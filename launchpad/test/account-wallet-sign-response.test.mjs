import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createAccountApp } from '../src/account-app.mjs';

test('wallet signing HTTP errors expose only the definite rejection code used for safe retries', async t => {
  let nextError;
  const calls = [], account = { id: 'wallet-user', role: 'user', authType: 'wallet' };
  const server = createAccountApp({
    accounts: { master: Buffer.alloc(32), async getSessionWithCsrf() { return { session: { account, walletVerified: true }, csrfValid: true }; } },
    runtimes: {}, policy: {}, marketData: {}, funding: {}, protocolFees: {}, branding: {}, adminPanel: {}, adminRevenue: {}, explore: {}, trading: {},
    launchpad: { async sign(...args) { calls.push(args); throw nextError; } },
    features: { toolkit: false, telegram: false, walletOnly: true },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await server.closeServices(); });
  const request = () => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path: '/api/launchpad/sign', method: 'POST',
      headers: { cookie: 'launchpad-session=fixture', 'x-control-token': 'fixture-csrf', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject); req.end(JSON.stringify({ id: 'launch', operationId: 'operation', transaction: 'signed-bytes' }));
  });
  nextError = Object.assign(Error('The wallet changed the reviewed transaction.'), { code: 'WALLET_TRANSACTION_REJECTED' });
  let result = await request();
  assert.equal(result.status, 400);
  assert.deepEqual(result.body, { error: nextError.message, code: 'WALLET_TRANSACTION_REJECTED' });
  assert.deepEqual(calls.at(-1), [account.id, 'launch', 'operation', 'signed-bytes']);

  for (const code of ['ETIMEDOUT', 'PRIVATE_PROVIDER_ERROR', undefined]) {
    nextError = Object.assign(Error('Please check the transaction status.'), { code });
    result = await request();
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { error: nextError.message });
  }
});
