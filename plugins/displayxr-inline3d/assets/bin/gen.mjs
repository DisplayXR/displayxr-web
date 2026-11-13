#!/usr/bin/env node
// gen — optional online asset generation behind one adapter interface, plus provenance.
//
//   node gen.mjs providers                         which adapters have a key in the environment (names only)
//   node gen.mjs run <adapter> --kind <kind> --prompt "<text>" [--image <url>] --out <file> --confirm-paid
//   node gen.mjs provenance --file <path> --source "<where it came from>" --license "<licence>" [--notes "..."]
//
// Kinds: text-to-3d, image-to-3d (3D adapters, output .glb), image (image adapter, output .png:
// textures, posters, HDR-free backdrops).
//
// RULES (the skill repeats them): keys come ONLY from the environment and are never printed,
// logged, written to a file or committed. Every paid call needs --confirm-paid, which the agent
// passes only after the user said yes to that call and its estimated cost. Every output gets an
// ASSETS.md entry (provider, kind, prompt, date, licence note) next to it.
import { writeFileSync, appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (k, d = undefined) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);

// ------------------------------------------------------------------------------ adapters
// Each adapter: { env, kinds, estimate(kind), terms, async run({ kind, prompt, image }) -> Buffer }.
// Endpoints follow each provider's public developer API; they are not exercised by this repo's
// tests (no keys in CI). An adapter that fails says which HTTP status it got and stops.
async function http(url, init, key) {
  const r = await fetch(url, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(init.headers || {}) } });
  const text = await r.text();
  if (!r.ok) throw new Error(`${new URL(url).host} answered HTTP ${r.status}: ${text.slice(0, 300).replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')}`);
  try { return JSON.parse(text); } catch { return text; }
}
async function download(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
async function poll(fn, { everyMs = 5000, maxMs = 15 * 60_000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > maxMs) throw new Error('timed out waiting for the task');
    await sleep(everyMs);
  }
}

