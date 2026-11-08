import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createAccountApp } from '../src/account-app.mjs';
import { QUOTE_LOGO_PATHS } from '../public/quote-logo-paths.mjs';

async function fixture(t) {
  let sessionReads = 0;
  const accounts = { master: Buffer.alloc(32), list: async () => [], hostStore: { read: async () => null },
    getSession: async () => { sessionReads++; return null; }, verifyCsrf: async () => false, registry: async () => ({ accounts: [] }) };
  const server = createAccountApp({ accounts, runtimes: {}, policy: {}, publicUrl: 'https://launch.example', launchpad: {},
    marketData: {}, protocolFees: {}, protocolTreasury: {}, branding: {}, adminPanel: {}, adminRevenue: {}, explore: {}, trading: {}, adminVolume: {}, lifetimeVolume: {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await server.closeServices(); });
  const request = (path, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path, method,
      headers: { host: 'launch.example', 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.0.2.1', ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
    }); req.on('error', reject); req.end();
  });
  return { request, get sessionReads() { return sessionReads; } };
}

test('every declared local quote logo serves its exact bytes with raster MIME and revalidation', async t => {
  const f = await fixture(t), entries = Object.entries(QUOTE_LOGO_PATHS);
  assert(entries.length > 0, 'The release includes a populated mint-specific logo map.');
  for (const [mint, path] of entries) {
    assert(path.startsWith('/quote-logos/' + mint + '.'));
    const result = await f.request(path + '?v=49');
    assert.equal(result.status, 200, path);
    assert.equal(result.headers['content-type'], path.endsWith('.jpg') ? 'image/jpeg' : path.endsWith('.webp') ? 'image/webp' : 'image/png', path);
    assert.deepEqual(result.bytes, await readFile(new URL('../public' + path, import.meta.url)), path);
    assert.equal(Number(result.headers['content-length']), result.bytes.length);
    // Release media without its content hash (a manual `?v=49` here): reused for a day, then
    // revalidated with its ETag (v71.25 asset caching; pages, scripts and styles still revalidate always).
    assert.equal(result.headers['cache-control'], 'public, max-age=86400, stale-while-revalidate=604800'); assert(result.headers.etag);
    assert.equal(result.headers['access-control-allow-origin'], undefined);
  }
  assert.equal(f.sessionReads, 0);
});

test('bundled font serves exact WOFF2 binary and license plus logo modules have text MIME', async t => {
  const f = await fixture(t), path = '/fonts/InterVariable.woff2', font = await f.request(path + '?v=4.1');
  assert.equal(font.status, 200); assert.equal(font.headers['content-type'], 'font/woff2'); assert.equal(font.bytes.subarray(0, 4).toString(), 'wOF2');
  assert.deepEqual(font.bytes, await readFile(new URL('../public' + path, import.meta.url)));
  assert.equal(font.headers['cache-control'], 'public, max-age=86400, stale-while-revalidate=604800');
  for (const [path, type] of [['/fonts/Inter-LICENSE.txt', 'text/plain'], ['/coin-image.mjs', 'text/javascript'], ['/quote-logos.mjs', 'text/javascript'], ['/quote-logo-paths.mjs', 'text/javascript'], ['/quote-logos.css', 'text/css'], ['/amm-branding.mjs', 'text/javascript'], ['/amm-branding.css', 'text/css'], ['/custom-pair-fields.mjs','text/javascript']]) {
    const result = await f.request(path); assert.equal(result.status, 200, path); assert.equal(result.headers['content-type'], type + '; charset=utf-8');
    assert.deepEqual(result.bytes, await readFile(new URL('../public' + path, import.meta.url)));
    assert.equal(result.headers['cache-control'], 'public, max-age=0, must-revalidate', path + ' (text always revalidates)');
  }
  assert.equal(f.sessionReads, 0);
});

test('verified launch-origin artwork is served from the fixed public routes', async t => {
  const f = await fixture(t);
  for (const path of ['/pair-origin-pump.png','/pair-origin-stonk.png']) {
    const result = await f.request(path);
    assert.equal(result.status,200,path);
    assert.equal(result.headers['content-type'],'image/png');
    assert.deepEqual(result.bytes,await readFile(new URL('../public'+path,import.meta.url)));
    assert.equal(result.bytes.subarray(1,4).toString(),'PNG');
  }
  assert.equal(f.sessionReads,0);
});

test('logo and font HEAD and conditional requests return no binary body', async t => {
  const f = await fixture(t), logo = Object.values(QUOTE_LOGO_PATHS)[0]; assert(logo);
  for (const path of [logo, '/fonts/InterVariable.woff2']) {
    const get = await f.request(path), head = await f.request(path, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(head.bytes.length, 0); assert.equal(head.headers['content-length'], get.headers['content-length']);
    assert.equal(head.headers.etag, get.headers.etag); assert.equal(head.headers['content-type'], get.headers['content-type']);
    for (const method of ['GET', 'HEAD']) {
      const unchanged = await f.request(path, { method, headers: { 'if-none-match': get.headers.etag } });
      assert.equal(unchanged.status, 304); assert.equal(unchanged.bytes.length, 0);
    }
    assert.equal((await f.request(path, { headers: { 'if-none-match': '"older-release"' } })).status, 200);
  }
});

test('unknown logo/font and traversal paths never read arbitrary files', async t => {
  const f = await fixture(t);
  for (const path of ['/quote-logos/unknown.png', '/quote-logos/11111111111111111111111111111111.png', '/fonts/unknown.woff2', '/fonts/',
    '/quote-logos/../package.json', '/quote-logos/%2e%2e/package.json', '/quote-logos/..%2fsrc%2faccount-app.mjs', '/fonts/../../src/account-app.mjs', '/fonts/%2e%2e%2fpackage.json']) {
    const response = await f.request(path); assert.equal(response.status, 404, path); assert.match(response.bytes.toString(), /Not found/);
  }
  assert.equal(f.sessionReads, 0);
});

test('logo/font routes preserve origin guards and private API authentication', async t => {
  const f = await fixture(t), logo = Object.values(QUOTE_LOGO_PATHS)[0]; assert(logo);
  for (const path of [logo, '/fonts/InterVariable.woff2', '/quote-logos.mjs', '/coin-image.mjs', '/api/admin/volume', '/api/account']) {
    for (const headers of [{ origin: 'https://other.example' }, { 'sec-fetch-site': 'cross-site' }, { 'x-forwarded-proto': 'http' }, { host: 'other.example' }]) {
      const response = await f.request(path, { headers }); assert.equal(response.status, 403, path); assert.equal(response.headers['access-control-allow-origin'], undefined);
    }
  }
  for (const path of ['/api/admin/volume', '/api/account']) assert.equal((await f.request(path)).status, 401, path);
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) assert.equal((await f.request(logo, { method })).status, 404, method);
  assert.equal((await f.request('/api/curve/circulating-supply')).status, 404, 'Canceled supply endpoint is not registered.');
});
