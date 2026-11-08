// Pump.fun pairs beyond SOL (v71.19): the live quote list, quote-mint support,
// the atomic launch on another pair (create_v2 remaining accounts and the
// creator-chosen creator fee), its simulated and finalized checks, token-share
// distribution legs, pair-asset funding receipts and pair-priced trades.
// Dependency-free: runs without the npm packages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { base58Encode, associatedTokenAddress, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, NATIVE_MINT, SYSTEM_PROGRAM, MEMO_PROGRAM } from '../src/pump-classic/codec.mjs';
import { encodeAccount, encodeEvent, decodeInstructionArgs, instructionSpec } from '../src/pump-classic/idl.mjs';
import * as ix from '../src/pump-classic/instructions.mjs';
import * as fx from '../src/pump-classic/effects.mjs';
import { shareholdersFor, fundingPlan, quotePairAllowed, pairDevBuyInSol, PUMP_CLASSIC_POLICY, PUMP_CLASSIC_POLICY_V1, PUMP_CLASSIC_POLICY_V2, PUMP_CLASSIC_POLICY_V3, PUMP_CLASSIC_POLICY_V4, POLICIES, PUMP_CLASSIC_POLICY_V1_HASH, PUMP_CLASSIC_POLICY_V2_HASH, PUMP_CLASSIC_POLICY_V3_HASH, PUMP_CLASSIC_POLICY_V4_HASH, PUMP_CLASSIC_POLICY_HASH } from '../src/pump-classic/policy.mjs';

const wallet = n => base58Encode(createHash('sha256').update('pump-classic-pairs:' + n).digest());
const MINT = wallet('mint'), LAUNCH = wallet('launch'), DEV = wallet('dev'), PROTOCOL = wallet('protocol'), MODE = wallet('mode'), OTHER = wallet('cranker');
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', XSTOCK = wallet('xstock'), ODD = wallet('odd');
const PUMP = ix.PUMP_PROGRAM, FEES = ix.PUMP_FEES_PROGRAM, zero = SYSTEM_PROGRAM, ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const USDC_Q = { mint: USDC, program: TOKEN_PROGRAM }, X_Q = { mint: XSTOCK, program: TOKEN_2022_PROGRAM };
const GLOBAL = {
  initialized: true, authority: wallet('auth'), fee_recipient: wallet('fee0'), initial_virtual_token_reserves: 1073000000000000n, initial_virtual_sol_reserves: 30000000000n, initial_real_token_reserves: 793100000000000n,
  token_total_supply: 1000000000000000n, fee_basis_points: 95n, withdraw_authority: wallet('w'), enable_migrate: true, pool_migration_fee: 15000001n, creator_fee_basis_points: 30n,
  fee_recipients: Array.from({ length: 7 }, (_, i) => wallet('fee' + (i + 1))), set_creator_authority: wallet('s'), admin_set_creator_authority: wallet('a'), create_v2_enabled: true, whitelist_pda: zero, reserved_fee_recipient: wallet('r'), mayhem_mode_enabled: false,
  reserved_fee_recipients: Array.from({ length: 7 }, (_, i) => wallet('rr' + i)), is_cashback_enabled: false, buyback_fee_recipients: Array.from({ length: 8 }, (_, i) => wallet('bb' + i)), buyback_basis_points: 0n,
  initial_virtual_quote_reserves: 4500000000n, whitelisted_quote_mints: [USDC], creator_fee_configurable: true, max_configurable_creator_fee_bps: 500n, holder_reward_claim_authority: zero, is_holder_reward_enabled: false,
};
const account = (owner, data, lamports = 1461600n) => ({ owner, lamports, data: Buffer.from(data), executable: false });
const tokenAccount = (mint, owner, amount, program = TOKEN_2022_PROGRAM) => { const d = Buffer.alloc(165); Buffer.from(ix.keyBytes(mint)).copy(d, 0); Buffer.from(ix.keyBytes(owner)).copy(d, 32); d.writeBigUInt64LE(amount, 64); d[108] = 1; return account(program, d, 2039280n); };
const coinMint = () => { const d = Buffer.alloc(82); d.writeBigUInt64LE(1000000000000000n, 36); d[44] = 6; d[45] = 1; return account(TOKEN_2022_PROGRAM, d); };
const tlv = (type, data) => { const head = Buffer.alloc(4); head.writeUInt16LE(type, 0); head.writeUInt16LE(data.length, 2); return Buffer.concat([head, data]); };
const text = value => { const b = Buffer.from(value, 'utf8'), n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]); };
const metadataExt = (name, symbol) => tlv(19, Buffer.concat([Buffer.alloc(32), Buffer.from(ix.keyBytes(XSTOCK)), text(name), text(symbol), text('https://issuer.example/x.json'), Buffer.alloc(4)]));
/** A quote mint account: SPL (no extensions) or Token-2022 with the given TLV entries. */
function quoteMintAccount({ program = TOKEN_2022_PROGRAM, decimals = 8, extensions = [] } = {}) {
  const base = Buffer.alloc(82); base[44] = decimals; base[45] = 1;
  if (program === TOKEN_PROGRAM || !extensions.length) return account(program, base);
  const padded = Buffer.alloc(166); base.copy(padded); padded[165] = 1;
  return account(program, Buffer.concat([padded, ...extensions]));
}
const bondingCurve = (quote, overrides = {}) => account(PUMP, encodeAccount('pump', 'BondingCurve', { virtual_token_reserves: 1073000000000000n, virtual_quote_reserves: 4500000000n, real_token_reserves: 793100000000000n, real_quote_reserves: 0n, token_total_supply: 1000000000000000n, complete: false, creator: ix.coinAddresses(MINT, quote).sharingConfig, is_mayhem_mode: false, is_cashback_coin: false, quote_mint: quote.mint, creator_fee_bps: 0n, can_edit_creator_fee: false, is_holder_reward: false, ...overrides }));
const sharing = shareholders => account(FEES, encodeAccount('pump_fees', 'SharingConfig', { bump: 255, version: 2, status: 'Active', mint: MINT, admin: LAUNCH, admin_revoked: true, shareholders: shareholders.map(s => ({ address: s.address, share_bps: s.shareBps })) }));
function txFixture({ keys, top = [], inner = [], pre, post, fee = 5000, err = null, preTokens = [], postTokens = [], signers = 1 }) {
  return { slot: 777, blockTime: 1760000000, transaction: { signatures: ['sig'], message: { header: { numRequiredSignatures: signers }, accountKeys: keys, instructions: top } }, meta: { err, fee, preBalances: pre.map(Number), postBalances: post.map(Number), preTokenBalances: preTokens, postTokenBalances: postTokens, innerInstructions: inner, loadedAddresses: { writable: [], readonly: [] } } };
}

