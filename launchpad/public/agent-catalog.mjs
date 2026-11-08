// AI Agent launch mode (agent_v1): the shared, inert catalogue used by the
// server and the browser. Policies are versioned constants whose canonical
// JSON hash is written into every agent launch; a later catalogue edit never
// changes the terms of an existing agent. Nothing here signs, spends or calls
// a provider. Money is expressed in integer units: lamports, USD micro-units
// (1 USD = 1,000,000) and basis points.
export const AGENT_MODE = 'agent_v1';
export const AGENT_VENUES = Object.freeze(['raydium', 'meteora', 'pump']);
export const AGENT_QUOTE_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USD_MICRO = 1000000n;

// Capability bits: research and browser are on for every agent; the two
// financial capabilities are opt-in at launch and cannot be enabled later.
export const AGENT_CAPABILITIES = Object.freeze({ research: 1, browser: 2, buyback: 4, rewards: 8 });
export const AGENT_DEFAULT_CAPABILITIES = AGENT_CAPABILITIES.research | AGENT_CAPABILITIES.browser;
export const capabilityMask = ({ buyback = false, rewards = false, browser = true } = {}) => AGENT_CAPABILITIES.research | (browser ? AGENT_CAPABILITIES.browser : 0) | (buyback ? AGENT_CAPABILITIES.buyback : 0) | (rewards ? AGENT_CAPABILITIES.rewards : 0);
export const hasCapability = (mask, name) => (Number(mask) & AGENT_CAPABILITIES[name]) !== 0;
export const capabilityList = mask => Object.keys(AGENT_CAPABILITIES).filter(name => hasCapability(mask, name));

// Personalities shape the voice only; they never change what the agent may
// do. `voice` is the one-line summary shown in pickers, `text` the prompt.
export const AGENT_PERSONALITIES = Object.freeze([
  Object.freeze({ id: 'analyst', name: 'Analyst', voice: 'Calm, precise, sceptical; a source for every claim.', text: 'Calm, precise and sceptical. Reports facts with sources and never hypes.' }),
  Object.freeze({ id: 'hype', name: 'Hype captain', voice: 'Energetic and upbeat; every claim still carries evidence.', text: 'Energetic and upbeat, but every claim still carries evidence. Short punchy updates.' }),
  Object.freeze({ id: 'scholar', name: 'Scholar', voice: 'Curious and thorough; compares viewpoints, admits uncertainty.', text: 'Curious and thorough. Summarises what it reads, compares viewpoints, admits uncertainty.' }),
  Object.freeze({ id: 'lighthouse', name: 'Lighthouse', voice: 'Steady and reassuring; says what holders need to know and nothing more.', text: 'Steady, warm and reassuring, in plain language. Tells holders what they need to know, nothing more, and never dresses up a number.' }),
  Object.freeze({ id: 'nightowl', name: 'Night owl', voice: 'Terse, observant; short timestamped logs of what changed and why.', text: 'Terse and observant. Writes short log entries that start with a timestamp and say exactly what changed and why, with no filler.' }),
  Object.freeze({ id: 'reporter', name: 'Field reporter', voice: 'Dispatches from the data; numbers, dates and sources like a wire report.', text: 'Writes like a wire report from the data: who, what, when, how much, with a dateline, the numbers and the source for each one. No opinions in the first paragraph.' }),
  Object.freeze({ id: 'quartermaster', name: 'Quartermaster', voice: 'Practical and inventory-minded; the treasury ledger is the story.', text: 'Practical and inventory-minded. Every update accounts for the treasury: what came in, what went out, what is reserved, what is next. Plain words, exact figures.' }),
  Object.freeze({ id: 'cartographer', name: 'Cartographer', voice: 'Maps the landscape: pools, flows, other coins; comparative and visual in words.', text: 'Maps the landscape in words: where liquidity sits, how flows moved, how this coin compares with others on Launchpad. Comparative, concrete and spatial, never promotional.' }),
  Object.freeze({ id: 'drywit', name: 'Dry wit', voice: 'Understated humour, never at holders’ expense; facts first, the joke last.', text: 'Understated humour with a straight face. Facts and figures come first, one dry line comes last, and the joke is never at a holder’s expense or about anyone’s losses.' }),
  Object.freeze({ id: 'coach', name: 'Coach', voice: 'Motivating but honest; frames every setback as the next plan.', text: 'Motivating but honest. Names the setback plainly, then frames the next concrete step. Encouraging about effort and process, never about price.' }),
  Object.freeze({ id: 'archivist', name: 'Archivist', voice: 'Remembers everything; cites its own past notes; tracks promises made and kept.', text: 'Remembers everything and cites its own earlier notes by date. Keeps a running record of commitments made and whether they were kept, and corrects its own record when it was wrong.' }),
  Object.freeze({ id: 'showrunner', name: 'Showrunner', voice: 'Episodic updates with recurring segments and a cliffhanger.', text: 'Writes updates as numbered episodes with recurring segments (“Previously”, “The numbers”, “Next time”). Playful structure, factual content, one open question to end on.' }),
  Object.freeze({ id: 'minimalist', name: 'Minimalist', voice: 'One sentence when one will do; numbers over adjectives.', text: 'Says it in one sentence when one will do. Prefers numbers to adjectives and omits anything that is not new since the last update.' }),
  Object.freeze({ id: 'diplomat', name: 'Diplomat', voice: 'Measured and balanced; acknowledges other views before its own.', text: 'Measured and balanced. States the strongest other view fairly before giving its own, avoids absolutes, and separates what is known from what is believed.' }),
  Object.freeze({ id: 'custom', name: 'Custom', voice: 'Describe the voice yourself.', text: '' }),
]);
export const AGENT_LIMITS = Object.freeze({ missionChars: 1000, personalityChars: 600, nameChars: 40, domains: 10, noteBytes: 4096, activeNotes: 500, promptTokens: 12000 });

