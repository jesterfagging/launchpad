import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createAccountApp } from '../src/account-app.mjs';

async function fixture(t) {
  let reads = 0, revenueReads = 0, sessionReads = 0, startCalls = 0;
  const accounts = { master: Buffer.alloc(32), list: async () => [], hostStore: { read: async () => null },
    getSession: async () => { sessionReads++; return null; }, registry: async () => ({ accounts: [] }) };
  const volume = { readPublic: async () => { reads++; return {
    launches: { total: 0, last24h: 0, uniqueDevelopers: 0, uniqueDevelopers24h: 0, observedTotal: 0, observedLast24h: 0, observedUniqueDevelopers: 0, observedUniqueDevelopers24h: 0, complete: true },
    dailyLaunches: { timezone: 'UTC', complete: true, days: [] }, inventoryAt: Date.now(),
    volume: { period: '24h', usd: 0, complete: true, lifetimeUsd: null, lifetimeStatus: 'unavailable' },
  }; }, read: () => assert.fail('anonymous analytics must not invoke an admin response') };
  const server = createAccountApp({ accounts, runtimes: {}, policy: {}, publicUrl: 'https://launch.example',
    launchpad: {}, marketData: {}, funding: {}, protocolFees: {}, protocolTreasury: {}, branding: {}, adminPanel: {},
    adminRevenue: { read: () => assert.fail('public analytics cannot use the admin response'), readPublic: () => { revenueReads++; return {status:'available',complete:true,historyComplete:true,pricingComplete:true,totalUsdEstimate:12,pricedUsdEstimate:12}; } },
    explore: {}, trading: {}, adminVolume: volume,
    publicBurnSupply: { start(){}, close(){}, readPublic:()=>({status:'available',mint:'7rvRFpzP5W18yZcNpPNqtWgPTxLaFrnutz5QPxXpyupc',decimals:6,originalSupply:'1000000000000000',currentSupply:'814000000000000',totalBurned:'186000000000000',burnedPercent:'18.60',slot:452000000,at:Date.now(),commitment:'finalized',source:'finalized-mint-supply'}) },
    lifetimeVolume: { start: () => { startCalls++; }, readPublic: () => ({ status: 'backfilling', period: 'lifetime', scope: 'launch-curves', recordedVolumeUsdEstimate: null }), close() {} },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await server.closeServices(); });
  const request = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path, method,
      headers: { host: 'launch.example', 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.0.2.1', ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode, headers: response.headers, text,
        data: text && response.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null }); });
    }); req.on('error', reject); req.end(body);
  });
  return { request, get reads() { return reads; }, get revenueReads() { return revenueReads; }, get sessionReads() { return sessionReads; }, get startCalls() { return startCalls; } };
}

test('anonymous same-origin analytics uses public projection and global cache while admin APIs remain private', async t => {
  const f = await fixture(t); assert.equal(f.startCalls, 1);
  const result = await f.request('/api/analytics', { headers: { 'sec-fetch-site': 'same-origin', cookie: 'launchpad-session=forged-cookie' } });
  assert.equal(result.status, 200); assert.equal(result.data.launches.total, 0); assert.equal(result.data.lifetime.status, 'backfilling');
  assert.equal(result.data.burnSupply.totalBurned, '186000000000000'); assert.equal(result.data.refreshMs, 30000);
  assert.equal(result.data.revenue.totalUsdEstimate, 12); assert.equal(f.revenueReads, 1);
  assert.equal(result.headers['set-cookie'], undefined); assert.equal(f.sessionReads, 0); assert.equal(f.reads, 1);
  await f.request('/api/analytics', { headers: { 'x-forwarded-for': '192.0.2.2' } }); assert.equal(f.reads, 1); assert.equal(f.revenueReads, 1);
  for (const path of ['/api/admin/volume', '/api/admin/revenue-audit', '/api/admin/protocol-treasury', '/api/admin/launches', '/api/admin/failed-launch-archive']) {
    const response = await f.request(path); assert.equal(response.status, 401, path);
  }
});

test('analytics blocks mutation, force-refresh parameters and cross-origin requests before expensive reads', async t => {
  const f = await fixture(t);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) assert.equal((await f.request('/api/analytics', { method })).status, 405, method);
  for (const query of ['?force=1', '?accountId=private', '?mint=coin', '?refresh=1']) assert.equal((await f.request('/api/analytics' + query)).status, 400, query);
  for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { 'x-forwarded-proto': 'http' }, { host: 'evil.example' }]) {
    assert.equal((await f.request('/api/analytics', { headers })).status, 403);
  }
  assert.equal(f.reads, 0); assert.equal(f.sessionReads, 0);
  assert.equal((await f.request('/api/analytics/private')).status, 404);
});

test('public endpoint limits by actual forwarded client IP and sends retry guidance', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 30; i++) assert.equal((await f.request('/api/analytics')).status, 200);
  const blocked = await f.request('/api/analytics'); assert.equal(blocked.status, 429); assert(Number(blocked.headers['retry-after']) >= 1);
  assert.equal(f.reads, 1);
  assert.equal((await f.request('/api/analytics', { headers: { 'x-forwarded-for': '192.0.2.3' } })).status, 200);
  assert.equal(f.reads, 1);
});

test('analytics page opens from external links and scripts retain the existing content security policy', async t => {
  const f = await fixture(t);
  const page = await f.request('/analytics', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } });
  assert.equal(page.status, 200); assert.match(page.headers['content-type'], /text\/html/); assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  for (const path of ['/analytics.js', '/analytics.css', '/analytics-view.mjs', '/burn-valuation.mjs']) assert.equal((await f.request(path)).status, 200, path);
  assert.equal(f.sessionReads, 0); assert.equal(f.reads, 0);
});
