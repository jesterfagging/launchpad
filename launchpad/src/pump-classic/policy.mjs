// Pump.fun Classic: the frozen, versioned launch policy (server side).
//
// Every launch records PUMP_CLASSIC_POLICY_HASH. The platform share of creator
// fees, reserves and strategy limits for a coin come from the policy version it
// launched with; changing any value means a new version for future launches.
// The share percentages are published in the Revenue section of the docs and are
// deliberately not repeated in user-facing UI copy.
import { createHash } from 'node:crypto';
import { NATIVE_MINT, TOKEN_2022_PROGRAM } from './codec.mjs';
import { PUMP_PROGRAM, PUMP_AMM_PROGRAM, PUMP_FEES_PROGRAM, MAYHEM_PROGRAM } from './instructions.mjs';
import { PUMP_CLASSIC_MODES, PUMP_CLASSIC_STRATEGY_MODES } from '../../public/pump-classic-catalog.mjs';

const fail = (message, code = 'PUMP_CLASSIC_POLICY') => { throw Object.assign(Error(message), { code, statusCode: 400 }); };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

export const PUMP_CLASSIC_POLICY_V1 = freeze({
  version: 'pump-classic-policy-v1',
  venue: 'pump-classic',
  programs: { pump: PUMP_PROGRAM, amm: PUMP_AMM_PROGRAM, fees: PUMP_FEES_PROGRAM, mayhem: MAYHEM_PROGRAM },
  coin: { quoteMint: NATIVE_MINT, baseTokenProgram: TOKEN_2022_PROGRAM, decimals: 6, mayhemMode: false, cashback: false, holderReward: false, customCreatorFee: false },
  // Platform share of the coin's native creator fee, in bps, by launch option.
  platformShareBps: { creator: 1000, holders: 1000, gotchi: 1000, agent: 2000, market_maker: 2000, lp_manager: 2000 },
  // Who holds the remaining share: the developer directly, or a per-coin Launchpad wallet.
  recipient: { creator: 'developer', holders: 'rewards', gotchi: 'gotchi', agent: 'agent', market_maker: 'strategy', lp_manager: 'strategy' },
  launch: { maxDevBuyLamports: '25000000000', quoteTtlMs: 600000, tokenTolerancePpm: 10000, maxCreateAttempts: 3, maxFundingAgeMs: 86400000 },
  // The setup budget covers every account the launch creates (mint, curve, fee sharing,
  // token accounts, volume accumulator) and network fees; any unused part is refunded.
  costs: { setupBudgetLamports: '50000000', networkFeeCapLamports: '300000', priorityMicroLamports: 20000, computeUnits: 700000 },
  reserves: {
    collectorGasLamports: '5000000',
    modeGasLamports: { creator: '0', holders: '20000000', gotchi: '3000000', agent: '3000000', market_maker: '20000000', lp_manager: '20000000' },
  },
  seed: { modes: ['market_maker', 'lp_manager'], maxLamports: '50000000000' },
  collection: { intervalMs: 900000, minimumLamports: '20000000', minimumNetworkMultiple: 100, gasFloatLamports: '5000000' },
  routing: { sweepMinimumLamports: '20000000', keepLamports: '2000000' },
  holders: { topHolders: 100, windowMinutes: 60, sampleIntervalMinutes: 5, minimumCycleLamports: '100000000', minimumPayoutLamports: '1000000', batchSize: 4, cycleIntervalMs: 3600000 },
  strategies: {
    market_maker: {
      targetBaseBps: 5000, bandBps: 1000, maxAdjustmentBps: 1000, cooldownMs: 120000, flipCooldownMs: 600000, pollMs: 20000,
      slippageBps: 100, maxImpactBps: 200, dailyTurnoverBps: 20000, dailyFeeCapBps: 200, lossLimitBps: 2000, reversalGuardBps: 100,
      minTradeLamports: '10000000', cashReserveLamports: '10000000', maxFailures: 3,
    },
    lp_manager: { minDepositLamports: '100000000', slippageBps: 100, maxImpactBps: 200, cashReserveLamports: '10000000', pollMs: 60000, maxFailures: 3, lossLimitBps: 5000 },
  },
});
// v71.19: pairs beyond SOL. Every value shared with v1 is unchanged; v1 coins keep v1.
export const PUMP_CLASSIC_POLICY_V2 = freeze({
  version: 'pump-classic-policy-v2',
  venue: 'pump-classic',
  programs: { pump: PUMP_PROGRAM, amm: PUMP_AMM_PROGRAM, fees: PUMP_FEES_PROGRAM, mayhem: MAYHEM_PROGRAM },
  // Pairs: SOL plus each quote asset Pump.fun admits for new coins when the
  // launch is quoted (its listed quote and its custom pairs), if Launchpad can
  // handle the mint exactly. Custom pairs may carry a creator-chosen creator fee.
  coin: { quotes: 'pump-approved', baseTokenProgram: TOKEN_2022_PROGRAM, decimals: 6, mayhemMode: false, cashback: false, holderReward: false, customCreatorFee: 'creator-choice-on-custom-pairs' },
  // Options whose wallets trade or settle in SOL pair with SOL only.
  solOnlyModes: ['agent', 'market_maker', 'lp_manager'],
  // Options whose share Launchpad converts to SOL before paying it out; they need a pair Launchpad can convert.
  convertModes: ['holders', 'gotchi'],
  platformShareBps: { creator: 1000, holders: 1000, gotchi: 1000, agent: 2000, market_maker: 2000, lp_manager: 2000 },
  recipient: { creator: 'developer', holders: 'rewards', gotchi: 'gotchi', agent: 'agent', market_maker: 'strategy', lp_manager: 'strategy' },
  // A dev buy on another pair is capped at the same size, scaled by Pump's initial curve reserves for that pair.
  launch: { maxDevBuyLamports: '25000000000', quoteTtlMs: 600000, tokenTolerancePpm: 10000, maxCreateAttempts: 3, maxFundingAgeMs: 86400000 },
  costs: { setupBudgetLamports: '50000000', quoteSetupBudgetLamports: '60000000', networkFeeCapLamports: '300000', priorityMicroLamports: 20000, computeUnits: 700000 },
  reserves: {
    collectorGasLamports: '5000000',
    modeGasLamports: { creator: '0', holders: '20000000', gotchi: '3000000', agent: '3000000', market_maker: '20000000', lp_manager: '20000000' },
    // On another pair the platform receipt wallet also opens shareholder token
    // accounts and pays conversions; option wallets pay their conversions.
    quoteCollectorGasLamports: '12000000',
    quoteModeGasLamports: { creator: '0', holders: '25000000', gotchi: '8000000' },
  },
  seed: { modes: ['market_maker', 'lp_manager'], maxLamports: '50000000000' },
  // Thresholds in SOL; on another pair they are scaled by the coin's initial curve reserves.
  collection: { intervalMs: 900000, minimumLamports: '20000000', minimumNetworkMultiple: 100, gasFloatLamports: '5000000' },
  conversion: { minimumLamports: '20000000', maxNetworkCostLamports: '5000000', intervalMs: 900000 },
  routing: { sweepMinimumLamports: '20000000', keepLamports: '2000000' },
  holders: { topHolders: 100, windowMinutes: 60, sampleIntervalMinutes: 5, minimumCycleLamports: '100000000', minimumPayoutLamports: '1000000', batchSize: 4, cycleIntervalMs: 3600000 },
  strategies: {
    market_maker: {
      targetBaseBps: 5000, bandBps: 1000, maxAdjustmentBps: 1000, cooldownMs: 120000, flipCooldownMs: 600000, pollMs: 20000,
      slippageBps: 100, maxImpactBps: 200, dailyTurnoverBps: 20000, dailyFeeCapBps: 200, lossLimitBps: 2000, reversalGuardBps: 100,
      minTradeLamports: '10000000', cashReserveLamports: '10000000', maxFailures: 3,
    },
    lp_manager: { minDepositLamports: '100000000', slippageBps: 100, maxImpactBps: 200, cashReserveLamports: '10000000', pollMs: 60000, maxFailures: 3, lossLimitBps: 5000 },
  },
});
// v71.22: dev buys on other pairs are paid in SOL, and launches need less SOL up
// front. v1 and v2 coins keep their own policy.
export const PUMP_CLASSIC_POLICY_V3 = freeze({
  version: 'pump-classic-policy-v3',
  venue: 'pump-classic',
  programs: { pump: PUMP_PROGRAM, amm: PUMP_AMM_PROGRAM, fees: PUMP_FEES_PROGRAM, mayhem: MAYHEM_PROGRAM },
  coin: { quotes: 'pump-approved', baseTokenProgram: TOKEN_2022_PROGRAM, decimals: 6, mayhemMode: false, cashback: false, holderReward: false, customCreatorFee: 'creator-choice-on-custom-pairs' },
  solOnlyModes: ['agent', 'market_maker', 'lp_manager'],
  convertModes: ['holders', 'gotchi'],
  platformShareBps: { creator: 1000, holders: 1000, gotchi: 1000, agent: 2000, market_maker: 2000, lp_manager: 2000 },
  recipient: { creator: 'developer', holders: 'rewards', gotchi: 'gotchi', agent: 'agent', market_maker: 'strategy', lp_manager: 'strategy' },
  launch: { maxDevBuyLamports: '25000000000', quoteTtlMs: 600000, tokenTolerancePpm: 10000, maxCreateAttempts: 3, maxFundingAgeMs: 86400000 },
  // A dev buy on another pair is paid in SOL. Once the funding is final, Launchpad
  // buys the pair asset with exactly that SOL through the treasury's verified
  // route (at most 1% slippage and 2% price impact), then creates the coin with
  // what it received. The reviewed minimum allows the asset's price to move
  // `quoteDriftBps` between the quote and the purchase; a purchase that cannot
  // guarantee it is not sent. After `maxAttempts` failed purchases the SOL is
  // refunded instead. If the coin is not created after a purchase, the asset is
  // sold back to SOL before the refund (up to `unwindAttempts` tries, then it is
  // returned as is).
  pairDevBuy: { funding: 'sol', slippageBps: 100, maxImpactBps: 200, quoteDriftBps: 100, maxNetworkCostLamports: '5000000', maxAttempts: 4, unwindAttempts: 3 },
  // Setup budgets cover the accounts a launch creates and its network fees, with
  // headroom; the unused part is refunded right after the launch. Typical mainnet
  // cost: about 0.0135 SOL for a SOL coin with a dev buy, about 0.016 SOL for a
  // coin on another pair before its dev-buy accounts.
  costs: { setupBudgetLamports: '20000000', quoteSetupBudgetLamports: '35000000', estimatedSetupLamports: '14000000', estimatedQuoteSetupLamports: '24000000', networkFeeCapLamports: '300000', priorityMicroLamports: 20000, computeUnits: 700000 },
  // Operating reserves: SOL the coin's Launchpad wallets keep for their own network
  // fees and token accounts (not refunded; they pay for fee collection, payouts
  // and conversions over the coin's life).
  reserves: {
    collectorGasLamports: '2000000',
    modeGasLamports: { creator: '0', holders: '5000000', gotchi: '2000000', agent: '3000000', market_maker: '10000000', lp_manager: '10000000' },
    quoteCollectorGasLamports: '7000000',
    quoteModeGasLamports: { creator: '0', holders: '8000000', gotchi: '6000000' },
  },
  seed: { modes: ['market_maker', 'lp_manager'], maxLamports: '50000000000' },
  collection: { intervalMs: 900000, minimumLamports: '20000000', minimumNetworkMultiple: 100, gasFloatLamports: '5000000' },
  conversion: { minimumLamports: '20000000', maxNetworkCostLamports: '5000000', intervalMs: 900000 },
  routing: { sweepMinimumLamports: '20000000', keepLamports: '2000000' },
  holders: { topHolders: 100, windowMinutes: 60, sampleIntervalMinutes: 5, minimumCycleLamports: '100000000', minimumPayoutLamports: '1000000', batchSize: 4, cycleIntervalMs: 3600000 },
  strategies: {
    market_maker: {
      targetBaseBps: 5000, bandBps: 1000, maxAdjustmentBps: 1000, cooldownMs: 120000, flipCooldownMs: 600000, pollMs: 20000,
      slippageBps: 100, maxImpactBps: 200, dailyTurnoverBps: 20000, dailyFeeCapBps: 200, lossLimitBps: 2000, reversalGuardBps: 100,
      minTradeLamports: '10000000', cashReserveLamports: '10000000', maxFailures: 3,
    },
    lp_manager: { minDepositLamports: '100000000', slippageBps: 100, maxImpactBps: 200, cashReserveLamports: '10000000', pollMs: 60000, maxFailures: 3, lossLimitBps: 5000 },
  },
});
// v71.23: a wider spread for SOL-paid dev buys on other pairs. The purchase may
// slip 2% on chain (v3: 1%), and the pair asset's price may move 5% between the
// quote and the purchase (v3: 1%), so a launch is not refunded over a small move.
// The reviewed minimum shown in the quote is that much lower. The purchase budget
// is 0.01 SOL (v3: 0.005): a route through another asset creates a token account
// for it (about 0.002 SOL each) besides the pair asset's own; the unused part is
// refunded after launch. Everything else is v3's; v3 coins keep v3.
export const PUMP_CLASSIC_POLICY_V4 = freeze({
  ...PUMP_CLASSIC_POLICY_V3,
  version: 'pump-classic-policy-v4',
  pairDevBuy: { ...PUMP_CLASSIC_POLICY_V3.pairDevBuy, slippageBps: 200, quoteDriftBps: 500, maxNetworkCostLamports: '10000000' },
});
// v71.35: three more launch options and reward baskets. Diamond Hands is
// Holders with a streak ledger (same share, reserves and pair rules as
// Holders). Earned and Insured pay their escrow or pot to the developer and
// holders in SOL, so they pair with SOL only; their wallets keep the Holders
// reserve for payouts. A Holders coin may name up to two more reward assets
// (`basket`): every payout round is split equally, the extra shares are bought
// at market from the rewards wallet under the treasury route guard, and the top
// holders are paid every asset. Everything else is v4's; v1–v4 coins keep their
// own policy.
export const PUMP_CLASSIC_POLICY_V5 = freeze({
  ...PUMP_CLASSIC_POLICY_V4,
  version: 'pump-classic-policy-v5',
  solOnlyModes: ['agent', 'market_maker', 'lp_manager', 'earned', 'insured'],
  convertModes: ['holders', 'gotchi', 'diamond_hands'],
  platformShareBps: { ...PUMP_CLASSIC_POLICY_V4.platformShareBps, diamond_hands: 1000, earned: 1000, insured: 1000 },
  recipient: { ...PUMP_CLASSIC_POLICY_V4.recipient, diamond_hands: 'rewards', earned: 'escrow', insured: 'insured' },
  reserves: {
    ...PUMP_CLASSIC_POLICY_V4.reserves,
    modeGasLamports: { ...PUMP_CLASSIC_POLICY_V4.reserves.modeGasLamports, diamond_hands: '5000000', earned: '5000000', insured: '5000000' },
    quoteModeGasLamports: { ...PUMP_CLASSIC_POLICY_V4.reserves.quoteModeGasLamports, diamond_hands: '8000000' },
  },
  // Earned records the market cap once a day from creation (the first record is the baseline); Insured checks its
  // deadline hourly (graduation itself is seen by the venue tracker). A refund or bonus payout starts at once.
  options: { earned: { checkIntervalMs: 86400000 }, insured: { checkIntervalMs: 3600000 } },
  // Reward baskets (Holders only): at most two extra assets; a share is bought with 1% slippage and at most 2% price
  // impact, three attempts per round before it is paid in the main asset instead; shares under the minimum are not
  // bought (network costs would eat them) and stay in the main asset; the route check at launch spends nothing.
  basket: { modes: ['holders'], maxExtras: 2, conversionSlippageBps: 100, conversionMaxImpactBps: 200, conversionAttempts: 3, minimumLegLamports: '5000000', maxNetworkCostLamports: '10000000', probeLamports: '250000000' },
});
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}
const policyHash = policy => createHash('sha256').update(canonicalJson(policy)).digest('hex');
export const PUMP_CLASSIC_POLICY_V1_HASH = policyHash(PUMP_CLASSIC_POLICY_V1);
export const PUMP_CLASSIC_POLICY_V2_HASH = policyHash(PUMP_CLASSIC_POLICY_V2);
export const PUMP_CLASSIC_POLICY_V3_HASH = policyHash(PUMP_CLASSIC_POLICY_V3);
export const PUMP_CLASSIC_POLICY_V4_HASH = policyHash(PUMP_CLASSIC_POLICY_V4);
export const PUMP_CLASSIC_POLICY_V5_HASH = policyHash(PUMP_CLASSIC_POLICY_V5);
/** The policy new launches use. */
export const PUMP_CLASSIC_POLICY = PUMP_CLASSIC_POLICY_V5;
export const PUMP_CLASSIC_POLICY_HASH = PUMP_CLASSIC_POLICY_V5_HASH;
export const POLICIES = Object.freeze({ [PUMP_CLASSIC_POLICY_V1_HASH]: PUMP_CLASSIC_POLICY_V1, [PUMP_CLASSIC_POLICY_V2_HASH]: PUMP_CLASSIC_POLICY_V2, [PUMP_CLASSIC_POLICY_V3_HASH]: PUMP_CLASSIC_POLICY_V3, [PUMP_CLASSIC_POLICY_V4_HASH]: PUMP_CLASSIC_POLICY_V4, [PUMP_CLASSIC_POLICY_V5_HASH]: PUMP_CLASSIC_POLICY_V5 });
/** Whether a policy pays a dev buy on another pair in SOL (Launchpad buys the pair asset) instead of in the pair asset. */
export const pairDevBuyInSol = policy => policy?.pairDevBuy?.funding === 'sol';
export const policyFor = hash => POLICIES[hash] || fail('This coin uses an unknown Pump.fun Classic policy.', 'PUMP_CLASSIC_POLICY_UNKNOWN');

