import test from 'node:test';
import assert from 'node:assert/strict';
import { openAgentDatabase } from '../src/agent/db.mjs';
import { AgentStore } from '../src/agent/store.mjs';
import { AGENT_POLICY_HASH } from '../src/agent/policy.mjs';
import { AGENT_POLICY_V1, AGENT_RATE_CARD_V1, capabilityMask } from '../public/agent-catalog.mjs';
import { tokenAsset } from '../src/agent/ledger.mjs';

const SOL = 'So11111111111111111111111111111111111111112';
const MINT = 'GoatCoin1111111111111111111111111111111111', WALLET = 'AgentWa11et111111111111111111111111111111', CREATOR = 'Creator11111111111111111111111111111111111';
const SIG = '5'.repeat(88);
let clock = 1_700_000_000_000; const now = () => clock;

async function fixture() {
  const db = await openAgentDatabase(':memory:', { now }), store = new AgentStore(db, { now });
  store.savePolicy({ hash: AGENT_POLICY_HASH, version: AGENT_POLICY_V1.version, document: AGENT_POLICY_V1, rateCard: AGENT_RATE_CARD_V1 });
  const agent = store.createAgent({ mint: MINT, route: 'raydium', launchId: 'launch-1', accountId: 'acct-1', wallet: WALLET, name: 'Goat', symbol: 'GOAT', image: null, policyHash: AGENT_POLICY_HASH, policyVersion: AGENT_POLICY_V1.version, capabilities: capabilityMask({ buyback: true }), model: 'openai/gpt-6-luna', mission: 'Research goats.', creatorWallet: CREATOR });
  return { db, store, agent };
}

test('agents are unique per mint and wallet, with revisions', async () => {
  const { db, store, agent } = await fixture();
  assert.equal(agent.state, 'provisioning'); assert.equal(agent.revision, 1);
  assert.throws(() => store.createAgent({ mint: MINT, route: 'raydium', launchId: 'launch-2', accountId: 'acct-1', wallet: 'Xther' + WALLET.slice(5), name: 'Dup', symbol: 'DUP', policyHash: AGENT_POLICY_HASH, policyVersion: 'agent-policy-v1', capabilities: 3, model: 'm', mission: 'x' }), /UNIQUE/);
  assert.throws(() => store.createAgent({ mint: 'Xther' + MINT.slice(5), route: 'pumpswap', launchId: 'l', accountId: 'a', wallet: 'Xther' + WALLET.slice(5), name: 'x', symbol: 'x', policyHash: AGENT_POLICY_HASH, policyVersion: 'v', capabilities: 3, model: 'm', mission: 'x' }), /Unsupported agent route/);
  assert.throws(() => store.updateAgent(agent.id, { policyHash: 'x' }), /cannot be updated/);
  assert.equal(store.addRevision(agent.id, { actor: 'creator', kind: 'mission', changes: { mission: 'New' } }), 2);
  assert.equal(store.agent(agent.id).revision, 2);
  assert.equal(store.agentByMint(MINT).id, agent.id); assert.equal(store.agentByWallet(WALLET).id, agent.id);
  const page = store.listAgents({ limit: 1 }); assert.equal(page.agents.length, 1); assert.equal(page.nextCursor, null);
  db.close();
});

test('fee receipts credit exactly once and split 30/70', async () => {
  const { db, store, agent } = await fixture();
  const first = store.recordFeeReceipt({ agentId: agent.id, signature: SIG, allocation: `${MINT}:0`, venue: 'raydium', launchMint: MINT, sourceWallet: CREATOR, mint: SOL, amount: '1000000001', slot: 10 });
  assert.equal(first.duplicate, false); assert.equal(first.operations, 300000000n); assert.equal(first.treasury, 700000001n);
  const again = store.recordFeeReceipt({ agentId: agent.id, signature: SIG, allocation: `${MINT}:0`, venue: 'raydium', launchMint: MINT, sourceWallet: CREATOR, mint: SOL, amount: '1000000001', slot: 10 });
  assert.equal(again.duplicate, true);
  // The same transaction can carry a second allocation (another payout row): different allocation identity.
  store.recordFeeReceipt({ agentId: agent.id, signature: SIG, allocation: `${MINT}:1`, venue: 'raydium', launchMint: MINT, sourceWallet: CREATOR, mint: SOL, amount: '10', slot: 10 });
  const balances = store.agentBalances(agent.id);
  assert.equal(balances.sol.operatingUnsettled, '300000003'); assert.equal(balances.sol.treasuryAvailable, '700000008');
  assert.throws(() => store.recordFeeReceipt({ agentId: agent.id, signature: SIG, allocation: 'usdc', venue: 'raydium', launchMint: MINT, sourceWallet: CREATOR, mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amount: '5', slot: 10 }), /must be SOL/);
  assert.equal(store.feeTotals(agent.id).count, 2);
  assert.equal(store.ledger.verify().ok, true);
  db.close();
});

