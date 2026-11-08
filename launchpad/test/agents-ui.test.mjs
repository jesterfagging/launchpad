import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { createAgentsPage } from '../public/agents.js';

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const ok = value => ({ ok: true, status: 200, json: async () => value });
const agent = index => ({ id: 'agent-' + index, mint: 'Mint' + String(index).padStart(3, '0'), name: 'Agent ' + index, symbol: 'AG' + index, state: 'ready', stateLabel: 'Ready', href: '/coin?mint=Mint' + String(index).padStart(3, '0') + '#agent', mission: 'Research and post updates.', model: 'Model', capabilities: ['research'], treasurySol: '1', operatingBackedUsd: '$1.00', feesSol: '0', feeReceipts: 0, route: 'raydium', lastActivity: null });

async function agentsPage(t, { list, session = { authenticated: true, token: 'csrf', account: { id: 'account', username: 'mira_builds', role: 'admin' } } } = {}) {
  const { document } = parseHTML(await readFile(new URL('../public/agents.html', import.meta.url), 'utf8'));
  const calls = [], shells = []; let timer = null;
  const fetcher = async path => {
    calls.push(path); const url = new URL(path, 'https://launchpad.invalid');
    if (path === '/api/session') return ok(session);
    if (url.pathname === '/api/launchpad/agents/catalog') return ok({ intakeOpen: true, models: [{ name: 'Model' }], rules: [], funding: {} });
    if (url.pathname === '/api/launchpad/agents') return list(url);
    throw Error('Unexpected request ' + path);
  };
  const app = createAgentsPage({ document, window: { setTimeout, clearTimeout, matchMedia: () => ({ matches: true }) }, fetcher, clock: () => 1700000000000, setTimer: fn => { timer = fn; return 1; }, clearTimer: () => {}, shell: value => shells.push(value) });
  t.after(() => app.destroy()); await app.ready; await flush();
  return { document, app, calls, shells, get: id => document.getElementById(id), cards: () => document.querySelectorAll('#agents-cards .agents-card').length, refresh: async () => { timer(); await flush(); } };
}
const paged = (rows, limits = []) => url => { const limit = Number(url.searchParams.get('limit')), start = Number(url.searchParams.get('cursor') || 0); limits.push(limit); return ok({ agents: rows.slice(start, start + limit), nextCursor: start + limit < rows.length ? String(start + limit) : null, intakeOpen: true, at: 1700000000000 }); };

test('a direct load reads the session so the header shows the signed-in account', async t => {
  const ui = await agentsPage(t, { list: paged([agent(1)]) });
  assert.equal(ui.calls.filter(path => path === '/api/session').length, 1);
  assert.equal(ui.shells.at(-1).session.account.username, 'mira_builds'); assert.equal(ui.shells.at(-1).page, 'agents');
});

test('the auto-refresh keeps every page loaded with Load more', async t => {
  const limits = [], ui = await agentsPage(t, { list: paged(Array.from({ length: 27 }, (_, index) => agent(index)), limits) });
  assert.equal(ui.cards(), 24); assert.equal(ui.get('agents-more').hidden, false);
  await ui.get('agents-more').onclick(); await flush(); assert.equal(ui.cards(), 27); assert.equal(ui.get('agents-more').hidden, true);
  await ui.refresh(); assert.equal(ui.cards(), 27, 'a refresh re-reads the pages already shown'); assert.equal(ui.get('agents-more').hidden, true);
  assert.deepEqual(limits, [24, 24, 27]);
});

test('a slow agent list shows readable text instead of a browser abort error', async t => {
  const ui = await agentsPage(t, { list: () => { throw new DOMException('signal is aborted without reason', 'AbortError'); } });
  assert.match(ui.get('agents-status').textContent, /taking longer than usual/); assert.doesNotMatch(ui.get('agents-cards').textContent + ui.get('agents-status').textContent, /signal is aborted/);
});

