//! The planes of a frame with 16 bits per value: depth, infrared and confidence take half the
//! memory of `f32`, in the formats of the decoders' own intermediate planes (`tof/pack.rs`).
//!
//! - [`Depth`]: millimeters in steps of 0.5 mm (0 = no depth, up to 32767.5 mm). The decoders
//!   work out the depth in these steps anyway, so nothing is lost by storing it.
//! - [`Infrared`]: binary16 of the value / 32: 11 significant bits (0.05 %), up to 2.1 million.
//! - [`Confidence`]: 0..1 in steps of 1/65535.
//!
//! Read values with [`Plane::get`] or [`Plane::iter`], whole rows with [`Plane::unpack_row`]
//! (vectorized); [`Plane::raw`] gives the 16-bit values themselves.
//!
//! ```
//! use kinect_driver::plane::{Depth, Plane};
//!
//! let mut depth: Plane<Depth> = Plane::zeroed(4);
//! depth.set(1, 1234.3);
//! assert_eq!(depth.get(1), Some(1234.5));
//! assert_eq!(depth.iter().filter(|d| *d > 0.0).count(), 1);
//! ```

use std::marker::PhantomData;

use crate::consts::WIDTH;
use crate::tof::pack::{self, Codec, formats};

/// What a [`Plane`] holds: how its 16-bit values are read and written.
pub trait Format {
    /// the encoding
    const CODEC: Codec;
    /// for `Debug`
    const NAME: &'static str;
}

/// Depth in mm (z, not the distance along the ray): steps of 0.5 mm, 0 = no depth.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Depth;

impl Format for Depth {
    const CODEC: Codec = formats::DEPTH;
    const NAME: &'static str = "depth";
}

/// Infrared amplitude in libfreenect2's scale: binary16 of the value / 32 (11 significant bits;
/// libfreenect2's white, 65535, reads back as 65536).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Infrared;

impl Format for Infrared {
    const CODEC: Codec = formats::IR;
    const NAME: &'static str = "infrared";
}

/// Confidence 0..1 in steps of 1/65535.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Confidence;

impl Format for Confidence {
    const CODEC: Codec = formats::CONFIDENCE;
    const NAME: &'static str = "confidence";
}

/// An image plane, 16 bits per value in the format `F` (row-major, `WIDTH` values per row when
/// it is a whole image).
pub struct Plane<F> {
    data: Vec<u16>,
    format: PhantomData<fn() -> F>,
}

impl<F> Clone for Plane<F> {
    fn clone(&self) -> Self {
        Plane { data: self.data.clone(), format: PhantomData }
    }

    fn clone_from(&mut self, source: &Self) {
        self.data.clone_from(&source.data);
    }
}

impl<F> Default for Plane<F> {
    fn default() -> Self {
        Plane { data: Vec::new(), format: PhantomData }
    }
}

impl<F> PartialEq for Plane<F> {
    fn eq(&self, other: &Self) -> bool {
        self.data == other.data
    }
}

impl<F> Eq for Plane<F> {}

impl<F: Format> std::fmt::Debug for Plane<F> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Plane<{}>({} values)", F::NAME, self.data.len())
    }
}

impl<F: Format> Plane<F> {
    /// An empty plane.
    pub const fn new() -> Self {
        Plane { data: Vec::new(), format: PhantomData }
    }

    /// `len` values of 0.
    pub fn zeroed(len: usize) -> Self {
        Plane { data: vec![0; len], format: PhantomData }
    }

    /// The values `values`, packed.
    pub fn from_values(values: &[f32]) -> Self {
        let mut p = Plane::zeroed(values.len());
        pack::pack_row(F::CODEC, values, &mut p.data);
        p
    }

    /// A plane of stored 16-bit values.
    pub fn from_raw(data: Vec<u16>) -> Self {
        Plane { data, format: PhantomData }
    }

    /// The stored 16-bit values.
    pub fn into_raw(self) -> Vec<u16> {
        self.data
    }

    /// Number of values.
    pub fn len(&self) -> usize {
        self.data.len()
    }

    /// True if it has no values.
    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    /// Removes every value (keeps the memory).
    pub fn clear(&mut self) {
        self.data.clear();
    }

    /// Keeps the first `len` values.
    pub fn truncate(&mut self, len: usize) {
        self.data.truncate(len);
    }

    /// `len` values; new ones are 0.
    pub fn resize(&mut self, len: usize) {
        self.data.resize(len, 0);
    }

    /// Sets every value to 0.
    pub fn zero(&mut self) {
        self.data.fill(0);
    }

