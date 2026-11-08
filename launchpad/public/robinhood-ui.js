import { renderHeaderAccount } from './workspace-shell.js';
import { renderIfChanged } from './ui-performance.mjs';
import { createExecutionPresetsUI } from './execution-presets-ui.js';
import { createTerminalUI } from './terminal-ui.js';
import { createAccountConnections } from './account-connections-ui.js';
import { TOOL_NAMES, EVM_NATIVE } from './chains.mjs';
import { WALLET_LIMITS, walletTool } from './wallet-limits.mjs';
const $ = id => document.getElementById(id);
let csrf = '', settings, revision, account, fees, kind = 'copy', latest, saving = false, polling = false, authResolve;
const manualKeys = new Set(), active = {};
let connections, executionUI, manualSubmitting = false, manualUncertain = false, manualRequest = null, manualDirection = 'buy';
const text = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; };
function alert(message = '') { $('rh-alert').textContent = message; $('rh-alert').hidden = !message; }
async function api(path, body, shared = false) {
  const response = await fetch(`${shared ? '/api/' : '/api/robinhood/'}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-control-token': csrf, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); if (response.ok && value.token && ['account/login','account/register','account/mfa/enable'].includes(path)) csrf = value.token;
  if (!response.ok) { if (response.status === 401) location.assign('/?chain=robinhood'); throw Object.assign(Error(value.error || 'Request failed.'), { statusCode: response.status, retryAfterMs: value.retryAfterMs }); } return value;
}
const fields = [
  ['leads','Target addresses (up to 100)','textarea',['copy']], ['developers','Developer wallets (up to 100)','textarea',['sniper']],
  ['launchSource','Launch source',[['both','Pons + LONG'],['pons','Pons'],['long','LONG']],['sniper']],
  ['token','Token contract','text',['market','liquidity']],
  ['autoCompoundFees','Automatically reinvest earned LP fees','checkbox',['liquidity']],
  ['preset','Strategy',[['conservative','Conservative'],['balanced','Balanced'],['active','Active'],['advanced','Advanced']],['market','liquidity']],
  ['amountMode','Buy sizing',[['fixed','Same amount'],['random','Random amount'],['custom','Amount per wallet']],['copy','sniper']],
  ['buyAmount','Buy amount / wallet (Robinhood ETH)','decimal',['copy','sniper']], ['randomMin','Random minimum (ETH)','decimal',['copy','sniper']], ['randomMax','Random maximum (ETH)','decimal',['copy','sniper']],
  ['budget','ETH budget / wallet','decimal',['copy','sniper']],
  ['budgetEth','ETH budget / wallet','decimal',['market','liquidity']],
  ['sellMode','Sell rule',[['mirror','When the target sells'],['percent','Price percentage steps'],['hybrid-percent','Target sells or price steps']],['copy','sniper']],
  ['mirrorFraction','Match the fraction sold','checkbox',['copy','sniper']], ['percentStep','Price increase per step (%)','number',['copy','sniper']], ['sellPercent','Sell each step (%)','number',['copy','sniper']],
];
const advancedFields = [['quote','Pool quote override (optional)','text',['market','liquidity']], ['targetPercent','Target token inventory (%)','number',['market']], ['driftPercent','Rebalance band (%)','number',['market']], ['intervalMs','Strategy / ladder interval (ms)','number',['copy','sniper','market','liquidity']], ['rangeBps','LP range width (basis points)','number',['liquidity']], ['maxPositions','LP positions per wallet (20 total maximum)','number',['liquidity']]];
function renderFields(list, container) {
  const box = $(container); box.replaceChildren();
  for (const [key, label, type, kinds] of list) {
    if (!kinds.includes(kind)) continue;
    const node = document.createElement('label'); node.append(text('span', label));
    let input;
    if (Array.isArray(type)) { input = document.createElement('select'); for (const [value, title] of type) { const opt = text('option', title); opt.value = value; input.append(opt); } }
    else if (type === 'textarea') { input = document.createElement('textarea'); input.rows = 3; input.spellcheck = false; }
    else { input = document.createElement('input'); input.type = type === 'decimal' ? 'text' : type; if (type === 'decimal') input.inputMode = 'decimal'; if (type === 'number') input.step = 'any'; }
    input.dataset.field = key;
    if (key === 'quote') input.placeholder = 'Automatic';
    if (key === 'budgetEth') { input.required = true; input.placeholder = 'Enter an ETH amount'; }
    if (key === 'amountMode') input.onchange = () => { settings.tools[kind].amountMode = input.value; renderWallets(); };
    const value = settings.tools[kind][key]; if (type === 'checkbox') { input.checked = !!value; node.className = 'check'; } else input.value = Array.isArray(value) ? value.join('\n') : value ?? '';
    node.append(input);
    if (key === 'budgetEth' && !value) node.append(text('small', 'Set your ETH budget. The previous quote-token amount has not been carried over.', 'help'));
    box.append(node);
  }
}
function collect() {
  if (!settings) return;
  for (const input of document.querySelectorAll('[data-field]')) {
    const key = input.dataset.field, value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
    settings.tools[kind][key] = ['leads','developers'].includes(key) ? value.split(/[\s,]+/).filter(Boolean) : value;
  }
  for (const [id, key] of [['rh-pool','pool'],['rh-fee-pool','feePool']]) { const raw = $(id).value.trim(); try { settings.tools[kind][key] = raw ? JSON.parse(raw) : null; } catch { throw Error('The advanced pool key must be valid JSON.'); } }
  Object.assign(settings, { rpcUrl: $('rh-rpc').value, maxGasGwei: $('rh-gas').value, priorityGwei: $('rh-priority').value, reserveEth: $('rh-reserve').value, slippageBps: Math.round(Number($('rh-slippage').value) * 100), rpcRequestsPerSecond: Number($('rh-rps').value), pollMs: Number($('rh-poll').value), maxSignalAgeMs: Number($('rh-signal-age').value) });
  return structuredClone(settings);
}
const group = () => settings.wallets.filter(w => w.tool === walletTool(kind));
function renderWallets() {
  const wallets = group(), selected = new Set(settings.runWallets[kind]);
  $('rh-wallets').replaceChildren(); $('rh-manual-wallets').replaceChildren();
  $('rh-cap').textContent = `${wallets.length} / ${WALLET_LIMITS[kind]}${['copy','sniper'].includes(kind) ? ' shared' : ''}`;
  $('rh-generate-count').max = String(Math.max(1, WALLET_LIMITS[kind] - wallets.length));
  for (const wallet of wallets) {
    const row = document.createElement('div'); row.className = 'rh-wallet-row';
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selected.has(wallet.publicKey); check.setAttribute('aria-label', `Select ${wallet.label}`);
    check.onchange = () => { const set = new Set(settings.runWallets[kind]); check.checked ? set.add(wallet.publicKey) : set.delete(wallet.publicKey); settings.runWallets[kind] = [...set]; updateSelection(); };
    const info = document.createElement('div'); info.append(text('strong', wallet.label), text('div', wallet.publicKey, 'rh-address'));
    const amount = document.createElement('input'); amount.className = 'rh-amount'; amount.hidden = !['copy','sniper'].includes(kind) || settings.tools[kind].amountMode !== 'custom'; amount.inputMode = 'decimal'; amount.value = wallet.amount || ''; amount.placeholder = 'Buy amount (ETH)'; amount.setAttribute('aria-label', `Custom amount for ${wallet.label}`); amount.oninput = () => { wallet.amount = amount.value; }; info.append(amount);
    const remove = text('button', '×', 'text-button'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${wallet.label}`); remove.onclick = () => { settings.wallets = settings.wallets.filter(w => w.publicKey !== wallet.publicKey); for (const k of Object.keys(TOOL_NAMES)) settings.runWallets[k] = settings.runWallets[k].filter(a => a !== wallet.publicKey); manualKeys.delete(wallet.publicKey); renderWallets(); };
    row.append(check, info, remove); $('rh-wallets').append(row);
    const manual = document.createElement('label'); manual.className = 'manual-wallet'; const chosen = document.createElement('input'); chosen.type = 'checkbox'; chosen.checked = manualKeys.has(wallet.publicKey); chosen.onchange = () => { chosen.checked ? manualKeys.add(wallet.publicKey) : manualKeys.delete(wallet.publicKey); updateSelection(); }; const label = document.createElement('span'); label.append(text('strong', wallet.label), text('small', `${wallet.publicKey.slice(0, 6)}…${wallet.publicKey.slice(-4)}`)); label.title = wallet.publicKey; manual.append(chosen, label); $('rh-manual-wallets').append(manual);
  }
  updateSelection();
}
function updateSelection() { const n = settings.runWallets[kind].length, total = group().length; $('rh-selected').textContent = `${n} selected · ${TOOL_NAMES[kind]}`; $('rh-select-all').checked = !!total && n === total; $('rh-select-all').indeterminate = n > 0 && n < total; manualControls(); }
function render() {
  $('rh-title').textContent = ({ copy: 'Copy trading', sniper: 'Launch sniper', liquidity: 'Liquidity', market: 'Market making' })[kind];
  $('rh-title').parentElement.querySelector('.subtitle').textContent = ({ copy: 'Follow target wallets with buys and sells in ETH.', sniper: 'Watch new launches and set your buy amount in ETH.', liquidity: 'Choose a token and an ETH budget. Pool assets are handled for you.', market: 'Set an ETH budget and let your inventory rebalance automatically.' })[kind];
  $('rh-title').parentElement.querySelector('.help').hidden = true;
  $('rh-wallet-title').textContent = 'Your wallets';
  for (const button of $('rh-tools').children) button.setAttribute('aria-selected', String(button.dataset.kind === kind));
  $('rh-funding-help').textContent = kind === 'liquidity' ? 'Fund these wallets with Robinhood ETH. Launchpad finds the pool and buys its assets within your ETH budget. Withdrawals automatically return available proceeds to ETH. Keep extra ETH for gas.' : 'Fund these wallets with Robinhood ETH. Buys handle conversions automatically; sells return ETH. Your budget includes Launchpad trade fees. Keep extra ETH for gas.';
  renderFields(fields, 'rh-tool-fields'); renderFields(advancedFields, 'rh-advanced-fields'); renderWallets();
  $('rh-pool').value = settings.tools[kind].pool ? JSON.stringify(settings.tools[kind].pool, null, 2) : ''; $('rh-fee-pool').value = settings.tools[kind].feePool ? JSON.stringify(settings.tools[kind].feePool, null, 2) : '';
  for (const [id, key] of [['rh-rpc','rpcUrl'],['rh-gas','maxGasGwei'],['rh-priority','priorityGwei'],['rh-reserve','reserveEth'],['rh-rps','rpcRequestsPerSecond'],['rh-poll','pollMs'],['rh-signal-age','maxSignalAgeMs']]) $(id).value = settings[key];
  $('rh-slippage').value = settings.slippageBps / 100; $('rh-manual-card').hidden = !['copy','sniper','market'].includes(kind);
  if (kind === 'market') manualDirection = 'sell';
  $('rh-manual-fee').textContent = `Launchpad fee: ${kind === 'sniper' ? '1%' : kind === 'market' ? '0.10%' : '0.25%'} per buy or sell. Submitting accepts this fee. Collected in ETH; network and pool costs are separate.`;
  $('rh-manual-help').textContent = kind === 'market' ? 'Stop Market Making before selling its managed inventory.' : 'Uses your configured fees and limits. Available with copytrading running or stopped.';
  renderFees(); renderStatus(active[kind] || { state: latest?.runs?.[kind]?.state || 'stopped', positions: [], pending: [], events: [] });
}
function renderFees() { $('rh-fees').textContent = fees.description; $('rh-lp-fees').textContent = fees.liquidityDescription; }
function renderStatus(status) {
  latest = status; active[kind] = status;
  const timing = status.metrics?.lastExecution || {};
  $('rh-send-ms').textContent = status.metrics?.detectionToSendMs == null ? '—' : `${status.metrics.detectionToSendMs} ms`;
  $('rh-receipt-ms').textContent = status.metrics?.confirmationMs == null ? '—' : `${status.metrics.confirmationMs} ms`;
  $('rh-rpc-state').textContent = status.rpc ? `RPC ${status.rpc.effectiveRequestsPerSecond} / ${status.rpc.configuredRequestsPerSecond} requests/sec · ${status.rpc.rateLimits} rate limits · ${status.rpc.queued || 0} waiting` : 'No active RPC session.';
  renderIfChanged($('rh-timing'),timing,()=>{$('rh-timing').replaceChildren();
  for (const [label, key] of [['Side','side'],['Decode','decodeMs'],['Wallet queue','queueMs'],['Route','routeMs'],['Approvals','approvalMs'],['Pre-sign checks','checksMs'],['Simulation','simulationMs'],['Journal','journalMs'],['RPC acknowledgment','rpcAckMs']]) if (timing[key] != null) $('rh-timing').append(text('dt',label),text('dd',`${timing[key]}${key.endsWith('Ms') ? ' ms' : ''}`));
  });
  const state = status.state || 'stopped'; $('rh-state').textContent = status.stopReason ? `${state === 'stopping' ? 'Stopping' : 'Stopped'} after an error · review Activity` : state[0].toUpperCase() + state.slice(1); $('rh-light').classList.toggle('running', state === 'running');
  $('rh-start').disabled = state !== 'stopped' || saving || !fees.ready; $('rh-stop').disabled = state === 'stopped'; $('rh-stop').textContent = state === 'stopped' ? 'Stopped' : state === 'stopping' ? 'Stopping…' : 'Stop';
  $('rh-all-status').textContent = Object.entries(TOOL_NAMES).map(([k, title]) => `${title}: ${status.runs?.[k]?.state || active[k]?.state || 'stopped'}`).join(' · ');
  const lots = status.positions || []; $('rh-position-count').textContent = lots.length;
  const pnl = new Map();
  for (const lot of lots) if (lot.quotePnl != null && Date.now() - lot.priceAt < 60000) { const prior = pnl.get(lot.costCurrency || lot.quote) || { total: 0, symbol: lot.quoteSymbol || 'quote' }; prior.total += Number(lot.quotePnl) / 10 ** lot.quoteDecimals; pnl.set(lot.costCurrency || lot.quote, prior); }
  $('rh-position-summary').textContent = `${lots.length} open · ${(status.pending || []).length} pending. ${[...pnl.values()].map(p => `Estimated P&L ${p.total.toLocaleString(undefined, { maximumSignificantDigits: 7 })} ${p.symbol}`).join(' · ') || 'Quotes update while running.'} ETH positions include estimated exit fees. Gas is excluded.`;
  renderIfChanged($('rh-positions'),[kind,lots,status.inventory,status.pending,state],()=>{$('rh-positions').replaceChildren();
  for (const lot of lots) {
    const row = document.createElement('div'); row.className = 'rh-position'; row.append(text('strong', `${lot.symbol || 'LP position'} · ${lot.wallet.slice(0, 8)}…`));
    if (lot.liquidity) {
      row.append(text('p', `Position #${lot.tokenId} · range ${lot.lower} to ${lot.upper}`));
      const withdraw = text('button', 'Withdraw LP', 'small-button'); withdraw.type = 'button'; withdraw.onclick = () => act(async () => { collect(); settings.agreedFeeVersion = fees.version; await api('withdraw', { settings, allocation: { id: lot.id, wallet: lot.wallet }, kind: 'liquidity' }); await poll(true); }); row.append(withdraw);
      if (lot.pool?.protocol === 'v2') row.append(text('p', 'Trading fees already accrue in this pool’s LP reserves.', 'help'));
      else { const claim = text('button', 'Claim fees', 'small-button'); claim.type = 'button'; claim.onclick = () => act(async () => { collect(); settings.agreedFeeVersion = fees.version; await api('claim-fees', { settings, allocation: { id: lot.id, wallet: lot.wallet }, kind: 'liquidity' }); await poll(true); }); row.append(claim); }
    } else {
      const quantity = Number(lot.remaining) / 10 ** lot.decimals, cost = Number(lot.cost || 0) / 10 ** lot.quoteDecimals;
      row.append(text('p', `${quantity.toLocaleString(undefined, { maximumSignificantDigits: 8 })} ${lot.symbol || 'tokens'} · avg entry ${quantity ? (cost / quantity).toLocaleString(undefined, { maximumSignificantDigits: 7 }) : '—'} ${lot.quoteSymbol || 'quote'}`));
      row.append(text('p', lot.token));
      const sell = text('button', 'Set up sale', 'small-button'); sell.type = 'button'; sell.onclick = () => { if (manualSubmitting || manualUncertain) return; manualDirection = 'sell'; $('rh-manual-token').value = lot.token; manualKeys.clear(); manualKeys.add(lot.wallet); renderWallets(); $('rh-manual-card').scrollIntoView({ behavior: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }; if (['copy','sniper','market'].includes(kind)) row.append(sell);
    }
    $('rh-positions').append(row);
  }
  for (const wallet of Object.keys(status.inventory || {})) {
    const row = document.createElement('div'); row.className = 'rh-position';
    row.append(text('p', `Managed budget · ${wallet.slice(0, 8)}…`));
    const budget = status.inventory[wallet];
    if (budget.budgetCurrency === EVM_NATIVE) row.append(text('p', `${(Number(budget.ethAvailable || 0) / 1e18).toLocaleString(undefined, { maximumSignificantDigits: 7 })} ETH available · ${(Number(budget.budgetEth) / 1e18).toLocaleString(undefined, { maximumSignificantDigits: 7 })} ETH initial budget`, 'help'));
    if (kind === 'liquidity' && (BigInt(budget.tokenAvailable || 0) || BigInt(budget.quoteAvailable || 0))) {
      const convert = text('button', 'Return idle funds to ETH', 'small-button'); convert.type = 'button'; convert.disabled = state !== 'stopped' || status.pending?.some(p => p.wallet === wallet);
      convert.onclick = () => act(async () => { collect(); settings.agreedFeeVersion = fees.version; await api('inventory/convert', { wallet, kind, settings }); await poll(true); }); row.append(convert);
    }
    const release = text('button', 'Release idle budget', 'small-button'); release.type = 'button';
    release.disabled = state !== 'stopped' || lots.some(l => l.wallet === wallet) || status.pending?.some(p => p.wallet === wallet);
    release.onclick = () => act(async () => { await api('inventory/release', { wallet, kind }); await poll(true); });
    row.append(release, text('p', 'Releases tracking after positions are closed; assets stay in the wallet.', 'help')); $('rh-positions').append(row);
  }
  });
  renderIfChanged($('rh-events'),(status.events||[]).slice(0,60),()=>{$('rh-events').replaceChildren();
  for (const event of (status.events || []).slice(0, 60)) { const row = document.createElement('div'); row.className = 'rh-event'; row.dataset.level = event.level; row.append(text('time', `${new Date(event.at).toLocaleTimeString()} · ${event.level.toUpperCase()}`), text('p', event.message)); if (/^0x[0-9a-f]{64}$/i.test(event.signature || '')) { const link = text('a', `${event.signature.slice(0, 12)}… ↗`); link.href = `https://robinhoodchain.blockscout.com/tx/${event.signature}`; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link); } $('rh-events').append(row); }
  });
  const held = [...new Map(lots.filter(l => l.token && !l.liquidity).map(l => [l.token, l])).values()];
  renderIfChanged($('rh-manual-held-token'), held.map(l => [l.token,l.symbol]), () => { const select = $('rh-manual-held-token'), previous = select.value; select.replaceChildren(); const placeholder = text('option', 'Choose a held token'); placeholder.value = ''; select.append(placeholder); for (const lot of held) { const option = text('option', `${lot.symbol || 'Token'} · ${lot.token.slice(0, 8)}…`); option.value = lot.token; select.append(option); } select.value = previous; });
  $('rh-manual-held-token-label').hidden = manualDirection !== 'sell' || !held.length;
  const manualResult = status.manualResult;
  if (manualRequest && manualResult?.id === manualRequest.trade.id && manualResult.complete) { manualUncertain = false; manualRequest = null; $('rh-manual-message').textContent = 'Request checked. Review each wallet result below.'; }
  $('rh-manual-results').hidden = !manualResult?.results?.length;
  renderIfChanged($('rh-manual-results'),manualResult?.results||[],()=>{$('rh-manual-results').replaceChildren();
  for (const result of manualResult?.results || []) { const row = text('div', '', 'manual-outcome'); row.append(text('strong', result.label || `${result.wallet.slice(0, 8)}…`), text('span', result.state)); if (result.error) row.append(text('p', result.error, 'help')); if (/^0x[0-9a-f]{64}$/i.test(result.signature || '')) { const link = text('a', 'View transaction ↗'); link.href = `https://robinhoodchain.blockscout.com/tx/${result.signature}`; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link); } $('rh-manual-results').append(row); }
  });
  manualControls(); executionUI?.render();
}
async function act(task) { alert(); try { return await task(); } catch (error) { alert(error.message); } }
async function persist() {
  if (saving) throw Error('Wait for settings to finish saving.'); saving = true;
  try { const next = await api('settings', { settings: collect(), revision }); settings = next.settings; revision = next.revision; render(); return next; }
  finally { saving = false; $('rh-start').disabled = latest?.state !== 'stopped' || !fees.ready; }
}
async function poll(force = false) {
  if (polling || !settings || document.hidden && !force) return; polling = true; const selected = kind;
  try { const status = await api(`status?kind=${selected}`); active[selected] = status; if (kind === selected) renderStatus(status); }
  catch (error) { alert(error.message); } finally { polling = false; }
}
function download(name, data) { const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function authorize(title) {
  if (authResolve) return Promise.reject(Error('Finish the current account verification.'));
  $('rh-auth-title').textContent = title; $('rh-password').value = ''; $('rh-code').value = ''; $('rh-auth-dialog').showModal();
  return new Promise((resolve, reject) => { authResolve = { resolve, reject }; });
}
$('rh-verify-form').onsubmit = event => { event.preventDefault(); const pending = authResolve; authResolve = null; const credentials = { password: $('rh-password').value, code: $('rh-code').value }; $('rh-password').value = ''; $('rh-code').value = ''; $('rh-auth-dialog').close(); pending?.resolve(credentials); };
function cancelAuth() { const pending = authResolve; authResolve = null; $('rh-password').value = ''; $('rh-code').value = ''; $('rh-auth-dialog').close(); pending?.reject(Error('Verification cancelled.')); }
$('rh-auth-cancel').onclick = cancelAuth; $('rh-auth-dialog').addEventListener('cancel', cancelAuth);
$('rh-select-all').onchange = () => { settings.runWallets[kind] = $('rh-select-all').checked ? group().map(w => w.publicKey) : []; renderWallets(); };
$('rh-manual-all').onchange = () => { manualKeys.clear(); if ($('rh-manual-all').checked) group().forEach(w => manualKeys.add(w.publicKey)); renderWallets(); };
$('rh-save').onclick = () => act(persist);
$('rh-generate').onclick = () => act(async () => { if (saving) throw Error('Wait for settings to save.'); saving = true; try { const result = await api('wallets/generate', { settings: collect(), revision, kind, count: Number($('rh-generate-count').value) }); settings = result.settings; revision = result.revision; render(); } finally { saving = false; } });
$('rh-import').onclick = () => act(async () => {
  collect(); const keys = $('rh-import-keys').value.split(/[\s,]+/).filter(Boolean); if (!keys.length) throw Error('Paste one or more EVM private keys.');
  if (group().length + keys.length > WALLET_LIMITS[kind]) throw Error(`Maximum ${WALLET_LIMITS[kind]} wallets for this group.`);
  const candidate = structuredClone(settings); keys.forEach((privateKey, i) => candidate.wallets.push({ privateKey, publicKey: '', tool: walletTool(kind), label: `Imported ${group().length + i + 1}`, amount: '' }));
  const checked = await api('wallets/check', { settings: candidate }); candidate.wallets.forEach((w, i) => { w.publicKey = checked.wallets[i].publicKey; });
  candidate.runWallets[kind].push(...candidate.wallets.slice(-keys.length).map(w => w.publicKey));
  const saved = await api('settings', { settings: candidate, revision }); settings = saved.settings; revision = saved.revision; $('rh-import-keys').value = ''; render();
});
$('rh-setup').onsubmit = event => { event.preventDefault(); const selected = kind; act(async () => { const saved = await persist(), requested = structuredClone(saved.settings); requested.agreedFeeVersion = fees.version; if (kind === selected) renderStatus({ ...active[selected], state: 'starting' }); try { const status = await api('start', { settings: requested, kind: selected }); active[selected] = status; if (kind === selected) renderStatus(status); } finally { await poll(true); } }); };
$('rh-stop').onclick = () => act(async () => { const selected = kind; renderStatus({ ...latest, state: 'stopping' }); const status = await api('stop', { kind: selected }); active[selected] = status; if (kind === selected) renderStatus(status); });
function manualControls() {
  if (!settings) return;
  const wallets = group(), count = wallets.filter(w => manualKeys.has(w.publicKey)).length, busy = manualSubmitting || manualUncertain, sell = manualDirection === 'sell';
  $('rh-manual-fields').disabled = busy; $('rh-manual-wallet-count').textContent = `${count} selected`;
  $('rh-manual-all').checked = !!wallets.length && count === wallets.length; $('rh-manual-all').indeterminate = count > 0 && count < wallets.length;
  for (const button of document.querySelectorAll('[data-manual-side]')) { button.setAttribute('aria-pressed', String(button.dataset.manualSide === manualDirection)); button.disabled = busy || kind === 'market' && button.dataset.manualSide === 'buy'; }
  for (const button of document.querySelectorAll('[data-sell-percent]')) button.setAttribute('aria-pressed', String(Number(button.dataset.sellPercent) === Number($('rh-manual-sell-percent').value)));
  $('rh-manual-buy-fields').hidden = sell; $('rh-manual-sell-fields').hidden = !sell;
  $('rh-manual-held-token-label').hidden = !sell || $('rh-manual-held-token').children.length < 2;
  const amount = Number($('rh-manual-size').value), percent = Number($('rh-manual-sell-percent').value);
  $('rh-manual-preview').textContent = !count ? 'Select wallets to preview your trade.' : sell ? `Sell ${percent || 0}% of ${kind === 'market' ? 'managed inventory' : 'holdings'} in each of ${count} selected wallets.` : `${amount || 0} ETH per wallet · up to ${(amount * count || 0).toLocaleString(undefined, { maximumSignificantDigits: 10 })} ETH total, plus network fees.`;
  const submit = $('rh-manual-submit'); submit.textContent = manualSubmitting ? 'Checking execution…' : manualUncertain ? 'Check this request' : `${sell ? 'Sell' : 'Buy'} with ${count || 'selected'} wallet${count === 1 ? '' : 's'}`;
  submit.classList.toggle('sell', sell); submit.disabled = manualSubmitting || saving || !fees?.ready || !manualUncertain && (!count || kind === 'market' && latest?.state !== 'stopped');
}
for (const button of document.querySelectorAll('[data-manual-side]')) button.onclick = () => { if (manualSubmitting || manualUncertain || kind === 'market' && button.dataset.manualSide === 'buy') return; manualDirection = button.dataset.manualSide; manualControls(); };
for (const button of document.querySelectorAll('[data-sell-percent]')) button.onclick = () => { $('rh-manual-sell-percent').value = button.dataset.sellPercent; manualControls(); };
for (const id of ['rh-manual-size','rh-manual-sell-percent','rh-manual-token']) $(id).oninput = manualControls;
$('rh-manual-held-token').onchange = () => { if ($('rh-manual-held-token').value) $('rh-manual-token').value = $('rh-manual-held-token').value; manualControls(); };
$('rh-manual').onsubmit = async event => {
  event.preventDefault(); if (manualSubmitting) return; alert(); const wasUncertain = manualUncertain;
  try {
    if (!manualRequest) {
      const wallets = group().filter(w => manualKeys.has(w.publicKey)).map(w => w.publicKey), token = $('rh-manual-token').value.trim(), amount = $('rh-manual-size').value.trim(), percent = Number($('rh-manual-sell-percent').value);
      if (!wallets.length) throw Error('Select at least one manual-trade wallet.');
      if (!/^0x[0-9a-f]{40}$/i.test(token)) throw Error('Enter a valid token contract address.');
      if (manualDirection === 'buy' && (!/^(?:\d+\.?\d{0,18}|\.\d{1,18})$/.test(amount) || Number(amount) <= 0)) throw Error('Enter a positive ETH amount with at most 18 decimal places.');
      if (manualDirection === 'sell' && (!Number.isFinite(percent) || percent <= 0 || percent > 100)) throw Error('Sell percentage must be above 0 and at most 100.');
      const requested = collect(); requested.agreedFeeVersion = fees.version;
      manualRequest = { settings: requested, kind, trade: { id: crypto.randomUUID(), side: manualDirection, token, quote: '', amount, percent, wallets } };
    }
    manualSubmitting = true; manualControls(); executionUI?.render();
    const selected = manualRequest.kind, status = await api('manual', manualRequest);
    manualUncertain = false; manualRequest = null;
    if (kind === selected) { renderStatus(status); $('rh-manual-message').textContent = 'Request checked. Review each wallet result below.'; }
  } catch (error) {
    if (manualRequest && (wasUncertain || !error.statusCode || error.statusCode >= 500 || [408,429].includes(error.statusCode))) {
      manualUncertain = true; $('rh-manual-message').textContent = 'The response was interrupted. Check this request to recover its result without submitting a second trade.';
    } else { manualUncertain = false; manualRequest = null; $('rh-manual-message').textContent = error.message; }
    alert(error.message);
  } finally { manualSubmitting = false; manualControls(); executionUI?.render(); await poll(true); }
};
$('rh-export').onclick = () => act(async () => { collect(); const result = await api('settings/export', { settings, ...await authorize('Export full Robinhood setup') }); download('robinhood-setup.json', result.settings); });
$('rh-load').onclick = () => $('rh-file').click(); $('rh-file').onchange = () => act(async () => { const file = $('rh-file').files[0]; if (!file || file.size > 262144) throw Error('Choose a setup JSON smaller than 256 KB.'); const raw = JSON.parse(await file.text()); if (raw.chain !== 'robinhood' || raw.chainId !== 4663) throw Error('Choose a Robinhood setup file.'); const result = await api('settings', { settings: raw, revision }); settings = result.settings; revision = result.revision; render(); $('rh-file').value = ''; });
$('rh-log-export').onclick = () => download('robinhood-log.json', latest);
function renderAccount(data) { account = data.account; renderHeaderAccount($('rh-account'), account); fees = data.fees; renderFees(); $('rh-username').textContent = account.username; $('rh-main-wallet').textContent = account.mainWallet; $('rh-cashback').textContent = `Cashback: ${account.cashbackBps / 100}% of verified Launchpad fees. ${(data.cashback || []).map(r => `${Number(r.pendingAmount) / 1e18} ETH verified, unpaid`).join(' · ')}`; $('rh-admin').hidden = account.role !== 'admin'; }
async function refreshAccount() { renderAccount(await api('account')); }
$('rh-account').onclick = () => act(async () => { await refreshAccount(); connections?.showOverview(); if (!$('rh-account-dialog').open) $('rh-account-dialog').showModal(); });
$('rh-account-close').onclick = () => $('rh-account-dialog').close();
function initializeConnections() { connections = createAccountConnections({ dialog: $('rh-account-dialog'), getAccount:()=>account, chain: 'robinhood', api: (path, body) => api(path.slice('/api/'.length), body, true), onOverview: () => act(refreshAccount), onSaved: value => {
  if (value.chain !== 'robinhood') return true;
  Object.assign(settings, value.values);
  for (const [id, key] of [['rh-rpc','rpcUrl'],['rh-rps','rpcRequestsPerSecond'],['rh-poll','pollMs']]) $(id).value = settings[key];
  if (revision !== value.previousRevision) return false;
  revision = value.revision; return true;
} }); }
$('rh-main-copy').onclick = () => act(() => navigator.clipboard.writeText(account.mainWallet));
$('rh-main-export').onclick = () => act(async () => { const key = await api('account/export', await authorize('Export Robinhood cashback wallet')); download('robinhood-main-wallet.json', key); });
$('rh-logout').onclick = () => act(async () => { await api('account/logout', {}, true); settings = null; location.assign('/'); });
for (const [key, title] of [['copy','Copy trading'],['sniper','Launch sniper'],['liquidity','Liquidity'],['market','Market making']]) { const button = text('button', title, 'small-button'); button.type = 'button'; button.dataset.kind = key; button.setAttribute('role', 'tab'); button.onclick = () => act(async () => { if (manualSubmitting || manualUncertain) throw Error('Check the current manual request before switching tools.'); collect(); kind = key; manualKeys.clear(); settings.runWallets[kind].forEach(a => manualKeys.add(a)); render(); await poll(true); }); $('rh-tools').append(button); }
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(true); else { $('rh-import-keys').value = ''; if (authResolve) cancelAuth(); } });
try {
  const response = await fetch('/api/session'), session = await response.json(); if (!session.authenticated) { location.replace('/?chain=robinhood&tool='+encodeURIComponent(new URLSearchParams(location.search).get('tool')||'terminal')); } else {
    csrf = session.token; if (session.accounts) initializeConnections(); const [saved, data] = await Promise.all([api('settings'), api('account')]); settings = saved.settings; revision = saved.revision; renderAccount(data);
    settings.runWallets.copy.forEach(a => manualKeys.add(a)); $('session-loading').hidden = true; $('rh-main').hidden = false; document.body.dataset.session = 'account'; $('rh-account').hidden = false; renderHeaderAccount($('rh-account'), account); render();
    executionUI = createExecutionPresetsUI({ chain: 'robinhood', mount: $('rh-execution-presets'), read: collect, locked: () => saving || manualSubmitting || manualUncertain || latest?.state !== 'stopped' || Object.values(latest?.runs || active).some(r => r.state !== 'stopped'), write: async next => { if (saving) throw Error('Wait for settings to finish saving.'); saving = true; try { const result = await api('settings', { settings: next, revision }); settings = result.settings; revision = result.revision; render(); } finally { saving = false; } } });
    if (!fees.ready) alert('Robinhood trading is awaiting the host’s execution-contract and fee-wallet setup.'); await poll(true); createTerminalUI({ chain: 'robinhood', session, api: path => api(path.slice('/api/'.length), undefined, true), openConnections: () => connections?.open() }); setInterval(poll, 2000);
  }
} catch (error) { $('session-loading').textContent = error.message; }
