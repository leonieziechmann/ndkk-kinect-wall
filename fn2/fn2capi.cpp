// Minimal C API around libfreenect2 for Python (ctypes): depth stream with automatic
// reconnect in a background thread. Uses the same fast-reconnect tricks as
// fn2_reconnect.cpp (shared pipeline, no USB reset, NO_DEVICE detection).
//
//   int  fn2_start(const char *pipeline)          "cl" (default) | "cpu" | "clkde"; 0 = ok
//   int  fn2_state(void)                          0 no device, 1 starting, 2 streaming
//   long fn2_get_depth(float *dst, long last_seq) copies a 512x424 depth frame (mm) when its
//                                                 sequence number differs from last_seq; returns
//                                                 the frame's sequence number, or -1 if none newer
//   int  fn2_ir_params(float *dst)                fx, fy, cx, cy of the depth camera as read from
//                                                 the device; 0 = ok, -1 = not known yet
//   void fn2_stop(void)

#include <libfreenect2/libfreenect2.hpp>
#include <libfreenect2/frame_listener.hpp>
#include <libfreenect2/packet_pipeline.h>
#include <libfreenect2/logger.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#define API extern "C" __declspec(dllexport)

namespace {

using Clock = std::chrono::steady_clock;
const int W = 512, H = 424;

std::atomic<bool> g_run{false};
std::atomic<bool> g_lost{false};
std::atomic<int> g_state{0};
std::thread g_thread;

std::mutex g_mutex;
std::vector<float> g_depth(W * H);
long g_seq = 0;
Clock::time_point g_last_frame;
float g_ir[4];
bool g_have_ir = false;

class WatchLogger : public libfreenect2::Logger
{
public:
  WatchLogger() { level_ = Warning; }
  void log(Level level, const std::string &msg) override
  {
    if (msg.find("NO_DEVICE") != std::string::npos || msg.find("failed to submit transfer") != std::string::npos)
      g_lost = true;
    if (level > Warning) return;
    if (msg != last_)
      std::fprintf(stderr, "[fn2 %s] %s\n", level2str(level).c_str(), msg.c_str());
    last_ = msg;
  }
private:
  std::string last_;
};

class DepthListener : public libfreenect2::FrameListener
{
public:
  bool onNewFrame(libfreenect2::Frame::Type type, libfreenect2::Frame *frame) override
  {
    if (type != libfreenect2::Frame::Depth || frame->status != 0) return false;
    std::lock_guard<std::mutex> lock(g_mutex);
    std::memcpy(g_depth.data(), frame->data, W * H * sizeof(float));
    ++g_seq;
    g_last_frame = Clock::now();
    return false;
  }
};

class SharedPipeline : public libfreenect2::PacketPipeline
{
public:
  explicit SharedPipeline(const libfreenect2::PacketPipeline *inner) : inner_(inner) {}
  PacketParser *getRgbPacketParser() const override { return inner_->getRgbPacketParser(); }
  PacketParser *getIrPacketParser() const override { return inner_->getIrPacketParser(); }
  libfreenect2::RgbPacketProcessor *getRgbPacketProcessor() const override { return inner_->getRgbPacketProcessor(); }
  libfreenect2::DepthPacketProcessor *getDepthPacketProcessor() const override { return inner_->getDepthPacketProcessor(); }
private:
  const libfreenect2::PacketPipeline *inner_;
};

libfreenect2::PacketPipeline *make_pipeline(const std::string &name)
{
  if (name == "cpu") return new libfreenect2::CpuPacketPipeline();
#ifdef LIBFREENECT2_WITH_OPENCL_SUPPORT
  if (name == "clkde") return new libfreenect2::OpenCLKdePacketPipeline();
  return new libfreenect2::OpenCLPacketPipeline();
#else
  return new libfreenect2::CpuPacketPipeline();
#endif
}

void worker(libfreenect2::PacketPipeline *shared)
{
  libfreenect2::Freenect2 ctx;
  DepthListener listener;
  libfreenect2::Freenect2Device *dev = nullptr;
  Clock::time_point started;

  while (g_run)
  {
    if (!dev)
    {
      g_state = 0;
      if (ctx.enumerateDevices() == 0)
      {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        continue;
      }
      g_state = 1;
      dev = ctx.openDevice(0, new SharedPipeline(shared));
      if (!dev)
      {
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        continue;
      }
      g_lost = false;
      dev->setIrAndDepthFrameListener(&listener);
      if (!dev->startStreams(false, true))
      {
        dev->close();
        delete dev;
        dev = nullptr;
        continue;
      }
      started = Clock::now();
      {
        libfreenect2::Freenect2Device::IrCameraParams p = dev->getIrCameraParams();
        std::lock_guard<std::mutex> lock(g_mutex);
        g_ir[0] = p.fx;
        g_ir[1] = p.fy;
        g_ir[2] = p.cx;
        g_ir[3] = p.cy;
        g_have_ir = true;
      }
      continue;
    }

    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    Clock::time_point last;
    {
      std::lock_guard<std::mutex> lock(g_mutex);
      last = g_last_frame;
    }
    Clock::time_point now = Clock::now();
    bool have = last > started;
    if (have) g_state = 2;
    // no frame for 500 ms while streaming, or none 8 s after start (the sensor can need ~3 s after a reboot)
    bool stalled = have ? now - last > std::chrono::milliseconds(500) : now - started > std::chrono::seconds(8);
    if (!g_lost && !stalled) continue;

    std::fprintf(stderr, "[fn2] %s, reconnecting\n", g_lost ? "Kinect vom USB verschwunden" : "keine Bilder mehr");
    g_state = 0;
    dev->stop();
    dev->close();
    delete dev;
    dev = nullptr;
  }

  if (dev)
  {
    dev->stop();
    dev->close();
    delete dev;
  }
  g_state = 0;
}

}  // namespace

API int fn2_start(const char *pipeline)
{
  if (g_run) return 0;
  _putenv("LIBFREENECT2_SKIP_RESET=1");
  libfreenect2::setGlobalLogger(new WatchLogger());  // libfreenect2 takes ownership
  libfreenect2::PacketPipeline *shared = make_pipeline(pipeline ? pipeline : "cl");
  if (!shared) return 1;
  g_run = true;
  g_thread = std::thread([shared] {
    worker(shared);
    delete shared;
  });
  return 0;
}

API int fn2_state(void) { return g_state; }

API long fn2_get_depth(float *dst, long last_seq)
{
  std::lock_guard<std::mutex> lock(g_mutex);
  if (g_seq == 0 || g_seq == last_seq) return -1;
  std::memcpy(dst, g_depth.data(), W * H * sizeof(float));
  return g_seq;
}

API int fn2_ir_params(float *dst)
{
  std::lock_guard<std::mutex> lock(g_mutex);
  if (!g_have_ir) return -1;
  std::memcpy(dst, g_ir, sizeof(g_ir));
  return 0;
}

API void fn2_stop(void)
{
  if (!g_run) return;
  g_run = false;
  if (g_thread.joinable()) g_thread.join();
  libfreenect2::setGlobalLogger(nullptr);
}
