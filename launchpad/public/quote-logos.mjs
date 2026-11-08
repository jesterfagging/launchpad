import { QUOTE_LOGO_PATHS } from './quote-logo-paths.mjs';
import { knownQuoteDisplayAsset, quoteLabel } from './quote-display-identity.mjs';

/** Logos are pinned by mint, never by a possibly duplicated ticker or a remote URL. */
export function quoteLogoPath(mint) {
  const path = typeof mint === 'string' ? QUOTE_LOGO_PATHS[mint] : null;
  return typeof path === 'string' && path.startsWith('/quote-logos/' + mint + '.') && /^\/quote-logos\/[1-9A-HJ-NP-Za-km-z]{32,44}\.(png|jpg|webp)$/.test(path) ? path : null;
}

/** Custom catalog images are server-published content hashes, never remote URLs. */
export function quoteAssetLogoPath(asset) {
  const bundled = quoteLogoPath(asset?.mint);
  if (bundled) return bundled;
  if (asset?.category !== 'custom' || typeof asset.mint !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(asset.mint)) return null;
  const path = asset.logoPath ?? asset.imagePath;
  return typeof path === 'string' && /^\/token-images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(path) ? path : null;
}

const ORIGIN_BADGES = Object.freeze({
  pump: { label: 'Launched on Pump.fun', path: '/pair-origin-pump.png' },
  stonk: { label: 'Launched on Stonk', path: '/pair-origin-stonk.png' },
});

/** Origin is verified server metadata, never a ticker, issuer name or mint suffix. */
export function createQuoteOriginBadge(document, asset) {
  if (asset?.category !== 'custom' || asset.originVerified !== true || typeof asset.mint !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(asset.mint)) return null;
  const origin = Object.hasOwn(ORIGIN_BADGES, asset.launchpadOrigin) ? ORIGIN_BADGES[asset.launchpadOrigin] : null;
  if (!origin) return null;
  ensureStyles(document);
  const badge = document.createElement('span'), image = document.createElement('img');
  badge.className = 'quote-origin-badge';badge.dataset.origin = asset.launchpadOrigin;
  badge.title = origin.label;badge.setAttribute('role', 'img');badge.setAttribute('aria-label', origin.label);
  image.src = origin.path;image.alt = '';image.width = image.height = 14;image.decoding = 'async';
  image.onerror = () => { badge.dataset.state = 'missing'; };
  badge.append(image);return badge;
}

function ensureStyles(document) {
  if (!document.head) return;
  const existing = document.getElementById('curve-quote-logo-styles');
  if (existing) { if (existing.getAttribute('href') !== '/quote-logos.css?v=52') existing.href = '/quote-logos.css?v=52';return; }
  const link = document.createElement('link');
  link.id = 'curve-quote-logo-styles';link.rel = 'stylesheet';link.href = '/quote-logos.css?v=52';
  document.head.append(link);
}

export function quoteAssetTitle(asset) {
  const identity = knownQuoteDisplayAsset(asset?.mint) || asset || {};
  const issuer = String(identity.issuer || '').replace(/_/g, ' ').trim();
  return [identity.name || quoteLabel(asset?.mint, asset?.symbol), issuer, asset?.mint].filter(Boolean).join(' · ');
}

export function createQuoteIcon(document, asset, { size = 24, className = '', textFallback = true } = {}) {
  ensureStyles(document);
  size = [18,20,24,30,44].includes(size) ? size : 24;
  const symbol = quoteLabel(asset?.mint, asset?.symbol), root = document.createElement('span');
  root.className = 'quote-logo' + (className ? ' ' + className : '');
  root.setAttribute('aria-hidden', 'true');root.dataset.mint = String(asset?.mint || '');root.dataset.size = String(size);
  root.dataset.symbol = symbol;root.dataset.length = symbol.length <= 4 ? 'short' : symbol.length <= 6 ? 'medium' : symbol.length <= 8 ? 'long' : 'extended';
  if (textFallback) {
    const letters = document.createElement('span');letters.className = 'quote-logo-fallback launch-ticker-letters';letters.textContent = symbol;letters.dataset.size = root.dataset.length;
    root.append(letters);
  } else root.classList.add('quote-logo-css-fallback');
  const path = quoteAssetLogoPath(asset);
  root.dataset.state = path ? 'loading' : 'fallback';
  if (path) {
    const image = document.createElement('img');
    image.alt = '';image.width = size;image.height = size;image.loading = 'lazy';image.decoding = 'async';image.referrerPolicy = 'no-referrer';
    image.onload = () => { root.dataset.state = 'ready'; };
    image.onerror = () => { image.remove();root.dataset.state = 'fallback'; };
    image.src = path;root.append(image);
  }
  return root;
}

/** The visible name remains available if an icon is unavailable or cannot load. */
export function createQuoteLabel(document, asset, { size = 20, className = '', strong = false, icon = true, origin = false } = {}) {
  ensureStyles(document);
  const root = document.createElement('span'), label = document.createElement(strong ? 'strong' : 'span');
  root.className = 'quote-identity' + (className ? ' ' + className : '');root.title = quoteAssetTitle(asset);
  if (icon && quoteAssetLogoPath(asset)) root.append(createQuoteIcon(document, asset, { size, textFallback: false }));
  label.className = 'quote-symbol';label.textContent = quoteLabel(asset?.mint, asset?.symbol);root.append(label);
  if (origin) { const badge = createQuoteOriginBadge(document, asset);if (badge) { root.append(badge);root.title += ' · ' + badge.title; } }
  return root;
}
