# Kabel richtig aufwickeln: Konzept der 3D-Fassung

Die erste Fassung war 2D und zu abstrakt: Wickeln ist eine 3D-Bewegung der Hände, und was ein Kabel tut (Drall, Kringel, Acht), versteht man nur, wenn es sich wie ein echtes Kabel verhält. Die zweite Fassung ist deshalb:

- **echtes 3D** (three.js in Motion Canvas), heller Studio-Look mit weichen Schatten;
- **simulierte Kabel**: ein Cosserat-Stab (XPBD) mit Biege- und Torsionssteifigkeit, Schwerkraft, Bodenreibung, Selbstkontakt und Formgedächtnis. Hände greifen das Kabel und drehen es. Wo die Simulation allein nicht verlässlich die gewünschte Form findet, führen weiche Führungskräfte sie dorthin („Pseudo-Simulation“). Gerechnet wird vorab (`npm run bake`), im Video wird nur abgespielt;
- **Ich-Perspektive (POV)**: Beim Erklären sieht man die eigenen Hände so, wie man sie beim Wickeln sieht; in Stufe 3 im geteilten Bild neben einer Außenansicht. Für die POV sind Schultern und Kamera etwas versetzt, damit Hände und Ring ganz ins Bild passen (die Hände selbst sind in beiden Ansichten dieselben, das Kabel auch);
- **Menschen** aus dem Erklärvideo (`erklaervideo/src/lib/people.ts`, `body/`), erweitert um Finger, Arbeitskleidung, Körperformen, Frisuren und Kopfbedeckungen.

Aufbau wie bisher: vom Überblick immer genauer, nach jeder Stufe die Karte „Verstanden? Dann kannst du hier aufhören.“, jede Stufe ein Kapitel im mp4.

## Besetzung

Ein Team, das einfach zusammen arbeitet. Niemand wird vorgeführt, niemand erklärt sich; die Vielfalt steht im Bild, nicht im Text.

| Rolle | Wer | Aussehen |
|---|---|---|
| **Noor** (wickelt in Stufe 1 und 3, eigene Hände in der POV) | Frau, Mitte 20 | Hidschab in Salbeigrün, mittelbraune Haut, dunkelgraues Langarmshirt, olivfarbene Arbeitshose mit Knieschonern, Sneaker, Rigger-Handschuhe mit freien Fingerspitzen hängen am Gürtel |
| **Kofi** (wirft das lange Kabel) | Mann, um die 55 | dunkle Haut, kurze graue Haare und grauer Bart, rosa T-Shirt, schwarze Arbeitshose, Arbeitsschuhe |
| **Robin** (zieht das Ladekabel auseinander) | nicht-binär, um die 20 | helle Haut, kurzer Undercut in Türkis, übergroßer Hoodie in Senfgelb, weite Hose |
| **Mai** (legt das dicke Stromkabel in Achten, hebt) | Frau, um die 30 | ostasiatisch, kleiner und kräftig, Cap, Hoodie in Petrol, Knieschoner, Sicherheitsschuhe, Arbeitshandschuhe |
| **Jonas** (trägt mit Mai) | Mann, um die 35 | weiß, groß und schlank, lange blonde Haare im Zopf, lackierte Nägel, Fleece in Lila |
| **Ilse** (zeigt die Physik am Tisch) | Frau, um die 70 | weißes Haar im Bob, Brille, Rollstuhl, Strickjacke |
| **Ada und Teo** (ziehen in Stufe 2 nebeneinander je einen Ring auseinander) | Ada: Schwarze Frau, um die 40, kurze Locken; Teo: Mann, um die 25, südasiatisch, Locken, Brille | Alltags- und Arbeitskleidung |

Sprache: Wir sprechen alle mit „du“ an, ohne generisches Maskulinum („wer links wickelt“ statt „Linkshänder“, „zu zweit“ statt „zwei Männer“, „Crew“ statt „Techniker“).

## Kabel

| Kabel | Ø (gezeigt) | Steifigkeit | Schlaufe |
|---|---|---|---|
| XLR, 10 m, schwarz | 7 mm (leicht übertrieben) | EI 2e-3, GJ 1,5e-3 N·m² | Ø ≈ 25–30 cm |
| Ladekabel USB-C, 1,5 m, weiß | 4 mm | EI 4e-4 | Ø ≈ 10 cm |
| CEE-Verlängerung 5G2,5, 15 m, blau | 16 mm | EI ≈ 0,1 | Achten von ≈ 60 cm |

Alle Kabel tragen einen **gelben Längsstreifen**: Er zeigt, wie sich das Kabel um die eigene Achse dreht (Drall). In Erklärstrecken leuchten Über-Schlaufen **blau**, Unter-Schlaufen **orange**.

## Stufen

