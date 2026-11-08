// Wire layouts and read-only behavior reviewed against Jac0xb/lighthouse
// commit 4c579479c98635e419b1b167f08be02a71604a71:
// programs/lighthouse/src/{instruction.rs,lib.rs,macros.rs}, processor/assert_*,
// types/assert/{account_data,account_info,mint_account,token_account,
// assertion_result,log_level,operator}.rs and lighthouse-common/src/types/*.
// https://github.com/Jac0xb/lighthouse/tree/4c579479c98635e419b1b167f08be02a71604a71
// This validates message structure ONLY. Before co-signing an augmented message,
// the caller must independently verify the deployed executable against its
// reviewed program pin, resolve lookups from a trusted chain snapshot,
// verify the payer signature, and simulate with sigVerify.
// Read-only instruction metas inherit global privileges in Solana, so neither
// the program ID alone nor a caller-supplied readonly flag establishes safety.
import { PublicKey } from '@solana/web3.js';
export const LIGHTHOUSE_PROGRAM = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
// Phantom, Solflare and other wallets set their own priority fee and compute
// limit while signing. The developer wallet is always the fee payer, so these
// edits only change what that user pays. Bound them so a wallet bug cannot
// silently spend more than 0.01 SOL in priority fees on one launch step.
export const MAX_WALLET_PRIORITY_FEE_LAMPORTS = 10_000_000n;
const MAX_COMPUTE_UNITS = 1_400_000n;
const INSTRUCTIONS_SYSVAR = 'Sysvar1nstructions1111111111111111111111111';
const MAX_GUARDS = 16, MAX_GUARD_BYTES = 512, MAX_TOTAL_GUARD_BYTES = 1024;
// Phantom's balance guard snapshots an account into a Lighthouse memory PDA
// (MemoryWrite, before the reviewed instructions) and asserts the delta after
// them. The payer funds that PDA's rent, so its size and count are bounded:
// at most two memories of 1 KiB each (about 0.008 SOL rent apiece, refundable).
const MAX_MEMORIES = 2, MAX_MEMORY_BYTES = 1024n;
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const GUARD_KEY = `key:${LIGHTHOUSE_PROGRAM}`, SYSTEM_KEY = `key:${SYSTEM_PROGRAM}`;
const isGuard = ix => ix.program === GUARD_KEY;
const MAX_ASSERTIONS = 32, MAX_ACCOUNT_BYTES = 10485760n, MAX_HASH_BYTES = 1048576n;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const BUDGET_KEY = `key:${COMPUTE_BUDGET_PROGRAM}`;
const isBudget = ix => ix.program === BUDGET_KEY;
const reject = (reason, detail = '') => { throw Object.assign(new Error(`Wallet transaction validation failed (${reason}${detail ? '; ' + detail : ''}). This step was not submitted.`), { code: 'WALLET_TRANSACTION_REJECTED', walletValidationReason: reason, ...(detail ? { walletValidationDetail: detail } : {}) }); };
const check = (condition, reason) => { if (!condition) reject(reason); };
const byte = value => Number.isInteger(value) && value >= 0 && value <= 255;

// These diagnostics describe only fixed categories and bounded indexes/counts.
// Never include a key, instruction payload, transaction encoding or signature.
function instructionKind(ix) {
  if (!ix) return 'none';
  if (ix.program === `key:${LIGHTHOUSE_PROGRAM}`) return 'lighthouse';
  if (ix.program === 'key:ComputeBudget111111111111111111111111111111')
    return ({ 0: 'compute-units', 1: 'compute-heap', 2: 'compute-limit', 3: 'compute-price', 4: 'compute-data' })[ix.data[0]] || 'compute-other';
  return ({
    'key:11111111111111111111111111111111': 'system',
    'key:AddressLookupTab1e1111111111111111111111111': 'lookup',
    'key:ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL': 'associated-token',
    'key:TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA': 'token',
    'key:TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb': 'token-2022',
    'key:metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s': 'metadata',
  })[ix.program] || 'other';
}
const diagnosticNumber = value => Number.isInteger(value) && value >= 0 && value <= 999 ? String(value) : 'many';
// `counted` supplies the returned instruction total when `actual` is a filtered view;
// `guardOnly` describes a wallet-added instruction with no reviewed counterpart.
function instructionDiagnostic(expected, actual, index, compareAccounts = false, counted = actual, guardOnly = false) {
  const count = `n${diagnosticNumber(expected.instructions.length)}>${diagnosticNumber(counted.instructions.length)}`;
  if (index === undefined) {
    index = expected.instructions.findIndex((before, i) => {
      const after = actual.instructions[i];
      return !after || before.program !== after.program || !before.data.equals(after.data);
    });
    if (index < 0 && actual.instructions.length > expected.instructions.length) index = expected.instructions.length;
    if (index < 0) return `layout; ${count}`;
  }
  const before = guardOnly ? undefined : expected.instructions[index], after = actual.instructions[index];
  const field = !before ? 'added' : !after ? 'removed' : before.program !== after.program ? 'program' : !before.data.equals(after.data) ? 'data' : compareAccounts && !same(before.keys, after.keys) ? 'accounts' : 'layout';
  return `ix${diagnosticNumber(index)} ${field} ${instructionKind(before)}>${instructionKind(after)}; ${count}`;
}

