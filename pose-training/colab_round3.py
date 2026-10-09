# Round 3 on a Colab VM (README.md, "On Colab"; started like colab_job.py: colab exec -s pose -f <this file>):
# a better teacher and the fight against forgetting, measured on recordings no training has seen.
#   data: kinect-pose-daten.zip, kinect-pose-tpose.zip (frames), kinect-pose-test.zip (the unseen test: final-*,
#         alt-*, room; recordings/training/test), kinect-pose-r3.zip (the raw detections of the teacher at 512
#         from round 2 and the round-2 weights in runs-old/)
#   1. teacher yolo11x at 1024 and 768 (upscaled: far persons), mirrored too; ensemble with the teacher at 512:
#      keypoints only where they agree (ensemble.py)
#   2. every model so far against the new labels: on the held-out frames (val) and on the unseen test
#   3. yolo11n at 512, 80 epochs: (a) new labels, (b) + gray COCO persons, (c) + infrared augmentation
# Every result is delivered as soon as it exists, as /content/out/<step>.zip (the watcher on the laptop fetches
# each into recordings/training/models/<step>/): the teacher's evaluation of the old models, then per training
# its weights (best, last), the ONNX for the browser and the hub (fp32, fp16) and its evaluation, so a model can
# be tested while the next one trains. A step that is done is skipped when the job starts again.
import os
import subprocess
import textwrap

C = '/content'
K = f'{C}/kinect'
T = f'{K}/recordings/training'
TT = f'{T}/test'
EPOCHS = int(os.environ.get('POSE_EPOCHS', '80'))
MODELS = ' '.join([
    'yolo11n-pose.pt@512', 'yolo11n-pose.pt@384', 'yolo11s-pose.pt@512', 'yolo11s-pose.pt@384', 'yolo11m-pose.pt@512',
    f'{T}/runs-old/n-ir-2/weights/best.pt@512', f'{T}/runs-old/n-ir-384-2/weights/best.pt@384',
])
CASES = 'alle=,final=final-,alt=alt-,room=room-'
TEACH = 'yolo11x-pose@1024+768-flip yolo11x-pose-flip'
TRAIN = f'python -u {K}/pose-training/train.py --epochs {EPOCHS} --batch 128 --workers 8'

job = textwrap.dedent(f"""\
    set -x
    for z in {C}/kinect-pose-*.zip; do [ -e $z.unpacked ] || {{ unzip -q -o $z -d {C} && touch $z.unpacked; }}; done
    mkdir -p {K}/pose-training {C}/out && cp {C}/pose-training/*.py {K}/pose-training/
    export KINECT_MAIN={K} POSE_THREADS=$(nproc)
    P={K}/pose-training
    pip install -q ultralytics onnx onnxruntime onnxconverter-common onnxslim albumentations
    # deliver <step> <files relative to the training folder>: /content/out/<step>.zip, written whole, then renamed
    deliver() {{ s=$1; shift; (cd {T} && rm -f {C}/out/$s.zip.part && zip -q -r {C}/out/$s.zip.part "$@" && mv {C}/out/$s.zip.part {C}/out/$s.zip); }}
    cd {T}/weights
    [ -e {T}/done-r3-teacher ] || {{
      python -u $P/teacher.py --split val --flip --scales 1024,768 --batch 32 --labels 0 &&
      python -u $P/teacher.py --split train --flip --scales 1024,768 --batch 32 --labels 0 &&
      python -u $P/teacher.py --out {TT} --split val --flip --batch 64 --labels 0 &&
      python -u $P/teacher.py --out {TT} --split val --flip --scales 1024,768 --batch 32 --labels 0 &&
      touch {T}/done-r3-teacher; }}
    python -u $P/ensemble.py --split val --raw {TEACH} 2>&1 | tee {T}/ensemble-r3.txt
    python -u $P/ensemble.py --split train --raw {TEACH} 2>&1 | tee -a {T}/ensemble-r3.txt
    python -u $P/ensemble.py --out {TT} --split val --raw {TEACH} 2>&1 | tee -a {T}/ensemble-r3.txt
    [ -e {C}/out/r3-lehrer.zip ] || {{
      python -u $P/eval.py {MODELS} 2>&1 | tee {T}/eval-r3-old-val.txt
      python -u $P/eval.py --out {TT} --cases {CASES} {MODELS} 2>&1 | tee {T}/eval-r3-old-test.txt
      deliver r3-lehrer raw test/raw ensemble-r3.txt eval-r3-old-val.txt eval-r3-old-test.txt; }}
    [ -e {T}/coco/images/train ] || python -u $P/coco.py --out {T}
    # train <name> <train.py options>: train (or go on), export, evaluate, deliver
    train() {{ n=$1; shift
      [ -e {C}/out/$n.zip ] && return
      {TRAIN} --name $n "$@" || python -u $P/train.py --resume --name $n "$@"
      python -u $P/export.py --name $n 2>&1 | tee {T}/export-$n.txt
      M="{T}/runs/$n/weights/best.pt@512 {T}/runs/$n/weights/last.pt@512"
      python -u $P/eval.py $M 2>&1 | tee {T}/eval-$n-val.txt
      python -u $P/eval.py --out {TT} --cases {CASES} $M 2>&1 | tee {T}/eval-$n-test.txt
      deliver $n runs/$n/weights/best.pt runs/$n/weights/last.pt runs/$n/results.csv runs/$n/args.yaml export/$n.onnx export/$n-fp16.onnx export-$n.txt eval-$n-val.txt eval-$n-test.txt
    }}
    train r3a
    train r3b --extra coco/images/train
    train r3c --extra coco/images/train --ir-aug --degrees 5 --scale 0.7
    touch {C}/DONE-R3
""")
open(f'{C}/job-r3.sh', 'w').write(job)
if os.path.exists(f'{C}/DONE-R3'):
    os.remove(f'{C}/DONE-R3')
subprocess.Popen(f'nohup bash {C}/job-r3.sh > {C}/job-r3.log 2>&1 &', shell=True)
print('started: /content/job-r3.log; /content/out/<step>.zip as results come, /content/DONE-R3 at the end')
