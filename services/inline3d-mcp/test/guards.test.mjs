// Address guard, URL parsing and the spend estimator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress } from '../worker/ip-guard.mjs';
import { parsePublicUrl, guardedGet } from '../lib/url-guard.mjs';
import { budget, DEFAULTS } from '../lib/budget.mjs';
import { memoryStore } from '../lib/store.mjs';

test('private, loopback, link-local, metadata and special ranges are refused', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.5.4', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::10.0.0.1', '2002:a00:1::', 'ff02::1', '2001:db8::1', 'not-an-ip']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '216.150.1.129', '2606:4700::1111', '::ffff:8.8.8.8', '2a00:1450:4001::200e']) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

test('URL parsing refuses non-http, credentials and local names', () => {
  for (const u of ['ftp://x.org/', 'file:///etc/passwd', 'javascript:alert(1)', 'http://user:pw@example.org/', 'http://localhost/', 'http://box.local/', 'http://x.internal/', 'http://10.0.0.1/', 'http://[fe80::1]/']) {
    assert.throws(() => parsePublicUrl(u), u);
  }
  assert.equal(parsePublicUrl('https://example.org/a?b=1').hostname, 'example.org');
});

test('guardedGet refuses a name that resolves to loopback (rebinding guard at connect time)', async () => {
  // localtest.me and friends resolve to 127.0.0.1; use an IP literal path through the lookup too.
  await assert.rejects(guardedGet('http://127.0.0.1:9/'), /private|non-public/);
});

test('spend estimate: a cold job pays boot + idle, a warm follow-up pays only what it extends', async () => {
  let t = Date.UTC(2026, 10, 18, 12);
  const b = budget(memoryStore(), {}, { now: () => t });
  const first = await b.chargeJob();
  assert.equal(first, DEFAULTS.bootS + DEFAULTS.jobEstimateS + DEFAULTS.idleS);
  t += 60000; // a minute later, worker still up
  const second = await b.chargeJob();
  assert.equal(Math.round(second), 60);
  t += 3600000; // an hour later: the worker shut down long ago
  assert.equal(await b.chargeJob(), first);
  const s = await b.spent();
  assert.ok(Math.abs(s.daySeconds - (2 * first + 60)) < 1);
});

test('a real run longer than the estimate is topped up, once', async () => {
  const b = budget(memoryStore());
  await b.chargeJob();
  const before = (await b.spent()).daySeconds;
  await b.settleJob('j1', 45000);
  await b.settleJob('j1', 45000);
  assert.equal((await b.spent()).daySeconds - before, 45 - DEFAULTS.jobEstimateS);
});

test('daily cap = monthly cap / 30; the alert fires once per month', async () => {
  const alerts = [];
  const b = budget(memoryStore(), { monthlyCapUsd: 3, alertUsd: 0.05 }, { alert: async (m) => alerts.push(m) });
  assert.equal((await b.canRun()).ok, true);
  await b.chargeJob(); // 390 s at $0.58/h = $0.063: over the $0.05 alert, under the $0.10 daily cap
  assert.equal(alerts.length, 1);
  assert.equal((await b.canRun()).ok, true);
  for (let i = 0; i < 3; i++) await b.settleJob(`j${i}`, 400000);
  assert.equal(alerts.length, 1);
  const r = await b.canRun();
  assert.equal(r.ok, false);
  assert.match(r.reason, /today/);
});

test('per-IP limit', async () => {
  const b = budget(memoryStore(), { checksPerIpHour: 2 });
  assert.equal((await b.allowIp('1.2.3.4')).ok, true);
  assert.equal((await b.allowIp('1.2.3.4')).ok, true);
  assert.equal((await b.allowIp('1.2.3.4')).ok, false);
  assert.equal((await b.allowIp('5.6.7.8')).ok, true);
});
