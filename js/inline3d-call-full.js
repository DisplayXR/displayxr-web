// inline3d-call-full.js — `@displayxr/inline3d/call/full`: the call entry with 2D→3D bundled.
//
// PREVIEW tier (docs/sdk-stability.md). RFC 0003 §1 "Lift under bundlers", mechanism 2.
//
//   import { mountCall } from '@displayxr/inline3d/call/full';
//   const call = await mountCall(el);        // 2D participants are lifted to 3D on a 3D display
//
// The plain `./call` entry finds the lift module through a COMPUTED import, which a bundler cannot
// follow: a Vite/webpack/esbuild build of it resolves the specifier against the chunk URL, 404s,
// and — since 1.29 — says so (`warning { code: 'lift-not-bundled' }`) rather than staying flat in
// silence. This entry is the fix for the common case: it imports lift STATICALLY, so a bundler
// sees it, code-splits it, and ships it; `mono3D` defaults to that `lift`. Pages that do not want
// the depth-model plumbing keep importing `./call`. A page with its own `mono3D` (a function, or
// `'off'`) is left alone.
//
// Everything else — `addCall`, `dxrSignaling`, the types, the `<dxr-call>` registration — is the
// `./call` entry re-exported, and `<dxr-call>` is pointed at THIS `mountCall`, so importing this
// entry makes every element on the page lift too.
//
// Until `./lift` (js/lift/) lands on main, that path holds a PLACEHOLDER exporting no `lift`;
// this entry then behaves exactly like `./call` (`liftBundled === false`, and the same warning
// fires). The import is `* as`, so the day the real module replaces the placeholder nothing here
// changes.

import * as liftMod from './lift/index.js';
import { mountCall as mountCallBase, addCall as addCallBase, DxrCallElement } from './inline3d-call.js';

export * from './inline3d-call.js';

const lift = typeof liftMod.lift === 'function' ? liftMod.lift : null;

/** True when this copy of the SDK carries the lift module (false on a build before `./lift` landed). */
export const liftBundled = lift !== null;

const withLift = (opts) => (lift && (!opts || opts.mono3D === undefined) ? { ...(opts || {}), mono3D: lift } : opts || {});

/** `mountCall` of `./call`, with `mono3D` defaulted to the statically imported `lift`. */
export function mountCall(el, opts) {
  return mountCallBase(el, withLift(opts));
}

/** `addCall` of `./call`, with `mono3D` defaulted to the statically imported `lift`. */
export function addCall(wall, container, opts) {
  return addCallBase(wall, container, withLift(opts));
}

// `<dxr-call>` on a page that imported this entry lifts too (the element's mount seam).
DxrCallElement.mount = mountCall;
