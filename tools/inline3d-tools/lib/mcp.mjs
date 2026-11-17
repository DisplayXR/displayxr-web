// inline3d-tools mcp — a stdio MCP server exposing the same operations as the CLI, for any MCP
// client (Claude Code, OpenAI Codex, Cursor, ...).
//
//   inline3d-tools mcp
//
// Tools: check, asset_check, scaffold, gen_providers, gen_run, gen_provenance, authoring_guide.
// Relative paths resolve against the server's working directory (start it in the project root, or
// set the client's `cwd`). Generator keys come from the server's environment only and are never
// returned, logged or written. gen_run makes a paid call only when `confirm_paid` is literally
// true, which an agent may pass only after the user approved that one call and its cost.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';
import { runCheck, formatHuman, VERSION } from './check/run.mjs';
import { assetCheck, formatAssetReport } from './assets/asset-check.mjs';
import { scaffold } from './scaffold.mjs';
import { listProviders, genRun, provenance, ADAPTERS } from './gen.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Every env key value a generator could read, so no tool result can ever echo one.
function redact(text) {
  let s = String(text);
  for (const a of Object.values(ADAPTERS)) {
    const k = process.env[a.env];
    if (k && k.length >= 8) s = s.split(k).join('[redacted]');
  }
  return s;
}
const ok = (text, structured) => ({ content: [{ type: 'text', text: redact(text) }], ...(structured ? { structuredContent: JSON.parse(redact(JSON.stringify(structured))) } : {}) });
const fail = (text) => ({ isError: true, content: [{ type: 'text', text: redact(text) }] });

