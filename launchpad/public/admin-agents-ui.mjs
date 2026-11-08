// Owner view of AI Agent mode: rollout flags, solvency, pending settlement,
// unknown provider usage, orphan browsers, transaction backlog, pause reasons,
// provider funding batches, backing, reimbursement, health checks, key
// verification, the model catalog (every allowlisted model with its live price
// and availability) and every agent with its objective and program state.
// Stored key values are never returned by the API.
import { PAGE_SIZE, copyButton, exactTime, filterBar, hashState, pageRows, pager, relativeTime, timeNode } from './admin-list-kit.mjs';
import { INFLUENCER_STATE_LABELS, INFLUENCER_MEDIA_MODES } from './influencer-catalog.mjs';
import { influencerView } from './influencer-ui.mjs';
const POLL_MS = 30000;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const number = value => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const when = value => { const at = number(value); return at > 0 ? new Date(at).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'; };
const count = (value, one, many = one + 's') => { const n = Number.isSafeInteger(value) && value >= 0 ? value : 0; return n + ' ' + (n === 1 ? one : many); };
const plain = (value, max = 300) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : '';
const whole = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
// Provider health (GET /api/admin/agents/health, or the POST that also releases orphaned browser sessions) as one readable line.
function healthSummary(result) {
  if (!result || typeof result !== 'object') return 'The health check returned no details.';
  const parts = ['Checked ' + when(result.at)], model = result.model, browser = result.browser, database = result.database, worker = result.worker, catalog = result.catalog;
  if (model) parts.push('Model provider (OpenRouter): ' + (model.ok ? 'OK' + (model.remainingUsd ? ', ' + plain(model.remainingUsd, 24) + ' credit left' + (model.totalCreditsUsd ? ' of ' + plain(model.totalCreditsUsd, 24) : '') : '') : (model.configured ? 'check failed' : 'not configured') + (model.error ? ': ' + plain(model.error) : '')));
  if (browser) parts.push('Browser provider (Browserbase): ' + (browser.ok ? 'OK, ' + count(browser.running, 'running session') + ', ' + count(browser.orphans, 'orphaned session') + (Number(browser.released) > 0 ? ', ' + count(browser.released, 'session') + ' released' : '') : (browser.configured ? 'check failed' : 'not configured') + (browser.error ? ': ' + plain(browser.error) : '')));
  if (database) parts.push('Database: ' + (database.ok ? 'OK' : 'needs a check') + (database.version != null ? ' (schema ' + plain(String(database.version), 12) + ')' : ''));
  if (worker) parts.push('Worker: ' + (worker.ready ? 'ready' : 'not ready') + (Number.isSafeInteger(worker.inFlight) ? ', ' + worker.inFlight + ' in flight' : '') + (Number(worker.restarts) > 0 ? ', ' + count(worker.restarts, 'restart') : ''));
  if (catalog) parts.push('Model catalog: ' + (Number.isSafeInteger(catalog.available) && Number.isSafeInteger(catalog.total) ? catalog.available + ' of ' + count(catalog.total, 'model') + ' available' : Array.isArray(catalog.models) ? count(catalog.models.length, 'model') : 'loaded') + (catalog.refreshedAt ? ', refreshed ' + when(catalog.refreshedAt) : '') + (catalog.error ? ': ' + plain(catalog.error) : ''));
  if (typeof result.dryRun === 'boolean') parts.push(result.dryRun ? 'Dry run (mock model)' : 'Real mode');
  return parts.join(' · ') + '.';
}
// Results of the other owner operations, summarised instead of printed as JSON.
function toolSummary(path, result) {
  if (path.includes('/health')) return healthSummary(result);
  if (!result || typeof result !== 'object') return 'Done.';
  if (path.endsWith('/keys/verify')) { const failed = Array.isArray(result.rows) ? result.rows.filter(row => row && !row.ok) : []; return result.ok ? 'All ' + count(result.checked, 'agent key document') + ' match their wallets.' : 'Key check failed for ' + count(failed.length, 'agent') + ': ' + failed.slice(0, 10).map(row => plain(row.wallet || row.id, 44) + ' (' + (plain(row.error, 160) || 'does not match its wallet') + ')').join(' · ') + '.'; }
  if (path.endsWith('/keys/rotate')) return 'Re-encrypted ' + count(result.rotated, 'key document') + '.' + (result.note ? ' ' + plain(result.note) : '');
  if (path.endsWith('/backup')) return 'Ledger backup written' + (result.path ? ' to ' + plain(result.path, 200) : '') + (result.at ? ' at ' + when(result.at) : '') + '.';
  return 'Done.';
}
const decimalAmount = value => /^\d{1,12}(?:\.\d{1,6})?$/.test(value);
const FLAGS = [['intake', 'Launch intake', 'Lets creators launch new AI Agent coins (Raydium, Meteora and Pump.fun).'], ['runs', 'Agent runs', 'Starts scheduled research runs. Off stops new runs; fees and receipts keep settling.'], ['model', 'Model execution', 'Allows OpenRouter requests inside runs (needs the key in /etc/launchpad.env).'], ['browser', 'Browser execution', 'Allows Browserbase sessions inside runs (needs key and project id).'], ['financial', 'Treasury actions', 'Allows signing buyback/burn and holder-reward transactions. Off stops new signatures; signed ones still reconcile.'], ['settlement', 'Operating settlement', 'Allows swapping operating SOL to USDC (Jupiter, 50 bps caps).'], ['influencer', 'AI influencer', 'Lets agent launches add an X account and a generated character (needs the X app and Higgsfield keys in /etc/launchpad.env). Off stops new connections, generations and posts; existing media stays readable.']];
// AI influencer (v71.30): the per-agent view (state, X handle, character, caps, today's counters) and the 24 h stats the snapshot may carry.
const INFLUENCER_TONES = Object.freeze({ ready: 'good', generating: 'warn', pending: '', failed: 'bad', paused: 'warn', disabled: 'bad' });
const influencerOf = row => row && row.influencer && typeof row.influencer === 'object' ? influencerView(row.influencer) : null;
/** Whether the platform paused posting: the view's own flag when it carries one, else a paused state the creator did not cause. */
const influencerPausedByAdmin = view => view.adminPaused === true || (view.adminPaused === null && view.state === 'paused' && view.postingPaused !== true);
// ---- models ------------------------------------------------------------------------
const MODEL_CHIPS = Object.freeze([['', 'All'], ['available', 'Available'], ['unavailable', 'Unavailable']]);
const TAG_LABELS = Object.freeze({ fast: 'Fast', balanced: 'Balanced', deep: 'Deep' });
const TAG_TITLES = Object.freeze({ fast: 'Completion price under $1 per million tokens: a small model that answers in a moment.', balanced: 'Completion price under $8 per million tokens: a mid-tier model.', deep: 'Completion price of $8 or more per million tokens: a frontier reasoning model.' });
// The availability pill: the registry's reason, in the owner's words.
const AVAILABILITY = Object.freeze({ 'not in the live catalog': ['Not in live catalog', 'bad', 'OpenRouter does not list this id. Check the spelling of the allowlist entry, or wait for the provider to publish it.'], 'no pricing': ['No pricing', 'bad', 'OpenRouter lists this model without a usable price, so no run can be reserved against it.'], 'no tools support': ['No tools', 'bad', 'This model cannot call tools, which every agent run needs.'], 'pricing stale': ['Stale', 'warn', 'The last price is older than 24 hours. Runs wait for a fresh catalog.'], 'no live catalog yet': ['No catalog yet', 'warn', 'The live catalog has not been read since the service started.'] });
const providerOf = id => { const text = String(id || ''); const at = text.indexOf('/'); return at > 0 ? text.slice(0, at).toLowerCase() : ''; };
const providerLabel = model => plain(model.providerName, 40) || (providerOf(model.id) ? providerOf(model.id).replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()) : 'Other');
/** The live name without a repeated "Provider: " prefix ("OpenAI: GPT-5 Mini", "MoonshotAI: Kimi K2"); the id alone (shown under it) reads as "—". */
const modelName = model => {
  const name = plain(model.name, 120), match = /^([^:]{1,32}):\s+(\S.*)$/.exec(name), squash = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const provider = squash(providerOf(model.id) || model.provider), label = squash(providerLabel(model)), prefix = match ? squash(match[1]) : '';
  const short = match && prefix && [provider, label].some(key => key && (key.startsWith(prefix) || prefix.startsWith(key))) ? match[2].trim() : name;
  return short && short !== model.id ? short : '';
};
// "$2.5", "$0.075", "$14": up to three decimals below $1, two below $10, one above, trailing zeros dropped.
const usdPerMillion = value => { const n = number(value); if (n === null || n < 0) return '—'; return '$' + String(Number(n.toFixed(n >= 10 ? 1 : n >= 1 ? 2 : 3))); };
const tokens = value => { const n = number(value); if (!n || n < 0) return '—'; return n >= 1e6 ? String(Number((n / 1e6).toFixed(2))) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'K' : String(Math.round(n)); };
/** Models grouped by provider in allowlist order (the first provider seen is the default model's). */
function groupModels(models) {
  const groups = [];
  for (const model of models) { const key = providerOf(model.id) || plain(model.provider, 40) || ''; let group = groups.find(item => item.key === key); if (!group) { group = { key, label: providerLabel(model), models: [] }; groups.push(group); } group.models.push(model); }
  return groups;
}
// ---- agents ------------------------------------------------------------------------
const STATE_TONES = Object.freeze({ ready: 'good', running: 'good', sleeping_budget: 'warn', awaiting_funding: 'warn', awaiting_settlement: 'warn', provisioning: '', paused_creator: 'warn', paused_admin: 'bad', paused_provider: 'bad', paused_integrity: 'bad', archived: '' });
const ACTION_KINDS = Object.freeze({ buyback_burn: 'Buyback & burn', holder_reward: 'Holder reward' });
const humanize = value => plain(value, 60).replace(/[_-]+/g, ' ').replace(/^\w/, letter => letter.toUpperCase());
/** The objective name an admin row carries ('Custom' for agents launched before objectives existed). */
const objectiveName = row => plain(row?.objectiveName, 60) || (typeof row?.objective === 'string' && row.objective ? humanize(row.objective) : 'Custom');
const objectiveKey = row => (typeof row?.objective === 'string' && row.objective) || (plain(row?.objectiveName, 60) ? plain(row.objectiveName, 60).toLowerCase().replace(/[^a-z0-9]+/g, '_') : 'custom');
/**
 * The program pill: Active while the platform runs the program, Finished when it ran to its end (milestones hit,
 * graduation reached), Waiting while a published condition holds it back (market data, quiet period, launch not live),
 * Off when a pause, a missing capability, the archive or the platform's treasury switch stops it. Null without a program.
 */