test('funding intents credit once, by purpose, and reject mismatched amounts', async () => {
  const { db, store, agent } = await fixture();
  const intent = store.createIntent({ agentId: agent.id, accountId: 'acct-9', purpose: 'activity', sender: CREATOR, recipient: WALLET, mint: SOL, amount: '2000000000', memo: 'agent:' + agent.id + ':abc', messageHash: 'h', unsignedRaw: 'raw', blockhash: 'b', lastValidBlockHeight: 10, preparedSlot: 5, expiresAt: now() + 120000 });
  assert.equal(intent.state, 'awaiting_signature');
  assert.throws(() => store.creditIntent(intent.id, { signature: SIG, slot: 7, receivedAmount: '1999999999' }), error => error.code === 'AGENT_INTENT_MISMATCH');
  assert.equal(store.creditIntent(intent.id, { signature: SIG, slot: 7, receivedAmount: '2000000000' }).duplicate, false);
  assert.equal(store.creditIntent(intent.id, { signature: SIG, slot: 7, receivedAmount: '2000000000' }).duplicate, true);
  assert.equal(store.agentBalances(agent.id).sol.operatingUnsettled, '2000000000');
  assert.equal(store.intent(intent.id).unsignedRaw, null);
  const treasury = store.createIntent({ agentId: agent.id, accountId: 'acct-9', purpose: 'treasury', sender: CREATOR, recipient: WALLET, mint: SOL, amount: '5', memo: 'agent:' + agent.id + ':def', messageHash: 'h', unsignedRaw: 'raw', blockhash: 'b', lastValidBlockHeight: 10, preparedSlot: 5, expiresAt: now() + 120000 });
  store.creditIntent(treasury.id, { signature: '6'.repeat(88), slot: 8, receivedAmount: '5' });
  assert.equal(store.agentBalances(agent.id).sol.treasuryAvailable, '5');
  assert.throws(() => store.createIntent({ agentId: agent.id, accountId: 'a', purpose: 'treasury', sender: CREATOR, recipient: WALLET, mint: SOL, amount: '5', memo: 'agent:' + agent.id + ':def', messageHash: 'h', unsignedRaw: 'raw', blockhash: 'b', lastValidBlockHeight: 10, preparedSlot: 5, expiresAt: 1 }), /UNIQUE/);
  db.close();
});

