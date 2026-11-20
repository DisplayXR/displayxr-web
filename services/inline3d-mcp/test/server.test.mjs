// The hosted connector's tools against a fake RunPod endpoint (no network, no GPU).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../lib/server.mjs';
import { budget } from '../lib/budget.mjs';
import { memoryStore } from '../lib/store.mjs';

const REPORT = {
  tool: 'inline3d-check', version: '0.1.1', url: 'http://127.0.0.1:1/index.html', verdict: 'pass', durationMs: 9000,
  checks: [{ id: 'session', letter: 'a', title: 't', status: 'pass', summary: 'session reached' },
    { id: 'eyes-not-blank', letter: 'c', title: 't', status: 'pass', summary: 'both eyes drawn' }],
  info: { rig: { type: 'display' } },
};

// A fake endpoint: jobs complete after `runs` status polls; health reports `workers`.
function fakeRunpod({ runs = 0, workers = {}, output = { report: REPORT, checkSeconds: 9 } } = {}) {
  const jobs = new Map();
  const calls = [];
  let n = 0;
  return {
    calls,
    async submit(input) { const id = `job-${++n}-abcdefgh`; jobs.set(id, { input, polls: 0 }); calls.push(input); return { id, status: 'IN_QUEUE' }; },
    async status(id) {
      const j = jobs.get(id);
      if (!j) throw new Error('RunPod status HTTP 404: not found');
      if (j.polls++ < runs) return { id, status: 'IN_PROGRESS' };
      return { id, status: 'COMPLETED', executionTime: 9000, output };
    },
    async health() { return { workers: { idle: 0, running: 0, ready: 0, initializing: 0, ...workers } }; },
  };
}

async function connect(opts) {
  const server = createServer({ log: () => {}, ...opts });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  return client;
}

const PAGE = [{ path: 'index.html', content: '<!doctype html><title>x</title><script type="module" src="app.js"></script>' }, { path: 'app.js', content: 'console.log(1)' }];

test('every tool is read-only with explicit hints and a title (both directories require it)', async () => {
  const c = await connect({});
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['check_asset_url', 'check_files', 'check_url', 'get_authoring_guide', 'get_check_result', 'scaffold_page']);
  for (const t of tools) {
    assert.ok(t.title, `${t.name} title`);
    assert.equal(t.annotations.title, t.title, `${t.name} annotations.title`);
    assert.equal(t.annotations.readOnlyHint, true, t.name);
    assert.equal(t.annotations.destructiveHint, false, t.name);
    assert.equal(typeof t.annotations.openWorldHint, 'boolean', t.name);
  }
});

test('tool descriptions state facts only: no tool names another tool (directory policy)', async () => {
  const c = await connect({});
  const { tools } = await c.listTools();
  const names = tools.map((t) => t.name);
  for (const t of tools) {
    for (const other of names) if (other !== t.name) assert.ok(!t.description.includes(other), `${t.name} description names ${other}`);
  }
});

test('guide carries the hosted note and the checklist, and warms a worker once', async () => {
  const rp = fakeRunpod();
  const limits = budget(memoryStore());
  const c = await connect({ runpod: rp, limits });
  const r = await c.callTool({ name: 'get_authoring_guide', arguments: {} });
  const text = r.content[0].text;
  assert.match(text, /hosted DisplayXR connector/);
  assert.match(text, /check_files/);
  assert.match(text, /Woven-canvas checklist/);
  assert.deepEqual(rp.calls, [{ mode: 'warm' }]);
  await c.callTool({ name: 'scaffold_page', arguments: {} });
  assert.equal(rp.calls.length, 1, 'a worker that is up is not warmed again');
});

test('no warm when the endpoint already has a worker', async () => {
  const rp = fakeRunpod({ workers: { idle: 1 } });
  const c = await connect({ runpod: rp, limits: budget(memoryStore()) });
  await c.callTool({ name: 'get_authoring_guide', arguments: {} });
  assert.equal(rp.calls.length, 0);
});

