// Admin → Tokens → Vanity addresses: owner-only, MFA-gated. Adding keys and
// removing addresses need the owner's password and 2FA code; pasted keys are
// cleared once sent; the view prints addresses and the fields it knows, never
// key material.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createAdminVanity } from '../public/admin-vanity-ui.mjs';

const OWNER = { id: 'owner', role: 'admin', mfaEnabled: true }, NOW = 1790668800000;
const A = '9J7iw6jVxqPoiBMXWsWRNAsgFT9qkkkVHyAS26euwoBq', B = 'TestVanity11111111111111111111111111111pump', C = 'Ax7vB1Fhk3bQ6Yw2NNhtWT2ofZtrTmqP3Lhwz9LDpump', D = 'DUSTpump1111111111111111111111111111111pump';
const SECRET = '5'.repeat(88);
const snapshot = (patch = {}) => ({
  version: 1, at: NOW, lowWater: 10, low: ['raydium'],
  counts: { available: 12, byScope: { all: 8, pump: 4, raydium: 0, meteora: 0 }, forVenue: { pump: 12, raydium: 8, meteora: 8 }, reserved: 1, used: 2, skipped: 1 },
  fallbacks: { total: 3, sinceImport: 2, lastAt: NOW, lastVenue: 'pump' }, checks: { failures: 1, lastFailureAt: NOW - 60000 },
  pool: [{ address: A, scope: 'pump', addedAt: NOW, state: 'available', secret: SECRET }, { address: B, scope: 'all', addedAt: NOW, state: 'reserved', venue: 'raydium', until: NOW + 600000 }], poolTotal: 13,
  used: [{ address: C, scope: 'all', state: 'used', venue: 'pump', at: NOW, name: 'Orbit', symbol: 'ORBIT', onChain: true, secretKey: SECRET }, { address: D, scope: 'all', state: 'skipped', venue: 'meteora', at: NOW, reason: 'An account already exists at this address, so it cannot become a coin.' }], usedTotal: 3,
  events: [{ at: NOW, kind: 'import', text: '12 addresses added for every launch.' }], ...patch,
});
function page({ account = OWNER, respond = async () => snapshot(), authorize = async () => ({ password: 'pw', code: '123456' }), files = [] } = {}) {
  const { document } = parseHTML('<html><body></body></html>'); Object.defineProperty(document, 'hidden', { value: false, writable: true });
  const calls = [], auths = [], messages = [];
  const ui = createAdminVanity({ document, getAccount: () => account, isActive: () => true, message: (text, error) => messages.push({ text, error: !!error }), security: { authorize: async (label, options) => { auths.push({ label, options }); return authorize(label, options); } }, api: async (path, body) => { calls.push({ path, body }); return respond(path, body); }, setTimer: () => 1, clearTimer: () => {}, readFiles: async () => files });
  document.body.append(ui.element);
  return { ui, document, calls, auths, messages, get: id => document.getElementById(id) };
}
const submit = async p => { await p.get('admin-vanity-add').onsubmit({ preventDefault() {} }); await new Promise(resolve => setTimeout(resolve, 0)); };

test('the vanity view needs an admin with MFA and never calls the API otherwise', async () => {
  for (const account of [null, { ...OWNER, role: 'user' }, { ...OWNER, mfaEnabled: false }]) {
    const p = page({ account }); await p.ui.load(); assert.equal(p.calls.length, 0); assert.equal(p.ui.element.hidden, true); p.ui.destroy();
  }
});

