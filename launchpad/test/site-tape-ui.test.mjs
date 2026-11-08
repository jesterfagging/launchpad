import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { mountSiteTape, tapeItems } from '../public/site-tape.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const page = (body = '<header class="app-header"><div class="workspace-header-inner"></div></header><main></main>') => parseHTML(`<!doctype html><html><body data-shell="true">${body}</body></html>`);
const coins = [
  { mint: 'So11111111111111111111111111111111111111112', symbol: 'koi', name: 'Neon Koi', stage: 'new', fdvUsd: 46800, progressPercent: 88.2, createdAt: 1700000000000 - 7200000 },
  { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'GRID', stage: 'graduated', marketCapUsd: 1290000, priceChange24h: -3.2, createdAt: 1600000000000 },
  { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', symbol: 'FRESH', stage: 'new', fdvUsd: 20310, progressPercent: 3.1, createdAt: 1700000000000 + 3000000, coinUrl: '/coin?mint=4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R&chain=robinhood' },
  { symbol: 'NOMINT' },
];

test('tape items: ticker, value, progress or 24h move, a NEW marker for the first hour, coin links', () => {
  const items = tapeItems(coins, 1700000000000 + 3600000 - 1);
  assert.equal(items.length, 3, 'a row without a mint is skipped');
  assert.deepEqual(items.map(i => i.symbol), ['KOI', 'GRID', 'FRESH']);
  assert.equal(items[0].value, '$46.8K'); assert.equal(items[0].detail, '88% bonded'); assert.equal(items[0].tone, 'pct'); assert.equal(items[0].fresh, false, 'launched two hours ago');
  assert.equal(items[1].value, '$1.29M'); assert.equal(items[1].detail, '-3.2%'); assert.equal(items[1].tone, 'down');
  assert.equal(items[2].fresh, true, 'launched 50 minutes ago');
  assert.equal(items[2].href, '/coin?mint=4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R&chain=robinhood');
  assert.equal(items[0].href, '/coin?mint=So11111111111111111111111111111111111111112');
  assert.deepEqual(tapeItems(null), []);
});

test('the tape mounts after the header, stays hidden until the feed answers and is preserved by the router', async () => {
  const { document } = page(); const calls = [];
  const fetcher = async path => { calls.push(path); return { ok: true, json: async () => ({ coins }) }; };
  const tape = mountSiteTape({ document, fetcher, now: () => 1700000000000 });
  assert.ok(tape); assert.equal(tape.element.previousElementSibling.className, 'app-header'); assert.equal(tape.element.hidden, true);
  await flush(); await flush();
  assert.equal(tape.element.hidden, false); assert.deepEqual(calls, ['/api/explore?stage=all&sort=volume&limit=14']);
  assert.equal(tape.element.dataset.navigationPersistent, 'true');
  const links = [...tape.element.querySelectorAll('.site-tape-track > a')];
  assert.equal(links.length, 6, 'the strip is doubled for a seamless loop');
  assert.equal(links[0].querySelector('b').textContent, '$KOI'); assert.equal(links[0].getAttribute('href'), '/coin?mint=So11111111111111111111111111111111111111112');
  assert.equal(links[3].getAttribute('aria-hidden'), 'true', 'the copy is hidden from assistive tech');
  assert.equal(links[1].querySelector('.is-down').textContent, '-3.2%');
  assert.equal(mountSiteTape({ document, fetcher }), tape, 'mounting again returns the same tape');
  // The remembered chain narrows the feed.
  document.body.dataset.chain = 'robinhood'; await tape.refresh(); assert.equal(calls.at(-1), '/api/explore?stage=all&sort=volume&limit=14&chain=robinhood');
  tape.dispose(); assert.equal(document.querySelector('.site-tape'), null);
});

test('no tape on the admin panel, without a fetch, or when the feed is empty or failing', async () => {
  const admin = page(); admin.document.body.dataset.page = 'admin';
  assert.equal(mountSiteTape({ document: admin.document, fetcher: async () => ({ ok: true, json: async () => ({ coins }) }) }), null);
  const bare = page(); bare.window.fetch = undefined; assert.equal(mountSiteTape({ document: bare.document }), null);
  const empty = page(); const tape = mountSiteTape({ document: empty.document, fetcher: async () => ({ ok: true, json: async () => ({ coins: [] }) }) });
  await flush(); await flush(); assert.equal(tape.element.hidden, true); tape.dispose();
  const failing = page(); const broken = mountSiteTape({ document: failing.document, fetcher: async () => { throw new Error('offline'); } });
  await flush(); await flush(); assert.equal(broken.element.hidden, true); broken.dispose();
});
