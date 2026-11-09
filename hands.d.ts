// Type definitions for @displayxr/inline3d/hands.
// EXPERIMENTAL — not covered by the 1.x semver promise. See docs/sdk-stability.md.
//
// Tracked hands on an inline-3D session (WebXR Hand Input, DisplayXR Browser 1.8.0+ on Windows
// with a hand provider), and the pinch gestures that drive a viewer's orbit from them. Inert
// everywhere else: `watchHands` reports no hands and `handControls` moves nothing.

import type { Inline3D, Inline3DUnsupported } from './index.js';

/** The 25 WebXR hand joint names, in `XRHand` iteration order. */
export const HAND_JOINTS: ReadonlyArray<string>;

/** Gesture tuning. Metres in the joints' frame (the rig frame), radians. */
export interface HandGestureConfig {
  /** Thumb-tip to index-tip distance that starts a pinch, for a hand of `referencePalmM` (default 0.025). */
  pinchEnterM: number;
  /** Distance that ends it, > enter (default 0.04). */
  pinchExitM: number;
  /**
   * Palm length every distance here is stated for; a sample's own palm length scales them (pinch
   * thresholds, orbit gain, separation guard), so a scaled hand behaves the same. 0 = never scale
   * (default 0.095).
   */
  referencePalmM: number;
  /** Radians of orbit per metre of pinch-point drag, for a reference-size hand (default 10). */
  orbitRadPerM: number;
  /** EMA time constant on the pinch point, seconds; 0 = off (default 0.05). */
  smoothTauS: number;
  /** Per-frame zoom ratio clamp, both ways (default 1.25). */
  maxZoomStep: number;
  /** Two-hand gestures are ignored while the hands are further apart than this (default 1.2). */
  maxHandSeparationM: number;
}
export const HAND_GESTURE_DEFAULTS: Readonly<HandGestureConfig>;

/** Two-threshold pinch state. */
export declare class PinchDetector {
  readonly pinched: boolean;
  reset(): void;
  /** `tracked: false` releases regardless of distance. Returns the new state. */
  update(tracked: boolean, tipDistance: number, enter: number, exit: number): boolean;
}

/** One hand's input to the gesture controller. Positions `[x, y, z]`, metres. */
export interface HandGestureSample {
  tracked?: boolean;
  thumbTip: ArrayLike<number>;
  indexTip: ArrayLike<number>;
  /** Wrist → middle knuckle, metres; 0 / absent = unknown (the metre thresholds apply as given). */
  palmLength?: number;
}

/**
 * The pose delta for one frame, in the SUBJECT's convention (what `SceneViewer.nudgePose` takes):
 * yaw / pitch / roll in radians to ADD, zoom a ratio to MULTIPLY. A pinch dragged right → yaw +;
 * dragged up → pitch −; two hands turning counter-clockwise → roll +; spreading → zoom > 1.
 */
export interface HandGestureDelta {
  yaw: number;
  pitch: number;
  roll: number;
  zoom: number;
  /** Exactly one hand pinched this frame. */
  oneHand: boolean;
  /** Both hands pinched this frame. */
  twoHand: boolean;
  any: boolean;
}

/**
 * Pinch gestures → pose deltas, per frame. Pure arithmetic (no DOM, no WebXR): a port of the
 * DisplayXR Model Viewer's controls. Hand-relative pinch (thresholds scale by palm length), one
 * pinched hand orbits, two pinched hands zoom (separation ratio), roll (twist in the display
 * plane) and orbit (midpoint drag). The first frame of a gesture anchors; a hand gained or lost
 * re-anchors, so a mode change never jumps.
 */
export declare class HandGestureController {
  constructor(config?: Partial<HandGestureConfig>);
  config: HandGestureConfig;
  update(frame: {
    /** Seconds, any origin (drives the EMA). */
    time?: number;
    left?: HandGestureSample | null;
    right?: HandGestureSample | null;
    /** Multiplies every position first (default 1). */
    lengthScale?: number;
  }): HandGestureDelta;
  /** Pinch state after the last update: `0` / `'left'`, `1` / `'right'`. */
  pinched(hand: 0 | 1 | 'left' | 'right'): boolean;
  /** Last thumb-index tip distance, metres; < 0 when untracked. */
  tipDistance(hand: 0 | 1 | 'left' | 'right'): number;
  /** Forget every anchor. */
  reset(): void;
}

