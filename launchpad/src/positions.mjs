import { SOL, decimal, tokenBalances } from './core.mjs';

const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
const finite = value => Number.isFinite(value) ? value : null;
const amount = value => { try { return /^\d+$/.test(String(value)) ? BigInt(value) : null; } catch { return null; } };
const decimalsValid = value => Number.isInteger(value) && value >= 0 && value <= 18;
const marketFor = (markets, mint) => markets instanceof Map ? markets.get(mint) : markets?.[mint];

function freshMarket(markets, mint, now, maxPriceAgeMs) {
  const market = marketFor(markets, mint);
  return market && Number.isFinite(market.receivedAt) && now - market.receivedAt >= -1000 &&
    now - market.receivedAt <= maxPriceAgeMs && positive(market.price) ? market : null;
}

// Save entry conversion rates with the order before it is signed. Later prices
// may value a position, but must never rewrite its historical entry cost.
export function captureEntryCost(order, markets = new Map(), { now = Date.now(), tipsLamports = 0n } = {}) {
  const sol = freshMarket(markets, SOL, now, 10000), input = freshMarket(markets, order.inputMint, now, 10000);
  return { inputMint: order.inputMint, inputDecimals: order.inputMint === SOL ? 9 : order.inputDecimals,
    inputPriceUsd: positive(input?.price), solPriceUsd: positive(sol?.price), quotedAt: now,
    tipsLamports: String(amount(tipsLamports) ?? 0n) };
}

function nativeInputDebit(tx, wallet, tipsLamports) {
  const keys = tx.transaction?.message?.accountKeys;
  const key = value => typeof value === 'string' ? value : value?.pubkey?.toString();
  if (!Array.isArray(keys) || key(keys[0]) !== wallet || !Number.isSafeInteger(tx.meta?.fee)) return null;
  const before = tx.meta.preBalances, after = tx.meta.postBalances;
  const delta = index => Array.isArray(before) && Array.isArray(after) &&
    Number.isSafeInteger(before[index]) && Number.isSafeInteger(after[index]) && before[index] >= 0 && after[index] >= 0
    ? BigInt(before[index]) - BigInt(after[index]) : null;
  let debit = delta(0);
  if (debit === null) return null;
  // Payer SOL alone includes ATA rent and wrapped SOL refunds. Include the
  // native balance changes of its token accounts to cancel both, including
  // existing wrapped SOL spent by the route. No per-wallet RPC reads needed.
  const owned = new Set();
  for (const balance of [...(tx.meta.preTokenBalances || []), ...(tx.meta.postTokenBalances || [])]) {
    if (balance.owner === wallet) owned.add(balance.accountIndex);
  }
  for (const index of owned) {
    if (!Number.isSafeInteger(index) || index <= 0 || index >= keys.length) return null;
    const change = delta(index);
    if (change === null) return null;
    debit += change;
  }
  // New protocol PDAs (for example volume-tracking accounts) can also be
  // funded by this payer. Their rent is not a token acquisition cost. Without
  // a complete ownership/rent proof, retain the labelled budget estimate.
  // The same applies to a non-token account closed and refunded by the route.
  for (let index = 1; index < keys.length; index++) {
    if (!owned.has(index) && ((before[index] === 0 && after[index] > 0) || (before[index] > 0 && after[index] === 0))) return null;
  }
  return debit - BigInt(tx.meta.fee) - tipsLamports;
}

function makeBasis(inputMint, inputAmount, inputDecimals, context, estimated, source) {
  if (!decimalsValid(inputDecimals) || inputAmount === null || inputAmount <= 0n) return null;
  return { version: 1, inputMint, inputAmount: String(inputAmount), inputDecimals,
    inputPriceUsd: positive(context?.inputPriceUsd), solPriceUsd: positive(context?.solPriceUsd),
    quotedAt: Number.isFinite(context?.quotedAt) ? context.quotedAt : null, estimated, source };
}

