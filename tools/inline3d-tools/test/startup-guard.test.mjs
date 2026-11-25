// The `startup-guard` check's static scan: a page script that opens the inline-3D session with no
// catch anywhere is flagged (WARN), so a rejection cannot leave a blank or covered canvas unseen.
// Pure function, no Chrome.
//   node --test tools/inline3d-tools/test/startup-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unguardedCreateCall } from '../lib/check/run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('a bare await createInline3D() with no catch is flagged', () => {
  assert.equal(unguardedCreateCall("import { createInline3D } from '@displayxr/inline3d';\nconst wall = await createInline3D();\nif (!wall.supported) draw2D();"), true);
  assert.equal(unguardedCreateCall('const wall = await sharedInline3D();'), true);
  assert.equal(unguardedCreateCall('await startInline3D(canvas, onFrame);'), true);
});

test('a .catch on the call, a try/catch, or a caught startup counts as guarded', () => {
  assert.equal(unguardedCreateCall("const wall = await createInline3D().catch((err) => { console.warn(err); return null; });"), false);
  assert.equal(unguardedCreateCall('try { wall = await createInline3D(); } catch (e) { draw2D(); }'), false);
  assert.equal(unguardedCreateCall('try { wall = await createInline3D(); } catch { draw2D(); }'), false);
  assert.equal(unguardedCreateCall("async function start() { await createInline3D(); }\nconst u = 'https://example.com/x'; start().catch(show2D);"), false);
});

test('comments neither count as a call nor as a catch', () => {
  assert.equal(unguardedCreateCall('// one createInline3D() per document\nconst x = 1;'), false, 'no real call');
  assert.equal(unguardedCreateCall('/* use createInline3D().catch(...) */\nconst wall = await createInline3D();'), true, 'catch only in a comment');
  assert.equal(unguardedCreateCall('const wall = await createInline3D(); // TODO .catch(...)'), true);
});

test('an import alone is not a call', () => {
  assert.equal(unguardedCreateCall("import { createInline3D } from '@displayxr/inline3d';"), false);
});

test('the scaffold template is guarded', () => {
  assert.equal(unguardedCreateCall(readFileSync(join(HERE, '..', 'templates', 'app.js'), 'utf8')), false);
});
