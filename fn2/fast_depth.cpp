// fast_depth.cpp: see fast_depth.h. Built with -O3 -mavx2 -mfma -ffast-math (only this file): the
// per-pixel loops vectorize, and the caller checks cpu_supported() before using the decoder.

#include "fast_depth.h"

#include <algorithm>
#include <bit>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>

#include <immintrin.h>
#ifdef _WIN32
#include <windows.h>
#endif

namespace fastdepth
{

namespace
{

constexpr float PI = 3.14159265358979f;
constexpr float TWO_PI = 6.28318530717959f;
/// rows per work item of the thread pool
constexpr int BLOCK = 8;

// ---- vectorizable approximations (no library calls inside the pixel loops) -----------------

inline float bits_to_float(uint32_t u) { return std::bit_cast<float>(u); }
inline uint32_t float_to_bits(float f) { return std::bit_cast<uint32_t>(f); }

/// atan2 with ~1e-6 rad error; atan2(0, 0) = 0
inline float fast_atan2(float y, float x)
{
  const float ax = std::fabs(x), ay = std::fabs(y);
  const float mx = std::max(ax, ay), mn = std::min(ax, ay);
  const float a = mx > 0.0f ? mn / mx : 0.0f;
  const float s = a * a;
  float r = a * (0.99997726f + s * (-0.33262347f + s * (0.19354346f + s * (-0.11643287f + s * (0.05265332f + s * -0.01172120f)))));
  r = ay > ax ? 1.57079637f - r : r;
  r = x < 0.0f ? PI - r : r;
  return y < 0.0f ? -r : r;
}

/// e^x for x in [-87, 88], ~2e-7 relative error
inline float fast_exp(float x)
{
  x = std::min(88.0f, std::max(-87.0f, x));
  const float t = x * 1.44269504f;
  const float fi = std::floor(t);
  const float f = t - fi;
  // 2^f on [0, 1)
  const float p = 1.0f + f * (0.69314718f + f * (0.24022650f + f * (0.05550411f + f * (0.00961813f + f * 0.00133336f))));
  const int32_t e = (int32_t)fi;
  return p * bits_to_float((uint32_t)(e + 127) << 23);
}

/// ln(x) for x > 0, ~1e-6 absolute error
inline float fast_log(float x)
{
  const uint32_t u = float_to_bits(x);
  const int e = (int)((u >> 23) & 255) - 127;
  float m = bits_to_float((u & 0x007fffff) | 0x3f800000); // [1, 2)
  // ln(m) = 2 atanh((m - 1) / (m + 1))
  const float z = (m - 1.0f) / (m + 1.0f);
  const float z2 = z * z;
  const float l = 2.0f * z * (1.0f + z2 * (0.33333333f + z2 * (0.2f + z2 * (0.14285714f + z2 * 0.11111111f))));
  return l + (float)e * 0.69314718f;
}


// ---- the same approximations, 8 pixels at a time (AVX2 + FMA) -------------------------------

inline __m256 set(float v) { return _mm256_set1_ps(v); }

inline __m256 exp_ps(__m256 x)
{
  x = _mm256_min_ps(set(88.0f), _mm256_max_ps(set(-87.0f), x));
  const __m256 t = _mm256_mul_ps(x, set(1.44269504f));
  const __m256 fi = _mm256_floor_ps(t);
  const __m256 f = _mm256_sub_ps(t, fi);
  __m256 p = _mm256_fmadd_ps(f, set(0.00133336f), set(0.00961813f));
  p = _mm256_fmadd_ps(p, f, set(0.05550411f));
  p = _mm256_fmadd_ps(p, f, set(0.24022650f));
  p = _mm256_fmadd_ps(p, f, set(0.69314718f));
  p = _mm256_fmadd_ps(p, f, set(1.0f));
  const __m256i e = _mm256_slli_epi32(_mm256_add_epi32(_mm256_cvttps_epi32(fi), _mm256_set1_epi32(127)), 23);
  return _mm256_mul_ps(p, _mm256_castsi256_ps(e));
}

inline __m256 log_ps(__m256 x)
{
  const __m256i u = _mm256_castps_si256(x);
  const __m256 e = _mm256_cvtepi32_ps(_mm256_sub_epi32(_mm256_srli_epi32(u, 23), _mm256_set1_epi32(127)));
  const __m256 m = _mm256_castsi256_ps(_mm256_or_si256(_mm256_and_si256(u, _mm256_set1_epi32(0x007fffff)), _mm256_set1_epi32(0x3f800000)));
  const __m256 z = _mm256_div_ps(_mm256_sub_ps(m, set(1.0f)), _mm256_add_ps(m, set(1.0f)));
  const __m256 z2 = _mm256_mul_ps(z, z);
  __m256 p = _mm256_fmadd_ps(z2, set(0.11111111f), set(0.14285714f));
  p = _mm256_fmadd_ps(p, z2, set(0.2f));
  p = _mm256_fmadd_ps(p, z2, set(0.33333333f));
  p = _mm256_fmadd_ps(p, z2, set(1.0f));
  return _mm256_fmadd_ps(e, set(0.69314718f), _mm256_mul_ps(_mm256_mul_ps(set(2.0f), z), p));
}

inline __m256 abs_ps(__m256 x) { return _mm256_andnot_ps(set(-0.0f), x); }

inline __m256 atan2_ps(__m256 y, __m256 x)
{
  const __m256 ax = abs_ps(x), ay = abs_ps(y);
  const __m256 mx = _mm256_max_ps(ax, ay), mn = _mm256_min_ps(ax, ay);
  const __m256 pos = _mm256_cmp_ps(mx, _mm256_setzero_ps(), _CMP_GT_OQ);
  const __m256 a = _mm256_and_ps(pos, _mm256_div_ps(mn, _mm256_max_ps(mx, set(1e-30f))));
  const __m256 s = _mm256_mul_ps(a, a);
  __m256 p = _mm256_fmadd_ps(s, set(-0.01172120f), set(0.05265332f));
  p = _mm256_fmadd_ps(p, s, set(-0.11643287f));
  p = _mm256_fmadd_ps(p, s, set(0.19354346f));
  p = _mm256_fmadd_ps(p, s, set(-0.33262347f));
  p = _mm256_fmadd_ps(p, s, set(0.99997726f));
  __m256 r = _mm256_mul_ps(a, p);
  r = _mm256_blendv_ps(r, _mm256_sub_ps(set(1.57079637f), r), _mm256_cmp_ps(ay, ax, _CMP_GT_OQ));
  r = _mm256_blendv_ps(r, _mm256_sub_ps(set(PI), r), _mm256_cmp_ps(x, _mm256_setzero_ps(), _CMP_LT_OQ));
  return _mm256_blendv_ps(r, _mm256_sub_ps(_mm256_setzero_ps(), r), _mm256_cmp_ps(y, _mm256_setzero_ps(), _CMP_LT_OQ));
}

inline __m256 select_ps(__m256 mask, __m256 a, __m256 b) { return _mm256_blendv_ps(b, a, mask); }
inline __m256 lt(__m256 a, __m256 b) { return _mm256_cmp_ps(a, b, _CMP_LT_OQ); }
inline __m256 le(__m256 a, __m256 b) { return _mm256_cmp_ps(a, b, _CMP_LE_OQ); }
inline __m256 ge(__m256 a, __m256 b) { return _mm256_cmp_ps(a, b, _CMP_GE_OQ); }
inline __m256 gt(__m256 a, __m256 b) { return _mm256_cmp_ps(a, b, _CMP_GT_OQ); }

} // namespace

bool cpu_supported()
{
  __builtin_cpu_init();
  return __builtin_cpu_supports("avx2") && __builtin_cpu_supports("fma");
}

Decoder::Decoder(int threads, Params params, bool low_priority) : p_(params), low_priority_(low_priority)
{
  for (int f = 0; f < 3; f++) {
    mcos_[f].assign(N, 0.0f);
    msin_[f].assign(N, 0.0f);
    a_[f].assign(N, 0.0f);
    b_[f].assign(N, 0.0f);
    n_[f].assign(N, 0.0f);
    na_[f].assign(N, 0.0f);
    nb_[f].assign(N, 0.0f);
  }
  xtable_.assign(N, 0.0f);
  ztable_.assign(N, 0.0f);
  invalid_.assign(N, 1);
  valid_.assign(N, 0.0f);
  raw_depth_.assign(N, 0.0f);
  ir_sum_.assign(N, 0.0f);
  edge_ok_.assign(N, 1);
  std::fill(lut_, lut_ + 2048, 0.0f);
  for (int t = 0; t < threads; t++) threads_.emplace_back([this] { worker_loop(); });
}

Decoder::~Decoder()
{
  {
    std::lock_guard<std::mutex> lock(m_);
    quit_ = true;
  }
  start_.notify_all();
  for (auto &t : threads_) t.join();
}

bool Decoder::load_tables(const uint8_t *p0, size_t p0_len, const float *xtable, const float *ztable, const int16_t *lut)
{
  // libfreenect2::protocol::P0TablesResponse: 8 x u32 header, then three tables of N u16, each
  // between two u16
  const size_t t0 = 32 + 2, t1 = t0 + (size_t)N * 2 + 4, t2 = t1 + (size_t)N * 2 + 4;
  if (!p0 || p0_len < t2 + (size_t)N * 2 || !xtable || !ztable || !lut) return false;
  const size_t offs[3] = {t0, t1, t2};
  for (int f = 0; f < 3; f++) {
    const double m = p_.ab_multiplier_per_frq[f];
    for (int i = 0; i < N; i++) {
      uint16_t raw;
      std::memcpy(&raw, p0 + offs[f] + 2 * (size_t)i, 2);
      const double phase = -(double)raw * 0.000031 * 3.14159265358979323846;
      mcos_[f][i] = (float)(m * std::cos(phase));
      msin_[f][i] = (float)(m * std::sin(phase));
    }
  }
  for (int i = 0; i < N; i++) {
    xtable_[i] = xtable[i];
    ztable_[i] = ztable[i];
    invalid_[i] = !(ztable[i] > 0.0f);
    valid_[i] = invalid_[i] ? 0.0f : 1.0f;
  }
  // where each pixel's 11 bits are in a row: pixel x was sent at position (x % 4) * 128 + x / 4;
  // the first and last column carry nothing (raw 0)
  for (int x = 0; x < W; x++) {
    const int pos = (x & 3) * 128 + (x >> 2);
    const int bit = pos * 11;
    word_off_[x] = (bit >> 4) * 2;
    word_shift_[x] = bit & 15;
    word_keep_[x] = (x < 1 || x > W - 2) ? 0 : 2047;
  }
  for (int k = 0; k < 2048; k++) lut_[k] = (float)lut[k];
  ready_ = true;
  return true;
}

bool Decoder::decode(const uint8_t *packet, size_t len, float *depth, float *ir)
{
  if (!ready_ || !packet || len < PACKET_BYTES || !depth || !ir) return false;
  data_ = reinterpret_cast<const uint16_t *>(packet);
  depth_out_ = depth;
  ir_out_ = ir;
  using Clock = std::chrono::steady_clock;
  auto t0 = Clock::now();
  const std::function<void(int, int)> s1 = [this](int y0, int y1) { stage1(y0, y1); };
  run_parallel(s1);
  auto t1 = Clock::now();
  const std::function<void(int, int)> s2 = [this](int y0, int y1) { stage2(y0, y1); };
  run_parallel(s2);
  auto t2 = Clock::now();
  const std::function<void(int, int)> s3 = [this](int y0, int y1) { stage3(y0, y1); };
  run_parallel(s3);
  auto t3 = Clock::now();
  auto ms = [](Clock::time_point a, Clock::time_point b) { return std::chrono::duration<double, std::milli>(b - a).count(); };
  phase_ms[0] = ms(t0, t1);
  phase_ms[1] = ms(t1, t2);
  phase_ms[2] = ms(t2, t3);
  return true;
}

// ---- the thread pool: blocks of rows handed out by an atomic counter ------------------------

void Decoder::run_parallel(const std::function<void(int, int)> &rows)
{
  next_.store(0);
  {
    std::lock_guard<std::mutex> lock(m_);
    job_ = &rows;
    pending_ = (int)threads_.size();
    generation_++;
  }
  start_.notify_all();
  for (int b; (b = next_.fetch_add(1)) * BLOCK < H;) rows(b * BLOCK, std::min(H, (b + 1) * BLOCK));
  std::unique_lock<std::mutex> lock(m_);
  done_.wait(lock, [this] { return pending_ == 0; });
  job_ = nullptr;
}

void Decoder::worker_loop()
{
#ifdef _WIN32
  if (low_priority_) SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
#endif
  int seen = 0;
  for (;;) {
    const std::function<void(int, int)> *job;
    {
      std::unique_lock<std::mutex> lock(m_);
      start_.wait(lock, [&] { return quit_ || generation_ != seen; });
      if (quit_) return;
      seen = generation_;
      job = job_;
    }
    for (int b; (b = next_.fetch_add(1)) * BLOCK < H;) (*job)(b * BLOCK, std::min(H, (b + 1) * BLOCK));
    {
      std::lock_guard<std::mutex> lock(m_);
      if (--pending_ == 0) done_.notify_one();
    }
  }
}

// ---- stage 1: unpack, phases of the three frequencies, amplitudes, infrared -----------------

void Decoder::stage1(int y0, int y1)
{
  const float cph[3] = {std::cos(p_.phase_in_rad[0]), std::cos(p_.phase_in_rad[1]), std::cos(p_.phase_in_rad[2])};
  const float sph[3] = {std::sin(p_.phase_in_rad[0]), std::sin(p_.phase_in_rad[1]), std::sin(p_.phase_in_rad[2])};
  const __m256 ir_scale = set(0.333333333f * p_.ab_multiplier * p_.ab_output_multiplier);
  const __m256 zero = _mm256_setzero_ps(), sat_v = set(32767.0f), big = set(65535.0f);
  const __m256i mask11 = _mm256_set1_epi32(2047);
  for (int y = y0; y < y1; y++) {
    // rows 0..211 come in order, 212..423 reversed
    const int y_in = y < 212 ? y : 635 - y;
    const size_t base = (size_t)y * W;
    float *irr = ir_out_ + base;
    for (int x = 0; x < W; x += 8) {
      const __m256i off = _mm256_load_si256(reinterpret_cast<const __m256i *>(word_off_ + x));
      const __m256i shift = _mm256_load_si256(reinterpret_cast<const __m256i *>(word_shift_ + x));
      const __m256i keep = _mm256_load_si256(reinterpret_cast<const __m256i *>(word_keep_ + x));
      const __m256 valid = _mm256_load_ps(valid_.data() + base + x);
      __m256 ir_acc = zero;
      for (int f = 0; f < 3; f++) {
        // the three samples of this frequency: 11 bits each at a precomputed place in the row
        __m256 v[3];
        for (int k = 0; k < 3; k++) {
          const int sub = 3 * f + k;
          const uint8_t *row = reinterpret_cast<const uint8_t *>(data_ + (size_t)(424 * sub + y_in) * 352);
          const __m256i word = _mm256_i32gather_epi32(reinterpret_cast<const int *>(row), off, 1);
          const __m256i raw = _mm256_and_si256(_mm256_and_si256(_mm256_srlv_epi32(word, shift), mask11), keep);
          v[k] = _mm256_i32gather_ps(lut_, raw, 4);
        }
        const __m256 c = _mm256_fmadd_ps(v[0], set(cph[0]), _mm256_fmadd_ps(v[1], set(cph[1]), _mm256_mul_ps(v[2], set(cph[2]))));
        const __m256 sn = _mm256_fmadd_ps(v[0], set(sph[0]), _mm256_fmadd_ps(v[1], set(sph[1]), _mm256_mul_ps(v[2], set(sph[2]))));
        const __m256 mc = _mm256_load_ps(mcos_[f].data() + base + x), ms = _mm256_load_ps(msin_[f].data() + base + x);
        __m256 av = _mm256_mul_ps(valid, _mm256_fmsub_ps(mc, c, _mm256_mul_ps(ms, sn)));
        __m256 bv = _mm256_mul_ps(valid, _mm256_sub_ps(zero, _mm256_fmadd_ps(ms, c, _mm256_mul_ps(mc, sn))));
        const __m256 n = _mm256_sqrt_ps(_mm256_fmadd_ps(av, av, _mm256_mul_ps(bv, bv)));
        const __m256 sat = _mm256_or_ps(_mm256_or_ps(_mm256_cmp_ps(v[0], sat_v, _CMP_EQ_OQ), _mm256_cmp_ps(v[1], sat_v, _CMP_EQ_OQ)),
                                        _mm256_cmp_ps(v[2], sat_v, _CMP_EQ_OQ));
        av = _mm256_andnot_ps(sat, av);
        bv = _mm256_andnot_ps(sat, bv);
        _mm256_store_ps(a_[f].data() + base + x, av);
        _mm256_store_ps(b_[f].data() + base + x, bv);
        _mm256_store_ps(n_[f].data() + base + x, n);
        const __m256 inv_n = _mm256_and_ps(gt(n, zero), _mm256_div_ps(set(1.0f), _mm256_max_ps(n, set(1e-30f))));
        _mm256_store_ps(na_[f].data() + base + x, _mm256_mul_ps(av, inv_n));
        _mm256_store_ps(nb_[f].data() + base + x, _mm256_mul_ps(bv, inv_n));
        ir_acc = _mm256_add_ps(ir_acc, select_ps(sat, big, n));
      }
      _mm256_storeu_ps(irr + x, _mm256_min_ps(_mm256_mul_ps(ir_acc, ir_scale), big));
    }
  }
}

// ---- stage 2: joint bilateral filter on the phases, phase unwrapping, depth -----------------

void Decoder::stage2(int y0, int y1)
{
  const float jb_threshold = (p_.joint_bilateral_ab_threshold * p_.joint_bilateral_ab_threshold) / (p_.ab_multiplier * p_.ab_multiplier);
  const float jb_exp = -1.442695f * p_.joint_bilateral_exp;
  const float *g = p_.gaussian_kernel;
  const float slope = p_.ab_confidence_slope;
  const float max_edge = p_.joint_bilateral_max_edge;
  alignas(32) float af[3][W], bf[3][W];
  alignas(32) float thr[W], ex[W], wsum[W], wa[W], wb[W], dacc[W];
  alignas(32) uint8_t edge[W];
  for (int y = y0; y < y1; y++) {
    const size_t base = (size_t)y * W;
    const bool border_row = y < 1 || y > 422;
    std::memset(edge, 1, W);
    for (int f = 0; f < 3; f++) {
      const float *A = a_[f].data() + base, *B = b_[f].data() + base, *Nn = n_[f].data() + base;
      const float *NA = na_[f].data() + base, *NB = nb_[f].data() + base;
      if (!p_.bilateral_filter || border_row) {
        std::memcpy(af[f], A, sizeof(float) * W);
        std::memcpy(bf[f], B, sizeof(float) * W);
        continue;
      }
      // per pixel: weak pixels (c0) take every neighbour with the plain gaussian
      for (int x = 0; x < W; x++) {
        const bool c0 = Nn[x] * Nn[x] < jb_threshold;
        thr[x] = c0 ? 0.0f : jb_threshold;
        ex[x] = c0 ? 0.0f : jb_exp;
        wsum[x] = wa[x] = wb[x] = dacc[x] = 0.0f;
      }
      // the nine neighbours one after the other, each over the whole row (contiguous, vectorized)
      int j = 0;
      for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++, j++) {
          const ptrdiff_t o = (ptrdiff_t)dy * W + dx;
          const float *oN = Nn + o, *oNA = NA + o, *oNB = NB + o, *oA = A + o, *oB = B + o;
          const float gj = g[j];
          int x = 1;
          const __m256 vg = set(gj), half = set(0.5f), one = set(1.0f);
          for (; x + 8 <= W - 1; x += 8) {
            const __m256 on = _mm256_loadu_ps(oN + x);
            const __m256 c1 = lt(_mm256_mul_ps(on, on), _mm256_loadu_ps(thr + x));
            const __m256 dot = _mm256_fmadd_ps(_mm256_loadu_ps(NA + x), _mm256_loadu_ps(oNA + x),
                                               _mm256_mul_ps(_mm256_loadu_ps(NB + x), _mm256_loadu_ps(oNB + x)));
            const __m256 dist = _mm256_mul_ps(half, _mm256_sub_ps(one, dot));
            const __m256 w = _mm256_andnot_ps(c1, _mm256_mul_ps(vg, exp_ps(_mm256_mul_ps(_mm256_loadu_ps(ex + x), dist))));
            _mm256_storeu_ps(wa + x, _mm256_fmadd_ps(w, _mm256_loadu_ps(oA + x), _mm256_loadu_ps(wa + x)));
            _mm256_storeu_ps(wb + x, _mm256_fmadd_ps(w, _mm256_loadu_ps(oB + x), _mm256_loadu_ps(wb + x)));
            _mm256_storeu_ps(wsum + x, _mm256_add_ps(w, _mm256_loadu_ps(wsum + x)));
            _mm256_storeu_ps(dacc + x, _mm256_add_ps(_mm256_andnot_ps(c1, dist), _mm256_loadu_ps(dacc + x)));
          }
          for (; x < W - 1; x++) {
            const bool c1 = oN[x] * oN[x] < thr[x];
            const float dist = 0.5f * (1.0f - (NA[x] * oNA[x] + NB[x] * oNB[x]));
            const float e = gj * fast_exp(ex[x] * dist);
            const float w = c1 ? 0.0f : e;
            wa[x] += w * oA[x];
            wb[x] += w * oB[x];
            wsum[x] += w;
            dacc[x] += c1 ? 0.0f : dist;
          }
        }
      }
      for (int x = 1; x < W - 1; x++) {
        // a pixel without signal stays without (libfreenect2 gets NaN there, then 0)
        const bool ok = wsum[x] > 0.0f && Nn[x] > 0.0f;
        const float inv = ok ? 1.0f / wsum[x] : 0.0f;
        af[f][x] = wa[x] * inv;
        bf[f][x] = wb[x] * inv;
        edge[x] &= (uint8_t)(dacc[x] < max_edge);
      }
      af[f][0] = A[0];
      bf[f][0] = B[0];
      af[f][W - 1] = A[W - 1];
      bf[f][W - 1] = B[W - 1];
    }
    std::memcpy(edge_ok_.data() + base, edge, W);
    const float *xt = xtable_.data() + base, *zt = ztable_.data() + base;
    float *rd = raw_depth_.data() + base, *irs = ir_sum_.data() + base;
    const float *a0 = af[0], *a1 = af[1], *a2 = af[2], *b0 = bf[0], *b1 = bf[1], *b2 = bf[2];
    const float abm = p_.ab_multiplier, conf_off = p_.ab_confidence_offset;
    const float max_conf = p_.max_dealias_confidence, min_conf = p_.min_dealias_confidence;
    const float ind_thr = p_.individual_ab_threshold, ab_thr = p_.ab_threshold, ph_off = p_.phase_offset;
    const float unamb2 = p_.unambigious_dist * 2.0f;
    const bool slope_pos = slope > 0.0f;
    const __m256 zero = _mm256_setzero_ps(), two_pi = set(TWO_PI);
    for (int x = 0; x < W; x += 8) {
      const __m256 va0 = _mm256_load_ps(a0 + x), va1 = _mm256_load_ps(a1 + x), va2 = _mm256_load_ps(a2 + x);
      const __m256 vb0 = _mm256_load_ps(b0 + x), vb1 = _mm256_load_ps(b1 + x), vb2 = _mm256_load_ps(b2 + x);
      __m256 ph0 = atan2_ps(vb0, va0), ph1 = atan2_ps(vb1, va1), ph2 = atan2_ps(vb2, va2);
      ph0 = _mm256_add_ps(ph0, _mm256_and_ps(lt(ph0, zero), two_pi));
      ph1 = _mm256_add_ps(ph1, _mm256_and_ps(lt(ph1, zero), two_pi));
      ph2 = _mm256_add_ps(ph2, _mm256_and_ps(lt(ph2, zero), two_pi));
      const __m256 ir0 = _mm256_mul_ps(_mm256_sqrt_ps(_mm256_fmadd_ps(va0, va0, _mm256_mul_ps(vb0, vb0))), set(abm));
      const __m256 ir1 = _mm256_mul_ps(_mm256_sqrt_ps(_mm256_fmadd_ps(va1, va1, _mm256_mul_ps(vb1, vb1))), set(abm));
      const __m256 ir2 = _mm256_mul_ps(_mm256_sqrt_ps(_mm256_fmadd_ps(va2, va2, _mm256_mul_ps(vb2, vb2))), set(abm));
      const __m256 ir_sum = _mm256_add_ps(_mm256_add_ps(ir0, ir1), ir2);
      const __m256 ir_min = _mm256_min_ps(ir0, _mm256_min_ps(ir1, ir2));
      const __m256 ir_max = _mm256_max_ps(ir0, _mm256_max_ps(ir1, ir2));
      const __m256 t0 = _mm256_mul_ps(ph0, set(3.0f / TWO_PI));
      const __m256 t1 = _mm256_mul_ps(ph1, set(15.0f / TWO_PI));
      const __m256 t2 = _mm256_mul_ps(ph2, set(2.0f / TWO_PI));
      const __m256 t5 = _mm256_fmadd_ps(_mm256_floor_ps(_mm256_fmadd_ps(_mm256_sub_ps(t1, t0), set(0.333333f), set(0.5f))), set(3.0f), t0);
      __m256 t3 = _mm256_sub_ps(t5, t2);
      const __m256 c1 = ge(t3, zero);
      const __m256 f1 = select_ps(c1, set(2.0f), set(-2.0f));
      const __m256 f2 = select_ps(c1, set(0.5f), set(-0.5f));
      t3 = _mm256_mul_ps(t3, f2);
      t3 = _mm256_mul_ps(_mm256_sub_ps(t3, _mm256_floor_ps(t3)), f1);
      const __m256 at3 = abs_ps(t3);
      const __m256 c2 = _mm256_and_ps(lt(set(0.5f), at3), lt(at3, set(1.5f)));
      __m256 t6 = _mm256_add_ps(t5, _mm256_and_ps(c2, set(15.0f)));
      __m256 t7 = _mm256_add_ps(t1, _mm256_and_ps(c2, set(15.0f)));
      __m256 t8 = _mm256_mul_ps(_mm256_fmadd_ps(_mm256_floor_ps(_mm256_fmadd_ps(_mm256_sub_ps(t6, t2), set(0.5f), set(0.5f))), set(2.0f), t2), set(0.5f));
      t6 = _mm256_mul_ps(t6, set(0.333333f));
      t7 = _mm256_mul_ps(t7, set(0.066667f));
      const __m256 t9 = _mm256_add_ps(_mm256_add_ps(t8, t6), t7);
      const __m256 t10 = _mm256_and_ps(ge(t9, zero), _mm256_mul_ps(t9, set(0.333333f)));
      t6 = _mm256_mul_ps(t6, two_pi);
      t7 = _mm256_mul_ps(t7, two_pi);
      t8 = _mm256_mul_ps(t8, two_pi);
      const __m256 t8n = _mm256_fmsub_ps(t7, set(0.826977f), _mm256_mul_ps(t8, set(0.110264f)));
      const __m256 t6n = _mm256_fmsub_ps(t8, set(0.551318f), _mm256_mul_ps(t6, set(0.826977f)));
      const __m256 t7n = _mm256_fmsub_ps(t6, set(0.110264f), _mm256_mul_ps(t7, set(0.551318f)));
      const __m256 norm = _mm256_fmadd_ps(t8n, t8n, _mm256_fmadd_ps(t6n, t6n, _mm256_mul_ps(t7n, t7n)));
      __m256 irx = slope_pos ? ir_min : ir_max;
      irx = log_ps(_mm256_max_ps(irx, set(1e-20f)));
      irx = exp_ps(_mm256_mul_ps(_mm256_fmadd_ps(irx, set(slope * 0.301030f), set(conf_off)), set(3.321928f)));
      irx = _mm256_min_ps(set(max_conf), _mm256_max_ps(set(min_conf), irx));
      irx = _mm256_mul_ps(irx, irx);
      const __m256 strong = _mm256_and_ps(_mm256_and_ps(ge(ir_min, set(ind_thr)), ge(ir_sum, set(ab_thr))), ge(irx, norm));
      __m256 pf = _mm256_and_ps(strong, t10);
      pf = _mm256_add_ps(pf, _mm256_and_ps(gt(pf, zero), set(ph_off)));
      const __m256 dl = _mm256_mul_ps(_mm256_load_ps(zt + x), pf);
      const __m256 md = _mm256_mul_ps(pf, set(unamb2));
      const __m256 cond1 = _mm256_and_ps(gt(dl, zero), gt(md, zero));
      const __m256 md2 = select_ps(cond1, _mm256_mul_ps(_mm256_mul_ps(md, md), set(8192.0f)), set(1.0f));
      const __m256 xm = _mm256_div_ps(_mm256_mul_ps(_mm256_load_ps(xt + x), set(90.0f)), md2);
      __m256 df = _mm256_div_ps(dl, _mm256_fnmadd_ps(dl, xm, set(1.0f)));
      df = _mm256_max_ps(df, zero);
      _mm256_store_ps(rd + x, select_ps(cond1, df, dl));
      _mm256_store_ps(irs + x, ir_sum);
    }
  }
}

