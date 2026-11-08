import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DAMM_PUMP_POLICY, dammPumpCurveAtGraduationTarget } from '../src/damm-pump-policy.mjs';
import { DAMM_PUMP_ADMIN_TEST_POLICY, dammPumpAdminTestCurveAtGraduationTarget as micro } from '../src/damm-pump-admin-test-policy.mjs';

test('admin micro economics remain isolated from immutable public economics', () => {
  assert.equal(DAMM_PUMP_POLICY.startUsd, '20000');
  assert.equal(DAMM_PUMP_POLICY.graduationUsd, '50000');
  assert.equal(DAMM_PUMP_ADMIN_TEST_POLICY.startUsd, '50');
  assert.equal(DAMM_PUMP_ADMIN_TEST_POLICY.graduationUsd, '100');
  assert.notEqual(DAMM_PUMP_ADMIN_TEST_POLICY.version, DAMM_PUMP_POLICY.version);
  assert.throws(() => dammPumpCurveAtGraduationTarget({ quoteDecimals: 6, quoteUsd: '1', startUsd: '50', graduationUsd: '100' }));
  assert.throws(() => micro({ quoteDecimals: 6, quoteUsd: '1', startUsd: '20000', graduationUsd: '50000' }));
  assert.throws(() => micro({ quoteDecimals: 6, quoteUsd: '1', startUsd: '51' }));
});

test('micro policy keeps actual DAMM and PumpSwap prices inside five basis points', () => {
  for (const [quoteUsdMicros, quoteDecimals] of [['1000000', 6], ['150000000', 9], ['100000000000', 8], ['250125000', 6], ['1', 6], ['100000000000', 18]]) {
    const m = micro({ quoteUsdMicros, quoteDecimals });
    assert(Object.isFrozen(m));
    assert.equal(BigInt(m.baseForSale) + BigInt(m.baseReserved), 1000000000000000n);
    assert.equal(m.initialQuote, '0');
    assert.equal(m.quoteSeedRaw, '1');
    assert.equal(m.creatorFeeBps, 0);
    assert.equal(m.transferTaxBps, 0);
    assert.equal(m.poolFeeBps, 125);
    assert(Math.abs(Number(m.actualStartUsd) / 50 - 1) < 0.0005);
    assert(Math.abs(Number(m.actualGraduationUsd) / 100 - 1) < 0.0005);
    assert(Math.abs(Number(m.actualMigrationUsd) / 100 - 1) < 0.0005);
    assert(BigInt(m.endpointQuoteRoundedUp) - BigInt(m.finalQuote) <= 1n);
  }
});

test('micro policy matches exact stablecoin split and principal', () => {
  const m = micro({ quoteDecimals: 6, quoteUsd: '1' });
  assert.equal(m.baseForSale, '676060562607558');
  assert.equal(m.baseReserved, '323939437392442');
  assert.equal(m.finalQuote, '47804700');
  assert.equal(m.estimatedMigrationLiquidityUsd, '64.787888');
  assert.equal(m.graduationFeeRaw, '15410756');
  assert.equal(m.migrationQuoteRaw, '32393944');
  assert.equal(BigInt(m.finalQuote), BigInt(m.graduationFeeRaw)+BigInt(m.migrationQuoteRaw));
});

test('micro precision and malformed values reject instead of changing the test price', () => {
  for (const params of [
    { quoteDecimals: 0, quoteUsd: '1' },
    { quoteDecimals: 19, quoteUsd: '1' },
    { quoteDecimals: 9, quoteUsd: '0' },
    { quoteDecimals: 6, quoteUsd: '1', supplyTokens: '100000000' },
    { quoteDecimals: 6, quoteUsd: '1', baseDecimals: 9 },
    { quoteDecimals: 6, quoteUsd: '1', quoteUsdMicros: '2000000' },
  ]) assert.throws(() => micro(params));
});

test('separate test program address and executable are pinned without replacing production', async () => {
  const admin = new PublicKey('7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS');
  const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
  const program = await PublicKey.createWithSeed(admin, 'launchpad-program-4', loader);
  assert.equal(program.toBase58(), 'CzgJRVKJSmAibnZAjkEYqmAVvxyCSSukjxNG2y7b62NU');
  assert.equal(PublicKey.findProgramAddressSync([program.toBuffer()], loader)[0].toBase58(), '8kvT3drS36j6qaMie5j2HgqLDMfxLbdLqPsy75VASrc4');
  const hash = async path => createHash('sha256').update(await readFile(new URL(path, import.meta.url))).digest('hex');
  assert.equal(await hash('../private/damm-pump-admin-test/curve_damm_pump_admin_test.so'), '948d26bc525ef14483d0132a0685f5dbfc6c885306904648bb8bc2728d14cf91');
  assert.equal(await hash('../private/damm-pump/curve_damm_pump.so'), '5b45c7f3e114f5e8ccd73aaf12f500fb654915e7ab8656d169d54a3ad6f2d252');
});
