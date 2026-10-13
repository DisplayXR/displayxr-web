// decide.js — the built-in's native-vs-web decision for one "Convert to 3D" pick. Pure (unit-tested
// in test/lift-builtin-decide.test.mjs).
//
// Inputs: `caps`, a FRESH liftCapabilities() answer (never a cached one), and `hint`, the browser's
// own decision passed as convertAt's 4th argument by patch 0331 (`{native, liftState}`; absent from
// an older browser). The browser saw the same coarse state the caps endpoint reports, and it is the
// one that sets `dxr-lift`, so its word wins.
//
// Rule (runtime conversion-providers §7.4): `waiting` is a reason to wait, never a reason to switch
// paths — a native pick stays native while the runtime's converter warms. Only `unavailable` is the
// in-page path.

export const LIFT_STATES = Object.freeze(['waiting', 'ready', 'unavailable']);

/**
 * @param {{native?:boolean, liftState?:string, state?:string}} caps  a fresh caps answer
 * @param {{native?:boolean, liftState?:string}|undefined} hint  the browser's decision, if it gave one
 * @returns {object} caps with `native` and `liftState` settled
 */
export function decideLift(caps, hint) {
  const c = caps && typeof caps === 'object' ? caps : { native: false };
  const own = LIFT_STATES.includes(c.liftState) ? c.liftState : c.native ? (c.state === 'activating' ? 'waiting' : 'ready') : 'unavailable';
  if (hint && typeof hint === 'object' && typeof hint.native === 'boolean') {
    if (!hint.native) return { ...c, native: false, liftState: 'unavailable' };
    let ls = LIFT_STATES.includes(hint.liftState) ? hint.liftState : own;
    if (ls === 'unavailable') ls = 'waiting'; // the browser said native: our own query raced its answer
    return { ...c, native: true, liftState: ls };
  }
  return { ...c, native: !!c.native && own !== 'unavailable', liftState: own };
}
