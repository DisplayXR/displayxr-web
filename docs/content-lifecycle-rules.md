# Content lifecycle rules: release what a swap replaces

Companion to [`authoring-inline-3d.md`](authoring-inline-3d.md) and
[`woven-canvas-rules.md`](woven-canvas-rules.md). Those pages keep a woven canvas alive and
joined. This one covers what happens to the GPU over the life of that canvas, when the page swaps
content in and out of it: a product carousel, a catalogue, a gallery that loads glTF after glTF.

The symptom is slow and silent. Nothing on the page looks wrong. The browser's **GPU process**
grows by a few megabytes a minute for as long as the page is open, until the machine runs short
of memory. The rules below come from a production page that grew about **8 MB/min** this way on a
Linux laptop. They were then checked against the PlayCanvas 2.22.3 and three.js 0.180 sources, and
measured against this SDK's own swap paths (§5).

---

## 1. What leaks, and why it costs so much

Every distinct material set a page draws makes the engine **link a WebGL program**: one per
material variant (lighting, skinning, maps, pass). A linked program is not just a handle. The
driver keeps its compiled form for as long as the program exists. On one Linux driver (Mesa, integrated
graphics) that was **about 5 MB per live program**, measured with an allocation tracer on the
browser's GPU process: the outstanding allocations were the linked program's IR, freed only by
`glDeleteProgram`. The production page linked about four new programs per product and deleted
none, so each product it showed left 15–25 MB behind for the life of the page.

What the page saw as "swapping a product" was, to the GPU, *adding* one. The page destroyed the
entity and its materials, and the engine kept every program those materials had linked.

## 2. Engine facts

### PlayCanvas (2.22.3)

- **`ProgramLibrary` caches every program for the device's life.** Its cache is keyed by the
  variant's options. An entry leaves only when that `Shader` is destroyed (`Shader.destroy()`),
  or when the device is.
- **`Material.destroy()` destroys no program.** It empties `material.variants` and clears each
  mesh instance's per-pass cache (its bind groups and uniform buffers), and that is all. Once it
  has run, the material no longer even says which programs it had.
- **`Asset.unload()` on a glTF container** destroys the container's textures, meshes and
  materials (each material through `Material.destroy()`, so no program again). **The registry
  shares one container per URL** between every caller that loads it.
- **One `Shader` per key, shared.** Two materials with the same options get the same `Shader`
  object from the library. Destroying it under one of them breaks the other.
- **The compiled shaders outlive their program.** `WebglShader.destroy()` deletes the program and
  nothing else. The vertex and fragment shaders it was linked from stay in a module-private
  `CompiledShaderCache` (keyed by source) until the device is destroyed. So even a page that
  destroys its programs keeps two compiled shaders per program it ever linked.
- **`app.destroy()` frees everything.** It unloads every asset, clears the program library
  (destroying each program) and destroys the device, which deletes the cached shaders.

### three.js (0.180)

- **Programs are reference-counted per material.** The renderer listens for each material's
  `dispose` event. `material.dispose()` releases that material's programs
  (`WebGLPrograms.releaseProgram`), and the last material out deletes the program
  (`gl.deleteProgram`). Materials that compile to the same program share it.
- **There is no compiled-shader cache to leak.** `WebGLProgram` deletes its two shaders right
  after linking.
- **Nothing is freed by taking an object out of the scene,** or by dropping the last reference to
  it. Call `geometry.dispose()`, `material.dispose()` and `texture.dispose()` for each texture.
  `material.dispose()` does not dispose the textures it uses.
- **`renderer.info.programs.length`** is the live program count: the pass test of §4, for free.

## 3. The rules

### 1. Release everything a swap replaces, not just the entity

A swap replaces five things: the **entity**, its **materials**, the **programs** those materials
linked, their **textures**, and the **container** they came from. Destroying the entity releases
the first. Unloading the container releases the textures, meshes and materials. The programs are
released by nobody unless the page does it.

On a PlayCanvas tile, content you add under `handle.engine.root` is released in one call:

```js
const prev = shown;                                    // { entity, asset } of the outgoing product
const { programs, container } = handle.releaseEntity(prev.entity, { asset: prev.asset });
```

`releaseEntity` (new, on `addSplat(…, { engine: 'playcanvas' })` and PlayCanvas `addModel`
handles) does rules 2 to 4 for you, and the SDK does rule 5 on its own devices. On a three.js scene, traverse and dispose (§2, three.js).

### 2. Collect the programs before you destroy anything

`Material.destroy()` empties `material.variants`, and the container's unload destroys its
materials. Read `variants` of every material the entity's mesh instances use (and each mesh
instance's own shader cache), and of the container's materials, **first**. Then destroy the entity,
then unload the container, then destroy the programs.

