// Post-processing on the three.js adapter: the scene drawn into a render target, then full-screen
// passes, then the screen. Asserted through the same 'convert' checks as case 'a': the halves must
// differ by the fake eyes' shift, which fails if the right eye samples the left eye's chain.
export default function cases({ P, NEW }) {
  return [
    { id: 'e-postfx', name: 'three.js post chain (scene target + two-pass blur on ONE material + composite + HUD)', url: P + 'three-postfx.html', shim: NEW, cfg: { convTarget: false }, expect: 'convert', fovDeg: 40, ready: 'window.__frozen' },
  ];
}
