import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { GotchiService, GOTCHI_POLICY } from '../src/gotchi-service.mjs';
import { GOTCHI_THEMES } from '../public/gotchi-catalog.mjs';

const SOL = 'So11111111111111111111111111111111111111112', USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const MIN = 60000, HOUR = 3600000;
const wallet = () => Keypair.generate().publicKey.toBase58();
const signatureOf = seed => bs58.encode(createHash('sha512').update(seed).digest());
const rawOf = seed => { const raw = Buffer.from('tx:' + seed).toString('base64'); return { raw, rawHash: createHash('sha256').update(Buffer.from(raw, 'base64')).digest('hex') }; };

class FakeStore { constructor() { this.docs = new Map(); this.writes = 0; } async read(name, fallback = null) { if (!/^[a-z][a-z0-9-]*$/.test(name)) throw Error('Invalid storage name.'); return this.docs.has(name) ? JSON.parse(this.docs.get(name)) : fallback; } async write(name, value) { if (!/^[a-z][a-z0-9-]*$/.test(name)) throw Error('Invalid storage name.'); this.docs.set(name, JSON.stringify(value)); this.writes++; } }

function raydiumLaunch({ vault, mint, rewards, feeWallet, curve, sources = [], now }) {
  const secret = key => bs58.encode(key.secretKey);
  return { id: 'launch-' + mint.slice(0, 6), state: 'live', curve, authorizedAt: now - 3 * HOUR, createdAt: now - 4 * HOUR, feeCustody: 'relay',
    input: { route: 'raydium', network: 'mainnet-beta', feeMode: 'holders', taxBps: 100, gotchiId: 'fomogotchi', gotchi: { version: 1, id: 'fomogotchi', theme: 'fomogotchi', vault }, quoteMint: SOL, name: 'Granite Goat', symbol: 'GOAT', imageId: '' },
    keys: { mint: { address: mint }, wallet: { address: feeWallet.publicKey.toBase58(), secret: secret(feeWallet) }, rewards: { address: rewards.publicKey.toBase58(), secret: secret(rewards) } },
    review: { quoteDecimals: 9, quoteSymbol: 'SOL', price: { usd: '200', at: now } }, credits: { quote: '41000000', base: '120000' },
    rewardsWallet: { version: 1, status: 'active', address: rewards.publicKey.toBase58(), creatorCredits: { base: '0', quote: '0', protocolQuote: '0', taxBase: '0' } },
    operations: sources.map(source => ({ kind: 'payout', state: 'confirmed', signature: source.signature, slot: 100, confirmedAt: now - HOUR, amount: source.amount, payouts: [{ owner: vault, amount: source.amount }], rewardsWallet: { version: 1, source: 'rewards', address: rewards.publicKey.toBase58(), signerSource: 'rewards' } })) };
}

