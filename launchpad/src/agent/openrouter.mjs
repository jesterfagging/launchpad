// OpenRouter adapter: a direct HTTPS client for chat completions with tools
// and usage accounting, plus a model registry that reads live pricing and
// capabilities from the public catalog. The API key is only ever read by the
// worker process (and by the owner's health check); the registry needs none.
import { pricePerMillionMicro, tokensCostUsd } from './policy.mjs';
import { brandName, publicOrigin } from '../brand.mjs';

export const OPENROUTER_API = 'https://openrouter.ai/api/v1';
const REFRESH_MS = 10 * 60000, STALE_MS = 24 * 3600000;
const fail = (message, code = 'AGENT_PROVIDER', extra = {}) => { throw Object.assign(Error(message), { code, ...extra }); };
// OpenRouter's app attribution: the platform's public address (LAUNCHPAD_PUBLIC_URL) and name (LAUNCHPAD_BRAND_NAME).
const attribution = () => { let name = 'Launchpad'; try { name = brandName(); } catch { /* checked at startup */ } const origin = publicOrigin(); return { ...(origin ? { 'http-referer': origin } : {}), 'x-title': name + ' AI Agent' }; };
const headers = (apiKey, json = true) => ({ ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}), ...(json ? { 'content-type': 'application/json' } : {}), ...attribution() });
export const usdToMicro = value => { const number = Number(value); if (!Number.isFinite(number) || number < 0) return null; return BigInt(Math.ceil(number * 1e6)); };

