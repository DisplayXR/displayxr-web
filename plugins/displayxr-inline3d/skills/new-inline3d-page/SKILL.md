---
name: new-inline3d-page
description: Scaffold a new 3D web page or app for Spatial Displays on @displayxr/inline3d from a known-good template (vanilla ESM + import map, or Vite), with one persistent canvas, a cover that always comes off, a 2D fallback and exact version pins. Use when starting a new inline-3D page, demo or app from scratch.
argument-hint: "[esm|vite] [target-dir] [model|splat|image|video|player|scene]"
---

# Scaffold an inline-3D page

The templates ship in the exact-pinned `@displayxr/inline3d-tools` npm package; its `scaffold`
command copies them (the first run downloads the package; the user approves the command):

```sh
npx -y @displayxr/inline3d-tools@0.1.4 scaffold esm  <target-dir> --title "<page title>"
npx -y @displayxr/inline3d-tools@0.1.4 scaffold vite <target-dir> --title "<page title>" [--name <npm-name>]
```

It never overwrites an existing file (`--force` replaces). What it writes:

| file | what |
|---|---|
| `app.js` | the page logic (shared by both flavours): a three.js scene on `addScene` with `EyeCamera`, display rig, validate-before-clear with last-good replay, buffer sized 2× the box (dpr ≤ 2, clamped to the GPU), cover removed on `handle.firstWoven` + a 4 s timeout + `catch`, a mono 2D fallback |
| `style.css` | page styles; the canvas and its ancestors carry no CSS effects |
| `index.html` (esm) | no build step: an import map with exact CDN pins |
| `index.html` + `package.json` (vite) | Vite: exact npm pins (`@displayxr/inline3d` 1.57.0, `three` 0.180.0) |

## Steps

1. Pick the flavour: **esm** unless the project already uses npm/a bundler (then **vite**, or merge
   the pins into the existing `package.json` exactly, no `^`).
2. Run `scaffold` with the flavour and the target directory (it fills in the title and, for vite,
   the package name). Don't add an `<img>` or extra canvas: there is ONE persistent canvas.
3. Pick the content (the `inline3d` skill §1 table) and swap the scene block if it is not a custom
   scene. Keep the cover, the fallback and the pins. For a model or a splat, replace everything from
   "renderer + scene" down with the viewer call, which handles the buffer, framing, validation and
   the 2D fallback itself:

   ```js
   import { createInline3D } from '@displayxr/inline3d';
   import { addModel } from '@displayxr/inline3d/model';          // or: import { addSplat } from '@displayxr/inline3d/splat/playcanvas';
   const wall = await createInline3D().catch((err) => {             // a rejection must not blank the page:
     console.warn('inline 3D unavailable, showing 2D', err);          // log it, then the viewer draws 2D
     return null;
   });
   const handle = addModel(wall, canvas, './assets/model.glb');     // addSplat(wall, canvas, './scene.sog', { engine: 'playcanvas' })
   // the page behind the tile shows around the subject: keep it a soft colour (or pass clearColor)
   Promise.race([handle.firstWoven, new Promise((r) => setTimeout(r, 4000))]).finally(dropCover);
   ```

   A player is the same shape: `addPlayer(wall, canvas, ['./clip.webm', './clip.mp4'], { poster })`
   from `/player` (webm first; the canvas sits in a container for the transport), and the cover
   comes off on `player.firstWoven` + the timeout, never on `'ready'` / `loadeddata`. On an SDK
   without `player.firstWoven`, wait for the first frame and then ~1200 ms more.

   Add `"playcanvas": "https://cdn.jsdelivr.net/npm/playcanvas@2.24.0/build/playcanvas.mjs"` and
   `"@displayxr/inline3d/model": "https://cdn.jsdelivr.net/npm/@displayxr/inline3d@1.57.0/js/inline3d-model-entry.js"`
   (or `.../js/inline3d-splat-pc-entry.js` for `/splat/playcanvas`) to the import map, or
   `"playcanvas": "2.24.0"` to `package.json`. Images and video use `wall.addImage(canvas, 'pic_2x1.jpg')`
   / `wall.addVideo(canvas, videoEl)` in the 3D branch and an `<img>` of the left half (or a mono
   video) in the 2D branch. Check each export against the installed `.d.ts` before using it.
   A camera-rig world or game: set its depth by the rule in "Building on @displayxr/inline3d" §2.
4. Run it: esm → serve the directory (`python3 -m http.server`), or let the checker
   serve it; vite → `npm install && npm run dev`.
5. **Run the checker before saying done**, and fix every FAIL:

   ```sh
   npx -y @displayxr/inline3d-tools@0.1.4 check <target-dir>              # esm
   npx -y @displayxr/inline3d-tools@0.1.4 check http://localhost:5173/    # vite dev server
   ```

The untouched template passes every check (verdict PASS). If your change makes a check fail, the
failing line names the rule and the doc in `node_modules/@displayxr/inline3d/docs/`.
