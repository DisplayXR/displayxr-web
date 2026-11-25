// inline3d-pc-shader-cache.js — give PlayCanvas's compiled WebGL shaders back when the last
// program that uses them is destroyed.
//
// Internal. The PlayCanvas viewer (./inline3d-splat-playcanvas.js, shared by ./splat and ./model)
// calls installShaderCacheRelease(device) on every device it creates.
//
// WHY. The engine (2.22.3, src/platform/graphics/webgl/webgl-shader.js) keeps every compiled
// vertex and fragment shader in a module-private CompiledShaderCache, keyed by source, until the
// DEVICE is destroyed: `WebglShader.destroy()` deletes the program and nothing else. A page that
// releases what a content swap replaces (`Shader.destroy()` on the outgoing variants, see
// docs/content-lifecycle-rules.md) therefore still keeps two compiled shaders per program it
// ever linked, with the driver's compiled IR behind each one. Over a long-lived page that is
// unbounded growth in the browser's GPU process.
//
// WHAT THIS DOES. The engine is the page's own peer dependency (an import map, a bundler, a CDN
// build), never a file this package ships, so it cannot be patched on disk. Instead this replaces
// two methods on the engine's WebglShader prototype, reached through the first shader the device
// creates:
//   _compileShaderSource — the same lookup the engine does, in a per-device cache of its own
//                          (keyed by source, as the engine's), plus one count per program that
//                          took the shader;
//   destroy              — the engine's destroy (deletes the program), then one release per
//                          shader. The last program out deletes the shader and drops the entry, so
//                          the next ask for that source compiles it again.
// Context loss clears the cache (the GL objects are gone; the engine recompiles on restore), and
// device destroy deletes whatever is still cached, as the engine's own cache does. Shaders the
// engine compiled BEFORE the patch stay in the engine's cache and are left alone.
//
// ACROSS ENGINE BUMPS. The patch installs only when the prototype has the 2.22.x shape (an
// `_compileShaderSource(device, src, isVertexShader)` that reads a `.map` keyed by source, and a
// `destroy` that does not already delete shaders), and otherwise steps aside and says why
// (`device.__dxrShaderCache`, and the diagnostics overlay). On an engine bump: read the new
// webgl-shader.js; if CompiledShaderCache still never deletes a shader before device destroy, keep
// this and update the shape check if the method moved; if upstream releases shaders itself, the
// `deleteShader` check makes this a no-op — delete the module. test/pc-shader-cache.test.mjs
// runs this against a copy of the 2.22.3 class shape.

const PATCHED = Symbol.for('@displayxr/inline3d.shaderCacheRelease');

/** The per-device cache: source → shader, per stage, and a count per shader. */
const caches = new WeakMap();

function cacheFor(device) {
  let c = caches.get(device);
  if (!c) {
    c = { v: new Map(), f: new Map(), refs: new Map(), compiled: 0, deleted: 0 };
    caches.set(device, c);
    device.on?.('devicelost', () => {
      c.v.clear();
      c.f.clear();
      c.refs.clear();
    });
    device.on?.('destroy', () => {
      const gl = device.gl;
      if (gl && !gl.isContextLost?.()) for (const s of c.refs.keys()) gl.deleteShader(s);
      c.v.clear();
      c.f.clear();
      c.refs.clear();
    });
  }
  return c;
}

function release(device, map, src, glShader) {
  const c = caches.get(device);
  if (!c || !glShader || !c.refs.has(glShader)) return false; // not ours (compiled before the patch)
  const n = c.refs.get(glShader) - 1;
  if (n > 0) {
    c.refs.set(glShader, n);
    return true;
  }
  c.refs.delete(glShader);
  if (map.get(src) === glShader) map.delete(src);
  device.gl?.deleteShader(glShader);
  c.deleted++;
  return true;
}

/**
 * Why `proto` cannot take the patch, or null when it can. Exported for the test.
 * @param {object} proto  the engine's WebglShader.prototype
 */
