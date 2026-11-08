// Admin → Tokens → Pump.fun: owner-only, MFA-gated controls. Every flag change and
// launch action needs a reason plus the owner's password and 2FA code, buttons
// follow the server's state, and the view prints only the fields it knows (it can
// ask the server to verify keys but never shows key material).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createAdminPumpClassic } from '../public/admin-pump-classic-ui.mjs';

const OWNER = { id: 'owner', role: 'admin', mfaEnabled: true }, NOW = 1790668800000;
const MINT = '9J7iw6jVxqPoiBMXWsWRNAsgFT9qkkkVHyAS26euwoBq', W = c => c.repeat(44);
const FLAG_LABELS = { intake: 'New launches and coin creation', collection: 'Creator-fee collection', routing: 'Sweeps to the treasury, Gotchi pots and agents', holders: 'Holder reward payouts', strategies: 'Market Maker and Liquidity Manager trading' };
const strategy = (extra = {}) => ({ kind: 'market_maker', label: 'Market Maker', status: 'active', statusLabel: 'Active', cashSol: '1.4', tokens: '1000', lp: '0', contributedSol: '1', equitySol: '1.5', resultSol: '0.5', feesSpentSol: '0.01', lastActionAt: NOW, pauseReason: '', ...extra });
const launch = (extra = {}) => ({ id: 'l1', name: 'Orbit Garden', symbol: 'ORBIT', mode: 'market_maker', modeLabel: 'Market Maker', state: 'created', stateLabel: 'Live on Pump.fun', reason: '', dimensions: { delivery: 'delivered', fees: 'verified', venue: 'curve', refund: 'refunded' }, policyVersion: 'pump-classic-v1', createAttempts: 1, mint: MINT, developerWallet: W('D'), launchWallet: W('E'), protocolWallet: W('F'), modeWallet: W('G'), recipient: W('D'), balances: { protocol: { credited: '0.5', debited: '0.4', costs: '0.001' } }, feeTotals: { platform: '0.1' }, strategy: strategy(), openOperations: [], events: [{ at: NOW, title: 'Fee recipients verified', body: '' }], hidden: false, secretKey: 'SECRET_MUST_NOT_RENDER', keyDocument: 'KEYDOC_MUST_NOT_RENDER', ...extra });
const overview = (patch = {}) => ({ available: true, flags: { intake: true, collection: false, routing: false, holders: false, strategies: false }, flagLabels: FLAG_LABELS, effective: { master: true, intake: true }, policy: { version: 'pump-classic-v1' }, lastPassAt: NOW, lastError: '', database: { ok: true, version: 1 }, launches: [launch()], ...patch });

