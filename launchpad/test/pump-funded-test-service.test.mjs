import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { PumpFundedTestService, PUMP_TEST_OPERATOR as OPERATOR, PUMP_TEST_TREASURY as TREASURY, verifyFundedSignedTransaction, readPrivatePumpConfig, selectCleanPumpPoolIndex } from '../src/pump-funded-test-service.mjs';
const owner = { account: { id: 'owner' } };
const config = { operator: OPERATOR, treasury: TREASURY, cluster: 'mainnet-beta', graduationFeeBps: 2885, tradeFeeBps: 100, solUsdMicros: '150000000' };
function message(wallet = OPERATOR, lamports = 1000) {
  const payer = new PublicKey(wallet);
  return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: Keypair.fromSeed(new Uint8Array(32).fill(6)).publicKey.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(TREASURY), lamports })] }).compileToV0Message());
}
const encoded = tx => Buffer.from(tx.serialize()).toString('base64');
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-funded-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let stored, clock = 100000, allowed = true, prepares = 0, sends = 0, failWrite = false;
  const tx = message(), signed = message(); signed.signatures[0].fill(4);
  const configCopy = structuredClone(config);
  const accounts = { dir, hostStore: { read: async () => structuredClone(stored || { schemaVersion: 1, operations: [] }), write: async (key, value) => { if (failWrite) throw Error('disk unavailable'); stored = structuredClone(value); } } };
  const context = { sessionToken: 'session-one', authorize: async () => { if (!allowed) throw Object.assign(Error('revoked'), { statusCode: 403 }); return owner; } };
  const adapter = {
    load: async () => ({ config: structuredClone(configCopy), configDir: dir }),
    rpc: () => async method => { if (method === 'sendTransaction') { sends++; assert.equal(stored.operations.at(-1).journal.entries[0].signedTransaction, encoded(signed), 'signed bytes persisted before send'); return 'saved-signature'; } return {}; },
    status: async () => ({ phase: 'uninitialized', actions: ['initialize'] }),
    configurePrice: async (loaded, price, now) => { configCopy.solUsdMicros = price; configCopy.priceObservedAt = new Date(now).toISOString(); },
    prepare: async () => { prepares++; return { unsignedTransaction: encoded(tx), details: { startingFdvUsd: '100' }, maxWalletDebitLamports: '10000', walletBalanceLamports: '100000' }; },
    submit: async (loaded, rpc, bundle, signedTransaction, journalStore) => {
      const journal = await journalStore.read();
      if (!journal.entries.length) { journal.entries.push({ signedTransaction, signature: 'saved-signature', state: 'prepared-for-send' }); await journalStore.write(journal); }
      await rpc('sendTransaction', [signedTransaction]); journal.entries[0].state = 'submitted'; await journalStore.write(journal);
      return { state: 'submitted', signature: 'saved-signature' };
    },
    reconcile: async () => ({ state: 'finalized', signature: 'saved-signature' })
  };
  const verifySignature = (bytes, bundle, wallet) => { assert.equal(wallet, OPERATOR); assert.equal(bytes, encoded(signed)); assert.equal(bundle.unsignedTransaction, encoded(tx)); };
  const service = new PumpFundedTestService({ accounts, requireOwner: async session => assert.equal(session.account.id, owner.account.id), adapter, now: () => clock, verifySignature, ...options });
  const prepare = () => service.prepare(owner, { action: 'initialize', expectedWallet: OPERATOR, solUsdMicros: '150000000' }, context);
  return { service, adapter, accounts, context, configCopy, prepare, signed: encoded(signed), tx, get stored() { return stored; }, get prepares() { return prepares; }, get sends() { return sends; }, revoke: () => { allowed = false; }, advance: ms => { clock += ms; }, failWrites: () => { failWrite = true; } };
}

