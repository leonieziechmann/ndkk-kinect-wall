// The video as a long loop file: the rendered video several times in a row, seamless inside the file.
// The video loops on its own (it ends on its first frame, the track is mixed around the seam), but
// many players pause for a moment when they start a file over; with this file that happens only
// every few minutes. The picture is copied as it is (no new encoding), the sound is encoded once from
// the looped track, so picture and sound stay together to the frame.
//
//   node tools/loop.mjs [N]      output/kinect-wand.mp4 + output/soundtrack.wav
//                                → output/kinect-wand-loop.mp4 (N times, default 10: about 15 min)
//
// Needs the rendered video (npm run render -- --fps 30) and the track it was rendered with (npm run sound).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.FFMPEG ?? ffmpegInstaller.path;
const times = Number(process.argv[2] ?? 10);
const out = (name) => path.join(root, 'output', name);
for (const f of ['kinect-wand.mp4', 'soundtrack.wav']) {
  if (!fs.existsSync(out(f))) {
    console.error(`output/${f} fehlt: erst ${f.endsWith('.mp4') ? '`npm run render -- --fps 30`' : '`npm run sound`'}.`);
    process.exit(1);
  }
}

const ff = (...args) => execFileSync(FFMPEG, ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
// the picture alone, so that its length is exactly that of its frames (the sound track of the
// render is a little longer, by the padding of its encoder) ...
const picture = out('loop-picture.mp4');
ff('-i', out('kinect-wand.mp4'), '-map', '0:v', '-c', 'copy', picture);
// ... and then N times in a row, with the track N times in a row underneath
const list = out('loop-list.txt');
fs.writeFileSync(list, Array.from({ length: times }, () => `file '${picture.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`).join('\n'));
const seconds = (fs.statSync(out('soundtrack.wav')).size - 44) / 8 / 48000;
const result = out('kinect-wand-loop.mp4');
ff(
  '-f', 'concat', '-safe', '0', '-i', list,
  '-stream_loop', String(times - 1), '-i', out('soundtrack.wav'),
  '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
  '-t', (seconds * times).toFixed(3), '-movflags', '+faststart', result,
);
fs.rmSync(picture);
fs.rmSync(list);
console.log(`→ output/kinect-wand-loop.mp4: ${times} × ${seconds.toFixed(1)} s, ${(fs.statSync(result).size / 1e6).toFixed(0)} MB`);
