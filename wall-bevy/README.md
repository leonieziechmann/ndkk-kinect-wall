# wall-bevy: die LED-Wand-Ausgabe als native App

`wall-bevy` ist das Ausgabefenster der LED-Wand (`/wall/` im Browser) als eigenes Programm in Rust
(Bevy 0.20, wgpu). Es spielt dieselbe Show mit denselben Szenen: gleiche Namen, Parameter,
Projektionen und Personen-Einstellungen. Die Steuerzentrale bleibt im Browser und steuert es über
den Dev-Server wie das Browser-Fenster: Show, Weiter/Zurück, Szene ansehen, Blackout, Testbilder,
Parameter, Projektion, Wand-Setup, Vorschau und Status.

Warum: Das Bild soll nie ruckeln. Im Browser teilen sich die Szene, der Compositor, die
Garbage Collection und die Steuerzentrale einen Takt; hier gehört der Takt der Ausgabe allein.

## Bauen (einmal je Checkout)

```
rustup update stable          # Bevy 0.20 braucht Rust 1.97 oder neuer
cd wall-bevy
cargo build --release         # beim ersten Mal 10–20 min, danach Sekunden
```

Das Programm liegt dann in `wall-bevy\target\release\wall-bevy.exe` (`target/` ist nicht in git).

## Starten

Für die Ausstellung mit dem Launcher, der Rest bleibt wie gewohnt (Hub, Dev-Server, Steuerzentrale,
Wächter, Optimierungen):

```
start-wand.cmd -Bevy
```

`start-wand` startet dann statt des Chrome-Kiosk-Fensters `wall-bevy.exe` auf dem Wand-Bildschirm,
öffnet es wieder, wenn es zugeht, und schließt es, falls es auf dem Notebook-Bildschirm landet. Ist
`wall-bevy` nicht gebaut, nimmt es wie bisher das Browser-Fenster. Die Ausgaben von `wall-bevy`
stehen in den Logs (`L` im Launcher). Allein, ohne Launcher:

```
wall-bevy\target\release\wall-bevy.exe
```

Ohne Optionen: Hub `127.0.0.1:8090` (oder `KINECT_HUB`), der `web/`-Ordner neben dem Programm,
der Dev-Server aus `web/.cache/dev-server.json` (die Steuerzentrale), Setup und Projektionen aus
`web/.cache/wall/` des Haupt-Checkouts (oder `KINECT_WALL_DIR`), die Show aus
`web/.cache/wall/show.json`. Die Ausgabe geht randlos auf den Bildschirm der Wand: den aus dem
Wand-Setup (in der Steuerzentrale gewählt), sonst den linkesten, der nicht der Hauptbildschirm ist.
Ohne zweiten Bildschirm öffnet sich ein Fenster auf dem Hauptbildschirm, bis einer angeschlossen
wird. Schließen: Alt+F4 oder „Ausgabe schließen“ in der Steuerzentrale.

Es darf nur **eine** Ausgabe laufen: entweder das Browser-Fenster `/wall/` oder `wall-bevy`.

| Option | |
|---|---|
| `--hub 8091` / `host:port` / URL | anderer Hub, z. B. ein Replay-Hub |
| `--scene NAME [-p key=wert ...]` | nur diese Szene statt der Show |
| `--windowed` | normales Fenster (zum Ausprobieren auf einem Bildschirm) |
| `--monitor N\|NAME`, `--screen X,Y,B,H` | Bildschirm erzwingen (Nummer, Name oder Desktop-Rechteck) |
| `--fps N` | Bildrate begrenzen (wie `?fps=` im Browser) |
| `--vsync fifo\|mailbox\|immediate` | Darstellung; Standard `fifo` (gleichmäßig, nie Risse) |
| `--web DIR`, `--dev URL` | `web/`-Ordner bzw. Dev-Server von Hand |
| `--mute`, `--no-bus` | ohne Ton, ohne Steuerzentrale |
| `--shots DIR --seconds S [--shot-every T]` | Test: S Sekunden spielen, Bilder und Bildzeiten nach DIR (als Fenster in LED-Größe; mit `--monitor`/`--screen` randlos auf dem Bildschirm) |
| `--list-scenes` | alle Szenen-Deklarationen als JSON ausgeben und beenden |

