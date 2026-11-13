// End-to-end tests for inline3d-check: every check must PASS on the repo's samples and on the good
// fixture, and FAIL (or WARN, where the check is warn-level) on the fixture page that breaks it.
//
//   node --test --test-concurrency=1 plugins/displayxr-inline3d/checker/test/checker.e2e.mjs
//
// Needs Chrome (CHROME env, else the default install path). The samples load three.js / PlayCanvas
// from a CDN, so those cases need the network; the fixture cases do not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runCheck } from '../lib/run.mjs';
import { findChrome } from '../lib/cdp.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FIXTURE = 'plugins/displayxr-inline3d/checker/test/fixtures/scene.html';
const skip = findChrome() ? false : 'Chrome not found (set CHROME)';
const byId = (r, id) => r.checks.find((c) => c.id === id);

function show(r) {
  return r.checks.map((c) => `${c.status.padEnd(4)} ${c.id}: ${c.summary}`).join('\n');
}

async function run(path, opt = {}) {
  const prev = process.cwd();
  process.chdir(REPO);
  try {
    return await runCheck(path, { root: REPO, ...opt });
  } finally {
    process.chdir(prev);
  }
}

// ---- known-good pages: no check fails -----------------------------------------------------
for (const sample of ['samples/hello-cube/', 'samples/model/', 'samples/splat/', 'samples/player/', `${FIXTURE}`]) {
  test(`good: ${sample} has no failing check`, { skip, timeout: 90000 }, async () => {
    const r = await run(sample);
    const failed = r.checks.filter((c) => c.status === 'fail');
    assert.equal(failed.length, 0, show(r));
    for (const id of ['session', 'stereo', 'eyes-not-blank', 'fallback-2d']) assert.equal(byId(r, id).status, 'pass', `${id}\n${show(r)}`);
    assert.ok(r.durationMs < 45000, `took ${r.durationMs} ms`);
  });
}

test('good fixture is clean: verdict pass (cover comes off, no join-window exposure)', { skip, timeout: 60000 }, async () => {
  const r = await run(FIXTURE);
  assert.equal(r.verdict, 'pass', show(r));
  assert.equal(r.info.rig.type, 'display');
  assert.equal(r.info.rig.virtualDisplayHeight, 0.12);
});

// ---- one broken page per check -------------------------------------------------------------
test('camera rig: reported with its comfort number, real stereo', { skip, timeout: 60000 }, async () => {
  const r = await run(`${FIXTURE}?rig=camera`);
  assert.equal(r.info.rig.type, 'camera', show(r));
  assert.ok(Math.abs(r.info.comfort - 0.65 / 0.26) < 0.01, `comfort ${r.info.comfort}`);
  assert.equal(byId(r, 'stereo').status, 'pass', show(r));
});

const CASES = [
  // [bug, check id, expected status, options]
  ['no-session', 'session', 'fail'],
  ['same-eyes', 'stereo', 'fail'],
  ['black', 'eyes-not-blank', 'fail'],
  ['flat-wide', 'no-flat-sbs', 'fail'],
  ['sbs-flat-fallback', 'no-flat-sbs', 'fail'],
  ['huge-buffer', 'buffer', 'fail', { maxTexture: 4096 }],
  ['huge-buffer', 'buffer', 'warn'],
  ['css-filter', 'css', 'fail'],
  ['css-opacity', 'css', 'fail'],
  ['css-transform', 'css', 'fail'],
  ['two-sessions', 'single-session', 'fail'],
  ['opaque-overlay', 'overlay', 'fail'],
  ['stuck-cover', 'overlay', 'fail'],
  ['console-error', 'console', 'fail'],
  ['gl-error', 'console', 'fail'],
  ['no-fallback', 'fallback-2d', 'fail'],
  ['issupported', 'detection', 'warn'],
  ['noop-layerlost', 'layer-lost', 'fail'],
  ['sticky-blend', 'overlay', 'warn'],
];
for (const [bug, id, expected, opt] of CASES) {
  test(`broken: ?bug=${bug} -> ${id} ${expected}${opt ? ` ${JSON.stringify(opt)}` : ''}`, { skip, timeout: 60000 }, async () => {
    const r = await run(`${FIXTURE}?bug=${bug}`, opt);
    assert.equal(byId(r, id).status, expected, show(r));
    if (expected === 'fail') assert.equal(r.verdict, 'fail');
  });
}

test('good fixture: opaque sticky header + buy card over part of the tile pass; layer loss goes flat', { skip, timeout: 60000 }, async () => {
  const r = await run(FIXTURE);
  assert.equal(byId(r, 'overlay').status, 'pass', show(r));
  assert.equal(byId(r, 'layer-lost').status, 'pass', show(r));
});

test('stuck cover is reported as a cover that never came off', { skip, timeout: 60000 }, async () => {
  const r = await run(`${FIXTURE}?bug=stuck-cover`);
  assert.match(byId(r, 'overlay').summary, /never came off/, show(r));
});
