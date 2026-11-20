// The hosted inline-3D connector's MCP server: one stateless McpServer per request.
//
// Tools (all read-only for the caller; nothing is written anywhere the caller can see):
//   get_authoring_guide  the authoring checklist                         (no GPU)
//   scaffold_page        a known-good page template, returned as text    (no GPU)
//   check_asset_url      glTF/GLB budget check on a public URL           (no GPU, runs here)
//   check_files          the checker on page files passed inline         (GPU worker)
//   check_url            the checker on a public page URL                (GPU worker)
//   get_check_result     collect a check that was still running          (GPU worker)
//
// guide and scaffold calls warm the GPU worker in the background, because a check usually follows
// within minutes: that hides most of the worker's ~1 minute cold start. A check that is still
// running after ~40 s returns a job id instead of holding the call open.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative, extname } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { formatHuman } from '../node_modules/@displayxr/inline3d-tools/lib/check/run.mjs';
import { assetCheck, formatAssetReport } from '../node_modules/@displayxr/inline3d-tools/lib/assets/asset-check.mjs';
import { scaffold } from '../node_modules/@displayxr/inline3d-tools/lib/scaffold.mjs';
import { parsePublicUrl, assertResolvesPublic, guardedGet, GuardError } from './url-guard.mjs';

export const TOOLS_VERSION = '0.1.3';
export const SERVER_VERSION = '0.1.0';
const PKG = new URL('../node_modules/@displayxr/inline3d-tools/', import.meta.url);
const DOCS_URL = 'https://github.com/DisplayXR/displayxr-web/blob/main/docs';
const LOCAL = `npx -y @displayxr/inline3d-tools@${TOOLS_VERSION}`;
const WAIT_MS = 40000;
const POLL_MS = 2000;
const MAX_FILES = 60;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

const HOSTED_NOTE = `# Using this guide through the hosted DisplayXR connector

You are reading this through the hosted connector (claude.ai, ChatGPT or another remote MCP client),
not a local install. Differences from the local instructions below:
- To check a page, call **check_files** with the page's own files (index.html, app.js, style.css, ...)
  as text. Nothing is hosted or kept: the files are served only to the checker's browser and
  deleted when the check ends. Assets the page loads (models, images, video) must be at public
  URLs (a CDN, the user's site); binary files cannot be passed inline.
- Or call **check_url** with a public http(s) URL of a deployed page or deploy preview. localhost
  and private addresses cannot be reached from the hosted checker.
- A check takes 10-20 s on a warm checker and about a minute more when it has to start. When a check
  tool answers with a job id, tell the user the check is running and call **get_check_result**.
- **scaffold_page** returns the template files as text: show or save them, then edit.
- **check_asset_url** checks a public .glb/.gltf URL. Local asset prep (\`assets prep\`) and the
  paid generators (\`gen\`) exist only in the local tools: ${LOCAL}
- Where the text below says \`npx ... check\`, use check_files or check_url instead. Doc paths under
  node_modules/@displayxr/inline3d/docs/ are also at ${DOCS_URL}/.
- To view a page in 3D, the user opens its public URL in the DisplayXR Browser on a 3D display; in
  any other browser it shows the 2D fallback. The page is static files, so any static host works:
  - In ChatGPT, publish it as a public Site if that tool is available (it gives a top-level public
    URL), then run check_url on that URL.
  - Otherwise give the user the files to deploy (GitHub Pages, Netlify, Vercel, ...). A Claude
    artifact link is not enough: artifacts run inside a sandboxed frame that blocks models, images
    and video from other origins.

---

`;

const ok = (text, structured) => ({ content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}) });
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docLinks = (s) => s.replaceAll('node_modules/@displayxr/inline3d/docs', DOCS_URL);

export function formatReport(rep, extra = '') {
  if (!rep || rep.verdict === 'error' || !Array.isArray(rep.checks)) {
    return `The checker could not run the page: ${rep && rep.error ? rep.error : 'no report'}${extra}`;
  }
  const human = docLinks(formatHuman(rep));
  return `${human}${extra}\n\nFix every FAIL (each line names the rule and its doc), check again until nothing fails, and judge every WARN. A pass means the page works in a simulated DisplayXR Browser; it is not a test on a real 3D display.`;
}