class FakeChain {
  constructor(world) { this.world = world; this.calls = []; this.closed = false; }
  async incomingReceipt(source, { wallet: destination }) { this.calls.push(['incomingReceipt', source.signature]); if (!this.world.finalized.has(source.signature)) return null; if (source.wallet !== destination) throw Error('wrong destination'); return { id: source.signature + ':' + source.mint, signature: source.signature, mint: source.mint, wallet: destination, sourceWallet: source.sourceWallet, receivedAmount: source.amount, sourceDebitAmount: source.amount, transferredAmount: source.amount, slot: 120 }; }
  async solUsd() { if (this.world.solUsdError) throw Error(this.world.solUsdError); return { usd: this.world.solUsd, at: this.world.now(), source: 'test' }; }
  async mintSummary(mint) { return { mint, program: TOKEN_PROGRAM, decimals: 6, supply: '1000000000000000', slot: 130, transferFee: null }; }
  async holderSnapshot({ mint, exclude }) { this.calls.push(['holderSnapshot', mint]); const rows = (this.world.holders.get(mint) || []).filter(row => !exclude.includes(row.owner)); return { mint, slot: 140, at: this.world.now(), rows, scanned: rows.length, skipped: 0, complete: true }; }
  async vaultBalances({ address }) { return { address, slot: 150, lamports: '0', tokens: [] }; }
  async prepare(request) { this.calls.push(['prepare', request.kind, request.mint, request.amount, request.minSolReserve]); const failure = this.world.prepareFailures.shift(); if (failure) throw Object.assign(Error(failure.message || failure.code), { code: failure.code }); const seed = 'op' + (++this.world.sequence); return { kind: request.kind, mint: request.mint, wallet: request.wallet.address, inputAmount: request.amount, minimumOutput: '1', expectedOutput: '1', signature: signatureOf(seed), ...rawOf(seed), blockhash: 'hash', lastValidBlockHeight: 1000, preparedSlot: 160, createdAt: this.world.now(), accounting: { maxCostLamports: request.maxNetworkCostLamports, monitoredAccounts: [], ata: null, program: TOKEN_PROGRAM, decimals: 6, minSolReserve: request.minSolReserve, networkFeeLamports: '5000', beforeSol: '0', beforeTokens: '0' } }; }
  async prepareAirdrop({ wallet: signer, mint, payouts, minSolReserve, maxNetworkCostLamports }) { this.calls.push(['prepareAirdrop', mint, payouts.length]); const seed = 'op' + (++this.world.sequence); const lamports = payouts.reduce((sum, row) => sum + BigInt(row.lamports), 0n), tokens = payouts.reduce((sum, row) => sum + BigInt(row.tokens), 0n); return { kind: 'airdrop', mint, wallet: signer.address, inputAmount: lamports.toString(), tokenAmount: tokens.toString(), minimumOutput: '0', expectedOutput: '0', payouts: payouts.map(row => ({ ...row, ata: null, minTokens: row.tokens })), signature: signatureOf(seed), ...rawOf(seed), blockhash: 'hash', lastValidBlockHeight: 1000, preparedSlot: 170, createdAt: this.world.now(), accounting: { maxCostLamports: maxNetworkCostLamports, rentBudgetLamports: '0', networkFeeLamports: '5000', monitoredAccounts: [], ata: null, program: TOKEN_PROGRAM, decimals: 6, minSolReserve, beforeSol: '0', beforeTokens: '0' } }; }
  async broadcast(op) { this.calls.push(['broadcast', op.kind]); this.world.broadcast.push(op.signature); }
  async receipt(op) { const receipt = this.world.receipts.get(op.signature); if (!receipt) return null; if (receipt.state === 'confirmed' && op.kind === 'airdrop') return { ...receipt, inputAmount: op.inputAmount, tokenAmount: op.tokenAmount, recipients: op.payouts.map(row => ({ owner: row.owner, lamports: row.lamports, tokens: row.tokens })) }; return { ...receipt, inputAmount: receipt.inputAmount ?? op.inputAmount }; }
  async state() { return { state: 'pending', reason: 'test' }; }
  async close() { this.closed = true; }
}

async function harness({ solUsd = 200 } = {}) {
  let clock = Date.UTC(2026, 9, 2, 12, 0, 0);
  const now = () => clock, store = new FakeStore(), dir = await mkdtemp(join(tmpdir(), 'gotchi-'));
  const launches = [], meteoraLaunches = [], meteoraSources = [];
  const accounts = { dir, hostStore: store, list: async () => [{ id: 'acct-1', username: 'mira', role: 'admin', mfaEnabled: true, banned: false }], get: async id => id === 'acct-1' ? { id, username: 'mira', role: 'admin', mfaEnabled: true, banned: false } : null, storeFor: () => ({ read: async (name, fallback) => name === 'launchpad' ? { launches } : fallback }) };
  const world = { now, solUsd, finalized: new Set(), holders: new Map(), prepareFailures: [], receipts: new Map(), broadcast: [], sequence: 0, chains: [] };
  const markets = new Map();
  // The fake feed behaves like the live Explore projection: every warm() refreshes the observation time.
  const discovery = { inventory: async () => new Map([...markets.keys()].map(mint => [mint, { coin: { mint } }])), coin: record => { const row = markets.get(record.coin.mint); return row ? { ...row, marketAt: now() } : undefined; }, warm: async () => {} };
  const service = new GotchiService({ accounts, launchpad: null, discovery, chainFactory: async () => { const chain = new FakeChain(world); world.chains.push(chain); return chain; }, now, intervalMs: 1000 });
  service.meteora = { gotchiLaunches: async () => meteoraLaunches, gotchiSources: async () => meteoraSources };
  // Owner controls kick a background pass in production; tests drive every pass explicitly.
  service.kick = () => null;
  const tick = async (id = 'fomogotchi') => { service.launchCache = null; const controls = await service.loadControls(); await service.processGotchi(id, controls); return service.load(id); };
  return { service, store, world, launches, meteoraLaunches, meteoraSources, markets, now, advance: ms => { clock += ms; }, tick, accounts };
}

