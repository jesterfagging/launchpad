import { LAUNCHPAD_ANALYTICS_START_DAY } from './analytics-dates.mjs';
import { burnTokenAmount, burnedUsdDisplay } from './burn-valuation.mjs';
import { OFFICIAL_TOKEN_MINT } from './coin-image.mjs';

const POLL_MS = 30000, MIN_POLL_MS = 10000, REQUEST_MS = 20000, STALE_MS = 120000, BURN_SUPPLY_STALE_MS = 60000;
// Failed, timed-out and aborted loads retry quickly first, then back off.
// A server Retry-After (rate limit or restart) is always honoured.
const RETRY_MS = [2000, 5000, 10000, 20000, 30000, 60000], MAX_RETRY_AFTER_MS = 300000;
const known = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const rowsOf = value => Array.isArray(value) ? value.filter(row => row && typeof row === 'object' && !Array.isArray(row)) : [];
export function analyticsRetryDelay(failures, retryAfterMs = 0) {
  const step = RETRY_MS[Math.min(RETRY_MS.length, Math.max(1, Math.floor(failures) || 1)) - 1];
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(step, Number.isFinite(retryAfterMs) ? retryAfterMs : 0));
}
function retryAfter(response) {
  let header = null; try { header = response?.headers?.get?.('retry-after'); } catch {}
  if (typeof header !== 'string' || !header.trim()) return 0;
  if (/^\d{1,6}$/.test(header.trim())) return Number(header.trim()) * 1000;
  const at = Date.parse(header); return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}
// Server-relative clock offset. Freshness thresholds are a few seconds to two
// minutes, so a visitor clock that is merely a few seconds behind (or minutes
// ahead) must not turn a current server snapshot into "unavailable"/"stale".
export function analyticsClockOffset(data, response, receivedAt, previous = 0) {
  if (Number.isSafeInteger(data?.servedAt) && data.servedAt > 0 && Number.isFinite(receivedAt)) return data.servedAt - receivedAt;
  let header = null; try { header = response?.headers?.get?.('date'); } catch {}
  const parsed = typeof header === 'string' ? Date.parse(header) : NaN;
  if (!Number.isFinite(parsed) || !Number.isFinite(receivedAt)) return previous;
  // HTTP dates have one-second resolution; ignore offsets inside that noise.
  const offset = Math.round(parsed + 500 - receivedAt);
  return Math.abs(offset) > 2000 ? offset : 0;
}
const whole = value => Number.isSafeInteger(value) && value >= 0;
const count = value => whole(value) ? value.toLocaleString('en-US') : '—';
const validDate = value => typeof value === 'number' && value > 0 && !Number.isNaN(new Date(value).getTime());
const dateLabel = value => validDate(value) ? new Date(value).toLocaleString() : 'Unavailable';
const signature = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value);
const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z'));
const dayLabel = (date, year = false) => new Date(date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' });
const utcDay = ms => new Date(ms).toISOString().slice(0, 10);
const rawUint = value => typeof value === 'string' && /^(0|[1-9]\d{0,79})$/.test(value);
const NS = 'http://www.w3.org/2000/svg';
// Launch venues keep a fixed colour slot each (identity never follows rank).
const VENUES = [['raydium', 'Raydium'], ['meteora', 'Meteora'], ['damm-pump', 'PumpSwap'], ['pump-classic', 'Pump.fun']];

export function analyticsUsd(value) {
  if (!known(value)) return '—';
  if (value > 0 && value < 0.01) return '<$0.01';
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

// Raw receipt amounts remain integers until display, including amounts beyond
// JavaScript's safe-integer range. Unknown decimals never imply zero decimals.
export function analyticsRaw(value, decimals) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,79})$/.test(value) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) return '—';
  const raw = BigInt(value), scale = 10n ** BigInt(decimals), integer = raw / scale;
  const places = Math.min(decimals, 6), remainder = (raw % scale).toString().padStart(decimals, '0').slice(0, places).replace(/0+$/, '');
  if (raw > 0n && integer === 0n && !remainder) return '<0.000001';
  return integer.toLocaleString('en-US') + (remainder ? '.' + remainder : '');
}

// Axis and direct-label formats: short, never "$0.00" (a dash is the only way
// an unknown amount is shown; zero prints as a plain zero).
export function analyticsCompact(value, { currency = false } = {}) {
  if (!known(value)) return '—';
  const prefix = currency ? '$' : '';
  if (value >= 1e9) return prefix + trim(value / 1e9) + 'B';
  if (value >= 1e6) return prefix + trim(value / 1e6) + 'M';
  if (value >= 1e3) return prefix + trim(value / 1e3) + 'K';
  if (Number.isInteger(value)) return prefix + value.toLocaleString('en-US');
  return prefix + trim(value);
  function trim(number) { return (number >= 100 ? number.toFixed(0) : number >= 10 ? number.toFixed(1) : number.toFixed(2)).replace(/\.0+$|(\.\d*[1-9])0+$/, '$1'); }
}
// Clean axis ticks: 0 … a 1/2/2.5/5 × 10^n step that covers the maximum.
export function analyticsTicks(maximum, steps = 4, integer = false) {
  if (!known(maximum) || maximum === 0) return { max: integer ? 4 : 1, ticks: integer ? [0, 1, 2, 3, 4] : [0, .25, .5, .75, 1] };
  const rough = maximum / steps, magnitude = 10 ** Math.floor(Math.log10(rough)), unit = rough / magnitude;
  let step = (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10) * magnitude;
  if (integer) step = Math.max(1, Math.round(step));
  const max = Number((Math.ceil(maximum / step - 1e-9) * step).toPrecision(12)), ticks = [];
  for (let value = 0; value <= max + step / 2; value += step) ticks.push(Number(value.toPrecision(12)));
  return { max, ticks };
}
// Change between the latest window of complete days and the window before it.
// Null when either window is incomplete or the earlier one is zero.
export function analyticsWindowDelta(values, window = 7) {
  const points = values.filter(value => known(value));
  if (points.length !== values.length) return null;
  const size = Math.min(window, Math.floor(points.length / 2));
  if (size < 2) return null;
  const current = points.slice(-size).reduce((sum, value) => sum + value, 0), previous = points.slice(-size * 2, -size).reduce((sum, value) => sum + value, 0);
  if (previous <= 0) return null;
  return { days: size, current, previous, percent: (current - previous) / previous * 100 };
}

function burnSupplySummary(supply, now) {
  const raw = value => typeof value === 'string' && /^(0|[1-9]\d{0,79})$/.test(value);
  if (!['available', 'stale'].includes(supply?.status) || supply.mint !== OFFICIAL_TOKEN_MINT || supply.decimals !== 6 || supply.originalSupply !== '1000000000000000' || !raw(supply.currentSupply) || !raw(supply.totalBurned) || supply.source !== 'finalized-mint-supply' || supply.commitment !== 'finalized' || !whole(supply.slot) || supply.slot === 0 || !validDate(supply.at) || supply.at > now + 5000) return null;
  const original = BigInt(supply.originalSupply), current = BigInt(supply.currentSupply), burned = BigInt(supply.totalBurned);
  if (current > original || burned !== original - current) return null;
  // Round directly from raw supply, avoiding integer-percent rounding or a
  // second rounding of the API's two-decimal percentage.
  const tenths = (burned * 1000n + original / 2n) / original;
  return { ...supply, percent: `${tenths / 10n}.${tenths % 10n}%`, fraction: Number(tenths) / 1000, stale: supply.status === 'stale' || now - supply.at > BURN_SUPPLY_STALE_MS };
}

