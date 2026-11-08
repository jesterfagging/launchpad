// Reference encoder for Launchpad's transfer hook program (contracts/curve-transfer-hook, rules v2).
// Everything the server needs to talk to the program without an IDL: the
// interface discriminators, PDA derivations, instruction builders with the exact
// byte layouts, the ExtraAccountMetaList TLV writer (byte-identical to the Rust
// writer; test/fixtures/hook-tlv.json pins six shapes), account decoders, the
// Execute extra-account resolver and the error table. Nothing here signs, sends
// or reads the chain; builders return plain { programId, keys, data } objects
// that `new TransactionInstruction(...)` accepts. All 64-bit numbers cross this
// boundary as decimal strings (the catalogue's hookRuleParams produces them).
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { HOOK_RULES, HOOK_PARAM_COUNT as CATALOG_PARAM_COUNT, hookRuleById, hookRuleByKind, hookRulesConflict } from '../../public/hook-catalog.mjs';

export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
/** The instructions sysvar: a literal entry of every shape whose rules read the transaction (sniper_fee_cap, tithe, fomo_only, pump_app_only). */
export const SYSVAR_INSTRUCTIONS_ID = new PublicKey('Sysvar1nstructions1111111111111111111111111');

const discriminator = name => createHash('sha256').update(`spl-transfer-hook-interface:${name}`).digest().subarray(0, 8);
/** sha256("spl-transfer-hook-interface:execute")[0..8] — Token-2022 sends this; it is also the TLV type of the ExtraAccountMetaList. */
export const EXECUTE_DISCRIMINATOR = Buffer.from(discriminator('execute'));
/** sha256("spl-transfer-hook-interface:initialize-extra-account-metas")[0..8] — accepted as an alias of tag 0. */
export const INITIALIZE_EXTRA_ACCOUNT_METAS_DISCRIMINATOR = Buffer.from(discriminator('initialize-extra-account-metas'));
/** sha256("spl-transfer-hook-interface:update-extra-account-metas")[0..8] — the program rejects it (the list is immutable). */
export const UPDATE_EXTRA_ACCOUNT_METAS_DISCRIMINATOR = Buffer.from(discriminator('update-extra-account-metas'));

export const SEEDS = Object.freeze({ config: 'config', wallet: 'wallet', allow: 'allow', block: 'block', extraMetas: 'extra-account-metas' });
export const INSTRUCTION_TAGS = Object.freeze({ initializeExtraAccountMetaList: 0, initConfig: 1, addAllowed: 2, removeAllowed: 3, registerWallet: 4, addBlocked: 5 });
export const HOOK_PARAM_COUNT = 6;
export const MAX_RULES = 4;
export const MAX_KIND = 27;
export const RULE_LEN = 1 + 8 * HOOK_PARAM_COUNT; // 49
export const INIT_CONFIG_ARGS_LEN = 297 + MAX_RULES * RULE_LEN; // 493
export const HOOK_CONFIG_SIZE = 752;
export const WALLET_STATE_SIZE = 34;
export const ALLOW_ENTRY_SIZE = 66;
export const BLOCKLIST_SIZE = 8 + 200 * 32; // 6408
export const BLOCKLIST_MAX = 200;
export const BLOCKLIST_BATCH = 28;
export const EXTRA_META_LEN = 35;
export const EXTRA_METAS_HEADER_LEN = 16;
/** Layout version byte of every account (the earlier layout was never deployed, so v2 keeps the byte at 1). */
export const HOOK_LAYOUT_VERSION = 1;
if (CATALOG_PARAM_COUNT !== HOOK_PARAM_COUNT) throw Error('hook program: the catalogue and the encoder disagree on the parameter count.');

/** Byte offsets of every account field (little-endian, fixed sizes); mirrors contracts/curve-transfer-hook/src/state.rs. */
export const HOOK_CONFIG_LAYOUT = Object.freeze({
  version: 0, bump: 1, mint: 2, creator: 34, exempt: 66, venues: 194, gateMint: 258, gateTokenProgram: 290, startedAt: 322, startSlot: 330, ruleCount: 338, rules: 339,
  titheRecipient: 535, swapBaseAmount: 567, vaultInitial: 575, volumeBought: 583, lastSlot: 591, slotTrades: 599, potatoHolder: 607, potatoSince: 639, turnSide: 647, turnTs: 648,
  oscEnergy: 656, oscEnergy2: 664, oscPhase: 672, oscTs: 680, reserved: 688, size: HOOK_CONFIG_SIZE,
});
export const WALLET_STATE_LAYOUT = Object.freeze({ version: 0, bump: 1, firstReceiptTs: 2, receivedTotal: 10, reserved: 18, size: WALLET_STATE_SIZE });
export const ALLOW_ENTRY_LAYOUT = Object.freeze({ version: 0, bump: 1, mint: 2, wallet: 34, size: ALLOW_ENTRY_SIZE });
export const BLOCKLIST_LAYOUT = Object.freeze({ version: 0, bump: 1, count: 2, padding: 3, wallets: 8, max: BLOCKLIST_MAX, size: BLOCKLIST_SIZE });
export const INIT_CONFIG_LAYOUT = Object.freeze({ exempt: 0, venues: 128, gateMint: 192, gateTokenProgram: 224, titheRecipient: 256, swapBaseAmount: 288, ruleCount: 296, rules: 297, size: INIT_CONFIG_ARGS_LEN });
export const TURN_SIDES = Object.freeze({ 0: 'none', 1: 'buy', 2: 'sell' });

