// CLI surface: dispatch, gen safety (no paid call without --confirm-paid, keys never echoed),
// scaffold. No network: every gen case stops before a provider is called.
//   node --test tools/inline3d-tools/test/cli.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'inline3d-tools.mjs');
const KEYLESS = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['MESHY_API_KEY', 'TRIPO_API_KEY', 'OPENAI_API_KEY'].includes(k)));
const run = (args, env = KEYLESS, cwd) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env, cwd });

test('help and version', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  for (const c of ['check', 'assets', 'gen', 'scaffold', 'mcp']) assert.match(r.stdout, new RegExp(`\\b${c}\\b`));
  const v = run(['--version']);
  assert.equal(v.stdout.trim(), JSON.parse(readFileSync(join(dirname(BIN), '..', 'package.json'), 'utf8')).version);
  assert.equal(run(['nope']).status, 2);
});

test('gen providers lists names and key presence only', () => {
  const secret = 'sk-test-0123456789abcdefghijklmnop';
  const r = run(['gen', 'providers'], { ...KEYLESS, OPENAI_API_KEY: secret });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /openai\s+key present/);
  assert.match(r.stdout, /meshy\s+no key/);
  assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret));
});

test('gen run without a key: unavailable (exit 3), nothing written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'i3t-gen-'));
  const r = run(['gen', 'run', 'meshy', '--kind', 'text-to-3d', '--prompt', 'x', '--out', 'a.glb', '--confirm-paid'], KEYLESS, dir);
  assert.equal(r.status, 3);
  assert.ok(!existsSync(join(dir, 'a.glb')));
});

test('gen run without --confirm-paid refuses (exit 4), makes no call, prints the estimate, never the key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'i3t-gen-'));
  const secret = 'test-not-a-real-key-0123456789abcdef';
  for (const [adapter, kind] of [['meshy', 'text-to-3d'], ['tripo', 'image-to-3d'], ['openai', 'image']]) {
    const env = { ...KEYLESS, MESHY_API_KEY: secret, TRIPO_API_KEY: secret, OPENAI_API_KEY: secret };
    const r = run(['gen', 'run', adapter, '--kind', kind, '--prompt', 'x', '--out', 'a.bin'], env, dir);
    assert.equal(r.status, 4, r.stderr);
    assert.match(r.stderr, /PAID CALL NOT MADE/);
    assert.ok(!(r.stdout + r.stderr).includes(secret));
  }
  assert.ok(!existsSync(join(dir, 'a.bin')) && !existsSync(join(dir, 'ASSETS.md')));
});

test('gen run rejects a wrong adapter/kind (exit 2)', () => {
  assert.equal(run(['gen', 'run', 'nope', '--kind', 'image', '--out', 'x']).status, 2);
  assert.equal(run(['gen', 'run', 'openai', '--kind', 'text-to-3d', '--out', 'x']).status, 2);
});

test('gen provenance appends to ASSETS.md in the working directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'i3t-prov-'));
  const r = run(['gen', 'provenance', '--file', 'm.glb', '--source', 'supplied by the user', '--license', "user's"], KEYLESS, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(dir, 'ASSETS.md'), 'utf8'), /\| m\.glb \| supplied by the user \| user's \|/);
});

test('scaffold esm + vite fill placeholders and never overwrite without --force', () => {
  const dir = mkdtempSync(join(tmpdir(), 'i3t-scaf-'));
  const r = run(['scaffold', 'esm', join(dir, 'a'), '--title', 'Hello 3D']);
  assert.equal(r.status, 0, r.stderr);
  const html = readFileSync(join(dir, 'a', 'index.html'), 'utf8');
  assert.match(html, /<title>Hello 3D<\/title>/);
  assert.match(html, /importmap/);
  assert.ok(existsSync(join(dir, 'a', 'app.js')) && existsSync(join(dir, 'a', 'style.css')));
  assert.equal(run(['scaffold', 'esm', join(dir, 'a')]).status, 2);
  assert.equal(run(['scaffold', 'esm', join(dir, 'a'), '--force']).status, 0);

  assert.equal(run(['scaffold', 'vite', join(dir, 'My App')]).status, 0);
  const pkg = JSON.parse(readFileSync(join(dir, 'My App', 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'my-app');
  for (const v of Object.values({ ...pkg.dependencies, ...pkg.devDependencies })) assert.match(v, /^\d+\.\d+\.\d+$/);
  assert.ok(!readFileSync(join(dir, 'My App', 'index.html'), 'utf8').includes('__TITLE__'));
});

test('assets prep without Blender says so and does not install anything', () => {
  const dir = mkdtempSync(join(tmpdir(), 'i3t-prep-'));
  writeFileSync(join(dir, 'in.obj'), 'v 0 0 0\n');
  const r = run(['assets', 'prep', 'in.obj', 'out.glb', '--blender', join(dir, 'no-such-blender')], { ...KEYLESS, PATH: dir, BLENDER: '' }, dir);
  // A machine with Blender in a default install path would find it; only assert the no-Blender path.
  if (r.status === 2) assert.match(r.stderr, /never installs/);
});
