// The time-of-flight decoding on the GPU: the same steps, constants and approximations as the
// CPU decoder (tof/kernels.rs, tof/resolve.rs, tof/fill.rs), one invocation per pixel.
//
// The Rust side puts a prelude in front of this file: the image, plane and format constants and
// `struct Params` (generated from the same values the CPU decoder uses).
//
// The values between the stages take 16 bits each, in the formats of tof/pack.rs (f16 or fixed
// point; the CPU decoder stores the same), two to a 32-bit word.
//
// Buffers:
//   raw   the nine phase sub-images as u32 words, then one row mask per image row (bit s = row
//         of sub-image s arrived)
//   tabs  per-pixel tables (planes T_*: m cos(p0) and m sin(p0) as a snorm pair per frequency,
//         x and z as f32 bits) and the 11-to-16-bit lookup table (f32 bits)
//   work  the work words (planes W_*) and the push-pull pyramid
//   L     the level of a push-pull step

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> raw: array<u32>;
@group(0) @binding(2) var<storage, read> tabs: array<u32>;
@group(0) @binding(3) var<storage, read_write> work: array<u32>;

// a push-pull level and its parent: (vw, wt) as f16 pairs, the filled values as f32 bits
struct Level {
    w: u32,
    h: u32,
    pw: u32,
    ph: u32,
    vwt: u32,
    filled: u32,
    pvwt: u32,
    pfilled: u32,
}
@group(1) @binding(0) var<uniform> L: Level;

const PI: f32 = 3.14159265;
const TAU: f32 = 6.28318531;
const BIG: f32 = 3.0e38;

fn wget(p: u32, i: u32) -> u32 { return work[p * N + i]; }
fn wset(p: u32, i: u32, v: u32) { work[p * N + i] = v; }
fn tget(p: u32, i: u32) -> f32 { return bitcast<f32>(tabs[p * N + i]); }

// ---- the 16-bit formats (tof/pack.rs) ---------------------------------------------------------

// NaN as 0
fn sane(v: f32) -> f32 { return select(0.0, v, v == v); }
// two halves into a word
fn pair(lo: u32, hi: u32) -> u32 { return (lo & 0xffffu) | (hi << 16u); }
// t rounded to the nearest integer (ties to even), the low 16 bits of its two's complement
fn q16(t: f32) -> u32 { return bitcast<u32>(i32(round(t))) & 0xffffu; }
// binary16 bits of a finite v within +-65504, rounded to the nearest even (pack.rs f16_bits;
// not pack2x16float, whose rounding WGSL leaves to the GPU: AMD rounds towards zero)
fn f16_bits(v: f32) -> u32 {
    let x = bitcast<u32>(v);
    let sign = (x >> 16u) & 0x8000u;
    let a = x & 0x7fffffffu;
    let normal = (a - 0x38000000u + 0x0fffu + ((a >> 13u) & 1u)) >> 13u;
    // below 2^-14: a multiple of 2^-24; adding 0.5 (whose last bit is 2^-24) rounds it there
    let sub = bitcast<u32>(bitcast<f32>(a) + 0.5) - 0x3f000000u;
    return sign | select(normal, sub, a < 0x38800000u);
}
// the value of binary16 bits, exact (pack.rs f16_value; subnormals included)
fn f16_value(h: u32) -> f32 {
    let sign = (h & 0x8000u) << 16u;
    let em = h & 0x7fffu;
    let normal = (em << 13u) + 0x38000000u;
    let sub = bitcast<u32>(bitcast<f32>(0x3f000000u + em) - 0.5);
    return bitcast<f32>(sign | select(normal, sub, em < 0x400u));
}
// two binary16 values in a word, and back
fn f16x2_of(v: vec2<f32>) -> u32 { return pair(f16_bits(clamp(sane(v.x), -F16_MAX, F16_MAX)), f16_bits(clamp(sane(v.y), -F16_MAX, F16_MAX))); }
fn f16x2_val(w: u32) -> vec2<f32> { return vec2<f32>(f16_value(w & 0xffffu), f16_value(w >> 16u)); }
// binary16 of v * scale (clamped to the finite range), and back (`inv` = 1 / scale)
fn f16_of(v: f32, scale: f32) -> u32 { return f16_bits(clamp(sane(v * scale), -F16_MAX, F16_MAX)); }
fn f16_val(bits: u32, inv: f32) -> f32 { return f16_value(bits & 0xffffu) * inv; }
fn unorm_of(v: f32) -> u32 { return q16(clamp(sane(v), 0.0, 1.0) * 65535.0); }
fn unorm_val(bits: u32) -> f32 { return f32(bits & 0xffffu) * INV_65535; }
fn snorm_of(v: f32) -> u32 { return q16(clamp(sane(v), -1.0, 1.0) * 32767.0); }
fn snorm_val(bits: u32) -> f32 { return max(f32(bitcast<i32>(bits << 16u) >> 16u) * INV_32767, -1.0); }
fn frac_of(u: f32) -> u32 { return q16(clamp((sane(u) + FRAC_OFFSET) * INV_FRAC_SPAN, 0.0, 1.0) * 65535.0); }
fn frac_val(bits: u32) -> f32 { return f32(bits & 0xffffu) * INV_65535 * FRAC_SPAN - FRAC_OFFSET; }
fn mm_of(d: f32) -> u32 { return q16(clamp(sane(d) * 2.0, 0.0, 65535.0)); }
fn mm_val(bits: u32) -> f32 { return f32(bits & 0xffffu) * 0.5; }

// stage 1 values of frequency k at pixel i: (a, b), (a, b) / amplitude, amplitude
fn ab_at(k: u32, i: u32) -> vec2<f32> { return f16x2_val(wget(W_AB + k, i)) * AB_INV; }
fn dir_at(k: u32, i: u32) -> vec2<f32> {
    let w = wget(W_DIR + k, i);
    return vec2<f32>(snorm_val(w), snorm_val(w >> 16u));
}
fn amp_at(k: u32, i: u32) -> f32 {
    if (k == 0u) { return f16_val(wget(W_N01, i), AMP_INV); }
    if (k == 1u) { return f16_val(wget(W_N01, i) >> 16u, AMP_INV); }
    return f16_val(wget(W_IRN, i) >> 16u, AMP_INV);
}
// the small word: usable bits 0..2, bilateral edge test 3, saturation bits 4..6, kind 8..15;
// the anchor weight in the high half
fn edge_ok_at(i: u32) -> bool { return ((wget(W_SMALL, i) >> 3u) & 1u) != 0u; }
fn anchor_at(i: u32) -> f32 { return unorm_val(wget(W_SMALL, i) >> 16u); }

// ---- math: the CPU decoder's approximations (tof/math.rs) -----------------------------------

fn atan2_(y: f32, x: f32) -> f32 {
    let ax = abs(x);
    let ay = abs(y);
    let mx = max(ax, ay);
    let mn = min(ax, ay);
    var a = 0.0;
    if (mx > 0.0) { a = mn / max(mx, 1e-30); }
    let s = a * a;
    var p = -0.0117212;
    p = p * s + 0.05265332;
    p = p * s - 0.11643287;
    p = p * s + 0.19354346;
    p = p * s - 0.33262347;
    p = p * s + 0.99997726;
    var r = a * p;
    if (ay > ax) { r = 1.5707964 - r; }
    if (x < 0.0) { r = PI - r; }
    if (y < 0.0) { r = -r; }
    return r;
}

fn exp_(x0: f32) -> f32 {
    let x = min(max(x0, -87.0), 88.0);
    let t = x * 1.44269504;
    let fi = floor(t);
    let f = t - fi;
    var p = 0.00133336;
    p = p * f + 0.00961813;
    p = p * f + 0.05550411;
    p = p * f + 0.2402265;
    p = p * f + 0.69314718;
    p = p * f + 1.0;
    let biased = bitcast<u32>(fi + 127.0 + 8388608.0);
    return p * bitcast<f32>(biased << 23u);
}

fn ln_(x: f32) -> f32 {
    let u = bitcast<u32>(x);
    let e = i32((u >> 23u) & 255u) - 127;
    let m = bitcast<f32>((u & 0x007fffffu) | 0x3f800000u);
    let z = (m - 1.0) / (m + 1.0);
    let z2 = z * z;
    var p = 0.11111111;
    p = p * z2 + 0.14285714;
    p = p * z2 + 0.2;
    p = p * z2 + 0.33333333;
    p = p * z2 + 1.0;
    return f32(e) * 0.69314718 + 2.0 * z * p;
}

fn round_(x: f32) -> f32 { return floor(x + 0.5); }

fn depth_from_phase(phase: f32, xt: f32, zt: f32) -> f32 {
    let depth_linear = zt * phase;
    let max_depth = phase * UNIT_MM * 2.0;
    let cond = depth_linear > 0.0 && max_depth > 0.0;
    var md2 = 1.0;
    if (cond) { md2 = max_depth * max_depth * 8192.0; }
    let xmul = (xt * 90.0) / md2;
    var fit = depth_linear / (-depth_linear * xmul + 1.0);
    if (fit < 0.0) { fit = 0.0; }
    if (cond) { return fit; }
    return depth_linear;
}

fn depth_of_u(u: f32, xt: f32, zt: f32) -> f32 { return depth_from_phase(9.0 * u, xt, zt); }

fn u_of_depth(z: f32, zt: f32) -> f32 {
    if (zt > 0.0) { return z / (9.0 * zt); }
    return 0.0;
}

fn gain(k: u32) -> f32 {
    if (k == 0u) { return P.gain0; }
    if (k == 1u) { return P.gain1; }
    return P.gain2;
}

