// Kinect v2 reconnect stress test with libfreenect2.
//
// Streams color + depth, detects a dropout as fast as possible (libusb
// NO_DEVICE in the log, or no frames for --stall ms), tears the device down,
// re-opens it the moment it is back on the bus, and prints how long each phase
// of the reconnect took. Goal: minimise the gap between the last frame before
// a reset and the first frame after it.
//
//   fn2_reconnect [--seconds N] [--no-rgb] [--no-depth] [--pipeline cpu|cl|clkde] [--fresh-pipeline]
//                 [--kick S] [--reset] [--stall MS] [--csv FILE] [-v]
//
// --kick S   every S seconds of streaming, reboot the Kinect via its firmware shutdown
//            command (it drops off USB like on a real reset) to measure the reconnect path

#include <libfreenect2/libfreenect2.hpp>
#include <libfreenect2/frame_listener.hpp>
#include <libfreenect2/packet_pipeline.h>
#include <libfreenect2/logger.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <csignal>
#include <mutex>
#include <string>
#include <thread>

using Clock = std::chrono::steady_clock;
static const Clock::time_point T0 = Clock::now();

static double now_ms() { return std::chrono::duration<double, std::milli>(Clock::now() - T0).count(); }

static std::atomic<bool> g_quit{false};
static std::atomic<bool> g_lost{false};
static std::atomic<double> g_lost_at{0};
static bool g_verbose = false;

class WatchLogger : public libfreenect2::Logger
{
public:
  WatchLogger() { level_ = Info; }
  void log(Level level, const std::string &msg) override
  {
    bool gone = msg.find("NO_DEVICE") != std::string::npos ||
                msg.find("failed to submit transfer") != std::string::npos ||
                msg.find("PIPE") != std::string::npos;
    if (gone && !g_lost.exchange(true))
      g_lost_at = now_ms();
    if (g_verbose || level <= Warning)
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (msg == last_msg_)  // open retries repeat the same error every few ms
      {
        ++repeats_;
        return;
      }
      if (repeats_ > 0)
        std::fprintf(stderr, "            (last message repeated %d times)\n", repeats_);
      repeats_ = 0;
      last_msg_ = msg;
      std::fprintf(stderr, "%10.1f  [fn2 %s] %s\n", now_ms(), level2str(level).c_str(), msg.c_str());
    }
  }
private:
  std::mutex mutex_;
  std::string last_msg_;
  int repeats_ = 0;
};

class TimingListener : public libfreenect2::FrameListener
{
public:
  std::atomic<double> last_color{-1}, last_depth{-1};
  std::atomic<long> n_color{0}, n_depth{0};

  void reset() { last_color = -1; last_depth = -1; n_color = 0; n_depth = 0; }

  bool onNewFrame(libfreenect2::Frame::Type type, libfreenect2::Frame *frame) override
  {
    double t = now_ms();
    if (frame->status != 0) return false;
    if (type == libfreenect2::Frame::Color) { last_color = t; ++n_color; }
    else if (type == libfreenect2::Frame::Depth) { last_depth = t; ++n_depth; }
    return false;  // let the library recycle the frame
  }
};

struct Cycle
{
  double last_frame = -1;     // last frame before the dropout
  double detected = -1;       // we noticed the dropout
  double torn_down = -1;      // stop/close/delete finished
  double enumerated = -1;     // device visible on the bus again
  double opened = -1;         // openDevice returned
  double started = -1;        // start() returned
  double first_depth = -1;
  double first_color = -1;
  int open_attempts = 0;
};

static void on_sigint(int) { g_quit = true; }

// the library takes ownership of the pipeline on openDevice (also on failure)
static libfreenect2::PacketPipeline *make_pipeline(const std::string &name)
{
  if (name == "cpu") return new libfreenect2::CpuPacketPipeline();
#ifdef LIBFREENECT2_WITH_OPENCL_SUPPORT
  if (name == "cl") return new libfreenect2::OpenCLPacketPipeline();
  if (name == "clkde") return new libfreenect2::OpenCLKdePacketPipeline();
#endif
  std::fprintf(stderr, "unknown or unsupported pipeline '%s'\n", name.c_str());
  return nullptr;
}

// Hands the parts of a long-lived pipeline to openDevice. The device deletes this
// wrapper on close, the inner pipeline (OpenCL context, compiled kernels, worker
// threads) survives, so a reconnect does not pay for its setup again.
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

