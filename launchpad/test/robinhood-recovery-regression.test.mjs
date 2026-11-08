import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, parseEther } from 'viem';
import { RobinhoodEngine } from '../src/robinhood-engine.mjs';
import { RobinhoodExecutor } from '../src/robinhood-executor.mjs';
import { createRobinhoodAccount } from '../src/robinhood-settings.mjs';
import { CONTRACTS, erc20Abi, poolAbi, poolId, EVM_NATIVE } from '../src/robinhood-contracts.mjs';
import { adapterAbi } from '../src/robinhood-legacy-contracts.mjs';

const token = '0x1111111111111111111111111111111111111111', stock = '0x2222222222222222222222222222222222222222', lead = '0x3333333333333333333333333333333333333333', venue = '0x4444444444444444444444444444444444444444';
const pool = { currency0: EVM_NATIVE, currency1: token, fee: 3000, tickSpacing: 60, hooks: EVM_NATIVE };
const book = () => ({ data: { version: 1, lots: [], pending: [], seen: [], events: [], feeReceipts: [] }, async save() {}, addEvent(e) { this.data.events.unshift(e); } });
const transfer = (address, from, to, value) => ({ address, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }), data: encodeAbiParameters(parseAbiParameters('uint256'), [value]) });
function running(t, ledger = book(), kind = 'copy') {
  const engine = new RobinhoodEngine(ledger, {}, kind), config = createRobinhoodAccount().settings;
  engine.config = config; engine.tool = { mirrorFraction: true, sellMode: 'mirror' }; engine.abort = new AbortController(); engine.state = 'running';
  engine.executor = new RobinhoodExecutor({ client: {} }, ledger);
  t.after(() => clearInterval(engine.reconcileTimer));
  return { engine, ledger, wallet: config.wallets[0] };
}
const settle = async engine => { await Promise.allSettled([...engine.tasks]); await Promise.resolve(); };

test('lead exits survive delayed buy receipts and restart without selling later entries', async t => {
  const { engine, ledger, wallet } = running(t);
  engine.copyPairs.set(`${lead}:${token}`, { pool, quote: EVM_NATIVE });
  engine.leadBalanceBefore = async () => 200n;
  engine.pools = { observeLegacyLogs: async () => [], find: async () => pool };
  ledger.data.pending.push({ wallet: wallet.publicKey, signature: 'delayed-buy' });
  const swap = { address: CONTRACTS.poolManager, topics: encodeEventTopics({ abi: poolAbi, eventName: 'Swap', args: { id: poolId(pool), sender: venue } }), data: encodeAbiParameters(parseAbiParameters('int128,int128,uint160,uint128,int24,uint24'), [100n, -100n, 2n ** 96n, 1000n, 0, 3000]) };
  const tx = { from: lead, hash: `0x${'12'.repeat(32)}` }, receipt = { logs: [transfer(token, lead, venue, 100n), swap] };
  await engine.copySignals(tx, receipt, {}); await settle(engine);
  assert.equal(ledger.data.copySells.length, 1); assert.equal(ledger.data.copySells[0].attempts, 0);
  const stored = JSON.parse(JSON.stringify(ledger.data));
  const restored = book(); restored.data = stored; restored.data.pending = [];
  const next = running(t, restored).engine; next.config.wallets = [wallet];
  restored.data.lots.push({ id: 'old-buy', wallet: wallet.publicKey, lead, token, quote: EVM_NATIVE, pool, remaining: '1000', cost: '100', copySequence: 0 }, { id: 'later-buy', wallet: wallet.publicKey, lead, token, quote: EVM_NATIVE, pool, remaining: '300', cost: '30', copySequence: 2 });
  let submitted = 0;
  next.swap = async (w, p, input, amount, context) => {
    assert.equal(amount, 500n); assert.deepEqual(context.lotIds, ['old-buy']); submitted++;
    next.confirmed({ signature: 'exit', wallet: w.publicKey, context: { ...context, operation: 'swap', amount: String(amount), pool: p } }, { logs: [transfer(token, w.publicKey, venue, amount)] });
  };
  next.dispatchCopySells(); await settle(next); next.dispatchCopySells(); await settle(next);
  assert.equal(submitted, 1); assert.equal(restored.data.copySells.length, 0);
  assert.deepEqual(restored.data.lots.map(l => l.remaining), ['500', '300']);
});

