// inline3d-undock.js — lift a window's 3D asset OUT of the page into a floating, transparent,
// click-through native viewer over the desktop. Dependency-free, and usable on its own.
//
// TWO PATHS, ONE CONTRACT. Where the browser exposes `XRDisplayLayer.undock()` the request goes
// straight through it: the layer already knows its element's rect, and the viewer opens with no
// prompt. Everywhere else the page spawns the same viewer through the `displayxr-view:` OS
// protocol — the spawn primitive every browser hands a page (Chrome asks once, "Open DisplayXR
// …?", with an "Always allow" tick). The URL grammar below is the contract both paths share, and
// it is the one parsed by displayxr-common's `launch_args.h`.
//
// WHY A NATIVE PROCESS AND NOT A WINDOW. The browser's inline-3D weave is bound to ONE window per
// process and hands back opaque pixels into the page's own compositing, so no browser window can
// be the transparent floating one. The floating window is a native process; the page's only job
// is to spawn it with the asset URL and the tile's screen rect.
//
// NOTHING HERE TOUCHES THE TILE. Undock READS an element's rect and never writes to it, so it
// cannot disturb a woven window — the button that calls it lives in the page's own chrome.

/** @typedef {'model'|'splat'} UndockType */

/**
 * How the API-first path finds the live `XRDisplayLayer` behind an element. `inline3d.js`
 * registers one when it is imported (only it knows the canvas -> layer map); with no resolver —
 * this module used standalone — every call takes the protocol fallback, which is the correct
 * degradation rather than a failure.
 *
 * @param {(el: Element) => object|null} fn
 */
let layerResolver = null;
export function setUndockLayerResolver(fn) {
  layerResolver = typeof fn === 'function' ? fn : null;
}

/**
 * True where a native DisplayXR viewer can exist at all. The viewers are Windows-only today, so
 * this is a PLATFORM probe, not a capability one — a page uses it to decide whether to show an
 * undock affordance. It says nothing about whether the viewer is installed: that is only knowable
 * when the launch is attempted (a `not-installed` Error on the API path; silently nothing on the
 * protocol path, which is exactly why the API path is worth having).
 */
export function undockAvailable() {
  if (typeof navigator === 'undefined') return false;
  const uad = navigator.userAgentData;
  if (uad && uad.platform) return uad.platform === 'Windows';
  return /Windows/i.test(navigator.userAgent);
}

/**
 * The element's rect in PHYSICAL SCREEN pixels — the space the viewer places its window in.
 *
 * `screenX/Y` and `outerWidth/Height` are CSS px in the browser's own DIP space; `devicePixelRatio`
 * folds the OS scale AND the page zoom together. At 100 % zoom the arithmetic is exact; with page
 * zoom it drifts by the zoom factor, and the viewer clamps the rect into the panel anyway. `dpr`
 * travels along so a calibration session can read both numbers from the viewer's log instead of
 * reverse-engineering the DIP space.
 *
 * @param {Element} el
 * @returns {{x:number, y:number, w:number, h:number, dpr:number}}
 */
export function tileScreenRect(el) {
  const r = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const chromeX = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
  const chromeY = Math.max(0, window.outerHeight - window.innerHeight);
  return {
    x: Math.round((window.screenX + chromeX + r.left) * dpr),
    y: Math.round((window.screenY + chromeY + r.top) * dpr),
    w: Math.max(64, Math.round(r.width * dpr)),
    h: Math.max(64, Math.round(r.height * dpr)),
    dpr,
  };
}

