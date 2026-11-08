// The treasury route (Pump.fun pair dev buys, fee conversions, Gotchi and AI
// Agent purchases) audits its Jupiter route at confirmed state, then reads the
// wallet at finalized state at least that new. Finalized state trails confirmed
// by about 32 slots, and a Solana RPC answers such a read with -32016 at once:
// the snapshot must wait for finalization instead of failing every time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolTreasuryChain } from '../src/protocol-treasury-chain.mjs';

function rpc({ finalized = 1000, step = 3, behindWithoutError = false, fail = null } = {}) {
  const state = { finalized, reads: 0, sleeps: 0, asked: [] };
  state.c = {
    async getMultipleAccountsInfoAndContext(keys, { commitment, minContextSlot }) {
      state.reads++; state.asked.push(minContextSlot); assert.equal(commitment, 'finalized');
      if (fail) throw fail;
      if (minContextSlot > state.finalized) {
        if (behindWithoutError) return { context: { slot: state.finalized }, value: keys.map(() => null) };
        throw Object.assign(new Error('failed to get info for accounts: Minimum context slot has not been reached'), { code: -32016, data: { contextSlot: state.finalized } });
      }
      return { context: { slot: state.finalized }, value: keys.map(key => ({ key })) };
    },
  };
  state.sleep = async () => { state.sleeps++; state.finalized += step; };
  return state;
}
const snapshot = (state, keys, minimum) => ProtocolTreasuryChain.prototype.finalizedSnapshot.call({ c: state.c, sleep: state.sleep }, keys, minimum);

test('a finalized snapshot waits for finalization to reach the confirmed route slot', async () => {
  const state = rpc();
  const result = await snapshot(state, ['wallet', 'ata'], 1032);
  assert.ok(result.context.slot >= 1032);
  assert.equal(result.value.length, 2);
  assert.equal(state.sleeps, 11, 'about 13 seconds of one-second waits for 32 slots');
  assert.ok(state.asked.every(slot => slot === 1032), 'the lower bound is never dropped');
});

test('an RPC that answers with an older context waits the same way', async () => {
  const state = rpc({ behindWithoutError: true });
  const result = await snapshot(state, ['wallet', 'ata', 'route'], 1010);
  assert.ok(result.context.slot >= 1010); assert.equal(result.value.length, 3); assert.equal(state.sleeps, 4);
});

test('a finalized slot already there reads once; other errors are not waited on', async () => {
  const ready = rpc({ finalized: 2000 });
  assert.equal((await snapshot(ready, ['wallet'], 1500)).context.slot, 2000);
  assert.deepEqual([ready.reads, ready.sleeps], [1, 0]);
  const broken = rpc({ fail: new Error('connection refused') });
  await assert.rejects(snapshot(broken, ['wallet'], 1500), /connection refused/);
  assert.equal(broken.sleeps, 0);
});

test('a briefly busy RPC is ridden out within the same bound; a stopping service is not', async () => {
  const errors = [Object.assign(new Error('RPC is cooling down after a rate limit.'), { retryable: true, rateLimited: true }), Object.assign(new Error('Node is behind by 40 slots'), { code: -32005 }), new Error('Provider connection failed.'), new Error('fetch failed')];
  const state = rpc({ finalized: 2000 }), read = state.c.getMultipleAccountsInfoAndContext;
  let calls = 0; state.c.getMultipleAccountsInfoAndContext = async (...args) => { if (calls < errors.length) throw errors[calls++]; return read(...args); };
  assert.equal((await snapshot(state, ['wallet'], 1500)).context.slot >= 1500, true);
  assert.equal(state.sleeps, errors.length);
  for (const stop of [Object.assign(new Error('Stopped.'), { code: 'ABORT_ERR' }), Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })]) {
    const stopping = rpc({ fail: stop });
    await assert.rejects(snapshot(stopping, ['wallet'], 1500), error => error === stop);
    assert.equal(stopping.sleeps, 0, 'a stopping service is never kept waiting');
  }
  const busy = rpc({ fail: Object.assign(new Error('RPC capacity is busy.'), { capacityLimited: true }) });
  await assert.rejects(snapshot(busy, ['wallet'], 1500), /capacity is busy/); assert.equal(busy.sleeps, 45, 'still bounded');
});

test('the wait is bounded and ends as context lag, which callers retry later', async () => {
  const state = rpc({ step: 0 });
  await assert.rejects(snapshot(state, ['wallet'], 1032), error => error.code === -32016 && /Minimum context slot has not been reached/.test(error.message));
  assert.equal(state.sleeps, 45);
  const quiet = rpc({ step: 0, behindWithoutError: true });
  await assert.rejects(snapshot(quiet, ['wallet'], 1032), error => error.code === -32016);
});

test('the treasury preparation reads its post-route snapshot through the wait, after the route size check', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/protocol-treasury-chain.mjs', import.meta.url), 'utf8');
  const sizeCheck = source.indexOf('if(transactionSize(compile(PublicKey.default.toBase58()))>1232)'), wait = source.indexOf('before=await this.finalizedSnapshot(');
  assert.ok(sizeCheck > 0 && wait > sizeCheck, 'a route too large for one transaction is refused before waiting for finalization');
  assert.match(source, /before=await this\.finalizedSnapshot\(\[owner,ata,\.\.\.monitored\.map\(row=>row\.key\)\],Math\.max\(before\.context\.slot,quote\?\.slot\|\|0\)\);/);
  assert.doesNotMatch(source, /commitment:'finalized',minContextSlot:Math\.max\(before\.context\.slot,quote\?\.slot/, 'no direct finalized read at the confirmed route slot remains');
});
