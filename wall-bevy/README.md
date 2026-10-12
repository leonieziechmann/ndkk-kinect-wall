# wall-bevy: die LED-Wand als native App

`wall-bevy` ist alles, was die LED-Wand braucht, in einem Programm (Rust, Bevy 0.20, wgpu): die
Ausgabe auf dem Wand-Bildschirm, die Show, die Szenen und die **Steuerzentrale**, die das Programm
selbst ausliefert, am Notebook und als Fernbedienung auf Handy oder Tablet im selben Netz. Kein
Browser-Fenster, kein Node, kein Dev-Server.

Warum nativ: Das Bild soll nie ruckeln. Im Browser teilten sich die Szene, der Compositor, die
Garbage Collection und die Steuerzentrale einen Takt; hier gehört der Takt der Ausgabe allein
(Messung: [`BENCHMARK.md`](BENCHMARK.md)). Wie die Wand gedacht ist (Setup, Projektion, Sperrzonen,
Show-Regeln): [`WALL.md`](WALL.md); die Personen: [`PERSONS.md`](PERSONS.md).

## Bauen (einmal je Checkout)

```
rustup update stable          # Bevy 0.20 braucht Rust 1.97 oder neuer
cd wall-bevy
cargo build --release         # beim ersten Mal 10–20 min, danach Sekunden
```

Das baut den ganzen Workspace: die Ausgabe, das Framework `wall` und jede Szene als eigene Bibliothek.
Alles liegt dann in `wall-bevy\target\release\` (`target/` ist nicht in git): `wall-bevy.exe`,
`wall.dll` (das Framework), `std-*.dll` (Rusts Standardbibliothek, die sich alle teilen; das
Build-Skript kopiert sie aus der Toolchain) und je Szene eine `wall_scene_<name>.dll`. Immer den ganzen
Workspace bauen, nie ein Paket allein mit `-p`: die Bibliotheken müssen zur Ausgabe passen, in die sie
geladen werden.

## Starten

Für die Ausstellung mit dem Launcher im Projektordner: Er startet den Hub und `wall-bevy` auf dem
Wand-Bildschirm, öffnet die Steuerzentrale als Fenster auf dem Notebook, startet neu, was ausfällt,
und stimmt Windows für die Show ab.

```
start-wand.cmd
```

Allein, ohne Launcher (der Hub muss laufen):

```
wall-bevy\target\release\wall-bevy.exe
```

Ohne Optionen: Hub `127.0.0.1:8090` (oder `KINECT_HUB`), die Dokumente der Wand im Datenordner
(siehe unten), die Steuerzentrale auf Port 8095. Die Ausgabe geht randlos auf den Bildschirm der
Wand: den aus dem Wand-Setup (in der Steuerzentrale gewählt), sonst den linkesten, der nicht der
Hauptbildschirm ist. Ohne zweiten Bildschirm öffnet sich ein Fenster auf dem Hauptbildschirm, bis
einer angeschlossen wird. Beenden: Alt+F4 im Ausgabefenster (oder `quit.flag` im Launcher, siehe
`start-wand.ps1`).

| Option | |
|---|---|
| `--hub 8091` / `host:port` / URL | anderer Hub, z. B. ein Replay-Hub |
| `--scene NAME [-p key=wert ...]` | nur diese Szene statt der Show |
| `--windowed` | normales Fenster (zum Ausprobieren auf einem Bildschirm) |
| `--monitor N\|NAME`, `--screen X,Y,B,H` | Bildschirm erzwingen (Nummer, Name oder Desktop-Rechteck) |
| `--fps N` | Bildrate begrenzen |
| `--vsync fifo\|mailbox\|immediate` | Darstellung; Standard `fifo` (gleichmäßig, nie Risse) |
| `--data DIR` | Datenordner (Standard: `KINECT_WALL_DIR`, sonst `wall-bevy/data/` des Haupt-Checkouts) |
| `--control-port N`, `--control-bind IP` | Port der Steuerzentrale (Standard 8095, 0 = keine) und wo sie lauscht (Standard `0.0.0.0` = auch im Netz; `127.0.0.1` = nur dieser Rechner) |
| `--control-dir DIR` | die Seite der Steuerzentrale aus `DIR` statt der eingebauten (zum Bearbeiten: `--control-dir control`, Neuladen im Browser genügt) |
| `--mute`, `--no-control` | ohne Ton, ohne Steuerzentrale |
| `--shots DIR --seconds S [--shot-every T]` | Test: S Sekunden spielen, Bilder und Bildzeiten nach DIR (als Fenster in LED-Größe; mit `--monitor`/`--screen` randlos auf dem Bildschirm) |
| `--list-scenes` | alle Szenen-Deklarationen als JSON ausgeben und beenden |
| `--watch [DIR]` | Szenen beim Speichern selbst neu bauen und im laufenden Bild austauschen (DIR: der Workspace `wall-bevy/`, Standard: der, aus dem das Programm gebaut ist) |
| `--new-scene NAME` | neue Szene aus der Vorlage anlegen (`scenes/NAME/`) und beenden |

## Steuerzentrale

Die Steuerzentrale ist eine Seite, die `wall-bevy` selbst ausliefert (HTTP und WebSocket in eigenen
Threads; die Dateien unter `control/` sind ins Programm eingebaut). Am Rechner der Ausgabe:
**`http://127.0.0.1:8095/`** (der Launcher öffnet sie als App-Fenster). Ist 8095 belegt, nimmt die
Ausgabe den nächsten freien Port und schreibt die Adresse ins Log und nach `control.json` im
Datenordner.