function address(key) {
  const value = key?.toBase58?.();
  check(typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) && key.toBytes?.().length === 32, 'invalid account key');
  return value;
}

function messageView(message) {
  check(message?.version === 0 && Array.isArray(message.staticAccountKeys) && Array.isArray(message.addressTableLookups) && Array.isArray(message.compiledInstructions), 'unsupported message');
  const keys = message.staticAccountKeys.map(address), h = message.header;
  check(keys.length > 0 && keys.length <= 256 && h && [h.numRequiredSignatures, h.numReadonlySignedAccounts, h.numReadonlyUnsignedAccounts].every(byte), 'invalid account permissions');
  check(h.numRequiredSignatures > 0 && h.numRequiredSignatures <= keys.length && h.numReadonlySignedAccounts < h.numRequiredSignatures && h.numReadonlyUnsignedAccounts <= keys.length - h.numRequiredSignatures, 'invalid account permissions');
  check(new Set(keys).size === keys.length, 'duplicate account keys');
  const lookups = message.addressTableLookups.map(table => {
    check(table && (Array.isArray(table.writableIndexes) || table.writableIndexes instanceof Uint8Array) && (Array.isArray(table.readonlyIndexes) || table.readonlyIndexes instanceof Uint8Array), 'invalid address lookups');
    const writable = Array.from(table.writableIndexes), readonly = Array.from(table.readonlyIndexes);
    check([...writable, ...readonly].every(byte) && new Set([...writable, ...readonly]).size === writable.length + readonly.length, 'duplicate address lookup indexes');
    return [address(table.accountKey), writable, readonly];
  });
  check(new Set(lookups.map(row => row[0])).size === lookups.length, 'duplicate address lookups');
  const accounts = keys.map((key, index) => ({
    key: `key:${key}`, address: key, signer: index < h.numRequiredSignatures,
    writable: index < h.numRequiredSignatures ? index < h.numRequiredSignatures - h.numReadonlySignedAccounts : index < keys.length - h.numReadonlyUnsignedAccounts,
  }));
  // Without trusted resolution, identity is the complete table/index binding.
  // With evidence, resolveView replaces these identities with concrete keys.
  for (const writable of [true, false]) for (const [table, writes, reads] of lookups) for (const index of writable ? writes : reads)
    accounts.push({ key: `lookup:${table}:${index}`, table, index, signer: false, writable });
  check(accounts.length <= 256, 'too many accounts');
  const account = index => { check(byte(index) && index < accounts.length, 'invalid instruction account index'); return accounts[index]; };
  const instructions = message.compiledInstructions.map(ix => {
    check(ix && (Array.isArray(ix.accountKeyIndexes) || ix.accountKeyIndexes instanceof Uint8Array) && ix.data instanceof Uint8Array, 'invalid instruction');
    const program = account(ix.programIdIndex);
    check(ix.programIdIndex < keys.length && !program.signer && !program.writable, 'invalid instruction program');
    return { program: program.key, keys: Array.from(ix.accountKeyIndexes, index => account(index).key), data: Buffer.from(ix.data) };
  });
  return { keys, accounts, lookups, instructions, signers: keys.slice(0, h.numRequiredSignatures), payer: keys[0], blockhash: message.recentBlockhash };
}

