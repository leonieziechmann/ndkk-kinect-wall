# kinect-driver

Ein schlanker Kinect-v2-Treiber in Rust, der nicht abstürzt: USB direkt über libusb (Windows, Linux, macOS), die Tiefen- und IR-Berechnung aus den Rohdaten der Time-of-Flight-Kamera auf der CPU (SIMD, ein paar Threads) oder der GPU (wgpu-Compute-Shader), und Pipelines aus Stufen, die man konfigurieren und um eigene ergänzen kann. Als Bibliothek (Crate `kinect-driver`) oder als Programm `kinect-driver`, das auch als Capture-Worker in den kinect-hub passt.

| Ordner | Was |
|---|---|
| `driver/` | die Bibliothek: USB, Protokoll, Tiefen-/IR-Dekodierung (CPU und GPU), Pipelines, Simulator, Aufnahmen |
| `cli/` | das Programm `kinect-driver`: Worker für den Hub und Werkzeuge |
| `tools/` | C++-Harness, das den kompatiblen Modus gegen `fn2/fast_depth.cpp` prüft |

## Was er anders macht

**Mehr Reichweite (Modus `extended`).** libfreenect2 rechnet mit einer geschlossenen Formel nur bis 4,5 m und verwirft alles, wo eine Frequenz sättigt. Der erweiterte Modus sucht über den ganzen eindeutigen Bereich der drei Frequenzen (80, 16, 120 MHz → 18,75 m) die wahrscheinlichste Entfernung: jede Kandidatenentfernung der genauesten Frequenz wird mit allen brauchbaren Frequenzen nach ihrem Rauschen gewichtet verfeinert, die Konfidenz kommt aus dem Abstand zum zweitbesten Kandidaten und der Konsistenz der Phasen. Dazu:
- **Nah trotz Sättigung:** Die drei Phasenproben einer Frequenz summieren sich zu null. Ist eine davon gesättigt, wird sie aus den beiden anderen rekonstruiert; ist mehr gesättigt, fällt nur diese Frequenz weg, und die Entfernung kommt aus den übrigen beiden. Bleibt nur eine Frequenz, entscheiden die Nachbarn (Abstimmung, bei gesättigten Nachbarn bevorzugt die desselben hellen Objekts), sonst eine glatte Erwartung aus der Umgebung. Wo alle Frequenzen sättigen, wird die Tiefe vom gemessenen Rand desselben Objekts nach innen interpoliert (Flag `DEPTH_FILLED`).
- **Weit:** Kandidaten, die eine unmögliche Helligkeit bräuchten (ein heller Punkt kann nicht 12 m weg sein, ein dunkler eher ein Echo von jenseits des Bereichs), werden bestraft; ein Speckle-Filter nimmt einzelne Ausreißer heraus, der Kantenfilter wächst mit der Entfernung.
- **Verlorene USB-Daten:** Fehlt ein Phasenbild (oder ein Teil davon, weil ein USB-Paket verloren ging), wird es wie eine gesättigte Probe aus den beiden anderen seiner Frequenz rekonstruiert, mit passend höherem Rauschen im Modell.

**IR ohne Überbelichtung (HDR).** Statt die drei Frequenzen zu addieren und bei 65535 abzuschneiden, ist das IR der gewichtete Mittelwert der brauchbaren Frequenzen: sättigt eine, tragen die anderen (rekonstruierte schwächer gewichtet). Nur wo alle sättigen, wird aus der Umgebung gefüllt, nie dunkler als der Pegel, bei dem dieser Sensor sättigt. Die Werte gehen über 65535 hinaus; die Stufe `IrToneMap` bringt sie in einen Ausgabebereich:
- `hub`: bis 3000 unverändert, darüber weich komprimiert (Reinhard) statt abgeschnitten (für die Weiß-bei-6000-Darstellung des Hubs)
- `even`: gleichmäßigere Belichtung: der Abfall mit der Entfernung wird herausgerechnet (auf 2,5 m bezogen; Nahes höchstens 4-fach dunkler, Fernes höchstens 2,5-fach heller, damit das Rauschen hinten nicht aufblüht), dann wie `hub`

**Kompatibler Modus (`compat`).** Das Verfahren von libfreenect2 bzw. `fn2/fast_depth.cpp` mit denselben Ergebnissen (gegen fast_depth geprüft mit `tools/fastdepth_ref.cpp`); die Flags bleiben dort leer.

