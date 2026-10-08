//! YOLO-pose (Ultralytics YOLO11n-pose, web/lib/models/README.md) on the infrared image with ONNX
//! Runtime: preparing the input and decoding the output exactly as web/lib/persons-pose.js does
//! in the browser, for any input size the model was exported with (512x448, 384x320, ...).
//! Measured against the browser with kinect-hub/pose-bench (README there).

use std::path::{Path, PathBuf};

use ort::ep;
use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::Tensor;

use crate::protocol::{HEIGHT as H, PIXELS, WIDTH as W};

const MAX_POSES: usize = 16;
const MIN_SCORE: f32 = 0.35;
const NMS_IOU: f64 = 0.5;
/// Gray of the letterbox bands, as in training (114 / 255).
const GRAY: f64 = 114.0 / 255.0;

/// Where a model runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Device {
    /// DirectML on this graphics adapter (0 = the default one)
    DirectMl(i32),
    /// the CPU with this many threads
    Cpu(usize),
}

impl Device {
    pub fn name(self) -> &'static str {
        match self {
            Device::DirectMl(_) => "directml",
            Device::Cpu(_) => "cpu",
        }
    }
}

/// One person's pose: in pixels of the depth/infrared image as the hub sends it (mirrored), like
/// PoseModel.detect in persons-pose.js. Keypoints are COCO-17 as (u, v, confidence).
#[derive(Clone, Debug)]
pub struct Pose {
    pub score: f32,
    /// u0, v0, u1, v1
    pub bbox: [f32; 4],
    pub kp: [f32; 51],
}

/// How the 512x424 image sits in the model input: scaled to fit, gray bands around it. At 512x448
/// the scale is 1 and the bands are 12 rows above and below.
#[derive(Clone, Copy, Debug)]
pub struct Letterbox {
    pub in_w: usize,
    pub in_h: usize,
    scale: f64,
    w: usize,
    h: usize,
    pad_x: usize,
    pad_y: usize,
}

impl Letterbox {
    pub fn new(in_w: usize, in_h: usize) -> Letterbox {
        let scale = (in_w as f64 / W as f64).min(in_h as f64 / H as f64);
        let w = ((W as f64 * scale).round() as usize).min(in_w);
        let h = ((H as f64 * scale).round() as usize).min(in_h);
        Letterbox { in_w, in_h, scale, w, h, pad_x: (in_w - w) / 2, pad_y: (in_h - h) / 2 }
    }

    /// A point of the model input back to pixels of the (mirrored) depth image.
    fn to_image(self, x: f64, y: f64) -> (f64, f64) {
        ((W - 1) as f64 - (x - self.pad_x as f64) / self.scale, (y - self.pad_y as f64) / self.scale)
    }
}

/// The model input: gray bands, the image mirrored back (the model then sees people the right way
/// round and names their sides correctly), gray in all three channels, 0..1. At scale 1 the values
/// are exactly those of persons-pose.js; smaller inputs are scaled bilinearly like the training's
/// letterbox.
fn preprocess(ir: &[u8], x: &mut [f32], lut: &[f32; 256], lb: Letterbox) {
    let plane = lb.in_w * lb.in_h;
    x.fill(GRAY as f32);
    let (p0, rest) = x.split_at_mut(plane.min(x.len()));
    let rows = p0.chunks_exact_mut(lb.in_w).skip(lb.pad_y).take(lb.h);
    if lb.w == W && lb.h == H {
        for (dst, src) in rows.zip(ir.as_chunks::<W>().0) {
            for (d, s) in dst.iter_mut().skip(lb.pad_x).zip(src.iter().rev()) {
                *d = lut.get(usize::from(*s)).copied().unwrap_or(0.0);
            }
        }
    } else {
        // per output row/column: the two source rows/columns and the weight of the second
        let taps = |n: usize, len: usize| -> Vec<(usize, usize, f32)> {
            (0..n)
                .map(|i| {
                    let s = ((i as f64 + 0.5) / lb.scale - 0.5).clamp(0.0, (len - 1) as f64);
                    let i0 = s.floor() as usize;
                    (i0, (i0 + 1).min(len - 1), (s - i0 as f64) as f32)
                })
                .collect()
        };
        let cols = taps(lb.w, W);
        // mirrored back: input column c reads source column W - 1 - c
        let px = |row: &[u8], c: usize| f32::from(row.get(W - 1 - c).copied().unwrap_or(0));
        for (dst, (r0, r1, fy)) in rows.zip(taps(lb.h, H)) {
            let (Some(a), Some(b)) = (ir.get(r0 * W..(r0 + 1) * W), ir.get(r1 * W..(r1 + 1) * W)) else { continue };
            for (d, (c0, c1, fx)) in dst.iter_mut().skip(lb.pad_x).zip(&cols) {
                let top = px(a, *c0) * (1.0 - fx) + px(a, *c1) * fx;
                let bottom = px(b, *c0) * (1.0 - fx) + px(b, *c1) * fx;
                *d = (top * (1.0 - fy) + bottom * fy) / 255.0;
            }
        }
    }
    for p in rest.chunks_exact_mut(plane) {
        p.copy_from_slice(p0);
    }
}