class GuardReader {
  constructor(data) { this.data = data; this.offset = 0; }
  take(length) { check(Number.isSafeInteger(length) && length >= 0 && this.offset + length <= this.data.length, 'truncated wallet guard'); this.offset += length; }
  u8() { this.take(1); return this.data[this.offset - 1]; }
  u16() { this.take(2); return this.data.readUInt16LE(this.offset - 2); }
  bool() { check(this.u8() <= 1, 'invalid wallet guard boolean'); }
  operator(integer = false) { check(this.u8() <= (integer ? 7 : 1), 'invalid wallet guard operator'); }
  optional(length) { const tag = this.u8(); check(tag <= 1, 'invalid wallet guard option'); if (tag) this.take(length); }
  compact(limit) {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      const next = this.u8(), payload = next & 127;
      check(i < 9 || payload <= 1, 'invalid wallet guard integer');
      value |= BigInt(payload) << BigInt(i * 7);
      if (!(next & 128)) {
        check(i === 0 || payload !== 0, 'noncanonical wallet guard integer');
        check(value <= limit, 'wallet guard limit exceeded');
        return value;
      }
    }
    reject('invalid wallet guard integer');
  }
}

function accountData(r) {
  r.compact(MAX_ACCOUNT_BYTES);
  const kind = r.u8(), sizes = [1, 1, 1, 2, 2, 4, 4, 8, 8, 16, 16];
  if (kind === 0) { r.bool(); r.operator(); }
  else if (kind < sizes.length) { r.take(sizes[kind]); r.operator(true); }
  else if (kind === 11) { r.take(Number(r.compact(BigInt(MAX_GUARD_BYTES)))); r.operator(); }
  else if (kind === 12) { r.take(32); r.operator(); }
  else reject('unsupported wallet guard assertion');
}
function accountInfo(r) {
  const kind = r.u8();
  if ([0, 1, 4].includes(kind)) { r.take(8); r.operator(true); }
  else if (kind === 2) { r.take(32); r.operator(); }
  else if (kind === 3) { check(r.u8() <= 8, 'invalid wallet guard known owner'); r.operator(); }
  else if ([5, 6, 7].includes(kind)) { r.bool(); r.operator(); }
  else if (kind === 8) { r.take(32); r.compact(MAX_ACCOUNT_BYTES); r.compact(MAX_HASH_BYTES); }
  else reject('unsupported wallet guard assertion');
}
function mintAccount(r) {
  const kind = r.u8();
  if (kind === 0 || kind === 4) { r.optional(32); r.operator(); }
  else if (kind === 1 || kind === 2) { r.take(kind === 1 ? 8 : 1); r.operator(true); }
  else if (kind === 3) { r.bool(); r.operator(); }
  else reject('unsupported wallet guard assertion');
}
function tokenAccount(r) {
  const kind = r.u8();
  if (kind === 0 || kind === 1) { r.take(32); r.operator(); }
  else if (kind === 2 || kind === 6) { r.take(8); r.operator(true); }
  else if (kind === 3 || kind === 7) { r.optional(32); r.operator(); }
  else if (kind === 4) { r.take(1); r.operator(true); }
  else if (kind === 5) { r.optional(8); r.operator(); }
  else if (kind !== 8) reject('unsupported wallet guard assertion');
}

