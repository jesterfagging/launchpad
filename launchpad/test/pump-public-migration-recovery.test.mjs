import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { PumpPublicService, PUMP_PUBLIC_TREASURY } from '../src/pump-public-service.mjs';
import { verifySignedTransaction } from '../src/providers.mjs';

// Service-level recovery uses deterministic mock chain receipts, real Ed25519
// signatures, production journal transitions over an in-memory host-store
// substitute, and the actual Linux commit lock.
// Actual PumpSwap execution/burn behavior is covered separately by the VM suite.
const clone = value => structuredClone(value);
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-public-migration-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const relay = Keypair.generate(), creator = Keypair.generate();
  const program = Keypair.generate().publicKey, mint = Keypair.generate().publicKey.toBase58();
  let now = 1_790_000_000_000;
  let db = {
    schemaVersion: 1,
    config: { programId: program.toBase58(), relayer: relay.publicKey.toBase58(), treasury: PUMP_PUBLIC_TREASURY, cluster: 'mainnet-beta' },
    relayer: { address: relay.publicKey.toBase58(), secretBase64: Buffer.from(relay.secretKey).toString('base64') },
    launches: [{ id: 'launch', mint, creatorId: 'creator', creatorWallet: creator.publicKey.toBase58(), status: 'bonded', confirmationStatus: 'finalized', creatorFeesPending: '0' }],
    operations: [], enabled: true, migrationCursor: 0
  };
  const observed = { prepares: 0, sends: 0, reconciles: 0, wires: [] };
  let receipt = { state: 'pending' }, phase = 'bonded';
  const accounts = { dir, hostStore: { read: async () => clone(db), write: async (_key, value) => { db = clone(value); } } };
  const adapter = {
    verifyDeployment: async () => ({ enabled: true }),
    balance: async () => '10000000',
    state: async () => ({ phase, creatorFeesPending: '0', creatorFeesPaid: '0' }),
    prepare: async (_config, args) => {
      assert.equal(args.action, 'migrate');
      assert.equal(args.wallet, relay.publicKey.toBase58());
      assert.notEqual(args.wallet, creator.publicKey.toBase58());
      observed.prepares++;
      const tx = new VersionedTransaction(new TransactionMessage({
        payerKey: relay.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(),
        instructions: [new TransactionInstruction({ programId: program,
          keys: [{ pubkey: relay.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([3, observed.prepares, 0]) })]
      }).compileToV0Message());
      return { unsignedTransaction: Buffer.from(tx.serialize()).toString('base64'), lastValidBlockHeight: 100 + observed.prepares };
    },
    send: async (_config, wire) => {
      observed.sends++; observed.wires.push(wire);
      const persisted = db.operations.find(op => op.signedTransaction === wire);
      assert.equal(persisted?.state, 'journaled', 'Signed bytes must be saved before any ambiguous send');
      const tx = VersionedTransaction.deserialize(Buffer.from(wire, 'base64'));
      verifySignedTransaction(Buffer.from(wire, 'base64'), relay.publicKey.toBase58());
      assert.equal(persisted.signature, bs58.encode(tx.signatures[0]));
      throw Error('RPC timeout after possible broadcast');
    },
    reconcile: async (_config, op) => {
      observed.reconciles++;
      assert.equal(op.signedTransaction, db.operations.find(saved => saved.id === op.id)?.signedTransaction);
      return clone(receipt);
    }
  };
  const services = [];
  function restart() {
    for (const service of services) service.closed = true;
    const service = new PumpPublicService({ accounts, adapter, now: () => now });
    services.push(service); return service;
  }
  t.after(() => { for (const service of services) service.closed = true; });
  return { restart, adapter, observed, read: () => clone(db), advance: (ms = 30001) => { now += ms; },
    receipt: value => { receipt = value; }, phase: value => { phase = value; } };
}

test('ambiguous migration send survives restart without a second transaction or repeated broadcast', async t => {
  const f = await fixture(t);
  await f.restart().tick();
  const original = f.read().operations[0];
  assert.equal(original.action, 'migrate'); assert.equal(original.state, 'pending');
  assert.equal(f.observed.sends, 1);
  f.advance();
  const restarted = f.restart();
  await restarted.tick(); f.advance(); await restarted.tick();
  const saved = f.read().operations;
  assert.equal(saved.length, 1); assert.equal(saved[0].signedTransaction, original.signedTransaction);
  assert.equal(saved[0].signature, original.signature);
  assert.equal(f.observed.prepares, 1); assert.equal(f.observed.sends, 1); assert.equal(f.observed.reconciles, 2);
});

test('journaled migration recovers after a crash before broadcast without preparing another pool', async t => {
  const f = await fixture(t), initial = f.restart();
  initial.markBroadcast = async () => { throw Error('Host terminated after durable signing'); };
  await initial.tick();
  const original = f.read().operations[0];
  assert.equal(original.state, 'journaled'); assert.equal(f.observed.sends, 0);
  f.advance(); await f.restart().tick();
  assert.equal(f.read().operations.length, 1);
  assert.equal(f.read().operations[0].signature, original.signature);
  assert.equal(f.observed.prepares, 1); assert.equal(f.observed.sends, 0);
});

test('a conclusively expired migration becomes terminal and permits one fresh retry', async t => {
  const f = await fixture(t);
  await f.restart().tick();
  const original = f.read().operations[0];
  f.receipt({ state: 'expired', reason: 'Finalized block height exceeded validity and blockhash is invalid; no signature status.' });
  f.advance();
  const restarted = f.restart(); await restarted.tick();
  const operations = f.read().operations;
  assert.equal(operations.length, 2); assert.equal(operations[0].state, 'expired');
  assert.equal(operations[0].signedTransaction, original.signedTransaction);
  assert.equal(operations[1].state, 'pending'); assert.notEqual(operations[1].signature, original.signature);
  assert.equal(f.observed.prepares, 2); assert.equal(f.observed.sends, 2);
  f.receipt({ state: 'pending' }); f.advance(); await restarted.tick();
  assert.equal(f.read().operations.length, 2); assert.equal(f.observed.sends, 2);
});

test('a finalized migration stores its burn receipt and never migrates again after restart', async t => {
  const f = await fixture(t);
  await f.restart().tick();
  const original = f.read().operations[0], poolId = Keypair.generate().publicKey.toBase58();
  const receipt = { state: 'finalized', phase: 'migrated', poolId, lpBurned: '512870391664', creatorFeesPending: '0', creatorFeesPaid: '100' };
  f.receipt(receipt); f.phase('migrated'); f.advance();
  await f.restart().tick();
  const launch = f.read().launches[0];
  assert.equal(launch.status, 'migrated'); assert.equal(launch.poolId, poolId);
  assert.equal(launch.migrationSignature, original.signature); assert.deepEqual(launch.burnReceipt, receipt);
  assert.equal(f.read().operations[0].state, 'finalized');
  f.advance(); const restarted = f.restart(); await restarted.tick(); f.advance(); await restarted.tick();
  assert.equal(f.observed.prepares, 1); assert.equal(f.observed.sends, 1); assert.equal(f.observed.reconciles, 1);
});

test('a merely confirmed migration cannot mark LP burned or authorize a replacement', async t => {
  const f = await fixture(t), service = f.restart(); await service.tick();
  f.receipt({ state: 'confirmed', phase: 'migrated', lpBurned: '512870391664' });
  const db = f.read();
  await assert.rejects(service.receiptOutsideLock(db, db.operations[0]), /Only initialization supports early confirmation/);
  assert.equal(f.read().launches[0].status, 'bonded'); assert.equal(f.read().launches[0].burnReceipt, undefined);
  assert.equal(f.read().operations[0].state, 'pending');
  f.advance(); await f.restart().tick();
  assert.equal(f.observed.prepares, 1); assert.equal(f.observed.sends, 1);
});
