# @displayxr/inline3d-tools

Tools for building 3D web pages for Spatial Displays on
[`@displayxr/inline3d`](https://www.npmjs.com/package/@displayxr/inline3d), for any coding agent
or a human: a headless page checker, a glTF/GLB asset check, page scaffolds, optional paid asset
generation with provenance, and a stdio [MCP](https://modelcontextprotocol.io) server exposing the
same operations. [`AGENTS.md`](AGENTS.md) is the matching authoring checklist for agents.

Needs Node ≥ 18. `check` also needs a local Chrome or Chromium. Always run an **exact version**:

```sh
npx -y @displayxr/inline3d-tools@0.1.8 <command> ...
```

## CLI

| command | what it does |
|---|---|
| `check <url \| dir \| page.html> [--root <dir>] [--max-texture 4096] [--timeout ms] [--viewport WxH] [--no-fallback] [--json] [--out report.json]` | Loads the page in headless Chrome inside a fake DisplayXR Browser (two real eye views) and again plain, and reports pass/fail per rule. Exit 0 pass (warnings allowed), 1 a check failed, 2 the checker could not run. [Details](#check). |
| `assets <file.glb\|file.gltf> [--target tablet\|desktop] [--json]` | Is this model ready for an inline-3D page: missing files, decoders, triangles, draw calls, units/pivot, textures and decoded GPU memory, alpha-BLEND and metal/glass materials, file size, animations. Exit 0 / 1 (a FAIL) / 2 (unreadable). No network. |
| `assets prep <in> <out.glb> [--metres 0.01] [--decimate 0.5] [--blender <path>]` | Converts FBX/OBJ/STL/PLY/DAE/.blend (or fixes a glTF) with your **already installed** Blender, headless: applies transforms, scales to metres, decimates, recentres, exports one GLB. Never installs Blender. |
| `scaffold <esm\|vite> <dir> [--title "..."] [--name <npm-name>] [--force]` | Copies a known-good page: one persistent canvas, a cover that always comes off, a mono 2D fallback, exact pins (`esm`: import map, no build; `vite`: `package.json`). Never overwrites without `--force`. The untouched template passes every `check` rule. |
| `gen providers` | Which generator adapters have an API key in the environment (names and presence only). |
| `gen run <meshy\|tripo\|openai> --kind <text-to-3d\|image-to-3d\|image> --prompt "..." [--image <url>] [--size WxH] --out <file> --confirm-paid` | **Paid.** One call to the provider with your own key, writes the file and an `ASSETS.md` row. Without `--confirm-paid` it makes no call and prints the cost estimate (exit 4); without the key, exit 3. |
| `gen provenance --file <f> --source "..." --license "..." [--notes "..."]` | Appends a row to `ASSETS.md` in the working directory. |
| `mcp` | Starts the stdio MCP server. |

## MCP server

`inline3d-tools mcp` speaks MCP over stdio and exposes:

| tool | what | side effects |
|---|---|---|
| `check` | `target`, `root?`, `max_texture?`, `timeout_ms?`, `viewport?`, `fallback?` → the report (text + structured) | starts and closes a headless Chrome; loads the page |
| `asset_check` | `file`, `target?` → the report | none |
| `scaffold` | `flavour`, `dir`, `title?`, `name?`, `force?` | writes the template files |
| `gen_providers` | → adapters and key presence (never a key) | none |
| `gen_run` | `adapter`, `kind`, `prompt?`, `image?`, `size?`, `out`, **`confirm_paid`** (required) | **paid** provider call only when `confirm_paid` is `true`; writes the file + `ASSETS.md` |
| `gen_provenance` | `file`, `source`, `license`, `notes?` | appends to `ASSETS.md` |
| `authoring_guide` | → [`AGENTS.md`](AGENTS.md) | none |

Relative paths resolve against the server's **working directory**: start it in the project root
(Codex: set `cwd`). `gen_run` with `confirm_paid: false` returns the cost estimate and makes no call;
an agent passes `true` only after the user approved that one call. Keys come from the server's
environment only and are redacted from every tool result.

### Claude Code

```sh
claude mcp add inline3d-tools -- npx -y @displayxr/inline3d-tools@0.1.8 mcp
```

or in a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "inline3d-tools": {
      "command": "npx",
      "args": ["-y", "@displayxr/inline3d-tools@0.1.8", "mcp"]
    }
  }
}
```

(The [`displayxr-inline3d` Claude Code plugin](https://github.com/DisplayXR/displayxr-web/tree/main/plugins/displayxr-inline3d) does not need the
server: its skills run the CLI. The server is an optional add-on.)

### OpenAI Codex

**Use the MCP server in Codex.** MCP servers run outside Codex's sandbox; a shell `check` does not:
its local file server fails with `listen EPERM 127.0.0.1` in the default sandbox, so a shell run
needs you to approve running it outside the sandbox. In `~/.codex/config.toml` (or a trusted project's `.codex/config.toml`), one
`[mcp_servers.<name>]` table per server, as in the
[Codex MCP documentation](https://developers.openai.com/codex/mcp):

```toml
[mcp_servers.inline3d-tools]
command = "npx"
args = ["-y", "@displayxr/inline3d-tools@0.1.8", "mcp"]
# cwd = "/path/to/your/project"   # relative paths in tool calls resolve here
startup_timeout_sec = 30          # first run downloads the package (default 10)
tool_timeout_sec = 180            # a page check takes 10-60 s; generation can take minutes (default 60)
# Only if you use the optional paid generators: forward these from your shell.
# env_vars = ["MESHY_API_KEY", "TRIPO_API_KEY", "OPENAI_API_KEY"]
```

or `codex mcp add inline3d-tools -- npx -y @displayxr/inline3d-tools@0.1.8 mcp`. The
[`displayxr-inline3d-codex` plugin](https://github.com/DisplayXR/displayxr-web/tree/main/plugins/displayxr-inline3d-codex)
sets the server up for you in Codex.

**Fetch the package once before the first Codex session:** `npx -y @displayxr/inline3d-tools@0.1.8 --version`.
Codex starts MCP servers when a session starts and can stop one before a cold `npx` download
finishes. The interrupted download leaves a broken entry in npm's `_npx` cache (`node_modules`
without a `package.json`), and from then on the server fails at every start with
`npm error enoent Could not read package.json` in Codex's log. To recover, delete the
`~/.npm/_npx/<hash>` directory named in that error, then run the command above.

Codex reads
[`AGENTS.md`](AGENTS.md) files from the project: copy this package's into yours (or call the
`authoring_guide` tool).

### Cursor

In `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "inline3d-tools": {
      "command": "npx",
      "args": ["-y", "@displayxr/inline3d-tools@0.1.8", "mcp"]
    }
  }
}
```

## What it runs, sends and fetches

Nothing runs in the background and nothing is sent anywhere by default. Every network call is one
you or the agent makes on purpose, and the paid ones need an explicit confirmation per call.

| command / tool | runs | network | writes |
|---|---|---|---|
| `npx -y @displayxr/inline3d-tools@<v>` | `npx` | the npm registry, to fetch this package and its pinned dependencies (first run; then npm's cache) | npm's cache |
| `check` | `node` + a headless Chrome it starts (local install, or `CHROME=`) and closes; a static file server on `127.0.0.1`, random port, when you pass a directory | whatever the page under test loads (for example its CDN imports); nothing else | a throwaway Chrome profile in the OS temp directory, deleted when Chrome closes; a JSON report only with `--out` |
| `assets` | `node`, reads a GLB/glTF | none | none |
| `assets prep` | your installed Blender, headless, with `lib/assets/blender/prep.py` | none | the output file you name |
| `scaffold` | `node` | none | the template files, in the directory you name |
| `gen providers` | `node` | none | none |
| `gen run` (optional, paid) | `node` | `api.meshy.ai`, `api.tripo3d.ai` or `api.openai.com` (the adapter you pick), with your prompt or image URL and your key for that provider; then downloads the result from the URL the provider returns | the output file and a row in `ASSETS.md` |
| `gen provenance` | `node` | none | a row in `ASSETS.md` |
| `mcp` | `node`, the stdio server; each tool as above | as above | as above |

`gen run` refuses to call a provider without `--confirm-paid` (MCP: `confirm_paid: true`). It reads
each key from the environment only, never prints, logs or writes one, and redacts long tokens from
provider error messages. DisplayXR receives nothing from this package: no telemetry, no accounts.
Prompts and images you send to a generator are governed by that provider's terms.

### Generator keys (optional)

| Adapter | Variable | Makes |
|---|---|---|
| `meshy` | `MESHY_API_KEY` | text/image → GLB model |
| `tripo` | `TRIPO_API_KEY` | text/image → GLB model |
| `openai` | `OPENAI_API_KEY` | images (textures, posters, backdrops); model via `OPENAI_IMAGE_MODEL`, default `gpt-image-2.5-flare` |

Set them in the environment the tool runs in (your shell profile, or your MCP client's env
forwarding). Never paste a key into an agent chat.

## check

```sh
npx -y @displayxr/inline3d-tools@0.1.8 check <url | dir | page.html> [--root <dir>] [--max-texture 4096] [--json] [--out report.json]
```

Needs Node ≥ 18 and a local Chrome (`CHROME=/path/to/chrome` overrides the default location). It
speaks the DevTools protocol over a pipe, so it opens no port, and it closes the
Chrome it started. If Chrome does not answer on that pipe within 15 s (a cold start on a busy
machine), the checker retries once with a fresh profile before giving up (0.1.1). Exit code 0 = pass (warnings allowed), 1 = a check failed, 2 = the checker could
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
| (g) `console` | console errors, uncaught exceptions and unhandled promise rejections (labelled as such, 0.1.2), HTTP ≥ 400, GL errors, failed shader compile/link | real |
| (h) `fallback-2d` | second run without the fake: no errors, and each canvas that wove shows something | real |
| (h) `startup-guard` | static scan of same-origin scripts: a `createInline3D()` / `sharedInline3D()` / `startInline3D()` call in a file with no `.catch(` or `try`/`catch` at all is a WARN (a rejection there leaves a blank or covered canvas), 0.1.2 | approximate |
| `detection` | runtime `isSessionSupported('inline-3d')` calls; static scan of same-origin scripts for it and for UA sniffing next to "DisplayXR" | approximate |
| `pins` | import-map CDN URLs and `package.json` versions for the SDK, playcanvas and three are exact | approximate |
| `depth` | block-matched disparity of the primary canvas, in mm of screen disparity, against the Shibata comfort zone at 0.65 m; subject entirely off the glass | approximate |
| `depth-underused` | too little depth is a failure too (a report, never a limit), 0.1.3. **Camera rig: measured** from the two eye images: the share of the Shibata comfort zone (0.65 m) the default view uses, on its binding side (`max(|p05| / front, p95 / behind)` of the block disparities, mm on the glass; `cameraRigComfortFactor` ≈ 1 / that share). Below 30 % is a WARN; a rig converged at infinity WARNs too. The hint gives the rule: convergence on the centre of interest, `metersToVirtual` = the true conversion or `convergence / 2` (no true scale), then `ipdFactor` ≈ 1 (open scene) or 0.8–1× `cameraRigComfortFactor` (bounded). **Display rig: from the rig** (its natural depth is the subject's real proportions, so the measured span is not judged): `ipdFactor` below 0.5 is a WARN (0 = 2D on purpose) | camera: approximate; display: real |
| `backdrop-on-glass` | rule 10, 0.1.4 (a report, never a limit). A picture the page draws under the woven canvas (a CSS `background-image` with a `url()`, an `<img>`, a `<video>`: found by walking the paint order below the canvas on a 9×6 grid) sits at the depth of the glass. WARN when at least 10% of the canvas has such a picture under it, at least 10% of the eye images is see-through, and the measured content reaches behind the glass (p95 of the block disparities past 10% of the rear comfort zone). The hint: draw the backdrop in the scene, behind the subject (`backdropPlacement()`), or bring the subject on or in front of the glass | approximate |

Also reported: the rig (display/camera and its fields) and, for a camera rig, the comfort number
`ipdFactor × metersToVirtual × convergenceDiopters × 0.65` (the divergence ceiling: keep ≤ 1).

**Blind spots.** It is not a panel: no weave, no real compositor join, no eye tracking, no crosstalk.
Views come from the most recently created layer, so a page with several tiles on different rigs is
approximated by one. Heuristics on pixels can be fooled by unusual content (repeating patterns,
huge disparity, a page that animates wildly between snapshots). Lazy tiles below the fold are
found by scrolling, which a page may react to. CDN-hosted samples need the network.

## Development

From the repository root: `npm test` runs these unit tests with the SDK's; `npm run test:plugin:e2e`
runs the checker end to end on the repo's samples (needs Chrome). In this folder, `npm ci` installs
the MCP SDK so `test/mcp.test.mjs` runs too. After editing a plugin skill or bumping the version,
run `node tools/inline3d-tools/scripts/sync-agents.mjs` (regenerates `AGENTS.md` and the plugin's
pins; CI checks it). Publishing: `tools-vX.Y.Z` tags, see
[`.github/workflows/tools-publish.yml`](https://github.com/DisplayXR/displayxr-web/blob/main/.github/workflows/tools-publish.yml).

## License

Apache-2.0.