// WriteType (programs/lighthouse/src/types/write): returns the written length.
function writeType(r) {
  const kind = r.u8();
  if (kind === 0) { r.u16(); return BigInt(r.u16()); }                                   // AccountData { offset, data_length }
  if (kind === 1) { const field = r.u8(); check(field <= 5, 'unsupported wallet guard write'); return [32n, 8n, 8n, 32n, 8n, 1n][field]; }   // AccountInfoField
  if (kind === 2) {                                                                        // DataValue
    const value = r.u8(), sizes = [1, 1, 1, 2, 2, 4, 4, 8, 8, 16, 16];
    if (value < sizes.length) { r.take(sizes[value]); return BigInt(sizes[value]); }
    if (value === 11) { const length = r.compact(MAX_MEMORY_BYTES); r.take(Number(length)); return length; }   // Bytes (LEB128 length)
    if (value === 12) { r.take(32); return 32n; }                                          // Pubkey
    reject('unsupported wallet guard write');
  }
  if (kind === 3) { check(r.u8() <= 4, 'unsupported wallet guard write'); return 8n; }   // ClockField
  reject('unsupported wallet guard write');
}
// AccountDeltaAssertion (types/assert/account_delta.rs): read-only comparison of a memory snapshot with a live account.
function accountDelta(r) {
  const kind = r.u8();
  if (kind === 0) {                                                                        // AccountInfo { a_offset, assertion }
    r.compact(MAX_MEMORY_BYTES); const assertion = r.u8();
    if ([0, 1, 3].includes(assertion)) { r.take(16); r.operator(true); }                 // Lamports | DataLength | RentEpoch { i128, IntegerOperator }
    else if (assertion === 2) r.operator();                                               // Owner { EquatableOperator }
    else reject('unsupported wallet guard assertion');
  } else if (kind === 1) {                                                                 // Data { a_offset, b_offset, assertion }
    r.compact(MAX_MEMORY_BYTES); r.compact(MAX_ACCOUNT_BYTES); const assertion = r.u8(), sizes = [2, 2, 4, 4, 8, 8, 16, 16];
    if (assertion < sizes.length) { r.take(sizes[assertion]); r.operator(true); }
    else if (assertion === 8) { r.u16(); r.operator(); }                                   // Bytes { length, EquatableOperator }
    else reject('unsupported wallet guard assertion');
  } else reject('unsupported wallet guard assertion');
}
function memoryAddress(payer, memoryId, bump) {
  try { return PublicKey.createProgramAddressSync([Buffer.from('memory'), new PublicKey(payer).toBuffer(), Buffer.from([memoryId]), Buffer.from([bump])], new PublicKey(LIGHTHOUSE_PROGRAM)).toBase58(); }
  catch { return null; }
}
/**
 * Decode one Lighthouse instruction a wallet added and bound every byte of it.
 * Returns { kind, memory } where kind is 'assert' (one target account, read-only),
 * 'memory-write' / 'memory-close' (the payer's own memory PDA) or 'delta'
 * (read-only comparison against such a memory). `payer` is the reviewed fee payer.
 */
function guardInstruction(ix, payer) {
  check(ix.program === GUARD_KEY, 'unsupported appended program');
  check(ix.data.length >= 3 && ix.data.length <= MAX_GUARD_BYTES, 'invalid wallet guard size');
  const r = new GuardReader(ix.data), opcode = r.u8();
  if (opcode === 0 || opcode === 1) {
    // MemoryWrite { memory_id, memory_bump, write_offset, write_type } with accounts
    // [lighthouse, system, payer(signer,writable), memory(writable), source]; MemoryClose
    // { memory_id, memory_bump } with [lighthouse, payer, memory]. Only the reviewed fee
    // payer may fund or be refunded, and only its own bounded Lighthouse memory PDA.
    const memoryId = r.u8(), bump = r.u8();
    const memory = memoryAddress(payer, memoryId, bump);
    check(memory, 'invalid wallet guard memory');
    const keys = opcode === 0 ? [GUARD_KEY, SYSTEM_KEY, `key:${payer}`, `key:${memory}`] : [GUARD_KEY, `key:${payer}`, `key:${memory}`];
    check(ix.keys.length === keys.length + (opcode === 0 ? 1 : 0) && keys.every((key, index) => ix.keys[index] === key), 'invalid wallet guard accounts');
    if (opcode === 0) { const offset = r.compact(MAX_MEMORY_BYTES), length = writeType(r); check(offset + length <= MAX_MEMORY_BYTES, 'wallet guard limit exceeded'); }
    check(r.offset === ix.data.length, 'trailing wallet guard bytes');
    return { kind: opcode === 0 ? 'memory-write' : 'memory-close', memory, memoryKey: `key:${memory}` };
  }
  const log = r.u8();
  // Borsh 0.10 enum wire indexes, not Rust repr discriminants. Modes 3 and 6
  // invoke SPL Noop; exclude them, along with unknown/future logging modes.
  check([0, 1, 2, 4, 5].includes(log), 'unsupported wallet guard logging');
  if (opcode === 4) {                                                                      // AssertAccountDelta [memory, target]
    check(ix.keys.length === 2, 'invalid wallet guard accounts');
    accountDelta(r);
    check(r.offset === ix.data.length, 'trailing wallet guard bytes');
    return { kind: 'delta', memoryKey: ix.keys[0] };
  }
  check(ix.keys.length === 1, 'invalid wallet guard accounts');
  const parser = ({ 2: accountData, 3: accountData, 5: accountInfo, 6: accountInfo, 7: mintAccount, 8: mintAccount, 9: tokenAccount, 10: tokenAccount })[opcode];
  check(parser, 'unsupported wallet guard instruction');
  const count = [3, 6, 8, 10].includes(opcode) ? Number(r.compact(BigInt(MAX_ASSERTIONS))) : 1;
  check(count > 0, 'empty wallet guard');
  for (let i = 0; i < count; i++) parser(r);
  check(r.offset === ix.data.length, 'trailing wallet guard bytes');
  return { kind: 'assert' };
}