fn iou(a: &[f64; 4], b: &[f64; 4]) -> f64 {
    let inter = (a[2].min(b[2]) - a[0].max(b[0])).max(0.0) * (a[3].min(b[3]) - a[1].max(b[1])).max(0.0);
    let area = |r: &[f64; 4]| (r[2] - r[0]).max(0.0) * (r[3] - r[1]).max(0.0);
    inter / (area(a) + area(b) - inter).max(1e-6)
}

/// Channel c of the output [1, C, A].
fn chan(data: &[f32], anchors: usize, c: usize) -> &[f32] {
    data.get(c * anchors..(c + 1) * anchors).unwrap_or(&[])
}

fn at(ch: &[f32], a: usize) -> f64 {
    f64::from(ch.get(a).copied().unwrap_or(0.0))
}

/// Output [1, C, A] (box cx, cy, w, h, score, 17 x (x, y, confidence)): candidates above MIN_SCORE,
/// greedy non-maximum suppression, at most 16, the most confident first, in image pixels. The
/// arithmetic follows persons-pose.js (doubles), so both give the same poses.
pub fn decode(data: &[f32], channels: usize, anchors: usize, lb: Letterbox) -> Vec<Pose> {
    let score = chan(data, anchors, 4);
    let mut cands: Vec<(usize, f64, [f64; 4])> = Vec::new();
    for (a, s) in score.iter().enumerate() {
        if *s < MIN_SCORE {
            continue;
        }
        let (cx, cy) = (at(chan(data, anchors, 0), a), at(chan(data, anchors, 1), a));
        let (w, h) = (at(chan(data, anchors, 2), a), at(chan(data, anchors, 3), a));
        cands.push((a, f64::from(*s), [cx - w / 2.0, cy - h / 2.0, cx + w / 2.0, cy + h / 2.0]));
    }
    cands.sort_by(|p, q| q.1.total_cmp(&p.1));
    let mut keep: Vec<(usize, f64, [f64; 4])> = Vec::new();
    for c in cands {
        if keep.iter().all(|k| iou(&k.2, &c.2) < NMS_IOU) {
            keep.push(c);
        }
        if keep.len() >= MAX_POSES {
            break;
        }
    }
    keep.into_iter()
        .map(|(a, score, b)| {
            let mut kp = [0.0_f32; 51];
            for (k, [u, v, conf]) in kp.as_chunks_mut::<3>().0.iter_mut().enumerate() {
                if 5 + 3 * k + 2 >= channels {
                    break;
                }
                let (x, y) = lb.to_image(at(chan(data, anchors, 5 + 3 * k), a), at(chan(data, anchors, 6 + 3 * k), a));
                (*u, *v) = (x as f32, y as f32);
                *conf = at(chan(data, anchors, 7 + 3 * k), a) as f32;
            }
            // mirrored: the right edge of the model's box is the left one in the image
            let ((u0, v0), (u1, v1)) = (lb.to_image(b[2], b[1]), lb.to_image(b[0], b[3]));
            Pose { score: score as f32, bbox: [u0 as f32, v0 as f32, u1 as f32, v1 as f32], kp }
        })
        .collect()
}

/// One loaded pose model, ready to run.
pub struct Model {
    session: Session,
    input: Tensor<f32>,
    input_name: String,
    output_name: String,
    lut: [f32; 256],
    pub lb: Letterbox,
    pub file: PathBuf,
}

impl Model {
    pub fn load(file: &Path, device: Device) -> Result<Model, String> {
        let err = |e: &dyn std::fmt::Display| format!("{}: {e}", file.display());
        let builder = Session::builder().map_err(|e| err(&e))?.with_optimization_level(GraphOptimizationLevel::Level3).map_err(|e| err(&e))?;
        let session = match device {
            // DirectML wants sequential execution and no memory pattern; the CPU part is small
            Device::DirectMl(adapter) => builder
                .with_parallel_execution(false)
                .map_err(|e| err(&e))?
                .with_memory_pattern(false)
                .map_err(|e| err(&e))?
                .with_intra_threads(1)
                .map_err(|e| err(&e))?
                .with_execution_providers([ep::DirectML::default().with_device_id(adapter).build().error_on_failure()])
                .map_err(|e| err(&e))?
                .commit_from_file(file)
                .map_err(|e| err(&e))?,
            Device::Cpu(threads) => builder
                .with_intra_threads(threads)
                .map_err(|e| err(&e))?
                .with_inter_threads(1)
                .map_err(|e| err(&e))?
                .with_intra_op_spinning(false)
                .map_err(|e| err(&e))?
                .commit_from_file(file)
                .map_err(|e| err(&e))?,
        };
        let input_name = session.inputs().first().map(|i| i.name().to_string()).ok_or("the model has no input")?;
        let output_name = session.outputs().first().map(|o| o.name().to_string()).ok_or("the model has no output")?;
        let dims: Vec<i64> =
            session.inputs().first().and_then(|i| i.dtype().tensor_shape()).map(|s| s.iter().copied().collect()).unwrap_or_default();
        let lb = match dims.as_slice() {
            [1, 3, h, w] if *h >= 32 && *w >= 32 && *h <= 2048 && *w <= 2048 => {
                Letterbox::new(usize::try_from(*w).map_err(|e| e.to_string())?, usize::try_from(*h).map_err(|e| e.to_string())?)
            }
            d => return Err(format!("{}: input {d:?}, expected 1x3xHxW", file.display())),
        };
        let input = Tensor::from_array(([1_usize, 3, lb.in_h, lb.in_w], vec![0.0_f32; 3 * lb.in_h * lb.in_w])).map_err(|e| err(&e))?;
        let mut lut = [0.0_f32; 256];
        for (i, v) in lut.iter_mut().enumerate() {
            *v = (i as f64 / 255.0) as f32; // as a Float32Array stores ir / 255
        }
        Ok(Model { session, input, input_name, output_name, lut, lb, file: file.to_path_buf() })
    }

