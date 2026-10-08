// depth_bench: decodes recorded raw depth packets (fn2_rawdump) with libfreenect2's OpenCL (and
// CPU) pipeline and with fast_depth, and compares results and times. No Kinect needed.
//
//   depth_bench recordings/raw-NAME.k2raw [--threads 3] [--frames 0] [--cpu 10] [--dump 100]
//   depth_bench recordings/raw-NAME.k2raw --pace 30 --seconds 20 --only fast|cl [--threads 3]
//     decodes in a loop at 30 Hz with one decoder only (to see what it costs a scene meanwhile)
//
// --cpu N: also libfreenect2's CPU pipeline on the first N packets (slow); --dump F: writes the
// depth of packet F of both decoders as <file>.F.ref.f32 / .fast.f32 (512 x 424 floats).

#include <libfreenect2/libfreenect2.hpp>
#include <libfreenect2/frame_listener.hpp>
#include <libfreenect2/packet_pipeline.h>
#include <libfreenect2/logger.h>
#include "libfreenect2/depth_packet_processor.h"

#include "fast_depth.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

using Clock = std::chrono::steady_clock;
constexpr int N = fastdepth::N;

struct Packet
{
  uint32_t seq, ts;
  std::vector<uint8_t> data;
};

class Grab : public libfreenect2::FrameListener
{
public:
  std::vector<float> depth = std::vector<float>(N), ir = std::vector<float>(N);
  bool onNewFrame(libfreenect2::Frame::Type type, libfreenect2::Frame *frame) override
  {
    if (frame->format == libfreenect2::Frame::Float && frame->width * frame->height == (size_t)N)
      std::memcpy(type == libfreenect2::Frame::Depth ? depth.data() : ir.data(), frame->data, N * 4);
    return false;
  }
};

static double ms(Clock::time_point a, Clock::time_point b) { return std::chrono::duration<double, std::milli>(b - a).count(); }

struct Stats
{
  long both = 0, ref_only = 0, fast_only = 0, over10 = 0, over1 = 0;
  double sum_abs = 0, ir_rel = 0;
  long ir_n = 0;
  std::vector<float> diffs; // a sample for percentiles
  float max_abs = 0;
  void add(const float *ref, const float *fast, const float *ref_ir, const float *fast_ir)
  {
    for (int i = 0; i < N; i++) {
      const bool a = ref[i] > 0, b = fast[i] > 0;
      if (a && b) {
        const float d = std::fabs(ref[i] - fast[i]);
        both++;
        sum_abs += d;
        over10 += d > 10.0f;
        over1 += d > 1.0f;
        max_abs = std::max(max_abs, d);
        if ((i & 63) == 0) diffs.push_back(d);
      } else if (a) {
        ref_only++;
      } else if (b) {
        fast_only++;
      }
      if (ref_ir[i] > 10.0f) {
        ir_rel += std::fabs(ref_ir[i] - fast_ir[i]) / ref_ir[i];
        ir_n++;
      }
    }
  }
};

static std::string arg(int argc, char **argv, const char *name, const char *def)
{
  for (int i = 1; i + 1 < argc; i++)
    if (std::strcmp(argv[i], name) == 0) return argv[i + 1];
  return def;
}

