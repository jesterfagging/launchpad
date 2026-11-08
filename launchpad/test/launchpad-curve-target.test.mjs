import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import BN from 'bn.js';
import { rayCurveAtGraduationTarget } from '../src/launchpad-curve-target.mjs';

const require = createRequire(import.meta.url);
const ray = require('@raydium-io/raydium-sdk-v2');
const fixture = JSON.parse(readFileSync(new URL('./launchpad-accounts.json', import.meta.url)));
const solConfig = ray.LaunchpadConfig.decode(Buffer.from(fixture.rayConfig.account.data[0], 'base64'));
const bn = value => new BN(String(value));
// The low-raise configuration reproduces current USDC/stock/PreStocks bounds.
// Price references in these deterministic tests are illustrative, not live data.
const quoteConfig = (overrides = {}) => ({ ...solConfig, minFundRaisingB: bn(1), minSellRateA: bn(1), maxLockRate: bn(999999), ...overrides });
const price = (quote, base, supply, decimals, usd) => Number(quote) / Number(base) * Number(supply) / (10 ** decimals) * usd;

test('the default launches at $20k and graduates near $50k with about $38.7k gross marked liquidity', () => {
  const result = rayCurveAtGraduationTarget(quoteConfig(), 6, '1');
  assert.ok(Math.abs(Number(result.actualUsd) - 20000) < 0.01);
  assert.ok(Math.abs(Number(result.graduationUsd) - 50000) < 0.01);
  assert.ok(Math.abs(Number(result.raise) * 2 / 1000000 - 38742.588672) < 0.01);
});

test('current mainnet SOL allocation limits allow $20k starts and $50k/$70k/$75k/$80k graduation', () => {
  assert.equal(solConfig.minSellRateA.toString(), '200000');
  for (const usd of ['40', '100', '250']) for (const graduation of ['50000', '70000', '75000', '80000']) {
    const result = rayCurveAtGraduationTarget(solConfig, 9, usd, '20000', graduation);
    const { supply, sell, raise, virtualBase, virtualQuote } = Object.fromEntries(Object.entries(result).slice(0, 5).map(([key, value]) => [key, BigInt(value)]));
    assert.equal(supply, 1000000000000000n);
    assert.ok(Math.abs(Number(result.actualUsd) - 20000) < 0.01);
    assert.ok(Math.abs(Number(result.graduationUsd) - Number(graduation)) < 0.01);
    assert.ok(Math.abs(price(virtualQuote + raise, virtualBase - sell, supply, 9, Number(usd)) - Number(graduation)) < 0.01);
    const k = Math.sqrt(Number(graduation) / 20000);
    assert.ok(Math.abs(Number(sell) / Number(supply) - k / (1 + k)) < 1e-12);
    assert.ok(raise >= BigInt(solConfig.minFundRaisingB.toString()));
  }
});

test('tiny minimum raises do not evaluate an invalid zero-denominator curve', () => {
  for (const [decimals, usd] of [[3, '0.001'], [6, '1'], [6, '300'], [8, '100000'], [9, '100'], [12, '1']]) {
    for (const graduation of ['50000', '70000', '75000', '80000']) {
      const result = rayCurveAtGraduationTarget(quoteConfig(), decimals, usd, '20000', graduation);
      assert.ok(Math.abs(Number(result.actualUsd) / 20000 - 1) <= 0.0005);
      assert.ok(Math.abs(Number(result.graduationUsd) / Number(graduation) - 1) <= 0.0005);
      assert.equal(Number.isFinite(Number(result.virtualBase)), true);
    }
  }
});

test('admin starts can explicitly keep the 2.5-times graduation ratio', () => {
  const result = rayCurveAtGraduationTarget(solConfig, 9, '150', '100000', '250000');
  assert.ok(Math.abs(Number(result.actualUsd) - 100000) < 0.01);
  assert.ok(Math.abs(Number(result.graduationUsd) - 250000) < 0.01);
  assert.ok(Math.abs(Number(result.sell) / Number(result.supply) - 0.612574113277) < 1e-12);
});

test('nonzero migration charges adjust allocation and keep both endpoints within tolerance', () => {
  for (const [decimals, usd, fee] of [[9, '150', '2000000000'], [6, '1', '100000000'], [8, '60000', '100000']]) {
    const config = quoteConfig({ migrateFee: bn(fee) });
    const result = rayCurveAtGraduationTarget(config, decimals, usd);
    const supply = BigInt(result.supply), sell = BigInt(result.sell), raise = BigInt(result.raise);
    assert.ok(Math.abs(Number(result.actualUsd) - 20000) < 0.01);
    assert.ok(Math.abs(Number(result.graduationUsd) - 50000) < 0.01);
    const initial = price(result.virtualQuote, result.virtualBase, supply, decimals, Number(usd));
    const end = price(BigInt(result.virtualQuote) + raise, BigInt(result.virtualBase) - sell, supply, decimals, Number(usd));
    const migrated = price(raise - BigInt(fee), supply - sell, supply, decimals, Number(usd));
    assert.ok(Math.abs(initial - 20000) < 0.01);
    assert.ok(Math.abs(end - 50000) < 0.01);
    assert.ok(Math.abs(migrated - 50000) < 0.01);
    assert.ok(Number(sell) / Number(supply) > 0.612574113277);
  }
});

