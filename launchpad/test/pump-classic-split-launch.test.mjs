// Pump.fun launches on other pairs (v71.22): the setup transaction's accounts,
// the split creation layout that keeps a dev buy inside Solana's limit of 64
// program calls, the separate dev-buy delivery and its finalized check, and the
// holder-aware creation checks. Dependency-free: runs without the npm packages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { base58Encode, associatedTokenAddress, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, SYSTEM_PROGRAM } from '../src/pump-classic/codec.mjs';
import { encodeAccount, encodeEvent, decodeInstructionArgs, instructionSpec } from '../src/pump-classic/idl.mjs';
import * as ix from '../src/pump-classic/instructions.mjs';
import * as fx from '../src/pump-classic/effects.mjs';
import { shareholdersFor } from '../src/pump-classic/policy.mjs';

const wallet = n => base58Encode(createHash('sha256').update('pump-classic-split:' + n).digest());
const MINT = wallet('mint'), LAUNCH = wallet('launch'), DEV = wallet('dev'), PROTOCOL = wallet('protocol');
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', PUMP_PAIR = wallet('pump-pair');
const PUMP = ix.PUMP_PROGRAM, FEES = ix.PUMP_FEES_PROGRAM, ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', zero = SYSTEM_PROGRAM;
const USDC_Q = { mint: USDC, program: TOKEN_PROGRAM }, PUMP_Q = { mint: PUMP_PAIR, program: TOKEN_PROGRAM };
const GLOBAL = {
  initialized: true, authority: wallet('auth'), fee_recipient: wallet('fee0'), initial_virtual_token_reserves: 1073000000000000n, initial_virtual_sol_reserves: 30000000000n, initial_real_token_reserves: 793100000000000n,
  token_total_supply: 1000000000000000n, fee_basis_points: 95n, withdraw_authority: wallet('w'), enable_migrate: true, pool_migration_fee: 15000001n, creator_fee_basis_points: 30n,
  fee_recipients: Array.from({ length: 7 }, (_, i) => wallet('fee' + (i + 1))), set_creator_authority: wallet('s'), admin_set_creator_authority: wallet('a'), create_v2_enabled: true, whitelist_pda: zero, reserved_fee_recipient: wallet('r'), mayhem_mode_enabled: false,
  reserved_fee_recipients: Array.from({ length: 7 }, (_, i) => wallet('rr' + i)), is_cashback_enabled: false, buyback_fee_recipients: Array.from({ length: 8 }, (_, i) => wallet('bb' + i)), buyback_basis_points: 5000n,
  initial_virtual_quote_reserves: 4500000000n, whitelisted_quote_mints: [USDC], creator_fee_configurable: true, max_configurable_creator_fee_bps: 300n, holder_reward_claim_authority: zero, is_holder_reward_enabled: false,
};
const account = (owner, data, lamports = 1461600n) => ({ owner, lamports, data: Buffer.from(data), executable: false });
const tokenAccount = (mint, owner, amount, program = TOKEN_2022_PROGRAM) => { const d = Buffer.alloc(165); Buffer.from(ix.keyBytes(mint)).copy(d, 0); Buffer.from(ix.keyBytes(owner)).copy(d, 32); d.writeBigUInt64LE(amount, 64); d[108] = 1; return account(program, d, 2039280n); };
const coinMint = () => { const d = Buffer.alloc(82); d.writeBigUInt64LE(1000000000000000n, 36); d[44] = 6; d[45] = 1; return account(TOKEN_2022_PROGRAM, d); };
const bondingCurve = quote => account(PUMP, encodeAccount('pump', 'BondingCurve', { virtual_token_reserves: 1073000000000000n, virtual_quote_reserves: 4500000000n, real_token_reserves: 793100000000000n, real_quote_reserves: 0n, token_total_supply: 1000000000000000n, complete: false, creator: ix.coinAddresses(MINT, quote).sharingConfig, is_mayhem_mode: false, is_cashback_coin: false, quote_mint: quote.mint, creator_fee_bps: 0n, can_edit_creator_fee: false, is_holder_reward: false }));
const sharing = shareholders => account(FEES, encodeAccount('pump_fees', 'SharingConfig', { bump: 255, version: 2, status: 'Active', mint: MINT, admin: LAUNCH, admin_revoked: true, shareholders: shareholders.map(s => ({ address: s.address, share_bps: s.shareBps })) }));
function txFixture({ keys, top = [], inner = [], pre, post, fee = 5000, err = null, preTokens = [], postTokens = [] }) {
  return { slot: 778, blockTime: 1760000000, transaction: { signatures: ['sig'], message: { header: { numRequiredSignatures: 1 }, accountKeys: keys, instructions: top } }, meta: { err, fee, preBalances: pre.map(Number), postBalances: post.map(Number), preTokenBalances: preTokens, postTokenBalances: postTokens, innerInstructions: inner, loadedAddresses: { writable: [], readonly: [] } } };
}
const kind = i => i.programId === PUMP ? 'pump:' + (decodeName(i) || '?') : i.programId === FEES ? 'fees' : i.programId === ATA ? 'ata' : i.programId === SYSTEM_PROGRAM ? 'system' : i.programId === TOKEN_2022_PROGRAM ? 'token2022' : i.programId === TOKEN_PROGRAM ? 'token' : i.programId;
const DISCRIMINATORS = Object.fromEntries(['create_v2', 'buy_v2', 'init_user_volume_accumulator'].map(name => [createHash('sha256').update('global:' + name).digest().subarray(0, 8).toString('hex'), name]));
function decodeName(i) { return DISCRIMINATORS[Buffer.from(i.data).subarray(0, 8).toString('hex')]; }

