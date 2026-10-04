// call/disparity.js — moved to js/camera/disparity.js in C2 (RFC 0003 §4: auto-convergence is a
// camera-side measurement that the call and `addCameraView` share). This path re-exports it so
// test imports and any in-tree reference keep resolving; new code imports the camera module.
export * from '../camera/disparity.js';
