#!/usr/bin/env python3
"""Geführte Kinect-Aufnahme für „Kabel richtig aufwickeln“ (Motion Capture).

Liest mocap/shots.json und führt dich Take für Take durch den Aufnahmeplan (mocap/aufnahmeplan.md):
Aufbau zeigen, Bild prüfen, Countdown mit Tönen, Startsignal zum Klatschen, zeitgesteuerte
Ansagen, automatisches Ende. Aufgenommen wird mit `kinect-hub-probe record` vom laufenden Hub
(nie direkt von der Kinect) nach <Hauptordner>/recordings/mocap/termin<N>/<shot>_t<take>.k2rec.
Daneben schreibt das Tool das Sitzungslog sitzung.json (Takes, Notizen, behalten ja/nein,
Startsignal-Zeit); es ist zugleich der Stand zum Weitermachen.

    python aufnahme.py                         # Menü (dasselbe wie Doppelklick auf aufnahme.cmd)
    python aufnahme.py --session 1             # Termin 1 (A, B, T), macht dort weiter, wo du aufgehört hast
    python aufnahme.py --setup A --prio 1      # nur Aufbau A, nur Prio 1
    python aufnahme.py --shot p3.pair.slow     # einzelne Shots (auch A6, B12 …)
    python aufnahme.py --from p3.check         # ab diesem Shot bis zum Ende seines Termins
    python aufnahme.py --list | --sessions | --setups | --status
    python aufnahme.py --vorschau --setup B    # nur Bild prüfen, ohne Aufnahme

Nur Standardbibliothek (numpy und andere Pakete werden nicht gebraucht). Windows und Linux.
Anleitung: mocap/README.md, Abschnitt „Aufnehmen“.
"""

from __future__ import annotations

import argparse
import datetime
import http.server
import json
import math
import os
import queue
import re
import shutil
import signal
import statistics
import struct
import subprocess
import sys
import textwrap
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from array import array
from pathlib import Path

HERE = Path(__file__).resolve().parent
SHOTS_JSON = HERE / "shots.json"
PLAN_MD = HERE / "aufnahmeplan.md"
LOG_NAME = "sitzung.json"
LOG_FORMAT = "kabel-wickeln mocap sitzung"
LOG_VERSION = 1
DEFAULT_HUB = "http://127.0.0.1:8090"
IMG_W, IMG_H = 512, 424
K2REC_MAGIC = 0x4352324B  # "K2RC"
K2REC_FRAME = 0x4652324B  # "K2RF"

# Fallback, falls shots.json kein "alternate" hat (aus aufnahmeplan.md: „abwechselnd aufnehmen“)
DEFAULT_ALTERNATE = [
    ["p3.wrong.same", "p5.eight.hang"],
    ["p5.knots.pull", "p5.knots.fix"],
    ["p2.teo.coil", "p2.teo.pull"],
    ["p2.robin.coil", "p2.robin.pull"],
    ["p7.ribbon.pull", "p7.ribbon.release"],
]

EXIT_OK, EXIT_ERROR, EXIT_HUB, EXIT_DISK, EXIT_CONFIG, EXIT_INTERRUPT = 0, 1, 2, 3, 4, 130


class UserQuit(Exception):
    """Du hast „beenden“ gewählt oder Strg+C in einer Frage gedrückt."""


class Fatal(Exception):
    def __init__(self, msg: str, code: int = EXIT_ERROR):
        super().__init__(msg)
        self.code = code


# ---------------------------------------------------------------------------------------------
# Kleinkram


def de(x: float, nd: int = 1) -> str:
    """Zahl mit Komma: 1.5 -> '1,5'."""
    return f"{x:.{nd}f}".replace(".", ",")


def iso_now() -> str:
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def write_json_atomic(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    for attempt in range(10):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:  # Windows: kurz von einem anderen Programm geöffnet
            if attempt == 9:
                raise
            time.sleep(0.2)


def gb(nbytes: float) -> str:
    return de(nbytes / 1e9, 1) + " GB"


# ---------------------------------------------------------------------------------------------
# Konsole: Farben, große Schrift, Töne, Tasten

FONT = {
    "A": [" ### ", "#   #", "#####", "#   #", "#   #"], "B": ["#### ", "#   #", "#### ", "#   #", "#### "],
    "C": [" ####", "#    ", "#    ", "#    ", " ####"], "D": ["#### ", "#   #", "#   #", "#   #", "#### "],
    "E": ["#####", "#    ", "#### ", "#    ", "#####"], "F": ["#####", "#    ", "#### ", "#    ", "#    "],
    "G": [" ####", "#    ", "#  ##", "#   #", " ####"], "H": ["#   #", "#   #", "#####", "#   #", "#   #"],
    "I": ["###", " # ", " # ", " # ", "###"], "J": ["#####", "   # ", "   # ", "#  # ", " ##  "],
    "K": ["#   #", "#  # ", "###  ", "#  # ", "#   #"], "L": ["#    ", "#    ", "#    ", "#    ", "#####"],
    "M": ["#   #", "## ##", "# # #", "#   #", "#   #"], "N": ["#   #", "##  #", "# # #", "#  ##", "#   #"],
    "O": [" ### ", "#   #", "#   #", "#   #", " ### "], "P": ["#### ", "#   #", "#### ", "#    ", "#    "],
    "Q": [" ### ", "#   #", "# # #", "#  # ", " ## #"], "R": ["#### ", "#   #", "#### ", "#  # ", "#   #"],
    "S": [" ####", "#    ", " ### ", "    #", "#### "], "T": ["#####", "  #  ", "  #  ", "  #  ", "  #  "],
    "U": ["#   #", "#   #", "#   #", "#   #", " ### "], "V": ["#   #", "#   #", "#   #", " # # ", "  #  "],
    "W": ["#   #", "#   #", "# # #", "## ##", "#   #"], "X": ["#   #", " # # ", "  #  ", " # # ", "#   #"],
    "Y": ["#   #", " # # ", "  #  ", "  #  ", "  #  "], "Z": ["#####", "   # ", "  #  ", " #   ", "#####"],
    "Ä": ["#   #", " ### ", "#   #", "#####", "#   #"], "Ö": ["#   #", " ### ", "#   #", "#   #", " ### "],
    "Ü": ["#   #", "     ", "#   #", "#   #", " ### "],
    "0": ["#####", "#   #", "#   #", "#   #", "#####"], "1": ["  #  ", " ##  ", "  #  ", "  #  ", " ### "],
    "2": ["#####", "    #", "#####", "#    ", "#####"], "3": ["#####", "    #", " ####", "    #", "#####"],
    "4": ["#   #", "#   #", "#####", "    #", "    #"], "5": ["#####", "#    ", "#####", "    #", "#####"],
    "6": ["#####", "#    ", "#####", "#   #", "#####"], "7": ["#####", "    #", "   # ", "  #  ", "  #  "],
    "8": ["#####", "#   #", "#####", "#   #", "#####"], "9": ["#####", "#   #", "#####", "    #", "#####"],
    " ": ["   ", "   ", "   ", "   ", "   "], "!": ["#", "#", "#", " ", "#"], ":": [" ", "#", " ", "#", " "],
    ".": [" ", " ", " ", " ", "#"], ",": ["  ", "  ", "  ", " #", "# "], "-": ["    ", "    ", "####", "    ", "    "],
    "?": ["####", "   #", " ## ", "    ", " #  "],
}


def big_lines(text: str, width: int) -> list[str] | None:
    """Text in Blockschrift (5 Zeilen), oder None, wenn er nicht in die Breite passt."""
    text = text.upper().replace("ß", "SS")
    if any(ch not in FONT for ch in text):
        return None
    for double in (True, False):
        rows = ["", "", "", "", ""]
        for ch in text:
            for i, row in enumerate(FONT[ch]):
                cell = "".join(c * (2 if double else 1) for c in row)
                rows[i] += cell.replace("#", "█") + ("  " if double else " ")
        if max(len(r) for r in rows) <= width - 2:
            return [r.rstrip() for r in rows]
    return None


class Beeper:
    """Töne in einem eigenen Thread, damit der Zeitplan nicht wartet (winsound.Beep blockiert)."""

    PATTERNS = {
        "tick": [(880, 110)],
        "signal": [(1320, 550)],
        "cue": [(1050, 120), (0, 70), (1050, 120)],
        "endpose": [(740, 160)],
        "end": [(660, 180), (0, 40), (520, 380)],
        "warn": [(330, 220), (0, 90), (330, 220), (0, 90), (330, 220)],
    }

    def __init__(self, enabled: bool, bell_ok: bool):
        self.enabled = enabled
        self.bell_ok = bell_ok
        self.q: queue.Queue = queue.Queue()
        self.winsound = None
        if enabled and os.name == "nt":
            try:
                import winsound  # noqa: PLC0415  (nur Windows)

                self.winsound = winsound
            except ImportError:
                self.winsound = None
        if enabled:
            threading.Thread(target=self._run, name="beeper", daemon=True).start()

    def tone(self, kind: str) -> None:
        if self.enabled:
            self.q.put(self.PATTERNS.get(kind, self.PATTERNS["tick"]))

    def _run(self) -> None:
        while True:
            pattern = self.q.get()
            rang = False
            for freq, ms in pattern:
                try:
                    if freq and self.winsound is not None:
                        self.winsound.Beep(int(freq), int(ms))
                        continue
                    if freq and self.bell_ok and not rang:
                        sys.stdout.write("\a")
                        sys.stdout.flush()
                        rang = True
                except Exception:  # noqa: BLE001  (Ton ist nie wichtig genug für einen Absturz)
                    pass
                time.sleep(ms / 1000)


class Keys:
    """Einzelne Tasten (auch Presenter: Bild ab/auf), im Test zeilenweise von stdin."""

    def __init__(self):
        self.tty = sys.stdin is not None and sys.stdin.isatty()

    def flush(self) -> None:
        """Tasten verwerfen, die während der Aufnahme gedrückt wurden."""
        if not self.tty:
            return
        try:
            if os.name == "nt":
                import msvcrt  # noqa: PLC0415

                while msvcrt.kbhit():
                    msvcrt.getwch()
            else:
                import termios  # noqa: PLC0415

                termios.tcflush(sys.stdin.fileno(), termios.TCIFLUSH)
        except Exception:  # noqa: BLE001
            pass

    def key(self) -> str:
        """Eine Taste: 'enter', 'space', 'esc', 'pgdn', 'pgup', 'left', 'right', 'up', 'down', 'f5' oder ein Zeichen."""
        if not self.tty:
            line = sys.stdin.readline() if sys.stdin is not None else ""
            if line == "":
                raise EOFError
            s = line.strip().lower()
            return "enter" if s == "" else s
        if os.name == "nt":
            return self._key_windows()
        return self._key_posix(None) or ""

    def poll(self, timeout: float) -> str | None:
        """Taste, falls innerhalb von timeout Sekunden gedrückt, sonst None."""
        if not self.tty:
            time.sleep(timeout)
            return None
        if os.name == "nt":
            import msvcrt  # noqa: PLC0415

            end = time.monotonic() + timeout
            while time.monotonic() < end:
                if msvcrt.kbhit():
                    return self._key_windows()
                time.sleep(0.03)
            return None
        return self._key_posix(timeout)

    @staticmethod
    def _key_windows() -> str:
        import msvcrt  # noqa: PLC0415

        ch = msvcrt.getwch()
        if ch == "\x03":
            raise KeyboardInterrupt
        if ch in ("\x00", "\xe0"):
            code = msvcrt.getwch()
            return {"Q": "pgdn", "I": "pgup", "K": "left", "M": "right", "H": "up", "P": "down", "?": "f5"}.get(code, "")
        if ch in ("\r", "\n"):
            return "enter"
        if ch == " ":
            return "space"
        if ch == "\x1b":
            return "esc"
        return ch.lower()

    @staticmethod
    def _key_posix(timeout: float | None) -> str | None:
        import select  # noqa: PLC0415
        import termios  # noqa: PLC0415
        import tty  # noqa: PLC0415

        fd = sys.stdin.fileno()
        old = termios.tcgetattr(fd)
        try:
            tty.setcbreak(fd)
            if timeout is not None and not select.select([fd], [], [], timeout)[0]:
                return None
            b = os.read(fd, 1)
            if b == b"\x1b":
                seq = b""
                while select.select([fd], [], [], 0.05)[0] and len(seq) < 6:
                    seq += os.read(fd, 1)
                return {b"": "esc", b"[6~": "pgdn", b"[5~": "pgup", b"[C": "right", b"[D": "left", b"[A": "up",
                        b"[B": "down", b"[15~": "f5", b"OP": "f1"}.get(seq, "")
            if b in (b"\n", b"\r"):
                return "enter"
            if b == b" ":
                return "space"
            if b and b[0] >= 0xC0:  # UTF-8, z. B. ä
                while select.select([fd], [], [], 0.01)[0] and len(b) < 4:
                    b += os.read(fd, 1)
            return b.decode("utf-8", "ignore").lower()
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)


class Ui:
    STYLES = {"b": "1", "dim": "2", "red": "1;31", "green": "1;32", "yellow": "1;33", "blue": "1;34",
              "cyan": "1;36", "inv": "7", "rec": "1;37;41", "sig": "1;30;42", "warnbox": "1;30;43"}

    def __init__(self, tty: bool, color: bool):
        self.tty = tty
        self.color = color and tty and self._enable_vt()
        self.status_shown = False

    @staticmethod
    def _enable_vt() -> bool:
        if os.environ.get("NO_COLOR"):
            return False
        if os.name != "nt":
            return True
        try:
            import ctypes  # noqa: PLC0415

            k = ctypes.windll.kernel32  # type: ignore[attr-defined]
            h = k.GetStdHandle(-11)
            mode = ctypes.c_uint32()
            if not k.GetConsoleMode(h, ctypes.byref(mode)):
                return False
            return bool(k.SetConsoleMode(h, mode.value | 0x0004))
        except Exception:  # noqa: BLE001
            return False

    @property
    def width(self) -> int:
        return max(60, min(shutil.get_terminal_size((100, 30)).columns, 160))

    def c(self, text: str, style: str) -> str:
        if not self.color:
            return text
        return f"\x1b[{self.STYLES.get(style, '0')}m{text}\x1b[0m"

    def out(self, text: str = "") -> None:
        self.end_status()
        print(text, flush=True)

    def clear(self) -> None:
        self.end_status()
        if not self.tty:
            print("", flush=True)
            return
        if self.color:
            print("\x1b[2J\x1b[H", end="", flush=True)
        elif os.name == "nt":
            os.system("cls")  # noqa: S605,S607
        else:
            print("\n" * 3, flush=True)

    def rule(self, title: str = "", char: str = "═", style: str = "cyan") -> None:
        w = self.width - 1
        line = (char * 2 + " " + title + " " + char * w)[:w] if title else char * w
        self.out(self.c(line, style))

    def wrap(self, text: str, indent: str = "  ", style: str | None = None) -> None:
        for line in textwrap.wrap(text, width=self.width - 2, initial_indent=indent,
                                  subsequent_indent=indent + "  ") or [indent]:
            self.out(self.c(line, style) if style else line)

    def big(self, text: str, style: str = "b") -> None:
        lines = big_lines(text, self.width) if self.tty else None
        if lines is None:
            self.banner(text, style)
            return
        for ln in lines:
            self.out("  " + self.c(ln, style))

    def banner(self, text: str, style: str = "inv") -> None:
        w = self.width - 1
        spaced = " ".join(text.upper()) if len(text) * 2 + 4 < w else text.upper()
        self.out(self.c((" " * 2 + spaced).ljust(w), style))

    def status(self, text: str) -> None:
        """Eine Zeile, die sich selbst überschreibt (nur im Terminal)."""
        if not self.tty:
            return
        w = self.width - 1
        print("\r" + text[:w].ljust(w), end="", flush=True)
        self.status_shown = True

    def end_status(self) -> None:
        if self.status_shown:
            print("", flush=True)
            self.status_shown = False


