import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { Engine } from '../src/engine.mjs';
import { Providers, ProviderError } from '../src/providers.mjs';
import { RequestPacing } from '../src/request-pacing.mjs';
import { validateConfig } from '../src/core.mjs';
import { Ledger } from '../src/ledger.mjs';
import { SOL, JUPITER } from '../src/core.mjs';
import { manualSellGroups, validateManualTrade } from '../src/manual-trades.mjs';
import { build, config, event, key1, key2, lead, lead2, mint, quote, swap, token } from './fixtures.mjs';

const pub = key => key.publicKey.toBase58();
const request = (side = 'buy', wallets = [key1], extra = {}) => ({ id: randomUUID(), side, mint, wallets: wallets.map(pub), amountSol: '.012345678', sellPercent: 100, ...extra });

async function harness(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-manual-'));
  const ledgers = { live: await new Ledger(join(dir, 'live.json')).load(), paper: await new Ledger(join(dir, 'paper.json')).load() };
  const receipts = new Map(), orders = [], active = new Map(), submissions = [];
  let initializations = 0, subscriptions = 0, fail = options.fail, unresolved = options.unresolved;
  const p = { market: new Map([[mint, { price: 1, marketCap: 100000, symbol: 'TEST', receivedAt: Date.now() }], [SOL, { price: 100, receivedAt: Date.now() }]]), knownPrograms: new Set([JUPITER]), jitoTips: [],
    init: async () => { initializations++; p.direct.discover = async () => null; }, subscribe: async () => { subscriptions++; }, close() {},
    markets: async () => p.market, balance: async () => 100000000000n, height: async () => 100,
    build: async (order, wallet) => {
      orders.push({ ...order, wallet: wallet.publicKey }); active.set(wallet.publicKey, order);
      const value = build(order, wallet); value.outputDecimals = 6; value.blockhashWithMetadata.blockhash = Keypair.generate().publicKey.toBase58(); return value;
    },
    rpc: async method => { assert.equal(method, 'simulateTransaction'); return { value: { err: null } }; },
    submit: async bytes => {
      const tx = VersionedTransaction.deserialize(bytes), signature = bs58.encode(tx.signatures[0]), owner = tx.message.staticAccountKeys[0].toBase58(), order = active.get(owner);
      const journal = JSON.parse(await readFile(join(dir, 'live.json')));
      const saved = journal.pending.find(item => item.signature === signature);
      assert(saved?.signatureVerified, 'signature must be checked and journalled before broadcast');
      if (order.manualRequestId) {
        assert(journal.seen.includes(`manual:${order.manualRequestId}`), 'request ID must be durable before broadcast');
        assert(journal.manualRequests.find(item => item.id === order.manualRequestId).outcomes.find(item => item.wallet === owner).trades.some(item => item.signature === signature));
      }
      submissions.push({ signature, owner, order });
      receipts.set(signature, { transaction: { message: { accountKeys: [{ pubkey: owner, signer: true }] } }, meta: {
        err: fail ? { InstructionError: [0, 'failed'] } : null,
        preTokenBalances: [token(owner, order.kind === 'buy' ? order.outputMint : order.inputMint, order.kind === 'buy' ? 0n : order.amount)],
        postTokenBalances: [token(owner, order.kind === 'buy' ? order.outputMint : order.inputMint, order.kind === 'buy' ? 1000n : 0n)],
      } });
      if (options.timeout) throw new Error('transport timeout');
      return { route: 'Local mock', signature };
    },
    statuses: async signatures => signatures.map(signature => !unresolved && receipts.has(signature) ? { confirmationStatus: 'confirmed', err: fail ? { InstructionError: [0, 'failed'] } : null } : null),
    transaction: async signature => receipts.get(signature) || null,
  };
  const engine = new Engine(ledgers, () => p); engine.receiptIntervalMs = 2; engine.receiptWaitMs = unresolved ? 1 : 2000;
  t.after(async () => { engine.stop(); await engine.stopPromise; await rm(dir, { recursive: true, force: true }); });
  return { engine, p, ledgers, dir, orders, submissions, get initializations() { return initializations; }, get subscriptions() { return subscriptions; },
    set fail(value) { fail = value; }, set unresolved(value) { unresolved = value; } };
}

function lot(wallet, { id = randomUUID(), amount = 1000n, exitMint = SOL, venue = null, ...extra } = {}) {
  return { id, wallet: pub(wallet), walletLabel: 'Test wallet', lead, mint, decimals: 6, remaining: String(amount), original: String(amount), exitMint, venue, mode: 'live', ...extra };
}

async function drain(engine) { await Promise.all([...engine.queues.values()]); }

