// Vercel function: the connector's streamable-HTTP MCP endpoint, https://mcp.displayxr.org/mcp.
// Stateless (no session ids): every POST builds a fresh server, answers with JSON, and is done.
// Authless by design; abuse is bounded by the GPU budget and per-IP limits in lib/budget.mjs.
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createServer } from '../lib/server.mjs';
import { runpodClient } from '../lib/runpod.mjs';
import { budget } from '../lib/budget.mjs';
import { storeFromEnv } from '../lib/store.mjs';

const env = process.env;
const store = storeFromEnv(env);
const runpod = runpodClient({ apiKey: env.RUNPOD_API_KEY, endpointId: env.RUNPOD_ENDPOINT_ID });
const limits = budget(store, {
  ...(env.MONTHLY_CAP_USD ? { monthlyCapUsd: Number(env.MONTHLY_CAP_USD) } : {}),
  ...(env.ALERT_USD ? { alertUsd: Number(env.ALERT_USD) } : {}),
  ...(env.GPU_PRICE_PER_HOUR ? { pricePerHour: Number(env.GPU_PRICE_PER_HOUR) } : {}),
}, {
  salt: env.IP_SALT || '',
  alert: async (text) => {
    console.error(`ALERT ${text}`);
    if (env.ALERT_WEBHOOK_URL) await fetch(env.ALERT_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }).catch(() => {});
  },
});

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, mcp-protocol-version, mcp-session-id, authorization',
  'access-control-expose-headers': 'mcp-session-id',
};
const withCors = (res) => { for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v); return res; };

function clientIp(req) {
  const h = req.headers;
  return h.get('x-real-ip') || (h.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
}

export async function POST(request) {
  const server = createServer({ runpod, limits, clientIp: clientIp(request), log: (m) => console.log(m) });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return withCors(await transport.handleRequest(request));
  } finally {
    if (Math.random() < 0.02) store.purge().catch(() => {});
  }
}

// Stateless server: no server-initiated stream and no sessions to delete.
const notAllowed = () => withCors(new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: POST JSON-RPC to this URL' }, id: null }), { status: 405, headers: { 'content-type': 'application/json', allow: 'POST, OPTIONS' } }));
export const GET = notAllowed;
export const DELETE = notAllowed;
export function OPTIONS() { return withCors(new Response(null, { status: 204 })); }
