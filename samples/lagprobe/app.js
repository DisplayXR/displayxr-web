// lagprobe — a deliberately minimal inline-3D tile whose only job is to make scroll lag
// MEASURABLE. No three.js, no CDN: per-eye rendering is plain WebGL scissor+clear, so the
// page cannot itself be the source of a frame of latency.
//
// Per frame it logs (console.error so the line survives --v=0 in logcat):
//   [LAGPROBE] pf=<page frame> sy=<scrollY dev px> tile=<x,y wxh dev px> bar=<step> phase=<p>
// Correlate pf/tile against the browser-internal [DXR-LAGPROBE] line (submitted rect vs
// staging rect vs freshness) to separate "wrong geometry" from "old content".
window.__beacon('module-start');
import { startInline3D } from '@displayxr/inline3d';
window.__beacon('sdk-imported');

const canvas = document.getElementById('tile');
const hud    = document.getElementById('hud');
const refbar = document.getElementById('refbar');
const gl     = canvas.getContext('webgl', { alpha: true, antialias: false, preserveDrawingBuffer: false });

const dpr = window.devicePixelRatio || 1;
const BAR_STEPS = 40;                 // stripe sweeps across the tile in 40 discrete steps
let pf = 0;                           // page frame counter
let phase = 'idle';

// ---- auto-scroll driver -------------------------------------------------------------------
// PROGRAMMATIC scroll is main-thread; a touch fling is compositor-thread. They can behave
// differently for this bug, so ?auto=1 runs a deterministic ramp and the default just logs
// while scrolling is driven externally (adb input swipe).
const params = new URLSearchParams(location.search);
const AUTO = params.get('auto') === '1';
const STATIC = params.get('static') === '1';
const PLAN = [                        // [phase name, frames, px per frame]
  ['settle', 60, 0], ['slow', 90, 2], ['settle', 30, 0],
  ['med',    90, 8], ['settle', 30, 0],
  ['fast',   90, 24], ['STOP',  90, 0],   // abrupt stop = the latency-vs-geometry snap test
];
let planIdx = 0, planLeft = AUTO ? PLAN[0][1] : 0;

function driveScroll() {
  if (!AUTO) { phase = 'manual'; return; }
  if (planIdx >= PLAN.length) { phase = 'done'; return; }
  const [name, , step] = PLAN[planIdx];
  phase = name;
  if (step) window.scrollBy(0, step);
  if (--planLeft <= 0) { planIdx++; if (planIdx < PLAN.length) planLeft = PLAN[planIdx][1]; }
}


// Deterministic positioning for measurement runs: ?y=<device px> scrolls the tile to a known
// place with no fling momentum, so a screenshot can be compared against an exact expectation.
{
  const yq = new URLSearchParams(location.search).get('y');
  if (yq !== null) {
    const target = parseInt(yq, 10) / (window.devicePixelRatio || 1);
    // Cold layout under-scrolls (content height not final at 'load'), so retry
    // until the target sticks or we run out of tries — deterministic positioning
    // is what makes the A/B arms comparable.
    let tries = 0;
    const settle = () => {
      window.scrollTo(0, target);
      const got = Math.round(window.scrollY * dpr);
      if (Math.abs(got - parseInt(yq, 10)) > 4 && ++tries < 40) return setTimeout(settle, 50);
      window.__beacon('positioned sy=' + got + ' tries=' + tries);
    };
    addEventListener('load', () => setTimeout(settle, 50));
  }
}

// ---- per-eye render ------------------------------------------------------------------------
// A bright stripe steps one slot per frame. Its position IS the frame number, so a woven tile
// that shows an older stripe position than the DOM reference bar is lagging by that many frames.
function drawEye(vp, step, eyeIdx) {
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(vp.x, vp.y, vp.width, vp.height);
  gl.clearColor(eyeIdx === 0 ? 0.06 : 0.10, 0.07, 0.12, 1);   // slight L/R tint = stereo proof
  gl.clear(gl.COLOR_BUFFER_BIT);
  // stripe
  const w = Math.max(6, Math.floor(vp.width / BAR_STEPS));
  const x = vp.x + Math.floor((step / BAR_STEPS) * (vp.width - w));
  // eye disparity: shift the stripe a few px per eye so it reads as depth when woven
  const disp = eyeIdx === 0 ? -6 : 6;
  gl.scissor(x + disp, vp.y, w, vp.height);
  gl.clearColor(0.30, 0.85, 1.0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  // static reference ticks at fixed positions (should never move relative to the tile)
  for (let t = 0; t <= 4; t++) {
    gl.scissor(vp.x + Math.floor(t * (vp.width - 4) / 4), vp.y, 4, Math.floor(vp.height * 0.14));
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  gl.disable(gl.SCISSOR_TEST);
}

function logFrame(step) {
  const r = canvas.getBoundingClientRect();
  const x = Math.round(r.left * dpr), y = Math.round(r.top * dpr);
  const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  window.__bpush(`[LAGPROBE] pf=${pf} sy=${Math.round(window.scrollY * dpr)} tile=${x},${y} ${w}x${h} bar=${step} phase=${phase}`);
  if (phase === 'done' || (pf % 120) === 0) window.__bflush();
}

function tick(step) {
  refbar.style.left = ((step / BAR_STEPS) * (812 - 10)) + 'px';
  hud.textContent = `pf=${pf} phase=${phase}\nbar=${step} dpr=${dpr}\nsy=${Math.round(window.scrollY)}`;
}

window.__beacon('calling-startInline3D gl=' + (gl ? 'ok' : 'NULL'));
const status = await startInline3D(canvas, {
  virtualDisplayHeight: 0.12,
  onFrame: (views, layer) => {
    pf++;
    const step = STATIC ? 20 : (pf % BAR_STEPS);
    driveScroll();
    views.forEach((v, i) => drawEye(layer.getViewport(v), step, i));
    tick(step); logFrame(step);
  },
});

window.__beacon('startInline3D returned supported=' + (status && status.supported));

// Mono fallback so the page is still meaningful without the DisplayXR browser.
if (!status.supported) {
  const loop = () => {
    pf++; const step = pf % BAR_STEPS;
    driveScroll();
    drawEye({ x: 0, y: 0, width: canvas.width, height: canvas.height }, step, 0);
    tick(step); logFrame(step);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
