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
//
// ── COMPARE DISPLAYXR RELEASES, NOT ONLY CHROMIUM (browser-pvt patch 0245) ────────────────
//
// Several DisplayXR releases ship on ONE Chromium tag (1.0.5 and 1.0.6 are both
// 154.0.8037.17), so a Chromium-only comparison never told a 1.0.5 user about 1.0.6. From
// 1.0.7 the browser adds {brand: "DisplayXR Browser", version: "<release>"} to the SAME
// high-entropy fullVersionList (never to the low-entropy `brands` sent to every site). So:
//
//   * brand present and parseable  -> compare it with the feed entry's `version`.
//   * brand ABSENT in a DisplayXR Browser -> it predates the brand, i.e. it is older than
//     FIRST_BRANDED_RELEASE, so any feed release at or above that one is an update. This is
//     what lets 1.0.5 / 1.0.6 learn about 1.0.7 even though Chromium did not move.
//   * otherwise (feed has no `version`, brand unparseable such as a "0.0.0-dev" build) ->
//     the original Chromium comparison.
//
// ── PICK THE FEED ENTRY FOR THIS PLATFORM ────────────────────────────────────────────────
//
// The feed carries `platforms.{windows,android,linux}` next to the legacy top-level
// `latest` (which is Windows). Every DisplayXR Browser runs this check, Android included, so
// reading `latest` alone offered an Android user the Windows .exe. Prefer
// feed.platforms[key] with key from navigator.userAgentData.platform, and fall back to
// `latest` ONLY for windows or an unknown platform (browser-pvt docs/auto-update-design.md
// §1 "Migration" step 2). Linux updates through apt, so its banner says so.

const FEED_URL = 'https://updates.displayxr.org/feed.json';
const DISMISS_KEY = 'dxr-update-dismissed';
/** The UA-CH brand the browser reports its DisplayXR release under (browser-pvt 0245). */
export const DISPLAYXR_BRAND = 'DisplayXR Browser';
/**
 * The first release that reports DISPLAYXR_BRAND. A DisplayXR Browser WITHOUT the brand is
 * therefore older than this. Never lower it; raising it would stop older browsers hearing
 * about the releases in between.
 */
export const FIRST_BRANDED_RELEASE = '1.0.7';

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
 * The DisplayXR release from a `fullVersionList` (the "DisplayXR Browser" entry), or null
 * when absent or not a plain dotted number (a "0.0.0-dev" build reads as null on purpose).
 */
export function pickDisplayXRVersion(fullVersionList) {
  if (!Array.isArray(fullVersionList)) return null;
  const want = DISPLAYXR_BRAND.toLowerCase();
  const hit = fullVersionList.find((b) => b && typeof b.brand === 'string' && b.brand.toLowerCase() === want);
  return hit && parseVersion(hit.version) ? hit.version.trim() : null;
}

/** True when the list names the DisplayXR brand at all, parseable or not. */
function hasDisplayXRBrand(fullVersionList) {
  if (!Array.isArray(fullVersionList)) return false;
  const want = DISPLAYXR_BRAND.toLowerCase();
  return fullVersionList.some((b) => b && typeof b.brand === 'string' && b.brand.toLowerCase() === want);
}

/**
 * navigator.userAgentData.platform -> feed platform key. "Windows" -> "windows",
 * "Android" -> "android", "Linux" -> "linux"; anything else (or nothing) -> null.
 */
export function platformKey(platform) {
  if (typeof platform !== 'string') return null;
  const p = platform.trim().toLowerCase();
  return p === 'windows' || p === 'android' || p === 'linux' ? p : null;
}

/**
 * The feed entry for a platform key. `platforms[key]` wins; the legacy top-level `latest`
 * (a Windows entry) is used ONLY for windows or an unknown platform, so an Android or Linux
 * browser is never offered the .exe. Null means "no entry for this platform: say nothing".
 */
