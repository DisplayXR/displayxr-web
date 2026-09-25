// inline3d-splat-diag.js — transition diagnostics for the PlayCanvas splat handle (#36).
//
// Internal. Used by ./inline3d-splat-playcanvas.js only. Off unless the page asks for it:
// `addSplat(..., { engine: 'playcanvas', diag: true })`, or `?dxrdiag=1` on the page URL.
//
// WHY. "Head tracking stops for a moment at every photo transition" has four candidate causes
// that look identical on the panel, and only one of them is visible from a headless browser:
//   - a MAIN-THREAD stall: the page misses session frames, so nothing new is drawn. Shows here as
//     a gap in the session-frame intervals (and in the window rAF), usually with a long task.
//   - a TRACKING hold: frames keep coming, but the eye poses in them do not move. The browser
//     keeps the last good views when a locate reply comes back empty, and reuses the previous
//     reply while its UI thread is busy. Shows here as frames whose XRView transforms are
//     BIT-IDENTICAL to the previous frame's (a live eye tracker never repeats itself exactly).
//   - a FROZEN IMAGE: frames come, poses move, but what is on screen is a still capture (the
//     crossfade's frozen bridge, shown until the live outgoing camera has sorted). Shows here as
//     frames where the transition overlay samples the frozen capture at a high weight.
//   - a RIG change applied late or badly: every setViewRig push is logged with its values, so a
//     pose jump or a hold can be lined up against the rig it followed.
// Each frame of the session is recorded with all four, so one run on the panel says which.
//
// KILL SWITCHES, for A/B on the panel (comma-separated, in `diag` or in `?dxrdiag=`):
//   norig    — the rig declared before the first setSource stays declared; every later
//              re-declaration is DROPPED (logged as dropped). Tests "the rig change freezes it".
//   frozen   — force `outgoing: 'frozen'` (the 1.12.1 frozen outgoing photo) on every setSource.
//   nowarm   — skip the transition shader pre-warm (prepareSource / setSource compile nothing).
//   cold     — skip the live outgoing PRE-SORT (the 1.19.2 behaviour: the frozen capture bridges
//              until a fresh manager has sorted).
//   nooverlay — record + console + window.__dxrDiag, but no on-screen overlay.

/** The switches `diag` / `?dxrdiag` understand, besides the plain on values. */
export const DIAG_SWITCHES = Object.freeze(['norig', 'frozen', 'nowarm', 'cold', 'nooverlay']);
const ON_TOKENS = new Set(['1', 'on', 'true', 'yes']);

/**
 * `diag` option (true | string | string[]) and/or the page query, into { on, switches }.
 * The option wins when it is given (false turns diag off even with `?dxrdiag` on the URL).
 * Unknown tokens are returned in `unknown` (warned once by the caller), never thrown on: a
 * diagnostic flag must not be able to break a page.
 */
