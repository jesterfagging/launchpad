// Admin → Tokens → Robinhood Chain: owner-only, MFA-gated controls. Every flag change, owner transaction, pair action and
// launch action needs a reason plus the owner's password and 2FA code; buttons follow the server's state (the factory's
// owner and switches, each pair's approval, each launch's state); the view prints only the fields it knows and never
// key material.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createAdminRobinhood } from '../public/admin-robinhood-ui.mjs';

const OWNER = { id: 'owner', role: 'admin', mfaEnabled: true }, NOW = 1790668800000;
const TOKEN = '0x5a3b7c9d1e2f4a6b8c0d2e4f6a8b0c2d4e6f8a1b', HOST_OWNER = '0x1111111111111111111111111111111111111111', HOST_PLATFORM = '0x2222222222222222222222222222222222222222';
const factory = (extra = {}) => ({ owner: HOST_OWNER, pendingOwner: '0x0000000000000000000000000000000000000000', ownerIsHost: true, launchesOpen: true, launchFee: '0.001', platformRecipient: HOST_PLATFORM, platformIsHost: true, config: { totalSupply: '1000000000000000000000000000', curveProtocolFeeBps: 125, curveCreatorFeeBps: 50, poolProtocolFeeBps: 25, poolCreatorFeeBps: 25, taxPlatformShareBps: 500, minTaxBps: 100, maxTaxBps: 300, tickSpacing: 10, enabled: true }, blockers: [], ...extra });
const launch = (extra = {}) => ({ id: 'ab12cd34ef56ab12cd34ef56', state: 'created', stateLabel: 'Live on Robinhood Chain', reason: '', mode: 'holders', modeLabel: 'Holders', paysHolders: true, name: 'Orbit Garden', symbol: 'ORBIT', token: TOKEN, predictedToken: TOKEN, curve: '0x1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d', dimensions: { launch: 'live', fees: 'verified', venue: 'curve', refund: 'complete' }, pair: { symbol: 'ETH', decimals: 18, kind: 'native' }, tier: { id: '4k', label: '$4k start' }, taxBps: 200, fees: { taxBps: 200, curveTotalBps: 325, poolTotalBps: 250, curveShareBps: 4153, poolShareBps: 1400, stage: 'curve', creatorShape: false }, rules: 1, liveAt: NOW - 3600000, createdAt: NOW - 3700000, venueState: 'curve', hidden: false, archived: false, createAttempts: 1, holders: 3,
  developerWallet: '0x9a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d', launchWallet: '0x3333333333333333333333333333333333333333', feeWallet: '0x4444444444444444444444444444444444444444', quote: { launchFeeEth: '0.001', devBuy: '0.05', devBuySymbol: 'ETH', gasBudgetEth: '0.0014', feeWalletGasEth: '0.001', totalEth: '0.0534', pairUsd: '3980.12' },
  balances: [{ role: 'rewards', asset: '0x0000000000000000000000000000000000000000', available: '0.0028', credited: '0.0091' }], openOperations: [], events: [], holderPayout: { asset: 'ETH', thresholdUsd: 100, held: '0.0028', open: null, last: null }, feeClaims: [], secretKey: 'NEVER', ...extra });
