import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { MintLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PortfolioEngine } from '../src/portfolio.mjs';
import { portfolioConfig } from '../src/portfolio-plan.mjs';
import { strategyDefaults, resolvedStrategy } from '../public/strategy-settings.mjs';
import { SOL } from '../src/core.mjs';
import { key1, key2, mint, quote, config } from './fixtures.mjs';
const wallet = key1.publicKey.toBase58();
const prices = { [SOL]: 100000000000000n, [mint]: 1000000000000n, [quote]: 10000000000000n };
const decimals = { [SOL]: 9, [mint]: 6, [quote]: 8 };
const book = () => ({ data: { lots: [], pending: [], events: [], seen: [], trades: 0 }, async save() {}, addEvent(e) { this.data.events.push(e); } });
const plan = (id, baseMint, budgetSol, preset = 'balanced') => ({ id, label: id, wallet, strategy: { ...strategyDefaults(), baseMint, budgetSol, preset } });
function setup(t, balance = 4000000000n) {
  const ledgers = { live: book(), paper: book() }, discovered = [], reads = [];
  const adapter = { connection: { async getAccountInfo(key) {
    const data = Buffer.alloc(MintLayout.span);
    MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1000000000000n, decimals: decimals[key.toBase58()], isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
    return { owner: TOKEN_PROGRAM_ID, data };
  } }, async discover(s) { discovered.push(s.baseMint); return { venue: 'test', id: s.baseMint, mints: [s.baseMint, s.quoteMint] }; } };
  const e = new PortfolioEngine(ledgers, () => ({ async init() {}, async balance(w, m) { reads.push([w, m]); return balance; }, close() {} }), () => adapter);
  e.refreshPrices = async () => { e.prices = prices; e.pricesAt = Date.now(); };
  e.tick = async () => {};
  t.after(() => e.stop());
  return { e, discovered, reads, raw: () => config({ mode: 'live', liquidityPlans: [plan('position_one', mint, '1'), plan('position_two', quote, '2', 'conservative')] }) };
}
test('two LP positions use one funded wallet with independent budgets, pairs, pools and presets', async t => {
  const h = setup(t); await h.e.start(h.raw(), 'liquidity');
  const rows = h.e.ledger.data.lots;
  assert.equal(h.e.c.wallets.length, 1); assert.equal(h.e.c.wallets[0].budget, 3000000000n);
  assert.deepEqual(rows.map(r => r.wallet), [wallet, wallet]); assert.equal(new Set(rows.map(r => r.id)).size, 2);
  assert.deepEqual(rows.map(r => r.budget), ['1000000000', '2000000000']);
  assert.deepEqual(rows.map(r => r.pool.id), [mint, quote]);
  assert.deepEqual(rows.map(r => r.strategy.preset), ['balanced', 'conservative']);
  assert.deepEqual(h.discovered, [mint, quote]); assert.equal(h.reads.length, 1);
  const c = portfolioConfig({ ...h.raw(), wallets: config({ mode: 'live', wallets: [key1, key2] }).wallets }, 'liquidity');
  assert.equal(c.wallets.length, 1, 'an unused selected wallet has no allocation');
});
test('combined LP budgets cannot reuse a wallet balance, including existing stopped allocations', async t => {
  const h = setup(t, 2500000000n);
  await assert.rejects(h.e.start(h.raw(), 'liquidity'), /all allocations/);
  assert.equal(h.e.ledgers.live.data.lots.length, 0, 'no partial new allocation persists');
  const other = setup(t, 4000000000n);
  other.e.ledgers.live.data.lots.push({ id: 'old', kind: 'liquidity', wallet, baseMint: mint, quoteMint: SOL, budget: '2000000000', tokens: { [SOL]: '2000000000' } });
  await assert.rejects(other.e.start(other.raw(), 'liquidity'), /all allocations/);
  assert.equal(other.e.ledgers.live.data.lots.length, 1);
});
test('withdrawing a selected LP allocation does not withdraw another position in the same wallet', async t => {
  const h = setup(t); await h.e.start(h.raw(), 'liquidity');
  const [one, two] = h.e.ledger.data.lots; one.position = { id: mint }; two.position = { id: quote };
  h.e.activeIds = new Set([one.id]);
  await assert.rejects(h.e.withdraw(wallet), /specific LP position/);
  await assert.rejects(h.e.withdraw({ wallet: key2.publicKey.toBase58(), id: two.id }), /specific/);
  await h.e.withdraw({ wallet, id: two.id });
  assert.equal(one.exiting, undefined); assert.equal(two.exiting, 'withdraw'); assert(h.e.activeIds.has(two.id));
});
test('MM wallets share daily fee and turnover budgets with reservations before asynchronous balance checks', async t => {
  const h = setup(t), e = h.e;
  e.c = portfolioConfig(config({ mode: 'live', wallets: [key1, key2], strategy: { ...strategyDefaults(), baseMint: mint } }), 'market');
  e.kind = 'market'; e.ledger = e.ledgers.live; e.accepting = true; e.abort = new AbortController(); e.prices = prices; e.pricesAt = Date.now(); e.decimals = decimals;
  const rows = e.c.wallets.map((w, i) => ({ id: `row${i}`, wallet: w.publicKey, budget: '1000000000', fees: '0', turnover: '0', tokens: { [SOL]: '1000000000' }, day: e.day() }));
  e.ledger.data.lots.push(...rows); e.activeIds = new Set(rows.map(r => r.id));
  let unblock; const held = new Promise(resolve => { unblock = resolve; });
  e.p = { async balance() { await held; return 5000000000n; }, close() {} };
  const first = e.limits(rows[0], 300000000000000n);
  await assert.rejects(e.limits(rows[1], 200000000000000n), /turnover/);
  unblock(); await first; e.limitReservations.clear();
  rows[0].turnover = '0'; rows[1].fees = '39000000';
  await e.limits(rows[0], 0n, 100000n);
  await assert.rejects(e.limits(rows[0], 0n, 2000000n, false), /fee budget/);
  assert.equal(e.limitReservations.get(rows[0].id).fee, e.feeEstimate() + 100000n, 'rejected conversion cannot increase its reserved spend');
});
