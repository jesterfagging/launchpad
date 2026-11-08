import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { TelegramStore } from '../src/telegram-store.mjs';
import { LaunchpadTrading } from '../src/launchpad-trading.mjs';

const id = 'a'.repeat(32), otherId = 'b'.repeat(32);
const pair = () => { const k = Keypair.generate(); return { address: k.publicKey.toBase58(), secret: bs58.encode(k.secretKey) }; };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-main-trade-')), main = pair(), connected = pair(), creator = pair(), base = pair(), quote = pair();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stores = new Map(), now = { value: 1_000_000 }, flags = { active: true, hidden: false, banned: new Set(), receipts: null, failSend: false, height: 100 }, calls = { broadcast: 0, prepare: 0, receipt: 0 };
  const account = { id, authType: 'password', mainWallet: main.address, cashbackWallet: connected.address, banned: false };
  const accounts = { get: async accountId => accountId === id ? { ...account } : { ...account, id: otherId }, storeFor(accountId) { if (!stores.has(accountId)) stores.set(accountId, new TelegramStore(join(dir, accountId), Buffer.alloc(32, 5), 'account:' + accountId)); return stores.get(accountId); }, assertWalletAllowed: async address => { if (flags.banned.has(address)) throw Object.assign(Error('Wallet banned'), { statusCode: 403 }); } };
  await accounts.storeFor(id).write('main-wallet', { publicKey: main.address, privateKey: main.secret });
  const book = async () => accounts.storeFor(id).read('launchpad-trades', { version: 1, trades: [] });
  const record = { coin: { mint: base.address, name: 'Example', symbol: 'EXAMPLE', taxBps: 500, feeMode: 'holders', quote: { mint: quote.address } }, chainRecord: { curve: pair().address, input: {}, keys: { wallet: creator, payer: creator, platform: creator, mint: base }, review: { quoteDecimals: 9 } } };
  const prepared = new WeakSet();
  const chain = {
    c: { getBlockHeight: async () => flags.height },
    walletBalances: async (_launch, { wallet }) => ({ nativeBalanceLamports: '2000000000', baseBalanceRaw: '50000000', quoteBalanceRaw: '1000000000', baseDecimals: 6, quoteDecimals: 9, wallet, secret: 'DO NOT RETURN' }),
    quote: async (launch, input) => {
      assert.equal(launch.keys.wallet.secret, undefined); assert.equal(launch.keys.mint.secret, undefined); assert.equal(launch.input.taxBps, 500);
      const result = { ...input, amountRaw: '100000000', expectedOutputRaw: '123456', minimumOutputRaw: '120000', inputMint: quote.address, outputMint: base.address, inputSymbol: 'SOL', outputSymbol: 'EXAMPLE', inputDecimals: 9, outputDecimals: 6, expectedOutput: '0.123456', minimumOutput: '0.12', expiresAt: now.value + 30_000, market: 'curve', pool: launch.curve };
      prepared.add(result); return result;
    },
    prepareTrade: async (_launch, q, options) => {
      assert(prepared.has(q)); calls.prepare++; calls.options = options;
      await flags.duringPrepare?.();
      return options.external ? { needsSignature: true, unsignedRaw: 'unsigned', state: 'awaiting_signature', externalSigner: connected.address, blockhash: 'hash', lastValidBlockHeight: 200 } : { needsSignature: false, state: 'pending', raw: 'SIGNED DEFAULT BYTES', signature: 'defaultSignature', lastValidBlockHeight: 200 };
    },
    acceptSigned: async (operation, transaction) => { if (transaction !== 'expectedSigned') throw Error('The wallet changed the reviewed transaction. Nothing was submitted.'); await flags.duringAccept?.(); return { ...operation, needsSignature: false, raw: transaction, signature: 'externalSignature', state: 'pending' }; },
    broadcast: async operation => { calls.broadcast++; const saved = await book(); assert(saved.trades.some(row => row.state === 'pending' && row.operation.signature === operation.signature)); if (flags.failSend) throw Error('RPC timeout'); },
    receipt: async () => { calls.receipt++; return flags.receipts; },
    close() {}
  };
  const context = { sessionToken: 'session-token', authorize: async () => { if (!flags.active) throw Object.assign(Error('Session expired'), { statusCode: 401 }); } };
  const options = { accounts, rpcUrl: 'https://rpc.example/' + randomBytes(8).toString('hex'), resolveCoin: async () => { if (flags.hidden) throw Object.assign(Error('Coin hidden'), { statusCode: 404 }); return record; }, chainFactory: async () => chain, now: () => now.value };
  const service = new LaunchpadTrading(options);
  const input = { mint: base.address, mode: 'default', side: 'buy', amount: '0.1', slippageBps: 100 };
  const getQuote = async (overrides = {}) => (await service.quote(id, { ...input, ...overrides }, context)).quote;
  const prepare = async (overrides = {}) => { const q = await getQuote(overrides); return (await service.prepare(id, { quoteId: q.id, requestId: randomBytes(12).toString('hex') }, context)).trade; };
  return { ...options, service, accounts, account, main, connected, creator, record, flags, calls, context, now, input, getQuote, prepare, book, dir, chain };
}

