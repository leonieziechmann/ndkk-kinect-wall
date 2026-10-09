# Erklärvideo Kinect-Wand: Konzept (Stand: Entwurf 4)

Ein Video von etwa 1:30 min, das Gästen ohne Technikwissen zeigt, wie die Installation funktioniert. Es läuft auf einem Notebook neben der Wand.

- **Format:** 16:9, MP4, 1920 × 1080, ohne Ton. Fertig mit 60 fps, die Vorschau mit 30 fps. Es endet in Schwarz und läuft so nahtlos in Schleife.
- **Erklären über Bewegung:** Es passiert immer etwas. Pro Szene steht höchstens ein kurzer, einfacher Satz im Bild, dazu ein paar Beschriftungen und für Technik-Interessierte zwei Zahlen (30 Bilder/s, Latenz ≈ 10 ms).
- **Personen:** drei simulierte Figuren im Low-Poly-Stil (facettierte 3D-Körper mit Kleidung und Haaren, ohne Gesicht). Ohne Geschlechterklischees: Er trägt ein pinkes T-Shirt und wird im Tracking magenta, sie trägt ein türkises Boxy-Shirt, eine weite helle High-Waist-Hose und einen Pferdeschwanz und wird cyan, die dritte Person einen ockerfarbenen Pullover. Die Hauttöne sind verschieden. Echte Aufnahmen sind nicht nötig. Als Alternative gibt es denselben Körper weich schattiert („Natürlich“).
- **Abspann** (Szene 9): eine geteilte Seite. Links Modern Events (hat die LED-Wand gestellt, Verleih und Betreuung) mit dem LED-Punkt-Logo aus ihrer Wand-Szene, rechts Leonie Ziechmann (Konzept, Umsetzung, Erklärung) auf der Kontaktkarte im Betula-Look mit E-Mail und Telefon. Danach Schwarz.
- **Schluss** (Szene 10): der ganze Bildschirm wird eine Regenbogenflagge aus LED-Punkten (wie das Modern-Events-Logo), die leicht im Wind weht. Darauf leuchtet in weißen Punkten „COTTBUS IST BUNT“, dann wird COTTBUS Spalte für Spalte zu DIE ZUKUNFT umgeschrieben: „DIE ZUKUNFT IST BUNT“. Danach Schwarz, das Video läuft in Schleife.
- **Keine heiklen Gesten:** Arme gehen nur nach oben oder zur Seite, Ellbogen gebeugt, nie gestreckt nach vorne. `npm run check-arms` prüft jedes Bild.

## Look

- **Raum:** dunkel, als Linienzeichnung. Die Truss ist aus schattierten Rohren gebaut, mit Eckwürfeln und Fußplatten. Die LED-Wand hängt an einer Flugtraverse, die an violetten Rundschlingen mit Schäkeln an der Truss hängt.
- **Testbild:** die 24 Panels (12 × 2, je 0,5 × 1 m) mit dem Raster-Testbild der Steuerzentrale. Jedes Panel hat eine Farbe aus einem Verlauf über die ganze Wand und eine große ID, dazu Kreis, Mittelkreuz, Panelgrenzen, farbige Ecken und Meterskala.
- **Kinect-Daten:** Punktwolke, Bewegung, Skelette und Masken sieht man grob aus Richtung der Kinect, mit kleinen Schwenks.
- **Farben wie im echten System:** Personen in ihren Tracking-Farben (Cyan, Magenta, Gold), Tiefe nah = warm, fern = kalt.
- **Kapitel:** Die Schnitte zwischen den Szenen sind unsichtbar. Unten zeigt eine Fortschrittsleiste ohne Text die 8 Kapitel.

## Szenen

| # | Zeit | Szene | Satz im Bild |
|---|---|---|---|
| 1 | 0:00 | Aufbau | Titel „So funktioniert die Kinect-Wand“, dann Beschriftungen |
| 2 | 0:11 | Sichtfeld, Infrarot, Abstand | „Die Kinect misst mit Infrarot-Licht, wie weit alles entfernt ist.“ |
| 3 | 0:20 | Punktwolke | „Aus jedem Bildpunkt wird ein Punkt im Raum.“ |
| 4 | 0:30 | Bewegung (Optical Flow) | „Sie sieht auch, wie sich alles bewegt.“ |
| 5 | 0:36 | KI-Tracking | „Eine KI erkennt die Menschen und ihr Skelett.“ |
| 6 | 0:48 | Masken | „Nur die Menschen bleiben übrig.“ |
| 7 | 0:56 | Der Weg der Daten | „30-mal pro Sekunde läuft jedes Bild durch diese Schritte.“ / „Daraus entsteht das Bild auf der Wand.“ |
| 8 | 1:08 | Interaktion | „Deine Bewegung malt auf der Wand.“ |
| 9 | 1:20 | Abspann | Modern Events: „LED-Wand · Verleih und Betreuung · modern-events.de“ / Leonie Ziechmann: „Konzept · Umsetzung · Erklärung“, Anfragen per E-Mail und Telefon |
| 10 | 1:30 | Bunt | „COTTBUS IST BUNT“, dann „DIE ZUKUNFT IST BUNT“ auf einer Regenbogenflagge aus LED-Punkten |

