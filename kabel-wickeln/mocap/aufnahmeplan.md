# Aufnahmeplan: echte Bewegungen für „Kabel richtig aufwickeln“

Die Hände im Video sollen sich bewegen wie deine, nicht wie ausgedacht. Darum nimmst du alle Bewegungen des Videos einmal mit der Kinect auf. Danach laufen große Pose-Modelle über die Aufnahmen und machen daraus Gelenkdaten. Die Figuren bewegen sich dann so wie du, und die Kabelsimulation folgt deinen echten Händen.

Du spielst alle Figuren: Noor, Kofi, Ilse, Teo, Robin, Jonas, Mai und Ada. Du brauchst dafür nicht zu schauspielern, arbeite einfach so, wie du immer arbeitest. Alter, Körperbau und Kleidung bekommen die Figuren erst in der Animation. Bei jedem Take steht trotzdem die Rolle dabei, damit die Animation weiß, wohin er gehört.

Die maschinenlesbare Fassung dieses Plans ist [`shots.json`](shots.json). Das Aufnahme-Tool liest sie, und später lesen sie auch die Animationen. Die IDs (`p1.coil.teach` …) sind in beiden Dateien gleich und bleiben fest.

## Auf einen Blick

| Aufbau | Wofür | Shots | Takes | Aufnahme | Speicher | Zeit mit Umbau |
|---|---|---|---|---|---|---|
| **A** Front | Wickeln, Fehler beim Wickeln, Stehen, dickes Kabel wickeln | 16 | 28 | 11 min | 13 GB | ≈ 1 ½ h |
| **B** Nah | Finger, Klettband, Knoten, Acht, Ellenbogen, Teo und Robin | 28 | 47 | 16 min | 20 GB | ≈ 1 ½ h |
| **T** Tisch | Ilse: kurzes Kabel, FOH-Platz, Physik-Versuche | 12 | 20 | 6 min | 8 GB | ≈ ¾ h |
| **C** Hoch | Wickeln von oben, Bodenarbeit, Achten mit dem dicken Kabel | 9 | 12 | 5 min | 6 GB | ≈ 1 h |
| **D** Seite | Wurf, Heben zu zweit, Gehen und Tragen im Titel | 12 | 23 | 8 min | 9 GB | ≈ 1 ¼ h |
| **zusammen** | | **77** | **130** | **46 min** | **55 GB** | **≈ 6 h** |

Beim Heben nimmst du nur eine der beiden Varianten auf (allein oder zu zweit, siehe Aufbau D); die Tabelle zählt die Variante allein.

- **Zwei Termine** sind entspannter als einer: Termin 1 mit A, B und T (≈ 4 h; das Wichtigste, die Hände), Termin 2 mit C und D (≈ 2 h; braucht viel Platz, das hohe Stativ und für das Heben am besten eine zweite Person).
- Plane etwa **70 GB** freien **Speicher** ein (55 GB plus Wiederholungen). Hast du weniger, verschieb die Aufnahmen nach Termin 1 auf eine externe Platte.
- **Prio** steht bei jedem Shot: **1** = unbedingt, **2** = wichtig, **3** = wenn Zeit ist. Nur Prio 1 sind 39 Shots, ≈ 4 h und 32 GB.
- Die Zeiten sind geschätzt: je Take etwa eine Minute für Kabel neu legen, hinstellen und kurz prüfen, dazu der Umbau und Pausen.
- Die Kinect steht an vier Plätzen, T ist B mit Tisch und Stuhl davor. Umgestellt wird sie also nur dreimal.

## So läuft ein Take

1. Im Aufnahme-Tool den Shot wählen und starten. Das Tool zählt 5 s herunter, damit du in Ruhe auf deine Marke gehen kannst.
2. **Startpose**, 1 s still.
3. Auf das Startsignal (Ton und „Klatschen“) **einmal klatschen**, mit den Händen vor der Brust, so dass die Kinect sie sieht. Das geht auch mit einem Kabelende in der Hand. Das Klatschen ist der Nullpunkt für die Auswertung (und für ein Handyvideo, falls du nebenher filmst).
4. 1 s still, dann loslegen. Das Tool zeigt die Ansagen aus `say`, bei manchen Shots auch zeitgesteuerte Ansagen mit Ton (Teo und Robin, Heben).
5. Am Ende **2 s in der Endpose** bleiben. Das Tool hört nach der geplanten Zeit von selbst auf.
6. Misslungen (Kabel verheddert, aus dem Bild gelaufen, gestolpert)? Nochmal. Ein Take kostet nur Speicher. Pro Shot brauchen wir einen guten.

**Tempo:**
- **Lehrtempo** heißt: so, wie du es in deinem Video B zeigst, eine Schlaufe etwa 3 s.
- **Langsam** heißt: etwa halbes Tempo, mit kurzen Halten an den wichtigen Stellen.
- **Arbeitstempo** heißt: so schnell, wie du sonst wickelst, ohne zu hetzen.

**Was die Auswertung braucht:**
- Die Hände sind frei sichtbar: nicht hinter dem Körper, nicht hinter dem Ring, nicht hinter der anderen Hand.
- Dein Gesicht zeigt ungefähr zur Kinect oder genau zur Seite, nicht schräg nach hinten.
- Die Startpose und die Endpose sind ruhig.
- Das Kabel läuft möglichst vor einem hellen Hintergrund, nicht vor deinem Körper.
- Du bleibst auf deiner Marke und im Bild.

## Was du vorbereitest

### Technik