/** OpenRouter provider slugs (the part of a model id before the slash) and their display names. */
export const PROVIDERS = Object.freeze({ openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', qwen: 'Qwen', 'x-ai': 'xAI', deepseek: 'DeepSeek', mistralai: 'Mistral', moonshotai: 'Moonshot', minimax: 'MiniMax', 'z-ai': 'Z.ai' });
// The default allowlist (`AGENTS_OPENROUTER_MODELS` overrides it): flagship, mid and small tiers from ten
// providers, in the display order of the launch page. Ids cannot be verified offline, and OpenRouter renames
// and retires models, so nothing here is trusted on its own: a model is offered to creators only once the
// live catalog has priced it (see `available`). The first entry is the platform default model; keep it first.
export const DEFAULT_MODEL_ALLOWLIST = Object.freeze([
  'openai/gpt-6-luna', 'openai/gpt-5.2', 'openai/gpt-5-mini', 'openai/gpt-5-nano',
  'anthropic/claude-opus-4.5', 'anthropic/claude-sonnet-4.5', 'anthropic/claude-haiku-4.5',
  'google/gemini-3-pro-preview', 'google/gemini-2.5-flash', 'google/gemini-2.5-flash-lite',
  'qwen/qwen3-max', 'qwen/qwen3-235b-a22b-2507', 'qwen/qwen3-30b-a3b',
  'x-ai/grok-4', 'x-ai/grok-4-fast',
  'deepseek/deepseek-v3.2', 'deepseek/deepseek-chat-v3.1',
  'mistralai/mistral-large-2512', 'mistralai/mistral-medium-3.1', 'mistralai/mistral-small-3.2-24b-instruct',
  'moonshotai/kimi-k2-thinking', 'moonshotai/kimi-k2-0905',
  'minimax/minimax-m2.1', 'minimax/minimax-m2',
  'z-ai/glm-4.7', 'z-ai/glm-4.6',
]);
/**
 * Speed/depth tags by completion price per million tokens (the price that tracks model size): under $1 "fast"
 * (small models that answer in a moment), under $8 "balanced" (mid-tier models), $8 and above "deep" (frontier
 * reasoning models). Prompt prices are not used: every agent run sends the same prompt and tool list, so the
 * completion price is what separates the tiers.
 */
export const MODEL_TAG_THRESHOLDS = Object.freeze({ fastBelowUsd: 1, balancedBelowUsd: 8 });
export const MODEL_TAGS = Object.freeze(['fast', 'balanced', 'deep']);
/** Unavailability reasons in the order they are checked (`null` when the model is available). */
export const UNAVAILABLE_REASONS = Object.freeze({ noCatalog: 'no live catalog yet', notListed: 'not in the live catalog', noPricing: 'no pricing', noTools: 'no tools support', stale: 'pricing stale' });
/** The provider slug of an OpenRouter model id ('' when the id has no provider part). */
export function providerOf(id) { const text = String(id || ''); const at = text.indexOf('/'); return at > 0 ? text.slice(0, at).toLowerCase() : ''; }
/** The display name of a provider slug (known providers by name; unknown ones capitalised). */
export function providerName(slug) { const key = String(slug || '').toLowerCase(); if (PROVIDERS[key]) return PROVIDERS[key]; return key ? key.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()) : 'Other'; }
/** 'fast' | 'balanced' | 'deep' for a completion price in USD per million tokens; null without a usable price. */
export function modelTag(completionUsdPerMillion) { if (completionUsdPerMillion === null || completionUsdPerMillion === undefined || completionUsdPerMillion === '') return null; const price = Number(completionUsdPerMillion); if (!Number.isFinite(price) || price < 0) return null; return price < MODEL_TAG_THRESHOLDS.fastBelowUsd ? 'fast' : price < MODEL_TAG_THRESHOLDS.balancedBelowUsd ? 'balanced' : 'deep'; }

// OpenRouter names models "Provider: Model"; the provider is shown as its own heading, so the prefix is dropped when it names this model's provider.
const squash = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export function displayName(name, id) { const match = /^([^:]{1,30}):\s+(.+)$/.exec(name); if (!match) return name; const prefix = squash(match[1]), slug = providerOf(id); return prefix === squash(slug) || prefix === squash(providerName(slug)) ? match[2] : name; }
export class ModelRegistry {
  constructor({ apiKey = '', allowlist = [], now = Date.now, fetcher = globalThis.fetch?.bind(globalThis), catalog = null } = {}) { this.apiKey = apiKey; this.allowlist = [...new Set((Array.isArray(allowlist) ? allowlist : []).filter(id => typeof id === 'string' && id))]; this.now = now; this.fetcher = fetcher; this.models = new Map(); this.unpriced = new Map(); this.refreshedAt = 0; this.error = ''; this.pending = null; if (catalog) this.ingest(catalog, now()); }
  /**
   * Stores every allowlisted model the live list carries. Prices arrive as decimal strings in USD per token
   * ("0.0000025") or numbers; a listed model whose price cannot be read is remembered as unpriced (so the
   * catalog can say so) and never used. A missing `supported_parameters` list is taken as tool support, as
   * before: the runner checks the real answer on the first call. A non-array list is ignored entirely.
   */
  ingest(list, at) {
    if (!Array.isArray(list)) return 0;
    let stored = 0; const seen = new Set();
    for (const row of list) {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !this.allowlist.includes(row.id)) continue;
      seen.add(row.id);
      const pricing = row.pricing && typeof row.pricing === 'object' ? row.pricing : {}; let prompt, completion;
      try { prompt = pricePerMillionMicro(pricing.prompt); completion = pricePerMillionMicro(pricing.completion); } catch { this.unpriced.set(row.id, at); this.models.delete(row.id); continue; }
      const tools = Array.isArray(row.supported_parameters) ? row.supported_parameters.includes('tools') : true;
      this.unpriced.delete(row.id);
      this.models.set(row.id, { id: row.id, name: displayName(String(row.name || row.id), row.id).slice(0, 120), promptMicroPerMillion: prompt, completionMicroPerMillion: completion, contextLength: Number(row.context_length) || 0, maxCompletionTokens: Number(row.top_provider?.max_completion_tokens) || 0, supportsTools: tools, requestUsd: usdToMicro(pricing.request || 0) || 0n, webSearchUsd: usdToMicro(pricing.web_search || 0) || 0n, at });
      stored++;
    }
    // A model that left the list keeps its last price until it goes stale (a transient omission must not stop
    // its agents); an unpriced marker is only as old as the last list that carried the model.
    for (const id of this.unpriced.keys()) if (!seen.has(id)) this.unpriced.delete(id);
    this.refreshedAt = at;
    return stored;
  }
  async refresh({ force = false } = {}) {
    if (!force && this.now() - this.refreshedAt < REFRESH_MS) return;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      if (!this.fetcher) fail('No fetcher is available for the model registry.');
      const response = await this.fetcher(OPENROUTER_API + '/models', { headers: headers('', false), signal: AbortSignal.timeout(15000) });
      if (!response.ok) fail(`The model catalog returned HTTP ${response.status}.`);
      const body = await response.json(); if (!Array.isArray(body?.data)) fail('The model catalog returned no model list.');
      this.ingest(body.data, this.now()); this.error = '';
    })().catch(error => { this.error = String(error.message).slice(0, 200); }).finally(() => { this.pending = null; });
    return this.pending;
  }
  stale(row) { return this.now() - row.at > STALE_MS; }
  pricing(id) { const row = this.models.get(id); if (!row || this.stale(row)) return null; return row; }
  /** Why a model cannot be launched or run right now (null when it can): the checks in `UNAVAILABLE_REASONS` order. */
  unavailableReason(id) {
    const row = this.models.get(id);
    if (!row) return !this.refreshedAt ? UNAVAILABLE_REASONS.noCatalog : this.unpriced.has(id) ? UNAVAILABLE_REASONS.noPricing : UNAVAILABLE_REASONS.notListed;
    if (!row.supportsTools) return UNAVAILABLE_REASONS.noTools;
    if (this.stale(row)) return UNAVAILABLE_REASONS.stale;
    return null;
  }
  /** Available = listed in the live catalog with a readable price, tool support and a price younger than 24 hours. */
  available(id) { return this.unavailableReason(id) === null; }
  // Launch intake accepts only an available model (the runner refuses models without tool support anyway).
  fresh(id) { return this.available(id); }
  catalog() {
    return this.allowlist.map(id => {
      const row = this.models.get(id), provider = providerOf(id), reason = this.unavailableReason(id), base = { id, provider, providerName: providerName(provider), available: reason === null, unavailableReason: reason };
      if (!row) return { ...base, name: id, tag: null, promptUsdPerMillion: null, completionUsdPerMillion: null, contextLength: 0, maxCompletionTokens: 0, supportsTools: null, pricedAt: null, stale: true, unavailable: true };
      const completionUsdPerMillion = Number(row.completionMicroPerMillion) / 1e6;
      return { ...base, name: row.name, tag: modelTag(completionUsdPerMillion), promptUsdPerMillion: Number(row.promptMicroPerMillion) / 1e6, completionUsdPerMillion, contextLength: row.contextLength, maxCompletionTokens: row.maxCompletionTokens, supportsTools: row.supportsTools, pricedAt: row.at, stale: this.stale(row), unavailable: false };
    });
  }
  /** The catalog with counts: per provider and in total, how many allowlisted models are available right now. */
  status() {
    const models = this.catalog(), providers = [];
    for (const model of models) { let entry = providers.find(item => item.provider === model.provider); if (!entry) { entry = { provider: model.provider, name: model.providerName, total: 0, available: 0 }; providers.push(entry); } entry.total++; if (model.available) entry.available++; }
    return { refreshedAt: this.refreshedAt || null, error: this.error, lastRefreshError: this.error, refreshMs: REFRESH_MS, staleMs: STALE_MS, total: models.length, available: models.filter(model => model.available).length, providers, models };
  }
}
/** One bounded chat completion with tool support and usage accounting. */
// `temperature: null` leaves the sampling default (reasoning models refuse any other value); `reasoning` is OpenRouter's
// unified reasoning control ({ effort }), `responseFormat` the response_format object (JSON mode).
export async function chatCompletion({ apiKey, model, messages, tools = [], maxTokens, signal, fetcher = globalThis.fetch?.bind(globalThis), temperature = 0.3, reasoning = null, responseFormat = null }) {
  if (!apiKey) fail('OpenRouter is not configured.', 'AGENT_PROVIDER_MISSING');
  const body = { model, messages, max_tokens: maxTokens, ...(temperature === null || temperature === undefined ? {} : { temperature }), ...(reasoning ? { reasoning } : {}), ...(responseFormat ? { response_format: responseFormat } : {}), usage: { include: true }, ...(tools.length ? { tools, tool_choice: 'auto', parallel_tool_calls: false } : {}), provider: { allow_fallbacks: false, data_collection: 'deny' } };
  const response = await fetcher(OPENROUTER_API + '/chat/completions', { method: 'POST', headers: headers(apiKey), body: JSON.stringify(body), signal });
  const text = await response.text(); let json; try { json = JSON.parse(text); } catch { fail(`OpenRouter returned a non-JSON response (HTTP ${response.status}).`, 'AGENT_PROVIDER_RESPONSE', { status: response.status }); }
  if (!response.ok || json.error) fail(`OpenRouter error ${json.error?.code || response.status}: ${String(json.error?.message || text).slice(0, 200)}`, response.status === 402 ? 'AGENT_PROVIDER_FUNDS' : response.status === 429 ? 'AGENT_PROVIDER_RATE_LIMITED' : 'AGENT_PROVIDER_ERROR', { status: response.status, requestId: json.id || null });
  const choice = json.choices?.[0]; if (!choice?.message) fail('OpenRouter returned no completion.', 'AGENT_PROVIDER_RESPONSE', { requestId: json.id || null });
  const usage = json.usage || {};
  return { id: String(json.id || ''), model: String(json.model || model), message: choice.message, finishReason: choice.finish_reason || '', usage: { promptTokens: Number(usage.prompt_tokens) || 0, completionTokens: Number(usage.completion_tokens) || 0, totalTokens: Number(usage.total_tokens) || 0, costUsd: usage.cost !== undefined ? usdToMicro(usage.cost) : null, cachedTokens: Number(usage.prompt_tokens_details?.cached_tokens) || 0, reasoningTokens: Number(usage.completion_tokens_details?.reasoning_tokens) || 0 } };
}
/** Billing lookup by generation id for reconciliation of unknown or estimated costs. */
export async function generationCost({ apiKey, id, fetcher = globalThis.fetch?.bind(globalThis) }) {
  const response = await fetcher(`${OPENROUTER_API}/generation?id=${encodeURIComponent(id)}`, { headers: headers(apiKey, false), signal: AbortSignal.timeout(15000) });
  if (response.status === 404) return null;
  if (!response.ok) fail(`OpenRouter generation lookup returned HTTP ${response.status}.`);
  const body = (await response.json())?.data; if (!body) return null;
  return { id: body.id, totalCostUsd: usdToMicro(body.total_cost), promptTokens: Number(body.tokens_prompt) || 0, completionTokens: Number(body.tokens_completion) || 0, model: body.model || '' };
}
/** Remaining prepaid credit at the provider (owner health check). */
export async function providerCredits({ apiKey, fetcher = globalThis.fetch?.bind(globalThis) }) {
  const response = await fetcher(OPENROUTER_API + '/credits', { headers: headers(apiKey, false), signal: AbortSignal.timeout(15000) });
  if (!response.ok) fail(`OpenRouter credits lookup returned HTTP ${response.status}.`);
  const body = (await response.json())?.data || {}; return { totalCreditsUsd: usdToMicro(body.total_credits), totalUsageUsd: usdToMicro(body.total_usage), remainingUsd: usdToMicro(Math.max(0, Number(body.total_credits || 0) - Number(body.total_usage || 0))) };
}
export function estimateCostUsd(pricing, { promptTokens, completionTokens }) { return tokensCostUsd(promptTokens, pricing.promptMicroPerMillion) + tokensCostUsd(completionTokens, pricing.completionMicroPerMillion) + BigInt(pricing.requestUsd || 0n); }