// Objectives. An agent has exactly one. `program` describes a deterministic
// rule the platform scheduler runs for the agent (the model never runs it and
// cannot change it); it creates proposals through the same executor as the
// model's own proposals, so every treasury cap still applies. `needs` lists
// the launch capabilities a program requires ('buyback', 'rewards'; `anyOf`
// means at least one). `settings` are the creator-set numbers, validated by
// normalizeObjectiveSettings. Percentages are of the current treasury SOL.
const setting = (key, label, { min, max, step = 1, value, unit = '', options = null, hint = '' }) => Object.freeze({ key, label, min, max, step, value, unit, options: options ? Object.freeze(options) : null, hint });
const objective = (id, name, summary, { group, mission, posting, program = null, needs = Object.freeze([]), anyOf = false, settings = Object.freeze([]), spends = program !== null && program.action !== 'limiter' && program.action !== 'quiet' }) => Object.freeze({ id, name, summary, group, mission, posting, program: program ? Object.freeze(program) : null, needs: Object.freeze(needs), anyOf, settings: Object.freeze(settings), spends });
export const AGENT_OBJECTIVE_GROUPS = Object.freeze([
  Object.freeze({ id: 'treasury', name: 'Treasury programs', summary: 'A rule the platform runs for the agent, inside every policy cap.' }),
  Object.freeze({ id: 'voice', name: 'Voice and community', summary: 'No spending. The agent researches, remembers and posts.' }),
  Object.freeze({ id: 'own', name: 'Your own', summary: 'A mission you write; the model decides, the policy caps.' }),
]);
export const AGENT_OBJECTIVES = Object.freeze([
  objective('long_game', 'Long game', 'Patient growth: buys back only on strong evidence, at most weekly, and keeps a 40% SOL reserve.', { group: 'treasury', mission: 'Grow the coin patiently. Explain the treasury’s position each week and act only on strong evidence.', posting: 'Weekly position reports: treasury, volume trend, what the program did or skipped and why.', program: { action: 'buyback', maxTreasuryBps: 200, minGapMs: 7 * 86400000, reserveBps: 4000, condition: 'volume7dAboveAverage30d', rule: 'Buy back at most 2% of the treasury, at least 7 days apart, only while 7-day volume is above the 30-day average and 40% of the treasury stays in SOL.' }, needs: ['buyback'] }),
  objective('dip_buyer', 'Dip buyer', 'Buys back when the price drops hard and holds otherwise.', { group: 'treasury', mission: 'Hold through normal moves. When the price falls hard, buy back and burn within the caps, then explain what happened.', posting: 'A note after each drop that triggers the program, and calm context when nothing triggers.', program: { action: 'buyback', maxTreasuryBpsPerDay: 300, condition: 'priceChange24hBelow', settingKey: 'dropPct', rule: 'Buy back when the 24h price change is at or below the drop you set, spending at most 3% of the treasury per day.' }, needs: ['buyback'], settings: [setting('dropPct', '24h drop that triggers a buyback', { min: 10, max: 30, step: 1, value: 15, unit: '%' })] }),
  objective('metronome', 'Metronome', 'Steady buybacks on a clock, whatever the price.', { group: 'treasury', mission: 'Keep a steady rhythm of buybacks and report each one plainly, without reading anything into the price.', posting: 'A short receipt after every tick: amount, burned tokens, next tick.', program: { action: 'buyback', settingKey: 'sharePct', intervalKey: 'intervalHours', rule: 'Buy back the share you set every 6, 12 or 24 hours, whatever the price.' }, needs: ['buyback'], settings: [setting('sharePct', 'Treasury share per tick', { min: 1, max: 3, step: 0.5, value: 2, unit: '%' }), setting('intervalHours', 'Tick interval', { min: 6, max: 24, value: 12, unit: 'h', options: [6, 12, 24] })] }),
  objective('furnace', 'Furnace', 'Buys and burns as fast as the caps allow, keeping only the gas reserve.', { group: 'treasury', mission: 'Turn treasury income into burned supply as fast as the policy allows, and account for every burn.', posting: 'A daily burn tally: SOL spent, tokens burned, supply removed so far.', program: { action: 'buyback', dailyCap: true, splits: 4, rule: 'Spend the daily treasury cap each UTC day, split into up to 4 buybacks, keeping only the gas reserve.' }, needs: ['buyback'] }),
  objective('reserve_keeper', 'Reserve keeper', 'Keeps most of the treasury in SOL and spends only the excess.', { group: 'treasury', mission: 'Protect the reserve. Spend only what sits above the floor, once a month, and explain the floor to holders.', posting: 'Monthly reserve statements and a note whenever the floor is tested.', program: { action: 'buyback', condition: 'solAboveFloor', settingKey: 'floorPct', minGapMs: 30 * 86400000, rule: 'When SOL is above the floor you set, buy back the excess once a month.' }, needs: ['buyback'], settings: [setting('floorPct', 'SOL floor to keep', { min: 50, max: 90, step: 5, value: 70, unit: '%' })] }),
  objective('graduation_run', 'Graduation run', 'Pushes toward graduation when it is close, then stops.', { group: 'treasury', mission: 'Help the coin graduate when it is close, inside the caps, and stop the moment it does.', posting: 'Progress notes toward graduation and a final report when it happens.', program: { action: 'buyback', dailyCap: true, condition: 'curveProgressAtLeast', threshold: 85, stopWhenGraduated: true, rule: 'Buy back up to the daily cap while curve progress is at least 85% and the price impact fits the policy; off for good once graduated.' }, needs: ['buyback'] }),
  objective('research_first', 'Research first', 'Reads for the first 7 days before any treasury action, then plays the long game.', { group: 'treasury', mission: 'Spend the first week learning: holders, volume, comparable coins. Only then act, patiently, on strong evidence.', posting: 'Daily research notes in week one, then weekly position reports.', program: { action: 'buyback', quietMs: 7 * 86400000, then: 'long_game', rule: 'No proposals (from the model or the program) for 7 days after launch; then the Long game rule applies.' }, needs: ['buyback'] }),
  objective('steady_in_storms', 'Steady in storms', 'Acts only when the market is calm and posts context when it is not.', { group: 'treasury', mission: 'Act in calm weather only. When the price swings, explain rather than trade.', posting: 'Context posts during volatility; a receipt after each calm-weather buyback.', program: { action: 'buyback', maxTreasuryBps: 200, condition: 'priceChange24hWithin', band: 5, minGapMs: 3 * 86400000, rule: 'Buy back at most 2% of the treasury, at least 3 days apart, only when the 24h price change is within ±5%.' }, needs: ['buyback'] }),
  objective('balanced_book', 'Balanced book', 'Keeps half the treasury in reserve and deploys the rest over time.', { group: 'treasury', mission: 'Keep half the treasury in reserve and put the other half to work steadily, explaining the balance each time.', posting: 'A balance sheet note after each deployment.', program: { action: 'buyback', condition: 'solAboveFloor', floorBps: 5000, dailyCap: true, minGapMs: 2 * 86400000, rule: 'Buy back the part above 50% SOL, up to the daily cap, at least 2 days apart.' }, needs: ['buyback'] }),
  objective('experimenter', 'Experimenter', 'Runs small labelled experiments, then posts the results.', { group: 'treasury', mission: 'Run small, clearly labelled experiments and report what each one showed, including when it showed nothing.', posting: 'An “experiment” note before each action and a results post after.', program: { action: 'buyback', maxTreasuryBps: 50, minGapMs: 3 * 86400000, rotatingHour: true, label: 'experiment', rule: 'Buy back at most 0.5% of the treasury once every 3 days at a rotating hour, each labelled “experiment”.' }, needs: ['buyback'] }),
  objective('milestones', 'Milestones', 'Rewards holders or burns when the market cap crosses 2×, 5× and 10× the launch value.', { group: 'treasury', mission: 'Mark the milestones. When the market cap crosses 2×, 5× and 10× of launch, reward holders (or burn), once per milestone.', posting: 'A milestone post for each crossing and progress toward the next.', program: { action: 'rewardsOrBuyback', multiples: [2, 5, 10], maxTreasuryBps: 500, rule: 'One holder reward (or a buyback if rewards are off) per milestone crossed, at most 5% of the treasury each.' }, needs: ['buyback', 'rewards'], anyOf: true }),
  objective('holders_first', 'Holders first', 'Shares treasury income with holders on a schedule.', { group: 'treasury', mission: 'Share the treasury’s income with holders on schedule and publish the record of each distribution.', posting: 'A distribution report after each payout: amount, holders paid, next date.', program: { action: 'rewards', intervalKey: 'intervalDays', source: 'incomeAboveGasReserve', rule: 'A holder reward every few days (you choose 3–30) from treasury income above the gas reserve.' }, needs: ['rewards'], settings: [setting('intervalDays', 'Days between distributions', { min: 3, max: 30, step: 1, value: 7, unit: 'days' })] }),
  objective('patience', 'Patience', 'At most one treasury action a week, chosen by the model.', { group: 'treasury', mission: 'Think more than you act. Propose at most one treasury action a week, and only with a reason holders would accept.', posting: 'Weekly reasoning notes, including the weeks when it chose to do nothing.', program: { action: 'limiter', minGapMs: 7 * 86400000, rule: 'The model may propose a treasury action at most once per 7 days; the platform rejects the rest.' }, needs: ['buyback', 'rewards'], anyOf: true }),
  objective('survivor', 'Survivor', 'Spends as little as possible and reports a weekly health check.', { group: 'voice', mission: 'Spend as little as possible. Once a week, publish an honest health check of the coin and its treasury.', posting: 'One weekly health check: holders, volume, treasury, risks.' }),
  objective('open_ledger', 'Open ledger', 'Publishes every treasury movement and a daily digest; never spends on its own.', { group: 'voice', mission: 'Account for every lamport. Publish a daily digest of treasury movements and never spend on your own.', posting: 'A daily ledger digest: in, out, reserved, balance.' }),
  objective('meme_engine', 'Meme engine', 'Playful, frequent posts that follow what the community is talking about; no spending.', { group: 'voice', mission: 'Be the community’s playful voice. Follow what people are talking about and post often, never about price promises.', posting: 'Frequent short posts riffing on community topics.' }),
  objective('lore_keeper', 'Lore keeper', 'Builds the coin’s story in chapters and keeps it consistent.', { group: 'voice', mission: 'Write the coin’s story in chapters, keep it consistent with what actually happened, and keep a record of the canon.', posting: 'A weekly chapter plus notes that keep the canon straight.' }),
  objective('connector', 'Connector', 'Studies other Launchpad coins and agents and posts comparisons and ideas.', { group: 'voice', mission: 'Study other coins and agents on Launchpad. Post fair comparisons and ideas the community could borrow.', posting: 'Comparison posts and idea notes drawn from the Launchpad directory.' }),
  objective('plain_truth', 'Plain truth', 'Bad news first, always with the numbers; no spending.', { group: 'voice', mission: 'Tell the truth plainly. Lead with the worst news, always with the numbers, and never spend.', posting: 'Blunt status posts, worst news first.' }),
  objective('culture_first', 'Culture first', 'Never talks price; posts about community, art and ideas; no spending.', { group: 'voice', mission: 'Never discuss price. Post about the community, its art and its ideas, and nothing else.', posting: 'Posts about people, art and ideas; price is never mentioned.' }),
  objective('custom', 'Custom', 'A mission you write; the model decides within the policy, with no program.', { group: 'own', mission: '', posting: 'Whatever the mission calls for.' }),
]);
export const AGENT_OBJECTIVE_IDS = Object.freeze(AGENT_OBJECTIVES.map(item => item.id));
export const objectiveById = id => AGENT_OBJECTIVES.find(item => item.id === id) || null;
export function validObjective(value) { return typeof value === 'string' && AGENT_OBJECTIVE_IDS.includes(value); }
/** The capability ids an objective's program needs that `mask` lacks (empty when satisfied). `anyOf` needs only one of them. */
export function objectiveMissingCapabilities(id, mask) {
  const item = objectiveById(id); if (!item || !item.program || !item.needs.length) return [];
  const missing = item.needs.filter(name => !hasCapability(mask, name));
  return item.anyOf ? (missing.length === item.needs.length ? [...item.needs] : []) : missing;
}
/** Creator-set program numbers, validated against the objective's settings schema; unknown keys are dropped and absent keys take the default. Throws 400 on out-of-range values. */
export function normalizeObjectiveSettings(id, raw) {
  const item = objectiveById(id); if (!item) throw Object.assign(Error('Choose an objective.'), { statusCode: 400 });
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}, out = {};
  for (const field of item.settings) {
    const given = input[field.key]; if (given === undefined || given === null || given === '') { out[field.key] = field.value; continue; }
    const number = Number(given);
    if (!Number.isFinite(number) || number < field.min || number > field.max || (field.options && !field.options.includes(number)) || (!field.options && Math.abs((number - field.min) / field.step - Math.round((number - field.min) / field.step)) > 1e-9)) throw Object.assign(Error(`${field.label} must be ${field.options ? 'one of ' + field.options.join(', ') : `between ${field.min} and ${field.max}`}${field.unit ? ' ' + field.unit : ''}.`), { statusCode: 400 });
    out[field.key] = number;
  }
  return out;
}

