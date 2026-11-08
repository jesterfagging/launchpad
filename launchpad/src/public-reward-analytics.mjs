import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { displayUnits } from '../public/launchpad-model.mjs';
import { quoteLabel } from '../public/quote-identity.mjs';

const mintValue = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) ? value : null;
const signatureValue = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value) ? value : null;
const unsigned = value => typeof value === 'string' && /^\d{1,40}$/.test(value) ? BigInt(value) : null;
const signed = value => typeof value === 'string' && /^-?\d{1,40}$/.test(value) ? BigInt(value) : null;
const stamp = value => Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000 ? value : null;
const relevant = new Set(['create', 'launch-all', 'claim', 'buy', 'burn', 'payout']);
const creation = op => ['create', 'launch-all'].includes(op.kind);
const validConfirmed = op => op?.state === 'confirmed' && signatureValue(op.signature) && Number.isSafeInteger(op.slot) && op.slot > 0;
const asString = value => value === null ? null : value.toString();
// Recipient identity remains private to the reporting scan. Hash only validated
// canonical wallet addresses, and publish the deduplicated count, never hashes.
function recipientIdentity(value) {
  try { if (typeof value !== 'string') return null; const key = new PublicKey(value); return key.toBase58() === value && PublicKey.isOnCurve(key.toBytes()) ? createHash('sha256').update('curve:holder-recipient:v1:' + value).digest('hex') : null; }
  catch { return null; }
}

// A legacy confirmed operation can retain its verified receipt and complete
// payout plan even when the redundant top-level amount is absent. Recover only
// that exact amount; a malformed or contradictory saved value stays invalid.
function payoutAmount(op) {
  const value = unsigned(op.amount);
  if (value !== null || op.amount !== undefined && op.amount !== null) return { value, recovered: false };
  if (op.kind !== 'payout' || !validConfirmed(op)) return { value: null, recovered: false };
  const quote = signed(op.receipt?.quoteDelta), base = signed(op.receipt?.baseDelta), rows = op.payouts;
  if (quote === null || quote >= 0n || base !== 0n || !Array.isArray(rows) || !rows.length || rows.length > 1000) return { value: null, recovered: false };
  const owners = new Set(); let total = 0n;
  for (const row of rows) {
    const amount = unsigned(row?.amount), owner = recipientIdentity(row?.owner);
    if (amount === null || amount <= 0n || !owner || owners.has(owner)) return { value: null, recovered: false };
    owners.add(owner); total += amount;
  }
  return total === -quote ? { value: total, recovered: true } : { value: null, recovered: false };
}

/** Project a complete private launch journal during the existing inventory scan.
 * This value contains no account IDs, wallet addresses, payout recipients,
 * signed transaction bytes, credentials, or user-provided error text. It must
 * remain internal; the public response is produced by publicRewardAnalytics. */
