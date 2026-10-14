//! A simulated Kinect v2: renders a 3D scene into raw depth packets that look like the real
//! ones (three modulation frequencies with three phase steps each, the per-pixel P0 phase
//! offsets, noise, saturation of the pixel taps, the 11-bit compression, the bit layout, mixed
//! pixels at depth edges), together with the ground truth.
//!
//! It is used to develop and test the decoders without hardware, as a data source for the driver
//! (`Source::Simulator`) and behind the mock USB device.
//!
//! The model per pixel and frequency k (raw sensor units):
//! - normalized amplitude `n` = brightness * albedo * cos(incidence) * cos(angle)^falloff / r^2
//!   (in libfreenect2's infrared scale divided by 10.67)
//! - raw amplitude `A_k = e_k * n / (1.5 * m_k)` (`m_k` = libfreenect2's per-frequency
//!   multiplier, `e_k` = relative exposure), phase `psi_k = 2 pi frac(f_k r / 18750 mm)`
//! - sample `v_kj = A_k cos(psi_k + theta_j + p0_k) + noise`, theta_j = 0, 120, 240 degrees
//! - charge of the fuller tap `B_k + |v_kj|`, `B_k = e_k * (dc * n / 1.5 + ambient)`; above the
//!   full well the sample is reported as saturated
//! - noise variance `read^2 + shot * B_k`, then the 11-bit companding of the sensor

pub mod eval;
pub mod rng;
pub mod scene;

use std::sync::Arc;

use crate::camera::IrCameraParams;
use crate::consts::{FREQ_MULTIPLES, HEIGHT, PIXELS, ROW_BYTES, SATURATED_CODE, SUBIMAGES, UNAMBIGUOUS_RANGE_MM, WIDTH};
use crate::error::Result;
use crate::packet::{RawDepthPacket, code_for_value, pack_row, packed_row};
use crate::tables::{DeviceTables, depth_from_u};
pub use rng::Rng;
pub use scene::{Object, Scene, Shape};

/// libfreenect2's infrared scale: IR = mean normalized amplitude * 0.6667 * 16.
pub const IR_SCALE: f32 = 0.666_666_7 * 16.0;

/// How the simulated sensor behaves.
#[derive(Clone, Debug, PartialEq)]
pub struct SimConfig {
    /// random seed (noise, P0 tables)
    pub seed: u64,
    /// camera intrinsics
    pub ir_params: IrCameraParams,
    /// read noise per sample, raw units
    pub read_noise: f32,
    /// shot noise: variance per unit of tap charge
    pub shot_noise: f32,
    /// tap charge at which a sample saturates, raw units
    pub full_well: f32,
    /// DC tap charge per unit of normalized amplitude (times 1/1.5)
    pub dc_ratio: f32,
    /// relative exposure of the three frequencies
    pub exposure: [f32; 3],
    /// relative amplitude error of the three frequencies (1 = as libfreenect2's multipliers assume)
    pub gain_error: [f32; 3],
    /// residual common mode of the three phase samples, as a fraction of the amplitude
    pub common_mode: f32,
    /// 2 x 2 rays per pixel, so depth edges produce mixed ("flying") pixels
    pub supersample: bool,
    /// exponent of the illumination falloff towards the image corners
    pub falloff: f32,
    /// libfreenect2's `ab_multiplier_per_frq`
    pub ab_multiplier_per_frq: [f32; 3],
    /// libfreenect2's `phase_in_rad`
    pub phase_in_rad: [f32; 3],
}

impl Default for SimConfig {
    fn default() -> Self {
        SimConfig {
            seed: 1,
            ir_params: IrCameraParams::TYPICAL,
            read_noise: 3.0,
            shot_noise: 0.03,
            full_well: 5000.0,
            dc_ratio: 2.0,
            exposure: [1.0; 3],
            gain_error: [1.0; 3],
            common_mode: 0.0,
            supersample: true,
            falloff: 2.0,
            ab_multiplier_per_frq: [1.322581, 1.0, 1.612903],
            phase_in_rad: [0.0, 2.094395, 4.18879],
        }
    }
}

/// What the scene really looked like.
#[derive(Clone, Debug, Default)]
pub struct GroundTruth {
    /// distance along the pixel's ray, mm (0 = nothing in this direction)
    pub radial: Vec<f32>,
    /// the depth an ideal decoder reports (libfreenect2's depth formula at the true distance),
    /// mm; 0 if nothing was hit or it lies beyond the unambiguous range
    pub depth: Vec<f32>,
    /// the true infrared brightness, libfreenect2 scale, not clipped
    pub ir: Vec<f32>,
    /// bit k: frequency k had a saturated sample; bit 3 + k: two or more
    pub saturated: Vec<u8>,
    /// the pixel mixes surfaces more than 3 % apart in distance (depth edge)
    pub mixed: Vec<bool>,
}

/// The simulated sensor.
pub struct Simulator {
    cfg: SimConfig,
    tables: Arc<DeviceTables>,
    rng: Rng,
}

