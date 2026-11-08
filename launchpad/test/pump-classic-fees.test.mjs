// Pump.fun fee math with Pump's live buyback setting (v71.21). Pump's
// buyback_basis_points is the share of the protocol fee that goes to its
// buyback recipients (at most 10,000 bps of that fee), not a further fee on
// trades. Mainnet PumpSwap's config held 5,000 when it was captured on
// September 28, 2026. Charging it as a trade fee made every Pump.fun quote fail
// with "The current Pump fee is outside the reviewed range". Dependency-free:
// uses the vendored IDL and the captured mainnet account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { base58Encode, SYSTEM_PROGRAM } from '../src/pump-classic/codec.mjs';
import { encodeAccount } from '../src/pump-classic/idl.mjs';
import * as ix from '../src/pump-classic/instructions.mjs';
import * as fx from '../src/pump-classic/effects.mjs';
import { curveFeeBps, quoteCurveFeeBps, ammFeeBps } from '../src/pump-classic/math.mjs';

const wallet = n => base58Encode(createHash('sha256').update('pump-classic-fees:' + n).digest());
const zero = SYSTEM_PROGRAM;
const global = (buyback, extra = {}) => ({
  initialized: true, authority: wallet('auth'), fee_recipient: wallet('fee0'), initial_virtual_token_reserves: 1073000000000000n, initial_virtual_sol_reserves: 30000000000n, initial_real_token_reserves: 793100000000000n,
  token_total_supply: 1000000000000000n, fee_basis_points: 95n, withdraw_authority: wallet('w'), enable_migrate: true, pool_migration_fee: 15000001n, creator_fee_basis_points: 30n,
  fee_recipients: Array.from({ length: 7 }, (_, i) => wallet('fee' + (i + 1))), set_creator_authority: wallet('s'), admin_set_creator_authority: wallet('a'), create_v2_enabled: true, whitelist_pda: zero, reserved_fee_recipient: wallet('r'), mayhem_mode_enabled: true,
  reserved_fee_recipients: Array.from({ length: 7 }, (_, i) => wallet('rr' + i)), is_cashback_enabled: true, buyback_fee_recipients: Array.from({ length: 8 }, (_, i) => wallet('bb' + i)), buyback_basis_points: buyback, initial_virtual_quote_reserves: 0n,
  whitelisted_quote_mints: [wallet('usdc')], creator_fee_configurable: true, max_configurable_creator_fee_bps: 300n, holder_reward_claim_authority: zero, is_holder_reward_enabled: true, ...extra,
});
const fees = (lp, protocol, creator) => ({ lp_fee_bps: lp, protocol_fee_bps: protocol, creator_fee_bps: creator });
// Pump's published schedule: 0.95% protocol + 0.30% creator on the bonding
// curve, then the PumpSwap tiers by market cap (lamports).
const TIERS = [[0n, fees(0n, 95n, 30n)], [420000000000n, fees(20n, 5n, 95n)], [1470000000000n, fees(20n, 5n, 90n)], [98240000000000n, fees(20n, 5n, 5n)]].map(([t, f]) => ({ market_cap_lamports_threshold: t, fees: f }));
const feeConfigAccount = () => ({ owner: ix.PUMP_FEES_PROGRAM, lamports: 5000000n, executable: false, data: Buffer.from(encodeAccount('pump', 'FeeConfig', { bump: 254, admin: wallet('fee-admin'), flat_fees: fees(25n, 5n, 0n), fee_tiers: TIERS, stable_fee_tiers: TIERS, exotic_flat_fees: fees(0n, 95n, 30n) })) });

test('the captured mainnet PumpSwap config (buyback share 5,000) quotes its real 0.30% fee', () => {
  const capture = JSON.parse(readFileSync(new URL('./fixtures/pump-global-config.json', import.meta.url), 'utf8')).result.value;
  const config = fx.readAmmGlobalConfig({ owner: capture.owner, lamports: BigInt(capture.lamports), executable: capture.executable, data: capture.data });
  assert.equal(config.buyback_basis_points, 5000n, 'half of the protocol fee goes to Pump’s buybacks');
  assert.deepEqual([config.lp_fee_basis_points, config.protocol_fee_basis_points, config.coin_creator_fee_basis_points], [20n, 5n, 5n]);
  assert.equal(ammFeeBps({ globalConfig: config, feeConfig: null, baseReserve: 1n, quoteReserve: 1n, supply: 1n }), 30n, 'LP + protocol + creator; the buyback share is part of the protocol fee');
  const quote = fx.ammTradeQuote({ side: 'buy', amount: 1000000000n, baseReserve: 200000000000000n, quoteVault: 80000000000n, globalConfig: config, feeConfig: null, supply: 1000000000000000n, slippageBps: 100 });
  assert.equal(quote.feeBps, 30n); assert.ok(quote.expected > 0n);
});