# ---------------------------------------------------------------------------------------------
# Plan: shots.json


class Plan:
    def __init__(self, path: Path = SHOTS_JSON):
        try:
            d = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            raise Fatal(f"{path} lässt sich nicht lesen: {e}", EXIT_CONFIG) from e
        self.path = path
        self.data = d
        self.shots: list[dict] = list(d.get("shots") or [])
        self.by_id = {s["id"]: s for s in self.shots}
        self.setups = {s["id"]: s for s in d.get("setups") or []}
        self.setup_order = [s["id"] for s in d.get("setups") or []]
        self.sessions = list(d.get("sessions") or [])
        self.session_of: dict[str, int] = {}
        for sess in self.sessions:
            for su in sess.get("setups", []):
                self.session_of[su] = int(sess["id"])
        conv = d.get("conventions") or {}
        self.countdown = float(conv.get("start_countdown_s", 5))
        self.pre = float(conv.get("pre_roll_s", 2))
        self.post = float(conv.get("post_roll_s", 2))
        self.mb_per_s = float(conv.get("mb_per_s", 20))
        self.legend = d.get("legend") or {}
        problems = [s["id"] for s in self.shots if s.get("setup") not in self.setups or s.get("setup") not in self.session_of]
        if problems:
            raise Fatal(f"shots.json: Shots ohne bekannten Aufbau oder Termin: {', '.join(problems)}", EXIT_CONFIG)
        alt = d.get("alternate") or DEFAULT_ALTERNATE
        self.alternate = [[i for i in g if i in self.by_id] for g in alt]
        self.alternate = [g for g in self.alternate if len(g) >= 2]
        # Nummern wie im Aufnahmeplan: A1 … A16, B1 …
        self.number: dict[str, str] = {}
        count: dict[str, int] = {}
        for s in self.shots:
            count[s["setup"]] = count.get(s["setup"], 0) + 1
            self.number[s["id"]] = f"{s['setup']}{count[s['setup']]}"
        self.by_number = {v.upper(): k for k, v in self.number.items()}

    def resolve(self, ref: str) -> dict:
        ref = ref.strip()
        if ref in self.by_id:
            return self.by_id[ref]
        if ref.upper() in self.by_number:
            return self.by_id[self.by_number[ref.upper()]]
        close = [i for i in self.by_id if ref.lower() in i.lower()]
        hint = f" Meintest du: {', '.join(close[:5])}?" if close else " Liste: aufnahme.py --list"
        raise Fatal(f"Shot „{ref}“ gibt es nicht.{hint}", EXIT_CONFIG)

    def record_seconds(self, shot: dict) -> int:
        """Länge für `probe record --seconds`: Vorlauf + Shot + Nachlauf, aufgerundet, plus 1 s Reserve."""
        return int(math.ceil(self.pre + float(shot["seconds"]) + self.post)) + 1

    def folder_name(self, shot: dict) -> str:
        return f"termin{self.session_of[shot['setup']]}"

    def clap(self, shot: dict) -> bool:
        return shot.get("clap", True) is not False

    def setup_shots(self, setup: str) -> list[dict]:
        return [s for s in self.shots if s["setup"] == setup]

    def calib_shots(self, setup: str) -> list[dict]:
        return [s for s in self.shots if s["setup"] == setup and s.get("part") == "calib"]

    def group_of(self, shot_id: str) -> list[str] | None:
        for g in self.alternate:
            if shot_id in g:
                return g
        return None


def select_shots(plan: Plan, args) -> list[dict] | None:
    """Auswahl aus --session/--setup/--shot/--from/--prio; None = nichts gewählt (Menü)."""
    shots: list[dict] | None = None
    if args.shot:
        refs = [r for item in args.shot for r in item.split(",") if r.strip()]
        seen: list[dict] = []
        for r in refs:
            s = plan.resolve(r)
            if s not in seen:
                seen.append(s)
        shots = seen
    elif args.setup:
        wanted = [x.strip().upper() for item in args.setup for x in item.split(",") if x.strip()]
        unknown = [x for x in wanted if x not in plan.setups]
        if unknown:
            raise Fatal(f"Aufbau {', '.join(unknown)} gibt es nicht (es gibt {', '.join(plan.setup_order)}).", EXIT_CONFIG)
        shots = [s for s in plan.shots if s["setup"] in wanted]
    elif args.session:
        ids = {int(x) for item in args.session for x in str(item).split(",") if str(x).strip()}
        known = {int(s["id"]) for s in plan.sessions}
        if ids - known:
            raise Fatal(f"Termin {', '.join(map(str, sorted(ids - known)))} gibt es nicht (es gibt {', '.join(map(str, sorted(known)))}).", EXIT_CONFIG)
        shots = [s for s in plan.shots if plan.session_of[s["setup"]] in ids]
    elif args.from_:
        start = plan.resolve(args.from_)
        shots = [s for s in plan.shots if plan.session_of[s["setup"]] == plan.session_of[start["setup"]]]
    if shots is None:
        return None
    if args.from_:
        start = plan.resolve(args.from_)
        if start not in shots:
            raise Fatal(f"--from {args.from_}: der Shot ist nicht in deiner Auswahl.", EXIT_CONFIG)
        shots = shots[shots.index(start):]
    if args.prio:
        shots = [s for s in shots if int(s.get("prio", 3)) <= int(args.prio)]
    return shots


def build_slots(plan: Plan, shots: list[dict]) -> list[tuple[dict, int]]:
    """(Shot, Take-Platz 1…takes) in Aufnahmereihenfolge; Gruppen aus alternate abwechselnd."""
    chosen = {s["id"] for s in shots}
    out: list[tuple[dict, int]] = []
    done: set[str] = set()
    for s in shots:
        if s["id"] in done:
            continue
        group = plan.group_of(s["id"])
        members = [i for i in group if i in chosen and i not in done] if group else []
        if len(members) >= 2:
            most = max(int(plan.by_id[i].get("takes", 1)) for i in members)
            for k in range(1, most + 1):
                for i in members:
                    if k <= int(plan.by_id[i].get("takes", 1)):
                        out.append((plan.by_id[i], k))
            done.update(members)
        else:
            for k in range(1, int(s.get("takes", 1)) + 1):
                out.append((s, k))
            done.add(s["id"])
    return out


# ---------------------------------------------------------------------------------------------
# Aufnahmeplan (Markdown): Aufbau-Abschnitte mit ASCII-Skizze


def setup_section(setup_id: str, plan_md: Path = PLAN_MD) -> list[str]:
    """Einleitung, ASCII-Skizze und Stichpunkte des Abschnitts „## Aufbau X“, ohne die Shots."""
    try:
        lines = plan_md.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    start = None
    for i, ln in enumerate(lines):
        if re.match(rf"^## Aufbau {re.escape(setup_id)}\b", ln):
            start = i
            break
    if start is None:
        return []
    out: list[str] = []
    for ln in lines[start + 1:]:
        if ln.startswith("## ") or ln.startswith("---") or re.match(rf"^\*\*{re.escape(setup_id)}\d", ln):
            break
        out.append(ln)
    while out and not out[0].strip():
        out.pop(0)
    while out and not out[-1].strip():
        out.pop()
    return out


# ---------------------------------------------------------------------------------------------
# Hauptordner, Probe, Aufnahmeordner


def find_main(explicit: str | None) -> Path:
    """Hauptcheckout: --main, sonst `git worktree list --porcelain`, sonst .git-Datei eines Worktrees."""
    if explicit:
        return Path(explicit).resolve()
    try:
        r = subprocess.run(["git", "worktree", "list", "--porcelain"], cwd=HERE, capture_output=True,
                           text=True, encoding="utf-8", errors="replace", timeout=10, check=False)
        for line in r.stdout.splitlines():
            if line.startswith("worktree "):
                return Path(line[len("worktree "):].strip()).resolve()
    except (OSError, subprocess.SubprocessError):
        pass
    for parent in [HERE, *HERE.parents]:
        g = parent / ".git"
        if g.is_dir():
            return parent
        if g.is_file():
            m = re.match(r"gitdir:\s*(.+)", g.read_text(encoding="utf-8", errors="replace").strip())
            if m:  # <main>/.git/worktrees/<name>
                gitdir = Path(m.group(1).strip())
                if not gitdir.is_absolute():
                    gitdir = (parent / gitdir).resolve()
                return gitdir.parent.parent.parent
            return parent
    return HERE.parent.parent


def find_probe(main: Path, explicit: str | None) -> Path:
    if explicit:
        p = Path(explicit)
        if not p.exists():
            raise Fatal(f"--probe {p}: die Datei gibt es nicht.", EXIT_CONFIG)
        return p.resolve()
    rel = Path("kinect-hub") / "target" / "release"
    for name in ("kinect-hub-probe.exe", "kinect-hub-probe"):
        p = main / rel / name
        if p.exists():
            return p
    raise Fatal(
        f"kinect-hub-probe.exe fehlt in {main / rel}.\n"
        f"  Es wird im Hauptordner gebaut: cd {main / 'kinect-hub'}  und dann  cargo build --release\n"
        f"  (oder gib den Pfad an: --probe PFAD)", EXIT_CONFIG)


def probe_command(probe: Path) -> list[str]:
    """Eine .py-Probe (Test) läuft mit diesem Python, sonst direkt."""
    if probe.suffix.lower() == ".py":
        return [sys.executable, str(probe)]
    return [str(probe)]