// ---- rule kinds and shapes ---------------------------------------------------------------
export const KIND = Object.freeze(Object.fromEntries(HOOK_RULES.map(r => [r.id, r.kind])));
const pascal = id => id.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join('');

/** Program error codes: 6000 + kind per rule (name = PascalCase rule id, title = catalogue name, message = the catalogue's rule text),
 *  structural codes from 6100 (contracts/curve-transfer-hook/src/errors.rs). */
export const HOOK_ERRORS = Object.freeze(Object.fromEntries([
  ...[...HOOK_RULES].sort((a, b) => a.kind - b.kind).map(r => [6000 + r.kind, pascal(r.id), r.rule, r.id, r.name]),
  [6100, 'WalletNotRegistered', 'This wallet has no record for the coin yet; register it first.'],
  [6101, 'NotAllowed', 'Only the coin\'s creator can do this.'],
  [6102, 'ConfigMismatch', 'The coin\'s hook configuration is missing or invalid.'],
  [6103, 'BadAccounts', 'The transfer did not carry the accounts the hook program expects.'],
  [6104, 'NotTransferring', 'The hook program can only run inside a Token-2022 transfer.'],
  [6105, 'Overflow', 'An amount in this transfer is too large.'],
  [6106, 'AlreadyInitialized', 'This hook account already exists.'],
  [6107, 'BlocklistFull', 'The blocklist can hold at most 200 wallets.'],
  [6108, 'LaunchStarted', 'The first trade has happened; the blocklist is sealed.'],
  [6109, 'BadSysvar', 'The transaction did not carry the instructions sysvar the hook program expects.'],
].map(([code, name, message, ruleId = null, title = null]) => [code, Object.freeze({ code, name, message, ruleId, title })])));
/** The error code a rule of `kind` (1..27) fails with. */
export const hookErrorCodeForRule = kind => 6000 + Number(kind);

const kindOf = (rule, what = 'rule') => {
  if (typeof rule === 'number' || typeof rule === 'string' && /^\d+$/.test(rule)) return Number(rule);
  if (rule && typeof rule === 'object' && rule.kind !== undefined && rule.kind !== null) return Number(rule.kind);
  const id = typeof rule === 'string' ? rule : rule?.id;
  const item = id ? hookRuleById(id) : null;
  if (item) return item.kind;
  throw TypeError(`hook program: ${what} has no kind.`);
};

/** Which optional entries a rule set needs: `rules` is an array of { kind } or { id } (plan.rules, hook.rules or packed rules),
 *  or an already computed shape (returned as is). The count is the number of ExtraAccountMetaList entries (1..10). */
export function hookShape(rules) {
  if (rules && typeof rules === 'object' && !Array.isArray(rules) && typeof rules.count === 'number') return rules;
  if (!Array.isArray(rules)) throw TypeError('hook program: hookShape needs the rules array.');
  const kinds = new Set(rules.map(r => kindOf(r)));
  // The sysvar entry follows the catalogue's needsSysvar (sniper_fee_cap, tithe and, from v71.35, the two app-only rules).
  const sysvar = [...kinds].some(kind => hookRuleByKind(kind)?.needsSysvar === true), blocklist = kinds.has(KIND.blocklist), walletState = kinds.has(KIND.holder_vesting), allowlist = kinds.has(KIND.allowlist), holderGated = kinds.has(KIND.holder_gated);
  return Object.freeze({ sysvar, blocklist, walletState, allowlist, holderGated, count: 1 + sysvar + blocklist + 2 * walletState + allowlist + 4 * holderGated });
}

/** Execute account indices of a shape's entries (0 source, 1 mint, 2 destination, 3 authority, 4 the list, 5 config, then the
 *  present entries in order); `null` = not present; `accounts` = the number of accounts an Execute call carries. */
export function hookShapePositions(rulesOrShape) {
  const s = hookShape(rulesOrShape);
  let next = 6;
  const take = present => (present ? next++ : null);
  const sysvar = take(s.sysvar), blocklist = take(s.blocklist), srcWallet = take(s.walletState), dstWallet = take(s.walletState), allow = take(s.allowlist);
  const ataProgram = take(s.holderGated), gateTokenProgram = take(s.holderGated), gateMint = take(s.holderGated), gateAta = take(s.holderGated);
  return Object.freeze({ config: 5, sysvar, blocklist, srcWallet, dstWallet, allow, ataProgram, gateTokenProgram, gateMint, gateAta, accounts: next });
}

