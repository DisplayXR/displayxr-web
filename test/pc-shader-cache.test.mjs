// The engine compiled-shader release (./inline3d-pc-shader-cache.js), against a copy of the shape
// of PlayCanvas 2.22.3's WebglShader + CompiledShaderCache (src/platform/graphics/webgl/
// webgl-shader.js). On an engine bump, re-copy those two classes here if they changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patchWebglShaderPrototype, shaderCacheShapeProblem, installShaderCacheRelease, shaderCacheStats } from '../js/inline3d-pc-shader-cache.js';

/** A fresh copy of the 2.22.3 classes per test (the patch is per prototype, once). */
function engine() {
  class CompiledShaderCache {
    map = new Map();
  }
  const caches = new Map();
  const cacheOf = (device, vs) => {
    const k = `${vs}`;
    if (!caches.has(device)) caches.set(device, { true: new CompiledShaderCache(), false: new CompiledShaderCache() });
    return caches.get(device)[k];
  };
  class WebglShader {
    constructor(shader) {
      this.glProgram = null;
      this.compile(shader.device, shader);
      this.glProgram = shader.device.gl.createProgram();
      shader.device.shaders.push(shader);
    }
    destroy(shader) {
      if (this.glProgram) {
        shader.device.gl.deleteProgram(this.glProgram);
        this.glProgram = null;
      }
    }
    compile(device, shader) {
      this._vsource = shader.definition.vshader;
      this._fsource = shader.definition.fshader;
      this.glVertexShader = this._compileShaderSource(device, this._vsource, true);
      this.glFragmentShader = this._compileShaderSource(device, this._fsource, false);
    }
    _compileShaderSource(device, src, isVertexShader) {
      const gl = device.gl;
      if (gl.isContextLost()) return null;
      const shaderCache = cacheOf(device, isVertexShader);
      let glShader = shaderCache.map.get(src);
      if (!glShader) {
        glShader = gl.createShader(isVertexShader ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER);
        gl.shaderSource(glShader, src);
        gl.compileShader(glShader);
        shaderCache.map.set(src, glShader);
      }
      return glShader;
    }
  }
  return { WebglShader, caches };
}

function device(WebglShader) {
  let n = 0;
  const live = new Set();
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    lost: false,
    isContextLost() {
      return this.lost;
    },
    createShader: (t) => {
      const s = { id: ++n, t };
      live.add(s);
      return s;
    },
    shaderSource() {},
    compileShader() {},
    deleteShader: (s) => {
      assert.ok(live.has(s), 'never deletes a shader twice');
      live.delete(s);
    },
    createProgram: () => ({ id: ++n }),
    deleteProgram() {},
  };
  const handlers = {};
  // createShaderImpl on the prototype, as on the engine's WebglGraphicsDevice
  class Device {
    createShaderImpl(shader) {
      return new WebglShader(shader);
    }
  }
  const dev = Object.assign(new Device(), {
    isWebGL2: true,
    gl,
    shaders: [],
    on: (ev, cb) => (handlers[ev] ||= []).push(cb),
    fire: (ev) => (handlers[ev] || []).forEach((cb) => cb()),
  });
  return { dev, gl, live };
}

const shader = (dev, vs, fs) => {
  const s = { device: dev, definition: { vshader: vs, fshader: fs } };
  s.impl = dev.createShaderImpl(s);
  s.destroy = () => s.impl.destroy(s);
  return s;
};

test('the 2.22.3 shape takes the patch, once', () => {
  const { WebglShader } = engine();
  assert.equal(shaderCacheShapeProblem(WebglShader.prototype), null);
  assert.equal(patchWebglShaderPrototype(WebglShader.prototype), 'patched');
  assert.equal(patchWebglShaderPrototype(WebglShader.prototype), 'already');
});

test('a shared shader is deleted by the LAST program out; its source compiles again after', () => {
  const { WebglShader } = engine();
  patchWebglShaderPrototype(WebglShader.prototype);
  const { dev, live } = device(WebglShader);
  const a = shader(dev, 'VS', 'FS-a');
  const b = shader(dev, 'VS', 'FS-b');
  assert.equal(a.impl.glVertexShader, b.impl.glVertexShader, 'one compiled shader per source, as the engine');
  assert.equal(live.size, 3);
  a.destroy();
  assert.equal(live.size, 2, 'FS-a gone; VS still used by b');
  b.destroy();
  assert.equal(live.size, 0, 'the last program out deletes the shared vertex shader');
  const c = shader(dev, 'VS', 'FS-a');
  assert.equal(live.size, 2, 'compiled again, not a dead cached one');
  assert.ok(live.has(c.impl.glVertexShader));
  assert.deepEqual(shaderCacheStats(dev), { compiled: 5, deleted: 3, cached: 2 });
});

test('unpatched (as the engine ships): destroying every program deletes no shader', () => {
  const { WebglShader } = engine();
  const { dev, live } = device(WebglShader);
  shader(dev, 'VS', 'FS-a').destroy();
  shader(dev, 'VS2', 'FS-b').destroy();
  assert.equal(live.size, 4, 'this is the growth the patch removes');
});

test('context loss forgets the cache; device destroy deletes what is left', () => {
  const { WebglShader } = engine();
  patchWebglShaderPrototype(WebglShader.prototype);
  const { dev, gl, live } = device(WebglShader);
  shader(dev, 'VS', 'FS');
  dev.fire('devicelost');
  const x = shader(dev, 'VS', 'FS');
  assert.equal(live.size, 4, 'recompiled after loss (the old objects died with the context)');
  live.clear();
  live.add(x.impl.glVertexShader).add(x.impl.glFragmentShader);
  dev.fire('destroy');
  assert.equal(live.size, 0);
  gl.lost = true;
});

test('installShaderCacheRelease reaches the class through the first impl; shaders compiled before the patch are left alone', () => {
  const { WebglShader } = engine();
  const { dev, live } = device(WebglShader);
  assert.equal(installShaderCacheRelease(dev), 'pending');
  const first = shader(dev, 'VS0', 'FS0'); // through the engine's own cache
  assert.equal(dev.__dxrShaderCache, 'patched');
  assert.equal(Object.hasOwn(dev, 'createShaderImpl'), false, 'the device method is restored');
  const s = shader(dev, 'VS1', 'FS1');
  s.destroy();
  first.destroy();
  assert.equal(live.size, 2, 'only the pre-patch pair stays (in the engine cache, as before)');
  assert.equal(installShaderCacheRelease({ isWebGL2: false, createShaderImpl() {} }), 'skipped: not a WebGL2 device');
});

test('steps aside on an engine that already releases shaders, or has a different shape', () => {
  class Released {
    _compileShaderSource(device, src, v) {
      return this.map.get(src) || device.gl.createShader(v);
    }
    destroy(shader) {
      shader.device.gl.deleteShader(this.glVertexShader);
    }
  }
  assert.match(patchWebglShaderPrototype(Released.prototype), /^skipped: the engine already releases shaders/);
  class Other {
    _compileShaderSource(device, src) {
      return src;
    }
    destroy() {}
  }
  assert.match(patchWebglShaderPrototype(Other.prototype), /^skipped:/);
  assert.match(shaderCacheShapeProblem({}), /no WebglShader/);
});
