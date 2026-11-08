// Mocked AI Agent mode responses (src/agent/views.mjs read models and the
// owner/admin projections in src/agent/service.mjs). Two agent coins exist in
// data.mjs: SCOUT (Raydium, ready) and TIDE (Meteora, sleeping on budget).
import { sourceModule } from '../src-public.mjs';
import { coins, SOL, image } from './data.mjs';
import { address, signature, hex64, avatarPng } from './util.mjs';
const catalog = await sourceModule('public/agent-catalog.mjs');
const { AGENT_POLICY_V1, AGENT_RATE_CARD_V1, AGENT_PERSONALITIES, AGENT_LIMITS, AGENT_STATE_LABELS, AGENT_RULES, AGENT_FUNDING_SUMMARY, AGENT_VENUES, AGENT_TOOLS, AGENT_OBJECTIVES, AGENT_OBJECTIVE_GROUPS, capabilityList, capabilityMask, formatUsdMicro, objectiveById } = catalog;
const { AGENT_POLICY_HASH } = await sourceModule('src/agent/policy.mjs');
const { ModelRegistry, DEFAULT_MODEL_ALLOWLIST } = await sourceModule('src/agent/openrouter.mjs');
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000, SOL_USD = 152.37;
const usd = micro => formatUsdMicro(String(micro));
const explorer = sig => 'https://solscan.io/tx/' + sig;
// The real registry over a fake OpenRouter list: the default allowlist with plausible prices (USD per token), one
// model without tool support (qwen3-30b-a3b), one priced 30 hours ago (deepseek-chat-v3.1) and one the live list
// does not carry (minimax-m2.1). `registry.status()` is exactly what the admin snapshot publishes.
const LIVE = [
  ['openai/gpt-6-luna', 'OpenAI: GPT-6 Luna', '0.0000025', '0.00001', 1000000, 128000], ['openai/gpt-5.2', 'OpenAI: GPT-5.2', '0.00000175', '0.000014', 400000, 128000], ['openai/gpt-5-mini', 'OpenAI: GPT-5 Mini', '0.00000025', '0.000002', 400000, 128000], ['openai/gpt-5-nano', 'OpenAI: GPT-5 Nano', '0.00000005', '0.0000004', 400000, 128000],
  ['anthropic/claude-opus-4.5', 'Anthropic: Claude Opus 4.5', '0.000005', '0.000025', 200000, 64000], ['anthropic/claude-sonnet-4.5', 'Anthropic: Claude Sonnet 4.5', '0.000003', '0.000015', 1000000, 64000], ['anthropic/claude-haiku-4.5', 'Anthropic: Claude Haiku 4.5', '0.000001', '0.000005', 200000, 64000],
  ['google/gemini-3-pro-preview', 'Google: Gemini 3 Pro Preview', '0.000002', '0.000012', 1048576, 65536], ['google/gemini-2.5-flash', 'Google: Gemini 2.5 Flash', '0.0000003', '0.0000025', 1048576, 65535], ['google/gemini-2.5-flash-lite', 'Google: Gemini 2.5 Flash Lite', '0.0000001', '0.0000004', 1048576, 65535],
  ['qwen/qwen3-max', 'Qwen: Qwen3 Max', '0.0000012', '0.000006', 256000, 32768], ['qwen/qwen3-235b-a22b-2507', 'Qwen: Qwen3 235B A22B Instruct 2507', '0.00000013', '0.0000006', 262144, 16384], ['qwen/qwen3-30b-a3b', 'Qwen: Qwen3 30B A3B', '0.00000008', '0.0000003', 40960, 8192, false],
  ['x-ai/grok-4', 'xAI: Grok 4', '0.000003', '0.000015', 256000, 16384], ['x-ai/grok-4-fast', 'xAI: Grok 4 Fast', '0.0000002', '0.0000005', 2000000, 30000],
  ['deepseek/deepseek-v3.2', 'DeepSeek: DeepSeek V3.2', '0.00000028', '0.00000042', 163840, 65536], ['deepseek/deepseek-chat-v3.1', 'DeepSeek: DeepSeek V3.1', '0.0000002', '0.0000008', 163840, 65536],
  ['mistralai/mistral-large-2512', 'Mistral: Mistral Large 3', '0.0000005', '0.0000015', 262144, 32768], ['mistralai/mistral-medium-3.1', 'Mistral: Mistral Medium 3.1', '0.0000004', '0.000002', 131072, 32768], ['mistralai/mistral-small-3.2-24b-instruct', 'Mistral: Mistral Small 3.2 24B', '0.00000005', '0.0000001', 128000, 32768],
  ['moonshotai/kimi-k2-thinking', 'MoonshotAI: Kimi K2 Thinking', '0.0000006', '0.0000025', 262144, 32768], ['moonshotai/kimi-k2-0905', 'MoonshotAI: Kimi K2 0905', '0.0000004', '0.000002', 262144, 32768],
  ['minimax/minimax-m2', 'MiniMax: MiniMax M2', '0.0000003', '0.0000012', 204800, 32768],
  ['z-ai/glm-4.7', 'Z.ai: GLM 4.7', '0.0000006', '0.0000022', 200000, 65536], ['z-ai/glm-4.6', 'Z.ai: GLM 4.6', '0.0000004', '0.00000175', 202752, 65536],
].map(([id, name, prompt, completion, context, max, tools = true]) => ({ id, name, pricing: { prompt, completion, request: '0' }, context_length: context, top_provider: { max_completion_tokens: max }, supported_parameters: tools ? ['tools', 'tool_choice', 'temperature'] : ['temperature', 'top_p'] }));
const registry = new ModelRegistry({ allowlist: DEFAULT_MODEL_ALLOWLIST });
registry.ingest(LIVE.filter(row => row.id === 'deepseek/deepseek-chat-v3.1'), Date.now() - 30 * HOUR);
registry.ingest(LIVE.filter(row => row.id !== 'deepseek/deepseek-chat-v3.1'), Date.now() - 20 * MIN);
const MODELS = registry.catalog();
// PREVIEW_AGENT_PROGRAM=active|waiting|finished|limiter|off picks SCOUT's program state (default: active).
const SCOUT_PROGRAM = process.env.PREVIEW_AGENT_PROGRAM || 'active';
const programSpec = (objective, objectiveSettings, { active = true, reason = '', lastRunAgo = 2 * HOUR, nextDueIn = 3 * DAY, lastNote = '', actions = 0, lastActionAgo = null, finished = false, finishedReason = '', milestonesHit = [], launchMarketCapUsd = null } = {}) => ({ objective, objectiveSettings, active, reason, lastRunAgo, nextDueIn, lastNote, actions, lastActionAgo, finished, finishedReason, milestonesHit, launchMarketCapUsd });
const SCOUT_PROGRAMS = {
  active: programSpec('long_game', {}, { lastRunAgo: 2 * HOUR, nextDueIn: 3 * DAY + 5 * HOUR, lastNote: 'Proposed 0.0640 SOL: Long game: 7-day volume ($44.1k/day) is above the 30-day average ($31.2k/day); 2% buyback, keeping 40% in SOL.', actions: 3, lastActionAgo: 2 * HOUR }),
  waiting: programSpec('long_game', {}, { lastRunAgo: 40 * MIN, nextDueIn: 6 * HOUR, lastNote: 'Waiting: 7-day volume ($28.4k/day) is below the 30-day average ($31.2k/day); no buyback this check. Next check in 6 h.', actions: 3, lastActionAgo: 4 * DAY }),
  finished: programSpec('milestones', {}, { active: false, reason: 'All milestones reached: 2×, 5× and 10× of the launch market cap.', lastRunAgo: 9 * HOUR, nextDueIn: null, lastNote: 'Proposed 0.0650 SOL: Milestones: market cap $212.4k crossed 10× the launch value ($20.0k); holder reward of up to 5% of the treasury.', actions: 3, lastActionAgo: 9 * HOUR, finished: true, finishedReason: 'All milestones reached: 2×, 5× and 10× of the launch market cap.', milestonesHit: [2, 5, 10], launchMarketCapUsd: 20000 }),
  limiter: programSpec('patience', {}, { lastRunAgo: 3 * DAY, nextDueIn: 4 * DAY, lastNote: 'One model proposal accepted this week (0.0640 SOL buyback, Oct 1). The next treasury proposal is allowed from Oct 8.', actions: 2, lastActionAgo: 3 * DAY }),
  off: programSpec('long_game', {}, { active: false, reason: 'Paused by the creator.', lastRunAgo: 2 * DAY, nextDueIn: null, lastNote: 'Proposed 0.0640 SOL: Long game: 7-day volume above the 30-day average; 2% buyback.', actions: 3, lastActionAgo: 2 * DAY }),
};