impl Simulator {
    /// A simulator with its own (random but smooth) P0 calibration.
    pub fn new(cfg: SimConfig) -> Result<Simulator> {
        let mut rng = Rng::new(cfg.seed ^ 0x5EED);
        let bases = [0x2c9a as f32, 0x08ec as f32, 0x42e8 as f32];
        let p0: [Vec<u16>; 3] = std::array::from_fn(|k| {
            let base = bases.get(k).copied().unwrap_or(10000.0);
            (0..PIXELS)
                .map(|i| {
                    let xn = ((i % WIDTH) as f32 - 256.0) / 256.0;
                    let yn = ((i / WIDTH) as f32 - 212.0) / 212.0;
                    let v = base + 1500.0 * (xn * xn + 0.7 * yn * yn) + 300.0 * xn * (k as f32 + 1.0) + 50.0 * (rng.uniform() - 0.5);
                    v.clamp(0.0, 65535.0) as u16
                })
                .collect()
        });
        let tables = DeviceTables::from_tables(cfg.ir_params, p0, "SIMULATED000")?;
        Ok(Simulator { rng: Rng::new(cfg.seed), cfg, tables })
    }

    /// The tables a decoder needs for this simulated device.
    pub fn tables(&self) -> &Arc<DeviceTables> {
        &self.tables
    }

    /// The configuration.
    pub fn config(&self) -> &SimConfig {
        &self.cfg
    }

    /// Renders one frame of `scene`.
    pub fn frame(&mut self, scene: &Scene, sequence: u32) -> (RawDepthPacket, GroundTruth) {
        let c = &self.cfg;
        let t = &self.tables;
        let p = c.ir_params;
        let mut packet = RawDepthPacket::zeroed(sequence, sequence.wrapping_mul(333));
        packet.present = crate::consts::ALL_SUBIMAGES;
        let mut gt = GroundTruth {
            radial: vec![0.0; PIXELS],
            depth: vec![0.0; PIXELS],
            ir: vec![0.0; PIXELS],
            saturated: vec![0; PIXELS],
            mixed: vec![false; PIXELS],
        };
        let offsets: &[(f32, f32)] = if c.supersample { &[(-0.25, -0.25), (0.25, -0.25), (-0.25, 0.25), (0.25, 0.25)] } else { &[(0.0, 0.0)] };
        let cos_theta = c.phase_in_rad.map(f32::cos);
        let sin_theta = c.phase_in_rad.map(f32::sin);
        let mut codes = vec![[0u16; WIDTH]; SUBIMAGES];
        for y in 0..HEIGHT {
            for x in 0..WIDTH {
                let i = y * WIDTH + x;
                let ray = t.rays.get(i).copied().unwrap_or([0.0, 0.0]);
                // complex return per frequency, summed over the sub-rays
                let mut re = [0f32; 3];
                let mut im = [0f32; 3];
                let mut total = 0f32;
                let (mut rmin, mut rmax) = (f32::INFINITY, 0f32);
                for (dx, dy) in offsets {
                    let dir = norm3([ray[0] + dx / p.fx, ray[1] + dy / p.fy, 1.0]);
                    let Some(hit) = scene.cast(dir) else { continue };
                    let r = hit.t;
                    let r_m = r / 1000.0;
                    let ir = scene.brightness * hit.reflect * hit.cos_incidence.max(0.02) * dir[2].powf(c.falloff) / (r_m * r_m);
                    let n = ir / IR_SCALE / offsets.len() as f32;
                    total += n;
                    rmin = rmin.min(r);
                    rmax = rmax.max(r);
                    for k in 0..3 {
                        let f = FREQ_MULTIPLES.get(k).copied().unwrap_or(1) as f32;
                        let cycles = f * r / UNAMBIGUOUS_RANGE_MM;
                        let psi = std::f32::consts::TAU * (cycles - cycles.floor());
                        if let (Some(re), Some(im)) = (re.get_mut(k), im.get_mut(k)) {
                            *re += n * psi.cos();
                            *im += n * psi.sin();
                        }
                    }
                }
                // ground truth from the pixel center
                let center = scene.cast(norm3([ray[0], ray[1], 1.0]));
                if let Some(h) = center {
                    let r_m = h.t / 1000.0;
                    let ir = scene.brightness * h.reflect * h.cos_incidence.max(0.02) * norm3([ray[0], ray[1], 1.0])[2].powf(c.falloff) / (r_m * r_m);
                    if let Some(g) = gt.radial.get_mut(i) {
                        *g = h.t;
                    }
                    if let Some(g) = gt.ir.get_mut(i) {
                        *g = ir;
                    }
                    if h.t < UNAMBIGUOUS_RANGE_MM
                        && let Some(g) = gt.depth.get_mut(i)
                    {
                        *g = depth_from_u(h.t / UNAMBIGUOUS_RANGE_MM, t.xtable.get(i).copied().unwrap_or(0.0), t.ztable.get(i).copied().unwrap_or(0.0));
                    }
                }
                if rmax > 0.0
                    && rmax > rmin * 1.03
                    && let Some(m) = gt.mixed.get_mut(i)
                {
                    *m = true;
                }
                let mut sat_bits = 0u8;
                for k in 0..3 {
                    let m = c.ab_multiplier_per_frq.get(k).copied().unwrap_or(1.0);
                    let e = c.exposure.get(k).copied().unwrap_or(1.0);
                    let g = c.gain_error.get(k).copied().unwrap_or(1.0);
                    let (zr, zi) = (re.get(k).copied().unwrap_or(0.0), im.get(k).copied().unwrap_or(0.0));
                    let amp = (zr * zr + zi * zi).sqrt();
                    let psi = zi.atan2(zr);
                    let a = e * g * amp / (1.5 * m);
                    let dc = e * (c.dc_ratio * total / 1.5 + scene.ambient);
                    let sigma = (c.read_noise * c.read_noise + c.shot_noise * dc).sqrt();
                    let p0 = t.p0_phase(k, i) as f32;
                    let mut nsat = 0;
                    for j in 0..3 {
                        let (ct, st) = (cos_theta.get(j).copied().unwrap_or(1.0), sin_theta.get(j).copied().unwrap_or(0.0));
                        // cos(psi + theta + p0) without another trig call per sample
                        let (cp, sp) = ((psi + p0).cos(), (psi + p0).sin());
                        let clean = a * (cp * ct - sp * st);
                        let v = clean + c.common_mode * a + sigma * self.rng.normal();
                        let code = if dc + v.abs() > c.full_well {
                            nsat += 1;
                            SATURATED_CODE
                        } else if x == 0 || x == WIDTH - 1 {
                            0
                        } else {
                            code_for_value(v)
                        };
                        if let Some(row) = codes.get_mut(3 * k + j)
                            && let Some(o) = row.get_mut(x)
                        {
                            *o = code;
                        }
                    }
                    if nsat >= 1 {
                        sat_bits |= 1 << k;
                    }
                    if nsat >= 2 {
                        sat_bits |= 1 << (3 + k);
                    }
                }
                if let Some(s) = gt.saturated.get_mut(i) {
                    *s = sat_bits;
                }
                // the 10th sub-image: unknown meaning; something ambient-like
                if let Some(o) = codes.get_mut(9).and_then(|r| r.get_mut(x)) {
                    *o = code_for_value((scene.ambient + 0.1 * total).min(16000.0));
                }
            }
            let Some(r) = packed_row(y) else { continue };
            for (s, row_codes) in codes.iter().enumerate() {
                let start = s * crate::consts::SUBIMAGE_BYTES + r * ROW_BYTES;
                if let Some(dst) = packet.data.get_mut(start..start + ROW_BYTES) {
                    pack_row(row_codes, dst);
                }
            }
        }
        (packet, gt)
    }
}

