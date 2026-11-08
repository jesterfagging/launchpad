// Launchpad motion layer v2: entrance reveals, live-number animation, tactile
// feedback, ambient depth and a small set of opt-in hooks (float, tilt,
// sparkle, bars, glow, live dots, shimmer, Gotchi peeks, celebrations) for
// every page. Purely decorative. It never changes the meaning of a value:
// animated numbers always settle on the exact text the page rendered, bars
// end on their real width, and nothing here reads or writes application
// state. Reduced motion degrades everything to the static design.
// CSP-safe: no inline styles in markup, only CSSOM custom properties.
// Hooks: the data-motion-* attributes below.

const REVEAL = [
  '.explore-coin', '.explore-mini-coin', '.explore-leaders > div > *', '.explore-contenders li',
  '.coin-overview', '.coin-chart-card', '.coin-trade-panel', '.coin-info', '.token-info-card',
  '.analytics-metric', '.analytics-card', '.analytics-section',
  '.documentation-card', '.documentation-section',
  '.token-card', '.token-launch-card', '.launch-section', '.launch-welcome-card',
  '.admin-card', '.admin-overview > *', '.launch-admin-row', '.admin-stat',
  '.card', '[data-motion-reveal]',
].join(',');
const SPOTLIGHT = '.explore-coin,.explore-mini-coin,.token-launch-card,.documentation-card,.analytics-metric,.admin-card,[data-motion-spotlight]';
const NUMBERS = [
  '.analytics-metric-value', '.analytics-metric strong', '.curve-price-value', '.explore-feature-price', '.explore-feature-stats strong',
  '.explore-coin-cap', '.explore-coin-mcap', '.explore-mini-coin-value', '.coin-price', '.coin-fdv', '.coin-stats strong', '.coin-stat-value',
  '.coin-market-value', '.market-value', '.admin-stat strong', '.admin-overview strong', '.admin-metric-value', '[data-motion-number]',
].join(',');
const RIPPLE = '.primary,.top-launch,[data-motion-ripple]';
const TILT = '[data-motion-tilt]', BAR = '[data-motion-bar]', SPARKLE = '[data-motion-sparkle]';
// Reveals are a first-paint effect. Anything registered later than the initial
// window simply appears; anything still waiting for a scroll after the cap is
// shown without animation, so no page is ever incomplete at rest.
const INITIAL_WINDOW_MS = 2600, REVEAL_CAP_MS = 1000, FAILSAFE_MS = 400;
const CELEBRATE_MS = 1500;
const SUNRISE = ['#ddd3ff', '#a78bff', '#8b5cff', '#7c4dff', '#6d45d9', '#4b2fa0', '#2ee59d'];
// A white-label launchpad's confetti is its own ramp (public/tenant.css carries it as --tn-* tokens).
function confettiColours() {
  try { const style = getComputedStyle(document.body), ramp = ['--tn-cream', '--tn-acc-soft', '--tn-acc', '--tn-acc-strong', '--tn-mauve', '--tn-deep'].map(name => style.getPropertyValue(name).trim()).filter(value => /^#[0-9a-f]{6}$/i.test(value)); return ramp.length === 6 ? [...ramp, '#2ee59d'] : SUNRISE; } catch { return SUNRISE; }
}
const GOTCHI_THEMES = ['fomogotchi', 'pumpgotchi'];

const reduced = () => { try { return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true; } catch { return false; } };
const raf = fn => (globalThis.requestAnimationFrame || (cb => setTimeout(cb, 16)))(fn);
const now = () => globalThis.performance?.now?.() ?? Date.now();

// Parse "$1,234.56K", "12.3%", "≈$4.1M", "0.000041" into a tweenable number.
const NUMBER = /^(\D*?)(-?)(\d[\d,]*)(?:\.(\d+))?(\D*)$/;
export function parseDisplayNumber(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  if (!value || value.length > 40) return null;
  const match = NUMBER.exec(value);
  if (!match) return null;
  const [, prefix, sign, whole, fraction = '', suffix] = match;
  if (/\d/.test(prefix) || /\d/.test(suffix)) return null;
  const number = Number((sign ? '-' : '') + whole.replace(/,/g, '') + (fraction ? '.' + fraction : ''));
  if (!Number.isFinite(number)) return null;
  return { prefix, suffix, number, decimals: fraction.length, grouped: whole.includes(',') };
}
export function formatDisplayNumber(shape, value) {
  const fixed = Math.abs(value).toFixed(shape.decimals);
  let [whole, fraction] = fixed.split('.');
  if (shape.grouped) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return shape.prefix + (value < 0 ? '-' : '') + whole + (fraction ? '.' + fraction : '') + shape.suffix;
}

// The fraction a progress bar's fill should show: its own `--value` (0–1 or a
// percentage), aria-valuenow / aria-valuemax, a <progress> value, or null when
// the fill's rendered width is the only source of truth.
export function barFraction(node, fill) {
  const read = (element, name) => { try { return element?.style?.getPropertyValue?.(name) || globalThis.getComputedStyle?.(element)?.getPropertyValue?.(name) || ''; } catch { return ''; } };
  for (const element of [node, fill]) {
    const value = read(element, '--value').trim();
    if (value) { const number = parseFloat(value); if (Number.isFinite(number)) return Math.min(1, Math.max(0, value.endsWith('%') ? number / 100 : number > 1 ? number / 100 : number)); }
  }
  for (const element of [node, fill]) {
    if (!element?.getAttribute) continue;
    const current = parseFloat(element.getAttribute('aria-valuenow') ?? ''), max = parseFloat(element.getAttribute('aria-valuemax') ?? '100'), min = parseFloat(element.getAttribute('aria-valuemin') ?? '0');
    if (Number.isFinite(current) && Number.isFinite(max) && max > min) return Math.min(1, Math.max(0, (current - min) / (max - min)));
  }
  return null;
}

export function startMotion({ document = globalThis.document, window = globalThis.window } = {}) {
  if (!document?.documentElement || document.documentElement.dataset.motion === 'on') return null;
  const root = document.documentElement;
  root.dataset.motion = 'on';
  root.classList.add('motion-ready');
  let windowStart = now(), disposed = false;
  const seen = new WeakSet(), counting = new WeakMap(), lastText = new WeakMap(), waiting = [];
  const motionQuery = (() => { try { return window.matchMedia?.('(prefers-reduced-motion: reduce)') || null; } catch { return null; } })();
  const finePointer = () => { try { return window.matchMedia?.('(hover: hover) and (pointer: fine)').matches === true; } catch { return false; } };

  // Ambient light and scroll progress live outside page content so the router
  // never removes them.
  const ambient = document.createElement('div');
  ambient.className = 'motion-ambient'; ambient.setAttribute('aria-hidden', 'true'); ambient.dataset.navigationPersistent = 'true';
  ambient.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
  document.body.prepend(ambient);
  const progress = document.createElement('div');
  progress.className = 'motion-scroll-progress'; progress.setAttribute('aria-hidden', 'true'); progress.dataset.navigationPersistent = 'true';
  document.body.append(progress);

  // ---- Header and scroll state ----
  function header() {
    const node = document.querySelector('.app-header');
    if (!node) return null;
    if (!node.querySelector(':scope > .motion-hairline')) {
      const position = window.getComputedStyle?.(node)?.position;
      if (position && position !== 'static') { const line = document.createElement('span'); line.className = 'motion-hairline'; line.setAttribute('aria-hidden', 'true'); node.append(line); }
    }
    return node;
  }
  let scrollQueued = false;
  function scrolled() {
    if (scrollQueued) return; scrollQueued = true;
    raf(() => {
      scrollQueued = false;
      const y = window.scrollY || 0, max = Math.max(1, (document.documentElement.scrollHeight || 0) - (window.innerHeight || 0));
      header()?.classList.toggle('motion-scrolled', y > 8);
      const long = max > (window.innerHeight || 800) * 1.2;
      progress.classList.toggle('is-visible', long && y > 40);
      progress.style.setProperty('--motion-scroll', String(Math.min(1, Math.max(0, y / max))));
    });
  }
  window.addEventListener('scroll', scrolled, { passive: true });
  window.addEventListener('resize', scrolled, { passive: true });

  // ---- Entrance reveals ----
  // Elements below the fold wait (hidden) for their scroll reveal, but only
  // briefly: the cap, a failsafe sweep, printing, a hidden tab and a switch to
  // reduced motion all show everything at once. Screenshots and slow readers
  // therefore always get a complete page.
  const observer = 'IntersectionObserver' in window ? new window.IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      reveal(entry.target, 0);
    }
  }, { rootMargin: '0px 0px 18% 0px', threshold: 0.01 }) : null;
  function reveal(node, index) {
    node.classList.remove('motion-pending');
    node.style.setProperty('--motion-i', String(index));
    node.classList.add('motion-in');
    const done = () => { node.classList.remove('motion-in'); node.style.removeProperty('--motion-i'); };
    node.addEventListener('animationend', done, { once: true });
    setTimeout(done, 1200);
  }
  function staggerMain() {
    const main = document.querySelector('main');
    if (!main) return;
    let index = 0;
    for (const child of main.children) child.style?.setProperty('--motion-index', String(index++));
  }
  let capTimer = null, failsafeTimer = null;
  function register(nodes, initial = false) {
    if (reduced()) return;
    const inWindow = now() - windowStart < INITIAL_WINDOW_MS;
    const perParent = new Map(), viewport = window.innerHeight || 800;
    for (const node of nodes) {
      if (seen.has(node) || node.closest?.('dialog,.app-header,[data-motion-skip]') || node.hidden) continue;
      seen.add(node);
      if (!inWindow) continue;
      const rect = node.getBoundingClientRect?.();
      if (!rect || rect.width === 0 && rect.height === 0) continue;
      if (rect.top < viewport * 1.18) {
        // Already painted on first load: the CSS page entrance covers it.
        if (initial) continue;
        const parent = node.parentElement, index = perParent.get(parent) || 0;
        perParent.set(parent, index + 1);
        reveal(node, index);
      } else if (observer && !document.hidden) {
        node.classList.add('motion-pending');
        observer.observe(node);
        waiting.push(node);
      }
    }
    if (waiting.length) {
      if (capTimer === null) capTimer = setTimeout(() => { capTimer = null; revealAll(); }, REVEAL_CAP_MS);
      if (failsafeTimer === null) failsafeTimer = setInterval(failsafe, FAILSAFE_MS);
    }
  }
  function revealAll() {
    for (const node of waiting.splice(0)) if (node.classList.contains('motion-pending')) { observer?.unobserve(node); node.classList.remove('motion-pending'); }
    if (failsafeTimer !== null) { clearInterval(failsafeTimer); failsafeTimer = null; }
  }
  // A failsafe sweep while anything waits: nothing near the viewport may stay
  // hidden if an observer never fires (zoom, resized viewport, print preview).
  function failsafe() {
    const viewport = window.innerHeight || 800;
    for (const node of waiting.splice(0)) {
      if (!node.classList.contains('motion-pending')) continue;
      const rect = node.getBoundingClientRect();
      if (rect.top < viewport * 1.3 || !node.isConnected) { observer?.unobserve(node); reveal(node, 0); } else waiting.push(node);
    }
    if (!waiting.length && failsafeTimer !== null) { clearInterval(failsafeTimer); failsafeTimer = null; }
  }
  window.addEventListener('beforeprint', revealAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) revealAll(); });
  motionQuery?.addEventListener?.('change', () => { if (reduced()) revealAll(); });
  function scan(scope = document, initial = false) {
    const nodes = [];
    if (scope.nodeType === 1 && scope.matches?.(REVEAL)) nodes.push(scope);
    if (scope.querySelectorAll) nodes.push(...scope.querySelectorAll(REVEAL));
    register(nodes, initial);
    const each = (selector, fn) => { if (scope.nodeType === 1 && scope.matches?.(selector)) fn(scope); if (scope.querySelectorAll) for (const node of scope.querySelectorAll(selector)) fn(node); };
    each(SPOTLIGHT, spotlight); each(NUMBERS, watchNumber); each(BAR, bar); each(SPARKLE, sparkle);
  }

  // ---- Cursor spotlight on cards ----
  const spotted = new WeakSet();
  function spotlight(node) {
    if (spotted.has(node) || reduced() || !window.matchMedia?.('(hover: hover)').matches) return;
    const position = window.getComputedStyle?.(node)?.position;
    if (position !== 'static' && position !== 'relative') return;
    spotted.add(node);
    node.classList.add('motion-spotlight');
    const layer = document.createElement('span'); layer.className = 'motion-spot'; layer.setAttribute('aria-hidden', 'true');
    node.prepend(layer);
  }
  // ---- 3D tilt (desktop pointers only; transform only) ----
  let tilted = null;
  function untilt() { if (!tilted) return; tilted.style.removeProperty('--motion-rx'); tilted.style.removeProperty('--motion-ry'); tilted.classList.remove('is-tilting'); tilted = null; }
  document.addEventListener('pointermove', event => {
    const card = event.target.closest?.('.motion-spotlight');
    if (card) {
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--motion-x', (event.clientX - rect.left) + 'px');
      card.style.setProperty('--motion-y', (event.clientY - rect.top) + 'px');
    }
    if (reduced() || event.pointerType === 'touch' || !finePointer()) return;
    const tilt = event.target.closest?.(TILT);
    if (tilt !== tilted) untilt();
    if (!tilt) return;
    const rect = tilt.getBoundingClientRect(); if (!rect.width || !rect.height) return;
    const max = Math.min(14, Math.max(1, parseFloat(tilt.dataset.motionTilt) || 6));
    const px = (event.clientX - rect.left) / rect.width - .5, py = (event.clientY - rect.top) / rect.height - .5;
    tilted = tilt; tilt.classList.add('is-tilting');
    tilt.style.setProperty('--motion-ry', (px * 2 * max).toFixed(2) + 'deg');
    tilt.style.setProperty('--motion-rx', (-py * 2 * max).toFixed(2) + 'deg');
  }, { passive: true });
  document.addEventListener('pointerout', event => { if (tilted && !tilted.contains(event.relatedTarget)) untilt(); }, { passive: true });
  document.addEventListener('pointercancel', untilt, { passive: true });

  // ---- Sparkles on pills and badges ----
  const sparkled = new WeakSet();
  function sparkle(node) {
    if (sparkled.has(node)) return;
    sparkled.add(node);
    const position = window.getComputedStyle?.(node)?.position;
    if (!position || position === 'static') node.classList.add('motion-sparkle-host');
    const count = Math.min(5, Math.max(1, parseInt(node.dataset.motionSparkle, 10) || 3));
    for (let i = 0; i < count; i++) { const star = document.createElement('i'); star.className = 'motion-sparkle'; star.setAttribute('aria-hidden', 'true'); star.style.setProperty('--i', String(i)); node.append(star); }
  }

  // ---- Progress bars: fill from zero on first view, slide on change ----
  // Like reveals, a bar waiting for its first view fills on its own after the
  // cap (and at once when printing or hidden), so it is never stuck at zero.
  const bars = new WeakMap(), armedBars = new Set();
  const barObserver = 'IntersectionObserver' in window ? new window.IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { barObserver.unobserve(entry.target); fillBar(entry.target); }
  }, { threshold: 0.05 }) : null;
  function fillAllBars() { for (const node of [...armedBars]) { barObserver?.unobserve(node); fillBar(node); } }
  window.addEventListener('beforeprint', fillAllBars);
  document.addEventListener('visibilitychange', () => { if (document.hidden) fillAllBars(); });
  function barFill(node) { return node.tagName === 'PROGRESS' ? node : node.querySelector('[data-motion-bar-fill]') || node.firstElementChild; }
  // Layout width (offsetWidth ignores the fill's own scale transform).
  function barWidth(node) { const fill = barFill(node); if (!fill || fill === node) return null; const width = fill.offsetWidth; return width > 0 ? width : null; }
  function bar(node) {
    if (bars.has(node)) return;
    const state = { armed: false, width: null, observer: null };
    bars.set(node, state);
    if (node.tagName === 'PROGRESS' || !barFill(node)) return;
    node.classList.add('motion-bar');
    if (reduced()) return;
    // Hidden until first view: the fill is scaled to zero, never re-measured.
    node.classList.add('motion-bar-reset'); node.style.setProperty('--motion-bar', '0'); state.armed = true;
    if (barObserver && !document.hidden) { barObserver.observe(node); armedBars.add(node); setTimeout(() => { if (armedBars.has(node)) { barObserver.unobserve(node); fillBar(node); } }, REVEAL_CAP_MS); }
    else fillBar(node);
    if (window.MutationObserver) {
      state.observer = new window.MutationObserver(() => barChanged(node));
      state.observer.observe(node, { attributes: true, attributeFilter: ['style', 'aria-valuenow', 'aria-valuemax', 'class', 'data-value'] });
      const fill = barFill(node); if (fill) state.observer.observe(fill, { attributes: true, attributeFilter: ['style', 'aria-valuenow', 'aria-valuemax', 'class', 'data-value'] });
    }
  }
  function fillBar(node) {
    const state = bars.get(node); if (!state) return;
    armedBars.delete(node); state.width = barWidth(node);
    raf(() => { state.armed = false; node.classList.remove('motion-bar-reset'); node.style.setProperty('--motion-bar', '1'); setTimeout(() => { if (!state.armed) node.style.removeProperty('--motion-bar'); }, 1000); });
  }
  function barChanged(node) {
    // Our own class and variable writes never change the layout width, so they
    // fall out here; only a genuine resize of the fill animates.
    const state = bars.get(node); if (!state || state.armed || reduced()) return;
    const width = barWidth(node); if (width === null || state.width === null || Math.abs(width - state.width) < .5) { state.width = width ?? state.width; return; }
    // The fill already has its new layout width: start scaled to the old width
    // (transform only) and ease to its real size.
    const from = Math.min(4, state.width / width); state.armed = true;
    node.classList.add('motion-bar-reset'); node.style.setProperty('--motion-bar', from.toFixed(4));
    void node.offsetWidth;
    fillBar(node);
  }

  // ---- Ripple ----
  document.addEventListener('pointerdown', event => {
    if (reduced() || event.button !== 0) return;
    const button = event.target.closest?.(RIPPLE);
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return;
    const rect = button.getBoundingClientRect(), size = Math.max(rect.width, rect.height) * 2.2;
    const ripple = document.createElement('span'); ripple.className = 'motion-ripple'; ripple.setAttribute('aria-hidden', 'true');
    ripple.style.setProperty('--motion-size', size + 'px');
    ripple.style.setProperty('--motion-x', (event.clientX - rect.left) + 'px');
    ripple.style.setProperty('--motion-y', (event.clientY - rect.top) + 'px');
    button.append(ripple);
    setTimeout(() => ripple.remove(), 700);
  }, { passive: true });

  // ---- Live numbers ----
  function watchNumber(node) { if (!lastText.has(node)) lastText.set(node, node.textContent); }
  function numberChanged(node, previous) {
    const next = node.textContent;
    if (counting.get(node)?.writing === next) return;
    lastText.set(node, next);
    const before = parseDisplayNumber(previous), after = parseDisplayNumber(next);
    const running = counting.get(node); if (running) { running.cancelled = true; counting.delete(node); }
    if (!after || reduced()) return;
    const fromPlaceholder = !before && (previous === '' || /^[—–-]+$/.test((previous || '').trim()) || previous == null);
    if (!before && !(fromPlaceholder && now() - windowStart < INITIAL_WINDOW_MS * 2)) return;
    if (before && (before.prefix !== after.prefix || before.suffix !== after.suffix || before.number === after.number)) return;
    const start = before ? before.number : 0, end = after.number, shape = after, duration = before ? 520 : 900;
    if (before) {
      const cls = end > start ? 'motion-up' : 'motion-down';
      node.classList.remove('motion-up', 'motion-down'); void node.offsetWidth; node.classList.add(cls);
      setTimeout(() => node.classList.remove(cls), 1150);
    }
    // Very small or very large magnitudes animate poorly; just flash them.
    if (Math.abs(end) >= 1e15 || shape.decimals > 9) return;
    const job = { cancelled: false, writing: null }, began = now();
    counting.set(node, job); node.classList.add('motion-counting');
    const step = () => {
      if (job.cancelled || disposed) return;
      const t = Math.min(1, (now() - began) / duration), eased = 1 - Math.pow(1 - t, 3);
      const text = t >= 1 ? next : formatDisplayNumber(shape, start + (end - start) * eased);
      job.writing = text;
      if (node.textContent !== text) node.textContent = text;
      if (t < 1) raf(step);
      else { counting.delete(node); node.classList.remove('motion-counting'); lastText.set(node, next); }
    };
    raf(step);
  }

  // ---- Mutation tracking ----
  let pendingScan = new Set(), queued = false;
  const mutations = new window.MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'childList') {
        for (const node of record.addedNodes) if (node.nodeType === 1 && !/^motion-(ripple|spot|sparkle|peek|burst)$/.test(node.className || '')) pendingScan.add(node);
        const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        const number = target?.closest?.(NUMBERS);
        if (number && lastText.has(number)) {
          const previous = lastText.get(number);
          if (previous !== number.textContent) numberChanged(number, previous);
        }
      } else if (record.type === 'characterData') {
        const number = record.target.parentElement?.closest?.(NUMBERS);
        if (number && lastText.has(number)) { const previous = lastText.get(number); if (previous !== number.textContent) numberChanged(number, previous); }
      }
    }
    if (pendingScan.size && !queued) {
      // Microtask: reveal classes land before the next paint, so no flicker.
      queued = true;
      queueMicrotask(() => {
        queued = false; const nodes = [...pendingScan]; pendingScan = new Set();
        for (const node of nodes) if (node.isConnected) {
          // A newly inserted number element counts up from a placeholder.
          if (node.matches?.(NUMBERS) && !lastText.has(node)) { lastText.set(node, ''); numberChanged(node, ''); }
          scan(node);
        }
        if (nodes.some(node => node.parentElement?.tagName === 'MAIN' || node.tagName === 'MAIN')) staggerMain();
      });
    }
  });
  mutations.observe(document.body, { childList: true, subtree: true, characterData: true });

  // ---- Router integration ----
  document.addEventListener('curve-navigation-start', () => { windowStart = now(); });
  document.addEventListener('curve-navigation-complete', () => { windowStart = now(); staggerMain(); scan(document); scrolled(); });

  // ---- Celebration and toast hooks (dispatch a 'curve-celebrate' / 'curve-toast' event) ----
  document.addEventListener('curve-celebrate', event => celebrate(document, window, event.detail));
  document.addEventListener('curve-toast', event => toast(document, String(event.detail?.text || '').slice(0, 120)));
  // Copy buttons across the site get an instant confirmation.
  document.addEventListener('click', event => {
    const button = event.target.closest?.('button,a');
    if (!button || !/^\s*copy\b/i.test(button.textContent || '') || button.closest('dialog')) return;
    setTimeout(() => toast(document, 'Copied'), 60);
  });

  // ---- Gotchi peek: a small character looks into an empty state ----
  let gotchiModule = null;
  async function peek(container, options = {}) {
    if (!container?.isConnected || disposed) return null;
    const { stage = 1, side = 'right', height = 92, interactive = false } = options;
    const theme = GOTCHI_THEMES.includes(options.theme) ? options.theme : GOTCHI_THEMES[Math.floor(Math.random() * GOTCHI_THEMES.length)];
    container.querySelector(':scope > .motion-peek')?.remove();
    const wrap = document.createElement('div'); wrap.className = 'motion-peek'; wrap.dataset.side = side === 'left' ? 'left' : 'right'; wrap.setAttribute('aria-hidden', 'true');
    const position = window.getComputedStyle?.(container)?.position;
    if (!position || position === 'static') container.classList.add('motion-peek-host');
    container.append(wrap);
    try {
      gotchiModule ||= import('./gotchi-character.mjs');
      const { createGotchiCharacter } = await gotchiModule;
      if (!wrap.isConnected || disposed) { wrap.remove(); return null; }
      const character = createGotchiCharacter({ document, window, theme, stage, size: 'mini', interactive });
      character.element.style.setProperty('--gotchi-figure-height', Math.max(48, Math.min(180, Number(height) || 92)) + 'px');
      wrap.append(character.element);
      raf(() => wrap.classList.add('is-in'));
      return { element: wrap, character, theme, remove() { try { character.destroy(); } catch {} wrap.remove(); } };
    } catch { gotchiModule = null; wrap.remove(); return null; }
  }

  staggerMain(); scan(document, true); scrolled();
  const api = {
    version: 2,
    peek,
    celebrate: detail => celebrate(document, window, detail),
    toast: text => toast(document, String(text ?? '').slice(0, 120)),
    reveal: scope => scan(scope || document),
    revealAll,
    bar: node => { if (node?.matches?.(BAR)) bar(node); },
    dispose() {
      disposed = true; mutations.disconnect(); observer?.disconnect(); barObserver?.disconnect(); revealAll();
      if (capTimer !== null) clearTimeout(capTimer); ambient.remove(); progress.remove(); root.classList.remove('motion-ready'); delete root.dataset.motion;
      if (window.curveMotion === api) delete window.curveMotion;
    },
  };
  window.curveMotion = api;
  return api;
}

