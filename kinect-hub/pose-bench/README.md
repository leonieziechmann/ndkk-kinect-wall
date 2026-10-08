# pose-bench: Pose-Modell nativ statt im Browser (Mess-Prototyp)

Misst das Pose-Modell der Personenerkennung (YOLO11n-pose, `web/lib/models/yolo11n-pose-fp16.onnx`, Eingang 1×3×448×512) nativ mit ONNX Runtime: auf der GPU über DirectML und auf der CPU mit N Threads. Vorbereitung und Auswertung sind genau die aus `web/lib/persons-pose.js`. Das Werkzeug vergleicht Zeit, CPU-/GPU-Last und Sensorrate mit dem Browser (ONNX Runtime Web, WebGPU) und prüft, ob dieselben Posen herauskommen.

Nur ein Messwerkzeug: der Hub nutzt es nicht, und es ist ein eigenes Crate (eigener Workspace, eigenes `target/`).

## Ergebnis (08.10.2026, Ryzen 5 PRO 4650U, Radeon Vega iGPU, Hub mit Kinect bei 30 fps)

Bilder: das mittlere Frame aus vier Verdeckungs-Clips (2–5 Personen) und ein Live-Bild. Browser: `web/tools/pose-ref.mjs`, also `PoseModel` aus `persons-pose.js` in headless Chrome mit WebGPU. Nativ: dieses Werkzeug, ONNX Runtime 1.24.4. Als GPU-Last lief die Szene `depth-shader` ohne eigenes Pose-Modell, gerendert in 2560×1440 (mittel) oder 3840×2160 (hoch, GPU dann voll).

**GPU frei** (nur die Tiefenberechnung `fn2_capture` läuft, ~11–18 % Compute):

| | Pose je Lauf (Median, p90) | Rate | CPU | GPU (3D-Engine) | Sensor |
|---|---|---|---|---|---|
| Browser, WebGPU, fp16 | 56,5 ms (73) | 18 Hz | ~0,75 Kerne (Chrome) | 80 %, also ~45 ms GPU je Pose | 30,4 fps |
| **nativ DirectML, fp16** | **18,8 ms (23)** | 48 Hz | **0,15 Kerne** | 69 %, also **~14 ms GPU je Pose** | 30,5 fps |
| nativ DirectML, fp16, auf 15 Hz | 17,9 ms (54) | 15 Hz | 0,05 Kerne | 35 % | 30,2 fps |
| nativ CPU 3 Threads, fp32 | 43 ms (47); über 20 s 68 ms (118) | 12–22 Hz | 1,6–2,4 Kerne | – | 29,7 fps |
| nativ CPU 6 Threads, fp32 | 42 ms (53) | 22 Hz | 3,6 Kerne | – | 30,2 fps |
| nativ CPU 6 Threads, fp16 | 45,5 ms (48) | 21 Hz | 3,7 Kerne | – | 30,2 fps |

**Unter Last.** Je Lastsitzung liefen die Varianten im Wechsel, zwei Runden; die Zahlen sind Runde 1 / Runde 2. Die Szene allein: mittel 60 fps bei Sensor 30 fps, hoch 53–59 fps bei Sensor 12–20 fps.

| | Pose je Lauf, Median (p90) | Rate | Sensor | Szene |
|---|---|---|---|---|
| mittel: Browser | 129 / 162 ms (168 / 205) | 6–8 Hz | 30,7 / 26,4 fps | 59 / 56 fps |
| mittel: **DirectML** | **52 / 39 ms** (79 / 58) | 17 / 22 Hz | **30 / 30 fps** | 59 / 59 fps |
| mittel: CPU 3 Threads, fp32 | 112 / 98 ms (147 / 182) | 9 Hz | 26 / 26 fps | 60 / 60 fps |
| hoch: Browser | 186 / 142 ms (242 / 180) | 5–7 Hz | 17,6 / 28,9 fps | 29 / 38 fps |
| hoch: **DirectML** | **58 / 83 ms** (83 / 114) | 16 / 11 Hz | **30 / 28,5 fps** | 40 / 32 fps |
| hoch: CPU 3 Threads, fp32 | 100 / 106 ms (137 / 129) | 9 Hz | 11,5 / 10,8 fps | 55 / 50 fps |

Zum Vergleich die echte Pipeline: `npm run check person-skeleton` (leichte Szene, Tracker und Pose im selben Chrome) meldet 127 ms je Pose.

