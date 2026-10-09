# ndkk-kinect-wall

Kinect v2 an einem Windows-Rechner (USB-Mod): Tiefenbild mit 30 fps, eine Middleware, über die beliebig viele Programme und Agenten gleichzeitig auf den Sensor zugreifen, und eine Szenen-Werkstatt, in der viele Agenten parallel (je ein Worktree) Browser-Szenen für die Wand entwickeln.

| Teil | Was |
|---|---|
| [`kinect-hub/`](kinect-hub/README.md) | Rust-Middleware: besitzt die Kinect, rechnet einmal pro Frame vor, streamt per WebSocket/HTTP an alle |
| [`web/`](web/README.md) | Szenen-Werkstatt (Vite): Galerie, Laufzeit mit Hot-Swap, Beispielszenen (Punktwolke, Shader, three.js). Anleitung für Agenten: [`web/AGENTS.md`](web/AGENTS.md) |
| `fn2/` | C++ auf libfreenect2: Capture-Worker für den Hub, Reconnect-Messtool, DLLs für Python |
| `kinect_hub.py` | Python-Client für den Hub |
| `pointcloud.py`, `viewer.py` | Python-Viewer (direkt über libfreenect2/SDK oder `--hub`) |
| `third_party/` | `setup.sh` holt und baut libfreenect2 (gepatcht), libusb, libjpeg-turbo, OpenCL-Header |
| `start-wand.cmd` | Die Wand mit einem Klick starten (Ausstellung), siehe unten |

## Ausstellung: alles mit einem Klick

`start-wand.cmd` (Doppelklick, oder Desktop-Symbol „Kinect-Wand starten“) startet aus dem main-Checkout den Hub, den Dev-Server und das Ausgabefenster der Wand. Was schon läuft, wird mitbenutzt, und was abstürzt, startet neu. Solange das Programm läuft, stellt es Windows auf Leistung:

- Energieplan: eine vorübergehende Kopie von „Höchstleistung“ (kein Standby, Bildschirm bleibt an, Deckel zu = nichts tun, USB- und PCIe-Energiesparen aus)
- Hub und Tiefen-Worker mit hoher Priorität, Chat- und Sync-Apps (Teams, WhatsApp, Signal, Smartphone-Link, OneDrive, …) im Effizienzmodus
- nach einer UAC-Abfrage: Windows-Suche, SysMain, Telemetrie und Windows Update angehalten (nicht deaktiviert)

Die Bildschirme erkennt das Programm bei jedem Start von selbst, einstellen musst du nichts.
- Das Wand-Fenster geht auf dem Zweitmonitor auf, nie auf dem Notebook. Ohne Zweitmonitor bleibt es zu, bis einer angeschlossen ist. Landet ein Wand-Fenster doch auf dem Notebook, schließt das Programm es sofort.
- Die Steuerzentrale geht als eigenes Fenster maximiert auf dem Notebook-Bildschirm auf. Bei zugeklapptem Deckel bleibt sie zu, damit sie nie auf der Wand landet. **S** holt sie zurück.

Beenden mit **Q** im Fenster. **NOTAUS: Strg+Alt+Shift+N** (wirkt in jedem Fenster) oder das Desktop-Symbol „Kinect-Wand NOTAUS“: Das beendet alles, was das Programm gestartet hat, und stellt alle Werte zurück. Jeder alte Wert steht in `%LOCALAPPDATA%\kinect-wand\journal.json`, bevor er geändert wird. Wird das Fenster geschlossen oder stürzt es ab, stellt ein Wächter-Prozess alles zurück. Nach einem Absturz des PCs passiert das bei der nächsten Anmeldung, und den Rest räumt der nächste Start auf. Optionen: `-NoWall`, `-NoControl`, `-NoAdmin`, `-Hub 8091`.

## Schnellstart

```
kinect-hub\target\release\kinect-hub.exe
```

Dann im Browser (Chrome/Edge, wegen WebGPU) **http://127.0.0.1:8090** öffnen: Status, Live-Vorschau und die Szenen aller laufenden Dev-Server. Szenen entwickeln (je Worktree ein Dev-Server, Node.js 20+):

```
cd web
npm install
npm run dev
```

Details in [`web/README.md`](web/README.md). Weitere Programme lesen parallel mit:

```
python viewer.py --hub
python pointcloud.py --hub
```

Ohne Kinect gibt es eine generierte Testszene: `kinect-hub.exe --source synthetic`. Echte Daten ohne jemanden vor dem Sensor liefert eine Aufnahme: `kinect-hub-probe record --seconds 30 --out recordings/NAME.k2rec` nimmt vom laufenden Hub auf, `kinect-hub.exe --source replay recordings/NAME.k2rec --bind 127.0.0.1:8091` spielt sie in Schleife ab (siehe [`kinect-hub/README.md`](kinect-hub/README.md)). Aufnahmen zeigen den Raum und die Menschen darin und bleiben in `recordings/`, das git ignoriert.

## Aus dem Repo bauen

