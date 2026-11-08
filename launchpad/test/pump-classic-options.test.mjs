// Pump.fun Classic launch options (v71.35): Diamond Hands, Earned and Insured,
// driven through the real service against the scripted chain: quotes with
// settings, the streak ledger across payouts, the daily market-cap records and
// their outcomes, the refund pot, the developer sweeps, the deadline and the
// two graduation outcomes. Dependency-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, body, openIntake, pass, fundAndCreate, signature, generateWallet } from './helpers/pump-classic-world.mjs';
import { sol } from '../src/pump-classic/service.mjs';
import { PUMP_CLASSIC_POLICY, PUMP_CLASSIC_POLICY_HASH, PUMP_CLASSIC_POLICY_V5, PUMP_CLASSIC_POLICY_V5_HASH, PUMP_CLASSIC_POLICY_V4_HASH, POLICIES, fundingPlan, solOnlyText } from '../src/pump-classic/policy.mjs';
import { PUMP_CLASSIC_MODES, PUMP_CLASSIC_OPTION_MODES, PUMP_CLASSIC_SOL_ONLY_MODES, PUMP_CLASSIC_CONVERT_MODES, pumpClassicDisclosure } from '../public/pump-classic-catalog.mjs';

const DAY = 86400000, MINUTE = 60000;
const holdersOf = rows => rows.map(([owner, amount]) => ({ owner, amount: String(amount) }));
/** Records one creator-fee distribution of `total` lamports to the coin's recipients through the receipt journal (platform 10%, option wallet 90%). */
function distribute(h, launch, total) {
  const sig = signature(), platform = total / 10n, rest = total - platform;
  const rows = h.world.history.get(launch.protocol_wallet) || [];
  h.world.history.set(launch.protocol_wallet, [...rows, { signature: sig, slot: 90 + rows.length, failed: false }]);
  h.world.distributions.set(sig, { signature: sig, slot: 90 + rows.length, blockTime: 1, failed: false, payer: generateWallet().address, feeLamports: 5000n, anomalies: [], legs: [{ eventIndex: 0, recipient: launch.protocol_wallet, amount: platform, distributed: total, shareBps: 1000 }, { eventIndex: 0, recipient: launch.mode_wallet, amount: rest, distributed: total, shareBps: 9000 }] });
  h.world.lamports.set(launch.mode_wallet, (h.world.lamports.get(launch.mode_wallet) ?? 0n) + rest);
  h.advance(61000); // past the receipt scanner's throttle
  return sig;
}
/** Runs passes five minutes apart until the coin has a frozen or complete reward cycle beyond `before`. */
async function untilCycle(h, launch, before = 0, limit = 16) {
  const store = h.service.store();
  for (let i = 0; i < limit && store.rewardCycles(launch.id, 20).length <= before; i++) { await h.service.process(); h.advance(5 * MINUTE); }
  return store.rewardCycles(launch.id, 20)[0] || null;
}
/** Confirms every open airdrop of the cycle until it is complete. */
async function payOut(h, launch) {
  const store = h.service.store();
  for (let i = 0; i < 12; i++) {
    const open = store.operationsFor(launch.id, 'airdrop').filter(op => ['signed', 'submitted', 'unknown'].includes(op.state));
    for (const op of open) h.world.receipts.set(op.signature, { state: 'confirmed', actualSolCostLamports: '6000' });
    h.advance(11000); await pass(h);
    const cycle = store.rewardCycles(launch.id, 1)[0]; if (cycle?.state === 'complete') return cycle;
  }
  return store.rewardCycles(launch.id, 1)[0];
}
/** Confirms the open sweep of a role and returns it. */
async function settleSweep(h, launch, kind) {
  const store = h.service.store();
  for (let i = 0; i < 6; i++) {
    h.advance(61000); await h.service.process();
    const open = store.operationsFor(launch.id, 'withdraw').filter(op => op.expected?.purpose === 'sweep' && op.expected.role === kind && ['signed', 'submitted', 'unknown'].includes(op.state)).at(-1);
    if (open) { h.world.receipts.set(open.signature, { state: 'confirmed', actualSolCostLamports: '5000', slot: 120 }); h.advance(11000); await pass(h); return store.sweeps({ kind, launchId: launch.id }).find(s => s.operation_id === open.id); }
  }
  return null;
}

