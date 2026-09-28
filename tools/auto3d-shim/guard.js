// DisplayXR auto-3D — frame-rate guard. PROTOTYPE, not a product.
//
// `function dxrGuard(core)`, a part of the core bundle (build.mjs). STUB: the guard itself (2D
// baseline from considerActivation, sampling in the session frame, trip -> core.turnOff) is a later
// slice. The core already calls it where the real one hooks in:
//   onFlip(st)    the layer was just created (flip)
//   tick(st, t)   once per session frame, after the cover tick
function dxrGuard(core) {
  return {
    onFlip(st) {},
    tick(st, t) {},
  };
}