test('registry, vault keys and launch targets are created once and never rotated', async () => {
  const h = await harness();
  const registry = await h.service.ensure();
  assert.deepEqual(Object.keys(registry.gotchis).sort(), GOTCHI_THEMES.map(theme => theme.id).sort());
  const target = await h.service.launchTarget('fomogotchi');
  assert.equal(target.vault, registry.gotchis.fomogotchi.vault);
  const keys = await h.store.read('gotchi-vault-keys');
  assert.equal(Keypair.fromSecretKey(bs58.decode(keys.keys.fomogotchi.secret)).publicKey.toBase58(), target.vault);
  const again = new GotchiService({ accounts: h.accounts, discovery: null, chainFactory: async () => null, now: h.now });
  assert.equal((await again.launchTarget('fomogotchi')).vault, target.vault, 'a restart keeps the same vault');
  await assert.rejects(h.service.launchTarget('dogegotchi'), /Choose a Gotchi/);
  await h.service.control('acct-1', { enabled: false, reason: 'maintenance window' });
  await assert.rejects(h.service.launchTarget('fomogotchi'), /paused by the platform owner/);
  await h.service.control('acct-1', { enabled: true, reason: 'maintenance done' });
  assert.equal((await h.service.launchTarget('pumpgotchi')).id, 'pumpgotchi');
  await assert.rejects(h.service.control('acct-1', { id: 'fomogotchi', collectionPaused: true, reason: 'no' }), /reason/);
  await assert.rejects(h.service.control('nobody', { enabled: false, reason: 'not an admin' }), /Administrator/);
});

test('contributions are recognized once from finalized receipts and never from balances', async () => {
  const h = await harness();
  const target = await h.service.launchTarget('fomogotchi'), rewards = Keypair.generate(), feeWallet = Keypair.generate(), mint = wallet(), curve = wallet();
  const first = { signature: signatureOf('payout-1'), amount: '500000000' }, second = { signature: signatureOf('payout-2'), amount: '250000000' };
  h.launches.push(raydiumLaunch({ vault: target.vault, mint, rewards, feeWallet, curve, sources: [first, second], now: h.now() }));
  h.markets.set(mint, { mint, marketCapUsd: 150000, fdvUsd: 150000, priceUsd: 0.00015, stage: 'graduated', stale: false, marketSource: 'test' });
  h.world.finalized.add(first.signature);
  let state = await h.tick();
  assert.equal(state.coins[mint].graduated, true);
  assert.equal(state.coins[mint].graduatedAt, h.now());
  assert.equal(state.coins[mint].graduationSource, 'first-observation');
  assert.equal(state.totals.realizedSol, '500000000');
  assert.equal(state.totals.contributions, 1);
  assert.equal(Object.keys(state.seen).length, 1);
  assert.ok(Object.keys(state.sourceRetry).length === 1, 'the unfinalized payout waits with a retry record');
  state = await h.tick();
  assert.equal(state.totals.realizedSol, '500000000', 'a seen receipt is never credited twice');
  h.world.finalized.add(second.signature); h.advance(GOTCHI_POLICY.retryBaseMs * 2);
  state = await h.tick();
  assert.equal(state.totals.realizedSol, '750000000');
  const pot = h.service.potView(state);
  assert.equal(pot.spendableSol, '0.73');
  assert.equal(pot.reservedSol, '0.02');
  assert.ok(Math.abs(state.valuation.potUsd - 0.73 * 200) < 1e-9);
  assert.equal(state.milestones.length, 0);
  // Pausing recognition leaves new receipts untouched.
  const third = { signature: signatureOf('payout-3'), amount: '100000000' };
  h.launches[0].operations.push({ kind: 'payout', state: 'confirmed', signature: third.signature, slot: 101, confirmedAt: h.now(), amount: third.amount, payouts: [{ owner: target.vault, amount: third.amount }], rewardsWallet: { version: 1, source: 'rewards', address: rewards.publicKey.toBase58(), signerSource: 'rewards' } });
  h.world.finalized.add(third.signature);
  await h.service.control('acct-1', { id: 'fomogotchi', collectionPaused: true, reason: 'investigating a receipt' });
  state = await h.tick();
  assert.equal(state.totals.realizedSol, '750000000');
  await h.service.control('acct-1', { id: 'fomogotchi', collectionPaused: false, reason: 'all clear' });
  state = await h.tick();
  assert.equal(state.totals.realizedSol, '850000000');
});