test('main wallet selection ignores cashback and never exposes account keys', async t => {
  const f = await fixture(t);
  const selected = await f.service.wallet(id, f.input, f.context);
  assert.equal(selected.wallet.address, f.main.address); assert.equal(selected.wallet.mode, 'default');
  assert(!JSON.stringify(selected).includes(f.main.secret)); assert(!JSON.stringify(selected).includes('DO NOT RETURN'));
  const trade = await f.prepare();
  assert.equal(f.calls.options.secret, f.main.secret); assert.equal(trade.state, 'prepared'); assert.equal(trade.signature, 'defaultSignature');
  assert(!JSON.stringify(trade).includes('SIGNED DEFAULT')); assert(!JSON.stringify(trade).includes(f.creator.secret));
  const bytes = await readFile(join(f.dir, id, 'launchpad-trades.enc'), 'utf8'); assert(!bytes.includes('SIGNED DEFAULT'));
});

test('connected wallet has explicit precedence and cannot fall back to a stored main key', async t => {
  const f = await fixture(t), trade = await f.prepare({ mode: 'external', wallet: f.connected.address });
  assert.equal(f.calls.options.secret, undefined); assert.equal(trade.state, 'awaiting_signature');
  await assert.rejects(f.service.submit(id, { tradeId: trade.id, confirm: true, signedTransaction: 'changedMessage' }, f.context), /changed/);
  assert.equal(f.calls.broadcast, 0); assert.equal(f.calls.prepare, 1); assert.equal((await f.book()).trades[0].state, 'awaiting_signature');
});

test('wallet-created accounts must connect and cannot silently generate or use a managed key', async t => {
  const f = await fixture(t); f.account.authType = 'wallet';
  assert.equal((await f.service.wallet(id, f.input, f.context)).wallet.requiresConnection, true);
  await assert.rejects(f.getQuote(), /Connect your account wallet/); assert.equal(f.calls.prepare, 0);
});

test('immutable quote is bound to account and session, expires, and excludes creator secrets', async t => {
  const f = await fixture(t), q = await f.getQuote(); q.amount = '999';
  await assert.rejects(f.service.prepare(otherId, { quoteId: q.id, requestId: '0000000000000001' }, f.context), /quote expired/);
  await assert.rejects(f.service.prepare(id, { quoteId: q.id, requestId: '0000000000000002' }, { ...f.context, sessionToken: 'different' }), /quote expired/);
  const trade = (await f.service.prepare(id, { quoteId: q.id, requestId: '0000000000000003' }, f.context)).trade;
  assert.equal(trade.quote.amount, '0.1'); await f.service.cancel(id, { tradeId: trade.id }, f.context);
  const next = await f.getQuote(); f.now.value += 31_000;
  await assert.rejects(f.service.prepare(id, { quoteId: next.id, requestId: '0000000000000004' }, f.context), /quote expired/);
});