test('the setup transaction creates the pair accounts the creation transaction uses, plus the dev buy’s own accounts', () => {
  const a = ix.coinAddresses(MINT, PUMP_Q), ata = owner => associatedTokenAddress(owner, PUMP_PAIR, TOKEN_PROGRAM);
  const plain = fx.launchSetupPlan({ mint: MINT, launchWallet: LAUNCH, global: GLOBAL, quote: PUMP_Q });
  assert.deepEqual(plain.map(r => [r.kind, r.owner, r.address]), [['ata', LAUNCH, ata(LAUNCH)], ['ata', a.sharedCreatorVault, ata(a.sharedCreatorVault)], ['ata', a.ammCreatorVaultAuthority, ata(a.ammCreatorVaultAuthority)]], 'without a dev buy: the launch wallet’s, the shared vault’s and the PumpSwap creator vault’s pair accounts');
  const withBuy = fx.launchSetupPlan({ mint: MINT, launchWallet: LAUNCH, global: GLOBAL, quote: PUMP_Q, devBuy: true });
  const { feeRecipient, buybackFeeRecipient } = fx.tradeRecipients(GLOBAL, MINT + LAUNCH), volume = ix.userVolumeAccumulator(LAUNCH);
  assert.deepEqual(withBuy.slice(3).map(r => [r.kind, r.owner, r.address]), [['volume', LAUNCH, volume], ['ata', volume, ata(volume)], ['ata', feeRecipient, ata(feeRecipient)], ['ata', buybackFeeRecipient, ata(buybackFeeRecipient)]], 'with a dev buy: the volume account and the pair accounts buy_v2 would otherwise create');
  // Every account the creation's buy_v2 writes in the pair asset is covered by the setup.
  const buy = ix.buyV2({ amount: 1n, maxQuoteIn: 1n, mint: MINT, user: LAUNCH, creator: a.sharingConfig, feeRecipient, buybackFeeRecipient, quote: PUMP_Q });
  const spec = instructionSpec('pump', 'buy_v2').accounts.map(x => x.name), at = name => buy.keys[spec.indexOf(name)].pubkey, planned = new Set(withBuy.map(r => r.address));
  for (const name of ['associated_quote_fee_recipient', 'associated_quote_buyback_fee_recipient', 'associated_quote_user', 'user_volume_accumulator', 'associated_user_volume_accumulator']) assert.ok(planned.has(at(name)), name);
  assert.throws(() => fx.launchSetupPlan({ mint: MINT, launchWallet: LAUNCH, global: GLOBAL, quote: null }), /another pair/);
  // Only the missing accounts are created: ATAs idempotently with the pair's token program, the volume account by Pump.
  const list = fx.launchSetupInstructions({ launchWallet: LAUNCH, quote: PUMP_Q, missing: withBuy.slice(2, 5) });
  assert.deepEqual(list.map(kind), ['ata', 'pump:init_user_volume_accumulator', 'ata']);
  assert.deepEqual([list[0].keys[0].pubkey, list[0].keys[2].pubkey, list[0].keys[5].pubkey], [LAUNCH, a.ammCreatorVaultAuthority, TOKEN_PROGRAM]);
  const init = instructionSpec('pump', 'init_user_volume_accumulator').accounts.map(x => x.name);
  assert.deepEqual([list[1].keys[init.indexOf('payer')].pubkey, list[1].keys[init.indexOf('user')].pubkey, list[1].keys[init.indexOf('user_volume_accumulator')].pubkey], [LAUNCH, LAUNCH, volume]);
  assert.equal(list[2].keys[2].pubkey, volume);
});

