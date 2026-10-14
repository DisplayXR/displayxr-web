// inline3d-cursor-option.js — `cursor: 'depth' | { … }` as ./model and ./splat accept it.
//
// Its own tiny, dependency-free module on purpose: the PlayCanvas adapter validates the option at
// the call (statically), but must not pull the cursor itself into a page that never asks for it
// (the cursor modules load only on opt-in). ./cursor-depth re-exports everything here.

/** Anchor modes — see ./inline3d-cursor-depth.js. */
export const CURSOR_ANCHOR_MODES = Object.freeze(['hybrid', 'screen', 'world']);

/** The keys `cursor: { … }` accepts on ./model and ./splat. */
export const CURSOR_OPTION_KEYS = Object.freeze(['height', 'margin', 'anchor', 'pointerScope', 'debug', 'soften']);

// ── Crosstalk softening (runtime ADR-046 Amendment 2 §B.7) ─────────────────────────────────────
// On a lenticular panel a little of every view leaks into its neighbours. A LIFTED cursor's leaked
// copy sits one ghost offset away, and how visible it is scales with contrast × edge sharpness; on
// the glass the views coincide and there is no ghost. So the drawn arrow is softened with lift:
// an edge blur of k × |ghost offset| panel px (capped) and an opacity easing to alphaMin. Both are
// exactly zero on the glass. The numbers are the runtime's U_CURSOR_SOFTEN_DEFAULT_*, tuned by eye
// on a Windows Leia panel and confirmed on a Mac (2026-10-11/12), so web and native match.

/** `cursor.soften` presets: both effects (default), neither, or one of them (the A/B presets). */
export const CURSOR_SOFTEN_PRESETS = Object.freeze(['both', 'off', 'alpha', 'blur']);

/** The runtime's softening defaults (u_cursor_soften_params_default). */
export const CURSOR_SOFTEN_DEFAULTS = Object.freeze({
  /** Edge blur on. */
  blur: true,
  /** Opacity easing on. */
  alpha: true,
  /** Panel px of blur per panel px of ghost offset. */
  blurK: 0.1,
  /** Hard ceiling on the blur radius, panel px (the real cap is blurMaxFrac). */
  blurMaxPx: 8,
  /** Blur cap as a fraction of the DRAWN arrow's height (~4 px on a 64 px arrow), so it reads the same at any DPI. */
  blurMaxFrac: 0.06,
  /** Opacity at full lift. */
  alphaMin: 0.5,
  /** |disparity| (eye baselines) at which the opacity reaches alphaMin: the lift over typical content. */
  fullD: 0.03,
});

// The numeric knobs and their legal ranges [lo, hi, loOpen] — the runtime's parse ranges.
const SOFTEN_NUMBERS = Object.freeze({
  blurK: [0, 1000, false],
  blurMaxPx: [0, 8, false],
  blurMaxFrac: [0, 0.5, false],
  alphaMin: [0, 1, false],
  fullD: [0, 1000, true],
});

/** The keys `cursor.soften: { … }` accepts: an optional preset `mode`, then the numbers. */
export const CURSOR_SOFTEN_KEYS = Object.freeze(['mode', ...Object.keys(SOFTEN_NUMBERS)]);

const inSoftenRange = (k, v) => {
  const [lo, hi, loOpen] = SOFTEN_NUMBERS[k];
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi && !(loOpen && v <= lo);
};

const presetFlags = (mode) => ({ blur: mode === 'both' || mode === 'blur', alpha: mode === 'both' || mode === 'alpha' });

/**
 * `cursor.soften` as the API accepts it, resolved to the full parameter set: a preset
 * (`'both'` — the default — `'off'`, `'alpha'`, `'blur'`), or `{ mode?, blurK?, blurMaxPx?,
 * blurMaxFrac?, alphaMin?, fullD? }` over the defaults. `undefined` / `null` / `true` = the
 * defaults, `false` = `'off'`. Throws on a bad value, like every other option, at the call.
 * @returns {{blur: boolean, alpha: boolean, blurK: number, blurMaxPx: number, blurMaxFrac: number, alphaMin: number, fullD: number}}
 */
export function resolveCursorSoften(opt, who = '@displayxr/inline3d') {
  if (opt === undefined || opt === null || opt === true) return { ...CURSOR_SOFTEN_DEFAULTS };
  if (opt === false) opt = 'off';
  const bad = () => new Error(`${who}: cursor.soften ${JSON.stringify(opt)} — expected ${CURSOR_SOFTEN_PRESETS.map((m) => `'${m}'`).join(' | ')} or { ${CURSOR_SOFTEN_KEYS.join(', ')} }.`);
  if (typeof opt === 'string') {
    if (!CURSOR_SOFTEN_PRESETS.includes(opt)) throw bad();
    return { ...CURSOR_SOFTEN_DEFAULTS, ...presetFlags(opt) };
  }
  if (typeof opt !== 'object' || Array.isArray(opt)) throw bad();
  const unknown = Object.keys(opt).filter((k) => !CURSOR_SOFTEN_KEYS.includes(k));
  if (unknown.length) throw new Error(`${who}: cursor.soften — unknown option(s) ${unknown.join(', ')}; expected ${CURSOR_SOFTEN_KEYS.join(', ')}.`);
  if (opt.mode !== undefined && !CURSOR_SOFTEN_PRESETS.includes(opt.mode)) throw bad();
  const out = { ...CURSOR_SOFTEN_DEFAULTS, ...presetFlags(opt.mode ?? 'both') };
  for (const k of Object.keys(SOFTEN_NUMBERS)) {
    if (opt[k] === undefined) continue;
    const [lo, hi, loOpen] = SOFTEN_NUMBERS[k];
    if (!inSoftenRange(k, opt[k])) throw new Error(`${who}: cursor.soften.${k} must be a number in ${loOpen ? '(' : '['}${lo}, ${hi}].`);
    out[k] = opt[k];
  }
  return out;
}

