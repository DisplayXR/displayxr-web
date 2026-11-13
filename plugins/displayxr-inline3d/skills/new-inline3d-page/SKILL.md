---
name: new-inline3d-page
description: Scaffold a new glasses-free 3D web page or app on @displayxr/inline3d from a known-good template (vanilla ESM + import map, or Vite), with one persistent canvas, a cover that always comes off, a 2D fallback and exact version pins. Use when starting a new inline-3D page, demo or app from scratch.
argument-hint: "[esm|vite] [target-dir] [model|splat|image|video|player|scene]"
---

# Scaffold an inline-3D page

Templates live in `${CLAUDE_SKILL_DIR}/templates/`:

| file | what |
|---|---|
| `templates/app.js` | the page logic (shared by both flavours): a three.js scene on `addScene` with `EyeCamera`, display rig, validate-before-clear with last-good replay, buffer sized 2× the box (dpr ≤ 2, clamped to the GPU), cover removed on `handle.firstWoven` + a 4 s timeout + `catch`, a mono 2D fallback |
| `templates/style.css` | page styles; the canvas and its ancestors carry no CSS effects |
| `templates/esm/index.html` | no build step: an import map with exact CDN pins |
| `templates/vite/index.html`, `templates/vite/package.json` | Vite: exact npm pins (`@displayxr/inline3d` 1.52.3, `three` 0.180.0) |

## Steps

1. Pick the flavour: **esm** unless the project already uses npm/a bundler (then **vite**, or merge
   the pins into the existing `package.json` exactly, no `^`).
2. Copy `app.js` and `style.css` plus the flavour's files into the target directory. Replace
   `__TITLE__` / `__NAME__`. Don't add an `<img>` or extra canvas: there is ONE persistent canvas.
3. Pick the content (the `inline3d` skill §1 table) and swap the scene block if it is not a custom
   scene. Keep the cover, the fallback and the pins. For a model or a splat, replace everything from
   "renderer + scene" down with the viewer call, which handles the buffer, framing, validation and
   the 2D fallback itself:

   ```js
   import { createInline3D } from '@displayxr/inline3d';
   import { addModel } from '@displayxr/inline3d/model';          // or: import { addSplat } from '@displayxr/inline3d/splat/playcanvas';
   const wall = await createInline3D().catch(() => null);           // unsupported -> the viewer draws 2D
   const handle = addModel(wall, canvas, './assets/model.glb');     // addSplat(wall, canvas, './scene.sog', { engine: 'playcanvas' })
   // the page behind the tile shows around the subject: keep it a soft colour (or pass clearColor)
   Promise.race([handle.firstWoven, new Promise((r) => setTimeout(r, 4000))]).finally(dropCover);
   ```

   A player is the same shape: `addPlayer(wall, canvas, ['./clip.webm', './clip.mp4'], { poster })`
   from `/player` (webm first; the canvas sits in a container for the transport), and the cover
   comes off on `player.firstWoven` + the timeout, never on `'ready'` / `loadeddata`. On an SDK
   without `player.firstWoven`, wait for the first frame and then ~1200 ms more.

   Add `"playcanvas": "https://cdn.jsdelivr.net/npm/playcanvas@2.24.0/build/playcanvas.mjs"` and
   `"@displayxr/inline3d/model": "https://cdn.jsdelivr.net/npm/@displayxr/inline3d@1.52.3/js/inline3d-model-entry.js"`
   (or `.../js/inline3d-splat-pc-entry.js` for `/splat/playcanvas`) to the import map, or
   `"playcanvas": "2.24.0"` to `package.json`. Images and video use `wall.addImage(canvas, 'pic_2x1.jpg')`
   / `wall.addVideo(canvas, videoEl)` in the 3D branch and an `<img>` of the left half (or a mono
   video) in the 2D branch. Check each export against the installed `.d.ts` before using it.
4. Run it: esm → serve the directory (`npx serve` / `python3 -m http.server`), or let the checker
   serve it; vite → `npm install && npm run dev`.
5. **Run the checker before saying done**, and fix every FAIL:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/checker/bin/inline3d-check.mjs" <target-dir>        # esm
   node "${CLAUDE_PLUGIN_ROOT}/checker/bin/inline3d-check.mjs" http://localhost:5173/   # vite dev server
   ```

The untouched template passes every check (verdict PASS). If your change makes a check fail, the
failing line names the rule and the doc in `node_modules/@displayxr/inline3d/docs/`.
