#!/usr/bin/env python3
"""Tests für mocap/aufnahme.py ohne Kinect: ein Mock-Hub (HTTP) und eine falsche Probe.

    python kabel-wickeln/mocap/tests/test_aufnahme.py            # alle Tests (unittest, nur Standardbibliothek)
    python kabel-wickeln/mocap/tests/test_aufnahme.py -v MockSession

Diese Datei ist zugleich die falsche Probe: `python test_aufnahme.py record --seconds N --out F --url U`
benimmt sich wie `kinect-hub-probe record` (gleiche Ausgabe, kleine gültige .k2rec mit 4×3 Pixeln).
Umgebung der falschen Probe: FAKE_PROBE_SCALE (Zeitfaktor, 1 = Echtzeit), FAKE_PROBE_MODE (ok, fail, noframes).
Alles läuft in einem temporären Ordner; nichts landet im Repository.
"""

from __future__ import annotations

import http.server
import json
import os
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
MOCAP = HERE.parent
TOOL = MOCAP / "aufnahme.py"
sys.path.insert(0, str(MOCAP))

import aufnahme  # noqa: E402

FAKE_W, FAKE_H = 4, 3

# ---------------------------------------------------------------------------------------------
# .k2rec schreiben (Format: kinect-hub/src/recording.rs)


def k2rec_header(w: int, h: int, info: dict) -> bytes:
    info_b = json.dumps(info).encode()
    lut = struct.pack(f"<{w * h * 2}f", *([0.0] * (w * h * 2)))
    head = struct.pack("<IIIHHIIQ", aufnahme.K2REC_MAGIC, 1, 32 + len(info_b) + len(lut), w, h, len(info_b), len(lut), 0)
    return head + info_b + lut


def k2rec_frame(seq: int, capture_us: int, w: int, h: int, ir: bool = True) -> bytes:
    depth = struct.pack(f"<{w * h}H", *([1500] * (w * h)))
    irb = bytes([100] * (w * h)) if ir else b""
    return struct.pack("<IIQHHI", aufnahme.K2REC_FRAME, seq, capture_us, 1 if ir else 0, 0, len(depth) + len(irb)) + depth + irb


def write_k2rec(path: Path, frames: int, start_us: int = 1_700_000_000_000_000, w: int = FAKE_W, h: int = FAKE_H) -> None:
    with open(path, "wb") as f:
        f.write(k2rec_header(w, h, {"params": {}, "recorded_at_us": start_us}))
        for i in range(frames):
            f.write(k2rec_frame(i, start_us + i * 33_333, w, h))


# ---------------------------------------------------------------------------------------------
# Falsche Probe


