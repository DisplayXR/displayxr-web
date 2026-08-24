// version-check.js — tell a DisplayXR Browser when a newer build exists.
//
// WHY THIS EXISTS (displayxr-browser#154). The preview deliberately ships no silent
// updater. The intent was always "check + link, never auto-install", but until now the
// check itself did not exist: docs/release-and-distribution.md described this file in the
// present tense while nothing implemented it, and the feed it reads sat at 0.1.5 /
// Chromium 150 for five releases because the release script announced a feed it never
// wrote. Both halves are fixed; this is the consumer.
//
// It matters most for security rebases. A rebase onto current Chrome stable that no
// installed browser is told about delivers its fixes to the release page and nowhere else.
//
// ── THE VERSION MUST COME FROM userAgentData, NOT navigator.userAgent ─────────────────────
//
// Chromium FREEZES the version in the UA string (UA reduction): a browser running
// 151.0.7922.174 reports `Chrome/151.0.0.0`. Measured on the shipping DisplayXR Browser:
//
//     navigator.userAgent  ->  ...Chrome/151.0.0.0 Safari/537.36
//     getHighEntropyValues(['fullVersionList'])
//                          ->  [{brand:'Chromium', version:'151.0.7922.174'}, ...]
//
// The first version of this file compared the UA string, and an up-to-date browser
// therefore read as 151.0.0.0 < 151.0.7922.174 and got a permanent "update available"
// banner it could never clear. That is the worst failure mode this file has: nagging a
// user who is already current, on every page load, forever. Unit tests passed because they
// fed a full-precision UA that real Chrome never sends; the live browser caught it.
//
// So: high-entropy hints or nothing. There is deliberately NO fallback to the UA string —
// falling back would restore exactly that false-positive. If the hints are unavailable
// (non-Chromium browser, insecure context, permission denied), we say nothing.
//
// Pick the Chromium ENTRY BY BRAND: the list contains a GREASE decoy ("Not=A?Brand" at
// version 99) in a deliberately unstable position, so indexing [0] is a coin flip.
//
// ── TWO MORE RULES ───────────────────────────────────────────────────────────────────────
//
// 1. NEVER prompt a browser that is not the DisplayXR Browser. These pages are public and
//    render fine in ordinary Chrome, Safari and Firefox. The gate is `window.XRDisplayLayer`,
//    the same signal inline3d.js's inline3DAvailable() uses. A DisplayXR Browser with
//    inline-3D disabled is missed by that test, and that is the RIGHT trade: a false
//    negative costs one un-notified user; a false positive puts a wrong banner in front of
//    everyone else on the open web.
// 2. Fail silent, always. No feed, bad JSON, offline, blocked ⇒ render nothing. An update
//    check is not important enough to put an error in front of someone reading a sample.
//
// It reads the FEED, not GitHub's /releases/latest: every preview is published as a
// pre-release and that alias excludes pre-releases, so it still resolves to 0.1.8 today.

const FEED_URL = 'https://updates.displayxr.org/feed.json';
const DISMISS_KEY = 'dxr-update-dismissed';

/** True only in the DisplayXR Browser (mirrors inline3d.js's inline3DAvailable gate). */
function isDisplayXRBrowser() {
  return typeof window !== 'undefined' && typeof window.XRDisplayLayer === 'function';
}

/** "151.0.7922.174" → [151,0,7922,174]; null if absent or unparseable. */
export function parseVersion(str) {
  if (typeof str !== 'string' || !/^\d+(\.\d+)*$/.test(str.trim())) return null;
  const parts = str.trim().split('.').map((n) => parseInt(n, 10));
  return parts.some(Number.isNaN) ? null : parts;
}

/**
 * Pick the real Chromium version out of a `fullVersionList`, ignoring the GREASE decoy.
 * Exported because choosing the wrong entry is the subtle way this breaks.
 */
export function pickChromiumVersion(fullVersionList) {
  if (!Array.isArray(fullVersionList)) return null;
  const wanted = ['chromium', 'google chrome', 'microsoft edge'];
  for (const name of wanted) {
    const hit = fullVersionList.find((b) => b && typeof b.brand === 'string' && b.brand.toLowerCase() === name);
    if (hit && parseVersion(hit.version)) return hit.version;
  }
  return null;
}

