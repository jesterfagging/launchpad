// The AI Agent section of a coin page: Overview, Activity, Browser, Treasury
// and Memory tabs over the public read models, live activity through
// server-sent events, "Live screenshots" for the read-only browser, creator
// controls for the owning account and non-refundable funding deposits.
import { AGENT_STATE_LABELS, AGENT_PERSONALITIES, AGENT_LIMITS, AGENT_OBJECTIVES, AGENT_OBJECTIVE_GROUPS, objectiveById, objectiveMissingCapabilities, normalizeObjectiveSettings, capabilityMask, formatUsdMicro } from './agent-catalog.mjs';
import { coinImage } from './coin-image.mjs';
import { createInfluencerCard, handleXReturn } from './influencer-ui.mjs';

const number = value => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const sol = value => { const n = number(value); return n === null ? '—' : new Intl.NumberFormat(undefined, { maximumFractionDigits: n >= 100 ? 2 : n >= 1 ? 3 : 4 }).format(n) + ' SOL'; };
const when = value => { const at = number(value); return at > 0 ? new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'; };
const ago = (value, now) => { const at = number(value); if (!(at > 0)) return '—'; const seconds = Math.max(0, Math.round((now - at) / 1000)); if (seconds < 60) return 'just now'; if (seconds < 3600) return Math.round(seconds / 60) + ' min ago'; if (seconds < 86400) return Math.round(seconds / 3600) + ' h ago'; return Math.round(seconds / 86400) + ' d ago'; };
const until = (value, now) => { const at = number(value); if (!(at > 0)) return '—'; const seconds = Math.round((at - now) / 1000); if (seconds <= 0) return 'now'; if (seconds < 3600) return 'in ' + Math.max(1, Math.round(seconds / 60)) + ' min'; if (seconds < 172800) return 'in ' + (seconds / 3600).toFixed(1) + ' h'; return 'in ' + Math.round(seconds / 86400) + ' d'; };
const exact = value => { const at = number(value); return at > 0 ? new Date(at).toLocaleString() : ''; };
const usdText = value => { const n = number(value); return n === null ? '—' : '$' + n.toLocaleString(undefined, { maximumFractionDigits: n >= 1000 ? 0 : 2 }); };
const CAPABILITY_LABELS = { buyback: 'buy-and-burn', rewards: 'holder rewards' };
const needsLabel = missing => missing.length > 1 ? 'buy-and-burn or holder rewards' : CAPABILITY_LABELS[missing[0]] || missing[0];
/** The objective's program as the coin page describes it: the fixed rule plus who runs it (the platform, never the model). */
const programNote = (program) => program.kind === 'limiter' ? 'The model proposes; this limiter decides how often a proposal may be accepted, and the policy caps each one.' : 'The platform runs this rule on its own schedule. The model cannot change it, and every program proposal passes the same policy caps and executor as the model’s own.';
/** Program status for the pill: Finished, Off (with the reason), Waiting (the last check found nothing to do) or Active. */
const programStatus = program => program.finished ? { status: 'finished', label: 'Finished', text: program.finishedReason || program.reason || 'The program finished.' } : !program.active ? { status: 'off', label: 'Off', text: program.reason || 'The program is not running.' } : /^waiting\b/i.test(program.lastNote || '') ? { status: 'waiting', label: 'Waiting', text: program.lastNote } : { status: 'active', label: 'Active', text: program.lastNote || '' };
const short = value => typeof value === 'string' && value.length > 12 ? value.slice(0, 4) + '…' + value.slice(-4) : String(value || '—');
const KINDS = { update: 'Update', run: 'Run', action: 'Treasury', fee: 'Fee', funding: 'Funding', settlement: 'Settlement', backing: 'Backing', browse: 'Browser', revision: 'Revision', state: 'Status', activated: 'Activated', live: 'Live', bound: 'Launch', admin: 'Platform', paused: 'Paused', archived: 'Archived', provisioned: 'Provisioned' };
const TABS = [['overview', 'Overview'], ['activity', 'Activity'], ['browser', 'Browser'], ['treasury', 'Treasury'], ['memory', 'Memory']];

export function createAgentView({ document, window, root, mint, fetcher = fetch, clock = Date.now, setTimer = setInterval, clearTimer = clearInterval, fundingFactory = null } = {}) {
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = String(text); if (cls) node.className = cls; return node; };
  const link = (text, href, cls) => { const node = el('a', text, cls); node.href = href; if (/^https:/.test(href)) { node.target = '_blank'; node.rel = 'noopener noreferrer'; } return node; };
  const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  if (!document.querySelector('link[href^="/agents.css"]')) { const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = '/agents.css'; document.head.append(style); }
  let detail = null, session = null, mine = null, disposed = false, tab = 'overview', events = [], eventsBefore = null, lastEventId = 0, stream = null, treasury = null, memory = null, browser = null, shotTimer = null, busy = false, message = '', funding = null, generation = 0, timer = null, lastDetailAt = 0;
  // AI influencer (v71.30): when the X callback landed this page in the connect popup, the result goes to the opener at
  // once and the popup closes; otherwise the Influencer card shows it. The card itself mounts with the overview.
  const xReturn = (() => { const back = handleXReturn({ window }); return back && !back.posted ? back : null; })();
  let influencer = null;
  root.className = 'coin-agent';
  root.innerHTML = `<div class="agent-head"><div class="agent-avatar" data-agent-avatar><span data-agent-initial>A</span><i class="agent-pulse" aria-hidden="true"></i></div><div class="agent-head-copy"><p class="eyebrow">AI AGENT</p><h2 data-agent-title>Agent</h2><p class="agent-voice" data-agent-voice hidden></p><p class="agent-state"><span class="agent-pill" data-agent-state>—</span><span data-agent-objective class="agent-pill agent-pill-objective" hidden></span><span data-agent-reason class="agent-muted"></span></p></div><nav class="agent-tabs cv-segmented" aria-label="Agent sections"></nav></div><div class="agent-body" data-agent-body></div><p class="agent-status" data-agent-message role="status"></p>`;
  const $ = selector => root.querySelector(selector);
  const nav = $('.agent-tabs'); for (const [id, label] of TABS) { const button = el('button', label); button.type = 'button'; button.dataset.agentTab = id; button.setAttribute('aria-pressed', String(id === tab)); button.onclick = () => select(id); nav.append(button); }
  async function api(path, body) {
    const response = await fetcher(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'x-control-token': session?.token || '', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json().catch(() => ({})); if (!response.ok) throw Object.assign(Error(data.error || 'The agent request failed.'), { status: response.status }); return data;
  }
  function note(text, bad = false) { message = text; const node = $('[data-agent-message]'); node.textContent = text; node.dataset.bad = String(bad); }
  function owner() { return !!detail && !!mine && mine.agents.some(agent => agent.mint === mint); }
  // Presentation only: the tab strip's sliding indicator follows the selected button (coin.css reads --tab-x / --tab-s).
  function placeIndicator() {
    const button = nav.querySelector('button[aria-pressed="true"]'), x = button?.offsetLeft, width = button?.offsetWidth;
    if (!Number.isFinite(x) || !(width > 0)) { nav.classList.remove('has-indicator'); return; }
    nav.style?.setProperty?.('--tab-x', x + 'px'); nav.style?.setProperty?.('--tab-s', (width / 100).toFixed(4)); nav.classList.add('has-indicator');
  }
  function select(next) { tab = next; for (const button of nav.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.agentTab === tab)); placeIndicator(); if (tab === 'activity' && !events.length) loadActivity(); if (tab === 'treasury') loadTreasury(); if (tab === 'memory') loadMemory(); if (tab === 'browser') loadBrowser(); render(); }
  function renderHead() {
    const avatar = $('[data-agent-avatar]'), src = coinImage(mint, detail.image);
    avatar.querySelector('img')?.remove(); $('[data-agent-initial]').textContent = (detail.symbol || 'A')[0];
    if (src) { const img = el('img'); img.src = src; img.alt = ''; img.onerror = () => img.remove(); avatar.prepend(img); }
    avatar.dataset.state = detail.state; avatar.classList.toggle('is-sleeping', ['sleeping_budget', 'paused_creator', 'paused_admin', 'paused_provider', 'paused_integrity', 'archived', 'awaiting_funding', 'awaiting_settlement'].includes(detail.state)); avatar.classList.toggle('is-running', detail.state === 'running'); avatar.classList.toggle('no-motion', reduced());
    $('[data-agent-title]').textContent = detail.name + ' · $' + detail.symbol + ' agent';
    // v71.37 moderation: the creator (and an admin) of a hidden agent sees why it is off the agents page; the public gets a 404 before this renders.
    let moderation = root.querySelector('.agent-moderation-note');
    if (detail.moderation?.hidden === true) { if (!moderation) { moderation = el('p', null, 'agent-moderation-note'); $('[data-agent-title]').insertAdjacentElement('afterend', moderation); } moderation.replaceChildren(el('strong', 'Hidden from the agents page by moderation'), ' · ' + String(detail.moderation.reason || 'no reason recorded').replace(/[.\s]+$/, '') + (detail.moderation.by ? ' · by ' + detail.moderation.by : '') + '. The coin still trades; only the agent listing is hidden.'); }
    else moderation?.remove();
    const voice = $('[data-agent-voice]'), preset = AGENT_PERSONALITIES.find(p => p.id === detail.personalityPreset), voiceText = preset?.id === 'custom' ? String(detail.personality || '').trim() : preset?.voice || '';
    voice.replaceChildren(); if (voiceText) { voice.append(el('strong', preset?.name || 'Custom'), ' · ' + voiceText); } voice.hidden = !voiceText;
    const objectivePill = $('[data-agent-objective]'); objectivePill.textContent = detail.objectiveName || objectiveById(detail.objective)?.name || ''; objectivePill.title = detail.objectiveSummary || ''; objectivePill.hidden = !objectivePill.textContent || detail.objective === 'custom' && !detail.objectiveName;
    $('[data-agent-state]').textContent = detail.stateLabel || AGENT_STATE_LABELS[detail.state] || detail.state; $('[data-agent-state]').dataset.state = detail.state;
    $('[data-agent-reason]').textContent = detail.stateReason || (detail.state === 'ready' && detail.nextRunAt ? 'Next eligible run ' + until(detail.nextRunAt, clock()) + '.' : '');
  }
  function facts(rows) { const dl = el('dl', null, 'agent-dl'); for (const [label, value, title] of rows) { const row = el('div'); const dt = el('dt', label); if (title) dt.title = title; const dd = el('dd'); if (value && typeof value === 'object' && typeof value.nodeType === 'number') dd.append(value); else dd.textContent = value ?? '—'; row.append(dt, dd); dl.append(row); } return dl; }
  function renderOverview(body) {
    const now = clock(), balances = detail.balances || {}, treasuryRow = balances.treasury || {}, operating = balances.operating || {};
    const grid = el('div', null, 'agent-grid');
    const identity = el('section', null, 'agent-panel'); identity.append(el('h3', 'Identity'));
    identity.append(el('p', detail.mission, 'agent-mission'));
    const preset = AGENT_PERSONALITIES.find(p => p.id === detail.personalityPreset), objective = objectiveById(detail.objective) || null;
    const objectiveCell = el('span'); objectiveCell.append(el('strong', detail.objectiveName || objective?.name || 'Custom')); if (detail.objectiveSummary || objective?.summary) objectiveCell.append(el('span', ' · ' + (detail.objectiveSummary || objective.summary), 'agent-muted'));
    const personalityCell = el('span'); personalityCell.append(el('strong', preset?.name || detail.personalityPreset)); const voiceLine = detail.personalityPreset === 'custom' ? detail.personality : preset?.voice; if (voiceLine) personalityCell.append(el('span', ' · ' + voiceLine, 'agent-muted'));
    identity.append(facts([['Objective', objectiveCell], ['Personality', personalityCell], ['Model', detail.model], ['Capabilities', (detail.capabilities || []).join(', ')], ['Research domains', detail.approvedDomains?.length ? detail.approvedDomains.join(', ') : (detail.domains?.length ? detail.domains.join(', ') + ' (awaiting vetting)' : 'none')], ['Venue', detail.route === 'meteora' ? 'Meteora' : detail.route === 'pump' ? 'Pump.fun' : 'Raydium'], ['Revision', 'r' + detail.revision], ['Launched', when(detail.createdAt)], ['Activated', detail.activatedAt ? when(detail.activatedAt) : 'not yet']]));
    const money = el('section', null, 'agent-panel'); money.append(el('h3', 'Funds'));
    money.append(facts([['Fees received', detail.feesSol ? sol(detail.feesSol) + ' across ' + detail.feeReceipts + ' receipt(s)' : 'none yet', 'Finalized creator-entitlement payouts credited 30/70'], ['Operating credit (backed)', operating.backedUsd, 'Spendable AI credit backed by recorded provider funding'], ['Operating reserved', operating.reservedUsd], ['Operating spent', operating.spentUsd], ['Unsettled operating SOL', sol(Number(operating.unsettledSol || 0) + Number(operating.settlingSol || 0)), 'Awaiting settlement to USDC'], ['Settled USDC awaiting backing', operating.settledUsdc + ' USDC'], ...(Number(operating.disputedUsd?.replace(/[^0-9.]/g, '') || 0) > 0 ? [['Unresolved provider cost', operating.disputedUsd]] : []), ['Treasury available', sol(treasuryRow.availableSol)], ['Treasury reserved', sol(treasuryRow.reservedSol)], ['Frozen rewards', sol(treasuryRow.frozenRewardsSol)], ['Gas reserve', sol(treasuryRow.gasReserveSol)], ['Today’s run budget', (detail.budget?.daySpentUsd || '$0.00') + ' of ' + (detail.budget?.dayBudgetUsd || '$0.00')]]));
    const run = el('section', null, 'agent-panel'); run.append(el('h3', 'Last run'));
    if (detail.lastRun) { const last = detail.lastRun; run.append(facts([['State', last.state + (last.dryRun ? ' · dry run' : '')], ['Started', when(last.startedAt)], ['Cost', last.spentUsd + (Number(last.disputedUsd?.replace(/[^0-9.]/g, '') || 0) > 0 ? ' + ' + last.disputedUsd + ' unresolved' : '') + ' (reserved ' + last.reservedUsd + ')'], ['Calls', last.modelCalls + ' model · ' + last.toolCalls + ' tools · ' + last.browserActions + ' browser'], ['Summary', last.summary || last.errorCode || '—']])); }
    else run.append(el('p', 'No runs yet. Runs start once the agent is activated and eligible.', 'agent-muted'));
    const policy = el('section', null, 'agent-panel'); policy.append(el('h3', 'Policy and custody'));
    policy.append(el('p', detail.custody, 'agent-muted'));
    policy.append(facts([['Policy', detail.policyVersion + ' · ' + short(detail.policyHash)], ['Agent wallet', link(short(detail.wallet) + ' ↗', 'https://solscan.io/account/' + detail.wallet, 'agent-link')], ['Funding', detail.funding || '']]));
    grid.append(identity); if (detail.program) grid.append(renderProgram(detail.program, now)); grid.append(money, run, policy);
    body.append(grid);
    // The Influencer card: fed by the detail's `influencer` view when the server sends one (null = the agent has none),
    // else by GET /api/launchpad/agents/influencer?mint=; the creator's controls sit inside it.
    if (detail.influencer !== null) { if (!influencer) influencer = createInfluencerCard({ document, window, mint, request: api, clock, setTimer, clearTimer, owner, xReturn }); influencer.setView(detail.influencer); body.append(influencer.element); if (detail.influencer === undefined) void influencer.refresh(); }
    else if (influencer) { influencer.destroy(); influencer = null; }
    if (owner()) body.append(renderControls()); else if (session?.authenticated === false || !session) body.append(el('p', 'Sign in with the creator account to manage this agent. Anyone signed in can fund it.', 'agent-muted'));
    const fundHost = el('section', null, 'agent-panel agent-panel-wide');
    body.append(fundHost);
    if (fundingFactory && detail.state !== 'archived') { funding?.destroy(); funding = fundingFactory({ document, window, root: fundHost, mint, fetcher, clock, onFinalized: () => refresh(true) }); funding.setSession(session); const params = new URLSearchParams(window.location.search); if (params.get('fund')) funding.preset({ purpose: params.get('fund'), amount: params.get('amount') }); }
    else fundHost.remove();
  }
  /** The Program card: the fixed rule, its status (Active / Waiting / Finished / Off with the reason), the schedule and what it has done. */
  function renderProgram(program, now) {
    const panel = el('section', null, 'agent-panel agent-program'), status = programStatus(program), limiter = program.kind === 'limiter';
    panel.dataset.status = status.status; panel.dataset.kind = program.kind;
    const head = el('div', null, 'agent-program-head'); head.append(el('h3', limiter ? 'Program limiter' : 'Program'));
    const pill = el('span', status.label, 'agent-pill agent-program-pill'); pill.dataset.status = status.status; if (status.status === 'active') { const dot = el('i', null, 'agent-program-dot'); dot.setAttribute('aria-hidden', 'true'); pill.prepend(dot); } head.append(pill);
    if (program.spends) head.append(el('span', 'Spends treasury', 'agent-pill agent-pill-spends'));
    panel.append(head, el('p', program.rule, 'agent-program-rule'));
    if (status.text) { const note = el('p', status.text, 'agent-program-note'); note.dataset.status = status.status; panel.append(note); }
    const rows = [];
    if (!program.finished && program.active) { const due = el('span', program.nextDueAt ? until(program.nextDueAt, now) : 'on the next check'); if (program.nextDueAt) due.title = exact(program.nextDueAt); rows.push(['Next due', due]); }
    if (program.lastRunAt) { const last = el('span', ago(program.lastRunAt, now)); last.title = exact(program.lastRunAt); rows.push(['Last check', last]); }
    { const last = el('span', program.lastActionAt ? ago(program.lastActionAt, now) : 'none yet'); if (program.lastActionAt) last.title = exact(program.lastActionAt); rows.push(['Last action', last]); }
    rows.push(['Actions', String(program.actions ?? 0) + (limiter ? ' accepted' : ' proposed')]);
    if (program.launchMarketCapUsd) rows.push(['Launch market cap', usdText(program.launchMarketCapUsd)]);
    panel.append(facts(rows));
    const objective = objectiveById(detail.objective), multiples = objective?.program?.multiples;
    if (Array.isArray(multiples) && multiples.length) {
      const hit = new Set((program.milestonesHit || []).map(Number)), list = el('div', null, 'agent-milestones'); list.setAttribute('aria-label', 'Milestones');
      for (const multiple of multiples) { const chip = el('span', multiple + '×' + (hit.has(multiple) ? ' reached' : ''), 'agent-pill agent-milestone'); chip.dataset.hit = String(hit.has(multiple)); list.append(chip); }
      const wrap = el('div', null, 'agent-milestones-wrap'); wrap.append(el('span', 'Milestones', 'agent-milestones-label'), list); panel.append(wrap);
    }
    panel.append(el('p', programNote(program), 'agent-muted agent-program-foot'));
    return panel;
  }
  /** The objectives a launched agent may switch to: those whose program needs are met by the capabilities chosen at launch. */
  function allowedObjectives(me) {
    const caps = me.capabilities || [], mask = capabilityMask({ buyback: caps.includes('buyback'), rewards: caps.includes('rewards') });
    return AGENT_OBJECTIVES.map(item => ({ item, missing: objectiveMissingCapabilities(item.id, mask) }));
  }
  function renderObjectiveSettings(host, item, current) {
    host.replaceChildren(); host.hidden = !item.settings.length;
    for (const setting of item.settings) {
      const label = el('label', setting.label + (setting.unit ? ' (' + setting.unit + ')' : '')), value = current && current[setting.key] !== undefined ? current[setting.key] : setting.value;
      let input;
      if (setting.options) { input = el('select'); for (const option of setting.options) { const row = el('option', option + (setting.unit ? ' ' + setting.unit : '')); row.value = String(option); input.append(row); } input.value = String(value); }
      else { input = el('input'); input.type = 'number'; input.min = String(setting.min); input.max = String(setting.max); input.step = String(setting.step); input.value = String(value); input.inputMode = 'decimal'; }
      input.name = 'agentObjective_' + setting.key; input.dataset.setting = setting.key; label.append(input);
      label.append(el('small', setting.min + '–' + setting.max + (setting.unit ? ' ' + setting.unit : '') + (setting.hint ? ' · ' + setting.hint : ''), 'agent-muted'));
      host.append(label);
    }
  }
  function renderControls() {
    const me = mine.agents.find(agent => agent.mint === mint), panel = el('section', null, 'agent-panel agent-panel-wide agent-controls'); panel.append(el('h3', 'Creator controls'));
    const form = el('form'); form.onsubmit = event => event.preventDefault();
    const presetLabel = el('label', 'Personality'), preset = el('select'); for (const row of AGENT_PERSONALITIES) { const option = el('option', row.name); option.value = row.id; preset.append(option); } preset.value = me.personalityPreset; presetLabel.append(preset);
    const customLabel = el('label', 'Custom personality'), custom = el('textarea'); custom.rows = 2; custom.maxLength = AGENT_LIMITS.personalityChars; custom.value = me.personality || ''; customLabel.append(custom); customLabel.hidden = preset.value !== 'custom'; preset.onchange = () => { customLabel.hidden = preset.value !== 'custom'; };
    const missionLabel = el('label', 'Mission'), mission = el('textarea'); mission.rows = 3; mission.maxLength = AGENT_LIMITS.missionChars; mission.value = me.mission; missionLabel.append(mission);
    const domainsLabel = el('label', 'Research domain requests (max 10)'), domains = el('input'); domains.type = 'text'; domains.value = (me.domains || []).join(', '); domainsLabel.append(domains);
    const modelLabel = el('label', 'Model'), model = el('select'); for (const id of me.models || [me.model]) { const option = el('option', id); option.value = id; model.append(option); } model.value = me.model; modelLabel.append(model);
    // Objective: only objectives whose program needs are met by the capabilities chosen at launch can be chosen; the others stay listed, disabled, with the reason.
    const objectiveLabel = el('label', 'Objective'), objective = el('select'); objective.name = 'agentObjective'; objective.dataset.agentObjective = 'true';
    const choices = allowedObjectives(me), currentObjective = objectiveById(me.objective) ? me.objective : 'custom';
    for (const group of AGENT_OBJECTIVE_GROUPS) { const optgroup = el('optgroup'); optgroup.label = group.name; for (const { item, missing } of choices.filter(row => row.item.group === group.id)) { const option = el('option', item.name + (item.program ? ' · ' + (item.program.action === 'limiter' ? 'limiter' : 'program') : '') + (missing.length ? ' · needs ' + needsLabel(missing) + ', not enabled at launch' : '')); option.value = item.id; option.disabled = missing.length > 0; optgroup.append(option); } objective.append(optgroup); }
    objective.value = currentObjective; objectiveLabel.append(objective);
    const objectiveSummary = el('p', null, 'agent-muted agent-objective-summary'), settingsHost = el('div', null, 'agent-objective-settings'); settingsHost.dataset.agentObjectiveSettings = 'true';
    const syncObjective = () => { const item = objectiveById(objective.value) || objectiveById('custom'); objectiveSummary.replaceChildren(el('strong', item.name + ': '), item.summary, el('br'), el('span', item.program ? 'What the platform will do: ' + item.program.rule + (item.id === currentObjective ? '' : ' A new objective starts its program schedule over.') : item.id === 'custom' ? 'No program: the model decides within the policy.' : 'No program: the agent researches, remembers and posts.')); renderObjectiveSettings(settingsHost, item, item.id === currentObjective ? me.objectiveSettings : null); };
    objective.onchange = syncObjective; syncObjective();
    const objectiveSettings = () => { const out = {}; for (const input of settingsHost.querySelectorAll('[data-setting]')) { const value = String(input.value ?? '').trim(); if (value !== '') out[input.dataset.setting] = Number(value); } return out; };
    const save = el('button', 'Save revision', 'small-button'); save.type = 'button';
    const pause = el('button', me.creatorPaused ? 'Resume runs' : 'Pause runs', 'small-button'); pause.type = 'button';
    save.onclick = async () => { if (busy) return; let settings; try { settings = normalizeObjectiveSettings(objective.value, objectiveSettings()); } catch (error) { note(error.message, true); return; } busy = true; note('Saving…'); try { const result = await api('/api/launchpad/agents/revise', { mint, mission: mission.value, personalityPreset: preset.value, personality: custom.value, domains: domains.value, model: model.value, objective: objective.value, objectiveSettings: settings }); if (disposed) return; const index = mine.agents.findIndex(agent => agent.mint === mint); mine.agents[index] = result; note('Revision r' + result.revision + ' saved and published to the activity feed.'); await refresh(true); } catch (error) { if (!disposed) note(error.message, true); } finally { busy = false; } };
    pause.onclick = async () => { if (busy) return; busy = true; note(me.creatorPaused ? 'Resuming…' : 'Pausing…'); try { const result = await api('/api/launchpad/agents/pause', { mint, paused: !me.creatorPaused }); if (disposed) return; const index = mine.agents.findIndex(agent => agent.mint === mint); mine.agents[index] = result; note(result.creatorPaused ? 'Paused. Fees keep accruing; signed transactions still reconcile.' : 'Resumed.'); await refresh(true); } catch (error) { if (!disposed) note(error.message, true); } finally { busy = false; } };
    const actions = el('div', null, 'agent-actions'); actions.append(save, pause);
    form.append(presetLabel, customLabel, objectiveLabel, objectiveSummary, settingsHost, missionLabel, domainsLabel, modelLabel, el('p', 'Revisions are public events. You cannot withdraw assigned funds, change the fee recipient, add financial capabilities or raise the frozen limits. An objective can only change to one whose program the capabilities chosen at launch allow.', 'agent-muted'), actions);
    panel.append(form); return panel;
  }
  function eventRow(event) {
    const row = el('article', null, 'agent-event'); row.dataset.kind = event.kind;
    const data = event.data || {}, head = el('div', null, 'agent-event-head'); head.append(el('span', KINDS[event.kind] || event.kind, 'agent-pill agent-pill-' + event.kind));
    if (data.origin === 'program') { const chip = el('span', 'Program', 'agent-pill agent-pill-program'); chip.title = 'Proposed by the ' + (objectiveById(data.objective)?.name || 'objective') + ' program the platform runs; the policy caps it like any proposal.'; head.append(chip); }
    head.append(el('strong', event.title), el('time', ago(event.at, clock()))); if (number(event.at) > 0) head.lastChild.title = exact(event.at);
    row.append(head); if (event.body) row.append(el('p', event.body));
    const links = el('div', null, 'agent-event-links');
    for (const [key, label] of [['signatureUrl', 'Receipt'], ['buySignatureUrl', 'Buy receipt'], ['burnSignatureUrl', 'Burn receipt']]) if (data[key]) links.append(link(label + ' ↗', data[key], 'agent-link'));
    if (data.stage) links.append(el('span', data.stage, 'agent-muted'));
    if (data.dryRun) links.append(el('span', 'dry run', 'agent-muted'));
    if (links.childElementCount) row.append(links);
    return row;
  }
  function renderActivity(body) {
    const list = el('div', null, 'agent-feed'); if (!events.length) list.append(el('p', 'No activity yet.', 'agent-muted'));
    for (const event of events) list.append(eventRow(event));
    body.append(list);
    if (eventsBefore) { const more = el('button', 'Load older', 'small-button'); more.type = 'button'; more.onclick = () => loadActivity(true); body.append(more); }
    body.append(el('p', stream ? 'Live · updates arrive as they happen.' : 'Refreshes periodically.', 'agent-muted'));
  }
  function renderBrowser(body) {
    const panel = el('section', null, 'agent-panel agent-panel-wide');
    if (!browser) { panel.append(el('p', 'Loading…', 'agent-muted')); body.append(panel); return; }
    panel.append(el('h3', browser.label || 'Live screenshots'));
    panel.append(el('p', browser.note, 'agent-muted'));
    panel.append(facts([['Status', !browser.available ? 'Browsing unavailable for this agent' : browser.active ? 'Session open' + (browser.host ? ' · ' + browser.host : '') : 'No session right now'], ['Approved domains', browser.approvedDomains?.length ? browser.approvedDomains.join(', ') : 'none'], ['Cadence', 'one screenshot every ' + browser.intervalSeconds + ' s while a session is open']]));
    if (browser.screenshotUrl) { const frame = el('div', null, 'agent-shot'); const img = el('img'); img.alt = 'Latest screenshot of the agent’s read-only browser'; img.src = browser.screenshotUrl + '&t=' + browser.screenshotAt; frame.append(img, el('span', 'Captured ' + ago(browser.screenshotAt, clock()) + ' · watch-only, no control', 'agent-muted')); panel.append(frame); }
    else panel.append(el('p', 'No screenshots yet. They appear while a run is browsing and expire after 7 days.', 'agent-muted'));
    body.append(panel);
  }
  function actionRow(action) {
    const row = el('article', null, 'agent-action'); row.dataset.state = action.state;
    const head = el('div', null, 'agent-event-head'); head.append(el('span', action.stateLabel, 'agent-pill agent-pill-' + action.state)); if (action.origin === 'program') { const chip = el('span', 'Program', 'agent-pill agent-pill-program'); chip.title = 'Proposed by the objective’s program, which the platform runs; the policy caps it like any proposal.'; head.append(chip); }
    head.append(el('strong', (action.kind === 'buyback_burn' ? 'Buyback & burn' : 'Holder reward') + ' · ' + (Number(action.principalSol) > 0 ? sol(action.principalSol) : 'requested ' + action.requested + ' SOL')), el('time', when(action.createdAt)));
    row.append(head, el('p', action.reason));
    if (action.evaluation && !action.evaluation.ok) row.append(el('p', 'Rejected: ' + action.evaluation.reason, 'agent-muted'));
    if (action.error) row.append(el('p', action.error, 'agent-muted'));
    if (action.outcome) { const outcome = el('p', null, 'agent-muted'); const parts = []; if (action.outcome.bought) parts.push('bought ' + action.outcome.bought + ' raw'); if (action.outcome.burned && action.outcome.burned !== '0') parts.push('burned ' + action.outcome.burned + ' raw'); if (action.outcome.paid != null) parts.push(action.outcome.paid + ' paid'); if (action.outcome.deferred) parts.push(action.outcome.deferred + ' deferred'); outcome.textContent = parts.join(' · '); row.append(outcome); }
    const legs = el('div', null, 'agent-event-links'); for (const leg of action.legs || []) { if (leg.explorerUrl) legs.append(link(leg.kind + ' ' + leg.state + ' ↗', leg.explorerUrl, 'agent-link')); else legs.append(el('span', leg.kind + ' ' + leg.state, 'agent-muted')); } if (legs.childElementCount) row.append(legs);
    return row;
  }
  function renderTreasury(body) {
    if (!treasury) { body.append(el('p', 'Loading…', 'agent-muted')); return; }
    const grid = el('div', null, 'agent-grid'), balances = treasury.balances || {}, t = balances.treasury || {};
    const bal = el('section', null, 'agent-panel'); bal.append(el('h3', 'Treasury'));
    bal.append(facts([['Available', sol(t.availableSol)], ['Reserved for actions', sol(t.reservedSol)], ['Frozen rewards', sol(t.frozenRewardsSol)], ['Gas reserve', sol(t.gasReserveSol)], ...Object.entries(t.tokensPendingBurn || {}).filter(([, raw]) => raw !== '0').map(([tokenMint, raw]) => ['Bought, burn pending', raw + ' raw ' + short(tokenMint)]), ['Capabilities', (treasury.capabilities || []).join(', ')]]));
    const caps = el('section', null, 'agent-panel'); caps.append(el('h3', 'Today’s limits'));
    caps.append(treasury.caps ? facts([['Per action', '≤ ' + sol(treasury.caps.perActionSol)], ['Per hour', '≤ ' + sol(treasury.caps.hourlySol)], ['Per UTC day', '≤ ' + sol(treasury.caps.dailySol)], ['Minimum principal', sol(treasury.caps.minimumPrincipalSol)], ['Opening baseline', sol(treasury.caps.baselineSol)], ['SOL/USD', '$' + Number(treasury.caps.solUsd).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' · ' + ago(treasury.caps.priceAt, clock())]]) : el('p', 'Limits need a fresh SOL/USD price; none is available right now, so no treasury action can execute.', 'agent-muted'));
    grid.append(bal, caps);
    const holders = el('section', null, 'agent-panel'); holders.append(el('h3', 'Holder snapshot'));
    holders.append(treasury.holders ? facts([['Holders', treasury.holders.holders], ['Top 10 share', treasury.holders.top10SharePercent + '%'], ['Top 100 share', treasury.holders.top100SharePercent + '%'], ['Snapshot', ago(treasury.holders.at, clock()) + ' · slot ' + treasury.holders.slot]]) : el('p', 'No finalized holder snapshot yet (rewards need an hour of 5-minute snapshots).', 'agent-muted'));
    const fees = el('section', null, 'agent-panel'); fees.append(el('h3', 'Fee receipts'));
    fees.append(facts([['Receipts', treasury.fees?.count ?? 0], ['Total', sol(treasury.fees?.total ? Number(treasury.fees.total) / 1e9 : 0)], ...(treasury.fees?.platform && BigInt(treasury.fees.platform) > 0n ? [['Platform share', sol(Number(treasury.fees.platform) / 1e9)]] : []), ['To operations (30%)', sol(treasury.fees?.operations ? Number(treasury.fees.operations) / 1e9 : 0)], ['To treasury (70%)', sol(treasury.fees?.treasury ? Number(treasury.fees.treasury) / 1e9 : 0)], ['Last receipt', treasury.fees?.lastAt ? ago(treasury.fees.lastAt, clock()) : '—']]));
    grid.append(holders, fees); body.append(grid);
    const actions = el('section', null, 'agent-panel agent-panel-wide'); actions.append(el('h3', 'Actions'));
    if (!treasury.actions?.length) actions.append(el('p', 'No treasury actions proposed yet. Queued, rejected, pending and completed actions appear here with their receipts.', 'agent-muted'));
    for (const action of treasury.actions || []) actions.append(actionRow(action));
    body.append(actions);
    if (treasury.cycles?.length) { const cycles = el('section', null, 'agent-panel agent-panel-wide'); cycles.append(el('h3', 'Reward cycles')); for (const cycle of treasury.cycles) cycles.append(el('p', when(cycle.createdAt) + ' · ' + sol(cycle.totalSol) + ' to ' + cycle.recipients + ' holders · ' + cycle.paid + ' paid, ' + cycle.deferred + ' deferred · ' + cycle.sampleCount + ' snapshots ' + when(cycle.windowFrom) + ' → ' + when(cycle.windowTo), 'agent-muted agent-cycle')); body.append(cycles); }
    body.append(el('p', treasury.custody, 'agent-muted'));
  }
  function renderMemory(body) {
    if (!memory) { body.append(el('p', 'Loading…', 'agent-muted')); return; }
    body.append(el('p', memory.active + ' active note(s) · ' + memory.limits.noteBytes + ' bytes each, ' + memory.limits.activeNotes + ' active max. Notes are the agent’s own structured memory; the mission, pages and notes are treated as untrusted data by the run.', 'agent-muted'));
    const list = el('div', null, 'agent-feed'); if (!memory.notes.length) list.append(el('p', 'No notes yet.', 'agent-muted'));
    for (const noteRow of memory.notes) { const row = el('article', null, 'agent-event'); const head = el('div', null, 'agent-event-head'); head.append(el('span', noteRow.kind, 'agent-pill'), el('strong', noteRow.title), el('time', ago(noteRow.at, clock()))); row.append(head, el('p', noteRow.body)); if (noteRow.sourceUrl) row.append(link('Source ↗', noteRow.sourceUrl, 'agent-link')); list.append(row); }
    body.append(list);
  }
  function render() {
    if (disposed || !detail) return;
    renderHead(); placeIndicator();
    const body = $('[data-agent-body]'); body.replaceChildren();
    if (tab === 'overview') renderOverview(body); else if (tab === 'activity') renderActivity(body); else if (tab === 'browser') renderBrowser(body); else if (tab === 'treasury') renderTreasury(body); else renderMemory(body);
    $('[data-agent-message]').textContent = message;
  }
  async function loadActivity(older = false) {
    try { const data = await api('/api/launchpad/agents/activity?mint=' + encodeURIComponent(mint) + (older && eventsBefore ? '&before=' + eventsBefore : '') + '&limit=30'); if (disposed) return; events = older ? [...events, ...data.events] : data.events; eventsBefore = data.nextBefore; lastEventId = Math.max(lastEventId, ...events.map(event => event.id), 0); if (tab === 'activity') render(); connect(); } catch (error) { if (!disposed) note(error.message, true); }
  }
  async function loadTreasury() { try { treasury = await api('/api/launchpad/agents/treasury?mint=' + encodeURIComponent(mint)); if (tab === 'treasury') render(); } catch (error) { if (!disposed) note(error.message, true); } }
  async function loadMemory() { try { memory = await api('/api/launchpad/agents/memory?mint=' + encodeURIComponent(mint)); if (tab === 'memory') render(); } catch (error) { if (!disposed) note(error.message, true); } }
  async function loadBrowser() { try { browser = await api('/api/launchpad/agents/browser?mint=' + encodeURIComponent(mint)); if (tab === 'browser') render(); window.clearTimeout(shotTimer); if (browser.active && !document.hidden) shotTimer = window.setTimeout(() => { if (tab === 'browser') loadBrowser(); }, (browser.intervalSeconds || 4) * 1000); } catch (error) { if (!disposed) note(error.message, true); } }
  function connect() {
    if (stream || disposed || typeof window.EventSource !== 'function') return;
    try { stream = new window.EventSource('/api/launchpad/agents/stream?mint=' + encodeURIComponent(mint) + '&after=' + lastEventId); } catch { stream = null; return; }
    stream.addEventListener('activity', raw => { let event; try { event = JSON.parse(raw.data); } catch { return; } if (events.some(row => row.id === event.id)) return; events.unshift(event); lastEventId = Math.max(lastEventId, event.id); if (tab === 'activity') render(); if (['run', 'action', 'fee', 'funding', 'state', 'activated'].includes(event.kind)) refresh(true); });
    stream.addEventListener('browser', raw => { try { browser = JSON.parse(raw.data); } catch { return; } if (tab === 'browser') render(); });
    stream.onerror = () => { stream?.close(); stream = null; window.setTimeout(() => { if (!disposed) connect(); }, 15000); };
  }
  async function refresh(force = false) {
    if (disposed || (!force && (document.hidden || clock() - lastDetailAt < 20000))) return;
    const version = ++generation;
    try { const data = await api('/api/launchpad/agents/agent?mint=' + encodeURIComponent(mint)); if (disposed || version !== generation) return; detail = data; lastDetailAt = clock(); if (session?.authenticated && mine === null) { try { mine = await api('/api/launchpad/agents/me'); } catch { mine = { agents: [] }; } } render(); if (!events.length) loadActivity(); }
    catch (error) {
      if (disposed) return;
      // A definitive answer (no such agent, hidden by moderation, the feature off) ends the 20 s polling instead of repeating the same
      // 404/503 for as long as the page is open; a passing failure keeps the panel's last state and is asked again on the next tick.
      if ([403, 404, 503].includes(error.status)) { clearTimer(timer); timer = null; }
      if (!detail) root.replaceChildren(el('p', error.status === 503 ? 'AI Agent mode is not enabled on this host.' : error.status === 404 ? 'This coin’s agent is not listed right now.' : error.message, 'agent-status'));
    }
  }
  timer = setTimer(() => refresh(), 20000);
  return { setSession(next) { session = next; mine = null; funding?.setSession(next); if (detail) refresh(true); }, refresh: () => refresh(true), select, get influencer() { return influencer; }, destroy() { disposed = true; clearTimer(timer); window.clearTimeout(shotTimer); stream?.close(); funding?.destroy(); influencer?.destroy(); influencer = null; }, canLeave: () => !busy && !(funding?.busy?.()) && !influencer?.busy };
}
