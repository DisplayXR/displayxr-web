// Types for `@displayxr/inline3d/splat/playcanvas`: ./splat's addSplat with the engine fixed to
// 'playcanvas', without the Spark/three peers. Same handle and options as ./splat.
export { addSplat, readSogCamera, readSogMeta, applySplatPerf, SPLAT_PERF_PRESETS, resolveRig } from './splat';
export type * from './splat';

// ── EXPERIMENTAL (docs/sdk-stability.md): helpers for an app that builds its own PlayCanvas scene ──

/**
 * Centres (+ peak opacities where the format has them) from a loaded flat gsplat resource
 * (`asset.resource` of a 'gsplat' asset), in the file's model space, strided at copy time to the
 * viewers' frame sample cap. Resolves null for a missing resource. Loads the viewer module on
 * first call.
 */
export function readCloud(
  resource: unknown,
  yielder?: () => Promise<void> | void,
): Promise<{ xyz: Float32Array; opacity: Float32Array | null; total: number; stride: number; sourceTotal: number } | null>;
/** The generated room environment as RGBE bytes (W × H × 4), cached per size. Defaults 256 × 128. */
export function roomRGBE(W?: number, H?: number): Uint8Array;
/** Yaw, in degrees, that lines the generated room up with the world (its +X panel on +X). */
export const ROOM_YAW_DEG: number;
