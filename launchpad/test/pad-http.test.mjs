// A launchpad's v1.1 features through the real account app (LAUNCHPAD_PRODUCT=tenant, every feature on): the pages, the
// public feature APIs (which launchpad-only mode must let through), media, the admin routes' sign-in gate, the launch
// gate the venues call (src/tenant/pad.mjs padCheck) and shutdown. A fake accounts store and discovery; no chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';

test('launchpad features: pages, APIs, media, the admin gate and the launch gate in the running app', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pad-http-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'brand')); await mkdir(join(dir, 'data'));
  const tenant = { version: 1, name: 'Smoke Pad', slug: 'smoke-pad', tagline: '', layout: 'rack', preset: 'custom', accent: '8B5CFF', theme: 'dark', look: { font: 'layout', corners: 'layout', background: 'plain', hero: false }, features: { tickerLock: true, bundleCheck: true, registry: true, summit: true, takeover: true }, venues: ['pump-classic', 'raydium'], modes: ['creator', 'holders'], hooks: false, starts: {}, links: { x: '', telegram: '', website: '' }, poweredBy: true, launcher: { name: 'Example Platform', url: 'https://platform.example' }, createdAt: Date.now() };
  await writeFile(join(dir, 'tenant.json'), JSON.stringify(tenant));
  Object.assign(process.env, { LAUNCHPAD_PRODUCT: 'tenant', LAUNCHPAD_BRAND_NAME: 'Hostbrand', LAUNCHPAD_TENANT_FILE: join(dir, 'tenant.json'), LAUNCHPAD_PUBLIC_URL: 'https://smoke-pad.pads.example', LAUNCHPAD_PUBLIC_RPC_URL: 'https://rpc.invalid.example/' });
  const { createAccountApp } = await import('../src/account-app.mjs'), { padCheck } = await import('../src/tenant/pad.mjs');
  const now = Date.now(), coins = Array.from({ length: 12 }, (_, index) => { const i = index + 1; return { mint: 'Mint' + String(i).padStart(3, '0') + 'x'.repeat(36), name: 'Coin ' + i, symbol: 'CN' + i, image: '', createdAt: now - (30 - i) * 3600000, platform: 'pump-classic', curve: 'Curv' + String(i).padStart(3, '0') + 'y'.repeat(36), creator: { username: 'maker' + i }, stage: i % 5 === 0 ? 'graduated' : 'new', marketCapUsd: 5000 + i * 3000, volume24h: 1000 * i, progressPercent: (i * 7) % 100 }; });
  const explore = { inventory: async () => new Map(), catalogue: () => ({ coins, records: [], quotes: [] }), records: new Map(), list: async () => ({ coins: [], counts: {} }) };
  const accounts = { dir: join(dir, 'data'), master: Buffer.alloc(32), getSession: async () => null, registry: async () => ({ accounts: [] }), list: async () => [], hostStore: { read: async () => null } };
  const server = createAccountApp({ accounts, runtimes: {}, policy: {}, publicUrl: 'https://smoke-pad.pads.example', launchpad: {}, marketData: {}, funding: {}, protocolFees: {}, protocolTreasury: {}, protocolGasFunding: {}, branding: {}, adminPanel: {}, adminRevenue: {}, explore, trading: {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let closed = false; const close = async () => { if (closed) return; closed = true; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await server.closeServices(); };
  t.after(close);
  const call = (path, { method = 'GET', body } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: { host: 'smoke-pad.pads.example', 'x-forwarded-proto': 'https', ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); let json = null; try { json = JSON.parse(text); } catch { /* a page */ } resolve({ status: res.statusCode, text, json, type: String(res.headers['content-type'] || '') }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
  // The first sync numbers the coins.
  for (let i = 0; i < 50 && (await call('/api/pad/registry')).json?.registered !== 12; i++) await new Promise(resolve => setTimeout(resolve, 50));
  for (const path of ['/launches', '/stats', '/summit', '/takeover']) {
    const page = await call(path); assert.equal(page.status, 200, path); assert.match(page.text, /data-product="tenant"/); assert.match(page.text, /data-pad-root/); assert.match(page.text, /tenant-pad\.mjs/);
    assert.equal((page.text.replace(/<[^>]+>/g, ' ').match(/\bHostbrand\b/g) || []).length, 0, path + ' shows no host brand');
  }
  assert.match((await call('/')).text, /data-features="tickerLock bundleCheck registry summit takeover"/);
  assert.match((await call('/docs')).text, /id="features" data-tn-feature="any"/);
  assert.equal((await call('/api/pad/config')).json.features.summit, true, 'launchpad-only mode lets the feature APIs through');
  const registry = (await call('/api/pad/registry?sort=oldest&limit=5')).json; assert.equal(registry.registered, 12); assert.equal(registry.coins[0].symbol, 'CN1'); assert.equal(registry.coins[0].no, 1);
  assert.equal((await call('/api/pad/stats')).json.coins, 12);
  assert.ok((await call('/api/pad/summit')).json.today.mint, 'a coin holds the summit');
  assert.equal((await call('/api/pad/coin?mint=' + coins[3].mint)).json.no, 4);
  assert.equal((await call('/api/pad/check?ticker=CN12&name=Whatever')).json.locked.symbol, 'CN12');
  const unsigned = await call('/api/pad/takeover', { method: 'POST', body: { mint: coins[0].mint } }); assert.equal(unsigned.status, 400); assert.match(unsigned.json.error, /connect your wallet/);
  assert.equal((await call('/pad-media/' + 'a'.repeat(64) + '.png')).status, 404);
  assert.equal((await call('/api/admin/pad/takeovers')).status, 401, 'the takeover queue needs the admin');
  assert.match((await call('/tenant-pad.mjs')).type, /javascript/); assert.match((await call('/tenant-pad.css')).type, /css/);
  // The launch gate every venue calls: the running launchpad's ticker lock and the Pump.fun claim.
  assert.throws(() => padCheck({ name: 'Fresh', symbol: 'CN12', owner: 'u1' }), /\$CN12 was launched here with that ticker/);
  assert.throws(() => padCheck({ name: 'coin 12', symbol: 'ZZZ', owner: 'u1' }), /with that name/);
  padCheck({ name: 'Fresh', symbol: 'FRESH1', owner: 'u1' }); padCheck({ name: 'Fresh', symbol: 'FRESH1', owner: 'u1' });
  assert.throws(() => padCheck({ name: 'Other', symbol: 'FRESH1', owner: 'u2' }), /launching that ticker here right now/);
  await close();
  padCheck({ name: 'Fresh', symbol: 'CN12', owner: 'u1' }); // after shutdown the gate is off
});