/**
 * Decode the compute-budget instructions a wallet returned. Only a unit limit
 * and unit price may be wallet-chosen; any other budget instruction must be
 * byte-identical to one the reviewed message already contained.
 */
function computeBudget(view, reviewed = null) {
  let limit = null, price = 0n;
  const seen = new Set();
  for (const ix of view.instructions.filter(isBudget)) {
    check(ix.keys.length === 0 && ix.data.length >= 1, 'unsupported compute budget instruction');
    const kind = ix.data[0];
    check(!seen.has(kind), 'duplicate compute budget instruction');
    seen.add(kind);
    if (kind === 2) {
      check(ix.data.length === 5, 'unsupported compute budget instruction');
      limit = BigInt(ix.data.readUInt32LE(1));
      check(limit > 0n && limit <= MAX_COMPUTE_UNITS, 'compute limit out of bounds');
    } else if (kind === 3) {
      check(ix.data.length === 9, 'unsupported compute budget instruction');
      price = ix.data.readBigUInt64LE(1);
    } else {
      check(reviewed && reviewed.some(row => row.data.equals(ix.data)), 'unsupported compute budget instruction');
    }
  }
  // Without an explicit limit, assume the runtime maximum for the fee bound.
  const units = limit ?? MAX_COMPUTE_UNITS;
  return { fee: (price * units + 999_999n) / 1_000_000n };
}
const budgetLayout = view => view.instructions.map((ix, index) => isBudget(ix) ? [index, ix.data.toString('hex')] : null).filter(Boolean);
const coreView = (view, budget) => budget ? { ...view, instructions: view.instructions.filter(ix => !isBudget(ix)) } : view;

/**
 * Accept exact v0 messages, or the exact original instructions in their original
 * order with bounded, decoded Lighthouse guard instructions before, between or
 * after them: read-only assertions on existing accounts, and the payer's own
 * Lighthouse memory snapshot (MemoryWrite / MemoryClose) with read-only delta
 * assertions against it, which is how Phantom guards the fee payer's balance.
 * No RPC or signing occurs here. Throws only bounded, signature-free diagnostics.
 * For changed ALT layouts, resolvedTables must be trusted chain evidence for the
 * exact union of original and returned table keys, never wallet-supplied state.
 * The explicit equivalent-recompile option also permits a different v0 account
 * layout with the same ordered instructions and effective account privileges.
 * The explicit compute-budget option lets the wallet add, move or change its
 * own SetComputeUnitLimit/SetComputeUnitPrice instructions (the fee payer is
 * unchanged), bounded by maxPriorityFeeLamports. Every other original
 * instruction keeps its order, program, accounts and data.
 */