export function rewardAnalyticsRecord(launch, coin = {}) {
  const mode = launch?.input?.feeMode;
  // Gotchi launches pay a pot vault; their payouts are not holder rewards.
  if (!['holders', 'buyback'].includes(mode) || launch.input.gotchi) return null;
  const mint = mintValue(coin.mint || launch.keys?.mint?.address);
  const quoteMint = mintValue(coin.quote?.mint || launch.input?.quoteMint);
  const decimals = launch.review?.quoteDecimals;
  const metadataValid = !!mint && !!quoteMint && Number.isInteger(decimals) && decimals >= 0 && decimals <= 12 &&
    (!launch.keys?.mint?.address || launch.keys.mint.address === mint) && (!launch.input?.quoteMint || launch.input.quoteMint === quoteMint);
  const raw = Array.isArray(launch.operations) ? launch.operations : [];
  const operations = raw.filter(op => op && relevant.has(op.kind)).map(op => {
    const amount = mode === 'holders' ? payoutAmount(op) : { value: unsigned(op.amount), recovered: false };
    return {
    kind: op.kind, state: op.state === 'confirmed' ? 'confirmed' : 'unconfirmed',
    signature: signatureValue(op.signature), slot: Number.isSafeInteger(op.slot) && op.slot > 0 ? op.slot : null,
    operationId: typeof op.operationId === 'string' && op.operationId.length <= 100 ? op.operationId : null,
    createdAt: stamp(op.createdAt), confirmedAt: stamp(op.confirmedAt),
    amount: asString(amount.value),
    ...(amount.recovered ? { amountSource: 'saved-confirmed-receipt' } : {}),
    payouts: Array.isArray(op.payouts) ? op.payouts.map(row => ({ amount: asString(unsigned(row?.amount)), recipient: recipientIdentity(row?.owner) })) : null,
    receipt: op.receipt ? { quoteDelta: asString(signed(op.receipt.quoteDelta)), baseDelta: asString(signed(op.receipt.baseDelta)) } : null,
  }; });
  // These counters describe one distribution cycle, not a lifetime total. They
  // can prove retained payout history is incomplete, but cannot add amounts
  // or recipients without their deduplicated confirmed transaction records.
  const cycleEvidence = mode === 'holders' ? [launch.holderRewards?.lastDistributionQuoteUnits, launch.cycle?.distributedQuoteUnits].filter(value => value !== undefined && value !== null) : [];
  const retainedPayouts = new Map();
  for (const op of operations) {
    const amount = unsigned(op.amount);
    if (op.kind === 'payout' && validConfirmed(op) && amount > 0n && (!op.receipt || signed(op.receipt.quoteDelta) === -amount && signed(op.receipt.baseDelta) === 0n)) retainedPayouts.set(op.signature, amount);
  }
  const retainedPaid = [...retainedPayouts.values()].reduce((sum, value) => sum + value, 0n);
  const cycleHistoryRepresented = cycleEvidence.every(value => unsigned(value) !== null && unsigned(value) <= retainedPaid);
  return {
    mint, mode, quote: { mint: quoteMint, symbol: quoteLabel(quoteMint, coin.quote?.symbol || launch.review?.quoteSymbol), decimals: metadataValid ? decimals : null },
    metadataValid,
    historyComplete: metadataValid && Array.isArray(launch.operations) && operations.some(op => creation(op) && validConfirmed(op)) && launch.historyTruncated !== true && launch.operationsTruncated !== true && cycleHistoryRepresented,
    operations,
  };
}

function money(historyComplete) {
  return { amounts: new Map(), historyComplete, inventoryComplete: historyComplete, unassignedHistory: false, evidenceCount: 0 };
}
function add(metric, quote, amount, historyComplete = true) {
  const key = quote.mint, prior = metric.amounts.get(key);
  if (prior && prior.decimals !== quote.decimals) { metric.historyComplete = false; prior.historyComplete = false; return; }
  metric.amounts.set(key, { ...quote, amount: (prior?.amount || 0n) + amount, historyComplete: (prior?.historyComplete ?? metric.inventoryComplete) && historyComplete });
  if (amount > 0n) metric.evidenceCount++;
}
function incomplete(metric, quote) { metric.historyComplete = false; add(metric, quote, 0n, false); }
// Same two-minute window as lifetime volume, revenue and burn valuation. Quote
// prices are only re-fetched once they are 60s old (every 30s, a few mints at a
// time), so a 60s window regularly dropped a current price between refreshes and
// made the public rewards value flicker between a total, a subtotal and a dash.
const PRICE_MAX_AGE_MS = 120_000;
function freshPrice(prices, mint, now) {
  const p = prices instanceof Map ? prices.get(mint) : prices?.[mint];
  if (!p || p.stale === true || !stamp(p.at) || p.at > now || now - p.at > PRICE_MAX_AGE_MS) return null;
  if (!['number', 'string'].includes(typeof p.usd) || typeof p.usd === 'string' && !/^\d+(?:\.\d+)?$/.test(p.usd)) return null;
  const usd = Number(p.usd);
  return Number.isFinite(usd) && usd > 0 ? { usd, at: p.at } : null;
}
function publicMoney(metric, prices, now) {
  let observed = 0, priced = 0, unpriced = 0;
  const quoteTotals = [...metric.amounts.values()].sort((a, b) => a.mint.localeCompare(b.mint)).map(row => {
    const historyComplete = row.historyComplete && !metric.unassignedHistory;
    // A placeholder for a known quote is not proof that it paid zero. Preserve
    // any positive verified subtotal, but hide a zero when history is missing.
    const amount = historyComplete || row.amount > 0n ? displayUnits(row.amount, row.decimals) : null, price = freshPrice(prices, row.mint, now);
    const value = amount === null ? null : row.amount === 0n ? 0 : price ? Number(amount) * price.usd : null;
    const usdEstimate = value !== null && Number.isFinite(value) ? value : null;
    if (row.amount > 0n) {
      if (usdEstimate === null) unpriced++;
      else { observed += usdEstimate; priced++; }
    }
    return { symbol: row.symbol, decimals: row.decimals, amount, usdEstimate, priceAt: amount === null ? null : price?.at || null, historyComplete, coverage: historyComplete ? 'complete' : row.amount > 0n ? 'subtotal' : 'unavailable' };
  });
  const finite = Number.isFinite(observed), valuationComplete = unpriced === 0 && finite;
  const knownZero = metric.historyComplete && metric.evidenceCount === 0;
  return {
    usdEstimate: metric.historyComplete && valuationComplete ? observed : null,
    observedUsdEstimate: finite && (priced > 0 || knownZero) ? observed : null,
    quoteTotals, historyComplete: metric.historyComplete, valuationComplete,
    valuationBasis: 'current_quote_prices', evidenceCount: metric.evidenceCount,
    unpricedQuoteAssets: unpriced,
  };
}

