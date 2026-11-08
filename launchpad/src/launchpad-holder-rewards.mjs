import { displayUnits, units, requireValue as ok } from '../public/launchpad-model.mjs';
import { quoteLabel } from '../public/quote-identity.mjs';
import { TAX_CONVERSION_INTERVAL_MS, TAX_CONVERSION_MAX_TOKENS, TAX_CONVERSION_MAX_IMPACT_BPS, TAX_CONVERSION_RESERVE_BPS, TAX_CONVERSION_BACKLOG_TOKENS, TAX_CONVERSION_BACKLOG_UNITS, TAX_CONVERSION_BURST_MAX_IMPACT_BPS, TAX_CONVERSION_BURST_RESERVE_BPS } from './launchpad-tax-conversion.mjs';
import { autoRewardEnabled } from './launchpad-reward-recovery.mjs';
import { publicTaxBurn, officialTaxBurnScope, officialTaxBurnConfigured, TAX_BURN_POLICY } from './launchpad-tax-burn.mjs';
import { PAYCHECK_POLICY, PAYCHECK_INTERVAL_MS, PAYCHECK_CLAIM_MINIMUM_CENTS, PAYCHECK_THRESHOLD_CENTS, PAYCHECK_SPLIT_BPS, paycheckLaunch, paycheckInput, publicPaycheck } from './launchpad-paycheck.mjs';

export const HOLDER_REWARD_INTERVAL_MS = 60 * 60 * 1000;
export const HOLDER_REWARD_MINIMUM_USD = 100;
export const HOLDER_REWARD_POLICY = 'fixed-usd-100-v1';
const MAX_TOKEN_UNITS = 18446744073709551615n;
export const pacedHolderTax = launch => launch.input.feeMode === 'holders' && (launch.input.taxBps > 0 || BigInt(launch.credits?.base || '0') > 0n);
// Derive the backlog from receipt-accounted launch-base credits on every pass.
// Saved burn reservations always exclude sales; their normal route validates
// policy integrity. Explicit pauses and one-off manual work cannot opt in.
export const automaticTaxBacklog = launch => launch.input.feeMode==='holders'&&!!launch.curve&&!!launch.authorizedAt&&launch.state==='live'&&autoRewardEnabled(launch)&&!launch.taxBurn&&!(officialTaxBurnScope(launch)&&officialTaxBurnConfigured())&&BigInt(launch.credits?.base||'0')>=TAX_CONVERSION_BACKLOG_UNITS;
// Paycheck launches (v71.44) run their cycle every 15 minutes; other holder launches hourly.
export const holderRewardIntervalMs = launch => paycheckLaunch(launch) ? PAYCHECK_INTERVAL_MS : HOLDER_REWARD_INTERVAL_MS;
export const feeCycleInterval = launch => launch.input.feeMode === 'holders' ? pacedHolderTax(launch) ? TAX_CONVERSION_INTERVAL_MS : holderRewardIntervalMs(launch) : 60000;
export const holderRewardCheckDueAt = launch => Number(launch.lastHolderRewardCheck ?? (launch.lastCycle || launch.authorizedAt || launch.createdAt || 0)) + holderRewardIntervalMs(launch);
export const feeCycleDueAt = launch => {
  if(automaticTaxBacklog(launch))return 0;
  const next = Number(launch.lastCycle || (launch.input.feeMode === 'holders' ? launch.authorizedAt || launch.createdAt || 0 : 0)) + feeCycleInterval(launch);
  return launch.input.feeMode === 'holders' ? Math.min(next, holderRewardCheckDueAt(launch)) : next;
};
export const lastTaxConversionAt = launch => (launch.operations || []).reduce((latest, op) => op.kind === 'sell' ? Math.max(latest, Number(op.createdAt || 0), Number(op.confirmedAt || 0), Number(op.failedAt || 0)) : latest, Number(launch.lastTaxConversionAt || 0));
export const taxConversionDueAt = launch => { if(automaticTaxBacklog(launch))return 0;const last = lastTaxConversionAt(launch); return last ? last + TAX_CONVERSION_INTERVAL_MS : 0; };

// Work entirely in atomic units. Rounding up keeps the default threshold above
// zero even for expensive quote tokens with few decimal places.
export function referenceRewardMinimum(review, cents = 100n) {
  ok(Number.isInteger(review.quoteDecimals) && review.quoteDecimals >= 0 && review.quoteDecimals <= 18, 'Unsupported quote token decimals.');
  const price = units(review.price?.usd, 8, 'Quote price reference');
  ok(price > 0n, 'The quote price reference must be positive.');
  const numerator = 10n ** BigInt(review.quoteDecimals) * 100000000n * cents;
  const denominator = price * 100n;
  const amount = (numerator + denominator - 1n) / denominator;
  ok(amount > 0n && amount <= MAX_TOKEN_UNITS, 'The default holder reward minimum is outside this token’s supported range.');
  return amount;
}

