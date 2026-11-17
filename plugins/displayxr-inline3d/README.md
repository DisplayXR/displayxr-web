# displayxr-inline3d: a Claude Code plugin for glasses-free 3D web pages

Helps a coding agent build pages on [`@displayxr/inline3d`](https://www.npmjs.com/package/@displayxr/inline3d)
(woven glasses-free 3D in the DisplayXR Browser, plain 2D everywhere else) and **check them
before calling them done**.

| part | what it does |
|---|---|
| `skills/inline3d` | auto-loads when a task touches `@displayxr/inline3d`: content type and entry point, view rig, depth/comfort, the woven-canvas checklist, chrome and detection, exact pins. Points at the docs inside the installed package instead of copying them. |
| `skills/new-inline3d-page` | scaffolds a page from a known-good template (vanilla ESM + import map, or Vite). |
| `skills/inline3d-assets` | get → prepare → check 3D assets: glTF-Transform (pinned, via npx), headless Blender **only if already installed**, a zero-dependency `assets/bin/asset-check.mjs` (tablet/desktop budgets, decoders, units, textures, materials), optional paid generation through `assets/bin/gen.mjs` adapters (`meshy`, `tripo`, `openai`; keys from the environment only, `--confirm-paid` per call after the user's yes), and `ASSETS.md` provenance. |
| `commands/inline3d-check` | `/displayxr-inline3d:inline3d-check <target>`: runs the checker and fixes what fails. |
| `checker/` | `inline3d-check`: loads the page in headless Chrome inside a fake DisplayXR inline-3D environment, and again plain, and reports pass/fail per rule. |
| `hooks/` | non-blocking reminders to run the checker after editing an inline-3D page. |

## What this plugin runs, sends and fetches

Nothing runs in the background and nothing is sent anywhere by default. Every network call is one
the agent makes on purpose, and the paid ones need your yes first.

| part | runs | network | writes |
|---|---|---|---|
| skills, command | nothing by themselves (instructions to the agent) | none | none |
| `hooks/remind-check.mjs` | `node`, after Edit/Write/MultiEdit/Bash and at the end of a turn; reads the edited file to see whether it uses `@displayxr/inline3d` | none | one small JSON state file per session in the OS temp directory (`displayxr-inline3d-hook/`) |
| `checker/` | `node` + a headless Chrome it starts (local install, or `CHROME=`) and closes; a static file server on `127.0.0.1`, random port, when you pass a directory | whatever the page under test loads (for example its CDN imports); nothing else | a throwaway Chrome profile in the OS temp directory, deleted when Chrome closes; a JSON report only with `--out` |
| `assets/bin/asset-check.mjs` | `node`, reads a GLB/glTF | none | none |
| `skills/inline3d-assets` → glTF-Transform | `npx -y @gltf-transform/cli@4.3.0` (exact pin), when the agent optimises a model | the npm registry, to fetch that package | the output file you name |
| `skills/inline3d-assets` → Blender | `assets/blender/prep.py` in Blender, **only if Blender is already installed**; never installs it | none | the output file you name |
| `assets/bin/gen.mjs run` (optional, paid) | `node` | `api.meshy.ai`, `api.tripo3d.ai` or `api.openai.com` (the adapter you pick), with your prompt or image URL and your key for that provider; then downloads the result from the URL the provider returns | the output file and a row in `ASSETS.md` |

`gen.mjs` refuses to call a provider without `--confirm-paid`, and the skill passes that flag only
after you approved that one call and its estimated cost. It never prints, logs or writes a key, and
redacts long tokens from provider error messages. DisplayXR receives nothing from this plugin: no
telemetry, no accounts. Prompts and images you send to a generator are governed by that provider's
terms.

## Where it works

Claude Code, on macOS, Windows or Linux. The checker and the hooks need Node ≥ 18 on the machine;
the checker also needs Chrome or Chromium. The skills work without either.

## Install

From a clone: `claude --plugin-dir <repo>/plugins/displayxr-inline3d`.

From the marketplace in this repo:

```
/plugin marketplace add DisplayXR/displayxr-web
/plugin install displayxr-inline3d@displayxr
```

## Generator API keys (optional)

Only the asset skill's optional generation step needs keys. Everything else works without them.
`gen.mjs` reads each key from the environment of the shell Claude Code runs commands in, and from
nowhere else:

| Adapter | Variable | Makes |
|---|---|---|
| `meshy` | `MESHY_API_KEY` | text/image → GLB model |
| `tripo` | `TRIPO_API_KEY` | text/image → GLB model |
| `openai` | `OPENAI_API_KEY` | images (textures, posters, backdrops); model via `OPENAI_IMAGE_MODEL`, default `gpt-image-2.5-flare` |

Set the ones you have **before starting Claude Code**, either in your shell profile
(`export MESHY_API_KEY=…` in `~/.zshrc` / `~/.bashrc`) or in the `env` block of
`~/.claude/settings.json`. Don't paste a key into the chat; the skill never asks for one, prints one
or writes one to a file. `node <plugin>/assets/bin/gen.mjs providers` lists which adapters see a key
(names only). Every call is paid, and the skill asks before each one.

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
| (f) `overlay` | grid hit-test (pointer-events forced on) for opaque elements above the canvas after `firstWoven`; a cover present at registration and still there = "never came off"; then a **scroll sweep** over the whole page: chrome that passes over a tile with a filter, blend mode or 3D context, a whole-tile frost, or a section painted over the whole tile. Partial chrome (sticky header, buy card), opaque or translucent, passes: current browsers occlude by draw order | real, grid-sampled |
| (f) `layer-lost` | ends the session, then compares each canvas with what it showed before: unchanged = the page left its side-by-side pair up (no-op `onLayerLost`) | real |
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

From the repository root:

```sh
node --test plugins/displayxr-inline3d/checker/test/analyze.test.mjs plugins/displayxr-inline3d/assets/test/asset-check.test.mjs   # no browser
npm run test:plugin:e2e                                                                                                        # Chrome: samples + one broken page per check
```

The e2e suite (`test/plugin/checker.e2e.mjs`, outside the plugin folder because it reads the repo's
samples) runs the repo's `hello-cube`, `model`, `splat` and `player` samples (no check may fail)
and `test/fixtures/scene.html`, a raw-WebGL page that is clean by default and breaks one rule per
`?bug=` value.
