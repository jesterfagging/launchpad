import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_SCHEMAS, validateArguments, toolDefinitions, DATA_TOOLS, BROWSER_TOOLS, PROPOSAL_TOOLS, INFLUENCER_TOOLS } from '../src/agent/tools.mjs';
import { AGENT_TOOLS } from '../public/agent-catalog.mjs';

test('every published tool has a closed schema and no run context in its arguments', () => {
  assert.equal(AGENT_TOOLS.length, 16);
  assert.ok(AGENT_TOOLS.includes('get_curve_coin') && AGENT_TOOLS.includes('list_curve_agents'), 'v71.27 directory tools');
  assert.deepEqual(INFLUENCER_TOOLS, ['post_to_x'], 'v71.30 influencer tool');
  for (const name of AGENT_TOOLS) {
    const schema = TOOL_SCHEMAS[name];
    assert.equal(schema.parameters.type, 'object'); assert.equal(schema.parameters.additionalProperties, false, name);
    for (const key of Object.keys(schema.parameters.properties)) assert.ok(!['mint', 'agentId', 'wallet', 'chain', 'signature', 'recipient'].includes(key), `${name}.${key}`);
    for (const [key, property] of Object.entries(schema.parameters.properties)) if (property.type === 'string') assert.ok(property.maxLength > 0, `${name}.${key} bounded`);
  }
  assert.deepEqual(new Set([...DATA_TOOLS, ...BROWSER_TOOLS, ...PROPOSAL_TOOLS, ...INFLUENCER_TOOLS]), new Set(AGENT_TOOLS));
});

test('arguments are validated strictly: unknown fields, types, bounds, control characters and size', () => {
  assert.equal(validateArguments('nope', '{}').error, 'Unknown tool.');
  assert.deepEqual(validateArguments('get_own_market', '{}'), { ok: true, value: {} });
  assert.deepEqual(validateArguments('get_own_market', '').value, {});
  assert.match(validateArguments('get_own_market', '{"mint":"x"}').error, /not allowed/);
  assert.match(validateArguments('save_note', '{"title":"a"}').error, /body is required/);
  assert.match(validateArguments('save_note', JSON.stringify({ title: 'a', body: 'x'.repeat(4000) })).error, /longer than 3600/);
  assert.match(validateArguments('save_note', JSON.stringify({ title: 'a\u0000b', body: 'ok' })).error, /control characters/);
  assert.match(validateArguments('save_note', JSON.stringify({ title: '   ', body: 'ok' })).error, /cannot be empty/);
  assert.match(validateArguments('get_own_fee_history', '{"limit":0}').error, /between 1 and 20/);
  assert.match(validateArguments('get_own_fee_history', '{"limit":"5"}').error, /must be an integer/);
  assert.match(validateArguments('propose_buyback_burn', '{"amountSol":"1","reason":"x"}').error, /must be a number/);
  assert.match(validateArguments('propose_buyback_burn', '{"amountSol":5000,"reason":"x"}').error, /between 0.001 and 1000/);
  assert.match(validateArguments('propose_buyback_burn', '{"amountSol":1e999,"reason":"x"}').error, /JSON|number/);
  assert.match(validateArguments('browser_follow_link', '{"link":1.5}').error, /integer/);
  assert.match(validateArguments('browser_open', '[]').error, /must be an object/);
  assert.match(validateArguments('browser_open', '{"url":"' + 'x'.repeat(9000) + '"}').error, /too large/);
  assert.match(validateArguments('browser_open', '{bad json').error, /valid JSON/);
  assert.deepEqual(validateArguments('propose_holder_reward', { amountSol: 0.5, reason: 'Weekly reward' }).value, { amountSol: 0.5, reason: 'Weekly reward' });
  // The directory tools: the coin mint is the model's own choice (a bounded base58 string), the agent list takes nothing.
  assert.deepEqual(validateArguments('get_curve_coin', { coinMint: 'So11111111111111111111111111111111111111112' }).value, { coinMint: 'So11111111111111111111111111111111111111112' });
  assert.match(validateArguments('get_curve_coin', { coinMint: 'short' }).error, /at least 32 characters/);
  assert.match(validateArguments('get_curve_coin', { coinMint: 'x'.repeat(45) }).error, /longer than 44/);
  assert.match(validateArguments('get_curve_coin', { mint: 'So11111111111111111111111111111111111111112' }).error, /not allowed/);
  assert.match(validateArguments('get_curve_coin', {}).error, /coinMint is required/);
  assert.deepEqual(validateArguments('list_curve_agents', '{}').value, {});
  assert.match(validateArguments('list_curve_agents', '{"limit":5}').error, /not allowed/);
});

test('tool definitions follow the launch-time capabilities', () => {
  const names = defs => defs.map(def => def.function.name);
  assert.deepEqual(names(toolDefinitions({})).filter(name => PROPOSAL_TOOLS.includes(name)), []);
  assert.deepEqual(names(toolDefinitions({ buyback: true })).filter(name => PROPOSAL_TOOLS.includes(name)), ['propose_buyback_burn']);
  assert.deepEqual(names(toolDefinitions({ rewards: true })).filter(name => PROPOSAL_TOOLS.includes(name)), ['propose_holder_reward']);
  assert.deepEqual(names(toolDefinitions({ browser: false })).filter(name => BROWSER_TOOLS.includes(name)), []);
  assert.equal(names(toolDefinitions({ buyback: true, rewards: true, browser: true })).length, 15, 'post_to_x is offered only when the influencer may post');
  assert.deepEqual(names(toolDefinitions({})).filter(name => INFLUENCER_TOOLS.includes(name)), []);
  assert.deepEqual(names(toolDefinitions({ influencer: true })).filter(name => INFLUENCER_TOOLS.includes(name)), ['post_to_x']);
  assert.equal(names(toolDefinitions({ buyback: true, rewards: true, browser: true, influencer: true })).length, 16);
  assert.equal(validateArguments('post_to_x', { text: 'gm from the studio', media: 'image', mediaBrief: 'sipping coffee at dawn' }).ok, true);
  assert.equal(validateArguments('post_to_x', { text: 'gm', media: 'gif' }).ok, false, 'media enum is enforced');
  assert.equal(validateArguments('post_to_x', { text: '' }).ok, false);
  assert.equal(validateArguments('post_to_x', { text: 'x'.repeat(281) }).ok, false);
  assert.ok(names(toolDefinitions({})).includes('get_curve_coin') && names(toolDefinitions({})).includes('list_curve_agents'), 'directory tools need no capability');
  for (const def of toolDefinitions({ buyback: true, rewards: true })) { assert.equal(def.type, 'function'); assert.equal(def.function.parameters.additionalProperties, false); }
});
