import test from 'node:test';
import assert from 'node:assert/strict';
import { PAYCHECK_POLICY, PAYCHECK_SPLIT_BPS, PAYCHECK_INTERVAL_MS, PAYCHECK_THRESHOLD_CENTS, PAYCHECK_CLAIM_MINIMUM_CENTS, paycheckInput, paycheckLaunch, splitPaycheckPool, paycheckLedger, paycheckLedgerTotal, planPaycheckCycle, paycheckBatchAttribution, recordPaycheckPayout, publicPaycheck } from '../src/launchpad-paycheck.mjs';

const A = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', C = 'Bz3zS37oQ3vm8itxXxsXGJPKyQnHii3xMroaA9hZCwEb';
const CREATOR = '7rvRFpzP5W18yZcNpPNqtWgPTxLaFrnutz5QPxXpyupc', PROTOCOL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const THRESHOLD = 3_000_000n; // $0.50 at ~$166/SOL
const input = { feeMode: 'holders', taxBps: 0, paycheck: { policy: PAYCHECK_POLICY } };
const launch = (paycheck = undefined) => ({ input, ...(paycheck === undefined ? {} : { paycheck }) });
const rows = balances => Object.entries(balances).map(([owner, amount]) => ({ owner, amount: String(amount) }));
const cycle = (ledger, pool, balances, extra = {}) => planPaycheckCycle({ ledger, pool: BigInt(pool), rows: balances ? rows(balances) : null, threshold: THRESHOLD, recipients: { creator: CREATOR, protocol: PROTOCOL }, now: 1700000000000, slot: 5, ...extra });
const total = payouts => payouts.reduce((n, row) => n + BigInt(row.amount), 0n);

test('the policy constants: 15 minutes, $0.50 per wallet, a $1 claim floor, the 50/35/10/5 split', () => {
  assert.equal(PAYCHECK_INTERVAL_MS, 900000); assert.equal(PAYCHECK_THRESHOLD_CENTS, 50n); assert.equal(PAYCHECK_CLAIM_MINIMUM_CENTS, 100n);
  assert.deepEqual(PAYCHECK_SPLIT_BPS, { holders: 5000, burn: 3500, curve: 1000, creator: 500 });
  assert.equal(Object.values(PAYCHECK_SPLIT_BPS).reduce((a, b) => a + b, 0), 10000);
  assert.ok(paycheckInput(input)); assert.ok(paycheckLaunch({ input }));
  assert.equal(paycheckInput({ ...input, gotchi: { id: 'x' } }), false, 'a Gotchi launch is not a Paycheck launch');
  assert.equal(paycheckInput({ feeMode: 'holders', taxBps: 200 }), false); assert.equal(paycheckInput({ feeMode: 'creator', paycheck: { policy: PAYCHECK_POLICY } }), false);
  assert.equal(paycheckInput({ ...input, paycheck: { policy: 'paycheck-v9' } }), false); assert.equal(paycheckLaunch(null), false);
});

test('splitting a pool: creator, burn and Launchpad round down, holders take the remainder, nothing is lost', () => {
  assert.deepEqual(splitPaycheckPool(10000n), { creator: 500n, burn: 3500n, curve: 1000n, holders: 5000n });
  assert.deepEqual(splitPaycheckPool(7n), { creator: 0n, burn: 2n, curve: 0n, holders: 5n });
  assert.deepEqual(splitPaycheckPool('0'), { creator: 0n, burn: 0n, curve: 0n, holders: 0n });
  for (const pool of [1n, 99n, 123456789n, 10n ** 18n]) { const s = splitPaycheckPool(pool); assert.equal(s.creator + s.burn + s.curve + s.holders, pool); }
  assert.throws(() => splitPaycheckPool(-1n), /Invalid Paycheck pool/);
});