test('durable journal precedes broadcast and duplicate submits never duplicate a transaction', async t => {
  const f = await fixture(t), trade = await f.prepare();
  const [a, b] = await Promise.all([f.service.submit(id, { tradeId: trade.id, confirm: true }, f.context), f.service.submit(id, { tradeId: trade.id, confirm: true }, f.context)]);
  assert.equal(a.trade.state, 'pending'); assert.equal(b.trade.state, 'pending'); assert.equal(f.calls.broadcast, 1);
  await assert.rejects(f.prepare(), /previous trade/);
});

test('request IDs are idempotent and cannot be rebound to another quote', async t => {
  const f = await fixture(t), q = await f.getQuote(), body = { quoteId: q.id, requestId: 'same-request-00000001' };
  const first = await f.service.prepare(id, body, f.context), second = await f.service.prepare(id, body, f.context);
  assert.equal(first.trade.id, second.trade.id); assert.equal(f.calls.prepare, 1);
  await assert.rejects(f.service.prepare(id, { ...body, quoteId: 'another' }, f.context), /another trade/);
});

test('send timeout survives a service restart and blocks replacement until finalized receipt', async t => {
  const f = await fixture(t), trade = await f.prepare(); f.flags.failSend = true;
  assert.match((await f.service.submit(id, { tradeId: trade.id, confirm: true }, f.context)).trade.error, /uncertain/);
  const restarted = new LaunchpadTrading({ ...f, now: () => f.now.value }), newContext = { ...f.context, sessionToken: 'new-session' };
  assert.equal((await restarted.status(id, { tradeId: trade.id }, newContext)).trade.state, 'pending'); assert.equal(f.calls.broadcast, 1);
  const replacement=await restarted.quote(id,f.input,newContext);
  await assert.rejects(restarted.prepare(id,{quoteId:replacement.quote.id,requestId:'new-request-after-restart'},newContext),/previous trade/);
  await assert.rejects(restarted.cancel(id, { tradeId: trade.id }, newContext), /already be onchain/);
  f.flags.receipts = { slot: 333, meta: { err: null }, transaction: { signatures: ['defaultSignature'] } }; f.now.value += 4000;
  assert.equal((await restarted.status(id, { tradeId: trade.id }, newContext)).trade.state, 'confirmed'); assert.equal(f.calls.broadcast, 1);
});

test('no hosted trade is sent without explicit confirmation', async t => {
  const f = await fixture(t), trade = await f.prepare();
  await assert.rejects(f.service.submit(id, { tradeId: trade.id }, f.context), /Confirm/); assert.equal(f.calls.broadcast, 0);
});

test('session revocation during preparation prevents saving or sending a signed trade', async t => {
  const f = await fixture(t); f.flags.duringPrepare = () => { f.flags.active = false; };
  await assert.rejects(f.prepare(), /Session expired/); assert.equal((await f.book()).trades.length, 0); assert.equal(f.calls.broadcast, 0);
});

test('session revocation while a wallet signature is verified prevents broadcast', async t => {
  const f = await fixture(t), trade = await f.prepare({ mode: 'external', wallet: f.connected.address });
  f.flags.duringAccept = () => { f.flags.active = false; };
  await assert.rejects(f.service.submit(id, { tradeId: trade.id, signedTransaction: 'expectedSigned', confirm: true }, f.context), /Session expired/); assert.equal(f.calls.broadcast, 0);
});

test('hidden coins, banned accounts, and banned connected wallets block trading', async t => {
  const f = await fixture(t), q = await f.getQuote(); f.flags.hidden = true;
  await assert.rejects(f.service.prepare(id, { quoteId: q.id, requestId: '0000000000000001' }, f.context), /hidden/);
  f.flags.hidden = false; f.account.banned = true; await assert.rejects(f.getQuote(), /cannot trade/);
  f.account.banned = false; f.flags.banned.add(f.connected.address);
  await assert.rejects(f.getQuote({ mode: 'external', wallet: f.connected.address }), /banned/);
});

test('expired unsubmitted default transaction is safe to replace without broadcasting', async t => {
  const f = await fixture(t), trade = await f.prepare(); f.flags.height = 201;
  assert.equal((await f.service.submit(id, { tradeId: trade.id, confirm: true }, f.context)).trade.state, 'expired'); assert.equal(f.calls.broadcast, 0);
});