**1 · Aufbau (11 s)**
- Das Bodenraster zeichnet sich, die Truss-Türme wachsen hoch, die Traverse zieht sich darüber.
- Die Flugtraverse fällt an ihren Schlingen herab. Dann hängen sich die Panels Spalte für Spalte ein und leuchten sofort mit ihrem Stück Testbild auf.
- Die Kinect setzt mittig vor der Wand auf ein Foto-Stativ.
- Beschriftungen: LED-Wand, Truss, Kinect, 6 m, 2 m.

**2 · Sichtfeld, Infrarot, Abstand (9,5 s)**
- Die Kamera fährt zur Seite. Das Sichtfeld wächst aus der Kinect, zwei Personen laufen hinein, und die beiden Bilder fahren leer herein.
- Der erste Infrarot-Puls läuft los. Im Takt füllen sich beide Bilder von nah nach fern, mit roter Front: Was nah ist, kommt zuerst zurück.
- Danach laufen die Bilder live weiter, die Personen kommen an, eine winkt.

**3 · Punktwolke (9,5 s)**
- Ein Bildpunkt auf einer Brust wird markiert. Eine Linie führt zur Kinect, ein Strahl in den Raum, und ein Punkt erscheint mit seiner Entfernung.
- Die Kamera schwenkt in die Richtung der Kinect.
- Dann fliegt das Tiefenbild in den Raum, von hinten nach vorne: zuerst die Rückwand, dann Möbel und Personen, zuletzt der Boden vor der Kamera. Das Bild leert sich in derselben Reihenfolge.
- Ein langsamer Schwenk zeigt die Tiefe.

**4 · Bewegung (6 s)**
- Was sich bewegt, leuchtet hell und zieht seine Bahn aus den letzten Bildern hinter sich her, etwa den Bogen eines winkenden Arms. Der Rest wird dunkel.

**5 · KI-Tracking (11,5 s)**
- Das Infrarotbild steht groß in der Mitte. Eine Scan-Linie läuft darüber, dann erscheinen Boxen („Mensch 93 %“), 17 Punkte (Kopf, Hand, Knie beschriftet) und das Skelett. Die Personen bekommen ihre Farbe.
- Die Skelette heben sich in 3D in die graue Punktwolke.

**6 · Masken (8,5 s)**
- Von den Skeletten aus wächst die Farbe über die Körper.
- Der Raum wird grau, fällt nach unten weg und löst sich auf. Übrig bleiben nur die Menschen.

**7 · Der Weg der Daten (11,5 s)**
- Die Kette erscheint, Datenpunkte strömen hindurch: Kinect → Vorberechnung → KI-Erkennung → Tracking → Visualisierung → LED-Wand.
- Eine Klammer von der Kinect bis zur Visualisierung zeigt „Latenz ≈ 10 ms (live)“. Das ist der Live-Modus ab fertigem Tiefenbild, laut `web/PERSONS.md`.
- Die Karte „Daten nach dem Tracking“ zeigt live, wie hoch und wie weit weg die Hände sind.
- „Visualisierung“ öffnet sich zur Wand mit den Skeletten, mit zwei Hinweisen: „wie ein Spiegel“ und „Laufweg × 1,4“ (in einer Draufsicht).
- Dann beginnt das Fluid.

**8 · Interaktion (12 s)**
- Von hinten über das Publikum: Drei Silhouetten bewegen sich vor der Wand, und das Fluid folgt ihnen.
- Ein Bild-im-Bild zeigt die Sicht der Kinect.
- Zum Schluss Blende zu Schwarz.

**9 · Abspann (später)**
- Split-Screen: links Modern Events (LED-Wand), rechts Leonie Ziechmann (Creative und Implementierung).