/**
 * Numeric dotted-version compare. -1 / 0 / 1, shorter operand zero-extended so
 * "151.0.7922" vs "151.0.7922.174" orders correctly rather than by string length.
 */
export function compareVersions(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Decide whether to prompt, given the feed and the TRUE running Chromium version string.
 * Pure — no fetch, no DOM, no globals — so the interesting logic is testable headlessly.
 * Returns null (say nothing) or the banner facts.
 */
export function evaluate(feed, runningVersion) {
  const latest = feed && feed.latest;
  if (!latest || !latest.chromium || !latest.url) return null;
  const running = parseVersion(runningVersion);
  const available = parseVersion(latest.chromium);
  if (!running || !available) return null;
  if (compareVersions(running, available) >= 0) return null; // current, or ahead of the feed
  return {
    version: latest.version || null,
    chromium: latest.chromium,
    url: latest.url,
    security: latest.security === true,
  };
}

/**
 * The running Chromium version, or null when it cannot be known EXACTLY.
 * Never guesses from navigator.userAgent — see the header.
 */
export async function runningChromiumVersion() {
  const uad = typeof navigator !== 'undefined' ? navigator.userAgentData : undefined;
  if (!uad || typeof uad.getHighEntropyValues !== 'function') return null;
  try {
    const hints = await uad.getHighEntropyValues(['fullVersionList']);
    return pickChromiumVersion(hints && hints.fullVersionList);
  } catch {
    return null; // permission denied / not a secure context
  }
}

function dismissed(chromium) {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === chromium;
  } catch {
    return false; // private mode / storage blocked — just show it
  }
}

function render(info) {
  const bar = document.createElement('div');
  bar.setAttribute('role', 'status');
  bar.style.cssText =
    'position:sticky;top:0;z-index:2147483000;display:flex;gap:12px;align-items:center;' +
    'justify-content:center;flex-wrap:wrap;padding:10px 16px;font:14px/1.5 system-ui,sans-serif;' +
    'background:' + (info.security ? '#7f1d1d' : '#1e3a8a') + ';color:#fff';

  const label = info.security
    ? 'A DisplayXR Browser security update is available'
    : 'A newer DisplayXR Browser is available';
  const text = document.createElement('span');
  text.textContent = info.version
    ? `${label} — ${info.version} (Chromium ${info.chromium})`
    : `${label} — Chromium ${info.chromium}`;

  const link = document.createElement('a');
  link.href = info.url;
  link.textContent = 'Download';
  link.style.cssText = 'color:#fff;font-weight:600';
  link.rel = 'noopener noreferrer'; // the asset lives on a different origin

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Dismiss';
  close.style.cssText =
    'background:transparent;border:1px solid #fff8;color:#fff;border-radius:6px;' +
    'padding:2px 10px;cursor:pointer;font:inherit';
  close.addEventListener('click', () => {
    // Dismiss THIS version only: the next release prompts again, so a dismissal can never
    // silently opt someone out of every future security notice.
    try {
      window.localStorage.setItem(DISMISS_KEY, info.chromium);
    } catch {
      /* storage blocked — dismissal is then per-page-load, which is fine */
    }
    bar.remove();
  });

  bar.append(text, link, close);
  document.body.prepend(bar);
}

/**
 * Run the check. Safe to call unconditionally and on any page: it no-ops everywhere except
 * an out-of-date DisplayXR Browser.
 */
export async function checkForUpdate({ feedUrl = FEED_URL, version } = {}) {
  if (!isDisplayXRBrowser()) return null;
  const running = version ?? (await runningChromiumVersion());
  if (!running) return null; // version not knowable exactly ⇒ say nothing
  let feed;
  try {
    const res = await fetch(feedUrl, { cache: 'no-cache' });
    if (!res.ok) return null;
    feed = await res.json();
  } catch {
    return null; // offline, blocked, malformed
  }
  const info = evaluate(feed, running);
  if (!info || dismissed(info.chromium)) return null;
  if (document.body) render(info);
  else window.addEventListener('DOMContentLoaded', () => render(info), { once: true });
  return info;
}

// Auto-run when included as a plain module, unless the host page opts out with
// <script type="module" src="version-check.js" data-manual>.
if (typeof document !== 'undefined' && !document.currentScript?.hasAttribute('data-manual')) {
  checkForUpdate();
}
