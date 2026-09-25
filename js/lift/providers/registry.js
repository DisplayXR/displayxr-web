// registry.js — pluggable depth providers and inpainters.
//
// Nothing in the lift path hard-codes ONNX Runtime: it asks this registry for the best provider.
// The ORT/WebGPU depth provider and inpainter register themselves at priority 0 when their modules
// load; a native provider (the DisplayXR Browser's Phase B on-device depth) or a vendor provider
// registers at a higher priority and wins automatically, without the page changing.
//
// Lookup by name accepts either a REGISTERED provider name ('ort', 'native', …) or a MODEL name —
// a manifest family ('vda-small' | 'moge3' | 'da3' | 'da2-small' | 'light-inpaint-v1') or a
// concrete manifest entry — which is handed to the best provider as `opts.model`.
//
// The registry is a process-wide singleton keyed on a global Symbol, so two copies of the SDK on
// one page (a CDN import plus a bundled one) still share it.

const KEY = Symbol.for('displayxr.inline3d.lift.registry');

/** Family → kind, for name lookups that arrive without `kind`. Mirrors depth-ort.js MODEL_KINDS. */
const FAMILY_KIND = { 'vda-small': 'video', moge3: 'still', da3: 'still', 'da2-small': 'still' };
const kindOf = (name) => FAMILY_KIND[name] || (/^vda/.test(name || '') ? 'video' : 'still');

function createPool(what) {
  /** @type {{name:string, factory:Function, priority:number, kinds:string[], available?:Function, seq:number}[]} */
  const entries = [];
  let seq = 0;
  return {
    register(name, factory, o = {}) {
      if (typeof name !== 'string' || !name) throw new Error(`register${what}: name required`);
      if (typeof factory !== 'function') throw new Error(`register${what}: factory must be a function`);
      const i = entries.findIndex((e) => e.name === name);
      if (i >= 0) entries.splice(i, 1);
      const e = {
        name, factory,
        priority: Number.isFinite(o.priority) ? o.priority : 0,
        kinds: o.kinds || ['video', 'still'],
        available: o.available,
        seq: seq++,
      };
      entries.push(e);
      return () => { const j = entries.indexOf(e); if (j >= 0) entries.splice(j, 1); };
    },
    find(name) { return entries.find((e) => e.name === name) || null; },
    resolve(kind, prefer) {
      const ok = (e) => (!kind || e.kinds.includes(kind)) && (!e.available || safe(e.available));
      if (prefer) {
        const p = entries.find((e) => e.name === prefer);
        if (p && ok(p)) return pick(p);
      }
      let best = null;
      for (const e of entries) {
        if (!ok(e)) continue;
        if (!best || e.priority > best.priority || (e.priority === best.priority && e.seq > best.seq)) best = e;
      }
      return best && pick(best);
    },
    list() {
      return entries.slice().sort((a, b) => b.priority - a.priority || b.seq - a.seq)
        .map((e) => ({ name: e.name, priority: e.priority, kinds: e.kinds.slice() }));
    },
  };
}

function createRegistry() {
  const depth = createPool('DepthProvider');
  const inpaint = createPool('Inpainter');
  return {
    /**
     * Register (or replace, by name) a depth provider factory. `factory(opts) → DepthProvider`
     * receives the createDepthProvider options ({ kind, modelSource, ort, quality, model }).
     * @param {string} name
     * @param {Function} factory
     * @param {{priority?:number, kinds?:string[], available?:() => boolean}} [o]
     * @returns {() => void} unregister
     */
    registerDepthProvider: depth.register,

    /** Register an inpainter factory: `factory({ modelSource, ort, quality, model }) → Inpainter`. */
    registerInpainter: (name, factory, o = {}) => inpaint.register(name, factory, { ...o, kinds: ['inpaint'] }),

    /**
     * Best depth provider for `kind`. `prefer` (a registered name) wins when it supports the kind
     * and is available; otherwise the highest priority, latest-registered on ties.
     * @returns {{name:string, factory:Function, priority:number} | null}
     */
    resolve: depth.resolve,

    /**
     * Instantiate a depth provider by name: a registered provider name, or a model / family name
     * (→ the best provider for that model's kind, with `model: name`). Returns a DepthProvider.
     */
    getDepthProvider(name, opts = {}) {
      const reg = name && depth.find(name);
      if (reg) return reg.factory({ ...opts, kind: opts.kind || kindOf(opts.model) });
      const kind = opts.kind || kindOf(name || opts.model);
      const e = depth.resolve(kind, opts.provider);
      if (!e) throw new Error(`lift: no depth provider registered for kind ${JSON.stringify(kind)}`);
      return e.factory({ ...opts, kind, model: name || opts.model });
    },

    /** Instantiate an inpainter by registered name, or by model/family name (null → default). */
    getInpainter(name, opts = {}) {
      const reg = name && inpaint.find(name);
      const e = reg ? { factory: reg.factory } : inpaint.resolve('inpaint', opts.provider);
      if (!e) throw new Error('lift: no inpainter registered');
      return e.factory(reg ? opts : { ...opts, model: name || opts.model });
    },

    /** Registered depth provider entry by name (diagnostics / A1 fallback path). */
    get(name) { const e = depth.find(name); return e && pick(e); },

    /** Snapshot of registrations, highest priority first. */
    list() { return depth.list(); },
    listInpainters() { return inpaint.list(); },
  };
}

function safe(fn) { try { return !!fn(); } catch { return false; } }
function pick(e) { return { name: e.name, factory: e.factory, priority: e.priority }; }

/** The shared registry. */
export function getRegistry() {
  return globalThis[KEY] || (globalThis[KEY] = createRegistry());
}
