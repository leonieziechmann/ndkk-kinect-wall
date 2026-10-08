# Packs the training for a Kaggle notebook (free GPU): a zip with the frames (frames.py), the model weights
# and the browser's current model, and a notebook that labels, trains, evaluates and exports there and
# leaves ergebnis.zip to download. Both go to <out>/kaggle/:
#   kinect-pose-daten.zip       upload as a PRIVATE Kaggle dataset (it shows people)
#   kinect-pose-training.ipynb  import as a notebook; settings: GPU T4 x2, Internet on; add the dataset; run all
# Usage: python kaggle.py [--epochs 40]
import argparse, glob, json, os, sys, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from frames import MAIN, REC  # noqa: E402

SCRIPTS = ['frames.py', 'teacher.py', 'train.py', 'eval.py', 'export.py', 'compare.py']


def pack(out):
    dst = os.path.join(out, 'kaggle', 'kinect-pose-daten.zip')
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    files = []
    for split in ('train', 'val'):
        files += [(p, f'kinect/recordings/training/images/{split}/{os.path.basename(p)}') for p in sorted(glob.glob(os.path.join(out, 'images', split, '*.png')))]
    for w in ('yolo11x-pose.pt', 'yolo11n-pose.pt'):
        files.append((os.path.join(out, 'weights', w), f'kinect/recordings/training/weights/{w}'))
    files.append((os.path.join(MAIN, 'web', 'lib', 'models', 'yolo11n-pose-fp16.onnx'), 'kinect/web/lib/models/yolo11n-pose-fp16.onnx'))
    with zipfile.ZipFile(dst, 'w', zipfile.ZIP_STORED) as z:  # PNG and weights do not compress further
        for src, arc in files:
            z.write(src, arc)
    print(f'{dst}: {len(files)} files, {os.path.getsize(dst) / 1e6:.0f} MB')


def cell(kind, src):
    c = {'cell_type': kind, 'metadata': {}, 'source': src}
    if kind == 'code':
        c.update(execution_count=None, outputs=[])
    return c


def notebook(out, epochs):
    scripts = {n: open(os.path.join(HERE, n), encoding='utf8').read() for n in SCRIPTS}
    cells = [
        cell('markdown', '# Kinect-Pose-Modell nachtrainieren\n\n'
             'Beschriftet die Kinect-IR-Bilder mit YOLO11x-pose (Lehrer), trainiert YOLO11n-pose (das Modell im Browser) nach, '
             'misst alt gegen neu und exportiert ONNX wie in `web/lib/models/README.md`.\n\n'
             '**Einstellungen:** Accelerator *GPU T4 x2*, Internet *an*, Datensatz `kinect-pose-daten` (privat) hinzufügen. '
             'Dann *Run All* (oder *Save Version → Save & Run All*, dann läuft es im Hintergrund weiter).\n\n'
             'Am Ende `ergebnis.zip` aus dem Output herunterladen. Die kopierten Bilder werden zum Schluss gelöscht.'),
        cell('code', '!pip install -q ultralytics onnx onnxruntime onnxconverter-common onnxslim'),
        cell('code', 'import glob, os, shutil\n'
             "src = glob.glob('/kaggle/input/**/kinect/recordings/training/images', recursive=True)\n"
             "assert src, 'Datensatz kinect-pose-daten fehlt: rechts unter Input hinzufügen'\n"
             "root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(src[0]))))  # .../kinect\n"
             "K = '/kaggle/working/kinect'\n"
             "if not os.path.exists(K):\n"
             "    shutil.copytree(root, K)  # labels/ must lie next to images/, the input is read-only\n"
             "os.makedirs(f'{K}/pose-training', exist_ok=True)\n"
             "os.environ.update(KINECT_MAIN=K, POSE_THREADS=str(os.cpu_count()))\n"
             "import torch; print('GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'keine!')\n"
             "print(len(os.listdir(f'{K}/recordings/training/images/train')), 'train,', len(os.listdir(f'{K}/recordings/training/images/val')), 'val')"),
        cell('code', '# die Skripte aus pose-training/ (Stand beim Packen)\n'
             f'SCRIPTS = {json.dumps(scripts, ensure_ascii=False)}\n'
             "for n, s in SCRIPTS.items():\n"
             "    open(f'{K}/pose-training/{n}', 'w', encoding='utf8').write(s)\n"
             "print(sorted(SCRIPTS))"),
        cell('markdown', '## 1. Lehrer beschriftet (mit Spiegel-Mittelung)'),
        cell('code', "%cd /kaggle/working/kinect/recordings/training/weights\n"
             '!python -u ../../../pose-training/teacher.py --split val --flip --batch 32\n'
             '!python -u ../../../pose-training/teacher.py --split train --flip --batch 32'),
        cell('markdown', '## 2. Training\n\nNach jeder Epoche liegt `runs/n-ir/weights/resume.pt` vor; bricht die Sitzung ab, geht es mit `train.py --resume` weiter.'),
        cell('code', f'!python -u ../../../pose-training/train.py --epochs {epochs} --batch 64 --workers 4'),
        cell('markdown', '## 3. Alt gegen neu (Validierung: zurückgehaltene Aufnahmen, Lehrer-Labels)'),
        cell('code', '!python -u ../../../pose-training/eval.py 2>&1 | tee ../eval.txt'),
        cell('markdown', '## 4. Export (ONNX und float16 für den Browser)'),
        cell('code', '!python -u ../../../pose-training/export.py 2>&1 | tee ../export.txt'),
        cell('markdown', '## 5. Ergebnis packen'),
        cell('code', "import zipfile\n"
             "T = '/kaggle/working/kinect/recordings/training'\n"
             "with zipfile.ZipFile('/kaggle/working/ergebnis.zip', 'w', zipfile.ZIP_DEFLATED) as z:\n"
             "    for d in ('raw', 'runs', 'export'):\n"
             "        for p in glob.glob(f'{T}/{d}/**/*', recursive=True):\n"
             "            if os.path.isfile(p):\n"
             "                z.write(p, os.path.relpath(p, T))\n"
             "    for f in ('eval.txt', 'export.txt'):\n"
             "        if os.path.exists(f'{T}/{f}'):\n"
             "            z.write(f'{T}/{f}', f)\n"
             "shutil.rmtree('/kaggle/working/kinect')  # the copied frames (people) do not stay in the output\n"
             "print(os.path.getsize('/kaggle/working/ergebnis.zip') / 1e6, 'MB')"),
    ]
    nb = {'cells': cells, 'metadata': {'kernelspec': {'display_name': 'Python 3', 'language': 'python', 'name': 'python3'}, 'language_info': {'name': 'python'}}, 'nbformat': 4, 'nbformat_minor': 5}
    dst = os.path.join(out, 'kaggle', 'kinect-pose-training.ipynb')
    json.dump(nb, open(dst, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
    print(dst)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(REC, 'training'))
    ap.add_argument('--epochs', type=int, default=40)
    ap.add_argument('--no-zip', action='store_true', help='only the notebook (after a change to the scripts)')
    a = ap.parse_args()
    if not a.no_zip:
        pack(a.out)
    notebook(a.out, a.epochs)


if __name__ == '__main__':
    main()