static void print_cycle(int n, const Cycle &c, bool rgb, bool depth, FILE *csv)
{
  auto d = [](double a, double b) { return (a < 0 || b < 0) ? -1.0 : a - b; };
  double first = -1;
  if (depth && c.first_depth >= 0) first = c.first_depth;
  if (rgb && c.first_color >= 0) first = first < 0 ? c.first_color : std::min(first, c.first_color);
  std::printf("#%-3d gap %7.0f ms | detect %5.0f  teardown %5.0f  bus %6.0f  open %5.0f  start %5.0f  "
              "1st-depth %5.0f  1st-color %5.0f  (open tries %d)\n",
              n, d(first, c.last_frame), d(c.detected, c.last_frame), d(c.torn_down, c.detected),
              d(c.enumerated, c.torn_down), d(c.opened, c.enumerated), d(c.started, c.opened),
              d(c.first_depth, c.started), d(c.first_color, c.started), c.open_attempts);
  std::fflush(stdout);
  if (csv)
  {
    std::fprintf(csv, "%d,%.1f,%.1f,%.1f,%.1f,%.1f,%.1f,%.1f,%.1f,%d\n", n, c.last_frame, c.detected, c.torn_down,
                 c.enumerated, c.opened, c.started, c.first_depth, c.first_color, c.open_attempts);
    std::fflush(csv);
  }
}