test('earlier coins keep their policy; v3 pays pair dev buys in SOL and needs less SOL up front; v4 widens the dev-buy spread; v5 (v71.35) adds options and baskets', () => {
  assert.equal(PUMP_CLASSIC_POLICY_V1_HASH, '3471aeb7132cd4751f03ea17b7e5096d3b49968eb90b104a26b7fee337adc9aa', 'the v1 policy (and every v71.18 coin) is unchanged');
  assert.equal(PUMP_CLASSIC_POLICY_V2_HASH, '917ea4e19c126435e0be26751a4dd8e218fbeac3348eaef4cf7db4f6362a38f3', 'the v2 policy (and every v71.19-v71.21 coin) is unchanged');
  assert.equal(PUMP_CLASSIC_POLICY_V3_HASH, 'f52e568ed8b9a8b54f7b9c97b6bfe1041c76b24d41a014d6dbf45d8bb9b8e13e', 'the v3 policy (and every v71.22 coin) is unchanged');
  assert.deepEqual(PUMP_CLASSIC_POLICY_V3.pairDevBuy, { funding: 'sol', slippageBps: 100, maxImpactBps: 200, quoteDriftBps: 100, maxNetworkCostLamports: '5000000', maxAttempts: 4, unwindAttempts: 3 });
  assert.equal(PUMP_CLASSIC_POLICY_V4.version, 'pump-classic-policy-v4');
  assert.equal(PUMP_CLASSIC_POLICY_V4_HASH, '84aedf64bc5a9b86eebca825d654a56b14291a0f12a99189320489a285650a72', 'the v4 policy (and every v71.23–v71.34 coin) is frozen: any change needs a new version');
  assert.deepEqual(PUMP_CLASSIC_POLICY_V4.pairDevBuy, { funding: 'sol', slippageBps: 200, maxImpactBps: 200, quoteDriftBps: 500, maxNetworkCostLamports: '10000000', maxAttempts: 4, unwindAttempts: 3 }, 'v4: 2% slippage, 5% for the price to move and a 0.01 SOL purchase budget');
  for (const key of Object.keys(PUMP_CLASSIC_POLICY_V3)) if (!['version', 'pairDevBuy'].includes(key)) assert.deepEqual(PUMP_CLASSIC_POLICY_V4[key], PUMP_CLASSIC_POLICY_V3[key], `v4 keeps v3's ${key}`);
  assert.deepEqual(Object.keys(PUMP_CLASSIC_POLICY_V4).sort(), Object.keys(PUMP_CLASSIC_POLICY_V3).sort());
  // v5 (v71.35): the three launch options and reward baskets on top of v4; the dev-buy rules and every v1 figure are v4's.
  assert.equal(PUMP_CLASSIC_POLICY.version, 'pump-classic-policy-v5'); assert.deepEqual(PUMP_CLASSIC_POLICY.pairDevBuy, PUMP_CLASSIC_POLICY_V4.pairDevBuy);
  assert.deepEqual(Object.keys(PUMP_CLASSIC_POLICY).sort(), [...Object.keys(PUMP_CLASSIC_POLICY_V4), 'options', 'basket'].sort());
  assert.ok(![PUMP_CLASSIC_POLICY_V1_HASH, PUMP_CLASSIC_POLICY_V2_HASH, PUMP_CLASSIC_POLICY_V3_HASH, PUMP_CLASSIC_POLICY_V4_HASH].includes(PUMP_CLASSIC_POLICY_HASH));
  assert.equal(POLICIES[PUMP_CLASSIC_POLICY_V1_HASH], PUMP_CLASSIC_POLICY_V1); assert.equal(POLICIES[PUMP_CLASSIC_POLICY_V2_HASH], PUMP_CLASSIC_POLICY_V2); assert.equal(POLICIES[PUMP_CLASSIC_POLICY_V3_HASH], PUMP_CLASSIC_POLICY_V3); assert.equal(POLICIES[PUMP_CLASSIC_POLICY_V4_HASH], PUMP_CLASSIC_POLICY_V4); assert.equal(POLICIES[PUMP_CLASSIC_POLICY_HASH], PUMP_CLASSIC_POLICY);
  assert.ok(Object.isFrozen(PUMP_CLASSIC_POLICY.pairDevBuy) && Object.isFrozen(PUMP_CLASSIC_POLICY));
  for (const key of ['seed', 'collection', 'routing', 'holders', 'strategies']) assert.deepEqual(PUMP_CLASSIC_POLICY[key], PUMP_CLASSIC_POLICY_V1[key], `${key} is unchanged`);
  for (const mode of ['creator', 'holders', 'gotchi', 'agent', 'market_maker', 'lp_manager']) { assert.equal(PUMP_CLASSIC_POLICY.platformShareBps[mode], PUMP_CLASSIC_POLICY_V1.platformShareBps[mode]); assert.equal(PUMP_CLASSIC_POLICY.recipient[mode], PUMP_CLASSIC_POLICY_V1.recipient[mode]); }
  assert.deepEqual(['creator', 'holders', 'gotchi', 'agent', 'market_maker', 'lp_manager', 'diamond_hands', 'earned', 'insured'].filter(m => quotePairAllowed(m)), ['creator', 'holders', 'gotchi', 'diamond_hands']);
  assert.equal(quotePairAllowed('creator', PUMP_CLASSIC_POLICY_V1), false, 'v1 never paired with anything but SOL');
  // v2 exactly as before: a pair dev buy is funded in the pair asset.
  assert.equal(fundingPlan({ mode: 'holders', devBuyLamports: 1000000000n }, PUMP_CLASSIC_POLICY_V2).totalLamports, (1000000000n + 50000000n + 5000000n + 20000000n).toString());
  assert.equal(fundingPlan({ mode: 'holders', quotePair: true }, PUMP_CLASSIC_POLICY_V2).totalLamports, '97000000');
  assert.throws(() => fundingPlan({ mode: 'creator', quotePair: true, devBuyLamports: 1n }, PUMP_CLASSIC_POLICY_V2), /funded in the pair asset/);
  assert.equal(pairDevBuyInSol(PUMP_CLASSIC_POLICY_V2), false);
  // v3: lower budgets and reserves, and the pair dev buy is SOL plus a conversion budget.
  assert.equal(pairDevBuyInSol(PUMP_CLASSIC_POLICY), true);
  const sol = fundingPlan({ mode: 'holders', devBuyLamports: 1000000000n });
  assert.equal(sol.totalLamports, (1000000000n + 20000000n + 2000000n + 5000000n).toString());
  assert.equal(fundingPlan({ mode: 'creator' }).totalLamports, '22000000', 'a Creator launch on SOL without a dev buy: 0.022 SOL (it was 0.055)');
  const pair = fundingPlan({ mode: 'gotchi', quotePair: true });
  assert.deepEqual([pair.setupBudgetLamports, pair.collectorGasLamports, pair.modeGasLamports, pair.conversionBudgetLamports, pair.totalLamports], ['35000000', '7000000', '6000000', undefined, '48000000'], 'Gotchi on a pair: 0.048 SOL (it was 0.08)');
  const bought = fundingPlan({ mode: 'gotchi', quotePair: true, devBuyLamports: 500000000n });
  assert.deepEqual([bought.devBuyLamports, bought.conversionBudgetLamports, bought.totalLamports], ['500000000', '10000000', '558000000'], 'the SOL dev buy plus its conversion budget (v4: 0.01 SOL)');
  const boughtV3 = fundingPlan({ mode: 'gotchi', quotePair: true, devBuyLamports: 500000000n }, PUMP_CLASSIC_POLICY_V3);
  assert.deepEqual([boughtV3.conversionBudgetLamports, boughtV3.totalLamports], ['5000000', '553000000'], 'v3 launches keep their 0.005 SOL budget');
  assert.throws(() => fundingPlan({ mode: 'agent', quotePair: true }), /SOL only/);
  assert.throws(() => fundingPlan({ mode: 'creator', quotePair: true, devBuyLamports: 25000000001n }), /dev buy exceeds/);
});