export function holderRewardPolicy(input, review) {
  if (input.feeMode !== 'holders') return null;
  // A Paycheck launch claims its fee vault at $1 and pays each wallet at $0.50; the $100 floor is for taxed holder launches.
  if (paycheckInput(input)) return { policy: PAYCHECK_POLICY, minimumUsd: Number(PAYCHECK_CLAIM_MINIMUM_CENTS) / 100, thresholdUsd: Number(PAYCHECK_THRESHOLD_CENTS) / 100, intervalMinutes: PAYCHECK_INTERVAL_MS / 60000, split: { ...PAYCHECK_SPLIT_BPS }, minimumQuoteUnits: referenceRewardMinimum(review, PAYCHECK_CLAIM_MINIMUM_CENTS).toString(), thresholdQuoteUnits: referenceRewardMinimum(review, PAYCHECK_THRESHOLD_CENTS).toString() };
  return { policy: HOLDER_REWARD_POLICY, minimumUsd: HOLDER_REWARD_MINIMUM_USD, minimumQuoteUnits: referenceRewardMinimum(review,10000n).toString() };
}

export const holderRewardMinimumCents = launch => paycheckLaunch(launch) ? PAYCHECK_CLAIM_MINIMUM_CENTS : 10000n;
export const holderRewardMinimumUsd = launch => Number(holderRewardMinimumCents(launch)) / 100;

export function holderRewardMinimum(launch, reference = launch.holderRewards?.priceReference || launch.review.price) {
  // Legacy developer-selected amounts never determine the current policy.
  return referenceRewardMinimum({...launch.review,price:reference},holderRewardMinimumCents(launch));
}

export function currentHolderRewardMinimum(launch, reference, now = Date.now()) {
  ok(reference?.mint===launch.input.quoteMint&&Number.isSafeInteger(reference.at)&&reference.at<=now&&now-reference.at<=60000&&reference.stale!==true,`A fresh quote price is required for the $${holderRewardMinimumUsd(launch)} holder reward minimum.`);
  return holderRewardMinimum(launch,reference);
}

/** The Paycheck per-wallet payout threshold ($0.50) in quote units at the launch's saved price reference. */
export function paycheckPayoutThreshold(launch, reference = launch.holderRewards?.priceReference || launch.review.price) {
  ok(paycheckLaunch(launch),'This launch does not run Paycheck rewards.');
  return referenceRewardMinimum({...launch.review,price:reference},PAYCHECK_THRESHOLD_CENTS);
}

export function holderRewardDistributionStats(launch) {
  const signatures = new Set(), operations = new Set(), confirmed = [];
  for (const op of launch.operations || []) {
    if (op.kind !== 'payout' || op.state !== 'confirmed' || typeof op.signature !== 'string' || !op.signature || !Number.isSafeInteger(op.slot) || op.slot <= 0) continue;
    if (!/^[0-9]+$/.test(String(op.amount)) || BigInt(op.amount) <= 0n || signatures.has(op.signature) || op.operationId && operations.has(op.operationId)) continue;
    signatures.add(op.signature);if (op.operationId) operations.add(op.operationId);confirmed.push(op);
  }
  const total = confirmed.reduce((sum, op) => sum + BigInt(op.amount), 0n);
  const latest = confirmed.reduce((last, op) => !last || op.slot >= last.slot ? op : last, null);
  let lastAmount = latest ? BigInt(latest.amount) : null;
  let lastAt = latest ? Number(latest.confirmedAt || latest.createdAt || 0) || null : null;
  if (latest?.holderRewardCycleId) lastAmount = confirmed.filter(op => op.holderRewardCycleId === latest.holderRewardCycleId).reduce((sum, op) => sum + BigInt(op.amount), 0n);
  else if (latest && launch.holderRewards?.lastDistributionAt >= (lastAt || 0) && /^[0-9]+$/.test(String(launch.holderRewards.lastDistributionQuoteUnits))) {
    const savedAmount = BigInt(launch.holderRewards.lastDistributionQuoteUnits);
    if (savedAmount > 0n && savedAmount <= total) {lastAmount = savedAmount;lastAt = launch.holderRewards.lastDistributionAt;}
  }
  return {
    totalDistributedQuote: displayUnits(total, launch.review.quoteDecimals),
    totalPayments: confirmed.reduce((sum, op) => sum + (op.payouts || []).filter(row => /^[0-9]+$/.test(String(row.amount)) && BigInt(row.amount) > 0n).length, 0),
    lastDistributionAt: lastAt,
    lastDistributionQuote: lastAmount === null ? null : displayUnits(lastAmount, launch.review.quoteDecimals),
  };
}

