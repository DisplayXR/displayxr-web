# Motion, transitions and per-eye effects

Companion to [`authoring-inline-3d.md`](authoring-inline-3d.md). That page covers the API —
what a window is, how to make one, what may sit on top of one. This page covers the part
that trips up every carousel, lightbox, slideshow and hover effect:

> **You cannot move a woven window. You move what is inside it.**

Read the parent page first. Everything here assumes you already have a working
`addImage` / `addVideo` window.

---

## 1. Why a woven tile must not move

A woven window is a compositor quad. The browser weaves the display's lenticular pattern
into it at the quad's **screen position**, so the interleave is phase-locked to physical
pixels. Change the geometry of that quad per frame and you are asking the compositor to
re-derive the weave every frame against a moving target: the stereo smears.

So all of these are wrong for a live window:

```js
// ✗ every one of these animates the QUAD
tile.style.transform = `translateX(${x}px)`;
tile.animate([{ transform: "translateX(0)" }, { transform: "translateX(-100%)" }], 300);
tile.style.transition = "transform .3s";
tile.style.width = `${w}px`;          // per frame
```

Two kinds of motion **are** fine, because they are not per-frame geometry animation of the
quad:

- **Scrolling.** A window inside `overflow: auto`, or the page itself, scrolls normally. The
  browser clips the weave to the ancestor clip and keeps it woven at any partial visibility.
  This is a first-class supported case — see `samples/composition` cases 07, 08 and 09.
  *Floor: DisplayXR Browser 0.1.20.*
- **A static ancestor transform.** A virtualized list that positions rows with
  `transform: translateY(...)` and leaves them there is fine. It is animation, not
  displacement, that hurts.

### What to do instead

Redraw the **source canvas**. The SDK repaints an `addImage` / `addVideo` window from its
source every frame, so changing what is *in* that source is the supported way to change what
gets woven — no new layers, no re-registration, no geometry change:

```js
const inter = document.createElement("canvas");   // the source you own
const handle = wall.addImage(canvas, inter);      // registered ONCE

function paint(t) {                               // called from your own rAF
  const ctx = inter.getContext("2d");
  // ...draw whatever this frame should show...
}
```

Register the window **once** and never re-register it on a content change. Tearing a window
down and adding it back to show a different picture costs a rect churn and a re-activation,
and it is exactly what a "it snaps into 3D a moment later" bug looks like.

---

## 2. The per-eye rule

This is the one that produces bugs you cannot see on a 2D monitor.

The source buffer is **side-by-side**: the left half is the left eye, the right half is the
right eye. Any effect you composite into it must be applied to **both halves at the same
fractional position**. Treat the buffer as one image and you will show one eye something the
other never sees — that is binocular rivalry, not depth, and it reads as a headache.

```js
const eyeW = buf.width / 2;

// ✗ WRONG — sweeps across the left eye first, then the right
ctx.drawImage(next, 0, 0, cut, h, 0, 0, cut, h);

// ✓ RIGHT — the same fraction of each eye
for (const eye of [0, 1]) {
  const ox = eye * eyeW;
  ctx.drawImage(next, ox, 0, cut, h, ox, 0, cut, h);
}
```

**How to check it without a 3D display.** Find the strongest vertical discontinuity inside
each half and compare their *fractional* positions. They must be equal:

```js
// seam(x0, x1) → { frac } : column of max |Δ| within [x0, x1)
const L = seam(0, eyeW), R = seam(eyeW, buf.width);
console.assert(Math.abs(L.frac - R.frac) < 0.002, "per-eye misalignment");
```

A real measurement from a shipping carousel mid-transition: `0.5495` and `0.5500`,
delta `0.0005`. That number is the whole test.

The same rule governs anything else you draw in: letterbox bars (centre them inside **each**
eye, or the bars land between the eyes and read as a black column down the middle),
vignettes, captions burned into the buffer, colour grades.

---

## 3. Recipes

### Slide between two pictures

A filmstrip pulled past a fixed window. Nothing in the DOM moves.

```js
/** Draw one eye of `src` at destination offset `dx`, clipped to that eye. */
function drawEye(ctx, src, eye, eyeW, h, dx) {
  const x0 = Math.max(0, dx);
  const x1 = Math.min(eyeW, dx + eyeW);
  if (x1 <= x0) return;
  const sx = x0 - dx;
  ctx.drawImage(src, eye * eyeW + sx, 0, x1 - x0, h,
                     eye * eyeW + x0, 0, x1 - x0, h);
}

// t: 0→1, dir: +1 advancing (incoming enters from the RIGHT), -1 going back
function slide(ctx, out, inc, eyeW, h, t, dir) {
  const shift = Math.round(t * eyeW);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, eyeW * 2, h);
  for (const eye of [0, 1]) {
    drawEye(ctx, out, eye, eyeW, h, -dir * shift);
    drawEye(ctx, inc, eye, eyeW, h, dir * (eyeW - shift));
  }
}
```

Clipping **per eye** is what stops the outgoing picture bleeding across the seam into the
other view.

### Crossfade

For automatic transitions (a slideshow), where there is no finger to follow:

```js
ctx.globalAlpha = 1; ctx.drawImage(outgoing, 0, 0);
ctx.globalAlpha = t; ctx.drawImage(incoming, 0, 0);
ctx.globalAlpha = 1;
```

A whole-buffer alpha is automatically per-eye-consistent, so this one needs no special care.

### A full-tile effect — swap the source, never overlay