test('quote-token contributions are converted to SOL through journaled transactions', async () => {
  const h = await harness();
  const target = await h.service.launchTarget('pumpgotchi');
  h.meteoraLaunches.push({ venue: 'meteora', mint: wallet(), name: 'Salt', symbol: 'SALT', image: null, gotchi: { id: 'pumpgotchi', theme: 'pumpgotchi', vault: target.vault, attachedAt: h.now() }, status: 'migrated', graduated: true, graduatedAt: h.now() - HOUR, createdAt: h.now() - 2 * HOUR, finalizedAt: h.now() - 2 * HOUR, quoteMint: USDC, quoteDecimals: 6, quoteSymbol: 'USDC', baseDecimals: 6, hidden: false, archived: false, custody: [wallet(), wallet()], contributedRaw: '0', pendingRaw: '0' });
  const sig = signatureOf('meteora-payout');
  h.meteoraSources.push({ kind: 'meteora-gotchi-payout', gotchiId: 'pumpgotchi', launchMint: h.meteoraLaunches[0].mint, venue: 'meteora', signature: sig, mint: USDC, amount: '41200000', wallet: target.vault, sourceWallet: wallet(), decimals: 6, symbol: 'USDC', at: h.now() });
  h.world.finalized.add(sig);
  let state = await h.tick('pumpgotchi');
  assert.equal(state.coins[h.meteoraLaunches[0].mint].graduationSource, 'migration-receipt');
  assert.equal(state.assets[USDC].credit, '41200000');
  assert.ok(state.pending, 'a conversion was prepared in the same pass');
  assert.equal(state.pending.kind, 'convert'); assert.equal(state.pending.inputAmount, '41200000');
  assert.deepEqual(h.world.broadcast, [state.pending.signature], 'the journaled transaction was broadcast after being saved');
  assert.equal(state.gas.reserved, GOTCHI_POLICY.maximumOperationCostLamports);
  // Still pending: nothing else happens, the receipt is checked, no second op.
  h.advance(11000); state = await h.tick('pumpgotchi');
  assert.equal(state.pending.kind, 'convert'); assert.equal(h.world.sequence, 1);
  h.world.receipts.set(state.pending.signature, { state: 'confirmed', signature: state.pending.signature, slot: 200, feeLamports: '5000', inputAmount: '41200000', outputAmount: '270000000', actualSolCostLamports: '9000' });
  h.advance(11000); state = await h.tick('pumpgotchi');
  assert.equal(state.pending, null);
  assert.equal(state.assets[USDC].credit, '0'); assert.equal(state.assets[USDC].converted, '41200000');
  assert.equal(state.totals.convertedSol, '270000000'); assert.equal(state.totals.realizedSol, '270000000');
  assert.equal(state.totals.networkSpent, '9000'); assert.equal(state.gas.reserved, '0'); assert.equal(state.gas.used, '9000');
  assert.equal(state.history.at(-1).state, 'confirmed');
  // A failed conversion keeps the credit and schedules a retry; the fee is charged.
  h.meteoraSources.push({ ...h.meteoraSources[0], signature: signatureOf('meteora-payout-2'), amount: '1000000' }); h.world.finalized.add(signatureOf('meteora-payout-2'));
  h.advance(GOTCHI_POLICY.retryBaseMs * 2); state = await h.tick('pumpgotchi');
  assert.equal(state.pending.kind, 'convert');
  h.world.receipts.set(state.pending.signature, { state: 'failed', signature: state.pending.signature, slot: 210, feeLamports: '5000', inputAmount: '1000000', outputAmount: '0', actualSolCostLamports: '5000' });
  h.advance(11000); state = await h.tick('pumpgotchi');
  assert.equal(state.assets[USDC].credit, '1000000', 'a failed conversion keeps its credit');
  assert.equal(state.totals.realizedSol, '269995000', 'the failed network fee leaves the ledger');
  assert.ok(state.assets[USDC].nextAttemptAt > h.now());
  await h.service.control('acct-1', { id: 'pumpgotchi', conversionPaused: true, reason: 'route review' });
  h.advance(HOUR); state = await h.tick('pumpgotchi');
  assert.equal(state.pending, null, 'paused conversion prepares nothing');
});

