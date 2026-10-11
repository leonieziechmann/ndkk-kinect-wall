//! The background painter: the browser painted the wood, the cards and the heap's shape in frame()
//! whenever their layout changed (a hitch); here a thread per scene instance does it and frame()
//! only uploads the result. The setup paints everything once itself.

use std::mem::discriminant;
use std::sync::mpsc::{Receiver, Sender, channel};

use super::cards::{self, Cards, CardsSpec};
use super::forest::{self, Forest};
use super::heap::{self, HeapShape, HeapSpec};
use super::layout::{Layout, Post};

/// What the wood depends on (forest.js key: size, canopy, ground, the signs' boxes, the signpost).
#[derive(Clone, PartialEq)]
pub struct ForestKey {
    w: f64,
    h: f64,
    canopy: f64,
    ground: f64,
    signs: Vec<[f64; 4]>,
    post: Post,
}

impl ForestKey {
    pub fn new(l: &Layout) -> Self {
        Self { w: l.w, h: l.h, canopy: l.canopy, ground: l.ground, signs: l.signs.iter().map(|g| [g.x, g.y, g.w, g.h]).collect(), post: l.post }
    }

    /// does it still describe this layout? (no allocation)
    pub fn is(&self, l: &Layout) -> bool {
        self.w == l.w
            && self.h == l.h
            && self.canopy == l.canopy
            && self.ground == l.ground
            && self.post == l.post
            && self.signs.len() == l.signs.len()
            && self.signs.iter().zip(&l.signs).all(|(a, g)| *a == [g.x, g.y, g.w, g.h])
    }
}

pub enum Job {
    Forest(Box<Layout>),
    Cards(Box<CardsSpec>),
    Heap(Box<HeapSpec>),
}

pub enum Done {
    Forest(Box<Forest>),
    Cards(Box<Cards>),
    Heap(Box<HeapShape>),
}

fn run(job: Job) -> Done {
    match job {
        Job::Forest(l) => Done::Forest(Box::new(forest::paint(&l))),
        Job::Cards(s) => Done::Cards(Box::new(cards::paint(&s))),
        Job::Heap(s) => Done::Heap(Box::new(heap::shape(&s))),
    }
}

/// A thread per scene instance that paints what changed (it ends with the instance).
pub struct Painter {
    jobs: Sender<Job>,
    done: Receiver<Done>,
}

impl Painter {
    pub fn new(name: &str) -> Result<Self, String> {
        let (jobs, rx) = channel::<Job>();
        let (tx, done) = channel::<Done>();
        std::thread::Builder::new()
            .name(format!("{name} paint"))
            .spawn(move || {
                while let Ok(first) = rx.recv() {
                    // only the newest job of each kind (a glide asks for many)
                    let mut list = vec![first];
                    while let Ok(j) = rx.try_recv() {
                        list.retain(|k| discriminant(k) != discriminant(&j));
                        list.push(j);
                    }
                    for j in list {
                        if tx.send(run(j)).is_err() {
                            return;
                        }
                    }
                }
            })
            .map_err(|e| format!("Mal-Thread: {e}"))?;
        Ok(Self { jobs, done })
    }

    pub fn ask(&self, job: Job) {
        let _ = self.jobs.send(job);
    }

    pub fn poll(&self) -> Option<Done> {
        self.done.try_recv().ok()
    }
}