export function selectFeedEntry(feed, key) {
  if (!feed || typeof feed !== 'object') return null;
  const platforms = feed.platforms && typeof feed.platforms === 'object' ? feed.platforms : null;
  if (key && platforms && platforms[key] && typeof platforms[key] === 'object') return platforms[key];
  if (key === null || key === undefined || key === 'windows') return feed.latest || null;
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
 * Decide whether to prompt. Pure — no fetch, no DOM, no globals — so the interesting logic
 * is testable headlessly. Returns null (say nothing) or the banner facts.
 *
 * `running` is either the TRUE running Chromium version string (the original signature,
 * still accepted), or { chromium, displayxr, branded, platform } from runningVersions():
 *   chromium  — Chromium full version from fullVersionList
 *   displayxr — the "DisplayXR Browser" release, or null
 *   branded   — whether the list named the brand at all (false = pre-brand browser)
 *   platform  — navigator.userAgentData.platform ("Windows", "Android", ...)
 * `branded` defaults to "unknown", which disables the pre-brand inference, so a caller that
 * only knows Chromium keeps the original behaviour.
 */
export function evaluate(feed, running) {
  const r = typeof running === 'string' || running == null ? { chromium: running } : running;
  const key = platformKey(r.platform);
  const entry = selectFeedEntry(feed, key);
  if (!entry || !entry.url) return null;

  const offered = parseVersion(entry.version);
  const mine = parseVersion(r.displayxr);
  let by;
  if (offered && mine) {
    if (compareVersions(mine, offered) >= 0) return null; // current, or ahead of the feed
    by = 'displayxr';
  } else if (offered && r.branded === false && r.chromium != null &&
             compareVersions(offered, parseVersion(FIRST_BRANDED_RELEASE)) >= 0) {
    // A DisplayXR Browser with no brand predates FIRST_BRANDED_RELEASE, so this is newer.
    // Requires a known Chromium version too: "version unknowable" must stay silent.
    if (!parseVersion(r.chromium)) return null;
    by = 'displayxr';
  } else {
    if (!entry.chromium) return null;
    const cur = parseVersion(r.chromium);
    const available = parseVersion(entry.chromium);
    if (!cur || !available) return null;
    if (compareVersions(cur, available) >= 0) return null; // current, or ahead of the feed
    by = 'chromium';
  }
  return {
    version: entry.version || null,
    chromium: entry.chromium || null,
    url: entry.url,
    notes: entry.notes || null,
    security: entry.security === true,
    platform: key,
    // What a Dismiss remembers: the OFFERED release when DisplayXR versions decided, else
    // the offered Chromium (the original key, so old dismissals keep working).
    dismissKey: by === 'displayxr' ? entry.version : entry.chromium,
  };
}

/**
 * Everything evaluate() needs from userAgentData, or null when the Chromium version cannot
 * be known EXACTLY. Never guesses from navigator.userAgent — see the header.
 */
export async function runningVersions() {
  const uad = typeof navigator !== 'undefined' ? navigator.userAgentData : undefined;
  if (!uad || typeof uad.getHighEntropyValues !== 'function') return null;
  try {
    const hints = await uad.getHighEntropyValues(['fullVersionList', 'platform']);
    const list = hints && hints.fullVersionList;
    const chromium = pickChromiumVersion(list);
    if (!chromium) return null;
    return {
      chromium,
      displayxr: pickDisplayXRVersion(list),
      branded: hasDisplayXRBrand(list),
      platform: (hints && hints.platform) || uad.platform || null,
    };
  } catch {
    return null; // permission denied / not a secure context
  }
}

/** The running Chromium version only (kept for existing callers). */
export async function runningChromiumVersion() {
  const v = await runningVersions();
  return v ? v.chromium : null;
}

function dismissed(key) {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === key;
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
  const chromium = info.chromium ? `Chromium ${info.chromium}` : '';
  text.textContent = info.version
    ? `${label} — ${info.version}${chromium ? ` (${chromium})` : ''}`
    : `${label} — ${chromium}`;
  // Linux installs from the apt repository; a download link would bypass it.
  if (info.platform === 'linux') text.textContent += ' — update with apt';

  const link = document.createElement('a');
  link.href = info.platform === 'linux' && info.notes ? info.notes : info.url;
  link.textContent = info.platform === 'linux' ? 'Release notes' : 'Download';
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
      window.localStorage.setItem(DISMISS_KEY, info.dismissKey);
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
  // `version` may be a Chromium string (the original override) or a runningVersions() object.
  const running = version ?? (await runningVersions());
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
  if (!info || dismissed(info.dismissKey)) return null;
  if (document.body) render(info);
  else window.addEventListener('DOMContentLoaded', () => render(info), { once: true });
  return info;
}

// Auto-run when included as a plain module, unless the host page opts out with
// <script type="module" src="version-check.js" data-manual>.
if (typeof document !== 'undefined' && !document.currentScript?.hasAttribute('data-manual')) {
  checkForUpdate();
}
