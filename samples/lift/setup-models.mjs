#!/usr/bin/env node
// Download the Convert-to-3D models for the lift sample into _scratch/models/<path>,
// verifying each file's sha256 against js/lift/models.json. Default = the installer set;
// pass --all to include the on-demand (A/B) models too. Re-runs skip verified files.
//
//   node samples/lift/setup-models.mjs [--all] [--dest <dir>]
//
// Blobs come from the public content-addressed release the manifest's blobBaseUrl names.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const args = process.argv.slice(2);
const all = args.includes('--all');
const destIdx = args.indexOf('--dest');
const dest = resolve(destIdx >= 0 ? args[destIdx + 1] : join(root, '_scratch', 'models'));

const manifest = JSON.parse(await readFile(join(root, 'js', 'lift', 'models.json'), 'utf8'));
const base = manifest.blobBaseUrl.replace(/\/$/, '');

async function sha256(path) {
  const h = createHash('sha256');
  await pipeline((await import('node:fs')).createReadStream(path), h);
  return h.digest('hex');
}

let bytes = 0;
for (const m of manifest.models) {
  if (!all && m.installer === false) { console.log(`skip  ${m.name} (on-demand; use --all)`); continue; }
  for (const f of m.files) {
    const out = join(dest, f.path);
    try {
      const s = await stat(out);
      if (s.size === f.size && (await sha256(out)) === f.sha256) { console.log(`ok    ${f.path}`); continue; }
    } catch {}
    const url = f.url || `${base}/${f.sha256}.${m.format}`;
    console.log(`fetch ${f.path}  (${(f.size / 1e6).toFixed(0)} MB)`);
    await mkdir(dirname(out), { recursive: true });
    const part = `${out}.part`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    await pipeline(res.body, createWriteStream(part));
    const got = await sha256(part);
    if (got !== f.sha256) { await unlink(part); throw new Error(`${f.path}: sha256 mismatch (${got})`); }
    await rename(part, out);
    bytes += f.size;
    console.log(`done  ${f.path}`);
  }
}
console.log(`\nmodels in ${dest}  (${(bytes / 1e9).toFixed(2)} GB downloaded this run)`);
console.log(`serve the repo root and open samples/lift/index.html — the sample looks for /_scratch/models by default.`);
