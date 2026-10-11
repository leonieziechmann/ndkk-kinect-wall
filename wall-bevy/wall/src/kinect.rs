//! What the scenes see as ctx.kinect (port of web/lib/kinect-data.js and the hub half of
//! persons.js PersonStream): the newest frames, flags for new data, the persons, and how their
//! results are played out.
//!
//! Play-out: the browser showed a delayed result when `arrival + delay` had passed, so the network
//! jitter of the arrivals went straight into the motion. Here every result is due at its sensor
//! time (capture_time_us on this machine's clock) plus the delay, and the decision which display
//! frame shows it is phase-locked to the display: the boundary between "this frame" and "the next
//! one" sits half a display frame away from where the results usually fall. A steady 30 Hz sensor
//! on a 60 Hz display then gives every result exactly two frames, with no doubled or skipped one.

use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;

use crate::hub::{DepthFrame, HubClient, HubCommand, HubEvent, HubStatus, IrFrame, PersonsKind, mono_ms, mono_of_system_us};
use crate::persons::{PersonOptions, PersonsResult, PersonsView, ViewMode};

#[derive(Clone, Copy, Debug, Default)]
pub struct Fresh {
    pub depth: bool,
    pub ir: bool,
    pub meta: bool,
    pub lut: bool,
    pub persons: bool,
}

#[derive(Default)]
struct Held {
    depth: Option<Arc<DepthFrame>>,
    ir: Option<Arc<IrFrame>>,
}

const HISTORY: usize = 90;

/// The phase lock of the play-out (see the top of this file).
struct PhaseLock {
    /// circular mean of (frame time - due time) as a unit vector, per display interval
    c: f64,
    s: f64,
    /// ms a result may be shown before it is due (0 .. interval)
    lead: f64,
    n: u32,
}

impl PhaseLock {
    fn new() -> Self {
        Self { c: 0.0, s: 0.0, lead: 0.0, n: 0 }
    }

    /// Notes when a result was shown (`late`: frame time - due time) and moves the decision
    /// boundary away from where the results fall, if it came close.
    fn shown(&mut self, late: f64, interval: f64) {
        if !(interval > 1.0) || !late.is_finite() {
            return;
        }
        let a = late.rem_euclid(interval) / interval * std::f64::consts::TAU;
        let k = if self.n < 10 { 0.3 } else { 0.05 };
        self.c += k * (a.cos() - self.c);
        self.s += k * (a.sin() - self.s);
        self.n = self.n.saturating_add(1);
        if self.n < 6 || self.c.hypot(self.s) < 0.3 {
            return; // no clear phase (jitter as large as the frame): leave it
        }
        let mean = self.s.atan2(self.c).rem_euclid(std::f64::consts::TAU) / std::f64::consts::TAU * interval;
        // the boundary is at phase -lead; where it should be: opposite to the mean
        let want = (-(mean + interval / 2.0)).rem_euclid(interval);
        let boundary = (-self.lead).rem_euclid(interval);
        let dist = {
            let d = (boundary - mean).rem_euclid(interval);
            d.min(interval - d)
        };
        if dist < interval * 0.3 {
            self.lead = want;
        }
    }
}