test('an empty ledger validates, a corrupt one does not, and only Paycheck launches have one', () => {
  const empty = paycheckLedger(launch());
  assert.equal(empty.version, 1); assert.equal(empty.policy, PAYCHECK_POLICY); assert.deepEqual(empty.holders, {}); assert.equal(empty.carry, '0'); assert.equal(paycheckLedgerTotal(empty), 0n); assert.equal(empty.cycles, 0);
  assert.throws(() => paycheckLedger({ input: { feeMode: 'holders', taxBps: 200 } }), /does not run Paycheck/);
  assert.throws(() => paycheckLedger(launch({ ...empty, version: 2 })), /Unsupported Paycheck ledger version/);
  assert.throws(() => paycheckLedger(launch({ ...empty, holders: { [A]: { accrued: '0', balance: '5' } } })), /positive accrual and balance/);
  assert.throws(() => paycheckLedger(launch({ ...empty, holders: { 'not-an-address': { accrued: '1', balance: '5' } } })), /Invalid Paycheck holder/);
  assert.throws(() => paycheckLedger(launch({ ...empty, split: { creator: '-1', burn: '0', curve: '0' } })), /Invalid Paycheck creator share/);
  assert.throws(() => paycheckLedger(launch({ ...empty, carry: 1 })), /Invalid Paycheck carry/);
  const saved = paycheckLedger(launch({ ...empty, holders: { [A]: { accrued: '10', balance: '5' } }, split: { creator: '1', burn: '2', curve: '3' }, carry: '4', totals: { claimed: '20' } }));
  assert.equal(paycheckLedgerTotal(saved), 20n); assert.equal(saved.totals.claimed, '20'); assert.equal(saved.totals.forfeited, '0'); assert.equal(saved.paid.holders, '0');
});

test('first cycle: the new pool is split and holders accrue pro rata; nothing below $0.50 is paid', () => {
  const plan = cycle(paycheckLedger(launch()), 1_000_000, { [A]: 600, [B]: 400 });
  assert.deepEqual(plan.payouts, []);
  assert.deepEqual(plan.cycle.split, { creator: '50000', burn: '350000', curve: '100000', holders: '500000' });
  assert.equal(plan.ledger.holders[A].accrued, '300000'); assert.equal(plan.ledger.holders[A].balance, '600');
  assert.equal(plan.ledger.holders[B].accrued, '200000'); assert.equal(plan.ledger.holders[B].balance, '400');
  assert.deepEqual(plan.ledger.split, { creator: '50000', burn: '350000', curve: '100000' }); assert.equal(plan.ledger.carry, '0');
  assert.equal(plan.ledger.totals.claimed, '1000000'); assert.equal(plan.ledger.totals.holders, '500000'); assert.equal(plan.ledger.totals.burn, '350000'); assert.equal(plan.ledger.totals.forfeited, '0');
  assert.equal(plan.ledger.cycles, 1); assert.equal(plan.ledger.lastAllocationAt, 1700000000000); assert.equal(plan.ledger.lastSlot, 5); assert.equal(plan.ledger.lastSnapshotWallets, 2);
  assert.equal(plan.attribution.creatorUnits, '0'); assert.equal(plan.attribution.protocolUnits, '0'); assert.equal(plan.attribution.holderUnits, '0'); assert.equal(plan.attribution.walletsPaid, 0);
  assert.equal(plan.cycle.walletsAccruing, 2); assert.equal(plan.cycle.eligibleBalance, '1000'); assert.equal(plan.cycle.accruedUnits, '500000');
  assert.equal(paycheckLedgerTotal(plan.ledger), 1_000_000n, 'every unit of the pool is owed to someone');
});