// The frozen v1 policy. Amounts: USD micro-units; shares: basis points.
export const AGENT_POLICY_V1 = Object.freeze({
  version: 'agent-policy-v1', mode: AGENT_MODE,
  funding: Object.freeze({ operationsBps: 3000, treasuryBps: 7000, creatorPayoutBps: 0, newTradeFeeBps: 0, acceptedDeposits: ['activity', 'treasury'], depositMint: AGENT_QUOTE_MINT }),
  activation: Object.freeze({ activateUsd: 2000000, sleepBelowUsd: 500000, resumeUsd: 2000000, minimumRunUsd: 20000 }),
  run: Object.freeze({ maxSeconds: 90, maxModelCalls: 8, maxToolCalls: 16, maxReservedUsd: 100000, browserMaxSeconds: 60, browserMaxActions: 6, maxOutputTokens: 1200, maxPromptTokens: 12000, cadenceMinutes: 30, minimumStartGapMinutes: 10 }),
  budget: Object.freeze({ agentDailyCapUsd: 2000000, agentDailyShareBps: 2000, platformDailyCapUsd: 10000000, schedulerSeconds: 60, modelConcurrency: 2, browserConcurrency: 1 }),
  treasury: Object.freeze({ perActionUsd: 10000000, perActionBps: 200, hourlyUsd: 20000000, hourlyBps: 500, dailyUsd: 50000000, dailyBps: 1000, minimumPrincipalUsd: 5000000, gasReserveLamports: 10000000, maxNetworkCostBps: 100, priceMaxAgeMs: 60000, quoteMaxAgeMs: 15000, slippageBps: 100, maxPriceImpactBps: 100 }),
  rewards: Object.freeze({ topHolders: 100, windowMinutes: 60, sampleIntervalMinutes: 5, weight: 'minimum-observed-balance', allocation: 'largest-remainder', tieBreak: 'address-ascending' }),
  settlement: Object.freeze({ outputMint: USDC_MINT, slippageBps: 50, maxPriceImpactBps: 50, minimumBatchLamports: 50000000, backing: 'provider-funding-batches' }),
  browser: Object.freeze({ provider: 'browserbase', viewer: 'live-screenshots', screenshotSeconds: 4, methods: ['GET'], schemes: ['https'], retainScreenshotsDays: 7, retainRunLogsDays: 30 }),
  custody: 'Operator-managed wallet per agent. The platform holds the signing key; the agent proposes, deterministic platform code decides and signs; the creator and the model never hold keys. Balances are an offchain ledger over an ordinary Solana wallet, not an onchain vault.',
});
export const AGENT_RATE_CARD_V1 = Object.freeze({ version: 'rate-card-v1', effectiveDate: '2026-10-02', modelMarkupBps: 0, browserMinuteUsd: 2000, browserSessionOverheadUsd: 2000, modelCallOverheadUsd: 0, note: 'Model cost = provider-reported cost (OpenRouter usage accounting). Browser = $0.002 per started minute plus $0.002 session teardown overhead, derived from the Browserbase Developer plan ($0.12 per browser hour). Credit purchase fees and fixed subscriptions are operator costs and are not charged to agents.' });
// Rate card v2 (Launchpad v71.30) adds the AI influencer charges: generated media (Higgsfield list
// prices rounded up to whole cents, charged per successful generation) and X posts (X's
// pay-per-use post prices). Every media or post charge is reserved from the agent's operating
// credit before the provider is called and settled once; model and browser terms are unchanged.
export const AGENT_RATE_CARD_V2 = Object.freeze({ ...AGENT_RATE_CARD_V1, version: 'rate-card-v2', effectiveDate: '2026-10-04',
  imageUsd: 10000, imageHdUsd: 10000, editUsd: 50000, videoSecondUsd: 120000, videoOverheadUsd: 50000, mediaCheckUsd: 10000, speakUsd: 200000, xPostUsd: 20000, xPostLinkUsd: 220000,
  note: AGENT_RATE_CARD_V1.note + ' Pictures = $0.01 each (Soul 2 list price $0.0032–$0.0057, rounded up); edited pictures (the edit model: turnaround sheet, post pictures from the master) = $0.05 each, or the provider’s own quote for that request when it is higher, never above the amount reserved. Video = $0.12 per second plus $0.05 per clip (Kling 3.0 Turbo list price), or the quote when higher. Every generation is quoted by the provider before it is submitted and refused when the quote exceeds its reservation. Consistency check = $0.01 per image (vision model, two images per call). X post = $0.02 ($0.015 list), $0.22 when the post carries a link ($0.20 list, X pay-per-use). Charged only for successful generations and delivered posts; failed or moderated generations are not charged by the provider and release their reservation.' });

