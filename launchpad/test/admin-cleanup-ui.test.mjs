// Admin → Tokens → Cleanup: unfinished launches on every venue, 25 a page, with
// the right action per row. Archive/restore use the per-request archive route
// after an inline confirmation; Pump.fun actions need a reason plus the owner's
// password and 2FA code; "Archive all finished failures" previews, confirms and
// runs one identity-checked request. The view prints only the fields it knows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createAdminCleanup } from '../public/admin-cleanup-ui.mjs';

const ADMIN = { id: 'owner', role: 'admin', mfaEnabled: true }, NOW = 1790668800000, HEX = c => c.repeat(32), MINT = 'Ax7vB1Fhk3bQ6Yw2NNhtWT2ofZtrTmqP3Lhwz9LDpump';
const row = (patch = {}) => ({ key: 'raydium:' + HEX('b') + ':' + HEX('1'), route: 'raydium', venue: 'Raydium', accountId: HEX('b'), username: 'maker', id: HEX('1'), mint: MINT, name: 'Broken Coin', symbol: 'BRK', state: 'failed', stateLabel: 'Failed', kind: 'failed', reason: 'The launch transaction expired before it executed.', createdAt: NOW - 3 * 86400000, updatedAt: NOW - 86400000, money: '0.0421 SOL reserved', moneyZero: false, pending: false, recovery: false, archived: false, hidden: false, listArchived: false, archiveReason: '', bulkEligible: false, bulkCode: '', actions: ['archive'], secretKey: 'SECRET_MUST_NOT_RENDER', ...patch });
const pumpRow = (patch = {}) => row({ key: 'pump-classic:' + HEX('b') + ':x1', route: 'pump-classic', venue: 'Pump.fun', id: 'x1', name: 'Pump Coin', symbol: 'PMP', kind: 'unfinished', state: 'funded', stateLabel: 'Funded', reason: 'Funding was received but the coin was never created.', money: '0.085 SOL funded', actions: ['refund'], ...patch });
const list = (rows, patch = {}) => ({ at: NOW, version: 1, counts: { total: rows.length, failed: rows.filter(r => r.kind === 'failed').length, unfinished: rows.filter(r => r.kind === 'unfinished').length, refund: 0, abandoned: 0, archived: 0, byVenue: {}, moneyRows: 1, bulkEligible: 2, pumpEligible: 1 }, kinds: {}, venues: {}, rows, total: rows.length, offset: 0, limit: 25, nextOffset: null, includeArchived: false, search: '', venue: '', kind: '', ...patch });
function page({ account = ADMIN, respond, authorize = async () => ({ password: 'pw', code: '123456' }), ownerAllowed = () => true } = {}) {
  const { document } = parseHTML('<html><body></body></html>'); Object.defineProperty(document, 'hidden', { value: false, writable: true });
  const calls = [], auths = [], messages = [];
  const ui = createAdminCleanup({ document, getAccount: () => account, ownerAllowed, isActive: () => true, message: (text, error) => messages.push({ text, error: !!error }), security: { authorize: async (label, options) => { auths.push({ label, options }); return authorize(label, options); } }, api: async (path, body) => { calls.push({ path, body }); return respond(path, body); }, setTimer: () => 1, clearTimer: () => {}, clock: () => NOW });
  document.body.append(ui.element);
  return { ui, document, calls, auths, messages, get: id => document.getElementById(id), buttons: root => [...(root || ui.element).querySelectorAll('button')], byText: (text, root) => [...(root || ui.element).querySelectorAll('button')].find(b => b.textContent === text) };
}
const settle = async (n = 2) => { for (let i = 0; i < n; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const click = node => node.dispatchEvent(new node.ownerDocument.defaultView.Event('click', { bubbles: true, cancelable: true }));

test('the cleanup page needs an admin with MFA and reads one page at a time with its filters in the query', async () => {
  for (const account of [null, { ...ADMIN, role: 'user' }, { ...ADMIN, mfaEnabled: false }]) { const p = page({ account, respond: async () => list([]) }); await p.ui.load(); assert.equal(p.calls.length, 0); assert.equal(p.ui.element.hidden, true); p.ui.destroy(); }
  const p = page({ respond: async () => list([row(), pumpRow()]) }); await p.ui.load();
  assert.equal(p.calls[0].path, '/api/admin/cleanup?offset=0&limit=25');
  assert.equal(p.ui.element.querySelectorAll('.admin-cleanup-row').length, 2);
  const first = p.ui.element.querySelector('.admin-cleanup-row');
  assert.match(first.textContent, /\$BRK · Broken Coin/); assert.match(first.textContent, /Raydium · maker/); assert.match(first.textContent, /expired before it executed/); assert.match(first.textContent, /0\.0421 SOL reserved/); assert.match(first.textContent, /1 day old/);
  assert.doesNotMatch(p.ui.element.textContent, /SECRET_MUST_NOT_RENDER/);
  assert.equal(p.ui.element.querySelector('.admin-copy').dataset.copy, MINT, 'a copy button carries the mint');
  assert.equal(first.querySelector('time').title.length > 8, true, 'the exact time is the tooltip');
  assert.deepEqual(p.buttons(first).filter(b => !b.classList.contains('admin-copy')).map(b => b.textContent), ['Archive']);
  assert.match(p.ui.element.dataset.adminSummary, /2 unfinished/);
  // Filters go to the server; a chip or the venue select resets the page.
  p.get('admin-cleanup-venue').value = 'pump-classic'; p.get('admin-cleanup-venue').onchange(); await settle();
  assert.equal(p.calls.at(-1).path, '/api/admin/cleanup?offset=0&limit=25&venue=pump-classic');
  p.ui.element.querySelector('[data-chip="refund"]').onclick(); await settle();
  assert.equal(p.calls.at(-1).path, '/api/admin/cleanup?offset=0&limit=25&kind=refund&venue=pump-classic');
  p.ui.element.querySelector('[data-chip="archived"]').onclick(); await settle();
  assert.equal(p.calls.at(-1).path, '/api/admin/cleanup?offset=0&limit=25&kind=archived&archived=1&venue=pump-classic');
  p.ui.destroy();
});

test('archive and restore confirm inline, then use the per-request archive route with the row identity', async () => {
  const native = row({ key: 'meteora:' + HEX('b') + ':m1', route: 'meteora', venue: 'Meteora', id: 'f'.repeat(8) + '-' + 'f'.repeat(4) + '-' + 'f'.repeat(4) + '-' + 'f'.repeat(4) + '-' + 'f'.repeat(12), name: 'Pool Coin', symbol: 'POOL', state: 'error', stateLabel: 'Error' });
  const p = page({ respond: async (path, body) => path === '/api/admin/launches/archive' ? { route: body.route, launch: { id: body.id, manuallyArchived: body.archived, listArchived: body.archived } } : list([row(), native]) });
  await p.ui.load();
  const rows = p.ui.element.querySelectorAll('.admin-cleanup-row'), archive = p.byText('Archive', rows[0]);
  click(archive); assert.equal(archive.textContent, 'Archive?'); assert.equal(archive.dataset.armed, 'true'); assert.equal(p.calls.filter(c => c.path.endsWith('/archive')).length, 0, 'the first click only arms the button');
  click(archive); await settle(3);
  const post = p.calls.find(c => c.path === '/api/admin/launches/archive');
  assert.deepEqual(post.body, { accountId: HEX('b'), id: HEX('1'), archived: true }, 'a Raydium request sends no route');
  assert.equal(p.auths.length, 0, 'archiving a request needs no new identity prompt (the route checks the admin session and control token)');
  assert.match(p.messages.at(-1).text, /BRK archived/);
  const second = p.byText('Archive', p.ui.element.querySelectorAll('.admin-cleanup-row')[1]); click(second); click(second); await settle(3);
  assert.deepEqual(p.calls.filter(c => c.path === '/api/admin/launches/archive').at(-1).body, { accountId: HEX('b'), id: native.id, route: 'meteora', mint: MINT, archived: true }, 'a native request sends its route and mint');
  p.ui.destroy();
  const restorable = page({ respond: async (path, body) => path === '/api/admin/launches/archive' ? { launch: { id: body.id, manuallyArchived: body.archived } } : list([row({ kind: 'archived', archived: true, listArchived: true, actions: ['restore'] })]) });
  await restorable.ui.load(); const restore = restorable.byText('Restore'); click(restore); click(restore); await settle(3);
  assert.equal(restorable.calls.find(c => c.path === '/api/admin/launches/archive').body.archived, false); restorable.ui.destroy();
});

test('Pump.fun actions need a reason, the owner capability, the password and 2FA code; dangerous ones confirm inline first', async () => {
  const p = page({ respond: async path => path.endsWith('/control') ? { ok: true } : list([pumpRow(), pumpRow({ key: 'pump-classic:' + HEX('b') + ':x2', id: 'x2', symbol: 'DONE', kind: 'failed', state: 'refunded', stateLabel: 'Refunded', actions: ['archive'] })]) });
  await p.ui.load();
  const rows = p.ui.element.querySelectorAll('.admin-cleanup-row'), refund = p.byText('Refund', rows[0]), archive = p.byText('Archive', rows[1]);
  p.get('admin-cleanup-reason').value = 'bad';
  click(archive); await settle(); assert.equal(p.auths.length, 0); assert.match(p.messages.at(-1).text, /reason from 5 to 500/);
  p.get('admin-cleanup-reason').value = 'Cleanup from the admin panel.';
  click(archive); await settle(3);
  assert.deepEqual(p.auths.at(-1), { label: 'Archive · DONE', options: { requireCode: true } });
  assert.deepEqual(p.calls.find(c => c.path.endsWith('/control')).body, { launchId: 'x2', action: 'archive', reason: 'Cleanup from the admin panel.', password: 'pw', code: '123456' });
  click(refund); assert.equal(refund.textContent, 'Refund?'); assert.equal(p.calls.filter(c => c.path.endsWith('/control')).length, 1);
  click(refund); await settle(3);
  assert.deepEqual(p.calls.filter(c => c.path.endsWith('/control')).at(-1).body, { launchId: 'x1', action: 'refund', reason: 'Cleanup from the admin panel.', password: 'pw', code: '123456' });
  p.ui.destroy();
  const guest = page({ ownerAllowed: () => false, respond: async () => list([pumpRow()]) }); await guest.ui.load();
  assert.equal(guest.byText('Refund').disabled, true, 'without the owner capability Pump.fun actions stay disabled');
  assert.match(guest.byText('Refund').title, /Owner-only/); guest.ui.destroy();
  const cancelled = page({ authorize: async () => { throw Error('Cancelled.'); }, respond: async () => list([pumpRow({ actions: ['unarchive'], kind: 'archived', archived: true })]) }); await cancelled.ui.load();
  click(cancelled.byText('Restore')); await settle(3);
  assert.equal(cancelled.calls.filter(c => c.path.endsWith('/control')).length, 0); assert.equal(cancelled.messages.some(m => m.error), false); cancelled.ui.destroy();
});

test('archive all previews the counts, needs a confirmation plus 2FA, sends one saved request id and reports both parts', async () => {
  let archived = 0;
  const p = page({ respond: async (path, body) => path === '/api/admin/failed-launch-archive' ? { eligibleCount: 3, excludedCount: 2, excludedReasons: [{ code: 'funds', count: 2, message: 'Funds or reward obligations remain reserved for this request.' }] } : path === '/api/admin/cleanup/archive-all' ? (archived++, { requestId: body.requestId, status: 'completed', archivedCount: 3, skippedCount: 0, remainingCount: 0, excludedCount: 2, excludedReasons: [], pumpFun: { skipped: null, archived: 1 } }) : list([row()]) });
  await p.ui.load();
  const bulk = p.get('admin-cleanup-bulk'), confirm = p.get('admin-cleanup-bulk-confirm');
  assert.equal(p.get('admin-cleanup-bulk-panel').hidden, true); assert.equal(confirm.disabled, true);
  await bulk.onclick(); await settle();
  assert.equal(p.get('admin-cleanup-bulk-panel').hidden, false);
  assert.match(p.get('admin-cleanup-bulk-panel').textContent, /3 failed requests on Raydium, PumpSwap and Meteora are eligible to archive \(2 excluded\), plus 1 settled Pump\.fun failure/);
  assert.match(p.get('admin-cleanup-bulk-panel').textContent, /2 · Funds or reward obligations remain reserved/);
  assert.equal(confirm.textContent, 'Archive 4 finished failures'); assert.equal(confirm.disabled, false); assert.equal(p.auths.length, 0, 'the preview needs no identity prompt');
  await confirm.onclick(); await settle(3);
  assert.deepEqual(p.auths.at(-1), { label: 'Archive 4 finished failures', options: { requireCode: true } });
  const post = p.calls.find(c => c.path === '/api/admin/cleanup/archive-all');
  assert.match(post.body.requestId, /^[a-f0-9]{32}$/); assert.deepEqual([post.body.password, post.body.code, post.body.reason], ['pw', '123456', 'Cleanup from the admin panel.']);
  assert.match(p.get('admin-cleanup-bulk-panel').textContent, /3 failed requests archived on Raydium, PumpSwap and Meteora · 0 skipped during recheck · 2 excluded in total\. 1 Pump\.fun failure archived\./);
  assert.equal(archived, 1); assert.match(p.messages.at(-1).text, /Finished failures archived/);
  assert.equal(p.calls.filter(c => c.path.startsWith('/api/admin/cleanup?')).length, 2, 'the list reads again afterwards');
  p.ui.destroy();
});

test('leaving the page clears nothing it should keep, and a lost session clears everything', async () => {
  let account = ADMIN;
  const p = page({ account: undefined, respond: async () => list([row()]) }); p.ui.destroy();
  const q = (() => { const { document } = parseHTML('<html><body></body></html>'); Object.defineProperty(document, 'hidden', { value: false, writable: true }); const ui = createAdminCleanup({ document, getAccount: () => account, isActive: () => true, security: { authorize: async () => ({}) }, api: async () => list([row()]), setTimer: () => 1, clearTimer: () => {} }); document.body.append(ui.element); return ui; })();
  await q.load(); assert.equal(q.element.querySelectorAll('.admin-cleanup-row').length, 1);
  q.pause(); assert.equal(q.element.querySelectorAll('.admin-cleanup-row').length, 1, 'pausing keeps the rows for a quick return');
  account = null; await q.load(); assert.equal(q.element.hidden, true); assert.equal(q.element.querySelectorAll('.admin-cleanup-row').length, 0); q.destroy();
});
