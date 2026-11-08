// Robinhood launch venue: the frozen, versioned launch policy (server side). Every launch records the policy hash it
// was quoted under; changing any value means a new version for future launches. The chain holds the fee split
// (the factory's config); the policy records what the service expects there and refuses to run against anything else.
import { createHash } from 'node:crypto';
import { ROBINHOOD_MODES, ROBINHOOD_OPTION_MODES, ROBINHOOD_HOLDER_MODES, ROBINHOOD_TIERS, ROBINHOOD_CHAIN_ID } from '../../public/robinhood-launch-catalog.mjs';

const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const fail = (message, code = 'ROBINHOOD_LAUNCH_POLICY') => { throw Object.assign(Error(message), { code, statusCode: 400 }); };

export const ROBINHOOD_LAUNCH_POLICY_V1 = freeze({
  version: 'robinhood-launch-policy-v3',
  venue: 'robinhood',
  chainId: ROBINHOOD_CHAIN_ID,
  // The factory config every launch uses, and what the service verifies on chain before it opens intake.
  // v71.41: Raydium's fee shape on two Uniswap v4 pools (public/robinhood-launch-catalog.mjs ROBINHOOD_FEES).
  config: { id: '1', totalSupply: '1000000000000000000000000000', curveProtocolFeeBps: 125, curveCreatorFeeBps: 50, poolProtocolFeeBps: 25, poolCreatorFeeBps: 25, taxPlatformShareBps: 500, minTaxBps: 100, maxTaxBps: 300, defaultTaxBps: 200, tickSpacing: 10 },
  tiers: ROBINHOOD_TIERS.map(t => ({ id: t.id, startUsd: t.startUsd, graduationUsd: t.graduationUsd })),
  modes: [...ROBINHOOD_MODES],
  optionModes: [...ROBINHOOD_OPTION_MODES],
  holderModes: [...ROBINHOOD_HOLDER_MODES],
  // Who the coin names as its creator fee recipient on chain: the developer's wallet, or the per-coin fee wallet.
  recipient: { creator: 'developer', holders: 'fee', diamond_hands: 'fee', earned: 'fee', insured: 'fee' },
  // The ledger role the fee wallet's claims belong to.
  role: { holders: 'rewards', diamond_hands: 'rewards', earned: 'escrow', insured: 'insured' },
  launch: { quoteTtlMs: 600000, maxCreateAttempts: 3, maxFundingAgeMs: 86400000, maxPendingLaunches: 3, maxRules: 4, confirmations: 3 },
  // Gas: fixed limits (observed on anvil: a launch with rules and a dev buy is under 5 M), priced from live fees with
  // head room; the unused part of the budget is refunded with the rest of the launch wallet.
  gas: { launchGas: '7000000', approveGas: '80000', transferGas: '30000', claimGas: '120000', collectGas: '400000', payoutGasPerRecipient: '45000', payoutGasBase: '120000', graduateGas: '1500000', feeHeadroomBps: 20000, minimumGasPriceWei: '10000000' },
  // ETH kept on per-coin wallets for their own transactions: the fee wallet claims and pays out, so the launch seeds
  // its gas. On an ETH pair the seed only has to reach the first claim (what it claims pays for the rest, charged to
  // the coin's ledger); on a non-ETH pair it cannot pay gas from what it earns, so the seed carries the coin's life.
  reserves: { feeWalletGasWei: { eth: '1000000000000000', other: '3000000000000000' }, keepWei: '200000000000000', refundDustWei: '20000000000000' },
  // Fee claims from the escrow to the fee wallet, and the locker's LP-fee collection after graduation.
  collection: { intervalMs: 900000, minimumUsd: 2, lockerIntervalMs: 3600000 },
  routing: { sweepMinimumUsd: 5, platformClaimMinimumUsd: 20 },
  holders: { topHolders: 100, windowMinutes: 60, sampleIntervalMinutes: 5, minimumCycleUsd: 100, minimumPayoutUsd: 0.25, batchSize: 200, cycleIntervalMs: 3600000, maxSamplesKept: 36 },
  market: { priceTtlMs: 60000, assetsTtlMs: 3600000, stalePriceMs: 900000 },
});

export const ROBINHOOD_LAUNCH_POLICIES = freeze({ [ROBINHOOD_LAUNCH_POLICY_V1.version]: ROBINHOOD_LAUNCH_POLICY_V1 });
export const ROBINHOOD_LAUNCH_POLICY = ROBINHOOD_LAUNCH_POLICY_V1;
export const policyHash = policy => createHash('sha256').update(JSON.stringify(policy)).digest('hex');
export const ROBINHOOD_LAUNCH_POLICY_HASH = policyHash(ROBINHOOD_LAUNCH_POLICY);

/** The policy a stored launch was quoted under (its version and hash must match a known policy). */
export function policyFor(version, hash) {
  const policy = ROBINHOOD_LAUNCH_POLICIES[version];
  if (!policy) fail(`Unknown Robinhood launch policy ${version}.`, 'ROBINHOOD_LAUNCH_POLICY_UNKNOWN');
  if (hash && policyHash(policy) !== hash) fail('The launch policy on record does not match this release.', 'ROBINHOOD_LAUNCH_POLICY_HASH');
  return policy;
}

export const modeAllowed = mode => ROBINHOOD_LAUNCH_POLICY.modes.includes(mode);
export const tierById = id => ROBINHOOD_LAUNCH_POLICY.tiers.find(t => t.id === id) || null;
export const feeRecipientRole = mode => ROBINHOOD_LAUNCH_POLICY.recipient[mode] || null;
export const ledgerRole = mode => ROBINHOOD_LAUNCH_POLICY.role[mode] || null;

/**
 * The wei a launch needs on its launch wallet: the launch fee, the dev buy when it is ETH, gas for the launch
 * transactions and the refund, and the fee wallet's gas seed on a non-ETH pair. `maxFeePerGas` is the live suggestion.
 */
export function fundingPlan({ launchFeeWei, devBuyWei = 0n, pairIsEth, maxFeePerGas }, policy = ROBINHOOD_LAUNCH_POLICY) {
  const g = policy.gas;
  const gasPrice = BigInt(maxFeePerGas) > BigInt(g.minimumGasPriceWei) ? BigInt(maxFeePerGas) : BigInt(g.minimumGasPriceWei);
  const gasUnits = BigInt(g.launchGas) + (pairIsEth ? 0n : BigInt(g.approveGas)) + BigInt(g.transferGas) * 2n;
  const gasBudget = gasUnits * gasPrice * BigInt(g.feeHeadroomBps) / 10000n;
  const feeWalletGas = BigInt(pairIsEth ? policy.reserves.feeWalletGasWei.eth : policy.reserves.feeWalletGasWei.other);
  const launchFee = BigInt(launchFeeWei), devBuy = pairIsEth ? BigInt(devBuyWei) : 0n;
  return { launchFee, devBuy, gasBudget, feeWalletGas, totalWei: launchFee + devBuy + gasBudget + feeWalletGas, gasPrice };
}
