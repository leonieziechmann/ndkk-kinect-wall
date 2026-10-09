# Erklärvideo der Kinect-Wand

Motion-Canvas-Projekt für ein Video von etwa 1:30 min, das erklärt, wie die Installation funktioniert. Es braucht weder Kinect noch Hub: Die Kinect-Bilder werden aus einer simulierten 3D-Szene berechnet. Wie das Video aufgebaut ist, steht in [KONZEPT.md](KONZEPT.md); welche echten Aufnahmen die simulierten Figuren ersetzen sollen, in [AUFNAHMEN.md](AUFNAHMEN.md).

```bash
cd erklaervideo
npm install
npm start                                  # Editor: http://localhost:9000 (Vorschau, Zeitleiste, Render-Knopf)
npm run render                             # ganzes Video → output/kinect-wand.mp4 (1080p, 60 fps)
npm run render -- --fps 30                 # schnellere Vorschau
npm run stills -- 12 30.5 47               # Einzelbilder (Sekunden) → output/stills/
python3 tools/sheet.py output/stills sheet.jpg 2   # Kontaktabzug der Einzelbilder (braucht Pillow)
```

`render` und `stills` starten Vite und einen unsichtbaren Chrome/Edge (`tools/render.mjs`, Browser per `CHROME_PATH` wählbar). Im Editor geht dasselbe über „Video Settings“ → „Render“ (Exporter FFmpeg ist voreingestellt, Ergebnis in `output/`).

Abspielen auf dem Notebook in Schleife, zum Beispiel mit VLC (Wiedergabe → Endlosschleife) oder `ffplay -loop 0 -fs output/kinect-wand.mp4`.

## Aufbau

| Datei | Was |
|---|---|
| `src/scenes/s1-…s8-*.tsx` | die acht Szenen (Ablauf, Texte, Kamera) |
| `src/lib/timeline.ts` | wann jede Szene auf der Story-Uhr beginnt |
| `src/lib/choreo.ts` | wer wann wohin läuft und welche Geste macht |
| `src/lib/people.ts` | die einfachen Figuren: Skelett aus 22 Punkten, Körper aus Kapseln |
| `src/lib/world.ts` | der Raum: LED-Wand, Truss, Kinect, Möbel (Maße aus `web/WALL.md`) |
| `src/lib/sensor.ts` | die simulierte Kinect: Tiefe, Infrarot, Masken, Optical Flow, Boxen, Keypoints (512 × 424, 30 Bilder/s) |
| `src/lib/fluid.ts`, `mapping.ts` | das Fluid auf der Wand und wie Menschen auf die Wand abgebildet werden |
| `src/lib/shots.ts` | Kamerapositionen der 3D-Ansichten |
| `src/nodes/Stage.ts` | die 3D-Bühne (Linien, Punktwolke, Skelette) |
| `src/nodes/SensorPanel.ts`, `WallView.ts` | die Kinect-Bilder mit KI-Overlay, die Wand von vorne |

Alles hängt an einer Story-Uhr (Sekunden ab Videostart). Die Figuren, die Kinect und das Fluid sind Funktionen dieser Uhr, deshalb sind die Schnitte zwischen den Szenen unsichtbar. Jede Szene muss genau so lang sein, wie `timeline.ts` sagt; ist eine länger, meldet `npm run stills` das.
