// A platform with a name or token of its own (LAUNCHPAD_BRAND_NAME, LAUNCHPAD_TOKEN_SYMBOL; <body data-brand-name>,
// <body data-token-symbol>, written by src/brand.mjs): keeps every word page scripts draw later in that name and ticker,
// as the server did for the page itself. Coin names and tickers are the creators' words and are left alone. White-label
// launchpads use public/tenant-shell.mjs instead.
import { createTenantCopy, retickerCopy } from './tenant-copy.mjs';

const COPY_ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt'];
const USER_CONTENT = 'a[href^="/coin?mint="], [class*="coin-name"], [class*="coin-symbol"], [class*="token-name"], [class*="token-symbol"], [class*="hero-name"], .site-tape-track, [data-coin-name]';
const PLATFORM_COPY = '[class*="badge"], [class*="chip"]';

export function startBrandShell({ document = globalThis.document, window = globalThis.window } = {}) {
  const name = document?.body?.dataset?.brandName, symbol = document?.body?.dataset?.tokenSymbol || '';
  if (!name && !symbol || document.body.dataset.product === 'tenant') return null;
  const names = name ? createTenantCopy({ name }) : null;
  const copy = { rebrandCopy: text => retickerCopy(names ? names.rebrandCopy(text) : text, symbol), needsRebrand: text => copy.rebrandCopy(text) !== String(text) };
  const userContent = node => {
    const element = node?.nodeType === 1 ? node : node?.parentElement, owner = element?.closest?.(USER_CONTENT);
    if (!owner) return false;
    const label = element.closest(PLATFORM_COPY);
    return !(label && owner.contains(label) && !label.matches(USER_CONTENT));
  };
  const skip = node => ['SCRIPT', 'STYLE'].includes(node?.tagName);
  const text = node => { if (!skip(node.parentNode) && copy.needsRebrand(node.nodeValue) && !userContent(node)) node.nodeValue = copy.rebrandCopy(node.nodeValue); };
  const attributes = element => { for (const key of COPY_ATTRIBUTES) { const value = element.getAttribute?.(key); if (value && copy.needsRebrand(value) && !userContent(element)) element.setAttribute(key, copy.rebrandCopy(value)); } };
  function rebrand(node) {
    if (!node) return;
    if (node.nodeType === 3) { text(node); return; }
    if (![1, 9, 11].includes(node.nodeType) || skip(node)) return;
    if (node.nodeType === 1) attributes(node);
    const walker = (node.ownerDocument || node).createTreeWalker(node, 5);
    for (let current = walker.nextNode(); current; current = walker.nextNode()) { if (current.nodeType === 3) text(current); else if (!skip(current)) attributes(current); }
  }
  rebrand(document.documentElement);
  if (document.title && copy.needsRebrand(document.title)) document.title = copy.rebrandCopy(document.title);
  if (typeof window?.MutationObserver !== 'function') return { stop() {} };
  const observer = new window.MutationObserver(records => {
    for (const record of records) { if (record.type === 'childList') for (const node of record.addedNodes) rebrand(node); else rebrand(record.target); }
    if (document.title && copy.needsRebrand(document.title)) document.title = copy.rebrandCopy(document.title);
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: COPY_ATTRIBUTES });
  return { stop() { observer.disconnect(); } };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') startBrandShell();