test('the creation layout on another pair: pair accounts from the setup and a separate delivery leave out six instructions and their program calls', () => {
  const shareholders = shareholdersFor('creator', { protocolWallet: PROTOCOL, recipient: DEV }), transfers = [{ to: PROTOCOL, lamports: '7000000' }];
  const quote = fx.launchQuote({ global: GLOBAL, feeConfig: null, devBuyRaw: 5000000n, quote: { mint: USDC, kind: 'listed', initialVirtualQuoteReserves: 4500000000n } });
  const args = { mint: MINT, launchWallet: LAUNCH, developer: DEV, name: 'Scout', symbol: 'SCT', uri: 'https://a.example/m.json', shareholders, tokens: quote.tokens, maxSolCost: 5000000n, global: GLOBAL, transfers, quote: USDC_Q };
  const inline = fx.launchInstructions(args);
  assert.deepEqual(inline.map(kind), ['pump:create_v2', 'ata', 'ata', 'ata', 'fees', 'fees', 'ata', 'pump:buy_v2', 'ata', 'token2022', 'token2022', 'system'], 'the v71.21 layout: everything in one transaction');
  const split = fx.launchInstructions({ ...args, pairAccounts: 'ready', delivery: 'separate' });
  assert.deepEqual(split.map(kind), ['pump:create_v2', 'fees', 'fees', 'ata', 'pump:buy_v2', 'system'], 'pair accounts come from the setup and the tokens stay with the launch wallet');
  assert.equal(inline.length - split.length, 6);
  assert.equal(decodeInstructionArgs('pump', 'buy_v2', split[4].data).amount, quote.tokens);
  assert.equal(split[3].keys[2].pubkey, LAUNCH, 'the launch wallet’s own coin account receives the dev buy');
  // The readiness check's upper bound: the pair accounts inline except the PumpSwap creator vault's.
  assert.deepEqual(fx.launchInstructions({ ...args, pairAccounts: 'create', ammVault: false, delivery: 'separate' }).map(kind), ['pump:create_v2', 'ata', 'ata', 'fees', 'fees', 'ata', 'pump:buy_v2', 'system']);
  // No dev buy: nothing to deliver either way.
  assert.deepEqual(fx.launchInstructions({ ...args, tokens: 0n, maxSolCost: 0n, pairAccounts: 'ready', delivery: 'separate' }).map(kind), ['pump:create_v2', 'fees', 'fees', 'system']);
  assert.throws(() => fx.launchInstructions({ ...args, pairAccounts: 'later' }), /Invalid launch layout/);
  assert.throws(() => fx.launchInstructions({ ...args, delivery: 'never' }), /Invalid launch layout/);
});

