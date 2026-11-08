import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import * as hooks from '../src/hooks/program.mjs';
import { HOOK_RULES, HOOK_CONFLICTS, HOOK_LIMITS, hookRuleById, hookRuleParams, normalizeHookSettings } from '../public/hook-catalog.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/hook-tlv.json', import.meta.url), 'utf8'));
const rustSource = name => readFileSync(new URL(`../contracts/curve-transfer-hook/src/${name}`, import.meta.url), 'utf8');
const errorsSource = rustSource('errors.rs'), stateSource = rustSource('state.rs'), executeSource = rustSource('execute.rs'), instructionsSource = rustSource('instructions.rs');
const k = n => new PublicKey(Buffer.alloc(32, n));
const bytes = key => Buffer.from(key.toBuffer());
const ZERO = Buffer.alloc(32);
const u64 = v => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const i64 = v => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };
const programId = k(11), mint = k(22), creator = k(33), payer = k(44), wallet = k(55), vault = k(66), partner = k(77), leftover = k(88), migrationAuthority = k(99), gateTokenProgram = k(7), gateMint = k(9), titheRecipient = k(123);
const six = (...values) => { const out = values.map(String); while (out.length < 6) out.push('0'); return out; };
// The app-only rules (v71.35) carry a host-configured program id instead of settings: a fixed test key stands in.
const APP_PROGRAM_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i + 1), APP_MARK = { kind: 'signer', keyBytes: APP_PROGRAM_BYTES, index: 0 };
const ruleOf = (id, settings = {}, extra = {}) => ({ kind: hookRuleById(id).kind, params: hookRuleParams(id, settings, { gateDecimals: 6, appMark: APP_MARK, ...extra }) });
// The sandbox's web3 stand-in derives PDAs with a plain hash and no bump; real web3 re-derives the address from seeds + bump.
const realPdaMath = (() => { try { const seeds = [Buffer.from('probe')]; const [key, bump] = PublicKey.findProgramAddressSync(seeds, programId); return PublicKey.createProgramAddressSync([...seeds, Buffer.from([bump])], programId).equals(key); } catch { return false; } })();
/** `pub const NAME: usize = N;` lines of a `pub mod <name> { ... }` block in state.rs, keyed by camelCase name (LEN → size). */
const rustOffsets = (source, module) => {
  const block = source.slice(source.indexOf(`pub mod ${module} {`));
  const body = block.slice(0, block.indexOf('\n}\n'));
  return Object.fromEntries([...body.matchAll(/pub const ([A-Z_0-9]+): usize = (\d+);/g)].map(m => [m[1] === 'LEN' ? 'size' : m[1].toLowerCase().replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase()), Number(m[2])]));
};

test('interface discriminators are the sha256 prefixes the program and the fixture use', () => {
  const sha = name => [...createHash('sha256').update(`spl-transfer-hook-interface:${name}`).digest().subarray(0, 8)];
  assert.deepEqual([...hooks.EXECUTE_DISCRIMINATOR], sha('execute'));
  assert.deepEqual([...hooks.EXECUTE_DISCRIMINATOR], [105, 37, 101, 197, 75, 251, 102, 26]);
  assert.deepEqual([...hooks.INITIALIZE_EXTRA_ACCOUNT_METAS_DISCRIMINATOR], [43, 34, 13, 49, 167, 88, 235, 235]);
  assert.deepEqual([...hooks.UPDATE_EXTRA_ACCOUNT_METAS_DISCRIMINATOR], [157, 105, 42, 146, 102, 85, 241, 174]);
  assert.deepEqual(fixture.executeDiscriminator, [...hooks.EXECUTE_DISCRIMINATOR]);
  assert.deepEqual(fixture.initializeExtraAccountMetasDiscriminator, [...hooks.INITIALIZE_EXTRA_ACCOUNT_METAS_DISCRIMINATOR]);
  assert.equal(hooks.executeData('123456789').toString('hex'), Buffer.concat([hooks.EXECUTE_DISCRIMINATOR, u64(123456789)]).toString('hex'));
  assert.throws(() => hooks.executeData('-1'), /u64/);
  assert.throws(() => hooks.executeData('18446744073709551616'), /u64/);
});

