import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicClient, custom, encodeAbiParameters, encodeEventTopics, parseAbiParameters } from 'viem';
import { RobinhoodWalletScanner, walletLogFilters } from '../src/robinhood-scanner.mjs';
import { RobinhoodEngine } from '../src/robinhood-engine.mjs';
import { RobinhoodExecutor } from '../src/robinhood-executor.mjs';
import { createRobinhoodAccount } from '../src/robinhood-settings.mjs';
import { CONTRACTS, erc20Abi, EVM_NATIVE } from '../src/robinhood-contracts.mjs';
import { v3PoolAbi, curveAbi } from '../src/robinhood-legacy-contracts.mjs';
import { matchingSwap } from '../src/robinhood-legacy-pools.mjs';

const lead = '0x1111111111111111111111111111111111111111';
const foreign = '0x2222222222222222222222222222222222222222';
const stock = '0x3333333333333333333333333333333333333333';
const token = '0x4444444444444444444444444444444444444444';
const venue = '0x5555555555555555555555555555555555555555';
const curveAddress = '0x6666666666666666666666666666666666666666';
const h = n => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const now = BigInt(Math.floor(Date.now() / 1000));
const header = n => ({ number: BigInt(n), hash: h(n), parentHash: h(BigInt(n) - 1n), timestamp: now });
const candidate = (blockNumber, transactionIndex, id, from = lead) => ({ address: token, blockNumber: BigInt(blockNumber), blockHash: h(blockNumber), transactionIndex, transactionHash: h(id), logIndex: 0, removed: false, from });
function fixture({ end = 600n, logs = [], kind = 'copy' } = {}) {
  const calls = [], delivered = [], warnings = [], abort = new AbortController();
  const client = {
    async getBlock(args) { calls.push(['block', args]); assert.equal(args.includeTransactions, false); return header(args.blockNumber ?? end); },
    async getLogs(args) { calls.push(['logs', args]); return logs.filter(log => log.blockNumber >= args.fromBlock && log.blockNumber <= args.toBlock).toReversed(); },
    async getTransactionReceipt({ hash }) { calls.push(['receipt', hash]); const log = logs.find(item => item.transactionHash === hash); return { ...log, status: 'success', logs: [] }; }
  };
  const scanner = new RobinhoodWalletScanner(client, { kind, tracked: [lead], launchSource: 'both', blockNumber: 100n, blockHash: h(100), signal: abort.signal, onTransaction: async (tx, receipt, block) => delivered.push({ tx, receipt, block }), onRangeLimit: size => warnings.push(size) });
  return { calls, delivered, warnings, abort, client, scanner };
}

test('a 5000-block gap uses filtered ranges, orders and deduplicates buys/sells, and ignores unrelated senders', async () => {
  const logs = [candidate(120, 1, 90001), candidate(120, 0, 90002), candidate(150, 0, 90003, foreign), candidate(3900, 0, 90004)];
  const f = fixture({ end: 5100n, logs });
  assert.equal(await f.scanner.scan(), false);
  assert.equal(f.scanner.blockNumber, 5100n);
  assert.deepEqual(f.delivered.map(row => row.tx.hash), [h(90002), h(90001), h(90004)]);
  assert.equal(f.calls.filter(row => row[0] === 'receipt').length, 4);
  assert(f.calls.length < 35, `requested ${f.calls.length} RPC reads for 5000 blocks`);
  assert.equal(f.scanner.status().backlogBlocks, '0');
  assert.equal(await f.scanner.scan(), false); assert.equal(f.delivered.length, 3);
});

test('free-plan 10-block limits are learned and catch-up covers every block without duplicates', async () => {
  const f = fixture({ end: 310n, logs: [candidate(110, 0, 90101), candidate(111, 0, 90102), candidate(299, 0, 90103)] });
  const original = f.client.getLogs, covered = [];
  f.client.getLogs = async args => {
    if (args.toBlock - args.fromBlock + 1n > 10n) throw Error('Based on your plan, eth_getLogs requests are limited to a 10 block range.');
    covered.push([args.fromBlock, args.toBlock]); return original(args);
  };
  assert.equal(await f.scanner.scan(), true); assert.equal(f.scanner.blockNumber, 180n);
  while (await f.scanner.scan()) {}
  assert.equal(f.scanner.blockNumber, 310n); assert.deepEqual(f.warnings, [10]);
  assert.deepEqual(f.delivered.map(row => row.tx.hash), [h(90101), h(90102), h(90103)]);
  const fromQueries = covered.filter((_, index) => index % 2 === 0);
  let expected = 101n;
  for (const [from, to] of fromQueries) { assert.equal(from, expected); expected = to + 1n; }
  assert.equal(expected, 311n);
});

