---
name: inline3d-check
description: Check an @displayxr/inline3d page in headless Chrome (a fake DisplayXR Browser with two real eye views, plus a plain 2D run) and fix what fails. Use when the user asks to check, test, verify or validate an inline-3D page, or before saying such a page is done.
argument-hint: "<url | dir | page.html> [--root <dir>] [--max-texture 4096]"
allowed-tools: Read, Grep, Glob
---

# Check an inline-3D page

Target: the page the user named (as a slash command, the arguments: `$ARGUMENTS`). If none, use the
page you are working on: a running dev server URL, or the directory holding its `index.html`.

Run the checker from the exact-pinned `@displayxr/inline3d-tools` npm package (the first run
downloads it; the user approves the command):

```sh
npx -y @displayxr/inline3d-tools@0.1.7 check <url | dir | page.html>
```

If the `inline3d-tools` MCP server is configured, its `check` tool does the same (`target`, `root`,
`max_texture`) and is the better route inside a sandbox (OpenAI Codex's default sandbox blocks the
checker's local file server, `listen EPERM 127.0.0.1`; a shell `check` there needs the user to
approve running outside the sandbox).

Add `--root <project>` when the page imports `../` or `/node_modules/`, and `--max-texture 4096` for a
large or full-screen canvas (the Android tablet's limit). `--json` prints the full report. It needs
Node ≥ 18 and a local Chrome (`CHROME=/path/to/chrome` overrides the location).

Then, for every FAIL: fix it in the page, following the line's `fix:` hint and the doc it names under
`node_modules/@displayxr/inline3d/docs/`; re-run until nothing fails. Report WARN lines to the user
with a one-line judgement each (fixed, or why it is acceptable). A `depth-underused` WARN means the
page reads nearly flat: raise the rig's depth as its hint says (convergence on the subject, `metersToVirtual` set, not the world
rescaled, then `ipdFactor`), don't explain it away as "comfortable". A `backdrop-on-glass` WARN means a page image
shows through the canvas while the subject reaches behind the glass: move the picture into the scene as a
plane behind the subject (`backdropPlacement()`, rule 10), or use a plain colour or soft gradient. Say plainly that a passing run is a
fake-environment check, not a test on a real 3D panel.