test('policy v5 adds the three options without touching v1–v4; the catalogue classifies them', () => {
  assert.equal(PUMP_CLASSIC_POLICY.version, 'pump-classic-policy-v5'); assert.equal(PUMP_CLASSIC_POLICY_HASH, PUMP_CLASSIC_POLICY_V5_HASH);
  assert.ok(POLICIES[PUMP_CLASSIC_POLICY_V4_HASH] && POLICIES[PUMP_CLASSIC_POLICY_V5_HASH] && Object.keys(POLICIES).length === 5);
  assert.deepEqual(PUMP_CLASSIC_POLICY_V5.recipient.diamond_hands, 'rewards'); assert.equal(PUMP_CLASSIC_POLICY_V5.recipient.earned, 'escrow'); assert.equal(PUMP_CLASSIC_POLICY_V5.recipient.insured, 'insured');
  for (const mode of PUMP_CLASSIC_OPTION_MODES) { assert.equal(PUMP_CLASSIC_POLICY_V5.platformShareBps[mode], 1000, mode); assert.equal(PUMP_CLASSIC_POLICY_V5.reserves.modeGasLamports[mode], '5000000', mode); assert.ok(PUMP_CLASSIC_MODES.includes(mode)); }
  assert.ok(PUMP_CLASSIC_SOL_ONLY_MODES.includes('earned') && PUMP_CLASSIC_SOL_ONLY_MODES.includes('insured') && !PUMP_CLASSIC_SOL_ONLY_MODES.includes('diamond_hands'));
  assert.ok(PUMP_CLASSIC_CONVERT_MODES.includes('diamond_hands'));
  assert.equal(solOnlyText(), 'AI Agent, Market Maker, Liquidity Manager, Earned and Insured launches pair with SOL only.');
  for (const mode of ['earned', 'insured']) assert.throws(() => fundingPlan({ mode, quotePair: true }), /pair with SOL only/, mode);
  assert.equal(fundingPlan({ mode: 'diamond_hands', quotePair: true }).modeGasLamports, '8000000', 'Diamond Hands keeps the Holders reserve on a pair');
  assert.match(pumpClassicDisclosure('earned').join(' '), /escrow wallet made for this coin/);
  assert.match(pumpClassicDisclosure('insured').join(' '), /refund pot/);
  assert.match(pumpClassicDisclosure('diamond_hands').join(' '), /streak starts over/);
});

test('quotes carry validated option settings (defaults, ranges, only for option modes) and the review describes them', async () => {
  const h = harness();
  try {
    await openIntake(h);
    const q = async overrides => { const view = await h.service.quote(h.session, { ...body({ devBuySol: '0', ...overrides }), wallet: h.dev }); await h.service.cancel(h.session, { launchId: view.id }); return view; };
    const diamond = await q({ mode: 'diamond_hands', option: { settings: { streakBonusPercent: 20, maxBonusPercent: 60 } } });
    assert.deepEqual(diamond.option, { kind: 'diamond_hands', label: 'Diamond Hands', settings: { streakBonusPercent: 20, maxBonusPercent: 60 }, description: diamond.option.description, phase: 'pending' });
    assert.match(diamond.option.description, /adds 20% to its share, up to 60% \(reached at a streak of 4\)/);
    assert.equal(h.service.store().launch(diamond.id).policy_version, 'pump-classic-policy-v5');
    const earned = await q({ mode: 'earned' });
    assert.deepEqual(earned.option.settings, { probationDays: 30, floorPercent: 50 }, 'absent settings take the defaults');
    assert.match(earned.disclosure.join(' '), /escrow/);
    const insured = await q({ mode: 'insured', option: { coveragePercent: 40, deadlineDays: 14, onGraduation: 1 } });
    assert.deepEqual(insured.option.settings, { coveragePercent: 40, deadlineDays: 14, onGraduation: 1 }, 'settings may be sent flat');
    assert.match(insured.option.description, /paid to holders as a bonus/);
    await assert.rejects(q({ mode: 'earned', option: { settings: { floorPercent: 7 } } }), /Floor must be between 10 and 200/);
    await assert.rejects(q({ mode: 'insured', option: { settings: { onGraduation: 2 } } }), /one of 0, 1/);
    await assert.rejects(q({ mode: 'diamond_hands', option: { settings: { streakBonusPercent: 0, maxBonusPercent: 100 } } }), /set a bonus per payout/);
    await assert.rejects(q({ mode: 'diamond_hands', option: { settings: { streakBonusPercent: 2.5 } } }), /between 0 and 50/);
    await assert.rejects(q({ mode: 'creator', option: { settings: { probationDays: 30 } } }), /Option settings require/);
    assert.equal((await q({ mode: 'creator' })).option, null);
    assert.ok(!JSON.stringify(diamond).includes('secret'));
  } finally { await h.cleanup(); }
});

