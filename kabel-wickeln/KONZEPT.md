# Kabel richtig aufwickeln: Konzept der 3D-Fassung

Die erste Fassung war 2D und zu abstrakt: Wickeln ist eine 3D-Bewegung der Hände, und was ein Kabel tut (Drall, Kringel, Acht), versteht man nur, wenn es sich wie ein echtes Kabel verhält. Die zweite Fassung ist deshalb:

- **echtes 3D** (three.js in Motion Canvas), heller Studio-Look mit weichen Schatten;
- **simulierte Kabel**: ein Cosserat-Stab (XPBD) mit Biege- und Torsionssteifigkeit, Schwerkraft, Bodenreibung, Selbstkontakt und Formgedächtnis. Hände greifen das Kabel und drehen es. Wo die Simulation allein nicht verlässlich die gewünschte Form findet, führen weiche Führungskräfte sie dorthin („Pseudo-Simulation“). Gerechnet wird vorab (`npm run bake`), im Video wird nur abgespielt;
- **Ich-Perspektive (POV)** immer dann, wenn gezeigt wird, wie man etwas macht: links die eigenen Hände, rechts die Außenansicht. Für die POV sitzt die Kamera etwas tiefer und weiter vorn, der linke Unterarm liegt etwas tiefer und weiter außen, damit Hände und Ring ganz im Bild sind. Hände und Kabel sind in beiden Ansichten dieselben;
- **Menschen** aus dem Erklärvideo (`erklaervideo/src/lib/people.ts`, `body/`), erweitert um Finger, Arbeitskleidung, Körperformen, Frisuren und Kopfbedeckungen.

Aufbau wie bisher: vom Überblick immer genauer, nach jeder Stufe eine Karte zum Aufhören, jede Stufe ein Kapitel im mp4.

Das Konzept wurde vor dem Bauen von vier Seiten geprüft (Didaktik, Fakten, Machbarkeit, Besetzung und Sprache); die Änderungen daraus sind eingearbeitet.

## Grundregeln

**Was über und unter heißt.** Beide Schlaufen laufen gleich herum und liegen auf derselben Seite des Rings. Der einzige Unterschied ist, wo das **Kabel zum Boden** die neue Schlaufe kreuzt:
- **über**: Das Kabel zum Boden liegt **obenauf** (auf deiner Seite der neuen Schlaufe).
- **unter**: Die neue Schlaufe **deckt es zu** (es läuft hinter ihr durch).

Deshalb wird nicht die ganze Schlaufe eingefärbt, sondern: das Kabel zum Boden bekommt ein weißes Leuchten, die Kreuzung einen blauen (über) oder orangen (unter) Rand. Die Kabel selbst bleiben schwarz mit gelbem Streifen.

**Kameras.** Die Außenkamera steht auf Noors Seite des Rings: rechts von ihr, leicht hinter ihr (110–130° zur Blickrichtung), 30–40 cm über den Händen, 25° nach unten. So sieht sie dieselbe Seite des Rings wie die POV, und die rechte Hand ist in beiden Bildern rechts. Die Kamera steht still, während verglichen wird, und bewegt sich nur zwischen den Takten. Die POV-Kamera ist geglättet und wackelt nicht.

**Werkzeuge**, überall gleich eingesetzt:
- weißes Leuchten: das Kabel zum Boden
- blauer/oranger Rand: die Kreuzung einer Über- oder Unter-Schlaufe
- Standbild mit Kamerafahrt um die linke Hand: „vor“ und „hinter“ werden zu links und rechts
- durchsichtige Hand (30 %) im Standbild, damit nichts verdeckt ist
- gestrichelte Geisterschlaufe: so groß soll die Schlaufe werden
- gebogene 3D-Pfeile: Rollen des Kabels, Umdrehen der Hand (180°), Drall
- Zeitlupe (0,25×) mit kleinem Hinweis „Zeitlupe“ für alles, was schneller als eine Sekunde geht, danach einmal in Echtzeit
- Einblendung (Inset) für Dinge weiter weg, etwa das Kabelende am Boden