export function shaderCacheShapeProblem(proto) {
  if (!proto || typeof proto._compileShaderSource !== 'function' || typeof proto.destroy !== 'function') return 'no WebglShader._compileShaderSource/destroy';
  if (proto._compileShaderSource.length !== 3) return 'WebglShader._compileShaderSource has a different signature';
  const compile = Function.prototype.toString.call(proto._compileShaderSource);
  if (!/\.map\.get\(/.test(compile) || !/createShader\(/.test(compile)) return 'WebglShader._compileShaderSource has a different body';
  const destroy = Function.prototype.toString.call(proto.destroy);
  if (/deleteShader/.test(destroy)) return 'the engine already releases shaders (WebglShader.destroy deletes them)';
  return null;
}

/** Patch the engine's WebglShader prototype once (the prototype is shared by every device). */
export function patchWebglShaderPrototype(proto) {
  if (proto[PATCHED]) return 'already';
  const problem = shaderCacheShapeProblem(proto);
  if (problem) return `skipped: ${problem}`;
  const engineDestroy = proto.destroy;
  proto._compileShaderSource = function (device, src, isVertexShader) {
    const gl = device.gl;
    if (gl.isContextLost()) return null;
    const c = cacheFor(device);
    const map = isVertexShader ? c.v : c.f;
    let glShader = map.get(src);
    if (!glShader) {
      glShader = gl.createShader(isVertexShader ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER);
      gl.shaderSource(glShader, src);
      gl.compileShader(glShader);
      map.set(src, glShader);
      c.compiled++;
    }
    c.refs.set(glShader, (c.refs.get(glShader) || 0) + 1);
    return glShader;
  };
  proto.destroy = function (shader) {
    engineDestroy.call(this, shader);
    const device = shader?.device;
    const c = device && caches.get(device);
    if (!c) return;
    if (release(device, c.v, this._vsource, this.glVertexShader)) this.glVertexShader = null;
    if (release(device, c.f, this._fsource, this.glFragmentShader)) this.glFragmentShader = null;
  };
  Object.defineProperty(proto, PATCHED, { value: true });
  return 'patched';
}

/**
 * Install the release on `device`'s shader class. Idempotent; WebGL devices only. The result is
 * also kept on `device.__dxrShaderCache` ('patched' | 'already' | 'skipped: …' | 'pending').
 * The prototype is reached through the first shader impl the device creates (the class is not
 * exported), so this wraps `createShaderImpl` until it has one.
 */
export function installShaderCacheRelease(device) {
  if (!device || device.__dxrShaderCache) return device?.__dxrShaderCache ?? null;
  if (!device.isWebGL2 || typeof device.createShaderImpl !== 'function') {
    device.__dxrShaderCache = 'skipped: not a WebGL2 device';
    return device.__dxrShaderCache;
  }
  const existing = device.shaders?.find?.((s) => s?.impl);
  if (existing) {
    device.__dxrShaderCache = patchWebglShaderPrototype(Object.getPrototypeOf(existing.impl));
    return device.__dxrShaderCache;
  }
  device.__dxrShaderCache = 'pending';
  const create = device.createShaderImpl;
  const ownBefore = Object.hasOwn(device, 'createShaderImpl');
  device.createShaderImpl = function (shader) {
    // The prototype is only reachable from an impl, and the impl's constructor compiles: this
    // first pair lands in the engine's own cache (kept for the device's life, as before); every
    // later shader goes through the counted one.
    if (device.__dxrShaderCache === 'pending') {
      device.__dxrShaderCache = 'probing';
      let impl;
      try {
        impl = create.call(this, shader);
      } finally {
        if (ownBefore) device.createShaderImpl = create;
        else delete device.createShaderImpl; // the prototype's method again
      }
      device.__dxrShaderCache = patchWebglShaderPrototype(Object.getPrototypeOf(impl));
      return impl;
    }
    return create.call(this, shader);
  };
  return device.__dxrShaderCache;
}

/** Shaders compiled / deleted through the patched cache on `device` (diagnostics), or null. */
export function shaderCacheStats(device) {
  const c = device && caches.get(device);
  return c ? { compiled: c.compiled, deleted: c.deleted, cached: c.refs.size } : null;
}