export function createPublicAnalytics({ document, window = document.defaultView, fetcher = globalThis.fetch, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = String(text); if (cls) node.className = cls; return node; };
  const shape = (tag, attrs, text) => { const node = document.createElementNS(NS, tag); for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value)); if (text != null) node.textContent = String(text); return node; };
  const root = document.getElementById('analytics-main');
  if (!root) throw new Error('Analytics container missing.');
  // ---- Hero and toolbar ----
  const hero = el('div', null, 'analytics-hero'), heroText = el('div', null, 'analytics-hero-text'), heroSide = el('div', null, 'analytics-hero-side');
  heroText.append(el('p', 'LAUNCHPAD / IN NUMBERS', 'eyebrow'), el('h1', 'Protocol analytics'), el('p', 'Follow the launches, trading activity, and holder rewards behind Launchpad.', 'analytics-intro'));
  const live = el('span', null, 'analytics-live'), liveDot = el('i'); liveDot.dataset.motionLive = ''; liveDot.setAttribute('aria-hidden', 'true');
  live.append(liveDot, el('span', 'Burn supply checks every 30 seconds'));
  const art = el('div', null, 'analytics-hero-art'); art.setAttribute('aria-hidden', 'true'); art.dataset.motionFloat = 'slow';
  heroSide.append(art, live); hero.append(heroText, heroSide);
  const toolbar = el('div', null, 'analytics-toolbar'), periods = el('div', null, 'analytics-periods cv-segmented');
  periods.setAttribute('role', 'group'); periods.setAttribute('aria-label', 'Statistics period');
  const buttons = new Map();
  for (const [key, label] of [['24h', '24h'], ['all', 'All time']]) {
    const button = el('button', label); button.type = 'button'; button.dataset.period = key;
    button.setAttribute('aria-pressed', String(key === 'all'));
    button.onclick = () => { period = key; for (const [id, node] of buttons) node.setAttribute('aria-pressed', String(id === period)); section(renderHeadline, snapshot); };
    buttons.set(key, button); periods.append(button);
  }
  const updated = el('div', null, 'analytics-updated'), updatedTime = el('span', 'Waiting for the first update'), refresh = el('button', 'Refresh', 'small-button analytics-refresh');
  refresh.type = 'button'; refresh.setAttribute('aria-label', 'Refresh analytics'); updated.append(updatedTime, refresh); toolbar.append(periods, updated);
  const message = el('p', 'Warming up the curve…', 'analytics-message'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
  // ---- Headline tiles ----
  const metrics = el('section', null, 'analytics-metrics'); metrics.setAttribute('aria-label', 'Protocol statistics');
  const windowNote = el('p', '', 'analytics-window-note');
  const marketVolume = el('section', null, 'analytics-market-volume'), marketText = el('div'), marketCaption = el('p', '', 'analytics-market-caption'), marketAmount = el('div', null, 'analytics-market-amount'), marketValue = el('strong', '—', 'analytics-metric-value');
  marketVolume.setAttribute('aria-label', '24h market volume'); marketVolume.dataset.analyticsMetric = 'market-volume-usd';
  const marketTitle = el('h2'), marketDot = el('i'); marketDot.dataset.motionLive = ''; marketDot.setAttribute('aria-hidden', 'true'); marketTitle.append(marketDot, el('span', '24h market volume'));
  marketText.append(marketTitle, marketCaption); marketAmount.append(marketValue); marketVolume.append(marketText, marketAmount);
  const setText = (node, text) => { text = String(text); if (node.textContent !== text) node.textContent = text; };
  // Metric cards are kept while they show the same metric, so a refresh only
  // rewrites text that changed. The shared motion layer (curve-motion.mjs)
  // then counts a first value up from its dash and flashes genuine changes,
  // instead of seeing a brand-new card on every poll. A card whose meaning
  // changes (the 24h / all-time switch) is a new card, so one metric is never
  // tweened into another. With a unit, the digits sit in their own element:
  // a count-up rewrites only that element and never removes the unit label.
  // The optional trend slot (sparkline, delta or meter) sits after the caption.
  function metricCard(unit) {
    const item = el('div', null, 'analytics-metric'), heading = el('h3', '', 'analytics-metric-label'), amount = el('strong', unit ? null : '—', 'analytics-metric-value'), caption = el('small', '', 'analytics-metric-caption'), trend = el('div', null, 'analytics-metric-trend');
    let number = amount;
    if (unit) { number = el('span', '—'); number.dataset.motionNumber = ''; amount.append(number, el('span', unit, 'analytics-unit')); }
    trend.hidden = true; item.append(heading, amount, caption, trend);
    return { item, heading, amount, number, caption, trend, trendKey: null, unit: unit || '', text: '—', width: null };
  }
  function updateCard(card, label, value, caption, extra = null) {
    const text = String(value);
    setText(card.heading, label); setText(card.caption, caption);
    // Do not rewrite digits mid count-up unless the value itself changed.
    if (card.text !== text || !card.number.classList.contains('motion-counting') && card.number.textContent !== text) { card.text = text; card.number.textContent = text; }
    // Keep full currency values legible within their card without truncating digits.
    const width = String(Math.max(1, text.length * .66));
    if (card.width !== width) { card.width = width; card.amount.style.setProperty('--analytics-value-width', width); }
    renderTrend(card, extra);
    return card.item;
  }
  // entries: [key, label, value, caption, unit?, extra?]. Cards not shown are dropped.
  function metricGroup(container) {
    let cards = new Map();
    return entries => {
      const next = new Map(), nodes = [];
      for (const [key, label, value, caption, unit, extra] of entries) {
        let card = cards.get(key);
        if (!card || card.unit !== (unit || '')) card = metricCard(unit);
        next.set(key, card); nodes.push(updateCard(card, label, value, caption, extra));
      }
      cards = next;
      const current = [...container.children];
      if (current.length !== nodes.length || current.some((node, index) => node !== nodes[index])) container.replaceChildren(...nodes);
      return nodes;
    };
  }
  // ---- Trend slot: sparkline + delta, or a meter ----
  function sparkline(values, { window: span = 7 } = {}) {
    const width = 132, height = 36, pad = 4, points = values.map(value => known(value) ? value : 0), max = Math.max(1e-9, ...points), min = 0;
    const svg = shape('svg', { class: 'analytics-spark', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' });
    const xy = (value, index) => [pad + index * (width - pad * 2) / Math.max(1, points.length - 1), height - pad - (value - min) / (max - min || 1) * (height - pad * 2)];
    const path = points.map((value, index) => (index ? 'L' : 'M') + xy(value, index).map(n => n.toFixed(1)).join(' ')).join(' ');
    const first = Math.max(0, points.length - span);
    const current = points.slice(first).map((value, index) => (index ? 'L' : 'M') + xy(value, first + index).map(n => n.toFixed(1)).join(' ')).join(' ');
    const [endX, endY] = xy(points.at(-1), points.length - 1);
    svg.append(shape('path', { class: 'spark-base', d: path, 'vector-effect': 'non-scaling-stroke' }), shape('path', { class: 'spark-current', d: current, 'vector-effect': 'non-scaling-stroke' }), shape('circle', { class: 'spark-end', cx: endX.toFixed(1), cy: endY.toFixed(1), r: 3.5, 'vector-effect': 'non-scaling-stroke' }));
    return svg;
  }
  function renderTrend(card, extra) {
    let key; try { key = JSON.stringify(extra); } catch { key = null; }
    if (card.trendKey === key) return;
    card.trendKey = key; card.trend.replaceChildren(); card.trend.hidden = true;
    if (!extra) return;
    if (extra.meter) {
      const meter = el('div', null, 'analytics-meter'), fill = el('div', null, 'analytics-meter-fill');
      meter.dataset.motionBar = ''; meter.setAttribute('role', 'img'); meter.setAttribute('aria-label', extra.meter.label);
      meter.style.setProperty('--value', String(Math.min(1, Math.max(0, extra.meter.fraction))));
      meter.append(fill); card.trend.append(meter, el('span', extra.meter.label, 'analytics-meter-label'));
      card.trend.hidden = false; return;
    }
    if (Array.isArray(extra.series) && extra.series.filter(known).length >= 3) card.trend.append(sparkline(extra.series, { window: extra.delta?.days || 7 }));
    if (extra.delta) {
      const delta = el('span', null, 'analytics-delta'), direction = Math.abs(extra.delta.percent) < .5 ? 'flat' : extra.delta.percent > 0 ? 'up' : 'down';
      delta.dataset.direction = direction;
      const percent = Math.abs(extra.delta.percent) >= 1000 ? '>999' : Math.abs(extra.delta.percent).toFixed(Math.abs(extra.delta.percent) >= 10 ? 0 : 1);
      delta.append(el('b', (direction === 'down' ? '−' : direction === 'up' ? '+' : '±') + percent + '%'), el('span', extra.delta.label || `last ${extra.delta.days}d vs the ${extra.delta.days}d before`));
      card.trend.append(delta);
    }
    card.trend.hidden = !card.trend.childElementCount;
  }
  // ---- Charts ----
  // A bar chart (single or stacked) with gridlines, axes, a hover/focus tooltip
  // listing every series, a legend for two or more series, selective direct
  // labels and an animated draw-in. Unknown values draw nothing (never a zero);
  // partial days are dimmed and say so in the tooltip. The host element stays
  // put across polls, so hover state survives a routine refresh.
  const charts = new Set();
  function chartHost(className) { const host = el('div', null, 'analytics-plot ' + className); host.dataset.chart = className; charts.add(host); return host; }
  // A Gotchi peeks into an empty chart (never while loading). The character is
  // destroyed when the chart renders data, so nothing lingers.
  function peekInto(host, empty, theme) {
    const motion = window?.curveMotion;
    if (typeof motion?.peek !== 'function') return;
    try { const pending = Promise.resolve(motion.peek(empty, { theme, side: 'right', height: 84 })); pending.catch(() => {}); host.peekPending = pending; } catch {}
  }
  function renderChart(host, spec) {
    host.spec = spec; host.renderedWidth = Math.round(host.clientWidth || 0); host.replaceChildren();
    if (host.peekPending) { host.peekPending.then(result => result?.remove?.()).catch(() => {}); host.peekPending = null; }
    const { series, days } = spec, hasKnown = days.some(day => day.values.some(known));
    if (spec.loading) {
      const skeleton = el('div', null, 'analytics-empty is-loading'); skeleton.dataset.motionShimmer = ''; skeleton.setAttribute('aria-busy', 'true');
      const bars = el('div', null, 'analytics-skeleton-bars'); for (const height of [38, 62, 46, 80, 58, 70, 44, 66]) { const bar = el('i', null, 'skeleton'); bar.style.setProperty('--h', height + '%'); bars.append(bar); }
      skeleton.append(bars, el('p', spec.emptyText || 'Warming up the curve…')); host.append(skeleton); return;
    }
    if (!days.length || !hasKnown) {
      const empty = el('div', null, 'analytics-empty'); empty.append(el('p', spec.emptyText || 'Nothing recorded yet.'));
      host.append(empty); peekInto(host, empty, spec.theme); return;
    }
    const width = Math.max(280, Math.round(host.clientWidth || 0) || 640), height = width < 480 ? 220 : 260;
    const left = spec.axisWidth || 52, right = 14, top = 20, bottom = 30, plotW = width - left - right, plotH = height - top - bottom;
    const totals = days.map(day => day.values.reduce((sum, value) => sum + (known(value) ? value : 0), 0));
    const { max, ticks } = analyticsTicks(Math.max(0, ...totals), 4, spec.integer === true);
    const id = 'analytics-chart-' + spec.id;
    const svg = shape('svg', { class: 'analytics-chart ' + (series.length > 1 ? 'is-stacked ' : 'is-single ') + (spec.className || ''), viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img', tabindex: 0, 'aria-labelledby': `${id}-title ${id}-desc` });
    svg.append(shape('title', { id: id + '-title' }, spec.title), shape('desc', { id: id + '-desc' }, spec.desc + ' Focus the chart and use the arrow keys to read each day.'));
    const y = value => top + plotH - Math.min(1, value / max) * plotH;
    for (const tick of ticks) {
      svg.append(shape('line', { x1: left, x2: width - right, y1: y(tick).toFixed(1), y2: y(tick).toFixed(1), class: tick === 0 ? 'axis-line' : 'grid-line' }));
      svg.append(shape('text', { x: left - 10, y: (y(tick) + 4).toFixed(1), 'text-anchor': 'end', class: 'axis-y' }, spec.formatAxis(tick)));
    }
    const band = plotW / days.length, barW = Math.max(3, Math.min(24, band - Math.max(3, band * .34))), stacked = series.length > 1, last = days.length - 1;
    const columns = [];
    days.forEach((day, index) => {
      const x0 = left + index * band + (band - barW) / 2, x1 = x0 + barW, column = shape('g', { class: 'analytics-col', 'data-col': index });
      let cursor = top + plotH, topMost = -1;
      for (let s = series.length - 1; s >= 0; s--) if (known(day.values[s]) && day.values[s] > 0) { topMost = s; break; }
      series.forEach((item, s) => {
        const value = day.values[s];
        if (!known(value) || value <= 0 || max <= 0) return;
        const full = value / max * plotH, gap = s === topMost ? 0 : Math.min(2, full), heightPx = Math.max(.5, full - gap), yTop = cursor - full, yBottom = cursor - gap;
        const r = s === topMost ? Math.min(4, barW / 2, heightPx / 2) : 0;
        const d = r > 0
          ? `M${x0.toFixed(2)} ${yBottom.toFixed(2)}V${(yTop + r).toFixed(2)}Q${x0.toFixed(2)} ${yTop.toFixed(2)} ${(x0 + r).toFixed(2)} ${yTop.toFixed(2)}H${(x1 - r).toFixed(2)}Q${x1.toFixed(2)} ${yTop.toFixed(2)} ${x1.toFixed(2)} ${(yTop + r).toFixed(2)}V${yBottom.toFixed(2)}Z`
          : `M${x0.toFixed(2)} ${yBottom.toFixed(2)}V${yTop.toFixed(2)}H${x1.toFixed(2)}V${yBottom.toFixed(2)}Z`;
        const bar = shape('path', { d, class: `bar s${s + 1}${index === last && !stacked ? ' is-latest' : ''}${day.partial ? ' is-partial' : ''}` });
        bar.style.setProperty('--i', String(index));
        bar.append(shape('title', {}, `${dayLabel(day.date, true)}: ${spec.formatValue(value)} ${item.label}${day.partial ? ' (partial)' : ''}`));
        column.append(bar); cursor -= full;
      });
      // The whole column is the hover target, not just the painted bar.
      const hit = shape('rect', { x: (left + index * band).toFixed(2), y: top, width: band.toFixed(2), height: plotH, class: 'hit', 'data-col': index });
      column.append(hit); svg.append(column); columns.push(column);
    });
    // Selective direct label: the latest column's total on its cap.
    if (known(totals[last]) && totals[last] > 0 && days[last].values.some(known)) svg.append(shape('text', { x: (left + last * band + band / 2).toFixed(2), y: (y(totals[last]) - 7).toFixed(1), 'text-anchor': 'middle', class: 'bar-label' }, spec.formatAxis(totals[last])));
    const labelAt = new Set([0, last]), step = Math.ceil(days.length / 5);
    for (let index = step; index < last - step / 2; index += step) labelAt.add(index);
    for (const index of labelAt) svg.append(shape('text', { x: (left + index * band + band / 2).toFixed(2), y: height - 8, 'text-anchor': index === 0 ? 'start' : index === last ? 'end' : 'middle', class: 'axis-x' }, dayLabel(days[index].date)));
    host.append(svg);
    if (stacked) {
      const legend = el('div', null, 'analytics-legend');
      series.forEach((item, s) => { const entry = el('span', null, 'analytics-legend-item'); const swatch = el('i', null, 'swatch s' + (s + 1)); swatch.setAttribute('aria-hidden', 'true'); entry.append(swatch, el('span', item.label)); legend.append(entry); });
      host.append(legend);
    }
    const tip = el('div', null, 'analytics-tip'); tip.hidden = true; tip.setAttribute('aria-hidden', 'true'); host.append(tip);
    let shown = -1;
    const show = index => {
      const day = days[index]; if (!day) return;
      if (shown >= 0 && shown !== index) columns[shown].classList.remove('is-hover');
      shown = index; columns[index].classList.add('is-hover'); tip.replaceChildren(el('strong', dayLabel(day.date, true)));
      series.forEach((item, s) => { const row = el('span', null, 'analytics-tip-row'), swatch = el('i', null, 'key s' + (s + 1)); row.append(swatch, el('b', known(day.values[s]) ? spec.formatValue(day.values[s]) : '—'), el('span', item.label)); tip.append(row); });
      if (day.note) tip.append(el('span', day.note, 'analytics-tip-note'));
      const centre = (left + index * band + band / 2) / width * 100, peak = Math.max(0, (y(totals[index]) / height) * 100);
      tip.style.setProperty('--tip-x', centre.toFixed(2) + '%'); tip.style.setProperty('--tip-y', peak.toFixed(2) + '%'); tip.dataset.side = centre > 66 ? 'left' : centre < 34 ? 'right' : 'center';
      tip.hidden = false;
    };
    const hide = () => { if (shown >= 0) columns[shown].classList.remove('is-hover'); shown = -1; tip.hidden = true; };
    const indexOf = target => { const hit = target?.closest?.('.hit'); return hit ? Number(hit.dataset.col) : -1; };
    svg.addEventListener('pointerover', event => { const index = indexOf(event.target); if (index >= 0) show(index); });
    svg.addEventListener('pointerout', event => { if (!svg.contains(event.relatedTarget)) hide(); else if (indexOf(event.relatedTarget) < 0) hide(); });
    // Keyboard: one tab stop per chart; arrow keys walk the days, Escape hides.
    svg.addEventListener('focus', () => show(shown >= 0 ? shown : last));
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', event => {
      const moves = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity };
      if (event.key === 'Escape') { hide(); return; }
      if (!(event.key in moves)) return;
      event.preventDefault();
      const next = moves[event.key] === -Infinity ? 0 : moves[event.key] === Infinity ? last : Math.min(last, Math.max(0, (shown >= 0 ? shown : last) + moves[event.key]));
      show(next);
    });
  }
  // Re-render charts at their new width when the layout changes (no scroll work).
  let resizeQueued = false;
  const resizer = typeof window?.ResizeObserver === 'function' ? new window.ResizeObserver(() => {
    if (resizeQueued) return; resizeQueued = true;
    (window.requestAnimationFrame || (fn => setTimeout(fn, 16)))(() => {
      resizeQueued = false;
      for (const host of charts) { const spec = host.spec, width = Math.round(host.clientWidth || 0); if (spec && width && Math.abs(width - (host.renderedWidth || 0)) > 8) { host.renderedWidth = width; renderChart(host, spec); } }
    });
  }) : null;
  function mountChart(host) { if (resizer) resizer.observe(host); return host; }
  // Part-to-whole: one horizontal stacked bar (top four shares and "Other").
  function renderShare(host, rows, { formatValue }) {
    host.replaceChildren();
    const shares = rows.filter(row => known(row.value) && row.value > 0).sort((a, b) => b.value - a.value);
    const total = shares.reduce((sum, row) => sum + row.value, 0);
    if (!shares.length || total <= 0) { host.hidden = true; return; }
    host.hidden = false;
    const head = shares.slice(0, 4), rest = shares.slice(4), parts = rest.length ? [...head, { label: 'Other', value: rest.reduce((sum, row) => sum + row.value, 0) }] : head;
    const bar = el('div', null, 'analytics-share-bar'); bar.setAttribute('role', 'img'); bar.setAttribute('aria-label', parts.map(part => `${part.label} ${(part.value / total * 100).toFixed(1)}%`).join(', '));
    const legend = el('ul', null, 'analytics-share-legend');
    parts.forEach((part, index) => {
      const segment = el('span', null, 'analytics-share-seg s' + (index + 1)); segment.style.setProperty('--share', (part.value / total).toFixed(4)); segment.style.setProperty('--i', String(index));
      segment.title = `${part.label}: ${formatValue(part.value)} (${(part.value / total * 100).toFixed(1)}%)`; bar.append(segment);
      const item = el('li', null, 'analytics-share-item'), swatch = el('i', null, 'swatch s' + (index + 1)); swatch.setAttribute('aria-hidden', 'true');
      item.append(swatch, el('span', part.label), el('b', (part.value / total * 100).toFixed(1) + '%'), el('small', formatValue(part.value))); legend.append(item);
    });
    host.append(bar, legend);
  }
  function sectionHead(title, description, badge) {
    const header = el('div', null, 'analytics-section-head'), group = el('div'); group.append(el('h2', title)); if (description) group.append(el('p', description)); header.append(group); if (badge) header.append(el('span', badge, 'analytics-alltime')); return header;
  }
  // ---- Volume and launches charts ----
  const chartsRow = el('div', null, 'analytics-charts');
  const volumeCard = el('section', null, 'analytics-card cv-card analytics-volume-card'), volumeHost = mountChart(chartHost('analytics-volume-plot')), volumeCaption = el('p', '', 'analytics-chart-caption');
  volumeCard.setAttribute('aria-label', 'Trading volume by day');
  const volumeDetails = el('details', null, 'analytics-data-details'), volumeTable = el('div', null, 'analytics-table-wrap'); volumeDetails.append(el('summary', 'View daily volume'), volumeTable);
  volumeCard.append(sectionHead('Trading volume', 'Recorded quote amounts by UTC day · up to 30 days'), volumeHost, volumeCaption, volumeDetails);
  const chartCard = el('section', null, 'analytics-card cv-card analytics-chart-wrap'), chartContainer = mountChart(chartHost('analytics-launch-plot')), chartCaption = el('p', '', 'analytics-chart-caption');
  chartCard.setAttribute('aria-label', 'Token launches by day');
  chartCard.append(sectionHead('Token launches', 'Daily launches · up to 30 days · UTC'), chartContainer, chartCaption);
  const chartDetails = el('details', null, 'analytics-data-details'), chartTable = el('div', null, 'analytics-table-wrap'); chartDetails.append(el('summary', 'View daily numbers'), chartTable); chartCard.append(chartDetails);
  chartsRow.append(volumeCard, chartCard);
  // ---- Buybacks & burns ----
  const treasury = el('section', null, 'analytics-card cv-card analytics-treasury'); treasury.setAttribute('aria-label', 'Protocol buybacks and burns');
  const treasuryMetrics = el('div', null, 'analytics-treasury-metrics'), recordedBurns = el('p', '', 'analytics-treasury-note'), treasuryNote = el('p', '', 'analytics-treasury-note');
  recordedBurns.dataset.analyticsMetric = 'recorded-burns';
  const receiptsRow = el('div', null, 'analytics-receipt-charts'), buyHost = mountChart(chartHost('analytics-buy-plot')), burnHost = mountChart(chartHost('analytics-burn-plot'));
  const buyFigure = el('figure', null, 'analytics-mini-chart'), burnFigure = el('figure', null, 'analytics-mini-chart');
  buyFigure.append(el('figcaption', 'SOL spent on buybacks · by UTC day'), buyHost); burnFigure.append(el('figcaption', '$LAUNCHPAD burned · by UTC day'), burnHost);
  receiptsRow.append(buyFigure, burnFigure); const receiptsCaption = el('p', '', 'analytics-chart-caption');
  const policy = el('div', null, 'analytics-policy'), policyRate = el('strong', '50%'), policyText = el('p', 'Of recognized net SOL revenue is allocated to $LAUNCHPAD buybacks and burns. '), policyLink = el('a', 'How revenue works ↗'); policyLink.href = '/docs#revenue'; policyText.append(policyLink); policy.append(policyRate, policyText);
  treasury.append(sectionHead('Buybacks & burns', 'Total burned supply and recorded protocol buybacks, shown separately.', 'ALL TIME'), treasuryMetrics, receiptsRow, receiptsCaption, recordedBurns, treasuryNote, policy);
  // ---- Holder rewards ----
  const rewards = el('section', null, 'analytics-card cv-card analytics-rewards'), rewardMetrics = el('div', null, 'analytics-treasury-metrics'), rewardNote = el('p', '', 'analytics-treasury-note'), rewardDetails = el('details', null, 'analytics-data-details'), rewardTable = el('div', null, 'analytics-table-wrap');
  const rewardShare = el('div', null, 'analytics-share'); rewardShare.hidden = true;
  rewardDetails.append(el('summary', 'View rewards by paired asset'), rewardTable);
  rewards.append(sectionHead('Holder rewards', 'Confirmed rewards and the wallets paid across Launchpad coins.', 'ALL TIME'), rewardMetrics, rewardShare, rewardNote, rewardDetails);
  const lifetimeDetails = el('details', null, 'analytics-data-details analytics-lifetime-details'), lifetimeTable = el('div', null, 'analytics-table-wrap'), lifetimeNote = el('p', '', 'analytics-chart-caption');
  lifetimeDetails.append(el('summary', 'View lifetime volume sources and paired assets'), lifetimeNote, lifetimeTable);
  // ---- Receipts and coverage ----
  const lower = el('div', null, 'analytics-lower');
  const historyCard = el('section', null, 'analytics-card cv-card analytics-history'), historyDetails = el('details'), historyRows = el('div', null, 'analytics-table-wrap'), historyEmpty = el('p', '', 'analytics-history-empty');
  historyDetails.open = true;
  historyDetails.append(el('summary', 'View recent confirmed transactions'), historyRows); historyCard.append(sectionHead('Onchain receipts', 'Recent protocol buybacks, treasury burns and direct $LAUNCHPAD burns.'), historyDetails, historyEmpty);
  const sources = el('section', null, 'analytics-card cv-card analytics-sources'), coverageValue = el('strong', '—', 'analytics-coverage-number'), coverageLabel = el('p', 'Coins with complete USD volume data', 'analytics-coverage-label'), sourceList = el('dl', null, 'analytics-source-list'), volumeSource = el('dd'), inventorySource = el('dd');
  const coverageMeter = el('div', null, 'analytics-meter analytics-coverage-meter'), coverageFill = el('div', null, 'analytics-meter-fill'); coverageMeter.dataset.motionBar = ''; coverageMeter.setAttribute('aria-hidden', 'true'); coverageMeter.append(coverageFill); coverageMeter.hidden = true;
  const sourceVolume = el('div'), sourceInventory = el('div'); sourceVolume.append(el('dt', 'Trading volume'), volumeSource); sourceInventory.append(el('dt', 'Launch counts'), inventorySource); sourceList.append(sourceVolume, sourceInventory);
  const docsLink = el('a', 'About these numbers ↗', 'analytics-docs-link'); docsLink.href = '/docs#analytics';
  sources.append(el('h2', 'Data coverage'), coverageValue, coverageLabel, coverageMeter, sourceList, docsLink); lower.append(historyCard, sources);
  const scope = el('p', 'Counts cover completed Launchpad launches, including hidden and archived coins. Only aggregate statistics are published here.', 'analytics-scope');
  root.replaceChildren(hero, toolbar, message, metrics, windowNote, lifetimeDetails, marketVolume, chartsRow, treasury, rewards, lower, scope);

  const headlineCards = metricGroup(metrics), treasuryCards = metricGroup(treasuryMetrics), rewardCards = metricGroup(rewardMetrics);
  let period = 'all', snapshot = null, disposed = false, suspended = false, revision = 0, timer = null, timeout = null, controller = null, inflight = null, marketShown = '—', marketWidthShown = null;
  // Last rendered inputs of charts and tables; unchanged ones are not rebuilt.
  const built = {};
  let failures = 0, skew = 0, receivedAt = null, pollMs = POLL_MS;
  // Server-relative time for freshness checks (see analyticsClockOffset).
  const serverNow = () => now() + skew;
  function table(labels, numeric = []) { const node = el('table', null, 'analytics-table'), head = el('thead'), row = el('tr'), body = el('tbody'); labels.forEach((label, index) => { const th = el('th', label); th.scope = 'col'; if (numeric.includes(index)) th.className = 'num'; row.append(th); }); head.append(row); node.append(head, body); return { node, body, cell: (text, index) => { const td = el('td', text); if (numeric.includes(index)) td.className = 'num'; return td; } }; }
  function volumeSummary(data) {
    const volume = data?.volume || {};
    if (known(volume.usd)) return { value: volume.usd, caption: 'USD estimate · complete reported coverage', status: 'complete' };
    if (known(volume.sampledUsd)) return { value: volume.sampledUsd, caption: 'Sampled USD estimate · observations collected within 15 minutes', status: 'sampled', sampled: true };
    if (known(volume.observedUsd)) return { value: volume.observedUsd, caption: 'Recorded subtotal · partial reported coverage', status: 'partial' };
    if (known(volume.sampledObservedUsd)) return { value: volume.sampledObservedUsd, caption: 'Sampled subtotal · partial reported coverage', status: 'partial', sampled: true };
    return { value: null, caption: 'Waiting for market data', status: 'unavailable' };
  }
  function recordedVolumeSummary(data, all) {
    const lifetime = data?.lifetime || {}, view = all ? lifetime : lifetime.last24h || {};
    const unavailable = lifetime.status === 'unavailable' || lifetime.status === 'loading';
    const value = unavailable ? null : known(view.recordedVolumeUsdEstimate) ? view.recordedVolumeUsdEstimate : view.pricedVolumeUsdEstimate;
    const historyComplete = (all ? lifetime.coverage?.historyComplete : view.historyComplete) === true;
    const pricingComplete = known(view.recordedVolumeUsdEstimate);
    const indexed = whole(lifetime.coverage?.indexedRecordedPools) && lifetime.coverage.indexedRecordedPools > 0;
    let caption = indexed ? 'Historical pool volume + recorded launch trades' : lifetime.coverage?.postGraduationIncluded === true ? 'Recorded trading volume' : 'Recorded launch-curve subtotal';
    if (known(value)) {
      if (!historyComplete) caption += lifetime.coverage?.backfillComplete === true && (!indexed || lifetime.coverage.indexedHistoryComplete === true) ? ' · latest trades syncing' : ' · partial history';
      if (!pricingComplete) caption += ' · partial pricing';
      caption += indexed ? ' · USD estimate' : ' · current-price USD estimate';
    } else if (lifetime.status === 'loading') caption += ' · history is loading';
    else if (lifetime.status === 'unavailable') caption += ' · saved history unavailable';
    else if (whole(view.tradeCount) && view.tradeCount > 0) caption += ' · USD pricing is refreshing · ' + count(view.tradeCount) + ' trades recorded';
    else caption += ' · ' + (all ? 'historical volume is not available yet' : '24h records are not available yet');
    return { value: known(value) ? value : null, caption, coverage: known(value) ? historyComplete && pricingComplete ? 'complete' : 'partial' : 'unavailable' };
  }
  function counted(data, field, observed, caption) {
    if (whole(data?.[field])) return { value: count(data[field]), caption };
    if (whole(data?.[observed])) return { value: count(data[observed]), caption: 'Recorded subtotal · incomplete coverage' };
    return { value: '—', caption: 'Launch data is unavailable' };
  }
  function revenueSummary(data) {
    const revenue=data?.revenue;
    const available=['available','partial'].includes(revenue?.status);
    const value=available?(known(revenue.totalUsdEstimate)?revenue.totalUsdEstimate:revenue.pricedUsdEstimate):null;
    const complete=revenue?.complete===true&&revenue.historyComplete===true&&revenue.pricingComplete===true&&known(revenue.totalUsdEstimate);
    const modes = ['Raydium', ...(revenue?.coverage?.sources?.includes('meteora') ? ['Meteora'] : []), ...(revenue?.coverage?.sources?.includes('damm-pump') ? ['PumpSwap'] : [])];
    let caption='All-time recorded protocol revenue · ' + modes.join(' + ');
    if(!known(value))caption+=data?' · USD estimate unavailable':' · Waiting for confirmed revenue data';
    else{
      if(!complete){caption+=' · recorded subtotal';if(revenue.historyComplete!==true&&revenue.pricingComplete!==true)caption+=' · partial history and pricing';else if(revenue.historyComplete!==true)caption+=' · partial history';else if(revenue.pricingComplete!==true)caption+=' · partial pricing';}
      caption+=' · current USD estimate';
    }
    return {value:known(value)?value:null,caption,coverage:known(value)?complete?'complete':'partial':'unavailable'};
  }
  // Daily series for the headline sparklines, oldest first. Only complete
  // values count; a gap in the saved ledger is a genuine zero-trade day only
  // while its history is complete.
  function launchSeries(data) {
    const days = rowsOf(data?.dailyLaunches?.days).filter(day => validDay(day.date) && day.date >= LAUNCHPAD_ANALYTICS_START_DAY).slice(-30);
    return days.map(day => whole(day.count) ? day.count : null);
  }
  function volumeDays(data) {
    const lifetime = data?.lifetime || {}, rows = rowsOf(lifetime.daily).filter(day => validDay(day.date) && day.date >= LAUNCHPAD_ANALYTICS_START_DAY);
    if (!rows.length || lifetime.status === 'unavailable' || lifetime.status === 'loading') return [];
    const byDate = new Map(rows.map(day => [day.date, day])), complete = lifetime.coverage?.historyComplete === true;
    const first = rows.reduce((min, day) => day.date < min ? day.date : min, rows[0].date), end = Math.floor(serverNow() / 86400000) * 86400000, start = Math.max(Date.parse(first + 'T00:00:00Z'), end - 29 * 86400000);
    const days = [];
    for (let at = start; at <= end; at += 86400000) {
      const date = utcDay(at), day = byDate.get(date);
      if (!day) { days.push({ date, value: complete ? 0 : null, partial: !complete, note: complete ? null : 'No trades recorded for this day yet · history still syncing' }); continue; }
      const priced = day.completePricing === true && known(day.volumeUsdEstimate), value = priced ? day.volumeUsdEstimate : known(day.pricedVolumeUsdEstimate) ? day.pricedVolumeUsdEstimate : null;
      days.push({ date, value, partial: !priced || !complete, note: !priced ? 'Partial pricing · some quote assets have no current USD price' : !complete ? 'Recorded subtotal · history still syncing' : null, trades: whole(day.tradeCount) ? day.tradeCount : null });
    }
    return days;
  }
  function renderHeadline(data) {
    const all = period === 'all', launches = data?.launches || {}, recorded = recordedVolumeSummary(data, true), market = volumeSummary(data), revenue = revenueSummary(data);
    // Rolling market volume includes graduated pools. The historical ledger
    // has narrower coverage and must not replace this figure or be added to it.
    const headline = all ? recorded : { ...market, coverage: market.status };
    const lifetime = data?.lifetime || {}, coverage = lifetime.coverage || {};
    const launchCount = counted(launches, all ? 'total' : 'last24h', all ? 'observedTotal' : 'observedLast24h', all ? 'Completed launches recorded by Launchpad' : 'Completed in the past 24 hours');
    metrics.dataset.period = period; metrics.dataset.volumeCoverage = headline.coverage;
    const launchDaily = launchSeries(data), volumeDaily = volumeDays(data).map(day => day.partial ? null : day.value);
    // Deltas compare the trailing run of complete days only.
    const trailing = values => { let start = values.length; while (start > 0 && known(values[start - 1])) start--; return values.slice(start); };
    const launchDelta = analyticsWindowDelta(trailing(launchDaily)), volumeDelta = analyticsWindowDelta(trailing(volumeDaily));
    const launchExtra = launchDaily.filter(known).length >= 3 ? { series: launchDaily.slice(-14), delta: launchDelta } : null;
    const volumeExtra = volumeDaily.filter(known).length >= 3 ? { series: volumeDaily.slice(-14), delta: volumeDelta && { ...volumeDelta, label: `last ${volumeDelta.days}d vs the ${volumeDelta.days}d before · recorded` } } : null;
    const [, revenueMetric] = headlineCards([
      ['volume-' + period, all ? 'Lifetime Total Volume' : '24h Trading Volume', analyticsUsd(headline.value), headline.caption, undefined, volumeExtra],
      // Revenue has no 24h figure yet; the 24h view labels the all-time total as such.
      ['revenue', all ? 'Total Revenue' : 'All-time Revenue', analyticsUsd(revenue.value), revenue.caption],
      ['launches-' + period, all ? 'Total launches' : '24h launches', launchCount.value, launchCount.caption, undefined, launchExtra]]);
    revenueMetric.dataset.analyticsMetric = 'revenue-usd'; revenueMetric.dataset.coverage = revenue.coverage;
    let note;
    if (all) {
      const indexed = whole(coverage.indexedRecordedPools) && coverage.indexedRecordedPools > 0;
      note = indexed
        ? 'Includes indexed pool history before and after graduation. Overlapping pool and saved-trade records count once. Indexed pool volume uses historical USD values; remaining saved quote amounts use current prices.'
        : coverage.postGraduationIncluded === true
        ? 'Recorded trading history. PumpSwap launch mode includes its original Meteora pool and verified PumpSwap pool, including external wallet trades. Other launch modes retain limited pool coverage.'
        : 'Recorded launch curves only; post-graduation pools are excluded. Complete all-time market volume is not available yet.';
      if (lifetime.status === 'unavailable') note += ' Saved volume history is currently unavailable.';
      else {
        note += ' History sync: ' + count(coverage.backfilledLaunches) + ' / ' + count(coverage.launches) + ' launches.';
        if (whole(coverage.headFreshLaunches)) note += ' Latest trades current: ' + count(coverage.headFreshLaunches) + ' / ' + count(coverage.launches) + '.';
        if (whole(coverage.indexedPools)) note += ' Indexed pool histories: ' + count(coverage.indexedRecordedPools) + ' / ' + count(coverage.indexedPools) + '.';
      }
    } else {
      note = 'Rolling 24-hour trading volume across launch curves and indexed pools, including trading after graduation. Shared pools count once. Lifetime volume has separate, incomplete historical coverage.';
      if (market.sampled) note += ' These market observations were collected within 15 minutes and are not one synchronized window.';
    }
    setText(windowNote, note);
    const marketDisplay = analyticsUsd(market.value), marketWidth = String(Math.max(1, marketDisplay.length * .66));
    if (marketShown !== marketDisplay || !marketValue.classList.contains('motion-counting') && marketValue.textContent !== marketDisplay) { marketShown = marketDisplay; marketValue.textContent = marketDisplay; }
    if (marketWidthShown !== marketWidth) { marketWidthShown = marketWidth; marketValue.style.setProperty('--analytics-value-width', marketWidth); }
    marketVolume.dataset.coverage = market.status;
    marketVolume.hidden = !all;
    marketDot.dataset.motionLive = market.status === 'unavailable' ? 'idle' : market.status === 'complete' ? '' : 'warn';
    setText(marketCaption, 'Launch curves + graduated pools · ' + market.caption + (coverage.postGraduationIncluded === true ? '. Provider market snapshot; coverage may differ from saved trading history above.' : '. Broader coverage than recorded launch-curve volume above.'));
    lifetimeDetails.hidden = !all;
  }
  // Quote amounts: exact decimal strings keep up to 18 places (longer ones are
  // truncated, never rejected as unavailable); numbers never print exponents or
  // turn a positive dust amount into a misleading "0".
  function units(value) {
    if (typeof value === 'string' && /^\d{1,80}(?:\.\d+)?$/.test(value)) { const [integer, fraction = ''] = value.split('.'), places = fraction.slice(0, 18).replace(/0+$/, ''); return BigInt(integer).toLocaleString('en-US') + (places ? '.' + places : ''); }
    if (!known(value)) return '—';
    if (value > 0 && value < 1e-9) return '<0.000000001';
    return value.toLocaleString('en-US', { maximumFractionDigits: 9 });
  }
  // True when a chart or table's inputs differ from what it last rendered, so
  // a routine poll does not rebuild identical rows (losing hover/scroll state).
  function changed(name, inputs) {
    let key; try { key = JSON.stringify(inputs); } catch { key = NaN; }
    if (built[name] === key) return false;
    built[name] = key; return true;
  }
  function renderLifetime(data) {
    const lifetime = data?.lifetime || {}, rows = rowsOf(lifetime.quoteTotals).slice(0, 200), waiting = lifetime.status === 'unavailable' || lifetime.status === 'loading';
    const indexed = whole(lifetime.coverage?.indexedRecordedPools) && lifetime.coverage.indexedRecordedPools > 0;
    setText(lifetimeNote, waiting ? lifetime.status === 'unavailable' ? 'Saved volume history is currently unavailable.' : 'Recorded volume history is loading.' : (indexed
      ? 'Indexed historical pool volume: ' + analyticsUsd(lifetime.indexedHistoricalVolumeUsd) + '. Remaining saved-trade estimate: ' + analyticsUsd(lifetime.curveVolumeUsdEstimate) + '. The paired-asset table covers those remaining saved trades, valued at current prices. '
      : lifetime.coverage?.postGraduationIncluded === true ? 'Cumulative quote amounts from saved, deduplicated trades. Includes original Meteora and verified PumpSwap pools for PumpSwap launch mode. ' : 'Cumulative launch-curve quote amounts from saved, deduplicated trades. Post-graduation pools are excluded. ') + (lifetime.coverage?.historyComplete === true ? 'Available history is synced.' : 'History is still partial or syncing.') + (validDate(lifetime.updatedAt) ? ' Updated ' + dateLabel(lifetime.updatedAt) + '.' : ''));
    if (changed('lifetime', waiting ? lifetime.status : rows)) {
      lifetimeTable.replaceChildren();
      if (!waiting) {
        if (!rows.length) lifetimeTable.append(el('p', 'Recorded quote-asset volume is not available yet.', 'analytics-history-empty'));
        else {
          const { node, body, cell } = table(['Paired asset', 'Recorded volume', 'Current USD estimate'], [1, 2]);
          for (const quote of rows) { const row = el('tr'); row.append(cell(quote.symbol || 'Quote asset', 0), cell(units(quote.amount), 1), cell(analyticsUsd(quote.usdEstimate), 2)); body.append(row); } lifetimeTable.append(node);
        }
      }
    }
    // Daily recorded volume chart.
    const days = waiting ? [] : volumeDays(data), complete = lifetime.coverage?.historyComplete === true;
    volumeCard.dataset.state = waiting ? lifetime.status : days.some(day => known(day.value)) ? 'ready' : 'empty';
    setText(volumeCaption, waiting ? (lifetime.status === 'unavailable' ? 'Saved volume history is currently unavailable.' : 'Recorded volume history is loading.') : days.length ? (indexed ? 'Indexed pool history (historical USD) plus saved trades at current prices, by UTC day. ' : 'Saved, deduplicated trades valued at current quote prices, by UTC day. ') + (complete ? 'Today is still in progress.' : 'History is still syncing; days are recorded subtotals.') : 'Daily volume appears once saved trade history is available.');
    const loading = !data || lifetime.status === 'loading';
    if (!changed('volume-chart', [loading, lifetime.status, complete, days.map(day => [day.date, day.value, day.partial])])) return;
    renderChart(volumeHost, { id: 'volume', className: 'analytics-volume-chart', title: 'Daily recorded trading volume', desc: (complete ? '' : 'Partial recorded amounts. ') + 'USD estimate of recorded trades by UTC day. Exact values are available under View daily volume.',
      series: [{ key: 'volume', label: 'volume' }], days: days.map(day => ({ date: day.date, values: [day.value], partial: day.partial, note: day.note })), loading,
      formatAxis: value => analyticsCompact(value, { currency: true }), formatValue: value => analyticsUsd(value), emptyText: loading ? 'Warming up the curve…' : lifetime.status === 'unavailable' ? 'Saved volume history is taking a break. It will be back shortly.' : 'No trading volume recorded yet. The first trades will draw the curve.', theme: 'pumpgotchi' });
    volumeTable.replaceChildren(); volumeDetails.hidden = !days.length;
    if (days.length) {
      const { node, body, cell } = table(['Date (UTC)', 'Recorded volume', 'Trades', 'Coverage'], [1, 2]);
      for (let index = days.length - 1; index >= 0; index--) { const day = days[index], row = el('tr'); row.append(cell(day.date, 0), cell(analyticsUsd(day.value), 1), cell(whole(day.trades) ? count(day.trades) : '—', 2), cell(!known(day.value) ? 'Unavailable' : day.partial ? 'Recorded subtotal' : 'Complete', 3)); body.append(row); }
      volumeTable.append(node);
    }
  }
  function renderRewards(data) {
    const holders = data?.rewards?.holders || {}, distributed = holders.distributed || {};
    const complete = known(distributed.usdEstimate), value = complete ? distributed.usdEstimate : distributed.observedUsdEstimate;
    const walletCount = whole(holders.uniqueWallets) ? holders.uniqueWallets : holders.observedUniqueWallets;
    const walletsComplete = holders.walletsComplete === true && whole(holders.uniqueWallets);
    rewardCards([
      ['rewards-usd', 'Current value of rewards sent', analyticsUsd(value), 'All-time confirmed token payouts · valued today' + (known(value) ? complete ? ' · current USD estimate' : ' · partial USD estimate' : ' · USD unavailable')],
      ['wallets-paid', 'Wallets paid', count(walletCount), walletsComplete ? 'Unique wallets paid across all holder reward coins' : whole(walletCount) ? 'Verified unique wallets · recorded subtotal' : 'Recipient history is not available yet'],
      ...(whole(holders.payments) ? [['payments', 'Reward payments', count(holders.payments), 'Confirmed payouts recorded across holder reward coins']] : [])]);
    let note = 'Each wallet is counted once across all confirmed holder reward payouts. The dollar figure is today’s value of tokens sent, not the dollar amount paid at the time. See the paired-asset table for the recorded token amounts.';
    if (distributed.historyComplete !== true || distributed.valuationComplete !== true || !walletsComplete) note += ' Available records and prices are shown as subtotals where coverage is incomplete. A dash means payout history or USD pricing is unavailable; it does not mean nothing was distributed.';
    setText(rewardNote, note);
    const quotes = rowsOf(distributed.quoteTotals).slice(0, 200);
    if (!changed('rewards', [distributed.historyComplete === true, quotes])) return;
    rewardTable.replaceChildren();
    const { node, body, cell } = table(['Paired asset', 'Confirmed amount', 'Current USD estimate', 'Coverage'], [1, 2]);
    const shares = [];
    for (const quote of quotes) {
      const complete = quote.historyComplete === true || quote.historyComplete === undefined && distributed.historyComplete === true;
      const positiveAmount = typeof quote.amount === 'string' && /^\d+(?:\.\d+)?$/.test(quote.amount) && /[1-9]/.test(quote.amount) || known(quote.amount) && quote.amount > 0;
      const amount = complete || positiveAmount ? quote.amount : null, usdEstimate = amount === null ? null : quote.usdEstimate;
      const coverage = complete ? known(usdEstimate) ? 'Complete' : 'USD price unavailable' : positiveAmount ? known(usdEstimate) ? 'Recorded subtotal' : 'Subtotal · USD unavailable' : 'History unavailable';
      const row = el('tr'); row.append(cell(quote.symbol || 'Quote asset', 0), cell(units(amount), 1), cell(analyticsUsd(usdEstimate), 2), cell(coverage, 3)); body.append(row);
      if (known(usdEstimate) && usdEstimate > 0) shares.push({ label: typeof quote.symbol === 'string' && quote.symbol.trim() ? quote.symbol.trim().slice(0, 16) : 'Quote asset', value: usdEstimate });
    }
    rewardDetails.hidden = !body.children.length; if (body.children.length) rewardTable.append(node);
    renderShare(rewardShare, shares, { formatValue: analyticsUsd });
  }
  function renderChartLaunches(data) {
    const daily = data?.dailyLaunches || {};
    const days = rowsOf(daily.days).filter(day => validDay(day.date) && day.date >= LAUNCHPAD_ANALYTICS_START_DAY).slice(-30);
    const values = days.map(day => whole(day.count) ? day.count : whole(day.observedCount) ? day.observedCount : null), hasKnown = values.some(known), incomplete = daily.complete !== true || days.some(day => !whole(day.count));
    // Per-venue counts stack when the report carries them (and they add up).
    const venues = VENUES.filter(([key]) => days.some(day => whole(day.venues?.[key]) && day.venues[key] > 0));
    const stacked = venues.length > 0 && days.every((day, index) => !known(values[index]) || !day.venues || VENUES.reduce((sum, [key]) => sum + (whole(day.venues[key]) ? day.venues[key] : 0), 0) <= values[index]);
    const loading = !data;
    if (!changed('chart', [loading, daily.complete === true, stacked, days.map(day => [day.date, day.count, day.observedCount, stacked ? venues.map(([key]) => day.venues?.[key] ?? null) : null])])) return;
    chartTable.replaceChildren(); chartDetails.hidden = !days.length;
    chartCard.dataset.state = loading ? 'loading' : hasKnown ? 'ready' : 'empty';
    chartCaption.textContent = incomplete ? 'Recorded daily subtotals. Launch history is incomplete; today is still in progress.' : 'Completed launches by UTC day. Today is still in progress.';
    const series = stacked ? [...venues.map(([key, label]) => ({ key, label })), { key: 'other', label: 'Other' }] : [{ key: 'launches', label: 'launches' }];
    const rows = days.map((day, index) => {
      if (!stacked) return { date: day.date, values: [values[index]], partial: !whole(day.count), note: whole(day.count) ? null : known(values[index]) ? 'Recorded subtotal · coverage incomplete' : 'Unavailable' };
      const known_ = known(values[index]), parts = venues.map(([key]) => known_ && whole(day.venues?.[key]) ? day.venues[key] : known_ ? 0 : null), other = known_ ? Math.max(0, values[index] - parts.reduce((sum, value) => sum + (value || 0), 0)) : null;
      return { date: day.date, values: [...parts, other], partial: !whole(day.count), note: whole(day.count) ? null : known_ ? 'Recorded subtotal · coverage incomplete' : 'Unavailable' };
    });
    if (stacked && !rows.some(row => row.values.at(-1) > 0)) { series.pop(); for (const row of rows) row.values.pop(); }
    renderChart(chartContainer, { id: 'launches', className: 'analytics-launch-chart', title: 'Daily Launchpad launches', desc: (incomplete ? 'Partial recorded counts. ' : '') + 'Launches by UTC day' + (stacked ? ', stacked by launch venue' : '') + '. Exact values are available under View daily numbers.',
      series, days: rows, integer: true, axisWidth: 40, loading, formatAxis: value => count(Math.round(value)), formatValue: value => count(Math.round(value)), emptyText: loading ? 'Counting launches…' : 'Daily launch history is not available yet. The next launch starts the chart.', theme: 'pumpgotchi' });
    if (days.length) {
      const { node, body, cell } = table(['Date (UTC)', 'Launches', 'Coverage', ...(stacked ? venues.map(([, label]) => label) : [])], stacked ? [1, ...venues.map((_, index) => 3 + index)] : [1]);
      for (let index = days.length - 1; index >= 0; index--) {
        const day = days[index], row = el('tr');
        row.append(cell(day.date, 0), cell(count(values[index]), 1), cell(whole(day.count) ? 'Complete' : known(values[index]) ? 'Recorded subtotal' : 'Unavailable', 2));
        if (stacked) venues.forEach(([key], offset) => row.append(cell(whole(day.venues?.[key]) ? count(day.venues[key]) : '—', 3 + offset)));
        body.append(row);
      }
      chartTable.append(node);
    }
  }
  function renderReceiptCharts(burns, burnsAvailable, solDecimals) {
    const daily = burns?.daily, rows = rowsOf(daily?.rows).filter(row => validDay(row.date) && rawUint(row.solSpent) && rawUint(row.curveBurned)), available = burnsAvailable && daily && typeof daily === 'object';
    const curveDecimals = Number.isInteger(daily?.curveDecimals) && daily.curveDecimals >= 0 && daily.curveDecimals <= 18 ? daily.curveDecimals : 6, lamportDecimals = Number.isInteger(daily?.solDecimals) ? daily.solDecimals : Number.isInteger(solDecimals) ? solDecimals : 9;
    const span = Math.max(7, Math.min(60, whole(daily?.days) ? daily.days : 30));
    if (!changed('receipts-chart', [available, daily?.complete === true, span, rows.map(row => [row.date, row.solSpent, row.curveBurned])])) return;
    receiptsRow.hidden = !available;
    if (!available) { setText(receiptsCaption, ''); receiptsCaption.hidden = true; return; }
    receiptsCaption.hidden = false;
    setText(receiptsCaption, rows.length ? (daily.complete === true ? 'Confirmed receipts by UTC day over the last ' + span + ' days. ' : 'Recorded receipts by UTC day over the last ' + span + ' days · recorded subtotal while some sources are incomplete. ') + 'Days without receipts are shown as zero.' : 'No buyback or burn receipts were recorded in the last ' + span + ' days.');
    const byDate = new Map(rows.map(row => [row.date, row])), end = Math.floor(serverNow() / 86400000) * 86400000, days = [];
    for (let at = end - (span - 1) * 86400000; at <= end; at += 86400000) { const date = utcDay(at); if (date < LAUNCHPAD_ANALYTICS_START_DAY) continue; days.push({ date, row: byDate.get(date) || null }); }
    const scaled = (raw, decimals) => Number(BigInt(raw) / 10n ** BigInt(Math.max(0, decimals - 6))) / 10 ** Math.min(6, decimals);
    const partial = daily.complete !== true;
    renderChart(buyHost, { id: 'buybacks', className: 'analytics-buy-chart', title: 'SOL spent on buybacks by day', desc: 'Recorded buyback purchases in SOL by UTC day.', series: [{ key: 'sol', label: 'SOL' }],
      days: days.map(day => ({ date: day.date, values: [day.row ? scaled(day.row.solSpent, lamportDecimals) : 0], partial, note: partial ? 'Recorded subtotal' : null })), axisWidth: 46,
      formatAxis: value => analyticsCompact(value), formatValue: value => value.toLocaleString('en-US', { maximumFractionDigits: 4 }), emptyText: 'No buybacks recorded in this window.', theme: 'fomogotchi' });
    renderChart(burnHost, { id: 'burns', className: 'analytics-burn-chart', title: 'LAUNCHPAD burned by day', desc: 'Recorded LAUNCHPAD burns by UTC day.', series: [{ key: 'curve', label: 'LAUNCHPAD' }],
      days: days.map(day => ({ date: day.date, values: [day.row ? scaled(day.row.curveBurned, curveDecimals) : 0], partial, note: partial ? 'Recorded subtotal' : null })), axisWidth: 46,
      formatAxis: value => analyticsCompact(value), formatValue: value => value.toLocaleString('en-US', { maximumFractionDigits: 2 }), emptyText: 'No burns recorded in this window.', theme: 'fomogotchi' });
  }
  function renderTreasury(data) {
    const info = data?.treasury || {}, available = info.status === 'available'||info.status==='partial'&&(info.manualIncluded===true||info.adminIncluded===true||info.adminHistoryUnavailable===true), decimals = info.curveDecimals;
    const burns = data?.burns || info, burnsAvailable = data?.burns ? ['available','partial'].includes(burns.status) : available, burnDecimals = burns.curveDecimals;
    const supply = burnSupplySummary(data?.burnSupply, serverNow());
    const burnCaption = supply ? supply.percent + ' of original supply · ' + (supply.stale ? 'Last verified ' + dateLabel(supply.at) : 'Finalized onchain') : 'Onchain burned supply unavailable';
    // The server attached a price that was fresh when it generated this
    // snapshot. Judge it at that time while the snapshot is current, so a
    // cached report does not lapse to a dash between polls; once the snapshot
    // itself is stale the price is judged against the current time.
    const valuedAt = validDate(data?.generatedAt) && serverNow() - data.generatedAt <= STALE_MS ? data.generatedAt : serverNow();
    const burnUsd = burnedUsdDisplay(supply ? burnTokenAmount(supply.totalBurned, supply.decimals) : null, info.curvePrice, { mint: OFFICIAL_TOKEN_MINT, now: valuedAt });
    const [, , burnedMetric, valuation] = treasuryCards([
      ['sol-spent', 'SOL spent on buybacks', available ? analyticsRaw(info.solSpent, info.solDecimals) : '—', 'Recorded confirmed purchases', 'SOL'],
      ['curve-bought', '$LAUNCHPAD bought', available ? analyticsRaw(info.curveBought, decimals) : '—', 'Purchased tokens before the burn step', 'LAUNCHPAD'],
      ['burned-supply', '$LAUNCHPAD burned · onchain', supply ? analyticsRaw(supply.totalBurned, supply.decimals) : '—', burnCaption, 'LAUNCHPAD', supply ? { meter: { fraction: supply.fraction, label: supply.percent + ' of the 1,000,000,000 original supply burned' } } : null],
      ['burned-usd', 'Burned value · current price', burnUsd, !supply ? 'Onchain burned supply unavailable' : burnUsd === '—' ? 'Current USD price unavailable; not shown as zero' : (supply.stale ? 'Last verified burned supply' : 'Onchain burned supply') + ' at today’s token price; not historical spending']]);
    burnedMetric.dataset.analyticsMetric = 'burned-supply'; burnedMetric.dataset.coverage = supply ? supply.stale ? 'stale' : 'available' : 'unavailable';
    valuation.dataset.analyticsMetric = 'burned-usd';
    const recordedAmount = burnsAvailable ? analyticsRaw(burns.curveBurned, burnDecimals) : '—';
    let recorded = 'Recorded burns: ' + recordedAmount + ' LAUNCHPAD · ' + (recordedAmount === '—' ? 'Receipt totals unavailable.' : burns.complete === false ? 'Recorded burn subtotal · incomplete receipt coverage.' : 'Confirmed receipts.');
    if (supply && !supply.stale && recordedAmount !== '—' && burnDecimals === supply.decimals) {
      const difference = BigInt(supply.totalBurned) - BigInt(burns.curveBurned);
      if (difference > 0n) recorded += ' ' + analyticsRaw(difference.toString(), supply.decimals) + ' LAUNCHPAD burned outside these saved receipts; attribution is unclassified, not counted as protocol-funded.';
      else if (difference < 0n) recorded += ' Recorded receipts and the supply snapshot are awaiting reconciliation.';
    }
    setText(recordedBurns, recorded);
    let note = available ? 'Buyback and receipt totals come from saved confirmed treasury records. Purchases and burns are separate steps; a purchase is counted as burned only after its burn confirms. Total onchain burns include all reductions from the original supply, regardless of who burned them.' : info.status === 'unconfigured' ? 'Public treasury totals are not available yet. Unavailable amounts are not shown as zero.' : 'Treasury activity is temporarily unavailable. Confirmed totals will appear when its records are available.';
    if(available&&info.manualIncluded)note=(info.amountsAreSubtotals?'Recorded subtotal; some automatic totals are unavailable. ':'')+'Includes verified manual protocol purchases and burns alongside recorded automatic activity. Manual activity does not increase the automatic buyback budget. Purchased LAUNCHPAD is the amount received after transfer tax; SOL spend excludes network fees and rent.';
    if(available&&info.adminIncluded)note+=' Includes administrator-imported finalized receipts. Burn-only entries do not increase SOL spent or LAUNCHPAD bought.';
    if(info.adminHistoryUnavailable)note+=' Imported receipt history is temporarily unavailable; available totals are shown as subtotals.';
    const contributed=typeof info.manualContributionBurned==='string'&&/^[1-9]\d{0,79}$/.test(info.manualContributionBurned)?analyticsRaw(info.manualContributionBurned,decimals):'—';
    if(available&&contributed!=='—')note+=' '+contributed+' LAUNCHPAD in the recorded burn total came from tokens contributed to the treasury; no protocol buyback spend is recorded for them.';
    if(data?.burns&&burnsAvailable){
      const direct=typeof burns.directBurned==='string'&&/^[1-9]\d{0,79}$/.test(burns.directBurned)?analyticsRaw(burns.directBurned,burnDecimals):null;
      if(direct)note+=' Includes '+direct+' LAUNCHPAD burned directly from collected tax or authorized inventory. These burns have no recorded buyback cost; they do not increase SOL spent or LAUNCHPAD bought.';
      if(!burns.complete)note+=' The receipt total is a recorded subtotal while some source records are unavailable.';
      note+=' Direct burns appear automatically after their finalized receipt is saved, on the next minute refresh.';
    }
    if (available && validDate(info.updatedAt)) note += ' Records updated ' + dateLabel(info.updatedAt) + '.';
    setText(treasuryNote, note);
    // The allocation policy is not a claim that any pending balance is spent.
    setText(policyRate, whole(info.buybackBps) && info.buybackBps <= 10000 ? String(info.buybackBps / 100) + '%' : '50%');
    section(() => renderReceiptCharts(data?.burns, !!data?.burns && burnsAvailable, info.solDecimals));
    const receipts = burnsAvailable ? rowsOf(burns.history).filter(row => ['buy', 'burn'].includes(row.kind) && signature(row.signature) && validDate(row.confirmedAt)).slice(0, 20) : [];
    historyDetails.hidden = !receipts.length; historyEmpty.hidden = receipts.length > 0;
    setText(historyEmpty, burnsAvailable ? 'No recent confirmed buyback or burn receipts are available to display.' : 'Confirmed receipts will appear here when their saved records are available.');
    if (!changed('receipts', [info.solDecimals, burnDecimals, receipts])) return;
    historyRows.replaceChildren();
    if (receipts.length) {
      const { node, body, cell } = table(['Action', 'Amount', 'Confirmed', 'Receipt'], [1]);
      for (const receipt of receipts) {
        const row = el('tr'), link = el('a', 'View transaction ↗'), linkCell = el('td'); link.href = 'https://solscan.io/tx/' + receipt.signature; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.setAttribute('aria-label', 'View confirmed ' + (receipt.kind === 'buy' ? 'buyback' : 'burn') + ' transaction on Solscan (opens in a new tab)'); linkCell.append(link);
        const label=receipt.source==='direct'?(receipt.funding==='approved-initial-inventory'?'Direct inventory burn':'Direct tax burn'):receipt.kind==='burn'&&receipt.funding==='external-contribution'?'Contributed LAUNCHPAD burn':(receipt.kind === 'buy' ? 'Buyback' : 'Burn')+(receipt.source==='manual'?' · manual':receipt.source==='admin'?' · imported':'');
        const action = el('td'), kind = el('i', null, 'analytics-kind ' + (receipt.kind === 'buy' ? 'is-buy' : 'is-burn')); kind.setAttribute('aria-hidden', 'true'); action.append(kind, el('span', label));
        row.append(action, cell(analyticsRaw(receipt.inputAmount, receipt.kind === 'buy' ? info.solDecimals : burnDecimals) + (receipt.kind === 'buy' ? ' SOL' : ' LAUNCHPAD'), 1), cell(dateLabel(receipt.confirmedAt), 2), linkCell); body.append(row);
      }
      historyRows.append(node);
    }
  }
  // Each section renders independently: one malformed section cannot leave
  // the rest of the page on its previous (or initial dash) values.
  function section(fn, data) { try { fn(data); } catch {} }
  function renderStatus(data) {
    const volume = data?.volume || {}, stale = !validDate(data?.generatedAt) || serverNow() - data.generatedAt > STALE_MS;
    message.dataset.state = stale ? 'stale' : 'ready'; setText(message, stale ? 'This snapshot is older than two minutes. Refreshing automatically.' : volume.refreshing === true ? 'Market data is refreshing. Counts and confirmed treasury records update independently.' : 'Public statistics · no sign-in required');
  }
  function render(data) {
    snapshot = data;
    for (const part of [renderHeadline, renderTreasury, renderRewards, renderLifetime, renderChartLaunches]) section(part, data);
    section(() => {
      const volume = data.volume || {}, info = volume.coverage || {}, sampled = volumeSummary(data).sampled === true;
      const covered = sampled ? volume.sampling?.cachedCoins : info.usdComplete;
      setText(coverageValue, count(covered) + ' / ' + count(info.launches));
      setText(coverageLabel, sampled ? 'Coins with complete sampled USD volume' : 'Coins with complete fresh USD volume');
      const fraction = whole(covered) && whole(info.launches) && info.launches > 0 ? Math.min(1, covered / info.launches) : null;
      coverageMeter.hidden = fraction === null; if (fraction !== null) coverageMeter.style.setProperty('--value', fraction.toFixed(4));
      setText(volumeSource, (sampled ? 'Sampled 24h windows observed from ' + dateLabel(volume.sampling?.oldestAt) + ' to ' + dateLabel(volume.sampling?.newestAt) + '. These windows are not synchronized.' : 'Bonding-curve activity and graduated-pool market data. ' + (validDate(volume.asOf) ? 'Snapshot: ' + dateLabel(volume.asOf) + '.' : 'An observation time is not available yet.')) + (volumeSummary(data).status === 'partial' ? ' The displayed volume is a subtotal.' : ''));
      setText(inventorySource, data.launches?.complete === true ? 'Completed launches in Launchpad records. Includes hidden and archived launches, without publishing their details.' : 'Some launch records are unavailable. Displayed counts are recorded subtotals.');
    });
    setText(updatedTime, 'Updated ' + dateLabel(data.generatedAt));
    renderStatus(data);
  }
  function stopTimer() { if (timer !== null) clearTimer(timer); timer = null; }
  // Background and bfcache-suspended pages do not poll or retry; becoming
  // visible (or being restored) loads immediately instead.
  function schedule(delay) { stopTimer(); if (!disposed && !suspended && !document.hidden) timer = setTimer(() => { timer = null; void load(); }, delay); }
  // Only a first load or an explicit Refresh shows as busy. Routine polls keep
  // the Refresh control and page state steady (a disabled button dims, so
  // toggling it on every poll made the toolbar blink).
  function busy(on) { refresh.disabled = on; root.setAttribute('aria-busy', String(on)); }
  function settle() { if (timeout !== null) clearTimer(timeout); timeout = null; controller = null; inflight = null; busy(false); }
  function abort() { revision++; controller?.abort(); settle(); }
  function failed(retryAfterMs) {
    failures++;
    if (snapshot) {
      // Keep every previously loaded number on screen. Only the supply check is
      // explicitly marked stale until a refresh succeeds again.
      snapshot = { ...snapshot, burnSupply: snapshot.burnSupply ? { ...snapshot.burnSupply, status: snapshot.burnSupply.status === 'available' ? 'stale' : snapshot.burnSupply.status } : undefined };
      section(renderTreasury, snapshot);
    }
    message.dataset.state = snapshot ? 'stale' : 'error'; setText(message, snapshot ? 'Could not refresh. Showing the previous snapshot; retrying automatically.' : 'Analytics is temporarily unavailable. Retrying automatically.');
    return analyticsRetryDelay(failures, retryAfterMs);
  }
  function load(options) {
    if (disposed || suspended) return Promise.resolve();
    const manual = options?.manual === true;
    // One request at a time: callers (timer, Refresh, visibility) share it.
    if (inflight) { if (manual) busy(true); return inflight; }
    // A background tab with numbers already on screen waits until it is
    // visible. One with nothing to show still completes its first load.
    if (document.hidden && snapshot) { stopTimer(); return Promise.resolve(); }
    stopTimer(); if (manual || !snapshot) busy(true);
    // Numbers that aged while the tab was hidden or refreshes kept failing are
    // re-labelled before the request, never cleared.
    if (snapshot && receivedAt !== null && now() - receivedAt > pollMs + REQUEST_MS) { section(renderTreasury, snapshot); renderStatus(snapshot); }
    const generation = ++revision, pending = new AbortController(); controller = pending;
    timeout = setTimer(() => pending.abort(), REQUEST_MS);
    // A timeout or abort settles the load even if a fetch implementation
    // ignores the signal; a late response for this generation is discarded.
    const expired = new Promise((_, reject) => pending.signal.addEventListener('abort', () => reject(Error('Analytics request expired.')), { once: true }));
    expired.catch(() => {});
    const current = () => generation === revision && !disposed;
    let delay = pollMs, waitAfter = 0, finished = false;
    const work = (async () => {
      try {
        const response = await Promise.race([fetcher('/api/analytics', { credentials: 'omit', signal: pending.signal, headers: { Accept: 'application/json' } }), expired]);
        const arrivedAt = now();
        if (!response?.ok) { waitAfter = retryAfter(response); throw new Error('Analytics unavailable.'); }
        const data = await Promise.race([response.json(), expired]);
        if (pending.signal.aborted) throw new Error('Analytics request expired.');
        if (!data || data.version !== 1 || !validDate(data.generatedAt) || !data.launches || !data.volume || !data.treasury) throw new Error('Analytics snapshot unavailable.');
        if (!current()) return;
        const offset = analyticsClockOffset(data, response, arrivedAt, skew);
        // Never replace a newer report with an older one (e.g. from another
        // server process); a clock reset is accepted once ours is stale.
        const older = snapshot && data.generatedAt < snapshot.generatedAt && arrivedAt + offset - snapshot.generatedAt <= STALE_MS;
        skew = offset; failures = 0; receivedAt = arrivedAt;
        pollMs = Number.isSafeInteger(data.refreshMs) && data.refreshMs > 0 ? Math.min(POLL_MS, Math.max(MIN_POLL_MS, data.refreshMs)) : POLL_MS;
        delay = pollMs;
        if (older) renderStatus(snapshot);
        else render(data);
      } catch {
        if (current()) delay = failed(waitAfter);
      } finally {
        finished = true;
        if (generation === revision) { settle(); schedule(delay); }
      }
    })();
    // A fetcher that throws synchronously settles before this line; recording
    // that finished load as in flight would make every later load (and the
    // retry timer) reuse it, and polling would stop for good.
    if (!finished) inflight = work;
    return work;
  }
  // Hidden tabs keep an in-flight load (so numbers are ready when the tab is
  // opened) but stop polling. Becoming visible refreshes immediately.
  function visibility() { if (disposed) return; if (document.hidden) stopTimer(); else void load(); }
  // bfcache: abort network work on pagehide; a restored page reloads at once.
  function pagehide() { suspended = true; stopTimer(); abort(); }
  function pageshow() { if (suspended && !disposed) { suspended = false; void load(); } }
  function destroy() { if (disposed) return; disposed = true; stopTimer(); abort(); resizer?.disconnect(); refresh.onclick = null; for (const button of buttons.values()) button.onclick = null; document.removeEventListener('visibilitychange', visibility); window?.removeEventListener('pagehide', pagehide); window?.removeEventListener('pageshow', pageshow); }
  refresh.onclick = () => load({ manual: true }); document.addEventListener('visibilitychange', visibility); window?.addEventListener('pagehide', pagehide); window?.addEventListener('pageshow', pageshow);
  renderHeadline(null); renderTreasury(null); renderRewards(null); renderLifetime(null); renderChartLaunches(null);
  return { element: root, load, destroy };
}
