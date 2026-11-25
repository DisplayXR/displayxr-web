// The `backdrop-on-glass` check (rule 10): a page image under a see-through woven canvas sits on
// the glass; WARN when the content reaches behind it. Verdict first (no browser), then the real
// probe against headless Chrome and the fixture page (skipped where Chrome cannot draw WebGL).
//   node --test tools/inline3d-tools/test/backdrop-on-glass.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backdropOnGlass, shibataZoneMm } from '../lib/check/analyze.mjs';
import { findChrome } from '../lib/check/cdp.mjs';
import { runCheck } from '../lib/check/run.mjs';

const zone = shibataZoneMm(0.65); // ≈ 25 mm behind
const spread = (lo, hi, n = 40) => Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
const img = (kind = 'css', f = 1) => ({ total: 54, imageFraction: f, sources: [{ selector: '#stage', kind, hits: Math.round(54 * f) }] });
const none = { total: 54, imageFraction: 0, sources: [] };

test('a CSS image through a see-through canvas, content behind the glass: WARN naming rule 10', () => {
  const r = backdropOnGlass(img(), 0.6, spread(-6, 9), zone);
  assert.equal(r.status, 'warn', r.summary);
  assert.match(r.summary, /CSS background-image \(#stage\)/);
  assert.match(r.hint, /Rule 10/);
  assert.match(r.hint, /backdropPlacement\(\)/);
  assert.match(backdropOnGlass(img('video'), 0.6, spread(-6, 9), zone).summary, /a <video>/);
});

test('never more than a WARN, and quiet when any one condition is missing', () => {
  assert.equal(backdropOnGlass(none, 0.6, spread(-6, 9), zone).status, 'pass'); // no image
  assert.equal(backdropOnGlass(img('css', 0.05), 0.6, spread(-6, 9), zone).status, 'pass'); // a sliver of one
  assert.equal(backdropOnGlass(img(), 0.02, spread(-6, 9), zone).status, 'pass'); // opaque canvas
  assert.equal(backdropOnGlass(img(), 0.6, spread(-8, 1.5), zone).status, 'pass'); // content on / in front of the glass
});

test('nothing to judge: skip', () => {
  assert.equal(backdropOnGlass(null, 0.6, spread(-6, 9), zone).status, 'skip');
  assert.equal(backdropOnGlass(img(), null, spread(-6, 9), zone).status, 'skip');
  assert.equal(backdropOnGlass(img(), 0.6, [1, 2], zone).status, 'skip');
});

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const PAGE = join(HERE, 'fixtures', 'scene.html');
const find = (r) => r.checks.find((c) => c.id === 'backdrop-on-glass');
let skip = findChrome() ? false : 'no Chrome on this machine';
let base = null;
if (!skip) {
  base = await runCheck(PAGE, { root: REPO, fallback: false });
  const c = base.checks.find((x) => x.id === 'eyes-not-blank');
  if (c.status !== 'pass') skip = `this Chrome cannot render the fixture (${c.summary}); WebGL unavailable?`;
}

test('fixture: the good page passes; a see-through canvas over a page image warns; an opaque one does not', { skip, timeout: 180000 }, async () => {
  assert.equal(find(base).status, 'pass', find(base).summary);
  const bad = find(await runCheck(`${PAGE}?bug=css-backdrop&rig=camera`, { root: REPO, fallback: false }));
  assert.equal(bad.status, 'warn', `${bad.summary} ${JSON.stringify(bad.details)}`);
  assert.equal(bad.details.sources[0].selector, '#stage');
  const opaque = find(await runCheck(`${PAGE}?bug=css-backdrop-opaque&rig=camera`, { root: REPO, fallback: false }));
  assert.equal(opaque.status, 'pass', opaque.summary);
  assert.match(opaque.summary, /canvas is opaque/);
});
