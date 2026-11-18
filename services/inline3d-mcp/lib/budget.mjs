// The hard spend cap and the per-IP limits, kept in the counter store.
//
// RunPod bills a serverless worker for every second it is up: boot, jobs, and the idle window
// after the last job (workers.idleTimeout). We cannot read that bill cheaply per request, so we
// estimate it: an "active until" mark tracks when the single worker will shut down, and every job
// is charged the seconds it pushes that mark forward (plus a boot when the worker was down).
// Completed jobs top up the charge with their real execution time. The estimate errs high.
//
// claude.ai and ChatGPT call us from their own servers, so many users share one IP. The per-IP
// limit mainly stops a single direct client; the global daily/monthly budget is the real cap.
import { createHash } from 'node:crypto';

export const DEFAULTS = {
  pricePerHour: 0.58, // the endpoint's GPU class (16 GB Ampere, flex), USD
  monthlyCapUsd: 50,
  alertUsd: 20,
  idleS: 300, // must equal the endpoint's workers.idleTimeout
  bootS: 75, // measured cold start: 67-82 s
  jobEstimateS: 15, // a typical check (8-16 s measured)
  checksPerIpHour: 30,
  checksPerIpDay: 120,
};

const day = (t) => new Date(t).toISOString().slice(0, 10);
const month = (t) => new Date(t).toISOString().slice(0, 7);
const DAY_S = 86400;
const MONTH_S = 32 * 86400;

export function budget(store, cfg = {}, { now = () => Date.now(), salt = '', alert = async () => {} } = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const usdPerS = c.pricePerHour / 3600;
  const monthCapS = c.monthlyCapUsd / usdPerS;
  const dayCapS = monthCapS / 30;
  const ipKey = (ip) => createHash('sha256').update(`${salt}|${ip}`).digest('hex').slice(0, 24);

  async function spent() {
    const t = now();
    const [d, m] = await Promise.all([store.get(`gpu:d:${day(t)}`), store.get(`gpu:m:${month(t)}`)]);
    return { daySeconds: d, monthSeconds: m, dayUsd: d * usdPerS, monthUsd: m * usdPerS, dayCapUsd: dayCapS * usdPerS, monthCapUsd: c.monthlyCapUsd };
  }

  async function charge(seconds) {
    if (seconds <= 0) return;
    const t = now();
    const [, m] = await Promise.all([store.incr(`gpu:d:${day(t)}`, seconds, DAY_S + 3600), store.incr(`gpu:m:${month(t)}`, seconds, MONTH_S)]);
    if (m * usdPerS >= c.alertUsd && (await store.incr(`alert:${month(t)}`, 1, MONTH_S)) === 1) {
      await alert(`inline3d hosted checker: estimated GPU spend this month passed $${c.alertUsd} (now $${(m * usdPerS).toFixed(2)} of the $${c.monthlyCapUsd} cap).`);
    }
  }

  return {
    config: c,
    spent,
    // Before a job: is there budget left? Returns a reason when there is not.
    async canRun() {
      const s = await spent();
      if (s.monthSeconds >= monthCapS) return { ok: false, reason: "the hosted checker has used this month's budget" };
      if (s.daySeconds >= dayCapS) return { ok: false, reason: "the hosted checker has used today's budget" };
      return { ok: true };
    },
    // Per-IP limit on checks (guide, scaffold and the asset check use no GPU).
    async allowIp(ip) {
      const k = ipKey(ip || 'unknown');
      const hour = Math.floor(now() / 3600000);
      const [h, d] = await Promise.all([store.incr(`ip:h:${k}:${hour}`, 1, 3600), store.incr(`ip:d:${k}:${day(now())}`, 1, DAY_S)]);
      if (h > c.checksPerIpHour) return { ok: false, reason: `rate limit: ${c.checksPerIpHour} checks per hour from one address` };
      if (d > c.checksPerIpDay) return { ok: false, reason: `rate limit: ${c.checksPerIpDay} checks per day from one address` };
      return { ok: true };
    },
    // A job was submitted (warm or check): charge the seconds it adds to the worker's uptime.
    async chargeJob(jobS = c.jobEstimateS) {
      const t = now() / 1000;
      const until = await store.get('worker:active-until');
      const end = t + jobS + c.idleS;
      const add = until > t ? Math.max(0, end - until) : c.bootS + jobS + c.idleS;
      await store.set('worker:active-until', Math.max(until, end), DAY_S);
      await charge(add);
      return add;
    },
    // A check finished: top up with the part of its real run time the estimate did not cover.
    async settleJob(jobId, executionMs) {
      if (!jobId || !executionMs) return;
      if ((await store.incr(`job:${jobId}`, 1, 3600)) !== 1) return; // charge once
      const extra = executionMs / 1000 - c.jobEstimateS;
      if (extra > 0) {
        await charge(extra);
        await store.set('worker:active-until', Math.max(await store.get('worker:active-until'), now() / 1000 + c.idleS), DAY_S);
      }
    },
    async workerProbablyUp() { return (await store.get('worker:active-until')) > now() / 1000 + 20; },
  };
}