function trimForStructured(rep) {
  if (!rep || !Array.isArray(rep.checks)) return { verdict: 'error' };
  return {
    verdict: rep.verdict,
    version: rep.version,
    durationMs: rep.durationMs,
    checks: rep.checks.map((c) => ({ id: c.id, status: c.status, summary: c.summary, hint: c.hint, doc: c.doc && docLinks(c.doc) })),
    rig: rep.info && rep.info.rig,
  };
}

export function createServer({ runpod, limits, clientIp = 'unknown', log = () => {} } = {}) {
  const server = new McpServer({
    name: 'displayxr-inline3d', title: 'DisplayXR inline 3D', version: SERVER_VERSION,
    websiteUrl: 'https://mcp.displayxr.org/',
    // Clients (ChatGPT's composer chip, Claude) show this icon; without it ChatGPT draws a broken image.
    icons: [{ src: 'https://mcp.displayxr.org/icon.png', mimeType: 'image/png', sizes: ['512x512'] }],
  }, {
    instructions: 'Tools for building @displayxr/inline3d web pages: glasses-free 3D that the DisplayXR Browser shows on 3D displays, with a 2D fallback everywhere else. Read get_authoring_guide before writing a page, start from scaffold_page, and run check_files (or check_url for a deployed page) before calling the page done.',
  });
  // Directories read the tool's display name from annotations.title as well as the top-level
  // title (the Claude directory flags a tool without it), so every tool carries both, equal.
  const register = server.registerTool.bind(server);
  server.registerTool = (name, cfg, cb) => register(name, { ...cfg, annotations: { title: cfg.title, ...cfg.annotations } }, cb);


  // Start a worker when none is up, so the check that usually follows finds it warm.
  async function warm(reason) {
    if (!runpod || !limits) return;
    try {
      if (!(await limits.canRun()).ok || (await limits.workerProbablyUp())) return;
      const h = await runpod.health().catch(() => null);
      const w = h && h.workers ? h.workers : {};
      if ((w.idle || 0) + (w.running || 0) + (w.ready || 0) + (w.initializing || 0) > 0) return;
      await runpod.submit({ mode: 'warm' });
      await limits.chargeJob(1);
      log(`warm: started a worker (${reason})`);
    } catch (e) { log(`warm failed: ${e.message}`); }
  }

  async function startCheck(input) {
    if (!runpod || !limits) return { error: `The hosted checker is not configured on this server. Run it locally instead: ${LOCAL} check <url | dir>` };
    const b = await limits.canRun();
    if (!b.ok) return { error: `${b.reason}. Run the same check locally (free, needs Node and Chrome): ${LOCAL} check <url | dir | page.html>` };
    const ip = await limits.allowIp(clientIp);
    if (!ip.ok) return { error: `${ip.reason}. Try again later, or run it locally: ${LOCAL} check <url | dir>` };
    const job = await runpod.submit(input);
    await limits.chargeJob();
    return { id: job.id };
  }

  async function collect(id, waitMs) {
    const t0 = Date.now();
    let st;
    for (;;) {
      st = await runpod.status(id);
      if (['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(st.status)) break;
      if (Date.now() - t0 + POLL_MS > waitMs) return { pending: true, status: st.status };
      await sleep(POLL_MS);
    }
    if (st.status !== 'COMPLETED') return { done: true, error: `the check ended with status ${st.status}${st.error ? `: ${String(st.error).slice(0, 500)}` : ''}` };
    await limits.settleJob(id, st.executionTime).catch(() => {});
    const out = st.output || {};
    if (out.verdict === 'error') return { done: true, error: out.error };
    return { done: true, report: out.report, seconds: out.checkSeconds };
  }

  function answer(id, r, cold) {
    if (r.pending) {
      return ok(`CHECK RUNNING (job_id: ${id}). ${cold ? 'The checker is starting up, which takes about a minute the first time. ' : ''}Tell the user the check is running, then call get_check_result with this job_id (it waits up to 40 s per call). Results are kept 30 minutes.`, { status: 'running', job_id: id });
    }
    if (r.error) return fail(`The check could not complete: ${r.error}`);
    return ok(formatReport(r.report), { status: 'done', job_id: id, ...trimForStructured(r.report) });
  }

  const checkOptions = {
    max_texture: z.number().int().min(1024).max(16384).optional().describe('Simulate a device MAX_TEXTURE_SIZE (4096 = the Android tablet)'),
    viewport: z.string().regex(/^\d{3,4}x\d{3,4}$/).optional().describe('WxH, default 1280x800'),
    fallback: z.boolean().optional().describe('Also run the plain-browser (2D fallback) pass (default true)'),
  };

  async function runCheckTool(input) {
    try {
      const cold = !(await limits.workerProbablyUp());
      const s = await startCheck(input);
      if (s.error) return fail(s.error);
      return answer(s.id, await collect(s.id, WAIT_MS), cold);
    } catch (e) {
      if (e instanceof GuardError) return fail(e.message);
      log(`check error: ${e.message}`);
      return fail(`The hosted checker failed (${e.message}). Try again, or run it locally: ${LOCAL} check <url | dir>`);
    }
  }

  server.registerTool('get_authoring_guide', {
    title: 'Inline-3D authoring guide',
    description: 'The authoring checklist for @displayxr/inline3d pages (glasses-free 3D on 3D displays in the DisplayXR Browser, 2D everywhere else): content type and entry point, view rig, depth and comfort, woven-canvas rules, page chrome, exact pins, assets.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    await warm('guide');
    return ok(HOSTED_NOTE + readFileSync(new URL('AGENTS.md', PKG), 'utf8'));
  });

  server.registerTool('scaffold_page', {
    title: 'Scaffold an inline-3D page',
    description: 'Returns the files of a known-good @displayxr/inline3d page as text: esm (index.html with an import map of exact CDN pins, app.js, style.css; no build step) or vite (the same plus package.json with exact npm pins). One persistent canvas, a cover that always comes off, a mono 2D fallback. The untouched template passes every check. Nothing is written or stored.',
    inputSchema: {
      flavour: z.enum(['esm', 'vite']).optional().describe('esm (default) unless the project already uses npm or a bundler'),
      title: z.string().max(120).optional().describe('Page title'),
      name: z.string().max(80).optional().describe('npm package name for the vite flavour'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ flavour = 'esm', title, name }) => {
    await warm('scaffold');
    const dir = mkdtempSync(join(tmpdir(), 'scaffold-'));
    try {
      const r = scaffold({ flavour, dir: join(dir, 'page'), title, name: name || 'inline3d-page' });
      const files = r.files.map((f) => ({ path: relative(r.dir, f), content: readFileSync(f, 'utf8') }));
      const fence = (p) => ({ '.html': 'html', '.js': 'js', '.css': 'css', '.json': 'json' })[extname(p)] || '';
      const text = [`${flavour} inline-3D page template (${files.length} files). Save them side by side, edit app.js, then run check_files on the result.`, '',
        ...files.flatMap((f) => [`### ${f.path}`, `\`\`\`${fence(f.path)}`, f.content.replace(/\n$/, ''), '```', ''])].join('\n');
      return ok(text, { flavour, files });
    } catch (e) { return fail(`scaffold_page: ${e.message}`); } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  server.registerTool('check_asset_url', {
    title: 'Check a glTF/GLB asset URL',
    description: 'Is the glTF/GLB at this public URL ready for an inline-3D page? Fetches it (and a .gltf\'s relative buffers and textures) and reports missing files, decoders the page must serve, triangles (both eyes draw them), draw calls, size/units/pivot, texture sizes and GPU memory, alpha-BLEND and metal/glass materials, file size and animations, against a tablet (default) or desktop budget. Files are deleted after the check.',
    inputSchema: {
      url: z.string().url().describe('Public http(s) URL of a .glb or .gltf'),
      target: z.enum(['tablet', 'desktop']).optional().describe('Device budget (default tablet: the weakest supported device)'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ url, target = 'tablet' }) => {
    const dir = mkdtempSync(join(tmpdir(), 'asset-'));
    try {
      const u = parsePublicUrl(url);
      await assertResolvesPublic(u);
      const name = (u.pathname.split('/').pop() || 'asset.glb').replace(/[^A-Za-z0-9._-]/g, '_');
      if (!/\.(glb|gltf)$/i.test(name)) return fail('check_asset_url needs a URL ending in .glb or .gltf');
      let budgetLeft = 50 * 1024 * 1024;
      const main = await guardedGet(u.href, { maxBytes: budgetLeft });
      budgetLeft -= main.body.length;
      writeFileSync(join(dir, name), main.body);
      if (/\.gltf$/i.test(name)) {
        let j;
        try { j = JSON.parse(main.body.toString('utf8')); } catch { return fail('the .gltf is not valid JSON'); }
        const uris = [...(j.buffers || []), ...(j.images || [])].map((x) => x.uri).filter((x) => x && !x.startsWith('data:') && !/^[a-z]+:/i.test(x));
        for (const rel of [...new Set(uris)].slice(0, 64)) {
          const path = decodeURIComponent(rel);
          if (path.split('/').includes('..') || path.startsWith('/')) continue;
          try {
            const r = await guardedGet(new URL(rel, main.url).href, { maxBytes: budgetLeft });
            budgetLeft -= r.body.length;
            mkdirSync(dirname(join(dir, path)), { recursive: true });
            writeFileSync(join(dir, path), r.body);
          } catch { /* asset check reports it as missing */ }
        }
      }
      const rep = assetCheck(join(dir, name), { target });
      rep.file = u.href;
      return ok(formatAssetReport(rep), rep);
    } catch (e) {
      return fail(`check_asset_url: ${e.message}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  server.registerTool('check_files', {
    title: 'Check an inline-3D page (files)',
    description: 'Run the inline-3D checker on a page passed as its own text files: headless Chrome on a GPU loads it twice, inside a simulated DisplayXR Browser (two real eye views) and plain (the 2D fallback), and reports pass/warn/fail per rule (session, stereo, blank eyes, flat side-by-side, buffer, CSS, overlay, layer lost, console, 2D fallback, detection, pins, depth). The files are served only to the checker and deleted afterwards. Assets the page loads must be at public URLs. Takes 10-20 s, plus about a minute when the checker has to start; a check still running after 40 s returns a job_id instead of the report.',
    inputSchema: {
      files: z.array(z.object({
        path: z.string().regex(/^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._/-]{1,200}$/).describe('Relative path, e.g. index.html or js/app.js'),
        content: z.string().describe('File text'),
      })).min(1).max(MAX_FILES).describe('The page\'s text files (HTML, JS, CSS, JSON, SVG)'),
      entry: z.string().optional().describe('The page to open (default index.html)'),
      ...checkOptions,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ files, entry, ...opt }) => {
    const bytes = files.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
    if (bytes > MAX_FILE_BYTES) return fail(`check_files takes ${MAX_FILE_BYTES / 1048576} MB of text at most (got ${(bytes / 1048576).toFixed(1)} MB). Put large assets at a public URL.`);
    const e = entry || 'index.html';
    if (!files.some((f) => f.path === e)) return fail(`no file named ${e}: pass the page as ${e} or set entry`);
    return runCheckTool({ mode: 'check_files', files, entry: e, ...opt });
  });

  server.registerTool('check_url', {
    title: 'Check an inline-3D page (URL)',
    description: 'Run the inline-3D checker on a deployed page at a public http(s) URL (a site or a deploy preview; not localhost). Same checks as the file check: simulated DisplayXR Browser plus plain 2D run, pass/warn/fail per rule. Takes 10-20 s, plus about a minute when the checker has to start; a check still running after 40 s returns a job_id instead of the report.',
    inputSchema: {
      url: z.string().url().describe('Public http(s) URL of the page'),
      ...checkOptions,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ url, ...opt }) => {
    try {
      const u = parsePublicUrl(url);
      await assertResolvesPublic(u);
      return runCheckTool({ mode: 'check', url: u.href, ...opt });
    } catch (e) { return fail(e.message); }
  });

  server.registerTool('get_check_result', {
    title: 'Get a running check\'s result',
    description: 'Returns the report of a page check that answered with a job_id. Waits up to 40 s; if the check is still running it says so. Results are kept 30 minutes.',
    inputSchema: { job_id: z.string().regex(/^[A-Za-z0-9_-]{8,120}$/).describe('The job_id a check tool returned') },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ job_id }) => {
    if (!runpod) return fail('The hosted checker is not configured on this server.');
    try { return answer(job_id, await collect(job_id, WAIT_MS), false); } catch (e) {
      if (/HTTP 404/.test(e.message)) return fail('No such job (results are kept 30 minutes). Run the check again.');
      return fail(`get_check_result: ${e.message}`);
    }
  });

  return server;
}
