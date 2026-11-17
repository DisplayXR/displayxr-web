// inline3d-tools scaffold — copy a known-good inline-3D page template into a directory.
//
//   inline3d-tools scaffold <esm|vite> <target-dir> [--title "<page title>"] [--name <npm-name>] [--force]
//
// esm  = no build step: index.html with an import map of exact CDN pins + app.js + style.css
// vite = index.html + app.js + style.css + package.json with exact npm pins
// The untouched template passes every `inline3d-tools check` rule. Never overwrites an existing
// file unless --force is given.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
export const SCAFFOLD_USAGE = 'usage: inline3d-tools scaffold <esm|vite> <target-dir> [--title "<page title>"] [--name <npm-name>] [--force]';

// [template path, output name] per flavour.
const FILES = {
  esm: [['app.js', 'app.js'], ['style.css', 'style.css'], ['esm/index.html', 'index.html']],
  vite: [['app.js', 'app.js'], ['style.css', 'style.css'], ['vite/index.html', 'index.html'], ['vite/package.template.json', 'package.json']],
};

const npmName = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '') || 'inline3d-page';

export function scaffold({ flavour = 'esm', dir, title, name, force = false }) {
  if (!FILES[flavour]) throw new Error(`unknown flavour "${flavour}" (esm | vite)`);
  if (!dir) throw new Error('scaffold needs a target directory');
  const abs = resolve(dir);
  const t = title || 'Inline 3D page';
  const n = npmName(name || basename(abs));
  const plan = FILES[flavour].map(([src, out]) => ({ src: join(TEMPLATES, src), out: join(abs, out) }));
  const clash = plan.filter((p) => existsSync(p.out));
  if (clash.length && !force) throw new Error(`would overwrite ${clash.map((p) => p.out).join(', ')} (pass --force to replace)`);
  mkdirSync(abs, { recursive: true });
  const written = [];
  for (const p of plan) {
    const text = readFileSync(p.src, 'utf8').replaceAll('__TITLE__', t).replaceAll('__NAME__', n);
    mkdirSync(dirname(p.out), { recursive: true });
    writeFileSync(p.out, text);
    written.push(p.out);
  }
  return { flavour, dir: abs, files: written };
}

// Returns the exit code.
export function main(argv) {
  if (argv.includes('-h') || argv.includes('--help')) { console.log(SCAFFOLD_USAGE); return 0; }
  const val = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const pos = argv.filter((a, i) => !a.startsWith('--') && !['--title', '--name'].includes(argv[i - 1]));
  const [flavour, dir] = pos;
  if (!flavour || !dir) { console.error(SCAFFOLD_USAGE); return 2; }
  try {
    const r = scaffold({ flavour, dir, title: val('title'), name: val('name'), force: argv.includes('--force') });
    console.log(`scaffolded ${r.flavour} page in ${r.dir}:\n${r.files.map((f) => `  ${f}`).join('\n')}`);
    console.log(r.flavour === 'esm'
      ? `next: inline3d-tools check ${dir}`
      : `next: cd ${dir} && npm install && npm run dev, then inline3d-tools check http://localhost:5173/`);
    return 0;
  } catch (e) {
    console.error(`scaffold: ${e.message}`);
    return 2;
  }
}