export const validMode = mode => PUMP_CLASSIC_MODES.includes(mode);
const SOL_ONLY_LABELS = { agent: 'AI Agent', market_maker: 'Market Maker', lp_manager: 'Liquidity Manager', earned: 'Earned', insured: 'Insured' };
/** "AI Agent, Market Maker, Liquidity Manager, Earned and Insured launches pair with SOL only." for a policy. */
export function solOnlyText(policy = PUMP_CLASSIC_POLICY) {
  const names = (policy.solOnlyModes || []).map(mode => SOL_ONLY_LABELS[mode] || mode);
  return `${names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names.at(-1) : names[0] || 'These'} launches pair with SOL only.`;
}
export const isStrategyMode = mode => PUMP_CLASSIC_STRATEGY_MODES.includes(mode);
/** Whether an option may pair with a quote asset other than SOL under this policy (v1: never). */
export const quotePairAllowed = (mode, policy = PUMP_CLASSIC_POLICY) => validMode(mode) && Array.isArray(policy.solOnlyModes) && !policy.solOnlyModes.includes(mode);
export function platformShareBps(mode, policy = PUMP_CLASSIC_POLICY) {
  if (!validMode(mode)) fail('Unsupported Pump.fun launch option.');
  const bps = policy.platformShareBps[mode];
  if (!Number.isInteger(bps) || bps <= 0 || bps >= 10000) fail('Invalid platform share.');
  return bps;
}
/** Native fee-sharing shareholders: [platform receipt wallet, mode recipient]. Order is the on-chain order. */
export function shareholdersFor(mode, { protocolWallet, recipient }, policy = PUMP_CLASSIC_POLICY) {
  const bps = platformShareBps(mode, policy);
  if (!protocolWallet || !recipient || protocolWallet === recipient) fail('Fee sharing needs two distinct recipients.');
  return [{ address: protocolWallet, shareBps: bps }, { address: recipient, shareBps: 10000 - bps }];
}
const lamports = (value, label) => { const n = BigInt(String(value ?? '0')); if (n < 0n) fail(`Invalid ${label}.`); return n; };
/**
 * The SOL a developer funds for one launch, and how it is used. All values are
 * lamports. On another pair (`quotePair`) the setup and reserves use the pair
 * amounts. Under v1 and v2 a dev buy there is funded separately in the pair
 * asset, so `devBuyLamports` must be 0; from v3 it is paid in SOL and the plan
 * adds the conversion's network budget.
 */