const ADAPTERS = {
  meshy: {
    env: 'MESHY_API_KEY',
    kinds: ['text-to-3d', 'image-to-3d'],
    estimate: () => 'a few US$ per model at list price (preview + refine); check the provider\'s current pricing',
    terms: 'Meshy terms of service: check the licence of generated models for your plan before shipping',
    async run({ kind, prompt, image }, key) {
      const base = 'https://api.meshy.ai/openapi';
      let path, id;
      if (kind === 'text-to-3d') {
        path = `${base}/v2/text-to-3d`;
        id = (await http(path, { method: 'POST', body: JSON.stringify({ mode: 'preview', prompt }) }, key)).result;
        await poll(async () => { const t = await http(`${path}/${id}`, { method: 'GET' }, key); if (t.status === 'FAILED') throw new Error('task failed'); return t.status === 'SUCCEEDED' ? t : null; });
        id = (await http(path, { method: 'POST', body: JSON.stringify({ mode: 'refine', preview_task_id: id }) }, key)).result;
      } else {
        path = `${base}/v1/image-to-3d`;
        id = (await http(path, { method: 'POST', body: JSON.stringify({ image_url: image, enable_pbr: true }) }, key)).result;
      }
      const done = await poll(async () => { const t = await http(`${path}/${id}`, { method: 'GET' }, key); if (t.status === 'FAILED') throw new Error('task failed'); return t.status === 'SUCCEEDED' ? t : null; });
      return download(done.model_urls.glb);
    },
  },
  tripo: {
    env: 'TRIPO_API_KEY',
    kinds: ['text-to-3d', 'image-to-3d'],
    estimate: () => 'tens of provider credits per model (roughly US$0.2–1); check the provider\'s current pricing',
    terms: 'Tripo terms of service: check the licence of generated models for your plan before shipping',
    async run({ kind, prompt, image }, key) {
      const base = 'https://api.tripo3d.ai/v2/openapi';
      const body = kind === 'text-to-3d' ? { type: 'text_to_model', prompt } : { type: 'image_to_model', file: { type: 'jpg', url: image } };
      const id = (await http(`${base}/task`, { method: 'POST', body: JSON.stringify(body) }, key)).data.task_id;
      const done = await poll(async () => { const t = (await http(`${base}/task/${id}`, { method: 'GET' }, key)).data; if (['failed', 'cancelled', 'banned', 'expired'].includes(t.status)) throw new Error(`task ${t.status}`); return t.status === 'success' ? t : null; });
      const url = done.output.pbr_model || done.output.model;
      return download(url);
    },
  },
  openai: {
    env: 'OPENAI_API_KEY',
    kinds: ['image'],
    estimate: () => 'a few US cents to ~US$0.25 per image depending on size/quality; check the provider\'s current pricing',
    terms: 'OpenAI usage policies: you own generated images subject to their terms',
    async run({ prompt }, key) {
      const r = await http('https://api.openai.com/v1/images/generations', { method: 'POST', body: JSON.stringify({ model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1', prompt, size: opt('size', '1024x1024') }) }, key);
      const d = r.data[0];
      return d.b64_json ? Buffer.from(d.b64_json, 'base64') : download(d.url);
    },
  },
};

// ------------------------------------------------------------------------------ provenance
function provenance({ file, source, license, notes, extra = {} }) {
  const abs = resolve(file);
  const ledger = join(process.cwd(), 'ASSETS.md');
  if (!existsSync(ledger)) writeFileSync(ledger, '# Assets\n\nWhere every 3D asset, texture and image on this page came from, and under what licence.\n\n| file | source | licence | date | notes |\n|---|---|---|---|---|\n');
  const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const row = `| ${esc(relative(process.cwd(), abs))} | ${esc(source)} | ${esc(license)} | ${new Date().toISOString().slice(0, 10)} | ${esc([notes, ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`)].filter(Boolean).join('; '))} |\n`;
  appendFileSync(ledger, row);
  return ledger;
}

// ------------------------------------------------------------------------------ main
if (cmd === 'providers') {
  for (const [name, a] of Object.entries(ADAPTERS)) {
    console.log(`${name.padEnd(8)} ${process.env[a.env] ? 'key present' : 'no key'} (${a.env})  kinds: ${a.kinds.join(', ')}  cost: ${a.estimate()}`);
  }
  process.exit(0);
}
if (cmd === 'provenance') {
  const file = opt('file');
  if (!file) { console.error('provenance needs --file'); process.exit(2); }
  const l = provenance({ file, source: opt('source', 'unknown'), license: opt('license', 'unknown: check before shipping'), notes: opt('notes') });
  console.log(`recorded ${file} in ${l}`);
  process.exit(0);
}
if (cmd === 'run') {
  const name = args[1];
  const a = ADAPTERS[name];
  const kind = opt('kind');
  const prompt = opt('prompt', '');
  const out = opt('out');
  if (!a) { console.error(`unknown adapter "${name}" (known: ${Object.keys(ADAPTERS).join(', ')})`); process.exit(2); }
  if (!a.kinds.includes(kind)) { console.error(`${name} does ${a.kinds.join(', ')}, not "${kind}"`); process.exit(2); }
  if (!out) { console.error('run needs --out <file>'); process.exit(2); }
  const key = process.env[a.env];
  if (!key) { console.error(`no ${a.env} in the environment: this adapter is unavailable (keys are read from the environment only)`); process.exit(3); }
  if (!flag('confirm-paid')) {
    console.error(`PAID CALL NOT MADE. ${name} ${kind} costs ${a.estimate()}.\nAsk the user to approve this one call, then re-run with --confirm-paid.`);
    process.exit(4);
  }
  try {
    const bytes = await a.run({ kind, prompt, image: opt('image') }, key);
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, bytes);
    const l = provenance({ file: out, source: `generated: ${name} ${kind}`, license: a.terms, notes: prompt ? `prompt: ${prompt}` : opt('image') ? `from image ${opt('image')}` : '' });
    console.log(`wrote ${out} (${(bytes.length / 1048576).toFixed(2)} MB); provenance in ${l}. Next: optimise + asset-check it.`);
  } catch (e) {
    console.error(`${name} failed: ${String(e.message || e).replace(key, '[redacted]')}`);
    process.exit(1);
  }
  process.exit(0);
}
console.error('usage: gen.mjs providers | run <adapter> --kind <kind> --prompt "<text>" --out <file> --confirm-paid | provenance --file <f> --source <s> --license <l>');
process.exit(2);
