import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { AgentService } from '../src/agent/service.mjs';
import { InlineWorker } from '../src/agent/runner.mjs';
import { dryRunModel } from '../src/agent/loop.mjs';
import { ModelRegistry } from '../src/agent/openrouter.mjs';
import { AGENT_POLICY_V1, AGENT_RATE_CARD_V1, AGENT_MODE, AGENT_FUNDING_SUMMARY, AGENT_FUNDING_SUMMARY_V1, capabilityMask } from '../public/agent-catalog.mjs';
import { AGENT_POLICY_HASH, AGENT_POLICY_V2_HASH } from '../src/agent/policy.mjs';

const SOL = 'So11111111111111111111111111111111111111112', USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const MIN = 60000, HOUR = 3600000, MODEL = 'openai/gpt-6-luna';
const wallet = () => Keypair.generate().publicKey.toBase58();
const signatureOf = seed => bs58.encode(createHash('sha512').update(seed).digest());
const rawOf = seed => { const raw = Buffer.from('tx:' + seed).toString('base64'); return { raw, rawHash: createHash('sha256').update(Buffer.from(raw, 'base64')).digest('hex') }; };
const CATALOG = [{ id: MODEL, name: 'GPT-6 Luna', pricing: { prompt: '0.0000001', completion: '0.0000005', request: '0' }, context_length: 1050000, top_provider: { max_completion_tokens: 128000 }, supported_parameters: ['tools', 'structured_outputs'] }];

class FakeStore { constructor() { this.docs = new Map(); } async read(name, fallback = null) { if (!/^[a-z][a-z0-9-]*$/.test(name)) throw Error('Invalid storage name.'); return this.docs.has(name) ? JSON.parse(this.docs.get(name)) : fallback; } async write(name, value) { if (!/^[a-z][a-z0-9-]*$/.test(name)) throw Error('Invalid storage name.'); this.docs.set(name, JSON.stringify(value)); } }
function raydiumAgentLaunch({ attachment, mint, rewards, feeWallet, payer, curve, payouts = [], now, state = 'live' }) {
  const secret = key => bs58.encode(key.secretKey);
  return { id: 'launch-' + mint.slice(0, 6), state, curve, authorizedAt: now - 3 * HOUR, createdAt: now - 4 * HOUR, feeCustody: 'relay',
    input: { route: 'raydium', network: 'mainnet-beta', feeMode: 'creator', taxBps: 0, recipient: attachment.wallet, agent: attachment, quoteMint: SOL, name: 'Granite Goat', symbol: 'GOAT', imageId: '' },
    keys: { mint: { address: mint }, wallet: { address: feeWallet.publicKey.toBase58(), secret: secret(feeWallet) }, payer: { address: payer, external: true }, rewards: { address: rewards.publicKey.toBase58(), secret: secret(rewards) } },
    review: { quoteDecimals: 9, quoteSymbol: 'SOL', price: { usd: '200', at: now } }, credits: { quote: '0', base: '0' },
    rewardsWallet: { version: 1, status: 'active', address: rewards.publicKey.toBase58(), creatorCredits: { base: '0', quote: '0', protocolQuote: '0', taxBase: '0' } },
    operations: [{ kind: 'create', state: 'confirmed', signature: signatureOf('create-' + mint), confirmedAt: now - 3 * HOUR }, ...payouts.map(row => ({ kind: 'payout', state: 'confirmed', signature: row.signature, slot: 100, confirmedAt: now - HOUR, amount: row.amount, payouts: [{ owner: attachment.wallet, amount: row.amount }] }))] };
}
class FakeChain {
  constructor(world) { this.world = world; this.calls = []; }
  async incomingReceipt(source, { wallet: destination }) { this.calls.push(['incomingReceipt', source.signature]); if (!this.world.finalized.has(source.signature)) return null; return { id: source.signature + ':' + source.mint, signature: source.signature, mint: source.mint, wallet: destination, sourceWallet: source.sourceWallet, receivedAmount: source.amount, sourceDebitAmount: source.amount, transferredAmount: source.amount, slot: 120 }; }
  async solUsd() { if (this.world.solUsdError) throw Error(this.world.solUsdError); return { usd: this.world.solUsd, at: this.world.now(), source: 'test' }; }
  async mintSummary(mint) { return { mint, program: TOKEN_PROGRAM, decimals: 6, supply: '1000000000000000', slot: 130, transferFee: null }; }
  async holderSnapshot({ mint, exclude }) { const rows = (this.world.holders.get(mint) || []).filter(row => !exclude.includes(row.owner)); return { mint, slot: 140 + this.world.sequence, at: this.world.now(), rows, scanned: rows.length, skipped: 0, complete: true }; }
  op(kind, request, extra = {}) { const seed = 'op' + (++this.world.sequence); return { kind, mint: request.mint, wallet: request.wallet.address, inputAmount: String(request.lamports ?? request.amount), minimumOutput: extra.minimumOutput || '1', expectedOutput: extra.expectedOutput || '1', signature: signatureOf(seed), ...rawOf(seed), blockhash: 'hash', lastValidBlockHeight: 1000, preparedSlot: 160, createdAt: this.world.now(), accounting: { maxCostLamports: String(request.maxNetworkCostLamports || '5000000'), monitoredAccounts: [], ata: 'ata', program: TOKEN_PROGRAM, decimals: 6, minSolReserve: String(request.minSolReserve || '0'), networkFeeLamports: '5000', beforeSol: '0', beforeTokens: '0' }, ...extra }; }
  async prepareSettlement(request) { this.calls.push(['prepareSettlement', request.lamports, request.minSolReserve]); return this.op('acquire', { ...request, mint: USDC }, { expectedOutput: '60000000', minimumOutput: '59700000' }); }
  async prepareBuyback(request) { this.calls.push(['prepareBuyback', request.mint, request.lamports, request.minSolReserve]); const failure = this.world.prepareFailures.shift(); if (failure) throw Object.assign(Error(failure.message || failure.code), { code: failure.code }); return this.op('acquire', request, { expectedOutput: '5000000', minimumOutput: '4950000' }); }
  async prepareIncinerate(request) { this.calls.push(['prepareIncinerate', request.mint, request.amount]); return this.op('incinerate', request, { minimumOutput: '0', expectedOutput: '0' }); }
  async prepareAirdrop({ wallet: signer, mint, payouts, minSolReserve, maxNetworkCostLamports }) { this.calls.push(['prepareAirdrop', payouts.length]); const seed = 'op' + (++this.world.sequence); const lamports = payouts.reduce((sum, row) => sum + BigInt(row.lamports), 0n); return { kind: 'airdrop', mint, wallet: signer.address, inputAmount: lamports.toString(), tokenAmount: '0', minimumOutput: '0', expectedOutput: '0', payouts: payouts.map(row => ({ ...row, ata: null, minTokens: '0' })), signature: signatureOf(seed), ...rawOf(seed), blockhash: 'hash', lastValidBlockHeight: 1000, preparedSlot: 170, createdAt: this.world.now(), accounting: { maxCostLamports: maxNetworkCostLamports, rentBudgetLamports: '0', networkFeeLamports: '5000', monitoredAccounts: [], ata: null, program: TOKEN_PROGRAM, decimals: 9, minSolReserve, beforeSol: '0', beforeTokens: '0' } }; }
  async broadcast(op) { this.calls.push(['broadcast', op.kind]); this.world.broadcast.push(op.signature); }
  async receipt(op) { const receipt = this.world.receipts.get(op.signature); if (!receipt) return null; return { signature: op.signature, slot: 200, feeLamports: '5000', inputAmount: op.inputAmount, outputAmount: '0', actualSolCostLamports: '5000', outputDecimals: op.accounting?.decimals ?? 6, ...receipt }; }
  async state(op) { return this.world.states.get(op.signature) || { state: 'pending' }; }
  async close() {}
}
async function fixture({ flags = {}, model = dryRunModel(), dryRun = false } = {}) {
  let clock = Date.UTC(2026, 9, 2, 12, 0, 0); const now = () => clock, tick = ms => { clock += ms; };
  const dir = await mkdtemp(join(tmpdir(), 'agent-'));
  const world = { now, finalized: new Set(), receipts: new Map(), states: new Map(), broadcast: [], sequence: 0, solUsd: 200, holders: new Map(), prepareFailures: [] };
  const books = new Map(), accountsList = [{ id: 'acct-1', username: 'mira', role: 'admin', mfaEnabled: true, banned: false, mainWallet: null }, { id: 'acct-2', username: 'bob', role: 'user', mfaEnabled: false, banned: false, mainWallet: null }];
  const accounts = { dir, hostStore: new FakeStore(), list: async () => accountsList, get: async id => accountsList.find(a => a.id === id) || null };
  const launchpad = { book: async id => ({ launches: books.get(id) || [] }) };
  const config = { enabled: true, dryRun, dbPath: join(dir, 'agents.sqlite'), backupDir: '', openrouterKey: 'test-key', models: [MODEL], defaultModel: MODEL, browserbaseKey: '', browserbaseProject: '', browserbaseRegion: '', operatorWallet: wallet(), globalDailyUsd: 10000000n, modelConcurrency: 2, browserConcurrency: 1, domainAllowlist: ['coingecko.com'], rateCard: AGENT_RATE_CARD_V1, workerPath: '' };
  const registry = new ModelRegistry({ allowlist: [MODEL], now, catalog: CATALOG, fetcher: async () => ({ ok: true, json: async () => ({ data: CATALOG }) }) });
  const chains = [];
  const service = new AgentService({ accounts, launchpad, discovery: null, chainFactory: async () => { const chain = new FakeChain(world); chains.push(chain); return chain; }, config, now, registry, worker: new InlineWorker({ model }) });
  const store = await service.ensure();
  store.setSetting('flags', { intake: true, runs: true, model: true, financial: true, settlement: true, browser: false, ...flags }, 'test');
  return { service, store, world, accounts, books, now, tick, chains, dir };
}
function request(overrides = {}) { return { mode: AGENT_MODE, venue: 'raydium', mission: 'Research goat markets and publish honest updates.', personalityPreset: 'analyst', personality: '', model: MODEL, domains: ['coingecko.com'], buyback: true, rewards: true, capabilities: capabilityMask({ buyback: true, rewards: true }), ...overrides }; }

