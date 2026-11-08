import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import BN from 'bn.js';
import { DAMM_PUMP_POLICY, dammPumpCurveAtGraduationTarget as curve } from '../src/damm-pump-policy.mjs';

const require = createRequire(import.meta.url);
const damm = require('@meteora-ag/cp-amm-sdk');
const Q128 = 1n << 128n;
const supply = 1000000000000000n;
const bn = value => new BN(String(value));
const absolute = value => value < 0n ? -value : value;
const cases = [
  [6, '1'], [9, '118.17'], [8, '100000'], [6, '250.125'],
  [3, '0.001'], [6, '0.000001'], [12, '12.345678'], [18, '100000'], [0, '1'],
];

test('USDC launch preserves the independently derived 20k -> 50k economics for one billion tokens', () => {
  const plan = curve({ quoteDecimals: 6, quoteUsd: '1' });
  assert.equal(plan.supply, '1000000000000000');
  assert.equal(plan.baseDecimals, 6);
  assert.equal(plan.baseForSale, '612574113277206');
  assert.equal(plan.baseReserved, '387425886722794');
  assert.equal(plan.finalQuote, '19371294336');
  assert.equal(plan.initialQuote, '0');
  assert.equal(plan.quoteSeedRaw, '1');
  assert.equal(plan.finalBase, '0');
  assert.equal(plan.graduationFeeRaw, '0');
  assert.ok(Math.abs(Number(plan.estimatedMigrationLiquidityUsd) - 38742.588672279) < 0.00001);
  assert.equal(plan.poolFeeBps, 125);
  assert.equal(plan.estimatedProtocolFeeBps, 100);
  assert.equal(plan.creatorFeeBps, 0);
  assert.equal(plan.transferTaxBps, 0);
  assert.equal(plan.collectFeeMode, damm.CollectFeeMode.OnlyB);
  assert.equal(plan.compoundingFeeBps, 0);
});

test('quote decimals and USD references preserve allocation, endpoint prices and migration continuity', () => {
  for (const [quoteDecimals, quoteUsd] of cases) {
    const plan = curve({ quoteDecimals, quoteUsd });
    const min = BigInt(plan.sqrtMinPrice), max = BigInt(plan.sqrtMaxPrice);
    const reference = BigInt(plan.quoteUsdMicros), scale = 10n ** BigInt(quoteDecimals);
    const allocated = BigInt(plan.baseForSale), reserve = BigInt(plan.baseReserved);
    assert.equal(allocated + reserve, supply);
    assert.ok(allocated > supply / 2n && allocated < supply * 2n / 3n);
    assert.equal(plan.initSqrtPrice, plan.sqrtMinPrice);
    for (const [price, target] of [[min, 20000000000n], [max, 50000000000n]]) {
      const expectedNumerator = target * scale * Q128;
      const actualNumerator = price * price * supply * reference;
      assert.ok(actualNumerator <= expectedNumerator, 'floor square root must not overshoot FDV');
      assert.ok((price + 1n) ** 2n * supply * reference > expectedNumerator,
        'sqrt price must be the greatest representable price below the target');
      assert.ok(absolute(actualNumerator - expectedNumerator) * 2000n <= expectedNumerator);
    }
    const migrationNumerator = BigInt(plan.finalQuote) * Q128;
    const endNumerator = reserve * max * max;
    assert.ok(absolute(migrationNumerator - endNumerator) * 2000n <= endNumerator);
    assert.ok(BigInt(plan.finalQuote) <= (1n << 64n) - 1n);
    assert.ok(BigInt(plan.liquidity) <= (1n << 128n) - 1n);
  }
});

