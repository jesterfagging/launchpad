import { PAGE_SIZE, filterBar, pageRows, pager } from './admin-list-kit.mjs';
const POLL_MS = 30000;
const address = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
const signature = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(value);
const number = value => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const sol = value => { const n = number(value); return n === null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: 4 }) + ' SOL'; };
const money = value => { const n = number(value); return n === null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n); };
const when = value => { const at = number(value); return at > 0 ? new Date(at).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'; };
// Raw token units shown in whole tokens with the asset's own decimals; null when either part is unusable.
const tokens = (raw, decimals) => { const text = typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : raw; if (typeof text !== 'string' || !/^\d{1,80}$/.test(text) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null; const value = BigInt(text), scale = 10n ** BigInt(decimals), fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, ''); return (value / scale).toLocaleString('en-US') + (fraction ? '.' + fraction : ''); };
// UTC day of a timestamp, as the Gotchi service keys its daily gas ledger.
const utcDay = value => { const at = number(value); return new Date(at > 0 ? at : Date.now()).toISOString().slice(0, 10); };
const RETRY_LABELS = { buy: 'Winner buy', airdrop: 'Airdrop' };
const FLAGS = [['collectionPaused', 'Contribution recognition', 'Finds and credits finalized payouts to the vault'], ['conversionPaused', 'Conversion to SOL', 'Sells collected quote tokens for SOL'], ['samplingPaused', 'Holder sampling', 'Scores holders of graduated coins every 15 minutes'], ['settlementPaused', 'Settlement payments', 'Buying the winner and airdropping. A race still closes and freezes at the goal while paused, so the frozen plan can be reviewed here first']];

export function createAdminGotchi({ document, api, security, message = () => {}, getAccount, isActive = () => true, setTimer = setInterval, clearTimer = clearInterval, clock = Date.now } = {}) {
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = String(text); if (cls) node.className = cls; return node; };
  // A long address keeps its full text and gives way in the middle when space runs out.
  const shortened = (node, value) => { if (typeof value === 'string' && value.length > 12 && node.textContent === value) { node.replaceChildren(el('span', value.slice(0, -6)), el('span', value.slice(-6))); node.classList.add('admin-address'); node.setAttribute('title', value); } return node; };
  const link = (kind, value, label) => { const node = el(kind === 'tx' ? signature(value) ? 'a' : 'span' : address(value) ? 'a' : 'span', label || value); if (node.tagName === 'A') { node.href = 'https://solscan.io/' + kind + '/' + value; node.target = '_blank'; node.rel = 'noopener noreferrer'; } return node; };
  const element = el('section', null, 'admin-card admin-gotchi'); element.id = 'admin-gotchi';
  const heading = el('div', null, 'admin-card-heading'), copy = el('div'), refresh = el('button', 'Refresh', 'text-button'); refresh.type = 'button'; refresh.id = 'admin-gotchi-refresh';
  copy.append(el('p', 'LAUNCH OPERATIONS / GOTCHI MODE', 'eyebrow'), el('h2', 'Gotchi races'), el('p', 'Inspect every Gotchi vault, pause or resume each stage independently and retry stuck steps. Vault keys never leave the server.'));
  heading.append(copy, refresh);
  const status = el('p', '', 'admin-revenue-status'); status.id = 'admin-gotchi-status'; status.setAttribute('role', 'status');
  const globalRow = el('div', null, 'admin-gotchi-global'), globalToggle = el('button', 'Pause new Gotchi launches', 'small-button'); globalToggle.type = 'button'; globalToggle.id = 'admin-gotchi-launches';
  const reasonLabel = el('label', 'Reason for the next change', 'admin-protocol-wide'), reason = el('input'); reason.id = 'admin-gotchi-reason'; reason.minLength = 5; reason.maxLength = 500; reason.placeholder = 'Recorded with every pause, resume or retry'; reasonLabel.append(reason);
  globalRow.append(reasonLabel, globalToggle);
  const cards = el('div', null, 'admin-gotchi-cards'); cards.id = 'admin-gotchi-cards';
  // Gotchis are listed 25 a page after a text filter (name, vault, coin), so a long roster never scrolls for miles.
  const listHead = el('div', null, 'admin-list-head'), listTitle = el('h3', 'Gotchis'); listHead.append(listTitle);
  const filter = filterBar(document, { placeholder: 'Find a Gotchi: name, vault or coin', label: 'Find a Gotchi', chips: [{ key: '', label: 'All' }, { key: 'paused', label: 'Paused' }, { key: 'pending', label: 'Confirming' }], onChange: ({ q, chip }) => { query.q = q; query.chip = chip; query.offset = 0; renderList(); } });
  filter.input.id = 'admin-gotchi-search'; filter.element.classList.add('admin-sticky-tools');
  const pages = pager(document, { label: 'Gotchis', onPage: offset => { query.offset = offset; renderList(); cards.scrollIntoView?.({ block: 'start' }); } });
  const query = { q: '', chip: '', offset: 0 };
  const history = el('details', null, 'admin-protocol-gas'), historyList = el('ul', null, 'admin-protocol-history'); history.append(el('summary', 'Control history'), historyList);
  element.append(heading, status, globalRow, listHead, filter.element, cards, pages.element, history);
  let snapshot = null, revision = 0, disposed = false, loading = false, busy = false, active = false, timer = null, viewOwner = null, loadedAt = 0, snapshotDay = '';
  const accountIdentity = () => getAccount()?.id ?? getAccount();
  const permitted = () => !disposed && getAccount()?.role === 'admin' && getAccount()?.mfaEnabled === true;
  const permittedAt = (generation, owner) => permitted() && revision === generation && accountIdentity() === owner;
  function stop() { if (timer !== null) { clearTimer(timer); timer = null; } }
  function schedule() { stop(); if (active && permitted() && isActive() && !document.hidden && !busy) timer = setTimer(() => { if (permitted() && isActive() && !document.hidden) void load(); else stop(); }, POLL_MS); }
  function controls() { const disabled = !permitted() || !snapshot || loading || busy; refresh.disabled = !permitted() || loading || busy; reason.disabled = disabled; globalToggle.disabled = disabled; for (const button of cards.querySelectorAll('button')) button.disabled = disabled; globalToggle.textContent = snapshot?.enabled === false ? 'Resume new Gotchi launches' : 'Pause new Gotchi launches'; }
  function clear() { revision++; stop(); snapshot = null; viewOwner = null; loadedAt = 0; loading = false; busy = false; active = false; element.hidden = true; status.textContent = ''; cards.replaceChildren(); pages.update({ total: 0 }); filter.cancel(); historyList.replaceChildren(); reason.value = ''; delete element.dataset.adminSummary; controls(); }
  function renderList() {
    const rows = Array.isArray(snapshot?.gotchis) ? snapshot.gotchis : [], paused = row => Object.entries(row.flags || {}).some(([key, value]) => key.endsWith('Paused') && value === true);
    const page = pageRows(rows, { offset: query.offset, q: query.q, fields: ['name', 'vault', 'id', row => row.launch?.mint, row => row.launch?.symbol, row => row.launch?.name], keep: row => query.chip === 'paused' ? paused(row) : query.chip === 'pending' ? !!row.pending : true, limit: PAGE_SIZE });
    query.offset = page.offset;
    filter.setChips([{ key: '', label: 'All', count: rows.length }, { key: 'paused', label: 'Paused', count: rows.filter(paused).length }, { key: 'pending', label: 'Confirming', count: rows.filter(row => !!row.pending).length }]);
    listTitle.textContent = `Gotchis (${rows.length.toLocaleString('en-US')})`;
    cards.replaceChildren(...page.rows.map(renderGotchi)); if (!page.rows.length) cards.append(el('p', rows.length ? 'No Gotchis match this filter.' : 'No Gotchi launches yet.', 'help'));
    pages.update({ offset: page.offset, limit: PAGE_SIZE, total: page.total, shown: page.rows.length });
    element.dataset.adminSummary = `${rows.length.toLocaleString('en-US')} Gotchis · ${rows.filter(paused).length} paused`;
  }
  function requireReason() { const text = reason.value.trim(); if (text.length < 5 || text.length > 500) { message('Enter a reason from 5 to 500 characters.', true); return null; } return text; }
  async function act(label, path, body) {
    if (viewOwner !== accountIdentity()) { clear(); return; } if (!permitted() || element.hidden || !isActive()) return;
    const generation = revision, owner = accountIdentity(); busy = true; stop(); controls();
    try { const credentials = await security.authorize(label, { requireCode: true }); if (!permittedAt(generation, owner) || !isActive()) return; await api(path, { ...body, ...credentials }); if (!permittedAt(generation, owner)) return; message(label + ' saved.'); reason.value = ''; await load(true); }
    catch (error) { if (permittedAt(generation, owner) && error?.message !== 'Cancelled.') message(error?.message || 'The Gotchi control could not be confirmed. Refresh before trying again.', true); }
    finally { if (generation === revision) { if (!permittedAt(generation, owner)) { clear(); return; } busy = false; controls(); schedule(); } }
  }
  function facts(rows) { const box = el('div', null, 'admin-gas-facts'); for (const [label, value] of rows) { const item = el('div', null, 'admin-stat'); item.append(el('span', label), el('strong', value)); box.append(item); } return box; }
  function renderGotchi(row) {
    const card = el('div', null, 'admin-gotchi-card'); card.dataset.gotchi = row.id;
    const head = el('div', null, 'admin-card-heading'), title = el('div'); title.append(el('h3', row.name), el('p', null, 'help')); head.append(title); card.append(head);
    if (row.error && !row.vault) { card.append(el('p', row.error, 'admin-gas-warning')); return card; }
    const walletLine = el('p', null, 'help'); walletLine.append('Vault ', shortened(link('account', row.vault, row.vault), row.vault), row.balance ? ' · on-chain ' + sol(row.balance.sol) + ' at ' + when(row.balance.at) : ' · balance awaiting a fresh read'); card.append(walletLine);
    const pot = row.pot || {}, race = row.race || {};
    card.append(facts([['Pot value', pot.potUsd === null || pot.potUsd === undefined ? '—' : money(pot.potUsd)], ['Realized SOL', sol(pot.realizedSol)], ['Spendable', sol(pot.spendableSol)], ['Frozen', sol(pot.frozenSol)], ['Race', '#' + (race.index || 1) + ' · ' + (race.status || '—')], ['Samples', String(race.sampleCount ?? 0)], ['Network spent', sol(pot.networkSpentSol)], ['Gas today', sol(row.gas?.day === snapshotDay ? number(row.gas?.used) / 1e9 : 0)]]));
    const flagRow = el('div', null, 'admin-gotchi-flags');
    for (const [key, label, help] of FLAGS) { const paused = row.flags?.[key] === true, lower = label[0].toLowerCase() + label.slice(1), button = el('button', (paused ? 'Resume ' : 'Pause ') + lower, 'small-button'); button.type = 'button'; button.title = help; button.dataset.state = paused ? 'paused' : 'running'; button.onclick = () => { const text = requireReason(); if (!text) return; void act((paused ? 'Resume ' : 'Pause ') + lower + ' for ' + row.name, '/api/admin/gotchi/control', { id: row.id, [key]: !paused, reason: text }); }; const wrap = el('div', null, 'admin-gotchi-flag'); wrap.append(button, el('span', paused ? 'Paused' : 'Running', paused ? 'admin-gotchi-paused' : 'admin-gotchi-running')); flagRow.append(wrap); }
    const retry = el('button', 'Retry now', 'small-button'); retry.type = 'button'; retry.title = 'Clear backoffs and re-check the saved transaction, contributions, conversions and settlement immediately.'; retry.onclick = () => { const text = requireReason(); if (!text) return; void act('Retry Gotchi steps for ' + row.name, '/api/admin/gotchi/retry', { id: row.id, reason: text }); };
    const retryWrap = el('div', null, 'admin-gotchi-flag'); retryWrap.append(retry); flagRow.append(retryWrap); card.append(flagRow);
    if (row.flags?.reason) card.append(el('p', 'Last control: ' + row.flags.reason + ' · ' + when(row.flags.updatedAt), 'help'));
    if (row.pending) { const pending = el('p', null, 'admin-gas-warning'); pending.append('Saved transaction ' + row.pending.kind + ' (' + (row.pending.stage || 'service') + ') is confirming: ', link('tx', row.pending.signature, 'View ↗'), row.pendingError ? ' · ' + row.pendingError : ''); card.append(pending); }
    const retries = Object.entries(row.retry || {}).filter(([, value]) => value.error);
    const retryLabel = key => { if (!key.startsWith('convert:')) return RETRY_LABELS[key] || key; const mint = key.slice(8), asset = (row.assets || []).find(item => item.mint === mint); return 'Conversion of ' + (asset?.symbol || (mint.length > 12 ? mint.slice(0, 4) + '…' + mint.slice(-4) : mint)); };
    if (retries.length) { const list = el('ul', null, 'admin-protocol-history'); for (const [key, value] of retries) list.append(el('li', retryLabel(key) + ': ' + value.error + ' · attempts ' + value.attempts + (value.nextAttemptAt ? ' · next ' + when(value.nextAttemptAt) : ''))); card.append(el('h4', 'Retries'), list); }
    if (row.error) card.append(el('p', 'Service note: ' + row.error, 'help'));
    if (race.settlement) { const settlement = race.settlement, line = el('p', null, 'help'); line.append('Settlement: winner ', link('token', settlement.winner?.mint, settlement.winner?.mint ? settlement.winner.mint.slice(0, 6) + '…' : '—'), ' · ' + settlement.winners?.length + ' winners · pot ' + sol(settlement.potSol) + ' · buy ' + sol(settlement.buySol) + ' · remaining to buy ' + sol(number(settlement.buyRemainingLamports) / 1e9) + ' · airdrops ' + settlement.index + '/' + (settlement.payouts?.length ?? '—') + (settlement.buyNote ? ' · ' + settlement.buyNote : '')); card.append(line); }
    const assets = (row.assets || []).filter(asset => number(asset.credit) > 0);
    if (assets.length) { const list = el('ul', null, 'admin-protocol-history'); for (const asset of assets) { const amount = tokens(asset.credit, asset.decimals), name = asset.symbol || (typeof asset.mint === 'string' && asset.mint.length > 12 ? asset.mint.slice(0, 4) + '…' + asset.mint.slice(-4) : asset.mint || 'Token'); list.append(el('li', (amount === null ? name + ': ' + asset.credit + ' raw units' : amount + ' ' + name) + ' awaiting conversion' + (asset.error ? ' · ' + asset.error : ''))); } card.append(el('h4', 'Collected assets'), list); }
    const coins = row.coins || []; const coinsBox = el('details', null, 'admin-protocol-gas'); coinsBox.append(el('summary', 'Attached coins · ' + coins.length + ' (' + coins.filter(coin => coin.graduated).length + ' graduated)'));
    const coinList = el('ul', null, 'admin-protocol-history'); for (const coin of coins) { const item = el('li'); item.append(link('token', coin.mint, '$' + (coin.symbol || coin.mint.slice(0, 6))), ' · ' + coin.venue + ' · ' + (coin.graduated ? 'graduated ' + when(coin.graduatedAt) : 'curve') + (coin.live === false ? ' · inactive' : '') + (coin.archived ? ' · archived' : '') + ' · contributed ' + coin.contributedRaw + ' raw' + (coin.sampleError ? ' · sample: ' + coin.sampleError : '')); coinList.append(item); } if (!coins.length) coinList.append(el('li', 'No coins paired yet.', 'help')); coinsBox.append(coinList); card.append(coinsBox);
    const ops = el('details', null, 'admin-protocol-gas'); ops.append(el('summary', 'Recent transactions · ' + (row.history || []).length));
    const opList = el('ul', null, 'admin-protocol-history'); for (const op of row.history || []) { const item = el('li'); item.append((op.state === 'confirmed' ? 'Confirmed' : 'Not completed') + ' ' + op.kind + ' · ' + when(op.confirmedAt) + ' · in ' + op.inputAmount + ' out ' + op.outputAmount + ' '); if (signature(op.signature)) item.append(link('tx', op.signature, 'View ↗')); opList.append(item); } if (!opList.children.length) opList.append(el('li', 'No transactions yet.', 'help')); ops.append(opList); card.append(ops);
    return card;
  }
  function render(data) {
    if (!data || data.version !== 1 || !Array.isArray(data.gotchis)) throw Error('Gotchi snapshot unavailable.');
    snapshot = data; element.hidden = false; loadedAt = clock(); snapshotDay = utcDay(data.at);
    status.textContent = (data.enabled === false ? 'New Gotchi launches are paused. ' : 'New Gotchi launches are open. ') + 'Snapshot ' + when(data.at) + '. Policy: goal ' + money(data.policy?.goalUsd) + ', top ' + data.policy?.topHolders + ', gas reserve ' + sol(number(data.policy?.gasReserveLamports) / 1e9) + ', daily network cap ' + sol(number(data.policy?.dailyNetworkLimitLamports) / 1e9) + '.';
    renderList();
    historyList.replaceChildren(); for (const row of data.controls || []) historyList.append(el('li', when(row.at) + ' · ' + (row.actor || row.actorId) + ' · ' + (row.id || 'all') + ' · ' + Object.entries(row).filter(([key, value]) => ['enabled', 'collectionPaused', 'conversionPaused', 'settlementPaused', 'samplingPaused'].includes(key) && value !== null && value !== undefined).map(([key, value]) => key + '=' + value).join(' ') + ' · ' + row.reason)); if (!historyList.children.length) historyList.append(el('li', 'No control changes recorded.', 'help'));
    controls();
  }
  async function load(force = false) {
    if (!permitted()) { clear(); return; } if (!isActive()) { stop(); return; } const owner = accountIdentity(); if (viewOwner !== null && viewOwner !== owner) clear(); viewOwner = owner; active = true;
    if (document.hidden && !force) { schedule(); return; } if (loading || (busy && !force)) return; loading = true; element.hidden = false; controls(); const generation = revision; if (!snapshot) status.textContent = 'Loading Gotchi status…';
    try { const data = await api('/api/admin/gotchi'); if (permittedAt(generation, owner)) render(data); }
    catch { if (permittedAt(generation, owner)) status.textContent = snapshot ? 'Gotchi status could not be refreshed. Showing the last saved snapshot.' : 'Gotchi status is temporarily unavailable. Use Refresh to try again.'; }
    finally { if (generation === revision) { if (!permittedAt(generation, owner)) { clear(); return; } loading = false; controls(); schedule(); } }
  }
  globalToggle.onclick = () => { const text = requireReason(); if (!text || !snapshot) return; const enabled = snapshot.enabled === false; void act((enabled ? 'Resume' : 'Pause') + ' new Gotchi launches', '/api/admin/gotchi/control', { enabled, reason: text }); };
  function pause() { active = false; stop(); }
  // Opening the page again reuses a snapshot younger than one poll interval and only restarts polling.
  function show() { if (permitted() && isActive() && snapshot && viewOwner === accountIdentity() && clock() - loadedAt < POLL_MS) { active = true; schedule(); return; } return load(); }
  function visibility() { if (document.hidden || !isActive()) { stop(); return; } if (active && permitted()) void load(); }
  function destroy() { clear(); disposed = true; document.removeEventListener('visibilitychange', visibility); }
  refresh.onclick = () => load(true); document.addEventListener('visibilitychange', visibility); clear(); return { element, load, show, clear, pause, destroy };
}
