// Type definitions for @displayxr/inline3d/call/full — the call entry with 2D→3D bundled.
// PREVIEW tier — not covered by the 1.x semver promise. See docs/sdk-stability.md.
//
// Same surface as `./call` (re-exported), except `mountCall` / `addCall` default `mono3D` to a
// STATICALLY imported `lift` (`./lift`), which is what lets a bundler ship it. Use this entry in a
// bundled app that wants 2D participants lifted to 3D; use `./call` when you do not want the
// depth-model plumbing (it then warns `lift-not-bundled` the first time a 2D peer would have been
// lifted on a 3D display). Importing this entry also points `<dxr-call>` at this `mountCall`.

import type { CallHandle, CallOptions } from './call.js';

export * from './call.js';

/** True when this copy of the SDK carries the lift module; false on a build where `./lift` has not landed yet. */
export const liftBundled: boolean;

/** `mountCall` of `./call` with `mono3D` defaulted to the bundled `lift` (unless you pass your own). */
export function mountCall(el: HTMLElement, opts?: CallOptions): Promise<CallHandle>;

/** `addCall` of `./call` with `mono3D` defaulted to the bundled `lift` (unless you pass your own). */
export function addCall(wall: unknown, container: HTMLElement, opts?: CallOptions): Promise<CallHandle>;
