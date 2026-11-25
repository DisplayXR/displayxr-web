#!/usr/bin/env node
// tools/signal-keys.mjs — issue / revoke / inspect publishable keys for the hosted dxr-signal/1
// service, BY HAND (RFC 0003 Decision 4). A key is a KV record (`key:<pk_…>` → JSON) in the
// deployment's KEYS namespace; this script drives `wrangler kv` against that namespace, so it
// needs a logged-in wrangler (`npx wrangler login`) and nothing else — no admin token.
//
//   node tools/signal-keys.mjs issue  --origins https://app.example,https://*.example.com [--note "Acme"] [--limits '{"rooms":100}'] [--env staging]
//   node tools/signal-keys.mjs revoke pk_…            [--env staging]
//   node tools/signal-keys.mjs show   pk_…            [--env staging]
//   node tools/signal-keys.mjs list                   [--env staging]
//   node tools/signal-keys.mjs block   203.0.113.9    [--env staging]   # IP blocklist (abuse)
//   node tools/signal-keys.mjs unblock 203.0.113.9    [--env staging]
//
// `--env prod` (default) uses signaling/deploy/displayxr.toml; `--env staging` the staging config.
// Origins: exact (`https://app.example`), one-label wildcard (`https://*.example.com`),
// `http://localhost` (any port), or `*` (any origin — attribution only). KV is eventually
// consistent: a new or revoked key takes up to ~60 s to be seen everywhere.
//
// The same records can be managed over HTTPS with the Worker's /admin/keys/<id> endpoints
// (GET / PUT / DELETE, `Authorization: Bearer <ADMIN_TOKEN>`) — see signaling/README.md.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { newKeyId, parseKeyRecord, KEY_RE } from '../signaling/keys.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i > 0 ? argv[i + 1] : dflt;
};
const env = opt('env', 'prod');
const config = resolve(root, 'signaling/deploy', env === 'prod' ? 'displayxr.toml' : `${env}.toml`);
const WRANGLER = process.env.WRANGLER || 'npx';

function kv(...args) {
  const a = [...(WRANGLER === 'npx' ? ['wrangler'] : []), 'kv', 'key', ...args, '--binding', 'KEYS', '--remote', '--config', config];
  return execFileSync(WRANGLER, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], cwd: root }).trim();
}

function usage(code = 1) {
  console.error('usage: signal-keys.mjs <issue|revoke|show|list|block|unblock> … [--env prod|staging]  (see the header of this file)');
  process.exit(code);
}

function get(id) {
  try {
    const raw = kv('get', `key:${id}`, '--text');
    return raw ? parseKeyRecord(id, raw) : null;
  } catch {
    return null;
  }
}

switch (cmd) {
  case 'issue': {
    const origins = (opt('origins', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!origins.length) {
      console.error('issue: --origins is required (comma-separated page origins, or *)');
      usage();
    }
    let limits;
    if (opt('limits')) limits = JSON.parse(opt('limits'));
    const id = newKeyId();
    const rec = parseKeyRecord(id, { origins, note: opt('note', ''), createdAt: new Date().toISOString(), limits });
    kv('put', `key:${id}`, JSON.stringify(rec));
    console.log(JSON.stringify(rec, null, 2));
    console.log(`\nissued ${id} (${env}). Give the developer: <dxr-call key="${id}"> / mountCall(el, { key: '${id}' })`);
    break;
  }
  case 'revoke': {
    const id = argv[1];
    if (!KEY_RE.test(id || '')) usage();
    const rec = get(id);
    if (!rec) {
      console.error(`${id}: not found`);
      process.exit(2);
    }
    kv('put', `key:${id}`, JSON.stringify({ ...rec, revoked: true, revokedAt: new Date().toISOString() }));
    console.log(`revoked ${id} (${env}); takes effect within ~60 s`);
    break;
  }
  case 'show': {
    const id = argv[1];
    if (!KEY_RE.test(id || '')) usage();
    const rec = get(id);
    if (!rec) {
      console.error(`${id}: not found`);
      process.exit(2);
    }
    console.log(JSON.stringify(rec, null, 2));
    break;
  }
  case 'list': {
    const out = kv('list', '--prefix', 'key:');
    const names = JSON.parse(out || '[]').map((k) => k.name.replace(/^key:/, ''));
    for (const id of names) {
      const rec = get(id);
      console.log(`${id}  ${rec && rec.revoked ? 'REVOKED' : 'active '}  ${rec ? rec.origins.join(',') : '?'}  ${rec && rec.note ? '— ' + rec.note : ''}`);
    }
    if (!names.length) console.log('(no keys)');
    break;
  }
  case 'block':
  case 'unblock': {
    const ip = argv[1];
    if (!ip) usage();
    if (cmd === 'block') kv('put', `block:${ip}`, new Date().toISOString());
    else kv('delete', `block:${ip}`, '--force');
    console.log(`${cmd}ed ${ip} (${env})`);
    break;
  }
  default:
    usage(cmd ? 1 : 0);
}
