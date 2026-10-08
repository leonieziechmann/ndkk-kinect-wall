# kinect-hub

Middleware für die Kinect v2: **ein** Prozess besitzt den Sensor, rechnet alles, was jeder Client braucht, **einmal pro Frame** vor und streamt das Ergebnis an beliebig viele Clients (Browser/WebGPU, Python, Rust, …) per WebSocket und HTTP.

```
Kinect ─USB─▶ fn2_capture.exe   (C++/libfreenect2 + OpenCL, eigener Prozess)
                 │ stdout: Tiefe+IR (float), Kameraparameter, Status, Heartbeat
                 ▼
           kinect-hub.exe       (Rust)
             Supervisor  – startet den Worker, Watchdog, Neustart mit Backoff
             Pipeline    – einmal pro Frame: Filter, u16/u8, Statistik, XYZ, Entzerrungs-LUT
             Fan-out     – „latest only“: langsame Clients überspringen Frames statt zu verzögern
                 │ ws://127.0.0.1:8090/ws  +  http://127.0.0.1:8090/api/…
                 ▼
           Szenen im Browser (web/, ein Vite-Dev-Server je Worktree), kinect_hub.py, eigene Agenten …
```

## Start

```
cargo build --release                      # im Ordner kinect-hub
kinect-hub\target\release\kinect-hub.exe   # aus dem Projektordner
```

Optionen (`--help`): `--bind 0.0.0.0:8090` (LAN statt nur localhost), `--source synthetic` (generierte Testszene ohne Kinect), `--source replay DATEI` (Aufnahme in Schleife abspielen, s. u.), `--pipeline fast|cl` (Tiefen-Dekodierung, s. u.), `--persons on|off`, `--persons-delay 12`, `--smoothing 0.4`, `--max-clients 64`, `--allow-origin URL`, `--web-dir` (z. B. `web/dist` für gebaute Szenen), `--worker`, `--pose dml|cpu|off`, `--pose-hz 15`, `--pose-model`, `--pose-model-fast`, `--onnxruntime` (s. u. „Posen“). Logging über `RUST_LOG=debug`.

Für die Posen einmal je Checkout `powershell -NoProfile -ExecutionPolicy Bypass -File kinect-hub\setup-onnxruntime.ps1` (holt `onnxruntime.dll`, s. u.). Ohne läuft der Hub wie bisher, nur ohne Posen.

Der Worker `fn2/bin/fn2_capture.exe` wird mit `sh fn2/build.sh` gebaut. Er braucht den libusbK-Treiber auf „Xbox NUI Sensor (Interface 0)“.

## Endpunkte

| | |
|---|---|
| `GET /` | Startseite aus `web/`: Status, 2D-Vorschau und die Szenen aller angemeldeten Dev-Server |
| `GET /api` | maschinenlesbare Beschreibung von allem hier (für Agenten) |
| `GET /api/status` | Sensorzustand, fps, Latenz, Clients, Worker, Fehlerzähler, Statistik des letzten Frames |
| `GET /api/params` | Intrinsik und Verzeichnung der Tiefenkamera (aus der Kinect gelesen) |
| `GET /api/lut` | Entzerrungstabelle: f32 x,y je Pixel |
| `GET /api/frame/{depth,depth_raw,ir,points,meta}` | neuester Frame binär; `?format=png` für depth (16 Bit, mm) und ir |
| `GET /api/poses` | neueste Posen (JSON wie der Stream `poses`). Eine Anfrage hält das Modell 5 s am Laufen, die erste bekommt eventuell `poses: null` |
| `GET /ws` | WebSocket-Stream |
| `GET /api/devservers` | Register der Szenen-Dev-Server (Vite, einer je Worktree) mit ihren Szenen |
| `POST /api/devservers` | Dev-Server meldet sich an: `{url: "http://127.0.0.1:<port>", label, branch, worktree, hub, pid, scenes: [...]}`. Alle paar Sekunden wiederholen, Einträge verfallen nach 15 s. Erledigt das Vite-Plugin in `web/tools/`. |
| `DELETE /api/devservers?url=…` | Dev-Server meldet sich ab |

