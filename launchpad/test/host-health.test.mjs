import test from 'node:test';
import assert from 'node:assert/strict';
import { HostHealth, requestArea } from '../src/host-health.mjs';

test('host health bounds latency history and counts each response completion once', t => {
  const health = new HostHealth(); t.after(() => health.close());
  const pending = health.begin();
  for (let i = 0; i < 1100; i++) {
    const finish = health.begin(); finish(i === 0 ? 503 : 200); finish(0);
  }
  let snapshot = health.snapshot();
  assert.equal(snapshot.requests.active, 1);
  assert.equal(snapshot.requests.completed, 1100);
  assert.equal(snapshot.requests.failed, 1);
  assert.equal(snapshot.requests.sampleSize, 1024);
  assert.ok(Number.isFinite(snapshot.requests.p95Ms));
  pending(0); pending(0);
  snapshot = health.snapshot();
  assert.equal(snapshot.requests.active, 0);
  assert.equal(snapshot.requests.completed, 1101);
  assert.equal(snapshot.requests.failed, 2);
});

test('HTTP 200 missing and stale market data remain visible separately from transport errors', t => {
  const health = new HostHealth(); t.after(() => health.close());
  health.observe('/api/explore/market', 200, { native: null });
  health.observe('/api/explore/market', 200, { native: { stale: true } });
  health.observe('/api/explore/market', 200, { native: { stale: false } });
  health.observe('/api/explore/holders', 200, { available: false });
  health.observe('/api/explore/holders', 200, { available: true, stale: true });
  health.observe('/api/explore/trades', 200, { available: true });
  health.observe('/api/explore/trades', 503, { available: false });
  health.observe('/api/unknown?secret=fixture', 200, { native: null });
  const first = health.snapshot();
  assert.deepEqual(first.data, {
    market: { responses: 3, unavailable: 1, stale: 1 },
    holders: { responses: 2, unavailable: 1, stale: 1 },
    trades: { responses: 1, unavailable: 0, stale: 0 },
  });
  first.data.market.responses = 999;
  assert.equal(health.snapshot().data.market.responses, 3);
  assert.ok(!JSON.stringify(first).includes('secret'));
  assert.equal(first.services.tradeRecovery, 'not_started');
  health.tradeRecovery = 'unavailable';
  assert.equal(health.snapshot().services.tradeRecovery, 'unavailable');
});

