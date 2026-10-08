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
