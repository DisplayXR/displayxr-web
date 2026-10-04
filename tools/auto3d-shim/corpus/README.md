# auto-3D no-harm corpus (the P4 gate)

Before auto-3D is on by default everywhere (design §3.9, §4 row 4), the injected scripts must be
shown to **do no harm** on pages that have no 3D engine, and to convert, or cleanly stay 2D, on
pages that have one. This folder runs the **product bundle** over live outside sites and compares
each one against a control load of the same site without it.

It does not replace the panel. It cannot judge woven 3D, comfort, or whether controls still work by
hand. It covers the mechanical half of §3.9: cost, page-visible surface, errors, and outcome.

## Running it

```sh
cd tools/auto3d-shim/corpus
npm install                         # puppeteer-core only; uses your installed Chrome
node run-corpus.mjs --sample        # the 10 sites marked "sample": true (~5-6 min)
node run-corpus.mjs                 # all ~70 sites (~35 min at ~30 s/site; use a quiet box)
node run-corpus.mjs --group engine  # one group
node run-corpus.mjs --only google,three-bloom
node run-corpus.mjs --keep          # also write control/injected screenshots to results/<tag>/
```

`CHROME=<binary>` overrides the Chrome path (defaults as in `../test/run.mjs`). Sites run one at a
time (concurrency 1), since timings mean nothing on a contended GPU. Output:
`results/<date>[-sample|-<group>|-only].json` (everything per site) and a `.md` table with a
PASS / REVIEW / FAIL per site and a one-line verdict. The exit code is 1 if any site FAILs.

## What one site costs

Each site is loaded twice, in fresh incognito contexts of real-GPU headless Chrome with
`../test/run.mjs`'s launch flags (including `--disable-features=OpenXR,WebXR`):

| load | injected at document start (main world, **main frame only**) |
|---|---|
| control | `../test/fake-xr.js` + a probe |
| injected | `../test/fake-xr.js` + the probe + the **committed** `dist/auto3d-sentinel.js` + `dist/auto3d-core.js`, evaluated by `../test/fake-host.js` in product mode with `decision: 'allow'` |

The product texts are what the browser vendors (checked against `VENDOR.json`; a mismatch warns).
Each gets a `//# sourceURL` (`dxr-auto3d-sentinel.js`, `dxr-auto3d-core.js`), so a timer, observer
or exception can be traced to **our** code by its stack. The probe snapshots `window`'s own keys
and the own-property descriptors of `Object`, `EventTarget`, `Node`, `Element`, `HTMLElement`,
`HTMLCanvasElement`, `Document` and `Window` prototypes; it counts WebGL contexts and
`getContext('webgpu')` calls, records every timer whose creating stack is ours, and times our
`MutationObserver`'s callbacks: total ms (`moMs`), the number of callbacks (`moCalls`) and the
longest single one (`moMaxMs`), so a total over the REVIEW line can be judged per callback. The
probe runs in both loads, so its own changes cancel out.

Every injected text is gated on `window === window.top` and run with an indirect `eval`.
`evaluateOnNewDocument` also runs in same-process subframes, including sandboxed `about:blank`
frames without `allow-scripts`. A listener registered there is blocked when it fires, and Chrome
logs "Blocked script execution in 'about:blank'…" for each firing (youtube, cnn, stackoverflow, ebay,
spotify, cesium, unity-play in the 2026-10-03 run). The browser injects into the main frame here,
so subframes get nothing in either load.

Each load gets a 30 s navigation budget (`--budget-ms`). If `load` never fires, the partial page is
judged and the site is marked REVIEW. After load the page is watched for 6 s (plain), 12 s
(engine) or 10 s (sdk). A terminal report (`live`, `flat`, `standdown`, `guard`, `optout`) ends the
watch 2 s later. Then the injected tab is reloaded three times for the **warm** sentinel cost.
Only the injected load reloads. Console errors, page errors and our log lines from those reloads go
into separate buckets (`warmErrors`, shown as `+N` in the table) and are **not judged**. The verdict
compares the two first loads, like for like. Repeat visits log things a first visit does not: FedCM
"Not signed in with the identity provider" (reddit, notion, stackoverflow) and 403s (etsy).

