import bs58 from 'bs58';
import { SOL_MINT } from '../public/launchpad-model.mjs';
import { TAX_BURN_MINT, TAX_BURN_WALLET, TAX_BURN_POLICY } from './launchpad-rewards-wallet.mjs';
import { MANUAL_PROTOCOL_HISTORY } from './protocol-manual-history.mjs';

const raw = value => typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
const time = (value, now) => Number.isSafeInteger(value) && value > 0 && value <= now + 5000;
const signature = value => { try { return typeof value === 'string' && value.length >= 64 && value.length <= 88 && bs58.decode(value).length === 64; } catch { return false; } };
const operationKey = row => row.signature + ':' + row.kind;
const same = (a, b) => ['kind','signature','inputAmount','outputAmount'].every(key => a[key] === b[key]);

// Read only the official launch's finalized receipt journal. A selected policy,
// authorization, wallet balance or pending transaction is never a burn receipt.
// The worker persists taxBurnReceipt only after finalized BurnChecked validation.
export function directBurnRecord(launch, now = Date.now()) {
  if (launch?.keys?.mint?.address !== TAX_BURN_MINT) return null;
  const unavailable = () => ({ complete: false, history: [] });
  if (launch.input?.network !== 'mainnet-beta' || launch.input.route !== 'raydium' || launch.input.feeMode !== 'holders' || launch.input.quoteMint !== SOL_MINT || !(launch.input.taxBps > 0) || (launch.keys?.rewards?.address || launch.rewardsWallet?.address) !== TAX_BURN_WALLET) return unavailable();
  const operations = Array.isArray(launch.operations) ? launch.operations : [];
  if (!launch.taxBurn) return operations.some(op => op?.kind === 'tax-burn') ? unavailable() : { complete: true, history: [] };
  if (launch.taxBurn.policy !== TAX_BURN_POLICY || !Number.isSafeInteger(launch.taxBurn.burnCount) || launch.taxBurn.burnCount < 0) return unavailable();
  const seen = new Map(); let complete = true;
  for (const op of operations) {
    if (op?.kind !== 'tax-burn' || op.state !== 'confirmed') continue;
    const receipt = op.taxBurnReceipt;
    if (!signature(op.signature) || !time(op.confirmedAt, now) || !Number.isSafeInteger(op.slot) || op.slot <= 0 || op.taxBurnPolicy !== TAX_BURN_POLICY || !raw(op.amount) || BigInt(op.amount) === 0n || receipt?.policy !== TAX_BURN_POLICY || receipt.mint !== TAX_BURN_MINT || receipt.wallet !== TAX_BURN_WALLET || receipt.baseUnits !== op.amount || !raw(receipt.trackedTaxBaseUnits) || !raw(receipt.approvedLegacyBaseUnits) || BigInt(receipt.trackedTaxBaseUnits) + BigInt(receipt.approvedLegacyBaseUnits) !== BigInt(op.amount) || !['withheld-tax','approved-initial-inventory'].includes(receipt.source) || receipt.source !== op.taxSource || receipt.source === 'withheld-tax' && receipt.approvedLegacyBaseUnits !== '0' || op.receipt?.baseDelta !== '-' + op.amount || op.receipt?.quoteDelta !== '0') { complete = false; continue; }
    const row = { kind: 'burn', source: 'direct', funding: receipt.source, signature: op.signature, inputAmount: op.amount, outputAmount: '0', confirmedAt: op.confirmedAt, slot: op.slot, commitment: 'finalized', trackedTaxBaseUnits: receipt.trackedTaxBaseUnits, approvedLegacyBaseUnits: receipt.approvedLegacyBaseUnits };
    const prior = seen.get(row.signature);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row)) return unavailable();
    seen.set(row.signature, row);
  }
  const tracked = [...seen.values()].reduce((sum, row) => sum + BigInt(row.trackedTaxBaseUnits), 0n);
  const legacy = [...seen.values()].reduce((sum, row) => sum + BigInt(row.approvedLegacyBaseUnits), 0n);
  const ledgerBurned = launch.taxProtocol?.burnedBase ?? '0', initialLegacy = launch.taxBurn.initialInventory?.legacyBurnedBase ?? '0';
  if (!raw(ledgerBurned) || !raw(initialLegacy) || tracked !== BigInt(ledgerBurned) || legacy !== BigInt(initialLegacy) || seen.size !== launch.taxBurn.burnCount) complete = false;
  return { complete, history: [...seen.values()] };
}

