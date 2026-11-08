import test from 'node:test';
import assert from 'node:assert/strict';
import { AddressLookupTableAccount, ComputeBudgetProgram, Keypair, MessageV0, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage } from '@solana/web3.js';
import { LIGHTHOUSE_PROGRAM, validateWalletMessage, validateWalletLookupAccounts } from '../src/launchpad-wallet-guards.mjs';

const key = () => Keypair.generate().publicKey;
const lighthouse = new PublicKey(LIGHTHOUSE_PROGRAM);
const u64 = value => { const data = Buffer.alloc(8); data.writeBigUInt64LE(BigInt(value)); return data; };
const compact = value => { const bytes = []; let n = BigInt(value); do { const b = Number(n & 127n); n >>= 7n; bytes.push(b | (n ? 128 : 0)); } while (n); return Buffer.from(bytes); };
const b = (...parts) => Buffer.concat(parts.map(part => typeof part === 'number' ? Buffer.from([part]) : Buffer.from(part)));
// Rust Borsh source: opcode5, logSilent, AccountInfo::Lamports, u64, Equal.
const lamports = () => b(5, 0, 0, u64(1000), 0);
const copy = message => MessageV0.deserialize(message.serialize());
const makeTable = addresses => new AddressLookupTableAccount({ key: key(), state: { deactivationSlot: 18446744073709551615n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses } });

function fixture({ tables = [] } = {}) {
  const payer = key(), mint = key(), recipient = key(), readonly = key(), program = key();
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 }), SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: mint, lamports: 1000, space: 0, programId: SystemProgram.programId }), SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports: 2000 }), new TransactionInstruction({ programId: program, keys: [{ pubkey: readonly, isSigner: false, isWritable: false }], data: Buffer.from([1, 2]) })];
  const blockhash = key().toBase58(), compile = instructions => new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message(tables);
  const guard = (data = lamports(), target = payer, meta = {}) => new TransactionInstruction({ programId: lighthouse, keys: [{ pubkey: target, isSigner: false, isWritable: false, ...meta }], data });
  return { payer, mint, recipient, readonly, program, ixs, tables, compile, guard, message: compile(ixs), augmented: (...guards) => compile([...ixs, ...guards]) };
}
function rejected(f, message, reason) {
  assert.throws(() => validateWalletMessage(f.message, message), error => {
    assert.equal(error.code, 'WALLET_TRANSACTION_REJECTED');
    if (reason) assert.match(error.walletValidationReason, reason);
    assert(error.message.length < 180);
    for (const pubkey of [f.payer, f.mint, f.recipient, f.readonly]) assert(!error.message.includes(pubkey.toBase58()));
    return true;
  });
}

test('byte-identical messages retain the strict existing path', () => {
  const f = fixture();
  assert.deepEqual(validateWalletMessage(f.message, copy(f.message)), { changed: false, guardCount: 0 });
  assert.deepEqual(validateWalletLookupAccounts(f.message, []), { lookupAccountCount: 0 });
});

test('wallet mismatch diagnostics identify positions and program categories without transaction contents', () => {
  const f = fixture();
  const cases = [
    [f.compile([f.guard(), ...f.ixs.slice(0, 4)]), 'unsupported instruction count', 'ix4 removed other>none; n5>5'],
    [f.compile([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), ...f.ixs, f.guard()]), 'original instructions changed', 'ix0 data compute-limit>compute-price; n5>7'],
    [f.compile([...f.ixs, SystemProgram.transfer({ fromPubkey: f.payer, toPubkey: f.recipient, lamports: 1 })]), 'unsupported appended program', 'ix5 added none>system; n5>6'],
  ];
  const repriced = copy(f.message); repriced.compiledInstructions[1].data[1] ^= 1;
  cases.push([repriced, 'unsupported instruction count', 'ix1 data compute-price>compute-price; n5>5']);
  const changedAccounts = f.augmented(f.guard()); changedAccounts.compiledInstructions[3].accountKeyIndexes.reverse();
  cases.push([changedAccounts, 'original instructions changed', 'ix3 accounts system>system; n5>6']);
  for (const [message, reason, detail] of cases) {
    assert.throws(() => validateWalletMessage(f.message, message), error => {
      assert.equal(error.walletValidationReason, reason); assert.equal(error.walletValidationDetail, detail);
      assert.equal(error.code, 'WALLET_TRANSACTION_REJECTED'); assert(error.message.length < 180);
      for (const pubkey of [...f.message.staticAccountKeys, ...message.staticAccountKeys]) assert(!error.message.includes(String(pubkey)));
      assert(!error.message.includes(Buffer.from(message.serialize()).toString('base64')));
      return true;
    });
  }
  // An equivalent encoding still cannot gain acceptance through diagnostics.
  const rearranged = f.augmented(f.guard()); rearranged.compiledInstructions.pop();
  assert.throws(() => validateWalletMessage(f.message, rearranged), error => error.code === 'WALLET_TRANSACTION_REJECTED' && error.walletValidationDetail === 'ix4 removed other>none; n5>5');
});

