import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { assertLoopbackRpc, localRequest, readOnlyUpstream, scrubError, startReadOnlyProxy, validateFixture } from '../scripts/robinhood-fork-check.mjs';

const fixture = () => ({ version: 1, chainId: 4663, cases: [{ name: 'fixture only', pool: { protocol: 'v3', address: '0x3333333333333333333333333333333333333333', currency0: '0x1111111111111111111111111111111111111111', currency1: '0x2222222222222222222222222222222222222222', fee: 3000, tickSpacing: 60 }, input: '0x1111111111111111111111111111111111111111', buyRaw: '100000', funding: [{ token: '0x1111111111111111111111111111111111111111', holder: '0x4444444444444444444444444444444444444444', raw: '1000000' }], lp: { amount0Raw: '100', amount1Raw: '100', feeTradeRaw: '10' } }] });

test('fork fixture rejects keys, arbitrary chain IDs, unsafe quantities and invalid funding', () => {
  assert.equal(validateFixture(fixture()).cases[0].ppm, 2500);
  for (const mutate of [f => f.chainId = 1, f => f.privateKey = 'not allowed', f => f.cases[0].privateKey = 'not allowed', f => f.cases[0].buyRaw = 1000, f => f.cases[0].buyRaw = '-1', f => f.cases[0].buyRaw = String(2n ** 128n), f => delete f.cases[0].funding[0].holder, f => f.cases[0].ppm = 0, f => f.cases[0].slippageBps = 9999, f => f.cases[0].funding[0].rpcUrl = 'https://secret.test']) {
    const f = fixture(); mutate(f); assert.throws(() => validateFixture(f));
  }
});
test('signing transport cannot be constructed for a remote or ambiguous destination', async () => {
  for (const url of ['https://rpc.example.com/', 'http://127.0.0.1.evil.test:8545/', 'http://localhost:8545/', 'http://[::1]:8545/', 'https://127.0.0.1:8545/', 'http://user:pass@127.0.0.1:8545/', 'http://127.0.0.1:8545/?next=remote', 'http://127.0.0.1:8545/rpc', 'http://127.0.0.1/']) assert.throws(() => assertLoopbackRpc(url));
  let destination, options;
  const request = localRequest('http://127.0.0.1:12345/', async (url, init) => { destination = url; options = init; return { ok: true, json: async () => ({ result: 'local' }) }; });
  assert.equal(await request({ method: 'eth_sendRawTransaction', params: ['fixture'] }), 'local');
  assert.equal(destination, 'http://127.0.0.1:12345/'); assert.equal(options.redirect, 'error');
});
test('upstream is strictly read-only even when called directly', async () => {
  const calls = [];
  const read = readOnlyUpstream('https://provider.test/?api-key=secret', async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ result: '0x1237' }) }; });
  for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'eth_signTransaction', 'personal_unlockAccount', 'anvil_setBalance', 'anvil_impersonateAccount', 'evm_mine', 'anvil_reset', 'wallet_sendCalls', 'eth_sendBundle']) await assert.rejects(() => read({ method }), /forbidden/);
  assert.equal(calls.length, 0); assert.equal(await read({ method: 'eth_chainId' }), '0x1237');
  assert.equal(calls.length, 1); assert.equal(calls[0].init.redirect, 'error');
});
const post = (url, body) => new Promise((resolve, reject) => {
  const request = httpRequest(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, response => { const chunks = []; response.on('data', c => chunks.push(c)); response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (error) { reject(error); } }); });
  request.on('error', reject); request.end(JSON.stringify(body));
});
test('proxy never forwards mutations, including mixed batches and malformed requests', async () => {
  const forwarded = [], proxy = await startReadOnlyProxy(async call => { forwarded.push(call.method); return '0x1237'; });
  try {
    const result = await post(proxy.url, [{ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }, { jsonrpc: '2.0', id: 2, method: 'eth_sendRawTransaction', params: ['signed'] }, { jsonrpc: '2.0', id: 3, method: 'anvil_setBalance', params: [] }, null]);
    assert.deepEqual(forwarded, ['eth_chainId']); assert.equal(result[0].result, '0x1237');
    for (const entry of result.slice(1)) assert.equal(entry.error.code, -32601);
    await post(proxy.url, { jsonrpc: '2.0', id: 4, method: 'eth_call', params: 'bad' }); assert.deepEqual(forwarded, ['eth_chainId']);
  } finally { await proxy.close(); }
});
test('provider credentials and arbitrary provider error data stay out of reports and proxy replies', async () => {
  const secret = 'https://provider.test/v2/private-api-key';
  const read = readOnlyUpstream(secret, async () => ({ ok: true, json: async () => ({ error: { code: -32000, message: `Rejected ${secret}`, data: { credentials: 'private-api-key' } } }) }));
  await assert.rejects(() => read({ method: 'eth_chainId' }), error => !String(error).includes('private-api-key') && !error.data);
  const proxy = await startReadOnlyProxy(async () => { throw Error(`Failed ${secret}`); });
  try { assert(!JSON.stringify(await post(proxy.url, { jsonrpc: '2.0', id: 1, method: 'eth_chainId' })).includes('private-api-key')); } finally { await proxy.close(); }
  const redacted = scrubError(Error(`Error ${secret} 0x${'a'.repeat(64)} and standalone-secret`), [secret, 'standalone-secret']);
  assert(!redacted.includes('private-api-key')); assert(!redacted.includes('standalone-secret')); assert(!redacted.includes('a'.repeat(64)));
});
