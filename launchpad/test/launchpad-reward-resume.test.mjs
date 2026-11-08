import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {activeRewardsFixture,rewardFixtureReceipt} from './helpers/rewards-wallet-fixture.mjs';
import { Launchpad } from '../src/launchpad.mjs';
import { newLaunchKeys } from '../src/launchpad-receipts.mjs';
import { launchInput, USDC_MINT } from '../public/launchpad-model.mjs';

const START = Date.parse('2026-09-26T12:00:00Z');
const overload = 'failed to get accounts owned by program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: account index service overloaded, please try again. Please use getProgramAccountsV2';
const transient = () => Object.assign(Error('Token-account scan is temporarily unavailable. Rewards will retry automatically.'), { code: 'REWARD_ACCOUNT_SCAN_RETRY' });
function initial(mode, extra = {}) {
  const keys = newLaunchKeys(); keys.payer = newLaunchKeys().wallet;
  return activeRewardsFixture({ id: 'a'.repeat(32), input: { ...launchInput({ name: 'Recovery', symbol: 'RWD', feeMode: mode, quoteMint: USDC_MINT }), taxBps: 0 }, keys, curve: newLaunchKeys().mint.address, authorizedAt: START - 4000000, createdAt: START - 4000000, lastCycle: START - 4000000, state: 'paused', phase: 'verify', autoFees: false, feesRequested: false, feeAutomation: { enabled: true, source: 'launch', updatedAt: START - 4000000 }, error: 'HTTP 503', feeCustody: 'relay', review: { quoteDecimals: 6, price: { usd: '1' } }, operations: [{ kind: 'claim', state: 'confirmed', signature: 'previous-earned-claim', slot: 90 }], credits: { quote: '200000000', base: '0' }, cycle: { stage: 'distribute', index: 0, createdAt: START - 4000000 }, gas: { day: '2026-09-26', reserved: '0' }, ...extra },START);
}
async function harness(t, launch) {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-reward-resume-')), books = new Map([['a:launchpad', { version: 1, launches: [structuredClone(launch)] }]]);
  let now = START, manager, failure = null, receipts = new Map(), work = 0, chainReads = 0;
  const prepared = [], broadcasts = [], holder = newLaunchKeys().wallet.address;
  const accounts = { dir, get: async () => ({ mainWallet: launch.keys.payer.address }), storeFor: id => ({ dir: join(dir, id), read: async (key, fallback) => structuredClone(books.get(id + ':' + key) ?? fallback), write: async (key, value) => books.set(id + ':' + key, structuredClone(value)) }) };
  const attempt = () => { work++; if (failure) throw failure; };
  const chain = { close() {}, c: { getBlockHeight: async () => 1 }, holderRewardReference: async l => ({ mint: l.input.quoteMint, usd: '1', at: now }), holderSnapshot: async () => { attempt(); return { slot: 100, rows: [{ owner: holder, amount: '1' }] }; }, swapFeeInstructions: async (_l, side) => { attempt(); assert.equal(side, 'buy'); return ['buy']; }, payoutInstructions: async () => ['payout'], burnInstructions: async () => ['burn'], claimInstructions: async () => [], receipt: async op => receipts.get(op.signature) || null,
    prepare: async (_l, instructions) => { const signature = 'new-reward-' + (prepared.length + 1); prepared.push({ signature, instructions }); return { state: 'pending', signature, raw: 'exact-' + signature, createdAt: now, lastValidBlockHeight: 100 }; },
    broadcast: async op => { assert(books.get('a:launchpad').launches[0].operations.some(saved => saved.signature === op.signature && saved.raw === op.raw), 'signed operation must be durable before broadcast'); broadcasts.push(op.signature); },
  };
  const restart = async () => { await manager?.close(); manager = new Launchpad(accounts, null, { now: () => now, chainFactory: () => { chainReads++; return chain; } }); manager.kick = () => {}; };
  await restart(); t.after(async () => { await manager.close(); await rm(dir, { recursive: true, force: true }); });
  return { prepared, broadcasts, chain, restart, get manager() { return manager; }, get saved() { return books.get('a:launchpad').launches[0]; }, get now() { return now; }, get work() { return work; }, get chainReads() { return chainReads; }, set failure(value) { failure = value; }, advance(ms) { now += ms; }, due() { now = this.saved.rewardRetry.at; },
    async confirm(quote, base = 0n) {
      const l = this.saved, op = l.operations.find(o => o.state === 'pending');
      receipts.set(op.signature,rewardFixtureReceipt(l,{quote,base,operation:op}));
      await manager.process('a');
    },
  };
}