test('scanner keeps up with 100ms blocks at 120ms per read on a 10-block-limit provider', async () => {
  let elapsed = 1000, reads = 0;
  const head = () => 100n + BigInt(Math.floor(elapsed / 100));
  const f = fixture();
  f.client.getBlock = async args => { elapsed += 120; reads++; return header(args.blockNumber ?? head()); };
  f.client.getLogs = async args => { elapsed += 120; reads++; if (args.toBlock - args.fromBlock + 1n > 10n) throw Error('eth_getLogs permits a 10-block range.'); return []; };
  for (let i = 0; i < 80; i++) {
    const catchingUp = await f.scanner.scan();
    assert(head() - f.scanner.blockNumber < 40n);
    elapsed += catchingUp ? 0 : 1000;
  }
  assert(f.scanner.blockNumber > 1000n); assert(reads < Number(f.scanner.blockNumber - 100n));
});

test('one failed filter retains the cursor and a retry still finds the lead sell', async () => {
  const f = fixture({ logs: [candidate(300, 0, 90201)] }); let fail = true;
  const original = f.client.getLogs;
  f.client.getLogs = async args => { if (fail && args.args.to) throw Error('HTTP 429'); return original(args); };
  await assert.rejects(f.scanner.scan(), /429/); assert.equal(f.scanner.blockNumber, 100n); assert.equal(f.delivered.length, 0);
  assert.equal(f.scanner.range, 1000n); fail = false;
  await f.scanner.scan(); assert.equal(f.delivered.length, 1); assert.equal(f.scanner.blockNumber, 600n);
});

test('Stop during log fetching leaves the cursor and signal handler untouched', async () => {
  const f = fixture({ logs: [candidate(300, 0, 90301)] }); const original = f.client.getLogs;
  f.client.getLogs = async args => { const logs = await original(args); f.abort.abort(); return logs; };
  await assert.rejects(f.scanner.scan(), /abort/i); assert.equal(f.scanner.blockNumber, 100n); assert.equal(f.delivered.length, 0);
});

test('reorgs, malformed logs, and mismatched receipts cannot advance or produce signals', async t => {
  for (const mutation of ['anchor', 'end', 'removed', 'receipt', 'canonical']) await t.test(mutation, async () => {
    const f = fixture({ logs: [candidate(300, 0, 90401)] });
    const getBlock = f.client.getBlock, getLogs = f.client.getLogs, getReceipt = f.client.getTransactionReceipt;
    let queried = false;
    f.client.getLogs = async args => { queried = true; const logs = await getLogs(args); return mutation === 'removed' ? logs.map(log => ({ ...log, removed: true })) : logs; };
    f.client.getBlock = async args => { const block = await getBlock(args); return mutation === 'anchor' && args.blockNumber === 100n || mutation === 'end' && queried && args.blockNumber === 600n || mutation === 'canonical' && args.blockNumber === 300n ? { ...block, hash: h(999999) } : block; };
    f.client.getTransactionReceipt = async args => { const receipt = await getReceipt(args); return mutation === 'receipt' ? { ...receipt, transactionHash: h(999999) } : receipt; };
    await assert.rejects(f.scanner.scan(), /changed|match|canonical/); assert.equal(f.scanner.blockNumber, 100n); assert.equal(f.delivered.length, 0);
  });
});

test('Pons v1/v2 launch and LONG filters use real indexed fields with installed viem', async () => {
  const calls = [], client = createPublicClient({ transport: custom({ request: async args => { calls.push(args); return []; } }) });
  const filters = walletLogFilters('sniper', [lead, foreign]);
  for (const filter of filters) await client.getLogs({ ...filter, fromBlock: 1n, toBlock: 10n });
  assert.equal(calls.length, 5); assert(calls.every(call => call.method === 'eth_getLogs'));
  const padded = [lead, foreign].map(address => '0x' + address.slice(2).padStart(64, '0'));
  assert.deepEqual(calls[0].params[0].topics[1], padded); assert.deepEqual(calls[1].params[0].topics[2], padded);
  assert.deepEqual(calls[2].params[0].topics[3], padded); assert.deepEqual(calls[3].params[0].topics[2], padded);
  assert.equal(calls[4].params[0].address, CONTRACTS.airlock); assert.equal(calls[4].params[0].topics.length, 1);
  assert.equal(walletLogFilters('sniper', [lead], 'long').length, 3); assert.equal(walletLogFilters('sniper', [lead], 'pons').length, 4);
});

