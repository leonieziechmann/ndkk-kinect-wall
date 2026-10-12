"""Tests der Auswertung (mocap/auswerten.py, Paket mocap/auswertung).

    python kabel-wickeln/mocap/tests/test_auswerten.py            alle (die synthetischen nur, wenn es sie gibt)
    python kabel-wickeln/mocap/tests/test_auswerten.py -v Einheit  nur die schnellen Einzeltests

Braucht numpy; der Test des leichten Modells zusätzlich onnxruntime. Die synthetischen Aufnahmen kommen aus
`node mocap/synthetic/erzeugen.mjs` (output/synthetic/, ~640 MB); fehlen sie, werden diese Tests übersprungen.
Alles, was die Tests schreiben, landet in einem temporären Ordner.

Was geprüft wird:
- Einheit: .k2rec lesen (auch abgeschnitten, kaputt, falsche Version), Kamera (Strahl <-> Pixel, Spiegelung),
  Boden (RANSAC mit Tisch und Wand), WELT-Matrix, Tiefengruppen mit fliegenden Pixeln, Knochenlänge auf dem Strahl,
  Glättung/30 fps/Ausreißer/Lücken, Handsystem und Krümmung, Take-Datei schreiben/lesen/prüfen, Klatschen.
- Synthetisch, Wahrheit-2D: die wahren Pixel der Gelenke durch die 3D-Kette (Tiefe, Boden, WELT, Knochen, Glättung).
  Der Fehler hier kommt nur von der Kette selbst; er muss klein sein (Körper sichtbar im Mittel < 20 mm).
- Synthetisch, leichtes Modell (YOLO11s-ONNX): die ganze Auswertung; die Fehler kommen jetzt vor allem aus 2D.
- Kabel auf synth-coil: Trefferquote, Genauigkeit, 3D-Abstand zum wahren Kabel.
"""

import gzip
import json
import math
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
MOCAP = HERE.parent
sys.path.insert(0, str(MOCAP))

from auswertung import gelenke as G  # noqa: E402
from auswertung import haende, heben, kamera, marker, pipeline, take, vergleich  # noqa: E402
from auswertung.k2rec import K2Rec, K2RecError, write_k2rec  # noqa: E402

SYN = MOCAP.parent / "output" / "synthetic"
KINECT = {"fx": 365.6, "fy": 365.6, "cx": 256.9, "cy": 211.4, "k1": 0.0904, "k2": -0.2694, "k3": 0.0935, "p1": 0.0, "p2": 0.0}


def lut_from_params(p, W=512, H=424):
    """LUT wie kinect-hub/src/lut.rs (Fixpunkt-Inversion der Verzeichnung)."""
    f = np.float32
    u, v = np.meshgrid(np.arange(W, dtype=f), np.arange(H, dtype=f))
    xd = (u - f(p["cx"])) / f(p["fx"])
    yd = (v - f(p["cy"])) / f(p["fy"])
    x, y = xd.copy(), yd.copy()
    k1, k2, k3, p1, p2 = (f(p[k]) for k in ("k1", "k2", "k3", "p1", "p2"))
    for _ in range(12):
        r2 = x * x + y * y
        kr = f(1) + ((k3 * r2 + k2) * r2 + k1) * r2
        dx = p2 * (r2 + f(2) * x * x) + f(2) * p1 * x * y
        dy = p1 * (r2 + f(2) * y * y) + f(2) * p2 * x * y
        x = (xd - dx) / kr
        y = (yd - dy) / kr
    return np.stack([x, y], -1).astype(np.float32)


def have(name):
    return (SYN / f"{name}.k2rec").exists() and (SYN / f"{name}.truth.json.gz").exists()


class Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="auswerten-test-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


# ---------------------------------------------------------------------------------------- Einheit

