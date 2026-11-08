import test from 'node:test';
import assert from 'node:assert/strict';
import { DammPumpClientAdapter } from '../src/damm-pump-chain.mjs';

test('PumpSwap transport uses purchased operator capacity only for its exact configured endpoint', async t => {
  const names = ['LAUNCHPAD_PUBLIC_RPC_URL', 'LAUNCHPAD_PUBLIC_RPC_RPS'];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) before[name] === undefined ? delete process.env[name] : process.env[name] = before[name]; });
  process.env.LAUNCHPAD_PUBLIC_RPC_URL = 'https://rpc.example/?api-key=operator-fixture';
  process.env.LAUNCHPAD_PUBLIC_RPC_RPS = '40';
  const cases = [
    { endpoint: undefined, rate: 40, aggregateRate: 40 },
    { endpoint: 'https://RPC.EXAMPLE:443/?api-key=operator-fixture', rate: 40, aggregateRate: 40 },
    { endpoint: 'https://rpc.example/?api-key=customer-fixture', rate: 8, aggregateRate: undefined },
  ];
  for (const { endpoint, rate, aggregateRate } of cases) {
    let admission;
    const rpcGate = {
      acquire: async (_key, _client, localRate, options) => {
        admission = { rate: localRate, aggregateRate: options.aggregateRate };
        // Stop at admission. The test never connects to an RPC or submits anything.
        throw new Error('Offline admission probe');
      },
      removeClient() {},
    };
    const adapter = new DammPumpClientAdapter({ rpcUrl: endpoint, rpcGate });
    try {
      await assert.rejects(adapter.connection.getSlot('confirmed'), /Offline admission probe/);
      assert.deepEqual(admission, { rate, aggregateRate });
    } finally { adapter.close(); }
  }
});
