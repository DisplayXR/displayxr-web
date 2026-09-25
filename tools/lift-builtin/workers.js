// workers.js — Worker capability probe + the main-thread fallbacks the built-in bundle needs.
//
// The built-in runs in the DisplayXR Browser's "Convert to 3D" isolated world, on ANY page. Two
// things there can make a Worker unusable, and neither throws where the SDK would catch it:
//   1. the page's CSP (`worker-src` / `child-src` / `script-src` fallback) blocks the blob: URL the
//      worker is created from — Chromium reports that as an async `error` event, not an exception;
//   2. the isolated world's CSP (`connect-src displayxr-lift: https:`) or the worker's inherited one
//      blocks `fetch('data:application/wasm…')`, which is how Spark's workers load their wasm —
//      the worker then dies in `__wbg_init` and every request to it hangs forever.
// So the built-in PROBES once, with a worker that does exactly what Spark's does (blob URL +
// data: wasm fetch + instantiate), and on anything but a clean reply within PROBE_MS switches every
// worker the bundle owns to an in-thread emulation:
//   - Spark's two worker kinds (the sort/decode pool and the legacy worker) → `mainThreadWorker()`
//     running the SAME worker code, compiled into the bundle as a function at build time
//     (build.mjs extracts it from Spark's string literal — no eval at runtime, the world's CSP has
//     no 'unsafe-eval');
//   - lift-gen's PLY emit worker → lift-gen's own in-thread path (`emitLiftSplats`).
// Everything here is worker-FREE when the probe fails; the cost is main-thread time (Spark's sort
// on orbit, the ~100–300 ms PLY emit), not correctness.

const PROBE_MS = 1500;

/** @type {{mode:'unknown'|'worker'|'main-thread', reason:string}} */
export const workerState = { mode: 'unknown', reason: '' };

let probeP = null;

/** Force a mode (tests / diagnostics). 'worker' | 'main-thread' | null (= probe). */
export function forceWorkerMode(mode) {
  probeP = null;
  if (mode) {
    workerState.mode = mode;
    workerState.reason = 'forced';
    probeP = Promise.resolve(workerState);
  } else {
    workerState.mode = 'unknown';
    workerState.reason = '';
  }
}

// An 8-byte empty module: `\0asm` + version 1.
const EMPTY_WASM_DATA_URL = 'data:application/wasm;base64,AGFzbQEAAAA=';
const PROBE_SRC =
  `fetch(${JSON.stringify(EMPTY_WASM_DATA_URL)}).then(r=>r.arrayBuffer()).then(b=>WebAssembly.instantiate(b))` +
  `.then(()=>postMessage('ok'),e=>postMessage('fail:'+(e&&e.message||e)));`;

/**
 * Resolve once: can this document run the bundle's workers (blob: worker + data: wasm fetch)?
 * @returns {Promise<{mode:'worker'|'main-thread', reason:string}>}
 */
export function probeWorkers() {
  if (probeP) return probeP;
  probeP = new Promise((resolve) => {
    const done = (mode, reason) => {
      if (workerState.mode !== 'unknown') return;
      workerState.mode = mode;
      workerState.reason = reason;
      resolve(workerState);
    };
    let w = null;
    let url = null;
    const timer = setTimeout(() => done('main-thread', 'probe timed out (worker blocked or never started)'), PROBE_MS);
    const finish = (mode, reason) => {
      clearTimeout(timer);
      try { w && w.terminate(); } catch { /* */ }
      try { url && URL.revokeObjectURL(url); } catch { /* */ }
      done(mode, reason);
    };
    try {
      if (typeof Worker !== 'function' || typeof Blob !== 'function') return finish('main-thread', 'no Worker/Blob');
      url = URL.createObjectURL(new Blob([PROBE_SRC], { type: 'text/javascript' }));
      w = new Worker(url);
      w.onmessage = (e) =>
        e.data === 'ok' ? finish('worker', 'blob worker + data: wasm ok') : finish('main-thread', String(e.data));
      w.onerror = (e) => {
        e.preventDefault?.();
        finish('main-thread', 'worker error: ' + ((e && e.message) || 'blocked (CSP?)'));
      };
    } catch (e) {
      finish('main-thread', 'Worker threw: ' + ((e && e.message) || e));
    }
  });
  return probeP;
}