fn noise(k: u32) -> f32 {
    if (k == 0u) { return P.noise0; }
    if (k == 1u) { return P.noise1; }
    return P.noise2;
}

fn gauss(j: u32) -> f32 {
    switch (j) {
        case 0u: { return P.g0; }
        case 1u: { return P.g1; }
        case 2u: { return P.g2; }
        case 3u: { return P.g3; }
        case 4u: { return P.g4; }
        case 5u: { return P.g5; }
        case 6u: { return P.g6; }
        case 7u: { return P.g7; }
        default: { return P.g8; }
    }
}

fn nf(k: u32) -> f32 {
    if (k == 0u) { return 10.0; }
    if (k == 1u) { return 2.0; }
    return 15.0;
}

// ---- stage 1: samples -> complex value per frequency ---------------------------------------

// the 11-bit code of pixel x in image row y of phase sub-image s
fn code_at(s: u32, y: u32, x: u32) -> u32 {
    var pr = y;
    if (y >= 212u) { pr = 635u - y; }
    let base = s * SUB_WORDS + pr * ROW_WORDS;
    let q = x & 3u;
    let j = x >> 2u;
    let g = q * 8u + (j >> 4u);
    let t = j & 15u;
    let bit = g * 176u + 11u * t;
    let wi = base + (bit >> 5u);
    let sh = bit & 31u;
    var v = raw[wi] >> sh;
    if (sh > 21u) { v = v | (raw[wi + 1u] << (32u - sh)); }
    return v & 2047u;
}

// the stage 1 values of frequency k (the amplitude is stored with the others, see stage1)
fn store_s1(k: u32, i: u32, av: f32, bv: f32, nn: f32) {
    wset(W_AB + k, i, pair(f16_of(av, AB_SCALE), f16_of(bv, AB_SCALE)));
    var inv = 0.0;
    if (nn > 0.0) { inv = 1.0 / max(nn, 1e-30); }
    wset(W_DIR + k, i, pair(snorm_of(av * inv), snorm_of(bv * inv)));
}

// the amplitudes and the infrared (two words)
fn store_amps(i: u32, n0: f32, n1: f32, n2: f32, ir: f32) {
    wset(W_N01, i, pair(f16_of(n0, AMP_SCALE), f16_of(n1, AMP_SCALE)));
    wset(W_IRN, i, pair(f16_of(ir, IR_SCALE), f16_of(n2, AMP_SCALE)));
}

@compute @workgroup_size(16, 8, 1)
fn stage1(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if (x >= W || y >= H) { return; }
    let i = y * W + x;
    let mask = raw[MASK_BASE + y];
    var v: array<f32, 9>;
    for (var s = 0u; s < 9u; s++) {
        var val = 0.0;
        if (((mask >> s) & 1u) != 0u) {
            var c = 0u;
            if (x != 0u && x != W - 1u) { c = code_at(s, y, x); }
            val = bitcast<f32>(tabs[T_LUT + c]);
        }
        v[s] = val;
    }
    var valid = 0.0;
    if (tget(T_ZT, i) > 0.0) { valid = 1.0; }
    var amp: array<f32, 3>;
    if (P.mode == 0u) {
        // compat (libfreenect2): a saturated sample zeroes its frequency, white infrared
        var ir_acc = 0.0;
        for (var k = 0u; k < 3u; k++) {
            let v0 = v[3u * k];
            let v1 = v[3u * k + 1u];
            let v2 = v[3u * k + 2u];
            let fok = ((mask >> (3u * k)) & 7u) == 7u;
            let mcs = tabs[(T_MCS + k) * N + i];
            let mc = snorm_val(mcs) * TABLE_RANGE;
            let ms = snorm_val(mcs >> 16u) * TABLE_RANGE;
            let c = v0 * P.cos_t0 + v1 * P.cos_t1 + v2 * P.cos_t2;
            let s = v0 * P.sin_t0 + v1 * P.sin_t1 + v2 * P.sin_t2;
            var vk = 0.0;
            if (fok) { vk = valid; }
            var av = vk * (mc * c - ms * s);
            var bv = vk * -(ms * c + mc * s);
            let nn = sqrt(av * av + bv * bv);
            let sat = v0 == SATURATED || v1 == SATURATED || v2 == SATURATED;
            if (sat) {
                av = 0.0;
                bv = 0.0;
            }
            store_s1(k, i, av, bv, nn);
            amp[k] = nn;
            if (sat) { ir_acc += 65535.0; } else { ir_acc += nn; }
        }
        store_amps(i, amp[0], amp[1], amp[2], min(ir_acc * P.ir_scale, 65535.0));
        wset(W_SMALL, i, 0u);
        wset(W_FLAGS, i, 0u);
        return;
    }
    // extended: one saturated or lost sample is rebuilt from the other two, HDR infrared
    var ir_acc = 0.0;
    var w_acc = 0.0;
    var usable = 0u;
    var fl = 0u;
    let lost = (mask & 511u) != 511u;
    for (var k = 0u; k < 3u; k++) {
        let x0 = v[3u * k];
        let x1 = v[3u * k + 1u];
        let x2 = v[3u * k + 2u];
        let m0 = ((mask >> (3u * k)) & 1u) == 0u;
        let m1 = ((mask >> (3u * k + 1u)) & 1u) == 0u;
        let m2 = ((mask >> (3u * k + 2u)) & 1u) == 0u;
        let nmiss = u32(m0) + u32(m1) + u32(m2);
        let ok = nmiss == 0u || (nmiss == 1u && P.repair_lost != 0u);
        let mcs = tabs[(T_MCS + k) * N + i];
        let mc = snorm_val(mcs) * TABLE_RANGE;
        let ms = snorm_val(mcs >> 16u) * TABLE_RANGE;
        let st0 = x0 == SATURATED || (P.full_scale != 0u && abs(x0) >= FULL_SCALE);
        let st1 = x1 == SATURATED || (P.full_scale != 0u && abs(x1) >= FULL_SCALE);
        let st2 = x2 == SATURATED || (P.full_scale != 0u && abs(x2) >= FULL_SCALE);
        let nsat = u32(st0) + u32(st1) + u32(st2);
        let u0 = st0 || m0;
        let u1 = st1 || m1;
        let u2 = st2 || m2;
        let nunk = u32(u0) + u32(u1) + u32(u2);
        var k0 = x0;
        if (u0) { k0 = 0.0; }
        var k1 = x1;
        if (u1) { k1 = 0.0; }
        var k2 = x2;
        if (u2) { k2 = 0.0; }
        let sum_ok = k0 + k1 + k2;
        let max_ok = max(max(abs(k0), abs(k1)), abs(k2));
        let imputed = -sum_ok;
        var plausible = true;
        if (nmiss != 1u) { plausible = P.repair != 0u && abs(imputed) >= P.repair_ratio * max_ok; }
        let repaired = nunk == 1u && plausible;
        var y0 = x0;
        if (u0) { y0 = imputed; }
        var y1 = x1;
        if (u1) { y1 = imputed; }
        var y2 = x2;
        if (u2) { y2 = imputed; }
        let good = ok && valid > 0.0 && (nunk == 0u || repaired);
        let c = y0 * P.cos_t0 + y1 * P.cos_t1 + y2 * P.cos_t2;
        let s = y0 * P.sin_t0 + y1 * P.sin_t1 + y2 * P.sin_t2;
        var av = 0.0;
        var bv = 0.0;
        if (good) {
            av = mc * c - ms * s;
            bv = -(ms * c + mc * s);
        }
        let nn = sqrt(av * av + bv * bv);
        store_s1(k, i, av, bv, nn);
        amp[k] = nn;
        var w = 0.0;
        if (good) {
            w = 1.0;
            if (repaired) { w = P.w_repaired; }
        }
        ir_acc += w * nn * gain(k);
        w_acc += w;
        if (good && nn > 0.0) { usable |= 1u << k; }
        if (nsat > 0u) { fl |= 1u << k; }
        if (repaired && good) { fl |= 1u << (3u + k); }
    }
    var ir = 0.0;
    if (w_acc > 0.0) { ir = ir_acc / max(w_acc, 1e-30) * P.ir_lin; }
    let clipped = w_acc <= 0.0 && (fl & FL_SATURATED_ANY) != 0u;
    if (lost) { fl |= FL_DATA_LOST; }
    if (clipped) { fl |= FL_IR_FILLED; }
    store_amps(i, amp[0], amp[1], amp[2], ir);
    wset(W_SMALL, i, usable);
    wset(W_FLAGS, i, fl);
}

// ---- stage 2: bilateral filter, unwrapping ----------------------------------------------

// libfreenect2's joint bilateral filter of frequency k at (x, y): (a, b, edge ok)
fn bilateral(x: u32, y: u32, k: u32, ext: bool) -> vec3<f32> {
    let i = y * W + x;
    let ab_c = ab_at(k, i);
    if (P.bilateral == 0u || y < 1u || y > H - 2u || x < 1u || x > W - 2u) {
        return vec3<f32>(ab_c.x, ab_c.y, 1.0);
    }
    let nn = amp_at(k, i);
    let c0 = nn * nn < P.jb_threshold;
    var thr = P.jb_threshold;
    var ex = P.jb_exp;
    if (c0) {
        thr = 0.0;
        ex = 0.0;
    }
    let sdir = dir_at(k, i);
    var wsum = 0.0;
    var wa = 0.0;
    var wb = 0.0;
    var dacc = 0.0;
    var j = 0u;
    for (var dy = 0u; dy < 3u; dy++) {
        for (var dx = 0u; dx < 3u; dx++) {
            let g = gauss(j);
            j++;
            let o = (y + dy - 1u) * W + (x + dx - 1u);
            let on = amp_at(k, o);
            var c1 = on * on < thr;
            if (ext) { c1 = c1 || on <= 0.0; }
            let d = dir_at(k, o);
            let dot = sdir.x * d.x + sdir.y * d.y;
            let dist = 0.5 * (1.0 - dot);
            var w = 0.0;
            if (!c1) { w = g * exp_(ex * dist); }
            let ab = ab_at(k, o);
            wa += w * ab.x;
            wb += w * ab.y;
            wsum += w;
            if (!c1) { dacc += dist; }
        }
    }
    let ok = wsum > 0.0 && nn > 0.0;
    var inv = 0.0;
    if (ok) { inv = 1.0 / max(wsum, 1e-30); }
    let edge_here = dacc < P.max_edge;
    let counts = !ext || thr > 0.0;
    var e = 0.0;
    if (edge_here || !counts) { e = 1.0; }
    return vec3<f32>(wa * inv, wb * inv, e);
}

