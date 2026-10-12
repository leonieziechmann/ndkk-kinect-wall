#!/usr/bin/env python3
"""Auswertung der Mocap-Takes für „Kabel richtig aufwickeln“: .k2rec -> Gelenkdaten (mocap/FORMAT.md).

Je Aufnahme:
  1. 2D: YOLO11x-pose findet dich in jedem Infrarotbild, Sapiens2 1b (Körper, Füße, 2 x 21 Handpunkte) und
     ViTPose++ huge (Körper) setzen die Gelenke im Ausschnitt um dich; alles auch gespiegelt und gemittelt.
     Zwischengespeichert neben der Aufnahme (<name>.kp2d-<modell>.json.gz): ein zweiter Lauf rechnet nur 3D neu.
  2. 3D: Tiefe an jedem Gelenk (robust, mit Körperbau), Boden aus dem leeren Raum (cal.<Aufbau>.empty) oder aus
     der Aufnahme, WELT wie in FORMAT.md, Knochenlängen, Lücken, Glättung, genau 30 fps.
  3. Klatschen (Sync), Beginn/Ende, Hände (Handsystem, Fingerkrümmung), Kabel (experimentell).
  4. Take-Datei <shot>_t<take>.json.gz, Kontrollvideo und Bericht neben der Aufnahme.

    python auswerten.py <Hauptordner>/recordings/mocap/termin1           alle behaltenen Takes eines Termins
    python auswerten.py recordings/mocap/termin1/p1.coil.teach_t1.k2rec   ein Take
    python auswerten.py --modell leicht ...                               schneller Test (nur Körper, ONNX)
    python auswerten.py --device dml --every 2 ...                        Grafik des Notebooks, jeder 2. Frame
    python auswerten.py --colab-paket D:/colab termin1                    Infrarotbilder für Colab packen (fragt)
    python auswerten.py --nur-2d --ir-paket x.ir.npz                      (auf Colab) nur 2D aus einem Paket

Die Take-Dateien landen in <Hauptordner>/recordings/mocap/takes/ (privat). Ins Repository
(kabel-wickeln/mocap/takes/) nur mit --ins-repo, und nur mit deinem Okay. Anleitung: mocap/README.md, „Auswerten“.
"""

import argparse
import sys
import time
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from auswertung import pipeline, sitzung, vergleich  # noqa: E402

REPO_TAKES = HERE / "takes"

CONSENT_COLAB = """\
Die Infrarotbilder dieser Aufnahmen werden in eine Datei gepackt, die du danach selbst zu Google Colab hochlädst.
Im Infrarotbild ist dein Gesicht erkennbar (und das jeder anderen Person im Bild). Hochgeladen wird nur das
Infrarotbild, keine Tiefe. Auf Colab rechnen die großen Modelle die 2D-Gelenke; die Bilder werden dort danach
gelöscht (colab_auswerten.py tut das am Ende). Die Datei bleibt bei dir, bis du sie selbst löschst.
Willst du das? Tippe  ja  und Enter (alles andere = nein): """

