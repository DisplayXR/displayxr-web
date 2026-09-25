// Tests for js/lift/providers/registry.js — priority resolution the native / vendor providers rely on.

import test from 'node:test';
import assert from 'node:assert/strict';
import { getRegistry } from '../js/lift/providers/registry.js';

test('getRegistry is a process-wide singleton', () => {
  assert.equal(getRegistry(), getRegistry());
});

test('highest priority wins; prefer overrides; kinds and availability filter', () => {
  const r = getRegistry();
  const fa = () => 'a', fb = () => 'b', fc = () => 'c';
  const offA = r.registerDepthProvider('t-a', fa, { priority: 0 });
  const offB = r.registerDepthProvider('t-b', fb, { priority: 10, kinds: ['still'] });
  let up = false;
  const offC = r.registerDepthProvider('t-c', fc, { priority: 20, available: () => up });
  try {
    assert.equal(r.resolve('video').name, 't-a');           // b is still-only, c unavailable
    assert.equal(r.resolve('still').name, 't-b');
    up = true;
    assert.equal(r.resolve('video').name, 't-c');
    assert.equal(r.resolve('video', 't-a').name, 't-a');   // explicit preference
    assert.equal(r.resolve('video', 't-b').name, 't-c');   // preference that can't serve the kind is ignored
    assert.equal(r.resolve('nope'), null);
  } finally { offA(); offB(); offC(); }
});

test('re-registering a name replaces it; ties go to the latest registration', () => {
  const r = getRegistry();
  const off1 = r.registerDepthProvider('t-x', () => 1, { priority: 5 });
  const off2 = r.registerDepthProvider('t-y', () => 2, { priority: 5 });
  try {
    assert.equal(r.resolve('video').name, 't-y');
    r.registerDepthProvider('t-x', () => 3, { priority: 5 });
    assert.equal(r.resolve('video').name, 't-x');
    assert.equal(r.resolve('video').factory(), 3);
    assert.equal(r.list().filter((e) => e.name === 't-x').length, 1);
  } finally { off1(); off2(); getRegistry().registerDepthProvider('t-x', () => 0, {})(); }
});

test('getDepthProvider: registered name → that factory; model/family name → best provider with model set', () => {
  const r = getRegistry();
  const seen = [];
  const off = r.registerDepthProvider('t-best', (o) => { seen.push(o); return { id: 't-best' }; }, { priority: 50 });
  try {
    r.getDepthProvider('moge3', { quality: 'high' });
    assert.deepEqual(seen.at(-1), { quality: 'high', kind: 'still', model: 'moge3' });
    r.getDepthProvider('vda-small', {});
    assert.equal(seen.at(-1).kind, 'video');
    r.getDepthProvider('t-best', { kind: 'video', model: 'vda-small' });
    assert.deepEqual(seen.at(-1), { kind: 'video', model: 'vda-small' });
  } finally { off(); }
});

test('getInpainter: family name reaches the best inpainter as `model`', () => {
  const r = getRegistry();
  const seen = [];
  const off = r.registerInpainter('t-inp', (o) => { seen.push(o); return {}; }, { priority: 50 });
  try {
    r.getInpainter('light-inpaint-v1', { quality: 'high' });
    assert.deepEqual(seen.at(-1), { quality: 'high', model: 'light-inpaint-v1' });
    r.getInpainter('t-inp', { quality: 'low' });
    assert.deepEqual(seen.at(-1), { quality: 'low' });
  } finally { off(); }
});
