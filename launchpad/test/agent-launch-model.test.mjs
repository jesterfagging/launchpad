import test from 'node:test';
import assert from 'node:assert/strict';
import { launchInput, agentLaunchRequest } from '../public/launchpad-model.mjs';
import { AGENT_MODE, AGENT_CAPABILITIES, capabilityList } from '../public/agent-catalog.mjs';
import { validAgentAttachment, agentLaunch, raydiumAgentSources } from '../src/agent/launches.mjs';

const SOL = 'So11111111111111111111111111111111111111112', USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WALLET = 'Xther11111111111111111111111111111111111111';
const request = extra => ({ venue: 'raydium', mission: 'Track mentions and post honest updates.', personalityPreset: 'analyst', model: 'openai/gpt-6-luna', domains: 'solana.com, Docs.Raydium.io', ...extra });

test('agent launch requests are normalized, bounded and never carry wallet or policy fields', () => {
  const value = agentLaunchRequest(request({ buyback: 'on' }));
  assert.equal(value.mode, AGENT_MODE); assert.equal(value.venue, 'raydium'); assert.deepEqual(value.domains, ['solana.com', 'docs.raydium.io']);
  assert.equal(value.buyback, true); assert.equal(value.rewards, false); assert.deepEqual(capabilityList(value.capabilities), ['research', 'browser', 'buyback']);
  assert.equal(value.capabilities & AGENT_CAPABILITIES.rewards, 0); assert.ok(!('wallet' in value) && !('policyHash' in value) && !('id' in value));
  assert.throws(() => agentLaunchRequest(request({ venue: 'pumpswap' })), /Raydium, Meteora and Pump\.fun only/);
  assert.equal(agentLaunchRequest(request({ venue: 'pump' })).venue, 'pump', 'Pump.fun agents (v71.18)');
  assert.throws(() => agentLaunchRequest(request({ mission: '' })), /mission/);
  assert.throws(() => agentLaunchRequest(request({ mission: 'x'.repeat(1001) })), /mission/);
  assert.throws(() => agentLaunchRequest(request({ personalityPreset: 'villain' })), /personality preset/);
  assert.throws(() => agentLaunchRequest(request({ personalityPreset: 'custom', personality: '' })), /Describe the custom personality/);
  assert.equal(agentLaunchRequest(request({ personalityPreset: 'custom', personality: ' Dry wit. ' })).personality, 'Dry wit.');
  assert.throws(() => agentLaunchRequest(request({ model: 'gpt-6' })), /supported model/);
  assert.throws(() => agentLaunchRequest(request({ model: 'openai/gpt 6' })), /supported model/);
  assert.throws(() => agentLaunchRequest(null), /Describe your agent/);
  assert.throws(() => agentLaunchRequest(request({ domains: ['bad_domain', 'solana.com'] })), /not a valid research domain/);
  assert.deepEqual(agentLaunchRequest(request({ domains: ['solana.com', 'SOLANA.com'] })).domains, ['solana.com']);
});

test('launchInput maps the AI Agent option onto a SOL-only creator-fee launch with automatic fees and no tax', () => {
  const value = launchInput({ name: 'Scout', symbol: 'SCOUT', feeMode: 'agent', quoteMint: SOL, walletMode: 'external', externalWallet: WALLET, agent: request() });
  assert.equal(value.feeMode, 'creator'); assert.equal(value.taxBps, 0); assert.equal(value.autoFees, true); assert.equal(value.agentRequest.mode, AGENT_MODE);
  assert.throws(() => launchInput({ name: 'Scout', symbol: 'SCOUT', feeMode: 'agent', quoteMint: USDC, agent: request() }), /pair with SOL only/);
  assert.throws(() => launchInput({ name: 'Scout', symbol: 'SCOUT', feeMode: 'agent', quoteMint: SOL }), /Describe your agent/);
  assert.throws(() => launchInput({ name: 'Scout', symbol: 'SCOUT', feeMode: 'creator', quoteMint: SOL, agent: request() }), /require the AI Agent launch option/);
  const plain = launchInput({ name: 'Plain', symbol: 'PLN', feeMode: 'creator', quoteMint: SOL, walletMode: 'external', externalWallet: WALLET });
  assert.equal(plain.autoFees, false); assert.equal('agentRequest' in plain, false);
});

test('a launch counts as an agent launch only with a valid attachment, SOL quote, zero tax and the agent wallet as recipient', () => {
  const attachment = { version: 1, mode: AGENT_MODE, id: 'a'.repeat(24), wallet: WALLET, policyHash: 'f'.repeat(64), policyVersion: 'agent-policy-v1', capabilities: 3, model: 'openai/gpt-6-luna' };
  assert.equal(validAgentAttachment(attachment), true);
  assert.equal(validAgentAttachment({ ...attachment, mode: 'buyback' }), false);
  assert.equal(validAgentAttachment({ ...attachment, wallet: 'nope' }), false);
  assert.equal(validAgentAttachment({ ...attachment, policyHash: 'short' }), false);
  const launch = { id: 'l1', mint: 'M'.repeat(43), state: 'live', input: { feeMode: 'creator', taxBps: 0, quoteMint: SOL, recipient: WALLET, agent: attachment }, keys: { wallet: WALLET } };
  assert.equal(agentLaunch(launch), true);
  assert.equal(agentLaunch({ ...launch, input: { ...launch.input, recipient: 'Y'.repeat(43) } }), false);
  assert.equal(agentLaunch({ ...launch, input: { ...launch.input, taxBps: 100 } }), false);
  assert.equal(agentLaunch({ ...launch, input: { ...launch.input, quoteMint: USDC } }), false);
  assert.equal(agentLaunch({ ...launch, input: { ...launch.input, feeMode: 'holders' } }), false);
  assert.equal(agentLaunch({ ...launch, input: { ...launch.input, agent: undefined } }), false);
  assert.deepEqual(raydiumAgentSources({ ...launch, input: { ...launch.input, feeMode: 'holders' } }), []);
});