test('account sizes and offsets match the Rust layouts in state.rs and instructions.rs', () => {
  assert.equal(hooks.HOOK_PARAM_COUNT, 6);
  assert.equal(hooks.RULE_LEN, 49);
  assert.equal(hooks.MAX_RULES, 4);
  assert.equal(hooks.HOOK_CONFIG_SIZE, 752);
  assert.equal(hooks.WALLET_STATE_SIZE, 34);
  assert.equal(hooks.ALLOW_ENTRY_SIZE, 66);
  assert.equal(hooks.BLOCKLIST_SIZE, 6408);
  assert.equal(hooks.BLOCKLIST_MAX, HOOK_LIMITS.blocklistTotal);
  assert.equal(hooks.BLOCKLIST_BATCH, HOOK_LIMITS.blocklistBatch);
  assert.equal(hooks.INIT_CONFIG_ARGS_LEN, 493);
  assert.equal(hooks.HOOK_LAYOUT_VERSION, 1);
  const config = rustOffsets(stateSource, 'config');
  assert.deepEqual(hooks.HOOK_CONFIG_LAYOUT, { ...config, size: 752 });
  assert.deepEqual([config.rules, config.titheRecipient, config.swapBaseAmount, config.vaultInitial, config.reserved], [339, 535, 567, 575, 688]);
  assert.equal(config.rules + 4 * 49, config.titheRecipient);
  assert.equal(config.reserved + 64, config.size);
  assert.deepEqual(hooks.WALLET_STATE_LAYOUT, rustOffsets(stateSource, 'wallet'));
  assert.deepEqual(hooks.ALLOW_ENTRY_LAYOUT, rustOffsets(stateSource, 'allow'));
  assert.deepEqual(hooks.BLOCKLIST_LAYOUT, rustOffsets(stateSource, 'block'));
  assert.deepEqual(hooks.INIT_CONFIG_LAYOUT, rustOffsets(instructionsSource, 'init_config'));
  assert.equal(hooks.TOKEN_2022_PROGRAM_ID.toBase58(), 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  assert.equal(hooks.ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  assert.equal(hooks.SYSTEM_PROGRAM_ID.toBase58(), '11111111111111111111111111111111');
  assert.equal(hooks.SYSVAR_INSTRUCTIONS_ID.toBase58(), 'Sysvar1nstructions1111111111111111111111111');
  assert.deepEqual(hooks.INSTRUCTION_TAGS, { initializeExtraAccountMetaList: 0, initConfig: 1, addAllowed: 2, removeAllowed: 3, registerWallet: 4, addBlocked: 5 });
  assert.deepEqual(hooks.SEEDS, { config: 'config', wallet: 'wallet', allow: 'allow', block: 'block', extraMetas: 'extra-account-metas' });
  assert.deepEqual(hooks.KIND, Object.fromEntries(HOOK_RULES.map(r => [r.id, r.kind])));
});

test(`PDA helpers derive from the documented seeds (${realPdaMath ? 'real web3 PDA math' : 'stub web3: seeds and shape only; address vectors need npm test on the owner PC'})`, () => {
  const cases = [
    [hooks.hookConfigPda(programId, mint), [Buffer.from('config'), bytes(mint)]],
    [hooks.walletStatePda(programId, mint, wallet), [Buffer.from('wallet'), bytes(mint), bytes(wallet)]],
    [hooks.allowEntryPda(programId, mint, wallet), [Buffer.from('allow'), bytes(mint), bytes(wallet)]],
    [hooks.blocklistPda(programId, mint), [Buffer.from('block'), bytes(mint)]],
    [hooks.extraMetasPda(programId, mint), [Buffer.from('extra-account-metas'), bytes(mint)]],
  ];
  for (const [pda, seeds] of cases) {
    assert.deepEqual(Object.keys(pda).sort(), ['address', 'bump', 'key', 'seeds']);
    assert.equal(typeof pda.address, 'string');
    assert.ok(pda.key instanceof PublicKey);
    assert.equal(pda.key.toBase58(), pda.address);
    assert.ok(Number.isInteger(pda.bump) && pda.bump >= 0 && pda.bump <= 255);
    assert.deepEqual(pda.seeds.map(s => s.toString('hex')), seeds.map(s => s.toString('hex')));
    const [expected, bump] = PublicKey.findProgramAddressSync(seeds, programId);
    assert.equal(pda.address, expected.toBase58());
    assert.equal(pda.bump, bump);
    if (realPdaMath) assert.equal(PublicKey.createProgramAddressSync([...seeds, Buffer.from([pda.bump])], programId).toBase58(), pda.address);
  }
  assert.equal(hooks.walletStatePda(programId.toBase58(), mint.toBase58(), wallet.toBase58()).address, hooks.walletStatePda(programId, mint, wallet).address);
  assert.notEqual(hooks.walletStatePda(programId, mint, wallet).address, hooks.walletStatePda(programId, mint, creator).address);
  assert.notEqual(hooks.walletStatePda(programId, mint, wallet).address, hooks.allowEntryPda(programId, mint, wallet).address);
  assert.notEqual(hooks.blocklistPda(programId, mint).address, hooks.hookConfigPda(programId, mint).address);
  const ata = hooks.associatedTokenAddress(wallet, gateMint, gateTokenProgram);
  assert.deepEqual(ata.seeds.map(s => s.toString('hex')), [bytes(wallet), bytes(gateTokenProgram), bytes(gateMint)].map(s => s.toString('hex')));
  assert.equal(ata.address, PublicKey.findProgramAddressSync([bytes(wallet), bytes(gateTokenProgram), bytes(gateMint)], hooks.ASSOCIATED_TOKEN_PROGRAM_ID)[0].toBase58());
  assert.throws(() => hooks.hookConfigPda(programId, undefined), /mint is missing/);
});

test('hookShape follows the catalogue flags for every rule and sizes the list as 16 + 35 × count', () => {
  for (const r of HOOK_RULES) {
    const s = hooks.hookShape([{ id: r.id }]);
    assert.equal(s.sysvar, r.needsSysvar, `${r.id} sysvar`);
    assert.equal(s.blocklist, r.needsBlocklist, `${r.id} blocklist`);
    assert.equal(s.walletState, r.needsWalletState, `${r.id} wallet state`);
    assert.equal(s.allowlist, r.id === 'allowlist');
    assert.equal(s.holderGated, r.id === 'holder_gated');
    assert.deepEqual(hooks.hookShape([{ kind: r.kind }]), s, 'kinds and ids agree');
    assert.deepEqual(hooks.hookShape([r.kind]), s);
    assert.equal(hooks.extraMetasSize([{ kind: r.kind }]), 16 + 35 * s.count);
    // 'any' route rules never need per-trader entries
    if (r.route === 'any') assert.ok(!s.walletState && !s.allowlist && !s.holderGated, `${r.id} is mint-derived only`);
  }
  assert.deepEqual(hooks.hookShape([{ kind: 4 }, { kind: 7 }]), { sysvar: false, blocklist: false, walletState: false, allowlist: false, holderGated: false, count: 1 });
  assert.deepEqual(hooks.hookShape([{ id: 'holder_vesting' }, { id: 'allowlist' }, { id: 'tithe' }]), { sysvar: true, blocklist: false, walletState: true, allowlist: true, holderGated: false, count: 5 });
  assert.deepEqual(hooks.hookShape([]), { sysvar: false, blocklist: false, walletState: false, allowlist: false, holderGated: false, count: 1 });
  const shape = hooks.hookShape([{ kind: 2 }]);
  assert.equal(hooks.hookShape(shape), shape, 'a shape passes through');
  assert.equal(hooks.extraMetasSize(shape), 191);
  assert.equal(hooks.extraMetasSize([{ kind: 1 }, { kind: 3 }]), 156);
  assert.equal(hooks.extraMetasSize([{ kind: 21 }]), 86);
  assert.deepEqual(hooks.hookShapePositions([{ kind: 2 }]), { config: 5, sysvar: null, blocklist: null, srcWallet: null, dstWallet: null, allow: null, ataProgram: 6, gateTokenProgram: 7, gateMint: 8, gateAta: 9, accounts: 10 });
  assert.deepEqual(hooks.hookShapePositions([{ kind: 25 }, { kind: 2 }]), { config: 5, sysvar: 6, blocklist: null, srcWallet: null, dstWallet: null, allow: null, ataProgram: 7, gateTokenProgram: 8, gateMint: 9, gateAta: 10, accounts: 11 });
  assert.deepEqual(hooks.hookShapePositions([{ kind: 3 }, { kind: 1 }]), { config: 5, sysvar: null, blocklist: null, srcWallet: 6, dstWallet: 7, allow: 8, ataProgram: null, gateTokenProgram: null, gateMint: null, gateAta: null, accounts: 9 });
  assert.throws(() => hooks.hookShape([{ settings: {} }]), /has no kind/);
  assert.throws(() => hooks.hookShape('allowlist'), /rules array/);
});

const keyList = ix => ix.keys.map(x => [x.pubkey.toBase58(), x.isSigner, x.isWritable]);

test('InitializeExtraAccountMetaList: tag 0 alone, six accounts ending with the config', () => {
  const ix = hooks.initializeExtraAccountMetaList({ programId, mint, authority: creator, payer });
  assert.equal(ix.programId.toBase58(), programId.toBase58());
  assert.deepEqual([...ix.data], [0]);
  assert.deepEqual(keyList(ix), [
    [hooks.extraMetasPda(programId, mint).address, false, true],
    [mint.toBase58(), false, false],
    [creator.toBase58(), true, false],
    [hooks.SYSTEM_PROGRAM_ID.toBase58(), false, false],
    [payer.toBase58(), true, true],
    [hooks.hookConfigPda(programId, mint).address, false, false],
  ]);
});

const rules = [{ kind: 7, params: six(200) }, { kind: 16, params: six(120, 8, 40, 100, 25) }];

test('InitConfig: tag 1 followed by the 493-byte payload with exact offsets', () => {
  const ix = hooks.initConfig({ programId, mint, creator, payer, exempt: [creator, partner, leftover, migrationAuthority], venues: [vault], gateMint: null, gateTokenProgram: null, titheRecipient: null, swapBaseAmount: '800000000000000', rules });
  assert.deepEqual(keyList(ix), [
    [hooks.hookConfigPda(programId, mint).address, false, true],
    [mint.toBase58(), false, false],
    [creator.toBase58(), true, false],
    [payer.toBase58(), true, true],
    [hooks.SYSTEM_PROGRAM_ID.toBase58(), false, false],
  ]);
  const expected = Buffer.concat([
    Buffer.from([1]),
    bytes(creator), bytes(partner), bytes(leftover), bytes(migrationAuthority),
    bytes(vault), ZERO,
    ZERO, ZERO,
    ZERO, u64('800000000000000'),
    Buffer.from([2]),
    Buffer.from([7]), u64(200), u64(0), u64(0), u64(0), u64(0), u64(0),
    Buffer.from([16]), u64(120), u64(8), u64(40), u64(100), u64(25), u64(0),
    Buffer.alloc(2 * 49),
  ]);
  assert.equal(expected.length, 494);
  assert.equal(ix.data.toString('hex'), expected.toString('hex'));
  // payload offsets (after the tag): exempt 0, venues 128, gate mint 192, gate program 224, tithe recipient 256, swap base 288, rule count 296, rules 297
  const payload = ix.data.subarray(1), L = hooks.INIT_CONFIG_LAYOUT;
  assert.equal(payload.subarray(L.venues, L.venues + 32).toString('hex'), bytes(vault).toString('hex'));
  assert.equal(payload.readBigUInt64LE(L.swapBaseAmount), 800000000000000n);
  assert.equal(payload[L.ruleCount], 2);
  assert.equal(payload[L.rules], 7);
  assert.equal(payload.readBigUInt64LE(L.rules + 1), 200n);
  assert.equal(payload.readBigUInt64LE(L.rules + 9), 0n);
  assert.equal(payload[L.rules + 49], 16);
  assert.equal(payload.readBigUInt64LE(L.rules + 49 + 1 + 4 * 8), 25n, 'the fifth parameter of rule two');
  // gate keys and the tithe recipient are written when given
  const gated = hooks.initConfig({ programId, mint, creator, payer, exempt: [creator], venues: [vault], gateMint, gateTokenProgram, titheRecipient, rules: [{ kind: 2, params: six(1000000, 6) }, { kind: 25, params: six(5000000) }] });
  assert.equal(gated.data.subarray(1 + L.gateMint, 1 + L.gateMint + 32).toString('hex'), bytes(gateMint).toString('hex'));
  assert.equal(gated.data.subarray(1 + L.gateTokenProgram, 1 + L.gateTokenProgram + 32).toString('hex'), bytes(gateTokenProgram).toString('hex'));
  assert.equal(gated.data.subarray(1 + L.titheRecipient, 1 + L.titheRecipient + 32).toString('hex'), bytes(titheRecipient).toString('hex'));
  assert.equal(gated.data.readBigUInt64LE(1 + L.swapBaseAmount), 0n, 'swapBaseAmount defaults to zero');
  assert.equal(gated.data[1 + L.ruleCount], 2);
  // validation mirrors the program's InitConfig checks
  const base = { programId, mint, creator, payer, exempt: [creator], venues: [vault] };
  assert.throws(() => hooks.initConfig({ ...base, rules: [] }), /1 to 4 rules/);
  assert.throws(() => hooks.initConfig({ ...base, rules: Array(5).fill(rules[0]) }), /1 to 4 rules/);
  assert.throws(() => hooks.initConfig({ ...base, rules: [{ kind: 28, params: six() }] }), /1\.\.27/);
  assert.throws(() => hooks.initConfig({ ...base, rules: [{ kind: 0, params: six() }] }), /1\.\.27/);
  assert.throws(() => hooks.initConfig({ ...base, rules: [rules[0], rules[0]] }), /twice/);
  assert.throws(() => hooks.initConfig({ ...base, rules: [{ kind: 4, params: ['200', '25', '0', '0'] }] }), /exactly 6 parameters/);
  assert.throws(() => hooks.initConfig({ ...base, rules: [{ kind: 4, params: six(200, 25, 0, 0, 0, -1) }] }), /u64/);
  assert.throws(() => hooks.initConfig({ ...base, venues: [], rules }), /one or two venues/);
  assert.throws(() => hooks.initConfig({ ...base, venues: [PublicKey.default], rules }), /first venue/);
  assert.throws(() => hooks.initConfig({ ...base, exempt: [creator, partner, leftover, migrationAuthority, wallet], rules }), /four exempt/);
  assert.throws(() => hooks.initConfig({ ...base, rules: [{ kind: 2, params: six(1, 6) }] }), /gate mint/);
  assert.throws(() => hooks.initConfig({ ...base, rules: [{ kind: 25, params: six(5000000) }] }), /recipient/);
  assert.throws(() => hooks.initConfig({ ...base, rules: [ruleOf('sliding_caps')] }), /swap base amount/);
  hooks.initConfig({ ...base, swapBaseAmount: '1', rules: [ruleOf('sliding_caps')] });
  // the catalogue's conflict pairs are refused
  assert.throws(() => hooks.initConfig({ ...base, rules: [{ kind: 1, params: six() }, { kind: 17, params: six() }] }), /cannot be combined/);
  assert.throws(() => hooks.initConfig({ ...base, rules: [{ kind: 4, params: six(200, 25) }, { kind: 10, params: six(50) }] }), /Trade guard cannot be combined with Anti-dump caps/);
  for (const [a, b] of HOOK_CONFLICTS) assert.throws(() => hooks.initConfig({ ...base, gateMint, gateTokenProgram, titheRecipient, swapBaseAmount: '1', rules: [ruleOf(a), ruleOf(b)] }), /cannot be combined/, `${a} / ${b}`);
});

test('every catalogue rule feeds InitConfig with its default, minimum and maximum settings', () => {
  const extremes = (r, pick) => Object.fromEntries(r.settings.map(s => [s.key, s.options ? s.options[pick === 'min' ? 0 : s.options.length - 1] : s[pick]]));
  for (const r of HOOK_RULES) {
    for (const [label, settings] of [['default', {}], ['min', extremes(r, 'min')], ['max', extremes(r, 'max')]]) {
      let normalized;
      try { normalized = normalizeHookSettings(r.id, settings); } catch { continue; } // extremes that break a cross-field rule (floor > base) are not launchable anyway
      const params = hookRuleParams(r.id, normalized, { gateDecimals: 6, decimals: 6, appMark: APP_MARK });
      assert.equal(params.length, 6, `${r.id} ${label} emits six parameters`);
      const data = hooks.initConfigData({ exempt: [creator], venues: [vault], gateMint, gateTokenProgram, titheRecipient, swapBaseAmount: '800000000000000', rules: [{ kind: r.kind, params }] });
      assert.equal(data.length, 493);
      assert.equal(data[hooks.INIT_CONFIG_LAYOUT.rules], r.kind);
      params.forEach((value, j) => assert.equal(data.readBigUInt64LE(hooks.INIT_CONFIG_LAYOUT.rules + 1 + j * 8).toString(), value, `${r.id} ${label} parameter ${j}`));
    }
  }
  // four compatible rules at once, in catalogue parameter order
  const chosen = ['chapters', 'market_hours', 'holder_gated', 'breathing_cap'].map(id => ruleOf(id));
  const ix = hooks.initConfig({ programId, mint, creator, payer, exempt: [creator], venues: [vault], gateMint, gateTokenProgram, rules: chosen });
  const payload = ix.data.subarray(1);
  assert.equal(payload[hooks.INIT_CONFIG_LAYOUT.ruleCount], 4);
  chosen.forEach((rule, i) => {
    const p = hooks.INIT_CONFIG_LAYOUT.rules + i * 49;
    assert.equal(payload[p], rule.kind);
    rule.params.forEach((value, j) => assert.equal(payload.readBigUInt64LE(p + 1 + j * 8).toString(), value));
  });
  const chapters = chosen.find(r => r.kind === 9);
  assert.deepEqual(chapters.params, ['100', '10000000000000', '0', '0', '0', '0'], '1% start, 10M tokens (6 decimals) per chapter');
  const trading = ruleOf('trading_hours', { tzOffset: -300, dst: 1 });
  assert.deepEqual(trading.params, ['540', '1020', '31', '1140', '1', '0'], 'the offset is shifted by 1440 so it fits a u64');
});

test('AddAllowed, RemoveAllowed, RegisterWallet and AddBlocked: tags 2, 3, 4, 5 with their account lists', () => {
  const add = hooks.addAllowed({ programId, mint, creator, payer, wallet });
  assert.equal(add.data.toString('hex'), Buffer.concat([Buffer.from([2]), bytes(wallet)]).toString('hex'));
  assert.deepEqual(keyList(add), [
    [hooks.hookConfigPda(programId, mint).address, false, false],
    [creator.toBase58(), true, false],
    [payer.toBase58(), true, true],
    [hooks.allowEntryPda(programId, mint, wallet).address, false, true],
    [hooks.SYSTEM_PROGRAM_ID.toBase58(), false, false],
  ]);
  const remove = hooks.removeAllowed({ programId, mint, creator, wallet, refundTo: payer });
  assert.deepEqual([...remove.data], [3]);
  assert.deepEqual(keyList(remove), [
    [hooks.hookConfigPda(programId, mint).address, false, false],
    [creator.toBase58(), true, false],
    [hooks.allowEntryPda(programId, mint, wallet).address, false, true],
    [payer.toBase58(), false, true],
  ]);
  assert.equal(keyList(hooks.removeAllowed({ programId, mint, creator, wallet }))[3][0], creator.toBase58(), 'the refund defaults to the creator');
  const register = hooks.registerWallet({ programId, mint, wallet, payer });
  assert.deepEqual([...register.data], [4]);
  assert.deepEqual(keyList(register), [
    [hooks.hookConfigPda(programId, mint).address, false, false],
    [wallet.toBase58(), false, false],
    [payer.toBase58(), true, true],
    [hooks.walletStatePda(programId, mint, wallet).address, false, true],
    [hooks.SYSTEM_PROGRAM_ID.toBase58(), false, false],
  ]);
  const blocked = hooks.addBlocked({ programId, mint, creator, payer, wallets: [wallet, partner.toBase58()] });
  assert.equal(blocked.data.toString('hex'), Buffer.concat([Buffer.from([5, 2]), bytes(wallet), bytes(partner)]).toString('hex'));
  assert.deepEqual(keyList(blocked), [
    [hooks.hookConfigPda(programId, mint).address, false, false],
    [creator.toBase58(), true, false],
    [payer.toBase58(), true, true],
    [hooks.blocklistPda(programId, mint).address, false, true],
    [hooks.SYSTEM_PROGRAM_ID.toBase58(), false, false],
  ]);
  const many = Array.from({ length: 28 }, (_, i) => k(100 + i));
  assert.equal(hooks.addBlocked({ programId, mint, creator, payer, wallets: many }).data.length, 2 + 28 * 32);
  assert.throws(() => hooks.addBlocked({ programId, mint, creator, payer, wallets: [...many, wallet] }), /1 to 28/);
  assert.throws(() => hooks.addBlocked({ programId, mint, creator, payer, wallets: [] }), /1 to 28/);
  assert.throws(() => hooks.addBlocked({ programId, mint, creator, payer, wallets: [PublicKey.default] }), /zero address/);
  for (const ix of [add, remove, register, blocked]) {
    assert.equal(ix.programId.toBase58(), programId.toBase58());
    assert.ok(Buffer.isBuffer(ix.data));
    for (const key of ix.keys) assert.ok(key.pubkey instanceof PublicKey);
  }
  assert.throws(() => hooks.addAllowed({ programId, mint, creator, payer }), /wallet is missing/);
});

test('ExtraAccountMetaList bytes equal the shared fixture in every shape', () => {
  const gateKeys = { gateTokenProgram: new PublicKey(Uint8Array.from(fixture.gateTokenProgramBytes)), gateMint: new PublicKey(Uint8Array.from(fixture.gateMintBytes)) };
  assert.equal(fixture.gateTokenProgram, gateKeys.gateTokenProgram.toBase58());
  assert.deepEqual(Object.keys(fixture.shapes), ['configOnly', 'sysvar', 'blocklist', 'route', 'holderGated', 'full']);
  for (const [name, section] of Object.entries(fixture.shapes)) {
    const shape = hooks.hookShape({ ...section.flags, count: section.entries });
    const built = hooks.extraAccountMetaListBytes({ shape, ...gateKeys });
    assert.equal(built.length, section.size, `${name} size`);
    assert.equal(built.length, hooks.extraMetasSize(shape));
    assert.equal(built.toString('hex'), section.hex, `${name} bytes`);
    assert.equal(built.subarray(0, 8).toString('hex'), hooks.EXECUTE_DISCRIMINATOR.toString('hex'));
    assert.equal(built.readUInt32LE(8), 4 + section.entries * 35);
    assert.equal(built.readUInt32LE(12), section.entries);
    assert.deepEqual(hooks.hookShapePositions(shape), section.positions, `${name} positions`);
    if (section.exampleRules) assert.equal(hooks.extraAccountMetaListBytes({ rules: section.exampleRules.map(id => ({ id })), ...gateKeys }).toString('hex'), section.hex, `${name} from its example rules`);
  }
  // the config entry is identical in every shape
  const configEntry = Buffer.from(fixture.shapes.configOnly.hex, 'hex').subarray(16, 51).toString('hex');
  for (const section of Object.values(fixture.shapes)) assert.equal(Buffer.from(section.hex, 'hex').subarray(16, 51).toString('hex'), configEntry);
  // entries, decoded: the full shape
  const full = hooks.decodeExtraAccountMetaList(Buffer.from(fixture.shapes.full.hex, 'hex'));
  assert.deepEqual(full.map(e => e.discriminator), [1, 0, 1, 1, 1, 1, 0, 0, 0, 128 + 11]);
  assert.deepEqual(full.map(e => e.isWritable), [true, false, false, true, true, false, false, false, false, false]);
  assert.ok(full.every(e => e.isSigner === false));
  assert.equal(full[0].addressConfig.slice(0, 20), Buffer.from([1, 6, ...Buffer.from('config'), 3, 1]).toString('hex'));
  assert.equal(full[1].address, hooks.SYSVAR_INSTRUCTIONS_ID.toBase58());
  assert.equal(full[2].addressConfig.slice(0, 18), Buffer.from([1, 5, ...Buffer.from('block'), 3, 1]).toString('hex'));
  assert.equal(full[3].addressConfig.slice(0, 28), Buffer.from([1, 6, ...Buffer.from('wallet'), 3, 1, 4, 0, 32, 32]).toString('hex'), 'source owner from the source token account data');
  assert.equal(full[4].addressConfig.slice(0, 28), Buffer.from([1, 6, ...Buffer.from('wallet'), 3, 1, 4, 2, 32, 32]).toString('hex'));
  assert.equal(full[5].addressConfig.slice(0, 26), Buffer.from([1, 5, ...Buffer.from('allow'), 3, 1, 4, 2, 32, 32]).toString('hex'));
  assert.equal(full[6].address, hooks.ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
  assert.equal(full[7].address, fixture.gateTokenProgram);
  assert.equal(full[8].address, fixture.gateMint);
  assert.equal(full[9].addressConfig.slice(0, 16), Buffer.from([4, 2, 32, 32, 3, 12, 3, 13]).toString('hex'), 'gate ATA seeds point at the actual indices 12 and 13');
  // the plain holder-gated shape: the gate accounts follow the config directly, so the indices shift down
  const gated = hooks.decodeExtraAccountMetaList(Buffer.from(fixture.shapes.holderGated.hex, 'hex'));
  assert.deepEqual(gated.map(e => e.discriminator), [1, 0, 0, 0, 128 + 6]);
  assert.equal(gated[4].addressConfig.slice(0, 16), Buffer.from([4, 2, 32, 32, 3, 7, 3, 8]).toString('hex'));
  // tithe + holder_gated: sysvar at 6, gate accounts at 7..10
  const mixed = hooks.decodeExtraAccountMetaList(hooks.extraAccountMetaListBytes({ rules: [{ id: 'tithe' }, { id: 'holder_gated' }], ...gateKeys }));
  assert.deepEqual(mixed.map(e => e.discriminator), [1, 0, 0, 0, 0, 128 + 7]);
  assert.equal(mixed[5].addressConfig.slice(0, 16), Buffer.from([4, 2, 32, 32, 3, 8, 3, 9]).toString('hex'));
  assert.equal(hooks.decodeExtraAccountMetaList(Buffer.from(fixture.shapes.configOnly.hex, 'hex')).length, 1);
  assert.throws(() => hooks.extraAccountMetaListBytes({ rules: [{ kind: 2 }] }), /gateTokenProgram and gateMint/);
  assert.throws(() => hooks.decodeExtraAccountMetaList(Buffer.alloc(156)), /not an ExtraAccountMetaList/);
});

test('decoders read hand-built HookConfig, WalletState, AllowEntry and BlockList buffers', () => {
  const L = hooks.HOOK_CONFIG_LAYOUT, config = Buffer.alloc(752);
  config[L.version] = 1; config[L.bump] = 253;
  bytes(mint).copy(config, L.mint); bytes(creator).copy(config, L.creator);
  bytes(creator).copy(config, L.exempt); bytes(partner).copy(config, L.exempt + 32); bytes(leftover).copy(config, L.exempt + 64);
  bytes(vault).copy(config, L.venues);
  bytes(gateMint).copy(config, L.gateMint); bytes(gateTokenProgram).copy(config, L.gateTokenProgram);
  i64(-5).copy(config, L.startedAt); u64(250000000).copy(config, L.startSlot);
  config[L.ruleCount] = 2;
  config[L.rules] = 4; u64(200).copy(config, L.rules + 1); u64(25).copy(config, L.rules + 9);
  config[L.rules + 49] = 16; u64(120).copy(config, L.rules + 50); u64(8).copy(config, L.rules + 58); u64(40).copy(config, L.rules + 66); u64(100).copy(config, L.rules + 74); u64(25).copy(config, L.rules + 82);
  bytes(titheRecipient).copy(config, L.titheRecipient); u64('800000000000000').copy(config, L.swapBaseAmount);
  u64('1000000000000000').copy(config, L.vaultInitial); u64(123).copy(config, L.volumeBought); u64(250000010).copy(config, L.lastSlot); u64(2).copy(config, L.slotTrades);
  bytes(wallet).copy(config, L.potatoHolder); i64(1700000100).copy(config, L.potatoSince); config[L.turnSide] = 2; i64(1700000200).copy(config, L.turnTs);
  u64(500000).copy(config, L.oscEnergy); u64(250000).copy(config, L.oscEnergy2); u64(32768).copy(config, L.oscPhase); i64(1700000300).copy(config, L.oscTs);
  const decoded = hooks.decodeHookConfig(config);
  assert.deepEqual(decoded, {
    version: 1, bump: 253, mint: mint.toBase58(), creator: creator.toBase58(),
    exempt: [creator.toBase58(), partner.toBase58(), leftover.toBase58(), PublicKey.default.toBase58()],
    venues: [vault.toBase58(), PublicKey.default.toBase58()],
    gateMint: gateMint.toBase58(), gateTokenProgram: gateTokenProgram.toBase58(),
    startedAt: '-5', startSlot: '250000000', ruleCount: 2,
    rules: [{ kind: 4, id: 'anti_dump', params: ['200', '25', '0', '0', '0', '0'] }, { kind: 16, id: 'momentum', params: ['120', '8', '40', '100', '25', '0'] }],
    titheRecipient: titheRecipient.toBase58(), swapBaseAmount: '800000000000000',
    vaultInitial: '1000000000000000', volumeBought: '123', lastSlot: '250000010', slotTrades: '2',
    potatoHolder: wallet.toBase58(), potatoSince: '1700000100', turnSide: 2, turnSideName: 'sell', turnTs: '1700000200',
    oscEnergy: '500000', oscEnergy2: '250000', oscPhase: '32768', oscTs: '1700000300',
    shape: { sysvar: false, blocklist: false, walletState: false, allowlist: false, holderGated: false, count: 1 },
  });
  assert.deepEqual(hooks.decodeHookConfig(Uint8Array.from(config)), decoded, 'Uint8Array input works');
  assert.deepEqual(hooks.decodeHookConfig({ data: config }), decoded, 'an account info object works');
  assert.throws(() => hooks.decodeHookConfig(config.subarray(0, 751)), /not a HookConfig/);
  assert.throws(() => hooks.decodeHookConfig(Buffer.alloc(559)), /not a HookConfig/);
  const wrongVersion = Buffer.from(config); wrongVersion[0] = 2;
  assert.throws(() => hooks.decodeHookConfig(wrongVersion), /not a HookConfig/);
  const tooMany = Buffer.from(config); tooMany[L.ruleCount] = 5;
  assert.throws(() => hooks.decodeHookConfig(tooMany), /rule count/);
  const badTurn = Buffer.from(config); badTurn[L.turnSide] = 3;
  assert.throws(() => hooks.decodeHookConfig(badTurn), /turn side/);
  // the decoded rules feed the shape helpers directly
  const vesting = Buffer.from(config); vesting[L.rules] = 3; vesting[L.rules + 49] = 25;
  assert.deepEqual(hooks.decodeHookConfig(vesting).shape, { sysvar: true, blocklist: false, walletState: true, allowlist: false, holderGated: false, count: 4 });

  const state = Buffer.alloc(34);
  state[0] = 1; state[1] = 254; i64(-7).copy(state, 2); u64('18446744073709551615').copy(state, 10);
  assert.deepEqual(hooks.decodeWalletState(state), { version: 1, bump: 254, firstReceiptTs: '-7', receivedTotal: '18446744073709551615' });
  assert.throws(() => hooks.decodeWalletState(Buffer.alloc(34)), /not a WalletState/);
  assert.throws(() => hooks.decodeWalletState(Buffer.alloc(43)), /not a WalletState/);

  const entry = Buffer.alloc(66);
  entry[0] = 1; entry[1] = 251; bytes(mint).copy(entry, 2); bytes(wallet).copy(entry, 34);
  assert.deepEqual(hooks.decodeAllowEntry(entry), { version: 1, bump: 251, mint: mint.toBase58(), wallet: wallet.toBase58() });
  assert.throws(() => hooks.decodeAllowEntry(Buffer.alloc(66)), /not an AllowEntry/);
  assert.deepEqual(hooks.allowEntryFilters(mint), [{ dataSize: 66 }, { memcmp: { offset: 2, bytes: mint.toBase58() } }]);

  const list = Buffer.alloc(6408);
  list[0] = 1; list[1] = 250; list[2] = 3; bytes(wallet).copy(list, 8); bytes(partner).copy(list, 40); bytes(leftover).copy(list, 72); bytes(creator).copy(list, 104);
  assert.deepEqual(hooks.decodeBlocklist(list), { version: 1, bump: 250, count: 3, wallets: [wallet.toBase58(), partner.toBase58(), leftover.toBase58()] });
  const full = Buffer.from(list); full[2] = 200;
  assert.equal(hooks.decodeBlocklist(full).wallets.length, 200);
  const over = Buffer.from(list); over[2] = 201;
  assert.throws(() => hooks.decodeBlocklist(over), /not a BlockList/);
  assert.throws(() => hooks.decodeBlocklist(Buffer.alloc(6408)), /not a BlockList/);
  assert.throws(() => hooks.decodeBlocklist(list.subarray(0, 6407)), /not a BlockList/);
});

test('the error table mirrors src/errors.rs and carries the catalogue names and texts', () => {
  const rustCodes = Object.fromEntries([...errorsSource.matchAll(/^\s+([A-Z][A-Za-z0-9]+) = (\d+),$/gm)].map(m => [Number(m[2]), m[1]]));
  const rustMessages = Object.fromEntries([...errorsSource.matchAll(/HookError::([A-Za-z0-9]+) => "((?:[^"\\]|\\.)*)",/g)].map(m => [m[1], m[2].replace(/\\"/g, '"')]));
  assert.equal(Object.keys(rustCodes).length, 37);
  assert.deepEqual(Object.fromEntries(Object.entries(hooks.HOOK_ERRORS).map(([code, e]) => [Number(code), e.name])), rustCodes);
  for (const [code, e] of Object.entries(hooks.HOOK_ERRORS)) {
    assert.equal(e.code, Number(code));
    assert.equal(e.message, rustMessages[e.name], `${e.name} message`);
    assert.ok(/\.$/.test(e.message));
  }
  for (const rule of HOOK_RULES) {
    const e = hooks.HOOK_ERRORS[hooks.hookErrorCodeForRule(rule.kind)];
    assert.ok(e, `${rule.id} has an error code`);
    assert.equal(e.name, rule.id.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(''), `${rule.id} → ${e.name}`);
    assert.equal(e.ruleId, rule.id);
    assert.equal(e.title, rule.name);
    assert.equal(e.message, rule.rule, `${rule.id} text is the catalogue's rule sentence`);
  }
  assert.deepEqual(Object.keys(hooks.HOOK_ERRORS).map(Number).filter(c => c < 6100), Array.from({ length: 27 }, (_, i) => 6001 + i));
  assert.equal(hooks.HOOK_ERRORS[6026].name, 'FomoOnly'); assert.equal(hooks.HOOK_ERRORS[6027].name, 'PumpAppOnly');
  assert.deepEqual(Object.keys(hooks.HOOK_ERRORS).map(Number).filter(c => c >= 6100), [6100, 6101, 6102, 6103, 6104, 6105, 6106, 6107, 6108, 6109]);
  assert.deepEqual([6100, 6101, 6102, 6103, 6104, 6105, 6106, 6107, 6108, 6109].map(c => hooks.HOOK_ERRORS[c].name), ['WalletNotRegistered', 'NotAllowed', 'ConfigMismatch', 'BadAccounts', 'NotTransferring', 'Overflow', 'AlreadyInitialized', 'BlocklistFull', 'LaunchStarted', 'BadSysvar']);
  assert.equal(hooks.HOOK_ERRORS[6100].ruleId, null);
  assert.equal(hooks.HOOK_ERRORS[6018].name, 'HotPotato');
  assert.equal(hooks.HOOK_ERRORS[6020].name, 'P2pOnly');
});

