// Owner view of Pump.fun launches: rollout flags, worker health, every launch's
// lifecycle dimensions, Launchpad wallets and balances by role, open operations,
// strategy state, holder payouts and the owner actions the server allows (pay a Holders coin's holders now,
// pause, resume or retire a strategy (then return its SOL to the funding wallet), refund a funded launch before
// creation, release a stuck SOL refund, hide, archive a finished failure, and an LP withdrawal that stays in the
// coin's strategy wallet). Launches are listed 25 at a time as compact rows (filter by text or state) that expand
// to the full card. Stored key values are never returned by the API; this view can only ask the server to verify them.
import { PAGE_SIZE, copyButton, exactTime, filterBar, hashState, pager, relativeTime } from './admin-list-kit.mjs';
const POLL_MS = 30000;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;
const FLAG_HELP = Object.freeze({
  intake: 'Lets creators quote and fund new Pump.fun launches. Off stops new quotes; funded launches still finish or refund.',
  pairs: 'Offers Pump.fun’s pairs other than SOL to everyone. While off, only you (the platform owner) see and can launch on them; run the read-only pair checks first.',
  collection: 'Distributes accrued creator fees to each coin’s fee-sharing recipients (every 15 minutes, and before each holder payout).',
  routing: 'Sweeps received fees to the treasury, Gotchi pots and agent wallets.',
  holders: 'Pays Holders coins’ rewards in each coin’s pair asset: automatically once the holders’ share is worth about $100, or when you use Pay holders now or Sell & distribute all.',
  strategies: 'Lets Market Maker and Liquidity Manager bots trade and add liquidity.',
});
// Button wording per flag ("Enable …" / "Disable …"); proper nouns keep their case.
const FLAG_ACTION = Object.freeze({ intake: 'new launches', pairs: 'pairs other than SOL', collection: 'creator-fee collection', routing: 'sweeps', holders: 'holder reward payouts', strategies: 'Market Maker and Liquidity Manager trading' });
const when = value => Number.isSafeInteger(value) && value > 0 ? exactTime(value) : '—';
// Ledger roles (src/pump-classic: roleOf and the fee-sharing shareholders) by name.
const ROLE_LABELS = Object.freeze({ protocol: 'Platform share', platform: 'Platform share', developer: 'Creator', creator: 'Creator', rewards: 'Holder rewards', holders: 'Holder rewards', gotchi: 'Gotchi pot', agent: 'Agent wallet', strategy: 'Strategy wallet' });
const roleLabel = role => ROLE_LABELS[role] || (typeof role === 'string' && role ? role[0].toUpperCase() + role.slice(1).replace(/[_-]+/g, ' ') : 'Other');
// Pump.fun coins have 6 decimals (src/pump-classic/effects.mjs TOKEN_DECIMALS); raw strategy token units shown as whole coins.
const COIN_DECIMALS = 6;
const coinAmount = raw => { if (typeof raw !== 'string' || !/^\d{1,40}$/.test(raw)) return null; const value = BigInt(raw), scale = 10n ** BigInt(COIN_DECIMALS), fraction = (value % scale).toString().padStart(COIN_DECIMALS, '0').replace(/0+$/, ''); return (value / scale).toLocaleString('en-US') + (fraction ? '.' + fraction : ''); };
const grouped = raw => typeof raw === 'string' && /^\d{1,40}$/.test(raw) ? BigInt(raw).toLocaleString('en-US') : null;
const STATE_CHIPS = Object.freeze([['', 'All'], ['attention', 'Needs attention'], ['created', 'Live'], ['funded', 'Funded'], ['failed', 'Failed'], ['refunding', 'Refunding'], ['refunded', 'Refunded'], ['archived', 'Archived']]);
const TONES = Object.freeze({ created: 'good', failed: 'bad', refunding: 'warn', funded: 'warn', creating: 'warn', funding_pending: 'warn', awaiting_funding: '', refunded: '', cancelled: '', expired: '' });
const text = (value, max = 120) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max) : '';
const page = value => { const n = Number(value); return Number.isSafeInteger(n) && n > 1 ? n : 1; };
/** What needs the owner on a launch (the server sends `attention`; older responses are read the same way here). */
function attentionOf(row) {
  if (Array.isArray(row.attention)) return row.attention.filter(item => item && typeof item.text === 'string').map(item => ({ code: text(item.code, 24), text: text(item.text, 60) }));
  const items = [];
  if (row.dimensions?.refund === 'pending' || row.pairRefund === 'pending' || row.pairRefund === 'released') items.push({ code: 'refund', text: 'Refund waiting' });
  if (row.strategy?.status === 'paused') items.push({ code: 'strategy-paused', text: 'Strategy paused' });
  if (row.holderPayout?.last?.state === 'blocked' && !row.holderPayout.open) items.push({ code: 'payout-blocked', text: 'Holder payout blocked' });
  if (row.state === 'failed' && row.dimensions?.refund !== 'pending') items.push({ code: 'failed', text: 'Failed' });
  return items;
}

