// Shared pieces for long admin lists: relative times with the exact time on hover, copy buttons for
// addresses, a filter bar (search + chips), paging controls, and the page/filter state kept in the
// hash (`#section/page?q=…&page=2`) so the browser's Back button returns to the same page. No module
// here calls the API; each page module keeps its own loading, checks and identity prompts.
export const PAGE_SIZE = 25;
const SAFE_TIME = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;
const UNITS = [['year', 365 * 86400000], ['month', 30 * 86400000], ['week', 7 * 86400000], ['day', 86400000], ['hour', 3600000], ['minute', 60000]];

/** "3 minutes ago", "in 2 hours", "just now"; '—' for an unusable time. */
export function relativeTime(at, now = Date.now()) {
  if (!SAFE_TIME(at)) return '—';
  const delta = at - now, abs = Math.abs(delta);
  if (abs < 45000) return 'just now';
  for (const [unit, size] of UNITS) {
    if (abs >= size) { const count = Math.round(abs / size); const text = `${count} ${unit}${count === 1 ? '' : 's'}`; return delta < 0 ? `${text} ago` : `in ${text}`; }
  }
  const seconds = Math.round(abs / 1000); return delta < 0 ? `${seconds} s ago` : `in ${seconds} s`;
}
/** The full date and time, with the year. */
export function exactTime(at) { return SAFE_TIME(at) ? new Date(at).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'; }
/** A <time> that reads relatively and shows the exact time on hover and to screen readers. */
export function timeNode(document, at, { now = Date.now(), prefix = '' } = {}) {
  const node = document.createElement('time');
  if (!SAFE_TIME(at)) { node.textContent = '—'; return node; }
  node.dateTime = new Date(at).toISOString(); node.textContent = prefix + relativeTime(at, now); node.title = exactTime(at); node.className = 'admin-time';
  node.setAttribute('aria-label', (prefix ? prefix.trim() + ' ' : '') + exactTime(at));
  return node;
}
/** A full-width-safe time range text: "3 days old" style age for lists. */
export function ageText(at, now = Date.now()) { const text = relativeTime(at, now); return text === 'just now' ? 'just now' : text.replace(/ ago$/, ' old'); }

/** A small copy-to-clipboard button; the copied value is only ever the given text (never read back from the DOM). */
export function copyButton(document, value, label = 'Copy address') {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'admin-copy'; button.dataset.copy = String(value); button.title = label; button.setAttribute('aria-label', label);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('aria-hidden', 'true');
  const box = document.createElementNS('http://www.w3.org/2000/svg', 'rect'); box.setAttribute('x', '7'); box.setAttribute('y', '7'); box.setAttribute('width', '9'); box.setAttribute('height', '9'); box.setAttribute('rx', '2');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7');
  svg.append(box, path); const done = document.createElement('span'); done.className = 'admin-copy-done'; done.textContent = 'Copied'; button.append(svg, done);
  let timer = null;
  button.addEventListener('click', async event => {
    event.preventDefault(); event.stopPropagation();
    const clipboard = document.defaultView?.navigator?.clipboard;
    try { if (clipboard?.writeText) await clipboard.writeText(String(value)); else throw Error('No clipboard'); button.dataset.copied = 'true'; }
    catch { button.dataset.copied = 'failed'; }
    if (timer !== null) clearTimeout(timer); timer = setTimeout(() => { delete button.dataset.copied; timer = null; }, 1400);
  });
  return button;
}

/**
 * The filter/page state of one list, kept in the hash query (`#tokens/vanity?q=abc&page=2`) when a
 * window with history is available; otherwise in memory. `prefix` separates several lists on one page.
 */
export function hashState(window, { prefix = '' } = {}) {
  let memory = new URLSearchParams();
  const usable = () => !!(window?.location && typeof window.location.hash === 'string' && window.history?.replaceState);
  const read = () => { if (!usable()) return memory; const hash = String(window.location.hash || ''), at = hash.indexOf('?'); return new URLSearchParams(at >= 0 ? hash.slice(at + 1) : ''); };
  const key = name => prefix ? prefix + '.' + name : name;
  return {
    get(name) { return read().get(key(name)) || ''; },
    /** Writes the given names (empty values are dropped). `push` records a history entry (page changes), otherwise the entry is replaced (typing). */
    set(values, { push = false } = {}) {
      const params = read();
      for (const [name, value] of Object.entries(values)) { if (value === '' || value === null || value === undefined || value === 0 || value === '0') params.delete(key(name)); else params.set(key(name), String(value)); }
      if (!usable()) { memory = params; return; }
      const hash = String(window.location.hash || ''), base = hash.includes('?') ? hash.slice(0, hash.indexOf('?')) : hash, query = params.toString(), next = base + (query ? '?' + query : '');
      if (next === hash) return;
      try { if (push && window.history.pushState) window.history.pushState(null, '', next); else window.history.replaceState(null, '', next); } catch { /* history unavailable: the list still works */ }
    },
    /** The parts of the query that belong to this list, for comparing before and after a popstate. */
    signature() { const params = read(); return [...params.entries()].filter(([name]) => !prefix || name.startsWith(prefix + '.')).map(([name, value]) => name + '=' + value).sort().join('&'); },
  };
}

/** Previous/next controls with "a–b of N"; hidden while everything fits on one page. */
export function pager(document, { onPage, label = 'rows' } = {}) {
  const element = document.createElement('div'); element.className = 'admin-pager'; element.setAttribute('role', 'navigation'); element.setAttribute('aria-label', 'Pages');
  const prev = document.createElement('button'), next = document.createElement('button'), summary = document.createElement('span');
  prev.type = next.type = 'button'; prev.className = next.className = 'small-button cv-sm'; prev.textContent = 'Previous'; next.textContent = 'Next'; summary.className = 'admin-pager-summary'; summary.setAttribute('aria-live', 'polite');
  prev.dataset.page = 'previous'; next.dataset.page = 'next';
  element.append(prev, summary, next);
  let state = { offset: 0, limit: PAGE_SIZE, total: 0 };
  prev.onclick = () => { if (state.offset > 0) onPage?.(Math.max(0, state.offset - state.limit)); };
  next.onclick = () => { if (state.offset + state.limit < state.total) onPage?.(state.offset + state.limit); };
  return {
    element,
    update({ offset = 0, limit = PAGE_SIZE, total = 0, shown = null, noun = label } = {}) {
      state = { offset, limit, total };
      if (!Number.isSafeInteger(shown) || shown < 0) shown = Math.max(0, Math.min(limit, total - offset));
      summary.textContent = total ? `${offset + 1}–${offset + shown} of ${total.toLocaleString('en-US')} ${noun}` : `No ${noun}`;
      prev.disabled = offset <= 0; next.disabled = offset + limit >= total;
      element.hidden = total <= limit && offset === 0;
    },
    state: () => ({ ...state }),
  };
}

/**
 * A search field with filter chips on one row. `chips` is [{ key, label, count? }]; the empty key means "all".
 * `onChange({ q, chip })` runs on input (debounced) and on chip clicks.
 */
export function filterBar(document, { placeholder = 'Filter', label = 'Filter', chips = [], onChange, debounceMs = 180, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const element = document.createElement('div'); element.className = 'admin-filter-bar';
  const field = document.createElement('label'); field.className = 'admin-filter-field';
  const text = document.createElement('span'); text.className = 'admin-visually-hidden'; text.textContent = label;
  const input = document.createElement('input'); input.type = 'search'; input.placeholder = placeholder; input.autocomplete = 'off'; input.spellcheck = false; input.maxLength = 64; input.setAttribute('aria-label', label);
  field.append(text, input);
  const row = document.createElement('div'); row.className = 'admin-filter-chips cv-chips'; row.setAttribute('role', 'group'); row.setAttribute('aria-label', label + ' options');
  element.append(field, row);
  let chip = '', timer = null, items = [];
  const render = () => {
    row.replaceChildren(...items.map(item => {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.chip = item.key; button.textContent = item.label; button.setAttribute('aria-pressed', String(item.key === chip));
      if (Number.isSafeInteger(item.count)) { const count = document.createElement('span'); count.className = 'admin-chip-count'; count.textContent = item.count.toLocaleString('en-US'); button.append(count); }
      button.onclick = () => { if (chip === item.key) return; chip = item.key; render(); onChange?.({ q: input.value.trim(), chip, source: 'chip' }); };
      return button;
    }));
    row.hidden = !items.length;
  };
  input.addEventListener('input', () => { if (timer !== null) clearTimer(timer); timer = setTimer(() => { timer = null; onChange?.({ q: input.value.trim(), chip, source: 'input' }); }, debounceMs); });
  input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); if (timer !== null) { clearTimer(timer); timer = null; } onChange?.({ q: input.value.trim(), chip, source: 'enter' }); } else if (event.key === 'Escape' && input.value) { event.preventDefault(); event.stopPropagation(); input.value = ''; onChange?.({ q: '', chip, source: 'clear' }); } });
  items = chips; render();
  return {
    element, input,
    get q() { return input.value.trim(); }, get chip() { return chip; },
    /** Replaces the chips (counts included) and keeps the selection when it still exists. */
    setChips(next) { items = next; if (!items.some(item => item.key === chip)) chip = ''; render(); },
    set({ q, chip: next }) { if (q !== undefined) input.value = q; if (next !== undefined) { chip = next; render(); } },
    cancel() { if (timer !== null) { clearTimer(timer); timer = null; } },
  };
}