/** Size of the ExtraAccountMetaList account for a rule set (or a shape): 16 + 35 × count. */
export const extraMetasSize = rulesOrShape => EXTRA_METAS_HEADER_LEN + EXTRA_META_LEN * hookShape(rulesOrShape).count;

// ---- helpers ------------------------------------------------------------------
const pk = (value, what = 'public key') => {
  if (value instanceof PublicKey) return value;
  if (value && typeof value === 'object' && typeof value.toBase58 === 'function') return new PublicKey(value.toBase58());
  if (typeof value === 'string' || value instanceof Uint8Array || Array.isArray(value)) return new PublicKey(value);
  throw TypeError(`hook program: ${what} is missing.`);
};
const keyBytes = (value, what) => Buffer.from(pk(value, what).toBuffer());
const ZERO = Buffer.alloc(32);
const optionalKeyBytes = (value, what) => (value === undefined || value === null ? Buffer.from(ZERO) : keyBytes(value, what));
const U64_MAX = (1n << 64n) - 1n;
const toBigU64 = (value, what) => {
  let n;
  try { n = typeof value === 'bigint' ? value : BigInt(typeof value === 'number' ? Math.trunc(value) : String(value).trim()); } catch { throw RangeError(`hook program: ${what} is not a whole number.`); }
  if (n < 0n || n > U64_MAX) throw RangeError(`hook program: ${what} must fit a u64.`);
  return n;
};
const u64le = (value, what) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(toBigU64(value, what)); return b; };
const u32le = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
const readU64 = (buf, off) => buf.readBigUInt64LE(off).toString();
const readI64 = (buf, off) => buf.readBigInt64LE(off).toString();
const readKey = (buf, off) => new PublicKey(buf.subarray(off, off + 32)).toBase58();
const asBuffer = (value, what) => {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array || Array.isArray(value)) return Buffer.from(value);
  if (value && value.data) return asBuffer(value.data, what);
  throw TypeError(`hook program: ${what} must be a byte buffer.`);
};
const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });

// ---- PDAs -------------------------------------------------------------------------
const pda = (programId, seeds) => {
  const program = pk(programId, 'program id');
  const [key, bump] = PublicKey.findProgramAddressSync(seeds, program);
  return { address: key.toBase58(), bump, key, seeds };
};
/** HookConfig PDA ["config", mint]. */
export const hookConfigPda = (programId, mint) => pda(programId, [Buffer.from(SEEDS.config), keyBytes(mint, 'mint')]);
/** WalletState PDA ["wallet", mint, owner]. */
export const walletStatePda = (programId, mint, owner) => pda(programId, [Buffer.from(SEEDS.wallet), keyBytes(mint, 'mint'), keyBytes(owner, 'wallet owner')]);
/** AllowEntry PDA ["allow", mint, wallet]. */
export const allowEntryPda = (programId, mint, wallet) => pda(programId, [Buffer.from(SEEDS.allow), keyBytes(mint, 'mint'), keyBytes(wallet, 'wallet')]);
/** BlockList PDA ["block", mint]. */
export const blocklistPda = (programId, mint) => pda(programId, [Buffer.from(SEEDS.block), keyBytes(mint, 'mint')]);
/** ExtraAccountMetaList PDA ["extra-account-metas", mint] (the Token-2022 standard). */
export const extraMetasPda = (programId, mint) => pda(programId, [Buffer.from(SEEDS.extraMetas), keyBytes(mint, 'mint')]);
/** The associated token account of `owner` for `mint` under `tokenProgram` (the gate ATA an Execute call reads). */
export const associatedTokenAddress = (owner, mint, tokenProgram) => pda(ASSOCIATED_TOKEN_PROGRAM_ID, [keyBytes(owner, 'owner'), keyBytes(tokenProgram, 'token program'), keyBytes(mint, 'mint')]);

// ---- instruction data ---------------------------------------------------------
/** The 16-byte Execute payload Token-2022 sends: discriminator ++ amount u64. */
export const executeData = amount => Buffer.concat([EXECUTE_DISCRIMINATOR, u64le(amount, 'amount')]);

/** Validates and packs the rules array for InitConfig: [{ kind 1..27, params: [6 decimal strings] }] (1..4 entries, no duplicate
 *  kinds, no catalogue conflict pair) → rule_count u8 ++ 4 × { kind u8, params[6] u64 } (197 bytes). */