// A confirmed operation has exactly one financial identity. Duplicate migrated
// records can repeat it, but a conflicting mint/kind/amount/receipt is excluded
// rather than allowing traversal order to determine reported totals.
function fingerprint(mint, op) {
  return JSON.stringify([mint, op.kind, op.slot, op.amount, op.receipt, op.payouts]);
}
function mergeRecords(records, collectSkipped = false) {
  const groups = new Map(), signatures = new Map(), ids = new Map();
  for (const record of records.filter(Boolean).sort((a, b) => (b.operations?.length || 0) - (a.operations?.length || 0))) {
    if (!['holders', 'buyback'].includes(record.mode)) continue;
    const key = record.mint || `invalid:${groups.size}`;
    let group = groups.get(key);
    if (!group) { group = { mint: record.mint, mode: record.mode, quote: record.quote, metadataValid: record.metadataValid === true, historyComplete: record.historyComplete === true, operations: [], skipped: [], invalid: false, metadataConflict: false }; groups.set(key, group); }
    else {
      group.historyComplete ||= record.historyComplete === true;
      if (group.mode !== record.mode || group.quote?.mint !== record.quote?.mint || group.quote?.decimals !== record.quote?.decimals || record.metadataValid !== true) { group.invalid = true; group.metadataConflict = true; }
    }
    for (const op of record.operations || []) {
      if (op.state !== 'confirmed') { if (collectSkipped) group.skipped.push({op, reason:'not_confirmed'}); continue; }
      if (!validConfirmed(op)) { group.invalid = true; if (collectSkipped) group.skipped.push({op, reason:!op.signature?'missing_or_invalid_signature':'missing_or_invalid_finalized_slot'}); continue; }
      const identity = fingerprint(group.mint, op), existing = signatures.get(op.signature);
      if (existing) {
        if (existing.identity !== identity) { existing.group.invalid = true; group.invalid = true; existing.bad = true; existing.reason='conflicting_signature'; if (collectSkipped) group.skipped.push({op,reason:'conflicting_signature'}); }
        else if (collectSkipped) group.skipped.push({op,reason:'duplicate_signature'});
        continue;
      }
      const idKey = op.operationId ? `${group.mint}:${op.operationId}` : null, priorId = idKey && ids.get(idKey);
      const item = { op, identity, group, bad: false, order: group.operations.length };
      if (priorId) { priorId.bad = true; priorId.group.invalid = true; priorId.reason='conflicting_operation_id'; item.bad = true; item.reason='conflicting_operation_id'; group.invalid = true; }
      if (idKey) ids.set(idKey, item);
      signatures.set(op.signature, item); group.operations.push(item);
    }
  }
  for (const group of groups.values()) {
    group.historyComplete &&= !group.invalid && group.metadataValid;
    group.operations.sort((a, b) => a.op.slot - b.op.slot || (a.op.createdAt || 0) - (b.op.createdAt || 0) || a.order - b.order);
  }
  return [...groups.values()];
}

