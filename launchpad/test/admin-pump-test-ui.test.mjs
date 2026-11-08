import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createAdminPumpTest, parsePumpTestDecimal } from '../public/admin-pump-test-ui.mjs';

const admin = { id: 'owner', role: 'admin', mfaEnabled: true };
const metadata = { mode: 'local-test', network: 'none', fundedLaunchEnabled: false, publicLaunchEnabled: false, verification: { model: 'passed', custody: 'not-implemented', migration: 'not-implemented', lpBurn: 'pending', independentAudit: 'pending' }, blockers: ['A deployed custody program has not been verified.'] };
const estimate = { quoteCollectedUsd: '21808', graduationFeeUsd: '6291', lpQuoteUsd: '15517.50', lpTokenValueUsd: '15517.50', lpTotalUsd: '31035', poolOpeningFdvUsd: '50000' };
function page({ account = admin, active = true, respond = async path => path.endsWith('/preview') ? { estimate } : metadata } = {}) {
  const { document, window } = parseHTML('<html><body></body></html>');
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', { configurable: true, get() { return [...this.options].find(option => option.selected)?.value || this.options[0]?.value || ''; }, set(value) { for (const option of this.options) option.removeAttribute('selected'); [...this.options].find(option => option.value === String(value))?.setAttribute('selected', ''); } });
  Object.defineProperty(document, 'hidden', { value: false, writable: true });
  const calls = [], ui = createAdminPumpTest({ document, api: async (path, body) => { calls.push({ path, body }); return respond(path, body); }, getAccount: () => account, isActive: () => active }); document.body.append(ui.element);
  return { ui, document, calls, setAccount(value) { account = value; }, setActive(value) { active = value; }, get(id) { return document.getElementById('admin-pump-test-' + id); }, async preview({ graduation = '28.85', trading = '1', price = '150', preset = 'standard' } = {}) { this.get('preset').value = preset; this.get('graduation-fee').value = graduation; this.get('trade-fee').value = trading; this.get('sol-usd').value = price; await this.get('form').onsubmit({ preventDefault() {} }); } };
}

test('private lab requires administrator MFA and rejects revoked or anonymous owners', async () => {
  for (const account of [null, { ...admin, role: 'user' }, { ...admin, mfaEnabled: false }, { ...admin, banned: true }, { role: 'admin', mfaEnabled: true }]) {
    const p = page({ account }); await p.ui.load(); await p.preview(); assert.equal(p.calls.length, 0); assert.equal(p.ui.element.hidden, true); p.ui.destroy();
  }
});

test('only an active lab loads; its graduation fee is fixed and it cannot sign or fund', async () => {
  const p = page({ active: false }); await p.ui.load(); assert.equal(p.calls.length, 0); p.setActive(true); await p.ui.load();
  assert.equal(p.calls.length, 1); assert.equal(p.get('graduation-fee').value, '28.85'); assert.equal(p.get('graduation-fee').readOnly, true); assert.equal(p.get('trade-fee').value, '1.00'); assert.equal(p.get('sol-usd').value, '');
  assert.match(p.ui.element.textContent, /Simulation only • no funds moved/); assert.match(p.ui.element.textContent, /Funded launches are disabled/);
  assert.match(p.ui.element.textContent, /Not implemented/); assert.match(p.ui.element.textContent, /Not yet verified/); assert.doesNotMatch(p.ui.element.textContent, /100% safe|fully audited/i);
  assert.equal(p.ui.element.querySelectorAll('button').length, 2); assert.equal(p.ui.element.querySelector('a'), null); p.ui.destroy();
});

test('exact decimal inputs generate only the read-only model POST and labeled estimates', async () => {
  const p = page(); await p.ui.load(); await p.preview({ graduation: '28.85', trading: '1.23', price: '150.123456' });
  assert.deepEqual(p.calls[1], { path: '/api/admin/pump-test/preview', body: { preset: 'standard', graduationFeeBps: '2885', tradeFeeBps: '123', solUsdMicros: '150123456' } });
  assert.match(p.get('results').textContent, /\$31,035\.00/); assert.match(p.get('results').textContent, /\$15,517\.50/); assert.match(p.get('results').textContent, /graduation fee 28\.85% of quote funds/);
  assert.match(p.get('results').textContent, /No pool or burn transaction has been submitted/); assert.match(p.get('status').textContent, /no settings changed/); p.ui.destroy();
});

test('invalid fee and price inputs never reach the preview API', async () => {
  const p = page(); await p.ui.load();
  for (const graduation of ['', '-1', '100', '25', '30.01', '28.855', '1e2', 'Infinity', '0x10', '1,5', '.5', '  ']) await p.preview({ graduation });
  for (const trading of ['', '100', '3.01', '-0.1', '1.0001']) await p.preview({ trading });
  for (const price of ['', '0', '-1', '1e3', '0.0000001', '1000000.000001', 'NaN']) await p.preview({ price });
  assert.equal(p.calls.length, 1); assert.equal(p.get('results').children.length, 0); assert.match(p.get('status').textContent, /positive SOL price/);
  assert.equal(parsePumpTestDecimal('0.29', 2), '29'); assert.equal(parsePumpTestDecimal('99.99', 2), '9999'); assert.equal(parsePumpTestDecimal('150.123456', 6, { min: 1n, max: 1000000000000n }), '150123456');
  p.ui.destroy();
});

