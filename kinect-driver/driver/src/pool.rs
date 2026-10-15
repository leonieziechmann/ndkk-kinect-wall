//! Buffers that go round instead of being allocated for every frame.
//!
//! A frame's big buffers (the raw packet, 3 MB; the decoded planes, 3.5 MB) live for an
//! unknown time: in a queue, in the application, in a stage that keeps the raw packet. So they
//! are not taken from a fixed ring (a slow reader would block the sensor or have its frame
//! overwritten) but from a [`Pool`]: whoever drops a frame puts its buffers back, the next frame
//! takes them out again. In steady operation the same few buffers circulate and nothing is
//! allocated; if more are out than usual (the application holds frames), new ones are made, and
//! the pool keeps at most `keep` of them once they come back.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

/// Counters of a pool.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PoolStats {
    /// buffers made because the pool was empty
    pub made: u64,
    /// buffers taken from the pool
    pub reused: u64,
    /// buffers waiting in the pool now
    pub free: usize,
}

struct Inner<T> {
    free: Mutex<Vec<T>>,
    keep: usize,
    made: AtomicU64,
    reused: AtomicU64,
}

/// A pool of reusable buffers (cheap to clone: all clones share the same buffers).
pub struct Pool<T> {
    inner: Arc<Inner<T>>,
}

impl<T> Clone for Pool<T> {
    fn clone(&self) -> Self {
        Pool { inner: self.inner.clone() }
    }
}

impl<T> std::fmt::Debug for Pool<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = self.stats();
        write!(f, "Pool {{ made: {}, reused: {}, free: {} }}", s.made, s.reused, s.free)
    }
}

impl<T> Pool<T> {
    /// A pool that keeps up to `keep` buffers.
    pub fn new(keep: usize) -> Pool<T> {
        // the list never grows past `keep`: no allocation when buffers come back
        Pool { inner: Arc::new(Inner { free: Mutex::new(Vec::with_capacity(keep)), keep, made: AtomicU64::new(0), reused: AtomicU64::new(0) }) }
    }

    fn free(&self) -> std::sync::MutexGuard<'_, Vec<T>> {
        self.inner.free.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A buffer from the pool, or a new one from `make`.
    pub fn take_or(&self, make: impl FnOnce() -> T) -> T {
        let got = self.free().pop();
        match got {
            Some(b) => {
                self.inner.reused.fetch_add(1, Ordering::Relaxed);
                b
            }
            None => {
                self.inner.made.fetch_add(1, Ordering::Relaxed);
                make()
            }
        }
    }

    /// Gives a buffer back (dropped if the pool is full).
    pub fn put(&self, b: T) {
        let mut free = self.free();
        if free.len() < self.inner.keep {
            free.push(b);
        }
    }

    /// Counters.
    pub fn stats(&self) -> PoolStats {
        PoolStats { made: self.inner.made.load(Ordering::Relaxed), reused: self.inner.reused.load(Ordering::Relaxed), free: self.free().len() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buffers_go_round_and_the_pool_stays_bounded() {
        let pool: Pool<Vec<u8>> = Pool::new(2);
        let a = pool.take_or(|| vec![1; 10]);
        let b = pool.take_or(|| vec![2; 10]);
        let c = pool.take_or(|| vec![3; 10]);
        pool.put(a);
        pool.put(b);
        pool.put(c); // full: dropped
        assert_eq!(pool.stats(), PoolStats { made: 3, reused: 0, free: 2 });
        let d = pool.take_or(Vec::new);
        assert_eq!(d.len(), 10, "a reused buffer, not a new one");
        assert_eq!(pool.stats().reused, 1);
        let p2 = pool.clone();
        p2.put(d);
        assert_eq!(pool.stats().free, 2);
    }
}
