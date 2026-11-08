// Pump.fun Classic reward baskets (v71.35): a Holders coin that names up to two
// more reward assets, driven through the real service against the scripted
// chain: the quote's checks, the round split, the purchases from the rewards
// wallet, the per-asset payouts to the same holders, the failed-purchase
// fallback and the public views. Dependency-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, body, openIntake, pass, fundAndCreate, signature, generateWallet } from './helpers/pump-classic-world.mjs';
import { PUMP_CLASSIC_POLICY_V5 } from '../src/pump-classic/policy.mjs';
import { PUMP_CLASSIC_SCHEMA_VERSION } from '../src/pump-classic/store.mjs';

const MINUTE = 60000, SOL = 'So11111111111111111111111111111111111111112';
const holdersOf = rows => rows.map(([owner, amount]) => ({ owner, amount: String(amount) }));
/** Records one creator-fee distribution of `total` lamports (platform 10%, rewards wallet 90%) through the receipt journal. */
function distribute(h, launch, total) {
  const sig = signature(), platform = total / 10n, rest = total - platform;
  const rows = h.world.history.get(launch.protocol_wallet) || [];
  h.world.history.set(launch.protocol_wallet, [...rows, { signature: sig, slot: 90 + rows.length, failed: false }]);
  h.world.distributions.set(sig, { signature: sig, slot: 90 + rows.length, blockTime: 1, failed: false, payer: generateWallet().address, feeLamports: 5000n, anomalies: [], legs: [{ eventIndex: 0, recipient: launch.protocol_wallet, amount: platform, distributed: total, shareBps: 1000 }, { eventIndex: 0, recipient: launch.mode_wallet, amount: rest, distributed: total, shareBps: 9000 }] });
  h.world.lamports.set(launch.mode_wallet, (h.world.lamports.get(launch.mode_wallet) ?? 0n) + rest);
  h.advance(61000);
  return sig;
}
/** Two listed-looking assets with a SOL route: 1 lamport buys 2 raw units of TSLAx (6 decimals), 5 of NVDAx (8 decimals). */
function basketWorld(h) {
  const tsla = generateWallet().address, nvda = generateWallet().address;
  h.world.assets = new Map([[tsla, { symbol: 'TSLAx', decimals: 6, rawPerLamport: 2n }], [nvda, { symbol: 'NVDAx', decimals: 8, rawPerLamport: 5n }]]);
  h.world.prices = new Map([[tsla, 300], [nvda, 180]]);
  h.world.tokens = new Map(); h.world.accounts = new Map();
  return { tsla, nvda };
}
/** Confirms every open purchase (acquire) as the route promised and every open airdrop, pass by pass, until `done` holds. */
async function drive(h, launch, done, limit = 40) {
  const store = h.service.store();
  for (let i = 0; i < limit; i++) {
    for (const op of store.openOperations(launch.id)) {
      if (!['signed', 'submitted', 'unknown'].includes(op.state) || h.world.receipts.has(op.signature)) continue;
      if (op.kind === 'acquire') {
        const asset = h.world.assets.get(op.expected.op.mint), input = BigInt(op.expected.op.inputAmount), output = input * asset.rawPerLamport;
        if (h.world.failSettle?.has(op.expected.op.mint)) { h.world.receipts.set(op.signature, { state: 'failed', actualSolCostLamports: '5000', outputAmount: '0' }); continue; }
        h.world.receipts.set(op.signature, { state: 'confirmed', outputAmount: output.toString(), actualSolCostLamports: '7000', slot: 130 });
        const wallet = h.world.tokens.get(op.wallet) || new Map(); wallet.set(op.expected.op.mint, (wallet.get(op.expected.op.mint) || 0n) + output); h.world.tokens.set(op.wallet, wallet);
        h.world.lamports.set(op.wallet, (h.world.lamports.get(op.wallet) ?? 0n) - input - 7000n);
      } else if (op.kind === 'airdrop') h.world.receipts.set(op.signature, { state: 'confirmed', actualSolCostLamports: '6000', slot: 140 });
    }
    h.advance(11000); await pass(h);
    if (done()) return true;
    h.advance(5 * MINUTE - 22000); // the next pass five minutes on: holder snapshots keep their cadence
  }
  return false;
}
/** An hour of holder snapshots just under five minutes apart, so the minute the receipt scanner needs never opens a gap in the window. */
async function snapshots(h, times = 14) { for (let i = 0; i < times; i++) { await h.service.process(); h.advance(294000); } }
async function basketCoin(h, extras, overrides = {}) {
  await openIntake(h, { intake: true, launch: true, collection: true, routing: true, holders: true });
  h.world.treasury = generateWallet().address;
  const launch = await fundAndCreate(h, body({ mode: 'holders', basket: extras, ...overrides }));
  assert.equal(launch.state, 'created');
  return launch;
}

