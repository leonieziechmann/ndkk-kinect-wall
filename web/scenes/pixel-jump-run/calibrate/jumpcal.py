"""Scores the jump detection of pixel-jump-run against recordings with known moves (see README.md).

    python scenes/pixel-jump-run/calibrate/jumpcal.py \
        --hops   .cache/shots/hops-log.json   ../recordings/hops-2026-10-08.cues.csv   1951 \
        --nohops .cache/shots/nohops-log.json ../recordings/nohops-2026-10-08.cues.csv 2160 [--sim]

LOG: the signal log of probe.mjs --log while a replay hub played the recording (two loops or more).
CUES: the cue file of record-session.ps1. FRAMES: the recording's frame count (record-session prints
it, the replay hub's /api/status shows it).

It prints, for the jumps the scene itself fired: how many hops were caught (per kind), how long after
the takeoff (the fastest rise of the mask near the cue), and how many false jumps the other
recording gave, per move. With --sim it also replays the logged signals through the detector of
this file (detect(), the same rule as people.js) with a few variants, to tune the params offline.
"""
import csv
import json
import sys
from collections import Counter, defaultdict

import numpy as np

# columns of a log row (people.js, signals())
COLS = dict(t=0, id=1, pel=2, pelv=3, feet=4, top=5, height=6, mean=10, med=11, raw=12, walk=15, seq=16)


def load(path):
    rows = json.load(open(path))
    a = np.array([[r[i] if i < len(r) else 0 for i in range(17)] for r in rows], float)
    return a[np.argsort(a[:, 0], kind='stable')]


def cues(path):
    """(cue, text, t_s); t_s may have been written with a decimal comma (then split in two fields)"""
    out = []
    with open(path, encoding='utf-8-sig') as f:
        r = csv.reader(f)
        next(r)
        for row in r:
            t = float(row[2] + '.' + row[3]) if len(row) == 5 else float(row[2])
            out.append((int(row[0]), row[1], t))
    return out


class Sig:
    """one height signal as in people.js (class Signal): velocity, standing level from still moments"""

    def __init__(self, win=8.0, pct=80):
        self.win, self.pct = win, pct
        self.hist, self.stand, self.v, self.y, self.t = [], None, 0.0, None, 0.0

    def add(self, t, y):
        if not y:
            return None
        dt = t - self.t
        vi = (y - self.y) / dt if self.y is not None and 1e-3 < dt < 0.3 else None
        self.v = 0.4 * self.v + 0.6 * vi if vi is not None else 0.0
        self.y, self.t = y, t
        if abs(self.v) < 0.25:
            self.hist.append((t, y))
        while self.hist and t - self.hist[0][0] > self.win:
            self.hist.pop(0)
        if len(self.hist) >= 8:
            self.stand = float(np.percentile([h[1] for h in self.hist], self.pct))
        elif self.stand is None:
            self.stand = y
        return dict(rise=y - self.stand, v=self.v, y=y)


# the params of people.js (main.js defaults)
DEFAULT = dict(jumpVy=0.45, jumpVy2=0.2, jumpRise=0.05, jumpDip=0.1, feetUp=0.02, minRise=0.06, pelvisMin=0.03, walkGate=0.55, jumpRest=0.15)


def detect(a, **P):
    """the rule of people.js over logged rows (per person id); returns the row indices of the jumps"""
    P = {**DEFAULT, **P}
    fires, state = [], {}
    for i, r in enumerate(a):
        t = r[COLS['t']]
        st = state.get(r[COLS['id']])
        if st is None:
            st = state[r[COLS['id']]] = dict(body=Sig(), mean=Sig(), feet=Sig(4, 50), pel=Sig(), armed=True, armedAt=-9, cand=-9, born=t, walks=[], n=0)
        body = st['body'].add(t, r[COLS['med']])
        mean = st['mean'].add(t, r[COLS['mean']])
        feet = st['feet'].add(t, r[COLS['feet']])
        pel = st['pel'].add(t, r[COLS['raw']])
        st['walks'] = [w for w in st['walks'] if t - w[0] <= 0.3] + [(t, r[COLS['walk']])]
        walking = max(w[1] for w in st['walks'])
        if not body:
            continue
        st['n'] += 1
        flies = body['rise'] > -P['jumpDip'] and body['rise'] + body['v'] ** 2 / 19.62 > P['jumpRise']
        if body['v'] > P['jumpVy'] and (not mean or mean['v'] > P['jumpVy2']) and flies and walking < P['walkGate']:
            st['cand'] = t
        feet_up = not feet or feet['rise'] > P['feetUp']
        pelvis_ok = not pel or pel['rise'] > P['pelvisMin']
        can = st['armed'] and t - st['born'] > 1 and st['n'] >= 20
        if can and t - st['cand'] < 0.35 and feet_up and body['rise'] > P['minRise'] and pelvis_ok:
            st.update(armed=False, armedAt=t, cand=-9)
            fires.append(i)
        elif not st['armed'] and t - st['armedAt'] > P['jumpRest'] and (body['v'] < 0.05 or body['rise'] < P['jumpRise'] * 0.35):
            st['armed'] = True
    return fires


