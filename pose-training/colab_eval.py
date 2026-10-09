# Evaluates models on a Colab VM against its labels (held-out frames and the unseen test) and delivers
# /content/out/<name>.zip with the tables: the yardstick for a new label set (e.g. the COCO weights and the best
# run so far against the labels of four teachers). Set in the VM's Python before this file runs (colab exec):
#   POSE_EVAL=r5-lehrer  POSE_MODELS='yolo11s-pose.pt@384 yolo11s-pose.pt@512 /content/.../best.pt'
#   POSE_LABELS=-r5  waits for that label set (colab_run.py makes it)
import os
import subprocess
import textwrap

C = '/content'
K = f'{C}/kinect'
T = f'{K}/recordings/training'
N = os.environ['POSE_EVAL']
MODELS = os.environ['POSE_MODELS']
READY = f"{T}/labels-ready{os.environ.get('POSE_LABELS', '')}"
CASES = 'alle=,final=final-,alt=alt-,room=room-'

job = textwrap.dedent(f"""\
    set -x
    until [ -e {READY} ]; do sleep 20; done
    export KINECT_MAIN={K} POSE_THREADS=4
    P={C}/pose-training
    cd {T}/weights
    python -u $P/eval.py {MODELS} 2>&1 | tee {T}/eval-{N}-val.txt
    python -u $P/eval.py --out {T}/test --cases {CASES} {MODELS} 2>&1 | tee {T}/eval-{N}-test.txt
    (cd {T} && zip -q {C}/out/{N}.zip.part eval-{N}-val.txt eval-{N}-test.txt ensemble*.txt 2>/dev/null; mv {C}/out/{N}.zip.part {C}/out/{N}.zip)
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
