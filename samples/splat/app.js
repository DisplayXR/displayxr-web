// splat — one Gaussian splat as an inline-3D window.
//
// The whole integration is the two marked lines: open a session, add a splat. Everything else
// here is page furniture — status text, two buttons, and registering the 2D plate as a 2D
// overlay so the weave leaves it crisp.

import { createInline3D } from '@displayxr/inline3d';
import { addSplat } from '@displayxr/inline3d/splat';

const canvas = document.getElementById('tile');
const statusEl = document.getElementById('status');
const buyEl = document.getElementById('buy');

// Default asset: Spark's butterfly, © World Labs, used with permission and converted to SOG
// with all three spherical-harmonic bands kept, so its colour shifts with the viewing angle.
// ?url= loads your own. Anything you ship to a customer needs to be an asset you actually hold
// rights to, which a demo file on someone else's CDN is not.
const DEFAULT_URL = new URL('./assets/butterfly.sog', import.meta.url).href;
const params = new URLSearchParams(location.search);
const url = params.get('url') || DEFAULT_URL;

// The tile renders with the PlayCanvas engine. ?engine=spark renders the same tile with Spark
// (three.js), the SDK's other backend: same handle, same rig and framing. PlayCanvas reads .sog,
// .ply and a Streamed SOG (its lod-meta.json URL). Spark reads .sog, .ply, .spz, .splat and
// .ksplat, but no Streamed SOG.
const engine = params.get('engine') === 'spark' ? 'spark' : 'playcanvas';
const engineName = engine === 'spark' ? 'Spark' : 'PlayCanvas';

// Turntable. A product scan wants it, a photograph lifted into 3D does not (it has no back, so
// a turn only shows its stretched edges). So it starts only when the asset gets the display rig,
// i.e. its .sog carries no capture camera. ?spin=<deg/s> forces a rate, ?spin=0 forces it off.
const SPIN_PARAM = params.has('spin') ? Number(params.get('spin')) || 0 : null;
const SPIN_RATE = SPIN_PARAM || 10;

let wall = null;
let handle = null;

// ── page furniture ────────────────────────────────────────────────────────────────────────
const spinBtn = document.getElementById('spin');
let spinning = false;
function setSpin(on) {
  spinning = Boolean(on);
  if (handle?.viewer) handle.viewer.idleSpin = spinning ? SPIN_RATE : 0;
  spinBtn.textContent = spinning ? 'Pause turntable' : 'Start turntable';
}
spinBtn.addEventListener('click', () => setSpin(!spinning));
document.getElementById('reset').addEventListener('click', () => handle?.resetPose());

// Spark reads a .sog's camera block from BYTES only, so on the Spark path a .sog is fetched
// here and handed over as bytes. Without that the two engines would open the same file with
// different rigs. PlayCanvas reads the block from the URL. A failed fetch falls back to the
// URL, so the load error is reported by addSplat below.
const isSog = /\.sog(\?|#|$)/i.test(url);
const src =
  engine === 'spark' && isSog
    ? await fetch(url).then((r) => (r.ok ? r.arrayBuffer() : url)).catch(() => url)
    : url;

wall = await createInline3D({ lazy: false }); // ← 1. open the session
try {
  handle = addSplat(wall, canvas, src, {
    // ← 2. add the splat
    engine,
    idleSpin: 0, // started below once the rig is known
    feather: 24,
    // Half-scale per eye. After the interlace each eye receives roughly half the panel's
    // samples anyway, so the detail beyond this is rendered and then discarded.
    renderScale: 0.6,
  });
} catch (err) {
  // A format the chosen engine cannot read (a .spz on PlayCanvas, a Streamed SOG on Spark)
  // throws at call time, with a message saying what to pass instead.
  statusEl.textContent = err.message;
  buyEl.hidden = true;
}

if (handle) {
  // The 2D plate sits ON the tile, so it has to be declared as 2D or the weave interlaces it
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
    const n = handle.mesh?.numSplats ?? 0;
    const camRig = handle.rig?.type === 'camera';
    const framing = camRig ? 'opened at its capture camera' : handle.frame ? 'auto-framed' : 'unframed';
    setSpin(SPIN_PARAM ?? (camRig ? 0 : SPIN_RATE));
    statusEl.textContent =
      `${n.toLocaleString()} splats · ${engineName} · ${framing} · ` +
      (wall.supported ? 'woven glasses-free 3D' : 'flat fallback (open in the DisplayXR Browser)');
  } catch {
    statusEl.textContent = `Could not load ${url} with ${engineName} — check the URL, its format and its CORS headers.`;
  }
}
