// Coin page AI Agent tab (v71.27): the objective and its program on the public view, program chips on activity, and
// the creator's revise form limited to objectives the launched capabilities allow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createAgentView } from '../public/agent-view.mjs';
import { AGENT_OBJECTIVES, objectiveById } from '../public/agent-catalog.mjs';

const MINT = '8db6sLzSneci4TbNPiwyNZrVYh7T879SxRRsHpS2PgiE', NOW = 1_760_000_000_000;
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const ok = value => ({ ok: true, status: 200, json: async () => value });
const program = (over = {}) => ({ rule: objectiveById('metronome').program.rule, kind: 'program', spends: true, active: true, reason: '', lastRunAt: NOW - 3_600_000, nextDueAt: NOW + 5 * 3_600_000, lastNote: 'Proposed 0.05 SOL: Metronome program: scheduled 2% buyback (tick 4).', actions: 4, lastActionAt: NOW - 3_600_000, finished: false, finishedReason: '', milestonesHit: [], launchMarketCapUsd: null, ...over });
const detail = (over = {}) => ({ id: 'agent-1', mint: MINT, name: 'Scout Signal', symbol: 'SCOUT', image: null, route: 'raydium', href: '/coin?mint=' + MINT + '#agent', state: 'ready', stateLabel: 'Ready', stateReason: '', mission: 'Keep a steady rhythm.', model: 'openai/gpt-6-luna', capabilities: ['research', 'browser', 'buyback'], personalityPreset: 'nightowl', personality: '', createdAt: NOW - 86_400_000, activatedAt: NOW - 80_000_000, revision: 2, nextRunAt: NOW + 240_000, objective: 'metronome', objectiveName: 'Metronome', objectiveSummary: objectiveById('metronome').summary, objectiveSettings: { sharePct: 2.5, intervalHours: 6 }, program: program(), blockers: [], launchState: 'live', domains: [], approvedDomains: [], wallet: '7rvRFpzP5W18yZcNpPNqtWgPTxLaFrnutz5QPxXpyupc', policyHash: 'a'.repeat(64), policyVersion: 'agent-policy-v2', custody: 'Operator-managed wallet.', creatorPaused: false, adminPaused: false, integrityPaused: false, pauseReason: '', balances: { sol: { treasuryAvailable: '1.5', treasuryReserved: '0', rewardFrozen: '0', operatingUnsettled: '0', gasReserve: '0.01' }, usd: { backed: '$2.00', reserved: '$0.00', spent: '$0.10' }, usdc: { settled: '0' } }, fees: { total: '0.5', count: 3 }, lastRun: null, todayBudget: { spent: '$0.10', budget: '$1.00' }, policy: { version: 'agent-policy-v2' }, funding: 'Raydium agent launches keep the standard 0.50% creator trading fee.', ...over });
const events = [{ id: 7, kind: 'action', title: 'Program buyback proposed: 0.0500 SOL', body: 'Metronome program: scheduled 2% buyback (tick 4).', at: NOW - 3_600_000, data: { origin: 'program', objective: 'metronome', actionId: 7 } }, { id: 6, kind: 'update', title: 'Tick 3 receipt', body: 'Bought and burned.', at: NOW - 7_200_000, data: {} }];