test('status never trusts a receipt for another signature and bounds repeated RPC polling', async t => {
  const f = await fixture(t), trade = await f.prepare(); await f.service.submit(id, { tradeId: trade.id, confirm: true }, f.context);
  f.flags.receipts = { slot: 333, meta: { err: null }, transaction: { signatures: ['wrongSignature'] } };
  assert.equal((await f.service.status(id, { tradeId: trade.id }, f.context)).trade.state, 'pending');
  await f.service.status(id, { tradeId: trade.id }, f.context); assert.equal(f.calls.receipt, 1);
});

test('cancel only discards unsubmitted transactions and never picks a replacement wallet', async t => {
  const f = await fixture(t), trade = await f.prepare({ mode: 'external', wallet: f.connected.address });
  assert.equal((await f.service.cancel(id, { tradeId: trade.id }, f.context)).trade.state, 'cancelled');
  assert.equal((await f.service.submit(id, { tradeId: trade.id, confirm: true }, f.context)).trade.state, 'cancelled'); assert.equal(f.calls.broadcast, 0);
});

test('all launch types use identical wallet safeguards for buys and sells', async t => {
  const f = await fixture(t);
  for (const mode of ['creator', 'holders', 'buyback']) for (const side of ['buy', 'sell']) {
    f.record.coin.feeMode = mode; const trade = await f.prepare({ side }); assert.equal(trade.wallet, f.main.address); assert.equal(trade.quote.side, side);
    await f.service.cancel(id, { tradeId: trade.id }, f.context);
  }
});

test('pending trade expires only after two advancing retained-history proofs and a fresh review is still required', async t => {
  const f = await fixture(t), trade = await f.prepare(); await f.service.submit(id, { tradeId: trade.id, confirm: true }, f.context);
  let checkpoint = { height: 300, slot: 330 };
  f.chain.pendingTransactionState = async op => ({ state: 'expired', signature: op.signature, checkpoint, historyFromSlot: 0 });
  f.now.value += 180001;
  assert.equal((await f.service.status(id, { tradeId: trade.id }, f.context)).trade.state, 'pending');
  f.now.value += 4000; checkpoint = { height: 301, slot: 331 };
  assert.equal((await f.service.status(id, { tradeId: trade.id }, f.context)).trade.state, 'pending');
  f.now.value += 7000; checkpoint = { height: 302, slot: 332 };
  assert.equal((await f.service.status(id, { tradeId: trade.id }, f.context)).trade.state, 'expired');
  const saved = (await f.book()).trades[0]; assert(saved.operation.expiryProof); assert.equal(saved.operation.raw, undefined); assert.equal(f.calls.broadcast, 1); assert.equal(f.calls.prepare, 1);
  assert.equal((await f.service.submit(id, { tradeId: trade.id, confirm: true }, f.context)).trade.state, 'expired');
});

test('pruned or non-advancing history never releases a pending trade', async t => {
  const f = await fixture(t), trade = await f.prepare(); await f.service.submit(id, { tradeId: trade.id, confirm: true }, f.context); f.now.value += 180001;
  f.chain.pendingTransactionState = async () => ({ state: 'unknown', reason: 'History pruned' });
  assert.equal((await f.service.status(id, { tradeId: trade.id }, f.context)).trade.state, 'pending');
  f.chain.pendingTransactionState = async op => ({ state: 'expired', signature: op.signature, checkpoint: { height: 300, slot: 330 }, historyFromSlot: 0 });
  f.now.value += 11000; await f.service.status(id, { tradeId: trade.id }, f.context);
  f.now.value += 11000; assert.equal((await f.service.status(id, { tradeId: trade.id }, f.context)).trade.state, 'pending');
  assert.equal(f.calls.broadcast, 1);
});

