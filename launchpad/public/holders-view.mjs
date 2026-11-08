const number = value => (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) && Number.isFinite(Number(value)) ? Number(value) : null;
const positiveNumber = value => { const result = number(value); return result !== null && result >= 0 ? result : null; };
const short = value => typeof value === 'string' && value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-5)}` : value || '—';
const quantity = value => { const n = positiveNumber(value); return n === null ? '—' : new Intl.NumberFormat(undefined, n >= 1000 ? { notation: 'compact', maximumFractionDigits: 2 } : { maximumSignificantDigits: 6 }).format(n); };
const money = value => { const n = number(value); return n === null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', ...(Math.abs(n) >= 1000 ? { notation: 'compact', maximumFractionDigits: 2 } : { maximumSignificantDigits: 5 }) }).format(n); };
const percent = value => { const n = positiveNumber(value); return n === null ? '—' : n > 0 && n < .01 ? '<0.01%' : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n)}%`; };

export function holderExplorerUrl(chain, address) {
  if (typeof address !== 'string') return null;
  if (chain === 'solana' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return `https://solscan.io/account/${address}`;
  if (chain === 'robinhood' && /^0x[0-9a-f]{40}$/i.test(address)) return `https://robinhoodchain.blockscout.com/address/${address}`;
  return null;
}

// A balance can be marked to the selected pool's current price. Historical
// trades must retain their actual quote units; today's price is never a basis.
export function holderCurrentValue(amount, priceUsd) {
  const balance = positiveNumber(amount), price = positiveNumber(priceUsd);
  if (balance === null || price === null) return null;
  const value = balance * price;
  return Number.isFinite(value) ? value : null;
}

export function createHoldersView({ document, chain, token, symbol = 'tokens', priceUsd = null, data = {}, histories = new Map(), onHistory }) {
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; };
  const rows = Array.isArray(data.rows) ? data.rows : [], root = el('section', null, 'holders-view');
  const summary = el('div', null, 'holders-summary');
  for (const [label, value] of [['Listed holders', String(rows.length)], ['Listed share of supply', percent(data.listedSupplyPercent)], ['Total token supply', quantity(data.supply)]]) {
    const cell = el('div'); cell.append(el('span', label), el('strong', value)); summary.append(cell);
  }
  root.append(summary);
  if (!rows.length) { root.append(el('p', data.warning || 'No holder balances are available from this connection yet.', 'terminal-empty')); return root; }
  const scroll = el('div', null, 'table-scroll holders-scroll'); scroll.tabIndex = 0; scroll.setAttribute('aria-label', 'Holder wallets, percentage of supply, balances and current values.');
  const table = el('table', null, 'terminal-table holders-table'); table.setAttribute('role', 'table');
  table.append(el('caption', `${symbol} holders, ordered by the balances returned by the provider.`, 'holders-caption'));
  const thead = el('thead'), heading = el('tr'); heading.setAttribute('role', 'row');
  for (const title of ['Wallet', '% of supply', 'Balance', 'Value']) { const th = el('th', title); th.scope = 'col'; th.setAttribute('role', 'columnheader'); heading.append(th); }
  thead.append(heading); table.append(thead);
  const body = el('tbody');
  const detail = (primary, secondary, cls = '') => { const cell = el('div', null, `holder-amount ${cls}`.trim()); cell.append(el('strong', primary)); if (secondary) cell.append(el('small', secondary)); return cell; };
  const quoteAmount = (value, quote) => `${quantity(value)} ${quote.symbol || short(quote.mint)}`;
  function trades(history, side) {
    const summary = history[side], quotes = (history.quotes || []).filter(quote => positiveNumber(quote[side]) !== null && Number(quote[side]) > 0);
    if (!summary) return null;
    const amounts = el('div', null, `holder-amount ${side === 'bought' ? 'positive' : 'negative'}`);
    if (number(summary.usd) !== null) amounts.append(el('strong', money(summary.usd)));
    else if (quotes.length) for (const quote of quotes) amounts.append(el('strong', quoteAmount(quote[side], quote)));
    else amounts.append(el('strong', summary.count === 0 ? '0' : '—'));
    amounts.append(el('small', `${quantity(summary.tokens)} ${symbol} · ${quantity(summary.count)} ${summary.count === 1 ? 'swap' : 'swaps'}`));
    return amounts;
  }
  function average(history, field) {
    const values = (history.quotes || []).filter(quote => positiveNumber(quote[field]) !== null);
    if (!values.length) return null;
    const cell = el('div', null, 'holder-amount');
    for (const quote of values) cell.append(el('strong', quoteAmount(quote[field], quote)));
    cell.append(el('small', 'Per token · observed swaps')); return cell;
  }
  for (const [index, row] of rows.entries()) {
    const tr = el('tr', null, 'holder-row'+(index % 2 ? ' striped' : '')); tr.dataset.holder = row.address; tr.setAttribute('role', 'row');
    const state = histories.get(row.address), history = state?.data, wallet = el('div', null, 'holder-wallet');
    const identity = el('div', null, 'holder-identity'), rank = el('span', String(index + 1), 'holder-rank');
    const url = holderExplorerUrl(chain, row.address), address = el(url ? 'a' : 'span', short(row.address), 'holder-address'); address.title = row.address || '';
    if (url) { address.href = url; address.target = '_blank'; address.rel = 'noopener noreferrer'; }
    identity.append(rank, address); wallet.append(identity);
    const role = row.contract ? 'Contract' : row.ownerResolved === false ? 'Token account' : 'Wallet';
    wallet.append(el('small', `${role}${row.balanceCoverage === 'listed-accounts' ? ' · listed accounts' : ''}`, 'holder-kind'));
    const share = positiveNumber(row.supplyPercent), supply = detail(percent(share), null, 'holder-supply');
    supply.firstElementChild.classList.add('holder-share'); supply.title = share === null ? 'Total supply data is unavailable.' : 'Share of total token supply';
    const meter = el('div', null, 'holder-share-meter'), fill = el('span'); meter.setAttribute('aria-hidden', 'true'); fill.style.width = `${share === null ? 0 : Math.min(100, share)}%`; meter.append(fill); supply.append(meter);
    const balance = detail(quantity(row.amount), symbol, 'holder-balance'); balance.title = `${row.amount ?? 'Unknown'} ${symbol}`;
    const amount = detail(money(holderCurrentValue(row.amount, priceUsd)), null, 'holder-remaining holder-value'); amount.title = `${row.amount ?? 'Unknown'} ${symbol}`;
    for (const [label, content] of [['Wallet', wallet], ['% of supply', supply], ['Balance', balance], ['Value', amount]]) { const cell = el('td'); cell.dataset.label = label; cell.setAttribute('role', 'cell'); cell.append(content); tr.append(cell); }
    body.append(tr);
    const canLoad = onHistory && url && row.ownerResolved !== false && data.historyAvailable !== false;
    if (!canLoad && !history && !state?.loading && !state?.error) continue;
    const activity = el('tr', null, 'holder-coverage-row holder-activity-row'), cell = el('td'); cell.colSpan = 4; activity.setAttribute('role', 'row'); cell.setAttribute('role', 'cell');
    activity.hidden = !(state?.expanded ?? !!(state?.loading || history || state?.error));
    const button = el('button', activity.hidden ? 'Show activity' : 'Hide activity', 'text-button holder-history-button'); button.type = 'button'; button.setAttribute('aria-expanded', String(!activity.hidden)); button.setAttribute('aria-label', `Show or hide activity for ${row.address}`);
    button.onclick = () => {
      activity.hidden = !activity.hidden; button.textContent = activity.hidden ? 'Show activity' : 'Hide activity'; button.setAttribute('aria-expanded', String(!activity.hidden)); if (state) state.expanded = !activity.hidden;
      if (!activity.hidden && !history && !state?.loading && canLoad) return onHistory(row.address);
    };
    wallet.append(button);
    const header = el('div', null, 'holder-activity-heading'); header.append(el('strong', 'Observed wallet activity'));
    if (canLoad && (history || state?.error)) { const refresh = el('button', state?.loading ? 'Loading…' : 'Refresh activity', 'text-button holder-activity-refresh'); refresh.type = 'button'; refresh.disabled = !!state?.loading; refresh.onclick = () => onHistory(row.address); header.append(refresh); }
    cell.append(header);
    if (history?.available === true) {
      const metrics = el('div', null, 'holder-activity-metrics');
      for (const [label, value] of [['Bought', trades(history, 'bought')], ['Sold', trades(history, 'sold')], ['Avg. entry', average(history, 'averageEntry')], ['Avg. exit', average(history, 'averageExit')]]) if (value) { const stat = el('div'); stat.append(el('span', label, 'holder-activity-label'), value); metrics.append(stat); }
      const pnl = number(history.pnl?.usd);
      if (pnl !== null) { const stat = el('div'); stat.append(el('span', 'P&L', 'holder-activity-label'), detail(`${pnl > 0 ? '+' : ''}${money(pnl)}`, history.pnl.label || 'Verified cost basis', pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : '')); metrics.append(stat); }
      cell.append(metrics);
    }
    const message = state?.loading ? 'Loading this wallet’s recent activity…' : state?.error || [history?.source, history?.coverage?.note || 'Only retrieved activity is included; this is not a lifetime trading record.'].filter(Boolean).join(' · ');
    cell.append(el('p', message, state?.error ? 'holder-activity-note negative' : 'holder-activity-note'));
    if (history?.coverage?.from && history?.coverage?.to) { const from = new Date(history.coverage.from), to = new Date(history.coverage.to); if (Number.isFinite(from.getTime()) && Number.isFinite(to.getTime())) cell.append(el('p', `${from.toLocaleDateString()}–${to.toLocaleDateString()}`, 'holder-activity-note')); }
    if (history?.transferred) cell.append(el('p', `Transfers in: ${quantity(history.transferred.in)} ${symbol}; out: ${quantity(history.transferred.out)} ${symbol}. Transfers are not classified as trades.`, 'holder-activity-note'));
    activity.append(cell); body.append(activity);
  }
  table.append(body); scroll.append(table); root.append(scroll);
  root.append(el('p', 'Supply percentages use total token supply. Value uses the selected pool’s current USD price. Wallet activity is optional; missing history is never treated as profit or loss.', 'holders-footnote'));
  return root;
}