def fake_probe(argv: list[str]) -> int:
    args = {"--seconds": "10", "--url": "ws://127.0.0.1:8090/ws", "--out": None}
    it = iter(argv)
    for a in it:
        if a in args:
            args[a] = next(it)
        elif a != "record":
            print(f"unknown argument {a}", file=sys.stderr, flush=True)
            return 2
    scale = float(os.environ.get("FAKE_PROBE_SCALE", "1"))
    mode = os.environ.get("FAKE_PROBE_MODE", "ok")
    seconds = int(args["--seconds"])
    out = Path(args["--out"])
    url = args["--url"]
    if out.exists():
        print(f"record failed: {out} exists already: choose another name or delete it first", file=sys.stderr, flush=True)
        return 1
    u = urllib.parse.urlsplit(url)
    try:
        urllib.request.urlopen(f"http://{u.hostname}:{u.port}/api/status", timeout=2).read()
        if mode == "fail":
            raise OSError("Connection refused (os error 111)")
    except (OSError, urllib.error.URLError) as e:
        print(f"record failed: cannot connect to {url}: {e}", file=sys.stderr, flush=True)
        return 1
    out.parent.mkdir(parents=True, exist_ok=True)
    part = out.with_name(out.name + ".part")
    print(f"{part}: {seconds} s from {url} (hub source kinect), about 20 MB per second", flush=True)
    if mode == "noframes":
        time.sleep(0.2 * scale)
        print("record failed: no frames recorded (nothing to record within 15 s (sensor searching)); is the hub "
              "streaming? see /api/status", file=sys.stderr, flush=True)
        return 1
    time.sleep(min(0.3, 0.3 * scale))  # verbinden, LUT abwarten
    start_us = int(time.time() * 1e6)
    t0 = time.monotonic()
    total = seconds * 30
    n = 0
    reason = f"{seconds} s recorded"
    reported = 0
    with open(part, "wb") as f:
        f.write(k2rec_header(FAKE_W, FAKE_H, {"params": {"fake": True}, "recorded_at_us": start_us,
                                              "recorder": "fake-probe (test_aufnahme.py)"}))
        print("recording ...", flush=True)
        try:
            while n < total:
                due = min(total, int((time.monotonic() - t0) / max(scale, 1e-6) * 30) + 1)
                while n < due:
                    f.write(k2rec_frame(n, start_us + n * 33_333, FAKE_W, FAKE_H))
                    n += 1
                if n // 150 > reported:
                    reported = n // 150
                    print(f"  {n / 30:4.1f} s, {n} frames", flush=True)
                time.sleep(0.003)
        except KeyboardInterrupt:
            reason = "stopped with Ctrl+C"
    os.replace(part, out)
    secs = (n - 1) / 30 if n > 1 else 0.0
    size = out.stat().st_size
    print(f"{out}: {n} frames ({n} with IR), {secs:.1f} s, {30.0 if n > 1 else 0.0:.1f} fps, 0 skipped by the hub stream, "
          f"{size / 1e6:.0f} MB ({reason})\nreplay: kinect-hub --source replay {out} --bind 127.0.0.1:8091", flush=True)
    return 0


# ---------------------------------------------------------------------------------------------
# Mock-Hub


def png_gray8(w: int, h: int, pixels: bytes) -> bytes:
    raw = b"".join(b"\x00" + pixels[y * w:(y + 1) * w] for y in range(h))

    def chunk(t: bytes, d: bytes) -> bytes:
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


# eine stehende Person mitten im Bild (u, v, Konfidenz) für COCO-17
PERSON_KP = [(256, 60), (250, 55), (262, 55), (244, 60), (268, 60), (226, 110), (286, 110), (216, 170), (296, 170),
             (210, 225), (302, 225), (236, 230), (276, 230), (236, 310), (276, 310), (236, 390), (276, 390)]


def person(kp=PERSON_KP, conf: float = 0.9, score: float = 0.9) -> dict:
    flat = []
    for u, v in kp:
        flat += [u, v, conf]
    return {"score": score, "box": [200, 40, 312, 400], "kp": flat}


class MockHub:
    """Antwortet auf /api/status, /api/poses, /api/frame/ir?format=png und /api/frame/depth."""

    def __init__(self):
        self.sensor_state = "streaming"
        self.source = "kinect"
        self.poses: list | None = [person()]
        self.depth_mm = 1700
        self.requests: dict[str, int] = {}
        self.png = png_gray8(aufnahme.IMG_W, aufnahme.IMG_H, bytes((x * 255 // aufnahme.IMG_W) for _ in range(aufnahme.IMG_H)
                                                                     for x in range(aufnahme.IMG_W)))
        hub = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, body: bytes, ctype: str, extra=None):
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                for k, v in (extra or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):  # noqa: N802
                path = urllib.parse.urlsplit(self.path).path
                hub.requests[path] = hub.requests.get(path, 0) + 1
                if path == "/api/status":
                    st = {"type": "status", "source": hub.source, "fps": 30.0,
                          "sensor": {"state": hub.sensor_state, "detail": "mock", "since_unix_ms": 0},
                          "pose": {"state": "running"}, "render": []}
                    self._send(200, json.dumps(st).encode(), "application/json")
                elif path == "/api/poses":
                    doc = {"type": "poses", "seq": 1, "capture_time_us": int(time.time() * 1e6), "model": "mock",
                           "poses": hub.poses}
                    self._send(200, json.dumps(doc).encode(), "application/json")
                elif path == "/api/frame/ir":
                    self._send(200, hub.png, "image/png")
                elif path == "/api/frame/depth":
                    body = struct.pack(f"<{aufnahme.IMG_W * aufnahme.IMG_H}H", *([hub.depth_mm] * (aufnahme.IMG_W * aufnahme.IMG_H)))
                    self._send(200, body, "application/octet-stream", {"x-width": "512", "x-height": "424"})
                else:
                    self._send(404, b'{"error":"unknown"}', "application/json")

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def free_port() -> int:
    import socket  # noqa: PLC0415

    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# ---------------------------------------------------------------------------------------------
