import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createAccountApp } from '../src/account-app.mjs';

const navigation = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

async function fixture(t, { toolkit = false } = {}) {
  let sessionReads = 0;
  const accounts = {
    master: Buffer.alloc(32),
    async getSession() { sessionReads++; return null; },
    async registry() { return { accounts: [] }; },
  };
  const server = createAccountApp({
    accounts, runtimes: {}, policy: {}, publicUrl: 'https://launch.example',
    features: { toolkit, telegram: false, walletOnly: true },
    launchpad: {
      async image() { return { type: 'image/png', bytes: Buffer.from('public image') }; },
      async metadata() { return { name: 'Public token' }; },
    },
    marketData: {}, funding: {}, protocolFees: {}, branding: {}, adminPanel: {}, adminRevenue: {},
    explore: { async list() { return { coins: [] }; } }, trading: {},
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await server.closeServices();
  });
  const request = (path, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path, method,
      headers: { host: 'launch.example', 'x-forwarded-proto': 'https', ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end();
  });
  return { request, get sessionReads() { return sessionReads; } };
}

test('external links open static public pages without consulting account sessions', async t => {
  const h = await fixture(t);
  for (const site of ['cross-site', 'same-site']) {
    for (const path of ['/', '/explore', '/coin?mint=So11111111111111111111111111111111111111112', '/launchpad', '/wallet-account', '/profile', '/user/creator', '/launched-tokens', '/admin', '/docs', '/terms', '/privacy']) {
      const result = await h.request(path, { headers: { ...navigation, 'sec-fetch-site': site, cookie: 'launchpad-session=private-session' } });
      assert.equal(result.status, 200, `${site} ${path}`);
      assert.match(result.headers['content-type'], /^text\/html/);
      assert.ok(result.text.length > 100);
      assert.equal(result.headers['set-cookie'], undefined);
      assert.equal(result.headers['access-control-allow-origin'], undefined);
      assert.equal(result.headers['x-frame-options'], 'DENY');
      assert.match(result.headers['content-security-policy'], /frame-ancestors 'none'/);
      assert.ok(!result.text.includes('private-session'));
    }
  }
  assert.equal(h.sessionReads, 0);
  const script = await h.request('/explore.js', { headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' } });
  assert.equal(script.status, 200); assert.match(script.headers['content-type'], /javascript/);
  for(const [path,dest,type]of [['/explore-search.mjs','script',/javascript/],['/explore-search.css','style',/text\/css/]]){
    const asset=await h.request(path,{headers:{'sec-fetch-site':'same-origin','sec-fetch-mode':'no-cors','sec-fetch-dest':dest}});assert.equal(asset.status,200,path);assert.match(asset.headers['content-type'],type);assert(asset.text.length>100);
  }
});

test('external public page links retain legacy redirects and toolkit HTML behavior', async t => {
  const h = await fixture(t);
  for (const path of ['/trade', '/robinhood', '/sessions', '/funding', '/tutorial', '/?tool=trade']) {
    const result = await h.request(path, { headers: navigation });
    assert.equal(result.status, 303, path); assert.equal(result.headers.location, '/');
  }
  const oldToken = await h.request('/?token=So11111111111111111111111111111111111111112', { headers: navigation });
  assert.equal(oldToken.status, 303); assert.equal(oldToken.headers.location, '/coin?mint=So11111111111111111111111111111111111111112');
  const toolkit = await fixture(t, { toolkit: true });
  for (const path of ['/trade', '/robinhood', '/sessions', '/funding', '/tutorial']) {
    const result = await toolkit.request(path, { headers: navigation });
    assert.equal(result.status, 200, path); assert.match(result.headers['content-type'], /^text\/html/);
  }
});

test('cross-site and same-site API requests and non-GET methods remain blocked before authentication', async t => {
  const h = await fixture(t);
  for (const site of ['cross-site', 'same-site']) {
    const headers = { ...navigation, 'sec-fetch-site': site, cookie: 'launchpad-session=private-session' };
    for (const path of ['/api/session', '/api/account', '/api/admin/health', '/api/explore', '/api/launchpad', '/api/launchpad/trading/submit', '/healthz', '/readyz', '/not-a-page', '/coin/extra', '/%63oin', '/explore.js', '/style.css', '/user', '/user/creator/private', '/user/creator.js', '/%75ser/creator']) {
      const result = await h.request(path, { headers });
      assert.equal(result.status, 403, `${site} ${path}`); assert.match(result.text, /Cross-site request refused/);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
      for (const path of ['/', '/user/creator', '/creator?username=creator', '/launchpad', '/api/launchpad/trading/submit']) {
        const result = await h.request(path, { method, headers });
        assert.equal(result.status, 403, `${site} ${method} ${path}`);
      }
    }
  }
  assert.equal(h.sessionReads, 0);
});

test('HTML navigation exception requires browser top-level navigation metadata', async t => {
  const h = await fixture(t);
  for (const headers of [
    { 'sec-fetch-site': 'cross-site' },
    { ...navigation, 'sec-fetch-mode': 'cors' },
    { ...navigation, 'sec-fetch-mode': 'no-cors' },
    { ...navigation, 'sec-fetch-mode': 'same-origin' },
    { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'document' },
    { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
    { ...navigation, 'sec-fetch-dest': 'iframe' },
    { ...navigation, 'sec-fetch-dest': 'frame' },
    { ...navigation, 'sec-fetch-dest': 'empty' },
    { ...navigation, 'sec-fetch-site': 'invalid' },
  ]) {
    const result = await h.request('/', { headers });
    assert.equal(result.status, 403, JSON.stringify(headers));
    assert.match(result.text, /Cross-site request refused/);
  }
  for (const headers of [{}, { 'sec-fetch-site': 'none' }, { 'sec-fetch-site': 'same-origin' }]) {
    assert.equal((await h.request('/', { headers })).status, 200);
    assert.equal((await h.request('/api/session', { headers })).status, 200);
  }
});

test('public links cannot bypass the Origin, configured host or HTTPS proxy checks', async t => {
  const h = await fixture(t);
  for (const origin of ['https://outside.example', 'https://sub.launch.example', 'null']) {
    const result = await h.request('/', { headers: { ...navigation, origin } });
    assert.equal(result.status, 403); assert.match(result.text, /Cross-origin request refused/);
  }
  assert.equal((await h.request('/', { headers: { ...navigation, origin: 'https://launch.example' } })).status, 200);
  const host = await h.request('/', { headers: { ...navigation, host: 'outside.example' } });
  assert.equal(host.status, 403); assert.match(host.text, /configured Launchpad address/);
  for (const proto of ['', 'http', 'https,http']) {
    const result = await h.request('/', { headers: { ...navigation, 'x-forwarded-proto': proto } });
    assert.equal(result.status, 403); assert.match(result.text, /HTTPS Launchpad website/);
  }
});

test('public media retains cross-origin GET access and branding HEAD support only', async t => {
  const h = await fixture(t), headers = { origin: 'https://metadata.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
  const image = '/token-images/' + 'a'.repeat(64) + '.png', metadata = '/token-metadata/So11111111111111111111111111111111111111112.json';
  // A Robinhood Chain coin's metadata is published under its token address (the token's contractURI / tokenURI).
  const evmMetadata = '/token-metadata/0x5321d3645F2EC860a9986b9906885C054C61b50D.json';
  for (const path of ['/brand-icon.svg', '/brand-logo.svg', '/brand-icon.png', '/brand-avatar.png', '/brand-avatar.jpg', image, metadata, evmMetadata]) {
    const result = await h.request(path, { headers });
    assert.equal(result.status, 200, path); assert.equal(result.headers['access-control-allow-origin'], '*');
    assert.ok(result.text.length > 0);
    assert.equal((await h.request(path, { method: 'POST', headers })).status, 403);
  }
  // A Robinhood pair badge is public media too; with the venue off (this fixture) it is a plain 404, never a cross-site refusal.
  const badge = await h.request('/robinhood-pairs/logo/0x5321d3645F2EC860a9986b9906885C054C61b50D', { headers });
  assert.equal(badge.status, 404); assert.equal(badge.headers['access-control-allow-origin'], '*'); assert.match(badge.text, /No logo/);
  assert.equal((await h.request('/robinhood-pairs/logo/not-an-address', { headers })).status, 403, 'anything else stays behind the cross-site gate');
  const head = await h.request('/brand-icon.svg', { method: 'HEAD', headers });
  assert.equal(head.status, 200); assert.equal(head.text, ''); assert.equal(head.headers['access-control-allow-origin'], '*');
  assert.equal((await h.request(image, { method: 'HEAD', headers })).status, 403);
  assert.equal((await h.request(metadata, { method: 'HEAD', headers })).status, 403);
  assert.equal((await h.request('/api/account', { headers })).status, 403);
});

test('public user paths serve the creator shell and legacy or mixed-case URLs redirect safely',async t=>{
  const h=await fixture(t);
  for(const site of ['cross-site','same-site']){
    const headers={...navigation,'sec-fetch-site':site};
    for(const [path,target] of [['/creator?username=Sun_Rise','/user/sun_rise'],['/creator?username=sun-rise&next=https://outside.example','/user/sun-rise'],['/user/Sun_Rise','/user/sun_rise'],['/user/sun_rise/','/user/sun_rise']]){
      const result=await h.request(path,{headers});assert.equal(result.status,308);assert.equal(result.headers.location,target);assert.equal(result.headers['set-cookie'],undefined);
    }
    const profile=await h.request('/user/sun_rise?username=someone_else',{headers});assert.equal(profile.status,200);assert.match(profile.text,/src="\/creator\.js(?:\?v=[0-9a-f]{16})?"/);assert.match(profile.headers['content-type'],/^text\/html/);
  }
  for(const path of ['/user/ab','/user/'+('a'.repeat(33)),'/user/sunrise/extra','/user/evil%2fapi','/user/%73unrise','/user/%2e%2e%2fapi']){
    const result=await h.request(path);assert.equal(result.status,404,path);assert.doesNotMatch(result.headers['content-type'],/html/);
  }
  for(const headers of [{'sec-fetch-site':'cross-site'}, {...navigation,'sec-fetch-mode':'cors'}, {...navigation,'sec-fetch-dest':'iframe'}, {...navigation,origin:'https://outside.example'}, {...navigation,host:'outside.example'}, {...navigation,'x-forwarded-proto':'http'}])assert.equal((await h.request('/user/sunrise',{headers})).status,403);
  assert.equal(h.sessionReads,0);
});

test('HEAD answers pages, static files and health checks like GET without a body', async t => {
  const h = await fixture(t);
  for (const path of ['/', '/explore', '/coin', '/launchpad', '/style.css', '/navigation.mjs', '/brand-icon.png', '/user/sun_rise', '/healthz', '/readyz']) {
    const get = await h.request(path), head = await h.request(path, { method: 'HEAD' });
    assert.equal(get.status, 200, path); assert.equal(head.status, 200, path); assert.equal(head.text, '', path);
    assert.equal(head.headers['content-type'], get.headers['content-type'], path);
    if (get.headers['content-length']) assert.equal(head.headers['content-length'], get.headers['content-length'], path);
  }
  const redirect = await h.request('/creator?username=Sun_Rise', { method: 'HEAD' });
  assert.equal(redirect.status, 308); assert.equal(redirect.headers.location, '/user/sun_rise');
});

test('browser navigations to unknown pages get the site 404 page while scripts and APIs keep JSON', async t => {
  const h = await fixture(t), browser = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' };
  for (const path of ['/not-a-page', '/coin/extra', '/user/ab', '/user/sunrise/extra', '/404']) {
    const page = await h.request(path, { headers: browser });
    assert.equal(page.status, 404, path); assert.match(page.headers['content-type'], /^text\/html/, path);
    assert.match(page.text, /<title>Page not found — Launchpad<\/title>/); assert.match(page.text, /<a href="\/">Explore coins<\/a>/);
    // CSP-compliant: no executable inline script and no inline style; the site's stylesheets are versioned.
    assert.doesNotMatch(page.text, /<script(?![^>]*type="importmap")/); assert.doesNotMatch(page.text, /\sstyle=/);
    assert.match(page.headers['content-security-policy'], /^default-src 'self'; script-src 'self' 'sha256-[^']+'; style-src 'self' 'sha256-/);
    assert.match(page.text, /href="\/curve-theme\.css\?v=[0-9a-f]{16}"/);
    const head = await h.request(path, { method: 'HEAD', headers: browser }); assert.equal(head.status, 404); assert.equal(head.text, '');
  }
  for (const [path, headers] of [['/not-a-page', {}], ['/not-a-page', { accept: 'application/json' }], ['/api/not-a-route', browser], ['/user/ab', { accept: '*/*' }]]) {
    const result = await h.request(path, { headers });
    assert.equal(result.status, 404, path); assert.match(result.headers['content-type'], /^application\/json/, path); assert.ok(JSON.parse(result.text).error);
  }
  const post = await h.request('/not-a-page', { method: 'POST', headers: { accept: 'text/html' } });
  assert.equal(post.status, 404); assert.match(post.headers['content-type'], /^application\/json/);
});
