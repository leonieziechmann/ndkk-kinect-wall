// fast_depth: decodes the Kinect v2's raw depth packets on the CPU, fast enough to replace
// libfreenect2's OpenCL pipeline (and leave the GPU to the scenes and the pose model).
//
// The method is libfreenect2's (opencl_depth_packet_processor.cl: phases of three frequencies,
// joint bilateral filter, phase unwrapping, edge-aware filter, same parameters), done differently
// where it is cheaper with comparable results:
//   - the per-pixel sines and cosines of the device's P0 tables are computed once when the tables
//     are loaded, not per frame (the three phase offsets become a rotation)
//   - the 11-bit samples are unpacked row by row; atan2, exp and log are vectorizable
//     polynomial approximations; the filter normalizes every pixel once instead of per neighbour
//   - rows in parallel on a few threads, three phases with barriers (decode, filter + unwrap,
//     edge filter); compiled with AVX2/FMA and fast math (the caller checks the CPU)
// fn2/depth_bench.cpp compares it with libfreenect2 on recorded packets (fn2/fn2_rawdump).

#pragma once

#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>

namespace fastdepth
{

constexpr int W = 512, H = 424, N = W * H;
/// bytes of one raw depth packet (10 sub-images of 512 x 424 11-bit samples)
constexpr size_t PACKET_BYTES = (size_t)N * 11 / 16 * 10 * 2;

/// libfreenect2's DepthPacketProcessor::Parameters (defaults) and Config.
struct Params
{
  float ab_multiplier = 0.6666667f;
  float ab_multiplier_per_frq[3] = {1.322581f, 1.0f, 1.612903f};
  float ab_output_multiplier = 16.0f;
  float phase_in_rad[3] = {0.0f, 2.094395f, 4.18879f};
  float joint_bilateral_ab_threshold = 3.0f;
  float joint_bilateral_max_edge = 2.5f;
  float joint_bilateral_exp = 5.0f;
  float gaussian_kernel[9] = {0.1069973f, 0.1131098f, 0.1069973f, 0.1131098f, 0.1195716f,
                              0.1131098f, 0.1069973f, 0.1131098f, 0.1069973f};
  float phase_offset = 0.0f;
  float unambigious_dist = 2083.333f;
  float individual_ab_threshold = 3.0f;
  float ab_threshold = 10.0f;
  float ab_confidence_slope = -0.5330578f;
  float ab_confidence_offset = 0.7694894f;
  float min_dealias_confidence = 0.3490659f;
  float max_dealias_confidence = 0.6108653f;
  float edge_ab_avg_min_value = 50.0f;
  float edge_ab_std_dev_threshold = 0.05f;
  float edge_close_delta_threshold = 50.0f;
  float edge_far_delta_threshold = 30.0f;
  float edge_max_delta_threshold = 100.0f;
  float edge_avg_delta_threshold = 0.0f;
  float max_edge_count = 5.0f;
  /// mm
  float min_depth = 500.0f;
  float max_depth = 4500.0f;
  bool bilateral_filter = true;
  bool edge_aware_filter = true;
};

class Decoder
{
public:
  /// threads: workers besides the caller (0 = all on the calling thread); low_priority: the
  /// workers yield to other programs (the scenes) when the CPU is short
  explicit Decoder(int threads = 3, Params params = Params(), bool low_priority = false);
  ~Decoder();
  Decoder(const Decoder &) = delete;
  Decoder &operator=(const Decoder &) = delete;

  /// The device's tables as libfreenect2 gets them (P0 tables command response, x/z tables,
  /// 11-to-16-bit lookup table). False if they do not fit.
  bool load_tables(const uint8_t *p0, size_t p0_len, const float *xtable, const float *ztable, const int16_t *lut);
  bool ready() const { return ready_; }

  /// One raw depth packet -> depth in mm (0 = no measurement) and the infrared amplitude, W * H
  /// floats each, as libfreenect2's depth and ir frames (mirrored, row 0 at the top).
  bool decode(const uint8_t *packet, size_t len, float *depth, float *ir);

  /// ms the phases of the last decode took: decode, filter + unwrap, edge filter
  double phase_ms[3] = {0, 0, 0};

private:
  void run_parallel(const std::function<void(int, int)> &rows);
  void work(uint64_t generation, const std::function<void(int, int)> &rows, int blocks);
  void worker_loop();
  void stage1(int y0, int y1);
  void stage2(int y0, int y1);
  void stage3(int y0, int y1);

  Params p_;
  bool ready_ = false;
  // tables, structure of arrays
  std::vector<float> mcos_[3], msin_[3]; // multiplier * cos / sin of the P0 phase per frequency
  std::vector<float> xtable_, ztable_;
  std::vector<uint8_t> invalid_;
  std::vector<float> valid_;
  alignas(32) float lut_[2048];
  // per column: byte offset of the 32-bit word with its 11 bits, the shift, and 0 for the
  // columns that carry nothing
  alignas(32) int32_t word_off_[W], word_shift_[W], word_keep_[W];
  // per frame
  const uint16_t *data_ = nullptr;
  std::vector<float> a_[3], b_[3], n_[3], na_[3], nb_[3];
  std::vector<float> raw_depth_, ir_sum_;
  std::vector<uint8_t> edge_ok_;
  float *depth_out_ = nullptr, *ir_out_ = nullptr;
  // the thread pool
  std::vector<std::thread> threads_;
  std::mutex m_;
  std::condition_variable start_, done_;
  const std::function<void(int, int)> *job_ = nullptr;
  uint64_t generation_ = 0;
  int blocks_ = 0;
  // the blocks of a job are claimed from one counter: its generation in the high 32 bits, the next
  // block in the low 32 (a helper that wakes up late cannot take blocks of a newer job)
  std::atomic<uint64_t> claim_{0};
  std::atomic<int> finished_{0};
  bool quit_ = false;
  bool low_priority_ = false;
};

/// True if this CPU can run the decoder (AVX2 and FMA).
bool cpu_supported();

} // namespace fastdepth
