"""shots.json (Aufnahmeplan) und sitzung.json (Log des Aufnahme-Tools): was ein Take ist und wozu er gehört."""

import json
import re
import subprocess
from pathlib import Path

MOCAP = Path(__file__).resolve().parents[1]
SHOTS_JSON = MOCAP / "shots.json"
NAME_RE = re.compile(r"^(?P<shot>.+)_t(?P<take>\d+)\.k2rec(?:\.part)?$")


def find_main(explicit=None):
    """Hauptcheckout (dort liegt recordings/): --main, sonst `git worktree list --porcelain`, sonst über .git."""
    if explicit:
        return Path(explicit).resolve()
    try:
        r = subprocess.run(["git", "worktree", "list", "--porcelain"], cwd=MOCAP, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=10, check=False)
        for line in r.stdout.splitlines():
            if line.startswith("worktree "):
                return Path(line[len("worktree "):].strip()).resolve()
    except (OSError, subprocess.SubprocessError):
        pass
    for parent in [MOCAP, *MOCAP.parents]:
        g = parent / ".git"
        if g.is_dir():
            return parent
        if g.is_file():
            m = re.match(r"gitdir:\s*(.+)", g.read_text(encoding="utf-8", errors="replace").strip())
            if m:
                gitdir = Path(m.group(1).strip())
                if not gitdir.is_absolute():
                    gitdir = (parent / gitdir).resolve()
                return gitdir.parent.parent.parent
    return MOCAP.parents[1]


def git_ignored(main, path):
    try:
        r = subprocess.run(["git", "check-ignore", "-q", str(path)], cwd=main, capture_output=True, timeout=10, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.returncode == 0 if r.returncode in (0, 1) else None


class Plan:
    def __init__(self, path=SHOTS_JSON):
        try:
            self.data = json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.data = {"shots": [], "setups": []}
        self.shots = {s["id"]: s for s in self.data.get("shots", [])}
        self.setups = {s["id"]: s for s in self.data.get("setups", [])}

    def shot(self, sid):
        return self.shots.get(sid)

    def kinect(self, setup_id):
        s = self.setups.get(setup_id) or {}
        return dict(s.get("kinect") or {})


def parse_name(path):
    m = NAME_RE.match(Path(path).name)
    if not m:
        return None, None
    return m.group("shot"), int(m.group("take"))


def session_log(folder):
    p = Path(folder) / "sitzung.json"
    if not p.exists():
        return None
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else None
    except (OSError, ValueError):
        return None


def session_entry(path):
    """Eintrag des Takes in sitzung.json neben der Aufnahme (der letzte mit diesem Dateinamen) oder None."""
    log = session_log(Path(path).parent)
    if not log:
        return None
    name = Path(path).name.replace(".k2rec.part", ".k2rec")
    found = [t for t in log.get("takes", []) if t.get("file") == name]
    return found[-1] if found else None


def calibration_takes(path, setup, kind, placement=None):
    """Kalibrier-Aufnahmen cal.<setup>.<kind> zur Aufnahme `path`: aus sitzung.json (behalten, gleiche Platzierung),
    sonst alle passenden Dateien im selben Ordner; neueste zuerst."""
    folder = Path(path).parent
    sid = f"cal.{setup}.{kind}"
    log = session_log(folder)
    out = []
    if log:
        for t in reversed(log.get("takes", [])):
            if t.get("shot") != sid or t.get("keep") is False:
                continue
            if placement is not None and t.get("placement") not in (None, placement):
                continue
            p = folder / t.get("file", "")
            if p.exists():
                out.append(p)
    if not out:
        files = sorted(folder.glob(f"{sid}_t*.k2rec"), key=lambda p: parse_name(p)[1] or 0, reverse=True)
        out = files
    return out


def list_takes(folder, keep_only=True):
    """Alle Aufnahmen eines Ordners in Aufnahmereihenfolge; mit sitzung.json nur die behaltenen."""
    folder = Path(folder)
    log = session_log(folder)
    files = sorted(folder.glob("*.k2rec"))
    if not log:
        return files
    entries = {}
    for t in log.get("takes", []):
        entries[t.get("file")] = t
    out = []
    for f in files:
        e = entries.get(f.name)
        if keep_only and e is not None and e.get("keep") is False:
            continue
        out.append(f)
    return out
