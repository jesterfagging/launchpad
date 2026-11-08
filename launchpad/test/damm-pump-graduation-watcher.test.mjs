import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Keypair, PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { CP_AMM_PROGRAM_ID, getAmountsForModifyForConcentratedLiquidity, Rounding } from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import { DammPumpFeeClientAdapter } from '../src/damm-pump-fee-chain.mjs';
import { createDammPumpGraduationWatcher } from '../src/damm-pump-graduation-watcher.mjs';

const key = () => Keypair.generate().publicKey.toBase58();
const flush = () => new Promise(resolve => setImmediate(resolve));
function encodePool(adapter, pool) {
  const coder = adapter.cp._program.coder.accounts, buffer = Buffer.alloc(4096);
  const length = coder.accountLayouts.get('pool').layout.encode(pool, buffer);
  return Buffer.concat([coder.accountDiscriminator('pool'), buffer.subarray(0, length)]);
}
const captured = JSON.parse(await readFile(new URL('../contracts/curve-pump-public/tests/fixtures/damm-pump/controller-initialized.json', import.meta.url)));
async function fixture(t) {
  const callbacks = new Map(), removed = [], hints = [], commitments = [];
  let nextId = 0, reads = 0;
  const connection = {
    onAccountChange(pool, callback, commitment) { commitments.push(commitment); callbacks.set(++nextId, callback); return nextId; },
    async removeAccountChangeListener(id) { removed.push(id); callbacks.delete(id); },
  };
  const adapter = new DammPumpFeeClientAdapter({ connection, now: () => 1790000000000 });
  const config = { programId: '5F4tt5fQwSR9ymzx5KiYL4Q2Ln8FJxbMfbXD1HhMgUrw' };
  const launch = { mint: key(), publicProgramId: config.programId, creatorWallet: key(), quoteMint: String(NATIVE_MINT),
    quoteDecimals: 9, quoteTokenProgram: String(TOKEN_PROGRAM_ID), status: 'trading', confirmationStatus: 'finalized', priceSnapshot: { quoteUsdMicros: '117240000' } };
  const addresses = adapter.launchAddresses(config, launch), model = adapter.model(launch);
  const state = { phase: 0, mint: launch.mint, quoteMint: launch.quoteMint, dammPool: String(addresses.dammPool),
    sqrtMinPrice: model.sqrtMinPrice, sqrtMaxPrice: model.sqrtMaxPrice, liquidity: model.liquidity, expectedQuote: model.finalQuote };
  adapter.rawState = async (_config, _launch, commitment) => { reads++; assert.equal(commitment, 'finalized'); return { state, addresses, slot: 100 }; };
  const watcher = createDammPumpGraduationWatcher({ adapter, onHint: hint => hints.push(hint) });
  t.after(() => watcher.close());
  async function account(remaining = 100000000n, overrides = {}) {
    const pool = adapter.cp._program.coder.accounts.decode('pool', Buffer.from(captured.accounts.dammPool.data, 'base64'));
    Object.assign(pool, { tokenAMint: new PublicKey(launch.mint), tokenBMint: NATIVE_MINT,
      sqrtMinPrice: new BN(model.sqrtMinPrice), sqrtMaxPrice: new BN(model.sqrtMaxPrice),
      sqrtPrice: new BN(String(BigInt(model.sqrtMaxPrice) - remaining * (1n << 128n) / BigInt(model.liquidity))),
      liquidity: new BN(model.liquidity), activationType: 0, activationPoint: new BN(0), poolStatus: 0 });
    pool.poolFees.initSqrtPrice = new BN(model.sqrtMinPrice);
    [pool.tokenAAmount, pool.tokenBAmount] = getAmountsForModifyForConcentratedLiquidity(pool.sqrtPrice, pool.sqrtMinPrice, pool.sqrtMaxPrice, pool.liquidity, Rounding.Down);
    return { owner: CP_AMM_PROGRAM_ID, executable: false, data: encodePool(adapter, pool), ...overrides };
  }
  const rows = () => [{ launch, config }];
  const emit = (value, slot = 101) => { for (const callback of callbacks.values()) callback(value, { slot }); };
  return { adapter, connection, watcher, launch, config, state, callbacks, removed, hints, commitments, account, rows, emit, reads: () => reads };
}