**Gleiche Ergebnisse:** In allen 5 Bildern findet nativ dieselben 18 Personen wie der Browser. Die Abweichungen liegen bei Score ≤ 0,008, Box ≤ 0,9 px und Gelenken mit Konfidenz ≥ 0,5 bei ≤ 1,1 px; im Live-Bild sind es einmal 2,4 px. Der Rust-Dekoder liefert aus der Browser-Rohausgabe exakt die Posen von `persons-pose.js` (Δ 0). Das fp32-Modell gibt auf DirectML und CPU identische Werte, die kleinen Unterschiede stammen also vom fp16-Rechnen im Browser.

**Was dabei auffällt:**

- DirectML braucht je Pose nur etwa ein Drittel der GPU-Zeit von WebGPU. Bei freier GPU ist es dreimal so schnell, unter mittlerer Last 2,5- bis 4-mal.
- DirectML rechnet auf der 3D-Engine, wie die Szene. Wird die GPU voll, teilen sich beide die Zeit: die Pose läuft dann 60–80 ms und die Szene verliert fps. Der Sensor hielt aber in jeder Messung mit DirectML 28,5–30 fps, sogar besser als mit der Szene allein.
- Die CPU ist auf diesem Laptop keine Entlastung. CPU und iGPU teilen sich 15 W und den Speicher. Unter Szenenlast wird die CPU-Inferenz 2,5-mal langsamer und zieht die Sensorrate auf 11–26 fps herunter. Bei Dauerlast (20 s) taktet die CPU schon ohne Szene ab: 68 statt 43 ms.
- Mit fester Rate (15 Hz) taktet die iGPU zwischen den Läufen herunter. Der Median bleibt gleich, das p90 steigt bei freier GPU auf 54 ms.
- Die Zahlen schwanken über Minuten um ±30 %, je nach Wärme des Laptops. Deshalb sind die Varianten abwechselnd gemessen; die Verhältnisse blieben in allen Runden gleich.

## Empfehlung

**Das Pose-Modell lohnt sich nativ mit DirectML; die CPU ist keine Alternative.** Gründe:

- Es ist drei Mal schneller und braucht ein Drittel der GPU-Zeit je Pose. Unter Last kommen 11–22 statt 5–8 Posen pro Sekunde.
- Fast keine CPU (0,1 Kerne), und die Sensorrate bleibt bei 30 fps.
- Es wird einmal im Hub gerechnet statt in jedem Tab, der eine Szene mit Personen zeigt. Das passt zur Idee des Hubs: einmal vorberechnen, an viele verteilen.

So würde ich es bauen:

1. **Pose zuerst und allein.** Ein eigener Worker-Prozess wie `fn2_capture`, nicht im Hub-Prozess. ONNX Runtime und DirectML sind 17 MB Fremdcode samt GPU-Treiber, ein Hänger dort darf den Hub nicht mitnehmen. Der Hub gibt dem Worker das IR-Bild, das er ohnehin hat, und verteilt die Antwort als neuen Stream `poses` (seq, bis zu 16 × Box und 17 Gelenke, ~3,5 KB). Im Browser ersetzt ein Abo dieses Streams `persons-pose-worker.js`; Segmentierung, Fluss und Skelett bleiben vorerst, wo sie sind.
2. **Den Tracker erst danach**, falls nötig. Segmentierung, optischer Fluss und Skelett-Fusion sind CPU-Arbeit; für die Geschwindigkeit reicht die WASM-Arbeit der anderen Sitzung. Der Umzug bringt dort vor allem „einmal statt je Tab“. Das lohnt sich, sobald regelmäßig mehrere Tabs mit Personen gleichzeitig laufen.

Vorbehalte:

- Das DirectML-Paket von ONNX Runtime gibt es nur bis 1.24.4, die CPU-Pakete sind bei 1.30.
- `ort` 2.0 ist noch ein Release Candidate.
- Die GPU bleibt geteilt: eine Szene, die die GPU sättigt, kostet die Pose weiterhin Zeit, und umgekehrt. Die Rate der Pose gehört deshalb begrenzbar gemacht (z. B. 15 Hz).

## Größere Modelle: yolo11s und yolo11m (08.10.2026, abends)

Anlass: Nachtrainiertes n verallgemeinert nicht, die Modellgröße ist der Hebel (Pose-mAP gegen yolo11x auf 283 ungesehenen Bildern: n@512 0,654, n@384 0,603, s@384 0,684, s@512 0,726, m@512 0,800; `pose-training/README.md` auf Branch `claude/focused-golick-2f20b5`). Modelle: `recordings/training/export-coco/` (lokal, fp16 wie `web/lib/models/README.md`). Gleiche Bilder und Bedingungen wie oben, alle fünf Modelle je Lastsitzung im Wechsel, je 15 s; der Hub dekodierte die Tiefe damals noch mit OpenCL.

