// signaling/turn-budget.mjs — TURN metering and the monthly cost ceiling (RFC 0003 §5c).
//
// TURN relay is the only real cost of the hosted service. This module answers one question per
// join: "may this session get TURN credentials, and for how long?" — from an org-wide monthly
// budget with graduated shedding:
//
//   usage/budget   < 70%   ok        everyone gets TURN at the tier's TTL
//   70% … 90%      degraded  anonymous mints get a 300 s TTL and a per-IP hourly cap of 5
//   90% … 100%     degraded  anonymous mints STOP (reason 'budget'); keyed sessions keep TURN
//   >= 100%        off       nobody gets new credentials (reason 'cap') → the SDK's `turn-cap`
//
// Direct P2P keeps working throughout (the welcome simply carries no `iceServers`), and relays
// already allocated run until their credentials expire.
//
// Two usage figures, and which one counts:
//   - ESTIMATED: every mint records (key, ttl). estimatedGB = Σ ttl-hours × EST_GB_PER_TTL_HOUR.
//     Always available; crude on purpose (a credential may never relay a byte, or may relay for
//     its whole TTL). The default 0.3 GB per TTL-hour assumes ~15% of sessions relay at ~3.5 Mbps
//     both ways.
//   - ACTUAL: Cloudflare exposes relay bytes per TURN key and per `customIdentifier` through the
//     GraphQL analytics dataset `callsTurnUsageAdaptiveGroups`. A scheduled (cron) handler polls
//     it and stores month-to-date GB (total and per key). When an ACTUAL figure is fresh (< 3 h),
//     it is what counts; otherwise the estimate does. A test / operator OVERRIDE (admin endpoint
//     or the TURN_FORCE_USAGE_GB var) beats both.
//
// Usage is aggregated PER KEY (plus 'anon') every month — the billing identity the business
// model needs — while billing itself stays off: nothing here charges anyone.

export const GB = 1e9;

/** @typedef {{ freeGB: number, capUSD: number, pricePerGB: number, shedFrac: number, stopAnonFrac: number, estGBPerTtlHour: number, actualMaxAgeMs: number, forceUsageGB: number|null }} BudgetConfig */

export const DEFAULT_BUDGET = Object.freeze({
  freeGB: 1000, // Cloudflare Realtime TURN free tier, per month
  capUSD: 100, // RFC 0003 Decision 2: the hard cap beyond the free tier
  pricePerGB: 0.05, // verify against current Cloudflare pricing when it changes
  shedFrac: 0.7,
  stopAnonFrac: 0.9,
  estGBPerTtlHour: 0.3,
  actualMaxAgeMs: 3 * 3600_000,
  forceUsageGB: null,
});