export function resolveDiag(opt, search = pageSearch()) {
  let raw = null;
  if (opt === false) return { on: false, switches: new Set(), unknown: [] };
  if (opt === true) raw = '1';
  else if (typeof opt === 'string') raw = opt;
  else if (Array.isArray(opt)) raw = opt.join(',');
  else if (opt === undefined || opt === null) raw = queryValue(search);
  if (raw === null) return { on: false, switches: new Set(), unknown: [] };
  const switches = new Set();
  const unknown = [];
  for (const tok of String(raw).split(/[,\s+]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (ON_TOKENS.has(tok)) continue;
    if (tok === '0' || tok === 'off' || tok === 'false') return { on: false, switches: new Set(), unknown: [] };
    if (DIAG_SWITCHES.includes(tok)) switches.add(tok);
    else unknown.push(tok);
  }
  return { on: true, switches, unknown };
}

function pageSearch() {
  try {
    return typeof location !== 'undefined' && typeof location.search === 'string' ? location.search : '';
  } catch {
    return '';
  }
}

/** `?dxrdiag=...` (every occurrence, joined), or null when absent. `?dxrdiag` alone = on. */
function queryValue(search) {
  if (!search) return null;
  let q;
  try {
    q = new URLSearchParams(search);
  } catch {
    return null;
  }
  if (!q.has('dxrdiag')) return null;
  const all = q.getAll('dxrdiag').map((v) => v || '1');
  return all.join(',');
}

/**
 * One frame's eye-pose metrics against the previous frame's views.
 *   held   — every view's transform AND projection bit-identical to the previous frame (a hold:
 *            a live tracker never repeats itself to the last bit).
 *   delta  — the largest eye-position move, in the views' world units.
 *   ipd    — the eye separation this frame, same units (it scales with the rig).
 *   rel    — delta / ipd: head motion in eye separations, comparable across rigs.
 * `prev` is the previous frame's packed state (or null); returns { m, state }, `state` being
 * this frame's packed copy for the next call.
 */
export function poseDelta(views, prev) {
  const n = views ? views.length : 0;
  const state = new Float64Array(n * 32);
  for (let i = 0; i < n; i++) {
    const t = views[i]?.transform?.matrix;
    const p = views[i]?.projectionMatrix;
    for (let k = 0; k < 16; k++) {
      state[i * 32 + k] = t ? t[k] : NaN;
      state[i * 32 + 16 + k] = p ? p[k] : NaN;
    }
  }
  const m = { views: n, held: false, delta: NaN, ipd: NaN, rel: NaN };
  if (n >= 2) {
    const dx = state[12] - state[32 + 12];
    const dy = state[13] - state[32 + 13];
    const dz = state[14] - state[32 + 14];
    m.ipd = Math.hypot(dx, dy, dz);
  }
  if (prev && prev.length === state.length && n > 0) {
    let same = true;
    for (let k = 0; k < state.length; k++) {
      if (!Object.is(state[k], prev[k])) {
        same = false;
        break;
      }
    }
    m.held = same;
    let d = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 32;
      d = Math.max(d, Math.hypot(state[o + 12] - prev[o + 12], state[o + 13] - prev[o + 13], state[o + 14] - prev[o + 14]));
    }
    m.delta = d;
    m.rel = m.ipd > 0 ? d / m.ipd : NaN;
  }
  return { m, state };
}

/** A view rig descriptor, summarised for the log (numbers rounded; nothing else kept). */
export function summarizeRig(rig) {
  if (!rig || typeof rig !== 'object') return { type: rig === null ? 'none' : typeof rig };
  const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : x);
  const out = {};
  const walk = (o, prefix, depth) => {
    for (const [k, v] of Object.entries(o)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'number') out[key] = r4(v);
      else if (typeof v === 'string' || typeof v === 'boolean') out[key] = v;
      else if (v && typeof v === 'object' && depth < 2 && !ArrayBuffer.isView(v)) walk(v, key, depth + 1);
    }
  };
  walk(rig, '', 0);
  return out;
}

/** Phase names, in order: prepare (prepareSource), swap (setSource → adopt), window, settle. */
export const DIAG_PHASES = Object.freeze(['idle', 'prepare', 'swap', 'window', 'settle']);

const FRAME_CAP = 1800; // ~30 s at 60 Hz
const EVENT_CAP = 600;
const SETTLE_MS = 1000; // a transition's summary covers its window + this much after it
const PRE_MS = 300; // ... and this much before the setSource call

/**
 * The recorder. `now` is injectable (tests); everything else is plain data, so the recorder runs
 * (and is tested) without a DOM. The overlay (attachOverlay) is optional on top.
 */
export class DiagRecorder {
  constructor({ switches = new Set(), now = () => performance.now(), log = defaultLog, label = 'splat' } = {}) {
    this.switches = switches;
    this.now = now;
    this.log = log;
    this.label = label;
    this.frames = [];
    this.events = [];
    this.transitions = [];
    this.phase = 'idle';
    this.phaseAt = 0;
    this.callAt = NaN; // the current / last setSource call
    this._prevState = null;
    this._lastFrameAt = NaN;
    this._lastRafAt = NaN;
    this._rigAt = -Infinity;
    this._rigFrame = -Infinity;
    this._frameNo = 0;
    this._open = null; // the transition being recorded
    this.imageState = null; // () => { overlay: 'none' | 'frozen' | 'live', w }
    this.longTasks = [];
    this._lto = null;
    this.rigLocked = null; // norig: the summary of the rig kept
    this._listeners = new Set();
  }

  has(sw) {
    return this.switches.has(sw);
  }