**Text.** Das Video ist stumm. Höchstens etwa zehn Wörter pro Einblendung, in Du-Form („Nimm …“, „Dreh …“). Eine Einblendung erscheint etwa eine Sekunde vor der Bewegung und bleibt mindestens (Zeichen ÷ 12 + 1) Sekunden; während der entscheidenden Bewegung kommt kein neuer Text. Was man sehen soll, steht als kurzes Etikett im Bild, an der Stelle, wo es passiert. Einblendungen mindestens 44 px, Etiketten mindestens 32 px fett auf einer festen Unterlage, unten mindestens 10 % Abstand zum Rand (Player-Leiste). Im geteilten Bild schrumpft die Stufenleiste zu einem kleinen Chip.

**Farben.** Über: Blau #2a6cc4, unter: Orange #b85000 (weiße Schrift darauf ≥ 5:1), gedämpfter Text #5b616d. Rot nur zusammen mit ✗ oder Schraffur, nie allein. Keine Pulse schneller als 2 Hz. Kleidung in Farben, die nicht mit der Kodierung konkurrieren (Grau, Schwarz, Oliv, gedecktes Braun, Mauve, Altrosa).

**Fehler.** Wer einen Fehler zeigt, zeigt im selben Bild auch, wie es richtig geht. Alle Fehler führt Noor selbst vor („So nicht.“ – „So.“), so wie es auch im echten Unterricht ist.

## Besetzung

Eine Crew nach einer Veranstaltung beim Abbau. Alle arbeiten, niemand wird vorgeführt, niemand erklärt sich; die Vielfalt steht im Bild, nie im Text. Kein Text nennt ein Pronomen.

| Person | Aussehen | Was sie tut |
|---|---|---|
| **Noor**, Mitte 20 | mittelbraune Haut, eng anliegender Sport-Hidschab in Mauve (in den Kragen gesteckt, keine losen Enden), dunkelgraues Langarmshirt, olivfarbene Arbeitshose mit Knieschonern, Sneaker, Rigger-Handschuhe mit freien Fingerspitzen (helle Lederhandfläche, schwarzer Handrücken: so sieht man sofort, ob die Handfläche oben ist) | wickelt (Stufe 1, 3), führt Fehler vor und behebt sie (5), ihre Hände sind die POV |
| **Kofi**, um die 55 | sehr dunkle Haut, kurze graue Haare, grauer Bart, breit gebaut mit Bauch, altrosa T-Shirt, schwarze Arbeitshose | wirft das lange Kabel (1) |
| **Ilse**, um die 70 | silberner Kurzhaarschnitt, Brille, dunkles Jeans-Overshirt mit Crew-Ausweis, sportlicher Aktivrollstuhl ohne Schiebegriffe (fährt selbst) | zieht am FOH-Platz ein kurzes Kabel auseinander (1), zeigt die Physik (7) |
| **Teo**, um die 25 | südasiatisch, Locken, Brille, grauer Hoodie, Arbeitshose | zieht in Stufe 2 den immer gleich gewickelten Ring auseinander |
| **Robin**, um die 22 | helle Haut, Undercut mit fliederfarbenen Spitzen, schwarzes Crew-T-Shirt, Arbeitsjacke | zieht in Stufe 2 den Über-Unter-Ring auseinander |
| **Jonas**, um die 35 | weiß, groß und schlank, lange blonde Haare im Zopf, lackierte Nägel, olivfarbenes Fleece | Klettband in Nahaufnahme (4) |
| **Mai**, um die 30 | vietnamesisch-deutsch, mittelgroß, kräftig, Cap, dunkelgrauer Arbeitshoodie, Knieschoner, Sicherheitsschuhe, Arbeitshandschuhe | dicke Kabel (6), gibt beim Tragen das Kommando |
| **Ada**, um die 40 | Schwarze Frau, kurze Locken, breit gebaut, Crew-Kleidung | trägt mit Mai (6) |