test('launch target provisions a reusable draft and rejects unsupported venues, closed intake and unknown models', async () => {
  const { service, store } = await fixture();
  const first = await service.launchTarget(request(), { accountId: 'acct-2', venue: 'raydium', name: 'Granite Goat', symbol: 'GOAT' });
  assert.equal(first.mode, AGENT_MODE); assert.equal(first.policyHash, AGENT_POLICY_V2_HASH, 'new agents launch under policy v2'); assert.equal(first.policyVersion, 'agent-policy-v2'); assert.match(first.wallet, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  const again = await service.launchTarget(request(), { accountId: 'acct-2', venue: 'raydium', name: 'Granite Goat', symbol: 'GOAT' });
  assert.equal(again.id, first.id); assert.equal(again.wallet, first.wallet);
  const other = await service.launchTarget(request({ mission: 'Different' }), { accountId: 'acct-2', venue: 'raydium' });
  assert.notEqual(other.id, first.id);
  await assert.rejects(service.launchTarget(request({ venue: 'pumpswap' }), { accountId: 'acct-2', venue: 'pumpswap' }), /Raydium, Meteora and Pump\.fun only/);
  assert.equal((await service.launchTarget(request({ venue: 'pump' }), { accountId: 'acct-2', venue: 'pump' })).policyHash, AGENT_POLICY_V2_HASH);
  await assert.rejects(service.launchTarget(request({ model: 'other/model', venue: 'meteora' }), { accountId: 'acct-2', venue: 'meteora' }), /supported list/);
  store.setSetting('flags', { ...service.flags(), intake: false }, 'test');
  await assert.rejects(service.launchTarget(request({ mission: 'x' }), { accountId: 'acct-2', venue: 'raydium' }), error => error.code === 'AGENT_INTAKE_CLOSED');
  const signer = await service.signer(first.id); assert.equal(signer.address, first.wallet);
  assert.equal(store.agent(first.id).mint, null);
  service.close();
});

test('launch -> fee receipts (exactly once, platform share then 30/70) -> settlement -> backing -> activation -> dry run -> sleep and resume', async () => {
  const { service, store, world, books, now, tick, chains } = await fixture();
  const attachment = await service.launchTarget(request(), { accountId: 'acct-2', venue: 'raydium', name: 'Granite Goat', symbol: 'GOAT' });
  const mint = wallet(), rewards = Keypair.generate(), feeWallet = Keypair.generate(), payer = wallet(), curve = wallet();
  const payouts = [{ signature: signatureOf('pay-1'), amount: '1000000001' }, { signature: signatureOf('pay-2'), amount: '400000000' }];
  books.set('acct-2', [raydiumAgentLaunch({ attachment, mint, rewards, feeWallet, payer, curve, payouts, now: now() })]);
  await service.process();
  let agent = store.agent(attachment.id);
  assert.equal(agent.mint, mint); assert.equal(agent.launchState, 'live'); assert.ok(agent.authorityCheckedAt);
  assert.equal(agent.state, 'awaiting_funding');
  // Only finalized receipts credit; the second payout is not finalized yet.
  world.finalized.add(payouts[0].signature);
  tick(MIN); service.launchCache = null; await service.process();
  let balances = store.agentBalances(agent.id);
  // Policy v2 on Raydium: 10% (100,000,000) is set aside for the platform first, then 30/70 of the remaining 900,000,001.
  assert.equal(balances.sol.protocolPayable, '100000000');
  assert.equal(balances.sol.operatingUnsettled, '0'); // 0.27 SOL >= 0.055 SOL, so it was reserved into a settlement batch
  assert.equal(balances.sol.operatingSettling, '270000000'); assert.equal(balances.sol.treasuryAvailable, '630000001');
  assert.equal(store.feeTotals(agent.id).count, 1);
  assert.equal(store.agent(agent.id).state, 'awaiting_settlement');
  // Replays never credit twice; the settlement batch finalizes from its finalized receipt.
  const batch = store.openSettlementBatch(agent.id); assert.equal(batch.state, 'submitted');
  world.receipts.set(batch.operation.signature, { state: 'confirmed', outputAmount: '60000000', actualSolCostLamports: '1000000' });
  world.finalized.add(payouts[1].signature);
  tick(MIN); service.launchCache = null; await service.process();
  balances = store.agentBalances(agent.id);
  assert.equal(store.feeTotals(agent.id).count, 2);
  // The first batch finalized (265,000,000 swapped + 1,000,000 network cost, 4,000,000 of cost reserve returned) and the new
  // operating SOL (30% of 360,000,000 after the 40,000,000 share = 108,000,000, + 4,000,000) was immediately reserved into a second batch.
  assert.equal(balances.usdc.operatingSettled, '60000000'); assert.equal(balances.sol.operatingSettling, '112000000'); assert.equal(balances.sol.operatingUnsettled, '0');
  assert.equal(balances.sol.treasuryAvailable, (630000001n + 252000000n).toString()); assert.equal(balances.sol.protocolPayable, '140000000', 'no remittance without a configured treasury recipient');
  const second = store.openSettlementBatch(agent.id); assert.equal(second.inputLamports, '107000000');
  store.setSetting('flags', { ...service.flags(), settlement: false }, 'test');
  assert.equal(store.ledger.verify().ok, true);
  // Backing: the owner records provider funding with evidence; credits become spendable.
  const provider = await service.recordProviderBatch('acct-1', { reference: 'or-inv-77', evidence: 'OpenRouter invoice or-inv-77 paid with USDC tx abc', paidUsdc: '100', purchaseFeeUsdc: '5.5', creditsUsd: '94.5' });
  await assert.rejects(service.recordProviderBatch('acct-2', { reference: 'x', evidence: 'evidence', paidUsdc: '1', creditsUsd: '1' }), /Administrator/);
  const backed = await service.allocateBacking('acct-1', { batchId: provider.id, reason: 'Back settled USDC' });
  assert.equal(backed.applied.length, 1); assert.equal(backed.applied[0].usd, '56700000');
  assert.equal(store.agentBalances(agent.id).usd.backed, '56700000'); assert.equal(store.agentBalances(agent.id).usdc.operatingSettled, '0');
  service.refreshStates(); agent = store.agent(agent.id);
  assert.equal(agent.state, 'ready'); assert.ok(agent.activatedAt);
  // A scheduled dry run: reservation first, exact settlement after.
  await service.process(); await service.runner.drain();
  const run = store.runs(agent.id)[0];
  assert.ok(run); assert.equal(run.state, 'completed'); assert.equal(run.reservedUsd, '20000'); assert.ok(BigInt(run.spentUsd) > 0n && BigInt(run.spentUsd) < 20000n, run.spentUsd);
  assert.equal(run.modelCalls, 5); assert.equal(run.toolCalls, 4);
  const events = store.events(agent.id, { limit: 20 });
  assert.ok(events.some(event => event.kind === 'update' && event.title.startsWith('[dry run]')));
  assert.equal(store.noteCount(agent.id), 1);
  balances = store.agentBalances(agent.id);
  assert.equal(BigInt(balances.usd.backed) + BigInt(balances.usd.spent), 56700000n); assert.equal(balances.usd.reserved, '0');
  agent = store.agent(agent.id); assert.equal(agent.daySpentUsd, run.spentUsd); assert.equal(agent.state, 'ready');
  // Cadence and start gap: no second run inside 10 minutes.
  await service.process(); await service.runner.drain(); assert.equal(store.runs(agent.id).length, 1);
  tick(31 * MIN); await service.process(); await service.runner.drain(); assert.equal(store.runs(agent.id).length, 2);
  // Sleep below $0.50 and resume only at $2.
  store.ledger.post({ kind: 'test-drain', sourceKey: 'test:drain', agentId: agent.id, entries: [{ owner: 'agent:' + agent.id, asset: 'USD', bucket: 'operating_backed', delta: -(BigInt(store.agentBalances(agent.id).usd.backed) - 400000n) }, { owner: 'external:provider', asset: 'USD', bucket: 'main', delta: BigInt(store.agentBalances(agent.id).usd.backed) - 400000n }] });
  service.refreshStates(); assert.equal(store.agent(agent.id).state, 'sleeping_budget');
  store.ledger.post({ kind: 'test-fund', sourceKey: 'test:fund1', agentId: agent.id, entries: [{ owner: 'external:provider', asset: 'USD', bucket: 'main', delta: -1000000n }, { owner: 'agent:' + agent.id, asset: 'USD', bucket: 'operating_backed', delta: 1000000n }] });
  service.refreshStates(); assert.equal(store.agent(agent.id).state, 'sleeping_budget', 'resume needs $2');
  store.ledger.post({ kind: 'test-fund', sourceKey: 'test:fund2', agentId: agent.id, entries: [{ owner: 'external:provider', asset: 'USD', bucket: 'main', delta: -1000000n }, { owner: 'agent:' + agent.id, asset: 'USD', bucket: 'operating_backed', delta: 1000000n }] });
  service.refreshStates(); assert.equal(store.agent(agent.id).state, 'ready');
  assert.equal(store.ledger.verify().ok, true);
  assert.ok(chains.length > 0);
  service.close();
});

test('a failed or redirected launch never activates; admin pause outranks creator resume; creator cannot raise limits', async () => {
  const { service, store, books, now } = await fixture();
  const attachment = await service.launchTarget(request(), { accountId: 'acct-2', venue: 'raydium' });
  const failed = raydiumAgentLaunch({ attachment, mint: wallet(), rewards: Keypair.generate(), feeWallet: Keypair.generate(), payer: wallet(), curve: null, now: now(), state: 'failed' });
  failed.curve = null; failed.operations = [];
  books.set('acct-2', [failed]);
  await service.process();
  let agent = store.agent(attachment.id); assert.equal(agent.launchState, 'failed'); assert.equal(agent.archived, 1); assert.equal(agent.state, 'archived');
  const second = await service.launchTarget(request({ mission: 'two' }), { accountId: 'acct-2', venue: 'raydium' });
  const live = raydiumAgentLaunch({ attachment: second, mint: wallet(), rewards: Keypair.generate(), feeWallet: Keypair.generate(), payer: wallet(), curve: wallet(), now: now() });
  live.feeRecipientRedirectedAt = now();
  books.set('acct-2', [failed, live]); service.launchCache = null;
  await service.process();
  agent = store.agent(second.id); assert.equal(agent.integrityPaused, 1); assert.equal(agent.state, 'provisioning');
  const session = { account: { id: 'acct-2', authType: 'password' } };
  await assert.rejects(service.revise(session, { mint: live.keys.mint.address, model: 'other/model' }), /supported list/);
  await assert.rejects(service.revise({ account: { id: 'acct-1', authType: 'password' } }, { mint: live.keys.mint.address, mission: 'hijack' }), /creator account/);
  await service.control('acct-1', { agentId: second.id, adminPaused: true, reason: 'Manual review of the recipient.' });
  await service.setCreatorPause(session, { mint: live.keys.mint.address, paused: false });
  await service.control('acct-1', { agentId: second.id, clearIntegrity: true, reason: 'Recipient verified manually.' });
  live.feeRecipientRedirectedAt = undefined; delete live.feeRecipientRedirectedAt; service.launchCache = null; await service.process();
  assert.equal(store.agent(second.id).state, 'paused_admin');
  await service.control('acct-1', { agentId: second.id, adminPaused: false, reason: 'Review complete.' });
  service.refreshStates(); assert.equal(store.agent(second.id).state, 'awaiting_funding');
  service.close();
});

test('proposals are bounded by policy, executed through journaled legs, burn only the purchased delta and never re-buy after a burn failure', async () => {
  const proposer = () => { let step = 0; return async () => { step++; if (step === 1) return { id: 'g-1', message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'propose_buyback_burn', arguments: JSON.stringify({ amountSol: 5, reason: 'Fees accumulated; buy and burn per policy.' }) } }] }, usage: { promptTokens: 1000, completionTokens: 50, costUsd: 300n } }; if (step === 2) return { id: 'g-2', message: { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'propose_holder_reward', arguments: JSON.stringify({ amountSol: 0.5, reason: 'Reward holders.' }) } }] }, usage: { promptTokens: 1200, completionTokens: 40, costUsd: 300n } }; return { id: 'g-3', message: { role: 'assistant', content: 'Proposed a buyback and a reward.' }, usage: { promptTokens: 1300, completionTokens: 30, costUsd: 300n } }; }; };
  const { service, store, world, books, now, tick } = await fixture({ model: proposer() });
  const attachment = await service.launchTarget(request(), { accountId: 'acct-2', venue: 'raydium' });
  const mint = wallet(), launch = raydiumAgentLaunch({ attachment, mint, rewards: Keypair.generate(), feeWallet: Keypair.generate(), payer: wallet(), curve: wallet(), now: now(), payouts: [{ signature: signatureOf('big'), amount: '20000000000' }] });
  books.set('acct-2', [launch]); world.finalized.add(signatureOf('big'));
  store.setSetting('flags', { ...service.flags(), settlement: false }, 'test');
  await service.process();
  const agent = store.agent(attachment.id); assert.equal(store.agentBalances(agent.id).sol.treasuryAvailable, '12600000000'); // 20 SOL - 2 SOL platform share - 30% operations
  store.ledger.post({ kind: 'test-fund', sourceKey: 'test:fund', agentId: agent.id, entries: [{ owner: 'external:provider', asset: 'USD', bucket: 'main', delta: -5000000n }, { owner: 'agent:' + agent.id, asset: 'USD', bucket: 'operating_backed', delta: 5000000n }] });
  service.refreshStates(); assert.equal(store.agent(agent.id).state, 'ready');
  await service.process(); await service.runner.drain(); await service.process();
  const run = store.runs(agent.id)[0]; assert.equal(run.state, 'completed'); assert.equal(run.spentUsd, '900');
  const actions = store.actions(agent.id); assert.equal(actions.length, 2);
  const reward = actions.find(a => a.kind === 'holder_reward'), buyback = actions.find(a => a.kind === 'buyback_burn');
  assert.equal(buyback.evaluation.ok, true, JSON.stringify(buyback.evaluation));
  // 12.6 SOL treasury at $200: per action min($10 = 0.05 SOL, 2% ≈ 0.25 SOL) -> 0.05 SOL, bounded from the requested 5 SOL.
  assert.equal(buyback.evaluation.principal, '50000000'); assert.equal(buyback.evaluation.bounded, true);
  assert.equal(reward.state, 'rejected'); assert.match(reward.evaluation.reason, /already in progress/);
  // Execution: reserve, journal the buy leg, broadcast.
  let current = store.action(buyback.id);
  assert.equal(current.state, 'submitted'); assert.equal(store.legs(buyback.id).length, 1);
  assert.equal(store.agentBalances(agent.id).sol.treasuryReserved, '57000000');
  const buyLeg = store.legs(buyback.id)[0];
  assert.ok(world.broadcast.includes(buyLeg.signature));
  // Buy finalizes with a token delta; then a burn leg for exactly that delta. The first burn fails: no re-buy, burn retried.
  world.receipts.set(buyLeg.signature, { state: 'confirmed', outputAmount: '4990000', actualSolCostLamports: '7000' });
  tick(MIN); await service.process();
  current = store.action(buyback.id); assert.ok(current.outcome, JSON.stringify({ state: current.state, error: current.error, legs: store.legs(buyback.id).map(l => [l.kind, l.state, l.error]) })); assert.equal(current.state, 'submitted'); assert.equal(current.outcome.bought, '4990000');
  assert.equal(store.agentBalances(agent.id).tokens[mint].pendingBurn, '4990000');
  const burnLeg = store.legs(buyback.id)[1]; assert.equal(burnLeg.kind, 'burn'); assert.equal(burnLeg.operation.inputAmount, '4990000');
  world.receipts.set(burnLeg.signature, { state: 'failed', actualSolCostLamports: '5000', error: { InstructionError: [0, 'Custom'] } });
  tick(MIN); await service.process();
  current = store.action(buyback.id); assert.equal(current.state, 'confirmed_pending_finality'); assert.match(current.error, /fresh burn/);
  assert.equal(store.legs(buyback.id).length, 2);
  tick(2 * MIN); await service.process();
  const secondBurn = store.legs(buyback.id)[2]; assert.ok(secondBurn, JSON.stringify({ action: store.action(buyback.id), legs: store.legs(buyback.id).map(l => [l.kind, l.state]), alerts: store.openAlerts() })); assert.equal(secondBurn.kind, 'burn'); assert.equal(secondBurn.operation.inputAmount, '4990000');
  assert.equal(world.calls?.length, undefined);
  world.receipts.set(secondBurn.signature, { state: 'confirmed', actualSolCostLamports: '5000', outputAmount: '4990000' });
  tick(MIN); await service.process();
  current = store.action(buyback.id); assert.equal(current.state, 'finalized'); assert.equal(current.outcome.burned, '4990000');
  const balances = store.agentBalances(agent.id);
  assert.equal(balances.tokens[mint].pendingBurn, '0'); assert.equal(balances.sol.treasuryReserved, '0');
  assert.equal(balances.sol.treasuryAvailable, (12600000000n - 50000000n - 7000n - 5000n - 5000n).toString());
  assert.equal(store.ledger.verify().ok, true);
  service.close();
});