test('settlement batches move one agent\'s SOL to USDC and provider batches back USD credits once', async () => {
  const { db, store, agent } = await fixture();
  const other = store.createAgent({ mint: 'Lemon' + MINT.slice(5), route: 'meteora', launchId: 'l2', accountId: 'acct-2', wallet: 'Lemon' + WALLET.slice(5), name: 'Lemon', symbol: 'LEM', policyHash: AGENT_POLICY_HASH, policyVersion: 'agent-policy-v1', capabilities: 3, model: 'm', mission: 'x' });
  store.recordFeeReceipt({ agentId: agent.id, signature: SIG, allocation: 'a', venue: 'raydium', launchMint: MINT, sourceWallet: CREATOR, mint: SOL, amount: '1000000000', slot: 1 });
  store.recordFeeReceipt({ agentId: other.id, signature: '7'.repeat(88), allocation: 'a', venue: 'meteora', launchMint: other.mint, sourceWallet: CREATOR, mint: SOL, amount: '2000000000', slot: 1 });
  const batch = store.createSettlementBatch({ agentId: agent.id, lamports: '290000000', maxNetworkCost: '10000000' });
  assert.equal(batch.state, 'reserved');
  assert.equal(store.agentBalances(agent.id).sol.operatingUnsettled, '0'); assert.equal(store.agentBalances(agent.id).sol.operatingSettling, '300000000');
  assert.throws(() => store.createSettlementBatch({ agentId: agent.id, lamports: '10', maxNetworkCost: '0' }), error => error.code === 'AGENT_BATCH_OPEN');
  assert.throws(() => store.createSettlementBatch({ agentId: other.id, lamports: '600000001', maxNetworkCost: '0' }), error => error.code === 'AGENT_LEDGER_INSUFFICIENT');
  store.finalizeSettlementBatch(batch.id, { outputUsdc: '58000000', networkCost: '2000000', signature: '8'.repeat(88) });
  assert.equal(store.finalizeSettlementBatch(batch.id, { outputUsdc: '58000000', signature: '8'.repeat(88) }).duplicate, true);
  let balances = store.agentBalances(agent.id);
  assert.equal(balances.usdc.operatingSettled, '58000000'); assert.equal(balances.sol.operatingSettling, '0'); assert.equal(balances.sol.operatingUnsettled, '8000000');
  const second = store.createSettlementBatch({ agentId: other.id, lamports: '500000000', maxNetworkCost: '10000000' });
  store.releaseSettlementBatch(second.id, { reason: 'Route failed onchain.', feeLamports: '5000', failed: true });
  assert.equal(store.agentBalances(other.id).sol.operatingUnsettled, '599995000'); assert.equal(store.settlementBatch(second.id).state, 'failed');
  const provider = store.createProviderBatch({ provider: 'openrouter', reference: 'inv-1', evidence: 'OpenRouter invoice inv-1', paidUsdc: '100000000', purchaseFeeUsdc: '5500000', creditsUsd: '94500000', actor: 'owner' });
  assert.throws(() => store.createProviderBatch({ provider: 'openrouter', reference: 'inv-1', evidence: 'dup', paidUsdc: '1', purchaseFeeUsdc: '0', creditsUsd: '1', actor: 'owner' }), error => error.code === 'AGENT_DUPLICATE_BATCH');
  store.allocateBacking({ batchId: provider.id, agentId: agent.id, usdc: '58000000', usd: '54810000' });
  assert.throws(() => store.allocateBacking({ batchId: provider.id, agentId: agent.id, usdc: '1', usd: '1' }), error => error.code === 'AGENT_LEDGER_INSUFFICIENT');
  assert.throws(() => store.allocateBacking({ batchId: provider.id, agentId: other.id, usdc: '50000000', usd: '47250000' }), error => error.code === 'AGENT_BACKING_EXHAUSTED');
  assert.throws(() => store.allocateBacking({ batchId: provider.id, agentId: other.id, usdc: '40000000', usd: '37800000' }), error => error.code === 'AGENT_LEDGER_INSUFFICIENT');
  balances = store.agentBalances(agent.id);
  assert.equal(balances.usd.backed, '54810000'); assert.equal(balances.usdc.operatingSettled, '0');
  assert.equal(store.platformBalances().operatorReceivableUsdc, '58000000'); assert.equal(store.platformBalances().providerCapacityUsd, '39690000');
  assert.equal(store.ledger.verify().ok, true);
  db.close();
});

