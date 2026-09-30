// js/lift/index.js — PLACEHOLDER for the lift module (`@displayxr/inline3d/lift`), which is on
// the `feat/lift` branch and not yet on main. That branch replaces this file wholesale (resolve
// any add/add conflict by taking feat/lift's file).
//
// It exists so `./call/full` (js/inline3d-call-full.js) can import lift STATICALLY today — the
// one shape a bundler can follow — and so the `./call` entry's computed import of this path
// resolves to "a lift module with no `lift` export" (reason `no-lift-export`) rather than a
// network 404. Either way the call raises `warning { code: 'lift-not-bundled' }` when a 2D
// participant would have been lifted, and the lobby reads "2D→3D unavailable in this build".
//
// `lift` is exported as null (not omitted): webpack turns a namespace access to a MISSING export
// into a build error, and the point of this file is that `/call/full` builds everywhere today.

export const LIFT_PLACEHOLDER = true;
export const lift = null;
