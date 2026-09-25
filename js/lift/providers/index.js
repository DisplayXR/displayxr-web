// @displayxr/inline3d lift providers — depth, inpainting, model delivery, ORT loading.
// Importing this module registers the ORT/WebGPU depth provider (priority 0) in the shared registry.
export { createDepthProvider, createOrtDepthProvider, AUTO_DROP_MS } from './depth-ort.js';
export { createInpainter } from './inpaint-ort.js';
export { createModelSource, parseManifest, sha256Hex, CACHE_NAME, NATIVE_ORIGIN, DEFAULT_MANIFEST_URL } from './models.js';
export { getRegistry } from './registry.js';
export { loadOrt, hasJspi, hasWebGpu, ORT_VERSION, ORT_DEFAULT_BASE } from './ort.js';
export { createRemoteSharpLift, createPopupAuth, RemoteLiftError, REMOTE_SHARP_DEFAULTS } from './lift-remote-sharp.js';
export { mogePost, da3Post, solveFocalShift } from './still-post.js';