int main(int argc, char **argv)
{
  if (argc < 2) {
    fprintf(stderr, "usage: depth_bench recordings/raw-NAME.k2raw [--threads 3] [--frames 0] [--cpu 10] [--dump 100]\n");
    return 2;
  }
  const std::string file = argv[1];
  const int threads = std::stoi(arg(argc, argv, "--threads", "3"));
  const int max_frames = std::stoi(arg(argc, argv, "--frames", "0"));
  const int cpu_frames = std::stoi(arg(argc, argv, "--cpu", "0"));
  const int dump = std::stoi(arg(argc, argv, "--dump", "-1"));
  const double pace = std::stod(arg(argc, argv, "--pace", "0"));
  const double seconds = std::stod(arg(argc, argv, "--seconds", "20"));
  const std::string only = arg(argc, argv, "--only", "");

  // the tables
  FILE *h = fopen((file + ".head").c_str(), "rb");
  if (!h) {
    fprintf(stderr, "cannot read %s.head\n", file.c_str());
    return 1;
  }
  char magic[8];
  uint32_t p0_len = 0;
  if (fread(magic, 1, 8, h) != 8 || std::memcmp(magic, "K2RAW1", 6) != 0 || fread(&p0_len, 4, 1, h) != 1) return 1;
  std::vector<uint8_t> p0(p0_len);
  std::vector<float> xt(N), zt(N);
  std::vector<int16_t> lut(2048);
  if (fread(p0.data(), 1, p0_len, h) != p0_len || fread(xt.data(), 4, N, h) != (size_t)N || fread(zt.data(), 4, N, h) != (size_t)N ||
      fread(lut.data(), 2, 2048, h) != 2048)
    return 1;
  fclose(h);

  // the packets
  std::vector<Packet> packets;
  FILE *f = fopen(file.c_str(), "rb");
  if (!f) return 1;
  for (;;) {
    uint32_t head[3];
    if (fread(head, 4, 3, f) != 3) break;
    Packet p{head[0], head[1], std::vector<uint8_t>(head[2])};
    if (fread(p.data.data(), 1, head[2], f) != head[2]) break;
    packets.push_back(std::move(p));
    if (max_frames && (int)packets.size() >= max_frames) break;
  }
  fclose(f);
  fprintf(stderr, "%zu packets of %zu bytes\n", packets.size(), packets.empty() ? 0 : packets[0].data.size());

  libfreenect2::setGlobalLogger(libfreenect2::createConsoleLogger(libfreenect2::Logger::Warning));
  auto setup = [&](libfreenect2::DepthPacketProcessor *proc, Grab *grab) {
    proc->setFrameListener(grab);
    proc->loadP0TablesFromCommandResponse(p0.data(), p0.size());
    proc->loadXZTables(xt.data(), zt.data());
    proc->loadLookupTable(lut.data());
  };
  libfreenect2::OpenCLPacketPipeline cl;
  Grab ref;
  setup(cl.getDepthPacketProcessor(), &ref);
  libfreenect2::CpuPacketPipeline cpu;
  Grab cpu_ref;
  if (cpu_frames) setup(cpu.getDepthPacketProcessor(), &cpu_ref);

  fastdepth::Decoder dec(threads);
  if (!dec.load_tables(p0.data(), p0.size(), xt.data(), zt.data(), lut.data())) {
    fprintf(stderr, "fast_depth: tables do not fit\n");
    return 1;
  }
  std::vector<float> depth(N), ir(N);
  if (pace > 0) {
    // one decoder in a loop at a fixed rate
    const auto period = std::chrono::duration_cast<Clock::duration>(std::chrono::duration<double>(1.0 / pace));
    const auto start = Clock::now();
    auto due = start;
    std::vector<double> t;
    for (size_t k = 0; Clock::now() - start < std::chrono::duration<double>(seconds); k++) {
      std::this_thread::sleep_until(due);
      due += period;
      Packet &p = packets[k % packets.size()];
      libfreenect2::DepthPacket dp{p.seq, p.ts, p.data.data(), p.data.size(), nullptr};
      auto a = Clock::now();
      if (only == "cl") cl.getDepthPacketProcessor()->process(dp);
      else dec.decode(p.data.data(), p.data.size(), depth.data(), ir.data());
      t.push_back(ms(a, Clock::now()));
    }
    std::sort(t.begin(), t.end());
    printf("%s at %.0f Hz for %.0f s: %zu frames, %.2f ms median, p90 %.2f, max %.1f\n", only == "cl" ? "OpenCL" : "fast", pace, seconds, t.size(),
           t[t.size() / 2], t[(t.size() - 1) * 9 / 10], t.back());
    return 0;
  }
  Stats st, st_cpu;
  std::vector<double> t_cl, t_fast, t_cpu, ph[3];
  for (size_t k = 0; k < packets.size(); k++) {
    Packet &p = packets[k];
    libfreenect2::DepthPacket dp{p.seq, p.ts, p.data.data(), p.data.size(), nullptr};
    auto a = Clock::now();
    cl.getDepthPacketProcessor()->process(dp);
    auto b = Clock::now();
    dec.decode(p.data.data(), p.data.size(), depth.data(), ir.data());
    auto c = Clock::now();
    if (k >= 3) {
      t_cl.push_back(ms(a, b));
      t_fast.push_back(ms(b, c));
      for (int j = 0; j < 3; j++) ph[j].push_back(dec.phase_ms[j]);
    }
    st.add(ref.depth.data(), depth.data(), ref.ir.data(), ir.data());
    if ((int)k < cpu_frames) {
      auto d = Clock::now();
      cpu.getDepthPacketProcessor()->process(dp);
      t_cpu.push_back(ms(d, Clock::now()));
      st_cpu.add(ref.depth.data(), cpu_ref.depth.data(), ref.ir.data(), cpu_ref.ir.data());
    }
    if ((int)k == dump) {
      for (auto [suffix, data] : {std::pair{".ref.f32", ref.depth.data()}, std::pair{".fast.f32", depth.data()}}) {
        FILE *o = fopen((file + "." + std::to_string(k) + suffix).c_str(), "wb");
        if (o) {
          fwrite(data, 4, N, o);
          fclose(o);
        }
      }
    }
  }
  auto median = [](std::vector<double> v) {
    if (v.empty()) return 0.0;
    std::sort(v.begin(), v.end());
    return v[v.size() / 2];
  };
  auto p90 = [](std::vector<double> v) {
    if (v.empty()) return 0.0;
    std::sort(v.begin(), v.end());
    return v[(v.size() - 1) * 9 / 10];
  };
  auto report = [&](const char *name, Stats &s) {
    std::sort(s.diffs.begin(), s.diffs.end());
    auto q = [&](double x) { return s.diffs.empty() ? 0.0f : s.diffs[(size_t)(x * (s.diffs.size() - 1))]; };
    const double frames = (double)packets.size();
    printf("%s vs OpenCL: per frame %.0f valid in both, %.0f only OpenCL, %.0f only %s | |diff| mean %.2f mm, median %.2f, p99 %.2f, max %.0f | >1 mm %.3f%%, >10 mm %.3f%% | ir rel %.4f\n",
           name, s.both / frames, s.ref_only / frames, s.fast_only / frames, name, s.sum_abs / std::max(1L, s.both), q(0.5), q(0.99), s.max_abs,
           100.0 * s.over1 / std::max(1L, s.both), 100.0 * s.over10 / std::max(1L, s.both), s.ir_rel / std::max(1L, s.ir_n));
  };
  report("fast", st);
  if (cpu_frames) report("cpu ", st_cpu);
  printf("time per frame: OpenCL %.2f ms (p90 %.2f) | fast %.2f ms (p90 %.2f; decode %.2f, filter+unwrap %.2f, edges %.2f) with %d threads + caller",
         median(t_cl), p90(t_cl), median(t_fast), p90(t_fast), median(ph[0]), median(ph[1]), median(ph[2]), threads);
  if (cpu_frames) printf(" | libfreenect2 CPU %.1f ms", median(t_cpu));
  printf("\n");
  return 0;
}
