// web#268, two defects in what the SDK reads from and writes to the page's objects:
//
// 1. cameraRigFromCamera read `camera.fov` only: a PerspectiveCamera's `.zoom` (which narrows
//    the projection without touching `.fov`) was ignored, and an OrthographicCamera (no `.fov`)
//    sent the runtime a NaN verticalFov. Now: getEffectiveFOV() when zoom != 1, and one console
//    warning plus a finite stand-in for a camera with no perspective FOV.
// 2. _register promoted every window's canvas with inline `will-change: transform` /
//    `transform: translateZ(0)` and nothing put the page's own values back. Now handle.remove()
//    and the session ending restore them (and leave a value the page rewrote since alone).
//
// Recording stubs, no three.js and no jsdom.

import test from 'node:test';
import assert from 'node:assert/strict';

// ── environment (as test/resize-sync.test.mjs's core tests) ─────────────────────────────

const session = {
  addEventListener() {},
  removeEventListener() {},
  requestReferenceSpace: async () => ({}),
  requestAnimationFrame: () => 1,
  end() {},
};
Object.defineProperty(globalThis, 'navigator', { value: { xr: { requestSession: async () => session } }, configurable: true, writable: true });
class L {
  getViewport() {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  close() {}
}
globalThis.window = { XRDisplayLayer: L, devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
globalThis.XRDisplayLayer = L;

const { createInline3D } = await import('../js/inline3d.js');
const { cameraRigFromCamera } = await import('../js/inline3d-three.js');

function withCapturedWarnings(fn) {
  const warns = [];
  const real = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    fn();
  } finally {
    console.warn = real;
  }
  return warns;
}

// ── 1. cameraRigFromCamera ──────────────────────────────────────────────────────────────

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** Only what the rig builder touches. */
const THREE = {
  Vector3: class {
    set(x, y, z) {
      Object.assign(this, { x, y, z });
      return this;
    }
  },
  Quaternion: class {
    set(x, y, z, w) {
      Object.assign(this, { x, y, z, w });
      return this;
    }
  },
  MathUtils: { degToRad: (d) => d * DEG2RAD },
};

function poseOf(cam) {
  cam.updateMatrixWorld = () => {};
  cam.matrixWorld = {
    decompose(p, q, s) {
      p.set(0, 0, 0);
      q.set(0, 0, 0, 1);
      s.set(1, 1, 1);
    },
  };
  return cam;
}

/** A PerspectiveCamera-shaped double with three's own getEffectiveFOV formula. */
function perspective(fov, zoom = 1) {
  return poseOf({
    isPerspectiveCamera: true,
    fov,
    zoom,
    getEffectiveFOV() {
      return RAD2DEG * 2 * Math.atan(Math.tan(DEG2RAD * 0.5 * this.fov) / this.zoom);
    },
  });
}

test('cameraRigFromCamera: zoom 1 reads .fov as before, bit for bit', () => {
  const rig = cameraRigFromCamera(THREE, perspective(60), { convergence: 1 });
  assert.equal(rig.verticalFov, 60 * DEG2RAD);
});

test('cameraRigFromCamera: a zoomed PerspectiveCamera sends the FOV it renders with', () => {
  const rig = cameraRigFromCamera(THREE, perspective(60, 2), { convergence: 1 });
  const expected = 2 * Math.atan(Math.tan(Math.PI / 6) / 2);
  assert.ok(Math.abs(rig.verticalFov - expected) < 1e-12, `${rig.verticalFov} !~= ${expected}`);
  assert.ok(rig.verticalFov < 60 * DEG2RAD, 'zoom 2 narrows the frustum');
});

test('cameraRigFromCamera: zoom without getEffectiveFOV falls back to .fov', () => {
  const cam = perspective(45, 3);
  delete cam.getEffectiveFOV;
  assert.equal(cameraRigFromCamera(THREE, cam, { convergence: 1 }).verticalFov, 45 * DEG2RAD);
});

test('cameraRigFromCamera: an OrthographicCamera warns once and never yields NaN', () => {
  const ortho = () => poseOf({ isOrthographicCamera: true, zoom: 1, left: -1, right: 1, top: 1, bottom: -1 });
  let a;
  let b;
  const warns = withCapturedWarnings(() => {
    a = cameraRigFromCamera(THREE, ortho(), { convergence: 1 });
    b = cameraRigFromCamera(THREE, poseOf({ fov: undefined }), { convergence: 1 });
  });
  for (const rig of [a, b]) {
    assert.ok(Number.isFinite(rig.verticalFov) && rig.verticalFov > 0, `finite verticalFov, got ${rig.verticalFov}`);
    assert.equal(rig.verticalFov, 50 * DEG2RAD, "three's default 50° stand-in");
  }
  const fovWarns = warns.filter((w) => /needs a perspective camera/.test(w));
  assert.equal(fovWarns.length, 1, 'one warning per page, not per call');
  assert.match(fovWarns[0], /OrthographicCamera/);
});

// ── 2. the canvas's inline will-change / transform ──────────────────────────────────────

function makeCanvas(style = {}) {
  return {
    style: { ...style },
    width: 0,
    height: 0,
    clientWidth: 300,
    clientHeight: 150,
    parentElement: null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 150 }),
  };
}

test('handle.remove() restores the inline will-change / transform the page had', async () => {
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const canvas = makeCanvas({ willChange: 'opacity', transform: 'scale(2)' });
  const h = wall.addScene(canvas, () => {});
  assert.equal(canvas.style.willChange, 'transform', 'promoted while registered');
  assert.equal(canvas.style.transform, 'translateZ(0)');
  h.remove();
  assert.equal(canvas.style.willChange, 'opacity');
  assert.equal(canvas.style.transform, 'scale(2)');

  // None set before: none after.
  const bare = makeCanvas();
  wall.addScene(bare, () => {}).remove();
  assert.equal(bare.style.willChange, '');
  assert.equal(bare.style.transform, '');

  // Registered twice: the second registration restores and re-saves, so the page's ORIGINAL
  // values (not the SDK's own) come back on the final remove.
  const twice = makeCanvas({ transform: 'rotate(1deg)' });
  withCapturedWarnings(() => wall.addScene(twice, () => {}));
  let h2;
  withCapturedWarnings(() => {
    h2 = wall.addScene(twice, () => {});
  });
  h2.remove();
  assert.equal(twice.style.transform, 'rotate(1deg)');
  wall.close();
});

test('the session ending restores every window canvas, and leaves a value the page rewrote alone', async () => {
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const a = makeCanvas({ transform: 'translateX(4px)' });
  const b = makeCanvas();
  wall.addScene(a, () => {});
  wall.addScene(b, () => {});
  b.style.transform = 'rotate(3deg)'; // the page's own, written after registration
  wall.close();
  assert.equal(a.style.transform, 'translateX(4px)');
  assert.equal(a.style.willChange, '');
  assert.equal(b.style.transform, 'rotate(3deg)', "the page's newer value is not clobbered");
  assert.equal(b.style.willChange, '');
});
