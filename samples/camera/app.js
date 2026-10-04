// camera — a 3D selfie page on @displayxr/inline3d/camera. See docs/camera.md.

import { sharedInline3D, inline3DAvailable } from '@displayxr/inline3d';
import { openCamera, addCameraView } from '@displayxr/inline3d/camera';

const q = new URLSearchParams(location.search);
/** @returns {HTMLInputElement & HTMLButtonElement} the control with `id` (every control here is an input or a button) */
const $ = (id) => /** @type {any} */ (document.getElementById(id));
const status = $('status');
const say = (text, cls) => {
  status.textContent = text;
  if (cls) status.className = `status ${cls}`;
};

// ?camera=synthetic: a generated side-by-side pair with a KNOWN disparity — a textured square in
// front of the screen plane, labelled L / R per eye — so the mirrored self view can be checked
// without a stereo camera: in the mirror the labels read backwards, the "R" half is on the LEFT,
// and the square still stands in front (mirror each half AND swap; see docs/camera.md).
function syntheticSbs() {
  const W = 1280;
  const H = 720;
  const D = 24;
  const c = Object.assign(document.createElement('canvas'), { width: W * 2, height: H });
  const g = c.getContext('2d');
  let n = 0;
  const draw = () => {
    n++;
    const x = W / 2 + Math.sin(n / 60) * 300;
    for (const eye of [0, 1]) {
      const ox = eye * W;
      g.save();
      g.beginPath();
      g.rect(ox, 0, W, H);
      g.clip();
      for (let yy = 0; yy < H; yy += 80) for (let xx = 0; xx < W; xx += 80) {
        g.fillStyle = ((xx + yy) / 80) % 2 ? '#2a3350' : '#1a2036';
        g.fillRect(ox + xx, yy, 80, 80);
      }
      const sx = ox + x - 120 + (eye === 0 ? D : -D);
      for (let yy = 0; yy < 240; yy += 16) for (let xx = 0; xx < 240; xx += 16) {
        const h = ((xx * 73856093) ^ (yy * 19349663)) >>> 0;
        g.fillStyle = ['#1d4ed8', '#3b82f6', '#60a5fa', '#93c5fd'][(h >>> 7) & 3];
        g.fillRect(sx + xx, H / 2 - 120 + yy, 16, 16);
      }
      g.fillStyle = '#fff';
      g.font = '600 48px system-ui';
      g.fillText(eye === 0 ? 'L' : 'R', ox + 30, 70);
      g.fillText(`#${n}`, ox + 30, H - 40);
      g.restore();
    }
  };
  setInterval(draw, 1000 / 30);
  draw();
  return c.captureStream(30);
}

const want = q.get('camera');
let cam;
try {
  cam =
    want === 'synthetic'
      ? await openCamera({ prefer: syntheticSbs(), format: 'sbs', calibration: { baselineMm: 63, horizontalFovDeg: 70 }, debug: q.has('debug') })
      : await openCamera({ prefer: want === 'stereo' || want === 'mono' ? want : 'auto', debug: q.has('debug') });
} catch (err) {
  say(`No camera: ${err.code} — ${err.message}`, 'flat');
  throw err;
}

const wall = await sharedInline3D();
const kind = cam.format === 'sbs' ? `3D (side-by-side, ${cam.width}×${cam.height}${cam.stereo?.rectified ? ', rectified' : ''})` : `2D (${cam.width}×${cam.height})`;
say(
  inline3DAvailable()
    ? `DisplayXR Browser — ${cam.label || 'camera'}: ${kind}. The self view is woven; a pair is mirrored each half and eye-swapped.`
    : `No inline-3D here — ${cam.label || 'camera'}: ${kind}. The self view is the left eye, flat; files are still real pairs.`,
  inline3DAvailable() ? 'woven' : 'flat'
);

const view = addCameraView(wall, /** @type {HTMLCanvasElement} */ (document.getElementById('self')), cam, { mirror: true, autoConverge: false });
$('mirror').addEventListener('change', () => view.setMirror($('mirror').checked));
$('converge').addEventListener('change', () => view.setAutoConverge($('converge').checked));
$('depth').addEventListener('input', () => view.setDepth($('depth').valueAsNumber));
$('depth').addEventListener('dblclick', () => (($('depth').value = '0'), view.setDepth(0)));

cam.on('ended', () => {
  say('The camera ended (revoked, unplugged, or taken by another app). Reload to open it again.', 'flat');
  $('photo').disabled = $('rec').disabled = true;
});

const files = $('files');
function offer(blob, name, note) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.textContent = `${name} (${(blob.size / 1024).toFixed(0)} KB${note ? `, ${note}` : ''})`;
  files.prepend(a);
}

$('photo').disabled = false;
$('photo').addEventListener('click', async () => {
  const photo = await cam.capturePhoto();
  offer(photo.blob, photo.suggestedName, photo.convergencePx === null ? 'no convergence measured' : `convergence ${photo.convergencePx.toFixed(1)} px`);
});

$('rec').disabled = false;
let rec = null;
$('rec').addEventListener('click', async () => {
  if (!rec) {
    rec = cam.record({ mono: $('mono').checked });
    $('rec').textContent = 'Stop';
    $('rec').dataset.on = '1';
    return;
  }
  const r = rec;
  rec = null;
  $('rec').textContent = 'Record';
  delete $('rec').dataset.on;
  const clip = await r.stop();
  offer(clip.blob, clip.suggestedName, `${(clip.durationMs / 1000).toFixed(1)} s${clip.tagged ? ', tagged' : ''}`);
  if (clip.mono) offer(clip.mono, clip.monoSuggestedName, '2D copy');
});

// Debug hooks, same convention as the other samples' __wall / __call.
Object.assign(window, { __wall: wall, __cam: cam, __view: view });