test('a full race: sampling, freezing, buying the winner, airdropping and opening the next race', async () => {
  const h = await harness({ solUsd: 200 });
  const target = await h.service.launchTarget('fomogotchi'), rewards = Keypair.generate(), feeWallet = Keypair.generate(), mint = wallet(), curve = wallet(), second = wallet();
  const funding = { signature: signatureOf('big-payout'), amount: '60000000000' };
  const launch = raydiumLaunch({ vault: target.vault, mint, rewards, feeWallet, curve, sources: [funding], now: h.now() });
  h.launches.push(launch);
  const holders = Array.from({ length: 12 }, () => wallet());
  h.world.holders.set(mint, [...holders.map((owner, index) => ({ owner, amount: String((index + 1) * 1000000) })), { owner: feeWallet.publicKey.toBase58(), amount: '999999999999' }, { owner: target.vault, amount: '5000000' }]);
  h.world.holders.set(second, [{ owner: holders[0], amount: '7000000000' }]);
  h.markets.set(mint, { mint, marketCapUsd: 150000, fdvUsd: 150000, priceUsd: 0.00015, stage: 'graduated', stale: false, marketSource: 'test' });
  h.markets.set(second, { mint: second, marketCapUsd: 9000, fdvUsd: 9000, priceUsd: 0.000009, stage: 'graduated', stale: false, marketSource: 'test' });
  h.launches.push({ ...raydiumLaunch({ vault: target.vault, mint: second, rewards: Keypair.generate(), feeWallet: Keypair.generate(), curve: wallet(), sources: [], now: h.now() }), id: 'launch-second' });
  // The pot is empty for the first passes: samples accrue, nothing closes.
  let state = await h.tick();
  assert.equal(state.totals.realizedSol, '0'); assert.equal(state.race.status, 'open');
  let doc = await h.service.loadRace(state);
  assert.equal(doc.sampleCount, 2, 'both graduated coins were sampled');
  assert.equal(Object.keys(doc.coins[mint].balances).length, 12, 'custody and the vault are excluded from the sample');
  h.advance(16 * MIN); state = await h.tick(); doc = await h.service.loadRace(state);
  assert.equal(doc.sampleCount, 4);
  const board = await h.service.leaderboard(state);
  assert.equal(board.projected.length, 10);
  assert.equal(board.projected[0].owner, holders[0], 'the holder of both coins leads');
  assert.equal(board.projected[1].owner, holders[11]);
  const mine = await h.service.holdings(holders[11]);
  assert.equal(mine.gotchis.find(row => row.id === 'fomogotchi').rank, 2);
  // Payments are paused by the owner; the pot then fills: the race still closes at the goal and freezes, nothing is bought.
  await h.service.control('acct-1', { id: 'fomogotchi', settlementPaused: true, reason: 'inspect the frozen plan first' });
  h.world.finalized.add(funding.signature);
  h.advance(MIN); state = await h.tick();
  assert.equal(state.totals.realizedSol, '60000000000');
  assert.ok(state.valuation.potUsd > 10000);
  assert.deepEqual(state.milestones.map(row => row.usd), [2500, 5000, 10000]);
  assert.equal(state.race.status, 'closing'); assert.equal(state.race.cutoffAt, h.now());
  doc = await h.service.loadRace(state); assert.equal(doc.sampleCount, 4, 'sampling stops at the cutoff');
  h.advance(MIN); state = await h.tick();
  assert.equal(state.race.status, 'frozen', 'the plan is frozen while payments wait'); assert.equal(state.pending, null);
  assert.equal((await h.service.inspect('acct-1', { balances: false })).gotchis.find(row => row.id === 'fomogotchi').race.settlement.winner.mint, mint, 'the owner can read the frozen plan');
  h.advance(MIN); state = await h.tick(); assert.equal(state.race.status, 'frozen'); assert.equal(state.pending, null);
  // Resume: frozen → buying in the same pass.
  await h.service.control('acct-1', { id: 'fomogotchi', settlementPaused: false, reason: 'plan reviewed' });
  h.advance(MIN); state = await h.tick();
  assert.equal(state.race.status, 'buying');
  const settlement = state.race.settlement;
  assert.equal(settlement.winner.mint, mint, 'the highest market cap graduated coin wins');
  assert.equal(settlement.winners.length, 10);
  assert.equal(settlement.winners[0].owner, holders[0]);
  assert.equal(settlement.potLamports, '59980000000');
  assert.equal(settlement.reserveLamports, String(10 * Number(GOTCHI_POLICY.recipientReserveLamports)));
  assert.equal(BigInt(settlement.buyLamports) + BigInt(settlement.solLamports) + BigInt(settlement.reserveLamports), 59980000000n);
  assert.equal(state.pending.kind, 'acquire'); assert.equal(state.pending.mint, mint);
  assert.equal(state.pending.inputAmount, GOTCHI_POLICY.maximumBuyChunkLamports, 'purchases are chunked');
  assert.equal(h.service.spendableLamports(state), 0n, 'the frozen pot is not spendable');
  // Confirm purchases until the budget is spent.
  let guard = 0;
  while (state.race.status === 'buying' && guard++ < 40) {
    if (state.pending) h.world.receipts.set(state.pending.signature, { state: 'confirmed', signature: state.pending.signature, slot: 300 + guard, feeLamports: '5000', inputAmount: state.pending.inputAmount, outputAmount: String(BigInt(state.pending.inputAmount) * 3n), actualSolCostLamports: '7000' });
    h.advance(11000); state = await h.tick();
  }
  assert.equal(state.race.status, 'distributing');
  assert.equal(state.race.settlement.buyRemainingLamports, '0');
  assert.equal(state.race.settlement.boughtTokens, (BigInt(settlement.buyLamports) * 3n).toString());
  assert.equal(state.race.settlement.payouts.length, 10);
  const planned = state.race.settlement.payouts.reduce((sum, row) => sum + BigInt(row.lamports), 0n);
  assert.ok(planned <= BigInt(settlement.solLamports) && BigInt(settlement.solLamports) - planned < 10n);
  assert.equal(state.pending.kind, 'airdrop'); assert.equal(state.pending.payouts.length, GOTCHI_POLICY.airdropBatch);
  guard = 0;
  while (state.race.status === 'distributing' && guard++ < 40) {
    if (state.pending) h.world.receipts.set(state.pending.signature, { state: 'confirmed', signature: state.pending.signature, slot: 400 + guard, feeLamports: '5000', outputAmount: '0', actualSolCostLamports: '15000' });
    h.advance(11000); state = await h.tick();
  }
  assert.equal(state.race.status, 'open', 'a new race opened');
  assert.equal(state.race.index, 2);
  assert.equal(state.races.length, 1);
  const done = state.races[0];
  assert.equal(done.winner.mint, mint); assert.equal(done.airdrops.length, 3); assert.ok(done.buys.length >= 1);
  assert.equal(state.celebration.raceIndex, 1);
  const spent = BigInt(done.spentLamports);
  assert.equal(BigInt(state.totals.realizedSol), 60000000000n - spent, 'the ledger is reduced by exactly what settlement spent');
  assert.ok(BigInt(state.totals.realizedSol) >= 20000000n + BigInt(done.solRemainder), 'reserve and rounding remainders carry forward');
  assert.equal(BigInt(state.totals.airdroppedTokens) + BigInt(done.tokenRemainder), BigInt(done.boughtTokens), 'every bought token is airdropped except the integer remainder');
  doc = await h.service.loadRace(state); assert.equal(doc.index, 2); assert.equal(doc.sampleCount, 0);
  const detail = await h.service.detail('fomogotchi');
  assert.equal(detail.history.length, 1); assert.equal(detail.race.index, 2);
  const list = await h.service.list(); assert.equal(list.gotchis.length, 2);
  assert.ok(h.world.chains.every(chain => chain.closed), 'every chain adapter was closed');
});

