// inline3d-tools gen — optional online asset generation behind one adapter interface, plus provenance.
//
//   inline3d-tools gen providers                   which adapters have a key in the environment (names only)
//   inline3d-tools gen run <adapter> --kind <kind> --prompt "<text>" [--image <url>] [--size WxH] --out <file> --confirm-paid
//   inline3d-tools gen provenance --file <path> --source "<where it came from>" --license "<licence>" [--notes "..."]
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
export const GEN_USAGE = 'usage: inline3d-tools gen providers | run <adapter> --kind <kind> --prompt "<text>" [--image <url>] [--size WxH] --out <file> --confirm-paid | provenance --file <f> --source <s> --license <l> [--notes <n>]';

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

export const ADAPTERS = {
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
    async run({ prompt, size }, key) {
      const r = await http('https://api.openai.com/v1/images/generations', { method: 'POST', body: JSON.stringify({ model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-flare', prompt, size: size || '1024x1024' }) }, key);
      const d = r.data[0];
      return d.b64_json ? Buffer.from(d.b64_json, 'base64') : download(d.url);
    },
  },
};

// ------------------------------------------------------------------------------ provenance
// The ledger is ASSETS.md in `cwd` (default: the process's working directory = the project root).
export function provenance({ file, source, license, notes, extra = {}, cwd = process.cwd() }) {
  const abs = resolve(cwd, file);
  const ledger = join(cwd, 'ASSETS.md');
  if (!existsSync(ledger)) writeFileSync(ledger, '# Assets\n\nWhere every 3D asset, texture and image on this page came from, and under what licence.\n\n| file | source | licence | date | notes |\n|---|---|---|---|---|\n');
  const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const row = `| ${esc(relative(cwd, abs))} | ${esc(source)} | ${esc(license)} | ${new Date().toISOString().slice(0, 10)} | ${esc([notes, ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`)].filter(Boolean).join('; '))} |\n`;
  appendFileSync(ledger, row);
  return ledger;
}

// ------------------------------------------------------------------------------ API
// Names and key presence only; never the key itself.
export function listProviders() {
  return Object.entries(ADAPTERS).map(([name, a]) => ({ name, env: a.env, keyPresent: !!process.env[a.env], kinds: a.kinds, cost: a.estimate() }));
}

export class GenError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// Runs one paid generation. Throws GenError with the CLI's exit code: 2 bad arguments, 3 no key in
// the environment, 4 not confirmed (no call made; the message carries the estimate), 1 provider error.
export async function genRun({ adapter, kind, prompt = '', image, size, out, confirmPaid = false, cwd = process.cwd() }) {
  const a = ADAPTERS[adapter];
  if (!a) throw new GenError(`unknown adapter "${adapter}" (known: ${Object.keys(ADAPTERS).join(', ')})`, 2);
  if (!a.kinds.includes(kind)) throw new GenError(`${adapter} does ${a.kinds.join(', ')}, not "${kind}"`, 2);
  if (!out) throw new GenError('run needs an output file (--out <file>)', 2);
  const key = process.env[a.env];
  if (!key) throw new GenError(`no ${a.env} in the environment: this adapter is unavailable (keys are read from the environment only)`, 3);
  if (confirmPaid !== true) {
    throw new GenError(`PAID CALL NOT MADE. ${adapter} ${kind} costs ${a.estimate()}.\nAsk the user to approve this one call, then re-run with --confirm-paid.`, 4);
  }
  let bytes;
  try {
    bytes = await a.run({ kind, prompt, image, size }, key);
  } catch (e) {
    throw new GenError(`${adapter} failed: ${String(e.message || e).split(key).join('[redacted]')}`, 1);
  }
  const abs = resolve(cwd, out);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
  const ledger = provenance({ file: abs, cwd, source: `generated: ${adapter} ${kind}`, license: a.terms, notes: prompt ? `prompt: ${prompt}` : image ? `from image ${image}` : '' });
  return { file: abs, bytes: bytes.length, ledger, message: `wrote ${out} (${(bytes.length / 1048576).toFixed(2)} MB); provenance in ${ledger}. Next: optimise + asset-check it.` };
}

// ------------------------------------------------------------------------------ CLI
// Returns the exit code.
export async function main(args) {
  const cmd = args[0];
  const opt = (k, d = undefined) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
  const flag = (k) => args.includes(`--${k}`);
  if (cmd === 'providers') {
    for (const p of listProviders()) {
      console.log(`${p.name.padEnd(8)} ${p.keyPresent ? 'key present' : 'no key'} (${p.env})  kinds: ${p.kinds.join(', ')}  cost: ${p.cost}`);
    }
    return 0;
  }
  if (cmd === 'provenance') {
    const file = opt('file');
    if (!file) { console.error('provenance needs --file'); return 2; }
    const l = provenance({ file, source: opt('source', 'unknown'), license: opt('license', 'unknown: check before shipping'), notes: opt('notes') });
    console.log(`recorded ${file} in ${l}`);
    return 0;
  }
  if (cmd === 'run') {
    try {
      const r = await genRun({ adapter: args[1], kind: opt('kind'), prompt: opt('prompt', ''), image: opt('image'), size: opt('size'), out: opt('out'), confirmPaid: flag('confirm-paid') });
      console.log(r.message);
      return 0;
    } catch (e) {
      console.error(e.message);
      return e.code || 1;
    }
  }
  console.error(GEN_USAGE);
  return cmd === '-h' || cmd === '--help' ? 0 : 2;
}
