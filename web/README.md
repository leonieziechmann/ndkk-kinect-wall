# web/ – Szenen-Werkstatt

Hier entstehen die Szenen für die Kinect-Wand: Browser-Visuals (WebGPU, three.js), die live auf das Tiefenbild reagieren. Der **kinect-hub** liefert die Daten. Ein **Vite-Dev-Server** liefert die Szenen aus und tauscht eine Szene beim Speichern aus, ohne dass die Seite neu lädt.

Das Ganze ist für viele Agenten gleichzeitig gedacht. Jeder arbeitet in seinem eigenen Worktree mit eigenem Dev-Server. Alle Szenen erscheinen zusammen auf der Startseite des Hubs, und dort blätterst du mit `,` und `.` durch alle Varianten.

```
Kinect ─▶ kinect-hub (Rust, :8090, läuft einmal) ── WebSocket, direkt ──▶ Szene im Browser
              ▲ meldet sich an (alle 5 s)                                   ▲ Szenen-Code, Hot-Swap
              └──────────── Vite-Dev-Server je Worktree (:5173, :5174, …) ──┘
```

Agenten lesen [AGENTS.md](AGENTS.md): Szenen-API, Vorlagen und Regeln. Für Effekte mit Menschen: [PERSONS.md](PERSONS.md) (Personenerkennung: Masken, Skelette, Koordinaten, Rezepte).

## Loslegen

Voraussetzungen: Node.js 20 oder neuer, und der Hub läuft (`kinect-hub\target\release\kinect-hub.exe` aus dem Hauptordner).

```
cd web
npm install
npm run dev
```

| Was | Wo |
|---|---|
| Szenen aller Worktrees | http://127.0.0.1:8090/ |
| Galerie dieses Worktrees | http://127.0.0.1:5173/ (Port steht in der Ausgabe von `npm run dev`) |
| eine Szene | http://127.0.0.1:5173/scenes/pointcloud/ |

| Befehl | |
|---|---|
| `npm run dev` | Dev-Server. Er nimmt den nächsten freien Port ab 5173 und meldet sich beim Hub an. |
| `npm run new <name> [vorlage]` | neue Szene als Kopie einer vorhandenen (Standard: `depth-shader`) |
| `npm run check [szene …]` | rendert headless auf der echten GPU: Fehler, fps, Kinect-Bildrate, Screenshot nach `.cache/shots/` |
| `npm run build` | statischer Build nach `dist/`, für die Wand ohne Node |

## In einer Szene

- **Tasten:**
  - `h` blendet die Bedienelemente aus und ein.
  - `f` schaltet Vollbild.
  - `m` spiegelt, und zwar alle Szenen gleich.
  - `,` und `.` wechseln zur vorigen oder nächsten Szene, über alle Worktrees.
  - In 3D-Szenen: Maus ziehen dreht, Mausrad zoomt, Leertaste schaltet den Auto-Orbit, `r` oder Doppelklick setzt die Ansicht zurück.
- **Parameter (rechts oben):** Was du verstellst, bleibt gespeichert und ist gelb markiert. „Zurücksetzen“ holt die Werte aus dem Code zurück, „Werte kopieren“ legt sie als JSON in die Zwischenablage, etwa für einen Agenten.
- **HUD (links unten):** Bildrate, Kinect-Bildrate und die Latenz vom Sensor bis zum Bild (gemessen 12–19 ms). Es blendet sich aus, wenn die Maus ruht.
- **URL-Optionen:**
  - `?hub=8091` nimmt einen anderen Hub, z. B. einen, der eine Aufnahme abspielt (`--source replay`), oder den synthetischen.
  - `?fps=30` begrenzt die Bildrate.
  - `?kiosk` blendet alle Bedienelemente aus, für die Wand.
  - `?nothumb` lädt kein Vorschaubild hoch.

## Aufbau

