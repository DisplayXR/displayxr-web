// ort.js — obtain onnxruntime-web WITHOUT bundling it into the SDK.
//
// ORT is ~a 25 MB wasm + JS payload; the SDK core must stay dependency-free, so the lift path
// imports it at runtime from a base URL (a CDN by default, or the page's own copy of
// `node_modules/onnxruntime-web/dist/`). A page that already has ORT passes it as `ort` and this
// module is never touched.
//
// Bundle choice: the JSPI build (`ort.jspi.min.mjs`) measured 11–14 % faster than the classic
// asyncify WebGPU build on the VDA streaming model (1.31.0-dev, Apple M-series, Chrome 14x); it
// needs WebAssembly JSPI (`WebAssembly.Suspending`). 'auto' uses it when present, else
// `ort.webgpu.min.mjs`.

export const ORT_VERSION = '1.31.0-dev.20260918-bc8e7ed75';
export const ORT_DEFAULT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

const loaded = new Map();

export function hasJspi() {
  return typeof WebAssembly !== 'undefined' && typeof (/** @type {any} */ (WebAssembly)).Suspending === 'function';
}

/**
 * Import onnxruntime-web from `baseUrl` and point its wasm loader there. Memoised per URL.
 * @param {{baseUrl?:string, bundle?:'auto'|'jspi'|'webgpu'}} [o]
 * @returns {Promise<any>} the `ort` module namespace
 */
export function loadOrt({ baseUrl = ORT_DEFAULT_BASE, bundle = 'auto' } = {}) {
  if (!baseUrl.endsWith('/')) baseUrl += '/';
  const b = bundle === 'auto' ? (hasJspi() ? 'jspi' : 'webgpu') : bundle;
  const file = b === 'jspi' ? 'ort.jspi.min.mjs' : 'ort.webgpu.min.mjs';
  const key = baseUrl + file;
  let p = loaded.get(key);
  if (!p) {
    p = import(/* webpackIgnore: true */ /* @vite-ignore */ key).then((ort) => {
      ort.env.wasm.wasmPaths = baseUrl;
      // Threads need cross-origin isolation (SharedArrayBuffer); without it ORT warns and falls
      // back anyway — say so up front. The WebGPU EP does the heavy lifting regardless.
      if (!globalThis.crossOriginIsolated) ort.env.wasm.numThreads = 1;
      return ort;
    });
    p.catch(() => loaded.delete(key));
    loaded.set(key, p);
  }
  return p;
}

/** True when this browser can run the WebGPU execution provider at all. */
export function hasWebGpu() {
  return typeof navigator !== 'undefined' && !!(/** @type {any} */ (navigator)).gpu;
}
