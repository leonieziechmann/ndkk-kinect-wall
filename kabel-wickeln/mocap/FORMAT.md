# Take-Format: Gelenkdaten eines Takes

Der Vertrag zwischen der Auswertung (`auswerten.py`: `.k2rec` → Gelenke), der synthetischen Testaufnahme (`synthetic/generate.ts`: bekannte Bewegung → `.k2rec` + Wahrheit in diesem Format) und dem Retargeting (Gelenke → Figuren der Animation). Wer etwas ändert, ändert es hier und in allen drei zugleich und erhöht `version`.

Version 1. Angelegt mit der synthetischen Testaufnahme; `synthetic/pruefen.py` liest es.

## Datei

- `mocap/takes/<shot>_t<take>.json.gz`, z. B. `p1.coil.teach_t1.json.gz`: gzip-komprimiertes JSON (UTF-8). Im Browser: `new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).json()`.
- Nur Gelenkdaten, keine Bilder. Ins Repository nur mit deinem Okay.
- Die Wahrheit einer synthetischen Aufnahme hat dasselbe Format (`kind: "truth"`) und liegt neben ihr: `output/synthetic/<name>.truth.json.gz`.

## Koordinaten

**KAMERA** (Tiefenkamera der Kinect, *ungespiegelt*), mm: x nach rechts, wie vom Sensor aus in die Szene gesehen; y nach unten; z nach vorn (optische Achse). Der Hub liefert das Bild gespiegelt: Pixel (u, v) mit Tiefe z ergibt den Hub-Punkt (lut.x·z, lut.y·z, z) und den KAMERA-Punkt **(−lut.x·z, lut.y·z, z)**. Die LUT (mit Linsenentzerrung) steht in der `.k2rec`.

**Boden** in KAMERA: Höhe eines KAMERA-Punkts p über dem Boden = `floor.normal · p + floor.d_mm` (Normale: Einheitsvektor nach oben).

**WELT** (für die Animation), mm im Take (m = mm / 1000): y nach oben, Boden bei y = 0, Ursprung auf dem Boden senkrecht unter dem Sensor, +z waagrecht von der Person zum Sensor (die Kamera schaut entlang −z, um ihre Neigung gekippt), x = y × z, also nach rechts, wie vom Sensor aus gesehen. Eine Person, die zur Kinect schaut, schaut nach +z, ihre linke Hand ist auf der +x-Seite. Genauer: −z ist die Blickrichtung der Kamera, auf den Boden projiziert; zielt die Kinect auf die Marke (so steht es im Aufnahmeplan), liegt die Marke bei x = 0.

`world.cam_to_world`: 4 × 4, zeilenweise, KAMERA-mm → WELT-mm: `p_welt = R · p_kamera + t` mit R = die ersten drei Spalten, t = die vierte Spalte. Die zweite Zeile von R ist `floor.normal`, t = (0, `floor.d_mm`, 0).

## Felder

| Feld | Inhalt |
|---|---|
| `format`, `version` | `"kabel-wickeln-take"`, `1` |
| `kind` | `"take"` (Auswertung) oder `"truth"` (synthetische Wahrheit) |
| `shot`, `take` | Shot-ID aus `shots.json`, Take-Nummer (Zahl) |
| `source` | Dateiname der `.k2rec`, ohne Pfad |
| `recorded_at` | ISO 8601, UTC (aus `info.recorded_at_us` der Aufnahme) |
| `setup` | Aufbau `A`, `B`, `T`, `C`, `D` |
| `kinect` | geplante Aufstellung: `height_m`, `distance_m`, `yaw_deg`, `pitch_deg` (wie `shots.json`), `note` |
| `fps`, `frames` | Nennrate (30), Zahl der Frames im Take |
| `t` | Zeit jedes Frames in s seit dem **ersten Frame der `.k2rec`**: gleichmäßig `{"t0": 0, "dt": 0.0333…}` oder eine Liste mit einem Wert je Frame (wenn Frames fehlen oder der Take nur ein Ausschnitt ist) |
| `camera` | `width`, `height`, `fx`, `fy`, `cx`, `cy`, `k1`, `k2`, `k3`, `p1`, `p2` (aus `params` der Aufnahme), `mirrored: true`, `frame` (Text) |
| `floor` | `normal` [3], `d_mm`, `rms_mm` (Streuung der Bodenpunkte um die Ebene; 0 bei der Wahrheit), `frame` (Text) |
| `world` | `frame` (Text), `cam_to_world` [16], `sensor_mm` [3], optional `mark_mm` [3] |
| `joints` | die feste Namensliste unten (68 Namen in dieser Reihenfolge) |
| `pos` | je Frame ein flaches Array `[x0, y0, z0, x1, …]`, 3 × 68 ganze Zahlen, mm, WELT; **Gelenkmitten** (im Körper), nicht Punkte auf der Haut. Fehlt ein Gelenk: 0, 0, 0 und `how` = `-` |
| `conf` | je Frame 68 ganze Zahlen 0 … 100 (Konfidenz × 100) |
| `how` | je Frame ein String mit einem Zeichen je Gelenk: `D` aus der Tiefe am Keypoint (Treffer, zur Gelenkmitte versetzt), `I` zeitlich interpoliert, `B` über die Knochenlänge geschätzt (Tiefe fehlt oder passt nicht), `-` fehlt, `T` Wahrheit (nie gemessen) |
| `cable` | optional; je Frame eine Liste von Polylinien `{"pts": [x0, y0, z0, …] (mm, WELT, ganze Zahlen), "conf": 0 … 100}`; eine leere Liste = kein Kabel gefunden |
| `quality` | `joints`: je Gelenkname `{"conf": mittlere Konfidenz 0 … 1, "depth_hits": Anteil der Frames mit Tiefentreffer 0 … 1, "jitter_mm": Zittern}`; weitere Felder frei |
| `markers` | `clap`, `start`, `end`: s, gleiche Zeitbasis wie `t` (Klatschen = Sync-Nullpunkt; Beginn und Ende der Aktion); `null`, wenn unbekannt |
| `meta` | optional, frei: Modelle, Schwellen, Programmversionen |
| `truth` | nur bei `kind: "truth"`, siehe unten |

