# One training on a Colab VM (more VMs, results sooner): labels from the teachers' raw detections
# (ensemble.py), train, export, evaluate, deliver /content/out/<name>.zip (best/last.pt, ONNX fp32 and fp16,
# evaluation on the held-out frames and the unseen test). Data: the zips of colab_round3.py plus
# kinect-pose-r3raw.zip (the teacher at 1024 from round 3), all as /content/kinect-pose-*.zip.
# The run is set by environment variables in the VM's Python before this file runs (colab exec), e.g.
#   POSE_RUN=r3c-s512  POSE_ARGS='--model yolo11s-pose.pt --imgsz 512 --batch 64 --extra coco/images/train --ir-aug'
#   POSE_TEACH='yolo11x-pose@1024+768-flip yolo11x-pose-flip'  POSE_NEED=1.0  POSE_EPOCHS=80
#   POSE_SECOND=1  a second run on the same VM: waits for the first one's labels instead of making them
#   POSE_RESUME=1  goes on from runs/<name>/weights/resume.pt (uploaded from the laptop's backup after a lost VM)
# Colab ends a VM whose kernel stays idle, and the job runs outside the kernel: keep the VM busy from the
# laptop (a tiny colab exec every few minutes) and back up resume.pt from there.
import os
import subprocess
import textwrap

C = '/content'
K = f'{C}/kinect'
T = f'{K}/recordings/training'
TT = f'{T}/test'
N = os.environ['POSE_RUN']
ARGS = os.environ.get('POSE_ARGS', '')
TEACH = os.environ.get('POSE_TEACH', 'yolo11x-pose@1024+768-flip yolo11x-pose-flip')
NEED = os.environ.get('POSE_NEED', '1.0')
EPOCHS = os.environ.get('POSE_EPOCHS', '80')
SECOND = os.environ.get('POSE_SECOND') == '1'
RESUME = os.environ.get('POSE_RESUME') == '1'
AUG = '--ir-aug' if '--ir-aug' in ARGS else ''
CASES = 'alle=,final=final-,alt=alt-,room=room-'

PREP = f"""for z in {C}/kinect-pose-*.zip; do [ -e $z.unpacked ] || {{ unzip -q -o $z -d {C} && touch $z.unpacked; }}; done
    pip install -q ultralytics onnx onnxruntime onnxconverter-common onnxslim albumentations
    python -u $P/ensemble.py --split val --raw {TEACH} --need {NEED}
    python -u $P/ensemble.py --split train --raw {TEACH} --need {NEED}
    python -u $P/ensemble.py --out {TT} --split val --raw {TEACH} --need {NEED}
    [ -e {T}/coco/images/train ] || python -u $P/coco.py --out {T}
    touch {T}/labels-ready"""
WAIT = f'until [ -e {T}/labels-ready ]; do sleep 20; done'
FIT = (f'python -u $P/train.py --resume --name {N} {AUG}' if RESUME else
       f'python -u $P/train.py --name {N} --epochs {EPOCHS} --workers $(( $(nproc) / 2 - 1 )) {ARGS} || python -u $P/train.py --resume --name {N} {AUG}')

job = textwrap.dedent(f"""\
    set -x
    mkdir -p {C}/out
    export KINECT_MAIN={K} POSE_THREADS=$(( $(nproc) / 2 ))
    P={C}/pose-training
    deliver() {{ s=$1; shift; (cd {T} && rm -f {C}/out/$s.zip.part && zip -q -r {C}/out/$s.zip.part "$@" && mv {C}/out/$s.zip.part {C}/out/$s.zip); }}
    {WAIT if SECOND else PREP}
    cd {T}/weights
    [ -e {C}/out/{N}.zip ] || {{
      {FIT}
      python -u $P/export.py --name {N} 2>&1 | tee {T}/export-{N}.txt
      M="{T}/runs/{N}/weights/best.pt {T}/runs/{N}/weights/last.pt"
      python -u $P/eval.py $M 2>&1 | tee {T}/eval-{N}-val.txt
      python -u $P/eval.py --out {TT} --cases {CASES} $M 2>&1 | tee {T}/eval-{N}-test.txt
      deliver {N} runs/{N}/weights/best.pt runs/{N}/weights/last.pt runs/{N}/results.csv runs/{N}/args.yaml export/{N}.onnx export/{N}-fp16.onnx export-{N}.txt eval-{N}-val.txt eval-{N}-test.txt; }}
    touch {C}/DONE-{N}
""")
if os.path.exists(f'{C}/job-{N}.started'):  # a retried start (colab exec can time out after starting it)
    print('started already')
else:
    open(f'{C}/job-{N}.started', 'w').close()
    open(f'{C}/job-{N}.sh', 'w').write(job)
    subprocess.Popen(f'nohup bash {C}/job-{N}.sh > {C}/job-{N}.log 2>&1 &', shell=True)
    print(f'started: /content/job-{N}.log; /content/out/{N}.zip, /content/DONE-{N}')
