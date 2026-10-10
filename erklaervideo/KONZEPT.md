# Erklärvideo Kinect-Wand: Konzept (Stand: Entwurf 5)

Ein Video von etwa 1:30 min, das Gästen ohne Technikwissen zeigt, wie die Installation funktioniert. Es läuft auf einem Notebook neben der Wand.

- **Format:** 16:9, MP4, 1920 × 1080, 30 fps, mit Ton (funktioniert auch stumm), 1:31 min, ein nahtloser Loop.
- **Anfang und Loop:** schon im ersten Bild die Nacht der kreativen Köpfe im Look von ndkk.de: das NDKK-Logo und „Die magische Videowand“, 1,6 s lang; dann wischt die Fläche nach oben weg, und der Titel „So funktioniert die Kinect-Wand“ kommt über dem Aufbau. Am Ende kommt dieselbe Fläche wie ein Vorhang von oben über die Flagge herunter und landet genau auf dem ersten Bild; Rasterpunkte und Schriftzug driften dabei ohne Sprung über die Nahtstelle weiter. Im Ton klingt der Vorhang aus, und mit dem ersten Bild kommt wieder der Akkord der NDKK. Man sieht nicht, wo das Video anfängt.
- **Erklären über Bewegung:** Es passiert immer etwas. Pro Szene stehen ein, höchstens zwei kurze, einfache Sätze im Bild, dazu ein paar Beschriftungen und für Technik-Interessierte ein paar Zahlen (30 Bilder/s, Latenz ≈ 10 ms, die Körpergröße in echt).
- **Schrift:** groß genug für das Notebook aus einem Schritt Abstand: die Sätze mit 54 px, Beschriftungen und Bildtitel 1,25-mal so groß wie im ersten Entwurf (`TEXT` in `src/lib/layout.ts`).
- **Personen:** drei simulierte Figuren im Low-Poly-Stil (facettierte 3D-Körper mit Kleidung und Haaren, ohne Gesicht). Ohne Geschlechterklischees: Er trägt ein pinkes T-Shirt und wird im Tracking magenta, sie trägt ein türkises Boxy-Shirt, eine weite helle High-Waist-Hose und einen Pferdeschwanz und wird cyan, die dritte Person einen ockerfarbenen Pullover. Die Hauttöne sind verschieden. Echte Aufnahmen sind nicht nötig. Als Alternative gibt es denselben Körper weich schattiert („Natürlich“).
- **Abspann** (Szene 9): eine geteilte Seite. Links Modern Events (hat die LED-Wand gestellt, Verleih und Betreuung) mit dem LED-Punkt-Logo aus ihrer Wand-Szene, rechts Leonie Ziechmann (Konzept, Umsetzung, Erklärung) auf der Kontaktkarte im Betula-Look mit E-Mail und Telefon. Danach Schwarz.
- **Schluss** (Szene 10): der ganze Bildschirm wird eine Regenbogenflagge aus LED-Punkten (wie das Modern-Events-Logo), die wie Satin im Wind weht: dunkle Falten, Glanz auf den Kämmen, jede LED etwas anders hell, einzelne Punkte funkeln (manche als Sterne), ab und zu läuft ein Glanz darüber. Darauf steht in großer weißer Schrift mit weichem Schatten „Cottbus ist bunt“; dann verschwimmt „Cottbus“ nach oben, „Die Zukunft“ wird von unten scharf, und die Flagge funkelt einmal auf: „Die Zukunft ist bunt“. Dann fällt die NDKK-Fläche vom Anfang wie ein Vorhang darüber, und das Video beginnt von vorn.
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
| 1 | 0:00 | Aufbau | NDKK-Logo und „Die magische Videowand“, dann der Titel „So funktioniert die Kinect-Wand“, dann Beschriftungen |
| 2 | 0:10 | Sichtfeld, Infrarot, Abstand | „Die Kinect misst mit Infrarot-Licht, wie weit alles entfernt ist.“ / „Was nah ist, kommt zuerst zurück.“ |
| 3 | 0:18 | Punktwolke | „Aus jedem Bildpunkt wird ein Punkt im Raum.“ |
| 4 | 0:27 | Bewegung (Optical Flow) | „Sie sieht auch, wie sich alles bewegt.“ |
| 5 | 0:32 | KI-Tracking | „Eine KI erkennt die Menschen und ihr Skelett.“ |
| 6 | 0:42 | Masken | „Nur die Menschen bleiben übrig.“ |
| 7 | 0:50 | Der Weg der Daten | „30-mal pro Sekunde läuft jedes Bild durch diese Schritte.“ / „Daraus entsteht das Bild auf der Wand.“ |
| 8 | 1:02 | Interaktion | „Deine Bewegung malt auf der Wand.“ / „Alle vor der Wand malen mit.“ |
| 9 | 1:13 | Abspann | Modern Events: „LED-Wand · Verleih und Betreuung · modern-events.de“ / Leonie Ziechmann: „Konzept · Umsetzung · Erklärung“, Anfragen per E-Mail und Telefon |
| 10 | 1:22 | Bunt | „Cottbus ist bunt“, dann „Die Zukunft ist bunt“ auf einer Regenbogenflagge aus LED-Punkten |

