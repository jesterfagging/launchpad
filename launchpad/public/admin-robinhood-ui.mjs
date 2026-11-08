// Owner view of Robinhood Chain launches (v71.39): rollout flags, the factory as deployed (owner, switches, fee,
// platform recipient, blockers), the host wallets and their ETH, the pair table (ETH, USDG, stocks and ETFs: enable,
// approve on chain), every launch's lifecycle, wallets, ledgers, operations, events and holder payouts, and the owner
// actions the server allows. Launches are listed 25 at a time as compact rows that expand to the full card. Stored
// key values are never returned by the API; this view can only ask the server to verify them.
import { PAGE_SIZE, copyButton, exactTime, filterBar, hashState, pager, relativeTime } from './admin-list-kit.mjs';
const POLL_MS = 30000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/, HASH = /^0x[0-9a-fA-F]{64}$/, EXPLORER = 'https://robinhoodchain.blockscout.com';
const FLAG_HELP = Object.freeze({
  intake: 'Lets creators quote and fund new Robinhood Chain launches. Off stops new quotes; funded launches still finish or refund.',
  pairs: 'Offers the stock and ETF pairs to everyone. While off, only you (the platform owner) see and can launch on them; ETH and USDG are always offered.',
  collection: 'Claims the creator share from the fee escrow to each coin’s fee wallet (every 15 minutes) and collects the locked pool’s fees after graduation.',
  routing: 'Sweeps the platform share to the treasury, and Earned / Insured coins’ releases to their creators.',
  holders: 'Pays Holders and Diamond Hands coins’ rewards through LaunchPayouts: automatically once the holders’ share is worth the threshold, or when you use Pay holders now.',
});
const FLAG_ACTION = Object.freeze({ intake: 'new launches', pairs: 'stock and ETF pairs', collection: 'fee collection', routing: 'sweeps', holders: 'holder reward payouts' });
const ROLE_LABELS = Object.freeze({ platform: 'Platform share', launch: 'Launch budget', gas: 'Option wallet gas', rewards: 'Holder rewards', escrow: 'Earned escrow', insured: 'Insured (pot and creator)', developer: 'Creator' });
const roleLabel = role => ROLE_LABELS[role] || (typeof role === 'string' && role ? role[0].toUpperCase() + role.slice(1).replace(/[_-]+/g, ' ') : 'Other');
const when = value => Number.isSafeInteger(value) && value > 0 ? exactTime(value) : '—';
const STATE_CHIPS = Object.freeze([['', 'All'], ['created', 'Live'], ['awaiting_funding', 'Waiting for funding'], ['funding_pending', 'Confirming funding'], ['funded', 'Funded'], ['creating', 'Creating'], ['failed', 'Failed'], ['refunding', 'Refunding'], ['refunded', 'Refunded'], ['archived', 'Archived']]);
const TONES = Object.freeze({ created: 'good', failed: 'bad', refunding: 'warn', funded: 'warn', creating: 'warn', funding_pending: 'warn', awaiting_funding: '', refunded: '', cancelled: '', expired: '' });
const text = (value, max = 120) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max) : '';
const page = value => { const n = Number(value); return Number.isSafeInteger(n) && n > 1 ? n : 1; };
const pct = bps => (Number(bps) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '%';

export function createAdminRobinhood({ document, api, security, message = () => {}, getAccount, isActive = () => true, setTimer = setInterval, clearTimer = clearInterval, clock = Date.now, pageSize = PAGE_SIZE } = {}) {
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = String(text); if (cls) node.className = cls; return node; };
  const link = (text, href) => { const a = el('a', text); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; };
  const view = document.defaultView || null;
  const address = (node, value) => { node.replaceChildren(el('span', value.slice(0, -6)), el('span', value.slice(-6))); node.classList.add('admin-address'); node.setAttribute('title', value); return node; };
  const element = el('section', null, 'admin-card admin-pump-classic admin-robinhood'); element.id = 'admin-robinhood';
  const heading = el('div', null, 'admin-card-heading'), copy = el('div'), refresh = el('button', 'Refresh', 'text-button'); refresh.type = 'button'; refresh.id = 'admin-robinhood-refresh';
  copy.append(el('p', 'LAUNCH OPERATIONS / ROBINHOOD CHAIN', 'eyebrow'), el('h2', 'Robinhood Chain launches'), el('p', 'Coins created by Launchpad’s own launch contracts on Robinhood Chain: rollout flags, the factory, host wallets, pairs and every launch. Keys never leave the server; this view only asks it to verify them.', 'help'));
  heading.append(copy, refresh);
  const status = el('p', '', 'admin-revenue-status'); status.id = 'admin-robinhood-status'; status.setAttribute('role', 'status');
  const reasonLabel = el('label', 'Reason for the next change', 'admin-protocol-wide'), reason = el('input'); reason.id = 'admin-robinhood-reason'; reason.minLength = 5; reason.maxLength = 500; reason.placeholder = 'Recorded with every flag change and launch action (5 to 500 characters)'; reasonLabel.append(reason);
  const flagsBox = el('div', null, 'admin-gotchi-flags'); flagsBox.id = 'admin-robinhood-flags';
  const factoryBox = el('div', null, 'admin-gas-facts'); factoryBox.id = 'admin-robinhood-factory';
  const tools = el('div', null, 'admin-gotchi-flags'); tools.id = 'admin-robinhood-tools';
  const pairsBox = el('div', null, 'admin-launch-rows'); pairsBox.id = 'admin-robinhood-pairs';
  const result = el('p', '', 'help'); result.id = 'admin-robinhood-result';
  const listHead = el('div', null, 'admin-list-head'), listTitle = el('h3', 'Launches');
  const filter = filterBar(document, { placeholder: 'Find a launch: coin, ticker, token, account or reason', label: 'Find a Robinhood launch', chips: STATE_CHIPS.map(([key, label]) => ({ key, label })), onChange: ({ q, chip, source }) => { query.search = q; query.state = chip; if (source !== 'input' || q !== lastSearch) query.offset = 0; lastSearch = q; writeState({ push: source !== 'input' }); void load(true); } });
  filter.input.id = 'admin-robinhood-search'; filter.element.classList.add('admin-sticky-tools');
  listHead.append(listTitle);
  const launchesBox = el('div', null, 'admin-launch-rows'); launchesBox.id = 'admin-robinhood-launches';
  const pages = pager(document, { label: 'launches', onPage: offset => { query.offset = offset; writeState({ push: true }); void load(true); } });
  element.append(heading, status, reasonLabel, el('h3', 'Rollout flags'), flagsBox, el('h3', 'Factory and host wallets'), factoryBox, el('h3', 'Operations'), tools, result, el('h3', 'Pairs'), pairsBox, listHead, filter.element, launchesBox, pages.element);
  let snapshot = null, revision = 0, disposed = false, loading = false, busy = false, active = false, timer = null, viewOwner = null, loadedAt = 0, lastSearch = '';
  const query = { search: '', state: '', offset: 0 }, state = hashState(view, { prefix: 'rh' }), expanded = new Set();
  const accountIdentity = () => getAccount()?.id ?? getAccount();
  const permitted = () => !disposed && getAccount()?.role === 'admin' && getAccount()?.mfaEnabled === true;
  const permittedAt = (generation, owner) => permitted() && revision === generation && accountIdentity() === owner;
  function stop() { if (timer !== null) { clearTimer(timer); timer = null; } }
  function schedule() { stop(); if (active && permitted() && isActive() && !document.hidden && !busy) timer = setTimer(() => { if (permitted() && isActive() && !document.hidden) void load(); else stop(); }, POLL_MS); }
  function controls() { const disabled = !permitted() || !snapshot || loading || busy || snapshot?.available === false; refresh.disabled = !permitted() || loading || busy; reason.disabled = disabled; filter.input.disabled = disabled; for (const button of element.querySelectorAll('button:not(#admin-robinhood-refresh):not(.admin-copy):not(.admin-row-toggle):not(.admin-pager button)')) button.disabled = disabled; }
  function clear() { revision++; stop(); snapshot = null; viewOwner = null; loadedAt = 0; loading = false; busy = false; active = false; element.hidden = true; status.textContent = ''; flagsBox.replaceChildren(); factoryBox.replaceChildren(); tools.replaceChildren(); pairsBox.replaceChildren(); launchesBox.replaceChildren(); pages.update({ total: 0 }); result.textContent = ''; reason.value = ''; expanded.clear(); }
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
      message(label + ' done.' + (value?.hash ? ' Transaction ' + value.hash.slice(0, 10) + '…' : '')); if (value?.rows && value.available !== false) render(value); else if (reload) await load(true); return value;
    } catch (error) { if (permittedAt(generation, owner) && error?.message !== 'Cancelled.') message(error?.message || 'The request could not be confirmed. Refresh before trying again.', true); return null; }
    finally { if (generation === revision) { if (!permittedAt(generation, owner)) { clear(); return; } busy = false; controls(); schedule(); } }
  }
  function stat(label, value, warn = false) { const item = el('div', null, 'admin-stat'); item.append(el('span', label), el('strong', value)); if (warn) item.classList.add('admin-gas-warning'); return item; }
  function wallets(row) {
    const list = el('dl', null, 'admin-wallets'), add = (label, ...nodes) => { const item = el('div'), value = el('dd'); value.append(...nodes); item.append(el('dt', label), value); list.append(item); };
    const token = row.token || row.predictedToken;
    if (ADDRESS.test(token || '')) add(row.token ? 'Coin' : 'Coin (predicted)', address(link(token, row.token ? '/coin?mint=' + token + '&chain=robinhood' : EXPLORER + '/address/' + token), token), link('explorer ↗', EXPLORER + '/address/' + token));
    for (const [label, value] of [['Developer (funding, first-buy delivery)', row.developerWallet], ['Launch wallet (creator of the coin, payer)', row.launchWallet], ['Fee wallet (the option’s)', row.feeWallet], ['Launchpad', row.curve]]) if (ADDRESS.test(value || '')) add(label, address(link(value, EXPLORER + '/address/' + value), value), copyButton(document, value));
    return list;
  }
  const pill = (label, tone = '') => el('span', label, 'cv-pill' + (tone ? ' is-' + tone : ''));
  function renderLaunch(row) {
    const card = el('div', null, 'admin-gotchi-card'); card.dataset.launch = row.id;
    const head = el('div', null, 'admin-card-heading'), title = el('div');
    const pair = row.pair?.symbol || 'ETH';
    // The fee shape (v71.41): the holder tax of a Holders / Diamond Hands coin, or the flat creator fee; both stages' totals.
    const fees = row.fees && Number.isFinite(Number(row.fees.curveTotalBps)) ? row.fees : null, pct = bps => (Number(bps) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '%';
    const feeText = fees ? (fees.taxBps > 0 ? ' · holder tax ' + pct(fees.taxBps) : ' · creator fee 0.5% / 0.25%') + ' · pool fee ' + pct(fees.curveTotalBps) + (fees.stage === 'pool' ? ' → ' + pct(fees.poolTotalBps) + ' (graduated)' : ' → ' + pct(fees.poolTotalBps)) : Number(row.taxBps) > 0 ? ' · holder tax ' + pct(row.taxBps) : '';
    title.append(el('h3', row.name + ' · $' + row.symbol), el('p', (row.modeLabel || row.mode) + ' · paired with ' + pair + (row.tier?.label ? ' · ' + row.tier.label : '') + feeText + (row.rules ? ' · ' + row.rules + ' rule' + (row.rules === 1 ? '' : 's') : '') + ' · ' + (row.stateLabel || row.state) + (row.reason ? ' · ' + row.reason : ''), 'help'));
    head.append(title); card.append(head);
    const dims = row.dimensions || {}, facts = el('div', null, 'admin-gas-facts');
    for (const [label, value, warn] of [['Launch', dims.launch || '—', dims.launch === 'failed'], ['Fees', dims.fees || '—'], ['Venue', dims.venue || '—'], ['Refund', dims.refund || '—', dims.refund === 'pending'], ['Creation attempts', String(row.createAttempts ?? 0)], ['Holders', String(row.holders ?? 0)], ['Live since', when(row.liveAt)], ['Quoted', when(row.createdAt)]]) facts.append(stat(label, value, !!warn));
    card.append(facts, wallets(row));
    const q = row.quote;
    if (q) { const box = el('div', null, 'admin-gas-facts'); for (const [label, value] of [['Launch fee', q.launchFeeEth + ' ETH'], ['First buy', q.devBuy + ' ' + (q.devBuySymbol || pair)], ['Gas budget', q.gasBudgetEth + ' ETH'], ['Option wallet gas', q.feeWalletGasEth + ' ETH'], ['Funding total', q.totalEth + ' ETH'], ['Pair price at quote', q.pairUsd ? '$' + q.pairUsd : '—']]) box.append(stat(label, value)); card.append(box); }
    const balances = el('div', null, 'admin-gas-facts');
    for (const b of row.balances || []) balances.append(stat(roleLabel(b.role) + ' · ' + (b.asset && b.asset !== '0x0000000000000000000000000000000000000000' ? pair : 'ETH') + ' available / credited', b.available + ' / ' + b.credited));
    if (balances.children.length) card.append(balances);
    const payout = row.holderPayout;
    if (payout && typeof payout === 'object') {
      const box = el('div', null, 'admin-gas-facts');
      box.append(stat('Holder payouts', payout.open ? (payout.open.source === 'admin' ? 'Requested' : 'Cycle open') + (payout.open.waiting ? ' · ' + payout.open.waiting : '') : 'Idle'), stat('Ready to pay', (payout.held || '0') + ' ' + (payout.asset || pair)), stat('Automatic at', '$' + Number(payout.thresholdUsd || 100).toLocaleString('en-US')));
      if (payout.last) box.append(stat('Last payout', when(payout.last.at) + ' · ' + (payout.last.state || '') + (payout.last.recipients ? ' · ' + payout.last.recipients + ' holders' : '') + (payout.last.reason ? ' · ' + payout.last.reason : '')));
      card.append(box);
    }
    if (row.feeClaims?.length) { const list = el('ul', null, 'admin-protocol-history'); for (const c of row.feeClaims) { const item = el('li', c.kind + ' · ' + roleLabel(c.role) + ' · ' + c.amount + ' · block ' + c.block + ' '); if (HASH.test(c.tx || '')) item.append(link('tx ↗', EXPLORER + '/tx/' + c.tx)); list.append(item); } card.append(el('h4', 'Fee claims'), list); }
    if (row.openOperations?.length) { const list = el('ul', null, 'admin-protocol-history'); for (const op of row.openOperations) { const item = el('li', op.kind + ' · ' + op.state + ' · attempts ' + (op.attempts ?? 0) + (op.error ? ' · ' + op.error : '') + ' '); if (HASH.test(op.hash || '')) item.append(link('tx ↗', EXPLORER + '/tx/' + op.hash)); list.append(item); } card.append(el('h4', 'Open operations'), list); }
    if (row.events?.length) { const details = el('details', null, 'admin-protocol-gas'), list = el('ul', null, 'admin-protocol-history'); details.append(el('summary', 'Recent events · ' + row.events.length)); for (const e of row.events) { const item = el('li', when(e.at) + ' · ' + e.title + (e.body ? ' · ' + e.body : '') + ' '); if (HASH.test(e.txHash || e.tx_hash || '')) item.append(link('tx ↗', EXPLORER + '/tx/' + (e.txHash || e.tx_hash))); list.append(item); } details.append(list); card.append(details); }
    const buttons = el('div', null, 'admin-gotchi-flags'), button = (label, action, extra = {}) => { const b = el('button', label, 'small-button'); b.type = 'button'; b.onclick = () => { const text = requireReason(); if (!text) return; void act(label + ' · ' + row.symbol, '/api/admin/robinhood/control', { launchId: row.id, action, reason: text, ...extra }); }; buttons.append(b); return b; };
    if (row.state === 'created' && row.paysHolders) button('Pay holders now', 'pay-holders');
    if (row.state === 'created' && row.venueState !== 'graduated') button('Record graduation (price past the tick)', 'graduate');
    if (row.state === 'created') button('Collect pool fees now', 'collect');
    if (['funded', 'creating'].includes(row.state)) button('Refund (stop before creation)', 'refund');
    if (row.state === 'created') button(row.hidden ? 'Show on public lists' : 'Hide from public lists', row.hidden ? 'unhide' : 'hide');
    if (['failed', 'refunded', 'expired', 'cancelled'].includes(row.state)) button(row.archived ? 'Unarchive' : 'Archive', row.archived ? 'unarchive' : 'archive');
    button('Retry now', 'retry');
    card.append(buttons);
    return card;
  }
  function renderRow(row, now) {
    const item = el('details', null, 'admin-launch-row'); item.dataset.launchRow = row.id;
    const summary = el('summary'), identity = el('span', null, 'admin-launch-identity'), pills = el('span', null, 'admin-launch-pills'), meta = el('span', null, 'admin-launch-meta');
    const token = row.token || row.predictedToken || '';
    const name = el('strong', '$' + text(row.symbol, 24) + ' · ' + text(row.name, 60)), sub = el('small', (row.modeLabel || row.mode || '') + ' · ' + (row.pair?.symbol || 'ETH') + (row.tier?.label ? ' · ' + row.tier.label : '') + (ADDRESS.test(token) ? ' · ' + token.slice(0, 6) + '…' + token.slice(-4) : ''));
    identity.append(name, sub);
    pills.append(pill(row.stateLabel || row.state, TONES[row.state] || ''));
    if (row.venueState === 'graduated') pills.append(pill('Graduated', 'good'));
    if (row.dimensions?.refund === 'pending') pills.append(pill('Refund waiting', 'warn')); if (row.state === 'failed' && row.dimensions?.refund !== 'pending') pills.append(pill('Failed', 'bad'));
    if (row.openOperations?.length) pills.append(pill(row.openOperations.length + ' open op' + (row.openOperations.length === 1 ? '' : 's'), 'warn'));
    if (row.hidden) pills.append(pill('Hidden')); if (row.archived) pills.append(pill('Archived'));
    if (row.legacy) { const p = pill('Earlier contracts · not tracked', 'warn'); p.title = 'Made by the earlier bonding-curve contract set; this host tracks pool-native coins only. The coin still exists on its old contracts.'; pills.append(p); }
    const at = Number.isSafeInteger(row.liveAt) && row.liveAt > 0 ? row.liveAt : row.createdAt;
    const age = el('time', relativeTime(at, now)); if (Number.isSafeInteger(at) && at > 0) { age.title = exactTime(at); age.dateTime = new Date(at).toISOString(); }
    meta.append(age); if (ADDRESS.test(token)) meta.append(copyButton(document, token, 'Copy token address'));
    summary.append(identity, pills, meta, el('span', '⌄', 'admin-launch-expand'));
    item.append(summary, renderLaunch(row));
    if (expanded.has(row.id)) item.open = true;
    item.addEventListener('toggle', () => { if (item.open) expanded.add(row.id); else expanded.delete(row.id); });
    return item;
  }
  function renderList() { const now = clock(); launchesBox.replaceChildren(); for (const row of snapshot?.rows || []) launchesBox.append(renderRow(row, now)); if (!snapshot?.rows?.length) launchesBox.append(el('p', snapshot?.total ? 'No launches on this page.' : 'No launches match.', 'help')); pages.update({ total: snapshot?.total || 0, offset: snapshot?.offset || 0, limit: pageSize }); controls(); }
  const KIND_LABELS = { native: 'ETH', stable: 'Stablecoin', stock: 'Stock', etf: 'ETF', custom: 'Custom (Launchpad-added)' };
  function renderPairs() {
    pairsBox.replaceChildren();
    // Add a pair by address (v71.40): any ERC-20 on the chain that a Uniswap pool prices against USDG or ETH.
    const addBox = el('div', null, 'admin-pair-add'), addLabel = el('label', 'Add a pair by token address'), addInput = el('input'); addInput.type = 'text'; addInput.placeholder = '0x… (an ERC-20 on Robinhood Chain)'; addInput.autocomplete = 'off'; addInput.spellcheck = false; addInput.maxLength = 42; addInput.id = 'admin-robinhood-add-pair'; addLabel.htmlFor = addInput.id; addInput.dataset.pairAddress = '';
    const addButton = el('button', 'Add pair', 'small-button'); addButton.type = 'button'; addButton.dataset.addPair = '';
    addButton.onclick = () => { const address = addInput.value.trim(); if (!ADDRESS.test(address)) { message('Enter a token address: 0x followed by 40 hex characters.', true); return; } const text = requireReason(); if (!text) return; void act('Add pair ' + address.slice(0, 6) + '…' + address.slice(-4), '/api/admin/robinhood/control', { action: 'add-pair', address, reason: text }).then(v => { if (v) { addInput.value = ''; if (v.what) result.textContent = v.what + '. Approve it on chain, then offer it to creators.'; } }); };
    const addRow = el('div', null, 'admin-pair-add-row'); addRow.append(addInput, addButton);
    addBox.append(addLabel, addRow, el('p', 'The token is read on the chain (symbol, name, decimals) and must have a Uniswap pool pricing it against USDG or ETH. Stocks and ETFs come from the stock-token list (Sync pairs). Adding is a listing: approve it on chain and offer it to creators afterwards.', 'help'));
    pairsBox.append(addBox);
    // Requests from the launch page's Custom check.
    const requests = snapshot?.pairRequests || [];
    if (requests.length) {
      const box = el('div', null, 'admin-pair-requests'); box.append(el('h4', 'Requested by creators · ' + requests.length));
      const table = el('table', null, 'cv-table admin-pairs-table'), head = el('tr'); for (const h of ['Token', 'Price', 'Requests', 'Last', '']) head.append(el('th', h)); const thead = el('thead'); thead.append(head); const tbody = el('tbody');
      for (const r of requests) {
        const tr = el('tr'), nameCell = el('td'); nameCell.append(el('strong', r.symbol || '?'), el('span', ' ' + (r.name || '')), el('br'), address(link(r.address, EXPLORER + '/address/' + r.address), r.address));
        const actions = el('td'), button = (label, body) => { const b = el('button', label, 'small-button'); b.type = 'button'; b.onclick = () => { const text = requireReason(); if (!text) return; void act(label + ' · ' + (r.symbol || r.address.slice(0, 8)), '/api/admin/robinhood/control', { reason: text, ...body }); }; actions.append(b); return b; };
        if (r.compatible) button('Add pair', { action: 'add-pair', address: r.address });
        button('Dismiss', { action: 'dismiss-pair-request', address: r.address });
        tr.append(nameCell, el('td', r.usd ? '$' + Number(r.usd).toLocaleString('en-US', { maximumFractionDigits: 4 }) : 'no pool price'), el('td', String(r.count || 1) + (Array.isArray(r.accounts) && r.accounts.length ? ' · ' + r.accounts.length + ' account' + (r.accounts.length === 1 ? '' : 's') : '')), el('td', when(r.lastAt)), actions); tbody.append(tr);
      }
      table.append(thead, tbody); box.append(table); pairsBox.append(box);
    }
    const rows = snapshot?.pairs || []; if (!rows.length) { pairsBox.append(el('p', 'No pairs synced yet. Run the pair sync.', 'help')); return; }
    const table = el('table', null, 'cv-table admin-pairs-table'), head = el('tr'); for (const h of ['Pair', 'Kind', 'Approved on chain', 'Offered', '']) head.append(el('th', h)); const thead = el('thead'); thead.append(head); const tbody = el('tbody');
    for (const p of rows) {
      const tr = el('tr'), nameCell = el('td'); nameCell.className = 'admin-rh-pair-cell';
      const badge = el('span', null, 'admin-rh-pair-badge'); const mark = el('span', String(p.symbol || '?').slice(0, 2)); badge.append(mark);
      if (typeof p.logo === 'string' && /^\/robinhood-pairs\/logo\/0x[0-9a-fA-F]{40}(?:\?v=\d+)?$/.test(p.logo)) { const img = el('img'); img.src = p.logo; img.alt = ''; img.width = 22; img.height = 22; img.loading = 'lazy'; img.addEventListener('error', () => { img.remove(); mark.hidden = false; }); mark.hidden = true; badge.append(img); }
      nameCell.append(badge, el('strong', p.symbol), el('span', ' ' + (p.name || '')));
      if (p.kind === 'custom' && ADDRESS.test(p.address || '')) nameCell.append(el('br'), address(link(p.address, EXPLORER + '/address/' + p.address), p.address));
      const actions = el('td'), button = (label, body) => { const b = el('button', label, 'small-button'); b.type = 'button'; b.onclick = () => { const text = requireReason(); if (!text) return; void act(label + ' · ' + p.symbol, '/api/admin/robinhood/control', { reason: text, ...body }); }; actions.append(b); return b; };
      if (!p.approved) button('Approve on chain', { action: 'approve-pairs', addresses: [p.address] });
      if (p.kind !== 'native' && p.kind !== 'stable') button(p.enabled ? 'Stop offering' : 'Offer to creators', { action: p.enabled ? 'disable-pair' : 'enable-pair', address: p.address });
      if (p.kind === 'custom') button('Remove', { action: 'remove-pair', address: p.address });
      tr.append(nameCell, el('td', KIND_LABELS[p.kind] || p.kind || '—'), el('td', p.approved ? 'Yes' + (p.approved_at ? ' · ' + when(p.approved_at) : '') : 'No'), el('td', p.enabled ? 'Yes' : 'No'), actions); tbody.append(tr);
    }
    table.append(thead, tbody); pairsBox.append(table);
  }
  function render(value) {
    snapshot = value; element.hidden = false; loadedAt = clock();
    if (value.available === false) { status.textContent = 'Robinhood launches are disabled on this host (LAUNCHPAD_ROBINHOOD_LAUNCH_ENABLED).'; flagsBox.replaceChildren(); factoryBox.replaceChildren(); tools.replaceChildren(); pairsBox.replaceChildren(); launchesBox.replaceChildren(); pages.update({ total: 0 }); controls(); return; }
    const pass = value.lastPassAt ? relativeTime(value.lastPassAt, clock()) : 'never';
    status.textContent = (value.configured ? 'Contracts configured. ' : 'Contracts not configured (LAUNCHPAD_RH_LAUNCH_FACTORY and friends). ') + 'Worker: last pass ' + pass + (value.lastError ? ' · ' + value.lastError : '') + ' · ' + (value.passes || 0) + ' passes' + (value.db ? ' · database v' + value.db.version + (value.db.ok ? '' : ' · INTEGRITY CHECK FAILED') : '') + ' · policy ' + (value.policy?.version || '');
    flagsBox.replaceChildren();
    for (const [name, on] of Object.entries(value.flags || {})) {
      const box = el('div', null, 'admin-gotchi-flag'), b = el('button', (on ? 'Disable ' : 'Enable ') + (FLAG_ACTION[name] || name), 'small-button'); b.type = 'button'; b.dataset.flag = name;
      b.onclick = () => { const text = requireReason(); if (!text) return; void act((on ? 'Disable ' : 'Enable ') + (FLAG_ACTION[name] || name), '/api/admin/robinhood/control', { flags: { [name]: !on }, reason: text }); };
      box.append(pill(name + ': ' + (on ? 'on' : 'off') + (value.effective && value.effective[name] !== on ? ' (not effective)' : ''), on ? 'good' : ''), el('p', FLAG_HELP[name] || '', 'help'), b); flagsBox.append(box);
    }
    factoryBox.replaceChildren();
    const f = value.factory, h = value.host || {}, b = h.balances || {};
    if (f) {
      for (const [label, val, warn] of [['Factory owner', (f.ownerIsHost ? 'the host owner wallet' : f.owner) + (f.pendingOwner && !/^0x0{40}$/i.test(f.pendingOwner) ? ' · pending: ' + f.pendingOwner : ''), !f.ownerIsHost], ['Launches', f.launchesOpen ? 'open' : 'closed', !f.launchesOpen], ['Launch fee', f.launchFee + ' ETH'], ['Platform recipient', f.platformIsHost ? 'the host platform wallet' : f.platformRecipient, !f.platformIsHost], ['Config', f.config ? 'supply ' + String(f.config.totalSupply).replace(/0{18}$/, '') + (f.config.curveProtocolFeeBps != null ? ' · curve pool ' + pct(f.config.curveProtocolFeeBps) + ' Launchpad + ' + pct(f.config.curveCreatorFeeBps) + ' creator · graduation pool ' + pct(f.config.poolProtocolFeeBps) + ' + ' + pct(f.config.poolCreatorFeeBps) + ' · holder tax ' + pct(f.config.minTaxBps) + '–' + pct(f.config.maxTaxBps) + ' (' + pct(f.config.taxPlatformShareBps) + ' of it Launchpad’s)' : ' · trade fee ' + f.config.tradeFeeBps + ' bps · platform share ' + f.config.platformShareBps + ' bps · pool fee ' + f.config.poolFee) + (f.config.enabled ? '' : ' · DISABLED') : '—']]) factoryBox.append(stat(label, val, !!warn));
      for (const blocker of f.blockers || []) factoryBox.append(el('p', blocker, 'admin-gas-warning'));
    } else factoryBox.append(el('p', value.factoryError ? 'The factory could not be read: ' + value.factoryError : 'The factory could not be read.', 'admin-gas-warning'));
    for (const [label, addr, balance] of [['Host owner wallet (owner transactions, graduation retries)', h.owner, b.owner], ['Host platform wallet (platform-share claims, sweeps)', h.platform, b.platform]]) if (ADDRESS.test(addr || '')) { const item = el('div', null, 'admin-stat'); const value = el('strong'); value.append(address(link(addr, EXPLORER + '/address/' + addr), addr), copyButton(document, addr)); item.append(el('span', label + (balance !== undefined ? ' · ' + balance + ' ETH' : '')), value); if (balance !== undefined && Number(balance) < 0.001) item.classList.add('admin-gas-warning'); factoryBox.append(item); }
    if (b.platformEscrow !== undefined) factoryBox.append(stat('Platform share waiting in the escrow', b.platformEscrow + ' ETH'));
    for (const [label, addr] of Object.entries(value.contracts || {})) if (ADDRESS.test(addr || '')) { const item = el('div', null, 'admin-stat'); const v = el('strong'); v.append(address(link(addr, EXPLORER + '/address/' + addr), addr)); item.append(el('span', label), v); factoryBox.append(item); }
    if (value.treasury) factoryBox.append(stat('Treasury', value.treasury));
    tools.replaceChildren();
    const tool = (label, body, { needsReason = true } = {}) => { const btn = el('button', label, 'small-button'); btn.type = 'button'; btn.onclick = () => { const text = needsReason ? requireReason() : ''; if (needsReason && !text) return; void act(label, '/api/admin/robinhood/control', { reason: text, ...body }); }; tools.append(btn); return btn; };
    tool('Sync pairs', { action: 'sync-pairs' }, { needsReason: false });
    const unapproved = (value.pairs || []).filter(p => !p.approved).map(p => p.address);
    if (f && f.ownerIsHost && unapproved.length) tool(`Approve all ${unapproved.length} listed pairs on chain`, { action: 'approve-pairs', addresses: unapproved });
    if (f && !f.ownerIsHost) tool('Accept factory ownership', { action: 'accept-ownership' });
    if (f && f.ownerIsHost && !f.platformIsHost) tool('Set platform recipient to the host wallet', { action: 'set-platform-recipient' });
    if (f && f.ownerIsHost) tool(f.launchesOpen ? 'Close launches on the factory' : 'Open launches on the factory', { action: 'set-launches-open', value: !f.launchesOpen });
    const verify = el('button', 'Verify stored keys', 'small-button'); verify.type = 'button'; verify.onclick = () => { void act('Verify stored keys', '/api/admin/robinhood/keys/verify', {}, { reload: false }).then(v => { if (v) result.textContent = v.ok + ' launch key set' + (v.ok === 1 ? '' : 's') + ' verified' + (v.bad?.length ? '; problems: ' + v.bad.map(x => x.id + ' (' + x.error + ')').join(', ') : '') + '.'; }); }; tools.append(verify);
    const backup = el('button', 'Back up the database', 'small-button'); backup.type = 'button'; backup.onclick = () => { void act('Back up the Robinhood launch database', '/api/admin/robinhood/backup', {}, { reload: false }).then(v => { if (v) result.textContent = 'Backup written: ' + (v.path || v.file || 'done') + '.'; }); }; tools.append(backup);
    const counts = Object.entries(value.counts || {}).filter(([, n]) => n > 0).map(([s, n]) => s.replace(/_/g, ' ') + ' ' + n).join(' · ');
    listTitle.textContent = 'Launches' + (counts ? ' · ' + counts : '');
    renderPairs(); renderList();
  }
  async function load(force = false) {
    if (!permitted()) { clear(); return; } if (!isActive()) { stop(); return; } const owner = accountIdentity(); if (viewOwner !== null && viewOwner !== owner) clear(); viewOwner = owner; active = true;
    if (document.hidden && !force) { schedule(); return; } if (loading || (busy && !force)) return; loading = true; element.hidden = false; controls(); const generation = revision; if (!snapshot) status.textContent = 'Loading Robinhood Chain launches…';
    try { const data = await api('/api/admin/robinhood?' + params()); if (permittedAt(generation, owner)) render(data); }
    catch { if (permittedAt(generation, owner)) status.textContent = snapshot ? 'Robinhood Chain status could not be refreshed. Showing the last snapshot.' : 'Robinhood Chain status is temporarily unavailable. Use Refresh to try again.'; }
    finally { if (generation === revision) { if (!permittedAt(generation, owner)) { clear(); return; } loading = false; controls(); schedule(); } }
  }
  function pause() { active = false; stop(); }
  function show() { const before = state.signature(); readState(); if (permitted() && isActive() && snapshot && viewOwner === accountIdentity() && clock() - loadedAt < POLL_MS && before === state.signature()) { active = true; schedule(); return; } return load(); }
  function visibility() { if (document.hidden || !isActive()) { stop(); return; } if (active && permitted()) void load(); }
  let signature = '';
  function navigated() { if (!active || !permitted() || !isActive()) return; const next = state.signature(); if (next === signature) return; signature = next; readState(); void load(true); }
  function destroy() { clear(); disposed = true; document.removeEventListener('visibilitychange', visibility); view?.removeEventListener?.('popstate', navigated); }
  refresh.onclick = () => load(true); document.addEventListener('visibilitychange', visibility); view?.addEventListener?.('popstate', navigated); clear();
  const loadWithState = force => { readState(); signature = state.signature(); return load(force); };
  return { element, load: loadWithState, reload: () => load(true), show, clear, pause, destroy, find: q => { filter.set({ q }); query.search = q; query.offset = 0; writeState(); return load(true); } };
}
