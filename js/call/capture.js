// call/capture.js — moved to js/camera/capture.js in C2 (RFC 0003 §4: device selection,
// calibration and the busy-device skip belong to `@displayxr/inline3d/camera`). This path
// re-exports it so test imports and any in-tree reference keep resolving.
export * from '../camera/capture.js';