test('Lighthouse suffix tolerates new readonly program/header indexes while preserving global roles', () => {
  const f = fixture(), two = f.augmented(f.guard(), f.guard(b(9, 0, 2, u64(50), 4), f.recipient));
  assert.notDeepEqual(two.header, f.message.header);
  assert.deepEqual(validateWalletMessage(f.message, two), { changed: true, guardCount: 2 });
  assert.deepEqual(validateWalletLookupAccounts(f.message, []), { lookupAccountCount: 0 });
  const one = f.augmented(f.guard()), saved = Buffer.from(one.serialize());
  validateWalletMessage(f.message, one);
  assert(Buffer.from(one.serialize()).equals(saved), 'validation must not rewrite wallet-signed bytes');
});

test('read-only account reordering is accepted only alongside vetted suffix guards', () => {
  const f = fixture(), changed = f.augmented(f.guard()), indexes = [changed.staticAccountKeys.length - 1, changed.staticAccountKeys.length - 2];
  const [a, c] = indexes;
  assert(!changed.isAccountWritable(a) && !changed.isAccountWritable(c));
  [changed.staticAccountKeys[a], changed.staticAccountKeys[c]] = [changed.staticAccountKeys[c], changed.staticAccountKeys[a]];
  const remap = i => i === a ? c : i === c ? a : i;
  for (const ix of changed.compiledInstructions) { ix.programIdIndex = remap(ix.programIdIndex); ix.accountKeyIndexes = ix.accountKeyIndexes.map(remap); }
  assert.deepEqual(validateWalletMessage(f.message, changed), { changed: true, guardCount: 1 });
  changed.compiledInstructions.pop();
  rejected(f, changed, /instruction count/);
});

test('explicit recompile compatibility preserves every original instruction and permission without requiring guards', () => {
  const f = fixture(), a = makeTable([f.recipient]), c = makeTable([f.readonly]);
  const compile = tables => new TransactionMessage({ payerKey: f.payer, recentBlockhash: f.message.recentBlockhash, instructions: f.ixs }).compileToV0Message(tables);
  const original = compile([a,c]);
  for (const tables of [[c,a],[a],[c],[]]) {
    const changed = compile(tables), saved = Buffer.from(changed.serialize());
    assert.throws(() => validateWalletMessage(original, changed, { resolvedTables:[a,c] }), error => error.code === 'WALLET_TRANSACTION_REJECTED');
    assert.deepEqual(validateWalletMessage(original, changed, { resolvedTables:[a,c], allowEquivalentRecompile:true }), { changed:true, guardCount:0 });
    assert(Buffer.from(changed.serialize()).equals(saved));
    assert.equal(changed.compiledInstructions.length, original.compiledInstructions.length, 'instruction indexes must not move');
  }
  const changed = copy(f.message), x = changed.staticAccountKeys.length-1, y = x-1;
  assert(!changed.isAccountWritable(x) && !changed.isAccountWritable(y));
  [changed.staticAccountKeys[x],changed.staticAccountKeys[y]]=[changed.staticAccountKeys[y],changed.staticAccountKeys[x]];
  const remap=index=>index===x?y:index===y?x:index;
  for(const ix of changed.compiledInstructions){ix.programIdIndex=remap(ix.programIdIndex);ix.accountKeyIndexes=ix.accountKeyIndexes.map(remap);}
  assert.deepEqual(validateWalletMessage(f.message,changed,{allowEquivalentRecompile:true}),{changed:true,guardCount:0});
  for(const value of [1,'true',{},null])assert.throws(()=>validateWalletMessage(f.message,changed,{allowEquivalentRecompile:value}),{code:'WALLET_TRANSACTION_REJECTED'});
});

