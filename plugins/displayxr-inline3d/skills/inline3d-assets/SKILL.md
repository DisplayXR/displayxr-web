---
name: inline3d-assets
description: Find, convert, optimise, check and (optionally) generate the 3D assets an inline-3D page shows — glTF/GLB models, textures, posters — so they load fast on a tablet and look right on a glasses-free 3D display. Use when a @displayxr/inline3d page needs a model it does not have yet, when an asset is FBX/OBJ/STL/.blend/huge/uncompressed/in centimetres, when the user mentions Blender, glTF-Transform, Meshy, Tripo or AI-generated 3D, or before shipping any model. Records where every asset came from in ASSETS.md.
---

# Assets for inline-3D pages

Both eyes draw every triangle and sample every texture, the weakest device is a tablet with a
4096 px texture limit, and depth errors that a 2D page hides (sorting, z-fighting, a model that is
centimetres instead of metres) show in stereo. So every asset goes through the same three steps:
**get it → prepare it → check it**, and every asset gets a line in `ASSETS.md`.

Tools, in the order to reach for them:

| Tool | When | Install |
|---|---|---|
| `asset-check.mjs` (bundled) | always, last | none (Node only) |
| glTF-Transform CLI | glTF/GLB in, glTF/GLB out: inspect, resize, compress, simplify, centre | `npx -y @gltf-transform/cli@4.3.0` (pinned; nothing installed globally) |
| Blender (headless) | any other format (FBX, OBJ, STL, PLY, DAE, .blend), units/axis fixes, heavy decimation | **only if already installed**; never install it |
| `gen.mjs` (bundled) | no asset exists and the user wants one generated | needs the user's own API key in the environment; every call is paid and needs the user's yes |

## 1. Get it

In order of preference:

1. **The user's own asset** (in the project, or a path they gave). Record it:
   `node "${CLAUDE_PLUGIN_ROOT}/assets/bin/gen.mjs" provenance --file assets/x.glb --source "supplied by the user" --license "user's"`.
2. **A library asset with a clear licence** (CC0 / CC-BY, e.g. the Khronos glTF sample models,
   Poly Haven). Record the URL, author and licence; CC-BY needs visible credit on the page.
3. **A placeholder you build** (primitives in three.js/PlayCanvas) when nothing fits and the user
   did not ask for generation. Say so in your notes.
4. **Generation**, only when the user asked for it or agreed. See §4.

Never take a model from a site whose licence you cannot state.

## 2. Prepare it

**glTF/GLB (glTF-Transform).** Look first, then fix only what the check flags:

```sh
GT="npx -y @gltf-transform/cli@4.3.0"
$GT inspect in.glb                                   # triangles, textures, extensions, size
$GT optimize in.glb out.glb --compress false --texture-compress webp --texture-size 2048
```

That default (WebP textures resized to 2048, deduplicated, pruned, no geometry compression) needs
**no decoder** on the page. Only for big meshes add `--compress meshopt` and then the
`meshoptimizer` package (an import-map entry or `package.json` pin): nothing to serve. Avoid
`--compress draco` and KTX2 unless the page already serves `/draco/` and `/basis/` (the SDK never
fetches decoders from a CDN). Other fixes: `$GT simplify in.glb out.glb --ratio 0.5 --error 0.001`
(too many triangles), `$GT center in.glb out.glb --pivot center` (the origin is far from the model),
`$GT copy in.gltf out.glb` (a multi-file .gltf → one file you cannot half-deploy).

**Anything else (Blender, if present).** Detect it, don't install it:

```sh
B=$(command -v blender || ls /Applications/Blender.app/Contents/MacOS/Blender 2>/dev/null)
"$B" -b --factory-startup -P "${CLAUDE_PLUGIN_ROOT}/assets/blender/prep.py" -- in.fbx out.glb [--metres 0.01] [--decimate 0.5]
```

`prep.py` imports, applies transforms, scales to metres (`--metres` = metres per source unit:
0.01 for centimetres), decimates, recentres the bounds on the origin and exports one GLB. Then run
the glTF-Transform `optimize` line on its output (Blender writes PNG textures; WebP is far smaller).
No Blender: say the format cannot be converted here, and ask for a GLB.

Units: `addModel` frames the model on the glass from its bounds, so units and offset do not break
it; a model you place in your own `addScene` must be in **metres, centred** (its real size: a
helmet is ~0.3 m, not 2 m).

## 3. Check it (before the page uses it)

```sh
node "${CLAUDE_PLUGIN_ROOT}/assets/bin/asset-check.mjs" out.glb            # tablet budget (default)
node "${CLAUDE_PLUGIN_ROOT}/assets/bin/asset-check.mjs" out.glb --target desktop
```

It reports: missing external files, decoders the page must provide, triangles (both eyes draw
them; tablet budget 300k), draw calls, size/units/pivot, texture sizes and decoded GPU memory
(over 4096 px fails on a tablet), alpha-BLEND materials (sorting errors read as depth errors in
stereo; use MASK for cut-outs), metallic/glass materials (they need an environment map: keep
`addModel`'s default image-based environment (`'room'` / `'neutral'`) or pass `envMap`; never
`environment: 'studio'`, a punctual rig under which metal renders dark), file size, and
animations. Fix every FAIL; act on WARNs or say why not. Then run the page checker (`inline3d`
skill §7): the asset check is about the file, the page check about how it is shown.

## 4. Generate it (optional, paid, the user's keys)

```sh
node "${CLAUDE_PLUGIN_ROOT}/assets/bin/gen.mjs" providers     # which adapters have a key (names only)
```

Adapters: `meshy` and `tripo` (text-to-3d, image-to-3d → GLB), `openai` (image → PNG, for
textures, posters and backdrops). Each reads its key from the environment (`MESHY_API_KEY`,
`TRIPO_API_KEY`, `OPENAI_API_KEY`) and from nowhere else.

**Rules, no exceptions:**
- **Never ask for, print, echo, log, write or commit a key.** Never put one in a file, an env file
  you create, a command line, or `ASSETS.md`. If no key is set, the adapter is unavailable: say so
  and use §1 instead. Do not suggest pasting a key into the chat.
- **Ask before every paid call.** Tell the user the adapter, what you will generate (the prompt or
  image), and the cost estimate `gen.mjs` prints; only after they say yes run it with
  `--confirm-paid`. Without that flag `gen.mjs` refuses and prints the estimate. One yes covers
  one call, not a batch, unless the user said otherwise.
- **Every generated file goes through §2 and §3** (generated models are often huge, off-centre,
  with 4K textures), and `gen.mjs` has already written its `ASSETS.md` line (adapter, prompt,
  date, the provider's licence note). Check the provider's licence terms before calling the asset
  shippable.

```sh
node "${CLAUDE_PLUGIN_ROOT}/assets/bin/gen.mjs" run meshy --kind text-to-3d --prompt "a brass desk lamp, PBR" --out assets/lamp-raw.glb --confirm-paid
```

## 5. ASSETS.md

One table, at the project root, one row per file the page loads that you did not write: file,
source (URL, "supplied by the user", or `generated: <adapter> <kind>`), licence, date, notes
(prompt, author, changes made: "optimised: webp 2048, decimated 50%"). Create it with the
`provenance` command; keep it in the deliverable. A CC-BY asset also needs a visible credit on the
page.
