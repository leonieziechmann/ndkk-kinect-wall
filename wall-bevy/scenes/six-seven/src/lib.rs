//! six-seven: the "6 7" gesture as a speedrun. Both hands in front, palms up, one up and one down,
//! then swap: every swap is a pump. Whoever reaches 67 pumps first wins; everyone races at once,
//! each with their own timer that starts with the first pump.

use std::collections::HashMap;

use wall::audio::{exp_ramp, osc, render};
use wall::prelude::*;

wall::scene! {
    name: "six-seven",
    title: "6 7 Speedrun",
    params: [
        num("ziel", 67.0, 10.0, 200.0, 1.0, "Pumps bis zum Ziel"),
        num("hub", 0.04, 0.01, 0.25, 0.005, "Hub (Anteil der Körpergröße)"),
        num("tempo", 0.5, 0.1, 3.0, 0.05, "Schnell ab (Körpergrößen/s): halber Hub genügt"),
        num("anteil", 0.2, 0.0, 0.45, 0.05, "Mindestanteil der schwächeren Hand am Hub"),
        num("pause", 6.0, 2.0, 20.0, 0.5, "Ergebnis zeigen (s)"),
    ],
    persons: live,
    sketch: SixSeven,
}

/// Pitch steps of the pump ticks (a pentatonic scale, rising with the count).
const STEPS: usize = 12;

#[derive(Default)]
enum Phase {
    /// waiting for the first pump
    #[default]
    Ready,
    /// racing since `start` (scene time)
    Run { start: f32 },
    /// finished in `time` seconds, shown since `at`
    Done { time: f32, at: f32 },
}

#[derive(Default)]
struct Player {
    phase: Phase,
    count: u32,
    /// +1 the signal is rising (left hand going up), -1 falling, 0 not yet started
    side: i8,
    /// the extremum of the signal since the last reversal
    ext: f32,
    /// the last distinct sample and its time (for the speed)
    prev_d: f32,
    prev_t: f32,
    /// the heights of the (left, right) hand at the extremum and at the reversal before it
    ext_hands: (f32, f32),
    turn_hands: (f32, f32),
    /// scene time of the last reversal (counted or not)
    last_turn: f32,
    /// pumps per second, smoothed
    rate: f32,
    /// the first pump of the starting streak
    first: f32,
    /// a flash after each pump (1 → 0)
    kick: f32,
    /// scene time of the last pump (an idle racer is reset)
    last: f32,
}

struct SixSeven {
    players: HashMap<u32, Player>,
    best: Option<f32>,
    sparks: Particles,
    toasts: Toasts,
    ticks: Vec<Pcm>,
    fanfare: Pcm,
    go: Pcm,
    idle: Fade,
    /// 0..1: how hard the fastest racer pumps (smoothed), and the flashes of the big 6 and 7
    heat: f32,
    flash: [f32; 2],
}

impl Sketch for SixSeven {
    fn setup(_s: &mut Setup) -> Result<Self, String> {
        let scale = [0.0f32, 2.0, 4.0, 7.0, 9.0];
        let ticks = (0..STEPS)
            .map(|i| {
                let semis = scale.get(i % 5).copied().unwrap_or(0.0) + 12.0 * (i / 5) as f32;
                let hz = 440.0 * 2f32.powf(semis / 12.0);
                render(0.09, move |t, _| (osc("triangle", hz * t) + 0.3 * osc("square", hz * 2.0 * t)) * exp_ramp(t, 0.0, 0.005, 0.09, 0.001) * 0.6)
            })
            .collect();
        let fanfare = render(1.2, |t, _| {
            let notes = [523.25f32, 659.25, 783.99, 1046.5];
            let k = ((t / 0.12) as usize).min(3);
            let hz = notes.get(k).copied().unwrap_or(523.25);
            (osc("sawtooth", hz * t) * 0.35 + osc("sine", hz * 0.5 * t) * 0.4) * exp_ramp(t, 0.0, 0.01, 1.2, 0.001)
        });
        let go = render(0.25, |t, _| osc("square", (330.0 + 600.0 * t) * t) * exp_ramp(t, 0.0, 0.01, 0.25, 0.001) * 0.4);
        Ok(SixSeven {
            players: HashMap::new(),
            best: None,
            sparks: Particles::new(400.0),
            toasts: Toasts::default(),
            ticks,
            fanfare,
            go,
            idle: Fade::new(0.6, 0.4),
            heat: 0.0,
            flash: [0.0; 2],
        })
    }