test('sniping detects factory launches with no developer Transfer logs and verifies transaction sender', async () => {
  const launch = candidate(300, 0, 90501), foreignLaunch = candidate(301, 0, 90502, foreign);
  const f = fixture({ kind: 'sniper', logs: [launch, foreignLaunch] });
  f.client.getLogs = async args => args.address === CONTRACTS.ponsFactory ? [launch] : args.address === CONTRACTS.airlock ? [foreignLaunch] : [];
  await f.scanner.scan(); assert.deepEqual(f.delivered.map(row => row.tx.hash), [launch.transactionHash]);
});

const transfer = (address, from, to, value) => ({ address, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }), data: encodeAbiParameters(parseAbiParameters('uint256'), [value]) });
test('a stock-routed Pons buy selects the coin curve and queues all three followers once', async t => {
  const route = { protocol: 'v3', address: venue, currency0: CONTRACTS.weth, currency1: stock, fee: 3000, tickSpacing: 60 };
  const curve = { protocol: 'pons-curve', address: curveAddress, token, quote: stock, currency0: stock, currency1: token };
  const swap = { address: venue, topics: encodeEventTopics({ abi: v3PoolAbi, eventName: 'Swap', args: { sender: foreign, recipient: foreign } }), data: encodeAbiParameters(parseAbiParameters('int256,int256,uint160,uint128,int24'), [100n, -200n, 2n ** 96n, 1000n, 0]) };
  const buy = { address: curveAddress, topics: encodeEventTopics({ abi: curveAbi, eventName: 'CurveBuy', args: { buyer: foreign, recipient: lead } }), data: encodeAbiParameters(parseAbiParameters('uint256,uint256,uint256,uint256'), [200n, 400n, 0n, 0n]) };
  const row = candidate(300, 0, 90601);
  const receipt = { ...row, from: lead, status: 'success', logs: [swap, transfer(token, curveAddress, lead, 400n), buy] };
  assert.equal(matchingSwap(receipt.logs, route, token), null);
  assert(matchingSwap(receipt.logs, route, stock)); assert(matchingSwap(receipt.logs, curve, token));
  const ledger = { data: { lots: [], pending: [], events: [], seen: [] }, async save() {}, addEvent(e) { this.data.events.unshift(e); }, async remember(k) { this.data.seen.push(k); } };
  const engine = new RobinhoodEngine(ledger, {}, 'copy'); t.after(() => clearInterval(engine.reconcileTimer));
  engine.config = { ...createRobinhoodAccount().settings, maxSignalAgeMs: 15000 }; engine.config.wallets = engine.config.wallets.slice(0, 3);
  engine.tool = { leads: [lead], quote: EVM_NATIVE, amountMode: 'fixed', buyAmount: '.05', sellMode: 'mirror' };
  engine.abort = new AbortController(); engine.state = 'running'; engine.lastBlock = 100n; engine.lastBlockHash = h(100);
  const f = fixture({ logs: [row] }); f.client.getTransactionReceipt = async () => receipt;
  engine.rpc = { client: f.client, token: async () => ({ decimals: 18 }) };
  engine.pools = { rememberLogs() {}, observeLegacyLogs: async () => [route, curve], find: async () => { throw Error('Unexpected fallback discovery'); } };
  engine.executor = new RobinhoodExecutor(engine.rpc, ledger);
  const buys = []; engine.swap = async (wallet, pool, input, amount, context) => buys.push({ wallet: wallet.publicKey, pool, input, amount, context });
  await engine.scan(); await Promise.allSettled([...engine.tasks]);
  assert.equal(buys.length, 3); assert.equal(engine.metrics.signals, 1);
  assert(buys.every(b => b.pool === curve && b.input === EVM_NATIVE && b.context.quote === stock && b.context.token === token));
  // Replay after a later RPC failure must not queue the same signal again.
  engine.scanner = null; engine.lastBlock = 100n; engine.lastBlockHash = h(100);
  await engine.scan(); await Promise.allSettled([...engine.tasks]); assert.equal(buys.length, 3);
});