  /** Observe long tasks (where the browser has the API). */
  observeLongTasks() {
    try {
      if (typeof PerformanceObserver !== 'function') return;
      this._lto = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) this.longTask(e.startTime, e.duration);
      });
      this._lto.observe({ type: 'longtask', buffered: false });
    } catch {
      this._lto = null;
    }
  }

  longTask(start, duration) {
    const lt = { s: round1(start), d: round1(duration) };
    this.longTasks.push(lt);
    if (this.longTasks.length > EVENT_CAP) this.longTasks.splice(0, this.longTasks.length - EVENT_CAP);
    this._event('longtask', lt, start);
  }

  /** A window rAF tick (the diag's own loop): main-thread cadence independent of the session. */
  raf(t = this.now()) {
    const gap = Number.isFinite(this._lastRafAt) ? t - this._lastRafAt : NaN;
    this._lastRafAt = t;
    if (this._open && Number.isFinite(gap)) this._open.maxRafGap = Math.max(this._open.maxRafGap, gap);
    return gap;
  }

  /** One session frame (the woven path's onFrame), BEFORE the draw. */
  frame(views, t = this.now()) {
    const { m, state } = poseDelta(views, this._prevState);
    this._prevState = state;
    const dt = Number.isFinite(this._lastFrameAt) ? t - this._lastFrameAt : NaN;
    this._lastFrameAt = t;
    this._frameNo++;
    const img = this.imageState ? safe(this.imageState) : null;
    const f = {
      n: this._frameNo,
      t: round1(t),
      dt: round1(dt),
      phase: this.phase,
      sinceCall: Number.isFinite(this.callAt) ? round1(t - this.callAt) : null,
      views: m.views,
      held: m.held,
      delta: round6(m.delta),
      rel: round4(m.rel),
      ipd: round6(m.ipd),
      // A rig push in the last 3 frames: a pose jump here is the rig, not the head.
      afterRig: this._frameNo - this._rigFrame <= 3,
      img: img ? img.overlay : 'none',
      imgW: img ? round4(img.w) : 0,
    };
    this.frames.push(f);
    if (this.frames.length > FRAME_CAP) this.frames.splice(0, this.frames.length - FRAME_CAP);
    if (this._open) this._accumulate(this._open, f);
    this._maybeClose(t);
    this._emit();
    return f;
  }

  /** A setViewRig push (or, under `norig`, a dropped one). */
  rig(rig, { dropped = false } = {}) {
    const t = this.now();
    const s = summarizeRig(rig);
    // controls:'page' re-declares every frame: only a CHANGED rig is an event.
    const key = (dropped ? 'd' : 'p') + JSON.stringify(s);
    if (key === this._lastRigKey) {
      this.rigRepeats = (this.rigRepeats || 0) + 1;
      return null;
    }
    this._lastRigKey = key;
    this._rigAt = t;
    if (!dropped) this._rigFrame = this._frameNo;
    const ev = this._event(dropped ? 'rig-dropped' : 'rig', { rig: s }, t);
    if (this._open) this._open.rigs.push({ at: round1(t - this._open.callAt), dropped, rig: s });
    this.log(`${dropped ? 'rig DROPPED (norig)' : 'rig'} ${fmtT(this, t)} ${JSON.stringify(s)}`);
    return ev;
  }

  /** Enter a phase ('prepare', 'swap', 'window', 'settle', 'idle'); `detail` is logged with it. */
  setPhase(phase, detail) {
    const t = this.now();
    if (phase === 'swap') this._openTransition(t, detail);
    this.phase = phase;
    this.phaseAt = t;
    if (this._open) this._open.phases.push({ phase, at: round1(t - this._open.callAt), ...(detail ? { detail } : {}) });
    this._event('phase', { phase, ...(detail ? { detail } : {}) }, t);
    this.log(`phase ${phase} ${fmtT(this, t)}${detail ? ' ' + JSON.stringify(detail) : ''}`);
    if (phase === 'settle' && this._open) this._open.settleAt = t;
  }

  /** A named instant inside the current transition (e.g. 'presorted', 'live-shown'). */
  mark(name, detail) {
    const t = this.now();
    if (this._open) this._open.marks.push({ name, at: round1(t - this._open.callAt), ...(detail ? { detail } : {}) });
    this._event('mark', { name, ...(detail ? { detail } : {}) }, t);
    this.log(`mark ${name} ${fmtT(this, t)}${detail ? ' ' + JSON.stringify(detail) : ''}`);
  }

  _openTransition(t, detail) {
    if (this._open) this._close(this._open, t, 'superseded');
    this.callAt = t;
    this._open = {
      id: this.transitions.length + 1,
      callAt: t,
      detail: detail || null,
      settleAt: NaN,
      phases: [],
      marks: [],
      rigs: [],
      frames: 0,
      maxFrameGap: 0,
      maxRafGap: 0,
      held: 0,
      heldRun: 0,
      heldRunMax: 0,
      heldRunMaxMs: 0,
      _heldRunStart: NaN,
      frozenImg: 0,
      frozenImgMs: 0,
      _lastT: NaN,
      firstFrameAt: NaN,
      lastFrameAt: NaN,
      window: [], // the frame records kept for the frozen overlay strip
    };
    // Frames already recorded in the lead-in (PRE_MS before the call) belong to it too.
    for (const f of this.frames) if (f.t >= t - PRE_MS) this._open.window.push(f);
  }

  _accumulate(o, f) {
    o.frames++;
    o.window.push(f);
    if (!Number.isFinite(o.firstFrameAt)) o.firstFrameAt = f.t;
    o.lastFrameAt = f.t;
    if (Number.isFinite(f.dt)) o.maxFrameGap = Math.max(o.maxFrameGap, f.dt);
    if (f.held) {
      o.held++;
      if (o.heldRun === 0) o._heldRunStart = Number.isFinite(f.dt) ? f.t - f.dt : f.t;
      o.heldRun++;
      if (o.heldRun > o.heldRunMax) {
        o.heldRunMax = o.heldRun;
        o.heldRunMaxMs = round1(f.t - o._heldRunStart);
      }
    } else o.heldRun = 0;
    if (f.img === 'frozen' && f.imgW >= 0.5) {
      o.frozenImg++;
      if (Number.isFinite(f.dt)) o.frozenImgMs = round1(o.frozenImgMs + f.dt);
    }
  }

  _maybeClose(t) {
    const o = this._open;
    if (o && Number.isFinite(o.settleAt) && t - o.settleAt >= SETTLE_MS) this._close(o, t, 'settled');
  }

  /** Force the open transition's summary now (tests, or a page that wants it early). */
  flush() {
    if (this._open) this._close(this._open, this.now(), 'flushed');
  }

  _close(o, t, how) {
    this._open = null;
    if (how === 'settled' && this.phase === 'settle') {
      this.phase = 'idle';
      this.phaseAt = t;
    }
    const lts = this.longTasks.filter((e) => e.s + e.d > o.callAt - PRE_MS && e.s < t);
    const s = {
      id: o.id,
      how,
      detail: o.detail,
      at: round1(o.callAt),
      windowMs: Number.isFinite(o.settleAt) ? round1(o.settleAt - o.callAt) : null,
      phases: o.phases,
      marks: o.marks,
      rigs: o.rigs,
      frames: o.frames,
      maxFrameGapMs: round1(o.maxFrameGap),
      maxRafGapMs: round1(o.maxRafGap),
      longTasks: lts.map((e) => ({ at: round1(e.s - o.callAt), d: e.d })),
      longestTaskMs: lts.length ? Math.max(...lts.map((e) => e.d)) : 0,
      heldFrames: o.held,
      heldRunMax: o.heldRunMax,
      heldRunMaxMs: o.heldRunMaxMs,
      frozenImageFrames: o.frozenImg,
      frozenImageMs: o.frozenImgMs,
    };
    s.verdict = verdict(s);
    s.window = o.window.map((f) => ({ ...f, t: round1(f.t - o.callAt) }));
    this.transitions.push(s);
    if (this.transitions.length > 50) this.transitions.shift();
    const { window: _w, ...brief } = s;
    this.log(`transition #${s.id} ${s.verdict} ${JSON.stringify(brief)}`);
    this._emit(s);
  }

  _event(type, data, t = this.now()) {
    const ev = { ...data, type, t: round1(t), sinceCall: Number.isFinite(this.callAt) ? round1(t - this.callAt) : null };
    this.events.push(ev);
    if (this.events.length > EVENT_CAP) this.events.splice(0, this.events.length - EVENT_CAP);
    return ev;
  }

  onUpdate(cb) {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  _emit(summary) {
    for (const cb of this._listeners) safe(() => cb(summary));
  }

  /** Everything, as plain JSON (what David pastes back). */
  toJSON() {
    return {
      label: this.label,
      switches: [...this.switches],
      rigLocked: this.rigLocked,
      transitions: this.transitions,
      events: this.events,
      frames: this.frames,
    };
  }

  dump() {
    return JSON.stringify(this.toJSON());
  }

  dispose() {
    try {
      this._lto?.disconnect();
    } catch {
      /* already gone */
    }
    this._lto = null;
    this._listeners.clear();
  }
}