test('a 20-wallet manual batch recovers a route 429, quotes each wallet, and submits each intent exactly once', async t => {
  const h=await harness(t),keys=Array.from({length:20},()=>Keypair.generate()),raw=config({mode:'live',wallets:keys,leads:[]}),provider=new Providers(validateConfig(structuredClone(raw),{requireLeads:false}),(level,message)=>h.engine.event(level,message));
  const gate=new RequestPacing();t.after(()=>gate.close());provider.jupiterGate={acquire:(c,s,d)=>gate.acquire('jupiter','batch',3,{signal:s,deadline:d}),cooldown:(c,ms)=>gate.cooldown('jupiter',5)};
  const original=h.p.build;let calls=0;
  // Record real manual IDs before the mock receipt builder captures the order.
  const byOwner=new Map();h.p.build=async(order,wallet,signal)=>{byOwner.set(wallet.publicKey,order);return provider.jupiterBuild(order,wallet,signal);};
  provider.fetch=async url=>{if(++calls===1)throw new ProviderError('429',{rateLimited:true});const q=new URL(url).searchParams,owner=q.get('taker');return original(byOwner.get(owner),provider.c.wallets.find(w=>w.publicKey===owner));};
  const trade=request('buy',keys),result=await h.engine.manualTrade(raw,trade);
  assert.equal(calls,21);assert.equal(h.submissions.length,20);assert.equal(new Set(h.submissions.map(x=>x.owner)).size,20);assert(result.manualResult.outcomes.every(x=>x.status==='confirmed'));assert(h.submissions.every(x=>x.order.amount===12345678n));
  await h.engine.manualTrade(raw,trade);assert.equal(h.submissions.length,20);assert(!h.ledgers.live.data.events.some(e=>e.level==='error'));
});

test('manual quota waiting does not consume the fresh quote age; low balances after waiting still prevent signing',async t=>{
  const h=await harness(t),original=h.p.build;let routed=false;
  h.p.build=async(...args)=>{await delay(150);routed=true;return {...await original(...args),routeName:'Jupiter'};};
  h.p.balance=async()=>routed?0n:10000000000n;
  const result=await h.engine.manualTrade(config({mode:'live',leads:[],maxSignalAgeMs:100}),request());
  assert.equal(h.submissions.length,0);assert.equal(result.manualResult.outcomes[0].status,'failed');assert.match(result.manualResult.outcomes[0].error,/Insufficient SOL/);
});
test('an atomic fee-conversion wait cannot renew an expired manual swap quote',async t=>{
  const h=await harness(t);h.engine.platformContext={accountId:'fee-quote',recipient:pub(key2),mainWallet:quote,settlement:'sol'};
  h.ledgers.live.data.lots.push(lot(key1,{amount:1000000n,exitMint:quote}));
  h.p.jupiterBuild=async(order,wallet)=>{await delay(150);return build(order,wallet);};
  const result=await h.engine.manualTrade(config({mode:'live',leads:[],maxSignalAgeMs:100}),request('sell'));
  assert.equal(h.submissions.length,0);assert.equal(result.manualResult.outcomes[0].status,'failed');assert.match(result.manualResult.outcomes[0].error,/signal age/);
});

test('stopped manual buy uses exact SOL per selected wallet, requires no leads, and never starts automatic copying', async t => {
  const h = await harness(t), third = Keypair.generate();
  const result = await h.engine.manualTrade(config({ mode: 'live', wallets: [key1, key2, third], leads: [] }), request('buy', [key1, key2]));
  assert.equal(result.state, 'stopped'); assert.equal(result.manualResult.state, 'complete');
  assert.equal(h.subscriptions, 0); assert.equal(h.submissions.length, 2); assert.equal(h.engine.pollTimer, undefined);
  assert(result.manualResult.outcomes.every(item => item.status === 'confirmed' && item.signature));
  assert(h.orders.every(order => order.inputMint === SOL && order.amount === 12345678n));
  assert.equal(h.ledgers.live.data.lots.length, 2); assert(h.ledgers.live.data.lots.every(item => item.lead === 'manual'));
  assert(h.engine.c.wallets.every(wallet => wallet.keypair === null));
});

test('a repeated request remains idempotent across a new engine and refuses changed settings or mode', async t => {
  const h = await harness(t), trade = request();
  const first = await h.engine.manualTrade(config({ mode: 'live', leads: [] }), trade);
  const fresh = { live: await new Ledger(join(h.dir, 'live.json')).load(), paper: await new Ledger(join(h.dir, 'paper.json')).load() };
  const restarted = new Engine(fresh, () => assert.fail('duplicate must not initialize a provider'));
  const second = await restarted.manualTrade(config({ mode: 'live', leads: [] }), trade);
  assert.deepEqual(second.manualResult, first.manualResult); assert.equal(h.submissions.length, 1);
  await assert.rejects(restarted.manualTrade(config({ mode: 'live' }), { ...trade, amountSol: '.5' }), /different trade settings/);
  await assert.rejects(restarted.manualTrade(config({ mode: 'paper' }), trade), /different trade settings/);
});

