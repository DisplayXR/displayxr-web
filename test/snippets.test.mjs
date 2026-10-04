// Every sample and every code snippet in docs/call.md + docs/camera.md compiles against the
// PUBLIC types only (RFC 0003 §7, C2 gate) — tools/check-snippets.mjs under `node --test`.
// Needs `typescript`: present locally (devDependency) and in CI's typecheck job, which also runs
// the tool directly; the dependency-free unit job skips this file rather than failing it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { checkSnippets, extractSnippets, deprecatedImports, injectedImports } from '../tools/check-snippets.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let hasTs = true;
try {
  createRequire(join(root, 'package.json')).resolve('typescript/bin/tsc');
} catch {
  hasTs = false;
}

test('check-snippets: fenced blocks, deprecated-import detection, fragment injection (pure parts)', () => {
  const md = "text\n```js\nconst a = 1;\n```\n```html\n<b>\n```\n```ts title\nlet b: number;\n```\n```jsx\n<x/>\n```\n";
  assert.deepEqual(extractSnippets(md).map((s) => [s.lang, s.line]), [['js', 2], ['ts', 8], ['jsx', 11]]);
  assert.deepEqual(deprecatedImports("import { mountCall, newRoomId, type CallOptions } from '@displayxr/inline3d/call';"), ['newRoomId']);
  assert.deepEqual(deprecatedImports("import { mountCall } from '@displayxr/inline3d/call/full';"), []);
  const inj = injectedImports('const c = await mountCall(el);');
  assert.ok(inj.some((l) => l.includes("from '@displayxr/inline3d/call'") && l.includes('mountCall') && !l.includes('newRoomId')));
  assert.ok(inj.some((l) => l.includes("from '@displayxr/inline3d/camera'") && l.includes('openCamera')));
  assert.equal(injectedImports("import { mountCall } from '@displayxr/inline3d/call';").some((l) => l.includes('/call\'')), false, 'an entry the snippet imports from is left alone');
});

test('every doc snippet and sample typechecks against the public types', { skip: !hasTs && 'typescript not installed (CI unit job): the typecheck job runs tools/check-snippets.mjs' }, () => {
  const r = checkSnippets();
  assert.ok(r.ok, `snippets that do not compile against the public surface:\n${r.errors.join('\n')}`);
  assert.ok(r.files.length > 10, `checked ${r.files.length} files`);
});
