# displayxr-inline3d: a Claude Code plugin for glasses-free 3D web pages

Helps a coding agent build pages on [`@displayxr/inline3d`](https://www.npmjs.com/package/@displayxr/inline3d)
(woven glasses-free 3D in the DisplayXR Browser, plain 2D everywhere else) and **check them
before calling them done**.

The plugin itself is instructions only: Markdown skills, plus this README, a licence
and an icon. It contains no scripts, no hooks and no MCP server. The tools the skills use (the page
checker, the asset check, the page templates and the optional generators) live in the open-source
npm package [`@displayxr/inline3d-tools`](https://www.npmjs.com/package/@displayxr/inline3d-tools)
([source](https://github.com/DisplayXR/displayxr-web/tree/main/tools/inline3d-tools)), which the
skills run at one exact pinned version, `npx -y @displayxr/inline3d-tools@0.1.0 <command>`, as an
ordinary shell command that you approve.

| part | what it does |
|---|---|
| `skills/inline3d` | auto-loads when a task touches `@displayxr/inline3d`: content type and entry point, view rig, depth/comfort, the woven-canvas checklist, chrome and detection, exact pins, and when to run the checker. Points at the docs inside the installed SDK package instead of copying them. |
| `skills/new-inline3d-page` | scaffolds a page from a known-good template (vanilla ESM + import map, or Vite) with `inline3d-tools scaffold`. |
| `skills/inline3d-assets` | get → prepare → check 3D assets: glTF-Transform (pinned, via npx), headless Blender **only if already installed** (`inline3d-tools assets prep`), `inline3d-tools assets` (tablet/desktop budgets, decoders, units, textures, materials), optional paid generation through `inline3d-tools gen` (`meshy`, `tripo`, `openai`; keys from the environment only, `--confirm-paid` per call after your yes), and `ASSETS.md` provenance. |
| `skills/inline3d-check` | `/displayxr-inline3d:inline3d-check <target>` (or just "check this page"): runs the checker and fixes what fails. A skill rather than a command, so agents that read the plugin's skills but not `commands/` (OpenAI Codex) get it too. |

## What this plugin runs, sends and fetches

Nothing runs in the background and nothing is sent anywhere by default. Every command is one the
agent proposes and you approve, and the paid ones need your yes first.

| part | runs | network | writes |
|---|---|---|---|
| skills | nothing by themselves (instructions to the agent) | none | none |
| `npx -y @displayxr/inline3d-tools@0.1.0 …` (any command below) | `npx`, when the agent runs it | the npm registry, to fetch that exact version of the package and its pinned dependencies (first run; then npm's cache) | npm's cache directory |
| `… check` | `node` + a headless Chrome it starts (local install, or `CHROME=`) and closes; a static file server on `127.0.0.1`, random port, when you pass a directory | whatever the page under test loads (for example its CDN imports); nothing else | a throwaway Chrome profile in the OS temp directory, deleted when Chrome closes; a JSON report only with `--out` |
| `… assets <file>` | `node`, reads a GLB/glTF | none | none |
| `… assets prep` | your **already installed** Blender, headless, with the package's prep script; never installs Blender | none | the output file you name |
| `… scaffold` | `node`, copies the package's page templates | none | the template files, into the directory you name; never overwrites without `--force` |
| `npx -y @gltf-transform/cli@4.3.0` (asset skill) | glTF-Transform, when the agent optimises a model | the npm registry, to fetch that package | the output file you name |
| `… gen run` (optional, paid) | `node` | `api.meshy.ai`, `api.tripo3d.ai` or `api.openai.com` (the adapter you pick), with your prompt or image URL and your key for that provider; then downloads the result from the URL the provider returns | the output file and a row in `ASSETS.md` |
| `… gen provenance` | `node` | none | a row in `ASSETS.md` |

`gen run` refuses to call a provider without `--confirm-paid`, and the skill passes that flag only
after you approved that one call and its estimated cost. It never prints, logs or writes a key, and
redacts long tokens from provider error messages. DisplayXR receives nothing from this plugin or the
package: no telemetry, no accounts. Prompts and images you send to a generator are governed by that
provider's terms.

## Where it works

Claude Code, on macOS, Windows or Linux. The skills are plain instructions with no plugin-root paths,
so agents that read this marketplace's skills (OpenAI Codex) can use them too; inside Codex's default
sandbox the checker's local server is blocked, so there use the MCP server below or approve running
`check` outside the sandbox. The commands need Node ≥ 18 (with `npx`) on the machine;
the checker also needs Chrome or Chromium. The skills work without either: if a command cannot run,
the agent says so and gives you the command.

## Install

From the marketplace in this repo:

```
/plugin marketplace add DisplayXR/displayxr-web
/plugin install displayxr-inline3d@displayxr
```

From a clone: `claude --plugin-dir <repo>/plugins/displayxr-inline3d`.

## Optional: the MCP server

The same npm package has a stdio MCP server (`inline3d-tools mcp`) with the same operations as
tools (`check`, `asset_check`, `scaffold`, `gen_providers`, `gen_run`, `gen_provenance`,
`authoring_guide`). The plugin does **not** configure it; it is an add-on you can set up yourself in
Claude Code or any other MCP client. The package README has the snippets:
[MCP configuration](https://github.com/DisplayXR/displayxr-web/tree/main/tools/inline3d-tools#mcp-server).

## Generator API keys (optional)

Only the asset skill's optional generation step needs keys. Everything else works without them.
`gen` reads each key from the environment of the shell Claude Code runs commands in, and from
nowhere else:

| Adapter | Variable | Makes |
|---|---|---|
| `meshy` | `MESHY_API_KEY` | text/image → GLB model |
| `tripo` | `TRIPO_API_KEY` | text/image → GLB model |
| `openai` | `OPENAI_API_KEY` | images (textures, posters, backdrops); model via `OPENAI_IMAGE_MODEL`, default `gpt-image-2.5-flare` |

Set the ones you have yourself, before starting Claude Code. Don't paste a key into the chat; the
skill never asks for one, prints one or writes one to a file. `gen providers` lists which adapters
see a key (names only). Every call is paid, and the skill asks before each one.

## The checker

What it checks, how, and its blind spots are documented with the package:
[`inline3d-tools check`](https://github.com/DisplayXR/displayxr-web/tree/main/tools/inline3d-tools#check).
In short: it loads the page in headless Chrome inside a fake DisplayXR inline-3D environment (two
geometric eye views) and again plain, and reports pass/fail per rule: session, stereo, blank eyes,
flat side-by-side, buffer, CSS, overlay, session end, console, 2D fallback, detection, pins and
measured depth. It is not a panel: a pass is a fake-environment check, and the skills say so.

## Other agents

The authoring checklist in these skills is also published for agents that do not read Claude
plugins (OpenAI Codex and others) as
[`AGENTS.md`](https://github.com/DisplayXR/displayxr-web/blob/main/tools/inline3d-tools/AGENTS.md)
in the package, generated from these skill files and checked for drift in CI.
