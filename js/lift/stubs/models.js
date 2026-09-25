// lift/stubs/models.js — STUB of js/lift/providers/models.js (A2). Fetches nothing.
//
// Same exports: createModelSource({baseUrl?, manifest?}), loadOrt({baseUrl}), getRegistry().

export function createModelSource({ baseUrl = '' } = {}) {
  return {
    async get(name) {
      const stream = typeof ReadableStream === 'function' ? new ReadableStream({ start: (c) => c.close() }) : null;
      return { stream, size: 0, sha256: '', name };
    },
    url(name) {
      return `${baseUrl}${name}`;
    },
  };
}

export async function loadOrt() {
  return null; // the stub depth provider needs no runtime
}

const providers = new Map();
export function getRegistry() {
  return {
    registerDepthProvider(name, factory, { priority = 0 } = {}) {
      providers.set(name, { factory, priority });
    },
    // Same semantics as the real registry: an INSTANCE for a registered name, else null (lift.js
    // then falls back to createDepthProvider).
    getDepthProvider(name, opts = {}) {
      const e = providers.get(name);
      return e ? e.factory({ ...opts, model: name }) : null;
    },
    list() {
      return [...providers.keys()];
    },
  };
}
