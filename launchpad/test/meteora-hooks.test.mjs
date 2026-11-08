// Transfer hook rules on Meteora (v71.28, contract v2), server side. The service is driven through its own prepare/submit/reconcile
// logic with the transaction encoding stubbed (as meteora-vanity.test.mjs does); the chain adapter runs against a FakeConnection and
// a fake DBC client, with src/hooks/program.mjs (agent A's encoder) replaced by a stub of the v2 shapes. Nothing here signs or sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { TokenType, TokenAuthorityOption } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { MeteoraService, meteoraHookProgramId, meteoraHookAppMark, meteoraHookApps } from '../src/meteora-service.mjs';
import { MeteoraChainAdapter, METEORA_DBC_PROGRAM_ID, hookSetupFirstChunk, hookSetupSteps, hookShapeOf, HOOK_SETUP_FIRST_CHUNK_MAX } from '../src/meteora-chain.mjs';
import { meteoraHookTokenOptions } from '../src/meteora-policy.mjs';
import { meteoraDiscoveryRecord } from '../src/launchpad-explore.mjs';
import { generateWallet } from '../src/pump-classic/service.mjs';
import { HOOK_LIMITS, HOOK_ROUTES, HOOK_APP_SETTINGS, describeHookRule, hookRuleParams, hookLaunchRequest, hookAppTradeNote, describeHookAppMark } from '../public/hook-catalog.mjs';

const SOL = 'So11111111111111111111111111111111111111112', TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', SYSTEM = '11111111111111111111111111111111', SYSVAR_INSTRUCTIONS = 'Sysvar1nstructions1111111111111111111111111';
const PROGRAM = generateWallet().address, POOL_AUTHORITY = generateWallet().address, DAMM_POOL_AUTHORITY = generateWallet().address, MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const key = () => new PublicKey(generateWallet().address), str = value => value?.toBase58?.() ?? String(value), wallets = n => Array.from({ length: n }, () => generateWallet().address);
// Seeds: a literal word (`'config'`, `'wallet'`, …) or a key (PublicKey or base58 address).
const pda = (programId, seeds) => { const [address, bump] = PublicKey.findProgramAddressSync(seeds.map(seed => typeof seed === 'string' && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(seed) ? Buffer.from(seed) : new PublicKey(str(seed)).toBuffer()), new PublicKey(str(programId))); return { address: address.toBase58(), bump, key: address }; };
const SUPPLY = 1_000_000_000_000_000n;

/** Agent A's src/hooks/program.mjs v2 interface, stubbed with the same shapes (its JS encoder API); every call is recorded. */
function fakeHooks(calls = []) {
  const built = (name, args, tag, data) => { calls.push({ name, args }); return { programId: args.programId, keys: [{ pubkey: args.payer || args.creator || args.wallet, isSigner: true, isWritable: true }], data: data || Buffer.from([tag]), name, args }; };
  const shape = rules => { const kinds = new Set((rules || []).map(r => Number(r.kind))); const sysvar = kinds.has(21) || kinds.has(25) || kinds.has(26) || kinds.has(27), blocklist = kinds.has(17), walletState = kinds.has(3), allowlist = kinds.has(1), holderGated = kinds.has(2); return { sysvar, blocklist, walletState, allowlist, holderGated, count: 1 + sysvar + blocklist + 2 * walletState + allowlist + 4 * holderGated }; };
  const resolve = args => {
    const s = shape(args.rules), programId = new PublicKey(str(args.programId)), mint = str(args.mint), list = [{ pubkey: pda(programId, ['config', mint]).key, isWritable: true }];
    if (s.sysvar) list.push({ pubkey: new PublicKey(SYSVAR_INSTRUCTIONS), isWritable: false });
    if (s.blocklist) list.push({ pubkey: pda(programId, ['block', mint]).key, isWritable: false });
    if (s.walletState) list.push({ pubkey: pda(programId, ['wallet', mint, args.sourceOwner]).key, isWritable: true }, { pubkey: pda(programId, ['wallet', mint, args.destinationOwner]).key, isWritable: true });
    if (s.allowlist) list.push({ pubkey: pda(programId, ['allow', mint, args.destinationOwner]).key, isWritable: false });
    if (s.holderGated) { if (!args.gateMint || !args.gateTokenProgram) throw TypeError('gate keys missing'); list.push({ pubkey: new PublicKey(ATA_PROGRAM), isWritable: false }, { pubkey: new PublicKey(str(args.gateTokenProgram)), isWritable: false }, { pubkey: new PublicKey(str(args.gateMint)), isWritable: false }, { pubkey: pda(ATA_PROGRAM, [args.destinationOwner, args.gateTokenProgram, args.gateMint]).key, isWritable: false }); }
    return list.map(meta => ({ ...meta, isSigner: false }));
  };
  return {
    calls,
    HOOK_PARAM_COUNT: 6, RULE_LEN: 49, MAX_RULES: 4, HOOK_CONFIG_SIZE: 784, WALLET_STATE_SIZE: 50, ALLOW_ENTRY_SIZE: 66, BLOCKLIST_SIZE: 8 + 200 * 32,
    SYSVAR_INSTRUCTIONS_ID: new PublicKey(SYSVAR_INSTRUCTIONS),
    hookShape: shape, extraMetasSize: rules => 16 + 35 * (Array.isArray(rules) ? shape(rules) : rules).count,
    hookConfigPda: (programId, mint) => pda(programId, ['config', mint]),
    walletStatePda: (programId, mint, owner) => pda(programId, ['wallet', mint, owner]),
    allowEntryPda: (programId, mint, wallet) => pda(programId, ['allow', mint, wallet]),
    extraMetasPda: (programId, mint) => pda(programId, ['extra-account-metas', mint]),
    blocklistPda: (programId, mint) => pda(programId, ['block', mint]),
    // InitConfig carries the v2 payload (tag + 493 bytes), so the first-chunk arithmetic behaves as in production.
    initConfig: args => built('initConfig', args, 1, Buffer.concat([Buffer.from([1]), Buffer.alloc(493, 7)])),
    initializeExtraAccountMetaList: args => built('initializeExtraAccountMetaList', args, 0),
    addAllowed: args => built('addAllowed', args, 2),
    removeAllowed: args => built('removeAllowed', args, 3),
    registerWallet: args => built('registerWallet', args, 4),
    addBlocked: args => { if (!Array.isArray(args.wallets) || args.wallets.length < 1 || args.wallets.length > 28) throw RangeError('1..28 wallets'); return built('addBlocked', args, 5, Buffer.concat([Buffer.from([5, args.wallets.length]), ...args.wallets.map(w => new PublicKey(str(w)).toBuffer())])); },
    resolveExecuteAccounts: args => { calls.push({ name: 'resolveExecuteAccounts', args }); return resolve(args); },
    hookRemainingAccounts: args => { calls.push({ name: 'hookRemainingAccounts', args }); return [...resolve(args), { pubkey: new PublicKey(str(args.programId)), isSigner: false, isWritable: false }, { pubkey: pda(args.programId, ['extra-account-metas', str(args.mint)]).key, isSigner: false, isWritable: false }]; },
    decodeBlocklist: data => { const buffer = Buffer.from(data); if (buffer.length < 8) throw Error('not a BlockList'); const count = buffer[2]; return { version: buffer[0], bump: buffer[1], count, wallets: Array.from({ length: count }, (_, i) => new PublicKey(buffer.subarray(8 + 32 * i, 40 + 32 * i)).toBase58()) }; },
    decodeWalletState: () => ({ version: 2 }),
    HOOK_ERRORS: { 6004: { name: 'Anti-dump caps', message: 'The sell moves more of the supply than the rule allows.' }, 6025: { name: 'Tithe', message: 'The trade carries no donation.' }, 6100: { name: 'WalletNotRegistered', message: 'The wallet has no record yet.' } },
    hookErrorMessage: (value, options = {}) => { calls.push({ name: 'hookErrorMessage', args: options }); return value?.err?.InstructionError?.[1]?.Custom === 6004 ? 'One sell may move at most the allowed share of the supply.' : null; },
    allowEntryFilters: mint => [{ dataSize: 66 }, { memcmp: { offset: 2, bytes: str(mint) } }],
    decodeAllowEntry: data => ({ version: 1, bump: 255, mint: new PublicKey(data.subarray(2, 34)).toBase58(), wallet: new PublicKey(data.subarray(34, 66)).toBase58() }),
  };
}

class FakeConnection {
  constructor() { this.accounts = new Map(); this.rentSizes = []; this.reads = []; this.fallback = null; }
  set(address, info) { this.accounts.set(str(address), info); return this; }
  lookup(address) { const hit = this.accounts.get(str(address)); return hit === undefined ? this.fallback : hit; }
  async getAccountInfo(address) { this.reads.push(str(address)); return this.lookup(address); }
  async getMultipleAccountsInfo(addresses) { return addresses.map(address => this.lookup(address)); }
  async getMinimumBalanceForRentExemption(size) { this.rentSizes.push(size); return 890880 + 6960 * size; }
  async getBalance() { return 10_000_000_000; }
  async getGenesisHash() { return MAINNET; }
}

/** A hook record as the service freezes it at launch (contract v2), derived through the adapter so the PDAs match what it verifies later. */
async function hookRecord(adapter, launch, input, { gateDecimals = 0, gateTokenProgram = null } = {}) {
  const plan = hookLaunchRequest(input), addresses = await adapter.hookAddresses({ mint: launch.mint, quoteMint: launch.quoteMint, configAddress: launch.configAddress, program: PROGRAM });
  return { ...plan, gateDecimals, gateTokenProgram, program: PROGRAM, configPda: addresses.configPda, extraMetasPda: addresses.extraMetasPda, blocklistPda: plan.needsBlocklist ? addresses.blocklistPda : null, exempt: [launch.creatorWallet, launch.partnerAuthority, launch.partnerAuthority, addresses.dammPoolAuthority], venue: addresses.baseVault, tokenType: 'token2022', createdWithHook: true, allowlist: [], createdAt: 1 };
}
const RULES = { rules: [{ id: 'anti_dump', settings: { maxBuyPct: 2, maxSellPct: 0.25 } }, { id: 'holder_vesting', settings: { cliffHours: 24, unlockPct: 10, periodHours: 24, minBuyPct: 0.05 } }] };
const VESTING_THRESHOLD = SUPPLY * 500n / 1_000_000n; // minBuyPct 0.05% = 500 ppm of the supply

