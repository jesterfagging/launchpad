// The model registry: the default allowlist, provider derivation, fast/balanced/deep tags and the
// availability rule (listed in the live catalog with a readable price, tool support and a price younger
// than 24 hours). No network: the catalog is injected or served by a fake fetcher.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelRegistry, DEFAULT_MODEL_ALLOWLIST, PROVIDERS, MODEL_TAG_THRESHOLDS, UNAVAILABLE_REASONS, providerOf, providerName, modelTag } from '../src/agent/openrouter.mjs';

const MODEL_ID = /^[a-z0-9][a-z0-9._-]{1,60}\/[a-z0-9][a-z0-9._:-]{1,80}$/i; // the launch request's model rule (launchpad-model.mjs)
const HOUR = 3600000, DAY = 24 * HOUR;
const row = (id, prompt, completion, extra = {}) => ({ id, name: 'Name of ' + id, pricing: { prompt, completion, request: '0' }, context_length: 200000, top_provider: { max_completion_tokens: 32000 }, supported_parameters: ['tools', 'temperature'], ...extra });
const clock = (start = Date.UTC(2026, 9, 4, 12)) => { let now = start; return { now: () => now, advance: ms => { now += ms; } }; };

test('the default allowlist has at least 20 unique OpenRouter ids over 10 providers, the platform default first', () => {
  assert.equal(DEFAULT_MODEL_ALLOWLIST[0], 'openai/gpt-6-luna');
  assert.ok(DEFAULT_MODEL_ALLOWLIST.length >= 20);
  assert.equal(new Set(DEFAULT_MODEL_ALLOWLIST).size, DEFAULT_MODEL_ALLOWLIST.length);
  for (const id of DEFAULT_MODEL_ALLOWLIST) assert.match(id, MODEL_ID);
  const providers = new Set(DEFAULT_MODEL_ALLOWLIST.map(providerOf));
  assert.equal(providers.size, 10);
  assert.deepEqual([...providers].sort(), Object.keys(PROVIDERS).sort());
  for (const slug of providers) assert.ok(DEFAULT_MODEL_ALLOWLIST.filter(id => providerOf(id) === slug).length >= 2, slug + ' has at least two tiers');
  assert.ok(Object.isFrozen(DEFAULT_MODEL_ALLOWLIST));
});

test('providers derive from the id prefix and read by their display names', () => {
  assert.equal(providerOf('anthropic/claude-sonnet-4.5'), 'anthropic');
  assert.equal(providerOf('X-AI/grok-4'), 'x-ai');
  assert.equal(providerOf('gpt-6'), ''); assert.equal(providerOf(''), ''); assert.equal(providerOf(null), '');
  assert.equal(providerName('x-ai'), 'xAI'); assert.equal(providerName('z-ai'), 'Z.ai'); assert.equal(providerName('moonshotai'), 'Moonshot'); assert.equal(providerName('mistralai'), 'Mistral');
  assert.equal(providerName('some-lab'), 'Some Lab'); assert.equal(providerName(''), 'Other');
});

test('tags follow the completion price: under $1 fast, under $8 balanced, $8 and above deep', () => {
  assert.deepEqual(MODEL_TAG_THRESHOLDS, { fastBelowUsd: 1, balancedBelowUsd: 8 });
  assert.equal(modelTag(0), 'fast'); assert.equal(modelTag(0.4), 'fast'); assert.equal(modelTag(0.999), 'fast');
  assert.equal(modelTag(1), 'balanced'); assert.equal(modelTag(2.5), 'balanced'); assert.equal(modelTag(7.99), 'balanced');
  assert.equal(modelTag(8), 'deep'); assert.equal(modelTag(15), 'deep'); assert.equal(modelTag(75), 'deep');
  assert.equal(modelTag(null), null); assert.equal(modelTag(NaN), null); assert.equal(modelTag(-1), null); assert.equal(modelTag('abc'), null);
});