- **Show:** Ablauf mit Werten je Eintrag, Szenen-Liste (▶ sofort zeigen, + in die Show), Weiter/Zurück,
  Blackout, automatisch weiter mit Wartezeiten, Übergänge.
- **Live:** Vorschau des LED-Bilds (etwa 5 Bilder/s, nur solange eine Seite sie zeigt), was läuft,
  Personen, Kinect, Bildrate.
- **Projektion, Wand-Setup, Testbilder, Status:** wie in [`WALL.md`](WALL.md) beschrieben.
- **Tasten** am Rechner: `→`/`←` weiter/zurück, `B` Blackout.

**Fernbedienung:** Ein Handy oder Tablet im selben Netz öffnet dieselbe Seite (schmal angeordnet). Im
Tab „Fernbedienung“ steht ein QR-Code mit Adresse und Code: einmal scannen, und das Gerät bleibt
gekoppelt (Cookie, 400 Tage), bis dort „Neuen Code erzeugen“ gedrückt wird (nur am Rechner der
Ausgabe; das meldet alle gekoppelten Geräte ab). Ohne Kamera: Adresse öffnen, Code eintippen. Nach
10 falschen Codes von einer Adresse ist 10 Minuten Pause. Seiten am Rechner selbst
(`127.0.0.1`/`localhost`) brauchen keinen Code.

**Windows-Firewall:** Beim ersten Start fragt Windows, ob `wall-bevy` im Netzwerk erreichbar sein darf:
„Private Netzwerke“ erlauben. Wer keine Fernbedienung will: `--control-bind 127.0.0.1`.

**Datenordner** (`wall-bevy/data/` des Haupt-Checkouts, eine Wand für alle Worktrees; nicht in git):

| Datei | |
|---|---|
| `setup.json`, `projection.json`, `show.json` | Wand-Setup, Projektionen, Show (die Steuerzentrale schreibt sie über die Ausgabe) |
| `bevy-store.json` | was Szenen sich merken (z. B. Bestenlisten) |
| `control-code.txt` | der Kopplungs-Code der Fernbedienung |
| `control.json` | Adresse und Port der Steuerzentrale, solange die Ausgabe der Show läuft (für `start-wand`; Testfenster mit `--windowed`, `--scene` oder `--watch` schreiben sie nicht) |

Die Ausgabe schreibt die Dokumente kurz nach einer Änderung (atomar) und merkt, wenn ein anderes
Programm sie ändert. Beim ersten Start übernimmt sie Setup, Projektionen und Show der früheren
Browser-Ausgabe aus `web/.cache/wall/`, falls es den Ordner noch gibt. Mit `--shots` (Test) bleiben
die Dokumente unangetastet und die Steuerzentrale aus.