test('definite copied sell failures have bounded retries and never consume the exit intent', async t => {
  const { engine, ledger, wallet } = running(t);
  ledger.data.copySells = [{ id: 'exit', wallet: wallet.publicKey, lead, token, quote: EVM_NATIVE, pool, numerator: '1', denominator: '1', sequence: 2, attempts: 0 }];
  ledger.data.lots.push({ id: 'buy', wallet: wallet.publicKey, lead, token, remaining: '100', copySequence: 1 });
  let submitted = 0; engine.swap = async () => { submitted++; throw Error('simulation failed'); };
  for (let i = 0; i < 5; i++) { ledger.data.copySells[0].retryAt = 0; engine.dispatchCopySells(); await settle(engine); }
  assert.equal(submitted, 3); assert.equal(ledger.data.copySells.length, 1); assert.equal(ledger.data.copySells[0].attempts, 3);
});

test('partial ERC20 input refunds reduce entry cost and managed budget by the actual debit', t => {
  const { engine, ledger, wallet } = running(t, book(), 'market');
  ledger.data.inventory = { [wallet.publicKey]: { token, quote: stock, quoteAvailable: '200' } };
  const pending = { signature: 'partial', wallet: wallet.publicKey, context: { operation: 'swap', side: 'buy', inventory: true, input: stock, inputAccounting: 'receipt', token, quote: stock, amount: '100', minimum: '50', pool } };
  const receipt = { logs: [transfer(stock, wallet.publicKey, venue, 100n), transfer(stock, venue, wallet.publicKey, 40n), transfer(token, venue, wallet.publicKey, 80n)] };
  engine.confirmed(pending, receipt); engine.confirmed(pending, receipt);
  assert.equal(ledger.data.inventory[wallet.publicKey].quoteAvailable, '140'); assert.equal(ledger.data.lots[0].cost, '60'); assert.equal(ledger.data.lots[0].remaining, '80');
});

function sender() {
  const config = createRobinhoodAccount().settings, wallet = config.wallets[0], ledger = book(), abort = new AbortController();
  let sent = 0;
  const rpc = { config, client: { getTransactionCount: async () => 0, getBalance: async () => parseEther('10'), getBlock: async () => ({ baseFeePerGas: 1n }), estimateGas: async () => 21000n }, request: async () => { sent++; return null; } };
  const executor = new RobinhoodExecutor(rpc, ledger, { policy: {}, signal: abort.signal });
  return { wallet, ledger, abort, executor, rpc, sent: () => sent };
}
test('Stop during the attempted journal save cancels before RPC submission', async () => {
  const s = sender(); s.ledger.save = async () => { if (s.ledger.data.pending[0]?.attempted) s.abort.abort(); };
  await assert.rejects(s.executor.send(s.wallet, { to: venue, data: '0x', value: 0n }), /Stopped before broadcasting/);
  assert.equal(s.sent(), 0); assert.equal(s.ledger.data.pending.length, 0);
});
test('an attempted journal write failure remains safely removable because nothing was broadcast', async () => {
  const s = sender(); let fail = true;
  s.ledger.save = async () => { if (fail && s.ledger.data.pending[0]?.attempted) { fail = false; throw Error('disk full'); } };
  await assert.rejects(s.executor.send(s.wallet, { to: venue, data: '0x', value: 0n }), /disk full/);
  assert.equal(s.sent(), 0); assert.equal(s.ledger.data.pending[0].attempted, false);
  await s.executor.reconcileAll(); assert.equal(s.ledger.data.pending.length, 0); assert.equal(s.sent(), 0);
});
test('invalid executor fee evidence cannot partially apply holdings', async () => {
  const ledger = book(), pending = { signature: `0x${'ab'.repeat(32)}`, wallet: lead, to: venue, attempted: true, context: {}, fee: { amount: '10', recipient: stock } }; ledger.data.pending.push(pending);
  const fee = { address: venue, topics: encodeEventTopics({ abi: adapterAbi, eventName: 'PlatformFee', args: { wallet: lead, recipient: stock } }), data: encodeAbiParameters(parseAbiParameters('uint256,bytes4'), [11n, '0x00000000']) };
  let applied = 0;
  const receipt = { transactionHash: pending.signature, from: lead, to: venue, status: '0x1', blockNumber: '0x2', blockHash: '0x1', logs: [fee] };
  const rpc = { client: {}, request: async ({ method }) => method === 'eth_getBlockByNumber' ? { hash: '0x1' } : receipt };
  const executor = new RobinhoodExecutor(rpc, ledger, { policy: { adapter: venue }, confirmed: async () => { applied++; } });
  await assert.rejects(executor.reconcile(pending), /exceeds the signed maximum/);
  assert.equal(applied, 0); assert.equal(ledger.data.pending.length, 1); assert.equal(ledger.data.feeReceipts.length, 0);
});
test('queued LP actions reject a position closed by a preceding receipt', async t => {
  const { engine, ledger, wallet } = running(t, book(), 'liquidity');
  const stale = { id: 'lp', wallet: wallet.publicKey, liquidity: '100' }; ledger.data.lots.push({ ...stale, liquidity: '0' });
  await assert.rejects(engine.withdrawLot(wallet, stale, false), /already closed/);
  await assert.rejects(engine.claimLotFees(wallet, stale, false), /already closed/);
});