## WebSocket-Protokoll

Nach dem Verbinden schickt der Hub `{"type":"hello",…}` mit allen Streams und den aktuellen Parametern. Der Client abonniert:

```json
{"type": "subscribe", "streams": ["depth", "lut", "meta"], "max_fps": 30}
{"type": "ping", "t": 123}
```

`subscribe` ersetzt das bisherige Abo. `max_fps` ist optional (z. B. 5 für ein Überwachungsskript). `ping` wird mit `{"type":"pong","t":…,"server_time_us":…}` beantwortet, das dient für Uhrabgleich und RTT.

| Stream | Nachricht |
|---|---|
| `depth` | binär, kind 1: u16 Tiefe in mm (0 = kein Messwert), zeitlich geglättet |
| `depth_raw` | binär, kind 2: u16 mm, ungefiltert |
| `ir` | binär, kind 3: u8 Infrarot-Helligkeit (Wurzel-Tonemapping) |
| `points` | binär, kind 4: i16 x,y,z in mm je Pixel (nur berechnet, solange jemand abonniert) |
| `lut` | `{"type":"params",…}` + binär kind 16: f32 x,y je Pixel; kommt beim Abo und bei jedem Sensorstart |
| `meta` | `{"type":"frame",…}` je Frame: seq, Zeitstempel, Statistik (min/max/Median/Schwerpunkt) |
| `status` | `{"type":"status",…}` einmal pro Sekunde (standardmäßig abonniert) |
| `poses` | `{"type":"poses", seq, capture_time_us, publish_time_us, model, ms, poses: [{score, box: [u0,v0,u1,v1], kp: 17 × (u, v, Konfidenz)}]}` in der Pose-Rate; Pixel wie die Frames (gespiegelt), COCO-17. Das Modell läuft nur, solange jemand abonniert |

**Binär-Header** (32 Byte, little-endian), danach die Nutzdaten:

```
u32 magic "K2H1" (0x3148324B) | u8 kind | u8 version | u16 header_len (32)
u32 seq | u16 width (512) | u16 height (424) | u64 capture_time_us | u64 publish_time_us
```

Die Zeiten sind µs seit 1970 auf der Uhr des Hub-Rechners. `capture_time_us` ist der Moment, in dem der fertige Tiefenframe aus libfreenect2 kam.

**Koordinaten:** Kamerakoordinaten der Kinect: x nach rechts, y nach unten, z nach vorn, Einheit mm. 3D-Punkt eines Pixels: `(lut.x * z, lut.y * z, z)`. Die LUT enthält die Linsenentzerrung, die der Hub einmal pro Sensorstart berechnet. Das Kinect-Bild kommt gespiegelt; für eine echte 3D-Ansicht x negieren (machen die Szenen standardmäßig, Taste `m`).

## Tiefen-Dekodierung

Der Worker dekodiert die Rohdaten der Kinect standardmäßig selbst auf der CPU (`--pipeline fast`, `fn2/fast_depth.cpp`): dasselbe Verfahren wie libfreenect2s OpenCL-Pipeline (drei Frequenzen, bilateraler Filter, Phasen-Unwrapping, Kantenfilter), aber mit vorberechneter Trigonometrie, AVX2 und vier Threads. Die GPU bleibt damit ganz für Szenen und Pose-Modell.

