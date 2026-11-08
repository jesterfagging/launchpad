import { createTerminalUI } from './terminal-ui.js';
import { chainToolHref } from './chains.mjs';
import { createExecutionPresetsUI } from './execution-presets-ui.js';
import { cleanSniper, sniperFields } from './sniper-settings.mjs';
import { WALLET_LIMITS, walletTool, toolWallets } from './wallet-limits.mjs';
import { createRunUI } from './run-ui.js';
import { createPortfolioUI } from './portfolio-ui.js';
import { createAccountUI } from './account-ui.js';
import { createTradingUI } from './trading-ui.js';
import { settingIds, createPreset, readPreset, maxPresetBytes } from './presets.mjs';
const $ = id => document.getElementById(id);
let token = '', latest = null, walletId = 0, lastEvents = '', polling = false, lastPollAt = 0, authTransition = 0;
let walletGenerationPending = false, startPending = false, stopPending = false, connected = false, actionVersion = 0;
let updatesConnected = false, portfolioUI = null, runUI = null, accountUI = null, tradingUI = null, sessionExpired = false, launchGeneration = { copy: 0, liquidity: 0, market: 0, sniper: 0 };
const phone = window.LaunchpadAndroid;
let defaultWallets = {}, sniperState = cleanSniper(), copyState = null, workingForm = 'copy';
let executionPresets, executionUI;
const statuses = {};
const kindNow = () => portfolioUI?.active || 'copy';
const groupWallets = () => walletValues().filter(w => w.tool === walletTool(kindNow()));
const readCopyForm = () => Object.fromEntries(['leads', ...sniperFields].map(id => [id, $(id).type === 'checkbox' ? $(id).checked : $(id).value]));
function saveWorkingForm() { const v = readCopyForm(); if (workingForm === 'sniper') sniperState = cleanSniper({ ...v, developers: v.leads }); else copyState = v; }
function switchCopyForm(kind) {
  if (!['copy', 'sniper'].includes(kind)) { saveWorkingForm(); return; }
  if (kind !== workingForm) { saveWorkingForm(); const v = kind === 'sniper' ? { ...sniperState, leads: sniperState.developers } : copyState; for (const [id, value] of Object.entries(v)) if ($(id)) { if ($(id).type === 'checkbox') $(id).checked = value; else $(id).value = value; } workingForm = kind; }
  latest = statuses[kind] || null; connected = !!latest; lastEvents = '';
  if (latest) showStatus(latest); poll();
}
let presetReady = false, saveTimer;
function fullPreset() { return createPreset({ ...configuration(), wallets: walletValues(true) }); }
function savePhoneNow() { if(phone && presetReady) { clearTimeout(saveTimer); phone.savePreset(JSON.stringify(fullPreset())); } }
function rememberSetup() {
  if (!phone || !presetReady) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { phone.savePreset(JSON.stringify(fullPreset())); } catch { alertError('Could not save settings on this phone.'); } }, 500);
}
function applyPreset(c) {
  executionPresets = c.executionPresets;
  for (const id of settingIds) { if (id === 'mode' || c[id] === undefined) continue; if ($(id).type === 'checkbox') $(id).checked = c[id]; else $(id).value = c[id]; }
  for (const id of ['jitoUrl', 'senderUrl']) if (String(c[id] || '').startsWith('relay-saved-v1:')) $(id).type = 'password';
  $('mode').value = 'live';
  defaultWallets = c.defaultWallets || {}; sniperState = cleanSniper(c.sniper); copyState = readCopyForm(); workingForm = 'copy';
  $('wallets').replaceChildren(); c.wallets.forEach(w => walletRow(w, true)); portfolioUI?.load(c.strategies, c.liquidityPlans); runUI?.load(c.runWallets); switchCopyForm(kindNow()); updateControls();
}
function alertError(message) { $('alert').textContent = message; $('alert').hidden = !message; }
function walletRow(value = {}, defer = false) {
  const tool = value.tool || walletTool(kindNow());
  if (!defer && walletValues().filter(w => w.tool === tool).length >= WALLET_LIMITS[tool]) return alertError(`Maximum ${WALLET_LIMITS[tool]} wallets for this tool.`);
  const row = document.createElement('div'); row.className = 'wallet-row'; row.dataset.id = ++walletId; row.dataset.tool = tool;
  // This template is static; user strings are assigned only through value/textContent.
  row.innerHTML = '<label>LABEL<input class="wallet-label" autocomplete="off"></label><div class="credential"><label class="key-label">PRIVATE KEY<input class="wallet-key" type="password" autocomplete="off" spellcheck="false" placeholder="Base58 or JSON array"></label><input class="wallet-public" type="hidden"><div class="wallet-address"></div></div><label class="wallet-amount-field" hidden>AMOUNT (<span class="amount-unit">SOL</span>)<input class="wallet-amount" inputmode="decimal" autocomplete="off"></label><button class="remove" type="button" aria-label="Remove wallet">×</button>';
  row.querySelector('.wallet-label').value = value.label || `Wallet ${$('wallets').children.length + 1}`;
  row.querySelector('.wallet-key').value = value.privateKey || '';
  row.querySelector('.wallet-public').value = value.publicKey || '';
  row.querySelector('.wallet-address').textContent = value.publicKey || '';
  row.querySelector('.wallet-amount').value = value.amount || '0.05';
  row.querySelector('.remove').onclick = () => { row.remove(); updateControls(); rememberSetup(); };
  $('wallets').append(row); if (!defer) { updateControls(); rememberSetup(); }
}
function walletValues(includeAllKeys = false) { return [...$('wallets').children].map(row => ({ tool: row.dataset.tool, label: row.querySelector('.wallet-label').value, privateKey: row.querySelector('.wallet-key').value, publicKey: row.querySelector('.wallet-public').value, amount: row.querySelector('.wallet-amount').value })); }
function sealSettings(before, saved) {
  const fields = ['heliusKey','jupiterKey','rpcUrl','wsUrl','jitoUrl','jitoAuth','senderUrl'];
  for (const id of fields) if ($(id).value === before[id]) { $(id).value = saved[id] || ''; $(id).type = 'password'; }
  for (const row of $('wallets').children) {
    const input = row.querySelector('.wallet-key'), index = before.wallets.findIndex(w => w.privateKey === input.value);
    if (index < 0 || !saved.wallets[index]) continue;
    input.value = saved.wallets[index].privateKey || '';
    row.querySelector('.wallet-public').value = saved.wallets[index].publicKey || '';
    row.querySelector('.wallet-address').textContent = saved.wallets[index].publicKey || '';
  }
}
function configuration() {
  saveWorkingForm();
  return { ...Object.fromEntries(settingIds.map(id => [id, id === 'mode' ? 'live' : $(id).type === 'checkbox' ? $(id).checked : $(id).value])),
    ...copyState, wallets: walletValues(), walletSchema: 1, defaultWallets, sniper: sniperState,
    strategies: portfolioUI?.presets(), liquidityPlans: portfolioUI?.plans(), runWallets: runUI?.selections(), executionPresets };
}
function updateControls() {
  $('wallet-count').textContent = `${groupWallets().length} / ${WALLET_LIMITS[kindNow()]}`;
  $('generate-count').max = String(Math.max(1, WALLET_LIMITS[kindNow()] - groupWallets().filter(w => w.privateKey.trim() || w.publicKey.trim()).length));
  $('fixed-size').hidden = $('amountMode').value !== 'fixed'; $('random-size').hidden = $('amountMode').value !== 'random';
  const custom = $('amountMode').value === 'custom';
  $('custom-size-help').hidden = !custom;
  for (const row of $('wallets').children) {
    row.classList.toggle('custom-amount', custom);
    row.querySelector('.wallet-amount-field').hidden = !custom; row.querySelector('.wallet-amount').disabled = !custom;
  }
  document.querySelectorAll('.amount-unit').forEach(el => el.textContent = $('funding').value === 'sol' ? 'SOL' : 'QUOTE');
  $('sizing-help').textContent = $('funding').value === 'sol' ? 'Amount each wallet spends when a target buys.' : 'Amounts are units of the actual quote token. 0.05 BTC and 0.05 USDC have very different values.';
  const sellMode = $('sellMode').value;
  $('ladder-settings').hidden = sellMode === 'mirror'; $('percent-field').hidden = !sellMode.includes('percent'); $('marketcap-field').hidden = !sellMode.includes('marketcap'); $('mirror-rule').hidden = sellMode !== 'mirror' && !sellMode.startsWith('hybrid');
  $('ladder-help').textContent = sellMode.includes('marketcap') ? `Sell ${$('sellPercent').value}% of the remaining position each +$${Number($('marketcapStep').value).toLocaleString()} above the entry market cap reference. Missing market cap data leaves the ladder unarmed; FDV is never substituted.` : `Sell ${$('sellPercent').value}% of what remains at +${$('percentStep').value}%, +${2 * Number($('percentStep').value)}%, +${3 * Number($('percentStep').value)}%… from the entry market price reference. Each level fires once.`;
  const fees = ['prioritySol','jitoSol','heliusSol'].reduce((n, id) => n + (Number($(id).value) || 0), 0);
  $('fee-total').textContent = `${fees.toFixed(9).replace(/0+$/, '').replace(/\.$/, '')} SOL`;
  $('fast-logs-setting').hidden = $('streamMode').value !== 'logs';
  $('stream-help').textContent = $('streamMode').value === 'logs'
    ? ($('fastPumpLogs').checked ? 'Uses ordinary RPC WebSockets. Supported Pump/SOL buys and 100% exits read processed logs directly. Proportional sells and other pairs use confirmed transactions.' : 'Uses ordinary RPC WebSockets. Confirmed logs are followed by a transaction fetch.')
    : 'LaserStream WebSocket uses transactionSubscribe with full trade data. Enter your Helius key or a compatible WebSocket URL; the provider plan must include this method.';
  $('speed-settings').textContent = `Pre-send simulation ${$('simulateBeforeSend').checked ? 'on' : 'off'} · ${$('mirrorFraction').checked ? 'proportional target sells' : '100% target exits'}`;
  portfolioUI?.controls(); tradingUI?.controls(); runUI?.render(); executionUI?.render();
}
async function api(path, body) {
  const kind = path.startsWith('/api/sniper/') ? 'sniper' : path === '/api/manual-trade' ? body?.kind || kindNow() : path.startsWith('/api/portfolio/') ? body?.kind || portfolioUI?.active : 'copy';
  if (path === '/api/runtime/stop') for (const k of Object.keys(launchGeneration)) launchGeneration[k]++;
  else if (['/api/stop', '/api/portfolio/stop', '/api/sniper/stop'].includes(path)) launchGeneration[kind]++;
  if (body !== undefined && ['/api/start', '/api/portfolio/start', '/api/sniper/start', '/api/manual-trade'].includes(path)) {
    const generation = launchGeneration[kind];
    body = path === '/api/manual-trade' ? await accountUI?.beforeManual(body) || body : await accountUI?.beforeStart(body, path === '/api/portfolio/start') || body;
    if (generation !== launchGeneration[kind]) throw Error('Start cancelled.');
  }
  const changingSecurity = ['/api/account/mfa/enable', '/api/account/mfa/disable', '/api/account/password', '/api/account/logout-all','/api/account/signin-wallet','/api/account/signin-wallet/unlink'].includes(path);
  if (changingSecurity) authTransition++;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), (path.endsWith('/start') || path === '/api/manual-trade') ? 120000 : ['/api/admin/fees', '/api/wallet-balances'].includes(path) ? 20000 : 8000);
  try {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-control-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal });
    const value = await response.json();
    if ((response.status === 401 || (response.status === 403 && value.error === 'Refresh this page to reconnect.')) && accountUI?.enabled && accountUI.authenticated && !sessionExpired && !authTransition) {
      $('wallet-generation-message').textContent = '';
      sessionExpired = true; token = ''; document.body.dataset.session = 'loading'; $('session-loading').hidden = false; $('session-loading').textContent = 'Your session expired. Opening sign in…'; $('setup').reset(); $('wallets').replaceChildren(); location.reload();
    }
    if (response.ok && value.token && ['/api/account/login','/api/account/register','/api/account/mfa/enable','/api/account/mfa/disable','/api/account/password','/api/account/logout-all','/api/account/signin-wallet','/api/account/signin-wallet/unlink'].includes(path)) token = value.token;
    if (!response.ok) { const error = new Error(value.error || 'Request failed.'); error.status = value.status; error.statusCode = response.status; error.code = value.code; error.retryAfterMs = value.retryAfterMs; throw error; } return value;
  } finally { clearTimeout(timer); if (changingSecurity) authTransition--; }
}
const short = value => value ? value.slice(0, 5) + '…' + value.slice(-5) : '—';
const dollars = n => Number(n).toLocaleString(undefined, { style:'currency', currency:'USD', maximumFractionDigits: Number(n) < 1 ? 8 : 2 });
function runControls() {
  const busy = walletGenerationPending || startPending || (latest && latest.state !== 'stopped');
  $('config-fields').disabled = !!busy; $('mode').disabled = !!busy;
  $('start').disabled = !connected || !!busy || stopPending;
  const stopped = connected && latest?.state === 'stopped' && !startPending;
  $('stop').disabled = stopPending || stopped || latest?.state === 'stopping';
  $('stop').textContent = stopPending || latest?.state === 'stopping' ? 'Stopping…' : stopped ? 'Stopped' : 'Stop';
  $('start').firstChild.nodeValue = latest?.startupError ? 'Retry start ' : kindNow() === 'sniper' ? 'Start sniping ' : 'Start copying ';
  portfolioUI?.controls(); tradingUI?.controls(); runUI?.render(); executionUI?.render();
}
function showStatus(s) {
  const kind = s.kind === 'sniper' ? 'sniper' : 'copy';
  const previous = statuses[kind]; if (s.statusStreamId === previous?.statusStreamId && s.revision < previous?.revision) return;
  statuses[kind] = s; if (kind !== (kindNow() === 'sniper' ? 'sniper' : 'copy')) return;
  if (s.statusStreamId === latest?.statusStreamId && Number.isFinite(s.revision) && Number.isFinite(latest?.revision) && s.revision < latest.revision) return;
  latest = s; connected = true; runControls();
  $('run-state').textContent = { stopped: s.stopReason ? 'Stopped after an error · review Activity' : s.startupError ? 'Start failed · stopped' : 'Ready to configure', starting: 'Connecting…', running: 'Live trading active', stopping: s.stopReason ? 'Stopping after an error…' : 'Stopping…' }[s.state];
  if (s.manualOnly && s.state === 'running') $('run-state').textContent = 'Manual trade running';
  $('status-light').className = `status-light ${s.state === 'running' ? 'running' : ''} ${s.state === 'running' && s.mode === 'live' ? 'live' : ''}`;
  $('stream-state').textContent = s.streamConnected ? 'Stream connected' : 'Stream offline'; $('mode-badge').textContent = s.mode.toUpperCase();
  if (s.streamConnected && s.stream) $('stream-state').textContent = s.stream.mode === 'logs' ? (s.stream.fastPumpLogs ? 'RPC logs · fast enabled' : 'RPC logs · confirmed') : `LaserStream WebSocket · ${s.stream.commitment}`;
  if (s.manualOnly) $('stream-state').textContent = 'Manual execution · no target stream';
  if (s.confirmationRetryAt > Date.now()) $('stream-state').textContent += ' · RPC cooldown';
  const metrics = s.metrics || {};
  for (const [id, number] of [['send-latency',metrics.detectionToSendMs],['confirm-latency',metrics.confirmationMs]]) { $(id).replaceChildren(document.createTextNode(number == null ? '—' : String(number))); const unit = document.createElement('small'); unit.textContent='ms'; $(id).append(unit); }
  $('signals').textContent = metrics.detected ?? 0; $('submitted').textContent = metrics.submitted ?? 0; $('fills').textContent = metrics.confirmed ?? 0;
  const timing = metrics.lastExecution;
  $('timing-details').hidden = !timing;
  if (timing) {
    $('timing-source').textContent = timing.source === 'pump-processed-logs' ? 'Used fast Pump logs.'
      : timing.fallbackReason ? `Confirmed fallback: ${timing.fallbackReason}.`
      : timing.source === 'pump-confirmed-logs' ? 'Decoded confirmed Pump logs.' : 'Used the full transaction.';
    $('timing-values').replaceChildren();
    for (const [label, field] of [['Read target','notificationToSignalMs'],['Confirmation wait','confirmationWaitMs'],['Transaction fetch','transactionFetchMs'],['Queue & sizing','signalToOrderMs'],['Route','routeMs'],['Balances (parallel)','balanceMs'],['Pack / compact','packMs'],['Simulation','simulationMs'],['Sign & verify','signatureMs'],['Journal','journalMs'],['Submission acknowledgment','relayAckMs']]) {
      if (['confirmationWaitMs','transactionFetchMs'].includes(field) && timing[field] == null) continue;
      const term = document.createElement('dt'), value = document.createElement('dd'); term.textContent = label;
      value.textContent = timing[field] === null || timing[field] === undefined ? '—' : `${timing[field]} ms`;
      $('timing-values').append(term, value);
    }
  }
  tradingUI?.render(s);
  const eventsKey = s.events[0]?.id || '';
  if (eventsKey !== lastEvents) {
    lastEvents = eventsKey; $('events').replaceChildren();
    for (const e of s.events.slice(0,100)) {
      const item=document.createElement('div'); item.className=`event ${['warn','error'].includes(e.level)?e.level:''}`;
      const time=document.createElement('time'); time.textContent=new Date(e.at).toLocaleTimeString([], {hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
      const content=document.createElement('div'), level=document.createElement('span'); level.className='level'; level.textContent=e.level;
      const text=document.createElement('p');text.textContent=e.message; content.append(level,text);
      if (e.signature && /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(e.signature)) {const link=document.createElement('a');link.href=`https://solscan.io/tx/${encodeURIComponent(e.signature)}`;link.target='_blank';link.rel='noopener noreferrer';link.textContent=`${short(e.signature)} ↗`;content.append(link);} item.append(time,content);$('events').append(item);
    }
  }
  portfolioUI?.render(); runUI?.render();
}
function addGeneratedWallets(wallets) {
  for (const row of [...$('wallets').children]) if (!row.querySelector('.wallet-key').value.trim() && !row.querySelector('.wallet-public').value.trim()) row.remove();
  for (const wallet of wallets) walletRow(wallet, true);
  updateControls(); rememberSetup();
}
$('generate-toggle').onclick = () => { $('generate-panel').hidden = !$('generate-panel').hidden; };
$('generate-wallets').onclick = async () => {
  const button = $('generate-wallets'); if (button.disabled) return;
  const count = Number($('generate-count').value), used = groupWallets().filter(w => w.privateKey.trim() || w.publicKey.trim()).length;
  if (used >= WALLET_LIMITS[kindNow()]) return alertError(`Maximum ${WALLET_LIMITS[kindNow()]} total. Remove an unused wallet before generating more.`);
  if (!Number.isInteger(count) || count < 1 || count + used > WALLET_LIMITS[kindNow()]) return alertError(`Choose 1–${WALLET_LIMITS[kindNow()] - used} new wallets. Maximum ${WALLET_LIMITS[kindNow()]} total.`);
  walletGenerationPending = true; button.disabled = true; $('generate-count').disabled = true; alertError(''); runControls();
  try {
    const generated = await accountUI.generateWallets(count, kindNow());
    $('wallet-generation-message').textContent = `${generated.length} new wallets generated and saved. Use Save addresses to fund them, and Save full setup to back up their keys.`;
    $('generate-panel').hidden = true;
  } catch (error) { alertError(`${error.message} Reload your saved settings before retrying if the connection was interrupted.`); }
  finally { walletGenerationPending = false; button.disabled = false; $('generate-count').disabled = false; runControls(); }
};
$('wallet-addresses-export').onclick = () => {
  const wallets = walletValues().filter(w => w.privateKey.trim() || w.publicKey.trim());
  if (!wallets.length || wallets.some(w => !w.publicKey)) return alertError('Use Check addresses first, then save the addresses.');
  download('wallet-addresses.json', { wallets: wallets.map(({ label, publicKey }) => ({ label, publicKey })) });
};
$('add-wallet').onclick=()=>{walletRow();$('wallet-menu').open=true;$('wallet-editor').open=true;};
$('fast-setup').onclick=()=>{ $('fastPumpLogs').checked=true; $('commitment').value='processed'; $('simulateBeforeSend').checked=false; updateControls(); };
$('bulk-toggle').onclick=()=>{$('bulk-panel').hidden=!$('bulk-panel').hidden;};
$('bulk-add').onclick=()=>{const lines=$('bulk-keys').value.split('\n').map(x=>x.trim()).filter(Boolean);if(groupWallets().length+lines.length>WALLET_LIMITS[kindNow()])return alertError(`Remove empty rows first; maximum ${WALLET_LIMITS[kindNow()]} wallets total.`);for(const line of lines){const[key,amount,label]=line.split('|').map(x=>x.trim());walletRow({privateKey:key,amount,label});}$('bulk-keys').value='';$('bulk-panel').hidden=true;};
$('check-wallets').onclick=async()=>{try{alertError('');const result=await api('/api/wallets',{wallets:walletValues(),mode:$('mode').value});[...$('wallets').children].forEach((row,i)=>{row.querySelector('.wallet-address').textContent=result.wallets[i].publicKey;row.querySelector('.wallet-public').value=result.wallets[i].publicKey;});runUI?.render();}catch(e){alertError(e.message);}};
$('setup').onsubmit=async event=>{
  event.preventDefault(); if(!['copy', 'sniper'].includes(kindNow())) return; if(walletGenerationPending || startPending || stopPending)return;
  startPending=true; actionVersion++; alertError(''); runControls();
  try {
    savePhoneNow(); const s=await api(kindNow() === 'sniper' ? '/api/sniper/start' : '/api/start',configuration());
    // Mode wallet subsets do not share indices with the imported wallet list.
    $('bulk-keys').value=''; showStatus(s);
  } catch(e) { alertError(e.message); if(e.status)showStatus(e.status); else connected=false; }
  finally { startPending=false; runControls(); await poll(); }
};
$('stop').onclick=async()=>{
  if(stopPending)return; stopPending=true; actionVersion++; runControls();
  try { showStatus(await api(kindNow() === 'sniper' ? '/api/sniper/stop' : '/api/stop',{})); alertError(''); }
  catch(e) { connected=false; alertError(phone?'Cannot reach the engine. Use ⋮ → Restart engine.':e.message); }
  finally { stopPending=false; runControls(); await poll(); }
};
function download(name,value){const text=JSON.stringify(value,null,2);if(phone){phone.exportJson(name,text);return;}const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('export-preset').onclick=async()=>{try{alertError('');download('toolkit-settings.json',createPreset(accountUI?.enabled ? await accountUI.exportPreset() : {...configuration(),wallets:walletValues(true)}));}catch(e){alertError(e.message);}};
$('import-preset').onclick=()=>{if(walletGenerationPending)return alertError('Wait for wallet generation to finish saving.');if(latest?.state!=='stopped' || portfolioUI?.busy)return alertError('Stop before loading a preset.');$('preset-file').click();};
$('preset-file').onchange=async()=>{try{const file=$('preset-file').files[0];if(!file)return;if(file.size>maxPresetBytes)throw Error('Preset is too large.');applyPreset(readPreset(await file.text()));rememberSetup();alertError('');}catch(e){alertError(e.message);}finally{$('preset-file').value='';}};
$('export-log').onclick=()=>download('toolkit-session.json',{...latest,exportedAt:Date.now()});
for(const id of settingIds)$(id).addEventListener('input',updateControls);
$('setup').addEventListener('input', rememberSetup);
$('setup').addEventListener('change', rememberSetup);
$('setup').addEventListener('click', rememberSetup);
async function poll(){if(polling||document.hidden)return;polling=true;lastPollAt=Date.now();const version=actionVersion;try{const s=await api(kindNow() === 'sniper' ? '/api/sniper/status' : '/api/status');if(version===actionVersion)showStatus(s);}catch(e){if(version===actionVersion){connected=false;runControls();$('run-state').textContent='Local app disconnected';$('stream-state').textContent=phone?'Use ⋮ → Restart engine':'Check the terminal window';}}finally{polling=false;}}
async function liveUpdates() {
  let reader;
  try {
    const response = await fetch('/api/events', {headers:{'x-control-token':token}});
    if (!response.ok || !response.body?.getReader) throw Error('Updates unavailable');
    reader=response.body.getReader(); updatesConnected=true;
    const decoder=new TextDecoder(); let buffer='';
    for (;;) {
      const {value,done}=await reader.read(); if(done)break;
      buffer+=decoder.decode(value,{stream:true});
      let end;
      while((end=buffer.indexOf('\n\n'))>=0) {
        const message=buffer.slice(0,end); buffer=buffer.slice(end+2);
        if(message.startsWith('data: '))showStatus(JSON.parse(message.slice(6)));
      }
    }
  } catch {} finally { reader?.cancel().catch(()=>{}); updatesConnected=false; setTimeout(liveUpdates,1500); }
}
tradingUI = createTradingUI({ api, configuration, getKind: kindNow, getStatus: () => latest, showStatus, onWallets: wallets => { [...$('wallets').children].forEach((row, i) => { if (wallets[i]) row.querySelector('.wallet-public').value = wallets[i].publicKey; }); } });
portfolioUI = createPortfolioUI({ api, configuration, alertError, copyStatus: () => latest, selectedIndices: () => runUI?.selectedIndices(), tabChanged: () => { switchCopyForm(kindNow()); accountUI?.renderFeeNote(); updateControls(); runControls(); runUI?.render(); }, changed: rememberSetup, saveNow: savePhoneNow, download });
runUI = createRunUI({ api, getStatus: () => latest, getKind: () => portfolioUI.active, isPending: () => startPending || portfolioUI.pending, changed: () => { rememberSetup(); portfolioUI.render(); }, alertError });
accountUI = createAccountUI({ api, getKind: kindNow, getStatus: () => latest, settings: () => ({ ...configuration(), wallets: walletValues(true) }), applySettings: value => applyPreset(readPreset(JSON.stringify(value))), sealSettings, addGeneratedWallets, alertError });
walletRow();
executionUI = createExecutionPresetsUI({ chain: 'solana', mount: $('execution-presets'), read: configuration,
  locked: () => startPending || walletGenerationPending || portfolioUI.busy || tradingUI.busy || latest?.state !== 'stopped',
  write: async next => {
    const before = configuration(); applyPreset(next);
    try { if (accountUI.enabled) await accountUI.save(); else savePhoneNow(); }
    catch (error) { applyPreset(before); throw error; }
  } });
if(phone){
  try { const saved=phone.loadPreset(); if(saved)applyPreset(readPreset(saved)); } catch { alertError('Saved settings could not be loaded. Import your setup file.'); }
  const note=document.createElement('p');note.className='help';note.textContent='Settings save on this phone automatically. Start a run when ready.';$('setup').prepend(note);
}
presetReady=true;
document.addEventListener('relay-save', savePhoneNow);
document.addEventListener('visibilitychange', () => { if(document.hidden)savePhoneNow(); });
try {
  const response = await fetch('/api/session'); if (!response.ok) throw Error('Session unavailable.');
  const session = await response.json(); token = session.token || '';
  if (session.authenticated && new URLSearchParams(location.search).get('chain') === 'robinhood') location.replace(chainToolHref('robinhood',new URLSearchParams(location.search).get('tool')));
  if (await accountUI.initialize(session)) {
    await poll(); if (session.portfolio) portfolioUI.enable(); if (session.accounts) runUI.enable(); liveUpdates();
    createTerminalUI({ chain: 'solana', session, api, openConnections: () => accountUI.openConnections() });
    setInterval(() => { if (!sessionExpired && (!updatesConnected || kindNow() === 'sniper' || Date.now() - lastPollAt >= 5000)) poll(); }, 1200);
  }
} catch {
  $('session-loading').replaceChildren();
  const message = document.createElement('p'); message.textContent = phone ? 'Cannot connect to the trading service. Reopen Launchpad.' : 'Cannot connect to Launchpad. Check that the host is running and try again.';
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'small-button'; retry.textContent = 'Retry'; retry.onclick = () => location.reload();
  $('session-loading').append(message, retry); $('session-loading').hidden = false;
}
