// @displayxr/inline3d/lift — "Convert to 3D". EXPERIMENTAL (preview tier, docs/sdk-stability.md).
//
//   import { lift } from '@displayxr/inline3d/lift';
//   const h = await lift(videoOrImg);
//
// The conversion is the runtime's: lift() hands the element to the DisplayXR Browser's conversion
// stack (`liftCapabilities().native`) and rejects with a NativeLiftError ('unavailable') where there
// is none. This entry is light: the explore renderer (the PlayCanvas engine, the SDK's optional
// peer) and the .sog export are dynamic imports that lift() makes on first use. See docs/lift.md.
export { lift, resolveMediaAt, resolveQuality, STATES } from './lift.js';
export { getRegistry } from './providers/registry.js';
export { liftCapabilities, LIFT_ATTRS, LIFT_PRIORITIES, createNativeDepthProvider, createNativeGaussiansLift, NativeLiftError } from './native.js';
export { createRemoteSharpLift, createPopupAuth, RemoteLiftError } from './providers/lift-remote-sharp.js';
