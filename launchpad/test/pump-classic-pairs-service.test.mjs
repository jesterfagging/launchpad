// Pump.fun launches on pairs other than SOL (v71.19, SOL-only funding from
// v71.22), against a scripted chain: the live pair list, quote gating (SOL-only
// options, convertible pairs, the creator-chosen creator fee, the SOL dev buy
// and its pair-unit limit), SOL-only funding, the pair purchase with its
// reviewed minimum, the setup transaction, creation with the pair, the separate
// delivery, selling the pair asset back to SOL when a coin is not created, the
// pair refund before the SOL refund, the pair-asset receipt ledger, conversion
// to SOL before routing, public views and the schema-2 migration of a v71.18
// database. Dependency-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PumpClassicService, generateWallet } from '../src/pump-classic/service.mjs';
import { openPumpClassicDatabase, MIGRATIONS, PUMP_CLASSIC_SCHEMA_VERSION } from '../src/pump-classic/store.mjs';
import { base58Encode } from '../src/pump-classic/codec.mjs';
import { coinAddresses } from '../src/pump-classic/instructions.mjs';
import { curveTokensForQuote } from '../src/pump-classic/math.mjs';
import { PUMP_CLASSIC_POLICY, PUMP_CLASSIC_POLICY_V3, PUMP_CLASSIC_POLICY_V3_HASH } from '../src/pump-classic/policy.mjs';

const SOL = 'So11111111111111111111111111111111111111112', USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const XSTOCK = generateWallet().address, HOOKED = generateWallet().address, ODD = generateWallet().address;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const signature = () => base58Encode(randomBytes(64));
function signedOp(fields) { const raw = Buffer.from(randomBytes(200)).toString('base64'); return { signature: signature(), raw, rawHash: sha(Buffer.from(raw, 'base64')), blockhash: base58Encode(randomBytes(32)), lastValidBlockHeight: 5000, preparedSlot: 100, createdAt: Date.now(), ...fields }; }
const PAIRS = {
  [USDC]: { mint: USDC, kind: 'listed', quoteControl: false, initialVirtualQuoteReserves: 4500000000n, program: SPL, decimals: 6, supported: true, metadata: null },
  [XSTOCK]: { mint: XSTOCK, kind: 'custom', quoteControl: true, initialVirtualQuoteReserves: 120000000000n, program: T22, decimals: 8, supported: true, metadata: { name: 'Example xStock', symbol: 'EXMx' } },
  [ODD]: { mint: ODD, kind: 'custom', quoteControl: true, initialVirtualQuoteReserves: 90000000000n, program: T22, decimals: 8, supported: true, metadata: { name: 'Odd Asset', symbol: 'ODD' } },
  [HOOKED]: { mint: HOOKED, kind: 'custom', quoteControl: true, initialVirtualQuoteReserves: 90000000000n, program: T22, decimals: 6, supported: false, reason: 'This pair’s token runs a transfer hook program.', metadata: null },
};
// Pump's fresh curve (token side) and a fee for the scripted quotes.
const LAUNCHPAD = { virtual_token_reserves: 1073000000000000n, real_token_reserves: 793100000000000n }, FEE = 125n;
const curveFor = virtualQuote => ({ virtual_quote_reserves: BigInt(virtualQuote), ...LAUNCHPAD });
const tokensFor = (virtualQuote, quoteIn) => curveTokensForQuote({ virtualQuote, virtualToken: LAUNCHPAD.virtual_token_reserves, realToken: LAUNCHPAD.real_token_reserves, quoteIn: BigInt(quoteIn), feeBps: FEE });
// Route prices: raw pair units per lamport, as [numerator, denominator] (1 SOL = 150 USDC = 0.8 EXMx).
const RATES = () => ({ [USDC]: [150000000n, 1000000000n], [XSTOCK]: [80000000n, 1000000000n] });
const routed = (rate, lamports, slippageBps = 100) => { const expected = BigInt(lamports) * rate[0] / rate[1]; return { expected, minimum: expected * BigInt(10000 - slippageBps) / 10000n }; };

