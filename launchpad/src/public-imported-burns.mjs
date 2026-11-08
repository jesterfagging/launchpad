import bs58 from 'bs58';
import { MANUAL_PROTOCOL_HISTORY, MANUAL_PROTOCOL_MINT } from './protocol-manual-history.mjs';

const raw = value => typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
const key = row => row.signature + ':' + row.kind;
const same = (a, b) => a.inputAmount === b.inputAmount && a.outputAmount === b.outputAmount;
const signature = value => { try { return typeof value === 'string' && value.length >= 64 && value.length <= 88 && bs58.decode(value).length === 64; } catch { return false; } };
const address = value => { try { return typeof value === 'string' && bs58.decode(value).length === 32 && bs58.encode(bs58.decode(value)) === value; } catch { return false; } };
const valid = (row, now) => row && ['buy', 'burn'].includes(row.kind) && signature(row.signature) &&
  Number.isSafeInteger(row.confirmedAt) && row.confirmedAt > 0 && row.confirmedAt <= now + 5000 &&
  raw(row.inputAmount) && BigInt(row.inputAmount) > 0n && raw(row.outputAmount) &&
  (row.kind === 'buy' ? BigInt(row.outputAmount) > 0n : row.outputAmount === '0');
const known = value => ['available', 'partial'].includes(value?.status);
const publicRow = row => ({ kind: row.kind, source: 'admin', signature: row.signature,
  inputAmount: row.inputAmount, outputAmount: row.outputAmount, confirmedAt: row.confirmedAt,
  slot: row.slot, commitment: 'finalized', curveDecimals: 6, mint: MANUAL_PROTOCOL_MINT,
  ...(row.wallet === undefined ? {} : { wallet: row.wallet }),
  ...(row.accountingSource === undefined ? {} : { accountingSource: row.accountingSource }) });
const recent = rows => [...new Map(rows.map(row => [key(row), row])).values()].sort((a, b) => b.confirmedAt - a.confirmedAt).slice(0, 20);