test('the live pair list: SOL, the listed quote and custom pairs, with Global winning duplicates', () => {
  const control = { mints: [{ mint: XSTOCK, initialVirtualQuoteReserves: 120000000000n }, { mint: USDC, initialVirtualQuoteReserves: 1n }, { mint: ODD, initialVirtualQuoteReserves: 0n }] };
  const quotes = fx.pumpQuotes({ global: GLOBAL, quoteControl: control });
  assert.deepEqual(quotes.map(q => [q.mint, q.kind, q.quoteControl, q.initialVirtualQuoteReserves]), [[NATIVE_MINT, 'sol', false, 30000000000n], [USDC, 'listed', false, 4500000000n], [XSTOCK, 'custom', true, 120000000000n]], 'a custom pair without reserves cannot be quoted and is left out');
  const qc = fx.readQuoteControl(account(PUMP, encodeAccount('pump', 'QuoteControl', { admin: wallet('qa'), _reserved: Array(64).fill(0), mints: [{ mint: XSTOCK, initial_virtual_quote_reserves: 7n }, { mint: zero, initial_virtual_quote_reserves: 9n }] })));
  assert.deepEqual(qc.mints, [{ mint: XSTOCK, initialVirtualQuoteReserves: 7n }], 'empty slots are ignored');
  assert.equal(fx.readQuoteControl(null), null);
  assert.equal(fx.initialCurve(GLOBAL, quotes[2]).virtual_quote_reserves, 120000000000n);
  assert.equal(fx.initialCurve(GLOBAL).virtual_quote_reserves, 30000000000n);
});

