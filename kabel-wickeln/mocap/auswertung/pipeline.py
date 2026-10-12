"""Die ganze Auswertung eines Takes: 2D (Modelle, zwischengespeichert) -> 3D -> Take-Datei, Kontrollvideo, Bericht."""

import datetime as dt
import gzip
import json
import math
import time
from pathlib import Path

import numpy as np

from . import VERSION
from . import gelenke as G
from . import haende, heben, kabel, kamera, marker, modelle, sitzung, take, verfolgung, vorschau
from .k2rec import K2Rec

REPO = Path(__file__).resolve().parents[3]
LIGHT_MODEL = REPO / "web" / "lib" / "models" / "yolo11s-pose-512x448-fp16.onnx"
FPS = 30.0


class Options:
    def __init__(self, **kw):
        self.modell = "leicht"        # leicht | stark
        self.device = "cpu"           # cpu | cuda | dml
        self.every = 1                # Modelle nur auf jedem n-ten Frame (dazwischen interpoliert)
        self.detektor = None          # Pfad: .onnx (onnxruntime) oder .pt (Ultralytics)
        self.detektor_groesse = 640   # Eingabebreite für Ultralytics
        self.topdown = None           # Liste, z. B. ["sapiens", "vitpose"]; None = nach Modell
        self.flip = True
        self.personen = None          # None = aus shots.json
        self.max_luecke = 1.0         # s
        self.glatt = 1.0              # Faktor für die Glättungsbreite
        self.kabel = "dunkel"         # dunkel | hell | aus
        self.ganz = False             # nicht auf die Aktion kürzen
        self.vorschau = True
        self.boden = None             # .k2rec des leeren Raums (sonst automatisch)
        self.knochen = None           # Take-Datei, deren Knochenlängen gelten sollen
        self.signal_s = None          # Startsignal (s ab erstem Frame), sonst aus sitzung.json
        self.threads = 0
        self.batch = 0                # Personen je Stapel für die Top-down-Modelle (0 = 8 auf cuda, sonst 1)
        self.modelle_ordner = None
        self.sapiens_repo = None
        self.vitpose_repo = None
        self.dtype = None
        self.neu_2d = False           # 2D neu rechnen, auch wenn ein Zwischenstand da ist
        self.max_frames = None        # nur die ersten n Frames (Tests)
        self.kp2d_dir = None          # Ordner für den 2D-Zwischenstand (Standard: neben der Aufnahme)
        self.video_dir = None         # Ordner für Kontrollvideo und Bericht (Standard: neben der Aufnahme)
        self.quiet = False
        for k, v in kw.items():
            if not hasattr(self, k):
                raise TypeError(f"unbekannte Option {k}")
            setattr(self, k, v)

    def tag(self):
        return self.modell + (f"-e{self.every}" if self.every > 1 else "")

    def signature(self):
        """Welche Modelle das 2D gerechnet haben (ein Zwischenstand mit anderen Modellen wird nicht benutzt)."""
        if self.modell == "leicht":
            tops = self.topdown or []
        else:
            tops = self.topdown if self.topdown is not None else ["sapiens", "vitpose"]
        repos = {"sapiens": self.sapiens_repo or modelle.TOPDOWN["sapiens"][0],
                 "vitpose": self.vitpose_repo or modelle.TOPDOWN["vitpose"][0]}
        det = Path(self.detektor).name if self.detektor else ("yolo11s-pose-512x448-fp16.onnx" if self.modell == "leicht"
                                                              else "yolo11x-pose.pt")
        return {"modell": self.modell, "detektor": det, "topdown": [f"{t}:{repos.get(t, t)}" for t in tops],
                "flip": bool(self.flip)}


def say(opts, *a):
    if not opts.quiet:
        print(*a, flush=True)


# ---------------------------------------------------------------------------------------- Bildquellen

class IrPackage:
    """Infrarotbilder einer Aufnahme ohne Tiefe (für Colab): npz mit ir (N, H, W) uint8, times (N,), index (N,)."""

    def __init__(self, path):
        d = np.load(path, allow_pickle=False)
        self.path = Path(path)
        self._ir = d["ir"]
        self.index = d["index"].astype(int)
        self.times_all = d["times_all"]
        self.source = str(d["source"])
        self.frames_total = int(d["frames"])

    def __len__(self):
        return self.frames_total

    @property
    def times(self):
        return self.times_all

    def ir(self, i):
        k = np.searchsorted(self.index, i)
        if k < len(self.index) and self.index[k] == i:
            return self._ir[k]
        return None


