#!/usr/bin/env python3
"""Kreuzprobe des Take-Formats (FORMAT.md): Python (auswertung/take.py, kamera.py) gegen TypeScript
(src/mocap/take.ts, joints.ts und synthetic/generate.ts) und die Koordinaten-Konventionen.

    python kabel-wickeln/mocap/tests/test_format.py          (etwa 30 s; braucht numpy, für den TS-Teil Node + npm install)

- Gelenklisten: gelenke.py = src/mocap/joints.ts = synthetic/generate.ts (Namen und Reihenfolge).
- Eine Take-Datei, von Python geschrieben (fehlende Gelenke, alle `how`-Zeichen, Kabel, `t` als {t0, dt} und als
  Liste), liest take.ts genauso: Zeiten, mm -> m, Konfidenz, how, Marker, Kabel; synchron (node:zlib) = wie im
  Browser (DecompressionStream); mirror() tauscht links und rechts.
- Die synthetische Wahrheit besteht take.check(); Pixel -> Strahl mit auswertung.kamera (entspiegelt) ->
  cam_to_world trifft ihre Gelenke (Python-Kamera = TS-Generator).
- WELT und Seiten: y oben (Kopf über den Füßen, Füße am Boden), eine Person, die zur Kinect schaut, schaut nach
  +z und hat die linke Hand auf +x; dasselbe in einem ausgewerteten Take (Seiten nicht vertauscht).
Die synthetischen Teile brauchen output/synthetic/ (node mocap/synthetic/erzeugen.mjs); fehlt es, werden sie übersprungen.
"""

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
MOCAP = HERE.parent
PROJECT = MOCAP.parent
SYN = PROJECT / "output" / "synthetic"
sys.path.insert(0, str(MOCAP))

from auswertung import gelenke as G  # noqa: E402
from auswertung import kamera, take  # noqa: E402
from auswertung.k2rec import K2Rec  # noqa: E402

_NODE_CACHE = {}


def node_view(*files):
    """Was take.ts in den Dateien sieht (JSON von take_format.mjs); None, wenn Node oder vite fehlt."""
    key = tuple(str(f) for f in files)
    if key in _NODE_CACHE:
        return _NODE_CACHE[key]
    node = shutil.which("node")
    if not node or not (PROJECT / "node_modules" / "vite").exists():
        return None
    r = subprocess.run([node, str(HERE / "take_format.mjs"), *key], cwd=PROJECT, capture_output=True, text=True,
                       encoding="utf-8", timeout=300, check=False)
    if r.returncode != 0:
        raise AssertionError(f"take_format.mjs: {r.stderr[-2000:]}")
    _NODE_CACHE[key] = json.loads(r.stdout)
    return _NODE_CACHE[key]


def sample_doc(K=12, t_list=False, cable=True):
    """Eine kleine, gültige Take-Datei mit allen Sonderfällen."""
    rng = np.random.default_rng(5)
    pos = rng.uniform(-1500, 1500, (K, G.J, 3))
    pos[..., 1] = np.abs(pos[..., 1])
    how = np.full((K, G.J), "D", dtype="<U1")
    codes = "DIBT"
    for k in range(K):
        for j in range(G.J):
            how[k, j] = codes[(k + j) % 4]
    how[2, 5] = "-"           # fehlt (Position egal)
    pos[3, 7] = np.nan        # fehlt als NaN
    how[4, :] = "-"           # ganzer Frame ohne Person
    conf = rng.uniform(0, 1, (K, G.J))
    P, H, C = take.encode_frames(pos, how, conf)
    world = kamera.world_from_floor(kamera.expected_floor_normal(-10), 1200.0)
    t = [round(0.5 + k / 30 + (0.0333 if k > 6 else 0), 6) for k in range(K)] if t_list else {"t0": 0.5, "dt": 1 / 30}
    cab = None
    if cable:
        cab = [[] for _ in range(K)]
        cab[1] = [{"pts": [10, 20, -1500, 30, 25, -1490, 50, 30, -1480], "conf": 80}]
        cab[2] = [{"pts": [0, 0, -1000, 0, 5, -1001], "conf": 40}, {"pts": [1, 2, 3, 4, 5, 6, 7, 8, 9], "conf": 100}]
    doc = {
        "format": take.FORMAT, "version": take.VERSION, "kind": "take", "shot": "test.format", "take": 3,
        "source": "test.format_t3.k2rec", "recorded_at": "2026-10-12T10:00:00.00Z", "setup": "A",
        "kinect": {"height_m": 1.2, "distance_m": 1.8, "yaw_deg": 30, "pitch_deg": -10, "note": "test"},
        "fps": 30.0, "frames": K, "t": t,
        "camera": {"width": 512, "height": 424, "fx": 365.6, "fy": 365.6, "cx": 256.9, "cy": 211.4, "k1": 0, "k2": 0,
                   "k3": 0, "p1": 0, "p2": 0, "mirrored": True, "frame": "test"},
        "floor": {"normal": [float(v) for v in world[1, :3]], "d_mm": float(world[1, 3]), "rms_mm": 1.0, "frame": "test"},
        "world": {"frame": "test", "cam_to_world": [float(v) for v in world.reshape(-1)], "sensor_mm": [0, 1200, 0],
                  "mark_mm": [0, 0, -1800]},
        "joints": list(G.JOINTS), "pos": P, "conf": C, "how": H, "cable": cab,
        "quality": {"joints": {n: {"conf": 0.5, "depth_hits": 0.5, "jitter_mm": 1.0} for n in G.JOINTS}},
        "markers": {"clap": 0.7, "start": 0.9, "end": None},
    }
    return doc, pos, how, conf


