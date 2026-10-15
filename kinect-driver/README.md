# kinect-driver

Ein schlanker Kinect-v2-Treiber in Rust, der nicht abstürzt: USB direkt über libusb (Windows, Linux, macOS), die Tiefen- und IR-Berechnung aus den Rohdaten der Time-of-Flight-Kamera auf der CPU (SIMD, ein paar Threads) oder der GPU (wgpu-Compute-Shader), und Pipelines aus Stufen, die man konfigurieren und um eigene ergänzen kann. Als Bibliothek (Crate `kinect-driver`) oder als Programm `kinect-driver`, das auch als Capture-Worker in den kinect-hub passt.

| Ordner | Was |
|---|---|
| `driver/` | die Bibliothek: USB, Protokoll, Tiefen-/IR-Dekodierung (CPU und GPU), Pipelines, Simulator, Aufnahmen |
| `cli/` | das Programm `kinect-driver`: Worker für den Hub und Werkzeuge |
| `tools/` | C++-Harness, das den kompatiblen Modus gegen `fn2/fast_depth.cpp` prüft |

## Was er anders macht

**Mehr Reichweite (Modus `extended`).** libfreenect2 rechnet mit einer geschlossenen Formel nur bis 4,5 m und verwirft alles, wo eine Frequenz sättigt. Der erweiterte Modus sucht über den ganzen eindeutigen Bereich der drei Frequenzen (80, 16, 120 MHz → 18,75 m) die wahrscheinlichste Entfernung: jede Kandidatenentfernung der genauesten Frequenz wird mit allen brauchbaren Frequenzen nach ihrem Rauschen gewichtet verfeinert, die Konfidenz kommt aus dem Abstand zum zweitbesten Kandidaten und der Konsistenz der Phasen. Das Rauschmodell, das dabei wiegt, ist an der echten Kinect gemessen (siehe [Gemessen (echte Kinect)](#gemessen-echte-kinect)): Es umfasst, was die Entfaltung wirklich sieht, also das gefilterte Rauschen, Streulicht und Kalibrierfehler, nicht nur das Sensorrauschen. Dazu:
- **Nah trotz Sättigung:** Die drei Phasenproben einer Frequenz summieren sich zu null. Ist eine davon gesättigt, wird sie aus den beiden anderen rekonstruiert; ist mehr gesättigt, fällt nur diese Frequenz weg, und die Entfernung kommt aus den übrigen beiden. Bleibt nur eine Frequenz, entscheiden die Nachbarn (Abstimmung, bei gesättigten Nachbarn bevorzugt die desselben hellen Objekts), sonst eine glatte Erwartung aus der Umgebung. Wo alle Frequenzen sättigen, wird die Tiefe vom gemessenen Rand desselben Objekts nach innen interpoliert (Flag `DEPTH_FILLED`).
- **Weit:** Kandidaten, die eine unmögliche Helligkeit bräuchten (ein heller Punkt kann nicht 12 m weg sein, ein dunkler eher ein Echo von jenseits des Bereichs), werden bei der Wahl bestraft. Die Helligkeit rechnet mit dem Beleuchtungsprofil der Kinect: in der Bildmitte fast gleichmäßig, zum Rand hin steil abfallend (auf die Hälfte bei 31° von der Achse, `illumination_angle`). Mehr als das 1,5-Fache einer weißen Fläche gilt als unplausibel (`max_reflectivity`). Die Strafe entscheidet nur zwischen den Kandidaten, die Konsistenz zählt sie nicht: Ein Reflektor, dessen Phasen eindeutig sind, behält seine Tiefe. Die Nachbarn wählen nie einen zweitbesten Kandidaten, den die Helligkeit verworfen hat. Ein Speckle-Filter nimmt einzelne Ausreißer heraus, der Kantenfilter wächst mit der Entfernung.
- **Mehrwege (Flag `MULTIPATH`):** Ein Echo erreicht alle drei Frequenzen gleich stark. Zwei Echos aus verschiedenen Entfernungen (eine streifend gesehene Tischplatte, Kanten, Streulicht) überlagern sich je Frequenz anders, weil ihr Phasenabstand mit der Frequenz wächst. Passen die drei Amplituden nicht zu einem Echo, sinkt die Konfidenz (ein zweites Chi-Quadrat neben dem der Phasen), und die Nachbarn bestätigen oder ersetzen die Entfernung nicht. Solche Pixel gaben vorher Phasen, die zu einer Entfernung weit hinter der Rückwand passten.
- **Vorsicht beim Entscheiden:** Der beste Kandidat muss um `margin_prior` (10) besser sein als der zweitbeste, bevor die Entfaltung ihm mehr glaubt als dem anderen. Das Modell kennt nur das Rauschen; was es nicht kennt, lässt einen falschen Kandidaten ab und zu um ein paar Einheiten gewinnen.
- **Verlorene USB-Daten:** Fehlt ein Phasenbild (oder ein Teil davon, weil ein USB-Paket verloren ging), wird es wie eine gesättigte Probe aus den beiden anderen seiner Frequenz rekonstruiert, mit passend höherem Rauschen im Modell.

**IR ohne Überbelichtung (HDR).** Statt die drei Frequenzen zu addieren und bei 65535 abzuschneiden, ist das IR der gewichtete Mittelwert der brauchbaren Frequenzen: sättigt eine, tragen die anderen (rekonstruierte schwächer gewichtet). Nur wo alle sättigen, wird aus der Umgebung gefüllt, nie dunkler als der Pegel, bei dem dieser Sensor sättigt. Die Werte gehen über 65535 hinaus; die Stufe `IrToneMap` bringt sie in einen Ausgabebereich:
- `hub`: bis 3000 unverändert (wie libfreenect2 im Hub), darüber logarithmisch, weiß erst bei 65535 (für die Weiß-bei-6000-Darstellung des Hubs): was dort heute weiß ist, behält seine Zeichnung als helles Grau (6000 wird Byte 212 statt 255, 12000 wird 227, 30000 wird 243). `hub:KNIE:WEISS` stellt beides ein, z. B. `hub:2500:200000` für noch weichere Lichter (6000 wird 199). Eine Kurve je Frequenz vor dem Mitteln gäbe dasselbe Bild: die drei Amplituden messen dieselbe Helligkeit (in hellen Bereichen auf etwa 1 % gleich); nur an Kanten, wo sie auseinanderliegen, würde der Rand dunkler.
- `even`: gleichmäßigere Belichtung: der Abfall mit der Entfernung wird herausgerechnet (auf 2,5 m bezogen; Nahes höchstens 4-fach dunkler, Fernes höchstens 2,5-fach heller, damit das Rauschen hinten nicht aufblüht), dann wie `hub`

**Kompatibler Modus (`compat`).** Das Verfahren von libfreenect2 bzw. `fn2/fast_depth.cpp` mit denselben Ergebnissen (gegen fast_depth geprüft mit `tools/fastdepth_ref.cpp`); die Flags bleiben dort leer.

**Robust.** Siehe [Was bei Störungen passiert](#was-bei-störungen-passiert). Der Code verbietet `unwrap`, `expect`, `panic!` und ungeprüftes Indizieren; jeder Thread, jede Stufe und jeder USB-Callback fängt Panics ab.

## Gemessen (Simulator)

Die Tabellen unten sind gegen einen physikalischen Simulator der Kamera gemessen (`driver/src/sim/`: Phasen, Rauschmodell, Sättigung, Mehrwegfehler, Pixelkanten), der den Rohpaketen der Kinect Byte für Byte gleicht. `kinect-driver eval` druckt die Tabellen. Anteil der Pixel mit Tiefe / davon richtig (innerhalb 1 % bzw. 15 mm) / falsch (über 5 % daneben):

| Szene, Bereich | compat | extended | extended bis 15.10. |
|---|---|---|---|
| Raum, 3–4,5 m | 65 % / 54 % / 0,06 % | 77 % / 66 % / 0,04 % | 78 % / 66 % / 0,24 % |
| Raum, 4,5–6 m (Rückwand) | 33 % / 33 % / 0 % | 99 % / 99 % / 0 % | 99 % / 99 % / 0 % |
| nah, unter 0,5 m | 0 % | 99 % / 61 % / 0 % | 98 % / 60 % / 0 % |
| nah, gesättigte Pixel | 0 % | 100 % / 56 % / 0 % | 100 % / 55 % / 0 % |
| Halle, 4,5–6 m | 0,5 % / 0,2 % / 0,05 % | 33 % / 23 % / 0,21 % | 32 % / 22 % / 0,47 % |
| Halle, 8–10 m | 0,3 % / 0 % / 0,3 % | 47 % / 41 % / 0,01 % | 44 % / 39 % / 0,13 % |
| dunkle Flächen, 6–8 m | 0,1 % / 0 % / 0,05 % | 6 % / 5 % / 0 % | 15 % / 9 % / 1,1 % |
| Rampe, Tiefe, wo nichts ist (2 Frames) | 552 Pixel | 106 Pixel | 3.360 Pixel |

Seit dem ersten Test an der echten Kinect sind falsche Pixel auch im Simulator fast verschwunden; dafür reicht der erweiterte Modus auf dunklen Flächen nicht mehr so weit (über 6 m). Der Simulator rauscht etwa fünfmal schwächer als die echte Kinect und beleuchtet den Rand gleichmäßiger (cos²): Das Rauschmodell des Decoders ist für ihn zu vorsichtig, an der echten Kinect passt es.

IR, wo der Sensor sättigt: compat 100 % weiß abgeschnitten, extended 0 %. Ein verlorenes Phasenbild kostet im erweiterten Modus 2–15 % der richtigen Pixel (ohne Rekonstruktion bis zu 99 % oder 20-mal mehr falsche).

**Zeit** (Xeon 2,8 GHz, 4 vCPU, AVX2): compat 4,6 ms je Frame mit 3 Threads (12,5 ms mit einem), extended 10,7 ms im Raum und 12,5 ms mit viel Sättigung (27–29 ms mit einem); Einzelheiten unter [Rechenkerne](#rechenkerne). Auf der GPU (wgpu) dieselben Ergebnisse bis auf Rundung (Tiefe max. 0,005 mm Abweichung, gemessen mit lavapipe); die Zeit dort hängt von der GPU ab: `kinect-driver bench`.

**Strom** (geteiltes Budget einer APU): Bei 30 fps hält die CPU-Variante im erweiterten Modus etwa einen Kern beschäftigt (32 ms CPU-Zeit je Frame mit 3 Threads, 35 ms bei viel Sättigung). Der GPU-Weg braucht auf der CPU 1,4 ms je Frame (Hochladen 0,6 ms, Zurücklesen 0,7 ms); nur wo etwas sättigt, kommen bis 3,3 ms für die Füllung dazu. Ob die GPU dieselbe Arbeit mit weniger Energie macht, zeigt nur eine Messung auf dem Zielrechner: `kinect-driver bench --fps 30 --seconds 120 --mode extended --backend cpu`, dann dasselbe mit `--backend gpu`, und jeweils die mittlere Leistung (z. B. HWiNFO, „CPU Package Power“, auf einer APU mit GPU) gegen den Leerlauf vergleichen. Im Taktbetrieb gibt der Befehl auch die CPU-Zeit je Frame des ganzen Prozesses aus.

## Gemessen (echte Kinect)

Erster Test am 15.10.2026: Kinect v2 (Vorabversion, Firmware 4.0.3917.0) an einem ThinkPad X13 (Ryzen 5 4650U), ein leerer, ruhiger Raum mit Wänden und Regal bei 0,5–2,5 m und einer streifend gesehenen Tischplatte im Vordergrund. Rohdaten: `recordings/2026-10-15-rohpakete/` (nicht im Repository), dort auch `BEFUNDE-kinect-driver.md`. Gemessen mit `replay --compare --frames 60`, je Frame:

| | extended bis 15.10. | extended |
|---|---|---|
| Pixel mit Tiefe (compat: 73,2 %) | 61,0 % | 79,7 % |
| 0–0,5 m (die Tischplatte; compat misst erst ab 0,5 m) | 2.980 | 23.136 |
| 0,5–2 m in beiden Modi, davon gleich (1 % / 10 mm) | 126.104, 98,2 % | 147.698, 97,8 % |
| 0,5–2 m nur compat | 32.768 | 11.294 |
| 0,5–2 m nur extended | 1.276 | 2.240 |
| Phantome jenseits 4,5 m (der Raum endet bei 2,5 m) | 1.953 | 1 |

- **Zuverlässige Pixel** (Tiefe in mindestens 90 % der Frames, zeitlich unter 1 % Streuung, mindestens 6 der 8 Nachbarn ebenso): compat 114.470, extended 114.810. Extended hat 98,2 % der zuverlässigen compat-Pixel, 98,1 % davon auf 1 % / 10 mm gleich. Was fehlt, liegt fast ganz in einer Ecke unten links, die compat bei 1 m sieht und deren Amplituden nicht zu einem Echo passen.
- **Was compat allein hat**, sind vor allem Mischpixel: Blattränder, Kanten und diese Ecke. Ihre Werte liegen zwischen den Entfernungen, die sie mischen.
- **CPU und GPU** liefern auf diesem Dump dasselbe (0,1 Pixel je Frame mit Tiefe in nur einem, max. 0,006 mm).
- **Zeit** unverändert: 8,8 ms je Frame mit 4 Threads auf dem Ryzen 5 4650U, auf der Radeon-iGPU 9,4 ms.
- **Woran es lag** (Diagnose: `cargo run --release -p kinect-driver --features gpu --example diag_raw -- DATEI.k2raw --png ORDNER [--gpu]`):
  - Das Rauschmodell war das der Literatur. Die echte Entfaltung sah etwa das 2,4-Fache an Phasenfehler, dazu Fehler, die mit der Helligkeit nicht kleiner werden (Kalibrierung, Streulicht; je Frequenz 0,02–0,05 rad). Die Konfidenz fiel deshalb auf hellen und dunklen Flächen gleichermaßen, und nur die Fenster um einzelne sichere Pixel blieben: die blockigen Löcher.
  - Die Phantome lagen auf der streifend gesehenen Tischplatte (zwei Echos: die Amplituden der Frequenzen meist um Faktor 2 bis 4 verschieden) und als schwache Pixel am Bildrand, wo die Beleuchtung auf ein Viertel abfällt.
- **Den eigenen Sensor einmessen:** eine ruhige Szene 10 s lang aufnehmen (`kinect-driver record --out recordings/….k2raw --seconds 10`), dann `kinect-driver analyze DATEI.k2raw`. Es misst die Helligkeit einer weißen Fläche auf der Achse, das Beleuchtungsprofil (grob, wenn der Raum vollgestellt ist; eine weiße Wand, die das Bild füllt, gibt es am besten), die Verstärkung der Frequenzen und das Rauschmodell: die Verhältnisse der Frequenzen aus ihrem Rauschen, die Stärke so, dass die Kosten ruhender Pixel ihrer Verteilung folgen. Es druckt die `--tof`-Einstellungen. Auf dem Dump vom 15.10. schlägt es `noise_coeff=3.54:2.69:4.33,noise_floor=0.040,brightness_1m=26029,illumination_angle=32.5` vor. Die Standardwerte (`3:2.5:3.5`, `0.04`, `25000`, `31`) liegen daneben; der Winkel ist etwas kleiner, weil das Licht zu den Seiten steiler abfällt als zu den Ecken.
- **Noch offen:** Reichweite an der echten Kinect (Halle, über 4,5 m) und Personen im Bild.

## Speicher und Kopien

Im laufenden Betrieb legt ein Frame keinen Bildspeicher neu an; die großen Puffer kreisen.

- **Rohpakete** (2,98 MB) kommen aus einem Pool des Parsers. Die USB-Pakete landen direkt an ihrem Platz im Rohpaket (beim Teilbild nach dem zuletzt empfangenen); nur der Footer, der den richtigen Platz nennt, liegt daneben. Nennt er einen anderen Platz (nach einem verlorenen Teilbild), wird das Teilbild einmal verschoben. Je Byte also eine Kopie: vom USB-Puffer ins Rohpaket.
- **Ausgabe-Ebenen** (Tiefe, IR, Konfidenz, Flags, Punkte: 3,47 MB, mit Punkten 6 MB) kommen aus dem Pool der Dekodierstufe und gehen zurück, wenn die Anwendung den Frame fallen lässt. Hält sie Frames länger, entstehen eben neue; beide Pools behalten höchstens 8 Stück.
- **Dekoder:** feste Helfer-Threads, die zwischen den Phasen schlafen, statt Thread-Starts je Phase. Arbeitsebenen, Push-Pull, Flood-Fill und IR-Füllung behalten ihre Puffer.
- **Stufen** behalten ihre Puffer (`IrToneMap::even`, `TemporalFilter`); `Points` füllt die Ebene des Frames.
- **Worker für den Hub:** schreibt Tiefe und IR direkt aus den Ebenen des Frames in die Pipe, ohne Nachrichtenpuffer und Zwischenkopie; danach gehen die Ebenen zurück in den Pool.

Gemessen mit `cargo run --release -p kinect-driver --example alloc_count` (zählender Allocator; Parser, Pipeline, Übergabe):

| je Frame | vorher | jetzt |
|---|---|---|
| Allokationen, CPU (compat / extended / mit `even` und Punkten) | 3.872 / 4.808 / 4.809 | 2 / 2 / 2 |
| neu angelegte Bytes | 7,1 / 12,8 / 15,4 MB | 296 B (`Arc` des Rohpakets, `Box` des Ereignisses) |
| GPU-Weg | 105 Allokationen, 6,7 MB | 94 kleine in wgpu, 18 KB |
| Zeit, Linux, 4 vCPU: Parser / compat / extended / ganzer Treiber | 0,35 / 9–13 / 21 / 18,7 ms | 0,21 / 8 / 20 / 17,1 ms |

`driver/tests/alloc.rs` hält das fest. Im erweiterten Modus ändert sich die Zeit kaum, dort dominiert die Rechnung. Unter Windows sind Thread-Starts und große Allokationen teurer; dort dürfte der Unterschied größer sein (noch nicht gemessen).

## Rechenkerne

Die Pixelkerne rechnen acht Pixel auf einmal (`driver/src/tof/lanes.rs`: Werte aus acht Spuren, die der Compiler zu je einem AVX2-Befehl macht, zu zwei mit SSE2 oder NEON). So bleiben Zwischenwerte über Schleifen hinweg, die nicht über Pixel laufen, in Registern, statt als Zeilen-Arrays durch den Cache zu gehen: die 15 Kandidatenentfernungen der Entfaltung, die neun Nachbarn des bilateralen Filters, die 24 des Speckle-Filters.

- **Näherungen:** exp, atan2 und ln sind dieselben Polynome wie in `fn2/fast_depth.cpp` und im GPU-Shader (exp etwa 1e-4 relativ). Eine andere, gleich genaue Näherung lag weit unter 0,1 mm, verschob aber so viele Schwellenentscheidungen, dass CPU und GPU nicht mehr gleich entschieden. Gespart wird dagegen, was sich exakt umformen lässt: Wurzel und zwei Divisionen im Kantenfilter (der Test quadriert), die Division je Kandidat (Kehrwert), der Rest der Referenzfrequenz (an ihren eigenen Kandidaten null), die Plausibilitätsprüfung als Schranke auf u², NaN-sichere `min`/`max` (drei Befehle) durch einfache. Im AVX2-Build rechnet FMA mit.
- **Keine maskierten Speicherzugriffe:** `vmaskmovps` ist auf AMD Zen mikrocodiert und langsam; der AVX2-Code enthält keine mehr.
- **Gleichstände:** Sind nur 80 und 120 MHz nutzbar, wiederholen sich die Kandidaten alle 3,75 m mit gleichen Kosten. Bisher entschied dann das Rundungsrauschen, jetzt ein fester Zuschlag von 0,001 je Kandidatenschritt (`TIE_BREAK`): der nähere gewinnt, auf CPU und GPU gleich.
- **Entpacken:** die 11-Bit-Codes mit einem 64-Bit-Zugriff je Code direkt in Messwerte, ohne Zwischenfeld.
- **Nachschritte:** Push-Pull ohne gespeicherte volle Auflösung und auf den Dekoder-Threads; die IR-Füllung läuft neben der Erwartung des Auflösers; die Flutfüllung startet nur am Rand der Quellen.
- **Kompaktere Zwischenwerte brachten hier nichts:** Der Dekoder ist rechengebunden (neben einem Prozess, der dauernd Speicher kopiert, nicht langsamer). 9 statt 15 Ebenen aus Stufe 1 (a und b aus Betrag und Richtung) waren langsamer, weil der Filter dann mehr rechnet. Geblieben ist n² statt n (eine Multiplikation weniger je Nachbar). f16 für die Ebenen aus Stufe 1 (nachgestellt durch Runden auf 11 Bit, mit passender Skalierung): compat höchstens 0,09 mm, extended bei 99,9 % der Pixel unter 0,09 mm, aber 0,06 % springen um 2 bis 40 mm (Pixel, deren 16-MHz-Phase eine halbe Periode danebenliegt, kippen an einer Rundungsgrenze der Schätzung), vereinzelt um einen ganzen Bereich, und siebenmal so viele Pixel wie mit den Näherungen oben haben in einem der beiden Builds Tiefe und im anderen nicht. Zeitlich ist f16 so stabil wie f32 (40 Frames stillstehender Szenen mit Sensorrauschen): gleiches Rauschen (auf 0,01 mm), gleich viele Sprünge über der Glättungsschwelle des Hubs und gleich viele Wechsel zwischen mit und ohne Tiefe (je unter 1 % Unterschied); die Pixel, die f16 um mehr als 1 mm verschiebt, rauschen schon mit f32 um 24 mm (Median, alle Pixel: 4,6 mm). Schneller würde es auf der CPU nicht: jeder Lesezugriff bräuchte eine Umwandlung, und am Speicher hängt es nicht. Auf der GPU, wo der Speicherverkehr zählt, wäre f16 dagegen der richtige Hebel.

Zeit je Frame (Median aus fünf abwechselnden Läufen, `examples/bench_tof.rs`):

| | vorher | jetzt |
|---|---|---|
| compat, 1 / 3 / 4 Threads | 20,0 / 7,2 / 5,5 ms | 12,5 / 4,6 / 3,4 ms |
| extended, Raum, 1 / 3 / 4 Threads | 38,2 / 14,9 / 11,6 ms | 26,7 / 10,7 / 8,7 ms |
| extended, viel Sättigung, 1 / 3 / 4 Threads | 41,4 / 20,4 / 19,8 ms | 29,4 / 12,5 / 11,7 ms |

Genauigkeit gegen die vorige Version (`examples/tof_diff.rs`: 18 Frames, alle Szenen des Simulators, ein verlorenes Phasenbild, beschädigte Zeilen):

| je Frame | compat | extended |
|---|---|---|
| Tiefe, größte / mittlere Abweichung | 0,004 / 0,0001 mm | 0,006 / 0,0001 mm |
| IR, größte relative Abweichung | 3e-7 | 3e-7 |
| Pixel, die zwischen mit und ohne Tiefe wechseln | 1,8 von 121.700 | 34 von 157.800 |
| zum Vergleich: dieselben Szenen mit anderem Sensorrauschen | 17.200 | 20.900 |

Die wechselnden Pixel liegen genau an einer Schwelle (Konfidenz 0,6, Kanten- und Speckle-Test) oder sind Gleichstände wie oben. Der kompatible Modus liegt gegen `fn2/fast_depth.cpp` bei höchstens 0,004 mm, das IR ist gleich.

## Mit dem kinect-hub

Der Treiber ersetzt `fn2/bin/fn2_capture.exe` (libfreenect2) als Capture-Worker, ohne Änderung am Hub:

```bash
cd kinect-driver && cargo build --release
kinect-hub/target/release/kinect-hub.exe --worker kinect-driver/target/release/kinect-driver.exe
```

- `--pipeline fast` (Standard des Hubs) dekodiert auf der CPU, `--pipeline cl` auf der GPU (ohne GPU automatisch wieder CPU).
- Der Hub reicht nur `--pipeline` durch, alles andere über die Umgebung: `KINECT_DRIVER_MODE=compat|extended` (Standard extended), `KINECT_DRIVER_IR=hub|even|raw` (Standard hub; `hub:KNIE:WEISS` für eine andere Schulter), `KINECT_DRIVER_TOF=key=value,…`, `KINECT_DRIVER_LED=0..1000`, `KINECT_DRIVER_SOURCE=sim:room` (Test ohne Kinect), `KINECT_DRIVER_CACHE=Ordner|off`, `KINECT_DRIVER_PRIORITY=normal`.
- Der Heartbeat in `/api/status` → `worker.heartbeat` zeigt Dekoder, ms je Frame, verlorene/geflickte USB-Pakete, Teilframes, Neustarts.
- Getestet mit dem echten Hub (Linux-Build, simulierte Quelle): Zustand `streaming`, 30 fps, Kameraparameter und Frames kommen an, der Worker endet, wenn der Hub geht.
- Treiber unter Windows: derselbe wie für libfreenect2 (libusbK über Zadig auf „Xbox NUI Sensor“). Alternativ UsbDk (lässt den Microsoft-Treiber an seinem Platz): `KINECT_DRIVER_USBDK=1`.

Vor dem Einsatz in der Ausstellung: mit der echten Kinect eine Weile neben `fn2_capture` vergleichen (Posen, Personenerkennung, Szenen), besonders den erweiterten Modus und `KINECT_DRIVER_IR=even`, denn das Pose-Modell sieht das IR-Bild.

## Programm

```
kinect-driver [worker] [OPTIONEN]     Capture-Worker für den Hub (Binärprotokoll auf stdout)
kinect-driver list                    Kinects am USB
kinect-driver info [--save-calibration ORDNER]
kinect-driver stream [OPTIONEN] [--seconds N] [--png ORDNER]
kinect-driver record --out DATEI.k2raw [--seconds N]
kinect-driver replay DATEI.k2raw|sim:SZENE [OPTIONEN] [--frames N] [--every K] [--png ORDNER] [--compare]
kinect-driver bench [--source DATEI.k2raw|sim:SZENE] [--backend cpu|gpu] [--threads N] [--mode compat|extended] [--fps F [--seconds S]]
kinect-driver simulate --out DATEI.k2raw [--scene S] [--frames N]
kinect-driver eval [--scenes a,b] [--frames N] [--tof key=value,…]
kinect-driver analyze DATEI.k2raw [--frames N] [--tof key=value,…]
```

Optionen: `--mode extended|compat`, `--backend cpu|gpu|auto`, `--tof key=value,…` (alle Felder von `TofConfig`/`ExtendedParams`, z. B. `min_confidence=0.7,weak_boost=on,max_depth=12000`), `--ir hub|even|raw` (auch `hub:KNIE:WEISS`), `--source kinect|kinect:SERIAL|sim:SZENE|DATEI.k2raw`, `--led`, `--calibration-cache`. `kinect-driver help` listet alles. Log: `KINECT_DRIVER_LOG=debug`.

Aufnahmen zeigen den Raum im Infrarot: nur nach `recordings/` (git-ignoriert), nie committen. `.k2raw` ist das Format von `fn2/fn2_rawdump.exe`; beide Programme lesen die Dateien des anderen.

## Als Bibliothek

```toml
[dependencies]
kinect-driver = { path = "../kinect-driver/driver" }                  # USB (libusb wird mitgebaut)
kinect-driver = { path = "...", features = ["gpu"] }                   # + GPU-Dekodierung
kinect-driver = { path = "...", default-features = false }            # ohne USB: Aufnahmen, Simulator
```

```rust
use kinect_driver::driver::{Driver, DriverConfig, Event};

let driver = Driver::start(DriverConfig::default())?;      // sucht, startet, hält die Kinect am Laufen
while let Some(event) = driver.recv() {
    match event {
        Event::Frame(f) => println!("{} Pixel mit Tiefe, {:.1} ms", f.valid_pixels(), f.pipeline_ms),
        Event::State { state, detail } => println!("{} {detail}", state.name()),
        _ => {}
    }
}
```

Eigene Pipelines: die Dekodierung ist eine Stufe wie jede andere.

```rust
use kinect_driver::driver::PipelineFactory;
use kinect_driver::pipeline::{Backend, Pipeline};
use kinect_driver::stages::{IrToneMap, TemporalFilter, Points};

let factory: PipelineFactory = std::sync::Arc::new(|| {
    Ok(Pipeline::decoder(kinect_driver::TofConfig::extended(), Backend::Gpu)?
        .with(IrToneMap::even())
        .with(TemporalFilter::default())
        .with(Points)
        .with_fn("mein schritt", |frame| {
            // frame.depth, frame.ir, frame.confidence, frame.flags, frame.points, frame.set_extra(...)
            Ok(())
        }))
});
let cfg = kinect_driver::DriverConfig { pipeline: Some(factory), ..Default::default() };
```

- `Frame`: Tiefe (mm), IR, Konfidenz 0..1, Flags je Pixel (`tof::flags`: gesättigt, rekonstruiert, aus Nachbarn aufgelöst, Kante, gefüllt, Mehrwege, …), 3D-Punkte, eigene Ebenen (`extra`). Die Ebenen gehen zurück in den Pool, wenn der Frame fallen gelassen wird: Was länger gebraucht wird, mit `std::mem::take(&mut frame.depth)` herausnehmen oder kopieren.
- Quellen: `Source::Kinect`, `Source::Recording` (`.k2raw`, Echtzeit oder so schnell wie möglich, in Schleife), `Source::Simulator`, `Source::Backend` (eigener USB-Backend, z. B. das simulierte Gerät `usb::mock` mit Fehlerinjektion).
- Ohne Treiber-Threads: `CpuDecoder` / `gpu::GpuDecoder` direkt auf Rohpakete; `gpu::GpuDecoder::with_device` nutzt ein vorhandenes wgpu-Device (wgpu 30, dieselbe Version wie wall-bevy).
- `pipeline::Backend::Gpu` fällt ohne GPU oder nach einem GPU-Fehler (Treiber-Reset, Device verloren) auf die CPU zurück und versucht die GPU alle 30 s neu.

## Was bei Störungen passiert

| Störung | Reaktion |
|---|---|
| keine Kinect | sucht weiter, merkt eine später eingesteckte |
| USB-2-Port | klare Meldung, sucht weiter |
| libusb startet nicht | versucht es alle 2 s neu |
| Befehl schlägt fehl | Wiederholung, die Antwort-Pipe wird geleert (eine späte Antwort wird nie für die nächste gehalten); Unwichtiges wird übersprungen |
| Kalibrierung nicht lesbar | die zwischengespeicherte desselben Geräts (`.k2cal`) |
| verlorenes iso-Paket | mit Nullen in seiner Größe aufgefüllt, nur die betroffenen Zeilen gelten als verloren und werden rekonstruiert; jedes Paket wird an seinem eigenen Offset gelesen (libfreenect2 verrutscht nach einem Fehler) |
| unvollständiger Frame | ab 6 von 9 Phasenbildern geliefert und dekodiert |
| Frames bleiben aus (2 s; 8 s nach dem Start) oder der Stream stirbt | Sensor-Neustart; scheitert das wiederholt, beim nächsten Öffnen Port-Reset, danach Firmware-Neustart |
| Kinect verschwindet | wird beim Wiederauftauchen wieder aufgenommen; alte, hängende Transfers bleiben bewusst liegen statt freigegeben zu werden, ein späterer Callback kann nichts mehr kaputtmachen |
| Anwendung liest zu langsam | alte Frames werden verworfen, nie unbegrenzt gepuffert |
| Panic in einer Stufe, einem Thread, einem USB-Callback | abgefangen, gezählt; der Thread beginnt neu, der Callback reicht den Transfer weiter |
| GPU-Fehler | wgpu-Fehler werden abgefangen (wgpu würde sonst abbrechen), Fehler-Scope je Frame, CPU springt ein |

Getestet gegen ein simuliertes Gerät mit Fehlerinjektion (`usb/mock.rs`): verlorene und verfälschte Pakete, belegte Geräte, Befehls-Timeouts, Ausstecken und Wiedereinstecken, stehender Stream, USB 2, eine Stufe, die bei jedem zweiten Frame abstürzt.

## Plattformen

- **Windows**: libusbK über Zadig (wie für libfreenect2) oder UsbDk (`KINECT_DRIVER_USBDK=1`). Baut mit `stable-x86_64-pc-windows-gnu` (w64devkit; als Cross-Build geprüft); libusb wird mitgebaut, es ist keine DLL nötig. Der Worker läuft wie `fn2_capture` mit erhöhter Priorität (`KINECT_DRIVER_PRIORITY=normal` lässt das).
- **Linux**: Zugriff auf das Gerät per udev-Regel, z. B. `/etc/udev/rules.d/90-kinect2.rules`:
  `SUBSYSTEM=="usb", ATTR{idVendor}=="045e", ATTR{idProduct}=="02d8", TAG+="uaccess"` (und `02c4` für die Vorabversion), dann `sudo udevadm control --reload && sudo udevadm trigger`. Bei Problemen mit großen iso-Transfers: `usbcore.usbfs_memory_mb=0` (oder ≥ 64).
- **macOS**: libusb braucht nichts weiter. Ungetestet.
- **GPU**: Vulkan, Metal, DirectX 12, OpenGL ES 3.1 (wgpu). `KINECT_DRIVER_GPU=low` bevorzugt die integrierte GPU; `WGPU_BACKEND`/`WGPU_ADAPTER_NAME` wählen weiter.

## Entwickeln

```bash
cargo build --release                              # Bibliothek + Programm (USB, GPU)
cargo test --workspace --all-features              # ~65 Tests; die GPU-Tests laufen auf jeder wgpu-GPU (auch lavapipe)
cargo clippy --workspace --all-targets --all-features
cargo build --release --target x86_64-pc-windows-gnu -p kinect-driver-cli    # Windows-Build von Linux aus
cargo run --release -p kinect-driver --example eval_sim                       # weitere Auswertungen: examples/
```

- `driver/src/tof/`: CPU-Dekoder (`kernels.rs` die Pixelkerne, je acht Pixel in `lanes.rs`-Werten, mit AVX2/FMA per Laufzeitauswahl; `resolve.rs` die Nachbarschaftsauflösung; `post.rs` Flood-Fill und IR-Füllung; `fill.rs` Push-Pull), `config.rs` alle Parameter.
- Änderungen an den Kernen prüfen: `examples/tof_diff.rs` vergleicht die Ausgabe zweier Builds Pixel für Pixel (`dump ORDNER` in beiden, dann `compare ALT NEU`), `examples/bench_tof.rs` misst je Phase (Median).
- `driver/src/gpu/`: `decode.wgsl` (dieselben Schritte als Compute-Shader), `mod.rs` (wgpu, Rückfall auf die CPU).
- `driver/src/usb/`: Trait-Grenze, `libusb.rs` (echtes Gerät), `mock.rs` (simuliertes Gerät).
- `driver/src/protocol/`, `device.rs`: Befehle, Antworten, Paket-Zusammenbau, Startsequenz (wie libfreenect2, aber nachsichtig).
- `driver/src/driver.rs`: Supervisor (Quellen, Watchdog, Eskalation, Ereignisse).
- `driver/src/sim/`: Simulator mit Szenen (`room`, `near`, `far`, `ramp`, `sun`, `hall`, `flat`, `visitor`) und Auswertung.
- IR-Vergleichsbilder (libfreenect2 / `hub` / `even`, so wie der Hub sie zeigt): `cargo run --release -p kinect-driver --example ir_demo -- ORDNER visitor near room hall`.