test('quote-mint support: exact handling only, with display metadata from the mint', () => {
  assert.deepEqual(fx.quoteMintSupport(quoteMintAccount({ program: TOKEN_PROGRAM, decimals: 6 })), { supported: true, program: TOKEN_PROGRAM, decimals: 6, extensions: [], metadata: null });
  const pausable = tlv(26, Buffer.concat([Buffer.alloc(32, 7), Buffer.from([0])])), delegate = tlv(12, Buffer.alloc(32, 5)), pointer = tlv(18, Buffer.alloc(64, 1));
  const stock = fx.quoteMintSupport(quoteMintAccount({ extensions: [pointer, metadataExt('Tesla xStock', 'TSLAx'), pausable, delegate, tlv(25, Buffer.alloc(56))] }));
  assert.equal(stock.supported, true); assert.equal(stock.program, TOKEN_2022_PROGRAM); assert.equal(stock.decimals, 8);
  assert.deepEqual(stock.metadata, { name: 'Tesla xStock', symbol: 'TSLAx' });
  assert.equal(fx.quoteMintSupport(quoteMintAccount({ extensions: [tlv(1, Buffer.alloc(108))] })).supported, false, 'a transfer fee would reduce exact amounts');
  assert.match(fx.quoteMintSupport(quoteMintAccount({ extensions: [tlv(6, Buffer.from([2]))] })).reason, /start frozen/);
  assert.equal(fx.quoteMintSupport(quoteMintAccount({ extensions: [tlv(6, Buffer.from([1]))] })).supported, true);
  assert.match(fx.quoteMintSupport(quoteMintAccount({ extensions: [tlv(14, Buffer.concat([Buffer.alloc(32), Buffer.alloc(32, 9)]))] })).reason, /transfer hook/);
  assert.equal(fx.quoteMintSupport(quoteMintAccount({ extensions: [tlv(14, Buffer.alloc(64))] })).supported, true, 'a hook extension without a program is inert');
  assert.equal(fx.quoteMintSupport(null).supported, false);
  assert.equal(fx.tokenMetadataText([{ type: 19, data: Buffer.from([1, 2, 3]) }]), null, 'malformed metadata is ignored, never guessed');
  const hostile = fx.tokenMetadataText(fx.mintExtensions(quoteMintAccount({ extensions: [metadataExt('Bad‮Name\u0007', 'US​DC')] }).data));
  assert.deepEqual(hostile, { name: 'BadName', symbol: 'USDC' }, 'control and direction characters are stripped');
});

