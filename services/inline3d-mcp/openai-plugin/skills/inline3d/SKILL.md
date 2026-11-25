---
name: inline3d
description: Build or fix a web page that shows 3D on Spatial Displays with @displayxr/inline3d (the DisplayXR Browser), and check it before calling it done. Use when the user asks for a 3D web page, a page for a 3D or spatial display, inline 3D, or to check such a page or a glTF/GLB model for one.
---

# Inline-3D pages with DisplayXR

Pages built on `@displayxr/inline3d` show 3D on Spatial Displays in the DisplayXR Browser
and a normal 2D view in every other browser. The DisplayXR inline 3D tools cover the whole loop:

1. **Read the rules first.** `get_authoring_guide` returns the authoring checklist: content type and
   entry point, view rig, depth and comfort, woven-canvas rules, page chrome, exact version pins,
   assets.
2. **Start from the template.** `scaffold_page` returns a known-good page (esm: `index.html`,
   `app.js`, `style.css`, no build step). Keep its structure: one persistent canvas, a cover that
   always comes off, a 2D fallback. Change the scene in `app.js`.
3. **Check before saying done.** `check_files` runs the page's own files in a simulated DisplayXR
   Browser (two real eye views) and in a plain browser, and reports pass, warn or fail per rule.
   For a deployed page use `check_url` with its public URL; localhost and private addresses can't
   be reached. A check that is still starting returns a `job_id`: tell the user it is running and
   collect it with `get_check_result`. Fix every FAIL, check again, and judge every WARN.
4. **Models.** `check_asset_url` checks a public `.glb` or `.gltf` against a device budget before
   the page loads it. Models, images and video the page loads must be at public URLs.

A pass means the page works in a simulated 3D browser; it is not a test on a real Spatial Display. To
see it in 3D, the user opens the page's public URL in the DisplayXR Browser on a Spatial Display. The
page is static files: publish it as a public site if that is available here, or give the user the
files to put on any static host.