test('holder rewards need a complete hour of snapshots, freeze a deterministic top list and pay in batches', async () => {
  const proposer = () => { let step = 0; return async () => { step++; if (step === 1) return { id: 'r-1', message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'propose_holder_reward', arguments: JSON.stringify({ amountSol: 0.1, reason: 'Reward loyal holders.' }) } }] }, usage: { promptTokens: 1000, completionTokens: 50, costUsd: 300n } }; return { id: 'r-2', message: { role: 'assistant', content: 'Proposed rewards.' }, usage: { promptTokens: 1000, completionTokens: 20, costUsd: 300n } }; }; };
  const { service, store, world, books, now, tick } = await fixture({ model: proposer() });
  const attachment = await service.launchTarget(request(), { accountId: 'acct-2', venue: 'raydium' });
  const mint = wallet(), launch = raydiumAgentLaunch({ attachment, mint, rewards: Keypair.generate(), feeWallet: Keypair.generate(), payer: wallet(), curve: wallet(), now: now(), payouts: [{ signature: signatureOf('big'), amount: '20000000000' }] });
  books.set('acct-2', [launch]); world.finalized.add(signatureOf('big'));
  store.setSetting('flags', { ...service.flags(), settlement: false }, 'test');
  const holders = ['A', 'B', 'C', 'D', 'E', 'F'].map(() => wallet()).sort();
  world.holders.set(mint, holders.map((owner, index) => ({ owner, amount: String((index + 1) * 1000000) })));
  world.holders.get(mint).push({ owner: attachment.wallet, amount: '999999999' }, { owner: launch.keys.payer.address, amount: '888888888' });
  await service.process();
  const agent = store.agent(attachment.id);
  store.ledger.post({ kind: 'test-fund', sourceKey: 'test:fund', agentId: agent.id, entries: [{ owner: 'external:provider', asset: 'USD', bucket: 'main', delta: -5000000n }, { owner: 'agent:' + agent.id, asset: 'USD', bucket: 'operating_backed', delta: 5000000n }] });
  service.refreshStates();
  await service.process(); await service.runner.drain(); await service.process();
  let action = store.actions(agent.id)[0]; assert.equal(action.kind, 'holder_reward'); assert.equal(action.evaluation.ok, true, JSON.stringify(action.evaluation));
  // Only ~15 minutes of snapshots exist: the reward is deferred (rejected with a deferral reason), nothing reserved.
  assert.equal(store.action(action.id).state, 'rejected'); assert.match(store.action(action.id).error, /deferred/);
  assert.equal(store.agentBalances(agent.id).sol.treasuryReserved, '0');
  // Build one hour of 5-minute snapshots (one holder drops out of one sample: excluded).
  for (let i = 0; i < 13; i++) { tick(5 * MIN); if (i === 6) world.holders.set(mint, world.holders.get(mint).filter(row => row.owner !== holders[0])); else if (i === 7) world.holders.get(mint).push({ owner: holders[0], amount: '1000000' }); await service.executor.sampleHolders(await service.chainFactory()); }
  const samples = store.holderSamples(agent.id, { from: 0, to: now() }); assert.ok(samples.length >= 13);
  tick(4 * MIN);
  // A fresh proposal now executes: frozen cycle, deterministic recipients (agent, creator and the dropped holder excluded).
  service.runner.worker = new InlineWorker({ model: proposer() });
  await service.process(); await service.runner.drain(); await service.process();
  action = store.actions(agent.id, { limit: 1 })[0]; assert.equal(action.kind, 'holder_reward');
  const cycle = store.rewardCycleForAction(action.id); assert.ok(cycle, JSON.stringify({ action, samples: store.holderSamples(agent.id, { from: 0, to: now() }).map(s => [s.at, s.holderCount, s.complete]), now: now(), runs: store.runs(agent.id).map(r => [r.state, r.error, r.toolCalls]) }));
  assert.equal(cycle.totalLamports, '50000000'); // min($10=0.05 SOL, 2%) cap applies to the 0.1 SOL request
  const recipients = cycle.recipients.map(row => row.owner);
  assert.ok(!recipients.includes(attachment.wallet)); assert.ok(!recipients.includes(launch.keys.payer.address)); assert.ok(!recipients.includes(holders[0]));
  assert.equal(recipients.length, 5);
  const total = cycle.recipients.reduce((sum, row) => sum + BigInt(row.lamports), 0n); assert.equal(total, 50000000n);
  assert.equal(store.agentBalances(agent.id).sol.rewardFrozen, '50000000');
  const first = store.legs(action.id)[0]; assert.equal(first.kind, 'reward'); assert.equal(first.operation.payouts.length, 4);
  world.receipts.set(first.signature, { state: 'confirmed', actualSolCostLamports: '9000', outputAmount: '0' });
  tick(MIN); await service.process();
  const second = store.legs(action.id)[1]; assert.ok(second); assert.equal(second.operation.payouts.length, 1);
  world.receipts.set(second.signature, { state: 'confirmed', actualSolCostLamports: '9000', outputAmount: '0' });
  tick(MIN); await service.process();
  assert.equal(store.action(action.id).state, 'finalized', JSON.stringify({ error: store.action(action.id).error, legs: store.legs(action.id).map(l => [l.kind, l.state, l.error]), debts: store.debts(cycle.id).map(d => d.state) }));
  assert.equal(store.agentBalances(agent.id).sol.rewardFrozen, '0'); assert.equal(store.agentBalances(agent.id).sol.treasuryReserved, '0');
  assert.equal(store.debts(cycle.id).filter(debt => debt.state === 'paid').length, 5);
  assert.equal(store.ledger.verify().ok, true);
  service.close();
});

