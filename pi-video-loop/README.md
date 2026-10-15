# Wand-Video on a Raspberry Pi 4

Plays the NDKK explainer video (`kinect-wand-pc.mp4`) on a Raspberry Pi 4 in a seamless endless loop:
card in, HDMI, power, no input ever. Base: Raspberry Pi OS Lite arm64 (Trixie, 2026-10-06).

- `wand-video/` goes to `/boot/firmware/wand-video/` on the card (FAT, editable in Windows).
- `boot/user-data`, `boot/meta-data`: cloud-init (user `kinect`, SSH key `~/.ssh/kinect_pi_ed25519` only).
- `update-card.ps1 -Drive D: -Media <dir>`: puts everything onto a flashed card. `<dir>` holds
  `loop.mov` and `debs/`, which are not in git (see below).

## How it works

- **Seamless loop:** `ffmpeg -stream_loop -1 ... -c copy -f nut` pipes one endless stream into mpv.
  mpv never reaches an end of file, so there is no seek, decoder restart or audio gap.
  `loop.mov` makes the seam exact: H.264 without B-frames, PCM audio (AAC has codec delay at the seam).
  Video and audio are exactly the same length: 2736 frames at 30 fps and 4377600 samples, both 91.2 s.
- **No login prompt:** `cmdline.txt` has `systemd.mask=getty@tty1.service`, `console=tty3`, `quiet` and no cursor.
- **First boot:** `cmdline.txt` boots into `firstrun.sh` once (`systemd.run=`, as Raspberry Pi Imager
  used to). It installs mpv + ffmpeg offline from `debs/`, removes itself from `cmdline.txt` and reboots.
  Do not do this from cloud-init `runcmd`: `cloud-final` runs after `multi-user.target`, so the login
  prompt shows first, and it never ran on the real card. cloud-init `bootcmd` and `runcmd` only call
  `install.sh` again as a backup; it returns at once when the install is done.
- **Robustness:** `wand-video.service` restarts the player. After two quick crashes it falls back to the
  display's preferred mode and software decoding. Sound goes to the HDMI port the display is on.
  `wand-video.conf` switches it to the jack or turns it off.

## Rebuilding the media (WSL Ubuntu)

```bash
ffmpeg -i kinect-wand-pc.mp4 -map 0:v -map 0:a \
  -c:v libx264 -preset slow -crf 15 -tune animation -bf 0 -refs 3 -g 60 -keyint_min 60 -sc_threshold 0 \
  -profile:v high -level:v 4.1 -maxrate 20M -bufsize 30M -pix_fmt yuv420p -r 30 \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -c:a pcm_s16le -ar 48000 -ac 2 -af atrim=end_sample=4377600 -movflags +faststart loop.mov
```

`debs/`: loop-mount the same Pi OS image, chroot into it with qemu-user-static, then run
`apt-get update && apt-get install --no-install-recommends --download-only mpv ffmpeg`
and take `/var/cache/apt/archives/*.deb`. That gives 170 packages, 122 MB, all new for this image.
