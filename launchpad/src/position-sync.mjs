import { invariant } from './core.mjs';

const live = lot => lot.mode === undefined || lot.mode === 'live';
const matches = (lot, wallet, mint) => (wallet === undefined || lot.wallet === wallet) && (mint === undefined || lot.mint === mint);
const integerAmount = value => {
  invariant(typeof value === 'bigint' || (typeof value === 'string' && /^\d+$/.test(value)), 'Tracked position amount is invalid.');
  const amount = BigInt(value);
  invariant(amount >= 0n, 'Tracked position amount is invalid.');
  return amount;
};
const knownSlot = value => {
  if (value === undefined || value === null) return 0;
  invariant(Number.isSafeInteger(value) && value >= 0, 'Tracked position slot is invalid.');
  return value;
};

// Capture only the requested inventory, without allowing array order to turn a
// harmless ledger reorder into a different snapshot. The caller compares this
// before committing an asynchronous balance read.
export function inventoryFingerprint(lots, wallet, mint) {
  invariant(Array.isArray(lots), 'Position ledger is invalid.');
  const rows = lots.filter(lot => matches(lot, wallet, mint)).map(lot => ({
    id: lot.id, wallet: lot.wallet, mint: lot.mint, mode: lot.mode ?? 'live',
    original: String(lot.original), remaining: String(lot.remaining),
    confirmedSlot: lot.confirmedSlot ?? null, lastBalanceSlot: lot.lastBalanceSlot ?? null,
  }));
  rows.sort((a, b) => String(a.id).localeCompare(String(b.id)) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify(rows);
}

// A complete, confirmed wallet/mint snapshot may reduce attributed holdings.
// It never imports deposits, creates a trade, or changes historical acquisition
// data. All checks and exact allocations finish before any ledger mutation.
export function reconcileTrackedLots(ledger, { wallet, mint, balance, slot, source }) {
  const data = ledger?.data;
  invariant(data && Array.isArray(data.lots) && Array.isArray(data.pending), 'Position ledger is invalid.');
  invariant(typeof wallet === 'string' && wallet.length > 0 && typeof mint === 'string' && mint.length > 0, 'Choose a wallet and token to synchronize.');
  invariant(typeof balance === 'bigint' && balance >= 0n, 'Wallet token balance is invalid.');
  invariant(Number.isSafeInteger(slot) && slot >= 0, 'Wallet balance snapshot has an invalid slot.');
  invariant(typeof source === 'string' && source.length > 0 && source.length <= 128, 'Wallet balance snapshot source is invalid.');
  invariant(!data.pending.some(pending => pending.wallet === wallet), 'A pending wallet transaction must resolve before synchronizing positions.');
  invariant(data.positionAdjustments === undefined || Array.isArray(data.positionAdjustments), 'Position adjustment ledger is invalid.');
  const rows = data.lots.filter(lot => live(lot) && matches(lot, wallet, mint));
  const amounts = rows.map(lot => integerAmount(lot.remaining));
  const minimumSlot = rows.reduce((minimum, lot) => Math.max(minimum, knownSlot(lot.confirmedSlot), knownSlot(lot.lastBalanceSlot)), 0);
  invariant(slot >= minimumSlot, 'Wallet balance snapshot predates a confirmed fill or position synchronization.');
  const before = amounts.reduce((total, amount) => total + amount, 0n);
  if (balance >= before) {
    // Pin one trustworthy anchor for legacy rows without creating an adjustment
    // or requiring another ledger write on every unchanged balance poll.
    const unanchored = rows.filter(lot => !knownSlot(lot.lastBalanceSlot) && !knownSlot(lot.confirmedSlot));
    unanchored.forEach(lot => { lot.lastBalanceSlot = slot; });
    return { changed: false, updated: unanchored.length > 0, before, after: before, removed: 0n };
  }

  let cumulative = 0n, assigned = 0n;
  const allocations = amounts.map(amount => {
    cumulative += amount;
    const target = cumulative * balance / before, remaining = target - assigned;
    assigned = target;
    return remaining;
  });
  const removed = before - balance;
  const adjustment = { wallet, mint, before: before.toString(), after: balance.toString(), externalRemoved: removed.toString(), slot, at: Date.now(), source };
  const adjustments = [...(data.positionAdjustments || []), adjustment].slice(-1000);
  rows.forEach((lot, index) => {
    lot.remaining = allocations[index].toString();
    lot.lastBalanceSlot = slot;
    if (allocations[index] < amounts[index]) lot.externalAdjusted = true;
  });
  data.positionAdjustments = adjustments;
  return { changed: true, updated: true, before, after: balance, removed, adjustment };
}
