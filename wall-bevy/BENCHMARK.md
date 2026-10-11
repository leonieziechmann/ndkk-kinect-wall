# Browser-Ausgabe gegen wall-bevy: Messung

Stand: 11.10.2026, wall-bevy-Release-Build mit Single-Threaded-Executor. Die echte Antwort liefert die
Messung auf dem Ausstellungs-Notebook mit `bench/compare.mjs` (siehe README). Diese Messung lief auf
einer Linux-VM **ohne GPU**. Was darauf übertragbar ist, steht unten.

## Aufbau

- **Gleiche Bedingungen:** dieselbe Show (eine Szene allein), derselbe Hub (`fake_hub`, 3 erfundene
  Personen, 30 fps), derselbe Bildschirm (Xvfb 1920×1080, randlos), dasselbe Wand-Setup
  (1008×336, pixelgenau).
- **Browser:** Chromium 141 mit den Flags des Kiosk-Fensters (`web/tools/wall-launch.js`).
- **wall-bevy:** der Release-Build.
- **Ablauf:** je Szene 6 s Anlauf, dann 20 s Messung, ohne DevTools-Verbindung während der Messung.
- **Rechner:** 4 vCPUs (Xeon 2,8 GHz), keine GPU. Beide rendern in Software: der Browser mit
  SwiftShader (WebGPU) und llvmpipe (Compositor), wall-bevy mit lavapipe. Die Threads der
  Software-Rasterizer laufen auf zwei eigenen Kernen und werden getrennt gezählt. So verfälscht ihre
  Last die Zeiten der übrigen Threads nicht.
- **Gemessen:** jedes Bild (Abstand, Arbeit im Hauptthread: im Browser die Zeit der
  `requestAnimationFrame`-Callbacks, in wall-bevy die Zeit der Ausgabe ohne Treiber-Submits), die CPU
  je Thread aus `/proc`, der Speicher (PSS) und die V8-GC-Pausen (`--trace-gc`).

**Nicht vergleichbar sind die Bildraten.** Die zwei Software-Rasterizer sind unterschiedlich schnell,
SwiftShader schafft `pixel-spiegel` mit 0,2 fps, lavapipe mit 8 fps. Auf dem Notebook rendert die GPU,
dort zählen die Zahlen unten zur CPU-Seite.

## Ergebnis

Die zehn Wand-Szenen der Show (Median über die Szenen):

| | Browser | wall-bevy |
|---|---|---|
| Arbeit im Hauptthread je Bild, p50 | 5,6 ms | 2,3 ms |
| … p99 | 16,8 ms | 3,9 ms |
| … längstes einzelnes Bild (alle Szenen) | 730 ms | 12 ms |
| Garbage Collection | 57 je Minute, Pausen bis 28 ms | – |
| CPU ohne Software-Rasterizer (% eines Kerns) | 28 % | 17 % |
| davon Hauptthread | 11 % | 9 % |
| Speicher (PSS, mit Software-GPU) | 561 MB | 545 MB |
| Start bis zum ersten Bild | 0,8 s | 3,8 s (bereitet alle 19 Szenen vor) |
| Hauptthread blockiert beim Szenenwechsel (längstes Bild) | bis 1,3 s | bis 17 ms |

Je Szene (Browser / wall-bevy; Arbeit je Bild in ms; GC: Anzahl in 20 s, längste Pause):