test('persisted enabled holder and buyback pauses wait across restart then finish with unchanged credit budgets', async t => {
  for (const mode of ['holders', 'buyback']) {
    const h = await harness(t, initial(mode)), before = structuredClone(h.saved);
    await h.manager.process('a'); assert.equal(h.saved.state, 'live'); assert.equal(h.saved.rewardRetry.at, START + 30000); assert.equal(h.manager.wakeAt.get('a'), START + 30000); assert.equal(h.chainReads, 0);
    for (const key of ['credits', 'operations', 'cycle', 'feeAutomation']) assert.deepEqual(h.saved[key], before[key]);
    await h.restart(); h.advance(29999); await h.manager.process('a'); assert.equal(h.chainReads, 0); assert.equal(h.prepared.length, 0);
    h.advance(1); await h.manager.process('a'); assert.equal(h.work, 1); assert.equal(h.broadcasts.length, 1); assert.equal(h.saved.operations.at(-1).kind, mode === 'holders' ? 'payout' : 'buy'); assert.equal(h.saved.operations.at(-1).amount, before.credits.quote); assert.deepEqual(h.saved.credits, before.credits);
    await h.confirm(-200000000n, mode === 'buyback' ? 500n : 0n); assert.equal(h.saved.credits.quote, '0'); assert.equal(h.saved.rewardRetry, undefined);
    await h.manager.process('a');
    if (mode === 'buyback') { assert.equal(h.saved.operations.at(-1).kind, 'burn'); await h.confirm(0n, -500n); await h.manager.process('a'); }
    assert.equal(h.saved.cycle, null); assert.equal(h.saved.state, 'live'); assert.equal(h.saved.autoFees, true); assert.deepEqual(h.saved.credits, { quote: '0', base: '0' });
    const completed = h.broadcasts.length; await h.restart(); await h.manager.process('a'); assert.equal(h.broadcasts.length, completed, 'the finished earned credits cannot be paid or burned twice after restart');
  }
});

test('scanner retries back off durably and later success uses a fresh complete holder snapshot', async t => {
  const h = await harness(t, initial('holders')); h.failure = transient(); await h.manager.process('a'); h.due(); await h.manager.process('a');
  assert.equal(h.work, 1); assert.equal(h.saved.rewardRetry.attempt, 2); assert.equal(h.saved.rewardRetry.at, h.now + 60000); assert.equal(h.prepared.length, 0); assert.equal(h.saved.cycle.payouts, undefined); assert.equal(h.saved.credits.quote, '200000000');
  await h.restart(); await h.manager.process('a'); assert.equal(h.work, 1); h.due(); await h.manager.process('a'); assert.equal(h.saved.rewardRetry.attempt, 3); assert.equal(h.saved.rewardRetry.at, h.now + 120000); assert.equal(h.prepared.length, 0);
  h.failure = null; h.due(); await h.manager.process('a'); assert.equal(h.work, 3); assert.equal(h.prepared.length, 1); assert.equal(h.saved.operations.at(-1).amount, '200000000');
});

test('explicit pauses and scanner integrity failures never restart unsigned reward work', async t => {
  for (const mode of ['holders', 'buyback']) {
    const h = await harness(t, initial(mode, { feeAutomation: { enabled: false, source: 'user', updatedAt: START }, error: overload })), before = structuredClone(h.saved);
    await h.manager.process('a'); await h.restart(); h.advance(86400000); await h.manager.process('a'); assert.equal(h.chainReads, 0); assert.equal(h.prepared.length, 0); assert.deepEqual(h.saved, before);
  }
  const h = await harness(t, initial('holders', { state: 'live', autoFees: true, feesRequested: true, error: '' }));
  h.failure = Object.assign(Error('Invalid holder account data; HTTP 503'), { code: 'REWARD_ACCOUNT_SCAN_INVALID' }); await h.manager.process('a');
  assert.equal(h.saved.state, 'paused'); assert.equal(h.saved.rewardRetry, undefined); assert.equal(h.prepared.length, 0); const reads = h.chainReads;
  await h.restart(); h.advance(3600000); await h.manager.process('a'); assert.equal(h.chainReads, reads); assert.equal(h.saved.state, 'paused'); assert.equal(h.saved.credits.quote, '200000000');
});

test('the prior exact provider-overload pause migrates automatically while explicit opt-out remains unchanged', async t => {
  const launch = initial('holders', { error: overload }); delete launch.feeAutomation;
  const h = await harness(t, launch); h.failure = transient(); await h.manager.process('a');
  assert.equal(h.saved.feeAutomation.source, 'legacy-recovery'); assert.equal(h.saved.feeAutomation.enabled, true); assert.equal(h.saved.state, 'live'); assert.equal(h.saved.rewardRetry.at, START + 30000); assert.equal(h.prepared.length, 0);
  await h.restart(); h.failure = null; h.due(); await h.manager.process('a'); assert.equal(h.prepared.length, 1); assert.equal(h.saved.operations.at(-1).kind, 'payout'); assert.equal(h.saved.operations.at(-1).amount, '200000000');
});