test('create_v2 on another pair carries the documented remaining accounts and the chosen creator fee', () => {
  const listed = ix.createV2({ mint: MINT, user: LAUNCH, creator: LAUNCH, name: 'Scout', symbol: 'SCT', uri: 'https://a.example/m.json', quote: USDC_Q });
  const base = instructionSpec('pump', 'create_v2').accounts.length, a = ix.coinAddresses(MINT, USDC_Q);
  assert.deepEqual(listed.keys.slice(base).map(k => [k.pubkey, k.isWritable]), [[USDC, false], [a.associatedQuoteBondingCurve, true], [TOKEN_PROGRAM, false]]);
  assert.equal(a.associatedQuoteBondingCurve, associatedTokenAddress(a.bondingCurve, USDC, TOKEN_PROGRAM));
  assert.deepEqual(decodeInstructionArgs('pump', 'create_v2', listed.data), { name: 'Scout', symbol: 'SCT', uri: 'https://a.example/m.json', creator: LAUNCH, is_mayhem_mode: false });
  const custom = ix.createV2({ mint: MINT, user: LAUNCH, creator: LAUNCH, name: 'Scout', symbol: 'SCT', uri: 'https://a.example/m.json', quote: X_Q, quoteControl: true, creatorFeeBps: 250 });
  assert.deepEqual(custom.keys.slice(base).map(k => k.pubkey), [XSTOCK, ix.coinAddresses(MINT, X_Q).associatedQuoteBondingCurve, TOKEN_2022_PROGRAM, ix.pumpAddresses.quoteControl]);
  assert.deepEqual(decodeInstructionArgs('pump', 'create_v2', custom.data), { name: 'Scout', symbol: 'SCT', uri: 'https://a.example/m.json', creator: LAUNCH, is_mayhem_mode: false, is_cashback_enabled: false, creator_fee_bps: 250n });
  assert.equal(custom.data.length, listed.data.length + 1 + 8, 'cashback off (1 byte) then the u64 creator fee; holder rewards stay omitted');
  assert.throws(() => ix.createV2({ mint: MINT, user: LAUNCH, creator: LAUNCH, name: 'S', symbol: 'S', uri: 'https://a.b/c', quote: USDC_Q, creatorFeeBps: 10 }), /custom pairs/);
  assert.throws(() => ix.createV2({ mint: MINT, user: LAUNCH, creator: LAUNCH, name: 'S', symbol: 'S', uri: 'https://a.b/c', quoteControl: true }), /not a quote-control pair/);
  assert.throws(() => ix.quoteOf({ mint: USDC, program: wallet('fake-program') }), /token program/);
  assert.notEqual(ix.coinAddresses(MINT, USDC_Q).canonicalPool, ix.coinAddresses(MINT).canonicalPool, 'the canonical pool is per quote mint');
  assert.equal(ix.coinAddresses(MINT, USDC_Q).bondingCurve, ix.coinAddresses(MINT).bondingCurve);
});

