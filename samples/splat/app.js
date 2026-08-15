// splat — one Gaussian splat as an inline-3D window.
//
// The whole integration is the two marked lines: open a session, add a splat. Everything else
// here is page furniture — status text, two buttons, and registering the price plate as a 2D
// overlay so the weave leaves it crisp.

import { createInline3D } from '@displayxr/inline3d';
import { addSplat } from '@displayxr/inline3d/splat';

const canvas = document.getElementById('tile');
const statusEl = document.getElementById('status');
const buyEl = document.getElementById('buy');

// Default asset: Spark's own public getting-started splat, the one their README points at. It
// keeps this page working with no assets committed here. Swap in your own with ?url=… — and
// note that anything you ship to a customer needs to be an asset you actually hold rights to,
// which a demo file on someone else's CDN is not.
const DEFAULT_URL = 'https://sparkjs.dev/assets/splats/butterfly.spz';
const url = new URLSearchParams(location.search).get('url') || DEFAULT_URL;

// A butterfly is not a shoe: it wants a smaller virtual display than a boxed product would, or
// it fills the tile and clips. Real catalogues carry this per SKU.
const VIRTUAL_DISPLAY_HEIGHT = 0.16;

const wall = await createInline3D({ lazy: false }); // ← 1. open the session
const handle = addSplat(wall, canvas, url, {
  // ← 2. add the splat
  virtualDisplayHeight: VIRTUAL_DISPLAY_HEIGHT,
  idleSpin: 10,
  feather: 24,
  // Half-scale per eye. After the interlace each eye receives roughly half the panel's samples
  // anyway, so the detail beyond this is rendered and then discarded.
  renderScale: 0.6,
});

// The price plate sits ON the tile, so it has to be declared as 2D or the weave interlaces it
// along with the splat and it turns to mush. No-ops on a browser without overlay exclusion.
handle.exclude(buyEl);

// Debug hook, same convention as the other samples' __wall: lets a devtools console (or an
// agent driving the page) inspect the viewer without instrumenting the module.
window.__splat = handle;

statusEl.textContent = wall.supported
  ? 'inline-3D session live — loading splat…'
  : 'No inline-3D here — showing the flat fallback. Loading splat…';

try {
  await handle.ready;
  const n = handle.mesh.numSplats ?? 0;
  const src = handle.frame ? 'measured in-page' : 'none';
  statusEl.textContent =
    `${n.toLocaleString()} splats · framing ${src} · ` +
    (wall.supported ? 'woven glasses-free 3D' : 'flat fallback (open in the DisplayXR Browser)');
} catch {
  statusEl.textContent = `Could not load ${url} — check the URL and its CORS headers.`;
}

// ── page furniture ────────────────────────────────────────────────────────────────────────
document.getElementById('reset').addEventListener('click', () => handle.resetPose());

const spinBtn = document.getElementById('spin');
let spinning = true;
spinBtn.addEventListener('click', () => {
  spinning = !spinning;
  handle.viewer.idleSpin = spinning ? 10 : 0;
  spinBtn.textContent = spinning ? 'Pause turntable' : 'Resume turntable';
});
