// The time-of-flight decoding on the GPU: the same steps, constants and approximations as the
// CPU decoder (tof/kernels.rs, tof/resolve.rs, tof/fill.rs), one invocation per pixel.
//
// The Rust side puts a prelude in front of this file: the image and plane constants and
// `struct Params` (generated from the same values the CPU decoder uses).
//
// Buffers:
//   raw  the nine phase sub-images as u32 words, then one row mask per image row (bit s = row
//        of sub-image s arrived)
//   tabs per-pixel tables (planes T_*) and the 11-to-16-bit lookup table
//   fw   float work planes (F_*) and the push-pull pyramid
//   iw   integer work planes (I_*)
//   L    the level of a push-pull step

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> raw: array<u32>;
@group(0) @binding(2) var<storage, read> tabs: array<f32>;
@group(0) @binding(3) var<storage, read_write> fw: array<f32>;
@group(0) @binding(4) var<storage, read_write> iw: array<u32>;

struct Level {
    w: u32,
    h: u32,
    pw: u32,
    ph: u32,
    vw: u32,
    wt: u32,
    filled: u32,
    pvw: u32,
    pwt: u32,
    pfilled: u32,
    src_v: u32,
    src_w: u32,
}
@group(1) @binding(0) var<uniform> L: Level;

const PI: f32 = 3.14159265;
const TAU: f32 = 6.28318531;
const BIG: f32 = 3.0e38;

fn fget(p: u32, i: u32) -> f32 { return fw[p * N + i]; }
fn fset(p: u32, i: u32, v: f32) { fw[p * N + i] = v; }
fn iget(p: u32, i: u32) -> u32 { return iw[p * N + i]; }
fn iset(p: u32, i: u32, v: u32) { iw[p * N + i] = v; }
fn tget(p: u32, i: u32) -> f32 { return tabs[p * N + i]; }

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
            val = tabs[T_LUT + c];
        }
        v[s] = val;
    }
    let valid = tget(T_VALID, i);
    if (P.mode == 0u) {
        // compat (libfreenect2): a saturated sample zeroes its frequency, white infrared
        var ir_acc = 0.0;
        for (var k = 0u; k < 3u; k++) {
            let v0 = v[3u * k];
            let v1 = v[3u * k + 1u];
            let v2 = v[3u * k + 2u];
            let fok = ((mask >> (3u * k)) & 7u) == 7u;
            let mc = tget(T_MC + k, i);
            let ms = tget(T_MS + k, i);
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
            fset(F_A + k, i, av);
            fset(F_B + k, i, bv);
            fset(F_N + k, i, nn);
            var inv = 0.0;
            if (nn > 0.0) { inv = 1.0 / max(nn, 1e-30); }
            fset(F_NA + k, i, av * inv);
            fset(F_NB + k, i, bv * inv);
            if (sat) { ir_acc += 65535.0; } else { ir_acc += nn; }
        }
        fset(F_IR, i, min(ir_acc * P.ir_scale, 65535.0));
        iset(I_USABLE, i, 0u);
        iset(I_FLAGS, i, 0u);
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
        let mc = tget(T_MC + k, i);
        let ms = tget(T_MS + k, i);
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
        fset(F_A + k, i, av);
        fset(F_B + k, i, bv);
        fset(F_N + k, i, nn);
        var inv = 0.0;
        if (nn > 0.0) { inv = 1.0 / max(nn, 1e-30); }
        fset(F_NA + k, i, av * inv);
        fset(F_NB + k, i, bv * inv);
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
    fset(F_IR, i, ir);
    iset(I_USABLE, i, usable);
    iset(I_FLAGS, i, fl);
}

// ---- stage 2: bilateral filter, unwrapping ----------------------------------------------