**GPU frei** (Modell je Lauf, Median (p90); GPU-Zeit je Pose = 3D-Auslastung / Rate):

| | hintereinander | Rate | GPU je Pose | fest 15 Hz |
|---|---|---|---|---|
| n@512 | 20–24 ms (23–37) | 35–46 Hz | ~13 ms | 43 ms (74) |
| n@384 | 12–14 ms (14–21) | 59–74 Hz | ~8 ms | 37 ms (70) |
| **s@384** | **27–29 ms** (29–44) | 30–35 Hz | ~16 ms | **34 ms (64)** |
| **s@512** | **46–49 ms** (52–66) | 18–21 Hz | ~26 ms | **55 ms (72)** |
| m@512 | 118–165 ms (133–202) | 6–8 Hz | ~72 ms | nicht erreichbar (6,5 Hz) |

**Unter Szenenlast** (`depth-shader` in 1920×1080, 2560×1440, 3840×2160; gruppiert nach der 3D-Auslastung der Szene allein, die je nach anderen Sitzungen schwankte). Modell je Lauf, Median (p90), Rate:

| Szene allein | n@512 | n@384 | s@384 | s@512 | m@512 |
|---|---|---|---|---|---|
| ~40–50 % GPU (2 Runden) | 40–48 ms (70–73), 18–21 Hz | 26–27 ms, 34 Hz | 60–63 ms (110–119), 13–14 Hz | 95–118 ms (172), 8–9 Hz | 228–252 ms, 4 Hz |
| ~62–68 % (3 Runden) | 45–83 ms (63–131), 10–20 Hz | 29–30 ms, 29–31 Hz | 51–117 ms (75–147), 8–17 Hz | 104–123 ms (144–172), 7–9 Hz | 233–250 ms, 4 Hz |
| ~92 % (2 Runden) | 58–61 ms (82–96), 15–16 Hz | 33–37 ms, 22–24 Hz | 83–92 ms (112–137), 10–11 Hz | 145–169 ms (205–231), 6–7 Hz | 309–350 ms, 3 Hz |

- **Sensor** (noch OpenCL-Dekodierung): bis ~68 % GPU mit allen Modellen 26–30 fps (s@384 einmal 22), bei ~92 % 24–28 fps (die Szene allein drückt ihn dort auf 15–18). Mit der CPU-Dekodierung (`fn2/fast_depth`) hängt der Sensor nicht mehr an der GPU.
- **Szene:** bis ~68 % bleibt sie mit n und s bei 52–60 fps, m kostet 5–11 fps. Bei ~92 % kostet jedes Pose-Modell die Szene ~20 fps (n 37 fps, s@384 34–38, s@512 30–33, m 28–31 statt 52–59).
- **Live im Hub** (Kinect, GPU zu 94 % durch zwei Browser mit Szenen): s@512 ~200 ms (4,5 Hz); s@384 mit n@384 als Ausweichmodell 59 ms bei 12 Hz.

**Bewertung:**

- **s@384 kostet bei freier GPU so viel wie heute n@512** (27–34 ms) und ist besser (0,684 statt 0,654). Bei 15 Hz passt es bequem.
- **s@512 passt nur bei freier GPU**, und knapp: bei 15 Hz 55 ms Median, p90 72 ms über der Periode von 67 ms. Der Hub-Scheduler wechselt ab 60 ms (90 % der Periode) und kehrt erst unter 40 ms (60 %) zurück; das schafft s@512 nie, nach einem Wechsel bliebe er also auf dem kleinen Modell. Für s@512 ↔ s@384 muss die Rückkehrschwelle hoch (z. B. 85 % der Periode) oder `--pose-hz 12`.
- **Unter Last skaliert s schlechter als n:** bei ~45 % GPU s@384 60 ms (≈ n@512 40–48), bei ~92 % 83–92 ms (10–11 Hz) statt n@512 58–61 ms (15–16 Hz). s@512 liegt unter jeder Last bei 95–170 ms (6–9 Hz).
- **m@512 ist für live zu langsam** (118–165 ms bei freier GPU, 230–350 ms unter Last); nur offline, etwa als Lehrer.
- Vorschlag für den Hub: drei Stufen s@512 → s@384 → n@384. s@512 läuft, solange die GPU frei ist. s@384 ist der Normalfall. n@384 hält unter Volllast 15 Hz (29–37 ms), mit schlechteren Posen. Heute kennt der Hub zwei Stufen: für den Live-Test laufen s@384 und n@384 (`--pose-model …/yolo11s-pose-384x320-fp16.onnx --pose-model-fast …/yolo11n-pose-384-fp16.onnx`).