/**
 * The `displayxr-view:` URL for undocking `opts` at `el`'s screen rect — the fallback path's
 * whole payload, exported so a page can log or test it without launching anything.
 *
 *   displayxr-view://open?src=<pct>&type=model|splat&rect=X,Y,W,H&dpr=<f>&title=<pct>
 *                        &env=room&pose=<yaw>,<pitch>&margin=<f>&transparent=1&v=1
 *
 * `src` is resolved to an ABSOLUTE url here and must be https (or http on loopback): the viewer
 * refuses file:/UNC/local paths from a protocol launch by design.
 *
 * NO `vh`. The grammar has one, and sending it is wrong: it is a raw pin that DISABLES the
 * viewer's auto-fit, so an asset authored at 0.2 m arrives at native scale in a small window (far
 * too zoomed in). Left unpinned the viewer auto-fits to ~80 % of the window height — the same
 * rule a page's own fit applies to the same pixel box — so the apparent size matches. Apparent
 * size is a property of the window rect, not of vH.
 *
 * @param {Element} el
 * @param {object} opts  {src, type, env?, pose?, margin?, title?}
 * @returns {string}
 */
export function undockUrl(el, opts) {
  const src = new URL(opts.src, window.location.href).href;
  const rect = tileScreenRect(el);
  const pairs = [];
  const put = (k, v) => pairs.push(`${k}=${encodeURIComponent(v)}`);
  put('src', src);
  put('type', opts.type);
  put('rect', `${rect.x},${rect.y},${rect.w},${rect.h}`);
  put('dpr', rect.dpr.toFixed(3));
  if (opts.title) put('title', String(opts.title).slice(0, 64));
  if (opts.env) put('env', opts.env);
  // The page's opening angle: a model seen at yaw -40 has a very different silhouette from the
  // same model face-on, and "it looks bigger undocked" is usually exactly that (the fit rules
  // agree; the pose did not). Same convention as the SDK's setPose({yaw, pitch, zoom}).
  if (opts.pose) {
    const z = opts.pose.zoom !== undefined && opts.pose.zoom !== 1 ? `,${opts.pose.zoom}` : '';
    put('pose', `${opts.pose.yaw},${opts.pose.pitch ?? 0}${z}`);
  }
  if (opts.margin !== undefined) put('margin', String(opts.margin));
  // Transparent is the protocol's default; stated explicitly so the intent is visible in the URL.
  put('transparent', '1');
  put('v', '1');
  // Built by hand rather than with URLSearchParams, which encodes a space as '+' — a form the
  // viewer deliberately does NOT decode. encodeURIComponent is the spec form and never emits '+'.
  return `displayxr-view://open?${pairs.join('&')}`;
}

/**
 * Fire the protocol from a user gesture. A hidden iframe rather than `location.href`: the page
 * never unloads mid-demo, and a "no handler installed" outcome is contained in the frame — which
 * is also why this path can never REPORT that outcome. Chrome only shows the external-protocol
 * dialog under a transient user activation, so it has to run synchronously in the click.
 */
function launchProtocol(url) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.display = 'none';
  frame.src = url;
  document.body.appendChild(frame);
  window.setTimeout(() => frame.remove(), 1500);
}

const UNDOCK_ERRORS = ['not-installed', 'src-not-allowed', 'no-activation', 'busy'];

/** Give a rejection one of the four contract names, keeping the browser's own where it has one. */
function undockError(e, fallbackName, message) {
  const name = e && UNDOCK_ERRORS.includes(e.name) ? e.name : fallbackName;
  const err = new Error(message || (e && e.message) || `[inline3d] undock failed (${name}).`);
  err.name = name;
  if (e) err.cause = e;
  return err;
}

// ONE LIVE UNDOCK AT A TIME. The viewer is a single floating window and the browser refuses a
// second request while one is in flight ('busy'); the fallback path has no such guard, so the
// module keeps its own — two protocol launches from one click would spawn two viewers.
let inFlight = false;

/**
 * Undock `target`'s asset into the floating native viewer.
 *
 * CALL IT SYNCHRONOUSLY INSIDE THE CLICK. Both paths need the transient user activation — the
 * API path to be allowed at all (`no-activation`), the fallback to get Chrome's protocol dialog —
 * and an `await` before this call spends it. Nothing here awaits before the launch, so the
 * activation is intact when it matters.
 *
 * @param {Element} target  the element whose SCREEN RECT the viewer opens over (the tile).
 * @param {object} opts
 * @param {string} opts.src   absolute https URL (or http on loopback) of the asset.
 * @param {UndockType} opts.type
 * @param {'room'|'studio'|'sky'|'none'} [opts.env]  lighting the page rendered with.
 * @param {{yaw:number, pitch?:number, zoom?:number}} [opts.pose]  the angle the page opened at.
 * @param {number} [opts.margin]  the page's fit margin, when it overrides the default.
 * @param {string} [opts.title]
 * @returns {Promise<{ended:Promise<void>, viewer:UndockType, detached?:boolean}>}
 *   `ended` resolves when the viewer exits (fallback path: immediately, with
 *   `detached === true` — a protocol launch is fire-and-forget and the page never hears back).
 *   Rejects with an Error named `not-installed` | `src-not-allowed` | `no-activation` | `busy`.
 */