// Admin diagnostics use the same global merge and exclusion decisions as the
// public reducer. Return only public transaction identities, never internal
// operation IDs or the recipient hashes retained by the private projection.
export function holderRewardJournalAudit(records = [], { maxDetails = 500 } = {}) {
  let remaining = Number.isSafeInteger(maxDetails) ? Math.max(0, Math.min(1000, maxDetails)) : 500;
  return mergeRecords(Array.isArray(records) ? records : [], true).filter(group => group.mode === 'holders').map(group => {
    const reasons = {}, details = []; let confirmed = 0, accepted = 0, recovered = 0, total = 0n, detailCount = 0, historyComplete = group.historyComplete;
    const report = (op, reason, counted = false) => {
      reasons[reason] = (reasons[reason] || 0) + 1; detailCount++;
      if (remaining > 0 && details.length < 50) { remaining--; details.push({ signature: signatureValue(op.signature), slot: stamp(op.slot), counted, reason }); }
    };
    for (const item of group.skipped) if (item.op.kind === 'payout') report(item.op, item.reason);
    for (const item of group.operations) {
      const op = item.op; if (op.kind !== 'payout') continue;
      confirmed++;
      if (item.bad) { report(op, item.reason || 'conflicting_record'); continue; }
      if (!group.metadataValid || group.metadataConflict) { report(op, 'quote_or_launch_metadata_invalid'); continue; }
      const amount = unsigned(op.amount);
      if (amount === null || amount <= 0n) { historyComplete = false; report(op, 'missing_or_invalid_amount'); continue; }
      if (op.receipt && (signed(op.receipt.quoteDelta) !== -amount || signed(op.receipt.baseDelta) !== 0n)) { historyComplete = false; report(op, 'contradictory_receipt'); continue; }
      accepted++; total += amount;
      if (op.amountSource === 'saved-confirmed-receipt') { recovered++; report(op, 'amount_recovered_from_confirmed_receipt', true); }
      else report(op, 'confirmed_payout', true);
      const rows = op.payouts;
      if (!Array.isArray(rows) || !rows.length || rows.some(row => unsigned(row?.amount) === null || unsigned(row.amount) <= 0n) || rows.reduce((sum, row) => sum + unsigned(row.amount), 0n) !== amount) report(op, 'recipient_breakdown_incomplete', true);
      else if (rows.some(row => typeof row.recipient !== 'string' || !/^[a-f0-9]{64}$/.test(row.recipient))) report(op, 'recipient_identity_incomplete', true);
    }
    return { mint: group.mint, quote: group.quote, metadataValid: group.metadataValid && !group.metadataConflict, historyComplete,
      confirmedPayouts: confirmed, countedPayouts: accepted, recoveredPayoutAmounts: recovered, countedQuoteUnits: total.toString(),
      reasons, details, omittedDetails: detailCount - details.length };
  });
}

/** Read-only lifetime aggregation from journal facts. USD uses fresh current
 * quote prices, because historical execution-time USD prices were not saved.
 * Native quote totals remain available when a quote cannot currently be priced.
 * No RPC calls, account writes, payout creation, or signing are performed. */
