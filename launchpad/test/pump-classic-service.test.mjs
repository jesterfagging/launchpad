// Pump.fun Classic service lifecycle against a scripted chain: quotes, funding,
// atomic creation, refunds, the receipt journal (including other callers'
// distributions), routing, Launchpad-run holder rewards and the managed strategies.
// The fake chain returns exactly what the real adapter returns after its own
// simulation checks; these tests cover the service's journaling, idempotency,
// recovery and accounting. Dependency-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { PumpClassicService, generateWallet, lamportsFromSol } from '../src/pump-classic/service.mjs';
import { base58Encode } from '../src/pump-classic/codec.mjs';
import { coinAddresses } from '../src/pump-classic/instructions.mjs';
import { PUMP_CLASSIC_POLICY_V1, PUMP_CLASSIC_POLICY, PUMP_CLASSIC_POLICY_HASH } from '../src/pump-classic/policy.mjs';
import { lpPlan } from '../src/pump-classic/strategy.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const signature = () => base58Encode(randomBytes(64));
function signedOp(fields) { const raw = Buffer.from(randomBytes(200)).toString('base64'); return { signature: signature(), raw, rawHash: sha(Buffer.from(raw, 'base64')), blockhash: base58Encode(randomBytes(32)), lastValidBlockHeight: 5000, preparedSlot: 100, createdAt: Date.now(), ...fields }; }

