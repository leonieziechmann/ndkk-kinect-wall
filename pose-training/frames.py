# Picks the training and validation frames from the recordings and writes their infrared images the way
# web/lib/persons-pose.js feeds them to the pose model: unmirrored, gray, 512x424 (the letterbox to 512x448
# happens in training and in the browser alike). One PNG per frame:
#   <out>/images/<split>/<recording>_<frame>.png
# Usage: python frames.py [--out recordings/training] [--stride 12] [--val-stride 15]
#
# Splits (whole recordings or time ranges, so neighboring frames never end up on both sides):
#   train  the multi-user recordings of 2026-10-08 (camera not moved or covered), hops2/nohops, wand-*
#   val    multi-155317, multi-150835 and multi-150334 from 2:20 on (two people, sitting, occlusion, chair),
#          hops-2026-10-08 (jumping, a take of its own)
# The jumping and moving recordings (hops*, nohops: fast moves on announced cues, <name>.cues.csv) are taken
# densely around each cue (every 3rd frame within 1.6 s), elsewhere every 9th frame.
#   never  final-*, alt-* (the person tracker's backtest: stays a fair test of the new model)
import argparse, json, os, sys
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))


def main_checkout():
    """The main checkout (recordings/ is not in git: worktrees do not have it)."""
    if os.environ.get('KINECT_MAIN'):
        return os.environ['KINECT_MAIN']
    import subprocess
    out = subprocess.run(['git', 'worktree', 'list', '--porcelain'], cwd=HERE, capture_output=True, text=True).stdout
    return out.splitlines()[0].removeprefix('worktree ').strip()


def be_nice():
    """Lowest CPU priority (and its child processes): whoever works on this computer comes first."""
    if os.name == 'nt':
        import ctypes
        k = ctypes.windll.kernel32
        k.GetCurrentProcess.restype = ctypes.c_void_p
        k.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        k.SetPriorityClass(k.GetCurrentProcess(), 0x40)  # IDLE_PRIORITY_CLASS
    else:
        os.nice(19)


# CPU threads for the models: a quarter of the cores, the rest stays free for work and the live setup
THREADS = max(1, (os.cpu_count() or 4) // 4)

MAIN = main_checkout()
REC = os.path.join(MAIN, 'recordings')
sys.path.insert(0, os.path.join(REC, 'katalog', 'werkzeuge'))
import k2  # noqa: E402  (the catalog's reader for .k2rec)

MULTI = ['145333', '145834', '150334', '150835', '153816', '154316', '154817', '155317', '155817']
VAL = {'155317': None, '150835': None, '150334': (140.0, None)}  # recording: (from s, to s) or the whole
OTHER = ['wand-solo', 'wand-kleid', 'wand-kleid2']
MOVES = {'hops2-2026-10-08': 'train', 'nohops-2026-10-08': 'train', 'hops-2026-10-08': 'val'}


def cue_times(name):
    """Seconds from the start of the recording of each announced move (t_s; some files write it 7,413)."""
    ts = []
    for line in open(os.path.join(REC, name + '.cues.csv'), encoding='utf-8-sig').read().splitlines()[1:]:
        f = line.split(',')
        if len(f) >= 4:
            ts.append(float('.'.join(f[2:-1])))
    return ts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(REC, 'training'))
    ap.add_argument('--stride', type=int, default=12, help='every n-th frame for training')
    ap.add_argument('--val-stride', type=int, default=15)
    a = ap.parse_args()
    listing = []
    for tag in MULTI:
        name = f'multi-2026-10-08-{tag}'
        labels = json.load(open(os.path.join(REC, 'katalog', 'daten', name + '.labels.json')))
        ok = {s['i'] for s in labels['samples'] if s['cam'] == 'ok'}  # camera not moved or covered
        step = labels['step']
        r = k2.Rec(os.path.join(REC, name + '.k2rec'))
        for i in range(0, len(r), step):
            if i not in ok:
                continue
            t = r.time(i)
            v = VAL.get(tag, 'train')
            split = 'train' if v == 'train' else 'val' if v is None or (t >= v[0] and (v[1] is None or t < v[1])) else 'train'
            stride = a.stride if split == 'train' else a.val_stride
            if i % stride:
                continue
            listing.append((split, name, r, i))
    for name in OTHER:
        r = k2.Rec(os.path.join(REC, name + '.k2rec'))
        for i in range(0, len(r), a.stride):
            listing.append(('train', name, r, i))
    for name, split in MOVES.items():
        r = k2.Rec(os.path.join(REC, name + '.k2rec'))
        cues = cue_times(name)
        for i in range(len(r)):
            near = any(abs(r.time(i) - c) <= 1.6 for c in cues)
            if i % (3 if near else 9) == 0:
                listing.append((split, name, r, i))
    n = {'train': 0, 'val': 0}
    for split, name, r, i in listing:
        d = os.path.join(a.out, 'images', split)
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, f'{name}_{i:05d}.png')
        n[split] += 1
        if os.path.exists(p):
            continue
        _, ir = r.frame(i)
        Image.fromarray(np.ascontiguousarray(ir[:, ::-1])).save(p)
    print(n)


if __name__ == '__main__':
    main()