# Hilfen


class Base(unittest.TestCase):
    hub: MockHub

    @classmethod
    def setUpClass(cls):
        cls.hub = MockHub()

    @classmethod
    def tearDownClass(cls):
        cls.hub.close()

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="aufnahme-test-"))
        self.main = self.tmp / "main"
        (self.main / "recordings").mkdir(parents=True)
        self.hub.sensor_state = "streaming"
        self.hub.poses = [person()]
        self.hub.depth_mm = 1700

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    @property
    def rec(self) -> Path:
        return self.main / "recordings" / "mocap"

    def tool(self, *args: str, scale: float = 0.004, mode: str = "ok", hub: str | None = None, timeout: float = 600,
             start_new_session: bool = False, background: bool = False):
        env = dict(os.environ, FAKE_PROBE_SCALE=str(scale), FAKE_PROBE_MODE=mode, PYTHONIOENCODING="utf-8")
        cmd = [sys.executable, str(TOOL), "--main", str(self.main), "--probe", str(Path(__file__).resolve()),
               "--hub", hub or self.hub.url, "--zeitfaktor", str(scale), "--leise", "--ohne-seite", "--mb-pro-s", "1",
               *args]
        if background:
            return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                                    text=True, encoding="utf-8", env=env, start_new_session=start_new_session)
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", env=env, timeout=timeout,
                           stdin=subprocess.DEVNULL)
        return r

    def log(self, termin: int = 1) -> dict:
        return json.loads((self.rec / f"termin{termin}" / "sitzung.json").read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------------------------
# Einheiten


class Units(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.plan = aufnahme.Plan()

    def args(self, **kw):
        ns = aufnahme.parse_args([])
        for k, v in kw.items():
            setattr(ns, k, v)
        return ns

    def test_plan_numbers_like_aufnahmeplan(self):
        p = self.plan
        self.assertEqual(p.number["p1.coil.teach"], "A4")
        self.assertEqual(p.number["p3.pair.slow"], "A6")
        self.assertEqual(p.number["p4.prep"], "B12")
        self.assertEqual(p.number["p1.short.pull"], "T4")
        self.assertEqual(p.number["p1.throw.only"], "D4")
        self.assertEqual(p.resolve("a6")["id"], "p3.pair.slow")
        with self.assertRaises(aufnahme.Fatal):
            p.resolve("gibtsnicht")

    def test_selection(self):
        p = self.plan
        s = aufnahme.select_shots(p, self.args(setup=["a"]))
        self.assertTrue(all(x["setup"] == "A" for x in s))
        self.assertEqual(s[0]["id"], "cal.A.empty")
        s = aufnahme.select_shots(p, self.args(session=["2"], prio=1))
        self.assertTrue(all(x["setup"] in ("C", "D") and x["prio"] <= 1 for x in s))
        s = aufnahme.select_shots(p, self.args(from_="p3.check"))
        self.assertEqual(s[0]["id"], "p3.check")
        self.assertEqual(s[-1]["setup"], "T")  # bis zum Ende von Termin 1
        s = aufnahme.select_shots(p, self.args(shot=["p4.close,A6", "A6"]))
        self.assertEqual([x["id"] for x in s], ["p4.close", "p3.pair.slow"])
        self.assertIsNone(aufnahme.select_shots(p, self.args()))

    def test_alternating_slots(self):
        p = self.plan
        shots = [p.by_id[i] for i in ("p3.check", "p3.wrong.same", "p5.eight.hang", "p5.size.small")]
        slots = [(s["id"], k) for s, k in aufnahme.build_slots(p, shots)]
        self.assertEqual(slots, [("p3.check", 1), ("p3.check", 2), ("p3.wrong.same", 1), ("p5.eight.hang", 1),
                                 ("p3.wrong.same", 2), ("p5.eight.hang", 2), ("p5.size.small", 1)])
        # T11 (2 Takes) und T12 (1 Take): T12 direkt nach T11 Take 1
        shots = [p.by_id["p7.ribbon.pull"], p.by_id["p7.ribbon.release"]]
        self.assertEqual([(s["id"], k) for s, k in aufnahme.build_slots(p, shots)],
                         [("p7.ribbon.pull", 1), ("p7.ribbon.release", 1), ("p7.ribbon.pull", 2)])

    def test_record_seconds_and_timeline(self):
        p = self.plan
        teo = p.by_id["p2.teo.pull"]
        self.assertEqual(p.record_seconds(teo), 2 + 21 + 2 + 1)
        r = aufnahme.Recorder.__new__(aufnahme.Recorder)
        r.plan = p
        ev = r.timeline(teo)
        kinds = [k for _, k, _ in ev]
        self.assertEqual(kinds[0], "signal")
        self.assertEqual(ev[0][0], 2.0)
        self.assertEqual(kinds.count("cue"), 7)
        self.assertNotIn("endpose", kinds)  # die Cues sagen „Endpose“ schon selbst
        self.assertEqual(ev[-1][1], "end")
        self.assertEqual(ev[-1][0], 2 + 21 + 2)
        empty = r.timeline(p.by_id["cal.A.empty"])
        self.assertNotIn("signal", [k for _, k, _ in empty])

    def test_take_numbers(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "termin1").mkdir()
            (root / "termin1" / "p3.check_t1.k2rec").write_bytes(b"")
            (root / "termin1" / "p3.check_t3.k2rec.part").write_bytes(b"")
            (root / "p3.check_t2.k2rec").write_bytes(b"")  # von Hand aufgenommen
            (root / "termin1" / "p3.check.x_t9.k2rec").write_bytes(b"")  # anderer Shot
            self.assertEqual(aufnahme.next_take_number(root, "p3.check", []), 4)
            log = aufnahme.SessionLog(root / "termin1", 1)
            log.takes.append({"shot": "p3.check", "take": 7, "frames": 10})
            log.takes.append({"shot": "p3.check", "take": 9, "frames": 0, "error": "x"})  # Fehlversuch zählt nicht
            self.assertEqual(aufnahme.next_take_number(root, "p3.check", [log]), 8)

    def test_parse_probe_output(self):
        lines = ["C:\\rec\\x.k2rec.part: 35 s from ws://127.0.0.1:8090/ws (hub source kinect), about 20 MB per second",
                 "recording ...", "   5.0 s, 150 frames",
                 "note: 3 of 1050 frames came without IR",
                 "C:\\rec\\x.k2rec: 1050 frames (1047 with IR), 34.9 s, 30.0 fps, 2 skipped by the hub stream, 683 MB (35 s recorded)",
                 "replay: kinect-hub --source replay C:\\rec\\x.k2rec --bind 127.0.0.1:8091"]
        info = aufnahme.parse_probe_output(lines)
        self.assertEqual((info["frames"], info["frames_ir"], info["fps"], info["skipped"], info["size_mb"]),
                         (1050, 1047, 30.0, 2, 683.0))
        self.assertEqual(info["reason"], "35 s recorded")
        self.assertEqual(info["notes"], ["3 of 1050 frames came without IR"])
        err = aufnahme.parse_probe_output(["record failed: cannot connect to ws://127.0.0.1:8090/ws: refused"])
        self.assertEqual(err["error"], "cannot connect to ws://127.0.0.1:8090/ws: refused")

    def test_scan_k2rec_cut_off(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "x.k2rec"
            write_k2rec(f, 31)
            s = aufnahme.scan_k2rec(f)
            self.assertEqual((s["frames"], s["frames_ir"], s["complete"]), (31, 31, True))
            self.assertAlmostEqual(s["fps"], 30.0, places=1)
            data = f.read_bytes()
            f.write_bytes(data[:-10])  # letzter Frame abgeschnitten
            s = aufnahme.scan_k2rec(f)
            self.assertEqual((s["frames"], s["complete"]), (30, False))
            f.write_bytes(b"nonsense" * 10)
            self.assertIsNone(aufnahme.scan_k2rec(f))

    def test_framing(self):
        p = self.plan
        shot = p.by_id["p1.coil.teach"]  # Aufbau A, braucht den ganzen Körper
        depth = (aufnahme.array("H", [1780] * (512 * 424)), 512, 424)
        ok = aufnahme.assess_framing(p, shot, {"poses": [person()]}, depth)
        self.assertTrue(ok["ok"] and ok["checked"], ok)
        self.assertAlmostEqual(ok["distance_m"], 1.78, places=2)
        kp = list(PERSON_KP)
        kp[15], kp[16] = (236, 422), (276, 423)  # Füße am unteren Rand
        r = aufnahme.assess_framing(p, shot, {"poses": [person(kp)]}, depth)
        self.assertFalse(r["ok"])
        self.assertIn("linker Fuß", r["problems"])
        self.assertIn("unteren", r["problems"]["linker Fuß"])
        r = aufnahme.assess_framing(p, shot, {"poses": []}, depth)
        self.assertFalse(r["ok"])
        self.assertIn("Niemand erkannt", r["warnings"][0])
        far = (aufnahme.array("H", [3300] * (512 * 424)), 512, 424)
        r = aufnahme.assess_framing(p, shot, {"poses": [person()]}, far)
        self.assertFalse(r["ok"])
        self.assertIn("zu weit weg", r["warnings"][-1])
        r = aufnahme.assess_framing(p, p.by_id["cal.A.empty"], {"poses": [person()]}, None)
        self.assertFalse(r["ok"])
        r = aufnahme.assess_framing(p, shot, {"poses": None, "pose": {"state": "off"}}, None)
        self.assertFalse(r["checked"])
        self.assertTrue(r["ok"])
        # Tisch: Hüfte und Beine werden nicht verlangt
        self.assertNotIn(15, aufnahme.needed_keypoints(p.by_id["cal.T.body"]))
        self.assertIn(15, aufnahme.needed_keypoints(p.by_id["cal.A.body"]))
        self.assertEqual(aufnahme.needed_keypoints(p.by_id["cal.B.empty"]), [])

    def test_expected_depth(self):
        p = self.plan
        self.assertAlmostEqual(aufnahme.mark_distance(p.setups["C"], "C-fern"), 2.2)
        self.assertAlmostEqual(aufnahme.mark_distance(p.setups["D"], "D-Start"), 3.2)
        self.assertAlmostEqual(aufnahme.mark_distance(p.setups["D"], "D-Ziel"), 3.2)  # Rückfall: distance_m
        self.assertAlmostEqual(aufnahme.expected_depth_m(p, p.by_id["p1.coil.near"]), 1.34, places=2)

    def test_setup_section_has_sketch(self):
        sec = "\n".join(aufnahme.setup_section("A"))
        self.assertIn("Draufsicht", sec)
        self.assertIn("[K]", sec)
        self.assertNotIn("A1–A3", sec)
        self.assertTrue(aufnahme.setup_section("D"))

    def test_big_font(self):
        lines = aufnahme.big_lines("Klatschen!", 100)
        self.assertEqual(len(lines), 5)
        self.assertTrue(all(len(x) <= 98 for x in lines))
        self.assertIsNone(aufnahme.big_lines("Hände 40 cm aufeinander zu", 60))


class PageServer(Base):
    def test_page_endpoints(self):
        page = aufnahme.Page(aufnahme.Hub(self.hub.url), 0)
        url = page.start()
        try:
            page.set(phase="countdown", big="3", say=["Ende in die linke Hand."], needed=[9, 10])
            html = urllib.request.urlopen(url, timeout=5).read().decode()
            self.assertIn("Mocap-Aufnahme", html)
            st = json.loads(urllib.request.urlopen(url + "state", timeout=5).read())
            self.assertEqual((st["phase"], st["big"]), ("countdown", "3"))
            png = urllib.request.urlopen(url + "ir.png", timeout=5).read()
            self.assertTrue(png.startswith(b"\x89PNG"))
            poses = json.loads(urllib.request.urlopen(url + "poses", timeout=5).read())
            self.assertEqual(len(poses["poses"]), 1)
            req = urllib.request.Request(url + "state", headers={"Host": "evil.example:80"})
            with self.assertRaises(urllib.error.HTTPError) as cm:
                urllib.request.urlopen(req, timeout=5)
            self.assertEqual(cm.exception.code, 403)
        finally:
            page.stop()


# ---------------------------------------------------------------------------------------------
# Ganze Sitzungen mit Mock-Hub und falscher Probe


class MockSession(Base):
    def test_full_session_1_scripted(self):
        """Termin 1 (A, B, T) komplett, ohne Fragen; dann Weitermachen und --again."""
        plan = aufnahme.Plan()
        t0 = time.monotonic()
        r = self.tool("--session", "1", "--yes", "--auto-keep")
        took = time.monotonic() - t0
        self.assertEqual(r.returncode, 0, r.stdout[-3000:] + r.stderr[-3000:])
        shots = [s for s in plan.shots if plan.session_of[s["setup"]] == 1]
        expected = sum(int(s["takes"]) for s in shots if not s.get("optional"))
        folder = self.rec / "termin1"
        files = sorted(folder.glob("*.k2rec"))
        self.assertEqual(len(files), expected)
        self.assertFalse(list(folder.glob("*.part")))
        log = self.log(1)
        self.assertEqual(log["format"], aufnahme.LOG_FORMAT)
        self.assertEqual(len(log["takes"]), expected)
        self.assertTrue(all(t["keep"] is True for t in log["takes"]))
        self.assertTrue(log["consents"])
        self.assertEqual(sorted(log["placements"]), ["A", "B", "T"])
        self.assertEqual(log["shots"]["p3.lefty"]["status"], "ausgelassen")
        for t in log["takes"]:
            shot = plan.by_id[t["shot"]]
            scan = aufnahme.scan_k2rec(folder / t["file"])
            self.assertEqual(scan["frames"], plan.record_seconds(shot) * 30, t["file"])
            self.assertEqual(t["frames"], scan["frames"])
            self.assertAlmostEqual(t["fps"], 30.0)
            self.assertEqual(t["placement"], 1)
            if plan.clap(shot):
                self.assertIn("signal_in_recording_s", t)
                self.assertGreaterEqual(t["signal_in_recording_s"], -0.5)
            else:
                self.assertNotIn("signal_in_recording_s", t)
            self.assertIn("framing", t)
            self.assertIn("monitor", t)
        teo = next(t for t in log["takes"] if t["shot"] == "p2.teo.pull")
        self.assertEqual([c["say"] for c in teo["cues"]][:2], ["Langsam auseinanderziehen", "Fast gespannt: halten"])
        idle = [t for t in log["takes"] if t["shot"] == "idle.stand"]
        self.assertEqual([t["variant"] for t in idle], plan.by_id["idle.stand"]["variants"])
        order = [(t["shot"], t["take"]) for t in log["takes"] if t["shot"] in ("p3.wrong.same", "p5.eight.hang")]
        self.assertEqual(order, [("p3.wrong.same", 1), ("p5.eight.hang", 1), ("p3.wrong.same", 2), ("p5.eight.hang", 2)])
        cal_first = [t["shot"] for t in log["takes"][:3]]
        self.assertEqual(cal_first, ["cal.A.empty", "cal.A.cable", "cal.A.body"])
        # Bildcheck: im leeren Raum steht im Mock jemand -> Warnung im Log
        empty = next(t for t in log["takes"] if t["shot"] == "cal.A.empty")
        self.assertFalse(empty["framing"]["ok"])
        body = next(t for t in log["takes"] if t["shot"] == "cal.T.body")
        self.assertTrue(body["framing"]["ok"], body["framing"])
        print(f"\n  Termin 1: {expected} Takes in {took:.0f} s (Zeitfaktor 0,004)", file=sys.stderr)

        # nochmal: alles schon da
        r2 = self.tool("--session", "1", "--yes", "--auto-keep")
        self.assertEqual(r2.returncode, 0, r2.stderr)
        self.assertIn("schon aufgenommen", r2.stdout)
        self.assertEqual(len(list(folder.glob("*.k2rec"))), expected)

        # --again: neue Take-Nummern, nichts überschrieben
        r3 = self.tool("--shot", "A7", "--again", "--yes", "--auto-keep")
        self.assertEqual(r3.returncode, 0, r3.stdout[-2000:] + r3.stderr)
        self.assertTrue((folder / "p3.check_t3.k2rec").exists())
        self.assertTrue((folder / "p3.check_t4.k2rec").exists())
        self.assertEqual(len(self.log(1)["takes"]), expected + 2)

        # Listen lesen den Stand
        r4 = subprocess.run([sys.executable, str(TOOL), "--main", str(self.main), "--status", "--list", "--setup", "T"],
                            capture_output=True, text=True, encoding="utf-8", env=dict(os.environ, PYTHONIOENCODING="utf-8"))
        self.assertEqual(r4.returncode, 0, r4.stderr)
        self.assertIn("fertig (3/3)", r4.stdout)
        self.assertIn("termin1:", r4.stdout)

    def test_resume_after_partial_setup(self):
        """Prio 1 von Aufbau T, dann der Rest: Kalibrierung nicht doppelt, Platzierung bleibt."""
        r = self.tool("--setup", "T", "--prio", "1", "--yes", "--auto-keep")
        self.assertEqual(r.returncode, 0, r.stdout[-2000:] + r.stderr)
        n1 = len(self.log(1)["takes"])
        self.assertEqual(n1, 3 + 3 + 2 + 2)
        r = self.tool("--setup", "T", "--yes", "--auto-keep")
        self.assertEqual(r.returncode, 0, r.stdout[-2000:] + r.stderr)
        self.assertIn("Weiter, wo du aufgehört hast", r.stdout)
        log = self.log(1)
        cal = [t for t in log["takes"] if t["shot"].startswith("cal.")]
        self.assertEqual(len(cal), 3)
        self.assertEqual(len(log["placements"]["T"]), 1)

    def test_single_shot_records_calibration_first(self):
        r = self.tool("--shot", "p7.tension", "--yes", "--auto-keep")
        self.assertEqual(r.returncode, 0, r.stdout[-2000:] + r.stderr)
        shots = [t["shot"] for t in self.log(1)["takes"]]
        self.assertEqual(shots, ["cal.T.empty", "cal.T.cable", "cal.T.body", "p7.tension", "p7.tension"])

    def test_hub_not_running(self):
        r = self.tool("--setup", "A", "--yes", "--auto-keep", hub=f"http://127.0.0.1:{free_port()}")
        self.assertEqual(r.returncode, aufnahme.EXIT_HUB)
        self.assertIn("Der Hub läuft nicht", r.stderr)
        self.assertIn("kinect-hub", r.stderr)
        self.assertIn("nicht start-wand.cmd", r.stderr)
        self.assertFalse(self.rec.exists() and list(self.rec.rglob("*.k2rec")))

    def test_sensor_not_streaming(self):
        self.hub.sensor_state = "searching"
        r = self.tool("--setup", "A", "--yes", "--auto-keep", scale=0.01)
        self.assertEqual(r.returncode, aufnahme.EXIT_HUB, r.stdout + r.stderr)
        self.assertIn("USB 3", r.stderr)

    def test_probe_failure_is_reported(self):
        r = self.tool("--shot", "p7.tension", "--ohne-kalibrierung", "--yes", "--auto-keep", mode="fail")
        self.assertEqual(r.returncode, aufnahme.EXIT_ERROR, r.stdout[-2000:] + r.stderr)
        self.assertIn("cannot connect to", r.stdout)  # die Meldung der Probe
        self.assertIn("Die Aufnahme klappt nicht", r.stderr)
        log = self.log(1)
        self.assertEqual(len(log["takes"]), 2)
        self.assertTrue(all("cannot connect" in t["error"] for t in log["takes"]))
        self.assertFalse(list(self.rec.rglob("*.k2rec")))

    def test_probe_no_frames(self):
        r = self.tool("--shot", "p7.tension", "--ohne-kalibrierung", "--yes", "--auto-keep", mode="noframes")
        self.assertEqual(r.returncode, aufnahme.EXIT_ERROR)
        self.assertIn("is the hub streaming", r.stdout)

    def test_probe_missing(self):
        env = dict(os.environ, PYTHONIOENCODING="utf-8")
        r = subprocess.run([sys.executable, str(TOOL), "--main", str(self.main), "--hub", self.hub.url, "--setup", "A",
                            "--yes", "--auto-keep", "--ohne-seite", "--leise"], capture_output=True, text=True,
                           encoding="utf-8", env=env, stdin=subprocess.DEVNULL, timeout=60)
        self.assertEqual(r.returncode, aufnahme.EXIT_CONFIG)
        self.assertIn("kinect-hub-probe.exe fehlt", r.stderr)

    @unittest.skipIf(os.name == "nt", "Strg+C an eine Prozessgruppe geht nur unter POSIX")
    def test_ctrl_c_keeps_recording(self):
        """Strg+C mitten im Take: die Probe schließt die Datei ab, das Tool trägt den Take ein und hört auf."""
        p = self.tool("--shot", "p1.coil.teach", "--ohne-kalibrierung", "--yes", "--auto-keep", scale=0.08,
                      start_new_session=True, background=True)
        part = self.rec / "termin1" / "p1.coil.teach_t1.k2rec.part"
        deadline = time.monotonic() + 30
        while not part.exists() and time.monotonic() < deadline and p.poll() is None:
            time.sleep(0.02)
        self.assertTrue(part.exists(), "die Aufnahme hat nicht begonnen")
        time.sleep(0.6)
        os.killpg(p.pid, signal.SIGINT)  # wie Strg+C im Terminal: Tool und Probe bekommen es
        out, err = p.communicate(timeout=60)
        self.assertEqual(p.returncode, aufnahme.EXIT_INTERRUPT, out[-2000:] + err)
        f = self.rec / "termin1" / "p1.coil.teach_t1.k2rec"
        self.assertTrue(f.exists())
        self.assertFalse(part.exists())
        scan = aufnahme.scan_k2rec(f)
        full = aufnahme.Plan().record_seconds(aufnahme.Plan().by_id["p1.coil.teach"]) * 30
        self.assertGreater(scan["frames"], 0)
        self.assertLess(scan["frames"], full)
        t = self.log(1)["takes"][0]
        self.assertEqual(t["stopped"], "strg+c")
        self.assertEqual(t["probe_reason"], "stopped with Ctrl+C")
        self.assertFalse(t["keep"])
        self.assertEqual(t["frames"], scan["frames"])

    def test_interactive_menu_keys(self):
        """Ohne --yes/--auto-keep, Tasten zeilenweise: Start, wiederholen, Notiz, behalten, genug."""
        keys = "\n".join([
            "j",          # Einverständnis
            "",           # Kinect steht -> Vorschau
            "",           # Start (cal.T.empty)
            "",           # behalten
            "", "",       # cal.T.cable: Start, behalten
            "", "",       # cal.T.body: Start, behalten
            "",           # p7.tension Take 1: Start
            "w",          # wiederholen
            "",           # Start
            "n", "Kabel hat sich verhakt",  # Notiz
            "g",          # genug: behalten, Shot fertig
        ]) + "\n"
        env = dict(os.environ, FAKE_PROBE_SCALE="0.004", PYTHONIOENCODING="utf-8")
        r = subprocess.run([sys.executable, str(TOOL), "--main", str(self.main), "--probe", str(Path(__file__).resolve()),
                            "--hub", self.hub.url, "--zeitfaktor", "0.004", "--leise", "--ohne-seite", "--mb-pro-s", "1",
                            "--shot", "p7.tension"], input=keys, capture_output=True, text=True, encoding="utf-8",
                           env=env, timeout=120)
        self.assertEqual(r.returncode, 0, r.stdout[-3000:] + r.stderr)
        log = self.log(1)
        tension = [t for t in log["takes"] if t["shot"] == "p7.tension"]
        self.assertEqual([(t["take"], t["keep"], t["decision"]) for t in tension],
                         [(1, False, "wiederholen"), (2, True, "genug")])
        self.assertIn("Kabel hat sich verhakt", tension[1]["notes"])
        self.assertEqual(log["shots"]["p7.tension"]["status"], "genug")
        self.assertTrue((self.rec / "termin1" / "p7.tension_t1.k2rec").exists())  # nichts gelöscht


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "record":
        sys.exit(fake_probe(sys.argv[2:]))
    unittest.main()