test('Diamond Hands: a payout skips wallets that sold since their last payout, resets their streak, and grows the others’ shares', async () => {
  const h = harness();
  try {
    await openIntake(h);
    const [a, b, c] = [generateWallet().address, generateWallet().address, generateWallet().address];
    h.world.holders = holdersOf([[a, 1000000000n], [b, 2000000000n], [c, 3000000000n]]);
    const launch = await fundAndCreate(h, body({ mode: 'diamond_hands', devBuySol: '0', option: { settings: { streakBonusPercent: 10, maxBonusPercent: 100 } } }));
    const store = h.service.store();
    assert.deepEqual(store.launch(launch.id).option.state, { phase: 'active', payouts: 0, paidWallets: 0, skippedWallets: 0, lastPayoutAt: null });
    assert.equal(store.events(launch.id).find(e => e.kind === 'option')?.title, 'Diamond Hands rules in force');
    // First payout: nobody has a record, everyone pays out at streak 1 with no bonus.
    store.recordFeeReceipt({ launchId: launch.id, mint: launch.mint, signature: signature(), eventIndex: 0, recipient: launch.mode_wallet, role: 'rewards', amount: 900000000n, distributed: 1000000000n, slot: 1 });
    let cycle = await untilCycle(h, launch); assert.ok(cycle, 'a cycle froze');
    assert.deepEqual(cycle.payouts.map(p => [p.owner, p.streak, p.multiplierBps, p.weight]), [[c, 1, 10000, '3000000000'], [b, 1, 10000, '2000000000'], [a, 1, 10000, '1000000000']]);
    cycle = await payOut(h, launch); assert.equal(cycle.state, 'complete');
    assert.deepEqual([...store.streaks(launch.id)].map(([o, s]) => [o, s.streak, s.balance]).sort(), [[a, 1, 1000000000n], [b, 1, 2000000000n], [c, 1, 3000000000n]].sort());
    // B sells half and A buys more before the second payout: B is skipped and reset, A and C reach streak 2 (+10%).
    h.world.holders = holdersOf([[a, 1500000000n], [b, 1000000000n], [c, 3000000000n]]);
    h.advance(70 * MINUTE); await pass(h, 2);
    store.recordFeeReceipt({ launchId: launch.id, mint: launch.mint, signature: signature(), eventIndex: 0, recipient: launch.mode_wallet, role: 'rewards', amount: 900000000n, distributed: 1000000000n, slot: 2 });
    for (let i = 0; i < 14; i++) { await h.service.process(); h.advance(5 * MINUTE); }
    cycle = store.rewardCycles(launch.id, 5)[0]; assert.notEqual(cycle.state, 'complete', 'a second cycle froze');
    assert.deepEqual(cycle.payouts.map(p => [p.owner, p.streak, p.multiplierBps, p.weight]), [[c, 2, 11000, '3300000000'], [a, 2, 11000, '1650000000']], 'weights carry the streak bonus; the seller is absent');
    const total = BigInt(cycle.amount), toC = BigInt(cycle.payouts[0].lamports), toA = BigInt(cycle.payouts[1].lamports);
    assert.equal(toC + toA, total); assert.ok(toC * 1650000000n - toA * 3300000000n <= 3300000000n, 'pro rata by boosted weight');
    assert.match(store.events(launch.id).find(e => e.title === 'Holder rewards frozen').body, /1 wallet skipped for selling since the last payout, streak reset/);
    assert.deepEqual(store.streaks(launch.id).get(b), { streak: 0, balance: 1000000000n }, 'the seller’s streak reset at the lower balance');
    cycle = await payOut(h, launch); assert.equal(cycle.state, 'complete');
    assert.deepEqual([...store.streaks(launch.id)].map(([o, s]) => [o, s.streak]).sort(), [[a, 2], [b, 0], [c, 2]].sort());
    const view = await h.service.coinView(launch.mint);
    assert.equal(view.option.kind, 'diamond_hands'); assert.equal(view.option.payouts, 2); assert.deepEqual(view.option.lastPayout.paid, 2); assert.equal(view.option.lastPayout.skipped, 1);
    assert.deepEqual(view.option.streaks.map(s => [s.owner, s.streak, s.multiplierBps]), [[a, 2, 11000], [c, 2, 11000]].sort((x, y) => x[0] < y[0] ? -1 : 1)); assert.equal(view.option.holding, 2); assert.equal(view.option.capStreak, 11);
    assert.ok(view.holderRewards && Array.isArray(view.rewards), 'the coin page shows holder rewards like a Holders coin');
    // B holds steady from its reset balance: eligible again at streak 1 on the third payout.
    h.advance(70 * MINUTE); await pass(h, 2);
    store.recordFeeReceipt({ launchId: launch.id, mint: launch.mint, signature: signature(), eventIndex: 0, recipient: launch.mode_wallet, role: 'rewards', amount: 900000000n, distributed: 1000000000n, slot: 3 });
    for (let i = 0; i < 14; i++) { await h.service.process(); h.advance(5 * MINUTE); }
    cycle = store.rewardCycles(launch.id, 5)[0];
    assert.deepEqual(cycle.payouts.map(p => [p.owner, p.streak, p.multiplierBps]), [[c, 3, 12000], [a, 3, 12000], [b, 1, 10000]]);
    assert.equal((await h.service.adminOverview('admin')).launches.find(l => l.id === launch.id).option.kind, 'diamond_hands');
  } finally { await h.cleanup(); }
});