function page({ account = OWNER, respond = async () => overview(), authorize = async () => ({ password: 'pw', code: '123456' }) } = {}) {
  const { document } = parseHTML('<html><body></body></html>'); Object.defineProperty(document, 'hidden', { value: false, writable: true });
  const calls = [], auths = [], messages = []; let active = true;
  const ui = createAdminPumpClassic({ document, getAccount: () => account, isActive: () => active, message: (text, error) => messages.push({ text, error: !!error }), security: { authorize: async (label, options) => { auths.push({ label, options }); return authorize(label, options); } }, api: async (path, body) => { calls.push({ path, body }); return respond(path, body); }, setTimer: () => 1, clearTimer: () => {} });
  document.body.append(ui.element);
  const get = id => document.getElementById(id), buttons = root => [...(root || ui.element).querySelectorAll('button')], byText = (text, root) => buttons(root).find(b => b.textContent === text);
  return { ui, document, calls, auths, messages, get, buttons, byText, account: value => { account = value; }, active: value => { active = value; } };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('the Pump.fun admin view needs an admin with MFA and never calls the API otherwise', async () => {
  for (const account of [null, {}, { ...OWNER, role: 'user' }, { ...OWNER, mfaEnabled: false }]) {
    const p = page({ account }); await p.ui.load(); assert.equal(p.calls.length, 0); assert.equal(p.ui.element.hidden, true); p.ui.destroy();
  }
  const p = page(); p.active(false); await p.ui.load(); assert.equal(p.calls.length, 0); p.ui.destroy();
});

test('flags render with readable labels and every change needs a reason plus password and 2FA', async () => {
  const p = page({ respond: async (path, body) => path.endsWith('/control') ? overview({ flags: { ...overview().flags, ...body.flags } }) : overview() });
  await p.ui.load();
  assert.deepEqual(p.buttons(p.get('admin-pump-classic-flags')).map(b => b.textContent), ['Disable new launches', 'Enable creator-fee collection', 'Enable sweeps', 'Enable holder reward payouts', 'Enable Market Maker and Liquidity Manager trading']);
  assert.match(p.get('admin-pump-classic-status').textContent, /master switch on/);
  const enable = p.byText('Enable creator-fee collection');
  enable.onclick(); await settle(); assert.equal(p.auths.length, 0, 'no reason, no prompt'); assert.match(p.messages.at(-1).text, /reason/);
  p.get('admin-pump-classic-reason').value = 'Turning on collection after the first launch';
  p.byText('Enable creator-fee collection').onclick(); await settle(); await settle();
  assert.deepEqual(p.auths[0], { label: 'Enable creator-fee collection', options: { requireCode: true } });
  const post = p.calls.find(c => c.path === '/api/admin/pump-classic/control');
  assert.deepEqual(post.body, { flags: { collection: true }, reason: 'Turning on collection after the first launch', password: 'pw', code: '123456' });
  assert.ok(p.byText('Disable creator-fee collection'), 'the view re-renders from the server response');
  p.ui.destroy();
});

test('a cancelled 2FA prompt sends nothing', async () => {
  const p = page({ authorize: async () => { throw Error('Cancelled.'); } });
  await p.ui.load(); p.get('admin-pump-classic-reason').value = 'Pausing for review';
  p.byText('Disable new launches').onclick(); await settle(); await settle();
  assert.equal(p.calls.filter(c => c.path.endsWith('/control')).length, 0); assert.equal(p.messages.some(m => m.error), false); p.ui.destroy();
});

test('launch buttons follow the launch and strategy state; unknown fields never render', async () => {
  const rows = [launch(), launch({ id: 'l2', symbol: 'PAUSE', strategy: strategy({ status: 'paused', statusLabel: 'Paused', pauseReason: 'Loss limit reached' }) }), launch({ id: 'l3', symbol: 'FUND', mode: 'creator', modeLabel: 'Creator', state: 'funded', stateLabel: 'Funded', mint: null, strategy: null, hidden: true }), launch({ id: 'l4', symbol: 'DONE', strategy: strategy({ status: 'retired', statusLabel: 'Retired' }) })];
  const p = page({ respond: async () => overview({ launches: rows }) }); await p.ui.load();
  const card = id => p.ui.element.querySelector(`[data-launch="${id}"]`), labels = id => p.buttons(card(id)).map(b => b.textContent);
  assert.deepEqual(labels('l1'), ['Pause strategy', 'Retire strategy', 'Hide (moderation)']);
  assert.deepEqual(labels('l2'), ['Resume strategy', 'Retire strategy', 'Hide (moderation)']); assert.match(card('l2').textContent, /Paused: Loss limit reached/);
  assert.deepEqual(labels('l3'), ['Refund before creation', 'Unhide']);
  assert.deepEqual(labels('l4'), ['Return strategy SOL to the funding wallet', 'Hide (moderation)'], 'a retired strategy offers only the SOL return');
  assert.doesNotMatch(p.ui.element.textContent, /SECRET_MUST_NOT_RENDER|KEYDOC_MUST_NOT_RENDER/);
  const coinLinks = [...card('l1').querySelectorAll('a')].map(a => a.getAttribute('href'));
  assert.ok(coinLinks.includes('/coin?mint=' + MINT) && coinLinks.includes('https://pump.fun/coin/' + MINT));
  p.get('admin-pump-classic-reason').value = 'Refund requested by creator';
  p.byText('Refund before creation', card('l3')).onclick(); await settle(); await settle();
  assert.deepEqual(p.calls.find(c => c.path.endsWith('/control')).body, { launchId: 'l3', action: 'refund', reason: 'Refund requested by creator', password: 'pw', code: '123456' });
  p.get('admin-pump-classic-reason').value = 'Owner test coin, returning its SOL';
  p.byText('Return strategy SOL to the funding wallet', card('l4')).onclick(); await settle(); await settle();
  assert.deepEqual(p.calls.filter(c => c.path.endsWith('/control')).at(-1).body, { launchId: 'l4', action: 'withdraw-strategy-sol', reason: 'Owner test coin, returning its SOL', password: 'pw', code: '123456' });
  p.ui.destroy();
});

test('a coin on another pair shows its pair, creator fee, pair ledger and conversions to SOL', async () => {
  const row = launch({ id: 'l4', mode: 'gotchi', modeLabel: 'Gotchi', strategy: null, pair: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6, kind: 'listed' }, creatorFeeBps: 0, feeUnit: 'USDC', feeTotals: { protocol: '25', gotchi: '225' }, fundedPair: '25', pairRefund: 'complete',
    pairBalances: { protocol: { credited: '25', converted: '20', held: '5' } }, conversions: [{ role: 'protocol', state: 'confirmed', input: '20', outputSol: '0.13', signature: '5'.repeat(88) }] });
  const custom = launch({ id: 'l5', mode: 'creator', modeLabel: 'Creator', strategy: null, pair: { mint: W('X'), symbol: 'EXMx', decimals: 8, kind: 'custom' }, creatorFeeBps: 250, feeUnit: 'EXMx', feeTotals: { protocol: '1' } });
  const stuck = launch({ id: 'l6', symbol: 'STUCK', mode: 'creator', modeLabel: 'Creator', state: 'failed', stateLabel: 'Failed', strategy: null, pair: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6, kind: 'listed' }, feeUnit: 'USDC', pairRefund: 'pending', dimensions: { delivery: 'none', fees: 'pending', venue: 'curve', refund: 'pending' } });
  const p = page({ respond: async () => overview({ launches: [row, custom, stuck] }) }); await p.ui.load();
  const card = id => p.ui.element.querySelector(`[data-launch="${id}"]`);
  assert.match(card('l4').textContent, /paired with USDC \(listed\)/); assert.match(card('l4').textContent, /Distributed · Platform share25 USDC/); assert.match(card('l4').textContent, /Platform share · USDC received \/ converted \/ held25 \/ 20 \/ 5 USDC/);
  assert.match(card('l4').textContent, /USDC refundcomplete/); assert.match(card('l4').textContent, /Funded USDC25/); assert.match(card('l4').textContent, /Conversions to SOL/); assert.match(card('l4').textContent, /Platform share · 20 USDC → 0\.13 SOL · confirmed/);
  assert.match(card('l5').textContent, /paired with EXMx \(custom\) · creator fee 2\.5%/);
  assert.equal(p.byText('Release SOL refund', card('l4')), undefined, 'nothing to release once the pair refund is done');
  p.get('admin-pump-classic-reason').value = 'Issuer froze the account';
  p.byText('Release SOL refund', card('l6')).onclick(); await settle(); await settle();
  assert.deepEqual(p.calls.find(c => c.path.endsWith('/control')).body, { launchId: 'l6', action: 'release-sol-refund', reason: 'Issuer froze the account', password: 'pw', code: '123456' });
  assert.doesNotMatch(p.ui.element.textContent, /SECRET_MUST_NOT_RENDER|KEYDOC_MUST_NOT_RENDER/); p.ui.destroy();
});