/**
 * The one-line verdict. Thresholds: a session-frame gap > 50 ms (three missed frames at 60 Hz) is
 * a stall; 2+ consecutive bit-identical frames is a hold; 2+ frames of the frozen capture at
 * weight >= 0.5 is a frozen image.
 */
export function verdict(s) {
  const out = [];
  if (s.heldRunMax >= 2) out.push(`TRACKING-HELD ${s.heldRunMax} frames (${s.heldRunMaxMs} ms) with frames still arriving`);
  if (s.maxFrameGapMs > 50) out.push(`MAIN-THREAD gap ${s.maxFrameGapMs} ms (longest task ${s.longestTaskMs} ms)`);
  if (s.frozenImageFrames >= 2) out.push(`IMAGE-FROZEN ${s.frozenImageFrames} frames (${s.frozenImageMs} ms) on the frozen capture`);
  return out.length ? out.join(' + ') : 'CLEAN (no hold, no gap > 50 ms, no frozen image)';
}

function defaultLog(msg) {
  if (typeof console !== 'undefined') console.info(`[dxr-diag] ${msg}`);
}
function fmtT(rec, t) {
  return Number.isFinite(rec.callAt) ? `t=${round1(t - rec.callAt)}ms` : `t=${round1(t)}`;
}
function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}
const round1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : x);
const round4 = (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : x);
const round6 = (x) => (Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : x);