// The raw input debit includes the buy's trading/platform fee. Network fees,
// sender tips and refundable account rent are excluded. Exit costs are not yet
// incurred and are therefore absent from unrealized PnL.
export function costBasisFromFill(order, received, tx, markets, wallet, { paper = false } = {}) {
  if (amount(received) === null || amount(received) <= 0n) return null;
  const gross = amount(order.amount), context = order.entryCostContext;
  if (!gross || !order.inputMint) return null;
  const inputDecimals = order.inputMint === SOL ? 9 : context?.inputDecimals ?? order.inputDecimals;
  if (paper) return makeBasis(order.inputMint, gross, inputDecimals, context, true, 'paper-budget');
  if (!tx?.meta || tx.meta.err !== null) return null;
  let changes;
  try { changes = tokenBalances(tx, wallet); } catch { return null; }
  if (order.inputMint !== SOL) {
    const input = changes.find(row => row.mint === order.inputMint);
    const spent = input ? -input.delta : null;
    return spent > 0n && spent <= gross ? makeBasis(order.inputMint, spent, input.decimals, context, false, 'confirmed-token-debit') : null;
  }
  const tips = amount(context?.tipsLamports);
  const spent = tips === null ? null : nativeInputDebit(tx, wallet, tips);
  // A funded cross-quote route can leave quote tokens behind. Without an entry
  // price for that remainder, report the budget estimate rather than claiming
  // that the entire SOL debit was the purchased token's exact cost.
  const surplus = changes.some(row => row.mint !== order.outputMint && row.mint !== SOL && row.delta > 0n);
  if (!surplus && spent !== null && spent > 0n && spent <= gross)
    return makeBasis(SOL, spent, 9, context, false, 'confirmed-native-debit');
  return makeBasis(SOL, gross, 9, context, true, 'order-budget');
}

function basisFor(lot, receipts) {
  const basis = lot.costBasis;
  if (basis?.version === 1 && amount(basis.inputAmount) > 0n && decimalsValid(basis.inputDecimals)) return basis;
  // Version 1.2.0 fee receipts retain the original gross input budget. That is
  // useful on upgrades, but it is a cap rather than proof of the actual spend.
  const receipt = receipts.get(lot.id);
  if (!receipt || receipt.wallet !== lot.wallet || !['copy', 'sniper'].includes(receipt.kind) || receipt.mint === lot.mint) return null;
  return makeBasis(receipt.mint, amount(receipt.grossAmount), receipt.mint === SOL ? 9 : receipt.decimals, null, true, 'legacy-order-budget');
}

function lotCosts(lot, basis) {
  const original = amount(lot.original), remaining = amount(lot.remaining);
  if (!basis || original === null || original <= 0n || remaining === null || remaining > original) return { costSol: null, costUsd: null };
  const input = amount(basis.inputAmount);
  if (input === null || input <= 0n || !decimalsValid(basis.inputDecimals)) return { costSol: null, costUsd: null };
  // Allocate a partial sale with integer arithmetic, retaining 18 fractional
  // raw-unit digits before converting for display. This does not mutate lots.
  const allocated = input * remaining * 10n ** 18n / original;
  const units = Number(decimal(allocated, basis.inputDecimals + 18));
  const usd = positive(basis.inputPriceUsd), solUsd = positive(basis.solPriceUsd);
  const costUsd = finite(units * (usd || (basis.inputMint === SOL ? solUsd : 0)));
  return { costSol: basis.inputMint === SOL ? finite(units) : usd && solUsd ? finite(units * usd / solUsd) : null,
    costUsd: usd || (basis.inputMint === SOL && solUsd) ? costUsd : null };
}