Sprache: durchgehend „du“, kein generisches Maskulinum. Wer links wickelt, bekommt einen eigenen Hinweis mit gespiegelter POV.

## Kabel

| Kabel | Ø gezeigt | Wo | Schlaufe |
|---|---|---|---|
| XLR, 5 m, schwarz, gelber Streifen, Klettband am Stecker mit den Stiften | 7 mm (Nah, POV), 12 mm (Totale) | 1, 3, 4, 5 | Ø 22–25 cm, 6 Schlaufen |
| XLR, 15 m (Kofi) | 12 mm (Totale) | 1 | Ø 25 cm |
| kurzes Patchkabel, 1,8 m, schwarz (Stufe 2) und Ladekabel, schwarz (Ilse) | 6 mm / 4 mm | 1, 2 | Ø 9–10 cm, 6 Schlaufen |
| Starkstrom 5G2,5, 15 m, schwarz, rote CEE-400-V-Stecker (≈ 5 kg) | 16 mm | 6 | Ø 40–50 cm |
| Starkstrom 5G16, 25 m, schwarz, rote CEE-63-A-Stecker (≈ 40 kg) | 30 mm | 6 | Achten ≥ 60 cm |
| Band (oben gelb, unten dunkel), 1,2 m | 25 × 2 mm | 7 | Ø 12 cm |

Der gelbe Längsstreifen zeigt, wie sich das Kabel um die eigene Achse dreht (Drall).

## Stufen

### Titel (≈ 10 s)
Totale: Abbau nach einer Show. Noor wickelt, Kofi geht mit einem Kabel quer durchs Bild, Mai und Ada stapeln Kabel in eine Kiste, Jonas schließt ein Case, Robin trägt ein Mikrofonstativ, Ilse sitzt am FOH-Platz. Die Kamera gleitet zu einem sauberen Ring auf einem Flightcase (Klettband zu, beide Stecker außen). Titel „Kabel richtig aufwickeln“, darunter „über, unter, über … (Over-Under-Methode)“, dann die Stufenleiste.

### 1 · Überblick (≈ 70 s)
1. **Noor wickelt**, geteiltes Bild (POV | außen). Erstes Paar langsam:
   - Über-Schlaufe. Etikett an der Kreuzung: „Kabel zum Boden: obenauf“. Standbild, Kamera fährt um die linke Hand.
   - Unter-Schlaufe: die rechte Hand dreht sich sichtbar um (180°-Pfeil). Etikett: „Die Schlaufe deckt es zu“. Standbild, Kamerafahrt.
   - Die übrigen vier Schlaufen in normaler Geschwindigkeit; am Rand füllt sich eine Strichliste „ü u ü u ü u“.
   Einblendungen: „Leg Schlaufen in die linke Hand – abwechselnd über und unter.“ · „Für »unter« drehst du die rechte Hand um.“
2. Klettband zu. ✓ Der Ring liegt rund und flach.
3. **Kurzes Kabel**: Ilse am FOH-Platz öffnet das Klettband eines kurzen Rings, lässt ihn hängen, nimmt beide Enden (beide außen, hervorgehoben) und zieht die Hände auseinander; die Schlaufen öffnen sich nacheinander. Kurz auch POV. „Kurzes Kabel: Nimm beide Enden und zieh sie auseinander.“
4. **Langes Kabel**: Kofi nimmt einen langen Ring, öffnet das Klettband, hält das Ende fest und lässt zwei, drei Schlaufen locker in der offenen Hand. Er wirft den Rest von unten Richtung Mikrofonstativ. Erst in Echtzeit von hinten, dann in Zeitlupe von der Seite: Die Schlaufen lösen sich nacheinander von der Rückseite des fliegenden Rings, die Schlaufen in der Hand laufen nach. Es landet in sanften Bögen, ohne Kringel; den Rest zieht er nach. „Langes Kabel: Halt ein Ende fest und wirf den Ring Richtung Ziel.“ · ✓ „Keine Kringel, keine Knoten.“
5. Karte: „Schon mal gewickelt? Dann reicht das. Zum ersten Mal? Weiter bis Stufe 3.“