export function undock(target, opts) {
  if (!target || typeof target.getBoundingClientRect !== 'function') {
    return Promise.reject(new TypeError('[inline3d] undock() takes an Element and options.'));
  }
  if (!opts || typeof opts.src !== 'string' || !opts.src) {
    return Promise.reject(new TypeError('[inline3d] undock() needs opts.src (an absolute URL).'));
  }
  if (opts.type !== 'model' && opts.type !== 'splat') {
    return Promise.reject(
      new TypeError(`[inline3d] undock() opts.type is 'model' or 'splat', got ${JSON.stringify(opts.type)}.`)
    );
  }
  if (inFlight) return Promise.reject(undockError(null, 'busy', '[inline3d] an undock is already in flight.'));

  const layer = layerResolver ? layerResolver(target) : null;
  const viewer = opts.type;

  // ── fallback: the OS protocol ──────────────────────────────────────────────────────────
  if (!layer || typeof layer.undock !== 'function') {
    let url;
    try {
      url = undockUrl(target, opts);
    } catch (e) {
      return Promise.reject(undockError(e, 'src-not-allowed'));
    }
    launchProtocol(url);
    // Fire-and-forget by construction: the iframe swallows "no handler installed" and nothing
    // comes back from a spawned process, so `ended` is honest only about THIS page's part being
    // over. `detached` is how a caller tells the two paths apart.
    return Promise.resolve({ ended: Promise.resolve(), viewer, detached: true, url });
  }

  // ── API path ───────────────────────────────────────────────────────────────────────────
  // Synchronous, first thing, activation intact. The layer knows its own element rect, so only
  // the content half of the contract travels.
  const init = { src: opts.src, type: opts.type };
  if (opts.env) init.env = opts.env;
  if (opts.pose) init.pose = opts.pose;
  if (opts.margin !== undefined) init.margin = opts.margin;
  if (opts.title) init.title = opts.title;

  let call;
  try {
    call = Promise.resolve(layer.undock(init));
  } catch (e) {
    // A synchronous throw is the same failure as a rejection; one .catch() should cover both.
    return Promise.reject(undockError(e, 'src-not-allowed'));
  }
  inFlight = true;
  const settled = call.finally(() => {
    inFlight = false;
  });

  // TWO PROMISE SHAPES, ONE ANSWER. `undock()` either rejects PROMPTLY — every refusal
  // (not-installed / src-not-allowed / no-activation / busy) is decided before any window
  // exists — or it stays pending until the viewer exits. A short race tells them apart without
  // inventing an event: whatever has not rejected by then launched. The launch has already
  // happened synchronously above, so this wait costs the user nothing.
  const LAUNCH_MS = 150;
  const launchProbe = settled.then(
    () => 'launched',
    (e) => {
      throw undockError(e, 'not-installed');
    }
  );
  // The probe LOSES the race whenever the viewer stays open, and a rejection arriving after that
  // would otherwise be an unhandled one. Marked handled here; the same rejection still reaches
  // the caller through `ended`, which is where a late failure belongs.
  launchProbe.catch(() => {});
  return Promise.race([
    launchProbe,
    new Promise((resolve) => window.setTimeout(() => resolve('launched'), LAUNCH_MS)),
  ]).then(() => ({
    // A rejection AFTER the launch window is the viewer failing later, and it belongs on `ended`.
    ended: settled.then(() => undefined),
    viewer,
    detached: false,
  }));
}
