# A yolo11s-pose run next to round 3 on the Colab VM (colab_round3.py; started the same way): the model the hub
# will run (DirectML, s at 384 by default, at 512 when the GPU has room), with round 3's ensemble labels and
# the recipe of r3c (gray COCO persons, infrared augmentation, rotation, stronger downscaling), 80 epochs.
# It waits until round 3 trains (then its labels, the COCO images and the label caches are ready) and shares
# the GPU with it (batch 64, fewer loader workers). Delivered like round 3: /content/out/r3c-s384.zip with
# best/last.pt, ONNX (384x320, fp32 and fp16), evaluation on the held-out frames and the unseen test.
# Yardstick on the unseen test: the COCO weights of yolo11s at 384 and 512 (r3-lehrer.zip, same labels).
import os
import subprocess
import textwrap

C = '/content'
K = f'{C}/kinect'
T = f'{K}/recordings/training'
TT = f'{T}/test'
N = 'r3c-s384'
EPOCHS = int(os.environ.get('POSE_EPOCHS', '80'))
CASES = 'alle=,final=final-,alt=alt-,room=room-'

job = textwrap.dedent(f"""\
    set -x
    until [ -e {T}/runs/r3a/weights/last.pt ]; do sleep 60; done
    export KINECT_MAIN={K} POSE_THREADS=4
    P={C}/pose-training  # the uploaded scripts (round 3 runs its own copy)
    deliver() {{ s=$1; shift; (cd {T} && rm -f {C}/out/$s.zip.part && zip -q -r {C}/out/$s.zip.part "$@" && mv {C}/out/$s.zip.part {C}/out/$s.zip); }}
    cd {T}/weights
    [ -e {C}/out/{N}.zip ] || {{
      python -u $P/train.py --name {N} --model yolo11s-pose.pt --imgsz 384 --epochs {EPOCHS} --batch 64 --workers 4 --extra coco/images/train --ir-aug --degrees 5 --scale 0.7 ||
        python -u $P/train.py --resume --name {N} --ir-aug
      python -u $P/export.py --name {N} 2>&1 | tee {T}/export-{N}.txt
      M="{T}/runs/{N}/weights/best.pt {T}/runs/{N}/weights/last.pt"
      python -u $P/eval.py $M 2>&1 | tee {T}/eval-{N}-val.txt
      python -u $P/eval.py --out {TT} --cases {CASES} $M 2>&1 | tee {T}/eval-{N}-test.txt
      deliver {N} runs/{N}/weights/best.pt runs/{N}/weights/last.pt runs/{N}/results.csv runs/{N}/args.yaml export/{N}.onnx export/{N}-fp16.onnx export-{N}.txt eval-{N}-val.txt eval-{N}-test.txt; }}
    touch {C}/DONE-{N}
""")
open(f'{C}/job-{N}.sh', 'w').write(job)
subprocess.Popen(f'nohup bash {C}/job-{N}.sh > {C}/job-{N}.log 2>&1 &', shell=True)
print(f'started: /content/job-{N}.log; /content/out/{N}.zip, /content/DONE-{N}')