def export_ir_package(rec, out, every=1):
    idx = np.arange(0, len(rec), every)
    ir = np.stack([rec.ir(i) if rec.ir(i) is not None else np.zeros((rec.height, rec.width), np.uint8) for i in idx])
    np.savez_compressed(out, ir=ir, index=idx, times_all=rec.times, source=np.array(rec.path.name), frames=np.array(len(rec)))
    return out


# ---------------------------------------------------------------------------------------- Stufe 1: 2D

def build_models(opts, main):
    det_path = opts.detektor
    if opts.modell == "leicht":
        det = modelle.OnnxYolo(Path(det_path) if det_path else LIGHT_MODEL, opts.device, opts.threads)
        tds = opts.topdown or []
    else:
        mdir = Path(opts.modelle_ordner) if opts.modelle_ordner else main / "recordings" / "mocap" / "modelle"
        mdir.mkdir(parents=True, exist_ok=True)
        if det_path and str(det_path).lower().endswith(".onnx"):
            det = modelle.OnnxYolo(Path(det_path), opts.device, opts.threads)
        else:
            det = modelle.UltralyticsYolo(Path(det_path) if det_path else mdir / "yolo11x-pose.pt", opts.device,
                                          opts.detektor_groesse)
        tds = opts.topdown if opts.topdown is not None else ["sapiens", "vitpose"]
    top = []
    for name in tds:
        repo = opts.sapiens_repo if name == "sapiens" else opts.vitpose_repo
        top.append(modelle.TopDown(name, opts.device, repo=repo, dtype=opts.dtype))
    return det, top


def run_2d(src, opts, n_persons, depth_of=None, models=None, main=None):
    """Stufe 1: Detektor auf jedem `every`-ten Frame, Hauptperson(en) verfolgen, Top-down-Modelle auf ihren Kästen,
    Ergebnisse zusammenführen. src: K2Rec oder IrPackage. Gibt das kp2d-Dokument."""
    det, tops = models if models else build_models(opts, main or sitzung.find_main())
    N = len(src) if opts.max_frames is None else min(len(src), opts.max_frames)
    frames = list(range(0, N, max(1, opts.every)))
    if hasattr(src, "index"):  # Infrarot-Paket: nur die Frames, die es enthält
        frames = [int(i) for i in src.index if i < N and i % max(1, opts.every) == 0]
    timer = modelle.Timer()
    t0 = time.time()
    dets = {}
    last = t0
    done = []
    for n, i in enumerate(frames):
        ir = src.ir(i)
        if ir is None:
            continue
        done.append(i)
        dets[i] = timer.run("detector", det.detect, ir, opts.flip)
        if time.time() - last > 20:
            last = time.time()
            say(opts, f"  2D: Personen suchen {n + 1}/{len(frames)} ({(last - t0) / len(done):.2f} s je Frame)")
    frames = done
    persons = verfolgung.select_persons(dets, frames, n_persons, depth_of)
    out_persons = []
    batch = opts.batch or (8 if opts.device == "cuda" else 1)
    for pi, track in enumerate(persons):
        fr, boxes, scores, kps = [], [], [], []
        items = sorted(track.items())
        td_out = {td.kind: [] for td in tops}
        for b0 in range(0, len(items), batch):
            chunk = items[b0:b0 + batch]
            pairs = [(src.ir(i), p["box"]) for i, p in chunk]
            for td in tops:
                td_out[td.kind] += timer.run(td.kind, td.many, pairs)
            if tops and time.time() - last > 20:
                last = time.time()
                done_n = b0 + len(chunk)
                say(opts, f"  2D: Person {pi + 1}, Top-down {done_n}/{len(items)} "
                          f"({sum(timer.t.get(t.kind, 0) for t in tops) / done_n:.1f} s je Frame)")
        for n, (i, p) in enumerate(items):
            cands = [("detector:" + det.name, p["kp"])] + [(td.kind + ":" + td.name, td_out[td.kind][n]) for td in tops]
            kp = modelle.fuse(cands, p["box"]) if len(cands) > 1 else p["kp"]
            fr.append(int(i))
            boxes.append([round(float(v), 1) for v in p["box"]])
            scores.append(round(float(p["score"]), 3))
            kps.append([round(float(v), 1 if k % 3 < 2 else 3) for k, v in enumerate(kp.reshape(-1))])
        out_persons.append({"id": pi + 1, "frames": fr, "box": boxes, "score": scores, "kp": kps})
    provided = sorted(set(det.provides).union(*[set(t.provides) for t in tops]))
    return {"format": "kabel-wickeln-kp2d", "version": 1, "source": getattr(src, "source", None) or src.path.name,
            "signature": opts.signature(),
            "frames": N, "computed": frames,
            "every": int(np.median(np.diff(frames))) if len(frames) > 1 else opts.every, "flip": opts.flip,
            "models": {"detector": det.name, "topdown": [t.name for t in tops], "device": opts.device},
            "joints": G.JOINTS, "provided": provided, "persons": out_persons,
            "seconds": round(time.time() - t0, 1), "seconds_by_model": {k: round(v, 1) for k, v in timer.t.items()},
            "created_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}


def stem_of(rec_path):
    n = Path(rec_path).name
    for ext in (".k2rec.part", ".k2rec"):
        if n.endswith(ext):
            return n[:-len(ext)]
    return Path(rec_path).stem


def kp2d_path(rec_path, opts):
    p = Path(rec_path)
    folder = Path(opts.kp2d_dir) if opts.kp2d_dir else p.parent
    exact = folder / f"{stem_of(p)}.kp2d-{opts.tag()}.json.gz"
    if not exact.exists():  # z. B. von Colab mit anderem --every
        other = sorted(folder.glob(f"{stem_of(p)}.kp2d-{opts.modell}*.json.gz"))
        if other:
            return other[0]
    return exact


def side_path(rec, opts, suffix):
    folder = Path(opts.video_dir) if opts.video_dir else rec.path.parent
    return folder / f"{stem_of(rec.path)}{suffix}"


def save_json_gz(path, doc):
    path = Path(path)
    tmp = path.with_name(path.name + ".part")
    with gzip.open(tmp, "wt", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))
    tmp.replace(path)
    return path