// ── the on-screen overlay (2D DOM; the caller excludes it from the weave) ─────────────────────

const W = 360;
const STRIP_H = 44;
const WINDOW_MS = 3000;

/**
 * A compact overlay, fixed to the viewport's bottom-left: two strips (the rolling last 3 s, and
 * the last transition, frozen at its settle) plus a text line. Per session frame, one bar: its
 * height is the frame interval (0–100 ms), its colour what the frame was — blue normal, RED held
 * (bit-identical poses), ORANGE the frozen capture on screen, GREY a rig push just before; the
 * white line is the head motion (delta / eye separation). Repainted at ~10 Hz by the diag's own
 * window rAF, which also measures the main thread's cadence (also without the overlay).
 * Returns { el, remove } (el null without the overlay).
 */
export function startDiagLoop(rec, { overlay = true, doc = typeof document !== 'undefined' ? document : null } = {}) {
  const hasRaf = typeof requestAnimationFrame === 'function';
  if (!overlay || !doc?.createElement || !doc.body) {
    // No overlay: the window rAF cadence is still measured (the main thread's own clock).
    let raf = 0;
    const tick = (t) => {
      rec.raf(t);
      raf = requestAnimationFrame(tick);
    };
    if (hasRaf) raf = requestAnimationFrame(tick);
    return { el: null, remove: () => raf && typeof cancelAnimationFrame === 'function' && cancelAnimationFrame(raf) };
  }
  const el = doc.createElement('div');
  el.setAttribute('data-dxr-diag', '');
  el.style.cssText =
    'position:fixed;left:8px;bottom:8px;z-index:2147483647;width:' +
    W +
    'px;padding:6px;background:rgba(0,0,0,0.78);color:#e8e8e8;font:11px/1.3 ui-monospace,Menlo,Consolas,monospace;' +
    'border-radius:6px;pointer-events:none;white-space:pre-wrap;';
  const head = doc.createElement('div');
  const cv = doc.createElement('canvas');
  cv.width = W;
  cv.height = STRIP_H * 2 + 18;
  cv.style.cssText = `display:block;width:${W}px;height:${STRIP_H * 2 + 18}px;margin:4px 0`;
  const foot = doc.createElement('div');
  el.append(head, cv, foot);
  doc.body.appendChild(el);
  const g = cv.getContext && cv.getContext('2d');
  let frozen = null; // the last transition's summary
  let raf = 0;
  let lastPaint = 0;
  const off = rec.onUpdate((s) => {
    if (s) frozen = s;
  });
  const strip = (frames, y0, t0, t1, callT) => {
    if (!g) return;
    g.fillStyle = '#111';
    g.fillRect(0, y0, W, STRIP_H);
    const x = (t) => ((t - t0) / (t1 - t0)) * W;
    if (Number.isFinite(callT)) {
      g.fillStyle = '#555';
      g.fillRect(Math.round(x(callT)), y0, 1, STRIP_H);
    }
    let prev = null;
    for (const f of frames) {
      if (f.t < t0 || f.t > t1) continue;
      const h = Math.min(STRIP_H, (Number.isFinite(f.dt) ? f.dt : 0) * (STRIP_H / 100));
      g.fillStyle = f.held ? '#ff3b30' : f.img === 'frozen' && f.imgW >= 0.5 ? '#ff9f0a' : f.afterRig ? '#8e8e93' : '#0a84ff';
      g.fillRect(Math.round(x(f.t)), y0 + STRIP_H - h, 2, h);
      if (Number.isFinite(f.rel)) {
        const yy = y0 + STRIP_H - Math.min(STRIP_H, f.rel * STRIP_H * 20);
        if (prev) {
          g.strokeStyle = '#fff';
          g.beginPath();
          g.moveTo(prev[0], prev[1]);
          g.lineTo(x(f.t), yy);
          g.stroke();
        }
        prev = [x(f.t), yy];
      } else prev = null;
    }
  };
  const paint = (t) => {
    rec.raf(t);
    raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(paint) : 0;
    if (t - lastPaint < 100) return;
    lastPaint = t;
    const last = rec.frames[rec.frames.length - 1];
    const now = last ? last.t : t;
    head.textContent =
      `dxr-diag ${rec.label}  phase ${rec.phase}` +
      (Number.isFinite(rec.callAt) ? `  +${Math.round(now - rec.callAt)} ms since setSource` : '') +
      (rec.switches.size ? `  [${[...rec.switches].join(',')}]` : '') +
      (last ? `\nframe dt ${last.dt} ms  held ${last.held ? 'YES' : 'no'}  img ${last.img}${last.img !== 'none' ? ' ' + last.imgW : ''}` : '');
    strip(rec.frames, 0, now - WINDOW_MS, now, rec.callAt);
    if (frozen && g) {
      strip(frozen.window.map((f) => ({ ...f })), STRIP_H + 18, -PRE_MS, WINDOW_MS - PRE_MS, 0);
    }
    if (g) {
      g.clearRect(0, STRIP_H, W, 18); // the label band: repainted, never accumulated
      g.fillStyle = '#e8e8e8';
      g.font = '10px ui-monospace, monospace';
      g.fillText(frozen ? `last transition #${frozen.id} (frozen)` : 'last transition: none yet', 4, STRIP_H + 13);
    }
    foot.textContent = frozen ? `#${frozen.id}: ${frozen.verdict}` : 'red = held poses · orange = frozen image · bar = frame interval';
  };
  raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(paint) : 0;
  return {
    el,
    remove() {
      off();
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      el.remove?.();
    },
  };
}

/**
 * `window.__dxrDiag`: every diag tile on the page. `dump()` is the JSON to paste back;
 * `last` the most recent tile's recorder; `transitions` every tile's transition summaries.
 */
export function registerDiag(rec) {
  if (typeof window === 'undefined' || !window) return null;
  let g = window.__dxrDiag;
  if (!g || !Array.isArray(g.tiles)) {
    g = window.__dxrDiag = {
      tiles: [],
      get last() {
        return this.tiles[this.tiles.length - 1] || null;
      },
      get transitions() {
        return this.tiles.flatMap((r) => r.transitions.map((s) => ({ tile: r.label, ...s })));
      },
      dump() {
        return JSON.stringify({ ua: typeof navigator !== 'undefined' ? navigator.userAgent : null, at: new Date().toISOString(), tiles: this.tiles.map((r) => r.toJSON()) });
      },
    };
  }
  rec.label = `splat#${g.tiles.length + 1}`;
  g.tiles.push(rec);
  const dispose = rec.dispose.bind(rec);
  rec.dispose = () => {
    dispose();
    const i = g.tiles.indexOf(rec);
    if (i >= 0) g.tiles.splice(i, 1);
  };
  return g;
}
