// Admin → Tokens → Vanity addresses: the owner's pool of vanity contract
// addresses. Add keypairs (pasted base58 private keys, "address,privatekey"
// lines, or the .json files `solana-keygen grind` writes) from a dialog, browse
// the pool and the "Used vanity" list 25 at a time with a prefix/state filter,
// and remove addresses the pool no longer needs. Keys travel once, with the
// owner's password and 2FA code, and are never shown again: the API returns
// addresses only, and this view prints only the fields it knows.
import { PAGE_SIZE, copyButton, exactTime, filterBar, hashState, pager, timeNode } from './admin-list-kit.mjs';
const POLL_MS = 60000;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const VENUES = Object.freeze({ pump: 'Pump.fun', raydium: 'Raydium', meteora: 'Meteora' });
const SCOPES = Object.freeze([['all', 'Every launch'], ['pump', 'Pump.fun launches only'], ['raydium', 'Raydium launches only'], ['meteora', 'Meteora launches only']]);
const SCOPE_LABEL = Object.freeze({ all: 'Every launch', pump: 'Pump.fun', raydium: 'Raydium', meteora: 'Meteora' });
const POOL_CHIPS = Object.freeze([['', 'All'], ['available', 'Available'], ['reserved', 'Held'], ['pump', 'For Pump.fun'], ['raydium', 'For Raydium'], ['meteora', 'For Meteora'], ['all', 'For every launch']]);
const USED_CHIPS = Object.freeze([['', 'All'], ['used', 'Used'], ['skipped', 'Skipped'], ['pump', 'Pump.fun'], ['raydium', 'Raydium'], ['meteora', 'Meteora']]);
const MAX_FILE_BYTES = 64 * 1024, MAX_TOTAL_BYTES = 960 * 1024, MAX_FILES = 2000;
const when = value => Number.isSafeInteger(value) && value > 0 ? exactTime(value) : '—';
const plural = (n, one, many) => `${Number(n) || 0} ${Number(n) === 1 ? one : many}`;
const whole = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const text = (value, max = 80) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max) : '';
const page = value => { const n = Number(value); return Number.isSafeInteger(n) && n > 1 ? n : 1; };

/** Reads the chosen key files as text (each at most 64 KB). */
async function readChosenFiles(input) {
  return Promise.all([...(input?.files || [])].slice(0, MAX_FILES).map(async file => file.size > MAX_FILE_BYTES ? { name: file.name, text: '', tooLarge: true } : { name: file.name, text: await file.text() }));
}

