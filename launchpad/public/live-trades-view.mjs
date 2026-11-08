const numeric = value => value !== null && value !== undefined && value !== '' && ['string', 'number'].includes(typeof value) && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const compact = value => { const n = numeric(value); return n === null ? '—' : new Intl.NumberFormat(undefined, n >= 1000 ? { notation: 'compact', maximumFractionDigits: 2 } : { maximumSignificantDigits: 6 }).format(n); };
const usd = value => { const n = numeric(value); return n === null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', ...(n >= 1000 ? { notation: 'compact', maximumFractionDigits: 2 } : { maximumSignificantDigits: 5 }) }).format(n); };
// Trade totals are money amounts: whole cents, compact from $1,000.
const cents = value => { const n = numeric(value); if (n === null) return '—'; if (n > 0 && n < 0.01) return '<$0.01'; return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', ...(n >= 1000 ? { notation: 'compact', maximumFractionDigits: 2 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }).format(n); };
const short = value => typeof value === 'string' && value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-5)}` : value || '—';

export function tradeExplorerUrl(chain, address, type = 'address') {
  if (typeof address !== 'string' || !['address', 'tx'].includes(type)) return null;
  if (chain === 'solana' && (type === 'tx' ? /^[1-9A-HJ-NP-Za-km-z]{80,90}$/ : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/).test(address)) return `https://solscan.io/${type === 'tx' ? 'tx' : 'account'}/${address}`;
  if (chain === 'robinhood' && (type === 'tx' ? /^0x[0-9a-f]{64}$/i : /^0x[0-9a-f]{40}$/i).test(address)) return `https://robinhoodchain.blockscout.com/${type}/${address}`;
  return null;
}

