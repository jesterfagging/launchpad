// The pair logo cache (v71.40; sources v71.42): a stock's mark is looked up by ISIN, then by ticker, on public logo
// services (Parqet, EODHD) before Robinhood's own token image; ETH and USDG take Parqet's crypto marks; the first
// source that answers is fetched once and served from the host for a week; an operator override wins; bad answers
// are refused and retried later; `pathFor` names a badge only when some source exists and carries the cache version.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PairLogos, LOGO_PATH_PREFIX, LOGO_VERSION, logoCandidates } from '../src/robinhood-launch/logos.mjs';

const NVDA = '0x000000000000000000000000000000000000AB12', SPY = '0x000000000000000000000000000000000000ab13';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const robinhood = 'https://cdn.robinhood.com/ncw_assets/logos/0x000000000000000000000000000000000000ab12.png';
const nvda = { kind: 'stock', symbol: 'NVDA', isin: 'US67066G1040', logo: robinhood }, spy = { kind: 'etf', symbol: 'SPY', isin: null, logo: null };
const suffix = '?v=' + LOGO_VERSION;
function fetcher(answers) {
  const calls = [];
  return { calls, fetch: async (url, options) => { calls.push({ url, options }); const a = typeof answers === 'function' ? answers(url) : answers; return { ok: a.status === 200, status: a.status, headers: { get: name => name === 'content-type' ? a.type : null }, arrayBuffer: async () => a.body }; } };
}

test('the candidate sources per pair kind: ISIN, then ticker, then Robinhood’s image for a stock; crypto marks for ETH and USDG; nothing for a bare custom token', () => {
  assert.deepEqual(logoCandidates(nvda), ['https://assets.parqet.com/logos/isin/US67066G1040?format=png', 'https://assets.parqet.com/logos/symbol/NVDA?format=png', 'https://eodhd.com/img/logos/US/NVDA.png', robinhood]);
  assert.deepEqual(logoCandidates(spy), ['https://assets.parqet.com/logos/symbol/SPY?format=png', 'https://eodhd.com/img/logos/US/SPY.png']);
  assert.deepEqual(logoCandidates({ kind: 'native', symbol: 'ETH' }), ['https://assets.parqet.com/logos/crypto/ETH?format=png']);
  assert.deepEqual(logoCandidates({ kind: 'stable', symbol: 'USDG' }), ['https://assets.parqet.com/logos/crypto/USDG?format=png']);
  assert.deepEqual(logoCandidates({ kind: 'custom', symbol: 'cbBTC' }), []);
  assert.deepEqual(logoCandidates({ kind: 'custom', symbol: 'X', logo: 'https://example.com/x.png' }), ['https://example.com/x.png'], 'a custom pair’s own URL, when it has one');
  assert.deepEqual(logoCandidates({ kind: 'stock', symbol: 'bad symbol', isin: 'nope' }), [], 'nothing is built from a malformed ticker or ISIN');
});

test('a stock’s mark comes from the first source that answers; Robinhood’s image is the last resort; the copy is served for a week', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-logos-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let now = 1_000_000;
  const f = fetcher(url => url.includes('/isin/') ? { status: 404, type: '', body: Buffer.alloc(0) } : { status: 200, type: 'image/png; charset=binary', body: PNG });
  const logos = new PairLogos({ dir, fetcher: f.fetch, now: () => now, ttlMs: 1000, log: () => {} });
  assert.equal(logos.pathFor(NVDA, nvda), LOGO_PATH_PREFIX + NVDA + suffix, 'the path carries the cache version');
  assert.equal(logos.pathFor(NVDA, { kind: 'custom', symbol: 'X' }), null, 'no source, no badge');
  assert.equal(logos.pathFor(NVDA, null), null);
  const first = await logos.get(NVDA, nvda);
  assert.equal(first.type, 'image/png'); assert.deepEqual([...first.bytes], [...PNG]); assert.match(first.etag, /^"[A-Za-z0-9_-]{24}"$/);
  assert.deepEqual(f.calls.map(c => c.url), ['https://assets.parqet.com/logos/isin/US67066G1040?format=png', 'https://assets.parqet.com/logos/symbol/NVDA?format=png'], 'the ISIN miss falls through to the ticker; nothing further is asked');
  assert.deepEqual(await readdir(join(dir, 'v' + LOGO_VERSION)), [NVDA.toLowerCase() + '.png'], 'cached under the lowercase address in the versioned folder');
  const again = await logos.get(NVDA.toLowerCase(), nvda);
  assert.equal(f.calls.length, 2, 'served from the cache'); assert.equal(again.etag, first.etag);
  now += 2000;
  const fresh = new PairLogos({ dir, fetcher: f.fetch, now: () => now, ttlMs: 1000, log: () => {} });
  await fresh.get(NVDA, nvda);
  assert.equal(f.calls.length, 4, 'refreshed after the TTL');
  assert.equal(f.calls[2].options.headers.accept, 'image/png,image/jpeg,image/webp,image/svg+xml');
  // Only Robinhood's image answers: it is taken, last.
  const only = fetcher(url => url.startsWith('https://cdn.robinhood.com/') ? { status: 200, type: 'image/png', body: PNG } : { status: 404, type: '', body: Buffer.alloc(0) });
  const fallback = new PairLogos({ dir: await mkdtemp(join(tmpdir(), 'launchpad-logos-')), fetcher: only.fetch, now: () => now, log: () => {} });
  assert.ok(await fallback.get(NVDA, nvda)); assert.equal(only.calls.length, 4); assert.equal(only.calls[3].url, robinhood);
});