test('roll-over: accruals carry across cycles and a wallet is paid the cycle it reaches the threshold; the protocol share pays first', () => {
  let ledger = paycheckLedger(launch()), paid = [];
  for (let i = 1; i <= 5; i++) { const plan = cycle(ledger, 2_000_000, { [A]: 600, [B]: 400 }); ledger = plan.ledger; paid.push({ i, payouts: plan.payouts, attribution: plan.attribution }); assert.equal(2_000_000n + paycheckLedgerTotal(paid.length > 1 ? paid.at(-2).ledgerAfter : paycheckLedger(launch())) , paycheckLedgerTotal(ledger) + total(plan.payouts), 'conserved in cycle ' + i); paid.at(-1).ledgerAfter = ledger; }
  // Cycles 1–3: nobody is at 3,000,000 yet (A accrues 600,000 a cycle, B 400,000; creator 100,000; protocol 900,000).
  for (const i of [0, 1, 2]) assert.deepEqual(paid[i].payouts, [], 'cycle ' + (i + 1));
  // Cycle 4: the protocol share reaches 3,600,000 (Launchpad 800,000 + burn 2,800,000) and is paid in one row.
  assert.deepEqual(paid[3].payouts, [{ owner: PROTOCOL, amount: '3600000' }]);
  assert.equal(paid[3].attribution.protocolUnits, '3600000'); assert.equal(paid[3].attribution.curveUnits, '800000'); assert.equal(paid[3].attribution.burnUnits, '2800000'); assert.equal(paid[3].attribution.creatorUnits, '0'); assert.equal(paid[3].attribution.holderUnits, '0');
  // Cycle 5: A reaches exactly 3,000,000 and is paid; B (2,000,000) and the creator (500,000) keep accruing.
  assert.deepEqual(paid[4].payouts, [{ owner: A, amount: '3000000' }]);
  assert.equal(paid[4].attribution.holderUnits, '3000000'); assert.equal(paid[4].attribution.walletsPaid, 1);
  assert.equal(ledger.holders[A], undefined, 'a paid wallet starts from zero'); assert.equal(ledger.holders[B].accrued, '2000000');
  assert.deepEqual(ledger.split, { creator: '500000', burn: '700000', curve: '200000' }, 'cycle 5 started the next protocol share'); assert.equal(ledger.cycles, 5);
  assert.equal(ledger.totals.claimed, '10000000'); assert.equal(ledger.totals.holders, '5000000'); assert.equal(ledger.totals.creator, '500000'); assert.equal(ledger.totals.burn, '3500000'); assert.equal(ledger.totals.curve, '1000000');
});

test('forfeiture: a wallet that holds less than at its last accrual loses its pending amount to the others and starts over', () => {
  let { ledger } = cycle(paycheckLedger(launch()), 1_000_000, { [A]: 600, [B]: 400 });
  // B sells a quarter. Its 200,000 accrual is redistributed with this cycle's 500,000 holder share: A 600/900, B 300/900.
  const plan = cycle(ledger, 1_000_000, { [A]: 600, [B]: 300 });
  assert.equal(plan.cycle.forfeitedUnits, '200000'); assert.equal(plan.ledger.totals.forfeited, '200000');
  assert.equal(plan.ledger.holders[A].accrued, String(300000 + 700000 * 600 / 900 | 0)); // 300,000 + 466,666
  assert.equal(plan.ledger.holders[A].accrued, '766666');
  assert.equal(plan.ledger.holders[B].accrued, '233333', 'B accrues afresh on its new balance'); assert.equal(plan.ledger.holders[B].balance, '300');
  assert.equal(plan.ledger.carry, '1', 'rounding dust waits in the carry');
  assert.equal(paycheckLedgerTotal(plan.ledger), 2_000_000n);
  // A wallet that left entirely forfeits too and has no entry afterwards.
  const gone = cycle(plan.ledger, 0, { [A]: 600 });
  assert.equal(gone.cycle.forfeitedUnits, '233333'); assert.equal(gone.ledger.holders[B], undefined);
  assert.equal(gone.ledger.holders[A].accrued, String(766666 + 233333 + 1)); assert.equal(gone.ledger.carry, '0');
  assert.deepEqual(gone.payouts, []); assert.equal(paycheckLedgerTotal(gone.ledger), 2_000_000n);
  // Buying more never forfeits; the balance is simply measured anew.
  const more = cycle(gone.ledger, 0, { [A]: 900 });
  assert.equal(more.cycle.forfeitedUnits, '0'); assert.equal(more.ledger.holders[A].balance, '900'); assert.equal(more.ledger.holders[A].accrued, '1000000');
});