    /// "512x448"
    pub fn size_name(&self) -> String {
        format!("{}x{}", self.lb.in_w, self.lb.in_h)
    }

    /// The poses in one infrared frame (512x424 bytes, as the `ir` stream).
    pub fn run(&mut self, ir: &[u8]) -> Result<Vec<Pose>, String> {
        if ir.len() != PIXELS {
            return Err(format!("infrared frame of {} bytes", ir.len()));
        }
        let (_, x) = self.input.extract_tensor_mut();
        preprocess(ir, x, &self.lut, self.lb);
        let outputs = self.session.run(ort::inputs![self.input_name.as_str() => &self.input]).map_err(|e| e.to_string())?;
        let out = outputs.get(self.output_name.as_str()).ok_or("the model gave no output")?;
        let (shape, data) = out.try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        let dims: Vec<i64> = shape.iter().copied().collect();
        match dims.as_slice() {
            [1, c, a] if *c >= 5 => {
                let channels = usize::try_from(*c).map_err(|e| e.to_string())?;
                let anchors = usize::try_from(*a).map_err(|e| e.to_string())?;
                Ok(decode(data, channels, anchors, self.lb))
            }
            d => Err(format!("unexpected output {d:?}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letterbox_full_size_is_the_browsers() {
        let lb = Letterbox::new(512, 448);
        assert_eq!((lb.w, lb.h, lb.pad_x, lb.pad_y), (512, 424, 0, 12));
        let (u, v) = lb.to_image(0.0, 12.0);
        assert!((u - 511.0).abs() < 1e-9 && v.abs() < 1e-9);
    }

    #[test]
    fn letterbox_small_keeps_the_aspect() {
        let lb = Letterbox::new(384, 320);
        assert_eq!((lb.w, lb.h, lb.pad_x, lb.pad_y), (384, 318, 0, 1));
    }

    #[test]
    fn preprocess_mirrors_and_pads() {
        let lb = Letterbox::new(512, 448);
        let mut ir = vec![0_u8; PIXELS];
        if let Some(p) = ir.get_mut(W - 1) {
            *p = 255; // top right pixel of the mirrored image
        }
        let mut x = vec![0.0_f32; 3 * 512 * 448];
        let mut lut = [0.0_f32; 256];
        for (i, v) in lut.iter_mut().enumerate() {
            *v = i as f32 / 255.0;
        }
        preprocess(&ir, &mut x, &lut, lb);
        let row12 = 12 * 512;
        assert_eq!(x.get(row12).copied(), Some(1.0)); // shows up top left, below the band
        assert_eq!(x.first().copied(), Some(GRAY as f32));
        assert_eq!(x.get(512 * 448 + row12).copied(), Some(1.0)); // in every channel
    }

    #[test]
    fn decode_keeps_the_best_of_overlapping_boxes() {
        let lb = Letterbox::new(512, 448);
        let (channels, anchors) = (56, 3);
        let mut data = vec![0.0_f32; channels * anchors];
        let mut set = |c: usize, a: usize, v: f32| {
            if let Some(x) = data.get_mut(c * anchors + a) {
                *x = v;
            }
        };
        for (a, (cx, score)) in [(100.0, 0.9), (102.0, 0.8), (400.0, 0.2)].into_iter().enumerate() {
            set(0, a, cx);
            set(1, a, 224.0);
            set(2, a, 50.0);
            set(3, a, 200.0);
            set(4, a, score);
        }
        let poses = decode(&data, channels, anchors, lb);
        assert_eq!(poses.len(), 1);
        let p = poses.first().map(|p| (p.score, p.bbox)).unwrap_or_default();
        assert!((p.0 - 0.9).abs() < 1e-6);
        assert!((p.1[0] - (511.0 - 125.0)).abs() < 1e-4 && (p.1[1] - 112.0).abs() < 1e-4);
    }
}
