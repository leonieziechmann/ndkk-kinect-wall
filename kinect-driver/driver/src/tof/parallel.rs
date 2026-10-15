//! Runs the rows of an image on a few threads: the work is cut into blocks (each owning its
//! slices of the output buffers), the threads take blocks until none are left. A panic in one
//! block is caught, the other blocks still finish, and the error is returned.
//!
//! The threads ([`Workers`]) stay for the whole life of a decoder and sleep between phases:
//! starting threads for every phase (four per frame) costs more than many of the phases take.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;

use crate::error::{Error, Result, panic_message};

/// How many threads to use for `requested` (0 = automatic: up to 4, leaving cores to others).
pub fn thread_count(requested: usize) -> usize {
    if requested > 0 {
        return requested.min(64);
    }
    let cores = std::thread::available_parallelism().map(usize::from).unwrap_or(1);
    cores.saturating_sub(1).clamp(1, 4)
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The job of a round: the caller's closure with its lifetime erased. It is only called while the
/// caller of [`Workers::run`] waits, see there.
#[derive(Clone, Copy)]
struct Job(*const (dyn Fn() + Sync + 'static));

// SAFETY: the pointer refers to a `Sync` closure, which may be called from any thread; when it
// may be called at all is up to `Workers::run`.
#[allow(unsafe_code)]
unsafe impl Send for Job {}

struct State {
    /// counts the rounds (one per `run`)
    round: u64,
    /// the job of the current round; `None` once the caller closed it
    job: Option<Job>,
    /// workers inside the job
    busy: usize,
    quit: bool,
}

struct Shared {
    state: Mutex<State>,
    start: Condvar,
    done: Condvar,
    /// panics caught outside any block (should never happen)
    panics: AtomicU64,
}

/// Helper threads of a decoder: they wait for work, the calling thread works along.
pub struct Workers {
    shared: Arc<Shared>,
    threads: Vec<JoinHandle<()>>,
}

impl Workers {
    /// `threads` in total (the caller is one of them: `threads - 1` are started). If the system
    /// refuses to start some, fewer do the work.
    pub fn new(threads: usize) -> Workers {
        let shared = Arc::new(Shared { state: Mutex::new(State { round: 0, job: None, busy: 0, quit: false }), start: Condvar::new(), done: Condvar::new(), panics: AtomicU64::new(0) });
        let mut handles = Vec::new();
        for _ in 1..threads.max(1) {
            let s = shared.clone();
            match std::thread::Builder::new().name("kinect-tof".into()).spawn(move || worker(&s)) {
                Ok(h) => handles.push(h),
                Err(e) => {
                    log::warn!("kinect-driver: cannot start a decoder thread ({e}); fewer threads");
                    break;
                }
            }
        }
        Workers { shared, threads: handles }
    }

    /// Threads that work on a round, the caller included.
    pub fn threads(&self) -> usize {
        self.threads.len() + 1
    }

    /// Calls `f` on every thread at once (each call takes work until none is left); returns when
    /// every call has returned.
    fn run(&self, f: &(dyn Fn() + Sync)) {
        if self.threads.is_empty() {
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err() {
                self.shared.panics.fetch_add(1, Ordering::Relaxed);
            }
            return;
        }
        // SAFETY: only the lifetime is erased (same layout). The pointer is published under the
        // lock and taken back under the lock below, before this function returns: a worker
        // can only start calling it while `job` is set, and counts itself in `busy` while it
        // does; we wait for `busy` to reach 0 after clearing `job`. Nothing in between can
        // unwind out of here (the own call is caught, the locks ignore poisoning).
        #[allow(unsafe_code)]
        let job = Job(unsafe { std::mem::transmute::<&(dyn Fn() + Sync + '_), &(dyn Fn() + Sync + 'static)>(f) });
        {
            let mut s = lock(&self.shared.state);
            s.round = s.round.wrapping_add(1);
            s.job = Some(job);
        }
        self.shared.start.notify_all();
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err() {
            self.shared.panics.fetch_add(1, Ordering::Relaxed);
        }
        // everything is taken: close the round (workers that wake up only now skip it) and wait
        // for those still inside
        let mut s = lock(&self.shared.state);
        s.job = None;
        while s.busy > 0 {
            s = self.shared.done.wait(s).unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// Processes every item with `f` on all threads (each item once, taken in order). A panic
    /// in `f` is caught: the other items are still processed, the first panic is the error.
    pub fn for_each<I, B>(&self, items: I, f: &(dyn Fn(B) + Sync)) -> Result<()>
    where
        I: Iterator<Item = B> + Send,
    {
        // (a Vec of zero-sized values never allocates)
        let mut none = vec![(); self.threads()];
        self.for_each_with(&mut none, items, &|_, b| f(b))
    }

    /// [`Workers::for_each`] with a scratch per thread: each thread that takes part gets one
    /// element of `scratch` for all its items (a thread without one, if there are fewer than
    /// [`Workers::threads`], leaves the items to the others).
    pub fn for_each_with<S, I, B>(&self, scratch: &mut [S], items: I, f: &(dyn Fn(&mut S, B) + Sync)) -> Result<()>
    where
        S: Send,
        I: Iterator<Item = B> + Send,
    {
        let slots = Mutex::new(scratch.iter_mut());
        let items = Mutex::new(items);
        let first_error: Mutex<Option<String>> = Mutex::new(None);
        let work = || {
            let Some(s) = lock(&slots).next() else { return };
            loop {
                // the lock only while taking the next item
                let next = lock(&items).next();
                let Some(b) = next else { break };
                if let Err(p) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&mut *s, b))) {
                    lock(&first_error).get_or_insert_with(|| panic_message(p.as_ref()));
                }
            }
        };
        let before = self.shared.panics.load(Ordering::Relaxed);
        self.run(&work);
        if let Some(m) = first_error.into_inner().unwrap_or_else(PoisonError::into_inner) {
            return Err(Error::Panic(m));
        }
        if self.shared.panics.load(Ordering::Relaxed) != before {
            return Err(Error::Panic("a decoder thread failed".into()));
        }
        Ok(())
    }
}

impl Drop for Workers {
    fn drop(&mut self) {
        lock(&self.shared.state).quit = true;
        self.shared.start.notify_all();
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
    }
}

fn worker(shared: &Shared) {
    let mut seen = 0u64;
    loop {
        let job = {
            let mut s = lock(&shared.state);
            loop {
                if s.quit {
                    return;
                }
                if s.round != seen {
                    seen = s.round;
                    if let Some(job) = s.job {
                        s.busy += 1;
                        break job;
                    }
                    // closed before this thread woke up: nothing left to do
                    continue;
                }
                s = shared.start.wait(s).unwrap_or_else(PoisonError::into_inner);
            }
        };
        // SAFETY: `job` is valid while this thread is counted in `busy` (see `Workers::run`).
        #[allow(unsafe_code)]
        let call = || unsafe { (*job.0)() };
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(call)).is_err() {
            shared.panics.fetch_add(1, Ordering::Relaxed);
        }
        let mut s = lock(&shared.state);
        s.busy = s.busy.saturating_sub(1);
        if s.busy == 0 {
            shared.done.notify_all();
        }
    }
}

/// Splits `buf` (rows of `width`) into blocks of `rows_per_block` rows: (first row, slice).
pub fn row_blocks<T>(buf: &mut [T], width: usize, rows_per_block: usize) -> impl Iterator<Item = (usize, &mut [T])> + Send
where
    T: Send,
{
    let step = width * rows_per_block.max(1);
    buf.chunks_mut(step.max(1)).enumerate().map(move |(i, c)| (i * rows_per_block.max(1), c))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_blocks_run_once() {
        let workers = Workers::new(4);
        let mut data = vec![0u32; 1000];
        for _ in 0..3 {
            let blocks = row_blocks(&mut data, 10, 3);
            workers
                .for_each(blocks, &|(row, chunk): (usize, &mut [u32])| {
                    for v in chunk.iter_mut() {
                        *v += row as u32 + 1;
                    }
                })
                .unwrap();
        }
        for (i, v) in data.iter().enumerate() {
            assert_eq!(*v, 3 * ((i / 30 * 3) as u32 + 1));
        }
    }

    #[test]
    fn a_panic_is_reported_and_the_rest_finishes() {
        let workers = Workers::new(3);
        let mut data = vec![0u8; 100];
        let blocks = row_blocks(&mut data, 10, 1);
        let r = workers.for_each(blocks, &|(row, chunk): (usize, &mut [u8])| {
            if row == 5 {
                panic!("boom");
            }
            chunk.fill(1);
        });
        assert_eq!(r, Err(Error::Panic("boom".into())));
        assert_eq!(data.iter().filter(|v| **v == 1).count(), 90);
        // and the threads still work afterwards
        let blocks = row_blocks(&mut data, 10, 1);
        workers.for_each(blocks, &|(_, chunk): (usize, &mut [u8])| chunk.fill(2)).unwrap();
        assert!(data.iter().all(|v| *v == 2));
    }

    #[test]
    fn many_short_rounds_and_borrowed_data() {
        let workers = Workers::new(4);
        assert_eq!(workers.threads(), 4);
        let total = AtomicU64::new(0);
        for round in 0..2000u64 {
            let local = [round; 7];
            workers
                .for_each(local.iter(), &|v: &u64| {
                    total.fetch_add(*v, Ordering::Relaxed);
                })
                .unwrap();
        }
        assert_eq!(total.load(Ordering::Relaxed), 7 * (0..2000u64).sum::<u64>());
    }

    #[test]
    fn one_thread_works_alone() {
        let workers = Workers::new(1);
        assert_eq!(workers.threads(), 1);
        let mut data = vec![0u8; 20];
        workers.for_each(row_blocks(&mut data, 4, 1), &|(_, c): (usize, &mut [u8])| c.fill(9)).unwrap();
        assert!(data.iter().all(|v| *v == 9));
    }
}
