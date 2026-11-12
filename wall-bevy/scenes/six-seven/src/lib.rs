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
        num("schwelle", 0.07, 0.02, 0.25, 0.01, "Hub (Anteil der Körpergröße)"),
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
    /// +1 left hand is higher, -1 right hand is higher, 0 not yet decided
    side: i8,
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
        })
    }

    fn frame(&mut self, f: &mut Frame) {
        let (w, h, dt, now) = (f.w(), f.h(), f.dt(), f.t());
        let goal = f.num("ziel").round().max(1.0) as u32;
        let thr = f.num("schwelle");
        let pause = f.num("pause");
        let bodies = f.bodies();
        f.clear(hex("#07040f"));

        // background: a slow "6 7" pulse
        let beat = (now * 2.0).fract();
        f.text("6", w * 0.25, h * 0.5, &Text::new(300.0).weight(900).color(hex("#2a1450").alpha(0.35 + 0.2 * (1.0 - beat))));
        f.text("7", w * 0.75, h * 0.5, &Text::new(300.0).weight(900).color(hex("#14304f").alpha(0.35 + 0.2 * beat)));

        self.players.retain(|id, _| bodies.iter().any(|b| b.id == *id));
        let mut running = false;

        for b in bodies.iter() {
            let c = Color::from_rgb(b.color);
            let p = self.players.entry(b.id).or_default();
            p.kick = (p.kick - dt * 4.0).max(0.0);
            f.skeleton(b, 3.0);

            let [lh, rh] = b.hands();
            let mut pumped = false;
            if let (Some(l), Some(r)) = (lh, rh) {
                // y grows downwards: d > 0 means the left hand is higher
                let d = (r.y - l.y) / b.height.max(40.0);
                let now_side = if d > thr { 1 } else if d < -thr { -1 } else { 0 };
                if now_side != 0 && now_side != p.side {
                    if p.side != 0 {
                        pumped = true;
                    }
                    p.side = now_side;
                }
                // the hands: "6" on the left, "7" on the right, the higher one shines
                for (hand, label, up) in [(l, "6", d > 0.0), (r, "7", d < 0.0)] {
                    let glow = if up { 1.0 } else { 0.35 };
                    f.circle(hand.x, hand.y, 10.0 + 6.0 * p.kick, Paint::fill(c.mix(Color::WHITE, 0.3).fade(glow)).glow(12.0).add());
                    f.text(label, hand.x, hand.y - 26.0, &Text::new(28.0 + 10.0 * p.kick * glow).weight(900).color(Color::WHITE.fade(0.5 + 0.5 * glow)).glow(8.0));
                }
            }

            if pumped {
                p.last = now;
                p.kick = 1.0;
                match p.phase {
                    Phase::Ready => {
                        p.phase = Phase::Run { start: now };
                        p.count = 1;
                        f.play(&self.go, 0.5);
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
                    self.sparks.spray(hand, 6, vec2(0.0, -150.0), 0.9, 0.6, c);
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
            let (px, py) = (top.x, (top.y - 34.0).max(24.0));
            match p.phase {
                Phase::Ready => {
                    f.label("6 7 – Hände hoch & runter!", px, py, 13.0, c);
                }
                Phase::Run { start } => {
                    running = true;
                    let secs = ((now - start) * 10.0).floor() / 10.0;
                    f.text(&format!("{} / {goal}", p.count), px, py - 14.0, &Text::new(26.0 + 8.0 * p.kick).weight(900).color(Color::WHITE).glow(10.0));
                    f.progress(px - 60.0, py + 4.0, 120.0, 8.0, p.count as f32 / goal as f32, c);
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
