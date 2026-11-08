import test from 'node:test';
import assert from 'node:assert/strict';
import { RobinhoodRpc } from '../src/robinhood-rpc.mjs';
import { scrubRpcMessage, deploymentErrorMessage } from '../src/robinhood-rpc-errors.mjs';
import { prepareDeploymentTransaction } from '../scripts/robinhood-deployment.mjs';

const address = '0x1111111111111111111111111111111111111111';
const deployment = { chainId: 4663, data: '0x60006000f3' };

// Every request is intercepted before networking. The fixture has no signing
// method or key and fails if preparation attempts to submit anything.
function fixture({ balance = 10n ** 18n, estimateError, beforeEstimate = () => {} } = {}) {
  const calls = [];
  const rpc = new RobinhoodRpc({ rpcUrl: 'https://robinhood-mainnet.g.alchemy.com/v2/fixture-only-key', rpcRequestsPerSecond: 100000 }, {
    async fetcher(_url, options) {
      const request = JSON.parse(options.body);
      calls.push(request);
      let result;
      switch (request.method) {
        case 'eth_chainId': result = '0x1237'; break;
        case 'eth_getTransactionCount': result = '0x0'; break;
        case 'eth_getBalance': result = `0x${balance.toString(16)}`; break;
        case 'eth_getBlockByNumber': result = { number: '0x10', hash: `0x${'ab'.repeat(32)}`, timestamp: '0x1', baseFeePerGas: '0x5f5e100', transactions: [] }; break;
        case 'eth_estimateGas':
          beforeEstimate();
          if (estimateError) return Response.json({ jsonrpc: '2.0', id: request.id, error: estimateError });
          result = '0x100000'; break;
        default: throw Error(`Unexpected RPC method: ${request.method}`);
      }
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    },
  });
  return { rpc, calls };
}

test('a provider insufficient-funds error retains its method and reason through viem deployment errors', async () => {
  const { rpc, calls } = fixture({ estimateError: { code: -32000, message: 'insufficient funds for gas * price + value' } });
  await assert.rejects(prepareDeploymentTransaction(rpc.client, { address }, deployment, '.001'), error => {
    const message = deploymentErrorMessage(error);
    assert.match(message, /eth_estimateGas/);
    assert.match(message, /insufficient funds/i);
    return true;
  });
  assert.equal(calls.filter(call => call.method === 'eth_estimateGas').length, 1);
  assert(calls.every(call => !/send|sign/i.test(call.method)));
});

test('RPC summaries redact full URLs, standalone query/path credentials and hex secrets', () => {
  for (const [url, credential] of [
    ['https://rpc.example.com/?api-key=query-Key_42-SECRET', 'query-Key_42-SECRET'],
    ['https://robinhood-mainnet.g.alchemy.com/v2/Alchemy_Key-42_SECRET', 'Alchemy_Key-42_SECRET'],
  ]) {
    const privateKey = 'a1'.repeat(32), transactionBlob = 'b2'.repeat(96);
    const input = `RPC failed at ${url}; API key ${credential}; key 0x${privateKey}; unprefixed key ${privateKey}; payload 0x${transactionBlob}`;
    const message = scrubRpcMessage(input, url);
    assert.match(message, /RPC failed/);
    for (const secret of [url, credential, privateKey, transactionBlob]) assert(!message.includes(secret), 'RPC summaries must not expose credentials or hex blobs');
  }
});

test('an empty deployment wallet is reported before estimating or signing', async () => {
  const { rpc, calls } = fixture({ balance: 0n });
  const statuses = [];
  await assert.rejects(prepareDeploymentTransaction(rpc.client, { address }, deployment, '.001', status => statuses.push(status)), /balance|fund|ETH/i);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].address.toLowerCase(), address);
  assert.equal(statuses[0].balance, 0n);
  assert(calls.every(call => call.method !== 'eth_estimateGas' && !/send|sign/i.test(call.method)));
});

test('actual viem deployment preparation emits only read requests with canonical hex quantities', async () => {
  const statuses = [];
  const { rpc, calls } = fixture({ beforeEstimate: () => assert.equal(statuses.length, 1, 'wallet status must precede gas estimation') });
  const prepared = await prepareDeploymentTransaction(rpc.client, { address }, deployment, '.001', status => statuses.push(status));
  const methods = calls.map(call => call.method);
  assert.deepEqual(methods.slice().sort(), ['eth_chainId', 'eth_getTransactionCount', 'eth_getTransactionCount', 'eth_getBlockByNumber', 'eth_getBalance', 'eth_estimateGas'].sort());
  const nonces = calls.filter(call => call.method === 'eth_getTransactionCount').map(call => call.params[1]);
  assert.deepEqual(nonces.sort(), ['latest', 'pending']);
  const estimate = calls.find(call => call.method === 'eth_estimateGas');
  const tx = estimate.params[0];
  assert.equal(tx.from.toLowerCase(), address);
  assert.equal(tx.data, deployment.data);
  assert(!Object.hasOwn(tx, 'to'), 'creation must not become a transfer');
  for (const field of ['maxFeePerGas', 'maxPriorityFeePerGas', 'nonce', 'value']) assert.match(tx[field], /^0x(?:0|[1-9a-f][0-9a-f]*)$/i);
  assert(!Object.hasOwn(tx, 'chainId') || typeof tx.chainId === 'string');
  assert.equal(statuses[0].nonce, 0);
  assert.equal(statuses[0].minedNonce, 0);
  assert.equal(statuses[0].balance, 10n ** 18n);
  assert.equal(statuses[0].baseFeePerGas, 100000000n);
  assert.equal(prepared.transaction.gas, 1048576n * 120n / 100n);
  assert.equal(prepared.transaction.chainId, 4663);
});