CONSENT_REPO = """\
Die Gelenkdaten (Zahlen, keine Bilder) kommen nach {ziel}, also ins Repository-Verzeichnis. Committet wird damit
noch nichts. Man kann aus ihnen deine Körpermaße und Bewegungen ablesen; zweite Personen nur mit ihrem Okay.
Okay? Tippe  ja  und Enter: """


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog="Ausführlich: mocap/README.md, Abschnitt „Auswerten“.")
    ap.add_argument("pfade", nargs="*", help=".k2rec-Dateien oder Ordner (dann alle behaltenen Takes darin)")
    ap.add_argument("--modell", choices=["stark", "leicht"], default="stark",
                    help="stark: YOLO11x + Sapiens2 1b + ViTPose++ huge (Standard); leicht: YOLO11s-ONNX, nur Körper (Test)")
    ap.add_argument("--device", choices=["auto", "cpu", "cuda", "dml"], default="auto",
                    help="cuda (Colab/Nvidia), dml (DirectML, Grafik des Notebooks), cpu; auto = cuda, wenn da, sonst cpu")
    ap.add_argument("--every", type=int, default=1, help="Modelle nur auf jedem n-ten Frame (2D dazwischen interpoliert, 3D auf jedem)")
    ap.add_argument("--topdown", help="Top-down-Modelle, z. B. sapiens oder sapiens,vitpose (Standard bei stark) oder keins")
    ap.add_argument("--detektor", help="eigenes Personen-Modell: .pt (Ultralytics) oder .onnx (onnxruntime, auch DirectML)")
    ap.add_argument("--detektor-groesse", type=int, default=640, help="Eingabebreite für den Ultralytics-Detektor (640)")
    ap.add_argument("--sapiens", help="anderes Sapiens2-Modell (Hugging Face), z. B. facebook/sapiens2-pose-0.4b")
    ap.add_argument("--vitpose", help="anderes ViTPose-Modell (Hugging Face), z. B. usyd-community/vitpose-plus-base")
    ap.add_argument("--ohne-spiegel", action="store_true", help="keine Spiegel-Mittelung (halbe Zeit, etwas unruhiger)")
    ap.add_argument("--ziel", help="Ordner für die Take-Dateien (Standard: <Hauptordner>/recordings/mocap/takes)")
    ap.add_argument("--ins-repo", action="store_true", help=f"Take-Dateien nach {REPO_TAKES} (fragt nach deinem Okay)")
    ap.add_argument("--personen", type=int, help="wie viele Personen (Standard: aus shots.json; die 2. -> <shot>_t<n>_p2)")
    ap.add_argument("--shot", help="nur diese Shots (Komma), bei Ordnern")
    ap.add_argument("--setup", help="nur dieser Aufbau (A, B, T, C, D), bei Ordnern")
    ap.add_argument("--alle", action="store_true", help="auch verworfene Takes (keep: false) auswerten")
    ap.add_argument("--boden", help=".k2rec des leeren Raums für den Boden (Standard: cal.<Aufbau>.empty derselben Platzierung)")
    ap.add_argument("--knochen", help="Take-Datei, deren Knochenlängen gelten (Standard: die ausgewertete cal.<Aufbau>.body im "
                                     "Zielordner, sonst die aus diesem Lauf)")
    ap.add_argument("--signal", type=float, help="Startsignal in s ab Aufnahmebeginn (Standard: aus sitzung.json)")
    ap.add_argument("--kp2d", help="2D-Ergebnis (.kp2d-*.json.gz) statt neu zu rechnen, z. B. von Colab")
    ap.add_argument("--neu", action="store_true", help="2D neu rechnen, auch wenn ein Zwischenstand da ist")
    ap.add_argument("--kabel", choices=["dunkel", "hell", "aus"], default="dunkel", help="Kabel: dunkle Linie (schwarzes Kabel), helle, aus")
    ap.add_argument("--ganz", action="store_true", help="nicht kürzen (sonst fällt alles vor Klatschen - 1 s weg)")
    ap.add_argument("--max-luecke", type=float, default=1.0, help="längste Lücke in s, die interpoliert wird (1,0)")
    ap.add_argument("--glatt", type=float, default=1.0, help="Glättung: Faktor der Fensterbreite (1 = etwa ±0,1 s)")
    ap.add_argument("--ohne-video", action="store_true", help="kein Kontrollvideo")
    ap.add_argument("--wahrheit", action="store_true", help="mit <name>.truth.json.gz vergleichen (synthetische Aufnahmen)")
    ap.add_argument("--threads", type=int, default=0, help="CPU-Threads für die Modelle (Standard: alle)")
    ap.add_argument("--batch", type=int, default=0, help="Personen je Stapel für Sapiens/ViTPose (Standard: 8 auf cuda, sonst 1)")
    ap.add_argument("--main", help="Hauptcheckout (dort liegt recordings/)")
    ap.add_argument("--nur-2d", action="store_true", help="nur Stufe 1 (2D), z. B. auf Colab")
    ap.add_argument("--ir-paket", nargs="*", help="(Colab) Infrarot-Pakete (.ir.npz) statt .k2rec, mit --nur-2d")
    ap.add_argument("--colab-paket", metavar="ORDNER", help="Infrarotbilder der Aufnahmen für Colab packen (fragt vorher)")
    ap.add_argument("--ja", action="store_true", help="Fragen nach Einverständnis mit ja beantworten (nur wenn du es willst)")
    ap.add_argument("--volle-prioritaet", action="store_true", help="normale CPU-Priorität (sonst niedriger, damit Hub und Aufnahme vorgehen)")
    ap.add_argument("--max-frames", type=int, help=argparse.SUPPRESS)
    return ap.parse_args(argv)