export function publicRewardAnalytics(records = [], { pricesByMint = {}, now = Date.now(), inventoryComplete = true } = {}) {
  const inventoryKnown = inventoryComplete === true && Array.isArray(records);
  const distributed = money(inventoryKnown), buybacks = money(inventoryKnown), boughtAndBurned = money(inventoryKnown);
  const paidWallets = new Set(); let walletsComplete = inventoryKnown;
  let holderCoins = 0, agentCoins = 0, payments = 0, paymentsComplete = inventoryKnown, completedBuys = 0, completedBurns = 0, pendingBurnBuys = 0;
  for (const group of mergeRecords(Array.isArray(records) ? records : [])) {
    const isHolder = group.mode === 'holders', metrics = isHolder ? [distributed] : [buybacks, boughtAndBurned];
    if (isHolder) holderCoins++; else agentCoins++;
    for (const metric of metrics) metric.historyComplete &&= group.historyComplete;
    if (isHolder) { paymentsComplete &&= group.historyComplete; walletsComplete &&= group.historyComplete; }
    if (!group.metadataValid || group.metadataConflict) { for (const metric of metrics) metric.unassignedHistory = true; continue; }
    for (const metric of metrics) add(metric, group.quote, 0n, group.historyComplete);
    // The persisted cycle burns the entire earned base-token credit. Only
    // reconcile a cost to that burn when all preceding credit changes are
    // known and the exact burn equals the tracked credit. Claimed base tokens
    // have zero buyback spending and never inflate the USD burn amount.
    let credit = 0n, creditKnown = group.historyComplete, pendingCosts = 0n, pendingBuys = 0;
    let created = false;
    for (const item of group.operations) {
      const op = item.op;
      if (item.bad) { creditKnown = false; continue; }
      if (creation(op)) { created = true; continue; }
      if (!created) creditKnown = false;
      const amount = unsigned(op.amount), q = signed(op.receipt?.quoteDelta), b = signed(op.receipt?.baseDelta);
      if (isHolder) {
        if (op.kind !== 'payout') continue;
        // Historic payout journals already record the exact validated sent
        // amount (unlike swap budgets). An existing contradictory receipt is
        // never accepted; recipient-side transfer taxes are not inferred.
        if (amount === null || amount <= 0n || op.receipt && (q !== -amount || b !== 0n)) { incomplete(distributed, group.quote); paymentsComplete = false; walletsComplete = false; continue; }
        add(distributed, group.quote, amount);
        const rows = op.payouts;
        if (!Array.isArray(rows) || !rows.length || rows.some(row => unsigned(row.amount) === null || unsigned(row.amount) <= 0n) || rows.reduce((total, row) => total + unsigned(row.amount), 0n) !== amount) { paymentsComplete = false; walletsComplete = false; }
        else {
          payments += rows.length;
          for (const row of rows) {
            if (typeof row.recipient === 'string' && /^[a-f0-9]{64}$/.test(row.recipient)) paidWallets.add(row.recipient);
            else walletsComplete = false;
          }
        }
        continue;
      }
      if (op.kind === 'claim') {
        if (q === null || q < 0n || b === null || b < 0n) { creditKnown = false; incomplete(boughtAndBurned, group.quote); }
        else credit += b;
      } else if (op.kind === 'buy') {
        if (amount === null || amount <= 0n || q === null || q >= 0n || -q > amount || b === null || b <= 0n) { incomplete(buybacks, group.quote); incomplete(boughtAndBurned, group.quote); creditKnown = false; continue; }
        add(buybacks, group.quote, -q); completedBuys++; pendingCosts -= q; pendingBuys++; credit += b;
      } else if (op.kind === 'burn') {
        if (amount === null || amount <= 0n || b !== -amount || q !== 0n) { incomplete(boughtAndBurned, group.quote); creditKnown = false; continue; }
        completedBurns++;
        if (creditKnown && credit === amount) {
          if (pendingCosts > 0n) add(boughtAndBurned, group.quote, pendingCosts);
          credit = 0n; pendingCosts = 0n; pendingBuys = 0;
        } else {
          // An unmatched or partial burn does not establish which purchase
          // was burned. Preserve known spending but do not invent burn cost.
          incomplete(boughtAndBurned, group.quote); creditKnown = false;
        }
      }
    }
    if (!isHolder) pendingBurnBuys += pendingBuys;
  }
  return {
    asOf: now, scope: 'all_completed_launches_including_hidden_and_archived',
    valuationBasis: 'current_quote_prices', valuationNote: 'USD estimates value confirmed quote amounts at current prices; they are not historical dollar totals.',
    holders: { distributed: publicMoney(distributed, pricesByMint, now), uniqueWallets: walletsComplete ? paidWallets.size : null, observedUniqueWallets: paidWallets.size > 0 || walletsComplete ? paidWallets.size : null, walletsComplete, walletCountBasis: 'distinct_confirmed_payout_recipients', payments: paymentsComplete ? payments : null, observedPayments: payments, coins: holderCoins, historyComplete: distributed.historyComplete, distributedBasis: 'quote_sent' },
    agents: { buybacks: publicMoney(buybacks, pricesByMint, now), boughtAndBurned: publicMoney(boughtAndBurned, pricesByMint, now), completedBuys, completedBurns, pendingBurnBuys, coins: agentCoins, historyComplete: buybacks.historyComplete && boughtAndBurned.historyComplete, burnBasis: 'confirmed_purchase_cost_matched_to_full_credit_burn' },
  };
}
