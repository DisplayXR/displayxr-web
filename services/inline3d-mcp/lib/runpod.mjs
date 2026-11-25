// RunPod serverless client for the checker endpoint (queue type). Key: an endpoint-scoped RunPod
// API key in RUNPOD_API_KEY, endpoint id in RUNPOD_ENDPOINT_ID. Never logged, never returned.
export function runpodClient({ apiKey, endpointId, base = 'https://api.runpod.ai/v2', fetchImpl = fetch } = {}) {
  if (!apiKey || !endpointId) return null;
  const call = async (path, body) => {
    const r = await fetchImpl(`${base}/${endpointId}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`RunPod ${path.split('/')[1]} HTTP ${r.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
  return {
    // The worker's own CLI timeout is 150 s; results are kept 30 min (then RunPod drops them).
    submit: (input) => call('/run', { input, policy: { executionTimeout: 170000, ttl: 1800000 } }),
    status: (id) => call(`/status/${encodeURIComponent(id)}`),
    health: () => call('/health'),
  };
}