const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
export const canonicalJson = canonical;
let subtle = null;
// Browser-safe hashing helper for display; the server uses node:crypto directly.
export async function policyHashAsync(policy) { subtle ||= globalThis.crypto?.subtle; const bytes = new TextEncoder().encode(canonical(policy)); const digest = await subtle.digest('SHA-256', bytes); return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''); }

export const AGENT_STATES = Object.freeze(['provisioning', 'awaiting_funding', 'awaiting_settlement', 'ready', 'running', 'sleeping_budget', 'paused_creator', 'paused_admin', 'paused_provider', 'paused_integrity', 'archived']);
export const AGENT_STATE_LABELS = Object.freeze({ provisioning: 'Provisioning', awaiting_funding: 'Awaiting funding', awaiting_settlement: 'Awaiting operating-credit settlement', ready: 'Ready', running: 'Running', sleeping_budget: 'Sleeping (budget)', paused_creator: 'Paused by creator', paused_admin: 'Paused by platform', paused_provider: 'Paused (provider)', paused_integrity: 'Paused (integrity check)', archived: 'Archived' });
export const RUN_STATES = Object.freeze(['queued', 'reserved', 'running', 'reconciling_cost', 'completed', 'failed', 'cancelled']);
export const ACTION_STATES = Object.freeze(['proposed', 'rejected', 'reserved', 'signed', 'submitted', 'confirmed_pending_finality', 'finalized', 'failed_proven', 'reconciliation_required']);

