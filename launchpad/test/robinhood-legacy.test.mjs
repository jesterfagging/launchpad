import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters, parseAbiParameters } from 'viem';
import { readLegacyPool, legacyQuote, legacySwap, readCurve } from '../src/robinhood-legacy-pools.mjs';
import { encode } from '../src/robinhood-pools.mjs';
import { CONTRACTS, EVM_NATIVE } from '../src/robinhood-contracts.mjs';
import { RobinhoodRpc } from '../src/robinhood-rpc.mjs';
import { cleanEvmTool } from '../src/robinhood-settings.mjs';
import { executorDeployment, expectedExecutorCode, verifyExecutor } from '../src/robinhood-deployment.mjs';
import { prepareDeploymentTransaction } from '../scripts/robinhood-deployment.mjs';

const token = '0x1111111111111111111111111111111111111111', stock = '0x2222222222222222222222222222222222222222', address = '0x3333333333333333333333333333333333333333';
test('v2/v3 stock-quote pools require factory registration, not just a matching interface', async () => {
  for (const protocol of ['v2', 'v3']) {
    let forged = false;
    const client = { async readContract({ functionName }) {
      return { factory: CONTRACTS[protocol === 'v2' ? 'v2Factory' : 'v3Factory'], token0: token, token1: stock, getPair: forged ? token : address, getPool: forged ? token : address, getReserves: [1000000n, 2000000n, 0], fee: 3000, tickSpacing: 60, liquidity: 123n }[functionName];
    } };
    const pool = await readLegacyPool(client, address, protocol); assert.equal(pool.protocol, protocol); assert.equal(pool.currency1, stock);
    forged = true; await assert.rejects(readLegacyPool(client, address, protocol), /registered|verified/);
  }
});
test('UR 2.1.2 v2/v3 instructions carry the required per-hop minimum array', () => {
  for (const protocol of ['v2', 'v3']) {
    const pool = { protocol, currency0: token, currency1: stock, fee: 3000 };
    const plan = legacySwap(encode, pool, stock, 1000n, 800n, address, true);
    const decoded = decodeAbiParameters(parseAbiParameters(`address,uint256,uint256,${protocol === 'v2' ? 'address[]' : 'bytes'},bool,uint256[]`), plan.input);
    assert.equal(plan.command, protocol === 'v2' ? '08' : '00'); assert.equal(decoded[1], 1000n); assert.equal(decoded[2], 800n); assert.deepEqual(decoded[5], [0n]);
    if (protocol === 'v2') assert.deepEqual(decoded[3], [stock, token]);
    else assert.equal(decoded[3], `${stock}000bb8${token.slice(2)}`);
  }
});
test('curve quotes tolerate an absent optional tax getter but never hide provider errors', async () => {
  let taxError = Object.assign(Error('missing getter'), { name: 'ContractFunctionZeroDataError' }), phase = 0;
  const client = { async readContract({ functionName }) {
    if (functionName === 'currentSnipeTaxBps') { if (taxError) throw taxError; return 100n; }
    return { getLaunchedToken: { exists: true, token, curve: address, pairToken: stock, phase }, factory: CONTRACTS.ponsFactory, token, pairToken: stock, graduated: phase > 0, readyToGraduate: false, getReserves: [100000n, 1000000n], feeBps: 100n, creatorTaxBps: 100n, sellableTokens: 1000000n, realQuoteReserve: 100000n }[functionName];
  } };
  const pool = await readCurve(client, token);
  assert.equal(await legacyQuote(client, pool, stock, 1000n, address), 9704n);
  taxError = Error('HTTP 429'); await assert.rejects(legacyQuote(client, pool, stock, 1000n, address), /429/);
  taxError = null; assert((await legacyQuote(client, pool, stock, 1000n, address)) < 9704n);
  phase = 2; await assert.rejects(readCurve(client, token), /graduated/); assert.equal((await readCurve(client, token, true)).address, address);
});
test('RPC startup uses real public dependency getters and rejects another chain or altered deployment', async () => {
  let chainId = 4663, altered = false;
  const rpc = new RobinhoodRpc({ rpcUrl: 'https://rpc.mainnet.chain.robinhood.com', rpcRequestsPerSecond: 10 });
  rpc.client = { getChainId: async () => chainId, getCode: async () => '0x60', async readContract({ address, functionName }) {
    assert(!(address === CONTRACTS.router && functionName === 'WETH9'));
    if (functionName === 'poolManager') return altered ? EVM_NATIVE : CONTRACTS.poolManager;
    if (functionName === 'WETH' || functionName === 'WETH9') return CONTRACTS.weth;
    return address === CONTRACTS.v2Router ? CONTRACTS.v2Factory : CONTRACTS.v3Factory;
  } };
  await rpc.connect(); altered = true; await assert.rejects(rpc.connect(), /dependencies/);
  chainId = 1; await assert.rejects(rpc.connect(), /4663/);
  assert.throws(() => cleanEvmTool({ autoCompoundFees: 'false' }, 'liquidity'), /true or false/);
});
test('deployment preparation pins constructor dependencies, verifies runtime and refuses excessive costs or pending nonces', async () => {
  const deployment = await executorDeployment(), code = await expectedExecutorCode();
  assert.equal(deployment.chainId, 4663); assert.equal(deployment.value, '0'); assert.deepEqual(deployment.constructorArguments, [CONTRACTS.ponsFactory, CONTRACTS.v2Router, CONTRACTS.v3PositionManager]);
  await verifyExecutor({ getCode: async () => code }, address);
  await assert.rejects(verifyExecutor({ getCode: async () => code.slice(0, -2) + (code.endsWith('00') ? '01' : '00') }, address), /compiled code/);
  let pending = false;
  const client = { getChainId: async () => 4663, getTransactionCount: async ({ blockTag }) => pending && blockTag === 'pending' ? 1 : 0, getBlock: async () => ({ baseFeePerGas: 1000000000n }), getBalance: async () => 10n ** 18n, estimateGas: async () => 1000000n };
  const tx = await prepareDeploymentTransaction(client, { address }, deployment, '.01'); assert.equal(tx.transaction.gas, 1200000n); assert.equal(tx.transaction.value, 0n);
  await assert.rejects(prepareDeploymentTransaction(client, { address }, deployment, '.000001'), /cost ceiling/);
  pending = true; await assert.rejects(prepareDeploymentTransaction(client, { address }, deployment, '.01'), /pending transaction/);
});