### 2 · Warum (≈ 60 s)
1. Teo und Robin stehen nebeneinander, jede Person mit einem kurzen Ring (1,8 m, 6 Schlaufen). „Zwei Ringe – von außen sehen sie gleich aus.“ Kurzer Rückblick, wie jeder gewickelt wurde: links ohne Umdrehen der Hand (alles „ü“), rechts abwechselnd. Geteiltes Bild, gleiche Kamera für beide Kabel; die Etiketten stehen an den Ringen, nie über Köpfen. Schloss-Symbole an den Händen: „Enden fest“.
2. **Erst eine Schlaufe, in Zeitlupe**: Beim Ausziehen wird aus der Schlaufe eine volle Drehung des Streifens (+360°). Dann ein Paar über/unter: +360°, −360° = 0.
3. **Beide ziehen** ihre Ringe aus, bis das Kabel fast gespannt ist (Hände ≈ 1,2 m auseinander). Links windet sich der Streifen wie eine Schraube, sechs Drehungen, das Kabel bleibt gerade. Rechts dreht er sich hin und zurück und liegt am Ende ruhig. Zähler „Drehungen im Kabel“: links 1, 2 … 6, rechts 1, 0, 1, 0, 1, 0. „Gespannt: Die Drehung steckt unsichtbar im Kabel.“
4. **Beide gehen mit den Händen 40 cm zusammen**: Links springt sofort ein Kringel heraus, dann verdrillt sich das Kabel um sich selbst wie ein altes Telefonkabel. Rechts hängt nur ein ruhiger Bogen. „Locker: Sie springt als Kringel heraus.“
5. Teo zieht wieder an: Der Kringel zieht sich zu einem Knick zu (✗, Schraffur). Teo hört auf und lässt locker – so ist es richtig. „Wieder gezogen: Knick. Das schadet den Adern.“
6. ✓ Robins Kabel hängt glatt. „Abwechselnd gewickelt: Die Drehungen heben sich auf.“

### 3 · Schritt für Schritt (≈ 130 s)
Geteiltes Bild, POV links (55 %), außen rechts (45 %). Vorweg: „Du wickelst lieber mit links? Dann alles spiegeln.“ (2 s gespiegelte POV). Das Klettband hängt schon am Stecker mit den Stiften; mit diesem Ende fängt Noor an.
1. „Nimm das Ende in die linke Hand, Handfläche oben.“ · Etikett: „Stecker bleibt außerhalb des Rings“.
2. „Rechte Hand: Daumen zeigt zur linken Hand.“ Gestrichelte Geisterschlaufe zeigt die Größe. „Gleite etwa eine Armlänge nach außen.“
3. **Über**: „Zurück, dabei mit dem Daumen nach vorn rollen.“ Pfeil um das Kabel. Etikett: „Kabel zum Boden: obenauf“. Die Schlaufe fällt rund in die Hand.
4. **Unter**: „Dreh die rechte Hand um: Daumen zeigt nach außen.“ 180°-Pfeil um den Unterarm, Handfläche (hell) zeigt nach oben. Zeitlupe.
5. „Zurück, dabei zurückdrehen.“ · Etikett: „Die Schlaufe fällt über den Handrücken“ · „Kabel zum Boden: drunter“ · „Sieht komisch aus – stimmt so.“ Zeitlupe, dann Echtzeit.
6. „Prüfen: Fällt die Schlaufe flach und rund?“ · „Hängt das Kabel zum Boden ruhig?“ ✓ Kurz zum Vergleich ✗: Wird immer gleich gewickelt, verdreht sich das hängende Kabel immer weiter.
7. „Immer die andere Sorte.“ Merkregel: „Lag das Kabel zum Boden eben obenauf? Dann jetzt drunter.“ Vier Schlaufen im Zeitraffer, Strichliste.
8. „Klettband drum – fertig.“ ✓

