import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryFingerprint, reconcileTrackedLots } from '../src/position-sync.mjs';

const row = (id, remaining, extra = {}) => ({ id, wallet: 'wallet-one', mint: 'mint-one', mode: 'live', original: String(remaining), remaining: String(remaining), confirmedSlot: 100, ...extra });
const ledger = lots => ({ data: { lots, pending: [], trades: 7, feeReceipts: [{ signature: 'previous-trade' }] } });
const synchronize = (value, balance, extra = {}) => reconcileTrackedLots(value, { wallet: 'wallet-one', mint: 'mint-one', balance, slot: 110, source: 'manual-refresh', ...extra });

test('three stale lots reconcile to the available balance with exact proportional allocation and a separate audit', () => {
  const basis = { inputAmount: '10000000', inputMint: 'sol' };
  const l = ledger([row('first', 329296827244n, { costBasis: basis }), row('second', 331208783619n), row('third', 331208783391n)]);
  const originals = l.data.lots.map(lot => lot.original), fees = structuredClone(l.data.feeReceipts);
  const result = synchronize(l, 331208783391n);
  assert.equal(result.before, 991714394254n);
  assert.equal(result.after, 331208783391n);
  assert.equal(result.removed, 660505610863n);
  assert.equal(l.data.lots.reduce((sum, lot) => sum + BigInt(lot.remaining), 0n), result.after);
  let gross = 0n, allocated = 0n;
  l.data.lots.forEach(lot => {
    gross += BigInt(lot.original);
    const target = gross * result.after / result.before;
    assert.equal(BigInt(lot.remaining), target - allocated); allocated = target;
    assert.equal(lot.lastBalanceSlot, 110); assert.equal(lot.externalAdjusted, true);
  });
  assert.deepEqual(l.data.lots.map(lot => lot.original), originals);
  assert.equal(l.data.lots[0].costBasis, basis);
  assert.deepEqual(l.data.feeReceipts, fees); assert.equal(l.data.trades, 7);
  assert.equal(l.data.positionAdjustments.length, 1);
  assert.deepEqual(l.data.positionAdjustments[0], { wallet: 'wallet-one', mint: 'mint-one', before: '991714394254', after: '331208783391', externalRemoved: '660505610863', slot: 110, source: 'manual-refresh', at: result.adjustment.at });
  assert(Number.isSafeInteger(result.adjustment.at));
});

test('tiny balances allocate exact raw units; zero balance retains closed lots and acquisition history', () => {
  const l = ledger([row('a', 1), row('b', 1), row('c', 1)]);
  synchronize(l, 1n);
  assert.deepEqual(l.data.lots.map(lot => lot.remaining), ['0', '0', '1']);
  const result = synchronize(l, 0n, { slot: 111 });
  assert.equal(result.removed, 1n); assert.equal(l.data.lots.length, 3);
  assert(l.data.lots.every(lot => lot.remaining === '0' && lot.original === '1' && lot.lastBalanceSlot === 111));
  assert.equal(l.data.positionAdjustments.length, 2);
  assert.equal(synchronize(l, 0n, { slot: 112 }).changed, false);
  assert.equal(l.data.positionAdjustments.length, 2);
});

test('unchanged balances and external deposits never grow lots; missing freshness anchors are written only once', () => {
  for (const balance of [5n, 50n]) {
    const l = ledger([row('a', 2, { confirmedSlot: undefined }), row('b', 3, { confirmedSlot: undefined })]);
    assert.deepEqual(synchronize(l, balance), { changed: false, updated: true, before: 5n, after: 5n, removed: 0n });
    assert.deepEqual(l.data.lots.map(lot => lot.remaining), ['2', '3']);
    assert(l.data.lots.every(lot => lot.lastBalanceSlot === 110 && lot.externalAdjusted === undefined));
    assert.equal(l.data.positionAdjustments, undefined);
    const anchored = structuredClone(l);
    assert.deepEqual(synchronize(l, balance, { slot: 120 }), { changed: false, updated: false, before: 5n, after: 5n, removed: 0n });
    assert.deepEqual(l, anchored);
  }
  const empty = ledger([]), before = structuredClone(empty);
  assert.equal(synchronize(empty, 123n).changed, false); assert.deepEqual(empty, before);
  const anchored = ledger([row('new-fill', 5)]), original = structuredClone(anchored);
  assert.equal(synchronize(anchored, 5n).updated, false);
  assert.deepEqual(anchored, original, 'confirmed fills need no extra disk write during a normal sell');
});