// This projection deliberately reports direct tax burns separately from
// purchases, SOL payouts and wallet balances. Only the tracked tax credit is
// eligible; other base-token credit remains reserved.
export function publicHolderTaxBurn(launch) {
  let value;
  try{value=publicTaxBurn(launch);}catch{
    if(!officialTaxBurnScope(launch)||!launch.taxBurn&&!officialTaxBurnConfigured())return null;
    return {policy:TAX_BURN_POLICY,selected:true,enabled:false,paused:true,tokensBurned:null,pendingTaxTokens:null,unattributedTokens:null,completedBurns:null,lastBurnSignature:null,lastBurnAt:null,accountingUnavailable:true};
  }
  if(!value?.selected)return null;
  return {
    policy:value.policy,selected:true,enabled:value.enabled===true,automatic:value.automatic===true,manual:value.manual===true,manualRequested:value.manualRequested===true,paused:value.paused===true,
    tokensBurned:value.burnedBase===null?null:displayUnits(value.burnedBase,6),
    trackedTaxTokensBurned:value.trackedBurnedBase==null?null:displayUnits(value.trackedBurnedBase,6),
    approvedLegacyTokensBurned:value.approvedLegacyBurnedBase==null?null:displayUnits(value.approvedLegacyBurnedBase,6),
    pendingTaxTokens:value.pendingTaxBase===null?null:displayUnits(value.pendingTaxBase,6),
    unattributedTokens:value.unattributedBase===null?null:displayUnits(value.unattributedBase,6),
    completedBurns:Number.isSafeInteger(value.burnCount)&&value.burnCount>=0?value.burnCount:null,
    lastBurnSignature:typeof value.lastBurnSignature==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value.lastBurnSignature)?value.lastBurnSignature:null,
    lastBurnAt:Number.isSafeInteger(value.lastBurnAt)&&value.lastBurnAt>0&&value.lastBurnAt<=8640000000000000?value.lastBurnAt:null,
    accountingUnavailable:value.accountingUnavailable===true,
    initialInventory:value.initialInventory?{approvedTokens:displayUnits(value.initialInventory.approvedBase,6),status:value.initialInventory.status,completedAt:Number.isSafeInteger(value.initialInventory.completedAt)&&value.initialInventory.completedAt>0?value.initialInventory.completedAt:null,signature:typeof value.initialInventory.signature==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value.initialInventory.signature)?value.initialInventory.signature:null}:null,
  };
}

export function publicHolderRewards(launch) {
  // A Gotchi launch has no holder distribution; its pot is shown on the Gotchi page.
  if (launch.input.feeMode !== 'holders' || launch.input.gotchi) return null;
  const decimals = launch.review.quoteDecimals;
  const processing = !!launch.cycle || !!launch.feesRequested || launch.operations.some(op => ['pending', 'awaiting_signature'].includes(op.state));
  const active = launch.curve && launch.state === 'live' && launch.autoFees && !processing;
  const taxBurn=publicHolderTaxBurn(launch);
  const taxEnabled = !taxBurn?.selected&&pacedHolderTax(launch);
  const nextConversion = active && taxEnabled ? Math.max(feeCycleDueAt(launch), taxConversionDueAt(launch)) : null;
  const paycheck = paycheckLaunch(launch) ? publicPaycheck(launch, { decimals }) : null;
  return {
    intervalMinutes: holderRewardIntervalMs(launch) / 60000,
    minimumUsd: holderRewardMinimumUsd(launch),
    minimumPolicy: paycheck ? PAYCHECK_POLICY : HOLDER_REWARD_POLICY,
    paycheck,
    minimumQuote: (()=>{try{return displayUnits(currentHolderRewardMinimum(launch,launch.holderRewards?.priceReference),decimals);}catch{return null;}})(),
    thresholdNote: launch.holderRewards?.thresholdNote || '',
    quoteSymbol: quoteLabel(launch.input.quoteMint, launch.review.quoteSymbol),
    pendingQuote: displayUnits(launch.credits.quote || '0', decimals),
    unconvertedTaxTokens: taxBurn?.selected?null:displayUnits(launch.credits.base || '0', 6),
    taxBurn,
    nextCheckAt: active ? holderRewardCheckDueAt(launch) : null,
    taxConversion: {
      enabled: taxEnabled,
      intervalMinutes: TAX_CONVERSION_INTERVAL_MS / 60000,
      maxTokens: TAX_CONVERSION_MAX_TOKENS,
      backlogThresholdTokens: TAX_CONVERSION_BACKLOG_TOKENS,
      backlogActive: automaticTaxBacklog(launch),
      backlogSellTokens: TAX_CONVERSION_BACKLOG_TOKENS,
      backlogMaximumPriceImpactPercent: TAX_CONVERSION_BURST_MAX_IMPACT_BPS / 100,
      backlogMaximumReservePercent: TAX_CONVERSION_BURST_RESERVE_BPS / 100,
      maxPriceImpactBps: TAX_CONVERSION_MAX_IMPACT_BPS,
      maxReserveBps: TAX_CONVERSION_RESERVE_BPS,
      maximumSupplyPercent: 0.1,
      maximumReservePercent: TAX_CONVERSION_RESERVE_BPS / 100,
      maximumPriceImpactPercent: TAX_CONVERSION_MAX_IMPACT_BPS / 100,
      nextAt: nextConversion,
      nextCheckAt: nextConversion,
      lastAt: lastTaxConversionAt(launch) || null,
      note: launch.taxConversionNote || '',
    },
    ...holderRewardDistributionStats(launch),
  };
}