test('scaffold_page returns the template files as text', async () => {
  const c = await connect({});
  const r = await c.callTool({ name: 'scaffold_page', arguments: { flavour: 'vite', title: 'My page', name: 'my-page' } });
  const paths = r.structuredContent.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['app.js', 'index.html', 'package.json', 'style.css']);
  const html = r.structuredContent.files.find((f) => f.path === 'index.html').content;
  assert.match(html, /<title>My page<\/title>/);
  assert.match(r.content[0].text, /### app\.js/);
});

test('check_files: a fast check answers in the same call', async () => {
  const rp = fakeRunpod({ runs: 1 });
  const c = await connect({ runpod: rp, limits: budget(memoryStore()) });
  const r = await c.callTool({ name: 'check_files', arguments: { files: PAGE } });
  assert.ok(!r.isError, r.content[0].text);
  assert.match(r.content[0].text, /verdict: PASS/);
  assert.equal(r.structuredContent.verdict, 'pass');
  assert.equal(rp.calls[0].mode, 'check_files');
  assert.equal(rp.calls[0].entry, 'index.html');
});

test('check_files: a slow check returns a job id, get_check_result collects it', async () => {
  const rp = fakeRunpod({ runs: 30 }); // 30 polls x 2 s > the 40 s wait
  const c = await connect({ runpod: rp, limits: budget(memoryStore()) });
  const r = await c.callTool({ name: 'check_files', arguments: { files: PAGE } });
  assert.equal(r.structuredContent.status, 'running');
  assert.match(r.content[0].text, /CHECK RUNNING/);
  assert.match(r.content[0].text, /starting up/, 'a cold worker says so');
  const r2 = await c.callTool({ name: 'get_check_result', arguments: { job_id: r.structuredContent.job_id } });
  assert.equal(r2.structuredContent.status, 'done');
}, { timeout: 120000 });

test('check_files refuses a missing entry and unsafe paths', async () => {
  const c = await connect({ runpod: fakeRunpod(), limits: budget(memoryStore()) });
  const r = await c.callTool({ name: 'check_files', arguments: { files: [{ path: 'app.js', content: '' }] } });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /no file named index\.html/);
  const bad = await c.callTool({ name: 'check_files', arguments: { files: [{ path: '../etc/passwd', content: '' }] } });
  assert.ok(bad.isError);
});

test('check_url refuses localhost and private addresses before using the GPU', async () => {
  const rp = fakeRunpod();
  const c = await connect({ runpod: rp, limits: budget(memoryStore()) });
  for (const url of ['http://localhost:5173/', 'http://127.0.0.1/', 'http://10.1.2.3/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd']) {
    const r = await c.callTool({ name: 'check_url', arguments: { url } });
    assert.ok(r.isError, url);
  }
  assert.equal(rp.calls.length, 0);
});

test('worker errors and failed jobs come back as tool errors', async () => {
  const c = await connect({ runpod: fakeRunpod({ output: { verdict: 'error', error: 'entry not found' } }), limits: budget(memoryStore()) });
  const r = await c.callTool({ name: 'check_files', arguments: { files: PAGE } });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /entry not found/);
});

test('no RunPod configured: checks explain the local alternative', async () => {
  const c = await connect({});
  const r = await c.callTool({ name: 'check_files', arguments: { files: PAGE } });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /npx -y @displayxr\/inline3d-tools@0\.1\.3 check/);
});

test('budget exhausted: checks refuse, guide still works and does not warm', async () => {
  const rp = fakeRunpod();
  const limits = budget(memoryStore(), { monthlyCapUsd: 0.01 });
  await limits.chargeJob(); // one cold job is far over a 1-cent cap
  const c = await connect({ runpod: rp, limits });
  const r = await c.callTool({ name: 'check_files', arguments: { files: PAGE } });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /budget/);
  const g = await c.callTool({ name: 'get_authoring_guide', arguments: {} });
  assert.ok(!g.isError);
  assert.equal(rp.calls.length, 0);
});
