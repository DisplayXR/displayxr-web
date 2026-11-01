// DisplayXR 3D Photos: front end (an ES module).
//
// Every browser already shows a normal photo: the server markup crops the side-by-side pair to
// one eye with plain CSS. This script only adds 3D, and only where it can exist: in the DisplayXR
// Browser on a 3D display. Anywhere else (or if jsDelivr is blocked) it changes nothing.
//
// How it follows docs/woven-canvas-rules.md:
//   rule 1  one inline-3D session for the whole page (sharedInline3D), every photo added to it;
//   rule 4  the canvas gets its final box and will-change from the stylesheet, and is registered
//           two animation frames after it is in the DOM;
//   rule 5  the flat photo stays ON TOP of the canvas until handle.firstWoven, then is cut;
//   rule 7  no CSS effects on the canvas (see dxr3d.css);
//   rule 11 rectCover:'auto' covers a responsive resize after the first weave.

const LOST = new Set(['layer-failed', 'session-ended', 'removed', 'unsupported']);

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

function loaded(img) {
  if (img.complete && img.naturalWidth > 0) return Promise.resolve(img);
  // The flat photo is lazy-loaded by the browser; wait for it rather than fetching twice.
  return new Promise((resolve, reject) => {
    img.addEventListener('load', () => resolve(img), { once: true });
    img.addEventListener('error', reject, { once: true });
  });
}

// layout="cross": the left half holds the RIGHT eye. Swap the halves once into a canvas the SDK
// paints from (addImage accepts a canvas source), so the woven pair is always left | right.
function swapped(img) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const half = Math.floor(w / 2);
  const c = document.createElement('canvas');
  c.width = half * 2;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, half, 0, half, h, 0, 0, half, h); // right half -> left eye
  ctx.drawImage(img, 0, 0, half, h, half, 0, half, h); // left half -> right eye
  return c;
}

async function weave(wall, fig) {
  const stage = fig.querySelector('.dxr3d-stage');
  const img = fig.querySelector('img.dxr3d-flat');
  if (!stage || !img) return;
  try {
    await loaded(img);
  } catch {
    console.warn('[dxr3d] could not load', fig.dataset.dxrSrc, '- left as is');
    return;
  }
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return;

  // Fix the box to one eye's shape before the photo leaves the flow.
  if (!stage.style.aspectRatio) stage.style.aspectRatio = `${w / 2} / ${h}`;

  const canvas = document.createElement('canvas');
  canvas.className = 'dxr3d-canvas';
  canvas.setAttribute('role', 'img');
  if (img.alt) canvas.setAttribute('aria-label', img.alt);
  stage.insertBefore(canvas, img); // under the photo, which stays on top as the cover
  fig.classList.add('dxr3d-on');

  await nextFrame();
  await nextFrame();

  let handle;
  try {
    const source = fig.dataset.dxrLayout === 'cross' ? swapped(img) : img;
    handle = wall.addImage(canvas, source, { rectCover: 'auto' });
  } catch (e) {
    console.warn('[dxr3d] 3D unavailable for', fig.dataset.dxrSrc, e);
    canvas.remove();
    fig.classList.remove('dxr3d-on');
    return;
  }

  const result = await handle.firstWoven; // settles once, never rejects
  if (!result.woven && LOST.has(result.reason)) {
    // This window will not weave: keep the clean flat photo rather than the SDK's flat canvas.
    handle.remove();
    canvas.remove();
    fig.classList.remove('dxr3d-on');
    return;
  }
  // Woven, or the browser's safety release (keep drawing both eyes): cut the cover.
  fig.classList.add('dxr3d-woven');
}

async function boot() {
  const figs = Array.from(document.querySelectorAll('figure.dxr3d[data-dxr-sdk]'));
  if (!figs.length) return;

  let sdk;
  try {
    sdk = await import(figs[0].dataset.dxrSdk);
  } catch (e) {
    console.info('[dxr3d] DisplayXR SDK not reachable; showing flat photos.', e);
    return;
  }
  // Cheap, synchronous: true only in the DisplayXR Browser with inline-3D enabled.
  if (!sdk.inline3DAvailable()) return;

  // One session per document, shared with anything else on the page that uses the SDK.
  const wall = await sdk.sharedInline3D();
  if (!wall.supported) return;

  for (const fig of figs) weave(wall, fig);
}

boot();