// ---- stage 3: edge-aware filter (flying pixels at depth edges) -------------------------------

void Decoder::stage3(int y0, int y1)
{
  const float min_d = p_.min_depth, max_d = p_.max_depth;
  const __m256 zero = _mm256_setzero_ps(), inf = set(3.0e38f), ninth = set(1.0f / 9.0f);
  for (int y = y0; y < y1; y++) {
    const size_t base = (size_t)y * W;
    const float *rd = raw_depth_.data();
    const float *irs = ir_sum_.data();
    float *out = depth_out_ + base;
    if (!p_.edge_aware_filter) {
      std::memcpy(out, rd + base, sizeof(float) * W);
      continue;
    }
    const bool border_row = y < 1 || y > 422;
    auto scalar = [&](int x) {
      const size_t i = base + x;
      const float d = rd[i];
      const bool in_range = d >= min_d && d <= max_d;
      if (border_row || x < 1 || x > W - 2) {
        out[x] = in_range ? d : 0.0f;
        return;
      }
      const float s = irs[i];
      float acc = s, sq = s * s, mn = d, mx = d;
      for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
          if (dx == 0 && dy == 0) continue;
          const size_t o = i + (ptrdiff_t)dy * W + dx;
          const float so = irs[o];
          acc += so;
          sq += so * so;
          const float dO = rd[o];
          mn = dO > 0.0f ? std::min(mn, dO) : mn;
          mx = dO > 0.0f ? std::max(mx, dO) : mx;
        }
      }
      float tmp0 = std::sqrt(std::max(0.0f, sq * 9.0f - acc * acc)) / 9.0f;
      const float edge_avg = std::max(acc / 9.0f, p_.edge_ab_avg_min_value);
      tmp0 /= edge_avg;
      const float amin = std::fabs(d - mn), amax = std::fabs(d - mx);
      const float avg = (amin + amax) * 0.5f, maxd = std::max(amin, amax);
      const bool cond0 = d > 0.0f && tmp0 >= p_.edge_ab_std_dev_threshold && p_.edge_close_delta_threshold < amin &&
                         p_.edge_far_delta_threshold < amax && p_.edge_max_delta_threshold < maxd && p_.edge_avg_delta_threshold < avg;
      out[x] = in_range && !cond0 && edge_ok_[i] ? d : 0.0f;
    };
    if (border_row) {
      for (int x = 0; x < W; x++) scalar(x);
      continue;
    }
    scalar(0);
    int x = 1;
    for (; x + 8 <= W - 1; x += 8) {
      const size_t i = base + x;
      const __m256 d = _mm256_loadu_ps(rd + i);
      const __m256 s = _mm256_loadu_ps(irs + i);
      __m256 acc = s, sq = _mm256_mul_ps(s, s), mn = d, mx = d;
      for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
          if (dx == 0 && dy == 0) continue;
          const size_t o = i + (ptrdiff_t)dy * W + dx;
          const __m256 so = _mm256_loadu_ps(irs + o);
          acc = _mm256_add_ps(acc, so);
          sq = _mm256_fmadd_ps(so, so, sq);
          const __m256 dO = _mm256_loadu_ps(rd + o);
          const __m256 pos = gt(dO, zero);
          mn = _mm256_min_ps(mn, select_ps(pos, dO, inf));
          mx = _mm256_max_ps(mx, select_ps(pos, dO, zero));
        }
      }
      __m256 tmp0 = _mm256_mul_ps(_mm256_sqrt_ps(_mm256_max_ps(zero, _mm256_fmsub_ps(sq, set(9.0f), _mm256_mul_ps(acc, acc)))), ninth);
      const __m256 edge_avg = _mm256_max_ps(_mm256_mul_ps(acc, ninth), set(p_.edge_ab_avg_min_value));
      tmp0 = _mm256_div_ps(tmp0, edge_avg);
      const __m256 amin = abs_ps(_mm256_sub_ps(d, mn)), amax = abs_ps(_mm256_sub_ps(d, mx));
      const __m256 avg = _mm256_mul_ps(_mm256_add_ps(amin, amax), set(0.5f)), maxd = _mm256_max_ps(amin, amax);
      __m256 cond0 = _mm256_and_ps(gt(d, zero), ge(tmp0, set(p_.edge_ab_std_dev_threshold)));
      cond0 = _mm256_and_ps(cond0, lt(set(p_.edge_close_delta_threshold), amin));
      cond0 = _mm256_and_ps(cond0, lt(set(p_.edge_far_delta_threshold), amax));
      cond0 = _mm256_and_ps(cond0, lt(set(p_.edge_max_delta_threshold), maxd));
      cond0 = _mm256_and_ps(cond0, lt(set(p_.edge_avg_delta_threshold), avg));
      const __m256 in_range = _mm256_and_ps(ge(d, set(min_d)), le(d, set(max_d)));
      const __m128i e8 = _mm_loadl_epi64(reinterpret_cast<const __m128i *>(edge_ok_.data() + i));
      const __m256 edge = _mm256_castsi256_ps(_mm256_cmpgt_epi32(_mm256_cvtepu8_epi32(e8), _mm256_setzero_si256()));
      const __m256 keep = _mm256_andnot_ps(cond0, _mm256_and_ps(in_range, edge));
      _mm256_storeu_ps(out + x, _mm256_and_ps(keep, d));
    }
    for (; x < W; x++) scalar(x);
  }
}

} // namespace fastdepth
