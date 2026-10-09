# Aufnahmen für das Erklärvideo

Im Moment laufen im Video einfache, simulierte Figuren. Mit diesen Aufnahmen ersetzen wir sie durch echte Kinect-Daten (Infrarot, Tiefe, Punktwolke, Skelette, Masken). Szene 1 (Aufbau) und das Pipeline-Schaubild in Szene 7 bleiben gezeichnet.

## Was ich brauche

1. **Maße des echten Aufbaus**, damit der gezeichnete Raum stimmt (in Klammern steht, was das Video jetzt annimmt):
   - Unterkante der LED-Wand über dem Boden (0,6 m)
   - Truss: Höhe, wie weit die Türme neben der Wand stehen, Art (Tor aus 2 Türmen und Traverse, 3,2 m hoch, 29er Truss)
   - Kinect: Höhe der Linse (0,85 m), Abstand vor der Wand (0,25 m), ob sie genau mittig steht
   - ein Handyfoto vom Aufbau von schräg vorne
2. **Fünf Kinect-Aufnahmen** (siehe unten), zusammen etwa 1:40 min, rund 2 GB.
3. **Optional für Szene 8:** ein Handyvideo von hinten und eine Bildschirmaufnahme der Wand-Ausgabe (siehe unten).

## So wird aufgenommen

Hub normal starten (Hauptordner), dann je Aufnahme:

```bash
MAIN=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
"$MAIN/kinect-hub/target/release/kinect-hub-probe.exe" record --seconds 15 --out "$MAIN/recordings/video-reinlaufen.k2rec"
```

Die Aufnahmen bleiben in `recordings/` (git ignoriert sie) und werden nicht hochgeladen.

### Regeln für alle Aufnahmen

- **Ort:** am besten am echten Aufbau, mit Wand, Truss und dem, was im Raum steht (Bar, Tische). Möbel im Hintergrund sind erwünscht, sie zeigen später, wie der Raum herausfällt.
- **Links und rechts** sind hier immer aus Sicht der Leute gemeint, die zur Wand schauen (also wie das Publikum).
- **Bodenmarken mit Klebeband:**
  - eine Mittellinie von der Kinect aus nach vorne
  - Querstriche bei 1,5 m, 2,3 m und 3 m Abstand zur Kinect
  - Punkt **A:** 2,3 m vor der Kinect, 0,8 m links der Mitte
  - Punkt **B:** 3 m vor der Kinect, 1,2 m rechts der Mitte
  - Punkt **C:** 1,8 m vor der Kinect, 1 m rechts der Mitte
- **Kleidung:**
  - Normale, matte Kleidung ist ideal.
  - Glänzendes Schwarz (Lack, Leder, manche Sportjacken) schluckt Infrarot und gibt Löcher im Tiefenbild.
  - Warnwesten und Reflektoren blenden.
  - Unterschiedliche Silhouetten helfen: zum Beispiel eine Person mit Jacke, eine mit Rock oder Kleid, verschiedene Größen.
- **Blickrichtung:** zur Wand, also zur Kinect. Langsame, große Bewegungen sehen im Video besser aus als schnelle, kleine.
- **Am Anfang und am Ende** jeder Aufnahme 2 s ruhig stehen (Puffer zum Schneiden).
- **Ein Klatscher** in Brusthöhe am Anfang jeder Aufnahme, damit sich Aufnahmen und Handyvideo synchronisieren lassen.
- **Einverständnis:** Im Infrarotbild sind Gesichter erkennbar. Alle Aufgenommenen sollten einverstanden sein, dass sie im Video vorkommen.

### Die fünf Aufnahmen

| # | Datei | Dauer | Wer | Für Szene |
|---|---|---|---|---|
| 1 | `video-leer.k2rec` | 10 s | niemand | 2, 6 |
| 2 | `video-reinlaufen.k2rec` | 15 s | A, B | 2, 3 |
| 3 | `video-gesten.k2rec` | 35 s | A, B | 3, 4, 5, 6 |
| 4 | `video-laufweg.k2rec` | 15 s | A, B | 7 |
| 5 | `video-interaktion.k2rec` | 25 s | A, B, C | 8 |

**1 · Leerer Raum** (10 s): Niemand steht im Sichtfeld, auch nicht am Rand. Daraus kommt der Raum ohne Menschen: Wände, Boden, Möbel.