test('the Rust CONFLICTS table mirrors the catalogue pairs, by kind and in order', () => {
  const block = executeSource.slice(executeSource.indexOf('pub const CONFLICTS'), executeSource.indexOf('];', executeSource.indexOf('pub const CONFLICTS')));
  const pairs = [...block.matchAll(/\((\d+), (\d+)\)/g)].map(m => [Number(m[1]), Number(m[2])]);
  assert.equal(pairs.length, HOOK_CONFLICTS.length);
  assert.deepEqual(pairs, HOOK_CONFLICTS.map(([a, b]) => [hookRuleById(a).kind, hookRuleById(b).kind]));
  assert.match(block, new RegExp(`\\[\\(u8, u8\\); ${HOOK_CONFLICTS.length}\\]`));
  // and the Rust kind constants agree with the catalogue
  for (const r of HOOK_RULES) assert.match(executeSource, new RegExp(`pub const KIND_${r.id.toUpperCase()}: u8 = ${r.kind};`), r.id);
  assert.match(executeSource, /pub const MAX_KIND: u8 = 27;/);
  assert.equal(hooks.MAX_KIND, 27);
});

test('resolveExecuteAccounts lists the extra accounts in list order for every shape', () => {
  const poolAuthority = k(5);
  const show = list => list.map(m => [m.pubkey.toBase58(), m.isWritable, m.isSigner]);
  const configOnly = hooks.resolveExecuteAccounts({ programId, mint, sourceOwner: poolAuthority, destinationOwner: wallet, rules: [{ kind: 4 }, { kind: 7 }] });
  assert.deepEqual(show(configOnly), [[hooks.hookConfigPda(programId, mint).address, true, false]]);
  const sysvar = hooks.resolveExecuteAccounts({ programId, mint, sourceOwner: poolAuthority, destinationOwner: wallet, rules: [{ id: 'sniper_fee_cap' }] });
  assert.deepEqual(show(sysvar), [[hooks.hookConfigPda(programId, mint).address, true, false], [hooks.SYSVAR_INSTRUCTIONS_ID.toBase58(), false, false]]);
  const blocklist = hooks.resolveExecuteAccounts({ programId, mint, sourceOwner: poolAuthority, destinationOwner: wallet, rules: [{ kind: 17 }] });
  assert.deepEqual(show(blocklist), [[hooks.hookConfigPda(programId, mint).address, true, false], [hooks.blocklistPda(programId, mint).address, false, false]]);
  const route = hooks.resolveExecuteAccounts({ programId, mint, sourceOwner: poolAuthority, destinationOwner: wallet, rules: [{ kind: 3 }, { kind: 1 }] });
  assert.deepEqual(show(route), [
    [hooks.hookConfigPda(programId, mint).address, true, false],
    [hooks.walletStatePda(programId, mint, poolAuthority).address, true, false],
    [hooks.walletStatePda(programId, mint, wallet).address, true, false],
    [hooks.allowEntryPda(programId, mint, wallet).address, false, false],
  ]);
  const gated = hooks.resolveExecuteAccounts({ programId, mint, sourceOwner: wallet, destinationOwner: poolAuthority, rules: [{ kind: 2 }], gateMint, gateTokenProgram });
  assert.deepEqual(show(gated), [
    [hooks.hookConfigPda(programId, mint).address, true, false],
    [hooks.ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), false, false],
    [gateTokenProgram.toBase58(), false, false],
    [gateMint.toBase58(), false, false],
    [hooks.associatedTokenAddress(poolAuthority, gateMint, gateTokenProgram).address, false, false],
  ]);
  const everything = hooks.resolveExecuteAccounts({ programId, mint, sourceOwner: wallet, destinationOwner: poolAuthority, shape: { sysvar: true, blocklist: true, walletState: true, allowlist: true, holderGated: true, count: 10 }, gateMint, gateTokenProgram });
  assert.equal(everything.length, 10);
  assert.deepEqual(everything.map(m => m.isWritable), [true, false, false, true, true, false, false, false, false, false]);
  assert.equal(everything[3].pubkey.toBase58(), hooks.walletStatePda(programId, mint, wallet).address, 'a sell: the trader is the source owner');
  assert.equal(everything[5].pubkey.toBase58(), hooks.allowEntryPda(programId, mint, poolAuthority).address, 'the allow entry follows the destination owner');
  // list order matches the TLV writer entry for entry
  for (const section of Object.values(fixture.shapes)) {
    const shape = { ...section.flags, count: section.entries };
    const resolved = hooks.resolveExecuteAccounts({ programId, mint, sourceOwner: wallet, destinationOwner: poolAuthority, shape, gateMint, gateTokenProgram });
    const entries = hooks.decodeExtraAccountMetaList(hooks.extraAccountMetaListBytes({ shape, gateMint, gateTokenProgram }));
    assert.equal(resolved.length, entries.length);
    entries.forEach((e, i) => {
      assert.equal(resolved[i].isWritable, e.isWritable, `${section.entries}-entry shape, entry ${i} writability`);
      if (e.discriminator === 0) assert.equal(resolved[i].pubkey.toBase58(), e.address, `literal entry ${i}`);
    });
  }
  assert.throws(() => hooks.resolveExecuteAccounts({ programId, mint, sourceOwner: wallet, destinationOwner: poolAuthority, rules: [{ kind: 2 }] }), /gateMint and gateTokenProgram/);
  assert.throws(() => hooks.resolveExecuteAccounts({ programId, mint, sourceOwner: wallet, destinationOwner: poolAuthority }), /needs the rules/);
  // string keys work; gate keys are ignored by shapes that do not need them
  assert.equal(hooks.resolveExecuteAccounts({ programId: programId.toBase58(), mint: mint.toBase58(), sourceOwner: wallet.toBase58(), destinationOwner: poolAuthority.toBase58(), rules: [{ kind: 12 }], gateMint }).length, 1);
  // the block a hooked DBC instruction carries: the resolved metas, then the hook program and the list PDA
  const remaining = hooks.hookRemainingAccounts({ programId, mint, sourceOwner: poolAuthority, destinationOwner: wallet, rules: [{ kind: 3 }, { kind: 1 }] });
  assert.equal(remaining.length, 6);
  assert.deepEqual(show(remaining.slice(4)), [[programId.toBase58(), false, false], [hooks.extraMetasPda(programId, mint).address, false, false]]);
  assert.deepEqual(show(remaining.slice(0, 4)), show(route));
});

