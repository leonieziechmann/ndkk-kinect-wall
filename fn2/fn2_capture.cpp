// Kinect v2 capture worker for kinect-hub.
//
// Streams depth + IR frames from libfreenect2 to stdout in a small binary protocol and
// reconnects on its own after USB dropouts or stalls. It runs as a child process of the Rust
// hub, so a crash inside libfreenect2/OpenCL only takes down this worker, and the hub restarts
// it. The worker exits by itself when its stdin closes (the hub went away).
//
// stdout: messages = 32-byte header + payload, little-endian
//   u32 magic "K2W1" | u16 kind | u16 flags | u32 payload_len | u32 seq | u32 device_ts
//   | u32 reserved | u64 host_time_us (system clock, microseconds since 1970)
//   kind 1 FRAME      depth f32[512*424] in mm, followed by IR f32[512*424] if flags & 1
//   kind 2 PARAMS     JSON: depth camera intrinsics + distortion, serial, firmware
//   kind 3 STATUS     JSON: {"state": "searching"|"starting"|"streaming", "detail": "..."}
//   kind 4 HEARTBEAT  JSON counters, once per second
// stderr: log lines
//
//   fn2_capture [--pipeline cl|cpu|clkde] [--no-stdin-watch]

#include <libfreenect2/libfreenect2.hpp>
#include <libfreenect2/frame_listener.hpp>
#include <libfreenect2/packet_pipeline.h>
#include <libfreenect2/logger.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <windows.h>

