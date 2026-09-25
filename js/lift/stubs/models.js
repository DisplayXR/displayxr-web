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
    getDepthProvider(name) {
      return providers.get(name)?.factory || null;
    },
    list() {
      return [...providers.keys()];
    },
  };
}