test('standard and 1–3% taxed-token swaps remain quoteable on the lower curve', () => {
  for (const [decimals, usd] of [[6, '1'], [9, '150'], [9, '100']]) for (const graduation of ['50000', '70000', '75000', '80000']) {
    const result = rayCurveAtGraduationTarget(quoteConfig(), decimals, usd, '20000', graduation);
    const poolInfo = { virtualA: bn(result.virtualBase), virtualB: bn(result.virtualQuote), realA: bn(0), realB: bn(0), totalSellA: bn(result.sell), totalFundRaisingB: bn(result.raise) };
    const args = { poolInfo, amountB: bn(result.raise).divn(10), curveType: 0, protocolFeeRate: bn(2500), platformFeeRate: bn(10000), creatorFeeRate: bn(0), shareFeeRate: bn(0), slot: 450000000 };
    const plain = ray.Launchpad.buyExactIn(args);
    for (const tax of [100, 200, 300]) {
      const transferFee = { epoch: 0n, transferFeeBasisPoints: tax, maximumFee: 18446744073709551615n };
      const transferFeeConfigA = { olderTransferFee: transferFee, newerTransferFee: transferFee };
      const bought = ray.Launchpad.buyExactIn({ ...args, transferFeeConfigA });
      assert.equal(bought.amountA.amount.toString(), plain.amountA.amount.toString());
      const gross = BigInt(bought.amountA.amount.toString());
      const expectedTax = (gross * BigInt(tax) + 9999n) / 10000n;
      assert.equal(bought.amountA.fee.toString(), expectedTax.toString());
      const fees = Object.values(bought.splitFee).reduce((sum, amount) => sum.add(amount), bn(0));
      const boughtPool = { ...poolInfo, realA: bought.amountA.amount, realB: bought.amountB.sub(fees) };
      const sold = ray.Launchpad.sellExactIn({ ...args, poolInfo: boughtPool, amountA: bn(gross - expectedTax), transferFeeConfigA });
      assert.ok(sold.amountB.gtn(0));
      assert.ok(sold.amountB.lt(bought.amountB));
      assert.equal(sold.splitFee.creatorFee.toString(), '0');
    }
    const creator = ray.Launchpad.buyExactIn({ ...args, creatorFeeRate: bn(5000) });
    assert.ok(creator.splitFee.creatorFee.gtn(0));
  }
});

test('onchain minimums reject incompatible targets without changing the curve', () => {
  for (const overrides of [
    { minFundRaisingB: bn('1000000000000000') },
    { minSellRateA: bn(800000) },
    { minMigrateRateA: bn(400000) },
    { minSupplyA: bn(1000000001) },
  ]) assert.throws(() => rayCurveAtGraduationTarget(quoteConfig(overrides), 9, '150'));
});

test('unsupported precision and reserve overflows fail rather than approximating a different target', () => {
  assert.throws(() => rayCurveAtGraduationTarget(quoteConfig(), 0, '100000'), /precision|accurately/);
  assert.throws(() => rayCurveAtGraduationTarget(quoteConfig(), 18, '0.00000001'), /supported range/);
  assert.throws(() => rayCurveAtGraduationTarget(quoteConfig(), 9, '100', '74999.99', '75000'), /supported range/);
  assert.throws(() => rayCurveAtGraduationTarget(quoteConfig({ migrateFee: bn('1000000000000000') }), 9, '150'), /cannot support/);
});

test('invalid references, targets and configurations are rejected deterministically', () => {
  for (const values of [[9, '0'], [9, '-1'], [9, 'NaN'], [9, 'Infinity'], [9, '1e3'], [19, '1'], [-1, '1'], [6.5, '1'], [9, '1', '0'], [9, '1', '75000', '75000'], [9, '1', '80000', '75000']]) {
    assert.throws(() => rayCurveAtGraduationTarget(quoteConfig(), ...values));
  }
  for (const overrides of [{ curveType: 1 }, { migrateFee: bn(-1) }, { minSellRateA: bn(1000001) }, { minFundRaisingB: '18446744073709551616' }]) {
    assert.throws(() => rayCurveAtGraduationTarget(quoteConfig(overrides), 9, '150'));
  }
  const config = quoteConfig(), before = JSON.stringify(config);
  assert.deepEqual(rayCurveAtGraduationTarget(config, 9, '150'), rayCurveAtGraduationTarget(config, 9, '150'));
  assert.equal(JSON.stringify(config), before);
});
