// The header's chain toggle (v71.42): Solana | Robinhood with the chains' marks right after the brand on every page;
// the pressed one follows the remembered choice and whatever the page applies; a click asks the page first (the home
// and launch pages answer and stay put) and opens the home page on that chain otherwise; Gotchi and Agents step aside
// on Robinhood (the body carries the chain for the stylesheet). Runs on the page's own document (the Chromium harness).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { mountChainToggle, selectSiteChain, applySiteChain, rememberedSiteChain, CHAIN_PREF_KEY } from '../public/workspace-shell.js';

const KEY = CHAIN_PREF_KEY;
const storage = () => { try { return globalThis.document?.defaultView?.localStorage || null; } catch { return null; } };
function header(document) {
  const host = document.createElement('div'); host.innerHTML = '<header class="app-header"><div class="workspace-header-inner"><a class="brand" href="/">Launchpad</a><div class="local"><a class="gotchi-nav">Gotchi</a><a class="agents-nav">Agents</a></div></div></header>';
  document.body.append(host); return { host, inner: host.querySelector('.workspace-header-inner') };
}

test('the toggle mounts after the brand with both marks, shows the remembered chain, and marks the body for the stylesheet', t => {
  const document = globalThis.document || parseHTML('<html><body></body></html>').document, store = storage();
  try { store?.setItem(KEY, 'robinhood'); } catch { /* no storage: the toggle still mounts */ }
  const { host, inner } = header(document);
  t.after(() => { host.remove(); try { store?.removeItem(KEY); } catch { /* ignore */ } delete document.body.dataset.chain; });
  const toggle = mountChainToggle({ document, container: inner });
  assert.ok(toggle, 'mounted'); assert.equal(toggle.previousElementSibling.className, 'brand', 'right after the brand');
  const expectedPressed = store ? 'true' : 'false';
  assert.deepEqual([...toggle.querySelectorAll('button')].map(b => [b.dataset.chain, b.textContent, b.querySelector('img').getAttribute('src'), b.getAttribute('aria-pressed')]), [['solana', 'Solana', '/solana-chain.svg', 'false'], ['robinhood', 'Robinhood', '/robinhood-chain.svg', expectedPressed]]);
  if (store) assert.equal(document.body.dataset.chain, 'robinhood', 'the body carries the chain (the stylesheet hides .gotchi-nav and .agents-nav on it)');
  assert.equal(mountChainToggle({ document, container: inner }), toggle, 'mounting again reuses the toggle'); assert.equal(inner.querySelectorAll('.site-chain-toggle').length, 1);
  // The page applies a chain (the home page's filter, the launch page's chain step): the toggle follows, the stored choice does not change.
  document.dispatchEvent(new CustomEvent('curve-chain-applied', { detail: { chain: 'solana' } }));
  assert.equal(toggle.querySelector('[data-chain="solana"]').getAttribute('aria-pressed'), 'true'); assert.equal(document.body.dataset.chain, 'solana');
  document.dispatchEvent(new CustomEvent('curve-chain-applied', { detail: { chain: 'all' } }));
  assert.deepEqual([...toggle.querySelectorAll('button')].map(b => b.getAttribute('aria-pressed')), ['false', 'false'], 'All presses neither'); assert.equal(document.body.dataset.chain, 'all');
  if (store) assert.equal(store.getItem(KEY), 'robinhood', 'applying does not rewrite the stored choice; choosing does');
  assert.equal(applySiteChain(document, 'nonsense'), 'all', 'anything else is All');
});

test('a click is offered to the page first: a page that answers keeps the viewer where they are; the choice is remembered', t => {
  const document = globalThis.document || parseHTML('<html><body></body></html>').document, store = storage(), seen = [];
  const { host, inner } = header(document);
  const handle = event => { seen.push(event.detail.chain); event.preventDefault(); };
  document.addEventListener('curve-chain-selected', handle);
  t.after(() => { document.removeEventListener('curve-chain-selected', handle); host.remove(); try { store?.removeItem(KEY); } catch { /* ignore */ } delete document.body.dataset.chain; });
  try { store?.removeItem(KEY); } catch { /* ignore */ }
  const toggle = mountChainToggle({ document, container: inner });
  assert.deepEqual([...toggle.querySelectorAll('button')].map(b => b.getAttribute('aria-pressed')), ['false', 'false'], 'nothing remembered: neither pressed');
  toggle.querySelector('[data-chain="robinhood"]').click();
  assert.deepEqual(seen, ['robinhood']); assert.equal(toggle.querySelector('[data-chain="robinhood"]').getAttribute('aria-pressed'), 'true'); assert.equal(document.body.dataset.chain, 'robinhood');
  if (store) { assert.equal(store.getItem(KEY), 'robinhood', 'remembered'); assert.equal(rememberedSiteChain(document), 'robinhood'); }
  toggle.querySelector('[data-chain="solana"]').click();
  assert.deepEqual(seen, ['robinhood', 'solana']); assert.equal(document.body.dataset.chain, 'solana');
});

test('a click no page answers opens the home page on that chain', () => {
  // A stand-in document: no listener answers, so the toggle navigates.
  const store = new Map(), location = { href: 'http://localhost/docs' };
  const fake = { body: { dataset: {} }, defaultView: { localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) }, location, CustomEvent }, querySelectorAll: () => [], dispatchEvent: () => true };
  selectSiteChain(fake, 'robinhood');
  assert.equal(location.href, '/?chain=robinhood'); assert.equal(store.get(KEY), 'robinhood'); assert.equal(fake.body.dataset.chain, 'robinhood');
  selectSiteChain(fake, 'anything-else');
  assert.equal(location.href, '/?chain=solana', 'only the two chains exist; anything else is Solana');
});

test('v71.43: on a host with Robinhood Chain off (<body data-robinhood="off">) no toggle mounts and the body stays on Solana', t => {
  const document = globalThis.document || parseHTML('<html><body></body></html>').document;
  const { host, inner } = header(document); document.body.dataset.robinhood = 'off';
  t.after(() => { host.remove(); delete document.body.dataset.robinhood; delete document.body.dataset.chain; });
  assert.equal(mountChainToggle({ document, container: inner, chain: 'robinhood' }), null);
  assert.equal(inner.querySelector('.site-chain-toggle'), null); assert.equal(document.body.dataset.chain, 'solana');
});