/** Client-side paging of an already loaded array after a text filter: { rows, total, offset, limit, nextOffset }. */
export function pageRows(rows, { offset = 0, limit = PAGE_SIZE, q = '', fields = [], keep = () => true } = {}) {
  const query = String(q || '').trim().toLowerCase();
  const matched = rows.filter(row => keep(row) && (!query || fields.some(field => String((typeof field === 'function' ? field(row) : row?.[field]) ?? '').toLowerCase().includes(query))));
  const start = Math.min(offset, Math.max(0, Math.floor((matched.length - 1) / limit) * limit));
  return { rows: matched.slice(start, start + limit), total: matched.length, offset: start, limit, nextOffset: start + limit < matched.length ? start + limit : null };
}

/** Low-risk actions confirm inline (a second click on "Confirm") instead of a dialog; the prompt cancels itself after a moment. */
export function inlineConfirm(button, run, { confirmText = 'Confirm?', timeoutMs = 4000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const original = button.textContent; let armed = false, timer = null;
  const reset = () => { armed = false; button.textContent = original; delete button.dataset.armed; if (timer !== null) { clearTimer(timer); timer = null; } };
  button.addEventListener('click', event => {
    if (!armed) { event.preventDefault(); event.stopPropagation(); armed = true; button.dataset.armed = 'true'; button.textContent = confirmText; timer = setTimer(reset, timeoutMs); return; }
    reset(); run(event);
  });
  button.addEventListener('blur', () => { if (armed) reset(); });
  return { reset };
}