let toastTimer = null;
function toast(document, text) {
  if (!text) return;
  let node = document.querySelector('.motion-toast');
  if (!node) { node = document.createElement('div'); node.className = 'motion-toast'; node.setAttribute('role', 'status'); node.dataset.navigationPersistent = 'true'; document.body.append(node); }
  node.textContent = text; void node.offsetWidth; node.classList.add('is-visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('is-visible'), 1600);
}

// Confetti in sunrise colours plus a soft burst, from the centre of the page
// or from `detail.target` / `detail.origin`. Everything is gone within 1.5 s.
function celebrate(document, window, detail) {
  if (reduced()) return;
  const width = window.innerWidth, height = window.innerHeight;
  let x = width / 2, y = height * .34;
  const target = detail?.target?.getBoundingClientRect ? detail.target : null;
  if (target) { const rect = target.getBoundingClientRect(); if (rect.width || rect.height) { x = rect.left + rect.width / 2; y = rect.top + rect.height / 2; } }
  else if (Number.isFinite(detail?.origin?.x) && Number.isFinite(detail?.origin?.y)) { x = detail.origin.x; y = detail.origin.y; }
  const burst = document.createElement('div'); burst.className = 'motion-burst'; burst.setAttribute('aria-hidden', 'true');
  burst.style.setProperty('--motion-x', x + 'px'); burst.style.setProperty('--motion-y', y + 'px');
  // Shown as popovers so the celebration also paints over an open <dialog> (the top layer), e.g. a launch dialog going live.
  const topLayer = node => { try { if (typeof node.showPopover === 'function') { node.setAttribute('popover', 'manual'); node.showPopover(); } } catch { /* popover unsupported: the element still paints below modal dialogs */ } };
  document.body.append(burst); topLayer(burst); setTimeout(() => burst.remove(), 900);
  const canvas = document.createElement('canvas'); canvas.className = 'motion-confetti'; canvas.setAttribute('aria-hidden', 'true');
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = width * ratio; canvas.height = height * ratio; document.body.append(canvas); topLayer(canvas);
  const context = canvas.getContext('2d'); if (!context) { canvas.remove(); return; }
  context.scale(ratio, ratio);
  const count = Math.min(220, Math.max(40, Number(detail?.count) || 140));
  const colours = confettiColours();
  const pieces = Array.from({ length: count }, (_, i) => {
    const angle = -Math.PI / 2 + (Math.random() - .5) * Math.PI * .9, speed = 7 + Math.random() * 11;
    return { x: x + (Math.random() - .5) * 24, y: y + (Math.random() - .5) * 16, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 2,
      r: Math.random() * Math.PI, vr: (Math.random() - .5) * .4, w: 5 + Math.random() * 6, h: 3 + Math.random() * 5,
      shape: i % 5 === 0 ? 'dot' : i % 7 === 0 ? 'strip' : 'rect', c: colours[Math.floor(Math.random() * colours.length)], wobble: Math.random() * Math.PI * 2 };
  });
  const began = now();
  const frame = () => {
    const t = now() - began; context.clearRect(0, 0, width, height);
    const alpha = t < CELEBRATE_MS - 450 ? 1 : Math.max(0, (CELEBRATE_MS - t) / 450);
    for (const p of pieces) {
      p.vy += .34; p.vx *= .985; p.x += p.vx + Math.sin(p.wobble + t / 140) * .6; p.y += p.vy; p.r += p.vr;
      context.save(); context.globalAlpha = alpha; context.translate(p.x, p.y); context.rotate(p.r); context.fillStyle = p.c;
      if (p.shape === 'dot') { context.beginPath(); context.arc(0, 0, p.h * .6, 0, Math.PI * 2); context.fill(); }
      else if (p.shape === 'strip') context.fillRect(-p.w, -1.5, p.w * 2, 3);
      else context.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      context.restore();
    }
    if (t < CELEBRATE_MS) raf(frame); else canvas.remove();
  };
  raf(frame);
}

if (typeof document !== 'undefined' && document.documentElement && typeof window !== 'undefined' && window.MutationObserver) {
  const boot = () => { try { startMotion({ document, window }); } catch { /* decorative only */ } };
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot, { once: true });
}