Voraussetzungen:
- Windows 10/11 mit Git for Windows (Git Bash). Die Shell-Skripte laufen dort.
- [w64devkit](https://github.com/skeeto/w64devkit): gcc, cmake, ninja im `PATH`.
- Rust (rustup, Toolchain `stable-x86_64-pc-windows-gnu`).
- Python 3 mit `pip install -r requirements.txt`.
- Node.js 20 oder neuer, für die Szenen in `web/` (`npm install` dort).
- Kinect-Treiber: in Zadig „Xbox NUI Sensor (Interface 0)“ auf **libusbK** umstellen (Options → List All Devices). Damit läuft das Kinect SDK nicht mehr. Zurück geht es im Geräte-Manager: Treiber samt Treibersoftware deinstallieren, dann nach geänderter Hardware suchen.

```
sh third_party/setup.sh            # libfreenect2 + Abhängigkeiten holen, patchen, bauen
sh fn2/build.sh                    # Capture-Worker, Messtool, DLLs
cd kinect-hub && cargo build --release
```

## Punktwolken-Demo (Python)

```
python pointcloud.py                     # Live-Fenster, Kamera kreist langsam um die Szene
python pointcloud.py --still bild.png    # Einzelbild rendern (--yaw, --pitch, --zoom, --size 1920x1080)
python pointcloud.py --hub               # Daten vom laufenden kinect-hub
```

Weiße, beleuchtete Punkte auf dunklem Grau mit Glow und Vignette. Jedes Tiefenpixel wird mit der Kalibrierung aus der Kinect in 3D umgerechnet und dann von einer virtuellen Kamera aus gezeichnet. Das Zeichnen übernimmt `fn2/bin/cloudsplat.dll` (`fn2/cloudsplat.cpp`).

| Taste / Maus | Funktion |
|---|---|
| Maus ziehen / Rad | drehen / zoomen |
| Leertaste | Auto-Orbit an/aus |
| `r` | Ansicht zurücksetzen |
| `+` / `-` | Punktgröße |
| `d` | Dichte (jedes 1./2./3. Sensorpixel) |
| `g` / `t` | Glow / zeitliche Glättung an/aus |
| `m` | spiegeln (falls links/rechts vertauscht ist) |
| `s` | Snapshot nach `snapshots/` |
| `f` | Vollbild |
| `h` | Hilfe ein/aus |
| `q` / `Esc` | beenden |

## libfreenect2

- Tiefe über OpenCL (iGPU): 30 fps bei ~6 ms pro Frame. Die CPU-Pipeline schafft nur ~5 fps.
- Die lokalen Änderungen stehen in `third_party/libfreenect2-fastreconnect.patch`:
  - kein USB-Reset beim Öffnen und keine festen Wartezeiten mehr
  - OpenCL-Header-Fix
  - optionaler Firmware-Reboot zum Testen
- Messtool:

  ```
  fn2\bin\fn2_reconnect.exe --no-rgb                  # nur Tiefe, Reconnect automatisch
  fn2\bin\fn2_reconnect.exe --no-rgb --kick 8         # alle 8 s Firmware-Reboot, misst den Reconnect
  ```

  Optionen: `--pipeline cpu|cl|clkde` (Standard `cl`), `--fresh-pipeline`, `--seconds N`, `--csv FILE`, `-v`.
- Ein Reconnect nach einem Firmware-Reboot dauert ~5,7 s:
  - ~2,1 s ist die Kinect vom USB weg
  - ~3,1 s meldet die Firmware „Sensor nicht bereit“
  - nur ~150 ms entfallen auf die Software

  Wer nicht auf das Bereit-Bit wartet (`LIBFREENECT2_STATUS_TIMEOUT_MS=0`), bekommt danach oft keinen laufenden Stream. Nicht verwenden.

## Viewer mit dem Kinect SDK

Für diesen Weg muss statt libusbK der SDK-Treiber installiert sein (Kinect for Windows SDK 2.0).

```
python viewer.py               # Farbe + Tiefe
python viewer.py --depth-only  # nur Tiefe, ein großes Fenster
python viewer.py --fn2         # Tiefe über libfreenect2 (libusbK-Treiber)
python viewer.py --hub         # Tiefe vom laufenden kinect-hub
```

Setzt sich der Sensor zurück, bleibt das letzte Bild abgedunkelt stehen, mit Timer und Phase. `q`/`Esc` beendet, `m` spiegelt, `s` speichert einen Snapshot nach `snapshots/` (Tiefe als 16-Bit-PNG in mm). Fährt die Maus über das Tiefenfenster, zeigt der Viewer die Entfernung unter dem Cursor.

`kinect2.py` ist eine schlanke ctypes-Anbindung an `Kinect20.dll`. Die vtable-Indizes stammen aus `inc\Kinect.h` des SDK.

## Hardware-Notizen (USB-Mod)

- Kinect-Kabel:
  - braun = +12 V
  - grau = Masse (zusätzlich mit USB-GND verbinden)
  - **rot = VBUS 5 V an USB-Pin 1** (ohne meldet sich die Kinect gar nicht an)
  - schwarz = USB-GND
  - weiß/grün (verdrillt) = D−/D+
  - die zweite weiße Ader frei lassen
  - Folienpaare = SuperSpeed
- Lüfter (Nidec U40R05MS1A7-57A07A, MS-Teilenr. X880927-004, 5 V, 4-polig):
  - Mit dem Kinect SDK setzte sich die Kinect beim Streamen alle ~14 s zurück, weil der Lüfter nicht lief.
  - Jetzt läuft er dauerhaft voll: Die gelbe Leitung (PWM) ist abgeklemmt, die blaue (Tacho) wieder angeschlossen.
  - Ergebnis: 3 × 10 min Stresstest mit Tiefe und Farbe, kein einziger Reset.

## Wenn keine Bilder kommen

- `http://127.0.0.1:8090/api/status` zeigt Sensorzustand, Worker, Fehler.
- Im Geräte-Manager prüfen, ob „Xbox NUI Sensor (Interface 0)“ mit libusbK da ist.
- Mit SDK-Treiber: Configuration Verifier (`C:\Program Files\Microsoft SDKs\Kinect\v2.0_1409\Tools\ConfigurationVerifier\KinectV2ConfigurationVerifier.exe`) und Kinect Studio als Gegencheck.