pub struct KinectData {
    client: HubClient,
    pub connected: bool,
    pub hello_streams: Vec<String>,
    pub accepts: Vec<String>,
    pub status: Option<Arc<HubStatus>>,
    pub status_json: Option<Arc<serde_json::Value>>,
    /// newest frames (with the delayed output: the frames of the persons shown)
    pub depth: Option<Arc<DepthFrame>>,
    pub ir: Option<Arc<IrFrame>>,
    /// ray x, y per pixel
    pub lut: Option<Arc<Vec<f32>>>,
    pub meta: Option<Arc<serde_json::Value>>,
    /// the persons result shown (block zones applied)
    pub persons: Option<Arc<PersonsResult>>,
    /// live + exact: the newest exact result
    pub persons_exact: Option<Arc<PersonsResult>>,
    /// ctx.persons
    pub view: Arc<PersonsView>,
    pub mode: ViewMode,
    /// live + exact: the newest exact view and the ones that came since the last frame
    pub exact_view: Option<Arc<PersonsView>>,
    pub exact_updates: Vec<Arc<PersonsView>>,
    pub fresh: Fresh,
    pending: Fresh,
    pub received: u64,
    pub fps: f64,
    pub latency_ms: f64,
    count: u32,
    count_since: f64,
    /// server clock - local clock (µs); None until the first pong
    clock_offset_us: Option<f64>,
    // ----- persons -----
    pub options: PersonOptions,
    pub persons_enabled: bool,
    /// the hub tracks persons (its streams and status say so)
    pub hub_persons: bool,
    waiting: VecDeque<Arc<PersonsResult>>,
    lags: VecDeque<f64>,
    play_delay: f64,
    phase: PhaseLock,
    /// display interval (ms), set by the output from its frame times
    pub interval: f64,
    /// false: show live results at once and delayed ones as the browser did (no phase lock)
    pub steady: bool,
    held: BTreeMap<u32, Held>,
    exact_new: Vec<Arc<PersonsResult>>,
    shown_hist: VecDeque<(u32, Arc<PersonsResult>, Option<Arc<PersonsView>>)>,
    exact_hist: VecDeque<(u32, Arc<PersonsView>)>,
    view_seq: Option<u32>,
    view_sign: f32,
    pub x_sign: f32,
    streams_key: String,
    wanted: Vec<String>,
    last_report: f64,
    pub results: u64,
    pub last_pose_ms: f64,
}

impl KinectData {
    pub fn new(ws_url: String) -> Self {
        Self {
            client: HubClient::start(ws_url),
            connected: false,
            hello_streams: Vec::new(),
            accepts: Vec::new(),
            status: None,
            status_json: None,
            depth: None,
            ir: None,
            lut: None,
            meta: None,
            persons: None,
            persons_exact: None,
            view: Arc::new(PersonsView::empty()),
            mode: ViewMode::Exact,
            exact_view: None,
            exact_updates: Vec::new(),
            fresh: Fresh::default(),
            pending: Fresh::default(),
            received: 0,
            fps: 0.0,
            latency_ms: 0.0,
            count: 0,
            count_since: mono_ms(),
            clock_offset_us: None,
            options: PersonOptions::default(),
            persons_enabled: false,
            hub_persons: false,
            waiting: VecDeque::new(),
            lags: VecDeque::new(),
            play_delay: 0.0,
            phase: PhaseLock::new(),
            interval: 1000.0 / 60.0,
            steady: true,
            held: BTreeMap::new(),
            exact_new: Vec::new(),
            shown_hist: VecDeque::new(),
            exact_hist: VecDeque::new(),
            view_seq: None,
            view_sign: 0.0,
            x_sign: -1.0,
            streams_key: String::new(),
            wanted: Vec::new(),
            last_report: 0.0,
            results: 0,
            last_pose_ms: 0.0,
        }
    }

    pub fn sensor_state(&self) -> String {
        if !self.connected {
            return "disconnected".into();
        }
        self.status.as_ref().and_then(|s| s.sensor.as_ref()).map(|s| s.state.clone()).unwrap_or_else(|| "unknown".into())
    }

    /// ms since the sensor captured this frame
    pub fn age_ms(&self, capture_time_us: u64) -> f64 {
        let off = self.clock_offset_us.unwrap_or(0.0);
        mono_ms() - mono_of_system_us(capture_time_us as f64, off)
    }

    pub fn depth_age_ms(&self) -> f64 {
        self.depth.as_ref().map(|d| self.age_ms(d.capture_time_us)).unwrap_or(f64::INFINITY)
    }

    /// Undistorted rays (pinhole until the hub sent its table).
    pub fn rays(&self) -> Arc<Vec<f32>> {
        match &self.lut {
            Some(l) => l.clone(),
            None => pinhole_rays(),
        }
    }

    // ----- streams -----

