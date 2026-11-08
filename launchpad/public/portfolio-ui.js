import { cleanLiquidityPlans, MAX_LP_POSITIONS } from './liquidity-plans.mjs';
import { walletTool } from './wallet-limits.mjs';
import { appliedExecutionValues } from './execution-presets.mjs';
import { profiles, strategyDefaults, cleanStrategy, resolvedStrategy, tuningLimits } from './strategy-settings.mjs';
const $ = id => document.getElementById(id);
const short = x => x?.slice(0, 5) + '…' + x?.slice(-5);
const labels = { deployPercent: 'Budget deployed (%)', targetPercent: 'Target base-token share (%)', bandPercent: 'Allocation drift (percentage points)', tradePercent: 'Maximum adjustment (% of inventory)', cooldownSeconds: 'Minimum time between trades (seconds)', pollSeconds: 'Check interval (seconds)', slippagePercent: 'Maximum slippage (%)', impactPercent: 'Maximum price impact (%)', turnoverMultiple: 'Daily turnover / budget', feePercent: 'Daily fee budget (%)', lossPercent: 'Allocation loss pause (%)', rangeBins: 'DLMM range (bins on each side)', maxMoves: 'Daily liquidity adjustments' };
export function createPortfolioUI({ api, configuration, alertError, copyStatus, changed, saveNow, download, selectedIndices = () => null, tabChanged = () => {} }) {
  let active = 'copy', enabled = false, state = null, online = false, polling = false, budgetIds = [], lastRender = '';
  const states = {}, actionsPending = new Map();
  let lpPlans = [], activePlan = '';
  const isPortfolio = () => ['market', 'liquidity'].includes(active);
  let saved = { market: strategyDefaults(), liquidity: strategyDefaults() };
  const nav = document.createElement('nav'); nav.className = 'strategy-tabs'; nav.hidden = true; nav.setAttribute('aria-label', 'Trading tools');
  for (const [id, label] of [['copy', 'Copy trading'], ['sniper', 'Launch sniper'], ['liquidity', 'Liquidity'], ['market', 'Market making']]) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.dataset.tab = id; b.onclick = () => select(id); nav.append(b);
  }
  document.querySelector('.heading').after(nav);
  const card = document.createElement('section'); card.className = 'card strategy-card'; card.hidden = true;
  card.innerHTML = '<div class="card-heading"><h2 id="strategy-title">Market Making</h2><span class="tag">YOUR ALLOCATED FUNDS</span></div><div class="two-col"><label>Token mint<input id="strategy-baseMint" spellcheck="false" placeholder="Solana token mint address"></label><label>Quote mint<input id="strategy-quoteMint" spellcheck="false"></label></div><label>Budget per wallet (SOL)<input id="strategy-budgetSol" inputmode="decimal" value="1"></label><p id="strategy-total" class="help"></p><div class="strategy-profiles" id="strategy-profiles"></div><p id="strategy-description" class="help"></p><p id="strategy-summary" class="strategy-summary"></p><label class="check" id="strategy-compound-field"><input id="strategy-compound" type="checkbox"> Automatically reinvest earned LP fees</label><p class="help" id="strategy-compound-help">Claim fees sends earned tokens to the wallet. Auto-compound reinvests tracked fee proceeds into the same position when they cover network costs. PumpSwap and Raydium CPMM already retain fees in their reserves.</p><label class="check"><input id="strategy-advanced" type="checkbox"> Advanced settings</label><div id="strategy-advanced-fields" hidden><label id="strategy-pool-field">Pool address <span class="optional">optional · automatically selected otherwise</span><input id="strategy-pool" spellcheck="false"></label><div id="strategy-budgets"></div><div class="two-col" id="strategy-tuning"></div><button type="button" class="text-button" id="strategy-reset">Reset to preset defaults</button></div>';
  $('config-fields').prepend(card);
  const planPanel = document.createElement('div'); planPanel.id = 'lp-plans';
  planPanel.innerHTML = '<div class="lp-plan-controls"><label>LP position<select id="lp-plan-select"></select></label><button type="button" class="small-button" id="lp-plan-add">+ Position</button><button type="button" class="text-button" id="lp-plan-remove">Remove setup</button></div><div class="two-col"><label>Position label<input id="lp-plan-label" maxlength="40"></label><label>Position wallet<select id="lp-plan-wallet"></select></label></div><p class="help">Each position has its own pair, budget and preset. One wallet can hold several positions. Up to 20 positions across 10 LP wallets.</p>';
  card.querySelector('.card-heading').after(planPanel);
  function savePlan() {
    if (active !== 'liquidity' || !activePlan) return;
    const p = lpPlans.find(p => p.id === activePlan); if (p) { p.strategy = read(); p.wallet = $('lp-plan-wallet').value || p.wallet; p.label = $('lp-plan-label').value || p.label; }
  }
  function planOptions() {
    const rows = [...$('wallets').children].filter(row => row.dataset.tool === 'liquidity'), value = $('lp-plan-wallet').value;
    $('lp-plan-wallet').replaceChildren();
    for (const row of rows) { const o = document.createElement('option'); o.value = row.querySelector('.wallet-public').value; o.textContent = row.querySelector('.wallet-label').value; $('lp-plan-wallet').append(o); }
    const p = lpPlans.find(p => p.id === activePlan); $('lp-plan-wallet').value = p?.wallet || value || rows[0]?.querySelector('.wallet-public').value || '';
    $('lp-plan-select').replaceChildren();
    for (const p of lpPlans) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.label; $('lp-plan-select').append(o); }
    $('lp-plan-select').value = activePlan; $('lp-plan-label').value = p?.label || 'LP position';
    $('lp-plan-add').disabled = lpPlans.length >= MAX_LP_POSITIONS;
  }
  function addPlan() {
    savePlan(); if (lpPlans.length >= MAX_LP_POSITIONS) return;
    const wallet = [...$('wallets').children].find(r => r.dataset.tool === 'liquidity')?.querySelector('.wallet-public').value;
    if (!wallet) return alertError('Generate or import an LP wallet and check its address first.');
    const p = { id: crypto.randomUUID(), label: `LP position ${lpPlans.length + 1}`, wallet, strategy: lpPlans.length ? strategyDefaults() : structuredClone(saved.liquidity) };
    lpPlans.push(p); activePlan = p.id; saved.liquidity = p.strategy; fill(); changed();
  }
  $('lp-plan-add').onclick = addPlan;
  $('lp-plan-select').onchange = () => { savePlan(); activePlan = $('lp-plan-select').value; saved.liquidity = lpPlans.find(p => p.id === activePlan).strategy; fill(); changed(); };
  $('lp-plan-remove').onclick = () => { lpPlans = lpPlans.filter(p => p.id !== activePlan); activePlan = lpPlans[0]?.id || ''; saved.liquidity = lpPlans[0]?.strategy || strategyDefaults(); fill(); changed(); };

  for (const [id, p] of Object.entries(profiles)) {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.preset = id; const title = document.createElement('strong'), text = document.createElement('small'); title.textContent = p.name; text.textContent = p.description; b.append(title, text);
    b.onclick = () => { saved[active] = read(); saved[active].preset = id; saved[active].tuning = {}; fill(); changed(); }; $('strategy-profiles').append(b);
  }
  for (const [key, [min, max]] of Object.entries(tuningLimits)) {
    const label = document.createElement('label'); label.textContent = labels[key]; label.dataset.tuning = key;
    const input = document.createElement('input'); input.id = `strategy-${key}`; input.type = 'number'; input.min = min; input.max = max; input.step = 'any'; label.append(input); $('strategy-tuning').append(label);
  }
  const actions = document.createElement('div'); actions.className = 'strategy-actions'; actions.hidden = true;
  actions.innerHTML = '<button type="button" class="primary" id="strategy-start">Start strategy ↗</button><button type="button" class="stop" id="strategy-stop" disabled>Stopped</button>';
  document.querySelector('.run-bar').append(actions);
  const side = document.createElement('section'); side.className = 'card strategy-status'; side.hidden = true;
  side.innerHTML = '<div class="card-heading"><h2>Strategy monitor</h2><button type="button" class="text-button" id="strategy-export">Export</button></div><p id="strategy-state">Stopped</p><p class="help" id="strategy-pool-name"></p><div id="strategy-positions"></div><h3>Activity</h3><div id="strategy-events" aria-live="polite"></div>';
  document.querySelector('aside').prepend(side);
  const feeCard = $('prioritySol').closest('.card'), feeHome = document.createComment('fees'); feeCard.before(feeHome);
  const walletHeading = $('wallets').closest('.card').querySelector('h2');
  const copyCards = ['leads', 'buyAmount', 'sellMode'].map(id => $(id).closest('.card'));
  const copyAside = [...document.querySelector('aside').children].filter(x => x !== side);
  function read() {
    if (!isPortfolio()) return null;
    const s = { ...saved[active], advanced: $('strategy-advanced').checked, autoCompoundFees: $('strategy-compound').checked, tuning: {}, walletBudgets: {} };
    for (const k of ['baseMint', 'quoteMint', 'budgetSol', 'pool']) s[k] = $(`strategy-${k}`).value;
    for (const k of Object.keys(tuningLimits)) s.tuning[k] = Number($(`strategy-${k}`).value);
    for (const input of $('strategy-budgets').querySelectorAll('input')) if (input.value.trim()) s.walletBudgets[input.dataset.index] = input.value.trim();
    return s;
  }
  function budgets() {
    const rows = [...$('wallets').children], ids = rows.map(r => r.dataset.id + ':' + r.dataset.tool);
    if (ids.join() === budgetIds.join()) return;
    const previous = new Map([...$('strategy-budgets').querySelectorAll('input')].map(i => [i.dataset.walletId, i.value]));
    $('strategy-budgets').replaceChildren();
    rows.forEach((row, index) => {
      if (row.dataset.tool !== walletTool(active)) return;
      const label = document.createElement('label'); label.textContent = `${row.querySelector('.wallet-label').value || `Wallet ${index + 1}`} budget (SOL)`;
      const input = document.createElement('input'); input.inputMode = 'decimal'; input.dataset.index = index; input.dataset.walletId = ids[index]; input.placeholder = 'Use common budget'; input.value = previous.get(ids[index]) || saved[active]?.walletBudgets[index] || ''; label.append(input); $('strategy-budgets').append(label);
    }); budgetIds = ids;
  }
  function fill() {
    if (!isPortfolio()) return;
    planOptions(); $('lp-plans').hidden = active !== 'liquidity';
    const s = saved[active], p = resolvedStrategy(s).limits;
    for (const k of ['baseMint', 'quoteMint', 'budgetSol', 'pool']) $(`strategy-${k}`).value = s[k];
    $('strategy-advanced').checked = s.advanced; $('strategy-compound').checked = s.autoCompoundFees === true;
    for (const k of Object.keys(tuningLimits)) $(`strategy-${k}`).value = p[k];
    budgetIds = []; $('strategy-budgets').replaceChildren(); budgets(); details();
  }
  function details() {
    if (!isPortfolio()) return;
    budgets(); const s = read(), p = profiles[s.preset];
    for (const b of $('strategy-profiles').children) b.setAttribute('aria-pressed', String(b.dataset.preset === s.preset));
    $('strategy-budgetSol').parentElement.firstChild.nodeValue = active === 'liquidity' ? 'Budget for this position (SOL)' : 'Budget per wallet (SOL)';
    $('strategy-budgets').hidden = active === 'liquidity';
    $('strategy-compound-field').hidden = active !== 'liquidity'; $('strategy-compound-help').hidden = active !== 'liquidity'; $('strategy-advanced-fields').hidden = !s.advanced; $('strategy-pool-field').hidden = active !== 'liquidity';
    for (const label of $('strategy-tuning').children) label.hidden = active !== 'liquidity' && ['rangeBins', 'maxMoves'].includes(label.dataset.tuning);
    const l = { ...p, ...(s.advanced ? s.tuning : {}) };
    const execution = appliedExecutionValues('solana', configuration());
    $('strategy-summary').textContent = `${l.deployPercent}% deployed · ${l.targetPercent}% target token share · ±${l.bandPercent} points before rebalancing · ${execution?.slippagePercent ?? l.slippagePercent}% slippage cap · ${execution ? `Saved execution preset: ${execution.prioritySol} SOL priority · ${execution.jitoSol} Jito · ${execution.heliusSol} Helius` : s.advanced ? 'Custom fees below' : 'Automatic fees: RPC, 0.00005 SOL priority cap'}`;
    const indices = selectedIndices() || [...$('wallets').children].map((_, i) => i), count = indices.length;
    const selectedKeys = new Set(indices.map(i => $('wallets').children[i]?.querySelector('.wallet-public').value));
    const total = active === 'liquidity' && lpPlans.length ? lpPlans.filter(p => selectedKeys.has(p.id === activePlan ? $('lp-plan-wallet').value : p.wallet)).reduce((n, p) => n + Number(p.id === activePlan ? s.budgetSol : p.strategy.budgetSol), 0) : indices.reduce((n, i) => n + Number(s.walletBudgets[i] || s.budgetSol || 0), 0);
    $('strategy-total').textContent = `${count} wallet${count === 1 ? '' : 's'} · ${Number.isFinite(total) ? total.toLocaleString(undefined, { maximumFractionDigits: 9 }) : '—'} SOL total budget. Fees and account rent use this budget; your wallet reserve stays separate.`;
  }
  function select(next) {
    if (isPortfolio()) { savePlan(); saved[active] = read(); } active = next; state = states[active] || null; lastRender = '';
    for (const b of nav.children) b.setAttribute('aria-pressed', String(b.dataset.tab === active));
    const isCopy = !isPortfolio(); card.hidden = isCopy; side.hidden = isCopy; actions.hidden = isCopy;
    copyCards.forEach(c => c.hidden = !isCopy); copyAside.forEach(c => c.hidden = !isCopy);
    if (isCopy) feeHome.after(feeCard); else $('strategy-advanced-fields').append(feeCard);
    walletHeading.textContent = 'Your wallets';
    $('leads').closest('.card').querySelector('h2').textContent = active === 'sniper' ? 'Developer wallets' : 'Target addresses';
    $('leads').closest('.card').querySelector('.help').textContent = active === 'sniper' ? 'Watch up to 100 developer addresses. Buys verified launches when a route is available.' : 'Copies new swaps after Start.';
    $('leads').placeholder = active === 'sniper' ? 'One developer public address per line (up to 100)' : 'One target address per line';
    $('leads').required = isCopy; $('start').hidden = !isCopy; $('stop').hidden = !isCopy;
    document.querySelector('.advanced').hidden = !isCopy;
    for (const el of [$('streamMode').closest('.two-col'), $('fast-logs-setting'), $('stream-help'), $('fast-setup'), $('fast-setup').nextElementSibling, $('speed-settings')]) el.hidden = !isCopy;
    for (const row of $('wallets').children) { const custom = isCopy && $('amountMode').value === 'custom'; row.querySelector('.wallet-amount-field').hidden = !custom; row.classList.toggle('custom-amount', custom); }
    document.querySelector('.heading h1').textContent = active === 'sniper' ? 'Launch sniper' : isCopy ? 'Copy trading' : active === 'market' ? 'Market making' : 'Liquidity';
    document.querySelector('.subtitle').textContent = active === 'sniper' ? '100 watched developers. Up to 25 sniping wallets.' : isCopy ? 'Choose your wallets, set an amount, and copy your targets.' : 'Choose a pair, budget and strategy.';
    if (!isCopy) {
      $('strategy-title').textContent = active === 'market' ? 'Market Making' : 'Liquidity Management';
      $('strategy-description').textContent = active === 'market' ? 'Rebalances allocated holdings only when they drift from the target. Funds stay in your wallets between swaps.' : 'Deposits allocated tokens into a verified pool. Manages DLMM ranges automatically; constant-product pools use their existing range. Stop leaves liquidity in place; Withdraw returns the tokens.';
      if (active === 'liquidity' && !lpPlans.length) addPlan();
      if (active === 'liquidity' && lpPlans.length) { activePlan ||= lpPlans[0].id; saved.liquidity = lpPlans.find(p => p.id === activePlan).strategy; }
      fill();
    }
    tabChanged(); render(); poll();
  }
  function controls() {
    if (!enabled) return;
    const concurrent = copyStatus()?.concurrent, portfolioBusy = isPortfolio() && (actionsPending.has(active) || (copyStatus()?.runs?.[active]?.state || state?.state || 'stopped') !== 'stopped'), copyBusy = !concurrent && copyStatus()?.state !== 'stopped';
    if (isPortfolio()) { $('config-fields').disabled = !!(portfolioBusy || copyBusy); $('mode').disabled = !!(portfolioBusy || copyBusy); }
    else if (!concurrent && Object.values(states).some(s => s.state !== 'stopped')) { $('config-fields').disabled = true; $('mode').disabled = true; $('start').disabled = true; }
    $('strategy-start').disabled = !online || !!portfolioBusy || !!copyBusy;
    $('strategy-stop').disabled = !portfolioBusy || state?.state === 'stopping';
    $('strategy-stop').textContent = state?.state === 'stopping' ? 'Stopping…' : portfolioBusy ? 'Stop' : 'Stopped';
    if (isPortfolio()) {
      for (const row of $('wallets').children) { row.querySelector('.wallet-amount-field').hidden = true; row.classList.remove('custom-amount'); }
      for (const el of [$('streamMode').closest('.two-col'), $('fast-logs-setting'), $('stream-help'), $('fast-setup'), $('fast-setup').nextElementSibling, $('speed-settings')]) el.hidden = true;
      $('run-state').textContent = state?.stopReason ? 'Stopped new trades · review Activity' : portfolioBusy ? `${state?.state || 'Starting'} · ${state?.kind === 'liquidity' ? 'Liquidity' : 'Market Making'}` : 'Ready to configure';
      $('stream-state').textContent = online ? 'Portfolio engine connected' : 'Connecting…';
      $('status-light').className = `status-light ${state?.state === 'running' ? 'running' : ''}`;
    }
  }
  function render() {
    controls(); details(); if (!state || !isPortfolio()) return;
    $('strategy-state').textContent = `${state.mode.toUpperCase()} · ${state.state}${state.stopReason ? ` · ${state.stopReason.message}` : state.startupError ? ` · ${state.startupError}` : ''}`;
    $('strategy-pool-name').textContent = state.pool ? `${state.pool.venue} · ${short(state.pool.id)}` : 'Inventory swaps use available Jupiter routes.';
    const key = JSON.stringify([state.positions, state.pending, state.events[0]?.id, state.state]); if (key === lastRender) return; lastRender = key;
    $('strategy-positions').replaceChildren();
    for (const p of state.positions) {
      const box = document.createElement('div'); box.className = 'position'; const title = document.createElement('strong'); title.textContent = `${p.label || p.walletLabel} · ${short(p.wallet)}`; box.append(title);
      const text = document.createElement('p'); text.textContent = p.paused || (state.pending.some(t => t.wallet === p.wallet) ? 'Transaction pending' : p.position ? `In ${p.position.venue} pool` : 'Funds in wallet'); box.append(text);
      for (const b of p.balances || []) { const line = document.createElement('small'); line.textContent = `${b.mint === 'So11111111111111111111111111111111111111112' ? 'SOL' : short(b.mint)}: ${b.amount}`; box.append(line); }
      if (p.poolBalances) for (const [mint, amount] of Object.entries(p.poolBalances)) { const line = document.createElement('small'); line.textContent = `Pool ${short(mint)}: ${Number(amount) / 10 ** (p.decimals?.[mint] || 0)}`; box.append(line); }
      const button = document.createElement('button'); button.type = 'button'; button.className = 'small-button'; button.textContent = p.position ? 'Withdraw to wallet' : 'Release allocation';
      button.disabled = actionsPending.has(active) || (p.position ? !['running','stopped'].includes(state.state) : state.state !== 'stopped') || state.pending.some(t => t.wallet === p.wallet);
      button.onclick = () => call(p.position ? 'withdraw' : 'release', p.position ? { wallet: p.wallet, id: p.id, config: { ...configuration(), mode: state.mode, strategy: read() } } : { id: p.id, mode: state.mode, kind: active }); box.append(button);
      if (p.position && !['PumpSwap', 'Raydium CPMM'].includes(p.position.venue)) { const claim = document.createElement('button'); claim.type = 'button'; claim.className = 'small-button'; claim.textContent = 'Claim fees'; claim.disabled = button.disabled; claim.onclick = () => call('claim-fees', { wallet: p.wallet, id: p.id, config: { ...configuration(), mode: state.mode, strategy: read() } }); box.append(claim); }
      else if (p.position) { const note = document.createElement('p'); note.className = 'help'; note.textContent = 'Trading fees already accrue inside the LP reserves.'; box.append(note); }
      $('strategy-positions').append(box);
    }
    if (!state.positions.length) $('strategy-positions').textContent = 'Your allocated balances and pool positions will appear here.';
    $('strategy-events').replaceChildren();
    for (const e of state.events.slice(0, 60)) { const item = document.createElement('p'); item.className = 'strategy-event'; item.textContent = `${new Date(e.at).toLocaleTimeString()} · ${e.message}`; $('strategy-events').append(item); }
  }
  async function call(name, body) {
    // Stop must remain usable while Start waits for RPC/network setup.
    const kind = active;
    if (actionsPending.has(kind) && name !== 'stop') return;
    const operation = Symbol(name); actionsPending.set(kind, operation); controls(); alertError('');
    try { const result = await api(`/api/portfolio/${name}`, { ...body, kind }); states[kind] = result; if (active === kind) state = result; online = true; }
    catch (e) {
      if (e.status) { states[kind] = e.status; if (active === kind) state = e.status; }
      const cancelled = name === 'start' && e.status?.state === 'stopped' && !e.status.startupError;
      alertError(cancelled ? '' : e.message);
    }
    finally { if (actionsPending.get(kind) === operation) actionsPending.delete(kind); lastRender = ''; await poll(); render(); }
  }
  async function poll() {
    if (!enabled || polling || document.hidden) return; polling = true;
    const kind = isPortfolio() ? active : 'liquidity';
    try { const result = await api(`/api/portfolio/status?kind=${kind}&mode=${$('mode').value}`); states[kind] = result; if (active === kind) state = result; online = true; } catch { online = false; }
    finally { polling = false; render(); }
  }
  $('strategy-start').onclick = () => {
    try { savePlan(); saved[active] = read(); saveNow(); call('start', { kind: active, config: { ...configuration(), strategy: saved[active] } }); }
    catch (e) { alertError(e.message); }
  };
  $('strategy-stop').onclick = () => call('stop', {});
  $('strategy-reset').onclick = () => { saved[active] = { ...read(), tuning: {} }; fill(); changed(); };
  $('strategy-export').onclick = () => download('portfolio-session.json', { ...state, exportedAt: Date.now() });
  card.addEventListener('input', () => { details(); changed(); });
  $('wallets').addEventListener('input', details);
  new MutationObserver(details).observe($('wallets'), { childList: true });
  return { get active() { return active; }, get pending() { return actionsPending.size > 0; }, get busy() { return actionsPending.size > 0 || Object.values(states).some(s => s.state !== 'stopped') || Object.values(copyStatus()?.runs || {}).some(s => s.state !== 'stopped'); }, controls, render,
    enable() { enabled = true; nav.hidden = false; select('copy'); poll(); setInterval(poll, 2000); },
    presets() { if (isPortfolio()) { savePlan(); saved[active] = read(); } return saved; },
    plans() { savePlan(); return structuredClone(lpPlans); },
    load(value = {}, plans = []) { lpPlans = cleanLiquidityPlans(plans); activePlan = lpPlans[0]?.id || ''; saved = { market: cleanStrategy(value.market || {}), liquidity: cleanStrategy(value.liquidity || {}) }; if (active === 'liquidity' && lpPlans[0]) saved.liquidity = lpPlans[0].strategy; if (isPortfolio()) fill(); },
  };
}
