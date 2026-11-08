import test from 'node:test';
import assert from 'node:assert/strict';
import { RobinhoodEngine } from '../src/robinhood-engine.mjs';
import { RobinhoodRuns } from '../src/robinhood-runtime.mjs';
import { createRobinhoodAccount } from '../src/robinhood-settings.mjs';
import { manualIdentity } from '../src/robinhood-manual.mjs';
import { EVM_NATIVE } from '../public/chains.mjs';

const token = '0x1111111111111111111111111111111111111111';
function fixture(t) {
  const raw = createRobinhoodAccount().settings, wallet = raw.wallets[0]; let disk, swaps = 0;
  const ledger = { data: { version: 1, lots: [], pending: [], seen: [], events: [] }, async save() { disk = structuredClone(this.data); }, addEvent() {}, async remember(id) { this.data.seen.push(id); await this.save(); } };
  const engine = new RobinhoodEngine(ledger, { version: 'fees' }, 'copy'); t.after(() => engine.close());
  raw.agreedFeeVersion = 'fees'; engine.state = 'running'; engine.config = raw; engine.tool = raw.tools.copy; engine.abort = new AbortController();
  engine.rpc = { balance: async () => 100n }; engine.pools = { find: async () => ({ currency0: EVM_NATIVE, currency1: token }) };
  engine.enqueue = async (_wallet, job) => job();
  engine.swap = async () => { swaps++; ledger.data = structuredClone(ledger.data); return { transactionHash: `0x${'ab'.repeat(32)}` }; };
  const trade = { id: 'recover-manual', side: 'buy', token, amount: '0.01', wallets: [wallet.publicKey] };
  return { raw, trade, ledger, engine, wallet, swaps: () => swaps, disk: () => disk };
}
test('manual results survive receipt staging and a repeated request cannot repeat a swap', async t => {
  const h = fixture(t); await h.engine.manualTrade(h.raw, h.trade);
  assert.equal(h.engine.manualResult.results[0].state, 'confirmed'); assert.equal(h.disk().manualRequests[0].complete, true);
  await h.engine.manualTrade(h.raw, h.trade); assert.equal(h.swaps(), 1);
  await assert.rejects(h.engine.manualTrade(h.raw, { ...h.trade, amount: '0.02' }), /different trade settings/);
  assert.equal(h.swaps(), 1);
});
test('broadcast uncertainty stays pending and queued wallets receive an explicit skipped result', async t => {
  const h = fixture(t), second = h.raw.wallets[1]; h.trade.wallets.push(second.publicKey);
  h.engine.enqueue = async (wallet, job) => { if (wallet === second) return; return job(); };
  h.engine.swap = async wallet => { h.ledger.data.pending.push({ wallet: wallet.publicKey, signature: 'pending-signature', context: { manualId: h.trade.id } }); throw Error('Transaction is still unresolved.'); };
  await h.engine.manualTrade(h.raw, h.trade);
  const rows = h.engine.manualResult.results; assert.equal(rows[0].state, 'pending'); assert.equal(rows[0].signature, 'pending-signature'); assert.equal(rows[1].state, 'skipped');
  await h.engine.manualTrade(h.raw, h.trade); assert.equal(h.ledger.data.pending.length, 1);
});
test('after a host restart a saved manual request returns its result without creating a worker', async t => {
  const h = fixture(t); await h.engine.manualTrade(h.raw, h.trade); const data = h.disk(); let created = 0;
  const manager = { storeFor: () => ({ read: async () => data }), engineFactory: () => { created++; throw Error('Must not create a worker'); } };
  const runs = new RobinhoodRuns(manager, 'account');
  const result = await runs.manualTrade({}, h.trade, 'copy'); assert.equal(result.manualResult.results[0].state, 'confirmed'); assert.equal(created, 0);
  await assert.rejects(runs.manualTrade({}, { ...h.trade, side: 'sell' }, 'copy'), /different trade settings/);
  data.manualRequests[0] = { id: h.trade.id, identity: manualIdentity(h.trade), side: 'buy', complete: false, results: [{ wallet: h.wallet.publicKey, state: 'queued' }] };
  const interrupted = await runs.manualTrade({}, h.trade, 'copy'); assert.equal(interrupted.manualResult.complete, true); assert.equal(interrupted.manualResult.results[0].state, 'skipped'); assert.equal(created, 0);
});
test('Stop during the saved-request lookup cancels an unaccepted manual order', async () => {
  let release; const lookup = new Promise(resolve => { release = resolve; }), manager = { storeFor: () => ({ read: () => lookup }) }, runs = new RobinhoodRuns(manager, 'account');
  const task = runs.manualTrade({}, { id: 'stop-lookup', side: 'buy', token, amount: '0.01', wallets: [] }, 'copy');
  runs.stop('copy'); release({}); await assert.rejects(task, /stopped before this manual request/); assert.equal(runs.workers.size, 0);
});