test('recompile opt-in cannot change fees, instructions, accounts, signers, guards or introspection behavior', () => {
  const f=fixture(),options={allowEquivalentRecompile:true};
  for(const mutate of [
    message=>{message.compiledInstructions[0].data[1]^=1;},
    message=>{message.compiledInstructions[1].data[1]^=1;},
    message=>{message.compiledInstructions[3].data[4]^=1;},
    message=>{message.compiledInstructions[3].accountKeyIndexes.reverse();},
    message=>{[message.compiledInstructions[2],message.compiledInstructions[3]]=[message.compiledInstructions[3],message.compiledInstructions[2]];},
    message=>{message.compiledInstructions.pop();},
    message=>{message.staticAccountKeys[0]=key();},
    message=>{message.staticAccountKeys[1]=key();},
    message=>{message.header.numReadonlyUnsignedAccounts--;},
    message=>{message.recentBlockhash=key().toBase58();},
  ]){const changed=copy(f.message);mutate(changed);assert.throws(()=>validateWalletMessage(f.message,changed,options),{code:'WALLET_TRANSACTION_REJECTED'});}
  const addedAccount=f.augmented(f.guard());addedAccount.compiledInstructions.pop();
  assert.throws(()=>validateWalletMessage(f.message,addedAccount,options),/unexpected added account/);
  assert.deepEqual(validateWalletMessage(f.message,f.compile([f.guard(),...f.ixs]),options),{changed:true,guardCount:1});
  assert.throws(()=>validateWalletMessage(f.message,f.compile([...f.ixs,SystemProgram.transfer({fromPubkey:f.payer,toPubkey:f.recipient,lamports:1})]),options),/unsupported appended program/);
  const sysvar=new PublicKey('Sysvar1nstructions1111111111111111111111111'),ix=new TransactionInstruction({programId:f.program,keys:[{pubkey:sysvar,isSigner:false,isWritable:false}],data:Buffer.alloc(0)}),table=makeTable([sysvar]);
  const original=f.compile([...f.ixs,ix]),recompiled=new TransactionMessage({payerKey:f.payer,recentBlockhash:f.message.recentBlockhash,instructions:[...f.ixs,ix]}).compileToV0Message([table]);
  assert.throws(()=>validateWalletMessage(original,recompiled,{...options,resolvedTables:[table]}),/introspection/);
});

test('source-proven account/token/mint/data assertion wire variants are accepted', () => {
  const f = fixture(), pubkey = key().toBytes();
  const info = [b(0, u64(1), 0), b(1, u64(165), 7), b(2, pubkey, 1), b(3, 8, 0), b(4, u64(0), 4), b(5, 1, 0), b(6, 0, 1), b(7, 0, 0), b(8, Buffer.alloc(32), compact(0), compact(165))];
  const token = [b(0, pubkey, 0), b(1, pubkey, 1), b(2, u64(1), 4), b(3, 0, 0), b(3, 1, pubkey, 1), b(4, 2, 0), b(5, 0, 1), b(5, 1, u64(0), 0), b(6, u64(0), 0), b(7, 0, 0), b(7, 1, pubkey, 0), b(8)];
  const mint = [b(0, 0, 0), b(0, 1, pubkey, 1), b(1, u64(1000), 2), b(2, 9, 0), b(3, 1, 0), b(4, 0, 0), b(4, 1, pubkey, 0)];
  const data = [b(compact(0), 0, 1, 0), ...[1, 1, 2, 2, 4, 4, 8, 8, 16, 16].map((size, i) => b(compact(300), i + 1, Buffer.alloc(size), 7)), b(compact(10), 11, compact(3), [1, 2, 3], 0), b(compact(32), 12, pubkey, 1)];
  for (const [single, multi, assertions] of [[5, 6, info], [9, 10, token], [7, 8, mint], [2, 3, data]]) {
    for (const assertion of assertions) for (const log of [0, 1, 2, 4, 5]) {
      const message = f.augmented(f.guard(b(single, log, assertion), f.readonly));
      assert.deepEqual(validateWalletMessage(f.message, message), { changed: true, guardCount: 1 });
    }
    const message = f.augmented(f.guard(b(multi, 0, compact(assertions.length), ...assertions), f.readonly));
    assert.deepEqual(validateWalletMessage(f.message, message), { changed: true, guardCount: 1 });
  }
});

