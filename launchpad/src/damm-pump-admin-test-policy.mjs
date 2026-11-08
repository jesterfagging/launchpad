/** Isolated owner-only test economics; never selected by the public launch policy. */
import { createRequire } from 'node:module';
import BN from 'bn.js';

const require = createRequire(import.meta.url);
const damm = require('@meteora-ag/cp-amm-sdk');
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const Q128 = 1n << 128n;
const USD_SCALE = 1000000n;
const SUPPLY = 1000000000000000n;
const START_USD_MICROS = 50000000n;
const END_USD_MICROS = 100000000n;
const GRADUATION_FEE_NUMERATOR = 322369073n;
const GRADUATION_FEE_DENOMINATOR = 1000000000n;
const RELATIVE_ERROR_DENOMINATOR = 2000n; // At most 0.05%, including migration rounding.
const bn = value => new BN(String(value));
const abs = value => value < 0n ? -value : value;
const ok = (condition, message) => { if (!condition) throw new Error(message); };
const ceilDiv = (numerator, denominator) => (numerator + denominator - 1n) / denominator;

export const DAMM_PUMP_ADMIN_TEST_POLICY = Object.freeze({
  version: 'damm-pump-admin-test-50-100-fee-v1',
  supplyTokens: '1000000000', supply: SUPPLY.toString(), baseDecimals: 6,
  startUsd: '50', graduationUsd: '100',
  graduationFeeNumerator: GRADUATION_FEE_NUMERATOR.toString(), graduationFeeDenominator: GRADUATION_FEE_DENOMINATOR.toString(),
  graduationFeePercent: 32.2369073,
  poolFeeBps: 125,
  estimatedProtocolFeeBps: 100,
  meteoraProtocolFeePercent: 20,
  creatorFeeBps: 0, transferTaxBps: 0,
  collectFeeMode: damm.CollectFeeMode.OnlyB,
  compoundingFeeBps: 0,
  quoteSeedRaw: '1', maximumRelativeErrorBps: 5,
});

function rawInteger(value, label, maximum = U64_MAX) {
  ok(typeof value === 'string' || typeof value === 'bigint'
    || (typeof value === 'number' && Number.isSafeInteger(value)), `${label} must be an exact integer.`);
  const text = String(value);
  ok(text.length <= 40 && /^(0|[1-9]\d*)$/.test(text), `${label} must be an exact nonnegative integer.`);
  const result = BigInt(text);
  ok(result <= maximum, `${label} exceeds the supported range.`);
  return result;
}

function usdMicros(value, label) {
  ok(typeof value === 'string' || typeof value === 'number', `${label} must be a plain positive decimal.`);
  const text = String(value).trim();
  ok(text.length <= 64 && /^(0|[1-9]\d*)(\.\d+)?$/.test(text), `${label} must be a plain positive decimal.`);
  const [whole, rawFraction = ''] = text.split('.');
  const fraction = rawFraction.replace(/0+$/, '');
  ok(fraction.length <= 6, `${label} cannot be represented by the required six-decimal USD reference.`);
  const result = BigInt(whole) * USD_SCALE + BigInt(fraction.padEnd(6, '0') || '0');
  ok(result > 0n && result <= U64_MAX, `${label} is outside the supported USD-reference range.`);
  return result;
}