test('the creator who also holds the coin gets one merged row; the protocol wallet never accrues as a holder', () => {
  // Each 20,000,000 cycle: holders 10,000,000 (5,000,000 each, paid every cycle), creator share 1,000,000 (paid when it reaches 3,000,000), protocol 9,000,000.
  let ledger = paycheckLedger(launch());
  for (let i = 0; i < 2; i++) ledger = cycle(ledger, 20_000_000, { [CREATOR]: 500, [A]: 500, [PROTOCOL]: 1000 }).ledger;
  assert.equal(ledger.holders[PROTOCOL], undefined); assert.equal(ledger.lastSnapshotWallets, 2); assert.equal(ledger.split.creator, '2000000');
  const plan = cycle(ledger, 20_000_000, { [CREATOR]: 500, [A]: 500, [PROTOCOL]: 1000 });
  const creatorRow = plan.payouts.find(row => row.owner === CREATOR), holderRow = plan.payouts.find(row => row.owner === A);
  assert.equal(creatorRow.amount, '8000000', 'the creator split (3,000,000) and the holder share (5,000,000) in one row');
  assert.equal(holderRow.amount, '5000000'); assert.equal(plan.payouts.length, 3);
  assert.equal(plan.payouts.find(row => row.owner === PROTOCOL).amount, '9000000');
  assert.equal(plan.attribution.creatorUnits, '3000000'); assert.equal(plan.attribution.holderUnits, '10000000'); assert.equal(plan.attribution.protocolUnits, '9000000'); assert.equal(plan.attribution.walletsPaid, 2);
  assert.equal(plan.ledger.split.creator, '0'); assert.equal(plan.ledger.holders[PROTOCOL], undefined);
  const next = cycle(plan.ledger, 20_000_000, { [CREATOR]: 500, [A]: 500 });
  assert.equal(next.payouts.find(row => row.owner === CREATOR).amount, '5000000', 'holder share only while the creator split (1,000,000) waits'); assert.equal(next.attribution.creatorUnits, '0'); assert.equal(next.attribution.holderUnits, '10000000');
  assert.throws(() => planPaycheckCycle({ ledger: paycheckLedger(launch()), pool: 0n, rows: [], threshold: THRESHOLD, recipients: { creator: A, protocol: A } }), /must differ/);
  assert.throws(() => planPaycheckCycle({ ledger: paycheckLedger(launch()), pool: 0n, rows: [], threshold: THRESHOLD, recipients: { creator: 'nope', protocol: A } }), /Invalid Paycheck creator wallet/);
});

test('an owed native debt flushes a small accrual with it; an operator sweep pays everything pending', () => {
  const { ledger } = cycle(paycheckLedger(launch()), 1_000_000, { [A]: 600, [B]: 400 });
  const owed = cycle(ledger, 0, { [A]: 600, [B]: 400 }, { owedOwners: [B] });
  assert.deepEqual(owed.payouts, [{ owner: B, amount: '200000' }]); assert.equal(owed.ledger.holders[B], undefined); assert.equal(owed.ledger.holders[A].accrued, '300000');
  const sweep = cycle(ledger, 0, { [A]: 600, [B]: 400 }, { override: true });
  assert.deepEqual(sweep.payouts, [{ owner: A, amount: '300000' }, { owner: PROTOCOL, amount: '450000' }, { owner: CREATOR, amount: '50000' }, { owner: B, amount: '200000' }].sort((x, y) => x.owner.localeCompare(y.owner)));
  assert.deepEqual(sweep.ledger.holders, {}); assert.deepEqual(sweep.ledger.split, { creator: '0', burn: '0', curve: '0' }); assert.equal(paycheckLedgerTotal(sweep.ledger), 0n);
  assert.equal(sweep.attribution.creatorUnits, '50000'); assert.equal(sweep.attribution.protocolUnits, '450000'); assert.equal(sweep.attribution.curveUnits, '100000'); assert.equal(sweep.attribution.burnUnits, '350000'); assert.equal(sweep.attribution.holderUnits, '500000');
});

test('a cycle without a snapshot (nothing new was claimed) only pays shares that are already due', () => {
  let { ledger } = cycle(paycheckLedger(launch()), 8_000_000, { [A]: 1 });
  // A accrued 4,000,000 and was paid at once; the protocol share (3,600,000) too; the creator share (400,000) waits.
  assert.deepEqual(ledger.holders, {}); assert.deepEqual(ledger.split, { creator: '400000', burn: '0', curve: '0' });
  const quiet = cycle(ledger, 0, null);
  assert.deepEqual(quiet.payouts, []); assert.equal(quiet.ledger.cycles, 2); assert.equal(quiet.cycle.walletsInSnapshot, null); assert.equal(quiet.ledger.split.creator, '400000');
  assert.equal(paycheckLedgerTotal(quiet.ledger), 400000n);
  // Dust: a holder share that does not divide stays in the carry and joins the next cycle.
  const dust = cycle(paycheckLedger(launch()), 2000, { [A]: 3, [B]: 3, [C]: 3 });
  assert.equal(dust.cycle.split.holders, '1000'); assert.equal(dust.ledger.carry, '1'); assert.equal(dust.ledger.holders[A].accrued, '333');
  const later = cycle(dust.ledger, 0, { [A]: 3, [B]: 3, [C]: 3 });
  assert.equal(later.ledger.carry, '1', 'one unit cannot be split three ways'); assert.equal(paycheckLedgerTotal(later.ledger), 2000n);
  const resolved = cycle(later.ledger, 0, { [A]: 3 });
  assert.equal(resolved.ledger.carry, '0'); assert.equal(resolved.ledger.holders[A].accrued, '1000', 'the forfeited shares and the carry go to the remaining holder');
});