### 3. Destroy only a program nothing else still draws with

Because the library hands one `Shader` to every material with the same key, a program you collected
may also belong to content that stays. Before `shader.destroy()`, look at what is still in the app:
every mesh instance under `app.root` (enabled or not), every layer's mesh instances, and every
material asset still in the registry. Destroy only what none of them holds. `Shader.destroy()` is
the engine's own release: it deletes the program and takes it out of the library, so the next ask
for that variant compiles it again rather than returning a dead one.

### 4. Unload a container with its last user

The registry shares one container per URL, so two products loaded from the same file share
textures and materials. Unload it (`app.assets.remove(asset); asset.unload()`) only when nothing
left in the scene draws from it: refcount your holders, or check that no remaining mesh instance
uses one of its meshes or materials (what `releaseEntity` does: it reports `container: 'in-use'`
and leaves it loaded).

### 5. Let the engine give compiled shaders back

Rule 3 deletes the programs. The compiled shaders behind them stay in the engine's
`CompiledShaderCache` (§2), so a page that follows rules 1–4 still keeps two compiled shaders for
every program it ever linked (measured in §5: shaders 10 → 91 over 24 swaps, programs bounded).
The fix counts, per cached shader, the programs that use it, and deletes the shader when the last
one is destroyed. **The SDK applies it to every PlayCanvas device it creates** (see §6). A page that
runs its own PlayCanvas app outside the SDK has to patch the engine itself: the change is about 20
lines in `src/platform/graphics/webgl/webgl-shader.js` (a count in `_compileShaderSource`, a
release in `WebglShader.destroy`, cleared on context loss). `js/inline3d-pc-shader-cache.js` is the
reference.

### 6. On three.js, dispose explicitly, and textures separately

Removing a mesh from the scene frees nothing on the GPU. For each object a swap replaces, call
`geometry.dispose()`, `material.dispose()`, and `dispose()` on every texture the material uses
(`map`, `normalMap`, …). The renderer then deletes a program when its last material is disposed.
Do not dispose a geometry, material or texture that content which stays still uses.

### 7. Fewer variants is cheaper than releasing them