test('when every source fails the miss is remembered and retried later; a stale copy is kept meanwhile; bad images are refused', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-logos-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let now = 5_000_000, status = 500; const f = fetcher(() => status === 200 ? { status, type: 'image/png', body: PNG } : status === 'html' ? { status: 200, type: 'text/html', body: Buffer.from('<html>') } : { status, type: '', body: Buffer.alloc(0) });
  const logos = new PairLogos({ dir, fetcher: f.fetch, now: () => now, ttlMs: 1000, log: () => {} });
  assert.equal(await logos.get(SPY, spy), null, 'HTTP 500 from both sources → no badge'); assert.equal(f.calls.length, 2);
  assert.equal(await logos.get(SPY, spy), null); assert.equal(f.calls.length, 2, 'no retry storm: a failed lookup waits ten minutes');
  now += 700000; status = 'html';
  assert.equal(await logos.get(SPY, spy), null, 'a non-image answer is refused'); assert.equal(f.calls.length, 4);
  now += 700000; status = 200;
  assert.ok(await logos.get(SPY, spy)); assert.equal(f.calls.length, 5, 'the first source answered');
  now += 2000; status = 500;
  const stale = await logos.get(SPY, spy);
  assert.ok(stale, 'the stale copy is served when the refresh fails'); assert.equal(f.calls.length, 7);
  assert.ok(await logos.get(SPY, spy)); assert.equal(f.calls.length, 7, 'and not refetched for an hour');
  const big = new PairLogos({ dir, fetcher: fetcher({ status: 200, type: 'image/png', body: Buffer.alloc(600 * 1024) }).fetch, now: () => now, maxBytes: 512 * 1024, log: () => {} });
  assert.equal(await big.get(NVDA, nvda), null, 'too large is refused');
  const scripted = new PairLogos({ dir, fetcher: fetcher({ status: 200, type: 'image/svg+xml', body: Buffer.from('<svg onload="x()"></svg>') }).fetch, now: () => now, log: () => {} });
  assert.equal(await scripted.get(NVDA, nvda), null, 'a scripted SVG is refused');
});

test('an operator override is served first, for any pair, and names a badge without any source', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-logos-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'overrides'), { recursive: true });
  const CB = '0x' + 'cb'.repeat(20), svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(dir, 'overrides', CB + '.svg'), svg);
  let now = 1; const f = fetcher({ status: 200, type: 'image/png', body: PNG });
  const logos = new PairLogos({ dir, fetcher: f.fetch, now: () => now });
  assert.equal(logos.pathFor(CB, { kind: 'custom', symbol: 'cbBTC' }), null, 'overrides are read on first use');
  const got = await logos.get(CB, { kind: 'custom', symbol: 'cbBTC' });
  assert.equal(got.type, 'image/svg+xml'); assert.equal(got.bytes.toString(), svg.toString());
  assert.equal(logos.pathFor(CB, { kind: 'custom', symbol: 'cbBTC' }), LOGO_PATH_PREFIX + CB + suffix, 'now known');
  assert.equal(logos.pathFor('0x' + '1'.repeat(40), { kind: 'custom', symbol: 'X' }), null);
  await writeFile(join(dir, 'overrides', NVDA + '.png'), PNG);
  now += 61000; // the overrides folder is re-read at most once a minute
  assert.equal((await logos.get(NVDA, nvda)).type, 'image/png'); assert.equal(f.calls.length, 0, 'the override beats every source');
  assert.equal(await logos.get('not-an-address', nvda), null);
});