test('Earned: the escrow waits through probation, a day-one baseline sets the floor, passing releases it to the creator', async () => {
  const h = harness();
  try {
    await openIntake(h);
    h.world.holders = holdersOf([[generateWallet().address, 1000000000n]]);
    const launch = await fundAndCreate(h, body({ mode: 'earned', devBuySol: '0', option: { settings: { probationDays: 7, floorPercent: 50 } } }));
    const store = h.service.store(), state = () => store.launch(launch.id).option.state, liveAt = store.launch(launch.id).live_at;
    assert.equal(state().phase, 'probation'); assert.equal(state().probationEndsAt, liveAt + 7 * DAY); assert.equal(state().nextCheckAt, liveAt + DAY); assert.equal(state().baseline, null);
    assert.equal(h.service.roleOf(launch, launch.mode_wallet), 'escrow');
    distribute(h, launch, 2000000000n); h.world.lamports.set(launch.mode_wallet, h.world.lamports.get(launch.mode_wallet) + 10000000n);
    await pass(h, 3);
    assert.equal(store.balance(launch.id, 'escrow').credited, 1800000000n, 'the developer’s 90% lands in the escrow ledger');
    h.advance(61000); await pass(h, 2);
    assert.equal(store.sweeps({ launchId: launch.id }).length, 0, 'nothing leaves the escrow during probation');
    assert.equal(h.service.payoutRequest(store.launch(launch.id)), null, 'holders are not paid during probation');
    // Day one: the baseline (about 27.96 SOL from the fake curve) and the floor.
    h.advance(DAY); await h.service.process();
    assert.ok(BigInt(state().baseline) > 27000000000n && BigInt(state().baseline) < 29000000000n, 'baseline from the curve’s virtual reserves and supply: ' + state().baseline);
    assert.equal(BigInt(state().floor), BigInt(state().baseline) / 2n);
    assert.equal(state().checks.length, 1); assert.equal(store.events(launch.id).find(e => e.title === 'Baseline recorded') !== undefined, true);
    // Days two to six: above the floor, still in probation; the escrow keeps waiting.
    for (let day = 2; day <= 6; day++) { h.advance(DAY); await h.service.process(); assert.equal(state().phase, 'probation', 'day ' + day); }
    assert.equal(state().checks.length, 6);
    // Day seven ends the probation: earned, and the escrow sweeps to the developer.
    h.advance(DAY); await h.service.process();
    assert.equal(state().phase, 'earned'); assert.ok(state().decidedAt >= liveAt + 7 * DAY);
    assert.equal(store.events(launch.id).find(e => e.title === 'Probation passed')?.kind, 'option');
    const sweep = await settleSweep(h, launch, 'escrow');
    assert.ok(sweep, 'the escrow was swept'); assert.equal(sweep.to_wallet, h.dev); assert.equal(sweep.state, 'confirmed'); assert.equal(sweep.amount, '1800000000');
    assert.equal(store.events(launch.id).find(e => e.title === 'Escrow released to the creator')?.body, '1.8 SOL.');
    const view = await h.service.coinView(launch.mint);
    assert.equal(view.option.phase, 'earned'); assert.equal(view.option.releasedSol, '1.8'); assert.equal(view.option.escrowSol, '0'); assert.equal(view.option.baselineSol, sol(state().baseline)); assert.equal(view.option.floorSol, sol(state().floor));
    assert.equal(view.option.checks.length, 7); assert.ok(view.option.checks.every(c => c.ok));
    assert.equal(view.recipients[1].label, 'Creator escrow wallet');
  } finally { await h.cleanup(); }
});