    fn frame(&mut self, f: &mut Frame) {
        let (w, h, dt, now) = (f.w(), f.h(), f.dt(), f.t());
        let goal = f.num("ziel").round().max(1.0) as u32;
        let thr = f.num("hub");
        let fast_speed = f.num("tempo");
        let share = f.num("anteil");
        let pause = f.num("pause");
        let bodies = f.bodies();
        let res = f.ctx.kinect.persons.clone();
        let view = f.ctx.kinect.view.clone();
        f.clear(hex("#07040f"));

        // the intensity shakes the whole picture a little
        let heat = self.heat;
        let hot = hex("#7a3cff").mix(hex("#ff4a1f"), heat);
        f.push();
        f.translate((now * 61.0).sin() * 3.0 * heat * heat, (now * 47.0).cos() * 2.5 * heat * heat);

        // background: the big 6 and 7 pulse slowly, jump with every pump and heat up with the pace
        let beat = (now * 2.0).fract();
        for (i, (digit, x, cold, idle)) in [("6", 0.25, "#2a1450", 1.0 - beat), ("7", 0.75, "#14304f", beat)].into_iter().enumerate() {
            let fl = self.flash.get(i).copied().unwrap_or(0.0);
            f.push();
            f.translate(w * x, h * 0.5);
            f.scale(1.0 + 0.12 * fl);
            f.text(digit, 0.0, 0.0, &Text::new(300.0).weight(900).color(hex(cold).mix(hot, (heat * 0.6 + fl * 0.5).min(1.0)).alpha(0.35 + 0.2 * idle + 0.4 * fl)));
            f.pop();
        }
        // glowing edges: the hotter, the brighter
        if heat > 0.02 {
            let edge = Paint::fill(hot.fade(0.25 + 0.75 * heat)).glow(10.0 + 30.0 * heat).add();
            f.rect(0.0, 0.0, w, 2.0 + 4.0 * heat, edge);
            f.rect(0.0, h - 2.0 - 4.0 * heat, w, 2.0 + 4.0 * heat, edge);
        }
        for fl in &mut self.flash {
            *fl = (*fl - dt * 6.0).max(0.0);
        }
        let mut top_rate = 0.0f32;

        self.players.retain(|id, _| bodies.iter().any(|b| b.id == *id));
        let mut running = false;

        for b in bodies.iter() {
            let c = Color::from_rgb(b.color);
            let p = self.players.entry(b.id).or_default();
            p.kick = (p.kick - dt * 4.0).max(0.0);
            if now - p.last > 0.4 {
                p.rate *= (-dt * 3.0).exp();
            }
            f.skeleton(b, 3.0 + 2.5 * p.kick);

            let [lh, rh] = b.hands();
            let mut pumped = false;
            // fast path: the hands straight from this depth frame's mask (30 fps); else the skeleton
            let fast = res.as_deref().and_then(|r| view.visible.iter().find(|q| q.id == b.id).and_then(|q| hand_signal(r, q)));
            let ny = b.joint(j::NECK).map_or(b.center.y, |n| n.y);
            let slow = lh.zip(rh).map(|(l, r)| ((ny - l.y) / b.height.max(40.0), (ny - r.y) / b.height.max(40.0)));
            if let (Some(l), Some(r), Some((hl, hr))) = (lh, rh, fast.or(slow)) {
                // d > 0 means the left hand is higher
                let d = hl - hr;
                // a pump is a reversal of d, not a crossing of zero: follow d to its extremum and count
                // once it has come back by the stroke. A fast reversal counts after half of it, so
                // quick small pumps register at the turn itself.
                if d != p.prev_d {
                    let speed = (d - p.prev_d).abs() / (now - p.prev_t).max(0.005);
                    p.prev_d = d;
                    p.prev_t = now;
                    if p.side == 0 {
                        p.side = 1;
                        p.ext = d;
                        p.ext_hands = (hl, hr);
                        p.turn_hands = (hl, hr);
                    }
                    let back = (p.ext - d) * f32::from(p.side);
                    if back <= 0.0 {
                        p.ext = d;
                        p.ext_hands = (hl, hr);
                    } else if now - p.last_turn > 0.05 && (back >= thr || (back >= thr * 0.5 && speed >= fast_speed)) {
                        // the stroke that just ended, per hand: it is a pump only if one hand went
                        // up and the other down, and neither did nearly all of it (a wave, a nod)
                        let (dl, dr) = (p.ext_hands.0 - p.turn_hands.0, p.ext_hands.1 - p.turn_hands.1);
                        let both = dl * dr < 0.0 && dl.abs().min(dr.abs()) >= share * (dl.abs() + dr.abs());
                        p.turn_hands = p.ext_hands;
                        p.side = -p.side;
                        p.ext = d;
                        p.ext_hands = (hl, hr);
                        p.last_turn = now;
                        pumped = both;
                    }
                }
                // the hands: "6" on the left, "7" on the right, the higher one shines
                for (hand, label, up) in [(l, "6", p.side > 0), (r, "7", p.side < 0)] {
                    let glow = if up { 1.0 } else { 0.35 };
                    f.circle(hand.x, hand.y, 10.0 + 6.0 * p.kick, Paint::fill(c.mix(Color::WHITE, 0.3).fade(glow)).glow(12.0).add());
                    if up && p.kick > 0.0 {
                        f.circle(hand.x, hand.y, 12.0 + 34.0 * (1.0 - p.kick), Paint::stroke(c.fade(p.kick), 2.5).glow(8.0).add());
                    }
                    f.text(label, hand.x, hand.y - 26.0, &Text::new(28.0 + 10.0 * p.kick * glow).weight(900).color(Color::WHITE.fade(0.5 + 0.5 * glow)).glow(8.0));
                }
            }

            if pumped {
                let gap = p.last;
                p.last = now;
                p.kick = 1.0;
                p.rate += ((1.0 / (now - gap).max(0.07)) - p.rate) * 0.4;
                if let Some(fl) = self.flash.get_mut(usize::from(p.side < 0)) {
                    *fl = 1.0;
                }
                match p.phase {
                    Phase::Ready => {
                        // three pumps in a row start the race (one twitch does not); the clock
                        // counts from the first of them
                        if p.count == 0 || now - gap > 0.7 {
                            p.count = 0;
                            p.first = now;
                        }
                        p.count += 1;
                        if p.count >= 3 {
                            p.phase = Phase::Run { start: p.first };
                            f.play(&self.go, 0.5);
                        }
                    }
                    Phase::Run { start } => {
                        p.count += 1;
                        let i = ((p.count as usize * STEPS) / (goal as usize + 1)).min(STEPS - 1);
                        if let Some(t) = self.ticks.get(i) {
                            f.play(t, 0.35);
                        }
                        if p.count >= goal {
                            let time = now - start;
                            p.phase = Phase::Done { time, at: now };
                            f.play(&self.fanfare, 0.7);
                            let center = b.top();
                            self.sparks.burst(center, 120, 260.0, 1.6, c.mix(Color::WHITE, 0.3));
                            let record = self.best.is_none_or(|best| time < best);
                            if record {
                                self.best = Some(time);
                                self.toasts.push(format!("NEUER REKORD: #{} in {:.2} s!", b.slot, time), c);
                            } else {
                                self.toasts.push(format!("#{} schafft {goal} in {:.2} s", b.slot, time), c);
                            }
                        }
                    }
                    Phase::Done { .. } => {}
                }
                if let Some(hand) = lh.zip(rh).map(|(l, r)| if p.side > 0 { l } else { r }) {
                    self.sparks.spray(hand, 5 + (p.rate * 2.0) as usize, vec2(0.0, -130.0 - 25.0 * p.rate), 0.9, 0.6, c.mix(hot, 0.4));
                }
            }

            // a racer who stops for 3 s starts over
            if matches!(p.phase, Phase::Run { .. }) && now - p.last > 3.0 {
                p.phase = Phase::Ready;
                p.count = 0;
            }
            if let Phase::Done { at, .. } = p.phase
                && now - at > pause
            {
                p.phase = Phase::Ready;
                p.count = 0;
            }

            // the panel over the head
            let top = b.top();
            let (px, py) = (top.x, (top.y - 34.0).max(46.0));
            match p.phase {
                Phase::Ready => {
                    f.label("6 7 – Hände hoch & runter!", px, py, 13.0, c);
                }
                Phase::Run { start } => {
                    running = true;
                    let secs = ((now - start) * 10.0).floor() / 10.0;
                    f.text(&format!("{} / {goal}", p.count), px, py - 14.0, &Text::new(26.0 + 8.0 * p.kick).weight(900).color(Color::WHITE).glow(10.0));
                    f.progress(px - 60.0, py + 4.0, 120.0, 8.0, p.count as f32 / goal as f32, c);
                    top_rate = top_rate.max(p.rate);
                    let pace = (p.rate * 10.0).round() / 10.0;
                    f.text(&format!("{pace:.1}/s"), px + 92.0, py + 8.0, &Text::new(13.0).weight(900).color(hot.mix(Color::WHITE, 0.4)).glow(6.0));
                    f.text(&format!("{secs:.1} s"), px, py + 22.0, &Text::new(14.0).bold().color(c.mix(Color::WHITE, 0.5)));
                }
                Phase::Done { time, at } => {
                    running = true;
                    let s = 1.0 + 0.3 * (1.0 - ((now - at) * 3.0).min(1.0));
                    f.text(&format!("{time:.2} s"), px, py - 10.0, &Text::new(34.0 * s).weight(900).color(c.mix(Color::WHITE, 0.4)).glow(14.0));
                    f.text("ZIEL!", px, py + 18.0, &Text::new(14.0).bold().color(Color::WHITE));
                }
            }
        }

        self.sparks.draw(f, dt);
        f.pop();
        // 8 pumps a second is full heat; it rises fast and cools slowly
        let target = (top_rate / 8.0).min(1.0);
        self.heat += (target - self.heat) * (dt * if target > self.heat { 6.0 } else { 1.5 }).min(1.0);

        // the record, top left
        let best = match self.best {
            Some(t) => format!("Rekord {goal}: {t:.2} s"),
            None => format!("Rekord {goal}: –"),
        };
        f.label(&best, 110.0, h - 22.0, 15.0, hex("#ffd34d"));

        let idle = self.idle.update(bodies.is_empty(), dt);
        f.banner("6 7 SPEEDRUN", &format!("Beide Hände nach vorn, abwechselnd hoch und runter: {goal}× so schnell wie möglich!"), idle, hex("#c06bff"));
        self.toasts.draw(f, dt);

        f.hold(running);
        f.status(format!("{} Personen, Rekord {}", bodies.len(), self.best.map_or("–".into(), |t| format!("{t:.2} s"))));
    }
}