class Gelenklisten(unittest.TestCase):
    def test_same_68_names_everywhere(self):
        self.assertEqual(G.J, 68)
        v = node_view()
        if v is None:
            self.skipTest("Node oder kabel-wickeln/node_modules fehlt (npm install)")
        self.assertEqual(v["take_joints"], G.JOINTS, "src/mocap/joints.ts weicht von auswertung/gelenke.py ab")
        self.assertEqual(v["synthetic_joints"], G.JOINTS, "synthetic/generate.ts weicht von auswertung/gelenke.py ab")
        # FORMAT.md nennt dieselbe Reihenfolge
        fmt = (MOCAP / "FORMAT.md").read_text(encoding="utf-8")
        for name in ("`nose`", "`right_ankle`", "`left_big_toe`", "`right_heel`", "`pinky_tip`", "`pelvis`", "`neck`", "`head`"):
            self.assertIn(name, fmt)
        self.assertEqual(G.JOINTS[17:23], ["left_big_toe", "left_small_toe", "left_heel", "right_big_toe",
                                           "right_small_toe", "right_heel"])
        self.assertEqual(G.JOINTS[23], "left_hand_wrist")
        self.assertEqual(G.JOINTS[44], "right_hand_wrist")
        self.assertEqual(G.JOINTS[65:], ["pelvis", "neck", "head"])


