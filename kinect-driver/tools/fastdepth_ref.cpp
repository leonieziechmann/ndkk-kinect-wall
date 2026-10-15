// fastdepth_ref: decodes a raw recording (.k2raw, as fn2_rawdump writes it) with the repository's
// fn2/fast_depth.cpp and writes, per packet, depth then IR as 512 x 424 little-endian floats.
// Used to check kinect-driver's Compat mode against the decoder that runs in production.
//
//   g++ -O3 -mavx2 -mfma -ffast-math -std=c++20 -I../fn2 ../fn2/fast_depth.cpp fastdepth_ref.cpp -o fastdepth_ref -lpthread
//   ./fastdepth_ref recordings/sim.k2raw out.f32

#include "fast_depth.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>
#include <string>
#include <vector>

// fast_depth.cpp reads std::vector data with aligned AVX loads (_mm256_load_ps), but std::vector
// only guarantees 16-byte alignment: on Linux (glibc, large blocks from mmap at page + 16) that
// crashes, on Windows it works by chance. Here every allocation is 64-byte aligned.
void *operator new(std::size_t n)
{
  void *p = std::aligned_alloc(64, (n + 63) / 64 * 64);
  if (!p) throw std::bad_alloc();
  return p;
}
void operator delete(void *p) noexcept { std::free(p); }
void operator delete(void *p, std::size_t) noexcept { std::free(p); }

int main(int argc, char **argv)
{
  if (argc < 3) {
    fprintf(stderr, "usage: fastdepth_ref FILE.k2raw OUT.f32\n");
    return 2;
  }
  const std::string file = argv[1];
  const int N = fastdepth::N;
  FILE *h = fopen((file + ".head").c_str(), "rb");
  if (!h) return 1;
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
  fastdepth::Decoder dec(0);
  if (!dec.load_tables(p0.data(), p0.size(), xt.data(), zt.data(), lut.data())) {
    fprintf(stderr, "tables do not fit\n");
    return 1;
  }
  FILE *f = fopen(file.c_str(), "rb");
  FILE *o = fopen(argv[2], "wb");
  if (!f || !o) return 1;
  std::vector<float> depth(N), ir(N);
  int n = 0;
  for (;;) {
    uint32_t head[3];
    if (fread(head, 4, 3, f) != 3) break;
    std::vector<uint8_t> data(head[2]);
    if (fread(data.data(), 1, head[2], f) != head[2]) break;
    if (!dec.decode(data.data(), data.size(), depth.data(), ir.data())) return 1;
    fwrite(depth.data(), 4, N, o);
    fwrite(ir.data(), 4, N, o);
    n++;
  }
  fclose(o);
  fprintf(stderr, "%d packets decoded\n", n);
  return 0;
}