test('Earned: a daily record below the floor fails the coin; the escrow and later fees pay holders and never the creator', async () => {
  const h = harness();
  try {
    await openIntake(h);
    const holders = holdersOf([[generateWallet().address, 1000000000n], [generateWallet().address, 3000000000n]]);
    h.world.holders = holders;
    const launch = await fundAndCreate(h, body({ mode: 'earned', devBuySol: '0', option: { settings: { probationDays: 7, floorPercent: 50 } } }));
    const store = h.service.store(), state = () => store.launch(launch.id).option.state;
    distribute(h, launch, 1000000000n); h.world.lamports.set(launch.mode_wallet, h.world.lamports.get(launch.mode_wallet) + 10000000n);
    await pass(h, 3);
    h.advance(DAY); await h.service.process(); assert.equal(state().phase, 'probation'); const baseline = BigInt(state().baseline);
    // The curve's quote reserves fall to 40% of their value: the market cap is below the floor at the next record.
    const coin = h.world.coins.get(launch.mint); coin.curve = { ...coin.curve, virtual_quote_reserves: coin.curve.virtual_quote_reserves * 2n / 5n };
    h.advance(DAY); await h.service.process();
    assert.equal(state().phase, 'failed'); assert.equal(state().checks.at(-1).ok, false); assert.ok(BigInt(state().checks.at(-1).marketCap) < baseline / 2n);
    assert.equal(store.events(launch.id).find(e => e.title === 'Probation failed')?.kind, 'option');
    assert.ok(h.service.holderPayoutActive(store.launch(launch.id)));
    // The escrow (0.9 SOL ≈ $135) now pays holders through the ordinary holder payout; nothing is ever swept to the developer.
    const cycle = await untilCycle(h, launch); assert.ok(cycle, 'a holder payout froze from the escrow');
    assert.equal(cycle.payouts.length, 2); assert.equal(BigInt(cycle.amount), 900000000n - 2500000n);
    const done = await payOut(h, launch); assert.equal(done.state, 'complete');
    assert.equal(store.balance(launch.id, 'escrow').debited, BigInt(done.amount));
    assert.equal(store.events(launch.id).find(e => e.title === 'Escrow paid to holders')?.kind, 'rewards');
    h.advance(61000); await pass(h, 2); assert.equal(store.sweeps({ kind: 'escrow', launchId: launch.id }).length, 0);
    const view = await h.service.coinView(launch.mint);
    assert.equal(view.option.phase, 'failed'); assert.equal(view.option.paidToHoldersSol, (Number(done.amount) / 1e9).toString()); assert.equal(view.option.releasedSol, '0');
    assert.notEqual((await h.service.queueHolderPayout('admin', { launchId: launch.id, requestId: 'a'.repeat(32) })).state, 'skipped', 'an administrator can pay the holders of a failed Earned coin');
  } finally { await h.cleanup(); }
});

