// Pure helpers of the "Convert to 3D" placement + option resolution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFit, isContentSized } from '../js/lift/placement.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('computeFit: fill maps the whole source onto the box', () => {
  const f = computeFit('fill', 400, 300, 1920, 1080);
  assert.deepEqual(f, { dx: 0, dy: 0, dw: 400, dh: 300, sx: 0, sy: 0, sw: 1920, sh: 1080 });
});

test('computeFit: contain letterboxes a 16:9 video in a 4:3 box', () => {
  const f = computeFit('contain', 400, 300, 1920, 1080);
  assert.ok(near(f.dw, 400));
  assert.ok(near(f.dh, 225));
  assert.ok(near(f.dy, 37.5));
  assert.equal(f.sw, 1920);
  assert.equal(f.sh, 1080);
});

test('computeFit: cover crops the source, canvas = the box', () => {
  const f = computeFit('cover', 300, 300, 1280, 720);
  assert.ok(near(f.dw, 300) && near(f.dh, 300) && f.dx === 0 && f.dy === 0);
  assert.ok(near(f.sw, 720) && near(f.sh, 720));
  assert.ok(near(f.sx, 280), 'centred crop');
});

test('computeFit: cover honours object-position', () => {
  const f = computeFit('cover', 300, 300, 1280, 720, '0% 50%');
  assert.ok(near(f.sx, 0));
  const g = computeFit('cover', 300, 300, 1280, 720, 'right');
  assert.ok(near(g.sx, 560));
});

test('computeFit: scale-down never upscales', () => {
  const f = computeFit('scale-down', 800, 800, 200, 100);
  assert.ok(near(f.dw, 200) && near(f.dh, 100) && near(f.dx, 300) && near(f.dy, 350));
});

test('computeFit: unknown intrinsic size falls back to the box', () => {
  const f = computeFit('contain', 400, 300, 0, 0);
  assert.equal(f.dw, 400);
  assert.equal(f.dh, 300);
});

test('isContentSized: Immersity Lens filters (>=50 px, aspect 0.2..5)', () => {
  assert.equal(isContentSized(640, 360), true);
  assert.equal(isContentSized(40, 400), false);
  assert.equal(isContentSized(600, 60), false, 'aspect 10 is a UI strip');
  assert.equal(isContentSized(250, 50), true);
});