function chainFixture() {
  const connection = new FakeConnection(), adapter = new MeteoraChainAdapter({ connection, now: () => 1_790_000_000_000 });
  const poolAuthority = new PublicKey(POOL_AUTHORITY), dammAuthority = new PublicKey(DAMM_POOL_AUTHORITY), pool = key(), baseVault = key(), sdk = [], hooks = fakeHooks();
  const wallet = generateWallet().address, authority = generateWallet().address, treasury = generateWallet().address;
  const launch = { mint: generateWallet().address, configAddress: generateWallet().address, creatorAuthority: generateWallet().address, creatorWallet: wallet, partnerAuthority: authority, treasury, quoteMint: SOL, quoteProgram: TOKEN_PROGRAM, quoteDecimals: 9, quoteSymbol: 'SOL', priceSnapshot: { usd: '150' }, name: 'Hooked coin', symbol: 'HOOK', metadataUri: 'https://launch.example/api/launchpad/metadata/x.json', migrationPositionMints: [generateWallet().address, generateWallet().address], creationFee: { lamports: '0', recipient: treasury }, firstBuyRaw: '0', status: 'draft' };
  // SDK derivations and the transaction encoder are replaced; the adapter's own logic (stage choice, verification, post-processing) runs.
  Object.assign(adapter, { hooks, poolAuthority: () => poolAuthority, dammPoolAuthority: () => dammAuthority, poolAddress: () => pool, baseVaultAddress: () => baseVault, instruction: built => built, verifyQuote: async () => ({ tlvData: Buffer.alloc(0) }), quoteAccountSize: () => 165, config: async () => null, rawState: async () => null, sdkPoolConfig: async config => { sdk.push({ name: 'getPoolConfig', params: { config } }); return { swapBaseAmount: '793100000000000' }; }, systemTransfer: args => ({ name: 'systemTransfer', programId: new PublicKey(SYSTEM), args, keys: [] }), associatedToken: (mint, owner) => pda(ATA_PROGRAM, [owner, mint]).key, readHookedMint: async () => ({ mintAuthority: null, freezeAuthority: null, supply: String(SUPPLY), decimals: 6, transferHookProgram: PROGRAM }) });
  adapter.dbcForHooks = () => adapter.dbc;
  adapter.prepareTransaction = async args => ({ action: args.action, instructions: args.instructions, requiredSigners: [args.wallet], review: { ...args.review, maxWalletDebitLamports: '1000000' }, addresses: args.addresses || {}, ...(args.extra || {}) });
  const record = (name, params) => { sdk.push({ name, params }); return { instructions: [{ name, params, programId: key(), keys: [] }] }; };
  const ix = (name, programId, keys, data = Buffer.from([0])) => ({ name, programId: new PublicKey(str(programId)), keys: keys.map(k => ({ pubkey: new PublicKey(str(k.pubkey ?? k)), isSigner: k.isSigner === true, isWritable: k.isWritable === true })), data });
  // The SDK's own resolution: placeholders for the source, destination and owner (the hook README's "Launchpad route").
  const f = { adapter, connection, launch, wallet, authority, treasury, poolAuthority, dammAuthority, pool, baseVault, sdk, hooks, ix, swapFixedKeys: null, sdkBlockOverride: null, quote: { outputAmount: '500', minimumAmountOut: '495' } };
  f.sdkBlock = () => f.sdkBlockOverride || hooks.hookRemainingAccounts({ programId: new PublicKey(PROGRAM), mint: new PublicKey(launch.mint), sourceOwner: PublicKey.default, destinationOwner: PublicKey.default, rules: launch.hook.rules, gateMint: launch.hook.gateMint ? new PublicKey(launch.hook.gateMint) : null, gateTokenProgram: launch.hook.gateTokenProgram ? new PublicKey(launch.hook.gateTokenProgram) : null });
  f.curveBlock = (sourceOwner, destinationOwner) => hooks.hookRemainingAccounts({ programId: new PublicKey(PROGRAM), mint: new PublicKey(launch.mint), sourceOwner: new PublicKey(str(sourceOwner)), destinationOwner: new PublicKey(str(destinationOwner)), rules: launch.hook.rules, gateMint: launch.hook.gateMint ? new PublicKey(launch.hook.gateMint) : null, gateTokenProgram: launch.hook.gateTokenProgram ? new PublicKey(launch.hook.gateTokenProgram) : null }).map(m => [str(m.pubkey), m.isWritable, false]);
  const swapTransaction = params => { f.swapFixedKeys = [{ pubkey: poolAuthority }, { pubkey: new PublicKey(launch.configAddress) }, { pubkey: pool, isWritable: true }, { pubkey: key(), isWritable: true }, { pubkey: key(), isWritable: true }, { pubkey: baseVault, isWritable: true }, { pubkey: key(), isWritable: true }, { pubkey: new PublicKey(launch.mint) }, { pubkey: new PublicKey(SOL) }, { pubkey: params.owner, isSigner: true, isWritable: true }, { pubkey: new PublicKey(TOKEN_2022) }, { pubkey: new PublicKey(TOKEN_PROGRAM) }, { pubkey: METEORA_DBC_PROGRAM_ID }, { pubkey: key() }, { pubkey: METEORA_DBC_PROGRAM_ID }]; return { instructions: [ix('wrapSol', SYSTEM, [{ pubkey: params.owner, isSigner: true, isWritable: true }]), ix('swap2WithTransferHook', METEORA_DBC_PROGRAM_ID, [...f.swapFixedKeys, ...f.sdkBlock()], Buffer.from([0xf8, 0xc6, 0x9e, 0x91, 7, 7, 7, 7, 1, 0])), ix('unwrapSol', TOKEN_PROGRAM, [{ pubkey: params.owner, isSigner: true, isWritable: true }], Buffer.from([9]))] }; };
  // The DBC program's Anchor-style method builders (`methods.claimCreatorTradingFee2(...).accountsPartial(...).remainingAccounts(...).instruction()`):
  // each call is recorded with its arguments, accounts and remaining accounts and yields an instruction whose keys are the accounts
  // in the order given followed by the remaining accounts, so tests can check the hook block and the receiver's token accounts.
  const builder = name => (...args) => { const call = { name, args, accounts: null, remaining: [] }; sdk.push(call); const chain = { accountsPartial(accounts) { call.accounts = accounts; return chain; }, remainingAccounts(list) { call.remaining = list; return chain; }, async instruction() { const asKey = v => { try { return new PublicKey(str(v)); } catch { return key(); } }; return ix(name, METEORA_DBC_PROGRAM_ID, [...Object.values(call.accounts || {}).map(v => ({ pubkey: asKey(v) })), ...call.remaining.map(m => ({ pubkey: m.pubkey, isWritable: m.isWritable === true }))], Buffer.from([7])); } }; return chain; };
  f.methods = Object.fromEntries(['claimCreatorTradingFee2', 'claimTradingFee2', 'claimCreatorTradingFee', 'claimTradingFee'].map(name => [name, builder(name)]));
  adapter.dbc = {
    partner: { createConfigWithTransferHook: async params => record('createConfigWithTransferHook', params), createConfig: async () => { throw Error('plain createConfig must not configure a hooked launch'); }, claimPartnerTradingFee2: async () => { throw Error('the SDK claim builder must not be used: claims are built from the program methods'); } },
    creator: { createPoolWithTransferHook: async params => record('createPoolWithTransferHook', params), createPoolWithFirstBuy: async () => { throw Error('createPoolWithFirstBuy must not create a hooked pool'); }, claimCreatorTradingFee2: async () => { throw Error('the SDK claim builder must not be used: claims are built from the program methods'); } },
    pool: { swapQuote2: () => f.quote, swap2WithTransferHook: async params => { sdk.push({ name: 'swap2WithTransferHook', params }); return f.swapOverride ? f.swapOverride(params) : swapTransaction(params); }, swap2: async params => record('swap2', params) },
    state: { getProgram: () => ({ account: { virtualPool: { size: 424 }, transferHookPool: { size: 424 } }, methods: f.methods }), getPoolConfig: async () => { throw Error('sdkPoolConfig is the seam'); } },
  };
  connection.set(PROGRAM, { executable: true, owner: new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111') });
  return f;
}
const configAccount = (launch, { creator = launch.creatorWallet, mint = launch.mint, version = 2 } = {}) => { const data = Buffer.alloc(784); data[0] = version; new PublicKey(mint).toBuffer().copy(data, 2); new PublicKey(creator).toBuffer().copy(data, 34); return { owner: new PublicKey(PROGRAM), data, lamports: 1, executable: false }; };
const metasAccount = () => ({ owner: new PublicKey(PROGRAM), data: Buffer.alloc(156), lamports: 1 });
const blocklistAccount = list => { const data = Buffer.alloc(8 + 200 * 32); data[0] = 1; data[1] = 255; data[2] = list.length; list.forEach((w, i) => new PublicKey(w).toBuffer().copy(data, 8 + 32 * i)); return { owner: new PublicKey(PROGRAM), data, lamports: 1 }; };

test('meteoraHookProgramId: unset is off, a base58 address is kept, anything else is refused with the setting named', () => {
  assert.equal(meteoraHookProgramId(undefined), null); assert.equal(meteoraHookProgramId(''), null); assert.equal(meteoraHookProgramId('  '), null);
  assert.equal(meteoraHookProgramId(` ${PROGRAM} `), PROGRAM);
  assert.throws(() => meteoraHookProgramId('not-an-address'), /LAUNCHPAD_HOOK_PROGRAM_ID must be the base58 address/);
  assert.throws(() => meteoraHookProgramId(PROGRAM.slice(0, 20)), /LAUNCHPAD_HOOK_PROGRAM_ID/);
});

test('hooked configure stage: createConfigWithTransferHook names the hook program and the SDK’s Token2022 + Immutable options by name, and budgets every hook account', async () => {
  const f = chainFixture(); f.launch.hook = await hookRecord(f.adapter, f.launch, RULES);
  const bundle = await f.adapter.prepareLaunch({ wallet: f.wallet, launch: f.launch });
  assert.equal(bundle.action, 'configure'); assert.equal(bundle.review.stage, 'configure'); assert.equal(bundle.review.stages, 3, 'a hooked launch has three approvals');
  const call = f.sdk.find(c => c.name === 'createConfigWithTransferHook'); assert.ok(call, 'the transfer-hook config builder is used'); assert.equal(f.sdk.some(c => c.name === 'createConfig'), false);
  assert.equal(str(call.params.transferHookProgram), PROGRAM, 'transferHookProgram is passed (the first build forgot it)');
  const options = meteoraHookTokenOptions();
  assert.equal(String(call.params.tokenType), String(TokenType.Token2022), 'tokenType is the SDK enum member TokenType.Token2022');
  assert.equal(String(call.params.tokenAuthorityOption), String(TokenAuthorityOption.Immutable), 'tokenAuthorityOption is the SDK enum member TokenAuthorityOption.Immutable: the mint authority is revoked at creation');
  assert.equal(String(call.params.tokenType), String(options.tokenType)); assert.equal(String(call.params.tokenAuthorityOption), String(options.tokenAuthorityOption)); assert.equal(call.params.tokenUpdateAuthority === undefined || String(call.params.tokenUpdateAuthority) === String(options.tokenAuthorityOption), true);
  assert.equal(str(call.params.payer), f.wallet); assert.equal(str(call.params.feeClaimer), f.authority); assert.equal(str(call.params.leftoverReceiver), f.authority); assert.equal(str(call.params.config), f.launch.configAddress);
  assert.ok(f.connection.rentSizes.includes(784), 'HookConfig rent (the encoder’s exact HOOK_CONFIG_SIZE) is in the launch budget'); assert.ok(f.connection.rentSizes.includes(16 + 35 * 3), 'ExtraAccountMetaList rent for config + two wallet records (holder vesting)'); assert.equal(f.connection.rentSizes.includes(8 + 200 * 32), false, 'no blocklist, no BlockList rent');
  assert.ok(BigInt(bundle.review.totalLaunchMaxDebitLamports) > BigInt(bundle.review.maxWalletDebitLamports)); assert.deepEqual(bundle.review.transferHook, { program: PROGRAM, rules: ['anti_dump', 'holder_vesting'], route: 'curve', gateMint: null, titheRecipient: null, blocklistCount: 0, tokenType: 'token2022' });
  // Holder-gated adds the four gate entries, a blocklist its own account; a plain launch budgets neither and keeps two stages.
  const gated = chainFixture(); gated.launch.hook = await hookRecord(gated.adapter, gated.launch, { rules: [{ id: 'holder_gated', settings: { minAmount: 1 } }], gateMint: generateWallet().address }, { gateDecimals: 6, gateTokenProgram: TOKEN_2022 });
  await gated.adapter.prepareLaunch({ wallet: gated.wallet, launch: gated.launch }); assert.ok(gated.connection.rentSizes.includes(16 + 35 * 5));
  const blocked = chainFixture(); blocked.launch.hook = await hookRecord(blocked.adapter, blocked.launch, { rules: ['blocklist', 'sniper_fee_cap'], blocklist: wallets(40) });
  const blockedBundle = await blocked.adapter.prepareLaunch({ wallet: blocked.wallet, launch: blocked.launch }); assert.ok(blocked.connection.rentSizes.includes(8 + 200 * 32), 'BlockList rent'); assert.ok(blocked.connection.rentSizes.includes(16 + 35 * 3), 'config + sysvar + blocklist entries'); assert.equal(blockedBundle.review.transferHook.blocklistCount, 40); assert.equal(blockedBundle.review.transferHook.route, 'any');
  // Without the encoder's size exports the adapter's own fallbacks budget the accounts.
  const bare = chainFixture(); bare.launch.hook = await hookRecord(bare.adapter, bare.launch, { rules: ['blocklist'], blocklist: wallets(3) }); bare.adapter.hooks = { ...bare.hooks, HOOK_CONFIG_SIZE: undefined, extraMetasSize: undefined, BLOCKLIST_SIZE: undefined };
  await bare.adapter.prepareLaunch({ wallet: bare.wallet, launch: bare.launch }); assert.ok(bare.connection.rentSizes.includes(800)); assert.ok(bare.connection.rentSizes.includes(16 + 35 * 2)); assert.ok(bare.connection.rentSizes.includes(8 + 200 * 32));
  assert.deepEqual(hookShapeOf([{ id: 'holder_vesting' }, { id: 'allowlist' }, { id: 'tithe' }]), { sysvar: true, blocklist: false, walletState: true, allowlist: true, holderGated: false, count: 5 });
  const plain = chainFixture(); plain.adapter.dbc.partner.createConfig = async params => ({ instructions: [{ name: 'createConfig', params }] });
  const plainBundle = await plain.adapter.prepareLaunch({ wallet: plain.wallet, launch: plain.launch }); assert.equal(plainBundle.review.stages, 2); assert.equal(plain.connection.rentSizes.includes(784), false); assert.equal(plainBundle.review.transferHook, undefined);
});

test('an undeployed hook program refuses every hooked stage before any SDK call, and a hooked first buy is refused', async () => {
  const f = chainFixture(); f.launch.hook = await hookRecord(f.adapter, f.launch, RULES); f.connection.set(PROGRAM, { executable: false });
  await assert.rejects(f.adapter.prepareLaunch({ wallet: f.wallet, launch: f.launch }), error => error.statusCode === 503 && /not deployed/.test(error.message));
  f.connection.set(PROGRAM, null); await assert.rejects(f.adapter.prepareLaunch({ wallet: f.wallet, launch: f.launch }), /not deployed/); assert.equal(f.sdk.length, 0);
  f.connection.set(PROGRAM, { executable: true });
  await assert.rejects(f.adapter.prepareLaunch({ wallet: f.wallet, launch: f.launch, firstBuyRaw: '1000000' }), /A hooked coin’s first buy is a separate trade after launch\./); assert.equal(f.sdk.length, 0);
});

test('hook-setup stage: [InitConfig, InitializeExtraAccountMetaList] paid and signed by the creator wallet, with the exact exempt keys, venues, tithe recipient, swapBaseAmount from the chain’s PoolConfig and six-parameter rules', async () => {
  const f = chainFixture(); const recipient = generateWallet().address; f.launch.hook = await hookRecord(f.adapter, f.launch, { rules: [...RULES.rules, { id: 'tithe', settings: { donationSol: 0.01 } }], titheRecipient: recipient }); f.adapter.config = async () => ({ exists: true });
  const bundle = await f.adapter.prepareLaunch({ wallet: f.wallet, launch: f.launch });
  assert.equal(bundle.action, 'configure', 'presented as a configure-kind approval so the launch flow continues unchanged'); assert.equal(bundle.review.stage, 'hook-setup'); assert.equal(bundle.hookSetup, true); assert.equal(bundle.review.stages, 3); assert.equal(bundle.review.step, '1/1', 'no blocklist: the setup is the only step');
  assert.deepEqual(bundle.instructions.map(ix => ix.name), ['initConfig', 'initializeExtraAccountMetaList'], 'the program reads the config when it writes the metas list, so InitConfig comes first');
  const [config, metas] = bundle.instructions;
  assert.equal(str(metas.args.programId), PROGRAM); assert.equal(str(metas.args.mint), f.launch.mint); assert.equal(str(metas.args.authority), f.wallet); assert.equal(str(metas.args.payer), f.wallet); assert.equal('holderGated' in metas.args, false, 'v2: the program derives the list shape from the config');
  assert.equal(str(config.args.creator), f.wallet); assert.equal(str(config.args.payer), f.wallet); assert.equal(str(config.args.mint), f.launch.mint);
  assert.deepEqual(config.args.exempt.map(str), [f.wallet, f.authority, f.authority, DAMM_POOL_AUTHORITY], 'creator wallet, partner authority, leftover receiver, DAMM v2 pool authority (the graduation transfer’s destination owner) — nothing else');
  assert.notEqual(str(config.args.exempt[3]), POOL_AUTHORITY, 'the DBC pool authority owns a venue and is never tested by the hook, so it takes no exempt slot');
  assert.deepEqual(config.args.venues.map(str), [f.baseVault.toBase58(), PublicKey.default.toBase58()]); assert.equal(config.args.gateMint, null); assert.equal(config.args.gateTokenProgram, null);
  assert.equal(str(config.args.titheRecipient), recipient); assert.equal(config.args.swapBaseAmount, '793100000000000', 'swapBaseAmount is the on-chain PoolConfig’s, read through the sdkPoolConfig seam'); assert.deepEqual(f.sdk.find(c => c.name === 'getPoolConfig').params, { config: new PublicKey(f.launch.configAddress) });
  assert.deepEqual(config.args.rules, [{ kind: 4, params: ['200', '25', '0', '0', '0', '0'] }, { kind: 3, params: ['0', '86400', '86400', '1000', '500', '0'] }, { kind: 25, params: ['10000000', '0', '0', '0', '0', '0'] }]); assert.deepEqual(config.args.rules[0].params, hookRuleParams('anti_dump', RULES.rules[0].settings));
  assert.equal(f.sdk.filter(c => c.name !== 'getPoolConfig').length, 0, 'no transaction-building SDK call in the setup stage'); assert.deepEqual(bundle.addresses, { hookConfig: f.launch.hook.configPda, hookExtraMetas: f.launch.hook.extraMetasPda, baseVault: f.baseVault.toBase58() });
  assert.deepEqual(bundle.transferHook, { program: PROGRAM, configPda: f.launch.hook.configPda, extraMetasPda: f.launch.hook.extraMetasPda, blocklistPda: null, swapBaseAmount: '793100000000000' }); assert.deepEqual(bundle.hookSetupStep, { kind: 'setup', step: 1, steps: 1, wallets: [], blocklistCountAfter: 0 });
  // A PoolConfig without a swap base amount cannot be written into the hook config.
  f.adapter.sdkPoolConfig = async () => ({ swapBaseAmount: '0' }); await assert.rejects(f.adapter.prepareLaunch({ wallet: f.wallet, launch: f.launch }), /no swap base amount/);
  f.adapter.sdkPoolConfig = async () => ({ swapBaseAmount: '793100000000000' });
  // The saved record must match what the launch derives: a changed exempt key, venue or an old record format is refused.
  const tampered = { ...f.launch, hook: { ...f.launch.hook, exempt: [f.wallet, f.authority, f.authority, generateWallet().address] } };
  await assert.rejects(f.adapter.prepareLaunch({ wallet: f.wallet, launch: tampered }), /exemptions do not match/);
  await assert.rejects(f.adapter.prepareLaunch({ wallet: f.wallet, launch: { ...f.launch, hook: { ...f.launch.hook, venue: generateWallet().address } } }), /addresses do not match/);
  await assert.rejects(f.adapter.prepareLaunch({ wallet: generateWallet().address, launch: f.launch }), /exemptions do not match/, 'only the creator wallet pays and signs the hook stages');
  await assert.rejects(f.adapter.prepareLaunch({ wallet: f.wallet, launch: { ...f.launch, hook: { ...f.launch.hook, version: 1 } } }), /earlier rules format/);
  // Holder-gated writes the gate keys; a record without the gate token program is refused.
  const gated = chainFixture(); const gateMint = generateWallet().address; gated.launch.hook = await hookRecord(gated.adapter, gated.launch, { rules: [{ id: 'holder_gated', settings: { minAmount: 2.5 } }], gateMint }, { gateDecimals: 6, gateTokenProgram: TOKEN_2022 }); gated.adapter.config = async () => ({ exists: true });
  const gatedConfig = (await gated.adapter.prepareLaunch({ wallet: gated.wallet, launch: gated.launch })).instructions[0].args; assert.equal(str(gatedConfig.gateMint), gateMint); assert.equal(str(gatedConfig.gateTokenProgram), TOKEN_2022); assert.deepEqual(gatedConfig.rules, [{ kind: 2, params: ['2500000', '6', '0', '0', '0', '0'] }]);
  await assert.rejects(gated.adapter.prepareLaunch({ wallet: gated.wallet, launch: { ...gated.launch, hook: { ...gated.launch.hook, gateTokenProgram: null } } }), /gate token program is missing/);
});

test('app-only rules (v71.36): the setup packs the app’s mark (frozen on the record) into the rule’s parameters — key in 0..3, kind in 4, account slot in 5; a record without it is refused; Launchpad never builds a trade for the coin while it is on the curve', async () => {
  const f = chainFixture(), app = generateWallet().address; f.adapter.config = async () => ({ exists: true });
  f.launch.hook = { ...(await hookRecord(f.adapter, f.launch, { rules: [{ id: 'max_per_wallet', settings: { maxPct: 1 } }, 'fomo_only'] })), appMark: { kind: 'signer', key: app, index: 0 } };
  assert.equal(f.launch.hook.route, 'app'); assert.equal(f.launch.hook.app, 'fomo'); assert.equal(f.launch.hook.needsSysvar, true);
  const bundle = await f.adapter.prepareLaunch({ wallet: f.wallet, launch: f.launch }), rules = bundle.instructions[0].args.rules;
  assert.equal(rules.length, 2); assert.equal(rules[1].kind, 26);
  const bytes = new PublicKey(app).toBytes(), expected = [0, 1, 2, 3].map(i => { let v = 0n; for (let j = 7; j >= 0; j--) v = (v << 8n) | BigInt(bytes[i * 8 + j]); return v.toString(); });
  assert.deepEqual(rules[1].params, [...expected, '2', '0'], 'the 32-byte key, little-endian u64s in params 0..3 (packed_key), kind 2 = signer, slot 0');
  assert.deepEqual(rules[1].params, hookRuleParams('fomo_only', {}, { appMark: { kind: 'signer', keyBytes: bytes, index: 0 } }));
  assert.deepEqual(hookRuleParams('pump_app_only', {}, { appMark: { kind: 'program-account', keyBytes: bytes, index: 5 } }), [...expected, '3', '5'], 'a program+account mark: kind 3 with the slot');
  assert.deepEqual(hookRuleParams('pump_app_only', {}, { appMark: { kind: 'program', keyBytes: bytes, index: 9 } }), [...expected, '1', '0'], 'a program mark ignores the slot');
  assert.equal(hookShapeOf(f.launch.hook.rules).sysvar, true, 'the app-only rule reads the instructions sysvar'); assert.equal(hookShapeOf(f.launch.hook.rules).count, 2);
  // A program+account mark on the record packs its slot; the chain adapter takes the mark as the service froze it.
  const slotted = await f.adapter.prepareLaunch({ wallet: f.wallet, launch: { ...f.launch, hook: { ...f.launch.hook, appMark: { kind: 'program-account', key: app, index: 5 } } } });
  assert.deepEqual(slotted.instructions[0].args.rules[1].params, [...expected, '3', '5']);
  await assert.rejects(f.adapter.prepareLaunch({ wallet: f.wallet, launch: { ...f.launch, hook: { ...f.launch.hook, appMark: null } } }), /no app mark recorded/);
  await assert.rejects(f.adapter.prepareLaunch({ wallet: f.wallet, launch: { ...f.launch, hook: { ...f.launch.hook, appMark: { kind: 'signer', key: '' } } } }), /no app mark recorded/);
  assert.throws(() => hookRuleParams('pump_app_only', {}, { appMark: { kind: 'signer', keyBytes: new Uint8Array(32), index: 0 } }), /Pump App-only: the app’s mark is not configured on this host/);
  assert.throws(() => hookRuleParams('fomo_only', {}), /not configured on this host/);
  assert.throws(() => hookRuleParams('fomo_only', {}, { appMark: { kind: 'co-signer', keyBytes: bytes, index: 0 } }), /not configured on this host/, 'an unknown kind');
  assert.throws(() => hookRuleParams('fomo_only', {}, { appMark: { kind: 'program-account', keyBytes: bytes, index: 64 } }), /the mark’s account slot must be 0 to 63/);
  // A trade on the curve is refused in the trade box's words before any SDK call; after graduation (DAMM) the hook is gone and the swap is ordinary.
  const t = tradeFixture(); t.launch.hook = { ...(await hookRecord(t.adapter, t.launch, { rules: ['pump_app_only'] })), appMark: { kind: 'program-account', key: app, index: 5 } }; t.launch.status = 'trading';
  await assert.rejects(t.adapter.prepareTrade({ wallet: generateWallet().address, launch: t.launch, side: 'buy', amountRaw: '1000' }), error => error.statusCode === 409 && error.message === hookAppTradeNote('Pump App'));
  await assert.rejects(t.adapter.prepareTrade({ wallet: generateWallet().address, launch: t.launch, side: 'sell', amountRaw: '1000' }), /Launchpad’s Buy and Sell are off for this coin while it is on the curve: its Pump App-only rule allows pool trades only through the Pump App app\. Trade it in Pump App; after graduation it trades anywhere, Launchpad included\./);
  assert.equal(t.sdk.some(c => /swap/i.test(c.name)), false, 'no swap was built');
});

test('hookSetupFirstChunk: the first AddBlocked carries what fits beside the v2 InitConfig (8 wallets, never 16), later chunks hold 28', () => {
  assert.equal(hookSetupFirstChunk({ initConfigDataLength: 494, metasDataLength: 1, total: 200 }), 8, 'a 494-byte InitConfig leaves room for 8 wallets under a 64-byte headroom');
  assert.equal(hookSetupFirstChunk({ initConfigDataLength: 494, metasDataLength: 1, total: 200, headroom: 0 }), 10);
  assert.equal(hookSetupFirstChunk({ initConfigDataLength: 494, metasDataLength: 1, total: 3 }), 3, 'never more than the list');
  assert.equal(hookSetupFirstChunk({ initConfigDataLength: 1, metasDataLength: 1, total: 200 }), HOOK_SETUP_FIRST_CHUNK_MAX, 'capped at 16 even when more would fit');
  assert.equal(hookSetupFirstChunk({ initConfigDataLength: 1100, metasDataLength: 1, total: 200 }), 0, 'a packet that is full carries no wallets');
  assert.equal(hookSetupSteps(200, 8), 1 + Math.ceil(192 / 28)); assert.equal(hookSetupSteps(8, 8), 1); assert.equal(hookSetupSteps(0, 0), 1); assert.equal(hookSetupSteps(36, 8), 2); assert.equal(hookSetupSteps(37, 8), 3); assert.equal(HOOK_LIMITS.blocklistBatch, 28);
});

test('blocklist coins: the first chunk rides with the setup, the rest come in ≤28-wallet steps chosen from the on-chain count; a list that differs from the plan is refused; the pool waits for the last chunk', async () => {
  const f = chainFixture(); const list = wallets(60); f.launch.hook = await hookRecord(f.adapter, f.launch, { rules: ['blocklist', { id: 'max_per_wallet', settings: { maxPct: 2 } }], blocklist: list }); f.adapter.config = async () => ({ exists: true });
  assert.equal(f.launch.hook.blocklistPda, pda(PROGRAM, ['block', f.launch.mint]).address);
  const first = await f.adapter.prepareLaunch({ wallet: f.wallet, launch: f.launch });
  assert.deepEqual(first.instructions.map(ix => ix.name), ['initConfig', 'initializeExtraAccountMetaList', 'addBlocked']); assert.equal(first.review.stage, 'hook-setup'); assert.equal(first.review.step, '1/3', '8 wallets now, then 28 and 24');
  const chunk1 = first.instructions[2].args; assert.deepEqual(chunk1.wallets.map(str), list.slice(0, 8)); assert.equal(str(chunk1.creator), f.wallet); assert.equal(str(chunk1.payer), f.wallet); assert.equal(str(chunk1.mint), f.launch.mint);
  assert.deepEqual(first.hookSetupStep, { kind: 'setup', step: 1, steps: 3, wallets: list.slice(0, 8), blocklistCountAfter: 8 }); assert.equal(first.addresses.hookBlocklist, f.launch.hook.blocklistPda); assert.equal(first.transferHook.blocklistPda, f.launch.hook.blocklistPda);
  // The setup finalized with 8 wallets: the next approval appends 28, step 2/3.
  f.connection.set(f.launch.hook.configPda, configAccount(f.launch)).set(f.launch.hook.extraMetasPda, metasAccount()).set(f.launch.hook.blocklistPda, blocklistAccount(list.slice(0, 8)));
  f.sdk.length = 0;
  const second = await f.adapter.prepareLaunch({ wallet: f.wallet, launch: f.launch });
  assert.equal(second.action, 'configure'); assert.equal(second.hookSetup, true); assert.equal(second.review.stage, 'hook-setup'); assert.equal(second.review.step, '2/3'); assert.deepEqual(second.instructions.map(ix => ix.name), ['addBlocked']);
  assert.deepEqual(second.instructions[0].args.wallets.map(str), list.slice(8, 36)); assert.deepEqual(second.hookSetupStep, { kind: 'blocklist', step: 2, steps: 3, wallets: list.slice(8, 36), blocklistCountAfter: 36 }); assert.equal(second.transferHook.swapBaseAmount, undefined, 'swapBaseAmount was written in step 1'); assert.equal(f.sdk.some(c => c.name === 'getPoolConfig'), false, 'no PoolConfig read for a chunk');
  assert.equal(f.hooks.calls.filter(c => c.name === 'initConfig').length >= 1, true, 'InitConfig is encoded only to size the first chunk'); assert.equal(f.hooks.calls.filter(c => c.name === 'addBlocked').at(-1).args.wallets.length, 28);
  // 36 on chain: the last chunk (24 wallets), step 3/3. The pool stage waits until the blocklist is complete.
  f.connection.set(f.launch.hook.blocklistPda, blocklistAccount(list.slice(0, 36)));
  const third = await f.adapter.prepareLaunch({ wallet: f.wallet, launch: f.launch }); assert.equal(third.review.step, '3/3'); assert.deepEqual(third.instructions[0].args.wallets.map(str), list.slice(36)); assert.equal(third.hookSetupStep.blocklistCountAfter, 60);
  f.connection.set(f.launch.hook.blocklistPda, blocklistAccount(list));
  const pool = await f.adapter.prepareLaunch({ wallet: f.wallet, launch: f.launch }); assert.equal(pool.action, 'initialize'); assert.equal(pool.review.stage, 'initialize'); assert.equal(pool.instructions[0].name, 'createPoolWithTransferHook');
  // hookSetupState reports the chain's count and completeness; a list whose prefix is not the plan is refused, as is a foreign owner.
  const complete = await f.adapter.hookSetupState(f.launch); assert.deepEqual({ ready: complete.ready, exists: complete.exists, blocklist: complete.blocklist }, { ready: true, exists: true, blocklist: { exists: true, count: 60, total: 60, complete: true } });
  f.connection.set(f.launch.hook.blocklistPda, blocklistAccount([...list.slice(0, 7), generateWallet().address])); await assert.rejects(f.adapter.prepareLaunch({ wallet: f.wallet, launch: f.launch }), /blocklist on chain differs/);
  f.connection.set(f.launch.hook.blocklistPda, { ...blocklistAccount(list.slice(0, 8)), owner: key() }); await assert.rejects(f.adapter.prepareLaunch({ wallet: f.wallet, launch: f.launch }), /not created by the hook program/);
  f.connection.set(f.launch.hook.blocklistPda, null); const none = await f.adapter.hookSetupState(f.launch); assert.deepEqual(none.blocklist, { exists: false, count: 0, total: 60, complete: false }); assert.equal(none.ready, false);
  // Before the setup exists, a BlockList account is impossible (AddBlocked needs the config) and is refused as an unexpected state.
  f.connection.set(f.launch.hook.configPda, null).set(f.launch.hook.extraMetasPda, null).set(f.launch.hook.blocklistPda, blocklistAccount(list.slice(0, 8))); await assert.rejects(f.adapter.hookSetupState(f.launch), /unexpected state/);
  // A small blocklist fits the setup transaction entirely: one step, no further approvals; the fee budget in the configure stage grows per approval.
  const small = chainFixture(); small.launch.hook = await hookRecord(small.adapter, small.launch, { rules: ['blocklist'], blocklist: wallets(5) }); small.adapter.config = async () => ({ exists: true });
  const only = await small.adapter.prepareLaunch({ wallet: small.wallet, launch: small.launch }); assert.equal(only.review.step, '1/1'); assert.equal(only.instructions[2].args.wallets.length, 5); assert.equal(only.hookSetupStep.steps, 1);
  // The blocklist chain reader: an absent account is an empty list; the decoded prefix is served.
  assert.deepEqual(await f.adapter.hookBlocklistOnChain(f.launch), list.slice(0, 8)); f.connection.set(f.launch.hook.blocklistPda, null); assert.deepEqual(await f.adapter.hookBlocklistOnChain(f.launch), []);
  await assert.rejects(small.adapter.hookBlocklistOnChain({ ...small.launch, hook: { ...small.launch.hook, needsBlocklist: false } }), /no blocklist rule/);
});

test('hooked initialize stage: createPoolWithTransferHook alone once the hook accounts exist, no first buy; a foreign hook config is refused', async () => {
  const f = chainFixture(); f.launch.hook = await hookRecord(f.adapter, f.launch, RULES); f.adapter.config = async () => ({ exists: true });
  f.connection.set(f.launch.hook.configPda, configAccount(f.launch)).set(f.launch.hook.extraMetasPda, metasAccount());
  f.launch.creationFee = { lamports: '15000000', recipient: f.launch.treasury };
  const bundle = await f.adapter.prepareLaunch({ wallet: f.wallet, launch: f.launch });
  assert.equal(bundle.action, 'initialize'); assert.equal(bundle.review.stage, 'initialize'); assert.equal(bundle.hookSetup, undefined);
  assert.equal(bundle.instructions[0].name, 'createPoolWithTransferHook'); assert.equal(bundle.instructions.length, 2, 'the pool creation and the creation fee transfer');
  const params = bundle.instructions[0].params; assert.equal(str(params.transferHookProgram), PROGRAM); assert.equal(str(params.payer), f.wallet); assert.equal(str(params.poolCreator), f.launch.creatorAuthority); assert.equal(str(params.baseMint), f.launch.mint); assert.equal(str(params.config), f.launch.configAddress); assert.equal(params.uri, f.launch.metadataUri);
  assert.equal(bundle.amountRaw, '0'); assert.equal(bundle.expectedTrade, null); assert.equal(bundle.executionVenue, 'dbc'); assert.deepEqual(bundle.transferHook, { program: PROGRAM, configPda: f.launch.hook.configPda, extraMetasPda: f.launch.hook.extraMetasPda, blocklistPda: null });
  assert.equal(f.hooks.calls.some(c => c.name === 'initConfig'), false, 'the setup is not repeated');
  // A config PDA somebody else created for this mint, or one of the two accounts missing, never becomes the base of a pool.
  f.connection.set(f.launch.hook.configPda, configAccount(f.launch, { creator: generateWallet().address }));
  await assert.rejects(f.adapter.prepareLaunch({ wallet: f.wallet, launch: f.launch }), /does not belong to this launch/);
  f.connection.set(f.launch.hook.configPda, configAccount(f.launch)).set(f.launch.hook.extraMetasPda, null);
  await assert.rejects(f.adapter.prepareLaunch({ wallet: f.wallet, launch: f.launch }), /unexpected state/);
  f.connection.set(f.launch.hook.configPda, { ...configAccount(f.launch), owner: key() }).set(f.launch.hook.extraMetasPda, metasAccount());
  await assert.rejects(f.adapter.prepareLaunch({ wallet: f.wallet, launch: f.launch }), /not created by the hook program/);
  assert.equal((await f.adapter.hookSetupState({ ...f.launch, hook: { ...f.launch.hook, configPda: generateWallet().address, extraMetasPda: generateWallet().address } })).exists, false);
});

function tradeFixture() {
  const f = chainFixture(), quoteVault = key();
  f.adapter.rawState = async () => ({ pool: { isMigrated: 0, quoteReserve: { lt: () => true }, baseVault: f.baseVault, quoteVault, creatorQuoteFee: '0', partnerQuoteFee: '0' }, virtual: {}, config: { migrationQuoteThreshold: 1 }, address: f.pool, slot: 5 });
  return f;
}
const dbcIx = bundle => bundle.instructions.find(ix => ix.programId instanceof PublicKey && ix.programId.equals(METEORA_DBC_PROGRAM_ID));
const tail = (ix, n) => ix.keys.slice(ix.keys.length - n).map(k => [str(k.pubkey), k.isWritable, k.isSigner]);

test('a trade on a hooked curve calls swap2WithTransferHook without hook accounts and replaces exactly the SDK’s trailing placeholder block with Launchpad’s resolution (buy: vault → trader; sell: trader → vault)', async () => {
  const f = tradeFixture(); f.launch.hook = await hookRecord(f.adapter, f.launch, { rules: ['allowlist', { id: 'max_per_wallet', settings: { maxPct: 1 } }] }); f.launch.status = 'trading';
  const buy = await f.adapter.prepareTrade({ wallet: f.wallet, launch: f.launch, side: 'buy', amountRaw: '1000', slippageBps: 100 }), resolved = f.hooks.calls.filter(c => c.name === 'hookRemainingAccounts').at(-1).args;
  assert.deepEqual(buy.instructions.map(ix => ix.name), ['wrapSol', 'swap2WithTransferHook', 'unwrapSol'], 'the SDK’s own wrap/unwrap stay; nothing is prepended for an allowlist coin');
  const swap = f.sdk.find(c => c.name === 'swap2WithTransferHook').params;
  assert.equal(swap.swapBaseForQuote, false); assert.equal(str(swap.owner), f.wallet); assert.equal(str(swap.pool), f.pool.toBase58()); assert.equal(swap.referralTokenAccount, null); assert.equal('transferHookAccounts' in swap, false, 'the SDK resolves the accounts itself; the old manual parameter is gone');
  const ix = dbcIx(buy), n = 2 + 2; // config, allow entry, program, metas PDA
  assert.equal(ix.keys.length, f.swapFixedKeys.length + n, 'N is unchanged, so the instruction data’s slice lengths stay valid'); assert.deepEqual(ix.keys.slice(0, f.swapFixedKeys.length).map(k => str(k.pubkey)), f.swapFixedKeys.map(k => str(k.pubkey)), 'the swap’s own accounts are untouched'); assert.deepEqual([...ix.data], [0xf8, 0xc6, 0x9e, 0x91, 7, 7, 7, 7, 1, 0], 'data is never touched');
  assert.deepEqual(tail(ix, n), f.curveBlock(POOL_AUTHORITY, f.wallet), 'a buy moves base vault → trader: the pool authority is the source owner, the trader the destination owner');
  const placeholder = f.sdkBlock().map(m => str(m.pubkey)); assert.notDeepEqual(tail(ix, n).map(k => k[0]), placeholder, 'the SDK’s placeholder entries are gone'); assert.equal(tail(ix, n)[0][0], f.launch.hook.configPda, 'config first'); assert.deepEqual(tail(ix, n).slice(-2).map(k => k[0]), [PROGRAM, f.launch.hook.extraMetasPda], 'program and list PDA last');
  assert.equal(str(resolved.sourceOwner), POOL_AUTHORITY); assert.equal(str(resolved.destinationOwner), f.wallet); assert.deepEqual(resolved.rules, f.launch.hook.rules); assert.equal(resolved.gateMint, null);
  assert.equal(f.sdk.some(c => c.name === 'swap2'), false, 'the plain swap is never used on a hooked curve'); assert.deepEqual(buy.review.transferHook, { program: PROGRAM, route: 'curve', registersWallet: false, titheLamports: null }); assert.equal(buy.review.expectedOutputRaw, '500'); assert.equal(buy.expectedTrade.minOutputRaw, '495');
  // A sell swaps the owners.
  const sell = await f.adapter.prepareTrade({ wallet: f.wallet, launch: f.launch, side: 'sell', amountRaw: '1000', slippageBps: 100 });
  assert.equal(f.sdk.at(-1).params.swapBaseForQuote, true); assert.deepEqual(tail(dbcIx(sell), n), f.curveBlock(f.wallet, POOL_AUTHORITY));
  // An 'any'-route coin (mint-derived and literal entries only) is resolved identically by the SDK; the check still runs and the block is rewritten with the same keys.
  const any = tradeFixture(); any.launch.hook = await hookRecord(any.adapter, any.launch, { rules: ['blocklist', 'sniper_fee_cap'], blocklist: wallets(3) });
  const anyBuy = await any.adapter.prepareTrade({ wallet: any.wallet, launch: any.launch, side: 'buy', amountRaw: '5', slippageBps: 50 }); assert.deepEqual(tail(dbcIx(anyBuy), 5), any.curveBlock(POOL_AUTHORITY, any.wallet)); assert.deepEqual(tail(dbcIx(anyBuy), 5).map(k => k[0]), any.sdkBlock().map(m => str(m.pubkey))); assert.equal(anyBuy.review.transferHook.route, 'any');
  // Holder-gated trades carry the gate accounts for the receiving side (its gate ATA).
  const gated = tradeFixture(); const gateMint = generateWallet().address; gated.launch.hook = await hookRecord(gated.adapter, gated.launch, { rules: [{ id: 'holder_gated', settings: { minAmount: 1 } }], gateMint }, { gateDecimals: 6, gateTokenProgram: TOKEN_2022 });
  const gatedBuy = await gated.adapter.prepareTrade({ wallet: gated.wallet, launch: gated.launch, side: 'buy', amountRaw: '5', slippageBps: 50 });
  const gatedArgs = gated.hooks.calls.filter(c => c.name === 'hookRemainingAccounts').at(-1).args; assert.equal(str(gatedArgs.gateMint), gateMint); assert.equal(str(gatedArgs.gateTokenProgram), TOKEN_2022);
  const gatedTail = tail(dbcIx(gatedBuy), 7); assert.equal(gatedTail[4][0], pda(ATA_PROGRAM, [gated.wallet, TOKEN_2022, gateMint]).address, 'the trader’s gate ATA, not the placeholder’s'); assert.deepEqual(gatedTail, gated.curveBlock(POOL_AUTHORITY, gated.wallet));
  // A plain coin keeps swap2 and resolves nothing.
  const plain = tradeFixture(); const plainTrade = await plain.adapter.prepareTrade({ wallet: plain.wallet, launch: plain.launch, side: 'buy', amountRaw: '5', slippageBps: 50 });
  assert.deepEqual(plainTrade.instructions.map(ix => ix.name), ['swap2']); assert.equal(plain.hooks.calls.length, 0); assert.equal(plainTrade.review.transferHook, undefined);
});

test('swap post-processing refuses an unexpected layout: a block that does not start with the config PDA or end with [program, metas PDA], a wrong count, no or two DBC instructions', async () => {
  const f = tradeFixture(); f.launch.hook = await hookRecord(f.adapter, f.launch, RULES); f.launch.status = 'trading';
  const trade = () => f.adapter.prepareTrade({ wallet: f.wallet, launch: f.launch, side: 'buy', amountRaw: '1000', slippageBps: 100 });
  const good = f.sdkBlock();
  f.sdkBlockOverride = [...good.slice(0, -1), { pubkey: key(), isSigner: false, isWritable: false }]; await assert.rejects(trade(), /unexpected hook account layout/, 'the list PDA must be last');
  f.sdkBlockOverride = [...good.slice(0, -2), { pubkey: key(), isSigner: false, isWritable: false }, good.at(-1)]; await assert.rejects(trade(), /unexpected hook account layout/, 'the hook program must precede it');
  f.sdkBlockOverride = [{ pubkey: key(), isSigner: false, isWritable: true }, ...good.slice(1)]; await assert.rejects(trade(), /unexpected hook account layout/, 'the config PDA must open the block');
  f.sdkBlockOverride = good.slice(1); await assert.rejects(trade(), /unexpected hook account layout/, 'a shorter block (the chain list has fewer entries than the plan) misaligns the markers');
  f.sdkBlockOverride = []; await assert.rejects(trade(), /unexpected hook account layout/, 'no hook accounts at all');
  f.sdkBlockOverride = null;
  f.swapOverride = () => ({ instructions: [f.ix('other', SYSTEM, [])] }); await assert.rejects(trade(), /unexpected hook account layout/, 'no DBC instruction');
  f.swapOverride = () => { const one = f.ix('swap', METEORA_DBC_PROGRAM_ID, [...f.sdkBlock()]); return { instructions: [one, { ...one }] }; }; await assert.rejects(trade(), /unexpected hook account layout/, 'two DBC instructions');
  f.swapOverride = () => ({ instructions: [f.ix('swap', METEORA_DBC_PROGRAM_ID, [...f.sdkBlock()])] }); await assert.rejects(trade(), /unexpected hook account layout/, 'the block alone is not a swap (nothing precedes it)');
  f.swapOverride = null; assert.equal((await trade()).instructions.length, 3, 'the untampered transaction passes');
  // Launchpad's own resolution is checked against the record too: a module that resolves a different config PDA cannot patch anything.
  f.adapter.hooks = { ...f.hooks, hookRemainingAccounts: args => [{ pubkey: key(), isWritable: true }, ...f.hooks.hookRemainingAccounts(args).slice(1)] }; await assert.rejects(trade(), /resolution does not match the saved launch/);
});

test('RegisterWallet (payer = trader) is prepended only for a buy on a vesting coin whose expected receipt qualifies and whose trader has no WalletState yet', async () => {
  const f = tradeFixture(); f.launch.hook = await hookRecord(f.adapter, f.launch, RULES); f.launch.status = 'trading';
  const buy = (quote, side = 'buy', wallet = f.wallet) => { f.quote = { outputAmount: String(quote), minimumAmountOut: String(BigInt(quote) - 1n) }; return f.adapter.prepareTrade({ wallet, launch: f.launch, side, amountRaw: '1000', slippageBps: 100 }); };
  assert.equal(VESTING_THRESHOLD, 500_000_000_000n, 'minBuyPct 0.05% of a 1e15 base-unit supply');
  const qualifying = await buy(VESTING_THRESHOLD);
  assert.deepEqual(qualifying.instructions.map(ix => ix.name), ['registerWallet', 'wrapSol', 'swap2WithTransferHook', 'unwrapSol'], 'RegisterWallet comes first');
  const register = qualifying.instructions[0].args; assert.equal(str(register.wallet), f.wallet); assert.equal(str(register.payer), f.wallet, 'the trader pays the record’s rent'); assert.equal(str(register.mint), f.launch.mint); assert.equal(str(register.programId), PROGRAM);
  assert.equal(qualifying.review.transferHook.registersWallet, true); assert.equal(qualifying.review.transferHook.route, 'curve');
  assert.deepEqual(tail(dbcIx(qualifying), 5).slice(1, 3).map(k => k[0]), [pda(PROGRAM, ['wallet', f.launch.mint, POOL_AUTHORITY]).address, pda(PROGRAM, ['wallet', f.launch.mint, f.wallet]).address], 'the swap carries the two WalletState PDAs (source owner, destination owner)');
  const small = await buy(VESTING_THRESHOLD - 1n); assert.deepEqual(small.instructions.map(ix => ix.name), ['wrapSol', 'swap2WithTransferHook', 'unwrapSol'], 'a receipt under the minimum qualifying share needs no record'); assert.equal(small.review.transferHook.registersWallet, false);
  const sell = await buy(VESTING_THRESHOLD * 4n, 'sell'); assert.deepEqual(sell.instructions.map(ix => ix.name), ['wrapSol', 'swap2WithTransferHook', 'unwrapSol'], 'a sell never registers'); assert.equal(f.hooks.calls.some(c => c.name === 'registerWallet' && c.args !== register), false);
  // The record exists: no RegisterWallet.
  f.connection.set(f.hooks.walletStatePda(new PublicKey(PROGRAM), new PublicKey(f.launch.mint), new PublicKey(f.wallet)).address, { owner: new PublicKey(PROGRAM), data: Buffer.alloc(50), lamports: 1 });
  const registered = await buy(VESTING_THRESHOLD * 2n); assert.deepEqual(registered.instructions.map(ix => ix.name), ['wrapSol', 'swap2WithTransferHook', 'unwrapSol']); assert.equal(registered.review.transferHook.registersWallet, false);
  // Rules without per-wallet state never register anything, whatever the size.
  const stateless = tradeFixture(); stateless.launch.hook = await hookRecord(stateless.adapter, stateless.launch, { rules: [{ id: 'anti_dump', settings: { maxSellPct: 0.25 } }] }); stateless.quote = { outputAmount: String(SUPPLY / 10n), minimumAmountOut: '1' };
  assert.deepEqual((await stateless.adapter.prepareTrade({ wallet: stateless.wallet, launch: stateless.launch, side: 'buy', amountRaw: '5', slippageBps: 50 })).instructions.map(ix => ix.name), ['wrapSol', 'swap2WithTransferHook', 'unwrapSol']);
});

test('tithe: a System transfer trader → recipient of the rule’s lamports is prepended to every buy and sell a trader builds, never to the creator’s', async () => {
  const f = tradeFixture(); const recipient = generateWallet().address, trader = generateWallet().address; f.launch.hook = await hookRecord(f.adapter, f.launch, { rules: [{ id: 'tithe', settings: { donationSol: 0.005 } }, 'venue_locked'], titheRecipient: recipient }); f.launch.status = 'trading';
  const trade = (wallet, side) => f.adapter.prepareTrade({ wallet, launch: f.launch, side, amountRaw: '1000', slippageBps: 100 });
  const buy = await trade(trader, 'buy'); assert.deepEqual(buy.instructions.map(ix => ix.name), ['systemTransfer', 'wrapSol', 'swap2WithTransferHook', 'unwrapSol']);
  assert.deepEqual(buy.instructions[0].args, { from: trader, to: recipient, lamports: '5000000' }, '0.005 SOL = 5,000,000 lamports, the catalogue’s p0'); assert.equal(buy.instructions[0].args.lamports, hookRuleParams('tithe', { donationSol: 0.005 })[0]);
  assert.deepEqual(buy.review.transferHook, { program: PROGRAM, route: 'curve', registersWallet: false, titheLamports: '5000000' });
  const sell = await trade(trader, 'sell'); assert.equal(sell.instructions[0].name, 'systemTransfer'); assert.deepEqual(sell.instructions[0].args, { from: trader, to: recipient, lamports: '5000000' });
  assert.deepEqual(tail(dbcIx(buy), 4).map(k => k[0]), [f.launch.hook.configPda, SYSVAR_INSTRUCTIONS, PROGRAM, f.launch.hook.extraMetasPda], 'the instructions sysvar rides in the hook block (a literal entry)');
  const creator = await trade(f.wallet, 'buy'); assert.deepEqual(creator.instructions.map(ix => ix.name), ['wrapSol', 'swap2WithTransferHook', 'unwrapSol'], 'the creator is exempt: no donation'); assert.equal(creator.review.transferHook.titheLamports, '5000000', 'the rule is still reported');
  await assert.rejects(f.adapter.prepareTrade({ wallet: trader, launch: { ...f.launch, hook: { ...f.launch.hook, titheRecipient: null } }, side: 'buy', amountRaw: '1', slippageBps: 1 }), /tithe recipient is missing/);
  // Vesting + tithe together: RegisterWallet, then the donation, then the swap.
  const both = tradeFixture(); both.launch.hook = await hookRecord(both.adapter, both.launch, { rules: [{ id: 'tithe', settings: {} }, { id: 'holder_vesting', settings: { minBuyPct: 0.05 } }], titheRecipient: recipient }); both.quote = { outputAmount: String(VESTING_THRESHOLD), minimumAmountOut: '1' };
  assert.deepEqual((await both.adapter.prepareTrade({ wallet: trader, launch: both.launch, side: 'buy', amountRaw: '1000', slippageBps: 100 })).instructions.map(ix => ix.name), ['registerWallet', 'systemTransfer', 'wrapSol', 'swap2WithTransferHook', 'unwrapSol']);
});

test('hooked fee claims are built from the program’s claim…TradingFee2 methods with the plain claim’s accounts, Token-2022 as the base program, the hook block (vault → receiver) as remaining accounts, and the quote paid into the receiver’s own token account', async () => {
  const f = tradeFixture(); f.launch.hook = await hookRecord(f.adapter, f.launch, RULES); f.launch.creatorRecipient = f.wallet;
  const quoteVault = key(); f.adapter.rawState = async () => ({ pool: { isMigrated: 0, quoteReserve: { lt: () => true }, baseVault: f.baseVault, quoteVault, creatorQuoteFee: '10', partnerQuoteFee: '7' }, virtual: {}, config: {}, address: f.pool, slot: 5 });
  const creator = await f.adapter.prepareCreatorClaim({ wallet: f.wallet, launch: f.launch, receiver: f.wallet });
  const call = f.sdk.find(c => c.name === 'claimCreatorTradingFee2'); assert.ok(call, 'the TransferHookPool claim instruction'); assert.equal(f.sdk.some(c => c.name === 'claimCreatorTradingFee'), false, 'the VirtualPool-only claim is never used for a hooked coin');
  // args: maxBaseAmount 0 (quote only), maxQuoteAmount u64 max, one TransferHookBase slice of the block's length (Anchor enum form).
  if (/^\d+$/.test(String(call.args[0]))) assert.equal(String(call.args[0]), '0'); assert.notEqual(call.args[1], undefined); const block = f.curveBlock(POOL_AUTHORITY, f.wallet); assert.deepEqual(call.args[2], { slices: [{ accountsType: { transferHookBase: {} }, length: block.length }] });
  const quoteAta = f.adapter.associatedToken(SOL, f.wallet, TOKEN_PROGRAM), baseAta = f.adapter.associatedToken(f.launch.mint, f.wallet, TOKEN_2022);
  assert.equal(str(call.accounts.creator), f.launch.creatorAuthority); assert.equal(str(call.accounts.pool), f.pool.toBase58()); assert.equal(str(call.accounts.tokenAAccount), str(baseAta)); assert.equal(str(call.accounts.tokenBAccount), str(quoteAta), 'the quote lands in the receiver’s quote token account, as a plain claim’s does'); assert.equal(str(call.accounts.baseVault), str(f.baseVault)); assert.equal(str(call.accounts.quoteVault), str(quoteVault)); assert.equal(str(call.accounts.baseMint), f.launch.mint); assert.equal(str(call.accounts.quoteMint), SOL); assert.equal(call.accounts.tokenBaseProgram, f.adapter.baseProgram(f.launch), 'the hooked mint’s token program (Token-2022) is the base program'); assert.notEqual(call.accounts.tokenBaseProgram, call.accounts.tokenQuoteProgram); assert.equal(str(call.accounts.tokenQuoteProgram), TOKEN_PROGRAM); assert.notEqual(call.accounts.poolAuthority, undefined, 'the DBC pool authority (the SDK derivation, stubbed here)'); assert.equal('config' in call.accounts, false);
  assert.deepEqual(call.remaining.map(m => [str(m.pubkey), m.isWritable, m.isSigner]), block, 'the claim moves base tokens vault → receiver: source owner pool authority, destination owner the receiver');
  assert.equal(creator.action, 'creator-claim'); assert.equal(creator.feeRole, 'creator'); assert.equal(creator.receiverQuoteAta, str(quoteAta)); assert.equal(creator.instructions.length, 3, 'two idempotent ATA creations, then the claim');
  assert.deepEqual(tail(dbcIx(creator), block.length), block);
  // Partner claims use claimTradingFee2 with the config and the partner authority as fee claimer and receiver.
  await f.adapter.preparePartnerClaim({ wallet: f.authority, launch: f.launch, receiver: f.authority });
  const partner = f.sdk.find(c => c.name === 'claimTradingFee2'); assert.ok(partner); assert.equal(str(partner.accounts.feeClaimer), f.authority); assert.equal(str(partner.accounts.config), f.launch.configAddress); assert.equal(str(partner.accounts.tokenBAccount), str(f.adapter.associatedToken(SOL, f.authority, TOKEN_PROGRAM))); assert.deepEqual(partner.remaining.map(m => str(m.pubkey)), f.curveBlock(POOL_AUTHORITY, f.authority).map(m => m[0]));
  // Once Meteora's curve-completing swap revoked the hook, the claim carries no hook accounts and an empty slice list.
  const done = tradeFixture(); done.launch.hook = await hookRecord(done.adapter, done.launch, RULES); done.launch.creatorRecipient = done.wallet; done.adapter.readHookedMint = async () => ({ transferHookProgram: null });
  done.adapter.rawState = async () => ({ pool: { isMigrated: 0, quoteReserve: { lt: () => true }, baseVault: done.baseVault, quoteVault: key(), creatorQuoteFee: '10', partnerQuoteFee: '0' }, virtual: {}, config: {}, address: done.pool, slot: 5 });
  await done.adapter.prepareCreatorClaim({ wallet: done.wallet, launch: done.launch, receiver: done.wallet }); const revoked = done.sdk.find(c => c.name === 'claimCreatorTradingFee2'); assert.deepEqual(revoked.args[2], { slices: [] }); assert.deepEqual(revoked.remaining, []); assert.equal(done.hooks.calls.some(c => c.name === 'hookRemainingAccounts'), false);
});

test('allowlist changes: AddAllowed/RemoveAllowed by the creator only, at most 20 per transaction, refused in words when the chain already disagrees', async () => {
  const f = chainFixture(); f.launch.hook = await hookRecord(f.adapter, f.launch, { rules: ['allowlist'] }); f.launch.status = 'trading';
  const [a, b, c] = wallets(3), programId = new PublicKey(PROGRAM), mint = new PublicKey(f.launch.mint);
  f.connection.set(f.hooks.allowEntryPda(programId, mint, new PublicKey(c)).address, { owner: programId, data: Buffer.alloc(2), lamports: 1 });
  const bundle = await f.adapter.prepareHookAllowlist({ wallet: f.wallet, launch: f.launch, add: [a, b], remove: [c] });
  assert.equal(bundle.action, 'hook-allow'); assert.deepEqual(bundle.instructions.map(ix => [ix.name, str(ix.args.wallet)]), [['addAllowed', a], ['addAllowed', b], ['removeAllowed', c]]);
  for (const ix of bundle.instructions) { assert.equal(str(ix.args.creator), f.wallet); assert.equal(str(ix.args.payer || ix.args.refundTo), f.wallet); assert.equal(str(ix.args.mint), f.launch.mint); }
  assert.deepEqual(bundle.review.add, [a, b]); assert.deepEqual(bundle.review.remove, [c]); assert.deepEqual(bundle.hookAllowlist, { add: [a, b], remove: [c] }); assert.equal(f.sdk.length, 0, 'no SDK call: the hook program alone');
  await assert.rejects(f.adapter.prepareHookAllowlist({ wallet: f.wallet, launch: f.launch, add: [c], remove: [] }), new RegExp(`${c} is already on the allowlist`));
  await assert.rejects(f.adapter.prepareHookAllowlist({ wallet: f.wallet, launch: f.launch, add: [], remove: [a] }), new RegExp(`${a} is not on the allowlist`));
  await assert.rejects(f.adapter.prepareHookAllowlist({ wallet: generateWallet().address, launch: f.launch, add: [a], remove: [] }), /creator wallet/);
  await assert.rejects(f.adapter.prepareHookAllowlist({ wallet: f.wallet, launch: f.launch, add: wallets(21), remove: [] }), /between 1 and 20/);
  await assert.rejects(f.adapter.prepareHookAllowlist({ wallet: f.wallet, launch: f.launch, add: [], remove: [] }), /between 1 and 20/);
  const plain = chainFixture(); plain.launch.hook = await hookRecord(plain.adapter, plain.launch, RULES);
  await assert.rejects(plain.adapter.prepareHookAllowlist({ wallet: plain.wallet, launch: plain.launch, add: [a], remove: [] }), /no allowlist rule/);
  // The authoritative list: the program's AllowEntry accounts for this mint, decoded and sorted; foreign or malformed rows are skipped.
  const entry = (mintKey, wallet) => { const data = Buffer.alloc(66); data[0] = 1; new PublicKey(mintKey).toBuffer().copy(data, 2); new PublicKey(wallet).toBuffer().copy(data, 34); return { pubkey: key(), account: { owner: programId, data } }; };
  let filters = null; f.connection.getProgramAccounts = async (program, options) => { filters = { program: str(program), ...options }; return [entry(f.launch.mint, b), entry(f.launch.mint, a), entry(generateWallet().address, c), { pubkey: key(), account: { owner: programId, data: Buffer.alloc(3) } }]; };
  assert.deepEqual(await f.adapter.hookAllowlistOnChain(f.launch), [a, b].sort());
  assert.equal(filters.program, PROGRAM); assert.deepEqual(filters.filters, [{ dataSize: 66 }, { memcmp: { offset: 2, bytes: f.launch.mint } }]);
  await assert.rejects(plain.adapter.hookAllowlistOnChain({ ...plain.launch, hook: null }), /no transfer hook rules/);
});

test('a simulation refused by the hook program is said in plain words (6000 + kind → the catalogue’s rule); DBC and token errors keep the generic message', async () => {
  const f = chainFixture(); f.launch.hook = await hookRecord(f.adapter, f.launch, RULES);
  const err = { InstructionError: [2, { Custom: 6004 }] }, logs = ['Program ComputeBudget111111111111111111111111111111 success', `Program ${PROGRAM} invoke [2]`, `Program ${PROGRAM} failed: custom program error: 0x1774`, `Program ${TOKEN_2022} failed: custom program error: 0x1774`];
  const message = await f.adapter.simulationFailureMessage(f.launch, { err, logs });
  assert.match(message, /^This transfer breaks the coin’s rule: Anti-dump caps\. One sell may move at most the allowed share of the supply\. No transaction was submitted\.$/);
  assert.deepEqual(f.hooks.calls.find(c => c.name === 'hookErrorMessage').args, { programId: PROGRAM }, 'the encoder is told which program is ours');
  // Without the encoder's sentence the HOOK_ERRORS table speaks, then the catalogue's own rule text.
  f.adapter.hooks = { ...f.hooks, hookErrorMessage: () => null }; assert.match(await f.adapter.simulationFailureMessage(f.launch, { err, logs }), /Anti-dump caps\. The sell moves more of the supply than the rule allows\./);
  f.adapter.hooks = { ...f.hooks, hookErrorMessage: undefined, HOOK_ERRORS: {} }; assert.match(await f.adapter.simulationFailureMessage(f.launch, { err, logs }), /Anti-dump caps\. The hook tells buys from sells/);
  f.adapter.hooks = { ...f.hooks, hookErrorMessage: () => { throw Error('encoder bug'); } }; assert.match(await f.adapter.simulationFailureMessage(f.launch, { err, logs }), /Anti-dump caps\./, 'an encoder failure never hides the refusal');
  // A code of a rule this coin does not carry still maps through the catalogue (6025 = tithe, kind 25); a structural code keeps the table's name.
  f.adapter.hooks = { ...f.hooks, hookErrorMessage: () => null, HOOK_ERRORS: {} }; assert.match(await f.adapter.simulationFailureMessage(f.launch, { err: { InstructionError: [2, { Custom: 6025 }] }, logs: [`Program ${PROGRAM} failed: custom program error: 0x1789`] }), /rule: Tithe\. A pool trade is allowed only if/);
  f.adapter.hooks = { ...f.hooks, hookErrorMessage: () => null }; assert.match(await f.adapter.simulationFailureMessage(f.launch, { err: { InstructionError: [2, { Custom: 6100 }] }, logs: [`Program ${PROGRAM} failed: custom program error: 0x17d4`] }), /rule: WalletNotRegistered\. The wallet has no record yet\./);
  const dbc = await f.adapter.simulationFailureMessage(f.launch, { err, logs: [`Program ${METEORA_DBC_PROGRAM_ID.toBase58()} failed: custom program error: 0x1774`] });
  assert.match(dbc, /^Meteora simulation failed: .*6004.*No transaction was submitted\.$/);
  assert.match(await f.adapter.simulationFailureMessage({ ...f.launch, hook: null }, { err, logs }), /^Meteora simulation failed/, 'a plain coin never reads hook errors');
  assert.match(await f.adapter.simulationFailureMessage(f.launch, { err }), /^Meteora simulation failed/, 'no logs, no attribution');
});

test('adapter readiness reports the hook program without blocking ordinary launches; hook-setup receipts prove the accounts and the blocklist count', async () => {
  const f = chainFixture(); f.connection.fallback = { executable: true }; f.adapter.migrationCheck = async () => ({ supported: true }); f.connection.getBalance = async () => 120_000_000;
  const ready = await f.adapter.readiness({ authority: f.authority, treasury: f.launch.treasury, hookProgramId: PROGRAM });
  assert.equal(ready.ready, true); assert.deepEqual(ready.hookProgram, { programId: PROGRAM, executable: true });
  f.connection.set(PROGRAM, { executable: false }); const undeployed = await f.adapter.readiness({ authority: f.authority, treasury: f.launch.treasury, hookProgramId: PROGRAM });
  assert.equal(undeployed.ready, true, 'an undeployed hook program is reported, never a blocker'); assert.equal(undeployed.hookProgram.executable, false);
  assert.equal((await f.adapter.readiness({ authority: f.authority, treasury: f.launch.treasury })).hookProgram, null);
  // hookSetupState at a receipt slot: both PDAs owned by the program, the config naming this mint and creator (any v≥1 version byte).
  f.launch.hook = await hookRecord(f.adapter, f.launch, RULES); f.connection.fallback = null;
  assert.equal((await f.adapter.hookSetupState(f.launch, 'finalized', 10)).exists, false);
  f.connection.set(f.launch.hook.configPda, configAccount(f.launch)).set(f.launch.hook.extraMetasPda, metasAccount());
  assert.deepEqual((({ ready, exists, blocklist }) => ({ ready, exists, blocklist }))(await f.adapter.hookSetupState(f.launch, 'finalized', 10)), { ready: true, exists: true, blocklist: null });
  f.connection.set(f.launch.hook.configPda, configAccount(f.launch, { version: 0 })); await assert.rejects(f.adapter.hookSetupState(f.launch), /does not belong/);
  f.connection.set(f.launch.hook.configPda, configAccount(f.launch, { mint: generateWallet().address })); await assert.rejects(f.adapter.hookSetupState(f.launch), /does not belong/);
  // reconcile of a hook-setup receipt: the accounts (and, for a chunk, the count) must be on chain at the receipt's slot; the result carries the step and swapBaseAmount.
  const blocked = chainFixture(); const list = wallets(30); blocked.launch.hook = await hookRecord(blocked.adapter, blocked.launch, { rules: ['blocklist'], blocklist: list });
  Object.assign(blocked.connection, { getSignatureStatuses: async () => ({ value: [{ confirmationStatus: 'finalized', err: null }] }), _rpcRequest: async () => ({ result: { meta: { err: null }, transaction: ['wire', 'base64'] } }), getParsedTransaction: async () => ({ slot: 77, meta: { err: null }, transaction: { message: { accountKeys: [], instructions: [] } } }) });
  const op = step => ({ signature: 'sig', signedTransaction: 'wire', wallet: blocked.wallet, bundle: { action: 'configure', hookSetup: true, hookSetupStep: step, transferHook: { program: PROGRAM, swapBaseAmount: step.kind === 'setup' ? '793100000000000' : undefined }, blockhash: { lastValidBlockHeight: 1 } } });
  await assert.rejects(blocked.adapter.reconcile(op({ kind: 'setup', step: 1, steps: 2, blocklistCountAfter: 8 }), blocked.launch), /transfer hook accounts were not found/);
  blocked.connection.set(blocked.launch.hook.configPda, configAccount(blocked.launch)).set(blocked.launch.hook.extraMetasPda, metasAccount());
  await assert.rejects(blocked.adapter.reconcile(op({ kind: 'setup', step: 1, steps: 2, blocklistCountAfter: 8 }), blocked.launch), /blocklist wallets were not found/);
  blocked.connection.set(blocked.launch.hook.blocklistPda, blocklistAccount(list.slice(0, 8)));
  assert.deepEqual((await blocked.adapter.reconcile(op({ kind: 'setup', step: 1, steps: 2, blocklistCountAfter: 8 }), blocked.launch)).hookSetup, { kind: 'setup', step: 1, steps: 2, blocklistCount: 8, complete: false, swapBaseAmount: '793100000000000' });
  blocked.connection.set(blocked.launch.hook.blocklistPda, blocklistAccount(list));
  assert.deepEqual((await blocked.adapter.reconcile(op({ kind: 'blocklist', step: 2, steps: 2, blocklistCountAfter: 30 }), blocked.launch)).hookSetup, { kind: 'blocklist', step: 2, steps: 2, blocklistCount: 30, complete: true });
});

// ---- Service: launch, allowlist action, receipts, views, status.
async function serviceFixture(t, { hookProgramId = PROGRAM, gate = null, hookApps = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'meteora-hooks-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = Date.UTC(2026, 9, 4, 12), receipt = { state: 'pending' }, signatures = 0;
  const authority = generateWallet(), treasury = generateWallet().address, user = generateWallet().address, docs = new Map(), calls = [];
  docs.set('meteora-launches', { schemaVersion: 1, enabled: true, config: { authority: authority.address, treasury, migrationFeePercentage: 0 }, authority: { address: authority.address, secretBase64: 'x' }, launches: [], operations: [], cursor: 0 });
  const accounts = { dir, get: async id => ({ id, role: 'admin', mfaEnabled: true }), list: async () => [], hostStore: { read: async (key, fallback) => docs.has(key) ? structuredClone(docs.get(key)) : structuredClone(fallback), write: async (key, value) => { docs.set(key, structuredClone(value)); } } };
  const unsigned = (wallet, action, extra = {}) => ({ action, unsignedTransaction: 'AA==', lastValidBlockHeight: 100, requiredSigners: [wallet], review: {}, ...extra });
  const FIRST = 8;
  const adapter = {
    readiness: async args => ({ ready: true, blockers: [], hookProgram: args.hookProgramId ? { programId: args.hookProgramId, executable: adapter.executable } : null }), executable: true,
    hookAddresses: async ({ mint, program, quoteMint, configAddress }) => { calls.push(['hookAddresses', { mint, program, quoteMint, configAddress }]); return { program, configPda: pda(program, ['config', mint]).address, extraMetasPda: pda(program, ['extra-account-metas', mint]).address, blocklistPda: pda(program, ['block', mint]).address, poolAuthority: POOL_AUTHORITY, dammPoolAuthority: DAMM_POOL_AUTHORITY, dbcPool: pda(program, ['pool', mint]).address, baseVault: pda(program, ['vault', mint]).address }; },
    hookGateMint: async mint => { calls.push(['hookGateMint', mint]); if (gate instanceof Error) throw gate; return gate && gate.mint === mint ? { ...gate } : null; },
    // The stage the real adapter would choose from chain state, mirrored from the record: configure → hook-setup (step 1, then blocklist chunks) → initialize.
    prepareLaunch: async ({ wallet, launch }) => {
      calls.push(['prepareLaunch', structuredClone(launch)]);
      const hook = launch.hook, total = hook?.needsBlocklist ? hook.blocklist.length : 0, first = Math.min(FIRST, total), steps = 1 + Math.ceil(Math.max(0, total - first) / 28);
      let stage = 'initialize', extra = {};
      if (!launch.configSignature) stage = 'configure';
      else if (hook && !hook.setupSignature) { stage = 'hook-setup'; extra = { hookSetup: true, hookSetupStep: { kind: 'setup', step: 1, steps, wallets: (hook.blocklist || []).slice(0, first), blocklistCountAfter: first }, transferHook: { program: hook.program, configPda: hook.configPda, extraMetasPda: hook.extraMetasPda, blocklistPda: hook.blocklistPda, swapBaseAmount: '793100000000000' } }; }
      else if (hook && total && (hook.blocklistCount || 0) < total) { const count = hook.blocklistCount || 0, chunk = hook.blocklist.slice(count, count + 28); stage = 'hook-setup'; extra = { hookSetup: true, hookSetupStep: { kind: 'blocklist', step: 2 + Math.ceil((count - first) / 28), steps, wallets: chunk, blocklistCountAfter: count + chunk.length }, transferHook: { program: hook.program } }; }
      return unsigned(wallet, stage === 'initialize' ? 'initialize' : 'configure', { review: { stage, stages: hook ? 3 : 2, ...(stage === 'hook-setup' ? { step: `${extra.hookSetupStep.step}/${steps}` } : {}) }, ...extra });
    },
    prepareTrade: async ({ wallet, side, launch }) => { calls.push(['prepareTrade', side, !!launch.hook]); return unsigned(wallet, side); },
    prepareHookAllowlist: async ({ wallet, launch, add, remove }) => { calls.push(['prepareHookAllowlist', { mint: launch.mint, add, remove }]); return unsigned(wallet, 'hook-allow', { review: { add, remove }, hookAllowlist: { add, remove } }); },
    prepareCreatorClaim: async ({ wallet }) => unsigned(wallet, 'creator-claim'), preparePartnerClaim: async ({ wallet }) => unsigned(wallet, 'partner-claim'), prepareMigration: async ({ wallet }) => unsigned(wallet, 'migrate'), preparePayout: async ({ wallet }) => unsigned(wallet, 'payout'), holderSnapshot: async () => ({ complete: true, slot: 1, rows: [] }),
    state: async () => ({ phase: 'trading', creatorFeesPending: '0', partnerFeesPending: '0' }), send: async () => 'sig', reconcile: async () => structuredClone(receipt), wallet: async () => ({}), marketSnapshot: async () => null,
  };
  const service = new MeteoraService({ accounts, adapter, requireOwner: async () => {}, getQuotePrice: async mint => ({ mint, usd: '100', at: clock }), getTreasury: async () => treasury, getCreationFee: async () => ({ lamports: '15000000', recipient: treasury }), publishMetadata: async () => 'https://launch.example/token-metadata/x.json', quoteEligibility: async mint => ({ mint, symbol: 'SOL', decimals: 9, launchReady: true }), listPairs: async () => [{ mint: SOL, launchReady: true }], pairReadiness: async () => ({ complete: true }), hookProgramId, hookApps, now: () => clock, verifyWalletTransaction: () => ({ message: { serialize: () => Buffer.from('signed') } }) });
  service.closed = true;
  // Transaction encoding, wallet proofs and the network are outside this test (see meteora-vanity.test.mjs).
  Object.assign(service, { validateBundle: () => ({ message: { serialize: () => Buffer.from('message') } }), verifyWalletChange: async () => {}, sign: () => ({ signedTransaction: 'c2lnbmVk', signature: String(++signatures).padStart(88, '1') }), broadcast: async op => ({ operation: { id: op.id } }) });
  const session = { account: { id: 'alice' }, walletVerified: true, walletAddress: user }, context = { sessionToken: 'alice-session', authorize: async () => session };
  const input = { action: 'initialize', expectedWallet: user, quoteMint: SOL, name: 'Hooked coin', symbol: 'HOOK', feeMode: 'creator' };
  const read = () => docs.get('meteora-launches');
  const f = { service, adapter, session, context, input, user, authority: authority.address, treasury, calls, read, advance: ms => { clock += ms; }, now: () => clock, receipt: value => { receipt = value; }, FIRST };
  f.signAndFinalize = async (operationId, result) => { await service.submit(session, { operationId, signedTransaction: 'c2lnbmVk' }, context); receipt = result; await service.reconcile(session, { operationId }, context); receipt = { state: 'pending' }; };
  /** The receipt the real adapter would return for a hook-setup bundle: the accounts proven, the chain's blocklist count, completeness. */
  f.setupReceipt = (op, slot) => { const step = op.bundle?.hookSetupStep || read().operations.find(o => o.id === op.id).bundle.hookSetupStep, launch = read().launches.find(l => l.mint === op.mint), total = launch.hook.needsBlocklist ? launch.hook.blocklist.length : 0; return { state: 'finalized', slot, hookSetup: { kind: step.kind, step: step.step, steps: step.steps, blocklistCount: step.blocklistCountAfter, complete: step.blocklistCountAfter >= total, ...(step.kind === 'setup' ? { swapBaseAmount: '793100000000000' } : {}) } }; };
  f.launch = async (extra = {}) => {
    let prepared = await service.prepare(session, { ...input, ...extra }, context); const mint = prepared.launch.mint; let slot = 20;
    for (let guard = 0; guard < 12; guard++) {
      if (guard > 0) prepared = await service.prepare(session, { action: 'initialize', expectedWallet: user, mint }, context);
      const op = read().operations.find(o => o.id === prepared.operation.id);
      if (op.action === 'initialize') { await f.signAndFinalize(op.id, { state: 'finalized', slot: slot++, phase: 'trading', poolId: generateWallet().address, dbcPoolId: generateWallet().address }); return mint; }
      await f.signAndFinalize(op.id, op.bundle.hookSetup ? f.setupReceipt(op, slot++) : { state: 'finalized', slot: slot++ });
    }
    throw Error('the launch never reached the pool stage');
  };
  return f;
}
const HOOK_INPUT = { rules: [{ id: 'anti_dump', settings: { maxBuyPct: 2, maxSellPct: 0.25 } }, { id: 'holder_vesting', settings: { cliffHours: 24, unlockPct: 10, periodHours: 24, minBuyPct: 0.05 } }] };

test('a hooked launch stores the v2 plan, program, PDAs, exemptions and venue, and takes three approvals in order; the setup receipt records swapBaseAmount', async t => {
  const f = await serviceFixture(t);
  const prepared = await f.service.prepare(f.session, { ...f.input, hook: HOOK_INPUT }, f.context), saved = f.read().launches[0];
  assert.equal(prepared.operation.action, 'configure'); assert.equal(prepared.operation.review.stage, 'configure'); assert.equal(prepared.operation.review.stages, 3);
  assert.deepEqual(saved.hook.rules, [{ id: 'anti_dump', kind: 4, settings: { maxBuyPct: 2, maxSellPct: 0.25 } }, { id: 'holder_vesting', kind: 3, settings: { earlyHours: 0, cliffHours: 24, unlockPct: 10, periodHours: 24, minBuyPct: 0.05 } }], 'the catalogue’s normalized settings (defaults filled in) are frozen');
  assert.equal(saved.hook.version, 2); assert.equal(saved.hook.program, PROGRAM); assert.equal(saved.hook.configPda, pda(PROGRAM, ['config', saved.mint]).address); assert.equal(saved.hook.extraMetasPda, pda(PROGRAM, ['extra-account-metas', saved.mint]).address); assert.equal(saved.hook.blocklistPda, null, 'no blocklist rule, no BlockList PDA');
  assert.deepEqual(saved.hook.exempt, [f.user, f.authority, f.authority, DAMM_POOL_AUTHORITY], 'creator wallet, partner authority, leftover receiver, DAMM v2 pool authority');
  assert.equal(saved.hook.venue, pda(PROGRAM, ['vault', saved.mint]).address); assert.deepEqual([saved.hook.route, saved.hook.needsWalletState, saved.hook.needsGlobalState, saved.hook.needsSysvar, saved.hook.needsBlocklist], ['curve', true, false, false, false]); assert.equal(saved.hook.gateMint, null); assert.equal(saved.hook.titheRecipient, null); assert.deepEqual(saved.hook.blocklist, []);
  assert.deepEqual([saved.hook.tokenType, saved.hook.createdWithHook, saved.hook.allowlist, saved.hook.gateDecimals, saved.hook.gateTokenProgram, 'walletStateSeed' in saved.hook, 'mintAuthority' in saved.hook], ['token2022', true, [], 0, null, false, false]);
  assert.equal(saved.firstBuyRaw, '0'); assert.equal(saved.feeMode, 'creator');
  assert.equal(f.calls.find(c => c[0] === 'hookAddresses')[1].program, PROGRAM); assert.deepEqual(f.calls.find(c => c[0] === 'prepareLaunch')[1].hook, saved.hook, 'the adapter receives the frozen record');
  assert.deepEqual(prepared.operation.review.hook, { rules: [{ id: 'anti_dump', name: 'Anti-dump caps', text: describeHookRule('anti_dump', HOOK_INPUT.rules[0].settings) }, { id: 'holder_vesting', name: 'Holder vesting', text: describeHookRule('holder_vesting', HOOK_INPUT.rules[1].settings) }], route: 'curve', gateMint: null, titheRecipient: null, blocklistCount: 0, program: PROGRAM });
  // Stage 1 finalizes → configured; stage 2 is the hook setup (a configure-kind approval, step 1/1); stage 3 creates the pool.
  await f.signAndFinalize(prepared.operation.id, { state: 'finalized', slot: 20 });
  assert.equal(f.read().launches[0].status, 'configured'); assert.equal(f.read().launches[0].configSignature, '1'.padStart(88, '1'));
  const setup = await f.service.prepare(f.session, { action: 'initialize', expectedWallet: f.user, mint: saved.mint }, f.context);
  assert.equal(setup.operation.action, 'configure'); assert.equal(setup.operation.review.stage, 'hook-setup'); assert.equal(setup.operation.review.step, '1/1');
  await f.signAndFinalize(setup.operation.id, f.setupReceipt(f.read().operations.find(o => o.id === setup.operation.id), 21));
  const afterSetup = f.read().launches[0]; assert.equal(afterSetup.hook.setupSignature, '2'.padStart(88, '1')); assert.equal(afterSetup.hook.setupSlot, 21); assert.equal(afterSetup.hook.swapBaseAmount, '793100000000000', 'the curve’s swapBaseAmount, read from the PoolConfig at setup, is recorded'); assert.equal(afterSetup.hook.setupComplete, true); assert.equal(afterSetup.hook.blocklistCount, 0); assert.equal(afterSetup.configSignature, '1'.padStart(88, '1'), 'the curve configuration signature is not overwritten'); assert.equal(afterSetup.status, 'configured');
  const pool = await f.service.prepare(f.session, { action: 'initialize', expectedWallet: f.user, mint: saved.mint }, f.context);
  assert.equal(pool.operation.action, 'initialize'); assert.equal(pool.operation.review.stage, 'initialize');
  await f.signAndFinalize(pool.operation.id, { state: 'finalized', slot: 22, phase: 'trading', poolId: generateWallet().address });
  const live = f.read().launches[0]; assert.equal(live.status, 'trading'); assert.ok(live.finalizedAt); assert.equal('mintAuthority' in live.hook, false, 'no mint-authority bookkeeping: the supply is fixed at creation');
  assert.deepEqual(f.calls.filter(c => c[0] === 'prepareLaunch').map(c => c[1].hook?.setupSignature ? 'setup done' : c[1].configSignature ? 'configured' : 'draft'), ['draft', 'configured', 'setup done']);
  // Hooks combine with holder rewards and Gotchi fee modes; the plan is frozen on the record and cannot be changed when resuming.
  await assert.rejects(f.service.prepare(f.session, { action: 'initialize', expectedWallet: f.user, mint: saved.mint, hook: HOOK_INPUT }, f.context), /cannot be resumed|cannot change afterwards/);
  const holders = await f.service.prepare(f.session, { ...f.input, feeMode: 'holders', hook: { rules: ['venue_locked'] } }, f.context); assert.equal(f.read().launches.at(-1).hook.rules[0].kind, 12); assert.equal(f.read().launches.at(-1).hook.route, 'any'); assert.equal(holders.launch.feeMode, 'holders');
});

test('a blocklist launch writes its wallets over several hook-setup approvals (step k/n), each recorded from its finalized receipt, before the pool is created', async t => {
  const f = await serviceFixture(t); const list = wallets(45), recipient = generateWallet().address;
  const prepared = await f.service.prepare(f.session, { ...f.input, hook: { rules: ['blocklist', { id: 'tithe', settings: { donationSol: 0.01 } }], blocklist: list, titheRecipient: recipient } }, f.context), mint = prepared.launch.mint, saved = () => f.read().launches.find(l => l.mint === mint);
  assert.deepEqual(saved().hook.blocklist, list); assert.equal(saved().hook.needsBlocklist, true); assert.equal(saved().hook.needsSysvar, true); assert.equal(saved().hook.titheRecipient, recipient); assert.equal(saved().hook.route, 'curve'); assert.equal(saved().hook.blocklistPda, pda(PROGRAM, ['block', mint]).address);
  assert.deepEqual(prepared.operation.review.hook.blocklistCount, 45); assert.equal(prepared.operation.review.hook.titheRecipient, recipient);
  await f.signAndFinalize(prepared.operation.id, { state: 'finalized', slot: 20 });
  const steps = []; let pool = null;
  for (let i = 0; i < 4; i++) {
    const next = await f.service.prepare(f.session, { action: 'initialize', expectedWallet: f.user, mint }, f.context);
    if (next.operation.action === 'initialize') { pool = next; break; }
    assert.equal(next.operation.review.stage, 'hook-setup'); steps.push(next.operation.review.step);
    const op = f.read().operations.find(o => o.id === next.operation.id); assert.equal(op.bundle.hookSetup, true);
    await f.signAndFinalize(next.operation.id, f.setupReceipt(op, 21 + i));
  }
  assert.deepEqual(steps, ['1/3', '2/3', '3/3'], '8 wallets with the setup, then 28, then 9');
  const record = saved().hook; assert.equal(record.setupSignature, '2'.padStart(88, '1')); assert.equal(record.swapBaseAmount, '793100000000000'); assert.equal(record.blocklistCount, 45); assert.equal(record.setupComplete, true);
  assert.deepEqual(record.blocklistSignatures.map(s => [s.step, s.wallets, s.slot]), [[2, 28, 22], [3, 9, 23]]); assert.match(record.blocklistSignatures[0].signature, /^1+3$/);
  assert.equal(pool.operation.action, 'initialize', 'the pool stage follows the last chunk'); assert.equal(pool.operation.review.stage, 'initialize');
  await f.signAndFinalize(pool.operation.id, { state: 'finalized', slot: 30, phase: 'trading', poolId: generateWallet().address }); assert.equal(saved().status, 'trading');
  // The public blocklist read: the recorded plan, or the chain when a reader answers (cached, falling back to the record).
  let listed = await f.service.hookBlocklist(mint); assert.deepEqual(listed, { mint, hooked: true, hasBlocklist: true, program: PROGRAM, blocklistPda: record.blocklistPda, active: true, ended: false, wallets: list, count: 45, source: 'curve', recorded: list, note: listed.note }); assert.match(listed.note, /sealed by the first trade/);
  let reads = 0; f.adapter.hookBlocklistOnChain = async launch => { reads++; assert.equal(launch.mint, mint); return list.slice(0, 45); };
  listed = await f.service.hookBlocklist(mint); assert.equal(listed.source, 'chain'); assert.equal(listed.count, 45); await f.service.hookBlocklist(mint); assert.equal(reads, 1, 'cached'); f.advance(15001); await f.service.hookBlocklist(mint); assert.equal(reads, 2);
  f.adapter.hookBlocklistOnChain = async () => { throw Error('RPC down'); }; f.advance(15001); const fallback = await f.service.hookBlocklist(mint); assert.equal(fallback.source, 'curve'); assert.deepEqual(fallback.wallets, list);
  await assert.rejects(f.service.hookBlocklist(generateWallet().address), error => error.statusCode === 404); await assert.rejects(f.service.hookBlocklist('nope'), /Invalid Solana address/);
  const plain = await f.launch(); const none = await f.service.hookBlocklist(plain); assert.deepEqual([none.hooked, none.hasBlocklist, none.wallets, none.count, none.source], [false, false, [], 0, 'none']);
  const other = await f.launch({ hook: HOOK_INPUT }); const noRule = await f.service.hookBlocklist(other); assert.deepEqual([noRule.hooked, noRule.hasBlocklist, noRule.wallets, noRule.source], [true, false, [], 'curve']);
  // The view carries the count and the tithe recipient, never the list itself.
  const view = await f.service.publicDetail(mint); assert.equal(view.hook.blocklistCount, 45); assert.equal(view.hook.titheRecipient, recipient); assert.equal(view.hook.blocklist, undefined); assert.equal(view.hook.hasBlocklist, true);
});

test('hook refusals: feature off (503), AI Agent coins, a first buy, hooks outside a launch, unknown hook keys, catalogue errors, a changed program or an old record on resume, the removed freeze action', async t => {
  const off = await serviceFixture(t, { hookProgramId: null });
  await assert.rejects(off.service.prepare(off.session, { ...off.input, hook: HOOK_INPUT }, off.context), error => error.statusCode === 503 && error.message === 'Transfer hook rules are not enabled on this host.');
  assert.equal(off.read().launches.length, 0); assert.equal(off.calls.some(c => c[0] === 'prepareLaunch'), false);
  const plain = await off.service.prepare(off.session, { ...off.input, hook: { rules: [] } }, off.context); assert.equal(plain.launch.hook, null, 'no rules chosen = an ordinary launch even when hooks are off');
  const status = await off.service.publicStatus(); assert.equal(status.hooksEnabled, false); assert.equal(status.hookProgramId, null); assert.equal(status.hookProgramExecutable, null);
  const f = await serviceFixture(t);
  await assert.rejects(f.service.prepare(f.session, { ...f.input, feeMode: 'agent', hook: { rules: ['venue_locked'] } }, f.context), error => error.statusCode === 400 && /AI Agent launches cannot carry transfer hook rules: the agent’s treasury wallet trades through the pool/.test(error.message));
  await assert.rejects(f.service.prepare(f.session, { ...f.input, amountRaw: '1000000', hook: HOOK_INPUT }, f.context), /A hooked coin’s first buy is a separate trade after launch\./);
  await assert.rejects(f.service.prepare(f.session, { ...f.input, hook: 'yes' }, f.context), /Describe the transfer hook rules/);
  await assert.rejects(f.service.prepare(f.session, { ...f.input, hook: { rules: ['anti_dump', 'sliding_caps'] } }, f.context), /cannot be combined with/);
  await assert.rejects(f.service.prepare(f.session, { ...f.input, hook: { rules: ['allowlist'], extra: 1 } }, f.context), /Unsupported Meteora input/, 'unknown keys inside `hook` are refused, not ignored');
  await assert.rejects(f.service.prepare(f.session, { ...f.input, hook: { rules: ['blocklist'] } }, f.context), /Blocklist: enter at least one wallet/);
  await assert.rejects(f.service.prepare(f.session, { ...f.input, hook: { rules: ['venue_locked'], blocklist: wallets(2) } }, f.context), /blocklist requires the Blocklist rule/);
  await assert.rejects(f.service.prepare(f.session, { ...f.input, hook: { rules: ['tithe'] } }, f.context), /Tithe: enter the recipient/);
  await assert.rejects(f.service.prepare(f.session, { ...f.input, hook: { rules: ['venue_locked'], titheRecipient: generateWallet().address } }, f.context), /tithe recipient requires the Tithe rule/);
  await assert.rejects(f.service.prepare(f.session, { ...f.input, hook: { rules: [{ id: 'anti_dump', settings: { maxSellPct: 25 } }] } }, f.context), /Max per sell must be between/);
  assert.equal(f.read().launches.length, 0); assert.equal(f.calls.some(c => c[0] === 'prepareLaunch'), false, 'nothing reached the adapter');
  const mint = await f.launch();
  await assert.rejects(f.service.prepare(f.session, { action: 'buy', expectedWallet: f.user, mint, amountRaw: '5', hook: HOOK_INPUT }, f.context), /chosen when a coin is launched/);
  await assert.rejects(f.service.prepare(f.session, { ...f.input, hookRules: [] }, f.context), /Unsupported Meteora input/);
  await assert.rejects(f.service.prepare(f.session, { action: 'hook-freeze-mint', expectedWallet: f.user, mint }, f.context), /Choose a launch, buy, sell, creator fee claim or allowlist change/, 'the Freeze-supply action no longer exists: the mint authority is revoked at creation');
  // A hooked draft created for another program, or by an earlier rules format, cannot be resumed on this host.
  const draft = await f.service.prepare(f.session, { ...f.input, hook: HOOK_INPUT }, f.context); await f.service.cancel(f.session, { operationId: draft.operation.id }, f.context);
  f.service.hookProgramId = generateWallet().address;
  await assert.rejects(f.service.prepare(f.session, { action: 'initialize', expectedWallet: f.user, mint: draft.launch.mint }, f.context), /different transfer hook program/);
  f.service.hookProgramId = null; await assert.rejects(f.service.prepare(f.session, { action: 'initialize', expectedWallet: f.user, mint: draft.launch.mint }, f.context), /different transfer hook program/);
  f.service.hookProgramId = PROGRAM; f.read().launches.find(l => l.mint === draft.launch.mint).hook.version = 1;
  await assert.rejects(f.service.prepare(f.session, { action: 'initialize', expectedWallet: f.user, mint: draft.launch.mint }, f.context), error => error.statusCode === 409 && /earlier version of the transfer hook rules/.test(error.message));
});

test('app-only launches (v71.36): offered per app whose mark is named in LAUNCHPAD_HOOK_FOMO_MARK / LAUNCHPAD_HOOK_PUMP_APP_MARK (public status hookApps), the mark frozen on the record, 503 in words when the app is not named, buys and sells refused with the trade box’s sentence until graduation, the views carrying the app and its mark', async t => {
  // The settings: unset is off; signer:<wallet>, program:<id> and program:<id>:account:<slot> are kept as { kind, key, index }; anything else is refused with the setting named; never a built-in default.
  const fomo = generateWallet().address, trader = generateWallet().address, router = generateWallet().address;
  assert.equal(meteoraHookAppMark(undefined), null); assert.equal(meteoraHookAppMark(' '), null);
  assert.deepEqual(meteoraHookAppMark(' signer:' + fomo + ' '), { kind: 'signer', key: fomo, index: 0 });
  assert.deepEqual(meteoraHookAppMark('program:' + router), { kind: 'program', key: router, index: 0 });
  assert.deepEqual(meteoraHookAppMark('program:' + router + ':account:5'), { kind: 'program-account', key: router, index: 5 });
  assert.deepEqual(meteoraHookAppMark({ kind: 'program-account', key: router, index: 5 }), { kind: 'program-account', key: router, index: 5 }, 'an already parsed mark is accepted');
  for (const bad of ['nope', fomo, 'signer:nope', 'wallet:' + fomo, 'program:' + router + ':account:64', 'program:' + router + ':slot:5', 'signer:' + fomo + ':account:1']) assert.throws(() => meteoraHookAppMark(bad, 'LAUNCHPAD_HOOK_PUMP_APP_MARK'), /LAUNCHPAD_HOOK_PUMP_APP_MARK must be program:<program id>, signer:<wallet>, or program:<program id>:account:<slot>\./, bad);
  assert.throws(() => meteoraHookAppMark('signer:' + '1'.repeat(44), 'LAUNCHPAD_HOOK_FOMO_MARK'), /LAUNCHPAD_HOOK_FOMO_MARK: 1{44} is not a base58 Solana address/, 'the key must be on the curve');
  assert.throws(() => meteoraHookAppMark({ kind: 'program-account', key: fomo, index: 70 }), /must be program:<program id>, signer:<wallet>/);
  assert.deepEqual(meteoraHookApps(null), { fomo: null, pumpApp: null }); assert.deepEqual(meteoraHookApps({ fomo: 'signer:' + fomo }), { fomo: { kind: 'signer', key: fomo, index: 0 }, pumpApp: null }); assert.deepEqual(HOOK_APP_SETTINGS, { fomo: 'LAUNCHPAD_HOOK_FOMO_MARK', pumpApp: 'LAUNCHPAD_HOOK_PUMP_APP_MARK' });
  assert.equal(describeHookAppMark({ kind: 'signer', key: fomo, index: 0 }, 'FOMO'), `FOMO: the wallet ${fomo.slice(0, 4)}…${fomo.slice(-4)} must sign the trade (FOMO’s co-signer).`);
  assert.equal(describeHookAppMark({ kind: 'program-account', key: router, index: 5 }, 'Pump App'), `Pump App: a top-level instruction of program ${router.slice(0, 4)}…${router.slice(-4)} with its account 6 filled (a commission or referral slot) must be in the trade.`);
  // Nothing named: both rules are refused at the service with the setting to set; nothing reached the adapter or the store.
  const off = await serviceFixture(t);
  assert.deepEqual((await off.service.publicStatus()).hookApps, { fomo: null, pumpApp: null });
  await assert.rejects(off.service.prepare(off.session, { ...off.input, hook: { rules: ['fomo_only'] } }, off.context), error => error.statusCode === 503 && error.message === 'FOMO-only is not enabled on this host: the owner has not named the FOMO app’s mark (LAUNCHPAD_HOOK_FOMO_MARK).');
  await assert.rejects(off.service.prepare(off.session, { ...off.input, hook: { rules: ['pump_app_only'] } }, off.context), error => error.statusCode === 503 && /Pump App-only is not enabled on this host.*LAUNCHPAD_HOOK_PUMP_APP_MARK/.test(error.message));
  assert.equal(off.read().launches.length, 0); assert.equal(off.calls.some(c => c[0] === 'prepareLaunch'), false);
  // FOMO named: the status says so per app (the mark and its sentence), a FOMO-only launch freezes the mark with the rule, a Pump App-only one is still refused.
  const fomoMark = { kind: 'signer', key: fomo, index: 0 }, fomoView = { ...fomoMark, text: describeHookAppMark(fomoMark, 'FOMO') };
  const f = await serviceFixture(t, { hookApps: { fomo: 'signer:' + fomo } });
  assert.deepEqual((await f.service.publicStatus()).hookApps, { fomo: fomoView, pumpApp: null }); assert.deepEqual((await f.service.ownerStatus(f.session, f.context)).hookApps, { fomo: fomoView, pumpApp: null });
  await assert.rejects(f.service.prepare(f.session, { ...f.input, hook: { rules: ['pump_app_only'] } }, f.context), error => error.statusCode === 503);
  await assert.rejects(f.service.prepare(f.session, { ...f.input, hook: { rules: ['fomo_only', 'allowlist'] } }, f.context), /cannot be combined with/);
  await assert.rejects(f.service.prepare(f.session, { ...f.input, hook: { rules: ['fomo_only', 'pump_app_only'] } }, f.context), /cannot be combined with/);
  const prepared = await f.service.prepare(f.session, { ...f.input, hook: { rules: [{ id: 'max_per_wallet', settings: { maxPct: 2 } }, 'fomo_only'] } }, f.context), saved = f.read().launches[0];
  assert.equal(prepared.operation.review.stages, 3); assert.deepEqual([saved.hook.route, saved.hook.app, saved.hook.appName, saved.hook.appMark, saved.hook.needsSysvar], ['app', 'fomo', 'FOMO', fomoMark, true]);
  assert.equal('appProgram' in saved.hook, false, 'v71.35’s program id is gone from the record');
  assert.deepEqual(saved.hook.rules.map(r => [r.id, r.kind]), [['max_per_wallet', 7], ['fomo_only', 26]]);
  assert.deepEqual(prepared.operation.review.hook, { rules: [{ id: 'max_per_wallet', name: 'Max per wallet', text: 'No wallet can hold more than 2% of the supply.' }, { id: 'fomo_only', name: 'FOMO-only', text: describeHookRule('fomo_only') }], route: 'app', app: 'fomo', appName: 'FOMO', appMark: fomoMark, gateMint: null, titheRecipient: null, blocklistCount: 0, program: PROGRAM });
  await f.service.cancel(f.session, { operationId: prepared.operation.id }, f.context);
  // The frozen mark outlives the setting: resuming after the owner changes or removes the app keeps the coin's own mark; a record that lost it cannot be resumed.
  f.service.hookApps = meteoraHookApps({ fomo: 'program:' + router + ':account:5' });
  const resumed = await f.service.prepare(f.session, { action: 'initialize', expectedWallet: f.user, mint: saved.mint }, f.context); assert.deepEqual(f.calls.at(-1)[1].hook.appMark, fomoMark, 'the adapter builds from the frozen mark'); await f.service.cancel(f.session, { operationId: resumed.operation.id }, f.context);
  f.service.hookApps = meteoraHookApps(null);
  const again = await f.service.prepare(f.session, { action: 'initialize', expectedWallet: f.user, mint: saved.mint }, f.context); assert.deepEqual(f.calls.at(-1)[1].hook.appMark, fomoMark); await f.service.cancel(f.session, { operationId: again.operation.id }, f.context);
  f.read().launches.find(l => l.mint === saved.mint).hook.appMark = null;
  await assert.rejects(f.service.prepare(f.session, { action: 'initialize', expectedWallet: f.user, mint: saved.mint }, f.context), error => error.statusCode === 409 && /no app mark recorded/.test(error.message));
  f.read().launches.find(l => l.mint === saved.mint).hook.appMark = fomoMark; f.service.hookApps = meteoraHookApps({ fomo: 'signer:' + fomo });
  // The mark's key cannot be the hook program itself.
  f.service.hookApps = meteoraHookApps({ fomo: 'program:' + PROGRAM }); await assert.rejects(f.service.prepare(f.session, { ...f.input, hook: { rules: ['fomo_only'] } }, f.context), /cannot be the hook program itself/); f.service.hookApps = meteoraHookApps({ fomo: 'signer:' + fomo });
  // A Pump App-only launch with a program+account mark freezes the slot with it.
  const both = await serviceFixture(t, { hookApps: { fomo: 'signer:' + fomo, pumpApp: 'program:' + router + ':account:5' } }), pumpMark = { kind: 'program-account', key: router, index: 5 };
  assert.deepEqual((await both.service.publicStatus()).hookApps, { fomo: fomoView, pumpApp: { ...pumpMark, text: describeHookAppMark(pumpMark, 'Pump App') } });
  const pumpPrepared = await both.service.prepare(both.session, { ...both.input, hook: { rules: ['pump_app_only'] } }, both.context); assert.deepEqual(both.read().launches[0].hook.appMark, pumpMark); assert.deepEqual(pumpPrepared.operation.review.hook.appMark, pumpMark); await both.service.cancel(both.session, { operationId: pumpPrepared.operation.id }, both.context);
  // A live App-only coin: buys and sells are refused with the trade box's sentence before the adapter is asked; the views carry the app, the mark, the lock and the sentence.
  const mint = await f.launch({ hook: { rules: ['fomo_only'] } }), before = f.calls.length;
  const traderSession = { account: { id: 'trader' }, walletVerified: true, walletAddress: trader }, traderContext = { sessionToken: 'trader-session', authorize: async () => traderSession };
  for (const side of ['buy', 'sell']) await assert.rejects(f.service.prepare(traderSession, { action: side, expectedWallet: trader, mint, amountRaw: '1000' }, traderContext), error => error.statusCode === 409 && error.message === hookAppTradeNote('FOMO'));
  await assert.rejects(f.service.prepare(f.session, { action: 'buy', expectedWallet: f.user, mint, amountRaw: '1000' }, f.context), /Launchpad’s Buy and Sell are off for this coin/, 'the creator too: Launchpad never builds the trade');
  assert.equal(f.calls.slice(before).some(c => c[0] === 'prepareTrade'), false);
  const row = await f.service.publicDetail(mint);
  assert.deepEqual([row.hook.route, row.hook.routeName, row.hook.app, row.hook.appName, row.hook.appMark, row.hook.appMarkText, row.hook.curveTrading, row.hook.tradeNote, row.hook.active, row.hook.ended], ['app', 'App only', 'fomo', 'FOMO', fomoMark, describeHookAppMark(fomoMark, 'FOMO'), false, hookAppTradeNote('FOMO'), true, false]);
  assert.equal(row.hook.routeText, HOOK_ROUTES.app.text); assert.deepEqual(row.hook.rules, [{ id: 'fomo_only', name: 'FOMO-only', text: describeHookRule('fomo_only') }]);
  const record = meteoraDiscoveryRecord(row, f.now()); assert.deepEqual([record.coin.hook.route, record.coin.hook.app, record.coin.hook.appName, record.coin.hook.curveTrading], ['app', 'fomo', 'FOMO', false]); assert.equal('appMark' in record.coin.hook, false, 'explore rows carry the app’s name, not its mark');
  // Graduation ends the rule: the lock lifts, trades go to the adapter again.
  const launch = f.read().launches.find(l => l.mint === mint); launch.status = 'migrated'; launch.poolId = generateWallet().address; launch.migratedAt = f.now();
  const done = await f.service.publicDetail(mint); assert.deepEqual([done.hook.route, done.hook.appName, done.hook.curveTrading, done.hook.tradeNote, done.hook.ended], ['app', 'FOMO', true, null, true]);
  assert.equal(meteoraDiscoveryRecord(done, f.now()).coin.hook.curveTrading, true);
  const trade = await f.service.prepare(traderSession, { action: 'buy', expectedWallet: trader, mint, amountRaw: '1000' }, traderContext); assert.equal(trade.operation.action, 'buy'); assert.deepEqual(f.calls.at(-1), ['prepareTrade', 'buy', true]);
  // Plain and Launchpad-route coins are untouched: curveTrading true, no sentence.
  const plain = await f.service.publicDetail(await f.launch({ hook: HOOK_INPUT })); assert.equal(plain.hook.curveTrading, true); assert.equal(plain.hook.tradeNote, null); assert.equal(plain.hook.app, null); assert.equal(plain.hook.appName, '');
});

test('holder-gated launches read the gate mint from chain through the adapter and freeze its decimals and token program', async t => {
  const gateMint = generateWallet().address;
  const f = await serviceFixture(t, { gate: { mint: gateMint, program: TOKEN_2022, decimals: 6 } });
  const prepared = await f.service.prepare(f.session, { ...f.input, hook: { rules: [{ id: 'holder_gated', settings: { minAmount: 2.5 } }], gateMint } }, f.context), saved = f.read().launches[0];
  assert.equal(saved.hook.gateMint, gateMint); assert.equal(saved.hook.gateDecimals, 6); assert.equal(saved.hook.gateTokenProgram, TOKEN_2022); assert.deepEqual(f.calls.find(c => c[0] === 'hookGateMint'), ['hookGateMint', gateMint]); assert.equal(saved.hook.route, 'curve');
  assert.deepEqual(hookRuleParams('holder_gated', saved.hook.rules[0].settings, { gateDecimals: saved.hook.gateDecimals }), ['2500000', '6', '0', '0', '0', '0']);
  assert.equal(prepared.launch.hook.gateMint, gateMint);
  const missing = await serviceFixture(t, { gate: null });
  await assert.rejects(missing.service.prepare(missing.session, { ...missing.input, hook: { rules: ['holder_gated'], gateMint } }, missing.context), error => error.statusCode === 400 && /gate token mint was not found on chain/.test(error.message));
  const notMint = await serviceFixture(t, { gate: Object.assign(Error('The gate token is not an SPL or Token-2022 mint.'), { statusCode: 409 }) });
  await assert.rejects(notMint.service.prepare(notMint.session, { ...notMint.input, hook: { rules: ['holder_gated'], gateMint } }, notMint.context), error => error.statusCode === 400 && /Holder-gated: The gate token is not an SPL or Token-2022 mint/.test(error.message));
  await assert.rejects(f.service.prepare(f.session, { ...f.input, hook: { rules: ['anti_dump'], gateMint } }, f.context), /gate token requires the Holder-gated rule/);
});

test('hook-allow: creator-only allowlist changes of at most 20 base58 wallets, recorded on the launch when the signed transaction finalizes, read back as { wallets }', async t => {
  const f = await serviceFixture(t), mint = await f.launch({ hook: { rules: ['allowlist', { id: 'max_per_wallet', settings: { maxPct: 2 } }] } });
  const list = wallets(21), [a, b, c] = list, allow = extra => f.service.prepare(f.session, { action: 'hook-allow', expectedWallet: f.user, mint, ...extra }, f.context);
  await assert.rejects(allow({ add: list, remove: [] }), /List at most 20 wallets/);
  await assert.rejects(allow({ add: list.slice(0, 15), remove: list.slice(15) }), /at most 20 wallets per transaction/);
  await assert.rejects(allow({ add: [a, a] }), /listed twice/); await assert.rejects(allow({ add: [a], remove: [a] }), /listed twice/);
  await assert.rejects(allow({ add: ['not-a-wallet'] }), /Invalid Solana address/); await assert.rejects(allow({ add: 'abc' }), /List at most/);
  await assert.rejects(allow({}), /Add or remove at least one wallet/); await assert.rejects(allow({ add: [a], amountRaw: '1' }), /names the coin and the wallets/);
  await assert.rejects(allow({ add: [a], wallets: [a] }), /Unsupported Meteora input/);
  await assert.rejects(f.service.prepare(f.session, { action: 'buy', expectedWallet: f.user, mint, amountRaw: '5', add: [a] }, f.context), /use the hook-allow action/);
  const bob = { account: { id: 'bob' }, walletVerified: true, walletAddress: generateWallet().address }, bobContext = { sessionToken: 'bob-session', authorize: async () => bob };
  await assert.rejects(f.service.prepare(bob, { action: 'hook-allow', expectedWallet: bob.walletAddress, mint, add: [a] }, bobContext), error => error.statusCode === 403 && /Only this coin’s creator/.test(error.message));
  assert.equal(f.calls.some(call => call[0] === 'prepareHookAllowlist'), false, 'nothing invalid reached the adapter');
  // A valid change: the unsigned transaction comes from the adapter; the list changes only when the signed transaction finalizes.
  const prepared = await allow({ add: [a, b], remove: [] });
  assert.equal(prepared.operation.action, 'hook-allow'); assert.equal(prepared.operation.state, 'awaiting_signature'); assert.deepEqual(prepared.operation.review.add, [a, b]); assert.equal(prepared.operation.transaction, 'AA==');
  assert.deepEqual(f.calls.find(call => call[0] === 'prepareHookAllowlist')[1], { mint, add: [a, b], remove: [] }); assert.deepEqual(f.read().operations.at(-1).hookAllowlist, { add: [a, b], remove: [] });
  assert.deepEqual((await f.service.hookAllowlist(mint)).wallets, [], 'unsigned = unchanged');
  await assert.rejects(allow({ add: [c] }), /Check your saved transaction/);
  await f.signAndFinalize(prepared.operation.id, { state: 'finalized', slot: 30, hookAllowlist: { add: [a, b], remove: [] } });
  const saved = f.read().launches[0]; assert.deepEqual(saved.hook.allowlist, [a, b]); assert.equal(saved.hook.allowlistUpdatedAt, f.now()); assert.equal(saved.hook.allowlistChanges.length, 1); assert.deepEqual(saved.hook.allowlistChanges[0].add, [a, b]); assert.equal(saved.hook.allowlistChanges[0].slot, 30);
  const second = await allow({ add: [c], remove: [a] }); await f.signAndFinalize(second.operation.id, { state: 'finalized', slot: 31, hookAllowlist: { add: [c], remove: [a] } });
  assert.deepEqual(f.read().launches[0].hook.allowlist, [b, c]);
  const listed = await f.service.hookAllowlist(mint);
  assert.deepEqual(listed.wallets, [b, c]); assert.equal(listed.count, 2); assert.equal(listed.hasAllowlist, true); assert.equal(listed.hooked, true); assert.equal(listed.active, true); assert.equal(listed.ended, false); assert.equal(listed.program, PROGRAM); assert.equal(listed.source, 'curve', 'without a chain reader the recorded list is served and labelled'); assert.deepEqual(listed.recorded, [b, c]); assert.match(listed.note, /chain is authoritative/);
  await assert.rejects(f.service.hookAllowlist(generateWallet().address), error => error.statusCode === 404); await assert.rejects(f.service.hookAllowlist('nope'), /Invalid Solana address/);
  // With a chain reader the chain wins (an entry another app added shows up); its answer is cached briefly and a receipt clears the cache; an RPC failure falls back to the recorded list.
  const external = generateWallet().address; let reads = 0; f.adapter.hookAllowlistOnChain = async launch => { reads++; assert.equal(launch.mint, mint); return [b, c, external].sort(); };
  const chain = await f.service.hookAllowlist(mint); assert.equal(chain.source, 'chain'); assert.deepEqual(chain.wallets, [b, c, external].sort()); assert.equal(chain.count, 3); assert.deepEqual(chain.recorded, [b, c]);
  await f.service.hookAllowlist(mint); assert.equal(reads, 1, 'cached'); f.advance(15001); await f.service.hookAllowlist(mint); assert.equal(reads, 2);
  f.adapter.hookAllowlistOnChain = async () => { throw Error('RPC down'); }; f.advance(15001);
  const fallback = await f.service.hookAllowlist(mint); assert.equal(fallback.source, 'curve'); assert.deepEqual(fallback.wallets, [b, c]);
  f.adapter.hookAllowlistOnChain = async () => [external]; assert.equal((await f.service.hookAllowlist(mint)).source, 'chain');
  const third = await allow({ add: [a] }); await f.signAndFinalize(third.operation.id, { state: 'finalized', slot: 32, hookAllowlist: { add: [a], remove: [] } });
  f.adapter.hookAllowlistOnChain = async () => [a, b, c, external].sort(); assert.deepEqual((await f.service.hookAllowlist(mint)).wallets, [a, b, c, external].sort(), 'a finalized change clears the cache'); assert.deepEqual(f.read().launches[0].hook.allowlist.sort(), [a, b, c].sort());
  delete f.adapter.hookAllowlistOnChain; f.service.allowlistCache.clear();
  // A failed transaction changes nothing; a coin without the Allowlist rule, or one that graduated, has no allowlist to change.
  const d = generateWallet().address, failed = await allow({ add: [d] }); await f.signAndFinalize(failed.operation.id, { state: 'failed' }); assert.deepEqual(f.read().launches[0].hook.allowlist.sort(), [a, b, c].sort());
  const other = await f.launch({ hook: HOOK_INPUT });
  await assert.rejects(f.service.prepare(f.session, { action: 'hook-allow', expectedWallet: f.user, mint: other, add: [d] }, f.context), error => error.statusCode === 409 && /no allowlist rule/.test(error.message));
  const plainMint = await f.launch(); await assert.rejects(f.service.prepare(f.session, { action: 'hook-allow', expectedWallet: f.user, mint: plainMint, add: [d] }, f.context), /no transfer hook rules/);
  f.read().launches[0].status = 'migrated'; await assert.rejects(allow({ add: [d] }), /graduated/);
});

test('views: coin rows carry hook { rules [{ id, name, text }], route, routeText, gateMint, blocklistCount, titheRecipient, active, ended } and nothing about a mint authority; explore keeps the public subset; My Tokens adds the recorded allowlist', async t => {
  const f = await serviceFixture(t), gateMint = generateWallet().address; f.adapter.hookGateMint = async mint => ({ mint, program: TOKEN_PROGRAM, decimals: 9 });
  const mint = await f.launch({ hook: { rules: [{ id: 'holder_gated', settings: { minAmount: 3 } }, { id: 'market_hours', settings: { afterHours: 1 } }], gateMint } }), plain = await f.launch();
  const row = await f.service.publicDetail(mint), expectedRules = [{ id: 'holder_gated', name: 'Holder-gated', text: 'Receiving wallets must hold at least 3 of the gate token.' }, { id: 'market_hours', name: 'Market hours', text: describeHookRule('market_hours', { afterHours: 1 }) }];
  assert.deepEqual(row.hook.rules, expectedRules); assert.equal(row.hook.gateMint, gateMint); assert.equal(row.hook.active, true); assert.equal(row.hook.ended, false); assert.equal(row.hook.hasAllowlist, false); assert.deepEqual(row.hook.allowlist, []); assert.equal(row.hook.program, PROGRAM);
  assert.equal(row.hook.route, 'curve'); assert.equal(row.hook.routeText, HOOK_ROUTES.curve.text); assert.equal(row.hook.routeName, 'Launchpad route only'); assert.equal(row.hook.blocklistCount, 0); assert.equal(row.hook.titheRecipient, null); assert.equal(row.hook.version, 2);
  for (const gone of ['supplyFrozen', 'mintAuthority', 'mintAuthorityHolder', 'mintAuthorityRevokedAt', 'configPda', 'exempt', 'blocklist']) assert.equal(gone in row.hook, false, `${gone} is not in a public row`); assert.doesNotMatch(JSON.stringify(row), /secretBase64/);
  assert.equal((await f.service.publicDetail(plain)).hook, null);
  const record = meteoraDiscoveryRecord(row, f.now()), pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));
  assert.deepEqual(pick(record.coin.hook, ['rules', 'gateMint', 'active', 'ended']), { rules: expectedRules, gateMint, active: true, ended: false }, 'explore rows carry the public shape'); assert.equal(record.coin.hook.supplyFrozen === undefined || record.coin.hook.supplyFrozen === null, true, 'nothing about a mint authority reaches explore');
  assert.equal(meteoraDiscoveryRecord(await f.service.publicDetail(plain), f.now()).coin.hook, null);
  assert.deepEqual((await f.service.publicList()).map(l => l.mint === mint ? l.hook.rules.length : l.hook), [2, null]);
  const mine = await f.service.listAccount(f.session); assert.deepEqual(mine.map(l => l.hook?.rules.map(r => r.id) ?? null), [['holder_gated', 'market_hours'], null]); assert.deepEqual(mine[0].hook.allowlist, []);
  // An 'any'-route coin says so; graduation ends every rule.
  const any = await f.launch({ hook: { rules: [{ id: 'anti_dump', settings: {} }, 'dex_only'] } }); const anyRow = await f.service.publicDetail(any); assert.equal(anyRow.hook.route, 'any'); assert.equal(anyRow.hook.routeText, HOOK_ROUTES.any.text); assert.equal(anyRow.hook.routeName, 'Trades anywhere');
  f.read().launches[0].status = 'migrated'; f.read().launches[0].poolId = generateWallet().address; f.read().launches[0].migratedAt = f.now();
  const graduated = await f.service.publicDetail(mint); assert.equal(graduated.hook.active, false); assert.equal(graduated.hook.ended, true);
  assert.deepEqual(pick(meteoraDiscoveryRecord(graduated, f.now()).coin.hook, ['active', 'ended']), { active: false, ended: true });
});

test('public status exposes hooksEnabled, hookProgramId and the program’s executable flag from adapter readiness; a hooked coin trades through the adapter with its record', async t => {
  const f = await serviceFixture(t);
  let status = await f.service.publicStatus(); assert.equal(status.hooksEnabled, true); assert.equal(status.hookProgramId, PROGRAM); assert.equal(status.hookProgramExecutable, true); assert.equal(status.available, true);
  f.adapter.executable = false; f.advance(6000); status = await f.service.publicStatus(); assert.equal(status.hooksEnabled, false, 'an undeployed program hides the rules'); assert.equal(status.hookProgramExecutable, false); assert.equal(status.available, true, 'ordinary launches stay open');
  f.adapter.executable = null; f.advance(6000); status = await f.service.publicStatus(); assert.equal(status.hooksEnabled, true, 'an unanswered RPC read keeps the section; each hooked transaction re-checks the program'); assert.equal(status.hookProgramExecutable, null);
  const owner = await f.service.ownerStatus(f.session, f.context); assert.equal(owner.hookProgramId, PROGRAM); assert.deepEqual(owner.hookProgram, { programId: PROGRAM, executable: null });
  f.advance(6000); const readiness = await f.service.readiness(f.read()); assert.equal(readiness.hookProgram.programId, PROGRAM);
  // After launch the first buy is an ordinary trade through the adapter, which carries the frozen record.
  const mint = await f.launch({ hook: HOOK_INPUT }); const buy = await f.service.prepare(f.session, { action: 'buy', expectedWallet: f.user, mint, amountRaw: '1000' }, f.context);
  assert.equal(buy.operation.action, 'buy'); assert.deepEqual(f.calls.at(-1), ['prepareTrade', 'buy', true]); assert.equal(HOOK_LIMITS.allowlistBatch, 20); assert.equal(HOOK_LIMITS.blocklistBatch, 28);
});

test('against the real encoder (src/hooks/program.mjs): PDAs, instruction tags and account blocks of the setup, blocklist chunks, trades and claims come from agent A’s module unchanged', async t => {
  const hooks = await import('../src/hooks/program.mjs');
  if (typeof hooks.hookRemainingAccounts !== 'function' || typeof hooks.addBlocked !== 'function' || typeof hooks.decodeBlocklist !== 'function') { t.skip('src/hooks/program.mjs is not the v2 encoder yet'); return; }
  const f = chainFixture(), list = wallets(30), recipient = generateWallet().address, trader = generateWallet().address; f.adapter.hooks = hooks; f.adapter.config = async () => ({ exists: true });
  f.launch.hook = await hookRecord(f.adapter, f.launch, { rules: [{ id: 'holder_vesting', settings: { minBuyPct: 0.05 } }, 'blocklist', { id: 'tithe', settings: { donationSol: 0.002 } }], blocklist: list, titheRecipient: recipient });
  const programId = new PublicKey(PROGRAM), mint = new PublicKey(f.launch.mint);
  assert.equal(f.launch.hook.configPda, hooks.hookConfigPda(programId, mint).address); assert.equal(f.launch.hook.extraMetasPda, hooks.extraMetasPda(programId, mint).address); assert.equal(f.launch.hook.blocklistPda, hooks.blocklistPda(programId, mint).address);
  assert.deepEqual(hookShapeOf(f.launch.hook.rules), { ...hooks.hookShape(f.launch.hook.rules) }, 'the adapter’s fallback shape agrees with the encoder'); assert.equal(hooks.extraMetasSize(f.launch.hook.rules), 16 + 35 * 5);
  // Hook-setup step 1: InitConfig (tag 1, 494 bytes) + InitializeExtraAccountMetaList (tag 0) + AddBlocked (tag 5, the 8 wallets that fit).
  const setup = await f.adapter.prepareLaunch({ wallet: f.wallet, launch: f.launch });
  assert.deepEqual(setup.instructions.map(ix => [ix.data[0], ix.data.length]), [[1, 494], [0, 1], [5, 2 + 32 * 8]]); assert.equal(setup.review.step, '1/2');
  const [init, metas, blocked] = setup.instructions;
  assert.equal(str(init.keys[0].pubkey), f.launch.hook.configPda); assert.equal(str(init.keys[2].pubkey), f.wallet); assert.ok(init.keys[2].isSigner); assert.equal(str(metas.keys[0].pubkey), f.launch.hook.extraMetasPda); assert.equal(str(metas.keys[5].pubkey), f.launch.hook.configPda); assert.equal(str(blocked.keys[3].pubkey), f.launch.hook.blocklistPda);
  const payload = init.data.subarray(1), L = hooks.INIT_CONFIG_LAYOUT; assert.equal(new PublicKey(payload.subarray(L.titheRecipient, L.titheRecipient + 32)).toBase58(), recipient); assert.equal(payload.readBigUInt64LE(L.swapBaseAmount), 793100000000000n); assert.equal(payload[L.ruleCount], 3); assert.equal(payload[L.rules], 3, 'holder_vesting kind'); assert.equal(payload.readBigUInt64LE(L.rules + 1 + 4 * 8), 500n, 'p4 = 500 ppm');
  assert.deepEqual(hooks.decodeBlocklist(blocklistAccount(list.slice(0, 8)).data).wallets, list.slice(0, 8), 'the test’s BlockList bytes follow the encoder’s layout');
  for (let i = 0; i < 8; i++) assert.equal(new PublicKey(blocked.data.subarray(2 + 32 * i, 34 + 32 * i)).toBase58(), list[i]);
  // Step 2 appends the remaining 22 wallets once the chain holds 8.
  f.connection.set(f.launch.hook.configPda, configAccount(f.launch, { version: hooks.HOOK_LAYOUT_VERSION })).set(f.launch.hook.extraMetasPda, metasAccount()).set(f.launch.hook.blocklistPda, blocklistAccount(list.slice(0, 8)));
  const chunk = await f.adapter.prepareLaunch({ wallet: f.wallet, launch: f.launch }); assert.equal(chunk.review.step, '2/2'); assert.deepEqual(chunk.instructions.map(ix => [ix.data[0], ix.data[1]]), [[5, 22]]);
  f.connection.set(f.launch.hook.blocklistPda, blocklistAccount(list)); assert.equal((await f.adapter.prepareLaunch({ wallet: f.wallet, launch: f.launch })).action, 'initialize');
  assert.deepEqual(await f.adapter.hookBlocklistOnChain(f.launch), list);
  // A qualifying buy by a trader: RegisterWallet (tag 4, the trader’s WalletState), the donation, then the swap whose trailing seven keys are the encoder’s block for vault → trader.
  f.launch.status = 'trading'; f.quote = { outputAmount: String(VESTING_THRESHOLD), minimumAmountOut: '1' }; f.adapter.rawState = async () => ({ pool: { isMigrated: 0, quoteReserve: { lt: () => true }, baseVault: f.baseVault, quoteVault: key(), creatorQuoteFee: '0', partnerQuoteFee: '0' }, virtual: {}, config: { migrationQuoteThreshold: 1 }, address: f.pool, slot: 5 });
  const placeholder = hooks.hookRemainingAccounts({ programId, mint, sourceOwner: PublicKey.default, destinationOwner: PublicKey.default, rules: f.launch.hook.rules }); f.sdkBlockOverride = placeholder; assert.equal(placeholder.length, 7);
  const buy = await f.adapter.prepareTrade({ wallet: trader, launch: f.launch, side: 'buy', amountRaw: '1000', slippageBps: 100 });
  assert.deepEqual(buy.instructions.map(ix => ix.name || ix.data?.[0]), [4, 'systemTransfer', 'wrapSol', 'swap2WithTransferHook', 'unwrapSol']);
  assert.equal(str(buy.instructions[0].keys[3].pubkey), hooks.walletStatePda(programId, mint, new PublicKey(trader)).address); assert.deepEqual(buy.instructions[1].args, { from: trader, to: recipient, lamports: '2000000' });
  const expected = hooks.hookRemainingAccounts({ programId, mint, sourceOwner: f.poolAuthority, destinationOwner: new PublicKey(trader), rules: f.launch.hook.rules }).map(m => [str(m.pubkey), m.isWritable, false]);
  assert.deepEqual(tail(dbcIx(buy), 7), expected); assert.deepEqual(expected.map(k => k[0]).slice(0, 3), [f.launch.hook.configPda, SYSVAR_INSTRUCTIONS, f.launch.hook.blocklistPda]); assert.notDeepEqual(expected.map(k => k[0]), placeholder.map(m => str(m.pubkey)));
  assert.deepEqual(buy.review.transferHook, { program: PROGRAM, route: 'curve', registersWallet: true, titheLamports: '2000000' });
  // A creator claim: the block is vault → receiver, the quote stays in the receiver’s ATA.
  f.adapter.rawState = async () => ({ pool: { isMigrated: 0, quoteReserve: { lt: () => true }, baseVault: f.baseVault, quoteVault: key(), creatorQuoteFee: '10', partnerQuoteFee: '0' }, virtual: {}, config: {}, address: f.pool, slot: 5 }); f.launch.creatorRecipient = f.wallet;
  const claim = await f.adapter.prepareCreatorClaim({ wallet: f.wallet, launch: f.launch, receiver: f.wallet });
  assert.deepEqual(tail(dbcIx(claim), 7), hooks.hookRemainingAccounts({ programId, mint, sourceOwner: f.poolAuthority, destinationOwner: new PublicKey(f.wallet), rules: f.launch.hook.rules }).map(m => [str(m.pubkey), m.isWritable, false])); assert.equal(str(dbcIx(claim).keys[3].pubkey), str(f.adapter.associatedToken(SOL, f.wallet, TOKEN_PROGRAM)), 'tokenBAccount is the receiver’s quote ATA');
  // The encoder's error table speaks for a refused simulation.
  const message = await f.adapter.simulationFailureMessage(f.launch, { err: { InstructionError: [2, { Custom: 6003 }] }, logs: [`Program ${PROGRAM} failed: custom program error: 0x1773`] });
  assert.match(message, /^This transfer breaks the coin’s rule: Holder vesting\. .*No transaction was submitted\.$/); assert.equal(hooks.HOOK_ERRORS[6003].title, 'Holder vesting');
});