## Was es gegen Ruckler tut

- **Ein fester Takt:** Vsync (`fifo`), höchstens zwei Bilder unterwegs. Szenen mit Bildraten-Grenze
  (`max_fps: 30`) rendern jedes zweite Anzeigebild, immer im gleichen Abstand; die Ausgabe zeigt
  trotzdem jedes Anzeigebild.
- **Nichts Schweres im Takt:** Hub-Verbindung und das Entpacken der Tiefenbilder und Personen-Masken
  laufen in einem eigenen Thread (Puffer werden wiederverwendet), das Einrichten einer Szene in
  einem Worker-Thread (die laufende spielt weiter), JPEG-Vorschauen werden asynchron gelesen und in
  einem eigenen Thread kodiert. Die Steuerzentrale (Netz, Dokumente, Speichern) läuft in eigenen
  Threads; die Ausgabe reicht ihr nur Nachrichten weiter und wartet nie auf sie.
- **Keine Shader-Übersetzung beim Szenenwechsel:** Beim Start wird jede Szene einmal eingerichtet
  und ein paar Bilder lang unsichtbar gerendert; alle Pipelines liegen danach im Cache.
- **Personen im Takt der Anzeige:** Die Personen werden nach der Aufnahmezeit des Sensors
  ausgespielt, mit einer kleinen, sich selbst einstellenden Verzögerung, phasenstarr zum
  Anzeigetakt. So kommt jedes Kinect-Bild gleich lange auf die Wand, auch wenn Netz und Hub
  schwanken.
- **Fehler halten die Show nicht an:** Jede Szene läuft in einem eigenen GPU-Fehlerbereich; eine
  Szene mit Fehlern wird nach 2 s neu versucht und nach drei Fehlern in 30 s übersprungen. Ein
  verlorenes GPU-Gerät wird neu aufgebaut. Unter Windows läuft die Ausgabe mit Priorität „höher als
  normal“ und ohne Energiespar-Drosselung (wie der Hub in `start-wand`).
- **Wenig CPU neben der Show:** Bevys eigene Systeme laufen ohne Thread-Pool (sie sind winzig; der
  Pool kostete nur das Wecken seiner Threads, gemessen rund 10 % eines Kerns). Die CPU bleibt für Hub,
  Tiefenberechnung und Posenmodell. `WALL_EXECUTOR=multi` schaltet Bevys Standard zum Vergleich ein.

## Szenen

Jede Szene ist eine eigene Crate in `scenes/<name>/` und wird zu einer eigenen Bibliothek gebaut. Die
Ausgabe lädt beim Start alle, die neben ihr liegen, und lädt eine Bibliothek neu, sobald sie neu gebaut
ist: Die laufende Szene wird im Bild ausgetauscht, ohne dass die Ausgabe beendet wird. Eine Bibliothek,
die gegen einen anderen Stand des Frameworks gebaut ist, lädt sie nicht (Build-ID).

Die Szenen: blasen-platzen, cyberspiegel, depth-shader, fluid-simulation, fruit-ninja, hallo-wand,
invaders-tracking, leonie-ziechmann, live-exakt, llg-sakura, modern-events, neon-room, person-mask,
person-skeleton, pixel-jump-run, pixel-spiegel, pointcloud, space-invaders, three-points,
wand-spiegel. Bis auf `hallo-wand` (die Beispielszene) sind sie aus dem Browser portiert: Logik und
Shader Zeile für Zeile, auch die Zufallsgeneratoren mit ihren Startwerten. Die Browser-Fassung
(`web/`) ist entfernt; sie liegt in der Git-Historie.

Die Steuerzentrale listet jede geladene Szene mit Titel und Parametern (sie fragt die Ausgabe, nicht
den Quelltext); eine neu gebaute erscheint dort, sobald die Ausgabe sie geladen hat. Ein Show-Eintrag
mit einer Szene, die es nicht gibt, ist dort rot markiert und wird übersprungen.
`wall-bevy --list-scenes` gibt dieselben Deklarationen als JSON aus (Name, Titel, Parameter,
Projektionswünsche, Personen-Optionen, Bildraten-Grenze).