test('ingest keeps every allowlisted model the live list carries, reads string prices and tolerates missing fields', () => {
  const time = clock(), allowlist = ['openai/gpt-6-luna', 'qwen/qwen3-30b-a3b', 'google/gemini-2.5-flash', 'z-ai/glm-4.6'];
  const registry = new ModelRegistry({ allowlist, now: time.now });
  const stored = registry.ingest([
    row('openai/gpt-6-luna', '0.0000025', '0.00001'),
    { id: 'qwen/qwen3-30b-a3b', pricing: { prompt: 0.0000001, completion: '0.0000003' } },           // numbers, no name, no supported_parameters, no context
    { id: 'openai/not-allowlisted', pricing: { prompt: '0.000001', completion: '0.000001' } },         // not in the allowlist
    { id: 'z-ai/glm-4.6', pricing: { prompt: '-1', completion: '-1' } },                               // listed without a usable price
    null, 'junk', { pricing: {} }, { id: 42 },                                                        // malformed rows
  ], time.now());
  assert.equal(stored, 2);
  const [luna, qwen, gemini, glm] = registry.catalog();
  assert.equal(luna.promptUsdPerMillion, 2.5); assert.equal(luna.completionUsdPerMillion, 10); assert.equal(luna.contextLength, 200000); assert.equal(luna.maxCompletionTokens, 32000); assert.equal(luna.supportsTools, true); assert.equal(luna.name, 'Name of openai/gpt-6-luna');
  assert.equal(qwen.promptUsdPerMillion, 0.1); assert.equal(qwen.completionUsdPerMillion, 0.3); assert.equal(qwen.supportsTools, true); assert.equal(qwen.contextLength, 0); assert.equal(qwen.name, 'qwen/qwen3-30b-a3b'); assert.equal(qwen.available, true);
  assert.equal(gemini.available, false); assert.equal(gemini.unavailableReason, UNAVAILABLE_REASONS.notListed);
  assert.equal(glm.available, false); assert.equal(glm.unavailableReason, UNAVAILABLE_REASONS.noPricing);
  assert.equal(registry.pricing('z-ai/glm-4.6'), null);
  assert.equal(registry.ingest(undefined, time.now()), 0); assert.equal(registry.ingest({ data: [] }, time.now()), 0);
  // The allowlist is deduplicated and keeps its order.
  assert.deepEqual(new ModelRegistry({ allowlist: ['a/b', 'c/d', 'a/b', '', null] }).allowlist, ['a/b', 'c/d']);
});

test('a model is available only when listed, priced, tool-capable and younger than 24 hours; each failure names its reason', () => {
  const time = clock(), allowlist = ['openai/gpt-6-luna', 'x-ai/grok-4', 'anthropic/claude-haiku-4.5', 'mistralai/mistral-small-3.2-24b-instruct', 'deepseek/deepseek-v3.2'];
  const registry = new ModelRegistry({ allowlist, now: time.now });
  // Before the first catalog read, nothing is available and the reason says so.
  for (const model of registry.catalog()) { assert.equal(model.available, false); assert.equal(model.unavailableReason, UNAVAILABLE_REASONS.noCatalog); assert.equal(model.unavailable, true); assert.equal(model.stale, true); assert.equal(model.tag, null); assert.equal(model.pricedAt, null); }
  assert.equal(registry.status().available, 0); assert.equal(registry.status().refreshedAt, null);
  registry.ingest([
    row('openai/gpt-6-luna', '0.0000025', '0.00001'),
    row('x-ai/grok-4', '0.000003', '0.000015', { supported_parameters: ['temperature', 'top_p'] }),
    row('anthropic/claude-haiku-4.5', '0.000001', '0.000005'),
    row('deepseek/deepseek-v3.2', '0.00000028', '0.00000042'),
  ], time.now());
  const by = () => Object.fromEntries(registry.catalog().map(model => [model.id, model]));
  let models = by();
  assert.deepEqual([models['openai/gpt-6-luna'].available, models['openai/gpt-6-luna'].unavailableReason, models['openai/gpt-6-luna'].tag], [true, null, 'deep']);
  assert.deepEqual([models['x-ai/grok-4'].available, models['x-ai/grok-4'].unavailableReason, models['x-ai/grok-4'].supportsTools, models['x-ai/grok-4'].tag], [false, UNAVAILABLE_REASONS.noTools, false, 'deep']);
  assert.deepEqual([models['anthropic/claude-haiku-4.5'].available, models['anthropic/claude-haiku-4.5'].tag], [true, 'balanced']);
  assert.deepEqual([models['deepseek/deepseek-v3.2'].available, models['deepseek/deepseek-v3.2'].tag], [true, 'fast']);
  assert.deepEqual([models['mistralai/mistral-small-3.2-24b-instruct'].available, models['mistralai/mistral-small-3.2-24b-instruct'].unavailableReason, models['mistralai/mistral-small-3.2-24b-instruct'].name], [false, UNAVAILABLE_REASONS.notListed, 'mistralai/mistral-small-3.2-24b-instruct']);
  assert.equal(registry.available('openai/gpt-6-luna'), true); assert.equal(registry.fresh('openai/gpt-6-luna'), true);
  assert.equal(registry.available('x-ai/grok-4'), false); assert.equal(registry.fresh('x-ai/grok-4'), false, 'launch intake must not accept a model without tool support');
  assert.ok(registry.pricing('x-ai/grok-4'), 'pricing stays readable for the runner, which refuses the model itself');
  // A day later every price is stale: the reason changes, the stored price is still reported.
  time.advance(DAY + 1);
  models = by();
  assert.deepEqual([models['openai/gpt-6-luna'].available, models['openai/gpt-6-luna'].unavailableReason, models['openai/gpt-6-luna'].stale, models['openai/gpt-6-luna'].promptUsdPerMillion], [false, UNAVAILABLE_REASONS.stale, true, 2.5]);
  assert.equal(models['x-ai/grok-4'].unavailableReason, UNAVAILABLE_REASONS.noTools, 'tool support is checked before staleness');
  assert.equal(registry.pricing('openai/gpt-6-luna'), null); assert.equal(registry.fresh('openai/gpt-6-luna'), false);
  assert.equal(registry.status().available, 0);
  // A fresh read brings them back; a model that left the list keeps its last price until it goes stale.
  registry.ingest([row('openai/gpt-6-luna', '0.0000025', '0.00001')], time.now());
  models = by();
  assert.equal(models['openai/gpt-6-luna'].available, true);
  assert.deepEqual([models['anthropic/claude-haiku-4.5'].available, models['anthropic/claude-haiku-4.5'].unavailableReason], [false, UNAVAILABLE_REASONS.stale]);
});