export function packRules(rules) {
  if (!Array.isArray(rules) || rules.length < 1 || rules.length > MAX_RULES) throw RangeError(`hook program: choose 1 to ${MAX_RULES} rules.`);
  const out = Buffer.alloc(1 + MAX_RULES * RULE_LEN);
  out[0] = rules.length;
  const kinds = [];
  rules.forEach((rule, i) => {
    const kind = Number(rule?.kind);
    if (!Number.isInteger(kind) || kind < 1 || kind > MAX_KIND) throw RangeError(`hook program: rule kind must be 1..${MAX_KIND}.`);
    if (kinds.includes(kind)) throw RangeError('hook program: a rule kind is listed twice.');
    const item = hookRuleByKind(kind);
    for (const other of kinds) if (item && hookRulesConflict(item.id, hookRuleByKind(other).id)) throw RangeError(`hook program: ${item.name} cannot be combined with ${hookRuleByKind(other).name}.`);
    kinds.push(kind);
    const params = Array.isArray(rule.params) ? rule.params : [];
    if (params.length !== HOOK_PARAM_COUNT) throw RangeError(`hook program: every rule carries exactly ${HOOK_PARAM_COUNT} parameters.`);
    const p = 1 + i * RULE_LEN;
    out[p] = kind;
    params.forEach((value, j) => u64le(value, `rule ${kind} parameter ${j}`).copy(out, p + 1 + j * 8));
  });
  return out;
}

/** The 493-byte InitConfig payload (after the tag): exempt[4][32], venues[2][32], gate_mint[32], gate_token_program[32],
 *  tithe_recipient[32], swap_base_amount u64, rule_count u8, rules[4]{kind u8, params[6] u64}. Mirrors the program's checks:
 *  venues[0] required, gate keys with holder_gated, a recipient with tithe, a nonzero swapBaseAmount with sliding_caps. */
export function initConfigData({ exempt = [], venues = [], gateMint = null, gateTokenProgram = null, titheRecipient = null, swapBaseAmount = 0, rules } = {}) {
  if (!Array.isArray(exempt) || exempt.length > 4) throw RangeError('hook program: at most four exempt keys.');
  if (!Array.isArray(venues) || venues.length < 1 || venues.length > 2) throw RangeError('hook program: one or two venues.');
  const parts = [];
  for (let i = 0; i < 4; i++) parts.push(optionalKeyBytes(exempt[i], `exempt key ${i}`));
  for (let i = 0; i < 2; i++) parts.push(optionalKeyBytes(venues[i], `venue ${i}`));
  if (parts[4].equals(ZERO)) throw RangeError('hook program: the first venue (the pool\'s base vault) is required.');
  const gate = optionalKeyBytes(gateMint, 'gate mint'), gateProgram = optionalKeyBytes(gateTokenProgram, 'gate token program'), tithe = optionalKeyBytes(titheRecipient, 'tithe recipient');
  const base = u64le(swapBaseAmount ?? 0, 'swap base amount');
  const packed = packRules(rules);
  const kinds = new Set(rules.map(r => Number(r.kind)));
  if (kinds.has(KIND.holder_gated) && (gate.equals(ZERO) || gateProgram.equals(ZERO))) throw RangeError('hook program: the holder-gated rule needs the gate mint and its token program.');
  if (kinds.has(KIND.tithe) && tithe.equals(ZERO)) throw RangeError('hook program: the tithe rule needs the recipient wallet.');
  if (kinds.has(KIND.sliding_caps) && base.equals(Buffer.alloc(8))) throw RangeError('hook program: the sliding caps rule needs the curve\'s swap base amount.');
  const data = Buffer.concat([...parts, gate, gateProgram, tithe, base, packed]);
  if (data.length !== INIT_CONFIG_ARGS_LEN) throw Error('hook program: InitConfig layout error.');
  return data;
}

// ---- instruction builders -------------------------------------------------------
/** Tag 0. Accounts: extra-metas PDA (w), mint, authority (signer: the creator), system program, payer (signer, w), config PDA.
 *  Data: [0]. Must follow InitConfig: the program derives the list's shape and copies the gate keys from the config. */
export function initializeExtraAccountMetaList({ programId, mint, authority, payer }) {
  const program = pk(programId, 'program id'), base = pk(mint, 'mint');
  return {
    programId: program,
    keys: [
      meta(extraMetasPda(program, base).key, false, true),
      meta(base, false, false),
      meta(pk(authority, 'authority'), true, false),
      meta(SYSTEM_PROGRAM_ID, false, false),
      meta(pk(payer, 'payer'), true, true),
      meta(hookConfigPda(program, base).key, false, false),
    ],
    data: Buffer.from([INSTRUCTION_TAGS.initializeExtraAccountMetaList]),
  };
}