fn row_clamped(y: u32, d: i32) -> u32 {
    return u32(clamp(i32(y) + d, 0, i32(H) - 1));
}

// 5 x 5 phase-coherent average of a weak pixel: (a, b, taken)
fn weak_boost(x: u32, y: u32, k: u32, af: f32, bf: f32) -> vec3<f32> {
    if (x < 2u || x > W - 3u) { return vec3<f32>(af, bf, 0.0); }
    var sa = 0.0;
    var sb = 0.0;
    var sm = 0.0;
    var cnt = 0.0;
    for (var dy = 0; dy < 5; dy++) {
        let yy = row_clamped(y, dy - 2);
        for (var dx = 0u; dx < 5u; dx++) {
            let o = yy * W + x + dx - 2u;
            let on = amp_at(k, o);
            if (on > 0.0) {
                let ab = ab_at(k, o);
                sa += ab.x;
                sb += ab.y;
                sm += on;
                cnt += 1.0;
            }
        }
    }
    let thr = P.weak_threshold / P.ab_multiplier;
    let amp = sqrt(af * af + bf * bf);
    let self_ok = amp_at(k, y * W + x) > 0.0;
    let weak = amp < thr;
    let in_phase = sqrt(sa * sa + sb * sb) > 0.8 * sm;
    let take = self_ok && weak && in_phase && cnt >= 12.0;
    let inv = 1.0 / max(cnt, 1.0);
    if (take) { return vec3<f32>(sa * inv, sb * inv, 1.0); }
    return vec3<f32>(af, bf, 0.0);
}

// ---- two echoes in one pixel (tof/echoes.rs) ----------------------------------------------

@compute @workgroup_size(16, 8, 1)
fn stage2(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if (x >= W || y >= H) { return; }
    let i = y * W + x;
    let ext = P.mode != 0u;
    var af: array<f32, 3>;
    var bf: array<f32, 3>;
    var edge = true;
    var boosted = false;
    for (var k = 0u; k < 3u; k++) {
        let r = bilateral(x, y, k, ext);
        var a = r.x;
        var b = r.y;
        edge = edge && r.z > 0.5;
        if (ext && P.weak_boost != 0u) {
            let wbst = weak_boost(x, y, k, a, b);
            a = wbst.x;
            b = wbst.y;
            boosted = boosted || wbst.z > 0.5;
        }
        af[k] = a;
        bf[k] = b;
    }
    let xt = tget(T_XT, i);
    let zt = tget(T_ZT, i);
    let abm = P.ab_multiplier;
    if (!ext) {
        // libfreenect2's closed-form unwrapping
        var ph0 = atan2_(bf[0], af[0]);
        var ph1 = atan2_(bf[1], af[1]);
        var ph2 = atan2_(bf[2], af[2]);
        if (ph0 < 0.0) { ph0 += TAU; }
        if (ph1 < 0.0) { ph1 += TAU; }
        if (ph2 < 0.0) { ph2 += TAU; }
        let ir0 = sqrt(af[0] * af[0] + bf[0] * bf[0]) * abm;
        let ir1 = sqrt(af[1] * af[1] + bf[1] * bf[1]) * abm;
        let ir2 = sqrt(af[2] * af[2] + bf[2] * bf[2]) * abm;
        let ir_sum = ir0 + ir1 + ir2;
        let ir_min = min(min(ir0, ir1), ir2);
        let ir_max = max(max(ir0, ir1), ir2);
        let t0 = ph0 * (3.0 / TAU);
        let t1 = ph1 * (15.0 / TAU);
        let t2 = ph2 * (2.0 / TAU);
        let t5 = floor((t1 - t0) * 0.333333 + 0.5) * 3.0 + t0;
        var t3 = t5 - t2;
        let c1 = t3 >= 0.0;
        var f1 = -2.0;
        var f2 = -0.5;
        if (c1) {
            f1 = 2.0;
            f2 = 0.5;
        }
        t3 *= f2;
        t3 = (t3 - floor(t3)) * f1;
        let at3 = abs(t3);
        let c2 = 0.5 < at3 && at3 < 1.5;
        var t6 = t5;
        var t7 = t1;
        if (c2) {
            t6 += 15.0;
            t7 += 15.0;
        }
        var t8 = (floor((t6 - t2) * 0.5 + 0.5) * 2.0 + t2) * 0.5;
        t6 *= 0.333333;
        t7 *= 0.066667;
        let t9 = t8 + t6 + t7;
        var t10 = 0.0;
        if (t9 >= 0.0) { t10 = t9 * 0.333333; }
        t6 *= TAU;
        t7 *= TAU;
        t8 *= TAU;
        let t8n = t7 * 0.826977 - t8 * 0.110264;
        let t6n = t8 * 0.551318 - t6 * 0.826977;
        let t7n = t6 * 0.110264 - t7 * 0.551318;
        let norm = t8n * t8n + t6n * t6n + t7n * t7n;
        var irx = ir_max;
        if (P.slope > 0.0) { irx = ir_min; }
        irx = ln_(max(irx, 1e-20));
        irx = exp_((irx * P.slope * 0.30103 + P.conf_offset) * 3.321928);
        irx = min(max(irx, P.min_conf), P.max_conf);
        irx = irx * irx;
        let strong = ir_min >= P.individual_threshold && ir_sum >= P.sum_threshold && irx >= norm;
        var pf = 0.0;
        if (strong) { pf = t10; }
        if (pf > 0.0) { pf += P.phase_offset; }
        wset(W_U12, i, pair(mm_of(depth_from_phase(pf, xt, zt)), f16_of(ir_sum, IRSUM_SCALE)));
        wset(W_SMALL, i, u32(edge) << 3u);
        return;
    }
    // extended: maximum-likelihood unwrapping over the whole unambiguous range
    let usable = wget(W_SMALL, i) & 7u;
    var fl = wget(W_FLAGS, i);
    var c: array<f32, 3>;
    var w: array<f32, 3>;
    var ir_sum = 0.0;
    var nvalid = 0.0;
    // the amplitude of each frequency (gain corrected), its noise variance, and whether it
    // takes part in the single-echo test
    var amp: array<f32, 3>;
    var amp_var: array<f32, 3>;
    var amp_use: array<bool, 3>;
    for (var k = 0u; k < 3u; k++) {
        let ak = af[k];
        let bk = bf[k];
        let ir = sqrt(ak * ak + bk * bk) * abm;
        let use_k = (usable & (1u << k)) != 0u && ir >= P.min_amplitude;
        var ck = atan2_(bk, ak) * (1.0 / TAU);
        if (ck < 0.0) { ck += 1.0; }
        let rebuilt = (fl & (FL_REPAIRED_80 << k)) != 0u;
        var nk = noise(k);
        if (rebuilt) { nk = nk * REBUILT_NOISE; }
        let sig = min(nk / max(ir, 1e-6), 3.0);
        let sig_c = sqrt(sig * sig + P.noise_floor * P.noise_floor) * (1.0 / TAU);
        c[k] = ck;
        w[k] = 0.0;
        if (use_k) {
            w[k] = 1.0 / max(sig_c * sig_c, 1e-12);
            ir_sum += ir;
            nvalid += 1.0;
        }
        amp[k] = ir * gain(k);
        amp_var[k] = nk * nk;
        amp_use[k] = use_k && !rebuilt;
    }
    // the single-echo test: one echo reaches every frequency with the same amplitude
    var chi_amp = 0.0;
    var dof_amp = 0.0;
    if (P.multipath != 0u && (fl & FL_SATURATED_ANY) == 0u) {
        var na = 0.0;
        var sum = 0.0;
        for (var k = 0u; k < 3u; k++) {
            if (amp_use[k]) {
                na += 1.0;
                sum += amp[k];
            }
        }
        let afloor = P.amplitude_floor * (sum / max(na, 1.0));
        var wa: array<f32, 3>;
        var sw = 0.0;
        var swa = 0.0;
        for (var k = 0u; k < 3u; k++) {
            wa[k] = 0.0;
            if (amp_use[k]) { wa[k] = 1.0 / max(afloor * afloor + amp_var[k], 1e-12); }
            sw += wa[k];
            swa += wa[k] * amp[k];
        }
        let am = swa / max(sw, 1e-30);
        var chi_a = 0.0;
        for (var k = 0u; k < 3u; k++) {
            let d = amp[k] - am;
            chi_a += wa[k] * d * d;
        }
        dof_amp = max(na - 1.0, 0.0);
        if (dof_amp > 0.0) { chi_amp = chi_a; }
    }
    let illum = tget(T_ILLUM, i);
    let irl = ir_sum / max(nvalid, 1.0) * P.ir_output;
    let use2 = w[2] > 0.0;
    let use0 = w[0] > 0.0;
    var c_ref = c[1];
    var n_ref = 2.0;
    var r_idx = 1u;
    if (use2) {
        c_ref = c[2];
        n_ref = 15.0;
        r_idx = 2u;
    } else if (use0) {
        c_ref = c[0];
        n_ref = 10.0;
        r_idx = 0u;
    }
    let wn2 = w[0] * 100.0 + w[1] * 4.0 + w[2] * 225.0;
    let inv_wn2 = 1.0 / max(wn2, 1e-30);
    var e1 = BIG;
    var u1 = 0.0;
    var e2 = BIG;
    var u2 = 0.0;
    // the phase cost of the best, and whether the candidate that fits the phases best had an
    // implausible brightness
    var ep1 = BIG;
    var emin = BIG;
    var pen_at_min = 0.0;
    var pen1 = 0.0;
    var pen2 = 0.0;
    for (var m = 0; m < 15; m++) {
        let mf = f32(m);
        if (mf >= n_ref) { break; }
        let um = (c_ref + mf) / n_ref;
        let d0 = 10.0 * um - c[0];
        let d1 = 2.0 * um - c[1];
        let d2 = 15.0 * um - c[2];
        let r0 = d0 - round_(d0);
        let r1 = d1 - round_(d1);
        let r2 = d2 - round_(d2);
        let s1 = w[0] * 10.0 * r0 + w[1] * 2.0 * r1 + w[2] * 15.0 * r2;
        let s2 = w[0] * r0 * r0 + w[1] * r1 * r1 + w[2] * r2 * r2;
        let e = max(s2 - s1 * s1 * inv_wn2, 0.0);
        let u = um - s1 * inv_wn2;
        let dm = u * (U_RANGE_MM * 0.001);
        let rho = irl * illum * dm * dm * P.inv_brightness;
        let lr = ln_(max(rho, 1e-30));
        let out = max(max(lr - P.ln_max_reflectivity, P.ln_min_reflectivity - lr), 0.0);
        let pen = out * out * P.penalty_scale;
        let ep = e + mf * TIE_BREAK;
        let et = ep + pen;
        if (et < e1) {
            e2 = e1;
            u2 = u1;
            pen2 = pen1;
            e1 = et;
            u1 = u;
            pen1 = pen;
            ep1 = ep;
        } else if (et < e2) {
            e2 = et;
            u2 = u;
            pen2 = pen;
        }
        if (ep < emin) {
            emin = ep;
            pen_at_min = pen;
        }
    }
    // the phase gap in units of the misfit (kernels.rs, pass C)
    let dof = max(nvalid - 1.0, 0.0);
    let dof_all = dof + dof_amp;
    let scale = max((NOISE_PRIOR_DOF + emin + chi_amp) / (NOISE_PRIOR_DOF + dof_all), 1.0);
    let gap = max((e2 - pen2 - ep1) / scale + pen2 - pen1, 0.0);
    let margin = min(gap - P.margin_prior, 80.0);
    let post = 1.0 / (1.0 + exp_(-0.5 * margin));
    let chi_a = dof_amp + 3.0 * sqrt(2.0 * dof_amp);
    let multipath = chi_amp > chi_a + MULTIPATH_MARGIN;
    let multi = nvalid >= 2.0;
    let single = nvalid == 1.0;
    var ou1 = u1;
    var ou2 = u2;
    if (single) {
        ou1 = c_ref / n_ref;
        ou2 = (c_ref + 1.0) / n_ref;
    }
    var conf = 0.0;
    // how far the amplitudes miss one echo, beyond the tolerance (none for an implausible best;
    // kernels.rs, pass C)
    var tolerance = P.multipath_tolerance;
    if (pen1 > IMPLAUSIBLE) { tolerance = 0.0; }
    let echoes = exp_(-0.5 * max(chi_amp - chi_a - tolerance, 0.0));
    if (multi) { conf = post * echoes; }
    var anchor = 0.0;
    if (multi && conf >= ANCHOR_CONFIDENCE) { anchor = conf; }
    var kind = KIND_NONE;
    if (multi) {
        kind = KIND_MULTI;
        if (pen2 > IMPLAUSIBLE) { kind |= KIND_SECOND_IMPLAUSIBLE; }
    } else if (single) { kind = KIND_SINGLE | (r_idx << 4u); }
    // one echo does not explain the pixel: the split pass tries two (kernels.rs, split_echoes)
    let expected = dof_all + 3.0 * sqrt(2.0 * dof_all) + MULTIPATH_MARGIN;
    let unexplained = nvalid == 3.0 && (fl & FL_SATURATED_ANY) == 0u && emin + chi_amp > expected + P.multipath_tolerance;
    if (P.two_echoes != 0u && unexplained) {
        fl |= FL_SPLIT_CANDIDATE;
        // the filtered values, for the split passes
        for (var k = 0u; k < 3u; k++) {
            wset(W_Z + 2u * k, i, bitcast<u32>(af[k]));
            wset(W_Z + 2u * k + 1u, i, bitcast<u32>(bf[k]));
        }
    }
    wset(W_U12, i, pair(frac_of(ou1), frac_of(ou2)));
    wset(W_GAPC, i, pair(f16_of(gap, GAP_SCALE), unorm_of(conf)));
    wset(W_CSIR, i, pair(unorm_of(c_ref), f16_of(ir_sum, IRSUM_SCALE)));
    let small = usable | (u32(edge) << 3u) | ((fl & FL_SATURATED_ANY) << 4u) | (kind << 8u);
    wset(W_SMALL, i, pair(small, unorm_of(anchor)));
    if (boosted) { fl |= FL_WEAK_BOOSTED; }
    if (nvalid == 0.0) { fl |= FL_NO_SIGNAL; }
    if (pen_at_min > IMPLAUSIBLE && nvalid >= 2.0) { fl |= FL_PLAUSIBILITY; }
    if (multipath) { fl |= FL_MULTIPATH; }
    wset(W_FLAGS, i, fl);
}