**1 · Aufbau (10 s)**
- Zuerst 1,6 s die NDKK (Pastellverlauf mit Rasterpunkten, Logo, „Die magische Videowand“), dann wischt sie nach oben weg.
- Das Bodenraster zeichnet sich, die Truss-Türme wachsen hoch, die Traverse zieht sich darüber.
- Die Flugtraverse fällt an ihren Schlingen herab. Dann hängen sich die Panels Spalte für Spalte ein und leuchten sofort mit ihrem Stück Testbild auf.
- Die Kinect setzt mittig vor der Wand auf ein Foto-Stativ.
- Beschriftungen: LED-Wand, Truss, Kinect, 6 m, 2 m.

**2 · Sichtfeld, Infrarot, Abstand (8,5 s)**
- Die Kamera fährt zur Seite. Das Sichtfeld wächst aus der Kinect, zwei Personen laufen hinein, und die beiden Bilder fahren leer herein.
- Der erste Infrarot-Puls läuft los. Im Takt füllen sich beide Bilder von nah nach fern, mit roter Front; der zweite Satz sagt es: „Was nah ist, kommt zuerst zurück.“
- Danach laufen die Bilder live weiter, die Personen kommen an, eine winkt.

**3 · Punktwolke (8,5 s)**
- Ein Bildpunkt auf einer Brust wird markiert. Eine Linie führt zur Kinect, ein Strahl in den Raum, und ein Punkt erscheint mit seiner Entfernung.
- Die Kamera schwenkt in die Richtung der Kinect.
- Dann fliegt das Tiefenbild in den Raum, von hinten nach vorne: zuerst die Rückwand, dann Möbel und Personen, zuletzt der Boden vor der Kamera. Das Bild leert sich in derselben Reihenfolge.
- Ein langsamer Schwenk zeigt die Tiefe.

**4 · Bewegung (5,5 s)**
- Was sich bewegt, leuchtet hell und zieht seine Bahn aus den letzten Bildern hinter sich her, etwa den Bogen eines winkenden Arms. Der Rest wird dunkel.

**5 · KI-Tracking (10 s)**
- Das Infrarotbild steht groß in der Mitte. Eine Scan-Linie läuft darüber, dann erscheinen Boxen („Mensch 93 %“), 17 Punkte (Kopf, Hand, Knie beschriftet) und das Skelett. Die Personen bekommen ihre Farbe.
- Die Skelette heben sich in 3D in die graue Punktwolke.

**6 · Masken (7,5 s)**
- Von den Skeletten aus wächst die Farbe über die Körper.
- Der Raum wird grau, fällt nach unten weg und löst sich auf. Übrig bleiben nur die Menschen.

**7 · Der Weg der Daten (12,5 s)**
- Die Kette erscheint, Datenpunkte strömen hindurch: Kinect → Vorberechnung → KI-Erkennung → Tracking → Visualisierung → LED-Wand.
- Eine Klammer von der Kinect bis zur Visualisierung zeigt „Latenz ≈ 10 ms (live)“. Das ist der Live-Modus ab fertigem Tiefenbild, laut `web/PERSONS.md`.
- Die Karte „Daten nach dem Tracking“ zeigt live, wie hoch und wie weit weg die Hände sind.
- „Visualisierung“ öffnet sich zur Wand mit den Skeletten, Schritt für Schritt mit drei Hinweisen: „wie ein Spiegel“, ein Maßstab vom Boden bis zum Kopf („1,65 m · echte Größe“: auf der Wand erscheint man so groß, wie man ist) und „Laufweg × 1,4“ (in einer Draufsicht: wer vor der Wand ein paar Schritte geht, kommt auf der Wand weiter).
- Dann beginnt das Fluid.

**8 · Interaktion (11 s)**
- Von hinten über das Publikum: Drei Silhouetten bewegen sich vor der Wand, und das Fluid folgt ihnen.
- Ein Bild-im-Bild zeigt die Sicht der Kinect.
- Der zweite Satz, wenn alle drei in Bewegung sind: „Alle vor der Wand malen mit.“
- Zum Schluss Blende zu Schwarz.

**9 · Abspann (8,7 s)**
- Split-Screen: links Modern Events (LED-Wand, Verleih und Betreuung) mit dem LED-Punkt-Logo, rechts Leonie Ziechmann (Konzept, Umsetzung, Erklärung) mit E-Mail und Telefon.

**10 · Bunt (9 s)**
- Die Regenbogenflagge aus LED-Punkten, „Cottbus ist bunt“ → „Die Zukunft ist bunt“, dann kommt in der letzten halben Sekunde der NDKK-Vorhang herunter und landet auf dem ersten Bild.

## Social-Fassung (Instagram)

