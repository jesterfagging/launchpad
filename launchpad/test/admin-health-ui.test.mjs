import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createAdminHealth } from '../public/admin-health-ui.mjs';

const snapshot = {
  requests: { active: 7, failed: 12, p95Ms: 251 }, eventLoop: { p95Ms: 23, maxMs: 190 }, memory: { rssBytes: 128 * 1048576 }, services: { tradeRecovery: 'degraded' },
  capacity: { rpcRequestsPerSecond: 200, sendRequestsPerSecond: 50, jupiterRequestsPerSecond: 10 },
  data: { market: { responses: 100, unavailable: 3, stale: 8 }, holders: { responses: 50, unavailable: 2, stale: 5 } },
  routes: { meteoraStatus: { completed: 80, failed: 12, rateLimited: 9, unavailable: 3, p95Ms: 870, sampleSize: 80 } },
};
const tick = () => new Promise(resolve => setImmediate(resolve));
function page(t, { account = { role: 'admin', mfaEnabled: true }, respond = async () => snapshot } = {}) {
  const { document } = parseHTML('<html><body></body></html>');
  Object.defineProperty(document, 'hidden', { value: false, writable: true });
  const calls = [], timers = new Map(); let nextTimer = 0;
  const ui = createAdminHealth({ document, getAccount: () => account,
    api: async path => { calls.push(path); return respond(); },
    setTimer: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, clearTimer: id => timers.delete(id),
  });
  document.body.append(ui.element); t.after(() => ui.destroy());
  return { ui, document, calls, timers, setAccount: value => { account = value; },
    visibility(hidden) { document.hidden = hidden; document.dispatchEvent(new document.defaultView.Event('visibilitychange')); } };
}

test('health renders measured server counters separately from configured provider budgets and degraded recovery', async t => {
  const p = page(t); await p.ui.load();
  assert.deepEqual(p.calls, ['/api/admin/health']);
  const metrics = [...p.ui.element.querySelectorAll('.admin-overview strong')].map(el => el.textContent);
  assert.deepEqual(metrics, ['7', '12', '251 ms', '23 ms', '190 ms', '128 MiB', 'Degraded']);
  assert.deepEqual([...p.ui.element.querySelectorAll('tbody td')].map(el => el.textContent), ['Meteora status and pairs', '80', '12', '9', '3', '870 ms']);
  assert.match(p.ui.element.textContent, /Market snapshots: 100 responses · 3 unavailable · 8 marked stale/);
  assert.match(p.ui.element.textContent, /Holder lists: 50 responses · 2 unavailable · 5 marked stale/);
  assert.match(p.ui.element.textContent, /Trade history: 0 responses · 0 unavailable · 0 marked stale/);
  assert.match(p.ui.element.textContent, /Configured capacity: 200 RPC requests\/s · 50 submissions\/s · 10 routing requests\/s/);
  assert.match(p.ui.element.textContent, /server settings, not a measurement of your provider plan/);
  assert.match(p.ui.element.textContent, /Unavailable and stale counts can overlap/);
  assert.match(p.ui.element.textContent, /Counts and event loop delay cover this server process since restart/);
  assert.match(p.ui.element.textContent, /256 per request group/);
});

test('health only requests data for administrators and clears a rendered snapshot on revocation', async t => {
  for (const account of [null, { role: 'user', mfaEnabled: true }]) {
    const p = page(t, { account }); await p.ui.load(); assert.equal(p.calls.length, 0);
    for (const timer of p.timers.values()) timer.fn();
    await tick(); assert.equal(p.calls.length, 0);
  }
  const p = page(t); await p.ui.load();
  assert.equal(p.ui.element.querySelectorAll('.admin-overview strong').length, 7);
  p.setAccount({ role: 'user' }); await p.ui.load();
  assert.equal(p.calls.length, 1);
  assert.equal(p.ui.element.querySelectorAll('.admin-overview strong').length, 0);
});

test('clearing or revoking health permission prevents late responses from restoring data', async t => {
  for (const action of ['clear', 'revoke', 'destroy']) {
    let resolve;
    const p = page(t, { respond: () => new Promise(done => { resolve = done; }) });
    const loading = p.ui.load();
    if (action === 'revoke') p.setAccount(null); else p.ui[action]();
    resolve(snapshot); await loading;
    assert.equal(p.ui.element.querySelectorAll('.admin-overview strong').length, 0);
    assert.ok(!p.ui.element.textContent.includes('200 RPC'));
  }
});

