// Admin → Tokens → Cleanup: every launch that stopped before it finished, across venues, in one paged list
// with the right action per row. Archive and restore use the existing per-request archive routes (nothing is
// deleted); Pump.fun refunds, SOL-refund releases and archives go through the owner's Pump.fun controls with a
// reason, the owner's password and 2FA code; "Archive all finished failures" runs the saved bulk archive (and,
// for the platform owner, archives every settled Pump.fun failure) after a confirmation and the identity prompt.
import { PAGE_SIZE, ageText, copyButton, exactTime, filterBar, hashState, inlineConfirm, pager, relativeTime } from './admin-list-kit.mjs';
const POLL_MS = 60000;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const KIND_CHIPS = Object.freeze([['', 'All'], ['failed', 'Failed'], ['unfinished', 'Never finished'], ['refund', 'Refunds'], ['abandoned', 'Abandoned quotes'], ['archived', 'Archived']]);
const VENUES = Object.freeze([['', 'Every venue'], ['raydium', 'Raydium'], ['pumpswap', 'PumpSwap'], ['meteora', 'Meteora'], ['pump-classic', 'Pump.fun']]);
const TONES = Object.freeze({ failed: 'bad', unfinished: 'warn', refund: 'warn', abandoned: '', archived: '' });
const ACTIONS = Object.freeze({
  archive: { label: 'Archive', title: 'Move this request to Archived tokens. Nothing is deleted.' },
  restore: { label: 'Restore', title: 'Bring this request back from Archived tokens.' },
  unarchive: { label: 'Restore', title: 'Bring this launch back from the archive.' },
  refund: { label: 'Refund', title: 'Refund this funded launch before creation (the Pump.fun worker returns its SOL).', danger: true },
  'release-sol-refund': { label: 'Release SOL refund', title: 'Refund the SOL now and keep retrying the pair refund.', danger: true },
  hide: { label: 'Hide', title: 'Hide this coin from public lists.' }, unhide: { label: 'Unhide', title: 'List this coin again.' },
});
const text = (value, max = 120) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max) : '';
const page = value => { const n = Number(value); return Number.isSafeInteger(n) && n > 1 ? n : 1; };
const whole = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