test('assertion decoding rejects truncation, trailing bytes, invalid enums/options, and CPI logging modes', () => {
  const f = fixture(), valid = lamports();
  for (let i = 0; i < valid.length; i++) rejected(f, f.augmented(f.guard(valid.subarray(0, i))));
  for (const data of [b(valid, 0), b(0, 0, 0), b(1, 0, 0), b(4, 0, 0), b(11, 0, 0), b(255, 0, 0), b(5, 3, 0, u64(1), 0), b(5, 6, 0, u64(1), 0), b(5, 16, 0, u64(1), 0), b(5, 17, 0, u64(1), 0), b(5, 0, 0, u64(1), 8), b(5, 0, 2, key().toBytes(), 2), b(5, 0, 3, 9, 0), b(5, 0, 5, 2, 0), b(5, 0, 99), b(9, 0, 3, 2, 0), b(9, 0, 5, 2, 0), b(7, 0, 0, 2, 0), b(7, 0, 3, 2, 0), b(2, 0, 0, 0, 2, 0), b(2, 0, 0, 13)]) rejected(f, f.augmented(f.guard(data)));
});

test('guard vector lengths, compact integers, data bytes, and total guard budgets are bounded', () => {
  const f = fixture();
  for (const data of [b(6, 0, 0), b(6, 0, 33), b(6, 0, 0x81, 0, 0, u64(0), 0), b(2, 0, ...Array(11).fill(0xff)), b(2, 0, ...Array(9).fill(0xff), 2), b(2, 0, compact(10485761), 1, 0, 0), b(2, 0, 0, 11, compact(513)), b(5, 0, 8, Buffer.alloc(32), 0, compact(1048577)), Buffer.alloc(513)]) rejected(f, f.augmented(f.guard(data)));
  const many = f.augmented(...Array.from({ length: 17 }, () => f.guard()));
  rejected(f, many, /instruction count/);
  const large = b(2, 0, 0, 11, compact(250), Buffer.alloc(250), 0);
  rejected(f, f.augmented(...Array.from({ length: 5 }, () => f.guard(large))), /limit/);
});

test('no new external keys, extra account metas, or original privilege changes', () => {
  const f = fixture();
  rejected(f, f.augmented(f.guard(lamports(), key())), /added account/);
  // Phantom may guard any account whose balance the launch changes, including
  // the new mint signer. Assertions are read-only and the immutable Lighthouse
  // executable is verified by every caller before co-signing.
  assert.deepEqual(validateWalletMessage(f.message, f.augmented(f.guard(lamports(), f.mint))), { changed: true, guardCount: 1 });
  rejected(f, f.augmented(f.guard(lamports(), f.readonly, { isWritable: true })), /permissions/);
  rejected(f, f.augmented(f.guard(lamports(), f.readonly, { isSigner: true })), /signer/);
  const extra = f.guard(); extra.keys.push({ pubkey: f.recipient, isSigner: false, isWritable: false });
  rejected(f, f.augmented(extra), /guard accounts/);
  const none = f.guard(); none.keys = [];
  rejected(f, f.augmented(none), /guard accounts/);
});

test('economic instructions, account ordering, fee budget, payer, blockhash, and signer set cannot change', () => {
  const f = fixture();
  const mutations = [
    m => { m.compiledInstructions[3].data[4] ^= 1; },
    m => { m.compiledInstructions[0].data[1] ^= 1; },
    m => { m.compiledInstructions[1].data[1] ^= 1; },
    m => { m.compiledInstructions[2].accountKeyIndexes.reverse(); },
    m => { [m.compiledInstructions[2], m.compiledInstructions[3]] = [m.compiledInstructions[3], m.compiledInstructions[2]]; },
    m => { m.compiledInstructions[3].programIdIndex = m.compiledInstructions[4].programIdIndex; },
    m => { m.recentBlockhash = key().toBase58(); },
    m => { m.staticAccountKeys[0] = key(); },
    m => { m.staticAccountKeys[1] = key(); },
    m => { m.staticAccountKeys[m.staticAccountKeys.length - 1] = key(); },
    m => { m.compiledInstructions.splice(2, 1); },
  ];
  for (const mutate of mutations) { const message = copy(f.augmented(f.guard())); mutate(message); rejected(f, message); }
  rejected(f, f.compile([f.guard(), ...f.ixs]), /original instructions/);
  rejected(f, f.compile([...f.ixs, SystemProgram.transfer({ fromPubkey: f.payer, toPubkey: f.recipient, lamports: 1 })]), /appended program/);
});

