// AI Agent policy v2: the platform share on gross Raydium/Meteora receipts is set
// aside in the ledger and remitted from a finalized transfer; v1 agents and net
// Pump.fun receipts are never charged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openAgentDatabase, AGENT_SCHEMA_VERSION } from '../src/agent/db.mjs';
import { AgentStore } from '../src/agent/store.mjs';
import { AGENT_POLICY_HASH, AGENT_POLICY_V2, AGENT_POLICY_V2_HASH, ledgerPlatformShareBps } from '../src/agent/policy.mjs';
import { AGENT_POLICY_V1, AGENT_RATE_CARD_V1, AGENT_FUNDING_SUMMARY, AGENT_RULES, AGENT_VENUES } from '../public/agent-catalog.mjs';
import { agentLaunchRequest } from '../public/launchpad-model.mjs';

const SOL = 'So11111111111111111111111111111111111111112', MINT = 'GoatCoin1111111111111111111111111111111111', WALLET = 'AgentWa11et111111111111111111111111111111', CREATOR = 'Creator11111111111111111111111111111111111', TREASURY = 'Treasury111111111111111111111111111111111';
let clock = 1_790_000_000_000; const now = () => clock;
async function fixture(policyHash = AGENT_POLICY_V2_HASH, route = 'raydium') {
  const db = await openAgentDatabase(':memory:', { now }), store = new AgentStore(db, { now });
  store.savePolicy({ hash: AGENT_POLICY_HASH, version: AGENT_POLICY_V1.version, document: AGENT_POLICY_V1, rateCard: AGENT_RATE_CARD_V1 });
  store.savePolicy({ hash: AGENT_POLICY_V2_HASH, version: AGENT_POLICY_V2.version, document: AGENT_POLICY_V2, rateCard: AGENT_RATE_CARD_V1 });
  const agent = store.createAgent({ mint: MINT, route, launchId: 'launch-1', accountId: 'acct-1', wallet: WALLET, name: 'Goat', symbol: 'GOAT', image: null, policyHash, policyVersion: policyHash === AGENT_POLICY_HASH ? 'agent-policy-v1' : 'agent-policy-v2', capabilities: 3, model: 'openai/gpt-6-luna', mission: 'Track things.', state: 'provisioning' });
  return { db, store, agent };
}
const receipt = (store, agent, { amount = '1000000000', venue = 'raydium', sig = '5'.repeat(88) } = {}) => store.recordFeeReceipt({ agentId: agent.id, signature: sig, allocation: `${MINT}:0`, venue, launchMint: MINT, sourceWallet: CREATOR, mint: SOL, amount, slot: 1, platformShareBps: ledgerPlatformShareBps(agent.policyHash, venue) });

test('policy v2 sets aside the platform share before the 30/70 split; v1 and net Pump.fun receipts pay nothing more', async () => {
  assert.equal(AGENT_SCHEMA_VERSION, 6, 'v71.27 added the objective columns and market samples; v71.30 the influencer tables; v71.32 the feature clip counter; v71.37 the moderation columns');
  assert.deepEqual(AGENT_VENUES, ['raydium', 'meteora', 'pump']);
  const { db, store, agent } = await fixture();
  const r = receipt(store, agent, { amount: '1000000001' });
  assert.equal(r.platform, 100000000n); assert.equal(r.operations, 270000000n); assert.equal(r.treasury, 630000001n);
  const b = store.agentBalances(agent.id).sol;
  assert.equal(b.protocolPayable, '100000000'); assert.equal(b.operatingUnsettled, '270000000'); assert.equal(b.treasuryAvailable, '630000001');
  assert.equal(store.feeTotals(agent.id).platform, '100000000');
  assert.equal(store.ledger.verify().ok, true);
  db.close();
  const v1 = await fixture(AGENT_POLICY_HASH);
  assert.equal(receipt(v1.store, v1.agent).platform, 0n, 'agents launched under v1 keep their disclosed terms'); v1.db.close();
  const pump = await fixture(AGENT_POLICY_V2_HASH, 'pump');
  const net = receipt(pump.store, pump.agent, { venue: 'pump' });
  assert.equal(net.platform, 0n, 'Pump.fun receipts are already net of the native platform share'); assert.equal(net.operations, 300000000n); pump.db.close();
});

test('remittance reserves the share, settles only from a finalized receipt and releases on failure', async () => {
  const { db, store, agent } = await fixture();
  receipt(store, agent, { amount: '500000000' });
  const remit = store.createRemit({ agentId: agent.id, amount: '49980000', destination: TREASURY });
  assert.equal(store.agentBalances(agent.id).sol.protocolPayable, '20000'); assert.equal(store.agentBalances(agent.id).sol.protocolRemitting, '49980000');
  assert.throws(() => store.createRemit({ agentId: agent.id, amount: '1', destination: TREASURY }), /already open/);
  store.updateRemit(remit.id, { state: 'submitted', signature: '6'.repeat(88), operation: { signature: '6'.repeat(88) } });
  store.settleRemit(remit.id, { signature: '6'.repeat(88), feeLamports: '5000' });
  const after = store.agentBalances(agent.id).sol;
  assert.equal(after.protocolRemitting, '0'); assert.equal(after.protocolPayable, '15000', 'the network fee comes out of the set-aside share');
  assert.equal(after.treasuryAvailable, '315000000', 'operations and treasury are untouched');
  assert.equal(store.remits({ state: 'confirmed' }).length, 1);
  // A failed remittance returns the reserve minus its fee.
  receipt(store, agent, { amount: '500000000', sig: '7'.repeat(88) });
  const second = store.createRemit({ agentId: agent.id, amount: '40000000', destination: TREASURY });
  store.updateRemit(second.id, { state: 'submitted', signature: '8'.repeat(88) });
  store.releaseRemit(second.id, { reason: 'failed onchain', feeLamports: '5000' });
  assert.equal(store.agentBalances(agent.id).sol.protocolPayable, (15000n + 50000000n - 5000n).toString());
  assert.equal(store.ledger.verify().ok, true);
  db.close();
});

test('agent copy names the platform share without stating it; Pump.fun is an agent venue', () => {
  for (const text of [...Object.values(AGENT_FUNDING_SUMMARY), ...AGENT_RULES]) assert.ok(!/(10|20)\s?%\s*(platform|protocol)|platform share of (10|20)/i.test(text));
  assert.match(AGENT_FUNDING_SUMMARY.pump, /platform share/); assert.match(AGENT_FUNDING_SUMMARY.raydium, /docs/);
  assert.equal(agentLaunchRequest({ venue: 'pump', mission: 'Watch the market', model: 'openai/gpt-6-luna' }).venue, 'pump');
  assert.throws(() => agentLaunchRequest({ venue: 'pumpswap', mission: 'x', model: 'openai/gpt-6-luna' }), /Raydium, Meteora and Pump.fun/);
  assert.equal(ledgerPlatformShareBps('f'.repeat(64), 'raydium'), 0, 'unknown policies never charge');
});