export function createAdminPumpClassic({ document, api, security, message = () => {}, getAccount, isActive = () => true, setTimer = setInterval, clearTimer = clearInterval, clock = Date.now, pageSize = PAGE_SIZE } = {}) {
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = String(text); if (cls) node.className = cls; return node; };
  const link = (text, href) => { const a = el('a', text); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; };
  const view = document.defaultView || null;
  // A long address keeps its full text (copy, search, screen readers) and gives way in the middle when space runs out.
  const address = (node, value) => { node.replaceChildren(el('span', value.slice(0, -6)), el('span', value.slice(-6))); node.classList.add('admin-address'); node.setAttribute('title', value); return node; };
  const element = el('section', null, 'admin-card admin-pump-classic'); element.id = 'admin-pump-classic';
  const heading = el('div', null, 'admin-card-heading'), copy = el('div'), refresh = el('button', 'Refresh', 'text-button'); refresh.type = 'button'; refresh.id = 'admin-pump-classic-refresh';
  copy.append(el('p', 'LAUNCH OPERATIONS / PUMP.FUN', 'eyebrow'), el('h2', 'Pump.fun launches'), el('p', 'Native Pump.fun coins created by Launchpad: rollout flags, worker health, wallets and strategies. Keys never leave the server; this view only verifies them.'));
  heading.append(copy, refresh);
  const status = el('p', '', 'admin-revenue-status'); status.id = 'admin-pump-classic-status'; status.setAttribute('role', 'status');
  const reasonLabel = el('label', 'Reason for the next change', 'admin-protocol-wide'), reason = el('input'); reason.id = 'admin-pump-classic-reason'; reason.minLength = 5; reason.maxLength = 500; reason.placeholder = 'Recorded with every flag change and launch action'; reasonLabel.append(reason);
  const flagsBox = el('div', null, 'admin-gotchi-flags'); flagsBox.id = 'admin-pump-classic-flags';
  const tools = el('div', null, 'admin-gotchi-flags'); tools.id = 'admin-pump-classic-tools';
  const result = el('p', '', 'help'); result.id = 'admin-pump-classic-result';
  const listHead = el('div', null, 'admin-list-head'), listTitle = el('h3', 'Launches');
  const filter = filterBar(document, { placeholder: 'Find a launch: coin, ticker, mint, account or reason', label: 'Find a Pump.fun launch', chips: STATE_CHIPS.map(([key, label]) => ({ key, label })), onChange: ({ q, chip, source }) => { query.search = q; query.state = chip; if (source !== 'input' || q !== lastSearch) query.offset = 0; lastSearch = q; writeState(); void load(true); } });
  filter.input.id = 'admin-pump-classic-search'; filter.element.classList.add('admin-sticky-tools');
  listHead.append(listTitle);
  const launchesBox = el('div', null, 'admin-launch-rows'); launchesBox.id = 'admin-pump-classic-launches';
  const pages = pager(document, { label: 'launches', onPage: offset => { query.offset = offset; writeState({ push: true }); void load(true); } });
  element.append(heading, status, reasonLabel, el('h3', 'Rollout flags'), flagsBox, el('h3', 'Operations'), tools, result, listHead, filter.element, launchesBox, pages.element);
  let snapshot = null, revision = 0, disposed = false, loading = false, busy = false, active = false, timer = null, viewOwner = null, loadedAt = 0, lastSearch = '';
  const query = { search: '', state: '', offset: 0 }, state = hashState(view, { prefix: 'pump' }), expanded = new Set();
  const accountIdentity = () => getAccount()?.id ?? getAccount();
  const permitted = () => !disposed && getAccount()?.role === 'admin' && getAccount()?.mfaEnabled === true;
  const permittedAt = (generation, owner) => permitted() && revision === generation && accountIdentity() === owner;
  function stop() { if (timer !== null) { clearTimer(timer); timer = null; } }
  function schedule() { stop(); if (active && permitted() && isActive() && !document.hidden && !busy) timer = setTimer(() => { if (permitted() && isActive() && !document.hidden) void load(); else stop(); }, POLL_MS); }
  function controls() { const disabled = !permitted() || !snapshot || loading || busy || snapshot?.available === false; refresh.disabled = !permitted() || loading || busy; reason.disabled = disabled; filter.input.disabled = disabled; for (const button of element.querySelectorAll('button:not(#admin-pump-classic-refresh):not(.admin-copy):not([data-page]):not([data-chip])')) button.disabled = disabled; }
  function clear() { revision++; stop(); snapshot = null; viewOwner = null; loadedAt = 0; loading = false; busy = false; active = false; element.hidden = true; status.textContent = ''; flagsBox.replaceChildren(); tools.replaceChildren(); launchesBox.replaceChildren(); pages.update({ total: 0 }); result.textContent = ''; reason.value = ''; expanded.clear(); filter.cancel(); delete element.dataset.adminSummary; controls(); }
  function requireReason() { const text = reason.value.trim(); if (text.length < 5 || text.length > 500) { message('Enter a reason from 5 to 500 characters.', true); return null; } return text; }
  function readState() { query.search = state.get('q'); query.state = state.get('state'); query.offset = (page(state.get('page')) - 1) * pageSize; lastSearch = query.search; filter.set({ q: query.search, chip: query.state }); }
  function writeState(options) { state.set({ q: query.search, state: query.state, page: query.offset ? Math.floor(query.offset / pageSize) + 1 : 0 }, options); }
  const params = () => { const p = new URLSearchParams(); p.set('offset', String(query.offset)); p.set('limit', String(pageSize)); if (query.search) p.set('search', query.search); if (query.state && query.state !== 'archived') p.set('state', query.state); if (query.state === 'archived') p.set('archived', '1'); return p.toString(); };
  async function act(label, path, body, { reload = true } = {}) {
    if (viewOwner !== accountIdentity()) { clear(); return null; } if (!permitted() || element.hidden || !isActive()) return null;
    const generation = revision, owner = accountIdentity(); busy = true; stop(); controls();
    try {
      const credentials = await security.authorize(label, { requireCode: true }); if (!permittedAt(generation, owner) || !isActive()) return null;
      const value = await api(path, { ...body, ...credentials }); if (!permittedAt(generation, owner)) return null;
      message(label + ' done.'); if (value?.launches && value.available !== false) render(value); else if (reload) await load(true); return value;
    } catch (error) { if (permittedAt(generation, owner) && error?.message !== 'Cancelled.') message(error?.message || 'The request could not be confirmed. Refresh before trying again.', true); return null; }
    finally { if (generation === revision) { if (!permittedAt(generation, owner)) { clear(); return; } busy = false; controls(); schedule(); } }
  }
  function stat(label, value, warn = false) { const item = el('div', null, 'admin-stat'); item.append(el('span', label), el('strong', value)); if (warn) item.classList.add('admin-gas-warning'); return item; }
  // The coin and every launch wallet: label above, address underneath, each opening in the explorer.
  function wallets(row) {
    const list = el('dl', null, 'admin-wallets'), add = (label, ...nodes) => { const item = el('div'), value = el('dd'); value.append(...nodes); item.append(el('dt', label), value); list.append(item); };
    if (ADDRESS.test(row.mint || '')) add('Coin', address(link(row.mint, '/coin?mint=' + row.mint), row.mint), link('pump.fun ↗', 'https://pump.fun/coin/' + row.mint));
    for (const [label, value] of [['Developer (funding, dev-buy delivery)', row.developerWallet], ['Launch wallet (creator, payer)', row.launchWallet], ['Platform receipt wallet', row.protocolWallet], ['Option wallet', row.modeWallet], ['Fee-sharing recipient', row.recipient]]) add(label, ADDRESS.test(value || '') ? address(link(value, 'https://solscan.io/account/' + value), value) : '—');
    return list;
  }
  const pill = (label, tone = '') => el('span', label, 'cv-pill' + (tone ? ' is-' + tone : ''));
  /** The full card (every fact, wallet, balance and owner action), as before; it sits inside a row that opens on demand. */
  function renderLaunch(row) {
    const card = el('div', null, 'admin-gotchi-card'); card.dataset.launch = row.id;
    const head = el('div', null, 'admin-card-heading'), title = el('div');
    const pair = typeof row.pair?.symbol === 'string' && row.pair.symbol ? row.pair.symbol : 'SOL', unit = typeof row.feeUnit === 'string' && row.feeUnit ? row.feeUnit : 'SOL';
    title.append(el('h3', row.name + ' · $' + row.symbol), el('p', (row.modeLabel || row.mode) + ' · paired with ' + pair + (row.pair?.kind && row.pair.kind !== 'sol' ? ' (' + row.pair.kind + ')' : '') + (Number(row.creatorFeeBps) > 0 ? ' · creator fee ' + (Number(row.creatorFeeBps) / 100) + '%' : '') + ' · ' + (row.stateLabel || row.state) + (row.reason ? ' · ' + row.reason : '') + (row.hidden ? ' · hidden' : '') + (row.archived ? ' · archived' : ''), 'help'));
    head.append(title); card.append(head);
    const dims = row.dimensions || {};
    const facts = el('div', null, 'admin-gas-facts');
    for (const [label, value, warn] of [['Delivery', dims.delivery || '—'], ['Fee sharing', dims.fees || '—', dims.fees === 'mismatch'], ['Venue', dims.venue || '—'], ['Refund', dims.refund || '—'], ...(row.pairRefund ? [[pair + ' refund', row.pairRefund]] : []), ...(row.fundedPair ? [['Funded ' + pair, row.fundedPair]] : []), ['Policy', row.policyVersion || '—'], ['Create attempts', String(row.createAttempts ?? 0)]]) facts.append(stat(label, value, warn));
    card.append(facts);
    card.append(wallets(row));
    const balances = el('div', null, 'admin-gas-facts');
    for (const [role, b] of Object.entries(row.balances || {})) balances.append(stat(roleLabel(role) + ' · SOL credited / debited / costs', b.credited + ' / ' + b.debited + ' / ' + b.costs + ' SOL'));
    for (const [role, total] of Object.entries(row.feeTotals || {})) balances.append(stat('Distributed · ' + roleLabel(role), total + ' ' + unit));
    for (const [role, b] of Object.entries(row.pairBalances || {})) balances.append(role === 'rewards' && b.paid !== undefined ? stat(roleLabel(role) + ' · ' + unit + ' received / sold for costs / paid to holders / held', b.credited + ' / ' + b.converted + ' / ' + b.paid + ' / ' + b.held + ' ' + unit) : stat(roleLabel(role) + ' · ' + unit + ' received / converted / held', b.credited + ' / ' + b.converted + ' / ' + b.held + ' ' + unit));
    if (balances.children.length) card.append(balances);
    const payout = row.holderPayout;
    if (payout && typeof payout === 'object') {
      const box = el('div', null, 'admin-gas-facts'), asset = typeof payout.asset === 'string' ? payout.asset.slice(0, 24) : unit;
      const stage = { collect: 'collecting creator fees', freeze: 'preparing', pay: 'paying holders' }[payout.open?.stage] || 'checking';
      box.append(stat('Holder payouts', payout.open ? (payout.open.source === 'admin' ? 'Requested · ' : 'Automatic · ') + stage : 'Idle'), stat('Ready to pay', (payout.held || '0') + ' ' + asset), stat('Automatic at', '$' + Number(payout.thresholdUsd || 100).toLocaleString('en-US')));
      if (payout.last) box.append(stat('Last payout', when(payout.last.at) + ' · ' + (payout.last.state === 'completed' ? (payout.last.paid || '0') + ' ' + (payout.last.asset || asset) + ' to ' + (payout.last.recipients || 0) + ' holders' : payout.last.state), payout.last.state === 'blocked'));
      card.append(box);
      const note = payout.open?.note || (payout.last && payout.last.state !== 'completed' ? payout.last.reason : '');
      if (note) card.append(el('p', note, payout.last?.state === 'blocked' && !payout.open ? 'admin-gas-warning' : 'help'));
    }
    if (row.conversions?.length) { const list = el('ul', null, 'admin-protocol-history'); for (const c of row.conversions) { const item = el('li', roleLabel(c.role) + ' · ' + c.input + ' ' + unit + ' → ' + c.outputSol + ' SOL · ' + c.state + ' '); if (SIGNATURE.test(c.signature || '')) item.append(link('tx ↗', 'https://solscan.io/tx/' + c.signature)); list.append(item); } card.append(el('h4', 'Conversions to SOL'), list); }
    const s = row.strategy;
    if (s) {
      const box = el('div', null, 'admin-gas-facts');
      for (const [label, value] of [['Strategy', (s.label || s.kind) + ' · ' + (s.statusLabel || s.status)], ['Cash', s.cashSol + ' SOL'], ['Tokens', coinAmount(s.tokens) === null ? '—' : coinAmount(s.tokens) + ' ' + row.symbol], ['LP tokens (raw units)', grouped(s.lp) ?? '—'], ['Contributed', s.contributedSol + ' SOL'], ['Value / result', s.equitySol + ' / ' + s.resultSol + ' SOL'], ['Fees spent', s.feesSpentSol + ' SOL'], ['Last action', when(s.lastActionAt)]]) box.append(stat(label, value));
      card.append(box);
      if (s.pauseReason) card.append(el('p', 'Paused: ' + s.pauseReason, 'admin-gas-warning'));
    }
    if (row.openOperations?.length) { const list = el('ul', null, 'admin-protocol-history'); for (const op of row.openOperations) { const item = el('li', op.kind + ' · ' + op.state + ' · attempts ' + (op.attempts ?? 0) + (op.error ? ' · ' + op.error : '') + ' '); if (SIGNATURE.test(op.signature || '')) item.append(link('tx ↗', 'https://solscan.io/tx/' + op.signature)); list.append(item); } card.append(el('h4', 'Open operations'), list); }
    if (row.events?.length) { const details = el('details', null, 'admin-protocol-gas'), list = el('ul', null, 'admin-protocol-history'); details.append(el('summary', 'Recent events · ' + row.events.length)); for (const e of row.events) { const item = el('li', when(e.at) + ' · ' + e.title + (e.body ? ' · ' + e.body : '') + ' '); if (SIGNATURE.test(e.signature || '')) item.append(link('tx ↗', 'https://solscan.io/tx/' + e.signature)); list.append(item); } details.append(list); card.append(details); }
    const buttons = el('div', null, 'admin-gotchi-flags'), button = (label, action, extra = {}) => { const b = el('button', label, 'small-button'); b.type = 'button'; b.onclick = () => { const text = requireReason(); if (!text) return; void act(label + ' · ' + row.symbol, '/api/admin/pump-classic/control', { launchId: row.id, action, reason: text, ...(typeof extra === 'function' ? extra() : extra) }); }; buttons.append(b); return b; };
    if (s) {
      if (s.status !== 'retired' && s.status !== 'paused') button('Pause strategy', 'pause-strategy');
      if (s.status === 'paused') button('Resume strategy', 'resume-strategy');
      if (s.status !== 'retired') button('Retire strategy', 'retire-strategy');
      // A retired strategy's SOL can go back to the coin's funding wallet (its tokens and LP stay; 0.001 SOL stays as the wallet's reserve).
      if (s.status === 'retired') button('Return strategy SOL to the funding wallet', 'withdraw-strategy-sol');
      if (row.mode === 'lp_manager' && s.lp && s.lp !== '0') { const b = el('button', 'Withdraw LP to the strategy wallet', 'small-button'); b.type = 'button'; b.onclick = () => { const text = requireReason(); if (!text) return; const amount = document.defaultView.prompt('LP tokens (raw units) to withdraw, up to ' + s.lp + '. Proceeds stay in this coin’s strategy wallet.', s.lp); if (!amount) return; void act('Withdraw LP · ' + row.symbol, '/api/admin/pump-classic/control', { launchId: row.id, action: 'lp-withdraw', lpAmount: amount.trim(), reason: text }); }; buttons.append(b); }
    }
    // Collects this coin's creator fees and pays its holders in the pair asset now (the $100 trigger is waived).
    // Holders, Diamond Hands, a failed Earned coin and an Insured coin refunding or paying its bonus can be paid now (the server says which, v71.35).
    if ((row.paysHolders === true || row.paysHolders === undefined && row.mode === 'holders') && row.state === 'created' && !row.holderPayout?.open) button('Pay holders now', 'pay-holders');
    if (row.state === 'funded') button('Refund before creation', 'refund');
    // The pair asset could not be returned (for example an issuer froze or paused it): refund the SOL now and keep retrying the pair refund.
    if (row.pairRefund === 'pending' && row.dimensions?.refund === 'pending' && ['created', 'failed'].includes(row.state)) button('Release SOL refund', 'release-sol-refund');
    // A finished failure whose money has settled can leave these lists (its journal stays); an archived launch can come back.
    if (row.archive?.eligible === true) { const b = button('Archive', 'archive'); b.classList.add('admin-danger'); b.title = 'Hide this finished launch from the owner lists. Nothing is deleted.'; }
    if (row.archived === true) button('Restore from archive', 'unarchive');
    button(row.hidden ? 'Unhide' : 'Hide (moderation)', row.hidden ? 'unhide' : 'hide');
    card.append(buttons);
    return card;
  }
  /** One compact row: name, mode, state, pair, what needs the owner, age; opens to the full card. */
  function renderRow(row, now) {
    const item = el('details', null, 'admin-launch-row'); item.dataset.launchRow = row.id;
    const summary = el('summary'), identity = el('span', null, 'admin-launch-identity'), pills = el('span', null, 'admin-launch-pills'), meta = el('span', null, 'admin-launch-meta');
    const name = el('strong', '$' + text(row.symbol, 24) + ' · ' + text(row.name, 60)), sub = el('small', (row.modeLabel || row.mode || '') + ' · ' + (typeof row.pair?.symbol === 'string' && row.pair.symbol ? row.pair.symbol : 'SOL') + (ADDRESS.test(row.mint || '') ? ' · ' + row.mint.slice(0, 6) + '…' + row.mint.slice(-4) : ''));
    identity.append(name, sub);
    pills.append(pill(row.stateLabel || row.state, TONES[row.state] || ''));
    for (const item of attentionOf(row)) pills.append(pill(item.text, item.code === 'failed' ? 'bad' : 'warn'));
    if (row.hidden) pills.append(pill('Hidden'));
    if (row.archived) pills.append(pill('Archived'));
    const at = Number.isSafeInteger(row.liveAt) && row.liveAt > 0 ? row.liveAt : row.createdAt;
    const age = el('time', relativeTime(at, now)); if (Number.isSafeInteger(at) && at > 0) { age.title = exactTime(at); age.dateTime = new Date(at).toISOString(); }
    meta.append(age); if (ADDRESS.test(row.mint || '')) meta.append(copyButton(document, row.mint, 'Copy mint address'));
    summary.append(identity, pills, meta, el('span', '⌄', 'admin-launch-expand'));
    item.append(summary, renderLaunch(row));
    if (expanded.has(row.id)) item.open = true;
    item.addEventListener('toggle', () => { if (item.open) expanded.add(row.id); else expanded.delete(row.id); });
    return item;
  }
  /** Client-side view of an unpaged response (an action's result, or an older server): the same filter and page. */
  function clientPage(rows) {
    const q = query.search.toLowerCase(), chip = query.state;
    const matched = rows.filter(row => (chip === 'archived' ? row.archived === true : !row.archived) && (chip === 'attention' ? attentionOf(row).length > 0 : !chip || chip === 'archived' || row.state === chip)
      && (!q || [row.name, row.symbol, row.mint, row.id, row.accountId, row.developerWallet, row.reason, row.stateLabel, row.modeLabel].some(value => String(value || '').toLowerCase().includes(q))));
    const counts = { total: rows.length, archived: rows.filter(row => row.archived).length, attention: rows.filter(row => !row.archived && attentionOf(row).length).length, byState: {} };
    for (const row of rows) if (!row.archived) counts.byState[row.state] = (counts.byState[row.state] || 0) + 1;
    const offset = Math.min(query.offset, Math.max(0, Math.floor((matched.length - 1) / pageSize) * pageSize));
    return { rows: matched.slice(offset, offset + pageSize), total: matched.length, offset, counts };
  }
  function render(data) {
    snapshot = data; element.hidden = false; loadedAt = clock(); const now = clock();
    if (data.available === false) { status.textContent = data.reason || 'Pump.fun launches are disabled on this host.'; flagsBox.replaceChildren(); tools.replaceChildren(); launchesBox.replaceChildren(); pages.update({ total: 0 }); delete element.dataset.adminSummary; controls(); return; }
    const effective = data.effective || {};
    status.textContent = 'Policy ' + (data.policy?.version || '—') + ' · master switch ' + (effective.master ? 'on' : 'off') + ' · last worker pass ' + when(data.lastPassAt) + ' · database ' + (data.database?.ok ? 'ok' : 'CHECK') + ' (schema ' + (data.database?.version ?? '—') + ')' + (data.lastError ? ' · last error: ' + data.lastError : '') + '.';
    flagsBox.replaceChildren();
    for (const [key, label] of Object.entries(data.flagLabels || {})) {
      const on = data.flags?.[key] === true, live = effective[key] === true, action = (on ? 'Disable ' : 'Enable ') + (FLAG_ACTION[key] || label), b = el('button', action, 'small-button'); b.type = 'button'; b.title = label + ' — ' + (FLAG_HELP[key] || '');
      b.onclick = () => { const text = requireReason(); if (!text) return; void act(action, '/api/admin/pump-classic/control', { flags: { [key]: !on }, reason: text }); };
      const wrap = el('div', null, 'admin-gotchi-flag'); wrap.append(b, el('span', live ? 'On' : on ? 'On (master off)' : 'Off', live ? 'admin-gotchi-running' : 'admin-gotchi-paused')); flagsBox.append(wrap);
    }
    tools.replaceChildren();
    for (const [label, path] of [['Verify launch keys', '/api/admin/pump-classic/keys/verify'], ['Back up the database now', '/api/admin/pump-classic/backup']]) {
      const b = el('button', label, 'small-button'); b.type = 'button';
      b.onclick = async () => { const value = await act(label, path, {}, { reload: false }); if (value) result.textContent = path.endsWith('verify') ? (value.ok ? 'All ' + value.checked + ' launch key documents match their addresses.' : (value.rows || []).filter(r => !r.ok).map(r => r.id + ': ' + r.error).join(' · ')) : 'Backup written: ' + value.path; };
      const wrap = el('div', null, 'admin-gotchi-flag'); wrap.append(b); tools.append(wrap);
    }
    const all = Array.isArray(data.launches) ? data.launches : [];
    const paged = Number.isSafeInteger(data.launchTotal) ? { rows: all, total: data.launchTotal, offset: Number.isSafeInteger(data.offset) ? data.offset : query.offset, counts: data.counts || {} } : clientPage(all);
    const counts = paged.counts || {}, byState = counts.byState || {};
    filter.setChips(STATE_CHIPS.map(([key, label]) => ({ key, label, count: key === '' ? (Number.isSafeInteger(counts.total) ? counts.total - (counts.archived || 0) : undefined) : key === 'attention' ? counts.attention : key === 'archived' ? counts.archived : byState[key] })));
    listTitle.textContent = `Launches (${(Number.isSafeInteger(counts.total) ? counts.total : all.length).toLocaleString('en-US')})`;
    element.dataset.adminSummary = `${(byState.created || 0).toLocaleString('en-US')} live · ${(counts.attention || 0).toLocaleString('en-US')} need attention`;
    launchesBox.replaceChildren(...paged.rows.map(row => renderRow(row, now)));
    if (!paged.rows.length) launchesBox.append(el('p', query.search || query.state ? 'No Pump.fun launches match this filter.' : 'No Pump.fun launches yet.', 'help'));
    pages.update({ offset: paged.offset, limit: pageSize, total: paged.total, shown: paged.rows.length });
    controls();
  }
  async function load(force = false) {
    if (!permitted()) { clear(); return; } if (!isActive()) { stop(); return; } const owner = accountIdentity(); if (viewOwner !== null && viewOwner !== owner) clear(); viewOwner = owner; active = true;
    if (document.hidden && !force) { schedule(); return; } if (loading || (busy && !force)) return; loading = true; element.hidden = false; controls(); const generation = revision; if (!snapshot) status.textContent = 'Loading Pump.fun launches…';
    try { const data = await api('/api/admin/pump-classic?' + params()); if (permittedAt(generation, owner)) render(data); }
    catch { if (permittedAt(generation, owner)) status.textContent = snapshot ? 'Pump.fun status could not be refreshed. Showing the last snapshot.' : 'Pump.fun status is temporarily unavailable. Use Refresh to try again.'; }
    finally { if (generation === revision) { if (!permittedAt(generation, owner)) { clear(); return; } loading = false; controls(); schedule(); } }
  }
  function pause() { active = false; stop(); }
  // Opening the page again reuses a snapshot younger than one poll interval and only restarts polling.
  function show() { const before = state.signature(); readState(); if (permitted() && isActive() && snapshot && viewOwner === accountIdentity() && clock() - loadedAt < POLL_MS && before === state.signature()) { active = true; schedule(); return; } return load(); }
  function visibility() { if (document.hidden || !isActive()) { stop(); return; } if (active && permitted()) void load(); }
  let signature = '';
  function navigated() { if (!active || !permitted() || !isActive()) return; const next = state.signature(); if (next === signature) return; signature = next; readState(); void load(true); }
  function destroy() { clear(); disposed = true; document.removeEventListener('visibilitychange', visibility); view?.removeEventListener?.('popstate', navigated); }
  refresh.onclick = () => load(true); document.addEventListener('visibilitychange', visibility); view?.addEventListener?.('popstate', navigated); clear();
  const loadWithState = force => { readState(); signature = state.signature(); return load(force); };
  return { element, load: loadWithState, reload: () => load(true), show, clear, pause, destroy, find: q => { filter.set({ q }); query.search = q; query.offset = 0; writeState(); return load(true); } };
}
