import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AccountService } from '../src/accounts.mjs';
import { createAccountApp } from '../src/account-app.mjs';
import { PumpTestService } from '../src/pump-test-service.mjs';
import { totp } from '../src/totp.mjs';

const password = 'private-pump-model-tests-only-123';
const previewInput = { graduationFeeBps: '2885', tradeFeeBps: '100', solUsdMicros: '150000000' };
const apiPaths = ['/api/admin/pump-test', '/api/admin/pump-test/pairs'];
const modulePaths = ['/admin-pump-test-ui.mjs', '/pump-launch-test-ui.mjs', '/admin-pump-deployment-ui.mjs'];

// Real account/session/MFA/CSRF storage with the real local-only model service.
// Every unrelated service is inert; any runtime or launch action is recorded.
async function fixture(t, { pinned = false, pumpFundedTest = null, pumpDeployment = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-pump-test-http-'));
  const accounts = await new AccountService(dir).init();
  const ownerAccount = await accounts.register('pump_owner', password); await accounts.setAdmin(ownerAccount.id);
  const setup = await accounts.beginMfa(ownerAccount.id, password); await accounts.enableMfa(ownerAccount.id, password, totp(setup.secret, Date.now()));
  const owner = await accounts.createSession(ownerAccount.id, { mfaVerified: true });
  const otherAccount = await accounts.register('pump_other', password), other = await accounts.createSession(otherAccount.id);
  const forbidden = [], launchCalls = [];
  const forbid = name => async () => { forbidden.push(name); throw Error('Unexpected external operation: ' + name); };
  const launchpad = {};
  for (const name of ['prepare', 'estimate', 'create']) launchpad[name] = async (...args) => { launchCalls.push({ name, args }); return { ok: true }; };
  const pumpTest = new PumpTestService({ accounts, ownerId: pinned ? owner.account.id : '' });
  const server = createAccountApp({ accounts, runtimes: { readSettings: forbid('readSettings'), get: forbid('getRuntime') }, policy: {}, launchpad, pumpTest, pumpFundedTest, pumpDeployment,
    marketData: {}, protocolFees: {}, protocolTreasury: {}, protocolGasFunding: {}, branding: {}, adminPanel: {}, adminRevenue: {}, adminRevenueAudit: {}, explore: {}, trading: {}, adminVolume: {}, lifetimeVolume: {}, publicAnalytics: {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await server.closeServices(); await rm(dir, { recursive: true, force: true }); });
  async function request(path, { auth, body, method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) {
    const response = await fetch(base + path, { method, redirect: 'manual', headers: { ...(auth ? { cookie: `launchpad-session=${auth.token}`, 'x-control-token': auth.csrfToken } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { code: response.status, headers: response.headers, text, body: response.headers.get('content-type')?.includes('application/json') && text ? JSON.parse(text) : text };
  }
  return { accounts, owner, other, request, server, pumpTest, forbidden, launchCalls, async promoteOther() { await accounts.setAdmin(other.account.id); const setup = await accounts.beginMfa(other.account.id, password); await accounts.enableMfa(other.account.id, password, totp(setup.secret, Date.now())); return accounts.createSession(other.account.id, { mfaVerified: true }); } };
}

test('Pump lab APIs require current owner, MFA and CSRF before model data is returned', async t => {
  const h = await fixture(t, { pinned: true });
  for (const path of apiPaths) {
    assert.equal((await h.request(path)).code, 401, path + ' guest');
    assert.equal((await h.request(path, { auth: h.other })).code, 403, path + ' ordinary');
    assert.equal((await h.request(path, { auth: h.owner, headers: { 'x-control-token': 'wrong' } })).code, 403, path + ' csrf');
  }
  assert.equal((await h.request('/api/admin/pump-test/preview', { body: previewInput })).code, 401);
  assert.equal((await h.request('/api/admin/pump-test/preview', { auth: h.other, body: previewInput })).code, 403);
  await h.accounts.setAdmin(h.other.account.id);
  assert.equal((await h.request(apiPaths[0], { auth: h.other })).code, 403, 'admin without enrolled MFA');
  const otherAdmin = await h.promoteOther();
  assert.equal((await h.request(apiPaths[0], { auth: otherAdmin })).code, 403, 'another verified admin is not the pinned owner');
  assert.equal((await h.request('/api/session', { auth: h.owner })).body.pumpTestAllowed, true);
  assert.equal((await h.request('/api/session', { auth: otherAdmin })).body.pumpTestAllowed, false);
  const meta = await h.request(apiPaths[0], { auth: h.owner });
  assert.equal(meta.code, 200); assert.equal(meta.body.mode, 'local-test'); assert.equal(meta.body.network, 'none'); assert.equal(meta.body.fundedLaunchEnabled, false); assert.equal(meta.body.publicLaunchEnabled, false); assert.equal(meta.headers.get('cache-control'), 'no-store');
  const pairs = await h.request(apiPaths[1], { auth: h.owner }); assert.equal(pairs.code, 200); assert.equal(pairs.headers.get('cache-control'), 'no-store');
  assert.deepEqual(h.forbidden, []); assert.deepEqual(h.launchCalls, []);
});

test('both lab browser modules are private cookie-gated no-store assets, never public static files', async t => {
  const h = await fixture(t, { pinned: true });
  for (const path of modulePaths) {
    assert.equal((await h.request(path)).code, 401, path + ' guest');
    assert.equal((await h.request(path, { auth: h.other })).code, 403, path + ' ordinary');
    const result = await h.request(path + '?v=60', { headers: { cookie: `launchpad-session=${h.owner.token}` } });
    assert.equal(result.code, 200, path + ' owner cookie without CSRF'); assert.match(result.headers.get('content-type'), /javascript/); assert.match(result.headers.get('cache-control'), /(?:^|,\s*)no-store(?:,|$)/); assert.match(result.text, /Simulation only|simulation|local-test|deployment/i);
    const head = await h.request(path, { auth: h.owner, method: 'HEAD' }); assert.equal(head.code, 405); assert.equal(head.text, ''); assert.match(head.headers.get('cache-control'), /(?:^|,\s*)no-store(?:,|$)/);
    assert.equal((await h.request(path, { auth: h.owner, method: 'POST', body: {} })).code, 405);
    assert.equal((await h.request(path + '.map')).code, 404);
  }
  await h.accounts.revokeSession(h.owner.token);
  for (const path of modulePaths) assert.equal((await h.request(path, { auth: h.owner })).code, 401);
  assert.deepEqual(h.forbidden, []);
});

test('ambiguous unpinned owner selection fails closed and role revocation is immediate', async t => {
  const h = await fixture(t); assert.equal((await h.request(apiPaths[0], { auth: h.owner })).code, 200);
  const otherAdmin = await h.promoteOther();
  for (const auth of [h.owner, otherAdmin]) for (const path of [...apiPaths, ...modulePaths]) assert.equal((await h.request(path, { auth })).code, 403, path);
  await h.accounts.setAdmin(h.other.account.id, false);
  assert.equal((await h.request(apiPaths[0], { auth: h.owner })).code, 200);
  await h.accounts.setAdmin(h.owner.account.id, false);
  assert.equal((await h.request(apiPaths[0], { auth: h.owner })).code, 403);
  assert.deepEqual(h.forbidden, []);
});

test('preview is local-only, validates fee/price inputs and exposes no execution route', async t => {
  const h = await fixture(t);
  assert.equal((await h.request('/api/admin/pump-test/preview', { auth: h.owner, body: previewInput, headers: { 'x-control-token': 'bad' } })).code, 403);
  const result = await h.request('/api/admin/pump-test/preview', { auth: h.owner, body: previewInput });
  assert.equal(result.code, 200); assert.equal(result.headers.get('cache-control'), 'no-store'); assert(result.body.estimate); assert(Number(result.body.estimate.lpTotalUsd) > 0); assert.equal(Number(result.body.estimate.poolOpeningFdvUsd).toFixed(0), '50000');
  const small = await h.request('/api/admin/pump-test/preview', { auth: h.owner, body: { ...previewInput, preset: 'micro-test' } });
  assert.equal(small.code, 200); assert.equal(Number(small.body.estimate.poolOpeningFdvUsd).toFixed(0), '500'); assert(Number(small.body.estimate.lpTotalUsd) > 0 && Number(small.body.estimate.lpTotalUsd) < 500); assert.equal(small.body.fundedLaunchEnabled, false);
  for (const body of [{ ...previewInput, preset: 'public-test' }, { ...previewInput, graduationFeeBps: 2500 }, { ...previewInput, graduationFeeBps: 3001 }, { ...previewInput, graduationFeeBps: '25.5' }, { ...previewInput, tradeFeeBps: 301 }, { ...previewInput, solUsdMicros: 0 }, { ...previewInput, graduationFeeBps: undefined }, { ...previewInput, quoteId: 'not-a-catalogue-mint' }, { ...previewInput, fundedLaunchEnabled: true, rpcUrl: 'https://untrusted.invalid', secretKey: 'never-sign' }]) {
    assert.equal((await h.request('/api/admin/pump-test/preview', { auth: h.owner, body })).code, 400);
  }
  for (const path of ['/api/admin/pump-test/create', '/api/admin/pump-test/launch', '/api/admin/pump-test/sign', '/api/admin/pump-test/migrate', '/api/admin/pump-test/burn', '/api/admin/pump-test/install-signer']) {
    assert.equal((await h.request(path, { auth: h.owner, body: { ...previewInput, privateKey: 'never-sign-this', fundedLaunchEnabled: true } })).code, 404, path);
  }
  for (const path of apiPaths) assert.equal((await h.request(path, { auth: h.owner, body: {} })).code, 405);
  assert.equal((await h.request('/api/admin/pump-test/preview', { auth: h.owner })).code, 405);
  assert.deepEqual(h.forbidden, []); assert.deepEqual(h.launchCalls, []);
});

test('session or owner changes during asynchronous work suppress completed private results', async t => {
  const h = await fixture(t), original = h.pumpTest.preview.bind(h.pumpTest);
  h.pumpTest.preview = async (...args) => { const result = await original(...args); await h.accounts.revokeSession(h.owner.token); return { ...result, privateSentinel: 'DO_NOT_RETURN_PRIVATE_RESULT' }; };
  const result = await h.request('/api/admin/pump-test/preview', { auth: h.owner, body: previewInput });
  assert([401, 403].includes(result.code)); assert.doesNotMatch(result.text, /DO_NOT_RETURN_PRIVATE_RESULT|lpTotalUsd/); assert.deepEqual(h.forbidden, []);
  const currentOwner = await h.accounts.createSession(h.owner.account.id, { mfaVerified: true }), read = h.pumpTest.read.bind(h.pumpTest);
  h.pumpTest.read = async (...args) => { const value = await read(...args); await h.accounts.setAdmin(h.other.account.id); return { ...value, privateSentinel: 'DO_NOT_RETURN_AMBIGUOUS_OWNER' }; };
  const changed = await h.request(apiPaths[0], { auth: currentOwner });
  assert.equal(changed.code, 403); assert.doesNotMatch(changed.text, /DO_NOT_RETURN_AMBIGUOUS_OWNER|verification/);
});

test('normal launch paths reject Pump markers before forwarding to Raydium launch actions', async t => {
  const h = await fixture(t);
  for (const path of ['/api/launchpad/prepare', '/api/launchpad/estimate', '/api/launchpad/create']) for (const marker of [{ route: 'pump' }, { route: 'pumpswap' }, { destination: 'pumpswap' }, { launchMode: 'pump-test' }, { venue: 'pump' }]) {
    assert.equal((await h.request(path, { auth: h.owner, body: marker })).code, 400, path + JSON.stringify(marker));
  }
  assert.deepEqual(h.launchCalls, []);
  assert.equal((await h.request('/api/launchpad/prepare', { auth: h.other, body: { route: 'raydium' } })).code, 200);
  assert.equal(h.launchCalls.length, 1); assert.equal(h.launchCalls[0].name, 'prepare'); assert.deepEqual(h.forbidden, []);
});

const fundedPaths = ['/api/admin/pump-test/funded/status', '/api/admin/pump-test/funded/prepare', '/api/admin/pump-test/funded/submit', '/api/admin/pump-test/funded/reconcile'];
const deploymentPaths = ['/api/admin/pump-test/deployment/status', '/api/admin/pump-test/deployment/prepare', '/api/admin/pump-test/deployment/submit', '/api/admin/pump-test/deployment/reconcile'];
test('funded and deployment routes enforce owner, MFA, CSRF and exact methods before any service call', async t => {
  const calls = [], service = Object.fromEntries(['status','prepare','submit','reconcile'].map(method => [method, async (...args) => { calls.push(method); const context = method==='status'?args[1]:args[2]; await context.authorize(); return {ok:true}; }]));
  const h=await fixture(t,{pinned:true,pumpFundedTest:service,pumpDeployment:service});
  for(const path of [...fundedPaths,...deploymentPaths]) {
    const body=path.endsWith('/status')?undefined:{};
    assert.equal((await h.request(path,{body})).code,401);
    assert.equal((await h.request(path,{body,auth:h.other})).code,403);
    assert.equal((await h.request(path,{body,auth:h.owner,headers:{'x-control-token':'wrong'}})).code,403);
    assert.equal((await h.request(path,{auth:h.owner,method:body===undefined?'POST':'GET',...(body===undefined?{body:{}}:{})})).code,405);
  }
  const other=await h.promoteOther();
  for(const path of [...fundedPaths,...deploymentPaths])assert.equal((await h.request(path,{auth:other,...(!path.endsWith('/status')?{body:{}}:{})})).code,403);
  assert.deepEqual(calls,[]);
  for(const path of [...fundedPaths,...deploymentPaths]) {
    const result=await h.request(path,{auth:h.owner,...(!path.endsWith('/status')?{body:{}}:{})});
    assert.equal(result.code,200,path);assert.equal(result.headers.get('cache-control'),'no-store');
  }
  assert.equal(calls.length,8);
  for(const path of ['/api/admin/pump-test/funded/sign','/api/admin/pump-test/deployment/install-key','/api/admin/pump-test/funded/prepare?programId=override'])assert([400,404].includes((await h.request(path,{auth:h.owner,body:{}})).code));
});
test('funded route remains disabled without a private verified deployment',async t=>{
  const h=await fixture(t,{pinned:true});
  const result=await h.request('/api/admin/pump-test/funded/status',{auth:h.owner});
  assert.equal(result.code,200);assert.equal(result.body.enabled,false);assert.equal(result.body.verifiedDeployment,false);assert.deepEqual(result.body.actions,[]);
  assert.doesNotMatch(result.text,/rpcUrl|configPath|sessionToken|secretKey/);assert.deepEqual(h.forbidden,[]);
});
test('funded HTTP context rechecks owner after async work and before service broadcast authorization',async t=>{
  let h,broadcasts=0;
  const service={submit:async(session,input,context)=>{await h.accounts.revokeSession(h.owner.token);await context.authorize();broadcasts++;return {privateResult:'must-not-leak'};}};
  h=await fixture(t,{pinned:true,pumpFundedTest:service});
  const result=await h.request('/api/admin/pump-test/funded/submit',{auth:h.owner,body:{operationId:'test',signedTransaction:'ignored'}});
  assert.equal(result.code,403);assert.equal(broadcasts,0);assert.doesNotMatch(result.text,/must-not-leak/);
});

test('private deployment files are never assets and internal funded errors do not expose configuration',async t=>{
  const service={prepare:async()=>{throw Error('ENOENT /srv/secret/pump-test-config.json https://rpc.invalid/private-token');}};
  const h=await fixture(t,{pinned:true,pumpFundedTest:service});
  for(const path of ['/private/pump-owner-test/curve_pump_test_OWNER_REQUIRES_REVIEW.so','/private/pump-owner-test/owner-build-unbound.json','/pump-test-config.json']){
    const result=await h.request(path,{auth:h.owner});assert.notEqual(result.code,200);assert.doesNotMatch(result.text,/\x7fELF|binarySha256|rpcUrl/);
  }
  const result=await h.request('/api/admin/pump-test/funded/prepare',{auth:h.owner,body:{action:'initialize'}});
  assert.equal(result.code,409);assert.doesNotMatch(result.text,/\/srv\/secret|rpc.invalid|private-token|pump-test-config/);
});
