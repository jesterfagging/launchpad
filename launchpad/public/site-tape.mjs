// The live tape (v71.43): a thin strip under the header on every public page that
// streams the most active Launchpad coins — ticker, value, graduation progress or 24h
// move — from the public /api/explore feed. Decorative and read-only: it never
// changes what a page does, it only links to coin pages. It stays hidden until
// the feed answers, refreshes once a minute while the tab is visible, and is
// preserved across client-side navigation like the header.
import { coinImage } from './coin-image.mjs';
const REFRESH_MS = 60000, LIMIT = 14, FRESH_MS = 3600000;
const tapes = new WeakMap();
const money = value => { const n = Number(value); if (!Number.isFinite(n) || n <= 0) return null; const abs = Math.abs(n); const f = (v, d) => v.toFixed(d).replace(/\.0+$|(\.\d*?)0+$/, '$1'); return abs >= 1e9 ? '$' + f(n / 1e9, 2) + 'B' : abs >= 1e6 ? '$' + f(n / 1e6, 2) + 'M' : abs >= 1e3 ? '$' + f(n / 1e3, 1) + 'K' : '$' + f(n, 2); };
const pct = value => { const n = Number(value); return Number.isFinite(n) ? (n > 0 ? '+' : '') + n.toFixed(Math.abs(n) >= 10 ? 0 : 1) + '%' : null; };
function coinHref(coin) { if (typeof coin.coinUrl === 'string' && coin.coinUrl.startsWith('/coin?')) return coin.coinUrl; return '/coin?mint=' + encodeURIComponent(coin.mint) + (coin.chain === 'robinhood' ? '&chain=robinhood' : ''); }
export function tapeItems(coins, now = Date.now()) {
  const rows = [];
  for (const coin of Array.isArray(coins) ? coins : []) {
    if (!coin || typeof coin.mint !== 'string' || !coin.mint) continue;
    const symbol = String(coin.symbol || coin.name || 'COIN').slice(0, 12).toUpperCase();
    const value = money(coin.marketCapUsd ?? coin.fdvUsd);
    let detail = null, tone = 'muted';
    const change = coin.stage === 'graduated' ? pct(coin.priceChange24h) : null;
    const progress = Number(coin.progressPercent);
    if (change) { detail = change; tone = change.startsWith('-') ? 'down' : 'up'; }
    else if (coin.stage === 'graduated') { detail = 'graduated'; tone = 'up'; }
    else if (Number.isFinite(progress)) { detail = Math.min(100, Math.max(0, progress)).toFixed(0) + '% bonded'; tone = 'pct'; }
    const fresh = Number(coin.createdAt) > 0 && now - Number(coin.createdAt) < FRESH_MS && now >= Number(coin.createdAt);
    rows.push({ mint: coin.mint, symbol, value, detail, tone, fresh, href: coinHref(coin), image: coinImage(coin.mint, coin.image) });
  }
  return rows;
}
function renderItems(document, track, items) {
  track.replaceChildren();
  const list = items.length ? [...items, ...items] : [];
  for (const [index, item] of list.entries()) {
    const link = document.createElement('a'); link.href = item.href; link.tabIndex = index >= items.length ? -1 : 0; if (index >= items.length) link.setAttribute('aria-hidden', 'true');
    if (item.external) { link.target = '_blank'; link.rel = 'noopener'; link.setAttribute('data-no-router', ''); }
    if (item.image) { const img = document.createElement('img'); img.src = item.image; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.width = 14; img.height = 14; img.onerror = () => img.remove(); link.append(img); }
    const symbol = document.createElement('b'); symbol.textContent = '$' + item.symbol; link.append(symbol);
    if (item.value) { const value = document.createElement('span'); value.textContent = item.value; link.append(value); }
    if (item.detail) { const detail = document.createElement('span'); detail.className = 'is-' + item.tone; detail.textContent = item.detail; link.append(detail); }
    if (item.fresh) { const fresh = document.createElement('span'); fresh.className = 'is-new'; fresh.textContent = 'NEW'; link.append(fresh); }
    track.append(link);
  }
}
export function mountSiteTape({ document, fetcher, now = Date.now } = {}) {
  if (!document?.body || document.body.dataset.page === 'admin') return null;
  // The page's own fetch (a test document without one mounts nothing and never schedules).
  if (typeof fetcher !== 'function') fetcher = document.defaultView?.fetch; if (typeof fetcher !== 'function') return null;
  if (tapes.has(document)) return tapes.get(document);
  const header = document.querySelector('.app-header'); if (!header) return null;
  const tape = document.createElement('div'); tape.className = 'site-tape'; tape.hidden = true; tape.dataset.navigationPersistent = 'true'; tape.setAttribute('aria-label', 'Live market tape');
  const inner = document.createElement('div'); inner.className = 'site-tape-inner';
  const label = document.createElement('span'); label.className = 'site-tape-label'; const dot = document.createElement('i'); dot.setAttribute('aria-hidden', 'true'); label.append(dot, document.createTextNode('LIVE'));
  const viewport = document.createElement('div'); viewport.className = 'site-tape-viewport';
  const track = document.createElement('div'); track.className = 'site-tape-track';
  viewport.append(track); inner.append(label, viewport); tape.append(inner); header.after(tape);
  const api = { element: tape, refresh };
  tapes.set(document, api);
  let timer = null, disposed = false;
  async function refresh() {
    if (disposed || typeof fetcher !== 'function') return;
    try {
      const chain = document.body.dataset.chain; const query = '/api/explore?stage=all&sort=volume&limit=' + LIMIT + (chain === 'solana' || chain === 'robinhood' ? '&chain=' + chain : '');
      const response = await fetcher(query, { headers: { accept: 'application/json' } }); if (!response?.ok) return;
      const data = await response.json(); const items = tapeItems(data?.coins, now());
      if (disposed) return;
      if (!items.length) { tape.hidden = true; return; }
      renderItems(document, track, items); tape.hidden = false;
    } catch { /* the tape is decorative: a failed refresh keeps the last one */ }
  }
  function schedule() { if (timer) clearTimeout(timer); timer = setTimeout(() => { if (document.visibilityState !== 'hidden') void refresh(); schedule(); }, REFRESH_MS); timer?.unref?.(); }
  void refresh(); schedule();
  document.addEventListener('curve-chain-applied', () => void refresh());
  api.dispose = () => { disposed = true; if (timer) clearTimeout(timer); tape.remove(); tapes.delete(document); };
  return api;
}
