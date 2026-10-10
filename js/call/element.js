// call/element.js — `<dxr-call>`: the one-line path as markup (RFC 0003 §1, C1).
//
//   <script type="module" src="https://cdn.jsdelivr.net/npm/@displayxr/inline3d@1/dist/call.js"></script>
//   <dxr-call accent="violet"></dxr-call>
//
// REGISTRATION. Importing `@displayxr/inline3d/call` (or `/call/full`, or the CDN bundle) defines
// the element — the entry calls `defineCallElement()` at the bottom of inline3d-call.js, which is
// why that file is listed in package.json `sideEffects`. This file itself defines nothing on
// import; it is the class, importable by path for tests.
//
// The element is SUGAR over `mountCall(this, attrsToOpts(this))`: it mounts on connect, `leave()`s
// on disconnect, re-dispatches every call event as a DOM `CustomEvent` (`dxr-call:peer`,
// `dxr-call:joined`, …, `detail` = the call's payload, bubbling and composed) and exposes the handle
// as `el.call`. It is the element's LIGHT DOM that hosts the tiles — no shadow root: woven canvases
// live in the document's own tree, and the SDK's chrome stylesheet is document-level.
//
// Attributes are the string-typed subset of `CallOptions` (attrsToOpts below). Anything else — a
// `MediaStream` camera, a custom `SignalingAdapter`, a `lift` function, a `wall` — is a JS
// property set BEFORE the element connects: `el.options = { … }`. Options win over attributes.
// Attributes are read once, at connect: this element is not reactive to later attribute changes
// (change them, then re-append it — which is a new call; see below).
//
// DISCONNECT = LEAVE. Removing the element ends the call, deliberately: a woven canvas must never
// be remounted mid-call (woven-canvas rule 2), so a DOM move IS a teardown. SPA routers: mount
// `<dxr-call>` in a layout that survives navigation. Re-appending a disconnected element starts a
// fresh call (a new mount; the old handle is gone).
//
// NO GLOBALS (Decision 11): nothing here touches `globalThis` beyond `customElements.define`,
// which `defineCallElement()` does exactly once and only when a registry exists. The class is
// usable — and unit-testable — without a DOM: the base class falls back to a plain class when
// `HTMLElement` is absent, and the mount seam (`DxrCallElement.mount`) is overridable.
//
// The import below is CIRCULAR (inline3d-call.js imports this file to register the element), so
// nothing from it may be read while this module evaluates: `mount` defaults lazily, at connect.

import { mountCall, dxrSignaling } from '../inline3d-call.js';

/** Every call event is re-dispatched as `dxr-call:<type>`; `dxr-call:ready` carries the handle. */
export const CALL_EVENT_PREFIX = 'dxr-call:';
const CALL_EVENTS = ['joined', 'left', 'peer', 'peerleft', 'state', 'display', 'speaker', 'quality', 'error', 'warning'];
const TAG = '[inline3d/call] <dxr-call>';

/** A boolean attribute: present is true, unless its value spells "false"/"0"/"off"/"no". */
const isOn = (v) => v !== null && v !== undefined && !/^(false|0|off|no)$/i.test(String(v).trim());
const num = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return undefined;
  const m = /^\s*([0-9.]+)\s*\/\s*([0-9.]+)\s*$/.exec(String(v)); // "16/9"
  const n = m ? +m[1] / +m[2] : +v;
  return Number.isFinite(n) ? n : undefined;
};
const str = (v) => (v === null || v === undefined || String(v).trim() === '' ? undefined : String(v).trim());

/**
 * Attribute → option mapping, pure. `source` is an element (or anything with `getAttribute`) or a
 * `(name) => value | null` function. Unset attributes contribute nothing (the call's own defaults
 * apply), so the result can be spread under `el.options`.
 *
 * | attribute            | option                                   |
 * |----------------------|------------------------------------------|
 * | `room`               | `room` (an id or an invite link)         |
 * | `signaling`          | `signaling: dxrSignaling(url)`           |
 * | `key`                | `key`                                    |
 * | `camera`             | `camera` (`auto`/`stereo`/`mono`/deviceId)|
 * | `layout`             | `layout` (`grid`/`speaker`/`none`)       |
 * | `accent`             | `theme.accent`                           |
 * | `max-peers`          | `maxPeers`                               |
 * | `no-ui`              | `ui: false`                              |
 * | `ui="tiles"`         | `ui: 'tiles'`                            |
 * | `auto-join`          | `autoJoin: true`                         |
 * | `mono3d="off"`       | `mono3D: 'off'`                          |
 * | `no-audio`           | `audio: false`                           |
 * | `no-self-view`       | `selfView: false`                        |
 * | `no-auto-converge`   | `autoConverge: false`                    |
 * | `cursor="depth"`     | `cursor: 'depth'`                        |
 * | `tile-aspect`        | `theme.tileAspect` (a number, or `w/h`)  |
 * | `invite-base`        | `invite.base`                            |
 * | `browser-url`        | `landing.browserUrl`                     |
 * | `debug`              | `debug: true`                            |
 *
 * @param {{ getAttribute(name: string): string | null } | ((name: string) => string | null)} source
 * @returns {object} a partial `CallOptions`
 */