test('the atomic launch on a custom pair opens the quote accounts, buys in the pair and verifies the creator fee', () => {
  const quotes = fx.pumpQuotes({ global: GLOBAL, quoteControl: { mints: [{ mint: XSTOCK, initialVirtualQuoteReserves: 120000000000n }] } }), entry = quotes[2];
  const quote = fx.launchQuote({ global: GLOBAL, feeConfig: null, devBuyRaw: 2000000000n, quote: entry, creatorFeeBps: 250n });
  assert.ok(quote.tokens > 0n && quote.costLamports <= 2000000000n);
  assert.ok(fx.launchQuote({ global: GLOBAL, feeConfig: null, devBuyRaw: 2000000000n, quote: entry }).tokens > quote.tokens, 'a higher chosen creator fee is charged in the quote');
  const shareholders = shareholdersFor('creator', { protocolWallet: PROTOCOL, recipient: DEV }), transfers = [{ to: PROTOCOL, lamports: '12000000' }];
  const list = fx.launchInstructions({ mint: MINT, launchWallet: LAUNCH, developer: DEV, name: 'Scout', symbol: 'SCT', uri: 'https://a.example/m.json', shareholders, tokens: quote.tokens, maxSolCost: 2000000000n, global: GLOBAL, transfers, quote: X_Q, quoteControl: true, creatorFeeBps: 250n });
  const a = ix.coinAddresses(MINT, X_Q);
  assert.deepEqual(list.map(i => i.programId === PUMP ? 'pump' : i.programId === FEES ? 'fees' : i.programId === ATA ? 'ata' : i.programId), ['pump', 'ata', 'ata', 'ata', 'fees', 'fees', 'ata', 'pump', 'ata', TOKEN_2022_PROGRAM, TOKEN_2022_PROGRAM, SYSTEM_PROGRAM]);
  assert.deepEqual(list.slice(1, 4).map(i => [i.keys[2].pubkey, i.keys[5].pubkey]), [[LAUNCH, TOKEN_2022_PROGRAM], [a.sharedCreatorVault, TOKEN_2022_PROGRAM], [a.ammCreatorVaultAuthority, TOKEN_2022_PROGRAM]], 'launch, shared-vault and AMM creator-vault quote accounts exist before fee sharing and the buy');
  const update = list[5], specUpdate = instructionSpec('pump_fees', 'update_fee_shares_v2').accounts.map(x => x.name);
  assert.equal(update.keys[specUpdate.indexOf('quote_mint')].pubkey, XSTOCK); assert.equal(update.keys[specUpdate.indexOf('pump_creator_vault_ata')].pubkey, a.sharedCreatorVaultQuoteAta);
  assert.deepEqual(update.keys.slice(specUpdate.length).map(k => k.pubkey), [LAUNCH, associatedTokenAddress(LAUNCH, XSTOCK, TOKEN_2022_PROGRAM)], 'the current shareholder and its quote account');
  const buy = list[7], spec = instructionSpec('pump', 'buy_v2').accounts.map(x => x.name), at = name => buy.keys[spec.indexOf(name)].pubkey;
  assert.equal(at('quote_mint'), XSTOCK); assert.equal(at('quote_token_program'), TOKEN_2022_PROGRAM); assert.equal(at('associated_quote_user'), associatedTokenAddress(LAUNCH, XSTOCK, TOKEN_2022_PROGRAM));
  assert.equal(at('associated_creator_vault'), a.sharedCreatorVaultQuoteAta);
  assert.equal(decodeInstructionArgs('pump', 'create_v2', list[0].data).creator_fee_bps, 250n);
  // Simulated post-state: the pair spend is bounded by the dev-buy budget and the coin carries the chosen fee.
  const watch = fx.launchWatchList({ mint: MINT, launchWallet: LAUNCH, developer: DEV, transfers, quote: X_Q });
  assert.equal(watch.at(-1), associatedTokenAddress(LAUNCH, XSTOCK, TOKEN_2022_PROGRAM));
  const after = fee => [account(SYSTEM_PROGRAM, Buffer.alloc(0), 30000000n), tokenAccount(MINT, DEV, quote.tokens), bondingCurve(X_Q, { creator_fee_bps: fee }), sharing(shareholders), coinMint(), account(SYSTEM_PROGRAM, Buffer.alloc(0), 12000000n), tokenAccount(XSTOCK, LAUNCH, 2000000000n - quote.costLamports)];
  const base = { mint: MINT, launchWallet: LAUNCH, developer: DEV, shareholders, tokens: quote.tokens, transfers, before: { launchLamports: 72000000n, recipients: { [PROTOCOL]: 0n }, launchQuote: 2000000000n }, maxDebit: 72000000n, quote: X_Q, creatorFeeBps: 250n, maxQuoteDebit: 2000000000n };
  const ok = fx.verifyLaunchState({ ...base, after: after(250n) });
  assert.equal(ok.spentQuote, quote.costLamports); assert.equal(ok.creatorFeeBps, 250n);
  assert.throws(() => fx.verifyLaunchState({ ...base, after: after(0n) }), /reviewed creator fee/);
  assert.throws(() => fx.verifyLaunchState({ ...base, maxQuoteDebit: quote.costLamports - 1n, after: after(250n) }), /quote asset than its dev-buy budget/);
  assert.throws(() => fx.verifyLaunchState({ ...base, after: [after(250n)[0], after(250n)[1], bondingCurve(USDC_Q), ...after(250n).slice(3)] }), /different quote asset/);
});