test('original instruction introspection blocks augmentation, including loaded sysvar keys', () => {
  const f = fixture(), sysvar = new PublicKey('Sysvar1nstructions1111111111111111111111111');
  const ix = new TransactionInstruction({ programId: f.program, keys: [{ pubkey: sysvar, isSigner: false, isWritable: false }], data: Buffer.alloc(0) });
  const original = f.compile([...f.ixs, ix]), augmented = f.compile([...f.ixs, ix, f.guard()]);
  assert.throws(() => validateWalletMessage(original, augmented), /introspection/);
  const table = makeTable([sysvar]), compile = instructions => new TransactionMessage({ payerKey: f.payer, recentBlockhash: f.message.recentBlockhash, instructions }).compileToV0Message([table]);
  const loaded = compile([...f.ixs, ix]);
  assert.equal(loaded.addressTableLookups.length, 1);
  assert.deepEqual(validateWalletMessage(loaded, compile([...f.ixs, ix, f.guard()])), { changed: true, guardCount: 1 });
  assert.throws(() => validateWalletLookupAccounts(loaded, [table]), /introspection/);
});

test('unchanged ALT identities and access partitions are preserved, then independently resolved', () => {
  const f = fixture(), table = makeTable([f.readonly, f.recipient]);
  const compile = instructions => new TransactionMessage({ payerKey: f.payer, recentBlockhash: f.message.recentBlockhash, instructions }).compileToV0Message([table]);
  const original = compile(f.ixs), actual = compile([...f.ixs, f.guard(lamports(), f.recipient)]);
  assert.deepEqual(validateWalletMessage(original, actual), { changed: true, guardCount: 1 });
  assert.deepEqual(validateWalletLookupAccounts(original, [table]), { lookupAccountCount: 2 });
  for (const mutate of [m => { m.addressTableLookups[0].accountKey = key(); }, m => { m.addressTableLookups[0].readonlyIndexes[0] = 2; }, m => { [m.addressTableLookups[0].writableIndexes, m.addressTableLookups[0].readonlyIndexes] = [m.addressTableLookups[0].readonlyIndexes, m.addressTableLookups[0].writableIndexes]; }]) {
    const changed = copy(actual); mutate(changed);
    assert.throws(() => validateWalletMessage(original, changed), /address lookups changed/);
  }
  for (const evidence of [undefined, [], [makeTable([f.readonly, f.recipient])], [table, table]]) assert.throws(() => validateWalletLookupAccounts(original, evidence), /lookup/);
  const badTable = addresses => new AddressLookupTableAccount({ key: table.key, state: { ...table.state, addresses } });
  assert.throws(() => validateWalletLookupAccounts(original, [badTable([f.readonly])]), /unresolved/);
  assert.throws(() => validateWalletLookupAccounts(original, [badTable([f.payer, f.recipient])]), /aliased/);
  assert.throws(() => validateWalletLookupAccounts(original, [badTable([f.recipient, f.recipient])]), /aliased/);
  assert.throws(() => validateWalletLookupAccounts(original, [badTable([lighthouse, f.recipient])]), /program aliases/);
});

test('malformed message headers, key aliases, and compiled indexes fail closed', () => {
  const f = fixture();
  for (const mutate of [m => { m.header.numRequiredSignatures = 0; }, m => { m.header.numReadonlyUnsignedAccounts = 255; }, m => { m.staticAccountKeys[2] = m.staticAccountKeys[0]; }, m => { m.compiledInstructions[0].programIdIndex = 255; }, m => { m.compiledInstructions[0].accountKeyIndexes = [255]; }, m => { m.compiledInstructions[0].programIdIndex = 0; }]) {
    const actual = f.augmented(f.guard()); mutate(actual); rejected(f, actual);
  }
});

test('trusted union evidence allows ALT reorder, repack, and static/loaded moves without changing signed bytes', () => {
  const f = fixture(), recipientTable = makeTable([f.recipient]), readonlyTable = makeTable([f.readonly]);
  const replacement = makeTable([key(), f.readonly, f.recipient]);
  const compile = (ixs, tables) => new TransactionMessage({ payerKey: f.payer, recentBlockhash: f.message.recentBlockhash, instructions: ixs }).compileToV0Message(tables);
  for (const [beforeTables, afterTables] of [
    [[recipientTable, readonlyTable], [readonlyTable, recipientTable]],
    [[recipientTable, readonlyTable], [replacement]],
    [[recipientTable, readonlyTable], []],
    [[], [replacement]],
    [[recipientTable], [readonlyTable]],
  ]) {
    const original = compile(f.ixs, beforeTables), actual = compile([...f.ixs, f.guard(lamports(), f.recipient), f.guard(lamports(), f.readonly)], afterTables);
    assert.notDeepEqual(original.addressTableLookups, actual.addressTableLookups);
    assert.throws(() => validateWalletMessage(original, actual), { code: 'WALLET_LOOKUP_RESOLUTION_REQUIRED' });
    const saved = Buffer.from(actual.serialize()), tables = [...new Map([...beforeTables, ...afterTables].map(table => [table.key.toBase58(), table])).values()];
    assert.deepEqual(validateWalletMessage(original, actual, { resolvedTables: tables }), { changed: true, guardCount: 2 });
    assert(Buffer.from(actual.serialize()).equals(saved), 'semantic validation cannot recompile or rewrite the signed message');
    assert.throws(() => validateWalletMessage(original, compile(f.ixs, afterTables), { resolvedTables: tables }), { code: 'WALLET_TRANSACTION_REJECTED' });
  }
});

