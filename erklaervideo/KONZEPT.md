# Erklärvideo Kinect-Wand: Konzept (Entwurf 1)

Ein Video von etwa 1:30 min, das erklärt, wie die Installation funktioniert. Es läuft auf einem eigenen Rechner neben der Wand.

- **Format:** MP4, 1920 × 1080, 60 fps, ohne Ton. Es endet in Schwarz und läuft deshalb nahtlos in Schleife (VLC oder Browser). Kinect und Hub braucht es nicht.
- **Technik:** Motion Canvas in `erklaervideo/` mit eigener `package.json`; `web/` bleibt unberührt. Alles ist gezeichnet, es gibt kein Fremdmaterial.
- **Daten:** IR, Tiefe, Punktwolke, Optical Flow und Masken werden aus *einer* simulierten 3D-Szene (Raum plus animierte Personen) berechnet. Dadurch passen alle Bilder exakt zusammen.

## Look

- Dunkler, leicht blauer Raum. Der 3D-Raum ist eine stilisierte Linienzeichnung aus dünnen, leuchtenden Linien.
- Szenen 1–6 sind eine durchgehende Kamerafahrt ohne harte Schnitte.
- Die Farben kommen aus dem echten System:
  - Personen in ihren Tracking-Farben: Cyan `#29e6ff`, Magenta `#ff3fd0`, Gold `#ffc23a`.
  - Tiefe als Verlauf: nah = warm, fern = kalt.
  - Infrarot in Graustufen.
- **Roter Faden:** Die Personen bleiben neutral grau, bis die KI sie erkennt (Szene 5). Erst dann bekommen sie ihre Farbe und ihre ID.
- **Schrift:** Inter, technische Zahlen in Mono.
- **Text pro Szene:** eine große, einfache Zeile für alle, darunter eine kleine Technik-Zeile.
- **Kapitel-Leiste unten:** Aufbau · Licht · 3D · Bewegung · KI · Masken · Szene · Wand.

## Szenen

### 1 · Aufbau (0:00–0:11)
- **Bild:** leerer Raum, Kamera schräg von vorne oben. Sie fährt langsam heran.
- **Ablauf:**
  1. Das Bodenraster zeichnet sich.
  2. Zwei Truss-Türme wachsen hoch, die Traverse schiebt sich darüber.
  3. 48 LED-Kabinette (12 × 4 à 0,5 m) hängen sich Reihe für Reihe ein und schwingen kurz nach.
  4. Die Wand zeigt kurz das Testbild der Steuerzentrale.
  5. Die Kinect setzt mittig vor der Wand auf ihr Stativ (kleiner Ping).
- **Text:** „So sieht dich die Wand.“
- **Maßlinien:** 6 × 2 m · 1008 × 336 LEDs · Kinect v2, mittig, 0,85 m hoch

### 2 · Sichtfeld, Infrarot, Tiefe (0:11–0:23)
- **Bild:** Die Kamera schwenkt seitlich hinter die Kinect.
- **Ablauf:**
  1. Das Sichtfeld wächst als Pyramide aus der Linse (70° × 60°, 0,5–4,5 m), und die Spielfläche leuchtet auf dem Boden auf.
  2. Zwei Personen laufen hinein, noch grau.
  3. Infrarot-Pulse wandern von der Kinect zu den Personen und zurück.
  4. Rechts fahren zwei Bildschirme herein: das Infrarotbild und das Tiefenbild mit Farbskala. Beide zeigen live dieselbe Szene.
- **Text:** „Die Kinect leuchtet den Raum mit unsichtbarem Infrarot aus und misst für jedes Pixel den Abstand.“
- **Technik-Zeile:** Time-of-Flight · 512 × 424 Pixel · 30 Bilder/s

### 3 · Punktwolke (0:23–0:34)
- **Ablauf:**
  1. Ein Pixel wird hervorgehoben: Sein Strahl aus der Linse und der gemessene Abstand ergeben einen Punkt im Raum.
  2. Alle Pixel lösen sich aus dem Tiefenbild und fliegen an ihre 3D-Position im Sichtfeld.
  3. Die Kamera kreist etwa 90° zur Seite. Die Personen haben Tiefe, aber man sieht nur ihre Vorderseite, weil die Kinect nicht um Ecken schaut. Das zeigt, dass es echte 3D-Daten sind.
  4. Die Kamera kehrt in die Schrägansicht zurück.
- **Text:** „Aus jedem Pixel wird ein Punkt im Raum.“
- **Technik-Zeile:** bis zu 217.088 Punkte pro Bild, in Millimetern

### 4 · Optical Flow (0:34–0:40, kurz)
- **Ablauf:** Eine Person winkt, die andere macht einen Schritt. Auf den bewegten Punkten erscheinen kurze Bewegungsspuren. Ihre Farbe zeigt die Richtung, ein kleines Farbrad dient als Legende.
- **Text:** „Optical Flow: Wohin bewegt sich jedes Pixel von Bild zu Bild?“
- **Technik-Zeile:** Er hält die Skelette zwischen zwei KI-Bildern flüssig und liefert später die Strömung fürs Fluid.