class PythonNachTypeScript(unittest.TestCase):
    """Was auswerten.py schreibt, liest take.ts Zahl für Zahl gleich."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="take-format-"))
        cls.docs = {}
        for name, kw in (("dict", {}), ("list", {"t_list": True, "cable": False})):
            doc, pos, how, conf = sample_doc(**kw)
            path = take.write(cls.tmp / f"test.format_t3_{name}.json.gz", doc)
            cls.docs[name] = (path, doc, pos, how, conf)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_python_check_accepts(self):
        for path, doc, *_ in self.docs.values():
            self.assertEqual(take.check(take.read(path)), [], path.name)

    def test_typescript_reads_the_same(self):
        paths = [str(p) for p, *_ in self.docs.values()]
        v = node_view(*paths)
        if v is None:
            self.skipTest("Node oder kabel-wickeln/node_modules fehlt (npm install)")
        for name, (path, doc, pos, how, conf) in self.docs.items():
            f = v["files"][str(path)]
            times, P, Hw, C = take.arrays(take.read(path))
            K = doc["frames"]
            self.assertEqual(f["frames"], K)
            self.assertEqual((f["shot"], f["take"], f["kind"], f["person"]), ("test.format", 3, "take", 1))
            self.assertTrue(np.allclose(f["time"], times, atol=1e-9), name)
            self.assertAlmostEqual(f["zero"], 0.7)
            self.assertEqual(f["markers"], {"clap": 0.7, "start": 0.9, "end": None})
            self.assertTrue(np.allclose(f["sensor"], [0, 1.2, 0]))
            self.assertTrue(np.allclose(f["mark"], [0, 0, -1.8]))
            tp = np.array(f["pos"]).reshape(K, G.J, 3)
            th = np.array([list(s) for s in f["how"]])
            tc = np.array(f["conf"]).reshape(K, G.J)
            self.assertTrue((th == Hw).all(), f"{name}: how weicht ab")
            ok = Hw != "-"
            self.assertTrue(np.allclose(tp[ok], P[ok] / 1000.0, atol=1e-6), f"{name}: Positionen (mm -> m) weichen ab")
            self.assertTrue(np.allclose(tc[ok], C[ok], atol=1e-6), f"{name}: Konfidenz weicht ab")
            self.assertTrue((tc[~ok] == 0).all())
            # die Sonderfälle
            self.assertEqual(th[2, 5], "-")
            self.assertEqual(th[3, 7], "-")
            self.assertTrue((th[4] == "-").all())
            self.assertEqual(f["sync_vs_async_max"], 0, "gzip synchron (Node) und DecompressionStream (Browser) verschieden")
            self.assertTrue(f["sync_vs_async_how_same"])
            self.assertLess(f["mirror_max_err"], 1e-6, "mirror() spiegelt nicht genau x -> -x mit links <-> rechts")
            self.assertFalse(f["mirror_twice_mirrored"])
            if doc["cable"] is None:
                self.assertTrue(all(c is None for c in f["cables"]))
            else:
                self.assertEqual(f["cables"][1], [3])
                self.assertEqual(f["cables"][2], [2, 3])
                self.assertEqual(f["cables"][0], [])
            # zwischen zwei Frames interpoliert take.ts; die Nase liegt zwischen den Nachbarn
            mid = f["mid"]
            a, b = P[2, 0] / 1000, P[3, 0] / 1000
            if Hw[2, 0] != "-" and Hw[3, 0] != "-":
                lo, hi = np.minimum(a, b) - 0.5, np.maximum(a, b) + 0.5
                self.assertTrue(np.all((np.array(mid["nose"]) >= lo) & (np.array(mid["nose"]) <= hi)))


def _truths():
    return sorted(SYN.glob("synth-*.truth.json.gz")) if SYN.exists() else []


class Wahrheit(unittest.TestCase):
    """Die synthetische Wahrheit (TS-Generator) gegen den Python-Leser und die Python-Kamera."""

    def setUp(self):
        self.files = _truths()
        if not self.files:
            self.skipTest("keine synthetischen Aufnahmen (node mocap/synthetic/erzeugen.mjs)")

    def test_check_and_ts_reader(self):
        docs = {}
        for f in self.files:
            d = take.read(f)
            self.assertEqual(take.check(d), [], f.name)
            self.assertEqual(d["kind"], "truth")
            docs[str(f)] = d
        v = node_view(*docs)
        if v is None:
            return
        for f, d in docs.items():
            tv = v["files"][f]
            self.assertEqual(tv["frames"], d["frames"])
            self.assertAlmostEqual(tv["zero"], d["markers"]["clap"])
            times, P, *_ = take.arrays(d)
            self.assertTrue(np.allclose(tv["time"], times, atol=1e-9))
            self.assertTrue(np.allclose(np.array(tv["pos"]).reshape(P.shape), P / 1000, atol=1e-6))
            self.assertLess(tv["mirror_max_err"], 1e-6)

    def test_python_camera_hits_generator_joints(self):
        """Hub-Pixel (gespiegelt) -> kamera.rays (entspiegelt) -> z der Gelenkmitte -> cam_to_world = Gelenk der Wahrheit."""
        for f in self.files:
            src = f.with_name(f.name.replace(".truth.json.gz", ".k2rec"))
            if not src.exists():
                continue
            d = take.read(f)
            with K2Rec(src) as rec:
                cam = kamera.Camera(rec.params, rec.lut)
            M = np.array(d["world"]["cam_to_world"], float).reshape(4, 4)
            errs = []
            for k in range(0, d["frames"], 37):
                uv = np.array(d["truth"]["uv_values"][k], float).reshape(G.J, 2)
                z = np.array(d["truth"]["zcam_mm"][k], float)
                inside = (uv[:, 0] >= 0) & (uv[:, 0] <= 511) & (uv[:, 1] >= 0) & (uv[:, 1] <= 423)
                r = cam.rays(uv[inside, 0], uv[inside, 1]) * z[inside, None]
                pw = kamera.apply(M, r)
                truth = np.array(d["pos"][k], float).reshape(G.J, 3)[inside]
                errs += list(np.linalg.norm(pw - truth, axis=1))
                # und zurück: project() trifft den Pixel der Wahrheit
                u, vv = cam.project(kamera.apply(kamera.invert(M), truth))
                self.assertLess(float(np.max(np.hypot(u - uv[inside, 0], vv - uv[inside, 1]))), 0.3, f.name)
            # uv ist auf 0,1 px gerundet: bei 3 m sind das ~1 mm
            self.assertLess(float(np.percentile(errs, 99)), 3.0, f"{f.name}: Pixel -> WELT weicht ab")


def facing_of(Pk):
    """Blickrichtung (waagrecht) aus den Schultern: (links - rechts) x oben."""
    L, R = Pk[G.IDX["left_shoulder"]], Pk[G.IDX["right_shoulder"]]
    f = np.cross(L - R, [0.0, 1.0, 0.0])
    f[1] = 0
    n = np.linalg.norm(f)
    return f / n if n > 1e-9 else None


class WeltUndSeiten(unittest.TestCase):
    """y oben, Boden y = 0, frontal: Blick nach +z und linke Hand auf +x; die Nase zeigt in die Blickrichtung."""

    def check_take(self, path, frontal):
        times, P, H, C = take.arrays(take.read(path))
        ok = (H[:, G.IDX["left_shoulder"]] != "-") & (H[:, G.IDX["right_shoulder"]] != "-") & \
             (H[:, G.IDX["nose"]] != "-") & (H[:, G.IDX["left_ankle"]] != "-")
        self.assertGreater(ok.sum(), 10, path.name)
        fz, nose_fwd, up, feet = [], [], [], []
        for k in np.where(ok)[0]:
            f = facing_of(P[k])
            if f is None:
                continue
            fz.append(f[2])
            neck = (P[k, G.IDX["left_shoulder"]] + P[k, G.IDX["right_shoulder"]]) / 2
            nose_fwd.append(float(np.dot(P[k, G.IDX["nose"]] - neck, f)))
            up.append(P[k, G.IDX["nose"]][1] - P[k, G.IDX["left_ankle"]][1])
            feet.append(min(P[k, G.IDX["left_ankle"]][1], P[k, G.IDX["right_ankle"]][1]))
        # die Nase liegt vor den Schultern (sonst wären links und rechts vertauscht)
        self.assertGreater(np.mean(np.array(nose_fwd) > 0), 0.9, f"{path.name}: Seiten vertauscht?")
        self.assertGreater(np.median(up), 1200, f"{path.name}: y zeigt nicht nach oben")
        self.assertTrue(30 < np.median(feet) < 200, f"{path.name}: Knöchel {np.median(feet):.0f} mm über dem Boden")
        if frontal:
            self.assertGreater(np.median(fz), 0.8, f"{path.name}: schaut nicht nach +z (zur Kinect)")
            lx = P[ok, G.IDX["left_wrist"], 0] - P[ok, G.IDX["right_wrist"], 0]
            self.assertGreater(np.mean(lx[np.isfinite(lx)] > -50), 0.8, f"{path.name}: linke Hand nicht auf +x")
        return np.median(fz)

    def test_truth(self):
        f = SYN / "synth-coil.truth.json.gz"
        if not f.exists():
            self.skipTest("synth-coil fehlt")
        self.check_take(f, frontal=True)
        g = SYN / "synth-throw.truth.json.gz"
        if g.exists():  # Kinect rechts vom Werfer: er schaut nach +x
            times, P, H, C = take.arrays(take.read(g))
            self.assertGreater(np.median([facing_of(P[k])[0] for k in range(0, len(P), 10)]), 0.8)

    def test_evaluated_takes_keep_the_sides(self):
        """Ausgewertete Takes (auswertung.pipeline; leichtes Modell oder wahre 2D-Pixel) haben dieselben Seiten."""
        found = sorted(SYN.glob("synth-coil.take-*.json.gz")) if SYN.exists() else []
        if not found:
            self.skipTest("keine ausgewerteten synthetischen Takes in output/synthetic")
        for f in found:
            fz = self.check_take(f, frontal=True)
            self.assertGreater(fz, 0.8)


if __name__ == "__main__":
    unittest.main()
