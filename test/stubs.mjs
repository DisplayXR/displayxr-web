// Minimal DOM + three.js stubs, enough to drive SceneViewer and EyeCamera under `node --test`.
//
// Deliberately NOT jsdom and NOT three.js: the behaviour under test is control flow — WHEN the
// renderer is cleared, WHICH camera is rendered, WHETHER setSize is called — so the useful test
// double is a recording one. Real three would hide exactly the calls we need to count behind a
// WebGL context this environment does not have.

/** Install the globals SceneViewer's constructor touches. Returns a handle to drive them. */
export function installDom() {
  const rafs = [];
  const observers = [];
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.requestAnimationFrame = (cb) => {
    rafs.push(cb);
    return rafs.length;
  };
  globalThis.cancelAnimationFrame = (id) => {
    if (id > 0 && id <= rafs.length) rafs[id - 1] = null;
  };
  globalThis.ResizeObserver = class {
    constructor(cb) {
      this.cb = cb;
      observers.push(this);
    }
    observe() {}
    disconnect() {}
  };
  return {
    /** Run every queued animation frame (callbacks queued during the flush run next time). */
    flushRaf() {
      const batch = rafs.splice(0, rafs.length);
      for (const cb of batch) if (cb) cb();
      return batch.length;
    },
    pendingRaf: () => rafs.filter(Boolean).length,
    /** Fire every live ResizeObserver, as the browser would on a box change. */
    fireResizeObservers() {
      for (const o of observers) o.cb([]);
    },
  };
}

/** A canvas that records nothing but answers everything SceneViewer asks of it. */
export function makeCanvas(w = 300, h = 200) {
  return {
    width: 0,
    height: 0,
    style: {},
    _box: { width: w, height: h },
    getBoundingClientRect() {
      return { width: this._box.width, height: this._box.height, x: 0, y: 0, top: 0, left: 0 };
    },
    setBox(width, height) {
      this._box = { width, height };
    },
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
  };
}

class Mat4 {
  constructor() {
    this.elements = new Float64Array(16);
  }
  fromArray(a) {
    for (let i = 0; i < 16; i++) this.elements[i] = a[i];
    return this;
  }
  copy(m) {
    this.elements.set(m.elements);
    return this;
  }
  invert() {
    // Not a real inverse — SceneViewer never reads it back, and a marker is enough to prove
    // the call happened in the right order.
    for (let i = 0; i < 16; i++) this.elements[i] = -this.elements[i];
    return this;
  }
  toArray() {
    return Array.from(this.elements);
  }
}

class Vec3 {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.z = 0;
  }
  set(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
  setScalar(s) {
    return this.set(s, s, s);
  }
}

class Euler {
  set(x, y, z, order) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.order = order;
    return this;
  }
}

class Obj3D {
  constructor() {
    this.position = new Vec3();
    this.scale = new Vec3().setScalar(1);
    this.rotation = new Euler();
    this.children = [];
    this.matrix = new Mat4();
    this.matrixWorld = new Mat4();
    this.matrixWorldInverse = new Mat4();
    this.matrixAutoUpdate = true;
  }
  add(c) {
    this.children.push(c);
    return this;
  }
}

/** THREE namespace stub + the recorder every test asserts against. */
export function makeTHREE() {
  const log = {
    clear: 0,
    render: [], // { camera, viewport } at the time of the call
    setSize: [],
    viewport: null,
    scissorTest: [],
  };

  class WebGLRenderer {
    constructor({ canvas }) {
      this.domElement = canvas;
      this.autoClear = true;
      this._drawnSinceClear = 0;
      log.clearsWithoutDraw = 0;
    }
    setClearColor() {}
    setPixelRatio() {}
    setSize(w, h) {
      log.setSize.push({ w, h });
      this.domElement.width = w;
      this.domElement.height = h;
    }
    clear() {
      // A clear that is never followed by a draw IS the dark frame this fix is about.
      if (log.clear > 0 && this._drawnSinceClear === 0) log.clearsWithoutDraw++;
      log.clear++;
      this._drawnSinceClear = 0;
    }
    setScissorTest(on) {
      log.scissorTest.push(on);
    }
    setViewport(x, y, width, height) {
      log.viewport = { x, y, width, height };
    }
    setScissor() {}
    render(scene, camera) {
      this._drawnSinceClear++;
      log.render.push({ camera, viewport: log.viewport });
    }
    dispose() {}
  }

  class PerspectiveCamera extends Obj3D {
    constructor(fov = 50) {
      super();
      this.fov = fov;
      this.aspect = 1;
      this.projectionMatrix = new Mat4();
      this.projectionMatrixInverse = new Mat4();
    }
    lookAt() {}
    updateProjectionMatrix() {}
  }

  const THREE = {
    WebGLRenderer,
    PerspectiveCamera,
    Scene: class extends Obj3D {},
    Group: class extends Obj3D {},
    Matrix4: Mat4,
  };
  return { THREE, log };
}

/** A view list shaped like the session's, with recognisable matrices per eye. */
export function makeViews(n = 2, seed = 1) {
  const views = [];
  for (let i = 0; i < n; i++) {
    const proj = new Float32Array(16);
    const pose = new Float32Array(16);
    for (let k = 0; k < 16; k++) {
      proj[k] = seed * 100 + i * 10 + k;
      pose[k] = seed * 1000 + i * 10 + k;
    }
    views.push({ eye: i === 0 ? 'left' : 'right', projectionMatrix: proj, transform: { matrix: pose } });
  }
  return views;
}

/** A layer that splits the SBS buffer in half, or refuses a given eye index. */
export function makeLayer(canvas, { nullFor = -1 } = {}) {
  return {
    getViewport(view) {
      const i = view.eye === 'left' ? 0 : 1;
      if (i === nullFor) return null;
      const half = Math.floor(canvas.width / 2);
      return { x: i * half, y: 0, width: half, height: canvas.height };
    },
  };
}