test('finalized pair launch, token-share distribution legs and pair-asset funding', () => {
  // Launch receipt: the create event names the pair and the pair spend stays within the budget.
  const launchQuoteAta = associatedTokenAddress(LAUNCH, USDC, TOKEN_PROGRAM), devAta = associatedTokenAddress(DEV, MINT, TOKEN_2022_PROGRAM);
  const created = quoteMint => base58Encode(encodeEvent('pump', 'CreateEvent', { name: 'Scout', symbol: 'SCT', uri: 'https://x/y', mint: MINT, bonding_curve: ix.coinAddresses(MINT).bondingCurve, user: LAUNCH, creator: LAUNCH, timestamp: 1n, virtual_token_reserves: 1n, virtual_sol_reserves: 1n, real_token_reserves: 1n, token_total_supply: 1n, token_program: TOKEN_2022_PROGRAM, is_mayhem_mode: false, is_cashback_enabled: false, quote_mint: quoteMint, virtual_quote_reserves: 1n, creator_fee_bps: 0n, is_holder_reward: false }));
  const keys = [LAUNCH, MINT, launchQuoteAta, devAta, PUMP, ix.pumpAddresses.eventAuthority];
  const launchTx = quoteMint => txFixture({ keys, top: [{ programIdIndex: 4, accounts: [1, 0], data: '1' }], inner: [{ index: 0, instructions: [{ programIdIndex: 4, accounts: [5], data: created(quoteMint) }] }], pre: [72000000, 0, 2039280, 0, 1, 1], post: [40000000, 1461600, 2039280, 2039280, 1, 1],
    preTokens: [{ accountIndex: 2, mint: USDC, owner: LAUNCH, uiTokenAmount: { amount: '25000000' } }], postTokens: [{ accountIndex: 2, mint: USDC, owner: LAUNCH, uiTokenAmount: { amount: '1000' } }, { accountIndex: 3, mint: MINT, owner: DEV, uiTokenAmount: { amount: '777' } }] });
  const effects = fx.launchReceiptEffects(launchTx(USDC), { mint: MINT, launchWallet: LAUNCH, developer: DEV, tokens: 777n, quote: USDC_Q, maxQuoteDebit: 25000000n });
  assert.equal(effects.quoteSpent, 24999000n); assert.equal(effects.tokens, 777n);
  assert.throws(() => fx.launchReceiptEffects(launchTx(NATIVE_MINT), { mint: MINT, launchWallet: LAUNCH, developer: DEV, tokens: 777n, quote: USDC_Q, maxQuoteDebit: 25000000n }), /different quote asset/);
  assert.throws(() => fx.launchReceiptEffects(launchTx(USDC), { mint: MINT, launchWallet: LAUNCH, developer: DEV, tokens: 777n, quote: USDC_Q, maxQuoteDebit: 1000n }), /dev-buy budget/);
  // Distribution in USDC: legs are the shareholders' token gains; the payer's SOL fee never reduces a leg.
  const shareholders = [{ address: PROTOCOL, shareBps: 1000 }, { address: MODE, shareBps: 9000 }], a = ix.coinAddresses(MINT, USDC_Q);
  const event = base58Encode(encodeEvent('pump', 'DistributeCreatorFeesEvent', { timestamp: 1760000000n, mint: MINT, bonding_curve: a.bondingCurve, sharing_config: a.sharingConfig, admin: LAUNCH, shareholders: shareholders.map(s => ({ address: s.address, share_bps: s.shareBps })), distributed: 50000000n, quote_mint: USDC }));
  const pAta = associatedTokenAddress(PROTOCOL, USDC, TOKEN_PROGRAM), mAta = associatedTokenAddress(MODE, USDC, TOKEN_PROGRAM);
  const dkeys = [PROTOCOL, MODE, pAta, mAta, a.sharedCreatorVaultQuoteAta, PUMP, ix.pumpAddresses.eventAuthority];
  const dist = txFixture({ keys: dkeys, top: [{ programIdIndex: 5, accounts: [0, 1, 2, 3, 4], data: '1' }], inner: [{ index: 0, instructions: [{ programIdIndex: 5, accounts: [6], data: event }] }], pre: [12000000, 0, 0, 0, 2039280, 1, 1], post: [12000000 - 5000 - 2 * 2039280, 0, 2039280, 2039280, 2039280, 1, 1],
    preTokens: [{ accountIndex: 4, mint: USDC, owner: a.sharedCreatorVault, uiTokenAmount: { amount: '50000000' } }], postTokens: [{ accountIndex: 2, mint: USDC, owner: PROTOCOL, uiTokenAmount: { amount: '5000000' } }, { accountIndex: 3, mint: USDC, owner: MODE, uiTokenAmount: { amount: '45000000' } }, { accountIndex: 4, mint: USDC, owner: a.sharedCreatorVault, uiTokenAmount: { amount: '0' } }] });
  const legs = fx.distributionLegs(dist, { mint: MINT, quote: USDC_Q });
  assert.deepEqual(legs.anomalies, []); assert.deepEqual(legs.legs.map(l => [l.recipient, l.amount]), [[PROTOCOL, 5000000n], [MODE, 45000000n]]);
  assert.equal(fx.distributionLegs(dist, { mint: MINT }).legs.length, 0, 'a SOL reading of a USDC distribution finds nothing');
  assert.equal(fx.lamportDelta(dist, fx.txKeys(dist), PROTOCOL), -(5000n + 2n * 2039280n), 'the payer pays the fee and opens the shareholder accounts');
  // Funding: SOL for costs plus the exact dev-buy USDC, one signer, with the memo.
  const memo = 'pump-launch:' + 'a'.repeat(24), fromAta = associatedTokenAddress(DEV, USDC, TOKEN_PROGRAM), toAta = launchQuoteAta;
  const transfer = Buffer.alloc(12); transfer.writeUInt32LE(2, 0); transfer.writeBigUInt64LE(72000000n, 4);
  const funding = (over = {}) => txFixture({ keys: [DEV, LAUNCH, fromAta, toAta, SYSTEM_PROGRAM, MEMO_PROGRAM, TOKEN_PROGRAM], top: [{ programIdIndex: 4, accounts: [0, 1], data: base58Encode(transfer) }, { programIdIndex: 5, accounts: [], data: base58Encode(Buffer.from(over.memo ?? memo)) }],
    pre: [100000000, 0, 2039280, 0, 1, 1, 1], post: [100000000 - 72000000 - 5000 - 2039280, 72000000, 2039280, 2039280, 1, 1, 1],
    preTokens: [{ accountIndex: 2, mint: USDC, owner: DEV, uiTokenAmount: { amount: '30000000' } }], postTokens: [{ accountIndex: 2, mint: USDC, owner: DEV, uiTokenAmount: { amount: String(30000000 - (over.moved ?? 25000000)) } }, { accountIndex: 3, mint: USDC, owner: LAUNCH, uiTokenAmount: { amount: String(over.moved ?? 25000000) } }], signers: over.signers ?? 1 });
  const ok = fx.quoteFundingEffects(funding(), { sender: DEV, recipient: LAUNCH, lamports: 72000000n, memo, quote: USDC_Q, tokenAmount: 25000000n });
  assert.deepEqual([ok.state, ok.receivedLamports, ok.receivedTokens], ['finalized', 72000000n, 25000000n]);
  assert.throws(() => fx.quoteFundingEffects(funding({ moved: 24000000 }), { sender: DEV, recipient: LAUNCH, lamports: 72000000n, memo, quote: USDC_Q, tokenAmount: 25000000n }), /different amount of the quote asset/);
  assert.throws(() => fx.quoteFundingEffects(funding({ memo: 'pump-launch:' + 'b'.repeat(24) }), { sender: DEV, recipient: LAUNCH, lamports: 72000000n, memo, quote: USDC_Q, tokenAmount: 25000000n }), /launch memo/);
  assert.throws(() => fx.quoteFundingEffects(funding({ signers: 2 }), { sender: DEV, recipient: LAUNCH, lamports: 72000000n, memo, quote: USDC_Q, tokenAmount: 25000000n }), /funding wallet alone/);
  assert.equal(fx.quoteFundingEffects({ ...funding(), meta: { ...funding().meta, err: { InstructionError: [0, 'x'] } } }, { sender: DEV, recipient: LAUNCH, lamports: 72000000n, memo, quote: USDC_Q, tokenAmount: 25000000n }).state, 'failed');
});