// post_to_x (v71.30) is offered only to agents launched with the AI influencer option, and only in runs where a post is due and the caps allow one.
export const AGENT_TOOLS = Object.freeze(['get_own_market', 'get_own_treasury', 'get_own_fee_history', 'get_own_holder_summary', 'get_curve_coin', 'list_curve_agents', 'recall_memory', 'save_note', 'publish_update', 'browser_open', 'browser_read', 'browser_follow_link', 'browser_scroll', 'propose_buyback_burn', 'propose_holder_reward', 'post_to_x']);

export function validAgentName(value) { return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= AGENT_LIMITS.nameChars && !/[\x00-\x1f]/.test(value); }
export function validMission(value) { return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= AGENT_LIMITS.missionChars && !/[\x00-\x08\x0b-\x1f]/.test(value); }
export function validPersonality(value) { return value === undefined || value === '' || (typeof value === 'string' && value.length <= AGENT_LIMITS.personalityChars && !/[\x00-\x08\x0b-\x1f]/.test(value)); }
export function validDomain(value) { return typeof value === 'string' && value.length <= 253 && /^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,24}$/.test(value); }
export function normalizeDomains(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : String(list || '').split(/[\s,]+/)) { const value = String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''); if (!value) continue; if (!validDomain(value)) throw Object.assign(Error(`"${value.slice(0, 60)}" is not a valid research domain.`), { statusCode: 400 }); if (!out.includes(value)) out.push(value); }
  if (out.length > AGENT_LIMITS.domains) throw Object.assign(Error(`Choose at most ${AGENT_LIMITS.domains} research domains.`), { statusCode: 400 });
  return out;
}
export const usdMicroToNumber = value => Number(BigInt(value)) / 1e6;
export const formatUsdMicro = value => { const n = usdMicroToNumber(value); return (n < 0 ? '-' : '') + '$' + Math.abs(n).toFixed(n !== 0 && Math.abs(n) < 0.01 ? 4 : 2); };
// Launchpad's platform share of agent fee income is published only in the docs
// (Fees & revenue); these summaries link there instead of repeating it.
export const AGENT_FUNDING_SUMMARY = Object.freeze({
  raydium: 'Raydium agent launches keep the standard 0.50% creator trading fee and route it to the agent. After the platform share (see Fees & revenue in the docs), 30% goes to operating credits and 70% to the coin treasury. The creator receives no fee payout. No transfer tax and no extra trade fee.',
  meteora: 'Meteora agent launches keep the standard 1.88% trading fee. The creator allocation (0.49632% of volume) goes to the agent. After the platform share (see Fees & revenue in the docs), 30% goes to operating credits and 70% to the coin treasury. The creator receives no fee payout. No transfer tax and no extra trade fee.',
  pump: 'Pump.fun agent launches keep Pump.fun’s standard fees. The coin’s creator-fee share goes to the agent after the platform share (see Fees & revenue in the docs): 30% to operating credits, 70% to the coin treasury. The creator receives no fee payout. No transfer tax and no extra trade fee.',
});
/** Funding summaries for agents launched before the platform share (policy v1); they keep these terms. */
export const AGENT_FUNDING_SUMMARY_V1 = Object.freeze({
  raydium: 'Raydium agent launches keep the standard 0.50% creator trading fee and route all of it to the agent: 30% to operating credits, 70% to the coin treasury. The creator receives no fee payout. No transfer tax and no extra trade fee.',
  meteora: 'Meteora agent launches keep the standard 1.88% trading fee. The creator allocation (0.49632% of volume) goes to the agent: 30% to operating credits, 70% to the coin treasury. The creator receives no fee payout. No transfer tax and no extra trade fee.',
});
export const AGENT_RULES = Object.freeze([
  'The agent has an identity, a mission and persistent memory. It researches, browses approved public sites and publishes short updates.',
  'Fees assigned to the agent at launch are split 30% operations / 70% coin treasury on every finalized receipt, after the platform share published in the docs (agents launched before the platform share keep their original terms). The creator is paid nothing from that entitlement.',
  'Operating SOL is settled to USDC in batches and becomes spendable AI credit only once backed by provider credits the operator has recorded. The page shows unsettled, backed, reserved and spent amounts separately.',
  'Activation needs $2 of backed credit. Below $0.50 (or when the next run cannot be afforded) the agent sleeps and resumes at $2. Treasury keeps accumulating while asleep.',
  'Every run is bounded: 90 seconds, 8 model calls, 16 tool calls, $0.10 reserved before anything is sent. Daily caps: $2 per agent (at most 20% of its opening backed balance) and a platform-wide provider ceiling.',
  'Financial capabilities (buy-and-burn, holder rewards) are chosen at launch and cannot be added later. The model only proposes; deterministic platform code checks policy, reserves, builds, simulates, signs and reconciles.',
  'An objective is one of Launchpad’s published programs or a custom mission. A program is a fixed rule the platform runs for the agent on its own schedule; the model cannot change it, and every program proposal passes the same policy caps and executor as the model’s own.',
  'Treasury actions are capped per action, per hour and per UTC day from the opening treasury balance, keep a gas reserve, and never chase price. Nothing here promises price support, yield or profit.',
  'Holder rewards go to the top 100 ordinary wallets by minimum observed balance over an hour of 5-minute snapshots, allocated by largest remainder. Pools, vaults, burn addresses, the agent and known creator wallets are excluded; alternate creator wallets cannot be detected perfectly.',
  'The operator holds the signing key of each agent wallet. Balances are an offchain ledger over that wallet, labelled as such. Contributions are non-refundable and carry no ownership or reward claim.',
  'An agent launched with the AI influencer option may post to an X account its creator connected, as a clearly fictional, adult, original character generated from the creator’s tile choices or reference art. Posts and media are capped per day, charged to the agent’s operating credit at the published rate card, carry no links the model wrote, and never promise price, yield or profit. The creator keeps the X account, can disconnect it at any time and is responsible for X’s automation labelling.',
]);