- **Qualität:** auf 233 aufgenommenen Rohpaketen gegen OpenCL im Median 0,00 mm Abweichung, 0,01 % der Pixel mehr als 1 mm, je Frame 2 Pixel weniger und 15 mehr gültig als OpenCL (`fn2/depth_bench`).
- **Zeit:** 5,7 ms je Frame (4 Threads), 13,5 ms auf einem; OpenCL 7–12 ms GPU-Zeit.
- **Unter einer Szene, die die GPU sättigt** (live gemessen, 3840×2160): Sensor 29,8 statt 23–25 fps mit OpenCL; die Szene verliert dabei 4 fps (56 statt 60), weil CPU und iGPU sich das Strombudget teilen, und der Worker braucht 1,8 statt 0,2 CPU-Kerne. Ohne GPU-Last 0,7 Kerne.
- Die Helfer-Threads laufen mit niedriger Priorität und geben der Szene den Vortritt, wenn die CPU knapp ist (`FN2_FAST_THREADS`, `FN2_FAST_PRIORITY=normal` im Environment des Hubs ändern das).
- Ohne AVX2/FMA nimmt der Worker OpenCL. `--pipeline cl` erzwingt OpenCL; ein älterer Worker kennt `fast` nicht und nimmt dann ebenfalls OpenCL.
- Neue Rohdaten zum Vergleichen: `fn2/bin/fn2_rawdump.exe --out recordings/raw-NAME.k2raw --seconds 8` (braucht die Kinect, also Hub kurz stoppen), dann `fn2/bin/depth_bench.exe recordings/raw-NAME.k2raw` (vergleicht mit libfreenect2 OpenCL und misst die Zeit, ohne Kinect).

## Posen

Der Hub erkennt die Körperhaltung der Menschen vor der Kinect selbst: YOLO11n-pose (`web/lib/models/`) auf dem Infrarotbild, mit ONNX Runtime auf der GPU über DirectML (`src/pose.rs`, `src/yolo.rs`). Das Ergebnis ist dasselbe wie im Browser (`web/lib/persons-pose.js`), es kostet aber nur etwa ein Drittel der GPU-Zeit und wird einmal für alle Clients gerechnet. Messungen und Vergleich: `pose-bench/README.md`.

- **Eigener Thread:** Er nimmt das neueste Bild, sobald die nächste Pose fällig ist (`--pose-hz`, Standard 15). Die Frames warten nie auf ihn. Das Modell rechnet nur, solange jemand `poses` abonniert hat oder `/api/poses` fragt.
- **Zwei Größen:** Liegt `web/lib/models/yolo11n-pose-384-fp16.onnx` neben dem Standardmodell (oder `--pose-model-fast`), springt der Hub auf das kleine Modell, wenn das große fünfmal hintereinander länger als 90 % der Periode braucht. Alle 3 s probiert er das große wieder (die Pose zählt mit) und kehrt zurück, sobald es dreimal unter 60 % bleibt. Jede Pose nennt ihr `model`. Gemessen unter hoher GPU-Last: 512×448 ≈ 58 ms, 384×320 ≈ 30 ms.
- **ONNX Runtime** wird zur Laufzeit geladen: `onnxruntime.dll` neben der exe, sonst `kinect-hub/onnxruntime/` (füllt `setup-onnxruntime.ps1`: NuGet-Paket Microsoft.ML.OnnxRuntime.DirectML 1.24.4, die neueste Version mit DirectML; prüft Prüfsumme und Microsoft-Signatur; nicht im Git). `DirectML.dll` bringt Windows mit.
- **Fehler:** Fehlen DLL oder Modell oder scheitert DirectML, läuft der Hub ohne Posen weiter. `/api/status` → `pose` sagt warum (`state`: `off`, `loading`, `idle`, `running`, `error`), und der Hub versucht es alle 10 s neu. Eine DLL oder ein Modell, das später dazukommt, wird also ohne Neustart übernommen. Abstürze im Pose-Thread werden abgefangen und gezählt.
- **Status** (`pose` in `/api/status`): Gerät, geladene Modelle mit ihrer Zeit nach dem Laden, aktives Modell, Ziel- und erreichte Rate, ms je Lauf, Zahl der Wechsel und der Grund des letzten.

