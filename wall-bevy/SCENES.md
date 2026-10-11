# Szenen für wall-bevy schreiben

Eine Szene ist eine eigene Crate in `wall-bevy/scenes/<name>/`. Sie wird zu einer Bibliothek gebaut
(`wall_scene_<name>.dll`, unter Linux `libwall_scene_<name>.so`), die die Ausgabe beim Start lädt und
**im laufenden Bild austauscht**, sobald sie neu gebaut ist. Die Ausgabe muss dafür nie beendet werden.
Was viele Szenen brauchen, steckt im Framework (`wall/`): Personen in LED-Pixeln, Zeichnen auf der GPU
(Formen mit Glow, Text, Bilder), UI-Bausteine, Partikel, Ton, Zufall. Eine Szene ist damit meist eine
Deklaration und zwei Funktionen.

## Schnellstart

```
cd wall-bevy
cargo build --release                                     # einmal: Framework, Ausgabe, alle Szenen
target\release\wall-bevy.exe --new-scene meine-szene      # scenes/meine-szene/ aus der Vorlage
target\release\wall-bevy.exe --watch --scene meine-szene --windowed
```

Jetzt `scenes/meine-szene/src/lib.rs` ändern und speichern. Die Ausgabe baut im Hintergrund (mit
niedriger Priorität) und tauscht die Szene aus, sobald sie fertig ist. Das Log sagt, wie lange es
gedauert hat:

```
baue: scenes/meine-szene/src/lib.rs
gebaut in 0.8 s
meine-szene neu geladen aus wall_scene_meine_szene.dll (1 ms, 1.1 s nach dem Speichern)
meine-szene: neue Version läuft (Setup 20 ms, 1.2 s nach dem Speichern)
```

Gemessen im Release-Profil (VM mit 4 Kernen, ohne GPU), vom Speichern bis zum neuen Bild: eine kleine
Szene 1,2 s, fruit-ninja (6.500 Zeilen) 2,9 s. Das Bauen allein nach einer Änderung in einer Funktion:
0,7 s (kleine Szene) bis 3,7 s (invaders, 8.900 Zeilen, baut zwei Szenen mit); das Release-Profil baut
dafür inkrementell. Ein Fehler beim Bauen steht im Log und in der Steuerzentrale; bis er behoben ist,
läuft die alte Version weiter.

- **Ohne Kinect:** `target\release\fake_hub.exe --bind 127.0.0.1:8099 --persons 3` und
  `--hub 8099` dazu (drei erfundene Personen, die gehen, winken und springen), oder ein Replay-Hub mit
  einer Aufnahme (`CLAUDE.md`).
- **Während der Show:** Die Ausgabe lädt neu gebaute Szenen auch ohne `--watch`. Läuft die Show mit
  `start-wand.cmd -Bevy`, genügt ein `cargo build --release` in `wall-bevy/`: Die Szene, die gerade
  läuft, wird ausgetauscht, die anderen spielt die Show beim nächsten Mal in der neuen Version. Das
  gilt, solange `wall/` und `src/` unverändert sind (siehe Regeln).
- **Neue Szene in der Show:** Eine Szene mit dem Namen einer Browser-Szene ersetzt diese in der Show
  (ein Port). Eine Szene, die es nur hier gibt, listet die Steuerzentrale noch nicht (sie kennt die
  Szenen aus `web/scenes/`); zeigen lässt sie sich mit `--scene NAME`.

## Wie eine Szene aussieht

```rust
use wall::prelude::*;

wall::scene! {
    name: "meine-szene",
    title: "Meine Szene",
    params: [
        color("farbe", "#5ad1ff", "Farbe"),
        num("tempo", 1.0, 0.0, 3.0, 0.05, "Tempo"),
    ],
    persons: live,
    sketch: MeineSzene,
}

struct MeineSzene {
    sparks: Particles,
}

impl Sketch for MeineSzene {
    fn setup(_s: &mut Setup) -> Result<Self, String> {
        Ok(MeineSzene { sparks: Particles::new(120.0) })
    }

    fn frame(&mut self, f: &mut Frame) {
        let tint = f.color("farbe");
        f.clear(hex("#05060d"));
        for b in f.bodies().iter() {
            f.skeleton(b, 4.0);
            if b.hand_up(0.0) {
                for hand in b.hands().into_iter().flatten() {
                    self.sparks.spray(hand, 2, vec2(0.0, -100.0), 0.6, 1.0, tint);
                }
            }
        }
        let dt = f.dt();
        self.sparks.draw(f, dt);
    }
}
```

