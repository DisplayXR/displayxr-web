// Counters with expiry: rate limits, the GPU-time budget and a few flags. Postgres (Neon, through
// DATABASE_URL) in production; an in-memory map for tests and local runs. Only counts are kept:
// keys hold a hashed IP or a date, never a URL, a page or a report.
import { neon } from '@neondatabase/serverless';

export function memoryStore() {
  const m = new Map();
  const live = (k) => { const e = m.get(k); if (e && e.exp > Date.now()) return e; m.delete(k); return null; };
  return {
    async incr(k, by, ttlS) { const e = live(k); const n = (e ? e.n : 0) + by; m.set(k, { n, exp: e ? e.exp : Date.now() + ttlS * 1000 }); return n; },
    async get(k) { const e = live(k); return e ? e.n : 0; },
    async set(k, n, ttlS) { m.set(k, { n, exp: Date.now() + ttlS * 1000 }); },
    async purge() {},
  };
}

export function postgresStore(url) {
  const sql = neon(url);
  let ready = null;
  const init = () => (ready ||= sql`CREATE TABLE IF NOT EXISTS mcp_counters (k text PRIMARY KEY, n double precision NOT NULL, expires timestamptz NOT NULL)`);
  return {
    async incr(k, by, ttlS) {
      await init();
      const r = await sql`INSERT INTO mcp_counters (k, n, expires) VALUES (${k}, ${by}, now() + make_interval(secs => ${ttlS}))
        ON CONFLICT (k) DO UPDATE SET
          n = CASE WHEN mcp_counters.expires < now() THEN EXCLUDED.n ELSE mcp_counters.n + EXCLUDED.n END,
          expires = CASE WHEN mcp_counters.expires < now() THEN EXCLUDED.expires ELSE mcp_counters.expires END
        RETURNING n`;
      return Number(r[0].n);
    },
    async get(k) {
      await init();
      const r = await sql`SELECT n FROM mcp_counters WHERE k = ${k} AND expires > now()`;
      return r.length ? Number(r[0].n) : 0;
    },
    async set(k, n, ttlS) {
      await init();
      await sql`INSERT INTO mcp_counters (k, n, expires) VALUES (${k}, ${n}, now() + make_interval(secs => ${ttlS}))
        ON CONFLICT (k) DO UPDATE SET n = EXCLUDED.n, expires = EXCLUDED.expires`;
    },
    async purge() { await init(); await sql`DELETE FROM mcp_counters WHERE expires < now()`; },
  };
}

export function storeFromEnv(env = process.env) {
  return env.DATABASE_URL ? postgresStore(env.DATABASE_URL) : memoryStore();
}
