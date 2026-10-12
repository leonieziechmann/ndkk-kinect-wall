# Die 2D-Stufe der Auswertung (auswerten.py --nur-2d, Modell stark) auf einer Colab-GPU, gestartet mit der colab CLI
# wie pose-training/colab_*.py. NUR mit deinem ausdrücklichen Ja: Hochgeladen werden die Infrarotbilder (dein Gesicht
# ist darauf erkennbar), die `auswerten.py --colab-paket` gepackt hat; keine Tiefe, keine .k2rec.
#
#   colab new -s mocap --gpu A100                      (oder L4; T4 geht auch, langsamer)
#   colab upload -s mocap <ORDNER>/kinect-ir-<datum>.zip /content/kinect-ir-<datum>.zip    (enthält auch den Code)
#   colab exec -s mocap -f kabel-wickeln/mocap/colab_auswerten.py           startet im Hintergrund, kehrt sofort zurück
#   echo "print(open('/content/job-auswerten.log').read()[-3000:])" | colab exec -s mocap     Fortschritt
#   colab download -s mocap /content/out/kp2d.zip <Hauptordner>/recordings/mocap/kp2d.zip   wenn /content/DONE-auswerten da ist
#   colab stop -s mocap
#
# Auf der VM: Pakete auspacken, Ultralytics + transformers installieren, je Aufnahme YOLO11x-pose + Sapiens2 1b +
# ViTPose++ huge (gespiegelt gemittelt) -> <name>.kp2d-stark.json.gz, alles in /content/out/kp2d.zip. Danach werden
# die hochgeladenen Infrarotbilder auf der VM gelöscht (Zip und ausgepackte Pakete). Ein zweiter Start überspringt
# fertige Aufnahmen. Einstellungen vorher im Python der VM setzen (colab exec), z. B.:
#   MOCAP_ARGS='--topdown sapiens'  weitere Optionen für auswerten.py (ein mit --every gepacktes Paket enthält nur diese Frames)
import os
import subprocess
import textwrap

C = '/content'
ARGS = os.environ.get('MOCAP_ARGS', '')

job = textwrap.dedent(f"""\
    set -x
    mkdir -p {C}/ir {C}/out {C}/kinect/recordings/mocap/modelle
    for z in {C}/kinect-ir-*.zip; do [ -e $z.unpacked ] || {{ unzip -q -o $z -d {C}/ir && touch $z.unpacked; }}; done
    mkdir -p {C}/mocap && cp -r {C}/ir/mocap/. {C}/mocap/
    pip install -q -U "transformers>=5.10" accelerate ultralytics
    cd {C}/mocap
    for p in {C}/ir/*.ir.npz; do
      ls ${{p%.ir.npz}}.kp2d-stark*.json.gz >/dev/null 2>&1 || python -u auswerten.py --nur-2d --modell stark --device cuda --main {C}/kinect --ir-paket $p {ARGS}
    done
    (cd {C}/ir && rm -f {C}/out/kp2d.zip.part && zip -q {C}/out/kp2d.zip.part *.kp2d-*.json.gz && mv {C}/out/kp2d.zip.part {C}/out/kp2d.zip)
    # die Infrarotbilder auf der VM löschen
    rm -f {C}/ir/*.ir.npz {C}/kinect-ir-*.zip {C}/kinect-ir-*.zip.unpacked
    touch {C}/DONE-auswerten
""")
for k in [k for k in os.environ if k.startswith('MOCAP_')]:
    del os.environ[k]
if os.path.exists(f'{C}/job-auswerten.started') and not os.path.exists(f'{C}/DONE-auswerten'):
    print('läuft schon: /content/job-auswerten.log')
else:
    for f in (f'{C}/DONE-auswerten',):
        if os.path.exists(f):
            os.remove(f)
    open(f'{C}/job-auswerten.started', 'w').close()
    open(f'{C}/job-auswerten.sh', 'w').write(job)
    subprocess.Popen(f'nohup bash {C}/job-auswerten.sh > {C}/job-auswerten.log 2>&1 &', shell=True)
    print('gestartet: /content/job-auswerten.log; Ergebnis /content/out/kp2d.zip, fertig wenn /content/DONE-auswerten da ist')
