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
  pickDisplayXRVersion,
  platformKey,
  selectFeedEntry,
  evaluate,
  FIRST_BRANDED_RELEASE,
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

// ── DisplayXR release comparison (browser-pvt patch 0245) ────────────────────────────────
// 1.0.5 and 1.0.6 both ship Chromium 154.0.8037.17, so the Chromium-only check could never
// tell a 1.0.5 user about 1.0.6. The browser now names its release in fullVersionList.

const CR = '154.0.8037.17';
const entry = (version, extra = {}) => ({
  version,
  chromium: CR,
  url: `https://example.invalid/DisplayXR-Browser-Setup-${version}.exe`,
  notes: `https://example.invalid/releases/tag/v${version}`,
  ...extra,
});
// The live feed's shape: legacy top-level `latest` (Windows) + per-platform entries.
const pfeed = (win, android, extra = {}) => ({
  latest: entry(win),
  platforms: {
    windows: entry(win),
    android: entry(android, { url: `https://example.invalid/DisplayXR-Browser-${android}-android-arm64.apk` }),
  },
  ...extra,
});
const run = (displayxr, platform = 'Windows', chromium = CR) =>
  ({ chromium, displayxr, branded: displayxr != null, platform });

test('pickDisplayXRVersion picks the DisplayXR brand, not GREASE or Chromium', () => {
  const list = [
    { brand: 'Not=A?Brand', version: '99.0.0.0' },
    { brand: 'Chromium', version: CR },
    { brand: 'DisplayXR Browser', version: '1.0.7' },
  ];
  assert.equal(pickDisplayXRVersion(list), '1.0.7');
  assert.equal(pickDisplayXRVersion([...list].reverse()), '1.0.7');
  assert.equal(pickChromiumVersion(list), CR); // and it does not disturb the Chromium pick
});

test('pickDisplayXRVersion returns null for absent or unlabelled builds', () => {
  assert.equal(pickDisplayXRVersion([{ brand: 'Chromium', version: CR }]), null);
  // The build lane's placeholder: a dev build must not be compared as a release.
  assert.equal(pickDisplayXRVersion([{ brand: 'DisplayXR Browser', version: '0.0.0-dev' }]), null);
  assert.equal(pickDisplayXRVersion(undefined), null);
});

test('same Chromium, newer DisplayXR release: PROMPTS (the bug this fixes)', () => {
  const info = evaluate(pfeed('1.0.8', '1.0.8'), run('1.0.7'));
  assert.ok(info);
  assert.equal(info.version, '1.0.8');
  assert.equal(info.dismissKey, '1.0.8'); // dismissal keyed on the DisplayXR release
});

test('same DisplayXR release: says NOTHING', () => {
  assert.equal(evaluate(pfeed('1.0.7', '1.0.7'), run('1.0.7')), null);
});

test('DisplayXR release ahead of the feed: says NOTHING, even if Chromium is behind', () => {
  // The DisplayXR comparison decides when both sides carry a release.
  assert.equal(evaluate(pfeed('1.0.7', '1.0.7'), run('1.0.8', 'Windows', '153.0.8010.37')), null);
});

test('PRE-BRAND browser (1.0.5/1.0.6) is told about the first branded release', () => {
  // No "DisplayXR Browser" entry in a DisplayXR Browser = older than FIRST_BRANDED_RELEASE,
  // whatever its Chromium says.
  const info = evaluate(pfeed(FIRST_BRANDED_RELEASE, FIRST_BRANDED_RELEASE), run(null));
  assert.ok(info);
  assert.equal(info.version, FIRST_BRANDED_RELEASE);
  assert.equal(info.dismissKey, FIRST_BRANDED_RELEASE);
});

test('pre-brand inference never fires for feeds older than the first branded release', () => {
  // A 1.0.6 feed must not nag a pre-brand browser that is already on 1.0.6's Chromium.
  assert.equal(evaluate(pfeed('1.0.6', '1.0.6'), run(null)), null);
});

test('pre-brand inference needs branded === false, not merely a missing release', () => {
  // A Chromium-string caller (original signature) keeps the Chromium comparison.
  assert.equal(evaluate(pfeed('1.0.7', '1.0.7'), CR), null);
  // An UNLABELLED branded build (0.0.0-dev) falls back to Chromium too: silent here.
  assert.equal(evaluate(pfeed('1.0.7', '1.0.7'), { chromium: CR, displayxr: null, branded: true, platform: 'Windows' }), null);
});

test('no feed version: falls back to the Chromium comparison', () => {
  const f = { latest: { chromium: '154.0.8037.40', url: 'https://example.invalid/a.exe' } };
  const info = evaluate(f, run('1.0.7'));
  assert.ok(info);
  assert.equal(info.dismissKey, '154.0.8037.40'); // Chromium-keyed, as before
  assert.equal(evaluate({ latest: { chromium: CR, url: 'https://x.invalid/a.exe' } }, run('1.0.7')), null);
});

// ── Per-platform feed entry (browser-pvt docs/auto-update-design.md, migration step 2) ──

test('platformKey maps userAgentData.platform', () => {
  assert.equal(platformKey('Windows'), 'windows');
  assert.equal(platformKey('Android'), 'android');
  assert.equal(platformKey('Linux'), 'linux');
  assert.equal(platformKey('macOS'), null);
  assert.equal(platformKey(''), null);
  assert.equal(platformKey(undefined), null);
});

test('Android is offered the APK, never the Windows .exe', () => {
  const info = evaluate(pfeed('1.0.8', '1.0.8'), run('1.0.7', 'Android'));
  assert.ok(info);
  assert.match(info.url, /android-arm64\.apk$/);
  assert.equal(info.platform, 'android');
});

test('platforms are independent: an Android release does not prompt Windows', () => {
  assert.equal(evaluate(pfeed('1.0.7', '1.0.8'), run('1.0.7', 'Windows')), null);
  assert.ok(evaluate(pfeed('1.0.7', '1.0.8'), run('1.0.7', 'Android')));
});

test('Android with no platforms entry says NOTHING (does not fall back to the .exe)', () => {
  const legacy = { latest: entry('1.0.8') };
  assert.equal(evaluate(legacy, run('1.0.7', 'Android')), null);
  assert.equal(selectFeedEntry(legacy, 'android'), null);
  assert.equal(selectFeedEntry(legacy, 'linux'), null);
});

test('Windows and unknown platforms fall back to the legacy top-level latest', () => {
  const legacy = { latest: entry('1.0.8') };
  assert.equal(selectFeedEntry(legacy, 'windows'), legacy.latest);
  assert.equal(selectFeedEntry(legacy, null), legacy.latest);
  assert.ok(evaluate(legacy, run('1.0.7', 'Windows')));
  assert.ok(evaluate(legacy, run('1.0.7', undefined)));
});

test('Linux entries link the release notes (apt updates), not a download', () => {
  const f = { latest: entry('1.0.8'), platforms: { linux: entry('1.0.8', { url: 'https://example.invalid/a.deb' }) } };
  const info = evaluate(f, run('1.0.7', 'Linux'));
  assert.ok(info);
  assert.equal(info.platform, 'linux');
  assert.equal(info.notes, 'https://example.invalid/releases/tag/v1.0.8');
});

test('the LIVE feed shape (1.0.6 on both platforms) nags nobody already on 1.0.6+', () => {
  const live = pfeed('1.0.6', '1.0.6');
  assert.equal(evaluate(live, run('1.0.7', 'Windows')), null);
  assert.equal(evaluate(live, run('1.0.7', 'Android')), null);
  assert.equal(evaluate(live, run(null, 'Windows')), null); // a 1.0.6 install
});
