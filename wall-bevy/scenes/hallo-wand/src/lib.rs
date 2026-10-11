//! hallo-wand: an example of a scene with the framework. Everyone on the wall gets a glowing
//! skeleton and a name tag, sparks fly from raised hands, a greeting when someone comes, a counter,
//! a QR code, a title while nobody is there. All of it: the declaration, setup() and frame().

use wall::audio::{exp_ramp, osc, render};
use wall::prelude::*;

wall::scene! {
    name: "hallo-wand",
    title: "Hallo Wand (Beispiel)",
    params: [
        color("farbe", "#5ad1ff", "Farbe"),
        num("funken", 1.0, 0.0, 3.0, 0.1, "Funken"),
        boolean("namen", true, "Namensschilder"),
        text("link", "https://example.org", "QR-Code"),
    ],
    persons: live,
    sketch: Hallo,
}

struct Hallo {
    sparks: Particles,
    toasts: Toasts,
    count: Score,
    qr: Qr,
    idle: Fade,
    chime: Pcm,
}

impl Sketch for Hallo {
    fn setup(_s: &mut Setup) -> Result<Self, String> {
        // a soft two-tone chime, made once
        let chime = render(0.6, |t, _| (osc("sine", 660.0 * t) + 0.5 * osc("sine", 990.0 * t)) * exp_ramp(t, 0.0, 0.3, 0.6, 0.001));
        Ok(Hallo { sparks: Particles::new(160.0), toasts: Toasts::default(), count: Score::default(), qr: Qr::default(), idle: Fade::new(0.6, 0.4), chime })
    }

    fn frame(&mut self, f: &mut Frame) {
        let (w, h, dt) = (f.w(), f.h(), f.dt());
        let tint = f.color("farbe");
        let bodies = f.bodies();
        f.clear(hex("#05060d"));

        // the people: a glowing skeleton, a light at the head and the hands
        for b in bodies.iter() {
            let c = Color::from_rgb(b.color);
            f.skeleton(b, 4.0);
            if let Some(head) = b.head() {
                f.circle(head.x, head.y, 9.0, Paint::fill(c.mix(Color::WHITE, 0.4)).glow(10.0).add());
            }
            for hand in b.hands().into_iter().flatten() {
                f.circle(hand.x, hand.y, 5.0, Paint::fill(tint).glow(8.0).add());
                // sparks from a raised hand
                if b.hand_up(0.0) && hand.y < b.center.y {
                    let n = (f.num("funken") * 3.0) as usize;
                    self.sparks.spray(hand, n, vec2(0.0, -110.0), 0.8, 1.1, tint.mix(c, 0.5));
                }
            }
            if f.flag("namen") {
                f.name_tag(b, &format!("Hallo #{}", b.slot), 13.0);
            }
            if b.entered {
                self.toasts.push(format!("Willkommen, #{}!", b.slot), c);
                f.play(&self.chime, 0.5);
            }
        }

        // the sparks fly, fall and fade by themselves
        self.sparks.draw(f, dt);

        // a title while nobody is there, the counter, the messages, the QR code
        let idle = self.idle.update(bodies.is_empty(), dt);
        f.banner("Hallo Wand", "Kommt näher und winkt!", idle, tint);
        let n = bodies.len() as i64;
        self.count.draw(f, n, w - 40.0, 34.0, &Text::new(36.0).bold().color(tint).glow(10.0), dt);
        f.text("Personen", w - 40.0, 62.0, &Text::new(11.0).color(Color::WHITE.alpha(0.7)));
        self.toasts.draw(f, dt);
        let link = f.string("link");
        self.qr.draw(f, &link, 12.0, h - 76.0, 64.0);
        f.status(format!("{n} Personen, {} Funken", self.sparks.len()));
    }
}