def git_ignored(main: Path, path: Path) -> bool | None:
    try:
        r = subprocess.run(["git", "check-ignore", "-q", str(path)], cwd=main, capture_output=True, timeout=10, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode in (0, 1):
        return r.returncode == 0
    return None


def free_bytes(path: Path) -> int:
    p = path
    while not p.exists() and p != p.parent:
        p = p.parent
    return shutil.disk_usage(p).free


# ---------------------------------------------------------------------------------------------
# Hub (HTTP, nur Standardbibliothek)


class HubDown(Exception):
    pass


class Hub:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        u = urllib.parse.urlsplit(self.base)
        self.host = u.hostname or "127.0.0.1"
        self.port = u.port or 80

    @property
    def ws_url(self) -> str:
        return f"ws://{self.host}:{self.port}/ws"

    def get(self, path: str, timeout: float = 2.0) -> tuple[bytes, dict]:
        try:
            with urllib.request.urlopen(self.base + path, timeout=timeout) as r:  # noqa: S310 (nur localhost)
                return r.read(), dict(r.headers)
        except urllib.error.HTTPError as e:
            raise HubDown(f"HTTP {e.code} bei {path}") from e
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise HubDown(str(getattr(e, "reason", e))) from e

    def json(self, path: str, timeout: float = 2.0):
        body, _ = self.get(path, timeout)
        try:
            return json.loads(body.decode("utf-8", "replace"))
        except ValueError as e:
            raise HubDown(f"{path}: keine gültige Antwort") from e

    def status(self) -> dict:
        return self.json("/api/status", 3.0)

    def poses(self) -> dict | None:
        try:
            doc = self.json("/api/poses", 2.0)
        except HubDown:
            return None
        return doc if isinstance(doc, dict) else None

    def depth(self) -> tuple[array, int, int] | None:
        try:
            body, headers = self.get("/api/frame/depth", 2.0)
        except HubDown:
            return None
        h = {k.lower(): v for k, v in headers.items()}
        w = int(h.get("x-width", IMG_W))
        hh = int(h.get("x-height", IMG_H))
        if len(body) != w * hh * 2:
            return None
        a = array("H")
        a.frombytes(body)
        if sys.byteorder == "big":
            a.byteswap()
        return a, w, hh


# ---------------------------------------------------------------------------------------------
# Bildcheck: Person da, nötige Gelenke im Bild, Abstand plausibel

KP_NAMES = ["Nase", "linkes Auge", "rechtes Auge", "linkes Ohr", "rechtes Ohr", "linke Schulter", "rechte Schulter",
            "linker Ellenbogen", "rechter Ellenbogen", "linke Hand", "rechte Hand", "linke Hüfte", "rechte Hüfte",
            "linkes Knie", "rechtes Knie", "linker Fuß", "rechter Fuß"]
KP_MIN_CONF = 0.3
PERSON_MIN_SCORE = 0.4
EDGE_MARGIN = 6
TORSO = [5, 6, 11, 12]
EDGE_DE = {"unten": "am unteren Bildrand", "oben": "am oberen Bildrand", "links": "am linken Bildrand",
           "rechts": "am rechten Bildrand"}


def needed_keypoints(shot: dict) -> list[int]:
    """COCO-Gelenke, die im Bild sein müssen, aus shots.json needs."""
    if int(shot.get("persons", 1)) == 0:
        return []
    needs = set(shot.get("needs") or [])
    seated = shot.get("setup") == "T"  # Tisch verdeckt Hüfte und Beine
    ks: set[int] = set()
    if "body" in needs:
        ks |= {5, 6, 7, 8, 9, 10}
        if not seated:
            ks |= {11, 12, 13, 14, 15, 16}
    if needs & {"hands", "fingers", "wrist"}:
        ks |= {7, 8, 9, 10}
    if "head" in needs:
        ks |= {0}
    if "feet" in needs and not seated:
        ks |= {15, 16}
    if not ks:
        ks = {5, 6}
    return sorted(ks)


def mark_distance(setup: dict, mark: str | None) -> float:
    """Waagrechter Abstand Kinect → Marke aus dem Text in shots.json, sonst distance_m des Aufbaus."""
    text = (setup.get("marks") or {}).get(mark or "", "")
    m = re.search(r"(\d+(?:,\d+)?)\s*m\s+(?:genau\s+)?vor\s+(?:dem Stativ|der Kinect)", text)
    if m:
        return float(m.group(1).replace(",", "."))
    return float((setup.get("kinect") or {}).get("distance_m", 2.0))


def expected_depth_m(plan: Plan, shot: dict) -> float:
    """Erwartete Kinect-Tiefe (z, entlang der Blickrichtung) am Oberkörper der Person."""
    setup = plan.setups[shot["setup"]]
    k = setup.get("kinect") or {}
    d = mark_distance(setup, shot.get("mark"))
    pitch = math.radians(abs(float(k.get("pitch_deg", 0))))
    torso_h = 0.85 if shot["setup"] == "T" else 1.15
    return d * math.cos(pitch) + (float(k.get("height_m", 1.2)) - torso_h) * math.sin(pitch)


def _edge(u: float, v: float, w: int, h: int, m: int = EDGE_MARGIN) -> str | None:
    if v > h - 1 - m:
        return "unten"
    if v < m:
        return "oben"
    if u < m:
        return "links"
    if u > w - 1 - m:
        return "rechts"
    return None


def depth_at(depth: tuple[array, int, int] | None, points: list[tuple[float, float]], r: int = 4) -> float | None:
    """Median der gültigen Tiefe (mm) in kleinen Fenstern um die Punkte, in m."""
    if depth is None:
        return None
    a, w, h = depth
    vals = []
    for u, v in points:
        cu, cv = int(round(u)), int(round(v))
        for y in range(max(0, cv - r), min(h, cv + r + 1)):
            row = y * w
            for x in range(max(0, cu - r), min(w, cu + r + 1)):
                z = a[row + x]
                if z:
                    vals.append(z)
    return statistics.median(vals) / 1000 if vals else None


def assess_framing(plan: Plan, shot: dict, doc: dict | None, depth=None) -> dict:
    """Bewertet ein /api/poses-Ergebnis für diesen Shot. ok=False heißt: deutlich warnen."""
    res: dict = {"checked": False, "ok": True, "persons": None, "warnings": [], "problems": {},
                 "distance_m": None, "expected_m": None}
    poses = doc.get("poses") if isinstance(doc, dict) else None
    if poses is None:
        state = ((doc or {}).get("pose") or {}).get("state") if isinstance(doc, dict) else None
        why = f" (Pose-Modell: {state})" if state else ""
        res["warnings"].append(f"Kein Bildcheck möglich: der Hub liefert gerade keine Posen{why}.")
        return res
    res["checked"] = True
    expected = int(shot.get("persons", 1))
    people = [p for p in poses if float(p.get("score", 0)) >= PERSON_MIN_SCORE]
    res["persons"] = len(people)
    if expected == 0:
        if people:
            res["ok"] = False
            res["warnings"].append("Es ist noch jemand im Bild. Für diesen Shot muss das Bild leer sein.")
        return res
    if not people:
        res["ok"] = False
        res["warnings"].append(f"Niemand erkannt. Stell dich auf die Marke {shot.get('mark') or ''}.".replace("  ", " "))
        return res
    if len(people) > expected:
        res["warnings"].append(f"{len(people)} Personen erkannt, geplant {expected}. Sonst niemand ins Bild.")

    def area(p):
        b = p.get("box") or [0, 0, 0, 0]
        return abs((b[2] - b[0]) * (b[3] - b[1]))

    main = sorted(people, key=area, reverse=True)[:expected]
    if len(main) < expected:
        res["ok"] = False
        res["warnings"].append(f"Nur {len(main)} von {expected} Personen erkannt.")
    for p in main:
        kp = p.get("kp") or []
        for k in needed_keypoints(shot):
            if len(kp) < 3 * k + 3:
                continue
            u, v, c = float(kp[3 * k]), float(kp[3 * k + 1]), float(kp[3 * k + 2])
            if c < KP_MIN_CONF:
                res["problems"][KP_NAMES[k]] = "nicht zu sehen"
            else:
                e = _edge(u, v, IMG_W, IMG_H)
                if e:
                    res["problems"][KP_NAMES[k]] = EDGE_DE[e]
    if res["problems"]:
        res["ok"] = False
        parts = [f"{name} {why}" for name, why in res["problems"].items()]
        res["warnings"].append("Nicht sicher im Bild: " + ", ".join(parts) + ".")
    # Abstand
    p0 = main[0]
    kp = p0.get("kp") or []
    torso = [(float(kp[3 * k]), float(kp[3 * k + 1])) for k in TORSO
             if len(kp) >= 3 * k + 3 and float(kp[3 * k + 2]) >= KP_MIN_CONF]
    z = depth_at(depth, torso)
    exp_z = expected_depth_m(plan, shot)
    res["expected_m"] = round(exp_z, 2)
    if z is not None:
        res["distance_m"] = round(z, 2)
        if abs(z - exp_z) > max(0.45, 0.25 * exp_z):
            res["ok"] = False
            closer = "zu nah an der Kinect" if z < exp_z else "zu weit weg"
            res["warnings"].append(f"Abstand {de(z, 1)} m statt etwa {de(exp_z, 1)} m: {closer}. Stimmt die Marke?")
    return res


class PoseWatch(threading.Thread):
    """Fragt /api/poses regelmäßig ab: letzter Stand für den Bildcheck und Statistik während des Takes."""

    def __init__(self, hub: Hub, plan: Plan, shot: dict, interval: float = 0.4):
        super().__init__(name="posewatch", daemon=True)
        self.hub, self.plan, self.shot, self.interval = hub, plan, shot, interval
        self.stop_ev = threading.Event()
        self.lock = threading.Lock()
        self.latest: dict | None = None
        self.samples = 0
        self.checked = 0
        self.no_person = 0
        self.bad: dict[str, int] = {}
        self.counting = False

    def run(self) -> None:
        while not self.stop_ev.is_set():
            doc = self.hub.poses()
            with self.lock:
                self.latest = doc
                if self.counting:
                    self._count(doc)
            self.stop_ev.wait(self.interval)

    def _count(self, doc: dict | None) -> None:
        self.samples += 1
        r = assess_framing(self.plan, self.shot, doc, None)
        if not r["checked"]:
            return
        self.checked += 1
        if int(self.shot.get("persons", 1)) > 0 and not r["persons"]:
            self.no_person += 1
        for name in r["problems"]:
            self.bad[name] = self.bad.get(name, 0) + 1

    def start_counting(self) -> None:
        with self.lock:
            self.counting = True

    def stop(self) -> None:
        self.stop_ev.set()

    def summary(self) -> dict:
        with self.lock:
            n = max(1, self.checked)
            worst = sorted(((v / n, k) for k, v in self.bad.items()), reverse=True)
            return {"samples": self.samples, "checked": self.checked,
                    "no_person": round(self.no_person / n, 2) if self.checked else None,
                    "not_visible": {k: round(f, 2) for f, k in worst}}


# ---------------------------------------------------------------------------------------------
# .k2rec lesen (nur Köpfe; Format: kinect-hub/src/recording.rs)


def scan_k2rec(path: Path) -> dict | None:
    """Frames, IR, Dauer und fps einer Aufnahme; liest nur die Köpfe. None = keine k2rec-Datei."""
    try:
        size = path.stat().st_size
        with open(path, "rb") as f:
            hdr = f.read(32)
            if len(hdr) < 32:
                return None
            magic, version, header_len, w, h, info_len, lut_len, _ = struct.unpack("<IIIHHIIQ", hdr)
            if magic != K2REC_MAGIC:
                return None
            try:
                info = json.loads(f.read(info_len).decode("utf-8", "replace")) if info_len < (1 << 20) else {}
            except ValueError:
                info = {}
            pos, frames, with_ir, first, last = header_len, 0, 0, None, None
            while pos + 24 <= size:
                f.seek(pos)
                fh = f.read(24)
                if len(fh) < 24:
                    break
                fm, _seq, cap, flags, _r, plen = struct.unpack("<IIQHHI", fh)
                if fm != K2REC_FRAME or pos + 24 + plen > size:
                    break
                frames += 1
                with_ir += flags & 1
                first = cap if first is None else first
                last = cap
                pos += 24 + plen
    except OSError:
        return None
    dur = (last - first) / 1e6 if frames > 1 and first is not None and last is not None else 0.0
    return {"version": version, "width": w, "height": h, "frames": frames, "frames_ir": with_ir,
            "first_capture_us": first, "last_capture_us": last, "duration_s": round(dur, 3),
            "fps": round((frames - 1) / dur, 2) if dur > 0 else 0.0, "bytes": size,
            "complete": pos == size, "recorded_at_us": info.get("recorded_at_us") if isinstance(info, dict) else None}


# ---------------------------------------------------------------------------------------------
# Probe: kinect-hub-probe record

SUMMARY_RE = re.compile(
    r"^(?P<file>.+): (?P<frames>\d+) frames \((?P<ir>\d+) with IR\), (?P<secs>[\d.]+) s, (?P<fps>[\d.]+) fps, "
    r"(?P<skipped>\d+) skipped by the hub stream, (?P<mb>[\d.]+) MB \((?P<reason>.*)\)\s*$")
PROGRESS_RE = re.compile(r"^\s*([\d.]+) s, (\d+) frames\s*$")


def parse_probe_output(lines: list[str]) -> dict:
    """Zusammenfassung, Fehler und Hinweise aus der Ausgabe der Probe."""
    out: dict = {}
    for ln in lines:
        m = SUMMARY_RE.match(ln.strip())
        if m:
            out.update(frames=int(m["frames"]), frames_ir=int(m["ir"]), duration_s=float(m["secs"]),
                       fps=float(m["fps"]), skipped=int(m["skipped"]), size_mb=float(m["mb"]), reason=m["reason"])
        elif ln.startswith("record failed:"):
            out["error"] = ln[len("record failed:"):].strip()
        elif ln.startswith("note:"):
            out.setdefault("notes", []).append(ln[len("note:"):].strip())
        elif ln.startswith("hub:"):
            out.setdefault("hub_messages", []).append(ln[len("hub:"):].strip())
    return out


class ProbeRun:
    """Startet die Probe und liest ihre Ausgabe in Threads mit (stdout ist zeilengepuffert)."""

    def __init__(self, cmd: list[str], env: dict | None = None):
        self.cmd = cmd
        self.lines: list[str] = []
        self.lock = threading.Lock()
        self.started_at: float | None = None  # time.monotonic() bei „recording ...“
        self.started_unix: float | None = None
        self.progress_frames: int | None = None
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                                     text=True, encoding="utf-8", errors="replace", bufsize=1, env=env)
        self.readers = [threading.Thread(target=self._read, args=(self.proc.stdout,), daemon=True),
                        threading.Thread(target=self._read, args=(self.proc.stderr,), daemon=True)]
        for t in self.readers:
            t.start()

    def _read(self, stream) -> None:
        try:
            for line in stream:
                line = line.rstrip("\r\n")
                now, unix = time.monotonic(), time.time()
                with self.lock:
                    self.lines.append(line)
                    if line.strip() == "recording ..." and self.started_at is None:
                        self.started_at, self.started_unix = now, unix
                    m = PROGRESS_RE.match(line)
                    if m:
                        self.progress_frames = int(m.group(2))
        except (OSError, ValueError):
            pass

    def alive(self) -> bool:
        return self.proc.poll() is None

    def interrupt(self) -> bool:
        """Wie Strg+C (nur POSIX; unter Windows bekommt die Probe Strg+C direkt von der Konsole)."""
        if os.name == "nt" or not self.alive():
            return False
        try:
            self.proc.send_signal(signal.SIGINT)
            return True
        except OSError:
            return False

    def kill(self) -> None:
        try:
            self.proc.kill()
        except OSError:
            pass

    def finish_reading(self, timeout: float = 3.0) -> None:
        for t in self.readers:
            t.join(timeout)

    def output(self) -> list[str]:
        with self.lock:
            return list(self.lines)


# ---------------------------------------------------------------------------------------------
# Sitzungslog = Stand


class SessionLog:
    def __init__(self, folder: Path, session: int):
        self.folder = folder
        self.path = folder / LOG_NAME
        self.data: dict = {}
        if self.path.exists():
            try:
                self.data = json.loads(self.path.read_text(encoding="utf-8"))
                if not isinstance(self.data, dict):
                    raise ValueError("kein Objekt")
            except (OSError, ValueError) as e:
                broken = self.path.with_name(f"sitzung.kaputt-{int(time.time())}.json")
                try:
                    os.replace(self.path, broken)
                except OSError:
                    pass
                print(f"Achtung: {self.path} war nicht lesbar ({e}); beiseitegelegt als {broken.name}.", flush=True)
                self.data = {}
        d = self.data
        d.setdefault("format", LOG_FORMAT)
        d.setdefault("version", LOG_VERSION)
        d.setdefault("session", session)
        d.setdefault("folder", folder.name)
        d.setdefault("created_at", iso_now())
        d.setdefault("consents", [])
        d.setdefault("placements", {})
        d.setdefault("shots", {})
        d.setdefault("takes", [])
        d.setdefault("events", [])

    @property
    def takes(self) -> list[dict]:
        return self.data["takes"]

    def save(self) -> None:
        self.data["updated_at"] = iso_now()
        write_json_atomic(self.path, self.data)

    def event(self, text: str) -> None:
        self.data["events"].append({"at": iso_now(), "text": text})

    def kept(self, shot_id: str, placement: int | None = None) -> list[dict]:
        return [t for t in self.takes if t.get("shot") == shot_id and t.get("keep") is True
                and (placement is None or t.get("placement") == placement)]

    def shot_status(self, shot_id: str) -> str | None:
        return (self.data["shots"].get(shot_id) or {}).get("status")

    def set_shot_status(self, shot_id: str, status: str, why: str = "") -> None:
        entry = self.data["shots"].setdefault(shot_id, {})
        entry["status"] = status
        entry["at"] = iso_now()
        if why:
            entry["why"] = why

    def placement(self, setup: str) -> dict | None:
        lst = self.data["placements"].get(setup) or []
        return lst[-1] if lst else None

    def new_placement(self, setup: str, why: str) -> dict:
        lst = self.data["placements"].setdefault(setup, [])
        p = {"n": len(lst) + 1, "at": iso_now(), "why": why}
        lst.append(p)
        return p


def take_numbers_on_disk(rec_root: Path, shot_id: str) -> list[int]:
    pat = re.compile(re.escape(shot_id) + r"_t(\d+)\.k2rec(?:\.part)?$")
    nums = []
    if rec_root.exists():
        for p in rec_root.rglob(f"{shot_id}_t*"):
            m = pat.match(p.name)
            if m:
                nums.append(int(m.group(1)))
    return nums


