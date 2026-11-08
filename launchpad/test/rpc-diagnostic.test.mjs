import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSavedRpc } from '../scripts/check-rpc.mjs';
test('saved RPC diagnostic uses the custom endpoint and makes only a read-only network check', async () => {
  let calls = 0;
  const result = await checkSavedRpc({ rpcUrl: 'https://mainnet.helius-rpc.com/?api-key=new-test-key', heliusKey: 'old-test-key' }, async (url, method, params) => {
    calls++; assert.equal(new URL(url).searchParams.get('api-key'), 'new-test-key'); assert.equal(method, 'getGenesisHash'); assert.deepEqual(params, []);
    return '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
  });
  assert.equal(calls, 1); assert.equal(result.source, 'Custom RPC URL'); assert(!JSON.stringify(result).includes('test-key'));
});
test('diagnostic identifies a URL pasted into the key field and preserves authentication failures', async () => {
  await assert.rejects(checkSavedRpc({ heliusKey: 'https://mainnet.helius-rpc.com/?api-key=example' }, () => { throw Error('must not call'); }), /contains a URL/);
  await assert.rejects(checkSavedRpc({ heliusKey: 'example' }, async () => { throw Error('RPC getGenesisHash returned HTTP 401.'); }), /HTTP 401/);
});
