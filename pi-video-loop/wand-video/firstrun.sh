#!/bin/bash
# Runs once instead of the normal boot (cmdline.txt: systemd.run=... systemd.unit=kernel-command-line.target),
# like the firstrun.sh of Raspberry Pi Imager: installs the kiosk, takes itself out of cmdline.txt and
# reboots (systemd.run_success_action / run_failure_action) straight into the video.
C=/boot/firmware/cmdline.txt
bash /boot/firmware/wand-video/install.sh --no-start
RC=$?
sed -i -E 's/ systemd\.(run|run_success_action|run_failure_action)=[^ ]*//g; s/ systemd\.unit=kernel-command-line\.target//g' "$C"
sync
exit $RC