def next_take_number(rec_root: Path, shot_id: str, logs) -> int:
    """Nächste freie Take-Nummer, über alle Termine: nie eine Datei oder einen Logeintrag doppelt."""
    nums = take_numbers_on_disk(rec_root, shot_id)
    for log in logs:  # auch gelöschte Takes behalten ihre Nummer; Fehlversuche ohne Datei nicht
        nums += [int(t.get("take", 0)) for t in log.takes
                 if t.get("shot") == shot_id and (t.get("frames") or t.get("deleted"))]
    return max(nums, default=0) + 1


# ---------------------------------------------------------------------------------------------
# Kleine Webseite: Ansage groß + Infrarotbild mit Skelett (nur 127.0.0.1)

PAGE_HTML = r"""<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mocap-Aufnahme</title>
<style>
:root{--bg:#101214;--panel:#1b1f23;--fg:#f1f1f1;--dim:#9aa3ad;--ok:#3ccf5a;--bad:#ff5a4f;--warn:#ffbf3c;--acc:#4aa8ff}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font-family:system-ui,"Segoe UI",sans-serif}
main{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:16px;min-height:100vh;padding:16px}
@media (max-aspect-ratio:1/1){main{grid-template-columns:1fr}}
#view{align-self:start}canvas{width:100%;height:auto;display:block;background:#000;border-radius:8px}
#legend{color:var(--dim);font-size:14px;margin-top:6px}
#panel{background:var(--panel);border-radius:8px;padding:16px 20px;display:flex;flex-direction:column;gap:10px;min-width:0}
#head{color:var(--dim);font-size:clamp(14px,2.2vh,22px)}
#big{font-size:clamp(44px,13vh,180px);font-weight:800;line-height:1.02;overflow-wrap:anywhere}
#big.huge{font-size:clamp(90px,36vh,420px);line-height:.95}#big.long{font-size:clamp(34px,8.5vh,110px)}
#sub{font-size:clamp(20px,4.2vh,52px);font-weight:600}
#bar{height:16px;background:#2c3238;border-radius:8px;overflow:hidden}#bar>i{display:block;height:100%;width:0;background:var(--acc)}
#time{font-size:clamp(16px,2.6vh,30px);color:var(--dim);font-variant-numeric:tabular-nums}
ul{margin:0;padding-left:1.1em}#say li{font-size:clamp(16px,2.8vh,32px);margin:.15em 0}
#cues{list-style:none;padding:0;color:var(--dim)}#cues li{font-size:clamp(15px,2.4vh,28px);margin:.1em 0}
#cues li.now{color:var(--warn);font-weight:700}#cues li.past{opacity:.45}
#frame{list-style:none;padding:0}#frame li{font-size:clamp(14px,2.2vh,24px);background:rgba(0,0,0,.4);border-radius:6px;padding:4px 10px;margin:4px 0}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
body.signal #panel{background:#1f7a2e}body.rec #big{color:#ff6b61}body.warnflash #panel{outline:6px solid var(--warn)}
#offline{display:none;position:fixed;inset:auto 16px 16px auto;background:var(--bad);color:#fff;padding:8px 12px;border-radius:6px}
</style></head><body>
<main><section id="view"><canvas id="cv" width="512" height="424"></canvas>
<div id="legend">Infrarotbild wie ein Spiegel. Grün: Gelenk im Bild, rot: fehlt oder am Rand, gestrichelt: Bildrand.</div></section>
<section id="panel"><div id="head"></div><div id="big"></div><div id="sub"></div>
<div id="bar"><i></i></div><div id="time"></div><ul id="cues"></ul><ul id="say"></ul><ul id="frame"></ul></section></main>
<div id="offline">Aufnahme-Tool antwortet nicht</div>
<script>
const W=512,H=424,M=6,cv=document.getElementById('cv'),g=cv.getContext('2d');
const EDGES=[[5,7],[7,9],[6,8],[8,10],[5,6],[5,11],[6,12],[11,12],[11,13],[13,15],[12,14],[14,16],[0,1],[0,2],[1,3],[2,4]];
let st={},poses=null,img=null;
const $=id=>document.getElementById(id);
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
async function pollState(){try{const r=await fetch('state',{cache:'no-store'});st=await r.json();$('offline').style.display='none';render();}
catch(e){$('offline').style.display='block'}setTimeout(pollState,200)}
function pollImg(){const im=new Image();im.onload=()=>{img=im;draw();setTimeout(pollImg,250)};im.onerror=()=>{img=null;draw();setTimeout(pollImg,1000)};im.src='ir.png?t='+Date.now()}
async function pollPoses(){try{const r=await fetch('poses',{cache:'no-store'});poses=await r.json()}catch(e){poses=null}draw();setTimeout(pollPoses,300)}
function inside(u,v){return u>=M&&v>=M&&u<=W-1-M&&v<=H-1-M}
function draw(){g.fillStyle='#000';g.fillRect(0,0,W,H);
 if(img)g.drawImage(img,0,0,W,H);else{g.fillStyle='#888';g.font='18px sans-serif';g.fillText('kein Infrarotbild vom Hub',20,36)}
 g.strokeStyle='rgba(255,191,60,.6)';g.setLineDash([6,6]);g.lineWidth=1;g.strokeRect(M,M,W-2*M,H-2*M);g.setLineDash([]);
 const need=new Set(st.needed||[]);const list=(poses&&poses.poses)||[];
 for(const p of list){if((p.score||0)<0.4)continue;const k=p.kp||[];
  g.lineWidth=3;g.strokeStyle='rgba(74,168,255,.9)';
  for(const[a,b]of EDGES){if(k[3*a+2]>=.3&&k[3*b+2]>=.3){g.beginPath();g.moveTo(k[3*a],k[3*a+1]);g.lineTo(k[3*b],k[3*b+1]);g.stroke()}}
  for(let j=0;j<17;j++){const u=k[3*j],v=k[3*j+1],c=k[3*j+2];if(c===undefined)continue;
   const good=c>=.3&&inside(u,v);if(!need.has(j)&&c<.3)continue;
   g.fillStyle=need.has(j)?(good?'#3ccf5a':'#ff5a4f'):'#d0d0d0';g.beginPath();g.arc(Math.min(W-4,Math.max(4,u)),Math.min(H-4,Math.max(4,v)),need.has(j)?6:4,0,7);g.fill()}}
}
function render(){document.body.className=(st.phase||'')+(st.flash?' warnflash':'');
 $('head').textContent=st.head||'';$('big').textContent=st.big||'';$('sub').textContent=st.sub||'';
 $('big').classList.toggle('huge',String(st.big||'').length<=3);$('big').classList.toggle('long',String(st.big||'').length>16);
 const cn=st.cue_now??-1;$('cues').innerHTML=(st.cues||[]).map((c,i)=>'<li class="'+(i===cn?'now':i<cn?'past':'')+'">'+esc(String(c.t).replace('.',','))+' s · '+esc(c.say)+'</li>').join('');
 const p=st.progress;$('bar').style.visibility=p?'visible':'hidden';
 if(p){$('bar').firstElementChild.style.width=Math.max(0,Math.min(100,100*p.t/p.total))+'%';$('time').textContent=p.text||''}else $('time').textContent='';
 $('say').innerHTML=(st.say||[]).map((s,i)=>'<li'+(i===st.say_now?' class="now"':'')+'>'+esc(s)+'</li>').join('');
 const f=st.framing;let h='';
 if(f){if(f.ok&&f.checked)h+='<li class="ok">Bild passt'+(f.distance_m?' · Abstand '+String(f.distance_m).replace('.',',')+' m':'')+'</li>';
  for(const w of f.warnings||[])h+='<li class="'+(f.ok?'warn':'bad')+'">'+esc(w)+'</li>'}
 for(const n of st.notes||[])h+='<li class="warn">'+esc(n)+'</li>';
 $('frame').innerHTML=h}
pollState();pollImg();pollPoses();
</script></body></html>
"""


class Page:
    """Lokale Webseite: GET / (Seite), /state (JSON), /ir.png und /poses (vom Hub durchgereicht)."""

    def __init__(self, hub: Hub, port: int):
        self.hub = hub
        self.want_port = port
        self.lock = threading.Lock()
        self.state: dict = {"phase": "idle", "big": "", "head": "Aufnahme-Tool", "sub": ""}
        self.clock: dict | None = None
        self.server: http.server.ThreadingHTTPServer | None = None
        self.url: str | None = None

    def start(self) -> str | None:
        page = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):  # still
                pass

            def _send(self, code: int, body: bytes, ctype: str) -> None:
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):  # noqa: N802
                host = (self.headers.get("Host") or "").split(":")[0].strip("[]").lower()
                if host not in ("127.0.0.1", "localhost", "::1"):
                    self._send(403, b"nur lokal", "text/plain")
                    return
                path = urllib.parse.urlsplit(self.path).path
                try:
                    if path in ("/", "/index.html"):
                        self._send(200, PAGE_HTML.encode("utf-8"), "text/html; charset=utf-8")
                    elif path == "/state":
                        self._send(200, json.dumps(page.snapshot(), ensure_ascii=False).encode("utf-8"),
                                   "application/json; charset=utf-8")
                    elif path == "/ir.png":
                        body, _ = page.hub.get("/api/frame/ir?format=png", 2.0)
                        self._send(200, body, "image/png")
                    elif path == "/poses":
                        body, _ = page.hub.get("/api/poses", 2.0)
                        self._send(200, body, "application/json")
                    else:
                        self._send(404, b"nicht gefunden", "text/plain")
                except HubDown as e:
                    self._send(502, f"Hub: {e}".encode("utf-8"), "text/plain; charset=utf-8")
                except (BrokenPipeError, ConnectionResetError):
                    pass

        for port in ([self.want_port] if self.want_port else []) + [0]:
            try:
                self.server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
                break
            except OSError:
                continue
        if self.server is None:
            return None
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, name="page", daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/"
        return self.url

    def stop(self) -> None:
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()

    def update(self, **kw) -> None:
        with self.lock:
            self.state.update(kw)

    def set(self, **kw) -> None:
        """Neuer Zustand (ersetzt alles außer dem Kopf)."""
        with self.lock:
            head = self.state.get("head", "")
            self.state = {"head": head, **kw}

    def set_clock(self, t0: float | None, total: float = 0, tf: float = 1.0, offset: float = 0.0) -> None:
        with self.lock:
            self.clock = None if t0 is None else {"t0": t0, "total": total, "tf": tf, "offset": offset}

    def snapshot(self) -> dict:
        with self.lock:
            s = dict(self.state)
            c = self.clock
        if c:
            t = (time.monotonic() - c["t0"]) / c["tf"] - c["offset"]
            total = c["total"]
            s["progress"] = {"t": max(0.0, t + c["offset"]), "total": total + c["offset"],
                             "text": f"{de(max(-c['offset'], t), 1)} s von {de(total, 0)} s"}
        return s


class NoPage:
    url = None

    def start(self):
        return None

    def stop(self):
        pass

    def update(self, **kw):
        pass

    def set(self, **kw):
        pass

    def set_clock(self, *a, **kw):
        pass


# ---------------------------------------------------------------------------------------------
# Das Tool

PACE_DE = {"still": "still (niemand bewegt sich)", "slow": "langsam, mit Halten", "teach": "Lehrtempo (eine Schlaufe etwa 3 s)",
           "natural": "dein Arbeitstempo"}

CONSENT_TEXT = """\
Datenschutz, bitte einmal lesen:
  • Die Aufnahmen zeigen dich und deinen Raum: Tiefe und Infrarot. Im Infrarotbild ist dein Gesicht erkennbar.
  • Sie bleiben auf diesem Rechner, in {root}
    (der Ordner recordings/ ist von git ausgeschlossen).
  • Sie werden nie committet und ohne dein ausdrückliches Ja nirgendwohin hochgeladen:
    keine Cloud, kein Chat, kein Colab oder Kaggle.
  • Ins Repository kommen später höchstens die Gelenkdaten (Zahlen, keine Bilder), und nur mit deinem Okay.
  • Niemand sonst im Bild. Eine zweite Person nur, wenn sie zugestimmt hat; sie kann jederzeit abbrechen
    und ihre Takes löschen lassen.
  • Du kannst jederzeit aufhören (q oder Strg+C) und Aufnahmen löschen."""


def variant_for(shot: dict, k: int) -> str | None:
    variants = shot.get("variants") or []
    return variants[k - 1] if 0 < k <= len(variants) else None