// strtod-like: optional leading whitespace, a decimal float, optional trailing spaces/tabs.
const SOFTEN_FLOAT = /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[ \t]*$/;

/**
 * The runtime's lenient knob parse (u_cursor_soften_params_parse), for string sources such as URL
 * parameters: `mode` 'off' | 'alpha' | 'blur' | 'both' (its leading word; anything else = both),
 * the numbers as strings. Each may be null/undefined (= default); a value that does not parse or
 * is out of range keeps its default instead of throwing.
 * @returns {{params: object, changed: boolean}}  `changed`: any knob differs from its default.
 */
export function parseCursorSoften(mode, blurK, blurMaxPx, blurMaxFrac, alphaMin, fullD) {
  const params = { ...CURSOR_SOFTEN_DEFAULTS };
  let changed = false;
  if (mode !== null && mode !== undefined) {
    const word = String(mode).split(/[ \t]/)[0];
    if (word === 'off') params.blur = params.alpha = false;
    else if (word === 'alpha') params.blur = false;
    else if (word === 'blur') params.alpha = false;
    changed = !params.blur || !params.alpha;
  }
  const raw = { blurK, blurMaxPx, blurMaxFrac, alphaMin, fullD };
  for (const k of Object.keys(SOFTEN_NUMBERS)) {
    const s = raw[k];
    if (s === null || s === undefined || s === '' || !SOFTEN_FLOAT.test(String(s))) continue;
    const v = parseFloat(String(s));
    if (!inSoftenRange(k, v)) continue;
    params[k] = v;
    changed = true;
  }
  return { params, changed };
}

/**
 * `cursor` as ./model and ./splat accept it: `'depth'`, or an options object (which also means
 * depth). Anything falsy is OFF — the zero-cost default. Validated here, at the call.
 * `debug`: true logs the cursor's per-frame cost (rolling stats, at most once a second); 'both' also
 * keeps the OS cursor visible beside the sprite (the latency check). Off by default, and free.
 * @returns {null | {height?: number, margin?: number, anchor?: string, pointerScope?: string, debug?: boolean|'both', soften?: string | object}}
 */
export function resolveCursorOption(opt, who = '@displayxr/inline3d') {
  if (opt === undefined || opt === null || opt === false) return null;
  if (opt === 'depth' || opt === true) return {};
  if (typeof opt !== 'object') {
    throw new Error(`${who}: cursor ${JSON.stringify(opt)} — expected 'depth' or { height, margin, anchor, pointerScope, debug, soften }.`);
  }
  const unknown = Object.keys(opt).filter((k) => !CURSOR_OPTION_KEYS.includes(k));
  if (unknown.length) throw new Error(`${who}: cursor — unknown option(s) ${unknown.join(', ')}; expected ${CURSOR_OPTION_KEYS.join(', ')}.`);
  if (opt.anchor !== undefined && !CURSOR_ANCHOR_MODES.includes(opt.anchor)) {
    throw new Error(`${who}: cursor.anchor "${opt.anchor}" — expected ${CURSOR_ANCHOR_MODES.join(', ')}.`);
  }
  if (opt.pointerScope !== undefined && opt.pointerScope !== 'canvas' && opt.pointerScope !== 'window') {
    throw new Error(`${who}: cursor.pointerScope "${opt.pointerScope}" — expected 'canvas' or 'window'.`);
  }
  if (opt.debug !== undefined && typeof opt.debug !== 'boolean' && opt.debug !== 'both') {
    throw new Error(`${who}: cursor.debug ${JSON.stringify(opt.debug)} — expected true, false or 'both'.`);
  }
  for (const k of ['height', 'margin']) {
    if (opt[k] !== undefined && !(typeof opt[k] === 'number' && opt[k] > 0 && Number.isFinite(opt[k]))) {
      throw new Error(`${who}: cursor.${k} must be a positive number.`);
    }
  }
  if (opt.soften !== undefined) resolveCursorSoften(opt.soften, who); // validate at the call
  return { ...opt };
}

/** The keys `cursor: { … }` accepts on a stereo PAIR (./camera's addCameraView, ./call's tiles). */
export const PAIR_CURSOR_OPTION_KEYS = Object.freeze(['height', 'pointerScope', 'soften']);

/**
 * `cursor` on a stereo pair — a camera view or a call tile: `'depth'`, or `{ height, pointerScope, soften }`.
 * A pair has no scene: its depth is MEASURED off the two halves, and the sprite is drawn into them,
 * so there is no anchor mode (it is always on the line of sight) and the margin is the SDK's. Falsy
 * is OFF, the zero-cost default.
 * @returns {null | {height?: number, pointerScope?: string, soften?: string | object}}
 */
export function resolvePairCursorOption(opt, who = '@displayxr/inline3d') {
  const o = resolveCursorOption(opt, who);
  if (!o) return null;
  const unknown = Object.keys(o).filter((k) => !PAIR_CURSOR_OPTION_KEYS.includes(k));
  if (unknown.length) throw new Error(`${who}: cursor — ${unknown.join(', ')} not supported on a stereo pair; expected ${PAIR_CURSOR_OPTION_KEYS.join(', ')}.`);
  return o;
}