### 4 · Klettband (≈ 45 s)
Jonas’ Hände, POV und Makro (Zeitlupe).
1. **Einmal vorbereiten**: Klettbinder 10–30 cm vor dem Stecker mit den Stiften um das Kabel legen, das lange Ende durch den eigenen Schlitz fädeln (3D-Pfeil), festziehen. Zugprobe: „Rutscht nicht.“ „Durch den eigenen Schlitz – festziehen.“ „Bei XLR am Stecker mit den Stiften: So hängt am Mikro kein Band.“
2. ✗ Ein Band, das nur um den Ring gewickelt war, fällt beim Öffnen herunter: „Nur drumgewickelt? Fällt ab, ist weg.“
3. „Mit diesem Ende fängst du an zu wickeln – dann ist das Band oben in deiner Hand.“
4. **Zumachen**: oben, wo die Hand gehalten hat, um den ganzen Ring legen und schließen. Zu fest: übertriebene Delle im Mantel; zu locker: Schlaufen rutschen heraus. „Fest, aber nicht quetschen.“ Beide Stecker bleiben außen.
5. Lange oder schwere Ringe: zwei Bänder gegenüber.
6. ✗ kurz, je ein Wort: Kabelbinder aus Plastik („quetscht“), das Kabel um sich selbst knoten („knickt“). ✓ Ring.

### 5 · Fehler und wie du sie behebst (≈ 150 s)
Unterkapitel als Chips in der Leiste.
1. **Das Ende durch den Ring.** Ursache: Der Ring wird in eine Kiste geworfen, ein Ende fällt durch die Mitte. Noor zieht es heraus: In jeder zweiten Schlaufe zieht sich ein Knoten zu (orange Ringe, gezählt 1 … 2 … 3). „Kommt das Ende aus der Mitte? Dann falsche Seite.“ · „Knoten? Stopp. Ende zurück durch die Mitte, nicht reißen.“ Daneben ✓ richtig: beide Enden außen, auseinanderziehen bzw. werfen (wie in Stufe 1).
2. **Die verdrehte Schlaufe – sie schlägt eine Acht.** Ursache: Das Kabel kommt von einem Ring, der immer gleich gewickelt war; das hängende Kabel ist schon verdreht (Streifen windet sich). Noor legt eine Schlaufe; sobald die rechte Hand loslässt, dreht sie sich von selbst zur Acht und steht aus dem Ring (Zeitlupe, Seitenkamera). Noor drückt sie flach, sie springt zurück: sperrig. Zum Vergleich: eine richtige Schlaufe bleibt flach liegen. „Im Kabel steckt schon Drall. Passt er nicht, schlägt die Schlaufe eine Acht.“ · „Plattdrücken hilft nicht – der Drall bleibt drin.“ Vier Wege, jeder mit eigenem POV-Bild und Ergebnis:
   - „Zwischen den Fingern zurückrollen, bis sie flach fällt.“
   - „Oder diese Schlaufe andersherum legen. Zweimal dieselbe Sorte ist dann okay.“
   - „Oder das freie Ende hängen lassen – der Drall dreht sich raus.“ (Inset: der Stecker dreht sich, der Zähler fällt.) „Steckt ein Ende noch? Dann fang dort an zu wickeln.“
   - „Viele Achten? Ganz auslegen, neu wickeln.“
