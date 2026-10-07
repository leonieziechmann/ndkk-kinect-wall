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
           web/ (WebGPU), kinect_hub.py, eigene Agenten …
```

## Start

```
cargo build --release                      # im Ordner kinect-hub
kinect-hub\target\release\kinect-hub.exe   # aus dem Projektordner
```

Optionen (`--help`): `--bind 0.0.0.0:8090` (LAN statt nur localhost), `--source synthetic` (generierte Testszene ohne Kinect), `--pipeline cl|cpu`, `--smoothing 0.4`, `--max-clients 64`, `--allow-origin URL`, `--web-dir`, `--worker`. Logging über `RUST_LOG=debug`.

Der Worker `fn2/bin/fn2_capture.exe` wird mit `sh fn2/build.sh` gebaut. Er braucht den libusbK-Treiber auf „Xbox NUI Sensor (Interface 0)“.

## Endpunkte

| | |
|---|---|
| `GET /` | Web-Clients aus `web/` (Startseite mit Status und 2D-Vorschau, `/pointcloud/` = WebGPU) |
| `GET /api` | maschinenlesbare Beschreibung von allem hier (für Agenten) |
| `GET /api/status` | Sensorzustand, fps, Latenz, Clients, Worker, Fehlerzähler, Statistik des letzten Frames |
| `GET /api/params` | Intrinsik und Verzeichnung der Tiefenkamera (aus der Kinect gelesen) |
| `GET /api/lut` | Entzerrungstabelle: f32 x,y je Pixel |
| `GET /api/frame/{depth,depth_raw,ir,points,meta}` | neuester Frame binär; `?format=png` für depth (16 Bit, mm) und ir |
| `GET /ws` | WebSocket-Stream |

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

**Binär-Header** (32 Byte, little-endian), danach die Nutzdaten:

```
u32 magic "K2H1" (0x3148324B) | u8 kind | u8 version | u16 header_len (32)
u32 seq | u16 width (512) | u16 height (424) | u64 capture_time_us | u64 publish_time_us
```

Die Zeiten sind µs seit 1970 auf der Uhr des Hub-Rechners. `capture_time_us` ist der Moment, in dem der fertige Tiefenframe aus libfreenect2 kam.

**Koordinaten:** Kamerakoordinaten der Kinect: x nach rechts, y nach unten, z nach vorn, Einheit mm. 3D-Punkt eines Pixels: `(lut.x * z, lut.y * z, z)`. Die LUT enthält die Linsenentzerrung, die der Hub einmal pro Sensorstart berechnet. Das Kinect-Bild kommt gespiegelt; für eine echte 3D-Ansicht x negieren (macht `/pointcloud/` standardmäßig, Taste `m`).

## Eigene Clients

- **Browser:** Seite unter `web/<name>/` anlegen, `import { KinectStream } from '/lib/kinect-stream.js'`. Die Dateien liefert der Hub ohne Neustart aus. Ein Beispiel steht auf der Startseite, der WebGPU-Renderer liegt unter `web/pointcloud/main.js`.
- **Python:** `kinect_hub.py` im Projektordner: `Hub().depth()`, `.points()`, `.status()` per HTTP (nur Standardbibliothek + numpy), Live-Stream mit `Hub().stream([...])` (braucht `pip install websockets`). `viewer.py --hub` und `pointcloud.py --hub` lesen ebenfalls vom Hub.
- **Andere Origins:** Seiten von anderen localhost-Ports (z. B. Vite) sind erlaubt. Fremde Origins nur mit `--allow-origin`, damit keine beliebige Website den Tiefenstream deines Zimmers lesen kann.

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
```

`abuse`: Ein gesunder Client misst durchgehend, während andere Müll senden, fluten, übergroße Nachrichten schicken, nicht mehr lesen, 300 Verbindungen auf- und abbauen, das Client-Limit sprengen und 40 PNGs parallel holen. Am Ende muss der Hub weiter 30 fps liefern und 0 Fehler zählen.