test('missing provider credentials, kill switches and ledger alerts stop runs without touching fee ingestion', async () => {
  const { service, store, world, books, now } = await fixture({ flags: { runs: false } });
  const attachment = await service.launchTarget(request(), { accountId: 'acct-2', venue: 'raydium' });
  const mint = wallet(); books.set('acct-2', [raydiumAgentLaunch({ attachment, mint, rewards: Keypair.generate(), feeWallet: Keypair.generate(), payer: wallet(), curve: wallet(), now: now(), payouts: [{ signature: signatureOf('p'), amount: '1000000000' }] })]);
  world.finalized.add(signatureOf('p'));
  store.setSetting('flags', { ...service.flags(), settlement: false }, 'test');
  await service.process();
  const agent = store.agent(attachment.id);
  assert.equal(store.agentBalances(agent.id).sol.treasuryAvailable, '630000000');
  store.ledger.post({ kind: 'test-fund', sourceKey: 'test:fund', agentId: agent.id, entries: [{ owner: 'external:provider', asset: 'USD', bucket: 'main', delta: -5000000n }, { owner: 'agent:' + agent.id, asset: 'USD', bucket: 'operating_backed', delta: 5000000n }] });
  service.refreshStates(); assert.equal(store.agent(agent.id).state, 'paused_provider');
  await service.process(); assert.equal(store.runs(agent.id).length, 0);
  store.setSetting('flags', { ...service.flags(), runs: true }, 'test'); service.refreshStates(); assert.equal(store.agent(agent.id).state, 'ready');
  store.raiseAlert({ scope: 'global', code: 'ledger', message: 'drift' });
  await service.process(); assert.equal(store.runs(agent.id).length, 0);
  store.clearAlert('global', 'ledger'); await service.process(); await service.runner.drain(); assert.equal(store.runs(agent.id).length, 1);
  service.close();
});

