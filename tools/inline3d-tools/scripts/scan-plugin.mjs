// Scans a Claude plugin folder for what the plugin directory blocks or holds for an unverified
// publisher. Exit 1 on any finding.
//
//   node tools/inline3d-tools/scripts/scan-plugin.mjs plugins/displayxr-inline3d
//
// Rules: only Markdown / text / JSON / YAML / PNG / JPEG / GIF / WebP / ICO files (+ LICENSE); no
// file starting with "#!"; no hooks (hooks/ or a `hooks` key); no MCP/LSP servers (.mcp.json or a
// `mcpServers` / `lspServers` key); no package.json `bin` (no package.json at all); commands' and
// skills' allowed-tools limited to Read / Grep / Glob / LS; every package launcher pinned to an
// exact version; no package-manager config; no OS junk files; every file < 256 KiB; complete PNGs.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';

const root = process.argv[2];
if (!root) { console.error('usage: scan-plugin.mjs <plugin-dir>'); process.exit(2); }
const OK_EXT = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico']);
const OK_BARE = new Set(['LICENSE', 'LICENSE.txt', 'NOTICE']);
const JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '__MACOSX']);
const PM_CONFIG = new Set(['.npmrc', '.yarnrc', '.yarnrc.yml', 'bunfig.toml', 'uv.toml', 'pip.conf', '.pnpmfile.cjs']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);
const findings = [];
const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (JUNK.has(n)) findings.push(`${relative(root, p)}: OS junk file`);
    if (statSync(p).isDirectory()) walk(p); else files.push(p);
  }
})(root);

for (const p of files) {
  const rel = relative(root, p);
  const name = basename(p);
  const ext = extname(p).toLowerCase();
  const buf = readFileSync(p);
  if (!OK_EXT.has(ext) && !OK_BARE.has(name)) findings.push(`${rel}: file type not allowed (${ext || 'no extension'})`);
  if (buf.subarray(0, 2).toString() === '#!') findings.push(`${rel}: starts with #!`);
  if (buf.length >= 256 * 1024 && !['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) findings.push(`${rel}: ${buf.length} bytes (>= 256 KiB)`);
  if (PM_CONFIG.has(name)) findings.push(`${rel}: package-manager config`);
  if (name === 'package.json' || name === 'package-lock.json') findings.push(`${rel}: a package manifest/lockfile in the plugin`);
  if (name === '.mcp.json' || name === '.lsp.json') findings.push(`${rel}: MCP/LSP server config`);
  if (rel.split(/[\\/]/)[0] === 'hooks') findings.push(`${rel}: hooks`);
  if (ext === '.png' && !buf.subarray(-12).includes(Buffer.from('IEND'))) findings.push(`${rel}: truncated PNG`);
  if (ext === '.json') {
    try {
      const j = JSON.parse(buf.toString('utf8'));
      for (const k of ['hooks', 'mcpServers', 'lspServers', 'bin']) if (j && Object.hasOwn(j, k)) findings.push(`${rel}: has "${k}"`);
    } catch (e) { findings.push(`${rel}: invalid JSON (${e.message})`); }
  }
  if (ext === '.md') {
    const s = buf.toString('utf8');
    const fm = s.match(/^---\n([\s\S]*?)\n---/);
    const at = fm && fm[1].match(/^allowed-tools:\s*(.+)$/m);
    if (at) {
      for (const t of at[1].split(/[,\s]+/).filter(Boolean)) if (!READ_TOOLS.has(t)) findings.push(`${rel}: allowed-tools includes ${t}`);
    }
    if (/^\s*!`/m.test(s)) findings.push(`${rel}: runs a !\`…\` inline command`);
    // Package launchers must name an exact version: pkg@1.2.3 (npx/bunx/pnpm dlx/yarn dlx) or pkg==1.2.3 (uvx/pipx run).
    for (const m of s.matchAll(/\b(npx|bunx|pnpm dlx|yarn dlx)\s+((?:-{1,2}[\w-]+\s+)*)(\S+)/g)) {
      const pkg = m[3].replace(/[`"')]+$/, '');
      if (!/^(@[\w.-]+\/)?[\w.-]+@\d+\.\d+\.\d+(-[\w.]+)?$/.test(pkg)) findings.push(`${rel}: unpinned launcher "${m[1]} ${pkg}"`);
    }
    for (const m of s.matchAll(/\b(uvx|pipx run)\s+((?:-{1,2}[\w-]+\s+)*)(\S+)/g)) {
      if (!/==\d+(\.\d+)*$/.test(m[3])) findings.push(`${rel}: unpinned launcher "${m[1]} ${m[3]}"`);
    }
  }
}
console.log(`scanned ${files.length} files in ${root}`);
for (const f of findings) console.log(`  FINDING  ${f}`);
console.log(findings.length ? `${findings.length} finding(s)` : 'no findings');
process.exit(findings.length ? 1 : 0);
