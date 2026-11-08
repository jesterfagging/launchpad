import test from 'node:test';
import assert from 'node:assert/strict';
import { heliusEndpoint, programAccountsPaged, wantsPagination } from '../src/rpc-program-accounts.mjs';

const PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const b64 = text => Buffer.from(text).toString('base64');
function fakeConnection(pages, { error = null } = {}) {
  const calls = [];
  return { calls, slot: 101, rpcEndpoint: 'https://mainnet.helius-rpc.com/?api-key=x', _rpcRequest: async (method, params) => { calls.push({ method, params }); if (error) return { error }; const page = pages[calls.length - 1]; return { jsonrpc: '2.0', result: { context: { slot: 100 + calls.length }, value: page } }; } };
}

test('Helius endpoints are recognised from the connection URL only; the provider refusal is recognised by its wording', () => {
  assert.equal(heliusEndpoint({ rpcEndpoint: 'https://mainnet.helius-rpc.com/?api-key=abc' }), true);
  assert.equal(heliusEndpoint({ rpcEndpoint: 'https://devnet.helius-rpc.com/?api-key=abc' }), true);
  assert.equal(heliusEndpoint({ rpcEndpoint: 'http://mainnet.helius-rpc.com/' }), false, 'https only');
  assert.equal(heliusEndpoint({ rpcEndpoint: 'https://solana-mainnet.core.chainstack.com/abc' }), false);
  assert.equal(heliusEndpoint({}), false); assert.equal(heliusEndpoint(null), false);
  assert.equal(wantsPagination(Error('failed to get accounts owned by program 6EF8…: Too many accounts requested (10000001 pubkeys), Please use getProgramAccountsV2 with pagination to handle large data')), true);
  assert.equal(wantsPagination(Error('429 Too Many Requests')), false); assert.equal(wantsPagination(null), false);
});

test('pages are read until the explicit null cursor, filters and encoding pass through, duplicates keep the last copy', async () => {
  const c = fakeConnection([
    { accounts: [{ pubkey: 'A', account: { data: [b64('a1'), 'base64'] } }, { pubkey: 'B', account: { data: [b64('b'), 'base64'] } }], paginationKey: 'cursor-1' },
    { accounts: [{ pubkey: 'A', account: { data: [b64('a2'), 'base64'] } }], paginationKey: 'cursor-2' },
    { accounts: [], paginationKey: null },
  ]);
  const filters = [{ memcmp: { offset: 0, bytes: 'xyz' } }];
  const pages = [];
  const rows = await programAccountsPaged(c, PROGRAM, { commitment: 'confirmed', encoding: 'base64', filters }, { onPage: page => pages.push(page) });
  assert.deepEqual(rows.map(r => [r.pubkey, r.data.toString()]), [['A', 'a2'], ['B', 'b']]);
  assert.equal(c.calls.length, 3); assert.equal(c.calls[0].method, 'getProgramAccountsV2'); assert.equal(c.calls[0].params[0], PROGRAM);
  assert.deepEqual(c.calls[0].params[1], { encoding: 'base64', commitment: 'confirmed', filters, withContext: true, limit: 10000 });
  assert.equal(c.calls[1].params[1].paginationKey, 'cursor-1'); assert.equal(c.calls[2].params[1].paginationKey, 'cursor-2');
  assert.equal(c.calls[0].params[1].paginationKey, undefined, 'the first page has no cursor');
  assert.equal(c.calls[0].params[1].changedSinceSlot, undefined, 'a full read has no slot cursor');
  assert.deepEqual(pages.map(p => [p.page, p.accounts, p.matched]), [[1, 2, 2], [2, 1, 2], [3, 0, 2]]);
  assert.equal(rows.contextSlot, c.slot, 'the read carries the slot of its first page');
});

test('an incremental read passes changedSinceSlot on every page; a rate-limited page is retried', async () => {
  const c = fakeConnection([{ accounts: [{ pubkey: 'A', account: { data: [b64('a'), 'base64'] } }], paginationKey: 'k1' }, { accounts: [], paginationKey: null }]);
  const rows = await programAccountsPaged(c, PROGRAM, { filters: [] }, { changedSinceSlot: 123456 });
  assert.equal(rows.length, 1); assert.equal(c.calls[0].params[1].changedSinceSlot, 123456); assert.equal(c.calls[1].params[1].changedSinceSlot, 123456);
  let failures = 0; const flaky = fakeConnection([{ accounts: [], paginationKey: null }]); const request = flaky._rpcRequest;
  flaky._rpcRequest = async (...args) => { if (failures++ < 2) throw Error('429 Too Many Requests'); return request(...args); };
  const out = await programAccountsPaged(flaky, PROGRAM, {}, { retries: 3 }); assert.equal(out.length, 0); assert.equal(failures, 3);
  await assert.rejects(programAccountsPaged(fakeConnection([{ accounts: [], paginationKey: 'k' }, { accounts: [], paginationKey: 'k2' }, { accounts: [], paginationKey: 'k3' }]), PROGRAM, {}, { maxPages: 2 }), /exceeded the page limit/);
});

test('an invalid page, account, repeated cursor, provider error or missing transport fails instead of returning a partial list', async () => {
  await assert.rejects(programAccountsPaged(fakeConnection([{ accounts: 'nope', paginationKey: null }]), PROGRAM), /invalid page/);
  await assert.rejects(programAccountsPaged(fakeConnection([{ accounts: [{ pubkey: 'A', account: { data: 'raw' } }], paginationKey: null }]), PROGRAM), /invalid account/);
  await assert.rejects(programAccountsPaged(fakeConnection([{ accounts: [], paginationKey: 'k' }, { accounts: [], paginationKey: 'k' }]), PROGRAM), /repeated cursor/);
  await assert.rejects(programAccountsPaged(fakeConnection([], { error: { code: -32602, message: 'bad params' } }), PROGRAM), /getProgramAccountsV2 failed: bad params/);
  await assert.rejects(programAccountsPaged({ rpcEndpoint: 'https://mainnet.helius-rpc.com/' }, PROGRAM), /transport does not offer/);
});

test('an aborted signal stops the read between pages with an AbortError and no further requests', async () => {
  const c = fakeConnection([
    { accounts: [{ pubkey: 'A', account: { data: [b64('a'), 'base64'] } }], paginationKey: 'cursor-1' },
    { accounts: [{ pubkey: 'B', account: { data: [b64('b'), 'base64'] } }], paginationKey: 'cursor-2' },
    { accounts: [], paginationKey: null },
  ]);
  const abort = new AbortController();
  const read = programAccountsPaged(c, PROGRAM, {}, { signal: abort.signal, onPage: ({ page }) => { if (page === 1) abort.abort(); } });
  await assert.rejects(read, error => error.name === 'AbortError');
  assert.equal(c.calls.length, 1, 'no page is requested after the abort');
  await assert.rejects(programAccountsPaged(c, PROGRAM, {}, { signal: AbortSignal.abort() }), error => error.name === 'AbortError');
  assert.equal(c.calls.length, 1, 'an already aborted signal makes no request at all');
});