**Robust.** Siehe [Was bei Störungen passiert](#was-bei-störungen-passiert). Der Code verbietet `unwrap`, `expect`, `panic!` und ungeprüftes Indizieren; jeder Thread, jede Stufe und jeder USB-Callback fängt Panics ab.

## Gemessen (Simulator)

Ohne Kinect in dieser Umgebung ist alles gegen einen physikalischen Simulator der Kamera gemessen (`driver/src/sim/`: Phasen, Rauschmodell, Sättigung, Mehrwegfehler, Pixelkanten), der den Rohpaketen der Kinect Byte für Byte gleicht. `kinect-driver eval` druckt die Tabellen. Anteil der Pixel mit Tiefe / davon richtig (innerhalb 1 % bzw. 15 mm) / falsch (über 5 % daneben):

| Szene, Bereich | compat | extended |
|---|---|---|
| Raum, 3–4,5 m | 65 % / 54 % / 0,05 % | 78 % / 66 % / 0,24 % |
| Raum, 4,5–6 m (Rückwand) | 34 % / 34 % / 0 % | 99 % / 99 % / 0 % |
| nah, unter 0,5 m | 0 % | 98 % / 60 % / 0 % |
| nah, gesättigte Pixel | 0 % | 100 % / 55 % / 0 % |
| Halle, 4,5–6 m | 0,5 % / 0,2 % / 0,05 % | 32 % / 22 % / 0,47 % |
| Halle, 8–10 m | 0,3 % / 0 % / 0,3 % | 44 % / 39 % / 0,13 % |
| dunkle Flächen, 6–8 m | 0,1 % / 0 % / 0,05 % | 15 % / 9 % / 1,1 % |

IR, wo der Sensor sättigt: compat 100 % weiß abgeschnitten, extended 0 %. Ein verlorenes Phasenbild kostet im erweiterten Modus 2–15 % der richtigen Pixel (ohne Rekonstruktion bis zu 99 % oder 20-mal mehr falsche).

**Das muss sich an der echten Kinect noch bestätigen.** Der Simulator ist nach dem Rauschmodell der Literatur gebaut, nicht nach diesem Sensor. Werkzeuge dafür: `kinect-driver record` (Rohdaten), `replay --compare --png` (beide Modi nebeneinander), `analyze` (Helligkeit, Verstärkung und Rauschen des eigenen Sensors → `--tof`-Einstellungen).

**Zeit** (Xeon 2,8 GHz, 4 vCPU, AVX2): compat 8 ms je Frame mit 3 Threads (21 ms mit einem), extended 18–19 ms (40–44 ms mit einem). Auf der GPU (wgpu) dieselben Ergebnisse bis auf Rundung (Tiefe max. 0,002 mm Abweichung, gemessen mit lavapipe); die Zeit dort hängt von der GPU ab: `kinect-driver bench`.

## Mit dem kinect-hub

Der Treiber ersetzt `fn2/bin/fn2_capture.exe` (libfreenect2) als Capture-Worker, ohne Änderung am Hub:

```bash
cd kinect-driver && cargo build --release
kinect-hub/target/release/kinect-hub.exe --worker kinect-driver/target/release/kinect-driver.exe
```

- `--pipeline fast` (Standard des Hubs) dekodiert auf der CPU, `--pipeline cl` auf der GPU (ohne GPU automatisch wieder CPU).
- Der Hub reicht nur `--pipeline` durch, alles andere über die Umgebung: `KINECT_DRIVER_MODE=compat|extended` (Standard extended), `KINECT_DRIVER_IR=hub|even|raw` (Standard hub), `KINECT_DRIVER_TOF=key=value,…`, `KINECT_DRIVER_LED=0..1000`, `KINECT_DRIVER_SOURCE=sim:room` (Test ohne Kinect), `KINECT_DRIVER_CACHE=Ordner|off`, `KINECT_DRIVER_PRIORITY=normal`.
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
kinect-driver bench [--source DATEI.k2raw|sim:SZENE] [--backend cpu|gpu] [--threads N]
kinect-driver simulate --out DATEI.k2raw [--scene S] [--frames N]
kinect-driver eval [--scenes a,b] [--frames N]
kinect-driver analyze DATEI.k2raw [--frames N]
```

Optionen: `--mode extended|compat`, `--backend cpu|gpu|auto`, `--tof key=value,…` (alle Felder von `TofConfig`/`ExtendedParams`, z. B. `min_confidence=0.7,weak_boost=on,max_depth=12000`), `--ir hub|even|raw`, `--source kinect|kinect:SERIAL|sim:SZENE|DATEI.k2raw`, `--led`, `--calibration-cache`. `kinect-driver help` listet alles. Log: `KINECT_DRIVER_LOG=debug`.

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

- `Frame`: Tiefe (mm), IR, Konfidenz 0..1, Flags je Pixel (`tof::flags`: gesättigt, rekonstruiert, aus Nachbarn aufgelöst, Kante, gefüllt, …), 3D-Punkte, eigene Ebenen (`extra`).
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

- `driver/src/tof/`: CPU-Dekoder (`kernels.rs` die Pixelkerne, zeilenweise, vektorisiert, mit AVX2/FMA per Laufzeitauswahl; `resolve.rs` die Nachbarschaftsauflösung; `post.rs` Flood-Fill und IR-Füllung), `config.rs` alle Parameter.
- `driver/src/gpu/`: `decode.wgsl` (dieselben Schritte als Compute-Shader), `mod.rs` (wgpu, Rückfall auf die CPU).
- `driver/src/usb/`: Trait-Grenze, `libusb.rs` (echtes Gerät), `mock.rs` (simuliertes Gerät).
- `driver/src/protocol/`, `device.rs`: Befehle, Antworten, Paket-Zusammenbau, Startsequenz (wie libfreenect2, aber nachsichtig).
- `driver/src/driver.rs`: Supervisor (Quellen, Watchdog, Eskalation, Ereignisse).
- `driver/src/sim/`: Simulator mit Szenen (`room`, `near`, `far`, `ramp`, `sun`, `hall`, `flat`, `visitor`) und Auswertung.
- IR-Vergleichsbilder (libfreenect2 / `hub` / `even`, so wie der Hub sie zeigt): `cargo run --release -p kinect-driver --example ir_demo -- ORDNER visitor near room hall`.