### Titel (≈ 8 s)
Kamera fährt langsam um einen sauberen Ring auf einem Flightcase, Klettband zu, beide Stecker außen. Titel „Kabel richtig aufwickeln – die Over-Under-Methode“, dann die sechs Stufen in einer Leiste.

### 1 · Überblick (≈ 45 s)
1. **Noor wickelt ein XLR-Kabel** (Außenansicht schräg von rechts vorn, leicht von oben, nah an Händen und Ring; langsame Kamerafahrt). Sechs Schlaufen: Über-Schlaufen leuchten kurz blau, Unter-Schlaufen orange, jeweils mit Etikett „über“/„unter“ an der Schlaufe. Man sieht, dass sich die rechte Hand für „unter“ umdreht und dass das Kabel zum Boden einmal vor, einmal hinter der neuen Schlaufe läuft.
   Text: „Schlaufen in die linke Hand legen – abwechselnd über und unter.“ · „Für »unter« dreht die rechte Hand um.“
2. **Fertig**: Klettband zu (kurz).
3. **Auslegen, kurzes Kabel**: Robin nimmt beide Enden eines Ladekabel-Rings und zieht die Hände auseinander. Die Schlaufen öffnen sich nacheinander, das Kabel hängt glatt. Text: „Kurzes Kabel: beide Enden nehmen, auseinanderziehen.“
4. **Auslegen, langes Kabel**: Kofi hält das Ende, wirft den Ring von unten nach vorn (Ring hochkant, in Wurfrichtung). Die Schlaufen laufen im Flug ab und landen als gerade Linie. Text: „Langes Kabel: ein Ende festhalten, Ring werfen.“ · ✓ „Liegt glatt. Keine Kringel, keine Knoten.“

### 2 · Warum (≈ 45 s)
1. Ada und Teo stehen nebeneinander, jede Person hält einen Ring aus 6 Schlaufen. Links „immer gleich herum gewickelt“, rechts „über, unter, über …“.
2. Beide ziehen gleichzeitig die Enden auseinander (Nahaufnahme, Zeitlupe). Links springen **noch während des Ziehens** Kringel aus dem Kabel, der gelbe Streifen windet sich wie eine Schraube; rechts kommt das Kabel glatt heraus, der Streifen bleibt oben.
3. Text: „Jede Schlaufe speichert eine Drehung.“ Zähler über den Kabeln: links 1, 2, … 6, rechts +1, −1, … 0.
4. Wiederholung einer Schlaufe in Zeitlupe: Aus der Schlaufe wird beim Ziehen eine Drehung, und sobald das Kabel locker ist, springt sie als Kringel heraus. Zieht Ada weiter, zieht sich der Kringel zum Knick zu. Text: „Kringel → Knick → kaputte Adern und Schirm.“

### 3 · Schritt für Schritt (≈ 100 s)
Geteiltes Bild: links „So siehst du es“ (POV), rechts „Von außen“ (Noor schräg von rechts vorn). Unten der Schritt mit Nummer. Langsam, die Unter-Schlaufe zweimal (einmal in Zeitlupe).
1. „Ende in die linke Hand, Handfläche nach oben. Der Stecker hängt außen herunter.“
2. „Rechte Hand greift das Kabel, Daumen oben, und gleitet eine Schlaufenlänge nach außen.“
3. **Über**: „Zurück zur linken Hand, dabei das Kabel mit Daumen und Zeigefinger nach vorn rollen. Die Schlaufe legt sich rund in die Hand. Das Kabel zum Boden läuft **vor** der Schlaufe.“ (Der Strang zum Boden leuchtet kurz.)
4. **Unter**: „Rechte Hand umdrehen: Handfläche nach oben, Daumen zeigt nach außen. So greifen und nach außen gleiten.“
5. „Zurück, dabei die Hand zurückdrehen und das Kabel andersherum rollen. Die Schlaufe fällt über den Handrücken. Das Kabel zum Boden läuft **hinter** der Schlaufe.“
6. „Prüfen: Liegt die Schlaufe flach und rund? Dreht sich das Ende am Boden nicht? Dann passt es.“
7. „Weiter abwechselnd bis zum Ende.“ (vier Schlaufen im Zeitraffer)

### 4 · Klettband (≈ 35 s)
1. Klettkabelbinder mit Öse: 10–30 cm vor dem Stecker um das Kabel legen, das Ende durch die Öse fädeln und festziehen. Jetzt bleibt er am Kabel und geht nicht verloren. (Bei XLR am Stecker-Ende, Hauptsache immer gleich.)
2. Nach dem Wickeln: das Band oben, wo die Hand gehalten hat, um den ganzen Ring legen und schließen. Fest genug, dass nichts rutscht, nicht so fest, dass es den Mantel quetscht. Beide Stecker bleiben außen.
3. Lange oder schwere Ringe: zwei Bänder gegenüber.
4. ✗ Kabelbinder aus Plastik, ✗ das Kabel um sich selbst knoten, ✗ die Stecker ineinanderstecken.