// ---- two echoes (tof/echoes.rs: the same search, the same polynomials) ----------------------
//
// Passes over the pixels stage 2 marked (it keeps their filtered values in the planes W_Z): the
// seeds (every SEED_STEP-th pixel both ways) get the whole grid search, one workgroup per seed
// (split_seeds), and its refinement, one invocation per seed (split_refine); the pixels between
// are listed (split_list) and start from the seeds' solutions around them, one invocation per
// pixel (split_between). The same arithmetic in the same order as one pixel after the other:
// the result does not depend on the passes.

// a pixel in the frame of its measured values (echoes.rs, Frame): per frequency the unit vector
// along the measurement (ex, ey), the square roots of the weights (radial, tangential), the
// weighted measurement; its energy, the brightness prior, stage 2's single echo
struct Frame {
    ex: vec3<f32>,
    ey: vec3<f32>,
    sr: vec3<f32>,
    st: vec3<f32>,
    y: vec3<f32>,
    zz: f32,
    inv_lim: f32,
    ps: f32,
    near: f32,
    ok: u32,
}

// a pair of echoes: distances, cost with the penalty, amplitudes
struct Pair {
    u1: f32,
    u2: f32,
    cost: f32,
    a1: f32,
    a2: f32,
}

struct Split {
    u1: f32,
    u2: f32,
    a1: f32,
    a2: f32,
    gap: f32,
}

// steering vectors: (cos, sin) of 2 pi n_k u per frequency
struct Steer {
    c: vec3<f32>,
    s: vec3<f32>,
}

// (cos, sin) of t cycles: reduced to an eighth of a cycle, then polynomials (round: ties to
// even, as echoes.rs)
fn cos_sin_cycles(t: f32) -> vec2<f32> {
    let r = t - round(t);
    let q = round(r * 4.0);
    let y = (r - 0.25 * q) * TAU;
    let y2 = y * y;
    let s = y * (1.0 + y2 * (-1.0 / 6.0 + y2 * (1.0 / 120.0 + y2 * (-1.0 / 5040.0))));
    let c = 1.0 + y2 * (-0.5 + y2 * (1.0 / 24.0 + y2 * (-1.0 / 720.0 + y2 * (1.0 / 40320.0))));
    switch (bitcast<u32>(i32(q)) & 3u) {
        case 0u: { return vec2<f32>(c, s); }
        case 1u: { return vec2<f32>(-s, c); }
        case 2u: { return vec2<f32>(-c, -s); }
        default: { return vec2<f32>(s, -c); }
    }
}

fn steering(u: f32) -> Steer {
    let a = cos_sin_cycles(nf(0u) * u);
    let b = cos_sin_cycles(nf(1u) * u);
    let d = cos_sin_cycles(nf(2u) * u);
    return Steer(vec3<f32>(a.x, b.x, d.x), vec3<f32>(a.y, b.y, d.y));
}

// s moved by the rotation r (the steering vector of a step): forward (1), back (-1), not (0)
fn rotate(s: Steer, r: Steer, dir: f32) -> Steer {
    if (dir == 0.0) { return s; }
    let rs = dir * r.s;
    return Steer(s.c * r.c - s.s * rs, s.c * rs + s.s * r.c);
}

// the brightness penalty of an echo of amplitude a at u^2: ps (t - 1)^2 beyond t = 1
fn echo_pen(f: Frame, a: f32, u2: f32) -> f32 {
    let over = max(a * u2 * f.inv_lim - 1.0, 0.0);
    return f.ps * over * over;
}

// the whitened radial and tangential parts of a steering vector
fn radial(f: Frame, s: Steer) -> vec3<f32> { return f.sr * (s.c * f.ex + s.s * f.ey); }
fn tangential(f: Frame, s: Steer) -> vec3<f32> { return f.st * (s.s * f.ex - s.c * f.ey); }