/** Tag 1. Accounts: config PDA (w), mint, creator (signer), payer (signer, w), system program. Data: [1] ++ initConfigData (494 bytes). Fails if the config exists. */
export function initConfig({ programId, mint, creator, payer, exempt, venues, gateMint, gateTokenProgram, titheRecipient, swapBaseAmount, rules }) {
  const program = pk(programId, 'program id'), base = pk(mint, 'mint');
  return {
    programId: program,
    keys: [
      meta(hookConfigPda(program, base).key, false, true),
      meta(base, false, false),
      meta(pk(creator, 'creator'), true, false),
      meta(pk(payer, 'payer'), true, true),
      meta(SYSTEM_PROGRAM_ID, false, false),
    ],
    data: Buffer.concat([Buffer.from([INSTRUCTION_TAGS.initConfig]), initConfigData({ exempt, venues, gateMint, gateTokenProgram, titheRecipient, swapBaseAmount, rules })]),
  };
}

/** Tag 2. Accounts: config, creator (signer), payer (signer, w), allow PDA (w), system program. Data: [2] ++ wallet[32]. Idempotent. */
export function addAllowed({ programId, mint, creator, payer, wallet }) {
  const program = pk(programId, 'program id'), base = pk(mint, 'mint'), who = pk(wallet, 'wallet');
  return {
    programId: program,
    keys: [
      meta(hookConfigPda(program, base).key, false, false),
      meta(pk(creator, 'creator'), true, false),
      meta(pk(payer, 'payer'), true, true),
      meta(allowEntryPda(program, base, who).key, false, true),
      meta(SYSTEM_PROGRAM_ID, false, false),
    ],
    data: Buffer.concat([Buffer.from([INSTRUCTION_TAGS.addAllowed]), who.toBuffer()]),
  };
}

/** Tag 3. Accounts: config, creator (signer), allow PDA (w), refund wallet (w). Data: [3]. Closes the entry and refunds its lamports. */
export function removeAllowed({ programId, mint, creator, wallet, refundTo }) {
  const program = pk(programId, 'program id'), base = pk(mint, 'mint');
  return {
    programId: program,
    keys: [
      meta(hookConfigPda(program, base).key, false, false),
      meta(pk(creator, 'creator'), true, false),
      meta(allowEntryPda(program, base, pk(wallet, 'wallet')).key, false, true),
      meta(pk(refundTo ?? creator, 'refund wallet'), false, true),
    ],
    data: Buffer.from([INSTRUCTION_TAGS.removeAllowed]),
  };
}

/** Tag 4. Accounts: config, wallet (the owner; need not sign), payer (signer, w), wallet-state PDA (w), system program. Data: [4]. Idempotent. */
export function registerWallet({ programId, mint, wallet, payer }) {
  const program = pk(programId, 'program id'), base = pk(mint, 'mint'), who = pk(wallet, 'wallet');
  return {
    programId: program,
    keys: [
      meta(hookConfigPda(program, base).key, false, false),
      meta(who, false, false),
      meta(pk(payer, 'payer'), true, true),
      meta(walletStatePda(program, base, who).key, false, true),
      meta(SYSTEM_PROGRAM_ID, false, false),
    ],
    data: Buffer.from([INSTRUCTION_TAGS.registerWallet]),
  };
}

/** Tag 5. Accounts: config, creator (signer), payer (signer, w), block PDA (w), system program. Data: [5, n] ++ n × wallet[32]
 *  (1 ≤ n ≤ 28). Creates the BlockList on first use, appends (listed wallets are skipped), refuses more than 200 entries
 *  (6107) and anything after the first trade (6108). */
export function addBlocked({ programId, mint, creator, payer, wallets }) {
  const program = pk(programId, 'program id'), base = pk(mint, 'mint');
  if (!Array.isArray(wallets) || wallets.length < 1 || wallets.length > BLOCKLIST_BATCH) throw RangeError(`hook program: AddBlocked takes 1 to ${BLOCKLIST_BATCH} wallets.`);
  const keys = wallets.map((w, i) => keyBytes(w, `blocked wallet ${i}`));
  if (keys.some(k => k.equals(ZERO))) throw RangeError('hook program: a blocked wallet cannot be the zero address.');
  return {
    programId: program,
    keys: [
      meta(hookConfigPda(program, base).key, false, false),
      meta(pk(creator, 'creator'), true, false),
      meta(pk(payer, 'payer'), true, true),
      meta(blocklistPda(program, base).key, false, true),
      meta(SYSTEM_PROGRAM_ID, false, false),
    ],
    data: Buffer.concat([Buffer.from([INSTRUCTION_TAGS.addBlocked, keys.length]), ...keys]),
  };
}