test('runs reserve, settle known and unknown cost, and fence leases', async () => {
  const { db, store, agent } = await fixture();
  store.ledger.post({ kind: 'backing', sourceKey: 'test:seed', agentId: agent.id, entries: [{ owner: 'external:provider', asset: 'USD', bucket: 'main', delta: -3000000n }, { owner: 'agent:' + agent.id, asset: 'USD', bucket: 'operating_backed', delta: 3000000n }] });
  const run = store.createRun({ agentId: agent.id, trigger: 'schedule', policyHash: AGENT_POLICY_HASH, model: 'm', revision: 1 });
  assert.throws(() => store.createRun({ agentId: agent.id, trigger: 'schedule', policyHash: AGENT_POLICY_HASH, model: 'm', revision: 1 }), error => error.code === 'AGENT_RUN_ACTIVE');
  store.reserveRun(run.id, '100000');
  assert.equal(store.agentBalances(agent.id).usd.reserved, '100000'); assert.equal(store.agentBalances(agent.id).usd.backed, '2900000');
  const lease = store.claimRun(run.id, 'worker-a', 60000); assert.equal(lease.fence, 1);
  assert.equal(store.claimRun(run.id, 'worker-b', 60000), null);
  clock += 61000;
  const takeover = store.claimRun(run.id, 'worker-b', 60000); assert.equal(takeover.fence, 2);
  assert.equal(store.renewRun(run.id, 'worker-a', 1, 60000), false); assert.equal(store.renewRun(run.id, 'worker-b', 2, 60000), true);
  assert.equal(store.recordUsage({ runId: run.id, agentId: agent.id, provider: 'openrouter', requestId: 'gen-1', kind: 'model', costUsd: '1800', state: 'resolved' }).duplicate, false);
  assert.equal(store.recordUsage({ runId: run.id, agentId: agent.id, provider: 'openrouter', requestId: 'gen-1', kind: 'model', costUsd: '1800', state: 'resolved' }).duplicate, true);
  store.settleRun(run.id, { spentUsd: '1800', disputedUsd: '20000' });
  let balances = store.agentBalances(agent.id);
  assert.equal(balances.usd.spent, '1800'); assert.equal(balances.usd.disputed, '20000'); assert.equal(balances.usd.reserved, '0'); assert.equal(balances.usd.backed, '2978200');
  store.resolveDispute(run.id, { actualUsd: '5000' });
  balances = store.agentBalances(agent.id);
  assert.equal(balances.usd.spent, '6800'); assert.equal(balances.usd.disputed, '0'); assert.equal(balances.usd.backed, '2993200');
  // Cost above the reservation is operator variance, never another agent's money.
  store.updateRun(run.id, { state: 'completed', finishedAt: now() });
  const second = store.createRun({ agentId: agent.id, trigger: 'schedule', policyHash: AGENT_POLICY_HASH, model: 'm', revision: 1 });
  store.reserveRun(second.id, '20000'); store.settleRun(second.id, { spentUsd: '25000' });
  assert.equal(store.agentBalances(agent.id).usd.spent, '26800'); assert.equal(store.platformBalances().providerVarianceUsd, '5000');
  assert.equal(store.ledger.verify().ok, true);
  db.close();
});

test('actions reserve treasury, record bought tokens until burned, and freeze reward debts', async () => {
  const { db, store, agent } = await fixture();
  store.recordFeeReceipt({ agentId: agent.id, signature: SIG, allocation: 'a', venue: 'raydium', launchMint: MINT, sourceWallet: CREATOR, mint: SOL, amount: '10000000000', slot: 1 });
  const action = store.createAction({ agentId: agent.id, kind: 'buyback_burn', proposal: { lamports: '1000000000', reason: 'test' }, policyHash: AGENT_POLICY_HASH });
  store.reserveAction(action.id, { lamports: '1000100000' });
  assert.equal(store.agentBalances(agent.id).sol.treasuryReserved, '1000100000');
  assert.throws(() => store.settleActionLamports(action.id, { spentLamports: '2000000000' }), error => error.code === 'AGENT_ACTION_OVERSPEND');
  const asset = tokenAsset(MINT);
  store.settleActionLamports(action.id, { spentLamports: '1000050000', tokenAsset: asset, tokensBought: '123456' });
  let balances = store.agentBalances(agent.id);
  assert.equal(balances.sol.treasuryReserved, '0'); assert.equal(balances.sol.treasuryAvailable, '5999950000'); assert.equal(balances.tokens[MINT].pendingBurn, '123456');
  store.settleBurn(action.id, { tokenAsset: asset, tokens: '123456' }); store.settleBurn(action.id, { tokenAsset: asset, tokens: '123456' });
  assert.equal(store.agentBalances(agent.id).tokens[MINT].pendingBurn, '0');
  const reward = store.createAction({ agentId: agent.id, kind: 'holder_reward', proposal: { lamports: '300' }, policyHash: AGENT_POLICY_HASH });
  store.reserveAction(reward.id, { lamports: '400' });
  const cycle = store.createRewardCycle({ agentId: agent.id, actionId: reward.id, policyHash: AGENT_POLICY_HASH, windowFrom: 1, windowTo: 2, sampleCount: 13, totalLamports: '300', recipients: [{ owner: 'A' + CREATOR.slice(1), lamports: '200', weight: '2' }, { owner: 'B' + CREATOR.slice(1), lamports: '100', weight: '1' }], exclusions: [WALLET], evidence: { slots: [1, 2] } });
  balances = store.agentBalances(agent.id);
  assert.equal(balances.sol.rewardFrozen, '300'); assert.equal(balances.sol.treasuryReserved, '100');
  const debts = store.debts(cycle.id); assert.equal(debts.length, 2);
  store.settleDebts(cycle.id, { debtIds: [debts[0].id], signature: '9'.repeat(88), legKey: 'leg0' });
  store.deferDebts(cycle.id, [debts[1].id], 'Recipient needs rent.');
  assert.equal(store.agentBalances(agent.id).sol.rewardFrozen, '100');
  assert.deepEqual(store.openDebts(agent.id).map(d => d.state), ['deferred']);
  store.releaseDebts(cycle.id, [debts[1].id], 'Retention window ended.');
  assert.equal(store.agentBalances(agent.id).sol.rewardFrozen, '0');
  assert.equal(store.ledger.verify().ok, true);
  db.close();
});

