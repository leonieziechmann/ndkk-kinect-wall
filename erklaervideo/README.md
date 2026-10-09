# Erklärvideo der Kinect-Wand

Motion-Canvas-Projekt für ein Video von etwa 1:30 min, das erklärt, wie die Installation funktioniert. Es braucht weder Kinect noch Hub: Die Kinect-Bilder werden aus einer simulierten 3D-Szene mit simulierten Personen berechnet. Wie das Video aufgebaut ist, steht in [KONZEPT.md](KONZEPT.md).

```bash
cd erklaervideo
npm install
npm start                                  # Editor: http://localhost:9000 (Vorschau, Zeitleiste, Render-Knopf)
npm run render                             # ganzes Video → output/kinect-wand.mp4 (1080p, 60 fps)
npm run render -- --fps 30                 # schnellere Vorschau
npm run stills -- 12 30.5 47               # Einzelbilder (Sekunden) → output/stills/
npm run stills -- --body natur 19 75       # dasselbe mit den weich schattierten Figuren (Standard: lowpoly)
npm run stills -- --project figuren --out output/fig 8 33.5   # Modellblatt der Figuren (vorne, Seite, hinten)
python3 tools/sheet.py output/stills sheet.jpg 2   # Kontaktabzug der Einzelbilder (braucht Pillow)
npm run check-arms                         # prüft jedes Bild: kein Arm gestreckt nach vorne (nach jeder Choreo-Änderung)
```

`render` und `stills` starten Vite und einen unsichtbaren Chrome/Edge (`tools/render.mjs`, Browser per `CHROME_PATH` wählbar). Im Editor geht dasselbe über „Video Settings“ → „Render“ (Exporter FFmpeg ist voreingestellt, Ergebnis in `output/`).

Abspielen auf dem Notebook in Schleife, zum Beispiel mit VLC (Wiedergabe → Endlosschleife) oder `ffplay -loop 0 -fs output/kinect-wand.mp4`.

## Aufbau

| Datei | Was |
|---|---|
| `src/scenes/s1-…s10-*.tsx` | die zehn Szenen (Ablauf, Texte, Kamera); s9 ist der Abspann, s10 „Die Zukunft ist bunt“ |
| `src/nodes/LedLogo.ts`, `LucideIcon.ts`, `RainbowFlag.ts` | das Modern-Events-Logo als LED-Punktfeld, die Icons der Kontaktkarte, die wehende Regenbogenflagge |
| `src/lib/timeline.ts` | wann jede Szene auf der Story-Uhr beginnt; `at(szene, t)` für Zeiten relativ zur Szene |
| `src/lib/choreo.ts` | wer wann wohin läuft und welche Geste macht |
| `src/lib/people.ts` | die Figuren: Skelett aus 22 Punkten, Gehen (Gangzyklus, Standbein) und Gesten |
| `src/lib/body/` | die Körper als Dreiecksnetze: `styles.ts` (Low-Poly oder Natürlich, Kleidung, Haare), `raster.ts` (zeichnet sie mit Tiefenpuffer), `looks.ts` (Farben pro Person, Licht) |
| `src/lib/world.ts` | der Raum: LED-Wand (12 × 2 Panels à 0,5 × 1 m) an Flugtraverse und Slings, Truss als Rohre, Kinect auf Foto-Stativ, Möbel |
| `src/lib/testpattern.ts` | das Testbild auf der Wand: Raster der Steuerzentrale (`web/lib/wall-output.js`) mit einer Farbe pro Panel |
| `src/lib/sensor.ts` | die simulierte Kinect: Tiefe, Infrarot, Masken, Optical Flow, Boxen, Keypoints (512 × 424, 30 Bilder/s) |
| `src/lib/fluid.ts`, `mapping.ts` | das Fluid auf der Wand und wie Menschen auf die Wand abgebildet werden |
| `src/lib/shots.ts` | Kamerapositionen der 3D-Ansichten |
| `src/nodes/Stage.ts` | die 3D-Bühne (Linien, Figuren, Punktwolke, Skelette) |
| `src/figuren.ts`, `src/scenes/figuren.tsx` | ein zweites Projekt nur zum Vergleichen der Figuren-Stile |
| `src/nodes/SensorPanel.ts`, `WallView.ts` | die Kinect-Bilder mit KI-Overlay, die Wand von vorne |

Alles hängt an einer Story-Uhr (Sekunden ab Videostart). Die Figuren, die Kinect und das Fluid sind Funktionen dieser Uhr, deshalb sind die Schnitte zwischen den Szenen unsichtbar. Jede Szene muss genau so lang sein, wie `timeline.ts` sagt; ist eine länger, meldet `npm run stills` das.