test('changed layouts require complete exact union evidence and reject every unresolved or aliased binding', () => {
  const f = fixture(), before = makeTable([f.recipient, f.readonly]), after = makeTable([f.readonly, f.recipient]);
  const compile = (ixs, table) => new TransactionMessage({ payerKey: f.payer, recentBlockhash: f.message.recentBlockhash, instructions: ixs }).compileToV0Message([table]);
  const original = compile(f.ixs, before), actual = compile([...f.ixs, f.guard()], after);
  const verify = resolvedTables => validateWalletMessage(original, actual, { resolvedTables });
  for (const tables of [[], [before], [after], [before, after, makeTable([])], [before, after, after], [before, makeTable(after.state.addresses)]])
    assert.throws(() => verify(tables), { code: 'WALLET_TRANSACTION_REJECTED' });
  const mutateAfter = addresses => new AddressLookupTableAccount({ key: after.key, state: { ...after.state, addresses } });
  for (const addresses of [[], [f.readonly], [f.readonly, f.payer], [f.recipient, f.recipient], [f.readonly, lighthouse], [new PublicKey('Sysvar1nstructions1111111111111111111111111'), f.recipient], [f.readonly, key()]])
    assert.throws(() => verify([before, mutateAfter(addresses)]), { code: 'WALLET_TRANSACTION_REJECTED' });
});

test('resolved layouts preserve original account privileges, recipient/order, data, fees, and guard targets', () => {
  const f = fixture(), before = makeTable([f.recipient, f.readonly]), after = makeTable([f.readonly, f.recipient]);
  const compile = (ixs, table) => new TransactionMessage({ payerKey: f.payer, recentBlockhash: f.message.recentBlockhash, instructions: ixs }).compileToV0Message([table]);
  const original = compile(f.ixs, before), tables = [before, after];
  const verify = actual => validateWalletMessage(original, actual, { resolvedTables: tables });
  assert.deepEqual(verify(compile([...f.ixs, f.guard(lamports(), f.mint)], after)), { changed: true, guardCount: 1 });
  for (const guard of [f.guard(lamports(), f.readonly, { isWritable: true }), f.guard(lamports(), key())])
    assert.throws(() => verify(compile([...f.ixs, guard], after)), { code: 'WALLET_TRANSACTION_REJECTED' });
  for (const mutate of [
    m => { m.compiledInstructions[3].accountKeyIndexes.reverse(); },
    m => { m.compiledInstructions[3].accountKeyIndexes[1] = m.compiledInstructions[4].accountKeyIndexes[0]; },
    m => { m.compiledInstructions[0].data[1] ^= 1; },
    m => { m.compiledInstructions[1].data[1] ^= 1; },
    m => { m.compiledInstructions[3].data[4] ^= 1; },
    m => { [m.compiledInstructions[2], m.compiledInstructions[3]] = [m.compiledInstructions[3], m.compiledInstructions[2]]; },
    m => { m.staticAccountKeys[1] = key(); },
  ]) {
    const changed = copy(compile([...f.ixs, f.guard()], after)); mutate(changed);
    assert.throws(() => verify(changed), { code: 'WALLET_TRANSACTION_REJECTED' });
  }
});

