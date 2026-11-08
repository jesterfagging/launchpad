import { bootPage } from './navigation.mjs';
import { createWorkspaceShell } from './workspace-shell.js';
import { coinImage } from './coin-image.mjs';
import { AGENT_STATE_LABELS, AGENT_RULES, AGENT_FUNDING_SUMMARY, AGENT_POLICY_V1, AGENT_PERSONALITIES, AGENT_OBJECTIVE_GROUPS, objectiveById, formatUsdMicro } from './agent-catalog.mjs';
import { createInfluencerBadge, influencerAvatarUrl } from './influencer-ui.mjs';

const REFRESH_MS = 30000, PAGE = 24;
const number = value => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const sol = value => { const n = number(value); return n === null ? '—' : new Intl.NumberFormat(undefined, { maximumFractionDigits: n >= 100 ? 2 : n >= 1 ? 3 : 4 }).format(n) + ' SOL'; };
const ago = (value, now) => { const at = number(value); if (!(at > 0)) return '—'; const seconds = Math.max(0, Math.round((now - at) / 1000)); if (seconds < 60) return 'just now'; if (seconds < 3600) return Math.round(seconds / 60) + ' min ago'; if (seconds < 86400) return Math.round(seconds / 3600) + ' h ago'; return Math.round(seconds / 86400) + ' d ago'; };
const until = (value, now) => { const at = number(value); if (!(at > 0)) return ''; const seconds = Math.round((at - now) / 1000); if (seconds <= 0) return 'next run due'; if (seconds < 3600) return 'next run in ' + Math.max(1, Math.round(seconds / 60)) + ' min'; return 'next run in ' + (seconds / 3600).toFixed(1) + ' h'; };

// The intro's Models cell: how many models are offered and from how many providers (the launch page lists them with prices).
const modelAvailable = model => model.available === undefined ? !model.unavailable && !model.stale : model.available === true;
const modelProvider = model => model.providerName || String(model.provider || String(model.id || '').split('/')[0] || 'other');
function modelsSummary(models) {
  const rows = models.filter(model => model && model.id && modelAvailable(model)); if (!rows.length) return models.length ? 'none priced right now' : 'none configured';
  const providers = new Set(rows.map(modelProvider));
  return rows.length === 1 ? rows[0].name || rows[0].id : rows.length + ' models from ' + providers.size + ' provider' + (providers.size === 1 ? '' : 's');
}
// The auto-refresh rebuilds the cards, which drops keyboard focus to the page
// body. Remember the focused control and return to its rebuilt equivalent.
function focusSnapshot(document, root) { const node = document.activeElement; if (!node || node === document.body || !root.contains(node)) return null; return { node, tag: node.tagName, href: node.getAttribute('href'), text: node.textContent }; }
function restoreFocus(document, root, state) {
  if (!state) return; const active = document.activeElement; if (active && active !== document.body && active !== document.documentElement) return;
  const usable = node => node.isConnected && !node.disabled && !node.closest('[hidden]');
  let next = usable(state.node) ? state.node : null;
  if (!next) { const candidates = [...root.querySelectorAll(state.tag)].filter(usable); next = candidates.find(node => node.getAttribute('href') === state.href && node.textContent === state.text) || candidates.find(node => state.href ? node.getAttribute('href') === state.href : node.textContent === state.text) || null; }
  next?.focus?.({ preventScroll: true });
}

