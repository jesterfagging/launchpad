import { buildCurveWithMarketCap, validateConfigParameters, TokenType, TokenAuthorityOption } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { GOTCHI_METEORA_POLICY } from '../public/gotchi-catalog.mjs';

export const METEORA_POLICY = Object.freeze({
  version: 1, initialFdvUsd: 20_000, graduationFdvUsd: 50_000,
  supply: 1_000_000_000, decimals: 6, tradingFeeBps: 188,
  creatorSharePercent: 33, partnerSharePercent: 67,
  permanentLockPercent: 100, migrationFeePercentage: 0,
  creatorMigrationFeePercentage: 0, meteoraMigrationFeeBps: 20,
});
// The only alternative fee schedule: the frozen Gotchi preset. A launch stores
// its preset object as `launch.policy`; every later verification derives the
// expected onchain numbers from that saved copy, never from live settings.
export const METEORA_PRESETS = Object.freeze({ [GOTCHI_METEORA_POLICY.preset]: GOTCHI_METEORA_POLICY });
// Starting market caps a launch may record (a white-label launchpad may offer the $4,000 start; every launch graduates at
// $50,000). A launch without one starts at $20,000, like every launch before the option existed.
export const METEORA_START_FDVS = Object.freeze([20_000, 4_000]);
export function meteoraPolicy(overrides = {}) {
  const migrationFeePercentage = overrides.migrationFeePercentage ?? 0;
  if (migrationFeePercentage !== 0) throw new Error('Launchpad Meteora launches have no graduation fee.');
  const initialFdvUsd = overrides.initialFdvUsd ?? METEORA_POLICY.initialFdvUsd;
  if (!METEORA_START_FDVS.includes(initialFdvUsd)) throw new Error('Unknown Meteora starting market cap.');
  if (overrides.preset === undefined) {
    for (const key of ['tradingFeeBps','creatorSharePercent','partnerSharePercent']) if (overrides[key] !== undefined && overrides[key] !== METEORA_POLICY[key]) throw new Error('Meteora fee overrides require a reviewed preset.');
    return { ...METEORA_POLICY, migrationFeePercentage, initialFdvUsd };
  }
  const preset = METEORA_PRESETS[overrides.preset];
  if (!preset) throw new Error('Unknown Meteora fee preset.');
  for (const key of ['tradingFeeBps','creatorSharePercent','partnerSharePercent']) if (overrides[key] !== undefined && overrides[key] !== preset[key]) throw new Error('The saved Meteora preset values differ from the reviewed preset.');
  return { ...METEORA_POLICY, ...preset, migrationFeePercentage, initialFdvUsd };
}
export const meteoraFeeNumerator = policy => String(meteoraPolicy(policy).tradingFeeBps * 100000);
// Meteora keeps 20% of every DBC/DAMM trading fee; the remainder is split by
// the creator share. These are display figures for public launch records.
export function meteoraFeeShares(policy) {
  const p = meteoraPolicy(policy), net = p.tradingFeeBps * 0.8;
  return { totalTradeFeeBps: p.tradingFeeBps, creatorFeeBps: Number((net * p.creatorSharePercent / 100).toFixed(6)), partnerFeeBps: Number((net * p.partnerSharePercent / 100).toFixed(6)), creatorSharePercent: p.creatorSharePercent, partnerSharePercent: p.partnerSharePercent };
}
// Transfer hook rules (v71.28): a hooked coin is a Token-2022 mint created by
// Meteora's createConfigWithTransferHook / createPoolWithTransferHook. Its token
// authority option is Immutable exactly like every plain Launchpad launch: Meteora's
// program requires a revoked mint authority only for non-hook configs and allows
// Immutable for hook configs, so the mint authority is revoked at creation and
// nobody can ever mint more. Both members are taken from the SDK by name so a
// renumbered enum can never silently change a launch.
export const meteoraHookTokenOptions = () => ({ tokenType: TokenType.Token2022, tokenAuthorityOption: TokenAuthorityOption.Immutable });
/** All monetary input is snapshotted once per launch. Never rebuild from a later quote price. `hooked` selects the Token-2022 transfer-hook token options. */
export function meteoraCurveConfig({ quoteUsd, quoteDecimals, policy = {}, hooked = false }) {
  const p = meteoraPolicy(policy), hook = hooked ? meteoraHookTokenOptions() : null;
  if (!Number.isFinite(quoteUsd) || quoteUsd <= 0 || !Number.isInteger(quoteDecimals) || quoteDecimals < 0 || quoteDecimals > 18) throw new Error('A verified quote mint and positive USD price are required.');
  const params = buildCurveWithMarketCap({
    token: { tokenType: hook ? hook.tokenType : 0, tokenBaseDecimal: p.decimals, tokenQuoteDecimal: quoteDecimals, tokenAuthorityOption: hook ? hook.tokenAuthorityOption : 1, totalTokenSupply: p.supply, leftover: 0 },
    fee: { baseFeeParams: { baseFeeMode: 0, feeSchedulerParam: { startingFeeBps: p.tradingFeeBps, endingFeeBps: p.tradingFeeBps, numberOfPeriod: 0, totalDuration: 0 } }, dynamicFeeEnabled: false, collectFeeMode: 0, creatorTradingFeePercentage: p.creatorSharePercent, poolCreationFee: 0, enableFirstSwapWithMinFee: false },
    migration: { migrationOption: 1, migrationFeeOption: 6, migrationFee: { feePercentage: p.migrationFeePercentage, creatorFeePercentage: 0 }, migratedPoolFee: { collectFeeMode: 0, dynamicFee: 0, poolFeeBps: p.tradingFeeBps } },
    liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: p.partnerSharePercent, partnerLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: p.creatorSharePercent, creatorLiquidityPercentage: 0 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: 1, initialMarketCap: p.initialFdvUsd / quoteUsd, migrationMarketCap: p.graduationFdvUsd / quoteUsd,
  });
  validateConfigParameters({ ...params, leftoverReceiver: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' });
  return params;
}
