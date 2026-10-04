// call — a 3D video call via addCall(). See docs/rfcs/0002-video-call.md.

import { createInline3D } from '@displayxr/inline3d';
import { addCall, dxrSignaling } from '@displayxr/inline3d/call';
import { openCamera } from '@displayxr/inline3d/camera';
import { peerjsCloud } from './peerjs-cloud.js'; // demo-only broker adapter; a sample, not part of the package

const q = new URLSearchParams(location.search);

// Signalling: the hosted DisplayXR dxr-signal/1 server by default (it also hands out TURN, so
// calls cross restrictive networks). `?signal=dev` = the local dev server
// (`node signaling/dev-server.mjs`), `?signal=peerjs` = the public PeerJS broker (demo only),
// `?signal=wss://…` = your own server.
const signal = q.get('signal') || '';
const signaling = signal === 'peerjs' ? peerjsCloud() : signal === 'dev' ? dxrSignaling('ws://localhost:8787') : signal ? dxrSignaling(signal) : dxrSignaling();

const wall = await createInline3D({ untrackedFallback: q.get('untracked') === 'mono' ? 'mono' : 'none' });
const status = document.getElementById('status');
status.className = 'status ' + (wall.supported ? 'woven' : 'flat');
status.textContent = wall.supported
  ? 'DisplayXR Browser — side-by-side participants are woven glasses-free 3D.'
  : 'No inline-3D here — this is an ordinary 2D call (a stereo sender shows its left eye).';

// ?camera=synthetic: a generated side-by-side pair with a known disparity (a checkerboard AT the
// screen plane and a square in front of it), so the 3D path can be tried without a stereo camera.
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
      // The square is TEXTURED (fixed pseudo-random blue cells) so it reads like a subject with
      // detail: auto-convergence (call/disparity.js) matches texture; a flat colour has none inside
      // its edges, and a regular checker would alias (it matches one period away).
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

const cam = q.get('camera');
// The synthetic pair is opened through /camera (a page-supplied stream declares its format and
// its calibration there — the module never guesses 3D from a stream's aspect) and handed to the
// call as `camera`; the real cameras go through the call's own 'auto' / 'stereo' / 'mono'.
const camera = cam === 'synthetic' ? await openCamera({ prefer: syntheticSbs(), format: 'sbs', calibration: { baselineMm: 63, horizontalFovDeg: 70 } }) : cam === 'mono' || cam === 'stereo' ? cam : 'auto';

const call = await addCall(wall, document.getElementById('call'), {
  signaling,
  camera,
  layout: q.get('layout') === 'speaker' ? 'speaker' : 'grid',
  theme: q.get('accent') ? { accent: q.get('accent') } : undefined,
  autoJoin: q.get('autojoin') === '1',
  // Mono participants are lifted to 3D through @displayxr/inline3d/lift when this copy of the SDK
  // has it (and a native provider or WebGPU is there); otherwise they stay 2D. ?lift=0 turns it
  // off; ?models=<base url> serves the depth model from your own host.
  mono3D: q.get('lift') === '0' ? 'off' : 'auto',
  liftOptions: q.get('models') ? { models: q.get('models') } : undefined,
  // The invite carries only what a joiner needs (the signalling server), never this page's own
  // test switches — a guest opening a `?camera=synthetic` host's link should use their camera.
  invite: { base: location.origin + location.pathname + (q.get('signal') ? `?signal=${encodeURIComponent(q.get('signal'))}` : '') },
  debug: q.has('debug'),
});

for (const ev of /** @type {const} */ (['peer', 'peerleft', 'display', 'speaker', 'error', 'warning', 'joined', 'left'])) {
  call.on(ev, (p) => console.log(`[call-sample] ${ev} ${JSON.stringify(p)}`));
}
// `quality` with `id: null` is the lift frame-time watch (web provider only); per-peer stats are noisy.
call.on('quality', (p) => 'lift' in p && console.log(`[call-sample] lift frame time ${JSON.stringify(p.lift)}`));

// Debug hooks, same convention as the other samples' __wall / __player: a devtools console (or an
// agent driving the page over CDP) can inspect and drive the call directly.
window.__wall = wall;
window.__call = call;
