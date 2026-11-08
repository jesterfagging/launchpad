import { createRequire } from 'node:module';
import BN from 'bn.js';
import { TOTAL_SUPPLY, units, displayUnits, requireValue as ok } from '../public/launchpad-model.mjs';

const require = createRequire(import.meta.url);
const ray = require('@raydium-io/raydium-sdk-v2');
const U64_MAX = 18446744073709551615n;
const ROOT_SCALE = 1000000000000000000n;
const SUPPLY = TOTAL_SUPPLY * 1000000n;
const bn = value => new BN(String(value));
const ceilDiv = (numerator, denominator) => (numerator + denominator - 1n) / denominator;
const abs = value => value < 0n ? -value : value;

function uint64(value, label) {
  const text = String(value ?? '');
  ok(text.length <= 64 && /^(0|[1-9]\d*)$/.test(text), `Invalid ${label} in the Raydium configuration.`);
  const amount = BigInt(text);
  ok(amount <= U64_MAX, `${label} exceeds Raydium's supported range.`);
  return amount;
}

function integerSqrt(value) {
  // Newton's integer iteration decreases from a power-of-two upper bound.
  // Input lengths are bounded by the decimal/u64 checks below.
  if (value < 2n) return value;
  let root = 1n << BigInt(Math.ceil(value.toString(2).length / 2));
  for (let step = 0; step < 256; step++) {
    const next = (root + value / root) / 2n;
    if (next >= root) return root;
    root = next;
  }
  throw Error('The requested bonding curve could not be calculated.');
}

/**
 * Calculate a new constant-product launch with independently specified starting
 * and graduation FDV, at the launch review's quote/USD reference. No accounts
 * are fetched or changed. Legacy saved launches must continue using their
 * original solver and allocation.
 *
 * For supply N, sold amount A, remaining R=N-A, quote raise Q and migration
 * charge M, Raydium's unrounded virtual reserves imply:
 *   starting FDV = N*Q^2*R / ((Q-M)*A^2), graduation FDV = N*(Q-M)/R
 * in raw quote units. With k=sqrt(graduation/start) and G=graduation FDV in raw
 * quote units, A/N = k*(G+M)/(G*(1+k)). For M=0 this is k/(1+k).
 * Keep that derivation in integer arithmetic, then validate the SDK's actual
 * rounded reserves. Transfer taxes affect net receipts and migrated reserves,
 * not the target used for the curve's gross marginal price.
 */
export function rayCurveAtGraduationTarget(config, quoteDecimals, quoteUsd, targetUsd = '20000', graduationUsd = '50000') {
  ok(Number.isInteger(quoteDecimals) && quoteDecimals >= 0 && quoteDecimals <= 18, 'Unsupported token decimals.');
  ok(config?.curveType === 0, 'This launch requires a constant-product Raydium configuration.');
  const price = units(quoteUsd, 8, 'Pairing-asset USD price');
  const start = units(targetUsd, 2, 'Starting FDV') * 1000000n;
  const graduation = units(graduationUsd, 2, 'Graduation FDV') * 1000000n;
  ok(price > 0n && start > 0n && graduation > start, 'Graduation market cap must be higher than the positive starting market cap.');
  const checked = {};
  for (const field of ['migrateFee', 'minSupplyA', 'maxLockRate', 'minSellRateA', 'minMigrateRateA', 'minFundRaisingB']) checked[field] = uint64(config[field], field);
  ok(checked.maxLockRate <= 1000000n && checked.minSellRateA <= 1000000n && checked.minMigrateRateA <= 1000000n, 'Raydium returned invalid allocation limits.');
  const scale = 10n ** BigInt(quoteDecimals), migrationFee = checked.migrateFee;
  const ratio = integerSqrt(graduation * ROOT_SCALE * ROOT_SCALE / start);
  const graduationQuoteNumerator = graduation * scale;
  const sell = SUPPLY * ratio * (graduationQuoteNumerator + migrationFee * price)
    / (graduationQuoteNumerator * (ROOT_SCALE + ratio));
  const rest = SUPPLY - sell;
  ok(sell > SUPPLY / 2n && rest > 0n, 'This pair cannot support the requested starting and graduation market caps.');
  const raise = ceilDiv(graduationQuoteNumerator * rest, SUPPLY * price) + migrationFee;
  ok(raise > migrationFee && raise <= U64_MAX, 'The required quote amount exceeds Raydium’s supported range.');
  ok(raise >= checked.minFundRaisingB, 'This pair’s minimum fundraising amount is above the requested graduation target. Choose another pairing asset.');

  const parameters = {
    supply: bn(SUPPLY), totalSell: bn(sell), totalLockedAmount: bn(0),
    totalFundRaising: bn(raise), migrateFee: bn(migrationFee),
  };
  // Check the actual GlobalConfig rather than assuming the common 20%/15%
  // minimum allocations. Some quote assets have different onchain limits.
  ray.Launchpad.checkParam({ ...parameters, decimals: 6, config, migrateType: 'cpmm' });
  const denominator = (raise - migrationFee) * sell / rest - raise;
  ok(denominator > 0n, 'This pairing asset has insufficient precision for the requested curve. Choose another asset.');
  const curve = ray.Launchpad.getCurve(0).getInitParam(parameters);
  const virtualBase = uint64(curve.a, 'virtual base reserve');
  const virtualQuote = uint64(curve.b, 'virtual quote reserve');
  ok(virtualQuote + raise <= U64_MAX, 'The final virtual quote reserve exceeds Raydium’s supported range.');
  ok(virtualBase > sell && virtualQuote > 0n, 'This pairing asset has insufficient precision for the requested curve. Choose another asset.');
  const actualStart = SUPPLY * virtualQuote * price / (virtualBase * scale);
  const actualGraduation = SUPPLY * (raise - migrationFee) * price / (rest * scale);
  const actualCurveEnd = SUPPLY * (virtualQuote + raise) * price / ((virtualBase - sell) * scale);
  // Same 0.05% maximum valuation error as the existing starting-FDV review.
  // Never substitute a different target to satisfy a minimum or rounding edge.
  ok(abs(actualStart - start) * 2000n <= start
    && abs(actualGraduation - graduation) * 2000n <= graduation
    && abs(actualCurveEnd - graduation) * 2000n <= graduation,
  'This pairing asset cannot represent the requested market caps accurately enough. Choose another asset.');
  return {
    supply: SUPPLY.toString(), sell: sell.toString(), raise: raise.toString(),
    virtualBase: virtualBase.toString(), virtualQuote: virtualQuote.toString(),
    actualUsd: displayUnits(actualStart, 8), graduationUsd: displayUnits(actualGraduation, 8),
  };
}
