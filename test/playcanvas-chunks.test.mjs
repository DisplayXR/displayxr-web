// Every PlayCanvas shader-chunk rewrite the SDK makes, run against the REAL chunks of each engine
// version in the peer range (`playcanvas >=2.22.3 <3`). The copies in test/playcanvas-chunks/
// come from the npm builds (tools/playcanvas-chunks.mjs); the SDK must serve all of them at once,
// feature-detecting the chunk shape, never switching on a version number.
//
// Status per version (a patch "no-ops" only where the engine fixed the thing natively):
//   footprint (gsplatCornerVS)     2.22.3 rewritten · 2.23.3 / 2.24.0 native (per-axis focal upstream)
//   quad extent (gsplatCommonVS)   rewritten on all three
//   stereo grab UV (refraction)    rewritten on all three; uScreenSize (2.22) vs screen_size (2.23+)
//   effect hooks (gsplatModify*)   the engine's default signatures = the ones the SDK generates
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { patchGsplatFootprint, installGsplatFootprint } from '../js/inline3d-splat-playcanvas.js';
import { patchPlayCanvasQuadExtent } from '../js/inline3d-splat-perf.js';
import { stereoRefractionSource } from '../js/inline3d-pc-look.js';
import { composeModifier, EFFECTS } from '../js/inline3d-splat-effects.js';

const VERSIONS = ['2.22.3', '2.23.3', '2.24.0'];
const chunk = (v, name) => readFileSync(new URL(`./playcanvas-chunks/${v}/${name}.glsl`, import.meta.url), 'utf8');
const FIXED_UPSTREAM = new Set(['2.23.3', '2.24.0']); // gsplatCornerVS takes the focal length per axis

for (const v of VERSIONS) {
  test(`playcanvas@${v}: footprint — rewritten where the engine has the bug, native where it does not`, () => {
    const src = chunk(v, 'gsplatCornerVS');
    const r = patchGsplatFootprint(src);
    assert.equal(r.ok, true, 'one of the two known shapes');
    if (FIXED_UPSTREAM.has(v)) {
      assert.equal(r.native, true);
      assert.equal(r.src, src, 'untouched');
    } else {
      assert.ok(!r.native);
      assert.match(r.src, /dxrFocalY/);
      assert.match(r.src, /0\.0, J1y, J2\.y,/);
    }
  });

  test(`playcanvas@${v}: installGsplatFootprint writes only when it rewrote, and never warns on a known shape`, (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const src = chunk(v, 'gsplatCornerVS');
    const store = new Map([['gsplatCornerVS', src]]);
    const r = installGsplatFootprint(store);
    assert.equal(r.ok, true);
    assert.equal(warn.mock.callCount(), 0, 'no "half height" warning on an engine that draws correctly');
    if (FIXED_UPSTREAM.has(v)) assert.equal(store.get('gsplatCornerVS'), src, 'the native chunk is not replaced');
    else assert.match(store.get('gsplatCornerVS'), /dxrFocalY/);
  });

  test(`playcanvas@${v}: quad-extent cap finds clipCorner's anchor`, () => {
    const src = chunk(v, 'gsplatCommonVS');
    const r = patchPlayCanvasQuadExtent(src, 0.75);
    assert.equal(r.ok, true);
    assert.match(r.src, /float clip = min\(0\.7500000 \/\* dxrQuadExtent \*\/,/);
    assert.match(r.src, /corner\.offset \*= clip;/);
    assert.match(r.src, /corner\.uv \*= clip;/, 'offset and uv still ride the same factor');
  });

  test(`playcanvas@${v}: stereo grab UV names the screen-size uniform this engine declares`, () => {
    const src = chunk(v, 'refractionDynamicPS');
    const out = stereoRefractionSource(src);
    assert.ok(out, 'shape recognised');
    assert.match(out, /uv = inline3dGrabUV\(projectionPoint\)/);
    const engineName = /\bscreen_size\b/.test(src) ? 'screen_size' : 'uScreenSize';
    const other = engineName === 'screen_size' ? 'uScreenSize' : 'screen_size';
    assert.match(out, new RegExp(`\\* ${engineName}\\.zw;`));
    assert.ok(!new RegExp(`\\b${other}\\b`).test(out), `${other} is not declared on this engine: naming it would not compile`);
  });

  test(`playcanvas@${v}: the splat-effect chunks the SDK replaces have the signatures it generates`, () => {
    const sig = (s) => s.replace(/\s+/g, ' ').trim();
    const vs = sig(chunk(v, 'gsplatModifyVS'));
    const { code } = composeModifier([{ name: 'fade', def: EFFECTS.fade, opts: {} }]);
    for (const decl of [
      'void modifySplatCenter(inout vec3 center)',
      'void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale)',
      'void modifySplatColor(vec3 center, inout vec4 color)',
    ]) {
      assert.ok(vs.includes(decl), `engine declares ${decl}`);
      assert.ok(sig(code).includes(decl), `SDK generates ${decl}`);
    }
    assert.ok(sig(chunk(v, 'gsplatModifyPS')).includes('void modifySplatColor(vec2 gaussianUV, inout vec4 color)'), 'fragment hook (fragmentGlsl)');
  });
}

test('stereoRefractionSource declines an unknown shape (no screen-size uniform it knows)', () => {
  const src = chunk('2.24.0', 'refractionDynamicPS').replace(/screen_size/g, 'someOtherSize');
  assert.equal(stereoRefractionSource(src), null);
  assert.equal(stereoRefractionSource(undefined), null);
});
