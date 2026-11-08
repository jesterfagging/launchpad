import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, SystemProgram } from '@solana/web3.js';
import { MintLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { SOL, validateConfig } from '../src/core.mjs';
import { PortfolioEngine } from '../src/portfolio.mjs';
import { portfolioConfig, planInventory, netPlans, inventoryValue } from '../src/portfolio-plan.mjs';
import { profiles, resolvedStrategy } from '../public/strategy-settings.mjs';
import { createPreset, readPreset } from '../public/presets.mjs';
import { verifySignedTransaction } from '../src/providers.mjs';
import { key1, key2, mint, quote, blockhash, config, token } from './fixtures.mjs';
const prices = { [SOL]: 100000000000000n, [mint]: 1000000000000n, [quote]: 10000000000000n };
const decimals = { [SOL]: 9, [mint]: 6, [quote]: 8 };
const strategy = extra => resolvedStrategy({ baseMint: mint, quoteMint: SOL, budgetSol: '1', ...extra });
const record = extra => ({ id: 'allocation', kind: 'market', wallet: key1.publicKey.toBase58(), walletLabel: 'Wallet 1', baseMint: mint, quoteMint: SOL, budget: '1000000000',
  cashReserve: '300000000', tokens: { [SOL]: '1000000000' }, initialized: false, initialValue: '100000000000000', fees: '0', turnover: '0', failures: 0, day: new Date().toISOString().slice(0, 10), ...extra });
const ledger = () => ({ data: { version: 1, lots: [], pending: [], seen: [], events: [], trades: 0 }, save: async () => {}, addEvent(e) { this.data.events.unshift(e); } });
function instance() {
  const ledgers = { paper: ledger(), live: ledger() }, engine = new PortfolioEngine(ledgers);
  engine.c = portfolioConfig(config({ mode: 'live', strategy: strategy() }), 'market'); engine.ledger = ledgers.live; engine.decimals = decimals; engine.prices = prices; engine.pricesAt = Date.now();
  engine.p = { unwatchSignature() {}, close() {} }; engine.abort = new AbortController(); return engine;
}
test('three automatic presets ignore stale advanced values unless enabled', () => {
  assert.equal(Object.keys(profiles).length, 3);
  assert.equal(strategy({ tuning: { tradePercent: 20 } }).limits.tradePercent, 10);
  assert.equal(strategy({ advanced: true, tuning: { tradePercent: 20 } }).limits.tradePercent, 20);
  assert.throws(() => strategy({ advanced: true, tuning: { tradePercent: 200 } }), /tradePercent/);
});
test('5 wallets with distinct budgets; copytrading still requires a lead', () => {
  const wallets = Array.from({ length: 5 }, () => Keypair.generate());
  const c = portfolioConfig(config({ leads: [], wallets, strategy: strategy({ budgetSol: '10', walletBudgets: { 0: '1' } }) }), 'market');
  assert.equal(c.wallets.length, 5); assert.equal(c.wallets[0].budget, 1000000000n); assert.equal(c.wallets[4].budget, 10000000000n);
  assert.throws(() => portfolioConfig(config({ wallets: [...wallets, key1], strategy: strategy() }), 'market'), /5/);
  assert.throws(() => validateConfig(config({ leads: [] })), /lead/);
});
test('preset round trip preserves keys and strategy overrides without changing copy fields', () => {
  const c = config({ mode: 'live' }); c.leads = c.leads.join('\n'); c.strategies = { market: strategy({ advanced: true, walletBudgets: { 0: '.5' }, tuning: { cooldownSeconds: 180 } }), liquidity: strategy() };
  const restored = readPreset(JSON.stringify(createPreset(c)));
  assert.equal(restored.wallets[0].privateKey, c.wallets[0].privateKey);
  assert.equal(restored.strategies.market.walletBudgets[0], '.5'); assert.equal(restored.buyAmount, '.05'.replace('.', '0.'));
  assert.equal(restored.strategies.market.tuning.cooldownSeconds, 180);
});
test('initial allocation retains the undeployed SOL and custom quotes are funded first', () => {
  const p = planInventory(record(), strategy(), prices, decimals); assert.equal(p.amount, 350000000n); assert.equal(p.outputMint, mint);
  const q = planInventory(record({ quoteMint: quote }), strategy({ quoteMint: quote }), prices, decimals); assert.equal(q.amount, 700000000n); assert.equal(q.outputMint, quote); assert.equal(q.funding, true);
});
test('balanced holdings do nothing; drift is bounded; cooldown and reversal guard stop churn', () => {
  const r = record({ initialized: true, tokens: { [SOL]: '650000000', [mint]: '35000000' } });
  assert.equal(planInventory(r, strategy(), prices, decimals), null);
  const high = { ...prices, [mint]: prices[mint] * 2n }, p = planInventory(r, strategy(), high, decimals);
  assert.equal(p.direction, 'sell'); assert.ok(p.amount <= 5250000n);
  assert.equal(planInventory({ ...r, lastTradeAt: Date.now() }, strategy(), high, decimals), null);
  assert.equal(planInventory({ ...r, lastDirection: 'buy', lastRatio: String(high[mint] * 1000000000n / prices[SOL]) }, strategy(), high, decimals), null);
});
test('opposite wallet imbalances are netted without creating equal buy/sell volume', () => {
  const plans = [{ order: { inputMint: SOL, outputMint: mint, amount: 100000000n } }, { order: { inputMint: mint, outputMint: SOL, amount: 10000000n } }];
  assert.equal(netPlans(plans, mint, prices, decimals).length, 0);
});
test('confirmed swaps debit actual native costs and only credit the observed tokens', async () => {
  const e = instance(), r = record(); e.ledger.data.lots.push(r);
  const p = { wallet: r.wallet, signature: 'test-signature', order: { kind: 'rebalance', recordId: r.id, inputMint: SOL, outputMint: mint, amount: '350000000', minOutput: '34000000', turnover: '350000000', relayFees: '1000' } };
  e.ledger.data.pending.push(p);
  await e.reconcileTransaction(p, { transaction: { message: { accountKeys: [{ pubkey: r.wallet }] } }, meta: { err: null, fee: 5000, preBalances: [2000000000], postBalances: [1649994000], preTokenBalances: [], postTokenBalances: [token(r.wallet, mint, 34500000, 6, 1)] } });
  assert.equal(r.tokens[SOL], '649994000'); assert.equal(r.tokens[mint], '34500000'); assert.equal(r.fees, '6000'); assert.equal(e.ledger.data.pending.length, 0);
  const snapshot = JSON.stringify(r); await e.applyDeltas(p, { [SOL]: -100n }, 1n); assert.equal(JSON.stringify(r), snapshot);
});
test('a receipt that overdrafts an allocation remains pending and does not partly mutate it', async () => {
  const e = instance(), r = record(), p = { wallet: r.wallet, signature: 'pending', order: { kind: 'rebalance', recordId: r.id } }; e.ledger.data.lots.push(r); e.ledger.data.pending.push(p);
  await assert.rejects(e.applyDeltas(p, { [mint]: 10n, [SOL]: -1000000001n }, 1n), /allocated funds/);
  assert.deepEqual(r.tokens, { [SOL]: '1000000000' }); assert.equal(e.ledger.data.pending.length, 1);
});
test('resuming an allocation does not reset daily turnover; loss stops new operations', async () => {
  const e = instance(), r = record({ initialized: true, tokens: { [SOL]: '300000000' } }); e.ledger.data.lots.push(r); e.accepting = true;
  e.refreshPrices = async () => {}; await e.tick(); assert.match(r.paused, /loss limit/); assert.equal(e.queues.size, 0);
  r.tokens[SOL] = r.budget; r.turnover = '2000000000';
  await assert.rejects(e.limits(r, 1n * prices[SOL]), /turnover/);
});
test('additional LP signers are accepted only when explicitly known and every signature verifies', () => {
  const payer = key1.publicKey, extra = key2;
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: extra.publicKey, lamports: 1, space: 0, programId: SystemProgram.programId })] }).compileToV0Message());
  tx.sign([key1, extra]); assert.throws(() => verifySignedTransaction(tx.serialize(), payer.toBase58()), /verification/);
  assert.ok(verifySignedTransaction(tx.serialize(), payer.toBase58(), [extra.publicKey.toBase58()]).signature);
  tx.signatures[1][0] ^= 1; assert.throws(() => verifySignedTransaction(tx.serialize(), payer.toBase58(), [extra.publicKey.toBase58()]), /verification/);
});
test('Stop can cancel RPC startup and a later run can start without reusing keys', async () => {
  let wait, started; const gate = new Promise(r => started = r);
  const e = new PortfolioEngine({ live: ledger(), paper: ledger() }, () => ({ init: async signal => { started(); await new Promise((_, reject) => { wait = () => reject(Error('Stopped.')); signal.addEventListener('abort', wait, { once: true }); }); }, close() {} }));
  const starting = e.start(config({ strategy: strategy() }), 'market'); await gate; assert.equal(e.state, 'starting'); e.stop(); await assert.rejects(starting, /Stopped/); assert.equal(e.state, 'stopped'); assert.equal(e.accepting, false);
});
test('unresolved journals and LP positions cannot be released', async () => {
  const e = instance(), r = record({ position: { id: mint } }); e.ledger.data.lots.push(r);
  await assert.rejects(e.release(r.id), /Withdraw/); r.position = null; e.ledger.data.pending.push({ signature: 'x' }); await assert.rejects(e.release(r.id), /reconcile/);
  e.ledger.data.pending = []; await e.release(r.id); assert.equal(e.ledger.data.lots.length, 0);
});
test('failed on-chain fees are reconciled once, and cannot disappear on restart', async () => {
  const e = instance(), r = record(), p = { wallet: r.wallet, signature: 'failed', order: { kind: 'rebalance', recordId: r.id } }; e.ledger.data.lots.push(r); e.ledger.data.pending.push(p);
  await e.failOnChain(p, { InstructionError: [1, 'Failed'] }, { meta: { fee: 5000 } });
  assert.equal(r.tokens[SOL], '999995000'); assert.equal(r.fees, '5000'); assert.equal(e.ledger.data.pending.length, 0); assert.ok(r.paused);
  await e.failOnChain(p, {}, { meta: { fee: 5000 } }); assert.equal(r.fees, '5000');
});
test('native SOL can be on either side while its cash reserve remains excluded', () => {
  const p = planInventory(record({ baseMint: SOL, quoteMint: quote }), strategy({ baseMint: SOL, quoteMint: quote }), prices, decimals);
  assert.equal(p.inputMint, SOL); assert.equal(p.outputMint, quote); assert.equal(p.amount, 350000000n);
});
test('stopped status can show persisted live allocations without starting a run', () => {
  const e = instance(); e.ledgers.live.data.lots.push(record()); e.c = null;
  assert.equal(e.status('live').positions.length, 1); assert.equal(e.status('paper').positions.length, 0); assert.equal(e.accepting, false);
});
test('an explicit withdrawal proceeds even when price service is unavailable', async () => {
  const e = instance(), r = record({ position: { id: mint }, exiting: 'withdraw' }); e.ledger.data.lots.push(r); e.accepting = true; e.withdrawOnly = true;
  e.refreshPrices = async () => { throw Error('Prices unavailable'); }; let called = false;
  e.executeLiquidity = async (_r, _w, withdraw) => { called = withdraw; };
  await e.tick(); await Promise.allSettled([...e.queues.values()]); assert.equal(called, true);
});