test('counts, warnings, the pool and the used list render; key material and unknown fields never do', async () => {
  const p = page(); await p.ui.load();
  const text = p.ui.element.textContent;
  assert.match(p.get('admin-vanity-status').textContent, /12 addresses available · 1 held by launches in progress · 2 used · 1 skipped/);
  assert.match(p.get('admin-vanity-warnings').textContent, /Fewer than 10 addresses are left for Raydium launches/);
  assert.match(p.get('admin-vanity-warnings').textContent, /2 launches used a random address because no vanity address was left \(last: Pump\.fun/);
  assert.match(p.get('admin-vanity-warnings').textContent, /The chain could not be asked whether an address was free/);
  assert.match(p.get('admin-vanity-facts').textContent, /For Pump\.fun launches12.*For Raydium launches8.*For Meteora launches8.*Used2/);
  assert.match(text, /Pool \(13\)/); assert.match(text, /Used vanity \(3\)/);
  assert.match(p.get('admin-vanity-pool').textContent, /Held by a Raydium launch in progress until/);
  const link = p.get('admin-vanity-used').querySelector('a'); assert.equal(link.getAttribute('href'), '/coin?mint=' + C); assert.match(p.get('admin-vanity-used').textContent, /\$ORBIT · Orbit.*Pump\.fun.*Created/);
  assert.match(p.get('admin-vanity-used').textContent, /already exists at this address/);
  assert.doesNotMatch(p.document.body.innerHTML, /5555555555/, 'a key field in a response is never printed');
  const boxes = [...p.get('admin-vanity-pool').querySelectorAll('input[type=checkbox]')];
  assert.deepEqual(boxes.map(b => [b.value, b.disabled]), [[A, false], [B, true]], 'only available addresses can be selected');
  assert.deepEqual([...p.get('admin-vanity-used').querySelectorAll('input[type=checkbox]')].map(b => [b.value, b.disabled]), [[C, true], [D, false]], 'a skipped address can be selected to delete its key; a used one cannot');
  const keys = p.get('admin-vanity-keys');
  assert.deepEqual(['spellcheck', 'autocomplete', 'autocorrect', 'autocapitalize'].map(n => keys.getAttribute(n)), ['false', 'off', 'off', 'off'], 'pasted keys are kept away from spellcheck and autofill');
  p.ui.destroy();
});

test('adding keys: nothing to send asks for nothing; keys and files go once with 2FA and are then cleared', async () => {
  const rejected = [{ where: 'pasted text line 2', reason: 'not a private key' }, { where: 'B.json', reason: 'already in the pool' }];
  const p = page({ files: [{ name: 'Grind1.json', text: '[1,2,3]' }, { name: 'Grind2.json', text: '[4,5,6]' }], respond: async (path, body) => path.endsWith('/import') ? { added: [A], rejected, truncated: false, view: snapshot() } : snapshot() });
  await p.ui.load();
  p.get('admin-vanity-keys').value = 'key-one\nkey-two'; p.get('admin-vanity-scope').value = 'pump';
  await submit(p);
  assert.equal(p.auths.length, 1); assert.deepEqual(p.auths[0], { label: 'Add vanity addresses', options: { requireCode: true } });
  const call = p.calls.at(-1);
  assert.equal(call.path, '/api/admin/vanity/import');
  assert.deepEqual(call.body, { entries: [{ name: 'pasted text', text: 'key-one\nkey-two' }, { name: 'Grind1.json', text: '[1,2,3]' }, { name: 'Grind2.json', text: '[4,5,6]' }], scope: 'pump', password: 'pw', code: '123456' });
  assert.equal(p.get('admin-vanity-keys').value, '', 'pasted keys are cleared once sent');
  assert.match(p.get('admin-vanity-result').textContent, /Added 1 address\. Not added \(2\): pasted text line 2 — not a private key; B\.json — already in the pool\./);
  p.ui.destroy();
  const empty = page(); await empty.ui.load(); await submit(empty);
  assert.equal(empty.auths.length, 0); assert.match(empty.messages.at(-1).text, /Paste private keys or choose key files first/); empty.ui.destroy();
  const cancelled = page({ authorize: async () => { throw Error('Cancelled.'); } }); await cancelled.ui.load();
  cancelled.get('admin-vanity-keys').value = 'key-one'; await submit(cancelled);
  assert.equal(cancelled.calls.filter(c => c.path.endsWith('/import')).length, 0, 'a cancelled 2FA prompt sends nothing');
  assert.equal(cancelled.get('admin-vanity-keys').value, 'key-one', 'and keeps what was pasted'); cancelled.ui.destroy();
  const huge = page({ files: [{ name: 'notes.json', text: '', tooLarge: true }] }); await huge.ui.load(); await submit(huge);
  assert.equal(huge.auths.length, 0); assert.match(huge.messages.at(-1).text, /too large to be key files: notes\.json/); huge.ui.destroy();
});

test('removing selected addresses needs 2FA and reports what was kept', async () => {
  const p = page({ respond: async (path, body) => path.endsWith('/remove') ? { removed: [A], kept: [], view: snapshot({ pool: [] }) } : snapshot() });
  await p.ui.load();
  const remove = p.get('admin-vanity-remove'); assert.equal(remove.disabled, true, 'nothing selected');
  const box = p.get('admin-vanity-pool').querySelector('input[type=checkbox]'); box.checked = true; box.onchange();
  assert.equal(remove.disabled, false);
  remove.onclick(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(p.auths.map(a => a.label), ['Remove 1 address from the pool']);
  assert.deepEqual(p.calls.at(-1), { path: '/api/admin/vanity/remove', body: { addresses: [A], password: 'pw', code: '123456' } });
  assert.match(p.get('admin-vanity-result').textContent, /Removed 1 address\./);
  assert.match(p.get('admin-vanity-pool').textContent, /The pool is empty/);
  p.ui.destroy();
});

test('pasted keys are cleared when the page is left, the tab is hidden or an import fails; a cancelled prompt keeps them', async () => {
  const p = page(); await p.ui.load(); const keys = p.get('admin-vanity-keys');
  keys.value = 'key-one'; p.ui.pause(); assert.equal(keys.value, '', 'leaving the page clears pasted keys');
  await p.ui.load(); keys.value = 'key-two'; p.document.hidden = true; p.document.dispatchEvent(new p.document.defaultView.Event('visibilitychange')); assert.equal(keys.value, '', 'hiding the tab clears pasted keys');
  p.document.hidden = false; p.ui.destroy();
  const failing = page({ respond: async path => { if (path.endsWith('/import')) throw Error('Invalid or already used authentication code. Use a new code.'); return snapshot(); } });
  await failing.ui.load(); failing.get('admin-vanity-keys').value = 'key-three'; await submit(failing);
  assert.equal(failing.calls.filter(c => c.path.endsWith('/import')).length, 1); assert.equal(failing.get('admin-vanity-keys').value, '', 'a failed import clears pasted keys');
  assert.match(failing.messages.at(-1).text, /authentication code/); failing.ui.destroy();
});
test('vanity dates include the year', async () => {
  const p = page(); await p.ui.load();
  assert.match(p.get('admin-vanity-status').textContent, new RegExp('Updated .*' + new Date(NOW).getFullYear())); p.ui.destroy();
});

// ---- v71.26: paged lists, filters, the add dialog ----
test('the lists are read 25 a page with the search and state filters in the query; paging and chips re-read', async () => {
  const p = page({ respond: async () => snapshot({ poolTotal: 184, poolMatched: 184, poolOffset: 0, poolLimit: 25, poolNextOffset: 25, usedTotal: 41, usedMatched: 41, usedOffset: 0, usedLimit: 25, usedNextOffset: 25 }) });
  await p.ui.load();
  assert.equal(p.calls[0].path, '/api/admin/vanity?poolOffset=0&poolLimit=25&usedOffset=0&usedLimit=25');
  assert.match(p.ui.element.textContent, /Pool \(184\)/); assert.match(p.ui.element.textContent, /Used vanity \(41\)/);
  const pagers = p.ui.element.querySelectorAll('.admin-pager');
  assert.equal(pagers.length, 2); assert.match(pagers[0].textContent, /1–2 of 184 addresses/, 'the page shows what it holds'); assert.equal(pagers[0].querySelector('[data-page=previous]').disabled, true); assert.equal(pagers[0].querySelector('[data-page=next]').disabled, false);
  pagers[0].querySelector('[data-page=next]').onclick(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(p.calls.at(-1).path, '/api/admin/vanity?poolOffset=25&poolLimit=25&usedOffset=0&usedLimit=25', 'the next pool page keeps the used page');
  p.ui.element.querySelector('[data-chip=reserved]').onclick(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(p.calls.at(-1).path, '/api/admin/vanity?poolOffset=0&poolLimit=25&poolState=reserved&usedOffset=0&usedLimit=25', 'a state chip returns to the first page');
  await p.ui.find('TestV'); assert.equal(p.calls.at(-1).path, '/api/admin/vanity?search=TestV&poolOffset=0&poolLimit=25&poolState=reserved&usedOffset=0&usedLimit=25');
  assert.equal(p.ui.element.querySelectorAll('.admin-copy').length, 4, 'every address row has a copy button');
  assert.equal(p.ui.element.querySelector('.admin-copy').dataset.copy, A);
  assert.match(p.ui.element.dataset.adminSummary, /12 available · 1 held · 2 used/);
  const added = p.get('admin-vanity-pool').querySelector('time'); assert.match(added.textContent, /ago|just now/); assert.match(added.title, new RegExp(String(new Date(NOW).getFullYear())), 'relative times carry the exact time');
  p.ui.destroy();
});

test('adding opens a dialog whose pasted keys clear when it closes; the form keeps its ids', async () => {
  const p = page({ respond: async (path) => path.endsWith('/import') ? { added: [A], rejected: [], truncated: false, view: snapshot() } : snapshot() });
  await p.ui.load();
  const dialog = p.get('admin-vanity-dialog'); let opened = 0; dialog.showModal = () => { opened++; dialog.setAttribute('open', ''); }; dialog.close = () => { dialog.removeAttribute('open'); dialog.dispatchEvent(new p.document.defaultView.Event('close')); };
  Object.defineProperty(dialog, 'open', { get() { return dialog.hasAttribute('open'); }, configurable: true });
  p.get('admin-vanity-open-add').onclick(); assert.equal(opened, 1); assert.ok(dialog.contains(p.get('admin-vanity-add')));
  p.get('admin-vanity-keys').value = 'key-one'; p.get('admin-vanity-cancel').onclick();
  assert.equal(dialog.hasAttribute('open'), false); assert.equal(p.get('admin-vanity-keys').value, '', 'cancelling clears pasted keys');
  p.get('admin-vanity-open-add').onclick(); p.get('admin-vanity-keys').value = 'key-two'; await submit(p);
  assert.equal(p.calls.at(-1).path, '/api/admin/vanity/import'); assert.equal(dialog.hasAttribute('open'), false, 'a successful import closes the dialog'); assert.equal(p.get('admin-vanity-keys').value, '');
  assert.match(p.get('admin-vanity-result').textContent, /Added 1 address\./);
  assert.ok(p.get('admin-vanity-open-add').dataset.adminPageAction, 'the add action is mirrored in the sticky top bar');
  p.ui.destroy();
});

test('selecting a page of pool addresses and removing them', async () => {
  const p = page({ respond: async (path, body) => path.endsWith('/remove') ? { removed: body.addresses, kept: [], view: snapshot({ pool: [] }) } : snapshot() });
  await p.ui.load();
  p.get('admin-vanity-select-page').onclick();
  assert.equal(p.get('admin-vanity-remove').textContent, 'Remove selected (1)', 'only the available address on the page is selectable');
  p.get('admin-vanity-remove').onclick(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(p.calls.at(-1).body.addresses, [A]); p.ui.destroy();
});