// libfreenect2's joint bilateral filter of frequency k at (x, y): (a, b, edge ok)
fn bilateral(x: u32, y: u32, k: u32, ext: bool) -> vec3<f32> {
    let i = y * W + x;
    let a_c = fget(F_A + k, i);
    let b_c = fget(F_B + k, i);
    if (P.bilateral == 0u || y < 1u || y > H - 2u || x < 1u || x > W - 2u) {
        return vec3<f32>(a_c, b_c, 1.0);
    }
    let nn = fget(F_N + k, i);
    let c0 = nn * nn < P.jb_threshold;
    var thr = P.jb_threshold;
    var ex = P.jb_exp;
    if (c0) {
        thr = 0.0;
        ex = 0.0;
    }
    let sna = fget(F_NA + k, i);
    let snb = fget(F_NB + k, i);
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
            let on = fget(F_N + k, o);
            var c1 = on * on < thr;
            if (ext) { c1 = c1 || on <= 0.0; }
            let dot = sna * fget(F_NA + k, o) + snb * fget(F_NB + k, o);
            let dist = 0.5 * (1.0 - dot);
            var w = 0.0;
            if (!c1) { w = g * exp_(ex * dist); }
            wa += w * fget(F_A + k, o);
            wb += w * fget(F_B + k, o);
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
            let on = fget(F_N + k, o);
            if (on > 0.0) {
                sa += fget(F_A + k, o);
                sb += fget(F_B + k, o);
                sm += on;
                cnt += 1.0;
            }
        }
    }
    let thr = P.weak_threshold / P.ab_multiplier;
    let amp = sqrt(af * af + bf * bf);
    let self_ok = fget(F_N + k, y * W + x) > 0.0;
    let weak = amp < thr;
    let in_phase = sqrt(sa * sa + sb * sb) > 0.8 * sm;
    let take = self_ok && weak && in_phase && cnt >= 12.0;
    let inv = 1.0 / max(cnt, 1.0);
    if (take) { return vec3<f32>(sa * inv, sb * inv, 1.0); }
    return vec3<f32>(af, bf, 0.0);
}

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
        fset(F_S2 + 0u, i, depth_from_phase(pf, xt, zt));
        fset(F_S2 + 1u, i, ir_sum);
        iset(I_EDGE, i, u32(edge));
        return;
    }
    // extended: maximum-likelihood unwrapping over the whole unambiguous range
    let usable = iget(I_USABLE, i);
    var fl = iget(I_FLAGS, i);
    var c: array<f32, 3>;
    var w: array<f32, 3>;
    var ir_sum = 0.0;
    var nvalid = 0.0;
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
    }
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
        var e = max(s2 - s1 * s1 * inv_wn2, 0.0);
        let u = um - s1 * inv_wn2;
        let dm = u * (U_RANGE_MM * 0.001);
        let rho = irl * dm * dm * P.inv_brightness;
        let implausible = rho > P.max_reflectivity || rho < P.min_reflectivity;
        if (implausible && P.plausibility != 0u) { e += 30.0; }
        e += mf * TIE_BREAK;
        if (e < e1) {
            e2 = e1;
            u2 = u1;
            e1 = e;
            u1 = u;
        } else if (e < e2) {
            e2 = e;
            u2 = u;
        }
    }
    let dof = max(nvalid - 1.0, 0.0);
    let chi = dof + 3.0 * sqrt(2.0 * dof);
    let margin = min(e2 - e1, 80.0);
    let post = 1.0 / (1.0 + exp_(-0.5 * margin));
    let cons = exp_(-0.5 * max(e1 - chi, 0.0));
    let multi = nvalid >= 2.0;
    let single = nvalid == 1.0;
    var ou1 = u1;
    var ou2 = u2;
    if (single) {
        ou1 = c_ref / n_ref;
        ou2 = (c_ref + 1.0) / n_ref;
    }
    var conf = 0.0;
    if (multi) { conf = post * cons; }
    var anchor = 0.0;
    if (multi && conf >= ANCHOR_CONFIDENCE) { anchor = conf; }
    fset(F_S2 + S2_U1, i, ou1);
    fset(F_S2 + S2_U2, i, ou2);
    fset(F_S2 + S2_E1, i, e1);
    fset(F_S2 + S2_E2, i, e2);
    fset(F_S2 + S2_CONF, i, conf);
    fset(F_S2 + S2_CSINGLE, i, c_ref);
    fset(F_S2 + S2_IR_SUM, i, ir_sum);
    fset(F_S2 + S2_ANCHOR, i, anchor);
    var kind = KIND_NONE;
    if (multi) { kind = KIND_MULTI; } else if (single) { kind = KIND_SINGLE | (r_idx << 4u); }
    iset(I_KIND, i, kind);
    iset(I_EDGE, i, u32(edge));
    iset(I_SAT, i, fl & FL_SATURATED_ANY);
    if (boosted) { fl |= FL_WEAK_BOOSTED; }
    if (nvalid == 0.0) { fl |= FL_NO_SIGNAL; }
    if (e1 >= 25.0 && nvalid >= 1.0) { fl |= FL_PLAUSIBILITY; }
    iset(I_FLAGS, i, fl);
}

// ---- stage 3: edge filter -----------------------------------------------------------------