## Was es gegen Ruckler tut

- **Ein fester Takt:** Vsync (`fifo`), höchstens zwei Bilder unterwegs. Szenen mit Bildraten-Grenze
  (`maxFps: 30`) rendern jedes zweite Anzeigebild, immer im gleichen Abstand; die Ausgabe zeigt
  trotzdem jedes Anzeigebild.
- **Nichts Schweres im Takt:** Hub-Verbindung und das Entpacken der Tiefenbilder und Personen-Masken
  laufen in einem eigenen Thread (Puffer werden wiederverwendet), das Einrichten einer Szene in
  einem Worker-Thread (die laufende spielt weiter), JPEG-Vorschauen und Testbilder werden
  asynchron gelesen und in einem eigenen Thread kodiert, Dokumente (Show, Setup, Projektion) in
  einem eigenen Thread beobachtet.
- **Keine Shader-Übersetzung beim Szenenwechsel:** Beim Start wird jede Szene einmal eingerichtet
  und ein paar Bilder lang unsichtbar gerendert; alle Pipelines liegen danach im Cache.
- **Personen im Takt der Anzeige:** Die Personen werden nach der Aufnahmezeit des Sensors
  ausgespielt, mit einer kleinen, sich selbst einstellenden Verzögerung, phasenstarr zum
  Anzeigetakt. So kommt jedes Kinect-Bild gleich lange auf die Wand, auch wenn Netz und Hub
  schwanken.
- **Fehler halten die Show nicht an:** Jede Szene läuft in einem eigenen GPU-Fehlerbereich; eine
  Szene mit Fehlern wird nach 2 s neu versucht und nach drei Fehlern in 30 s übersprungen. Ein
  verlorenes GPU-Gerät wird neu aufgebaut. Unter Windows läuft die Ausgabe mit Priorität „höher als
  normal“ und ohne Energiespar-Drosselung (wie Hub und Kiosk-Browser in `start-wand`).
- **Wenig CPU neben der Show:** Bevys eigene Systeme laufen ohne Thread-Pool (sie sind winzig; der
  Pool kostete nur das Wecken seiner Threads, gemessen rund 10 % eines Kerns). Die CPU bleibt für Hub,
  Tiefenberechnung und Posenmodell. `WALL_EXECUTOR=multi` schaltet Bevys Standard zum Vergleich ein.

## Szenen

Alle 19 Szenen aus `web/scenes/` haben hier ein Gegenstück in `src/scenes/` (gleicher Name, gleiche
Parameter, gleiche Projektionswünsche): blasen-platzen, cyberspiegel, depth-shader,
fluid-simulation, fruit-ninja, invaders-tracking, leonie-ziechmann, live-exakt, llg-sakura,
modern-events, neon-room, person-mask, person-skeleton, pixel-jump-run, pixel-spiegel, pointcloud,
space-invaders, three-points, wand-spiegel. Die WGSL-Dateien der Browser-Szenen werden, wo es geht,
unverändert eingebunden (`include_str!`), die Logik ist Zeile für Zeile nachgebaut, auch die
Zufallsgeneratoren mit ihren Startwerten (Kulissen und Wälder sind pixelgleich). Was sich nur mit
der Maus auf der Szenenseite bedienen ließ, fehlt (die Wand hat keine Maus). Der Ton ist mono (im
Browser stellenweise links/rechts verteilt).

`wall-bevy --list-scenes` gibt die Deklarationen aller Szenen als JSON aus (Name, Titel, Parameter,
Projektionswünsche, Personen-Optionen, Bildraten-Grenze); so lässt sich prüfen, ob sie noch zu den
Browser-Szenen passen.

Eine Szene, die es nur im Browser gibt (eine neue), überspringt die Show mit einer Fehlermeldung in
der Steuerzentrale. Ändert sich eine Browser-Szene, folgt ihr Port nicht von selbst: wie eine Szene
hierher kommt, steht in [`PORTING.md`](PORTING.md).

