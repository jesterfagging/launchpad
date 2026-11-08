import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { DAMM_PUMP_POLICY, dammPumpCurveAtGraduationTarget as legacy } from '../src/damm-pump-policy.mjs';
import { DAMM_PUMP_FEE_POLICY, dammPumpFeeCurveAtGraduationTarget as feeAware } from '../src/damm-pump-fee-policy.mjs';

test('future public fee economics do not change legacy launch terms', () => {
  const old = legacy({ quoteDecimals: 6, quoteUsd: '1' });
  const future = feeAware({ quoteDecimals: 6, quoteUsd: '1' });
  assert.notEqual(DAMM_PUMP_POLICY.version, DAMM_PUMP_FEE_POLICY.version);
  assert.equal(old.graduationFeeRaw, '0');
  assert.equal(old.baseForSale, '612574113277206');
  assert.equal(old.baseReserved, '387425886722794');
  assert.equal(old.finalQuote, '19371294336');
  assert.equal(future.baseForSale, '700000000055453');
  assert.equal(future.baseReserved, '299999999944547');
  assert.equal(future.finalQuote, '22135943622');
  assert.equal(future.graduationFeeRaw, '7135943625');
  assert.equal(future.migrationQuoteRaw, '14999999997');
  assert.equal(future.estimatedMigrationLiquidityUsd, '29999.999994');
  assert.equal(future.estimatedGraduationFeeUsd, '7135.943625');
});

test('fee-aware public geometry preserves fixed endpoints and total supply across quote units', () => {
  for (const [quoteUsdMicros, quoteDecimals] of [['1000000', 6], ['150000000', 9], ['100000000000', 8], ['250125000', 6], ['1', 6], ['100000000000', 18]]) {
    const m = feeAware({ quoteUsdMicros, quoteDecimals });
    assert(Object.isFrozen(m));
    assert.equal(BigInt(m.baseForSale) + BigInt(m.baseReserved), 1000000000000000n);
    assert.equal(BigInt(m.graduationFeeRaw), BigInt(m.finalQuote) * 322369073n / 1000000000n);
    assert.equal(BigInt(m.migrationQuoteRaw) + BigInt(m.graduationFeeRaw), BigInt(m.finalQuote));
    assert(Math.abs(Number(m.actualStartUsd) / 20000 - 1) < 0.0005);
    assert(Math.abs(Number(m.actualGraduationUsd) / 50000 - 1) < 0.0005);
    assert(Math.abs(Number(m.actualMigrationUsd) / 50000 - 1) < 0.0005);
    assert(Math.abs(Number(m.estimatedMigrationLiquidityUsd) / 30000 - 1) < 0.0005);
  }
});

test('future public fee policy rejects economics supplied by callers', () => {
  for (const params of [
    { startUsd: '50', graduationUsd: '100' },
    { startUsd: '20001' },
    { graduationUsd: '50001' },
    { supplyTokens: '100000000' },
    { baseDecimals: 9 },
  ]) assert.throws(() => feeAware({ quoteDecimals: 6, quoteUsd: '1', ...params }));
});

test('future public fee program has its own deterministic deployment', async () => {
  const admin = new PublicKey('7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS');
  const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
  const program = await PublicKey.createWithSeed(admin, 'launchpad-program-3', loader);
  assert.equal(program.toBase58(), '5F4tt5fQwSR9ymzx5KiYL4Q2Ln8FJxbMfbXD1HhMgUrw');
  assert.equal(PublicKey.findProgramAddressSync([program.toBuffer()], loader)[0].toBase58(), 'GxZuLjDyHZhDG7vft5uh6UMJfF7pG4a8PZQtEZYcKwTo');
});
