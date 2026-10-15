#!/bin/bash
# Setup for the video kiosk. firstrun.sh runs it once instead of the first normal boot (--no-start);
# cloud-init runs it again on every boot as a backup (user-data bootcmd/runcmd). Returns at once
# when everything is installed; otherwise installs mpv + ffmpeg from the packages on the card
# (no internet needed). No input needed, ever: cmdline.txt masks the login prompt.
D=/boot/firmware/wand-video
START=1; [ "$1" = --no-start ] && START=0
exec 9>/run/wand-video-install.lock
flock -n 9 || exit 0

if command -v mpv >/dev/null && command -v ffmpeg >/dev/null && [ -x /usr/local/bin/wand-video ] \
   && systemctl -q is-enabled wand-video.service 2>/dev/null; then
  [ $START = 1 ] && systemctl start --no-block wand-video.service
  exit 0
fi

exec >>"$D/install.log" 2>&1
echo "=== $(date '+%F %T') install"
printf '\033[2J\033[H\n\n   Wand-Video wird eingerichtet (nur beim ersten Start, ein paar Minuten) ...\n' > /dev/tty1 2>/dev/null

export DEBIAN_FRONTEND=noninteractive
dpkg --configure -a
if ! command -v mpv >/dev/null || ! command -v ffmpeg >/dev/null; then
  apt-get install -y --no-install-recommends -o DPkg::Lock::Timeout=600 "$D"/debs/*.deb \
    || { echo "offline install failed, trying online"; apt-get -o DPkg::Lock::Timeout=600 update \
         && apt-get install -y --no-install-recommends -o DPkg::Lock::Timeout=600 mpv ffmpeg; }
fi
if ! command -v mpv >/dev/null || ! command -v ffmpeg >/dev/null; then
  echo "ERROR: mpv/ffmpeg missing, next boot tries again"
  exit 1
fi

install -m 755 "$D/wand-video.sh" /usr/local/bin/wand-video
install -m 644 "$D/wand-video.service" /etc/systemd/system/wand-video.service

# Quiet kiosk: no login prompt, no background updates, logs only in RAM
systemctl mask getty@tty1.service
systemctl disable --now apt-daily.timer apt-daily-upgrade.timer man-db.timer
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=volatile\nRuntimeMaxUse=32M\n' > /etc/systemd/journald.conf.d/wand-video.conf

systemctl daemon-reload
systemctl enable wand-video.service
printf '\033[2J\033[H' > /dev/tty1 2>/dev/null
[ $START = 1 ] && systemctl start --no-block wand-video.service
echo "=== $(date '+%F %T') done"