test('a Holders coin shows its payouts in the pair asset and can be paid now (reason, password and 2FA)', async () => {
  const amada = launch({ id: 'l7', symbol: 'DELTA', mode: 'holders', modeLabel: 'Holders', strategy: null, pair: { mint: 'AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES', symbol: 'AMD', decimals: 6, kind: 'custom' }, feeUnit: 'AMD', feeTotals: { protocol: '0.3', rewards: '2.8' },
    pairBalances: { protocol: { credited: '0.3', converted: '0', held: '0.3' }, rewards: { credited: '2.8', converted: '0.08', paid: '2.7', held: '0.02' } },
    holderPayout: { asset: 'AMD', thresholdUsd: 100, held: '0.02', open: null, last: { state: 'completed', reason: 'Paid 2.7 AMD to 29 holders.', paid: '2.7', asset: 'AMD', recipients: 29, source: 'auto', at: NOW } } });
  const paying = launch({ id: 'l8', symbol: 'BUSY', mode: 'holders', modeLabel: 'Holders', strategy: null, holderPayout: { asset: 'SOL', thresholdUsd: 100, held: '0.2', open: { source: 'admin', stage: 'collect', note: 'Collecting this coin’s creator fees.', at: NOW, valueUsd: null, requests: 1 }, last: null } });
  const blocked = launch({ id: 'l9', symbol: 'STOP', mode: 'holders', modeLabel: 'Holders', strategy: null, holderPayout: { asset: 'AMD', thresholdUsd: 100, held: '1', open: null, last: { state: 'blocked', reason: 'The holder rewards wallet needs a little SOL for 12 new holder accounts.', paid: '0', asset: 'AMD', recipients: 0, source: 'auto', at: NOW } } });
  // v71.35: the server says which other modes can pay holders now (Diamond Hands always; Earned once failed; Insured while refunding).
  const diamond = launch({ id: 'l10', symbol: 'DIAM', mode: 'diamond_hands', modeLabel: 'Diamond Hands', strategy: null, paysHolders: true, holderPayout: { asset: 'SOL', thresholdUsd: 100, held: '0.3', open: null, last: null } });
  const earned = launch({ id: 'l11', symbol: 'EARN', mode: 'earned', modeLabel: 'Earned', strategy: null, paysHolders: false, holderPayout: null });
  const p = page({ respond: async () => overview({ launches: [amada, paying, blocked, diamond, earned] }) }); await p.ui.load();
  const card = id => p.ui.element.querySelector(`[data-launch="${id}"]`);
  assert.ok(p.byText('Pay holders now', card('l10')), 'a Diamond Hands coin can be paid now'); assert.equal(p.byText('Pay holders now', card('l11')), undefined, 'an Earned coin in probation cannot');
  assert.match(card('l7').textContent, /Holder rewards · AMD received \/ sold for costs \/ paid to holders \/ held2\.8 \/ 0\.08 \/ 2\.7 \/ 0\.02 AMD/);
  assert.match(card('l7').textContent, /Holder payoutsIdle/); assert.match(card('l7').textContent, /Ready to pay0\.02 AMD/); assert.match(card('l7').textContent, /Automatic at\$100/); assert.match(card('l7').textContent, /2\.7 AMD to 29 holders/);
  assert.match(card('l8').textContent, /Holder payoutsRequested · collecting creator fees/); assert.match(card('l8').textContent, /Collecting this coin’s creator fees\./);
  assert.equal(p.byText('Pay holders now', card('l8')), undefined, 'not while a payout is open');
  assert.match(card('l9').textContent, /needs a little SOL for 12 new holder accounts/);
  p.get('admin-pump-classic-reason').value = 'Pay DELTA holders now';
  p.byText('Pay holders now', card('l7')).onclick(); await settle(); await settle();
  assert.deepEqual(p.calls.find(c => c.path.endsWith('/control')).body, { launchId: 'l7', action: 'pay-holders', reason: 'Pay DELTA holders now', password: 'pw', code: '123456' });
  assert.equal(p.auths.at(-1).label, 'Pay holders now · DELTA'); p.ui.destroy();
});