test('malformed changed-layout messages fail definitively before requesting RPC resolution', () => {
  const f = fixture(), table = makeTable([f.recipient, f.readonly]);
  const compile = ixs => new TransactionMessage({ payerKey: f.payer, recentBlockhash: f.message.recentBlockhash, instructions: ixs }).compileToV0Message([table]);
  for (const actual of [compile([...f.ixs, f.guard(b(255, 0, 0))]), compile([...f.ixs, f.guard(Buffer.alloc(513))]), compile([...f.ixs, SystemProgram.transfer({ fromPubkey: f.payer, toPubkey: f.recipient, lamports: 1 })]), compile(f.ixs)])
    assert.throws(() => validateWalletMessage(f.message, actual), { code: 'WALLET_TRANSACTION_REJECTED' });
  for (const mutate of [m => { m.recentBlockhash = key().toBase58(); }, m => { m.staticAccountKeys[0] = key(); }, m => { m.staticAccountKeys[1] = key(); }, m => { m.compiledInstructions[0].data[1] ^= 1; }, m => { m.compiledInstructions[0].programIdIndex = 255; }]) {
    const actual = copy(compile([...f.ixs, f.guard()])); mutate(actual);
    assert.throws(() => validateWalletMessage(f.message, actual), { code: 'WALLET_TRANSACTION_REJECTED' });
  }
});

// Phantom and Solflare set their own priority fee / compute limit while signing.
// The developer wallet pays those fees, so the opt-in budget mode accepts them
// within the 0.01 SOL cap while every other reviewed instruction stays locked.
test('opt-in wallet compute budget edits are bounded and never unlock other changes', () => {
  const f = fixture(), budget = { allowComputeBudget: true }, core = f.ixs.slice(2);
  const accepts = (ixs, guardCount = 0) => assert.deepEqual(validateWalletMessage(f.message, f.compile(ixs), budget), { changed: true, guardCount });
  accepts([ComputeBudgetProgram.setComputeUnitLimit({ units: 260000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250000 }), ...core]);
  accepts([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }), ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }), ...core]);
  accepts([...core, ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })]);
  accepts(core);
  accepts([ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 90000 }), ...core, f.guard(), f.guard(lamports(), f.mint)], 2);
  // Strict default mode is unchanged.
  assert.throws(() => validateWalletMessage(f.message, f.compile([ComputeBudgetProgram.setComputeUnitLimit({ units: 260000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250000 }), ...core])), { code: 'WALLET_TRANSACTION_REJECTED' });
  const rejects = (ixs, reason) => assert.throws(() => validateWalletMessage(f.message, f.compile(ixs), budget), error => error.code === 'WALLET_TRANSACTION_REJECTED' && reason.test(error.walletValidationReason));
  rejects([ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 7200000 }), ...core], /priority fee above limit/);
  rejects([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 7200000 }), ...core], /priority fee above limit/);
  rejects([ComputeBudgetProgram.setComputeUnitLimit({ units: 1400001 }), ...core], /compute limit/);
  rejects([ComputeBudgetProgram.requestHeapFrame({ bytes: 65536 }), ...f.ixs], /unsupported compute budget/);
  rejects([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2 }), ...core], /duplicate compute budget/);
  rejects([...f.ixs.slice(0, 2), core[1], core[0], core[2]], /instruction count/);
  rejects([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 3 }), core[1], core[0], core[2]], /original instructions changed/);
  rejects([...f.ixs, SystemProgram.transfer({ fromPubkey: f.payer, toPubkey: f.recipient, lamports: 1 })], /unsupported appended program/);
  rejects([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 3 }), SystemProgram.transfer({ fromPubkey: f.payer, toPubkey: f.recipient, lamports: 1 }), ...core], /original instructions changed/);
  const withAccount = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 3 }); withAccount.keys = [{ pubkey: f.recipient, isSigner: false, isWritable: true }];
  rejects([withAccount, ...core], /unsupported compute budget/);
});