// ---- ExtraAccountMetaList TLV -------------------------------------------------------
// Seed encodings (spl-tlv-account-resolution): literal [1, len, bytes], instruction
// data [2, index, len], account key [3, index], account data [4, index, offset, len].
// Execute account indices: 0 source, 1 mint, 2 destination, 3 authority, 4 this
// list, 5 the config, 6.. the present entries in list order (hookShapePositions).
const seedLiteral = text => Buffer.concat([Buffer.from([1, text.length]), Buffer.from(text)]);
const seedAccountKey = index => Buffer.from([3, index]);
const seedAccountData = (index, offset, len) => Buffer.from([4, index, offset, len]);
const addressConfig = parts => { const cfg = Buffer.concat(parts); if (cfg.length > 32) throw Error('hook program: seed list too long.'); return Buffer.concat([cfg, Buffer.alloc(32 - cfg.length)]); };
const entry = (discriminator, config, isWritable) => Buffer.concat([Buffer.from([discriminator]), config, Buffer.from([0, isWritable ? 1 : 0])]);
export const EXTRA_META_DISCRIMINATORS = Object.freeze({ literal: 0, hookPda: 1, externalPdaBase: 128 });

/** The exact bytes of the ExtraAccountMetaList account for a rule set (or an explicit `shape`): config first, then the
 *  instructions sysvar, the BlockList, the two WalletStates, the AllowEntry and the four gate accounts, each only when the
 *  shape needs it. A holder-gated shape needs the gate token program and the gate mint (literal entries); the gate ATA's
 *  external-PDA discriminator and key() seeds use the actual instruction indices of the three literal entries. */
export function extraAccountMetaListBytes({ rules = null, shape = null, gateTokenProgram = null, gateMint = null } = {}) {
  const s = shape ? hookShape(shape) : hookShape(rules), pos = hookShapePositions(s);
  const entries = [entry(1, addressConfig([seedLiteral(SEEDS.config), seedAccountKey(1)]), true)];
  if (s.sysvar) entries.push(entry(0, Buffer.from(SYSVAR_INSTRUCTIONS_ID.toBuffer()), false));
  if (s.blocklist) entries.push(entry(1, addressConfig([seedLiteral(SEEDS.block), seedAccountKey(1)]), false));
  if (s.walletState) {
    entries.push(entry(1, addressConfig([seedLiteral(SEEDS.wallet), seedAccountKey(1), seedAccountData(0, 32, 32)]), true));
    entries.push(entry(1, addressConfig([seedLiteral(SEEDS.wallet), seedAccountKey(1), seedAccountData(2, 32, 32)]), true));
  }
  if (s.allowlist) entries.push(entry(1, addressConfig([seedLiteral(SEEDS.allow), seedAccountKey(1), seedAccountData(2, 32, 32)]), false));
  if (s.holderGated) {
    if (!gateTokenProgram || !gateMint) throw TypeError('hook program: the holder-gated list needs gateTokenProgram and gateMint.');
    entries.push(
      entry(0, Buffer.from(ASSOCIATED_TOKEN_PROGRAM_ID.toBuffer()), false),
      entry(0, keyBytes(gateTokenProgram, 'gate token program'), false),
      entry(0, keyBytes(gateMint, 'gate mint'), false),
      entry(128 + pos.ataProgram, addressConfig([seedAccountData(2, 32, 32), seedAccountKey(pos.gateTokenProgram), seedAccountKey(pos.gateMint)]), false),
    );
  }
  if (entries.length !== s.count) throw Error('hook program: shape layout error.');
  const body = Buffer.concat(entries);
  return Buffer.concat([EXECUTE_DISCRIMINATOR, u32le(4 + body.length), u32le(entries.length), body]);
}

/** Decodes an ExtraAccountMetaList account into its entries (for diagnostics and tests). */
export function decodeExtraAccountMetaList(buffer) {
  const buf = asBuffer(buffer, 'extra account meta list');
  if (buf.length < EXTRA_METAS_HEADER_LEN || !buf.subarray(0, 8).equals(EXECUTE_DISCRIMINATOR)) throw Error('hook program: not an ExtraAccountMetaList.');
  const count = buf.readUInt32LE(12), entries = [];
  if (buf.readUInt32LE(8) !== 4 + count * EXTRA_META_LEN || buf.length < EXTRA_METAS_HEADER_LEN + count * EXTRA_META_LEN) throw Error('hook program: ExtraAccountMetaList length mismatch.');
  for (let i = 0; i < count; i++) {
    const p = EXTRA_METAS_HEADER_LEN + i * EXTRA_META_LEN, discriminator = buf[p], config = buf.subarray(p + 1, p + 33);
    entries.push({ discriminator, address: discriminator === 0 ? new PublicKey(config).toBase58() : null, addressConfig: Buffer.from(config).toString('hex'), isSigner: buf[p + 33] === 1, isWritable: buf[p + 34] === 1 });
  }
  return entries;
}