export function tradeAge(at, now = Date.now()) {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0 || at > now + 60000) return '—';
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`;
}

export function updateTradeAges(root, now = Date.now()) {
  for (const cell of root.querySelectorAll('[data-trade-at]')) cell.textContent = tradeAge(Number(cell.dataset.tradeAt), now);
}

export function createLiveTradesView({ document, chain, symbol = 'tokens', data, loading = false, error = '', now = Date.now(), previous = null }) {
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; };
  const root = el('section', null, 'live-trades-view');
  const trades = (Array.isArray(data?.trades) ? data.trades : []).filter(trade => ['buy', 'sell'].includes(trade.side) && tradeExplorerUrl(chain, trade.signature, 'tx'));
  const connectionRequired = data?.connectionRequired === true, unsupported = data?.unsupported === true;
  const indexed = data?.indexed === true || /blockscout|indexed/i.test(data?.source || '');
  const unavailable = !!error || data?.stale === true || data?.unavailable === true || (!indexed && (data?.rpcUnavailable === true || !!(data?.retryAt && data?.warning)));
  const waitingDetails = !trades.length && Number(data?.backlog) > 0;
  const label = connectionRequired ? 'Connection needed' : unsupported ? 'Pool not supported' : unavailable ? trades.length ? 'Feed delayed' : indexed ? 'Index unavailable' : 'RPC unavailable' : loading && !data ? 'Connecting' : waitingDetails ? 'Loading transactions' : trades.length ? indexed ? 'Indexed swaps' : 'Confirmed swaps' : 'No recent swaps';
  const explanation = connectionRequired ? data.warning || 'Save an RPC in Account → Connections to load live swaps.' : unsupported ? data.warning || 'Live swaps are not available for this pool yet.' : unavailable ? error || data?.warning || 'The RPC cannot provide fresh swaps right now. Launchpad will retry automatically.' : data?.warning || (waitingDetails ? 'Transactions were found. Waiting for their confirmed details.' : trades.length ? indexed ? 'Recent indexed swaps; updates may lag chain confirmation.' : 'New confirmed swaps appear automatically.' : loading ? 'Loading confirmed activity for this pool…' : 'The feed is connected and checking for new confirmed swaps.');
  const status = el('div', null, 'live-trades-status'); status.setAttribute('role', 'status');
  status.append(el('span', label, `live-trades-state${connectionRequired || unsupported || unavailable ? ' delayed' : waitingDetails || loading ? ' waiting' : ''}`));
  status.append(el('span', explanation, 'live-trades-message')); root.append(status);
  if (!trades.length) {
    const message = connectionRequired ? 'Add your RPC connection to load the trade feed.' : unsupported ? 'This pool cannot be decoded by the live feed yet. Open the market on DEX Screener to see its activity.' : unavailable ? 'Swap data could not be loaded. This does not mean there are no trades. The feed retries automatically.' : loading && !data ? 'Loading market swaps…' : waitingDetails ? 'Waiting for transaction details. New rows appear after they can be confirmed.' : 'No confirmed swap rows in the current window. New activity appears here automatically.';
    root.append(el('p', message, 'terminal-empty')); return root;
  }
  const scroll = el('div', null, 'table-scroll live-trades-scroll'); scroll.tabIndex = 0; scroll.setAttribute('aria-label', 'Confirmed pool swaps. Scroll horizontally to see all columns.');
  const table = el('table', null, 'terminal-table live-trades-table'), head = el('thead'), heading = el('tr');
  for (const label of ['Age', 'Type', 'FDV (est.)', 'Amount', 'Total USD (est.)', 'Gas', 'Trader']) { const th = el('th', label); th.scope = 'col'; heading.append(th); }
  head.append(heading); table.append(head);
  const body = el('tbody'), seen = new Set(), existing = new Map([...(previous?.querySelectorAll('[data-trade]') || [])].map(row => [row.dataset.trade, row]));
  for (const trade of trades) {
    const key = trade.id || `${trade.signature}:${trade.side}`; if (seen.has(key)) continue; seen.add(key);
    const fingerprint = JSON.stringify([symbol, trade]), retained = existing.get(key);
    if (retained?._tradeFingerprint === fingerprint) { updateTradeAges(retained, now); body.append(retained); continue; }
    const row = el('tr', null, `live-trade-row ${trade.side}`); row.dataset.trade = key; row._tradeFingerprint = fingerprint;
    if (previous && typeof trade.at === 'number' && now - trade.at < 10000 && now >= trade.at) row.classList.add('arriving');
    const age = el('a', tradeAge(trade.at, now), 'live-trade-age'); age.href = tradeExplorerUrl(chain, trade.signature, 'tx'); age.target = '_blank'; age.rel = 'noopener noreferrer';
    if (typeof trade.at === 'number' && Number.isFinite(trade.at) && trade.at > 0) { age.dataset.tradeAt = String(trade.at); age.title = `${new Date(trade.at).toLocaleString()} · View transaction`; }
    const side = el('span', trade.side === 'buy' ? 'Buy' : 'Sell', `live-trade-side ${trade.side === 'buy' ? 'positive' : 'negative'}`);
    const fdv = el('span', usd(trade.fdvUsd)); fdv.title = 'Estimated fully diluted value: total supply × execution price × current quote USD reference. Not historical circulating market cap.';
    const amount = el('div', null, 'live-trade-amount'); amount.append(el('strong', `${compact(trade.tokenAmount)} ${symbol}`)); amount.title = `${trade.tokenAmount ?? 'Unknown'} ${symbol}${trade.amountKind ? ` · ${trade.amountKind}; wallet net amounts can differ after transfer fees.` : ''}`;
    if (numeric(trade.quoteAmount) !== null) amount.append(el('small', `${compact(trade.quoteAmount)} ${trade.quoteSymbol || data.quoteSymbol || 'quote'}`));
    const total = el('span', cents(trade.amountUsd), trade.side === 'buy' ? 'positive' : 'negative'); total.title = 'USD estimate uses the current quote-token USD reference; the onchain quote amount is shown under Amount.';
    const gas = el('div', null, 'live-trade-amount'); gas.append(el('strong', numeric(trade.gasNative) === null ? '—' : `${compact(trade.gasNative)} ${trade.gasSymbol === 'SOL' ? 'SOL' : trade.gasSymbol === 'ETH' ? 'ETH' : ''}`.trim()), el('small', 'Transaction fee'));
    const walletUrl = tradeExplorerUrl(chain, trade.wallet), wallet = el(walletUrl ? 'a' : 'span', short(trade.wallet), 'live-trade-wallet');
    if (walletUrl) { wallet.href = walletUrl; wallet.target = '_blank'; wallet.rel = 'noopener noreferrer'; wallet.title = `${trade.wallet}${trade.walletRole ? ` · ${trade.walletRole}` : ''}`; }
    for (const value of [age, side, fdv, amount, total, gas, wallet]) { const cell = el('td'); cell.append(value); row.append(cell); }
    body.append(row);
  }
  table.append(body); scroll.append(table); root.append(scroll);
  const info=el('details',null,'live-trades-info');info.open=!!previous?.querySelector('.live-trades-info')?.open;info.append(el('summary','About this feed'));
  info.append(el('p',(data?.partial?'Partial history: some swaps may be outside the retrieved window or unsupported by the decoder. ':'')+(indexed?'These swaps come from the explorer index and may arrive after chain confirmation. ':'Confirmed swaps only. ')+'USD totals and FDV use the current quote-token USD reference. Gas is the full transaction fee. Amounts describe pool swaps and can differ from wallet net amounts after transfer fees. Trader links identify the transaction sender or payer, which can be a router or sponsor.', 'live-trades-footnote'));root.append(info);
  return root;
}