Das Retargeting rechnet die Zeit relativ zum Klatschen: `t − markers.clap`.

## Gelenke (68, in dieser Reihenfolge)

`left`/`right` sind die Seiten der Person, nicht die Bildseiten (das Bild ist gespiegelt).

| Index | Namen |
|---|---|
| 0–16 | COCO-17: `nose`, `left_eye`, `right_eye`, `left_ear`, `right_ear`, `left_shoulder`, `right_shoulder`, `left_elbow`, `right_elbow`, `left_wrist`, `right_wrist`, `left_hip`, `right_hip`, `left_knee`, `right_knee`, `left_ankle`, `right_ankle` |
| 17–22 | Füße (Reihenfolge wie COCO-WholeBody): `left_big_toe`, `left_small_toe`, `left_heel`, `right_big_toe`, `right_small_toe`, `right_heel` |
| 23–43 | linke Hand, 21 Punkte: `left_hand_` + `wrist`, `thumb_cmc`, `thumb_mcp`, `thumb_ip`, `thumb_tip`, `index_mcp`, `index_pip`, `index_dip`, `index_tip`, `middle_mcp`, `middle_pip`, `middle_dip`, `middle_tip`, `ring_mcp`, `ring_pip`, `ring_dip`, `ring_tip`, `pinky_mcp`, `pinky_pip`, `pinky_dip`, `pinky_tip` (die übliche 21er-Reihenfolge von OpenPose/MediaPipe) |
| 44–64 | rechte Hand, dieselben 21 mit `right_hand_` |
| 65–67 | abgeleitet: `pelvis` (Mitte zwischen den Hüftgelenken), `neck` (Halsansatz, oberes Ende der Wirbelsäule), `head` (Kopfmitte) |

`left_wrist` und `left_hand_wrist` sind derselbe Punkt (ebenso rechts); die Auswertung darf den besseren Wert in beide schreiben.

## Block `truth` (nur synthetisch)

| Feld | Inhalt |
|---|---|
| `motion`, `about`, `person`, `preview_s` | Name der Bewegung, Beschreibung, Figur (`name`, `height_m`), Zeiten für Vorschaubilder |
| `rig_to_world` [16] | Rig-Welt der Animation (`src/people`: y oben, die Person auf der Marke im Ursprung, schaut nach −z), mm → WELT mm |
| `uv_values` | je Frame 2 × 68 Zahlen: Pixel (u, v) jedes Gelenks im gespiegelten Hub-Bild, mit Verzeichnung, 0,1 px genau |
| `zcam_mm` | je Frame 68 ganze Zahlen: z der Gelenkmitte in KAMERA |
| `zsurf_mm` | je Frame 68 ganze Zahlen: z der ersten Oberfläche, die der Sensor an diesem Pixel sieht (vor dem Rauschen) |
| `hit_codes` | je Frame ein String: was dort zu sehen ist: `p` Person, `k` Kabel, `f` Boden, `w` Wand, `s` Seitenwand, `c` Decke, `-` außerhalb des Bildes |
| `visible_codes` | je Frame ein String: `v` gesehen (die Oberfläche liegt höchstens `tolerance_mm` vor der Gelenkmitte), `o` verdeckt, `x` außerhalb des Bildes |
| `tolerance_mm` | je Gelenk, wie weit die Haut vor der Gelenkmitte liegen darf (Rumpf 160, Gliedmaßen 80, Gesicht 50, Füße 50, Hand 35) |
| `room`, `wall_m`, `sensor_model` | der Raum (Ebenen in WELT, Infrarot-Albedo), Abstand der Wand hinter der Marke, Rausch- und Kantenmodell |
| `ik_pos_error_max_mm` | wie weit die Hände der Choreographie ihr Ziel höchstens verfehlt haben (die Wahrheit ist die erreichte Pose) |
