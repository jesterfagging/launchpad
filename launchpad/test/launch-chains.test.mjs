// The chain choice on the launch page: Solana and Robinhood are listed; a chain added unrevealed stays out (not
// rendered, not selectable, not even from a URL) until its venues ship; the first chain comes from the URL, then the
// remembered choice, never an unavailable or unrevealed one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LAUNCH_CHAINS, initialLaunchChain, launchChainById, createChainSelect, listedLaunchChains } from '../public/launch-chains.mjs';

test('the catalogue lists Solana and Robinhood; an unrevealed chain stays out of the list', () => {
  assert.deepEqual(LAUNCH_CHAINS.filter(c => c.available).map(c => c.id), ['solana', 'robinhood']);
  assert.deepEqual(listedLaunchChains().map(c => c.id), ['solana', 'robinhood']);
  assert.ok(LAUNCH_CHAINS.every(c => c.revealed === true || c.available === false), 'nothing unrevealed is available');
  assert.equal(launchChainById('robinhood').name, 'Robinhood'); assert.equal(launchChainById('nope'), null);
  assert.deepEqual(listedLaunchChains([...LAUNCH_CHAINS, { id: 'nextchain', name: 'Next', available: false, revealed: false }]).map(c => c.id), ['solana', 'robinhood']);
});

test('the initial chain follows the URL, then memory, never a chain that is not available or not revealed', () => {
  assert.equal(initialLaunchChain({ search: '?chain=robinhood' }), 'robinhood');
  assert.equal(initialLaunchChain({ search: '?chain=ROBINHOOD' }), 'robinhood');
  assert.equal(initialLaunchChain({ search: '?chain=nextchain', remembered: 'robinhood' }), 'robinhood', 'an unknown chain in the URL falls back to the remembered one');
  assert.equal(initialLaunchChain({ search: '', remembered: 'otherchain' }), 'solana');
  assert.equal(initialLaunchChain({ search: '?x=1' }), 'solana');
});

/** A tiny DOM: enough of createElement / append / setAttribute / addEventListener for the segment renderer. */
function fakeDocument() {
  const make = tag => ({ tag, children: [], attrs: {}, listeners: {}, dataset: {}, disabled: false, textContent: '', className: '',
    append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; }, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }, click() { for (const fn of this.listeners.click || []) fn(); } });
  return { createElement: make };
}

test('the segments render the listed chains only and report real changes only', () => {
  const document = fakeDocument(), root = document.createElement('div'), changes = [];
  const chains = [...LAUNCH_CHAINS, { id: 'nextchain', name: 'Next', tagline: '', logo: '/solana-chain.svg', available: false, revealed: false, param: 'nextchain' }];
  const select = createChainSelect({ document, root, chains, value: 'solana', onChange: id => changes.push(id) });
  assert.equal(root.children.length, 2, 'an unrevealed chain is not rendered');
  assert.equal(root.dataset.launchChainCount, '2');
  const [solana, robinhood] = root.children;
  assert.deepEqual(root.children.map(b => b.dataset.launchChain), ['solana', 'robinhood']);
  assert.ok(!JSON.stringify(root.children).includes('Soon'), 'no Soon badge anywhere');
  assert.equal(solana.attrs['aria-pressed'], 'true'); assert.equal(robinhood.attrs['aria-pressed'], 'false');
  robinhood.click(); assert.deepEqual(changes, ['robinhood']); assert.equal(select.value, 'robinhood'); assert.equal(robinhood.attrs['aria-pressed'], 'true');
  robinhood.click(); assert.deepEqual(changes, ['robinhood'], 'clicking the chosen chain is not a change');
  assert.equal(select.set('solana', { silent: true }), true); assert.deepEqual(changes, ['robinhood']); assert.equal(solana.attrs['aria-pressed'], 'true');
  assert.equal(select.set('nextchain'), false, 'an unrevealed chain cannot be set');
  assert.equal(select.set('otherchain'), false);
  select.disable(true); assert.equal(solana.disabled, true); select.disable(false); assert.equal(solana.disabled, false);
});

test('a revealed chain that is not available yet renders disabled with a Soon badge (for the day one is revealed)', () => {
  const document = fakeDocument(), root = document.createElement('div');
  const chains = [...LAUNCH_CHAINS.slice(0, 2), { id: 'nextchain', name: 'Next', tagline: '', logo: '/solana-chain.svg', available: false, revealed: true, param: 'nextchain' }];
  createChainSelect({ document, root, chains, value: 'solana' });
  assert.equal(root.children.length, 3);
  const next = root.children[2];
  assert.equal(next.disabled, true); assert.ok(next.children[1].children.some(c => c.textContent === 'Soon'));
});