test('status counts available models in total and per provider, in allowlist order, and carries the last refresh error', async () => {
  const time = clock(), allowlist = ['openai/gpt-6-luna', 'openai/gpt-5-mini', 'google/gemini-2.5-flash', 'x-ai/grok-4-fast'];
  let response = { ok: true, json: async () => ({ data: [row('openai/gpt-6-luna', '0.0000025', '0.00001'), row('openai/gpt-5-mini', '0.00000025', '0.000002'), row('x-ai/grok-4-fast', '0.0000002', '0.0000005', { supported_parameters: ['temperature'] })] }) };
  const calls = [];
  const registry = new ModelRegistry({ allowlist, now: time.now, fetcher: async (url, options) => { calls.push({ url, auth: options?.headers?.authorization || null }); return response; } });
  await registry.refresh();
  assert.equal(calls.length, 1); assert.match(calls[0].url, /\/models$/); assert.equal(calls[0].auth, null, 'the public catalog needs no API key');
  const status = registry.status();
  assert.equal(status.total, 4); assert.equal(status.available, 2); assert.equal(status.error, ''); assert.equal(status.lastRefreshError, ''); assert.equal(status.refreshedAt, time.now());
  assert.deepEqual(status.providers, [{ provider: 'openai', name: 'OpenAI', total: 2, available: 2 }, { provider: 'google', name: 'Google', total: 1, available: 0 }, { provider: 'x-ai', name: 'xAI', total: 1, available: 0 }]);
  assert.deepEqual(status.models.map(model => model.id), allowlist);
  assert.equal(typeof status.staleMs, 'number'); assert.equal(typeof status.refreshMs, 'number');
  // The same keys the admin page and the health check already read.
  for (const key of ['refreshedAt', 'error', 'models']) assert.ok(key in status, key);
  // A failed refresh keeps the last catalog and reports the error; a malformed body counts as a failure.
  time.advance(HOUR); response = { ok: false, status: 503 };
  await registry.refresh({ force: true });
  assert.equal(registry.status().lastRefreshError, 'The model catalog returned HTTP 503.'); assert.equal(registry.status().available, 2);
  response = { ok: true, json: async () => ({ data: 'nope' }) };
  await registry.refresh({ force: true });
  assert.equal(registry.status().lastRefreshError, 'The model catalog returned no model list.'); assert.equal(registry.status().available, 2);
  // The next successful read clears the error.
  response = { ok: true, json: async () => ({ data: [row('openai/gpt-6-luna', '0.0000025', '0.00001')] }) };
  await registry.refresh({ force: true });
  assert.equal(registry.status().lastRefreshError, ''); assert.equal(registry.status().available, 2, 'gpt-5-mini keeps its price from an hour ago');
});

test('every catalog row keeps the published fields the launch page and readiness script read', () => {
  const time = clock(), registry = new ModelRegistry({ allowlist: ['openai/gpt-6-luna', 'google/gemini-2.5-flash'], now: time.now, catalog: [row('openai/gpt-6-luna', '0.0000025', '0.00001')] });
  const keys = ['id', 'name', 'provider', 'providerName', 'tag', 'available', 'unavailableReason', 'promptUsdPerMillion', 'completionUsdPerMillion', 'contextLength', 'maxCompletionTokens', 'supportsTools', 'pricedAt', 'stale', 'unavailable'];
  for (const model of registry.catalog()) for (const key of keys) assert.ok(key in model, model.id + ' has ' + key);
  const [listed, missing] = registry.catalog();
  assert.deepEqual({ ...listed, pricedAt: 0 }, { id: 'openai/gpt-6-luna', provider: 'openai', providerName: 'OpenAI', available: true, unavailableReason: null, name: 'Name of openai/gpt-6-luna', tag: 'deep', promptUsdPerMillion: 2.5, completionUsdPerMillion: 10, contextLength: 200000, maxCompletionTokens: 32000, supportsTools: true, pricedAt: 0, stale: false, unavailable: false });
  assert.deepEqual(missing, { id: 'google/gemini-2.5-flash', provider: 'google', providerName: 'Google', available: false, unavailableReason: 'not in the live catalog', name: 'google/gemini-2.5-flash', tag: null, promptUsdPerMillion: null, completionUsdPerMillion: null, contextLength: 0, maxCompletionTokens: 0, supportsTools: null, pricedAt: null, stale: true, unavailable: true });
});
