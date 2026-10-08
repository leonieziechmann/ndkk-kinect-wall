# The Sapiens2 teacher on a Colab VM of its own (topdown.py; on the VM of round 3 it shared the GPU with the
# trainings): the boxes of yolo11x at 1024 (kinect-pose-r3raw.zip), the images of the unseen test, the held-out
# frames and the training frames. Delivers /content/out/r4-sapiens.zip with raw/sapiens-{val,train}.json and
# test/raw/sapiens-val.json, for the ensemble of four teachers (colab_teachers.py has ViTPose).
import os
import subprocess
import textwrap

C = '/content'
K = f'{C}/kinect'
T = f'{K}/recordings/training'
B = os.environ.get('POSE_BATCH', '16')

job = textwrap.dedent(f"""\
    set -x
    for z in {C}/kinect-pose-*.zip; do [ -e $z.unpacked ] || {{ unzip -q -o $z -d {C} && touch $z.unpacked; }}; done
    mkdir -p {C}/out
    export KINECT_MAIN={K} POSE_THREADS=$(nproc) PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
    P={C}/pose-training
    pip install -q -U "transformers>=5.10" accelerate ultralytics
    python -u $P/topdown.py --model sapiens --out {T}/test --split val --batch {B}
    python -u $P/topdown.py --model sapiens --out {T} --split val --batch {B}
    python -u $P/topdown.py --model sapiens --out {T} --split train --batch {B}
    (cd {T} && zip -q -r {C}/out/r4-sapiens.zip.part raw/sapiens-val.json raw/sapiens-train.json test/raw/sapiens-val.json && mv {C}/out/r4-sapiens.zip.part {C}/out/r4-sapiens.zip)
    touch {C}/DONE-SAPIENS
""")
if os.path.exists(f'{C}/job-sapiens.started'):  # a retried start (colab exec can time out after starting it)
    print('started already')
else:
    open(f'{C}/job-sapiens.started', 'w').close()
    open(f'{C}/job-sapiens.sh', 'w').write(job)
    subprocess.Popen(f'nohup bash {C}/job-sapiens.sh > {C}/job-sapiens.log 2>&1 &', shell=True)
    print('started: /content/job-sapiens.log; /content/out/r4-sapiens.zip, /content/DONE-SAPIENS')