test('unknown or live capabilities do not enable a preview', async () => {
  for (const data of [{}, { ...metadata, mode: 'live' }, { ...metadata, network: 'mainnet-beta' }, { ...metadata, fundedLaunchEnabled: true }, { ...metadata, publicLaunchEnabled: true }]) {
    const p = page({ respond: async () => data }); await p.ui.load(); await p.preview(); assert.equal(p.calls.length, 1); assert.equal(p.get('preview').disabled, true); p.ui.destroy();
  }
});

test('owner change and session loss clear both private input values and estimates', async () => {
  const p = page(); await p.ui.load(); await p.preview(); p.setAccount({ ...admin, id: 'other' }); await p.preview();
  assert.equal(p.ui.element.hidden, true); assert.equal(p.get('graduation-fee').value, '28.85'); assert.equal(p.get('graduation-fee').readOnly, true); assert.equal(p.get('sol-usd').value, ''); assert.equal(p.get('results').children.length, 0);
  await p.ui.load(); await p.preview(); p.setAccount(null); p.document.dispatchEvent(new p.document.defaultView.Event('curve-account-updated'));
  assert.equal(p.ui.element.hidden, true); assert.equal(p.get('checks').children.length, 0); assert.equal(p.get('results').children.length, 0); p.ui.destroy();
});

test('late metadata and preview responses cannot cross owner changes or clear', async () => {
  const resolvers = []; const p = page({ respond: () => new Promise(resolve => resolvers.push(resolve)) });
  const load = p.ui.load(); p.setAccount({ ...admin, id: 'other' }); resolvers.shift()(metadata); await load; assert.equal(p.ui.element.hidden, true);
  const next = p.ui.load(); resolvers.shift()(metadata); await next;
  const preview = p.preview(); p.ui.clear(); resolvers.shift()({ estimate }); await preview; assert.equal(p.ui.element.hidden, true); assert.equal(p.get('results').children.length, 0);
  p.ui.destroy();
});

test('editing assumptions invalidates a pending estimate and permits a new calculation', async () => {
  const resolvers = []; const p = page({ respond: path => path.endsWith('/preview') ? new Promise(resolve => resolvers.push(resolve)) : metadata }); await p.ui.load();
  const first = p.preview(); p.get('trade-fee').value = '2'; p.get('trade-fee').oninput();
  const second = p.preview({ trading: '2' }); resolvers[0]({ estimate }); await first; assert.equal(p.get('results').children.length, 0);
  resolvers[1]({ estimate: { ...estimate, lpTotalUsd: '32173' } }); await second; assert.match(p.get('results').textContent, /\$32,173\.00/); assert.match(p.get('results').textContent, /bonding fee 2%/); p.ui.destroy();
});

test('pause and destroy invalidate pending results; duplicate clicks do not overlap', async () => {
  let resolve; const p = page({ respond: path => path.endsWith('/preview') ? new Promise(done => { resolve = done; }) : metadata }); await p.ui.load();
  const pending = p.preview(); await p.preview(); assert.equal(p.calls.length, 2); p.setActive(false); p.ui.pause(); resolve({ estimate }); await pending; assert.equal(p.get('results').children.length, 0);
  p.setActive(true); await p.ui.load(); const again = p.preview(); p.ui.destroy(); resolve({ estimate }); await again; assert.equal(p.get('results').children.length, 0); assert.equal(p.ui.element.hidden, true);
});

test('API failures do not expose private provider details and response text stays inert', async () => {
  const p = page({ respond: path => { if (path.endsWith('/preview')) throw Error('PRIVATE_RPC_SECRET'); return { ...metadata, blockers: ['<img src=x onerror=alert(1)>'], verification: { model: '<script>alert(1)</script>' } }; } });
  await p.ui.load(); assert.equal(p.ui.element.querySelector('img,script'), null); assert.match(p.get('checks').textContent, /<img src=x/); await p.preview(); assert.doesNotMatch(p.ui.element.textContent, /PRIVATE_RPC_SECRET/); assert.match(p.get('status').textContent, /preview could not be calculated/); p.ui.destroy();
});


test('missing model values are unavailable instead of reporting a completed zero or partial estimate', async () => {
  const p = page({ respond: path => path.endsWith('/preview') ? { estimate: { lpTotalUsd: '0' } } : metadata }); await p.ui.load(); await p.preview();
  assert.equal(p.get('results').children.length, 0); assert.match(p.get('status').textContent, /preview could not be calculated/); p.ui.destroy();
});


test('private micro preset changes only the preview payload and displays its own targets', async () => {
  const p = page({ respond: (path, body) => path.endsWith('/preview') ? { estimate: { ...estimate, lpTotalUsd: '250', poolOpeningFdvUsd: body.preset === 'micro-test' ? '500' : '50000' } } : metadata }); await p.ui.load();
  assert.equal(p.get('preset').value, 'standard'); await p.preview({ preset: 'micro-test' });
  assert.equal(p.calls.at(-1).body.preset, 'micro-test'); assert.match(p.get('results').textContent, /\$100 start → \$500 graduation/); assert.match(p.get('results').textContent, /\$500\.00/);
  assert.doesNotMatch(p.get('results').textContent, /20,000|50,000/);
  p.get('preset').value = 'standard'; p.get('preset').onchange(); assert.equal(p.get('results').children.length, 0);
  await p.preview(); assert.equal(p.calls.at(-1).body.preset, 'standard'); assert.match(p.get('results').textContent, /\$20,000 start → \$50,000 graduation/); p.ui.clear(); assert.equal(p.get('preset').value, 'standard'); p.ui.destroy();
});