test('batch attribution and paid totals follow the rows actually in a batch', () => {
  const attribution = { policy: PAYCHECK_POLICY, creatorRecipient: CREATOR, protocolRecipient: PROTOCOL, creatorUnits: '3000000', protocolUnits: '4500000', curveUnits: '1000000', burnUnits: '3500000', holderUnits: '9000000', walletsPaid: 3 };
  const first = paycheckBatchAttribution(attribution, [{ owner: A, amount: '3000000' }, { owner: B, amount: '3000000' }, { owner: CREATOR, amount: '6000000' }]);
  assert.deepEqual(first, { policy: PAYCHECK_POLICY, creatorRecipient: CREATOR, protocolRecipient: PROTOCOL, creatorUnits: '3000000', protocolUnits: '0', curveUnits: '0', burnUnits: '0', holderUnits: '9000000' });
  const second = paycheckBatchAttribution(attribution, [{ owner: PROTOCOL, amount: '4500000' }]);
  assert.equal(second.protocolUnits, '4500000'); assert.equal(second.curveUnits, '1000000'); assert.equal(second.burnUnits, '3500000'); assert.equal(second.holderUnits, '0'); assert.equal(second.creatorUnits, '0');
  assert.throws(() => paycheckBatchAttribution(attribution, [{ owner: CREATOR, amount: '1000' }]), /exceeds its payout/);
  assert.throws(() => paycheckBatchAttribution({ policy: 'other' }, []), /Missing Paycheck cycle attribution/);
  let ledger = paycheckLedger(launch());
  ledger = recordPaycheckPayout(ledger, first); ledger = recordPaycheckPayout(ledger, second);
  assert.deepEqual(ledger.paid, { holders: '9000000', creator: '3000000', protocol: '4500000' });
});

test('the public view reports the policy and the ledger in display units', () => {
  assert.equal(publicPaycheck({ input: { feeMode: 'creator' } }), null);
  const fresh = publicPaycheck(launch(), { now: 7 });
  assert.equal(fresh.intervalMinutes, 15); assert.equal(fresh.thresholdUsd, 0.5); assert.equal(fresh.claimMinimumUsd, 1); assert.deepEqual(fresh.split, { holders: 5000, burn: 3500, curve: 1000, creator: 500 });
  assert.equal(fresh.claimed, '0'); assert.equal(fresh.accruingWallets, 0); assert.equal(fresh.cycles, 0); assert.equal(fresh.asOf, 7);
  let { ledger } = cycle(paycheckLedger(launch()), 2_000_000_000, { [A]: 600, [B]: 400 });
  ledger = recordPaycheckPayout(ledger, { policy: PAYCHECK_POLICY, creatorUnits: '100000000', protocolUnits: '900000000', holderUnits: '0' });
  const view = publicPaycheck(launch(ledger));
  assert.equal(view.claimed, '2'); assert.equal(view.allocatedToHolders, '1'); assert.equal(view.allocatedToBurn, '0.7'); assert.equal(view.allocatedToCurve, '0.2'); assert.equal(view.allocatedToCreator, '0.1');
  assert.equal(view.paidToCreator, '0.1'); assert.equal(view.paidToProtocol, '0.9'); assert.equal(view.paidToHolders, '0'); assert.equal(view.accruing, '0', 'both holders were paid at once'); assert.equal(view.pendingCreator, '0'); assert.equal(view.cycles, 1); assert.equal(view.lastSnapshotWallets, 2);
  assert.deepEqual(publicPaycheck(launch({ version: 3 })), { policy: PAYCHECK_POLICY, accountingUnavailable: true });
});