export function programStatus(program) {
  if (!program || typeof program !== 'object') return null;
  if (program.finished === true) return { label: 'Finished', tone: '', reason: plain(program.finishedReason, 240) || plain(program.reason, 240) };
  if (program.active === true) return { label: 'Active', tone: 'good', reason: '' };
  const reason = plain(program.reason, 240);
  if (/^(waiting|reading)\b/i.test(reason)) return { label: 'Waiting', tone: 'warn', reason };
  return { label: 'Off', tone: 'bad', reason };
}
const paused = row => row.paused === true || row.ownerPaused === true || row.creatorPaused === true || row.adminPaused === true || row.integrityPaused === true || typeof row.pausedReason === 'string' && row.pausedReason.length > 0;

export function createAdminAgents({ document, api, security, message = () => {}, getAccount, isActive = () => true, setTimer = setInterval, clearTimer = clearInterval, clock = Date.now } = {}) {
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = String(text); if (cls) node.className = cls; return node; };
  const view = document.defaultView || null;
  // A long address keeps its full text (copy, search, screen readers) and gives way in the middle when space runs out.
  const address = (node, value) => { if (typeof value === 'string' && value.length > 12) { node.replaceChildren(el('span', value.slice(0, -6)), el('span', value.slice(-6))); node.classList.add('admin-address'); node.setAttribute('title', value); } return node; };
  const pill = (label, tone = '', cls = '') => el('span', label, 'cv-pill' + (tone ? ' is-' + tone : '') + (cls ? ' ' + cls : ''));
  const element = el('section', null, 'admin-card admin-agents'); element.id = 'admin-agents';
  const heading = el('div', null, 'admin-card-heading'), copy = el('div'), refresh = el('button', 'Refresh', 'text-button'); refresh.type = 'button'; refresh.id = 'admin-agents-refresh';
  copy.append(el('p', 'LAUNCH OPERATIONS / AI AGENTS', 'eyebrow'), el('h2', 'AI Agents'), el('p', 'Rollout flags, solvency, provider backing, the model catalog and every agent’s objective, program and pause state. Keys never leave the server; this view only verifies them.'));
  heading.append(copy, refresh);
  const status = el('p', '', 'admin-revenue-status'); status.id = 'admin-agents-status'; status.setAttribute('role', 'status');
  const reasonLabel = el('label', 'Reason for the next change', 'admin-protocol-wide'), reason = el('input'); reason.id = 'admin-agents-reason'; reason.minLength = 5; reason.maxLength = 500; reason.placeholder = 'Recorded with every flag change, pause, batch or reimbursement'; reasonLabel.append(reason);
  const flagsBox = el('div', null, 'admin-gotchi-flags'); flagsBox.id = 'admin-agents-flags';
  const solvency = el('div', null, 'admin-gas-facts'); solvency.id = 'admin-agents-solvency';
  const alerts = el('ul', null, 'admin-protocol-history'); alerts.id = 'admin-agents-alerts';
  const pending = el('details', null, 'admin-protocol-gas'); const pendingList = el('ul', null, 'admin-protocol-history'); pending.append(el('summary', 'Pending work'), pendingList);
  const tools = el('div', null, 'admin-gotchi-flags'); tools.id = 'admin-agents-tools';
  const health = el('p', '', 'help'); health.id = 'admin-agents-health';
  const batchForm = el('details', null, 'admin-protocol-gas'); batchForm.id = 'admin-agents-batch';
  const batchFields = el('div', null, 'admin-protocol-wide');
  const inputs = {};
  for (const [key, label, placeholder] of [['reference', 'Provider reference (invoice / payment id)', 'or-inv-1234'], ['evidence', 'Evidence (what proves this purchase)', 'OpenRouter invoice or-inv-1234, paid by card on 2026-10-02'], ['paidUsdc', 'Paid (USDC or USD equivalent)', '100'], ['purchaseFeeUsdc', 'Purchase fee included in the payment', '5.50'], ['creditsUsd', 'Credits received at the provider (USD)', '94.50']]) { const wrap = el('label', label), input = el('input'); input.placeholder = placeholder; input.id = 'admin-agents-batch-' + key; inputs[key] = input; wrap.append(input); batchFields.append(wrap); }
  const batchSave = el('button', 'Record provider funding batch', 'small-button'); batchSave.type = 'button';
  batchForm.append(el('summary', 'Record provider funding (manual reconciliation)'), el('p', 'Record a real provider credit purchase with its evidence, then back settled USDC with it. The same purchase can never back credit twice; balances are never set by hand.', 'help'), batchFields, batchSave);
  const batches = el('ul', null, 'admin-protocol-history'); batches.id = 'admin-agents-batches';
  // Models: every allowlisted id grouped by provider with its live price, tag and why it is (not) offered to creators.
  const modelsCard = el('section', null, 'admin-agents-models'); modelsCard.id = 'admin-agents-models'; modelsCard.setAttribute('aria-label', 'Models');
  const modelsHead = el('div', null, 'admin-list-head'), modelsTitle = el('h3', 'Models'), modelsTools = el('div', null, 'admin-list-tools');
  const modelsFilter = filterBar(document, { label: 'Model filter', chips: MODEL_CHIPS.map(([key, label]) => ({ key, label })), onChange: ({ chip }) => { modelsQuery.chip = chip; renderModels(); } });
  modelsFilter.input.hidden = true; modelsFilter.input.tabIndex = -1; modelsFilter.element.classList.add('admin-filter-chips-only');
  const modelsRefresh = el('button', 'Refresh catalog', 'small-button cv-sm'); modelsRefresh.type = 'button'; modelsRefresh.id = 'admin-agents-models-refresh'; modelsRefresh.title = 'Reads the public OpenRouter catalog again (the provider health check, no spend) and shows the result.';
  modelsTools.append(modelsFilter.element, modelsRefresh); modelsHead.append(modelsTitle, modelsTools);
  const modelsNote = el('p', '', 'help'); modelsNote.id = 'admin-agents-models-note';
  const modelsBox = el('div'); modelsBox.id = 'admin-agents-models-table';
  modelsCard.append(modelsHead, modelsNote, modelsBox);
  const modelsQuery = { chip: '' };
  let registry = null;
  function renderModels(next = registry) {
    registry = next && typeof next === 'object' ? next : null;
    const models = Array.isArray(registry?.models) ? registry.models.filter(model => model && typeof model.id === 'string') : [];
    const now = clock(), available = models.filter(model => model.available === true), shown = models.filter(model => modelsQuery.chip === 'available' ? model.available === true : modelsQuery.chip === 'unavailable' ? model.available !== true : true);
    modelsFilter.setChips(MODEL_CHIPS.map(([key, label]) => ({ key, label, count: key === '' ? models.length : key === 'available' ? available.length : models.length - available.length })));
    modelsTitle.textContent = models.length ? `Models (${available.length} of ${models.length} available)` : 'Models';
    const notes = [];
    if (registry?.refreshedAt) notes.push('Catalog read ' + relativeTime(Number(registry.refreshedAt), now) + ' (' + exactTime(Number(registry.refreshedAt)) + ')');
    else notes.push('The live catalog has not been read yet');
    const stale = number(registry?.staleMs); notes.push('prices count as stale after ' + (stale ? Math.round(stale / 3600000) + ' hours' : '24 hours') + '; creators can only launch available models');
    const error = plain(registry?.lastRefreshError || registry?.error, 200); if (error) notes.push('last refresh error: ' + error);
    const note = registry ? notes.join(' · ') : 'This snapshot carries no model catalog.'; modelsNote.textContent = /[.!?]$/.test(note) ? note : note + '.'; modelsNote.classList.toggle('admin-gas-warning', !!error);
    modelsBox.replaceChildren();
    if (!shown.length) { modelsBox.append(el('p', models.length ? 'No models match this filter.' : registry ? 'No models are allowlisted. Set AGENTS_OPENROUTER_MODELS, or leave it empty for the default list.' : 'No models to show.', 'help')); return; }
    const wrap = el('div', null, 'admin-revenue-table-wrap'), table = el('table', null, 'admin-revenue-table admin-models-table'), head = el('thead'), headRow = el('tr');
    for (const [label, cls] of [['Model', ''], ['Tag', ''], ['$ in / 1M', 'num'], ['$ out / 1M', 'num'], ['Context', 'num'], ['Tools', ''], ['Availability', ''], ['Priced', '']]) { const th = el('th', label, cls || undefined); th.scope = 'col'; headRow.append(th); }
    head.append(headRow); table.append(head);
    for (const group of groupModels(shown)) {
      const body = el('tbody'); body.dataset.provider = group.key;
      const groupRow = el('tr', null, 'admin-model-group'), groupCell = el('td'); groupCell.colSpan = 8;
      const inGroup = models.filter(model => (providerOf(model.id) || plain(model.provider, 40) || '') === group.key), ready = inGroup.filter(model => model.available === true).length;
      groupCell.append(el('strong', group.label), el('span', `${ready} of ${count(inGroup.length, 'model')} available`, 'admin-model-group-count')); groupRow.append(groupCell); body.append(groupRow);
      for (const model of group.models) {
        const tr = el('tr'); tr.dataset.model = model.id; tr.dataset.available = String(model.available === true); tr.dataset.priced = String(!!number(model.pricedAt));
        const name = el('td'), label = modelName(model), idLine = el('span', null, 'admin-address-cell'), id = el('code', model.id, 'admin-model-id'); id.title = model.id;
        idLine.append(id, copyButton(document, model.id, 'Copy model id'));
        name.append(el('strong', label || '—', 'admin-model-name'), idLine);
        const tag = el('td'); if (TAG_LABELS[model.tag]) { const node = pill(TAG_LABELS[model.tag], '', 'admin-model-tag is-' + model.tag); node.title = TAG_TITLES[model.tag]; tag.append(node); } else tag.append(el('span', '—', 'admin-muted'));
        const tools = model.supportsTools === true ? 'Yes' : model.supportsTools === false ? 'No' : '—';
        const availability = el('td'); if (model.available === true) { const node = pill('Available', 'good'); node.title = 'Listed by OpenRouter with a fresh price and tool support.'; availability.append(node); } else { const [text, tone, title] = AVAILABILITY[model.unavailableReason] || [plain(model.unavailableReason, 40) || 'Unavailable', 'bad', '']; const node = pill(text, tone); if (title) node.title = title; availability.append(node); }
        const priced = el('td'); priced.append(number(model.pricedAt) ? timeNode(document, Number(model.pricedAt), { now }) : el('span', '—'));
        tr.append(name, tag, el('td', usdPerMillion(model.promptUsdPerMillion), 'num'), el('td', usdPerMillion(model.completionUsdPerMillion), 'num'), el('td', tokens(model.contextLength), 'num'), el('td', tools, tools === 'No' ? 'admin-model-no' : undefined), availability, priced);
        body.append(tr);
      }
      table.append(body);
    }
    wrap.append(table); modelsBox.append(wrap);
  }
  // Agents are listed 25 a page after a text filter (name, coin, wallet, objective) and an objective choice, so a long roster never scrolls for miles.
  const agentsBox = el('div', null, 'admin-launch-rows'); agentsBox.id = 'admin-agents-cards';
  const agentsHead = el('div', null, 'admin-list-head'), agentsTitle = el('h3', 'Agents'); agentsHead.append(agentsTitle);
  const agentsFilter = filterBar(document, { placeholder: 'Find an agent: name, coin, mint, wallet or objective', label: 'Find an agent', chips: [{ key: '', label: 'All' }, { key: 'paused', label: 'Paused' }, { key: 'hidden', label: 'Hidden' }], onChange: ({ q, chip }) => { agentsQuery.q = q; agentsQuery.chip = chip; agentsQuery.offset = 0; writeState(); renderAgents(); } });
  agentsFilter.input.id = 'admin-agents-search'; agentsFilter.element.classList.add('admin-sticky-tools');
  const objectiveLabel = el('label', null, 'admin-agents-objective'), objectiveSelect = el('select'); objectiveSelect.id = 'admin-agents-objective'; objectiveSelect.setAttribute('aria-label', 'Objective');
  objectiveLabel.append(objectiveSelect); agentsFilter.element.append(objectiveLabel);
  objectiveSelect.onchange = () => { agentsQuery.objective = objectiveSelect.value; agentsQuery.offset = 0; writeState(); renderAgents(); };
  const agentsPages = pager(document, { label: 'agents', onPage: offset => { agentsQuery.offset = offset; writeState({ push: true }); renderAgents(); agentsBox.scrollIntoView?.({ block: 'start' }); } });
  const agentsQuery = { q: '', chip: '', objective: '', offset: 0 }, state = hashState(view, { prefix: 'agents' }), expanded = new Set();
  function readState() { agentsQuery.q = state.get('q'); agentsQuery.chip = ['paused', 'hidden'].includes(state.get('state')) ? state.get('state') : ''; agentsQuery.objective = state.get('objective'); const page = Number(state.get('page')); agentsQuery.offset = Number.isSafeInteger(page) && page > 1 ? (page - 1) * PAGE_SIZE : 0; agentsFilter.set({ q: agentsQuery.q, chip: agentsQuery.chip }); }
  function writeState(options) { state.set({ q: agentsQuery.q, state: agentsQuery.chip, objective: agentsQuery.objective, page: agentsQuery.offset ? Math.floor(agentsQuery.offset / PAGE_SIZE) + 1 : 0 }, options); }
  function renderObjectives(rows) {
    const counts = new Map();
    for (const row of rows) { const key = objectiveKey(row); const entry = counts.get(key) || { name: objectiveName(row), count: 0 }; entry.count++; counts.set(key, entry); }
    const options = [['', `Every objective (${rows.length.toLocaleString('en-US')})`], ...[...counts.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([key, entry]) => [key, `${entry.name} (${entry.count.toLocaleString('en-US')})`])];
    if (agentsQuery.objective && !counts.has(agentsQuery.objective)) options.push([agentsQuery.objective, humanize(agentsQuery.objective) + ' (0)']);
    objectiveSelect.replaceChildren(...options.map(([value, label]) => { const option = el('option', label); option.value = value; return option; }));
    objectiveSelect.value = agentsQuery.objective;
  }
  function renderAgents() {
    const rows = Array.isArray(snapshot?.agents) ? snapshot.agents : [], now = clock();
    renderObjectives(rows);
    const page = pageRows(rows, { offset: agentsQuery.offset, q: agentsQuery.q, fields: ['name', 'symbol', 'mint', 'wallet', 'id', 'creator', 'creatorWallet', 'launchMint', objectiveName, row => row.model], keep: row => (agentsQuery.chip === 'paused' ? paused(row) : agentsQuery.chip === 'hidden' ? row.hidden === true : true) && (!agentsQuery.objective || objectiveKey(row) === agentsQuery.objective), limit: PAGE_SIZE });
    agentsQuery.offset = page.offset;
    agentsFilter.setChips([{ key: '', label: 'All', count: rows.length }, { key: 'paused', label: 'Paused', count: rows.filter(paused).length }, { key: 'hidden', label: 'Hidden', count: rows.filter(row => row.hidden === true).length }]);
    agentsTitle.textContent = `Agents (${rows.length.toLocaleString('en-US')})`;
    agentsBox.replaceChildren(...page.rows.map(row => renderRow(row, now))); if (!page.rows.length) agentsBox.append(el('p', rows.length ? 'No agents match this filter.' : 'No agents yet.', 'help'));
    agentsPages.update({ offset: page.offset, limit: PAGE_SIZE, total: page.total, shown: page.rows.length });
  }
  const audit = el('details', null, 'admin-protocol-gas'), auditList = el('ul', null, 'admin-protocol-history'); audit.append(el('summary', 'Owner audit log'), auditList);
  element.append(heading, status, reasonLabel, el('h3', 'Rollout flags'), flagsBox, el('h3', 'Solvency'), solvency, el('h3', 'Alerts'), alerts, pending, el('h3', 'Operations'), tools, health, batchForm, el('h3', 'Provider funding batches'), batches, modelsCard, agentsHead, agentsFilter.element, agentsBox, agentsPages.element, audit);
  let snapshot = null, revision = 0, disposed = false, loading = false, busy = false, active = false, timer = null, viewOwner = null, loadedAt = 0;
  const accountIdentity = () => getAccount()?.id ?? getAccount();
  const permitted = () => !disposed && getAccount()?.role === 'admin' && getAccount()?.mfaEnabled === true;
  const permittedAt = (generation, owner) => permitted() && revision === generation && accountIdentity() === owner;
  function stop() { if (timer !== null) { clearTimer(timer); timer = null; } }
  function schedule() { stop(); if (active && permitted() && isActive() && !document.hidden && !busy) timer = setTimer(() => { if (permitted() && isActive() && !document.hidden) void load(); else stop(); }, POLL_MS); }
  function controls() { const disabled = !permitted() || !snapshot || loading || busy || snapshot?.disabled; refresh.disabled = !permitted() || loading || busy; reason.disabled = disabled; for (const button of element.querySelectorAll('button:not(#admin-agents-refresh):not([data-chip]):not([data-page]):not(.admin-copy)')) button.disabled = disabled; for (const input of Object.values(inputs)) input.disabled = disabled; }
  function clear() { revision++; stop(); snapshot = null; viewOwner = null; loadedAt = 0; loading = false; busy = false; active = false; element.hidden = true; status.textContent = ''; flagsBox.replaceChildren(); solvency.replaceChildren(); alerts.replaceChildren(); pendingList.replaceChildren(); tools.replaceChildren(); batches.replaceChildren(); agentsBox.replaceChildren(); agentsPages.update({ total: 0 }); agentsFilter.cancel(); expanded.clear(); renderModels(null); auditList.replaceChildren(); health.textContent = ''; reason.value = ''; delete element.dataset.adminSummary; controls(); }
  function requireReason() { const text = reason.value.trim(); if (text.length < 5 || text.length > 500) { message('Enter a reason from 5 to 500 characters.', true); return null; } return text; }
  async function act(label, path, body, { reload = true } = {}) {
    if (viewOwner !== accountIdentity()) { clear(); return null; } if (!permitted() || element.hidden || !isActive()) return null;
    const generation = revision, owner = accountIdentity(); busy = true; stop(); controls();
    try { const credentials = await security.authorize(label, { requireCode: true }); if (!permittedAt(generation, owner) || !isActive()) return null; const result = await api(path, { ...body, ...credentials }); if (!permittedAt(generation, owner)) return null; message(label + ' done.'); if (reload) await load(true); return result; }
    catch (error) { if (permittedAt(generation, owner) && error?.message !== 'Cancelled.') message(error?.message || 'The request could not be confirmed. Refresh before trying again.', true); return null; }
    finally { if (generation === revision) { if (!permittedAt(generation, owner)) { clear(); return; } busy = false; controls(); schedule(); } }
  }
  /** The provider health check is a read (no spend); it re-reads the live catalog on the server and returns it, so the Models card shows the result at once. */
  async function healthCheck(label) {
    if (!permitted() || busy || loading) return null; const generation = revision, owner = accountIdentity(); busy = true; controls();
    try { const result = await api('/api/admin/agents/health'); if (!permittedAt(generation, owner)) return null; health.textContent = toolSummary('/api/admin/agents/health', result); if (result?.catalog && typeof result.catalog === 'object' && Array.isArray(result.catalog.models)) renderModels(result.catalog); message(label + ' completed.'); return result; }
    catch (error) { if (permittedAt(generation, owner)) message(error.message, true); return null; }
    finally { if (generation === revision) { busy = false; controls(); } }
  }
  modelsRefresh.onclick = () => healthCheck('Catalog refresh');
  function stat(label, value, warn = false) { const item = el('div', null, 'admin-stat'); item.append(el('span', label), el('strong', value)); if (warn) item.classList.add('admin-gas-warning'); return item; }
  const modelLabel = id => { const model = Array.isArray(registry?.models) ? registry.models.find(item => item?.id === id) : null; return (model && modelName(model)) || plain(id, 80).replace(/^[^/]+\//, '') || '—'; };
  /** The program block of an expanded row: rule, status and reason, schedule, counters, last note and where the latest treasury actions came from. */
  function renderProgram(row, now) {
    const box = el('div', null, 'admin-agent-program'), program = row.program, programState = programStatus(program);
    box.append(el('h4', 'Objective · ' + objectiveName(row)));
    if (program === undefined) { box.append(el('p', 'Program details are not part of this snapshot.', 'help')); return box; }
    if (!program || typeof program !== 'object') { box.append(el('p', 'This objective runs no platform program: the model proposes within the policy, as for any custom mission.', 'help')); return box; }
    const line = el('p', null, 'admin-agent-program-state'); line.append(pill(programState.label, programState.tone, 'admin-agent-program-pill'), ' ', plain(program.rule, 400) || 'Program rule not published.'); box.append(line);
    if (programState.reason) box.append(el('p', programState.reason, 'help'));
    const facts = el('div', null, 'admin-gas-facts');
    const time = (at, prefix = '') => { const n = number(at); return n ? timeNode(document, n, { now, prefix }) : '—'; };
    const cell = (label, value) => { const item = el('div', null, 'admin-stat'); item.append(el('span', label)); const strong = el('strong'); strong.append(value); item.append(strong); return item; };
    facts.append(cell('Program kind', program.kind === 'limiter' ? 'Limiter (caps the model’s proposals)' : (program.spends ? 'Spends treasury' : 'Does not spend')), cell('Next due', time(program.nextDueAt)), cell('Last evaluated', time(program.lastRunAt)), cell('Program actions', count(whole(program.actions), 'action') + (number(program.lastActionAt) ? ', last ' + relativeTime(Number(program.lastActionAt), now) : '')));
    if (Array.isArray(program.milestonesHit) && program.milestonesHit.length) facts.append(cell('Milestones hit', program.milestonesHit.map(value => value + '×').join(', ')));
    box.append(facts);
    box.append(el('p', 'Last note: ' + (plain(program.lastNote, 240) || 'none yet'), 'help'));
    const actions = Array.isArray(row.recentActions) ? row.recentActions.filter(action => action && typeof action === 'object').slice(0, 5) : null;
    if (actions) {
      const list = el('ul', null, 'admin-protocol-history admin-agent-actions');
      if (!actions.length) list.append(el('li', 'No treasury actions yet.', 'help'));
      for (const action of actions) { const item = el('li'), origin = action.origin === 'program', text = el('span', (ACTION_KINDS[action.kind] || humanize(action.kind)) + ' · ' + (plain(action.stateLabel, 40) || humanize(action.state)) + (plain(action.principalSol, 24) && action.principalSol !== '0' ? ' · ' + plain(action.principalSol, 24) + ' SOL' : ''), 'admin-agent-action'); const source = pill(origin ? 'Program' : 'Model', origin ? 'accent' : ''); source.title = origin ? 'Proposed by the objective’s program (platform scheduler).' : 'Proposed by the model during a run.'; item.append(source, text, time(action.createdAt)); list.append(item); }
      const fromProgram = actions.filter(action => action.origin === 'program').length;
      box.append(el('p', actions.length ? `Latest treasury actions: ${fromProgram} of ${actions.length} came from the program, ${actions.length - fromProgram} from the model.` : '', 'help'), list);
    }
    return box;
  }
  function renderAgent(row, now = clock()) {
    const card = el('div', null, 'admin-gotchi-card'); card.dataset.agent = row.id;
    const head = el('div', null, 'admin-card-heading'), title = el('div'); title.append(el('h3', row.name + ' · $' + row.symbol), el('p', row.stateLabel + (row.stateReason ? ' · ' + row.stateReason : ''), 'help')); head.append(title); card.append(head);
    const walletLine = el('p', null, 'help'); const a = address(el('a', row.wallet), row.wallet); a.href = 'https://solscan.io/account/' + row.wallet; a.target = '_blank'; a.rel = 'noopener noreferrer'; walletLine.append('Wallet ', a, ' · ' + row.route + ' · launch ' + row.launchState + (row.archived ? ' · archived' : '') + (row.hidden ? ' · hidden' : '')); card.append(walletLine);
    const facts = el('div', null, 'admin-gas-facts'); const b = row.balances || {}, t = b.treasury || {}, o = b.operating || {};
    for (const [label, value] of [['Treasury available', t.availableSol + ' SOL'], ['Reserved / frozen', t.reservedSol + ' / ' + t.frozenRewardsSol + ' SOL'], ['Operating unsettled', o.unsettledSol + ' SOL (+' + o.settlingSol + ' settling)'], ['Settled USDC', o.settledUsdc], ['Backed / reserved', o.backedUsd + ' / ' + o.reservedUsd], ['Spent / disputed', o.spentUsd + ' / ' + o.disputedUsd], ['Reimbursable USDC', row.reimbursableUsdc], ['Open actions', String(row.openActions) + (row.activeRun ? ' · run active' : '')]]) facts.append(stat(label, value));
    card.append(facts);
    if (row.integrityPaused) card.append(el('p', 'Integrity pause: ' + row.integrityReason, 'admin-gas-warning'));
    if (row.adminPaused) card.append(el('p', 'Platform pause: ' + row.adminPauseReason, 'admin-gas-warning'));
    if (row.hidden) card.append(el('p', 'Hidden from the agents page' + (row.hiddenReason ? ': ' + String(row.hiddenReason).replace(/[.\s]+$/, '') : '') + (row.hiddenBy ? ' · by ' + row.hiddenBy : '') + (row.hiddenAt ? ' · ' + relativeTime(row.hiddenAt, now) : '') + '. The coin still trades; its creator sees this note on the coin page.', 'admin-gas-warning'));
    const buttons = el('div', null, 'admin-gotchi-flags');
    const pauseButton = el('button', row.adminPaused ? 'Lift platform pause' : 'Platform pause', 'small-button'); pauseButton.type = 'button'; pauseButton.onclick = () => { const text = requireReason(); if (!text) return; void act((row.adminPaused ? 'Lift pause for ' : 'Pause ') + row.symbol, '/api/admin/agents/control', { agentId: row.id, adminPaused: !row.adminPaused, reason: text }); };
    buttons.append(pauseButton);
    if (row.integrityPaused) { const clearButton = el('button', 'Clear integrity pause', 'small-button'); clearButton.type = 'button'; clearButton.onclick = () => { const text = requireReason(); if (!text) return; void act('Clear integrity pause for ' + row.symbol, '/api/admin/agents/control', { agentId: row.id, clearIntegrity: true, reason: text }); }; buttons.append(clearButton); }
    const hideButton = el('button', row.hidden ? 'Unhide' : 'Hide (moderation)', 'small-button'); hideButton.type = 'button'; hideButton.onclick = () => { const text = requireReason(); if (!text) return; void act((row.hidden ? 'Unhide ' : 'Hide ') + row.symbol, '/api/admin/agents/control', { agentId: row.id, hidden: !row.hidden, reason: text }); };
    buttons.append(hideButton);
    const influencer = influencerOf(row);
    if (influencer) { const pausedPosting = influencerPausedByAdmin(influencer), postingButton = el('button', pausedPosting ? 'Resume posting' : 'Pause posting', 'small-button'); postingButton.type = 'button'; postingButton.dataset.influencerPause = String(!pausedPosting); postingButton.onclick = () => { const text = requireReason(); if (!text) return; void act((pausedPosting ? 'Resume posting for ' : 'Pause posting for ') + row.symbol, '/api/admin/agents/control', { agentId: row.id, influencerPaused: !pausedPosting, reason: text }); }; buttons.append(postingButton); }
    if (number(row.reimbursableUsdc) > 0) { const reimburse = el('button', 'Reimburse operator (USDC)', 'small-button'); reimburse.type = 'button'; reimburse.onclick = () => { const text = requireReason(); if (!text) return; const amount = document.defaultView.prompt('USDC to move from this agent wallet to the operator wallet (max ' + row.reimbursableUsdc + '):', row.reimbursableUsdc); if (!amount) return; void act('Reimburse ' + amount + ' USDC from ' + row.symbol, '/api/admin/agents/reimburse', { agentId: row.id, amountUsdc: amount, reason: text }); }; buttons.append(reimburse); }
    card.append(buttons);
    const domains = el('p', 'Domains requested: ' + ((row.domains || []).join(', ') || 'none') + ' · approved: ' + ((row.approvedDomains || []).join(', ') || 'none'), 'help'); card.append(domains);
    if (row.objective !== undefined || row.objectiveName !== undefined || row.program !== undefined) card.append(renderProgram(row, now));
    if (influencer) card.append(renderInfluencer(row, influencer, now));
    return card;
  }
  /** The influencer block of an expanded row: state and reason, the X account, the character, caps and today's counters, the 24 h stats. Never a file, a token or a request id. */
  function renderInfluencer(row, view, now) {
    const box = el('div', null, 'admin-agent-influencer'); box.append(el('h4', 'AI influencer'));
    const line = el('p', null, 'admin-agent-influencer-state'); line.append(pill(view.stateLabel || INFLUENCER_STATE_LABELS[view.state] || view.state, INFLUENCER_TONES[view.state] ?? '', 'admin-agent-influencer-pill'), ' ', view.stateReason || (view.state === 'ready' ? 'Running within its caps.' : '')); box.append(line);
    if (influencerPausedByAdmin(view)) box.append(el('p', 'Platform pause on posting' + (view.stateReason ? ': ' + view.stateReason : '.'), 'admin-gas-warning'));
    const factsBox = el('div', null, 'admin-gas-facts'), mode = INFLUENCER_MEDIA_MODES.find(item => item.id === view.media), time = at => { const n = number(at); return n ? timeNode(document, n, { now }) : '—'; };
    const cell = (label, value) => { const item = el('div', null, 'admin-stat'); item.append(el('span', label)); const strong = el('strong'); strong.append(value); item.append(strong); return item; };
    const xCell = view.postToX ? (view.handle ? (() => { const a = el('a', '@' + view.handle); a.href = view.xUrl; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; })() : 'no account attached') : 'off';
    factsBox.append(cell('Posts to X', xCell), cell('Character', view.character ? (view.tiles || (view.source === 'reference' ? 'from reference art' : 'from tiles')) + (view.avatarUrl ? '' : ' · no portrait yet') : 'none'), cell('Media', view.character ? (mode?.name || view.media) : '—'), cell('Caps per day', [view.caps.dailyPosts != null ? view.caps.dailyPosts + ' posts' : '', view.caps.dailyImages != null ? view.caps.dailyImages + ' pictures' : '', view.caps.dailyVideos != null ? view.caps.dailyVideos + ' clips' : '', view.featureClip?.seconds ? '1 feature clip (' + view.featureClip.seconds + ' s)' : ''].filter(Boolean).join(' · ') || '—'), cell('Today', 'posts ' + view.today.posts + ' · pictures ' + view.today.images + ' · clips ' + view.today.videos + (view.featureClip?.seconds ? ' · feature clip ' + (view.today.feature ?? 0) : '')), cell('Cadence', view.cadenceHours ? 'every ' + view.cadenceHours + ' h' + (view.coinLink ? ', coin link added' : '') : '—'), cell('Next post', view.postToX ? time(view.nextPostAt) : '—'));
    const stats = row.influencerStats && typeof row.influencerStats === 'object' ? row.influencerStats : null;
    if (stats) factsBox.append(cell('Last 24 h', count(whole(stats.posts24h), 'post') + ' · ' + count(whole(stats.media24h), 'media job') + ' · ' + count(whole(stats.failures24h), 'failure')));
    box.append(factsBox);
    const posts = view.posts.slice(0, 5);
    if (posts.length) { const list = el('ul', null, 'admin-protocol-history admin-agent-posts'); for (const post of posts) { const item = el('li'); item.append(pill(post.stateLabel, post.state === 'posted' ? 'good' : ['failed', 'skipped'].includes(post.state) ? 'bad' : 'warn'), el('span', (post.kind === 'text' ? '' : (post.kind === 'video' ? 'Clip · ' : 'Picture · ')) + (post.text || '—') + (post.error && post.state !== 'posted' ? ' · ' + post.error : ''), 'admin-agent-post'), time(post.postedAt || post.at)); if (post.url) { const a = el('a', 'View ↗'); a.href = post.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; item.append(a); } list.append(item); } box.append(el('p', 'Latest posts:', 'help'), list); }
    return box;
  }
  /** One compact row: name, venue, model, objective chip, state and program pills, next run; opens to the full card with its controls. */
  function renderRow(row, now) {
    const item = el('details', null, 'admin-launch-row admin-agent-row'); item.dataset.agentRow = row.id; item.dataset.objective = objectiveKey(row);
    const summary = el('summary'), identity = el('span', null, 'admin-launch-identity'), pills = el('span', null, 'admin-launch-pills'), meta = el('span', null, 'admin-launch-meta');
    identity.append(el('strong', plain(row.name, 60) + ' · $' + plain(row.symbol, 24)), el('small', [plain(row.route, 24), 'launch ' + (plain(row.launchState, 24) || '—'), modelLabel(row.model), humanize(row.personalityPreset)].filter(Boolean).join(' · ')));
    pills.append(pill(plain(row.stateLabel, 40) || humanize(row.state), STATE_TONES[row.state] ?? ''));
    const hasObjective = row.objective !== undefined || row.objectiveName !== undefined;
    if (hasObjective) { const chip = pill(objectiveName(row), '', 'admin-agent-objective'); chip.title = 'Objective'; pills.append(chip); }
    const programState = programStatus(row.program);
    if (programState) { const chip = pill('Program ' + programState.label.toLowerCase(), programState.tone, 'admin-agent-program-pill'); chip.title = programState.reason || (programState.label === 'Active' ? 'The platform runs this objective’s program on its schedule.' : 'Program ' + programState.label.toLowerCase()); pills.append(chip); }
    const influencer = influencerOf(row);
    if (influencer) { const chip = pill('Influencer · ' + (influencer.stateLabel || influencer.state).toLowerCase(), INFLUENCER_TONES[influencer.state] ?? '', 'admin-agent-influencer-pill'); chip.title = [influencer.postToX ? (influencer.handle ? 'Posts to @' + influencer.handle : 'Posts to X (no account attached)') : 'Does not post to X', influencer.character ? 'Character ' + (influencer.tiles || 'from ' + influencer.source) : 'No character', influencer.stateReason].filter(Boolean).join(' · '); pills.append(chip); }
    if (row.integrityPaused) pills.append(pill('Integrity pause', 'bad'));
    if (row.adminPaused) pills.append(pill('Platform pause', 'bad'));
    if (row.creatorPaused) pills.append(pill('Creator pause', 'warn'));
    if (row.activeRun) pills.append(pill('Run active', 'accent'));
    if (row.hidden) pills.append(pill('Hidden'));
    if (row.archived) pills.append(pill('Archived'));
    const next = number(row.nextRunAt), last = number(row.lastActivity?.at), created = number(row.createdAt);
    meta.append(next && next > now ? timeNode(document, next, { now, prefix: 'next run ' }) : last ? timeNode(document, last, { now, prefix: 'active ' }) : created ? timeNode(document, created, { now, prefix: 'created ' }) : el('span', '—'));
    if (ADDRESS.test(row.mint || '')) meta.append(copyButton(document, row.mint, 'Copy mint address'));
    summary.append(identity, pills, meta, el('span', '⌄', 'admin-launch-expand'));
    item.append(summary, renderAgent(row, now));
    if (expanded.has(row.id)) item.open = true;
    item.addEventListener('toggle', () => { if (item.open) expanded.add(row.id); else expanded.delete(row.id); });
    return item;
  }
  function render(data) {
    if (!data || data.version !== 1) throw Error('Agent snapshot unavailable.');
    snapshot = data; element.hidden = false; loadedAt = clock(); modelsCard.hidden = !!data.disabled;
    if (data.disabled) { status.textContent = data.reason; flagsBox.replaceChildren(); solvency.replaceChildren(); agentsBox.replaceChildren(); renderModels(null); delete element.dataset.adminSummary; controls(); return; }
    const effective = data.effective || {};
    status.textContent = 'Snapshot ' + when(data.at) + ' · master switch ' + (effective.master ? 'on' : 'off') + ' · ' + (effective.dryRun ? 'DRY RUN (mock model, labelled)' : 'real mode') + ' · model ' + (effective.modelConfigured ? 'configured' : 'missing key') + ' · browser ' + (effective.browserConfigured ? 'configured' : 'not configured') + ' · worker ' + (data.worker?.ready ? 'ready' : 'not started') + ' · catalog ' + (data.registry?.refreshedAt ? when(data.registry.refreshedAt) : 'not loaded') + (data.registry?.error ? ' (' + data.registry.error + ')' : '') + (typeof effective.influencerOpen === 'boolean' ? ' · influencer ' + (effective.influencerOpen ? 'on' : 'off') + ' (X ' + (effective.xConfigured ? 'configured' : 'not configured') + ', media ' + (effective.mediaConfigured ? 'configured' : 'not configured') + ')' : '') + '.';
    flagsBox.replaceChildren();
    for (const [key, label, help] of FLAGS) { const on = data.flags?.[key] === true, button = el('button', (on ? 'Disable ' : 'Enable ') + label.toLowerCase(), 'small-button'); button.type = 'button'; button.title = help; button.onclick = () => { const text = requireReason(); if (!text) return; void act((on ? 'Disable ' : 'Enable ') + label, '/api/admin/agents/control', { flags: { [key]: !on }, reason: text }); }; const wrap = el('div', null, 'admin-gotchi-flag'); wrap.append(button, el('span', on ? 'On' : 'Off', on ? 'admin-gotchi-running' : 'admin-gotchi-paused')); flagsBox.append(wrap); }
    const s = data.solvency || {}, totals = s.totals || {}, platform = s.platform || {};
    solvency.replaceChildren(stat('Ledger audit', s.ledgerOk ? 'balanced' : 'PROBLEMS', !s.ledgerOk), stat('Provider capacity (unallocated)', platform.providerCapacityUsd), stat('Backed / reserved credit', totals.backedUsd + ' / ' + totals.reservedUsd), stat('Spent / disputed', totals.spentUsd + ' / ' + totals.disputedUsd, number(String(totals.disputedUsd).replace(/[^0-9.]/g, '')) > 0), stat('Operator receivable (USDC)', platform.operatorReceivableUsdc), stat('Provider variance (operator cost)', platform.providerVarianceUsd), stat('Treasury SOL (all agents)', totals.treasurySol), stat('Operating SOL unsettled', totals.operatingSol), stat('Settled USDC awaiting backing', totals.settledUsdc));
    alerts.replaceChildren(); for (const alert of data.alerts || []) alerts.append(el('li', when(alert.createdAt) + ' · ' + alert.scope + ' · ' + alert.code + ' · ' + alert.message)); if (!alerts.children.length) alerts.append(el('li', 'No open alerts.', 'help'));
    const p = data.pending || {}; pendingList.replaceChildren();
    for (const batch of p.settlementBatches || []) pendingList.append(el('li', 'Settlement ' + batch.id + ' · ' + batch.state + ' · ' + batch.inputSol + ' SOL' + (batch.error ? ' · ' + batch.error : '')));
    for (const row of p.unknownUsage || []) pendingList.append(el('li', 'Unknown provider cost · run ' + row.runId + ' · est. ' + row.estimatedUsd + ' · ' + when(row.createdAt)));
    for (const session of p.openBrowserSessions || []) pendingList.append(el('li', 'Browser session ' + session.id + ' open since ' + when(session.createdAt)));
    for (const action of p.openActions || []) pendingList.append(el('li', 'Action ' + action.kind + ' ' + action.state + (action.error ? ' · ' + action.error : '')));
    for (const run of p.activeRuns || []) pendingList.append(el('li', 'Run ' + run.id + ' ' + run.state + ' · lease ' + (run.leaseOwner || '—') + ' until ' + when(run.leaseExpiresAt)));
    for (const item of p.reimbursements || []) pendingList.append(el('li', 'Reimbursement ' + item.usdc + ' USDC · ' + item.state + (item.error ? ' · ' + item.error : '')));
    pending.querySelector('summary').textContent = 'Pending work · ' + pendingList.children.length; if (!pendingList.children.length) pendingList.append(el('li', 'Nothing pending.', 'help'));
    tools.replaceChildren();
    for (const [label, path, body, options] of [['Provider health check (no spend)', '/api/admin/agents/health', null, { get: true }], ['Release orphan browsers', '/api/admin/agents/health?releaseOrphans=1', { releaseOrphans: true }, {}], ['Verify agent keys', '/api/admin/agents/keys/verify', {}, {}], ['Re-encrypt key documents', '/api/admin/agents/keys/rotate', { reason: '' }, { reason: true }], ['Back up the ledger now', '/api/admin/agents/backup', {}, {}]]) {
      const button = el('button', label, 'small-button'); button.type = 'button';
      button.onclick = async () => { if (options.get) { await healthCheck(label); return; } const why = options.reason ? requireReason() : (reason.value.trim() || 'Owner operation'); if (!why) return; const result = await act(label, path, { ...body, reason: why }, { reload: false }); if (result) { health.textContent = toolSummary(path, result); if (result.catalog && typeof result.catalog === 'object' && Array.isArray(result.catalog.models)) renderModels(result.catalog); } };
      const wrap = el('div', null, 'admin-gotchi-flag'); wrap.append(button); tools.append(wrap);
    }
    batches.replaceChildren();
    for (const batch of data.providerBatches || []) { const item = el('li'); item.append(when(batch.createdAt) + ' · ' + batch.reference + ' · paid ' + batch.paid + ' USDC (fee ' + batch.purchaseFee + ') · credits ' + batch.credits + ' · remaining ' + batch.remainingUsdc + ' USDC / ' + batch.remainingUsd + ' · ' + batch.evidence + ' '); if (number(batch.remainingUsdc) > 0) { const back = el('button', 'Back settled USDC with this batch', 'small-button'); back.type = 'button'; back.onclick = () => { const text = requireReason(); if (!text) return; void act('Back settled USDC with ' + batch.reference, '/api/admin/agents/backing', { batchId: batch.id, reason: text }); }; item.append(back); } batches.append(item); }
    if (!batches.children.length) batches.append(el('li', 'No provider funding recorded yet. Agents cannot spend until settled USDC is backed by a recorded batch.', 'help'));
    renderModels(data.registry && typeof data.registry === 'object' ? data.registry : null);
    renderAgents();
    const agents = Array.isArray(data.agents) ? data.agents : [], programs = agents.filter(row => programStatus(row.program)?.label === 'Active').length, models = Array.isArray(data.registry?.models) ? data.registry.models : [];
    element.dataset.adminSummary = [count(agents.length, 'agent'), count(agents.filter(paused).length, 'paused', 'paused'), programs ? count(programs, 'program active', 'programs active') : '', models.length ? `${models.filter(model => model?.available === true).length} of ${count(models.length, 'model')} available` : ''].filter(Boolean).join(' · ');
    auditList.replaceChildren(); for (const row of data.audit || []) auditList.append(el('li', when(row.createdAt) + ' · ' + row.actor + ' · ' + row.action + ' · ' + (row.target || '') + ' · ' + (row.reason || ''))); if (!auditList.children.length) auditList.append(el('li', 'No owner actions recorded.', 'help'));
    controls();
  }
  function invalidBatch(body) {
    if (body.reference.length < 3) return ['reference', 'Enter the provider invoice or payment reference (at least 3 characters).'];
    if (body.evidence.length < 5) return ['evidence', 'Describe the evidence for this purchase (at least 5 characters).'];
    if (!decimalAmount(body.paidUsdc) || Number(body.paidUsdc) <= 0) return ['paidUsdc', 'Enter the amount paid in USDC, for example 100 or 99.50.'];
    if (!decimalAmount(body.purchaseFeeUsdc) || Number(body.purchaseFeeUsdc) > Number(body.paidUsdc)) return ['purchaseFeeUsdc', 'Enter the purchase fee included in the payment: 0 or more, and no more than the amount paid.'];
    if (!decimalAmount(body.creditsUsd) || Number(body.creditsUsd) <= 0) return ['creditsUsd', 'Enter the credits received at the provider in USD, for example 94.50.'];
    return null;
  }
  batchSave.onclick = () => { const why = requireReason(); if (!why) return; const body = { provider: 'openrouter', reference: inputs.reference.value.trim(), evidence: inputs.evidence.value.trim() || why, paidUsdc: inputs.paidUsdc.value.trim(), purchaseFeeUsdc: inputs.purchaseFeeUsdc.value.trim() || '0', creditsUsd: inputs.creditsUsd.value.trim() }; const invalid = invalidBatch(body); if (invalid) { message(invalid[1], true); inputs[invalid[0]].focus?.(); return; } void act('Record provider batch ' + body.reference, '/api/admin/agents/provider-batch', body).then(result => { if (result) for (const input of Object.values(inputs)) input.value = ''; }); };
  async function load(force = false) {
    if (!permitted()) { clear(); return; } if (!isActive()) { stop(); return; } const owner = accountIdentity(); if (viewOwner !== null && viewOwner !== owner) clear(); viewOwner = owner; active = true;
    if (document.hidden && !force) { schedule(); return; } if (loading || (busy && !force)) return; loading = true; element.hidden = false; controls(); const generation = revision; if (!snapshot) status.textContent = 'Loading agent status…';
    try { const data = await api('/api/admin/agents'); if (permittedAt(generation, owner)) render(data); }
    catch { if (permittedAt(generation, owner)) status.textContent = snapshot ? 'Agent status could not be refreshed. Showing the last snapshot.' : 'Agent status is temporarily unavailable. Use Refresh to try again.'; }
    finally { if (generation === revision) { if (!permittedAt(generation, owner)) { clear(); return; } loading = false; controls(); schedule(); } }
  }
  function pause() { active = false; stop(); }
  // Opening the page again reuses a snapshot younger than one poll interval and only restarts polling; the list state comes from the hash.
  function show() { const before = state.signature(); readState(); if (permitted() && isActive() && snapshot && viewOwner === accountIdentity() && clock() - loadedAt < POLL_MS) { active = true; if (before !== state.signature()) renderAgents(); schedule(); return; } return load(); }
  function visibility() { if (document.hidden || !isActive()) { stop(); return; } if (active && permitted()) void load(); }
  let signature = '';
  function navigated() { if (!active || !permitted() || !isActive() || !snapshot) return; const next = state.signature(); if (next === signature) return; signature = next; readState(); renderAgents(); }
  function destroy() { clear(); disposed = true; document.removeEventListener('visibilitychange', visibility); view?.removeEventListener?.('popstate', navigated); }
  refresh.onclick = () => load(true); document.addEventListener('visibilitychange', visibility); view?.addEventListener?.('popstate', navigated); clear();
  const loadWithState = force => { readState(); signature = state.signature(); return load(force); };
  return { element, load: loadWithState, show, clear, pause, destroy };
}