export function createAdminCleanup({ document, api, security, message = () => {}, getAccount, ownerAllowed = () => true, isActive = () => true, setTimer = setInterval, clearTimer = clearInterval, clock = Date.now, pageSize = PAGE_SIZE } = {}) {
  const el = (tag, value, cls) => { const node = document.createElement(tag); if (value != null) node.textContent = String(value); if (cls) node.className = cls; return node; };
  const view = document.defaultView || null;
  const element = el('section', null, 'admin-card admin-cleanup'); element.id = 'admin-cleanup';
  const heading = el('div', null, 'admin-card-heading'), copy = el('div'), headActions = el('div', null, 'admin-inline-actions');
  const refresh = el('button', 'Refresh', 'text-button'); refresh.type = 'button'; refresh.id = 'admin-cleanup-refresh';
  const bulk = el('button', 'Archive all finished failures', 'small-button admin-danger'); bulk.type = 'button'; bulk.id = 'admin-cleanup-bulk'; bulk.dataset.adminPageAction = 'true'; bulk.dataset.adminArchiveFailed = 'cleanup';
  copy.append(el('p', 'LAUNCH OPERATIONS / CLEANUP', 'eyebrow'), el('h2', 'Cleanup'), el('p', 'Launches that stopped before finishing, on every venue: failures, refunds still returning, funding that never completed and old drafts. Archive what is settled, refund what is waiting. Records are never deleted.'));
  headActions.append(bulk, refresh); heading.append(copy, headActions);
  const status = el('p', '', 'admin-revenue-status'); status.id = 'admin-cleanup-status'; status.setAttribute('role', 'status');
  const facts = el('div', null, 'admin-gas-facts'); facts.id = 'admin-cleanup-facts';
  // Bulk archive: a preview with counts, then one confirmed, identity-checked request (resumable by its saved id).
  const bulkPanel = el('section', null, 'launch-admin-distributions admin-cleanup-bulk'); bulkPanel.id = 'admin-cleanup-bulk-panel'; bulkPanel.hidden = true; bulkPanel.setAttribute('aria-label', 'Archive all finished failures');
  const bulkStatus = el('p', '', 'help'), bulkReasons = el('ul', '', 'help'), bulkControls = el('div', null, 'launch-admin-heading-actions'), bulkConfirm = el('button', 'Archive failed requests', 'small-button admin-danger'), bulkCancel = el('button', 'Cancel', 'text-button');
  bulkStatus.setAttribute('role', 'status'); bulkConfirm.type = bulkCancel.type = 'button'; bulkConfirm.id = 'admin-cleanup-bulk-confirm'; bulkConfirm.dataset.adminArchiveConfirm = 'cleanup'; bulkCancel.id = 'admin-cleanup-bulk-cancel';
  bulkControls.append(bulkConfirm, bulkCancel); bulkPanel.append(bulkStatus, bulkReasons, bulkControls);
  const reasonLabel = el('label', 'Reason for Pump.fun actions', 'admin-protocol-wide'), reason = el('input'); reason.id = 'admin-cleanup-reason'; reason.minLength = 5; reason.maxLength = 500; reason.value = 'Cleanup from the admin panel.'; reason.placeholder = 'Recorded with every refund, archive or visibility change'; reasonLabel.append(reason);
  const filter = filterBar(document, { placeholder: 'Find a launch: coin, ticker, mint, account or reason', label: 'Find an unfinished launch', chips: KIND_CHIPS.map(([key, label]) => ({ key, label })), onChange: ({ q, chip, source }) => { query.search = q; query.kind = chip; if (source !== 'input' || q !== lastSearch) query.offset = 0; lastSearch = q; writeState(); void load(true); } });
  filter.input.id = 'admin-cleanup-search'; filter.element.classList.add('admin-sticky-tools');
  const venueLabel = el('label', null, 'admin-cleanup-venue'), venue = el('select'); venue.id = 'admin-cleanup-venue'; venue.setAttribute('aria-label', 'Venue');
  for (const [value, label] of VENUES) { const option = el('option', label); option.value = value; venue.append(option); }
  venueLabel.append(venue); filter.element.append(venueLabel);
  venue.onchange = () => { query.venue = venue.value; query.offset = 0; writeState(); void load(true); };
  const listTitle = el('h3', 'Unfinished launches'), list = el('div', null, 'admin-cleanup-list'); list.id = 'admin-cleanup-list';
  const pages = pager(document, { label: 'launches', onPage: offset => { query.offset = offset; writeState({ push: true }); void load(true); } });
  element.append(heading, status, facts, bulkPanel, reasonLabel, filter.element, listTitle, list, pages.element);
  let snapshot = null, revision = 0, disposed = false, loading = false, busy = false, active = false, timer = null, viewOwner = null, loadedAt = 0, lastSearch = '', bulkPreview = null, bulkRequestId = '';
  const query = { search: '', kind: '', venue: '', offset: 0 }, state = hashState(view, { prefix: 'cleanup' }), acting = new Map();
  const accountIdentity = () => getAccount()?.id ?? getAccount();
  const permitted = () => !disposed && getAccount()?.role === 'admin' && getAccount()?.mfaEnabled === true;
  const permittedAt = (generation, owner) => permitted() && revision === generation && accountIdentity() === owner;
  function stop() { if (timer !== null) { clearTimer(timer); timer = null; } }
  function schedule() { stop(); if (active && permitted() && isActive() && !document.hidden && !busy) timer = setTimer(() => { if (permitted() && isActive() && !document.hidden) void load(); else stop(); }, POLL_MS); }
  function controls() {
    const disabled = !permitted() || !snapshot || loading || busy; refresh.disabled = !permitted() || loading || busy;
    filter.input.disabled = venue.disabled = reason.disabled = disabled; bulk.disabled = disabled || !!bulkRequestId;
    bulkConfirm.disabled = disabled || !(bulkPreview?.eligible > 0 || bulkRequestId); bulkCancel.disabled = disabled || !!bulkRequestId;
    bulkConfirm.textContent = bulkRequestId ? 'Retry saved archive request' : bulkPreview?.eligible > 0 ? `Archive ${bulkPreview.eligible.toLocaleString('en-US')} finished failures` : 'Archive failed requests';
    for (const button of list.querySelectorAll('button[data-action]')) button.disabled = disabled || acting.has(button.dataset.key) || (button.dataset.owner === 'true' && !ownerAllowed());
  }
  function readState() { query.search = state.get('q'); query.kind = state.get('kind'); query.venue = VENUES.some(([value]) => value === state.get('venue')) ? state.get('venue') : ''; query.offset = (page(state.get('page')) - 1) * pageSize; lastSearch = query.search; filter.set({ q: query.search, chip: query.kind }); venue.value = query.venue; }
  function writeState(options) { state.set({ q: query.search, kind: query.kind, venue: query.venue, page: query.offset ? Math.floor(query.offset / pageSize) + 1 : 0 }, options); }
  const params = () => { const p = new URLSearchParams(); p.set('offset', String(query.offset)); p.set('limit', String(pageSize)); if (query.search) p.set('search', query.search); if (query.kind && query.kind !== 'archived') p.set('kind', query.kind); if (query.kind === 'archived') { p.set('kind', 'archived'); p.set('archived', '1'); } if (query.venue) p.set('venue', query.venue); return p.toString(); };
  function clear() { revision++; stop(); snapshot = null; viewOwner = null; loadedAt = 0; loading = false; busy = false; active = false; element.hidden = true; status.textContent = ''; facts.replaceChildren(); list.replaceChildren(); pages.update({ total: 0 }); bulkPanel.hidden = true; bulkStatus.textContent = ''; bulkReasons.replaceChildren(); bulkPreview = null; bulkRequestId = ''; acting.clear(); filter.cancel(); delete element.dataset.adminSummary; controls(); }
  function fact(label, value, warn = false) { const item = el('div', null, 'admin-stat'); item.append(el('span', label), el('strong', value)); if (warn) item.classList.add('admin-gas-warning'); return item; }
  const pill = (label, tone = '') => el('span', label, 'cv-pill' + (tone ? ' is-' + tone : ''));
  function requireReason() { const value = reason.value.trim(); if (value.length < 5 || value.length > 500) { message('Enter a reason from 5 to 500 characters for Pump.fun actions.', true); return null; } return value; }
  /** Archive/restore on Raydium, PumpSwap and Meteora requests: the per-request route (CSRF, admin session; reversible). */
  async function archiveRow(row, archived, button) {
    if (!permitted() || busy || acting.has(row.key)) return;
    const generation = revision, owner = accountIdentity(), request = {}; acting.set(row.key, request); controls(); button.textContent = archived ? 'Archiving…' : 'Restoring…';
    try {
      const native = row.route !== 'raydium', result = await api('/api/admin/launches/archive', { accountId: row.accountId, id: row.id, ...(native ? { route: row.route, mint: row.mint } : {}), archived });
      if (!permittedAt(generation, owner)) return;
      if (result?.launch?.id !== row.id || result.launch.manuallyArchived !== archived) throw Error('The archive update could not be verified. Refresh to check this request.');
      message(archived ? `${row.symbol || row.name || 'Request'} archived.` : `${row.symbol || row.name || 'Request'} restored.`);
      await load(true);
    } catch (error) { if (permittedAt(generation, owner)) message(error?.message || 'This request could not be updated. Try again.', true); }
    finally { if (acting.get(row.key) === request) acting.delete(row.key); if (permittedAt(generation, owner)) controls(); }
  }
  /** Pump.fun actions: reason + password + 2FA through the owner's control route. */
  async function controlRow(row, action) {
    if (!permitted() || busy || acting.has(row.key) || !ownerAllowed()) return;
    const why = requireReason(); if (!why) return;
    const generation = revision, owner = accountIdentity(); busy = true; stop(); controls();
    const label = `${ACTIONS[action]?.label || action} · ${row.symbol || row.name || 'launch'}`;
    try {
      const credentials = await security.authorize(label, { requireCode: true }); if (!permittedAt(generation, owner) || !isActive()) return;
      await api('/api/admin/pump-classic/control', { launchId: row.id, action, reason: why, ...credentials }); if (!permittedAt(generation, owner)) return;
      message(label + ' done.'); busy = false; await load(true);
    } catch (error) { if (permittedAt(generation, owner) && error?.message !== 'Cancelled.') message(error?.message || 'The request could not be confirmed. Refresh before trying again.', true); }
    finally { if (generation === revision) { if (!permittedAt(generation, owner)) { clear(); return; } busy = false; controls(); schedule(); } }
  }
  function actionButton(row, action) {
    const spec = ACTIONS[action] || { label: action, title: '' }, button = el('button', spec.label, 'small-button cv-sm' + (spec.danger ? ' admin-danger' : '')); button.type = 'button'; button.title = spec.title; button.dataset.action = action; button.dataset.key = row.key;
    button.setAttribute('aria-label', `${spec.label} ${row.symbol || row.name || 'launch'}`);
    if (row.route === 'pump-classic') { button.dataset.owner = 'true'; if (!ownerAllowed()) button.title = 'Owner-only: available to the platform owner.'; if (spec.danger) inlineConfirm(button, () => { void controlRow(row, action); }, { confirmText: spec.label + '?' }); else button.onclick = () => { void controlRow(row, action); }; }
    else inlineConfirm(button, () => { void archiveRow(row, action === 'archive', button); }, { confirmText: action === 'archive' ? 'Archive?' : 'Restore?' });
    return button;
  }
  function renderRow(row, now) {
    const item = el('article', null, 'admin-cleanup-row'); item.dataset.cleanupRow = row.key; item.dataset.route = row.route; item.tabIndex = -1;
    const identity = el('div', null, 'admin-cleanup-identity');
    const name = el('strong', (row.symbol ? '$' + text(row.symbol, 24) + ' · ' : '') + (text(row.name, 60) || 'Unnamed launch'));
    const sub = el('small'); sub.append(text(row.venue, 24) || row.route, ' · ', text(row.username, 32) || 'unknown account');
    if (ADDRESS.test(row.mint || '')) { const mint = el('span', row.mint.slice(0, 6) + '…' + row.mint.slice(-4), 'admin-cleanup-mint'); mint.title = row.mint; sub.append(' · ', mint, copyButton(document, row.mint, 'Copy mint address')); }
    identity.append(name, sub);
    const stateBox = el('div', null, 'admin-cleanup-state'), pills = el('div', null, 'admin-launch-pills');
    pills.append(pill(text(row.stateLabel, 32) || row.state, TONES[row.kind] || ''));
    if (row.kind === 'refund') pills.append(pill(row.pairRefundState === 'pending' ? 'Pair refund waiting' : 'Refund waiting', 'warn'));
    if (row.kind === 'unfinished' && row.route === 'pump-classic') pills.append(pill('Funding never finished', 'warn'));
    if (row.pending) pills.append(pill('Transaction pending', 'warn'));
    if (row.recovery && row.route !== 'pump-classic') pills.append(pill('Recovery', 'warn'));
    if (row.hidden) pills.append(pill('Hidden'));
    if (row.archived || row.kind === 'archived') pills.append(pill('Archived'));
    stateBox.append(pills); if (row.reason) stateBox.append(el('p', text(row.reason, 300), 'help'));
    const money = el('div', null, 'admin-cleanup-money'); money.append(el('span', 'Money', 'admin-cleanup-label'), el('strong', row.moneyZero ? 'None involved' : text(row.money, 160) || '—'));
    if (!row.moneyZero) money.classList.add('is-live');
    const age = el('div', null, 'admin-cleanup-age'), when = el('time', ageText(row.updatedAt || row.createdAt, now)); const at = row.updatedAt || row.createdAt;
    if (Number.isSafeInteger(at) && at > 0) { when.title = exactTime(at); when.dateTime = new Date(at).toISOString(); }
    age.append(el('span', 'Age', 'admin-cleanup-label'), when, el('small', 'started ' + relativeTime(row.createdAt, now)));
    const actions = el('div', null, 'admin-cleanup-actions');
    for (const action of Array.isArray(row.actions) ? row.actions : []) if (ACTIONS[action]) actions.append(actionButton(row, action));
    if (!actions.children.length) actions.append(el('span', row.archiveReason ? text(row.archiveReason, 160) : 'No action available', 'help'));
    item.append(identity, stateBox, money, age, actions);
    return item;
  }
  function render(data) {
    snapshot = data; element.hidden = false; loadedAt = clock(); const now = clock(), counts = data?.counts || {}, rows = Array.isArray(data?.rows) ? data.rows : [];
    // "Open" rows need the operator; abandoned quotes (never funded) and archived rows are counted separately.
    const open = Math.max(0, whole(counts.total) - whole(counts.archived) - whole(counts.abandoned));
    status.textContent = `${open.toLocaleString('en-US')} unfinished ${open === 1 ? 'launch' : 'launches'} across every venue · ${whole(counts.moneyRows).toLocaleString('en-US')} with money involved · ${whole(counts.abandoned).toLocaleString('en-US')} abandoned ${whole(counts.abandoned) === 1 ? 'quote' : 'quotes'} · ${whole(counts.archived).toLocaleString('en-US')} archived. Updated ${exactTime(data?.at)}.`;
    element.dataset.adminSummary = `${open.toLocaleString('en-US')} unfinished · ${whole(counts.refund).toLocaleString('en-US')} refunds · ${whole(counts.bulkEligible).toLocaleString('en-US')} ready to archive`;
    facts.replaceChildren(fact('Failed', String(whole(counts.failed)), whole(counts.failed) > 0), fact('Never finished', String(whole(counts.unfinished)), whole(counts.unfinished) > 0), fact('Refunds waiting', String(whole(counts.refund)), whole(counts.refund) > 0), fact('Abandoned quotes', String(whole(counts.abandoned))), fact('Ready to archive', String(whole(counts.bulkEligible))));
    filter.setChips(KIND_CHIPS.map(([key, label]) => ({ key, label, count: key === '' ? open : whole(counts[key]) })));
    const total = whole(data?.total), matched = query.search || query.kind || query.venue;
    listTitle.textContent = `Unfinished launches (${total.toLocaleString('en-US')})`;
    list.replaceChildren(...rows.map(row => renderRow(row, now)));
    if (!rows.length) list.append(el('p', matched ? 'No unfinished launches match this filter.' : 'Nothing to clean up. Every launch finished or is already archived.', 'help admin-cleanup-empty'));
    pages.update({ offset: whole(data?.offset), limit: whole(data?.limit) || pageSize, total, shown: rows.length });
    controls();
  }
  async function load(force = false) {
    if (!permitted()) { clear(); return; } if (!isActive()) { stop(); return; } const owner = accountIdentity(); if (viewOwner !== null && viewOwner !== owner) clear(); viewOwner = owner; active = true;
    if (document.hidden && !force) { schedule(); return; } if (loading || (busy && !force)) return; loading = true; element.hidden = false; controls(); const generation = revision; if (!snapshot) status.textContent = 'Checking every venue for unfinished launches…';
    try { const data = await api('/api/admin/cleanup?' + params()); if (permittedAt(generation, owner)) render(data); }
    catch (error) { if (permittedAt(generation, owner)) { status.textContent = snapshot ? 'The cleanup list could not be refreshed. Showing the last snapshot.' : 'The cleanup list is temporarily unavailable. Use Refresh to try again.'; if (error?.known) message(error.message, true); } }
    finally { if (generation === revision) { if (!permittedAt(generation, owner)) { clear(); return; } loading = false; controls(); schedule(); } }
  }
  function showBulkReasons(rows) { bulkReasons.replaceChildren(); for (const row of Array.isArray(rows) ? rows.slice(0, 20) : []) if (Number.isSafeInteger(row?.count) && row.count > 0 && typeof row.message === 'string') bulkReasons.append(el('li', `${row.count} · ${row.message.slice(0, 250)}`)); }
  bulk.onclick = async () => {
    if (!permitted() || busy || loading || bulkRequestId) return;
    const generation = revision, owner = accountIdentity(); busy = true; stop(); bulkPreview = null; bulkPanel.hidden = false; bulkStatus.textContent = 'Checking failed requests across all accounts and venues…'; bulkReasons.replaceChildren(); controls();
    try {
      const result = await api('/api/admin/failed-launch-archive'); if (!permittedAt(generation, owner)) return;
      if (!Number.isSafeInteger(result?.eligibleCount) || result.eligibleCount < 0 || !Number.isSafeInteger(result?.excludedCount) || result.excludedCount < 0) throw Error('The archive preview could not be verified.');
      const pumpCount = ownerAllowed() ? whole(snapshot?.counts?.pumpEligible) : 0;
      bulkPreview = { eligible: result.eligibleCount + pumpCount, raydium: result.eligibleCount, pump: pumpCount, excluded: result.excludedCount };
      bulkStatus.textContent = `${result.eligibleCount.toLocaleString('en-US')} failed ${result.eligibleCount === 1 ? 'request' : 'requests'} on Raydium, PumpSwap and Meteora ${result.eligibleCount === 1 ? 'is' : 'are'} eligible to archive (${result.excludedCount.toLocaleString('en-US')} excluded)${ownerAllowed() ? `, plus ${pumpCount.toLocaleString('en-US')} settled Pump.fun ${pumpCount === 1 ? 'failure' : 'failures'}` : ''}. Live tokens, pending transactions and requests with funds or recovery work stay untouched. Nothing is deleted.`;
      showBulkReasons(result.excludedReasons);
    } catch (error) { if (permittedAt(generation, owner)) bulkStatus.textContent = String(error?.message || 'Failed requests could not be checked.').slice(0, 300); }
    finally { if (generation === revision) { busy = false; controls(); schedule(); } }
  };
  bulkConfirm.onclick = async () => {
    if (!permitted() || busy || loading || !(bulkPreview?.eligible > 0 || bulkRequestId)) return;
    const generation = revision, owner = accountIdentity(); busy = true; stop(); controls();
    try {
      const credentials = await security.authorize(bulkRequestId ? 'Retry saved failed-launch archive' : `Archive ${bulkPreview.eligible.toLocaleString('en-US')} finished failures`, { requireCode: true }); if (!permittedAt(generation, owner)) return;
      if (!bulkRequestId) bulkRequestId = globalThis.crypto.randomUUID().replaceAll('-', ''); const requestId = bulkRequestId; bulkStatus.textContent = 'Archiving eligible failed requests…';
      const result = await api('/api/admin/cleanup/archive-all', { requestId, reason: reason.value.trim() || 'Archive all finished failures from the admin panel.', ...credentials }); if (!permittedAt(generation, owner)) return;
      if (result?.requestId !== requestId || !['completed', 'partial'].includes(result?.status) || !['archivedCount', 'skippedCount', 'remainingCount', 'excludedCount'].every(key => Number.isSafeInteger(result[key]) && result[key] >= 0) || result.status === 'completed' && result.remainingCount !== 0) throw Error('The archive result could not be verified. Retry the saved request.');
      const pumpArchived = whole(result.pumpFun?.archived);
      bulkStatus.textContent = `${result.archivedCount.toLocaleString('en-US')} failed ${result.archivedCount === 1 ? 'request' : 'requests'} archived on Raydium, PumpSwap and Meteora · ${result.skippedCount} skipped during recheck · ${result.excludedCount} excluded in total.${result.pumpFun?.skipped ? '' : ` ${pumpArchived.toLocaleString('en-US')} Pump.fun ${pumpArchived === 1 ? 'failure' : 'failures'} archived.`}${result.status === 'partial' ? ` ${result.remainingCount} still need confirmation. Retry this saved request to finish.` : ' Archived records stay available under Archived.'}`;
      showBulkReasons(result.excludedReasons);
      if (result.status === 'completed') { bulkRequestId = ''; bulkPreview = null; message('Finished failures archived.'); }
      busy = false; await load(true);
    } catch (error) { if (permittedAt(generation, owner) && error?.message !== 'Cancelled.') bulkStatus.textContent = String(error?.message || 'The archive request could not be confirmed.').slice(0, 300) + (bulkRequestId ? ' Retry uses the same saved request.' : ''); }
    finally { if (generation === revision) { busy = false; controls(); schedule(); } }
  };
  bulkCancel.onclick = () => { if (busy || bulkRequestId) return; bulkPanel.hidden = true; bulkPreview = null; bulkStatus.textContent = ''; bulkReasons.replaceChildren(); controls(); };
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
