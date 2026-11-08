// A launchpad's own features in the browser (src/tenant/pad.mjs): the Launches, Stats, Summit and Takeover pages, and on
// the engine's pages the coin panel (registry number, flags, bundle check, takeover), the home page's Summit card and
// the launch form's ticker check. Loaded on every page of a launchpad that switched a feature on (src/tenant/skin.mjs).
import { getLaunchpadWallet } from './launchpad-wallet.mjs';

const body = document.body, name = body.dataset.brandName || 'This launchpad', features = new Set((body.dataset.features || '').split(' ').filter(Boolean));
const $ = (selector, root = document) => root.querySelector(selector);
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) { if (value === null || value === undefined || value === false) continue; if (key === 'text') node.textContent = String(value); else if (key === 'class') node.className = value; else if (key.startsWith('on')) node.addEventListener(key.slice(2), value); else node.setAttribute(key, value === true ? '' : String(value)); }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : String(child));
  return node;
}
async function api(path, { method = 'GET', body: payload, token } = {}) {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...(token ? { 'x-control-token': token } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  const data = await response.json().catch(() => null); if (!response.ok) throw Object.assign(new Error(data?.error || 'Something went wrong. Try again.'), { status: response.status }); return data;
}
const usd = value => value === null || value === undefined || !Number.isFinite(value) ? '—' : value >= 1e6 ? '$' + (value / 1e6).toFixed(2) + 'M' : value >= 1e3 ? '$' + (value / 1e3).toFixed(1) + 'K' : '$' + Math.round(value);
const pct = value => (Math.round(value * 100) / 100).toString() + '%';
const number = no => 'No. ' + String(no).padStart(4, '0');
function ago(ms) { const s = Math.max(0, (Date.now() - ms) / 1000); return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + 'm ago' : s < 86400 ? Math.floor(s / 3600) + 'h ago' : Math.floor(s / 86400) + 'd ago'; }
const short = address => address ? address.slice(0, 4) + '…' + address.slice(-4) : '';
const avatar = (src, size = 44) => { const img = el('img', { class: 'pad-avatar', src: src || '/brand/mark.svg', alt: '', width: size, height: size, loading: 'lazy' }); img.addEventListener('error', () => { img.src = '/brand/mark.svg'; }, { once: true }); return img; };
const chip = (text, kind = '') => el('span', { class: 'pad-chip' + (kind ? ' is-' + kind : ''), text });
function flagChips(coin, { long = false } = {}) {
  const out = [];
  if (coin.founding) out.push(chip('★ Founding', 'founding'));
  if (coin.flags?.takeover) out.push(chip('Community takeover', 'takeover'));
  if (coin.flags?.lookalikeOf) out.push(chip(`Lookalike of $${coin.flags.lookalikeOf.symbol || '?'}`, 'warn'));
  if (coin.flags?.copiedImageOf) out.push(chip(long ? `Same image as $${coin.flags.copiedImageOf.symbol || '?'}` : 'Copied image', 'warn'));
  const bundle = coin.flags?.bundle;
  if (bundle?.status === 'checked') out.push(bundle.linked?.length ? chip(`${bundle.linked.length} linked early ${bundle.linked.length === 1 ? 'buyer' : 'buyers'} · ${pct(bundle.linkedHoldPct)}`, 'bad') : chip('No linked early buyers', 'good'));
  else if (bundle?.status === 'pending' && long) out.push(chip('Bundle check pending', ''));
  return out;
}
function header(label, title, lede) { return el('div', { class: 'documentation-hero pad-hero' }, el('p', { class: 'eyebrow', text: `${name} / ${label}`.toUpperCase() }), el('h1', { class: 'pad-title', text: title }), lede ? el('p', { text: lede }) : null); }
const tabs = current => el('nav', { class: 'documentation-tabs pad-tabs', 'aria-label': name }, ...[['registry', 'Launches', '/launches'], ['registry', 'Stats', '/stats'], ['summit', 'Summit', '/summit'], ['takeover', 'Takeover', '/takeover']].filter(([feature]) => features.has(feature)).map(([, label, href]) => el('a', { href, 'aria-current': href === current ? 'page' : null, text: label })));
function coinRow(coin) {
  const right = coin.graduated ? el('span', { class: 'pad-progress is-done', text: 'Graduated' }) : el('span', { class: 'pad-progress' }, el('i', {}, el('u', {})), el('small', { text: coin.progress === null || coin.progress === undefined ? '—' : `${Math.round(coin.progress)}% to graduation` }));
  const fill = right.querySelector('u'); if (fill) fill.style.width = Math.max(0, Math.min(100, coin.progress || 0)) + '%';
  return el('a', { class: 'pad-row pad-card', href: '/coin?mint=' + encodeURIComponent(coin.mint) }, avatar(coin.image),
    el('div', { class: 'pad-row-main' }, el('div', { class: 'pad-row-title' }, el('strong', { text: coin.name }), el('span', { class: 'pad-ticker', text: '$' + coin.symbol })), el('div', { class: 'pad-row-meta' }, el('span', { class: 'pad-no', text: number(coin.no) }), el('span', { text: ago(coin.createdAt) }), ...flagChips(coin))),
    el('div', { class: 'pad-row-side' }, el('strong', { class: 'pad-value', text: usd(coin.valueUsd) }), right));
}
// ---------------------------------------------------------------- /launches
async function launchesPage(root) {
  document.title = `Launches — ${name}`;
  const state = { q: '', sort: 'newest', filter: 'all', offset: 0 }, limit = 24;
  const strip = el('div', { class: 'pad-kpis' }), list = el('div', { class: 'pad-list' }), pager = el('div', { class: 'pad-pager' });
  const search = el('input', { class: 'pad-input', type: 'search', placeholder: 'Search launches: name, ticker, number or address', 'aria-label': 'Search launches' });
  const sort = el('select', { class: 'pad-input', 'aria-label': 'Sort' }, ...[['newest', 'Newest first'], ['oldest', 'Oldest first'], ['value', 'Market cap: high to low'], ['volume', 'Most traded (24h)'], ['graduation', 'Closest to graduation']].map(([v, l]) => el('option', { value: v, text: l })));
  const filters = el('div', { class: 'pad-filters' }, ...[['all', 'All coins'], ['bonding', 'Bonding'], ['graduated', 'Graduated'], ['new', 'Launched < 10 min'], ['founding', '★ Founding'], ...(features.has('bundleCheck') ? [['clean', 'No linked early buyers']] : [])].map(([v, l]) => el('button', { type: 'button', class: 'pad-filter', 'data-filter': v, 'aria-pressed': v === 'all' ? 'true' : 'false', text: l })));
  root.replaceChildren(tabs('/launches'), header('Launches', 'Every launch, on the record.', `Every coin launched on ${name}, numbered in order. The first 100 are its Founding coins.`), strip, el('div', { class: 'pad-controls' }, search, sort), filters, list, pager);
  let timer = 0;
  async function load() {
    const params = new URLSearchParams({ q: state.q, sort: state.sort, filter: state.filter, offset: String(state.offset), limit: String(limit) });
    try {
      const data = await api('/api/pad/registry?' + params);
      strip.replaceChildren(kpi('Registered', data.registered.toLocaleString()), kpi('Founding seats left', String(data.foundingLeft)), kpi('Showing', data.total.toLocaleString()));
      list.replaceChildren(...(data.coins.length ? data.coins.map(coinRow) : [el('p', { class: 'pad-empty', text: state.q || state.filter !== 'all' ? 'No launches match.' : 'No coins yet. The first one is No. 0001.' })]));
      const pages = Math.max(1, Math.ceil(data.total / limit)), page = Math.floor(state.offset / limit) + 1;
      pager.replaceChildren(el('button', { type: 'button', class: 'pad-btn', disabled: page <= 1, text: '← Newer', onclick: () => { state.offset = Math.max(0, state.offset - limit); void load(); } }), el('span', { text: `Page ${page} of ${pages}` }), el('button', { type: 'button', class: 'pad-btn', disabled: page >= pages, text: 'Older →', onclick: () => { state.offset += limit; void load(); } }));
    } catch (error) { list.replaceChildren(el('p', { class: 'pad-empty', text: error.message })); }
  }
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.q = search.value.trim(); state.offset = 0; void load(); }, 250); });
  sort.addEventListener('change', () => { state.sort = sort.value; state.offset = 0; void load(); });
  filters.addEventListener('click', event => { const button = event.target.closest('[data-filter]'); if (!button) return; state.filter = button.dataset.filter; state.offset = 0; for (const b of filters.children) b.setAttribute('aria-pressed', String(b === button)); void load(); });
  await load(); setInterval(() => { if (!document.hidden) void load(); }, 30000);
}
const kpi = (label, value) => el('div', { class: 'pad-kpi pad-card' }, el('small', { text: label }), el('strong', { text: value }));
// ---------------------------------------------------------------- /stats
async function statsPage(root) {
  document.title = `Stats — ${name}`;
  const data = await api('/api/pad/stats');
  const list = (title, rows, metric) => el('section', { class: 'pad-section' }, el('h2', { text: title }), rows.length ? el('ol', { class: 'pad-ranks' }, ...rows.map((coin, i) => el('li', {}, el('a', { href: '/coin?mint=' + encodeURIComponent(coin.mint), class: 'pad-rank' }, el('b', { text: String(i + 1) }), avatar(coin.image, 32), el('span', { class: 'pad-rank-name' }, el('strong', { text: coin.name }), el('small', { text: '$' + coin.symbol + ' · ' + number(coin.no) })), el('span', { class: 'pad-rank-metric', text: metric(coin) }))))) : el('p', { class: 'pad-empty', text: 'Nothing here yet.' }));
  root.replaceChildren(tabs('/stats'), header('Stats', 'The numbers.', `Everything launched on ${name}, live from the chain.`),
    el('div', { class: 'pad-kpis' }, kpi('Coins', data.coins.toLocaleString()), kpi('Graduated', data.graduated.toLocaleString()), kpi('Launched today', data.launched24h.toLocaleString()), kpi('24h volume', usd(data.volume24h)), kpi('Combined market cap', usd(data.valueUsd)), ...(data.clean ? [kpi('No linked early buyers', `${data.clean.clean} of ${data.clean.checked}`)] : [])),
    el('div', { class: 'pad-columns' }, list('Biggest coins', data.biggest, coin => usd(coin.valueUsd)), list('Most traded today', data.busiest, coin => usd(coin.volume24h)), list('Recent graduations', data.graduations, coin => usd(coin.valueUsd)), list('Newest', data.newest, coin => ago(coin.createdAt))));
}
// ---------------------------------------------------------------- /summit
async function summitPage(root) {
  document.title = `Summit — ${name}`;
  const data = await api('/api/pad/summit'), coin = data.today;
  const countdown = el('strong', { class: 'pad-countdown' });
  const tick = () => { const s = Math.max(0, Math.floor((data.nextDraw - Date.now()) / 1000)); countdown.textContent = `${String(Math.floor(s / 3600)).padStart(2, '0')}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`; };
  tick(); setInterval(tick, 1000);
  const hero = coin ? el('a', { class: 'pad-summit pad-card', href: '/coin?mint=' + encodeURIComponent(coin.mint) }, el('span', { class: 'pad-summit-badge', text: '▲ Holding the summit' }), avatar(coin.image, 120), el('div', { class: 'pad-summit-body' }, el('h2', { class: 'pad-title', text: coin.name }), el('p', { class: 'pad-ticker', text: '$' + coin.symbol + ' · ' + number(coin.no) }), el('div', { class: 'pad-summit-stats' }, kpi('Market cap', usd(coin.valueUsd)), kpi('24h volume', usd(coin.volume24h)), kpi('Odds today', coin.odds ? `1 in ${Math.max(1, Math.round(1 / coin.odds))}` : '—')), el('div', { class: 'pad-row-meta' }, ...flagChips(coin))))
    : el('div', { class: 'pad-summit pad-card is-empty' }, el('h2', { class: 'pad-title', text: 'No coin holds the summit yet.' }), el('p', { text: 'The first draw happens as soon as a coin has a market.' }));
  root.replaceChildren(tabs('/summit'), header('Summit', 'One coin holds the summit.', `Each day one coin launched on ${name} is drawn to hold the summit for 24 hours.`), hero,
    el('div', { class: 'pad-next pad-card' }, el('span', { text: 'Next draw in' }), countdown),
    el('section', { class: 'pad-section' }, el('h2', { text: 'How the draw works' }), el('ul', {}, el('li', { text: 'A new coin is drawn every day at 00:00 UTC and holds the summit for the whole day.' }), el('li', { text: 'The draw is random, but a bigger market cap, more trading in the last 24 hours and being new all raise a coin’s odds.' }), el('li', { text: 'Coins flagged as copies, or whose early buyers are linked to their creator, are left out.' }))),
    el('section', { class: 'pad-section' }, el('h2', { text: 'Earlier summits' }), data.history.length ? el('div', { class: 'pad-list' }, ...data.history.map(row => { const node = coinRow(row.coin); node.querySelector('.pad-row-meta').prepend(el('span', { class: 'pad-day', text: row.day })); return node; })) : el('p', { class: 'pad-empty', text: 'The first summit is today.' })));
}
// ---------------------------------------------------------------- /takeover
function readImage(file, { width, height, type = 'image/png', cover = true }) {
  return new Promise((resolve, reject) => { if (!file) return resolve(''); if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return reject(new Error('Pick a PNG, JPEG or WebP image.')); createImageBitmap(file).then(bitmap => { const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const ctx = canvas.getContext('2d'); const scale = cover ? Math.max(width / bitmap.width, height / bitmap.height) : Math.min(width / bitmap.width, height / bitmap.height), w = width / scale, h = height / scale; ctx.drawImage(bitmap, (bitmap.width - w) / 2, (bitmap.height - h) / 2, w, h, 0, 0, width, height); resolve(canvas.toDataURL(type, 0.88)); }, () => reject(new Error('That image could not be read.'))); });
}
async function sha256Hex(text) { const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)); return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function takeoverPage(root) {
  document.title = `Community takeover — ${name}`;
  const config = await api('/api/pad/config'), params = new URLSearchParams(location.search);
  const mintInput = el('input', { class: 'pad-input', name: 'mint', placeholder: 'Coin address', value: params.get('mint') || '', autocomplete: 'off', spellcheck: 'false' });
  const logoInput = el('input', { type: 'file', class: 'pad-input', accept: 'image/png,image/jpeg,image/webp' }), bannerInput = el('input', { type: 'file', class: 'pad-input', accept: 'image/png,image/jpeg,image/webp' });
  const x = el('input', { class: 'pad-input', placeholder: 'https://x.com/…' }), telegram = el('input', { class: 'pad-input', placeholder: 'https://t.me/…' }), website = el('input', { class: 'pad-input', placeholder: 'https://…' });
  const description = el('textarea', { class: 'pad-input', rows: '4', maxlength: '500', placeholder: 'What the coin is about, in the holders’ words.' });
  const status = el('p', { class: 'pad-status', role: 'status' }), walletBox = el('div', { class: 'pad-wallets' }), submit = el('button', { type: 'submit', class: 'pad-btn is-primary', text: 'Sign and send the request' });
  const wallet = getLaunchpadWallet();
  const renderWallets = () => { const s = wallet.state(); walletBox.replaceChildren(s.address ? el('span', { class: 'pad-chip is-good', text: 'Signing with ' + short(s.address) }) : el('span', {}, ...(s.wallets.length ? s.wallets.map(row => el('button', { type: 'button', class: 'pad-btn', text: row.name, onclick: async () => { try { await wallet.connect(row.id); renderWallets(); } catch (error) { status.textContent = error.message; } } })) : [el('small', { text: s.discovering ? 'Looking for wallets…' : 'No browser wallet found. Open this page in your wallet’s browser.' })]))); };
  wallet.onChange?.(renderWallets); renderWallets();
  const form = el('form', { class: 'pad-form pad-card' },
    el('label', {}, el('span', { text: 'Coin' }), mintInput), el('div', { class: 'pad-field' }, el('span', { text: 'Wallet that holds it' }), walletBox),
    el('label', {}, el('span', { text: 'New logo (square)' }), logoInput), el('label', {}, el('span', { text: 'New banner (3:1)' }), bannerInput),
    el('div', { class: 'pad-grid3' }, el('label', {}, el('span', { text: 'X' }), x), el('label', {}, el('span', { text: 'Telegram' }), telegram), el('label', {}, el('span', { text: 'Website' }), website)),
    el('label', {}, el('span', { text: 'Description' }), description), el('p', { class: 'pad-note', text: `Leave anything blank to keep it. Your wallet signs the request (no transaction, no fee). It needs ${config.minHoldPct}% or more of the coin. ${name}'s owner reviews every request.` }), submit, status);
  form.addEventListener('submit', async event => {
    event.preventDefault(); status.textContent = ''; submit.disabled = true;
    try {
      const address = wallet.state().address; if (!address) throw new Error('Connect the wallet that holds the coin.');
      const logo = await readImage(logoInput.files?.[0], { width: 512, height: 512 }), banner = await readImage(bannerInput.files?.[0], { width: 1500, height: 500, type: 'image/jpeg' });
      const request = { mint: mintInput.value.trim(), logo, banner, links: { x: x.value.trim(), telegram: telegram.value.trim(), website: website.value.trim() }, description: description.value.trim() };
      const payload = { mint: request.mint, logo: logo ? await sha256Hex(logo) : '', banner: banner ? await sha256Hex(banner) : '', links: request.links, description: request.description };
      const at = Date.now(), message = `Community takeover request\nLaunchpad: ${location.host}\nCoin: ${request.mint}\nRequest: ${await sha256Hex(JSON.stringify(payload))}\nTime: ${new Date(at).toISOString()}`;
      status.textContent = 'Approve the message in your wallet…';
      const signature = await wallet.signMessage(message);
      await api('/api/pad/takeover', { method: 'POST', body: { ...request, wallet: address, at, signature } });
      status.textContent = `Sent. ${name}'s owner will review it; once approved the coin page shows a Community takeover badge.`; form.reset();
    } catch (error) { status.textContent = error.message; } finally { submit.disabled = false; }
  });
  root.replaceChildren(tabs('/takeover'), header('Takeover', 'Community takeover.', `When a coin’s creator walks away, its holders can give it a new look. Ask for a new logo, banner, links and description; ${name}'s owner approves it.`), form);
  void adminQueue(root);
}
async function adminQueue(root) {
  let session; try { session = await api('/api/session'); } catch { return; } if (session?.account?.role !== 'admin' || !session.token) return;
  const box = el('section', { class: 'pad-section pad-admin' });
  async function load() {
    try {
      const data = await api('/api/admin/pad/takeovers', { token: session.token });
      const decide = (id, approve) => async () => { try { await api('/api/admin/pad/takeovers/decide', { method: 'POST', body: { id, approve }, token: session.token }); await load(); } catch (error) { box.prepend(el('p', { class: 'pad-status', role: 'alert', text: error.message })); } };
      const pending = data.requests.filter(row => row.status === 'pending');
      box.replaceChildren(el('h2', { text: `Waiting for you (${pending.length})` }), ...(pending.length ? pending.map(row => el('div', { class: 'pad-request pad-card' }, row.logo ? el('img', { src: row.logo, alt: '', class: 'pad-avatar', width: 64, height: 64 }) : null, el('div', {}, el('strong', { text: '$' + row.symbol }), el('small', { text: ` · ${short(row.wallet)} holds ${pct(row.holdsPct)} · ${ago(row.at)}` }), row.banner ? el('img', { src: row.banner, alt: '', class: 'pad-banner' }) : null, row.description ? el('p', { text: row.description }) : null, el('p', { class: 'pad-note', text: Object.values(row.links).filter(Boolean).join(' · ') })), el('div', { class: 'pad-actions' }, el('button', { type: 'button', class: 'pad-btn is-primary', text: 'Approve', onclick: decide(row.id, true) }), el('button', { type: 'button', class: 'pad-btn', text: 'Reject', onclick: decide(row.id, false) })))) : [el('p', { class: 'pad-empty', text: 'No requests are waiting.' })]));
    } catch (error) { box.replaceChildren(el('p', { class: 'pad-empty', text: error.message })); }
  }
  root.append(box); await load();
}
// ---------------------------------------------------------------- the coin page panel
async function coinPanel() {
  const mint = new URLSearchParams(location.search).get('mint'); if (!mint) return;
  let coin; try { coin = await api('/api/pad/coin?mint=' + encodeURIComponent(mint)); } catch { return; }
  const main = $('#coin-main'); if (!main || $('.pad-coin', main)) return;
  const bundle = coin.flags?.bundle, takeover = coin.takeover;
  const panel = el('section', { class: 'pad-coin pad-card', 'aria-label': `${name} record` },
    el('div', { class: 'pad-coin-head' }, coin.registry ? el('span', { class: 'pad-no is-big', text: number(coin.no) }) : null, coin.summit ? chip('▲ Holding the summit today', 'summit') : null, ...flagChips(coin, { long: true }), coin.lockedUntil ? chip(`Ticker locked until ${new Date(coin.lockedUntil).toUTCString().slice(5, 22)} UTC`, '') : null),
    takeover ? el('div', { class: 'pad-takeover' }, takeover.banner ? el('img', { class: 'pad-banner', src: takeover.banner, alt: '' }) : null, el('div', { class: 'pad-takeover-body' }, takeover.logo ? el('img', { class: 'pad-avatar', src: takeover.logo, alt: '', width: 56, height: 56 }) : null, el('div', {}, el('strong', { text: 'Community takeover' }), takeover.description ? el('p', { text: takeover.description }) : null, el('p', { class: 'pad-links' }, ...Object.entries(takeover.links || {}).filter(([, href]) => href).map(([key, href]) => el('a', { href, target: '_blank', rel: 'noopener noreferrer', 'data-no-router': '', text: key === 'x' ? 'X' : key[0].toUpperCase() + key.slice(1) })))))) : null,
    bundle?.status === 'checked' ? el('details', { class: 'pad-bundle' }, el('summary', { text: bundle.linked.length ? `Bundle check: ${bundle.linked.length} of ${bundle.buyers} early buyers are linked; they hold ${pct(bundle.linkedHoldPct)} of the supply now` : `Bundle check: none of the ${bundle.buyers} early buyers are linked to the creator or to each other` }), bundle.linked.length ? el('ul', {}, ...bundle.linked.map(row => el('li', {}, el('a', { href: 'https://solscan.io/account/' + row.wallet, target: '_blank', rel: 'noopener noreferrer', 'data-no-router': '', text: short(row.wallet) }), ` — ${row.reason}, holds ${pct(row.holdsPct)}`))) : null, el('p', { class: 'pad-note', text: 'Wallets that bought in the first 20 slots, traced to the wallets that funded them.' })) : null,
    features.has('takeover') ? el('a', { class: 'pad-link', href: '/takeover?mint=' + encodeURIComponent(mint), text: 'Hold this coin? Ask for a community takeover →' }) : null);
  main.prepend(panel);
}
// ---------------------------------------------------------------- the home page's Summit card
async function summitCard() {
  let data; try { data = await api('/api/pad/summit'); } catch { return; } if (!data.today) return;
  for (let i = 0; i < 40 && !$('#explore-coins .explore-dashboard'); i++) await new Promise(r => setTimeout(r, 250));
  const dashboard = $('#explore-coins .explore-dashboard'); if (!dashboard || $('.pad-home-summit')) return;
  const coin = data.today;
  dashboard.before(el('a', { class: 'pad-home-summit pad-card', href: '/summit' }, el('span', { class: 'pad-summit-badge', text: '▲ Summit' }), avatar(coin.image, 36), el('strong', { text: coin.name }), el('span', { class: 'pad-ticker', text: '$' + coin.symbol }), el('span', { class: 'pad-value', text: usd(coin.valueUsd) }), el('small', { text: 'holds the summit today →' })));
}
// ---------------------------------------------------------------- the launch form's ticker check
function tickerCheck() {
  const attach = () => {
    const symbol = $('#launch-main input[name="symbol"]') || $('input[name="symbol"]'), nameInput = $('#launch-main input[name="name"]') || $('input[name="name"]'); if (!symbol || symbol.dataset.padCheck) return !!symbol;
    symbol.dataset.padCheck = '1'; const note = el('p', { class: 'pad-check', role: 'status' }); (symbol.closest('label') || symbol).after(note); let timer = 0;
    const run = async () => { const ticker = symbol.value.trim(), coinName = nameInput?.value.trim() || ''; if (!ticker && !coinName) { note.textContent = ''; return; } try { const result = await api('/api/pad/check?' + new URLSearchParams({ ticker, name: coinName })); note.className = 'pad-check' + (result.locked ? ' is-bad' : result.lookalike ? ' is-warn' : ''); note.textContent = result.locked ? (result.locked.until ? `$${result.locked.symbol} took this ${result.locked.field} here; it is locked until ${new Date(result.locked.until).toUTCString().slice(5, 22)} UTC.` : `That ${result.locked.field} belongs to $${result.locked.symbol}, which is still active here.`) : result.lookalike ? `Looks like $${result.lookalike.symbol} (${number(result.lookalike.no)}). You can launch it, but the coin page will flag it as a lookalike.` : ''; } catch { note.textContent = ''; } };
    for (const input of [symbol, nameInput].filter(Boolean)) input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 400); });
    return true;
  };
  let tries = 0; const timer = setInterval(() => { if (attach() || ++tries > 40) clearInterval(timer); }, 300);
}
// ---------------------------------------------------------------- start
const path = location.pathname, root = $('[data-pad-root]');
const pages = { '/launches': ['registry', launchesPage], '/stats': ['registry', statsPage], '/summit': ['summit', summitPage], '/takeover': ['takeover', takeoverPage] };
if (root && pages[path] && features.has(pages[path][0])) pages[path][1](root).catch(error => root.replaceChildren(el('p', { class: 'pad-empty', text: error.message })));
else if (path === '/coin') void coinPanel();
else if ((path === '/' || path === '/explore') && features.has('summit')) void summitCard();
else if (path.startsWith('/launchpad') && features.has('tickerLock')) tickerCheck();
