"""Auswertung der Mocap-Takes: .k2rec (Tiefe + Infrarot der Kinect) -> Take-Datei (FORMAT.md).

Module:
  k2rec       Leser für .k2rec (auch abgeschnittene Dateien)
  kamera      Kameramodell (LUT, Projektion), Boden (RANSAC), WELT
  gelenke     die 68 Gelenke, Knochen, Zuordnung der Modell-Keypoints (COCO, Goliath/Sapiens2)
  modelle     2D-Modelle: YOLO-Pose (ONNX oder Ultralytics), ViTPose++, Sapiens2; Spiegel-Mittelung
  verfolgung  die Hauptperson über die Frames verfolgen (stabile ID)
  heben       2D -> 3D mit der Tiefe, Knochenlängen, Lücken, Glättung, 30 fps
  haende      Handkoordinatensystem und Fingerkrümmung
  kabel       Kabel aus Infrarot + Tiefe (experimentell)
  marker      Klatschen, Beginn und Ende der Aktion
  take        Take-Datei schreiben und lesen
  vorschau    Kontrollvideo (Infrarot mit Skelett, Händen, Kabel)
  sitzung     shots.json und sitzung.json des Aufnahme-Tools
  pipeline    alles zusammen (von auswerten.py und den Tests benutzt)
"""

VERSION = "1.0"