test('SDK cap-filling swap and full-position withdrawal agree with immutable principal across quote units', () => {
  for (const [quoteDecimals, quoteUsd] of cases) {
    const plan = curve({ quoteDecimals, quoteUsd });
    const min = bn(plan.sqrtMinPrice), max = bn(plan.sqrtMaxPrice), liquidity = bn(plan.liquidity);
    const initial = damm.getInitialConcentratedLiquidityPoolInformation(min, max, min, liquidity);
    const fill = damm.calculateBtoAFromPartialAmountInForConcentratedLiquidity(
      max, min, liquidity, bn(plan.endpointQuoteRoundedUp).addn(100),
    );
    assert.equal(initial.tokenAAmount.toString(), plan.initialBase);
    assert.equal(initial.tokenBAmount.toString(), '0');
    assert.equal(fill.nextSqrtPrice.toString(), plan.sqrtMaxPrice);
    assert.ok(fill.amountLeft.gtn(0), 'excess input must remain unused at the cap');
    const unsoldRounding = BigInt(plan.initialBase) - BigInt(fill.outputAmount.toString());
    assert.ok(unsoldRounding >= 0n && unsoldRounding <= 1n);
    const withdrawB = damm.getAmountBFromLiquidityDeltaForConcentratedLiquidity(min, max, liquidity, damm.Rounding.Down);
    const withdrawA = damm.getAmountAFromLiquidityDeltaForConcentratedLiquidity(max, max, liquidity, damm.Rounding.Down);
    assert.equal(withdrawB.toString(), plan.finalQuote);
    assert.equal(withdrawA.toString(), plan.finalBase);
    assert.ok(BigInt(plan.endpointQuoteRoundedUp) - BigInt(plan.finalQuote) <= 1n);
  }
});

test('decimal and exact micro-dollar entry points agree without a Number roundtrip', () => {
  assert.deepEqual(curve({ quoteDecimals: 9, quoteUsd: '118.1700000' }),
    curve({ quoteDecimals: 9, quoteUsdMicros: '118170000' }));
  const reference = '1000000000000000001';
  const plan = curve({ quoteDecimals: 18, quoteUsdMicros: reference });
  assert.equal(plan.quoteUsdMicros, reference);
  assert.equal(plan.quoteUsd, '1000000000000.000001');
  assert.throws(() => curve({ quoteDecimals: 6, quoteUsd: '1', quoteUsdMicros: '1000001' }), /disagree/);
  assert.throws(() => curve({ quoteDecimals: 6, quoteUsdMicros: Number(reference) }), /exact integer/);
});

test('insufficient precision and u64/u128 overflow reject instead of silently changing economics', () => {
  for (const args of [
    { quoteDecimals: 0, quoteUsd: '10000' },
    { quoteDecimals: 18, quoteUsd: '0.000001' },
    { quoteDecimals: 18, quoteUsd: '0.1' },
    { quoteDecimals: 0, quoteUsdMicros: '18446744073709551615' },
  ]) assert.throws(() => curve(args), /precision|range/);
  assert.throws(() => curve({ quoteDecimals: 9, quoteUsd: '0.0000001' }), /six-decimal USD reference/);
});

test('policy cannot be overridden by changing supply, decimals or FDV arguments', () => {
  for (const override of [
    { supplyTokens: '100000000' }, { baseDecimals: 9 }, { startUsd: '10000' },
    { startUsd: '40000', graduationUsd: '100000' }, { graduationUsd: '50001' },
  ]) assert.throws(() => curve({ quoteDecimals: 6, quoteUsd: '1', ...override }), /require/);
});

test('invalid or ambiguous USD references and decimals fail before reserve math', () => {
  for (const quoteUsd of ['', '0', '-1', 'NaN', 'Infinity', '1e3', '01', {}, null, '9'.repeat(65)]) {
    assert.throws(() => curve({ quoteDecimals: 6, quoteUsd }));
  }
  for (const quoteUsdMicros of ['0', '-1', '1.1', '01', '18446744073709551616', {}, null]) {
    assert.throws(() => curve({ quoteDecimals: 6, quoteUsdMicros }));
  }
  for (const quoteDecimals of [-1, 19, 6.5, '6', Infinity, NaN]) {
    assert.throws(() => curve({ quoteDecimals, quoteUsd: '1' }), /decimals/);
  }
  assert.throws(() => curve());
});

test('snapshots are deterministic, frozen and JSON serializable without mutating inputs', () => {
  const input = Object.freeze({ quoteDecimals: 6, quoteUsdMicros: '1000000' });
  const a = curve(input), b = curve(input);
  assert.deepEqual(a, b);
  assert.equal(Object.isFrozen(a), true);
  assert.equal(Object.isFrozen(DAMM_PUMP_POLICY), true);
  assert.throws(() => { a.baseReserved = '0'; }, TypeError);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
});
