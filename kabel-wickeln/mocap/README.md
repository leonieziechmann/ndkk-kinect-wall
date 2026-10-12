# Motion Capture für „Kabel richtig aufwickeln“

Alle Bewegungen des Videos nimmst du mit der Kinect auf; große Pose-Modelle machen daraus Gelenkdaten, die Figuren bewegen sich dann wie du. Was aufgenommen wird und wie die Kinect steht: [`aufnahmeplan.md`](aufnahmeplan.md), maschinenlesbar in [`shots.json`](shots.json).

## Aufnehmen

Das Aufnahme-Tool `aufnahme.py` (Doppelklick: `aufnahme.cmd`) führt dich Take für Take durch den Plan: Aufbau zeigen, Bild prüfen, Countdown mit Tönen, Startsignal zum Klatschen, zeitgesteuerte Ansagen, automatisches Ende. Aufgenommen wird mit `kinect-hub-probe record` vom laufenden Hub, nie direkt von der Kinect.

### Einmal vorbereiten

- **Python 3.8 oder neuer** von python.org, bei der Installation den Haken „Add python.exe to PATH“ setzen. Pakete braucht das Tool keine.
- **Hub und Probe** sind im Hauptordner gebaut: `kinect-hub\target\release\kinect-hub.exe` und `kinect-hub-probe.exe` (sonst dort `cd kinect-hub` und `cargo build --release`).
- **Bildcheck:** Er nutzt das Pose-Modell des Hubs. Fehlt `onnxruntime.dll`, einmal im Hauptordner:
  `powershell -NoProfile -ExecutionPolicy Bypass -File kinect-hub\setup-onnxruntime.ps1`
  Ohne geht die Aufnahme auch, nur ohne Bildcheck.
