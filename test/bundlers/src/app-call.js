// A tiny app on the plain `/call` entry. A bundler cannot follow the computed lift import behind
// `mono3D: 'auto'`, so a 2D participant on a 3D display must raise `warning
// { code: 'lift-not-bundled' }` — never a silent flat tile (RFC 0003 §1).
import { addCall, DxrCallElement } from '@displayxr/inline3d/call';

export { DxrCallElement };
export function start(wall, el, opts) {
  return addCall(wall, el, opts);
}