// libfreenect2's flying-pixel test at (x, y) on the depth plane `dp` with the amplitude sums `sp`
fn is_flying(x: u32, y: u32, dp: u32, sp: u32) -> bool {
    let d = fget(dp, y * W + x);
    let s = fget(sp, y * W + x);
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
        let sn = fget(sp, o);
        acc += sn;
        sq += sn * sn;
        let on = fget(dp, o);
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
    let v = fget(F_S2 + 0u, i);
    var out = v;
    if (P.edge_enabled != 0u) {
        let in_range = v >= P.min_depth && v <= P.max_depth;
        if (y < 1u || y > H - 2u || x < 1u || x > W - 2u) {
            out = select(0.0, v, in_range);
        } else {
            let flying = is_flying(x, y, F_S2 + 0u, F_S2 + 1u);
            out = select(0.0, v, in_range && !flying && iget(I_EDGE, i) != 0u);
        }
    }
    fset(F_DEPTH, i, out);
    fset(F_CONF, i, select(0.0, 1.0, out > 0.0));
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
    let u1 = fget(F_S2 + S2_U1, i);
    let k = iget(I_KIND, i);
    let base = k & 15u;
    var fl = iget(I_FLAGS, i);
    var d_out = 0.0;
    var c_out = 0.0;
    if (P.spatial == 0u) {
        // no neighbors: multi-frequency results as they are, single ones dropped
        var cv = 0.0;
        if (base == KIND_MULTI) { cv = fget(F_S2 + S2_CONF, i); }
        if (cv > 0.0) { d_out = depth_of_u(u1, xt, zt); }
        fset(F_DRES, i, d_out);
        fset(F_CRES, i, cv);
        return;
    }
    let r = P.radius;
    let y0 = u32(max(i32(y) - i32(r), 0));
    let y1 = min(y + r, H - 1u);
    let x0 = u32(max(i32(x) - i32(r), 0));
    let x1 = min(x + r, W - 1u);
    if (base == KIND_MULTI) {
        let u2 = fget(F_S2 + S2_U2, i);
        let c = fget(F_S2 + S2_CONF, i);
        let gap = fget(F_S2 + S2_E2, i) - fget(F_S2 + S2_E1, i);
        if (c >= SURE_CONFIDENCE || (gap >= 20.0 && c >= CONFIRMED_CONFIDENCE)) {
            fset(F_DRES, i, depth_of_u(u1, xt, zt));
            fset(F_CRES, i, c);
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
                let uj = fget(F_S2 + S2_U1, o);
                let aj = fget(F_S2 + S2_ANCHOR, o);
                let dd1 = uj - u1;
                let dd2 = uj - u2;
                total += aj;
                s1 += aj * max(1.0 - dd1 * dd1 * inv_h2, 0.0);
                s2 += aj * max(1.0 - dd2 * dd2 * inv_h2, 0.0);
            }
        }
        // the pixel itself does not vote
        let own = fget(F_S2 + S2_ANCHOR, i);
        let d = (u2 - u1) / h;
        s1 -= own;
        s2 -= own * max(1.0 - d * d, 0.0);
        total -= own;
        var u = u1;
        var conf = c;
        if (total > 1.0 && s2 > 2.0 * s1 && gap < 20.0) {
            u = u2;
            conf = min(0.55 + 0.4 * s2 / total, 0.95);
            fl |= FL_RESOLVED;
        } else if (total > 1.0 && s1 > 2.0 * s2 && s1 > 0.5 * total) {
            conf = max(c, min(0.55 + 0.4 * s1 / total, 0.95));
            fl |= FL_RESOLVED;
        }
        fset(F_DRES, i, depth_of_u(u, xt, zt));
        fset(F_CRES, i, conf);
        iset(I_FLAGS, i, fl);
        return;
    }
    if (base == KIND_SINGLE) {
        let fi = (k >> 4u) & 3u;
        let n = nf(fi);
        let cref = fget(F_S2 + S2_CSINGLE, i);
        fl |= FL_SINGLE_FREQUENCY;
        let saturated = (fl & FL_SATURATED_ANY) != 0u;
        var votes: array<f32, 16>;
        for (var m = 0u; m < 16u; m++) { votes[m] = 0.0; }
        var total = 0.0;
        for (var yy = y0; yy <= y1; yy++) {
            for (var xx = x0; xx <= x1; xx++) {
                let o = yy * W + xx;
                let aj = fget(F_S2 + S2_ANCHOR, o);
                if (aj <= 0.0) { continue; }
                let uj = fget(F_S2 + S2_U1, o);
                var wj = aj;
                if (saturated && iget(I_SAT, o) != 0u) { wj = 10.0 * aj; }
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
        let e = fget(F_EXP, i);
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
        fset(F_DRES, i, d_out);
        fset(F_CRES, i, conf);
        iset(I_FLAGS, i, fl);
        return;
    }
    fset(F_DRES, i, 0.0);
    fset(F_CRES, i, 0.0);
}

// ---- stage 3b (extended): edge and speckle filter, range, confidence ---------------------------

@compute @workgroup_size(16, 8, 1)
fn finish(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if (x >= W || y >= H) { return; }
    let i = y * W + x;
    let v = fget(F_DRES, i);
    var fly = false;
    if (P.edge_enabled != 0u && y >= 1u && y <= H - 2u && x >= 1u && x <= W - 2u) {
        fly = v > 0.0 && (is_flying(x, y, F_DRES, F_S2 + S2_IR_SUM) || iget(I_EDGE, i) == 0u);
    }
    var agree = 24.0;
    if (P.speckle != 0u && y >= 2u && y <= H - 3u && x >= 2u && x <= W - 3u) {
        agree = 0.0;
        let tol = max(0.03 * v, 50.0);
        for (var dy = 0u; dy < 5u; dy++) {
            for (var dx = 0u; dx < 5u; dx++) {
                if (dy == 2u && dx == 2u) { continue; }
                let o = fget(F_DRES, (y + dy - 2u) * W + x + dx - 2u);
                if (o > 0.0 && abs(o - v) < tol) { agree += 1.0; }
            }
        }
    }
    let in_range = v >= P.min_depth && v <= P.max_depth;
    let c = fget(F_CRES, i);
    let confident = c >= P.out_min_conf;
    let speckle = P.speckle != 0u && agree < P.speckle_min;
    let keep = v > 0.0 && in_range && !fly && confident && !speckle;
    fset(F_DEPTH, i, select(0.0, v, keep));
    fset(F_CONF, i, select(0.0, c, keep));
    let has = v > 0.0;
    var fl = iget(I_FLAGS, i);
    if (has && !in_range) { fl |= FL_OUT_OF_RANGE; }
    if (has && in_range && fly) { fl |= FL_EDGE; }
    if (has && in_range && !fly && !confident) { fl |= FL_LOW_CONFIDENCE; }
    if (has && in_range && !fly && confident && speckle) { fl |= FL_SPECKLE; }
    iset(I_FLAGS, i, fl);
}

// ---- push-pull (tof/fill.rs): the expectation of u for the resolver ------------------------------

fn finite(v: f32) -> bool {
    return abs(v) <= 3.4e38;
}

// level 0 from two planes: weights clamped to 0..1, values premultiplied
@compute @workgroup_size(16, 8, 1)
fn pp_init(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if (x >= L.w || y >= L.h) { return; }
    let i = y * L.w + x;
    let v = fget(L.src_v, i);
    let w0 = fget(L.src_w, i);
    var w = 0.0;
    if (finite(w0)) { w = clamp(w0, 0.0, 1.0); }
    var vw = 0.0;
    if (finite(v)) { vw = v * w; }
    fw[L.vw + i] = vw;
    fw[L.wt + i] = w;
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
            v += fw[L.pvw + sy * L.pw + sx];
            t += fw[L.pwt + sy * L.pw + sx];
        }
    }
    if (t > 0.0) {
        let c = min(t, 1.0);
        v = v / t * c;
        t = c;
    }
    fw[L.vw + y * L.w + x] = v;
    fw[L.wt + y * L.w + x] = t;
}

// the coarsest level
@compute @workgroup_size(16, 8, 1)
fn pp_top(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if (x >= L.w || y >= L.h) { return; }
    let i = y * L.w + x;
    let w = fw[L.wt + i];
    var f = 0.0;
    if (w > 0.0) { f = fw[L.vw + i] / w; }
    fw[L.filled + i] = f;
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
    let a0 = fw[L.pfilled + ya * L.pw + xa];
    let a1 = fw[L.pfilled + ya * L.pw + xb];
    let b0 = fw[L.pfilled + yb * L.pw + xa];
    let b1 = fw[L.pfilled + yb * L.pw + xb];
    let up = a0 + (a1 - a0) * tx.z;
    let dn = b0 + (b1 - b0) * tx.z;
    let parent = up + (dn - up) * ty.z;
    let i = y * L.w + x;
    fw[L.filled + i] = fw[L.vw + i] + (1.0 - fw[L.wt + i]) * parent;
}