test('distribution and sweeps on another pair initialize shareholder accounts and pass the pair accounts', () => {
  const a = ix.coinAddresses(MINT, USDC_Q);
  const d = ix.distributeCreatorFeesV2({ payer: PROTOCOL, mint: MINT, shareholders: [PROTOCOL, MODE], quote: USDC_Q });
  assert.deepEqual(decodeInstructionArgs('pump', 'distribute_creator_fees_v2', d.data), { initialize_ata: true });
  const spec = instructionSpec('pump', 'distribute_creator_fees_v2').accounts.length;
  assert.deepEqual(d.keys.slice(spec).map(k => k.pubkey), [PROTOCOL, MODE, associatedTokenAddress(PROTOCOL, USDC, TOKEN_PROGRAM), associatedTokenAddress(MODE, USDC, TOKEN_PROGRAM)]);
  assert.ok(d.keys.some(k => k.pubkey === a.sharedCreatorVaultQuoteAta));
  const sweep = ix.transferCreatorFeesToPumpV2({ payer: PROTOCOL, mint: MINT, quote: USDC_Q });
  assert.ok(sweep.keys.some(k => k.pubkey === a.ammCreatorVaultAta) && sweep.keys.some(k => k.pubkey === USDC));
  assert.equal(fx.pendingCreatorFees({ vaultLamports: 9000000n, vaultRentExempt: 890880n, vaultQuoteAmount: 3000000n, ammVaultAmount: 1000000n }).total, 4000000n, 'a pair coin’s pending fees are its vault token balances');
});

test('public trades on another pair are read in the pair asset', () => {
  const a = ix.coinAddresses(MINT, USDC_Q), BUYER = wallet('buyer');
  const trade = base58Encode(encodeEvent('pump', 'TradeEvent', { mint: MINT, sol_amount: 0n, token_amount: 8000000000000n, is_buy: true, user: BUYER, timestamp: 1760000100n, virtual_sol_reserves: 0n, virtual_token_reserves: 1065000000000000n, real_sol_reserves: 0n, real_token_reserves: 785100000000000n, fee_recipient: wallet('fee1'), fee_basis_points: 95n, fee: 1n, creator: a.sharingConfig, creator_fee_basis_points: 30n, creator_fee: 1n, track_volume: false, total_unclaimed_tokens: 0n, total_claimed_tokens: 0n, current_sol_volume: 0n, last_update_timestamp: 0n, ix_name: 'buy_v2', mayhem_mode: false, cashback_fee_basis_points: 0n, cashback: 0n, buyback_fee_basis_points: 0n, buyback_fee: 0n, shareholders: [], quote_mint: USDC, quote_amount: 37500000n, virtual_quote_reserves: 4537500000n, real_quote_reserves: 37500000n, holder_rewards_bps: 0n, holder_rewards: 0n }));
  const tx = txFixture({ keys: [BUYER, PUMP, ix.pumpAddresses.eventAuthority], top: [{ programIdIndex: 1, accounts: [0], data: '1' }], inner: [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [2], data: trade }] }], pre: [1, 1, 1], post: [1, 1, 1] });
  assert.deepEqual(fx.coinTrades(tx, { mint: MINT, native: false }).map(t => [t.side, t.tokens, t.lamports]), [['buy', 8000000000000n, 37500000n]]);
});