// A public projection only. This never writes a treasury journal or touches a
// revenue allocation, budget, signing key or pending transaction. Imported
// burns can exceed recorded purchases: no purchase cost is inferred from them.
export function includeImportedBurnHistory({ treasury, burns, direct, knownTreasuryReceipts = [], imported, now = Date.now() }) {
  if (!imported || imported.status === 'available' && imported.complete === true && Array.isArray(imported.history) && imported.history.length === 0) return { treasury, burns };
  const treasuryKnown = known(treasury) && treasury.curveDecimals === 6 && raw(treasury.solSpent) && raw(treasury.curveBought) && raw(treasury.curveBurned);
  const burnsKnown = known(burns) && raw(burns.curveBurned);
  const unavailable = () => ({
    treasury: { ...treasury, status: 'unavailable', complete: false, solSpent: null, curveBought: null, curveBurned: null, history: [], adminIncluded: false, note: 'Conflicting imported receipt records need reconciliation.' },
    burns: { ...burns, status: 'unavailable', complete: false, curveBurned: null, history: [], adminIncluded: false, note: 'Conflicting imported receipt records need reconciliation.' },
  });
  // A failed store read cannot turn existing confirmed amounts into complete
  // totals. Keep known receipts visible, explicitly as a recorded subtotal.
  if (imported.status !== 'available' || !Array.isArray(imported.history)) return {
    treasury: { ...treasury, ...(treasuryKnown ? { status: 'partial', amountsAreSubtotals: true } : {}), complete: false, adminHistoryUnavailable: true },
    burns: { ...burns, ...(burnsKnown ? { status: 'partial' } : {}), complete: false, adminHistoryUnavailable: true },
  };
  const represented = new Map();
  const register = row => {
    const prior = represented.get(key(row));
    if (prior && !same(prior, row)) return false;
    if (!prior) represented.set(key(row), row);
    return true;
  };
  // Use complete retained source journals, not the recent public history list.
  // Only sources included in the displayed base count as already represented.
  const managedKnown = treasuryKnown && (treasury.managedStatus === 'available' || treasury.status === 'available' && !treasury.manualIncluded);
  const candidates = [
    ...(managedKnown ? knownTreasuryReceipts.filter(row => row?.state === 'confirmed') : []),
    ...(treasuryKnown && treasury.manualIncluded ? MANUAL_PROTOCOL_HISTORY.filter(row => row.confirmedAt <= now) : []),
    ...(treasuryKnown ? treasury.history || [] : []),
    ...(burnsKnown && known(direct) ? direct.history || [] : []),
    ...(burnsKnown ? burns.history || [] : []),
  ];
  for (const row of candidates) if (valid(row, now) && !register(row)) return unavailable();
  let spent = 0n, bought = 0n, burned = 0n;
  const importedRows = new Map();
  for (const input of imported.history) {
    if (!valid(input, now) || input.source !== 'admin' || input.mint !== MANUAL_PROTOCOL_MINT || input.curveDecimals !== 6 || input.commitment !== 'finalized' || !Number.isSafeInteger(input.slot) || input.slot <= 0 || input.wallet !== undefined && !address(input.wallet) || input.accountingSource !== undefined && !['managed-treasury', 'independent'].includes(input.accountingSource)) return unavailable();
    const row = publicRow(input), operationKey = key(row);
    const duplicate = importedRows.get(operationKey);
    if (duplicate && !same(duplicate, row)) return unavailable();
    if (duplicate) continue;
    importedRows.set(operationKey, row);
    const prior = represented.get(operationKey);
    if (prior && !same(prior, row)) return unavailable();
    if (prior) continue;
    // The importer persists this classification only after matching an already
    // counted confirmed treasury operation. Retain its identity after the
    // automatic recent journal is pruned, without adding it to cumulative totals.
    if (row.accountingSource === 'managed-treasury' && managedKnown) { represented.set(operationKey, row); continue; }
    represented.set(operationKey, row);
    if (row.kind === 'buy') { spent += BigInt(row.inputAmount); bought += BigInt(row.outputAmount); }
    else burned += BigInt(row.inputAmount);
  }
  const treasuryEmpty = treasury.status === 'unconfigured';
  const treasuryComplete = (treasuryEmpty || treasuryKnown && treasury.complete === true) && imported.complete === true;
  const burnsComplete = burnsKnown && burns.complete === true && imported.complete === true;
  const latest = Math.max(treasury.updatedAt || 0, burns.updatedAt || 0, ...[...importedRows.values()].map(row => row.confirmedAt));
  const amount = (base, extra, available) => ((available ? BigInt(base) : 0n) + extra).toString();
  const enhancedTreasury = { ...treasury, status: treasuryComplete ? 'available' : 'partial', complete: treasuryComplete,
    curveDecimals: 6, solSpent: treasuryKnown || treasuryEmpty || spent > 0n ? amount(treasury.solSpent, spent, treasuryKnown) : null,
    curveBought: treasuryKnown || treasuryEmpty || bought > 0n ? amount(treasury.curveBought, bought, treasuryKnown) : null,
    curveBurned: treasuryKnown || treasuryEmpty || burned > 0n ? amount(treasury.curveBurned, burned, treasuryKnown) : null, adminIncluded: true,
    adminSolSpent: spent.toString(), adminCurveBought: bought.toString(), adminCurveBurned: burned.toString(),
    amountsAreSubtotals: !treasuryComplete, updatedAt: latest || null,
    history: recent([...importedRows.values(), ...(treasuryKnown ? treasury.history || [] : [])]),
    note: 'Recorded automatic, historical and administrator-imported finalized receipts. Burn-only entries add no purchase cost. Imported activity never changes automatic spending budgets.',
  };
  return { treasury: enhancedTreasury, burns: { ...burns, status: burnsComplete ? 'available' : 'partial', complete: burnsComplete,
    curveBurned: burnsKnown || burned > 0n ? amount(burns.curveBurned, burned, burnsKnown) : null, adminIncluded: true, importedBurned: burned.toString(),
    history: recent([...importedRows.values(), ...(burnsKnown ? burns.history || [] : [])]), updatedAt: latest || null,
    note: 'Recorded treasury, direct and administrator-imported LAUNCHPAD burns, deduplicated by transaction signature and operation. Burn-only receipts add no SOL spent or LAUNCHPAD bought.',
  } };
}