// Phantom's balance guard is a Lighthouse MemoryWrite of the payer's lamports
// placed BEFORE the reviewed instructions and an AssertAccountDelta after them
// (observed on a PumpSwap configure step as "ix0 program lookup>lighthouse;
// n3>5"). The payer funds its own bounded memory PDA; everything stays read-only
// for every reviewed account.
test('Phantom memory snapshot before and delta assertion after the reviewed instructions are accepted within bounds', () => {
  const f = fixture(), budget = { allowComputeBudget: true }, core = f.ixs.slice(2);
  const [memory, bump] = PublicKey.findProgramAddressSync([Buffer.from('memory'), f.payer.toBuffer(), Buffer.from([0])], lighthouse);
  const leb = value => compact(value);
  const i128 = value => { const data = Buffer.alloc(16); data.writeBigInt64LE(BigInt(value)); if (value < 0) data.fill(0xff, 8); return data; };
  // MemoryWrite { memory_id 0, bump, write_offset 0, AccountInfoField(Lamports) }
  const memoryWrite = ({ source = f.payer, id = 0, b = bump, offset = 0, type = b(1, 1), mem = memory, who = f.payer } = {}) => new TransactionInstruction({ programId: lighthouse, keys: [
    { pubkey: lighthouse, isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: who, isSigner: true, isWritable: true }, { pubkey: mem, isSigner: false, isWritable: true }, { pubkey: source, isSigner: false, isWritable: false }],
    data: Buffer.concat([Buffer.from([0, id, b]), leb(offset), type]) });
  // AssertAccountDelta { log Silent, AccountInfo { a_offset 0, Lamports { value -3000, GreaterThanOrEqual } } }
  const delta = ({ target = f.payer, mem = memory } = {}) => new TransactionInstruction({ programId: lighthouse, keys: [{ pubkey: mem, isSigner: false, isWritable: false }, { pubkey: target, isSigner: false, isWritable: false }], data: Buffer.concat([Buffer.from([4, 0, 0]), leb(0), Buffer.from([0]), i128(-3000), Buffer.from([5])]) });
  const memoryClose = ({ mem = memory, who = f.payer, id = 0, b = bump } = {}) => new TransactionInstruction({ programId: lighthouse, keys: [{ pubkey: lighthouse, isSigner: false, isWritable: false }, { pubkey: who, isSigner: true, isWritable: true }, { pubkey: mem, isSigner: false, isWritable: true }], data: Buffer.from([1, id, b]) });
  const accepts = (ixs, guardCount) => assert.deepEqual(validateWalletMessage(f.message, f.compile(ixs), budget), { changed: true, guardCount });
  const rejects = (ixs, reason) => assert.throws(() => validateWalletMessage(f.message, f.compile(ixs), budget), error => error.code === 'WALLET_TRANSACTION_REJECTED' && reason.test(error.walletValidationReason) && error.message.length < 200);
  accepts([ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20000 }), memoryWrite(), ...core, delta()], 2);
  accepts([...f.ixs.slice(0, 2), memoryWrite(), ...core, delta()], 2);
  accepts([f.guard(), memoryWrite(), ...core, delta(), f.guard(lamports(), f.mint), memoryClose()], 5);
  accepts([memoryWrite({ source: f.mint }), ...core, delta({ target: f.mint })], 2);
  // Memory PDA must be the payer's, with the stated id and bump; only the payer funds or is refunded.
  const stranger = Keypair.generate().publicKey, [otherMemory, otherBump] = PublicKey.findProgramAddressSync([Buffer.from('memory'), stranger.toBuffer(), Buffer.from([0])], lighthouse);
  rejects([memoryWrite({ mem: stranger }), ...core, delta({ mem: stranger })], /invalid wallet guard/);
  rejects([memoryWrite({ b: (bump + 7) & 255 }), ...core, delta()], /invalid wallet guard/);
  rejects([memoryWrite({ who: stranger, mem: otherMemory, b: otherBump }), ...core], /signer set changed|invalid wallet guard accounts/);
  rejects([...core, memoryClose({ who: stranger, mem: otherMemory, b: otherBump })], /signer set changed|invalid wallet guard accounts/);
  // Bounded memory (offset + length <= 1024 bytes), original accounts only, delta needs a snapshot.
  rejects([memoryWrite({ offset: 1020 }), ...core, delta()], /wallet guard limit exceeded/);
  accepts([memoryWrite({ offset: 1016 }), ...core, delta()], 2);
  rejects([memoryWrite({ type: b(7) }), ...core], /unsupported wallet guard write/);
  rejects([memoryWrite({ source: stranger }), ...core, delta()], /unexpected added account|unsupported wallet guard target/);
  rejects([...core, delta()], /unsupported wallet guard target/);
  rejects([memoryWrite(), ...core, delta({ target: stranger })], /unexpected added account|unsupported wallet guard target/);
  // The reviewed instructions still cannot change, move or be joined by anything else.
  rejects([memoryWrite(), core[1], core[0], core[2], delta()], /original instructions changed/);
  rejects([memoryWrite(), core[0], core[1], delta()], /instruction count|original instructions changed/);
  rejects([memoryWrite(), SystemProgram.transfer({ fromPubkey: f.payer, toPubkey: f.recipient, lamports: 1 }), ...core, delta()], /original instructions changed/);
  const extra = [1, 2, 3].map(id => { const [mem, b2] = PublicKey.findProgramAddressSync([Buffer.from('memory'), f.payer.toBuffer(), Buffer.from([id])], lighthouse); return memoryWrite({ id, b: b2, mem }); });
  rejects([memoryWrite(), ...extra, ...core], /wallet guard limit exceeded/);
});