test('the separate delivery moves the dev-buy tokens to the developer and closes the launch wallet’s account', () => {
  const list = fx.deliveryInstructions({ launchWallet: LAUNCH, developer: DEV, mint: MINT, tokens: 777n });
  assert.deepEqual(list.map(kind), ['ata', 'token2022', 'token2022']);
  assert.deepEqual([list[0].keys[0].pubkey, list[0].keys[2].pubkey], [LAUNCH, DEV], 'the launch wallet pays for the developer’s account');
  assert.equal(list[1].data[0], 12, 'transferChecked'); assert.equal(list[1].data.readBigUInt64LE(1), 777n); assert.equal(list[1].data[9], 6);
  assert.equal(list[1].keys[2].pubkey, associatedTokenAddress(DEV, MINT, TOKEN_2022_PROGRAM));
  assert.equal(list[2].data[0], 9, 'closeAccount'); assert.equal(list[2].keys[1].pubkey, LAUNCH, 'the rent returns to the launch wallet');
  assert.throws(() => fx.deliveryInstructions({ launchWallet: LAUNCH, developer: DEV, mint: MINT, tokens: 0n }), /Invalid dev-buy delivery/);
  assert.throws(() => fx.deliveryInstructions({ launchWallet: LAUNCH, developer: LAUNCH, mint: MINT, tokens: 1n }), /Invalid dev-buy delivery/);
  // Finalized: exactly the prepared amount reached the developer, paid by the launch wallet.
  const source = associatedTokenAddress(LAUNCH, MINT, TOKEN_2022_PROGRAM), destination = associatedTokenAddress(DEV, MINT, TOKEN_2022_PROGRAM);
  const receipt = ({ moved = 777n, payer = LAUNCH, err = null } = {}) => txFixture({ keys: [payer, source, destination, MINT, TOKEN_2022_PROGRAM], pre: [10000000, 2039280, 0, 1, 1], post: [10000000 - 5000 - 2039280 + 2039280, 0, 2039280, 1, 1], err,
    preTokens: [{ accountIndex: 1, mint: MINT, owner: LAUNCH, uiTokenAmount: { amount: '777' } }], postTokens: err ? [] : [{ accountIndex: 2, mint: MINT, owner: DEV, uiTokenAmount: { amount: String(moved) } }] });
  const ok = fx.deliveryEffects(receipt(), { launchWallet: LAUNCH, developer: DEV, mint: MINT, tokens: 777n });
  assert.deepEqual([ok.failed, ok.tokens, ok.feeLamports, ok.slot], [false, 777n, 5000n, 778]);
  assert.throws(() => fx.deliveryEffects(receipt({ moved: 776n }), { launchWallet: LAUNCH, developer: DEV, mint: MINT, tokens: 777n }), /different token amount/);
  assert.throws(() => fx.deliveryEffects(receipt({ payer: PROTOCOL }), { launchWallet: LAUNCH, developer: DEV, mint: MINT, tokens: 777n }), /different payer/);
  const failed = fx.deliveryEffects(receipt({ err: { InstructionError: [1, 'x'] } }), { launchWallet: LAUNCH, developer: DEV, mint: MINT, tokens: 777n });
  assert.deepEqual([failed.failed, failed.tokens], [true, 0n]);
});