**`wall::scene!`** deklariert die Szene und exportiert sie. Die Felder kommen in dieser Reihenfolge,
alle außer `name`, `title` und `sketch` sind optional:

| Feld | |
|---|---|
| `name` | eindeutig, Kleinbuchstaben und `-`; der Name einer Browser-Szene macht sie zu deren Port |
| `title` | der Titel in der Steuerzentrale |
| `params: [...]` | was die Steuerzentrale einstellt: `num(key, wert, min, max, schritt, label)`, `boolean(key, wert, label)`, `color(key, "#rrggbb", label)`, `select(key, wert, &["a", "b"], label)`, `text(key, wert, label)` |
| `persons: live` / `exact` | die Personen: so früh wie möglich (`live`) oder genau, etwas später (`exact`); ohne: keine Personen |
| `streams: ["depth", "ir"]` | Kinect-Rohdaten (für eigene GPU-Arbeit) |
| `max_fps: 30` | Bildrate begrenzen (die Ausgabe zeigt trotzdem jedes Anzeigebild) |
| `projection: { ... }` | Wünsche an die Projektion wie `projection` in `main.js`, z. B. `{ "edge": "soft", "margin": 0.35 }` |
| `sketch: Typ` | der Typ, der `Sketch` implementiert |

**`setup(s)`** läuft einmal, in einem eigenen Thread (die Show spielt weiter): Bilder laden, Töne
erzeugen, Zustand anlegen. `s.w()`, `s.h()` (LED-Pixel), `s.num/flag/string(key)` (Params),
`s.draw` (zum Laden von Bildern). Ein `Err` zeigt die Steuerzentrale an; die Show versucht es später
noch einmal.

**`frame(f)`** läuft jedes Bild: Logik und Zeichnen. Das Framework löscht das Bild, zeichnet, was
`frame` verlangt hat, in einem Rutsch auf der GPU und gibt es an die Ausgabe.

| `f.` | |
|---|---|
| `w()`, `h()` | Größe in LED-Pixeln (1008 × 336) |
| `t()`, `dt()`, `frame()` | Sekunden seit dem Start der Szene, seit dem letzten Bild, Bildzähler |
| `num(key)`, `flag(key)`, `color(key)`, `string(key)` | die Params |
| `bodies()` | die Personen auf der Wand (siehe unten) |
| `entered()`, `left()` | Ids der Personen, die in diesem Bild gekommen / gegangen sind |
| `play(&pcm, lautstärke)` | einen Ton spielen |
| `status(text)` | Statuszeile in der Steuerzentrale |
| `hold(läuft)` | Spiele: solange `true`, wartet die Show mit dem Weiterschalten |

Eine Methode von `f` darf `f` in ihren Argumenten lesen (`f.circle(f.w() / 2.0, …)`). Eine Funktion,
die `f` als Argument bekommt, nicht: dann den Wert vorher in eine Variable holen (`let dt = f.dt();
self.sparks.draw(f, dt);`).

## Zeichnen

Alles in LED-Pixeln, (0, 0) oben links. Formen, Text und Bilder landen in einem einzigen Zeichenaufruf
je Mischmodus (Instanzen auf der GPU, Kanten mit Antialiasing). Tausende Formen je Bild sind kein
Problem.

| | |
|---|---|
| `f.clear(farbe)` | Hintergrund dieses Bilds (sonst schwarz) |
| `f.keep()`, `f.fade(farbe)` | das letzte Bild behalten und mit einer halbdurchsichtigen Farbe abdecken: Spuren |
| `f.rect(x, y, b, h, p)`, `f.rrect(x, y, b, h, radius, p)` | Rechteck (oben links, Größe), mit runden Ecken |
| `f.circle(x, y, r, p)`, `f.ellipse(x, y, rx, ry, p)` | Kreis, Ellipse (Mitte) |
| `f.line(x0, y0, x1, y1, breite, p)`, `f.polyline(&punkte, breite, geschlossen, p)` | Linien mit runden Enden |
| `f.triangle(a, b, c, p)`, `f.polygon(&punkte, p)` | Dreieck, konvexes Polygon |
| `f.push()`, `f.translate(x, y)`, `f.rotate(rad)`, `f.scale(s)`, `f.pop()` | Transformationen |

`p` ist eine Farbe (gefüllt) oder ein `Paint`: `Paint::fill(c)`, `Paint::stroke(c, breite)`,
`.outline(c, breite)`, `.glow(px)` (Leuchten um die Form), `.add()` (addiert: Licht auf der Wand).