test('Insured: the coverage share builds the pot, the rest sweeps to the creator, and a missed deadline refunds holders at once', async () => {
  const h = harness();
  try {
    await openIntake(h);
    const holders = holdersOf([[generateWallet().address, 1000000000n], [generateWallet().address, 1000000000n]]);
    h.world.holders = holders;
    const launch = await fundAndCreate(h, body({ mode: 'insured', devBuySol: '0', option: { settings: { coveragePercent: 40, deadlineDays: 7, onGraduation: 0 } } }));
    const store = h.service.store(), state = () => store.launch(launch.id).option.state, liveAt = store.launch(launch.id).live_at;
    assert.equal(state().phase, 'active'); assert.equal(state().deadlineAt, liveAt + 7 * DAY); assert.equal(state().pot, '0');
    distribute(h, launch, 1000000000n); h.world.lamports.set(launch.mode_wallet, h.world.lamports.get(launch.mode_wallet) + 10000000n);
    await pass(h, 3);
    assert.equal(store.balance(launch.id, 'insured').credited, 900000000n);
    assert.equal(state().pot, '360000000', '40% of the developer’s 90% is the pot'); assert.equal(state().potCredited, '360000000');
    assert.equal(h.service.insuredDeveloperDue(store.launch(launch.id)), 540000000n);
    const sweep = await settleSweep(h, launch, 'insured');
    assert.ok(sweep, 'the developer’s part sweeps'); assert.equal(sweep.amount, '540000000'); assert.equal(sweep.to_wallet, h.dev);
    assert.equal(h.service.insuredDeveloperDue(store.launch(launch.id)), 0n); assert.equal(state().pot, '360000000', 'the pot never sweeps');
    assert.equal(h.service.payoutRequest(store.launch(launch.id)), null, 'holders are not paid before the deadline');
    // The deadline passes without a graduation: the refund starts at once, whatever the pot is worth.
    h.advance(7 * DAY + 60 * MINUTE); await h.service.process();
    assert.equal(state().phase, 'holders'); assert.equal(store.events(launch.id).find(e => e.title === 'Graduation deadline missed')?.kind, 'option');
    let cycle = await untilCycle(h, launch); assert.ok(cycle, 'the refund froze');
    assert.equal(state().refundDue, null); assert.equal(store.events(launch.id).find(e => e.title === 'Holder refund started')?.body, '0.36 SOL from the refund pot goes to the top holders.');
    assert.equal(BigInt(cycle.amount), 360000000n - 2500000n, 'the pot less half the wallet reserve'); assert.equal(cycle.payouts.length, 2);
    cycle = await payOut(h, launch); assert.equal(cycle.state, 'complete');
    assert.equal(state().pot, '2500000'); assert.equal(state().potPaid, cycle.amount);
    assert.equal(store.events(launch.id).find(e => e.title === 'Holder refund paid')?.kind, 'rewards');
    // After the deadline the coverage share of later fees keeps going to holders and the rest to the creator.
    distribute(h, launch, 1000000000n); await pass(h, 3);
    assert.equal(state().pot, (2500000n + 360000000n).toString()); assert.equal(h.service.insuredDeveloperDue(store.launch(launch.id)), 540000000n);
    const view = await h.service.coinView(launch.mint);
    assert.equal(view.option.phase, 'holders'); assert.equal(view.option.potSol, '0.3625'); assert.equal(view.option.creatorPaidSol, '0.54'); assert.equal(view.option.target, 'developer'); assert.equal(view.option.daysLeft, 0);
    assert.equal(view.recipients[1].label, 'Creator share and refund pot wallet');
  } finally { await h.cleanup(); }
});

