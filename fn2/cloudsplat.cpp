// Rendering helpers for pointcloud.py ("white dots on dark gray" look), called via ctypes.
//
//   void splat_spheres(u, v, r, a, n, acc, w, h, light, ambient)
//       adds one shaded, anti-aliased sphere sprite per point into acc (additive blending, so
//       dense areas glow brighter). u, v = pixel position (pixel centers at i + 0.5),
//       r = radius in px, a = brightness, light = unit vector in image coords (y down, z to viewer)
//   void compose(acc, glow, w, h, gain, glow_gain, bg_center, bg_edge, out)
//       tone-maps the accumulated light onto a vignetted gray background -> 8-bit gray image

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <thread>
#include <vector>

#define API extern "C" __declspec(dllexport)

namespace {

// Splits the rows into bands, one thread each; every thread only writes its own rows.
template <typename F>
void parallel_rows(int h, F body)
{
  int n = (int)std::max(1u, std::min(8u, std::thread::hardware_concurrency()));
  std::vector<std::thread> pool;
  for (int t = 0; t < n; t++)
  {
    int y0 = h * t / n, y1 = h * (t + 1) / n;
    pool.emplace_back([=] { body(y0, y1); });
  }
  for (auto &th : pool) th.join();
}

// Smaller dots are drawn at this radius with proportionally less light, so far-away points
// fade out instead of flickering between pixels.
const float MIN_R = 0.8f;

}  // namespace

API void splat_spheres(const float *u, const float *v, const float *r, const float *a, int n,
                       float *acc, int w, int h, const float *light, float ambient)
{
  const float lx = light[0], ly = light[1], lz = light[2];
  parallel_rows(h, [&](int y0, int y1) {
    for (int k = 0; k < n; k++)
    {
      float rk = r[k], energy = a[k];
      if (rk < MIN_R)
      {
        energy *= (rk * rk) / (MIN_R * MIN_R);
        rk = MIN_R;
      }
      const float cu = u[k], cv = v[k];
      int ya = std::max(y0, (int)std::floor(cv - rk - 1.f));
      int yb = std::min(y1 - 1, (int)std::ceil(cv + rk));
      if (ya > yb) continue;
      int xa = std::max(0, (int)std::floor(cu - rk - 1.f));
      int xb = std::min(w - 1, (int)std::ceil(cu + rk));
      if (xa > xb) continue;
      const float inv_r = 1.f / rk;
      for (int y = ya; y <= yb; y++)
      {
        const float dy = y + 0.5f - cv;
        float *row = acc + (size_t)y * w;
        for (int x = xa; x <= xb; x++)
        {
          const float dx = x + 0.5f - cu;
          const float d = std::sqrt(dx * dx + dy * dy);
          float cover = rk + 0.5f - d;  // 1 inside, ramps to 0 over the last pixel (anti-aliasing)
          if (cover <= 0.f) continue;
          if (cover > 1.f) cover = 1.f;
          float nx = dx * inv_r, ny = dy * inv_r, nz = 0.f;
          const float nz2 = 1.f - nx * nx - ny * ny;
          if (nz2 > 0.f)
            nz = std::sqrt(nz2);
          else
          {
            const float s = 1.f / std::sqrt(nx * nx + ny * ny);
            nx *= s;
            ny *= s;
          }
          const float lambert = std::max(0.f, nx * lx + ny * ly + nz * lz);
          row[x] += energy * cover * (ambient + (1.f - ambient) * lambert);
        }
      }
    }
  });
}

API void compose(const float *acc, const float *glow, int w, int h, float gain, float glow_gain,
                 float bg_center, float bg_edge, uint8_t *out)
{
  parallel_rows(h, [&](int y0, int y1) {
    for (int y = y0; y < y1; y++)
    {
      const float fy = (y + 0.5f) / h - 0.5f;
      for (int x = 0; x < w; x++)
      {
        const float fx = (x + 0.5f) / w - 0.5f;
        const float vig = std::min(1.f, 2.f * (fx * fx + fy * fy));  // 0 center .. 1 corners
        const float bg = bg_center + (bg_edge - bg_center) * vig;
        const size_t i = (size_t)y * w + x;
        const float dots = 1.f - std::exp(-gain * acc[i]);
        const float halo = 1.f - std::exp(-gain * glow[i]);
        float val = bg + (1.f - bg) * dots + glow_gain * halo * (1.f - dots);
        // tiny hash dither against banding in the dark gradient
        uint32_t hsh = (uint32_t)x * 73856093u ^ (uint32_t)y * 19349663u;
        hsh = (hsh ^ (hsh >> 13)) * 1274126177u;
        val += ((hsh >> 24) / 255.f - 0.5f) / 255.f;
        out[i] = (uint8_t)(std::min(1.f, std::max(0.f, val)) * 255.f + 0.5f);
      }
    }
  });
}