test('cryptographic wallet verifier accepts only canonical v0 exact signed message and expected payer', () => {
  const signer = Keypair.fromSeed(new Uint8Array(32).fill(47)), tx = message(signer.publicKey.toBase58()), bundle = { unsignedTransaction: encoded(tx) };
  tx.sign([signer]); assert.match(verifyFundedSignedTransaction(encoded(tx), bundle, signer.publicKey.toBase58()), /^[a-f0-9]{64}$/);
  assert.throws(() => verifyFundedSignedTransaction(encoded(tx), bundle, OPERATOR), /reviewed operation/);
  const changed = message(signer.publicKey.toBase58(), 1001); changed.sign([signer]);
  assert.throws(() => verifyFundedSignedTransaction(encoded(changed), bundle, signer.publicKey.toBase58()), /reviewed operation/);
  tx.signatures[0][0] ^= 1; assert.throws(() => verifyFundedSignedTransaction(encoded(tx), bundle, signer.publicKey.toBase58()), /reviewed operation/);
  assert.throws(() => verifyFundedSignedTransaction(bundle.unsignedTransaction, bundle, signer.publicKey.toBase58()), /reviewed operation/);
  assert.throws(() => verifyFundedSignedTransaction('not-base64', bundle, signer.publicKey.toBase58()));
});

test('funded mode is disabled when private config is absent and rejects request-level policy overrides', async t => {
  const h = await fixture(t);
  h.adapter.load = async () => { throw Error('https://secret-rpc.invalid/token private path'); };
  const status = await h.service.status(owner, h.context); assert.equal(status.enabled, false); assert.equal(status.verifiedDeployment, false); assert.deepEqual(status.actions, []); assert.doesNotMatch(JSON.stringify(status), /secret-rpc|private path/);
  await assert.rejects(h.service.prepare(owner, { action: 'initialize', expectedWallet: OPERATOR, treasury: TREASURY }, h.context), /Unsupported/);
  await assert.rejects(h.service.prepare(owner, { action: 'initialize', expectedWallet: TREASURY, solUsdMicros: '150000000' }, h.context), /operator wallet/);
  assert.equal(h.sends, 0);
});

test('review reuse, explicit signature submission and read-only reconciliation preserve one durable operation', async t => {
  const h = await fixture(t), first = await h.prepare(), second = await h.prepare();
  assert.equal(first.operation.id, second.operation.id); assert.equal(h.prepares, 1); assert.equal(first.operation.state, 'awaiting_signature'); assert.equal(h.sends, 0);
  const submitted = await h.service.submit(owner, { operationId: first.operation.id, signedTransaction: h.signed }, h.context);
  assert.equal(submitted.operation.state, 'submitted'); assert.equal(h.sends, 1); assert(!submitted.operation.transaction);
  await assert.rejects(h.prepare(), /Resolve/);
  const recovered = new PumpFundedTestService({ accounts: h.accounts, requireOwner: async () => {}, adapter: h.adapter });
  const status = await recovered.status(owner, h.context); assert.equal(status.activeOperation.signature, 'saved-signature'); assert.deepEqual(status.actions, []);
  const done = await recovered.reconcile(owner, { operationId: first.operation.id }, { ...h.context, sessionToken: 'new-owner-session' });
  assert.equal(done.operation.state, 'finalized'); assert.equal(h.sends, 1);
});

test('role/session revocation, altered binding and session replay cannot broadcast', async t => {
  const h = await fixture(t), prepared = await h.prepare(), body = { operationId: prepared.operation.id, signedTransaction: h.signed };
  await assert.rejects(h.service.submit(owner, body, { ...h.context, sessionToken: 'other-session' }), /another session/);
  h.configCopy.tradeFeeBps = 101; await assert.rejects(h.service.submit(owner, body, h.context), /owner microtest/); h.configCopy.tradeFeeBps = 100;
  const previous = h.adapter.submit;
  h.adapter.submit = async (...args) => { h.revoke(); return previous(...args); };
  await assert.rejects(h.service.submit(owner, body, h.context), /revoked/); assert.equal(h.sends, 0);
  assert(h.stored.operations[0].journal.entries.length, 'saved evidence remains after revoke');
});