test('a positive status is persisted even when receipt lookup throws, and survives restart and a later cache miss', async t => {
  const f = await fixture(t), trade = await f.prepare(); await f.service.submit(id, { tradeId: trade.id, confirm: true }, f.context);
  f.chain.receipt = async op => { op.observedSignatureStatus = { confirmationStatus: 'confirmed', slot: 123 }; throw Error('Archival RPC unavailable'); };
  await f.service.status(id, { tradeId: trade.id }, f.context);
  assert.equal((await f.book()).trades[0].operation.observedSignatureStatus.slot, 123);
  f.chain.receipt = async () => null;
  let expiryCalls = 0; f.chain.pendingTransactionState = async () => { expiryCalls++; return { state: 'expired' }; };
  const restarted = new LaunchpadTrading({ ...f, now: () => f.now.value }); f.now.value += 181000;
  const resumed = await restarted.status(id, { tradeId: trade.id }, { ...f.context, sessionToken: 'replacement-session' });
  assert.equal(resumed.trade.state, 'pending'); assert.match(resumed.trade.error, /observed onchain/); assert.equal(expiryCalls, 0); assert.equal(f.calls.broadcast, 1);
});

test('service instances sharing an endpoint use one FIFO submission admission queue', async t => {
  const a = await fixture(t), b = await fixture(t), url = 'https://rpc.example/one-per-second';
  const left = new LaunchpadTrading({ ...a, rpcUrl: url, now: () => a.now.value }), right = new LaunchpadTrading({ ...b, rpcUrl: url, now: () => b.now.value });
  const make = async (service, f) => { const q = (await service.quote(id, f.input, f.context)).quote; return (await service.prepare(id, { quoteId: q.id, requestId: randomBytes(12).toString('hex') }, f.context)).trade; };
  const x = await make(left, a), y = await make(right, b), starts = []; let running = 0, peak = 0;
  const broadcast = label => async () => { starts.push(label); peak = Math.max(peak, ++running); await new Promise(resolve => setTimeout(resolve, 15)); running--; };
  a.chain.broadcast = broadcast('left'); b.chain.broadcast = broadcast('right');
  await Promise.all([left.submit(id, { tradeId: x.id, confirm: true }, a.context), right.submit(id, { tradeId: y.id, confirm: true }, b.context)]);
  assert.equal(starts.length, 2); assert.equal(peak, 1);
  // RPC transport pacing is tested separately. These injected chains bypass
  // that transport and must not consume an extra provider permit here.
});

test('revocation at submission admission prevents broadcasting', async t => {
  const f = await fixture(t), trade = await f.prepare();
  const sendSlot = f.service.sendSlot.bind(f.service);
  f.service.sendSlot = (callback, options) => sendSlot(slot => { f.flags.active = false; return callback(slot); }, options);
  await assert.rejects(f.service.submit(id, { tradeId: trade.id, confirm: true }, f.context), /Session expired/);
  assert.equal(f.calls.broadcast, 0); assert.equal((await f.book()).trades[0].state, 'prepared');
});

test('submission waiting is bounded from arrival and full queues reject before running callbacks', async t => {
  const f = await fixture(t); f.service.capacities.maxSendQueue = 2; f.service.capacities.sendDeadlineMs = 100;
  let release, entered; const enteredPromise = new Promise(resolve => entered = resolve);
  const first = f.service.sendSlot(async () => { entered(); await new Promise(resolve => release = resolve); });
  await enteredPromise; let laterRan = false;
  const second = f.service.sendSlot(() => { laterRan = true; });
  const secondOutcome = assert.rejects(second, error => error.statusCode === 503 && /deadline/.test(error.message));
  await assert.rejects(f.service.sendSlot(() => { laterRan = true; }), error => error.statusCode === 503 && /busy/.test(error.message));
  await secondOutcome; assert.equal(laterRan, false); release(); await first;
});

test('quote admission deduplicates concurrent identical work before provider requests', async t => {
  const f = await fixture(t); let release, calls = 0;
  const original = f.chain.quote;
  f.chain.quote = async (...args) => { calls++; await new Promise(resolve => release = resolve); return original(...args); };
  const first = f.getQuote(), second = f.getQuote();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.getQuote({ amount: '0.2' }), error => error.statusCode === 503);
  release(); const [a, b] = await Promise.all([first, second]); assert.equal(calls, 1); assert.equal(a.id, b.id);
});

