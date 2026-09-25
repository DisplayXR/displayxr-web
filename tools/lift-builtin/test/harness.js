// Runs BEFORE the bundle. In the browser the equivalent prologue is `globalThis.__dxrLiftNative = true;`
// (lift_trigger.cc); the scheme map is test-only — it rewrites displayxr-lift:// onto this server.
globalThis.__dxrHarnessAt = performance.now();
globalThis.__dxrGlobalsBefore = Object.getOwnPropertyNames(globalThis);
globalThis.__dxrLiftNative = true;
const q = new URLSearchParams(location.search);
globalThis.__dxrLiftConfig = {
  schemeMap: {
    'displayxr-lift://runtime/': location.origin + '/runtime/',
    'displayxr-lift://models/': location.origin + '/models/',
  },
  ...(q.get('workers') ? { workers: q.get('workers') } : {}),
};
globalThis.__dxrCspViolations = [];
document.addEventListener('securitypolicyviolation', (e) =>
  globalThis.__dxrCspViolations.push(`${e.violatedDirective} ${e.blockedURI} @ ${(e.sourceFile || "").split("/").pop()}:${e.lineNumber}:${e.columnNumber} ${e.sample || ""}`));
