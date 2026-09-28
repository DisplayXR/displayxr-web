// DisplayXR auto-3D — the "3D" chip and its menu. PROTOTYPE, not a product.
//
// `function dxrChip(ctl, S)`, a part of the core bundle (build.mjs). STUB: the chip itself is a
// later slice. It will use only `ctl` (status / setEnabled / setRig / setDepth / nudgeFocus / reset
// / onChange) and the built-ins the sentinel snapshotted (`S.intrinsics`). The core calls
//   update(status)   on every notify(), with ctl.status()
function dxrChip(ctl, S) {
  return {
    update(status) {},
  };
}