test('paper lots, other wallets and other mints are untouched; legacy live lots can reconcile', () => {
  const paper = row('paper', 200, { mode: 'paper', confirmedSlot: 999 }), otherWallet = row('other-wallet', 300, { wallet: 'wallet-two' }), otherMint = row('other-mint', 400, { mint: 'mint-two' });
  const excluded = structuredClone([paper, otherWallet, otherMint]);
  const legacy = row('legacy', 100); delete legacy.mode;
  const l = ledger([legacy, paper, otherWallet, otherMint]);
  assert.equal(synchronize(l, 25n).removed, 75n);
  assert.deepEqual(l.data.lots.slice(1), excluded);
  assert.equal(l.data.lots[0].remaining, '25');
});

test('pending transactions and stale snapshots fail before mutation, including closed-lot slot floors', () => {
  for (const pending of [{ wallet: 'wallet-one', order: { inputMint: 'mint-one' } }, { wallet: 'wallet-one', order: { inputMint: 'another-mint' } }]) {
    const l = ledger([row('a', 10)]); l.data.pending.push(pending); const before = structuredClone(l);
    assert.throws(() => synchronize(l, 1n), /pending wallet transaction/); assert.deepEqual(l, before);
  }
  for (const extra of [{ confirmedSlot: 120 }, { lastBalanceSlot: 120 }]) {
    const l = ledger([row('closed', 0, extra), row('active', 10)]), before = structuredClone(l);
    assert.throws(() => synchronize(l, 1n), /predates/); assert.deepEqual(l, before);
  }
  const l = ledger([row('a', 10)]); l.data.pending.push({ wallet: 'wallet-two' });
  assert.equal(synchronize(l, 1n).changed, true);
});

test('invalid inputs or malformed tracked rows cannot partially mutate the ledger', () => {
  for (const [balance, extra] of [[-1n, {}], ['1', {}], [1n, { slot: NaN }], [1n, { slot: -1 }], [1n, { slot: 1.5 }], [1n, { slot: Number.MAX_SAFE_INTEGER + 1 }], [1n, { source: '' }]]) {
    const l = ledger([row('a', 10)]), before = structuredClone(l);
    assert.throws(() => synchronize(l, balance, extra)); assert.deepEqual(l, before);
  }
  for (const extra of [{ remaining: '-1' }, { remaining: '1.1' }, { remaining: 9007199254740992 }, { confirmedSlot: '100' }, { lastBalanceSlot: NaN }]) {
    const l = ledger([row('valid', 10), row('invalid', 5, extra)]), before = structuredClone(l);
    assert.throws(() => synchronize(l, 1n)); assert.deepEqual(l, before);
  }
});

test('audit retention is bounded without rewriting previous entries', () => {
  const l = ledger([row('a', 10)]);
  l.data.positionAdjustments = Array.from({ length: 1000 }, (_, index) => ({ marker: index }));
  const previous = l.data.positionAdjustments.at(-1);
  synchronize(l, 1n);
  assert.equal(l.data.positionAdjustments.length, 1000);
  assert.equal(l.data.positionAdjustments[0].marker, 1);
  assert.equal(l.data.positionAdjustments.at(-2), previous);
  assert.equal(l.data.positionAdjustments.at(-1).externalRemoved, '9');
});

test('inventory fingerprints ignore reordering and unrelated inventory but detect attribution and freshness changes', () => {
  const lots = [row('b', 20), row('a', 10), row('other', 30, { wallet: 'wallet-two' })];
  const fingerprint = inventoryFingerprint(lots, 'wallet-one', 'mint-one');
  assert.equal(inventoryFingerprint([...lots].reverse(), 'wallet-one', 'mint-one'), fingerprint);
  lots[2].remaining = '0';
  assert.equal(inventoryFingerprint(lots, 'wallet-one', 'mint-one'), fingerprint);
  for (const extra of [{ remaining: '19' }, { original: '21' }, { confirmedSlot: 101 }, { lastBalanceSlot: 105 }, { mode: 'paper' }]) {
    const changed = lots.map(lot => lot.id === 'b' ? { ...lot, ...extra } : lot);
    assert.notEqual(inventoryFingerprint(changed, 'wallet-one', 'mint-one'), fingerprint);
  }
  assert.notEqual(inventoryFingerprint(lots.slice(1), 'wallet-one', 'mint-one'), fingerprint);
  assert.notEqual(inventoryFingerprint([...lots, row('new', 1)], 'wallet-one', 'mint-one'), fingerprint);
});