class EinheitK2Rec(Tmp):
    W, H = 4, 3

    def sample(self, n=5):
        lut = (np.arange(self.W * self.H * 2, dtype=np.float32) * 0.01).reshape(self.H, self.W, 2)
        frames = []
        for i in range(n):
            depth = (1000 + i * 10 + np.arange(self.W * self.H)).reshape(self.H, self.W).astype(np.uint16)
            ir = np.full((self.H, self.W), i, np.uint8) if i % 2 == 0 else None
            frames.append((100 + i, 1_000_000 + i * 33_333, depth, ir))
        p = self.tmp / "x.k2rec"
        write_k2rec(p, {"fx": 365.5}, lut, frames)
        return p

    def test_round_trip(self):
        p = self.sample(5)
        with K2Rec(p) as r:
            self.assertEqual((r.width, r.height, len(r)), (self.W, self.H, 5))
            self.assertEqual(r.params["fx"], 365.5)
            self.assertAlmostEqual(float(r.lut.reshape(-1)[3]), 0.03, places=6)
            self.assertTrue(np.allclose(r.times, np.arange(5) * 0.033333))
            d, ir = r.frame(2)
            self.assertEqual(int(d[0, 0]), 1020)
            self.assertEqual(int(ir[-1, -1]), 2)
            d, ir = r.frame(3)
            self.assertIsNone(ir)
            self.assertIsNone(r.damaged_tail)
            self.assertEqual(r.skipped, 0)

    def test_cut_off_keeps_whole_frames(self):
        p = self.sample(4)
        data = p.read_bytes()
        cut = self.tmp / "cut.k2rec.part"
        cut.write_bytes(data[:-5])
        with K2Rec(cut) as r:
            self.assertEqual(len(r), 3)
            self.assertIn("abgeschnitten", r.damaged_tail)

    def test_rejects_garbage(self):
        bad = self.tmp / "bad.k2rec"
        bad.write_bytes(b"hello")
        self.assertRaises(K2RecError, K2Rec, bad)
        bad.write_bytes(bytes(4096))
        self.assertRaises(K2RecError, K2Rec, bad)
        data = bytearray(self.sample(1).read_bytes())
        data[4] = 9
        bad.write_bytes(bytes(data))
        with self.assertRaisesRegex(K2RecError, "Formatversion 9"):
            K2Rec(bad)
        lut = np.zeros((self.H, self.W, 2), np.float32)
        write_k2rec(bad, {}, lut, [])
        with self.assertRaisesRegex(K2RecError, "keine ganzen Frames"):
            K2Rec(bad)

    def test_sequence_gaps(self):
        lut = np.zeros((self.H, self.W, 2), np.float32)
        d = np.zeros((self.H, self.W), np.uint16)
        p = self.tmp / "gap.k2rec"
        write_k2rec(p, {}, lut, [(10, 0, d, None), (11, 33_333, d, None), (14, 133_333, d, None)])
        with K2Rec(p) as r:
            self.assertEqual(r.skipped, 2)
            self.assertAlmostEqual(float(r.times[-1]), 0.133333, places=5)