export function publicDirectBurnAnalytics(records, { inventoryComplete = false } = {}) {
  let complete = inventoryComplete, conflict = false;
  const seen = new Map();
  for (const record of records || []) {
    if (!record?.complete) complete = false;
    for (const row of record?.history || []) {
      const prior = seen.get(row.signature);
      if (prior && JSON.stringify(prior) !== JSON.stringify(row)) conflict = true;
      else seen.set(row.signature, row);
    }
  }
  if (conflict) return { status: 'unavailable', complete: false, curveBurned: null, history: [] };
  return { status: complete ? 'available' : 'partial', complete, curveBurned: [...seen.values()].reduce((sum, row) => sum + BigInt(row.inputAmount), 0n).toString(), history: [...seen.values()].sort((a,b) => b.confirmedAt - a.confirmedAt) };
}

// Display-only aggregation. Treasury totals and its spending budget are never
// modified. Use its full retained journal, not the truncated public history, to
// avoid counting a receipt twice if it was also imported as a manual burn.
export function publicCombinedBurnAnalytics(treasury, direct, knownTreasuryReceipts = [], now = Date.now()) {
  const base = { curveMint: TAX_BURN_MINT, curveDecimals: 6, curveBurned: null, directBurned: null, treasuryBurned: null, history: [], updatedAt: null, complete: false, status: 'unavailable' };
  const treasuryKnown = ['available','partial'].includes(treasury?.status) && treasury.curveDecimals === 6 && raw(treasury.curveBurned);
  const treasuryEmpty = treasury?.status === 'unconfigured';
  const directKnown = ['available','partial'].includes(direct?.status) && raw(direct.curveBurned) && Array.isArray(direct.history) && (direct.complete === true || direct.history.length > 0);
  if (!treasuryKnown && !directKnown) return base;
  const represented = new Map();
  const managedKnown = treasuryKnown && (treasury.managedStatus === 'available' || treasury.status === 'available' && !treasury.manualIncluded);
  const candidates = treasuryKnown ? [...(managedKnown ? knownTreasuryReceipts || [] : []).filter(row => row?.state === 'confirmed'), ...MANUAL_PROTOCOL_HISTORY.filter(row => treasury.manualIncluded && row.confirmedAt <= now), ...(treasury.history || [])] : [];
  for (const row of candidates) {
    if (!['buy','burn'].includes(row?.kind) || !signature(row.signature) || !time(row.confirmedAt, now) || !raw(row.inputAmount) || !raw(row.outputAmount) || BigInt(row.inputAmount) === 0n) continue;
    const prior = represented.get(operationKey(row));
    if (prior && !same(prior, row)) return base;
    represented.set(operationKey(row), row);
  }
  let directAdded = 0n;
  const history = new Map((treasuryKnown ? treasury.history || [] : []).map(row => [operationKey(row), row]));
  for (const row of directKnown ? direct.history : []) {
    const prior = represented.get(operationKey(row));
    if (prior && !same(prior, row)) return base;
    if (!prior) directAdded += BigInt(row.inputAmount);
    represented.set(operationKey(row), row); history.set(operationKey(row), row);
  }
  const complete = (treasuryEmpty || treasuryKnown && treasury.complete !== false) && directKnown && direct.complete === true;
  const total = (treasuryKnown ? BigInt(treasury.curveBurned) : 0n) + directAdded;
  return { ...base, status: complete ? 'available' : 'partial', complete, curveBurned: total.toString(), treasuryBurned: treasuryKnown ? treasury.curveBurned : treasuryEmpty ? '0' : null, directBurned: directKnown ? directAdded.toString() : null,
    history: [...history.values()].sort((a,b) => b.confirmedAt - a.confirmedAt).slice(0,20),
    updatedAt: (directKnown ? direct.history.reduce((latest,row) => Math.max(latest,row.confirmedAt), treasury.updatedAt || 0) : treasury.updatedAt) || null,
    note: 'Recorded treasury and direct LAUNCHPAD burns, deduplicated by transaction signature and operation. Direct tax and authorized inventory burns have no recorded buyback cost and do not change treasury spending or budgets.' };
}
