// "Sell & distribute all" includes Pump.fun Holders coins (v71.24): the bulk
// sweep hands each live one to the Pump.fun service, which collects its creator
// fees and pays holders in the coin's pair asset, and reports progress in the
// sweep's item shape. Dependency-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminRewardSweeps } from '../src/admin-reward-sweeps.mjs';

const ACTOR = 'a'.repeat(32), OWNER = 'b'.repeat(32), REQ = '1'.repeat(32), AMD = 'AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES';
const row = (id, { state = 'created', feeMode = 'holders' } = {}) => ({ account: { id: OWNER }, launch: { id, state, input: { route: 'pump-classic', network: 'mainnet-beta', name: 'Amada', symbol: 'DELTA', feeMode, quoteMint: AMD, quoteSymbol: 'AMD' }, review: { quoteSymbol: 'AMD', quoteDecimals: 6 }, keys: { mint: { address: 'AMADAmint1111111111111111111111111111111111' } } } });

async function fixture(t, rows) {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-sweeps-pump-')), docs = new Map();
  const accounts = { dir, hostStore: { read: async (name, fallback) => docs.has(name) ? structuredClone(docs.get(name)) : fallback, write: async (name, value) => { docs.set(name, structuredClone(value)); } } };
  const calls = [], statuses = new Map();
  let clock = 1000, allowed = true, busy = false;
  const pumpClassic = {
    async queueRewardSweep(actor, input) { if (busy) throw Error('The previous engine is still stopping.'); calls.push({ actor, ...input }); statuses.set(input.requestId, { state: 'processing', stage: 'collect', reason: 'Collecting this coin’s creator fees.', distributedQuoteUnits: '0', remainingQuoteUnits: '360000000' }); return statuses.get(input.requestId); },
    async rewardSweepStatus(input) { return statuses.get(input.requestId) || { state: 'missing' }; },
  };
  const launchAdmin = { requireAdmin: async () => { if (!allowed) throw Object.assign(Error('Forbidden'), { statusCode: 403 }); return { id: ACTOR }; }, inventory: async () => ({ launches: rows }), pumpClassic };
  const sweeps = new AdminRewardSweeps({ accounts, launchpad: { book: async () => ({ launches: [] }) }, launchAdmin, launchAction: async () => { throw Error('Raydium only'); }, now: () => clock });
  sweeps.kick = () => {};
  t.after(async () => { await sweeps.close(); await rm(dir, { recursive: true, force: true }); });
  return { sweeps, calls, statuses, advance(ms = 16000) { clock += ms; }, set allowed(value) { allowed = value; }, set busy(value) { busy = value; }, async job() { return (await sweeps.read(ACTOR)).job; } };
}

test('Sell & distribute all hands live Pump.fun Holders coins to the Pump.fun service and follows them to the end', async t => {
  const live = 'c'.repeat(24), failed = 'd'.repeat(24);
  const h = await fixture(t, [row(live), row(failed, { state: 'failed' }), row('e'.repeat(24), { feeMode: 'creator' })]);
  await h.sweeps.enqueue(ACTOR, { requestId: REQ });
  await h.sweeps.process();
  let job = await h.job();
  assert.equal(job.items.length, 2, 'Holders coins only');
  assert.deepEqual(job.items.map(i => [i.launchId, i.route, i.state]), [[live, 'pump-classic', 'queued'], [failed, 'pump-classic', 'skipped']]);
  assert.equal(job.items[1].reason, 'This coin is not live.');
  await h.sweeps.process();
  job = await h.job();
  const item = job.items.find(i => i.launchId === live);
  assert.deepEqual([item.state, item.stage, item.quoteSymbol, item.quoteDecimals, item.remainingQuoteUnits, item.distributedQuoteUnits], ['processing', 'collect', 'AMD', 6, '360000000', '0']);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].actor, ACTOR); assert.equal(h.calls[0].launchId, live); assert.match(h.calls[0].requestId, /^[a-f0-9]{32}$/);
  // Checked again after 15 seconds, never queued twice.
  await h.sweeps.process(); assert.equal(h.calls.length, 1);
  h.statuses.set(h.calls[0].requestId, { state: 'completed', stage: 'done', reason: 'Paid 358.2 AMD to 41 holders.', distributedQuoteUnits: '358200000', remainingQuoteUnits: '0' });
  h.advance(); await h.sweeps.process();
  job = await h.job();
  const done = job.items.find(i => i.launchId === live);
  assert.deepEqual([done.state, done.stage, done.distributedQuoteUnits, done.remainingQuoteUnits, done.reason], ['completed', 'done', '358200000', '0', 'Paid 358.2 AMD to 41 holders.']);
  assert.equal(job.state, 'completed'); assert.equal(h.calls.length, 1, 'recorded once');
});

test('a busy Pump.fun service or revoked authorization never creates a second request', async t => {
  const live = 'c'.repeat(24), h = await fixture(t, [row(live)]);
  await h.sweeps.enqueue(ACTOR, { requestId: REQ });
  await h.sweeps.process();
  h.busy = true; await h.sweeps.process();
  let item = (await h.job()).items[0];
  assert.equal(item.state, 'waiting'); assert.match(item.reason, /busy/); assert.equal(h.calls.length, 0);
  h.busy = false; h.advance(); await h.sweeps.process();
  item = (await h.job()).items[0]; assert.equal(item.state, 'processing'); assert.equal(h.calls.length, 1);
  // A status the service no longer knows (for example after a restore) is asked for again with the same request ID.
  h.statuses.clear(); h.advance(); await h.sweeps.process();
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].requestId, h.calls[0].requestId);
  const other = await fixture(t, [row(live)]);
  await other.sweeps.enqueue(ACTOR, { requestId: REQ }); await other.sweeps.process();
  other.allowed = false; await other.sweeps.process().catch(() => {});
  assert.equal(other.calls.length, 0, 'no request without a current administrator');
});
