import { LAUNCHPAD_ANALYTICS_START_DAY } from './analytics-dates.mjs';
const POLL_MS = 60000;
// The first day of saved trade history, as the notes print it ("September 24, 2026").
const START_LABEL = new Date(LAUNCHPAD_ANALYTICS_START_DAY + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const known = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-US') : '—';
const nativeAmount = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,79})(?:\.[0-9]{1,18})?$/.test(value) ? (() => { const [integer, fraction] = value.split('.'); return BigInt(integer).toLocaleString('en-US') + (fraction ? '.' + fraction : ''); })() : known(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 9 }) : '—';
const dateLabel = at => known(at) && at > 0 && !Number.isNaN(new Date(at).getTime()) ? new Date(at).toLocaleString() : 'unknown';
const states = { available: 'Available', partial: 'Partial history', unavailable: 'Unavailable', unpriced: 'USD price unavailable' };

export function volumeAmount(value, usd = false) {
  if (!known(value)) return '—';
  if (value > 0 && value < (usd ? 0.01 : 0.000001)) return usd ? '<$0.01' : '<0.000001';
  return value.toLocaleString('en-US', usd
    ? { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }
    : { maximumFractionDigits: 6 });
}

export function createAdminVolume({ document, api, getAccount, isActive = () => true, setTimer = setInterval, clearTimer = clearInterval, clock = Date.now }) {
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined && text !== null) node.textContent = String(text); if (cls) node.className = cls; return node; };
  const element = el('section', null, 'admin-card admin-volume'); element.id = 'admin-volume';
  const heading = el('div', null, 'admin-card-heading'), title = el('div'), refresh = el('button', 'Refresh', 'text-button');
  refresh.type = 'button'; refresh.id = 'admin-volume-refresh';
  title.append(el('p', 'PLATFORM / VOLUME', 'eyebrow'), el('h2', 'Token trading volume'), el('p', 'Recorded lifetime and 24-hour volume across Launchpad launches, including hidden and archived coins.'));
  const controls = el('div', null, 'admin-inline-actions'), periods = el('div', null, 'admin-inline-actions admin-segmented cv-segmented'), buttons = new Map(); periods.setAttribute('role', 'group'); periods.setAttribute('aria-label', 'Volume period');
  for (const [key, label] of [['all', 'Lifetime'], ['24h', '24h']]) { const button = el('button', label, 'small-button'); button.type = 'button'; button.dataset.volumePeriod = key; button.setAttribute('aria-pressed', String(key === 'all')); button.onclick = () => { period = key; for (const [value, node] of buttons) node.setAttribute('aria-pressed', String(value === period)); if (snapshot) render(snapshot); }; buttons.set(key, button); periods.append(button); }
  controls.append(refresh, periods); heading.append(title, controls);
  const status = el('p', '', 'admin-volume-status'); status.setAttribute('role', 'status');
  const summary = el('div', null, 'admin-volume-summary'), coverage = el('p', '', 'admin-volume-coverage'), quotes = el('div', null, 'admin-volume-quotes');
  const details = el('details', null, 'admin-volume-details'), detailsTitle = el('summary', 'Volume by coin'), coins = el('div', null, 'admin-revenue-table-wrap');
  details.append(detailsTitle, coins);
  const note = el('p', '', 'admin-muted');
  const more = el('details', null, 'admin-more'); more.append(el('summary', 'More info'), note);
  element.append(heading, status, summary, coverage, quotes, details, more);
  let revision = 0, busy = false, disposed = false, active = false, timer = null, hasData = false, period = 'all', snapshot = null, viewOwner = null, loadedAt = 0;
  const permitted = () => !disposed && getAccount()?.role === 'admin' && getAccount()?.mfaEnabled;
  function stop() { if (timer !== null) { clearTimer(timer); timer = null; } }
  function schedule() {
    stop();
    if (active && isActive() && permitted() && !document.hidden) timer = setTimer(() => { if (isActive() && !document.hidden) void load(); else stop(); }, POLL_MS);
  }
  function clear() {
    revision++; active = false; busy = false; hasData = false; snapshot = null; viewOwner = null; loadedAt = 0; period = 'all'; for (const [key, node] of buttons) node.setAttribute('aria-pressed', String(key === period)); stop();
    summary.replaceChildren(); coins.replaceChildren(); quotes.replaceChildren();
    status.textContent = coverage.textContent = note.textContent = ''; details.open = false;
    details.hidden = true; element.hidden = true; refresh.disabled = false;
  }
  function metric(label, value, caption) {
    const item = el('div', null, 'admin-volume-metric');
    const figure = el('strong', value); figure.dataset.motionNumber = ''; item.append(el('span', label), figure, el('small', caption)); return item;
  }
  function volumeCell(full, observed, usd) {
    const cell = el('td', null, 'num'), value = known(full) ? full : observed;
    cell.append(el('span', volumeAmount(value, usd), 'admin-revenue-amount'));
    if (!known(full) && known(observed)) cell.append(el('small', 'Reported subtotal', 'admin-volume-subtotal'));
    return cell;
  }
  // `numeric` lists the columns holding amounts or counts; they align right.
  function table(labels, numeric = []) {
    const node = el('table', null, 'admin-revenue-table admin-volume-table'), head = el('thead'), row = el('tr'), body = el('tbody');
    for (const [index, label] of labels.entries()) { const cell = el('th', label, numeric.includes(index) ? 'num' : null); cell.scope = 'col'; row.append(cell); }
    head.append(row); node.append(head, body); return { node, body };
  }
  function render24(data) {
    const info = data.coverage || {}, complete = known(data.volumeUsd), sampledComplete = known(data.sampledVolumeUsd), recent = data.lifetime?.last24h;
    const recentValue = known(recent?.recordedVolumeUsdEstimate) ? recent.recordedVolumeUsdEstimate : recent?.pricedVolumeUsdEstimate;
    const recorded = !complete && !sampledComplete && (recent?.historyComplete === true && known(recent.recordedVolumeUsdEstimate) || !known(data.observedVolumeUsd) && !known(data.sampledObservedVolumeUsd) && known(recentValue));
    if (recorded) { renderRecorded24(recent); return; }
    const sampled = !complete && (sampledComplete || !known(data.observedVolumeUsd) && known(data.sampledObservedVolumeUsd)), observed = known(data.observedVolumeUsd);
    const value = complete ? data.volumeUsd : sampled ? sampledComplete ? data.sampledVolumeUsd : data.sampledObservedVolumeUsd : data.observedVolumeUsd;
    const sampleInfo = data.sampling || {};
    const sampleRange = `Source observations: ${dateLabel(sampleInfo.oldestAt)} – ${dateLabel(sampleInfo.newestAt)}.`;
    summary.replaceChildren(
      metric(complete ? '24h volume · USD estimate' : sampled ? sampledComplete ? 'Sampled 24h volume · USD estimate' : 'Sampled 24h subtotal · USD estimate' : 'Reported 24h volume · USD estimate', volumeAmount(value, true), complete ? 'Combined volume for the last 24 hours' : sampled ? 'Separate 24-hour windows observed within the past 15 minutes' : observed ? 'Partial subtotal; missing data is excluded' : 'Waiting for market data'),
      metric(sampled ? 'Coins with complete sampled USD data' : 'Coins with complete USD data', `${count(sampled ? sampleInfo.cachedCoins : info.usdComplete)} / ${count(info.launches)}`, info.inventoryComplete === false ? 'Launch inventory is incomplete' : 'All completed launches on this server'),
    );
    element.dataset.coverage = complete ? 'available' : sampled ? sampledComplete ? 'sampled' : 'partial' : observed ? 'partial' : 'unavailable';
    const gaps = [];
    if (info.partial > 0) gaps.push(`${count(info.partial)} with partial history`);
    if (info.unavailable > 0) gaps.push(`${count(info.unavailable)} unavailable`);
    if (info.unpriced > 0) gaps.push(`${count(info.unpriced)} without a USD price`);
    if (info.inventoryComplete === false) gaps.push('some launch records could not be read');
    coverage.textContent = sampled
      ? `${sampleRange} ${sampledComplete ? 'Complete sampled coverage; the windows are not synchronized.' : 'Partial sampled subtotal; missing volume is not counted as zero.'} Fresh complete USD data: ${count(info.usdComplete)} / ${count(info.launches)} coins.`
      : gaps.length ? 'Coverage: ' + gaps.join(' · ') + '. Missing volume is not counted as zero.' : complete ? 'Complete reported coverage for this snapshot.' : 'Complete volume is unavailable. Missing data is not counted as zero.';
    if (sampled && info.inventoryComplete === false) coverage.textContent += ' Launch inventory is incomplete.';
    quotes.replaceChildren();
    const quoteRows = Array.isArray(data.quoteTotals) ? data.quoteTotals : [];
    if (quoteRows.length) {
      const native = table(['Quote asset', sampled ? 'Sampled 24h bonding-curve volume' : 'Fresh 24h bonding-curve volume', 'Coins', 'Coverage'], [1, 2]);
      for (const quote of quoteRows) {
        const row = el('tr'), identity = el('td', quote.symbol || 'Quote token');
        if (quote.mint) identity.title = String(quote.mint);
        const full = sampled ? quote.sampledVolume24hQuote : quote.volume24hQuote, observed = sampled ? quote.sampledObservedVolumeQuote : quote.observedVolumeQuote;
        const cell = el('td', known(full) ? sampled ? 'Complete sample' : 'Complete' : known(observed) ? 'Recorded subtotal' : 'Unavailable');
        if (sampled && known(quote.sampledAt)) cell.append(el('small', dateLabel(quote.sampledAt), 'admin-volume-coin-meta'));
        row.append(identity, volumeCell(full, observed, false), el('td', count(quote.coins), 'num'), cell); native.body.append(row);
      }
      const wrap = el('div', null, 'admin-revenue-table-wrap'); wrap.append(native.node);
      quotes.append(el('h3', 'Bonding-curve volume by quote asset'), wrap, el('p', 'Quote amounts remain separate by asset. ' + (sampled ? 'Native amounts use the same retained sampling window as the USD headline; missing samples stay unavailable. ' : '') + 'Graduated-pool volume is included only in the USD figures when available.', 'admin-muted'));
    }
    const coinRows = Array.isArray(data.coins) ? data.coins : [];
    details.hidden = !coinRows.length; coins.replaceChildren();
    if (coinRows.length) {
      const breakdown = table(['Coin', 'Paired with', sampled ? 'Sampled 24h volume · USD estimate' : '24h volume · USD estimate', 'Coverage'], [2]);
      for (const coin of coinRows) {
        const row = el('tr'), identity = el('td'), name = el('strong', coin.name || coin.symbol || 'Unnamed coin'), flags = [];
        if (coin.symbol) flags.push(coin.symbol);
        if (coin.hidden) flags.push('Hidden');
        if (coin.archived) flags.push('Archived');
        identity.append(name, el('small', flags.join(' · '), 'admin-volume-coin-meta'));
        if (coin.mint) identity.title = String(coin.mint);
        const state = el('td', sampled ? known(coin.sampledVolume24hUsd) ? 'Complete sample' : 'No complete sample' : states[coin.status] || 'Unavailable');
        const source = sampled ? coin.sampledSource : coin.source;
        if (source) state.append(el('small', String(source), 'admin-volume-coin-meta'));
        if (sampled && known(coin.sampledVolume24hUsd)) state.append(el('small', dateLabel(coin.sampledAt), 'admin-volume-coin-meta'));
        row.append(identity, el('td', coin.quote?.symbol || 'Unknown'), volumeCell(sampled ? coin.sampledVolume24hUsd : coin.volume24hUsd, sampled ? null : coin.observedVolumeUsd, true), state); breakdown.body.append(row);
      }
      coins.append(breakdown.node);
    }
    note.textContent = 'USD figures combine market-reported volume and bonding-curve volume valued at quote-token prices at observation. Select Lifetime for saved cumulative launch-curve trades. ' + (data.note ? String(data.note) : 'Updates every minute while this page is visible.');
    const at = data.at, date = known(at) && at > 0 ? new Date(at) : null;
    status.textContent = (date && !Number.isNaN(date.getTime()) ? 'Updated ' + date.toLocaleString() + '.' : 'Update time unavailable.') + (data.refreshing === true ? ' Market data is updating; coverage will refresh automatically.' : '');
    status.classList.remove('negative'); hasData = true;
  }
  function coverageScope(info) {
    const indexed = Number.isSafeInteger(info?.indexedRecordedPools) && info.indexedRecordedPools > 0;
    return { indexed, included: indexed || info?.postGraduationIncluded === true, pumpswap: !indexed && info?.postGraduationIncluded === true };
  }
  function historicalQuotes(rows, historyComplete, title, amountLabel, scope = {}) {
    quotes.replaceChildren();
    if (rows.length) {
      const native = table(['Quote asset', amountLabel, 'Current USD estimate', 'Coverage'], [1, 2]);
      for (const quote of rows) {
        const row = el('tr'), identity = el('td', quote.symbol || 'Quote asset');
        if (quote.mint) identity.title = String(quote.mint);
        const nativeValue = nativeAmount(quote.amount), knownPositive = typeof quote.amount === 'string' ? /^[0-9.]+$/.test(quote.amount) && /[1-9]/.test(quote.amount) : known(quote.amount) && quote.amount > 0;
        const unavailable = !historyComplete && !knownPositive, nativeCell = el('td', unavailable ? '—' : nativeValue), estimate = unavailable ? null : quote.usdEstimate;
        nativeCell.className = 'admin-revenue-amount num';
        const label = unavailable ? 'History unavailable' : known(estimate) ? historyComplete ? 'Complete' : 'Recorded subtotal' : historyComplete ? 'USD price unavailable' : 'Subtotal · USD unavailable';
        row.append(identity, nativeCell, volumeCell(estimate, null, true), el('td', label)); native.body.append(row);
      }
      const wrap = el('div', null, 'admin-revenue-table-wrap'); wrap.append(native.node); quotes.append(el('h3', title), wrap);
    } else quotes.append(el('p', historyComplete ? (scope.included ? 'No recorded trades yet.' : 'No recorded launch-curve trades yet.') : 'Recorded quote-asset amounts will appear as trade history syncs.', 'admin-muted'));
  }
  function renderRecorded24(recent) {
    const complete = recent.historyComplete === true && known(recent.recordedVolumeUsdEstimate), rawValue = known(recent.recordedVolumeUsdEstimate) ? recent.recordedVolumeUsdEstimate : recent.pricedVolumeUsdEstimate;
    const value = rawValue === 0 && recent.historyComplete !== true ? null : rawValue, rows = Array.isArray(recent.quoteTotals) ? recent.quoteTotals.slice(0, 200) : [];
    const included = recent.postGraduationIncluded === true, kind = included ? 'trading' : 'launch-curve';
    summary.replaceChildren(metric(complete ? `Recorded 24h ${kind} volume · USD estimate` : `Recorded 24h ${kind} subtotal · USD estimate`, volumeAmount(value, true), `Current quote-asset prices · saved ${included ? '' : 'launch-curve '}trades`), metric('Recorded 24h trades', count(recent.tradeCount), recent.historyComplete === true ? `Available 24-hour ${kind} history is synced` : 'Partial trade history'));
    element.dataset.coverage = complete ? 'curve-only' : 'curve-partial';
    coverage.textContent = (included ? 'This fallback uses recorded trades in the past 24 hours, including original Meteora and verified PumpSwap pools for PumpSwap launch mode.' : 'This fallback uses recorded launch-curve trades in the past 24 hours. Post-graduation pools are excluded.') + (complete ? '' : ' History or pricing is partial; missing data is not counted as zero.');
    historicalQuotes(rows, recent.historyComplete === true, 'Recorded 24h volume by quote asset', 'Recorded 24h volume', { included });
    coins.replaceChildren(); details.hidden = true;
    note.textContent = 'Native amounts and USD estimates use the same saved 24-hour trade window. USD values use current quote prices. Lifetime volume remains separate.';
  }
  function renderLifetime(data) {
    const lifetime = data.lifetime || {}, info = lifetime.coverage || {}, rows = Array.isArray(lifetime.quoteTotals) ? lifetime.quoteTotals.slice(0, 200) : [];
    const historyComplete = info.historyComplete === true, priced = known(lifetime.recordedVolumeUsdEstimate), complete = historyComplete && priced, scope = coverageScope(info);
    const scopeCaption = scope.indexed ? 'indexed pools + launch curves' : scope.pumpswap ? 'launch curves + verified PumpSwap pools' : 'launch curves only';
    const rawValue = priced ? lifetime.recordedVolumeUsdEstimate : lifetime.pricedVolumeUsdEstimate, value = rawValue === 0 && !historyComplete ? null : rawValue;
    summary.replaceChildren(
      metric(complete || !known(value) ? 'Recorded lifetime volume · USD estimate' : 'Recorded lifetime subtotal · USD estimate', volumeAmount(value, true), known(value) ? (scope.indexed ? 'Historical pool and current quote-asset prices · ' : 'Current quote-asset prices · ') + scopeCaption : rows.length || lifetime.tradeCount > 0 ? 'USD reference prices are unavailable; native amounts remain below' : lifetime.status === 'loading' || lifetime.refreshing ? 'Historical trades are syncing' : 'Historical volume is not available yet'),
      metric('Launch histories synced', `${count(info.backfilledLaunches)} / ${count(info.launches)}`, `${count(lifetime.tradeCount)} recorded trades · since ${START_LABEL}`),
    );
    element.dataset.coverage = complete ? 'available' : known(value) || rows.length ? 'partial' : 'unavailable';
    const unpriced = rows.filter(row => !known(row.usdEstimate)).length;
    coverage.textContent = (historyComplete ? (scope.included ? 'Available trading history is synced.' : 'Available launch-curve history is synced.') : 'Historical trade sync is incomplete; shown amounts are recorded subtotals.') + (unpriced ? ` ${count(unpriced)} quote assets are awaiting USD prices; their native volume remains included below.` : '') + (info.inventoryComplete === false ? ' Launch inventory is incomplete.' : '') + ' Missing data is not counted as zero.';
    quotes.replaceChildren(); coins.replaceChildren(); details.hidden = true;
    historicalQuotes(rows, historyComplete, 'Lifetime volume by quote asset', 'Recorded lifetime volume', scope);
    note.textContent = (scope.indexed ? `Saved, deduplicated trades from ${START_LABEL} onward, plus indexed pool history before and after graduation. Overlapping pool and saved-trade records count once. Indexed pool volume uses historical USD values; remaining saved quote amounts use current prices.` : scope.pumpswap ? `Saved, deduplicated trades from ${START_LABEL} onward. PumpSwap launch mode includes its original Meteora pool and verified PumpSwap pool; other launch modes retain limited pool coverage. USD estimates use current quote prices, not historical prices.` : `Saved, deduplicated launch-curve trades from ${START_LABEL} onward. Post-graduation pools are excluded. USD estimates use current quote prices, not historical prices.`) + ' Lifetime totals are never calculated by adding overlapping 24-hour windows.' + (known(lifetime.updatedAt) ? ' History updated ' + dateLabel(lifetime.updatedAt) + '.' : '');
  }
  function render(data) {
    snapshot = data; element.dataset.period = period; detailsTitle.textContent = '24h market volume by coin';
    if (period === 'all') renderLifetime(data); else render24(data);
    status.textContent = (known(data.at) && data.at > 0 ? 'Updated ' + dateLabel(data.at) + '.' : 'Update time unavailable.') + (data.refreshing === true || period === 'all' && data.lifetime?.refreshing === true ? ' Data is updating; coverage will refresh automatically.' : '');
    status.classList.remove('negative'); hasData = true;
  }
  async function load() {
    if (!permitted()) { clear(); return; }
    if (!isActive()) { stop(); return; }
    const owner = getAccount()?.id; if (viewOwner !== null && viewOwner !== owner) clear(); viewOwner = owner; active = true;
    if (document.hidden) { schedule(); return; }
    if (busy) return;
    busy = true; refresh.disabled = true; element.hidden = false;
    const generation = revision, accountId = getAccount()?.id;
    const current = () => permitted() && generation === revision && accountId === getAccount()?.id;
    if (!hasData) status.textContent = 'Loading trading volume…';
    try { const data = await api('/api/admin/volume'); if (current()) { render(data); loadedAt = clock(); } }
    catch { if (current()) { status.textContent = hasData ? 'Volume could not be refreshed. Showing the previous snapshot.' : 'Volume is temporarily unavailable. Use Refresh to try again.'; status.classList.add('negative'); } }
    finally {
      if (generation === revision) {
        if (!current()) clear();
        else { busy = false; refresh.disabled = false; schedule(); }
      }
    }
  }
  function pause() { active = false; stop(); }
  // Opening the page again reuses volume younger than one poll interval and only restarts polling.
  function show() { if (permitted() && isActive() && hasData && viewOwner === getAccount()?.id && clock() - loadedAt < POLL_MS) { active = true; schedule(); return; } return load(); }
  function visibility() { if (document.hidden || !isActive()) stop(); else if (active && permitted()) void load(); }
  function destroy() { clear(); disposed = true; document.removeEventListener('visibilitychange', visibility); }
  refresh.onclick = load; document.addEventListener('visibilitychange', visibility); clear();
  return { element, load, show, clear, pause, destroy };
}
