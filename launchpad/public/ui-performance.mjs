const rendered = new WeakMap();

// Status feeds can arrive several times a second. Keep the actual controls in
// place when their displayed data is unchanged so focus and clicks survive.
export function renderIfChanged(element, value, render) {
  const signature = JSON.stringify(value);
  const old = rendered.get(element);
  if (old?.signature === signature && old.first === element.firstChild && old.last === element.lastChild) return false;
  render();
  rendered.set(element, { signature, first: element.firstChild, last: element.lastChild });
  return true;
}

export function openPositionCount(positions = []) {
  return positions.filter(p => p.position || Number(p.remaining ?? p.liquidity ?? 0) > 0).length;
}

// Lightweight Charts labels times in UTC. These formatters label the same
// instants in the visitor's time zone, like the rest of the page. The library
// still places day/month/year marks on UTC boundaries: in local time those are
// shown with their hour unless they fall on local midnight. Day candles are UTC
// days, so a daily chart keeps the library's UTC dates (return null).
export function chartTimeFormatters({ daily = () => false, seconds = () => false, timeZone } = {}) {
  const at = time => typeof time === 'number' && Number.isFinite(time) && time > 0 ? new Date(time * 1000) : null;
  const format = (date, options, locale) => { try { return date.toLocaleString(locale, { timeZone, ...options }); } catch { return date.toLocaleString(undefined, { timeZone, ...options }); } };
  const clock = withSeconds => ({ hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}), hourCycle: 'h23' });
  const midnight = date => format(date, clock(true), 'en-US') === '00:00:00';
  return {
    tickMarkFormatter(time, type, locale) {
      const date = at(time); if (!date || daily()) return null;
      if (type === 3 || type === 4) return format(date, clock(type === 4), locale);
      if (midnight(date)) return format(date, type === 0 ? { year: 'numeric' } : type === 1 ? { month: 'short' } : { day: 'numeric' }, locale);
      return format(date, { month: 'short', day: 'numeric' }, locale) + ' ' + format(date, clock(false), locale);
    },
    timeFormatter(time) {
      const date = at(time); if (!date) return typeof time === 'object' && time ? [time.year, time.month, time.day].join('-') : String(time ?? '');
      if (daily()) return format(date, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
      return format(date, { year: 'numeric', month: 'short', day: 'numeric', ...clock(seconds()) });
    },
  };
}

const sameBar = (a, b) => ['time','open','high','low','close','volume'].every(key => a[key] === b[key]);
export function candleUpdate(previous, next) {
  if (!previous.length || next.length < previous.length) return { reset: true, rows: next };
  for (let i = 0; i < previous.length - 1; i++) {
    if (!sameBar(previous[i], next[i])) return { reset: true, rows: next };
  }
  const last = previous.length - 1;
  if (previous[last].time !== next[last].time) return { reset: true, rows: next };
  return { reset: false, rows: next.slice(sameBar(previous[last], next[last]) ? previous.length : last) };
}
