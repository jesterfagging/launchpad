// Admin → Tokens → AI Agents: owner-only operations. Health results read as a summary, releasing orphaned
// browser sessions is a POST with password and 2FA, and a provider batch is checked before the prompt.
// The Models card lists every allowlisted model by provider with its live price, tag and availability; agent
// rows carry the objective chip, the program pill and (opened) the program's rule, note, schedule and actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createAdminAgents, programStatus } from '../public/admin-agents-ui.mjs';

const OWNER = { id: 'owner', role: 'admin', mfaEnabled: true }, NOW = Date.UTC(2026, 9, 3, 12, 0, 0), MIN = 60000, HOUR = 3600000, DAY = 86400000;
const MINT = 'So11111111111111111111111111111111111111112', WALLET = 'HTYV4yu546BS3zmNguDwHuY7jGYD2eZNjTBrgLNZSGo6';
const model = (id, name, overrides = {}) => ({ id, name, provider: id.split('/')[0], providerName: ({ openai: 'OpenAI', anthropic: 'Anthropic', qwen: 'Qwen', deepseek: 'DeepSeek', minimax: 'MiniMax', 'z-ai': 'Z.ai' })[id.split('/')[0]], tag: 'balanced', available: true, unavailableReason: null, promptUsdPerMillion: 1, completionUsdPerMillion: 5, contextLength: 200000, maxCompletionTokens: 32000, supportsTools: true, pricedAt: NOW - 20 * MIN, stale: false, unavailable: false, ...overrides });
const MODELS = [
  model('openai/gpt-6-luna', 'OpenAI: GPT-6 Luna', { tag: 'deep', promptUsdPerMillion: 2.5, completionUsdPerMillion: 10, contextLength: 1000000 }),
  model('openai/gpt-5-nano', 'OpenAI: GPT-5 Nano', { tag: 'fast', promptUsdPerMillion: 0.05, completionUsdPerMillion: 0.4, contextLength: 400000 }),
  model('anthropic/claude-haiku-4.5', 'Anthropic: Claude Haiku 4.5'),
  model('qwen/qwen3-30b-a3b', 'Qwen: Qwen3 30B A3B', { tag: 'fast', available: false, unavailableReason: 'no tools support', supportsTools: false, completionUsdPerMillion: 0.3, contextLength: 40960 }),
  model('deepseek/deepseek-chat-v3.1', 'DeepSeek: DeepSeek V3.1', { tag: 'fast', available: false, unavailableReason: 'pricing stale', stale: true, pricedAt: NOW - 30 * HOUR, completionUsdPerMillion: 0.8 }),
  model('minimax/minimax-m2.1', 'minimax/minimax-m2.1', { tag: null, available: false, unavailableReason: 'not in the live catalog', promptUsdPerMillion: null, completionUsdPerMillion: null, contextLength: 0, maxCompletionTokens: 0, supportsTools: null, pricedAt: null, stale: true, unavailable: true }),
  model('z-ai/glm-4.6', 'z-ai/glm-4.6', { tag: null, available: false, unavailableReason: 'no pricing', promptUsdPerMillion: null, completionUsdPerMillion: null, contextLength: 0, supportsTools: null, pricedAt: null, stale: true, unavailable: true }),
];
const registry = (overrides = {}) => ({ refreshedAt: NOW - 20 * MIN, error: '', lastRefreshError: '', refreshMs: 600000, staleMs: DAY, total: MODELS.length, available: 3, providers: [], models: MODELS, ...overrides });
const balances = { treasury: { availableSol: '1.0000', reservedSol: '0.0000', frozenRewardsSol: '0.0000' }, operating: { unsettledSol: '0.0000', settlingSol: '0.0000', settledUsdc: '0.00', backedUsd: '$0.00', reservedUsd: '$0.00', spentUsd: '$0.00', disputedUsd: '$0.00' } };
const agent = (id, name, symbol, overrides = {}) => ({ id, mint: MINT, name, symbol, route: 'raydium', launchState: 'live', state: 'ready', stateLabel: 'Ready', stateReason: '', model: 'openai/gpt-6-luna', personalityPreset: 'analyst', wallet: WALLET, domains: ['solana.com'], approvedDomains: ['solana.com'], balances, reimbursableUsdc: '0.00', openActions: 0, activeRun: false, archived: false, hidden: false, creatorPaused: false, adminPaused: false, integrityPaused: false, createdAt: NOW - 6 * DAY, nextRunAt: NOW + 4 * MIN, ...overrides });
const LONG_GAME_RULE = 'Buy back at most 2% of the treasury, at least 7 days apart, only while 7-day volume is above the 30-day average.';
const AGENTS = [
  agent('a-scout', 'Scout Signal', 'SCOUT', { objective: 'long_game', objectiveName: 'Long game', program: { rule: LONG_GAME_RULE, kind: 'program', spends: true, active: true, reason: '', lastRunAt: NOW - 26 * MIN, nextDueAt: NOW + 6 * DAY, lastNote: '7-day volume is 12% above the 30-day average; proposed a 0.064 SOL buyback.', actions: 3, lastActionAt: NOW - HOUR, finished: false, finishedReason: '', milestonesHit: [], launchMarketCapUsd: 18400 },
    recentActions: [{ id: 71, kind: 'buyback_burn', state: 'finalized', stateLabel: 'Completed', origin: 'program', principalSol: '0.0640', createdAt: NOW - HOUR }, { id: 70, kind: 'holder_reward', state: 'finalized', stateLabel: 'Completed', origin: 'model', principalSol: '0.0650', createdAt: NOW - 2 * DAY }, { id: 69, kind: 'buyback_burn', state: 'rejected', stateLabel: 'Rejected', origin: 'program', principalSol: '0', createdAt: NOW - 3 * DAY }] }),
  agent('a-owl', 'Night Owl Notes', 'OWL', { state: 'running', stateLabel: 'Running', model: 'anthropic/claude-haiku-4.5', personalityPreset: 'scholar', objective: 'research_first', objectiveName: 'Research first', program: { rule: 'No proposals for 7 days after launch; then the Long game rule applies.', kind: 'program', spends: true, active: false, reason: 'Reading for the first 7 days (until Oct 8, 2026); no treasury action before then.', lastRunAt: NOW - 31 * MIN, nextDueAt: NOW + 4 * DAY, lastNote: '', actions: 0, lastActionAt: null, finished: false, finishedReason: '', milestonesHit: [] }, recentActions: [] }),
  agent('a-tide', 'Tidewriter', 'TIDE', { route: 'meteora', state: 'paused_creator', stateLabel: 'Paused by creator', creatorPaused: true, objective: 'metronome', objectiveName: 'Metronome', program: { rule: 'Buy back 1–3% of the treasury every 6, 12 or 24 hours.', kind: 'program', spends: true, active: false, reason: 'Needs buy-and-burn, which this agent launched without.', lastRunAt: null, nextDueAt: null, lastNote: '', actions: 0, lastActionAt: null, finished: false, finishedReason: '', milestonesHit: [] } }),
  agent('a-mile', 'Milestone Maker', 'MILE', { objective: 'milestones', objectiveName: 'Milestones', program: { rule: 'One holder reward or buyback per milestone crossed.', kind: 'program', spends: true, active: false, reason: 'Every milestone was reached.', lastRunAt: NOW - DAY, nextDueAt: null, lastNote: 'Crossed 10× the launch value.', actions: 3, lastActionAt: NOW - DAY, finished: true, finishedReason: 'Every milestone was reached.', milestonesHit: [2, 5, 10] } }),
  agent('a-custom', 'Free Spirit', 'FREE', { objective: 'custom', objectiveName: 'Custom', program: null }),
  agent('a-legacy', 'Old Timer', 'OLD', { nextRunAt: null, lastActivity: { kind: 'run', title: 'Run completed', at: NOW - 3 * HOUR } }),
  agent('a-hidden', 'Copycat', 'COPY', { hidden: true, hiddenReason: 'Impersonates a listed project.', hiddenBy: 'mira', hiddenAt: NOW - 2 * HOUR }),
];
const snapshot = (overrides = {}) => ({ version: 1, at: NOW, flags: {}, effective: { master: true }, worker: { ready: true }, registry: { refreshedAt: NOW }, solvency: { ledgerOk: true, totals: {}, platform: {} }, alerts: [], pending: {}, providerBatches: [], agents: [], audit: [], ...overrides });
const health = { at: NOW, model: { configured: true, ok: true, remainingUsd: '$12.34', totalCreditsUsd: '$50.00', totalUsageUsd: '$37.66' }, browser: { configured: true, ok: true, running: 3, orphans: 1, released: 1 }, database: { ok: true, version: 7 }, worker: { kind: 'process', ready: true, restarts: 0, inFlight: 2 }, dryRun: false, catalog: { refreshedAt: NOW, error: null, models: [{}, {}] } };
function page({ respond } = {}) {
  const { document } = parseHTML('<html><body></body></html>'); Object.defineProperty(document, 'hidden', { value: false, writable: true });
  const calls = [], auths = [], messages = [];
  const ui = createAdminAgents({ document, getAccount: () => OWNER, isActive: () => true, clock: () => NOW, message: (text, error) => messages.push({ text, error: !!error }), security: { authorize: async (label, options) => { auths.push({ label, options }); return { password: 'pw', code: '123456' }; } }, api: async (path, body) => { calls.push({ path, body }); return (await respond?.(path, body)) ?? (path.includes('/health') ? health : snapshot()); }, setTimer: () => 1, clearTimer() {} });
  document.body.append(ui.element);
  const button = text => [...ui.element.querySelectorAll('button')].find(node => node.textContent === text);
  const row = id => ui.element.querySelector(`[data-agent-row="${id}"]`);
  return { ui, document, calls, auths, messages, button, row, get: id => document.getElementById(id), $: selector => ui.element.querySelector(selector), $$: selector => [...ui.element.querySelectorAll(selector)] };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const texts = nodes => [...nodes].map(node => node.textContent.trim());

test('the provider health check is a read and its result reads as a summary, not JSON', async () => {
  const p = page(); await p.ui.load(); await p.button('Provider health check (no spend)').onclick();
  assert.deepEqual(p.calls.at(-1), { path: '/api/admin/agents/health', body: undefined }); assert.equal(p.auths.length, 0);
  const text = p.get('admin-agents-health').textContent;
  assert.match(text, /Model provider \(OpenRouter\): OK, \$12\.34 credit left of \$50\.00/); assert.match(text, /3 running sessions, 1 orphaned session, 1 session released/); assert.match(text, /Database: OK \(schema 7\)/); assert.match(text, /Worker: ready, 2 in flight/); assert.match(text, /Model catalog: 2 models/);
  assert.doesNotMatch(text, /[{}"]/); p.ui.destroy();
});

test('releasing orphaned browser sessions is a POST with the owner password and 2FA', async () => {
  const p = page(); await p.ui.load(); p.get('admin-agents-reason').value = 'Clean up stuck sessions';
  await p.button('Release orphan browsers').onclick(); await settle();
  assert.deepEqual(p.auths.at(-1), { label: 'Release orphan browsers', options: { requireCode: true } });
  assert.deepEqual(p.calls.at(-1), { path: '/api/admin/agents/health?releaseOrphans=1', body: { releaseOrphans: true, reason: 'Clean up stuck sessions', password: 'pw', code: '123456' } });
  assert.match(p.get('admin-agents-health').textContent, /1 session released/); p.ui.destroy();
});

test('a provider funding batch with missing or invalid fields never opens the identity prompt', async () => {
  const p = page(); await p.ui.load(); p.get('admin-agents-reason').value = 'Record the October credit purchase';
  const fill = values => { for (const [key, value] of Object.entries(values)) p.get('admin-agents-batch-' + key).value = value; };
  const save = p.button('Record provider funding batch');
  for (const [values, expected] of [[{ reference: '', paidUsdc: '', creditsUsd: '' }, /invoice or payment reference/], [{ reference: 'or-inv-1', paidUsdc: 'abc', creditsUsd: '94.5' }, /amount paid in USDC/], [{ reference: 'or-inv-1', paidUsdc: '100', purchaseFeeUsdc: '120', creditsUsd: '94.5' }, /no more than the amount paid/], [{ reference: 'or-inv-1', paidUsdc: '100', purchaseFeeUsdc: '5.5', creditsUsd: '0' }, /credits received/]]) {
    fill(values); save.onclick(); await settle(); assert.match(p.messages.at(-1).text, expected); assert.equal(p.messages.at(-1).error, true);
  }
  assert.equal(p.auths.length, 0); assert.equal(p.calls.filter(call => call.body).length, 0);
  fill({ reference: 'or-inv-1', evidence: 'OpenRouter invoice or-inv-1', paidUsdc: '100', purchaseFeeUsdc: '5.5', creditsUsd: '94.5' }); save.onclick(); await settle(); await settle();
  assert.equal(p.auths.at(-1).label, 'Record provider batch or-inv-1');
  assert.deepEqual(p.calls.find(call => call.path === '/api/admin/agents/provider-batch').body, { provider: 'openrouter', reference: 'or-inv-1', evidence: 'OpenRouter invoice or-inv-1', paidUsdc: '100', purchaseFeeUsdc: '5.5', creditsUsd: '94.5', password: 'pw', code: '123456' });
  p.ui.destroy();
});

test('agent dates carry the year', async () => {
  const p = page(); await p.ui.load(); assert.match(p.get('admin-agents-status').textContent, /Snapshot .*2026/); p.ui.destroy();
});

test('the Models card groups every allowlisted model by provider with its tag, price, tools and availability pill', async () => {
  const p = page({ respond: path => path === '/api/admin/agents' ? snapshot({ registry: registry() }) : undefined }); await p.ui.load();
  assert.equal(p.$('#admin-agents-models h3').textContent, 'Models (3 of 7 available)');
  assert.match(p.get('admin-agents-models-note').textContent, /^Catalog read 20 minutes ago \(.*2026.*\) · prices count as stale after 24 hours; creators can only launch available models\.$/);
  const groups = p.$$('#admin-agents-models-table tbody');
  assert.deepEqual(groups.map(group => group.dataset.provider), ['openai', 'anthropic', 'qwen', 'deepseek', 'minimax', 'z-ai']);
  const groupText = () => p.$$('.admin-model-group').map(row => row.querySelector('strong').textContent + ' · ' + row.querySelector('.admin-model-group-count').textContent);
  assert.deepEqual(groupText(), ['OpenAI · 2 of 2 models available', 'Anthropic · 1 of 1 model available', 'Qwen · 0 of 1 model available', 'DeepSeek · 0 of 1 model available', 'MiniMax · 0 of 1 model available', 'Z.ai · 0 of 1 model available']);
  const rows = p.$$('tr[data-model]'); assert.equal(rows.length, MODELS.length);
  const cells = id => [...p.$(`tr[data-model="${id}"]`).children].map(cell => cell.textContent.trim().replace(/Copied$/, '').trim());
  assert.deepEqual(cells('openai/gpt-6-luna'), ['GPT-6 Lunaopenai/gpt-6-luna', 'Deep', '$2.5', '$10', '1M', 'Yes', 'Available', '20 minutes ago']);
  assert.deepEqual(cells('openai/gpt-5-nano').slice(1, 7), ['Fast', '$0.05', '$0.4', '400K', 'Yes', 'Available']);
  assert.deepEqual(cells('anthropic/claude-haiku-4.5').slice(0, 2), ['Claude Haiku 4.5anthropic/claude-haiku-4.5', 'Balanced']);
  assert.deepEqual(cells('qwen/qwen3-30b-a3b').slice(5, 7), ['No', 'No tools']);
  assert.deepEqual(cells('deepseek/deepseek-chat-v3.1').slice(6), ['Stale', '1 day ago']);
  assert.deepEqual(cells('minimax/minimax-m2.1'), ['—minimax/minimax-m2.1', '—', '—', '—', '—', '—', 'Not in live catalog', '—']);
  assert.equal(cells('z-ai/glm-4.6')[6], 'No pricing');
  assert.equal(p.$('tr[data-model="qwen/qwen3-30b-a3b"] .cv-pill.is-bad').textContent, 'No tools'); assert.equal(p.$('tr[data-model="deepseek/deepseek-chat-v3.1"] .cv-pill.is-warn').textContent, 'Stale'); assert.equal(p.$('tr[data-model="openai/gpt-6-luna"] .cv-pill.is-good').textContent, 'Available');
  assert.equal(p.$('tr[data-model="openai/gpt-6-luna"] .admin-model-tag').className, 'cv-pill admin-model-tag is-deep');
  assert.equal(p.$('tr[data-model="openai/gpt-6-luna"] button.admin-copy').dataset.copy, 'openai/gpt-6-luna');
  assert.equal(p.$('tr[data-model="openai/gpt-6-luna"] time').title.length > 0, true);
  // Availability chips: counts, and the Unavailable chip keeps only the models creators cannot launch.
  const chips = p.$$('#admin-agents-models [data-chip]');
  assert.deepEqual(texts(chips), ['All7', 'Available3', 'Unavailable4']);
  chips[2].onclick(); assert.deepEqual(p.$$('tr[data-model]').map(row => row.dataset.model), ['qwen/qwen3-30b-a3b', 'deepseek/deepseek-chat-v3.1', 'minimax/minimax-m2.1', 'z-ai/glm-4.6']);
  assert.deepEqual(groupText().slice(0, 1), ['Qwen · 0 of 1 model available']);
  p.$$('#admin-agents-models [data-chip]')[1].onclick(); assert.deepEqual(p.$$('tr[data-model]').map(row => row.dataset.model), ['openai/gpt-6-luna', 'openai/gpt-5-nano', 'anthropic/claude-haiku-4.5']);
  assert.equal(p.ui.element.dataset.adminSummary, '0 agents · 0 paused · 3 of 7 models available');
  p.ui.destroy();
});

test('a catalog that was never read, or whose last read failed, says so instead of blaming the models', async () => {
  const unread = MODELS.map(item => ({ ...item, available: false, unavailableReason: 'no live catalog yet', pricedAt: null, stale: true, unavailable: true }));
  const p = page({ respond: path => path === '/api/admin/agents' ? snapshot({ registry: registry({ refreshedAt: null, available: 0, models: unread, lastRefreshError: 'The model catalog returned HTTP 503.', error: 'The model catalog returned HTTP 503.' }) }) : undefined }); await p.ui.load();
  assert.equal(p.$('#admin-agents-models h3').textContent, 'Models (0 of 7 available)');
  assert.match(p.get('admin-agents-models-note').textContent, /^The live catalog has not been read yet · prices count as stale after 24 hours.*· last refresh error: The model catalog returned HTTP 503\.$/);
  assert.equal(p.get('admin-agents-models-note').classList.contains('admin-gas-warning'), true);
  assert.deepEqual(new Set(texts(p.$$('tr[data-model] td:nth-child(7)'))), new Set(['No catalog yet']));
  assert.equal(p.$('tr[data-model] td:nth-child(7) .cv-pill').className, 'cv-pill is-warn');
  p.ui.destroy();
});

test('Refresh catalog is the provider health check (a GET, no identity prompt) and shows the catalog it returns', async () => {
  const fresh = { ...health, catalog: registry({ refreshedAt: NOW - MIN, available: 1, total: 2, models: [MODELS[0], MODELS[3]] }) };
  const p = page({ respond: path => path === '/api/admin/agents' ? snapshot({ registry: registry() }) : path === '/api/admin/agents/health' ? fresh : undefined }); await p.ui.load();
  assert.equal(p.$$('tr[data-model]').length, MODELS.length);
  await p.get('admin-agents-models-refresh').onclick(); await settle();
  assert.equal(p.auths.length, 0);
  assert.deepEqual(p.calls.filter(call => call.path === '/api/admin/agents/health'), [{ path: '/api/admin/agents/health', body: undefined }]);
  assert.match(p.get('admin-agents-health').textContent, /Model catalog: 1 of 2 models available, refreshed /);
  assert.deepEqual(p.$$('tr[data-model]').map(row => row.dataset.model), ['openai/gpt-6-luna', 'qwen/qwen3-30b-a3b']);
  assert.match(p.get('admin-agents-models-note').textContent, /^Catalog read 1 minute ago/);
  assert.equal(p.messages.at(-1).text, 'Catalog refresh completed.');
  // No second snapshot read: the health result carries the server's refreshed registry already.
  assert.equal(p.calls.filter(call => call.path === '/api/admin/agents').length, 1);
  p.ui.destroy();
});

test('agent rows carry the objective chip and the program pill, and the objective filter narrows the list', async () => {
  const p = page({ respond: path => path === '/api/admin/agents' ? snapshot({ registry: registry(), agents: AGENTS }) : undefined }); await p.ui.load();
  assert.equal(p.$('#admin-agents-cards').children.length, AGENTS.length);
  assert.equal(p.$('.admin-list-head h3').textContent, 'Models (3 of 7 available)'); assert.equal(p.$$('.admin-list-head h3')[1].textContent, 'Agents (7)');
  const summaryPills = id => texts(p.row(id).querySelectorAll('summary .cv-pill'));
  assert.deepEqual(summaryPills('a-scout'), ['Ready', 'Long game', 'Program active']);
  assert.deepEqual(summaryPills('a-owl'), ['Running', 'Research first', 'Program waiting']);
  assert.deepEqual(summaryPills('a-tide'), ['Paused by creator', 'Metronome', 'Program off', 'Creator pause']);
  assert.deepEqual(summaryPills('a-mile'), ['Ready', 'Milestones', 'Program finished']);
  assert.deepEqual(summaryPills('a-custom'), ['Ready', 'Custom']);
  assert.deepEqual(summaryPills('a-legacy'), ['Ready']);
  assert.equal(p.row('a-scout').querySelector('.admin-agent-objective').textContent, 'Long game');
  assert.equal(p.row('a-scout').querySelector('.admin-agent-program-pill').className, 'cv-pill is-good admin-agent-program-pill');
  assert.equal(p.row('a-owl').querySelector('.admin-agent-program-pill').className, 'cv-pill is-warn admin-agent-program-pill');
  assert.equal(p.row('a-owl').querySelector('.admin-agent-program-pill').title, 'Reading for the first 7 days (until Oct 8, 2026); no treasury action before then.');
  assert.equal(p.row('a-tide').querySelector('.admin-agent-program-pill').className, 'cv-pill is-bad admin-agent-program-pill');
  assert.equal(p.row('a-mile').querySelector('.admin-agent-program-pill').className, 'cv-pill admin-agent-program-pill');
  assert.equal(p.row('a-custom').querySelector('.admin-agent-program-pill'), null);
  // The summary line: venue, launch state, the model's catalog name and the personality; the time column prefers the next run.
  assert.equal(p.row('a-scout').querySelector('summary small').textContent, 'raydium · launch live · GPT-6 Luna · Analyst');
  assert.equal(p.row('a-owl').querySelector('summary small').textContent, 'raydium · launch live · Claude Haiku 4.5 · Scholar');
  assert.equal(p.row('a-scout').querySelector('summary time').textContent, 'next run in 4 minutes');
  assert.equal(p.row('a-legacy').querySelector('summary time').textContent, 'active 3 hours ago');
  assert.equal(p.row('a-scout').querySelector('summary button.admin-copy').dataset.copy, MINT);
  // The objective filter lists every objective present with its count and narrows the rows; the search also matches objective names.
  const select = p.get('admin-agents-objective');
  assert.deepEqual(texts(select.options), ['Every objective (7)', 'Custom (3)', 'Long game (1)', 'Metronome (1)', 'Milestones (1)', 'Research first (1)']);
  assert.deepEqual([...select.options].map(option => option.value), ['', 'custom', 'long_game', 'metronome', 'milestones', 'research_first']);
  select.value = 'custom'; select.onchange();
  assert.deepEqual([...p.$('#admin-agents-cards').children].map(node => node.dataset.agentRow), ['a-custom', 'a-legacy', 'a-hidden']);
  assert.equal(p.$$('.admin-list-head h3')[1].textContent, 'Agents (7)');
  select.value = ''; select.onchange(); assert.equal(p.$('#admin-agents-cards').children.length, AGENTS.length);
  const chips = [...p.get('admin-agents-search').closest('.admin-filter-bar').querySelectorAll('[data-chip]')]; assert.deepEqual(texts(chips), ['All7', 'Paused1', 'Hidden1']);
  chips[1].onclick(); assert.deepEqual([...p.$('#admin-agents-cards').children].map(node => node.dataset.agentRow), ['a-tide']);
  // Moderation (v71.37): the Hidden chip lists the agents hidden from the public page; the row says why, by whom and when, and offers Unhide.
  chips[2].onclick(); assert.deepEqual([...p.$('#admin-agents-cards').children].map(node => node.dataset.agentRow), ['a-hidden']);
  assert.match(p.row('a-hidden').textContent, /Hidden from the agents page: Impersonates a listed project · by mira · 2 hours ago\. The coin still trades/);
  assert.equal([...p.row('a-hidden').querySelectorAll('button')].some(button => button.textContent === 'Unhide'), true);
  chips[0].onclick(); assert.equal([...p.row('a-scout').querySelectorAll('button')].some(button => button.textContent === 'Hide (moderation)'), true);
  p.get('admin-agents-search').value = 'metronome'; const enter = new p.document.defaultView.Event('keydown', { bubbles: true, cancelable: true }); Object.defineProperty(enter, 'key', { value: 'Enter' }); p.get('admin-agents-search').dispatchEvent(enter);
  assert.deepEqual([...p.$('#admin-agents-cards').children].map(node => node.dataset.agentRow), ['a-tide']);
  assert.equal(p.ui.element.dataset.adminSummary, '7 agents · 1 paused · 1 program active · 3 of 7 models available');
  p.ui.destroy();
});

test('the opened row shows the program rule, last note, next due, action count and where the latest treasury actions came from', async () => {
  const p = page({ respond: path => path === '/api/admin/agents' ? snapshot({ registry: registry(), agents: AGENTS }) : undefined }); await p.ui.load();
  const program = id => p.row(id).querySelector('.admin-agent-program');
  const scout = program('a-scout');
  assert.equal(scout.querySelector('h4').textContent, 'Objective · Long game');
  assert.equal(scout.querySelector('.admin-agent-program-state').textContent, 'Active ' + LONG_GAME_RULE);
  assert.deepEqual(texts(scout.querySelectorAll('.admin-stat')).map(text => text.replace(/\s+/g, ' ')), ['Program kindSpends treasury', 'Next duein 6 days', 'Last evaluated26 minutes ago', 'Program actions3 actions, last 1 hour ago']);
  assert.equal(scout.querySelector('.admin-stat time').title.length > 0, true);
  assert.match(scout.textContent, /Last note: 7-day volume is 12% above the 30-day average; proposed a 0\.064 SOL buyback\./);
  assert.match(scout.textContent, /Latest treasury actions: 2 of 3 came from the program, 1 from the model\./);
  assert.deepEqual(texts(scout.querySelectorAll('.admin-agent-actions li')).map(text => text.replace(/\s+/g, ' ')), ['ProgramBuyback & burn · Completed · 0.0640 SOL1 hour ago', 'ModelHolder reward · Completed · 0.0650 SOL2 days ago', 'ProgramBuyback & burn · Rejected3 days ago']);
  assert.equal(scout.querySelector('.admin-agent-actions .cv-pill').className, 'cv-pill is-accent');
  const owl = program('a-owl');
  assert.match(owl.querySelector('.help').textContent, /^Reading for the first 7 days/); assert.match(owl.textContent, /Last note: none yet/); assert.match(owl.textContent, /No treasury actions yet\./);
  assert.match(program('a-tide').textContent, /Needs buy-and-burn, which this agent launched without\./); assert.doesNotMatch(program('a-tide').textContent, /Latest treasury actions/);
  const mile = program('a-mile'); assert.match(mile.textContent, /Every milestone was reached\./); assert.match(mile.textContent, /Milestones hit2×, 5×, 10×/);
  assert.match(program('a-custom').textContent, /runs no platform program/);
  assert.equal(program('a-legacy'), null, 'a row from before objectives existed has no program block');
  // Every control stays on the opened card.
  for (const id of ['a-scout', 'a-legacy']) { const labels = texts(p.row(id).querySelectorAll('.admin-gotchi-flags button')); assert.deepEqual(labels, ['Platform pause', 'Hide (moderation)']); }
  assert.equal(p.row('a-scout').querySelector('.admin-gotchi-card').dataset.agent, 'a-scout');
  // Opened rows stay open across a refresh.
  p.row('a-scout').open = true; await settle(); await p.ui.load(true); assert.equal(p.row('a-scout').open, true); assert.equal(p.row('a-owl').open, false);
  p.ui.destroy();
});

test('programStatus maps a program view to Active, Waiting, Finished or Off', () => {
  assert.equal(programStatus(null), null); assert.equal(programStatus(undefined), null); assert.equal(programStatus('x'), null);
  assert.deepEqual(programStatus({ active: true, reason: '' }), { label: 'Active', tone: 'good', reason: '' });
  assert.deepEqual(programStatus({ active: false, finished: true, finishedReason: 'The coin graduated.' }), { label: 'Finished', tone: '', reason: 'The coin graduated.' });
  assert.deepEqual(programStatus({ active: false, reason: 'Waiting for the coin launch to go live.' }), { label: 'Waiting', tone: 'warn', reason: 'Waiting for the coin launch to go live.' });
  assert.deepEqual(programStatus({ active: false, reason: 'Reading for the first 7 days (until Oct 8, 2026); no treasury action before then.' }).label, 'Waiting');
  assert.deepEqual(programStatus({ active: false, reason: 'Paused by the platform.' }), { label: 'Off', tone: 'bad', reason: 'Paused by the platform.' });
  assert.deepEqual(programStatus({ active: false, reason: 'Treasury actions are closed on this platform right now.' }).label, 'Off');
  assert.deepEqual(programStatus({}).label, 'Off');
});