// ---- account decoders -------------------------------------------------------------------
/** HookConfig (752 bytes) → plain object; 64-bit values are decimal strings, keys base58. Throws on size/version mismatch. */
export function decodeHookConfig(buffer) {
  const d = asBuffer(buffer, 'HookConfig'), L = HOOK_CONFIG_LAYOUT;
  if (d.length !== L.size || d[L.version] !== HOOK_LAYOUT_VERSION) throw Error('hook program: not a HookConfig account.');
  const ruleCount = d[L.ruleCount];
  if (ruleCount > MAX_RULES) throw Error('hook program: HookConfig rule count is invalid.');
  if (d[L.turnSide] > 2) throw Error('hook program: HookConfig turn side is invalid.');
  const rules = [];
  for (let i = 0; i < ruleCount; i++) {
    const p = L.rules + i * RULE_LEN, kind = d[p], item = hookRuleByKind(kind);
    rules.push({ kind, id: item ? item.id : null, params: Array.from({ length: HOOK_PARAM_COUNT }, (_, j) => readU64(d, p + 1 + j * 8)) });
  }
  return {
    version: d[L.version], bump: d[L.bump], mint: readKey(d, L.mint), creator: readKey(d, L.creator),
    exempt: [0, 1, 2, 3].map(i => readKey(d, L.exempt + i * 32)), venues: [0, 1].map(i => readKey(d, L.venues + i * 32)),
    gateMint: readKey(d, L.gateMint), gateTokenProgram: readKey(d, L.gateTokenProgram),
    startedAt: readI64(d, L.startedAt), startSlot: readU64(d, L.startSlot), ruleCount, rules,
    titheRecipient: readKey(d, L.titheRecipient), swapBaseAmount: readU64(d, L.swapBaseAmount),
    vaultInitial: readU64(d, L.vaultInitial), volumeBought: readU64(d, L.volumeBought), lastSlot: readU64(d, L.lastSlot), slotTrades: readU64(d, L.slotTrades),
    potatoHolder: readKey(d, L.potatoHolder), potatoSince: readI64(d, L.potatoSince), turnSide: d[L.turnSide], turnSideName: TURN_SIDES[d[L.turnSide]], turnTs: readI64(d, L.turnTs),
    oscEnergy: readU64(d, L.oscEnergy), oscEnergy2: readU64(d, L.oscEnergy2), oscPhase: readU64(d, L.oscPhase), oscTs: readI64(d, L.oscTs),
    shape: hookShape(rules),
  };
}

/** WalletState (34 bytes) → { version, bump, firstReceiptTs, receivedTotal }. */
export function decodeWalletState(buffer) {
  const d = asBuffer(buffer, 'WalletState'), L = WALLET_STATE_LAYOUT;
  if (d.length !== L.size || d[L.version] !== HOOK_LAYOUT_VERSION) throw Error('hook program: not a WalletState account.');
  return { version: d[L.version], bump: d[L.bump], firstReceiptTs: readI64(d, L.firstReceiptTs), receivedTotal: readU64(d, L.receivedTotal) };
}

/** AllowEntry (66 bytes) → { version, bump, mint, wallet }. */
export function decodeAllowEntry(buffer) {
  const d = asBuffer(buffer, 'AllowEntry'), L = ALLOW_ENTRY_LAYOUT;
  if (d.length !== L.size || d[L.version] !== HOOK_LAYOUT_VERSION) throw Error('hook program: not an AllowEntry account.');
  return { version: d[L.version], bump: d[L.bump], mint: readKey(d, L.mint), wallet: readKey(d, L.wallet) };
}

/** BlockList (6408 bytes) → { version, bump, count, wallets: base58[] }. */
export function decodeBlocklist(buffer) {
  const d = asBuffer(buffer, 'BlockList'), L = BLOCKLIST_LAYOUT;
  if (d.length !== L.size || d[L.version] !== HOOK_LAYOUT_VERSION || d[L.count] > L.max) throw Error('hook program: not a BlockList account.');
  const count = d[L.count];
  return { version: d[L.version], bump: d[L.bump], count, wallets: Array.from({ length: count }, (_, i) => readKey(d, L.wallets + i * 32)) };
}

/** getProgramAccounts filters that list a coin's AllowEntry accounts (dataSize 66, mint at offset 2). */
export const allowEntryFilters = mint => [{ dataSize: ALLOW_ENTRY_SIZE }, { memcmp: { offset: ALLOW_ENTRY_LAYOUT.mint, bytes: pk(mint, 'mint').toBase58() } }];

// ---- Execute extra accounts ---------------------------------------------------------------
/** The extra accounts of an Execute call, in list order, for a transfer from `sourceOwner`'s token account to
 *  `destinationOwner`'s under the given rules (or shape): config (w), then — when the shape has them — the instructions
 *  sysvar, the BlockList, the source and destination WalletStates (w), the destination AllowEntry, the associated-token
 *  program, the gate token program, the gate mint and the destination owner's gate ATA. No program id and no list PDA:
 *  `hookRemainingAccounts` appends those. Accounts that do not exist are passed as empty accounts. */
