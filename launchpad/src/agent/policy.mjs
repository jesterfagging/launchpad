// AI Agent mode: server-side policy maths. Every function here is pure and
// integer-based so the scheduler, the executor and the tests agree exactly.
import { createHash } from 'node:crypto';
import { AGENT_POLICY_V1, AGENT_RATE_CARD_V1, canonicalJson, AGENT_CAPABILITIES } from '../../public/agent-catalog.mjs';
import { integer, nonNegative, positive } from './ledger.mjs';

export const policyHash = policy => createHash('sha256').update(canonicalJson(policy)).digest('hex');
export const AGENT_POLICY_HASH = policyHash(AGENT_POLICY_V1);
// v2 adds Launchpad's platform share of agent fee income for agents launched from
// this release. Operating rules are unchanged from v1. On Raydium and Meteora
// the agent wallet receives the gross creator fee and the share is set aside in
// the agent ledger (protocol_payable) and remitted to the protocol recipient; on
// Pump.fun the share is taken by native fee sharing before the agent receives
// anything, so its receipts are already net and nothing more is deducted.
// The share is published in the docs; it is kept out of the public catalogue.
export const AGENT_POLICY_V2 = Object.freeze({ ...AGENT_POLICY_V1, version: 'agent-policy-v2', funding: Object.freeze({ ...AGENT_POLICY_V1.funding,
  platformShareBps: Object.freeze({ raydium: 1000, meteora: 1000, pump: 2000 }), platformShareCollection: Object.freeze({ raydium: 'agent-ledger', meteora: 'agent-ledger', pump: 'native-fee-sharing' }), platformRemitMinimumLamports: '20000000' }) });
export const AGENT_POLICY_V2_HASH = policyHash(AGENT_POLICY_V2);
export const AGENT_POLICIES = Object.freeze({ [AGENT_POLICY_HASH]: AGENT_POLICY_V1, [AGENT_POLICY_V2_HASH]: AGENT_POLICY_V2 });
/** Basis points of a gross fee receipt the agent ledger sets aside for the platform (0 for v1 agents and for net Pump.fun receipts). */
export function ledgerPlatformShareBps(policyHashValue, venue) {
  const policy = AGENT_POLICIES[policyHashValue]; if (!policy?.funding?.platformShareBps) return 0;
  return policy.funding.platformShareCollection?.[venue] === 'agent-ledger' ? Number(policy.funding.platformShareBps[venue] || 0) : 0;
}
export const USD = 1000000n, LAMPORTS = 1000000000n;
const min = (a, b) => (a < b ? a : b);
const fail = (message, code = 'AGENT_POLICY') => { throw Object.assign(Error(message), { code, statusCode: 409 }); };

/** USD micro-units -> lamports at a SOL/USD price given in USD micro-units per SOL (conservative: floor). */
export function usdToLamports(usdMicro, solUsdMicro) { const usd = nonNegative(usdMicro, 'USD'), price = positive(solUsdMicro, 'SOL price'); return usd * LAMPORTS / price; }
/** lamports -> USD micro-units (floor). */
export function lamportsToUsd(lamports, solUsdMicro) { const value = nonNegative(lamports, 'Lamports'), price = positive(solUsdMicro, 'SOL price'); return value * price / LAMPORTS; }
/** A SOL/USD number (from the market reference) as integer micro-dollars per SOL. */
export function priceMicro(usd) { if (!Number.isFinite(usd) || usd <= 0 || usd > 1e7) fail('A valid SOL/USD reference is required.', 'AGENT_PRICE'); return BigInt(Math.floor(usd * 1e6)); }
export function freshPrice(reference, now, maxAgeMs = AGENT_POLICY_V1.treasury.priceMaxAgeMs) { return !!reference && reference.stale !== true && Number.isFinite(reference.usd) && reference.usd > 0 && Number.isSafeInteger(reference.at) && now - reference.at <= maxAgeMs && reference.at <= now + 5000; }

/**
 * Daily operating budget fixed at the first eligible run of a UTC day: the policy cap (plus a per-agent allowance
 * such as the influencer's daily feature clip, v71.32) bounded by the policy's share of the opening backed balance.
 */
export function dailyBudgetUsd(openingBackedUsd, policy = AGENT_POLICY_V1, allowanceUsd = 0n) {
  const opening = nonNegative(openingBackedUsd, 'Opening balance'), allowance = nonNegative(allowanceUsd, 'Allowance');
  return min(BigInt(policy.budget.agentDailyCapUsd) + allowance, opening * BigInt(policy.budget.agentDailyShareBps) / 10000n);
}
export const dayKey = now => new Date(now).toISOString().slice(0, 10);
export function canActivate(backedUsd, policy = AGENT_POLICY_V1) { return nonNegative(backedUsd, 'Backed') >= BigInt(policy.activation.activateUsd); }
export function shouldSleep(unreservedBackedUsd, nextRunUsd, policy = AGENT_POLICY_V1) { const value = nonNegative(unreservedBackedUsd, 'Backed'); return value < BigInt(policy.activation.sleepBelowUsd) || value < nonNegative(nextRunUsd, 'Next run'); }
export function canResume(unreservedBackedUsd, policy = AGENT_POLICY_V1) { return nonNegative(unreservedBackedUsd, 'Backed') >= BigInt(policy.activation.resumeUsd); }

