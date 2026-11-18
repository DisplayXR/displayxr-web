// Live smoke test against a deployed connector (not part of `npm test`: it uses the network and,
// for the check tools, the GPU budget).
//
//   node test/live.mjs [url] [--checks]
//
// Default URL https://mcp.displayxr.org/mcp. Without --checks it calls only the free tools.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith('http')) || 'https://mcp.displayxr.org/mcp';
const withChecks = args.includes('--checks');
const ASSET = 'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Assets@main/Models/Duck/glTF-Binary/Duck.glb';
const SAMPLE = 'https://displayxr.github.io/displayxr-web/samples/hello-cube/';

const client = new Client({ name: 'inline3d-mcp-live-test', version: '0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
let failed = 0;
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const note = await fn(); console.log(`ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)${note ? `  ${note}` : ''}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
};
const call = async (name, a = {}) => {
  const r = await client.callTool({ name, arguments: a }, undefined, { timeout: 120000 });
  if (r.isError) throw new Error(r.content[0].text.slice(0, 400));
  return r;
};
async function finish(r) {
  for (let i = 0; i < 6 && r.structuredContent && r.structuredContent.status === 'running'; i++) r = await call('get_check_result', { job_id: r.structuredContent.job_id });
  return r;
}

await step('tools/list', async () => {
  const { tools } = await client.listTools();
  return tools.map((t) => t.name).join(', ');
});
await step('get_authoring_guide', async () => `${(await call('get_authoring_guide')).content[0].text.length} chars`);
await step('scaffold_page', async () => (await call('scaffold_page', { title: 'Live test' })).structuredContent.files.map((f) => f.path).join(', '));
await step('check_asset_url', async () => (await call('check_asset_url', { url: ASSET })).content[0].text.split('\n').pop());
await step('check_url refuses localhost', async () => {
  const r = await client.callTool({ name: 'check_url', arguments: { url: 'http://localhost:5173/' } });
  if (!r.isError) throw new Error('expected an error');
});
if (withChecks) {
  await step('check_url (public sample)', async () => {
    const r = await finish(await call('check_url', { url: SAMPLE }));
    return r.content[0].text.split('\n').filter((l) => /verdict|FAIL|WARN/.test(l)).join(' | ');
  });
  await step('check_files (scaffold template)', async () => {
    const files = (await call('scaffold_page', { title: 'Checked template' })).structuredContent.files;
    const r = await finish(await call('check_files', { files }));
    return r.content[0].text.split('\n').filter((l) => /verdict|FAIL|WARN/.test(l)).join(' | ');
  });
}
await client.close();
process.exit(failed ? 1 : 0);