export function resolveExecuteAccounts({ programId, mint, sourceOwner, destinationOwner, rules = null, shape = null, gateMint = null, gateTokenProgram = null }) {
  const program = pk(programId, 'program id'), base = pk(mint, 'mint'), from = pk(sourceOwner, 'source owner'), to = pk(destinationOwner, 'destination owner');
  if (!rules && !shape) throw TypeError('hook program: resolveExecuteAccounts needs the rules (or a shape).');
  const s = shape ? hookShape(shape) : hookShape(rules);
  const list = [meta(hookConfigPda(program, base).key, false, true)];
  if (s.sysvar) list.push(meta(SYSVAR_INSTRUCTIONS_ID, false, false));
  if (s.blocklist) list.push(meta(blocklistPda(program, base).key, false, false));
  if (s.walletState) list.push(meta(walletStatePda(program, base, from).key, false, true), meta(walletStatePda(program, base, to).key, false, true));
  if (s.allowlist) list.push(meta(allowEntryPda(program, base, to).key, false, false));
  if (s.holderGated) {
    if (!gateMint || !gateTokenProgram) throw TypeError('hook program: a holder-gated coin needs gateMint and gateTokenProgram to resolve its accounts.');
    const tokenProgram = pk(gateTokenProgram, 'gate token program'), gate = pk(gateMint, 'gate mint');
    list.push(meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false), meta(tokenProgram, false, false), meta(gate, false, false), meta(associatedTokenAddress(to, gate, tokenProgram).key, false, false));
  }
  if (list.length !== s.count) throw Error('hook program: shape layout error.');
  return list;
}

/** The N accounts a hooked DBC instruction carries for one transfer: resolveExecuteAccounts(...) followed by the hook program id and
 *  the ExtraAccountMetaList PDA (both readonly) — the block the SDK appends per transfer (`transferHookAccounts`). */
export function hookRemainingAccounts(args) {
  const program = pk(args.programId, 'program id'), base = pk(args.mint, 'mint');
  return [...resolveExecuteAccounts(args), meta(program, false, false), meta(extraMetasPda(program, base).key, false, false)];
}

// ---- errors -----------------------------------------------------------------------------------
const CUSTOM_IN_TEXT = /custom program error:\s*(0x[0-9a-f]+|\d+)/i;
const FAILED_PROGRAM_LINE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed: custom program error:\s*(0x[0-9a-f]+|\d+)/i;
const parseCode = text => Number.parseInt(text, /^0x/i.test(text) ? 16 : 10);
const codeFromText = text => { const m = CUSTOM_IN_TEXT.exec(text); return m ? parseCode(m[1]) : null; };
const collectLogs = (value, out = [], seen = new Set()) => {
  if (!value || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) { if (value.every(v => typeof v === 'string')) out.push(...value); else value.forEach(v => collectLogs(v, out, seen)); return out; }
  for (const key of ['logs', 'logMessages', 'value', 'err', 'error', 'data']) if (value[key] !== undefined) collectLogs(value[key], out, seen);
  return out;
};
/** The custom error code inside a simulation / send error (object, text, logs or number), or null. With `programId`, log lines
 *  decide which program failed: a custom code raised by another program (Anchor programs also count from 6000) is not ours. */
export function hookErrorCode(error, { programId = null } = {}) {
  if (programId) {
    const logs = typeof error === 'string' ? error.split('\n') : collectLogs(error);
    const failed = logs.map(line => FAILED_PROGRAM_LINE.exec(String(line).trim())).filter(Boolean);
    if (failed.length) {
      const ours = failed.find(m => m[1] === pk(programId, 'program id').toBase58());
      const code = ours ? parseCode(ours[2]) : null;
      return code !== null && HOOK_ERRORS[code] ? code : null;
    }
  }
  const seen = new Set();
  const walk = value => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isInteger(value) ? value : null;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string') { const direct = codeFromText(value); if (direct !== null) return direct; const asNumber = /^\d{4,5}$/.test(value.trim()) ? Number(value) : null; return asNumber; }
    if (typeof value !== 'object' || seen.has(value)) return null;
    seen.add(value);
    if (Array.isArray(value)) { for (const item of value) { const code = walk(item); if (code !== null) return code; } return null; }
    if (value.Custom !== undefined) return walk(value.Custom);
    if (value.custom !== undefined) return walk(value.custom);
    for (const key of ['InstructionError', 'err', 'error', 'code', 'customCode', 'logs', 'message', 'data']) {
      if (value[key] === undefined) continue;
      const found = key === 'InstructionError' && Array.isArray(value[key]) ? walk(value[key][1]) : walk(value[key]);
      if (found !== null) return found;
    }
    return null;
  };
  const code = walk(error);
  return code !== null && HOOK_ERRORS[code] ? code : null;
}
/** A plain sentence for a hook program error found in a simulation error (object or text), or null when the error is not one of ours. */
export function hookErrorMessage(error, options = {}) {
  const code = hookErrorCode(error, options);
  return code === null ? null : HOOK_ERRORS[code].message;
}