def load_json_gz(path):
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return json.load(f)


def person_kp(kp2d, person, F):
    """kp2d -> (F, 68, 3) (Konfidenz 0 = nicht bekannt), 2D zwischen den gerechneten Frames interpoliert."""
    kp = np.zeros((F, G.J, 3), np.float32)
    if person >= len(kp2d["persons"]):
        return kp, np.zeros(F, bool)
    p = kp2d["persons"][person]
    found = np.zeros(F, bool)
    for i, k in zip(p["frames"], p["kp"]):
        if i < F:
            kp[i] = np.array(k, np.float32).reshape(G.J, 3)
            found[i] = True
    every = max(1, int(kp2d.get("every", 1)))
    if every > 1:
        kp = heben.interpolate_2d(kp, [i for i in p["frames"] if i < F], 2 * every + 1)
    return kp, found


# ---------------------------------------------------------------------------------------- Boden

def floor_from_recording(rec, prior_normal, prior_h, n_frames=40, cache=True, cache_dir=None):
    """Boden aus einer Aufnahme (Median je Pixel über n Frames, dann RANSAC). Zwischengespeichert in <name>.boden.json."""
    cpath = (Path(cache_dir) if cache_dir else rec.path.parent) / (stem_of(rec.path) + ".boden.json")
    if cache and cpath.exists():
        try:
            d = json.loads(cpath.read_text(encoding="utf-8"))
            if d.get("frames_total") == len(rec):
                d["normal"] = np.array(d["normal"])
                return d
        except (OSError, ValueError, KeyError):
            pass
    idx = np.linspace(0, len(rec) - 1, min(n_frames, len(rec))).round().astype(int)
    pts = kamera.floor_points_from_depth([rec.depth(i) for i in idx], rec.lut)
    fl = kamera.fit_floor(pts, np.random.default_rng(7), prior_normal, prior_h)
    if fl is None:
        return None
    fl["source"] = rec.path.name
    fl["frames_total"] = len(rec)
    if cache:
        try:
            cpath.write_text(json.dumps({k: (v.tolist() if isinstance(v, np.ndarray) else v) for k, v in fl.items()},
                                        indent=1), encoding="utf-8")
        except OSError:
            pass
    return fl