**2 · Reinlaufen** (15 s):
- 0–2 s: leer.
- ab 2 s: A kommt von links ins Bild und geht ruhig zu Punkt A.
- ab 3 s: B kommt von rechts und geht zu Punkt B.
- danach: beide stehen still und schauen zur Wand, bis die Aufnahme endet.

**3 · Gesten** (35 s): A und B stehen auf ihren Punkten. Zeiten ungefähr, Hauptsache in dieser Reihenfolge:

| Zeit | A | B | Wofür |
|---|---|---|---|
| 0–5 s | steht still | steht still | Bildpunkt wird Punkt im Raum |
| 5–9 s | – | hebt beide Arme (V), hält 2 s, senkt sie | Punktwolke von der Seite |
| 8–12 s | breitet die Arme aus (T), hält, senkt | – | Punktwolke von der Seite |
| 12–18 s | winkt groß mit der rechten Hand | ein Schritt nach links, kurz stehen, zurück | Optical Flow |
| 18–22 s | winkt langsam rechts | breitet die Arme aus | KI: Boxen und Punkte |
| 22–27 s | hebt beide Arme | streckt die linke Hand hoch | KI: Skelett in 3D |
| 27–33 s | breitet die Arme aus | winkt mit links | Masken |
| 33–35 s | steht still | steht still | Puffer |

**4 · Laufweg** (15 s): A auf Punkt A, B auf Punkt B.
- 2–6 s: A winkt mit der rechten Hand. Zeigt: Die Wand ist wie ein Spiegel.
- ab 7 s: B geht langsam (etwa 4 s) auf der 3-m-Linie quer durch das Sichtfeld, von rechts bis kurz vor den linken Rand, und bleibt dort stehen. Zeigt: Der Laufweg wird auf die ganze Wand gedehnt.

**5 · Interaktion** (25 s): Auf der Wand läuft die Szene **Fluid-Simulation**, damit sich alle natürlich bewegen.
- Start: A auf Punkt A, B auf Punkt B, C steht rechts außerhalb des Bildes.
- 0–4 s: C kommt von rechts zu Punkt C. A macht große, ruhige Armkreise vor dem Körper.
- 4–9 s: B winkt mit links. C reißt die Arme hoch und bewegt sie hin und her.
- 9–14 s: A geht langsam 1 m nach links und winkt dabei mit beiden Armen. B geht langsam zur Mitte.
- 14–20 s: alle bewegen sich frei, ruhig auch mal schneller: wischen, winken, ein Schritt hin und her.
- 20–25 s: alle stehen still, damit sich das Fluid beruhigt.

### Optional für Szene 8: echtes Bild der Wand

Szene 8 zeigt die Leute von hinten vor der leuchtenden Wand. Statt der gezeichneten Version ginge auch echtes Material, gleichzeitig mit Aufnahme 5:

- **Handyvideo:**
  - Stativ hinter dem Publikum, Linse etwa 1,6 m hoch, 7–9 m vor der Wand, genau mittig.
  - Querformat, 4K oder 1080p, 30 oder 60 fps.
  - Belichtung auf der Wand fixieren (antippen, gedrückt halten), sonst brennt die LED-Wand aus.
  - Die Leute sind nur von hinten zu sehen.
- **Bildschirmaufnahme der Ausgabe:**
  - Das Fenster `/wall/` mit OBS aufnehmen (Fensteraufnahme, 1008 × 336), gleichzeitig mit Aufnahme 5.
  - Dann zeigt die Wand im Video exakt das, was die Kinect-Daten ausgelöst haben.

## Und danach

Sobald die Aufnahmen da sind, braucht es ein kleines Export-Werkzeug auf dem Windows-Rechner (dort läuft der Hub):

1. **Abspielen:** Jede Aufnahme läuft über einen Replay-Hub (`--source replay … --bind 127.0.0.1:8091`).
2. **Exportieren:** Das Werkzeug schreibt pro Bild Tiefe, Infrarot, Personen (Boxen, Keypoints, Gelenke, IDs) und Masken nach `erklaervideo/data/<name>/`. Der Ordner wird nicht eingecheckt, weil er Menschen zeigt.
3. **Einbinden:** Das Video liest dann diese Daten statt der Simulation. Die Choreografie in `src/lib/choreo.ts` wird durch die Zeiten der Aufnahmen ersetzt.

Das Werkzeug schreibe ich, sobald klar ist, dass die Aufnahmen so passen. Es lässt sich nur dort testen, wo der Hub läuft.
