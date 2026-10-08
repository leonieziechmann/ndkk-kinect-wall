// fn2_rawdump: records the raw depth packets of the Kinect v2 with everything needed to decode
// them later (the device's P0 tables, x/z tables and 11-to-16-bit lookup table), for developing
// and checking depth decoders offline (fn2/fast_depth). Needs the Kinect: stop kinect-hub first.
//
//   fn2_rawdump --out recordings/raw-NAME.k2raw [--seconds 8]
//
// File (little-endian):
//   "K2RAW1\0\0" | u32 p0_len | p0 bytes | f32 xtable[512*424] | f32 ztable[512*424]
//   | i16 lut[2048] | f32 ir params fx fy cx cy k1 k2 k3 p1 p2
//   then per packet: u32 sequence | u32 timestamp | u32 length | bytes
// The recording shows the room (in infrared): keep it in recordings/, never commit it.

#include <libfreenect2/libfreenect2.hpp>
#include <libfreenect2/frame_listener.hpp>
#include <libfreenect2/packet_pipeline.h>
#include <libfreenect2/logger.h>

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>

namespace {

class Writer : public libfreenect2::FrameListener
{
public:
  explicit Writer(FILE *f) : f_(f) {}
  bool onNewFrame(libfreenect2::Frame::Type type, libfreenect2::Frame *frame) override
  {
    // the dump pipeline hands the same raw packet as Ir and as Depth: keep the Depth one
    if (type == libfreenect2::Frame::Depth && frame->format == libfreenect2::Frame::Raw) {
      std::lock_guard<std::mutex> lock(m_);
      uint32_t head[3] = {frame->sequence, frame->timestamp, (uint32_t)frame->bytes_per_pixel};
      fwrite(head, sizeof head, 1, f_);
      fwrite(frame->data, 1, frame->bytes_per_pixel, f_);
      packets_++;
    }
    return false; // libfreenect2 frees it
  }
  int packets() { std::lock_guard<std::mutex> lock(m_); return packets_; }

private:
  FILE *f_;
  std::mutex m_;
  int packets_ = 0;
};

} // namespace

int main(int argc, char **argv)
{
  std::string out;
  double seconds = 8;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    if (a == "--out" && i + 1 < argc) out = argv[++i];
    else if (a == "--seconds" && i + 1 < argc) seconds = atof(argv[++i]);
  }
  if (out.empty()) {
    fprintf(stderr, "usage: fn2_rawdump --out recordings/raw-NAME.k2raw [--seconds 8]\n");
    return 2;
  }
  libfreenect2::setGlobalLogger(libfreenect2::createConsoleLogger(libfreenect2::Logger::Warning));
  libfreenect2::Freenect2 ctx;
  if (ctx.enumerateDevices() == 0) {
    fprintf(stderr, "no Kinect found (is kinect-hub still running?)\n");
    return 1;
  }
  auto *pipeline = new libfreenect2::DumpPacketPipeline();
  libfreenect2::Freenect2Device *dev = ctx.openDevice(0, pipeline);
  if (!dev) {
    fprintf(stderr, "cannot open the Kinect\n");
    return 1;
  }
  FILE *f = fopen(out.c_str(), "wb");
  if (!f) {
    fprintf(stderr, "cannot write %s\n", out.c_str());
    return 1;
  }
  Writer writer(f);
  dev->setIrAndDepthFrameListener(&writer);
  if (!dev->startStreams(false, true)) {
    fprintf(stderr, "cannot start the depth stream\n");
    return 1;
  }
  size_t p0_len = 0, xl = 0, zl = 0, ll = 0;
  const unsigned char *p0 = pipeline->getDepthP0Tables(&p0_len);
  const float *xt = pipeline->getDepthXTable(&xl);
  const float *zt = pipeline->getDepthZTable(&zl);
  const short *lut = pipeline->getDepthLookupTable(&ll);
  libfreenect2::Freenect2Device::IrCameraParams ir = dev->getIrCameraParams();
  // the header goes to a file of its own: packets are being written already
  std::string head_path = out + ".head";
  FILE *h = fopen(head_path.c_str(), "wb");
  if (!h || !p0 || !xt || !zt || !lut) {
    fprintf(stderr, "tables missing\n");
    return 1;
  }
  fwrite("K2RAW1\0\0", 1, 8, h);
  uint32_t p0l = (uint32_t)p0_len;
  fwrite(&p0l, 4, 1, h);
  fwrite(p0, 1, p0_len, h);
  fwrite(xt, sizeof(float), xl, h);
  fwrite(zt, sizeof(float), zl, h);
  fwrite(lut, sizeof(short), ll, h);
  float params[9] = {ir.fx, ir.fy, ir.cx, ir.cy, ir.k1, ir.k2, ir.k3, ir.p1, ir.p2};
  fwrite(params, sizeof(float), 9, h);
  fclose(h);
  fprintf(stderr, "recording %.0f s: p0 %zu bytes, tables %zu/%zu/%zu, serial %s\n", seconds, p0_len, xl, zl, ll,
          dev->getSerialNumber().c_str());
  auto end = std::chrono::steady_clock::now() + std::chrono::milliseconds((int)(seconds * 1000));
  while (std::chrono::steady_clock::now() < end) std::this_thread::sleep_for(std::chrono::milliseconds(100));
  dev->stop();
  dev->close();
  fclose(f);
  fprintf(stderr, "%d packets -> %s (+ .head)\n", writer.packets(), out.c_str());
  return 0;
}
