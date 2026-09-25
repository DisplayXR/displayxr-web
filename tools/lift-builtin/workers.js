// workers.js — Worker capability probe + the main-thread fallback the built-in bundle needs.
//
// The built-in runs in the DisplayXR Browser's "Convert to 3D" isolated world, on ANY page. The
// page's CSP (`worker-src` / `child-src` / `script-src` fallback) can block the blob: URL a worker
// is created from — Chromium reports that as an async `error` event, not an exception the SDK
// would catch. So the built-in PROBES once, with a blob: worker that just answers, and on anything
// but a clean reply within PROBE_MS switches every worker the bundle owns to an in-thread
// emulation:
//   - PlayCanvas's gsplat SORT worker (the explore renderer's one worker) → `mainThreadWorker()`
//     running the SAME function, passed in at build time (build.mjs transformPcSorter — no eval,
//     the world's CSP has no 'unsafe-eval');
//   - lift-gen's PLY emit worker → lift-gen's own in-thread path (`emitLiftSplats`).
// Everything here is worker-FREE when the probe fails; the cost is main-thread time (the sort on
// orbit, the ~100–300 ms PLY emit), not correctness.
//
// (Until 2026-09 the explore renderer was Spark, whose workers also fetched their wasm from data:
// URLs; the probe tested that too and this file answered data: fetches locally. PlayCanvas's sort
// worker is plain JS, so both are gone.)

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

const PROBE_SRC = `postMessage('ok');`;

/**
 * Resolve once: can this document run the bundle's workers (a blob: worker)?
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
        e.data === 'ok' ? finish('worker', 'blob worker ok') : finish('main-thread', String(e.data));
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

// ── In-thread Worker emulation ─────────────────────────────────────────────────────────────
function cloneMsg(data, transfer) {
  const t = Array.isArray(transfer) ? transfer : transfer && transfer.transfer;
  try {
    return structuredClone(data, t && t.length ? { transfer: t } : undefined);
  } catch {
    return data; // not cloneable (should not happen for the sorter's messages): hand it over as-is
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
