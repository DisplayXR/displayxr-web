// The eyes-not-blank check against a real headless Chrome and the fixture page. A one-frame
// race (an eye missing from a single committed frame) must not fail the check; an eye that is
// never drawn must. Skipped where no Chrome is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from '../lib/check/cdp.mjs';
import { runCheck } from '../lib/check/run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const PAGE = join(HERE, 'fixtures', 'scene.html');
const skip = findChrome() ? false : 'no Chrome on this machine';
const eyes = (r) => r.checks.find((c) => c.id === 'eyes-not-blank');
// What the page did, for a failure message: did it reach a session, draw frames, log errors?
const why = (r) => r.checks.filter((c) => ['session', 'console', 'buffer'].includes(c.id)).map((c) => `${c.id}=${c.status}: ${c.summary}`).join(' | ');

test('an eye missing from 1 frame in 3 is not reported blank', { skip, timeout: 240000 }, async () => {
  for (let i = 0; i < 3; i++) {
    const r = await runCheck(`${PAGE}?bug=flicker-left`, { root: REPO, fallback: false });
    assert.equal(eyes(r).status, 'pass', `run ${i + 1}: ${eyes(r).summary} [${why(r)}]`);
  }
});

test('an eye that is never drawn still fails', { skip, timeout: 60000 }, async () => {
  const r = await runCheck(`${PAGE}?bug=blank-left`, { root: REPO, fallback: false });
  const c = eyes(r);
  assert.equal(c.status, 'fail', c.summary);
  assert.match(c.summary, /left eye/);
  assert.equal(c.details[0].right.blank, false, `the right eye must be drawn, or this proves nothing [${why(r)}]`);
  assert.equal(c.details[0].snapshots, 6, 'it looked again before failing');
});