// Per-agent fixtures keyed by coin symbol (see data.mjs `agent` specs).
const FIXTURES = {
  SCOUT: { state: 'ready', personalityVoice: true, program: SCOUT_PROGRAMS[SCOUT_PROGRAM] || SCOUT_PROGRAMS.active, mission: 'Track every public mention of SCOUT, summarise what people are asking, and post a short honest update twice a day. Never promise price moves.', personalityPreset: 'analyst', model: 'openai/gpt-6-luna', domains: ['solana.com', 'docs.raydium.io', 'dexscreener.com'], caps: capabilityMask({ buyback: true, rewards: true }), treasury: 18.4127, reserved: 0.065, frozen: 0, unsettled: 0.0412, settling: 0, settledUsdc: 3.21, backed: 6_412_000, reservedUsd: 0, spent: 1_588_000, fees: 26.362, receipts: 41, runs: 23, actions: 4, notes: 17, updates: 12, dayBudget: 1_282_400, daySpent: 418_200, lastRunAgo: 26 * MIN, activatedAgo: 6 * DAY },
  OWL: { state: 'running', program: programSpec('holders_first', { intervalDays: 7 }, { lastRunAgo: 50 * MIN, nextDueIn: 4 * DAY + 2 * HOUR, lastNote: 'Waiting: no treasury income above the gas reserve since the last distribution; nothing to share yet. Next check in 4 days.', actions: 1, lastActionAgo: 3 * DAY }), mission: 'Every evening, summarise Solana validator and network news in three bullet points with sources. Reward long-term holders once a week.', personalityPreset: 'scholar', model: 'openai/gpt-6-luna', domains: ['solana.com', 'dexscreener.com'], caps: capabilityMask({ rewards: true }), treasury: 7.214, reserved: 0, frozen: 0.5, unsettled: 0.0221, settling: 0, settledUsdc: 1.12, backed: 3_870_000, reservedUsd: 20_000, spent: 942_000, fees: 11.084, receipts: 27, runs: 31, actions: 2, notes: 22, updates: 15, dayBudget: 774_000, daySpent: 160_000, lastRunAgo: 1 * MIN, activatedAgo: 3 * DAY },
  TIDE: { state: 'sleeping_budget', program: programSpec('plain_truth', {}), stateReason: 'Backed operating credit is below $0.50. The agent resumes at $2.00 of backed credit.', mission: 'Explain Meteora dynamic fees to newcomers in plain language and keep a running FAQ in memory.', personalityPreset: 'scholar', model: 'openai/gpt-6-luna', domains: ['docs.meteora.ag'], caps: capabilityMask({}), treasury: 2.0814, reserved: 0, frozen: 0, unsettled: 0.0184, settling: 0.0612, settledUsdc: 0, backed: 312_000, reservedUsd: 0, spent: 2_104_000, fees: 2.97, receipts: 9, runs: 14, actions: 0, notes: 6, updates: 7, dayBudget: 2_000_000, daySpent: 0, lastRunAgo: 5 * HOUR, activatedAgo: 2 * DAY },
};
// Two directory-only agents (no coin record in data.mjs) show the finished Milestones program and the Patience limiter.
const EXTRA_COINS = [
  { symbol: 'MULE', name: 'Milestone Mule', platform: 'raydium', age: 19 * DAY, creator: { username: 'saltwater' } },
  { symbol: 'PELI', name: 'Patient Pelican', platform: 'meteora', age: 11 * DAY, creator: { username: 'lumen_labs' } },
].map(spec => ({ mint: address('mint:' + spec.symbol), name: spec.name, symbol: spec.symbol, image: image('coin:' + spec.symbol), platform: spec.platform, createdAt: Date.now() - spec.age, feeMode: 'agent', creator: spec.creator, stage: 'new' }));
Object.assign(FIXTURES, {
  MULE: { state: 'ready', mission: 'Mark the milestones. When the market cap crosses 2×, 5× and 10× of launch, reward holders, once per milestone, and say what changed.', personalityPreset: 'showrunner', model: 'anthropic/claude-sonnet-4.5', domains: ['solana.com'], caps: capabilityMask({ buyback: true, rewards: true }), treasury: 41.08, reserved: 0, frozen: 0, unsettled: 0.11, settling: 0, settledUsdc: 2.4, backed: 5_010_000, reservedUsd: 0, spent: 2_200_000, fees: 58.2, receipts: 96, runs: 70, actions: 3, notes: 40, updates: 33, dayBudget: 1_002_000, daySpent: 120_000, lastRunAgo: 22 * MIN, activatedAgo: 18 * DAY, program: SCOUT_PROGRAMS.finished },
  PELI: { state: 'ready', mission: 'Think more than you act. Propose at most one treasury action a week, and only with a reason holders would accept.', personalityPreset: 'diplomat', model: 'google/gemini-2.5-flash', domains: ['docs.meteora.ag'], caps: capabilityMask({ buyback: true }), treasury: 5.4, reserved: 0, frozen: 0, unsettled: 0.02, settling: 0, settledUsdc: 0.6, backed: 2_100_000, reservedUsd: 0, spent: 800_000, fees: 7.7, receipts: 18, runs: 20, actions: 2, notes: 12, updates: 9, dayBudget: 420_000, daySpent: 0, lastRunAgo: 12 * MIN, activatedAgo: 10 * DAY, program: SCOUT_PROGRAMS.limiter },
});
const agentCoins = () => [...coins().filter(coin => coin.feeMode === 'agent' && FIXTURES[coin.symbol]), ...EXTRA_COINS];
const objectiveOf = f => objectiveById(f.program?.objective || 'custom') || objectiveById('custom');
/** The public program view (src/agent/views.mjs program()): null when the objective has no program. */
function programView(f) {
  const objective = objectiveOf(f), spec = f.program; if (!objective.program) return null;
  const now = Date.now();
  return { rule: objective.program.rule, kind: objective.program.action === 'limiter' ? 'limiter' : 'program', spends: objective.spends, active: spec.active, reason: spec.reason, lastRunAt: spec.lastRunAgo == null ? null : now - spec.lastRunAgo, nextDueAt: spec.nextDueIn == null ? null : now + spec.nextDueIn, lastNote: spec.lastNote, actions: spec.actions, lastActionAt: spec.lastActionAgo == null ? null : now - spec.lastActionAgo, finished: spec.finished, finishedReason: spec.finishedReason, milestonesHit: spec.milestonesHit, launchMarketCapUsd: spec.launchMarketCapUsd };
}
const agentId = coin => hex64('agent:' + coin.symbol).slice(0, 24);
const wallet = coin => address('agent-wallet:' + coin.symbol);
function card(coin) {
  const f = FIXTURES[coin.symbol], now = Date.now(), treasury = f.treasury + f.reserved + f.frozen;
  const events = activityEvents(coin), last = events[0];
  return { id: agentId(coin), mint: coin.mint, name: coin.name, symbol: coin.symbol, image: coin.image, route: coin.platform, href: '/coin?mint=' + coin.mint + '#agent', state: f.state, stateLabel: AGENT_STATE_LABELS[f.state], stateReason: f.stateReason || '', mission: f.mission, model: f.model, capabilities: capabilityList(f.caps), personalityPreset: f.personalityPreset, objective: objectiveOf(f).id, objectiveName: objectiveOf(f).name, createdAt: coin.createdAt, activatedAt: now - f.activatedAgo, revision: 2,
    treasurySol: treasury.toFixed(4), treasuryUsd: usd(Math.round(treasury * SOL_USD * 1e6)), operatingBackedUsd: usd(f.backed), operatingUnsettledSol: (f.unsettled + f.settling).toFixed(4), feesSol: f.fees.toFixed(4), feeReceipts: f.receipts, lastActivity: last ? { kind: last.kind, title: last.title, at: last.at } : null, nextRunAt: f.state === 'ready' ? now - f.lastRunAgo + 30 * MIN : null, dryRun: false };
}
function balances(coin) {
  const f = FIXTURES[coin.symbol];
  return { treasury: { availableSol: f.treasury.toFixed(4), reservedSol: f.reserved.toFixed(4), frozenRewardsSol: f.frozen.toFixed(4), gasReserveSol: '0.01', suspenseSol: '0', tokensPendingBurn: {} },
    operating: { unsettledSol: f.unsettled.toFixed(4), settlingSol: f.settling.toFixed(4), settledUsdc: f.settledUsdc.toFixed(2), backedUsd: usd(f.backed), reservedUsd: usd(f.reservedUsd), spentUsd: usd(f.spent), disputedUsd: '$0.00' } };
}
function runs(coin) {
  const f = FIXTURES[coin.symbol], now = Date.now();
  return Array.from({ length: Math.min(f.runs, 8) }, (_, i) => { const started = now - f.lastRunAgo - i * 32 * MIN; return { id: 4000 + f.runs - i, state: i === 2 ? 'failed' : 'completed', trigger: 'schedule', model: f.model, dryRun: false, reservedUsd: '$0.02', spentUsd: i === 2 ? '$0.0031' : ['$0.0142', '$0.0088', '$0.0210'][i % 3], disputedUsd: '$0.00', modelCalls: i === 2 ? 1 : 3 + i % 3, toolCalls: i === 2 ? 1 : 4 + i % 5, browserActions: i % 2 ? 0 : 3, browserSeconds: i % 2 ? 0 : 24, summary: i === 2 ? '' : ['Posted an update on fee-share volume; saved two notes.', 'Read the Raydium docs page on LP locks; nothing new to report.', 'Compared 24h volume with yesterday and recorded the drop.'][i % 3], errorCode: i === 2 ? 'run_timeout' : '', queuedAt: started - 4000, startedAt: started, finishedAt: started + (i === 2 ? 90_000 : 41_000) }; });
}
function activityEvents(coin) {
  const f = FIXTURES[coin.symbol], now = Date.now(), id = agentId(coin), rows = [];
  let n = 900;
  const push = (ago, kind, title, body, data = {}) => rows.push({ id: n--, kind, title, body, data, runId: kind === 'run' || kind === 'update' ? 4000 + f.runs : null, at: now - ago });
  if (f.state === 'ready') {
    push(f.lastRunAgo - 2 * MIN, 'update', 'Volume cooled, questions did not', 'Trading volume is down 18% on yesterday while mentions of SCOUT rose. Most questions are about where the 70% treasury share goes; the answer is on the Treasury tab. No price prediction from me.');
    push(f.lastRunAgo - MIN, 'run', 'Run #' + (4000 + f.runs) + ' completed', 'Spent $0.0142 of a $0.02 reservation · 3 model calls · 6 tool calls · 3 browser actions.', { spentUsd: '$0.0142', reservedUsd: '$0.02' });
    push(f.lastRunAgo + 40 * MIN, 'action', 'Buyback & burn finalized', 'Bought 0.0640 SOL of SCOUT and burned the purchased amount.', { signature: signature('agent-buy:' + id), signatureUrl: explorer(signature('agent-buy:' + id)), burnSignature: signature('agent-burn:' + id), burnSignatureUrl: explorer(signature('agent-burn:' + id)), origin: 'program', objective: f.program?.objective });
    if (f.program?.objective) push(f.lastRunAgo + 42 * MIN, 'action', (objectiveOf(f).program?.action === 'rewards' || f.program.objective === 'milestones' ? 'Program holder reward proposed' : 'Program buyback proposed') + ': 0.0640 SOL', (f.program.lastNote || 'The platform proposed a treasury action from the ' + objectiveOf(f).name + ' program.') + ' Every program proposal passes the same policy caps as the model’s own.', { origin: 'program', objective: f.program.objective, kind: 'buyback_burn' });
    push(2 * HOUR, 'fee', 'Fee receipt credited', '0.4120 SOL received: 0.1236 SOL to operations, 0.2884 SOL to treasury.', { signature: signature('agent-fee:' + id + ':41'), signatureUrl: explorer(signature('agent-fee:' + id + ':41')) });
    push(5 * HOUR, 'settlement', 'Operating SOL settled to USDC', '0.5000 SOL settled for 75.84 USDC (network cost 0.000012 SOL).', { signature: signature('agent-settle:' + id), signatureUrl: explorer(signature('agent-settle:' + id)) });
    push(5 * HOUR + 10 * MIN, 'backing', 'Operating credit backed', '$75.84 of settled USDC backed by provider batch OR-2026-10-01.', {});
    push(DAY, 'revision', 'Revision r2 published', 'The creator added dexscreener.com to the research domains.', {});
  } else if (f.state === 'running') {
    push(f.lastRunAgo, 'run', 'Run started', 'Reading approved sources. Bounded to 90 seconds, 8 model calls and 16 tool calls.', {});
    push(31 * MIN, 'update', 'Validator news, in three bullets', 'Two client releases shipped this week, vote latency improved, and stake moved toward smaller validators. Sources in memory.', {});
    push(32 * MIN, 'run', 'Run #' + (4000 + f.runs) + ' completed', 'Spent $0.0063 of a $0.02 reservation · 4 model calls · 7 tool calls · 2 browser actions.', { spentUsd: '$0.0063' });
    push(3 * HOUR, 'fee', 'Fee receipt credited', '0.2210 SOL received: 0.0663 SOL to operations, 0.1547 SOL to treasury.', { signature: signature('agent-fee:' + id + ':27'), signatureUrl: explorer(signature('agent-fee:' + id + ':27')) });
    if (f.program?.objective) push(3 * DAY, 'action', 'Program holder reward proposed: 0.0650 SOL', 'Holders first: 0.0650 SOL of treasury income since the last distribution goes to holders. Every program proposal passes the same policy caps as the model’s own.', { origin: 'program', objective: f.program.objective, kind: 'holder_reward' });
  } else {
    push(10 * MIN, 'state', 'Sleeping on budget', f.stateReason, {});
    push(f.lastRunAgo, 'run', 'Run #' + (4000 + f.runs) + ' completed', 'Spent $0.0088 of a $0.02 reservation · 2 model calls · 4 tool calls.', { spentUsd: '$0.0088' });
    push(f.lastRunAgo + 3 * MIN, 'update', 'Dynamic fees, explained', 'Meteora pools charge a fee that starts high and decays over the first minutes of trading. The FAQ in my memory now has six answers.', {});
    push(9 * HOUR, 'fee', 'Fee receipt credited', '0.0612 SOL received: 0.0184 SOL to operations, 0.0428 SOL to treasury.', { signature: signature('agent-fee:' + id + ':9'), signatureUrl: explorer(signature('agent-fee:' + id + ':9')) });
  }
  push(f.activatedAgo, 'activated', 'Agent activated', 'Backed operating credit reached $2.00. Runs begin on the 30-minute cadence.', {});
  push(f.activatedAgo + HOUR, 'funding', 'Activity funding finalized', '0.0500 SOL deposited by the creator (100% operating).', { signature: signature('agent-fund:' + id), signatureUrl: explorer(signature('agent-fund:' + id)) });
  push(now - coin.createdAt - 2 * MIN, 'live', 'Launch is live', 'The coin is trading; fee receipts now credit this agent.', {});
  push(now - coin.createdAt, 'provisioned', 'Agent provisioned', 'A dedicated server-managed wallet was created for this agent.', {});
  return rows;
}
function actions(coin) {
  const f = FIXTURES[coin.symbol], now = Date.now(), id = agentId(coin);
  if (!f.actions) return [];
  const buy = signature('agent-buy:' + id), burn = signature('agent-burn:' + id);
  return [
    { id: 71, kind: 'buyback_burn', state: 'finalized', stateLabel: 'Completed', origin: 'program', reason: 'Long game: 7-day volume ($44.1k/day) is above the 30-day average ($31.2k/day); 2% buyback, keeping 40% in SOL.', requested: '0.064', principalSol: '0.0640', reservedSol: '0.0640', spentSol: '0.0640', evaluation: { ok: true, reason: '', bounded: true }, outcome: { bought: '4892260000', burned: '4892260000' }, error: '', legs: [{ sequence: 1, kind: 'buy', state: 'finalized', signature: buy, explorerUrl: explorer(buy), finalizedAt: now - f.lastRunAgo - 38 * MIN, error: '' }, { sequence: 2, kind: 'burn', state: 'finalized', signature: burn, explorerUrl: explorer(burn), finalizedAt: now - f.lastRunAgo - 36 * MIN, error: '' }], createdAt: now - f.lastRunAgo - 42 * MIN, finalizedAt: now - f.lastRunAgo - 36 * MIN },
    { id: 70, origin: 'model', kind: 'holder_reward', state: 'finalized', stateLabel: 'Completed', reason: 'Weekly holder reward to the top 100 minimum-balance holders.', requested: '0.065', principalSol: '0.0650', reservedSol: '0.0660', spentSol: '0.0650', evaluation: { ok: true, reason: '', bounded: false }, outcome: { paid: 100, deferred: 0 }, error: '', legs: Array.from({ length: 3 }, (_, i) => ({ sequence: i + 1, kind: 'reward', state: 'finalized', signature: signature('agent-reward:' + id + ':' + i), explorerUrl: explorer(signature('agent-reward:' + id + ':' + i)), finalizedAt: now - 2 * DAY + i * MIN, error: '' })), createdAt: now - 2 * DAY - 10 * MIN, finalizedAt: now - 2 * DAY + 2 * MIN },
    { id: 69, origin: 'model', kind: 'buyback_burn', state: 'rejected', stateLabel: 'Rejected', reason: 'Larger buyback after a quiet day.', requested: '2', principalSol: '0', reservedSol: '0', spentSol: '0', evaluation: { ok: false, reason: 'Requested 2 SOL exceeds the per-action cap of 0.0656 SOL (min $10, 2% of the opening treasury).', bounded: false }, outcome: null, error: '', legs: [], createdAt: now - 3 * DAY, finalizedAt: null },
    { id: 68, origin: 'model', kind: 'buyback_burn', state: 'submitted', stateLabel: 'Pending', reason: 'Routine buyback after the daily fee sweep.', requested: '0.06', principalSol: '0.0600', reservedSol: '0.0650', spentSol: '0', evaluation: { ok: true, reason: '', bounded: false }, outcome: null, error: '', legs: [{ sequence: 1, kind: 'buy', state: 'submitted', signature: signature('agent-buy-pending:' + id), explorerUrl: explorer(signature('agent-buy-pending:' + id)), finalizedAt: null, error: '' }], createdAt: now - 4 * MIN, finalizedAt: null },
  ];
}
export function agentCatalog({ intakeOpen = true } = {}) {
  return { mode: AGENT_POLICY_V1.mode, venues: AGENT_VENUES, intakeOpen, runsOpen: true, browserOpen: true, financialOpen: true, dryRun: false, models: MODELS, defaultModel: MODELS[0].id, personalities: AGENT_PERSONALITIES, objectives: AGENT_OBJECTIVES, objectiveGroups: AGENT_OBJECTIVE_GROUPS, limits: AGENT_LIMITS, domainAllowlist: ['solana.com', 'docs.raydium.io', 'docs.meteora.ag', 'dexscreener.com'], policy: agentPolicy(), funding: AGENT_FUNDING_SUMMARY, rules: AGENT_RULES, tools: AGENT_TOOLS, at: Date.now() };
}
export function agentPolicy() {
  const p = AGENT_POLICY_V1;
  return { hash: AGENT_POLICY_HASH, document: p, rateCard: AGENT_RATE_CARD_V1, defaultRateCard: AGENT_RATE_CARD_V1, custody: p.custody, limits: { activation: usd(p.activation.activateUsd), sleepBelow: usd(p.activation.sleepBelowUsd), resume: usd(p.activation.resumeUsd), runReserve: usd(p.run.maxReservedUsd), dailyCap: usd(p.budget.agentDailyCapUsd), platformDailyCap: usd(p.budget.platformDailyCapUsd), perAction: usd(p.treasury.perActionUsd), hourly: usd(p.treasury.hourlyUsd), daily: usd(p.treasury.dailyUsd), minimumPrincipal: usd(p.treasury.minimumPrincipalUsd), gasReserveSol: '0.01' } };
}
export function agentList() { return { agents: agentCoins().map(card), nextCursor: null, intakeOpen: true, at: Date.now(), refreshMs: 30000 }; }
const byMint = mint => agentCoins().find(coin => coin.mint === mint) || null;
export function agentDetail(mint) {
  const coin = byMint(mint); if (!coin) return null;
  const f = FIXTURES[coin.symbol], base = card(coin), preset = AGENT_PERSONALITIES.find(p => p.id === f.personalityPreset), run = runs(coin)[0] || null;
  return { ...base, blockers: f.state === 'sleeping_budget' ? ['budget'] : [], launchState: 'live', mission: f.mission, personality: preset?.text || '', objectiveSummary: objectiveOf(f).summary, objectiveSettings: f.program?.objectiveSettings || {}, program: programView(f), domains: f.domains, approvedDomains: f.domains, wallet: wallet(coin), policyHash: AGENT_POLICY_HASH, policyVersion: AGENT_POLICY_V1.version, custody: AGENT_POLICY_V1.custody, creatorPaused: false, adminPaused: false, integrityPaused: false, pauseReason: '', balances: balances(coin), budget: { dayKey: new Date().toISOString().slice(0, 10), dayBudgetUsd: usd(f.dayBudget), daySpentUsd: usd(f.daySpent), cadenceMinutes: 30 }, lastRun: run, openActions: f.actions ? 1 : 0, counts: { runs: f.runs, actions: f.actions, notes: f.notes, updates: f.updates }, browser: agentBrowser(mint), rules: AGENT_RULES, funding: AGENT_FUNDING_SUMMARY[coin.platform], at: Date.now(), refreshMs: 20000 };
}
export function agentActivity(mint, params) {
  const coin = byMint(mint); if (!coin) return null;
  const before = Number(params.get('before') || 0), after = Number(params.get('after') || 0), limit = Math.min(100, Number(params.get('limit') || 30));
  let rows = activityEvents(coin); if (before) rows = rows.filter(row => row.id < before); if (after) rows = rows.filter(row => row.id > after);
  rows = rows.slice(0, limit);
  return { events: rows, nextBefore: rows.length === limit ? rows.at(-1).id : null, lastId: 900, at: Date.now() };
}
export function agentRuns(mint) { const coin = byMint(mint); if (!coin) return null; const rows = runs(coin); return { runs: rows, nextBefore: rows.length ? rows.at(-1).queuedAt : null, at: Date.now() }; }
export function agentTreasury(mint) {
  const coin = byMint(mint); if (!coin) return null;
  const f = FIXTURES[coin.symbol], now = Date.now(), total = f.treasury + f.reserved + f.frozen, baseline = total + 0.3, cap = (usdAmount, bps) => Math.min(usdAmount / SOL_USD, baseline * bps / 10000);
  const perAction = cap(10, 200), hourly = cap(20, 500), daily = cap(50, 1000);
  return { mint, balances: balances(coin), caps: { perActionSol: perAction.toFixed(4), hourlySol: hourly.toFixed(4), dailySol: daily.toFixed(4), minimumPrincipalSol: (5 / SOL_USD).toFixed(4), baselineSol: baseline.toFixed(4), solUsd: SOL_USD, priceAt: now - 20000 }, capabilities: capabilityList(f.caps), actions: actions(coin),
    cycles: f.actions ? [{ id: 12, state: 'settled', totalSol: '0.5000', recipients: 100, windowFrom: now - 2 * DAY - 70 * MIN, windowTo: now - 2 * DAY - 10 * MIN, sampleCount: 13, paid: 100, deferred: 0, createdAt: now - 2 * DAY - 10 * MIN }] : [],
    holders: coin.stage === 'graduated' || f.actions ? { holders: 412, top10SharePercent: 31.4, top100SharePercent: 78.9, at: now - 4 * MIN, slot: 391204410, sampled: 412 } : null,
    fees: { count: f.receipts, total: String(Math.round(f.fees * 1e9)), operations: String(Math.round(f.fees * 0.3 * 1e9)), treasury: String(Math.round(f.fees * 0.7 * 1e9)), lastAt: now - 2 * HOUR }, custody: AGENT_POLICY_V1.custody, at: now };
}
export function agentReceipts(mint) {
  const coin = byMint(mint); if (!coin) return null;
  const f = FIXTURES[coin.symbol], id = agentId(coin), now = Date.now();
  const fees = Array.from({ length: Math.min(f.receipts, 12) }, (_, i) => { const amount = 0.412 - i * 0.021; return { signature: signature('agent-fee:' + id + ':' + (f.receipts - i)), explorerUrl: explorer(signature('agent-fee:' + id + ':' + (f.receipts - i))), venue: coin.platform, sol: amount.toFixed(4), operationsSol: (amount * 0.3).toFixed(4), treasurySol: (amount * 0.7).toFixed(4), slot: 391204000 - i * 5000, at: now - 2 * HOUR - i * 5 * HOUR, sourceAt: now - 2 * HOUR - i * 5 * HOUR - MIN }; });
  return { mint, fees, funding: [{ signature: signature('agent-fund:' + id), explorerUrl: explorer(signature('agent-fund:' + id)), purpose: 'activity', sol: '0.0500', at: now - f.activatedAgo - HOUR }], settlements: f.state === 'ready' ? [{ signature: signature('agent-settle:' + id), explorerUrl: explorer(signature('agent-settle:' + id)), inputSol: '0.5000', outputUsdc: '75.84', networkCostSol: '0.000012', at: now - 5 * HOUR }] : [], totals: { count: f.receipts, total: String(Math.round(f.fees * 1e9)), operations: String(Math.round(f.fees * 0.3 * 1e9)), treasury: String(Math.round(f.fees * 0.7 * 1e9)), lastAt: now - 2 * HOUR }, at: now };
}
export function agentMemory(mint) {
  const coin = byMint(mint); if (!coin) return null;
  const f = FIXTURES[coin.symbol], now = Date.now();
  const notes = f.state === 'ready' ? [
    { id: 310, kind: 'observation', title: 'Treasury share is the most common question', body: 'Across the last four runs, 9 of 14 holder questions asked where the 70% treasury share goes and whether it is spent automatically. Answered in the Oct 1 update; keep linking the Treasury tab.', sourceUrl: '', provenance: 'run 4023', at: now - 26 * MIN },
    { id: 309, kind: 'fact', title: 'Raydium LP lock terms', body: 'LaunchLab locks platform LP; the locked share earns fees that flow to the configured recipient. Confirmed on docs.raydium.io (read-only session).', sourceUrl: 'https://docs.raydium.io/raydium/pool-creation/launchlab', provenance: 'run 4019', at: now - 3 * HOUR },
    { id: 305, kind: 'plan', title: 'Update cadence', body: 'Post at most two updates per day; morning update covers volume, evening update covers questions. Skip when nothing changed.', sourceUrl: '', provenance: 'run 4001', at: now - 5 * DAY },
  ] : [
    { id: 120, kind: 'fact', title: 'Dynamic fee schedule', body: 'The pool fee starts at the configured maximum and decays toward the base fee during the first period after launch. Numbers vary per pool; cite the pool page rather than a constant.', sourceUrl: 'https://docs.meteora.ag/', provenance: 'run 4014', at: now - 5 * HOUR },
    { id: 118, kind: 'faq', title: 'FAQ: Does the creator get paid?', body: 'No. On an agent launch the creator allocation is routed to the agent wallet: 30% operating credit, 70% coin treasury. The creator payout is zero.', sourceUrl: '', provenance: 'run 4011', at: now - DAY },
  ];
  return { mint, notes, active: f.notes, limits: { noteBytes: AGENT_LIMITS.noteBytes, activeNotes: AGENT_LIMITS.activeNotes }, nextBefore: null, at: now };
}
export function agentBrowser(mint) {
  const coin = byMint(mint); if (!coin) return null;
  const f = FIXTURES[coin.symbol], now = Date.now(), active = f.state === 'running';
  return { viewer: 'live-screenshots', label: 'Live screenshots', available: f.domains.length > 0, active, host: active ? f.domains[0] : '', intervalSeconds: 4, screenshotId: f.state === 'ready' ? 88 : null, screenshotUrl: f.state === 'ready' ? '/api/launchpad/agents/screenshot?id=88' : null, screenshotAt: f.state === 'ready' ? now - f.lastRunAgo - 30000 : null, approvedDomains: f.domains, note: 'Read-only browsing on approved public domains. Viewers see server-produced screenshots, never a live control session.' };
}
export function agentMe(session) {
  if (!session || session.mode !== 'user') return { agents: [], at: Date.now() };
  // mira_builds owns SCOUT in data.mjs.
  return { agents: agentCoins().filter(coin => coin.creator.username === session.account.username).map(coin => { const f = FIXTURES[coin.symbol]; return { ...card(coin), mission: f.mission, personality: '', domains: f.domains, objective: objectiveOf(f).id, objectiveSettings: f.program?.objectiveSettings || {}, models: MODELS.filter(model => !model.unavailable).map(model => model.id), creatorPaused: false, wallet: wallet(coin) }; }), at: Date.now() };
}
export function agentAdmin() {
  const now = Date.now(), rows = agentCoins().map(coin => { const f = FIXTURES[coin.symbol]; return { ...card(coin), wallet: wallet(coin), accountId: hex64('acct:' + coin.creator.username).slice(0, 32), launchState: 'live', archived: false, hidden: false, creatorPaused: false, adminPaused: false, adminPauseReason: '', integrityPaused: false, integrityReason: '', balances: balances(coin), reimbursableUsdc: f.settledUsdc.toFixed(2), openActions: f.actions ? 1 : 0, activeRun: f.state === 'running', domains: f.domains, approvedDomains: f.domains, program: programView(f), recentActions: actions(coin).slice(0, 4).map((action, index) => ({ id: action.id, kind: action.kind, state: action.state, stateLabel: action.stateLabel, origin: index === 0 || index === 3 ? 'program' : 'model', principalSol: action.principalSol, reason: action.reason, createdAt: action.createdAt, finalizedAt: action.finalizedAt })) }; });
  return { version: 1, flags: { intake: true, runs: true, model: true, browser: true, financial: true, settlement: true, updatedAt: now - DAY, updatedBy: 'operator', reason: 'Staged rollout complete.' }, effective: { intake: true, runs: true, model: true, browser: true, financial: true, settlement: true, master: true, dryRun: false, modelConfigured: true, browserConfigured: true, operatorWallet: true, intakeOpen: true, runsOpen: true, modelOpen: true, browserOpen: true, financialOpen: true, settlementOpen: true },
    config: { models: MODELS.map(model => model.id), defaultModel: MODELS[0].id, operatorWallet: address('wallet:operator').slice(0, 6) + '…' + address('wallet:operator').slice(-4), domainAllowlist: ['solana.com', 'docs.raydium.io', 'docs.meteora.ag', 'dexscreener.com'], globalDailyUsd: '$10.00', modelConcurrency: 2, browserConcurrency: 1, dbPath: 'configured', backupDir: true, rateCard: AGENT_RATE_CARD_V1 },
    registry: registry.status(), worker: { kind: 'process', ready: true, pid: 48122, startedAt: now - 3 * DAY },
    solvency: { ledgerOk: true, problems: [], platform: { providerCapacityUsd: '$41.18', providerVarianceUsd: '$0.04', operatorReceivableUsdc: '3.21' }, totals: { treasurySol: '20.7441', operatingSol: '0.1208', settledUsdc: '3.21', backedUsd: '$6.72', reservedUsd: '$0.00', spentUsd: '$3.69', disputedUsd: '$0.00' } },
    pending: { settlementBatches: [{ id: 17, state: 'submitted', agentId: agentId(agentCoins()[1] || agentCoins()[0]), inputSol: '0.0612', error: '', attempts: 1, createdAt: now - 3 * MIN }], unknownUsage: [], openBrowserSessions: [], openActions: [{ id: 68, agentId: agentId(agentCoins()[0]), kind: 'buyback_burn', state: 'submitted', error: '', createdAt: now - 4 * MIN }], activeRuns: [], reimbursements: [] },
    alerts: [{ id: 5, scope: 'run:4017', code: 'variance-unfunded', message: 'Provider-reported cost exceeded the reservation by $0.04 on run 4017; posted to provider variance.', detail: {}, createdAt: now - 2 * DAY, clearedAt: null }],
    providerBatches: [{ id: 3, provider: 'openrouter', reference: 'OR-2026-10-01', paid: '52.75', purchaseFee: '2.75', credits: '$50.00', remainingUsdc: '8.82', remainingUsd: '$8.82', evidence: 'OpenRouter invoice 8F2A-0931', createdAt: now - DAY, recordedBy: 'operator' }, { id: 2, provider: 'openrouter', reference: 'OR-2026-09-24', paid: '21.10', purchaseFee: '1.10', credits: '$20.00', remainingUsdc: '0.00', remainingUsd: '$0.00', evidence: 'OpenRouter invoice 8F2A-0877', createdAt: now - 8 * DAY, recordedBy: 'operator' }],
    reimbursements: [{ id: 1, agentId: agentId(agentCoins()[0]), usdc: '41.00', state: 'finalized', signature: signature('agent-reimburse:1'), createdAt: now - 7 * DAY, finalizedAt: now - 7 * DAY + 2 * MIN, error: '' }],
    audit: [{ at: now - DAY, actorId: 'operator', actor: 'operator', action: 'flags', detail: 'financial: on, settlement: on', reason: 'Staged rollout complete.' }, { at: now - DAY - HOUR, actorId: 'operator', actor: 'operator', action: 'provider-batch', detail: 'OR-2026-10-01 · 52.75 USDC paid · $50.00 credits', reason: 'Monthly top-up.' }],
    agents: rows, policy: agentPolicy(), at: now };
}
export function agentHealth() { return { at: Date.now(), dryRun: false, model: { configured: true, ok: true, remainingUsd: '$41.18', totalCreditsUsd: '$70.00', totalUsageUsd: '$28.82' }, browser: { configured: true, ok: true, running: 0, orphans: 0, released: 0 }, database: { ok: true, version: 9 }, worker: { kind: 'process', ready: true, restarts: 0, inFlight: 1 }, catalog: registry.status(), openrouter: { ok: true, status: 200, credits: { totalCredits: 70, totalUsage: 28.82 }, models: MODELS.length }, browserbase: { ok: true, status: 200, runningSessions: 0, released: 0 }, rpc: { ok: true, slot: 391204410 } }; }
// Placeholder PNG for /api/launchpad/agents/screenshot in the preview.
export const SCREENSHOT_PNG = avatarPng('agent-screenshot', 256);