Partial 2D over a tile is fine (badges, captions, dots — see the parent page). A **full-tile**
overlay is not: on a legacy browser it matches the canvas's own quad and the tile falls out of
the weave. So a "show the depth map instead of the photo" effect is a *source swap*:

```js
// pre-build a full-SBS canvas holding the alternate content, then
src = mix < 0.001 ? photo
    : mix > 0.999 ? alternate
    : blend(photo, alternate, mix);   // into a scratch canvas
drawIntoSourceBuffer(src);
```

Ramp `mix` on your own rAF and repaint each frame; the window is never touched.

### Gesture-driven transitions

Drive the transition from a **number**, not a scroll position, and keep the settled index
separate from the in-flight one:

```js
{ index,            // the settled picture; only changes when a transition COMMITS
  to: { idx, dir }, // the incoming one, while in flight
  progress }        // 0…1
```

Keeping them separate is what lets a wrap (last → first) animate *forwards* instead of
rewinding, and lets an outside driver (autoplay, a deep link) step the component without
fighting it.

Two things to get right on the gesture itself:

- Claim it only once horizontal travel beats vertical, and keep `touch-action: pan-y` on the
  element, so a vertical flick still scrolls the page.
- If the element is also a link, swallow the click the gesture produces — and **clear that
  suppression flag on a zero-delay timer**. Left standing it eats the *next* click too, which
  shows up as "the first button press after a swipe does nothing".

---

## 4. Reconvergence and de-occlusion

Moving the zero-parallax plane means shifting the eyes relative to each other. That exposes a
strip of missing pixels on the inner edge of each eye. Do **not** invent those pixels — a
mirror fill reads exactly like what it is, a mirrored replica running down the edge of the
frame, and users report it as a glitch.

Hide the strip with the **minimum uniform zoom** instead. With windows `[aL, aL+w)` and
`[aR, aR+w)` scaled to the output width, output disparity is

```
D = (d − (aL − aR)) · k        k = eyeW / w
```

Convergence depends only on `aL − aR`, so pin that to the shift you want: the zero crossing
lands exactly where asked, and `k` scales the whole depth range with the picture — which is
what a zoom is. Both windows must fit inside their own half, which bounds `w ≤ eyeW − |Δ|`:

```
k = 1 / (1 − |frac|)     ≈ 1.03 at a typical 3% convergence
```

Crop the vertical window by the same factor, or it is a horizontal stretch rather than a zoom.

---

## 5. Budget

- One `createInline3D()` **per document**. The element-rect channel is a whole-widget setter;
  two live managers overwrite each other every frame.
- Prefer **one window per card** over one per item. A carousel that gives every slide its own
  window multiplies live windows by pictures-per-post; compositing the transition into a
  single window keeps it at one.
- The runtime batches every visible window into one weave call per frame, so N windows cost
  roughly the same as one. The real per-frame cost is that **every live image and video window
  repaints its source canvas every frame** — that is what you are actually budgeting.
- `wall.liveCount` tells you how many windows currently hold a weave layer. Print it while
  developing; 15–25 visible is routine.

---

## 6. Verifying without a 3D display

You will not have a DisplayXR display on CI, and probably not on your laptop. Most of what
breaks is compositing logic, and that is testable.

**Stub the manager.** `createInline3D()` only returns a live session on a DisplayXR Browser,
so the entire path is unreachable elsewhere. Replace it with one that blits your source
canvas to the tracked canvas, and the rest of the component is exercised for real — same
gesture, same per-eye compositing, same buffers:

```js
function stubWall() {
  const live = [];
  setInterval(() => {                      // a TIMER, not requestAnimationFrame
    for (const w of live) {
      if (!w.src.width) continue;
      w.canvas.width = w.src.width;
      w.canvas.height = w.src.height;
      w.canvas.getContext("2d").drawImage(w.src, 0, 0);
    }
  }, 16);
  return {
    supported: true,
    addImage(canvas, src) {
      const e = { canvas, src };
      live.push(e);
      return { remove: () => live.splice(live.indexOf(e), 1) };
    },
    close() { live.length = 0; },
  };
}
```

**Use a timer, not `requestAnimationFrame`, in the stub.** A backgrounded tab delivers *zero*
rAF frames, so an rAF-driven harness silently paints nothing and looks broken when the code is
fine. The same trap bites automated testing generally: in a hidden tab, rAF is paused, smooth
scrolling never advances, and `scroll` events never fire. If a headless check of an animation
returns "nothing happened", verify the tab is visible before believing it.

**Then assert on pixels, not on screenshots.** Read the composed buffer back and measure:
seam alignment between the eyes (§2), the displacement of a slide (cross-correlate a row
against the same row at rest — it should equal `t × eyeW`), whether a canvas is blank
(mean 0 = never painted, which is a different bug from a stale frame).

**What the stub cannot tell you:** whether the weave itself stays clean. Interleave quality,
phase, and anything about a moving quad are display-only. Keep those on a hardware checklist
and be explicit about which claims are measured and which are untested.

---

## 7. Checklist

- [ ] The window is registered once and never re-registered on a content change.
- [ ] Nothing animates the tile's geometry — no `transform`, no per-frame size change.
- [ ] Every content-space effect is applied per eye at the same fractional position.
- [ ] Letterbox bars are centred inside each eye, not around the packed pair.
- [ ] Full-tile effects are source swaps; only partial regions are DOM overlays.
- [ ] One `createInline3D()` per document.
- [ ] A gesture on a link clears its click-suppression flag.
- [ ] `touch-action: pan-y` so vertical scrolling still works.
- [ ] The page still works with `{ supported: false }`.
