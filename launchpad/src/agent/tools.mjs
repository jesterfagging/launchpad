// Typed tool allowlist for AI Agent runs. Every schema has
// additionalProperties:false and bounded sizes; arguments are validated by
// this module before anything runs, and the run context (agent, mint, chain,
// wallet) is never a model argument. Financial proposals carry only an amount
// bound and a public reason; the platform derives every account.
import { AGENT_TOOLS } from '../../public/agent-catalog.mjs';

const string = (description, maxLength, extra = {}) => ({ type: 'string', description, minLength: 1, maxLength, ...extra });
export const TOOL_SCHEMAS = Object.freeze({
  get_own_market: { description: 'Current market snapshot of your own coin: price, market cap, 24h volume, graduation stage. Read-only.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  get_own_treasury: { description: 'Your treasury and operating-credit balances, limits and pending actions. Read-only.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  get_own_fee_history: { description: 'Recent finalized fee receipts credited to you (30% operations / 70% treasury).', parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 20, description: 'How many receipts to return (default 10).' } }, additionalProperties: false } },
  get_own_holder_summary: { description: 'Holder statistics from the latest finalized snapshot of your coin: holder count, concentration, snapshot age.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  get_curve_coin: { description: 'Public market snapshot of any coin listed on Launchpad, by its mint address: price, market cap, 24h volume and change, curve progress, venue, fee mode. Read-only; returns a note when the mint is not listed.', parameters: { type: 'object', properties: { coinMint: string('Base58 mint address of a Launchpad coin (32–44 characters).', 44, { minLength: 32 }) }, required: ['coinMint'], additionalProperties: false } },
  list_curve_agents: { description: 'Public directory of AI agents on Launchpad (up to 24 newest): name, symbol, objective, state, mission and coin mint. Read-only.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  recall_memory: { description: 'Search your saved notes (full-text).', parameters: { type: 'object', properties: { query: string('Search words.', 200) }, required: ['query'], additionalProperties: false } },
  save_note: { description: 'Save a durable note for future runs: a fact, a decision or a source summary. Max 4 KB.', parameters: { type: 'object', properties: { title: string('Short title.', 120), body: string('Note body.', 3600), sourceUrl: { type: 'string', maxLength: 500, description: 'Optional https source URL.' } }, required: ['title', 'body'], additionalProperties: false } },
  publish_update: { description: 'Publish a concise public update to your coin page: conclusion, evidence, and any action summary. No raw reasoning.', parameters: { type: 'object', properties: { title: string('Headline.', 120), body: string('Update text, plain language.', 1200) }, required: ['title', 'body'], additionalProperties: false } },
  browser_open: { description: 'Open an approved public https page in the watch-only browser and read its visible text.', parameters: { type: 'object', properties: { url: string('Full https URL on an approved domain.', 2048) }, required: ['url'], additionalProperties: false } },
  browser_read: { description: 'Read more of the current page text (next chunk).', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  browser_follow_link: { description: 'Follow a link from the current page by its number in the last page listing.', parameters: { type: 'object', properties: { link: { type: 'integer', minimum: 1, maximum: 200, description: 'Link number from the listing.' } }, required: ['link'], additionalProperties: false } },
  browser_scroll: { description: 'Scroll the current page down one screen.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  propose_buyback_burn: { description: 'Propose buying your own coin with treasury SOL and burning exactly the purchased tokens. The platform caps and may reject it.', parameters: { type: 'object', properties: { amountSol: { type: 'number', minimum: 0.001, maximum: 1000, description: 'Desired SOL to spend; the policy caps it.' }, reason: string('Public, factual reason.', 280) }, required: ['amountSol', 'reason'], additionalProperties: false } },
  propose_holder_reward: { description: 'Propose distributing treasury SOL to the top 100 holders by minimum balance over the last hour of snapshots. The platform caps and may reject it.', parameters: { type: 'object', properties: { amountSol: { type: 'number', minimum: 0.001, maximum: 1000, description: 'Desired SOL to distribute; the policy caps it.' }, reason: string('Public, factual reason.', 280) }, required: ['amountSol', 'reason'], additionalProperties: false } },
  // v71.30: the AI influencer's one posting tool. The platform owns the X account, the media pipeline,
  // the caps and the link; the model supplies words and a picture brief. Queued, not immediate: media is
  // generated and the post is delivered by the platform after the run, within the creator's caps.
  post_to_x: { description: 'Queue one post to the coin’s connected X account as your character. Plain text up to 280 characters, no links (the platform adds the coin link when the creator enabled it), at most 2 hashtags, no price promises. Optionally ask for a picture or a short video of your character with a one-sentence brief; the platform generates it, checks it matches your character and delivers the post within the creator’s daily caps. At most one post per run.', parameters: { type: 'object', properties: { text: string('The post text, plain language, 1–280 characters, no URLs.', 280), media: { type: 'string', enum: ['none', 'image', 'video', 'feature'], maxLength: 7, description: 'none (text only), image (one picture of your character), video (a 5-second clip of your character) or feature (today’s longer feature clip, once a day, only when the creator enabled it and it is still available). Subject to the daily media caps.' }, mediaBrief: { type: 'string', maxLength: 240, description: 'For image or video: one sentence describing the scene, pose or mood. Your fixed appearance is added by the platform; do not describe it.' } }, required: ['text'], additionalProperties: false } },
});
for (const name of AGENT_TOOLS) if (!TOOL_SCHEMAS[name]) throw Error(`Missing tool schema for ${name}.`);
export const DATA_TOOLS = Object.freeze(['get_own_market', 'get_own_treasury', 'get_own_fee_history', 'get_own_holder_summary', 'get_curve_coin', 'list_curve_agents', 'recall_memory', 'save_note', 'publish_update']);
export const BROWSER_TOOLS = Object.freeze(['browser_open', 'browser_read', 'browser_follow_link', 'browser_scroll']);
export const PROPOSAL_TOOLS = Object.freeze(['propose_buyback_burn', 'propose_holder_reward']);
export const INFLUENCER_TOOLS = Object.freeze(['post_to_x']);

/** Strict validation of the bounded schema subset used above. Returns {ok, value|error}. */
export function validateArguments(name, raw) {
  const schema = TOOL_SCHEMAS[name]; if (!schema) return { ok: false, error: 'Unknown tool.' };
  let value = raw;
  if (typeof raw === 'string') { if (raw.length > 8192) return { ok: false, error: 'Arguments too large.' }; try { value = raw.trim() ? JSON.parse(raw) : {}; } catch { return { ok: false, error: 'Arguments are not valid JSON.' }; } }
  const result = check(schema.parameters, value, 'arguments'); return result.error ? { ok: false, error: result.error } : { ok: true, value: result.value };
}
function check(schema, value, path) {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: `${path} must be an object.` };
    const keys = Object.keys(value); if (keys.length > 20) return { error: `${path} has too many fields.` };
    for (const key of keys) if (!Object.hasOwn(schema.properties, key)) return { error: `${path}.${key} is not allowed.` };
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) return { error: `${path}.${key} is required.` };
    const out = {};
    for (const [key, item] of Object.entries(value)) { const child = check(schema.properties[key], item, `${path}.${key}`); if (child.error) return child; out[key] = child.value; }
    return { value: out };
  }
  if (schema.type === 'string') { if (typeof value !== 'string') return { error: `${path} must be a string.` }; if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) return { error: `${path} contains control characters.` }; if (value.length > schema.maxLength) return { error: `${path} is longer than ${schema.maxLength} characters.` }; if ((schema.minLength || 0) > value.trim().length) return { error: (schema.minLength || 0) > 1 ? `${path} must be at least ${schema.minLength} characters.` : `${path} cannot be empty.` }; if (schema.enum && !schema.enum.includes(value)) return { error: `${path} must be one of ${schema.enum.join(', ')}.` }; return { value }; }
  if (schema.type === 'integer') { if (!Number.isInteger(value)) return { error: `${path} must be an integer.` }; if (value < schema.minimum || value > schema.maximum) return { error: `${path} must be between ${schema.minimum} and ${schema.maximum}.` }; return { value }; }
  if (schema.type === 'number') { if (typeof value !== 'number' || !Number.isFinite(value)) return { error: `${path} must be a number.` }; if (value < schema.minimum || value > schema.maximum) return { error: `${path} must be between ${schema.minimum} and ${schema.maximum}.` }; return { value }; }
  if (schema.type === 'boolean') { if (typeof value !== 'boolean') return { error: `${path} must be true or false.` }; return { value }; }
  return { error: `${path} has an unsupported schema.` };
}
/** OpenRouter/OpenAI tool definitions for a capability set (financial tools only when opted in at launch; browser tools only when browsing is available; post_to_x only when the influencer may post this run). */
export function toolDefinitions({ buyback = false, rewards = false, browser = true, influencer = false } = {}) {
  const names = AGENT_TOOLS.filter(name => (name !== 'propose_buyback_burn' || buyback) && (name !== 'propose_holder_reward' || rewards) && (!BROWSER_TOOLS.includes(name) || browser) && (!INFLUENCER_TOOLS.includes(name) || influencer));
  return names.map(name => ({ type: 'function', function: { name, description: TOOL_SCHEMAS[name].description, parameters: TOOL_SCHEMAS[name].parameters } }));
}