class Recorder:
    def __init__(self, args, plan: Plan):
        self.args = args
        self.plan = plan
        self.tf = float(args.zeitfaktor)
        self.yes = bool(args.yes)
        self.auto = bool(args.auto_keep)
        self.ui = Ui(tty=sys.stdout.isatty(), color=not args.no_color)
        self.keys = Keys()
        self.beep = Beeper(enabled=not args.leise, bell_ok=self.ui.tty)
        self.hub = Hub(args.hub)
        self.main: Path | None = None
        self.probe: Path | None = None
        self.rec_root: Path | None = None
        self.logs: dict[str, SessionLog] = {}
        self.page = NoPage()
        self.current_setup: str | None = None
        self.current_placement: dict[str, int] = {}
        self.second_person_ok: bool | None = None
        self.optional_answers: dict[str, bool] = {}
        self.explicit_shots: set[str] = set()
        self.base_kept: dict[str, int] = {}
        self.consented = False
        self.interrupted = False
        self.closed: set[str] = set()  # in diesem Lauf übersprungen oder „genug“
        if getattr(args, "mb_pro_s", None):
            plan.mb_per_s = float(args.mb_pro_s)

    # --- Fragen -----------------------------------------------------------------------------

    def ask(self, prompt: str, keys: dict[str, str], default: str) -> str:
        """Fragt nach einer Taste; keys: Taste -> Ergebnis. Mit --yes sofort default."""
        if self.yes:
            self.ui.out(self.ui.c(prompt, "b") + f"  → {default} (--yes)")
            return default
        self.keys.flush()
        self.ui.out(self.ui.c(prompt, "b"))
        while True:
            try:
                k = self.keys.key()
            except (KeyboardInterrupt, EOFError) as e:
                raise UserQuit from e
            if k in keys:
                return keys[k]
            if len(k) > 1 and k[:1] in keys and not self.keys.tty:
                return keys[k[:1]]

    def yes_no(self, prompt: str, default: bool) -> bool:
        hint = "[J/n]" if default else "[j/N]"
        keys = {"j": "j", "y": "j", "n": "n", "enter": "j" if default else "n"}
        return self.ask(f"{prompt} {hint}", keys, "j" if default else "n") == "j"

    def line(self, prompt: str) -> str:
        if self.yes:
            return ""
        self.keys.flush()
        try:
            return input(prompt).strip()
        except (KeyboardInterrupt, EOFError) as e:
            raise UserQuit from e

    def wait_enter(self, prompt: str = "Weiter mit Enter (q = beenden)") -> None:
        r = self.ask(prompt, {"enter": "go", "space": "go", "pgdn": "go", "right": "go", "q": "quit", "esc": "quit"}, "go")
        if r == "quit":
            raise UserQuit

    # --- Vorbereitung -----------------------------------------------------------------------

    def setup_paths(self) -> None:
        self.main = find_main(self.args.main)
        self.rec_root = Path(self.args.ziel).resolve() if self.args.ziel else self.main / "recordings" / "mocap"

    def log_for(self, shot: dict) -> SessionLog:
        name = self.plan.folder_name(shot)
        if name not in self.logs:
            assert self.rec_root is not None
            self.logs[name] = SessionLog(self.rec_root / name, self.plan.session_of[shot["setup"]])
        return self.logs[name]

    def load_all_logs(self) -> None:
        """Alle vorhandenen Sitzungslogs (für Take-Nummern und den Stand)."""
        if self.rec_root and self.rec_root.exists():
            for p in sorted(self.rec_root.glob(f"*/{LOG_NAME}")):
                if p.parent.name not in self.logs:
                    m = re.match(r"termin(\d+)$", p.parent.name)
                    self.logs[p.parent.name] = SessionLog(p.parent, int(m.group(1)) if m else 0)

    def hub_instructions(self, why: str) -> str:
        main = self.main or Path("<Hauptordner>")
        exe = main / "kinect-hub" / "target" / "release" / ("kinect-hub.exe" if os.name == "nt" else "kinect-hub")
        if os.name == "nt":
            how = (f"  1. Kinect an USB 3 und Strom.\n"
                   f"  2. Neues Fenster: Windows-Taste, „cmd“, Enter, dann:\n"
                   f"       cd /d \"{main}\"\n"
                   f"       \"{exe}\"\n"
                   f"     (oder im Explorer {exe.name} in {exe.parent} doppelklicken). Das Fenster offen lassen.\n")
        else:
            how = (f"  1. Kinect anstecken.\n"
                   f"  2. In einem eigenen Terminal im Hauptordner:\n"
                   f"       cd \"{main}\" && \"{exe}\"\n")
        return (f"Der Hub läuft nicht oder antwortet nicht ({why}).\n"
                f"So startest du ihn (nur den Hub, nicht start-wand.cmd):\n{how}"
                f"  3. Warte, bis {self.hub.base}/api/status \"streaming\" zeigt (etwa 30 fps).\n"
                f"Dann starte die Aufnahme neu. (Das Tool startet oder stoppt den Hub nie selbst.)")

    def check_hub(self, first: bool) -> dict:
        """Prüft den Hub; wartet kurz, falls die Kinect noch startet. Wirft Fatal, wenn er nicht läuft
        (mitten in der Sitzung darfst du ihn erst neu starten)."""
        while True:
            try:
                st = self.hub.status()
                break
            except HubDown as e:
                if first or self.yes:
                    raise Fatal(self.hub_instructions(str(e)), EXIT_HUB) from e
                self.ui.out(self.ui.c(self.hub_instructions(str(e)), "red"))
                self.beep.tone("warn")
                if not self.yes_no("Läuft der Hub wieder? Nochmal prüfen", True):
                    raise UserQuit from e
        waited = 0.0
        while ((st.get("sensor") or {}).get("state")) != "streaming":
            sensor = st.get("sensor") or {}
            state, detail = sensor.get("state", "?"), sensor.get("detail", "")
            hint = {"searching": "Die Kinect wird nicht gefunden: USB 3 und Netzteil prüfen.",
                    "starting": "Die Kinect startet gerade.",
                    "offline": "Der Hub hat keinen laufenden Sensor."}.get(state, "")
            self.ui.status(f"Warte auf Bilder vom Hub: Sensor „{state}“ {detail[:60]} … {hint}")
            if waited >= 20 * max(self.tf, 0.05):
                self.ui.end_status()
                msg = f"Der Hub liefert keine Bilder (Sensor „{state}“: {detail}). {hint}"
                if self.yes:
                    raise Fatal(msg, EXIT_HUB)
                self.ui.out(self.ui.c(msg, "red"))
                if not self.yes_no("Nochmal prüfen?", True):
                    raise UserQuit
                waited = 0.0
            time.sleep(1.0 * max(self.tf, 0.05))
            waited += 1.0 * max(self.tf, 0.05)
            try:
                st = self.hub.status()
            except HubDown as e:
                raise Fatal(self.hub_instructions(str(e)), EXIT_HUB) from e
        self.ui.end_status()
        if not first:
            return st
        src = st.get("source")
        fps = float(st.get("fps") or 0)
        self.ui.out(f"Hub: {self.hub.base} · Quelle {src} · {de(fps, 1)} fps · Sensor streaming")
        if src != "kinect":
            self.ui.out(self.ui.c(f"Achtung: Der Hub liest nicht von der Kinect, sondern „{src}“. "
                                  "Für echte Aufnahmen den Hub mit der Kinect starten.", "yellow"))
            if not self.yes and not self.yes_no("Trotzdem aufnehmen (zum Testen)?", False):
                raise UserQuit
        if 0 < fps < 25:
            self.ui.out(self.ui.c(f"Achtung: nur {de(fps, 1)} fps. Schließ Szenen, Browser-Tabs mit der Wand und start-wand.cmd.", "yellow"))
        pose = st.get("pose") or {}
        if pose.get("state") in ("off", "error") and not self.args.ohne_check:
            self.ui.out(self.ui.c(f"Hinweis: Der Hub hat kein Pose-Modell ({pose.get('state')}: {pose.get('detail', '')}). "
                                  "Der Bildcheck fällt aus; im Hauptordner einmal "
                                  "powershell -NoProfile -ExecutionPolicy Bypass -File kinect-hub\\setup-onnxruntime.ps1", "yellow"))
        pages = [r for r in (st.get("render") or []) if isinstance(r, dict) and r.get("visible")]
        if pages:
            names = ", ".join(sorted({str(r.get("scene") or "?") for r in pages}))
            self.ui.out(self.ui.c(f"Achtung: Es läuft eine Szene ({names}). Schließ sie, sonst fehlen Bilder.", "yellow"))
        return st

    def check_disk(self, slots: list[tuple[dict, int]]) -> None:
        assert self.rec_root is not None
        todo = [(s, k) for s, k in slots if not self.slot_done(s, k)]
        if not self.args.ohne_kalibrierung:  # Kalibrierung, die vorangestellt wird
            chosen = {s["id"] for s, _ in slots}
            for su in dict.fromkeys(s["setup"] for s, _ in todo):
                todo += [(c, 1) for c in self.plan.calib_shots(su) if c["id"] not in chosen and not self.kept_count(c)]
        secs = sum(self.plan.record_seconds(s) for s, _ in todo)
        need = secs * self.plan.mb_per_s * 1e6
        free = free_bytes(self.rec_root)
        self.ui.out(f"Geplant: {len(todo)} Takes, {de(secs / 60, 1)} min Aufnahme, ≈ {gb(need)} "
                    f"(mit Reserve für Wiederholungen {gb(need * 1.3)}). Frei: {gb(free)} in {self.rec_root}")
        one = max((self.plan.record_seconds(s) for s, _ in todo), default=0) * self.plan.mb_per_s * 1e6
        if todo and free < one * 1.5 + 0.5e9:
            raise Fatal(f"Zu wenig Speicher: frei {gb(free)}, ein Take braucht bis zu {gb(one)}. "
                        "Verschieb ältere Aufnahmen auf eine externe Platte.", EXIT_DISK)
        if free < need * 1.3:
            self.ui.out(self.ui.c(f"Achtung: Mit Reserve reicht der Platz für etwa {int(free / max(1, need * 1.3) * len(todo))} der "
                                  f"{len(todo)} Takes. Verschieb Aufnahmen zwischendurch auf eine externe Platte.", "yellow"))
            if not self.yes_no("Trotzdem anfangen?", True):
                raise UserQuit

    def ask_consent(self) -> None:
        self.ui.out()
        self.ui.out(CONSENT_TEXT.format(root=self.rec_root))
        self.ui.out()
        if self.yes:
            self.ui.out("Einverstanden? → ja (--yes)")
        elif not self.yes_no("Einverstanden?", False):
            raise Fatal("Ohne dein Einverständnis nimmt das Tool nichts auf.", EXIT_OK)
        self.consented = True

    def note_consent(self, log: SessionLog) -> None:
        stamp = getattr(self, "_consent_stamp", None)
        if stamp is None:
            self._consent_stamp = stamp = {"at": iso_now(), "how": "--yes" if self.yes else "ja"}
        if stamp not in log.data["consents"]:
            log.data["consents"].append(stamp)

    def privacy_guard(self) -> None:
        assert self.main is not None and self.rec_root is not None
        ign = git_ignored(self.main, self.rec_root / "x.k2rec")
        if ign is False:
            raise Fatal(f"{self.rec_root} ist nicht von git ausgeschlossen. Aufnahmen gehören nach recordings/ "
                        "im Hauptordner (dort ignoriert .gitignore sie). Abbruch, damit nichts versehentlich ins Repository kommt.",
                        EXIT_CONFIG)

    # --- Stand ------------------------------------------------------------------------------

    def placement_of(self, shot: dict) -> int:
        return self.current_placement.get(shot["setup"]) or ((self.log_for(shot).placement(shot["setup"]) or {}).get("n") or 0)

    def kept_count(self, shot: dict) -> int:
        log = self.log_for(shot)
        if shot.get("part") == "calib":
            return len(log.kept(shot["id"], self.placement_of(shot)))
        return len(log.kept(shot["id"]))

    def slot_done(self, shot: dict, k: int) -> bool:
        if shot["id"] in self.closed:
            return True
        status = self.log_for(shot).shot_status(shot["id"])
        if status in ("übersprungen", "genug", "ausgelassen") and shot["id"] not in self.explicit_shots and not self.args.again:
            return True
        base = self.base_kept.get(shot["id"], 0) if self.args.again else 0
        return self.kept_count(shot) >= base + k

    # --- Bildschirme ------------------------------------------------------------------------

    def setup_screen(self, setup_id: str) -> None:
        su = self.plan.setups[setup_id]
        k = su.get("kinect") or {}
        ui = self.ui
        ui.clear()
        ui.rule(f"Aufbau {setup_id} · {su.get('name', '')}")
        for ln in setup_section(setup_id):
            if ln.strip().startswith("```"):
                continue
            ui.out("  " + ln.replace("**", "").replace("`", ""))
        ui.out()
        ui.out(ui.c(f"  Kinect: {de(float(k.get('height_m', 0)), 2)} m hoch (Mitte der Vorderseite), "
                    f"{abs(int(k.get('pitch_deg', 0)))}° nach unten, {de(float(k.get('distance_m', 0)), 1)} m Abstand, "
                    f"Richtung {k.get('yaw_deg', 0)}°", "b"))
        for name, text in (su.get("marks") or {}).items():
            ui.wrap(f"Marke {name}: {text}")
        if su.get("view_m"):
            ui.out(f"  Bild an der Marke ≈ {de(su['view_m'][0], 1)} × {de(su['view_m'][1], 1)} m · Platz "
                   f"{de(su.get('space_m', [0, 0])[0], 1)} × {de(su.get('space_m', [0, 0])[1], 1)} m")
        ui.out()
        ui.out(ui.c("  Checkliste:", "b"))
        for item in ("Bodenmarken kleben: Marke (Pfeil = Blickrichtung) und Stativplatz.",
                     "Höhe und Neigung einstellen (Handy-Wasserwaage oben auf die Kinect).",
                     "Die Kinect zeigt genau auf die Marke.",
                     "Vorschau: Auf der Marke die Bewegung machen, die am meisten Platz braucht. Alles im Bild? "
                     "Hände und Kabel vor hellem Hintergrund? Nichts grell weiß?",
                     "Bildränder am Boden markieren (seitlich gehen, bis die Hand verschwindet)."):
            ui.wrap("☐ " + item)
        ui.out()

    def shot_screen(self, shot: dict, k: int, take_no: int, log: SessionLog) -> None:
        ui, plan = self.ui, self.plan
        planned = int(shot.get("takes", 1))
        kept = self.kept_count(shot)
        ui.clear()
        ui.rule(f"{plan.number[shot['id']]} · {shot['id']} · Take {k} von {planned} · Prio {shot.get('prio', '?')}")
        ui.out(ui.c(f"  {shot.get('beat', '')}", "dim"))
        role = shot.get("role") or "–"
        ui.out(f"  Rolle: {ui.c(str(role).upper(), 'yellow')}    Tempo: {PACE_DE.get(shot.get('pace'), shot.get('pace', ''))}")
        mark = shot.get("mark")
        ui.out(f"  Marke: {mark or 'niemand im Bild'}    Länge: {de(float(shot['seconds']), 0)} s "
               f"(+ {de(plan.pre, 0)} s Startpose, {de(plan.post, 0)} s Nachlauf)")
        ui.out(ui.c(f"  Datei: {shot['id']}_t{take_no}.k2rec · behalten bisher: {kept} von {planned}", "dim"))
        if shot.get("props"):
            ui.wrap("Requisiten: " + "; ".join(shot["props"]))
        variants = shot.get("variants") or []
        if variants and k <= len(variants):
            ui.out(ui.c(f"  Diesmal (Take {k}): {variants[k - 1]}", "yellow"))
        if shot.get("mistake"):
            ui.wrap(f"✗ Fehler mit Absicht: {shot['mistake']}", style="red")
        group = plan.group_of(shot["id"])
        if group:
            others = [g for g in group if g != shot["id"]]
            ui.wrap(f"Abwechselnd mit {', '.join(others)}: Take 1 von jedem, dann Take 2 …", style="dim")
        ui.out()
        for s in shot.get("say") or []:
            ui.out("  " + ui.c("▶ " + s, "b"))
        if shot.get("cues"):
            ui.out()
            ui.out("  Ansagen nach dem Klatschen: " + " · ".join(f"{de(float(c['t']), 0)} s {c['say']}" for c in shot["cues"]))
        ui.out()
        if shot.get("notes"):
            ui.wrap(shot["notes"], style="dim")
        needs = shot.get("needs") or []
        legend = (self.plan.legend.get("needs") or {})
        if needs:
            ui.wrap("Die Auswertung braucht: " + "; ".join(legend.get(n, n) for n in needs), style="dim")
        if not plan.clap(shot):
            ui.out(ui.c("  Ohne Klatschen: Nach dem Start hast du Zeit, aus dem Bild zu gehen.", "cyan"))
        ui.out()
        self.page.set(phase="intro", head=self.page_head(shot, k, take_no), big=(str(role) if shot.get("role") else "Leeres Bild"),
                      sub=(variants[k - 1] if variants and k <= len(variants) else shot.get("beat", "")),
                      say=shot.get("say") or [], needed=needed_keypoints(shot), notes=[])

    def page_head(self, shot: dict, k: int, take_no: int) -> str:
        return f"{self.plan.number[shot['id']]} · {shot['id']} · Take {k} von {shot.get('takes', 1)} · Datei _t{take_no}"

    # --- Vorschau ---------------------------------------------------------------------------

    def preview(self, ref_shot: dict, once: bool = False) -> None:
        """Bild prüfen ohne Aufnahme, bis du Enter drückst."""
        ui = self.ui
        ui.out(ui.c("Vorschau: Stell dich auf die Marke und mach die Bewegung, die am meisten Platz braucht.", "b"))
        if self.page.url:
            ui.out(f"Infrarotbild mit Skelett: {self.page.url}")
        ui.out("Enter = fertig")
        self.page.set(phase="preview", head=f"Vorschau · Aufbau {ref_shot['setup']}", big="Vorschau",
                      sub="Stell dich auf die Marke", needed=needed_keypoints(ref_shot), say=[])
        self.keys.flush()
        last_depth, depth = 0.0, None
        warmup = time.monotonic() + 4.0  # die erste Anfrage weckt das Pose-Modell erst
        while True:
            doc = self.hub.poses()
            if (doc is None or doc.get("poses") is None) and time.monotonic() < warmup:
                ui.status("Warte auf das Pose-Modell des Hubs …")
                time.sleep(0.3)
                continue
            if time.monotonic() - last_depth > 1.0:
                depth = self.hub.depth()
                last_depth = time.monotonic()
            r = assess_framing(self.plan, ref_shot, doc, depth)
            self.page.update(framing=r)
            if r["checked"] and r["ok"]:
                dist = f" · Abstand {de(r['distance_m'], 2)} m (Soll ≈ {de(r['expected_m'], 1)} m)" if r["distance_m"] else ""
                text = f"✓ Bild passt{dist}"
            else:
                text = "✗ " + " ".join(r["warnings"]) if r["warnings"] else "…"
            if once or not ui.tty:
                ui.out("Bildcheck: " + text)
                return
            ui.status(text)
            try:
                key = self.keys.poll(0.5)
            except KeyboardInterrupt as e:
                raise UserQuit from e
            if key in ("enter", "space", "pgdn", "right"):
                ui.end_status()
                return
            if key in ("q", "esc"):
                ui.end_status()
                raise UserQuit

    # --- Aufbau betreten --------------------------------------------------------------------

    def enter_setup(self, setup_id: str, any_shot: dict) -> None:
        log = self.log_for(any_shot)
        self.setup_screen(setup_id)
        prev = log.placement(setup_id)
        if prev:
            same = self.yes_no(f"Steht die Kinect noch genau wie bei Aufbau {setup_id} #{prev['n']} (seit {prev['at'][:16].replace('T', ' ')})?", True)
            if same:
                self.current_placement[setup_id] = prev["n"]
            else:
                p = log.new_placement(setup_id, "Kinect neu aufgestellt")
                self.current_placement[setup_id] = p["n"]
                log.event(f"Aufbau {setup_id} neu aufgestellt (#{p['n']})")
        else:
            p = log.new_placement(setup_id, "erster Aufbau")
            self.current_placement[setup_id] = p["n"]
            log.event(f"Aufbau {setup_id} aufgestellt (#{p['n']})")
        self.note_consent(log)
        log.save()
        if not self.yes:
            self.wait_enter("Wenn die Kinect steht: Enter = weiter zur Vorschau (q = beenden)")
        if not self.args.ohne_check:
            ref = next((s for s in self.plan.calib_shots(setup_id) if int(s.get("persons", 1)) > 0), any_shot)
            self.preview(ref, once=self.yes)
        self.current_setup = setup_id
        if self.args.ohne_kalibrierung:
            return
        missing = [s for s in self.plan.calib_shots(setup_id) if not self.kept_count(s)]
        if missing:
            self.ui.out(self.ui.c(f"Kalibrierung für Aufbau {setup_id} #{self.current_placement[setup_id]}: "
                                  + ", ".join(s["id"] for s in missing), "b"))
            for s in missing:
                if self.record_slot(s, 1) == "quit":
                    raise UserQuit

    # --- Ein Take ---------------------------------------------------------------------------

    def countdown_for(self, shot: dict) -> float:
        base = float(self.args.countdown) if self.args.countdown is not None else self.plan.countdown
        return max(base, 10.0) if int(shot.get("persons", 1)) == 0 else base

    def timeline(self, shot: dict) -> list[tuple[float, str, str]]:
        """(Sekunden ab Aufnahmestart, Art, Text)."""
        pre, secs, post = self.plan.pre, float(shot["seconds"]), self.plan.post
        ev: list[tuple[float, str, str]] = []
        cues = shot.get("cues") or []
        if self.plan.clap(shot):
            ev.append((pre, "signal", "Klatschen!"))
            ev.append((pre + 1.0, "go", "Los"))
            for c in cues:
                ev.append((pre + float(c["t"]), "cue", str(c["say"])))
            if not any("endpose" in str(c["say"]).lower() for c in cues) and secs >= 6:
                ev.append((pre + secs - 2.0, "endpose", "Endpose: still halten"))
        else:
            ev.append((pre, "still", "Aufnahme läuft: nichts bewegt sich"))
        ev.append((pre + secs, "post", "Noch still … gleich fertig"))
        ev.append((pre + secs + post, "end", "Fertig"))
        ev.sort(key=lambda e: e[0])
        return ev

    def sleep_until(self, t: float) -> None:
        while True:
            d = t - time.monotonic()
            if d <= 0:
                return
            time.sleep(min(d, 0.05))

    def record_take(self, shot: dict, k: int, take_no: int, out: Path, log: SessionLog) -> dict:
        ui, plan, tf = self.ui, self.plan, self.tf
        rec_s = plan.record_seconds(shot)
        clap = plan.clap(shot)
        entry: dict = {
            "shot": shot["id"], "number": plan.number[shot["id"]], "take": take_no, "slot": k,
            "file": out.name, "setup": shot["setup"], "placement": self.placement_of(shot),
            "role": shot.get("role"), "mark": shot.get("mark"),
            "variant": variant_for(shot, k),
            "planned_s": float(shot["seconds"]), "pre_roll_s": plan.pre, "post_roll_s": plan.post,
            "record_s": rec_s, "clap": clap, "started_at": iso_now(), "keep": None, "notes": [],
        }
        if self.tf != 1.0:
            entry["zeitfaktor"] = self.tf
        watch = PoseWatch(self.hub, plan, shot) if not self.args.ohne_check else None
        head = self.page_head(shot, k, take_no)
        # Countdown
        cd = self.countdown_for(shot)
        if int(shot.get("persons", 1)) == 0:
            hint = "Geh aus dem Bild"
        else:
            hint = f"Geh auf deine Marke ({shot['mark']}): Startpose" if shot.get("mark") else "Geh auf deine Marke: Startpose"
        if variant_for(shot, k):
            hint += f" · Diesmal: {variant_for(shot, k)}"
        try:
            if watch:
                watch.start()
            t0 = time.monotonic()
            n = int(math.ceil(cd))
            for i in range(n, 0, -1):
                ui.clear()
                ui.rule(f"{shot['id']} · Take {k} · {shot.get('role') or 'leeres Bild'}", style="yellow")
                ui.out()
                ui.big(str(i), "yellow")
                ui.out()
                ui.out("  " + ui.c(hint, "b"))
                if not ui.tty:
                    ui.out(f"  Countdown {i}")
                self.page.set(phase="countdown", head=head, big=str(i), sub=hint, say=shot.get("say") or [],
                              needed=needed_keypoints(shot), notes=[])
                self.beep.tone("tick")
                self.sleep_until(t0 + (n - i + 1) * tf)
            # Bildcheck am Ende des Countdowns
            framing = None
            if watch:
                deadline = time.monotonic() + 1.5
                while watch.latest is None and time.monotonic() < deadline:
                    time.sleep(0.05)
                framing = assess_framing(plan, shot, watch.latest, self.hub.depth())
                entry["framing"] = framing
                if not framing["ok"]:
                    self.beep.tone("warn")
        except KeyboardInterrupt:
            if watch:
                watch.stop()
            entry.update(stopped="strg+c vor dem Start", error="vor dem Start abgebrochen, nichts aufgenommen")
            return entry
        # Aufnahme
        cmd = probe_command(self.probe) + ["record", "--seconds", str(rec_s), "--out", str(out), "--url", self.hub.ws_url]
        entry["probe_cmd"] = " ".join(cmd[-8:])
        stopped = None
        try:
            probe = ProbeRun(cmd)
        except OSError as e:
            if watch:
                watch.stop()
            entry.update(error=f"Probe startet nicht: {e}", stopped="fehler")
            return entry
        signal_unix = None
        cue_log: list[dict] = []
        try:
            ui.clear()
            ui.rule(f"{shot['id']} · Take {k}", style="yellow")
            ui.out()
            ui.big("Still" if clap else "Leer", "b")
            ui.out("  " + ui.c("Startpose, still. Die Aufnahme startet …" if clap else "Aufnahme startet …", "b"))
            self._framing_lines(framing)
            self.page.set(phase="prestill", head=head, big="Still", sub="Startpose, die Aufnahme startet",
                          say=shot.get("say") or [], needed=needed_keypoints(shot), framing=framing, notes=[],
                          flash=bool(framing and not framing["ok"]), cues=shot.get("cues") or [], cue_now=-1)
            start_deadline = time.monotonic() + 25
            while probe.started_at is None and probe.alive():
                if time.monotonic() > start_deadline:
                    stopped = "watchdog-start"
                    break
                time.sleep(0.02)
            if probe.started_at is not None:
                if watch:
                    watch.start_counting()
                t_rec = probe.started_at
                events = self.timeline(shot)
                total = plan.pre + float(shot["seconds"]) + plan.post
                self.page.set_clock(t_rec, float(shot["seconds"]), tf, plan.pre)
                hard_deadline = t_rec + rec_s * tf + 20
                ev_i, current, last_status = 0, None, 0.0
                while True:
                    now = time.monotonic()
                    fired = False
                    while ev_i < len(events) and now >= t_rec + events[ev_i][0] * tf:
                        t_ev, kind, text = events[ev_i]
                        ev_i += 1
                        fired = True
                        current = (kind, text)
                        if not ui.tty:
                            ui.out(f"  [{de(t_ev - plan.pre, 1)} s] {text}")
                        unix = time.time()
                        if kind == "signal":
                            signal_unix = unix
                            self.beep.tone("signal")
                        elif kind == "cue":
                            self.beep.tone("cue")
                            cue_log.append({"t": round(t_ev - plan.pre, 2), "say": text, "unix_us": int(unix * 1e6)})
                            self.page.update(cue_now=len(cue_log) - 1)
                        elif kind == "endpose":
                            self.beep.tone("endpose")
                        elif kind == "end":
                            self.beep.tone("end")
                    if fired and current:
                        self._take_screen(shot, k, current, framing, head, len(cue_log) - 1)
                    if not probe.alive():
                        break
                    if now > hard_deadline:
                        stopped = "watchdog"
                        break
                    if ui.tty and now - last_status > 0.1:
                        t_rel = (now - t_rec) / tf - plan.pre
                        frac = max(0.0, min(1.0, (t_rel + plan.pre) / total))
                        bar = "█" * int(frac * 24) + "░" * (24 - int(frac * 24))
                        frames = probe.progress_frames
                        ui.status(f"  {ui.c('● REC', 'rec')} {de(t_rel, 1):>6} s / {de(float(shot['seconds']), 0)} s  ▕{bar}▏"
                                  + (f"  {frames} Bilder" if frames else "") + "   Strg+C = abbrechen")
                        last_status = now
                    time.sleep(0.02)
        except KeyboardInterrupt:
            stopped = "strg+c"
        # Probe sauber beenden
        stopped = self._finish_probe(probe, stopped)
        if watch:
            watch.stop()
            entry["monitor"] = watch.summary()
        self.page.set_clock(None)
        ui.end_status()
        lines = probe.output()
        info = parse_probe_output(lines)
        entry["probe_exit"] = probe.proc.returncode
        entry["probe_output"] = lines[-12:]
        if stopped:
            entry["stopped"] = stopped
        if out.exists() is False:
            part = out.with_name(out.name + ".part")
            if part.exists():
                scan = scan_k2rec(part)
                if scan and scan["frames"] > 0:
                    try:
                        os.replace(part, out)
                        entry["notes"].append("Probe beendet; Aufnahme bis zum letzten ganzen Bild gerettet")
                    except OSError as e:
                        entry["notes"].append(f".part konnte nicht umbenannt werden: {e}")
                else:
                    try:
                        part.unlink()
                    except OSError:
                        pass
        scan = scan_k2rec(out) if out.exists() else None
        if scan:
            entry.update(frames=info.get("frames", scan["frames"]), frames_ir=info.get("frames_ir", scan["frames_ir"]),
                         duration_s=info.get("duration_s", scan["duration_s"]), fps=info.get("fps", scan["fps"]),
                         skipped=info.get("skipped"), size_mb=info.get("size_mb", round(scan["bytes"] / 1e6, 1)),
                         first_capture_us=scan["first_capture_us"], complete=scan["complete"])
            if signal_unix is not None and scan["first_capture_us"]:
                entry["signal_unix_us"] = int(signal_unix * 1e6)
                entry["signal_in_recording_s"] = round(signal_unix - scan["first_capture_us"] / 1e6, 3)
            for c in cue_log:
                if scan["first_capture_us"]:
                    c["in_recording_s"] = round(c["unix_us"] / 1e6 - scan["first_capture_us"] / 1e6, 3)
        else:
            entry["frames"] = 0
        entry["cues"] = cue_log
        if info.get("reason"):
            entry["probe_reason"] = info["reason"]
        if info.get("notes"):
            entry["notes"] += info["notes"]
        if info.get("error"):
            entry["error"] = info["error"]
        elif not scan:
            tail = [ln for ln in lines if ln.strip()][-3:]
            entry["error"] = "Keine Aufnahme entstanden" + (f": {' / '.join(tail)}" if tail else "")
        if probe.started_at is not None:
            entry["rec_start_unix_us"] = int((probe.started_unix or 0) * 1e6)
        return entry

    def _framing_lines(self, framing: dict | None) -> None:
        if not framing:
            return
        ui = self.ui
        if framing["ok"] and framing["checked"]:
            dist = f" · Abstand {de(framing['distance_m'], 2)} m" if framing.get("distance_m") else ""
            ui.out("  " + ui.c(f"✓ Bild passt{dist}", "green"))
        for w in framing["warnings"]:
            ui.out("  " + ui.c("⚠ " + w, "warnbox" if not framing["ok"] else "yellow"))

    def _take_screen(self, shot: dict, k: int, current: tuple[str, str], framing: dict | None, head: str,
                     cue_now: int = -1) -> None:
        ui = self.ui
        kind, text = current
        if ui.tty:
            ui.clear()
            ui.rule(f"{shot['id']} · Take {k} · {shot.get('role') or 'leeres Bild'}", style="red")
            ui.out()
            style = {"signal": "green", "cue": "yellow", "endpose": "cyan", "go": "green", "end": "green"}.get(kind, "b")
            ui.big(text.rstrip("!.") if len(text) <= 14 else text, style)
            ui.out()
            for i, c in enumerate(shot.get("cues") or []):
                line = f"  {de(float(c['t']), 0):>3} s  {c['say']}"
                ui.out(ui.c(line, "yellow") if i == cue_now else ui.c(line, "dim") if i < cue_now else line)
            if shot.get("cues"):
                ui.out()
            for s in shot.get("say") or []:
                ui.out("  " + ui.c("▶ " + s, "dim"))
            self._framing_lines(framing if framing and not framing["ok"] else None)
            ui.out()
        phase = {"signal": "signal", "end": "done"}.get(kind, "rec")
        self.page.update(phase=phase, big=text, sub=("Einmal klatschen, Hände vor der Brust" if kind == "signal" else ""),
                         head=head)

    def _finish_probe(self, probe: ProbeRun, stopped: str | None) -> str | None:
        """Wartet, bis die Probe ihre Datei abgeschlossen hat; notfalls Strg+C (POSIX) und am Ende kill."""
        ui = self.ui
        if probe.alive() and stopped:
            ui.end_status()
            ui.out(ui.c("  Gestoppt. Die Aufnahme wird abgeschlossen …", "yellow"))
        t_start = time.monotonic()
        sent = False
        wait_total = 12.0 if stopped else 25.0
        while probe.alive() and time.monotonic() - t_start < wait_total:
            try:
                time.sleep(0.05)
            except KeyboardInterrupt:
                stopped = stopped or "strg+c"
                continue
            if stopped and not sent and time.monotonic() - t_start > 3:
                sent = probe.interrupt()
        if probe.alive():
            if probe.interrupt():
                for _ in range(100):
                    if not probe.alive():
                        break
                    time.sleep(0.05)
            if probe.alive():
                probe.kill()
                stopped = (stopped or "") + "+kill" if stopped else "kill"
        try:
            probe.proc.wait(5)
        except subprocess.TimeoutExpired:
            pass
        probe.finish_reading()
        return stopped

    # --- Nach dem Take ----------------------------------------------------------------------

    def judge(self, shot: dict, e: dict) -> list[str]:
        """Warnungen zur Qualität des Takes."""
        w: list[str] = []
        if e.get("error"):
            return [f"Fehler: {e['error']}"]
        frames, fps = int(e.get("frames") or 0), float(e.get("fps") or 0)
        planned = self.plan.pre + float(shot["seconds"]) + self.plan.post
        if e.get("stopped", "").startswith("strg+c"):
            w.append("Mit Strg+C gestoppt.")
        if e.get("duration_s") is not None and float(e["duration_s"]) < planned - 0.5:
            w.append(f"Kürzer als geplant: {de(float(e['duration_s']), 1)} s statt {de(planned, 0)} s.")
        if 0 < fps < 25:
            w.append(f"Nur {de(fps, 1)} fps: Schließ Szenen und Browser-Tabs, die die Kinect zeigen.")
        if e.get("skipped") and frames and int(e["skipped"]) > 0.02 * frames:
            w.append(f"{e['skipped']} Bilder vom Hub übersprungen.")
        if frames and int(e.get("frames_ir") or 0) < frames:
            w.append(f"{frames - int(e.get('frames_ir') or 0)} Bilder ohne Infrarot.")
        f = e.get("framing")
        if f and not f.get("ok"):
            w.append("Beim Start: " + " ".join(f.get("warnings", [])))
        m = e.get("monitor") or {}
        if m.get("checked"):
            if m.get("no_person") and m["no_person"] > 0.1:
                w.append(f"In {int(m['no_person'] * 100)} % der Zeit niemand erkannt.")
            bad = [(k, v) for k, v in (m.get("not_visible") or {}).items() if v >= 0.15]
            if bad:
                w.append("Nicht sicher zu sehen: " + ", ".join(f"{k} {int(v * 100)} %" for k, v in bad[:4]) + " der Zeit.")
        if e.get("stopped") in ("watchdog", "watchdog-start", "kill"):
            w.append("Die Probe hat nicht von selbst aufgehört und wurde beendet.")
        return w

    def summary_screen(self, shot: dict, e: dict, warnings: list[str]) -> None:
        ui = self.ui
        ui.out()
        if e.get("frames"):
            ui.out(ui.c(f"  Take {e['take']}: {de(float(e.get('duration_s') or 0), 1)} s, {e['frames']} Bilder "
                        f"({e.get('frames_ir', '?')} mit IR), {de(float(e.get('fps') or 0), 1)} fps, "
                        f"{de(float(e.get('size_mb') or 0), 0)} MB → {e['file']}", "green"))
            if e.get("signal_in_recording_s") is not None:
                ui.out(f"  Startsignal bei {de(e['signal_in_recording_s'], 2)} s in der Aufnahme.")
        for w in warnings:
            ui.out("  " + ui.c("⚠ " + w, "yellow" if not e.get("error") else "red"))
        if not warnings:
            ui.out("  " + ui.c("✓ Keine Auffälligkeiten.", "green"))
        out = e.get("probe_output") or []
        if e.get("error") and out:
            ui.out(ui.c("  Ausgabe der Probe:", "dim"))
            for ln in out[-6:]:
                ui.out(ui.c("    " + ln, "dim"))
        self.page.set(phase="done", head=self.page_head(shot, e["slot"], e["take"]),
                      big=("Fehler" if e.get("error") else "Fertig"),
                      sub=f"{e.get('frames', 0)} Bilder" + (f", {de(float(e.get('fps') or 0), 1)} fps" if e.get("frames") else ""),
                      notes=warnings, say=[])

    def decide(self, shot: dict, e: dict, warnings: list[str], log: SessionLog) -> str:
        """Menü nach dem Take. Ergebnis: keep, retake, enough, skip, quit."""
        ok = bool(e.get("frames")) and not e.get("error")
        if self.auto:
            if str(e.get("stopped", "")).startswith("strg+c"):
                return "quit"
            return "keep" if ok else "retake"
        while True:
            if ok:
                prompt = ("[Enter/Bild ab] behalten   [w/Bild auf] wiederholen   [x] löschen + wiederholen\n"
                          "[g] genug: behalten, Shot fertig   [s] Shot überspringen   [n] Notiz   [q] beenden")
                keys = {"enter": "keep", "space": "keep", "pgdn": "keep", "right": "keep", "b": "keep",
                        "w": "retake", "pgup": "retake", "left": "retake", "x": "delete", "g": "enough",
                        "s": "skip", "n": "note", "q": "quit", "esc": "quit"}
            else:
                prompt = "[Enter] nochmal   [s] Shot überspringen   [n] Notiz   [q] beenden"
                keys = {"enter": "retake", "space": "retake", "pgdn": "retake", "w": "retake",
                        "s": "skip", "n": "note", "q": "quit", "esc": "quit"}
            try:
                choice = self.ask(prompt, keys, "keep" if ok else "retake")
            except UserQuit:
                choice = "quit"
            if choice == "note":
                text = self.line("Notiz: ")
                if text:
                    e.setdefault("notes", []).append(text)
                    log.save()
                continue
            if choice == "delete":
                if self.yes_no(f"{e['file']} wirklich löschen?", False):
                    try:
                        (log.folder / e["file"]).unlink()
                        e["deleted"] = True
                        e["notes"].append("gelöscht")
                    except OSError as err:
                        self.ui.out(self.ui.c(f"Löschen ging nicht: {err}", "red"))
                    return "retake"
                continue
            if choice == "quit" and ok:
                keep = self.yes_no("Diesen Take behalten?", True)
                e["keep"] = keep
                return "quit"
            return choice

    def record_slot(self, shot: dict, k: int) -> str:
        """Nimmt Take-Platz k eines Shots auf, bis er behalten oder übersprungen ist. Ergebnis: next, skip, quit."""
        log = self.log_for(shot)
        assert self.rec_root is not None
        failures = 0
        while True:
            take_no = next_take_number(self.rec_root, shot["id"], self.logs.values())
            out = log.folder / f"{shot['id']}_t{take_no}.k2rec"
            self.shot_screen(shot, k, take_no, log)
            if not self.yes:
                r = self.ask("[Enter/Bild ab] Start   [v] Vorschau   [s] Shot überspringen   [q] beenden",
                             {"enter": "go", "space": "go", "pgdn": "go", "right": "go", "f5": "go",
                              "v": "preview", "s": "skip", "q": "quit", "esc": "quit"}, "go")
                if r == "preview":
                    self.preview(shot)
                    continue
                if r == "skip":
                    log.set_shot_status(shot["id"], "übersprungen", "vor dem Take")
                    log.save()
                    self.closed.add(shot["id"])
                    return "skip"
                if r == "quit":
                    return "quit"
            self.check_hub(first=False)
            free = free_bytes(log.folder)
            need = self.plan.record_seconds(shot) * self.plan.mb_per_s * 1e6
            if free < need * 1.5 + 0.5e9:
                raise Fatal(f"Platte fast voll ({gb(free)} frei). Verschieb Aufnahmen auf eine externe Platte und mach dann weiter.", EXIT_DISK)
            log.folder.mkdir(parents=True, exist_ok=True)
            e = self.record_take(shot, k, take_no, out, log)
            log.takes.append(e)
            self.note_consent(log)
            log.save()
            warnings = self.judge(shot, e)
            self.summary_screen(shot, e, warnings)
            choice = self.decide(shot, e, warnings, log)
            if choice == "keep":
                e["keep"] = True
                e["decision"] = "behalten"
            elif choice == "enough":
                e["keep"] = True
                e["decision"] = "genug"
                log.set_shot_status(shot["id"], "genug", f"nach Take {take_no}")
            elif choice == "retake":
                e["keep"] = False
                e["decision"] = "wiederholen"
            elif choice == "skip":
                e["keep"] = False
                e["decision"] = "übersprungen"
                log.set_shot_status(shot["id"], "übersprungen", f"nach Take {take_no}")
            elif choice == "quit":
                e.setdefault("decision", "beendet")
                if e.get("keep") is None:
                    e["keep"] = False
                if self.auto and str(e.get("stopped", "")).startswith("strg+c"):
                    self.interrupted = True
            if e.get("keep") and self.kept_count(shot) >= int(shot.get("takes", 1)) and log.shot_status(shot["id"]) not in ("genug",):
                log.set_shot_status(shot["id"], "fertig")
            log.save()
            if choice in ("enough", "skip"):
                self.closed.add(shot["id"])
                return "skip"
            if choice == "keep":
                return "next"
            if choice == "quit":
                return "quit"
            # wiederholen
            if not (e.get("frames") and not e.get("error")):
                failures += 1
                if self.auto and failures >= 2:
                    raise Fatal(f"Die Aufnahme klappt nicht ({e.get('error', 'keine Bilder')}). Abbruch.", EXIT_ERROR)

    # --- Ablauf -----------------------------------------------------------------------------

    def run(self, shots: list[dict]) -> int:
        ui = self.ui
        slots = build_slots(self.plan, shots)
        self.explicit_shots = {s["id"] for s in shots} if self.args.shot else set()
        self.setup_paths()
        assert self.rec_root is not None
        self.load_all_logs()
        for s in shots:
            self.base_kept[s["id"]] = self.kept_count(s) if s.get("part") != "calib" else 0
        ui.clear()
        ui.rule("Kabel richtig aufwickeln · Kinect-Aufnahme")
        ui.out(f"Hauptordner: {self.main}")
        ui.out(f"Aufnahmen:   {self.rec_root}")
        self.probe = find_probe(self.main, self.args.probe)
        ui.out(f"Probe:       {self.probe}")
        self.privacy_guard()
        self.check_hub(first=True)
        self.check_disk(slots)
        todo = [(s, k) for s, k in slots if not self.slot_done(s, k)]
        if not todo:
            ui.out(ui.c("Alles in deiner Auswahl ist schon aufgenommen. (Neue Takes trotzdem: --again)", "green"))
            return EXIT_OK
        first = todo[0]
        if len(todo) < len(slots):
            ui.out(ui.c(f"Weiter, wo du aufgehört hast: {first[0]['id']} (Take {first[1]}). "
                        f"{len(slots) - len(todo)} Takes sind schon da.", "cyan"))
        self.ask_consent()
        if not self.args.ohne_seite:
            self.page = Page(self.hub, self.args.seite_port)
            url = self.page.start()
            if url:
                ui.out(f"Großanzeige mit Infrarotbild: {url}")
                if ui.tty and not self.yes:
                    try:
                        import webbrowser  # noqa: PLC0415

                        webbrowser.open(url)
                    except Exception:  # noqa: BLE001
                        pass
        try:
            for shot, k in slots:
                if self.slot_done(shot, k):
                    continue
                if shot.get("optional") and shot["id"] not in self.explicit_shots:
                    if shot["id"] not in self.optional_answers:
                        ui.out()
                        ui.wrap(f"Optional: {shot['id']} ({shot.get('role')}). {shot.get('notes', '')}", style="cyan")
                        ans = self.yes_no("Diesen Shot aufnehmen?", bool(self.args.optional)) if not self.yes else bool(self.args.optional)
                        self.optional_answers[shot["id"]] = ans
                        if not ans:
                            log = self.log_for(shot)
                            log.set_shot_status(shot["id"], "ausgelassen", "optional, nicht gewählt")
                            log.save()
                    if not self.optional_answers[shot["id"]]:
                        continue
                if int(shot.get("persons", 1)) >= 2:
                    if self.second_person_ok is None:
                        ui.out()
                        ui.wrap("Für diesen Shot ist eine zweite Person im Bild. Hast du ihr erklärt, was aufgenommen wird, "
                                "und hat sie zugestimmt? Sie kann jederzeit abbrechen und ihre Takes löschen lassen.", style="cyan")
                        self.second_person_ok = self.yes_no("Zweite Person einverstanden?", False) if not self.yes else bool(self.args.optional)
                    if not self.second_person_ok:
                        log = self.log_for(shot)
                        log.set_shot_status(shot["id"], "ausgelassen", "keine zweite Person / kein Einverständnis")
                        log.save()
                        continue
                if shot["setup"] != self.current_setup:
                    self.enter_setup(shot["setup"], shot)
                    if self.slot_done(shot, k):
                        continue
                r = self.record_slot(shot, k)
                if r == "quit":
                    raise UserQuit
        except UserQuit:
            ui.end_status()
            ui.out()
            ui.out(ui.c("Beendet. Der Stand ist gespeichert; beim nächsten Start geht es dort weiter.", "cyan"))
            self.print_progress()
            return EXIT_INTERRUPT if self.interrupted else EXIT_OK
        finally:
            self.page.stop()
        ui.out()
        ui.out(ui.c("Fertig: alles in deiner Auswahl ist aufgenommen.", "green"))
        self.print_progress()
        return EXIT_OK

    def print_progress(self) -> None:
        for name, log in sorted(self.logs.items()):
            kept = [t for t in log.takes if t.get("keep")]
            ui = self.ui
            ui.out(f"  {name}: {len(kept)} Takes behalten, {len(log.takes) - len(kept)} verworfen → {log.path}")