### 5 · Feinheiten und Fehler (≈ 120 s)
1. **Nie ein Ende durch den Ring ziehen.** Ein Ende wird durch die Mitte des Rings gefädelt und herausgezogen: In jeder zweiten Schlaufe zieht sich ein Knoten zu (simuliert). Richtig: beide Enden außen lassen, auseinanderziehen (kurz) oder werfen (lang), wie in Stufe 1.
2. **Die Acht.** POV und außen: Eine Schlaufe wird gegen den Drall gelegt. Sie will nicht flach liegen, verdreht sich zur Acht und steht sperrig aus dem Ring; der Streifen zeigt die gespeicherte Drehung. Text: „Im Kabel steckt Drall in die falsche Richtung. Die Schlaufe kann ihn nicht flach halten.“ Beheben, drei Wege:
   - „Kabel zwischen den Fingern zurückrollen, bis die Schlaufe flach fällt.“
   - „Oder diese Schlaufe als die andere Sorte legen (über statt unter) und danach weiter abwechseln.“
   - „Oder das Ende frei hängen lassen: Es dreht sich und der Drall läuft heraus.“
3. **Die richtige Schlaufengröße.** Noor lässt einen Meter Kabel aus der Hand hängen: Das Kabel krümmt sich von selbst, das ist seine Lieblingsgröße. Zu klein: die Schlaufen federn auf, das Kabel wird scharf gebogen (rot), nah an einem Knick. Zu groß: die Schlaufen hängen bis zum Boden und verheddern sich. Richtig: so groß, wie das Kabel von selbst liegt. Faustregel für die Biegung: nie enger als etwa das Zehnfache der Kabeldicke.
4. **Nicht um Hand und Ellenbogen.** Kurz außen: Jemand wickelt um Hand und Ellenbogen; jede Schlaufe dreht das Kabel, es wird gedehnt, die Schlaufen sind zu eng. ✗
5. **Dicke Kabel.** Mai legt eine schwere CEE-Verlängerung auf dem Boden in Achten: jede Acht eine Schlaufe links- und eine rechtsherum, der Drall gleicht sich aus. Anheben aus der Hocke mit geradem Rücken. Schwer? Zu zweit: Mai und Jonas tragen den Stapel gemeinsam. Text: „Schwer heißt: zu zweit und mit Technik – egal, wer hebt.“

### 6 · Für Neugierige: die Physik (≈ 90 s)
Ilse an einem Tisch mit Versuchen.
1. **Steifigkeit.** Drei Kabel hängen über einer Stange (Ladekabel, XLR, Stromkabel) und biegen sich verschieden. „Ein Kabel wehrt sich gegen Biegen und gegen Verdrehen. Doppelt so dick heißt ungefähr 16-mal so steif.“
2. **Formgedächtnis.** Ein Kabel, das lange aufgerollt lag, wird gerade hingelegt und krümmt sich zurück. „Mantel und Kupfer merken sich die Form. Wärme löst das Gedächtnis, Kälte macht das Kabel steif.“
3. **Das Band.** Statt des Kabels ein flaches Band (oben gelb, unten dunkel). Drei Bänder mit je vier Schlaufen: nur Über-Schlaufen, nur Unter-Schlaufen, gemischt über/unter. Beide Enden werden auseinandergezogen: links vier Drehungen rechtsherum, in der Mitte vier linksherum, rechts glatt. Dann werden die Enden wieder zusammengeschoben: Links und in der Mitte springen Kringel (in entgegengesetzter Richtung) heraus, rechts bleibt das Band ruhig. Live-Zähler zeigen Verdrillung und Windung; ihre Summe bleibt gleich.
4. **Die Formel.** „Verschlingungszahl = Verdrillung + Windung“ (Satz von Călugăreanu). Dieselbe Rechnung beschreibt, wie sich DNA aufwickelt.
5. **Darum über-unter**: 1 + 1 + 1 + 1 + 1 + 1 = 6 · 1 − 1 + 1 − 1 + 1 − 1 = 0. Schlusskarte.

## Was wir bewusst nicht behaupten

- Dass Über-Unter die Gleichtaktunterdrückung (CMRR) oder die Kapazität „erhält“: Das ist Folklore. Echte Vorteile: Das Kabel liegt flach, lässt sich ohne Kringel auslegen, ist schneller auf- und abgebaut und hält länger, weil es keine Knicke bekommt.
- Die Kabeltrommel als Bild fürs Auswerfen: Das wäre falsch (die erste Fassung hat es so gezeigt).