const overview = (patch = {}) => ({ available: true, configured: true, flags: { intake: true, pairs: false, collection: true, routing: true, holders: true }, effective: { master: true, intake: true, pairs: false, collection: true, routing: true, holders: true }, policy: { version: 'robinhood-launch-v1', hash: 'ab12' }, contracts: { factory: '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0', escrow: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512' }, treasury: null,
  host: { owner: HOST_OWNER, platform: HOST_PLATFORM, balances: { owner: '0.4821', platform: '0.0512', platformEscrow: '0.0073' } }, factory: factory(), factoryError: '',
  pairs: [{ address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', name: 'Ether', kind: 'native', decimals: 18, approved: true, enabled: true }, { address: '0xAaAa000000000000000000000000000000000001', symbol: 'NVDA', name: 'NVIDIA', kind: 'stock', decimals: 18, approved: true, enabled: false }, { address: '0xAaAa000000000000000000000000000000000002', symbol: 'AAPL', name: 'Apple', kind: 'stock', decimals: 18, approved: false, enabled: false }],
  lastPassAt: NOW - 12000, lastError: null, passes: 412, db: { version: 1, ok: true }, counts: { created: 1 }, total: 1, offset: 0, limit: 25, rows: [launch()], ...patch });

function page({ account = OWNER, respond = async () => overview(), authorize = async () => ({ password: 'pw', code: '123456' }) } = {}) {
  const { document } = parseHTML('<html><body></body></html>'); Object.defineProperty(document, 'hidden', { value: false, writable: true });
  const calls = [], auths = [], messages = []; let active = true;
  const ui = createAdminRobinhood({ document, getAccount: () => account, isActive: () => active, message: (text, error) => messages.push({ text, error: !!error }), security: { authorize: async (label, options) => { auths.push({ label, options }); return authorize(label, options); } }, api: async (path, body) => { calls.push({ path, body }); return respond(path, body); }, setTimer: () => 1, clearTimer: () => {}, clock: () => NOW });
  document.body.append(ui.element);
  const get = id => document.getElementById(id), buttons = root => [...(root || ui.element).querySelectorAll('button')], byText = (text, root) => buttons(root).find(b => b.textContent === text);
  return { ui, document, calls, auths, messages, get, buttons, byText, account: value => { account = value; }, active: value => { active = value; } };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('the Robinhood admin view needs an admin with MFA and never calls the API otherwise', async () => {
  for (const account of [null, {}, { ...OWNER, role: 'user' }, { ...OWNER, mfaEnabled: false }]) {
    const p = page({ account }); await p.ui.load(); assert.equal(p.calls.length, 0); assert.equal(p.ui.element.hidden, true); p.ui.destroy();
  }
  const p = page(); p.active(false); await p.ui.load(); assert.equal(p.calls.length, 0); p.ui.destroy();
});

test('flags, the factory and the host wallets render; a flag change needs a reason plus password and 2FA', async () => {
  const p = page({ respond: async (path, body) => path.endsWith('/control') ? overview({ flags: { ...overview().flags, ...body.flags } }) : overview() });
  await p.ui.load();
  assert.deepEqual(p.buttons(p.get('admin-robinhood-flags')).map(b => b.textContent), ['Disable new launches', 'Enable stock and ETF pairs', 'Disable fee collection', 'Disable sweeps', 'Disable holder reward payouts']);
  assert.match(p.get('admin-robinhood-status').textContent, /Contracts configured.*412 passes.*database v1/);
  const factoryText = p.get('admin-robinhood-factory').textContent;
  assert.match(factoryText, /the host owner wallet/); assert.match(factoryText, /0\.001 ETH/); assert.match(factoryText, /0\.4821 ETH/); assert.match(factoryText, /Platform share waiting in the escrow0\.0073 ETH/);
  assert.match(factoryText, /supply 1000000000 · curve pool 1\.25% Launchpad \+ 0\.5% creator · graduation pool 0\.25% \+ 0\.25% · holder tax 1%–3% \(5% of it Launchpad’s\)/, 'the v3 fee config on the card (v71.41)');
  assert.equal(p.ui.element.textContent.includes('NEVER'), false, 'unknown fields never render');
  p.byText('Enable stock and ETF pairs').onclick(); await settle(); assert.equal(p.auths.length, 0); assert.match(p.messages.at(-1).text, /reason/);
  p.get('admin-robinhood-reason').value = 'Opening stocks after the pair checks';
  p.byText('Enable stock and ETF pairs').onclick(); await settle(); await settle();
  assert.deepEqual(p.auths[0], { label: 'Enable stock and ETF pairs', options: { requireCode: true } });
  const post = p.calls.find(c => c.path === '/api/admin/robinhood/control');
  assert.deepEqual(post.body, { flags: { pairs: true }, reason: 'Opening stocks after the pair checks', password: 'pw', code: '123456' });
  assert.ok(p.byText('Disable stock and ETF pairs'), 'the view re-renders from the server response');
  p.ui.destroy();
});

test('owner transactions follow the factory: accept ownership before, platform recipient and switches after', async () => {
  const pending = page({ respond: async () => overview({ factory: factory({ owner: '0x9999999999999999999999999999999999999999', ownerIsHost: false, pendingOwner: HOST_OWNER, platformIsHost: false, platformRecipient: '0x9999999999999999999999999999999999999999', blockers: ['Launches are closed on the factory.'] }) }) });
  await pending.ui.load();
  assert.deepEqual(pending.buttons(pending.get('admin-robinhood-tools')).map(b => b.textContent), ['Sync pairs', 'Accept factory ownership', 'Verify stored keys', 'Back up the database']);
  assert.match(pending.get('admin-robinhood-factory').textContent, /pending: 0x1111/); assert.match(pending.get('admin-robinhood-factory').textContent, /Launches are closed on the factory/);
  pending.get('admin-robinhood-reason').value = 'Taking over the factory after deploy';
  pending.byText('Accept factory ownership').onclick(); await settle(); await settle();
  assert.deepEqual(pending.calls.find(c => c.path.endsWith('/control')).body, { reason: 'Taking over the factory after deploy', action: 'accept-ownership', password: 'pw', code: '123456' });
  pending.ui.destroy();
  const owned = page({ respond: async () => overview({ factory: factory({ platformIsHost: false, platformRecipient: '0x9999999999999999999999999999999999999999', launchesOpen: false }) }) });
  await owned.ui.load();
  assert.deepEqual(owned.buttons(owned.get('admin-robinhood-tools')).map(b => b.textContent), ['Sync pairs', 'Approve all 1 listed pairs on chain', 'Set platform recipient to the host wallet', 'Open launches on the factory', 'Verify stored keys', 'Back up the database']);
  owned.get('admin-robinhood-reason').value = 'Approving every listed stock';
  owned.byText('Approve all 1 listed pairs on chain').onclick(); await settle(); await settle();
  assert.deepEqual(owned.calls.find(c => c.path.endsWith('/control')).body, { reason: 'Approving every listed stock', action: 'approve-pairs', addresses: ['0xAaAa000000000000000000000000000000000002'], password: 'pw', code: '123456' });
  owned.byText('Sync pairs').onclick(); await settle(); await settle();
  assert.deepEqual(owned.calls.filter(c => c.path.endsWith('/control')).at(-1).body, { reason: '', action: 'sync-pairs', password: 'pw', code: '123456' }, 'a sync needs no reason');
  owned.ui.destroy();
});

test('pairs offer approval on chain and the creator switch; launch buttons follow the launch state', async () => {
  const rows = [launch(), launch({ id: 'ab12cd34ef56ab12cd34ef57', symbol: 'FUND', state: 'funded', stateLabel: 'Funded', token: null, paysHolders: false, holderPayout: null, hidden: true }), launch({ id: 'ab12cd34ef56ab12cd34ef58', symbol: 'DONE', state: 'refunded', stateLabel: 'Refunded', token: null, paysHolders: false, holderPayout: null, dimensions: { launch: 'failed', refund: 'complete' } }), launch({ id: 'ab12cd34ef56ab12cd34ef59', symbol: 'GRAD', venueState: 'graduated', dimensions: { launch: 'live', fees: 'verified', venue: 'graduated', refund: 'complete' } })];
  const p = page({ respond: async () => overview({ rows, total: rows.length }) }); await p.ui.load();
  const pairRows = [...p.get('admin-robinhood-pairs').querySelectorAll('.admin-pairs-table:not(.admin-pair-requests *) tbody tr')].filter(tr => !tr.closest('.admin-pair-requests'));
  assert.equal(pairRows.length, 3);
  assert.deepEqual(p.buttons(pairRows[0]).map(b => b.textContent), [], 'ETH is always approved and offered');
  assert.deepEqual(p.buttons(pairRows[1]).map(b => b.textContent), ['Offer to creators']);
  assert.deepEqual(p.buttons(pairRows[2]).map(b => b.textContent), ['Approve on chain', 'Offer to creators']);
  p.get('admin-robinhood-reason').value = 'Approving Apple after the price check';
  p.byText('Approve on chain', pairRows[2]).onclick(); await settle(); await settle();
  assert.deepEqual(p.calls.find(c => c.path.endsWith('/control')).body, { reason: 'Approving Apple after the price check', action: 'approve-pairs', addresses: ['0xAaAa000000000000000000000000000000000002'], password: 'pw', code: '123456' });
  const card = id => p.ui.element.querySelector(`[data-launch="${id}"]`), labels = id => p.buttons(card(id)).filter(b => !b.classList.contains('admin-copy')).map(b => b.textContent);
  assert.deepEqual(labels('ab12cd34ef56ab12cd34ef56'), ['Pay holders now', 'Record graduation (price past the tick)', 'Collect pool fees now', 'Hide from public lists', 'Retry now'], 'a live coin: graduation can be recorded once the price crossed, pool fees collected any time');
  assert.deepEqual(labels('ab12cd34ef56ab12cd34ef57'), ['Refund (stop before creation)', 'Retry now'], 'a funded launch is not live: no visibility switch');
  assert.deepEqual(labels('ab12cd34ef56ab12cd34ef58'), ['Archive', 'Retry now']);
  assert.deepEqual(labels('ab12cd34ef56ab12cd34ef59'), ['Pay holders now', 'Collect pool fees now', 'Hide from public lists', 'Retry now'], 'a graduated coin keeps collecting its pool fees');
  const summaries = [...p.ui.element.querySelectorAll('.admin-launch-row summary')].map(s => s.textContent);
  assert.match(summaries[0], /\$ORBIT · Orbit Garden/); assert.match(summaries[0], /Live on Robinhood Chain/); assert.match(summaries[3], /Graduated/);
  assert.match(card('ab12cd34ef56ab12cd34ef56').querySelector('.admin-card-heading .help').textContent, /Holders · paired with ETH · \$4k start · holder tax 2% · pool fee 3\.25% → 2\.5% · 1 rule · Live on Robinhood Chain/, 'the fee shape on the card (v71.41)');
  assert.match(card('ab12cd34ef56ab12cd34ef56').textContent, /0x9a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d/); assert.match(card('ab12cd34ef56ab12cd34ef56').textContent, /Holder rewards · ETH available \/ credited0\.0028 \/ 0\.0091/);
  p.byText('Pay holders now', card('ab12cd34ef56ab12cd34ef56')).onclick(); await settle(); await settle();
  assert.deepEqual(p.calls.at(-1).body, { launchId: 'ab12cd34ef56ab12cd34ef56', action: 'pay-holders', reason: 'Approving Apple after the price check', password: 'pw', code: '123456' });
  p.ui.destroy();
});

test('a disabled host says so; a refused factory read shows the error; the list pages with the server', async () => {
  const off = page({ respond: async () => ({ available: false }) }); await off.ui.load();
  assert.match(off.get('admin-robinhood-status').textContent, /disabled on this host/); assert.equal(off.buttons(off.get('admin-robinhood-flags')).length, 0); off.ui.destroy();
  const broken = page({ respond: async () => overview({ factory: null, factoryError: 'RPC timeout' }) }); await broken.ui.load();
  assert.match(broken.get('admin-robinhood-factory').textContent, /could not be read: RPC timeout/); broken.ui.destroy();
  const p = page({ respond: async path => { const q = new URL('http://x' + path).searchParams; return overview({ total: 60, offset: Number(q.get('offset') || 0), rows: [launch({ symbol: 'P' + (q.get('offset') || 0) })] }); } });
  await p.ui.load();
  assert.match(p.calls[0].path, /offset=0&limit=25/);
  assert.match(p.ui.element.querySelector('.admin-launch-row summary').textContent, /\$P0/);
  p.ui.destroy();
});

test('a custom pair is added by address, creators\' requests list with Add / Dismiss, and a custom row can be removed', async () => {
  const CB = '0xCbB7C0000aB88b473B1F5aFd9EF808440eEd33Bf', WLFI = '0xAaAa0000000000000000000000000000000000Aa', DUST = '0xBbBb0000000000000000000000000000000000Bb';
  const extra = { pairs: [{ address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', name: 'Ether', kind: 'native', decimals: 18, approved: true, enabled: true }, { address: CB, symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', kind: 'custom', decimals: 8, approved: false, enabled: false }],
    pairRequests: [{ address: WLFI, symbol: 'WLFI', name: 'World Liberty Financial', decimals: 18, usd: '0.1842', compatible: true, count: 3, accounts: ['a', 'b'], firstAt: 1, lastAt: Date.now() }, { address: DUST, symbol: 'DUST', name: 'Dust', decimals: 18, usd: null, compatible: false, count: 1, accounts: ['c'], firstAt: 1, lastAt: Date.now() }] };
  const p = page({ respond: async () => overview(extra) }); await p.ui.load();
  const box = p.get('admin-robinhood-pairs');
  const requestRows = [...box.querySelectorAll('.admin-pair-requests tbody tr')];
  assert.equal(requestRows.length, 2);
  assert.match(requestRows[0].textContent, /WLFI/); assert.match(requestRows[0].textContent, /\$0\.1842/); assert.match(requestRows[0].textContent, /3 · 2 accounts/);
  assert.deepEqual(p.buttons(requestRows[0]).filter(b => !b.classList.contains('admin-copy')).map(b => b.textContent), ['Add pair', 'Dismiss']);
  assert.deepEqual(p.buttons(requestRows[1]).filter(b => !b.classList.contains('admin-copy')).map(b => b.textContent), ['Dismiss'], 'an unpriced token cannot be added'); assert.match(requestRows[1].textContent, /no pool price/);
  p.get('admin-robinhood-reason').value = 'Creators asked for WLFI three times';
  p.byText('Add pair', requestRows[0]).onclick(); await settle(); await settle();
  assert.deepEqual(p.calls.find(c => c.path.endsWith('/control')).body, { reason: 'Creators asked for WLFI three times', action: 'add-pair', address: WLFI, password: 'pw', code: '123456' });
  p.byText('Dismiss', requestRows[1]).onclick(); await settle(); await settle();
  assert.deepEqual(p.calls.at(-1).body, { reason: 'Creators asked for WLFI three times', action: 'dismiss-pair-request', address: DUST, password: 'pw', code: '123456' });
  // the custom row: approve, offer, remove
  const customRow = [...box.querySelectorAll('tbody tr')].find(tr => /cbBTC/.test(tr.textContent) && !tr.closest('.admin-pair-requests'));
  assert.match(customRow.textContent, /Custom \(Launchpad-added\)/);
  assert.deepEqual(p.buttons(customRow).filter(b => !b.classList.contains('admin-copy')).map(b => b.textContent), ['Approve on chain', 'Offer to creators', 'Remove']);
  p.byText('Remove', customRow).onclick(); await settle(); await settle();
  assert.deepEqual(p.calls.at(-1).body, { reason: 'Creators asked for WLFI three times', action: 'remove-pair', address: CB, password: 'pw', code: '123456' });
  // add by address: a bad address never reaches the API
  const input = box.querySelector('[data-pair-address]'), add = box.querySelector('[data-add-pair]'), before = p.calls.length;
  input.value = '0x123'; add.onclick(); await settle(); assert.equal(p.calls.length, before); assert.match(p.messages.at(-1).text, /40 hex characters/);
  input.value = DUST; add.onclick(); await settle(); await settle();
  assert.deepEqual(p.calls.at(-1).body, { action: 'add-pair', address: DUST, reason: 'Creators asked for WLFI three times', password: 'pw', code: '123456' });
  p.ui.destroy();
});
