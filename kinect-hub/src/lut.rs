//! Per-pixel viewing rays with the lens distortion removed, computed once per device start.

use std::sync::Arc;

use serde_json::json;

use crate::protocol::{HEIGHT, Stream, WIDTH, f32_message};
use crate::state::{CameraParams, ParamSet, now_us};

/// For every pixel of the (distorted) depth image, the normalized undistorted ray (x, y):
/// the 3D point of a depth z is (x * z, y * z, z) in the camera frame (x right, y down, z forward).
///
/// libfreenect2's distortion model maps undistorted -> distorted coordinates; it is inverted here
/// by fixed-point iteration, which converges in a few steps for the mild Kinect lens distortion.
pub fn undistorted_rays(p: &CameraParams) -> Vec<f32> {
    let mut rays = Vec::with_capacity(WIDTH * HEIGHT * 2);
    for v in 0..HEIGHT {
        for u in 0..WIDTH {
            let xd = (u as f32 - p.cx) / p.fx;
            let yd = (v as f32 - p.cy) / p.fy;
            let (mut x, mut y) = (xd, yd);
            for _ in 0..12 {
                let r2 = x * x + y * y;
                let kr = 1.0 + ((p.k3 * r2 + p.k2) * r2 + p.k1) * r2;
                if kr.abs() < 1e-3 {
                    break;
                }
                let dx = p.p2 * (r2 + 2.0 * x * x) + 2.0 * p.p1 * x * y;
                let dy = p.p1 * (r2 + 2.0 * y * y) + 2.0 * p.p2 * x * y;
                x = (xd - dx) / kr;
                y = (yd - dy) / kr;
            }
            if !(x.is_finite() && y.is_finite()) || (x - xd).abs() > 0.5 || (y - yd).abs() > 0.5 {
                (x, y) = (xd, yd); // did not converge: fall back to the pinhole ray
            }
            rays.push(x);
            rays.push(y);
        }
    }
    rays
}

pub fn build_param_set(params: CameraParams) -> ParamSet {
    let rays = undistorted_rays(&params);
    param_set_with_rays(params, rays)
}

/// Like `build_param_set`, with rays that were computed elsewhere (a recording of a real sensor).
pub fn param_set_with_rays(params: CameraParams, rays: Vec<f32>) -> ParamSet {
    let now = now_us();
    let lut_msg = f32_message(Stream::Lut, 0, now, now, &rays);
    let json = json!({ "type": "params", "params": &params, "lut": {
        "kind": 16,
        "format": "f32 x,y per pixel, row-major 512x424; point = (x*z, y*z, z), camera frame x right, y down, z forward",
    }})
    .to_string()
    .into();
    ParamSet { params, rays: Arc::new(rays), json, lut_msg }
}