namespace {

using Clock = std::chrono::steady_clock;
const int W = 512, H = 424, PIXELS = W * H;
const uint32_t MAGIC = 0x3157324B;  // "K2W1"
enum Kind : uint16_t { FRAME = 1, PARAMS = 2, STATUS = 3, HEARTBEAT = 4 };
const uint16_t FLAG_HAS_IR = 1;

std::atomic<bool> g_quit{false};
std::atomic<bool> g_lost{false};

uint64_t host_time_us()
{
  return (uint64_t)std::chrono::duration_cast<std::chrono::microseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

std::string json_escape(const std::string &s)
{
  std::string out;
  for (char c : s)
  {
    if (c == '"' || c == '\\') out += '\\', out += c;
    else if ((unsigned char)c < 0x20) out += ' ';
    else out += c;
  }
  return out;
}

#pragma pack(push, 1)
struct Header
{
  uint32_t magic;
  uint16_t kind;
  uint16_t flags;
  uint32_t payload_len;
  uint32_t seq;
  uint32_t device_ts;
  uint32_t reserved;
  uint64_t host_time_us;
};
#pragma pack(pop)
static_assert(sizeof(Header) == 32, "header must be 32 bytes");

Header make_header(uint16_t kind, uint16_t flags, size_t len, uint32_t seq, uint32_t device_ts, uint64_t t_us)
{
  Header h;
  h.magic = MAGIC;
  h.kind = kind;
  h.flags = flags;
  h.payload_len = (uint32_t)len;
  h.seq = seq;
  h.device_ts = device_ts;
  h.reserved = 0;
  h.host_time_us = t_us;
  return h;
}

// Everything to stdout goes through one writer thread. Control messages are queued; frames use a
// latest-only slot, so a slow reader drops frames here instead of delaying libfreenect2.
class Output
{
public:
  void start() { thread_ = std::thread([this] { run(); }); }

  void stop()
  {
    {
      std::lock_guard<std::mutex> lock(m_);
      stop_ = true;
    }
    cv_.notify_all();
    if (thread_.joinable()) thread_.join();
  }

  void send_json(uint16_t kind, const std::string &json)
  {
    Msg msg;
    msg.header = make_header(kind, 0, json.size(), 0, 0, host_time_us());
    msg.payload.assign(json.begin(), json.end());
    {
      std::lock_guard<std::mutex> lock(m_);
      if (control_.size() < 64) control_.push_back(std::move(msg));
    }
    cv_.notify_one();
  }

  void send_frame(const float *depth, const float *ir, uint32_t seq, uint32_t device_ts, uint64_t t_us)
  {
    const size_t bytes = (size_t)PIXELS * sizeof(float);
    {
      std::lock_guard<std::mutex> lock(m_);
      if (frame_pending_) ++dropped_;
      frame_.payload.resize(ir ? 2 * bytes : bytes);
      std::memcpy(frame_.payload.data(), depth, bytes);
      if (ir) std::memcpy(frame_.payload.data() + bytes, ir, bytes);
      frame_.header = make_header(FRAME, ir ? FLAG_HAS_IR : 0, frame_.payload.size(), seq, device_ts, t_us);
      frame_pending_ = true;
    }
    cv_.notify_one();
  }

  uint64_t dropped() const { return dropped_; }
  uint64_t written() const { return written_; }

private:
  struct Msg
  {
    Header header;
    std::vector<uint8_t> payload;
  };

  static bool write_all(HANDLE h, const void *data, size_t len)
  {
    const uint8_t *p = static_cast<const uint8_t *>(data);
    while (len > 0)
    {
      DWORD chunk = (DWORD)std::min<size_t>(len, 1 << 20), done = 0;
      if (!WriteFile(h, p, chunk, &done, nullptr) || done == 0) return false;
      p += done;
      len -= done;
    }
    return true;
  }

  void run()
  {
    HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
    Msg msg;
    for (;;)
    {
      {
        std::unique_lock<std::mutex> lock(m_);
        cv_.wait(lock, [this] { return stop_ || !control_.empty() || frame_pending_; });
        if (!control_.empty())
        {
          msg = std::move(control_.front());
          control_.pop_front();
        }
        else if (frame_pending_ && !stop_)
        {
          std::swap(msg.payload, frame_.payload);
          msg.header = frame_.header;
          frame_pending_ = false;
        }
        else
          return;  // stopping and nothing left to say
      }
      if (!write_all(out, &msg.header, sizeof(Header)) || !write_all(out, msg.payload.data(), msg.payload.size()))
      {
        g_quit = true;  // the hub is gone
        return;
      }
      ++written_;
    }
  }

  std::thread thread_;
  std::mutex m_;
  std::condition_variable cv_;
  std::deque<Msg> control_;
  Msg frame_;
  bool frame_pending_ = false;
  bool stop_ = false;
  std::atomic<uint64_t> dropped_{0}, written_{0};
};

class WatchLogger : public libfreenect2::Logger
{
public:
  WatchLogger() { level_ = Info; }
  void log(Level level, const std::string &msg) override
  {
    if (msg.find("NO_DEVICE") != std::string::npos || msg.find("failed to submit transfer") != std::string::npos)
      g_lost = true;
    if (level > Warning) return;
    std::lock_guard<std::mutex> lock(m_);
    if (msg == last_) return;  // open retries repeat the same error every few ms
    last_ = msg;
    std::fprintf(stderr, "libfreenect2 %s: %s\n", level2str(level).c_str(), msg.c_str());
  }

private:
  std::mutex m_;
  std::string last_;
};

class Listener : public libfreenect2::FrameListener
{
public:
  explicit Listener(Output &out) : out_(out), ir_(PIXELS) {}

  // libfreenect2 delivers IR first, then depth of the same packet, from the same thread.
  bool onNewFrame(libfreenect2::Frame::Type type, libfreenect2::Frame *frame) override
  {
    if (frame->status != 0 || frame->width != (size_t)W || frame->height != (size_t)H || frame->bytes_per_pixel != 4)
      return false;
    if (type == libfreenect2::Frame::Ir)
    {
      std::memcpy(ir_.data(), frame->data, (size_t)PIXELS * sizeof(float));
      ir_seq_ = frame->sequence;
      have_ir_ = true;
    }
    else if (type == libfreenect2::Frame::Depth)
    {
      const bool with_ir = have_ir_ && ir_seq_ == frame->sequence;
      out_.send_frame(reinterpret_cast<const float *>(frame->data), with_ir ? ir_.data() : nullptr, frame->sequence,
                      frame->timestamp, host_time_us());
      last_frame_ms_ = std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now().time_since_epoch()).count();
      ++frames_;
    }
    return false;  // let libfreenect2 reuse the frame
  }

  void reset()
  {
    have_ir_ = false;
    last_frame_ms_ = 0;
  }
  // milliseconds (steady clock) of the newest depth frame, 0 if none since reset()
  int64_t last_frame_ms() const { return last_frame_ms_; }
  uint64_t frames() const { return frames_; }

private:
  Output &out_;
  std::vector<float> ir_;
  uint32_t ir_seq_ = 0;
  bool have_ir_ = false;
  std::atomic<int64_t> last_frame_ms_{0};
  std::atomic<uint64_t> frames_{0};
};

// Hands the parts of one long-lived pipeline to every openDevice: OpenCL setup (~0.6-2 s)
// happens once per worker, not once per reconnect.
class SharedPipeline : public libfreenect2::PacketPipeline
{
public:
  explicit SharedPipeline(const libfreenect2::PacketPipeline *inner) : inner_(inner) {}
  PacketParser *getRgbPacketParser() const override { return inner_->getRgbPacketParser(); }
  PacketParser *getIrPacketParser() const override { return inner_->getIrPacketParser(); }
  libfreenect2::RgbPacketProcessor *getRgbPacketProcessor() const override { return inner_->getRgbPacketProcessor(); }
  libfreenect2::DepthPacketProcessor *getDepthPacketProcessor() const override
  {
    return inner_->getDepthPacketProcessor();
  }

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

void watch_stdin()
{
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  char buf[256];
  DWORD n = 0;
  while (ReadFile(in, buf, sizeof(buf), &n, nullptr) && n > 0)
  {
  }
  g_quit = true;  // EOF or error: the hub closed our stdin or died
}

int64_t now_ms()
{
  return std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now().time_since_epoch()).count();
}

void send_status(Output &out, const char *state, const std::string &detail)
{
  out.send_json(STATUS, std::string("{\"state\":\"") + state + "\",\"detail\":\"" + json_escape(detail) + "\"}");
  std::fprintf(stderr, "state: %s %s\n", state, detail.c_str());
}

void send_params(Output &out, libfreenect2::Freenect2Device *dev)
{
  libfreenect2::Freenect2Device::IrCameraParams p = dev->getIrCameraParams();
  char buf[512];
  std::snprintf(buf, sizeof(buf),
                "{\"width\":%d,\"height\":%d,\"fx\":%.6f,\"fy\":%.6f,\"cx\":%.6f,\"cy\":%.6f,"
                "\"k1\":%.8f,\"k2\":%.8f,\"k3\":%.8f,\"p1\":%.8f,\"p2\":%.8f,",
                W, H, p.fx, p.fy, p.cx, p.cy, p.k1, p.k2, p.k3, p.p1, p.p2);
  out.send_json(PARAMS, std::string(buf) + "\"serial\":\"" + json_escape(dev->getSerialNumber()) +
                            "\",\"firmware\":\"" + json_escape(dev->getFirmwareVersion()) + "\"}");
}

}  // namespace