/** Can this document deliver hand sources at all (`XRHand` present)? */
export function handInputAvailable(): boolean;

/**
 * The browser's per-frame hand gate: `'available'`, a withheld reason (`'camera-rig'`,
 * `'posed-rig'`, `'rig-factors'`, `'no-canvas'`, `'not-fullscreen'`, `'scaled-rig'`), or
 * `'unknown'` where the session has no such surface.
 */
export function handGate(session: XRSession | null | undefined): string;

/** One tracked hand as `watchHands` reports it. Positions `[x, y, z]` metres in the watch's reference space. */
export interface HandSample {
  readonly tracked: boolean;
  readonly handedness: 'left' | 'right' | 'none';
  /** 25 × 16 column-major joint transforms (`XRFrame.fillPoses`). */
  readonly poses: Float32Array;
  /** 25 joint radii, metres. */
  readonly radii: Float32Array;
  /** Position of a joint by WebXR name, or null for an unknown name. */
  joint(name: string): number[] | null;
  readonly wrist: number[];
  readonly thumbTip: number[];
  readonly indexTip: number[];
  /** Wrist → middle knuckle, metres. */
  readonly palmLength: number;
  readonly source: XRInputSource;
}

export interface HandsFrame {
  /** Seconds (the session frame time / 1000). */
  time: number;
  /** As `handGate()`. */
  gate: string;
  left: HandSample | null;
  right: HandSample | null;
  /** Hands tracked this frame. */
  hands: number;
  frame: XRFrame;
}

export interface HandsWatch {
  stop(): void;
  readonly running: boolean;
  readonly state: { gate: string; hands: number; supported: boolean };
}

export interface WatchHandsOptions {
  /** Joints are located in this space (default: the wall's `refSpace`). */
  referenceSpace?: XRReferenceSpace;
  /** `inputsourceschange`, hand sources only. */
  onChange?: (e: { added: XRInputSource[]; removed: XRInputSource[] }) => void;
}

/**
 * Watch the hands on an inline-3D session: `onFrame` every session frame with the tracked hands
 * (or none). Runs its own `session.requestAnimationFrame` loop beside the SDK's; stops itself
 * when the session ends.
 */
export function watchHands(
  wall: Inline3D | Inline3DUnsupported | null | undefined,
  onFrame: (f: HandsFrame) => void,
  opts?: WatchHandsOptions,
): HandsWatch;

export interface HandControlOptions extends WatchHandsOptions {
  /** Controller tuning. */
  gestures?: Partial<HandGestureConfig>;
  /** Multiplies every hand position before the gesture math (default 1). */
  lengthScale?: number;
  /** Apply the two-hand roll where the viewer has a roll axis (default true). */
  roll?: boolean;
  /** Apply the two-hand zoom (default true). */
  zoom?: boolean;
  /** After each frame: the hands frame and the gesture delta. */
  onFrame?: (f: HandsFrame, d: HandGestureDelta) => void;
}

/** What `handControls` returns, and what `handle.hands` is on an `addModel` / `addSplat` handle. */
export interface HandControls {
  stop(): void;
  readonly running: boolean;
  readonly controller: HandGestureController;
  readonly state: { gate: string; hands: number; supported: boolean };
}

/** Anything with the viewer pose surface: a SceneViewer, the PlayCanvas viewer, or a handle whose `viewer` is one. */
export interface HandControlTarget {
  nudgePose?(delta: { yaw?: number; pitch?: number; zoom?: number; roll?: number }): void;
  getPose?(opts?: { target?: boolean }): { yaw: number; pitch: number; zoom: number; roll?: number };
  setPose?(pose: { yaw?: number; pitch?: number; zoom?: number; roll?: number }): void;
  readonly viewer?: HandControlTarget | null;
}

/**
 * Drive a viewer's orbit from the hands: one pinch dragged turns it, two pinches spread / twist
 * / dragged zoom / roll / turn it. Prefers `viewer.nudgePose()` (eased, counts as input for the
 * idle turntable), falls back to `getPose` + `setPose`. Pointer and wheel keep working.
 */
export function handControls(
  wall: Inline3D | Inline3DUnsupported | null | undefined,
  target: HandControlTarget,
  opts?: HandControlOptions,
): HandControls;
