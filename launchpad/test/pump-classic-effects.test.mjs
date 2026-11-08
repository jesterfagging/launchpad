// Pump.fun Classic: launch planning, simulated-state checks and receipt analysis
// on synthetic account data and finalized-transaction fixtures built with the
// vendored IDL. Dependency-free: runs without the npm packages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { base58Encode, associatedTokenAddress, TOKEN_2022_PROGRAM, NATIVE_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM } from '../src/pump-classic/codec.mjs';
import { encodeAccount, encodeEvent, decodeInstructionArgs, instructionSpec } from '../src/pump-classic/idl.mjs';
import * as ix from '../src/pump-classic/instructions.mjs';
import * as fx from '../src/pump-classic/effects.mjs';
import { shareholdersFor, fundingPlan, PUMP_CLASSIC_POLICY_V1 } from '../src/pump-classic/policy.mjs';
import { generateWallet } from '../src/pump-classic/service.mjs';

const wallet = n => base58Encode(createHash('sha256').update('pump-classic-effects:' + n).digest());
const MINT = wallet('mint'), LAUNCH = wallet('launch'), DEV = wallet('dev'), PROTOCOL = wallet('protocol'), MODE = wallet('mode'), OTHER = wallet('cranker');
const PUMP = ix.PUMP_PROGRAM, FEES = ix.PUMP_FEES_PROGRAM, AMM = ix.PUMP_AMM_PROGRAM;
const zero = SYSTEM_PROGRAM;
const GLOBAL = {
  initialized: true, authority: wallet('auth'), fee_recipient: wallet('fee0'), initial_virtual_token_reserves: 1073000000000000n, initial_virtual_sol_reserves: 30000000000n, initial_real_token_reserves: 793100000000000n,
  token_total_supply: 1000000000000000n, fee_basis_points: 95n, withdraw_authority: wallet('w'), enable_migrate: true, pool_migration_fee: 15000001n, creator_fee_basis_points: 30n,
  fee_recipients: Array.from({ length: 7 }, (_, i) => wallet('fee' + (i + 1))), set_creator_authority: wallet('s'), admin_set_creator_authority: wallet('a'), create_v2_enabled: true, whitelist_pda: zero, reserved_fee_recipient: wallet('r'), mayhem_mode_enabled: false,
  reserved_fee_recipients: Array.from({ length: 7 }, (_, i) => wallet('rr' + i)), is_cashback_enabled: false, buyback_fee_recipients: Array.from({ length: 8 }, (_, i) => wallet('bb' + i)), buyback_basis_points: 0n, initial_virtual_quote_reserves: 0n,
  whitelisted_quote_mints: [zero], creator_fee_configurable: false, max_configurable_creator_fee_bps: 0n, holder_reward_claim_authority: zero, is_holder_reward_enabled: false,
};
const account = (owner, data, lamports = 1461600n) => ({ owner, lamports, data: Buffer.from(data), executable: false });
const tokenAccount = (mint, owner, amount) => { const d = Buffer.alloc(165); Buffer.from(ix.keyBytes(mint)).copy(d, 0); Buffer.from(ix.keyBytes(owner)).copy(d, 32); d.writeBigUInt64LE(amount, 64); d[108] = 1; return account(TOKEN_2022_PROGRAM, d, 2039280n); };
const mintAccount = () => { const d = Buffer.alloc(82); d.writeBigUInt64LE(1000000000000000n, 36); d[44] = 6; d[45] = 1; return account(TOKEN_2022_PROGRAM, d); };
const bondingCurve = (overrides = {}) => account(PUMP, encodeAccount('pump', 'BondingCurve', { virtual_token_reserves: 1073000000000000n, virtual_quote_reserves: 30000000000n, real_token_reserves: 793100000000000n, real_quote_reserves: 0n, token_total_supply: 1000000000000000n, complete: false, creator: ix.coinAddresses(MINT).sharingConfig, is_mayhem_mode: false, is_cashback_coin: false, quote_mint: zero, creator_fee_bps: 0n, can_edit_creator_fee: false, is_holder_reward: false, ...overrides }));
const sharing = (shareholders, overrides = {}) => account(FEES, encodeAccount('pump_fees', 'SharingConfig', { bump: 255, version: 2, status: 'Active', mint: MINT, admin: LAUNCH, admin_revoked: true, shareholders: shareholders.map(s => ({ address: s.address, share_bps: s.shareBps })), ...overrides }));

