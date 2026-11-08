// Shared scripted chain and harness for Pump.fun Classic service tests (v71.35).
// Lifted from pump-classic-service.test.mjs so other suites can drive the real
// service through quotes, funding, creation, receipts, payouts and sweeps
// without duplicating the fake. The fake chain returns exactly what the real
// adapter returns after its own simulation checks. Dependency-free.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { PumpClassicService, generateWallet } from '../../src/pump-classic/service.mjs';
import { base58Encode } from '../../src/pump-classic/codec.mjs';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const signature = () => base58Encode(randomBytes(64));
export function signedOp(fields) { const raw = Buffer.from(randomBytes(200)).toString('base64'); return { signature: signature(), raw, rawHash: sha(Buffer.from(raw, 'base64')), blockhash: base58Encode(randomBytes(32)), lastValidBlockHeight: 5000, preparedSlot: 100, createdAt: Date.now(), ...fields }; }

export class World {
  constructor() { this.slot = 1000; this.calls = []; this.broadcasts = []; this.receipts = new Map(); this.deposits = new Map(); this.status = new Map(); this.coins = new Map(); this.history = new Map(); this.distributions = new Map(); this.lamports = new Map(); this.setupOk = true; this.tokensPerLamport = 30000n; }
}
export class FakeChain {
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
  async prepareAirdrop({ wallet, mint, payouts }) { return this.log('prepareAirdrop', signedOp({ kind: 'airdrop', wallet: wallet.address, mint, inputAmount: payouts.reduce((s, p) => s + BigInt(p.lamports), 0n).toString(), tokenAmount: payouts.reduce((s, p) => s + BigInt(p.tokens || 0), 0n).toString(), payouts })); }
  async readGlobals() { return { slot: 1, global: {}, feeConfig: null, ammGlobalConfig: { lp_fee_basis_points: 20n, protocol_fee_basis_points: 5n, coin_creator_fee_basis_points: 5n, buyback_basis_points: 0n }, ammFeeConfig: null }; }
  async quoteUsd(mint) { this.w.priceReads = (this.w.priceReads || 0) + 1; if (this.w.priceDown) throw Object.assign(Error('A fresh SOL/USD reference is unavailable.'), { code: 'PUMP_CLASSIC_PRICE' }); const usd = this.w.prices?.get(mint); return { usd: usd ?? this.w.solUsd ?? 150, at: this.w.clock() }; }
  // ---- reward baskets (v71.35): extra assets, their purchase and their payout ----
  async conversionSupport(mints) { return new Map(mints.map(m => [m, !(this.w.unroutable || new Set()).has(m)])); }
  async basketAssetInfo(mint) { const asset = this.w.assets?.get(mint); if (!asset) return { mint, supported: false, reason: 'This pair’s token mint was not found.' }; return { mint, supported: true, program: asset.program || 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', decimals: asset.decimals ?? 6, extensions: [], metadata: { symbol: asset.symbol, name: asset.symbol } }; }
  async quoteDevBuyConversion({ quoteMint, lamports }) { this.log('quoteDevBuyConversion'); if ((this.w.unroutable || new Set()).has(quoteMint) || !this.w.assets?.get(quoteMint)) throw Object.assign(Error('No SOL route is available.'), { code: 'SOL_ROUTE_NOT_FOUND' }); const rate = this.w.assets.get(quoteMint).rawPerLamport ?? 1n; const expected = BigInt(lamports) * rate; return { expectedRaw: expected.toString(), minimumRaw: (expected * 99n / 100n).toString(), slot: 100 }; }
  async prepareBasketAcquire({ wallet, mint, lamports, minSolReserve }) { if (this.w.failAcquire?.has(mint)) throw Object.assign(Error('No fair route right now.'), { code: 'TREASURY_PRICE_IMPACT' }); return this.log('prepareBasketAcquire', signedOp({ kind: 'acquire', wallet: wallet.address, mint, inputAmount: String(lamports), accounting: { minSolReserve: String(minSolReserve), decimals: this.w.assets?.get(mint)?.decimals ?? 6 } })); }
  async prepareConversion({ wallet, quote, amount }) { return this.log('prepareConversion', signedOp({ kind: 'convert', wallet: wallet.address, mint: quote.mint, inputAmount: String(amount) })); }
  async quoteBalances(addresses, quote) { return { slot: 1, balances: Object.fromEntries(addresses.map(a => [a, this.w.tokens?.get(a)?.get(quote.mint) ?? 0n])) }; }
  async payoutAccounts({ owners, quote }) { const states = this.w.accounts?.get(quote.mint) || new Map(); return { slot: 1, rentLamports: 2039280n, accounts: Object.fromEntries(owners.map(o => [o, states.get(o) || 'ready'])) }; }
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
export function harness({ clockStart = Date.UTC(2026, 9, 2, 12) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pump-classic-')), docs = new Map(), world = new World();
  let clock = clockStart; world.clock = () => clock;
  const accounts = { dir, hostStore: { async read(name, fallback) { return docs.has(name) ? structuredClone(docs.get(name)) : fallback; }, async write(name, value) { docs.set(name, structuredClone(value)); } }, async get(id) { return id === 'admin' ? { id, role: 'admin', mfaEnabled: true, username: 'owner' } : null; }, async list() { return [{ id: 'acct-1', username: 'scout-creator' }, { id: 'admin', username: 'owner' }]; } };
  const metadata = [];
  const service = new PumpClassicService({ accounts, chainFactory: async () => new FakeChain(world), publishMetadata: async args => { metadata.push(args); return `https://launch.example/token-metadata/${args.mint}.json`; }, gotchiTarget: async id => ({ id, theme: id, vault: generateWallet().address }), agentTarget: async () => null, protocolRecipient: async () => world.treasury || null, config: { enabled: true, dbPath: join(dir, 'pc.sqlite'), backupDir: join(dir, 'backups') }, now: () => clock });
  const dev = generateWallet().address, session = { account: { id: 'acct-1', mainWallet: dev }, walletVerified: true, walletAddress: dev };
  return { service, world, docs, dir, metadata, dev, session, advance: ms => { clock += ms; }, now: () => clock, cleanup: async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); } };
}
export const body = (overrides = {}) => ({ requestKey: randomBytes(12).toString('hex'), mode: 'holders', name: 'Scout Signal', symbol: 'scout', description: 'A test coin', image: '/token-images/' + 'a'.repeat(64) + '.png', devBuySol: '1', ...overrides });
export async function openIntake(h, flags = { intake: true }) { await h.service.ensure(); for (const [k, v] of Object.entries(flags)) h.service.store().setFlag(k, v, { reason: 'test' }); }
export async function pass(h, times = 1) { for (let i = 0; i < times; i++) { await h.service.process(); h.advance(11000); } }

export async function fundAndCreate(h, quoteBody = body()) {
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

export { generateWallet };
