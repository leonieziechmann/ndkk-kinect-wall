# The whole training on a Google Colab VM (GPU), started with the colab CLI (README.md, "On Colab"):
#   colab upload -s pose <data zip> /content/kinect-pose-daten.zip    (kaggle.py packs it; more: kinect-pose-<x>.zip)
#   colab upload -s pose pose-training/<each script> /content/pose-training/<script>
#   colab exec -s pose -f pose-training/colab_job.py                   starts it in the background, returns
#   echo "print(open('/content/job.log').read()[-3000:])" | colab exec -s pose     progress
#   colab download -s pose /content/ergebnis.zip <local>                once /content/DONE exists
# On the VM: unpacks the data, installs Ultralytics, then labels with the teacher (both splits, mirrored
# and averaged), trains the browser model at 512 (as now) and at 384 (faster in the browser), evaluates
# old against new, exports both, and packs ergebnis.zip. The steps run in a shell of their own (nohup), so
# a lost connection to the CLI does not stop them; a step that is done is skipped when started again.
import glob
import os
import subprocess
import textwrap

C = '/content'
K = f'{C}/kinect'
EPOCHS = int(os.environ.get('POSE_EPOCHS', '40'))

# every data zip: kinect-pose-daten.zip (kaggle.py) and those packed later (kaggle.py --only <prefix>)
for z in sorted(glob.glob(f'{C}/kinect-pose-*.zip')):
    if not os.path.exists(f'{z}.unpacked'):
        subprocess.run(['unzip', '-q', '-o', z, '-d', C], check=True)
        open(f'{z}.unpacked', 'w').close()
os.makedirs(f'{K}/pose-training', exist_ok=True)
subprocess.run(f'cp {C}/pose-training/*.py {K}/pose-training/', shell=True, check=True)

job = textwrap.dedent(f"""\
    set -x
    export KINECT_MAIN={K} POSE_THREADS=$(nproc)
    T={K}/recordings/training; P={K}/pose-training
    pip install -q ultralytics onnx onnxruntime onnxconverter-common onnxslim
    cd $T/weights
    [ -e $T/done-teacher ] || {{ python -u $P/teacher.py --split val --flip --batch 64 && python -u $P/teacher.py --split train --flip --batch 64 && touch $T/done-teacher; }}
    [ -e $T/done-n512 ] || {{ python -u $P/train.py --epochs {EPOCHS} --batch 128 --workers 8 --name n-ir || python -u $P/train.py --resume --name n-ir; }} && touch $T/done-n512
    [ -e $T/done-n384 ] || {{ python -u $P/train.py --epochs {EPOCHS} --batch 128 --workers 8 --imgsz 384 --name n-ir-384 || python -u $P/train.py --resume --name n-ir-384; }} && touch $T/done-n384
    python -u $P/eval.py 2>&1 | tee $T/eval.txt
    python -u $P/export.py --name n-ir 2>&1 | tee $T/export.txt
    python -u $P/export.py --name n-ir-384 2>&1 | tee -a $T/export.txt
    cd $T && rm -f {C}/ergebnis.zip && zip -q -r {C}/ergebnis.zip raw runs export eval.txt export.txt
    touch {C}/DONE
""")
open(f'{C}/job.sh', 'w').write(job)
if os.path.exists(f'{C}/DONE'):
    os.remove(f'{C}/DONE')
subprocess.Popen(f'nohup bash {C}/job.sh > {C}/job.log 2>&1 &', shell=True)
print('started: tail /content/job.log; /content/DONE when finished')