3. **Die richtige Größe.** Noor lässt das Kabel langsam aus der Hand auf den Boden sinken: Es legt sich in Bögen. Ein gestrichelter Kreis wird darauf gelegt und als Geisterschlaufe in ihre Hand gehoben. „So groß will das Kabel liegen.“ Drei Ringe nebeneinander, gleiche Kamera: zu klein (federt auf, wird oval, steht ab – Hinweis in Bernstein), zu groß (schleift am Boden, jemand tritt drauf), richtig (liegt von allein rund). POV: Eine Schlaufe beult sich, Noor lässt 5 cm mehr heraus, sie liegt rund. „Will die Schlaufe größer werden? Lass sie.“ · „Will sie andersherum? Gib nach und gleich es bald aus.“
4. **Nicht um Hand und Ellenbogen.** Noor: „So nicht.“ (jede Schlaufe dreht das Kabel, zu eng, gedehnt) – „So.“ (über-unter in der Hand).

### 6 · Dicke Kabel (≈ 60 s)
1. Mai wickelt 15 m Starkstrom 5G2,5 allein über-unter, Schlaufen 40–50 cm, trägt den Ring nah am Körper.
2. 25 m 5G16 (≈ 40 kg): Eine Schlaufe in der Hand federt zurück, zu schwer und zu steif. „Sehr dicke Kabel: auf dem Boden in Achten legen.“ Draufsicht und Mais POV nach unten: Jede Acht hat eine Schlaufe rechts- und eine linksherum (↻ ↺), der Streifen bleibt ruhig. „Hier ist die Acht gewollt: flach auf dem Boden.“ Biegeradius-Lehre: „Biegeradius mindestens 10 × Kabeldicke.“
3. Zwei Klettbänder um den Stapel. Abrollen: „Oben abziehen, eine Schlaufe nach der anderen.“
4. Tragen: Mai und Ada heben gemeinsam aus der Hocke, Mai gibt das Kommando (Handzeichen). „Schwer? Zu zweit tragen. Eine Person sagt an.“ · „Aus der Hocke, Rücken gerade, Last nah am Körper.“

### 7 · Für Neugierige: die Physik (≈ 120 s)
Ilse an einem Tisch mit Versuchen.
1. **Steifigkeit.** Drei gleich lange Kabelstücke ragen über die Tischkante (Ladekabel, XLR, Starkstrom), an jeder Spitze dieselbe kleine Klammer: Das dünne hängt sofort, das dicke bleibt fast gerade. „So weit trägt sich ein Kabel selbst – ungefähr so groß werden seine Schlaufen.“ Dann dreht Ilse ein eingespanntes XLR an einem Knauf: Der Streifen windet sich, ab einer Grenze springt eine Schlaufe heraus. „Ein Kabel wehrt sich gegen Biegen und gegen Verdrehen – fast gleich stark. Darum wird aus einer Drehung so leicht eine Schlaufe.“ · „Doppelt so dick: viel steifer. Steifere Kabel brauchen größere Schlaufen.“
2. **Formgedächtnis.** Ilse zieht ein Kabel von einem alten Ring und lässt es auf eine glatte Tischplatte fallen: Es landet in seinen alten Kringeln; ein neues Kabel landet fast gerade. „Lag ein Kabel lange aufgerollt, hat sich der Mantel an die Rundung gewöhnt.“ · „Warm und gerade ausgelegt vergisst er schneller. Kälte macht vor allem PVC steif.“ · „Richtig wickeln trainiert das Kabel um.“
3. **Zug versteckt den Drall.** Ein verdrehtes Kabel, gespannt: gerade. Locker: Kringel. „Gespannt sieht man den Drall nicht. Locker wird er zum Kringel.“ Ein freies Ende dreht ihn heraus: „Stecken beide Stecker, bleibt er drin.“
4. **Das Band.** Das gestreifte Kabel verwandelt sich in ein flaches Band: „Gelbe Seite = Streifen.“ Vier Bänder mit je vier Schlaufen sind an beiden Enden in Klemmen auf Schienen eingespannt: „Enden fest – sie dürfen sich nicht drehen.“
   | Band | auseinandergezogen | wieder zusammengeschoben |
   |---|---|---|
   | über ×4 | vier Drehungen, rechtsgängig wie ein Gewinde | Schlaufe, dann Verdrillung |
   | unter ×4 | vier Drehungen, andersherum | dasselbe, spiegelbildlich |
   | abwechselnd | glatt | ruhiger Bogen |
   | über, über, unter, über | zwei Drehungen | ein Kringel |
   Unter jedem Band ein Balken gleicher Länge, geteilt in gelb „Verdrillung“ und blau „Schlingen“: Beim Ziehen verschiebt sich die Teilung, die Länge bleibt. Zahlen erst am Ende. „Zähl einfach: über +1, unter −1. Was übrig bleibt, steckt als Drehung im Kabel.“ Ilse löst eine Klemme: Das Band dreht sich frei, die Summe ändert sich. „Lässt du ein Ende los, dreht sich der Drall heraus – das nutzt du bei der Acht.“