    /// The value at `i`.
    pub fn get(&self, i: usize) -> Option<f32> {
        self.data.get(i).map(|q| pack::unpack(F::CODEC, *q))
    }

    /// Sets the value at `i` (rounded to the format's steps; outside the plane: nothing).
    pub fn set(&mut self, i: usize, v: f32) {
        if let Some(q) = self.data.get_mut(i) {
            *q = pack::pack(F::CODEC, v);
        }
    }

    /// Every value in order.
    pub fn iter(&self) -> impl ExactSizeIterator<Item = f32> + DoubleEndedIterator + '_ {
        self.data.iter().map(|q| pack::unpack(F::CODEC, *q))
    }

    /// The stored 16-bit values.
    pub fn raw(&self) -> &[u16] {
        &self.data
    }

    /// The stored 16-bit values, to change.
    pub fn raw_mut(&mut self) -> &mut [u16] {
        &mut self.data
    }

    /// All values as `f32` (a new vector; [`Plane::unpack_into`] reuses one).
    pub fn to_vec(&self) -> Vec<f32> {
        let mut v = Vec::new();
        self.unpack_into(&mut v);
        v
    }

    /// All values into `out` (resized to the plane).
    pub fn unpack_into(&self, out: &mut Vec<f32>) {
        out.resize(self.data.len(), 0.0);
        pack::unpack_row(F::CODEC, &self.data, out);
    }

    /// The values `start..start + out.len()` into `out` (as many as there are).
    pub fn unpack_slice(&self, start: usize, out: &mut [f32]) {
        if let Some(src) = self.data.get(start..) {
            pack::unpack_row(F::CODEC, src, out);
        }
    }

    /// Packs `values` into the values from `start` on (as many as fit).
    pub fn pack_slice(&mut self, start: usize, values: &[f32]) {
        if let Some(dst) = self.data.get_mut(start..) {
            pack::pack_row(F::CODEC, values, dst);
        }
    }

    /// The stored values of row `y` (a whole image: `WIDTH` per row).
    pub fn row(&self, y: usize) -> Option<&[u16]> {
        self.data.get(y * WIDTH..(y + 1) * WIDTH)
    }

    /// Row `y` into `out` (`WIDTH` values); false if the plane has no such row.
    pub fn unpack_row(&self, y: usize, out: &mut [f32]) -> bool {
        match self.row(y) {
            Some(src) => {
                pack::unpack_row(F::CODEC, src, out);
                true
            }
            None => false,
        }
    }

    /// Packs `values` (`WIDTH`) into row `y`; false if the plane has no such row.
    pub fn pack_row(&mut self, y: usize, values: &[f32]) -> bool {
        match self.data.get_mut(y * WIDTH..(y + 1) * WIDTH) {
            Some(dst) => {
                pack::pack_row(F::CODEC, values, dst);
                true
            }
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_round_to_the_format() {
        let mut d: Plane<Depth> = Plane::zeroed(3);
        d.set(0, 1234.3);
        d.set(1, -5.0);
        d.set(7, 1.0);
        assert_eq!(d.to_vec(), vec![1234.5, 0.0, 0.0]);
        assert_eq!(d.raw(), &[2469, 0, 0]);
        let ir: Plane<Infrared> = Plane::from_values(&[0.0, 1.5, 65535.0, 1e6]);
        let v = ir.to_vec();
        assert_eq!(&v[..3], &[0.0, 1.5, 65536.0]);
        assert!((v[3] - 1e6).abs() < 1e6 / 2048.0);
        let c: Plane<Confidence> = Plane::from_values(&[0.0, 0.5, 1.0, 2.0]);
        assert_eq!(c.get(2), Some(1.0));
        assert_eq!(c.get(3), Some(1.0));
        assert!((c.get(1).unwrap() - 0.5).abs() < 1e-5);
        assert_eq!(c.get(4), None);
    }

    #[test]
    fn rows_and_slices() {
        let mut d: Plane<Depth> = Plane::zeroed(2 * WIDTH);
        let row: Vec<f32> = (0..WIDTH).map(|x| x as f32 * 10.0).collect();
        assert!(d.pack_row(1, &row));
        assert!(!d.pack_row(2, &row));
        let mut back = vec![0.0; WIDTH];
        assert!(d.unpack_row(1, &mut back));
        assert_eq!(back, row);
        assert!(d.unpack_row(0, &mut back));
        assert!(back.iter().all(|v| *v == 0.0));
        let mut part = [0.0; 3];
        d.unpack_slice(WIDTH + 2, &mut part);
        assert_eq!(part, [20.0, 30.0, 40.0]);
        assert_eq!(format!("{d:?}"), "Plane<depth>(1024 values)");
    }
}