export function fundingPlan({ mode, devBuyLamports = 0n, seedLamports = 0n, quotePair = false }, policy = PUMP_CLASSIC_POLICY) {
  if (!validMode(mode)) fail('Unsupported Pump.fun launch option.');
  const devBuy = lamports(devBuyLamports, 'dev buy'), seed = lamports(seedLamports, 'seed capital');
  if (devBuy > BigInt(policy.launch.maxDevBuyLamports)) fail('The dev buy exceeds the launch limit.');
  if (seed > 0n && !policy.seed.modes.includes(mode)) fail('Seed capital is only available for Market Maker and Liquidity Manager.');
  if (seed > BigInt(policy.seed.maxLamports)) fail('The seed capital exceeds the launch limit.');
  if (quotePair) {
    if (!quotePairAllowed(mode, policy)) fail(solOnlyText(policy), 'PUMP_CLASSIC_SOL_ONLY');
    if (devBuy > 0n && !pairDevBuyInSol(policy)) fail('A dev buy on this pair is funded in the pair asset.');
  }
  const setup = BigInt(quotePair ? policy.costs.quoteSetupBudgetLamports : policy.costs.setupBudgetLamports);
  const conversion = quotePair && devBuy > 0n ? BigInt(policy.pairDevBuy.maxNetworkCostLamports) : 0n;
  const collector = BigInt(quotePair ? policy.reserves.quoteCollectorGasLamports : policy.reserves.collectorGasLamports);
  const modeGas = BigInt((quotePair ? policy.reserves.quoteModeGasLamports : policy.reserves.modeGasLamports)[mode]);
  const total = devBuy + setup + conversion + collector + modeGas + seed;
  return {
    devBuyLamports: devBuy.toString(), setupBudgetLamports: setup.toString(), ...(conversion > 0n ? { conversionBudgetLamports: conversion.toString() } : {}), collectorGasLamports: collector.toString(),
    modeGasLamports: modeGas.toString(), seedLamports: seed.toString(), totalLamports: total.toString(),
  };
}
