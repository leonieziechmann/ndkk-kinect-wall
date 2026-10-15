//! The per-device tables every depth decoder needs: P0 phase offsets (from the device), and the
//! x/z tables and the 11-to-16-bit table (computed on the host from the camera parameters,
//! exactly as libfreenect2 does).

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::camera::IrCameraParams;
use crate::consts::{PIXELS, UNAMBIGUOUS_RANGE_MM, WIDTH};
use crate::error::{Error, Result};
use crate::packet::lut11to16;
use crate::protocol::response::P0Tables;

/// Everything a depth decoder needs to know about one device. Shared (`Arc`) between the
/// decoders and the frames they produce.
#[derive(Debug)]
pub struct DeviceTables {
    /// unique per instance: decoders reload their derived tables when it changes
    pub id: u64,
    /// camera intrinsics and distortion
    pub ir_params: IrCameraParams,
    /// raw P0 tables of the three frequencies, in image row order (row 0 at the top)
    pub p0: [Vec<u16>; 3],
    /// libfreenect2's x table: 8192 * undistorted x / z, per pixel
    pub xtable: Vec<f32>,
    /// libfreenect2's z table: unambiguous distance / |ray|, per pixel (0 = invalid pixel)
    pub ztable: Vec<f32>,
    /// 11-bit code -> sample value
    pub lut: [f32; 2048],
    /// undistorted ray per pixel (x / z, y / z), for point clouds
    pub rays: Vec<[f32; 2]>,
    /// pixels where the undistortion did not converge
    pub divergent_pixels: usize,
    /// the device's P0 response as received (for recordings), if any
    pub p0_raw: Option<Vec<u8>>,
    /// serial number of the device, if known
    pub serial: String,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

impl DeviceTables {
    /// Builds all tables from the device's camera parameters and P0 tables.
    pub fn new(ir_params: IrCameraParams, p0: P0Tables, serial: &str) -> Result<Arc<DeviceTables>> {
        ir_params.validate().map_err(Error::InvalidData)?;
        for (k, t) in p0.tables.iter().enumerate() {
            if t.len() != PIXELS {
                return Err(Error::invalid(format!("P0 table {k} has {} entries", t.len())));
            }
        }
        let geo = Geometry::new(&ir_params);
        let lut16 = lut11to16();
        let mut lut = [0f32; 2048];
        for (o, v) in lut.iter_mut().zip(lut16.iter()) {
            *o = f32::from(*v);
        }
        Ok(Arc::new(DeviceTables {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            ir_params,
            p0: p0.tables,
            xtable: geo.xtable,
            ztable: geo.ztable,
            lut,
            rays: geo.rays,
            divergent_pixels: geo.divergent,
            p0_raw: Some(p0.raw),
            serial: serial.to_string(),
        }))
    }

    /// Tables from raw P0 tables without the original response (recordings that kept only
    /// the tables, the simulator).
    pub fn from_tables(ir_params: IrCameraParams, p0: [Vec<u16>; 3], serial: &str) -> Result<Arc<DeviceTables>> {
        let raw = crate::protocol::response::encode_p0_tables(&p0);
        DeviceTables::new(ir_params, P0Tables { tables: p0, raw }, serial)
    }