class World { constructor() { Object.assign(this, { calls: [], broadcasts: [], receipts: new Map(), deposits: new Map(), status: new Map(), coins: new Map(), history: new Map(), distributions: new Map(), lamports: new Map(), tokens: new Map(), plans: [], setupPlans: [], setups: new Map(), creatorFee: { configurable: true, maxBps: 500 }, convertible: new Set([USDC, XSTOCK]), rates: RATES() }); } }
class FakeChain {
  constructor(world) { this.w = world; }
  log(name, value) { this.w.calls.push(name); return value; }
  entry(mint) { if (mint === SOL) return { mint: SOL, kind: 'sol', quoteControl: false, initialVirtualQuoteReserves: 30000000000n }; const p = PAIRS[mint]; if (!p || this.w.delisted === mint) throw Object.assign(Error('Pump.fun no longer accepts this quote asset for new coins.'), { code: 'PUMP_CLASSIC_QUOTE_ASSET', statusCode: 409 }); return { mint, kind: p.kind, quoteControl: p.quoteControl, initialVirtualQuoteReserves: p.initialVirtualQuoteReserves }; }
  async quoteAsset(mint) { const e = this.entry(mint); return this.log('quoteAsset', { ...PAIRS[mint], ...e, solReserves: 30000000000n, creatorFee: this.w.creatorFee, slot: 5 }); }
  async conversionSupport(mints) { return new Map(mints.map(m => [m, this.w.convertible.has(m)])); }
  async quoteLaunch({ devBuyRaw, quoteMint = SOL, creatorFeeBps = 0n }) {
    const entry = this.entry(quoteMint);
    if (creatorFeeBps > 0n && (entry.kind !== 'custom' || creatorFeeBps > BigInt(this.w.creatorFee.maxBps))) throw Object.assign(Error('Pump.fun does not accept this creator fee for this pair right now.'), { code: 'PUMP_CLASSIC_CREATOR_FEE', statusCode: 409 });
    return this.log('quoteLaunch', { tokens: tokensFor(entry.initialVirtualQuoteReserves, devBuyRaw), costLamports: BigInt(devBuyRaw), maxSolCost: BigInt(devBuyRaw), feeBps: FEE, slot: 10, entry, initialCurve: curveFor(entry.initialVirtualQuoteReserves), solReserves: 30000000000n });
  }
  async quoteDevBuyConversion({ quoteMint, program, lamports, taker, slippageBps, maxImpactBps }) {
    this.w.conversionQuote = { quoteMint, program, lamports, taker, slippageBps, maxImpactBps };
    if (this.w.routeError) throw this.w.routeError;
    const { expected, minimum } = routed(this.w.rates[quoteMint], lamports, slippageBps);
    return this.log('quoteDevBuyConversion', { expectedRaw: expected.toString(), minimumRaw: minimum.toString(), slot: 12 });
  }
  async pumpQuotes() { if (this.w.pairsDown) throw Error('rpc down'); this.w.pairReads = (this.w.pairReads || 0) + 1; return { slot: 9, solReserves: 30000000000n, creatorFee: this.w.creatorFee, quotes: [{ mint: SOL, kind: 'sol', quoteControl: false, initialVirtualQuoteReserves: 30000000000n, program: SPL, decimals: 9, supported: true, convertible: true }, ...Object.values(PAIRS).map(p => ({ ...p, convertible: this.w.convertible.has(p.mint) && p.supported }))] }; }
  unsigned(...parts) { const unsignedRaw = Buffer.from('unsigned:' + parts.join(':') + ':' + randomBytes(4).toString('hex')).toString('base64'); return { unsignedRaw, messageHash: sha(unsignedRaw), blockhash: base58Encode(randomBytes(32)), lastValidBlockHeight: 5000, preparedSlot: 100, createdAt: Date.now() }; }
  async priorityPrice() { return 100000; }
  async prepareDeposit({ sender, recipient, lamports, memo }) { return this.log('prepareDeposit', { kind: 'deposit', needsSignature: true, state: 'awaiting_signature', externalSigner: sender, recipient, inputAmount: String(lamports), memo, ...this.unsigned(sender, lamports) }); }
  async prepareSolDeposit(args) { return this.prepareDeposit(args); }
  async prepareQuoteDeposit({ sender, recipient, lamports, memo, quote, tokenAmount, decimals }) { this.w.quoteDeposit = { quote, tokenAmount, decimals }; return this.log('prepareQuoteDeposit', { kind: 'deposit', needsSignature: true, state: 'awaiting_signature', externalSigner: sender, recipient, mint: quote.mint, inputAmount: String(lamports), tokenAmount: String(tokenAmount), memo, ...this.unsigned(sender, lamports, tokenAmount) }); }
  async acceptSigned(op, signed) { if (signed !== 'signed-by-wallet') throw Object.assign(Error('The wallet changed the reviewed transaction.'), { code: 'WALLET_TRANSACTION_REJECTED' }); const { unsignedRaw, messageHash, ...rest } = op; return { ...rest, needsSignature: false, state: 'pending', signature: signature(), raw: Buffer.from('signed:' + unsignedRaw).toString('base64') }; }
  async broadcastSaved(op) { this.w.broadcasts.push(op.signature); }
  async broadcast(op) { this.w.broadcasts.push(op.signature); }
  async savedState(op) { return this.w.status.get(op.signature) || { state: 'pending' }; }
  async state(op) { return this.savedState(op); }
  async depositReceipt({ signature: sig }) { return this.w.deposits.get(sig) ?? null; }
  async quoteDepositReceipt({ signature: sig, tokenAmount }) { this.w.quoteReceiptTokens = tokenAmount; return this.w.deposits.get(sig) ?? null; }
  async prepareDevBuyConversion({ wallet, quote, lamports, minSolReserve, maxNetworkCostLamports, slippageBps, maxImpactBps }) {
    this.w.acquire = { wallet: wallet.address, quote, lamports: BigInt(lamports), minSolReserve: BigInt(minSolReserve), maxNetworkCostLamports: BigInt(maxNetworkCostLamports), slippageBps, maxImpactBps };
    if (this.w.acquireError) throw this.w.acquireError;
    const { expected, minimum } = routed((this.w.purchaseRates || this.w.rates)[quote.mint], lamports, slippageBps);
    return this.log('prepareDevBuyConversion', signedOp({ kind: 'acquire', mint: quote.mint, wallet: wallet.address, inputAmount: String(lamports), minimumOutput: minimum.toString(), expectedOutput: expected.toString(), accounting: { minSolReserve: String(minSolReserve) } }));
  }
  async prepareLaunchSetup({ plan, signer }) {
    assert.equal(signer.address, plan.launchWallet); this.w.setupPlans.push(plan);
    if ((this.w.setups.get(plan.mint) || []).some(sig => this.w.receipts.get(sig)?.state === 'confirmed')) return null;
    if (this.w.failSetup) throw this.w.failSetup;
    const op = signedOp({ kind: 'setup', wallet: plan.launchWallet, mint: plan.mint, created: [{ kind: 'ata', owner: plan.launchWallet }], simulatedSpend: '6100000' });
    this.w.setups.set(plan.mint, [...(this.w.setups.get(plan.mint) || []), op.signature]);
    return this.log('prepareLaunchSetup', op);
  }
  async setupReceipt(op) { return this.w.receipts.get(op.signature) ?? null; }
  async prepareLaunch({ plan, signers }) {
    assert.equal(signers.launch.address, plan.launchWallet); this.w.plans.push(plan);
    if (this.w.failPrepare) throw this.w.failPrepare;
    // As the real adapter: the launch wallet must still hold what the plan says it holds.
    const held = this.w.lamports.get(plan.launchWallet);
    if (held !== undefined && held < BigInt(plan.fundedLamports)) throw Object.assign(Error('The launch wallet holds less than its verified funding.'), { code: 'PUMP_CLASSIC_FUNDING' });
    const reserves = this.entry(plan.quote?.mint ?? SOL).initialVirtualQuoteReserves, tokens = plan.buyAll ? tokensFor(reserves, plan.devBuyRaw) : BigInt(plan.tokens);
    return this.log('prepareLaunch', signedOp({ kind: 'launch', version: 1, wallet: plan.launchWallet, mint: plan.mint, expected: { tokens: String(tokens), delivery: plan.delivery, pairAccounts: plan.pairAccounts, transfers: plan.transfers, shareholders: plan.shareholders } }));
  }
  async launchReceipt(op) { return this.w.receipts.get(op.signature) ?? null; }
  async prepareDelivery({ plan, signer, tokens }) {
    assert.equal(signer.address, plan.launchWallet); assert.equal(plan.delivery, 'separate'); this.w.deliveryPlan = plan;
    if (this.w.failDelivery) throw this.w.failDelivery;
    return this.log('prepareDelivery', signedOp({ kind: 'deliver', wallet: plan.launchWallet, recipient: plan.developer, mint: plan.mint, inputAmount: String(tokens) }));
  }
  async deliveryReceipt(op) { return this.w.receipts.get(op.signature) ?? null; }
  async verifyCoinSetup(plan) { this.w.setupQuote = plan.quote?.mint ?? SOL; return { ok: true, coin: this.w.coins.get(plan.mint) || null }; }
  async readCoin(mint, { quote } = {}) { this.w.readQuote = quote?.mint ?? SOL; return this.w.coins.get(mint) || { exists: false }; }
  async prepareDrain({ wallet, recipient, keepLamports = 0n, minContextSlot = 0 }) { this.w.drainSlot = minContextSlot; const balance = this.w.lamports.get(wallet.address) ?? 0n, keep = BigInt(keepLamports); if (balance - keep <= 5000n) throw Object.assign(Error('Nothing is left to refund after the network fee.'), { code: 'PUMP_CLASSIC_EMPTY' }); this.w.drainKeep = keep; return this.log('prepareDrain', signedOp({ kind: 'withdraw', mint: SOL, wallet: wallet.address, recipient, inputAmount: String(balance - 5000n - keep), accounting: { minSolReserve: String(keep) } })); }
  async prepareQuoteRefund({ wallet, recipient, quote, decimals, minContextSlot = 0 }) { this.w.refundSlot = minContextSlot; if (this.w.pairStuck) throw Object.assign(Error('The quote refund simulation failed: {"InstructionError":[3,{"Custom":17}]}.'), { code: 'PUMP_CLASSIC_SIMULATION' }); const held = this.w.tokens.get(wallet.address + ':' + quote.mint); if (held === undefined) throw Object.assign(Error('The launch wallet holds no quote account.'), { code: 'PUMP_CLASSIC_NO_QUOTE' }); this.w.refundDecimals = decimals; return this.log('prepareQuoteRefund', signedOp({ kind: 'quote-refund', wallet: wallet.address, recipient, mint: quote.mint, inputAmount: String(held), accounting: {} })); }
  async quoteRefundReceipt(op) { return this.w.receipts.get(op.signature) ?? null; }
  async receipt(op) { return this.w.receipts.get(op.signature) ?? null; }
  async prepareDistribution({ wallet, mint, shareholders, includeAmm, quote }) { this.w.distributionQuote = quote?.mint ?? SOL; return this.log('prepareDistribution', signedOp({ kind: 'distribute', wallet: wallet.address, mint, expected: { includeAmm, shareholders } })); }
  async distributionReceipt(sig, { quote }) { this.w.receiptQuote = quote?.mint ?? SOL; return this.w.distributions.get(sig) ?? { signature: sig, slot: 1, blockTime: 1, failed: false, payer: 'x', feeLamports: 5000n, payerLamportDelta: -5000n, legs: [], anomalies: [] }; }
  async signaturesFor(address, { until }) { const all = this.w.history.get(address) || []; const start = until ? all.findIndex(r => r.signature === until) + 1 : 0; return { rows: all.slice(start), complete: true }; }
  async walletBalances(addresses) { return { slot: 1, balances: Object.fromEntries(addresses.map(a => [a, this.w.lamports.get(a) ?? 0n])) }; }
  async quoteBalances(addresses, quote, { minContextSlot = 0 } = {}) { this.w.balanceSlot = minContextSlot; return { slot: 1, balances: Object.fromEntries(addresses.map(a => [a, this.w.tokens.get(a + ':' + quote.mint) ?? 0n])) }; }
  async prepareConversion({ wallet, quote, amount, maxNetworkCostLamports, guard = null, priority = false }) {
    this.w.conversionArgs = { wallet: wallet.address, amount: BigInt(amount), guard, priority };
    if (this.w.noRoute) throw Object.assign(Error('No verified route to SOL is available for this asset.'), { code: 'SOL_ROUTE_NOT_FOUND' });
    this.w.conversionCost = maxNetworkCostLamports;
    return this.log('prepareConversion', signedOp({ kind: 'convert', mint: quote.mint, wallet: wallet.address, inputAmount: String(amount), minimumOutput: '1', expectedOutput: '2', accounting: { minSolReserve: '0' } }));
  }
  async prepareWithdrawal({ wallet, amount, recipient }) { return this.log('prepareWithdrawal', signedOp({ kind: 'withdraw', mint: SOL, wallet: wallet.address, recipient, inputAmount: String(amount), accounting: { minSolReserve: '0' } })); }
  async holderBalances() { this.w.sampleSlot = (this.w.sampleSlot || 100) + 1; return { slot: this.w.sampleSlot, at: this.w.clock(), rows: this.w.holders || [], complete: true }; }
  async quoteUsd(mint) { const usd = (this.w.prices || { [SOL]: 150, [USDC]: 1, [XSTOCK]: 120 })[mint]; if (!usd) throw Object.assign(Error('A fresh quote-asset price is unavailable.'), { code: 'PUMP_CLASSIC_PRICE' }); return { usd, at: this.w.clock() }; }
  async payoutAccounts({ owners, quote }) { this.w.accountReads = (this.w.accountReads || 0) + 1; this.w.accountQuote = quote.mint; return { slot: 1, rentLamports: 2039280n, accounts: Object.fromEntries(owners.map(owner => [owner, this.w.accountStates?.[owner] || 'missing'])) }; }
  async prepareAirdrop({ wallet, mint, payouts, minSolReserve, maxNetworkCostLamports }) {
    // refuseAirdrop(payouts) returns the error a real preparation would throw (a refused account, a failed simulation), or nothing.
    const refused = this.w.refuseAirdrop?.(payouts); if (refused) { this.w.refusals = (this.w.refusals || 0) + 1; throw Error(refused); }
    this.w.airdropArgs = { mint, minSolReserve, maxNetworkCostLamports, payouts };
    return this.log('prepareAirdrop', signedOp({ kind: 'airdrop', wallet: wallet.address, mint, inputAmount: payouts.reduce((sum, p) => sum + BigInt(p.lamports), 0n).toString(), tokenAmount: payouts.reduce((sum, p) => sum + BigInt(p.tokens), 0n).toString(), payouts }));
  }
  async marketSnapshot(mint, { quote } = {}) { this.w.snapshotQuote = quote; return { mint, curve: coinAddresses(mint).bondingCurve, status: 'curve', slot: 90, at: 1, supply: 1e9, priceQuote: 0.0000002, quote: { mint: quote?.mint ?? SOL, usd: 1, at: 1, stale: false } }; }
  async recentTrades(mint, { quote } = {}) { this.w.tradesQuote = quote?.mint ?? SOL; return [{ venue: 'curve', side: 'buy', wallet: generateWallet().address, tokens: 8000000000000n, lamports: 37500000n, time: 1790000000, signature: '9'.repeat(88) }]; }
  async close() {}
}
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'pump-pairs-')), docs = new Map(), world = new World();
  let clock = Date.UTC(2026, 9, 2, 12); world.clock = () => clock;
  const accounts = { dir, hostStore: { async read(name, fallback) { return docs.has(name) ? structuredClone(docs.get(name)) : fallback; }, async write(name, value) { docs.set(name, structuredClone(value)); } }, async get(id) { return id === 'admin' ? { id, role: 'admin', mfaEnabled: true, username: 'owner' } : null; } };
  const service = new PumpClassicService({ accounts, requireOwner: async session => { if (session?.account?.id !== 'owner') throw Object.assign(Error('Owner only.'), { statusCode: 403 }); return session.account; }, chainFactory: async () => new FakeChain(world), publishMetadata: async args => `https://launch.example/token-metadata/${args.mint}.json`, gotchiTarget: async id => ({ id, theme: id, vault: generateWallet().address }), agentTarget: async () => null, protocolRecipient: async () => world.treasury || null, config: { enabled: true, dbPath: join(dir, 'pc.sqlite'), backupDir: join(dir, 'backups') }, now: () => clock });
  // Passes run only when a test asks for them, so every step is deterministic.
  service.kick = () => null;
  const dev = generateWallet().address, session = { account: { id: 'acct-1', mainWallet: dev }, walletVerified: true, walletAddress: dev };
  return { service, world, dir, dev, session, advance: ms => { clock += ms; }, cleanup: async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const body = (overrides = {}) => ({ requestKey: randomBytes(12).toString('hex'), mode: 'creator', name: 'Pair Signal', symbol: 'pair', description: 'A pair coin', image: '/token-images/' + 'b'.repeat(64) + '.png', ...overrides });
async function openFlags(h, flags = { intake: true, pairs: true }) { await h.service.ensure(); for (const [k, v] of Object.entries(flags)) h.service.store().setFlag(k, v, { reason: 'test' }); }
async function pass(h, times = 1) { for (let i = 0; i < times; i++) { await h.service.process(); h.advance(11000); } }
/** Runs worker passes until `ready()` holds (at most `max`). */
async function until(h, ready, max = 12, message = 'the expected step did not happen') { for (let i = 0; i < max && !ready(); i++) await pass(h); assert.ok(ready(), message); }
const ops = (h, id, kind) => h.service.store().operationsFor(id, kind);
/** Quotes and funds a launch (SOL only); the funding receipt is final at `slot`. */
async function fund(h, quoteBody, { slot = 50, session = h.session, wallet = h.dev } = {}) {
  const quote = await h.service.quote(session, { ...quoteBody, wallet });
  const prepared = await h.service.prepareFunding(session, { launchId: quote.id });
  await h.service.submitFunding(session, { launchId: quote.id, operationId: prepared.operationId, signedTransaction: 'signed-by-wallet' });
  const fundingOp = ops(h, quote.id, 'funding').find(op => op.signature);
  h.world.deposits.set(fundingOp.signature, { state: 'finalized', signature: fundingOp.signature, slot, receivedAmount: prepared.amountLamports, receivedTokens: '0' });
  h.world.lamports.set(h.service.store().launch(quote.id).launch_wallet, BigInt(prepared.amountLamports));
  return { quote, prepared };
}
/**
 * Confirms each step of a funded launch as it appears (the pair purchase, the
 * setup, creation and the delivery) until the coin is live with its dev buy
 * delivered. `leftover` is the pair asset its launch wallet keeps after the dev
 * buy (null: its pair account is not visible).
 */
async function settleCreation(h, id, { output = null, leftover = 0n } = {}) {
  const store = h.service.store();
  for (let i = 0; i < 16; i++) {
    const launch = store.launch(id), key = launch.launch_wallet + ':' + launch.quote_mint;
    if (launch.state === 'created' && launch.delivery_state !== 'pending') return launch;
    for (const op of store.openOperations(id)) {
      if (h.world.receipts.has(op.signature)) continue;
      const spend = lamports => { const held = h.world.lamports.get(launch.launch_wallet); if (held !== undefined) h.world.lamports.set(launch.launch_wallet, held - lamports); };
      if (op.kind === 'acquire') { const out = output ?? BigInt(op.expected.op.expectedOutput); h.world.receipts.set(op.signature, { state: 'confirmed', slot: 52, outputAmount: String(out), actualSolCostLamports: '2100000' }); h.world.tokens.set(key, BigInt(out)); spend(BigInt(op.expected.op.inputAmount) + 2100000n); }
      else if (op.kind === 'setup') { h.world.receipts.set(op.signature, { state: 'confirmed', slot: 54, feeLamports: 5000n, spentLamports: 6100000n }); spend(6100000n); }
      else if (op.kind === 'launch') {
        h.world.receipts.set(op.signature, { state: 'confirmed', signature: op.signature, slot: 60, tokens: op.expected.op.expected.tokens, feeLamports: 24000n, failed: false });
        if (launch.quote_mint !== SOL) { if (leftover === null) h.world.tokens.delete(key); else h.world.tokens.set(key, BigInt(leftover)); }
        for (const t of launch.plan.transfers) h.world.lamports.set(t.to, BigInt(t.lamports));
        h.world.coins.set(launch.mint, { exists: true, slot: 70, venue: 'curve', curve: { complete: false }, mint: { supply: 1000000000000000n }, fees: { curve: 0n, amm: 0n, total: 0n }, poolBase: 0n, poolQuote: 0n });
      } else if (op.kind === 'deliver') h.world.receipts.set(op.signature, { state: 'confirmed', slot: 61, tokens: BigInt(op.expected.op.inputAmount), feeLamports: 5000n });
    }
    await pass(h);
  }
  throw Error('The launch did not finish creating.');
}
/** Quote, fund, create and deliver a coin; returns the stored launch. */
async function fundAndCreate(h, quoteBody, options) {
  const { quote, prepared } = await fund(h, quoteBody);
  await settleCreation(h, quote.id, options);
  await pass(h, 2);
  return { launch: h.service.store().launch(quote.id), prepared, quote };
}

test('the live pair list: every Pump.fun pair with Launchpad’s support, display identity and limits (cached)', async () => {
  const h = harness();
  try {
    await openFlags(h);
    const result = await h.service.pairs();
    assert.equal(result.available, true); assert.equal(result.stale, false);
    assert.deepEqual(result.solOnlyModes, ['agent', 'market_maker', 'lp_manager', 'earned', 'insured']); assert.deepEqual(result.convertModes, ['holders', 'gotchi', 'diamond_hands']);
    const by = Object.fromEntries(result.pairs.map(p => [p.mint, p]));
    assert.equal(result.pairs[0].mint, SOL); assert.equal(by[SOL].maxDevBuy, '25');
    assert.deepEqual([by[USDC].symbol, by[USDC].name, by[USDC].category, by[USDC].decimals, by[USDC].kind, by[USDC].launchReady, by[USDC].convertible, by[USDC].maxDevBuy, by[USDC].creatorFee], ['USDC', 'USD Coin', 'crypto', 6, 'listed', true, true, '3750', null], 'a listed pair: verified identity, a SOL-equivalent dev-buy cap, no custom fee');
    assert.deepEqual([by[XSTOCK].symbol, by[XSTOCK].category, by[XSTOCK].creatorFee, by[XSTOCK].maxDevBuy], ['EXMx', 'custom', { maxBps: 500 }, '1000'], 'a custom pair named by its own metadata, with Pump’s creator-fee limit');
    assert.deepEqual([by[USDC].devBuyIn, by[USDC].maxDevBuySol, by[USDC].devBuyAvailable, by[XSTOCK].devBuyAvailable], ['SOL', '25', true, true], 'dev buys on other pairs are entered and paid in SOL');
    assert.equal(by[ODD].convertible, false); assert.equal(by[ODD].launchReady, true); assert.equal(by[ODD].devBuyAvailable, false, 'Launchpad cannot buy a pair it cannot route, so no dev buy there');
    assert.equal(by[HOOKED].launchReady, false); assert.match(by[HOOKED].supportReason, /transfer hook/);
    await h.service.pairs(); assert.equal(h.world.pairReads, 1, 'the list is cached');
    h.advance(300001); h.world.pairsDown = true;
    const stale = await h.service.pairs();
    assert.ok(stale.pairs.length >= 1 && stale.pairs[0].mint === SOL);
  } finally { await h.cleanup(); }
});

test('pairs other than SOL stay closed until the pairs flag is on; the platform owner can preview them', async () => {
  const h = harness();
  try {
    await openFlags(h, { intake: true });
    const closed = await h.service.pairs(null);
    assert.deepEqual([closed.pairsOpen, closed.ownerPreview, closed.pairs.map(p => p.mint)], [false, false, [SOL]]); assert.match(closed.notice, /not open/);
    assert.equal(h.world.pairReads || 0, 0, 'nothing is read onchain for a closed list');
    await assert.rejects(h.service.quote(h.session, { ...body({ quoteMint: USDC, devBuySol: '1' }), wallet: h.dev }), /not open on this site yet/);
    const ownerWallet = generateWallet().address, owner = { account: { id: 'owner', role: 'admin', mainWallet: ownerWallet }, walletVerified: true, walletAddress: ownerWallet };
    const preview = await h.service.pairs(owner);
    assert.deepEqual([preview.pairsOpen, preview.ownerPreview], [false, true]); assert.ok(preview.pairs.some(p => p.mint === USDC)); assert.match(preview.notice, /Owner preview/);
    const ownQuote = await h.service.quote(owner, { ...body({ quoteMint: USDC, devBuySol: '1' }), wallet: ownerWallet });
    assert.equal(ownQuote.pair.symbol, 'USDC', 'the owner can launch on a pair while it is closed to the public');
    const ownFunding = await h.service.prepareFunding(owner, { launchId: ownQuote.id });
    assert.deepEqual([ownFunding.pairSymbol, ownFunding.pairAmountRaw], ['USDC', '0'], 'funded in SOL only');
    // A public quote made while pairs were open cannot be funded after they close.
    h.service.store().setFlag('pairs', true, { reason: 'test' });
    const publicQuote = await h.service.quote(h.session, { ...body({ quoteMint: USDC, devBuySol: '1' }), wallet: h.dev });
    h.service.store().setFlag('pairs', false, { reason: 'test' });
    await assert.rejects(h.service.prepareFunding(h.session, { launchId: publicQuote.id }), /closed right now/);
    assert.equal((await h.service.quote(h.session, { ...body({ devBuySol: '0.1' }), wallet: h.dev })).pair.symbol, 'SOL', 'SOL launches are unaffected');
    const admin = await h.service.adminOverview('admin');
    assert.equal(admin.flags.pairs, false); assert.match(admin.flagLabels.pairs, /pairs other than SOL/);
  } finally { await h.cleanup(); }
});

test('quotes on other pairs: SOL-only options, convertible pairs, creator fees and the SOL dev buy with its pair limit are enforced', async () => {
  const h = harness();
  try {
    await openFlags(h);
    const q = overrides => h.service.quote(h.session, { ...body(overrides), wallet: h.dev });
    for (const mode of ['agent', 'market_maker', 'lp_manager', 'earned', 'insured']) await assert.rejects(q({ mode, quoteMint: USDC }), /SOL only/, mode);
    await assert.rejects(q({ mode: 'holders', quoteMint: ODD }), /cannot convert this pair’s fees to SOL yet/);
    await assert.rejects(q({ mode: 'gotchi', gotchiId: 'fomogotchi', quoteMint: ODD }), /cannot convert/);
    await assert.rejects(q({ quoteMint: HOOKED }), /transfer hook/);
    await assert.rejects(q({ quoteMint: generateWallet().address }), /no longer accepts/);
    await assert.rejects(q({ quoteMint: USDC, creatorFeeBps: 50 }), /only available on Pump\.fun custom pairs/);
    await assert.rejects(q({ quoteMint: XSTOCK, creatorFeeBps: 600 }), /at most 5%/);
    await assert.rejects(q({ quoteMint: XSTOCK, creatorFeeBps: 12.5 }), /valid creator fee/);
    await assert.rejects(q({ creatorFeeBps: 100 }), /custom pairs/, 'SOL coins keep Pump’s standard creator fee');
    // The dev buy on another pair is entered and paid in SOL.
    await assert.rejects(q({ quoteMint: USDC, devBuyAmount: '1' }), /Enter the dev buy in SOL/);
    await assert.rejects(q({ quoteMint: USDC, devBuySol: '1.0000000001' }), /up to 9 decimals/);
    await assert.rejects(q({ quoteMint: USDC, devBuySol: '25.000000001' }), /launch limit/);
    await assert.rejects(q({ quoteMint: ODD, devBuySol: '0.1' }), /cannot buy this pair’s asset with SOL/);
    h.world.rates[USDC] = [200000000n, 1000000000n];
    await assert.rejects(q({ quoteMint: USDC, devBuySol: '25' }), /pair’s launch limit\. Use at most about 18\.75 SOL/, 'the pair-unit cap still applies to what the SOL buys');
    h.world.rates = RATES();
    h.world.routeError = Object.assign(Error('No route.'), { code: 'SOL_ROUTE_NOT_FOUND' });
    await assert.rejects(q({ quoteMint: USDC, devBuySol: '1' }), /No fair SOL route/);
    h.world.routeError = Object.assign(Error('Price impact.'), { code: 'TREASURY_PRICE_IMPACT' });
    await assert.rejects(q({ quoteMint: USDC, devBuySol: '1' }), /No fair SOL route/);
    h.world.routeError = Object.assign(Error('Jupiter timed out.'), { code: 'SOL_ROUTE_TIMEOUT' });
    await assert.rejects(q({ quoteMint: USDC, devBuySol: '1' }), /could not reach its swap route/);
    h.world.routeError = null;
    h.world.creatorFee = { configurable: false, maxBps: 0 };
    await assert.rejects(q({ quoteMint: XSTOCK, creatorFeeBps: 100 }), /at most 0%/);
    h.world.creatorFee = { configurable: true, maxBps: 500 };
    const creator = await q({ quoteMint: ODD, devBuyAmount: '0' });
    assert.equal(creator.pair.symbol, 'ODD', 'a Creator launch without a dev buy works on a pair Launchpad cannot convert yet');
    const custom = await q({ mode: 'holders', quoteMint: XSTOCK, devBuySol: '12.5', creatorFeeBps: 250 });
    assert.deepEqual([custom.pair.mint, custom.pair.symbol, custom.pair.decimals, custom.pair.kind, custom.creatorFeeBps], [XSTOCK, 'EXMx', 8, 'custom', 250]);
    const { taker, ...route } = h.world.conversionQuote;
    assert.deepEqual(route, { quoteMint: XSTOCK, program: T22, lamports: 12500000000n, slippageBps: 200, maxImpactBps: 200 });
    assert.ok(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(taker) && taker !== h.dev, 'priced for a fresh wallet, never the creator’s own token accounts');
    // 12.5 SOL buys about 10 EXMx; the route guarantees 9.8 (2% slippage) and the reviewed minimum allows 5% more for the price to move before the purchase.
    assert.deepEqual([custom.quote.devBuySol, custom.quote.devBuyPaidIn, custom.quote.devBuy, custom.quote.devBuyRaw, custom.quote.devBuySymbol, custom.quote.pairAmountRaw, custom.quote.pairExpected, custom.quote.pairMinimum, custom.quote.pairBought],
      ['12.5', 'SOL', '9.31', '931000000', 'EXMx', '0', '10', '9.31', null]);
    const reviewedTokens = tokensFor(120000000000n, 931000000n);
    assert.equal(custom.quote.minimumTokens, (reviewedTokens - reviewedTokens * 10000n / 1000000n).toString(), 'the least creation accepts: the reviewed tokens less the 1% tolerance');
    assert.equal(custom.quote.expectedTokens, tokensFor(120000000000n, 1000000000n).toString());
    assert.equal(custom.quote.totalLamports, '12560000000', 'all in SOL: the dev buy, setup, the purchase budget (v4: 0.01 SOL) and reserves');
    assert.deepEqual([custom.quote.setupBudgetSol, custom.quote.conversionBudgetSol, custom.quote.operatingReserveSol, custom.quote.estimatedSetupSol], ['0.035', '0.01', '0.015', '0.024']);
    assert.ok(custom.disclosure.some(line => /You fund everything in SOL/.test(line)), 'the disclosure says the dev buy is paid in SOL');
    assert.ok(!custom.disclosure.some(line => /paid in EXMx from your wallet/.test(line)));
    assert.ok(custom.disclosure.some(line => /You chose this coin’s creator fee/.test(line)) && custom.disclosure.some(line => /arrive in EXMx/.test(line)));
    const row = h.service.store().launch(custom.id);
    assert.deepEqual([row.quote_mint, row.quote_program, row.quote_decimals, row.quote_kind, row.quote_control, row.creator_fee_bps, row.dev_buy_raw, row.dev_buy_lamports, row.quote_reserves, row.sol_reserves, row.policy_version], [XSTOCK, T22, 8, 'custom', 1, 250, '931000000', '12500000000', '120000000000', '30000000000', PUMP_CLASSIC_POLICY.version]);
    assert.deepEqual(row.quote.conversion, { inputLamports: '12500000000', expectedRaw: '1000000000', minimumRaw: '931000000', routeMinimumRaw: '980000000', slot: 12 });
    assert.ok(!JSON.stringify(custom).includes('secret'));
  } finally { await h.cleanup(); }
});

test('a USDC launch paid only in SOL: the USDC is bought, the pair accounts are set up, the coin is created and delivered, then the leftovers are refunded', async () => {
  const h = harness();
  try {
    await openFlags(h);
    const store = h.service.store();
    const { quote, prepared } = await fund(h, body({ quoteMint: USDC, devBuySol: '0.5' }));
    assert.equal(quote.quote.totalLamports, '552000000');
    assert.deepEqual([quote.quote.devBuySol, quote.quote.devBuyPaidIn, quote.quote.pairExpected, quote.quote.pairMinimum, quote.quote.pairAmountRaw], ['0.5', 'SOL', '75', '69.825', '0'], 'v4: 2% slippage, then 5% for the price to move');
    assert.deepEqual([prepared.amountLamports, prepared.pairAmountRaw, prepared.pairSymbol], ['552000000', '0', 'USDC']);
    assert.ok(h.world.calls.includes('prepareDeposit') && !h.world.calls.includes('prepareQuoteDeposit'), 'the creator funds SOL only');
    // The funding is final: the launch wallet buys the USDC with exactly the dev-buy SOL.
    await until(h, () => ops(h, quote.id, 'acquire').length > 0);
    let launch = store.launch(quote.id);
    assert.deepEqual([launch.state, launch.funded_lamports, launch.funded_quote], ['funded', '552000000', '0']);
    const purchase = ops(h, quote.id, 'acquire')[0];
    assert.deepEqual([purchase.wallet, purchase.expected.op.inputAmount, purchase.expected.op.mint, purchase.expected.op.minimumOutput], [launch.launch_wallet, '500000000', USDC, '73500000']);
    assert.deepEqual([h.world.acquire.minSolReserve, h.world.acquire.maxNetworkCostLamports, h.world.acquire.slippageBps, h.world.acquire.maxImpactBps], [42000000n, 10000000n, 200, 200], 'the rest of the funding stays as a protected reserve');
    await pass(h, 2);
    assert.equal(ops(h, quote.id, 'setup').length, 0, 'nothing else happens until the purchase is final');
    h.world.receipts.set(purchase.signature, { state: 'confirmed', slot: 52, outputAmount: '74800000', actualSolCostLamports: '2100000' });
    h.world.tokens.set(launch.launch_wallet + ':' + USDC, 74800000n);
    await pass(h);
    // In one pass: the purchase settles and the setup transaction is sent.
    launch = store.launch(quote.id);
    assert.equal(launch.funded_quote, '74800000'); assert.deepEqual(launch.quote.conversion.receipt, { inputLamports: '500000000', outputRaw: '74800000', costLamports: '2100000', signature: purchase.signature, slot: 52 });
    assert.equal(ops(h, quote.id, 'setup').length, 1, 'the setup follows in the same pass');
    const setupPlan = h.world.setupPlans.at(-1);
    assert.deepEqual([setupPlan.readySlot, setupPlan.devBuyRaw, setupPlan.pairAccounts, setupPlan.delivery], [52, '74800000', 'ready', 'separate'], 'setup reads happen at or after the purchase');
    assert.equal(ops(h, quote.id, 'launch').length, 0, 'creation waits for the setup');
    const setup = ops(h, quote.id, 'setup')[0];
    h.world.receipts.set(setup.signature, { state: 'confirmed', slot: 54, feeLamports: 5000n, spentLamports: 6100000n });
    await pass(h);
    // In one pass: the setup settles and creation is sent with everything the purchase bought.
    const plan = h.world.plans.at(-1);
    assert.deepEqual([plan.quote.mint, plan.devBuyRaw, plan.fundedQuoteRaw, plan.buyAll, plan.pairAccounts, plan.delivery, plan.readySlot, plan.fundedLamports], [USDC, '74800000', '74800000', true, 'ready', 'separate', 54, String(552000000n - 500000000n - 2100000n - 6100000n)], 'the launch wallet must still hold its funding less the purchase and the setup');
    assert.equal(store.launch(quote.id).state, 'creating');
    assert.equal(store.balance(quote.id, 'launch').costs, 2100000n + 6100000n, 'the purchase and setup costs are recorded');
    const op = ops(h, quote.id, 'launch')[0];
    assert.equal(op.expected.op.expected.tokens, tokensFor(4500000000n, 74800000n).toString());
    h.world.receipts.set(op.signature, { state: 'confirmed', signature: op.signature, slot: 60, tokens: op.expected.op.expected.tokens, feeLamports: 24000n, failed: false });
    h.world.tokens.set(launch.launch_wallet + ':' + USDC, 1000n); h.world.lamports.set(launch.launch_wallet, 30000000n);
    await pass(h);
    // Created; the dev-buy tokens wait in the launch wallet for their own delivery transaction.
    launch = store.launch(quote.id);
    assert.deepEqual([launch.state, launch.delivery_state, launch.dev_tokens], ['created', 'pending', op.expected.op.expected.tokens]);
    const delivery = ops(h, quote.id, 'deliver')[0];
    assert.deepEqual([delivery.wallet, delivery.expected.op.recipient, delivery.expected.op.inputAmount], [launch.launch_wallet, h.dev, launch.dev_tokens]);
    assert.equal(h.world.deliveryPlan.createdSlot, 60, 'delivery reads happen at or after the creation');
    await pass(h, 2);
    assert.equal(ops(h, quote.id, 'quote-refund').length + ops(h, quote.id, 'withdraw').length, 0, 'refunds wait for the delivery the launch wallet pays for');
    h.world.receipts.set(delivery.signature, { state: 'confirmed', slot: 61, tokens: BigInt(launch.dev_tokens), feeLamports: 5000n });
    await until(h, () => ops(h, quote.id, 'quote-refund').length > 0);
    launch = store.launch(quote.id);
    assert.equal(launch.delivery_state, 'complete'); assert.ok(store.events(quote.id, { publicOnly: false }).some(e => e.title === 'Dev-buy tokens delivered'));
    assert.equal(ops(h, quote.id, 'withdraw').length, 0, 'the SOL refund waits for the USDC refund');
    const pairRefund = ops(h, quote.id, 'quote-refund')[0];
    assert.deepEqual([pairRefund.expected.op.recipient, pairRefund.expected.op.inputAmount, h.world.refundDecimals, h.world.refundSlot], [h.dev, '1000', 6, 61], 'read at or after the newest settled transaction (the delivery)');
    h.world.receipts.set(pairRefund.signature, { state: 'confirmed', signature: pairRefund.signature, slot: 62, feeLamports: 5000n, refunded: 1000n });
    await until(h, () => ops(h, quote.id, 'withdraw').some(o => o.expected.purpose === 'refund'));
    launch = store.launch(quote.id);
    assert.equal(launch.quote_refund_state, 'complete'); assert.equal(launch.refunded_quote, '1000');
    const solRefund = ops(h, quote.id, 'withdraw').find(o => o.expected.purpose === 'refund');
    assert.equal(solRefund.expected.op.recipient, h.dev);
    h.world.receipts.set(solRefund.signature, { state: 'confirmed', actualSolCostLamports: '5000' });
    await until(h, () => store.launch(quote.id).refund_state === 'complete');
    const view = await h.service.ownLaunch(h.session, { launchId: quote.id });
    assert.deepEqual([view.refundedPair, view.pair.symbol, view.quote.pairBought, view.quote.devBuy, view.quote.devBuyPaidIn], ['0.001', 'USDC', '74.8', '74.8', 'SOL']);
    assert.equal(h.world.setupQuote, USDC, 'the fee setup is verified on the coin’s pair');
    const titles = store.events(quote.id, { publicOnly: false }).map(e => e.title);
    for (const title of ['Bought USDC for your dev buy', 'Pair accounts created', 'Live on Pump.fun']) assert.ok(titles.includes(title), title);
  } finally { await h.cleanup(); }
});

test('a pair purchase is only sent while it guarantees the reviewed minimum; after four failed tries the SOL is refunded and nothing is converted', async () => {
  const h = harness();
  try {
    await openFlags(h);
    const store = h.service.store();
    const { quote } = await fund(h, body({ quoteMint: USDC, devBuySol: '1' }));
    const launchWallet = store.launch(quote.id).launch_wallet;
    h.world.lamports.set(launchWallet, 1047000000n);
    assert.equal(store.launch(quote.id).dev_buy_raw, '139650000', 'reviewed: 150 USDC less 2% slippage, less 5% for the price to move');
    // USDC got 5.3% more expensive: the route now guarantees 139.16 USDC, below the reviewed 139.65. Nothing is sent.
    h.world.purchaseRates = { [USDC]: [142000000n, 1000000000n] };
    await pass(h, 3);
    assert.equal(ops(h, quote.id, 'acquire').length, 0, 'a purchase below the reviewed minimum is never journaled or sent');
    let launch = store.launch(quote.id);
    assert.equal(launch.state, 'funded'); assert.equal(launch.quote.conversion.prepareFailures, 1);
    assert.ok(store.events(quote.id, { publicOnly: false }).some(e => e.title === 'Buying USDC for the dev buy is waiting' && /cannot guarantee the reviewed 139\.65 USDC/.test(e.body)));
    assert.match(launch.state_reason, /could not buy USDC for your dev buy yet \(1 of 4 tries\)\. USDC costs more SOL than when you reviewed the launch\./, 'the creator sees why it waits');
    // Within the wider allowance (4% more expensive) the purchase goes ahead; this one fails onchain.
    h.world.purchaseRates = { [USDC]: [144000000n, 1000000000n] }; h.advance(60000);
    await until(h, () => ops(h, quote.id, 'acquire').length === 1);
    h.world.receipts.set(ops(h, quote.id, 'acquire')[0].signature, { state: 'failed', actualSolCostLamports: '7000' });
    await until(h, () => ops(h, quote.id, 'acquire').length === 2, 20);
    assert.equal(ops(h, quote.id, 'acquire')[0].state, 'failed'); assert.equal(store.balance(quote.id, 'launch').costs, 7000n);
    h.world.receipts.set(ops(h, quote.id, 'acquire')[1].signature, { state: 'failed', actualSolCostLamports: '7000' });
    h.world.purchaseRates = { [USDC]: [140000000n, 1000000000n] };
    for (let i = 0; i < 12 && store.launch(quote.id).state === 'funded'; i++) { await pass(h); h.advance(600000); }
    launch = store.launch(quote.id);
    assert.equal(launch.state, 'failed'); assert.match(launch.state_reason, /could not buy USDC for your dev buy within its price limits\. Your SOL is being refunded; nothing was converted/);
    assert.equal(launch.funded_quote, '0'); assert.equal(ops(h, quote.id, 'acquire').length, 2);
    // Nothing was bought, so there is nothing to sell back: the USDC step is skipped and the SOL is refunded.
    await until(h, () => ops(h, quote.id, 'withdraw').some(o => o.expected.purpose === 'refund'), 20);
    launch = store.launch(quote.id);
    assert.equal(launch.quote_refund_state, 'not_needed'); assert.equal(ops(h, quote.id, 'unwind').length, 0);
    const refund = ops(h, quote.id, 'withdraw').at(-1);
    assert.deepEqual([refund.expected.op.recipient, refund.expected.op.inputAmount], [h.dev, String(1047000000n - 5000n)]);
  } finally { await h.cleanup(); }
});

test('a SOL-paid launch that fails after the purchase sells the pair asset back to SOL before the refunds', async () => {
  const h = harness();
  try {
    await openFlags(h);
    const store = h.service.store();
    const { quote, prepared } = await fund(h, body({ mode: 'holders', quoteMint: USDC, devBuySol: '0.2' }));
    assert.equal(prepared.amountLamports, String(200000000n + 35000000n + 10000000n + 7000000n + 8000000n));
    await until(h, () => ops(h, quote.id, 'acquire').length > 0);
    const launchWallet = store.launch(quote.id).launch_wallet;
    h.world.receipts.set(ops(h, quote.id, 'acquire')[0].signature, { state: 'confirmed', slot: 52, outputAmount: '29900000', actualSolCostLamports: '2100000' });
    h.world.tokens.set(launchWallet + ':' + USDC, 29900000n);
    await until(h, () => ops(h, quote.id, 'setup').length > 0);
    // An admin refund waits while a launch transaction is in flight.
    await assert.rejects(h.service.adminControl('admin', { launchId: quote.id, action: 'refund', reason: 'Testing the guard' }), /still being checked/);
    h.world.receipts.set(ops(h, quote.id, 'setup')[0].signature, { state: 'confirmed', slot: 54, feeLamports: 5000n, spentLamports: 6100000n });
    // Then Pump stops admitting the pair: creation fails its checks and the launch is refunded.
    h.world.delisted = USDC; h.world.failPrepare = Object.assign(Error('Pump.fun no longer accepts this quote asset for new coins.'), { code: 'PUMP_CLASSIC_QUOTE_ASSET' });
    for (let i = 0; i < 6 && store.launch(quote.id).state !== 'failed'; i++) { await pass(h); h.advance(3600000); }
    let launch = store.launch(quote.id);
    assert.equal(launch.state, 'failed'); assert.match(launch.state_reason, /Creation did not succeed/);
    // The USDC bought for the dev buy is sold back to SOL first, under the same limits and with a priority fee.
    await until(h, () => ops(h, quote.id, 'unwind').length > 0);
    const sale = ops(h, quote.id, 'unwind')[0];
    assert.deepEqual([sale.wallet, sale.expected.op.inputAmount, sale.expected.op.mint], [launchWallet, '29900000', USDC]);
    assert.deepEqual([h.world.conversionArgs.wallet, h.world.conversionArgs.guard.slippageBps, h.world.conversionArgs.guard.maxImpactBps, h.world.conversionArgs.priority], [launchWallet, 200, 200, true]);
    assert.equal(h.world.balanceSlot, 54, 'the USDC balance is read at or after the newest settled transaction');
    assert.equal(ops(h, quote.id, 'quote-refund').length + ops(h, quote.id, 'withdraw').length, 0, 'the refunds wait for the sale');
    h.world.receipts.set(sale.signature, { state: 'confirmed', slot: 70, outputAmount: '198000000', actualSolCostLamports: '9000' });
    h.world.tokens.set(launchWallet + ':' + USDC, 0n); h.world.lamports.set(launchWallet, 250000000n);
    await until(h, () => ops(h, quote.id, 'quote-refund').length > 0);
    assert.equal(h.world.refundSlot, 70, 'the pair account is read at or after the sale');
    const close = ops(h, quote.id, 'quote-refund')[0];
    assert.equal(close.expected.op.inputAmount, '0', 'only the empty USDC account is closed');
    h.world.receipts.set(close.signature, { state: 'confirmed', feeLamports: 5000n, refunded: 0n });
    await until(h, () => ops(h, quote.id, 'withdraw').some(o => o.expected.purpose === 'refund'));
    const refund = ops(h, quote.id, 'withdraw').at(-1);
    assert.equal(refund.expected.op.inputAmount, String(250000000n - 5000n));
    h.world.receipts.set(refund.signature, { state: 'confirmed', actualSolCostLamports: '5000' });
    await until(h, () => store.launch(quote.id).state === 'refunded');
    launch = store.launch(quote.id);
    assert.deepEqual([launch.refunded_quote, launch.quote.conversion.unwind.state, launch.quote.conversion.unwind.outputLamports], ['0', 'sold', '198000000']);
    const view = await h.service.ownLaunch(h.session, { launchId: quote.id });
    assert.deepEqual([view.quote.pairBought, view.quote.pairSoldForSol, view.refundedPair], ['29.9', '0.198', '0']);
    assert.ok(store.events(quote.id).some(e => e.title === 'Sold the USDC back to SOL'), 'the creator sees the sale');
    await assert.rejects(h.service.quote(h.session, { ...body({ quoteMint: USDC, devBuySol: '0' }), wallet: h.dev }), /no longer accepts/, 'a delisted pair takes no new quotes');
  } finally { await h.cleanup(); }
});

test('a pair asset that cannot be sold back is returned as is; a launch that never bought one skips the pair step', async () => {
  const h = harness();
  try {
    await openFlags(h);
    const store = h.service.store();
    const { quote } = await fund(h, body({ quoteMint: USDC, devBuySol: '0.2' }));
    await until(h, () => ops(h, quote.id, 'acquire').length > 0);
    const launchWallet = store.launch(quote.id).launch_wallet;
    h.world.receipts.set(ops(h, quote.id, 'acquire')[0].signature, { state: 'confirmed', slot: 52, outputAmount: '29900000', actualSolCostLamports: '2100000' });
    h.world.tokens.set(launchWallet + ':' + USDC, 29900000n); h.world.lamports.set(launchWallet, 40000000n);
    // No route back to SOL from here on.
    h.world.noRoute = true;
    // The pair accounts cannot be created (three failed setups onchain): the launch is refunded.
    for (let i = 0; i < 12 && store.launch(quote.id).state === 'funded'; i++) {
      const open = ops(h, quote.id, 'setup').find(op => !h.world.receipts.has(op.signature));
      if (open) h.world.receipts.set(open.signature, { state: 'failed', feeLamports: 5000n });
      await pass(h);
    }
    let launch = store.launch(quote.id);
    assert.equal(launch.state, 'failed'); assert.match(launch.state_reason, /pair accounts for this launch could not be created/); assert.equal(ops(h, quote.id, 'setup').length, 3);
    // After three tries to sell it back, the USDC is returned with the unused SOL.
    for (let i = 0; i < 12 && store.launch(quote.id).quote?.conversion?.unwind?.state !== 'returned'; i++) { await pass(h); h.advance(700000); }
    launch = store.launch(quote.id);
    assert.deepEqual([launch.quote.conversion.unwind.state, launch.quote.conversion.unwind.prepareFailures, ops(h, quote.id, 'unwind').length], ['returned', 3, 0]);
    assert.ok(store.events(quote.id).some(e => e.title === 'Returning the USDC as is'));
    await until(h, () => ops(h, quote.id, 'quote-refund').length > 0);
    assert.equal(ops(h, quote.id, 'quote-refund')[0].expected.op.inputAmount, '29900000', 'the whole purchase goes back to the creator');
    // No pair account at all (never bought, never created): the pair step is marked not needed.
    h.world.noRoute = false;
    const solOnly = await h.service.quote(h.session, { ...body({ quoteMint: USDC, devBuySol: '0' }), wallet: h.dev });
    h.service.failLaunch({ ...store.launch(solOnly.id), state: 'awaiting_funding' }, 'awaiting_funding', 'Test');
    h.world.lamports.set(store.launch(solOnly.id).launch_wallet, 0n);
    await pass(h); assert.equal(store.launch(solOnly.id).quote_refund_state, 'not_needed');
    assert.equal(ops(h, solOnly.id, 'unwind').length, 0);
  } finally { await h.cleanup(); }
});

test('a pair account that is not visible never skips the pair refund; an operator can release the SOL refund and the pair refund still finishes', async () => {
  const h = harness();
  try {
    await openFlags(h);
    const store = h.service.store();
    // A created USDC coin whose launch-wallet pair account is not visible (a lagging node): never marked "not needed".
    const { quote } = await fund(h, body({ quoteMint: USDC, devBuySol: '0.3' }), { slot: 55 });
    let launch = await settleCreation(h, quote.id, { leftover: null });
    h.world.lamports.set(launch.launch_wallet, 30000000n);
    await pass(h);
    launch = store.launch(quote.id);
    assert.equal(launch.state, 'created'); assert.equal(launch.quote_refund_state, 'pending', 'a created coin always opened its pair account');
    assert.equal(h.world.refundSlot, 61, 'the pair account is read at or after the newest settled transaction');
    assert.ok(store.events(launch.id, { publicOnly: false }).some(e => /pair account is not visible/.test(e.title)));
    assert.equal(ops(h, quote.id, 'withdraw').length, 0, 'the SOL refund waits');
    // The pair asset cannot move (for example a frozen account): the operator releases the SOL refund.
    h.world.tokens.set(launch.launch_wallet + ':' + USDC, 1000n); h.world.pairStuck = true;
    h.advance(3600000); await pass(h);
    assert.ok(store.events(launch.id, { publicOnly: false }).some(e => e.title === 'The pair refund is waiting'));
    await assert.rejects(h.service.adminControl('admin', { launchId: launch.id, action: 'release-sol-refund', reason: 'x' }), /reason/);
    await h.service.adminControl('admin', { launchId: launch.id, action: 'release-sol-refund', reason: 'Issuer froze the account' });
    assert.equal(store.launch(launch.id).quote_refund_state, 'released');
    await assert.rejects(h.service.adminControl('admin', { launchId: launch.id, action: 'release-sol-refund', reason: 'Twice is refused' }), /still pending/);
    h.advance(3600000); await pass(h);
    const first = ops(h, quote.id, 'withdraw').find(o => o.expected.purpose === 'refund');
    assert.equal(h.world.drainKeep, 3000000n, 'a reserve stays for the pair refund'); assert.equal(first.expected.op.inputAmount, String(30000000n - 5000n - 3000000n));
    h.world.receipts.set(first.signature, { state: 'confirmed', actualSolCostLamports: '5000' });
    h.world.lamports.set(launch.launch_wallet, 3000000n);
    await pass(h);
    launch = store.launch(quote.id);
    assert.equal(launch.refund_state, 'complete'); assert.equal(launch.quote_refund_state, 'released');
    // Later the pair asset moves again: the pair refund finishes, then the reserve is refunded too.
    h.world.pairStuck = false; h.advance(3600000); await pass(h);
    const pairRefund = ops(h, quote.id, 'quote-refund').at(-1); assert.ok(pairRefund);
    h.world.receipts.set(pairRefund.signature, { state: 'confirmed', feeLamports: 5000n, refunded: 1000n });
    h.world.lamports.set(launch.launch_wallet, 3000000n + 2039280n - 5000n);
    await pass(h); await pass(h);
    launch = store.launch(quote.id);
    assert.equal(launch.quote_refund_state, 'complete'); assert.equal(launch.refund_state, 'pending');
    const last = ops(h, quote.id, 'withdraw').filter(o => o.expected.purpose === 'refund').at(-1);
    assert.notEqual(last.id, first.id); assert.equal(h.world.drainKeep, 0n, 'the final drain closes the wallet');
    h.world.receipts.set(last.signature, { state: 'confirmed', actualSolCostLamports: '5000' });
    await pass(h);
    launch = store.launch(quote.id);
    assert.equal(launch.refund_state, 'complete'); assert.equal(launch.refunded_lamports, String(30000000n - 5000n - 3000000n + BigInt(last.expected.op.inputAmount)), 'both SOL refunds are counted');
    assert.equal(launch.refunded_quote, '1000');
  } finally { await h.cleanup(); }
});

test('a delivery that fails onchain is prepared again; refunds wait until the tokens are delivered', async () => {
  const h = harness();
  try {
    await openFlags(h);
    const store = h.service.store();
    const { quote } = await fund(h, body({ quoteMint: USDC, devBuySol: '0.1' }));
    for (let i = 0; i < 12 && store.launch(quote.id).state !== 'created'; i++) {
      for (const op of store.openOperations(quote.id)) {
        if (h.world.receipts.has(op.signature)) continue;
        if (op.kind === 'acquire') { h.world.receipts.set(op.signature, { state: 'confirmed', slot: 52, outputAmount: op.expected.op.expectedOutput, actualSolCostLamports: '2100000' }); h.world.tokens.set(store.launch(quote.id).launch_wallet + ':' + USDC, BigInt(op.expected.op.expectedOutput)); }
        if (op.kind === 'setup') h.world.receipts.set(op.signature, { state: 'confirmed', slot: 54, feeLamports: 5000n });
        if (op.kind === 'launch') h.world.receipts.set(op.signature, { state: 'confirmed', signature: op.signature, slot: 60, tokens: op.expected.op.expected.tokens, feeLamports: 24000n, failed: false });
      }
      await pass(h);
    }
    const launch = store.launch(quote.id);
    h.world.tokens.set(launch.launch_wallet + ':' + USDC, 0n); h.world.lamports.set(launch.launch_wallet, 20000000n);
    assert.equal(launch.delivery_state, 'pending');
    const first = ops(h, quote.id, 'deliver')[0];
    h.world.receipts.set(first.signature, { state: 'failed', feeLamports: 5000n });
    await until(h, () => ops(h, quote.id, 'deliver').length === 2, 20);
    assert.equal(ops(h, quote.id, 'deliver')[0].state, 'failed'); assert.equal(store.launch(quote.id).delivery_state, 'pending');
    assert.equal(ops(h, quote.id, 'quote-refund').length + ops(h, quote.id, 'withdraw').length, 0, 'nothing is refunded before the delivery');
    // A delivery that cannot be prepared waits and alerts; the tokens stay in the launch wallet.
    h.world.receipts.set(ops(h, quote.id, 'deliver')[1].signature, { state: 'failed', feeLamports: 5000n });
    h.world.failDelivery = Object.assign(Error('The launch wallet’s dev-buy token account is not visible yet.'), { code: 'PUMP_CLASSIC_PENDING' });
    await pass(h, 3);
    assert.ok(store.events(quote.id, { publicOnly: false }).some(e => e.title === 'Dev-buy delivery is waiting'));
    h.world.failDelivery = null; h.advance(120000);
    await until(h, () => ops(h, quote.id, 'deliver').length === 3, 20);
    const third = ops(h, quote.id, 'deliver')[2];
    h.world.receipts.set(third.signature, { state: 'confirmed', slot: 64, tokens: BigInt(launch.dev_tokens), feeLamports: 5000n });
    await until(h, () => ops(h, quote.id, 'quote-refund').length > 0);
    assert.equal(store.launch(quote.id).delivery_state, 'complete');
    assert.equal(store.balance(quote.id, 'launch').costs >= 2100000n + 5000n * 3n, true, 'failed deliveries cost their fees');
  } finally { await h.cleanup(); }
});

test('pair-asset receipts stay in their own ledger until a verified conversion credits SOL; routing and reports follow', async () => {
  const h = harness();
  try {
    await openFlags(h, { intake: true, pairs: true, collection: true, routing: true });
    h.world.treasury = generateWallet().address;
    const { launch } = await fundAndCreate(h, body({ mode: 'gotchi', gotchiId: 'fomogotchi', quoteMint: XSTOCK, devBuySol: '0.5' }));
    const store = h.service.store();
    assert.equal(launch.fee_state, 'verified'); assert.equal(h.world.readQuote, XSTOCK); assert.equal(launch.delivery_state, 'complete');
    // Collection: the threshold is scaled into the pair's units (0.02 SOL × 120e9/30e9 = 80,000,000 raw).
    h.world.coins.get(launch.mint).fees = { curve: 79999999n, amm: 0n, total: 79999999n };
    h.advance(PUMP_CLASSIC_POLICY.collection.intervalMs); await pass(h);
    assert.ok(!h.world.calls.includes('prepareDistribution'), 'below the scaled threshold nothing is cranked');
    h.world.coins.get(launch.mint).fees = { curve: 1000000000n, amm: 0n, total: 1000000000n };
    h.advance(PUMP_CLASSIC_POLICY.collection.intervalMs); await pass(h);
    assert.equal(h.world.distributionQuote, XSTOCK);
    const crank = store.operationsFor(launch.id, 'distribute').at(-1), dist = signature();
    h.world.distributions.set(crank.signature, { signature: crank.signature, slot: 79, blockTime: 1, failed: false, payer: launch.protocol_wallet, feeLamports: 5000n, payerLamportDelta: -(5000n + 2n * 2039280n), legs: [], anomalies: [] });
    h.advance(20000); await pass(h);
    assert.equal(store.balance(launch.id, 'protocol').costs, 5000n + 2n * 2039280n, 'the payer’s fee and the shareholder accounts it opened are costs');
    // The journal records legs in the pair asset.
    h.world.history.set(launch.protocol_wallet, [{ signature: dist, slot: 80, failed: false }]);
    h.world.distributions.set(dist, { signature: dist, slot: 80, blockTime: 1, failed: false, payer: generateWallet().address, feeLamports: 5000n, payerLamportDelta: -5000n, anomalies: [], legs: [{ eventIndex: 0, recipient: launch.protocol_wallet, amount: 100000000n, distributed: 1000000000n, shareBps: 1000 }, { eventIndex: 0, recipient: launch.mode_wallet, amount: 900000000n, distributed: 1000000000n, shareBps: 9000 }] });
    h.world.tokens.set(launch.protocol_wallet + ':' + XSTOCK, 100000000n); h.world.tokens.set(launch.mode_wallet + ':' + XSTOCK, 900000000n);
    h.advance(60000); await pass(h);
    assert.equal(h.world.receiptQuote, XSTOCK);
    assert.deepEqual(store.feeTotals(launch.id), { protocol: '100000000', gotchi: '900000000' });
    assert.equal(store.balance(launch.id, 'protocol').credited, 0n, 'nothing reaches the SOL ledger before a conversion');
    assert.equal(store.quoteBalance(launch.id, 'protocol').available, 100000000n);
    // Conversion: the platform share first, then the Gotchi share.
    const convertOps = () => store.operationsFor(launch.id, 'convert');
    assert.equal(convertOps().length, 1); assert.equal(convertOps()[0].wallet, launch.protocol_wallet); assert.equal(convertOps()[0].expected.op.inputAmount, '100000000');
    assert.equal(h.world.conversionCost, PUMP_CLASSIC_POLICY.conversion.maxNetworkCostLamports);
    assert.deepEqual([h.world.conversionArgs.guard, h.world.conversionArgs.priority], [null, false], 'fee conversions keep the treasury defaults');
    h.world.receipts.set(convertOps()[0].signature, { state: 'confirmed', slot: 82, outputAmount: '30000000', actualSolCostLamports: '9000' });
    h.advance(20000); await pass(h);
    assert.equal(store.balance(launch.id, 'protocol').credited, 30000000n); assert.equal(store.quoteBalance(launch.id, 'protocol').converted, 100000000n);
    // Routing sweeps the converted SOL to the treasury.
    h.world.lamports.set(launch.protocol_wallet, 7000000n + 30000000n);
    h.advance(60000); await pass(h);
    const sweep = store.sweeps({ launchId: launch.id, kind: 'protocol' })[0];
    assert.equal(sweep.to_wallet, h.world.treasury); assert.equal(sweep.amount, '30000000', 'the converted SOL is routed; the receipt wallet keeps its gas');
    h.world.receipts.set(store.operationsFor(launch.id, 'withdraw').find(o => o.expected.purpose === 'sweep').signature, { state: 'confirmed', slot: 90, actualSolCostLamports: '5000' });
    h.advance(PUMP_CLASSIC_POLICY.conversion.intervalMs); await pass(h);
    const gotchiConvert = convertOps().at(-1);
    assert.equal(gotchiConvert.wallet, launch.mode_wallet); assert.equal(gotchiConvert.expected.role, 'gotchi');
    h.world.receipts.set(gotchiConvert.signature, { state: 'failed', actualSolCostLamports: '7000' });
    h.advance(20000); await pass(h);
    assert.equal(store.quoteBalance(launch.id, 'gotchi').converted, 0n, 'a failed conversion converts nothing'); assert.equal(store.balance(launch.id, 'gotchi').costs, 7000n);
    // Reports: receipts in the asset received; SOL received counts converted SOL.
    const sources = await h.service.revenueSources();
    assert.deepEqual(sources.sources.map(s => [s.mint, s.decimals, s.symbol, s.amount]), [[XSTOCK, 8, 'EXMx', '100000000']]);
    assert.equal((await h.service.revenueSummary()).receivedLamports, '30000000');
    const view = await h.service.coinView(launch.mint);
    assert.deepEqual([view.pair.symbol, view.fees.symbol, view.fees.distributed, view.fees.platform, view.fees.recipient, view.fees.convertedSol, view.fees.distributedSol], ['EXMx', 'EXMx', '10', '1', '9', '0.03', undefined]);
    const admin = (await h.service.adminOverview('admin')).launches.find(l => l.id === launch.id);
    assert.equal(admin.feeUnit, 'EXMx'); assert.equal(admin.pairBalances.protocol.converted, '1'); assert.equal(admin.conversions.length, 2);
  } finally { await h.cleanup(); }
});

test('conversion waits (and alerts) without a route; only the platform and Gotchi shares are converted', async () => {
  const h = harness();
  try {
    // v71.24: collection and sweeps (with their conversions) run unless switched off.
    await openFlags(h, { intake: true, pairs: true });
    const { launch } = await fundAndCreate(h, body({ mode: 'gotchi', gotchiId: 'fomogotchi', quoteMint: USDC, devBuySol: '0' }));
    const store = h.service.store();
    assert.deepEqual([ops(h, launch.id, 'acquire').length, ops(h, launch.id, 'deliver').length, launch.delivery_state], [0, 0, 'none'], 'no dev buy: nothing to buy or deliver');
    store.recordFeeReceipt({ launchId: launch.id, mint: launch.mint, signature: signature(), eventIndex: 0, recipient: launch.mode_wallet, role: 'gotchi', amount: 50000000n, distributed: 55555555n, slot: 1, quoteMint: USDC });
    h.world.tokens.set(launch.mode_wallet + ':' + USDC, 40000000n);
    store.setFlag('routing', false, { reason: 'test' });
    h.advance(60000); await pass(h);
    assert.equal(store.operationsFor(launch.id, 'convert').length, 0, 'the sweeps flag is off');
    store.setFlag('routing', true, { reason: 'test' });
    h.world.noRoute = true; h.advance(60000); await pass(h);
    assert.equal(store.operationsFor(launch.id, 'convert').length, 0);
    assert.ok(store.events(launch.id, { publicOnly: false }).some(e => e.title === 'Conversion to SOL is waiting'));
    h.world.noRoute = false; h.advance(PUMP_CLASSIC_POLICY.conversion.intervalMs + 600000); await pass(h);
    const op = store.operationsFor(launch.id, 'convert')[0];
    assert.equal(op.expected.op.inputAmount, '40000000', 'only what the wallet actually holds is converted');
    assert.ok(store.events(launch.id, { publicOnly: false }).some(e => /holds less of the pair asset/.test(e.title)));
    assert.throws(() => store.recordFeeReceipt({ launchId: launch.id, mint: launch.mint, signature: signature(), eventIndex: 0, recipient: launch.mode_wallet, role: 'strategy', amount: 1n, distributed: 1n, slot: 2, quoteMint: USDC }), /only credited in SOL/);
  } finally { await h.cleanup(); }
});

test('holder rewards on another pair are paid in that asset: a small sale covers new holder accounts, frozen accounts are skipped, nothing else is converted', async () => {
  const h = harness();
  try {
    await openFlags(h, { intake: true, pairs: true });
    // Holder snapshots run from launch on (every five minutes), so the payout's hour of snapshots starts at the launch.
    const holders = Array.from({ length: 6 }, (_, i) => ({ owner: generateWallet().address, amount: String(1000000000n * BigInt(i + 1)) }));
    h.world.holders = holders;
    const { launch } = await fundAndCreate(h, body({ mode: 'holders', quoteMint: USDC, devBuySol: '0' }));
    const store = h.service.store(), wallet = launch.mode_wallet, key = wallet + ':' + USDC;
    // The two largest holders already have USDC accounts; the smallest one's account is frozen by its issuer.
    h.world.accountStates = { [holders[5].owner]: 'ready', [holders[4].owner]: 'ready', [holders[0].owner]: 'unusable' };
    assert.equal(h.world.lamports.get(wallet), 8000000n, 'the rewards wallet starts with its 0.008 SOL operating reserve');
    store.recordFeeReceipt({ launchId: launch.id, mint: launch.mint, signature: signature(), eventIndex: 0, recipient: wallet, role: 'rewards', amount: 200000000n, distributed: 222222222n, slot: 1, quoteMint: USDC });
    h.world.tokens.set(key, 200000000n);
    // $200 of USDC: a payout starts at the next check (every five minutes) and waits for an hour of holder snapshots.
    h.advance(5 * 60000); await pass(h);
    const started = h.service.payoutRequest(store.launch(launch.id));
    assert.equal(started.source, 'auto'); assert.equal(started.valueUsd, 200); assert.match(started.waiting, /hour of holder snapshots/);
    for (let i = 0; i < 14 && !ops(h, launch.id, 'convert').length; i++) { await h.service.process(); h.advance(5 * 60000); }
    // 0.003 SOL is spendable (the wallet keeps 0.005); three new accounts and two batches need about 0.0088 SOL, so Launchpad sells about $1.10 of USDC.
    const sale = ops(h, launch.id, 'convert')[0];
    assert.ok(sale, 'a small sale covers the costs'); assert.equal(sale.expected.purpose, 'payout-gas'); assert.equal(sale.expected.role, 'rewards'); assert.equal(sale.wallet, wallet);
    assert.equal(sale.expected.op.inputAmount, '1102648');
    assert.equal(store.rewardCycles(launch.id, 5).length, 0, 'nothing is frozen before the sale settles');
    h.world.receipts.set(sale.signature, { state: 'confirmed', slot: 300, outputAmount: '7200000', actualSolCostLamports: '150000' });
    h.world.lamports.set(wallet, 8000000n + 7200000n); h.world.tokens.set(key, 200000000n - 1102648n);
    await pass(h); await pass(h);
    const cycle = store.rewardCycles(launch.id, 5)[0];
    assert.ok(cycle, 'the payout froze once the sale settled');
    assert.equal(BigInt(cycle.amount), 200000000n - 1102648n, 'everything else is paid out');
    assert.ok(cycle.payouts.every(p => p.lamports === '0' && BigInt(p.tokens) > 0n), 'paid in USDC, not SOL');
    assert.ok(!cycle.payouts.some(p => p.owner === holders[0].owner), 'a frozen account is skipped');
    assert.equal(cycle.payouts.length, 5);
    await pass(h);
    const drops = () => ops(h, launch.id, 'airdrop');
    assert.equal(drops().length, 1);
    assert.deepEqual([h.world.airdropArgs.mint, h.world.airdropArgs.minSolReserve, h.world.airdropArgs.maxNetworkCostLamports], [USDC, '5000000', '15000000']);
    assert.equal(drops()[0].expected.op.payouts.length, 4);
    h.world.receipts.set(drops()[0].signature, { state: 'confirmed', actualSolCostLamports: String(3n * 2039280n + 9000n) });
    await pass(h); await pass(h);
    assert.equal(drops().length, 2);
    h.world.receipts.set(drops()[1].signature, { state: 'confirmed', actualSolCostLamports: '9000' });
    await pass(h);
    const done = store.rewardCycles(launch.id, 5)[0];
    assert.equal(done.state, 'complete'); assert.equal(done.paid, done.amount);
    assert.deepEqual(store.quoteBalance(launch.id, 'rewards'), { credited: 200000000n, converted: 200000000n, available: 0n });
    assert.equal(h.service.payoutRequest(store.launch(launch.id)), null);
    // Only the payout's own sale converted anything; the regular conversion pass never touches holder rewards.
    assert.deepEqual(store.conversions({ launchId: launch.id }).map(c => [c.role, c.input, c.state]), [['rewards', '1102648', 'confirmed']]);
    const view = await h.service.coinView(launch.mint);
    assert.deepEqual([view.rewards[0].asset, view.rewards[0].paid, view.fees.paidToHolders, view.fees.convertedSol, view.holderRewards.asset], ['USDC', '198.897352', '198.897352', null, 'USDC']);
    const admin = (await h.service.adminOverview('admin')).launches.find(l => l.id === launch.id);
    assert.deepEqual(admin.pairBalances.rewards, { credited: '200', converted: '1.102648', paid: '198.897352', held: '0' });
    assert.deepEqual([admin.holderPayout.last.state, admin.holderPayout.last.asset, admin.holderPayout.last.paid, admin.holderPayout.last.recipients], ['completed', 'USDC', '198.897352', 5]);
    // Distribute SOL rewards leaves a coin on another pair to Sell & distribute all.
    const skipped = await h.service.queueHeldSolDistribution('admin', { id: launch.id, requestId: 'd'.repeat(32) });
    assert.deepEqual([skipped.state, skipped.reason], ['skipped', 'Holder rewards on this coin are paid in USDC. Use Sell & distribute all.']);
    // Sell & distribute all with nothing left: the request completes without paying.
    const swept = await h.service.queueRewardSweep('admin', { launchId: launch.id, requestId: 'e'.repeat(32) });
    assert.equal(swept.state, 'processing');
    await pass(h);
    const result = await h.service.rewardSweepStatus({ launchId: launch.id, requestId: 'e'.repeat(32) });
    assert.deepEqual([result.state, result.distributedQuoteUnits, result.remainingQuoteUnits], ['completed', '0', '0']);
    assert.match(result.reason, /No USDC holder rewards were waiting/);
  } finally { await h.cleanup(); }
});

/** A Holders coin on USDC with six holders who all hold USDC accounts, $200 of rewards and SOL for fees; returns once its payout froze. */
async function frozenUsdcPayout(h) {
  await openFlags(h, { intake: true, pairs: true });
  const holders = Array.from({ length: 6 }, (_, i) => ({ owner: generateWallet().address, amount: String(1000000000n * BigInt(i + 1)) }));
  h.world.holders = holders; h.world.accountStates = Object.fromEntries(holders.map(x => [x.owner, 'ready']));
  const { launch } = await fundAndCreate(h, body({ mode: 'holders', quoteMint: USDC, devBuySol: '0' }));
  const store = h.service.store();
  store.recordFeeReceipt({ launchId: launch.id, mint: launch.mint, signature: signature(), eventIndex: 0, recipient: launch.mode_wallet, role: 'rewards', amount: 200000000n, distributed: 222222222n, slot: 1, quoteMint: USDC });
  h.world.tokens.set(launch.mode_wallet + ':' + USDC, 200000000n); h.world.lamports.set(launch.mode_wallet, 50000000n);
  for (let i = 0; i < 16 && !store.rewardCycles(launch.id, 5).length; i++) { await h.service.process(); h.advance(5 * 60000); }
  const cycle = store.rewardCycles(launch.id, 5)[0]; assert.ok(cycle, 'the payout froze');
  assert.equal(ops(h, launch.id, 'convert').length, 0, 'every holder has an account and the wallet has SOL: nothing is sold');
  return { launch, store, cycle };
}
/** Worker passes ten minutes apart; every airdrop sent is confirmed. */
async function payOut(h, launch, rounds) {
  for (let i = 0; i < rounds; i++) {
    for (const op of ops(h, launch.id, 'airdrop')) if (!h.world.receipts.has(op.signature)) h.world.receipts.set(op.signature, { state: 'confirmed', actualSolCostLamports: '9000' });
    await h.service.process(); h.advance(10 * 60000);
  }
}

test('a holder whose account refuses the transfer leaves the payout after three failed tries; everyone else is paid and the share stays for the next payout', async () => {
  const h = harness();
  try {
    const { launch, store, cycle } = await frozenUsdcPayout(h);
    const bad = cycle.payouts[0], others = cycle.payouts.filter(p => p.owner !== bad.owner);
    h.world.refuseAirdrop = payouts => payouts.some(p => p.owner === bad.owner) ? 'Airdrop simulation failed: {"InstructionError":[3,{"Custom":17}]}.' : null;
    await payOut(h, launch, 12);
    const done = store.rewardCycle(cycle.id);
    assert.equal(done.state, 'complete');
    assert.deepEqual(done.payouts.map(p => p.owner), others.map(p => p.owner), 'only the refusing holder left the cycle');
    assert.equal(BigInt(done.amount), BigInt(cycle.amount) - BigInt(bad.tokens)); assert.equal(done.paid, done.amount);
    assert.ok(ops(h, launch.id, 'airdrop').every(op => !op.expected.op.payouts.some(p => p.owner === bad.owner)));
    assert.ok(store.events(launch.id, { publicOnly: false }).some(e => e.title === 'Holders skipped in a payout'));
    assert.equal(store.quoteBalance(launch.id, 'rewards').available, 200000000n - BigInt(done.paid), 'the skipped share stays with the rewards');
    assert.equal(h.service.payoutRequest(store.launch(launch.id)), null, 'the payout closed');
  } finally { await h.cleanup(); }
});

test('a payout batch that fails while each holder passes alone pays one holder per transaction; a failure for everyone skips no one', async () => {
  const h = harness();
  try {
    const { launch, store, cycle } = await frozenUsdcPayout(h);
    h.world.refuseAirdrop = payouts => payouts.length > 1 ? 'Airdrop simulation failed: {"InstructionError":[0,"ComputationalBudgetExceeded"]}.' : null;
    // Three failed tries, then each holder in a transaction of their own (sent, then settled on the next pass).
    await payOut(h, launch, 3 + 2 * cycle.payouts.length + 1);
    const done = store.rewardCycle(cycle.id);
    assert.equal(done.state, 'complete'); assert.equal(done.payouts.length, cycle.payouts.length, 'nobody was skipped'); assert.equal(done.paid, cycle.amount);
    assert.ok(ops(h, launch.id, 'airdrop').every(op => op.expected.op.payouts.length === 1));
    // A paused asset fails for every recipient (the probe's control too): the next payout waits with an alert and skips no one.
    h.world.refuseAirdrop = null;
    store.recordFeeReceipt({ launchId: launch.id, mint: launch.mint, signature: signature(), eventIndex: 1, recipient: launch.mode_wallet, role: 'rewards', amount: 200000000n, distributed: 222222222n, slot: 2, quoteMint: USDC });
    h.world.tokens.set(launch.mode_wallet + ':' + USDC, 200000000n);
    h.advance(PUMP_CLASSIC_POLICY.holders.cycleIntervalMs);
    for (let i = 0; i < 16 && store.rewardCycles(launch.id, 5).length < 2; i++) { await h.service.process(); h.advance(5 * 60000); }
    const next = store.rewardCycles(launch.id, 5).find(c => c.id !== cycle.id); assert.ok(next, 'a second payout froze');
    h.world.refuseAirdrop = () => 'Airdrop simulation failed: {"InstructionError":[3,{"Custom":36}]}.';
    await payOut(h, launch, 10);
    const stuck = store.rewardCycle(next.id);
    assert.equal(stuck.payouts.length, next.payouts.length, 'nobody is blamed for a failure every recipient shares'); assert.equal(stuck.paid, '0');
    assert.ok(store.events(launch.id, { publicOnly: false }).some(e => e.title === 'A holder payout batch is waiting'));
    h.world.refuseAirdrop = null; await payOut(h, launch, 8);
    assert.equal(store.rewardCycle(next.id).state, 'complete', 'it pays once the asset moves again');
  } finally { await h.cleanup(); }
});

test('a pair payout waits without prices, gives up after its sales cannot cover the costs, and never pays dust to a new account', async () => {
  const h = harness();
  try {
    await openFlags(h, { intake: true, pairs: true });
    // One whale and many small holders: at $5 of rewards a small holder's share is below three times a new account's rent.
    const whale = { owner: generateWallet().address, amount: '1000000000000' }, small = Array.from({ length: 8 }, () => ({ owner: generateWallet().address, amount: '1000000000' }));
    h.world.holders = [whale, ...small]; h.world.accountStates = { [whale.owner]: 'ready' };
    const { launch } = await fundAndCreate(h, body({ mode: 'holders', quoteMint: USDC, devBuySol: '0' }));
    const store = h.service.store(), wallet = launch.mode_wallet, key = wallet + ':' + USDC;
    store.recordFeeReceipt({ launchId: launch.id, mint: launch.mint, signature: signature(), eventIndex: 0, recipient: wallet, role: 'rewards', amount: 5000000n, distributed: 5555555n, slot: 1, quoteMint: USDC });
    h.world.tokens.set(key, 5000000n);
    h.service.kick = () => null;
    const requestId = 'f'.repeat(32);
    assert.equal((await h.service.queueRewardSweep('admin', { launchId: launch.id, requestId })).state, 'processing');
    for (let i = 0; i < 14 && !store.rewardCycles(launch.id, 5).length; i++) { await h.service.process(); h.advance(5 * 60000); }
    const cycle = store.rewardCycles(launch.id, 5)[0];
    assert.ok(cycle, JSON.stringify(h.service.payoutRequest(store.launch(launch.id))) + ' ' + JSON.stringify(await h.service.rewardSweepStatus({ launchId: launch.id, requestId })));
    assert.deepEqual(cycle.payouts.map(p => p.owner), [whale.owner], 'only the holder with an account qualifies; nothing is sold for dust accounts');
    assert.equal(ops(h, launch.id, 'convert').length, 0);
    await pass(h);
    for (const op of ops(h, launch.id, 'airdrop')) h.world.receipts.set(op.signature, { state: 'confirmed', actualSolCostLamports: '9000' });
    await pass(h); await pass(h);
    assert.equal((await h.service.rewardSweepStatus({ launchId: launch.id, requestId })).state, 'completed');
    // A second payout without prices waits.
    store.recordFeeReceipt({ launchId: launch.id, mint: launch.mint, signature: signature(), eventIndex: 0, recipient: wallet, role: 'rewards', amount: 300000000n, distributed: 333333333n, slot: 2, quoteMint: USDC });
    h.world.tokens.set(key, 300000000n); h.world.prices = {};
    await h.service.queueRewardSweep('admin', { launchId: launch.id, requestId: '9'.repeat(32) });
    await pass(h); await pass(h);
    const waiting = await h.service.rewardSweepStatus({ launchId: launch.id, requestId: '9'.repeat(32) });
    assert.deepEqual([waiting.state, waiting.reason], ['waiting', 'Waiting for live USDC and SOL prices.']);
    // Without a USDC reference the SOL route prices the payout (read-only). New accounts need SOL; sales that bring back too little stop after three tries and the USDC stays reserved.
    h.world.prices = { [SOL]: 150 }; h.world.accountStates = {}; delete h.world.conversionQuote;
    for (let i = 0; i < 12; i++) {
      for (const op of ops(h, launch.id, 'convert')) if (!h.world.receipts.has(op.signature)) h.world.receipts.set(op.signature, { state: 'confirmed', slot: 400 + i, outputAmount: '1000', actualSolCostLamports: '5000' });
      await pass(h);
      if ((await h.service.rewardSweepStatus({ launchId: launch.id, requestId: '9'.repeat(32) })).state === 'blocked') break;
    }
    const blocked = await h.service.rewardSweepStatus({ launchId: launch.id, requestId: '9'.repeat(32) });
    assert.equal(blocked.state, 'blocked'); assert.match(blocked.reason, /needs a little SOL/);
    assert.equal(ops(h, launch.id, 'convert').length, 3, 'at most three sales per payout');
    assert.deepEqual([h.world.conversionQuote.quoteMint, h.world.conversionQuote.lamports], [USDC, 50000000n], 'priced from the SOL route');
    assert.ok(store.quoteBalance(launch.id, 'rewards').available > 0n, 'the rest stays reserved');
    assert.ok(store.events(launch.id, { publicOnly: false }).some(e => e.title === 'A holder payout could not cover its costs'));
  } finally { await h.cleanup(); }
});

test('public rows and market reads carry the coin’s pair', async () => {
  const h = harness();
  try {
    await openFlags(h);
    const { launch } = await fundAndCreate(h, body({ quoteMint: USDC, devBuySol: '0.1' }));
    const row = await h.service.publicDetail(launch.mint);
    assert.deepEqual([row.quoteMint, row.quoteSymbol, row.quoteDecimals, row.quoteProgram, row.quoteName, row.quoteCategory, row.creatorFeeBps], [USDC, 'USDC', 6, SPL, 'USD Coin', 'crypto', 0]);
    assert.equal(row.bondingCurve, coinAddresses(launch.mint).bondingCurve);
    await h.service.marketSnapshot(launch.mint);
    assert.deepEqual([h.world.snapshotQuote.mint, h.world.snapshotQuote.decimals, h.world.snapshotQuote.symbol, h.world.snapshotQuote.initialVirtualQuoteReserves], [USDC, 6, 'USDC', '4500000000']);
    const trades = await h.service.trades(launch.mint);
    assert.equal(trades[0].quote, 37.5, 'trade amounts are in the pair asset'); assert.equal(h.world.tradesQuote, USDC);
  } finally { await h.cleanup(); }
});

test('a v71.18 database migrates to the current schema with every existing coin described as a SOL coin and no option', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pump-migrate-')), path = join(dir, 'pc.sqlite');
  try {
    const old = new DatabaseSync(path);
    old.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)'); old.exec(MIGRATIONS[0].sql);
    old.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (1, ?, 1)').run(MIGRATIONS[0].name);
    old.prepare(`INSERT INTO launches(id, account_id, request_key, mode, policy_version, policy_hash, name, symbol, launch_wallet, protocol_wallet, mint, plan, quote, quote_expires_at, state, created_at, updated_at) VALUES ('l1', 'a', 'k', 'creator', 'pump-classic-policy-v1', 'h', 'N', 'S', 'w1', 'w2', 'm1', '{}', '{}', 1, 'created', 1, 1)`).run();
    old.prepare(`INSERT INTO fee_receipts(id, launch_id, mint, signature, event_index, recipient, role, amount, distributed, slot, created_at) VALUES ('r1', 'l1', 'm1', 's1', 0, 'w2', 'protocol', '5', '50', 1, 1)`).run();
    old.close();
    const db = await openPumpClassicDatabase(path);
    try {
      assert.equal(db.version(), PUMP_CLASSIC_SCHEMA_VERSION); assert.equal(PUMP_CLASSIC_SCHEMA_VERSION, 4);
      const launch = db.get('SELECT * FROM launches WHERE id = ?', 'l1');
      assert.deepEqual([launch.quote_mint, launch.quote_program, launch.quote_decimals, launch.quote_symbol, launch.quote_kind, launch.quote_control, launch.creator_fee_bps, launch.dev_buy_raw, launch.quote_refund_state], [SOL, SPL, 9, 'SOL', 'sol', 0, 0, '0', 'none']);
      assert.equal(db.get('SELECT quote_mint FROM fee_receipts WHERE id = ?', 'r1').quote_mint, SOL);
      assert.equal(db.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('quote_balances', 'conversions', 'holder_streaks', 'basket_ledger')").n, 4);
      assert.ok(db.all('PRAGMA table_info(launches)').some(c => c.name === 'option') && db.all('PRAGMA table_info(launches)').some(c => c.name === 'basket'), 'v71.35 adds the launch option and basket columns');
      assert.ok(db.all('PRAGMA table_info(reward_cycles)').some(c => c.name === 'mint'), 'v71.35 records the asset of a basket cycle');
      assert.equal(launch.basket, null); assert.equal(launch.option, null);
    } finally { db.close(); }
    const again = await openPumpClassicDatabase(path); assert.equal(again.version(), 4); again.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a launch keeps the spread it was quoted with; a slow network waits without counting, other purchase failures count', async () => {
  const h = harness();
  try {
    await openFlags(h);
    const store = h.service.store();
    const { quote } = await fund(h, body({ quoteMint: USDC, devBuySol: '1' }));
    // A launch quoted under v3 keeps v3's limits for its purchase.
    store.updateLaunch(quote.id, { policy_hash: PUMP_CLASSIC_POLICY_V3_HASH, policy_version: PUMP_CLASSIC_POLICY_V3.version });
    // The swap provider is busy: the purchase waits, and the wait does not count toward the refund.
    h.world.acquireError = Object.assign(Error('SOL routing is busy (HTTP 429). Please try again in 2 seconds.'), { code: 'SOL_ROUTE_RATE_LIMITED' });
    await pass(h, 2);
    let launch = store.launch(quote.id);
    assert.equal(launch.state, 'funded'); assert.equal(launch.quote.conversion.waitFailures, 1); assert.equal(launch.quote.conversion.prepareFailures, undefined);
    assert.match(launch.state_reason, /Launchpad is buying USDC for your dev buy and is waiting on the network or its swap provider/);
    assert.deepEqual([h.world.acquire.slippageBps, h.world.acquire.maxImpactBps], [PUMP_CLASSIC_POLICY_V3.pairDevBuy.slippageBps, 200], 'v3 launches buy with v3’s 1% slippage');
    // An RPC that has not reached the route's slot, the shared RPC gate cooling down, a provider that rejects the
    // site's key and an unexpected error are the same kind of wait: none of them says the purchase cannot be made.
    const waits = [Object.assign(Error('failed to get info for accounts: Minimum context slot has not been reached'), { code: -32016 }),
      Object.assign(Error('RPC is cooling down after a rate limit.'), { retryable: true }),
      Object.assign(Error('The site’s SOL routing provider could not authorize this request (HTTP 401). The operator needs to check its routing configuration.'), { code: 'SOL_ROUTE_AUTH' }),
      Object.assign(Error('The SOL route expired. Review a fresh quote.')),
      new TypeError('Cannot read properties of undefined')];
    let advance = 60000;
    for (const error of waits) { h.world.acquireError = error; h.advance(advance *= 2); await pass(h); }
    assert.equal(store.launch(quote.id).quote.conversion.waitFailures, 1 + waits.length); assert.equal(store.launch(quote.id).quote.conversion.prepareFailures, undefined);
    // A failure that says the purchase cannot be made within its limits counts toward the refund.
    h.world.acquireError = Error('The treasury network and rent cost exceeds its operation limit.'); h.advance(600000);
    await pass(h);
    launch = store.launch(quote.id);
    assert.equal(launch.quote.conversion.prepareFailures, 1); assert.equal(launch.quote.conversion.waitFailures, 1 + waits.length);
    assert.match(launch.state_reason, /could not buy USDC for your dev buy yet \(1 of 4 tries\)\. It retries automatically; if it cannot, your SOL is refunded\./);
    for (const [error, counted] of [[Object.assign(Error('Treasury simulation failed: {"InstructionError":[3,{"Custom":6001}]}.')), 2], [Object.assign(Error('No SOL route is available for this amount and route size right now.'), { code: 'SOL_ROUTE_NOT_FOUND' }), 3]]) {
      h.world.acquireError = error; h.advance(600000); await pass(h);
      assert.equal(store.launch(quote.id).quote.conversion.prepareFailures, counted);
    }
    // Once it can be prepared, the purchase is sent and the status line clears.
    h.world.acquireError = null; h.advance(600000);
    await until(h, () => ops(h, quote.id, 'acquire').length === 1);
    assert.equal(store.launch(quote.id).state_reason, '');
    assert.equal(h.world.acquire.slippageBps, 100);
  } finally { await h.cleanup(); }
});

test('a pair purchase that cannot reach the network for many tries is refunded in SOL; nothing was converted', async () => {
  const h = harness();
  try {
    await openFlags(h);
    const store = h.service.store();
    const { quote } = await fund(h, body({ quoteMint: USDC, devBuySol: '1' }));
    h.world.acquireError = Object.assign(Error('The SOL routing provider could not be reached. Please try again shortly.'), { code: 'SOL_ROUTE_NETWORK' });
    await pass(h);
    const current = store.launch(quote.id);
    assert.equal(current.state, 'funded'); assert.equal(current.quote.conversion.waitFailures, 1);
    store.updateLaunch(quote.id, { quote: { ...current.quote, conversion: { ...current.quote.conversion, waitFailures: 24 } } });
    h.advance(600000); await pass(h);
    const launch = store.launch(quote.id);
    assert.equal(launch.state, 'failed'); assert.match(launch.state_reason, /could not reach the network long enough to buy USDC for your dev buy\. Your SOL is being refunded; nothing was converted/);
    assert.equal(ops(h, quote.id, 'acquire').length, 0);
  } finally { await h.cleanup(); }
});

test('one swap is prepared per worker pass, so a pass never holds the lock through several finalization waits', async () => {
  const h = harness();
  try {
    await openFlags(h);
    const store = h.service.store();
    const first = (await fund(h, body({ quoteMint: USDC, devBuySol: '1' }))).quote, second = (await fund(h, body({ quoteMint: USDC, devBuySol: '1' }), { wallet: h.dev })).quote;
    await h.service.process();
    assert.equal(ops(h, first.id, 'acquire').length + ops(h, second.id, 'acquire').length, 1, 'one purchase in the first pass');
    h.advance(11000); await h.service.process();
    assert.equal(ops(h, first.id, 'acquire').length + ops(h, second.id, 'acquire').length, 2, 'the other one in the next pass');
    assert.equal(h.service.swapsLeft, undefined, 'outside a pass swaps are not limited');
    assert.equal(store.launch(first.id).state, 'funded'); assert.equal(store.launch(second.id).state, 'funded');
  } finally { await h.cleanup(); }
});
