// inline3d-cursor-option.js — `cursor: 'depth' | { … }` as ./model and ./splat accept it.
//
// Its own tiny, dependency-free module on purpose: the PlayCanvas adapter validates the option at
// the call (statically), but must not pull the cursor itself into a page that never asks for it
// (the cursor modules load only on opt-in). ./cursor-depth re-exports everything here.

/** Anchor modes — see ./inline3d-cursor-depth.js. */
export const CURSOR_ANCHOR_MODES = Object.freeze(['hybrid', 'screen', 'world']);

/** The keys `cursor: { … }` accepts on ./model and ./splat. */
export const CURSOR_OPTION_KEYS = Object.freeze(['height', 'margin', 'anchor', 'pointerScope']);

/**
 * `cursor` as ./model and ./splat accept it: `'depth'`, or an options object (which also means
 * depth). Anything falsy is OFF — the zero-cost default. Validated here, at the call.
 * @returns {null | {height?: number, margin?: number, anchor?: string, pointerScope?: string}}
 */
export function resolveCursorOption(opt, who = '@displayxr/inline3d') {
  if (opt === undefined || opt === null || opt === false) return null;
  if (opt === 'depth' || opt === true) return {};
  if (typeof opt !== 'object') {
    throw new Error(`${who}: cursor ${JSON.stringify(opt)} — expected 'depth' or { height, margin, anchor, pointerScope }.`);
  }
  const unknown = Object.keys(opt).filter((k) => !CURSOR_OPTION_KEYS.includes(k));
  if (unknown.length) throw new Error(`${who}: cursor — unknown option(s) ${unknown.join(', ')}; expected ${CURSOR_OPTION_KEYS.join(', ')}.`);
  if (opt.anchor !== undefined && !CURSOR_ANCHOR_MODES.includes(opt.anchor)) {
    throw new Error(`${who}: cursor.anchor "${opt.anchor}" — expected ${CURSOR_ANCHOR_MODES.join(', ')}.`);
  }
  if (opt.pointerScope !== undefined && opt.pointerScope !== 'canvas' && opt.pointerScope !== 'window') {
    throw new Error(`${who}: cursor.pointerScope "${opt.pointerScope}" — expected 'canvas' or 'window'.`);
  }
  for (const k of ['height', 'margin']) {
    if (opt[k] !== undefined && !(typeof opt[k] === 'number' && opt[k] > 0 && Number.isFinite(opt[k]))) {
      throw new Error(`${who}: cursor.${k} must be a positive number.`);
    }
  }
  return { ...opt };
}