// cost with the penalty and amplitudes of two echoes (echoes.rs, Frame::pair); BIG where an
// amplitude would be negative or the pair degenerate
fn pair_at(f: Frame, s1: Steer, s2: Steer, u1: f32, u2: f32) -> Pair {
    let r1 = radial(f, s1);
    let t1 = tangential(f, s1);
    let r2 = radial(f, s2);
    let t2 = tangential(f, s2);
    let n1 = dot(r1, r1) + dot(t1, t1);
    let n2 = dot(r2, r2) + dot(t2, t2);
    let g = dot(r1, r2) + dot(t1, t2);
    let b1 = dot(r1, f.y);
    let b2 = dot(r2, f.y);
    let det = n1 * n2 - g * g;
    let inv = 1.0 / max(det, 1e-30);
    let a1 = (n2 * b1 - g * b2) * inv;
    let a2 = (n1 * b2 - g * b1) * inv;
    var c = BIG;
    if (det > 1e-6 * n1 * n2 && a1 > 0.0 && a2 > 0.0) {
        c = max(f.zz - a1 * b1 - a2 * b2, 0.0) + echo_pen(f, a1, u1 * u1) + echo_pen(f, a2, u2 * u2);
    }
    return Pair(u1, u2, c, a1, a2);
}

// cost with the penalty of one echo (echoes.rs, Frame::single)
fn single_at(f: Frame, s: Steer, u: f32) -> f32 {
    let r = radial(f, s);
    let t = tangential(f, s);
    let n = dot(r, r) + dot(t, t);
    let b = dot(r, f.y);
    if (!(b > 0.0 && n > 0.0)) { return BIG; }
    let a = b / n;
    return max(f.zz - b * a, 0.0) + echo_pen(f, a, u * u);
}

// the moves of the pattern search: both axes, both diagonals (echoes.rs, MOVES)
fn move_of(m: u32) -> vec2<f32> {
    switch (m) {
        case 0u: { return vec2<f32>(1.0, 0.0); }
        case 1u: { return vec2<f32>(-1.0, 0.0); }
        case 2u: { return vec2<f32>(0.0, 1.0); }
        case 3u: { return vec2<f32>(0.0, -1.0); }
        case 4u: { return vec2<f32>(1.0, 1.0); }
        case 5u: { return vec2<f32>(-1.0, -1.0); }
        case 6u: { return vec2<f32>(1.0, -1.0); }
        default: { return vec2<f32>(-1.0, 1.0); }
    }
}

// the pattern search from p with the step h, halved `levels` times (echoes.rs, refine_pair)
fn refine_pair(f: Frame, start: Pair, h0: f32, levels: u32, repeats: u32) -> Pair {
    var p = start;
    var s1 = steering(p.u1);
    var s2 = steering(p.u2);
    var h = h0;
    for (var l = 0u; l < levels; l++) {
        let rot = steering(h);
        for (var rep = 0u; rep < repeats; rep++) {
            var moved = false;
            for (var m = 0u; m < 8u; m++) {
                let mv = move_of(m);
                let v1 = p.u1 + mv.x * h;
                let v2 = p.u2 + mv.y * h;
                if (v1 <= 0.0 || v2 - v1 < MIN_SEP_U - 1e-6 || v2 >= 1.0) { continue; }
                let t1 = rotate(s1, rot, mv.x);
                let t2 = rotate(s2, rot, mv.y);
                let c = pair_at(f, t1, t2, v1, v2);
                if (c.cost < p.cost) {
                    p = c;
                    s1 = t1;
                    s2 = t2;
                    moved = true;
                }
            }
            if (!moved) { break; }
        }
        h *= 0.5;
    }
    return p;
}

// the same for one echo: its cost
fn refine_single(f: Frame, u0: f32, h0: f32, levels: u32) -> f32 {
    var u = u0;
    var s = steering(u);
    var cost = single_at(f, s, u);
    var h = h0;
    for (var l = 0u; l < levels; l++) {
        let rot = steering(h);
        for (var m = 0u; m < 2u; m++) {
            let dir = select(-1.0, 1.0, m == 0u);
            let t = rotate(s, rot, dir);
            let v = u + dir * h;
            let c = single_at(f, t, v);
            if (c < cost) {
                u = v;
                s = t;
                cost = c;
            }
        }
        h *= 0.5;
    }
    return cost;
}

// the split with its evidence (echoes.rs, finish): the margin over one echo and over pairs whose
// first echo lies elsewhere, in units of the misfit
fn finish_split(f: Frame, p: Pair, single: f32, alt_margin: f32) -> Split {
    let penalty = echo_pen(f, p.a1, p.u1 * p.u1) + echo_pen(f, p.a2, p.u2 * p.u2);
    let resid = max(p.cost - penalty, 0.0);
    let scale = max((NOISE_PRIOR_DOF + resid) / (NOISE_PRIOR_DOF + DOF_TWO), 1.0);
    let margin = min(single - p.cost, alt_margin);
    return Split(p.u1, p.u2, p.a1, p.a2, max(margin / scale, 0.0));
}

// the inputs of the split of a pixel: the filtered values stage 2 kept, their noise, the
// brightness prior (kernels.rs, collect_candidates)
fn split_frame(i: u32, fl: u32) -> Frame {
    var f = Frame(vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0), 0.0, 0.0, 0.0, 0.0, 0u);
    var z: array<vec2<f32>, 3>;
    var m: array<f32, 3>;
    let abm = P.ab_multiplier;
    for (var k = 0u; k < 3u; k++) {
        let a = bitcast<f32>(wget(W_Z + 2u * k, i));
        let b = bitcast<f32>(wget(W_Z + 2u * k + 1u, i));
        z[k] = vec2<f32>(a, b) * (abm * gain(k));
        m[k] = sqrt(z[k].x * z[k].x + z[k].y * z[k].y);
    }
    let mean = (m[0] + m[1] + m[2]) / 3.0;
    for (var k = 0u; k < 3u; k++) {
        var s = noise(k) * gain(k);
        if ((fl & (FL_REPAIRED_80 << k)) != 0u) { s = s * REBUILT_NOISE; }
        let a = P.echo_amplitude_floor * mean;
        let t = P.noise_floor * m[k];
        let wr = 1.0 / max(s * s + a * a, 1e-12);
        let wt = 1.0 / max(s * s + t * t, 1e-12);
        if (!(m[k] > 0.0)) { return f; }
        f.ex[k] = z[k].x / m[k];
        f.ey[k] = z[k].y / m[k];
        f.sr[k] = sqrt(wr);
        f.st[k] = sqrt(wt);
        f.y[k] = f.sr[k] * m[k];
    }
    f.zz = dot(f.y, f.y);
    if (P.penalty_scale > 0.0) {
        let lim = P.echo_rho_max / max(P.ir_output * tget(T_ILLUM, i) * P.inv_brightness * (U_RANGE_MM * 0.001) * (U_RANGE_MM * 0.001), 1e-30);
        if (lim > 0.0 && lim < BIG) { f.inv_lim = 1.0 / lim; }
    }
    f.ps = P.penalty_scale * P.echo_plausibility;
    f.near = frac_val(wget(W_U12, i));
    f.ok = 1u;
    return f;
}

// a split replaces the single echo's distance where the second echo is strong and the first
// lies elsewhere than the mixture (kernels.rs, split_replaces; cpu.rs, write_split)
fn apply_split(i: u32, sp: Split, near: f32, fl: u32) -> u32 {
    if (sp.a2 < STRONG_SECOND * sp.a1 || abs(sp.u1 - near) <= SPLIT_MOVES + SPLIT_MOVES_REL * near) { return fl; }
    let post2 = 1.0 / (1.0 + exp_(-0.5 * min(sp.gap - P.margin_prior, 80.0)));
    wset(W_U12, i, pair(frac_of(sp.u1), frac_of(sp.u2)));
    wset(W_GAPC, i, pair(f16_of(sp.gap, GAP_SCALE), unorm_of(post2)));
    // usable, edge and saturation bits stay; the kind changes, no anchor
    let small = wget(W_SMALL, i);
    wset(W_SMALL, i, pair((small & 0xffu) | ((KIND_MULTI | KIND_FIRST_ECHO) << 8u), 0u));
    return fl | FL_SECOND_ECHO;
}

// cost (non-negative, as f32 bits with the 8 low bits cleared) and grid point in one word: the
// smallest word is the smallest cost, among equal ones the first grid point
fn grid_key(c: f32, j: u32) -> u32 { return (bitcast<u32>(c) & ~0xffu) | j; }
fn key_cost(k: u32) -> f32 { return bitcast<f32>(k & ~0xffu); }
const NO_KEY: u32 = 0xffffffffu;
const SEED_THREADS: u32 = 64u;
// a seed's grid search found a pair (seed plane 1: this in the high byte, then the grid points
// of the single echo (NO_SINGLE: none), the second and the first echo; plane 2: the margin)
const SEED_FOUND: u32 = 0xff000000u;
const NO_SINGLE: u32 = 0xffu;

// (Workgroup memory is not zero-initialized: every variable is written before it is read.)
var<workgroup> wg_frame: Frame;
var<workgroup> wg_go: u32;
// the whitened steering vectors of the grid, the matched filter and the norm (b, n)
var<workgroup> wg_r: array<vec3<f32>, COARSE>;
var<workgroup> wg_t: array<vec3<f32>, COARSE>;
var<workgroup> wg_bn: array<vec2<f32>, COARSE>;
// the best pair per first echo, the best single echo (grid keys)
var<workgroup> wg_first: array<atomic<u32>, COARSE>;
var<workgroup> wg_single: atomic<u32>;
// the best pair (its cost and first echo as a grid key), the best cost of a pair whose first
// echo lies elsewhere
var<workgroup> wg_best: atomic<u32>;
var<workgroup> wg_alt: atomic<u32>;