## Personen

Der Hub verfolgt die Personen selbst (`src/tracking.rs` mit der Bibliothek `persons/`, dem Tracker aus `web/lib/persons-core.js` in Rust) und schickt das Ergebnis an alle Clients; Szenen mit `streams: ['persons']` nutzen es automatisch (`web/lib/persons.js`), ältere Hubs ohne diese Streams fallen auf den Tracker im Browser zurück.

- **Streams:** `persons_live` (jedes Frame sofort) und `persons` (jedes Frame, sobald die Pose eines späteren Frames da ist; Skelette dazwischen interpoliert, höchstens `--persons-delay` Frames, Standard 12). Je Ergebnis JSON (`type`, `seq`, `capture_time_us`, `persons` mit den Feldern aus `web/PERSONS.md`, `floor`, `ms`, `pose_ms`) und danach die Labels als binäre Nachricht (kind 5 bzw. 6, Lauflängen: je Lauf u8 Slot, u16 Länge; ~19 KB statt 217 KB).
- Der Tracker übergibt die Frames selbst an das Pose-Modell (jede Pose wird mit den Labels ihres Frames verglichen) und läuft nur, solange jemand abonniert. `GET /api/persons` liefert das neueste JSON und hält ihn 5 s am Laufen.
- **Gleich gut wie im Browser:** Der Backtest (`persons/examples/backtest.rs`, wie `recordings/backtest/backtest.mjs`) gibt auf allen vier Backtest-Aufnahmen dieselben Kennzahlen (Keypoint-Fehler, Flackern, IDs, Verzögerung). 2–5 ms je Frame statt 12–30 ms in Node; optischer Fluss mit AVX2.
- Gemessen (Replay mit bis zu 4 Personen, `person-skeleton`): 14,5 Posen/s statt 4,7 im Browser, exakte Ausgabe nach 150 statt 415 ms, weniger GPU-Last. Status in `/api/status` → `tracking`. Ein Absturz im Tracker wird abgefangen, er beginnt neu.

## Eigene Clients

- **Browser:** Szenen entstehen in `web/scenes/<name>/` und laufen über einen Vite-Dev-Server mit Hot-Swap, siehe [`web/README.md`](../web/README.md) und [`web/AGENTS.md`](../web/AGENTS.md). Für eine schlichte Seite ohne Build genügt `import { KinectStream } from '/lib/kinect-stream.js'`; der Hub liefert `web/` direkt aus.
- **Python:** `kinect_hub.py` im Projektordner: `Hub().depth()`, `.points()`, `.status()` per HTTP (nur Standardbibliothek + numpy), Live-Stream mit `Hub().stream([...])` (braucht `pip install websockets`). `viewer.py --hub` und `pointcloud.py --hub` lesen ebenfalls vom Hub.
- **Andere Origins:** Seiten von anderen localhost-Ports (z. B. Vite) sind erlaubt. Fremde Origins nur mit `--allow-origin`, damit keine beliebige Website den Tiefenstream deines Zimmers lesen kann.

## Aufnahme und Wiedergabe

Steht gerade niemand vor der Kinect, sehen Szenen nur einen leeren Raum. Eine Aufnahme liefert echte Daten mit Menschen, Bewegung und Sensorrauschen, und zwar bei jedem Lauf dieselben. So lassen sich Szenen reproduzierbar entwickeln und vergleichen.

```
kinect-hub-probe record --seconds 30 --out recordings/NAME.k2rec            # vom laufenden Hub aufnehmen
kinect-hub --source replay recordings/NAME.k2rec --bind 127.0.0.1:8091       # eigener Hub, spielt sie in Schleife ab
```