export function validateWalletMessage(expectedMessage, submittedMessage, { resolvedTables, allowEquivalentRecompile = false, allowComputeBudget = false, maxPriorityFeeLamports = MAX_WALLET_PRIORITY_FEE_LAMPORTS } = {}) {
  let expected = messageView(expectedMessage), actual = messageView(submittedMessage);
  const budget = allowComputeBudget === true;
  // Avoid serializing oversized guard payloads before their bounded parser has
  // rejected them. The caller separately enforces canonical wire size/encoding.
  if (expected.instructions.length === actual.instructions.length) {
    let equal;
    try { equal = Buffer.from(expectedMessage.serialize()).equals(Buffer.from(submittedMessage.serialize())); }
    catch { reject('invalid message encoding'); }
    if (equal) return { changed: false, guardCount: 0 };
  }
  check(expected.payer === actual.payer, 'fee payer changed');
  check(expected.blockhash === actual.blockhash, 'blockhash changed');
  check(same(expected.signers, actual.signers), 'signer set changed');
  let budgetChanged = false;
  if (budget) {
    const reviewed = expected.instructions.filter(isBudget);
    const original = computeBudget(expected, reviewed), returned = computeBudget(actual, reviewed);
    const cap = typeof maxPriorityFeeLamports === 'bigint' && maxPriorityFeeLamports >= 0n ? maxPriorityFeeLamports : MAX_WALLET_PRIORITY_FEE_LAMPORTS;
    check(returned.fee <= (original.fee > cap ? original.fee : cap), 'wallet priority fee above limit');
    budgetChanged = !same(budgetLayout(expected), budgetLayout(actual));
  }
  const expectedCore = coreView(expected, budget), actualCore = coreView(actual, budget);
  // Reviewed messages never carry Lighthouse instructions, so every one in the
  // returned message is the wallet's. They may sit before, between or after the
  // original instructions; the original sequence itself must survive unchanged.
  check(!expectedCore.instructions.some(isGuard), 'unexpected wallet guard in reviewed message');
  const guardCount = actualCore.instructions.filter(isGuard).length;
  const bodyView = { ...actualCore, instructions: actualCore.instructions.filter(ix => !isGuard(ix)) };
  if (guardCount > MAX_GUARDS) reject('unsupported instruction count', instructionDiagnostic(expectedCore, actualCore));
  if (bodyView.instructions.length !== expectedCore.instructions.length) {
    const extra = bodyView.instructions.length > expectedCore.instructions.length;
    const prefixKept = extra && expectedCore.instructions.every((before, index) => before.program === bodyView.instructions[index].program && before.data.equals(bodyView.instructions[index].data));
    reject(prefixKept ? 'unsupported appended program' : extra ? 'original instructions changed' : 'unsupported instruction count', instructionDiagnostic(expectedCore, bodyView, undefined, false, actualCore));
  }
  if (guardCount === 0 && !(allowEquivalentRecompile === true || budgetChanged)) reject('unsupported instruction count', instructionDiagnostic(expectedCore, actualCore));
  check(!expected.keys.includes(INSTRUCTIONS_SYSVAR) && !actual.keys.includes(INSTRUCTIONS_SYSVAR), 'instruction introspection is unsupported');
  // Program IDs remain static, so changed programs/data can also fail locally.
  for (let index = 0; index < expectedCore.instructions.length; index++) {
    const before = expectedCore.instructions[index], after = bodyView.instructions[index];
    if (!(before.program === after.program && before.data.equals(after.data))) reject('original instructions changed', instructionDiagnostic(expectedCore, bodyView, index, false, actualCore));
  }
  // Decode and bound every guard before asking the caller for RPC data.
  const guards = actualCore.instructions.map((ix, index) => isGuard(ix) ? { ix, index } : null).filter(Boolean);
  check(guards.reduce((total, { ix }) => total + ix.data.length, 0) <= MAX_TOTAL_GUARD_BYTES, 'wallet guard limit exceeded');
  const memories = new Set(), decoded = [];
  for (const { ix, index } of guards) {
    try {
      const guard = guardInstruction(ix, expected.payer);
      if (guard.kind === 'memory-write' || guard.kind === 'memory-close') { memories.add(guard.memoryKey); check(memories.size <= MAX_MEMORIES, 'wallet guard limit exceeded'); }
      if (guard.kind === 'delta') check(memories.has(guard.memoryKey), 'unsupported wallet guard target');
      decoded.push({ ...guard, ix });
    } catch (error) {
      if (error.code !== 'WALLET_TRANSACTION_REJECTED') throw error;
      reject(error.walletValidationReason, instructionDiagnostic(expectedCore, actualCore, index, false, actualCore, true));
    }
  }
  const changedLookups = !same(expected.lookups, actual.lookups);
  if (resolvedTables !== undefined) {
    const tables = lookupEvidence([expected, actual], resolvedTables);
    expected = resolveView(expected, tables);
    actual = resolveView(actual, tables);
  } else if (changedLookups) {
    // This is a request for trusted evidence, never an acceptance. The caller
    // must verify the wallet signature before fetching the union of table keys,
    // then rerun this validator with the same signed messages and that evidence.
    throw Object.assign(new Error('Wallet transaction validation requires address lookup resolution (address lookups changed).'), { code: 'WALLET_LOOKUP_RESOLUTION_REQUIRED' });
  }
  const original = new Map(expected.accounts.map(row => [row.key, row])), returned = new Map(actual.accounts.map(row => [row.key, row]));
  const walletRemovedBudget = budget && !actual.instructions.some(isBudget);
  for (const row of expected.accounts) {
    const next = returned.get(row.key);
    // A wallet may drop every compute-budget instruction (and so the program key).
    if (!next && walletRemovedBudget && row.key === BUDGET_KEY && !row.signer && !row.writable) continue;
    check(next && row.signer === next.signer && row.writable === next.writable, 'original account permissions changed');
  }
  // Added accounts: the Lighthouse and compute-budget programs (read-only), the
  // system program when a memory snapshot is taken (read-only), and the payer's
  // own Lighthouse memory PDAs (writable, never signers). Nothing else.
  for (const row of actual.accounts) if (!original.has(row.key)) {
    check(!row.signer, 'unexpected added account');
    if (row.writable) check(guardCount > 0 && memories.has(row.key), 'unexpected added account');
    else check(guardCount > 0 && row.address === LIGHTHOUSE_PROGRAM || budget && row.key === BUDGET_KEY || memories.size > 0 && row.key === SYSTEM_KEY, 'unexpected added account');
  }
  const resolvedExpected = coreView(expected, budget), resolvedActual = coreView(actual, budget);
  const resolvedBody = resolvedActual.instructions.filter(ix => !isGuard(ix));
  for (let index = 0; index < resolvedExpected.instructions.length; index++) {
    const before = resolvedExpected.instructions[index], after = resolvedBody[index];
    if (!(before.program === after.program && same(before.keys, after.keys) && before.data.equals(after.data))) reject('original instructions changed', instructionDiagnostic(resolvedExpected, { ...resolvedActual, instructions: resolvedBody }, index, true, resolvedActual));
  }
  // Assertions are read-only and callers verify the immutable, hash-pinned
  // Lighthouse executable before co-signing. Wallets guard the accounts the
  // user's balance depends on, which can include a newly created signer
  // account such as the mint, so any original account may be asserted or
  // snapshotted. Memory accounts were bound to the payer's own PDAs above.
  const resolvedGuards = resolvedActual.instructions.filter(isGuard);
  check(resolvedGuards.length === decoded.length, 'invalid wallet guard accounts');
  resolvedGuards.forEach((ix, offset) => {
    const { kind } = decoded[offset];
    const target = kind === 'memory-write' ? ix.keys[4] : kind === 'delta' ? ix.keys[1] : kind === 'assert' ? ix.keys[0] : null;
    if (target !== null) check(original.get(target), 'unsupported wallet guard target');
  });
  return { changed: true, guardCount };
}