class EinheitKamera(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.lut = lut_from_params(KINECT)
        cls.cam = kamera.Camera(KINECT, cls.lut)

    def test_ray_pixel_round_trip(self):
        rng = np.random.default_rng(3)
        u = rng.uniform(5, 506, 200)
        v = rng.uniform(5, 418, 200)
        z = rng.uniform(600, 4000, 200)
        pc = self.cam.rays(u, v) * z[:, None]
        uu, vv = self.cam.project(pc)
        self.assertLess(float(np.max(np.hypot(uu - u, vv - v))), 0.02)

    def test_mirroring(self):
        # Hub-Bild ist gespiegelt: ein Pixel rechts der Bildmitte liegt in KAMERA links (x < 0)
        r = self.cam.rays(np.array([400.0]), np.array([211.4]))[0]
        self.assertLess(r[0], 0)
        self.assertAlmostEqual(r[0], -float(kamera.lut_bilinear(self.lut, np.array([400.0]), np.array([211.4]))[0, 0]), places=6)
        pts = kamera.camera_points(np.full((424, 512), 2000, np.uint16), self.lut)
        self.assertTrue(np.allclose(pts[100, 400], [-self.lut[100, 400, 0] * 2000, self.lut[100, 400, 1] * 2000, 2000]))

    def test_world_from_floor(self):
        a = math.radians(10)
        n = kamera.expected_floor_normal(-10)
        self.assertTrue(np.allclose(n, [0, -math.cos(a), -math.sin(a)]))
        m = kamera.world_from_floor(n, 1200.0)
        R = m[:3, :3]
        self.assertTrue(np.allclose(R @ R.T, np.eye(3)))
        self.assertAlmostEqual(float(np.linalg.det(R)), 1.0)
        # wie die Wahrheit von synthetic/generate.ts
        want = np.array([[1, 0, 0, 0], [0, -0.984808, -0.173648, 1200], [0, 0.173648, -0.984808, 0], [0, 0, 0, 1]])
        self.assertTrue(np.allclose(m, want, atol=1e-5))
        # Sensor im Ursprung -> (0, Höhe, 0); ein Punkt auf der optischen Achse liegt bei -z (vor dem Sensor)
        self.assertTrue(np.allclose(kamera.apply(m, [0, 0, 0]), [0, 1200, 0]))
        p = kamera.apply(m, [0, 0, 2000])
        self.assertLess(p[2], -1900)
        # Punkt auf dem Boden: Höhe 0
        foot = np.array([0.0, 0.0, 0.0])
        # Boden in KAMERA: n . p + d = 0 -> Punkt 1200 mm "unter" der Kamera entlang -n
        foot = -1200.0 * n
        self.assertAlmostEqual(float(kamera.apply(m, foot)[1]), 0.0, places=6)
        # x = y × z: rechts vom Sensor aus gesehen (KAMERA +x) ist WELT +x
        self.assertGreater(kamera.apply(m, [500, 0, 2000])[0], 400)

    def test_fit_floor_with_table_and_wall(self):
        rng = np.random.default_rng(5)
        n = kamera.expected_floor_normal(-20)
        m = kamera.world_from_floor(n, 1500.0)
        inv = kamera.invert(m)
        floor = np.stack([rng.uniform(-1500, 1500, 6000), np.zeros(6000), rng.uniform(-3500, -800, 6000)], 1)
        table = np.stack([rng.uniform(-600, 600, 9000), np.full(9000, 750.0), rng.uniform(-1500, -800, 9000)], 1)
        wall = np.stack([rng.uniform(-1500, 1500, 3000), rng.uniform(0, 2000, 3000), np.full(3000, -3600.0)], 1)
        pts = kamera.apply(inv, np.concatenate([floor, table, wall]))
        pts += rng.normal(0, 3, pts.shape)
        f = kamera.fit_floor(pts, rng, n, 1500.0)
        self.assertLess(math.degrees(math.acos(min(1.0, abs(float(f["normal"] @ n))))), 0.3)
        self.assertLess(abs(f["d_mm"] - 1500.0), 5)
        # ohne Höhenangabe: die unterste große Ebene (nicht der Tisch mit mehr Punkten)
        f2 = kamera.fit_floor(pts, np.random.default_rng(6), n, None)
        self.assertLess(abs(f2["d_mm"] - 1500.0), 5)


class EinheitHeben(unittest.TestCase):
    def test_density_clusters_with_flying_pixels(self):
        rng = np.random.default_rng(1)
        hand = rng.normal(1700, 3, 30)
        body = rng.normal(1930, 3, 20)
        flying = np.linspace(1720, 1910, 8)  # fliegende Pixel zwischen Hand und Körper
        cl = heben.density_clusters(np.sort(np.concatenate([hand, body, flying]).astype(np.float32)))
        zs = [c[0] for c in cl]
        self.assertEqual(len(cl), 2, cl)
        self.assertAlmostEqual(zs[0], 1700, delta=5)
        self.assertAlmostEqual(zs[1], 1930, delta=5)

    def test_solve_on_ray(self):
        P = np.array([100.0, -200.0, 2000.0])
        ray = np.array([0.15, -0.05, 1.0])
        ray /= np.linalg.norm(ray)
        for prefer in (1800.0, 2400.0):
            p, ok = heben.solve_on_ray(ray, P, 300.0, prefer)
            self.assertTrue(ok)
            self.assertAlmostEqual(float(np.linalg.norm(p - P)), 300.0, places=3)
            self.assertAlmostEqual(float(np.linalg.norm(np.cross(p, ray))), 0.0, places=6)
        near, _ = heben.solve_on_ray(ray, P, 300.0, 1000.0)
        far, _ = heben.solve_on_ray(ray, P, 300.0, 5000.0)
        self.assertLess(np.linalg.norm(near), np.linalg.norm(far))

    def test_smooth_resample(self):
        rng = np.random.default_rng(2)
        t = np.cumsum(np.full(150, 1 / 30) + rng.normal(0, 0.002, 150))
        t -= t[0]
        traj = lambda tt: np.stack([400 * np.sin(2 * tt), 1000 + 200 * np.cos(3 * tt), -2000 + 100 * tt], -1)
        P = np.full((150, G.J, 3), np.nan)
        P[:, 9] = traj(t) + rng.normal(0, 3, (150, 3))
        how = np.full((150, G.J), "-", dtype="<U1")
        how[:, 9] = "D"
        conf = np.zeros((150, G.J))
        conf[:, 9] = 0.9
        P[40, 9] += [0, 0, 400]          # Ausreißer
        how[80:95, 9] = "-"              # Lücke 0,5 s
        P[80:95, 9] = np.nan
        grid = np.arange(0, t[-1], 1 / 30)
        pos, h, c, out, jit = heben.smooth_resample(t, P, how, conf, grid, max_gap=1.0)
        err = np.linalg.norm(pos[:, 9] - traj(grid), axis=1)
        self.assertLess(float(np.median(err)), 4.0)
        self.assertLess(float(err[np.abs(grid - t[40]) < 0.02].max()), 25.0)  # Ausreißer verworfen
        self.assertGreaterEqual(out[9], 1)
        gap = (grid > t[81]) & (grid < t[93])
        self.assertTrue(np.all(h[gap, 9] == "I"))
        self.assertLess(float(err[gap].max()), 60.0)
        self.assertTrue(np.all(h[:, 0] == "-"))
        self.assertAlmostEqual(float(jit[9]), 3 * math.sqrt(3) * 0.85, delta=3.0)

    def test_interpolate_2d(self):
        kp = np.zeros((7, G.J, 3), np.float32)
        kp[0, 5] = [100, 50, 0.9]
        kp[6, 5] = [160, 80, 0.7]
        out = heben.interpolate_2d(kp, [0, 6], 7)
        self.assertTrue(np.allclose(out[3, 5], [130, 65, 0.56]))


class EinheitHaende(unittest.TestCase):
    def hand(self, side, bend=0.0):
        """Hand in WELT: Finger nach oben (+y), Handfläche zur Kamera (+z), Daumen zur Seite."""
        pos = np.full((1, G.J, 3), np.nan)
        conf = np.zeros((1, G.J))
        # Fläche nach +z (zur Kinect): der Daumen liegt innen, zur Körpermitte; rechte Hand -> +x, linke -> -x
        thumb_dir = 1.0 if side == "right" else -1.0
        base = {"wrist": (0, 0, 0)}
        for k, finger in enumerate(["index", "middle", "ring", "pinky"]):
            x = thumb_dir * [24, 0, -18, -34][k]
            joints = [(x, 90, 0)]
            y, z = 90.0, 0.0
            ang = 0.0
            for seg in (45, 28, 22):
                ang += bend
                y += seg * math.cos(ang)
                z += seg * math.sin(ang)  # Beugen Richtung Handfläche (+z)
                joints.append((x, y, z))
            for nm, p in zip(("mcp", "pip", "dip", "tip"), joints):
                base[f"{finger}_{nm}"] = p
        for nm, p in zip(("thumb_cmc", "thumb_mcp", "thumb_ip", "thumb_tip"), ((thumb_dir * 25, 25, 0), (thumb_dir * 45, 55, 0),
                                                                             (thumb_dir * 60, 80, 0), (thumb_dir * 70, 100, 0))):
            base[nm] = p
        for nm, p in base.items():
            j = G.IDX[f"{side}_hand_{nm}"]
            pos[0, j] = p
            conf[0, j] = 0.9
        return pos, conf

    def test_frames_and_curl(self):
        for side in ("left", "right"):
            pos, conf = self.hand(side)
            o, ax, curl, hc = haende.hand_frames(pos, conf, side)
            self.assertTrue(np.allclose(ax[0, 0], [0, 1, 0], atol=1e-6))   # x entlang der Hand
            self.assertGreater(ax[0, 1] @ (pos[0, G.IDX[f"{side}_hand_thumb_tip"]] - o[0]), 0)  # y zum Daumen
            self.assertTrue(np.allclose(ax[0, 2], [0, 0, -1], atol=1e-6))  # z aus dem Handrücken (Fläche zeigt +z)
            self.assertLess(float(np.nanmax(curl[0, 1:])), 0.05)
            pos2, conf2 = self.hand(side, bend=math.radians(60))
            _, _, curl2, _ = haende.hand_frames(pos2, conf2, side)
            self.assertAlmostEqual(float(curl2[0, 2]), 180 / 270, delta=0.03)
        blk = haende.hands_block(pos, conf)
        self.assertEqual(blk[0]["left"], None)  # zuletzt nur die rechte Hand gebaut
        self.assertEqual(len(blk[0]["right"]["axes"]), 9)
        self.assertEqual(blk[0]["right"]["axes"][6:], [0, 0, -1000])


class EinheitTake(Tmp):
    def test_write_read_check(self):
        K = 5
        pos = np.random.default_rng(0).normal(0, 500, (K, G.J, 3))
        how = np.full((K, G.J), "D", dtype="<U1")
        how[2, 3] = "-"
        conf = np.full((K, G.J), 0.8)
        P, Hs, C = take.encode_frames(pos, how, conf)
        m = kamera.world_from_floor(kamera.expected_floor_normal(-10), 1200.0)
        doc = {"format": take.FORMAT, "version": take.VERSION, "kind": "take", "shot": "x", "take": 1, "source": "x.k2rec",
               "recorded_at": take.iso_utc(1.7e15), "setup": "A", "fps": 30.0, "frames": K, "t": {"t0": 0.5, "dt": 1 / 30},
               "camera": {}, "floor": {"normal": m[1, :3].tolist(), "d_mm": 1200.0}, "world": {"cam_to_world": m.reshape(-1).tolist()},
               "joints": G.JOINTS, "pos": P, "conf": C, "how": Hs, "cable": [[] for _ in range(K)], "quality": {},
               "markers": {"clap": None, "start": None, "end": None}}
        p = take.write(self.tmp / "x_t1.json.gz", doc)
        back = take.read(p)
        self.assertEqual(take.check(back), [])
        t, pos2, how2, conf2 = take.arrays(back)
        self.assertTrue(np.allclose(t, 0.5 + np.arange(K) / 30))
        self.assertTrue(np.isnan(pos2[2, 3, 0]))
        ok = how2 != "-"
        self.assertLess(float(np.max(np.abs(pos2[ok] - pos[ok]))), 0.51)
        # im Browser: gzip-JSON
        with gzip.open(p, "rt", encoding="utf-8") as f:
            self.assertEqual(json.load(f)["format"], "kabel-wickeln-take")
        bad = dict(back, how=["X" * G.J] * K)
        self.assertTrue(take.check(bad))


class EinheitMarker(unittest.TestCase):
    def test_clap(self):
        t = np.arange(0, 6, 1 / 30)
        K = len(t)
        pos = np.full((K, G.J, 3), np.nan)
        conf = np.zeros((K, G.J))
        for n, y in (("left_shoulder", 1400), ("right_shoulder", 1400), ("left_hip", 900), ("right_hip", 900)):
            pos[:, G.IDX[n]] = [0, y, -2000]
            conf[:, G.IDX[n]] = 0.9
        gap = 450 - 400 * np.exp(-((t - 2.3) / 0.12) ** 2)  # Hände schnell zusammen bei 2,3 s
        for side, sgn in (("left", 1), ("right", -1)):
            pos[:, G.IDX[f"{side}_wrist"]] = np.stack([sgn * gap / 2, np.full(K, 1200), np.full(K, -1800)], 1)
            conf[:, G.IDX[f"{side}_wrist"]] = 0.9
        c = marker.find_clap(t, pos, conf, signal_s=2.0)
        self.assertIsNotNone(c["time"])
        self.assertAlmostEqual(c["time"], 2.3, delta=0.02)
        self.assertIsNone(marker.find_clap(t, pos, conf, signal_s=4.5)["time"])  # außerhalb des Suchfensters


# ---------------------------------------------------------------------------------------- Synthetisch

def run_truth2d(test, name, frames=None, cable=False):
    rec = SYN / f"{name}.k2rec"
    truth = vergleich.load_truth(SYN / f"{name}.truth.json.gz")
    kp = vergleich.truth_kp2d(truth, only_visible=True)
    opts = pipeline.Options(vorschau=False, kabel="dunkel" if cable else "aus", ganz=True, quiet=True,
                            max_frames=frames, kp2d_dir=test.tmp, video_dir=test.tmp)
    res = pipeline.evaluate(rec, opts, test.tmp, kp2d=kp, truth_meta=truth)
    return res["doc"][0], truth


@unittest.skipUnless(have("synth-coil") and have("synth-tpose"), "synthetische Aufnahmen fehlen (node mocap/synthetic/erzeugen.mjs)")
class SynthetischWahrheit2D(Tmp):
    """Die wahren 2D-Pixel durch die 3D-Kette: prüft Tiefe, Strahl, Boden, WELT, Knochen und Glättung."""

    def check(self, name, body_mean_mm, limb_mean_mm):
        doc, truth = run_truth2d(self, name)
        self.assertEqual(take.check(doc), [])
        per = vergleich.mpjpe(doc, truth)
        print("\n" + vergleich.report(per, f"{name}, wahre 2D-Pixel -> 3D (Fehler in mm):"))
        rows = {g: (ev, eo) for g, ev, eo in vergleich.summarize(per)}
        body = rows["Körper (COCO 17)"][0]
        limbs = np.concatenate([rows["Arme (Ellbogen, Handgelenke)"][0], rows["Beine (Knie, Knöchel)"][0]])
        self.assertLess(float(np.mean(body)), body_mean_mm)
        self.assertLess(float(np.mean(limbs)), limb_mean_mm)
        n = np.array(doc["floor"]["normal"])
        ang = math.degrees(math.acos(min(1.0, float(n @ np.array(truth["floor"]["normal"])))))
        self.assertLess(ang, 0.3)
        self.assertLess(abs(doc["floor"]["d_mm"] - truth["floor"]["d_mm"]), 6)
        self.assertIsNotNone(doc["markers"]["clap"])
        self.assertLess(abs(doc["markers"]["clap"] - truth["markers"]["clap"]), 0.1)
        self.assertLess(abs(doc["markers"]["end"] - truth["markers"]["end"]), 1.0)
        return doc, truth

    def test_coil(self):
        doc, truth = self.check("synth-coil", 20, 15)
        hands = [j for j, n in enumerate(G.JOINTS) if "_hand_" in n]
        per = vergleich.mpjpe(doc, truth)
        hv = np.concatenate([per[G.JOINTS[j]]["vis"] for j in hands])
        self.assertLess(float(np.median(hv)), 15)

    def test_tpose(self):
        self.check("synth-tpose", 20, 15)

    @unittest.skipUnless(have("synth-throw"), "synth-throw fehlt")
    def test_throw_side_view(self):
        doc, truth = run_truth2d(self, "synth-throw")
        per = vergleich.mpjpe(doc, truth)
        print("\n" + vergleich.report(per, "synth-throw (Kinect seitlich, 3,2 m), wahre 2D-Pixel -> 3D:"))
        rows = {g: (ev, eo) for g, ev, eo in vergleich.summarize(per)}
        self.assertLess(float(np.median(rows["Körper (COCO 17)"][0])), 15)
        self.assertLess(float(np.median(rows["Beine (Knie, Knöchel)"][0])), 15)

    def test_cable(self):
        doc, truth = run_truth2d(self, "synth-coil", frames=120, cable=True)
        rec = K2Rec(SYN / "synth-coil.k2rec")
        cam = kamera.Camera(rec.params, rec.lut)
        rec.close()
        s = vergleich.cable_scores(doc, truth, cam)
        print(f"\nKabel synth-coil (120 Frames): Treffer {s['recall'] * 100:.0f} % der wahren Punkte nahe den Händen, "
              f"{s['precision'] * 100:.0f} % der gefundenen Punkte liegen am Kabel, 3D-Abstand Median {s['d3_median_mm']:.0f} mm, "
              f"90 % {s['d3_p90_mm']:.0f} mm")
        self.assertGreater(s["recall"], 0.5)
        self.assertGreater(s["precision"], 0.8)
        self.assertLess(s["d3_median_mm"], 30)

    def test_truncated_real_recording(self):
        src = SYN / "synth-tpose.k2rec"
        with K2Rec(src) as r:
            size = r._off[3] + 1000  # mitten im 4. Frame abgeschnitten
        part = self.tmp / "abgebrochen.k2rec.part"
        with open(src, "rb") as f:
            part.write_bytes(f.read(size))
        with K2Rec(part) as r:
            self.assertEqual(len(r), 3)
            self.assertIsNotNone(r.damaged_tail)
            d, ir = r.frame(2)
            self.assertEqual(d.shape, (424, 512))


def onnx_ok():
    try:
        import onnxruntime  # noqa: F401
        return pipeline.LIGHT_MODEL.exists()
    except ImportError:
        return False


@unittest.skipUnless(have("synth-coil") and onnx_ok(), "synth-coil oder onnxruntime/web-Modell fehlen")
class SynthetischLeicht(Tmp):
    """Die ganze Auswertung mit dem leichten Modell (YOLO11s-ONNX, nur Körper) auf jedem 2. Frame."""

    def test_coil_light(self):
        truth = vergleich.load_truth(SYN / "synth-coil.truth.json.gz")
        opts = pipeline.Options(modell="leicht", every=2, vorschau=True, kabel="dunkel", quiet=True,
                                kp2d_dir=self.tmp, video_dir=self.tmp)
        res = pipeline.evaluate(SYN / "synth-coil.k2rec", opts, self.tmp, truth_meta=truth)
        doc = res["doc"][0]
        self.assertEqual(take.check(doc), [])
        per = vergleich.mpjpe(doc, truth)
        print("\n" + vergleich.report(per, "synth-coil, leichtes Modell (YOLO11s-ONNX, jeder 2. Frame) -> 3D:"))
        rows = {g: (ev, eo) for g, ev, eo in vergleich.summarize(per)}
        self.assertLess(float(np.mean(rows["Körper (COCO 17)"][0])), 70)
        self.assertLess(float(np.mean(rows["Arme (Ellbogen, Handgelenke)"][0])), 50)
        self.assertIsNotNone(doc["markers"]["clap"])
        self.assertLess(abs(doc["markers"]["clap"] - truth["markers"]["clap"]), 0.15)
        self.assertTrue(any(self.tmp.glob("synth-coil.auswertung*")))
        self.assertTrue(any(self.tmp.glob("synth-coil.kp2d-leicht-e2.json.gz")))
        self.assertTrue((self.tmp / "synth-coil.json.gz").exists())


def copy_frames(src, dst, n):
    """Die ersten n Frames einer .k2rec in eine neue Datei (wie eine kurze Aufnahme)."""
    with K2Rec(src) as r:
        end = r._off[n - 1] + r.width * r.height * (3 if r.has_ir[n - 1] else 2) if n < len(r) else Path(src).stat().st_size
    with open(src, "rb") as f, open(dst, "wb") as g:
        g.write(f.read(end))


@unittest.skipUnless(have("synth-coil") and onnx_ok(), "synth-coil oder onnxruntime/web-Modell fehlen")
class SitzungsOrdner(Tmp):
    """Ein Termin-Ordner wie vom Aufnahme-Tool: sitzung.json, Kalibrierung, behaltene und verworfene Takes."""

    def test_folder_with_session_log(self):
        import subprocess
        t1 = self.tmp / "termin1"
        t1.mkdir()
        copy_frames(SYN / "synth-coil.k2rec", t1 / "cal.A.empty_t1.k2rec", 20)
        copy_frames(SYN / "synth-coil.k2rec", t1 / "p1.coil.teach_t1.k2rec", 75)
        copy_frames(SYN / "synth-coil.k2rec", t1 / "p1.coil.teach_t2.k2rec", 30)
        log = {"format": "kabel-wickeln mocap sitzung", "version": 1, "session": 1, "placements": {"A": [{"n": 1}]},
               "takes": [
                   {"shot": "cal.A.empty", "take": 1, "file": "cal.A.empty_t1.k2rec", "setup": "A", "placement": 1, "keep": True},
                   {"shot": "p1.coil.teach", "take": 1, "file": "p1.coil.teach_t1.k2rec", "setup": "A", "placement": 1,
                    "keep": True, "signal_in_recording_s": 0.8},
                   {"shot": "p1.coil.teach", "take": 2, "file": "p1.coil.teach_t2.k2rec", "setup": "A", "placement": 1, "keep": False}]}
        (t1 / "sitzung.json").write_text(json.dumps(log), encoding="utf-8")
        out = self.tmp / "takes"
        r = subprocess.run([sys.executable, str(MOCAP / "auswerten.py"), str(t1), "--modell", "leicht", "--every", "3",
                            "--ziel", str(out), "--ohne-video", "--kabel", "aus"], capture_output=True, text=True,
                           encoding="utf-8", env=dict(os.environ, PYTHONUTF8="1"))
        print(r.stdout[-1500:], r.stderr[-1500:])
        self.assertEqual(r.returncode, 0)
        self.assertIn("Kalibrierung ohne Person", r.stdout)
        self.assertEqual(sorted(p.name for p in out.glob("*.json.gz")), ["p1.coil.teach_t1.json.gz"])  # t2 verworfen
        doc = take.read(out / "p1.coil.teach_t1.json.gz")
        self.assertEqual(take.check(doc), [])
        self.assertEqual((doc["shot"], doc["take"], doc["setup"]), ("p1.coil.teach", 1, "A"))
        self.assertIn("cal.A.empty_t1.k2rec", doc["floor"]["source"])
        self.assertEqual(doc["meta"]["signal_in_recording_s"], 0.8)
        self.assertIn("Startsignal", doc["quality"]["clap"]["searched"])
        self.assertEqual(doc["kinect"]["height_m"], 1.2)  # aus shots.json (Aufbau A)
        self.assertTrue((t1 / "p1.coil.teach_t1.kp2d-leicht-e3.json.gz").exists())
        self.assertTrue((t1 / "p1.coil.teach_t1.auswertung.txt").exists())


class Kommandozeile(Tmp):
    def test_help_and_no_args(self):
        import subprocess
        r = subprocess.run([sys.executable, str(MOCAP / "auswerten.py"), "--help"], capture_output=True, text=True,
                           encoding="utf-8", env=dict(os.environ, PYTHONUTF8="1"))
        self.assertEqual(r.returncode, 0)
        self.assertIn("--modell", r.stdout)
        r = subprocess.run([sys.executable, str(MOCAP / "auswerten.py")], capture_output=True, text=True, encoding="utf-8",
                           env=dict(os.environ, PYTHONUTF8="1"))
        self.assertEqual(r.returncode, 2)

    @unittest.skipUnless(have("synth-tpose"), "synth-tpose fehlt")
    def test_colab_package_needs_yes(self):
        import subprocess
        r = subprocess.run([sys.executable, str(MOCAP / "auswerten.py"), "--colab-paket", str(self.tmp), str(SYN / "synth-tpose.k2rec")],
                           input="nein\n", capture_output=True, text=True, encoding="utf-8", env=dict(os.environ, PYTHONUTF8="1"))
        self.assertEqual(r.returncode, 1)
        self.assertEqual(list(self.tmp.glob("*.zip")), [])


if __name__ == "__main__":
    unittest.main()
