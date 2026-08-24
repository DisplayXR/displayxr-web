// Tests for version-check.js — the update prompt (displayxr-browser#154).
//
// The whole point of this check is that it is CORRECT ABOUT WHEN TO SAY NOTHING. A missed
// prompt costs one un-notified user; a wrong prompt puts "update DisplayXR Browser" in
// front of every Safari and Firefox reader on the open web, and a wrong COMPARISON nags a
// user who is already current, every page load, forever. So most of these pin silence.
//
// `evaluate()` and the helpers are pure, so all of this runs without a DOM or a network.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVersions,
  parseVersion,
  pickChromiumVersion,
  evaluate,
} from '../js/version-check.js';

const feed = (chromium, extra = {}) => ({
  latest: {
    version: '0.1.18',
    chromium,
    url: 'https://example.invalid/Setup.exe',
    ...extra,
  },
});

test('compareVersions orders numerically, not lexically', () => {
  // The trap: "9" > "10" as strings. Chromium build numbers cross that boundary constantly.
  assert.equal(compareVersions([151, 0, 7922, 9], [151, 0, 7922, 10]), -1);
  assert.equal(compareVersions([151, 0, 7922, 174], [151, 0, 7922, 77]), 1);
  assert.equal(compareVersions([152, 0, 1, 1], [151, 99, 99, 99]), 1);
  assert.equal(compareVersions([151, 0, 7922, 174], [151, 0, 7922, 174]), 0);
});

test('compareVersions zero-extends the shorter operand', () => {
  assert.equal(compareVersions([151, 0, 7922], [151, 0, 7922, 174]), -1);
  assert.equal(compareVersions([151, 0, 7922, 0], [151, 0, 7922]), 0);
});

test('parseVersion accepts dotted numbers and rejects everything else', () => {
  assert.deepEqual(parseVersion('151.0.7922.174'), [151, 0, 7922, 174]);
  assert.deepEqual(parseVersion(' 152.0.7977.54 '), [152, 0, 7977, 54]);
  assert.equal(parseVersion('151.0.7922.174-beta'), null);
  assert.equal(parseVersion('not-a-version'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion(undefined), null);
});

// ── The regression that the live browser caught, and unit tests had missed ───────────────
test('REGRESSION: the frozen UA version must never drive the comparison', () => {
  // Chromium's UA reduction reports Chrome/151.0.0.0 for a browser actually running
  // 151.0.7922.174. Comparing THAT against the feed made an up-to-date browser look
  // permanently out of date. evaluate() takes the true version, so the guard is that
  // 151.0.0.0 and the real version give opposite answers — proving they are not
  // interchangeable and that feeding the UA string here would be a bug.
  assert.notEqual(evaluate(feed('151.0.7922.174'), '151.0.0.0'), null); // what the UA would say
  assert.equal(evaluate(feed('151.0.7922.174'), '151.0.7922.174'), null); // the truth
});

test('pickChromiumVersion picks by BRAND, not by position', () => {
  // The GREASE decoy sits at a deliberately unstable index, so [0] is a coin flip.
  const list = [
    { brand: 'Not=A?Brand', version: '99.0.0.0' },
    { brand: 'Chromium', version: '151.0.7922.174' },
  ];
  assert.equal(pickChromiumVersion(list), '151.0.7922.174');
  assert.equal(pickChromiumVersion([...list].reverse()), '151.0.7922.174');
});

test('pickChromiumVersion returns null rather than guessing', () => {
  assert.equal(pickChromiumVersion([{ brand: 'Not=A?Brand', version: '99.0.0.0' }]), null);
  assert.equal(pickChromiumVersion([{ brand: 'Chromium', version: 'garbage' }]), null);
  assert.equal(pickChromiumVersion([]), null);
  assert.equal(pickChromiumVersion(undefined), null);
});

test('prompts when the feed is ahead of the running build', () => {
  const info = evaluate(feed('151.0.7922.174'), '151.0.7922.77');
  assert.ok(info);
  assert.equal(info.version, '0.1.18');
  assert.equal(info.chromium, '151.0.7922.174');
  assert.equal(info.security, false);
});

test('security releases are flagged, and only when the feed says so', () => {
  assert.equal(evaluate(feed('151.0.7922.174', { security: true }), '151.0.7922.77').security, true);
  // Anything other than a literal true is treated as not-a-security-release: over-claiming
  // "security" is the lie, under-claiming is merely quiet.
  assert.equal(evaluate(feed('151.0.7922.174', { security: 'yes' }), '151.0.7922.77').security, false);
});

test('says NOTHING when the running build is current or ahead', () => {
  assert.equal(evaluate(feed('151.0.7922.174'), '151.0.7922.174'), null);
  // A dev build ahead of the feed must not be told to "update" backwards.
  assert.equal(evaluate(feed('151.0.7922.174'), '152.0.7977.54'), null);
});

test('says NOTHING on a malformed or empty feed', () => {
  assert.equal(evaluate(null, '151.0.7922.77'), null);
  assert.equal(evaluate({}, '151.0.7922.77'), null);
  assert.equal(evaluate({ latest: {} }, '151.0.7922.77'), null);
  // A feed entry with no URL cannot produce a working prompt, so it must not produce one.
  assert.equal(evaluate({ latest: { chromium: '151.0.7922.174' } }, '151.0.7922.77'), null);
  // ...nor one with no chromium field to compare against.
  assert.equal(evaluate({ latest: { url: 'https://x.invalid/a.exe' } }, '151.0.7922.77'), null);
});

test('says NOTHING when the running version is unknown', () => {
  // runningChromiumVersion() returns null on non-Chromium / insecure contexts; that must
  // reach evaluate() as "say nothing", never as "assume out of date".
  assert.equal(evaluate(feed('151.0.7922.174'), null), null);
  assert.equal(evaluate(feed('151.0.7922.174'), ''), null);
});

test('says NOTHING when the feed version is unparseable', () => {
  assert.equal(evaluate(feed('not-a-version'), '151.0.7922.77'), null);
  assert.equal(evaluate(feed(''), '151.0.7922.77'), null);
});
