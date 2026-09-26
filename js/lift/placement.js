// lift/placement.js — find the real media under a point, and float a canvas exactly over it.
//
// A port of the Immersity Lens approach (dfattal.github.io/ImmersityLens/content.js):
//   • resolveMediaAt(x, y) — elementsFromPoint, then walk to the real <video>/<img>/<canvas>
//     (`findImgInParentsAndSiblings`: own subtree first, then siblings, at most 5 levels up, so a
//     click on a caption, a hover plate or YouTube's overlay stack still finds the media), with the
//     same size (≥ 50 px) and aspect (0.2..5) filters that keep icons and UI strips out.
//   • mountCanvas(el) — Immersity Lens's layout modes, reduced to where the host goes:
//       standard     host is the element's next sibling (its own container)
//       picture      <img> inside <picture>: host goes next to the <picture>, not inside it
//       aspectRatio  padding-bottom ratio boxes (Instagram/Pinterest/Shopify): host goes in the box
//       overlay      absolute/fixed/transformed media (Facebook-style stacks, players): host is the
//                    element's sibling with a z-index one above it
//     In every mode the host is `position:absolute` (fixed for fixed media) and re-derived from the
//     element's CONTENT box whenever it moves, so it scrolls with the page and survives resizes and
//     re-layout. The canvas lives in a CLOSED shadow root, so page CSS cannot reach it and page
//     scripts cannot find it by query.
//
// The element is only touched via inline `visibility` (hidden while covered, see below); unmount() restores it and removes the host.

const MIN_MEDIA_PX = 50;
const MAX_ASPECT = 5;
const MAX_SEARCH_LEVELS = 5;

const isMedia = (el) => !!el && (el.tagName === 'VIDEO' || el.tagName === 'IMG' || el.tagName === 'CANVAS');

/** Size/aspect filter (Immersity Lens: < 50 px or aspect outside 0.2..5 is UI, not content). */
export function isContentSized(w, h) {
  if (!(w >= MIN_MEDIA_PX && h >= MIN_MEDIA_PX)) return false;
  const a = w / h;
  return a <= MAX_ASPECT && a >= 1 / MAX_ASPECT;
}

function visibleRect(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
}

function mediaUsable(el) {
  if (!isMedia(el)) return false;
  const r = visibleRect(el);
  if (!r || !isContentSized(r.width, r.height)) return false;
  if (el.tagName === 'IMG' && el.complete && el.naturalWidth > 0 && el.naturalWidth < MIN_MEDIA_PX) return false;
  return true;
}

function allMediaIn(root) {
  const out = [];
  if (isMedia(root)) out.push(root);
  if (root.querySelectorAll) for (const el of root.querySelectorAll('video,img,canvas')) out.push(el);
  return out.filter(mediaUsable);
}

const area = (el) => {
  const r = el.getBoundingClientRect();
  return r.width * r.height;
};
const contains = (el, x, y) => {
  const r = el.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
};

/**
 * Walk up from `start` looking for media: the current subtree first (proximity 1000 - 100·level),
 * then — only when the current subtree had none — its siblings (500 - 100·level). Stops at the
 * first level that found anything. Among candidates: under-the-point beats not, then proximity,
 * then a <video> over an <img>, then the largest.
 */
export function findMediaInParentsAndSiblings(start, x, y) {
  const found = [];
  let cur = start;
  for (let level = 0; cur && cur.nodeType === 1 && level < MAX_SEARCH_LEVELS; level++, cur = cur.parentElement) {
    const here = allMediaIn(cur);
    for (const el of here) found.push({ el, score: 1000 - level * 100 });
    if (!here.length && cur.parentElement) {
      for (const sib of cur.parentElement.children) {
        if (sib === cur) continue;
        for (const el of allMediaIn(sib)) found.push({ el, score: 500 - level * 100 });
      }
    }
    if (found.length) break;
  }
  if (!found.length) return null;
  const hasPoint = Number.isFinite(x) && Number.isFinite(y);
  const rank = (c) =>
    (hasPoint && contains(c.el, x, y) ? 10000 : 0) + c.score + (c.el.tagName === 'VIDEO' ? 50 : 0);
  found.sort((a, b) => rank(b) - rank(a) || area(b.el) - area(a.el));
  return found[0].el;
}

/**
 * The real media element at viewport point (x, y), or null. Looks THROUGH overlays: the whole
 * hit-test stack is scanned (not just the topmost element), open shadow roots are entered, and a
 * hit inside a video player's chrome (YouTube's `.html5-video-player`, or any element whose
 * container holds exactly the video) resolves to that video.
 */
export function resolveMediaAt(x, y, doc = document) {
  const stack = typeof doc.elementsFromPoint === 'function' ? doc.elementsFromPoint(x, y) : [];
  const expanded = [];
  for (const el of stack) {
    if (el.shadowRoot && typeof el.shadowRoot.elementsFromPoint === 'function') {
      for (const inner of el.shadowRoot.elementsFromPoint(x, y)) if (inner !== el) expanded.push(inner);
    }
    expanded.push(el);
  }
  for (const el of expanded) if (mediaUsable(el) && contains(el, x, y)) return el;
  for (const el of expanded) {
    const player = el.closest && el.closest('.html5-video-player, [data-player], .video-js, .jwplayer, .plyr');
    if (player) {
      const v = player.querySelector('video');
      if (v && mediaUsable(v)) return v;
    }
  }
  return expanded.length ? findMediaInParentsAndSiblings(expanded[0], x, y) : null;
}