export function createAgentsPage({ document, window, fetcher = fetch, clock = Date.now, setTimer = setInterval, clearTimer = clearInterval, shell = createWorkspaceShell } = {}) {
  const main = document.querySelector('main'), $ = id => main.querySelector('[id="' + id + '"]');
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = String(text); if (cls) node.className = cls; return node; };
  const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  let disposed = false, timer = null, catalog = null, agents = [], nextCursor = null, loading = false, error = '', filter = 'all', objectiveFilter = 'all', peekHandle = null, peekVersion = 0;
  // Presentation only: the state chips narrow the directory to running, ready or resting agents.
  const RESTING = new Set(['sleeping_budget', 'paused_creator', 'paused_admin', 'paused_provider', 'paused_integrity', 'awaiting_funding', 'awaiting_settlement', 'provisioning']);
  const group = state => state === 'running' ? 'running' : state === 'ready' ? 'ready' : RESTING.has(state) ? 'resting' : 'other';
  let filterButtons = []; try { filterButtons = Array.from(main.querySelectorAll('[data-agent-filter]') || []); } catch { filterButtons = []; }
  for (const button of filterButtons) button.onclick = () => { filter = button.dataset.agentFilter; render(); };
  // The objective filter (v71.27): All, each group, and each objective present in the list, with counts.
  const objectiveSelect = $('agents-objective'); if (objectiveSelect) objectiveSelect.onchange = () => { objectiveFilter = objectiveSelect.value || 'all'; render(); };
  const objectiveOf = agent => objectiveById(agent.objective) || objectiveById('custom');
  const matchesObjective = agent => objectiveFilter === 'all' || (objectiveFilter.startsWith('group:') ? objectiveOf(agent).group === objectiveFilter.slice(6) : objectiveOf(agent).id === objectiveFilter);
  function renderObjectiveFilter() {
    const wrap = $('agents-objective-wrap'); if (!objectiveSelect || !wrap) return;
    wrap.hidden = !agents.length; objectiveSelect.replaceChildren();
    const counts = new Map(); for (const agent of agents) { const item = objectiveOf(agent); counts.set(item.id, (counts.get(item.id) || 0) + 1); }
    const values = ['all'], all = el('option', 'All objectives · ' + agents.length); all.value = 'all'; objectiveSelect.append(all);
    for (const group of AGENT_OBJECTIVE_GROUPS) {
      const inGroup = agents.filter(agent => objectiveOf(agent).group === group.id).length; if (!inGroup) continue;
      const optgroup = el('optgroup'); optgroup.label = group.name;
      const whole = el('option', 'All ' + group.name.toLowerCase() + ' · ' + inGroup); whole.value = 'group:' + group.id; optgroup.append(whole); values.push(whole.value);
      for (const [id, count] of counts) { const item = objectiveById(id); if (item?.group !== group.id) continue; const option = el('option', item.name + ' · ' + count); option.value = id; optgroup.append(option); values.push(id); }
      objectiveSelect.append(optgroup);
    }
    // A filter whose objective left the list falls back to All (the options were just rebuilt, so the list of values is authoritative).
    if (!values.includes(objectiveFilter)) objectiveFilter = 'all';
    objectiveSelect.value = objectiveFilter;
  }
  // Decorative: a Gotchi peeks into an empty list through the motion layer (window.curveMotion.peek); removed whenever the list is redrawn.
  function peekAway() { peekVersion++; try { peekHandle?.remove(); } catch { /* already gone */ } peekHandle = null; }
  function peekInto(target) { const peek = window?.curveMotion?.peek; if (typeof peek !== 'function' || !target) return; const version = peekVersion; target.classList.add('has-peek'); Promise.resolve().then(() => peek(target, { side: 'right', height: 92 })).then(handle => { if (disposed || version !== peekVersion) { try { handle?.remove(); } catch { /* ignore */ } return; } peekHandle = handle || null; if (!handle) target.classList.remove('has-peek'); }).catch(() => { if (version === peekVersion) target.classList.remove('has-peek'); }); }
  const controllers = new Set();
  async function api(path) {
    const controller = new AbortController(); controllers.add(controller); const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      let response;
      // A slow or dropped request shows readable text (never "signal is aborted without reason"); the page retries on its timer.
      try { response = await fetcher(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal }); }
      catch (e) { throw Error(controller.signal.aborted || e?.name === 'AbortError' ? 'The agent list is taking longer than usual to load. It will retry automatically.' : 'The agent list could not be reached. It will retry automatically.'); }
      const data = await response.json().catch(() => null); if (!response.ok) throw Object.assign(Error(data?.error || 'The agent list is unavailable.'), { status: response.status });
      if (!data || typeof data !== 'object') throw Error('The agent list is unavailable.'); return data;
    }
    finally { window.clearTimeout(timeout); controllers.delete(controller); }
  }
  function card(agent) {
    const now = clock(), article = el('article', null, 'agents-card'); article.dataset.state = agent.state;
    const avatar = el('div', null, 'agent-avatar'); avatar.classList.toggle('is-sleeping', ['sleeping_budget', 'paused_creator', 'paused_admin', 'paused_provider', 'paused_integrity', 'awaiting_funding', 'awaiting_settlement', 'provisioning'].includes(agent.state)); avatar.classList.toggle('is-running', agent.state === 'running'); avatar.classList.toggle('no-motion', reduced());
    avatar.append(el('span', (agent.symbol || 'A')[0]), el('i', null, 'agent-pulse'));
    // AI influencer (v71.30): the character's portrait stands in for the coin image, with an "on X" badge linking to the profile.
    const portrait = influencerAvatarUrl(agent.influencer), coinSrc = coinImage(agent.mint, agent.image), src = portrait || coinSrc;
    if (src) { const img = el('img'); img.src = src; img.alt = ''; img.loading = 'lazy'; let fellBack = !portrait || !coinSrc; img.onerror = () => { if (fellBack) { img.remove(); return; } fellBack = true; delete img.dataset.influencer; img.src = coinSrc; }; if (portrait) img.dataset.influencer = 'portrait'; avatar.prepend(img); }
    const badge = createInfluencerBadge(document, agent.influencer); if (badge) { avatar.classList.add('has-influencer'); avatar.append(badge); }
    const body = el('div', null, 'agents-card-body');
    const heading = el('div', null, 'agents-card-heading'); heading.append(el('h2', agent.name + ' · $' + agent.symbol), el('span', agent.stateLabel || AGENT_STATE_LABELS[agent.state] || agent.state, 'agent-pill')); heading.lastChild.dataset.state = agent.state;
    // Objective and personality chips (v71.27): the objective names the published program or "Custom".
    const chips = el('div', null, 'agents-card-chips'), objective = objectiveOf(agent), objectiveChip = el('span', agent.objectiveName || objective.name, 'agent-pill agent-pill-objective'); objectiveChip.dataset.objective = objective.id; objectiveChip.title = objective.summary; chips.append(objectiveChip);
    if (objective.program) { const program = el('span', objective.program.action === 'limiter' ? 'Limiter' : 'Program', 'agent-pill agent-pill-program'); program.title = objective.program.rule; chips.append(program); }
    const personality = AGENT_PERSONALITIES.find(p => p.id === agent.personalityPreset); if (personality) { const voice = el('span', personality.name, 'agent-pill agents-card-personality'); voice.title = personality.voice; chips.append(voice); }
    heading.append(chips);
    body.append(heading, el('p', agent.mission, 'agents-card-mission'));
    const facts = el('dl', null, 'agent-dl agents-card-facts');
    for (const [label, value] of [['Model', agent.model], ['Treasury', sol(agent.treasurySol) + (agent.treasuryUsd ? ' · ' + agent.treasuryUsd : '')], ['Operating credit', agent.operatingBackedUsd + (Number(agent.operatingUnsettledSol) > 0 ? ' · ' + sol(agent.operatingUnsettledSol) + ' unsettled' : '')], ['Fees received', agent.feeReceipts ? sol(agent.feesSol) + ' (' + agent.feeReceipts + ')' : 'none yet'], ['Capabilities', (agent.capabilities || []).join(', ')], ['Venue', agent.route === 'meteora' ? 'Meteora' : 'Raydium']]) { const row = el('div'); row.append(el('dt', label), el('dd', value)); facts.append(row); }
    body.append(facts);
    const foot = el('div', null, 'agents-card-foot');
    foot.append(el('span', agent.lastActivity ? agent.lastActivity.title + ' · ' + ago(agent.lastActivity.at, now) : (agent.stateReason || 'No activity yet'), 'agents-muted'));
    if (agent.state === 'ready' && agent.nextRunAt) foot.append(el('span', until(agent.nextRunAt, now), 'agents-muted'));
    if (agent.dryRun) foot.append(el('span', 'dry run', 'agent-pill'));
    const open = el('a', 'Open agent →', 'small-button'); open.href = agent.href; foot.append(open);
    const hidden = agent.moderation?.hidden === true;
    if (hidden) { article.classList.add('is-hidden'); const note = el('p', null, 'agents-card-moderation'); note.append(el('strong', 'Hidden from this page'), ' · ' + (agent.moderation.reason || 'no reason recorded') + (agent.moderation.by ? ' · by ' + agent.moderation.by : '') + (agent.moderation.at ? ' · ' + ago(agent.moderation.at, now) : '')); body.append(note); }
    if (moderator) { const link = el('a', hidden ? 'Unhide in admin →' : 'Hide in admin →', 'small-button agents-moderate'); link.href = '/admin#tokens/agents?agents.q=' + encodeURIComponent(agent.mint || agent.id); link.dataset.moderate = hidden ? 'unhide' : 'hide'; link.title = 'Opens the admin panel’s Agents tab on this agent. Hiding asks for your password and authenticator code and records the reason.'; foot.append(link); }
    body.append(foot); article.append(avatar, body); return article;
  }
  function render() {
    if (disposed) return;
    const host = $('agents-cards'); host.setAttribute('aria-busy', 'false'); host.replaceChildren(); peekAway(); host.classList.remove('has-peek');
    renderObjectiveFilter();
    const shown = agents.filter(agent => (filter === 'all' || group(agent.state) === filter) && matchesObjective(agent));
    for (const agent of shown) host.append(card(agent));
    const filters = $('agents-filters');
    if (filters) {
      filters.hidden = !agents.length;
      for (const button of filterButtons) button.setAttribute('aria-pressed', String(button.dataset.agentFilter === filter));
      for (const key of ['all', 'running', 'ready', 'resting']) { const count = $('agents-count-' + key); if (count) count.textContent = String(key === 'all' ? agents.length : agents.filter(agent => group(agent.state) === key).length); }
    }
    if (agents.length && !shown.length) { const objectiveName = objectiveFilter === 'all' ? '' : objectiveFilter.startsWith('group:') ? (AGENT_OBJECTIVE_GROUPS.find(item => item.id === objectiveFilter.slice(6))?.name || '').toLowerCase() : objectiveById(objectiveFilter)?.name || ''; host.append(el('p', objectiveName && filter !== 'all' ? 'No ' + objectiveName + ' agent is ' + (filter === 'running' ? 'running' : filter === 'ready' ? 'ready' : 'resting') + ' right now. The Gotchi is keeping watch.' : objectiveName ? 'No agent follows ' + objectiveName + ' yet. The Gotchi is keeping watch.' : filter === 'running' ? 'No agent is running right now. They wake up on their own schedule.' : filter === 'ready' ? 'No agent is waiting for its next run right now.' : 'Every agent is awake. Nothing is resting right now.', 'agents-empty')); peekInto(host.lastChild); }
    // A host that has not switched AI Agent mode on (503) or whose catalog is unreachable still explains the mode: the rules, funding terms and policy limits are static and ship with the page.
    const disabled = catalog?.unavailable === true, open = catalog?.intakeOpen === true;
    if (!agents.length) { host.append(el('p', disabled ? 'AI Agent mode is not switched on for this host yet. Agent coins will appear here once the platform owner enables it.' : error ? error : !open ? 'No agents yet. Agent launches are closed right now.' : 'No agents yet. Launch a coin with the AI Agent option to create the first one.', 'agents-empty')); if (!disabled && !error) peekInto(host.lastChild); }
    $('agents-more').hidden = !nextCursor;
    const hiddenCount = agents.filter(agent => agent.moderation?.hidden === true).length;
    $('agents-status').textContent = disabled ? '' : error ? error : agents.length ? 'Live · ' + agents.length + ' agent' + (agents.length === 1 ? '' : 's') + ' shown' + (moderator && hiddenCount ? ' (' + hiddenCount + ' hidden from the public, shown to you as an admin)' : '') + ' · refreshed ' + ago(clock(), clock()) + '. Treasury values use the live SOL price.' : '';
    const launch = $('agents-launch'); if (launch) launch.hidden = !open;
    const closedNote = $('agents-closed'); if (closedNote) { closedNote.hidden = open; closedNote.textContent = disabled ? 'Launching an agent coin becomes available when the host enables AI Agent mode.' : 'Agent launches are closed right now. The platform owner can reopen intake.'; }
    const facts = $('agents-intro-facts'); facts.replaceChildren();
    const limits = catalog?.policy?.limits || {}, policy = AGENT_POLICY_V1, usd = micro => formatUsdMicro(String(micro));
    for (const [label, value] of [['Fee split', '30% ops · 70% treasury, after the platform share'], ['Activates at', limits.activation || usd(policy.activation.activateUsd)], ['Run budget', (limits.dailyCap || usd(policy.budget.agentDailyCapUsd)) + ' / day'], ['Treasury actions', '≤ ' + (limits.perAction || usd(policy.treasury.perActionUsd)) + ' each'], ['Models', disabled ? 'not enabled on this host' : modelsSummary(catalog?.models || [])], ['Launches', disabled ? 'not enabled' : open ? 'open' : 'closed']]) { const cell = el('div'); cell.append(el('span', label), el('strong', value)); facts.append(cell); }
    const rules = $('agents-rules-list'); rules.replaceChildren(); for (const rule of catalog?.rules?.length ? catalog.rules : AGENT_RULES) rules.append(el('li', rule));
    const fundingText = catalog?.funding && Object.keys(catalog.funding).length ? catalog.funding : AGENT_FUNDING_SUMMARY;
    const funding = $('agents-funding'); funding.replaceChildren(); for (const [key, label] of [['pump', 'Pump.fun launches'], ['raydium', 'Raydium launches'], ['meteora', 'Meteora launches']]) { const text = fundingText[key]; if (!text) continue; const box = el('div', null, 'agents-funding-card'); box.append(el('strong', label), el('p', text)); funding.append(box); }
    $('agents-custody').textContent = catalog?.policy?.custody || policy.custody;
  }
  // v71.37 moderation: an admin (signed in, two-factor) sees hidden agents on this page too, dimmed with the reason, who and when,
  // and each card links into the admin panel's Agents tab to hide or unhide it there (every admin write re-checks the password and
  // authenticator code and records the reason). The server marks the list `moderator: true` for such a viewer; nobody else sees hidden agents.
  let moderator = false;
  const page = async cursor => { const data = await api('/api/launchpad/agents?limit=' + cursor.limit + (cursor.after ? '&cursor=' + encodeURIComponent(cursor.after) : '')); if (!Array.isArray(data.agents)) throw Error('The agent list is unavailable.'); moderator = data.moderator === true; return data; };
  async function load({ more = false } = {}) {
    if (disposed || loading) return; loading = true; const focus = focusSnapshot(document, main);
    try {
      if (!catalog) { try { catalog = await api('/api/launchpad/agents/catalog'); } catch (e) { catalog = { unavailable: true, intakeOpen: false, rules: [], funding: {}, reason: e.status === 503 ? 'AI Agent mode is not enabled on this host.' : e.message }; if (e.status === 503) { error = ''; render(); return; } } }
      if (more) { if (!nextCursor) return; const data = await page({ limit: PAGE, after: nextCursor }); if (disposed) return; agents = [...agents, ...data.agents]; nextCursor = data.nextCursor || null; }
      else {
        // A refresh re-reads every page already shown, so "Load more" is never undone.
        const want = Math.max(PAGE, agents.length); let rows = [], after = null;
        do { const data = await page({ limit: Math.min(100, Math.max(PAGE, want - rows.length)), after }); if (disposed) return; rows = [...rows, ...data.agents]; after = data.nextCursor || null; } while (after && rows.length < want);
        agents = rows; nextCursor = after;
      }
      error = '';
    } catch (e) { if (!disposed) error = e.status === 503 ? 'AI Agent mode is not enabled on this host.' : e.message; }
    finally { loading = false; render(); if (!disposed) restoreFocus(document, main, focus); }
  }
  $('agents-more').onclick = () => load({ more: true });
  shell({ page: 'agents', chain: 'solana' });
  // A direct load or reload reads the session, so the header shows the signed-in account and its admin link.
  const sessionController = new AbortController();
  Promise.resolve().then(() => fetcher('/api/session', { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: sessionController.signal })).then(response => response.ok ? response.json() : null).then(session => { if (!disposed && session && typeof session === 'object') shell({ page: 'agents', chain: 'solana', session }); }).catch(() => {});
  const visibility = () => { if (!document.hidden) load(); };
  document.addEventListener('visibilitychange', visibility);
  timer = setTimer(() => { if (!document.hidden) load(); }, REFRESH_MS);
  const ready = load();
  return { ready, refresh: () => load(), destroy() { if (disposed) return; disposed = true; clearTimer(timer); peekAway(); sessionController.abort(); document.removeEventListener('visibilitychange', visibility); for (const controller of controllers) controller.abort(); }, canLeave: () => true };
}
export function mountPage({ document = globalThis.document, window = document.defaultView } = {}) { return createAgentsPage({ document, window }); }
bootPage('agents', mountPage);
