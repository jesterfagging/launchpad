// The platform's own name, address, X profile and token. The pages, messages and onchain attribution say "Launchpad"
// and its token "$LAUNCHPAD"; a host with a name or token of its own (LAUNCHPAD_BRAND_NAME, LAUNCHPAD_TOKEN_SYMBOL) serves
// every page with them instead (createBrandSkin below, once per page on the server), and the browser keeps whatever
// scripts draw later in them (public/brand-shell.mjs). A white-label launchpad (LAUNCHPAD_PRODUCT=tenant) has its own
// name in tenant.json and its own skin (src/tenant/skin.mjs).
import { launchpadEnv } from './brand-env.mjs';
import { createTenantCopy, escapeHtml, retickerCopy } from '../public/tenant-copy.mjs';
import { platformTokenMint, platformTokenSymbol } from './platform-token.mjs';
import { PLATFORM_TOKEN_MINT as TEMPLATE_TOKEN_MINT } from '../public/platform-token.mjs';

export const DEFAULT_BRAND_NAME = 'Launchpad';

/** LAUNCHPAD_BRAND_NAME, checked: 2 to 40 characters a page can show as text. */
export function brandName(env = process.env) {
  const value = String(launchpadEnv('BRAND_NAME', env) ?? '').trim();
  if (!value) return DEFAULT_BRAND_NAME;
  if (value.length < 2 || value.length > 40 || /[<>"'`&\\{}]|[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('LAUNCHPAD_BRAND_NAME must be 2 to 40 characters, without < > " \' ` & \\ { or }.');
  }
  return value;
}

/** The public HTTPS origin (LAUNCHPAD_PUBLIC_URL), or '' when the host has none. */
export function publicOrigin(env = process.env) {
  try { const url = new URL(launchpadEnv('PUBLIC_URL', env) || ''); return url.protocol === 'https:' ? url.origin : ''; } catch { return ''; }
}

/** The platform's X profile (LAUNCHPAD_X_URL), shown in the site footer; '' when the host has none. */
export function brandXUrl(env = process.env) {
  const value = String(launchpadEnv('X_URL', env) ?? '').trim();
  if (!value) return '';
  let url; try { url = new URL(value); } catch { url = null; }
  if (!url || url.protocol !== 'https:' || url.username || url.password || !['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'].includes(url.hostname)) {
    throw new Error('LAUNCHPAD_X_URL must be an https://x.com/ profile link.');
  }
  return url.href;
}

// The header price badge of the platform token (public/curve-price-badge.mjs) and its stylesheet.
const BADGE = /<a\b[^>]*class="curve-price-badge"[^>]*>[\s\S]*?<\/a>/g, BADGE_STYLES = /<link\b[^>]*id="curve-price-badge-styles"[^>]*>\s*/g;

/**
 * Serves an engine page as this platform's. Text and the attributes a visitor reads (title, alt, aria-label,
 * placeholder, meta content) carry its name and its token's ticker; scripts and styles are left alone. The header
 * price badge links the host's token (LAUNCHPAD_TOKEN_MINT), and a host without one serves no badge.
 */
export function createBrandSkin(name = brandName(), { x = brandXUrl(), tokenMint = platformTokenMint(), tokenSymbol = platformTokenSymbol() } = {}) {
  const custom = name !== DEFAULT_BRAND_NAME;
  const pageCopy = createTenantCopy({ name, escape: escapeHtml }), copy = createTenantCopy({ name });
  const words = text => retickerCopy(custom ? pageCopy.rebrandCopy(text) : text, tokenSymbol);
  const TEXT = />([^<]+)</g, ATTRIBUTE = /\b(aria-label|title|placeholder|alt|content)="([^"]*)"/g;
  // The footer's X link (public/workspace-shell.js) and the browser half (public/brand-shell.mjs) read these from the page;
  // the launch form (public/launchpad.js) hides Paycheck on a host without a platform token.
  const bodyAttributes = (custom ? ` data-brand-name="${escapeHtml(name)}"` : '') + (tokenSymbol ? ` data-token-symbol="${escapeHtml(tokenSymbol)}"` : '') + (x ? ` data-brand-x="${escapeHtml(x)}"` : '') + (tokenMint ? '' : ' data-platform-token="off"');
  function rebrandPage(html) {
    let text = String(html);
    if (!tokenMint) text = text.replace(BADGE, '').replace(BADGE_STYLES, '');
    else if (tokenMint !== TEMPLATE_TOKEN_MINT) text = text.split(TEMPLATE_TOKEN_MINT).join(tokenMint);
    if (bodyAttributes) text = text.replace(/(<body\b[^>]*?)>/, (match, open) => `${open}${bodyAttributes}>`);
    if (!custom && !tokenSymbol) return text;
    text = text.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|[^]+?(?=<script\b|<style\b|$)/g, chunk => /^<(?:script|style)\b/.test(chunk)
      ? chunk
      : chunk.replace(TEXT, (match, inner) => '>' + words(inner) + '<').replace(ATTRIBUTE, (match, key, value) => key + '="' + words(value) + '"'));
    return text.replace(/<\/body>/, '<script type="module" src="/brand-shell.mjs?v=1"></script></body>');
  }
  /** The browser module with the host's token address, or '' (no platform token). */
  function platformTokenModule(source) {
    return String(source).replace(/(export const PLATFORM_TOKEN_MINT = )'[^']*';/, (match, head) => `${head}'${tokenMint}';`);
  }
  return Object.freeze({ name, custom, x, tokenMint, tokenSymbol, rebrandPage, platformTokenModule, rebrandCopy: text => retickerCopy(copy.rebrandCopy(text), tokenSymbol) });
}
