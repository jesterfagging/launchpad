import { cleanRunWallets, runKinds, runLabels } from './run-settings.mjs';
import { WALLET_LIMITS, walletTool } from './wallet-limits.mjs';
import { renderIfChanged } from './ui-performance.mjs';
const $ = id => document.getElementById(id);
export function createRunUI({ api, getStatus, getKind, changed, alertError, isPending = () => false }) {
  let selections = cleanRunWallets(), enabled = false, stopping = false, key = '', balances = {}, balancesAt = 0, refreshing = false;
  const bar = document.createElement('section'); bar.className = 'run-overview'; bar.hidden = true; bar.setAttribute('aria-label', 'All trading runs');
  const indicators = document.createElement('div'); indicators.className = 'run-indicators';
  const stop = document.createElement('button'); stop.type = 'button'; stop.className = 'small-button'; stop.textContent = 'Stop all';
  bar.append(indicators, stop); document.querySelector('.strategy-tabs').after(bar);
  const box = document.createElement('details'); box.id = 'wallet-menu'; box.className = 'mode-wallets'; box.hidden = true;
  box.innerHTML = '<summary><span id="run-wallet-title">Wallets</span><span id="run-wallet-selected">0 selected</span></summary><div class="wallet-picker-toolbar"><label class="check"><input type="checkbox" id="run-wallet-all"> Select all</label><button type="button" class="text-button" id="wallet-refresh">Refresh SOL</button></div><p id="wallet-balances-note" class="help" role="status">Balances load from your saved RPC.</p><div id="run-wallet-list"></div><details id="wallet-editor"><summary>Edit keys, labels &amp; amounts</summary></details>';
  const walletCard = $('wallets').closest('.card'); $('wallets').before(box); $('wallet-editor').append($('wallets'));
  for (const node of [walletCard.querySelector('.wallet-actions'), $('bulk-panel'), $('generate-panel'), $('wallet-generation-message')]) box.append(node);
  box.querySelector('.wallet-picker-toolbar').append($('add-wallet'));
  const rows = () => [...$('wallets').children].map((row, i) => ({ index: i, tool: row.dataset.tool || 'copy', key: row.querySelector('.wallet-public').value.trim(), label: row.querySelector('.wallet-label').value || `Wallet ${i + 1}` }));
  const eligible = (kind = getKind()) => rows().filter(w => w.tool === walletTool(kind));
  function selectedIndices(kind = getKind()) { return eligible(kind).filter(row => selections[kind] === null || selections[kind].includes(row.key)).map(row => row.index); }
  async function refreshBalances() {
    if (!enabled || refreshing || Date.now() - balancesAt < 30000) return;
    refreshing = true; $('wallet-refresh').disabled = true; $('wallet-balances-note').textContent = 'Reading SOL balances…';
    try { const value = await api('/api/wallet-balances'); balances = value.balances; balancesAt = value.at; $('wallet-balances-note').textContent = `SOL balances · ${new Date(value.at).toLocaleTimeString()}`; key = ''; render(); }
    catch (error) { $('wallet-balances-note').textContent = error.message; }
    finally { refreshing = false; $('wallet-refresh').disabled = false; }
  }
  function render() {
    const kind = getKind(), runs = getStatus()?.runs || {}, wallets = eligible(kind);
    for (const row of $('wallets').children) row.hidden = row.dataset.tool !== walletTool(kind);
    if (!enabled) return;
    renderIfChanged(indicators, runKinds.map(k => runs[k]?.state || 'stopped'), () => {
      indicators.replaceChildren();
      for (const k of runKinds) { const row = document.createElement('span'); row.className = `run-indicator ${runs[k]?.state === 'running' ? 'running' : ''}`; row.textContent = `${runLabels[k]} · ${runs[k]?.state || 'stopped'}`; indicators.append(row); }
    });
    stop.disabled = stopping || !isPending() && runKinds.every(k => !runs[k] || runs[k].state === 'stopped'); stop.textContent = stopping ? 'Stopping…' : 'Stop all';
    const count = selectedIndices(kind).length;
    $('run-wallet-title').textContent = `${runLabels[kind]} wallets`;
    $('run-wallet-selected').textContent = `${count} selected · ${wallets.length}/${WALLET_LIMITS[kind]}`;
    $('run-wallet-all').checked = !!wallets.length && count === wallets.length; $('run-wallet-all').indeterminate = count > 0 && count < wallets.length;
    const next = JSON.stringify([kind, wallets, selections, runKinds.map(k => [runs[k]?.state, runs[k]?.mode, runs[k]?.wallets]), balances]); if (next === key) return; key = next;
    const list = $('run-wallet-list'); list.replaceChildren();
    for (const wallet of wallets) {
      const row = document.createElement('div'); row.className = 'wallet-picker-row';
      const label = document.createElement('label'), check = document.createElement('input'); check.type = 'checkbox'; check.checked = selections[kind] === null || selections[kind].includes(wallet.key); check.disabled = !wallet.key;
      const text = document.createElement('span'), name = document.createElement('strong'), address = document.createElement('small');
      name.textContent = wallet.label; address.textContent = wallet.key ? `${wallet.key.slice(0, 5)}…${wallet.key.slice(-5)}` : 'Check address first'; address.title = wallet.key;
      const used = runKinds.filter(k => k !== kind && runs[k]?.state !== 'stopped' && runs[k]?.mode === 'live' && runs[k]?.wallets?.includes(wallet.key));
      if (used.length) address.textContent += ` · ${used.map(k => runLabels[k]).join(', ')}`;
      check.onchange = () => { const current = selections[kind] ?? wallets.map(w => w.key).filter(Boolean); selections[kind] = check.checked ? [...new Set([...current, wallet.key])] : current.filter(k => k !== wallet.key); changed(); render(); };
      text.append(name, address); label.append(check, text);
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'text-button'; copy.textContent = '⧉'; copy.setAttribute('aria-label', `Copy ${wallet.label} address`); copy.disabled = !wallet.key;
      copy.onclick = async () => { try { await navigator.clipboard.writeText(wallet.key); copy.textContent = '✓'; } catch { alertError('Could not copy the address. Open Edit keys to select it.'); } };
      const balance = document.createElement('span'); balance.className = 'wallet-sol'; balance.textContent = balances[wallet.key] == null ? '— SOL' : `${(Number(balances[wallet.key]) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 6 })} SOL`;
      row.append(label, copy, balance); list.append(row);
    }
    if (!wallets.length) list.textContent = 'Import or generate a wallet for this tool.';
  }
  $('run-wallet-all').onchange = () => { selections[getKind()] = $('run-wallet-all').checked ? null : []; changed(); render(); };
  $('wallet-refresh').onclick = refreshBalances;
  box.addEventListener('toggle', () => { if (box.open) refreshBalances(); });
  stop.onclick = async () => { if (stopping) return; stopping = true; render(); try { await api('/api/runtime/stop', {}); alertError(''); } catch (error) { alertError(error.message); } finally { stopping = false; render(); } };
  $('wallets').addEventListener('input', render); new MutationObserver(render).observe($('wallets'), { childList: true });
  return { render, selectedIndices, selections: () => Object.fromEntries(runKinds.map(k => [k, selections[k] === null ? null : selections[k].filter(key => eligible(k).some(w => w.key === key))])),
    load(value) { selections = cleanRunWallets(value); key = ''; balancesAt = 0; render(); }, enable() { enabled = true; bar.hidden = false; box.hidden = false; render(); } };
}