def be_nice():
    """Niedrige CPU-Priorität (wie pose-training): Hub, Aufnahme und alles andere auf dem Notebook gehen vor."""
    try:
        if sys.platform == "win32":
            import ctypes
            k = ctypes.windll.kernel32
            k.GetCurrentProcess.restype = ctypes.c_void_p
            k.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
            k.SetPriorityClass(k.GetCurrentProcess(), 0x4000)  # BELOW_NORMAL_PRIORITY_CLASS
        else:
            import os
            os.nice(10)
    except Exception:
        pass


def device_auto(d):
    if d != "auto":
        return d
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
    except ImportError:
        pass
    return "cpu"


def collect(paths, args):
    """Aufnahmen aus Dateien und Ordnern; Kalibrierung (leerer Raum, Körper) je Aufbau zuerst."""
    files = []
    for p in paths:
        p = Path(p)
        if p.is_dir():
            files += sitzung.list_takes(p, keep_only=not args.alle)
        elif p.exists():
            files.append(p)
        else:
            print(f"{p}: gibt es nicht")
    if args.shot:
        want = set(args.shot.split(","))
        files = [f for f in files if (sitzung.parse_name(f)[0] or f.stem) in want]
    if args.setup:
        plan = sitzung.Plan()
        files = [f for f in files if ((plan.shot(sitzung.parse_name(f)[0] or "") or {}).get("setup") == args.setup)]

    def key(f):
        shot = sitzung.parse_name(f)[0] or ""
        order = 0 if shot.endswith(".empty") else 1 if shot.endswith(".cable") else 2 if shot.endswith(".body") else 3
        return (order, str(f))
    return sorted(dict.fromkeys(files), key=key)


def ask(text, args):
    if args.ja:
        print(text + "ja (--ja)")
        return True
    try:
        return input(text).strip().lower() == "ja"
    except EOFError:
        return False


def colab_package(files, out_dir, every, args):
    out_dir = Path(out_dir)
    if not ask(CONSENT_COLAB, args):
        print("Nicht gepackt.")
        return 1
    from auswertung.k2rec import K2Rec
    out_dir.mkdir(parents=True, exist_ok=True)
    zpath = out_dir / f"kinect-ir-{time.strftime('%Y%m%d-%H%M%S')}.zip"
    with zipfile.ZipFile(zpath, "w", compression=zipfile.ZIP_STORED) as z:
        for f in files:
            with K2Rec(f) as rec:
                stem = f.name.replace(".k2rec", "")
                tmp = out_dir / f"{stem}.ir.npz"
                pipeline.export_ir_package(rec, tmp, every)
                z.write(tmp, tmp.name)
                tmp.unlink()
                print(f"  {f.name}: {len(rec)} Frames gepackt")
        # der Code der Auswertung, damit auf Colab nur dieses Paket und colab_auswerten.py hochgeladen werden müssen
        for code in [HERE / "auswerten.py", HERE / "shots.json", *sorted((HERE / "auswertung").glob("*.py"))]:
            z.write(code, "mocap/" + code.relative_to(HERE).as_posix())
    print(f"Paket: {zpath} ({zpath.stat().st_size / 1e6:.0f} MB). Weiter mit README.md, „Auf Colab auswerten“.")
    return 0