test('Insured: a graduation in time releases the pot to the creator, or pays it to holders as a bonus when the creator chose that', async () => {
  for (const onGraduation of [0, 1]) {
    const h = harness();
    try {
      await openIntake(h);
      h.world.holders = holdersOf([[generateWallet().address, 1000000000n]]);
      const launch = await fundAndCreate(h, body({ mode: 'insured', devBuySol: '0', option: { settings: { coveragePercent: 50, deadlineDays: 7, onGraduation } } }));
      const store = h.service.store(), state = () => store.launch(launch.id).option.state;
      distribute(h, launch, 1000000000n); h.world.lamports.set(launch.mode_wallet, h.world.lamports.get(launch.mode_wallet) + 10000000n);
      await pass(h, 3); assert.equal(state().pot, '450000000');
      await settleSweep(h, launch, 'insured'); assert.equal(h.service.insuredDeveloperDue(store.launch(launch.id)), 0n);
      // Graduation: the venue tracker sees the canonical PumpSwap pool.
      const coin = h.world.coins.get(launch.mint); Object.assign(coin, { venue: 'amm', pool: { address: generateWallet().address, virtual_quote_reserves: 0n }, poolBase: 500000000000000n, poolQuote: 60000000000n });
      h.advance(61000); await pass(h, 2);
      assert.equal(store.launch(launch.id).venue_state, 'amm');
      if (onGraduation === 0) {
        assert.equal(state().phase, 'released'); assert.equal(state().pot, '0'); assert.equal(state().potReleased, '450000000');
        assert.equal(h.service.insuredDeveloperDue(store.launch(launch.id)), 450000000n, 'the pot joins the developer’s due');
        const sweep = await settleSweep(h, launch, 'insured'); assert.equal(sweep?.amount, '450000000');
        assert.match(store.events(launch.id).find(e => e.title === 'Graduated in time').body, /released to the creator/);
        distribute(h, launch, 1000000000n); await pass(h, 3); assert.equal(state().pot, '0', 'no coverage is kept after the release');
        assert.equal((await h.service.coinView(launch.mint)).option.phaseLabel, 'Graduated · pot released to the creator');
      } else {
        assert.equal(state().phase, 'bonus'); assert.equal(h.service.payoutRequest(store.launch(launch.id))?.source, 'bonus', 'the bonus payout started in the same pass'); assert.equal(state().refundDue, null, 'and is recorded once');
        let cycle = await untilCycle(h, launch); assert.ok(cycle, 'the bonus froze at once'); assert.equal(BigInt(cycle.amount), 450000000n - 2500000n);
        assert.equal(store.events(launch.id).find(e => e.title === 'Graduation bonus started')?.body, '0.45 SOL from the refund pot goes to the top holders.');
        cycle = await payOut(h, launch); assert.equal(cycle.state, 'complete');
        assert.equal(state().phase, 'released', 'an emptied pot ends the bonus'); assert.equal(state().pot, '0'); assert.equal(state().potReleased, '2500000', 'the dust the payout kept back joins the creator’s share');
        assert.equal(store.events(launch.id).find(e => e.title === 'Graduation bonus paid')?.kind, 'rewards');
        distribute(h, launch, 1000000000n); await pass(h, 3); assert.equal(state().pot, '0', 'no coverage is kept after the bonus');
        assert.equal(h.service.insuredDeveloperDue(store.launch(launch.id)), 900000000n + 2500000n, 'later fees and the dust belong to the creator');
      }
      assert.equal((await h.service.coinView(launch.mint)).option.graduated, true);
    } finally { await h.cleanup(); }
  }
});