test('a purchase that keeps exceeding the impact limit shrinks and finally pays SOL instead', async () => {
  const h = await harness({ solUsd: 100000 });
  const target = await h.service.launchTarget('pumpgotchi'), rewards = Keypair.generate(), feeWallet = Keypair.generate(), mint = wallet();
  const funding = { signature: signatureOf('pump-payout'), amount: '400000000' };
  const launch = raydiumLaunch({ vault: target.vault, mint, rewards, feeWallet, curve: wallet(), sources: [funding], now: h.now() });
  launch.input.gotchi = { version: 1, id: 'pumpgotchi', theme: 'pumpgotchi', vault: target.vault }; launch.input.gotchiId = 'pumpgotchi';
  h.launches.push(launch);
  h.world.holders.set(mint, [{ owner: wallet(), amount: '1000000' }]);
  h.markets.set(mint, { mint, marketCapUsd: 50000, fdvUsd: 50000, priceUsd: 0.00005, stage: 'graduated', stale: false, marketSource: 'test' });
  let state = await h.tick('pumpgotchi'); h.advance(16 * MIN); state = await h.tick('pumpgotchi');
  h.world.finalized.add(funding.signature);
  h.advance(MIN); state = await h.tick('pumpgotchi'); assert.equal(state.race.status, 'closing');
  h.advance(MIN); h.world.prepareFailures.push({ code: 'TREASURY_PRICE_IMPACT' }); state = await h.tick('pumpgotchi');
  assert.equal(state.race.status, 'buying'); assert.equal(state.pending, null);
  const budget = BigInt(state.race.settlement.buyLamports);
  assert.ok(BigInt(state.race.settlement.buyChunkLamports) < budget, 'the chunk shrank');
  for (let i = 0; i < 12 && state.race.status === 'buying'; i++) { h.world.prepareFailures.push({ code: 'TREASURY_PRICE_IMPACT' }); h.advance(HOUR); state = await h.tick('pumpgotchi'); }
  assert.equal(state.race.status, 'distributing', 'after repeated minimum-chunk refusals the budget is redirected');
  assert.equal(state.race.settlement.unspentBuyLamports, budget.toString());
  assert.equal(state.race.settlement.boughtTokens, '0');
  assert.equal(state.race.settlement.payouts[0].tokens, '0');
  assert.equal(BigInt(state.race.settlement.payouts[0].lamports), BigInt(state.race.settlement.solLamports) + budget);
  assert.ok(/distributed as SOL/.test(state.race.settlement.buyNote));
});

