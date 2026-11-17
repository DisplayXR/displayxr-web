// #299: a launch that misses only the DevTools handshake is retried once, with a fresh profile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChrome } from '../lib/check/cdp.mjs';

test('a silent DevTools pipe is retried once, then reported', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-retry-'));
  const log = join(dir, 'launches');
  const fake = join(dir, 'fake-chrome.sh');
  // Never answers on fd 4; records each launch and its --user-data-dir.
  writeFileSync(fake, `#!/bin/sh\nfor a in "$@"; do case "$a" in --user-data-dir=*) echo "$a" >> "${log}";; esac; done\nexec sleep 30\n`);
  chmodSync(fake, 0o755);
  // 3 s, not less: macOS scans a freshly written executable before it runs, which can take ~1 s.
  await assert.rejects(
    launchChrome({ chrome: fake, pipeTimeoutMs: 3000 }),
    (e) => /did not answer on the DevTools pipe/.test(e.message) && /after 2 attempts/.test(e.message),
  );
  const launches = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(launches.length, 2);
  assert.notEqual(launches[0], launches[1], 'each attempt gets its own profile');
  for (const l of launches) assert.equal(existsSync(l.slice('--user-data-dir='.length)), false, 'profiles are removed');
});

test('a missing Chrome is not retried', async () => {
  await assert.rejects(launchChrome({ chrome: '/nonexistent/chrome' }), /Chrome not found/);
});
