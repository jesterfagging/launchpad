import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as flush } from 'node:timers/promises';
import { keccak256, parseEther } from 'viem';
import { RobinhoodExecutor } from '../src/robinhood-executor.mjs';
import { createRobinhoodAccount, generateEvmWallets } from '../src/robinhood-settings.mjs';

const venue = '0x4444444444444444444444444444444444444444';
function setup({ ack = async () => {} } = {}) {
  const config = createRobinhoodAccount().settings, wallet = config.wallets[0], abort = new AbortController();
  const ledger = { data: { pending: [], lots: [], feeReceipts: [] }, async save() {} };
  const receipts = new Map(), events = [], applied = [];
  let broadcast = 0, receiptReads = 0, available = false;
  const rpc = { config, client: { getTransactionCount: async () => 0, getBalance: async () => parseEther('10'), getBlock: async () => ({ baseFeePerGas: 1n }), estimateGas: async () => 21000n },
    request: async ({ method, params }) => {
      if (method === 'eth_sendRawTransaction') {
        broadcast++;
        const signature = keccak256(params[0]), pending = ledger.data.pending.find(p => p.signature === signature);
        receipts.set(signature, { transactionHash: signature, from: pending.wallet, to: pending.to, status: '0x1', blockNumber: '0x2', blockHash: '0x1234', logs: [] });
        await ack();
        return signature;
      }
      if (method === 'eth_getTransactionReceipt') { receiptReads++; return available ? receipts.get(params[0]) || null : null; }
      if (method === 'eth_getBlockByNumber') return { hash: '0x1234' };
      throw Error(`Unexpected fixture RPC: ${method}`);
    } };
  const executor = new RobinhoodExecutor(rpc, ledger, { policy: {}, signal: abort.signal,
    event: (level, message, details) => events.push({ level, message, ...details }),
    confirmed: async pending => { if (!applied.includes(pending.signature)) applied.push(pending.signature); ledger.data = structuredClone(ledger.data); } });
  return { wallet, ledger, rpc, executor, abort, receipts, events, applied, plan: { to: venue, data: '0x', value: 0n },
    available: () => { available = true; }, broadcast: () => broadcast, receiptReads: () => receiptReads };
}

async function waitUntil(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await flush();
  assert.ok(predicate(), 'Fixture reached its intended race window');
}
async function finishPolls(t, outcome) {
  for (let i = 0; i < 32 && !outcome.done; i++) { t.mock.timers.tick(1000); await flush(); }
  assert.ok(outcome.done, 'The send operation completed within its polling limit');
  return outcome;
}
function send(s) {
  const outcome = { done: false };
  const task = s.executor.send(s.wallet, s.plan).then(receipt => { outcome.receipt = receipt; }, error => { outcome.error = error; }).finally(() => { outcome.done = true; });
  return { outcome, task };
}

test('a background-confirmed receipt reaches the sleeping sender after the pending journal entry is removed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup(), { outcome, task } = send(s);
  await waitUntil(() => s.receiptReads() === 1); await flush();
  s.available(); await s.executor.reconcileAll();
  assert.equal(s.ledger.data.pending.length, 0); assert.equal(s.applied.length, 1);
  await finishPolls(t, outcome); await task;
  assert.equal(outcome.error, undefined, outcome.error?.message);
  assert.equal(outcome.receipt.status, '0x1'); assert.equal(s.broadcast(), 1); assert.equal(s.applied.length, 1);
  assert.equal(s.events.filter(event => event.level === 'confirmed').length, 1);
});

test('five wallet senders all receive background receipts once with no additional broadcasts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const s = setup();
  const sends = generateEvmWallets(5, [], 'market').map(wallet => send({ ...s, wallet }));
  await waitUntil(() => s.receiptReads() >= 5); await flush(); s.available(); await s.executor.reconcileAll();
  assert.equal(s.ledger.data.pending.length, 0);
  for (const { outcome, task } of sends) { await finishPolls(t, outcome); await task; assert.equal(outcome.error, undefined); assert.equal(outcome.receipt.status, '0x1'); }
  assert.equal(s.broadcast(), 5); assert.equal(s.applied.length, 5); assert.equal(s.executor.receiptWaiters.size, 0);
});
test('a verified receipt wins over a lost RPC acknowledgment', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let rejectAck;
  const ack = new Promise((_, reject) => { rejectAck = reject; }), s = setup({ ack: () => ack }), { outcome, task } = send(s);
  await waitUntil(() => s.broadcast() === 1); s.available(); await s.executor.reconcileAll(); rejectAck(Error('Lost acknowledgment'));
  await waitUntil(() => outcome.done); await task;
  assert.equal(outcome.error, undefined); assert.equal(s.broadcast(), 1); assert.equal(s.applied.length, 1);
  assert(!s.events.some(e => e.level === 'warn'));
});
test('a background-confirmed revert is reported as a revert, never a successful fill', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const s = setup(), { outcome, task } = send(s);
  await waitUntil(() => s.receiptReads() === 1); await flush(); s.receipts.values().next().value.status = '0x0'; s.available(); await s.executor.reconcileAll();
  await finishPolls(t, outcome); await task;
  assert.match(outcome.error.message, /revert/); assert.equal(s.applied.length, 0); assert.equal(s.broadcast(), 1); assert.equal(s.ledger.data.pending.length, 0);
});
test('receipt save failures keep the wallet pending until accounting is durable', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const s = setup(), { outcome, task } = send(s);
  await waitUntil(() => s.receiptReads() === 1); await flush(); s.available(); let fail = true; s.ledger.save = async () => { if (fail) throw Error('Fixture disk failure'); };
  await assert.rejects(s.executor.reconcile(s.ledger.data.pending[0]), /disk failure/);
  assert.equal(s.ledger.data.pending.length, 1); assert.equal(s.executor.receiptWaiters.values().next().value.receipt, null);
  t.mock.timers.tick(1000); await flush(); assert.equal(outcome.done, false);
  fail = false; await s.executor.reconcileAll(); await finishPolls(t, outcome); await task;
  assert.equal(outcome.error, undefined); assert.equal(s.applied.length, 1); assert.equal(s.broadcast(), 1);
});
test('a mismatched receipt remains pending and cannot wake the sender as confirmed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const s = setup(), { outcome, task } = send(s);
  await waitUntil(() => s.receiptReads() === 1); await flush(); s.receipts.values().next().value.from = venue; s.available();
  await s.executor.reconcileAll(); await finishPolls(t, outcome); await task;
  assert.match(outcome.error.message, /unresolved/); assert.equal(s.ledger.data.pending.length, 1); assert.equal(s.applied.length, 0); assert.equal(s.broadcast(), 1); assert.equal(s.executor.receiptWaiters.size, 0);
});