export function attrsToOpts(source) {
  const get = typeof source === 'function' ? source : (n) => (source && typeof source.getAttribute === 'function' ? source.getAttribute(n) : null);
  const o = {};
  const put = (k, v) => {
    if (v !== undefined) o[k] = v;
  };
  put('room', str(get('room')));
  const signaling = str(get('signaling'));
  if (signaling) o.signaling = dxrSignaling(signaling, str(get('key')) ? { key: str(get('key')) } : {});
  put('key', str(get('key')));
  put('camera', str(get('camera')));
  put('layout', str(get('layout')));
  put('maxPeers', num(get('max-peers')));
  const ui = str(get('ui'));
  if (isOn(get('no-ui'))) o.ui = false;
  else if (ui === 'tiles') o.ui = 'tiles';
  if (isOn(get('auto-join'))) o.autoJoin = true;
  const m3 = str(get('mono3d'));
  if (m3 && /^(off|false|0|no)$/i.test(m3)) o.mono3D = 'off';
  if (isOn(get('no-audio'))) o.audio = false;
  if (isOn(get('no-self-view'))) o.selfView = false;
  if (isOn(get('no-auto-converge'))) o.autoConverge = false;
  if (str(get('cursor')) === 'depth') o.cursor = 'depth';
  // The C2 groups (RFC 0003 §2): the attribute names are the C1 ones, the option shapes are new.
  const theme = { accent: str(get('accent')), tileAspect: num(get('tile-aspect')) };
  if (theme.accent !== undefined || theme.tileAspect !== undefined) o.theme = Object.fromEntries(Object.entries(theme).filter(([, v]) => v !== undefined));
  if (str(get('invite-base'))) o.invite = { base: str(get('invite-base')) };
  if (str(get('browser-url'))) o.landing = { browserUrl: str(get('browser-url')) };
  if (isOn(get('debug'))) o.debug = true;
  return o;
}

// Usable without a DOM (unit tests, SSR imports): a plain base class where HTMLElement is absent.
const Base = typeof HTMLElement === 'function' ? HTMLElement : class {};

export class DxrCallElement extends Base {
  /**
   * The mount seam: null = `mountCall` of `./call`. `./call/full` points it at its lift-wired
   * `mountCall`, so importing that entry makes every `<dxr-call>` lift 2D participants; tests
   * inject a fake. Resolved at connect, never at import (the circular import above).
   */
  static mount = null;

  constructor() {
    super();
    /** Options that are not strings — set BEFORE connect; win over attributes. */
    this.options = null;
    /** The `CallHandle` once mounted; null before, and again after disconnect. */
    this.call = null;
    /** Resolves with the handle when the mount lands (null if the element left first); rejects if it failed. */
    this.ready = null;
    this._gen = 0;
    this._off = [];
    this._pending = null;
  }

  connectedCallback() {
    if (this.call || this._pending) return; // already mounted, or mounting
    const gen = ++this._gen;
    const opts = { ...attrsToOpts(this), ...(this.options && typeof this.options === 'object' ? this.options : {}) };
    const mount = this.constructor.mount || DxrCallElement.mount || mountCall;
    // Synchronous call (a throw becomes a rejection): the container's chrome exists on return.
    this._pending = new Promise((res) => res(mount(this, opts)))
      .then(
        (handle) => {
          this._pending = null;
          if (gen !== this._gen) {
            // Disconnected while the camera/lobby was coming up: the mount landed on a dead element.
            handle.leave();
            return null;
          }
          this.call = handle;
          this._off = CALL_EVENTS.map((t) => handle.on(t, (detail) => this._dispatch(t, detail)));
          // The call module only console.warns an error when NOBODY listens; the element always
          // does, so it says it here — a drop-in widget's page usually has no JS listening at all.
          this._off.push(handle.on('error', (e) => console.warn(`${TAG} ${e.code}: ${e.message}`)));
          this._dispatch('ready', { call: handle });
          // `auto-join` (and `no-ui`) join DURING the mount, before anything could subscribe —
          // and a room that already had people reports them during the join too. Replay what a
          // listener would have seen, from the handle's state: 'joined', then one 'peer' per
          // participant already there. (Errors raised while mounting — 'camera-busy' — were
          // console.warned by the call itself, since nothing was listening yet.)
          if (handle.state === 'in-call') {
            this._dispatch('joined', { room: handle.room, id: handle.id });
            for (const p of handle.peers) this._dispatch('peer', { id: p.id });
          }
          return handle;
        },
        (err) => {
          this._pending = null;
          this._dispatch('error', { code: 'mount-failed', message: String((err && err.message) || err), error: err || null });
          console.warn(`${TAG} mount failed: ${String((err && err.message) || err)}`);
          throw err;
        }
      );
    this.ready = this._pending;
    // A rejected `ready` nobody awaits must not be an unhandled rejection in a plain page.
    this.ready.catch(() => {});
  }

  disconnectedCallback() {
    this._gen++; // a mount still in flight lands on a dead element (see above)
    const call = this.call;
    this.call = null;
    // leave() FIRST, so the call's 'left' still reaches listeners on the element as
    // `dxr-call:left` (it no longer bubbles anywhere: the element is out of the tree); THEN unhook.
    if (call) call.leave();
    for (const off of this._off) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    this._off = [];
  }

  _dispatch(type, detail) {
    if (typeof CustomEvent !== 'function' || typeof this.dispatchEvent !== 'function') return;
    this.dispatchEvent(new CustomEvent(CALL_EVENT_PREFIX + type, { detail, bubbles: true, composed: true }));
  }
}

/**
 * Register `<dxr-call>` (or another tag name) once. Returns true when this call registered it,
 * false when the name was already taken (by this class: fine; by another: a warning) or when there
 * is no `customElements` registry (Node, a worker).
 *
 * @param {string} [name='dxr-call']
 * @param {CustomElementRegistry} [registry=globalThis.customElements]
 */
export function defineCallElement(name = 'dxr-call', registry = globalThis.customElements) {
  if (!registry || typeof registry.define !== 'function') return false;
  const existing = registry.get(name);
  if (existing) {
    if (existing !== DxrCallElement) console.warn(`${TAG} <${name}> is already defined by another class; leaving it`);
    return false;
  }
  registry.define(name, DxrCallElement);
  return true;
}
