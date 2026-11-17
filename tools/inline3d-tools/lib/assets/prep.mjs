// inline3d-tools assets prep — run the bundled Blender script (blender/prep.py) headless, ONLY with a
// Blender that is already installed. Never downloads or installs Blender.
//
//   inline3d-tools assets prep <in.(fbx|obj|stl|ply|dae|blend|glb|gltf)> <out.glb> [--metres 0.01] [--decimate 0.5] [--blender <path>]
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PREP_PY = join(dirname(fileURLToPath(import.meta.url)), 'blender', 'prep.py');

// --blender, then $BLENDER, then `blender` on PATH, then the default install locations.
export function findBlender(explicit) {
  const cands = [explicit, process.env.BLENDER].filter(Boolean);
  for (const c of cands) if (existsSync(c)) return c;
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['blender'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim().split(/\r?\n/)[0];
  if (process.platform === 'darwin') {
    const p = '/Applications/Blender.app/Contents/MacOS/Blender';
    if (existsSync(p)) return p;
  }
  if (process.platform === 'win32') {
    const root = 'C:\\Program Files\\Blender Foundation';
    try {
      for (const d of readdirSync(root).sort().reverse()) {
        const p = join(root, d, 'blender.exe');
        if (existsSync(p)) return p;
      }
    } catch { /* not installed */ }
  }
  return null;
}

// Returns the exit code (2 = bad arguments or no Blender).
export function main(argv) {
  const val = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const pos = argv.filter((a, i) => !a.startsWith('--') && !['--metres', '--decimate', '--blender'].includes(argv[i - 1]));
  const [src, dst] = pos;
  if (!src || !dst) { console.error('usage: inline3d-tools assets prep <in> <out.glb> [--metres <m>] [--decimate <ratio>] [--blender <path>]'); return 2; }
  const blender = findBlender(val('blender'));
  if (!blender) {
    console.error('no Blender found (--blender, $BLENDER, PATH, default install path). This tool never installs it: ask for a GLB instead, or install Blender yourself.');
    return 2;
  }
  const extra = [];
  if (val('metres')) extra.push('--metres', val('metres'));
  if (val('decimate')) extra.push('--decimate', val('decimate'));
  const r = spawnSync(blender, ['-b', '--factory-startup', '-P', PREP_PY, '--', src, dst, ...extra], { stdio: 'inherit' });
  return r.status ?? 1;
}