- **Hub:** Starte nur den Hub mit der echten Kinect (Hauptordner, `kinect-hub\target\release\kinect-hub.exe`). Prüf unter `http://127.0.0.1:8090/api/status`, dass er von der Kinect liest und 30 fps schafft. Nimm **nicht** `start-wand.cmd`: Das stellt Windows für die Ausstellung um und startet die Wand. Schließ Szenen und Browser-Tabs mit der Wand, dann fehlen keine Bilder.
- **Aufnahme-Tool** (`mocap/aufnahme.cmd`, Anleitung in [README.md](README.md#aufnehmen)): Es liest `shots.json`, zeigt dir pro Take, was zu tun ist, und speichert nach `recordings/mocap/termin1/<shot>_t<take>.k2rec` im Hauptordner (Termin 2: `termin2/`). Ohne Tool geht es auch von Hand, aus dem Hauptordner. Nimm als Länge die Sekunden des Shots plus 10, damit du nach dem Start noch auf deine Marke gehen kannst, und klatsch dort selbst. Der Ordner wird angelegt, eine vorhandene Datei wird nie überschrieben:
  ```
  kinect-hub\target\release\kinect-hub-probe.exe record --seconds 40 --out recordings\mocap\p1.coil.teach_t1.k2rec
  ```
- **Vorschau:** Das Aufnahme-Tool zeigt Tiefe und Infrarot live. Ohne Tool zeigt `http://127.0.0.1:8090/` die Tiefe, und `http://127.0.0.1:8090/api/frame/ir?format=png` zeigt ein Infrarotbild (zum Aktualisieren neu laden).
- **Bildschirm:** Stell den Notebook-Bildschirm (oder einen zweiten Monitor) so, dass du ihn von der Marke aus lesen kannst, aber nicht in die Wurfbahn. Eine Funktastatur oder ein Presenter zum Starten erspart dir den Weg.
- **Stative:**
  - Die Kinect hat unten im Fuß ein 1/4-Zoll-Stativgewinde.
  - Für A, B, T und D reicht ein Fotostativ bis 1,5 m, am besten mit Kugelkopf zum Neigen.
  - Für C brauchst du 2,1 m: ein Licht- oder Mikrofonstativ mit Adapter auf 1/4″ und einem Kugelkopf, mit Sandsack gesichert. Ohne hohes Stativ geht auch ein Regal oder Schrank von etwa 2 m: Die Kinect oben an die Vorderkante stellen, mit Gaffa sichern und mit einem Buch unterlegt nach unten neigen.
- **Notebook-Platz:** Die Kinect reicht nur so weit wie ihr eigenes Kabel, eine USB-3-Verlängerung macht oft nur als aktive mit. Plan das Notebook deshalb nah am Stativ ein.
- **Zum Einmessen:** Maßband, Gaffa oder Kreppband für Bodenmarken, ein Handy mit Wasserwaage (für die Neigung).
- **Kabelweg:** Leg das USB-Kabel der Kinect so, dass du nicht darüber stolperst und dass es nicht in der Wurfbahn liegt.

### Raum und Licht

- **Kein Sonnenlicht** im Bild oder auf dir: Die Kinect misst mit Infrarot, und die Sonne stört es. Vorhänge zu, Lampen sind egal.
- Keine Spiegel, Glasflächen oder glänzenden Folien im Bild.
- **Heller Hintergrund:** Hinter dir sollte in 1–1,5 m eine helle, matte Fläche sein (Wand, Bettlaken, Malervlies). Das schwarze Kabel hebt sich davor ab. Schwarzer Molton ist hier genau falsch.
- **Boden (C):** Heller Holzboden reicht. Ist er dunkel, leg ein helles Laken hin und kleb es rundum fest (Rutschgefahr).
- **Tisch (T):** helle Platte oder ein helles Tuch.
- Niemand sonst im Bild: Mitbewohnende, Kinder, Besuch und Haustiere aus dem Raum.
- **Platz:** A und C etwa 3 × 3,5 m, B und T 2,5 × 2,5 m, D 5 × 4,5 m. Reicht der Raum für D nicht, nimm einen großen Raum (Probebühne, Halle, Lager), nicht draußen.

### Kleidung und Hände

- Eng anliegend, Ärmel bis über die Ellenbogen hochgeschoben oder ein T-Shirt: Die Drehung der Unterarme muss man sehen.
- Keine Reflexstreifen (Warnweste, Arbeitsjacke mit Streifen) und nichts Glänzendes: Das blendet im Infrarot.
- Keine Handschuhe: Die Finger sollen erkennbar sein.
- Haare zusammen, feste Schuhe (beim Heben zählen die Füße).
- Manche Stoffe sind im Infrarot hell, manche dunkel. Schau in der Vorschau, ob sich deine Unterarme vom Shirt abheben, sonst zieh etwas anderes an.
- Schwarze Kleidung schluckt bei der Kinect oft so viel Infrarot, dass im Tiefenbild Löcher sind. Grau oder eine mittlere Farbe ist sicherer.
- **Hilfreich, aber freiwillig:** ein Streifen helles Kreppband quer über jeden Handrücken. Im Infrarot leuchtet er, und die Auswertung sieht sicher, ob die Handfläche oben oder unten ist (das Umdrehen bei „unter“). Prüf es kurz in der Vorschau.

### Requisiten

| Was | Wofür | Wenn du es nicht hast |
|---|---|---|
| **XLR 5 m** (dein Sommer SC-Stage 22), Klettband am Stecker mit den Stiften | fast alles: Stufe 1, 3, 4, 5 | – |
| ein Kabel, das etwas aushalten darf (altes XLR) | Knoten (B21), Teo (B24–B26) | das 5-m-XLR, dann besonders vorsichtig |
| **langes XLR 10–15 m** | Kofis Wurf (D4, D5), Titel (D10), zwei Bänder (B17) | zwei 5-m-XLR zusammengesteckt (die Kupplung ist ein kleiner Knubbel); zweitbeste Lösung: das 5-m-XLR und ein kürzerer Wurf |
| **kurzes Kabel, am besten 1,5 m** (Patchkabel) | Teo und Robin (Stufe 2), Stehen (A13), Zug und Drall (T8) | Ladekabel; ein längeres Kabel bis 1,8 m geht auch, dann wird es beim Ausziehen nicht ganz gespannt |
| Ladekabel oder anderes dünnes Kabel | Ilse (T4), Steifigkeit (T6) | jedes dünne Kabel |
| kurzes XLR 1–3 m | Verdrehen (T7), Ring zur Acht (T10) | das 5-m-XLR mit längerer freier Länge |
| **Starkstrom 5G2,5, 15 m** (≈ 5 kg) | Mai wickelt (A14–A15), Steifigkeit (T6) | Verlängerungskabel 15–25 m; zweitbeste Lösung: Gartenschlauch 1/2″ |
| **Starkstrom 5G16, 25 m** (≈ 40 kg) | Achten am Boden (C7–C9), „federt zurück“ (A16) | Zu Hause hat das kaum jemand. Ersatz: Gartenschlauch 3/4″, 25 m (ähnlich dick und steif, aber viel leichter). Gibt es bei der Arbeit ein echtes, lohnen sich 30 min Ausleihen für C7–C9. |
| Klettbänder mit Schlitz (4–5), 2 lange für den Stapel | Stufe 4, 6 | – |
| Kabelbinder aus Plastik (am besten lösbar), Seitenschneider | B18 | Kabelbinder nur andeuten |
| Mikrofonstativ | Wurfziel (D4, D5), Robin (D11) | Stuhl oder Besen als Ziel |
| Kiste (Kabelkiste, Wäschekorb), 3–4 fertige Ringe | Titel (D12), Ursache Knoten (C6) | – |
| Getränkekiste oder Kiste mit ≈ 15 kg | Heben allein (D6, D7); zu zweit (D8) zwei davon, zusammengebunden | Wasserkasten, Bücherkiste |
| Koffer oder Case mit Deckel und Verschlüssen | Titel, Jonas (D13) | Werkzeugkoffer |
| Tisch (≈ 75 cm), Stuhl ohne Armlehnen | Aufbau T | Schreibtisch, Küchenstuhl |
| 3 Wäscheklammern, ein Buch, Schraubzwinge oder Gaffa | Physik (T6, T7) | – |
| Gurtband 1,2 m, ≈ 25 mm, eine Seite mit hellem Klebeband markiert | Band (T11, T12) | Band von einem Spanngurt, ein Gürtel |
| ein altes Kabel, das lange aufgerollt lag, und ein gerade gelagertes | Formgedächtnis (T9) | – |
| freiwillig: weißes Klebeband für Fähnchen | Stufe 2 und 7 | – |

**Fähnchen (freiwillig):** Kleb auf das kurze Kabel alle 20 cm ein Fähnchen aus weißem Klebeband, etwa 2 × 3 cm. Kleb sie, während das Kabel gerade und unverdreht liegt, alle zur selben Seite. Dann sieht man die Drehung des Kabels auch in der Aufnahme, wie den gelben Streifen im Video.

### Allein oder zu zweit

Fast alles nimmst du allein auf. Eine zweite Person hilft wirklich nur beim **Heben zu zweit** (D8, Mai und Ada). Ist niemand da, nimmst du beide Rollen nacheinander auf (D6 als Mai, D7 als Ada). Beide Takes laufen nach denselben Ansagen, die Animation setzt sie zusammen. Das Gleiche gilt für Teo und Robin (B26, B28): Sie stehen im Video nebeneinander, du nimmst sie nacheinander auf, mit denselben Ansagen.

Eine zweite Person darf nur mit ihrem Einverständnis ins Bild, siehe [Datenschutz](#datenschutz).

### Die Rollen

- **Noor** zeigt das Wickeln und führt die Fehler beim Wickeln vor (Stufe 1, 3 und 5). Die Fehler mit dem Klettband zeigt Jonas (Stufe 4).
- **Ilse** sitzt in einem sportlichen Aktivrollstuhl und fährt selbst.
  - Für die Aufnahme sitzt du auf einem Stuhl ohne Armlehnen, aufrecht, die Füße nebeneinander.
  - Steh nicht auf, rutsch nicht mit dem Stuhl und stütz dich nicht mit den Füßen ab. Bewegen dürfen sich nur Oberkörper, Arme und Kopf.
  - Nimm die Hände nicht seitlich unter die Sitzfläche: Dort sind in der Animation die Räder.
- **Mai und Ada** heben aus der Hocke, mit geradem Rücken und der Last nah am Körper. Nimm nur so viel Gewicht, wie dir guttut. Etwa 15 kg pro Person sehen echt genug aus.
- **Kofi, Teo, Robin, Jonas:** einfach du, bei der Arbeit.

## Kinect aufstellen (für jeden Aufbau)

1. **Bodenmarken kleben:** die Marke der Person (ein Kreuz, ein Pfeil zeigt die Blickrichtung) und den Platz des Stativs. Die Maße stehen beim Aufbau.
2. **Höhe:** Gemessen wird bis zur Mitte der Kinect-Vorderseite.
3. **Neigung:** Leg das Handy mit der Wasserwaage oben auf die Kinect. Reicht das Gelenk im Fuß der Kinect nicht (20° in B, 35° in C), neigst du mit dem Kugelkopf.
4. **Richtung:** Die Kinect zeigt genau auf die Marke.
5. **Vorschau prüfen:**
   - Stell dich auf die Marke und mach die Bewegung, die am meisten Platz braucht. Ist alles im Bild?
   - Siehst du im Infrarotbild deine Hände und das Kabel vor dem Hintergrund?
   - Leuchtet nichts grell weiß? Das hieße zu nah oder Reflexstreifen.
6. **Bildränder markieren:** Geh seitlich, bis deine Hand in der Vorschau verschwindet, und kleb dort ein Stück Band auf den Boden. Dann weißt du beim Arbeiten, wo das Bild aufhört.
7. **Kalibrieren:** Nimm die drei Kalibrier-Shots des Aufbaus auf (≈ 2 min):
   - leerer Raum, 5 s: der Hintergrund;
   - Kabel gerade am Boden, 5 s: zeigt, wie das Kabel im Bild aussieht, und dient als Maßstab;
   - Körper (≈ 15 s): T-Pose, Hände auf und zu, Handflächen hoch und runter.

   Danach noch einen Probelauf ohne Aufnahme.

---

## Aufbau A · Front (stehend, Hüfthöhe, schräg von vorn)

Der Hauptaufbau fürs Wickeln, mit Blick wie in deinem Video B, nur etwas von rechts. So sieht die Kinect die rechte Hand außen an der Hüfte und das Umdrehen, und die linke Hand mit dem Ring liegt frei vor dem Körper.

```
Draufsicht: Du schaust nach oben (^). Rechts im Bild ist deine rechte Seite.

                            [K]  Kinect: 1,20 m hoch, 10° nach unten
                           /
              ^           /
              |          /
              |         /   1,8 m
              |        /    (= 1,55 m nach vorn
              |       /        und 0,90 m nach rechts)
              | 30°  /
              |     /
              |    /
              |   /
              |  /
              | /
              P   du auf Marke A, Blick nach oben ^
                  ausgelegtes Kabel: rechts neben dir am Boden ->

   ===============================================
     helle, matte Fläche, 1–1,5 m hinter dir
```

- **Kinect:** 1,20 m hoch, 10° nach unten, 1,8 m vor dir, 30° nach rechts versetzt. Du schaust geradeaus, nicht zur Kinect.
- **Bild an der Marke:** etwa 2,6 m breit, vom Boden bis etwa 1,85 m, also mit Füßen und dem Boden rechts von dir. Das Kabel ist dort nur gut 1 Pixel dick: Hier zählen Hände und Arme, das Kabel ist eine Zugabe.
- **Kabelvorrat** liegt rechts neben dir am Boden, nicht nach vorn zum Stativ.
- Zwischen zwei Wickel-Takes den Ring öffnen, ein Ende festhalten und auswerfen. Ist Drall im Kabel, lass es kurz frei hängen, bis es ruhig ist.

**A1–A3 · Kalibrierung** (`cal.A.empty`, `cal.A.cable`, `cal.A.body`), Prio 1, ≈ 2 min
- leerer Raum 5 s;
- 5-m-XLR gestreckt quer über Marke A, niemand im Bild, 5 s;
- Körper 18 s: T-Pose, Hände dreimal auf und zu, Handflächen dreimal hoch und runter, dann 2 s Gesicht zur Kinect und 2 s genau seitlich.

**A4 · `p1.coil.teach`** · Prio 1 · Noor · 3 × 30 s · Lehrtempo
*Stufe 1.1 und 1.2 (erstes Paar langsam, Klettband zu), dient auch für Stufe 3.* **Der wichtigste Shot.**
- **Start:** Das Kabel liegt ausgelegt und ohne Drall rechts von dir. Das Ende mit dem Klettband hast du in der linken Hand, der Stecker bleibt außen.
- **Ablauf:** Wickle das ganze Kabel im Lehrtempo, abwechselnd über und unter, genau so, wie du es zeigst: dein Griff, deine Schlaufengröße, die neue Schlaufe vom Körper weg. Am Ende das Klettband zu.
- **Ende:** Ring 2 s ruhig vor der linken Hüfte.
- **Tracking:** Die rechte Hand geht nie hinter den Körper, die linke Hand verschwindet nicht hinter dem Ring. Das Kabel zum Boden läuft rechts vor der hellen Fläche.

**A5 · `p1.coil.natural`** · Prio 1 · Noor · 3 × 20 s · Arbeitstempo
*Stufe 1.1 (vier Schlaufen in Echtzeit), Stufe 3.7 (Zeitraffer), Titel, Stufe 5.3 (richtig groß), das „So.“ in Stufe 5.4.*
- Wie A4, nur in deinem normalen Tempo. Ruhig und gleichmäßig, nicht hetzen.

**A6 · `p3.pair.slow`** · Prio 1 · Noor · 2 × 30 s · langsam
*Stufe 3.2–3.5: Über- und Unter-Schlaufe Schritt für Schritt.*
- **Start:** 1–2 Schlaufen schon in der linken Hand.
- **Ablauf:** Ein Paar, erst über, dann unter. An sieben Stellen hältst du je eine Sekunde an:
  1. Die rechte Hand greift neben der linken, der Daumen zeigt zur linken Hand.
  2. Die rechte Hand ist außen an der Hüfte.
  3. Die Über-Schlaufe liegt in der linken Hand.
  4. Rechts außen: die Hand umgedreht, der Daumen zeigt nach außen.
  5. Auf dem Rückweg: Die Schlaufe hängt über dem Handrücken.
  6. Übergabe: Das Handgelenk steckt noch in der Schlaufe.
  7. Die Hand ist herausgeschlüpft.
- **Tracking:** Diese Halte werden später die Standbilder in Stufe 3. Halt die Hand dabei so, dass die Kinect den Handrücken oder die Handfläche sieht, nicht nur die Kante.

**A7 · `p3.check`** · Prio 2 · Noor · 2 × 15 s · Lehrtempo
*Stufe 3.6: Fällt die Schlaufe flach und rund? Hängt das Kabel zum Boden ruhig?*
- **Ablauf:** Ein Paar wickeln, anhalten, deutlich auf den Ring schauen, dann auf das Kabel zum Boden, dann weiterwickeln.
- **Tracking:** Hier zählt der Kopf. Den Ring dabei ruhig halten.

**A8 · `p3.wrong.same`** und **A9 · `p5.eight.hang`**: abwechselnd aufnehmen. A9 beginnt mit dem Ring, mit dem A8 endet, und lässt dabei den Drall wieder heraus. Also: A8 Take 1, A9 Take 1, Kabel neu auslegen, A8 Take 2, A9 Take 2.

- **A8 · `p3.wrong.same`** · Prio 2 · Noor · 2 × 20 s · Arbeitstempo
  *Stufe 3.6 ✗ Vergleich, auch der Rückblick auf Teos Ring in Stufe 2.1.*
  - **Fehler mit Absicht:** nur Über-Schlaufen, die Hand wird nie umgedreht. Drei, vier Schlaufen, bis noch etwa 1 m Kabel hängt. Dann aufs hängende Kabel schauen, das sich verdreht.
  - **Ende:** Den Ring nicht öffnen, weiter mit A9.
- **A9 · `p5.eight.hang`** · Prio 2 · Noor · 2 × 20 s · Arbeitstempo
  *Stufe 5.2, Weg 3: das freie Ende hängen lassen, der Drall dreht sich heraus.*
  - **Start:** der Ring aus A8 in der linken Hand, etwa 1 m verdrehtes Kabel hängt herunter, der Stecker liegt am Boden.
  - **Ablauf:** Heb den Ring auf Brusthöhe, so dass der Stecker frei über dem Boden hängt und sich ausdreht. Warte, bis er ruhig ist, und wickle dann zu Ende.

**A10 · `p5.size.small`** · Prio 2 · Noor · 1 × 15 s · Arbeitstempo
*Stufe 5.3: zu klein.*
- **Fehler mit Absicht:** viel zu kleine Schlaufen, etwa 15 cm, vier Stück, sonst über-unter wie immer.
- **Ende:** Ring 2 s auf Brusthöhe zur Kinect halten.

**A11 · `p5.size.big`** · Prio 2 · Noor · 1 × 15 s · Arbeitstempo
*Stufe 5.3: zu groß, schleift am Boden, jemand tritt drauf.*
- **Fehler mit Absicht:** viel zu große Schlaufen, sie schleifen am Boden. Am Ende trittst du mit dem rechten Fuß leicht auf eine Schlaufe und bleibst stehen.
- **Vorsicht**, nicht stolpern. Die Füße müssen im Bild sein.

**A12 · `p3.lefty`** · Prio 3, freiwillig · Noor · 1 × 25 s · Lehrtempo
*Stufe 3, Hinweis für alle, die links wickeln.*
- Alles gespiegelt: Ring in der rechten Hand, Schlaufen mit der linken. Nur, wenn es sich halbwegs flüssig anfühlt, sonst spiegelt die Animation A4.

**A13 · `idle.stand`** · Prio 2 · alle · 2 × 15 s · Arbeitstempo
*Stufe 2.1 (Teo und Robin stehen mit ihren Ringen nebeneinander), Titel und alle Übergänge: Wer nur dasteht, soll lebendig wirken, nicht eingefroren.*
- **Take 1** mit dem kurzen Ring in beiden Händen vor dem Bauch, **Take 2** mit dem fertigen 5-m-Ring in der linken Hand.
- **Ablauf:** Steh locker da, wie bei der Arbeit, wenn du kurz wartest: das Gewicht ruhig verlagern, mal auf den Ring schauen, mal zur Seite. Nicht schauspielern.

**A14 · `p6.coil.power`** · Prio 1 · Mai · 2 × 30 s · Arbeitstempo
*Stufe 6.1: 15 m Starkstrom allein über-unter, Schlaufen 40–50 cm.*
- **Kabel:** 5G2,5 oder Ersatz (Verlängerung, Gartenschlauch 1/2″).
- **Ablauf:** große Schlaufen, über-unter in deinem Tempo. Nach etwa acht Schlaufen aufhören, auch wenn das Kabel nicht fertig ist, und den Ring kurz ruhig halten.
- **Tracking:** Auf der Marke bleiben, das Bild ist nur 2,6 m breit.
- Die schweren Stecker nicht auf die Füße fallen lassen.

**A15 · `p6.carry.ring`** · Prio 2 · Mai · 2 × 12 s · Arbeitstempo
*Stufe 6.1: trägt den Ring nah am Körper.*
- **Start:** Der Ring ist fertig gewickelt und zu (ohne Aufnahme).
- **Ablauf:** Ring aufnehmen, nah am Körper tragen, wie bei der Arbeit (Schulter oder vor der Hüfte), zwei Schritte zur Seite, stehen bleiben.

**A16 · `p6.thick.fail`** · Prio 2 · Mai · 2 × 12 s · Arbeitstempo
*Stufe 6.2: Beim 5G16 federt eine Schlaufe in der Hand zurück, zu schwer und zu steif.*
- **Kabel:** das dickste, das du hast, oder ein Gartenschlauch 3/4″.
- **Fehler mit Absicht:** eine Schlaufe in der Hand versuchen, ein-, zweimal. Dann aufgeben und das Kabel auf den Boden legen. Das Gewicht zeigen, nicht schauspielern.

---

## Aufbau B · Nah (stehend, Hände von vorn oben)

Für Finger, Klettband, Knoten und die Acht: alles, was klein ist. Die Kinect steht näher, höher und genau vor dir.

```
Draufsicht: Du schaust nach oben, zur Kinect.

              [K]  Kinect: 1,50 m hoch, 20° nach unten (auf deine Hände)
               |
               |  1,3 m
               |
               P   du auf Marke B, Gesicht zur Kinect

   ===============================
     helle, matte Fläche hinter dir
```

- **Kinect:** 1,50 m hoch, 20° nach unten, 1,3 m genau vor dir.
- **Bild an der Marke:** etwa 2,0 m breit, vom Boden bis etwa 1,7 m. Bist du größer, fehlt oben der Scheitel, das macht nichts. Hände etwa 50 Pixel, das Kabel knapp 2 Pixel.
- Arbeite wie immer auf Hüfthöhe. Die rechte Hand gleitet wie gewohnt bis zur rechten Hüfte oder zum Oberschenkel; weiter außen wäre sie aus dem Bild.

**B1–B3 · Kalibrierung** (`cal.B.empty`, `cal.B.cable`, `cal.B.body`), Prio 1, ≈ 2 min
- wie in A;
- beim Körper statt der Drehung: Daumen und Zeigefinger dreimal zusammen wie beim Kabelgriff, vor dem Bauch.
- Ragen die Hände in der T-Pose aus dem Bild, nimm die Arme etwas nach vorn.

**B4 · `p1.coil.near`** · Prio 1 · Noor · 2 × 30 s · Lehrtempo
*Stufe 1.1 und 3: Griff und Rollen zwischen Daumen und Zeigefinger.*
- Wickeln wie A4, hier geht es um die Finger.
- **Tracking:** Daumen und Zeigefinger gut sichtbar, die Hände auf Hüfthöhe, nicht hinter dem Ring.

**B5 · `p3.start`** · Prio 1 · Noor · 2 × 15 s · langsam
*Stufe 3.1–3.2.*
- **Start:** Das Kabelende liegt vor dir auf dem Boden oder hängt über dem rechten Unterarm.
- **Ablauf:** Ende in die linke Hand, der Stecker bleibt außerhalb des Rings. Die rechte Hand greift, der Daumen zeigt zur linken Hand. Eine Armlänge nach außen gleiten, halten.
- KONZEPT sagt für die linke Hand „Handfläche oben“. Halt sie so, wie du es wirklich machst; den Text passen wir an deine Aufnahme an.

**B6 · `p3.pair.slow.near`** · Prio 1 · Noor · 2 × 30 s · langsam
*Stufe 3.2–3.5.*
- Dieselben sieben Halte wie A6, jetzt nah.

**B7 · `p5.eight.flip`** · Prio 1 · Noor · 2 × 20 s · Lehrtempo
*Stufe 5.2: Die verdrehte Schlaufe schlägt eine Acht und steht aus dem Ring; Plattdrücken hilft nicht.*
- **Drall vorbereiten (ohne Aufnahme):** Wickle das Kabel nur mit Über-Schlaufen und zieh es mit festgehaltenen Enden wieder auseinander. Oder dreh einen Stecker 3–4-mal um sich selbst, während das andere Ende unter einem Gewicht liegt. Dann ein paar Schlaufen wickeln, bis eine zur Acht will.
- **Fehler mit Absicht:** Leg die Schlaufe trotzdem und lass los: Sie schlägt eine Acht. Drück sie flach, sie springt zurück. Kurz anschauen, noch nicht beheben.
- **Tracking:** Die Acht nicht hinter der Hand verstecken.

**B8 · `p5.eight.roll`** · Prio 1 · Noor · 2 × 15 s · langsam
*Stufe 5.2, Weg 1: zwischen den Fingern zurückrollen.*
- **Ablauf:** Die Schlaufe will zur Acht. Roll das Kabel zwischen Daumen und Zeigefinger zurück, bis sie flach fällt.
- **Tracking:** Die Bewegung ist klein. Mach sie wie immer; wenn es geht, sieht die Kinect Daumen und Zeigefinger dabei von vorn.

**B9 · `p5.eight.reverse`** · Prio 2 · Noor · 2 × 15 s · Lehrtempo
*Stufe 5.2, Weg 2: diese Schlaufe andersherum legen.*
- **Ablauf:** Die Schlaufe will zur Acht, also legst du sie andersherum; zweimal dieselbe Sorte ist dann okay. Sie liegt flach.
- Danach den Drall herauslassen.

**B10 · `p5.size.more`** · Prio 2 · Noor · 2 × 12 s · Lehrtempo
*Stufe 5.3 (POV): Eine Schlaufe beult sich, 5 cm mehr Kabel, sie liegt rund.*
- Die Beule darf gespielt sein: Leg die Schlaufe etwas zu klein und gib dann nach.

**B11 · `p5.size.giveway`** · Prio 3 · Noor · 1 × 20 s · Lehrtempo
*Stufe 5.3: „Will sie andersherum? Gib nach und gleich es bald aus.“*
- Eine Schlaufe will andersherum, du gibst nach und gleichst bei der nächsten wieder aus, so, wie du es bei der Arbeit machst.

**B12 · `p4.prep`** · Prio 1 · Jonas · 2 × 20 s · Lehrtempo
*Stufe 4.1: Klettband einmal vorbereiten.*
- **Start:** XLR ohne Band. Nimm das Band vorher ab oder nimm ein zweites Kabel.
- **Ablauf:** Band 10–30 cm vor dem Stecker mit den Stiften um das Kabel legen, das lange Ende durch den eigenen Schlitz fädeln, festziehen. Zugprobe: Es rutscht nicht.
- **Tracking:** Hände vor dem Bauch, den Stecker zur Kinect gedreht, das Band nicht hinter den Fingern. (Hier darfst du die Hände höher nehmen als beim Wickeln.)

**B13 · `p4.start.end`** · Prio 3 · Jonas · 1 × 12 s · Lehrtempo
*Stufe 4.3: Mit diesem Ende fängst du an.*
- **Ablauf:** Nimm das Ende mit dem Band und wickle zwei Schlaufen: Das Band ist oben in deiner Hand.
- Danach ohne Aufnahme fertig wickeln: Der Ring ist der Start für B14.

**B14 · `p4.close`** · Prio 1 · Jonas · 3 × 15 s · Lehrtempo
*Stufe 4.4, auch 1.2 und 3.8: Zumachen.*
- **Ablauf:** Ring in der linken Hand. Das Band oben, wo deine Hand war, um den ganzen Ring legen und schließen, fest, aber nicht quetschen.
- **Ende:** Den Ring 2 s zur Kinect zeigen, beide Stecker außen.

**B15 · `p4.close.tight`** · Prio 2 · Jonas · 1 × 12 s
*Stufe 4.4 ✗ zu fest.*
- **Fehler mit Absicht:** Das Band kräftig ziehen, dann schließen. Die Delle im Mantel zeigt die Animation; quäl das Kabel nicht.

**B16 · `p4.close.loose`** · Prio 2 · Jonas · 1 × 12 s
*Stufe 4.4 ✗ zu locker.*
- **Fehler mit Absicht:** Das Band ganz locker schließen, den Ring am Band anheben und leicht schütteln, bis Schlaufen herausrutschen.

**B17 · `p4.two.straps`** · Prio 3 · Jonas · 1 × 15 s
*Stufe 4.5: Lange oder schwere Ringe bekommen zwei Bänder gegenüber.*
- Langer Ring (XLR 10–15 m oder dickes Kabel). Halt ihn, wie du es bei der Arbeit tust.

**B18 · `p4.wrong.ziptie`** · Prio 3 · Jonas · 1 × 12 s
*Stufe 4.6 ✗ Kabelbinder aus Plastik („quetscht“).*
- **Fehler mit Absicht:** Kabelbinder um den Ring legen und zuziehen, aber nur leicht.
- Danach ohne Aufnahme vorsichtig aufschneiden, nicht ins Kabel.

**B19 · `p4.wrong.knot`** · Prio 2 · Jonas · 1 × 15 s
*Stufe 4.6 ✗ das Kabel um sich selbst knoten („knickt“).*
- **Fehler mit Absicht:** Ende um den eigenen Ring knoten, wie man es leider oft sieht. Nicht fest zuziehen, zeigen, wieder lösen.

**B20 · `p4.wrong.wrapped`** · Prio 2 · Jonas · 2 × 12 s
*Stufe 4.2 ✗ Ein Band, das nur um den Ring gewickelt war, fällt beim Öffnen herunter.*
- **Start:** Ring mit einem losen Band, das nur drumgewickelt ist.
- **Fehler mit Absicht:** Öffnen, das Band fällt herunter (fallen lassen, nicht werfen), du schaust ihm hinterher.

**B21 · `p5.knots.pull`** · Prio 1 · Noor · 2 × 20 s · Lehrtempo
*Stufe 5.1: das Ende durch den Ring.*
- **Start:** Ein Über-unter-Ring in der linken Hand, das Band offen, ein Ende durch die Mitte gesteckt.
- **Fehler mit Absicht:** Zieh das Ende langsam heraus: In jeder zweiten Schlaufe zieht sich ein Knoten zu. Nach dem zweiten oder dritten Knoten: Stopp.
- **Vorsicht:** Langsam ziehen, die Knoten nicht festziehen. Am besten ein Kabel, das etwas aushält.

**B22 · `p5.knots.fix`** · Prio 1 · Noor · 2 × 20 s · Lehrtempo
*Stufe 5.1: Ende zurück durch die Mitte, nicht reißen; dann richtig.*
- Direkt nach B21: Das Ende geht zurück durch die Mitte, die Knoten gehen auf. Dann beide Enden außen nehmen und auseinanderziehen.

**B23 · `p5.elbow.wrong`** · Prio 1 · Noor · 2 × 15 s · Arbeitstempo
*Stufe 5.4 „So nicht.“*
- **Fehler mit Absicht:** Das Kabel um Hand und Ellenbogen wickeln, vier Wicklungen, normales Tempo. Dann abstreifen und hochhalten.
- **Tracking:** Der linke Unterarm ist vor dem Körper angewinkelt, der Ellenbogen nicht hinter dem Körper.
- Danach den Drall herauslassen. Das „So.“ ist A5.

**B24 · `p2.oneloop`** · Prio 2 · Teo · 2 × 12 s · langsam
*Stufe 2.2: erst eine Schlaufe in Zeitlupe, dann ein Paar über/unter.*
- **Take 1** mit einer einzigen Über-Schlaufe, **Take 2** mit einem Paar (erst über, dann unter).
- **Ablauf:** Je ein Ende in einer Hand. Ganz langsam auseinanderziehen, bis das Kabel fast gerade ist. Die Enden dabei nie in der Hand drehen.
- Mit Fähnchen auf dem Kabel sieht man die Drehung auch in der Aufnahme.

**B25 · `p2.teo.coil`** und **B26 · `p2.teo.pull`**: abwechselnd aufnehmen (wickeln, ausziehen, wickeln, ausziehen). Vor jedem neuen Wickeln den Drall herauslassen.

- **B25 · `p2.teo.coil`** · Prio 2 · Teo · 2 × 15 s · Arbeitstempo
  *Stufe 2.1, Rückblick: Teos Ring ist immer gleich gewickelt.*
  - **Fehler mit Absicht:** kurzes Kabel, kleine Schlaufen (9–10 cm), nur Über-Schlaufen, die Hand wird nie umgedreht. Sechs Schlaufen, dann halten.
- **B26 · `p2.teo.pull`** · Prio 1 · Teo · 2 × 21 s · Lehrtempo, mit zeitgesteuerten Ansagen
  *Stufe 2.3–2.5.*
  - **Start:** Band offen, je ein Ende in einer Hand, der Ring hängt dazwischen.
  - **Ablauf** (nach den Ansagen):
    - bei 2 s langsam auseinanderziehen;
    - bei 6 s fast gespannt halten: Das Kabel ist fast gerade, bei 1,5 m Kabel sind die Hände etwa 1,2–1,4 m auseinander, auf Brusthöhe (weiter nicht, sonst sind sie aus dem Bild);
    - bei 9 s gehen die Hände 40 cm aufeinander zu;
    - bei 12 s halten und das Kabel anschauen;
    - bei 15 s vorsichtig wieder ziehen;
    - bei 17 s Stopp, locker lassen.
  - **Fehler mit Absicht:** das Wiederziehen, bei dem sich der Kringel zum Knick zuzieht. Nur so weit ziehen, bis der Kringel klein wird, dann sofort locker lassen: Ein echter Knick schadet den Adern. Nimm ein altes Kabel.
  - **Tracking:** Die Enden nie in der Hand drehen.

**B27 · `p2.robin.coil`** und **B28 · `p2.robin.pull`**: wieder abwechselnd. Vorher den Drall aus Teos Takes herauslassen.

- **B27 · `p2.robin.coil`** · Prio 2 · Robin · 2 × 15 s · Arbeitstempo
  *Stufe 2.1, Rückblick: Robins Ring ist abwechselnd gewickelt.*
  - Kurzes Kabel, kleine Schlaufen, abwechselnd über und unter, sechs Schlaufen.
- **B28 · `p2.robin.pull`** · Prio 1 · Robin · 2 × 21 s · Lehrtempo, mit zeitgesteuerten Ansagen
  *Stufe 2.3–2.6.*
  - Dieselben Zeiten und derselbe Abstand der Hände wie B26, nur ohne Wiederziehen: Bei 15 s weiter halten, bei 17 s locker lassen. Das Kabel hängt in einem ruhigen Bogen.

---

## Aufbau T · Tisch (sitzend; die Kinect bleibt wie in B)

Ilse am FOH-Platz und am Versuchstisch. Die Kinect bewegst du nicht, du stellst nur Tisch und Stuhl davor.

```
Draufsicht: Du sitzt und schaust nach oben, zur Kinect.

              [K]  Kinect: wie in B, nicht bewegen
               |
               |  0,7 m
         +-----------+
         |   Tisch   |  <- rechte Kante (von dir aus):
         |  ≈ 75 cm  |     hier hängen Kabel über
         +-----------+
               S   Stuhl ohne Armlehnen, 1,6 m vor dem Stativ;
                   du sitzt, Gesicht zur Kinect
```

- **Tisch:** Die vordere Kante steht etwa 0,7 m vor dem Stativ, der Stuhl 1,6 m davor. Die Kinect sieht von vorn oben auf die Tischplatte und deine Hände.
- **Tischplatte:** hell und matt, sonst ein helles Tuch.
- Was über eine Kante hängen soll, kommt über die **rechte Seitenkante** (von dir aus), nicht über die vordere: Die sieht die Kinect nicht.
- Sitzen wie unter [Die Rollen](#die-rollen) beschrieben: aufrecht, Füße nebeneinander, nicht aufstehen, Hände nicht seitlich unter die Sitzfläche.
- Arbeite über der Tischplatte, nicht davor, und beug dich nicht über deine Hände.

**T1–T3 · Kalibrierung** (`cal.T.empty`, `cal.T.cable`, `cal.T.body`), Prio 1, ≈ 2 min
- Tisch und Stuhl leer;
- Kabel gerade quer über die Tischmitte;
- sitzend: Arme seitlich waagrecht, Hände auf und zu, Handflächen hoch und runter.

**T4 · `p1.short.pull`** · Prio 1 · Ilse · 3 × 15 s · Lehrtempo
*Stufe 1.3: kurzes Kabel.*
- **Start:** Ein kurzer Über-unter-Ring (Ladekabel) mit geschlossenem Klettband liegt vor dir auf dem Tisch.
- **Ablauf:** Klettband auf, den Ring hängen lassen. Beide Enden nehmen (beide außen) und die Hände langsam auseinanderziehen, auf Brusthöhe über dem Tisch. Das Kabel hängt ruhig.
- Zwischen den Takes den Ring ohne Aufnahme neu wickeln.

**T5 · `t.ilse.foh`** · Prio 3 · Ilse · 2 × 12 s · Arbeitstempo
*Titel: Ilse sitzt am FOH-Platz.*
- Ein gedachtes Pult auf dem Tisch: Fader schieben, Knöpfe drehen, ab und zu nach vorn zur Bühne schauen. Nach der Show, ruhig.

**T6 · `p7.stiff.edge`** · Prio 2 · Ilse · 1 × 20 s · Lehrtempo
*Stufe 7.1, Steifigkeit.*
- **Ablauf:**
  - Drei Kabel (Ladekabel, XLR, dickes Kabel) nebeneinander auf den Tisch legen, je 30 cm über die rechte Kante; ein Buch hält die anderen Enden.
  - An jede Spitze eine Wäscheklammer.
  - Hände weg und anschauen.
- Prüf in der Vorschau, dass die drei Spitzen im Bild sind; sonst rück den Tisch etwas nach links.
- Das ist zugleich ein echter Versuch für die Simulation. Das Ladekabel ist für die Kinect nur etwa 1 Pixel dick: Ein Handyfoto von vorn mit einem Maßband daneben (nur die Kabel, ohne dich) hilft zusätzlich.

**T7 · `p7.stiff.twist`** · Prio 1 · Ilse · 2 × 20 s · langsam
*Stufe 7.1: Ein eingespanntes XLR wird verdreht, bis eine Schlaufe herausspringt.*
- **Start:** Ein Ende des kurzen XLR ist am Tisch festgeklemmt (Schraubzwinge oder Gaffa). Das andere hältst du, 60–80 cm weiter, quer über den Tisch, leicht gespannt.
- **Ablauf:** Den Stecker langsam drehen, Umdrehung für Umdrehung, bis eine Schlaufe herausspringt. Umgreifen ist erlaubt, der Stecker bleibt dabei an derselben Stelle.
- Zähl still mit, nach wie vielen Umdrehungen die Schlaufe kommt, und schreib die Zahl danach auf. Sie ist für die Simulation wertvoll.

**T8 · `p7.tension`** · Prio 1 · Ilse · 2 × 20 s · Lehrtempo
*Stufe 7.3: Zug versteckt den Drall.*
- **Drall vorbereiten:** ein Ende 3–4-mal um sich selbst drehen, das andere festhalten.
- **Ablauf:** Das verdrehte Kabel zwischen beiden Händen spannen: Es bleibt gerade. Locker lassen: Ein Kringel springt heraus. Ein Ende loslassen: Es dreht sich aus.

**T9 · `p7.memory.drop`** · Prio 2 · Ilse · 2 × 15 s · Lehrtempo
*Stufe 7.2, Formgedächtnis.*
- **Take 1** mit dem alten Kabel, das lange aufgerollt lag, **Take 2** mit einem gerade gelagerten.
- **Ablauf:** Etwa einen Meter vom Ring abziehen, hochhalten und aus etwa 30 cm Höhe auf den Tisch fallen lassen. Anschauen.

**T10 · `p7.ring.eight`** · Prio 2 · Ilse · 2 × 15 s · langsam
*Stufe 7.5: Zu viel Drall im Ring.*
- **Start:** Ein kurzes XLR, in sich selbst gesteckt (Stecker in Buchse): ein geschlossener Ring.
- **Ablauf:** Mit beiden Händen über dem Tisch halten, eine Hand langsam drehen, bis der Ring zur Acht umklappt.

**T11 · `p7.ribbon.pull`** · Prio 2 · Ilse · 2 × 20 s · langsam
*Stufe 7.4: das Band.*
- **Take 1** mit vier Über-Schlaufen, **Take 2** abwechselnd über und unter.
- **Ablauf:** Das Band mit vier Schlaufen liegt auf dem Tisch. Deine Hände sind die Klemmen: Drück beide Enden flach auf die Platte, sie dürfen sich nicht drehen. Langsam auseinanderschieben, dann wieder zusammenschieben.

**T12 · `p7.ribbon.release`** · Prio 3 · Ilse · 1 × 12 s · Lehrtempo
*Stufe 7.4: Ilse löst eine Klemme.*
- Direkt nach T11, Take 1: Das Band ist gespannt. Ein Ende anheben und loslassen, das Band dreht sich frei.

---

## Aufbau C · Hoch (von vorn oben, für Bodenarbeit)

Für alles am Boden, und einmal das Wickeln von oben: Daraus wird die Ich-Perspektive.

```
Draufsicht: Du schaust nach oben, zur Kinect.

              [K]  Kinect auf hohem Stativ: 2,10 m, 35° nach unten
               |
               |  1,1 m
         + - - - - - - - +
         |               |
         |    C-nah      |   Bodenfläche etwa 2 m × 1,1 m,
         |   (1,4 m)     |   Ecken mit Klebeband
         |               |
         + - - - - - - - +
               C-fern (2,2 m): du, Gesicht zur Kinect

Seitenansicht:

    [K]
     |\
     | \  35°                    o
     |  \                       /|\   du auf C-fern
     |   \                       |
     |    \                     / \
   ==+=========[ Bodenfläche  ]====+=====
     0         1,1 m             2,2 m
```

- **Kinect:** 2,10 m hoch, 35° nach unten, genau vor dir. Marke **C-nah** 1,4 m vor dem Stativ (Hände von oben, fast wie in deinem Video A), Marke **C-fern** 2,2 m davor (Bodenarbeit). Auch auf C-fern bist du stehend bis etwa 1,9 m im Bild.
- Die **Bodenfläche** liegt 1,1–2,2 m vor dem Stativ und ist etwa 2 m breit. Was am Boden passiert, bleibt auf ihr.
- **Sicherheit:** Licht- oder Mikrofonstativ mit Sandsack, oder die Kinect oben auf einem Regal, mit Gaffa gesichert. Die Kinect steht vor dir, nie über dir.

**C1–C3 · Kalibrierung** (`cal.C.empty`, `cal.C.cable`, `cal.C.body`), Prio 1, ≈ 2 min
- leere Fläche;
- XLR gerade quer über die Fläche;
- Körper auf C-nah.

**C4 · `p1.coil.top`** · Prio 2 · Noor · 2 × 30 s · Lehrtempo · Marke C-nah
*Stufe 1.1 und 3, von oben.*
- Dieselbe Bewegung wie A4, Hände auf Hüfthöhe wie immer, der Kabelvorrat rechts von dir. Am Ende Klettband zu und den Ring ruhig halten.

**C5 · `p5.size.sink`** · Prio 2 · Noor · 2 × 20 s · langsam · Marke C-fern
*Stufe 5.3: Das Kabel sinkt langsam auf den Boden und legt sich in Bögen.*
- **Kabel:** XLR 5 m ohne Drall.
- **Ablauf:** Das Kabel auf Brusthöhe durch die locker geschlossene rechte Hand nach unten gleiten lassen, die linke führt nach. Es legt sich vor dir auf der Fläche in Bögen. Zum Schluss mit den Händen die Größe eines Bogens zeigen.
- Echter Versuch: Wie groß die Bögen werden, braucht die Simulation.

**C6 · `p5.knots.cause`** · Prio 3 · Noor · 1 × 12 s · Arbeitstempo · Marke C-fern
*Stufe 5.1, die Ursache.*
- **Start:** Die Kiste steht etwa 1,5 m vor dem Stativ.
- **Fehler mit Absicht:** Den Ring mit offenem Band in die Kiste legen. Dabei fällt ein Ende durch die Mitte; du darfst es mit der Hand durchstecken. Dann den Ring am Ende wieder herausheben.

**C7 · `p6.floor.eights`** · Prio 1 · Mai · 2 × 30 s · Arbeitstempo · Marke C-fern
*Stufe 6.2: sehr dickes Kabel auf dem Boden in Achten.*
- **Kabel:** das dickste, mindestens 15 m, oder Gartenschlauch 3/4″, 25 m.
- **Ablauf:** In Achten auf den Boden legen, eine Schlaufe rechtsherum, eine linksherum, große Bögen (mindestens 60 cm). Die Acht liegt quer, ihre lange Seite von links nach rechts: So passt sie auf die Fläche. Arbeite so, wie du es bei der Arbeit machst (bücken, knien oder im Stehen führen). Nach 30 s aufhören, auch wenn das Kabel nicht fertig ist.
- **Tracking:** Der Stapel bleibt auf der Fläche, du bewegst dich an ihrem Rand.

**C8 · `p6.floor.straps`** · Prio 2 · Mai · 1 × 20 s · Arbeitstempo
*Stufe 6.3: zwei Klettbänder um den Stapel.*
- Knie dich auf die Seite des Stapels, die von der Kinect weg zeigt, damit dein Körper ihn nicht verdeckt. Zwei Bänder gegenüber anlegen, fest, aber nicht quetschen.

**C9 · `p6.floor.unroll`** · Prio 2 · Mai · 1 × 20 s · Arbeitstempo
*Stufe 6.3: Abrollen.*
- Bänder auf, oben abziehen, eine Schlaufe nach der anderen, dabei langsam seitlich weggehen: quer zur Kinect, nicht auf sie zu.

---

## Aufbau D · Seite (weit, für Wurf, Heben und Gehen)

Hier zählt der ganze Körper. Das Kabel ist auf 3,2 m kaum zu sehen, beim Wurf rechnet es die Simulation.

```
Draufsicht: Die Bahn ist eine Klebeband-Linie quer vor der Kinect.

   D-Start          D-Mitte                D-Ziel
     P  ---------------+---------------------- [S]  Mikrofonstativ
     du, Wurf ->    Bahn 3,4 m
       1,4 m links     ^      2,0 m rechts
                       |
                       |  3,2 m
                       |
                      [K]  Kinect: 1,00 m hoch, 5° nach unten,
                           schaut quer auf die Bahn
```

- **Kinect:** 1,00 m hoch, 5° nach unten, 3,2 m vor D-Mitte.
- **Bahn:** 3,4 m lang, von D-Start (1,4 m links von D-Mitte, von der Kinect aus) bis D-Ziel (2,0 m rechts). Stehst du auf D-Start und schaust die Bahn entlang zum Ziel, ist die Kinect auf deiner rechten Seite. D-Start liegt mit Absicht nicht weiter außen: Beim Ausholen geht die Wurfhand ein Stück hinter dich, und so bleibt sie im Bild.
- **Bild:** etwa 4,5 m breit; ein Mensch ist etwa 200 Pixel hoch.
- **Sicherheit:** Nie Richtung Kinect, Notebook oder Fenster werfen. Die Bahn ist frei, nichts Zerbrechliches dahinter.
- **Reicht der Raum nicht:** Kinect 2,6 m vor der Bahn (Bild 3,7 m breit), D-Start 1,1 m links, D-Ziel 1,6 m rechts von D-Mitte. Oder dieses Setup in einem großen Raum.

**D1–D3 · Kalibrierung** (`cal.D.empty`, `cal.D.cable`, `cal.D.body`), Prio 1, ≈ 2 min
- leer, mit dem Stativ auf D-Ziel;
- langes Kabel gerade von D-Start bis D-Ziel;
- Körper auf D-Mitte: Gesicht zur Kinect (T-Pose, Hände auf und zu), dann je 2–3 s seitlich mit der Kinect rechts und links.

**D4 · `p1.throw.only`** · Prio 1 · Kofi · 3 × 15 s · Arbeitstempo · Marke D-Start
*Stufe 1.4, nur der Wurf.*
- **Start:** Der lange Ring liegt schon wurfbereit in den Händen, das Band offen.
- **Ablauf:**
  - Das Ende fest, 2–3 Schlaufen locker in der Hand.
  - Den Ring um 90° gedreht, so dass du den Kreis siehst.
  - Von unten Richtung Stativ werfen. Die Schlaufen in der Hand nachlaufen lassen, den Rest nachziehen.
- Wirf so, wie du es bei der Arbeit tust.
- **Tracking:** Wirfst du mit rechts, ist die Kinect auf deiner rechten Seite, und der Wurfarm ist frei zu sehen. Die linke Hand mit dem Ende ist von der Kinect aus dann hinter deinem Körper; das ist in Ordnung, die Auswertung ergänzt sie. Filmst du nebenher mit dem Handy, dann hier von der anderen Seite.

**D5 · `p1.throw`** · Prio 1 · Kofi · 4 × 25 s · Arbeitstempo · Marke D-Start
*Stufe 1.4, komplett.*
- **Start:** Der Ring liegt vor deinen Füßen, das Band zu.
- **Ablauf:** Aufnehmen, Klettband auf, das Ende festhalten, werfen, den Rest nachziehen.
- Zwischen den Takes ohne Aufnahme neu wickeln.

**Heben zu zweit:** entweder D6 und D7 (allein) oder D8 (zu zweit). Alle drei haben dieselben zeitgesteuerten Ansagen:

| Zeit | Ansage |
|---|---|
| 2 s | In die Hocke, greifen |
| 5 s | Mai zeigt: 3 |
| 6 s | 2 |
| 7 s | 1 |
| 8 s | Hoch |
| 11 s | Drei kleine Schritte |
| 15 s | Absetzen |
| 18 s | Endpose |

Das Handzeichen ist ein Vorschlag (siehe offene Fragen): Mai zählt mit der rechten Hand auf Schulterhöhe, zu Ada hin, drei, zwei, eins Finger, dann gehen beide Hände an die Last.

**D6 · `p6.lift.mai`** · Prio 1, nur allein · Mai · 2 × 20 s · Arbeitstempo
*Stufe 6.4.*
- **Start:** Die Kiste (≈ 15 kg) steht vor dir. Du stehst 0,6 m vor D-Mitte in Richtung D-Start, das Gesicht Richtung D-Ziel, wo Ada stünde. Die Kinect ist rechts von dir.
- **Ablauf:** Hocke, Blick zu Ada, Handzeichen, auf „Hoch“ heben, drei kleine Schritte vorwärts, absetzen. Rücken gerade, die Last nah am Körper.

**D7 · `p6.lift.ada`** · Prio 1, nur allein · Ada · 2 × 20 s · Arbeitstempo
*Stufe 6.4.*
- **Start:** Die Kiste steht vor dir. Du stehst 0,6 m hinter D-Mitte in Richtung D-Ziel, das Gesicht Richtung D-Start. Die Kinect ist links von dir.
- **Ablauf:** Hocke, greifen, beim Zählen zu Mai schauen, auf „Hoch“ mitheben, drei kleine Schritte rückwärts, absetzen.
- **Vorsicht:** Prüf vorher, dass hinter dir nichts auf dem Boden liegt.

**D8 · `p6.lift.pair`** · Prio 1, nur zu zweit · Mai und Ada · 3 × 20 s · Arbeitstempo
*Stufe 6.4.*
- **Start:** Ihr steht euch gegenüber, die Last (≈ 25–30 kg, z. B. zwei zusammengebundene Getränkekisten) liegt auf D-Mitte. Die Kinect sieht euch beide genau von der Seite, und niemand verdeckt die andere Person. Du spielst Mai.
- **Ablauf:** wie D6 und D7, gemeinsam.

**D9 · `p5.eight.layout`** · Prio 3 · Noor · 1 × 25 s · Arbeitstempo · Marke D-Start
*Stufe 5.2, Weg 4: „Viele Achten? Ganz auslegen, neu wickeln.“*
- **Start:** ein unordentlicher Ring mit Achten.
- **Ablauf:** Leg das Ende auf D-Start auf den Boden und geh mit dem Ring die Bahn entlang Richtung D-Ziel. Schlaufe für Schlaufe fällt ab, das Kabel liegt in einem großen Bogen. Am Ende dreh dich zur Kinect, nimm das Ende auf und wickle die ersten zwei Schlaufen neu.

**D10 · `t.kofi.walk`** · Prio 2 · Kofi · 2 × 10 s · Arbeitstempo
*Titel: Kofi geht mit einem Kabel quer durchs Bild.*
- Den Ring über der Schulter, ruhig wie nach der Show, auf der Linie. Take 1 von D-Start nach D-Ziel, Take 2 zurück.

**D11 · `t.robin.stand`** · Prio 2 · Robin · 2 × 10 s · Arbeitstempo
*Titel: Robin trägt ein Mikrofonstativ.*
- Das Stativ tragen, wie du es immer trägst, nicht zwischen dir und der Kinect. Take 1 hin, Take 2 zurück.

**D12 · `t.stack`** · Prio 3 · Mai / Ada · 2 × 12 s · Arbeitstempo
*Titel: Mai und Ada stapeln Kabel in eine Kiste.*
- Die Kiste steht auf D-Mitte, 3–4 Ringe liegen am Boden. Ruhig einen nach dem anderen in die Kiste legen.
- Take 1 als Mai links neben der Kiste (von der Kinect aus), Take 2 als Ada rechts davon.

**D13 · `t.jonas.case`** · Prio 3 · Jonas · 2 × 12 s · Arbeitstempo
*Titel: Jonas schließt ein Case.*
- Das Case liegt flach zwischen dir und der Kinect, du schaust zur Kinect. Deckel zuklappen, Verschlüsse schließen, kurz am Griff anheben.

---

## Was danach passiert

1. **Die Aufnahmen bleiben bei dir** in `recordings/mocap/` im Hauptordner. Dieser Ordner ist von git ausgeschlossen.
2. **Das Auswerteskript** (wird gerade gebaut) geht jeden Take durch:
   - Es findet das Klatschen als Nullpunkt.
   - Auf jedem Infrarotbild sucht YOLO11x-pose dich. ViTPose++ huge und Sapiens2 1b bestimmen deine Gelenke, Sapiens auch Finger und Füße (die Modelle aus `pose-training/`). Bei 512 × 424 Pixeln sind die Finger nur grob zu erkennen; für Griff und Rollen hilft ein Handyvideo nebenher (siehe offene Fragen).
   - Mit dem Tiefenbild wird daraus 3D in Metern, geglättet und mit gefüllten Lücken.
   - Wo das Kabel zu sehen ist, wird seine Lage als Führung für die Simulation gespeichert.
3. **Ergebnis:** je Take eine Datei `mocap/takes/<shot>_t<take>.json` mit Gelenkpositionen für jedes Bild (30 pro Sekunde), einer Sicherheit je Gelenk und dem Zeitpunkt des Klatschens. Darin sind keine Bilder und keine Tiefendaten. **Nur diese Dateien dürfen ins Repository, und nur, wenn du zustimmst** (siehe [Datenschutz](#datenschutz)).
4. **Auswahl:** Pro Shot suchst du (oder wir mit einem Vorschlag) den besten Take aus.
5. **Animation:**
   - Die Bewegung wird auf die Figur übertragen: Noor, Kofi, Ilse und alle anderen.
   - Die inverse Kinematik hält dabei den Griff am Kabel.
   - Die Kabelsimulation folgt deinen echten Händen.
   - Daraus entstehen zuerst Roh-Animationen und Storyboards, die dann verfeinert werden.
6. **Kontrollvideos** (Skelett über dem Infrarotbild) zeigen dich. Sie bleiben ebenfalls lokal in `recordings/`.
7. Wenn alles ausgewertet ist, kannst du die `.k2rec` löschen oder auf eine externe Platte verschieben.

## Datenschutz

- **Die Aufnahmen zeigen dich und deinen Raum:** Tiefe und Infrarot, im Infrarotbild ist dein Gesicht erkennbar. Sie bleiben in `recordings/` auf deinem Rechner.
  - Sie werden **nie committet**. Hochgeladen werden sie ohne dein ausdrückliches Ja nirgendwohin: nicht in die Cloud, nicht in einen Chat, nicht zu Colab oder Kaggle.
- **Auswertung:** Sie läuft standardmäßig lokal. Die großen Modelle sind auf dem Notebook langsam. Soll sie auf einer gemieteten GPU laufen, müssten die Infrarotbilder dafür hochgeladen werden. Das passiert nur, wenn du ausdrücklich Ja sagst, nur privat, und die Bilder werden danach gelöscht.
- **Ins Repository kommen höchstens die Gelenkdaten** in `mocap/takes/`: Zahlen, keine Bilder. Sie sind trotzdem deine Bewegungen; man kann daraus zum Beispiel deine Körpermaße ablesen. Darum kommen sie nur mit deinem Okay hinein, sonst bleiben auch sie lokal.
- **Zweite Person:**
  - Erklär ihr vorher, was aufgenommen wird und was damit passiert, und frag, ob sie einverstanden ist.
  - Sie kann jederzeit abbrechen und ihre Takes löschen lassen.
  - Ihre Gelenkdaten werden nur mit ihrem Okay committet.
- **Niemand sonst im Bild:** Mitbewohnende, Kinder, Besuch und Haustiere bleiben draußen.
- Ein Handyvideo nebenher (siehe offene Fragen) gilt genauso: Es bleibt lokal und wird nie hochgeladen.

## Noch offen

1. **Kabel:** Welche hast du?
   - ein langes XLR (10–15 m)?
   - Starkstrom 5G2,5, 15 m, oder eine lange Verlängerung?
   - Kommst du für 30 min an ein 5G16 oder ein anderes sehr dickes Kabel, oder nehmen wir einen Gartenschlauch?
   - ein altes Kabel, das Knoten und Knick aushalten darf?
2. **Raum:** Hast du für Aufbau D etwa 5 × 4,5 m frei, oder wo könntest du werfen?
3. **Hohes Stativ** für Aufbau C (2,1 m), zum Beispiel ein Lichtstativ mit Adapter?
4. **Zweite Person** fürs Heben, oder nimmst du beide Rollen allein auf?
5. **Handzeichen beim Heben:** Was nutzt ihr bei der Arbeit? Vorschlag: drei, zwei, eins mit den Fingern.
6. **Wurf:** Wirfst du mit rechts, und hält die linke Hand das Ende?
7. **Speicher:** Sind auf dem Notebook etwa 70 GB frei, oder gibt es eine externe Platte?
8. **Auswertung:** lokal oder auf einer gemieteten GPU (nur mit Upload der Infrarotbilder)? Lokal ist grob geschätzt eine Sache von Tagen statt Stunden: Die großen Modelle brauchen auf dem Notebook eher Sekunden je Bild, und alle Takes zusammen sind etwa 80 000 Bilder. Lokal würden wir darum nur den besten Take je Shot mit den großen Modellen auswerten.
9. **Handy als zweite Kamera:** Für die Finger und für das Kabel selbst ist die Kinect zu grob (Kabel 1–2 Pixel). Ein Handyvideo nebenher, schräg von der anderen Seite, gäbe Farbe, die Finger und die Form des Kabels; das Klatschen synchronisiert beide. Am meisten bringt es bei Aufbau B. Freiwillig, und es bleibt lokal.
10. **Linkshändig wickeln** (A12): Geht das bei dir flüssig genug?
11. **Körpergröße:** Wie groß bist du? Die Aufbauten sind für bis etwa 1,80 m gerechnet. Bist du größer, stellen wir die Kinect in A, B und C etwas höher.
12. **Gelenkdaten ins Repository:** Dürfen die Gelenkdaten aus `mocap/takes/` (Zahlen, keine Bilder) committet werden, oder bleiben sie lokal?