test('launch and sign-in metrics count failures once, bound latency samples and retain only fixed route labels', t => {
  const health = new HostHealth(); t.after(() => health.close());
  for (let i = 0; i < 600; i++) {
    const finish = health.begin();
    finish(i === 0 ? 429 : i === 1 ? 503 : i === 2 ? 0 : 200, '/api/launchpad/meteora/prepare');
    finish(503, '/api/wallet/verify');
  }
  health.begin()(200, '/api/launchpad/pump/status');
  health.begin()(429, '/api/launchpad/pump/pairs');
  health.begin()(200, '/api/launchpad/meteora/confirm');
  health.begin()(200, '/api/launchpad/meteora/reconcile');
  health.begin()(503, '/api/wallet/verify');
  for (let i = 0; i < 1200; i++) health.begin()(400, `/api/unknown/private-account-${i}?secret=fixture`);
  health.begin()(200, '/api/launchpad/meteora/prepare?secret=fixture');
  const snapshot = health.snapshot();
  assert.deepEqual(Object.keys(snapshot.routes).sort(), ['meteoraPrepare', 'meteoraReconcile', 'pumpStatus', 'walletVerify']);
  assert.deepEqual({ ...snapshot.routes.meteoraPrepare, p95Ms: 0 }, { completed: 600, failed: 3, rateLimited: 1, unavailable: 1, sampleSize: 256, p95Ms: 0 });
  assert.ok(Number.isFinite(snapshot.routes.meteoraPrepare.p95Ms));
  assert.equal(snapshot.routes.pumpStatus.completed, 2); assert.equal(snapshot.routes.pumpStatus.rateLimited, 1);
  assert.equal(snapshot.routes.meteoraReconcile.completed, 2); assert.equal(snapshot.routes.walletVerify.unavailable, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-account|secret|fixture|\/api\//);
  snapshot.routes.meteoraPrepare.failed = 999;
  assert.equal(health.snapshot().routes.meteoraPrepare.failed, 3);
});

test('public DAMM PumpSwap launch traffic appears in fixed health labels', t => {
  const health = new HostHealth(); t.after(() => health.close());
  health.begin()(200, '/api/launchpad/damm-pump/status');
  health.begin()(429, '/api/launchpad/damm-pump/pairs');
  health.begin()(503, '/api/launchpad/damm-pump/prepare');
  health.begin()(200, '/api/launchpad/damm-pump/submit');
  health.begin()(200, '/api/launchpad/damm-pump/reconcile');
  health.begin()(400, '/api/launchpad/damm-pump/prepare?secret=fixture');
  health.begin()(400, '/api/launchpad/damm-pump/private-wallet-fixture');
  const { routes } = health.snapshot();
  assert.deepEqual(Object.keys(routes).sort(), ['dammPumpPrepare', 'dammPumpReconcile', 'dammPumpStatus', 'dammPumpSubmit']);
  assert.equal(routes.dammPumpStatus.completed, 2);
  assert.equal(routes.dammPumpStatus.rateLimited, 1);
  assert.equal(routes.dammPumpPrepare.completed, 1);
  assert.equal(routes.dammPumpPrepare.unavailable, 1);
  assert.equal(routes.dammPumpSubmit.completed, 1);
  assert.equal(routes.dammPumpReconcile.completed, 1);
  assert.doesNotMatch(JSON.stringify(routes), /secret|fixture|wallet|\/api\//);
});

test('v71.37: failed requests break down by fixed status label and by area label, never by path', t => {
  const health = new HostHealth(); t.after(() => health.close());
  health.begin()(404, '/coin/does-not-exist?secret=fixture'); health.begin()(404, '/api/explore/market?mint=secret-fixture'); health.begin()(0, '/api/launchpad/meteora/status');
  health.begin()(429, '/api/launchpad/agents?limit=24'); health.begin()(418, '/api/account/private-fixture'); health.begin()(599, '/api/admin/health'); health.begin()(200, '/healthz'); health.begin()(200, '/index.html'); health.begin()(503, '/api/other/thing'); health.begin()(401, '/api/wallet/verify'); health.begin()(500, '');
  const snapshot = health.snapshot();
  assert.deepEqual(snapshot.failures.byStatus, { 404: 2, 0: 1, 429: 1, other4xx: 1, other5xx: 1, 503: 1, 401: 1, 500: 1 });
  assert.deepEqual(snapshot.failures.byArea, { pages: { completed: 2, failed: 1 }, explore: { completed: 1, failed: 1 }, launchpad: { completed: 1, failed: 1 }, agents: { completed: 1, failed: 1 }, account: { completed: 2, failed: 2 }, admin: { completed: 1, failed: 1 }, probes: { completed: 1, failed: 0 }, otherApi: { completed: 1, failed: 1 }, other: { completed: 1, failed: 1 } });
  assert.equal(snapshot.requests.failed, 9);
  assert.ok(!JSON.stringify(snapshot).includes('secret') && !JSON.stringify(snapshot).includes('fixture'));
  snapshot.failures.byArea.pages.failed = 99; assert.equal(health.snapshot().failures.byArea.pages.failed, 1);
  assert.deepEqual(['/api/launchpad/agents/agent', '/api/launchpad/pump/status', '/api/session', '/readyz', '/explore', '/api/zzz'].map(requestArea), ['agents', 'launchpad', 'account', 'probes', 'pages', 'otherApi']);
});