test('a host without the master switch shows the reason and no controls; key checks report only results', async () => {
  const off = page({ respond: async () => ({ available: false, reason: 'Pump.fun launches are disabled on this host. Set LAUNCHPAD_PUMP_CLASSIC_ENABLED=1 in /etc/launchpad.env and restart.', flagLabels: FLAG_LABELS }) });
  await off.ui.load(); assert.match(off.get('admin-pump-classic-status').textContent, /LAUNCHPAD_PUMP_CLASSIC_ENABLED=1/); assert.equal(off.buttons(off.get('admin-pump-classic-flags')).length, 0); assert.equal(off.get('admin-pump-classic-reason').disabled, true); off.ui.destroy();
  const p = page({ respond: async path => path.endsWith('/keys/verify') ? { ok: false, checked: 2, rows: [{ id: 'l1', ok: true }, { id: 'l2', ok: false, error: 'mint key does not match its address' }] } : overview() });
  await p.ui.load(); p.byText('Verify launch keys').onclick(); await settle(); await settle();
  assert.equal(p.calls.at(-1).path, '/api/admin/pump-classic/keys/verify'); assert.equal(p.get('admin-pump-classic-result').textContent, 'l2: mint key does not match its address'); p.ui.destroy();
});

test('balances use role names, strategy tokens are whole coins and dates carry the year', async () => {
  const row = launch({ strategy: strategy({ tokens: '41000000000000', lp: '1234567890' }) });
  const p = page({ respond: async () => overview({ launches: [row] }) }); await p.ui.load();
  const text = p.ui.element.querySelector('[data-launch="l1"]').textContent;
  assert.match(text, /Platform share · SOL credited \/ debited \/ costs0\.5 \/ 0\.4 \/ 0\.001 SOL/); assert.match(text, /Distributed · Platform share0\.1 SOL/);
  assert.match(text, /Tokens41,000,000 ORBIT/); assert.match(text, /LP tokens \(raw units\)1,234,567,890/);
  assert.doesNotMatch(text, /protocol credited|Tokens \(raw\)|41000000000000/);
  assert.match(text, new RegExp(String(new Date(NOW).getFullYear())), 'event dates include the year');
  p.ui.destroy();
});

