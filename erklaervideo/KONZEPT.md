# Erklärvideo Kinect-Wand: Konzept (Stand: Entwurf 3)

Ein Video von etwa 1:30 min, das Gästen ohne Technikwissen zeigt, wie die Installation funktioniert. Es läuft auf einem Notebook neben der Wand.

- **Format:** 16:9, MP4, 1920 × 1080, ohne Ton. Fertig mit 60 fps, die Vorschau mit 30 fps. Es endet in Schwarz und läuft so nahtlos in Schleife.
- **Text:** möglichst wenig. Pro Szene steht ein kurzer, einfacher Satz unten links, dazu Beschriftungen im Bild. Erklären soll die Animation.
- **Personen:** vorerst einfache simulierte Figuren. Die echten Aufnahmen sind in [AUFNAHMEN.md](AUFNAHMEN.md) beschrieben.
- **Branding** (Modern Events und Leonie Ziechmann) kommt später als Szene 9.

## Look

- Dunkler Raum, der 3D-Raum als Linienzeichnung. Szenen 1–6 sind eine durchgehende Kamerafahrt, auch die Schnitte zwischen den Szenen sind unsichtbar.
- Die Kinect-Daten (Punktwolke, Bewegung, Skelette, Masken) sieht man grob aus der Richtung der Kinect: von etwas hinter und über ihr, mit kleinen Schwenks, damit man die Tiefe erkennt.
- Personen in den Tracking-Farben des echten Systems: Cyan, Magenta, Gold. Bis die KI sie erkennt, sind sie grau.
- Tiefe als Farbverlauf (nah = warm, fern = kalt), Infrarot in Graustufen.
- Unten eine schmale Fortschrittsleiste mit 8 Kapiteln (ohne Text).

## Szenen

| # | Zeit | Szene | Satz im Bild |
|---|---|---|---|
| 1 | 0:00 | Aufbau | Titel „So funktioniert die Kinect-Wand“, dann nur Beschriftungen |
| 2 | 0:11 | Sichtfeld, Infrarot, Abstand | „Die Kinect misst mit Infrarot-Licht, wie weit alles entfernt ist.“ |
| 3 | 0:23 | Punktwolke | „Aus jedem Bildpunkt wird ein Punkt im Raum.“ |
| 4 | 0:34 | Optical Flow | „Sie sieht auch, wie sich alles bewegt.“ |
| 5 | 0:40 | KI-Tracking | „Eine KI erkennt die Menschen und ihr Skelett.“ |
| 6 | 0:52 | Masken | „Nur die Menschen bleiben übrig.“ |
| 7 | 1:01 | Der Weg der Daten | „30-mal pro Sekunde läuft jedes Bild durch diese Schritte.“ / „Daraus entsteht das Bild auf der Wand.“ |
| 8 | 1:13 | Interaktion | „Deine Bewegung malt auf der Wand.“ |
| 9 | 1:25 | Abspann | später |

**1 · Aufbau**
- Das Bodenraster zeichnet sich. Die Truss-Türme wachsen hoch, und die Traverse zieht sich darüber.
- 24 LED-Panels (12 × 2, je 0,5 m breit und 1 m hoch) hängen sich Spalte für Spalte ein. Jedes bringt sein Stück vom Raster-Testbild der Steuerzentrale mit: Panel-Nummern, Kreis, Mittelkreuz, farbige Ecken, „1008 × 336“.
- Die Kinect setzt mittig vor der Wand auf ein Foto-Stativ, dessen Beine oben zusammenlaufen.
- Beschriftungen: LED-Wand, Truss, Kinect, 6 m, 2 m.

**2 · Sichtfeld, Infrarot, Abstand**
- Die Kamera fährt zur Seite. Das Sichtfeld wächst als Pyramide aus der Kinect und wird am Boden abgeschnitten; die Spielfläche leuchtet.
- Zwei graue Figuren laufen hinein. Rote Infrarot-Pulse laufen durch das Sichtfeld und lassen die Figuren kurz aufleuchten.
- Dann fahren zwei Bilder herein: „Infrarot“ und „Abstand“ mit der Skala nah–fern.

**3 · Punktwolke**
- Ein Bildpunkt auf der Brust einer Figur wird markiert. Eine Linie führt zur Kinect, ein Strahl in den Raum, und ein Punkt erscheint mit seiner Entfernung („2,05 m“).
- Dann fliegen alle Bildpunkte aus dem Bild an ihre Stelle im Raum.
- Die Kamera schwenkt grob in die Richtung der Kinect und bewegt sich dann langsam zur Seite. Man sieht die Körper und die „Schatten“ auf der Rückwand, wo die Kinect nicht hinsieht: echte 3D-Daten.

**4 · Optical Flow**
- Aus Kinect-Richtung, etwas näher: Was sich bewegt, leuchtet in der Farbe seiner Bewegungsrichtung und zieht kurze Spuren. Der Rest wird dunkel.

**5 · KI-Tracking**
- Das Infrarotbild steht groß in der Mitte. Eine Scan-Linie läuft darüber, dann rasten Boxen ein („Mensch 93 %“).
- 17 Punkte ploppen auf; Kopf, Hand und Knie sind beschriftet. Die Knochen verbinden sich, und die Personen bekommen ihre Farbe.
- Die Skelette heben sich in 3D in die (graue) Punktwolke.

**6 · Masken**
- Links 3D, rechts das Maskenbild. Von den Skeletten aus wächst die Farbe über die Körper.
- Der Raum wird grau markiert, fällt nach unten weg und löst sich auf. Übrig bleiben nur die Menschen.

**7 · Der Weg der Daten**
- Die Schritte erscheinen mit eigenem Symbol, und Datenpunkte strömen hindurch: Kinect → Vorberechnung → KI-Erkennung → Tracking → Visualisierung → LED-Wand.
- Eine Karte „Daten nach dem Tracking“ zeigt live, wie hoch und wie weit weg die Hände gerade sind.
- „Visualisierung“ öffnet sich zur LED-Wand mit den Skeletten, dazu zwei Hinweise:
  - **„wie ein Spiegel“:** Die rechte Hand ist rechts.
  - **Laufweg × 1,4:** Eine Draufsicht zeigt, wie die Position gestreckt wird, damit man die ganze Wand erreicht.
- Dann beginnt das Fluid zu fließen.

**8 · Interaktion**
- Von hinten über das Publikum: Drei Silhouetten mit farbiger Lichtkante bewegen sich vor der Wand, das Fluid folgt ihrer Bewegung.
- Unten rechts zeigt ein Bild-im-Bild die Sicht der Kinect.
- Zum Schluss Blende zu Schwarz.

**9 · Abspann (später)**
- Split-Screen: links Modern Events (LED-Wand), rechts Leonie Ziechmann (Creative und Implementierung).