# ---------------------------------------------------------------------------------------------
# Listen


def shot_state(plan: Plan, logs: dict[str, SessionLog], shot: dict) -> str:
    log = logs.get(plan.folder_name(shot))
    if not log:
        return "offen"
    kept = len(log.kept(shot["id"]))
    status = log.shot_status(shot["id"])
    planned = int(shot.get("takes", 1))
    if status in ("übersprungen", "ausgelassen", "genug"):
        return f"{status} ({kept}/{planned})"
    if kept >= planned:
        return f"fertig ({kept}/{planned})"
    return f"offen ({kept}/{planned})" if kept else "offen"


def read_logs(rec_root: Path) -> dict[str, SessionLog]:
    logs: dict[str, SessionLog] = {}
    if rec_root.exists():
        for p in sorted(rec_root.glob(f"*/{LOG_NAME}")):
            m = re.match(r"termin(\d+)$", p.parent.name)
            logs[p.parent.name] = SessionLog(p.parent, int(m.group(1)) if m else 0)
    return logs


def cmd_list(plan: Plan, shots: list[dict], logs) -> None:
    print(f"{'Nr':<4} {'Shot':<20} {'Prio':>4}  {'Rolle':<10} {'Marke':<8} {'Länge':>6}  {'Takes':>5}  Stand")
    for s in shots:
        opt = " (optional)" if s.get("optional") else ""
        print(f"{plan.number[s['id']]:<4} {s['id']:<20} {s.get('prio', ''):>4}  {str(s.get('role') or '–'):<10} "
              f"{str(s.get('mark') or '–'):<8} {str(s['seconds']) + ' s':>6}  {s.get('takes', 1):>5}  {shot_state(plan, logs, s)}{opt}")