test('health clear admits a fresh session without allowing an older request to clear the new busy state', async t => {
  const resolvers = [], p = page(t, { respond: () => new Promise(resolve => resolvers.push(resolve)) });
  const old = p.ui.load(); p.ui.clear(); const fresh = p.ui.load();
  assert.equal(resolvers.length, 2);
  resolvers[0]({ ...snapshot, requests: { active: 999, p95Ms: 999 } }); await old;
  assert.equal(p.ui.element.querySelectorAll('.admin-overview strong').length, 0);
  await p.ui.load(); assert.equal(resolvers.length, 2);
  assert.equal(p.ui.element.querySelector('button').disabled, true);
  resolvers[1](snapshot); await fresh;
  assert.equal(p.ui.element.querySelector('.admin-overview strong').textContent, '7');
  assert.equal(p.ui.element.querySelector('button').disabled, false);
});

test('health polling skips hidden pages and stops after destroy', async t => {
  const p = page(t); await p.ui.load();
  const timer = [...p.timers.values()][0]; assert.equal(timer.ms, 30000);
  timer.fn(); await tick(); assert.equal(p.calls.length, 2);
  p.visibility(true); timer.fn(); await tick(); assert.equal(p.calls.length, 2);
  p.visibility(false); const visibleCount = p.calls.length;
  for (const current of p.timers.values()) current.fn();
  await tick(); assert.ok(p.calls.length > visibleCount);
  p.ui.destroy(); assert.equal(p.timers.size, 0);
  const stoppedCount = p.calls.length; timer.fn(); await p.ui.load(); await tick();
  assert.equal(p.calls.length, stoppedCount);
});

test('health refresh prevents overlapping requests and renders server text without HTML execution', async t => {
  let resolve;
  const p = page(t, { respond: () => new Promise(done => { resolve = done; }) });
  const pending = p.ui.load(); await p.ui.load();
  assert.equal(p.calls.length, 1); assert.equal(p.ui.element.querySelector('button').disabled, true);
  resolve({ ...snapshot, services: { tradeRecovery: '<img src=x onerror=bad()>' } }); await pending;
  assert.equal(p.ui.element.querySelector('img'), null);
  assert.match(p.ui.element.textContent, /<img src=x onerror=bad\(\)>/);
});

test('health supports older snapshots and ignores unknown request group labels', async t => {
  const p = page(t, { respond: async () => ({ ...snapshot, eventLoop: undefined, routes: { '/api/private?secret=fixture': snapshot.routes.meteoraStatus } }) });
  await p.ui.load();
  assert.equal(p.ui.element.querySelectorAll('.admin-overview strong').length, 7);
  assert.equal(p.ui.element.querySelector('table'), null);
  assert.doesNotMatch(p.ui.element.textContent, /private|secret|fixture/);
});

test('PumpSwap request groups get their own rows and service states read as words', async t => {
  const routes = { dammPumpStatus: { completed: 40, failed: 2, rateLimited: 1, unavailable: 0, p95Ms: 310 }, dammPumpPrepare: { completed: 6, failed: 0, rateLimited: 0, unavailable: 0, p95Ms: 900 }, dammPumpSubmit: { completed: 5, failed: 1, rateLimited: 0, unavailable: 1, p95Ms: 1200 }, dammPumpReconcile: { completed: 5, failed: 0, rateLimited: 0, unavailable: 0, p95Ms: 450 } };
  const p = page(t, { respond: async () => ({ ...snapshot, services: { tradeRecovery: 'not_started' }, routes }) }); await p.ui.load();
  assert.deepEqual([...p.ui.element.querySelectorAll('tbody tr td:first-child')].map(el => el.textContent), ['PumpSwap status and pairs', 'PumpSwap preparation', 'PumpSwap submission', 'PumpSwap confirmation']);
  assert.equal([...p.ui.element.querySelectorAll('.admin-overview strong')].at(-1).textContent, 'Not started');
  assert.doesNotMatch(p.ui.element.textContent, /not_started|dammPump/);
});

test('v71.37: the failed-request count is broken down by status and by area, largest first, with fixed labels only', async t => {
  const p = page(t, { respond: async () => ({ ...snapshot, failures: { byStatus: { 404: 600, 0: 100, 429: 120, other5xx: 8, 'x<img>': 3, 503: 0 }, byArea: { pages: { completed: 5000, failed: 590 }, explore: { completed: 900, failed: 230 }, probes: { completed: 100, failed: 0 }, 'zz<script>': { completed: 1, failed: 1 } } } }) });
  await p.ui.load();
  const lines = [...p.ui.element.querySelectorAll('.admin-health-failures')].map(node => node.textContent);
  assert.deepEqual(lines, ['Failed by status: 600 × 404 not found · 120 × 429 rate limited · 100 × client disconnected before the reply · 8 × other 5xx · 3 × x<img>.', 'Failed by area: pages and files 590 of 5,000 · coin data (explore) 230 of 900 · zz<script> 1 of 1.']);
  assert.equal(p.ui.element.querySelector('img,script'), null);
  const bare = page(t); await bare.ui.load(); assert.equal(bare.ui.element.querySelector('.admin-health-failures'), null);
});
