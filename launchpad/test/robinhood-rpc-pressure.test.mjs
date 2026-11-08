import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { RobinhoodRpc } from '../src/robinhood-rpc.mjs';
import { robinhoodErrorMessage, rpcRateLimit } from '../src/robinhood-rpc-errors.mjs';
import { RobinhoodPools } from '../src/robinhood-pools.mjs';
import { RobinhoodEngine } from '../src/robinhood-engine.mjs';
import { RobinhoodExecutor } from '../src/robinhood-executor.mjs';
import { CONTRACTS, EVM_NATIVE } from '../src/robinhood-contracts.mjs';
import { getAddress, decodeFunctionData } from 'viem';
import { adapterAbi } from '../src/robinhood-legacy-contracts.mjs';
import { ethFundingPath } from '../src/robinhood-eth-trades.mjs';

const config = () => ({ rpcUrl: 'https://rpc.example.com/v2/fixture-only-secret', rpcRequestsPerSecond: 100 });
const json = (request, result) => Response.json({ jsonrpc: '2.0', id: request.id, result });
const address = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`);

test('queued trade reads precede background work without starving it, and Stop removes queued requests', async () => {
  const order=[], abort=new AbortController(), rpc=new RobinhoodRpc(config(),{signal:abort.signal,fetcher:async(_url,options)=>{const q=JSON.parse(options.body);order.push(q.params[0]);return json(q,'0x1');}});
  rpc.nextAt=Date.now()+50;
  const background=rpc.withPriority(-2,()=>rpc.request({method:'eth_getBalance',params:['background']}));
  const trades=Array.from({length:8},(_,i)=>rpc.withPriority(1,()=>rpc.request({method:'eth_getBalance',params:[`trade-${i}`]})));
  await Promise.all([background,...trades]); assert.equal(order[0],'trade-0'); assert(order.indexOf('background')<=5); assert.equal(new Set(order).size,9);
  rpc.nextAt=Date.now()+500;const stopped=rpc.request({method:'eth_getBalance',params:['must-not-send']});abort.abort();await assert.rejects(stopped);assert(!order.includes('must-not-send'));assert.equal(rpc.status().queued,0);
});

test('a throttled run recovers only after a quiet period and stays within the configured provider cap', () => {
  const rpc=new RobinhoodRpc({...config(),rpcRequestsPerSecond:10});rpc.limited('eth_call','busy',250,429);assert.equal(rpc.effectiveRate,5);const base=rpc.lastLimitedAt;
  for(let i=0;i<20;i++)rpc.noteSuccess(base+1000);assert.equal(rpc.effectiveRate,5);
  for(let i=0;i<10;i++)rpc.noteSuccess(base+16000);assert.equal(rpc.effectiveRate,6);
  for(let step=2;step<15;step++)for(let i=0;i<10;i++)rpc.noteSuccess(base+16000+step*5000);
  assert.equal(rpc.effectiveRate,10);rpc.lastReduction=0;rpc.limited('eth_getLogs','busy',250,429);assert.equal(rpc.effectiveRate,5);
});

test('HTTP 429 retries a read once, honors Retry-After, lowers the shared rate and hides credentials', async () => {
  const calls = [], rates = [], cooldowns = [], settings = config();
  const rpc = new RobinhoodRpc(settings, {
    gate: { async acquire(c) { rates.push(c.rpcRequestsPerSecond); }, cooldown(c, ms) { cooldowns.push(ms); } },
    async fetcher(url, options) {
      const request = JSON.parse(options.body); calls.push({ at: Date.now(), ...request });
      if (calls.length === 1) return new Response('', { status: 429, headers: { 'retry-after': '0.25' } });
      return json(request, '0x1237');
    },
  });
  assert.equal(await rpc.client.getChainId(), 4663);
  assert.equal(calls.length, 2); assert(calls[1].at - calls[0].at >= 245);
  assert.deepEqual(rates, [100, 50]); assert.deepEqual(cooldowns, [250]);
  assert.equal(settings.rpcRequestsPerSecond, 100, 'adaptive pacing must not overwrite saved preferences');
  assert.equal(rpc.status().rateLimits, 1); assert.equal(rpc.status().effectiveRequestsPerSecond, 50);
  assert(!JSON.stringify(rpc.status()).includes('fixture-only-secret'));

  const rejected = new RobinhoodRpc(config(), { fetcher: async () => new Response('', { status: 429, headers: { 'retry-after': '8' } }) });
  await assert.rejects(rejected.client.getBlockNumber(), error => {
    const message = robinhoodErrorMessage(error, rejected.url);
    assert.match(message, /eth_blockNumber.*HTTP 429/); assert(!message.includes('fixture-only-secret'));
    assert.equal(rpcRateLimit(error).retryAfterMs, 8000); return true;
  });
});

test('JSON rate limits retain their provider reason through viem; broadcasts are never retried', async () => {
  let reads = 0, sends = 0;
  const rpc = new RobinhoodRpc(config(), { async fetcher(url, options) {
    const request = JSON.parse(options.body);
    if (request.method === 'eth_sendRawTransaction') { sends++; return new Response('', { status: 429 }); }
    reads++; return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32005, message: 'compute units per second rate limit for fixture-only-secret' } });
  } });
  await assert.rejects(rpc.client.getBlockNumber(), error => {
    assert.match(robinhoodErrorMessage(error), /compute units per second/);
    assert(!robinhoodErrorMessage(error).includes('fixture-only-secret')); return true;
  });
  assert.equal(reads, 2);
  rpc.blockedUntil = 0; rpc.nextAt = 0;
  await assert.rejects(rpc.request({ method: 'eth_sendRawTransaction', params: ['0x01'] }), /HTTP 429/);
  assert.equal(sends, 1);
});

test('Stop cancels rate-limit backoff without another provider request', async () => {
  const abort = new AbortController(); let calls = 0;
  const rpc = new RobinhoodRpc(config(), { signal: abort.signal, async fetcher() { calls++; setTimeout(() => abort.abort(), 20); return new Response('', { status: 429 }); } });
  await assert.rejects(rpc.client.getBlockNumber()); assert.equal(calls, 1);
});

test('concurrent identical reads coalesce; sequential reads, nonces and balances stay fresh', async () => {
  const calls = [];
  const rpc = new RobinhoodRpc(config(), { async fetcher(url, options) {
    const request = JSON.parse(options.body); calls.push(request); await wait(25); return json(request, '0x01');
  } });
  const call = { method: 'eth_call', params: [{ to: address(1), data: '0x12345678' }, 'latest'] };
  await Promise.all([rpc.request(call), rpc.request(call), rpc.request(call)]);
  assert.equal(calls.length, 1);
  await rpc.request(call); assert.equal(calls.length, 2);
  for (const method of ['eth_getBalance', 'eth_getTransactionCount']) await Promise.all([rpc.request({ method, params: [address(1), 'pending'] }), rpc.request({ method, params: [address(1), 'pending'] })]);
  assert.equal(calls.length, 6);
});

test('shared-gate workers pace calls instead of bursting their whole rolling allowance', async () => {
  const times = [];
  const rpc = new RobinhoodRpc({ ...config(), rpcRequestsPerSecond: 20 }, { gate: { async acquire() {} }, async fetcher(url, options) { times.push(Date.now()); return json(JSON.parse(options.body), '0x0'); } });
  await Promise.all([1, 2, 3].map(n => rpc.request({ method: 'eth_getBalance', params: [address(n), 'latest'] })));
  assert.equal(times.length, 3); assert(times[2] - times[0] >= 95);
});
test('a delayed shared permit cannot collapse Robinhood requests into one dispatch burst',async()=>{
  const times=[],releaseAt=Date.now()+200;
  const rpc=new RobinhoodRpc({...config(),rpcRequestsPerSecond:20},{gate:{async acquire(){await wait(Math.max(0,releaseAt-Date.now()));}},async fetcher(url,options){times.push(Date.now());return json(JSON.parse(options.body),'0x0');}});
  await Promise.all([1,2,3].map(n=>rpc.request({method:'eth_getBalance',params:[address(n),'latest']})));
  assert.equal(times.length,3);assert(times[1]-times[0]>=45);assert(times[2]-times[1]>=45);
});

function marketFixture() {
  const token = address(20), stock = address(10), curve = address(30), fundingAddress = address(40);
  const [currency0, currency1] = [stock, CONTRACTS.weth].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
  const pool = { protocol: 'pons-curve', token, quote: stock, address: curve, currency0: stock, currency1: token };
  const reads = [], taxes = [];
  const client = {
    async readContract({ address: at, functionName: fn, args = [] }) {
      reads.push({ at, fn, args }); await wait(1);
      if (at === CONTRACTS.ponsFactory && fn === 'getLaunchedToken') return args[0] === token ? { exists: true, token, pairToken: stock, curve, phase: 0 } : { exists: false };
      if (at === CONTRACTS.ponsV1Factory && fn === 'getLaunchedToken') return { exists: false };
      if (at === CONTRACTS.airlock) return Array(8).fill(EVM_NATIVE);
      if (at === CONTRACTS.stateView) throw Error('Pool is not initialized');
      if (at === CONTRACTS.v3Factory && fn === 'getPool') return fundingAddress;
      if (at === fundingAddress) return ({ factory: CONTRACTS.v3Factory, token0: currency0, token1: currency1, fee: 500, tickSpacing: 10, liquidity: 10n ** 25n })[fn];
      if (at === curve) {
        if (fn === 'currentSnipeTaxBps') { taxes.push(args[0]); return BigInt(taxes.length - 1) * 10n; }
        return ({ factory: CONTRACTS.ponsFactory, token, pairToken: stock, graduated: false, readyToGraduate: false, getReserves: [10n ** 25n, 10n ** 27n], feeBps: 100n, creatorTaxBps: 100n, sellableTokens: 10n ** 26n, realQuoteReserve: 10n ** 25n })[fn];
      }
      throw Error(`Unexpected ${at} ${fn}`);
    },
    async simulateContract({ args }) { reads.push({ fn: 'simulateQuote' }); await wait(1); return { result: [args[0].amountIn * 100n] }; },
  };
  const pools = new RobinhoodPools({ client }); pools.cache.set([stock, token].sort().join(':'), pool);
  return { token, stock, pool, pools, reads, taxes };
}

test('three cold-route followers share pool discovery and common quotes while retaining wallet-specific curve tax', async t => {
  async function run(shared) {
    const f = marketFixture(), plans = [], ledger = { data: { events: [], pending: [], lots: [] }, addEvent(e) { this.data.events.push(e); }, async save() {} };
    if (!shared) f.pools.snapshot = () => f.pools;
    const engine = new RobinhoodEngine(ledger, { copyPpm: 2500, recipient: address(60), adapter: address(70) }, 'copy');
    t.after(() => clearInterval(engine.reconcileTimer));
    Object.assign(engine, { pools: f.pools, abort: new AbortController(), rpc: { token: async () => ({ decimals: 18, symbol: 'COIN' }), balance: async () => 10n ** 18n }, config: { wallets: [1, 2, 3].map(n => ({ publicKey: address(n) })), slippageBps: 200, maxSignalAgeMs: 15000 }, tool: { amountMode: 'fixed', buyAmount: '0.01', budget: '0.1', feePool: null } });
    const queues = new Map(); engine.executor = { check() {}, async approvals() {}, serial(wallet, job) { const p = Promise.resolve().then(job); queues.set(wallet, p); return p; }, async send(wallet, plan) { plans.push({ wallet: wallet.publicKey, plan }); } };
    engine.buySignal({ token: f.token, quote: f.stock, pool: f.pool, at: Date.now(), signature: 'test', lead: address(99) });
    await Promise.allSettled([...engine.tasks]);
    assert.equal(plans.length, 3, JSON.stringify(ledger.data.events));
    assert.equal(new Set(f.taxes).size, 3, 'recipient-specific curve tax cannot be shared between wallets');
    for (const { plan } of plans) {
      const { args: [trade, path] } = decodeFunctionData({ abi: adapterAbi, data: plan.data });
      assert.equal(trade.buy, true); assert.equal(trade.curve, true); assert.equal(path.length, 1);
      assert.equal(path[0].input, CONTRACTS.weth); assert.equal(path[0].output, f.stock);
      assert.equal(plan.value, 10n ** 16n); assert(trade.minimum > 0n);
    }
    return { calls: f.reads.length, f };
  }
  const before = await run(false), after = await run(true);
  t.diagnostic(`Three-wallet cold stock route: ${before.calls} pool reads without sharing; ${after.calls} with sharing.`);
  assert(after.calls < before.calls * 0.6);
  const snapshot = after.f.pools.snapshot(); const previous = after.f.reads.length;
  await snapshot.find(after.f.token, after.f.stock);
  assert(after.f.reads.length > previous, 'a new signal must revalidate state');
});

test('expired buys still fail before any signing or submission', async () => {
  let calls = 0;
  const executor = new RobinhoodExecutor({ config: { maxSignalAgeMs: 1000 }, client: new Proxy({}, { get() { calls++; throw Error('Must not touch RPC'); } }) }, { data: { pending: [] } });
  await assert.rejects(executor.send({ publicKey: address(1) }, {}, { signalAt: Date.now() - 2000 }), /Buy signal expired before signing/);
  assert.equal(calls, 0);
});

test('rate-limited route discovery propagates the real failure instead of probing every other venue', async () => {
  let calls = 0;
  const error = Object.assign(Error('provider rate limit'), { rateLimited: true, rpcMethod: 'eth_call', retryAfterMs: 8000 });
  const pools = new RobinhoodPools({ client: { async readContract() { calls++; throw error; } } });
  await assert.rejects(ethFundingPath(pools, address(1)), e => e === error);
  assert.equal(calls, 1);
});

test('pool snapshots expire, do not retain rejected reads and never replace fresh execution simulation', async () => {
  const f = marketFixture(), snapshot = f.pools.snapshot();
  await snapshot.find(f.token, f.stock); const before = f.reads.length;
  await snapshot.find(f.token, f.stock); assert.equal(f.reads.length, before);
  await wait(2020); await snapshot.find(f.token, f.stock); assert(f.reads.length > before);
  let attempt = 0;
  const failed = new RobinhoodPools({ client: { async readContract() { if (++attempt === 1) throw Error('temporary failure'); return 12; } } }).snapshot();
  await assert.rejects(failed.client.readContract({ functionName: 'fee' }), /temporary/);
  assert.equal(await failed.client.readContract({ functionName: 'fee' }), 12);
  assert.equal(attempt, 2);
});