test('manual sell handles selected tracked lots across all leads, with exact percentages and separate quote/venue routes', async t => {
  const h = await harness(t), venue = { type: 'pump', pool: pub(Keypair.generate()), baseMint: mint, quoteMint: SOL };
  const lots = [lot(key1, { amount: 1001n }), lot(key1, { amount: 2000n, lead: lead2 }), lot(key1, { amount: 3000n, lead: 'manual', exitMint: quote }),
    lot(key1, { amount: 4000n, venue }), lot(key2, { amount: 9999n })];
  h.ledgers.live.data.lots.push(...lots);
  const result = await h.engine.manualTrade(config({ mode: 'live', wallets: [key1, key2], leads: [] }), request('sell', [key1], { sellPercent: 50 }));
  assert.equal(result.manualResult.outcomes[0].status, 'confirmed'); assert.equal(h.submissions.length, 3);
  assert.deepEqual(h.orders.map(order => order.amount).sort((a, b) => Number(a - b)), [1500n, 1500n, 2000n]);
  assert.deepEqual(lots.map(item => item.remaining), ['501', '1000', '1500', '2000', '9999']);
  assert.equal(result.manualResult.outcomes[0].signatures.length, 3);
});

test('restart after reserving a manual request reports interrupted work and never replays it', async t => {
  const h = await harness(t), trade = request(), normalized = validateManualTrade(trade);
  h.ledgers.live.data.manualRequests = [{ id: trade.id, mode: 'live', request: normalized, state: 'preparing', createdAt: Date.now(),
    outcomes: [{ wallet: pub(key1), status: 'skipped', error: 'Waiting to prepare this wallet.', trades: [] }] }];
  await h.ledgers.live.remember(`manual:${trade.id}`);
  const restarted = new Engine({ live: await new Ledger(join(h.dir, 'live.json')).load(), paper: h.ledgers.paper }, () => assert.fail('interrupted requests must not be replayed'));
  const result = await restarted.manualTrade(config({ mode: 'live' }), trade);
  assert.equal(result.manualResult.state, 'complete'); assert.equal(result.manualResult.outcomes[0].status, 'skipped');
  assert.match(result.manualResult.outcomes[0].error, /previous session ended/);
  assert.equal(JSON.parse(await readFile(join(h.dir, 'live.json'))).manualRequests[0].state, 'complete');
});

test('manual sells only tracked funds, and skip unresolved wallets without signing additional transactions', async t => {
  const h = await harness(t, { unresolved: true }), trade = request();
  const pending = await h.engine.manualTrade(config({ mode: 'live' }), trade);
  assert.equal(pending.manualResult.outcomes[0].status, 'pending'); assert.equal(h.submissions.length, 1);
  const retry = await h.engine.manualTrade(config({ mode: 'live' }), trade);
  assert.equal(retry.manualResult.outcomes[0].status, 'pending'); assert.equal(h.submissions.length, 1);
  const sell = await h.engine.manualTrade(config({ mode: 'live', wallets: [key1, key2] }), request('sell', [key1, key2]));
  assert(sell.manualResult.outcomes.every(item => item.status === 'skipped'));
  assert.match(sell.manualResult.outcomes.find(item => item.wallet === pub(key1)).error, /unresolved/);
  assert.match(sell.manualResult.outcomes.find(item => item.wallet === pub(key2)).error, /No tracked position/);
  assert.equal(h.submissions.length, 1); assert.equal(h.ledgers.live.data.pending.length, 1);
});

test('confirmed chain failures keep positions and report failed rather than confirmed manual sells', async t => {
  const h = await harness(t, { fail: true }); h.ledgers.live.data.lots.push(lot(key1));
  const result = await h.engine.manualTrade(config({ mode: 'live' }), request('sell'));
  assert.equal(result.manualResult.outcomes[0].status, 'failed'); assert.equal(h.ledgers.live.data.lots[0].remaining, '1000');
  assert.equal(h.ledgers.live.data.pending.length, 0); assert.equal(h.submissions.length, 1);
});

