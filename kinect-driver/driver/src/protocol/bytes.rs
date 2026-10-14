//! Little-endian reads that never panic.

/// u16 at `at`, if the slice is long enough.
pub fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    let s = b.get(at..at.checked_add(2)?)?;
    Some(u16::from_le_bytes([*s.first()?, *s.get(1)?]))
}

/// u32 at `at`, if the slice is long enough.
pub fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    let s = b.get(at..at.checked_add(4)?)?;
    let a: [u8; 4] = s.try_into().ok()?;
    Some(u32::from_le_bytes(a))
}

/// f32 at `at`, if the slice is long enough.
pub fn f32_at(b: &[u8], at: usize) -> Option<f32> {
    u32_at(b, at).map(f32::from_bits)
}

/// u64 at `at`, if the slice is long enough.
pub fn u64_at(b: &[u8], at: usize) -> Option<u64> {
    let s = b.get(at..at.checked_add(8)?)?;
    let a: [u8; 8] = s.try_into().ok()?;
    Some(u64::from_le_bytes(a))
}

/// Appends little-endian values.
pub trait PutLe {
    /// appends a u16
    fn put_u16(&mut self, v: u16);
    /// appends a u32
    fn put_u32(&mut self, v: u32);
    /// appends an f32
    fn put_f32(&mut self, v: f32);
    /// appends a u64
    fn put_u64(&mut self, v: u64);
}

impl PutLe for Vec<u8> {
    fn put_u16(&mut self, v: u16) {
        self.extend_from_slice(&v.to_le_bytes());
    }
    fn put_u32(&mut self, v: u32) {
        self.extend_from_slice(&v.to_le_bytes());
    }
    fn put_f32(&mut self, v: f32) {
        self.extend_from_slice(&v.to_le_bytes());
    }
    fn put_u64(&mut self, v: u64) {
        self.extend_from_slice(&v.to_le_bytes());
    }
}
