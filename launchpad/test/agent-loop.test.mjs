import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop, dryRunModel } from '../src/agent/loop.mjs';
import { toolDefinitions } from '../src/agent/tools.mjs';
import { AGENT_POLICY_V1, AGENT_RATE_CARD_V1 } from '../public/agent-catalog.mjs';
import { pricePerMillionMicro } from '../src/agent/policy.mjs';

function job({ reservedUsd = '100000', capabilities = ['research', 'browser'], approvedDomains = ['solana.com'], buyback = false, rewards = false } = {}) {
  return { id: 'run-1', fence: 1, dryRun: false, agent: { name: 'Scout', symbol: 'SCOUT', route: 'raydium', mission: 'Watch the chart', personality: '', personalityPreset: 'analyst', model: 'openai/gpt-6-luna' }, capabilities, approvedDomains,
    policy: { hash: 'abc', version: 'agent-policy-v1' }, rateCard: AGENT_RATE_CARD_V1,
    pricing: { promptMicroPerMillion: pricePerMillionMicro('0.0000001').toString(), completionMicroPerMillion: pricePerMillionMicro('0.0000005').toString(), requestUsd: '0' },
    budget: { reservedUsd, maxSeconds: AGENT_POLICY_V1.run.maxSeconds, maxModelCalls: AGENT_POLICY_V1.run.maxModelCalls, maxToolCalls: AGENT_POLICY_V1.run.maxToolCalls, maxOutputTokens: AGENT_POLICY_V1.run.maxOutputTokens, maxPromptTokens: AGENT_POLICY_V1.run.maxPromptTokens, browserMaxSeconds: AGENT_POLICY_V1.run.browserMaxSeconds, browserMaxActions: AGENT_POLICY_V1.run.browserMaxActions },
    context: { market: { priceUsd: 0.00004 }, treasury: { availableSol: '1' }, notes: [], feeSummary: { count: 0 }, recentUpdates: [] }, tools: toolDefinitions({ buyback, rewards, browser: capabilities.includes('browser') && approvedDomains.length > 0 }) };
}
const call = (name, args, id = 'c1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const scripted = (responses) => { let i = 0; return async () => { const next = responses[Math.min(i, responses.length - 1)]; i++; return typeof next === 'function' ? next() : next; }; };
const reply = (message, usage = { promptTokens: 500, completionTokens: 100, costUsd: '150' }) => ({ id: 'req-' + Math.random().toString(36).slice(2, 8), model: 'openai/gpt-6-luna', message, usage, finishReason: 'stop' });

test('dry-run loop walks the data tools, charges the estimate and labels its output', async () => {
  const calls = [], usage = [], events = [];
  const result = await runAgentLoop({ job: job(), model: dryRunModel(), callTool: async (name, args) => { calls.push([name, args]); return name === 'recall_memory' ? { notes: [] } : { ok: true }; }, onUsage: async row => usage.push(row), onEvent: async event => events.push(event) });
  assert.deepEqual(calls.map(([name]) => name), ['get_own_market', 'recall_memory', 'save_note', 'publish_update']);
  assert.equal(result.usage.modelCalls, 5); assert.equal(result.usage.toolCalls, 4); assert.equal(result.errorCode, '');
  assert.match(result.summary, /\[dry run\]/);
  assert.ok(usage.every(row => row.state === 'estimated' && BigInt(row.costUsd) > 0n));
  assert.equal(BigInt(result.usage.spentUsd), usage.reduce((sum, row) => sum + BigInt(row.costUsd), 0n));
  assert.ok(BigInt(result.usage.spentUsd) < 100000n);
});

test('model-call and tool budgets end the run; the model never sees the run context as a tool argument', async () => {
  const responses = []; for (let i = 0; i < 20; i++) responses.push(reply({ role: 'assistant', content: '', tool_calls: [call('get_own_market', {}, 'c' + i)] }));
  const seen = [];
  const result = await runAgentLoop({ job: job(), model: scripted(responses), callTool: async (name, args) => { seen.push(args); return { ok: true }; } });
  assert.equal(result.errorCode, 'model-call-limit'); assert.equal(result.usage.modelCalls, AGENT_POLICY_V1.run.maxModelCalls);
  assert.ok(seen.every(args => !('mint' in args)));
  const many = []; for (let i = 0; i < 40; i++) many.push(reply({ role: 'assistant', content: '', tool_calls: [call('get_own_market', {}, 'd' + i)] }, { promptTokens: 10, completionTokens: 5, costUsd: '1' }));
  const spec = job(); spec.budget = { ...spec.budget, maxModelCalls: 40 };
  let executed = 0;
  const limited = await runAgentLoop({ job: spec, model: scripted(many), callTool: async () => { executed++; return { ok: true }; } });
  assert.equal(executed, AGENT_POLICY_V1.run.maxToolCalls); assert.equal(limited.usage.toolCalls, AGENT_POLICY_V1.run.maxToolCalls);
});

test('a reservation that cannot cover the next worst-case call stops before sending it', async () => {
  let modelCalls = 0;
  const result = await runAgentLoop({ job: job({ reservedUsd: '500', approvedDomains: [] }), model: async () => { modelCalls++; return reply({ role: 'assistant', content: 'done' }); }, callTool: async () => ({}) });
  assert.equal(modelCalls, 0); assert.equal(result.errorCode, 'reservation-exhausted'); assert.equal(result.usage.spentUsd, '0');
  // with browsing available its worst case is held back from the model budget
  let calls2 = 0;
  const held = await runAgentLoop({ job: job({ reservedUsd: '4500' }), model: async () => { calls2++; return reply({ role: 'assistant', content: 'done' }); }, browserFactory: () => ({ open: async () => ({}), read: async () => ({}), follow: async () => ({}), scroll: async () => ({}), close: async () => {}, actions: 0, seconds: 0 }), callTool: async () => ({}) });
  assert.equal(calls2, 0); assert.equal(held.errorCode, 'reservation-exhausted');
  const fine = await runAgentLoop({ job: job({ reservedUsd: '4500', approvedDomains: [] }), model: async () => reply({ role: 'assistant', content: 'done' }), callTool: async () => ({}) });
  assert.equal(fine.errorCode, ''); assert.equal(fine.summary, 'done');
});

test('provider timeouts keep the worst-case cost as disputed and record an unknown request', async () => {
  const usage = [];
  const result = await runAgentLoop({ job: job({ approvedDomains: [] }), model: async () => { const error = Error('timed out'); error.code = 'AGENT_PROVIDER_TIMEOUT'; throw error; }, callTool: async () => ({}), onUsage: async row => usage.push(row) });
  assert.equal(result.errorCode, 'provider-timeout'); assert.ok(BigInt(result.usage.disputedUsd) > 0n); assert.equal(result.usage.spentUsd, '0');
  assert.equal(usage[0].state, 'unknown'); assert.equal(result.usage.providerRequests[0].state, 'unknown');
  const funds = await runAgentLoop({ job: job({ approvedDomains: [] }), model: async () => { const error = Error('insufficient credits'); error.code = 'AGENT_PROVIDER_FUNDS'; throw error; }, callTool: async () => ({}) });
  assert.equal(funds.errorCode, 'provider-funds');
});

test('invalid, unknown and unavailable tools are reported to the model, not executed', async () => {
  const executed = [];
  const responses = [
    reply({ role: 'assistant', content: '', tool_calls: [call('propose_buyback_burn', { amountSol: 1, reason: 'x' }, 'a')] }),
    reply({ role: 'assistant', content: '', tool_calls: [call('browser_open', { url: 'https://solana.com/' }, 'b')] }),
    reply({ role: 'assistant', content: '', tool_calls: [call('save_note', { title: 'x', body: 'y', extra: 1 }, 'c')] }),
    reply({ role: 'assistant', content: '', tool_calls: [{ id: 'd', type: 'function', function: { name: 'rm_rf', arguments: '{}' } }] }),
    reply({ role: 'assistant', content: 'finished' }),
  ];
  const messages = [];
  const model = scripted(responses.map(response => () => response));
  const result = await runAgentLoop({ job: job({ approvedDomains: [] }), model: async input => { messages.push(input.messages.at(-1)); return model(); }, callTool: async (name, args) => { executed.push(name); return { ok: true }; } });
  assert.deepEqual(executed, ['propose_buyback_burn']);
  const toolReplies = messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
  assert.equal(toolReplies[0].ok, true);
  assert.match(toolReplies[1].error || '', /unavailable|Browsing/);
  assert.match(toolReplies[2].error, /not allowed/);
  assert.equal(toolReplies[3].error, 'Unknown tool.');
  assert.equal(result.summary, 'finished'); assert.equal(result.usage.toolCalls, 4);
});

test('the time limit ends the run even when the model keeps asking for tools', async () => {
  let t = 1_000_000;
  const now = () => t;
  const result = await runAgentLoop({ job: job({ approvedDomains: [] }), now, sleep: async () => { t += 40_000; }, model: async () => reply({ role: 'assistant', content: '', tool_calls: [call('get_own_market', {}, 'x' + t)] }), callTool: async () => ({ ok: true }) });
  assert.equal(result.errorCode, 'run-timeout'); assert.ok(result.usage.modelCalls <= 3);
});
