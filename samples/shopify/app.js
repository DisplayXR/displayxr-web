// shopify — a merchant's existing Shopify 3D product, woven, with no asset work.
//
// The point of this sample is what it does NOT do. There is no conversion step, no re-export, no
// copy of the asset in this repo: `addModel` is handed a `cdn.shopify.com` URL and that is the
// whole integration. Shopify serves those files `access-control-allow-origin: *`, uncompressed,
// at real-world metre scale, so the SDK's ordinary model path already handles them.

import { createInline3D } from '@displayxr/inline3d';
import { addModel } from '@displayxr/inline3d/model';

// A product on one of Shopify's own demo storefronts. Deliberately THEIR asset on THEIR CDN —
// pointing at something we host would prove nothing about a merchant's catalogue.
const SHOPIFY_GLB =
  'https://cdn.shopify.com/3d/models/o/65d78c9116ff4cfc/OttiCombatBoot.glb';

// A combat boot is ~0.30 m tall. vH is metres and the fit normalises against it, so this is the
// object's real size rather than a number tuned until it looked right — Shopify's models arrive
// correctly scaled, which is the reason that is possible at all.
const V_H = 0.3;

// Where THIS SITE serves three's Draco decoder. The SDK defaults to `/draco/` on your origin and
// deliberately never falls back to a CDN, so a page hosted under a path prefix (as GitHub Pages
// hosts this one) has to say where the files actually are.
//
// Shopify's own optimiser does not emit Draco, so this asset does not need it. It is wired up
// because merchants routinely upload pre-Draco'd GLBs and Shopify passes those through untouched:
// without a decoder configured, GLTFLoader throws rather than degrading, and the failure would
// look like a broken product instead of a missing decoder.
const DECODER_PATH = { draco: new URL('../../vendor/draco/', import.meta.url).pathname };

const canvas = document.getElementById('tile');
const note = document.getElementById('note');
const input = document.getElementById('url');
const hint = document.getElementById('hint');

const wall = await createInline3D({ lazy: false });
input.value = SHOPIFY_GLB;

if (!wall.supported) {
  // Not the DisplayXR Browser, or no 3D display. The model still renders — flat — which is
  // exactly what a merchant's other visitors would see, and the reason this is safe to ship to
  // all of them rather than to a special build.
  hint.textContent =
    'Rendering flat: this browser has no inline-3D session. On a DisplayXR display the same page is woven.';
}

let handle = null;

/** Load a GLB by URL into the tile, replacing whatever was there. */
async function show(url) {
  note.textContent = 'loading…';
  if (handle) {
    handle.remove();
    handle = null;
  }

  const t0 = performance.now();
  try {
    handle = addModel(wall, canvas, url, {
      virtualDisplayHeight: V_H,
      environment: 'studio',
      idleSpin: 10,
      feather: 24,
      renderScale: 0.6,
      decoderPath: DECODER_PATH,
    });
    await handle.ready;

    const [w, h, d] = handle.frame.extent.map((n) => n.toFixed(2));
    const ms = Math.round(performance.now() - t0);
    // Report the MEASURED bounds, not the requested size. If a Shopify asset ever came through at
    // some other unit scale this is where it would be visible, rather than silently mis-framed.
    note.textContent =
      `loaded from cdn.shopify.com in ${ms} ms · measured ${w} × ${h} × ${d} m · ` +
      (wall.supported ? 'woven' : 'flat fallback');
  } catch (err) {
    // Name the likely cause. A cross-origin failure and a missing decoder look identical from the
    // outside, and guessing between them is what wastes the afternoon.
    note.textContent =
      `could not load: ${err?.message || err}. If this is not a cdn.shopify.com URL, the host may ` +
      `not allow cross-origin reads.`;
  }
}

document.getElementById('load').addEventListener('click', () => {
  const url = input.value.trim();
  if (url) show(url);
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('load').click();
});

document.getElementById('reset').addEventListener('click', () => {
  input.value = SHOPIFY_GLB;
  show(SHOPIFY_GLB);
});

show(SHOPIFY_GLB);