def loops(a, frames):
    """the whole replay loops in the log: (loop, row indices, recording time), by recording time"""
    lp = (a[:, COLS['seq']] // frames).astype(int)
    out = []
    for L in sorted(set(lp)):
        idx = np.where(lp == L)[0]
        rec = (a[idx, COLS['seq']] % frames) / 30.0
        if len(idx) > 0.5 * frames:  # loops with enough data (the first starts when the pose model is ready)
            o = np.argsort(rec, kind='stable')
            out.append((L, idx[o], rec[o]))
    return out


def score_hops(a, frames, cs, fires):
    """per cue of every loop: caught (a jump within the cue ± 1.6 s: people often hop on the spoken
    word, before the beep)? The delay of the first one after the takeoff."""
    fires = set(fires)
    rows, extra = [], 0
    for L, idx, rec in loops(a, frames):
        sub = a[idx]
        mine = [j for j, g in enumerate(idx) if g in fires]
        frec = rec[mine]
        used = set()
        for k, text, tc in cs:
            lo, hi = (tc - 0.8, tc + 1.0) if text.startswith('jetzt') else (tc - 1.6, tc + 1.5)
            w = np.where((rec >= lo) & (rec <= hi))[0]
            if len(w) < 4:
                continue
            # the takeoff: the fastest rise of the mask's median height (the skeleton glitches)
            y, tt = sub[w, COLS['med']], rec[w]
            takeoff = tt[int(np.argmax(np.diff(y) / np.maximum(1e-3, np.diff(tt))))]
            hit = [j for j in range(len(frec)) if lo <= frec[j] <= hi]
            used.update(hit)
            rows.append((L, text, frec[hit[0]] - takeoff if hit else None))
        extra += len(frec) - len(used)
    return rows, extra


def score_nohops(a, frames, cs, fires):
    """false jumps per loop of the person (the id with the most rows), per move"""
    main_id = Counter(a[:, COLS['id']]).most_common(1)[0][0]
    fires = set(fires)
    moves, n, ghosts = Counter(), 0, 0
    for L, idx, rec in loops(a, frames):
        n += 1
        for j, g in enumerate(idx):
            if g not in fires:
                continue
            if a[g, COLS['id']] != main_id:
                ghosts += 1
                continue
            m = 'zwischen'
            for k, text, tc in cs:
                if tc - 1.6 <= rec[j] <= tc + 3.0:
                    m = text
            moves[m] += 1
    return moves, n, ghosts


def report(name, hops, nohops, fires_h, fires_n):
    line = f'{name:28s}'
    if hops:
        rows, extra = score_hops(*hops, fires_h)
        by = defaultdict(list)
        for r in rows:
            by[r[1].split()[0]].append(r[2] is not None)
        d = [r[2] for r in rows if r[2] is not None]
        caught = sum(1 for r in rows if r[2] is not None)
        kinds = ' '.join(f'{k} {sum(v)}/{len(v)}' for k, v in by.items())
        delay = f'{np.median(d):+.2f} s (90 %: {np.percentile(d, 90):+.2f} s)' if d else '-'
        line += f' Hüpfer {caught}/{len(rows)} [{kinds}], nach dem Absprung {delay}, weitere {extra}'
    if nohops:
        moves, n, ghosts = score_nohops(*nohops, fires_n)
        total = sum(moves.values())
        line += f' | Fehlsprünge {total / max(1, n):.1f} pro Durchlauf ({n} Durchläufe; Schein-Personen {ghosts}): {dict(moves)}'
    print(line)


if __name__ == '__main__':
    args = sys.argv[1:]

    def arg(name):
        if name not in args:
            return None
        i = args.index(name)
        return load(args[i + 1]), int(args[i + 3]), cues(args[i + 2])

    hops, nohops = arg('--hops'), arg('--nohops')
    scene = lambda x: [i for i in range(len(x[0])) if x[0][i, 9] > 0] if x else []
    report('Szene (was sie auslöste)', hops, nohops, scene(hops), scene(nohops))
    if '--sim' in args:
        for name, P in [
            ('Simulation: people.js', {}),
            ('  ohne Becken-Veto', dict(pelvisMin=-9)),
            ('  Füße 2,5 cm', dict(feetUp=0.025)),
            ('  Körper 8 cm', dict(minRise=0.08)),
            ('  Absprung 0,6 m/s', dict(jumpVy=0.6)),
        ]:
            report(name, hops, nohops, detect(hops[0], **P) if hops else [], detect(nohops[0], **P) if nohops else [])
