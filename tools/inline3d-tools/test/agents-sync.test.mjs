// AGENTS.md and the plugin's pinned tool version must match the skills and this package.
//   node --test tools/inline3d-tools/test/agents-sync.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sync } from '../scripts/sync-agents.mjs';

test('AGENTS.md + plugin pins are in sync (node tools/inline3d-tools/scripts/sync-agents.mjs)', () => {
  assert.deepEqual(sync({ check: true }), []);
});