test('one thousand accepted quote reviews survive capacity pressure until expiry', async t => {
  const f = await fixture(t); f.service.capacities.maxQuoteReviews = 1000;
  const quotes = [];
  for (let index = 1; index <= 1000; index++) {
    const accountId = index.toString(16).padStart(32, '0');
    quotes.push((await f.service.quote(accountId, { ...f.input, mode: 'external', wallet: f.connected.address }, f.context)).quote);
  }
  await assert.rejects(f.getQuote(), error => error.statusCode === 503);
  assert.equal(f.service.quotes.size, 1000); assert(f.service.quotes.has(quotes[0].id)); assert(f.service.quotes.has(quotes.at(-1).id));
  f.now.value += 30001; await f.getQuote(); assert.equal(f.service.quotes.size, 1);
});

test('background confirmation recovers a durable pending trade after restart without a visiting user or rebroadcast authority', async t => {
  const f = await fixture(t), trade = await f.prepare(); await f.service.submit(id, { tradeId: trade.id, confirm: true }, f.context);
  f.accounts.list = async () => [f.account];
  f.flags.receipts = { transaction: { signatures: ['defaultSignature'] }, meta: { err: null }, slot: 123 };
  let batches = 0, verificationCalls = 0;
  f.chain.verifyBroadcastOperation = () => { verificationCalls++; return true; };
  f.chain.receiptBatch = async operations => { batches++; return operations.map(operation => ({ operation, receipt: f.flags.receipts, error: null })); };
  const restarted = new LaunchpadTrading({ ...f, now: () => f.now.value, random: () => 0 }); t.after(() => restarted.close());
  await restarted.start(); f.now.value += 2000; await restarted.runReconciliation();
  assert.equal((await f.book()).trades[0].state, 'confirmed'); assert.equal(batches, 1); assert.equal(f.calls.broadcast, 1); assert.equal(verificationCalls, 0);
});

test('started service status reads saved state without multiplying provider confirmation calls', async t => {
  const f = await fixture(t), trade = await f.prepare(); await f.service.submit(id, { tradeId: trade.id, confirm: true }, f.context);
  await f.service.start(); t.after(() => f.service.close());
  f.now.value += 5000;
  for (let index = 0; index < 10; index++) assert.equal((await f.service.status(id, { tradeId: trade.id }, f.context)).trade.state, 'pending');
  assert.equal(f.calls.receipt, 0);
  await f.service.runReconciliation(); assert.equal(f.calls.receipt, 1);
});

test('background retries only the exact saved bytes and revoked authorization stops further retries', async t => {
  const f = await fixture(t), trade = await f.prepare(); await f.service.submit(id, { tradeId: trade.id, confirm: true }, f.context);
  const original = (await f.book()).trades[0].operation.raw, sent = [];
  f.chain.verifyBroadcastOperation = operation => { assert.equal(operation.raw, original); assert.match(operation.broadcastRawHash, /^[a-f0-9]{64}$/); return true; };
  f.chain.broadcast = async operation => { sent.push(operation.raw); };
  await f.service.start(); t.after(() => f.service.close()); f.now.value += 9000;
  await f.service.runReconciliation(); assert.deepEqual(sent, [original]); assert.equal(f.calls.prepare, 1);
  f.flags.active = false; f.now.value += 11000; await f.service.runReconciliation(); assert.deepEqual(sent, [original]);
  assert.equal((await f.book()).trades[0].state, 'pending'); assert.equal(f.service.retryAuthorizations.size, 0);
});

test('new sign-in session can recover status but cannot authorize retry of a prior session transaction', async t => {
  const f = await fixture(t), trade = await f.prepare(); await f.service.submit(id, { tradeId: trade.id, confirm: true }, f.context);
  f.accounts.list = async () => [f.account]; f.chain.verifyBroadcastOperation = () => { throw Error('Must not verify or broadcast without original authorization'); };
  const restarted = new LaunchpadTrading({ ...f, now: () => f.now.value, random: () => 0 }); t.after(() => restarted.close()); await restarted.start();
  await restarted.status(id, { tradeId: trade.id }, { ...f.context, sessionToken: 'new-session' });
  f.now.value += 10000; await restarted.runReconciliation(); assert.equal(f.calls.broadcast, 1); assert.equal(restarted.retryAuthorizations.size, 0);
});