export function createAdminVanity({ document, api, security, message = () => {}, getAccount, isActive = () => true, setTimer = setInterval, clearTimer = clearInterval, readFiles = readChosenFiles, clock = Date.now, pageSize = PAGE_SIZE } = {}) {
  const el = (tag, value, cls) => { const node = document.createElement(tag); if (value != null) node.textContent = String(value); if (cls) node.className = cls; return node; };
  const view = document.defaultView || null;
  const element = el('section', null, 'admin-card admin-vanity'); element.id = 'admin-vanity';
  const heading = el('div', null, 'admin-card-heading'), copy = el('div'), headActions = el('div', null, 'admin-inline-actions');
  const refresh = el('button', 'Refresh', 'text-button'); refresh.type = 'button'; refresh.id = 'admin-vanity-refresh';
  const openAdd = el('button', 'Add addresses', 'small-button admin-primary'); openAdd.type = 'button'; openAdd.id = 'admin-vanity-open-add'; openAdd.dataset.adminPageAction = 'true';
  copy.append(el('p', 'LAUNCH OPERATIONS / VANITY ADDRESSES', 'eyebrow'), el('h2', 'Vanity contract addresses'), el('p', 'Every new Pump.fun, Raydium and Meteora launch takes its coin’s address from this pool while one is left. Private keys stay encrypted on the server; this page only ever shows addresses.'));
  headActions.append(openAdd, refresh); heading.append(copy, headActions);
  const status = el('p', '', 'admin-revenue-status'); status.id = 'admin-vanity-status'; status.setAttribute('role', 'status');
  const warnings = el('div'); warnings.id = 'admin-vanity-warnings';
  const facts = el('div', null, 'admin-gas-facts'); facts.id = 'admin-vanity-facts';
  // ---- add dialog (the form keeps its ids; it is only shown while adding)
  const dialog = el('dialog', null, 'admin-dialog admin-vanity-dialog'); dialog.id = 'admin-vanity-dialog'; dialog.setAttribute('aria-label', 'Add vanity addresses');
  const dialogHead = el('div', null, 'admin-dialog-heading'), dialogClose = el('button', 'Cancel', 'small-button'); dialogClose.type = 'button'; dialogClose.id = 'admin-vanity-cancel';
  dialogHead.append(el('h2', 'Add to the pool'), dialogClose);
  const form = el('form', null, 'admin-protocol-form admin-vanity-form'); form.id = 'admin-vanity-add'; form.noValidate = true;
  const keysLabel = el('label', 'Private keys', 'admin-protocol-wide'), keys = el('textarea'); keys.id = 'admin-vanity-keys'; keys.rows = 6;
  keys.placeholder = 'One per line: a base58 private key, or address,privatekey';
  for (const [name, value] of [['autocomplete', 'off'], ['autocapitalize', 'off'], ['autocorrect', 'off'], ['spellcheck', 'false'], ['data-gramm', 'false'], ['data-lpignore', 'true']]) keys.setAttribute(name, value);
  keysLabel.append(keys);
  const filesLabel = el('label', 'Key files'), files = el('input'); files.id = 'admin-vanity-files'; files.type = 'file'; files.multiple = true; files.accept = '.json,.txt,.csv'; filesLabel.append(files);
  const scopeLabel = el('label', 'Use for'), scope = el('select'); scope.id = 'admin-vanity-scope';
  for (const [value, label] of SCOPES) { const option = el('option', label); option.value = value; scope.append(option); }
  scopeLabel.append(scope);
  const formHelp = el('p', 'Accepted: the .json files from solana-keygen grind (select them all at once), base58 private keys as exported by Phantom, one per line, and address,privatekey lines. Keys are sent once with your password and 2FA code, stored encrypted, and never shown again. Addresses for one venue are used before addresses for every launch.', 'help admin-protocol-wide');
  const add = el('button', 'Add to pool', 'small-button admin-primary'); add.type = 'submit'; add.id = 'admin-vanity-submit';
  form.append(keysLabel, filesLabel, scopeLabel, formHelp, add);
  dialog.append(dialogHead, form);
  const result = el('p', '', 'help'); result.id = 'admin-vanity-result'; result.setAttribute('role', 'status');
  // ---- lists: one search for both, a state filter and 25 rows a page each
  const search = filterBar(document, { placeholder: 'Find an address (prefix or any part), coin or ticker', label: 'Find a vanity address', chips: [], onChange: ({ q }) => { query.search = q; pool.offset = used.offset = 0; writeState(); void load(true); } });
  search.input.id = 'admin-vanity-search'; search.element.classList.add('admin-sticky-tools');
  const poolHead = el('div', null, 'admin-list-head'), poolTitle = el('h3', 'Pool'), poolTools = el('div', null, 'admin-list-tools');
  const poolFilter = filterBar(document, { label: 'Pool filter', chips: POOL_CHIPS.map(([key, label]) => ({ key, label })), onChange: ({ chip }) => { pool.state = chip; pool.offset = 0; writeState(); void load(true); } });
  poolFilter.input.hidden = true; poolFilter.input.tabIndex = -1; poolFilter.element.classList.add('admin-filter-chips-only');
  const selectPage = el('button', 'Select page', 'small-button cv-sm'); selectPage.type = 'button'; selectPage.id = 'admin-vanity-select-page';
  const remove = el('button', 'Remove selected', 'small-button cv-sm admin-danger'); remove.type = 'button'; remove.id = 'admin-vanity-remove';
  poolTools.append(poolFilter.element, selectPage, remove); poolHead.append(poolTitle, poolTools);
  const poolBox = el('div'); poolBox.id = 'admin-vanity-pool';
  const poolPager = pager(document, { label: 'addresses', onPage: offset => { pool.offset = offset; writeState({ push: true }); void load(true); } });
  const usedHead = el('div', null, 'admin-list-head'), usedTitle = el('h3', 'Used vanity'), usedTools = el('div', null, 'admin-list-tools');
  const usedFilter = filterBar(document, { label: 'Used filter', chips: USED_CHIPS.map(([key, label]) => ({ key, label })), onChange: ({ chip }) => { used.state = chip; used.offset = 0; writeState(); void load(true); } });
  usedFilter.input.hidden = true; usedFilter.input.tabIndex = -1; usedFilter.element.classList.add('admin-filter-chips-only');
  usedTools.append(usedFilter.element); usedHead.append(usedTitle, usedTools);
  const usedBox = el('div'); usedBox.id = 'admin-vanity-used';
  const usedPager = pager(document, { label: 'addresses', onPage: offset => { used.offset = offset; writeState({ push: true }); void load(true); } });
  const activityBox = el('details', null, 'admin-protocol-gas'), activityTitle = el('summary', 'Recent activity'), activity = el('ul', null, 'admin-protocol-history'); activity.id = 'admin-vanity-activity'; activityBox.append(activityTitle, activity);
  element.append(heading, status, warnings, facts, result, search.element, poolHead, poolBox, poolPager.element, usedHead, usedBox, usedPager.element, activityBox, dialog);
  let snapshot = null, revision = 0, disposed = false, loading = false, busy = false, active = false, timer = null, viewOwner = null, loadedAt = 0;
  const query = { search: '' }, pool = { offset: 0, state: '' }, used = { offset: 0, state: '' }, state = hashState(view, { prefix: 'vanity' });
  const accountIdentity = () => getAccount()?.id ?? getAccount();
  const permitted = () => !disposed && getAccount()?.role === 'admin' && getAccount()?.mfaEnabled === true;
  const permittedAt = (generation, owner) => permitted() && revision === generation && accountIdentity() === owner;
  const selected = () => [...poolBox.querySelectorAll('input[type=checkbox]'), ...usedBox.querySelectorAll('input[type=checkbox]')].filter(box => box.checked && !box.disabled && ADDRESS.test(box.value)).map(box => box.value);
  const checkbox = (address, enabled) => { const box = el('input'); box.type = 'checkbox'; box.value = address; box.disabled = !enabled; box.setAttribute('aria-label', 'Select ' + address); box.onchange = controls; return box; };
  function stop() { if (timer !== null) { clearTimer(timer); timer = null; } }
  function schedule() { stop(); if (active && permitted() && isActive() && !document.hidden && !busy) timer = setTimer(() => { if (permitted() && isActive() && !document.hidden) void load(); else stop(); }, POLL_MS); }
  function controls() {
    const disabled = !permitted() || !snapshot || loading || busy; refresh.disabled = !permitted() || loading || busy;
    for (const node of [keys, files, scope, add, openAdd, search.input, selectPage]) node.disabled = disabled;
    const count = selected().length; remove.disabled = disabled || !count; remove.textContent = count ? `Remove selected (${count})` : 'Remove selected';
    selectPage.disabled = disabled || !poolBox.querySelector('input[type=checkbox]:not(:disabled)');
  }
  function clearInputs() { keys.value = ''; files.value = ''; }
  function closeDialog() { clearInputs(); if (dialog.open) { if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open'); } }
  function openDialog() { if (!permitted() || !snapshot || busy) return; result.textContent = ''; if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', ''); keys.focus?.(); }
  // The list state lives in the hash (#tokens/vanity?q=…&vanity.pool=2) so Back returns to the same page.
  function readState() { query.search = state.get('q'); pool.state = state.get('pool.state'); used.state = state.get('used.state'); pool.offset = (page(state.get('pool')) - 1) * pageSize; used.offset = (page(state.get('used')) - 1) * pageSize; search.set({ q: query.search }); poolFilter.set({ chip: pool.state }); usedFilter.set({ chip: used.state }); }
  function writeState(options) { state.set({ q: query.search, 'pool.state': pool.state, 'used.state': used.state, pool: pool.offset ? Math.floor(pool.offset / pageSize) + 1 : 0, used: used.offset ? Math.floor(used.offset / pageSize) + 1 : 0 }, options); }
  function clear() { revision++; stop(); snapshot = null; viewOwner = null; loadedAt = 0; loading = false; busy = false; active = false; element.hidden = true; status.textContent = ''; result.textContent = ''; warnings.replaceChildren(); facts.replaceChildren(); poolBox.replaceChildren(); usedBox.replaceChildren(); activity.replaceChildren(); poolPager.update({ total: 0 }); usedPager.update({ total: 0 }); closeDialog(); search.cancel(); delete element.dataset.adminSummary; controls(); }
  function fact(label, value) { const item = el('div', null, 'admin-stat'); item.append(el('span', label), el('strong', value)); return item; }
  function address(value, link = false) {
    if (!ADDRESS.test(value || '')) return el('span', '—');
    // The full address stays in the text; on narrow screens it gives way in the middle. A copy button sits next to it.
    const wrap = el('span', null, 'admin-address-cell');
    const shortened = node => { node.replaceChildren(el('span', value.slice(0, -6)), el('span', value.slice(-6))); node.classList.add('admin-address'); node.setAttribute('title', value); return node; };
    let node;
    if (!link) node = shortened(el('span', value, 'admin-revenue-mint'));
    else { node = shortened(el('a', value, 'admin-revenue-mint')); node.href = '/coin?mint=' + encodeURIComponent(value); node.target = '_blank'; node.rel = 'noopener noreferrer'; }
    wrap.append(node, copyButton(document, value)); return wrap;
  }
  function table(headers, rows) {
    const wrap = el('div', null, 'admin-revenue-table-wrap'), t = el('table', null, 'admin-revenue-table'), head = el('thead'), headRow = el('tr'), body = el('tbody');
    for (const header of headers) headRow.append(el('th', header));
    head.append(headRow); for (const cells of rows) { const tr = el('tr'); for (const cell of cells) { const td = el('td'); td.append(typeof cell === 'object' && cell !== null && 'nodeType' in cell ? cell : el('span', cell)); tr.append(td); } body.append(tr); }
    t.append(head, body); wrap.append(t); return wrap;
  }
  function chainState(row) {
    if (row.state === 'skipped') return text(row.reason, 200) || 'Skipped';
    return row.onChain === true ? 'Created' : row.onChain === false ? 'Not created yet' : '—';
  }
  const filtering = () => !!(query.search || pool.state || used.state);
  function render(data) {
    snapshot = data; element.hidden = false; loadedAt = clock(); const now = clock();
    const counts = data?.counts || {}, forVenue = counts.forVenue || {}, fallbacks = data?.fallbacks || {};
    status.textContent = `${plural(whole(counts.available), 'address', 'addresses')} available · ${whole(counts.reserved)} held by launches in progress · ${whole(counts.used)} used${whole(counts.skipped) ? ` · ${whole(counts.skipped)} skipped` : ''}. Updated ${when(data?.at)}.`;
    element.dataset.adminSummary = `${whole(counts.available).toLocaleString('en-US')} available · ${whole(counts.reserved)} held · ${whole(counts.used).toLocaleString('en-US')} used`;
    warnings.replaceChildren();
    const low = (Array.isArray(data?.low) ? data.low : []).filter(v => VENUES[v]);
    const names = low.map(v => VENUES[v]), list = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names.at(-1) : names[0];
    if (low.length) warnings.append(el('p', `Fewer than ${whole(data.lowWater) || 10} addresses are left for ${list} launches. Add more below; when none are left, launches use a random address.`, 'admin-gas-warning'));
    if (whole(fallbacks.sinceImport) > 0) warnings.append(el('p', `${plural(whole(fallbacks.sinceImport), 'launch', 'launches')} used a random address because no vanity address was left (last: ${VENUES[fallbacks.lastVenue] || '—'}, ${when(fallbacks.lastAt)}).`, 'admin-gas-warning'));
    const checkedAt = data?.checks?.lastFailureAt;
    if (Number.isSafeInteger(checkedAt) && Number.isSafeInteger(data?.at) && data.at - checkedAt < 3600000) warnings.append(el('p', `The chain could not be asked whether an address was free (last at ${when(checkedAt)}). Until it answers, launches use random addresses; check the RPC connection if this persists.`, 'admin-gas-warning'));
    facts.replaceChildren(fact('For Pump.fun launches', String(whole(forVenue.pump))), fact('For Raydium launches', String(whole(forVenue.raydium))), fact('For Meteora launches', String(whole(forVenue.meteora))), fact('Used', String(whole(counts.used))));
    const poolRows = Array.isArray(data?.pool) ? data.pool.filter(row => ADDRESS.test(row?.address || '')) : [], poolTotal = whole(data?.poolTotal ?? poolRows.length), poolMatched = whole(data?.poolMatched ?? poolTotal);
    poolTitle.textContent = `Pool (${poolTotal.toLocaleString('en-US')})` + (filtering() && poolMatched !== poolTotal ? ` · ${poolMatched.toLocaleString('en-US')} match` : '');
    poolBox.replaceChildren(poolRows.length ? table(['', 'Address', 'Use for', 'Added', 'Status'], poolRows.map(row => {
      const box = checkbox(row.address, row.state === 'available');
      const holder = VENUES[row.venue] ? `a ${VENUES[row.venue]} launch` : 'a launch';
      return [box, address(row.address), SCOPE_LABEL[row.scope] || '—', timeNode(document, row.addedAt, { now }), row.state === 'reserved' ? `Held by ${holder} in progress until ${when(row.until)}` : 'Available'];
    })) : el('p', poolMatched === 0 && filtering() ? 'No pool addresses match this filter.' : 'The pool is empty. New launches use a random address until you add some.', 'help'));
    poolPager.update({ offset: whole(data?.poolOffset ?? pool.offset), limit: whole(data?.poolLimit) || pageSize, total: poolMatched, shown: poolRows.length });
    const usedRows = Array.isArray(data?.used) ? data.used.filter(row => ADDRESS.test(row?.address || '')) : [], usedTotal = whole(data?.usedTotal ?? usedRows.length), usedMatched = whole(data?.usedMatched ?? usedTotal);
    usedTitle.textContent = `Used vanity (${usedTotal.toLocaleString('en-US')})` + (filtering() && usedMatched !== usedTotal ? ` · ${usedMatched.toLocaleString('en-US')} match` : '');
    // A skipped address keeps its key, set aside; selecting it and removing it deletes the key.
    usedBox.replaceChildren(usedRows.length ? table(['', 'Address', 'Coin', 'Launch', 'Used', 'Onchain'], usedRows.map(row => [
      checkbox(row.address, row.state === 'skipped'), address(row.address, row.state === 'used'), row.state === 'used' ? [text(row.symbol, 24) ? '$' + text(row.symbol, 24) : '', text(row.name, 64)].filter(Boolean).join(' · ') || '—' : '—', VENUES[row.venue] || '—', timeNode(document, row.at, { now }), chainState(row),
    ])) : el('p', usedMatched === 0 && filtering() ? 'No used addresses match this filter.' : 'No vanity address has been used yet.', 'help'));
    usedPager.update({ offset: whole(data?.usedOffset ?? used.offset), limit: whole(data?.usedLimit) || pageSize, total: usedMatched, shown: usedRows.length });
    const events = Array.isArray(data?.events) ? data.events.slice(0, 12) : [];
    activity.replaceChildren(...events.map(event => { const li = el('li'); li.append(el('span', text(event?.text, 300)), timeNode(document, event?.at, { now })); return li; }));
    activityTitle.textContent = `Recent activity · ${events.length}`; activityBox.hidden = !events.length;
    controls();
  }
  const params = () => { const p = new URLSearchParams(); if (query.search) p.set('search', query.search); p.set('poolOffset', String(pool.offset)); p.set('poolLimit', String(pageSize)); if (pool.state) p.set('poolState', pool.state); p.set('usedOffset', String(used.offset)); p.set('usedLimit', String(pageSize)); if (used.state) p.set('usedState', used.state); return p.toString(); };
  async function act(label, path, body) {
    if (viewOwner !== accountIdentity()) { clear(); return null; } if (!permitted() || element.hidden || !isActive()) return null;
    const generation = revision, owner = accountIdentity(); busy = true; stop(); controls();
    try {
      const credentials = await security.authorize(label, { requireCode: true }); if (!permittedAt(generation, owner) || !isActive()) return null;
      const value = await api(path, { ...body, ...credentials }); if (!permittedAt(generation, owner)) return null;
      // An action's view is the unfiltered snapshot: shown as is unless a filter or a later page is active, which reads again.
      if (value?.view && !filtering() && !pool.offset && !used.offset) render(value.view); else if (value?.view) await read(generation, owner); return value;
    } catch (error) { if (permittedAt(generation, owner) && error?.message !== 'Cancelled.') { if (path.endsWith('/import')) clearInputs(); message(error?.message || 'The request could not be confirmed. Refresh before trying again.', true); } return null; }
    finally { if (generation === revision) { if (!permittedAt(generation, owner)) { clear(); return; } busy = false; controls(); schedule(); } }
  }
  async function submit(event) {
    event?.preventDefault?.(); if (busy || !snapshot) return;
    const entries = [];
    if (keys.value.trim()) entries.push({ name: 'pasted text', text: keys.value });
    let chosen = []; try { chosen = await readFiles(files); } catch { message('The key files could not be read.', true); return; }
    const tooLarge = chosen.filter(file => file.tooLarge).map(file => file.name);
    if (tooLarge.length) { message(`These files are too large to be key files: ${tooLarge.slice(0, 3).join(', ')}${tooLarge.length > 3 ? '…' : ''}`, true); return; }
    entries.push(...chosen.map(file => ({ name: text(file.name, 120) || 'file', text: file.text })));
    if (!entries.length) { message('Paste private keys or choose key files first.', true); return; }
    if (entries.reduce((sum, entry) => sum + entry.text.length + entry.name.length + 16, 0) > MAX_TOTAL_BYTES) { message('That is too much at once. Add at most 2,000 keys per batch.', true); return; }
    const value = await act('Add vanity addresses', '/api/admin/vanity/import', { entries, scope: scope.value });
    if (!value) return;
    closeDialog();
    const added = Array.isArray(value.added) ? value.added.length : 0, rejected = Array.isArray(value.rejected) ? value.rejected : [];
    result.textContent = `Added ${plural(added, 'address', 'addresses')}.` + (rejected.length ? ` Not added (${rejected.length}): ` + rejected.slice(0, 20).map(r => `${text(r.where, 140)} — ${text(r.reason, 100)}`).join('; ') + (rejected.length > 20 ? '; …' : '') + '.' : '') + (value.truncated ? ' Only the first 2,000 keys were read.' : '');
    message(added ? `${plural(added, 'vanity address', 'vanity addresses')} added.` : 'No new addresses were added.', !added);
  }
  async function removeSelected() {
    const addresses = selected(); if (!addresses.length) return;
    const value = await act(`Remove ${plural(addresses.length, 'address', 'addresses')} from the pool`, '/api/admin/vanity/remove', { addresses });
    if (!value) return;
    const kept = Array.isArray(value.kept) ? value.kept : [];
    result.textContent = `Removed ${plural(Array.isArray(value.removed) ? value.removed.length : 0, 'address', 'addresses')}.` + (kept.length ? ' Kept: ' + kept.slice(0, 10).map(k => `${text(k.address, 44)} — ${text(k.reason, 100)}`).join('; ') + '.' : '');
    message(result.textContent.split(' Kept:')[0]);
  }
  async function read(generation, owner) {
    const data = await api('/api/admin/vanity?' + params()); if (permittedAt(generation, owner)) render(data);
  }
  async function load(force = false) {
    if (!permitted()) { clear(); return; } if (!isActive()) { stop(); return; } const owner = accountIdentity(); if (viewOwner !== null && viewOwner !== owner) clear(); viewOwner = owner; active = true;
    if (document.hidden && !force) { schedule(); return; } if (loading || (busy && !force)) return; loading = true; element.hidden = false; controls(); const generation = revision; if (!snapshot) status.textContent = 'Loading vanity addresses…';
    try { await read(generation, owner); }
    catch { if (permittedAt(generation, owner)) status.textContent = snapshot ? 'Vanity addresses could not be refreshed. Showing the last snapshot.' : 'Vanity addresses are temporarily unavailable. Use Refresh to try again.'; }
    finally { if (generation === revision) { if (!permittedAt(generation, owner)) { clear(); return; } loading = false; controls(); schedule(); } }
  }
  // Leaving the page (or hiding the browser tab) clears pasted keys and chosen key files, like the Husher key.
  function pause() { active = false; stop(); if (!busy) closeDialog(); }
  // Opening the page again reuses a snapshot younger than one poll interval and only restarts polling.
  function show() { const before = state.signature(); readState(); if (permitted() && isActive() && snapshot && viewOwner === accountIdentity() && clock() - loadedAt < POLL_MS && before === state.signature()) { active = true; schedule(); return; } return load(); }
  function visibility() { if (document.hidden) { stop(); if (!busy) closeDialog(); return; } if (!isActive()) { stop(); return; } if (active && permitted()) void load(); }
  // The browser's Back/Forward buttons change the hash: a changed list state reads its page again.
  let signature = '';
  function navigated() { if (!active || !permitted() || !isActive()) return; const next = state.signature(); if (next === signature) return; signature = next; readState(); void load(true); }
  function destroy() { clear(); disposed = true; document.removeEventListener('visibilitychange', visibility); view?.removeEventListener?.('popstate', navigated); }
  form.onsubmit = event => { void submit(event); }; remove.onclick = () => { void removeSelected(); };
  selectPage.onclick = () => { const boxes = [...poolBox.querySelectorAll('input[type=checkbox]:not(:disabled)')], all = boxes.every(box => box.checked); for (const box of boxes) box.checked = !all; controls(); };
  openAdd.onclick = openDialog; dialogClose.onclick = closeDialog; dialog.addEventListener('close', clearInputs); dialog.addEventListener('cancel', () => clearInputs());
  refresh.onclick = () => load(true); document.addEventListener('visibilitychange', visibility); view?.addEventListener?.('popstate', navigated);
  const firstLoad = load; const loadWithState = force => { readState(); signature = state.signature(); return firstLoad(force); };
  clear();
  return { element, load: loadWithState, reload: () => load(true), show, clear, pause, destroy, find: q => { search.set({ q }); query.search = q; pool.offset = used.offset = 0; writeState(); return load(true); } };
}