test('agents launched before v71.18 keep policy v1: receipts split 30/70 with no platform share', async () => {
  const { service, store, world, books, now } = await fixture();
  const attachment = await service.launchTarget(request(), { accountId: 'acct-2', venue: 'raydium' });
  // Simulate an agent provisioned by v71.17 (policy v1); the service never changes an agent's policy.
  store.db.run('UPDATE agents SET policy_hash = ?, policy_version = ? WHERE id = ?', AGENT_POLICY_HASH, AGENT_POLICY_V1.version, attachment.id);
  const legacy = { ...attachment, policyHash: AGENT_POLICY_HASH, policyVersion: AGENT_POLICY_V1.version };
  const mint = wallet(); books.set('acct-2', [raydiumAgentLaunch({ attachment: legacy, mint, rewards: Keypair.generate(), feeWallet: Keypair.generate(), payer: wallet(), curve: wallet(), now: now(), payouts: [{ signature: signatureOf('legacy'), amount: '1000000000' }] })]);
  world.finalized.add(signatureOf('legacy'));
  store.setSetting('flags', { ...service.flags(), settlement: false }, 'test');
  await service.process();
  const sol = store.agentBalances(attachment.id).sol;
  assert.equal(store.agent(attachment.id).policyHash, AGENT_POLICY_HASH);
  assert.equal(sol.treasuryAvailable, '700000000'); assert.equal(sol.operatingUnsettled, '300000000'); assert.equal(sol.protocolPayable ?? '0', '0');
  const detail = service.views.detail(mint);
  assert.equal(detail.policyVersion, AGENT_POLICY_V1.version); assert.equal(detail.funding, AGENT_FUNDING_SUMMARY_V1.raydium, 'legacy agents show their original funding terms');
  assert.doesNotMatch(detail.funding, /platform share/); assert.match(AGENT_FUNDING_SUMMARY.raydium, /platform share/);
  assert.equal(store.ledger.verify().ok, true);
  service.close();
});