test('with a separate delivery the creation checks expect the tokens in the launch wallet', () => {
  const shareholders = shareholdersFor('creator', { protocolWallet: PROTOCOL, recipient: DEV }), transfers = [{ to: PROTOCOL, lamports: '7000000' }];
  const watch = fx.launchWatchList({ mint: MINT, launchWallet: LAUNCH, developer: DEV, holder: LAUNCH, transfers, quote: USDC_Q });
  assert.equal(watch[1], associatedTokenAddress(LAUNCH, MINT, TOKEN_2022_PROGRAM), 'the dev-buy account read is the launch wallet’s');
  assert.equal(fx.launchWatchList({ mint: MINT, launchWallet: LAUNCH, developer: DEV, transfers, quote: USDC_Q })[1], associatedTokenAddress(DEV, MINT, TOKEN_2022_PROGRAM), 'inline delivery reads the developer’s');
  const after = holder => [account(SYSTEM_PROGRAM, Buffer.alloc(0), 30000000n), tokenAccount(MINT, holder, 777n), bondingCurve(USDC_Q), sharing(shareholders), coinMint(), account(SYSTEM_PROGRAM, Buffer.alloc(0), 7000000n), tokenAccount(USDC, LAUNCH, 1000n, TOKEN_PROGRAM)];
  const base = { mint: MINT, launchWallet: LAUNCH, developer: DEV, shareholders, tokens: 777n, transfers, before: { launchLamports: 42000000n, recipients: { [PROTOCOL]: 0n }, launchQuote: 5000000n }, maxDebit: 42000000n, quote: USDC_Q, maxQuoteDebit: 5000000n };
  const held = fx.verifyLaunchState({ ...base, holder: LAUNCH, after: after(LAUNCH) });
  assert.deepEqual([held.tokens, held.spentQuote], [777n, 4999000n]);
  assert.throws(() => fx.verifyLaunchState({ ...base, holder: LAUNCH, after: after(DEV) }), /token account/, 'the developer’s account in the launch wallet’s slot is refused');
  assert.throws(() => fx.verifyLaunchState({ ...base, holder: LAUNCH, tokens: 778n, after: after(LAUNCH) }), /launch wallet would not hold exactly the quoted dev-buy tokens/);
  // The finalized creation counts the tokens in the launch wallet's account too.
  const holderAta = associatedTokenAddress(LAUNCH, MINT, TOKEN_2022_PROGRAM), quoteAta = associatedTokenAddress(LAUNCH, USDC, TOKEN_PROGRAM);
  const created = base58Encode(encodeEvent('pump', 'CreateEvent', { name: 'Scout', symbol: 'SCT', uri: 'https://x/y', mint: MINT, bonding_curve: ix.coinAddresses(MINT).bondingCurve, user: LAUNCH, creator: LAUNCH, timestamp: 1n, virtual_token_reserves: 1n, virtual_sol_reserves: 1n, real_token_reserves: 1n, token_total_supply: 1n, token_program: TOKEN_2022_PROGRAM, is_mayhem_mode: false, is_cashback_enabled: false, quote_mint: USDC, virtual_quote_reserves: 1n, creator_fee_bps: 0n, is_holder_reward: false }));
  const tx = txFixture({ keys: [LAUNCH, MINT, quoteAta, holderAta, PUMP, ix.pumpAddresses.eventAuthority, PROTOCOL], top: [{ programIdIndex: 4, accounts: [1, 0], data: '1' }], inner: [{ index: 0, instructions: [{ programIdIndex: 4, accounts: [5], data: created }] }], pre: [42000000, 0, 2039280, 0, 1, 1, 0], post: [30000000, 1461600, 2039280, 2039280, 1, 1, 7000000],
    preTokens: [{ accountIndex: 2, mint: USDC, owner: LAUNCH, uiTokenAmount: { amount: '5000000' } }], postTokens: [{ accountIndex: 2, mint: USDC, owner: LAUNCH, uiTokenAmount: { amount: '1000' } }, { accountIndex: 3, mint: MINT, owner: LAUNCH, uiTokenAmount: { amount: '777' } }] });
  const effects = fx.launchReceiptEffects(tx, { mint: MINT, launchWallet: LAUNCH, developer: DEV, holder: LAUNCH, tokens: 777n, transfers, quote: USDC_Q, maxQuoteDebit: 5000000n });
  assert.deepEqual([effects.tokens, effects.quoteSpent, effects.transfers[PROTOCOL]], [777n, 4999000n, 7000000n]);
  assert.throws(() => fx.launchReceiptEffects(tx, { mint: MINT, launchWallet: LAUNCH, developer: DEV, tokens: 777n, transfers, quote: USDC_Q, maxQuoteDebit: 5000000n }), /different token amount/, 'read as an inline delivery it does not match');
});

test('a closed account in a simulation can be absent or have no lamports', () => {
  assert.equal(fx.accountClosed(null), true); assert.equal(fx.accountClosed(undefined), true);
  assert.equal(fx.accountClosed({ lamports: 0, owner: SYSTEM_PROGRAM, data: [] }), true);
  assert.equal(fx.accountClosed({ lamports: '0' }), true);
  assert.equal(fx.accountClosed({ lamports: 2039280 }), false); assert.equal(fx.accountClosed({ lamports: 1n }), false);
});