const num = (v, dflt) => {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

/** Read the budget knobs from env (TURN_FREE_GB, TURN_CAP_USD, TURN_PRICE_PER_GB, TURN_SHED_FRAC, TURN_STOP_ANON_FRAC, TURN_EST_GB_PER_TTL_HOUR, TURN_FORCE_USAGE_GB). */
export function budgetFromEnv(env = {}) {
  return {
    freeGB: num(env.TURN_FREE_GB, DEFAULT_BUDGET.freeGB),
    capUSD: num(env.TURN_CAP_USD, DEFAULT_BUDGET.capUSD),
    pricePerGB: num(env.TURN_PRICE_PER_GB, DEFAULT_BUDGET.pricePerGB) || DEFAULT_BUDGET.pricePerGB,
    shedFrac: num(env.TURN_SHED_FRAC, DEFAULT_BUDGET.shedFrac),
    stopAnonFrac: num(env.TURN_STOP_ANON_FRAC, DEFAULT_BUDGET.stopAnonFrac),
    estGBPerTtlHour: num(env.TURN_EST_GB_PER_TTL_HOUR, DEFAULT_BUDGET.estGBPerTtlHour),
    actualMaxAgeMs: DEFAULT_BUDGET.actualMaxAgeMs,
    forceUsageGB: env.TURN_FORCE_USAGE_GB === undefined || env.TURN_FORCE_USAGE_GB === '' ? null : num(env.TURN_FORCE_USAGE_GB, null),
  };
}

/** Total GB the month may use before the cap: free tier + what $cap buys. */
export function budgetGB(cfg) {
  return cfg.freeGB + cfg.capUSD / cfg.pricePerGB;
}

export function monthOf(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Month-to-date usage state. Serialisable; one instance per deployment (a 'budget' Durable
 * Object on Cloudflare, a field of the dev server).
 */
export class TurnBudget {
  /** @param {{ cfg?: Partial<BudgetConfig>, now?: () => number, state?: any }} [o] */
  constructor({ cfg = {}, now = () => Date.now(), state = null } = {}) {
    this.cfg = { ...DEFAULT_BUDGET, ...cfg };
    this.now = now;
    this.month = monthOf(now());
    /** per key id (or 'anon'): { joins, mints, ttlSeconds, actualGB? } */
    this.byKey = {};
    this.actualGB = null;
    this.actualAt = 0;
    this.overrideGB = null;
    if (state) this._load(state);
  }

  _load(s) {
    if (!s || typeof s !== 'object') return;
    if (s.month === this.month) {
      if (s.byKey && typeof s.byKey === 'object') this.byKey = JSON.parse(JSON.stringify(s.byKey));
      if (Number.isFinite(s.actualGB)) this.actualGB = s.actualGB;
      if (Number.isFinite(s.actualAt)) this.actualAt = s.actualAt;
    }
    // An override survives a month rollover on purpose (it is an operator's switch, not usage).
    if (Number.isFinite(s.overrideGB)) this.overrideGB = s.overrideGB;
  }

  toJSON() {
    return { month: this.month, byKey: this.byKey, actualGB: this.actualGB, actualAt: this.actualAt, overrideGB: this.overrideGB };
  }

  /** A new UTC month resets the counters (called before every read/write). */
  _roll() {
    const m = monthOf(this.now());
    if (m !== this.month) {
      this.month = m;
      this.byKey = {};
      this.actualGB = null;
      this.actualAt = 0;
    }
  }

  _bucket(keyId) {
    const id = keyId || 'anon';
    return (this.byKey[id] ??= { joins: 0, mints: 0, ttlSeconds: 0 });
  }

  recordJoin(keyId) {
    this._roll();
    this._bucket(keyId).joins++;
  }

  recordMint(keyId, ttlSeconds) {
    this._roll();
    const b = this._bucket(keyId);
    b.mints++;
    b.ttlSeconds += Math.max(0, ttlSeconds | 0);
  }

  /** The analytics poll result: total month-to-date relay GB, and per key if known. */
  setActual(totalGB, { byKey = null, at = this.now() } = {}) {
    this._roll();
    this.actualGB = Number.isFinite(totalGB) ? totalGB : null;
    this.actualAt = this.actualGB === null ? 0 : at;
    if (byKey && typeof byKey === 'object') for (const [k, gb] of Object.entries(byKey)) if (Number.isFinite(gb)) this._bucket(k).actualGB = gb;
  }

  /** Operator / test override of the usage figure (null clears it). */
  setOverride(gb) {
    this.overrideGB = Number.isFinite(gb) ? gb : null;
  }

  get estimatedGB() {
    let h = 0;
    for (const b of Object.values(this.byKey)) h += (b.ttlSeconds || 0) / 3600;
    return h * this.cfg.estGBPerTtlHour;
  }

  /** The figure that counts right now, and where it came from. */
  usedGB() {
    this._roll();
    if (Number.isFinite(this.cfg.forceUsageGB)) return { gb: this.cfg.forceUsageGB, source: 'forced' };
    if (this.overrideGB !== null) return { gb: this.overrideGB, source: 'override' };
    if (this.actualGB !== null && this.now() - this.actualAt < this.cfg.actualMaxAgeMs) return { gb: this.actualGB, source: 'actual' };
    return { gb: this.estimatedGB, source: 'estimate' };
  }

  /** Everything an operator wants to see (admin endpoint) and what `policy()` decides on. */
  snapshot() {
    const { gb, source } = this.usedGB();
    const total = budgetGB(this.cfg);
    const fraction = total > 0 ? gb / total : 1;
    return {
      month: this.month,
      usedGB: round(gb),
      source,
      estimatedGB: round(this.estimatedGB),
      actualGB: this.actualGB === null ? null : round(this.actualGB),
      actualAt: this.actualAt || null,
      overrideGB: this.overrideGB,
      budgetGB: total,
      freeGB: this.cfg.freeGB,
      capUSD: this.cfg.capUSD,
      fraction: Math.round(fraction * 1000) / 1000,
      status: statusFor(fraction, this.cfg),
      byKey: this.byKey,
    };
  }
}

function round(x) {
  return Math.round(x * 1000) / 1000;
}

/** 'ok' | 'degraded' | 'off' for a usage fraction. */
export function statusFor(fraction, cfg = DEFAULT_BUDGET) {
  if (fraction >= 1) return 'off';
  if (fraction >= cfg.shedFrac) return 'degraded';
  return 'ok';
}

/**
 * The per-session TURN decision. Pure: from a budget snapshot (`fraction`, or a `status` plus
 * `fraction`) and the session's tier + limits.
 * @param {{ fraction: number }} snap
 * @param {'anon'|'key'} tier
 * @param {{ turnTtl: number, mintsPerHour: number }} limits
 * @param {BudgetConfig} [cfg]
 * @returns {{ mint: boolean, ttl: number, mintsPerHour: number, status: 'ok'|'degraded'|'off', reason?: 'budget'|'cap' }}
 */
export function turnPolicy(snap, tier, limits, cfg = DEFAULT_BUDGET) {
  const f = snap && Number.isFinite(snap.fraction) ? snap.fraction : 0;
  const status = statusFor(f, cfg);
  if (status === 'off') return { mint: false, ttl: 0, mintsPerHour: 0, status, reason: 'cap' };
  if (tier !== 'key' && status === 'degraded') {
    if (f >= cfg.stopAnonFrac) return { mint: false, ttl: 0, mintsPerHour: 0, status, reason: 'budget' };
    return { mint: true, ttl: Math.min(300, limits.turnTtl), mintsPerHour: Math.min(5, limits.mintsPerHour), status };
  }
  return { mint: true, ttl: limits.turnTtl, mintsPerHour: limits.mintsPerHour, status };
}

/**
 * Read month-to-date relay bytes from Cloudflare's GraphQL analytics (dataset
 * `callsTurnUsageAdaptiveGroups`, filtered to this TURN key, grouped by `customIdentifier` — which
 * `mintTurnCredentials` sets to the session's key id). Needs an API token with the account's
 * "Account Analytics: Read" permission (`CF_ANALYTICS_API_TOKEN`, a Worker secret) and the
 * account id (`CF_ACCOUNT_ID`). Returns null when not configured.
 * @returns {Promise<null | { totalGB: number, byKey: Record<string, number>, from: string, to: string }>}
 */
export async function readTurnUsage(env, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  if (!env || !env.CF_ANALYTICS_API_TOKEN || !env.CF_ACCOUNT_ID || !env.TURN_KEY_ID) return null;
  const d = new Date(now);
  const from = `${monthOf(now)}-01`;
  const to = d.toISOString().slice(0, 10);
  const query = `query ($account: string!, $key: string!, $from: Date!, $to: Date!) {
    viewer { accounts(filter: { accountTag: $account }) {
      callsTurnUsageAdaptiveGroups(limit: 1000, filter: { date_geq: $from, date_leq: $to, keyId: $key }) {
        dimensions { customIdentifier }
        sum { egressBytes ingressBytes }
      } } } }`;
  const res = await fetchImpl('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CF_ANALYTICS_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { account: env.CF_ACCOUNT_ID, key: env.TURN_KEY_ID, from, to } }),
  });
  if (!res.ok) throw new Error(`TURN analytics: HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors && body.errors.length) throw new Error(`TURN analytics: ${body.errors[0].message || 'GraphQL error'}`);
  const groups = body?.data?.viewer?.accounts?.[0]?.callsTurnUsageAdaptiveGroups || [];
  const byKey = {};
  let total = 0;
  for (const g of groups) {
    const bytes = (g.sum?.egressBytes || 0) + (g.sum?.ingressBytes || 0);
    const id = g.dimensions?.customIdentifier || 'anon';
    byKey[id] = (byKey[id] || 0) + bytes / GB;
    total += bytes / GB;
  }
  return { totalGB: total, byKey, from, to };
}
