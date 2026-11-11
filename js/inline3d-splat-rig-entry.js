// inline3d-splat-rig-entry.js — `@displayxr/inline3d/splat/rig`: the rig and window math the splat
// viewers use, for an app that builds its own scenes around a captured splat.
//
// EXPERIMENTAL, like ./splat: names and signatures may change in any 1.x release (see
// docs/sdk-stability.md). Pure functions and constants; no engine, no DOM, no peer dependency.
// These are the SAME functions the viewers call (re-exported, not copied), so an app that frames
// its own layers with them agrees with the SDK's own framing to the last bit.
//
//   import { captureWindow, planeDistance, FOCUS_MIN_M, FOCUS_MAX_M } from '@displayxr/inline3d/splat/rig';

export {
  toRestSpace,
  aheadOfRest,
  planeDistance,
  medianDisparityDistance,
  FOCUS_MIN_M,
  FOCUS_MAX_M,
} from './inline3d-splat-rig.js';
export { captureWindow } from './inline3d-splat-shared.js';