| Datei | |
|---|---|
| `index.html` | Galerie. Der Hub liefert sie unter `/` aus und zeigt dann alle Worktrees. |
| `scene.html` | Seite für jede `/scenes/<name>/`-URL |
| `lib/runtime.js` | lädt die Szene: Renderloop, HUD, Fehleranzeige, Hot-Swap, Vorschaubilder, Tasten |
| `lib/kinect-data.js` | `ctx.kinect`: neueste Frames, „neu“-Flags, GPU-Texturen und -Puffer, die sich selbst aktualisieren |
| `lib/kinect-stream.js` | WebSocket-Client für den Hub, ohne Abhängigkeiten |
| `lib/shader-pass.js` | Vollbild-WGSL-Shader mit Kinect-Daten, Parametern als Uniforms und Feedback |
| `lib/camera.js`, `lib/params.js`, `lib/hub.js` | Orbit-Kamera, Parameter-Panel (lil-gui), Hub-URL und Szenenlisten |
| `lib/persons*.js`, `lib/models/` | Personenerkennung (`streams: ['persons']`): YOLO-Pose auf dem Infrarotbild in einem eigenen Worker, Maske je Tiefenframe mit gelerntem Hintergrund, Skelett zwischen den Posen interpoliert, s. [AGENTS.md](AGENTS.md) |
| `tools/vite-plugin-kinect.js` | Routen `/scenes/<name>/` und `/__scenes`, Vorschaubilder, Hot-Swap, Anmeldung beim Hub |
| `tools/new-scene.mjs`, `tools/check.mjs` | `npm run new`, `npm run check` (puppeteer-core mit dem installierten Chrome/Edge) |
| `scenes/<name>/` | eine Szene: `main.js` und `scene.json` (Titel, Beschreibung) |

Beispielszenen, zugleich Vorlagen:

| Szene | Inhalt |
|---|---|
| `pointcloud` | die Punktwolke im Referenz-Look, rohes WebGPU |
| `depth-shader` | Höhenlinien als einzelner WGSL-Shader |
| `three-points` | three.js-Partikel |
| `person-mask` | nur die Menschen in 2D, jede Person in ihrer Tracking-Farbe |
| `person-skeleton` | Strichmännchen aller Personen (nur Skelett, sehr günstig), leuchtende Hände, Spuren |
| `neon-room` | nur die Menschen als Punktwolken in einem virtuellen Neon-Raum |

## Gut zu wissen

- **Die GPU wird geteilt.** Die Tiefenberechnung der Kinect (OpenCL im Worker) läuft auf derselben iGPU wie die Szenen. Eine Szene, die die GPU voll auslastet, drückt die Kinect-Bildrate.
  - Der Worker startet den Sensor erst nach 2 s ohne Bild neu, sonst würde er bei Last ständig neu starten.
  - Die Szene zeigt dann einen Hinweis, und `npm run check` schlägt fehl.
  - Abhilfe: `maxFps: 30` in der Szene oder `?fps=30`.
- **Wand ohne Node:** `npm run build`, danach `kinect-hub.exe --web-dir web/dist` und im Browser `http://127.0.0.1:8090/scenes/<name>/?kiosk`.
- **Privatsphäre:** Vorschaubilder und Screenshots in `.cache/` zeigen den Raum und die Menschen darin. Sie sind git-ignoriert und bleiben lokal.
- **Latenz:** Die Szenen verbinden sich direkt mit dem Hub, nicht über einen Vite-Proxy. Der Hub braucht 2–4 ms bis zum Senden, dann folgt die Darstellung im nächsten Frame.
- **Personen:** `streams: ['persons']` liefert `ctx.persons` (jede Person mit ID, Farbe, Maske und Skelett in Welt-, Raum- und Bildkoordinaten). Jedes Bild wartet auf die nächste Pose (etwa 150–250 ms) und bekommt dafür ein genaues Skelett; die ganze Szene läuft gleichmäßig um diese Zeit versetzt. In der Szene `persons: { delay: 0 }` schaltet auf live, `persons: { mode: 'skeleton' }` rechnet nur Skelette (ohne Masken, viel günstiger). Alles Weitere: [PERSONS.md](PERSONS.md).