def main(argv=None):
    args = parse_args(argv)
    t0 = time.time()
    if not args.volle_prioritaet:
        be_nice()
    main_dir = sitzung.find_main(args.main)
    device = device_auto(args.device)
    topdown = None
    if args.topdown:
        topdown = [] if args.topdown in ("keins", "none") else [x.strip() for x in args.topdown.split(",") if x.strip()]
    opts = pipeline.Options(modell=args.modell, device=device, every=max(1, args.every), detektor=args.detektor,
                            detektor_groesse=args.detektor_groesse, topdown=topdown, flip=not args.ohne_spiegel,
                            personen=args.personen, max_luecke=args.max_luecke, glatt=args.glatt, kabel=args.kabel,
                            ganz=args.ganz, vorschau=not args.ohne_video, boden=args.boden, knochen=args.knochen,
                            signal_s=args.signal, threads=args.threads, sapiens_repo=args.sapiens,
                            vitpose_repo=args.vitpose, neu_2d=args.neu, max_frames=args.max_frames, batch=args.batch)
    # Colab-Seite: nur 2D aus Infrarot-Paketen
    if args.ir_paket:
        models = pipeline.build_models(opts, main_dir)
        for p in args.ir_paket:
            src = pipeline.IrPackage(p)
            print(f"{src.path.name}: {len(src.index)} Infrarotbilder von {src.source}")
            shot = (sitzung.parse_name(src.source)[0] or "")
            n_persons = args.personen or max(1, (sitzung.Plan().shot(shot) or {}).get("persons", 1) or 1)
            doc = pipeline.run_2d(src, opts, n_persons, None, models, main_dir)
            out = Path(p).with_name(src.source.replace(".k2rec", "") + f".kp2d-{opts.tag()}.json.gz")
            pipeline.save_json_gz(out, doc)
            print(f"  -> {out.name} ({doc['seconds']:.0f} s)")
        return 0
    if not args.pfade:
        print("Welche Aufnahmen? Gib Dateien oder einen Ordner an, z. B.:\n"
              f"  python auswerten.py {main_dir / 'recordings' / 'mocap' / 'termin1'}\n(--help zeigt alle Optionen)")
        return 2
    files = collect(args.pfade, args)
    if not files:
        print("Keine Aufnahmen gefunden.")
        return 2
    if args.kp2d and len(files) > 1:
        print("--kp2d gilt für genau eine Aufnahme (für einen Ordner: die .kp2d-Dateien neben die Aufnahmen legen).")
        return 2
    if args.colab_paket:
        return colab_package(files, args.colab_paket, opts.every, args)
    if args.ins_repo:
        if not ask(CONSENT_REPO.format(ziel=REPO_TAKES), args):
            print("Dann bleiben die Take-Dateien privat in recordings/. Abbruch.")
            return 1
        out_dir = REPO_TAKES
    else:
        out_dir = Path(args.ziel) if args.ziel else main_dir / "recordings" / "mocap" / "takes"
    if not args.ins_repo and sitzung.git_ignored(main_dir, out_dir / "x.json.gz") is False and not args.ziel:
        print(f"Achtung: {out_dir} ist nicht von git ausgeschlossen.")
    auto_knochen = False
    if opts.knochen is None:  # schon ausgewertete Kalibrierung (z. B. aus einem früheren Lauf über den Termin-Ordner)
        found = body_take_in(out_dir)
        if found:
            opts.knochen, auto_knochen = str(found), True
            print(f"Knochenlängen aus {found.name} (schon ausgewertet; --knochen wählt eine andere)")
    print(f"{len(files)} Aufnahme(n); Modell {opts.modell} auf {device}"
          + (f", jeder {opts.every}. Frame" if opts.every > 1 else "") + f"; Take-Dateien nach {out_dir}")
    models = None
    failed = []
    summary = []
    for f in files:
        try:
            kp2d = pipeline.load_json_gz(args.kp2d) if args.kp2d else None
            if kp2d is None and not args.nur_2d:
                cached = pipeline.kp2d_path(f, opts)
                if not cached.exists() or args.neu:
                    if models is None and needs_models(f):
                        models = pipeline.build_models(opts, main_dir)
            elif args.nur_2d and models is None:
                models = pipeline.build_models(opts, main_dir)
            if args.nur_2d:
                from auswertung.k2rec import K2Rec
                with K2Rec(f) as rec:
                    doc = pipeline.run_2d(rec, opts, args.personen or 1, None, models, main_dir)
                out = pipeline.save_json_gz(pipeline.kp2d_path(f, opts), doc)
                print(f"  -> {out}")
                continue
            truth = None
            tp = vergleich.truth_path_for(f)
            if tp.exists():
                truth = vergleich.load_truth(tp)
            res = pipeline.evaluate(f, opts, out_dir, main_dir, kp2d=kp2d, models=models, truth_meta=truth)
            if body_prior(res, opts, replace=auto_knochen):
                auto_knochen = False
            summary.append((f.name, res))
            if (args.wahrheit or truth is not None) and truth and res["doc"]:
                per = vergleich.mpjpe(res["doc"][0], truth)
                print(vergleich.report(per, f"  Vergleich mit der Wahrheit ({tp.name}):"))
        except KeyboardInterrupt:
            print("\nAbgebrochen (Strg+C). Der 2D-Zwischenstand fertiger Takes bleibt.")
            return 130
        except Exception as e:  # ein kaputter Take hält die anderen nicht auf
            import traceback
            traceback.print_exc()
            print(f"{f.name}: FEHLER {e}")
            failed.append(f.name)
    print(f"\nFertig in {time.time() - t0:.0f} s: {len(files) - len(failed)} ausgewertet" + (f", {len(failed)} mit Fehler: {', '.join(failed)}" if failed else ""))
    return 1 if failed else 0


