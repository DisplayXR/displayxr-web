// A tiny app on `/call/full`: the documented bundler path for 2D→3D (RFC 0003 §1). The bundler
// must see lift's STATIC import and ship it (or, on a checkout where ./lift is still the
// placeholder, build cleanly with `liftBundled === false`).
import { mountCall, liftBundled, DxrCallElement } from '@displayxr/inline3d/call/full';

export { liftBundled, DxrCallElement };
export function start(el, opts) {
  return mountCall(el, opts);
}
