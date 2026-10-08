# Sprungerkennung kalibrieren

So prüfen und justieren wir, ob `pixel-jump-run` Sprünge richtig erkennt: mit zwei Aufnahmen, in denen bekannt ist, wann jemand hüpft und wann nicht. Zuletzt am 2026-10-08 gemacht (Ergebnisse unten).

## Wann

- Wenn sich das Springen im Spiel falsch anfühlt (zu spät, verpasst, Fehlsprünge).
- An einem neuen Ort oder mit einem anderen Kinect-Aufbau.
- Nach Änderungen an der Personenerkennung (`web/lib/persons*`).

## 1. Aufnehmen (mit der Person vor der Kinect)

Voraussetzungen:
- Der echte Hub läuft auf 8090.
- Das Spiel und das Ausgabefenster sind geschlossen, damit die Kinect 30 Bilder pro Sekunde liefert.
- Die Person steht 2–3 m vor der Kamera, in der Mitte.

Vorher die Bewegungen ansagen und auf „los“ warten. Dann startet Claude (oder du im Terminal, aus dem Hauptordner `kinect`) das Skript:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File web\scenes\pixel-jump-run\calibrate\record-session.ps1 -Name hops-2026-10-09 -Plan hops
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File web\scenes\pixel-jump-run\calibrate\record-session.ps1 -Name nohops-2026-10-09 -Plan moves
```

Ablauf jeder Aufnahme:
1. Count-in mit 12 Piepsern, die letzten drei höher.
2. Ein langer hoher Ton: Die Aufnahme läuft.
3. Eine Stimme (Hedda, deutsch) sagt jede Bewegung an. Kurz danach markiert ein kurzer Piep den Moment.
4. Am Ende drei fallende Töne und „Fertig“.

| Plan | Dauer | Bewegungen |
|---|---|---|
| `hops` | 65 s | 5× klein (Füße gerade so vom Boden), 5× normal, 4× hoch (mit Armschwung), dann ein paar Sekunden mehrmals hintereinander |
| `moves` | 72 s | alles außer Hüpfen: Kniebeuge, Ducken, Zehenspitzen, Arme hoch, Knie wippen, Schritt links/rechts, Vorbeugen, in die Hocke (unten bleiben), schnell aufstehen, Ducken, Arme hoch und runter, schnelle Kniebeuge, ein paar Schritte gehen |

Ergebnis:
- Das Skript schreibt `recordings/<Name>.k2rec` und `recordings/<Name>.cues.csv` in den Hauptordner. Die CSV enthält die Zeit jedes Pieps ab Aufnahmebeginn.
- Am Ende nennt es die Zahl der Bilder (z. B. „1951 frames“), die braucht die Auswertung.
- Aufnahmen zeigen den Raum und die Person: nicht committen und nicht hochladen, auch nicht löschen.
- Neue Aufnahmen bitte in `recordings/README.md` eintragen.

**Gut zu wissen:** Man hüpft oft schon auf das gesprochene Wort, nicht erst auf den Piep. Die Auswertung sucht deshalb ±1,6 s um jede Ansage.

## 2. Durch die Szene abspielen

Ohne Person, aus `web/`, mit laufendem Dev-Server dieses Worktrees. Einen Replay-Hub auf einem freien Port starten (im Hintergrund):

```bash
"$MAIN/kinect-hub/target/release/kinect-hub.exe" --source replay "$MAIN/recordings/hops-2026-10-09.k2rec" --bind 127.0.0.1:8092
```

Dann die Szene darauf laufen lassen, mindestens zwei Durchläufe der Aufnahme:

```bash
node scenes/pixel-jump-run/calibrate/probe.mjs --hub 8092 --seconds 150 --log --nospawn --params '{"roundSecs":600}' --out .cache/shots/hops
```

- Die Szene läuft live wie im Spiel und loggt pro Tracking-Ergebnis ihre Signale und ob sie einen Sprung ausgelöst hat.
- `--nospawn` schaltet die Hindernisse ab.
- Danach dasselbe mit der zweiten Aufnahme (Hub stoppen, mit `nohops-…` neu starten) und `--out .cache/shots/nohops`.
- Den Replay-Hub am Ende wieder stoppen.

Achtung GPU-Last:
- Läuft nebenbei eine andere Szene oder die Live-Wand, wird das Posenmodell langsam (400 statt 130 ms). Dann wird das Skelett ungenau.
- Die Werte in `probe.mjs` (`poseMs`) mitnotieren.

## 3. Auswerten

```bash
python scenes/pixel-jump-run/calibrate/jumpcal.py --hops .cache/shots/hops-log.json "$MAIN/recordings/hops-2026-10-09.cues.csv" 1951 --nohops .cache/shots/nohops-log.json "$MAIN/recordings/nohops-2026-10-09.cues.csv" 2160 --sim
```

Die erste Zeile („Szene“) zählt die Sprünge, die die Szene wirklich ausgelöst hat:
- **Hüpfer:** wie viele erkannt wurden, je Art.
- **Verzögerung:** wie lange nach dem Absprung, gemessen am steilsten Anstieg des Beckens.
- **weitere:** zusätzliche Auslöser. In der Hüpf-Aufnahme sind das vor allem die Hüpfer am Stück, also Luftsprünge.
- **Fehlsprünge** in der zweiten Aufnahme, je Bewegung, und die bei Schein-Personen.

Mit `--sim` laufen die geloggten Signale zusätzlich durch `detect()` in `jumpcal.py`, mit ein paar Varianten der Werte:
- `detect()` ist dieselbe Regel wie in `people.js`. Wer die Regel ändert, ändert beide.
- So lässt sich offline ausprobieren, bevor man etwas in `main.js` (Standardwerte im Ordner „Springen“) oder `people.js` übernimmt.
- Danach Schritt 2 wiederholen, um zu prüfen, ob die Szene dasselbe tut.

## Die Erkennung (Stand 2026-10-08)

Alles kommt aus der Maske der Person, also jedes Bild exakt, ungeglättet und unabhängig vom Posenmodell:

1. **Absprung:** Die Medianhöhe der Maske steigt nahe der Standhöhe so schnell, dass der Körper abheben würde (Höhe + v²/2g mehr als 5 cm über dem Stand, v > 0,45 m/s). Der Mittelwert der Maske steigt mit.
2. **Bestätigung innerhalb von 0,35 s:**
   - Die Füße (unterste 3 % der Maske) heben 2 cm ab.
   - Der Körper ist 6 cm über dem Stand.
   - Das rohe Becken des Skeletts ist mindestens 3 cm über seinem Stand. Dieses Veto fängt hochgerissene Arme ab, die nur die Maske anheben.
3. **Standhöhe:**
   - Sie ist das 80. Perzentil der ruhigen Momente (|v| < 0,25 m/s) der letzten 8 s, bei den Füßen der Median der letzten 4 s.
   - Die erste Version nahm den höchsten Median und ließ ihn nur 3 mm/s sinken. Dabei blieb die Standhöhe nach ein paar Hüpfern bis zu 30 cm zu hoch hängen, und eine Minute lang zählte kein kleiner Hüpfer mehr.
4. **Lauf-Filter:** Wer sich in den letzten 0,3 s schneller als 0,55 m/s über den Boden bewegt hat, springt nicht.

## Ergebnisse 2026-10-08

Aufnahmen `hops2-2026-10-08` (1951 Bilder) und `nohops-2026-10-08` (2160 Bilder) bei der Nutzerin zu Hause. `hops-2026-10-08` ist ein Fehlversuch (Ablauf nicht verstanden).

Je Aufnahme gab es drei Mess-Läufe mit unterschiedlicher GPU-Last, je zwei bis drei Durchläufe. Gezählt ist ein Hüpfer, wenn innerhalb ±1,6 s um seine Ansage ein Sprung ausgelöst wurde. Die Verzögerung ist auf den steilsten Anstieg der Maske bezogen. Die Fehlsprünge gelten pro 72 s der zweiten Aufnahme, die nur aus kniffligen Nicht-Hüpfern besteht.

| Regel | Hüpfer | kleine Hüpfer | Verzögerung (Median) | Fehlsprünge |
|---|---|---|---|---|
| zweite Version: geglättetes Becken, Standhöhe blieb hängen (die Szene im ersten Lauf) | 22/34 | 1/10 | +0,12 s | 1,7 |
| **jetzt: Maske + Füße + Becken-Veto**, Lauf 1 (Posenmodell 131 ms) | 33/34 | 10/10 | +0,10 s | 1,3 |
| jetzt, Lauf 2 (420 ms, GPU unter Last) | 23/23 | 5/5 | +0,10 s | 2,5 |
| jetzt, Lauf 3, **von der Szene selbst ausgelöst** (246 ms) | 25/26 | 5/6 | +0,13 s | 1,0 |

- Zusammen 81 von 83 Hüpfern.
- In Lauf 3 stimmen Szene und Simulation (`--sim`) überein, die Simulation bildet die Szene also richtig nach.
- Verpasst wurden zwei sehr kleine Hüpfer: Die Füße hoben nur 1,8 cm ab.
- Die Fehlsprünge kommen von hochgerissenen Armen, von schnellem Aufstehen aus tiefer Hocke und unter GPU-Last vom Hochkommen nach dem Ducken.
- Ohne das Becken-Veto wären es 1,7–4,5 Fehlsprünge.

Gelernt:
- Erst die Auswertung prüfen, dann die Regel: Zweimal sah die Erkennung schlecht aus, weil die Auswertung falsch zählte.
  - Einmal hatte sie nur *nach* dem Piep gesucht.
  - Einmal hatte sie den Absprung am wackligen Skelett bestimmt.
- Die Simulation muss wie die Szene durchgehend laufen, ohne Neustart je Durchlauf. Sonst bleibt ein Hängenbleiben der Standhöhe unsichtbar.