int main(int argc, char **argv)
{
  std::string pipeline_name = "cl";
  bool stdin_watch = true;
  for (int i = 1; i < argc; i++)
  {
    std::string a = argv[i];
    if (a == "--pipeline" && i + 1 < argc) pipeline_name = argv[++i];
    else if (a == "--no-stdin-watch") stdin_watch = false;
    else
    {
      std::fprintf(stderr, "unknown argument %s\n", a.c_str());
      return 2;
    }
  }
  _putenv("LIBFREENECT2_SKIP_RESET=1");
  std::setvbuf(stderr, nullptr, _IONBF, 0);

  Output out;
  out.start();
  if (stdin_watch) std::thread(watch_stdin).detach();
  libfreenect2::setGlobalLogger(new WatchLogger());  // libfreenect2 takes ownership

  send_status(out, "starting", "setting up the depth pipeline (" + pipeline_name + ")");
  const Clock::time_point t_pipe = Clock::now();
  libfreenect2::PacketPipeline *shared = make_pipeline(pipeline_name);
  std::fprintf(stderr, "pipeline ready in %lld ms\n",
               (long long)std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t_pipe).count());

  libfreenect2::Freenect2 ctx;
  Listener listener(out);
  libfreenect2::Freenect2Device *dev = nullptr;
  int64_t started_ms = 0, next_heartbeat = now_ms();
  bool searching_reported = false, streaming_reported = false;
  uint32_t reconnects = 0;

  while (!g_quit)
  {
    const int64_t t = now_ms();
    if (t >= next_heartbeat)
    {
      char buf[256];
      std::snprintf(buf, sizeof(buf), "{\"frames\":%llu,\"dropped\":%llu,\"written\":%llu,\"reconnects\":%u}",
                    (unsigned long long)listener.frames(), (unsigned long long)out.dropped(),
                    (unsigned long long)out.written(), reconnects);
      out.send_json(HEARTBEAT, buf);
      next_heartbeat = t + 1000;
    }

    if (!dev)
    {
      if (ctx.enumerateDevices() == 0)
      {
        if (!searching_reported) send_status(out, "searching", "no Kinect v2 on USB");
        searching_reported = true;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        continue;
      }
      searching_reported = false;
      dev = ctx.openDevice(0, new SharedPipeline(shared));
      if (!dev)
      {
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        continue;
      }
      send_status(out, "starting", "sensor warming up");
      listener.reset();
      g_lost = false;
      dev->setIrAndDepthFrameListener(&listener);
      if (!dev->startStreams(false, true))
      {
        dev->close();
        delete dev;
        dev = nullptr;
        continue;
      }
      send_params(out, dev);
      started_ms = now_ms();
      streaming_reported = false;
      continue;
    }

    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    const int64_t last = listener.last_frame_ms();
    if (last > 0 && !streaming_reported)
    {
      send_status(out, "streaming", "");
      streaming_reported = true;
    }
    // no frame for 2 s while streaming, or none 8 s after start (the sensor needs ~3 s after a reboot).
    // Not shorter: the depth decoding shares the GPU with the browser scenes, and a GPU-heavy scene
    // can slow it to a few frames per second. Restarting then only adds a 3 s gap per restart.
    const bool stalled = last > 0 ? now_ms() - last > 2000 : now_ms() - started_ms > 8000;
    if (!g_lost && !stalled) continue;

    const bool usb_gone = g_lost;
    send_status(out, "searching", usb_gone ? "Kinect dropped off USB" : "frames stopped, restarting the sensor");
    dev->stop();
    dev->close();
    delete dev;
    dev = nullptr;
    ++reconnects;
    // The shared depth processor may still be busy with a packet from the old session;
    // starting a new one right away would load new tables into it concurrently.
    std::this_thread::sleep_for(std::chrono::milliseconds(usb_gone ? 50 : 300));
  }

  if (dev)
  {
    dev->stop();
    dev->close();
    delete dev;
  }
  out.stop();
  std::fprintf(stderr, "worker exits\n");
  // skip destructors of the shared pipeline / OpenCL context: the process ends anyway
  std::fflush(stderr);
  _exit(0);
}
