// A launchpad's shell (LAUNCHPAD_PRODUCT=tenant; <body data-product="tenant">). Runs on every public page and does
// nothing on any other product. The pages are the engine's templates under the launchpad's palette and layout
// (public/tenant.css, public/tenant-rack.css); this module dresses them — the header's mark and name, the theme switch,
// the Rack layout's nav and phone dock, the home strip, the footer's links and Powered by — keeps only the venues,
// launch modes and hooks the launchpad offers on the launch page, and keeps every visible word the launchpad's
// (public/tenant-copy.mjs), now and whenever a script changes the page.
import { createTenantCopy } from './tenant-copy.mjs';
import { VENUES, modeOnVenue } from './tenant-catalog.mjs';

const PRODUCT = 'tenant', THEME_KEY = 'pad-theme';
const ICONS = {
  explore: '<path d="M4 7h16M4 12h16M4 17h16"/><path d="M7 4v16M17 4v16"/>',
  launch: '<path d="M12 3c3.5 2.5 5 6.5 5 10.5L12 16l-5-2.5C7 9.5 8.5 5.5 12 3z"/><path d="M7 13.5 4 17l3.5-.5M17 13.5 20 17l-3.5-.5M10.5 19.5 12 22l1.5-2.5"/><circle cx="12" cy="10" r="1.6"/>',
  mine: '<path d="M12 20s-7-4.4-7-9.5A3.8 3.8 0 0 1 12 8a3.8 3.8 0 0 1 7 2.5C19 15.6 12 20 12 20z"/>',
  docs: '<path d="M6 3h9l3 3v15H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  launches: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  summit: '<path d="M3 20 9.5 8l4 7 2-3.5L21 20z"/><path d="M9.5 8V3.5l4 1.5-4 1.5"/>',
  gotchi: '<path d="M12 3c4.4 0 7.5 3.1 7.5 7.2V13a7.5 7.5 0 0 1-15 0v-2.8C4.5 6.1 7.6 3 12 3z"/><path d="M9 11h.01M15 11h.01M9.5 15c1.4 1.2 3.6 1.2 5 0"/>',
  agents: '<path d="M7 8h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3z"/><path d="M9 13h.01M15 13h.01M12 8V4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
};
/** The settings the server wrote on <body> (src/tenant/skin.mjs). */
export function readTenant(body) {
  const data = body?.dataset || {}, list = value => String(value || '').split(' ').filter(Boolean);
  return {
    name: data.brandName || 'Launchpad', layout: data.layout === 'rack' ? 'rack' : 'terminal', style: data.style || data.layout || 'terminal', themeDefault: data.themeDefault === 'light' ? 'light' : 'dark',
    hero: data.hero === 'on', features: list(data.features),
    venues: list(data.venues), modes: list(data.modes), hooks: data.hooks === 'on', logo: data.logo === 'on', poweredBy: data.poweredBy !== 'off',
    launcherName: data.launcherName || '', launcherUrl: /^https:\/\//.test(data.launcherUrl || '') ? data.launcherUrl : '', tagline: data.tagline || '',
    links: { x: /^https:\/\/x\.com\//.test(data.linkX || '') ? data.linkX : '', telegram: /^https:\/\/t\.me\//.test(data.linkTelegram || '') ? data.linkTelegram : '', website: /^https:\/\//.test(data.linkWebsite || '') ? data.linkWebsite : '' },
  };
}
/** Header links (desktop, Rack layout) and the phone dock, filtered to what the launchpad offers. */
export function navItems(tenant) {
  const features = tenant.features || [];
  return [['explore', 'Explore', '/'], ['launch', 'Launch', '/launchpad'], ...(features.includes('registry') ? [['launches', 'Launches', '/launches']] : []), ...(features.includes('summit') ? [['summit', 'Summit', '/summit']] : []), ['mine', 'My coins', '/launched-tokens'], ...(tenant.modes.includes('gotchi') ? [['gotchi', 'Gotchi', '/gotchi']] : []), ...(tenant.modes.includes('agent') ? [['agents', 'Agents', '/agents']] : []), ['docs', 'Docs', '/docs']];
}
export function currentNavKey(pathname, page) {
  if (pathname === '/' || pathname === '/explore' || page === 'explore') return 'explore';
  if (pathname.startsWith('/launchpad') || page === 'launchpad') return 'launch';
  if (pathname.startsWith('/launched-tokens')) return 'mine';
  if (pathname.startsWith('/gotchi')) return 'gotchi';
  if (pathname.startsWith('/agents')) return 'agents';
  if (pathname.startsWith('/docs')) return 'docs';
  if (pathname.startsWith('/launches') || pathname.startsWith('/stats')) return 'launches';
  if (pathname.startsWith('/summit')) return 'summit';
  return '';
}
export function readTheme(storage, fallback = 'dark') { try { const value = storage?.getItem(THEME_KEY); return value === 'light' || value === 'dark' ? value : fallback; } catch { return fallback; } }
export function writeTheme(storage, theme) { try { storage?.setItem(THEME_KEY, theme); } catch { /* a convenience */ } }
/** The launch mode a page should hold: the checked one when the launchpad offers it on this venue, else the first that is. */
export function allowedMode(tenant, venue, checked, order) {
  const ok = mode => tenant.modes.includes(mode) && modeOnVenue(mode, venue);
  return ok(checked) ? checked : order.find(ok) || null;
}

function el(document, tag, text, className) { const node = document.createElement(tag); if (text !== undefined && text !== null) node.textContent = String(text); if (className) node.className = className; return node; }
function icon(document, name) { const span = document.createElement('span'); span.className = 'tn-ic'; span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`; return span; }
const pageOf = document => document.body.dataset.page || (document.body.classList.contains('launch-page') ? 'launchpad' : '');

export function createTenantShell({ document, window, fetcher = globalThis.fetch?.bind(globalThis) } = {}) {
  if (!document?.body || document.body.dataset.product !== PRODUCT) return null;
  const tenant = readTenant(document.body), copy = createTenantCopy({ name: tenant.name, host: window.location?.host || '' });
  const storage = (() => { try { return window.localStorage; } catch { return null; } })(), html = document.documentElement;
  const markSrc = tenant.logo ? '/brand/icon-64.png' : '/brand/mark.svg';
  let theme = readTheme(storage, tenant.themeDefault), observer = null, disposed = false, headerQueued = false, launchTimer = null;
  function applyTheme(next, { remember = false } = {}) {
    theme = next === 'light' ? 'light' : 'dark'; if (theme === 'light') html.dataset.theme = 'light'; else delete html.dataset.theme; if (remember) writeTheme(storage, theme);
    for (const button of document.querySelectorAll('.tn-theme')) { if (button.dataset.tnTheme === theme) continue; button.dataset.tnTheme = theme; button.replaceChildren(icon(document, theme === 'light' ? 'moon' : 'sun')); button.setAttribute('aria-label', 'Switch to ' + (theme === 'light' ? 'dark' : 'light') + ' mode'); button.title = theme === 'light' ? 'Dark mode' : 'Light mode'; }
    try { document.dispatchEvent(new window.CustomEvent('tenant-theme-change', { detail: { theme } })); } catch { /* an old window */ }
  }
  // ---- the header: the mark and the name, the nav (Rack), the theme switch ----
  function dressHeader() {
    headerQueued = false; if (disposed) return;
    const header = document.querySelector('.app-header'); if (!header) return;
    for (const node of header.querySelectorAll('.curve-price-badge, .site-chain-toggle, a[href="/analytics"]')) node.remove();
    if (!tenant.modes.includes('gotchi')) header.querySelector('.gotchi-nav')?.remove();
    if (!tenant.modes.includes('agent')) header.querySelector('.agents-nav')?.remove();
    const brand = header.querySelector('.brand');
    if (brand && !brand.querySelector('.tn-mark')) {
      const mark = el(document, 'img', null, 'tn-mark'); mark.src = markSrc; mark.alt = ''; mark.width = 36; mark.height = 36; mark.decoding = 'async';
      brand.replaceChildren(mark, el(document, 'span', tenant.name, 'tn-name')); brand.href = '/'; brand.setAttribute('aria-label', tenant.name + ' home');
    }
    const local = header.querySelector('.local'); if (!local) return;
    let nav = local.querySelector('.tn-nav');
    // Rack carries the whole nav; Terminal keeps its plain header and gets only the feature pages (Launches, Summit).
    const items = tenant.layout === 'rack' ? navItems(tenant).filter(([key]) => key !== 'launch') : navItems(tenant).filter(([key]) => key === 'launches' || key === 'summit');
    if (!nav && items.length) { nav = el(document, 'nav', null, tenant.layout === 'rack' ? 'tn-nav' : 'tn-nav tn-padnav'); nav.setAttribute('aria-label', tenant.name); for (const [key, label, href] of items) { const a = el(document, 'a', null, 'tn-item'); a.href = href; a.dataset.tnKey = key; a.title = label; a.append(icon(document, key), el(document, 'span', label)); nav.append(a); } }
    let toggle = local.querySelector('.tn-theme');
    if (!toggle) { toggle = el(document, 'button', null, 'tn-theme'); toggle.type = 'button'; toggle.onclick = () => applyTheme(theme === 'light' ? 'dark' : 'light', { remember: true }); }
    if (nav) { if (local.firstElementChild !== nav || nav.nextElementSibling !== toggle) local.prepend(nav, toggle); }
    else if (local.firstElementChild !== toggle) local.prepend(toggle);
    applyTheme(theme); markCurrent();
  }
  function mountBar() {
    if (tenant.layout !== 'rack' || document.querySelector('.tn-bar')) return;
    const bar = el(document, 'nav', null, 'tn-bar'); bar.setAttribute('aria-label', tenant.name); bar.dataset.navigationPersistent = 'true';
    for (const [key, label, href] of navItems(tenant).filter(([key]) => key !== 'docs').slice(0, 5)) { const a = el(document, 'a', null, 'tn-item'); a.href = href; a.dataset.tnKey = key; a.append(icon(document, key), el(document, 'span', label)); bar.append(a); }
    document.body.append(bar);
  }
  function markCurrent() { const key = currentNavKey(window.location.pathname, pageOf(document)); for (const a of document.querySelectorAll('.tn-item')) { if (a.dataset.tnKey === key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); } }
  // ---- the footer: the mark, the launchpad's own links, Powered by ----
  function dressFooter() {
    const footer = document.querySelector('footer.site-footer'); if (!footer) return;
    footer.querySelector('a[href="/analytics"]')?.remove();
    const brand = footer.querySelector('.site-footer-brand');
    if (brand && !brand.querySelector('img')) { const img = el(document, 'img'); img.src = markSrc; img.alt = ''; img.width = 26; img.height = 26; brand.replaceChildren(img, el(document, 'span', tenant.name)); brand.setAttribute('aria-label', tenant.name + ' home'); brand.href = '/'; }
    const social = footer.querySelector('.site-footer-social');
    if (social && social.dataset.tnDressed !== 'true') { social.dataset.tnDressed = 'true'; if (tenant.links.x) { social.href = tenant.links.x; social.title = tenant.name + ' on X'; social.setAttribute('aria-label', tenant.name + ' on X (opens in a new tab)'); } else social.remove(); }
    const links = footer.querySelector('.site-footer-links');
    if (links && !links.querySelector('.tn-pad-link')) links.prepend(...[['registry', 'Launches', '/launches'], ['registry', 'Stats', '/stats'], ['summit', 'Summit', '/summit'], ['takeover', 'Takeover', '/takeover']].filter(([feature]) => (tenant.features || []).includes(feature)).map(([, label, href]) => { const a = el(document, 'a', label, 'tn-pad-link'); a.href = href; return a; }));
    if (links && !links.querySelector('.tn-social, .tn-powered-wrap')) {
      for (const [label, href] of [['Telegram', tenant.links.telegram], ['Website', tenant.links.website]]) if (href) { const a = el(document, 'a', label, 'tn-social'); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.setAttribute('data-no-router', ''); links.append(a); }
      if (tenant.poweredBy && tenant.launcherName) { const wrap = el(document, 'span', null, 'tn-powered-wrap'); const a = el(document, tenant.launcherUrl ? 'a' : 'span', null, 'tn-powered'); if (tenant.launcherUrl) { a.href = tenant.launcherUrl; a.target = '_blank'; a.rel = 'noopener'; a.setAttribute('data-no-router', ''); a.title = 'Make your own launchpad with ' + tenant.launcherName; } a.append('Powered by ', el(document, 'b', tenant.launcherName)); wrap.append(a); links.append(wrap); }
    }
  }
  // ---- home: the hero strip (Rack layout) ----
  function dressExplore() {
    const root = document.getElementById('explore-coins'); if (!root) return;
    document.title = tenant.name + (tenant.tagline ? ' — ' + tenant.tagline : ' — Launch a coin');
    // The owner's hero banner (any layout) on top of the page.
    if (tenant.hero && !root.querySelector('.tn-hero')) { const top = root.querySelector('.explore-dashboard'); if (top) { const banner = el(document, 'a', null, 'tn-hero'); banner.href = '/launchpad'; const img = el(document, 'img'); img.src = '/brand/hero.jpg'; img.alt = tenant.name; img.decoding = 'async'; banner.append(img); top.before(banner); } }
    if (tenant.layout !== 'rack' || root.querySelector('.tn-strip')) return;
    const dashboard = root.querySelector('.explore-dashboard'); if (!dashboard) return;
    const strip = el(document, 'section', null, 'tn-strip'); strip.setAttribute('aria-label', tenant.name);
    const hero = el(document, 'a', null, 'tn-tile tn-tile-hero'); hero.href = '/launchpad'; hero.append(el(document, 'span', tenant.name, 'tn-tile-label'), el(document, 'strong', 'Launch a coin', 'tn-tile-value'), el(document, 'small', tenant.tagline || 'Name it, give it a face, launch it.', 'tn-tile-note'));
    const venues = el(document, 'div', null, 'tn-tile'), chips = el(document, 'div', null, 'tn-tile-venues');
    for (const venue of VENUES.filter(row => tenant.venues.includes(row.id))) { const chip = el(document, 'span'); const img = el(document, 'img'); img.src = venue.icon; img.alt = ''; img.width = 16; img.height = 16; chip.append(img, venue.label); chips.append(chip); }
    venues.append(el(document, 'span', 'Launch on', 'tn-tile-label'), chips, el(document, 'small', tenant.venues.length > 1 ? 'Pick the venue when you launch.' : 'Every coin here launches on it.', 'tn-tile-note'));
    const count = el(document, 'strong', '—', 'tn-tile-value'); count.dataset.tnCount = '';
    const coins = el(document, 'a', null, 'tn-tile'); coins.href = '/launched-tokens'; coins.append(el(document, 'span', 'Coins launched here', 'tn-tile-label'), count, el(document, 'small', 'Your own are under My coins.', 'tn-tile-note'));
    strip.append(hero, venues, coins); dashboard.before(strip); void refreshCount();
  }
  async function refreshCount() {
    const node = document.querySelector('[data-tn-count]'); if (!node || typeof fetcher !== 'function') return;
    try { const response = await fetcher('/api/explore?stage=all&limit=1', { credentials: 'same-origin', headers: { accept: 'application/json' } }); const data = response.ok ? await response.json() : null; const total = Number(data?.total ?? data?.counts?.all ?? data?.count); node.textContent = Number.isFinite(total) && total >= 0 ? total.toLocaleString('en-US') : '—'; } catch { node.textContent = '—'; }
  }
  // ---- the launch page: the launchpad's venues and launch modes only ----
  function dressLaunch() {
    const form = document.getElementById('launch-form'); if (!form) return;
    document.title = tenant.name + ' — Launch a coin';
    const names = new Map(VENUES.map(venue => [venue.label.toLowerCase(), venue.id]));
    for (const li of document.querySelectorAll('.launch-welcome-venues li')) { const id = names.get(li.textContent.trim().toLowerCase()); if (id && !tenant.venues.includes(id)) li.setAttribute('data-tn-off', ''); }
    keepLaunchChoices();
    window.clearInterval(launchTimer); launchTimer = window.setInterval(keepLaunchChoices, 1500);
  }
  // A launch mode the launchpad does not offer is never left selected (the server refuses it anyway).
  function keepLaunchChoices() {
    const form = document.getElementById('launch-form'); if (!form || disposed) { window.clearInterval(launchTimer); return; }
    const pressed = document.querySelector('[data-launch-venue][aria-pressed="true"]')?.dataset.launchVenue;
    if (pressed && !tenant.venues.includes(pressed)) { const next = document.querySelector(tenant.venues.map(id => `[data-launch-venue="${id}"]`).join(',')); if (next && !next.disabled) { next.click(); return; } }
    const venue = pressed && tenant.venues.includes(pressed) ? pressed : tenant.venues[0];
    const radios = [...form.querySelectorAll('input[name="feeMode"]')], checked = radios.find(radio => radio.checked)?.value;
    const target = allowedMode(tenant, venue, checked, radios.filter(radio => !radio.disabled).map(radio => radio.value));
    if (target && target !== checked) { const radio = radios.find(row => row.value === target); if (radio && !radio.disabled) radio.click(); }
  }
  function dress() {
    dressHeader(); dressFooter(); markCurrent();
    const page = pageOf(document);
    if (page === 'explore') dressExplore();
    if (page === 'launchpad') dressLaunch();
  }
  // Only what changed is rewritten; a rewrite never matches again, so the observer settles at once.
  const COPY_ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt'];
  // Coin names and tickers are the creators' words: a coin named "Launchpad Cat" keeps its name.
  const USER_CONTENT = 'a[href^="/coin?mint="], [class*="coin-name"], [class*="coin-symbol"], [class*="token-name"], [class*="token-symbol"], [class*="hero-name"], .site-tape-track, [data-coin-name]';
  // Badges and chips inside a coin card are the platform's labels ("Hooked", the trade-route marker), not the creator's.
  const PLATFORM_COPY = '[class*="badge"], [class*="chip"]';
  const userContent = node => {
    const element = node?.nodeType === 1 ? node : node?.parentElement, owner = element?.closest?.(USER_CONTENT);
    if (!owner) return false;
    const label = element.closest(PLATFORM_COPY);
    return !(label && owner.contains(label) && !label.matches(USER_CONTENT));
  };
  function rebrandNode(node) {
    if (!node) return;
    const text = n => { if (copy.needsRebrand(n.nodeValue) && !userContent(n)) n.nodeValue = copy.rebrandCopy(n.nodeValue); };
    const attributes = e => { for (const name of COPY_ATTRIBUTES) { const value = e.getAttribute?.(name); if (value && copy.needsRebrand(value) && !userContent(e)) e.setAttribute(name, copy.rebrandCopy(value)); } if (e.tagName === 'IMG' && /^\/brand-(?:icon|logo|avatar)\./.test(e.getAttribute('src') || '')) e.setAttribute('src', markSrc); };
    if (node.nodeType === 3) { if (!['SCRIPT', 'STYLE'].includes(node.parentNode?.tagName)) text(node); return; }
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
    if (node.nodeType === 1) { if (['SCRIPT', 'STYLE'].includes(node.tagName)) return; attributes(node); }
    const walker = (node.ownerDocument || node).createTreeWalker(node, 5);
    for (let current = walker.nextNode(); current; current = walker.nextNode()) { if (current.nodeType === 3) { if (!['SCRIPT', 'STYLE'].includes(current.parentNode?.tagName)) text(current); } else attributes(current); }
  }
  function watch() {
    rebrandNode(document.documentElement);
    if (typeof window.MutationObserver !== 'function') return;
    observer = new window.MutationObserver(records => {
      if (disposed) return; let chrome = false;
      for (const record of records) {
        if (record.type === 'childList') for (const node of record.addedNodes) rebrandNode(node); else rebrandNode(record.target);
        if (!chrome && record.target?.closest?.('.app-header, footer.site-footer')) chrome = true;
        if (!chrome) for (const node of record.addedNodes || []) if (node.nodeType === 1 && (node.matches?.('.app-header, footer.site-footer') || node.querySelector?.('.app-header, footer.site-footer'))) chrome = true;
      }
      if (chrome && !headerQueued) { headerQueued = true; (window.requestAnimationFrame || window.setTimeout)(() => { dressHeader(); dressFooter(); }); }
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...COPY_ATTRIBUTES, 'src'] });
  }
  function start() { applyTheme(theme); mountBar(); watch(); dress(); document.addEventListener('curve-navigation-complete', dress); return api; }
  function destroy() { disposed = true; window.clearInterval(launchTimer); observer?.disconnect(); document.removeEventListener('curve-navigation-complete', dress); }
  const api = { start, destroy, applyTheme, dress, tenant, get theme() { return theme; } };
  return api;
}

// The theme applies before the first paint where the module runs early enough; the shell then dresses the page.
if (typeof document !== 'undefined' && document.defaultView && document.body?.dataset.product === PRODUCT) {
  const boot = () => createTenantShell({ document, window: document.defaultView })?.start();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
}