// the grid key of the pair of the first echo (i1: whitened steering vector ri, ti, matched filter
// b1, norm n1, distance ui) with the second at grid point j (rj, tj, (b, n) bn); NO_KEY where j
// is outside lo..=hi or the pair does not fit
fn seed_pair(f: Frame, ri: vec3<f32>, ti: vec3<f32>, b1: f32, n1: f32, ui: f32, lo: u32, hi: u32, j: u32, rj: vec3<f32>, tj: vec3<f32>, bn: vec2<f32>) -> u32 {
    if (j < lo || j > hi) { return NO_KEY; }
    let g = dot(ri, rj) + dot(ti, tj);
    let b2 = bn.x;
    let n2 = bn.y;
    let det = n1 * n2 - g * g;
    let inv = 1.0 / max(det, 1e-30);
    let a1 = (n2 * b1 - g * b2) * inv;
    let a2 = (n1 * b2 - g * b1) * inv;
    if (!(a1 >= FIRST_MIN * a2 && a2 > 0.0 && det > 1e-6 * n1 * n2)) { return NO_KEY; }
    let uj = f32(j) / f32(COARSE);
    let c = max(f.zz - a1 * b1 - a2 * b2, 0.0) + echo_pen(f, a1, ui * ui) + echo_pen(f, a2, uj * uj);
    return grid_key(c, j);
}

// the seeds' grid search: one workgroup per lattice point (echoes.rs, split_seeds, search); the
// refinement follows in split_refine
@compute @workgroup_size(64, 1, 1)
fn split_seeds(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
    let x = wid.x * SEED_STEP;
    let y = wid.y * SEED_STEP;
    if (x >= W || y >= H) { return; }
    let i = y * W + x;
    if (lid == 0u) {
        // no solution yet (the pixels between read the seed planes)
        wset(W_SEED1, i, bitcast<u32>(-1.0));
        var go = 0u;
        let fl = wget(W_FLAGS, i);
        if ((fl & FL_SPLIT_CANDIDATE) != 0u) {
            let f = split_frame(i, fl);
            wg_frame = f;
            go = f.ok;
        }
        wset(W_FLAGS, i, fl & ~FL_SPLIT_CANDIDATE);
        wg_go = go;
        atomicStore(&wg_single, NO_KEY);
        atomicStore(&wg_best, NO_KEY);
        atomicStore(&wg_alt, NO_KEY);
    }
    for (var j = lid; j < COARSE; j += SEED_THREADS) { atomicStore(&wg_first[j], NO_KEY); }
    if (workgroupUniformLoad(&wg_go) == 0u) { return; }
    let f = wg_frame;
    // the grid: the steering vectors whitened, the best single echo
    for (var j = lid; j < COARSE; j += SEED_THREADS) {
        let u = f32(j) / f32(COARSE);
        let s = steering(u);
        let r = radial(f, s);
        let t = tangential(f, s);
        let b = dot(r, f.y);
        let n = dot(r, r) + dot(t, t);
        wg_r[j] = r;
        wg_t[j] = t;
        wg_bn[j] = vec2<f32>(b, n);
        if (b > 0.0 && n > 0.0) { atomicMin(&wg_single, grid_key(max(f.zz - b * b / n + echo_pen(f, b / n, u * u), 0.0), j)); }
    }
    workgroupBarrier();
    // every pair whose first echo lies before the single echo's distance (not at 0): the best
    // per first echo; each invocation keeps its three second echoes (j0, j1, j2) in registers
    let near_i = u32(floor(max(f.near, 0.0) * f32(COARSE) + 0.5));
    let last = min(near_i + FIRST_BEYOND + 1u, COARSE - MIN_SEPARATION);
    let j0 = lid;
    let j1 = lid + SEED_THREADS;
    let j2 = lid + 2u * SEED_THREADS;
    let k2 = min(j2, COARSE - 1u);
    let r0 = wg_r[j0];
    let t0 = wg_t[j0];
    let bn0 = wg_bn[j0];
    let r1 = wg_r[j1];
    let t1 = wg_t[j1];
    let bn1 = wg_bn[j1];
    let r2 = wg_r[k2];
    let t2 = wg_t[k2];
    let bn2 = wg_bn[k2];
    for (var i1 = 1u; i1 < last; i1++) {
        let ri = wg_r[i1];
        let ti = wg_t[i1];
        let b1 = wg_bn[i1].x;
        let n1 = wg_bn[i1].y;
        let ui = f32(i1) / f32(COARSE);
        let lo = i1 + MIN_SEPARATION;
        let hi = i1 + min(COARSE - 1u - i1, COARSE - MIN_SEPARATION);
        var best = seed_pair(f, ri, ti, b1, n1, ui, lo, hi, j0, r0, t0, bn0);
        best = min(best, seed_pair(f, ri, ti, b1, n1, ui, lo, hi, j1, r1, t1, bn1));
        best = min(best, seed_pair(f, ri, ti, b1, n1, ui, lo, hi, j2, r2, t2, bn2));
        if (best != NO_KEY) { atomicMin(&wg_first[i1], best); }
    }
    workgroupBarrier();
    // the best pair: the smallest cost, among equal ones the first first echo
    for (var i1 = lid; i1 < last; i1 += SEED_THREADS) {
        let k = atomicLoad(&wg_first[i1]);
        if (i1 > 0u && k != NO_KEY && key_cost(k) < BIG) { atomicMin(&wg_best, (k & ~0xffu) | i1); }
    }
    let best = workgroupUniformLoad(&wg_best);
    if (best == NO_KEY) { return; }
    // the best pair whose first echo lies elsewhere
    let bi = best & 0xffu;
    for (var i1 = lid; i1 < last; i1 += SEED_THREADS) {
        let k = atomicLoad(&wg_first[i1]);
        let far = select(bi - i1, i1 - bi, i1 > bi);
        if (i1 > 0u && k != NO_KEY && far > SAME_FIRST) { atomicMin(&wg_alt, k & ~0xffu); }
    }
    workgroupBarrier();
    if (lid == 0u) {
        let bj = atomicLoad(&wg_first[bi]) & 0xffu;
        let ka = atomicLoad(&wg_alt);
        var alt = BIG;
        if (ka != NO_KEY) { alt = min(alt, key_cost(ka)); }
        let ks = atomicLoad(&wg_single);
        var js = NO_SINGLE;
        if (ks != NO_KEY) { js = ks & 0xffu; }
        wset(W_SEED1, i, SEED_FOUND | (js << 16u) | (bj << 8u) | bi);
        wset(W_SEED2, i, bitcast<u32>(alt - key_cost(best)));
    }
}

// the refinements of the seeds the grid search left a pair: one invocation per lattice point
// (echoes.rs, split_seeds)
@compute @workgroup_size(16, 8, 1)
fn split_refine(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x * SEED_STEP;
    let y = gid.y * SEED_STEP;
    if (x >= W || y >= H) { return; }
    let i = y * W + x;
    let found = wget(W_SEED1, i);
    if ((found & SEED_FOUND) != SEED_FOUND) { return; }
    let alt = bitcast<f32>(wget(W_SEED2, i));
    wset(W_SEED1, i, bitcast<u32>(-1.0));
    let fl = wget(W_FLAGS, i);
    let f = split_frame(i, fl);
    let step = 1.0 / f32(COARSE);
    let u1 = f32(found & 0xffu) * step;
    let u2 = f32((found >> 8u) & 0xffu) * step;
    let p = refine_pair(f, pair_at(f, steering(u1), steering(u2), u1, u2), 0.5 * step, LEVELS, REPEATS);
    let js = (found >> 16u) & 0xffu;
    var sc = BIG;
    if (js != NO_SINGLE) { sc = refine_single(f, f32(js) * step, 0.5 * step, LEVELS); }
    if (p.cost < BIG) {
        wset(W_SEED1, i, bitcast<u32>(p.u1));
        wset(W_SEED2, i, bitcast<u32>(p.u2));
        wset(W_FLAGS, i, apply_split(i, finish_split(f, p, sc, alt), f.near, fl));
    }
}

// the seeds around a pixel: the corners of its cell, then the ring around the cell (in steps)
fn seed_offset(k: u32) -> vec2<i32> {
    switch (k) {
        case 0u: { return vec2<i32>(0, 0); }
        case 1u: { return vec2<i32>(1, 0); }
        case 2u: { return vec2<i32>(0, 1); }
        case 3u: { return vec2<i32>(1, 1); }
        case 4u: { return vec2<i32>(-1, -1); }
        case 5u: { return vec2<i32>(0, -1); }
        case 6u: { return vec2<i32>(1, -1); }
        case 7u: { return vec2<i32>(2, -1); }
        case 8u: { return vec2<i32>(-1, 0); }
        case 9u: { return vec2<i32>(2, 0); }
        case 10u: { return vec2<i32>(-1, 1); }
        case 11u: { return vec2<i32>(2, 1); }
        case 12u: { return vec2<i32>(-1, 2); }
        case 13u: { return vec2<i32>(0, 2); }
        case 14u: { return vec2<i32>(1, 2); }
        default: { return vec2<i32>(2, 2); }
    }
}

// the pixels between the seeds to split, per band of LIST_ROWS rows: their indices (plane W_LIST,
// from the band's first pixel on, in no particular order) and their number (word LIST_COUNT +
// band); split_between then keeps its invocations busy
const LIST_PIXELS: u32 = LIST_ROWS * W;
const LIST_THREADS: u32 = 256u;
const BETWEEN_THREADS: u32 = 64u;
var<workgroup> wg_count: atomic<u32>;

