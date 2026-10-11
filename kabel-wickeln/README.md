# Kabel richtig aufwickeln: die Over-Under-Methode

Eine Erklär-Animation mit Motion Canvas, etwa 3:20 min, ohne Ton. Sie beginnt mit dem Überblick und wird Stufe für Stufe genauer. Nach jeder Stufe kommt eine Karte „Verstanden? Dann kannst du hier aufhören.“ Jede Stufe ist ein Kapitel im mp4, VLC und andere Player springen also direkt dorthin.

| Stufe | Was | Länge |
|---|---|---|
| Titel | Ein Kabel legt sich in Schlaufen: über, unter, über … | 0:09 |
| 1 · Überblick | Schlaufen in die linke Hand, abwechselnd über und unter. Ring werfen, das Kabel liegt glatt. | 0:31 |
| 2 · Warum | Jede Schlaufe dreht das Kabel einmal um sich selbst. Immer gleich gewickelt: 6 Drehungen, Kringel beim Auslegen. Über-unter: 0. Der gelbe Streifen auf dem Kabel zeigt die Drehung. | 0:27 |
| 3 · Schritt für Schritt | Sechs Schritte, langsam: Ende in die linke Hand, greifen, Über-Schlaufe (vorwärts rollen), Unter-Schlaufe (Hand umdrehen, zurückdrehen), abwechselnd, Klettband. Eine Lupe zeigt, wie das Kabel über bzw. unter sich selbst läuft. | 0:50 |
| 4 · Feinheiten | Nie ein Ende durch den Ring ziehen (sonst Knoten in jeder zweiten Schlaufe). Will die Schlaufe zur Acht: falsch herum gedreht. Nicht um Hand und Ellenbogen wickeln. Dicke Kabel in Achten auf den Boden legen. Gleich große Schlaufen, Klettband, Linkshänder spiegeln. | 0:51 |
| 5 · Physik | Ein Band mit einer Schlaufe: auseinandergezogen wird die Schlaufe zu einer ganzen Drehung, die Unter-Schlaufe zur Gegendrehung (Satz von Călugăreanu). 1+1+1+1+1+1 = 6, 1−1+1−1+1−1 = 0. | 0:33 |

## Bedienung

```bash
cd kabel-wickeln
npm install
npm start                      # Editor: http://localhost:9000 (Vorschau, Zeitleiste, Render-Knopf)
npm run render -- --fps 30     # ganzes Video → output/kabel-wickeln.mp4 (1080p, 30 fps, mit Kapiteln)
npm run render                 # dasselbe mit 60 fps (dauert doppelt so lang)
npm run stills -- 12 48.5 130  # Einzelbilder (Sekunden) → output/stills/
```

`render` und `stills` starten Vite und einen unsichtbaren Chrome/Edge (`tools/render.mjs`, Browser per `CHROME_PATH` wählbar). Danach trägt `render` die Kapitel aus `src/lib/chapters.ts` mit ffmpeg ins mp4 ein.

## Aufbau

| Datei | Was |
|---|---|
| `src/scenes/s0-titel.tsx … s5-physik.tsx` | die Szenen, eine pro Stufe |
| `src/lib/chapters.ts` | die Stufen: Namen in der Leiste oben, auf den Karten und als Kapitel im mp4 |
| `src/lib/geom.ts` | Kabelformen als 3D-Linien (x, y, z: z entscheidet nur, was an Kreuzungen oben liegt), gleichmäßig neu abgetastet |
| `src/lib/coil.ts` | der Ring in der Hand (`handCoil`), die auseinandergezogenen Schlaufen (`curlRow`), das Abrollen (`rollOut`), die Drehung beim Geradeziehen (`rowTwist`), Kringel (`kinkLine`) |
| `src/lib/choreo.ts`, `handview.tsx` | die Hände beim Wickeln: eine Zahl `p` treibt alles (2,4 = zwei Schlaufen fertig, die dritte unterwegs) |
| `src/lib/shapes.ts` | Knoten, die Acht, Ellenbogen-Wicklung, Achterlage |
| `src/nodes/Cable.ts` | zeichnet ein Kabel: Mantel, Glanz, gelber Streifen für die Drehung, Stecker; Kreuzungen wie im Knotendiagramm |
| `src/nodes/Ribbon.ts` | dasselbe als flaches Band (oben gelb, unten dunkel) für Stufe 5 |
| `src/nodes/Fist.ts` | eine Faust von vorn mit Unterarm; `flip` dreht die Hand um |
| `src/lib/ui.tsx` | Stufenleiste, Etiketten, ✓/✗, Drehpfeile, die „Hier kannst du aufhören“-Karte |

Texte und Tempo stehen direkt in den Szenen (`waitFor`, Dauern der Animationen).