def needs_models(f):
    plan = sitzung.Plan()
    shot = plan.shot(sitzung.parse_name(f)[0] or "")
    return not shot or shot.get("persons", 1) != 0


def body_prior(res, opts, replace=False):
    """Nach cal.<Aufbau>.body: dessen Knochenlängen gelten für die folgenden Takes (falls nicht --knochen; eine früher
    ausgewertete, automatisch gefundene ersetzt sie, replace=True). Gibt True, wenn sie jetzt gelten."""
    if opts.knochen is None or replace:
        for p in res.get("take", []):
            name = Path(p).name
            if name.startswith("cal.") and ".body_" in name and "_p2" not in name:
                opts.knochen = str(p)
                print(f"  Knochenlängen aus {name} gelten für die folgenden Takes")
                return True
    return False


def body_take_in(folder):
    """Die schon ausgewertete Körper-Kalibrierung im Ordner der Take-Dateien: Aufbau A zuerst (ganzer Körper), dann B, C,
    D, T (am Tisch fehlen die Beine), je die neueste. None, wenn keine da ist."""
    folder = Path(folder)
    if not folder.is_dir():
        return None
    rank = {s: i for i, s in enumerate("ABCDT")}
    found = [p for p in folder.glob("cal.*.body_t*.json.gz") if "_p2" not in p.name]
    if not found:
        return None
    return min(found, key=lambda p: (rank.get(p.name.split(".")[1], 9), -p.stat().st_mtime))


if __name__ == "__main__":
    sys.exit(main())