## Testen ohne Kinect

```
cargo build
./target/debug/fake_hub --bind 127.0.0.1:8099 --persons 3        # 3 erfundene Personen
./target/debug/wall-bevy --hub 8099 --windowed                   # Show im Fenster
./target/debug/wall-bevy --hub 8099 --scene pixel-spiegel --shots shots --seconds 8
```

`fake_hub` spricht das Hub-Protokoll mit Tiefe, IR, Personen-Masken und Skeletten; `--freeze 4.2`
zeigt immer denselben Augenblick (für Bildvergleiche). Echte Aufnahmen spielt der Replay-Hub ab
(siehe `CLAUDE.md`). `--shots` schreibt PNGs und `frames.json`: Bildrate, Bildzeiten (p50, p95, p99,
längstes Bild), verspätete Bilder, die längsten Bilder über 50 ms mit Zeitpunkt und Szene, Fehler,
und die eigene CPU-Zeit der Ausgabe je Bild (`cpu`, je Szene `cpuByScene`, Bilder über 8 ms
`slowCpu`), getrennt von der Zeit im Grafiktreiber (`submit`). Auf einem Rechner ohne GPU (lavapipe)
zeichnet der Treiber dort auf der CPU; die eigene CPU-Zeit gilt auch für die echte Maschine.
`frames.csv` hat jedes Bild einzeln (Zeit, Abstand, CPU-Zeit, Treiberzeit, Szene, ob die Szene
gezeichnet hat, Überblendung, Einrichten, erstes Bild).

## Vergleich mit der Browser-Ausgabe

`bench/compare.mjs` misst beide Ausgaben nacheinander auf diesem Rechner, mit derselben Show, demselben
Hub und auf demselben Bildschirm: Bildrate und Bildabstände der Szene, Ruckler, Arbeit je Bild im
Hauptthread, CPU aller Prozesse der Ausgabe, Speicher, unter Windows auch die GPU-Last je Prozess und
die CPU der ganzen Maschine. Die Browser-Ausgabe läuft dabei mit den Flags des Kiosk-Fensters.

```
start-wand.cmd -NoWall                                   # Hub, Dev-Server, Steuerzentrale, keine Ausgabe
node wall-bevy\bench\compare.mjs                          # die aktuelle Show, je Ausgabe 60 s
node wall-bevy\bench\compare.mjs --scenes space-invaders,fruit-ninja --seconds 30
```

Es darf keine andere Ausgabe laufen, und während der Messung sollte niemand den Rechner benutzen. Ohne
`--scenes` spielen beide die Show, wie sie ist; mit `--scenes` wird jede Szene allein gemessen (die
Show wird dafür kurz ersetzt und danach zurückgeschrieben). Die Ausgabe geht auf den Bildschirm aus dem
Wand-Setup (oder `--screen x,y,b,h`). Ergebnisse: Tabelle im Terminal, alle Zahlen in
`web/.cache/bench/`. Eine erste Messung (ohne GPU, auf einer VM) steht in [`BENCHMARK.md`](BENCHMARK.md).

## Aufbau

| Datei | |
|---|---|
| `main.rs` | Fenster, Bildschirmwahl, Bevy-Plugins |
| `output.rs` | die Ausgabe: Show, Übergänge, Blackout, Testbilder, Steuerzentrale, Telemetrie |
| `compositor.rs` | bringt das fertige LED-Bild ins Fenster (1:1, gestreckt oder eingepasst) |
| `hub.rs`, `kinect.rs`, `kinect_gpu.rs` | Hub-Client, Kinect-Daten, Ausspielen der Personen, GPU-Texturen |
| `persons.rs`, `wall.rs`, `wall_persons.rs` | Personen, Wand-Abbildung (Projektionen), Personen auf der Wand |
| `shader_pass.rs` | `createShaderPass` mit demselben WGSL-Vorspann |
| `canvas.rs`, `audio.rs`, `patterns.rs` | 2D-Zeichnen, Ton, Testbilder |
| `scenes/` | die Szenen |
| `bin/fake_hub.rs` | Test-Hub |