Eine kurze Fassung als Reel: 1080 × 1920 (9:16), 58 s, 30 fps, mit Ton. Dieselben acht Szenen bis zur Wand, jede knapper: Animationen schneller, Pausen kürzer, die Leute kommen früher und machen ihre Gesten dichter hintereinander.

- **Anfang:** schon im ersten Bild die Nacht der kreativen Köpfe im Look von ndkk.de: das NDKK-Logo und „Die magische Videowand“, 1,2 s lang; dann wischt die Fläche nach oben weg und der Titel „So funktioniert die Kinect-Wand“ kommt über dem Aufbau.

- **Schluss:** statt Abspann und Flagge die Nacht der kreativen Köpfe im Look von ndkk.de: Pastellverlauf (Mint, Hellblau, Gelb) mit Rasterpunkten, das NDKK-Logo baut sich Buchstabe für Buchstabe auf (das geschwungene K zuletzt), darunter „NACHT DER KREATIVEN KÖPFE“, dann ein dunkelblauer Kasten „Station Ludwig-Leichhardt-Gymnasium“. Schreibweisen wie auf ndkk.de.

- **Hochformat:** Der Satz jeder Szene steht groß oben in der Mitte, die 3D-Ansicht darunter, die Kinect-Bilder (Infrarot, Abstand, Masken) unter der 3D-Ansicht nebeneinander. Die Datenkette läuft von oben nach unten, die Wand füllt die Breite, die Draufsicht mit dem gestreckten Laufweg steht darunter.
- **Sichere Zone:** Text nur im mittleren Band, weil Instagram oben und unten eigene Anzeigen über das Reel legt und im Feed nur die Mitte (4:5) zeigt.
- **Weggelassen:** die Karte mit den Handdaten und der Maßstab in Szene 7, das kleine Bild „Sicht der Kinect“ in Szene 8 und die zweiten Sätze in Szene 2 und 8.
- **Ton:** dieselben Klänge, an die neuen Zeiten angepasst (eigene Cues), eigene Tonspur.

## Ton

Keine Musik von außen, keine Samples: Jeder Klang wird aus Sinustönen und Rauschen berechnet (`tools/sound/`), es gibt also keine Lizenzfragen. Alles steht in D-Dur-Pentatonik, deshalb klingen Effekte und Teppich immer zusammen.

- **Teppich:** ein leiser, weicher Akkord pro Szene (D, h-Moll, G, A, …, zum Schluss e-Moll → D-Dur), er geht mit jeder Blende zu Schwarz mit aus.
- **Effekte an den Bildmomenten:** Die Szenen setzen Cues (`cue()` in `src/lib/sound.ts`), zum Beispiel: Glöckchen zum Titel, kleine Blips beim Einhängen der Panels, ein weiches Pochen im Takt der Infrarot-Pulse, Glitzern, wenn das Tiefenbild als Punktwolke in den Raum fliegt, Bestätigungs-Pieps für die KI, ein Sinken, wenn der Raum wegfällt, Datenblips durch die Kette, LEDs, die beim Logo einzeln angehen, Funkeln der Flagge, Glocken beim Wortwechsel und ein warmer D-Dur-Akkord zum Schluss.
- **Winken:** Wer winkt, ruft „Hu-hu!“: zwei weiche, ansteigende Töne wie von einer Okarina, jede Person in ihrer eigenen Tonlage. Die Hu-hus entstehen automatisch aus der Choreografie (jede Winkgeste eine, zwei dicht hintereinander eine).
- **Fluid:** fließende Harfen-Arpeggien in D-Dur, nach der D-Dur-Suite von Händels Wassermusik, mit einem Bass auf jedem Takt wie ein Continuo. Je mehr sich die Menschen bewegen, desto dichter, höher und lauter spielen sie; dazu ein paar Tropfen, wo Hände schnell sind.
- **Wisch-Budget:** Rauschen und Wischen nur bei echten Kamerafahrten, höchstens vier pro Fassung (Sichtfeld, Drehung zur Kinect, Masken, Wand); Panels, Karten und Boxen kommen ohne.
- **Pegel:** Jeder Klang wird gemessen und auf seinen Platz gebracht (`LEVEL` in `tools/sound/sfx.mjs`): Teppich unten, Texturen knapp darüber, Blips und Hu-hus deutlich, Akzente oben; die wenigen Wischer bleiben im Hintergrund. Die ganze Spur hat -17 LUFS und wenig Bass, damit sie auch aus Notebook-Lautsprechern klingt.
- **Loop:** Die Spur des langen Videos ist ringförmig gemischt: Was am Ende noch klingt (Nachhall, Ausklang), kommt am Anfang dazu, und Filter und Limiter laufen über die Nahtstelle hinweg. So gibt es dort weder Knacken noch Loch. Die Social-Fassung blendet an ihrem Ende aus wie bisher.
- **Angenehm für die Ohren:** Töne meist unter 1,5 kHz (das Ohr ist zwischen 2 und 5 kHz am empfindlichsten), weiche Einsätze, dunkles Rauschen, gedämpfter Hall; auf der ganzen Spur eine leichte Absenkung um 3 kHz und der obersten Höhen.