    fn hub_streams(&self) -> Vec<&'static str> {
        if !self.persons_enabled || !self.hub_persons {
            return Vec::new();
        }
        if self.options.dual() {
            vec!["persons_live", "persons"]
        } else if self.options.delay > 0 {
            vec!["persons"]
        } else {
            vec!["persons_live"]
        }
    }

    /// The streams the scenes need ('persons' implies depth and the hub's persons streams).
    pub fn set_streams(&mut self, list: &[String], options: Option<PersonOptions>) {
        self.wanted = list.to_vec();
        let persons = list.iter().any(|s| s == "persons");
        if persons != self.persons_enabled {
            self.persons_enabled = persons;
            self.waiting.clear();
            self.held.clear();
        }
        if let Some(o) = options
            && o != self.options
        {
            let was_delayed = self.delayed();
            self.options = o;
            if self.delayed() != was_delayed {
                self.waiting.clear();
                // frames held for the delayed output come back at once
                if let Some((_, h)) = self.held.pop_last() {
                    if let Some(d) = h.depth {
                        self.depth = Some(d);
                        self.pending.depth = true;
                    }
                    if let Some(i) = h.ir {
                        self.ir = Some(i);
                        self.pending.ir = true;
                    }
                }
                self.held.clear();
            }
        }
        let mut want: Vec<String> = vec!["lut".into(), "meta".into(), "status".into()];
        for s in list {
            if s != "persons" {
                want.push(s.clone());
            }
        }
        if persons {
            want.push("depth".into());
            want.extend(self.hub_streams().iter().map(|s| s.to_string()));
        }
        want.sort();
        want.dedup();
        let key = want.join(",");
        if key != self.streams_key {
            self.streams_key = key;
            self.client.send(HubCommand::Subscribe(want));
        }
    }

    pub fn delayed(&self) -> bool {
        self.persons_enabled && self.options.delayed()
    }

    /// About once a second: how the output renders, so the hub's pose model gives way when it is slow.
    pub fn report_render(&mut self, fps: f64, target: f64, scene: &str) {
        let now = mono_ms();
        if now - self.last_report < 1000.0 {
            return;
        }
        self.last_report = now;
        if self.accepts.iter().any(|a| a == "render") {
            self.client.send(HubCommand::Render { fps: (fps * 10.0).round() / 10.0, target, visible: true, scene: scene.to_string() });
        }
    }

    // ----- every frame -----

    /// Once per rendered frame, before the scenes: takes what the hub sent, plays out the persons,
    /// sets the fresh flags and rebuilds ctx.persons for a new result. `filter` removes persons
    /// standing in a block zone (the wall setup) from every result before anybody sees it.
    pub fn begin_frame(&mut self, now: f64, filter: &mut dyn FnMut(Arc<PersonsResult>, bool) -> Arc<PersonsResult>) {
        self.drain(filter);
        self.tick(now, filter);
        self.fresh = std::mem::take(&mut self.pending);
        if self.fresh.depth
            && let Some(d) = &self.depth
        {
            let age = self.age_ms(d.capture_time_us);
            if age < 5000.0 && age > -1000.0 {
                self.latency_ms = if self.latency_ms > 0.0 { 0.9 * self.latency_ms + 0.1 * age } else { age };
            }
        }
        if now - self.count_since >= 1000.0 {
            self.fps = f64::from(self.count) * 1000.0 / (now - self.count_since);
            self.count = 0;
            self.count_since = now;
        }
        // the Person objects: rebuilt for a new result (or after the mirror changed)
        let new_view = match &self.persons {
            Some(r) if Some(r.seq) != self.view_seq || self.x_sign != self.view_sign => {
                if self.x_sign != self.view_sign {
                    for e in &mut self.shown_hist {
                        e.2 = None;
                    }
                    self.exact_hist.clear();
                    self.exact_view = None;
                }
                let prev = if self.view.seq.is_some() && self.view_sign == self.x_sign { Some(&*self.view) } else { None };
                Some((r.seq, PersonsView::build(r, self.x_sign, prev)))
            }
            _ => None,
        };
        match new_view {
            Some((seq, v)) => {
                let v = Arc::new(v);
                self.view = v.clone();
                self.view_seq = Some(seq);
                self.view_sign = self.x_sign;
                if let Some(e) = self.shown_hist.iter_mut().find(|e| e.0 == seq) {
                    e.2 = Some(v);
                }
            }
            None => {
                if self.view.fresh {
                    let v = Arc::make_mut(&mut self.view);
                    v.fresh = false;
                    v.entered.clear();
                    v.left.clear();
                }
            }
        }
        if !self.persons_enabled && self.view.seq.is_some() {
            self.view = Arc::new(PersonsView::empty());
            self.persons = None;
            self.view_seq = None;
        }
        self.update_exact();
    }

    /// Takes the hub thread's messages. Every display frame, also those without a scene frame
    /// (render cap, warm-up), so the queue never backs up and the state stays current.
    pub fn drain(&mut self, filter: &mut dyn FnMut(Arc<PersonsResult>, bool) -> Arc<PersonsResult>) {
        while let Ok(e) = self.client.events.try_recv() {
            match e {
                HubEvent::Open => self.connected = true,
                HubEvent::Closed => {
                    self.connected = false;
                    self.hub_persons = false;
                }
                HubEvent::Hello { streams, accepts } => {
                    self.hello_streams = streams;
                    self.accepts = accepts;
                    self.check_hub();
                }
                HubEvent::Status(s, j) => {
                    self.status = Some(s);
                    self.status_json = Some(j);
                    self.check_hub();
                }
                HubEvent::Clock(off) => self.clock_offset_us = Some(off),
                HubEvent::Lut(l) => {
                    self.lut = Some(l);
                    self.pending.lut = true;
                }
                HubEvent::Meta(m) => {
                    self.meta = Some(m);
                    self.pending.meta = true;
                }
                HubEvent::Depth(d) => {
                    self.received += 1;
                    self.count += 1;
                    if self.delayed() {
                        let seq = d.seq;
                        self.held.entry(seq).or_default().depth = Some(d);
                        self.trim_held();
                    } else {
                        self.depth = Some(d);
                        self.pending.depth = true;
                    }
                }
                HubEvent::Ir(f) => {
                    if self.delayed() {
                        let seq = f.seq;
                        self.held.entry(seq).or_default().ir = Some(f);
                        self.trim_held();
                    } else {
                        self.ir = Some(f);
                        self.pending.ir = true;
                    }
                }
                HubEvent::Persons(kind, r) => self.hub_result(kind, r, filter),
            }
        }
    }

    fn trim_held(&mut self) {
        while self.held.len() > 64 {
            self.held.pop_first();
        }
    }

    /// whether the hub tracks persons: its streams, and its tracker and pose model not off or broken
    fn check_hub(&mut self) {
        let offers = self.hello_streams.iter().any(|s| s == "persons");
        let ok_state = |s: &Option<crate::hub::StateDetail>| s.as_ref().is_some_and(|x| x.state != "off" && x.state != "error");
        let ok = offers && self.status.as_ref().is_some_and(|s| ok_state(&s.tracking) && s.pose.as_ref().is_none_or(|p| p.state != "off" && p.state != "error"));
        if ok != self.hub_persons {
            self.hub_persons = ok;
            self.streams_key.clear();
            let w = self.wanted.clone();
            self.set_streams(&w, None);
        }
    }

    fn hub_result(&mut self, kind: PersonsKind, r: Arc<PersonsResult>, filter: &mut dyn FnMut(Arc<PersonsResult>, bool) -> Arc<PersonsResult>) {
        if !self.persons_enabled {
            return;
        }
        let dual = self.options.dual();
        let wanted = match kind {
            PersonsKind::Exact => dual || self.options.delay > 0,
            PersonsKind::Live => dual || self.options.delay == 0,
        };
        if !wanted {
            return;
        }
        self.results += 1;
        self.last_pose_ms = r.pose_ms;
        if dual && kind == PersonsKind::Exact {
            // the exact skeletons of an earlier frame: its masks came with the live result already
            let mut e = (*r).clone();
            e.labels = None;
            e.depth = None;
            e.meters = None;
            e.indices = None;
            e.count = 0;
            e.lag = mono_ms() - e.arrived;
            self.note_lag(e.lag);
            let e = filter(Arc::new(e), true);
            self.persons_exact = Some(e.clone());
            self.exact_new.push(e);
            if self.exact_new.len() > 64 {
                self.exact_new.remove(0);
            }
            return;
        }
        let lag = mono_ms() - self.due_base(&r);
        if self.delayed() || self.steady {
            self.note_lag(lag);
            self.waiting.push_back(r);
            while self.waiting.len() > 48 {
                self.waiting.pop_front();
            }
        } else {
            self.waiting.clear();
            self.show(r, 0.0, filter);
        }
    }

    fn note_lag(&mut self, lag: f64) {
        if lag.is_finite() {
            self.lags.push_back(lag);
            while self.lags.len() > 90 {
                self.lags.pop_front();
            }
        }
    }

    /// The time a result counts from: its sensor time on this clock (steady), or its arrival.
    fn due_base(&self, r: &PersonsResult) -> f64 {
        match self.clock_offset_us {
            Some(off) if self.steady => {
                let t = mono_of_system_us(r.capture_time_us as f64, off);
                // a hub on another machine with a bad clock: fall back to the arrival
                if (r.arrived - t).abs() < 2000.0 { t } else { r.arrived }
            }
            _ => r.arrived,
        }
    }

    /// The newest waiting result whose time has come (persons.js tick, with the phase lock).
    fn tick(&mut self, now: f64, filter: &mut dyn FnMut(Arc<PersonsResult>, bool) -> Arc<PersonsResult>) {
        if self.waiting.is_empty() {
            return;
        }
        let mut recent: Vec<f64> = self.lags.iter().rev().take(30).copied().collect();
        if recent.is_empty() {
            recent.push(0.0);
        }
        recent.sort_by(f64::total_cmp);
        let delayed = self.delayed();
        // nearly every result in time (p95): a late one would break the steady cadence; live waits
        // only for that, the delayed output also for its pose
        let q = 0.95;
        let margin = if delayed { 12.0 } else { 4.0 };
        let want = recent[((q * (recent.len() - 1) as f64).floor()) as usize] + margin;
        if want > self.play_delay || self.play_delay - want > 34.0 {
            self.play_delay = want;
        } else {
            self.play_delay = want.max(self.play_delay - 0.2);
        }
        let lead = if self.steady { self.phase.lead } else { 0.0 };
        let mut pick = None;
        while let Some(front) = self.waiting.front() {
            let due = self.due_base(front) + self.play_delay;
            if due > now + lead {
                break;
            }
            pick = self.waiting.pop_front().map(|r| (r, due));
        }
        if let Some((r, due)) = pick {
            if self.steady {
                self.phase.shown(now - due, self.interval);
            }
            let lag = now - r.arrived;
            self.show(r, lag, filter);
        }
    }

    fn show(&mut self, r: Arc<PersonsResult>, lag: f64, filter: &mut dyn FnMut(Arc<PersonsResult>, bool) -> Arc<PersonsResult>) {
        let mut shown = (*r).clone();
        shown.lag = lag;
        let shown = filter(Arc::new(shown), false);
        let seq = shown.seq;
        // for liveAt / exactAt (the list stays, the masks are dropped)
        let mut light = (*shown).clone();
        light.labels = None;
        light.depth = None;
        light.meters = None;
        light.indices = None;
        if self.shown_hist.front().is_some_and(|e| e.0 > seq) {
            self.shown_hist.clear(); // the frame numbers started over (another hub)
        }
        self.shown_hist.push_back((seq, Arc::new(light), None));
        while self.shown_hist.len() > HISTORY {
            self.shown_hist.pop_front();
        }
        self.persons = Some(shown);
        self.pending.persons = true;
        if !self.delayed() {
            return;
        }
        // the frames of the same moment come out with the persons
        if let Some(h) = self.held.remove(&seq) {
            if let Some(d) = h.depth {
                self.depth = Some(d);
                self.pending.depth = true;
            }
            if let Some(i) = h.ir {
                self.ir = Some(i);
                self.pending.ir = true;
            }
        }
        while self.held.first_key_value().is_some_and(|(k, _)| *k <= seq) {
            self.held.pop_first();
        }
    }

    fn update_exact(&mut self) {
        let dual = self.persons_enabled && self.options.dual();
        let mut updates = Vec::new();
        for r in std::mem::take(&mut self.exact_new) {
            if !dual {
                continue;
            }
            let v = Arc::new(PersonsView::build(&r, self.x_sign, self.exact_view.as_deref()));
            self.exact_view = Some(v.clone());
            if self.exact_hist.front().is_some_and(|e| e.0 > r.seq) {
                self.exact_hist.clear();
            }
            self.exact_hist.push_back((r.seq, v.clone()));
            while self.exact_hist.len() > HISTORY {
                self.exact_hist.pop_front();
            }
            updates.push(v);
        }
        if dual {
            self.mode = ViewMode::Both;
            self.exact_updates = updates;
        } else if !self.persons_enabled || self.options.delay > 0 {
            self.mode = ViewMode::Exact;
            self.exact_updates = if self.view.fresh { vec![self.view.clone()] } else { Vec::new() };
            self.exact_view = Some(self.view.clone());
        } else {
            self.mode = ViewMode::Live;
            self.exact_updates = Vec::new();
            self.exact_view = None;
        }
    }

    /// The view of a shown frame (the last 3 s), made when asked for.
    fn shown_at(&mut self, seq: u32) -> Option<Arc<PersonsView>> {
        let x_sign = self.x_sign;
        let e = self.shown_hist.iter_mut().find(|e| e.0 == seq)?;
        if e.2.is_none() {
            e.2 = Some(Arc::new(PersonsView::build(&e.1, x_sign, None)));
        }
        e.2.clone()
    }

    /// The exact view of frame `seq` (ctx.persons.exactAt), or None.
    pub fn exact_at(&mut self, seq: u32) -> Option<Arc<PersonsView>> {
        match self.mode {
            ViewMode::Both => self.exact_hist.iter().find(|e| e.0 == seq).map(|e| e.1.clone()),
            ViewMode::Exact => self.shown_at(seq),
            ViewMode::Live => None,
        }
    }

    /// The live view of frame `seq` (ctx.persons.liveAt), or None.
    pub fn live_at(&mut self, seq: u32) -> Option<Arc<PersonsView>> {
        match self.mode {
            ViewMode::Exact => None,
            _ => self.shown_at(seq),
        }
    }

    /// ms from a frame's arrival to its result: (p50, p95, max) of the recent ones.
    pub fn wait_stats(&self) -> Option<(f64, f64, f64)> {
        if self.lags.is_empty() {
            return None;
        }
        let mut a: Vec<f64> = self.lags.iter().rev().take(30).copied().collect();
        a.sort_by(f64::total_cmp);
        let at = |q: f64| a[((q * (a.len() - 1) as f64).floor()) as usize].round();
        Some((at(0.5), at(0.95), at(1.0)))
    }

    /// German status line of the tracking (HUD, telemetry).
    pub fn status_text(&self) -> String {
        let Some(r) = &self.persons else {
            return if self.hub_persons { "Personen: warte auf das erste Ergebnis …".into() } else { "Personen: der Hub verfolgt keine Personen (Pose-Modell?)".into() };
        };
        let n = r.list.len();
        let lag = if self.options.dual() {
            format!(" · live, exakt nach {} ms", self.wait_stats().map(|s| s.0.to_string()).unwrap_or_else(|| "…".into()))
        } else if self.options.delay > 0 {
            format!(" · {} ms verzögert", self.play_delay.round())
        } else {
            String::new()
        };
        format!("{n} {} · Pose {:.0} ms (Hub){lag}", if n == 1 { "Person" } else { "Personen" }, r.pose_ms)
    }

    pub fn play_delay(&self) -> f64 {
        self.play_delay
    }
}

static PINHOLE: std::sync::OnceLock<Arc<Vec<f32>>> = std::sync::OnceLock::new();

/// Rays of an ideal pinhole Kinect (until the hub sent the real table).
pub fn pinhole_rays() -> Arc<Vec<f32>> {
    PINHOLE
        .get_or_init(|| {
            let mut v = vec![0.0_f32; crate::persons::N * 2];
            for y in 0..424 {
                for x in 0..512 {
                    v[(y * 512 + x) * 2] = (x as f32 - 256.0) / 365.5;
                    v[(y * 512 + x) * 2 + 1] = (y as f32 - 206.0) / 365.5;
                }
            }
            Arc::new(v)
        })
        .clone()
}