test('revocation during final moderation reads prevents the post-permit network send', async t => {
  const f = await fixture(t), trade = await f.prepare(); let checkingBroadcast = false, networkSends = 0;
  f.service.resolveCoin = async () => { if (checkingBroadcast) f.flags.active = false; return f.record; };
  f.chain.broadcast = async (_operation, options) => { checkingBroadcast = true; await options.authorize(); networkSends++; };
  const result = await f.service.submit(id, { tradeId: trade.id, confirm: true }, f.context);
  assert.equal(networkSends, 0); assert.equal(result.trade.state, 'pending'); assert.match(result.trade.error, /uncertain/);
});

test('positive batch observation is durable even if its archival receipt read fails', async t => {
  const f = await fixture(t), trade = await f.prepare(); await f.service.submit(id, { tradeId: trade.id, confirm: true }, f.context);
  f.chain.receiptBatch = async operations => operations.map(operation => {
    operation.observedSignatureStatus = { confirmationStatus: 'confirmed', slot: 321 };
    return { operation, receipt: null, error: Error('archival outage') };
  });
  await f.service.start(); t.after(() => f.service.close()); f.now.value += 1500; await f.service.runReconciliation();
  const saved = (await f.book()).trades[0]; assert.equal(saved.operation.observedSignatureStatus.slot, 321); assert.equal(saved.state, 'pending'); assert.equal(f.calls.broadcast, 1);
});

test('queued submissions preserve their own asynchronous request context', async t => {
  const f = await fixture(t), scope = new AsyncLocalStorage(), seen = []; let release, entered;
  const started = new Promise(resolve => entered = resolve);
  const first = scope.run({ label: 'first' }, () => f.service.sendSlot(async () => { seen.push(scope.getStore().label); entered(); await new Promise(resolve => release = resolve); }));
  await started;
  const second = scope.run({ label: 'second' }, () => f.service.sendSlot(() => seen.push(scope.getStore().label)));
  release(); await Promise.all([first, second]); assert.deepEqual(seen, ['first', 'second']);
});

test('preparation admission is bounded before signing and a busy valid review is retained', async t => {
  const f = await fixture(t), body = { ...f.input, mode: 'external', wallet: f.connected.address };
  const firstQuote = (await f.service.quote(id, body, f.context)).quote;
  const secondQuote = (await f.service.quote(otherId, body, f.context)).quote;
  f.service.capacities.maxQuoteJobs = 1;
  let release, entered; const started = new Promise(resolve => entered = resolve), original = f.chain.prepareTrade;
  f.chain.prepareTrade = async (...args) => { entered(); await new Promise(resolve => release = resolve); return original(...args); };
  const first = f.service.prepare(id, { quoteId: firstQuote.id, requestId: 'first-request-12345678' }, f.context);
  await started;
  await assert.rejects(f.service.prepare(otherId, { quoteId: secondQuote.id, requestId: 'second-request-12345678' }, f.context), error => error.statusCode === 503);
  assert(f.service.quotes.has(secondQuote.id)); assert.equal(f.calls.prepare, 0);
  release(); await first; f.chain.prepareTrade = original;
  assert.equal((await f.service.prepare(otherId, { quoteId: secondQuote.id, requestId: 'second-request-12345678' }, f.context)).trade.state, 'awaiting_signature');
  assert.equal(f.service.preparing, 0);
});

test('wallet-only trading requires the connected wallet and never reads a legacy main private key',async t=>{
  const f=await fixture(t);f.service.walletOnly=true;
  const store=f.accounts.storeFor(id),read=store.read.bind(store),original=await read('main-wallet');let keyReads=0;
  store.read=async(name,...args)=>{if(name==='main-wallet'){keyReads++;throw Error('managed key must not be read');}return read(name,...args);};
  await assert.rejects(f.service.wallet(id,f.input,f.context),e=>e.statusCode===403&&/Connect your wallet/.test(e.message));
  await assert.rejects(f.getQuote(),/Stored account wallets are disabled/);
  const trade=await f.prepare({mode:'external',wallet:f.connected.address});assert.equal(trade.state,'awaiting_signature');assert.equal(f.calls.options.external,true);assert.equal(f.calls.options.secret,undefined);assert.equal(keyReads,0);
  assert.deepEqual(await read('main-wallet'),original,'the legacy encrypted key remains recoverable');
});

