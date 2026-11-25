// lendGsplatInstances: the depth cursor's pick camera borrows the eye camera's splat draw for one
// pass. PlayCanvas 2.24 honours a mesh instance's isVisibleFunc even with frustum culling off, so
// without the loan the pick pass drew no splat (cursor stuck on the glass over every splat); the
// e2e (test/e2e/cursor-depth.e2e.mjs playcanvas/splat) is the pixel check, this is the contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lendGsplatInstances } from '../js/inline3d-cursor-depth-playcanvas.js';

const eye = { name: 'eye' };
const other = { name: 'other' };
const pick = { name: 'pick' };
// The engine's gsplat instance: visible to its own camera only (GSplatRenderer.createMeshInstance).
const splatFor = (cam) => ({ isVisibleFunc: (c) => c === cam });

test('the pick camera sees the eye camera\'s splat instance during the pass, and only then', () => {
  const mine = splatFor(eye);
  const own = mine.isVisibleFunc;
  const layer = { meshInstances: [mine] };
  const restore = lendGsplatInstances([layer], pick, [eye]);
  assert.equal(mine.isVisibleFunc(pick), true);
  assert.equal(mine.isVisibleFunc(eye), true, 'still visible to its owner');
  assert.equal(mine.isVisibleFunc(other), false, 'no one else');
  restore();
  assert.equal(mine.isVisibleFunc, own, 'the engine function is put back');
  assert.equal(mine.isVisibleFunc(pick), false);
});

test('instances of other cameras, and plain meshes, are left alone', () => {
  const theirs = splatFor(other);
  const theirsOwn = theirs.isVisibleFunc;
  const mesh = { isVisibleFunc: null };
  const restore = lendGsplatInstances([{ meshInstances: [theirs, mesh] }], pick, [eye]);
  assert.equal(theirs.isVisibleFunc, theirsOwn);
  assert.equal(mesh.isVisibleFunc, null);
  restore();
});

test('an instance in two picked layers is lent once and restored to the engine function', () => {
  const mine = splatFor(eye);
  const own = mine.isVisibleFunc;
  const restore = lendGsplatInstances([{ meshInstances: [mine] }, { meshInstances: [mine] }], pick, [eye]);
  restore();
  assert.equal(mine.isVisibleFunc, own);
});

test('no pick camera or no owner: nothing changes', () => {
  const mine = splatFor(eye);
  const own = mine.isVisibleFunc;
  lendGsplatInstances([{ meshInstances: [mine] }], null, [eye])();
  lendGsplatInstances([{ meshInstances: [mine] }], pick, [])();
  assert.equal(mine.isVisibleFunc, own);
});