/// The 6-7 signal from one depth frame, without waiting for the pose: the person's pixels in front of
/// the torso (the forearms and hands) left and right of the body's middle; their mean heights give
/// how high each hand is: (left, right) above the neck, in body heights. None when unsure.
fn hand_signal(res: &wall::persons::PersonsResult, p: &wall::persons::Person) -> Option<(f32, f32)> {
    use wall::persons::{H, W};
    let labels = res.labels.as_deref()?;
    let depth = res.depth.as_deref()?;
    let jt = |k: usize| p.image.joints.get(k).copied().flatten();
    let (ls, rs) = (jt(j::LEFT_SHOULDER)?, jt(j::RIGHT_SHOULDER)?);
    let neck = (ls + rs) * 0.5;
    let pelvis = jt(j::PELVIS).or_else(|| jt(j::LEFT_HIP).zip(jt(j::RIGHT_HIP)).map(|(a, b)| (a + b) * 0.5))?;
    let torso = (pelvis.y - neck.y).max(10.0);
    let half = (ls.x - rs.x).abs().max(torso * 0.4);
    let at = |u: i32, v: i32| -> Option<(u8, u16)> {
        if u < 0 || v < 0 || u >= W as i32 || v >= H as i32 {
            return None;
        }
        let i = v as usize * W + u as usize;
        Some((*labels.get(i)?, *depth.get(i)?))
    };
    // the torso's depth: the median of the person's pixels around the chest
    let mut chest = Vec::with_capacity(64);
    for dv in -4..=4 {
        for du in -4..=4 {
            if let Some((l, d)) = at(neck.x as i32 + du * 2, (neck.y + torso * 0.25) as i32 + dv * 2)
                && l == p.slot
                && d > 0
            {
                chest.push(d);
            }
        }
    }
    if chest.len() < 10 {
        return None;
    }
    chest.sort_unstable();
    let body_d = *chest.get(chest.len() / 2)? as i32;
    let front = body_d - 120;
    // the box: shoulders' width plus an arm to each side, from above the head to below the hips
    let (u0, u1) = ((neck.x - half * 2.0) as i32, (neck.x + half * 2.0) as i32);
    let (v0, v1) = ((neck.y - torso * 0.8) as i32, (pelvis.y + torso * 0.3) as i32);
    let left_is_low_u = ls.x < rs.x;
    let (mut sl, mut nl, mut sr, mut nr) = (0f32, 0u32, 0f32, 0u32);
    for v in (v0..=v1).step_by(2) {
        for u in (u0..=u1).step_by(2) {
            let Some((l, d)) = at(u, v) else { continue };
            if l != p.slot || d == 0 || d as i32 > front {
                continue;
            }
            if ((u as f32) < neck.x) == left_is_low_u {
                sl += v as f32;
                nl += 1;
            } else {
                sr += v as f32;
                nr += 1;
            }
        }
    }
    if nl < 6 || nr < 6 {
        return None;
    }
    // in body heights (a torso is about a third of one), like the skeleton fallback
    Some(((neck.y - sl / nl as f32) / torso / 3.0, (neck.y - sr / nr as f32) / torso / 3.0))
}