// ── fitting ──────────────────────────────────────────────────────────────────────────────────

function parsePos(token, fallback) {
  if (!token) return fallback;
  if (token === 'left' || token === 'top') return 0;
  if (token === 'right' || token === 'bottom') return 1;
  if (token === 'center') return 0.5;
  if (token.endsWith('%')) return parseFloat(token) / 100;
  return fallback; // px offsets: rare on media, treated as centred
}

/**
 * Where the media's pixels actually land inside its content box, per CSS object-fit /
 * object-position. Returns the VISIBLE displayed rect (`dx,dy,dw,dh`, CSS px relative to the
 * content box) and the part of the source it shows (`sx,sy,sw,sh`, source px). Pure.
 *
 * @param {string} fit  'fill' | 'contain' | 'cover' | 'none' | 'scale-down'
 * @param {string} [position='50% 50%']
 */
export function computeFit(fit, boxW, boxH, srcW, srcH, position = '50% 50%') {
  if (!(srcW > 0 && srcH > 0) || !(boxW > 0 && boxH > 0)) {
    return { dx: 0, dy: 0, dw: boxW, dh: boxH, sx: 0, sy: 0, sw: srcW || 0, sh: srcH || 0 };
  }
  if (fit === 'fill' || !fit) return { dx: 0, dy: 0, dw: boxW, dh: boxH, sx: 0, sy: 0, sw: srcW, sh: srcH };
  const contain = Math.min(boxW / srcW, boxH / srcH);
  let s;
  if (fit === 'contain') s = contain;
  else if (fit === 'cover') s = Math.max(boxW / srcW, boxH / srcH);
  else if (fit === 'none') s = 1;
  else if (fit === 'scale-down') s = Math.min(1, contain);
  else s = contain;
  const [t0, t1] = String(position).trim().split(/\s+/);
  const px = parsePos(t0, 0.5);
  const py = parsePos(t1 === undefined ? (t0 === 'top' || t0 === 'bottom' ? t0 : 'center') : t1, 0.5);
  const fx = t0 === 'top' || t0 === 'bottom' ? 0.5 : px;
  const rw = srcW * s,
    rh = srcH * s;
  const ox = (boxW - rw) * fx,
    oy = (boxH - rh) * py;
  const x0 = Math.max(0, ox),
    y0 = Math.max(0, oy);
  const x1 = Math.min(boxW, ox + rw),
    y1 = Math.min(boxH, oy + rh);
  return {
    dx: x0,
    dy: y0,
    dw: Math.max(0, x1 - x0),
    dh: Math.max(0, y1 - y0),
    sx: (x0 - ox) / s,
    sy: (y0 - oy) / s,
    sw: (x1 - x0) / s,
    sh: (y1 - y0) / s,
  };
}

/** Intrinsic size of the media, or 0×0 before it is known. */
export function mediaSize(el) {
  if (el.tagName === 'VIDEO') return { w: el.videoWidth || 0, h: el.videoHeight || 0 };
  if (el.tagName === 'IMG') return { w: el.naturalWidth || 0, h: el.naturalHeight || 0 };
  return { w: el.width || 0, h: el.height || 0 };
}

// ── layout-mode detection ───────────────────────────────────────────────────────────────────

/** Immersity Lens's layout analysis, reduced to the decision that matters here: where the host goes. */
export function detectLayout(el) {
  const cs = getComputedStyle(el);
  const complex =
    cs.position === 'absolute' ||
    cs.position === 'fixed' ||
    (cs.transform && cs.transform !== 'none') ||
    (parseInt(cs.zIndex, 10) || 0) > 100;
  if (complex) return { mode: 'overlay', container: el.parentElement, after: el };
  const pic = el.tagName === 'IMG' ? el.closest('picture') : null;
  if (pic && pic.parentElement) return { mode: 'picture', container: pic.parentElement, after: pic };
  // Padding-bottom aspect-ratio boxes, up to 3 levels (the element's height is 0/auto, the box's
  // padding carries the aspect). The host goes INSIDE the box so it clips/scrolls with it.
  let cur = el.parentElement;
  for (let i = 0; i < 3 && cur; i++, cur = cur.parentElement) {
    const p = getComputedStyle(cur);
    const pad = (parseFloat(p.paddingBottom) || 0) + (parseFloat(p.paddingTop) || 0);
    const zeroH = p.height === '0px' || parseFloat(p.height) === 0;
    const cls = typeof cur.className === 'string' ? cur.className : '';
    if ((pad > 0 && zeroH) || /aspect-ratio|ratio-box|ratio-frame|aspect-container/.test(cls)) {
      return { mode: 'aspectRatio', container: cur, after: null };
    }
  }
  return { mode: 'standard', container: el.parentElement, after: el };
}