@compute @workgroup_size(256, 1, 1)
fn split_list(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
    let first = wid.x * LIST_PIXELS;
    if (lid == 0u) { atomicStore(&wg_count, 0u); }
    workgroupBarrier();
    for (var o = lid; o < LIST_PIXELS; o += LIST_THREADS) {
        let i = first + o;
        if (i < N && (wget(W_FLAGS, i) & FL_SPLIT_CANDIDATE) != 0u) {
            wset(W_LIST, first + atomicAdd(&wg_count, 1u), i);
        }
    }
    workgroupBarrier();
    if (lid == 0u) { work[LIST_COUNT + wid.x] = atomicLoad(&wg_count); }
}

// the pixels between the seeds: from the best of the seeds' solutions around, a short pattern
// search (echoes.rs, split_between); one invocation per listed pixel
@compute @workgroup_size(64, 1, 1)
fn split_between(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
    let at = wid.x * BETWEEN_THREADS + lid;
    if (at >= work[LIST_COUNT + wid.y]) { return; }
    let i = wget(W_LIST, wid.y * LIST_PIXELS + at);
    let x = i % W;
    let y = i / W;
    var fl = wget(W_FLAGS, i);
    if ((fl & FL_SPLIT_CANDIDATE) == 0u) { return; }
    fl = fl & ~FL_SPLIT_CANDIDATE;
    let f = split_frame(i, fl);
    if (f.ok != 0u) {
        let cx = i32(x - x % SEED_STEP);
        let cy = i32(y - y % SEED_STEP);
        var best = Pair(0.0, 0.0, BIG, 0.0, 0.0);
        var k = 0u;
        for (var o = 0u; o < 16u; o++) {
            // the ring only where the cell has no seed with a solution
            if (k == 4u || (o == 4u && k > 0u)) { break; }
            let d = seed_offset(o);
            let sx = cx + d.x * i32(SEED_STEP);
            let sy = cy + d.y * i32(SEED_STEP);
            if (sx < 0 || sy < 0 || sx >= i32(W) || sy >= i32(H)) { continue; }
            let si = u32(sy) * W + u32(sx);
            let su1 = bitcast<f32>(wget(W_SEED1, si));
            if (!(su1 >= 0.0)) { continue; }
            let su2 = bitcast<f32>(wget(W_SEED2, si));
            k++;
            let c = pair_at(f, steering(su1), steering(su2), su1, su2);
            if (c.cost < best.cost) { best = c; }
        }
        if (best.cost < BIG) {
            let p = refine_pair(f, best, 0.25 / f32(COARSE), BETWEEN_LEVELS, 1u);
            if (p.cost < BIG) {
                fl = apply_split(i, finish_split(f, p, single_at(f, steering(f.near), f.near), BIG), f.near, fl);
            }
        }
    }
    wset(W_FLAGS, i, fl);
}

// ---- stage 3: edge filter -----------------------------------------------------------------

// the depth and the amplitude sum at pixel o: compat after stage 2, extended after the resolver
fn depth_at(o: u32, ext: bool) -> f32 {
    if (ext) { return mm_val(wget(W_RES, o)); }
    return mm_val(wget(W_U12, o));
}
fn irsum_at(o: u32, ext: bool) -> f32 {
    if (ext) { return f16_val(wget(W_CSIR, o) >> 16u, IRSUM_INV); }
    return f16_val(wget(W_U12, o) >> 16u, IRSUM_INV);
}

// libfreenect2's flying-pixel test at (x, y)
fn is_flying(x: u32, y: u32, ext: bool) -> bool {
    let d = depth_at(y * W + x, ext);
    let s = irsum_at(y * W + x, ext);
    var acc = s;
    var sq = s * s;
    var mn = d;
    var mx = d;
    for (var j = 0u; j < 8u; j++) {
        // order: (-1,-1) (0,-1) (1,-1) (-1,0) (1,0) (-1,1) (0,1) (1,1)
        var dx = 0u;
        var dy = 0u;
        switch (j) {
            case 0u: { dx = 0u; dy = 0u; }
            case 1u: { dx = 1u; dy = 0u; }
            case 2u: { dx = 2u; dy = 0u; }
            case 3u: { dx = 0u; dy = 1u; }
            case 4u: { dx = 2u; dy = 1u; }
            case 5u: { dx = 0u; dy = 2u; }
            case 6u: { dx = 1u; dy = 2u; }
            default: { dx = 2u; dy = 2u; }
        }
        let o = (y + dy - 1u) * W + x + dx - 1u;
        let sn = irsum_at(o, ext);
        acc += sn;
        sq += sn * sn;
        let on = depth_at(o, ext);
        if (on > 0.0) {
            mn = min(mn, on);
            mx = max(mx, on);
        }
    }
    var tmp0 = sqrt(max(sq * 9.0 - acc * acc, 0.0)) / 9.0;
    tmp0 = tmp0 / max(acc / 9.0, P.avg_min);
    let amin = abs(d - mn);
    let amax = abs(d - mx);
    let avg = (amin + amax) * 0.5;
    let maxd = max(amin, amax);
    var scale = 1.0;
    if (P.scale_mm > 0.0) { scale = max(d / P.scale_mm, 1.0); }
    return d > 0.0 && tmp0 >= P.std_threshold && P.close * scale < amin && P.far * scale < amax && P.max_delta * scale < maxd && P.avg_delta * scale < avg;
}

@compute @workgroup_size(16, 8, 1)
fn stage3_compat(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if (x >= W || y >= H) { return; }
    let i = y * W + x;
    let v = depth_at(i, false);
    var out = v;
    if (P.edge_enabled != 0u) {
        let in_range = v >= P.min_depth && v <= P.max_depth;
        if (y < 1u || y > H - 2u || x < 1u || x > W - 2u) {
            out = select(0.0, v, in_range);
        } else {
            let flying = is_flying(x, y, false);
            out = select(0.0, v, in_range && !flying && edge_ok_at(i));
        }
    }
    wset(W_OUT, i, pair(mm_of(out), unorm_of(select(0.0, 1.0, out > 0.0))));
}

// ---- stage 3a (extended): the neighbors decide -----------------------------------------------

fn bandwidth(u: f32) -> f32 {
    let mm = max(u * U_RANGE_MM * 0.04, 80.0);
    return mm / U_RANGE_MM;
}