export function createServer() {
  const server = new McpServer({ name: 'displayxr-inline3d-tools', version: VERSION });

  server.registerTool('check', {
    title: 'Check an inline-3D page',
    description: 'Load an @displayxr/inline3d page in headless Chrome twice: inside a fake DisplayXR Browser (two real eye views) and plain (the 2D fallback). Returns pass/warn/fail per rule (session, stereo, blank eyes, flat side-by-side, buffer, CSS, overlay, layer-lost, console, 2D fallback, detection, pins, depth). Needs a local Chrome. A pass is a fake-environment check, not a test on a real 3D panel. Read-only on the project.',
    inputSchema: {
      target: z.string().describe('A running page URL (http://localhost:5173/), a directory holding index.html, or an .html file'),
      root: z.string().optional().describe('Directory to serve; use the project root when the page imports ../ or /node_modules/'),
      max_texture: z.number().int().positive().optional().describe('Simulate a device MAX_TEXTURE_SIZE (4096 = the Android tablet)'),
      timeout_ms: z.number().int().positive().optional().describe('How long to wait for the 3D run to settle (default 15000)'),
      viewport: z.string().regex(/^\d+x\d+$/).optional().describe('WxH, default 1280x800'),
      fallback: z.boolean().optional().describe('Also run the plain-browser (2D fallback) pass (default true)'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ target, root, max_texture, timeout_ms, viewport, fallback }) => {
    const opt = {};
    if (root) opt.root = root;
    if (max_texture) opt.maxTexture = max_texture;
    if (timeout_ms) opt.timeoutMs = timeout_ms;
    if (fallback === false) opt.fallback = false;
    if (viewport) { const [w, h] = viewport.split('x').map(Number); opt.viewport = { width: w, height: h, dpr: 1 }; }
    try {
      const r = await runCheck(target, opt);
      return ok(`${formatHuman(r)}\n\nFix every FAIL (each line names the rule and the doc under node_modules/@displayxr/inline3d/docs/), re-run until nothing fails, and judge every WARN.`, r);
    } catch (e) { return fail(`check could not run: ${e.message}`); }
  });

  server.registerTool('asset_check', {
    title: 'Check a glTF/GLB asset',
    description: 'Is this glTF/GLB ready for an inline-3D page? Reports missing external files, decoders the page must serve, triangles (both eyes draw them), draw calls, size/units/pivot, texture sizes and decoded GPU memory, alpha-BLEND and metal/glass materials, file size, animations, against a tablet (default) or desktop budget. Read-only, no network.',
    inputSchema: {
      file: z.string().describe('Path to a .glb or .gltf'),
      target: z.enum(['tablet', 'desktop']).optional().describe('Device budget (default tablet: the weakest supported device)'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ file, target }) => {
    try {
      const r = assetCheck(file, { target: target || 'tablet' });
      return ok(formatAssetReport(r), r);
    } catch (e) { return fail(`asset_check: ${e.message}`); }
  });

  server.registerTool('scaffold', {
    title: 'Scaffold an inline-3D page',
    description: 'Copy a known-good page template into a directory: esm (index.html with an import map of exact CDN pins + app.js + style.css, no build step) or vite (adds package.json with exact npm pins). One persistent canvas, a cover that always comes off, a mono 2D fallback. Refuses to overwrite existing files unless force is true.',
    inputSchema: {
      flavour: z.enum(['esm', 'vite']).describe('esm unless the project already uses npm/a bundler'),
      dir: z.string().describe('Target directory (created if missing)'),
      title: z.string().optional().describe('Page title'),
      name: z.string().optional().describe('npm package name for the vite flavour (default: the directory name)'),
      force: z.boolean().optional().describe('Overwrite existing files'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (a) => {
    try {
      const r = scaffold(a);
      return ok(`scaffolded ${r.flavour} page in ${r.dir}:\n${r.files.map((f) => `  ${f}`).join('\n')}\nNext: run the check tool on it before calling it done.`, r);
    } catch (e) { return fail(`scaffold: ${e.message}`); }
  });

  server.registerTool('gen_providers', {
    title: 'List asset generators',
    description: 'Which optional paid generator adapters (meshy, tripo: text/image to GLB; openai: image) have an API key in the server environment. Names and presence only; never a key.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    const p = listProviders();
    return ok(p.map((x) => `${x.name.padEnd(8)} ${x.keyPresent ? 'key present' : 'no key'} (${x.env})  kinds: ${x.kinds.join(', ')}  cost: ${x.cost}`).join('\n'), { providers: p });
  });

  server.registerTool('gen_run', {
    title: 'Generate an asset (PAID)',
    description: 'PAID: send a prompt or image URL to one generator provider with the user\'s own key (from the server environment) and write the result plus an ASSETS.md provenance row. Ask the user before EVERY call: tell them the adapter, the prompt/image and the cost estimate (call once with confirm_paid=false to get it; no call is made). Only after they say yes, call again with confirm_paid=true. One yes covers one call.',
    inputSchema: {
      adapter: z.enum(Object.keys(ADAPTERS)).describe('meshy | tripo (text-to-3d, image-to-3d) | openai (image)'),
      kind: z.enum(['text-to-3d', 'image-to-3d', 'image']),
      prompt: z.string().optional(),
      image: z.string().url().optional().describe('Source image URL for image-to-3d'),
      size: z.string().optional().describe('Image size for the openai adapter, e.g. 1024x1024'),
      out: z.string().describe('Output file (.glb for 3D, .png for images)'),
      confirm_paid: z.boolean().describe('true ONLY after the user approved this one paid call and its estimated cost'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
  }, async (a) => {
    try {
      const r = await genRun({ adapter: a.adapter, kind: a.kind, prompt: a.prompt || '', image: a.image, size: a.size, out: a.out, confirmPaid: a.confirm_paid === true });
      return ok(r.message, { file: r.file, bytes: r.bytes, ledger: r.ledger });
    } catch (e) { return fail(e.message); }
  });

  server.registerTool('gen_provenance', {
    title: 'Record asset provenance',
    description: 'Append a row (file, source, licence, date, notes) to ASSETS.md in the server working directory, creating it if needed. Use for every asset the page loads that you did not write.',
    inputSchema: {
      file: z.string(),
      source: z.string().describe('URL, "supplied by the user", or "generated: <adapter> <kind>"'),
      license: z.string(),
      notes: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (a) => {
    try {
      const l = provenance(a);
      return ok(`recorded ${a.file} in ${l}`, { ledger: l });
    } catch (e) { return fail(`gen_provenance: ${e.message}`); }
  });

  server.registerTool('authoring_guide', {
    title: 'Inline-3D authoring guide',
    description: 'The authoring checklist for @displayxr/inline3d pages (content type and entry point, view rig, depth/comfort, woven-canvas rules, page chrome, exact pins, asset workflow). Read it before writing or fixing a page.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => ok(readFileSync(join(HERE, '..', 'AGENTS.md'), 'utf8')));

  return server;
}

export async function main() {
  // stdout carries the protocol: anything else printed there would corrupt it.
  console.log = console.info = console.debug = (...a) => console.error(...a);
  const server = createServer();
  // Resolves when the client disconnects (closes our stdin), so the process exits cleanly.
  const closed = new Promise((resolve) => {
    server.server.onclose = resolve;
    process.stdin.once('end', resolve);
  });
  await server.connect(new StdioServerTransport());
  console.error(`inline3d-tools mcp ${VERSION}: ready on stdio`);
  await closed;
  await server.close().catch(() => {});
  return 0;
}