async function view(t, { agent = detail(), session = null, me = null, onPost = null } = {}) {
  const { document, window } = parseHTML('<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  const posts = [], calls = [];
  const fetcher = async (path, options = {}) => {
    calls.push(path); const url = new URL(path, 'https://launchpad.invalid');
    if (options.method === 'POST') { const body = JSON.parse(options.body); posts.push({ path: url.pathname, body }); return ok(onPost ? onPost(url.pathname, body) : { ...me.agents[0], ...body, revision: 3 }); }
    if (url.pathname === '/api/launchpad/agents/agent') return ok(agent);
    if (url.pathname === '/api/launchpad/agents/me') return ok(me || { agents: [] });
    if (url.pathname === '/api/launchpad/agents/activity') return ok({ events, nextBefore: null });
    if (url.pathname === '/api/launchpad/agents/treasury') return ok({ actions: [{ id: 7, kind: 'buyback_burn', state: 'finalized', stateLabel: 'Completed', origin: 'program', requested: 0.05, principalSol: '0.05', reservedSol: '0.05', spentSol: '0.05', reason: 'Metronome program: scheduled 2% buyback (tick 4).', legs: [], createdAt: NOW - 3_600_000, finalizedAt: NOW - 3_500_000 }, { id: 5, kind: 'buyback_burn', state: 'rejected', stateLabel: 'Rejected', origin: 'model', requested: 0.5, principalSol: '0', reservedSol: '0', spentSol: '0', reason: 'Too much.', legs: [], createdAt: NOW - 90_000_000, finalizedAt: null }], balances: agent.balances, caps: {} });
    return { ok: false, status: 404, json: async () => ({ error: 'Not found: ' + path }) };
  };
  const root = document.getElementById('root');
  const app = createAgentView({ document, window: Object.assign(window, { matchMedia: () => ({ matches: true }), setTimeout, clearTimeout }), root, mint: MINT, fetcher, clock: () => NOW, setTimer: () => 1, clearTimer: () => {} });
  t.after(() => app.destroy());
  if (session) app.setSession(session);
  await app.refresh(); await flush();
  return { document, root, app, posts, calls, $: selector => root.querySelector(selector), $$: selector => [...root.querySelectorAll(selector)], text: selector => root.querySelector(selector)?.textContent || '' };
}
const creator = { authenticated: true, token: 'csrf', account: { id: 'acct', username: 'mira_builds' } };
const mine = (over = {}) => ({ agents: [{ id: 'agent-1', mint: MINT, mission: 'Keep a steady rhythm.', personalityPreset: 'nightowl', personality: '', domains: [], model: 'openai/gpt-6-luna', creatorPaused: false, revision: 2, state: 'ready', models: ['openai/gpt-6-luna', 'anthropic/claude-haiku-4.5'], approvedDomains: [], objective: 'metronome', objectiveSettings: { sharePct: 2.5, intervalHours: 6 }, capabilities: ['research', 'browser', 'buyback'], ...over }] });

test('the public view shows the objective, the personality voice and an active program with its schedule', async t => {
  const ui = await view(t);
  assert.equal(ui.text('[data-agent-objective]'), 'Metronome'); assert.match(ui.text('[data-agent-voice]'), /Night owl · Terse, observant/);
  assert.match(ui.text('.agent-identity, .agent-panel'), /Objective/);
  const card = ui.$('.agent-program'); assert(card, 'program card'); assert.equal(card.dataset.status, 'active'); assert.equal(card.dataset.kind, 'program');
  assert.match(card.textContent, /Buy back the share you set every 6, 12 or 24 hours/); assert.match(card.textContent, /Spends treasury/);
  assert.match(card.textContent, /Next due\s*in 5\.0 h/); assert.match(card.textContent, /Last action\s*1 h ago|Last action\s*60 min ago/); assert.match(card.textContent, /4 proposed/);
  assert.match(card.textContent, /The platform runs this rule on its own schedule\. The model cannot change it/);
  assert.equal(ui.$('.agent-program-pill').textContent.trim(), 'Active');
});

test('waiting, finished and off programs read as such, a limiter is labelled, and milestones show what was hit', async t => {
  const waiting = await view(t, { agent: detail({ program: program({ lastNote: 'Waiting: the next tick is due in 2 h.', nextDueAt: NOW + 7_200_000 }) }) });
  assert.equal(waiting.$('.agent-program').dataset.status, 'waiting'); assert.match(waiting.text('.agent-program-note'), /Waiting: the next tick/);
  const finished = await view(t, { agent: detail({ objective: 'milestones', objectiveName: 'Milestones', objectiveSummary: objectiveById('milestones').summary, objectiveSettings: {}, program: program({ rule: objectiveById('milestones').program.rule, active: false, finished: true, finishedReason: 'All milestones reached.', milestonesHit: [2, 5, 10], launchMarketCapUsd: 20000 }) }) });
  assert.equal(finished.$('.agent-program').dataset.status, 'finished'); assert.equal(finished.$('.agent-program-pill').textContent.trim(), 'Finished');
  assert.deepEqual(finished.$$('.agent-milestone').map(chip => [chip.textContent, chip.dataset.hit]), [['2× reached', 'true'], ['5× reached', 'true'], ['10× reached', 'true']]); assert.match(finished.text('.agent-program'), /\$20,000/);
  const off = await view(t, { agent: detail({ program: program({ active: false, reason: 'Needs buy-and-burn, which this agent launched without.' }) }) });
  assert.equal(off.$('.agent-program').dataset.status, 'off'); assert.match(off.text('.agent-program-note'), /launched without/);
  const limiter = await view(t, { agent: detail({ objective: 'patience', objectiveName: 'Patience', objectiveSummary: objectiveById('patience').summary, program: program({ rule: objectiveById('patience').program.rule, kind: 'limiter', spends: false }) }) });
  assert.equal(limiter.$('.agent-program').dataset.kind, 'limiter'); assert.match(limiter.text('.agent-program h3'), /Program limiter/); assert.match(limiter.text('.agent-program-foot'), /this limiter decides how often/);
  const none = await view(t, { agent: detail({ objective: 'custom', objectiveName: 'Custom', objectiveSummary: '', program: null }) });
  assert.equal(none.$('.agent-program'), null, 'no program card without a program');
});

test('activity and treasury rows from the program carry a Program chip', async t => {
  const ui = await view(t);
  ui.app.select('activity'); await flush();
  const rows = ui.$$('.agent-event');
  assert.equal(rows.length, 2); assert.equal(rows[0].querySelector('.agent-pill-program')?.textContent, 'Program'); assert.match(rows[0].querySelector('.agent-pill-program').title, /Metronome program/); assert.equal(rows[1].querySelector('.agent-pill-program'), null);
  ui.app.select('treasury'); await flush();
  const actions = ui.$$('.agent-action');
  assert.equal(actions.length, 2); assert.equal(actions[0].querySelector('.agent-pill-program')?.textContent, 'Program'); assert.equal(actions[1].querySelector('.agent-pill-program'), null);
});

test('the creator can change the objective only within the launched capabilities and saves its settings', async t => {
  const ui = await view(t, { session: creator, me: mine() });
  const select = ui.$('select[name=agentObjective]'); assert(select, 'objective select in the creator controls');
  assert.equal(select.value, 'metronome');
  const options = [...select.querySelectorAll('option')]; assert.equal(options.length, AGENT_OBJECTIVES.length);
  const byId = Object.fromEntries(options.map(option => [option.value, option]));
  assert.equal(byId.long_game.disabled, false, 'buyback programs are allowed'); assert.equal(byId.holders_first.disabled, true, 'rewards were not chosen at launch'); assert.match(byId.holders_first.textContent, /needs holder rewards, not enabled at launch/);
  assert.equal(byId.milestones.disabled, false, 'anyOf: buyback satisfies it'); assert.equal(byId.survivor.disabled, false); assert.equal(byId.custom.disabled, false);
  assert.deepEqual([...select.querySelectorAll('optgroup')].map(group => group.label), ['Treasury programs', 'Voice and community', 'Your own']);
  const settings = ui.$('[data-agent-objective-settings]'); assert.equal(settings.hidden, false);
  assert.equal(settings.querySelector('[data-setting=sharePct]').value, '2.5'); assert.equal(settings.querySelector('[data-setting=intervalHours]').value, '6');
  // A bad number is refused before anything is sent.
  settings.querySelector('[data-setting=sharePct]').value = '7';
  const save = [...ui.$$('button')].find(button => button.textContent === 'Save revision'); await save.onclick(); await flush();
  assert.equal(ui.posts.length, 0); assert.match(ui.text('[data-agent-message]'), /Treasury share per tick must be between 1 and 3/);
  // Switching to Dip buyer rebuilds the settings with its defaults; the save sends objective and settings.
  select.value = 'dip_buyer'; select.onchange(); await flush();
  assert.match(ui.text('.agent-objective-summary'), /Dip buyer: Buys back when the price drops hard/); assert.match(ui.text('.agent-objective-summary'), /A new objective starts its program schedule over/);
  assert.equal(settings.querySelector('[data-setting=dropPct]').value, '15'); settings.querySelector('[data-setting=dropPct]').value = '20';
  await save.onclick(); await flush();
  assert.equal(ui.posts.length, 1); assert.equal(ui.posts[0].path, '/api/launchpad/agents/revise');
  assert.equal(ui.posts[0].body.objective, 'dip_buyer'); assert.deepEqual(ui.posts[0].body.objectiveSettings, { dropPct: 20 }); assert.equal(ui.posts[0].body.mint, MINT);
  assert.match(ui.text('[data-agent-message]'), /Revision r3 saved/);
});

// ---- v71.37 moderation: the note a creator or admin sees on a hidden agent; the public's 404 ends the polling -------------
test('a hidden agent shows the creator why it is off the agents page, and the public 404 stops the 20 s polling', async t => {
  const ui = await view(t, { agent: detail({ moderation: { hidden: true, reason: 'Impersonates a listed project.', at: NOW - 3_600_000 } }), session: creator, me: mine() });
  assert.equal(ui.text('.agent-moderation-note'), 'Hidden from the agents page by moderation · Impersonates a listed project. The coin still trades; only the agent listing is hidden.');
  assert.equal(ui.$('.agent-moderation-note').previousElementSibling, ui.$('[data-agent-title]'));
  // An admin's view carries who hid it; an unhidden refresh removes the note.
  const admin = await view(t, { agent: detail({ moderation: { hidden: true, reason: 'Impersonates a listed project.', at: NOW - 3_600_000, by: 'mira' } }) });
  assert.match(admin.text('.agent-moderation-note'), /Impersonates a listed project · by mira\. The coin still trades/);
  const shown = await view(t); assert.equal(shown.$('.agent-moderation-note'), null);
  // The public: a 404 reads as "not listed" once and the timer is cleared instead of asking again every 20 s.
  const { document, window } = parseHTML('<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  let cleared = 0, asks = 0;
  const app = createAgentView({ document, window: Object.assign(window, { matchMedia: () => ({ matches: true }), setTimeout, clearTimeout }), root: document.getElementById('root'), mint: MINT, fetcher: async () => { asks++; return { ok: false, status: 404, json: async () => ({ error: 'This coin has no listed agent.' }) }; }, clock: () => NOW, setTimer: () => 7, clearTimer: id => { if (id === 7) cleared++; } });
  t.after(() => app.destroy()); await app.refresh(); await flush();
  assert.equal(document.getElementById('root').textContent, 'This coin’s agent is not listed right now.'); assert.equal(cleared, 1); assert.equal(asks, 1);
});
