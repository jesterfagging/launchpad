// A launchpad's words. The pages are the engine's templates and name the platform "Launchpad"; a host with a name of
// its own (LAUNCHPAD_BRAND_NAME, src/brand.mjs) or a white-label launchpad (LAUNCHPAD_PRODUCT=tenant) serves every visible
// mention in its name instead: once on the server for the static page text, and again in the browser for whatever page
// scripts render later (public/brand-shell.mjs, public/tenant-shell.mjs watch the document).
// Shared by the server and the browser: no imports, no DOM.

// The brand word: capitalised Launchpad and the LAUNCHPAD eyebrows. Never $LAUNCHPAD (a token ticker), never the
// lowercase "launchpad", never "Bonding Curve".
export const BRAND = /(?<![$\w])(?<!Bonding )(?:Launchpad|LAUNCHPAD)(?!\w)/g;
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The platform token's ticker in the templates; a host with a token of its own (LAUNCHPAD_TOKEN_SYMBOL) shows its ticker.
export const TOKEN_TICKER = /\$LAUNCHPAD(?![A-Za-z0-9_])/g;
export const retickerCopy = (text, symbol) => symbol ? String(text).replace(TOKEN_TICKER, () => '$' + symbol) : String(text);

/** Exact phrases (trimmed) that name things a launchpad does not have. Values may use {name}. */
export const TENANT_COPY = new Map([
  ['Open official $LAUNCHPAD token page. USD price unavailable.', ''],
  ['Launchpad home', '{name} home'],
  // The bonding stage in a plain word of its own (a badge upper-cases it).
  ['On the curve', 'Bonding'],
  ['Active on the curve', 'Active while bonding'],
  ['Quiet on the curve. No trades in the last 24 hours yet.', 'Quiet so far. No trades in the last 24 hours yet.'],
]);

/**
 * The copy functions for one launchpad. `name` is the launchpad's display name. The name itself is matched first and
 * kept, so a name that contains the brand word ("Moon Launchpad") is never rewritten twice: rewriting is idempotent and
 * observers settle at once.
 */
export function createTenantCopy({ name, escape = value => value } = {}) {
  // `escape` is for HTML source (the server's page rewrite): the name is escaped after any case change.
  const raw = String(name || 'Launchpad'), display = escape(raw), upper = escape(raw.toUpperCase());
  const fill = text => text.replace(/\{name\}/g, () => display);
  const keep = [...new Set([display, upper])].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const WORDS = new RegExp(`${keep.join('|')}|${BRAND.source}`, 'g');
  function rebrandCopy(text) {
    let value = String(text);
    const trimmed = value.trim();
    if (trimmed && TENANT_COPY.has(trimmed)) value = value.replace(trimmed, () => fill(TENANT_COPY.get(trimmed)));
    return value.replace(WORDS, word => word === display || word === upper ? word : word === 'LAUNCHPAD' ? upper : display);
  }
  return { rebrandCopy, needsRebrand: text => rebrandCopy(text) !== String(text), name: raw };
}

/** HTML-escape a value for page text or a double-quoted attribute. */
export const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