test('concurrent receipt staging preserves the attempted journal and cannot prune an in-flight submission', async () => {
  const s = sender(); let writes = 0, broadcast = 0;
  s.ledger.save = async () => {
    if (++writes === 1) {
      const stale = s.ledger.data.pending[0];
      // This is what Engine.confirmed does while another wallet awaits I/O.
      s.ledger.data = structuredClone(s.ledger.data);
      await s.executor.reconcile(stale);
      assert.equal(s.ledger.data.pending.length, 1);
    }
  };
  s.rpc.request = async ({ method }) => {
    if (method === 'eth_sendRawTransaction') {
      assert.equal(s.ledger.data.pending[0].attempted, true);
      assert.equal(writes, 2); broadcast++; s.abort.abort();
    }
    return null;
  };
  await assert.rejects(s.executor.send(s.wallet, { to: venue, data: '0x', value: 0n }), /unresolved/);
  assert.equal(broadcast, 1); assert.equal(s.ledger.data.pending[0].attempted, true);
});

test('MM resolves its pool quote but allocates and spends ETH when the pool uses WETH', async t => {
  const { engine, ledger, wallet } = running(t, book(), 'market');
  engine.config.wallets = [wallet];
  engine.config.reserveEth = '0';
  engine.tool = { token, quote: EVM_NATIVE, budgetEth: '0.00000000000000001', preset: 'balanced' };
  engine.strategyPool = { protocol: 'pons-curve' };
  const resolved = { ...pool, currency0: token, currency1: CONTRACTS.weth, protocol: 'v3' };
  engine.pools = { find: async () => resolved };
  engine.rpc = { token: async () => ({ decimals: 0 }), balance: async () => 10n };
  engine.ensureWrappedQuote = async () => assert.fail('ETH-funded market making must not pre-wrap or require WETH');
  let input;
  engine.swap = async (w, p, quoted, amount) => { input = quoted; assert.equal(amount, 5n); };
  await engine.marketTick(); await settle(engine);
  assert.equal(input, EVM_NATIVE); assert.equal(engine.tool.quote, CONTRACTS.weth); assert.equal(ledger.data.inventory[wallet.publicKey].quote, CONTRACTS.weth);
  assert.equal(ledger.data.inventory[wallet.publicKey].ethAvailable, '10');
});
