# displayxr-inline3d: a Claude Code plugin for glasses-free 3D web pages

Helps a coding agent build pages on [`@displayxr/inline3d`](https://www.npmjs.com/package/@displayxr/inline3d)
(woven glasses-free 3D in the DisplayXR Browser, plain 2D everywhere else) and **check them
before calling them done**.

| part | what it does |
|---|---|
| `skills/inline3d` | auto-loads when a task touches `@displayxr/inline3d`: content type and entry point, view rig, depth/comfort, the woven-canvas checklist, chrome and detection, exact pins. Points at the docs inside the installed package instead of copying them. |
| `skills/new-inline3d-page` | scaffolds a page from a known-good template (vanilla ESM + import map, or Vite). |
| `commands/inline3d-check` | `/displayxr-inline3d:inline3d-check <target>`: runs the checker and fixes what fails. |
| `checker/` | `inline3d-check`: loads the page in headless Chrome inside a fake DisplayXR inline-3D environment, and again plain, and reports pass/fail per rule. |
| `hooks/` | non-blocking reminders to run the checker after editing an inline-3D page. |

## Install

From a clone: `claude --plugin-dir <repo>/plugins/displayxr-inline3d`.

From the marketplace in this repo:

```
/plugin marketplace add DisplayXR/displayxr-web
/plugin install displayxr-inline3d@displayxr
```

## The checker

```sh
node plugins/displayxr-inline3d/checker/bin/inline3d-check.mjs <url | dir | page.html> [--root <dir>] [--max-texture 4096] [--json] [--out report.json]
```

Needs Node ≥ 18 and a local Chrome (`CHROME=/path/to/chrome` overrides the default location). No
`npm install`: it speaks the DevTools protocol over a pipe, so it opens no port, and it closes the
Chrome it started. Exit code 0 = pass (warnings allowed), 1 = a check failed, 2 = the checker could
not run.

The fake environment gives the SDK what the DisplayXR Browser gives it (`navigator.xr`
`inline-3d` session, `XRDisplayLayer`, display info, rendering modes), with **geometric** views: two
eyes 63 mm apart at 0.65 m from a 0.3456 m wide panel, off-axis frusta through the canvas's own
rect, scaled by the page's display or camera rig as the runtime does. A subject on the glass has zero
disparity, so the checker can measure depth in millimetres of screen disparity.

| check | how | real or approximate |
|---|---|---|
| (a) `session` | an `inline-3d` session, an open layer, frames with two views, pixels in the canvas | real |
| (b) `stereo` | the two halves of the committed buffer are not identical, a shift aligns them, and textured blocks match across eyes | real (a flat plane at one depth is a WARN) |
| (c) `eyes-not-blank` | each eye holds more than 0.3 % of something other than one colour | real |
| (d) `no-flat-sbs` | a woven buffer whose halves are not two views of one scene; any visible img/canvas/video showing a packed pair, in either run; join-window exposure (WARN) | heuristic on pixels |
| (e) `buffer` | `canvas.width/height` vs `drawingBufferWidth/Height`; with `--max-texture 4096` Chrome really clamps (`--webgl_or_caps_max_texture_size_limit_4096`) and the GL limits read 4096 | real |
| (f) `css` | computed filter / opacity / mask / clip-path / blend / backdrop-filter / non-translate transform on the canvas and every ancestor, sampled over time; border/radius/shadow and running animations WARN | real |
| (f) `single-session` | concurrent live sessions, a canvas registered twice, overlapping woven canvases | real |
| (f) `overlay` | grid hit-test (pointer-events forced on) for opaque elements above the canvas after `firstWoven`; a cover present at registration and still there = "never came off" | real, grid-sampled |
| (g) `console` | console errors, uncaught exceptions, HTTP ≥ 400, GL errors, failed shader compile/link | real |
| (h) `fallback-2d` | second run without the fake: no errors, and each canvas that wove shows something | real |
| `detection` | runtime `isSessionSupported('inline-3d')` calls; static scan of same-origin scripts for it and for UA sniffing next to "DisplayXR" | approximate |
| `pins` | import-map CDN URLs and `package.json` versions for the SDK, playcanvas and three are exact | approximate |
| `depth` | block-matched disparity of the primary canvas, in mm of screen disparity, against the Shibata comfort zone at 0.65 m; subject entirely off the glass | approximate |

Also reported: the rig (display/camera and its fields) and, for a camera rig, the comfort number
`ipdFactor × metersToVirtual × convergenceDiopters × 0.65`.

**Blind spots.** It is not a panel: no weave, no real compositor join, no eye tracking, no crosstalk.
Views come from the most recently created layer, so a page with several tiles on different rigs is
approximated by one. Heuristics on pixels can be fooled by unusual content (repeating patterns,
huge disparity, a page that animates wildly between snapshots). Lazy tiles below the fold are
found by scrolling, which a page may react to. CDN-hosted samples need the network.

## Tests

```sh
node --test plugins/displayxr-inline3d/checker/test/analyze.test.mjs                               # pixel analysis, no browser
node --test --test-concurrency=1 plugins/displayxr-inline3d/checker/test/checker.e2e.mjs      # Chrome: samples + one broken page per check
```

The e2e suite runs the repo's `hello-cube`, `model`, `splat` and `player` samples (no check may fail)
and `test/fixtures/scene.html`, a raw-WebGL page that is clean by default and breaks one rule per
`?bug=` value.
