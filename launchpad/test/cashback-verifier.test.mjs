import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, SystemProgram } from '@solana/web3.js';
import bs58 from 'bs58';
import { SOL } from '../src/core.mjs';
import { TelegramLedger, TelegramStore } from '../src/telegram-store.mjs';
import { validatePlatformContext, platformFeePlan, preparePlatformFee, verifyPlatformFee } from '../src/platform-fees.mjs';
import { CashbackVerifier, receiptHash } from '../src/cashback-verifier.mjs';
import { cashbackSummary } from '../src/account-policy.mjs';

const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const HOST_RPC = 'https://operator-rpc.example.com';
const address = () => Keypair.generate().publicKey.toBase58();

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-cashback-test-')), key = randomBytes(32);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const account = { id: 'account-one', mainWallet: address() }, collector = address(), wallet = address();
  let store = new TelegramStore(dir, key, `account:${account.id}`);
  const accounts = { list: async () => [account], storeFor: id => { assert.equal(id, account.id); return store; } };
  const calls = [], transactions = new Map(), clock = { now: 1000000 }, chain = { hash: MAINNET };
  const rpc = async (url, method, params, signal) => {
    assert.equal(url, HOST_RPC, 'cashback verification must never read the customer RPC'); assert(signal instanceof AbortSignal);
    calls.push({ method, params });
    if (method === 'getGenesisHash') return chain.hash;
    assert.equal(method, 'getTransaction'); assert.equal(params[1].commitment, 'finalized'); assert.equal(params[1].encoding, 'jsonParsed');
    const result = transactions.get(params[0]); if (result instanceof Error) throw result;
    return structuredClone(result ?? null);
  };
  const verifier = () => { const v = new CashbackVerifier(accounts, { rpcUrl: HOST_RPC, rpc, now: () => clock.now }); t.after(() => v.close()); return v; };
  const claim = async ({ signature = bs58.encode(randomBytes(64)), amount = 1000000n } = {}) => {
    const context = validatePlatformContext({ accountId: account.id, mainWallet: account.mainWallet, recipient: collector, cashbackBps: 2000 });
    const prepared = await preparePlatformFee(platformFeePlan(context, 'copy', SOL, amount, wallet), {});
    const pending = { signature, wallet, createdAt: clock.now, order: { platformFee: prepared.plan } }, fee = Number(prepared.plan.chargedAmount);
    const tx = { transaction: { signatures: [signature], message: { accountKeys: [{ pubkey: wallet, signer: true }, { pubkey: collector, signer: false }],
      instructions: [{ programId: SystemProgram.programId.toBase58(), parsed: { type: 'transfer', info: { source: wallet, destination: collector, lamports: fee } } }] } },
      meta: { err: null, fee: 5000, preBalances: [1000000000, 1000000], postBalances: [1000000000 - fee - 5000, 1000000 + fee], preTokenBalances: [], postTokenBalances: [] } };
    return { receipt: verifyPlatformFee(pending, tx), tx };
  };
  await store.write('settings', { customRpcUrl: 'https://customer-controlled.example.com?api-key=secret-test-value' });
  return { account, accounts, collector, wallet, calls, transactions, clock, chain, verifier, claim,
    get store() { return store; }, reopen() { store = new TelegramStore(dir, key, `account:${account.id}`); return store; } };
}

test('only independent finalized fee evidence becomes accrued cashback; payouts remain zero', async t => {
  const h = await harness(t), { receipt, tx } = await h.claim(); await h.store.write('live', { feeReceipts: [receipt] });
  let [summary] = await cashbackSummary(h.store); assert.equal(summary.accruedAmount, '0'); assert.equal(summary.unverifiedAmount, '500');
  h.transactions.set(receipt.signature, tx); await h.verifier().tick();
  [summary] = await cashbackSummary(h.store);
  assert.equal(summary.collectedAmount, '2500'); assert.equal(summary.accruedAmount, '500'); assert.equal(summary.pendingAmount, '500');
  assert.equal(summary.paidAmount, '0'); assert.equal(summary.unverifiedAmount, '0');
  const verification = await h.store.read('cashback-verification');
  assert.equal(verification.receipts[receipt.signature].status, 'verified'); assert.equal(verification.receipts[receipt.signature].hash, receiptHash(receipt));
  assert.deepEqual(h.calls.map(c => c.method), ['getGenesisHash', 'getTransaction']);
});

test('missing, failed, fabricated and mismatched customer claims never accrue from the host RPC', async t => {
  const cases = {
    missing: () => null,
    failed: tx => { tx.meta.err = { InstructionError: [2, 'Failure'] }; return tx; },
    'missing credit': tx => { tx.meta.postBalances[1] = tx.meta.preBalances[1]; return tx; },
    'missing transfer': tx => { tx.transaction.message.instructions = []; return tx; },
    'wrong signature': tx => { tx.transaction.signatures[0] = bs58.encode(randomBytes(64)); return tx; },
    'unsigned payer': tx => { tx.transaction.message.accountKeys[0].signer = false; return tx; },
    'RPC unavailable': () => Error('https://operator-rpc.example.com?api-key=secret provider problem'),
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async t => {
    const h = await harness(t), { receipt, tx } = await h.claim(); await h.store.write('portfolio-live', { feeReceipts: [receipt] });
    h.transactions.set(receipt.signature, change(tx)); await h.verifier().tick();
    const [summary] = await cashbackSummary(h.store);
    assert.equal(summary.collectedAmount, '0'); assert.equal(summary.accruedAmount, '0'); assert.equal(summary.pendingAmount, '0');
    assert.equal(summary.unverifiedAmount, '500'); assert.equal(summary.paidAmount, '0');
    const verification = await h.store.read('cashback-verification'); assert.equal(verification.receipts[receipt.signature].status, 'pending');
    assert(!JSON.stringify(verification).includes('secret')); assert(!JSON.stringify(verification).includes('https://'));
  });
});