test('closing waits for valuations, preserves the pot when nothing qualifies and retries later', async () => {
  const h = await harness({ solUsd: 200 });
  const target = await h.service.launchTarget('fomogotchi'), rewards = Keypair.generate(), feeWallet = Keypair.generate(), mint = wallet();
  const funding = { signature: signatureOf('fund'), amount: '60000000000' };
  h.launches.push(raydiumLaunch({ vault: target.vault, mint, rewards, feeWallet, curve: wallet(), sources: [funding], now: h.now() }));
  h.world.finalized.add(funding.signature);
  h.markets.set(mint, { mint, marketCapUsd: null, fdvUsd: null, priceUsd: null, stage: 'graduated', stale: false, marketSource: 'test' });
  h.world.holders.set(mint, []);
  let state = await h.tick(); assert.equal(state.race.status, 'closing');
  h.advance(MIN); state = await h.tick(); assert.equal(state.race.status, 'closing', 'no fresh valuation yet: keep waiting inside the grace period');
  assert.match(state.race.closeNote, /Waiting for a fresh valuation/);
  h.advance(GOTCHI_POLICY.closeGraceMs + MIN); state = await h.tick();
  assert.equal(state.race.status, 'open', 'no valued winner after the grace period: the race reopens');
  assert.match(state.race.closeNote, /pot is preserved/);
  assert.equal(state.totals.realizedSol, '60000000000');
  assert.ok(state.race.nextCloseAt > h.now());
  // A winner with no eligible holders also keeps the pot.
  h.markets.set(mint, { mint, marketCapUsd: 150000, fdvUsd: 150000, priceUsd: 0.00015, stage: 'graduated', stale: false, marketSource: 'test' });
  h.advance(GOTCHI_POLICY.closeRetryMs + MIN); state = await h.tick(); assert.equal(state.race.status, 'closing');
  h.advance(MIN); state = await h.tick(); assert.equal(state.race.status, 'open');
  assert.match(state.race.closeNote, /No eligible holder/);
  await h.service.retry('acct-1', { id: 'fomogotchi' });
  state = await h.service.load('fomogotchi'); assert.equal(state.race.nextCloseAt, 0);
});