function decimal(value, decimals) {
  const scale = 10n ** BigInt(decimals);
  const fractional = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${value / scale}${fractional ? `.${fractional}` : ''}`;
}

function integerSqrt(value) {
  ok(value >= 0n, 'Cannot calculate a negative reserve price.');
  if (value < 2n) return value;
  let root = 1n << BigInt(Math.ceil(value.toString(2).length / 2));
  for (;;) {
    const next = (root + value / root) / 2n;
    if (next >= root) return root;
    root = next;
  }
}

function withinTolerance(numerator, denominator, expected) {
  return denominator > 0n
    && abs(numerator - expected * denominator) * RELATIVE_ERROR_DENOMINATOR <= expected * denominator;
}

/**
 * Immutable, no-network math for a standard 1B / six-decimal DAMM -> PumpSwap launch.
 * USD references are integer micro-dollars. Base and quote amounts are raw units.
 * The quote reference is fixed at review; a floating quote/USD price can subsequently
 * move the USD endpoints. This function does not approve a mint's token extensions.
 *
 * For Q64 sqrt prices a,b, DAMM's SDK liquidity representation is:
 *   L = floor(B*a*b/(b-a)); initial base = ceil(L*(b-a)/(a*b));
 *   endpoint quote withdrawal = floor(L*(b-a)/2^128).
 * Swap fees are noncompounding and excluded from this principal. The mandatory
 * one-raw-unit initialization transfer is separate from the zero active quote.
 */
export function dammPumpAdminTestCurveAtGraduationTarget({
  quoteDecimals, quoteUsd, quoteUsdMicros,
  startUsd = DAMM_PUMP_ADMIN_TEST_POLICY.startUsd,
  graduationUsd = DAMM_PUMP_ADMIN_TEST_POLICY.graduationUsd,
  supplyTokens = DAMM_PUMP_ADMIN_TEST_POLICY.supplyTokens,
  baseDecimals = DAMM_PUMP_ADMIN_TEST_POLICY.baseDecimals,
} = {}) {
  ok(Number.isInteger(quoteDecimals) && quoteDecimals >= 0 && quoteDecimals <= 18,
    'This pairing asset has unsupported token decimals.');
  ok(baseDecimals === 6 && rawInteger(supplyTokens, 'Token supply') === 1000000000n,
    'PumpSwap launches require one billion tokens with six decimals.');
  ok(usdMicros(startUsd, 'Starting FDV') === START_USD_MICROS
    && usdMicros(graduationUsd, 'Graduation FDV') === END_USD_MICROS,
  'PumpSwap launches require a $50 start and $100 graduation.');
  const reference = quoteUsdMicros === undefined
    ? usdMicros(quoteUsd, 'Pairing-asset USD price')
    : rawInteger(quoteUsdMicros, 'Pairing-asset USD micro-dollar price');
  ok(reference > 0n, 'Pairing-asset USD price must be positive.');
  if (quoteUsd !== undefined && quoteUsdMicros !== undefined) {
    ok(usdMicros(quoteUsd, 'Pairing-asset USD price') === reference,
      'Pairing-asset USD references disagree. Refresh the launch review.');
  }
  const scale = 10n ** BigInt(quoteDecimals);
  const priceDenominator = reference * SUPPLY;
  const sqrtMin = integerSqrt(START_USD_MICROS * scale * Q128 / priceDenominator);
  const sqrtMax = integerSqrt(END_USD_MICROS * scale * Q128 / priceDenominator);
  ok(sqrtMin >= BigInt(damm.MIN_SQRT_PRICE.toString())
    && sqrtMax <= BigInt(damm.MAX_SQRT_PRICE.toString()) && sqrtMax > sqrtMin,
  'This pairing asset cannot represent the required DAMM price range.');

  // Allocate sale/reserve for the net post-fee migration ratio, keeping all 1B tokens.
  const budget = SUPPLY * sqrtMax * GRADUATION_FEE_DENOMINATOR
    / (sqrtMax * GRADUATION_FEE_DENOMINATOR + sqrtMin * (GRADUATION_FEE_DENOMINATOR - GRADUATION_FEE_NUMERATOR));
  const min = bn(sqrtMin), max = bn(sqrtMax);
  const liquidity = BigInt(damm.getLiquidityDeltaFromAmountAForConcentratedLiquidity(bn(budget), min, max).toString());
  ok(liquidity > 0n && liquidity <= U128_MAX,
    'This pairing asset exceeds DAMM’s supported liquidity range.');
  const initial = damm.getInitialConcentratedLiquidityPoolInformation(min, max, min, bn(liquidity));
  const baseForSale = BigInt(initial.tokenAAmount.toString());
  const initialQuote = BigInt(initial.tokenBAmount.toString());
  const baseReserved = SUPPLY - baseForSale;
  const finalQuote = BigInt(damm.getAmountBFromLiquidityDeltaForConcentratedLiquidity(
    min, max, bn(liquidity), damm.Rounding.Down,
  ).toString());
  const endpointQuoteRoundedUp = BigInt(damm.getAmountBFromLiquidityDeltaForConcentratedLiquidity(
    min, max, bn(liquidity), damm.Rounding.Up,
  ).toString());
  ok(initialQuote === 0n && baseForSale > SUPPLY / 2n && baseForSale <= budget && baseReserved > 0n,
    'This pairing asset cannot support the required one-sided allocation.');
  ok(finalQuote > 0n && endpointQuoteRoundedUp < U64_MAX,
    'This pairing asset exceeds the supported quote-reserve range.');

  const graduationFee = finalQuote * GRADUATION_FEE_NUMERATOR / GRADUATION_FEE_DENOMINATOR;
  const migrationQuote = finalQuote - graduationFee;
  // Reject coarse / extreme quote units instead of changing the launch economics.
  const marginalDenominator = Q128 * scale;
  const initialUsdNumerator = sqrtMin * sqrtMin * SUPPLY * reference;
  const endUsdNumerator = sqrtMax * sqrtMax * SUPPLY * reference;
  const migrationUsdNumerator = migrationQuote * SUPPLY * reference;
  const migrationUsdDenominator = baseReserved * scale;
  ok(withinTolerance(initialUsdNumerator, marginalDenominator, START_USD_MICROS)
    && withinTolerance(endUsdNumerator, marginalDenominator, END_USD_MICROS)
    && withinTolerance(migrationUsdNumerator, migrationUsdDenominator, END_USD_MICROS)
    && abs(migrationQuote * Q128 - baseReserved * sqrtMax * sqrtMax) * RELATIVE_ERROR_DENOMINATOR
      <= baseReserved * sqrtMax * sqrtMax,
  'This pairing asset has insufficient precision to preserve the $50 start and $100 migration price.');

  // Defensive agreement with the closed-form Rust validator; no floating point.
  ok(liquidity === budget * sqrtMin * sqrtMax / (sqrtMax - sqrtMin)
    && baseForSale === ceilDiv(liquidity * (sqrtMax - sqrtMin), sqrtMin * sqrtMax)
    && finalQuote === liquidity * (sqrtMax - sqrtMin) / Q128,
  'DAMM SDK arithmetic differs from the reviewed launch policy.');
  const humanUsd = (numerator, denominator) => decimal(numerator * 100n / denominator, 8);
  return Object.freeze({
    policy: DAMM_PUMP_ADMIN_TEST_POLICY.version,
    ...DAMM_PUMP_ADMIN_TEST_POLICY,
    quoteDecimals, quoteUsdMicros: reference.toString(), quoteUsd: decimal(reference, 6),
    supply: SUPPLY.toString(), baseForSale: baseForSale.toString(), baseReserved: baseReserved.toString(),
    liquidity: liquidity.toString(), sqrtMinPrice: sqrtMin.toString(), sqrtMaxPrice: sqrtMax.toString(),
    initSqrtPrice: sqrtMin.toString(), initialBase: baseForSale.toString(), initialQuote: '0',
    finalBase: '0', finalQuote: finalQuote.toString(),
    graduationFeeRaw: graduationFee.toString(), migrationQuoteRaw: migrationQuote.toString(),
    endpointQuoteRoundedUp: endpointQuoteRoundedUp.toString(),
    endpointRoundingDustRaw: (endpointQuoteRoundedUp - finalQuote).toString(),
    actualStartUsd: humanUsd(initialUsdNumerator, marginalDenominator),
    actualGraduationUsd: humanUsd(endUsdNumerator, marginalDenominator),
    actualMigrationUsd: humanUsd(migrationUsdNumerator, migrationUsdDenominator),
    estimatedGraduationFeeUsd: humanUsd(graduationFee * reference, scale),
    estimatedGrossQuoteUsd: humanUsd(finalQuote * reference, scale),
    estimatedMigrationLiquidityUsd: humanUsd(2n * migrationQuote * reference, scale),
  });
}