/** True once the probe said workers work. Before the probe resolves: false (safe side). */
export function workersOk() {
  return workerState.mode === 'worker';
}

// ── data: URL fetch (Spark loads its wasm from a data: URL; the lift world's connect-src has no data:)
function decodeDataUrl(u) {
  const comma = u.indexOf(',');
  const head = u.slice(5, comma);
  const body = u.slice(comma + 1);
  const b64 = /;base64$/i.test(head);
  const type = head.replace(/;base64$/i, '').split(';')[0] || 'application/octet-stream';
  let bytes;
  if (b64) {
    const bin = atob(body);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(body));
  }
  return new Response(bytes, { headers: { 'content-type': type } });
}

/** `fetch` that answers data: URLs locally and delegates everything else. */
export function dataFetch(input, init) {
  const u = typeof input === 'string' ? input : input && (input.href || input.url);
  if (typeof u === 'string' && u.startsWith('data:')) return Promise.resolve(decodeDataUrl(u));
  return globalThis.fetch(input, init);
}

// ── In-thread Worker emulation ─────────────────────────────────────────────────────────────
function cloneMsg(data, transfer) {
  const t = Array.isArray(transfer) ? transfer : transfer && transfer.transfer;
  try {
    return structuredClone(data, t && t.length ? { transfer: t } : undefined);
  } catch {
    return data; // not cloneable (should not happen for Spark's messages): hand it over as-is
  }
}

/**
 * A Worker-shaped object that runs `main(self)` on THIS thread. `main` is the worker's source
 * compiled as a function whose `self` is the fake worker global. Messages are structured-cloned
 * (with transfer, so buffers detach exactly as they would across a real worker boundary) and
 * delivered from a macrotask, so ordering and re-entrancy match a real worker.
 */
export function mainThreadWorker(main, options) {
  const inner = new Set(); // worker-side 'message' listeners
  const outer = new Map(); // page-side listeners by type
  let dead = false;
  const post = (fn) => setTimeout(() => { if (!dead) fn(); }, 0);

  const workerSelf = {
    name: (options && options.name) || '',
    location: { href: 'displayxr-lift://runtime/worker', toString() { return this.href; } },
    onmessage: null,
    addEventListener(type, fn) { if (type === 'message') inner.add(fn); },
    removeEventListener(type, fn) { if (type === 'message') inner.delete(fn); },
    postMessage(data, transfer) {
      const d = cloneMsg(data, transfer);
      post(() => emitOuter('message', { data: d }));
    },
    close() { dead = true; },
  };
  workerSelf.self = workerSelf;

  function emitOuter(type, ev) {
    const w = worker;
    const h = w['on' + type];
    try { if (typeof h === 'function') h.call(w, ev); } catch (e) { console.error(e); }
    for (const fn of outer.get(type) || []) {
      try { fn.call(w, ev); } catch (e) { console.error(e); }
    }
  }

  const worker = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(data, transfer) {
      const d = cloneMsg(data, transfer);
      post(() => {
        const ev = { data: d };
        try {
          if (typeof workerSelf.onmessage === 'function') workerSelf.onmessage(ev);
          for (const fn of inner) fn(ev);
        } catch (e) {
          emitOuter('error', { message: String((e && e.message) || e), error: e, preventDefault() {} });
        }
      });
    },
    addEventListener(type, fn) {
      if (!outer.has(type)) outer.set(type, new Set());
      outer.get(type).add(fn);
    },
    removeEventListener(type, fn) { outer.get(type)?.delete(fn); },
    terminate() { dead = true; inner.clear(); outer.clear(); },
    __dxrMainThread: true,
  };

  try {
    main(workerSelf);
  } catch (e) {
    post(() => emitOuter('error', { message: String((e && e.message) || e), error: e, preventDefault() {} }));
  }
  return worker;
}
