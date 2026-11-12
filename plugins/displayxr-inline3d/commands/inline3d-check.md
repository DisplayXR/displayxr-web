---
description: Check an @displayxr/inline3d page in headless Chrome (fake DisplayXR Browser + plain 2D run) and fix what fails
argument-hint: "<url | dir | page.html> [--root <dir>] [--max-texture 4096]"
allowed-tools: Bash(node:*)
---

Run the inline-3D checker on `$ARGUMENTS` (if empty, use the page you are working on: a running dev
server URL, or the directory holding its `index.html`):

```sh
node "${CLAUDE_PLUGIN_ROOT}/checker/bin/inline3d-check.mjs" $ARGUMENTS
```

Add `--root <project>` when the page imports `../` or `/node_modules/`, and `--max-texture 4096` for a
large or full-screen canvas (the Android tablet's limit). `--json` prints the full report.

Then, for every FAIL: fix it in the page, following the line's `fix:` hint and the doc it names under
`node_modules/@displayxr/inline3d/docs/`; re-run until nothing fails. Report WARN lines to the user
with a one-line judgement each (fixed, or why it is acceptable). Say plainly that a passing run is a
fake-environment check, not a test on a real 3D panel.
