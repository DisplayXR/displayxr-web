// The stdio MCP server: tool list, a real asset_check call, and the paid-call guard. Uses the SDK's
// own client over a spawned `inline3d-tools mcp`. Skipped when the package's dependencies are not
// installed (run `npm ci` in tools/inline3d-tools).
//   node --test tools/inline3d-tools/test/mcp.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'inline3d-tools.mjs');
let sdk = true;
try { createRequire(join(HERE, '..', 'package.json')).resolve('@modelcontextprotocol/sdk/client/index.js'); } catch { sdk = false; }
const skip = sdk ? false : '@modelcontextprotocol/sdk not installed (npm ci in tools/inline3d-tools)';

async function connect(env = {}) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'inline3d-tools-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], cwd: join(HERE, '..'), env: { PATH: process.env.PATH, ...env }, stderr: 'ignore' }));
  return client;
}

test('tools/list exposes the CLI operations', { skip }, async () => {
  const c = await connect();
  try {
    const { tools } = await c.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['asset_check', 'authoring_guide', 'check', 'gen_provenance', 'gen_providers', 'gen_run', 'scaffold']);
    const gen = tools.find((t) => t.name === 'gen_run');
    assert.ok(gen.inputSchema.required.includes('confirm_paid'));
  } finally { await c.close(); }
});

test('gen_run refuses unless confirm_paid is true, and never echoes the key', { skip }, async () => {
  const secret = 'test-not-a-real-key-0123456789abcdef';
  const c = await connect({ OPENAI_API_KEY: secret });
  try {
    const r = await c.callTool({ name: 'gen_run', arguments: { adapter: 'openai', kind: 'image', prompt: 'x', out: 'never.png', confirm_paid: false } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /PAID CALL NOT MADE/);
    assert.ok(!JSON.stringify(r).includes(secret));
    const p = await c.callTool({ name: 'gen_providers', arguments: {} });
    assert.match(p.content[0].text, /openai\s+key present/);
    assert.ok(!JSON.stringify(p).includes(secret));
  } finally { await c.close(); }
});

test('authoring_guide returns AGENTS.md', { skip }, async () => {
  const c = await connect();
  try {
    const r = await c.callTool({ name: 'authoring_guide', arguments: {} });
    assert.match(r.content[0].text, /Woven-canvas checklist/);
  } finally { await c.close(); }
});