test('hookErrorMessage reads custom codes out of simulation errors, text and logs', () => {
  assert.equal(hooks.hookErrorMessage({ InstructionError: [2, { Custom: 6007 }] }), hooks.HOOK_ERRORS[6007].message);
  assert.equal(hooks.hookErrorMessage({ err: { InstructionError: [0, { Custom: 6001 }] }, logs: [] }), hooks.HOOK_ERRORS[6001].message);
  assert.equal(hooks.hookErrorMessage('Transaction simulation failed: Error processing Instruction 3: custom program error: 0x1771'), hooks.HOOK_ERRORS[6001].message);
  assert.equal(hooks.hookErrorMessage('custom program error: 6100'), hooks.HOOK_ERRORS[6100].message);
  assert.equal(hooks.hookErrorMessage('custom program error: 0x17dd'), hooks.HOOK_ERRORS[6109].message);
  assert.equal(hooks.hookErrorMessage({ logs: ['Program log: rule 13', `Program ${programId.toBase58()} failed: custom program error: 0x177d`] }), hooks.HOOK_ERRORS[6013].message);
  assert.equal(hooks.hookErrorMessage(new Error('failed to send transaction: custom program error: 0x17d6')), hooks.HOOK_ERRORS[6102].message);
  assert.equal(hooks.hookErrorMessage(6025), hooks.HOOK_ERRORS[6025].message);
  assert.equal(hooks.hookErrorCode({ InstructionError: [1, { Custom: 6018 }] }), 6018);
  // not ours
  assert.equal(hooks.hookErrorMessage({ InstructionError: [0, { Custom: 6999 }] }), null);
  assert.equal(hooks.hookErrorMessage({ InstructionError: [0, { Custom: 6028 }] }), null);
  assert.equal(hooks.hookErrorMessage({ InstructionError: [0, { Custom: 6110 }] }), null);
  assert.equal(hooks.hookErrorMessage({ InstructionError: [0, 'InsufficientFunds'] }), null);
  assert.equal(hooks.hookErrorMessage('Blockhash not found'), null);
  assert.equal(hooks.hookErrorMessage(null), null);
  assert.equal(hooks.hookErrorMessage({ code: -32002, message: 'Transaction simulation failed' }), null);
  // with a program id, the failing program's log line decides: Anchor programs also count errors from 6000
  const dbc = k(123).toBase58();
  const logs = ['Program log: Instruction: Swap', `Program ${dbc} failed: custom program error: 0x1771`];
  assert.equal(hooks.hookErrorMessage({ InstructionError: [0, { Custom: 6001 }], logs }, { programId }), null);
  assert.equal(hooks.hookErrorMessage({ InstructionError: [0, { Custom: 6001 }], logs: [`Program ${programId.toBase58()} failed: custom program error: 0x1771`] }, { programId }), hooks.HOOK_ERRORS[6001].message);
  assert.equal(hooks.hookErrorMessage({ InstructionError: [0, { Custom: 6004 }] }, { programId }), hooks.HOOK_ERRORS[6004].message, 'without logs the code alone is used');
});