### 5 · KI-Tracking (0:40–0:52)
- **Bild:** Das Infrarotbild steht groß in der Mitte, in einem Rahmen „KI-Modell“.
- **Ablauf:**
  1. Eine Scan-Linie läuft über das Bild.
  2. Um jede Person rastet eine Box ein („Person 94 %“).
  3. 17 Punkte ploppen auf: Nase, Augen, Ohren, Schultern, Ellbogen, Handgelenke, Hüften, Knie, Knöchel.
  4. Die Knochen verbinden sich zum Skelett. Jede Person bekommt ihre Farbe und ihre ID.
  5. Das Bild kippt zurück in die 3D-Punktwolke. Die Skelette sitzen jetzt räumlich in den Personen.
- **Text:** „Ein KI-Modell findet die Menschen: erst als Box, dann als Skelett.“
- **Technik-Zeile:** YOLO11-Pose im kinect-hub, bis 15×/s auf der GPU · Gelenke in Metern aus der Tiefe der eigenen Pixel · dazwischen interpoliert auf 30 fps

### 6 · Silhouetten und Masken (0:52–1:01)
- **Ablauf:**
  1. Von den Skeletten aus wächst die Maske über den Körper, bis die Tiefe springt. Jedes Pixel gehört jetzt einer Person, in ihrer Farbe.
  2. Der gelernte Hintergrund (Boden, Wände, Möbel, Rauschen) wird grau markiert.
  3. In der 3D-Ansicht fällt er nach unten weg und löst sich auf. Übrig bleiben nur die farbigen Menschen mit ihren Skeletten.
- **Text:** „Nur die Menschen bleiben übrig, der Raum fällt raus.“
- **Technik-Zeile:** eine Maske pro Person in jedem Bild (30 fps), bis zu Fingern und Haaren

### 7 · Daten an die Szene (1:01–1:13)
- **Teil A, im Hintergrund:**
  - Die Menschen schrumpfen zu einem Datenpaket.
  - Die Pipeline erscheint als Kette: Kinect → kinect-hub (Rust: Tiefe, KI, Tracking) → WebSocket → Szene im Browser (WebGPU) → Ausgabe → LED-Wand.
  - Eine Datenkarte (`persons`: ID, Farbe, Gelenke in m …) fliegt die Kette entlang. Dazu: 30× pro Sekunde, ≈ 7 ms.
- **Teil B, in der Szene:**
  - Die Kette öffnet sich zur LED-Wand in frontaler Ansicht, und die Skelette blenden dort ein.
  - Drei kurze Hinweise:
    - **gespiegelt:** wie ein Spiegel
    - **echte Größe:** 1:1
    - **Laufweg gedehnt:** Eine kleine Draufsicht zeigt, dass die Kinect in 3 m Abstand etwa 4 m Breite sieht, die Wand aber 6 m breit ist. Die Position wird gestreckt, der Körper nicht.
  - Optional ein kleiner Code-Schnipsel (`ctx.persons`, `ctx.wall.joint(p, 'rightHand')`).
  - Am Ende beginnt das Fluid aus den Skeletten zu fließen, noch mit Debug-Overlay.
- **Text:** „Die Daten gehen live an die Szene auf der Wand.“

### 8 · Interaktion: Fluid (1:13–1:25)
- **Bild:** Kamera auf Augenhöhe hinter dem Publikum, die Wand frontal. Das Debug-Overlay blendet aus.
- **Ablauf:**
  - Drei Personen bewegen sich vor der Wand, als dunkle Silhouetten mit Lichtkante in ihrer Farbe. Eine läuft quer, eine winkt, eine wirbelt mit den Armen.
  - Auf der Wand läuft die Fluid-Simulation. Die Farbe entsteht an den bewegten Körpern, gespiegelt an ihrer Stelle, und ihre Bewegung schiebt sie weg.
  - Unten rechts zeigt ein kleines Bild-im-Bild live die Sicht der Kinect (Punktwolke und Skelette).
  - Zum Schluss treten alle zurück, und das Fluid beruhigt sich.
- **Text:** „Bewegung schiebt die Strömung.“

### 9 · Abspann (1:25–1:32)
- **Ablauf:** Blende zu Schwarz, dann teilt eine Linie das Bild.
  - **Links, Modern Events:** Verlauf Blau → Violett → Magenta, das Logo als LED-Punktraster wie in der Werbeszene. Darunter „LED-Wand“ · modern-events.de
  - **Rechts, Leonie Ziechmann:** heller Betula-Look mit grünem Akzent. Darunter „Creative & Implementierung“ · Softwareentwicklung und IT Solutions · github.com/leonieziechmann
- **Schluss:** Blende zu Schwarz, dann beginnt die Schleife von vorn.

## Offene Fragen

1. **Personen:** simulierte, stilisierte Figuren (Vorschlag) oder echte Daten aus einer Aufnahme in `recordings/`? Echte Daten sind authentischer, aber man erkennt die Leute, dann braucht es ihr Einverständnis. Außerdem müssten die Frames auf dem Windows-Rechner exportiert werden.
2. **Bildschirm:** 16:9 (Monitor, TV, Beamer)? Oder soll es auch auf der LED-Wand selbst laufen (3:1)?
3. **Zielgruppe:** Passt die Mischung aus einfacher Zeile für Gäste und kleiner Technik-Zeile?
4. **Ton:** ohne Ton (Vorschlag) oder mit Musik?
5. **Logos:** Gibt es das Modern-Events-Logo und dein Logo als SVG/PNG? Sonst baue ich beide nach wie in den Werbeszenen. Welcher Link soll bei dir stehen: GitHub, betula.app oder E-Mail?
