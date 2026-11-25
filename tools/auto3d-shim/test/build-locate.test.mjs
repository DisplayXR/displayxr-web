// node --test tools/auto3d-shim/test/build-locate.test.mjs
// build.mjs --locate maps VENDOR.json's sourceSha256 back to a commit on a ref. Needs git history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, locate } from '../build.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();
const shallow = git('rev-parse', '--is-shallow-repository') === 'true';

test('locate finds the HEAD commit that carries the committed sources', { skip: shallow && 'shallow clone' }, () => {
  const want = JSON.parse(readFileSync(join(root, 'VENDOR.json'), 'utf8')).sourceSha256;
  assert.equal(build(root).vendor.sourceSha256, want, 'committed VENDOR.json matches the sources');
  const { commit } = locate(root, 'HEAD');
  assert.ok(commit, 'a commit on HEAD carries the sources');
  git('merge-base', '--is-ancestor', commit, 'HEAD'); // throws if not on HEAD
  const last = git('log', '-1', '--format=%H', 'HEAD', '--', 'manifest.json', 'host-dev.js', 'sentinel.js', 'core.js', 'surface.js', 'guard.js', 'chip.js', 'dev.js', 'three-adapter.js', 'playcanvas-adapter.js', 'babylon-adapter.js');
  assert.equal(commit, last, 'the newest commit touching the sources');
});

test('locate returns null for a fingerprint no commit has', { skip: shallow && 'shallow clone' }, () => {
  assert.equal(locate(root, 'HEAD', '0'.repeat(64)).commit, null);
});