5. **Zu viel Drall im Ring**: Ein geschlossener Ring bekommt Drall dazu und klappt plötzlich zur Acht. Rückblick auf die verdrehte Schlaufe aus Stufe 5.
6. **Die Formel.** „Drehung + Schlingen = bleibt gleich (bei festgehaltenen Enden).“ Klein darunter: „Lk = Tw + Wr · Verschlingungszahl = Verdrillung (Twist) + Writhe · Satz von Călugăreanu, White und Fuller“. „Dieselbe Rechnung erklärt, wie sich DNA in der Zelle zu Superspiralen verdrillt.“
7. **Darum über-unter**: 1 + 1 + 1 + 1 + 1 + 1 = 6 · 1 − 1 + 1 − 1 + 1 − 1 = 0. Schlusskarte mit dem fertigen Ring.

## Was wir bewusst nicht behaupten

- Dass Über-Unter die Gleichtaktunterdrückung (CMRR) oder die Kapazität „erhält“: Das ist Folklore. Echte Vorteile: Das Kabel liegt flach, lässt sich ohne Kringel auslegen, ist schneller auf- und abgebaut und hält länger, weil es keine Knicke bekommt.
- Eine feste Zahl für das Rollen der Finger: Es ist eine kleine Drehung, die bei über und unter entgegengesetzt ist.
- Die Kabeltrommel als Bild fürs Auswerfen: Das wäre falsch (die erste Fassung hat es so gezeigt). Eine Trommel muss sich mitdrehen.

## Umsetzung (Kurzfassung)

- Ringe werden nicht aus einer Formel gebaut, sondern **gewickelt** („Ringfabrik“): Die Simulation legt die Schlaufen mit Führungskräften, so dass die Kreuzungen stimmen und der Drall pro Schlaufe klein bleibt. Jeder Ring wird automatisch geprüft (Über-Unter ausgezogen: |Drall| < 0,3 Umdrehungen; immer gleich: etwa eine Umdrehung pro Schlaufe; Streifen in Ruhe gerade). Spätere Einstellungen starten aus dem gespeicherten Zustand.
- Beim Wickeln ist der Ring in der Hand fest mit der Hand verbunden; simuliert werden die Schlaufe zwischen den Händen (mit Führung zur richtigen Kreuzung) und das Kabel zum Boden, das durch die Hand gleitet.
- Wurf: Die Schlaufen lösen sich von einem geführten Ring, simuliert wird das ausgelegte Kabel. Knoten: erst als Test in Node, sonst geführt. Acht: eingeschlossener Drall von 2,7–3 Umdrehungen. Klettband: kinematisch.
- Gerechnet wird pro Takt; Zeitlupen werden mit höherer Rate gerechnet. Gerendert wird pro Kapitel mit 30 Bildern/s, Vorschau mit halber Auflösung.