@compute @workgroup_size(16, 8, 1)
fn resolve(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if (x >= W || y >= H) { return; }
    let i = y * W + x;
    let xt = tget(T_XT, i);
    let zt = tget(T_ZT, i);
    let u12 = wget(W_U12, i);
    let u1 = frac_val(u12);
    let small = wget(W_SMALL, i);
    let k = (small >> 8u) & 255u;
    let base = k & 15u;
    let gapc = wget(W_GAPC, i);
    let c_in = unorm_val(gapc >> 16u);
    var fl = wget(W_FLAGS, i);
    var d_out = 0.0;
    if (P.spatial == 0u) {
        // no neighbors: multi-frequency results as they are, single ones dropped
        var cv = 0.0;
        if (base == KIND_MULTI) { cv = c_in; }
        if (cv > 0.0) { d_out = depth_of_u(u1, xt, zt); }
        wset(W_RES, i, pair(mm_of(d_out), unorm_of(cv)));
        return;
    }
    let r = P.radius;
    let y0 = u32(max(i32(y) - i32(r), 0));
    let y1 = min(y + r, H - 1u);
    let x0 = u32(max(i32(x) - i32(r), 0));
    let x1 = min(x + r, W - 1u);
    if (base == KIND_MULTI) {
        let u2 = frac_val(u12 >> 16u);
        let c = c_in;
        let gap = f16_val(gapc, GAP_INV);
        // the first of two echoes: confirmed where the neighbors' first echoes or sure distances
        // agree (resolve.rs, first_echo_support)
        if ((k & KIND_FIRST_ECHO) != 0u) {
            var conf = c;
            if (c < SURE_CONFIDENCE && !(gap >= 20.0 && c >= CONFIRMED_CONFIDENCE)) {
                let h1 = bandwidth(u1);
                let inv1 = 1.0 / max(h1 * h1, 1e-12);
                var s = 0.0;
                var total = 0.0;
                for (var yy = y0; yy <= y1; yy++) {
                    for (var xx = x0; xx <= x1; xx++) {
                        let o = yy * W + xx;
                        if (o == i) { continue; }
                        let so = wget(W_SMALL, o);
                        let ko = (so >> 8u) & 255u;
                        var wj = unorm_val(so >> 16u);
                        if ((ko & 15u) == KIND_MULTI && (ko & KIND_FIRST_ECHO) != 0u) { wj = FIRST_ECHO_WEIGHT; }
                        if (wj <= 0.0) { continue; }
                        let dd = frac_val(wget(W_U12, o)) - u1;
                        total += wj;
                        s += wj * max(1.0 - dd * dd * inv1, 0.0);
                    }
                }
                if (total > 1.0 && s > 0.5 * total) {
                    conf = max(c, min(0.55 + 0.4 * s / total, 0.95));
                    fl |= FL_RESOLVED;
                }
            }
            wset(W_RES, i, pair(mm_of(depth_of_u(u1, xt, zt)), unorm_of(conf)));
            wset(W_FLAGS, i, fl);
            return;
        }
        // sure; or mixing several echoes (wrong, not ambiguous: the neighbors neither confirm
        // nor replace its distance)
        if (c >= SURE_CONFIDENCE || (gap >= 20.0 && c >= CONFIRMED_CONFIDENCE) || (fl & FL_MULTIPATH) != 0u) {
            wset(W_RES, i, pair(mm_of(depth_of_u(u1, xt, zt)), unorm_of(c)));
            return;
        }
        let h = bandwidth(u1);
        let inv_h2 = 1.0 / max(h * h, 1e-12);
        var s1 = 0.0;
        var s2 = 0.0;
        var total = 0.0;
        for (var yy = y0; yy <= y1; yy++) {
            for (var xx = x0; xx <= x1; xx++) {
                let o = yy * W + xx;
                let uj = frac_val(wget(W_U12, o));
                let aj = anchor_at(o);
                let dd1 = uj - u1;
                let dd2 = uj - u2;
                total += aj;
                s1 += aj * max(1.0 - dd1 * dd1 * inv_h2, 0.0);
                s2 += aj * max(1.0 - dd2 * dd2 * inv_h2, 0.0);
            }
        }
        // the pixel itself does not vote
        let own = unorm_val(small >> 16u);
        let d = (u2 - u1) / h;
        s1 -= own;
        s2 -= own * max(1.0 - d * d, 0.0);
        total -= own;
        var u = u1;
        var conf = c;
        if (total > 1.0 && s2 > 2.0 * s1 && gap < 20.0 && (k & KIND_SECOND_IMPLAUSIBLE) == 0u) {
            u = u2;
            conf = min(0.55 + 0.4 * s2 / total, 0.95);
            fl |= FL_RESOLVED;
        } else if (total > 1.0 && s1 > 2.0 * s2 && s1 > 0.5 * total) {
            conf = max(c, min(0.55 + 0.4 * s1 / total, 0.95));
            fl |= FL_RESOLVED;
        }
        wset(W_RES, i, pair(mm_of(depth_of_u(u, xt, zt)), unorm_of(conf)));
        wset(W_FLAGS, i, fl);
        return;
    }
    if (base == KIND_SINGLE) {
        let fi = (k >> 4u) & 3u;
        let n = nf(fi);
        let cref = unorm_val(wget(W_CSIR, i));
        fl |= FL_SINGLE_FREQUENCY;
        let saturated = (fl & FL_SATURATED_ANY) != 0u;
        var votes: array<f32, 16>;
        for (var m = 0u; m < 16u; m++) { votes[m] = 0.0; }
        var total = 0.0;
        for (var yy = y0; yy <= y1; yy++) {
            for (var xx = x0; xx <= x1; xx++) {
                let o = yy * W + xx;
                let so = wget(W_SMALL, o);
                let aj = unorm_val(so >> 16u);
                if (aj <= 0.0) { continue; }
                let uj = frac_val(wget(W_U12, o));
                var wj = aj;
                if (saturated && ((so >> 4u) & 7u) != 0u) { wj = 10.0 * aj; }
                let m = floor(n * uj - cref + 0.5);
                if (m >= 0.0 && m < 16.0) {
                    votes[u32(m)] += wj;
                    total += wj;
                }
            }
        }
        var best_m = 0u;
        var best_v = 0.0;
        for (var m = 0u; m < 16u; m++) {
            if (votes[m] > best_v) {
                best_m = m;
                best_v = votes[m];
            }
        }
        var u = u1;
        var conf = 0.0;
        let e = bitcast<f32>(work[EXP_WORD + i]);
        if (total >= 1.5 && best_v > 0.6 * total) {
            fl |= FL_RESOLVED;
            u = (cref + f32(best_m)) / n;
            conf = 0.5 + 0.4 * best_v / total;
        } else if (e > 0.0) {
            fl |= FL_RESOLVED;
            let m = max(floor(n * e - cref + 0.5), 0.0);
            u = (cref + m) / n;
            conf = 0.4;
            if (saturated) { conf = 0.6; }
        } else if (saturated && P.near_prior_mm > 0.0 && u1 <= u_of_depth(P.near_prior_mm, zt)) {
            fl |= FL_NEAR_PRIOR;
            conf = 0.55;
        }
        if (conf > 0.0) { d_out = depth_of_u(u, xt, zt); }
        wset(W_RES, i, pair(mm_of(d_out), unorm_of(conf)));
        wset(W_FLAGS, i, fl);
        return;
    }
    wset(W_RES, i, 0u);
}

// ---- stage 3b (extended): edge and speckle filter, range, confidence ---------------------------

@compute @workgroup_size(16, 8, 1)
fn finish(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if (x >= W || y >= H) { return; }
    let i = y * W + x;
    let res = wget(W_RES, i);
    let v = mm_val(res);
    var fly = false;
    if (P.edge_enabled != 0u && y >= 1u && y <= H - 2u && x >= 1u && x <= W - 2u) {
        fly = v > 0.0 && (is_flying(x, y, true) || !edge_ok_at(i));
    }
    var agree = 24.0;
    if (P.speckle != 0u && y >= 2u && y <= H - 3u && x >= 2u && x <= W - 3u) {
        agree = 0.0;
        let tol = max(0.03 * v, 50.0);
        for (var dy = 0u; dy < 5u; dy++) {
            for (var dx = 0u; dx < 5u; dx++) {
                if (dy == 2u && dx == 2u) { continue; }
                let o = mm_val(wget(W_RES, (y + dy - 2u) * W + x + dx - 2u));
                if (o > 0.0 && abs(o - v) < tol) { agree += 1.0; }
            }
        }
    }
    let in_range = v >= P.min_depth && v <= P.max_depth;
    let c = unorm_val(res >> 16u);
    let confident = c >= P.out_min_conf;
    let speckle = P.speckle != 0u && agree < P.speckle_min;
    let keep = v > 0.0 && in_range && !fly && confident && !speckle;
    wset(W_OUT, i, pair(mm_of(select(0.0, v, keep)), unorm_of(select(0.0, c, keep))));
    let has = v > 0.0;
    var fl = wget(W_FLAGS, i);
    if (has && !in_range) { fl |= FL_OUT_OF_RANGE; }
    if (has && in_range && fly) { fl |= FL_EDGE; }
    if (has && in_range && !fly && !confident) { fl |= FL_LOW_CONFIDENCE; }
    if (has && in_range && !fly && confident && speckle) { fl |= FL_SPECKLE; }
    wset(W_FLAGS, i, fl);
}

// ---- push-pull (tof/fill.rs): the expectation of u for the resolver ------------------------------

// level 0 from the resolver's inputs: u1 weighted by the anchors (weights 0..1, premultiplied)
@compute @workgroup_size(16, 8, 1)
fn pp_init(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if (x >= L.w || y >= L.h) { return; }
    let i = y * L.w + x;
    let v = frac_val(wget(W_U12, i));
    let w = clamp(anchor_at(i), 0.0, 1.0);
    work[L.vwt + i] = f16x2_of(vec2<f32>(v * w, w));
}

// one level down: sums of 2 x 2, the weight saturating at 1
@compute @workgroup_size(16, 8, 1)
fn pp_down(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if (x >= L.w || y >= L.h) { return; }
    var v = 0.0;
    var t = 0.0;
    for (var dy = 0u; dy < 2u; dy++) {
        let sy = 2u * y + dy;
        if (sy >= L.ph) { continue; }
        for (var dx = 0u; dx < 2u; dx++) {
            let sx = 2u * x + dx;
            if (sx >= L.pw) { continue; }
            let p = f16x2_val(work[L.pvwt + sy * L.pw + sx]);
            v += p.x;
            t += p.y;
        }
    }
    if (t > 0.0) {
        let c = min(t, 1.0);
        v = v / t * c;
        t = c;
    }
    work[L.vwt + y * L.w + x] = f16x2_of(vec2<f32>(v, t));
}

// the coarsest level
@compute @workgroup_size(16, 8, 1)
fn pp_top(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if (x >= L.w || y >= L.h) { return; }
    let i = y * L.w + x;
    let p = f16x2_val(work[L.vwt + i]);
    var f = 0.0;
    if (p.y > 0.0) { f = p.x / p.y; }
    work[L.filled + i] = bitcast<u32>(f);
}

// the upsampling taps of fill.rs: (first, second, weight of the second)
fn taps(x: u32, parent: u32) -> vec3<f32> {
    let last = parent - 1u;
    if ((x & 1u) == 0u) {
        let b = min(x / 2u, last);
        var a = 0u;
        if (b > 0u) { a = b - 1u; }
        return vec3<f32>(f32(a), f32(b), 0.75);
    }
    let a = min(x / 2u, last);
    let b = min(a + 1u, last);
    return vec3<f32>(f32(a), f32(b), 0.25);
}

// one level up: what is missing comes from the (filled) parent
@compute @workgroup_size(16, 8, 1)
fn pp_up(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if (x >= L.w || y >= L.h) { return; }
    let tx = taps(x, L.pw);
    let ty = taps(y, L.ph);
    let xa = u32(tx.x);
    let xb = u32(tx.y);
    let ya = u32(ty.x);
    let yb = u32(ty.y);
    let a0 = bitcast<f32>(work[L.pfilled + ya * L.pw + xa]);
    let a1 = bitcast<f32>(work[L.pfilled + ya * L.pw + xb]);
    let b0 = bitcast<f32>(work[L.pfilled + yb * L.pw + xa]);
    let b1 = bitcast<f32>(work[L.pfilled + yb * L.pw + xb]);
    let up = a0 + (a1 - a0) * tx.z;
    let dn = b0 + (b1 - b0) * tx.z;
    let parent = up + (dn - up) * ty.z;
    let i = y * L.w + x;
    let own = f16x2_val(work[L.vwt + i]);
    work[L.filled + i] = bitcast<u32>(own.x + (1.0 - own.y) * parent);
}