Both loads use `setBypassCSP(true)` and a user agent without "Headless". The real injector is
exempt from a page's CSP, but the fake host uses `eval`, which a strict CSP or Trusted Types would
block.

## What "no harm" means

A site **FAILs** on any of the following (design §3.3):

- **cost:** the sentinel's evaluate-and-run time is 0.5 ms or more, **warm** (median of the three
  reloads). The cold first load in a fresh context has no V8 cache and costs 3-4 ms on the win box.
  It is recorded, not judged: the §3.3 target and `test/cases/sentinel.mjs` `s-cost` are warm
  figures. Whether the browser's injector gets a code cache is a browser-side question.
- **prototypes:** any descriptor change on the prototypes above other than
  `HTMLCanvasElement.prototype.getContext`, compared with the control. On WebGL pages the
  sentinel's transient one-shot `Object.prototype` id setter is tolerated.
- **window:** a new `window` key other than `__THREE_DEVTOOLS__`, or `pc` on a page that created a
  WebGL context, when the key is ours (named `dxr`/`auto3d`, or `pc`). `'pc' in window` newly true
  on a page with no WebGL is a FAIL.
- **pages with no graphics context** (no WebGL context and no `getContext('webgpu')` in either
  load): any timer created by our code, or `cap.loadCore()` called. A WebGPU page (three.js
  `WebGPURenderer`) is a graphics page. The core may load there, since three announces itself, and
  the expected outcome is `flat (WebGPURenderer …)`. A WebGPU-only page that converts is REVIEW.
- **errors:** an uncaught exception whose stack is ours (`dxr-auto3d-*.js`, `dxr…` part functions),
  or a new console error that names us.
- **outcome:** a `plain` page that converts or detects an engine, unless the control load shows
  three.js or PlayCanvas too (then it is REVIEW: relabel the site). An `sdk` page that converts: the
  core must stand down to the page's own inline-3D session. A page that loads without injection
  and not with it.

A site is **REVIEW** when something differs but cannot be pinned on us. Examples: console errors
missing from the control (ads and network noise; re-run), unattributed new window keys, page text
or element count below half the control's, our observer's callbacks over 5 ms in total (the reason
gives the callback count and the longest callback), an engine
page stuck `converting` or flat without a reason, an `offer` under `allow`, a converted page under
half the control's frame rate, or a partial load. Keys ending in 4 or more digits
(`closure_lm_560377`) are per-load ids the page makes. They are listed in `keysNoise` and not
judged.

**ERROR** means the site was unreachable in both loads (bot walls, geo-blocks). It says nothing
about us. Replace the site.

Expected outcomes by group:

| group | pass |
|---|---|
| `plain` | `none`: sentinel only, core never loaded, nothing reported |
| `engine` | `converted`, or `flat (reason)` / `standdown (reason)`: clean 2D **with** a reason. A three.js `WebGPURenderer` page: `flat (WebGPURenderer — …)` |
| `sdk` | `standdown` or `none`: never `converted` |

## Not covered here (the panel sample in §3.9)

Only the main frame is covered. The injected texts are gated to the top frame (above), and
`evaluateOnNewDocument` does not reach out-of-process iframes anyway, while the browser injects
`all_frames`. The corpus also does not check whether controls still work, raycast
picking against the virtualised `canvas.width`, screenshot and export features, turning auto-3D off
and back, or anything about woven output.

## Adding a site

Add an entry to `sites.json`:

```json
{ "id": "short-unique-id", "group": "plain|engine|sdk", "url": "https://…",
  "expect": "none|convert|standdown", "engine": "three.js|playcanvas|custom",
  "webgl": true, "sample": false, "note": "why it is in the corpus" }
```

- `group` decides how the site is judged; `engine`, `webgl` and `note` are for readers. The runner
  detects WebGL itself.
- Prefer stable, public, login-free URLs from outside our own properties. §3.9 wants 50 three.js
  and 20 PlayCanvas sites before the default flips, and today's list is short of that.
- Check the URL first with `node run-corpus.mjs --only <id>`. A site that is `ERROR` on every run
  is noise, so replace it.
- Keep `"sample": true` on about 10 sites: 6 plain, 3 engine, 1 sdk.