test('non-mainnet host endpoint cannot approve an otherwise convincing transaction', async t => {
  const h = await harness(t), { receipt, tx } = await h.claim(); await h.store.write('live', { feeReceipts: [receipt] });
  h.chain.hash = address(); h.transactions.set(receipt.signature, tx); await h.verifier().tick();
  assert.equal((await cashbackSummary(h.store))[0].accruedAmount, '0'); assert.equal(h.calls.filter(c => c.method === 'getTransaction').length, 0);
});

test('claims for another account or Main wallet never accrue to the reader', async t => {
  for (const field of ['accountId', 'mainWallet', 'evidenceAccountId']) await t.test(field, async t => {
    const h = await harness(t), { receipt, tx } = await h.claim();
    if (field === 'evidenceAccountId') receipt.evidence.accountId = 'another-account'; else receipt[field] = field === 'mainWallet' ? address() : 'another-account';
    await h.store.write('live', { feeReceipts: [receipt] }); h.transactions.set(receipt.signature, tx); await h.verifier().tick();
    assert.equal((await cashbackSummary(h.store))[0].accruedAmount, '0');
  });
});

test('paper receipts and paper ledgers never create payable cashback or host verification requests', async t => {
  const h = await harness(t), { receipt } = await h.claim();
  await h.store.write('live', { feeReceipts: [{ ...receipt, mode: 'paper', status: 'simulated' }] });
  await h.store.write('paper', { feeReceipts: [receipt] }); await h.store.write('portfolio-paper', { feeReceipts: [receipt] });
  await h.verifier().tick(); assert.deepEqual(await cashbackSummary(h.store), []); assert.equal(h.calls.length, 0);
});

test('cashback verification and deduplication survive restart without recounting or re-querying verified signatures', async t => {
  const h = await harness(t), { receipt, tx } = await h.claim();
  await h.store.write('live', { feeReceipts: [receipt, receipt] }); await h.store.write('portfolio-live', { feeReceipts: [receipt] });
  h.transactions.set(receipt.signature, tx); const one = h.verifier(); await one.tick(); await one.tick(); one.close();
  assert.equal(h.calls.filter(c => c.method === 'getTransaction').length, 1); h.reopen();
  const two = h.verifier(); await two.tick(); assert.equal(h.calls.filter(c => c.method === 'getTransaction').length, 1);
  const [summary] = await cashbackSummary(h.store); assert.equal(summary.accruedAmount, '500'); assert.equal(summary.collectedAmount, '2500');
});

test('pending claims respect retry delay and accrue only when finalized host history appears', async t => {
  const h = await harness(t), { receipt, tx } = await h.claim(); await h.store.write('live', { feeReceipts: [receipt] });
  const v = h.verifier(); await v.tick(); h.transactions.set(receipt.signature, tx); await v.tick();
  assert.equal(h.calls.filter(c => c.method === 'getTransaction').length, 1); assert.equal((await cashbackSummary(h.store))[0].accruedAmount, '0');
  h.clock.now += 60001; await v.tick(); assert.equal(h.calls.filter(c => c.method === 'getTransaction').length, 2);
  assert.equal((await cashbackSummary(h.store))[0].accruedAmount, '500');
});

test('a modified journal claim invalidates prior verification and an inflated amount is not accepted', async t => {
  const h = await harness(t), { receipt, tx } = await h.claim(); await h.store.write('live', { feeReceipts: [receipt] }); h.transactions.set(receipt.signature, tx);
  const v = h.verifier(); await v.tick(); assert.equal((await cashbackSummary(h.store))[0].accruedAmount, '500');
  receipt.cashbackAmount = '5000000'; await h.store.write('live', { feeReceipts: [receipt] });
  assert.equal((await cashbackSummary(h.store))[0].accruedAmount, '0'); await v.tick();
  assert.equal((await cashbackSummary(h.store))[0].accruedAmount, '0'); assert.equal((await h.store.read('cashback-verification')).receipts[receipt.signature].status, 'pending');
});

test('encrypted ledgers migrate missing fee arrays and refuse malformed fee collections', async t => {
  const h = await harness(t), legacy = { version: 1, lots: [], pending: [], seen: [], events: [], trades: 0 };
  await h.store.write('live', legacy); const ledger = await new TelegramLedger(h.store, 'live').load(); assert.deepEqual(ledger.data.feeReceipts, []);
  await ledger.save(); assert.deepEqual((await h.store.read('live')).feeReceipts, []);
  await h.store.write('live', { ...legacy, feeReceipts: { forged: true } });
  await assert.rejects(new TelegramLedger(h.store, 'live').load(), /Invalid encrypted platform fee ledger/);
});

test('changing the cashback destination preserves verification of historical identity-bound receipts',async t=>{
  const h=await harness(t),{receipt,tx}=await h.claim();await h.store.write('live',{feeReceipts:[receipt]});h.transactions.set(receipt.signature,tx);
  h.account.cashbackWallet=address();await h.verifier().tick();assert.equal((await cashbackSummary(h.store))[0].accruedAmount,'500');
  const identity=h.account.mainWallet;h.account.cashbackWallet=address();await h.verifier().tick();assert.equal(h.account.mainWallet,identity);assert.equal((await cashbackSummary(h.store))[0].pendingAmount,'500');assert.equal(h.calls.filter(c=>c.method==='getTransaction').length,1);
});