def cmd_sessions(plan: Plan, logs) -> None:
    for sess in plan.sessions:
        shots = [s for s in plan.shots if s["setup"] in sess.get("setups", [])]
        takes = sum(int(s.get("takes", 1)) for s in shots)
        secs = sum(plan.record_seconds(s) * int(s.get("takes", 1)) for s in shots)
        done = sum(1 for s in shots if shot_state(plan, logs, s).startswith(("fertig", "genug")))
        print(f"Termin {sess['id']}: Aufbau {', '.join(sess.get('setups', []))} · {len(shots)} Shots, {takes} Takes, "
              f"{de(secs / 60, 0)} min Aufnahme, ≈ {gb(secs * plan.mb_per_s * 1e6)} · fertig {done}/{len(shots)}")
        if sess.get("notes"):
            print(f"  {sess['notes']}")
        print(f"  Ordner: recordings/mocap/termin{sess['id']}/  ·  Start: aufnahme.cmd --session {sess['id']}")


def cmd_setups(plan: Plan) -> None:
    for sid in plan.setup_order:
        su = plan.setups[sid]
        k = su.get("kinect") or {}
        n = len(plan.setup_shots(sid))
        print(f"Aufbau {sid} · {su.get('name', '')} · Termin {plan.session_of.get(sid, '?')} · {n} Shots")
        print(f"  Kinect {de(float(k.get('height_m', 0)), 2)} m hoch, {abs(int(k.get('pitch_deg', 0)))}° nach unten, "
              f"{de(float(k.get('distance_m', 0)), 1)} m, Richtung {k.get('yaw_deg', 0)}°: {k.get('position', '')}")
        for name, text in (su.get("marks") or {}).items():
            print(f"  Marke {name}: {text}")