test('dry run: a live agent activates and runs the labelled mock model with no backed credit, no ledger movement and no provider usage', async () => {
  const { service, store, books, now, tick } = await fixture({ dryRun: true, flags: { settlement: false, financial: false } });
  assert.equal(service.effective().dryRun, true); assert.equal(service.effective().settlementOpen, false); assert.equal(service.effective().modelOpen, true);
  const attachment = await service.launchTarget(request(), { accountId: 'acct-2', venue: 'raydium', name: 'Granite Goat', symbol: 'GOAT' });
  books.set('acct-2', [raydiumAgentLaunch({ attachment, mint: wallet(), rewards: Keypair.generate(), feeWallet: Keypair.generate(), payer: wallet(), curve: wallet(), payouts: [], now: now() })]);
  await service.process(); await service.runner.drain();
  let agent = store.agent(attachment.id);
  assert.equal(agent.launchState, 'live'); assert.ok(agent.activatedAt); assert.ok(store.events(agent.id, { limit: 10 }).some(event => event.kind === 'activated' && /Dry run/.test(event.body)));
  assert.equal(store.agentBalances(agent.id).usd.backed, '0');
  const run = store.runs(agent.id)[0];
  assert.ok(run, 'a mock run started without credit'); assert.equal(run.state, 'completed'); assert.equal(!!run.dryRun, true); assert.equal(run.reservedUsd, '0'); assert.equal(run.spentUsd, '0'); assert.equal(run.disputedUsd, '0');
  assert.equal(run.modelCalls, 5); assert.equal(run.toolCalls, 4);
  const balances = store.agentBalances(agent.id);
  assert.equal(balances.usd.reserved, '0'); assert.equal(balances.usd.spent, '0'); assert.equal(store.ledger.verify().ok, true);
  const usage = store.usage(run.id); assert.ok(usage.length >= 5); assert.ok(usage.every(row => row.provider === 'dry-run' && row.costUsd === '0' && row.state === 'resolved'));
  assert.ok(store.events(agent.id, { limit: 20 }).some(event => event.kind === 'run' && event.title.startsWith('[dry run]') && event.data.estimatedUsd !== undefined));
  assert.ok(store.events(agent.id, { limit: 20 }).some(event => event.kind === 'update' && event.title.startsWith('[dry run]')));
  agent = store.agent(agent.id); assert.equal(agent.state, 'ready'); assert.match(agent.stateReason || '', /Dry run/);
  // Cadence still applies: no second run inside 30 minutes, one after.
  tick(5 * MIN); await service.process(); await service.runner.drain(); assert.equal(store.runs(agent.id).length, 1);
  tick(31 * MIN); await service.process(); await service.runner.drain(); assert.equal(store.runs(agent.id).length, 2);
  assert.equal(store.openAlerts().length, 0);
  service.close();
});

