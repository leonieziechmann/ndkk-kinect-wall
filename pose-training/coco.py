# Gray COCO persons for training next to the Kinect frames (train.py --extra coco/images/train): the model
# keeps what it knew about people in general and does not learn only the recorded sessions (on unseen
# recordings the model trained without them was worse, mostly in another room). COCO val2017: the images with
# persons and keypoint labels (human-made), converted to gray like the infrared image.
# Downloads about 0.8 GB (meant for a cloud VM): images from cocodataset.org, labels from Ultralytics.
# Usage: python coco.py [--out recordings/training] [--limit 0]
import argparse, glob, os, shutil, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from frames import REC  # noqa: E402

IMAGES = 'http://images.cocodataset.org/zips/val2017.zip'
LABELS = 'https://github.com/ultralytics/assets/releases/download/v0.0.0/coco2017labels-pose.zip'


def fetch(url, dst):
    if not os.path.exists(dst):
        subprocess.run(['wget', '-q', '-O', dst + '.part', url], check=True)
        os.rename(dst + '.part', dst)
    d = os.path.splitext(dst)[0]
    if not os.path.exists(d):
        subprocess.run(['unzip', '-q', '-o', dst, '-d', d], check=True)
    return d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(REC, 'training'))
    ap.add_argument('--cache', default='/content/coco-src')
    ap.add_argument('--limit', type=int, default=0)
    a = ap.parse_args()
    from PIL import Image
    os.makedirs(a.cache, exist_ok=True)
    imgs = fetch(IMAGES, os.path.join(a.cache, 'val2017.zip'))
    labs = fetch(LABELS, os.path.join(a.cache, 'labels.zip'))
    src = glob.glob(os.path.join(labs, '**', 'labels', 'val2017'), recursive=True)[0]
    idir = os.path.dirname(glob.glob(os.path.join(imgs, '**', '*.jpg'), recursive=True)[0])
    names = sorted(n for n in os.listdir(src) if os.path.getsize(os.path.join(src, n)) > 0)
    if a.limit:
        names = names[: a.limit]
    di, dl = os.path.join(a.out, 'coco', 'images', 'train'), os.path.join(a.out, 'coco', 'labels', 'train')
    os.makedirs(di, exist_ok=True)
    os.makedirs(dl, exist_ok=True)

    def one(n):
        stem = os.path.splitext(n)[0]
        p = os.path.join(idir, stem + '.jpg')
        if not os.path.exists(p):
            return 0
        Image.open(p).convert('L').save(os.path.join(di, stem + '.jpg'), quality=95)
        shutil.copyfile(os.path.join(src, n), os.path.join(dl, n))
        return 1

    with ThreadPoolExecutor(os.cpu_count()) as ex:
        n = sum(ex.map(one, names))
    print(f'{n} gray COCO images with persons -> {di}')


if __name__ == '__main__':
    main()