| Szene | Arbeit p50 | Arbeit p99 | Arbeit max | GC | CPU ohne Rasterizer |
|---|---|---|---|---|---|
| wand-spiegel | 1,4 / 0,9 | 4,5 / 2,1 | 5 / 4,8 | 8, 6 ms | 20 / 13 % |
| pixel-spiegel | 3,0 / 0,9 | 4,6 / 1,4 | 5 / 1,7 | 16, 3 ms | 11 / 10 % |
| fluid-simulation | 2,0 / 0,9 | 4,2 / 2,8 | 4 / 2,8 | 21, 14 ms | 16 / 7 % |
| modern-events | 6,6 / 2,9 | **235** / 5,0 | **243** / 8,7 | 17, 10 ms | 45 / 18 % |
| pixel-jump-run | 5,3 / 2,7 | 17,0 / 5,8 | 39 / 7,5 | 94, 28 ms | 54 / 17 % |
| blasen-platzen | 5,9 / 3,4 | 16,5 / 6,1 | 20 / 12,4 | 13, 25 ms | 33 / 18 % |
| llg-sakura | 6,0 / 2,8 | **335** / 4,2 | **730** / 5,3 | 24, 5 ms | 22 / 11 % |
| leonie-ziechmann | 4,0 / 1,7 | 8,7 / 3,6 | 19 / 9,9 | 0 | 19 / 17 % |
| fruit-ninja | 11,0 / 1,9 | 23,1 / 3,3 | 27 / 5,6 | 24, 13 ms | 42 / 27 % |
| space-invaders | 15,3 / 3,2 | 61,4 / 5,5 | 129 / 5,8 | 62, 13 ms | 57 / 21 % |
| person-mask | 1,6 / 1,4 | 3,3 / 2,6 | 4 / 3,9 | 11, 11 ms | 25 / 16 % |
| person-skeleton | 1,5 / 0,8 | 6,8 / 1,7 | 7 / 3,2 | 22, 3 ms | 13 / 9 % |
| depth-shader | 0,9 / 0,5 | 5,7 / 0,8 | 6 / 1,2 | 9, 8 ms | 26 / 12 % |
| live-exakt | 2,2 / 3,2 | 5,0 / 5,4 | 12 / 7,2 | 9, 51 ms | 49 / 29 % |
| neon-room | 1,2 / 1,0 | 1,8 / 2,1 | 2 / 2,1 | 22, 5 ms | 71 / 8 % |
| pointcloud | 0,5 / 0,4 | 1,3 / 0,9 | 1 / 2,3 | 8, 2 ms | 78 / 7 % |
| invaders-tracking | 7,9 / 3,3 | 25,6 / 5,3 | 72 / 7,5 | 100, 67 ms | 79 / 29 % |

`cyberspiegel` und `three-points` laufen in diesem Chromium nicht: three.js r186 setzt `swizzle` an
Texturansichten, das kennt Chromium 141 noch nicht. Im Ausstellungs-Chrome bitte prüfen.

## Szenenwechsel

Gemessen wurde eine Show mit den zehn Wand-Szenen, je 10 s, Überblendung 1 s, zwei Runden. Der Browser
blockiert beim Wechsel den Hauptthread, während er die neue Szene einrichtet: bei `pixel-jump-run`
1,3 s, `leonie-ziechmann` 1,2 s, `fruit-ninja` 0,45 s, `llg-sakura` 0,31 s, `space-invaders` 0,15 s. So
lange steht die alte Szene mitten in der Überblendung still. Dazu kommen die Shader: Der Browser
übersetzt sie beim Wechsel, bei `fluid-simulation` stand das Bild 5 s. Auf einer echten GPU geht das
schneller, es passiert aber trotzdem im Moment des Wechsels.

wall-bevy richtet die Szene in einem Worker-Thread ein und hat alle Shader beim Start übersetzt. Das
längste Bild im Hauptthread lag bei einem Wechsel bei 17 ms (im Median 7 ms). Die Bildabstände wachsen
nur in der Überblendung, in der beide Szenen rendern, auf das 1,1- bis 2,2-Fache.

## Was davon auf dem Notebook gilt

- **Gilt so:** Die Ruckler im Browser kommen aus dem Hauptthread: lange JavaScript-Bilder
  (`modern-events`, `llg-sakura`, `space-invaders`), GC-Pausen bis 67 ms (meist volle GCs,
  Mark-Compact) und das Einrichten beim Szenenwechsel. Das hängt nicht an der GPU.
- **Eher schlimmer im Browser:** Auf dem Notebook rendert der Browser schneller, also fällt mehr
  Garbage an, und die GC läuft öfter.
- **Rendern selbst:** Wer mit gleicher GPU-Last schneller zeichnet, zeigt erst die Messung mit echter
  GPU. `node wall-bevy/bench/compare.mjs` misst unter Windows auch die GPU-Last je Prozess.
- **Was wall-bevy kostet:** Es braucht etwa 3 s länger bis zum ersten Bild, weil es alle Szenen
  vorbereitet. Dafür ruckelt später kein Wechsel. `live-exakt`, eine Prüfszene, ist nativ etwas
  teurer (CPU-Linien).

## Gefunden und behoben

Bevys Thread-Pool kostete etwa 10 % eines Kerns nur für das Wecken seiner Threads. Alle Schedules
laufen jetzt single-threaded, Hauptthread und Bildzeiten sind unverändert (`WALL_EXECUTOR=multi`
schaltet zum Vergleich zurück).