test('schema 4 carries the basket, its ledger and the cycle asset; policy v5 names the basket rules', () => {
  assert.equal(PUMP_CLASSIC_SCHEMA_VERSION, 4);
  assert.deepEqual(PUMP_CLASSIC_POLICY_V5.basket.modes, ['holders']); assert.equal(PUMP_CLASSIC_POLICY_V5.basket.maxExtras, 2);
  assert.equal(PUMP_CLASSIC_POLICY_V5.basket.conversionAttempts, 3); assert.equal(PUMP_CLASSIC_POLICY_V5.basket.conversionMaxImpactBps, 200);
});

test('a quote freezes a checked basket on a Holders coin and refuses it elsewhere', async () => {
  const h = harness();
  try {
    await openIntake(h); const { tsla, nvda } = basketWorld(h);
    const view = await h.service.quote(h.session, { ...body({ basket: [tsla, nvda] }), wallet: h.dev });
    assert.deepEqual(view.basket.assets.map(a => a.symbol), ['SOL', 'TSLAx', 'NVDAx']); assert.equal(view.basket.count, 3); assert.equal(view.basket.description, 'SOL, TSLAx and NVDAx');
    const saved = h.service.store().launch(view.id);
    assert.deepEqual(saved.basket.assets, [{ mint: SOL, symbol: 'SOL', decimals: 9, program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { mint: tsla, symbol: 'TSLAx', decimals: 6, program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { mint: nvda, symbol: 'NVDAx', decimals: 8, program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }]);
    assert.equal(saved.basket.shares, 'equal'); assert.equal(h.world.calls.filter(c => c === 'quoteDevBuyConversion').length, 2, 'one route probe per extra asset, nothing bought');
    assert.match(h.service.store().events(view.id, { publicOnly: false, limit: 5 }).map(e => e.body).join(' '), /Reward basket: SOL, TSLAx and NVDAx, equal shares\./);
    await h.service.cancel(h.session, { launchId: view.id });
    // Holders only; at most two extras; the pair asset itself and unknown or unroutable assets are refused by name.
    await assert.rejects(h.service.quote(h.session, { ...body({ mode: 'creator', basket: [tsla] }), wallet: h.dev }), /A reward basket is for Holders launches\. Choose Holders, or remove the basket\./);
    await assert.rejects(h.service.quote(h.session, { ...body({ basket: [tsla, nvda, generateWallet().address] }), wallet: h.dev }), /at most 3 assets: your pair asset plus 2 more/);
    await assert.rejects(h.service.quote(h.session, { ...body({ basket: [SOL] }), wallet: h.dev }), /Your pair asset is already in the basket/);
    await assert.rejects(h.service.quote(h.session, { ...body({ basket: [generateWallet().address] }), wallet: h.dev }), /cannot join the basket: its token mint was not found/);
    h.world.unroutable = new Set([nvda]);
    await assert.rejects(h.service.quote(h.session, { ...body({ basket: [tsla, nvda] }), wallet: h.dev }), /NVDAx cannot join the basket: Launchpad’s swap route does not accept this asset\./);
    h.world.unroutable = new Set();
    assert.equal((await h.service.quote(h.session, { ...body({ basket: [] }), wallet: h.dev })).basket, null, 'an empty list is no basket');
  } finally { await h.cleanup(); }
});

test('a reward round splits equally, buys the extra assets from the rewards wallet and pays every asset to the same top holders', async () => {
  const h = harness();
  try {
    const { tsla, nvda } = basketWorld(h), launch = await basketCoin(h, [tsla, nvda]);
    const store = h.service.store(), a = generateWallet().address, b = generateWallet().address, c = generateWallet().address;
    h.world.holders = holdersOf([[a, 600_000_000_000n], [b, 300_000_000_000n], [c, 100_000_000_000n]]);
    await snapshots(h); // an hour of holder snapshots
    distribute(h, launch, 3_000_000_000n); // 2.7 SOL to the rewards wallet: well above the $100 trigger at $150/SOL
    await pass(h); // receipts recorded
    assert.equal(store.quoteBalances(launch.id).rewards, undefined); assert.ok(h.service.payoutHeld(launch) > 2_000_000_000n);
    const finished = await drive(h, launch, () => !h.service.payoutRequest(store.launch(launch.id)) && store.rewardCycles(launch.id, 10).length === 3);
    assert.ok(finished, 'the round completes: two basket-asset cycles and the SOL cycle');
    const cycles = store.rewardCycles(launch.id, 10).reverse(), events = store.events(launch.id, { publicOnly: false, limit: 80 }).map(e => e.title);
    assert.deepEqual(cycles.map(cy => cy.mint), [tsla, nvda, null], 'the extra assets are paid first, the main asset last');
    assert.ok(cycles.every(cy => cy.state === 'complete' && cy.payouts.length === 3));
    assert.deepEqual(cycles.map(cy => cy.payouts.map(p => p.owner)), [[a, b, c], [a, b, c], [a, b, c]], 'one recipient list for the whole round');
    // The split: three equal shares of what was ready; each extra share bought at the route's rate, less nothing (the fake route is exact).
    const acquires = store.operationsFor(launch.id, 'acquire').filter(op => op.expected.purpose === 'basket');
    assert.equal(acquires.length, 2); assert.deepEqual(acquires.map(op => op.expected.op.mint), [tsla, nvda]);
    const share = BigInt(acquires[0].expected.op.inputAmount); assert.equal(acquires[1].expected.op.inputAmount, share.toString());
    assert.equal(cycles[0].amount, (share * 2n).toString(), 'TSLAx bought with the share, all of it paid'); assert.equal(cycles[1].amount, (share * 5n).toString());
    assert.equal(store.basketBalance(launch.id, tsla).paid, share * 2n); assert.equal(store.basketBalance(launch.id, tsla).available, 0n); assert.equal(store.basketBalance(launch.id, tsla).payments, 1);
    const tokens = cycles[0].payouts.map(p => BigInt(p.tokens)), expected = [6n, 3n, 1n].map(w => share * 2n * w / 10n);
    assert.equal(tokens.reduce((x, y) => x + y, 0n), share * 2n, 'every unit bought is paid'); tokens.forEach((t, i) => assert.ok(t >= expected[i] - 1n && t <= expected[i] + 1n, 'by balance weight'));
    assert.ok(BigInt(cycles[2].amount) > 0n && BigInt(cycles[2].amount) <= share + 100n, 'the SOL cycle pays the remaining share less the round’s costs');
    assert.ok(events.includes('Reward round split across the basket') && events.includes('Bought TSLAx for the holders') && events.includes('Basket rewards paid in NVDAx') && events.includes('Holder rewards paid'));
    const last = JSON.parse(store.cursor(launch.id, 'holder-payout-last'));
    assert.equal(last.state, 'completed'); assert.equal(last.basket.length, 3); assert.deepEqual(last.basket.map(o => o.asset), ['TSLAx', 'NVDAx', 'SOL']);
    assert.match(last.reason, /^[0-9.]+ TSLAx to 3 holders; [0-9.]+ NVDAx to 3 holders; [0-9.]+ SOL to 3 holders\.$/);
    // Views: the basket with each extra asset's distributed amount, the cycles with their asset.
    const coin = await h.service.coinView(launch.mint);
    assert.deepEqual(coin.basket.assets.map(x => x.symbol), ['SOL', 'TSLAx', 'NVDAx']); assert.equal(coin.basket.assets[1].distributed, (Number(share * 2n) / 1e6).toString()); assert.equal(coin.basket.assets[1].pending, '0'); assert.equal(coin.basket.stage, null);
    assert.deepEqual(coin.rewards.map(r => [r.asset, r.basketAsset === true]), [['SOL', false], ['NVDAx', true], ['TSLAx', true]]);
    assert.deepEqual(h.service.publicRow(store.launch(launch.id)).basket, { count: 3, symbols: ['SOL', 'TSLAx', 'NVDAx'] });
  } finally { await h.cleanup(); }
});

test('a share whose purchase keeps failing stays in SOL after three attempts, and a share too small to buy is never attempted', async () => {
  const h = harness();
  try {
    const { tsla, nvda } = basketWorld(h), launch = await basketCoin(h, [tsla, nvda]);
    const store = h.service.store(), a = generateWallet().address;
    h.world.holders = holdersOf([[a, 600_000_000_000n]]);
    await snapshots(h);
    h.world.failAcquire = new Set([nvda]); // the route refuses NVDAx every time
    distribute(h, launch, 3_000_000_000n); await pass(h);
    const finished = await drive(h, launch, () => !h.service.payoutRequest(store.launch(launch.id)) && store.rewardCycles(launch.id, 10).length === 2, 60);
    assert.ok(finished, 'the round completes without NVDAx');
    const cycles = store.rewardCycles(launch.id, 10).reverse();
    assert.deepEqual(cycles.map(cy => cy.mint), [tsla, null]);
    const share = BigInt(store.operationsFor(launch.id, 'acquire')[0].expected.op.inputAmount);
    assert.ok(BigInt(cycles[1].amount) > share, 'the SOL cycle carries the NVDAx share too');
    assert.ok(store.events(launch.id, { publicOnly: false, limit: 120 }).some(e => /A basket purchase of NVDAx is waiting/.test(e.title)));
    assert.equal(store.basketBalance(launch.id, nvda).credited, 0n);
    const last = JSON.parse(store.cursor(launch.id, 'holder-payout-last')); assert.deepEqual(last.basket.map(o => o.asset), ['TSLAx', 'SOL']);
    // A round too small to buy anything with: both legs skipped up front, the SOL cycle pays it all.
    h.world.failAcquire = new Set(); h.advance(2 * 3600000);
    distribute(h, launch, 12_000_000n); await pass(h); // 0.0108 SOL to the rewards wallet
    h.world.solUsd = 100000; // worth the trigger at this price
    const small = await drive(h, launch, () => store.rewardCycles(launch.id, 10).length === 3 && !h.service.payoutRequest(store.launch(launch.id)), 40);
    assert.ok(small); assert.equal(store.operationsFor(launch.id, 'acquire').length, 1, 'no purchase for shares under the minimum leg (a refused preparation journals nothing)');
    assert.equal(store.rewardCycles(launch.id, 1)[0].mint, null);
  } finally { await h.cleanup(); }
});