    /// The P0 phase of frequency `k` at a pixel, radians (libfreenect2: `-raw * 0.000031 * pi`).
    pub fn p0_phase(&self, k: usize, pixel: usize) -> f64 {
        let raw = self.p0.get(k).and_then(|t| t.get(pixel)).copied().unwrap_or(0);
        -f64::from(raw) * 0.000031 * std::f64::consts::PI
    }
}

/// Per-pixel geometry derived from the camera parameters.
pub struct Geometry {
    /// libfreenect2's x table
    pub xtable: Vec<f32>,
    /// libfreenect2's z table
    pub ztable: Vec<f32>,
    /// undistorted (x / z, y / z) per pixel
    pub rays: Vec<[f32; 2]>,
    /// pixels where the undistortion did not converge
    pub divergent: usize,
}

impl Geometry {
    /// Computes the tables as libfreenect2's `IrCameraTables` (double precision, Newton's
    /// method for the inverse distortion).
    pub fn new(p: &IrCameraParams) -> Geometry {
        let scaling = 8192.0f64;
        let unambiguous = f64::from(UNAMBIGUOUS_RANGE_MM) / 9.0; // 6250 / 3
        let mut xtable = Vec::with_capacity(PIXELS);
        let mut ztable = Vec::with_capacity(PIXELS);
        let mut rays = Vec::with_capacity(PIXELS);
        let mut divergent = 0;
        for i in 0..PIXELS {
            let xi = (i % WIDTH) as f64;
            let yi = (i / WIDTH) as f64;
            let xd = (xi + 0.5 - f64::from(p.cx)) / f64::from(p.fx);
            let yd = (yi + 0.5 - f64::from(p.cy)) / f64::from(p.fy);
            let (xu, yu, ok) = undistort(p, xd, yd);
            divergent += usize::from(!ok);
            xtable.push((scaling * xu) as f32);
            ztable.push((unambiguous / (xu * xu + yu * yu + 1.0).sqrt()) as f32);
            rays.push([xu as f32, yu as f32]);
        }
        Geometry { xtable, ztable, rays, divergent }
    }
}

/// libfreenect2's `unambigious_dist` (6250 / 3 mm): the range of one "phase unit".
pub const PHASE_UNIT_MM: f32 = 2083.333;

/// Depth in mm from libfreenect2's final phase (`9 u`, u = distance / 18.75 m in [0, 1)), with
/// its correction for the offset between light source and camera (the x table). 0 or less =
/// no measurement.
#[inline(always)]
pub fn depth_from_phase(phase: f32, xtable: f32, ztable: f32) -> f32 {
    // branch-free, so the pixel loops around it vectorize
    let depth_linear = ztable * phase;
    let max_depth = phase * PHASE_UNIT_MM * 2.0;
    let cond = depth_linear > 0.0 && max_depth > 0.0;
    let md2 = if cond { max_depth * max_depth * 8192.0 } else { 1.0 };
    let xmul = (xtable * 90.0) / md2;
    let fit = depth_linear / (-depth_linear * xmul + 1.0);
    let fit = if fit < 0.0 { 0.0 } else { fit };
    if cond { fit } else { depth_linear }
}

/// Depth in mm for a distance given as fraction `u` of the unambiguous range.
#[inline(always)]
pub fn depth_from_u(u: f32, xtable: f32, ztable: f32) -> f32 {
    depth_from_phase(9.0 * u, xtable, ztable)
}

/// Radial and tangential distortion of normalized coordinates (libfreenect2's `distort`).
pub fn distort(p: &IrCameraParams, x: f64, y: f64) -> (f64, f64) {
    let (k1, k2, k3, p1, p2) = (f64::from(p.k1), f64::from(p.k2), f64::from(p.k3), f64::from(p.p1), f64::from(p.p2));
    let x2 = x * x;
    let y2 = y * y;
    let r2 = x2 + y2;
    let xy = x * y;
    let kr = ((k3 * r2 + k2) * r2 + k1) * r2 + 1.0;
    (x * kr + p2 * (r2 + 2.0 * x2) + 2.0 * p1 * xy, y * kr + p1 * (r2 + 2.0 * y2) + 2.0 * p2 * xy)
}

/// The inverse of [`distort`] by Newton's method (libfreenect2's `undistort`): returns the
/// undistorted coordinates and whether the iteration converged.
pub fn undistort(p: &IrCameraParams, x0: f64, y0: f64) -> (f64, f64, bool) {
    let (k1, k2, k3, p1, p2) = (f64::from(p.k1), f64::from(p.k2), f64::from(p.k3), f64::from(p.p1), f64::from(p.p2));
    let (mut x, mut y) = (x0, y0);
    let (mut last_x, mut last_y) = (x, y);
    let max_iterations = 100;
    let eps = f64::EPSILON * 16.0;
    for _ in 0..max_iterations {
        let x2 = x * x;
        let y2 = y * y;
        let x2y2 = x2 + y2;
        let x2y22 = x2y2 * x2y2;
        let x2y23 = x2y2 * x2y22;
        let ja = k3 * x2y23 + (k2 + 6.0 * k3 * x2) * x2y22 + (k1 + 4.0 * k2 * x2) * x2y2 + 2.0 * k1 * x2 + 6.0 * p2 * x + 2.0 * p1 * y + 1.0;
        let jb = 6.0 * k3 * x * y * x2y22 + 4.0 * k2 * x * y * x2y2 + 2.0 * k1 * x * y + 2.0 * p1 * x + 2.0 * p2 * y;
        let jc = jb;
        let jd = k3 * x2y23 + (k2 + 6.0 * k3 * y2) * x2y22 + (k1 + 4.0 * k2 * y2) * x2y2 + 2.0 * k1 * y2 + 2.0 * p2 * x + 6.0 * p1 * y + 1.0;
        let det = ja * jd - jb * jc;
        if det == 0.0 || !det.is_finite() {
            return (x, y, false);
        }
        let jdet = 1.0 / det;
        let (a, b, c, d) = (jd * jdet, -jb * jdet, -jc * jdet, ja * jdet);
        let (f, g) = distort(p, x, y);
        let f = f - x0;
        let g = g - y0;
        x -= a * f + b * g;
        y -= c * f + d * g;
        if !x.is_finite() || !y.is_finite() {
            return (x0, y0, false);
        }
        if (x - last_x).abs() <= eps && (y - last_y).abs() <= eps {
            return (x, y, true);
        }
        last_x = x;
        last_y = y;
    }
    (x, y, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn undistort_inverts_distort() {
        let p = IrCameraParams::TYPICAL;
        for &(x, y) in &[(0.0, 0.0), (0.3, -0.2), (-0.65, 0.55), (0.7, 0.58)] {
            let (xd, yd) = distort(&p, x, y);
            let (xu, yu, ok) = undistort(&p, xd, yd);
            assert!(ok);
            assert!((xu - x).abs() < 1e-9 && (yu - y).abs() < 1e-9, "{x} {y} -> {xu} {yu}");
        }
    }

    #[test]
    fn tables_are_sane() {
        let g = Geometry::new(&IrCameraParams::TYPICAL);
        assert_eq!(g.divergent, 0);
        let center = 207 * WIDTH + 255;
        assert!((g.ztable[center] - 2083.333).abs() < 0.5);
        // corners: longer rays, smaller z multiplier; x table changes sign across the image
        assert!(g.ztable[0] < g.ztable[center]);
        assert!(g.xtable[207 * WIDTH] < 0.0 && g.xtable[207 * WIDTH + 511] > 0.0);
        assert!(g.ztable.iter().all(|z| *z > 0.0 && z.is_finite()));
    }
}