/** Provider prices are quoted in USD per token (e.g. "0.0000001"); snapshots keep them as integer micro-USD per million tokens (ceil). */
export function pricePerMillionMicro(value) {
  const number = Number(value); if (!Number.isFinite(number) || number < 0 || number > 1) fail('Invalid model price.', 'AGENT_PRICING');
  return BigInt(Math.ceil(number * 1e12));
}
/** Cost in USD micro for a token count at micro-USD-per-million-tokens pricing (ceil). */
export function tokensCostUsd(tokens, microPerMillion) { const n = BigInt(tokens), p = BigInt(microPerMillion); if (n < 0n || p < 0n) fail('Invalid token cost.', 'AGENT_PRICING'); return (n * p + 999999n) / 1000000n; }
/** Worst-case cost of one model call at a pricing snapshot ({promptMicroPerMillion, completionMicroPerMillion}). */
export function modelCallWorstCaseUsd({ promptTokens, maxOutputTokens, pricing }, rateCard = AGENT_RATE_CARD_V1) {
  const cost = tokensCostUsd(promptTokens, pricing.promptMicroPerMillion) + tokensCostUsd(maxOutputTokens, pricing.completionMicroPerMillion);
  const marked = cost + cost * BigInt(rateCard.modelMarkupBps) / 10000n;
  return marked + BigInt(rateCard.modelCallOverheadUsd);
}
/** Worst-case browser charge for a session bounded by the policy (started minutes + teardown). */
export function browserWorstCaseUsd(maxSeconds, rateCard = AGENT_RATE_CARD_V1) { const minutes = BigInt(Math.ceil(Math.max(1, maxSeconds) / 60)); return minutes * BigInt(rateCard.browserMinuteUsd) + BigInt(rateCard.browserSessionOverheadUsd); }
/** Total reservation for a run: the whole worst case, bounded by the policy maximum and never below the minimum useful reservation. */
export function runReservationUsd({ pricing, browser = true }, policy = AGENT_POLICY_V1, rateCard = AGENT_RATE_CARD_V1) {
  const perCall = modelCallWorstCaseUsd({ promptTokens: policy.run.maxPromptTokens, maxOutputTokens: policy.run.maxOutputTokens, pricing }, rateCard);
  const worst = perCall * BigInt(policy.run.maxModelCalls) + (browser ? browserWorstCaseUsd(policy.run.browserMaxSeconds, rateCard) : 0n);
  const bounded = min(worst, BigInt(policy.run.maxReservedUsd));
  return bounded < BigInt(policy.activation.minimumRunUsd) ? BigInt(policy.activation.minimumRunUsd) : bounded;
}

/** Treasury caps for a UTC day from the opening baseline (lamports after gas reserve) and a fresh SOL price. */
export function treasuryCaps({ baselineLamports, solUsdMicro }, policy = AGENT_POLICY_V1) {
  const baseline = nonNegative(baselineLamports, 'Baseline'), t = policy.treasury;
  const usd = value => usdToLamports(BigInt(value), solUsdMicro), share = bps => baseline * BigInt(bps) / 10000n;
  return { perAction: min(usd(t.perActionUsd), share(t.perActionBps)), hourly: min(usd(t.hourlyUsd), share(t.hourlyBps)), daily: min(usd(t.dailyUsd), share(t.dailyBps)), minimumPrincipal: usd(t.minimumPrincipalUsd), gasReserve: BigInt(t.gasReserveLamports), baseline };
}
/**
 * Deterministic policy evaluation of a treasury proposal. Returns the bounded
 * principal or a rejection reason. Everything the model sent is treated as a
 * request, never as an instruction.
 */
export function evaluateTreasuryProposal({ kind, requestedLamports, capabilities, caps, available, pendingLiabilities, spentHourLamports, spentDayLamports, networkCostLamports }, policy = AGENT_POLICY_V1) {
  const capability = kind === 'buyback_burn' ? 'buyback' : kind === 'holder_reward' ? 'rewards' : null;
  if (!capability) return { ok: false, reason: 'Unsupported action kind.' };
  if ((Number(capabilities) & AGENT_CAPABILITIES[capability]) === 0) return { ok: false, reason: `This agent launched without the ${capability} capability.` };
  let requested; try { requested = positive(requestedLamports, 'Requested amount'); } catch { return { ok: false, reason: 'The requested amount is not a positive integer.' }; }
  const free = nonNegative(available, 'Available') - BigInt(caps.gasReserve) - nonNegative(pendingLiabilities, 'Liabilities');
  if (free < caps.minimumPrincipal) return { ok: false, reason: 'The treasury is below the $5 minimum principal after its gas reserve and pending liabilities.' };
  let principal = min(requested, caps.perAction);
  const hourRoom = caps.hourly - nonNegative(spentHourLamports, 'Hour spend'), dayRoom = caps.daily - nonNegative(spentDayLamports, 'Day spend');
  if (hourRoom <= 0n || dayRoom <= 0n) return { ok: false, reason: 'The hourly or daily treasury limit is used up.' };
  principal = min(principal, min(hourRoom, dayRoom));
  const network = nonNegative(networkCostLamports, 'Network cost');
  if (principal + network > free) principal = free - network;
  if (principal < caps.minimumPrincipal) return { ok: false, reason: 'The permitted amount is below the $5 minimum principal.' };
  if (network * 10000n > principal * BigInt(policy.treasury.maxNetworkCostBps)) return { ok: false, reason: 'Estimated network cost exceeds 1% of the action principal; deferred.' };
  return { ok: true, principal, reserved: principal + network, bounded: principal < requested, network };
}
export function rollingWindow(rows, now, windowMs) { return rows.filter(row => row.at >= now - windowMs); }
export const ratePerMillion = micro => Number(micro) / 1e6;
export { integer };
