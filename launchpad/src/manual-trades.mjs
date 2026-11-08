import { MAX_WALLETS } from '../public/wallet-limits.mjs';
import { address, invariant, SOL, units } from './core.mjs';

// A request ID belongs to one exact intent. Persisting that association before
// execution makes an HTTP retry safe even after the process has restarted.
export function validateManualTrade(raw) {
  invariant(raw && typeof raw === 'object' && !Array.isArray(raw), 'Enter a manual trade.');
  invariant(typeof raw.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.id), 'Manual trades require a unique request ID.');
  invariant(raw.side === 'buy' || raw.side === 'sell', 'Choose buy or sell.');
  const mint = address(raw.mint, 'Token mint');
  invariant(mint !== SOL, 'Choose the SPL token to buy or sell, rather than SOL.');
  invariant(Array.isArray(raw.wallets) && raw.wallets.length >= 1 && raw.wallets.length <= MAX_WALLETS, 'Select between 1 and 25 imported wallets.');
  const wallets = raw.wallets.map(value => address(value, 'Selected wallet'));
  invariant(new Set(wallets).size === wallets.length, 'Select each wallet only once.');
  const request = { id: raw.id.toLowerCase(), side: raw.side, mint, wallets: wallets.sort() };
  if (raw.side === 'buy') {
    const amount = units(raw.amountSol);
    invariant(amount > 0n, 'Enter a buy amount greater than zero SOL per wallet.');
    request.amount = amount.toString();
  } else {
    const percent = units(raw.sellPercent, 6);
    invariant(percent > 0n && percent <= 100_000_000n, 'Sell percentage must be greater than zero and no more than 100.');
    request.percent = percent.toString();
  }
  return request;
}

export function manualSellGroups(lots, wallet, mint, percent) {
  const groups = new Map();
  for (const lot of lots) {
    if (lot.wallet !== wallet || lot.mint !== mint || BigInt(lot.remaining) <= 0n) continue;
    const venue = lot.venue || null;
    const key = [lot.exitMint, venue?.type || '', venue?.pool || '', venue?.baseMint || '', venue?.quoteMint || ''].join(':');
    const group = groups.get(key) || { exitMint: lot.exitMint, venue, amount: 0n, allocations: [], remaining: 0n };
    group.remaining += BigInt(lot.remaining);
    // Round the route total once, then assign its exact cumulative difference.
    // Rounding every lot separately can turn several small holdings into zero.
    const target = group.remaining * BigInt(percent) / 100_000_000n;
    const amount = target - group.amount;
    group.amount = target;
    if (amount) group.allocations.push({ lotId: lot.id, amount: amount.toString() });
    groups.set(key, group);
  }
  return [...groups.values()].filter(group => group.amount > 0n).map(({ remaining, ...group }) => group);
}

export function refreshManualOutcome(outcome) {
  const trades = outcome.trades || [];
  if (!trades.length) return outcome;
  outcome.status = trades.some(t => t.status === 'pending') ? 'pending'
    : trades.some(t => t.status === 'failed') ? 'failed'
      : trades.some(t => t.status === 'skipped') ? 'skipped' : 'confirmed';
  const signatures = trades.map(t => t.signature).filter(Boolean);
  if (signatures.length) { outcome.signature = signatures.at(-1); outcome.signatures = signatures; }
  else { delete outcome.signature; delete outcome.signatures; }
  const errors = [...new Set(trades.map(t => t.error).filter(Boolean))];
  if (errors.length) outcome.error = errors.join(' ').slice(0, 500); else delete outcome.error;
  return outcome;
}
