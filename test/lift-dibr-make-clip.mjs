// Encode the synthetic scene to test/lift-dibr-clip.mp4 (H.264, 1280x720, 60 fps, 4 s loop).
//   node test/lift-dibr-make-clip.mjs      (needs ffmpeg on PATH)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { W, H, FPS, DURATION, renderFrame } from './lift-dibr-scene.mjs';

const out = fileURLToPath(new URL('./lift-dibr-clip.mp4', import.meta.url));
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba',
  '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-', '-c:v', 'libx264', '-preset', 'slow',
  '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
const buf = new Uint8ClampedArray(W * H * 4);
const n = FPS * DURATION;
for (let f = 0; f < n; f++) {
  renderFrame(f / FPS, buf);
  if (!ff.stdin.write(Buffer.from(buf.buffer))) await new Promise((r) => ff.stdin.once('drain', r));
}
ff.stdin.end();
ff.on('close', (c) => { console.log(c === 0 ? `wrote ${out}` : `ffmpeg exit ${c}`); process.exit(c); });
