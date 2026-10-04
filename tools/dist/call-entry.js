// tools/dist/call-entry.js — the source of the CDN bundle `dist/call.js` (RFC 0003 §1).
//
//   <script type="module" src="https://cdn.jsdelivr.net/npm/@displayxr/inline3d@1/dist/call.js"></script>
//   <dxr-call></dxr-call>
//
// One pre-bundled ESM file: core + call + camera + the element, no three/PlayCanvas. Importing it registers
// `<dxr-call>` (the `./call` entry does that) and exports the one-line surface below. Module-only,
// zero globals (Decision 11): a page that wants `mountCall` from the CDN does
//   import { mountCall } from 'https://cdn.jsdelivr.net/npm/@displayxr/inline3d@1/dist/call.js';
//
// Lift (2D→3D) is a LAZY SIBLING CHUNK: the computed import behind `mono3D: 'auto'` is pointed at
// `./lift.js` next to this file, which tools/dist/build.mjs emits from js/lift/ when the lift
// module is present in this copy of the SDK. When it is not, the chunk is absent and the call
// says so (`warning { code: 'lift-not-bundled' }`) the first time a 2D participant would have
// been lifted on a 3D display.

import { setLiftSpecifier } from '../../js/call/lift.js';

setLiftSpecifier(() => new URL('./lift.js', import.meta.url).href);

export { mountCall, addCall, dxrSignaling, DXR_SIGNAL_DEFAULT, parseInviteLink, DxrCallElement, defineCallElement, attrsToOpts, CALL_EVENT_PREFIX } from '../../js/inline3d-call.js';
export { sharedInline3D, createInline3D, inline3DAvailable } from '../../js/inline3d.js';
// The camera primitive (RFC 0003 §4) rides in the same file: `openCamera` / `addCameraView` for a
// 3D selfie page, and what `/call` builds its self view and capture on.
export { openCamera, addCameraView, isStereoCamera, suggestedName, readJpegStereoMeta, readWebmStereoMeta, readJpegXmp, parseStereoXmp, CAMERA_SDK } from '../../js/inline3d-camera.js';
