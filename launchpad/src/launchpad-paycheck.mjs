import { weightedRewards, requireValue as ok, displayUnits } from '../public/launchpad-model.mjs';
import { PAYCHECK_POLICY, PAYCHECK_INTERVAL_MS, PAYCHECK_THRESHOLD_CENTS, PAYCHECK_CLAIM_MINIMUM_CENTS, PAYCHECK_SPLIT_BPS, paycheckInput } from '../public/paycheck-policy.mjs';

// Paycheck (v71.44): a Raydium launch mode that pays the coin's creator fee out every
// fifteen minutes. The 0.50% LaunchLab creator fee (the most Raydium allows; there is
// no transfer tax) is claimed into the launch's managed reward wallet and split:
//   holders 50% · $LAUNCHPAD buy-and-burn 35% · Launchpad 10% · creator 5%.
// Holders accrue their share of every cycle pro rata to their balance in the snapshot;
// a wallet is paid in SOL once its accrued share reaches $0.50, smaller amounts roll
// over, and a wallet whose balance fell since its last accrual forfeits what it had
// accrued back to the other holders. Everything here is arithmetic on a saved ledger:
// the engine (src/launchpad.mjs) reads the chain, calls planPaycheckCycle and signs.
export { PAYCHECK_POLICY, PAYCHECK_INTERVAL_MS, PAYCHECK_THRESHOLD_CENTS, PAYCHECK_CLAIM_MINIMUM_CENTS, PAYCHECK_SPLIT_BPS, paycheckInput };
export const PAYCHECK_LEDGER_VERSION = 1;
const MAX_UNITS = 18446744073709551615n;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const uint = (value, label = 'Paycheck ledger amount') => { ok(typeof value === 'string' && /^(?:0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= MAX_UNITS, `Invalid ${label}.`); return BigInt(value); };
const address = (value, label) => { ok(typeof value === 'string' && ADDRESS.test(value), `Invalid ${label}.`); return value; };
const sum = values => values.reduce((total, value) => total + value, 0n);
const stamp = value => Number.isSafeInteger(value) && value > 0 ? value : null;

export const paycheckLaunch = launch => paycheckInput(launch?.input);

/** The split of newly claimed fee units. Creator, burn and Launchpad shares round down; holders take the rest, so nothing is lost. */
export function splitPaycheckPool(pool) {
  const total = BigInt(pool); ok(total >= 0n, 'Invalid Paycheck pool.');
  const creator = total * BigInt(PAYCHECK_SPLIT_BPS.creator) / 10000n, burn = total * BigInt(PAYCHECK_SPLIT_BPS.burn) / 10000n, curve = total * BigInt(PAYCHECK_SPLIT_BPS.curve) / 10000n;
  return { creator, burn, curve, holders: total - creator - burn - curve };
}

function emptyLedger() {
  return { version: PAYCHECK_LEDGER_VERSION, policy: PAYCHECK_POLICY, holders: {}, split: { creator: '0', burn: '0', curve: '0' }, carry: '0',
    totals: { claimed: '0', holders: '0', creator: '0', burn: '0', curve: '0', forfeited: '0' }, paid: { holders: '0', creator: '0', protocol: '0' },
    cycles: 0, lastAllocationAt: null, lastSlot: null, lastSnapshotWallets: 0 };
}

/** The saved ledger of a Paycheck launch, validated. A launch without one has paid nothing yet. */
export function paycheckLedger(launch) {
  ok(paycheckLaunch(launch), 'This launch does not run Paycheck rewards.');
  const value = launch.paycheck;
  if (!value) return emptyLedger();
  ok(value.version === PAYCHECK_LEDGER_VERSION && value.policy === PAYCHECK_POLICY, 'Unsupported Paycheck ledger version.');
  ok(value.holders && typeof value.holders === 'object' && !Array.isArray(value.holders), 'Invalid Paycheck holder ledger.');
  const holders = {};
  for (const [owner, entry] of Object.entries(value.holders)) {
    address(owner, 'Paycheck holder');
    const accrued = uint(entry?.accrued, 'Paycheck accrued amount'), balance = uint(entry?.balance, 'Paycheck holder balance');
    ok(accrued > 0n && balance > 0n, 'Paycheck ledger entries must hold a positive accrual and balance.');
    holders[owner] = { accrued: accrued.toString(), balance: balance.toString() };
  }
  const split = { creator: uint(value.split?.creator, 'Paycheck creator share').toString(), burn: uint(value.split?.burn, 'Paycheck burn share').toString(), curve: uint(value.split?.curve, 'Paycheck Launchpad share').toString() };
  const totals = {}, paid = {};
  for (const key of Object.keys(emptyLedger().totals)) totals[key] = uint(value.totals?.[key] ?? '0', 'Paycheck total').toString();
  for (const key of Object.keys(emptyLedger().paid)) paid[key] = uint(value.paid?.[key] ?? '0', 'Paycheck paid total').toString();
  const cycles = Number.isSafeInteger(value.cycles) && value.cycles >= 0 ? value.cycles : 0;
  return { version: PAYCHECK_LEDGER_VERSION, policy: PAYCHECK_POLICY, holders, split, carry: uint(value.carry ?? '0', 'Paycheck carry').toString(), totals, paid, cycles, lastAllocationAt: stamp(value.lastAllocationAt), lastSlot: stamp(value.lastSlot), lastSnapshotWallets: Number.isSafeInteger(value.lastSnapshotWallets) && value.lastSnapshotWallets >= 0 ? value.lastSnapshotWallets : 0 };
}

/** Units the ledger still owes someone (accrued holder shares, unpaid creator/protocol shares and the holder carry). They sit inside credits.quote. */
export function paycheckLedgerTotal(ledger) {
  return sum(Object.values(ledger.holders).map(entry => BigInt(entry.accrued))) + BigInt(ledger.split.creator) + BigInt(ledger.split.burn) + BigInt(ledger.split.curve) + BigInt(ledger.carry);
}

// Balances per owner, every token account of an owner added together (the same rule weightedRewards uses).
function balancesByOwner(rows) {
  const balances = new Map();
  for (const row of rows || []) { const n = BigInt(row.amount); ok(n >= 0n, 'Negative holder balance.'); if (n > 0n) balances.set(address(row.owner, 'holder address'), (balances.get(row.owner) || 0n) + n); }
  return balances;
}

/**
 * One Paycheck cycle on a saved ledger.
 *   pool       newly claimed fee units not yet in the ledger (credits.quote − owed native debts − paycheckLedgerTotal)
 *   rows       the holder snapshot ({owner, amount} per token account) taken this cycle, or null when the pool is empty
 *   threshold  the $0.50 payout minimum in quote units (0n or override pays every accrued amount)
 *   owedOwners holders with an owed native debt from an earlier payout: their accrual is paid with it whatever its size
 * Returns the next ledger, the payout rows (one per owner, sorted by address, nothing below the threshold) and the
 * attribution of those rows for receipts: how many units of the cycle's rows are the creator share, the protocol
 * share (Launchpad + burn) and holder rewards. The sums are conserved: pool + old ledger == new ledger + payouts.
 */
export function planPaycheckCycle({ ledger, pool, rows = null, threshold, recipients, owedOwners = [], override = false, now = Date.now(), slot = null }) {
  const before = paycheckLedgerTotal(ledger), fresh = BigInt(pool), minimum = override ? 1n : BigInt(threshold);
  ok(fresh >= 0n && minimum > 0n, 'Invalid Paycheck cycle budget.');
  const creatorRecipient = address(recipients?.creator, 'Paycheck creator wallet'), protocolRecipient = address(recipients?.protocol, 'Paycheck protocol wallet');
  ok(creatorRecipient !== protocolRecipient, 'The Paycheck creator and protocol wallets must differ.');
  const next = structuredClone(ledger), owed = new Set(owedOwners), split = splitPaycheckPool(fresh);
  let forfeited = 0n, accruedUnits = 0n, carry = BigInt(next.carry), eligibleBalance = '0', remainder = 0n;
  // New money: the creator, burn and Launchpad shares wait in the ledger until they are worth paying; the holder share joins the carry.
  for (const key of ['creator', 'burn', 'curve']) next.split[key] = (BigInt(next.split[key]) + split[key]).toString();
  carry += split.holders;
  if (fresh > 0n) { next.totals.claimed = (BigInt(next.totals.claimed) + fresh).toString(); for (const key of ['holders', 'creator', 'burn', 'curve']) next.totals[key] = (BigInt(next.totals[key]) + split[key]).toString(); }
  if (rows) {
    const balances = balancesByOwner(rows); balances.delete(protocolRecipient);
    // Forfeiture: a wallet that holds less than when it last accrued (it sold or moved tokens) loses its pending accrual to the others.
    for (const [owner, entry] of Object.entries(next.holders)) {
      const current = balances.get(owner) || 0n;
      if (current < BigInt(entry.balance)) { forfeited += BigInt(entry.accrued); delete next.holders[owner]; }
    }
    // Accrual: the holder share of this cycle, the carry and the forfeited amounts, pro rata to the snapshot balances. Dust stays in the carry.
    const distribution = weightedRewards(carry + forfeited, [...balances].map(([owner, amount]) => ({ owner, amount: amount.toString() })), 1n);
    eligibleBalance = distribution.eligibleBalance; remainder = BigInt(distribution.remainder);
    for (const { owner, amount } of distribution.payouts) {
      const entry = next.holders[owner] || { accrued: '0', balance: '0' };
      entry.accrued = (BigInt(entry.accrued) + BigInt(amount)).toString(); entry.balance = balances.get(owner).toString(); next.holders[owner] = entry; accruedUnits += BigInt(amount);
    }
    // Every holder in the snapshot carries its current balance forward (a wallet that bought more keeps its accrual, measured anew).
    for (const [owner, entry] of Object.entries(next.holders)) if (balances.has(owner)) entry.balance = balances.get(owner).toString();
    carry = remainder;
    next.lastSnapshotWallets = balances.size;
  }
  next.carry = carry.toString();
  // Payout rows: accrued shares at the threshold (or owed a native debt, or on an operator sweep), then the creator and protocol shares.
  const payouts = new Map(); let holderUnits = 0n, walletsPaid = 0;
  for (const [owner, entry] of Object.entries(next.holders)) {
    const accrued = BigInt(entry.accrued);
    if (accrued >= minimum || owed.has(owner)) { payouts.set(owner, (payouts.get(owner) || 0n) + accrued); holderUnits += accrued; walletsPaid++; delete next.holders[owner]; }
  }
  const creatorUnits = BigInt(next.split.creator), curve = BigInt(next.split.curve), burn = BigInt(next.split.burn), protocolUnits = curve + burn;
  const payCreator = creatorUnits > 0n && (creatorUnits >= minimum || owed.has(creatorRecipient)), payProtocol = protocolUnits > 0n && (protocolUnits >= minimum || owed.has(protocolRecipient));
  if (payCreator) { payouts.set(creatorRecipient, (payouts.get(creatorRecipient) || 0n) + creatorUnits); next.split.creator = '0'; }
  if (payProtocol) { payouts.set(protocolRecipient, (payouts.get(protocolRecipient) || 0n) + protocolUnits); next.split.curve = '0'; next.split.burn = '0'; }
  next.totals.forfeited = (BigInt(next.totals.forfeited) + forfeited).toString();
  next.cycles += 1; next.lastAllocationAt = now; if (stamp(slot)) next.lastSlot = slot;
  const rowsOut = [...payouts].sort(([a], [b]) => a.localeCompare(b)).map(([owner, amount]) => ({ owner, amount: amount.toString() }));
  const paid = sum(rowsOut.map(row => BigInt(row.amount))), after = paycheckLedgerTotal(next);
  ok(fresh + before === after + paid, 'Paycheck cycle accounting does not balance.');
  ok(Object.values(next.holders).every(entry => BigInt(entry.accrued) > 0n && BigInt(entry.balance) > 0n), 'Paycheck ledger entries must hold a positive accrual and balance.');
  return {
    ledger: next, payouts: rowsOut,
    attribution: { policy: PAYCHECK_POLICY, creatorRecipient, protocolRecipient, creatorUnits: (payCreator ? creatorUnits : 0n).toString(), protocolUnits: (payProtocol ? protocolUnits : 0n).toString(), curveUnits: (payProtocol ? curve : 0n).toString(), burnUnits: (payProtocol ? burn : 0n).toString(), holderUnits: holderUnits.toString(), walletsPaid },
    cycle: { claimedUnits: fresh.toString(), split: Object.fromEntries(Object.entries(split).map(([key, value]) => [key, value.toString()])), forfeitedUnits: forfeited.toString(), accruedUnits: accruedUnits.toString(), carryUnits: carry.toString(), eligibleBalance, walletsAccruing: Object.keys(next.holders).length, walletsInSnapshot: rows ? next.lastSnapshotWallets : null },
  };
}

/** The share of one payout batch that is creator, protocol and holder money, for the batch's receipt. Rows are merged per owner, so the creator's or the treasury's row may also carry holder units. */
export function paycheckBatchAttribution(attribution, batch) {
  ok(attribution?.policy === PAYCHECK_POLICY, 'Missing Paycheck cycle attribution.');
  const total = sum(batch.map(row => uint(row.amount, 'payout amount'))), owners = new Set(batch.map(row => row.owner));
  const creatorUnits = owners.has(attribution.creatorRecipient) ? uint(attribution.creatorUnits, 'creator units') : 0n, protocolUnits = owners.has(attribution.protocolRecipient) ? uint(attribution.protocolUnits, 'protocol units') : 0n;
  const curveUnits = protocolUnits ? uint(attribution.curveUnits, 'Launchpad units') : 0n, burnUnits = protocolUnits ? uint(attribution.burnUnits, 'burn units') : 0n;
  ok(creatorUnits + protocolUnits <= total && curveUnits + burnUnits === protocolUnits, 'Paycheck batch attribution exceeds its payout.');
  return { policy: PAYCHECK_POLICY, creatorRecipient: attribution.creatorRecipient, protocolRecipient: attribution.protocolRecipient, creatorUnits: creatorUnits.toString(), protocolUnits: protocolUnits.toString(), curveUnits: curveUnits.toString(), burnUnits: burnUnits.toString(), holderUnits: (total - creatorUnits - protocolUnits).toString() };
}

/** Adds a confirmed batch's attribution to the ledger's paid totals. */
export function recordPaycheckPayout(ledger, attribution) {
  ok(attribution?.policy === PAYCHECK_POLICY, 'Missing Paycheck payout attribution.');
  const next = structuredClone(ledger);
  next.paid.holders = (BigInt(next.paid.holders) + uint(attribution.holderUnits, 'holder units')).toString();
  next.paid.creator = (BigInt(next.paid.creator) + uint(attribution.creatorUnits, 'creator units')).toString();
  next.paid.protocol = (BigInt(next.paid.protocol) + uint(attribution.protocolUnits, 'protocol units')).toString();
  return next;
}

/** The public view of a Paycheck launch's ledger (amounts in the quote asset's display units). */
export function publicPaycheck(launch, { decimals = 9, now = Date.now() } = {}) {
  if (!paycheckLaunch(launch)) return null;
  let ledger; try { ledger = paycheckLedger(launch); } catch { return { policy: PAYCHECK_POLICY, accountingUnavailable: true }; }
  const accrued = sum(Object.values(ledger.holders).map(entry => BigInt(entry.accrued)));
  const display = value => displayUnits(value, decimals);
  return {
    policy: PAYCHECK_POLICY, intervalMinutes: PAYCHECK_INTERVAL_MS / 60000, thresholdUsd: Number(PAYCHECK_THRESHOLD_CENTS) / 100, claimMinimumUsd: Number(PAYCHECK_CLAIM_MINIMUM_CENTS) / 100,
    split: { ...PAYCHECK_SPLIT_BPS },
    claimed: display(ledger.totals.claimed), paidToHolders: display(ledger.paid.holders), paidToCreator: display(ledger.paid.creator), paidToProtocol: display(ledger.paid.protocol),
    allocatedToHolders: display(ledger.totals.holders), allocatedToBurn: display(ledger.totals.burn), allocatedToCurve: display(ledger.totals.curve), allocatedToCreator: display(ledger.totals.creator),
    forfeited: display(ledger.totals.forfeited), accruing: display(accrued), accruingWallets: Object.keys(ledger.holders).length, pendingCreator: display(ledger.split.creator), pendingProtocol: display(BigInt(ledger.split.curve) + BigInt(ledger.split.burn)), carry: display(ledger.carry),
    cycles: ledger.cycles, lastAllocationAt: ledger.lastAllocationAt, lastSnapshotWallets: ledger.lastSnapshotWallets, asOf: now,
  };
}