**Aufnahme** (`kinect-hub-probe record`):
- Liest vom **laufenden** Hub per WebSocket (`--url`, Standard `ws://127.0.0.1:8090/ws`), nie direkt vom Sensor. Der Haupt-Hub läuft dabei ungestört weiter.
- Abonniert `depth_raw`, `ir` und `lut`. Die Kameraparameter kommen aus `hello`/`params`.
- Speichert jeden Frame mit seinem `capture_time_us`.
- Strg+C beendet früher und behält das Aufgenommene.
- Eine vorhandene Datei wird nicht überschrieben.
- Am Ende liest der Recorder die Datei zur Kontrolle zurück und meldet Frames, Dauer, fps und vom Stream übersprungene Frames.
- Größe: etwa 20 MB/s, 30 s ≈ 590 MB.

**Wiedergabe** (`--source replay DATEI`):
- Spielt die Aufnahme endlos im originalen Frame-Takt ab. Pausen über 1 s (z. B. ein Sensorneustart während der Aufnahme) werden auf 1 s gekürzt.
- Läuft durch dieselbe Pipeline wie die Kinect, also mit Glättung für `depth`, `points`, Statistik und PNGs.
- `depth_raw` und `ir` kommen Byte für Byte so heraus, wie sie aufgenommen wurden. Kameraparameter und LUT stammen aus der Datei.
- `seq` zählt fortlaufend ab 0. `capture_time_us` ist der Zeitpunkt der Wiedergabe, Latenzmessungen stimmen also.
- `/api/status` meldet `"source": "replay"`, das Sensor-Detail nennt Datei, Frames und Länge.
- Fehlt die Datei oder ist sie kaputt, zeigt der Status `offline` mit dem Grund. Die API läuft weiter, und der Hub versucht es alle 5 s erneut, eine ersetzte Datei wird also übernommen. Eine abgebrochene Aufnahme spielt bis zum letzten vollständigen Frame.
- Ein relativer Pfad, den es im aktuellen Ordner nicht gibt, wird auch oberhalb der `kinect-hub.exe` gesucht. `recordings/NAME.k2rec` funktioniert deshalb auch aus einem Worktree, solange man das Hub-Exe des Hauptordners startet.
- Ein Replay-Hub fasst die Kinect nie an. Er kann auf einem eigenen Port neben dem Haupt-Hub laufen, beliebig viele gleichzeitig.

**Format `.k2rec`** (little-endian, Details in `src/recording.rs`):

```
Dateikopf, 32 Byte:
  u32 magic "K2RC" | u32 version (1) | u32 header_len (Offset des ersten Frames)
  | u16 width (512) | u16 height (424) | u32 info_len | u32 lut_len | u64 reserviert (0)
info_len Byte JSON:  {"params": {Kameraparameter wie vom Hub gesendet}, "recorded_at_us", "source_url", "hub_source", …}
lut_len Byte:        Nutzdaten der lut-Nachricht: f32 x,y je Pixel
dann Frames bis zum Dateiende, je 24 Byte Kopf und Pixel:
  u32 magic "K2RF" | u32 seq | u64 capture_time_us | u16 flags (1 = IR folgt) | u16 reserviert
  | u32 payload_len | u16 Tiefe[512*424] in mm (depth_raw) | u8 ir[512*424] (ir-Stream)
```

Es gibt keine Frame-Anzahl im Kopf, damit eine abgebrochene Aufnahme lesbar bleibt. Für die Wiedergabe rechnet der Hub die IR-Bytes in Rohwerte zurück, die sein Tonemapping wieder auf genau dieselben Bytes abbildet.

**Datenschutz:** Aufnahmen zeigen den Raum und die Menschen darin. Sie gehören nach `recordings/` (wie `*.k2rec` per `.gitignore` ausgeschlossen) und werden nie committet oder hochgeladen.

## Robustheit