fn norm3(v: [f32; 3]) -> [f32; 3] {
    let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if l > 0.0 { [v[0] / l, v[1] / l, v[2] / l] } else { [0.0, 0.0, 1.0] }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::packet::{lut11to16, unpack_row};

    #[test]
    fn flat_wall_samples_follow_the_model() {
        let mut sim = Simulator::new(SimConfig { read_noise: 0.0, shot_noise: 0.0, supersample: false, ..Default::default() }).unwrap();
        let scene = scene::flat(2000.0);
        let (packet, gt) = sim.frame(&scene, 0);
        let lut = lut11to16();
        let (y, x) = (212, 256);
        let i = y * WIDTH + x;
        assert!(gt.radial[i] > 1999.0 && gt.radial[i] < 2010.0);
        // decode frequency 1 by hand: a = sum v cos(theta + p0), b = -sum v sin(theta + p0)
        let mut codes = [0u16; WIDTH];
        let p0 = sim.tables().p0_phase(1, i) as f32;
        let (mut a, mut b) = (0f32, 0f32);
        for j in 0..3 {
            unpack_row(packet.row_bytes(3 + j, y).unwrap(), &mut codes);
            let v = f32::from(lut[usize::from(codes[x])]);
            let th = [0.0f32, 2.094395, 4.18879][j] + p0;
            a += v * th.cos();
            b -= v * th.sin();
        }
        let phase = b.atan2(a).rem_euclid(std::f32::consts::TAU);
        let cycles = 2.0 * gt.radial[i] / UNAMBIGUOUS_RANGE_MM;
        let expected = std::f32::consts::TAU * (cycles - cycles.floor());
        assert!((phase - expected).abs() < 0.02, "phase {phase} expected {expected}");
        // amplitude in libfreenect2's scale: n = 1.5 * A * m = the scene's normalized amplitude
        let n = (a * a + b * b).sqrt();
        assert!((n * IR_SCALE - gt.ir[i]).abs() / gt.ir[i] < 0.02, "{} vs {}", n * IR_SCALE, gt.ir[i]);
    }

    #[test]
    fn close_bright_objects_saturate() {
        let mut sim = Simulator::new(SimConfig::default()).unwrap();
        let (_, gt) = sim.frame(&Scene::preset("near", 0.0).unwrap(), 0);
        let sat = gt.saturated.iter().filter(|s| **s != 0).count();
        assert!(sat > 500, "only {sat} saturated pixels");
        assert!(sat < PIXELS / 4);
    }
}