def cmd_status(plan: Plan, rec_root: Path, logs) -> None:
    if not logs:
        print(f"Noch keine Aufnahmen in {rec_root}.")
        return
    for name, log in sorted(logs.items()):
        kept = [t for t in log.takes if t.get("keep")]
        size = sum(p.stat().st_size for p in log.folder.glob("*.k2rec"))
        print(f"{name}: {len(log.takes)} Takes, {len(kept)} behalten, {gb(size)} auf der Platte · zuletzt {log.data.get('updated_at', '?')}")
        sess_setups = next((s.get("setups", []) for s in plan.sessions if f"termin{s['id']}" == name), [])
        open_shots = [s["id"] for s in plan.shots if s["setup"] in sess_setups and shot_state(plan, logs, s).startswith("offen")]
        if open_shots:
            print(f"  offen ({len(open_shots)}): {', '.join(open_shots[:12])}{' …' if len(open_shots) > 12 else ''}")
        dropped = [t for t in log.takes if t.get("keep") is False and not t.get("deleted") and (log.folder / t.get("file", "")).exists()]
        if dropped:
            mb = sum((log.folder / t["file"]).stat().st_size for t in dropped) / 1e6
            print(f"  {len(dropped)} verworfene Takes liegen noch da ({de(mb / 1000, 1)} GB), z. B. {dropped[0]['file']}")


def menu(plan: Plan, args, logs) -> bool:
    """Menü für den Doppelklick. Setzt args.session/setup/shot/prio; False = beenden."""
    print("Kabel richtig aufwickeln · Kinect-Aufnahme")
    print()
    for sess in plan.sessions:
        shots = [s for s in plan.shots if s["setup"] in sess.get("setups", [])]
        done = sum(1 for s in shots if shot_state(plan, logs, s).startswith(("fertig", "genug", "übersprungen", "ausgelassen")))
        nxt = next((s["id"] for s in shots if shot_state(plan, logs, s).startswith("offen")), None)
        print(f"  {sess['id']}   Termin {sess['id']} (Aufbau {', '.join(sess.get('setups', []))}): {done}/{len(shots)} Shots erledigt"
              + (f", weiter bei {nxt}" if nxt and done else ""))
    print(f"  {'/'.join(plan.setup_order)}   nur diesen Aufbau")
    print("  p   Prio 1 von Termin 1 (das Wichtigste)")
    print("  l   Liste aller Shots     v   Vorschau (Bild prüfen, ohne Aufnahme)     q   beenden")
    print("  oder eine Shot-ID / Nummer wie p3.pair.slow oder A6")
    try:
        choice = input("Auswahl: ").strip()
    except (EOFError, KeyboardInterrupt):
        return False
    if not choice or choice.lower() == "q":
        return False
    if choice.lower() == "l":
        cmd_list(plan, plan.shots, logs)
        return menu(plan, args, logs)
    if choice.lower() == "v":
        args.vorschau = True
        try:
            su = input(f"Welcher Aufbau ({'/'.join(plan.setup_order)})? ").strip().upper()
        except (EOFError, KeyboardInterrupt):
            return False
        args.setup = [su or plan.setup_order[0]]
        return True
    if choice.lower() == "p":
        args.session, args.prio = ["1"], 1
        return True
    if choice.isdigit():
        args.session = [choice]
        return True
    if choice.upper() in plan.setups:
        args.setup = [choice.upper()]
        return True
    args.shot = [choice]
    return True


# ---------------------------------------------------------------------------------------------


def parse_args(argv=None):
    ap = argparse.ArgumentParser(
        prog="aufnahme.py",
        description="Geführte Kinect-Aufnahme für „Kabel richtig aufwickeln“ (liest mocap/shots.json). "
                    "Ohne Auswahl erscheint ein Menü.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Beispiele:\n  aufnahme.cmd --session 1\n  aufnahme.cmd --setup A --prio 1\n  aufnahme.cmd --shot p3.pair.slow\n"
               "  aufnahme.cmd --from B12\n  aufnahme.cmd --status")
    g = ap.add_argument_group("Auswahl")
    g.add_argument("--session", action="append", help="Termin (1 oder 2; Komma für mehrere)")
    g.add_argument("--setup", action="append", help="Aufbau A, B, T, C, D (Komma für mehrere)")
    g.add_argument("--shot", action="append", help="Shot-ID oder Nummer (p3.pair.slow, A6; Komma oder mehrfach)")
    g.add_argument("--from", dest="from_", metavar="SHOT", help="ab diesem Shot (bis zum Ende seines Termins oder deiner Auswahl)")
    g.add_argument("--prio", type=int, help="nur Shots bis zu dieser Prio (1 = unbedingt)")
    g.add_argument("--again", action="store_true", help="auch schon fertige Shots neu aufnehmen (neue Take-Nummern)")
    g.add_argument("--optional", action="store_true", help="optionale Shots ohne Nachfrage mit aufnehmen (mit --yes)")
    i = ap.add_argument_group("Anzeigen (ohne Aufnahme)")
    i.add_argument("--list", action="store_true", help="Shots mit Stand auflisten")
    i.add_argument("--sessions", action="store_true", help="Termine")
    i.add_argument("--setups", action="store_true", help="Aufbauten mit Kinect-Position")
    i.add_argument("--status", action="store_true", help="was schon aufgenommen ist")
    i.add_argument("--vorschau", action="store_true", help="nur Bild prüfen (mit --setup oder --shot)")
    o = ap.add_argument_group("Ablauf")
    o.add_argument("--yes", action="store_true", help="keine Fragen: Einverständnis und Standardantworten (für Tests)")
    o.add_argument("--auto-keep", action="store_true", help="kein Menü nach dem Take: jeden gelungenen Take behalten")
    o.add_argument("--countdown", type=float, help="Countdown in Sekunden (Standard aus shots.json: 5)")
    o.add_argument("--leise", action="store_true", help="keine Töne")
    o.add_argument("--ohne-check", action="store_true", help="kein Bildcheck über /api/poses")
    o.add_argument("--ohne-kalibrierung", action="store_true", help="Kalibrier-Shots nicht automatisch voranstellen")
    o.add_argument("--ohne-seite", action="store_true", help="keine Webseite mit Infrarotbild")
    o.add_argument("--seite-port", type=int, default=8097, help="Port der Webseite (Standard 8097, sonst ein freier)")
    o.add_argument("--no-color", action="store_true", help="keine Farben")
    o.add_argument("--mb-pro-s", type=float, help="Datenrate für die Platzrechnung (Standard aus shots.json: 20 MB/s)")
    p = ap.add_argument_group("Pfade")
    p.add_argument("--hub", default=DEFAULT_HUB, help=f"Hub-Adresse (Standard {DEFAULT_HUB})")
    p.add_argument("--main", help="Hauptordner (Standard: aus git worktree list)")
    p.add_argument("--probe", help="Pfad zu kinect-hub-probe(.exe) (Standard: <Hauptordner>/kinect-hub/target/release)")
    p.add_argument("--ziel", help="Aufnahmeordner statt <Hauptordner>/recordings/mocap")
    p.add_argument("--shots-json", default=str(SHOTS_JSON), help=argparse.SUPPRESS)
    p.add_argument("--zeitfaktor", type=float, default=1.0, help=argparse.SUPPRESS)  # Tests: 0.01 = hundertfach schneller
    return ap.parse_args(argv)


def main(argv=None) -> int:
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(errors="replace")  # type: ignore[attr-defined]
        except (AttributeError, ValueError):
            pass
    args = parse_args(argv)
    code = EXIT_OK
    try:
        plan = Plan(Path(args.shots_json))
        main_dir = find_main(args.main)
        rec_root = Path(args.ziel).resolve() if args.ziel else main_dir / "recordings" / "mocap"
        logs = read_logs(rec_root)
        if args.list or args.sessions or args.setups or args.status:
            if args.sessions:
                cmd_sessions(plan, logs)
            if args.setups:
                cmd_setups(plan)
            if args.list:
                cmd_list(plan, select_shots(plan, args) or plan.shots, logs)
            if args.status:
                cmd_status(plan, rec_root, logs)
            return EXIT_OK
        shots = select_shots(plan, args)
        if shots is None:
            if args.yes:
                raise Fatal("Mit --yes brauchst du eine Auswahl: --session, --setup, --shot oder --from.", EXIT_CONFIG)
            if not menu(plan, args, logs):
                return EXIT_OK
            shots = select_shots(plan, args) or []
        if args.vorschau:
            rec = Recorder(args, plan)
            rec.setup_paths()
            rec.check_hub(first=True)
            rec.page = Page(rec.hub, args.seite_port) if not args.ohne_seite else NoPage()
            url = rec.page.start()
            if url and rec.ui.tty:
                try:
                    import webbrowser  # noqa: PLC0415

                    webbrowser.open(url)
                except Exception:  # noqa: BLE001
                    pass
            try:
                if not shots:
                    raise Fatal("Für die Vorschau brauchst du --setup oder --shot.", EXIT_CONFIG)
                ref = next((s for s in shots if int(s.get("persons", 1)) > 0), shots[0])
                rec.preview(ref, once=args.yes)
            except UserQuit:
                pass
            finally:
                rec.page.stop()
            return EXIT_OK
        if not shots:
            print("Deine Auswahl enthält keine Shots.")
            return EXIT_OK
        code = Recorder(args, plan).run(shots)
    except Fatal as e:
        print(("\n" if str(e) else "") + str(e), file=sys.stderr if e.code else sys.stdout, flush=True)
        code = e.code
    except UserQuit:
        print("\nBeendet.", flush=True)
        code = EXIT_OK
    except KeyboardInterrupt:
        print("\nAbgebrochen (Strg+C).", flush=True)
        code = EXIT_INTERRUPT
    if os.environ.get("AUFNAHME_PAUSE") == "1" and sys.stdin is not None and sys.stdin.isatty():
        try:
            input("\nEnter = Fenster schließen ")
        except (EOFError, KeyboardInterrupt):
            pass
    return code


if __name__ == "__main__":
    sys.exit(main())