// ---- v71.26: compact rows, 25 a page, filters ----
test('launches are read a page at a time with the filter in the query, listed as rows that open to the full card', async () => {
  const rows = Array.from({ length: 3 }, (_, i) => launch({ id: 'l' + i, symbol: 'C' + i, mint: MINT }));
  const p = page({ respond: async () => overview({ launches: rows, launchTotal: 40, counts: { total: 42, archived: 2, attention: 4, byState: { created: 30, failed: 5 }, byMode: {} }, offset: 25, limit: 25, nextOffset: null }) });
  await p.ui.load();
  assert.equal(p.calls[0].path, '/api/admin/pump-classic?offset=0&limit=25');
  assert.equal(p.ui.element.querySelectorAll('.admin-launch-row').length, 3);
  const first = p.ui.element.querySelector('.admin-launch-row');
  assert.equal(first.open, false, 'rows start closed'); assert.match(first.querySelector('summary').textContent, /\$C0 · Orbit Garden/); assert.match(first.querySelector('summary').textContent, /Live on Pump\.fun/);
  assert.ok(first.querySelector('[data-launch="l0"]'), 'the full card sits inside the row');
  assert.match(p.ui.element.querySelector('.admin-pager').textContent, /26–28 of 40 launches/);
  assert.match(p.ui.element.textContent, /Launches \(42\)/);
  assert.match(p.ui.element.dataset.adminSummary, /30 live · 4 need attention/);
  const chips = [...p.ui.element.querySelectorAll('[data-chip]')].map(b => b.textContent);
  assert.deepEqual(chips.slice(0, 3), ['All40', 'Needs attention4', 'Live30']);
  p.ui.element.querySelector('[data-chip=failed]').onclick(); await settle();
  assert.equal(p.calls.at(-1).path, '/api/admin/pump-classic?offset=0&limit=25&state=failed');
  p.ui.element.querySelector('[data-chip=archived]').onclick(); await settle();
  assert.equal(p.calls.at(-1).path, '/api/admin/pump-classic?offset=0&limit=25&archived=1');
  await p.ui.find('orbit'); assert.equal(p.calls.at(-1).path, '/api/admin/pump-classic?offset=0&limit=25&search=orbit&archived=1');
  p.ui.destroy();
});

test('an unpaged response (an action result) is filtered and paged in the view; settled failures offer Archive', async () => {
  const rows = [launch(), launch({ id: 'l2', symbol: 'GONE', state: 'refunded', stateLabel: 'Refunded', strategy: null, dimensions: { refund: 'complete' }, archive: { eligible: true, reason: '' } }), launch({ id: 'l3', symbol: 'OLD', state: 'expired', stateLabel: 'Quote expired', strategy: null, archived: true, archive: { eligible: false, reason: 'This launch is already archived.' } }), launch({ id: 'l4', symbol: 'WAIT', state: 'failed', stateLabel: 'Failed', strategy: null, dimensions: { refund: 'pending' }, attention: [{ code: 'refund', text: 'Refund waiting' }] })];
  const p = page({ respond: async () => overview({ launches: rows }) }); await p.ui.load();
  const ids = () => [...p.ui.element.querySelectorAll('[data-launch]')].map(c => c.dataset.launch);
  assert.deepEqual(ids(), ['l1', 'l2', 'l4'], 'archived launches are left out until the Archived chip');
  const card = id => p.ui.element.querySelector(`[data-launch="${id}"]`);
  assert.deepEqual(p.buttons(card('l2')).map(b => b.textContent), ['Archive', 'Hide (moderation)']);
  assert.match(p.ui.element.querySelector('[data-launch-row="l4"] summary').textContent, /Refund waiting/);
  p.get('admin-pump-classic-reason').value = 'Cleanup from the admin panel.';
  p.byText('Archive', card('l2')).onclick(); await settle(); await settle();
  assert.deepEqual(p.calls.find(c => c.path.endsWith('/control')).body, { launchId: 'l2', action: 'archive', reason: 'Cleanup from the admin panel.', password: 'pw', code: '123456' });
  p.ui.element.querySelector('[data-chip=archived]').onclick(); await settle();
  assert.deepEqual(ids(), ['l3']); assert.deepEqual(p.buttons(card('l3')).map(b => b.textContent), ['Restore from archive', 'Hide (moderation)']);
  p.ui.element.querySelector('[data-chip=attention]').onclick(); await settle(); assert.deepEqual(ids(), ['l4']);
  p.ui.destroy();
});
