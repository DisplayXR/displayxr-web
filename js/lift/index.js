// @displayxr/inline3d/lift — "Convert to 3D". EXPERIMENTAL (preview tier, docs/sdk-stability.md).
//
//   import { lift } from '@displayxr/inline3d/lift';
//   const h = await lift(videoOrImg, { models: 'https://my.cdn/lift-models' });
//
// This entry is light: the providers (onnxruntime-web, loaded at runtime), the live DIBR, the
// generator, the explore renderer (the PlayCanvas engine, the SDK's optional peer) and the .sog
// export are dynamic imports
// that lift() makes on first use. See docs/lift.md.
export { lift, resolveMediaAt, resolveQuality, STATES } from './lift.js';
export { getRegistry } from './providers/registry.js';
export { liftCapabilities, LIFT_ATTRS, LIFT_PRIORITIES, createNativeDepthProvider, createNativeGaussiansLift, NativeLiftError } from './native.js';
export { createModelSource } from './providers/models.js';
export { loadOrt } from './providers/ort.js';
