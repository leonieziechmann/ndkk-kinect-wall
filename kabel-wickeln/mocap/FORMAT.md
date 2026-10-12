# Take-Format: Gelenkdaten eines Takes

Der Vertrag zwischen der Auswertung (`auswerten.py`: `.k2rec` → Gelenke), der synthetischen Testaufnahme (`synthetic/generate.ts`: bekannte Bewegung → `.k2rec` + Wahrheit in diesem Format) und dem Retargeting (Gelenke → Figuren der Animation). Wer etwas ändert, ändert es hier und in allen drei zugleich und erhöht `version`.

Version 1. Angelegt mit der synthetischen Testaufnahme; `synthetic/pruefen.py` liest es. Die Auswertung schreibt dazu einige **optionale** Felder (Abschnitt „Was die Auswertung zusätzlich schreibt“); sie ändern nichts an den Pflichtfeldern, Leser übergehen Felder, die sie nicht kennen. Prüfen: `auswertung/take.py` (`check()`).

## Datei

- `mocap/takes/<shot>_t<take>.json.gz`, z. B. `p1.coil.teach_t1.json.gz`: gzip-komprimiertes JSON (UTF-8). Im Browser: `new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).json()`.
- Nur Gelenkdaten, keine Bilder. Ins Repository nur mit deinem Okay. Bis dahin schreibt `auswerten.py` nach `<Hauptordner>/recordings/mocap/takes/` (privat, von git ausgeschlossen); `--ins-repo` schreibt nach `mocap/takes/`.
- Eine zweite Person im selben Take (nur `p6.lift.pair`): `<shot>_t<take>_p2.json.gz` mit `person: 2`.
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

## Was die Auswertung zusätzlich schreibt (optional)

`auswerten.py` (`auswertung/pipeline.py`) füllt die Pflichtfelder so:

- `t` ist immer gleichmäßig, `{"t0": …, "dt": 1/30}`: Die Auswertung rechnet auf ein genaues 30-fps-Raster um (Aufnahmezeiten mit Lücken → gleichmäßige Zeit). `t0` ist der Beginn des Takes in s seit dem ersten Frame der `.k2rec`; vorne fällt alles vor „Klatschen − 1 s“ weg (`--ganz` behält alles).
- `how`: `D` Tiefe am Keypoint passt zum Körperbau; `B` auf dem Sichtstrahl des Keypoints mit der Knochenlänge gesetzt (Tiefe fehlt, gehört zu etwas davor, oder springt); `I` aus den Nachbarframes interpoliert (kubisch, Lücken bis 1 s; auch verworfene Ausreißer); `-` fehlt. Die Positionen sind geglättet (robuste lokale quadratische Regression, etwa ±0,1 s), auch bei `D`.
- `conf`: 2D-Konfidenz des Modells × Faktor nach `how` (D 1, B 0,7, I 0,45 und weniger, je länger die Lücke).
- Gelenkmitten: die Tiefe sieht die Haut; die Auswertung schiebt den Punkt entlang der Sichtlinie um einen festen Abstand nach hinten (`meta.radius_mm`: Schulter 50, Ellbogen 40, Handgelenk 25, Hüfte 90, Knie 55, Knöchel 45, Fingergelenke 10, Fingerspitzen 0 …).
- Abgeleitete Gelenke: `pelvis` = Mitte der Hüften; `neck` = Mitte der Schultern, 0,11 Schulterbreiten zum Kopf hin (entlang Becken → Schultern); `head` = Mitte der Ohren (fehlen sie: Mitte der Augen, 8 cm nach −z). So liegen sie auch in der Wahrheit.
- `cable`: `null`, wenn die Kabelsuche aus war (`--kabel aus`), sonst je Frame die Polylinien (Punkte etwa 2 cm auseinander) mit `conf` aus Kontrast, Länge und Tiefenanteil. Experimentell: Lage nahe den Händen und darunter, keine Zuordnung der Linien von Frame zu Frame.
- `markers.clap`: Minimum des Abstands der Hände nach schneller Annäherung, zwischen den Frames verfeinert; `null`, wenn keins gefunden wurde. `start`/`end`: Näherung aus der Bewegung (erste Bewegung nach der Ruhe nach dem Klatschen, letzte Bewegung vor der Endpose).
- `floor.source`, `floor.measured`: aus welcher Aufnahme der Boden kommt (leerer Raum `cal.<Aufbau>.empty` derselben Platzierung oder der Take selbst). `world.mark_mm` ist die **geplante** Marke aus `shots.json` (`world.mark_note` sagt das), nicht gemessen.

Zusätzliche Felder:

| Feld | Inhalt |
|---|---|
| `person` | nur ab der zweiten Person: `2` (fehlt = 1, die Hauptperson) |
| `hands` | je Frame `{"left": …, "right": …}`, je Hand `null` (fehlt) oder `{"origin": [x, y, z] (mm, WELT, = Handgelenk), "axes": [9 ganze Zahlen] (x-, y-, z-Achse als Einheitsvektoren × 1000, nacheinander), "curl": [Daumen, Zeige-, Mittel-, Ring-, kleiner Finger] (0 gestreckt … 100 Faust, `null` = unbekannt), "conf": 0 … 100 (kleinste Konfidenz von wrist, index_mcp, middle_mcp, pinky_mcp), "low": true/false (conf < 40)}`. Achsen: x vom Handgelenk zu `middle_mcp`; y zur Daumenseite (`index_mcp − pinky_mcp`, senkrecht zu x); z aus dem Handrücken heraus (rechte Hand x × y, linke y × x). Handfläche oben ⇔ z zeigt nach unten. Krümmung: Summe der Beugewinkel (Finger: Mittelhand→Grundglied, PIP, DIP, ohne Spreizen; Daumen: MCP, IP) durch 270° (Daumen 150°). |
| `quality` | außer `joints` (dort zusätzlich `outliers`: verworfene Messungen): `frames_recorded`, `frames_skipped_by_hub`, `person_found` (Anteil der gerechneten Frames mit Person), `cable_frames`, `floor` (`pitch_deg`, `roll_deg`, `inliers`, `angle_vs_take`: Boden des leeren Raums gegen den des Takes), `clap` (`time`, `gap_mm`, `speed_m_s`, `searched`, …), `activity` (Schwelle für Beginn/Ende), `bones_fixed`, `warnings` (Text, deutsch) |
| `meta` | `program`, `models` (Detektor, Top-down-Modelle, Gerät), `every`, `flip`, `person`, `bones_mm` (Knochenlängen der Person, `"<eltern>-<kind>"`), `trim`, `signal_in_recording_s`, `smoothing`, `max_gap_s`, `seconds`, `radius_mm` |

`jitter_mm` in `quality.joints` ist bei der Auswertung die robuste Streuung der Messungen um die geglättete Kurve (1,48 × Median der Abstände).
