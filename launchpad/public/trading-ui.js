import { toolWallets } from './wallet-limits.mjs';
const $ = id => document.getElementById(id);
const short = value => value ? value.slice(0, 5) + '…' + value.slice(-5) : '—';
const finite = value => value !== null && value !== undefined && Number.isFinite(Number(value));
const amount = (value, digits = 6) => finite(value) ? Number(value).toLocaleString(undefined, { maximumFractionDigits: digits }) : '—';
const sol = value => finite(value) ? `${amount(value)} SOL` : 'N/A';
const usd = value => finite(value) ? Number(value).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: Math.abs(Number(value)) > 0 && Math.abs(Number(value)) < 0.01 ? 10 : 2 }) : 'N/A';
const signedSol = value => finite(value) ? `${Number(value) > 0 ? '+' : ''}${sol(value)}` : 'N/A';
const entry = row => finite(row.avgEntrySol) ? `${amount(row.avgEntrySol, 12)} SOL` : finite(row.avgEntryUsd) ? usd(row.avgEntryUsd) : 'N/A';
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function tone(node, value) { node.classList.toggle('positive', finite(value) && Number(value) > 0); node.classList.toggle('negative', finite(value) && Number(value) < 0); }

export function createTradingUI({ api, configuration, getStatus, showStatus, onWallets, getKind = () => 'copy' }) {
  let wallets = [], walletKey = '', walletLoad = null, side = 'buy', busy = false, uncertain = false, request = null;
  let lastPositions = '', lastHoldings = '', lastOutcome = '', initializedWallets = false;
  const selected = new Set();
  function message(text, error = false) { $('manual-message').textContent = text; $('manual-message').classList.toggle('negative', error); }
  function currentWalletKey() {
    const status = getStatus();
    return status?.state !== 'stopped' && status?.followers?.length
      ? JSON.stringify([status.runId, status.followers.map(w => [w.publicKey, w.label])])
      : JSON.stringify([getKind(), toolWallets(configuration(), getKind()).map(w => [w.privateKey, w.publicKey, w.label])]);
  }
  function setWallets(next, key) {
    const available = new Set(next.map(w => w.publicKey));
    for (const wallet of selected) if (!available.has(wallet)) selected.delete(wallet);
    wallets = next; walletKey = key; initializedWallets = true;
    $('manual-wallet-list').replaceChildren();
    for (const wallet of wallets) {
      const row = element('label', 'manual-wallet'), input = document.createElement('input'), text = element('span');
      input.type = 'checkbox'; input.value = wallet.publicKey; input.checked = selected.has(wallet.publicKey);
      input.onchange = () => { input.checked ? selected.add(wallet.publicKey) : selected.delete(wallet.publicKey); controls(); };
      text.append(element('strong', '', wallet.label || short(wallet.publicKey)), element('small', '', short(wallet.publicKey)));
      row.title = wallet.publicKey; row.append(input, text); $('manual-wallet-list').append(row);
    }
    if (!wallets.length) $('manual-wallet-list').append(element('p', 'help', 'Add your wallets in the setup first.'));
    controls();
  }
  async function loadWallets() {
    if (walletLoad) return walletLoad;
    const key = currentWalletKey();
    if (key === walletKey && initializedWallets) return;
    const active = getStatus();
    if (active?.state !== 'stopped' && active?.followers?.length) { setWallets(active.followers, key); return; }
    $('manual-wallet-loading').hidden = false;
    walletLoad = (async () => {
      const config = configuration(), value = await api('/api/wallets', { wallets: config.wallets, mode: config.mode });
      if (key !== currentWalletKey()) return;
      const next = value.wallets.map((wallet, i) => ({ ...wallet, label: config.wallets[i]?.label || `Wallet ${i + 1}` }));
      onWallets?.(next);
      const keys = new Set(toolWallets(config, getKind()).map(w => w.publicKey));
      setWallets(next.filter(w => keys.has(w.publicKey)), currentWalletKey());
    })();
    try { await walletLoad; } catch (error) { message(error.message, true); }
    finally { walletLoad = null; $('manual-wallet-loading').hidden = true; controls(); }
  }
  function controls() {
    const locked = busy || uncertain, count = selected.size;
    $('manual-fields').disabled = locked;
    $('manual-submit').disabled = busy || (!uncertain && (!count || !wallets.length));
    $('manual-submit').textContent = busy ? 'Checking execution…' : uncertain ? 'Check this request' : `${side === 'buy' ? 'Buy' : 'Sell'} with ${count || 'selected'} wallet${count === 1 ? '' : 's'}`;
    $('manual-submit').classList.toggle('manual-sell-button', side === 'sell' && !uncertain);
    $('manual-wallet-count').textContent = `${count} of ${wallets.length} selected`;
    $('manual-select-all').checked = !!wallets.length && count === wallets.length;
    $('manual-select-all').indeterminate = count > 0 && count < wallets.length;
    $('manual-buy-fields').hidden = side !== 'buy'; $('manual-sell-fields').hidden = side !== 'sell';
    for (const button of document.querySelectorAll('[data-manual-side]')) button.setAttribute('aria-pressed', String(button.dataset.manualSide === side));
    for (const button of document.querySelectorAll('[data-sell-percent]')) button.setAttribute('aria-pressed', String(button.dataset.sellPercent === $('manual-sell-percent').value));
    const size = Number($('manual-buy-amount').value), percent = Number($('manual-sell-percent').value);
    const mode = getStatus()?.state !== 'stopped' ? getStatus()?.mode : configuration().mode;
    $('manual-mode').textContent = (mode || 'live').toUpperCase();
    $('manual-preview').textContent = side === 'buy'
      ? `${sol(size)} per wallet · ${sol(size * count)} total input`
      : `${amount(percent, 2)}% of tracked holdings in each selected wallet`;
  }
  function renderOutcomes(result) {
    if (!result || !Array.isArray(result.outcomes)) return;
    const key = JSON.stringify(result); if (key === lastOutcome) return; lastOutcome = key;
    $('manual-results').replaceChildren();
    for (const item of result.outcomes) {
      const row = element('div', 'manual-outcome'), head = element('div', 'position-head');
      const wallet = wallets.find(w => w.publicKey === item.wallet);
      const state = ({ confirmed: 'Confirmed', pending: 'Pending confirmation', failed: 'Failed', skipped: 'Skipped' })[item.status] || item.status;
      head.append(element('strong', '', wallet?.label || short(item.wallet)), element('span', item.status === 'confirmed' ? 'positive' : ['failed', 'skipped'].includes(item.status) ? 'negative' : '', state));
      row.append(head);
      if (item.error) row.append(element('p', 'help', item.error));
      if (item.signature && /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(item.signature)) {
        const link = element('a', '', `${short(item.signature)} ↗`); link.href = `https://solscan.io/tx/${encodeURIComponent(item.signature)}`; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link);
      }
      $('manual-results').append(row);
    }
    $('manual-results').hidden = !result.outcomes.length;
  }
  function settleResult(result) {
    if (!result || result.id !== request?.trade.id) return false;
    renderOutcomes(result);
    if (result.state === 'preparing' || result.state === 'executing') {
      uncertain = true;
      message(result.state === 'preparing' ? 'Preparing this request. Wallet results will update here.' : 'Executing this request. Wallet results will update here.');
      return true;
    }
    uncertain = false;
    const counts = (result.outcomes || []).reduce((total, row) => ({ ...total, [row.status]: (total[row.status] || 0) + 1 }), {});
    message(Object.entries(counts).map(([name, count]) => `${count} ${name}`).join(' · ') || 'Request completed without wallet results.', !!counts.failed || !!counts.skipped);
    return true;
  }
  async function submit(event) {
    event.preventDefault(); if (busy) return;
    busy = true; controls();
    try {
      if (!uncertain) {
        await loadWallets();
        if (walletKey !== currentWalletKey() || !selected.size) throw Error('Select at least one of your wallets.');
        const mint = $('manual-mint').value.trim();
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw Error('Enter a valid Solana token mint.');
        const size = $('manual-buy-amount').value.trim(), percent = Number($('manual-sell-percent').value);
        if (side === 'buy' && (!/^\d*(?:\.\d+)?$/.test(size) || Number(size) <= 0)) throw Error('Enter a buy amount greater than zero.');
        if (side === 'sell' && (!Number.isFinite(percent) || percent <= 0 || percent > 100)) throw Error('Sell percentage must be greater than 0 and at most 100.');
        const config = configuration(), active = getStatus();
        if (active?.state === 'running') config.mode = active.mode;
        request = { config, kind: getKind(), trade: { id: crypto.randomUUID(), side, mint, wallets: [...selected], amountSol: size, sellPercent: percent, ...(getStatus()?.runId ? { expectedRunId: getStatus().runId } : {}) } };
        lastOutcome = ''; $('manual-results').replaceChildren(); $('manual-results').hidden = true;
      }
      message('Submitting your manual order…');
      const status = await api('/api/manual-trade', request); showStatus(status);
      const current = getStatus()?.manualResult;
      if (!settleResult(current?.id === request.trade.id ? current : status.manualResult)) {
        uncertain = true; message('Request accepted. Check this request for wallet results.');
      }
    } catch (error) {
      if (error.status) showStatus(error.status);
      // A lost response may already have executed. Retry the same request id.
      uncertain = error.name === 'AbortError' || error instanceof TypeError || !error.statusCode && /fetch|network|timeout|timed out/i.test(error.message) || error.statusCode >= 500;
      if (!uncertain || !settleResult(getStatus()?.manualResult)) message(uncertain ? 'Connection interrupted. Check this same request to retrieve its result.' : error.message, true);
    } finally { busy = false; controls(); }
  }
  function renderPositions(status) {
    const summary = status.positionSummary;
    const inventory = status.inventoryRefresh, inventoryNote = $('position-inventory-status');
    const checkedAt = Number(inventory?.at), checkedDate = new Date(checkedAt);
    const hasCheck = checkedAt > 0 && Number.isFinite(checkedDate.getTime());
    inventoryNote.hidden = status.mode !== 'live' || !inventory && !status.positions?.length;
    inventoryNote.classList.toggle('negative', inventory?.state === 'error');
    inventoryNote.textContent = inventory?.state === 'error'
      ? 'Balance refresh unavailable; showing last recorded holdings.'
      : inventory?.state === 'refreshing'
        ? 'Checking wallet balances…'
        : hasCheck
          ? `Balances checked ${checkedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
          : 'Wallet balances not checked yet.';
    $('position-count').textContent = summary?.openCount ?? status.positions?.length ?? 0;
    $('position-open-total').textContent = summary?.openCount ?? status.positions?.length ?? 0;
    $('position-value-total').textContent = summary ? sol(summary.totalValueSol) : 'N/A';
    $('position-pnl-total').textContent = summary ? signedSol(summary.totalPnlSol) : 'N/A';
    tone($('position-pnl-total'), summary?.totalPnlSol);
    $('position-pnl-usd').textContent = finite(summary?.totalPnlUsd) ? usd(summary.totalPnlUsd) : 'Unrealized';
    const partial = summary && (summary.pricedCount < summary.openCount || summary.costedCount < summary.openCount);
    $('position-data-note').textContent = partial ? 'Open P&L · unavailable prices or costs show N/A' : 'Open P&L · excludes network and exit fees';
    const groups = summary?.groups || [];
    const pendingWallets = new Set();
    for (const pending of status.pending || []) {
      if (pending.kind !== 'sell') continue;
      for (const allocation of pending.order?.allocations || []) {
        const lot = (status.positions || []).find(p => p.id === allocation.lotId);
        if (lot) pendingWallets.add(`${lot.mint}:${lot.wallet}`);
      }
    }
    const key = JSON.stringify([groups, [...pendingWallets]]);
    if (key !== lastPositions) {
      const expanded = new Set([...$('positions').querySelectorAll('details[open]')].map(d => d.dataset.mint));
      const focusedMint = document.activeElement?.classList.contains('holding-heading') ? document.activeElement.parentElement.dataset.mint : null;
      lastPositions = key; $('positions').replaceChildren();
      if (!groups.length) $('positions').append(element('p', 'empty', status.positions?.length ? 'Position values are being refreshed.' : 'No open positions.'));
      for (const group of groups) {
        const card = element('details', 'holding-group'); card.dataset.mint = group.mint; card.open = expanded.has(group.mint);
        const heading = element('summary', 'holding-heading'), title = element('span', 'holding-title'), values = element('span', 'holding-value');
        title.append(element('strong', '', group.symbol || short(group.mint)), element('small', '', `${amount(group.balance)} tokens`));
        values.append(element('strong', '', sol(group.valueSol)), element('small', '', `${group.wallets?.length || 0} wallet${group.wallets?.length === 1 ? '' : 's'}`));
        heading.append(title, values); card.append(heading);
        const metrics = element('div', 'holding-metrics');
        metrics.append(element('span', '', `Avg entry${group.basisEstimated ? " (est.)" : ""} ${entry(group)}`));
        const pnl = element('span', '', `PnL ${signedSol(group.pnlSol)}`); tone(pnl, group.pnlSol); metrics.append(pnl);
        // Group averages remain visible before wallet details are expanded.
        heading.append(metrics);
        if (!finite(group.valueSol)) heading.append(element('small', 'holding-price-note', 'Price unavailable')); 
        for (const wallet of group.wallets || []) {
          const row = element('div', 'holding-wallet'), head = element('div', 'position-head');
          head.append(element('strong', '', wallet.walletLabel || short(wallet.wallet)), element('span', '', `${amount(wallet.balance)} tokens`));
          row.title = wallet.wallet; row.append(head);
          const line = element('div', 'holding-wallet-meta'); line.append(element('span', '', `Avg entry${wallet.basisEstimated ? " (est.)" : ""} ${entry(wallet)}`), element('span', '', sol(wallet.valueSol))); row.append(line);
          const profit = element('small', '', `Unrealized ${signedSol(wallet.pnlSol)}`); tone(profit, wallet.pnlSol); row.append(profit);
          if (wallet.pendingSell || pendingWallets.has(`${group.mint}:${wallet.wallet}`)) row.append(element('small', 'positive', 'Selling · awaiting confirmation'));
          card.append(row);
        }
        $('positions').append(card);
        if (focusedMint === group.mint) heading.focus({ preventScroll: true });
      }
    }
    const holdings = [...new Map((status.positions || []).map(p => [p.mint, p])).values()];
    const holdingsKey = JSON.stringify(holdings.map(p => [p.mint, p.symbol]));
    if (holdingsKey !== lastHoldings) {
      lastHoldings = holdingsKey; const previous = $('manual-held-token').value; $('manual-held-token').replaceChildren();
      const option = element('option', '', 'Choose a held token…'); option.value = ''; $('manual-held-token').append(option);
      for (const holding of holdings) { const option = element('option', '', `${holding.symbol || short(holding.mint)} · ${short(holding.mint)}`); option.value = holding.mint; $('manual-held-token').append(option); }
      $('manual-held-token').value = holdings.some(p => p.mint === previous) ? previous : '';
      $('manual-held-token-label').hidden = !holdings.length;
    }
  }
  $('manual-form').onsubmit = submit;
  $('manual-wallet-menu').addEventListener('toggle', () => { if ($('manual-wallet-menu').open && !busy && !uncertain) loadWallets(); });
  $('manual-select-all').onchange = () => { for (const wallet of wallets) $('manual-select-all').checked ? selected.add(wallet.publicKey) : selected.delete(wallet.publicKey); for (const input of $('manual-wallet-list').querySelectorAll('input')) input.checked = selected.has(input.value); controls(); };
  $('manual-held-token').onchange = () => { if ($('manual-held-token').value) $('manual-mint').value = $('manual-held-token').value; };
  $('manual-mint').oninput = () => { if ($('manual-mint').value !== $('manual-held-token').value) $('manual-held-token').value = ''; };
  for (const button of document.querySelectorAll('[data-manual-side]')) button.onclick = () => { side = button.dataset.manualSide; controls(); };
  for (const button of document.querySelectorAll('[data-sell-percent]')) button.onclick = () => { $('manual-sell-percent').value = button.dataset.sellPercent; controls(); };
  $('manual-buy-amount').oninput = controls; $('manual-sell-percent').oninput = controls;
  $('position-details').addEventListener('toggle', () => { $('position-expand-label').textContent = $('position-details').open ? 'Hide positions & wallets' : 'Expand positions & wallets'; });
  controls();
  return {
    controls,
    get busy() { return busy || uncertain; },
    render(status) {
      renderPositions(status);
      if (status.manualResult?.id === request?.trade.id) settleResult(status.manualResult);
      if (status.state !== 'stopped' && status.followers?.length && !busy && !uncertain) {
        const key = currentWalletKey();
        if (key !== walletKey || !initializedWallets) setWallets(status.followers, key);
      }
      controls();
    },
  };
}
