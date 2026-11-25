// The public-API snapshot gate (RFC 0003 §7, C2): the surface of every pinned .d.ts (call,
// call/full, camera) must equal its checked-in snapshot in test/api-snapshot/. A change to a
// public export, option key, handle member or event payload fails here until the snapshot is
// updated IN THE SAME CHANGE (`node tools/api-surface.mjs --update`) — so the snapshot diff is
// the review of the API change, and nothing moves on a preview-tier entry unnoticed.
//
// Also pins the extractor itself on a small synthetic .d.ts, so a regression in the reader cannot
// silently shrink what the gate watches.

import test from 'node:test';
import assert from 'node:assert/strict';

import { checkAll, diffLines, extractSurface, exportedNames, PINNED } from '../tools/api-surface.mjs';

test('api-surface: the extractor reads kinds, members, optionality, deprecation and re-exports', () => {
  const src = `
/** doc */
export type Fmt = 'a' | 'b';
/** @deprecated gone in 2.0 */
export const OLD: number;
export function f(a: string, b?: { x: number; y: (z: 1) => void }): Promise<void>;
export interface I extends Base {
  /** @deprecated */
  old?: string;
  readonly r: number;
  m(a: Fmt): void;
}
export class C extends HTMLElement {
  static s: number | null;
  go(): void;
}
export { x, y } from './z.js';
export * from './w.js';
declare global {
  interface Foo { bar: 1 }
}
`;
  const lines = extractSurface(src);
  assert.deepEqual(lines, [
    'class C extends HTMLElement',
    '  C.go: go():void',
    '  C.static s: static s:number|null',
    'const OLD [deprecated]: number',
    'function f: (a:string,b?:{x:number;y:(z:1)=>void}):Promise<void>',
    'global interface Foo{bar:1}',
    'interface I extends Base',
    '  I.m: m(a:Fmt):void',
    '  I.old? [deprecated]: old?:string',
    '  I.readonly r: readonly r:number',
    "reexport {x,y} from './z.js'",
    "reexport export * from './w.js'",
    "type Fmt: 'a'|'b'",
  ]);
  const names = exportedNames('call.d.ts');
  assert.ok(names.some((n) => n.name === 'mountCall' && n.kind === 'function' && !n.deprecated));
  assert.ok(names.some((n) => n.name === 'newRoomId' && n.deprecated), 'the 1.30 deprecation set is part of the record');
  assert.ok(names.some((n) => n.name === 'CallOptions' && n.type));
});

test('api-surface: formatting and comments are not part of the surface', () => {
  const a = extractSurface('export function f(a: string): void;\n/** hi */\nexport interface I { a: 1; b?: 2 }');
  const b = extractSurface('// c\nexport function f(\n  a: string,\n): void;\nexport interface I {\n  /** b */\n  b?: 2;\n  a: 1;\n}');
  assert.deepEqual(a, b);
});

for (const p of PINNED) {
  test(`api snapshot: ${p.dts} matches ${p.snap}`, () => {
    const r = checkAll().find((x) => x.dts === p.dts);
    assert.ok(r.expected !== null, `${p.snap} is missing — run: node tools/api-surface.mjs --update`);
    assert.ok(
      !r.stale,
      `the public surface of ${p.dts} changed:\n${diffLines(r.expected, r.current).join('\n')}\n\nIf intended, update the snapshot in this same change: node tools/api-surface.mjs --update`
    );
  });
}

test('api snapshot: the C2 surface is the RFC 0003 §2 one (spot checks against the snapshot, not the .d.ts)', () => {
  const call = checkAll().find((x) => x.dts === 'call.d.ts').expected || '';
  for (const must of ['function mountCall:', 'function addCall:', 'function dxrSignaling:', 'const DXR_SIGNAL_DEFAULT:', 'function parseInviteLink:', 'class DxrCallElement', 'CallOptions.theme?:', 'CallOptions.invite?:', 'CallOptions.landing?:', 'CallHandle.setCameraOff:', 'CallHandle.readonly localFormat:', 'CallHandle.diagnostics:', 'CallHandle.tile:', 'CallEvents.display:', 'CallPeer.readonly display:']) {
    assert.ok(call.includes(must), `missing from the pinned surface: ${must}`);
  }
  for (const gone of ['CallHandle.wall', 'CallHandle.format:', 'CallHandle.sendHint', 'CallHandle.cameraOff(', 'CallEvents.format:', 'CallEvents.session:', 'CallOptions.accent?', 'CallOptions.maxLifted?', 'CallOptions.inviteBase?', 'CallOptions.browserUrl?', 'CallOptions.recoverSession?', 'CallOptions.log?', 'function peerjsCloud']) {
    assert.ok(!call.includes(gone), `should have left the public surface: ${gone}`);
  }
  // Every 1.29 helper that stays for one release is marked, so 1.31's removal is a visible diff.
  const deprecated = call.split('\n').filter((l) => /^(function|const|class) \w+ \[deprecated\]/.test(l)).length;
  assert.equal(deprecated, 38);
  const camera = checkAll().find((x) => x.dts === 'camera.d.ts').expected || '';
  for (const must of ['function openCamera:', 'function addCameraView:', 'StereoCamera.capturePhoto:', 'StereoCamera.record:', 'StereoCamera.on:', 'CameraPhoto.suggestedName:', 'CameraClip.mono?:']) assert.ok(camera.includes(must), `missing from /camera: ${must}`);
});