test('the atomic launch creates, shares fees, buys with the shared vault and delivers exact tokens', () => {
  const shareholders = shareholdersFor('holders', { protocolWallet: PROTOCOL, recipient: MODE });
  assert.deepEqual(shareholders, [{ address: PROTOCOL, shareBps: 1000 }, { address: MODE, shareBps: 9000 }]);
  const quote = fx.launchQuote({ global: GLOBAL, feeConfig: null, devBuyLamports: 1000000000n });
  assert.ok(quote.tokens > 30000000000000n && quote.tokens < 40000000000000n, 'about 34M tokens for 1 SOL on a fresh curve');
  assert.ok(quote.costLamports <= 1000000000n);
  const transfers = [{ to: PROTOCOL, lamports: '5000000' }, { to: MODE, lamports: '20000000' }];
  const list = fx.launchInstructions({ mint: MINT, launchWallet: LAUNCH, developer: DEV, name: 'Scout', symbol: 'SCT', uri: 'https://launch.example/token-metadata/x.json', shareholders, tokens: quote.tokens, maxSolCost: 1000000000n, global: GLOBAL, transfers });
  const names = list.map(i => i.programId === PUMP ? 'pump' : i.programId === FEES ? 'fees' : i.programId === ix.PUMP_AMM_PROGRAM ? 'amm' : i.programId);
  assert.deepEqual(names, ['pump', 'fees', 'fees', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'pump', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', TOKEN_2022_PROGRAM, TOKEN_2022_PROGRAM, SYSTEM_PROGRAM, SYSTEM_PROGRAM]);
  const update = decodeInstructionArgs('pump_fees', 'update_fee_shares_v2', list[2].data);
  assert.deepEqual(update.shareholders, [{ address: PROTOCOL, share_bps: 1000 }, { address: MODE, share_bps: 9000 }]);
  assert.equal(list[2].keys.at(-1).pubkey, LAUNCH, 'the current (initial) shareholder is the launch wallet');
  const buy = decodeInstructionArgs('pump', 'buy_v2', list[4].data);
  assert.equal(buy.amount, quote.tokens); assert.equal(buy.max_sol_cost, 1000000000n);
  const spec = instructionSpec('pump', 'buy_v2').accounts.map(a => a.name), at = name => list[4].keys[spec.indexOf(name)].pubkey;
  assert.equal(at('creator_vault'), ix.coinAddresses(MINT).sharedCreatorVault, 'the dev buy pays creator fees into the shared vault');
  assert.equal(at('user'), LAUNCH);
  const transfer = list[6];
  assert.equal(transfer.data.readBigUInt64LE(1), quote.tokens); assert.equal(transfer.keys[2].pubkey, associatedTokenAddress(DEV, MINT, TOKEN_2022_PROGRAM));
  assert.equal(list[8].data.readBigUInt64LE(4), 5000000n); assert.equal(list[9].keys[1].pubkey, MODE);
  // Zero dev buy: no buy, no delivery, and no budget may be attached.
  const none = fx.launchInstructions({ mint: MINT, launchWallet: LAUNCH, developer: DEV, name: 'Scout', symbol: 'SCT', uri: 'https://launch.example/m.json', shareholders, global: GLOBAL, transfers });
  assert.equal(none.filter(i => i.programId === PUMP).length, 1);
  assert.throws(() => fx.launchInstructions({ mint: MINT, launchWallet: LAUNCH, developer: DEV, name: 'S', symbol: 'S', uri: 'https://a.b/c', shareholders, tokens: 0n, maxSolCost: 5n, global: GLOBAL }), /zero dev buy/);
  assert.throws(() => fx.launchInstructions({ mint: MINT, launchWallet: LAUNCH, developer: DEV, name: 'S', symbol: 'S', uri: 'https://a.b/c', shareholders: [{ address: LAUNCH, shareBps: 1000 }, { address: MODE, shareBps: 9000 }], global: GLOBAL }), /launch wallet cannot be a final/);
  assert.throws(() => shareholdersFor('creator', { protocolWallet: PROTOCOL, recipient: PROTOCOL }), /distinct/);
});

test('policy shares, funding plan and option gating', () => {
  assert.deepEqual(Object.fromEntries(['creator', 'holders', 'gotchi', 'agent', 'market_maker', 'lp_manager'].map(m => [m, shareholdersFor(m, { protocolWallet: PROTOCOL, recipient: MODE })[0].shareBps])), { creator: 1000, holders: 1000, gotchi: 1000, agent: 2000, market_maker: 2000, lp_manager: 2000 });
  const plan = fundingPlan({ mode: 'market_maker', devBuyLamports: 2000000000n, seedLamports: 3000000000n });
  assert.equal(plan.totalLamports, (2000000000n + 20000000n + 2000000n + 10000000n + 3000000000n).toString());
  assert.throws(() => fundingPlan({ mode: 'holders', seedLamports: 1n }), /Seed capital is only available/);
  assert.throws(() => fundingPlan({ mode: 'creator', devBuyLamports: 25000000001n }), /dev buy exceeds/);
  assert.throws(() => fundingPlan({ mode: 'pumpswap' }), /Unsupported/);
  assert.equal(PUMP_CLASSIC_POLICY_V1.coin.mayhemMode, false);
});

test('the simulated launch state must match the plan exactly', () => {
  const shareholders = shareholdersFor('creator', { protocolWallet: PROTOCOL, recipient: DEV });
  const transfers = [{ to: PROTOCOL, lamports: '5000000' }];
  const a = ix.coinAddresses(MINT), watch = fx.launchWatchList({ mint: MINT, launchWallet: LAUNCH, developer: DEV, transfers });
  assert.deepEqual(watch, [LAUNCH, associatedTokenAddress(DEV, MINT, TOKEN_2022_PROGRAM), a.bondingCurve, a.sharingConfig, MINT, PROTOCOL]);
  const good = [account(SYSTEM_PROGRAM, Buffer.alloc(0), 40000000n), tokenAccount(MINT, DEV, 1234n), bondingCurve(), sharing(shareholders), mintAccount(), account(SYSTEM_PROGRAM, Buffer.alloc(0), 5000000n)];
  const base = { mint: MINT, launchWallet: LAUNCH, developer: DEV, shareholders, tokens: 1234n, transfers, before: { launchLamports: 1100000000n, recipients: { [PROTOCOL]: 0n } }, maxDebit: 1100000000n };
  const ok = fx.verifyLaunchState({ ...base, after: good });
  assert.equal(ok.spentLamports, 1060000000n); assert.equal(ok.tokens, 1234n);
  assert.throws(() => fx.verifyLaunchState({ ...base, tokens: 1235n, after: good }), /exactly the quoted dev-buy tokens/);
  assert.throws(() => fx.verifyLaunchState({ ...base, maxDebit: 1000n, after: good }), /more than its approved budget/);
  assert.throws(() => fx.verifyLaunchState({ ...base, after: [good[0], good[1], bondingCurve({ is_mayhem_mode: true }), ...good.slice(3)] }), /regular-coin/);
  assert.throws(() => fx.verifyLaunchState({ ...base, after: [good[0], good[1], bondingCurve({ creator: LAUNCH }), ...good.slice(3)] }), /regular-coin/);
  assert.throws(() => fx.verifyLaunchState({ ...base, after: [good[0], good[1], good[2], sharing(shareholders, { admin_revoked: false }), ...good.slice(4)] }), /reviewed recipients/);
  assert.throws(() => fx.verifyLaunchState({ ...base, after: [good[0], good[1], good[2], sharing([{ address: PROTOCOL, shareBps: 500 }, { address: DEV, shareBps: 9500 }]), ...good.slice(4)] }), /reviewed recipients/);
  assert.throws(() => fx.verifyLaunchState({ ...base, after: [...good.slice(0, 5), account(SYSTEM_PROGRAM, Buffer.alloc(0), 4000000n)] }), /exact launch funding/);
});

// --- finalized transaction fixtures ---------------------------------------------------------
function txFixture({ keys, top = [], inner = [], pre, post, fee = 5000, err = null, preTokens = [], postTokens = [] }) {
  return { slot: 777, blockTime: 1760000000, transaction: { signatures: ['sig'], message: { accountKeys: keys, instructions: top } }, meta: { err, fee, preBalances: pre.map(Number), postBalances: post.map(Number), preTokenBalances: preTokens, postTokenBalances: postTokens, innerInstructions: inner, loadedAddresses: { writable: [], readonly: [] } } };
}
const distributeEvent = (mint, shareholders, distributed) => base58Encode(encodeEvent('pump', 'DistributeCreatorFeesEvent', { timestamp: 1760000000n, mint, bonding_curve: ix.coinAddresses(mint).bondingCurve, sharing_config: ix.coinAddresses(mint).sharingConfig, admin: LAUNCH, shareholders: shareholders.map(s => ({ address: s.address, share_bps: s.shareBps })), distributed, quote_mint: NATIVE_MINT }));

test('distribution legs come from the event and real balance changes, ours or another caller’s', () => {
  const shareholders = [{ address: PROTOCOL, shareBps: 2000 }, { address: MODE, shareBps: 8000 }], a = ix.coinAddresses(MINT);
  const keys = [PROTOCOL, MODE, a.sharedCreatorVault, PUMP, ix.pumpAddresses.eventAuthority];
  // Launchpad's crank: the protocol wallet pays the fee and still receives its share.
  const ours = txFixture({ keys, top: [{ programIdIndex: 3, accounts: [0, 1, 2], data: '1' }], inner: [{ index: 0, instructions: [{ programIdIndex: 3, accounts: [4], data: distributeEvent(MINT, shareholders, 100000001n) }] }], pre: [10000000, 2000000, 200000000, 1, 1], post: [10000000 + 20000000 - 5000, 2000000 + 80000000, 100000000 - 1, 1, 1] });
  const legs = fx.distributionLegs(ours, { mint: MINT });
  assert.deepEqual(legs.anomalies, []);
  assert.deepEqual(legs.legs.map(l => [l.recipient, l.amount]), [[PROTOCOL, 20000000n], [MODE, 80000000n]]);
  // Another caller distributed: nobody's share is reduced by a fee.
  const external = txFixture({ keys: [OTHER, ...keys], top: [{ programIdIndex: 4, accounts: [1, 2, 3], data: '1' }], inner: [{ index: 0, instructions: [{ programIdIndex: 4, accounts: [5], data: distributeEvent(MINT, shareholders, 50000000n) }] }], pre: [9000000, 1, 1, 60000000, 1, 1], post: [9000000 - 5000, 1 + 10000000, 1 + 40000000, 10000000, 1, 1] });
  assert.deepEqual(fx.distributionLegs(external, { mint: MINT }).legs.map(l => [l.recipient, l.amount]), [[PROTOCOL, 10000000n], [MODE, 40000000n]]);
  // An unsolicited extra transfer in the same transaction is not revenue: the leg is held for review.
  const padded = txFixture({ keys: [OTHER, ...keys], top: [{ programIdIndex: 4, accounts: [1, 2, 3], data: '1' }], inner: [{ index: 0, instructions: [{ programIdIndex: 4, accounts: [5], data: distributeEvent(MINT, shareholders, 50000000n) }] }], pre: [99000000, 1, 1, 60000000, 1, 1], post: [9000000 - 5000, 1 + 10000000 + 90000000, 1 + 40000000, 10000000, 1, 1] });
  const held = fx.distributionLegs(padded, { mint: MINT });
  assert.deepEqual(held.legs.map(l => l.recipient), [MODE]); assert.equal(held.anomalies[0].recipient, PROTOCOL);
  // Another coin's distribution, a forged event authority and a failed transaction yield nothing.
  assert.equal(fx.distributionLegs(external, { mint: wallet('other-mint') }).legs.length, 0);
  const forged = txFixture({ keys: [...keys, OTHER], top: [], inner: [{ index: 0, instructions: [{ programIdIndex: 3, accounts: [5], data: distributeEvent(MINT, shareholders, 50000000n) }] }], pre: [1, 1, 1, 1, 1, 1], post: [1, 1, 1, 1, 1, 1] });
  assert.equal(fx.distributionLegs(forged, { mint: MINT }).legs.length, 0);
  assert.equal(fx.distributionLegs({ ...external, meta: { ...external.meta, err: { InstructionError: [0, 'x'] } } }, { mint: MINT }).legs.length, 0);
});

test('graduation needs the canonical pool routing creator fees to this coin’s fee sharing', () => {
  const a = ix.coinAddresses(MINT), curve = fx.readBondingCurve(bondingCurve({ complete: true }), MINT);
  const pool = overrides => account(AMM, encodeAccount('pump_amm', 'Pool', { pool_bump: 254, index: 0, creator: a.poolAuthority, base_mint: MINT, quote_mint: NATIVE_MINT, lp_mint: a.lpMint, pool_base_token_account: a.poolBaseTokenAccount, pool_quote_token_account: a.poolQuoteTokenAccount, lp_supply: 1000n, coin_creator: a.sharingConfig, is_mayhem_mode: false, is_cashback_coin: false, virtual_quote_reserves: -5n, creator_fee_bps: 0n, can_edit_creator_fee: false, is_holder_reward: false, ...overrides }));
  assert.equal(fx.graduationState({ mint: MINT, curve: fx.readBondingCurve(bondingCurve(), MINT), poolRaw: null }).venue, 'curve');
  assert.equal(fx.graduationState({ mint: MINT, curve, poolRaw: null }).venue, 'migrating');
  const done = fx.graduationState({ mint: MINT, curve, poolRaw: pool({}) });
  assert.equal(done.venue, 'amm'); assert.equal(done.pool.address, a.canonicalPool); assert.equal(done.pool.virtual_quote_reserves, -5n);
  assert.throws(() => fx.graduationState({ mint: MINT, curve, poolRaw: pool({ coin_creator: LAUNCH }) }), /fee sharing/);
  assert.throws(() => fx.graduationState({ mint: MINT, curve, poolRaw: pool({ creator: OTHER }) }), /canonical pool/);
  assert.throws(() => fx.graduationState({ mint: MINT, curve, poolRaw: { ...pool({}), owner: PUMP } }), /wrong owner/);
});

test('finalized launch effects require the create event and the exact delivered tokens', () => {
  const ata = associatedTokenAddress(DEV, MINT, TOKEN_2022_PROGRAM), keys = [LAUNCH, MINT, PROTOCOL, ata, PUMP, ix.pumpAddresses.eventAuthority];
  const created = base58Encode(encodeEvent('pump', 'CreateEvent', { name: 'Scout', symbol: 'SCT', uri: 'https://x/y', mint: MINT, bonding_curve: ix.coinAddresses(MINT).bondingCurve, user: LAUNCH, creator: LAUNCH, timestamp: 1n, virtual_token_reserves: 1n, virtual_sol_reserves: 1n, real_token_reserves: 1n, token_total_supply: 1n, token_program: TOKEN_2022_PROGRAM, is_mayhem_mode: false, is_cashback_enabled: false, quote_mint: zero, virtual_quote_reserves: 1n, creator_fee_bps: 0n, is_holder_reward: false }));
  const tx = txFixture({ keys, top: [{ programIdIndex: 4, accounts: [1, 0], data: '1' }], inner: [{ index: 0, instructions: [{ programIdIndex: 4, accounts: [5], data: created }] }], pre: [1100000000, 0, 0, 0, 1, 1], post: [40000000, 1461600, 5000000, 2039280, 1, 1], postTokens: [{ accountIndex: 3, mint: MINT, owner: DEV, uiTokenAmount: { amount: '777' } }] });
  const effects = fx.launchReceiptEffects(tx, { mint: MINT, launchWallet: LAUNCH, developer: DEV, tokens: 777n, transfers: [{ to: PROTOCOL, lamports: '5000000' }] });
  assert.equal(effects.failed, false); assert.equal(effects.tokens, 777n);
  assert.throws(() => fx.launchReceiptEffects(tx, { mint: MINT, launchWallet: LAUNCH, developer: DEV, tokens: 778n }), /different token amount/);
  assert.throws(() => fx.launchReceiptEffects(tx, { mint: wallet('m2'), launchWallet: LAUNCH, developer: DEV, tokens: 0n }), /did not create/);
  const failed = fx.launchReceiptEffects({ ...tx, meta: { ...tx.meta, err: { InstructionError: [3, { Custom: 6002 }] }, postTokenBalances: [] } }, { mint: MINT, launchWallet: LAUNCH, developer: DEV, tokens: 777n });
  assert.equal(failed.failed, true);
});

test('strategy trade quotes are conservative and cap price impact', () => {
  const curve = fx.readBondingCurve(bondingCurve(), MINT);
  const buy = fx.curveTradeQuote({ side: 'buy', amount: 100000000n, curve, global: GLOBAL, feeConfig: null, slippageBps: 100 });
  assert.ok(buy.expected > 0n && buy.minimum === buy.expected * 9900n / 10000n && buy.impactBps < 200n);
  const sell = fx.curveTradeQuote({ side: 'sell', amount: 1000000000000n, curve, global: GLOBAL, feeConfig: null, slippageBps: 100 });
  assert.ok(sell.expected > 0n && sell.minimum < sell.expected);
  const pool = fx.ammTradeQuote({ side: 'buy', amount: 1000000000n, baseReserve: 200000000000000n, quoteVault: 80000000000n, virtualQuoteReserves: -1000000000n, globalConfig: { lp_fee_basis_points: 20n, protocol_fee_basis_points: 5n, coin_creator_fee_basis_points: 5n, buyback_basis_points: 0n }, feeConfig: null, supply: 1000000000000000n, slippageBps: 100 });
  assert.ok(pool.expected > 0n && pool.impactBps > 0n);
  const strategyWallet = generateWallet().address;
  const ixs = fx.curveTradeInstructions({ side: 'buy', wallet: strategyWallet, mint: MINT, amount: 100000000n, minimum: buy.minimum, global: GLOBAL, createTokenAccount: true });
  assert.equal(ixs.length, 2); assert.deepEqual(decodeInstructionArgs('pump', 'buy_exact_quote_in_v2', ixs[1].data), { spendable_quote_in: 100000000n, min_tokens_out: buy.minimum });
  assert.ok(!ixs.some(i => i.keys.some(k => k.isSigner && k.pubkey !== strategyWallet)), 'only the strategy wallet signs strategy trades');
  assert.ok(!ixs.some(i => i.keys.some(k => k.pubkey === LAUNCH)), 'the deploying wallet never appears in strategy trades');
  const sellIx = fx.curveTradeInstructions({ side: 'sell', wallet: strategyWallet, mint: MINT, amount: 5n, minimum: 1n, global: GLOBAL });
  assert.deepEqual(decodeInstructionArgs('pump', 'sell_v2', sellIx[0].data), { amount: 5n, min_sol_output: 1n });
  assert.throws(() => fx.curveTradeInstructions({ side: 'buy', wallet: ix.coinAddresses(MINT).bondingCurve, mint: MINT, amount: 1n, minimum: 1n, global: GLOBAL }), /Invalid strategy trade/);
});

test('public trades come from Pump curve and canonical PumpSwap events of this coin only', () => {
  const a = ix.coinAddresses(MINT), BUYER = wallet('buyer'), SELLER = wallet('seller');
  const trade = over => base58Encode(encodeEvent('pump', 'TradeEvent', { mint: MINT, sol_amount: 250000000n, token_amount: 8000000000000n, is_buy: true, user: BUYER, timestamp: 1760000100n, virtual_sol_reserves: 30250000000n, virtual_token_reserves: 1065000000000000n, real_sol_reserves: 250000000n, real_token_reserves: 785100000000000n, fee_recipient: wallet('fee1'), fee_basis_points: 95n, fee: 2375000n, creator: a.sharingConfig, creator_fee_basis_points: 30n, creator_fee: 750000n, track_volume: false, total_unclaimed_tokens: 0n, total_claimed_tokens: 0n, current_sol_volume: 0n, last_update_timestamp: 0n, ix_name: 'buy_v2', mayhem_mode: false, cashback_fee_basis_points: 0n, cashback: 0n, buyback_fee_basis_points: 0n, buyback_fee: 0n, shareholders: [], quote_mint: NATIVE_MINT, quote_amount: 250000000n, virtual_quote_reserves: 30250000000n, real_quote_reserves: 250000000n, holder_rewards_bps: 0n, holder_rewards: 0n, ...over }));
  const ammBuy = over => base58Encode(encodeEvent('pump_amm', 'BuyEvent', { timestamp: 1760000200n, base_amount_out: 1000000000n, max_quote_amount_in: 9000000n, user_base_token_reserves: 0n, user_quote_token_reserves: 0n, pool_base_token_reserves: 1n, pool_quote_token_reserves: 1n, quote_amount_in: 8000000n, lp_fee_basis_points: 20n, lp_fee: 1n, protocol_fee_basis_points: 5n, protocol_fee: 1n, quote_amount_in_with_lp_fee: 8000001n, user_quote_amount_in: 8100000n, pool: a.canonicalPool, user: SELLER, user_base_token_account: wallet('uba'), user_quote_token_account: wallet('uqa'), protocol_fee_recipient: wallet('pfr'), protocol_fee_recipient_token_account: wallet('pfra'), coin_creator: a.sharingConfig, coin_creator_fee_basis_points: 5n, coin_creator_fee: 1n, track_volume: false, total_unclaimed_tokens: 0n, total_claimed_tokens: 0n, current_sol_volume: 0n, last_update_timestamp: 0n, min_base_amount_out: 1n, ix_name: 'buy', cashback_fee_basis_points: 0n, cashback: 0n, buyback_fee_basis_points: 0n, buyback_fee: 0n, virtual_quote_reserves: 0n, can_boost: false, base_supply: 1000000000000000n, holder_rewards_bps: 0n, holder_rewards: 0n, ...over }));
  const keys = [BUYER, PUMP, ix.pumpAddresses.eventAuthority, AMM, ix.pumpAddresses.ammEventAuthority];
  const tx = txFixture({ keys, top: [{ programIdIndex: 1, accounts: [0], data: '1' }, { programIdIndex: 3, accounts: [0], data: '1' }], inner: [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [2], data: trade() }, { programIdIndex: 1, accounts: [2], data: trade({ mint: wallet('another-coin') }) }] }, { index: 1, instructions: [{ programIdIndex: 3, accounts: [4], data: ammBuy() }, { programIdIndex: 3, accounts: [4], data: ammBuy({ pool: wallet('not-canonical') }) }] }], pre: [1, 1, 1, 1, 1], post: [1, 1, 1, 1, 1] });
  const curveOnly = fx.coinTrades(tx, { mint: MINT });
  assert.deepEqual(curveOnly.map(t => [t.venue, t.side, t.wallet, t.tokens, t.lamports, t.time]), [['curve', 'buy', BUYER, 8000000000000n, 250000000n, 1760000100]], 'another coin’s trade is ignored');
  const both = fx.coinTrades(tx, { mint: MINT, pool: a.canonicalPool });
  assert.deepEqual(both.map(t => [t.venue, t.side, t.wallet, t.tokens, t.lamports]), [['curve', 'buy', BUYER, 8000000000000n, 250000000n], ['amm', 'buy', SELLER, 1000000000n, 8000000n]], 'only the canonical pool counts after graduation');
  // A sell, a forged event authority and a failed transaction.
  const sell = txFixture({ keys, top: [{ programIdIndex: 1, accounts: [0], data: '1' }], inner: [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [2], data: trade({ is_buy: false, user: SELLER }) }] }], pre: [1, 1, 1, 1, 1], post: [1, 1, 1, 1, 1] });
  assert.equal(fx.coinTrades(sell, { mint: MINT })[0].side, 'sell');
  const forged = txFixture({ keys: [...keys, OTHER], top: [{ programIdIndex: 1, accounts: [0], data: '1' }], inner: [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [5], data: trade() }] }], pre: [1, 1, 1, 1, 1, 1], post: [1, 1, 1, 1, 1, 1] });
  assert.deepEqual(fx.coinTrades(forged, { mint: MINT }), []);
  assert.deepEqual(fx.coinTrades({ ...tx, meta: { ...tx.meta, err: { InstructionError: [0, 'x'] } } }, { mint: MINT }), []);
});