### Szenen hier entwickeln

```
target\release\wall-bevy.exe --new-scene meine-szene              # scenes/meine-szene/ aus der Vorlage
target\release\wall-bevy.exe --watch --scene meine-szene --windowed
```

Mit `--watch` baut die Ausgabe eine Szene nach jedem Speichern selbst neu (mit niedriger Priorität)
und tauscht sie aus: vom Speichern bis zum neuen Bild 1,2 s bei einer kleinen Szene, 2,9 s bei
fruit-ninja (6.500 Zeilen; Release-Profil, gemessen auf einer VM mit 4 Kernen). Ohne `--watch` lädt sie
Szenen, die jemand anderes baut (`cargo build --release`), genauso; so lässt sich eine Szene auch in der
laufenden Show austauschen. Ändert sich das Framework (`wall/`) oder die Ausgabe (`src/`), muss die
Ausgabe neu gebaut und gestartet werden. Wie eine Szene geschrieben wird (Deklaration, `setup`,
`frame`, Zeichnen, Personen, UI-Bausteine, Ton): [`SCENES.md`](SCENES.md); die Beispielszene ist
`scenes/hallo-wand`. Alles Weitere der Szenen-API (eigene Shader, Kinect-Daten auf der GPU):
[`PORTING.md`](PORTING.md).

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

Wie sich `wall-bevy` gegen die frühere Browser-Ausgabe schlägt, steht in [`BENCHMARK.md`](BENCHMARK.md)
(gemessen, bevor der Browser-Teil entfernt wurde; das Messskript `bench/compare.mjs` liegt in der
Git-Historie).

## Aufbau

Drei Teile in einem Workspace: die Ausgabe (`src/`), das Framework (`wall/`, eine Bibliothek, die
Ausgabe und Szenen teilen) und die Szenen (`scenes/*`, je eine Bibliothek).

| Datei | |
|---|---|
| `src/main.rs` | Fenster, Bildschirmwahl, Bevy-Plugins |
| `src/output.rs` | die Ausgabe: Show, Übergänge, Blackout, Testbilder, Telemetrie |
| `src/control/` | Server der Steuerzentrale: HTTP, WebSocket, Kopplung, die Dokumente im Datenordner |
| `control/` | die Seite der Steuerzentrale (HTML, JS, CSS ohne Build-Schritt, ins Programm eingebaut) |
| `src/scenes.rs`, `src/devbuild.rs`, `src/newscene.rs` | Szenen-Bibliotheken laden und austauschen, `--watch`, `--new-scene` |
| `src/compositor.rs` | bringt das fertige LED-Bild ins Fenster (1:1, gestreckt oder eingepasst) |
| `src/audio.rs`, `src/patterns.rs` | Tonausgabe, Testbilder |
| `src/bin/fake_hub.rs` | Test-Hub |
| `wall/src/scene.rs`, `sketch.rs` | was eine Szene ist (`Scene`, `SceneDef`), die kurze Form (`Sketch`, `wall::scene!`) |
| `wall/src/draw.rs`, `ui.rs`, `particles.rs`, `people.rs` | 2D auf der GPU, UI-Bausteine, Partikel, Personen in LED-Pixeln |
| `wall/src/hub.rs`, `kinect.rs`, `kinect_gpu.rs` | Hub-Client, Kinect-Daten, Ausspielen der Personen, GPU-Texturen |
| `wall/src/persons.rs`, `map.rs`, `wall_persons.rs` | Personen, Wand-Abbildung (Projektionen), Personen auf der Wand |
| `wall/src/shader_pass.rs` | Shader-Pass mit dem WGSL-Vorspann für Kinect, Personen und Wand |
| `wall/src/canvas.rs`, `audio.rs`, `common/` | 2D auf der CPU, Ton erzeugen, Helfer der Szenen |
| `scenes/<name>/` | die Szenen |