class World {
  constructor() { this.slot = 1000; this.calls = []; this.broadcasts = []; this.receipts = new Map(); this.deposits = new Map(); this.status = new Map(); this.coins = new Map(); this.history = new Map(); this.distributions = new Map(); this.lamports = new Map(); this.setupOk = true; this.tokensPerLamport = 30000n; }
}
class FakeChain {
  constructor(world) { this.w = world; }
  log(name, value) { this.w.calls.push(name); return value; }
  async quoteLaunch({ devBuyLamports }) { const t = BigInt(devBuyLamports) * this.w.tokensPerLamport; return this.log('quoteLaunch', { tokens: t, costLamports: BigInt(devBuyLamports), maxSolCost: BigInt(devBuyLamports), feeBps: 125n, slot: 10 }); }
  async prepareDeposit({ sender, recipient, lamports, memo }) { const unsignedRaw = Buffer.from(`unsigned:${sender}:${recipient}:${lamports}:${memo}:${randomBytes(4).toString('hex')}`).toString('base64'); return this.log('prepareDeposit', { kind: 'deposit', needsSignature: true, state: 'awaiting_signature', externalSigner: sender, recipient, inputAmount: String(lamports), memo, unsignedRaw, messageHash: sha(unsignedRaw), blockhash: base58Encode(randomBytes(32)), lastValidBlockHeight: 5000, preparedSlot: 100, createdAt: Date.now() }); }
  async prepareSolDeposit(args) { return this.prepareDeposit(args); }
  async priorityPrice() { return 100000; }
  async acceptSigned(op, signed) { if (signed !== 'signed-by-wallet') throw Object.assign(Error('The wallet changed the reviewed transaction.'), { code: 'WALLET_TRANSACTION_REJECTED' }); const raw = Buffer.from('signed:' + op.unsignedRaw).toString('base64'); const { unsignedRaw, messageHash, ...rest } = op; return { ...rest, needsSignature: false, state: 'pending', signature: signature(), raw }; }
  async broadcastSaved(op) { this.w.broadcasts.push(op.signature); }
  async broadcast(op) { this.w.broadcasts.push(op.signature); }
  async savedState(op) { return this.w.status.get(op.signature) || { state: 'pending' }; }
  async state(op) { return this.savedState(op); }
  async depositReceipt({ signature: sig }) { return this.w.deposits.get(sig) ?? null; }
  async prepareLaunch({ plan, signers }) {
    assert.equal(signers.launch.address, plan.launchWallet); assert.equal(signers.mint.address, plan.mint);
    if (this.w.failPrepare) { const e = this.w.failPrepare; this.w.failPrepare = null; throw e; }
    return this.log('prepareLaunch', signedOp({ kind: 'launch', version: 1, wallet: plan.launchWallet, mint: plan.mint, expected: { tokens: String(plan.tokens), transfers: plan.transfers, shareholders: plan.shareholders } }));
  }
  async launchReceipt(op) { return this.w.receipts.get(op.signature) ?? null; }
  async verifyCoinSetup(plan) { return { ok: this.w.setupOk, coin: this.w.coins.get(plan.mint) || null }; }
  async readCoin(mint) { return this.w.coins.get(mint) || { exists: false }; }
  async prepareDrain({ wallet, recipient, keepLamports = 0n, minContextSlot = 0 }) { const balance = this.w.lamports.get(wallet.address) ?? 0n, keep = BigInt(keepLamports); this.w.drain = { wallet: wallet.address, keep, minContextSlot }; if (balance - keep <= 5000n) throw Object.assign(Error('Nothing is left to refund after the network fee.'), { code: 'PUMP_CLASSIC_EMPTY' }); return this.log('prepareDrain', signedOp({ kind: 'withdraw', mint: 'So11111111111111111111111111111111111111112', wallet: wallet.address, recipient, inputAmount: String(balance - 5000n - keep), accounting: { minSolReserve: String(keep) } })); }
  async receipt(op) { return this.w.receipts.get(op.signature) ?? null; }
  async prepareDistribution({ wallet, mint, shareholders, includeAmm }) { return this.log('prepareDistribution', signedOp({ kind: 'distribute', wallet: wallet.address, mint, expected: { includeAmm, shareholders } })); }
  async distributionReceipt(sig) { return this.w.distributions.get(sig) ?? { signature: sig, slot: 1, blockTime: 1, failed: false, payer: 'x', feeLamports: 5000n, legs: [], anomalies: [] }; }
  async signaturesFor(address, { until }) { const all = this.w.history.get(address) || []; const start = until ? all.findIndex(r => r.signature === until) + 1 : 0; return { rows: all.slice(start), complete: true }; }
  async walletBalances(addresses) { return { slot: 1, balances: Object.fromEntries(addresses.map(a => [a, this.w.lamports.get(a) ?? 0n])) }; }
  async prepareWithdrawal({ wallet, amount, recipient }) { return this.log('prepareWithdrawal', signedOp({ kind: 'withdraw', mint: 'So11111111111111111111111111111111111111112', wallet: wallet.address, recipient, inputAmount: String(amount), accounting: { minSolReserve: '0' } })); }
  async holderBalances() { return { slot: ++this.w.slot, at: this.w.clock(), rows: this.w.holders || [], complete: true }; }
  async prepareAirdrop({ wallet, payouts }) { return this.log('prepareAirdrop', signedOp({ kind: 'airdrop', wallet: wallet.address, inputAmount: payouts.reduce((s, p) => s + BigInt(p.lamports), 0n).toString(), payouts })); }
  async readGlobals() { return { slot: 1, global: {}, feeConfig: null, ammGlobalConfig: { lp_fee_basis_points: 20n, protocol_fee_basis_points: 5n, coin_creator_fee_basis_points: 5n, buyback_basis_points: 0n }, ammFeeConfig: null }; }
  async quoteUsd() { this.w.priceReads = (this.w.priceReads || 0) + 1; if (this.w.priceDown) throw Object.assign(Error('A fresh SOL/USD reference is unavailable.'), { code: 'PUMP_CLASSIC_PRICE' }); return { usd: this.w.solUsd ?? 150, at: this.w.clock() }; }
  async prepareCurveTrade(req) { return this.log('prepareCurveTrade:' + req.side, signedOp({ kind: 'trade', venue: 'curve', side: req.side, wallet: req.wallet.address, mint: req.mint, inputAmount: String(req.amount), minimumOutput: '1', expected: {} })); }
  async prepareAmmTrade(req) { return this.log('prepareAmmTrade:' + req.side, signedOp({ kind: 'trade', venue: 'amm', side: req.side, wallet: req.wallet.address, mint: req.mint, inputAmount: String(req.amount), minimumOutput: '1', expected: {} })); }
  async tradeReceipt(op) { return this.w.receipts.get(op.signature) ?? null; }
  async prepareLpDeposit(req) { return this.log('prepareLpDeposit', signedOp({ kind: 'lp-deposit', wallet: req.wallet.address, mint: req.mint, expected: { maxBase: String(req.maxBase), maxQuote: String(req.maxQuote) } })); }
  async prepareLpWithdraw(req) { return this.log('prepareLpWithdraw', signedOp({ kind: 'lp-withdraw', wallet: req.wallet.address, mint: req.mint, expected: {} })); }
  async liquidityReceipt(op) { return this.w.receipts.get(op.signature) ?? null; }
  async marketSnapshot(mint) { this.w.marketReads = (this.w.marketReads || 0) + 1; return { mint, curve: 'curve-of-' + mint, status: 'curve', slot: 90, at: this.w.clock(), supply: 1e9, priceQuote: 0.000000028, quote: { mint: 'So11111111111111111111111111111111111111112', usd: 150, at: this.w.clock(), stale: false } }; }
  async recentTrades(mint) { this.w.tradeReads = (this.w.tradeReads || 0) + 1; return [{ venue: 'curve', side: 'buy', wallet: generateWallet().address, tokens: 8000000000000n, lamports: 250000000n, time: 1790000000, signature: '9'.repeat(88) }, { venue: 'curve', side: 'sell', wallet: generateWallet().address, tokens: 1n, lamports: 1n, time: null, signature: '8'.repeat(88) }]; }
  async close() {}
}
function harness({ clockStart = Date.UTC(2026, 9, 2, 12) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pump-classic-')), docs = new Map(), world = new World();
  let clock = clockStart; world.clock = () => clock;
  const accounts = { dir, hostStore: { async read(name, fallback) { return docs.has(name) ? structuredClone(docs.get(name)) : fallback; }, async write(name, value) { docs.set(name, structuredClone(value)); } }, async get(id) { return id === 'admin' ? { id, role: 'admin', mfaEnabled: true, username: 'owner' } : null; }, async list() { return [{ id: 'acct-1', username: 'scout-creator' }, { id: 'admin', username: 'owner' }]; } };
  const metadata = [];
  const service = new PumpClassicService({ accounts, chainFactory: async () => new FakeChain(world), publishMetadata: async args => { metadata.push(args); return `https://launch.example/token-metadata/${args.mint}.json`; }, gotchiTarget: async id => ({ id, theme: id, vault: generateWallet().address }), agentTarget: async () => null, protocolRecipient: async () => world.treasury || null, config: { enabled: true, dbPath: join(dir, 'pc.sqlite'), backupDir: join(dir, 'backups') }, now: () => clock });
  const dev = generateWallet().address, session = { account: { id: 'acct-1', mainWallet: dev }, walletVerified: true, walletAddress: dev };
  return { service, world, docs, dir, metadata, dev, session, advance: ms => { clock += ms; }, now: () => clock, cleanup: async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const body = (overrides = {}) => ({ requestKey: randomBytes(12).toString('hex'), mode: 'holders', name: 'Scout Signal', symbol: 'scout', description: 'A test coin', image: '/token-images/' + 'a'.repeat(64) + '.png', devBuySol: '1', ...overrides });
async function openIntake(h, flags = { intake: true }) { await h.service.ensure(); for (const [k, v] of Object.entries(flags)) h.service.store().setFlag(k, v, { reason: 'test' }); }
async function pass(h, times = 1) { for (let i = 0; i < times; i++) { await h.service.process(); h.advance(11000); } }

async function fundAndCreate(h, quoteBody = body()) {
  const quote = await h.service.quote(h.session, { ...quoteBody, wallet: h.dev });
  const prepared = await h.service.prepareFunding(h.session, { launchId: quote.id });
  await h.service.submitFunding(h.session, { launchId: quote.id, operationId: prepared.operationId, signedTransaction: 'signed-by-wallet' });
  const store = h.service.store(), fundingOp = store.operationsFor(quote.id, 'funding').find(op => op.state === 'submitted');
  h.world.deposits.set(fundingOp.signature, { state: 'finalized', signature: fundingOp.signature, slot: 50, receivedAmount: prepared.amountLamports });
  await pass(h); // funded → creating (journaled + broadcast)
  const launchOp = store.operationsFor(quote.id, 'launch').at(-1);
  assert.equal(launchOp.state, 'submitted'); assert.ok(launchOp.raw, 'signed bytes journaled before broadcast');
  h.world.receipts.set(launchOp.signature, { state: 'confirmed', signature: launchOp.signature, slot: 60, tokens: launchOp.expected.op.expected.tokens, feeLamports: 24000n, failed: false });
  const launch = store.launch(quote.id);
  h.world.lamports.set(launch.launch_wallet, 30000000n);
  for (const t of launch.plan.transfers) h.world.lamports.set(t.to, BigInt(t.lamports));
  h.world.coins.set(launch.mint, { exists: true, slot: 70, venue: 'curve', curve: { complete: false, virtual_quote_reserves: 30000000000n, virtual_token_reserves: 1073000000000000n, real_token_reserves: 793100000000000n, token_total_supply: 1000000000000000n }, mint: { supply: 1000000000000000n }, fees: { curve: 0n, amm: 0n, total: 0n }, poolBase: 0n, poolQuote: 0n });
  await pass(h, 2);
  return store.launch(quote.id);
}

test('quote validation, idempotency and server-side option gating', async () => {
  const h = harness();
  try {
    await assert.rejects(h.service.quote(h.session, { ...body(), wallet: h.dev }), /paused/);
    await openIntake(h);
    const b = body({ mode: 'market_maker', seedSol: '2' });
    const first = await h.service.quote(h.session, { ...b, wallet: h.dev }), again = await h.service.quote(h.session, { ...b, wallet: h.dev });
    assert.equal(first.id, again.id, 'the same request key returns the same launch');
    assert.equal(first.state, 'awaiting_funding'); assert.equal(first.symbol, 'SCOUT'); assert.equal(first.quote.seedSol, '2');
    // Policy v3: a 0.02 SOL setup budget, 0.002 SOL for the platform receipt wallet and 0.01 SOL for the strategy wallet.
    assert.equal(first.quote.totalLamports, (lamportsFromSol('1') + 20000000n + 2000000n + 10000000n + lamportsFromSol('2')).toString());
    assert.deepEqual([first.quote.setupBudgetSol, first.quote.estimatedSetupSol, first.quote.devBuyPaidIn], ['0.02', '0.014', 'SOL'], 'the review shows the budget and the expected cost');
    assert.ok(!JSON.stringify(first).includes('secret'), 'views never include key material');
    const keys = h.docs.get('pump-classic-keys-' + first.id);
    assert.ok(keys.launch.secret && keys.mint.secret && keys.protocol.secret && keys.mode_wallet.secret, 'all per-coin keys are stored before funding');
    const row = h.service.store().launch(first.id);
    assert.notEqual(row.mode_wallet, row.launch_wallet, 'the market-making wallet is never the deploying wallet');
    assert.deepEqual(row.plan.shareholders.map(s => s.address), [row.protocol_wallet, row.mode_wallet]);
    assert.equal(h.metadata[0].mint, row.mint);
    await assert.rejects(h.service.quote(h.session, { ...body({ mode: 'holders', seedSol: '1' }), wallet: h.dev }), /Seed capital is only available/);
    await assert.rejects(h.service.quote(h.session, { ...body({ mode: 'buyback' }), wallet: h.dev }), /Choose Creator/);
    await assert.rejects(h.service.quote(h.session, { ...body({ devBuySol: '25.000000001' }), wallet: h.dev }), /dev buy exceeds/);
    await assert.rejects(h.service.quote(h.session, { ...body({ devBuySol: '1.0000000001' }), wallet: h.dev }), /up to 9 decimals/);
    await assert.rejects(h.service.quote(h.session, { ...body(), wallet: generateWallet().address }), /wallet you signed in with/);
    await assert.rejects(h.service.quote(h.session, { ...body({ image: 'https://evil.example/x.png' }), wallet: h.dev }), /Upload a coin image/);
    await assert.rejects(h.service.quote(h.session, { ...body({ name: 'x'.repeat(33) }), wallet: h.dev }), /32 characters/);
    await assert.rejects(h.service.quote(h.session, { ...body({ mode: 'creator', agent: { mission: 'x' } }), wallet: h.dev }), /require the AI Agent/);
  } finally { await h.cleanup(); }
});

test('funding, atomic creation and refund of the unused remainder', async () => {
  const h = harness();
  try {
    await openIntake(h);
    const quote = await h.service.quote(h.session, { ...body({ mode: 'creator', devBuySol: '0.5' }), wallet: h.dev });
    const prepared = await h.service.prepareFunding(h.session, { launchId: quote.id });
    assert.equal(prepared.wallet, h.dev); assert.match(prepared.memo, /^pump-launch:[a-f0-9]{24}$/);
    await assert.rejects(h.service.submitFunding(h.session, { launchId: quote.id, operationId: prepared.operationId, signedTransaction: 'tampered' }), /changed the reviewed/);
    const submitted = await h.service.submitFunding(h.session, { launchId: quote.id, operationId: prepared.operationId, signedTransaction: 'signed-by-wallet' });
    assert.equal(submitted.state, 'funding_pending'); assert.equal(h.world.broadcasts.length, 1);
    await assert.rejects(h.service.cancel(h.session, { launchId: quote.id }), /Only an unfunded launch/);
    const store = h.service.store(), fundingOp = store.operationsFor(quote.id, 'funding').find(op => op.signature);
    await pass(h); assert.equal(store.launch(quote.id).state, 'funding_pending', 'no receipt yet: still pending, never assumed');
    h.world.deposits.set(fundingOp.signature, { state: 'finalized', signature: fundingOp.signature, slot: 50, receivedAmount: prepared.amountLamports });
    await pass(h);
    let launch = store.launch(quote.id); assert.equal(launch.state, 'creating');
    const op = store.operationsFor(quote.id, 'launch')[0]; assert.equal(op.expected.op.expected.tokens, (lamportsFromSol('0.5') * 30000n).toString());
    // Restart with a landed but unconfirmed transaction: it is never re-signed or duplicated.
    await pass(h, 3); assert.equal(store.operationsFor(quote.id, 'launch').length, 1); assert.ok(h.world.calls.filter(c => c === 'prepareLaunch').length === 1);
    h.world.receipts.set(op.signature, { state: 'confirmed', signature: op.signature, slot: 60, tokens: op.expected.op.expected.tokens, feeLamports: 24000n, failed: false });
    h.world.lamports.set(launch.launch_wallet, 31000000n);
    await pass(h);
    launch = store.launch(quote.id);
    assert.equal(launch.state, 'created'); assert.equal(launch.delivery_state, 'complete'); assert.equal(launch.dev_tokens, op.expected.op.expected.tokens);
    assert.equal(launch.refund_state, 'pending');
    const refund = store.operationsFor(quote.id, 'withdraw').find(o => o.expected.purpose === 'refund');
    assert.equal(refund.expected.op.recipient, h.dev); assert.equal(refund.expected.op.inputAmount, '30995000');
    h.world.receipts.set(refund.signature, { state: 'confirmed', signature: refund.signature, slot: 61, actualSolCostLamports: '5000' });
    await pass(h);
    launch = store.launch(quote.id);
    assert.equal(launch.refund_state, 'complete'); assert.equal(launch.refunded_lamports, '30995000');
    // Fee setup is verified by reading back the recipients after creation.
    await pass(h); assert.equal(store.launch(quote.id).fee_state, 'verified');
  } finally { await h.cleanup(); }
});

test('expired funding and creation are retried only after a proven expiry; failed creation refunds', async () => {
  const h = harness();
  try {
    await openIntake(h);
    const quote = await h.service.quote(h.session, { ...body({ mode: 'holders', devBuySol: '0' }), wallet: h.dev });
    const store = h.service.store();
    const prepared = await h.service.prepareFunding(h.session, { launchId: quote.id });
    await h.service.submitFunding(h.session, { launchId: quote.id, operationId: prepared.operationId, signedTransaction: 'signed-by-wallet' });
    const fundingOp = store.operationsFor(quote.id, 'funding').find(op => op.signature);
    h.world.status.set(fundingOp.signature, { state: 'expired', checkpoint: { slot: 900, height: 6000 } });
    await pass(h); assert.equal(store.launch(quote.id).state, 'funding_pending', 'one expired checkpoint is not proof');
    h.world.status.set(fundingOp.signature, { state: 'expired', checkpoint: { slot: 950, height: 6100 } });
    await pass(h); assert.equal(store.launch(quote.id).state, 'awaiting_funding', 'a second later checkpoint proves expiry; nothing was received');
    assert.equal(store.launch(quote.id).funding_signature, null);
    // Fund again; creation simulations then keep failing deterministically.
    const again = await h.service.prepareFunding(h.session, { launchId: quote.id });
    await h.service.submitFunding(h.session, { launchId: quote.id, operationId: again.operationId, signedTransaction: 'signed-by-wallet' });
    const second = store.operationsFor(quote.id, 'funding').filter(op => op.signature).at(-1);
    h.world.deposits.set(second.signature, { state: 'finalized', receivedAmount: again.amountLamports });
    h.world.lamports.set(store.launch(quote.id).launch_wallet, BigInt(again.amountLamports));
    for (let i = 0; i < 4 && store.launch(quote.id).state !== 'failed'; i++) { h.world.failPrepare = Object.assign(Error('Launch simulation failed: {"InstructionError":[2,{"Custom":6000}]}'), { code: 'PUMP_CLASSIC_SIMULATION' }); await pass(h); h.advance(3600000); }
    const launch = store.launch(quote.id);
    assert.equal(launch.state, 'failed'); assert.equal(launch.create_attempts, PUMP_CLASSIC_POLICY_V1.launch.maxCreateAttempts);
    assert.equal(store.operationsFor(quote.id, 'launch').length, 0, 'nothing was journaled or broadcast for a failed simulation');
    const refund = store.operationsFor(quote.id, 'withdraw').at(-1);
    assert.equal(refund.expected.op.inputAmount, (BigInt(again.amountLamports) - 5000n).toString(), 'the whole funding returns to the developer');
    h.world.receipts.set(refund.signature, { state: 'confirmed', actualSolCostLamports: '5000' });
    await pass(h); assert.equal(store.launch(quote.id).state, 'refunded');
  } finally { await h.cleanup(); }
});

test('the receipt journal records our and other callers’ distributions once; sweeps route only verified revenue', async () => {
  const h = harness();
  try {
    await openIntake(h, { intake: true, collection: true, routing: true });
    h.world.treasury = generateWallet().address;
    const launch = await fundAndCreate(h, body({ mode: 'gotchi', gotchiId: 'fomogotchi', devBuySol: '0.2' }));
    const store = h.service.store();
    assert.equal(launch.fee_state, 'verified');
    const legs = (amount, payer) => ({ slot: 80, blockTime: 1, failed: false, payer, feeLamports: 5000n, anomalies: [], legs: [{ eventIndex: 0, recipient: launch.protocol_wallet, amount: amount / 10n, distributed: amount, shareBps: 1000 }, { eventIndex: 0, recipient: launch.mode_wallet, amount: amount * 9n / 10n, distributed: amount, shareBps: 9000 }] });
    const external = signature(), ours = signature(), unrelated = signature();
    h.world.history.set(launch.protocol_wallet, [{ signature: external, slot: 80, failed: false }, { signature: unrelated, slot: 81, failed: false }, { signature: ours, slot: 82, failed: false }]);
    h.world.distributions.set(external, { signature: external, ...legs(300000000n, generateWallet().address) });
    h.world.distributions.set(ours, { signature: ours, ...legs(100000000n, launch.protocol_wallet) });
    h.advance(60000); await pass(h);
    assert.deepEqual(store.feeTotals(launch.id), { protocol: '40000000', gotchi: '360000000' });
    h.advance(60000); await pass(h); assert.deepEqual(store.feeTotals(launch.id), { protocol: '40000000', gotchi: '360000000' }, 'a rescan never double counts');
    assert.ok(store.feeReceipts(launch.id).some(r => r.signature === external && r.ours === 0));
    // Routing: the platform share sweeps to the treasury; the Gotchi share sweeps to its vault.
    h.world.lamports.set(launch.protocol_wallet, 45000000n); h.world.lamports.set(launch.mode_wallet, 363010000n + 5000000n);
    h.advance(60000); await pass(h);
    const sweeps = store.sweeps({ launchId: launch.id });
    assert.equal(sweeps.length, 1); assert.equal(sweeps[0].kind, 'protocol'); assert.equal(sweeps[0].to_wallet, h.world.treasury);
    assert.equal(BigInt(sweeps[0].amount), 45000000n - 5000000n - 10000n, 'never more than receipt-backed revenue, and the gas float stays in the wallet');
    const sweepOp = store.operationsFor(launch.id, 'withdraw').find(o => o.expected.purpose === 'sweep');
    h.world.receipts.set(sweepOp.signature, { state: 'confirmed', slot: 90, actualSolCostLamports: '5000' });
    h.advance(60000); await pass(h);
    assert.equal(store.sweeps({ launchId: launch.id, kind: 'protocol' })[0].state, 'confirmed');
    const treasurySources = await h.service.treasurySources();
    assert.deepEqual(treasurySources.map(s => [s.kind, s.wallet, s.sourceWallet, s.amount]), [['pump-classic-protocol', h.world.treasury, launch.protocol_wallet, '39990000']]);
    h.advance(60000); await pass(h);
    const gotchiSweep = store.sweeps({ launchId: launch.id, kind: 'gotchi' })[0];
    assert.equal(gotchiSweep.to_wallet, launch.gotchi.vault); assert.equal(BigInt(gotchiSweep.amount), 360000000n);
    h.world.receipts.set(store.operationsFor(launch.id, 'withdraw').at(-1).signature, { state: 'confirmed', slot: 91, actualSolCostLamports: '5000' });
    h.advance(60000); await pass(h);
    const sources = await h.service.gotchiSources();
    assert.equal(sources.length, 1); assert.equal(sources[0].gotchiId, 'fomogotchi'); assert.equal(sources[0].sourceWallet, launch.mode_wallet);
    const rows = await h.service.gotchiLaunches(); assert.equal(rows[0].venue, 'pump'); assert.equal(rows[0].contributedRaw, '360000000');
    // Collection prepares a crank only when the pending fees cover it.
    h.world.coins.get(launch.mint).fees = { curve: 50000000n, amm: 0n, total: 50000000n };
    h.advance(PUMP_CLASSIC_POLICY_V1.collection.intervalMs); await pass(h);
    assert.ok(h.world.calls.includes('prepareDistribution'));
  } finally { await h.cleanup(); }
});

test('SOL holder rewards pay out once the holders’ share is worth $100: fees are collected first, then the top holders are paid in batches', async () => {
  const h = harness();
  try {
    // v71.24: creator-fee collection and holder payouts run by default; only new launches need switching on.
    await openIntake(h, { intake: true });
    const holders = Array.from({ length: 6 }, (_, i) => ({ owner: generateWallet().address, amount: String(1000000000n * BigInt(i + 1)) }));
    h.world.holders = holders;
    const launch = await fundAndCreate(h, body({ mode: 'holders', devBuySol: '0' }));
    const store = h.service.store();
    h.world.holders = [...holders, { owner: launch.protocol_wallet, amount: '999999999999' }];
    // 0.5 SOL of collected rewards is about $75 at $150: below the $100 trigger, nothing is paid however long it waits.
    store.recordFeeReceipt({ launchId: launch.id, mint: launch.mint, signature: signature(), eventIndex: 0, recipient: launch.mode_wallet, role: 'rewards', amount: 500000000n, distributed: 555555555n, slot: 1 });
    for (let i = 0; i < 14; i++) { await h.service.process(); h.advance(5 * 60000); }
    assert.equal(store.rewardCycles(launch.id, 5).length, 0, 'about $75 waits');
    assert.equal(h.service.payoutRequest(store.launch(launch.id)), null);
    assert.ok(h.world.priceReads > 0, 'the trigger is priced in USD');
    // 0.4 SOL more is pending at Pump.fun; the holders' 90% of it lifts their share past $100, so a payout starts by collecting it.
    const coin = h.world.coins.get(launch.mint); coin.fees = { curve: 400000000n, amm: 0n, total: 400000000n };
    const cranks = () => store.operationsFor(launch.id, 'distribute');
    for (let i = 0; i < 3 && !cranks().length; i++) { await h.service.process(); h.advance(5 * 60000); }
    assert.equal(cranks().length, 1, 'the payout collects the pending fees first');
    const request = h.service.payoutRequest(store.launch(launch.id));
    assert.equal(request.source, 'auto'); assert.equal(request.stage, 'collect'); assert.ok(request.valueUsd >= 100);
    const crank = cranks()[0];
    h.world.distributions.set(crank.signature, { signature: crank.signature, slot: 90, blockTime: 1, failed: false, payer: launch.protocol_wallet, feeLamports: 5000n, anomalies: [], legs: [{ eventIndex: 0, recipient: launch.protocol_wallet, amount: 40000000n, distributed: 400000000n, shareBps: 1000 }, { eventIndex: 0, recipient: launch.mode_wallet, amount: 360000000n, distributed: 400000000n, shareBps: 9000 }] });
    h.world.history.set(launch.protocol_wallet, [{ signature: crank.signature, slot: 90, failed: false }]);
    coin.fees = { curve: 0n, amm: 0n, total: 0n };
    for (let i = 0; i < 8 && !store.rewardCycles(launch.id, 5).length; i++) await pass(h);
    const cycle = store.rewardCycles(launch.id, 5)[0];
    assert.ok(cycle, 'a cycle froze once the collected fees were recorded');
    assert.equal(BigInt(cycle.amount), 500000000n + 360000000n - 2500000n, 'everything collected, less half the wallet’s operating reserve');
    assert.ok(!cycle.payouts.some(p => p.owner === launch.protocol_wallet), 'Launchpad wallets never receive holder rewards');
    assert.equal(cycle.payouts.length, 6); assert.ok(cycle.payouts.every(p => !p.tokens), 'a SOL coin pays SOL');
    await pass(h);
    const ops = () => store.operationsFor(launch.id, 'airdrop');
    assert.equal(ops().length, 1); assert.equal(ops()[0].expected.op.payouts.length, 4, 'payouts go out four at a time');
    h.world.receipts.set(ops()[0].signature, { state: 'confirmed', actualSolCostLamports: '6000' });
    await pass(h); await pass(h);
    assert.equal(ops().length, 2);
    h.world.receipts.set(ops()[1].signature, { state: 'confirmed', actualSolCostLamports: '6000' });
    await pass(h);
    const done = store.rewardCycles(launch.id, 5)[0];
    assert.equal(done.state, 'complete'); assert.equal(done.paid, done.amount);
    assert.equal(store.balance(launch.id, 'rewards').debited, BigInt(done.amount));
    assert.equal(h.service.payoutRequest(store.launch(launch.id)), null, 'the payout closed');
    const view = await h.service.coinView(launch.mint);
    assert.deepEqual([view.rewards[0].asset, view.rewards[0].paid, view.rewards[0].state, view.fees.paidToHolders, view.holderRewards.asset, view.holderRewards.thresholdUsd], ['SOL', '0.8575', 'complete', '0.8575', 'SOL', 100]);
    assert.equal(view.events, undefined, 'internal activity is not public');
    const admin = (await h.service.adminOverview('admin')).launches.find(l => l.id === launch.id);
    assert.equal(admin.holderPayout.last.state, 'completed'); assert.equal(admin.holderPayout.last.paid, '0.8575'); assert.equal(admin.holderPayout.last.recipients, 6);
    // Within the cycle interval a new share worth $100 waits for the next automatic payout.
    store.recordFeeReceipt({ launchId: launch.id, mint: launch.mint, signature: signature(), eventIndex: 0, recipient: launch.mode_wallet, role: 'rewards', amount: 900000000n, distributed: 1000000000n, slot: 2 });
    h.advance(10 * 60000); await pass(h);
    assert.equal(h.service.payoutRequest(store.launch(launch.id)), null, 'not within an hour of the last payout');
  } finally { await h.cleanup(); }
});

test('an administrator can pay a Holders coin now, below $100; requests are idempotent and respect the holder flag', async () => {
  const h = harness();
  try {
    await openIntake(h, { intake: true });
    h.world.holders = Array.from({ length: 3 }, (_, i) => ({ owner: generateWallet().address, amount: String(1000000000n * BigInt(i + 1)) }));
    const launch = await fundAndCreate(h, body({ mode: 'holders', devBuySol: '0' }));
    const store = h.service.store(), id = launch.id, first = 'a'.repeat(32), second = 'b'.repeat(32), third = 'c'.repeat(32);
    h.service.kick = () => null; // passes run only when the test asks
    store.recordFeeReceipt({ launchId: id, mint: launch.mint, signature: signature(), eventIndex: 0, recipient: launch.mode_wallet, role: 'rewards', amount: 100000000n, distributed: 111111111n, slot: 1 });
    await assert.rejects(h.service.queueHolderPayout('nobody', { launchId: id, requestId: first }), /Administrator access/);
    await assert.rejects(h.service.queueHolderPayout('admin', { launchId: id, requestId: 'bad' }), /valid payout request/);
    // The holder flag is a kill switch for administrator requests too.
    store.setFlag('holders', false, { reason: 'test' });
    assert.deepEqual(await h.service.queueHeldSolDistribution('admin', { id, requestId: third }), { state: 'skipped', reason: 'Holder reward payouts are switched off in Admin → Pump.fun.' });
    store.setFlag('holders', true, { reason: 'test' });
    const queued = await h.service.queueHeldSolDistribution('admin', { id, requestId: first });
    assert.equal(queued.state, 'processing');
    assert.equal((await h.service.queueHeldSolDistribution('admin', { id, requestId: first })).state, 'processing', 'the same request ID is recorded once');
    assert.equal((await h.service.queueRewardSweep('admin', { launchId: id, requestId: second })).state, 'processing', 'a second request joins the open payout');
    assert.equal(h.service.payoutRequest(store.launch(id)).requests.length, 2);
    // The window needs an hour of holder snapshots; the request waits and says so.
    await pass(h);
    assert.equal((await h.service.heldSolDistributionStatus({ id, requestId: first })).state, 'waiting');
    assert.match((await h.service.rewardSweepStatus({ launchId: id, requestId: second })).reason, /hour of holder snapshots/);
    for (let i = 0; i < 14 && !store.rewardCycles(id, 5).length; i++) { await h.service.process(); h.advance(5 * 60000); }
    const cycle = store.rewardCycles(id, 5)[0]; assert.ok(cycle, 'about $15 is paid on request');
    await pass(h);
    assert.equal(BigInt(cycle.amount), 100000000n - 2500000n);
    assert.equal(store.operationsFor(id, 'distribute').length, 0, 'nothing was pending, so nothing was collected');
    for (const op of store.operationsFor(id, 'airdrop')) h.world.receipts.set(op.signature, { state: 'confirmed', actualSolCostLamports: '6000' });
    await pass(h); await pass(h);
    const result = await h.service.heldSolDistributionStatus({ id, requestId: first });
    assert.deepEqual([result.state, result.paidLamports], ['completed', '97500000']);
    const sweep = await h.service.rewardSweepStatus({ launchId: id, requestId: second });
    assert.deepEqual([sweep.state, sweep.stage, sweep.distributedQuoteUnits], ['completed', 'done', '97500000']);
    assert.match(sweep.reason, /Paid 0\.0975 SOL to 3 holders/);
    // Owner tools: Pay holders now records a request the same way (nothing left to pay now).
    const overview = await h.service.adminControl('admin', { launchId: id, action: 'pay-holders', reason: 'Pay the holders now' });
    assert.equal(overview.launches.find(l => l.id === id).holderPayout.open.source, 'admin');
    const again = await h.service.adminControl('admin', { launchId: id, action: 'pay-holders', reason: 'Pay the holders now' });
    assert.equal(again.launches.find(l => l.id === id).holderPayout.open.requests, 2, 'a second request joins the open payout');
    const creator = await fundAndCreate(h, body({ mode: 'creator', devBuySol: '0' }));
    await assert.rejects(h.service.adminControl('admin', { launchId: creator.id, action: 'pay-holders', reason: 'Pay the holders now' }), /does not pay holder rewards/);
  } finally { await h.cleanup(); }
});

test('Market Maker trades only from its own wallet, credits capital without profit and stays paused until resumed', async () => {
  const h = harness();
  try {
    await openIntake(h, { intake: true, strategies: true });
    const launch = await fundAndCreate(h, body({ mode: 'market_maker', devBuySol: '1', seedSol: '1' }));
    const store = h.service.store();
    let s = store.strategy(launch.id);
    assert.equal(s.contributed, lamportsFromSol('1').toString(), 'seed capital is contributed capital');
    assert.equal(s.wallet, launch.mode_wallet); assert.notEqual(s.wallet, launch.launch_wallet);
    h.world.lamports.set(launch.mode_wallet, lamportsFromSol('1.02'));
    await pass(h); h.advance(30000); await pass(h);
    const trade = store.operationsFor(launch.id, 'trade')[0];
    assert.ok(trade, 'a rebalancing buy was prepared'); assert.equal(trade.expected.op.side, 'buy'); assert.equal(trade.wallet, launch.mode_wallet);
    assert.ok(BigInt(trade.expected.op.inputAmount) <= lamportsFromSol('0.1'), 'one action moves at most the per-action cap');
    h.world.receipts.set(trade.signature, { state: 'confirmed', solDelta: -BigInt(trade.expected.op.inputAmount), tokenDelta: 3000000000000n, feeLamports: 5000n, slot: 99 });
    h.advance(30000); await pass(h);
    s = store.strategy(launch.id);
    assert.equal(BigInt(s.cash), lamportsFromSol('1') - BigInt(trade.expected.op.inputAmount) - 5000n);
    assert.equal(s.tokens, '3000000000000'); assert.equal(s.contributed, lamportsFromSol('1').toString(), 'trading never changes contributed capital');
    // A fee receipt is a capital credit, idempotent per receipt.
    const sig = signature();
    for (let i = 0; i < 2; i++) store.recordFeeReceipt({ launchId: launch.id, mint: launch.mint, signature: sig, eventIndex: 0, recipient: launch.mode_wallet, role: 'strategy', amount: 50000000n, distributed: 62500000n, slot: 2 });
    assert.equal(store.strategy(launch.id).contributed, (lamportsFromSol('1') + 50000000n).toString());
    // Operator pause is durable: new capital does not restart trading.
    await h.service.adminControl('admin', { launchId: launch.id, action: 'pause-strategy', reason: 'Reviewing volatility' });
    store.recordFeeReceipt({ launchId: launch.id, mint: launch.mint, signature: signature(), eventIndex: 0, recipient: launch.mode_wallet, role: 'strategy', amount: 50000000n, distributed: 62500000n, slot: 3 });
    const before = store.operationsFor(launch.id, 'trade').length; h.advance(700000); await pass(h, 3);
    assert.equal(store.operationsFor(launch.id, 'trade').length, before); assert.equal(store.strategy(launch.id).desired, 'paused');
    await h.service.adminControl('admin', { launchId: launch.id, action: 'resume-strategy', reason: 'Volatility reviewed' });
    assert.equal(store.strategy(launch.id).desired, 'active');
    // The ledger never spends SOL the wallet does not hold; a persistent shortfall pauses the strategy.
    h.world.lamports.set(launch.mode_wallet, 1000n);
    const tradesBefore = store.operationsFor(launch.id, 'trade').length;
    for (let i = 0; i < 5 && store.strategy(launch.id).desired === 'active'; i++) { h.advance(1800000); await pass(h); }
    assert.equal(store.operationsFor(launch.id, 'trade').length, tradesBefore, 'no trade while the wallet is short');
    assert.equal(store.strategy(launch.id).desired, 'paused'); assert.match(store.strategy(launch.id).pause_reason, /reconcile/);
  } finally { await h.cleanup(); }
});

test('Liquidity Manager accumulates before graduation, then swaps and adds to one aggregated LP position', async () => {
  const h = harness();
  try {
    await openIntake(h, { intake: true, strategies: true });
    const launch = await fundAndCreate(h, body({ mode: 'lp_manager', devBuySol: '0', seedSol: '3' }));
    const store = h.service.store();
    h.world.lamports.set(launch.mode_wallet, lamportsFromSol('3.1'));
    h.advance(120000); await pass(h);
    assert.equal(store.strategy(launch.id).observed, 'waiting_for_graduation'); assert.equal(store.operationsFor(launch.id, 'trade').length, 0);
    const a = coinAddresses(launch.mint);
    h.world.coins.set(launch.mint, { ...h.world.coins.get(launch.mint), venue: 'amm', pool: { address: a.canonicalPool, virtual_quote_reserves: 0n, lp_supply: 1000000000000n }, poolBase: 200000000000000n, poolQuote: 85000000000n });
    h.advance(120000); await pass(h); h.advance(120000); await pass(h);
    assert.equal(store.launch(launch.id).venue_state, 'amm');
    const swap = store.operationsFor(launch.id, 'trade')[0];
    assert.ok(swap && swap.expected.purpose === 'lp-swap' && swap.expected.op.venue === 'amm');
    const spent = BigInt(swap.expected.op.inputAmount); assert.ok(spent > lamportsFromSol('1.3') && spent < lamportsFromSol('1.6'), 'the swap is sized from reserves, not blindly half');
    const planned = lpPlan({ cash: lamportsFromSol('3'), tokens: 0n, reserveLamports: PUMP_CLASSIC_POLICY_V1.strategies.lp_manager.cashReserveLamports, baseReserve: 200000000000000n, quoteVault: 85000000000n, feeBps: 30n });
    assert.equal(planned.swapLamports, spent);
    h.world.receipts.set(swap.signature, { state: 'confirmed', solDelta: -spent, tokenDelta: planned.tokensOut, feeLamports: 5000n });
    Object.assign(h.world.coins.get(launch.mint), { poolBase: 200000000000000n - planned.tokensOut, poolQuote: 85000000000n + spent * 10000n / 10030n });
    h.advance(120000); await pass(h); h.advance(120000); await pass(h);
    const deposit = store.operationsFor(launch.id, 'lp-deposit')[0]; assert.ok(deposit);
    assert.equal(BigInt(deposit.expected.op.expected.maxBase), planned.tokensOut, 'the deposit uses only the strategy’s own purchased tokens');
    h.world.receipts.set(deposit.signature, { state: 'confirmed', lpDelta: 5000000000n, baseDelta: -planned.tokensOut, solDelta: -1400000000n, feeLamports: 5000n });
    h.advance(120000); await pass(h);
    let s = store.strategy(launch.id); assert.equal(s.lp, '5000000000');
    // A later contribution adds to the same position instead of replacing it.
    store.recordFeeReceipt({ launchId: launch.id, mint: launch.mint, signature: signature(), eventIndex: 0, recipient: launch.mode_wallet, role: 'strategy', amount: 2000000000n, distributed: 2500000000n, slot: 9 });
    h.world.lamports.set(launch.mode_wallet, lamportsFromSol('4'));
    h.advance(120000); await pass(h);
    const swap2 = store.operationsFor(launch.id, 'trade').at(-1), coin = h.world.coins.get(launch.mint), before2 = store.strategy(launch.id);
    const planned2 = lpPlan({ cash: before2.cash, tokens: before2.tokens, reserveLamports: PUMP_CLASSIC_POLICY_V1.strategies.lp_manager.cashReserveLamports, baseReserve: coin.poolBase, quoteVault: coin.poolQuote, feeBps: 30n });
    assert.equal(planned2.swapLamports, BigInt(swap2.expected.op.inputAmount));
    h.world.receipts.set(swap2.signature, { state: 'confirmed', solDelta: -planned2.swapLamports, tokenDelta: planned2.tokensOut, feeLamports: 5000n });
    Object.assign(coin, { poolBase: coin.poolBase - planned2.tokensOut, poolQuote: coin.poolQuote + planned2.swapLamports * 10000n / 10030n });
    h.advance(120000); await pass(h); h.advance(120000); await pass(h);
    const deposit2 = store.operationsFor(launch.id, 'lp-deposit').at(-1); assert.notEqual(deposit2.id, deposit.id);
    h.world.receipts.set(deposit2.signature, { state: 'confirmed', lpDelta: 2500000000n, baseDelta: -planned2.tokensOut, solDelta: -900000000n, feeLamports: 5000n });
    h.advance(120000); await pass(h);
    s = store.strategy(launch.id); assert.equal(s.lp, '7500000000', 'LP increments are summed');
    // Operator withdrawal stays inside the same strategy wallet.
    await h.service.adminControl('admin', { launchId: launch.id, action: 'lp-withdraw', lpAmount: '1000000000', reason: 'Recovery drill' });
    const withdraw = store.operationsFor(launch.id, 'lp-withdraw')[0]; assert.equal(withdraw.wallet, launch.mode_wallet);
    await assert.rejects(h.service.adminControl('admin', { launchId: launch.id, action: 'lp-withdraw', lpAmount: '99999999999', reason: 'Too much' }), /recorded position|open strategy/);
  } finally { await h.cleanup(); }
});

test('coin views expose recipients and allocations but never secrets or share percentages', async () => {
  const h = harness();
  try {
    await openIntake(h);
    const launch = await fundAndCreate(h, body({ mode: 'creator', devBuySol: '0.1' }));
    const view = await h.service.coinView(launch.mint);
    assert.equal(view.recipients[0].address, launch.protocol_wallet); assert.equal(view.recipients[1].address, h.dev);
    const text = JSON.stringify(view);
    assert.ok(!/secret|sharebps|share_bps|platformShare|percent/i.test(text), 'no key material and no share percentages in public views');
    assert.equal(view.feeLink, '/docs#revenue');
    await assert.rejects(h.service.coinView(generateWallet().address), /Not found/);
    const list = await h.service.publicList(); assert.equal(list[0].platform, 'pump-classic'); assert.equal(list[0].mint, launch.mint);
    await h.service.adminControl('admin', { launchId: launch.id, action: 'hide', reason: 'Moderation test' });
    assert.equal((await h.service.publicList()).length, 0);
    await assert.rejects(h.service.adminControl('nobody', { flags: { intake: false }, reason: 'Not allowed' }), /two-factor/);
  } finally { await h.cleanup(); }
});

test('public market reads are cached, limited to live listed coins and shaped for discovery', async () => {
  const h = harness();
  try {
    await openIntake(h);
    const launch = await fundAndCreate(h, body({ mode: 'market_maker', devBuySol: '0.2', seedSol: '1' }));
    const first = await h.service.marketSnapshot(launch.mint), again = await h.service.marketSnapshot(launch.mint);
    assert.equal(first.mint, launch.mint); assert.equal(again, first, 'a second read within the cache window reuses the snapshot'); assert.equal(h.world.marketReads, 1);
    h.advance(11000); await h.service.marketSnapshot(launch.mint); assert.equal(h.world.marketReads, 2, 'the cache expires');
    const trades = await h.service.trades(launch.mint);
    assert.deepEqual(trades.map(t => [t.side, t.quote, t.amount, t.time]), [['buy', 0.25, 8000000, 1790000000]], 'SOL and whole tokens, seconds, and no row without a time');
    assert.equal(await h.service.marketSnapshot(generateWallet().address), null, 'unknown coins are not read');
    const detail = await h.service.publicDetail(launch.mint);
    assert.equal(detail.platform, 'pump-classic'); assert.equal(detail.mode, 'market_maker'); assert.equal(detail.status, 'trading');
    assert.ok(!/secret|sharebps|share_bps|platformShare|percent|launch_wallet|protocol_wallet/i.test(JSON.stringify(detail)), 'public rows carry no wallets, shares or keys');
    await h.service.adminControl('admin', { launchId: launch.id, action: 'hide', reason: 'Moderation test' });
    assert.equal(await h.service.marketSnapshot(launch.mint), null, 'hidden coins leave discovery');
    assert.equal((await h.service.publicDetail(launch.mint)).hidden, true, 'a direct link still resolves a hidden coin for its holders');
  } finally { await h.cleanup(); }
});

test('the owner can return a retired strategy’s SOL to the coin’s funding wallet; its tokens and LP stay', async () => {
  const h = harness();
  try {
    await openIntake(h, { intake: true });
    const launch = await fundAndCreate(h, body({ mode: 'market_maker', devBuySol: '0.5', seedSol: '1' })), store = h.service.store();
    const control = (action, reason = 'Owner test coin, returning its strategy SOL') => h.service.adminControl('admin', { launchId: launch.id, action, reason });
    await assert.rejects(control('withdraw-strategy-sol'), /Retire the strategy before withdrawing its SOL/);
    await control('retire-strategy');
    h.world.lamports.set(launch.mode_wallet, 1000000000n + 10000000n);
    store.updateStrategy(launch.id, { last_value: '1000000000', high_water: '1000000000' }); // as last valued while it ran
    await control('withdraw-strategy-sol');
    const op = store.operationsFor(launch.id, 'withdraw').find(o => o.expected.purpose === 'strategy-withdraw');
    assert.deepEqual([op.wallet, op.expected.op.recipient, op.expected.op.inputAmount, op.expected.keepLamports], [launch.mode_wallet, h.dev, String(1010000000n - 5000n - 1000000n), '1000000'], 'everything but a 0.001 SOL reserve goes to the funding wallet');
    assert.equal(h.world.drain.keep, 1000000n, 'the strategy wallet stays a rent-exempt fee shareholder');
    await assert.rejects(control('withdraw-strategy-sol'), /Wait for the open strategy transaction/);
    await assert.rejects(control('resume-strategy'), /cannot be resumed/, 'a retired strategy stays retired');
    h.world.receipts.set(op.signature, { state: 'confirmed', slot: 90, actualSolCostLamports: '5000' });
    await pass(h, 2);
    const s = store.strategy(launch.id);
    assert.deepEqual([s.cash, s.contributed, s.last_value, s.high_water, s.desired], ['0', '0', '0', '0', 'retired'], 'returned capital leaves the ledger and the valuation');
    const view = h.service.strategyView(store.launch(launch.id));
    assert.deepEqual([view.equitySol, view.resultSol], ['0', '0'], 'nothing is reported as profit or loss');
    assert.equal(store.balance(launch.id, 'strategy').debited, 1010000000n - 5000n - 1000000n);
    assert.ok(store.events(launch.id).some(e => e.title === 'Retired strategy’s SOL returned' && e.body.includes(h.dev)), 'the coin page shows the return');
    store.setFlag('strategies', true, { reason: 'test' }); h.advance(60000); await pass(h, 2);
    assert.ok(!h.world.calls.some(c => c.startsWith('prepareCurveTrade')), 'a retired strategy never trades');
    // Later creator fees can be returned the same way; an empty wallet is refused.
    h.world.lamports.set(launch.mode_wallet, 1000000n + 4000n);
    await assert.rejects(control('withdraw-strategy-sol'), /no SOL to withdraw beyond its 0\.001 SOL reserve/);
    const holders = await fundAndCreate(h, body({ mode: 'holders' }));
    await assert.rejects(h.service.adminControl('admin', { launchId: holders.id, action: 'withdraw-strategy-sol', reason: 'Not a strategy coin' }), /no strategy/);
  } finally { await h.cleanup(); }
});

test('live Pump.fun coins appear in the shared Token moderation list and hide or restore there', async () => {
  const h = harness();
  try {
    await openIntake(h);
    const live = await fundAndCreate(h, body({ symbol: 'live' })), store = h.service.store();
    const pending = await h.service.quote(h.session, { ...body({ symbol: 'wait' }), wallet: h.dev });
    await assert.rejects(h.service.adminInventory('acct-1'), /Administrator access/);
    const rows = await h.service.adminInventory('admin');
    assert.deepEqual(rows.map(r => r.adminRow.id), [live.id], 'only coins that exist are listed');
    const row = rows[0].adminRow;
    assert.deepEqual([row.route, row.mint, row.accountId, row.username, row.hidden, row.canArchive, row.canRestore, row.eligibility.allowed, rows[0].account.username], ['pump-classic', live.mint, 'acct-1', 'scout-creator', false, false, false, false, 'scout-creator']);
    assert.ok(!JSON.stringify(rows).includes('secret'), 'no key material');
    await assert.rejects(h.service.adminVisibility('admin', { accountId: 'acct-1', id: live.id, mint: generateWallet().address, hidden: true, reason: 'Wrong mint is refused' }), /not found/);
    await assert.rejects(h.service.adminVisibility('admin', { accountId: 'acct-1', id: pending.id, mint: pending.mint, hidden: true, reason: 'Not created yet' }), /not found/);
    await assert.rejects(h.service.adminVisibility('admin', { accountId: 'acct-1', id: live.id, mint: live.mint, hidden: true, reason: 'x' }), /reason/);
    assert.deepEqual(await h.service.adminVisibility('admin', { accountId: 'acct-1', id: live.id, mint: live.mint, hidden: true, reason: 'Spam coin' }), { route: 'pump-classic', id: live.id, mint: live.mint, hidden: true });
    assert.equal((await h.service.publicList()).length, 0, 'hidden from public lists');
    assert.ok(await h.service.publicDetail(live.mint), 'direct links keep resolving');
    assert.equal((await h.service.adminInventory('admin'))[0].adminRow.listArchived, true, 'listed under Archived tokens');
    await h.service.adminVisibility('admin', { accountId: 'acct-1', id: live.id, mint: live.mint, hidden: false, reason: 'Reviewed and restored' });
    assert.equal((await h.service.publicList()).length, 1);
    assert.ok(store.events(live.id, { publicOnly: false }).some(e => e.title === 'Hidden by moderation' && e.body === 'Spam coin'));
  } finally { await h.cleanup(); }
});

// v71.25 regressions: lists read live coins by state (abandoned quotes never push them out), one quote at a time per
// account, coin text kept on one line with field-specific limits, and one chain client per rebroadcast sequence.
const address = () => base58Encode(randomBytes(32)), newIdFor = prefix => prefix + '_' + randomBytes(9).toString('base64url');
async function until(check, ms = 3000) { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw Error('Timed out waiting for the condition.'); await new Promise(resolve => setTimeout(resolve, 5)); } }
/** A launch row as the service saves it, with real launch keys (live coins of every option without running the worker). */
async function seedLaunch(h, state, { mode = 'creator', ...extra } = {}) {
  const id = randomBytes(12).toString('hex'), keys = await h.service.provisionKeys(id, mode), modeWallet = keys.mode_wallet?.address || null;
  return h.service.store().insertLaunch({ id, account_id: 'acct-1', request_key: sha(id), mode, policy_version: PUMP_CLASSIC_POLICY.version, policy_hash: PUMP_CLASSIC_POLICY_HASH, name: 'Old ' + mode, symbol: 'OLD',
    developer_wallet: h.dev, launch_wallet: keys.launch.address, protocol_wallet: keys.protocol.address, mode_wallet: modeWallet, mint: keys.mint.address, recipient: modeWallet || h.dev,
    plan: { funding: { totalLamports: '50000000' }, transfers: [], shareholders: [], memo: `pump-launch:${id}` }, quote: { tokens: '0' }, quote_expires_at: h.now() + 600000, state, ...(state === 'created' ? { live_at: h.now() } : {}), ...extra });
}

test('live coins stay in Explore, Gotchi, agent, revenue, moderation, admin and creator lists however many newer quotes were abandoned', async () => {
  const h = harness();
  try {
    await h.service.ensure(); const store = h.service.store();
    const creator = await seedLaunch(h, 'created'); h.advance(1000);
    const gotchi = await seedLaunch(h, 'created', { mode: 'gotchi', gotchi: { id: 'fomogotchi', theme: 'fomogotchi', vault: address() } }); h.advance(1000);
    const agent = await seedLaunch(h, 'created', { mode: 'agent', agent: { version: 1, id: 'c'.repeat(24), wallet: address(), model: 'test-model', capabilities: 1 } }); h.advance(1000);
    const hidden = await seedLaunch(h, 'created', { hidden: true }); h.advance(1000);
    const failed = await seedLaunch(h, 'failed', { refund_state: 'pending' }); h.advance(1000);
    for (const [l, kind] of [[gotchi, 'gotchi'], [agent, 'agent']]) store.insertSweep({ id: newIdFor(kind), launchId: l.id, kind, operationId: newIdFor('op'), signature: signature(), from: l.mode_wallet, to: address(), amount: 1000000n, state: 'confirmed' });
    // Every "Review launch" or "Start over" adds a row: 5,100 later quotes by this creator are left to expire, one is cancelled.
    store.db.transaction(() => { for (let i = 0; i < 5100; i++) { h.advance(1000); store.insertLaunch({ id: randomBytes(12).toString('hex'), account_id: 'acct-1', request_key: sha('abandoned' + i), mode: 'creator', policy_version: PUMP_CLASSIC_POLICY.version, policy_hash: PUMP_CLASSIC_POLICY_HASH, name: 'Draft', symbol: 'DRAFT', launch_wallet: address(), protocol_wallet: address(), mint: address(), plan: { funding: { totalLamports: '1' } }, quote: {}, quote_expires_at: h.now(), state: i === 0 ? 'cancelled' : 'expired' }); } });
    h.advance(1000); const stale = await seedLaunch(h, 'awaiting_funding', { quote_expires_at: h.now() - 1 }); h.advance(1000);
    const open = await seedLaunch(h, 'awaiting_funding');
    const live = [agent, gotchi, creator].map(l => l.id), ids = rows => rows.map(r => r.id);
    assert.deepEqual(ids(await h.service.publicList()), live, 'Explore and search list every visible live coin, newest first');
    assert.deepEqual((await h.service.gotchiLaunches()).map(r => r.launchId), [gotchi.id]);
    assert.deepEqual((await h.service.gotchiSources()).map(r => r.launchMint), [gotchi.mint], 'the Gotchi keeps its credit');
    assert.deepEqual((await h.service.agentLaunches()).map(r => r.launchId), [agent.id]);
    assert.deepEqual((await h.service.agentSources()).map(r => r.launchMint), [agent.mint], 'the agent keeps its credit');
    assert.equal((await h.service.revenueSummary()).coins, 4);
    assert.deepEqual((await h.service.adminInventory('admin')).map(r => r.adminRow.id), [hidden.id, ...live], 'moderation lists hidden coins too');
    const overview = ids((await h.service.adminOverview('admin')).launches);
    for (const l of [creator, gotchi, agent, hidden, failed, open]) assert.ok(overview.includes(l.id), 'the Pump.fun admin keeps every coin’s controls');
    assert.equal(overview.length, 7 + 200 - 2, 'plus the newest 200 for context (the two newest quotes are among them)');
    const verified = await h.service.verifyKeys('admin');
    for (const l of [creator, gotchi, agent, hidden, failed]) assert.equal(verified.rows.find(r => r.id === l.id)?.ok, true, 'old coins’ keys are verified');
    const mine = (await h.service.mine(h.session)).launches;
    assert.deepEqual(ids(mine), [open.id, failed.id, hidden.id, agent.id, gotchi.id, creator.id], 'the creator keeps live and unfinished launches; abandoned quotes are left out');
    assert.ok(!ids(mine).includes(stale.id), 'a quote past its expiry is left out before the worker marks it');
    assert.deepEqual(Object.keys(mine[0]).sort(), Object.keys(h.service.launchView(open, { owner: true })).sort(), 'rows keep the owner view shape');
    assert.equal(store.liveLaunches().length, 4);
  } finally { await h.cleanup(); }
});

test('a repeated or concurrent quote request never duplicates a launch, its keys or its metadata, and the pending limit holds', async () => {
  const h = harness();
  try {
    await openIntake(h);
    const keyDocs = () => [...h.docs.keys()].filter(k => k.startsWith('pump-classic-keys-')), rows = () => h.service.store().launchesWhere({ accountId: 'acct-1' });
    const same = { ...body({ mode: 'creator', devBuySol: '0' }), wallet: h.dev };
    const [one, two] = await Promise.all([h.service.quote(h.session, same), h.service.quote(h.session, same)]);
    assert.equal(two.id, one.id, 'a double click gets the first quote back');
    assert.deepEqual(keyDocs(), ['pump-classic-keys-' + one.id], 'no orphan keys'); assert.equal(h.metadata.length, 1, 'no orphan metadata'); assert.equal(rows().length, 1);
    // Two processes racing on the same request (no shared lock): the save itself returns the first launch, never a constraint error.
    const raced = { ...body({ mode: 'creator', devBuySol: '0' }), wallet: h.dev };
    const [first, second] = await Promise.all([h.service.createQuote(h.session, raced), h.service.createQuote(h.session, raced)]);
    assert.equal(second.id, first.id); assert.equal(rows().length, 2);
    // Two pending launches: of three concurrent new quotes only one fits under the limit of three; the others provision nothing.
    const docs = keyDocs().length, published = h.metadata.length;
    const results = await Promise.allSettled([1, 2, 3].map(() => h.service.quote(h.session, { ...body({ mode: 'creator', devBuySol: '0' }), wallet: h.dev })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    for (const r of results.filter(r => r.status === 'rejected')) { assert.equal(r.reason.statusCode, 409); assert.match(r.reason.message, /Finish or cancel your pending Pump.fun launches first/); }
    assert.equal(keyDocs().length, docs + 1); assert.equal(h.metadata.length, published + 1); assert.equal(rows().length, 3);
    assert.equal(h.service.queues.size, 0, 'the per-account queue is released');
  } finally { await h.cleanup(); }
});

test('coin text is trimmed onto one line, @handles become profile links, and each limit is named with its field', async () => {
  const h = harness();
  try {
    await openIntake(h);
    const quote = await h.service.quote(h.session, { ...body({ mode: 'creator', devBuySol: '0', name: '  Scout Signal \n', symbol: ' scout\t', description: 'Line one.\nLine two.\r\n\tLine three. ', website: 'launch.example', twitter: '@examplecoin', telegram: 'https://@examplechat' }), wallet: h.dev });
    const row = h.service.store().launch(quote.id), saved = { name: 'Scout Signal', symbol: 'SCOUT', description: 'Line one. Line two. Line three.', website: 'https://launch.example/', twitter: 'https://x.com/examplecoin', telegram: 'https://t.me/examplechat' };
    assert.deepEqual(Object.fromEntries(Object.keys(saved).map(k => [k, row[k]])), saved);
    assert.deepEqual(Object.fromEntries(Object.keys(saved).map(k => [k, h.metadata[0][k]])), saved, 'the published metadata matches');
    for (const [fields, message] of [
      [{ name: ' \n ' }, /^Enter a coin name\.$/],
      [{ name: 'Café Ünïcödé Rocket Club 🚀' }, /^The coin name is too long\. Use at most 32 characters; emoji and accented letters count as 2 to 4 each\.$/],
      [{ symbol: 'ÜNÏCÖDÉTICK' }, /^The ticker is too long\. Use at most 13 characters/],
      [{ description: 'x'.repeat(501) }, /^The description is too long\. Use at most 500 characters\.$/],
      [{ website: '@examplecoin' }, /^Enter the website as an https:\/\/ address with a domain/],
      [{ website: 'https://examplecoin' }, /^Enter the website as an https:\/\/ address with a domain/],
      [{ website: 'http://launch.example' }, /^Enter the website as an https:\/\/ address/],
      [{ twitter: '@this_is_far_too_long' }, /^Enter X as @handle/],
      [{ telegram: '@abc' }, /^Enter Telegram as @username/],
    ]) await assert.rejects(h.service.quote(h.session, { ...body({ mode: 'creator', devBuySol: '0', ...fields }), wallet: h.dev }), error => error.statusCode === 400 && message.test(error.message));
    assert.equal(h.service.store().launchesWhere({ accountId: 'acct-1' }).length, 1, 'refused text saves nothing');
  } finally { await h.cleanup(); }
});

test('funding rebroadcasts reuse one chain client per sequence and close it when the sequence ends', async () => {
  const h = harness();
  try {
    await openIntake(h);
    const quote = await h.service.quote(h.session, { ...body({ mode: 'creator', devBuySol: '0' }), wallet: h.dev });
    const prepared = await h.service.prepareFunding(h.session, { launchId: quote.id });
    await h.service.submitFunding(h.session, { launchId: quote.id, operationId: prepared.operationId, signedTransaction: 'signed-by-wallet' });
    await h.service.running;
    const op = h.service.store().operationsFor(quote.id, 'funding').find(o => o.signature), base = h.service.chainFactory;
    let made = [], failFirst = false;
    h.service.chainFactory = async () => { const chain = await base(); chain.closes = 0; chain.close = async () => { chain.closes++; }; if (failFirst && !made.length) chain.broadcastSaved = async () => { throw Error('RPC unavailable'); }; made.push(chain); return chain; };
    h.service.rebroadcast = { everyMs: 2, times: 5 };
    let sent = h.world.broadcasts.length; h.service.burst(op.id);
    await until(() => h.world.broadcasts.length - sent === 5 && made.length === 1 && made[0].closes === 1);
    assert.ok(h.world.broadcasts.slice(sent).every(s => s === op.signature), 'the same signed funding each time');
    // A failed resend drops its client and the next builds a fresh one; each is closed exactly once.
    made = []; failFirst = true; sent = h.world.broadcasts.length; h.service.burst(op.id);
    await until(() => h.world.broadcasts.length - sent === 4 && made.length === 2 && made.every(c => c.closes === 1));
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(made.length, 2); assert.ok(made.every(c => c.closes === 1));
    // Closing the service closes a client a running sequence still holds.
    made = []; failFirst = false; h.service.rebroadcast = { everyMs: 2, times: 1000 }; h.service.burst(op.id);
    await until(() => made.length === 1); await h.service.close();
    await until(() => made[0].closes === 1); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(made[0].closes, 1);
  } finally { await h.cleanup(); }
});

// ---- v71.26: the owner's Cleanup page and the paged Pump.fun admin list ----
test('finished launches can be archived once their money settled; the admin list pages, filters and counts them', async () => {
  const h = harness();
  try {
    await h.service.ensure(); const store = h.service.store();
    const live = await seedLaunch(h, 'created'); h.advance(1000);
    const refunding = await seedLaunch(h, 'failed', { refund_state: 'pending', state_reason: 'Creation did not succeed after repeated checks.', funded_lamports: '120000000', funding_signature: signature() }); h.advance(1000);
    h.world.lamports.set(refunding.launch_wallet, 120000000n); // its refund stays in flight (the worker journals the drain and waits for its receipt)
    const refunded = await seedLaunch(h, 'refunded', { refund_state: 'complete', refunded_lamports: '119000000', funded_lamports: '120000000', funding_signature: signature() }); h.advance(1000);
    const stuck = await seedLaunch(h, 'funded', { funded_at: h.now() - 2 * 3600000, funded_lamports: '90000000', funding_signature: signature() }); h.advance(1000);
    const expired = await seedLaunch(h, 'expired'); h.advance(1000);
    const paused = await seedLaunch(h, 'created', { mode: 'market_maker' }); store.ensureStrategy(paused.id, 'market_maker', paused.mode_wallet); store.updateStrategy(paused.id, { desired: 'paused', pause_reason: 'Loss limit reached', observed: 'paused' }); h.advance(1000);
    // Cleanup rows: every unfinished launch, with its kind, money and the actions it allows (never a key or a signature).
    const rows = await h.service.adminUnfinished('admin'), byId = Object.fromEntries(rows.map(r => [r.id, r]));
    await assert.rejects(h.service.adminUnfinished('acct-1'), /Administrator access/);
    assert.equal(byId[live.id], undefined, 'live coins are not cleanup work');
    assert.deepEqual([byId[refunding.id].kind, byId[refunding.id].actions, byId[refunding.id].money], ['refund', [], '0.12 SOL funded']);
    assert.deepEqual([byId[refunded.id].kind, byId[refunded.id].actions, byId[refunded.id].bulkEligible], ['failed', ['archive'], true]);
    assert.deepEqual([byId[stuck.id].kind, byId[stuck.id].actions, byId[stuck.id].reason], ['unfinished', ['refund'], 'Funding was received but the coin was never created.']);
    assert.deepEqual([byId[expired.id].kind, byId[expired.id].actions], ['abandoned', ['archive']], 'an expired quote that was never funded is abandoned, not failed');
    assert.doesNotMatch(JSON.stringify(rows), /secret|"raw"/i);
    // Archive: only settled finished launches; a waiting refund keeps its row until it settles; the launch itself stays.
    await assert.rejects(h.service.adminControl('admin', { launchId: refunding.id, action: 'archive', reason: 'Cleanup from the admin panel.' }), /refund is still being returned/);
    await assert.rejects(h.service.adminControl('admin', { launchId: live.id, action: 'archive', reason: 'Cleanup from the admin panel.' }), /failed, was refunded, cancelled or expired/);
    await h.service.adminControl('admin', { launchId: refunded.id, action: 'archive', reason: 'Cleanup from the admin panel.' });
    assert.equal(store.launch(refunded.id).archived, true); assert.equal(store.launch(refunded.id).state, 'refunded', 'archiving changes nothing but the flag');
    assert.equal((await h.service.adminUnfinished('admin')).find(r => r.id === refunded.id).kind, 'archived');
    await h.service.adminControl('admin', { launchId: refunded.id, action: 'unarchive', reason: 'Cleanup from the admin panel.' });
    assert.equal(store.launch(refunded.id).archived, false);
    // Archive all: every settled failure and abandoned quote at once (the waiting refund and the live coin stay).
    await h.service.adminControl('admin', { action: 'archive-all', reason: 'Archive all finished failures from the admin panel.' });
    assert.deepEqual([store.launch(refunded.id).archived, store.launch(expired.id).archived, store.launch(refunding.id).archived, store.launch(live.id).archived], [true, true, false, false]);
    assert.equal(h.service.lastArchiveAll.archived, 2);
    // The overview without options lists everything as before; with a page it filters, pages and counts.
    const full = await h.service.adminOverview('admin');
    assert.ok(full.launches.find(l => l.id === refunded.id)?.archived === true && full.launchTotal === undefined);
    const page = await h.service.adminOverview('admin', { offset: 0, limit: 2 });
    assert.deepEqual([page.launchTotal, page.launches.length, page.nextOffset, page.counts.archived, page.counts.attention], [4, 2, 2, 2, 3]);
    assert.ok(page.launches.every(l => !l.archived), 'archived launches are left out unless asked for');
    assert.deepEqual((await h.service.adminOverview('admin', { offset: 0, limit: 25, archived: true })).launches.map(l => l.id).sort(), [expired.id, refunded.id].sort());
    assert.deepEqual((await h.service.adminOverview('admin', { offset: 0, limit: 25, state: 'attention' })).launches.map(l => l.id).sort(), [refunding.id, stuck.id, paused.id].sort());
    assert.deepEqual((await h.service.adminOverview('admin', { offset: 0, limit: 25, search: paused.mint.slice(0, 8) })).launches.map(l => l.id), [paused.id]);
    assert.deepEqual((await h.service.adminOverview('admin', { offset: 0, limit: 25, mode: 'market_maker' })).launches[0].attention, [{ code: 'strategy-paused', text: 'Strategy paused' }]);
    await assert.rejects(h.service.adminOverview('admin', { offset: 0, limit: 500 }), /Invalid launch page/);
    await assert.rejects(h.service.adminOverview('admin', { offset: 0, limit: 25, state: 'nonsense' }), /valid launch state/);
    const attention = await h.service.adminAttention('admin');
    assert.deepEqual(attention, { refunds: 1, strategiesPaused: 1, payoutsBlocked: 0, stuck: 1, failed: 0 });
  } finally { await h.cleanup(); }
});