# ---------------------------------------------------------------------------------------- Stufe 2: 3D

def describe(rec_path, plan, truth=None):
    """Shot, Take, Aufbau und Plan-Werte einer Aufnahme (aus Dateiname, sitzung.json, shots.json)."""
    shot, take_no = sitzung.parse_name(rec_path)
    entry = sitzung.session_entry(rec_path)
    if truth:  # synthetische Aufnahme: Metadaten der Wahrheit (nur Namen und Plan, keine Messwerte)
        shot, take_no = truth.get("shot"), truth.get("take", 1)
    s = plan.shot(shot) if shot else None
    setup = (entry or {}).get("setup") or (s or {}).get("setup") or (truth or {}).get("setup")
    kin = plan.kinect(setup) if setup else {}
    if truth and truth.get("kinect"):
        kin = dict(truth["kinect"])
    kin = dict({k: kin.get(k) for k in ("height_m", "distance_m", "yaw_deg", "pitch_deg")}, note=kin.get("note") or kin.get("position"))
    return {"shot": shot or Path(rec_path).stem, "take": take_no or 1, "setup": setup, "kinect": kin, "plan": s,
            "session": entry}


def evaluate(rec_path, opts, out_dir, main=None, kp2d=None, models=None, truth_meta=None, write_preview=None):
    """Wertet eine Aufnahme aus. Gibt dict(take=Pfad(e), doc=Take-Dokument(e), report=Text, kp2d=...)."""
    t_start = time.time()
    main = main or sitzung.find_main()
    plan = sitzung.Plan()
    rec = K2Rec(rec_path)
    info = describe(rec_path, plan, truth_meta)
    say(opts, f"{rec.path.name}: {len(rec)} Frames, {rec.summary()['seconds']} s, Shot {info['shot']} Take {info['take']}, "
              f"Aufbau {info['setup'] or '?'}" + (f"; Ende beschädigt: {rec.damaged_tail}" if rec.damaged_tail else ""))
    cam = kamera.Camera(rec.params, rec.lut)
    kin = info["kinect"]
    prior_n = kamera.expected_floor_normal(kin.get("pitch_deg")) if kin.get("pitch_deg") is not None else None
    prior_h = kin["height_m"] * 1000 if kin.get("height_m") else None
    persons_planned = (info["plan"] or {}).get("persons", 1)
    n_persons = opts.personen or max(1, persons_planned or 1)

    # Boden: leerer Raum derselben Platzierung, sonst die Aufnahme selbst
    floor, floor_note = None, ""
    cal_files = [Path(opts.boden)] if opts.boden else (
        sitzung.calibration_takes(rec_path, info["setup"], "empty", (info["session"] or {}).get("placement")) if info["setup"] else [])
    for cf in cal_files:
        if cf.resolve() == Path(rec_path).resolve():
            continue
        try:
            with K2Rec(cf) as crec:
                floor = floor_from_recording(crec, prior_n, prior_h, cache_dir=opts.video_dir)
            floor_note = f"aus dem leeren Raum {cf.name}"
            break
        except (OSError, ValueError) as e:
            say(opts, f"  Boden aus {cf.name} ging nicht: {e}")
    own = floor_from_recording(rec, prior_n, prior_h, cache_dir=opts.video_dir)
    if floor is None:
        floor, floor_note = own, "aus dieser Aufnahme"
    elif own is not None:
        ang = math.degrees(math.acos(np.clip(abs(float(np.dot(own["normal"], floor["normal"]))), -1, 1)))
        floor["check_against_take"] = {"angle_deg": round(ang, 2), "height_mm": round(own["d_mm"] - floor["d_mm"], 1)}
    if floor is None:
        raise RuntimeError("keinen Boden gefunden (zu wenig Boden im Bild?); --boden <leerer Raum.k2rec> angeben")
    world = kamera.world_from_floor(floor["normal"], floor["d_mm"])
    pitch, roll = kamera.tilt_deg(floor["normal"])
    say(opts, f"  Boden {floor_note}: Kamera {floor['d_mm'] / 1000:.2f} m hoch, Neigung {pitch:+.1f}°, Rollen {roll:+.1f}°, "
              f"Streuung {floor['rms_mm']:.1f} mm")

    if persons_planned == 0 and not opts.personen:
        rep = (f"{rec.path.name}: Kalibrierung ohne Person. Boden: Kamera {floor['d_mm']:.0f} mm über dem Boden, "
               f"Neigung {pitch:+.1f}°, Rollen {roll:+.1f}°, Streuung {floor['rms_mm']:.1f} mm ({floor['inliers']} Punkte).")
        say(opts, "  " + rep)
        return {"take": [], "doc": [], "report": rep, "floor": floor}

    # Stufe 1: 2D (zwischengespeichert neben der Aufnahme)
    F = len(rec) if opts.max_frames is None else min(len(rec), opts.max_frames)
    if kp2d is None:
        cpath = kp2d_path(rec_path, opts)
        cached = load_json_gz(cpath) if cpath.exists() and not opts.neu_2d else None
        if cached is not None and cached.get("signature", opts.signature()) != opts.signature():
            say(opts, f"  Zwischenstand {cpath.name} stammt von anderen Modellen ({cached.get('signature')}); rechne 2D neu")
            cached = None
            cpath = (Path(opts.kp2d_dir) if opts.kp2d_dir else Path(rec_path).parent) / f"{stem_of(rec_path)}.kp2d-{opts.tag()}.json.gz"
        if cached is not None:
            kp2d = cached
            say(opts, f"  2D aus dem Zwischenstand {cpath.name} ({kp2d['models']['detector']}, {kp2d['models']['topdown']})")
        else:
            say(opts, f"  2D: Modell {opts.modell} auf {opts.device}, jeder {opts.every}. Frame, Spiegel-Mittelung {'an' if opts.flip else 'aus'}")

            def depth_of(i, box):
                d = rec.depth(i)
                x0, y0, x1, y1 = [int(v) for v in box]
                win = d[max(0, (y0 + y1) // 2 - 10):(y0 + y1) // 2 + 10, max(0, (x0 + x1) // 2 - 6):(x0 + x1) // 2 + 6]
                win = win[win > 0]
                return float(np.median(win)) if win.size else None
            kp2d = run_2d(rec, opts, n_persons, depth_of, models, main)
            save_json_gz(cpath, kp2d)
            say(opts, f"  2D fertig in {kp2d['seconds']:.0f} s -> {cpath.name}")
    results = []
    for person in range(n_persons):
        results.append(lift_person(rec, cam, world, floor, floor_note, kp2d, person, F, info, opts, out_dir, write_preview,
                                   t_start))
    rec.close()
    return {"take": [r["path"] for r in results], "doc": [r["doc"] for r in results],
            "report": "\n".join(r["report"] for r in results), "kp2d": kp2d, "floor": floor}


def lift_person(rec, cam, world, floor, floor_note, kp2d, person, F, info, opts, out_dir, write_preview, t_start):
    fx = float(cam.params.get("fx", 365.0))
    kp, found = person_kp(kp2d, person, F)
    computed = np.zeros(F, bool)
    computed[[i for i in kp2d["computed"] if i < F]] = True
    times = rec.times[:F]
    m = heben.Measurement(F)
    for i in range(F):
        if kp[i, :, 2].max() < heben.C_MIN:
            continue
        heben.measure_frame(m, i, rec.depth(i), kp[i], cam, fx)
    swapped = heben.fix_left_right(m, times)
    # Knochen
    prior = None
    if opts.knochen and person == 0:  # die Kalibrierung zeigt die Hauptperson, nicht die zweite
        try:
            prior = (take.read(opts.knochen).get("meta") or {}).get("bones_mm")
        except (OSError, ValueError):
            prior = None
    bones = heben.bone_lengths(m.cam, m.how, m.conf2d, prior)
    n_fixed = heben.enforce_bones(m, bones)
    heben.face_fill(m)
    Pw = heben.to_world(world, m.cam)
    grid = np.arange(0.0, times[-1] + 1e-6, 1.0 / FPS)
    pos, how, conf, outliers, jitter = heben.smooth_resample(times, Pw, m.how, m.conf2d, grid, opts.max_luecke, opts.glatt)
    pos, how, conf = heben.derive(pos, how, conf)
    # Marker
    sess = info["session"] or {}
    signal = opts.signal_s if opts.signal_s is not None else sess.get("signal_in_recording_s")
    clap_planned = (info["plan"] or {}).get("clap", True) is not False
    clap = marker.find_clap(grid, pos, conf, signal) if clap_planned else None
    clap_t = clap.get("time") if clap else None
    start, end, act = marker.start_end(grid, pos, conf, clap_t)
    # Kürzen: alles vor "Klatschen - 1 s" fällt weg (Vorlauf); hinten bleibt alles (Endpose, Nachlauf sind kurz)
    k0, k1 = 0, len(grid)
    if not opts.ganz and clap_t is not None:
        k0 = int(max(0, math.floor((clap_t - 1.0) * FPS)))
    sl = slice(k0, k1)
    g = grid[sl]
    P, Hw, C = pos[sl], how[sl], conf[sl]
    # Kabel
    cable_lines = []
    nearest = np.clip(np.searchsorted(times, g), 0, F - 1)
    nearest = np.where((nearest > 0) & (np.abs(times[np.maximum(nearest - 1, 0)] - g) < np.abs(times[nearest] - g)),
                       nearest - 1, nearest)
    ok_near = np.abs(times[nearest] - g) < 0.6 / FPS
    finder = kabel.CableFinder(cam, world, dark=(opts.kabel != "hell")) if opts.kabel != "aus" else None
    to_cam = kamera.invert(world)
    t_cable = time.time()
    for k in range(len(g)):
        lines = []
        if finder is not None and ok_near[k]:
            hands = []
            for side in ("left", "right"):
                j = G.IDX[f"{side}_hand_middle_mcp"] if C[k, G.IDX[f"{side}_hand_middle_mcp"]] > 0.3 else G.IDX[f"{side}_wrist"]
                if Hw[k, j] != "-" and C[k, j] > 0.15:
                    pc = kamera.apply(to_cam, P[k, j])
                    u, v = cam.project(pc)
                    hands.append((float(u), float(v), float(pc[2])))
            depth, ir = rec.frame(int(nearest[k]))
            lines = finder.find(ir, depth, hands)
        cable_lines.append(lines)
    t_cable = time.time() - t_cable
    hands_blk = haende.hands_block(P, C)
    # Qualität
    qj = {}
    for j, n in enumerate(G.JOINTS):
        qj[n] = {"conf": round(float(np.mean(C[:, j])), 3), "depth_hits": round(float(np.mean(Hw[:, j] == "D")), 3),
                 "jitter_mm": None if not np.isfinite(jitter[j]) else round(float(jitter[j]), 1)}
        if outliers[j]:
            qj[n]["outliers"] = int(outliers[j])
    warnings = quality_warnings(Hw, C, kp2d, info, clap, found, computed)
    found_frac = float(found[computed].mean()) if computed.any() else 0.0
    cable_frac = float(np.mean([bool(x) for x in cable_lines])) if cable_lines else 0.0
    P_out, H_out, C_out = take.encode_frames(P, Hw, C)
    pitch, roll = kamera.tilt_deg(floor["normal"])
    plan_d = (info["kinect"] or {}).get("distance_m")
    doc = {
        "format": take.FORMAT, "version": take.VERSION, "kind": "take",
        "shot": info["shot"], "take": info["take"], "source": rec.path.name.replace(".k2rec.part", ".k2rec"),
        "recorded_at": take.iso_utc(rec.recorded_at_us), "setup": info["setup"], "kinect": info["kinect"],
        "fps": FPS, "frames": len(g), "t": {"t0": round(float(g[0]), 6) if len(g) else 0.0, "dt": 1.0 / FPS},
        "camera": cam.to_json(),
        "floor": {"normal": [round(float(v), 6) for v in world[1, :3]], "d_mm": round(float(world[1, 3]), 1),
                  "rms_mm": round(float(floor["rms_mm"]), 2),
                  "frame": "CAMERA; height above the floor of a CAMERA point p (mm) = normal·p + d_mm",
                  "source": floor.get("source"), "measured": floor_note},
        "world": {"frame": "WORLD: mm, y up, floor y = 0, origin on the floor below the sensor, +z horizontal from the "
                           "person to the sensor (-z = the camera's view projected on the floor), x = y × z",
                  "cam_to_world": [round(float(v), 6) for v in world.reshape(-1)],
                  "sensor_mm": [0, round(float(world[1, 3]), 1), 0]},
        "joints": G.JOINTS, "pos": P_out, "conf": C_out, "how": H_out,
        "cable": [kabel.to_json(lines) for lines in cable_lines] if finder is not None else None,
        "hands": hands_blk,
        "quality": {"joints": qj, "frames_recorded": int(F), "frames_skipped_by_hub": rec.skipped,
                    "person_found": round(found_frac, 3), "cable_frames": round(cable_frac, 3),
                    "floor": {"angle_vs_take": floor.get("check_against_take"), "pitch_deg": round(pitch, 2),
                              "roll_deg": round(roll, 2), "inliers": floor.get("inliers")},
                    "clap": clap, "activity": act, "bones_fixed": int(n_fixed), "left_right_swapped": swapped,
                    "warnings": warnings},
        "markers": {"clap": clap_t, "start": start, "end": end},
        "meta": {"program": f"mocap/auswerten.py {VERSION}", "models": kp2d["models"], "every": kp2d.get("every", 1),
                 "flip": kp2d.get("flip"), "person": person + 1,
                 "bones_mm": {k: round(v["mm"], 1) for k, v in bones.items()},
                 "trim": {"from_s": round(float(g[0]), 3) if len(g) else None, "to_s": round(float(g[-1]), 3) if len(g) else None,
                          "whole_recording_s": round(float(times[-1]), 3)},
                 "signal_in_recording_s": signal, "smoothing": opts.glatt, "max_gap_s": opts.max_luecke,
                 "seconds": {"2d": kp2d.get("seconds"), "total": None, "cable": round(t_cable, 1)},
                 "radius_mm": {n: G.RADIUS[j] for j, n in enumerate(G.JOINTS) if G.RADIUS[j]}},
    }
    if plan_d:
        doc["world"]["mark_mm"] = [0, 0, -round(plan_d * 1000)]
        doc["world"]["mark_note"] = "geplante Marke laut shots.json (kinect.distance_m), nicht gemessen"
    if person > 0:
        doc["person"] = person + 1
    suffix = f"_p{person + 1}" if person > 0 else ""
    # Name wie die Aufnahme (<shot>_t<take>); Aufnahmen mit anderem Namen (synthetische) behalten ihren Namen
    base = f"{info['shot']}_t{info['take']}" if sitzung.parse_name(rec.path)[0] else stem_of(rec.path)
    out_path = Path(out_dir) / f"{base}{suffix}.json.gz"
    doc["meta"]["seconds"]["total"] = round(time.time() - t_start, 1)
    take.write(out_path, doc)
    report = format_report(doc, out_path, floor_note)
    # Kontrollvideo neben der Aufnahme
    wp = opts.vorschau if write_preview is None else write_preview
    if wp:
        vpath = side_path(rec, opts, f".auswertung{suffix}.mp4")
        vp = render_preview(rec, cam, world, kp, g, nearest, ok_near, P, Hw, C, cable_lines, doc, vpath)
        report += f"\n  Kontrollvideo: {vp}"
    txt = side_path(rec, opts, f".auswertung{suffix}.txt")
    try:
        txt.write_text(report + "\n", encoding="utf-8")
    except OSError:
        pass
    say(opts, report)
    return {"path": out_path, "doc": doc, "report": report}


def quality_warnings(Hw, C, kp2d, info, clap, found, computed):
    w = []
    if computed.any() and found[computed].mean() < 0.9:
        w.append(f"Person nur in {found[computed].mean() * 100:.0f} % der Frames gefunden")
    for n in ("left_wrist", "right_wrist", "left_elbow", "right_elbow", "left_shoulder", "right_shoulder", "left_hip",
              "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle"):
        j = G.IDX[n]
        bad = float(np.mean((Hw[:, j] == "-") | (Hw[:, j] == "I") | (C[:, j] < 0.3)))
        if bad > 0.25:
            w.append(f"{G.GERMAN.get(n, n)}: {bad * 100:.0f} % der Zeit unsicher oder interpoliert")
    if 23 in kp2d.get("provided", []):
        for side, de in (("left", "linke"), ("right", "rechte")):
            hj = [G.IDX[f"{side}_hand_{x}"] for x in ("index_mcp", "middle_mcp", "pinky_mcp", "index_tip", "thumb_tip")]
            if float(np.mean(C[:, hj] < 0.3)) > 0.4:
                w.append(f"{de} Hand: Finger in {np.mean(C[:, hj] < 0.3) * 100:.0f} % der Zeit unsicher")
    else:
        w.append("keine Hand- und Fußpunkte (leichtes Modell: nur Körper)")
    planned = (info.get("plan") or {}).get("clap", True) is not False
    if planned and (not clap or clap.get("time") is None):
        w.append("Klatschen nicht gefunden: markers.clap fehlt (Take nicht synchronisierbar, ganz behalten)")
    return w


def format_report(doc, out_path, floor_note):
    q = doc["quality"]
    mk = doc["markers"]
    lines = [f"  Take: {out_path}",
             f"  {doc['frames']} Frames ({doc['frames'] / FPS:.1f} s ab {doc['t']['t0']:.2f} s), Person in {q['person_found'] * 100:.0f} % gefunden",
             f"  Klatschen: {'%.2f s' % mk['clap'] if mk['clap'] is not None else 'nicht gefunden'}"
             + (f" (Hände {q['clap']['gap_mm']} mm, {q['clap']['speed_m_s']} m/s)" if q.get("clap") and q["clap"].get("time") is not None else "")
             + f"; Aktion {mk['start']} – {mk['end']} s"]
    body = ["left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist", "left_hip", "right_hip",
            "left_knee", "right_knee", "left_ankle", "right_ankle"]
    lines.append("  Gelenk              Konf.  Tiefe  Zittern")
    for n in body:
        j = q["joints"][n]
        jit = "–" if j["jitter_mm"] is None else f"{j['jitter_mm']:.0f} mm"
        lines.append(f"  {G.GERMAN.get(n, n):19s} {j['conf']:5.2f}  {j['depth_hits'] * 100:4.0f} %  {jit}")
    hand = [n for n in G.JOINTS if "_hand_" in n]
    hc = np.mean([q["joints"][n]["conf"] for n in hand])
    lines.append(f"  Handpunkte: mittlere Konfidenz {hc:.2f}; Kabel in {q['cable_frames'] * 100:.0f} % der Frames")
    for w in q["warnings"]:
        lines.append(f"  ! {w}")
    return "\n".join(lines)


def render_preview(rec, cam, world, kp, g, nearest, ok_near, P, Hw, C, cable_lines, doc, vpath):
    painter = vorschau.Painter(cam, world, 2)
    finite = P[np.isfinite(P[..., 0])]
    if len(finite):
        lo = np.percentile(finite, 1, axis=0) - 200
        hi = np.percentile(finite, 99, axis=0) + 200
        lo[1] = 0.0
        box = ((lo[0], hi[0]), (lo[1], hi[1]), (lo[2], hi[2]))
    else:
        box = ((-1000, 1000), (0, 2000), (-3000, -1000))
    W2, H2 = rec.width * 2 + rec.height, rec.height * 2
    vw = vorschau.VideoWriter(vpath, W2 + (W2 % 2), H2 + (H2 % 2), FPS)
    mk = doc["markers"]
    for k in range(len(g)):
        i = int(nearest[k])
        ir = rec.ir(i)
        t = g[k]
        rel = f"  (t - Klatschen = {t - mk['clap']:+.2f} s)" if mk["clap"] is not None else ""
        texts = [(f"{doc['shot']} Take {doc['take']}   {t:6.2f} s{rel}", (255, 255, 255))]
        if mk["clap"] is not None and abs(t - mk["clap"]) < 0.25:
            texts.append(("KLATSCHEN", (255, 80, 80)))
        if mk["start"] is not None and mk["end"] is not None and mk["start"] <= t <= mk["end"]:
            texts.append(("Aktion", (120, 255, 120)))
        if not ok_near[k]:
            texts.append(("(Frame fehlt in der Aufnahme)", (255, 200, 0)))
        frame = painter.frame(ir, kp[i] if ok_near[k] else None, P[k], Hw[k], C[k], cable_lines[k], texts, box)
        if frame.shape[1] != vw.w or frame.shape[0] != vw.h:
            pad = np.zeros((vw.h, vw.w, 3), np.uint8)
            pad[:frame.shape[0], :frame.shape[1]] = frame
            frame = pad
        vw.add(frame)
    return vw.close()