test('real SDK near-end quote and exact endpoint notify once; repeated changes coalesce', async t => {
  const f = await fixture(t); await f.watcher.sync(f.rows());
  assert.deepEqual(f.commitments, ['confirmed']); assert.equal(f.reads(), 1);
  const near = await f.account(); f.emit(near); f.emit(near); f.emit(near, 102); await flush();
  assert.deepEqual(f.hints, [{ mint: f.launch.mint, slot: 102 }]);
  f.emit(near, 102); await flush(); assert.equal(f.hints.length, 1);
  f.emit(await f.account(0n), 103); await flush(); assert.equal(f.hints.length, 2);
  await f.watcher.sync(f.rows()); assert.equal(f.reads(), 1); assert.equal(f.callbacks.size, 1);
});

test('old slots, wrong owners, malformed pools and above-cap remainders cannot wake the finisher', async t => {
  const f = await fixture(t); await f.watcher.sync(f.rows());
  f.emit(await f.account(), 99); f.emit(await f.account(100000000n, { owner: new PublicKey(key()) }));
  f.emit(await f.account(100000000n, { executable: true })); f.emit({ owner: CP_AMM_PROGRAM_ID, data: Buffer.alloc(10) });
  f.emit(await f.account(1000000000n)); await flush(); assert.equal(f.hints.length, 0);
  // A later transaction in the same slot must not lose the small finish window.
  f.emit(await f.account(100000000n), 101); await flush(); assert.equal(f.hints.length, 1);
});

test('notifications must match the immutable finalized pool identity and fee policy', async t => {
  const f = await fixture(t); await f.watcher.sync(f.rows());
  const wrong = await f.account(), decoded = f.adapter.cp._program.coder.accounts.decode('pool', wrong.data);
  decoded.tokenAMint = new PublicKey(key()); wrong.data = encodePool(f.adapter, decoded);
  f.emit(wrong); await flush(); assert.equal(f.hints.length, 0);
  decoded.tokenAMint = new PublicKey(f.launch.mint); decoded.poolStatus = 1;
  wrong.data = encodePool(f.adapter, decoded); f.emit(wrong);
  await flush(); assert.equal(f.hints.length, 0);
});

test('migrated and removed launches unsubscribe; close suppresses queued and late events', async t => {
  const f = await fixture(t); await f.watcher.sync(f.rows()); const late = [...f.callbacks.values()][0];
  f.launch.status = 'migrated'; await f.watcher.sync(f.rows()); assert.deepEqual(f.removed, [1]);
  late(await f.account(), { slot: 101 }); await flush(); assert.equal(f.hints.length, 0);
  f.launch.status = 'trading'; await f.watcher.sync(f.rows()); f.emit(await f.account()); await f.watcher.close();
  await flush(); assert.equal(f.hints.length, 0); assert.equal(f.callbacks.size, 0);
  await f.watcher.sync(f.rows()); assert.equal(f.callbacks.size, 0);
});

test('unavailable subscriptions and nonfinalized/non-SOL registrations fall back without throwing', async t => {
  const f = await fixture(t); f.connection.onAccountChange = () => { throw Error('websocket unavailable'); };
  await assert.doesNotReject(f.watcher.sync(f.rows())); assert.equal(f.callbacks.size, 0);
  f.launch.confirmationStatus = 'confirmed'; await f.watcher.sync(f.rows()); assert.equal(f.reads(), 1);
  f.launch.confirmationStatus = 'finalized'; f.launch.quoteMint = key(); await f.watcher.sync(f.rows()); assert.equal(f.reads(), 1);
  const absent = createDammPumpGraduationWatcher({ adapter: { connection: {} }, onHint() { throw Error('unexpected'); } });
  await absent.sync(f.rows()); await absent.close();
});

test('concurrent registration changes cannot install an obsolete subscription after close', async t => {
  const f = await fixture(t); let release;
  const base = f.adapter.rawState; f.adapter.rawState = async (...args) => { await new Promise(resolve => { release = resolve; }); return base(...args); };
  const pending = f.watcher.sync(f.rows()); await f.watcher.close(); release(); await pending;
  assert.equal(f.callbacks.size, 0); assert.equal(f.hints.length, 0);
});