test('notes are bounded, searchable and scoped per agent; events paginate', async () => {
  const { db, store, agent } = await fixture();
  const other = store.createAgent({ mint: 'Lemon' + MINT.slice(5), route: 'meteora', launchId: 'l2', accountId: 'acct-2', wallet: 'Lemon' + WALLET.slice(5), name: 'Lemon', symbol: 'LEM', policyHash: AGENT_POLICY_HASH, policyVersion: 'agent-policy-v1', capabilities: 3, model: 'm', mission: 'x' });
  store.saveNote({ agentId: agent.id, title: 'Goat market', body: 'Goats trade on Raydium with rising volume.', provenance: 'model' });
  store.saveNote({ agentId: other.id, title: 'Lemon secret', body: 'Lemons are private to the lemon agent.', provenance: 'model' });
  assert.throws(() => store.saveNote({ agentId: agent.id, title: 'big', body: 'x'.repeat(5000), provenance: 'model' }), /limited to/);
  assert.equal(store.recallNotes(agent.id, 'lemons').length, 0);
  assert.equal(store.recallNotes(agent.id, 'goats volume')[0].title, 'Goat market');
  assert.equal(store.recallNotes(other.id, 'lemon')[0].title, 'Lemon secret');
  for (let i = 0; i < 5; i++) store.addEvent({ agentId: agent.id, kind: 'update', title: 'Update ' + i });
  const page = store.events(agent.id, { limit: 2 }); assert.equal(page.length, 2); assert.equal(page[0].title, 'Update 4');
  assert.equal(store.events(agent.id, { limit: 10, before: page[1].id }).length, 3);
  assert.equal(store.events(agent.id, { after: page[1].id, limit: 10 }).length, 1);
  assert.equal(store.lastEventId(), 5);
  db.close();
});

test('alerts dedupe while open and outbox entries dedupe by key', async () => {
  const { db, store } = await fixture();
  assert.equal(store.raiseAlert({ scope: 'global', code: 'ledger', message: 'drift' }), true);
  assert.equal(store.raiseAlert({ scope: 'global', code: 'ledger', message: 'drift' }), false);
  assert.equal(store.clearAlert('global', 'ledger'), 1);
  assert.equal(store.raiseAlert({ scope: 'global', code: 'ledger', message: 'drift' }), true);
  assert.equal(store.enqueue({ kind: 'reconcile', dedupKey: 'x:1', payload: { a: 1 } }), true);
  assert.equal(store.enqueue({ kind: 'reconcile', dedupKey: 'x:1', payload: { a: 1 } }), false);
  assert.equal(store.pendingOutbox().length, 1);
  store.setSetting('flags', { feature: true }, 'owner'); assert.deepEqual(store.setting('flags'), { feature: true });
  db.close();
});