/** Check freshly resolved, original ALT bindings before any augmented co-sign. */
export function validateWalletLookupAccounts(expectedMessage, resolvedTables) {
  const expected = messageView(expectedMessage);
  const tables = lookupEvidence([expected], resolvedTables);
  resolveView(expected, tables);
  return { lookupAccountCount: expected.accounts.length - expected.keys.length };
}

function lookupEvidence(views, resolvedTables) {
  check(Array.isArray(resolvedTables), 'address lookup evidence is missing');
  const required = new Set(views.flatMap(view => view.lookups.map(row => row[0])));
  const tables = new Map();
  for (const table of resolvedTables) {
    const key = address(table?.key);
    check(!tables.has(key) && Array.isArray(table.state?.addresses) && table.state.addresses.length <= 256, 'invalid address lookup evidence');
    tables.set(key, table.state.addresses);
  }
  check(tables.size === required.size && [...required].every(key => tables.has(key)), 'address lookup evidence mismatch');
  return tables;
}

function resolveView(view, tables) {
  const remap = new Map(), loaded = [];
  const accounts = view.accounts.map(row => {
    if (row.address) { remap.set(row.key, row.key); return row; }
    const addresses = tables.get(row.table);
    check(addresses && row.index < addresses.length, 'unresolved address lookup index');
    const value = address(addresses[row.index]), key = `key:${value}`;
    loaded.push(value);
    remap.set(row.key, key);
    return { ...row, key, address: value };
  });
  const all = accounts.map(row => row.address);
  check(new Set(all).size === all.length, 'aliased address lookup accounts');
  check(!all.includes(INSTRUCTIONS_SYSVAR), 'instruction introspection is unsupported');
  // The only added static account permitted by validateWalletMessage is the
  // Lighthouse executable. It must not alias an original loaded account.
  check(!loaded.includes(LIGHTHOUSE_PROGRAM), 'wallet guard program aliases lookup');
  return { ...view, accounts, instructions: view.instructions.map(ix => ({ ...ix, program: remap.get(ix.program), keys: ix.keys.map(key => remap.get(key)) })) };
}
