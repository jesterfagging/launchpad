import test from 'node:test';
import assert from 'node:assert/strict';
import { publicAddress, screenUrl, resolvePublic, authorizeRequest, requestDecision, domainAllowed } from '../src/agent/egress.mjs';

const ALLOW = ['solana.com', 'docs.raydium.io'];

test('only public unicast addresses pass the address classifier', () => {
  for (const address of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.5', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '198.18.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'ff02::1', '::ffff:10.0.0.1', '2002:0a00:0001::1', '2001:db8::1']) assert.equal(publicAddress(address), false, address);
  for (const address of ['8.8.8.8', '104.18.3.1', '2606:4700::6810:84e5', '2a00:1450:4009:81f::200e']) assert.equal(publicAddress(address), true, address);
  assert.equal(publicAddress('not-an-ip'), false);
});

test('URL screening blocks schemes, credentials, ports, IP hosts and foreign domains', () => {
  assert.equal(screenUrl('http://solana.com/docs', ALLOW).code, 'scheme');
  assert.equal(screenUrl('ftp://solana.com/', ALLOW).code, 'scheme');
  assert.equal(screenUrl('javascript:alert(1)', ALLOW).code, 'scheme');
  assert.equal(screenUrl('https://user:pw@solana.com/', ALLOW).code, 'credentials');
  assert.equal(screenUrl('https://solana.com:8443/', ALLOW).code, 'port');
  assert.equal(screenUrl('https://1.2.3.4/', ALLOW).code, 'host');
  assert.equal(screenUrl('https://[::1]/', ALLOW).code, 'host');
  assert.equal(screenUrl('https://localhost/', ALLOW).code, 'host');
  assert.equal(screenUrl('https://evil-solana.com/', ALLOW).code, 'domain');
  assert.equal(screenUrl('https://solana.com.evil.net/', ALLOW).code, 'domain');
  assert.equal(screenUrl('https://' + 'a'.repeat(3000) + '.com/', ALLOW).code, 'length');
  assert.equal(screenUrl(42, ALLOW).code, 'length');
  const ok = screenUrl('https://Docs.Raydium.io/raydium/pool#frag', ALLOW);
  assert.equal(ok.ok, true); assert.equal(ok.host, 'docs.raydium.io'); assert.equal(ok.url, 'https://docs.raydium.io/raydium/pool');
  assert.equal(screenUrl('https://sub.solana.com:443/x', ALLOW).ok, true);
  assert.equal(domainAllowed('SOLANA.COM.', ALLOW), true);
});

test('DNS answers are verified at connection time: any private answer rejects the host', async () => {
  const lookup = async name => name === 'rebind.solana.com' ? [{ address: '104.18.3.1' }, { address: '10.0.0.5' }] : name === 'nx.solana.com' ? Promise.reject(Error('ENOTFOUND')) : [{ address: '104.18.3.1' }];
  assert.equal((await resolvePublic('solana.com', { lookup })).ok, true);
  assert.equal((await resolvePublic('rebind.solana.com', { lookup })).code, 'private');
  assert.equal((await resolvePublic('nx.solana.com', { lookup })).code, 'dns');
  assert.equal((await resolvePublic('empty.solana.com', { lookup: async () => [] })).code, 'dns');
  const authorized = await authorizeRequest('https://solana.com/news', ALLOW, { lookup });
  assert.equal(authorized.ok, true); assert.deepEqual(authorized.addresses, ['104.18.3.1']);
  assert.equal((await authorizeRequest('https://rebind.solana.com/', ALLOW, { lookup })).code, 'private');
  assert.equal((await authorizeRequest('http://solana.com/', ALLOW, { lookup })).code, 'scheme');
});

test('browser request interception is GET-only, https-only and allowlisted for every hop', () => {
  const policy = { allowlist: ALLOW };
  assert.equal(requestDecision({ url: 'https://solana.com/a.css', resourceType: 'Stylesheet' }, policy).allow, true);
  assert.equal(requestDecision({ url: 'https://solana.com/api', method: 'POST', resourceType: 'Fetch' }, policy).allow, false);
  assert.equal(requestDecision({ url: 'wss://solana.com/ws', resourceType: 'WebSocket' }, policy).allow, false);
  assert.equal(requestDecision({ url: 'https://tracker.example.com/pixel.gif', resourceType: 'Image' }, policy).allow, false);
  assert.equal(requestDecision({ url: 'http://solana.com/', isNavigation: true, resourceType: 'Document' }, policy).allow, false);
  assert.equal(requestDecision({ url: 'https://solana.com/', isNavigation: true, resourceType: 'Document' }, policy).allow, true);
  assert.equal(requestDecision({ url: 'https://solana.com/x', resourceType: 'EventSource' }, policy).allow, false);
});