- Im Code gibt es kein `unwrap`, `expect`, `panic!` und keine ungeprüfte Indizierung (Clippy-Lints auf `deny`). Fehler werden behandelt und geloggt.
- **libfreenect2 läuft nie im Hub.** Stürzt der Worker ab, hängt er (5 s ohne Heartbeat) oder spinnt die Kinect, beendet der Hub ihn und startet ihn neu (Backoff 0,25–5 s). Gemessen: harter Kill bis wieder Bilder kommen ≈ 1,1 s; die Clients bleiben verbunden.
- Stirbt der Hub, merkt der Worker das an seinem geschlossenen stdin und gibt die Kinect sauber frei. Es bleibt kein verwaister Prozess zurück.
- **Standby:** Ein zweiter Hub auf demselben Port fasst die Kinect nicht an, sondern wartet. Fällt der erste aus, übernimmt er nach ≈ 3 s. Browser-Clients verbinden sich automatisch neu.
- Jeder Client läuft in einer eigenen Task:
  - Senden hat ein Timeout von 5 s. Ein Client, der nicht mehr liest, wird getrennt.
  - Steuernachrichten sind auf 64 KB und 20/s begrenzt.
  - Unbekanntes oder Kaputtes beantwortet der Hub mit `{"type":"error"}`.
  - Höchstens 64 Clients; weitere bekommen HTTP 503.
- Panics in Tasks, Threads oder der Frame-Verarbeitung werden abgefangen und gezählt (`errors` in `/api/status`).
- Ist der Port belegt, versucht der Hub es weiter. Fehlt der Worker, liefert der Hub die API trotzdem und zeigt den Grund im Status.
- Dev-Server-Register:
  - Anmelden darf nur ein Prozess auf diesem Rechner, nie eine Browserseite (Origin-Header → 403).
  - Grenzen: höchstens 64 Einträge, 64 KB je Anmeldung, nur `http://127.0.0.1|localhost|[::1]:<port>`, Texte werden gekürzt und gesäubert.
  - Ein abgestürzter Dev-Server verschwindet nach 15 s.
- Der Worker startet den Sensor erst nach 2 s ohne Frame neu. Die Tiefenberechnung teilt sich die GPU mit den Browser-Szenen, und bei Volllast kommen Frames nur langsamer, sie fehlen nicht. Ein Neustart würde dann nur weitere 3 s Pause bringen.

## Latenz

Gemessen mit 5 gleichzeitigen Clients auf derselben Maschine:

| | |
|---|---|
| Worker → Hub (Pipe) | ≈ 0,8 ms |
| Vorberechnung (ein Durchlauf über alle Pixel, schreibt direkt in die fertigen Nachrichten) | ≈ 2,3 ms |
| Sensorframe → Client empfangen | **≈ 6–7 ms** im Mittel, 30 fps, keine übersprungenen Frames |

Hilfreich dafür sind `TCP_NODELAY`, geteilte Puffer (kein Kopieren pro Client) und der „latest only“-Kanal (kein Rückstau).

## Testen

```
kinect-hub-probe stream --clients 5 --seconds 10 --streams depth,ir,meta   # fps, Latenz, Lücken je Client
kinect-hub-probe abuse                                                       # Missbrauchstest, s. u.
kinect-hub-probe abuse --url ws://127.0.0.1:8093/ws                          # dasselbe gegen einen Replay-Hub
```

Ohne Kinect oder für reproduzierbare Messungen: einen Replay-Hub auf einem freien Port starten (`--source replay recordings/NAME.k2rec --bind 127.0.0.1:8093`) und die Probe mit `--url` darauf richten.

`abuse`: Ein gesunder Client misst durchgehend, während andere angreifen:
- Müll senden, fluten, übergroße Nachrichten schicken, nicht mehr lesen
- 300 Verbindungen auf- und abbauen, das Client-Limit sprengen, 40 PNGs parallel holen
- das Dev-Server-Register mit Müll, fremden URLs, Browser-Origins, übergroßen und zu vielen Anmeldungen bombardieren

Am Ende muss der Hub weiter 30 fps liefern und 0 Fehler zählen, und die Register-Zeile endet mit `OK`.
