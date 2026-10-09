# Erklärvideo der Kinect-Wand

Motion-Canvas-Projekt für ein Video von etwa 1:30 min, das erklärt, wie die Installation funktioniert. Es braucht weder Kinect noch Hub: Die Kinect-Bilder werden aus einer simulierten 3D-Szene mit simulierten Personen berechnet. Wie das Video aufgebaut ist, steht in [KONZEPT.md](KONZEPT.md).

```bash
cd erklaervideo
npm install
npm start                                  # Editor: http://localhost:9000 (Video oder Social-Fassung wählen; Vorschau, Zeitleiste, Render-Knopf)
npm run render                             # ganzes Video → output/kinect-wand.mp4 (1080p, 60 fps)
npm run render -- --fps 30                 # schnellere Vorschau
npm run stills -- 12 30.5 47               # Einzelbilder (Sekunden) → output/stills/
npm run stills -- --body natur 19 75       # dasselbe mit den weich schattierten Figuren (Standard: lowpoly)
npm run stills -- --project figuren --out output/fig 8 33.5   # Modellblatt der Figuren (vorne, Seite, hinten)
python3 tools/sheet.py output/stills sheet.jpg 2   # Kontaktabzug der Einzelbilder (braucht Pillow)
npm run check-arms                         # prüft jedes Bild beider Fassungen: kein Arm gestreckt nach vorne (nach jeder Choreo-Änderung)
npm run sound                              # Tonspur neu → src/audio/soundtrack.m4a (nach Änderungen an Timing, Choreo oder Klängen)
node tools/sound.mjs --levels              # dasselbe ohne neues Sammeln der Cues, mit Pegel jedes Klangs
node tools/sound.mjs --solo swarm,glint    # nur diese Klänge, ohne Teppich → output/solo.wav (zum Probehören)

# die kurze Fassung für Social Media (Instagram Reel, 9:16)
npm run render:social                      # → output/kinect-wand-social.mp4 (1080 × 1920, 30 fps, mit Ton)
npm run stills:social -- 3 20 40           # Einzelbilder (Sekunden der kurzen Fassung) → output/stills/
npm run sound:social                       # ihre Tonspur neu → src/audio/soundtrack-social.m4a
```

`render` und `stills` starten Vite und einen unsichtbaren Chrome/Edge (`tools/render.mjs`, Browser per `CHROME_PATH` wählbar). Im Editor geht dasselbe über „Video Settings“ → „Render“ (Exporter FFmpeg ist voreingestellt, Ergebnis in `output/`).

Das Video hat Ton (Effekte und ein leiser Klangteppich, alles synthetisiert, siehe [KONZEPT.md](KONZEPT.md#ton)); es funktioniert auch stumm. Die Tonspur ist `src/audio/soundtrack.m4a` und kommt beim Rendern automatisch dazu. Ändert sich das Timing einer Szene, `npm run sound` neu laufen lassen, sonst passt der Ton nicht mehr zum Bild.

Abspielen auf dem Notebook in Schleife, zum Beispiel mit VLC (Wiedergabe → Endlosschleife) oder `ffplay -loop 0 -fs output/kinect-wand.mp4`.

## Aufbau

| Datei | Was |
|---|---|
| `src/scenes/s1-…s10-*.tsx` | die zehn Szenen (Ablauf, Texte, Kamera); s9 ist der Abspann, s10 „Cottbus ist bunt“ → „Die Zukunft ist bunt“ |
| `src/nodes/LedLogo.ts`, `LucideIcon.ts`, `LedFlag.ts` | das Modern-Events-Logo als LED-Punktfeld, die Icons der Kontaktkarte, die wehende Regenbogenflagge aus LED-Punkten |
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
| `src/lib/sound.ts` | `cue()`: die Szenen markieren damit, wann welcher Klang kommt (auf der Story-Uhr) |
| `src/social.ts`, `src/scenes/social/`, `src/lib/portrait.ts` | die kurze Fassung für Social Media (siehe unten) |
| `tools/sound.mjs`, `tools/sound/` | die Tonspur: sammelt die Cues (`render.mjs cues`), synthetisiert die Klänge (`sfx.mjs`, Bausteine in `dsp.mjs`), folgt den Händen der Figuren und ihren Winkgesten (`motion.mjs`), pegelt jeden Klang nach `LEVEL`, Hall, Echo, sanfte Höhen, -17 LUFS |

## Social-Fassung

`src/social.ts` ist ein zweites Projekt: dieselbe Geschichte als Instagram Reel, 1080 × 1920 (9:16), 57 s statt 99 s. Statt Abspann und Flagge endet es mit der Nacht der kreativen Köpfe: dem NDKK-Logo und „Station Ludwig-Leichhardt-Gymnasium“ (r9, im Look von ndkk.de; das Logo liegt in Buchstaben zerlegt in `src/assets/ndkk/`, siehe `src/lib/ndkk.ts`). Die Szenen liegen in `src/scenes/social/` (r1 … r8, je eine Hochformat-Fassung von s1 … s8) und nutzen dieselben Bausteine (`Stage`, `SensorPanel`, `WallView`, die Icons der Datenkette in `src/nodes/pipeline.tsx`), mit größerer Schrift (`textScale`).

- **Zeitplan und Choreografie:** `timeline.ts` und `choreo.ts` haben für die kurze Fassung eigene Zeiten (`CUT === 'social'`); `src/lib/cut-social.ts` schaltet um und muss in `social.ts` als Erstes importiert werden. Die Leute machen dieselben Gesten, nur schneller hintereinander.
- **Layout:** `src/lib/portrait.ts`. Instagram legt oben (Name) und unten (Beschreibung, Knöpfe rechts) eigene Dinge über das Reel und zeigt im Feed nur die mittleren 4:5 (1080 × 1350). Deshalb steht der Satz jeder Szene groß oben in der Mitte (mit dunklem Verlauf dahinter), die Kinect-Bilder sitzen unter der 3D-Ansicht, und nichts Wichtiges liegt in den äußeren Rändern.
- **Kameras:** `SOCIAL_SHOTS` in `shots.ts` (das Sichtfeld ist senkrecht: im Hochformat ist das Bild gleich hoch, aber viel schmaler).

## Story-Uhr

Alles hängt an einer Story-Uhr (Sekunden ab Videostart). Die Figuren, die Kinect und das Fluid sind Funktionen dieser Uhr, deshalb sind die Schnitte zwischen den Szenen unsichtbar. Jede Szene muss genau so lang sein, wie `timeline.ts` sagt; ist eine länger, meldet `npm run stills` das.