- **Speicher:** etwa 20 MB pro Sekunde. Termin 1 sind ≈ 42 GB, Termin 2 ≈ 17 GB, dazu Wiederholungen (`aufnahme.cmd --sessions` rechnet es aus). Das Tool prüft den Platz vor dem Start und vor jedem Take.
- Raum, Licht, Kleidung, Requisiten: [`aufnahmeplan.md`](aufnahmeplan.md#was-du-vorbereitest).

### Starten

1. **Hub starten**, nur den Hub, nicht `start-wand.cmd`. Ein cmd-Fenster öffnen (Windows-Taste, `cmd`, Enter):
   ```
   cd /d C:\Pfad\zu\ndkk-kinect-wall
   kinect-hub\target\release\kinect-hub.exe
   ```
   Das Fenster offen lassen, und starte das Aufnahme-Tool in einem anderen Fenster: Strg+C ginge sonst auch an den Hub. Unter `http://127.0.0.1:8090/api/status` steht dann `"streaming"` und etwa 30 fps. Schließ Szenen und Browser-Tabs mit der Wand, sonst fehlen Bilder.
2. **Doppelklick auf `kabel-wickeln\mocap\aufnahme.cmd`**: Ein Menü fragt, was du aufnehmen willst. Oder gezielt in einem cmd-Fenster:
   ```
   cd /d C:\Pfad\zu\ndkk-kinect-wall\kabel-wickeln\mocap
   aufnahme.cmd --session 1             Termin 1: Aufbau A, B, T
   aufnahme.cmd --session 2             Termin 2: Aufbau C, D
   aufnahme.cmd --session 1 --prio 1    nur das Wichtigste (Prio 1)
   aufnahme.cmd --setup B               nur ein Aufbau
   aufnahme.cmd --shot p3.pair.slow     einzelne Shots, auch als Nummer (A6, B12), mehrere mit Komma
   aufnahme.cmd --from p3.check         ab diesem Shot bis zum Ende seines Termins
   aufnahme.cmd --shot A4 --again       weitere Takes von einem Shot, der schon fertig ist
   aufnahme.cmd --vorschau --setup A    nur das Bild prüfen, ohne Aufnahme
   aufnahme.cmd --list                  alle Shots mit Stand (auch --setup/--prio zum Filtern)
   aufnahme.cmd --sessions              Termine mit Dauer und Speicher
   aufnahme.cmd --setups                Aufbauten mit Kinect-Position
   aufnahme.cmd --status                was schon aufgenommen ist, was offen ist
   aufnahme.cmd --help                  alle Optionen
   ```
3. **Weitermachen** nach einer Pause oder am nächsten Tag: denselben Befehl nochmal. Fertige Shots überspringt das Tool, es geht beim ersten offenen Take weiter.

Hilfreiche Optionen: `--countdown 8` (mehr Zeit bis zur Marke), `--leise` (keine Töne), `--ohne-check` (kein Bildcheck), `--ohne-seite` (keine Großanzeige), `--hub http://127.0.0.1:8091` (anderer Hub).

### Was du siehst

**Vor dem Start:** Hub (Quelle, fps), Probe, geplanter Speicher und freier Platz, dann einmal die Datenschutz-Frage. Die Aufnahmen zeigen dich und deinen Raum; sie bleiben in `recordings/` und werden nie committet oder hochgeladen.

**Großanzeige im Browser** (öffnet sich selbst, sonst `http://127.0.0.1:8097/`): links das Infrarotbild wie ein Spiegel mit dem Skelett des Hubs (grün = Gelenk im Bild, rot = fehlt oder am Rand, gestrichelt = Bildrand), rechts groß Countdown, „Klatschen!“, die Ansagen, die Zeit und Warnungen. Stell den Bildschirm so, dass du ihn von der Marke aus lesen kannst. Im Konsolenfenster steht dasselbe; die Schrift dort wird mit Strg + Mausrad größer.

**Je Aufbau:**
1. Der Aufbau mit Skizze, Höhe, Neigung, Abstand und den Marken, dazu eine Checkliste.
2. Gab es den Aufbau schon: „Steht die Kinect noch genau so?“ Sagst du nein, gilt das als neue Platzierung, und die Kalibrierung kommt nochmal.
3. **Vorschau:** Stell dich auf die Marke, mach die Bewegung, die am meisten Platz braucht, und markier die Bildränder am Boden. Die Zeile unten sagt, ob Person, Gelenke und Abstand passen. Enter = weiter.
4. **Kalibrierung** (leerer Raum, Kabel am Boden, Körper): Sie kommt automatisch vor dem ersten Take des Aufbaus, auch wenn du nur einen einzelnen Shot aufnimmst.

**Je Take:**
1. Der Shot: Rolle, Tempo, Marke, Requisiten, die Variante dieses Takes, „Fehler mit Absicht“, die Ansagen (▶), Hinweise und was die Auswertung braucht. **Enter, Leertaste oder Presenter „Bild ab“ = Start.** `v` = Vorschau, `s` = Shot überspringen, `q` = beenden.
2. **Countdown** 5 s mit kurzen Tönen: Geh auf deine Marke. Bei Shots ohne Person sind es 10 s, damit du aus dem Bild kommst.
3. **Bildcheck** am Ende des Countdowns: Person gefunden, die nötigen Gelenke im Bild (je nach Shot Körper, Hände, Kopf, Füße), Abstand zur Kinect plausibel. Passt etwas nicht, kommt ein tiefer Warnton und die Warnung steht gelb im Bild. Aufgenommen wird trotzdem; du entscheidest danach.
4. **„Still“**: Startpose, bis die Aufnahme läuft, dann noch 2 s.
5. **Startsignal**: hoher, langer Ton und „KLATSCHEN!“. Klatsch einmal, die Hände vor der Brust. Dann „Los“.
6. Die **zeitgesteuerten Ansagen** (Teo und Robin, Heben) kommen mit einem Doppelton. 2 s vor Schluss „Endpose“ (ein Ton): still halten. Nach dem Nachlauf hört die Aufnahme von selbst auf (fallender Ton).
7. **Ergebnis:** Dauer, Bilder, fps, Größe, wann das Startsignal kam, und Warnungen, z. B. „rechte Hand 30 % der Zeit nicht sicher zu sehen“ (während des Takes fragt das Tool zweimal pro Sekunde die Posen ab).
8. **Entscheiden:**

| Taste | |
|---|---|
| Enter, Leertaste, Presenter „Bild ab“ | behalten |
| `w`, Presenter „Bild auf“ | wiederholen (der Take bleibt als verworfen liegen) |
| `x` | löschen und wiederholen (fragt nach) |
| `g` | genug: behalten, die restlichen Takes dieses Shots auslassen |
| `s` | Shot überspringen |
| `n` | Notiz zum Take (z. B. die Zahl der Umdrehungen bei T7) |
| `q`, Esc | beenden (fragt, ob der Take behalten wird) |

**Strg+C während eines Takes** stoppt sauber: Die Probe schließt die Datei ab, das Aufgenommene bleibt, danach kommt das Menü. Strg+C in einer Frage beendet das Tool; der Stand ist gespeichert.

Optionale Shots (A12 Linkshänder, Heben allein oder zu zweit) fragt das Tool vorher ab. Vor einem Shot mit zwei Personen fragt es, ob die zweite Person zugestimmt hat.

### Wo die Dateien landen

Alles im Hauptordner unter `recordings/` (von git ausgeschlossen; das Tool bricht ab, wenn der Ordner nicht ignoriert wäre):

```
recordings/mocap/termin1/p1.coil.teach_t1.k2rec    Aufbau A, B, T
recordings/mocap/termin1/sitzung.json              Sitzungslog und Stand
recordings/mocap/termin2/…                         Aufbau C, D
```

- **Take-Nummern** sind je Shot über alle Termine eindeutig. Eine vorhandene Datei wird nie überschrieben; ein neuer Take bekommt die nächste freie Nummer.
- Verworfene Takes (`keep: false`) bleiben liegen, bis du sie löschst. `--status` zeigt, wie viele es sind und wie viel Platz sie brauchen.
- Wird der Platz knapp, kannst du fertige `.k2rec` auf eine externe Platte verschieben. Lass `sitzung.json` liegen, dann bleiben Stand und Nummern richtig.

### Sitzungslog `sitzung.json` (für die Auswertung)

JSON, `format: "kabel-wickeln mocap sitzung"`, `version: 1`. Oben: `session`, `consents` (wann zugestimmt), `placements` (je Aufbau die Platzierungen `#1`, `#2` …; eine neue nach dem Umstellen der Kinect), `shots` (Status je Shot: `fertig`, `genug`, `übersprungen`, `ausgelassen`), `events`. In `takes` ein Eintrag je Versuch:

| Feld | |
|---|---|
| `shot`, `number`, `take`, `slot`, `file` | Shot-ID, Nummer wie im Plan (A4), Take-Nummer der Datei, Take-Platz im Plan (1 … `takes`), Dateiname |
| `setup`, `placement` | Aufbau und Platzierung: Takes mit derselben Platzierung teilen sich die Kalibrier-Shots `cal.<Aufbau>.*` dieser Platzierung (Boden, Maßstab) |
| `role`, `mark`, `variant` | Rolle, Marke, Variante dieses Takes aus `shots.json` |
| `planned_s`, `pre_roll_s`, `post_roll_s`, `record_s`, `clap` | geplante Länge ab dem Klatschen, Vor- und Nachlauf, Länge für die Probe, ob es ein Startsignal gab |
| `frames`, `frames_ir`, `fps`, `duration_s`, `skipped`, `size_mb`, `complete` | aus der Ausgabe der Probe und der Datei |
| `first_capture_us` | `capture_time_us` des ersten Bildes (µs seit 1970, Uhr des Rechners) |
| `signal_unix_us`, `signal_in_recording_s` | wann das Startsignal kam, und in Sekunden ab dem ersten Bild. Das Klatschen selbst (t = 0 der Auswertung) folgt etwa 0,2–0,6 s danach; die Auswertung sucht es dort |
| `cues` | zeitgesteuerte Ansagen: `t` (s nach dem Signal laut Plan), `say`, `unix_us`, `in_recording_s` |
| `framing` | Bildcheck am Ende des Countdowns: `ok`, `warnings`, `problems`, `distance_m`, `expected_m` |
| `monitor` | Posen während des Takes: `checked` Proben, `no_person` und `not_visible` (Anteil je Gelenk) |
| `stopped`, `error`, `probe_reason`, `probe_output` | warum der Take endete (`strg+c`, `watchdog` …), Fehlermeldung, letzte Zeilen der Probe |
| `keep`, `decision`, `notes` | behalten ja/nein, `behalten`/`wiederholen`/`genug`/`übersprungen`, Notizen |

### Wenn etwas schiefgeht

- **„Der Hub läuft nicht“:** Starte ihn wie oben. Das Tool startet oder stoppt den Hub nie selbst. Fällt er mitten in der Sitzung aus, wartet das Tool, bis du ihn neu gestartet hast.
- **„Der Hub liefert keine Bilder (Sensor searching)“:** Kinect an USB 3 und am Netzteil? Im Hub-Fenster steht, was er sieht.
- **„kinect-hub-probe.exe fehlt“:** im Hauptordner bauen (`cd kinect-hub`, `cargo build --release`) oder den Pfad mit `--probe` angeben.
- **„Nur 20 fps“ oder „Bilder übersprungen“:** Szenen, Browser-Tabs mit der Wand und `start-wand.cmd` schließen, dann den Take wiederholen.
- **„Kein Bildcheck möglich“:** Das Pose-Modell fehlt (`setup-onnxruntime.ps1`) oder lädt noch. Die Aufnahme geht trotzdem; `--ohne-check` schaltet den Check ab.
- **Der Bildcheck warnt, obwohl alles passt** (z. B. die Hand in der Startpose hinter dem Ring): Es ist nur ein Hinweis. Schau in der Großanzeige, was rot ist.
- **Fehler der Probe:** Das Tool zeigt ihre Meldung; Enter = nochmal. Ohne Bilder entsteht keine Datei.
- **Platte fast voll:** Das Tool hört vor dem Take auf. Fertige `.k2rec` auf eine externe Platte verschieben, dann weitermachen.
- **Fenster zu, Absturz, Stromausfall:** Einfach neu starten, der Stand steht in `sitzung.json`. Liegt eine `.k2rec.part` da, ist sie bis zum letzten ganzen Bild lesbar; benenn sie in `.k2rec` um, wenn du sie behalten willst.
- Nach Strg+C fragt Windows am Ende vielleicht „Batchvorgang abbrechen (J/N)?“: Die Antwort ist egal.
- Töne zu leise: Windows-Lautstärke. Keine Töne: `--leise`.

### Ohne Tool

Aus dem Hauptordner, Länge = Sekunden des Shots plus 10; klatsch selbst auf der Marke:
```
kinect-hub\target\release\kinect-hub-probe.exe record --seconds 40 --out recordings\mocap\termin1\p1.coil.teach_t1.k2rec
```
Das Tool zählt solche Dateien bei den Take-Nummern mit, trägt sie aber nicht ins Sitzungslog ein.

### Testen ohne Kinect

- **Automatische Tests** mit Mock-Hub und falscher Probe (etwa 1 min, nur Standardbibliothek; schreibt nur in einen temporären Ordner):
  `python kabel-wickeln\mocap\tests\test_aufnahme.py`
- **Probelauf mit der echten Probe** gegen einen Replay-Hub, in einen eigenen Ordner:
  ```
  kinect-hub\target\release\kinect-hub.exe --source replay recordings\<aufnahme>.k2rec --bind 127.0.0.1:8091
  kabel-wickeln\mocap\aufnahme.cmd --hub http://127.0.0.1:8091 --ziel C:\Pfad\zu\ndkk-kinect-wall\recordings\mocap-probelauf --shot A4
  ```
  Das Tool warnt, dass der Hub nicht von der Kinect liest; mit `j` geht es weiter.

## Synthetische Testaufnahme

Zum Testen ohne Kinect und ohne private Aufnahmen: Figuren des Videos (`src/people`) bewegen sich nach einer festen Choreographie, eine virtuelle Kinect v2 nimmt sie auf. Weil die wahre Bewegung bekannt ist, lässt sich die ganze Kette prüfen: bekannte Bewegung → `.k2rec` → Auswertung → Gelenke → Retargeting → Vergleich mit der Wahrheit. Es braucht nur Node (wie `npm run bake`) und für die Prüfung Python mit numpy (einmal `python -m pip install numpy`); keinen Browser, keine GPU.

```
cd /d C:\Pfad\zu\ndkk-kinect-wall\kabel-wickeln
node mocap\synthetic\erzeugen.mjs                  coil, throw, tpose: ≈ 2 min, ≈ 640 MB
node mocap\synthetic\erzeugen.mjs coil-a tpose-b   die beiden Extras
python mocap\synthetic\pruefen.py output\synthetic  Format, Tiefe an bekannten Stellen, Vorschaubilder
```

| Datei in `output/synthetic/` | Bewegung | Kinect |
|---|---|---|
| `synth-coil` | Noor wickelt eine Über- und eine Unter-Schlaufe, mit Kabel: Ring in der linken Hand, Schlaufe zwischen den Händen, rechts zum Boden und am Boden entlang (10 s) | wie A, aber genau von vorn, 2,0 m |
| `synth-throw` | Kofi wirft von unten mit dem rechten Arm, ohne Kabel (7 s) | D: von der Seite, 3,2 m, die Wand ist außer Reichweite |
| `synth-tpose` | Kalibrierung `cal.A.body`: T-Pose, Hände dreimal auf und zu, Handflächen dreimal runter und hoch, 2 s zur Kinect, 2 s seitlich (15 s) | A: 1,8 m, 30° vorn rechts |
| `synth-coil-a` (Extra) | wie `synth-coil` | A |
| `synth-tpose-b` (Extra) | wie `synth-tpose` ohne Drehungen; in der T-Pose ragen die Hände aus dem Bild, wie es der Aufnahmeplan für B befürchtet | B: 1,3 m, 20° nach unten |

Jede beginnt still, klatscht bei 1,0 s (Handflächen zusammen vor der Brust), hält kurz und endet in einer ruhigen Endpose, wie ein echter Take.

- **`<name>.k2rec`**: genau das Format des Hubs. 512 × 424, 30 fps, Tiefe in mm und Infrarot mit der Tonkurve des Hubs, gespiegelt wie vom Hub, mit Linsenverzeichnung wie bei einer echten Kinect v2 (die LUT steht in der Datei). Dazu, was die Kinect falsch macht: Rauschen (≈ 1,5 mm bei 1,3 m, 2,5 mm bei 2 m, mehr auf Dunklem), fliegende Pixel und Löcher an Kanten, keine Tiefe, wo zu wenig Infrarot zurückkommt, Reichweite 0,5–4,5 m. Das schwarze Kabel (Ø 6,4 mm) ist im Infrarot eine dunkle Linie, in der Tiefe meist nur Kantenpixel.
- **`<name>.truth.json.gz`**: die Wahrheit im Take-Format ([`FORMAT.md`](FORMAT.md), `kind: "truth"`): 68 Gelenke je Frame, das Kabel als Polylinien, Boden, `cam_to_world`, Klatschen, Start und Ende. Dazu der Block `truth`: Pixel jedes Gelenks, Tiefe der Gelenkmitte und der sichtbaren Oberfläche, sichtbar oder verdeckt.
- **`<name>.preview.png`** (von `pruefen.py`): drei Momente, je Tiefe | Infrarot | Infrarot mit Wahrheit.

`pruefen.py` liest die Dateien unabhängig vom Erzeuger (nur numpy) und vergleicht: Boden aus der Tiefe (RANSAC) gegen den wahren, die Tiefe an bekannten Stellen von Boden und Wand, am Körper gegen die gerenderte Oberfläche, die Kette Pixel → LUT → Kamera → Welt gegen die wahren Gelenke, das Kabel im Infrarot. Mit einer echten Aufnahme prüft es nur das Format und den Boden; das Vorschaubild landet dann neben der Aufnahme in `recordings/` (privat).

`pose2d.py` macht die Rundreise im Kleinen: das Pose-Modell des Hubs (YOLO11s-pose aus `web/lib/models`, braucht `python -m pip install onnxruntime`) auf den Infrarotbildern, die 17 COCO-Gelenke mit der Tiefe in 3D gehoben und mit selbst gemessenem Boden in die WELT gebracht, verglichen mit der Wahrheit in Pixeln und mm. Eine Messlatte für `auswerten.py`: `python mocap\synthetic\pose2d.py output\synthetic`.

Optionen von `erzeugen.mjs`: `--seconds S`, `--noise F` (Rauschen, 1 = wie die Kinect), `--flying F` (Anteil der Kantenpixel, die als fliegende Pixel bleiben, 0,3), `--drop F` (Anteil verlorener Frames), `--no-distortion`, `--seed N`, `--ss N` (Unterabtastung je Pixel und Achse, 3), `--cable-ir A` (Infrarot-Albedo des Kabels, 0,1), `--out DIR`.

Im Hub abspielen, wie eine echte Aufnahme (aus dem Hauptordner):
```
kinect-hub\target\release\kinect-hub.exe --source replay kabel-wickeln\output\synthetic\synth-coil.k2rec --bind 127.0.0.1:8091
```

**Grenzen:** Die Figuren sind low-poly mit flachen Flächen; die Pose-Modelle sehen darin vielleicht andere Menschen als in echten Infrarotbildern. Die Testaufnahme prüft deshalb vor allem die Geometrie (2D → 3D, Boden, Welt, Verdeckung, Retargeting), weniger, wie gut ein Modell echte Hände findet. Die Gelenke der Wahrheit sind Gelenkmitten im Körper (die Haut liegt an Schultern und Hüften 6–9 cm davor). Das Kabel ist gezeichnet, nicht simuliert. Bei den Drehungen der Kalibrierung gleiten die Füße. Kein Mehrwegeffekt, kein Sonnenlicht, keine Bewegungsunschärfe.

## Auswerten

`auswerten.py` (Doppelklick oder cmd: `auswerten.cmd`) macht aus jeder Aufnahme eine Take-Datei mit deinen Gelenken in 3D, 30 Bilder pro Sekunde, im Format von [`FORMAT.md`](FORMAT.md). Pro Take:

1. **2D:** YOLO11x-pose findet dich in jedem Infrarotbild (und verfolgt dich über den Take, auch wenn kurz jemand anderes durchs Bild läuft). Sapiens2 1b setzt im Ausschnitt um dich Körper, Füße und je 21 Punkte pro Hand, ViTPose++ huge den Körper ein zweites Mal; jedes Modell sieht das Bild auch gespiegelt, die Ergebnisse werden gemittelt. Wo Sapiens2 sicher ist, entscheidet es; wo nicht, springen die anderen ein. Dieser Schritt ist teuer und wird neben der Aufnahme zwischengespeichert (`<name>.kp2d-stark.json.gz`): Ein zweiter Lauf rechnet nur noch 3D.
2. **3D:** An jedem Gelenk die Tiefe der Kinect, robust gegen Kanten, fliegende Pixel und Dinge davor (Hände, Ring, Kabel vor der Hüfte), geprüft am Körperbau. Daraus der Punkt im Raum, zur Gelenkmitte nach hinten versetzt. Der Boden kommt aus dem leeren Raum (`cal.<Aufbau>.empty` derselben Kinect-Platzierung) oder aus der Aufnahme selbst. Deine Knochenlängen werden über den Take geschätzt (oder aus `cal.<Aufbau>.body`) und halten Gelenke, deren Tiefe fehlt, auf ihrem Sichtstrahl. Vertauschte Seiten (linkes und rechtes Bein in der Seitenansicht) werden erkannt. Dann geglättet, ohne schnelle Bewegungen zu verschleifen, Lücken bis 1 s gefüllt, genau 30 fps.
3. **Klatschen** als Nullpunkt (gesucht um das Startsignal aus `sitzung.json`), Beginn und Ende der Aktion; alles vor „Klatschen − 1 s“ fällt weg.
4. **Hände:** je Hand ein Koordinatensystem (Handgelenk, Zeige-, Mittel-, Kleinfinger-Grundgelenk) und die Krümmung jedes Fingers, mit Sicherheit.
5. **Kabel** (experimentell): die dünne dunkle Linie um und unter den Händen, in 3D, als Polylinien.

### Einmal einrichten (Windows)

Python 3.10 oder neuer (python.org, Haken „Add python.exe to PATH“). Dann in einem cmd-Fenster:

```
py -3 -m pip install numpy onnxruntime pillow imageio-ffmpeg
```

Das reicht für den **leichten Testmodus** (`--modell leicht`: das Pose-Modell des Hubs, YOLO11s als ONNX, nur Körper, keine Hände und Füße). Für die **großen Modelle** (`--modell stark`, Standard) zusätzlich:

```
py -3 -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
py -3 -m pip install "transformers>=5.10" accelerate ultralytics
```

Beim ersten Start laden sich die Modelle selbst: YOLO11x-pose (113 MB) nach `<Hauptordner>\recordings\mocap\modelle\`, Sapiens2 1b (≈ 6 GB) und ViTPose++ huge (≈ 2,5 GB) in den Hugging-Face-Speicher (`%USERPROFILE%\.cache\huggingface`; woanders hin mit der Umgebungsvariable `HF_HOME`). Sapiens2 braucht im Speicher etwa 6 GB RAM (float32 auf der CPU).

**Grafik des Notebooks (DirectML), noch nicht ausprobiert:** `py -3 -m pip install torch-directml onnxruntime-directml` und `--device dml`. Sapiens2 und ViTPose laufen dann über torch-directml in float16; falls ein Operator fehlt, bricht es mit einer Meldung ab, dann `--device cpu`. Ultralytics kann kein DirectML: Für den Detektor YOLO11x-pose einmal als ONNX exportieren und mitgeben:

```
py -3 -c "from ultralytics import YOLO; YOLO(r'C:\Pfad\zu\ndkk-kinect-wall\recordings\mocap\modelle\yolo11x-pose.pt').export(format='onnx', imgsz=(640, 768), opset=17)"
auswerten.cmd --device dml --detektor C:\Pfad\zu\ndkk-kinect-wall\recordings\mocap\modelle\yolo11x-pose.onnx ...
```

Lizenzen: YOLO (Ultralytics) AGPL-3.0, ViTPose++ Apache-2.0, Sapiens2 eigene Lizenz (nicht-kommerziell, für dieses Projekt passend, siehe `pose-training/README.md`).

### Starten

```
cd /d C:\Pfad\zu\ndkk-kinect-wall\kabel-wickeln\mocap
auswerten.cmd C:\Pfad\zu\ndkk-kinect-wall\recordings\mocap\termin1            alle behaltenen Takes von Termin 1
auswerten.cmd --setup B ..\..\recordings\mocap\termin1                        nur Aufbau B
auswerten.cmd --shot p1.coil.teach,p3.pair.slow ..\..\recordings\mocap\termin1
auswerten.cmd ..\..\recordings\mocap\termin1\p1.coil.teach_t2.k2rec           ein einzelner Take
auswerten.cmd --modell leicht ..\..\recordings\mocap\termin1                  schneller Test, nur Körper
auswerten.cmd --every 3 --topdown sapiens ...                                 billiger: jeder 3. Frame, ohne ViTPose
auswerten.cmd --help                                                          alle Optionen
```

- Ein **Ordner** wertet alle Takes darin aus, die du in `sitzung.json` behalten hast (`--alle`: auch die verworfenen). Kalibrierung zuerst: `cal.X.empty` liefert den Boden, `cal.X.body` die Knochenlängen für die folgenden Takes (beides automatisch, über die Platzierung aus `sitzung.json`; von Hand: `--boden`, `--knochen`).
- **Zwei Personen** (`p6.lift.pair`): die zweite landet in `<shot>_t<take>_p2.json.gz`.
- **Weiterrechnen:** Nochmal starten genügt; was im 2D-Zwischenstand steht, wird nicht neu gerechnet (`--neu` erzwingt es; mit anderen Modellen rechnet es von selbst neu). Strg+C bricht ab; fertige Takes bleiben.
- Die Auswertung läuft mit niedriger CPU-Priorität, damit Hub und Aufnahme vorgehen (`--volle-prioritaet` schaltet das ab). Während einer Aufnahme trotzdem besser nicht mit den großen Modellen rechnen.
- Hilfreich: `--every N` (Modelle nur auf jedem n-ten Frame, 2D dazwischen interpoliert, die Tiefe aber in jedem Frame), `--ohne-spiegel` (halbe Zeit), `--kabel hell` (helles Kabel) oder `aus`, `--ganz` (nicht kürzen), `--glatt 0.7` (weniger glätten), `--max-luecke 0.5`, `--ohne-video`, `--signal 3.2` (Startsignal von Hand, wenn ohne Tool aufgenommen).

### Was herauskommt

| Datei | wo | was |
|---|---|---|
| `<shot>_t<take>.json.gz` | `<Hauptordner>\recordings\mocap\takes\` (privat) | die Take-Datei: 68 Gelenke je Frame (mm, WELT), Sicherheit, wie gemessen (D Tiefe / B Knochenlänge / I interpoliert), Hände, Kabel, Klatschen, Beginn, Ende, Qualität, Boden und Kamera ([`FORMAT.md`](FORMAT.md)) |
| `<name>.auswertung.mp4` | neben der Aufnahme | Kontrollvideo: links das Infrarotbild mit dem Skelett (grün aus der Tiefe, orange über die Knochenlänge, gelb interpoliert), Händen und Kabel (violett), rechts die Gelenke in 3D von vorn und von der Seite. Zeigt dich: bleibt in `recordings\` |
| `<name>.auswertung.txt` | neben der Aufnahme | der Bericht: je Gelenk Sicherheit, Anteil mit Tiefe, Zittern; Klatschen; Warnungen wie „rechtes Handgelenk: 30 % der Zeit unsicher oder interpoliert“ |
| `<name>.kp2d-stark.json.gz` | neben der Aufnahme | 2D-Zwischenstand der Modelle (Pixel, keine Bilder) |
| `<name>.boden.json` | neben der Aufnahme | die gemessene Bodenebene |

Ins Repository (`kabel-wickeln\mocap\takes\`) kommen Take-Dateien nur mit `--ins-repo`, und das fragt vorher nach deinem Okay. Committet wird dabei noch nichts.

Was du im Bericht prüfst: Klatschen gefunden (sonst ist der Take nicht synchronisierbar; Startsignal mit `--signal` angeben), Person in fast allen Frames gefunden, keine Warnung zu den Gelenken, die der Shot braucht. Im Video: Liegt das Skelett auf dir, springt es nicht, sieht die Seitenansicht wie ein Mensch aus?

### Wie lange es dauert

Gemessen hier im Linux-Container mit 4 CPU-Kernen (keine GPU), je Frame mit Spiegel-Mittelung:

| Schritt | Zeit je Frame |
|---|---|
| leicht: YOLO11s-ONNX | ≈ 0,3–0,5 s |
| YOLO11x-pose (Ultralytics, 640) | ≈ 10–25 s |
| ViTPose++ huge | AUSSTEHEND |
| Sapiens2 1b | AUSSTEHEND |
| 3D, Hände, Klatschen | ≈ 0,01 s |
| Kabel | ≈ 0,15 s |
| Kontrollvideo | ≈ 0,05 s |

Ein Take von 30 s hat etwa 1000 Frames, beide Termine zusammen etwa 80 000. Mit den großen Modellen auf der CPU sind das Minuten je Frame, also **auf dem Notebook nur für einzelne Takes sinnvoll** (bester Take je Shot, `--every 3 --topdown sapiens`), und auch dann über Nacht. Mit DirectML ist es vermutlich deutlich schneller; das ist noch nicht gemessen. Auf einer Colab-GPU (A100) braucht Sapiens2 1b laut `pose-training` etwa 0,2–0,3 s je Person, alles zusammen grob 0,4 s je Frame: 80 000 Frames ≈ 9 h, mit `--every 2` die Hälfte.

### Auf Colab auswerten (nur mit deinem Ja)

Dafür müssen die **Infrarotbilder** (dein Gesicht ist darauf erkennbar) zu Google hochgeladen werden, keine Tiefe. Das passiert nur, wenn du es willst: `--colab-paket` fragt vorher, und du lädst selbst hoch. Die colab CLI läuft unter Linux/macOS, unter Windows in WSL (siehe `pose-training/README.md`, „On Colab“).

1. Packen (fragt nach deinem Ja; `--every 2` packt nur jeden 2. Frame, halb so groß; das 2D dazwischen wird später interpoliert):
   ```
   auswerten.cmd --colab-paket D:\colab C:\Pfad\zu\ndkk-kinect-wall\recordings\mocap\termin1
   ```
2. Hochladen und starten (das Paket enthält auch den Code der Auswertung; die Befehle stehen auch oben in `colab_auswerten.py`):
   ```
   colab new -s mocap --gpu A100
   colab upload -s mocap /mnt/d/colab/kinect-ir-<datum>.zip /content/kinect-ir-<datum>.zip
   colab exec -s mocap -f kabel-wickeln/mocap/colab_auswerten.py
   echo "print(open('/content/job-auswerten.log').read()[-3000:])" | colab exec -s mocap
   ```
3. Wenn `/content/DONE-auswerten` da ist: `colab download -s mocap /content/out/kp2d.zip <Hauptordner>/recordings/mocap/kp2d.zip`, dann `colab stop -s mocap`. Die VM löscht die Infrarotbilder am Ende selbst; mit `colab stop` ist die VM ganz weg.
4. `kp2d.zip` in den Termin-Ordner auspacken (Explorer „Alle extrahieren“ oder `tar -xf kp2d.zip -C ...\termin1`) und lokal auswerten wie oben. Die 2D-Ergebnisse werden gefunden; gerechnet wird nur noch 3D, das braucht die Tiefe und bleibt bei dir.

### Datenschutz

- Aufnahmen, Kontrollvideos, 2D-Zwischenstände, Bodendateien und Berichte bleiben neben den Aufnahmen in `recordings\` (von git ausgeschlossen).
- Take-Dateien standardmäßig auch (`recordings\mocap\takes\`); ins Repository nur mit `--ins-repo` und deinem Okay. Sie enthalten keine Bilder, aber deine Bewegungen und Körpermaße. Die einer zweiten Person nur mit ihrem Okay.
- Hochgeladen wird nichts, außer du packst selbst ein Colab-Paket und lädst es hoch.

### Genauigkeit (synthetische Aufnahmen)

AUSSTEHEND

### Testen

```
python kabel-wickeln\mocap\tests\test_auswerten.py
```

Einzeltests (Leser, Kamera, Boden, Glättung, Hände, Take-Format, Klatschen) laufen ohne Daten in einer Sekunde. Mit den synthetischen Aufnahmen (`node mocap\synthetic\erzeugen.mjs`) kommen dazu: die wahren 2D-Pixel durch die ganze 3D-Kette, das leichte Modell auf `synth-coil`, das Kabel, ein Termin-Ordner mit `sitzung.json` (zusammen etwa 3 min). `python auswerten.py --modell leicht ..\output\synthetic` vergleicht jede synthetische Aufnahme mit ihrer Wahrheit und druckt die Fehler je Gelenk.