test('a Pump.fun launch quote is the same with or without the buyback share', () => {
  const feeConfig = fx.readFeeConfig(feeConfigAccount());
  assert.equal(feeConfig.exotic_flat_fees.protocol_fee_bps, 95n, 'the vendored layout decodes the stable tiers and the custom-pair fees');
  assert.equal(feeConfig.stable_fee_tiers.length, TIERS.length);
  const live = global(5000n), none = global(0n);
  assert.equal(curveFeeBps({ global: live, feeConfig, curve: fx.initialCurve(live), supply: live.token_total_supply }), 125n, '0.95% protocol + 0.30% creator, as Pump publishes');
  const sol = fx.launchQuote({ global: live, feeConfig, devBuyLamports: 1000000000n }), solBefore = fx.launchQuote({ global: none, feeConfig, devBuyLamports: 1000000000n });
  assert.deepEqual([sol.tokens, sol.costLamports, sol.feeBps], [solBefore.tokens, solBefore.costLamports, 125n]);
  // A custom pair (PUMP, say) with the creator choosing 1% and then Pump's 3% maximum.
  const quote = { kind: 'custom', mint: wallet('pump-token'), initialVirtualQuoteReserves: 1500000000000n };
  const custom = fx.launchQuote({ global: live, feeConfig, devBuyRaw: 10000n, quote, creatorFeeBps: 100n });
  assert.equal(custom.feeBps, 195n, 'the highest schedule that could apply, with the creator part at 1%');
  assert.ok(custom.tokens > 0n && custom.costLamports <= 10000n);
  assert.equal(quoteCurveFeeBps({ global: live, feeConfig, curve: fx.initialCurve(live, quote), supply: live.token_total_supply, kind: 'custom', creatorFeeBps: 300n }), 395n);
  assert.equal(quoteCurveFeeBps({ global: live, feeConfig, curve: fx.initialCurve(live, quote), supply: live.token_total_supply, kind: 'listed' }), 125n, 'a listed pair (USDC) uses the schedule; no custom fee');
  // The strategy's curve trades use the same fee.
  const trade = fx.curveTradeQuote({ side: 'buy', amount: 100000000n, curve: fx.initialCurve(live), global: live, feeConfig, slippageBps: 100 });
  assert.equal(trade.feeBps, 125n);
});

test('a buyback share Pump itself would refuse still stops quotes', () => {
  const curve = fx.initialCurve(global(0n));
  for (const value of [10000n, 0n]) assert.doesNotThrow(() => curveFeeBps({ global: global(value), feeConfig: null, curve, supply: 1000000000000000n }));
  assert.throws(() => curveFeeBps({ global: global(10001n), feeConfig: null, curve, supply: 1000000000000000n }), /Pump fee is outside the reviewed range/);
  assert.throws(() => quoteCurveFeeBps({ global: global(10001n), feeConfig: null, curve, supply: 1000000000000000n, kind: 'custom', creatorFeeBps: 100n }), /Pump fee is outside the reviewed range/);
  assert.throws(() => ammFeeBps({ globalConfig: { lp_fee_basis_points: 20n, protocol_fee_basis_points: 5n, coin_creator_fee_basis_points: 5n, buyback_basis_points: 10001n }, feeConfig: null, baseReserve: 1n, quoteReserve: 1n, supply: 1n }), /PumpSwap fee is outside the reviewed range/);
  assert.throws(() => curveFeeBps({ global: global(0n, { fee_basis_points: 1970n }), feeConfig: null, curve, supply: 1000000000000000n }), /Pump fee is outside the reviewed range/, 'a fee of 20% or more is still refused');
});