test('public views never expose vault secrets and inspect reports controls', async () => {
  const h = await harness();
  await h.service.ensure();
  const list = await h.service.list(), text = JSON.stringify(list), keys = await h.store.read('gotchi-vault-keys');
  for (const key of Object.values(keys.keys)) assert.ok(!text.includes(key.secret));
  const detail = await h.service.detail('fomogotchi'); assert.ok(!JSON.stringify(detail).includes(keys.keys.fomogotchi.secret));
  await assert.rejects(h.service.detail('nope'), /not found/);
  const admin = await h.service.inspect('acct-1', { balances: false });
  assert.equal(admin.gotchis.length, 2); assert.equal(admin.enabled, true);
  assert.ok(!JSON.stringify(admin).includes(keys.keys.fomogotchi.secret));
  await assert.rejects(h.service.inspect('nobody'), /Administrator/);
  await assert.rejects(h.service.holdings('not-a-wallet'), /Invalid Gotchi wallet/);
  assert.equal((await h.service.attachment(wallet())), null);
  // A worker pass shares one RPC adapter across the three Gotchis and closes it.
  await h.service.process();
  assert.equal(h.world.chains.length, 1); assert.ok(h.world.chains[0].closed);
  for (const theme of GOTCHI_THEMES) assert.equal((await h.service.load(theme.id)).error, '');
  // A host without the encrypted store (minimal test hosts) gets 503 answers, never a startup failure.
  const bare = new GotchiService({ accounts: { list: async () => [], get: async () => ({ id: 'acct-1', role: 'admin', mfaEnabled: true }) }, chainFactory: async () => null, now: h.now });
  await assert.rejects(bare.list(), error => error.statusCode === 503);
  await assert.rejects(bare.launchTarget('fomogotchi'), error => error.statusCode === 503);
  await assert.rejects(bare.control('acct-1', { enabled: false, reason: 'maintenance' }), error => error.statusCode === 503);
  assert.deepEqual((await bare.holdings(wallet())).gotchis, []);
  await bare.process(); await bare.close();
});
