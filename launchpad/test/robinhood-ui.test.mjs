import { renderHeaderAccount } from '../public/workspace-shell.js';
import { renderIfChanged } from '../public/ui-performance.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { randomUUID } from 'node:crypto';
import { createRobinhoodAccount } from '../src/robinhood-settings.mjs';
import { createTerminalUI } from '../public/terminal-ui.js';
import { TOOL_NAMES, EVM_NATIVE } from '../public/chains.mjs';
import { WALLET_LIMITS, walletTool } from '../public/wallet-limits.mjs';
import { RobinhoodTelegram } from '../src/robinhood-telegram.mjs';
import { createExecutionPresetsUI } from '../public/execution-presets-ui.js';
import { createAccountConnections } from '../public/account-connections-ui.js';

// DOM execution with an isolated, fake HTTP boundary. This is not a browser
// screenshot or a live provider test; it exercises the actual page event code.
test('web manual menus, durable retry IDs, editable presets and cashback via Connections execute in the DOM', async t => {
  const html = await readFile(new URL('../public/robinhood.html', import.meta.url), 'utf8');
  const source = (await readFile(new URL('../public/robinhood-ui.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
  const { document, window } = parseHTML(html);
  const previousDocument = globalThis.document; globalThis.document = document; t.after(() => { globalThis.document = previousDocument; });
  window.HTMLElement.prototype.showModal = function () { this.open = true; }; window.HTMLElement.prototype.close = function () { this.open = false; };
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    configurable: true,
    get() { return [...this.options].find(o => o.selected)?.value || this.options[0]?.value || ''; },
    set(value) { for (const option of this.options) option.selected = option.value === String(value); },
  });
  const created = createRobinhoodAccount(); let settings = created.settings, revision = 1, manualCount = 0, copied = '', openConnections;
  const calls = [], states = {}, redirect = [], positions = [{ id: 'owned-position', wallet: settings.defaultWallets.liquidity, tokenId: '7', liquidity: '100', lower: -60, upper: 60, pool: { protocol: 'v3' } }];
  const fees = { ready: true, version: 'test-fees', description: 'Copy 0.25%; MM 0.10%', liquidityDescription: 'LP fees', recipient: '' };
  const fetch = async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined; calls.push({ path, body });
    let value;
    if (path === '/api/session') value = { authenticated: true, accounts: true, token: 'test-csrf' };
    else if (path.endsWith('/account')) value = { account: { username: 'tester', mainWallet: created.mainWallet.publicKey, cashbackBps: 10000 }, fees, cashback: [] };
    else if (path.startsWith('/api/account/connections')) value = { chain: 'robinhood', values: { rpcUrl: '' }, revision };
    else if (path.endsWith('/settings')) { if (body) { settings = structuredClone(body.settings); revision++; } value = { settings: structuredClone(settings), revision }; }
    else if (path.includes('/status?')) { const kind = path.split('kind=')[1]; value = { state: states[kind] || 'stopped', positions: kind === 'liquidity' ? positions : [], pending: [], events: [], runs: {} }; }
    else if (path.endsWith('/claim-fees')) value = { state: 'stopped', positions, pending: [], events: [] };
    else if (path.endsWith('/manual')) { if (++manualCount === 1) throw Error('Fixture lost response'); value = { state: 'stopped', positions: [], pending: [], events: [], manualResult: { id: body.trade.id, complete: true, results: body.trade.wallets.map(wallet => ({ wallet, state: 'confirmed' })) } }; }
    else if (path.endsWith('/start') || path.endsWith('/stop')) { states[body.kind] = path.endsWith('/start') ? 'running' : 'stopped'; value = { state: states[body.kind], positions: [], pending: [], events: [] }; }
    else throw Error(`Unexpected fixture request: ${path}`);
    return { ok: true, status: 200, json: async () => value };
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('document', 'fetch', 'location', 'navigator', 'setInterval', 'setTimeout', 'crypto', 'Blob', 'URL', 'TOOL_NAMES', 'EVM_NATIVE', 'WALLET_LIMITS', 'walletTool', 'createTerminalUI', 'renderIfChanged', 'createExecutionPresetsUI', 'createAccountConnections', 'renderHeaderAccount', source)(document, fetch, { assign: u => redirect.push(u), replace: u => redirect.push(u) }, { clipboard: { writeText: async value => { copied = value; } } }, () => 1, setTimeout, { randomUUID }, Blob, URL, TOOL_NAMES, EVM_NATIVE, WALLET_LIMITS, walletTool, options => { openConnections = options.openConnections; }, renderIfChanged, createExecutionPresetsUI, createAccountConnections, renderHeaderAccount);
  const get = id => document.getElementById(id), flush = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
  assert.deepEqual(redirect, []); assert.equal(get('rh-main').hidden, false);
  assert.equal(get('rh-main-wallet').textContent, created.mainWallet.publicKey); assert.match(get('rh-cashback').textContent, /100%/);
  openConnections(); await flush(); const overview = [...document.querySelectorAll('.account-tabs button')].find(b => b.textContent === 'Overview'); overview.onclick(); await flush();
  assert.equal(get('rh-username').textContent, 'tester'); assert.equal(get('rh-main-wallet').textContent, created.mainWallet.publicKey); await get('rh-main-copy').onclick(); assert.equal(copied, created.mainWallet.publicKey); get('rh-account-close').onclick();
  assert.equal(document.querySelectorAll('#rh-execution-presets .execution-preset-tabs button').length, 3);
  document.querySelector('#rh-execution-presets [aria-label="Edit execution presets"]').onclick();
  document.querySelectorAll('.execution-preset-dialog .execution-preset-tabs button')[1].onclick();
  document.querySelector('[data-execution-field="maxGasGwei"]').value = '12'; document.querySelector('[data-execution-field="priorityGwei"]').value = '1';
  document.querySelector('.execution-preset-dialog form').onsubmit({ preventDefault() {} }); await flush();
  assert.equal(settings.executionPresets.selected, 1); assert.equal(settings.maxGasGwei, '12'); assert.equal(settings.priorityGwei, '1');
  assert.match(get('rh-cap').textContent, /2 \/ 25 shared/);
  assert.equal(document.querySelector('.chain-switch [aria-current="page"]').getAttribute('href'), '/robinhood');
  assert.equal(get('rh-stop').disabled, true);
  await get('rh-tools').querySelector('[data-kind="liquidity"]').onclick();
  assert(document.querySelector('[data-field="maxPositions"]')); assert.equal(get('rh-manual-card').hidden, true);
  const compound = document.querySelector('[data-field="autoCompoundFees"]'); compound.checked = true;
  const claim = [...document.querySelectorAll('button')].find(b => b.textContent === 'Claim fees'); assert(claim); await claim.onclick(); await flush();
  const requestedClaim = calls.find(c => c.path.endsWith('/claim-fees'));
  assert.equal(requestedClaim.body.allocation.id, 'owned-position'); assert.equal(requestedClaim.body.kind, 'liquidity'); assert.equal(requestedClaim.body.settings.tools.liquidity.autoCompoundFees, true);
  await get('rh-tools').querySelector('[data-kind="market"]').onclick();
  assert.equal(get('rh-manual-card').hidden, false); assert.equal(document.querySelector('[data-manual-side="sell"]').getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelector('[data-manual-side="buy"]').disabled, true);
  assert.match(get('rh-manual-fee').textContent, /0.10%/);
  get('rh-setup').onsubmit({ preventDefault() {} }); await flush();
  assert(calls.some(c => c.path.endsWith('/start') && c.body.kind === 'market' && c.body.settings.agreedFeeVersion === fees.version));
  assert.equal(get('rh-stop').disabled, false); assert.equal(get('rh-start').disabled, true);
  await get('rh-stop').onclick(); assert.equal(get('rh-stop').disabled, true); assert.equal(get('rh-stop').textContent, 'Stopped');
  await get('rh-tools').querySelector('[data-kind="copy"]').onclick();
  assert.match(document.querySelector('[data-field="buyAmount"]').parentElement.textContent, /Robinhood ETH/);
  assert.equal(get('rh-manual-quote'), null);
  assert.match(document.querySelector('[data-field="budget"]').parentElement.textContent, /ETH budget/);
  get('rh-select-all').checked = true; get('rh-select-all').onchange();
  assert.match(get('rh-selected').textContent, /^2 selected/);
  assert.equal(get('rh-alert').hidden, true);
  document.querySelector('[data-manual-side="buy"]').onclick(); get('rh-manual-token').value = '0x1111111111111111111111111111111111111111'; get('rh-manual-size').value = '0.01';
  await get('rh-manual').onsubmit({ preventDefault() {} }); assert.equal(get('rh-manual-submit').textContent, 'Check this request'); assert.equal(get('rh-manual-fields').disabled, true);
  await get('rh-manual').onsubmit({ preventDefault() {} });
  const orders = calls.filter(c => c.path.endsWith('/manual')); assert.equal(orders.length, 2); assert.deepEqual(orders[0].body, orders[1].body); assert.equal(get('rh-manual-fields').disabled, false);
});

test('Telegram copy manual trading asks for ETH amount without asking for a stock contract', async () => {
  const messages = [], settings = createRobinhoodAccount().settings;
  const bot = { now: () => 1000, deleteInput: async () => {}, button: (_ctx, title, op, args) => ({ title, op, args }), say: (_ctx, message) => messages.push(message) };
  const telegram = new RobinhoodTelegram(bot, { policy: { get: async () => ({ description: 'Copy 0.25%', version: 'test' }) } });
  const ctx = { account: { id: 'test' }, chain: 'robinhood', tool: 'copy', revision: 1, generation: 1, settings, manualDraft: { id: 'manual', kind: 'copy', side: 'buy', wallets: [settings.defaultWallets.copy] } };
  telegram.prompt(ctx, 'manual-token', 'Token');
  await telegram.message(ctx, { text: '0x1111111111111111111111111111111111111111' });
  assert.equal(ctx.prompt, null); assert.match(messages.at(-1), /selected/);
  await telegram.action(ctx, 'rhManualSize', { id: 'manual' }); assert.equal(ctx.prompt.input, 'manual-size'); assert.match(messages.at(-1), /Robinhood ETH amount/);
  await telegram.message(ctx, { text: '0.01' });
  assert.equal(ctx.manualDraft.amount, '0.01'); assert.equal(ctx.manualDraft.quote, ''); assert.match(messages.at(-1), /0.01 ETH \/ wallet/);
  await telegram.action(ctx, 'rhField', { key: 'budget' }); assert.match(messages.at(-1), /ETH/);
});