Farben: `hex("#ff7a3d")`, `rgb(r, g, b)` (0..1), `rgb8(r, g, b)`, `hsl(grad, s, l)`,
`Color::WHITE`, `RED`, `CYAN` … `.alpha(a)`, `.fade(k)` (Deckkraft mal k), `.mix(andere, t)`,
`Color::from_rgb(body.color)`.

**Text:** `f.text("Hallo", x, y, &Text::new(24.0).bold().color(c).glow(8.0))`. Der Text steht mit
seinem Anker (Standard: Mitte) auf (x, y): `.anchor(Anchor::TopLeft)` usw. Dazu `.weight(900)`,
`.font("Segoe UI, sans-serif")` (CSS-Schriftliste, Systemschriften), `.background(c)`, `.pad(x, y)`,
`.radius(r)` (ein Kasten dahinter), `.spacing(em)`. `f.measure(text, &t)` gibt die Größe des Kastens.
Jeder Text wird einmal je Inhalt und Stil gerastert und dann aus einem Atlas gezeichnet. Ein Text, der
sich jedes Bild ändert (Zeit mit Millisekunden), kostet jedes Bild eine Rasterung: lieber runden.

**Bilder:** in `setup` laden, in `frame` zeichnen.

```rust
// setup
let logo = s.draw.load_png(include_bytes!("logo.png"))?;   // oder load_image(b, h, &rgba)
// frame
f.image(self.logo, x, y, b, h);
f.image_tinted(self.logo, x, y, b, h, Color::RED.alpha(0.5));
```

## Personen

`f.bodies()` gibt die sichtbaren Personen, schon durch die Projektion der Szene auf die Wand
abgebildet (Steuerzentrale → Projektionen), in LED-Pixeln. Je Person ein `Body`:

| | |
|---|---|
| `id`, `slot`, `color` | Tracking-Id, Platz (1, 2, …; die Farbe der Person in jeder Szene), Farbe `[r, g, b]` |
| `joints[j::RIGHT_HAND]`, `joint(j)` | jedes Gelenk (`Option<Vec2>`; `j::HEAD`, `j::NECK`, `j::LEFT_WRIST`, `j::PELVIS`, …) |
| `head()`, `hands()`, `feet()`, `top()` | Kopf, `[links, rechts]` Hände, Füße, höchster Punkt |
| `bones()` | die Knochen, deren beide Enden zu sehen sind |
| `hand_up(abstand)` | ist eine Hand über dem Kopf? |
| `center`, `height` | Mitte auf der Wand, Größe in Pixeln (höchstes bis tiefstes Gelenk) |
| `entered`, `age` | in diesem Bild gekommen, Sekunden seit das Tracking sie sieht |
| `vx`, `near` | Geschwindigkeit quer zur Wand (px/s), Nähe (1 vorne in der Zone, 0 hinten) |

## UI-Bausteine

Methoden von `f` (sie zeichnen sofort; jedes Bild aufrufen, solange sie zu sehen sein sollen):

| | |
|---|---|
| `f.label(text, x, y, größe, farbe)` | Text in einem dunklen Kasten, leuchtend |
| `f.name_tag(body, text, größe)` | Namensschild über dem Kopf, in der Farbe der Person |
| `f.bubble(body, text, größe)` | Sprechblase neben dem Kopf |
| `f.banner(titel, untertitel, a, farbe)` | großer Titel in der Mitte, sichtbar mit `a` (0..1) |
| `f.countdown(sekunden, x, y, größe, farbe)` | pulsierende Zahl (3, 2, 1) |
| `f.progress(x, y, b, h, wert, farbe)` | Fortschrittsbalken (0..1) |
| `f.skeleton(body, breite)` | das Skelett einer Person, leuchtend |

Mit Zustand (ein Feld der Szene, jedes Bild `draw`):

| | |
|---|---|
| `Score` | Zahl, die zum Wert hochzählt und beim Ändern kurz größer wird: `self.score.draw(f, punkte, x, y, &text, dt)` |
| `Toasts` | kurze Meldungen unten, die von selbst verblassen: `push("Willkommen!", farbe)`, `draw(f, dt)` |
| `Qr` | QR-Code (einmal je Text erzeugt): `self.qr.draw(f, "https://…", x, y, größe)` |
| `Fade` | blendet ein, solange etwas gilt: `let a = self.idle.update(niemand_da, dt); f.banner("Hallo", "Kommt näher!", a, c)` |
| `Particles` | Funken, Konfetti: `burst(punkt, anzahl, tempo, sekunden, farbe)`, `spray(punkt, anzahl, geschw, streuung, sekunden, farbe)`, `draw(f, dt)` |
| `Rng` | Zufall: `Rng::from_time()`, `.f32()`, `.range(a, b)`, `.int(n)`, `.chance(p)`, `.pick(&liste)`, `.unit()`, `.angle()` |