int main(int argc, char **argv)
{
  double run_seconds = 0;
  bool rgb = true, depth = true, do_reset = false, fresh_pipeline = false;
  std::string pipeline_name = "cl";
  double stall_ms = 300, kick_s = 0;
  const char *csv_path = nullptr;
  for (int i = 1; i < argc; i++)
  {
    std::string a = argv[i];
    if (a == "--seconds" && i + 1 < argc) run_seconds = std::atof(argv[++i]);
    else if (a == "--no-rgb") rgb = false;
    else if (a == "--no-depth") depth = false;
    else if (a == "--reset") do_reset = true;
    else if (a == "--stall" && i + 1 < argc) stall_ms = std::atof(argv[++i]);
    else if (a == "--csv" && i + 1 < argc) csv_path = argv[++i];
    else if (a == "--pipeline" && i + 1 < argc) pipeline_name = argv[++i];
    else if (a == "--fresh-pipeline") fresh_pipeline = true;
    else if (a == "--kick" && i + 1 < argc) kick_s = std::atof(argv[++i]);
    else if (a == "-v") g_verbose = true;
    else { std::fprintf(stderr, "unknown argument %s\n", a.c_str()); return 2; }
  }
  if (!do_reset) _putenv("LIBFREENECT2_SKIP_RESET=1");
  std::setvbuf(stdout, nullptr, _IONBF, 0);
  std::signal(SIGINT, on_sigint);

  libfreenect2::setGlobalLogger(new WatchLogger());  // libfreenect2 takes ownership

  FILE *csv = csv_path ? std::fopen(csv_path, "w") : nullptr;
  if (csv) std::fprintf(csv, "cycle,last_frame,detected,torn_down,enumerated,opened,started,first_depth,first_color,open_attempts\n");

  libfreenect2::Freenect2 ctx;
  TimingListener listener;
  libfreenect2::Freenect2Device *dev = nullptr;

  Cycle cyc;
  cyc.torn_down = now_ms();  // cycle 0 = cold start
  int cycle_no = 0;
  bool printed_first = false;
  double stat_t = 0, next_stat = 0;
  long stat_nd = 0, stat_nc = 0;

  std::printf("waiting for Kinect v2 (pipeline=%s%s rgb=%d depth=%d reset=%d stall=%.0f ms kick=%.0f s)...\n",
              pipeline_name.c_str(), fresh_pipeline ? " fresh" : " shared", rgb, depth, do_reset, stall_ms, kick_s);

  libfreenect2::PacketPipeline *shared = nullptr;
  if (!fresh_pipeline)
  {
    double t = now_ms();
    shared = make_pipeline(pipeline_name);
    if (!shared) return 2;
    std::printf("pipeline ready in %.0f ms\n", now_ms() - t);
  }
  bool wait_gone = false;  // after a kick: wait until the old device has left the bus

  while (!g_quit && (run_seconds <= 0 || now_ms() < run_seconds * 1000))
  {
    if (!dev)
    {
      // 1) wait until the device is on the bus
      int n = ctx.enumerateDevices();
      if (wait_gone)
      {
        if (n == 0 || now_ms() - cyc.torn_down > 5000) wait_gone = false;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        continue;
      }
      if (n == 0)
      {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        continue;
      }
      if (cyc.enumerated < 0) cyc.enumerated = now_ms();

      // 2) open + start
      ++cyc.open_attempts;
      libfreenect2::PacketPipeline *pipeline = shared ? new SharedPipeline(shared) : make_pipeline(pipeline_name);
      if (!pipeline) return 2;
      dev = ctx.openDevice(0, pipeline);
      if (!dev)
      {
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        continue;
      }
      cyc.opened = now_ms();
      listener.reset();
      g_lost = false;
      dev->setColorFrameListener(&listener);
      dev->setIrAndDepthFrameListener(&listener);
      if (!dev->startStreams(rgb, depth))
      {
        std::fprintf(stderr, "%10.1f  start failed, retrying\n", now_ms());
        dev->close();
        delete dev;
        dev = nullptr;
        continue;
      }
      cyc.started = now_ms();
      stat_t = cyc.started;
      next_stat = stat_t + 5000;
      stat_nd = stat_nc = 0;
      if (cycle_no == 0)
        std::printf("serial %s, firmware %s\n", dev->getSerialNumber().c_str(), dev->getFirmwareVersion().c_str());
      printed_first = false;
      continue;
    }

    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    double t = now_ms();
    double lc = listener.last_color, ld = listener.last_depth;
    if (cyc.first_depth < 0 && ld >= 0) cyc.first_depth = ld;
    if (cyc.first_color < 0 && lc >= 0) cyc.first_color = lc;

    bool have_all = (!depth || cyc.first_depth >= 0) && (!rgb || cyc.first_color >= 0);
    if (have_all && !printed_first)
    {
      if (cycle_no == 0)
        std::printf("cold start: open %.0f ms, start %.0f ms, first frames after %.0f ms\n",
                    cyc.opened - cyc.enumerated, cyc.started - cyc.opened,
                    std::max(cyc.first_depth, cyc.first_color) - cyc.enumerated);
      else
        print_cycle(cycle_no, cyc, rgb, depth, csv);
      printed_first = true;
    }

    if (t >= next_stat)
    {
      long nd = listener.n_depth, nc = listener.n_color;
      double dt = (t - stat_t) / 1000.0;
      std::printf("%10.1f  depth %4.1f fps, color %4.1f fps (total %ld / %ld)\n", t, (nd - stat_nd) / dt,
                  (nc - stat_nc) / dt, nd, nc);
      stat_t = t;
      stat_nd = nd;
      stat_nc = nc;
      next_stat = t + 5000;
    }

    // most recent frame of any enabled stream; color may idle in the dark, depth is the
    // reliable heartbeat
    double last = depth ? ld : lc;
    double ref = last >= 0 ? last : cyc.started;
    bool stalled = t - ref > (last >= 0 ? stall_ms : 8000);  // sensor may need ~3 s after a reboot
    bool kick = kick_s > 0 && printed_first && t - cyc.started > kick_s * 1000;
    if (!g_lost && !stalled && !kick) continue;

    // dropout
    Cycle next;
    double lf = std::max(lc, ld);
    next.last_frame = lf >= 0 ? lf : cyc.started;
    next.detected = g_lost ? (double)g_lost_at : t;
    const char *why = g_lost ? "usb gone" : stalled ? "stall" : "kick: firmware reboot";
    std::printf("%10.1f  dropout (%s) after %.1f s streaming, depth frames %ld, color frames %ld\n", t, why,
                (next.last_frame - cyc.started) / 1000.0, (long)listener.n_depth, (long)listener.n_color);
    if (kick && !g_lost && !stalled)
    {
      next.last_frame = t;  // simulated reset: count from the moment we pulled the plug
      _putenv("LIBFREENECT2_SHUTDOWN_ON_CLOSE=1");
      wait_gone = true;
    }
    dev->stop();
    dev->close();
    delete dev;
    dev = nullptr;
    _putenv("LIBFREENECT2_SHUTDOWN_ON_CLOSE=0");
    next.torn_down = now_ms();
    cyc = next;
    ++cycle_no;
  }

  if (dev)
  {
    dev->stop();
    dev->close();
    delete dev;
  }
  delete shared;
  if (csv) std::fclose(csv);
  libfreenect2::setGlobalLogger(nullptr);  // deletes the WatchLogger
  return 0;
}