## Einrichten

1. ONNX Runtime mit DirectML: `kinect-hub/setup-onnxruntime.ps1` (dieselbe DLL wie für den Hub, nach `kinect-hub/onnxruntime/`). Oder von Hand: NuGet-Paket [Microsoft.ML.OnnxRuntime.DirectML 1.24.4](https://www.nuget.org/packages/Microsoft.ML.OnnxRuntime.DirectML/1.24.4) (12,5 MB), aus dem Zip (`.nupkg`) nur `runtimes/win-x64/native/onnxruntime.dll` nach `kinect-hub/pose-bench/ort/onnxruntime.dll` (git-ignoriert). Das ist die neueste ONNX Runtime mit DirectML; deshalb `api-24` in `Cargo.toml`.
2. `DirectML.dll` liefert Windows 11 mit (System32, hier 1.15.5). Ist sie zu alt, das NuGet-Paket Microsoft.AI.DirectML neben die `onnxruntime.dll` legen.
3. `cargo build --release` in `kinect-hub/pose-bench/`. Das Crate `ort` lädt die DLL zur Laufzeit (`load-dynamic`), deshalb geht es mit der GNU-Toolchain wie der Hub.

## Aufruf

```
target/release/pose-bench.exe [--ep dml,cpu6,cpu3spin] [--frames a.bin,b.bin] [--runs 100 | --seconds 20] [--hz 15] [--load] [--compare]
                              [--model …/yolo11n-pose-fp16.onnx] [--ort ort/onnxruntime.dll] [--hub 127.0.0.1:8090]
```

- `--ep`: `dml` (DirectML, Grafikkarte 0; `dml1` die nächste), `cpuN` (N Threads, ohne Busy-Wait), `cpuNspin` (mit).
- `--frames`: Infrarotbilder als 512×424 Byte roh. Ohne: das neueste Bild vom Hub (`/api/frame/ir`).
- `--seconds` / `--runs`: so lange bzw. so oft hintereinander rechnen, wie der Pose-Worker im Browser es tut. `--hz 15`: stattdessen in fester Rate.
- `--load`: dabei CPU und GPU je Prozess messen (`load.ps1`, braucht `--seconds`).
- `--compare`: mit dem Browser vergleichen. Erwartet neben jedem Bild `<name>.browser.f32` (Rohausgabe) und `<name>.browser.txt` (Posen), die `web/tools/pose-ref.mjs` schreibt.

Je Provider: Zeit fürs Laden und den ersten Lauf, dann Vorbereitung, Modell (mit Rückkopieren der Ausgabe) und Auswertung (Median, p90, Minimum), Rate, CPU dieses Prozesses in Kernen und die Sensorrate am Hub während der Messung.

Dazu in `web/tools/`:

- `pose-ref.mjs` (+ `pose-ref.html`): das Modell im Browser genau so, wie der Pose-Worker es rechnet (`PoseModel` aus `persons-pose.js`, headless Chrome, echte GPU). Zeit für `detect()` und `session.run`, schreibt die Referenz für `--compare`.
- `pose-load.mjs`: GPU-Last. Rendert eine Szene in headless Chrome und schreibt jede Sekunde die Zahl gerenderter Frames, um die Szenen-fps je Messphase zu sehen.

Bilder mit Personen aus Aufnahmen: `pose-bench --extract ../../web/.cache/pose-native <clip>.k2rec …` schreibt das mittlere Infrarotbild jedes Clips als `<clip>.bin`. Die Bilder zeigen Menschen und bleiben wie die Aufnahmen lokal (`web/.cache/` ist ignoriert).

Die Messung oben, Schritt für Schritt (aus `kinect-hub/pose-bench/`, `C=../../web/.cache/pose-native`):

```
target/release/pose-bench.exe --extract $C <Clips aus recordings/clips/verdeckung/>
(cd ../../web && node tools/pose-ref.mjs <Namen der .bin ohne Endung> --runs 250)                    # Browser + Referenz
target/release/pose-bench.exe --frames $C/a.bin,$C/b.bin --ep dml,cpu6 --compare                    # Gleichheit, Zeit
target/release/pose-bench.exe --frames … --ep dml --seconds 20 --load                                # Last je Prozess
(cd ../../web && node tools/pose-load.mjs depth-shader --size 2560x1440 --seconds 300 --log .cache/pose-native/scene.log) &   # GPU-Last
```