test('failed persistence blocks send, signed ambiguity blocks replacement, exact retries keep saved signature', async t => {
  const h = await fixture(t), prepared = await h.prepare(), body = { operationId: prepared.operation.id, signedTransaction: h.signed };
  h.failWrites(); await assert.rejects(h.service.submit(owner, body, h.context)); assert.equal(h.sends, 0);
  const h2 = await fixture(t), p2 = await h2.prepare(), submit = h2.adapter.submit;
  h2.adapter.submit = async (...args) => { await submit(...args); throw Error('RPC timeout https://secret'); };
  const uncertain = await h2.service.submit(owner, { operationId: p2.operation.id, signedTransaction: h2.signed }, h2.context);
  assert.equal(uncertain.operation.signature, 'saved-signature'); assert.doesNotMatch(JSON.stringify(uncertain), /secret/);
  await assert.rejects(h2.prepare(), /Resolve/); assert.equal(h2.prepares, 1);
  await h2.service.submit(owner, { operationId: p2.operation.id, signedTransaction: h2.signed }, h2.context);
  assert.equal(h2.sends, 2); assert.equal(h2.stored.operations[0].journal.entries.length, 1);
});

test('expired unsigned reviews can be replaced, signed unresolved reviews never expire into replacements', async t => {
  const h = await fixture(t), first = await h.prepare(); h.advance(120001);
  await assert.rejects(h.service.submit(owner, { operationId: first.operation.id, signedTransaction: h.signed }, h.context), /expired/);
  const status = await h.service.status(owner, h.context); assert.deepEqual(status.actions, ['initialize']);
  const next = await h.prepare(); assert.notEqual(next.operation.id, first.operation.id);
  await h.service.submit(owner, { operationId: next.operation.id, signedTransaction: h.signed }, h.context); h.advance(120001);
  await assert.rejects(h.prepare(), /Resolve/);
});

test('exclusive filesystem lock prevents simultaneous preparations across service instances', async t => {
  const h = await fixture(t); let release, started;
  const pending = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
  const original = h.adapter.prepare; h.adapter.prepare = async (...args) => { started(); await pending; return original(...args); };
  const first = h.prepare(); await entered;
  const second = new PumpFundedTestService({ accounts: h.accounts, requireOwner: async () => {}, adapter: h.adapter });
  await assert.rejects(second.prepare(owner, { action: 'initialize', expectedWallet: OPERATOR, solUsdMicros: '150000000' }, h.context), /in progress/);
  release(); await first; assert.equal(h.prepares, 1);
});

test('private config reader rejects broad permissions and symlinks', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-pump-config-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json'); await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  assert.deepEqual((await readPrivatePumpConfig(path)).config, config);
  await chmod(path, 0o644); await assert.rejects(readPrivatePumpConfig(path), /protected/); await chmod(path, 0o600);
  await symlink(path, join(dir, 'link.json')); await assert.rejects(readPrivatePumpConfig(join(dir, 'link.json')));
  await assert.rejects(readPrivatePumpConfig('relative.json'), /configured/);
});

test('price updates require uninitialized state and cannot replace an unresolved reviewed operation', async t => {
  const h = await fixture(t);
  await assert.rejects(h.service.prepare(owner, {action:'initialize', expectedWallet:OPERATOR}, h.context), /manual SOL/);
  await assert.rejects(h.service.prepare(owner, {action:'buy-to-bond', expectedWallet:OPERATOR, solUsdMicros:'150000000'}, h.context), /only for initialization/);
  const prepared=await h.prepare();assert.equal(prepared.operation.review.solUsdMicros,'150000000');assert.equal(prepared.operation.review.priceObservedAt,new Date(100000).toISOString());
  await assert.rejects(h.service.prepare(owner,{action:'initialize',expectedWallet:OPERATOR,solUsdMicros:'151000000'},h.context),/Resolve/);
  h.advance(120001);h.adapter.status=async()=>({phase:'trading',actions:['buy-to-bond']});
  await assert.rejects(h.prepare(),/already initialized/);assert.equal(h.configCopy.solUsdMicros,'150000000');
});
test('migration uses a clean server-selected index and fails closed when reserve evidence is unavailable',async()=>{
  let selected=5,calls=0;
  const derive=async(c,index)=>Object.fromEntries(['pool','lpMint','authorityLp','poolBase','poolQuote'].map(name=>[name,{toBase58:()=>index+':'+name}]));
  const rpc=async(method,[address])=>{calls++;return {value:address==='5:poolQuote'?{lamports:1}:null};};
  assert.equal(await selectCleanPumpPoolIndex({},rpc,{derive,select:()=>selected++}),6);assert.equal(calls,10);
  await assert.rejects(selectCleanPumpPoolIndex({},async()=>({}),{derive,select:()=>0}),/No clean/);
});