// ---- v71.27: objectives on the cards and the objective filter ----------------------------------------------------
test('cards carry the objective, program and personality chips, and the objective filter narrows by objective or group', async t => {
  const rows = [{ ...agent(1), objective: 'metronome', objectiveName: 'Metronome', personalityPreset: 'nightowl' }, { ...agent(2), objective: 'patience', objectiveName: 'Patience', personalityPreset: 'diplomat' }, { ...agent(3), objective: 'survivor', objectiveName: 'Survivor', personalityPreset: 'analyst' }, { ...agent(4), objective: 'metronome', objectiveName: 'Metronome', state: 'running', stateLabel: 'Running', personalityPreset: 'coach' }, { ...agent(5) }];
  const ui = await agentsPage(t, { list: paged(rows) });
  const card = ui.document.querySelector('#agents-cards .agents-card');
  assert.deepEqual([...card.querySelectorAll('.agents-card-chips .agent-pill')].map(chip => chip.textContent), ['Metronome', 'Program', 'Night owl']);
  assert.equal(card.querySelector('.agent-pill-objective').dataset.objective, 'metronome'); assert.match(card.querySelector('.agent-pill-program').title, /every 6, 12 or 24 hours/);
  const second = ui.document.querySelectorAll('#agents-cards .agents-card')[1];
  assert.deepEqual([...second.querySelectorAll('.agents-card-chips .agent-pill')].map(chip => chip.textContent), ['Patience', 'Limiter', 'Diplomat']);
  const last = ui.document.querySelectorAll('#agents-cards .agents-card')[4];
  assert.deepEqual([...last.querySelectorAll('.agents-card-chips .agent-pill')].map(chip => chip.textContent), ['Custom'], 'an agent from before v71.27 reads as Custom');
  const select = ui.get('agents-objective'); assert.equal(ui.get('agents-objective-wrap').hidden, false);
  assert.deepEqual([...select.querySelectorAll('option')].map(option => [option.value, option.textContent]), [['all', 'All objectives · 5'], ['group:treasury', 'All treasury programs · 3'], ['metronome', 'Metronome · 2'], ['patience', 'Patience · 1'], ['group:voice', 'All voice and community · 1'], ['survivor', 'Survivor · 1'], ['group:own', 'All your own · 1'], ['custom', 'Custom · 1']]);
  select.value = 'metronome'; select.onchange(); assert.equal(ui.cards(), 2);
  select.value = 'group:treasury'; select.onchange(); assert.equal(ui.cards(), 3);
  // The state chips combine with the objective filter, and an empty combination says so.
  ui.document.querySelector('[data-agent-filter=running]').onclick(); assert.equal(ui.cards(), 1);
  select.value = 'survivor'; select.onchange(); assert.equal(ui.cards(), 0); assert.match(ui.get('agents-cards').textContent, /No Survivor agent is running right now/);
  ui.document.querySelector('[data-agent-filter=all]').onclick(); assert.equal(ui.cards(), 1);
  // A refresh keeps the chosen filter, and a filter whose objective disappeared falls back to All.
  await ui.refresh(); assert.equal(select.value, 'survivor'); assert.equal(ui.cards(), 1);
});

test('the intro counts the models offered across providers and ignores unavailable ones', async t => {
  const models = [{ id: 'openai/gpt-6-luna', name: 'GPT-6 Luna', providerName: 'OpenAI', available: true }, { id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5', providerName: 'Anthropic', available: true }, { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', providerName: 'Google', available: true }, { id: 'minimax/minimax-m2.1', name: 'minimax/minimax-m2.1', providerName: 'MiniMax', available: false, unavailable: true }];
  const { document } = parseHTML(await readFile(new URL('../public/agents.html', import.meta.url), 'utf8'));
  const fetcher = async path => { const url = new URL(path, 'https://launchpad.invalid'); if (path === '/api/session') return ok({ authenticated: false }); if (url.pathname === '/api/launchpad/agents/catalog') return ok({ intakeOpen: true, models, rules: [], funding: {} }); if (url.pathname === '/api/launchpad/agents') return ok({ agents: [agent(1)], nextCursor: null }); throw Error('Unexpected request ' + path); };
  const app = createAgentsPage({ document, window: { setTimeout, clearTimeout, matchMedia: () => ({ matches: true }) }, fetcher, clock: () => 1700000000000, setTimer: () => 1, clearTimer: () => {}, shell: () => {} });
  t.after(() => app.destroy()); await app.ready; await flush();
  const facts = [...document.querySelectorAll('#agents-intro-facts dt, #agents-intro-facts dd, #agents-intro-facts span, #agents-intro-facts strong')].map(node => node.textContent);
  assert.ok(facts.some(text => /3 models from 3 providers/.test(text)), facts.join(' | '));
});

// ---- v71.37 moderation: an admin sees hidden agents on the page, dimmed with the reason, and a link into the admin panel -------
test('an admin sees hidden agents dimmed with the reason and a link to moderate them in the admin panel; the public list carries no such thing', async t => {
  const rows = [agent(1), { ...agent(2), moderation: { hidden: true, reason: 'Impersonates a listed project.', at: 1700000000000 - 7200000, by: 'mira_builds' } }];
  const ui = await agentsPage(t, { list: url => ({ ...paged(rows)(url), json: async () => ({ ...(await paged(rows)(url).json()), moderator: true }) }) });
  const cards = [...ui.document.querySelectorAll('#agents-cards .agents-card')]; assert.equal(cards.length, 2);
  assert.equal(cards[0].classList.contains('is-hidden'), false); assert.equal(cards[1].classList.contains('is-hidden'), true);
  assert.equal(cards[1].querySelector('.agents-card-moderation').textContent, 'Hidden from this page · Impersonates a listed project. · by mira_builds · 2 h ago');
  const links = cards.map(card => card.querySelector('.agents-moderate'));
  assert.deepEqual(links.map(link => [link.textContent, link.dataset.moderate, link.getAttribute('href')]), [['Hide in admin →', 'hide', '/admin#tokens/agents?agents.q=Mint001'], ['Unhide in admin →', 'unhide', '/admin#tokens/agents?agents.q=Mint002']]);
  assert.match(ui.get('agents-status').textContent, /2 agents shown \(1 hidden from the public, shown to you as an admin\)/);
  // The public list: no moderator flag, no links, no note.
  const open = await agentsPage(t, { list: paged([agent(1)]), session: { authenticated: false } });
  assert.equal(open.document.querySelector('.agents-moderate'), null); assert.equal(open.document.querySelector('.agents-card-moderation'), null); assert.doesNotMatch(open.get('agents-status').textContent, /hidden from the public/);
});
