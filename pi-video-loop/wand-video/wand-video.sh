#!/bin/bash
# Plays the video in an endless, seamless loop (run by wand-video.service).
#
# Why it is seamless: ffmpeg reads the file endlessly (-stream_loop -1) and copies it into ONE
# continuous stream with steadily rising timestamps. mpv never sees an end of file, so there is
# no seek, no decoder restart and no audio gap at the seam. loop.mov is built for this:
# 2736 frames at 30 fps and exactly 4377600 PCM samples (both 91.2 s), H.264 without B-frames.

D=/boot/firmware/wand-video
VIDEO=$D/loop.mov
TON=hdmi
MODUS=1920x1080@60
LAUTSTAERKE=100
HWDEC=v4l2m2m-copy,auto-safe

# Settings from wand-video.conf (KEY=VALUE; the file may have Windows line endings)
if [ -f "$D/wand-video.conf" ]; then
  while IFS='=' read -r k v; do
    k=${k//[[:space:]]/}; v=${v//[[:space:]]/}
    case $k in TON|MODUS|LAUTSTAERKE|VIDEO) [ -n "$v" ] && printf -v "$k" '%s' "$v" ;; esac
  done < <(tr -d '\r' < "$D/wand-video.conf" | grep -E '^[A-Z]+=')
fi
[ -f "$VIDEO" ] || VIDEO=$D/$VIDEO

# Two quick crashes in a row: next try with the display's preferred mode and software decoding
mkdir -p /run/wand-video
FAILS=$(cat /run/wand-video/fails 2>/dev/null || echo 0)
if [ "$FAILS" -ge 2 ]; then MODUS=auto; HWDEC=no; fi

# Wait for a display: one of the two HDMI ports first, otherwise any connected output
while :; do
  STATUS=$(grep -l '^connected' /sys/class/drm/card*-HDMI-A-*/status /sys/class/drm/card*-*/status 2>/dev/null | head -n1)
  [ -n "$STATUS" ] && break
  sleep 1
done
CONN=$(basename "$(dirname "$STATUS")")      # e.g. card1-HDMI-A-1
CARD=/dev/dri/${CONN%%-*}                     # card1
PORT=0
case $CONN in *-HDMI-A-*) PORT=$(( ${CONN##*-} - 1 )) ;; esac   # HDMI-A-1 -> vc4hdmi0, HDMI-A-2 -> vc4hdmi1

case ${TON,,} in
  hdmi)          AO=(--audio-device="alsa/hdmi:CARD=vc4hdmi$PORT,DEV=0") ;;
  klinke|jack)   AO=(--audio-device="alsa/sysdefault:CARD=Headphones") ;;
  aus|off|no)    AO=(--no-audio) ;;
  *)             AO=() ;;
esac

MODE=()
if [ "${MODUS,,}" != auto ] && grep -qx "${MODUS%@*}" "$(dirname "$STATUS")/modes" 2>/dev/null; then
  MODE=(--drm-mode="$MODUS")
fi

echo "wand-video: $CONN, sound=$TON, mode=${MODE[*]:-preferred}, hwdec=$HWDEC, video=$VIDEO"
START=$(date +%s)

ffmpeg -nostdin -hide_banner -loglevel error -stream_loop -1 -i "$VIDEO" \
    -map 0:v:0 -map '0:a:0?' -c copy -f nut pipe:1 \
  | mpv --no-config --really-quiet --no-terminal --no-input-default-bindings \
    --vo=gpu --gpu-context=drm --drm-device="$CARD" --drm-connector="${CONN#*-}" "${MODE[@]}" \
    --hwdec="$HWDEC" --profile=fast --fs --osd-level=0 --no-osc --cursor-autohide=always \
    --video-sync=display-resample --audio-fallback-to-null=yes "${AO[@]}" --volume="$LAUTSTAERKE" \
    --cache=yes --demuxer-max-bytes=64MiB --demuxer-readahead-secs=10 -
RC=$?

if [ $(( $(date +%s) - START )) -lt 20 ]; then echo $((FAILS + 1)) > /run/wand-video/fails; else echo 0 > /run/wand-video/fails; fi
exit $RC
