# The top-down teachers on the Colab VM, next to round 3 (colab_round3.py; started the same way, once its
# teacher step is running): ViTPose++ huge and Sapiens2 1b place the joints in crops around the persons that
# yolo11x at 1024 found. Their labels go to a folder of their own (recordings/training4, the same images), so
# the trainings of round 3 keep theirs:
#   ensemble of four teachers (yolo11x at 1024 and at 512, ViTPose, Sapiens2), a keypoint labeled where 3 of 4
#   agree; then every model so far against these labels, delivered as /content/out/r4-lehrer.zip.
import os
import subprocess
import textwrap

C = '/content'
K = f'{C}/kinect'
T = f'{K}/recordings/training'
T4 = f'{K}/recordings/training4'
MODELS = ' '.join([
    'yolo11n-pose.pt@512', 'yolo11n-pose.pt@384', 'yolo11s-pose.pt@512', 'yolo11s-pose.pt@384', 'yolo11m-pose.pt@512',
    f'{T}/runs-old/n-ir-2/weights/best.pt@512',
])
CASES = 'alle=,final=final-,alt=alt-,room=room-'
TEACH = 'yolo11x-pose@1024+768-flip yolo11x-pose-flip vitpose sapiens'

job = textwrap.dedent(f"""\
    set -x
    until [ -e {T}/done-r3-teacher ]; do sleep 60; done
    export KINECT_MAIN={K} POSE_THREADS=4
    P={C}/pose-training  # the uploaded scripts as they are (round 3 runs its own copy)
    pip install -q -U "transformers>=5.10" accelerate
    deliver() {{ s=$1; shift; (cd {T4} && rm -f {C}/out/$s.zip.part && zip -q -r {C}/out/$s.zip.part "$@" && mv {C}/out/$s.zip.part {C}/out/$s.zip); }}
    # the same images, labels of their own
    for d in {T4} {T4}/test; do mkdir -p $d/raw $d/images; done
    for s in train val; do ln -sfn {T}/images/$s {T4}/images/$s; done
    ln -sfn {T}/test/images/val {T4}/test/images/val
    cp {T}/raw/*.json {T4}/raw/ && cp {T}/test/raw/*.json {T4}/test/raw/
    cd {T}/weights
    for m in vitpose sapiens; do
      python -u $P/topdown.py --model $m --out {T4}/test --split val --limit 40 2>&1 | tail -2
      python -u $P/topdown.py --model $m --out {T4}/test --split val
      python -u $P/topdown.py --model $m --out {T4} --split val
      python -u $P/topdown.py --model $m --out {T4} --split train
    done
    for o in "{T4} --split val" "{T4} --split train" "{T4}/test --split val"; do
      python -u $P/ensemble.py --out $o --raw {TEACH} --need 0.75 2>&1 | tee -a {T4}/ensemble-r4.txt
    done
    python -u $P/eval.py --out {T4} {MODELS} 2>&1 | tee {T4}/eval-r4-old-val.txt
    python -u $P/eval.py --out {T4}/test --cases {CASES} {MODELS} 2>&1 | tee {T4}/eval-r4-old-test.txt
    deliver r4-lehrer raw/vitpose-val.json raw/sapiens-val.json test/raw ensemble-r4.txt eval-r4-old-val.txt eval-r4-old-test.txt
    touch {C}/DONE-TEACHERS
""")
open(f'{C}/job-teachers.sh', 'w').write(job)
subprocess.Popen(f'nohup bash {C}/job-teachers.sh > {C}/job-teachers.log 2>&1 &', shell=True)
print('started: /content/job-teachers.log; /content/out/r4-lehrer.zip, /content/DONE-TEACHERS')