test('public agent feeds clamp every page size and funding lookups with a missing id are a plain 404', async t => {
  const { agentConfig } = await import('../src/agent/service.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'agent-limits-'));
  const service = new AgentService({ accounts: { dir, hostStore: { read: async () => null, write: async () => {} } }, config: { ...agentConfig({ LAUNCHPAD_AGENTS_ENABLED: '1', LAUNCHPAD_AGENTS_DRY_RUN: '1' }), dbPath: join(dir, 'agents.sqlite') } });
  t.after(async () => { await service.close?.(); rmSync(dir, { recursive: true, force: true }); });
  const store = await service.ensure(), mint = wallet();
  const agent = store.createAgent({ mint, route: 'pump', accountId: 'b'.repeat(32), wallet: wallet(), name: 'A', symbol: 'A', policyHash: AGENT_POLICY_HASH, policyVersion: '1', capabilities: 1, model: MODEL, state: 'ready', mission: 'Do things.' });
  for (let i = 0; i < 150; i++) store.addEvent({ agentId: agent.id, kind: 'update', title: 'Update ' + i, body: 'x' });
  const views = service.views;
  for (const [limit, expected] of [['30', 30], ['100000', 100], ['-1', 1], ['-500', 1], ['0', 30], ['abc', 30], [undefined, 30], ['2.9', 2], ['Infinity', 100]]) assert.equal(views.activity(mint, { limit }).events.length, expected, String(limit));
  for (const [read, cap] of [[options => views.runs(mint, options).runs, 50], [options => views.memory(mint, options).notes, 100], [options => views.receipts(mint, options).fees, 200]]) assert.ok(read({ limit: '-1' }).length <= cap);
  assert.ok(views.list({ limit: -1 }).agents.length <= 1);
  const session = { account: { id: 'b'.repeat(32) } };
  for (const body of [{}, { intentId: null }, { intentId: 5 }, { intentId: 'x' }, { intentId: 'f'.repeat(24) }]) {
    await assert.rejects(service.cancelFunding(session, body), error => error.statusCode === 404 && error.message === 'Funding deposit not found.', JSON.stringify(body));
    await assert.rejects(service.fundingStatus(session, body), error => error.statusCode === 404 && error.message === 'Funding deposit not found.', JSON.stringify(body));
  }
});

// v71.37 moderation: an admin hides an agent from the public directory with a reason; the public gets a 404 for it, its creator and
// admins still open it with the note, the directory marks it for admins only, and unhiding clears the note.
test('moderation (v71.37): a hidden agent leaves the public directory and detail but stays visible to its creator and to admins, with the reason, who and when; unhiding restores it', async () => {
  const { service, store, books, now } = await fixture();
  const attachment = await service.launchTarget(request(), { accountId: 'acct-2', venue: 'raydium' }), mint = wallet();
  const live = raydiumAgentLaunch({ attachment, mint, rewards: Keypair.generate(), feeWallet: Keypair.generate(), payer: wallet(), curve: wallet(), now: now() });
  books.set('acct-2', [live]); await service.process();
  const agent = store.agent(attachment.id); assert.equal(agent.mint, mint); assert.equal(agent.hidden, 0);
  const views = service.views, creator = { accountId: 'acct-2', moderator: false }, admin = { accountId: 'acct-1', moderator: true }, stranger = { accountId: 'acct-9', moderator: false };
  assert.equal(views.list().agents.length, 1); assert.equal(views.list().moderator, false); assert.equal(views.detail(mint).moderation, null);
  await assert.rejects(service.control('acct-1', { agentId: agent.id, hidden: true, reason: 'spam' }), /between 5 and 500 characters/);
  await assert.rejects(service.control('acct-2', { agentId: agent.id, hidden: true, reason: 'Impersonates a listed project.' }), /administrator|Administrator/);
  await service.control('acct-1', { agentId: agent.id, hidden: true, reason: 'Impersonates a listed project.' });
  const hidden = store.agent(agent.id); assert.equal(hidden.hidden, 1); assert.equal(hidden.hiddenReason, 'Impersonates a listed project.'); assert.equal(hidden.hiddenAt, now()); assert.equal(hidden.hiddenBy, 'mira');
  // The public: gone from the list, 404 on every read model.
  assert.deepEqual(views.list().agents, []); assert.deepEqual(views.list({ viewer: stranger }).agents, []);
  for (const read of [() => views.detail(mint), () => views.activity(mint), () => views.treasury(mint), () => views.runs(mint), () => views.receipts(mint), () => views.memory(mint), () => views.browser(mint), () => views.detail(mint, { viewer: stranger })]) assert.throws(read, error => error.statusCode === 404);
  // The creator: opens it with the note (no moderator name); an admin: listed with the note, including who hid it.
  const mine = views.detail(mint, { viewer: creator }); assert.deepEqual(mine.moderation, { hidden: true, reason: 'Impersonates a listed project.', at: now() });
  assert.equal(views.activity(mint, { viewer: creator }).events.length >= 0, true); assert.equal(views.treasury(mint, { viewer: creator }).mint, mint);
  const forAdmin = views.list({ viewer: admin }); assert.equal(forAdmin.moderator, true); assert.equal(forAdmin.agents.length, 1); assert.deepEqual(forAdmin.agents[0].moderation, { hidden: true, reason: 'Impersonates a listed project.', at: now(), by: 'mira' });
  assert.deepEqual(views.detail(mint, { viewer: admin }).moderation, { hidden: true, reason: 'Impersonates a listed project.', at: now(), by: 'mira' });
  assert.equal(service.creatorView(store.agent(agent.id)).moderation.reason, 'Impersonates a listed project.');
  // The launch-book sync (every process pass) must not undo a moderator's hide: before v71.37 it mirrored the coin's flag back.
  await service.process(); assert.equal(store.agent(agent.id).hidden, 1, 'the hide survives the launch sync');
  const row = (await views.inspect('acct-1')).agents.find(item => item.id === agent.id); assert.equal(row.hidden, true); assert.equal(row.hiddenReason, 'Impersonates a listed project.'); assert.equal(row.hiddenBy, 'mira'); assert.equal(row.hiddenAt, now());
  assert.equal(store.events(agent.id, { limit: 5, publicOnly: false }).some(event => event.title === 'Hidden by moderation' && !event.isPublic), true, 'the hide is recorded as a private event'); assert.equal(store.events(agent.id, { limit: 5 }).some(event => event.title === 'Hidden by moderation'), false, 'and never in the public feed');
  assert.equal(store.auditLog(5)[0].reason, 'Impersonates a listed project.');
  // Unhide: back in the public list, note gone, columns cleared.
  await service.control('acct-1', { agentId: agent.id, hidden: false, reason: 'Resolved with the creator.' });
  const shown = store.agent(agent.id); assert.equal(shown.hidden, 0); assert.equal(shown.hiddenReason, ''); assert.equal(shown.hiddenAt, null); assert.equal(shown.hiddenBy, '');
  assert.equal(views.list().agents.length, 1); assert.equal(views.detail(mint).moderation, null); assert.equal(service.creatorView(shown).moderation, null);
  // A coin hidden in Token management hides its agent (by "coin") and unhiding the coin brings it back; a moderator's hide outlives both.
  live.moderation = { hidden: true }; service.launchCache = null; await service.process();
  const byCoin = store.agent(agent.id); assert.equal(byCoin.hidden, 1); assert.equal(byCoin.hiddenBy, 'coin'); assert.equal(byCoin.hiddenReason, 'The coin is hidden in Token management.'); assert.deepEqual(views.list().agents, []);
  live.moderation = { hidden: false }; service.launchCache = null; await service.process(); assert.equal(store.agent(agent.id).hidden, 0); assert.equal(views.list().agents.length, 1);
  await service.control('acct-1', { agentId: agent.id, hidden: true, reason: 'Hidden again by a moderator.' });
  live.moderation = { hidden: true }; service.launchCache = null; await service.process(); live.moderation = { hidden: false }; service.launchCache = null; await service.process();
  const kept = store.agent(agent.id); assert.equal(kept.hidden, 1); assert.equal(kept.hiddenBy, 'mira'); assert.equal(kept.hiddenReason, 'Hidden again by a moderator.');
  service.close();
});
