// version-check.js — the DisplayXR Browser's lightweight update check.
//
// The preview deliberately has NO silent auto-updater. Instead, on launch the browser's start page
// (hosted here) checks the GitHub Releases API and, if a newer preview exists, shows a "new version
// available → download" banner. That's the whole update mechanism: a check + a link, never a silent
// install. See displayxr-browser/docs/release-and-distribution.md.
//
// Usage (from the browser start page):
//   import { checkForUpdate, showUpdateBanner } from '../js/version-check.js';
//   showUpdateBanner();   // no-op unless a newer release exists (and unless offline / not the browser)

const RELEASES_API = 'https://api.github.com/repos/DisplayXR/displayxr-browser/releases/latest';
const RELEASES_PAGE = 'https://github.com/DisplayXR/displayxr-browser/releases/latest';

// Parse the running browser's Chromium version from the UA (e.g. "Chrome/150.0.7871.24").
export function currentVersion() {
  const m = /Chrome\/(\d+\.\d+\.\d+\.\d+)/.exec(navigator.userAgent);
  return m ? m[1] : null;
}

// Compare dotted numeric versions. >0 if a>b, <0 if a<b, 0 equal.
export function cmpVersion(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// Returns { updateAvailable, latestTag, current, url } — or { updateAvailable:false } on any failure
// (offline, rate-limited, not the DisplayXR Browser). Never throws.
export async function checkForUpdate() {
  const current = currentVersion();
  try {
    const r = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) return { updateAvailable: false };
    const rel = await r.json();
    // Release tags look like "preview-150.0.7871.24"; pull the dotted version out.
    const tag = rel.tag_name || '';
    const lm = /(\d+\.\d+\.\d+\.\d+)/.exec(tag);
    const latest = lm ? lm[1] : null;
    const updateAvailable = !!(current && latest && cmpVersion(latest, current) > 0);
    return { updateAvailable, latestTag: tag, latest, current, url: rel.html_url || RELEASES_PAGE };
  } catch {
    return { updateAvailable: false };
  }
}

// Renders a small dismissible banner iff a newer preview exists. Safe to call anywhere.
export async function showUpdateBanner() {
  const info = await checkForUpdate();
  if (!info.updateAvailable) return;
  const bar = document.createElement('div');
  bar.setAttribute('role', 'status');
  bar.style.cssText =
    'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:10px 16px;' +
    'font:14px system-ui,sans-serif;background:#1d4ed8;color:#fff;display:flex;gap:12px;' +
    'align-items:center;justify-content:center';
  bar.innerHTML =
    `A new DisplayXR Browser preview is available (${info.latest}). ` +
    `<a href="${info.url}" style="color:#fff;font-weight:600;text-decoration:underline">Download</a>`;
  const x = document.createElement('button');
  x.textContent = '✕';
  x.style.cssText = 'background:none;border:0;color:#fff;cursor:pointer;font-size:15px';
  x.onclick = () => bar.remove();
  bar.appendChild(x);
  document.body.appendChild(bar);
}