test('manual and automatic actions share wallet queues while manual holdings remain outside lead mirroring', async t => {
  const h = await harness(t); await h.engine.start(config({ mode: 'live', wallets: [key1, key2], simulateBeforeSend: false }));
  const original = h.p.build; let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  let held = false;
  h.p.build = async (order, wallet) => { if (!held && order.manualRequestId && wallet.publicKey === pub(key1)) { held = true; entered(); await gate; } return original(order, wallet); };
  const trade = request('buy', [key1]), manual = h.engine.manualTrade(config({ mode: 'live' }), trade); await ready;
  const same = await h.engine.manualTrade(config({ mode: 'live' }), trade);
  assert.equal(same.manualResult.state, 'executing'); assert.equal(h.submissions.length, 0);
  await h.engine.onTransaction(event());
  while (!h.submissions.some(item => item.owner === pub(key2))) await delay(2);
  assert(!h.submissions.some(item => item.owner === pub(key1)), 'same-wallet automatic order must wait for manual job');
  release(); await manual; await drain(h.engine);
  assert.equal(h.engine.state, 'running'); assert.equal(h.subscriptions, 1); assert.equal(h.submissions.length, 3);
  await h.engine.onTransaction(event(swap({ input: mint, output: SOL, sold: 1000n })));
  await drain(h.engine);
  const remaining = h.ledgers.live.data.lots.filter(item => BigInt(item.remaining) > 0n);
  assert.equal(remaining.length, 1); assert.equal(remaining[0].lead, 'manual');
});

test('Stop during manual route preparation cancels before signing and leaves Start available', async t => {
  const h = await harness(t); let entered, release;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const original = h.p.build;
  h.p.build = async (...args) => { entered(); await gate; return original(...args); };
  const action = h.engine.manualTrade(config({ mode: 'live' }), request()); await ready;
  h.engine.stop(); release(); const result = await action;
  assert.equal(result.state, 'stopped'); assert.equal(result.manualResult.outcomes[0].status, 'skipped');
  assert.equal(h.submissions.length, 0); assert.equal(h.ledgers.live.data.pending.length, 0);
  await h.engine.start(config({ mode: 'live' })); assert.equal(h.engine.state, 'running');
});

test('manual validation rejects unsafe selections and mode/run mismatches before any transaction', async t => {
  const h = await harness(t);
  for (const change of [{ wallets: [] }, { wallets: [pub(key1), pub(key1)] }, { amountSol: '0' }, { amountSol: '.0000000001' }, { mint: 'bad' }, { id: 'not-a-uuid' }]) {
    await assert.rejects(h.engine.manualTrade(config({ mode: 'live' }), request('buy', [key1], change)));
  }
  await assert.rejects(h.engine.manualTrade(config({ mode: 'live' }), request('buy', [key2])), /only use wallets imported/);
  assert.equal(h.initializations, 0);
  await h.engine.start(config({ mode: 'paper' }));
  await assert.rejects(h.engine.manualTrade(config({ mode: 'live' }), request()), /mode must match/);
  await assert.rejects(h.engine.manualTrade(config(), request('buy', [key1], { expectedRunId: randomUUID() })), /run changed/);
  assert.equal(h.submissions.length, 0);
});

test('paper manual trades never broadcast and fee-size decimals are validated without floating point rounding', async t => {
  const h = await harness(t), raw = config({ leads: [] });
  const result = await h.engine.manualTrade(raw, request('buy', [key1], { amountSol: '.000000001' }));
  assert.equal(h.orders[0].amount, 1n); assert.equal(h.submissions.length, 0); assert.equal(result.manualResult.outcomes[0].status, 'confirmed');
  assert.equal(h.ledgers.live.data.lots.length, 0); assert.equal(h.ledgers.paper.data.lots.length, 1);
  for (const sellPercent of [0, -1, 101, 'NaN', '1e2']) assert.throws(() => validateManualTrade(request('sell', [key1], { sellPercent })));
  assert.equal(manualSellGroups([lot(key1, { amount: 1n })], pub(key1), mint, '50000000').length, 0);
  const dust = Array.from({ length: 10 }, () => lot(key1, { amount: 1n }));
  const [group] = manualSellGroups(dust, pub(key1), mint, '50000000');
  assert.equal(group.amount, 5n); assert.equal(group.allocations.length, 5);
  assert(group.allocations.every(allocation => allocation.amount === '1'));
});

test('partial confirmed debit is distributed across tiny lots without overdrawing the final lot', async t => {
  const h = await harness(t), lots = Array.from({ length: 10 }, () => lot(key1, { amount: 1n }));
  h.ledgers.live.data.lots.push(...lots);
  const original = h.p.transaction;
  h.p.transaction = async signature => {
    const receipt = await original(signature);
    if (receipt) receipt.meta.postTokenBalances[0].uiTokenAmount.amount = '1';
    return receipt;
  };
  const result = await h.engine.manualTrade(config({ mode: 'live' }), request('sell'));
  assert.equal(result.manualResult.outcomes[0].status, 'confirmed');
  assert.equal(lots.reduce((sum, item) => sum + BigInt(item.remaining), 0n), 1n);
  assert(lots.every(item => BigInt(item.remaining) >= 0n));
});
