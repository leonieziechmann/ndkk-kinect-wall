# The Sapiens2 teacher on a Colab VM (topdown.py; next to trainings it is slow): the boxes of yolo11x at 1024
# (kinect-pose-r3raw.zip). Delivers /content/out/<name>.zip with the raw detections it made (raw/sapiens-*.json,
# test/raw/sapiens-val.json), for the ensemble of four teachers. Set in the VM's Python before (colab exec):
#   POSE_SAPIENS=r4-sapiens   the delivery's name
#   POSE_SPLITS='test val train'   what to label (test: the unseen test)
#   POSE_SHARD=1,2,3,4,5,6/7   only these images of the training split (the rest on another VM; an L4 takes
#                              ~0.9 s per person, an A100 several times less)
#   POSE_BATCH=16
import os
import subprocess
import textwrap

C = '/content'
K = f'{C}/kinect'
T = f'{K}/recordings/training'
N = os.environ.get('POSE_SAPIENS', 'r4-sapiens')
B = os.environ.get('POSE_BATCH', '16')
SPLITS = os.environ.get('POSE_SPLITS', 'test val train').split()
SHARD = os.environ.get('POSE_SHARD', '')
OUT = {'test': f'--out {T}/test --split val', 'val': f'--out {T} --split val', 'train': f'--out {T} --split train' + (f' --shard {SHARD}' if SHARD else '')}
RUNS = '\n'.join(f'python -u $P/topdown.py --model sapiens {OUT[s]} --batch {B}' for s in SPLITS)

job = textwrap.dedent(f"""\
    set -x
    for z in {C}/kinect-pose-*.zip; do [ -e $z.unpacked ] || {{ unzip -q -o $z -d {C} && touch $z.unpacked; }}; done
    mkdir -p {C}/out
    export KINECT_MAIN={K} POSE_THREADS=4 PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
    P={C}/pose-training
    pip install -q -U "transformers>=5.10" accelerate ultralytics
""") + RUNS + textwrap.dedent(f"""
    (cd {T} && zip -q -r {C}/out/{N}.zip.part raw/sapiens-*.json test/raw/sapiens-*.json; mv {C}/out/{N}.zip.part {C}/out/{N}.zip)
    touch {C}/DONE-{N}
""")
# the settings stay in the VM's Python between colab exec calls: clear them, the next start sets its own
for k in [k for k in os.environ if k.startswith('POSE_')]:
    del os.environ[k]
if os.path.exists(f'{C}/job-{N}.started'):  # a retried start (colab exec can time out after starting it)
    print('started already')
else:
    open(f'{C}/job-{N}.started', 'w').close()
    open(f'{C}/job-{N}.sh', 'w').write(job)
    subprocess.Popen(f'nohup bash {C}/job-{N}.sh > {C}/job-{N}.log 2>&1 &', shell=True)
    print(f'started: /content/job-{N}.log; /content/out/{N}.zip, /content/DONE-{N}')
