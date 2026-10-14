//! Runs the rows of an image on a few threads: the work is cut into blocks (each owning its
//! slices of the output buffers), the threads take blocks until none are left. Safe Rust only
//! (scoped threads); a panic in one block is caught, the other blocks still finish, and the
//! error is returned.

use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::error::{Error, Result, panic_message};

/// How many threads to use for `requested` (0 = automatic: up to 4, leaving cores to others).
pub fn thread_count(requested: usize) -> usize {
    if requested > 0 {
        return requested.min(64);
    }
    let cores = std::thread::available_parallelism().map(usize::from).unwrap_or(1);
    cores.saturating_sub(1).clamp(1, 4)
}

/// Processes every block with `f` on up to `threads` threads (the caller is one of them).
pub fn for_each_block<B: Send>(threads: usize, blocks: Vec<B>, f: &(dyn Fn(B) + Sync)) -> Result<()> {
    let n = blocks.len();
    if n == 0 {
        return Ok(());
    }
    let threads = threads.clamp(1, n);
    let first_error: Mutex<Option<String>> = Mutex::new(None);
    let run_one = |b: B| {
        if let Err(p) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(b))) {
            let mut e = first_error.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            e.get_or_insert_with(|| panic_message(p.as_ref()));
        }
    };
    if threads == 1 {
        for b in blocks {
            run_one(b);
        }
    } else {
        let queue: Vec<Mutex<Option<B>>> = blocks.into_iter().map(|b| Mutex::new(Some(b))).collect();
        let next = AtomicUsize::new(0);
        let work = || {
            loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(slot) = queue.get(i) else { break };
                let b = slot.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
                if let Some(b) = b {
                    run_one(b);
                }
            }
        };
        let spawned = std::thread::scope(|s| {
            let mut handles = Vec::with_capacity(threads - 1);
            for _ in 1..threads {
                match std::thread::Builder::new().name("kinect-tof".into()).spawn_scoped(s, work) {
                    Ok(h) => handles.push(h),
                    Err(_) => break, // fewer threads, the caller does the rest
                }
            }
            work();
            handles.into_iter().all(|h| h.join().is_ok())
        });
        if !spawned {
            let mut e = first_error.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            e.get_or_insert_with(|| "a decoder thread failed".to_string());
        }
    }
    match first_error.into_inner().unwrap_or_else(std::sync::PoisonError::into_inner) {
        None => Ok(()),
        Some(m) => Err(Error::Panic(m)),
    }
}

/// Splits `buf` (rows of `width`) into blocks of `rows_per_block` rows: (first row, slice).
pub fn row_blocks<T>(buf: &mut [T], width: usize, rows_per_block: usize) -> Vec<(usize, &mut [T])> {
    let step = width * rows_per_block.max(1);
    buf.chunks_mut(step.max(1)).enumerate().map(|(i, c)| (i * rows_per_block.max(1), c)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_blocks_run_once() {
        let mut data = vec![0u32; 1000];
        let blocks = row_blocks(&mut data, 10, 3);
        for_each_block(4, blocks, &|(row, chunk): (usize, &mut [u32])| {
            for v in chunk.iter_mut() {
                *v += row as u32 + 1;
            }
        })
        .unwrap();
        for (i, v) in data.iter().enumerate() {
            assert_eq!(*v, (i / 30 * 3) as u32 + 1);
        }
    }

    #[test]
    fn a_panic_is_reported_and_the_rest_finishes() {
        let mut data = vec![0u8; 100];
        let blocks = row_blocks(&mut data, 10, 1);
        let r = for_each_block(3, blocks, &|(row, chunk): (usize, &mut [u8])| {
            if row == 5 {
                panic!("boom");
            }
            chunk.fill(1);
        });
        assert_eq!(r, Err(Error::Panic("boom".into())));
        assert_eq!(data.iter().filter(|v| **v == 1).count(), 90);
    }
}
