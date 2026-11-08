import { bootPage } from './navigation.mjs';
import { createWorkspaceShell } from './workspace-shell.js';
import { createGotchiCharacter } from './gotchi-character.mjs';
import { gotchiTheme, validGotchiId, milestoneProgress, GOTCHI_GOAL_USD, GOTCHI_MILESTONES_USD } from './gotchi-catalog.mjs';

const LIST_REFRESH_MS = 30000, DETAIL_REFRESH_MS = 30000, HOLDINGS_REFRESH_MS = 60000;
const number = value => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const money = value => { const n = number(value); return n === null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: n >= 1000 ? 0 : 2 }).format(n); };
const sol = value => { const n = number(value); return n === null ? '—' : new Intl.NumberFormat(undefined, { maximumFractionDigits: n >= 100 ? 2 : n >= 1 ? 3 : 4 }).format(n) + ' SOL'; };
const count = value => { const n = number(value); return n === null ? '—' : new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n); };
// Token amounts arrive as decimal strings already scaled by each token's decimals; group and trim them for display.
const amount = value => { const n = number(value); if (n === null || n < 0) return '—'; if (n > 0 && n < 0.000001) return '<0.000001'; return new Intl.NumberFormat(undefined, { maximumFractionDigits: n >= 1000 ? 2 : n >= 1 ? 4 : 6 }).format(n); };
const short = value => typeof value === 'string' && value.length > 12 ? value.slice(0, 4) + '…' + value.slice(-4) : String(value || '—');
const when = value => { const at = number(value); return at > 0 ? new Date(at).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'; };
const ago = (value, now) => { const at = number(value); if (!(at > 0)) return '—'; const seconds = Math.max(0, Math.round((now - at) / 1000)); if (seconds < 60) return 'just now'; if (seconds < 3600) return Math.round(seconds / 60) + ' min ago'; if (seconds < 86400) return Math.round(seconds / 3600) + ' h ago'; return Math.round(seconds / 86400) + ' d ago'; };
const duration = ms => { const n = number(ms); if (!(n > 0)) return '—'; const hours = n / 3600000; return hours < 1 ? Math.round(n / 60000) + ' min' : hours < 48 ? hours.toFixed(1) + ' h' : (hours / 24).toFixed(1) + ' days'; };
const base58 = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
const signature = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(value);
const stateLabels = { open: 'Race open', closing: 'Closing · freezing the result', frozen: 'Result frozen', buying: 'Buying the winning coin', distributing: 'Airdropping the prize', settled: 'Settled' };
const venueLabels = { raydium: 'Raydium', meteora: 'Meteora', pump: 'Pump.fun' };

// Refreshes rebuild the cards and panels, which drops keyboard focus to the page
// body. Remember the focused control and return to its rebuilt equivalent.
function focusSnapshot(document, root) { const node = document.activeElement; if (!node || node === document.body || !root.contains(node)) return null; return { node, tag: node.tagName, href: node.getAttribute('href'), text: node.textContent }; }
function restoreFocus(document, root, state) {
  if (!state) return; const active = document.activeElement; if (active && active !== document.body && active !== document.documentElement) return;
  const usable = node => node.isConnected && !node.disabled && !node.closest('[hidden]');
  let next = usable(state.node) ? state.node : null;
  if (!next) { const candidates = [...root.querySelectorAll(state.tag)].filter(usable); next = candidates.find(node => node.getAttribute('href') === state.href && node.textContent === state.text) || candidates.find(node => state.href ? node.getAttribute('href') === state.href : node.textContent === state.text) || null; }
  next?.focus?.({ preventScroll: true });
}

export function createGotchiPage({ document, window, fetcher = fetch, clock = Date.now, setTimer = setInterval, clearTimer = clearInterval, shell = createWorkspaceShell } = {}) {
  const main = document.querySelector('main'), $ = id => main.querySelector('[id="' + id + '"]');
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined && text !== null) node.textContent = String(text); if (cls) node.className = cls; return node; };
  const link = (text, href, cls) => { const node = el('a', text, cls); node.href = href; if (/^https:/.test(href)) { node.target = '_blank'; node.rel = 'noopener noreferrer'; } return node; };
  const explorer = (kind, value, text) => signature(value) || base58(value) ? link(text || short(value), 'https://solscan.io/' + kind + '/' + value, 'gotchi-link') : el('span', text || '—');
  const params = new URLSearchParams(window.location.search), requested = params.get('id') || '', detailId = validGotchiId(requested) ? requested : '';
  const controllers = new Set(), characters = new Map(); let disposed = false, timer = null, session = null, holdings = null, listData = null, detailData = null, listNext = 0, detailNext = 0, holdingsNext = 0, busy = false, lastCelebration = null, treatsSeen = 0;
  async function api(path, { token = '' } = {}) {
    const controller = new AbortController(); controllers.add(controller); const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      let response;
      // A slow or dropped request shows readable text (never "signal is aborted without reason"); the page retries on its timer.
      try { response = await fetcher(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: token ? { 'x-control-token': token } : {} }); }
      catch (e) { throw Error(controller.signal.aborted || e?.name === 'AbortError' ? 'Gotchi data is taking longer than usual to load. It will retry automatically.' : 'Gotchi data could not be reached. It will retry automatically.'); }
      const data = await response.json().catch(() => ({})); if (!response.ok) throw Object.assign(Error(data?.error || 'Gotchi data is temporarily unavailable.'), { status: response.status }); return data;
    }
    finally { window.clearTimeout(timeout); controllers.delete(controller); }
  }
  function character(key, theme, stage, size, host, options = {}) {
    let entry = characters.get(key);
    if (!entry) { entry = createGotchiCharacter({ document, window, theme, stage, size, interactive: options.interactive !== false }); characters.set(key, entry); host.replaceChildren(entry.element); }
    else { if (!host.contains(entry.element)) host.replaceChildren(entry.element); if (entry.stage !== stage) entry.setStage(stage, { animate: options.animate !== false }); }
    return entry;
  }
  function stageOf(gotchi) { return number(gotchi?.race?.stage) || milestoneProgress(gotchi?.pot?.potUsd || 0).stage; }
  function progressBar(gotchi) {
    const progress = milestoneProgress(gotchi.pot?.potUsd || 0), bar = el('div', null, 'gotchi-bar'), fill = el('span', null, 'gotchi-bar-fill'); bar.dataset.motionBar = ''; fill.style.width = progress.percentToGoal.toFixed(1) + '%'; bar.append(fill);
    for (const level of GOTCHI_MILESTONES_USD) { const tick = el('i', null, 'gotchi-bar-tick' + (progress.reached.includes(level) ? ' is-reached' : '')); tick.style.left = (level / GOTCHI_GOAL_USD * 100) + '%'; tick.title = money(level); bar.append(tick); }
    const wrap = el('div', null, 'gotchi-progress-wrap'), caption = el('div', null, 'gotchi-progress-caption');
    caption.append(el('span', gotchi.pot?.potUsd === null || gotchi.pot?.potUsd === undefined ? 'Pot value awaiting a fresh SOL price' : money(gotchi.pot.potUsd) + ' in the pot'), el('span', progress.next === null ? 'Goal reached · settling' : money(progress.next) + ' next · ' + money(GOTCHI_GOAL_USD) + ' closes the race'));
    wrap.append(bar, caption); return wrap;
  }
  function potFacts(gotchi) {
    const pot = gotchi.pot || {}, facts = el('div', null, 'gotchi-facts');
    for (const [label, value, title] of [['Prize pot', pot.potUsd === null || pot.potUsd === undefined ? '—' : money(pot.potUsd), pot.stale ? 'Waiting for a fresh SOL price' : 'Spendable SOL valued at the live SOL price'], ['Spendable', sol(pot.spendableSol), 'Realized SOL minus the gas reserve and any frozen settlement'], ['Reserved', sol(pot.reservedSol), 'Gas reserve plus funds frozen for the current settlement'], ['Coins attached', count(gotchi.attached) + (gotchi.graduated ? ' · ' + count(gotchi.graduated) + ' graduated' : ''), 'Graduated coins compete']]) { const cell = el('div', null, 'gotchi-fact'); cell.title = title; const amount = el('strong', value); if (label === 'Prize pot') amount.dataset.motionNumber = ''; cell.append(el('span', label), amount); facts.append(cell); }
    return facts;
  }
  function coinChip(coin) { const chip = link('', coin.href || '/coin?mint=' + coin.mint, 'gotchi-chip'); if (coin.image) { const img = el('img'); img.src = coin.image; img.alt = ''; img.loading = 'lazy'; chip.append(img); } chip.append(el('span', '$' + (coin.symbol || 'COIN')), el('small', coin.marketCapUsd === null || coin.marketCapUsd === undefined ? (coin.graduated ? 'Graduated' : 'On the curve') : money(coin.marketCapUsd))); return chip; }
  function renderList() {
    if (disposed || !listData) return;
    const host = $('gotchi-cards'); host.setAttribute('aria-busy', 'false');
    const now = clock(), seen = new Set();
    for (const gotchi of listData.gotchis || []) {
      const theme = gotchiTheme(gotchi.id); if (!theme) continue; seen.add(gotchi.id);
      let card = host.querySelector('[data-gotchi="' + gotchi.id + '"]');
      if (!card) { card = el('article', null, 'gotchi-card gotchi-bg-' + theme.id); card.dataset.gotchi = theme.id; for (const [key, value] of Object.entries(theme.palette)) card.style.setProperty('--gotchi-' + key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()), value); card.append(el('div', null, 'gotchi-card-sky'), el('div', null, 'gotchi-card-stage'), el('div', null, 'gotchi-card-body')); host.append(card); }
      const stage = stageOf(gotchi), entry = character('card:' + theme.id, theme, stage, 'card', card.querySelector('.gotchi-card-stage'));
      if (gotchi.celebration && gotchi.celebration.at !== lastCelebration && now - gotchi.celebration.at < 24 * 3600000) { lastCelebration = gotchi.celebration.at; entry.celebrate(); }
      const body = card.querySelector('.gotchi-card-body'); body.replaceChildren();
      const heading = el('div', null, 'gotchi-card-heading'); heading.append(el('h2', theme.name), el('span', theme.evolutions[stage - 1].title + ' · stage ' + stage, 'gotchi-pill'));
      body.append(heading, el('p', gotchi.unavailable ? 'This Gotchi is waking up. Check back shortly.' : theme.tagline, 'gotchi-card-tagline'));
      if (!gotchi.unavailable) {
        body.append(progressBar(gotchi), potFacts(gotchi));
        const race = el('p', null, 'gotchi-card-race'); race.append(el('strong', stateLabels[gotchi.race?.status] || 'Race'), el('span', gotchi.race?.startedAt ? ' · race ' + gotchi.race.index + ' started ' + ago(gotchi.race.startedAt, now) : ''));
        body.append(race);
        const chips = el('div', null, 'gotchi-chips'); if (gotchi.topCoins?.length) for (const coin of gotchi.topCoins) chips.append(coinChip(coin)); else chips.append(el('span', 'No graduated coins yet. Launch one on this team.', 'gotchi-muted')); body.append(chips);
        if (gotchi.lastRace?.winner) { const last = el('p', null, 'gotchi-muted'); last.append('Last race: ', explorer('token', gotchi.lastRace.winner.mint, short(gotchi.lastRace.winner.mint)), ' won ' + sol(gotchi.lastRace.potSol) + '.'); body.append(last); }
      }
      const actions = el('div', null, 'gotchi-card-actions');
      actions.append(link('Open ' + theme.name + ' →', '/gotchi?id=' + theme.id, 'small-button'), el('span', theme.interaction === 'treats' ? 'Pet with your cursor · feed treats on his page' : 'Tap, poke or drag to play', 'gotchi-muted'));
      body.append(actions);
    }
    for (const card of host.querySelectorAll('.gotchi-card-placeholder')) card.remove();
    for (const card of [...host.querySelectorAll('.gotchi-card')]) if (card.dataset.gotchi && !seen.has(card.dataset.gotchi)) card.remove();
    const facts = $('gotchi-intro-facts'); facts.replaceChildren();
    for (const [label, value] of [['Goal', money(listData.goalUsd || GOTCHI_GOAL_USD)], ['Evolutions', (listData.milestonesUsd || GOTCHI_MILESTONES_USD).slice(0, 2).map(money).join(' · ')], ['Winners', 'Top ' + (listData.topHolders || 10) + ' holders'], ['Split', '50% coin · 50% SOL']]) { const cell = el('div', null, 'gotchi-fact'); cell.append(el('span', label), el('strong', value)); facts.append(cell); }
    renderRules($('gotchi-rules-list'), $('gotchi-funding'), listData);
    $('gotchi-list-status').textContent = (requested && !detailId ? 'That Gotchi does not exist. Here are the three that do. ' : '') + 'Live · refreshed ' + ago(listData.at, now) + '. Pot values use the live SOL price; market caps come from the same feed as Explore.';
  }
  function renderRules(list, funding, data) {
    if (!list) return; list.replaceChildren(); for (const rule of data?.rules || []) list.append(el('li', rule));
    if (funding) { funding.replaceChildren(); for (const key of ['raydium', 'meteora', 'pump']) { const row = data?.funding?.[key]; if (!row) continue; const card = el('div', null, 'gotchi-funding-card'); card.append(el('strong', venueLabels[key] + ' launches'), el('p', row.text)); const bar = el('div', null, 'gotchi-funding-split'); for (const [label, value, cls] of [['Gotchi pot', row.potPercent, 'is-pot'], ['Launchpad protocol', row.protocolPercent, 'is-protocol'], [key === 'meteora' ? 'Meteora' : 'No venue share', row.venuePercent, 'is-venue']]) { if (!(value > 0)) continue; const part = el('span', label + ' ' + value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + '%', 'gotchi-funding-part ' + cls); part.style.flexGrow = String(Math.max(1, Math.round(value * 1000))); bar.append(part); } card.append(bar); funding.append(card); } }
  }
  function leaderboardRows(rows, { final = false, now } = {}) {
    const table = el('table', null, 'gotchi-table'), head = el('tr'); for (const title of ['#', 'Wallet', final ? 'Average held' : 'Average held so far', 'Share']) head.append(el('th', title)); table.append(head);
    const total = rows.reduce((sum, row) => sum + Number(row.averageUsd || 0), 0);
    rows.forEach((row, index) => { const tr = el('tr'); if (holdings?.wallet && row.owner === holdings.wallet) tr.className = 'is-you'; const wallet = el('td'); wallet.append(explorer('account', row.owner), ...(tr.className ? [el('span', ' you', 'gotchi-you')] : [])); const share = total > 0 ? (Number(row.averageUsd || 0) / total * 100).toFixed(1) + '%' : '—'; tr.append(el('td', String(row.rank || index + 1)), wallet, el('td', money(row.averageUsd)), el('td', share)); table.append(tr); });
    if (!rows.length) { const tr = el('tr'), td = el('td', final ? 'No eligible holders were recorded for this race.' : 'No race time recorded yet. Holders of graduated coins appear after the first 15-minute sample.'); td.colSpan = 4; tr.append(td); table.append(tr); }
    return table;
  }
  // The three forms side by side: static mini rigs of every stage, the current one lit.
  function renderEvolutions(theme, stage, data) {
    const host = $('gotchi-evolutions'); if (!host) return;
    const milestones = data.policy?.milestonesUsd || GOTCHI_MILESTONES_USD;
    if (host.dataset.theme !== theme.id) {
      host.dataset.theme = theme.id; host.replaceChildren();
      for (const evolution of theme.evolutions) {
        const item = el('div', null, 'gotchi-evolution'); item.dataset.stage = String(evolution.stage);
        const figure = el('div', null, 'gotchi-evolution-figure'); const entry = character('evolution:' + theme.id + ':' + evolution.stage, theme, evolution.stage, 'mini', figure, { interactive: false, animate: false });
        const copy = el('div', null, 'gotchi-evolution-copy'); copy.append(el('strong', evolution.title), el('span', evolution.stage === 1 ? 'From launch' : 'From $' + Number(milestones[evolution.stage - 2]).toLocaleString() + ' in the pot', 'gotchi-muted'), el('p', evolution.blurb, 'gotchi-evolution-blurb'));
        item.append(figure, copy); host.append(item);
      }
    }
    for (const item of host.children) { item.dataset.current = String(Number(item.dataset.stage) === stage); item.dataset.reached = String(Number(item.dataset.stage) <= stage); }
  }

  function renderDetail() {
    if (disposed || !detailData) return;
    const data = detailData, theme = gotchiTheme(data.id), now = clock(); if (!theme) return;
    const hero = $('gotchi-hero'); hero.className = 'gotchi-hero gotchi-bg-' + theme.id; for (const [key, value] of Object.entries(theme.palette)) hero.style.setProperty('--gotchi-' + key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()), value);
    const stage = stageOf(data), entry = character('page:' + theme.id, theme, stage, 'page', $('gotchi-hero-stage'));
    if (data.celebration && data.celebration.at !== lastCelebration && now - data.celebration.at < 24 * 3600000) { lastCelebration = data.celebration.at; entry.celebrate(); }
    document.title = 'Launchpad — ' + theme.name;
    const launchOne = $('gotchi-launch-one'); if (launchOne) launchOne.href = '/launchpad?gotchi=' + encodeURIComponent(theme.id);
    $('gotchi-detail-species').textContent = 'GOTCHI / ' + theme.species.toUpperCase(); $('gotchi-detail-name').textContent = theme.name;
    $('gotchi-detail-form').textContent = 'Stage ' + stage + ' · ' + theme.evolutions[stage - 1].title + ' — ' + theme.evolutions[stage - 1].blurb;
    $('gotchi-detail-description').textContent = theme.description;
    renderEvolutions(theme, stage, data);
    $('gotchi-pot').replaceChildren(potFacts(data)); $('gotchi-progress').replaceChildren(progressBar(data));
    const interact = $('gotchi-interact');
    if (!interact.dataset.ready) {
      interact.dataset.ready = 'true';
      if (theme.interaction === 'treats') { const feed = el('button', 'Feed a treat', 'small-button gotchi-feed'); feed.type = 'button'; const counter = el('span', '', 'gotchi-muted'); let fed = 0; try { fed = Number(window.localStorage?.getItem('gotchi-treats:' + theme.id) || 0) || 0; } catch { fed = 0; } counter.textContent = fed ? fed + ' treats so far' : 'He is hungry.'; feed.onclick = () => { const ok = characters.get('page:' + theme.id)?.feed(); if (!ok) return; fed++; counter.textContent = fed + ' treat' + (fed === 1 ? '' : 's') + ' so far'; try { window.localStorage?.setItem('gotchi-treats:' + theme.id, String(fed)); } catch { /* Treat counts are a per-browser nicety. */ } }; interact.append(feed, counter, el('span', 'Stroke him with your cursor or finger to pet him.', 'gotchi-muted')); }
      else interact.append(el('span', 'Tap, poke or drag across her visor and watch her eyes react. Double-tap for a wink.', 'gotchi-muted'));
    }
    const race = data.race || {}, settlement = race.settlement;
    $('gotchi-race-state').textContent = stateLabels[race.status] || '—'; $('gotchi-race-state').dataset.state = race.status || '';
    const raceHost = $('gotchi-race'); raceHost.replaceChildren();
    const raceFacts = el('dl', null, 'gotchi-dl');
    const facts = [['Race', '#' + (race.index || 1)], ['Started', when(race.startedAt)], ['Running for', duration(race.durationMs)], ['Samples', count(race.sampleCount) + (race.gapCount ? ' · ' + race.gapCount + ' gaps' : '')], ['Last sample', data.leaderboard?.lastSampleAt ? ago(data.leaderboard.lastSampleAt, now) : 'none yet'], ['Evolution', 'Stage ' + stage + (race.reached?.length ? ' · ' + race.reached.map(row => money(row.usd)).join(', ') + ' reached' : '')]];
    if (race.cutoffAt) facts.push(['Cutoff', when(race.cutoffAt)]); if (race.closeNote) facts.push(['Note', race.closeNote]);
    if (settlement) { facts.push(['Winning coin', settlement.winner ? short(settlement.winner.mint) + ' at ' + money(settlement.winner.marketCapUsd) : '—'], ['Pot at cutoff', sol(settlement.potSol)], ['Buying', sol(settlement.buySol) + (settlement.unspentBuySol && Number(settlement.unspentBuySol) > 0 ? ' (' + sol(settlement.unspentBuySol) + ' redirected to SOL)' : '')], ['SOL share', sol(settlement.solShareSol)], ['Bought', settlement.boughtTokens && settlement.boughtTokens !== '0' ? count(Number(settlement.boughtTokens) / 1e6) + ' tokens' : 'in progress'], ['Airdrops', (settlement.payouts ? settlement.index + ' of ' + settlement.payouts.length : '—') + ' recipients paid']); if (settlement.buyNote) facts.push(['Purchase note', settlement.buyNote]); }
    for (const [label, value] of facts) { const row = el('div'); row.append(el('dt', label), el('dd', value)); raceFacts.append(row); }
    raceHost.append(raceFacts);
    if (settlement?.winner) { const line = el('p', null, 'gotchi-muted'); line.append('Winner: ', explorer('token', settlement.winner.mint, short(settlement.winner.mint)), settlement.unvalued?.length ? ' · ' + settlement.unvalued.length + ' coin(s) had no fresh valuation at the cutoff.' : ''); raceHost.append(line); }
    const leaders = $('gotchi-leaders'); leaders.replaceChildren();
    if (settlement?.winners) { $('gotchi-leaders-note').textContent = 'Final · frozen at ' + when(settlement.frozenAt); leaders.append(leaderboardRows(settlement.winners.map((row, index) => ({ ...row, rank: index + 1 })), { final: true, now })); }
    else { const board = data.leaderboard || {}; $('gotchi-leaders-note').textContent = board.asOf ? 'Projected · ' + count(board.eligible) + ' eligible · as of ' + ago(board.asOf, now) : 'Projected'; leaders.append(leaderboardRows(board.projected || [], { now })); }
    const coins = $('gotchi-coins'); coins.replaceChildren();
    const rows = [...(data.coins || [])].sort((a, b) => Number(b.graduated) - Number(a.graduated) || (b.marketCapUsd || 0) - (a.marketCapUsd || 0) || a.mint.localeCompare(b.mint));
    if (!rows.length) coins.append(el('p', 'No coins are paired with ' + theme.name + ' yet. Choose the Gotchi option when you launch.', 'gotchi-muted'));
    else { const table = el('table', null, 'gotchi-table gotchi-coins-table'), head = el('tr'); for (const title of ['Coin', 'Venue', 'Stage', 'Market cap', 'Contributed', 'Awaiting payout']) head.append(el('th', title)); table.append(head);
      for (const coin of rows) { const tr = el('tr'), name = el('td'); name.append(coinChip(coin)); tr.append(name, el('td', venueLabels[coin.venue] || coin.venue), el('td', coin.graduated ? 'Graduated' + (coin.graduatedAt ? ' · ' + when(coin.graduatedAt) : '') : coin.stage === 'graduated' ? 'Graduated' : 'On the curve'), el('td', coin.marketCapUsd === null || coin.marketCapUsd === undefined ? '—' : money(coin.marketCapUsd)), el('td', amount(coin.contributed) + ' ' + (coin.quoteSymbol || '')), el('td', amount(coin.pending) + ' ' + (coin.quoteSymbol || ''))); if (coin.sampleError) tr.title = coin.sampleError; table.append(tr); }
      coins.append(table); }
    const ledger = $('gotchi-ledger'); ledger.replaceChildren(); const pot = data.pot || {}, dl = el('dl', null, 'gotchi-dl');
    for (const [label, value] of [['Realized SOL', sol(pot.realizedSol)], ['Spendable', sol(pot.spendableSol)], ['Gas reserve', sol(pot.gasReserveSol)], ['Frozen for settlement', sol(pot.frozenSol)], ['Received as SOL', sol(pot.receivedSol)], ['Converted to SOL', sol(pot.convertedSol)], ['Spent on winners', sol(pot.spentOnWinnerSol) + ' bought · ' + sol(pot.airdroppedSol) + ' airdropped'], ['Network fees', sol(pot.networkSpentSol)], ['Contributions', count(pot.contributions)]]) { const row = el('div'); row.append(el('dt', label), el('dd', value)); dl.append(row); }
    ledger.append(dl);
    if (pot.collected?.length) { const list = el('ul', null, 'gotchi-list-plain'); for (const asset of pot.collected) list.append(el('li', amount(asset.amount) + ' ' + (asset.symbol || short(asset.mint)) + ' awaiting conversion' + (asset.error ? ' · ' + asset.error : ''))); ledger.append(el('h3', 'Collected, not yet SOL'), list); }
    if (pot.pendingConversion) ledger.append(el('p', 'A conversion is confirming on chain.', 'gotchi-muted'));
    const unclaimed = (pot.unclaimed || []).filter(row => Number(row.pending) > 0 || Number(row.unconvertedTokens) > 0);
    if (unclaimed.length) { const list = el('ul', null, 'gotchi-list-plain'); for (const row of unclaimed) list.append(el('li', short(row.mint) + ': ' + amount(row.pending) + ' ' + row.quoteSymbol + ' awaiting payout' + (row.unconvertedTokens && Number(row.unconvertedTokens) > 0 ? ' · ' + amount(row.unconvertedTokens) + ' tax tokens awaiting conversion' : ''))); ledger.append(el('h3', 'Still inside launches'), list); }
    const history = $('gotchi-history'); history.replaceChildren();
    if (!data.history?.length) history.append(el('p', 'No race has settled yet.', 'gotchi-muted'));
    for (const row of data.history || []) { const card = el('details', null, 'gotchi-history-row'), summary = el('summary'); summary.append(el('strong', 'Race #' + row.index), el('span', ' · settled ' + when(row.settledAt) + ' · pot ' + sol(row.potSol) + ' · winner '), explorer('token', row.winner?.mint, short(row.winner?.mint))); card.append(summary);
      const facts = el('dl', null, 'gotchi-dl'); for (const [label, value] of [['Cutoff', when(row.cutoffAt)], ['Duration', duration(row.durationMs)], ['Bought', sol(row.buySol) + ' → ' + (row.boughtTokens ? count(Number(row.boughtTokens) / 1e6) + ' tokens' : '—')], ['SOL airdropped', sol(row.solShareSol) + (Number(row.unspentBuySol) > 0 ? ' + ' + sol(row.unspentBuySol) + ' unspent purchase budget' : '')], ['Recipients', count(row.payouts?.length)], ['Carried forward', sol(row.carrySol)], ['Samples', count(row.sampleCount)]]) { const line = el('div'); line.append(el('dt', label), el('dd', value)); facts.append(line); }
      card.append(facts);
      if (row.payouts?.length) card.append(leaderboardRows(row.winners.map((winner, index) => ({ ...winner, rank: index + 1 })), { final: true, now }));
      const tx = el('p', null, 'gotchi-muted'); for (const buy of row.buys || []) tx.append(explorer('tx', buy.signature, 'buy ↗'), ' '); for (const drop of row.airdrops || []) tx.append(explorer('tx', drop.signature, 'airdrop ↗'), ' '); if (tx.childNodes.length) card.append(tx);
      history.append(card); }
    renderRules($('gotchi-detail-rules'), $('gotchi-detail-funding'), data);
    renderMine();
    $('gotchi-detail-status').textContent = (data.error ? 'Service note: ' + data.error + ' · ' : '') + 'Refreshed ' + ago(data.at, now) + '. Settlement runs automatically when the pot reaches ' + money(data.policy?.goalUsd || GOTCHI_GOAL_USD) + '.';
  }
  function renderMine() {
    const standings = $('gotchi-standings'), mine = $('gotchi-mine');
    if (!holdings || !holdings.wallet) { if (standings) standings.hidden = true; if (mine) mine.hidden = true; return; }
    const now = clock();
    if (detailId && mine) { const row = holdings.gotchis.find(item => item.id === detailId); mine.hidden = !row; if (row) { $('gotchi-mine-note').textContent = short(holdings.wallet); const body = $('gotchi-mine-body'); body.replaceChildren(); if (row.settling) body.append(el('p', 'The current race is settling. Standings reopen with the next race.', 'gotchi-muted')); else { const dl = el('dl', null, 'gotchi-dl'); for (const [label, value] of [['Projected rank', row.rank ? '#' + row.rank + (row.inTop ? ' · in the top 10' : '') : 'Not ranked yet'], ['Average held', money(row.averageUsd)], ['Share of the top 10', row.shareOfTopPercent === null || row.shareOfTopPercent === undefined ? '—' : row.shareOfTopPercent + '%'], ['Eligible holders', count(row.eligible)]]) { const line = el('div'); line.append(el('dt', label), el('dd', value)); dl.append(line); } body.append(dl); if (row.holdings?.length) { const list = el('ul', null, 'gotchi-list-plain'); for (const holding of row.holdings) list.append(el('li', amount(holding.amount) + ' $' + (holding.symbol || short(holding.mint)) + ' · sampled ' + ago(holding.sampledAt, now))); body.append(list); } else body.append(el('p', 'No sampled holdings of graduated coins yet.', 'gotchi-muted')); } } }
    if (!detailId && standings) { standings.hidden = false; $('gotchi-standings-note').textContent = short(holdings.wallet); const body = $('gotchi-standings-body'); body.replaceChildren(); const grid = el('div', null, 'gotchi-standings-grid');
      // A podium: the best-ranked Gotchi stands tallest in the middle (places 2 and 3 flank it; unranked ones stay flat).
      const standing = holdings.gotchis.map((row, index) => ({ row, index, order: row.settling || !row.rank ? Infinity : Number(row.rank) })).sort((a, b) => a.order - b.order || a.index - b.index);
      standing.forEach(({ row, order }, place) => { const card = el('div', null, 'gotchi-standing'); card.dataset.place = String(place + 1); card.dataset.ranked = String(Number.isFinite(order)); card.append(el('strong', row.name), el('span', row.settling ? 'Settling' : row.rank ? '#' + row.rank : 'Not ranked yet', 'gotchi-standing-rank'), el('span', (row.rank && !row.settling ? (row.inTop ? 'In the top 10 · ' : '') : '') + money(row.averageUsd) + ' average held'), link('Open →', '/gotchi?id=' + row.id, 'gotchi-link')); grid.append(card); });
      body.append(grid); }
  }
  async function refreshList(force = false) { if (disposed || busy || detailId || (!force && (document.hidden || clock() < listNext))) return; busy = true; listNext = clock() + LIST_REFRESH_MS; try { listData = await api('/api/gotchi'); if (!disposed) { const focus = focusSnapshot(document, main); renderList(); restoreFocus(document, main, focus); } } catch (error) { if (!disposed) $('gotchi-list-status').textContent = error.message; } finally { busy = false; } }
  async function refreshDetail(force = false) { if (disposed || busy || !detailId || (!force && (document.hidden || clock() < detailNext))) return; busy = true; detailNext = clock() + DETAIL_REFRESH_MS; try { detailData = await api('/api/gotchi/detail?id=' + encodeURIComponent(detailId)); if (!disposed) { const focus = focusSnapshot(document, main); renderDetail(); restoreFocus(document, main, focus); } } catch (error) { if (!disposed) $('gotchi-detail-status').textContent = error.status === 404 ? 'This Gotchi was not found.' : error.message; } finally { busy = false; } }
  async function refreshHoldings(force = false) { if (disposed || !session?.authenticated || !session?.token || (!force && (document.hidden || clock() < holdingsNext))) return; holdingsNext = clock() + HOLDINGS_REFRESH_MS; try { holdings = await api('/api/launchpad/gotchi/holdings', { token: session.token }); if (!disposed) { const focus = focusSnapshot(document, main); renderMine(); restoreFocus(document, main, focus); } } catch { /* Standings are optional; the public race stays visible. */ } }
  function setSession(next) { session = next || null; if (!session?.authenticated) { holdings = null; renderMine(); return; } holdingsNext = 0; void refreshHoldings(true); }
  function tick() { return Promise.all([refreshList(), refreshDetail(), refreshHoldings()]); }
  const visibility = () => { if (!document.hidden) tick(); };
  $('gotchi-list').hidden = !!detailId; $('gotchi-detail').hidden = !detailId;
  if (requested && !detailId) $('gotchi-list-status').textContent = 'That Gotchi does not exist. Here are the three that do.';
  shell({ chain: 'solana', page: 'gotchi' }); document.addEventListener('visibilitychange', visibility); timer = setTimer(tick, 1000);
  const ready = tick();
  function destroy() { if (disposed) return; disposed = true; clearTimer(timer); for (const controller of controllers) controller.abort(); controllers.clear(); for (const entry of characters.values()) entry.destroy(); characters.clear(); document.removeEventListener('visibilitychange', visibility); }
  return { ready, refresh: () => tick(), setSession, destroy, canLeave: () => true };
}
export function mountPage({ document = globalThis.document, window = document.defaultView } = {}) {
  const page = createGotchiPage({ document, window, shell: createWorkspaceShell });
  let sessionUpdated = false, disposed = false; const controller = new AbortController();
  const update = event => { sessionUpdated = true; if (!disposed) page.setSession(event.detail); };
  document.addEventListener('curve-account-updated', update);
  fetch('/api/session', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal }).then(response => response.ok ? response.json() : { authenticated: false }).then(session => { if (disposed || sessionUpdated) return; page.setSession(session); createWorkspaceShell({ page: 'gotchi', session }); }).catch(() => {});
  return { ...page, destroy() { disposed = true; controller.abort(); document.removeEventListener('curve-account-updated', update); page.destroy(); } };
}
bootPage('gotchi', mountPage);