Dazu `smooth(t)`, `ease_out(t)` und `envelope(alter, ein, halten, aus)` (0 → 1 → 0, z. B. ein Titel
am Anfang: `f.banner(…, envelope(f.t(), 0.6, 3.5, 0.8), …)`).

## Ton

Töne werden einmal in `setup` erzeugt (`wall::audio`) und in `frame` gespielt:

```rust
use wall::audio::{exp_ramp, osc, render};
// setup: 0,6 s, Sinus 660 Hz mit Quinte, klingt aus
let chime = render(0.6, |t, _| (osc("sine", 660.0 * t) + 0.5 * osc("sine", 990.0 * t)) * exp_ramp(t, 0.0, 0.3, 0.6, 0.001));
// frame
f.play(&self.chime, 0.5);
```

`osc(form, phase)` kann `"sine"`, `"square"`, `"sawtooth"`, `"triangle"` (Phase in Schwingungen:
Frequenz × Zeit); dazu `noise`, `lin_ramp`, `exp_ramp`,
`Biquad`, `OnePole` (Filter) und `mix` (Töne zusammensetzen).

## Eigene GPU-Arbeit

Ein `Sketch` zeichnet 2D. Für Shader (Effekte auf den Kinect-Daten, Simulationen, 3D) implementiert
eine Szene `wall::Scene` direkt und bekommt den ganzen Kontext: wgpu-Gerät, Encoder, Kinect-Texturen,
Wand-Abbildung. Wie das geht, steht in [`PORTING.md`](PORTING.md); Beispiele: `scenes/shader-scenes`
(Shader-Pässe), `scenes/pixel-spiegel`, `scenes/fluid-simulation`. Für Text und Formen über den
eigenen Pässen: `wall::draw::Draw` (`Draw::new` in `make`, je Bild `begin()`, zeichnen,
`finish_into(encoder, view)`).

## Regeln

- **Austauschen heißt neu starten:** Die neue Version beginnt mit einem frischen `setup`; der Zustand
  der alten geht verloren. `setup` sollte schnell sein.
- **Framework und Ausgabe:** Ändert sich `wall/` (das Framework) oder `src/` (die Ausgabe), passen die
  Szenen-Bibliotheken nicht mehr zur laufenden Ausgabe. Mit `--watch` meldet die Ausgabe dann „neu
  bauen und starten“ und baut keine Szenen mehr, bis sie neu gestartet ist. Eine Bibliothek, die gegen
  einen anderen Stand des Frameworks gebaut ist, lädt sie nicht (sie prüft eine Build-ID).
- **Immer den ganzen Workspace bauen** (`cargo build --release` in `wall-bevy/`), nie ein Paket allein
  mit `-p`: Cargo wählt sonst andere Features für gemeinsame Abhängigkeiten, und die Bibliotheken
  passen nicht mehr zusammen.
- **Eigene Abhängigkeiten** (z. B. eine Crate für Physik) gehen in die `Cargo.toml` der Szene. Was das
  Framework schon hat, kommt von dort: `wall::glam`, `wall::wgpu`, `wall::serde_json`, `wall::bytemuck`.
- **Nie ruckeln:** Schwere Arbeit (Bilder malen, Töne erzeugen, Tabellen rechnen) gehört in `setup`. In
  `frame` nichts Großes anlegen, nichts blockieren, kein `println!`. Ein Panic in einer Szene hält die
  Show nicht an: Die Szene wird nach 2 s neu gestartet und nach drei Fehlern in 30 s übersprungen.
- **Testen:** `--shots DIR --seconds S` rendert ohne Bildschirm und schreibt Bilder und Bildzeiten
  (`frames.json`: `cpu` ist die CPU-Zeit der Ausgabe je Bild, `cpuByScene` je Szene); siehe README.
  `cargo clippy --release --all-targets` soll ohne Warnungen durchlaufen.

Die Beispielszene `scenes/hallo-wand` zeigt fast alles davon in 90 Zeilen: Skelette, Namensschilder,
Funken von erhobenen Händen, Begrüßung mit Ton, Zähler, QR-Code und einen Titel, solange niemand da ist.