function contentBox(el) {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const l = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
  const t = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0);
  const rr = (parseFloat(cs.borderRightWidth) || 0) + (parseFloat(cs.paddingRight) || 0);
  const b = (parseFloat(cs.borderBottomWidth) || 0) + (parseFloat(cs.paddingBottom) || 0);
  return { left: r.left + l, top: r.top + t, width: Math.max(0, r.width - l - rr), height: Math.max(0, r.height - t - b) };
}

/**
 * Float a canvas over `el`'s visible media pixels.
 *
 * @param {HTMLVideoElement|HTMLImageElement|HTMLCanvasElement} el
 * @returns {{
 *   host: HTMLElement, shadow: ShadowRoot, canvas: HTMLCanvasElement, layout: string,
 *   fit: ReturnType<typeof computeFit> & {boxW:number, boxH:number},
 *   update(): boolean,       // re-derive geometry; true when the canvas CSS box changed
 *   setInteractive(on: boolean): void,
 *   unmount(): void,
 * }}
 */
export function mountCanvas(el) {
  const layout = detectLayout(el);
  const host = document.createElement('div');
  host.setAttribute('data-inline3d-lift', layout.mode);
  const hs = host.style;
  hs.position = getComputedStyle(el).position === 'fixed' ? 'fixed' : 'absolute';
  hs.margin = '0';
  hs.padding = '0';
  hs.border = '0';
  hs.overflow = 'hidden';
  hs.pointerEvents = 'none';
  hs.boxSizing = 'content-box';
  hs.contain = 'layout style';
  const z = parseInt(getComputedStyle(el).zIndex, 10);
  hs.zIndex = String(Number.isFinite(z) ? z + 1 : 1);
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent =
    ':host{all:initial}' +
    'canvas{position:absolute;display:block;margin:0;padding:0;border:0;background:transparent;touch-action:none}';
  const canvas = document.createElement('canvas');
  shadow.append(style, canvas);

  const container = layout.container || el.parentElement || document.body;
  if (layout.after && layout.after.parentElement === container) layout.after.after(host);
  else container.appendChild(host);

  let last = '';
  const fit = { dx: 0, dy: 0, dw: 0, dh: 0, sx: 0, sy: 0, sw: 0, sh: 0, boxW: 0, boxH: 0 };

  function update() {
    if (!host.isConnected || !el.isConnected) return false;
    const box = contentBox(el);
    const cs = getComputedStyle(el);
    const { w, h } = mediaSize(el);
    // <canvas> ignores object-fit only when it has no intrinsic size; images/videos honour it.
    const f = computeFit(cs.objectFit, box.width, box.height, w, h, cs.objectPosition);
    // Position the host at the content box, in its containing block's coordinates.
    let left, top;
    if (hs.position === 'fixed') {
      left = box.left;
      top = box.top;
    } else {
      const op = host.offsetParent;
      if (op && op !== document.body && op !== document.documentElement) {
        const or = op.getBoundingClientRect();
        left = box.left - or.left - op.clientLeft + op.scrollLeft;
        top = box.top - or.top - op.clientTop + op.scrollTop;
      } else {
        left = box.left + window.scrollX;
        top = box.top + window.scrollY;
      }
    }
    const key = [left, top, box.width, box.height, f.dx, f.dy, f.dw, f.dh, f.sx, f.sy, f.sw, f.sh]
      .map((v) => Math.round(v * 100) / 100)
      .join(',');
    if (key === last) return false;
    last = key;
    hs.left = `${left}px`;
    hs.top = `${top}px`;
    hs.width = `${box.width}px`;
    hs.height = `${box.height}px`;
    canvas.style.left = `${f.dx}px`;
    canvas.style.top = `${f.dy}px`;
    canvas.style.width = `${f.dw}px`;
    canvas.style.height = `${f.dh}px`;
    Object.assign(fit, f, { boxW: box.width, boxH: box.height });
    return true;
  }

  update();
  // The source element is hidden (not display:none — it must keep decoding/laying out) while the
  // tile covers it: the DisplayXR Browser's inline-3D join otherwise falls back to the exact-cover
  // layer UNDER the canvas on frames where the canvas emits no quad and weaves the mono <video>
  // frame as SBS (displayxr-browser-pvt#168). visibility:hidden keeps playback, rVFC and
  // texImage2D uploads working.
  const prevVisibility = el.style.visibility;
  let sourceHidden = false;
  function setSourceHidden(hide) {
    if (hide === sourceHidden) return;
    sourceHidden = hide;
    el.style.visibility = hide ? 'hidden' : prevVisibility;
  }
  setSourceHidden(true);
  return {
    host,
    shadow,
    canvas,
    layout: layout.mode,
    fit,
    update,
    setInteractive(on) {
      canvas.style.pointerEvents = on ? 'auto' : 'none';
      canvas.style.cursor = on ? 'grab' : '';
      canvas.style.touchAction = on ? 'none' : ''; // a touch drag orbits, it does not scroll the page
    },
    setSourceHidden,
    unmount() {
      setSourceHidden(false);
      host.remove();
    },
  };
}