Each distinct option set is a program. A catalogue whose items share one material set (the same
maps, the same lighting) links once and swaps meshes and textures. A catalogue of hand-made
materials links per item. Releasing keeps the second kind bounded, but every swap then compiles
again, which costs a frame or more of main-thread time on first draw: warm the incoming content
before you show it (`handle.warmEntity`, [PlayCanvas adapter § warmEntity](playcanvas-adapter.md#warmentity--a-gltfs-first-draw-without-the-freeze)).

### 8. Removing the tile is not a content swap

`handle.remove()` on a PlayCanvas tile destroys the app, and with it every program, shader,
texture and asset (measured in §5: nothing left). But a new tile is a new canvas for the browser's
compositor to join, with the raw side-by-side window that brings
([woven-canvas rules 2 and 3](woven-canvas-rules.md#2-never-remount-a-woven-canvas-inside-a-screen)).
Keep the tile and swap what is in it, with rules 1–5.

## 4. The pass test: hook, swap, plateau

Count program and shader creation on the context, swap content about ten times, and check that the
live count (`created − deleted`) **plateaus**. A page that leaks climbs with every new item. A page
that releases goes up and down around what is on screen.

```js
// Run before the page creates its WebGL context (inject at document start, e.g. with the
// DevTools protocol's Page.addScriptToEvaluateOnNewDocument, then reload).
const live = (globalThis.__glLive = { programs: 0, shaders: 0 });
for (const Ctx of [WebGLRenderingContext, WebGL2RenderingContext]) {
  const p = Ctx.prototype;
  const count = (name, key, step) => {
    const orig = p[name];
    p[name] = function (...args) {
      const r = orig.apply(this, args);
      if (step > 0 ? r : args[0]) live[key] += step; // a create that returned an object; a delete of one
      return r;
    };
  };
  count('createProgram', 'programs', +1);
  count('deleteProgram', 'programs', -1);
  count('createShader', 'shaders', +1);
  count('deleteShader', 'shaders', -1);
}
// Swap content ten times, reading __glLive after each swap: it must level off.
```

Two things to know when reading it:
- **Content that repeats plateaus anyway.** The engine reuses a cached program for a variant it has
  already linked, so a carousel of eight products stops growing after the eighth even without a
  release. Test with more distinct items than the page will show at once, or with real catalogue
  data.
- **The SDK's own transitions compile once.** The first `setSource` with each transition kind
  links its programs, and later swaps reuse them: a few rises, then flat.

**`?dxrdiag` does this for you on a PlayCanvas tile.** The diagnostics overlay shows
`gl programs N live (+created −deleted)  shaders N live (…)  cache patched`, and the dump
(`copy(__dxrDiag.dump())`) carries the same under `glObjects`. At every content swap the SDK can
see (a `setSource`, a glTF container loaded into the tile's registry, a `releaseEntity`), it samples
the live program count. When the count has not dropped across the last 10 swaps of one kind and
rose at more than 60% of them, it warns once in the console. It costs nothing when diag is off.
`?dxrdiag=keepshaders` turns rule 5 off for an A/B (page-wide; set it on the URL before the first
tile loads). Details: [PlayCanvas adapter § Diagnosing transition stalls](playcanvas-adapter.md#diagnosing-transition-stalls-diag--dxrdiag-36).

## 5. Measured: the SDK's own paths

DisplayXR Browser on Linux (Chromium 156, Mesa, integrated graphics), PlayCanvas 2.22.3, the hook of §4,
Khronos glTF sample models. "Live" is `created − deleted` after each step.

| path | before this release | with this release |
|---|---|---|
| `addModel` → `remove()` → `addModel` on the same canvas, 10–12 times over 4 models | live 0 programs / 0 shaders after every `remove()` (60 created, 60 deleted) | same: nothing leaks |
| glTF swapped under `handle.engine.root`, page destroys the entity and unloads the container (rule 1 without the programs), 24 distinct models | programs 5 → 47, shaders 10 → 91; `deleteProgram` never called | same: the page never destroys a program, so nothing the SDK does can free it. `?dxrdiag` warns at the 10th swap |
| the same swaps with `handle.releaseEntity(entity, { asset })` | n/a | programs between 5 and 16 (the model on screen), shaders exactly twice that; back to 5 / 10 after the last release |
| the same, `?dxrdiag=keepshaders` (rule 5 off) | n/a | programs bounded (5–16), shaders 10 → 91: the engine's compiled-shader cache alone |
| `setSource` × 12–16 on one splat (cut, crossfade, wavefront, flip in turn) | +6 programs over the first pass of the four transitions, then flat | same |
| `setVideo(src)` / `setVideo(null)` × 6 | +1 program on the first, then flat | same |

So the SDK's own swaps (`setSource`, `setVideo`, `prepareSource().dispose()`, `remove()`) release
what they replace, and content a page adds under `handle.engine.root` is the page's, with
`releaseEntity` to do it. On the production page, releasing the outgoing product's programs and
container plus the shader-cache fix took the GPU process from **+9.1 MB/min to flat** over a soak,
with live programs and shaders steady and every product still rendering when it came round again.

## 6. What the SDK does for you, and what the page still owns

| | SDK | page |
|---|---|---|
| `handle.remove()` (PlayCanvas `./splat`, `./model`) | destroys the app: every entity, asset, program, shader and texture on the tile | nothing |
| `handle.remove()` (three.js `./model`) | disposes the model's geometries, materials and textures | anything the page added to the scene |
| `setSource` | the outgoing asset (entity destroyed, asset unloaded a few frames later); its own transition programs are compiled once and reused | nothing |
| `setVideo(null)`, `prepareSource().dispose()` | the plane / the prepared asset | nothing |
| compiled shaders (rule 5) | on every PlayCanvas device the SDK creates | a PlayCanvas app the page creates itself |
| content under `handle.engine.root` | `handle.releaseEntity(entity, { asset })` when the page calls it | calling it (or rules 2–4 by hand) for whatever a swap replaces |
| `addScene` (three.js or raw WebGL) | nothing: the renderer is the page's | rule 6 |

**How the shader-cache fix rides along with the engine.** PlayCanvas is the page's own peer
dependency (an import map, a bundler, a CDN build), never a file this package ships, so the SDK
cannot patch it on disk. `js/inline3d-pc-shader-cache.js` replaces two methods on the engine's
`WebglShader` prototype at run time, once, through the first shader the device creates. It
installs only on the 2.22.x shape (an `_compileShaderSource(device, src, isVertexShader)` reading a
cache keyed by source, and a `destroy` that does not delete shaders), and otherwise steps aside and
reports why in `?dxrdiag` (`cache skipped: …`). On an engine bump: re-read `webgl-shader.js`; if it
still never deletes a compiled shader before device destroy, keep the fix and update its shape
check and `test/pc-shader-cache.test.mjs` (a copy of the 2.22.3 class shape). If upstream releases
shaders itself, the check makes the fix a no-op, and it can be deleted.