test('wallet-only upgrade rejects a saved managed trade before broadcast but permits cancellation',async t=>{
  const f=await fixture(t),trade=await f.prepare();f.service.walletOnly=true;
  await assert.rejects(f.service.submit(id,{tradeId:trade.id,confirm:true},f.context),/Stored account wallets are disabled/);assert.equal(f.calls.broadcast,0);
  const cancelled=await f.service.cancel(id,{tradeId:trade.id},f.context);assert.equal(cancelled.trade.state,'cancelled');assert.equal(f.calls.prepare,1);
});

test('wallet-only upgrade still reconciles an already submitted managed trade without new spending authority',async t=>{
  const f=await fixture(t),trade=await f.prepare();await f.service.submit(id,{tradeId:trade.id,confirm:true},f.context);
  f.service.walletOnly=true;f.now.value+=4000;
  f.flags.receipts={slot:333,meta:{err:null},transaction:{signatures:['defaultSignature']}};
  const status=await f.service.submit(id,{tradeId:trade.id,confirm:true},f.context);assert.equal(status.trade.state,'confirmed');assert.equal(f.calls.broadcast,1);assert.equal(f.service.retryAuthorizations.size,0);
});


for(const side of ['buy','sell'])test(`API accepts exact custom ${side} slippage from zero through100 percent`,async t=>{
  const f=await fixture(t);
  for(const slippageBps of [0,1,2537,10000]){const q=await f.getQuote({side,slippageBps});assert.equal(q.slippageBps,slippageBps);assert.equal(q.side,side);}
  assert.equal(f.calls.prepare,0);assert.equal(f.calls.broadcast,0);
});
test('API rejects invalid slippage before consulting the trade chain',async t=>{
  const f=await fixture(t);f.chain.quote=()=>assert.fail('Invalid slippage must not reach a provider.');
  for(const slippageBps of [-1,10001,0.5,NaN,Infinity,'100',null])await assert.rejects(f.getQuote({slippageBps}),/Slippage must be between 0% and 100%/);
});

test('a full trade journal drops old finished trades instead of locking the account out of trading for good', async t => {
  const f = await fixture(t), DAY = 86_400_000;
  const old = (n, state) => ({ id: 'old-' + n, requestId: 'old-request-' + String(n).padStart(8, '0'), mint: f.input.mint, mode: 'default', wallet: f.main.address, state, quote: {}, createdAt: f.now.value - 3 * DAY, updatedAt: f.now.value - 3 * DAY + n, operation: { signature: 'sig-' + n }, error: '' });
  const states = ['confirmed', 'failed', 'cancelled', 'expired'];
  const trades = Array.from({ length: 4990 }, (_, n) => old(n, states[n % 4]));
  // Recent outcomes stay, whatever their age in the list.
  for (let n = 0; n < 10; n++) trades.push({ ...old(5000 + n, 'confirmed'), updatedAt: f.now.value - 1000 });
  await f.accounts.storeFor(id).write('launchpad-trades', { version: 1, trades });
  const trade = await f.prepare();
  assert.equal(trade.state, 'prepared');
  const saved = (await f.book()).trades;
  assert.equal(saved.length, 4001); assert.equal(saved.at(-1).id, trade.id);
  assert.equal(saved.filter(row => row.updatedAt === f.now.value - 1000).length, 10, 'recent outcomes are kept');
  assert.equal(saved[0].id, 'old-1000', 'the 1,000 oldest finished trades were dropped first');
  // Unfinished or recent trades are never dropped: a journal full of them still refuses (nothing is lost).
  await f.service.cancel(id, { tradeId: trade.id }, f.context);
  const recent = Array.from({ length: 5000 }, (_, n) => ({ ...old(n, 'confirmed'), updatedAt: f.now.value - 1000 }));
  await f.accounts.storeFor(id).write('launchpad-trades', { version: 1, trades: recent });
  await assert.rejects(f.prepare(), /journal is full/);
  assert.equal((await f.book()).trades.length, 5000);
});