const sumKnown = (rows, key) => rows.every(row => Number.isFinite(row[key])) ? finite(rows.reduce((sum, row) => sum + row[key], 0)) : null;
function aggregate(rows) {
  const decimals = Math.max(...rows.map(row => row.decimals)), raw = rows.reduce((sum, row) => sum + BigInt(row.remaining) * 10n ** BigInt(decimals - row.decimals), 0n);
  const balance = decimal(raw, decimals), units = Number(balance), costSol = sumKnown(rows, 'costSol'), costUsd = sumKnown(rows, 'costUsd');
  const valueSol = sumKnown(rows, 'valueSol'), valueUsd = sumKnown(rows, 'valueUsd');
  return { balance, valueSol, valueUsd, costSol, costUsd,
    avgEntrySol: costSol !== null && units > 0 ? finite(costSol / units) : null,
    avgEntryUsd: costUsd !== null && units > 0 ? finite(costUsd / units) : null,
    pnlSol: costSol !== null && valueSol !== null ? finite(valueSol - costSol) : null,
    pnlUsd: costUsd !== null && valueUsd !== null ? finite(valueUsd - costUsd) : null,
    basisEstimated: rows.some(row => row.basisEstimated) };
}

export function summarizePositions(lots, markets = new Map(), { now = Date.now(), maxPriceAgeMs = 30000, feeReceipts = [] } = {}) {
  const receipts = new Map(feeReceipts.map(row => [row.signature, row]));
  const solPrice = positive(freshMarket(markets, SOL, now, maxPriceAgeMs)?.price), grouped = new Map();
  const positions = (Array.isArray(lots) ? lots : []).filter(lot => amount(lot.remaining) > 0n && decimalsValid(lot.decimals)).map(lot => {
    const market = freshMarket(markets, lot.mint, now, maxPriceAgeMs), basis = basisFor(lot, receipts), balance = decimal(lot.remaining, lot.decimals);
    const valueUsd = market ? finite(Number(balance) * Number(market.price)) : null;
    const valueSol = lot.mint === SOL ? finite(Number(balance)) : valueUsd !== null && solPrice ? finite(valueUsd / solPrice) : null;
    const costs = lotCosts(lot, basis), units = Number(balance);
    const row = { ...lot, balance, market: market || null, ...costs, valueSol, valueUsd,
      avgEntrySol: costs.costSol !== null && units > 0 ? finite(costs.costSol / units) : null,
      avgEntryUsd: costs.costUsd !== null && units > 0 ? finite(costs.costUsd / units) : null,
      pnlSol: costs.costSol !== null && valueSol !== null ? finite(valueSol - costs.costSol) : null,
      pnlUsd: costs.costUsd !== null && valueUsd !== null ? finite(valueUsd - costs.costUsd) : null,
      basisEstimated: !!basis?.estimated || !!lot.externalAdjusted, costBasisSource: basis?.source || null };
    const group = grouped.get(lot.mint) || []; group.push(row); grouped.set(lot.mint, group);
    return row;
  });
  const groups = [...grouped].map(([mint, rows]) => {
    const byWallet = new Map();
    for (const row of rows) { const held = byWallet.get(row.wallet) || []; held.push(row); byWallet.set(row.wallet, held); }
    const wallets = [...byWallet].map(([wallet, held]) => ({ wallet, walletLabel: held[0].walletLabel || '', ...aggregate(held),
      lotIds: held.map(row => row.id) }));
    return { mint, symbol: rows.find(row => row.market?.symbol)?.market.symbol || rows.find(row => row.symbol)?.symbol || '',
      ...aggregate(rows), wallets };
  });
  const wallets = groups.flatMap(group => group.wallets);
  return { positions, positionSummary: { openCount: groups.length, assetCount: groups.length, positionCount: wallets.length,
    pricedCount: groups.filter(row => row.valueSol !== null).length,
    costedCount: groups.filter(row => row.costSol !== null).length,
    totalValueSol: sumKnown(groups, 'valueSol'), totalValueUsd: sumKnown(groups, 'valueUsd'),
    totalPnlSol: sumKnown(groups, 'pnlSol'), totalPnlUsd: sumKnown(groups, 'pnlUsd'),
    basisEstimated: groups.some(group => group.basisEstimated), groups, asOf: now } };
}
