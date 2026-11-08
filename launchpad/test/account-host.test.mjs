import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Keypair } from '@solana/web3.js';
import { request as httpRequest } from 'node:http';
import { AccountService } from '../src/accounts.mjs';
import { AccountRuntimeManager } from '../src/account-runtime.mjs';
import { AccountFeePolicy } from '../src/account-policy.mjs';
import { createAccountApp } from '../src/account-app.mjs';
import { defaults } from '../src/telegram-settings.mjs';
import { TelegramBot } from '../src/telegram-bot.mjs';
import { TelegramStore } from '../src/telegram-store.mjs';
import { randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { MAX_LAUNCH_IMAGE } from '../src/launchpad-media.mjs';
import { totp } from '../src/totp.mjs';
import { config, key1, key2 } from './fixtures.mjs';

const password = 'host-test-password-123';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const empty = (kind, mode) => ({ state: 'stopped', kind, mode, positions: [], pending: [], events: [], metrics: {} });
class MockEngine extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.closed = false; this.calls = []; this.value = { ...empty('copy', 'paper'), views: { copy: empty('copy', 'paper'), portfolioLive: empty('liquidity', 'live'), portfolioPaper: empty('liquidity', 'paper') } }; }
  status() { return { ...this.value, state: this.state }; }
  async start(raw, kind = 'copy') {
    this.calls.push({ method: 'start', raw, kind }); this.state = 'running';
    this.value.kind = kind; this.value.mode = raw.mode;
    const view = kind === 'copy' ? 'copy' : raw.mode === 'live' ? 'portfolioLive' : 'portfolioPaper';
    this.value.views[view] = { ...empty(kind, raw.mode), state: 'running' }; this.emit('change'); return this.status();
  }
  async withdraw(wallet, raw) { this.calls.push({ method: 'withdraw', wallet, raw }); return this.status(); }
  async manualTrade(raw, trade) {
    this.calls.push({ method: 'manualTrade', raw, trade }); this.value.mode = raw.mode; this.value.kind = 'copy';
    this.value.manualResult = { id: trade.id, state: 'complete', wallets: trade.wallets.map(wallet => ({ wallet, state: 'confirmed' })) };
    this.value.views.copy = { ...empty('copy', raw.mode), state: this.state, manualResult: this.value.manualResult };
    this.emit('change'); return this.status();
  }
  async release(id, mode) { this.calls.push({ method: 'release', id, mode }); return this.status(); }
  stop() { this.calls.push({ method: 'stop' }); this.state = 'stopped'; for (const view of Object.values(this.value.views)) view.state = 'stopped'; this.emit('change'); }
  async close() { this.closed = true; this.state = 'stopped'; }
}

async function harness(t, { maxUsers = 100, maxActive = 5, beforeLiveStart, launchpad, funding, marketData, explore, trading, adminPanel, protocolFees, protocolTreasury, branding, adminRevenue } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-host-test-'));
  const accounts = await new AccountService(dir).init(), policy = new AccountFeePolicy(accounts, { verifyRecipient: async () => {} }), workers = [];
  const manager = new AccountRuntimeManager(accounts, policy, { maxActive, beforeLiveStart, engineFactory: (store, context, options) => { const engine = new MockEngine(); workers.push({ store, context, options, engine }); return engine; } });
  const server = createAccountApp({ accounts, runtimes: manager, policy, maxUsers, launchpad, funding, marketData, explore, trading, adminPanel, protocolFees, protocolTreasury, branding, adminRevenue, features: { toolkit: true, telegram: true, walletOnly: false } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await manager.close(); await rm(dir, { recursive: true, force: true }); });
  async function request(path, { auth, body, method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest(base + path, { method, headers: { ...(auth ? { cookie: `launchpad-session=${auth.token}`, 'x-control-token': auth.csrfToken } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
        response.on('end', () => { try { resolve({ code: response.statusCode, headers: new Headers(response.headers), body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (error) { reject(error); } });
      });
      req.on('error', reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end();
    });
  }
  async function user(username) { const account = await accounts.register(username, password); return { account, ...await accounts.createSession(account.id) }; }
  return { dir, accounts, policy, manager, workers, server, base, request, user };
}

async function concurrentSetup(h, account) {
  const keys = [key1, key2, Keypair.generate()];
  await h.policy.setRecipient(Keypair.generate().publicKey.toBase58());
  const raw = { ...structuredClone(defaults), ...config({ mode: 'live', wallets: keys }), leads: config().leads.join('\n'),
    agreedFeeVersion: (await h.policy.get(account.id)).version,
    runWallets: Object.fromEntries(['copy', 'liquidity', 'market'].map((kind, i) => [kind, [keys[i].publicKey.toBase58()]])) };
  raw.strategies.market.baseMint = raw.strategies.liquidity.baseMint = Keypair.generate().publicKey.toBase58();
  raw.strategies.liquidity.walletBudgets = { 1: '2' }; raw.strategies.market.walletBudgets = { 2: '3' };
  return raw;
}

test('password login cannot mint a new session when a password reset wins the issuance race', { timeout: 15000 }, async t => {
  const h = await harness(t), user = await h.user('login_reset_race');
  const entered = deferred(), release = deferred(), issue = h.accounts.createAuthenticatedSession.bind(h.accounts);
  let first = true;
  h.accounts.createAuthenticatedSession = async result => {
    if (first) { first = false; entered.resolve(); await release.promise; }
    return issue(result);
  };
  const request = h.request('/api/account/login', { body: { username: user.account.username, password } });
  await entered.promise;
  await h.accounts.changePassword(user.account.id, password, 'updated-login-race-password');
  release.resolve();
  const rejected = await request;
  assert.equal(rejected.code, 400); assert.match(rejected.body.error, /security changed/);
  assert.equal(rejected.headers.get('set-cookie'), null);
  assert.equal((await h.request('/api/session', { auth: user })).body.authenticated, false);
  const fresh = await h.request('/api/account/login', { body: { username: user.account.username, password: 'updated-login-race-password' } });
  assert.equal(fresh.code, 200); assert.equal(fresh.body.account.id, user.account.id);
});

test('profile avatar API bounds decoded images and request bodies even when browser optimization is bypassed',async t=>{
  const h=await harness(t),auth=await h.user('avatar_limit');
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=','base64');
  const sizedPng=size=>{
    const text=Buffer.alloc(size-png.length-12,97);text[7]=0;
    const chunk=Buffer.alloc(text.length+12);chunk.writeUInt32BE(text.length);chunk.write('tEXt',4);text.copy(chunk,8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4,-4)),chunk.length-4);
    return Buffer.concat([png.subarray(0,-12),chunk,png.subarray(-12)]);
  };
  const accepted=await h.request('/api/account/avatar',{auth,body:{data:sizedPng(MAX_LAUNCH_IMAGE).toString('base64')}});
  assert.equal(accepted.code,200);assert.match(accepted.body.imageId,/^[a-f0-9]{64}\.png$/);
  const stored=await h.accounts.storeFor(auth.account.id).read('launch-images',{ids:[]});
  assert.deepEqual(stored.ids,[accepted.body.imageId]);
  const rejected=await h.request('/api/account/avatar',{auth,body:{data:sizedPng(MAX_LAUNCH_IMAGE+1).toString('base64')}});
  assert.equal(rejected.code,413);assert.match(rejected.body.error,/too large/);
  const oversizedBody=await h.request('/api/account/avatar',{auth,body:{data:png.toString('base64'),padding:'x'.repeat(MAX_LAUNCH_IMAGE*2)}});
  assert.equal(oversizedBody.code,413);assert.match(oversizedBody.body.error,/too large/);
  const launchBypass=await h.request('/api/launchpad/image',{auth,body:{data:sizedPng(MAX_LAUNCH_IMAGE+1).toString('base64')}});
  assert.equal(launchBypass.code,400);
  assert.deepEqual((await h.accounts.storeFor(auth.account.id).read('launch-images',{ids:[]})).ids,[accepted.body.imageId]);
  const helper=await fetch(h.base+'/profile-image.mjs');assert.equal(helper.status,200);assert.match(helper.headers.get('content-type'),/javascript/);
});

test('creator claim-all is account scoped; takeover administration requires admin MFA and fresh identity proof',async t=>{
  const claims=[],books=[];
  const launchpad={claimAll:async id=>{claims.push(id);return{queued:[],active:[],skipped:[],launches:[]};},book:async id=>{books.push(id);return{launches:[]};}};
  const h=await harness(t,{launchpad}),a=await h.user('claimowner'),other=await h.user('claimother');
  const path='/api/launchpad/fees/claim-all';
  assert.equal((await h.request(path,{body:{}})).code,401);
  assert.equal((await h.request(path,{auth:a,body:{},headers:{'x-control-token':'bad'}})).code,403);
  assert.equal((await h.request(path,{auth:a,body:{accountId:other.account.id}})).code,200);
  assert.deepEqual(claims,[a.account.id]);
  assert.equal((await h.request('/api/admin/launches',{auth:a})).code,403);
  assert.equal((await h.request('/api/admin/launches/recipient',{auth:a,body:{accountId:other.account.id,password}})).code,403);
  await h.accounts.setAdmin(a.account.id);
  assert.equal((await h.request('/api/admin/launches',{auth:a})).code,403);
  const setup=await h.accounts.beginMfa(a.account.id,password);
  await h.accounts.enableMfa(a.account.id,password,totp(setup.secret,Date.now()));
  const auth=await h.accounts.createSession(a.account.id,{mfaVerified:true});
  assert.equal((await h.request('/api/admin/launches',{auth})).code,200);
  assert(books.includes(other.account.id));
  assert.equal((await h.request('/api/admin/launches/recipient',{auth,body:{accountId:other.account.id,password:'wrong',code:'000000'}})).code,400);
  for(const url of ['/launch-admin-ui.mjs','/creator-claims.mjs']){const response=await fetch(h.base+url);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/javascript/);}
});

test('holder reward settings and manual distribution cannot use the developer action endpoint',async t=>{
  const writes=[],h=await harness(t,{launchpad:{action:async(...args)=>writes.push(args)}}),a=await h.user('fixedrewards');
  for(const action of ['rewards-settings','holder-distribute']){
    const body={id:'c'.repeat(32),action,minimumQuote:'0',forceHolderDistribution:true,admin:true};
    assert.equal((await h.request('/api/launchpad/action',{body})).code,401);
    assert.equal((await h.request('/api/launchpad/action',{auth:a,body})).code,403);
  }
  assert.deepEqual(writes,[]);
});

test('rewards balances are owner-scoped and manual holder distribution is unavailable through owner routes',async t=>{
  const reads=[],writes=[],launchId='d'.repeat(32);let owner;
  const owned=(id,requested)=>{if(id!==owner||requested!==launchId)throw Error('Launch was not found in this account.');};
  const launchpad={rewards:async(id,requested)=>{owned(id,requested);reads.push(id);return{launchId:requested,wallet:{quoteBalance:'12.5'}};},action:async(id,requested,action)=>{owned(id,requested);writes.push({id,action});return{id:requested,feesRequested:true};}};
  const h=await harness(t,{launchpad}),a=await h.user('rewardwalletowner'),other=await h.user('rewardwalletother');owner=a.account.id;
  const path='/api/launchpad/rewards?id='+launchId;
  assert.equal((await h.request(path)).code,401);
  assert.equal((await h.request(path,{auth:other})).code,400);
  const response=await h.request(path+'&accountId='+other.account.id,{auth:a});assert.equal(response.code,200);assert.equal(response.body.wallet.quoteBalance,'12.5');assert.deepEqual(reads,[owner]);assert.equal(writes.length,0);
  const actionPath='/api/launchpad/action',body={id:launchId,action:'holder-distribute',accountId:owner};
  assert.equal((await h.request(actionPath,{auth:other,body})).code,403);
  assert.equal((await h.request(actionPath,{auth:a,body,headers:{'x-control-token':'bad'}})).code,403);
  assert.equal((await h.request(actionPath,{auth:a,body})).code,403);assert.deepEqual(writes,[]);
});

test('native launch chart and swap routes use the authenticated account and expose no signing actions',async t=>{
  let owner;const calls=[],launchId='a'.repeat(32),mint=Keypair.generate().publicKey.toBase58(),curve=Keypair.generate().publicKey.toBase58();
  const owned=(id,requested)=>{assert.equal(requested,launchId);if(id!==owner)throw Error('Launch was not found in this account.');return {id:launchId,mint,curve,input:{network:'mainnet-beta',quoteMint:'So11111111111111111111111111111111111111112'}};};
  const launchpad={market:async(id,requested)=>{const l=owned(id,requested);calls.push(['chart',id]);return {launchId:l.id,mint,curve,points:[{time:1700000000,priceQuote:.001,slot:1}]};},marketTradeContext:async(id,requested)=>({launch:owned(id,requested),snapshot:{mint,curve,stale:false}})};
  const marketData={launchTrades:async(id,l,snapshot)=>{calls.push(['trades',id,l.id]);assert.equal(l.curve,curve);assert.equal(snapshot.mint,mint);return {trades:[],source:'Confirmed swaps'};}};
  const h=await harness(t,{launchpad,marketData}),a=await h.user('curveowner'),b=await h.user('curvestranger');owner=a.account.id;
  for(const endpoint of ['market','trades']){
    const path=`/api/launchpad/${endpoint}?id=${launchId}`;
    assert.equal((await h.request(path)).code,401);
    assert.equal((await h.request(path,{auth:b})).code,400);
    assert.equal((await h.request(path+'&accountId='+b.account.id,{auth:a})).code,200);
  }
  assert.deepEqual(calls,[['chart',owner],['trades',owner,launchId]]);
  const module=await fetch(h.base+'/launch-curve-chart.mjs');assert.equal(module.status,200);assert.match(module.headers.get('content-type'),/javascript/);
});

test('market viewer allows only the DEX Screener frame origin and keeps market APIs authenticated', async t => {
  let requested;
  const h = await harness(t, { marketData: { pools: async (...args) => { requested = args; return { pools: [], source: 'DEX Screener' }; } } });
  const page = await fetch(h.base + '/');
  assert.equal(page.status, 200);
  const policy = page.headers.get('content-security-policy');
  assert.match(policy, /(?:^|;\s*)frame-src https:\/\/dexscreener\.com;/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /connect-src 'self'/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const helper = await fetch(h.base + '/dexscreener-view.mjs');
  assert.equal(helper.status, 200);
  assert.match(helper.headers.get('content-type'), /javascript/);
  const api = await h.request('/api/market/pools?chain=solana&address=So11111111111111111111111111111111111111112');
  assert.equal(api.code, 401);
  assert.equal(requested, undefined);
  const auth = await h.user('dexviewer');
  const selected = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
  const response = await h.request(`/api/market/pools?chain=solana&address=So11111111111111111111111111111111111111112&pair=${selected}`, { auth });
  assert.equal(response.code, 200);
  assert.deepEqual(requested, ['solana', 'So11111111111111111111111111111111111111112', selected]);
});

test('launchpad and funding HTTP routes require account authentication, CSRF, scoped ownership and reauthentication for exports', async t=>{
  const calls=[],funding={overview:async id=>({configured:true,accountId:id}),quote:async id=>{calls.push(['quote',id]);return{id:'quote'};},configure:async()=>{calls.push(['configure']);return{configured:true};}},launchpad={read:async id=>({launches:[],accountId:id}),create:async id=>{calls.push(['launch',id]);return{id:'draft'};},exportWallet:async id=>{calls.push(['export',id]);return{privateKey:'test-key'};}};
  const h=await harness(t,{funding,launchpad}),a=await h.user('new_tools_a'),b=await h.user('new_tools_b');
  for(const path of ['/api/funding','/api/launchpad'])assert.equal((await h.request(path)).code,401);
  assert.equal((await h.request('/api/funding',{auth:a,headers:{'x-control-token':'wrong'}})).code,403);
  assert.equal((await h.request('/api/funding',{auth:a})).body.accountId,a.account.id);
  assert.equal((await h.request('/api/launchpad',{auth:b})).body.accountId,b.account.id);
  assert.equal((await h.request('/api/funding/quote',{auth:a,body:{accountId:b.account.id}})).code,200);
  assert.equal((await h.request('/api/launchpad/create',{auth:a,body:{accountId:b.account.id}})).code,200);
  assert.deepEqual(calls,[['quote',a.account.id],['launch',a.account.id]]);
  assert.notEqual((await h.request('/api/launchpad/export',{auth:a,body:{id:'draft',password:'wrong'}})).code,200);assert(!calls.some(c=>c[0]==='export'));
  assert.equal((await h.request('/api/launchpad/export',{auth:a,body:{id:'draft',password}})).code,200);
  assert.equal((await h.request('/api/funding/configure',{auth:a,body:{apiKey:'test-key',password}})).code,403);assert(!calls.some(c=>c[0]==='configure'));
  for(const path of ['/launchpad','/funding?chain=robinhood','/launchpad.js','/launch-image.mjs','/funding.js','/launchpad.css']){const res=await fetch(h.base+path);assert.equal(res.status,200);assert((await res.text()).length>100);}
});

test('batch generation saves 24 recoverable wallets without exposing keys, replacing Main, or starting trades', async t => {
  const h = await harness(t), a = await h.user('wallet_generation'), other = await h.user('other_wallets');
  const before = await h.manager.readSettings(a.account.id);
  assert.equal((await h.request('/api/account/wallets/generate', { body: { settings: before.settings, revision: before.revision, count: 24 } })).code, 401);
  const created = await h.request('/api/account/wallets/generate', { auth: a, body: { settings: before.settings, revision: before.revision, count: 24, accountId: other.account.id } });
  assert.equal(created.code, 200, created.body.error); assert.equal(created.body.generated.length, 24);
  assert.equal(new Set(created.body.generated.map(w => w.publicKey)).size, 24);
  assert(created.body.settings.wallets.every(w => w.privateKey.startsWith('relay-saved-v1:')));
  const stored = await h.manager.readSettings(a.account.id);
  assert.equal(stored.settings.wallets.length, 27); assert.equal(h.workers.length, 0);
  for (const wallet of stored.settings.wallets) assert(!JSON.stringify(created.body).includes(wallet.privateKey));
  assert.equal((await h.accounts.get(a.account.id)).mainWallet, a.account.mainWallet);
  assert(!stored.settings.wallets.some(w => w.publicKey === a.account.mainWallet));
  assert.equal((await h.manager.readSettings(other.account.id)).settings.wallets.length, 3);
  const checked = await h.request('/api/wallets', { auth: a, body: { mode: 'live', wallets: created.body.settings.wallets } });
  assert.equal(checked.code, 200); assert.equal(checked.body.wallets.length, 27);
  const denied = await h.request('/api/account/settings-export', { auth: a, body: {} }); assert.equal(denied.code, 400);
  const exported = await h.request('/api/account/settings-export', { auth: a, body: { password } });
  assert.equal(exported.code, 200); assert.deepEqual(exported.body.settings.wallets, stored.settings.wallets);
  const overflow = await h.request('/api/account/wallets/generate', { auth: a, body: { settings: created.body.settings, revision: created.body.revision, count: 1 } });
  assert.equal(overflow.code, 400); assert.match(overflow.body.error, /25 Copy \/ Sniping wallets total/);
  assert.equal((await h.manager.readSettings(a.account.id)).revision, stored.revision);
});

test('simultaneous batches and stale retries cannot overwrite settings or generate duplicate saved batches', async t => {
  const h = await harness(t), a = await h.user('wallet_generation_race');
  const initial = await h.manager.readSettings(a.account.id);
  const settings = { ...initial.settings, wallets: config({ mode: 'live' }).wallets, buyAmount: '0.123' };
  const body = { settings, revision: initial.revision, count: 19 };
  const results = await Promise.all([h.request('/api/account/wallets/generate', { auth: a, body }), h.request('/api/account/wallets/generate', { auth: a, body })]);
  assert.deepEqual(results.map(r => r.code).sort(), [200, 409]);
  const saved = await h.manager.readSettings(a.account.id);
  assert.equal(saved.settings.wallets.length, 20); assert.equal(saved.settings.buyAmount, '0.123');
  assert.equal(saved.settings.wallets[0].privateKey, settings.wallets[0].privateKey);
  assert.equal((await h.request('/api/account/wallets/generate', { auth: a, body })).code, 409);
  assert.equal((await h.manager.readSettings(a.account.id)).revision, saved.revision);
});

test('saved secret references work for wallet checks, three run modes and manual exits without returning keys', async t => {
  const h = await harness(t), a = await h.user('sealed_settings');
  const raw = await concurrentSetup(h, a.account);
  const initial = await h.manager.readSettings(a.account.id);
  await h.manager.saveSettings(a.account.id, raw, initial.revision);
  const response = await h.request('/api/account/settings', { auth: a }), sealed = response.body.settings;
  sealed.agreedFeeVersion = raw.agreedFeeVersion;
  assert.ok(sealed.wallets.every(w => w.privateKey.startsWith('relay-saved-v1:')));
  for (const w of raw.wallets) assert.ok(!JSON.stringify(response.body).includes(w.privateKey));
  const checked = await h.request('/api/wallets', { auth: a, body: { mode: 'live', wallets: sealed.wallets } });
  assert.equal(checked.code, 200); assert.deepEqual(checked.body.wallets.map(w => w.publicKey), raw.wallets.map(w => w.publicKey));
  const saved = await h.request('/api/account/settings', { auth: a, body: { settings: sealed, revision: response.body.revision } });
  assert.equal(saved.code, 200); assert.ok(!JSON.stringify(saved.body).includes(raw.wallets[0].privateKey));
  for (const kind of ['copy', 'liquidity', 'market']) {
    const result = await h.request(kind === 'copy' ? '/api/start' : '/api/portfolio/start', { auth: a, body: kind === 'copy' ? sealed : { kind, config: sealed } });
    assert.equal(result.code, 200, result.body.error);
    const call = h.workers.at(-1).engine.calls[0]; assert.ok(call.raw.wallets[0].privateKey && !call.raw.wallets[0].privateKey.startsWith('relay-saved-v1:'));
  }
  await h.request('/api/stop', { auth: a, body: {} });
  const manual = await h.request('/api/manual-trade', { auth: a, body: { config: sealed, trade: { id: 'sealed-manual-sell', side: 'sell', mint: key2.publicKey.toBase58(), sellPercent: '100', wallets: [raw.wallets[0].publicKey] } } });
  assert.equal(manual.code, 200, manual.body.error);
  const denied = await h.request('/api/account/settings-export', { auth: a, body: { settings: sealed } }); assert.equal(denied.code, 400);
  const backup = await h.request('/api/account/settings-export', { auth: a, body: { settings: sealed, password } });
  assert.equal(backup.code, 200); assert.equal(backup.body.settings.wallets[0].privateKey, raw.wallets[0].privateKey);
  assert.equal((await h.manager.readSettings(a.account.id)).settings.wallets[0].privateKey, raw.wallets[0].privateKey);
  const b = await h.user('sealed_other');
  const forged = await h.request('/api/wallets', { auth: b, body: { mode: 'live', wallets: sealed.wallets, accountId: a.account.id } });
  assert.equal(forged.code, 400); assert.equal(forged.body.wallets, undefined);
});

test('MFA HTTP enrollment rotates the session; login, export, linking and password changes require the factor', async t => {
  const h = await harness(t), a = await h.user('http_mfa'); let now = Date.now(); h.accounts.now = () => now;
  const enrollment = await h.request('/api/account/mfa/setup', { auth: a, body: { password } }); assert.equal(enrollment.code, 200);
  const enabled = await h.request('/api/account/mfa/enable', { auth: a, body: { password, code: totp(enrollment.body.secret, now) } });
  assert.equal(enabled.code, 200); assert.equal(await h.accounts.getSession(a.token), null);
  const auth = { token: enabled.headers.get('set-cookie').match(/^launchpad-session=([^;]+)/)[1], csrfToken: enabled.body.token };
  assert.equal((await h.request('/api/account/export', { auth, body: { password } })).body.mfaRequired, true);
  assert.equal((await h.request('/api/account/telegram-link', { auth, body: { password } })).body.mfaRequired, true);
  assert.equal((await h.request('/api/account/login', { body: { username: a.account.username, password } })).body.mfaRequired, true);
  now += 30000;
  const linked = await h.request('/api/account/telegram-link', { auth, body: { password, code: totp(enrollment.body.secret, now) } }); assert.equal(linked.code, 200);
  await h.accounts.redeemLinkCode(linked.body.code, 9134);
  const exported = await h.request('/api/account/export', { auth, body: { password, code: enabled.body.recoveryCodes[0] } });
  assert.equal(exported.code, 200); assert.equal(exported.body.publicKey, a.account.mainWallet);
  const revoke = await h.request('/api/account/logout-all', { auth, body: { password, code: enabled.body.recoveryCodes[1] } });
  assert.equal(revoke.code, 200); assert.equal(await h.accounts.getSession(auth.token), null); assert.equal(await h.accounts.getTelegramAccount(9134), null);
});

test('public HTTP app only trusts HTTPS forwarded by the local proxy and marks cookies Secure', async t => {
  const h = await harness(t), a = await h.user('https_only');
  const server = createAccountApp({ accounts: h.accounts, runtimes: h.manager, policy: h.policy, publicUrl: 'https://app.example.com', features: { toolkit: true, telegram: true, walletOnly: false } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const call = async headers => new Promise((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${server.address().port}/api/account/login`, { method: 'POST', headers: { host: 'app.example.com', 'content-type': 'application/json', ...headers } }, res => { res.resume(); res.on('end', () => resolve(res)); });
    req.on('error', reject); req.end(JSON.stringify({ username: a.account.username, password }));
  });
  assert.equal((await call({})).statusCode, 403);
  assert.equal((await call({ 'x-forwarded-proto': 'http' })).statusCode, 403);
  const result = await call({ 'x-forwarded-proto': 'https', 'x-forwarded-for': '198.51.100.20' });
  assert.equal(result.statusCode, 200); assert.match(result.headers['set-cookie'][0], /; Secure/); assert.ok(result.headers['strict-transport-security']);
});

test('three live modes run with disjoint wallets, independent IDs, budgets, fees, HTTP stops and Stop All', async t => {
  const h = await harness(t), { account, ...auth } = await h.user('all_three');
  const raw = await concurrentSetup(h, account), runtime = h.manager.get(account.id);
  await Promise.all(['copy', 'liquidity', 'market'].map(kind => runtime.start(raw, kind)));
  assert.equal(h.workers.length, 3); assert.equal(h.manager.activeCount(), 3);
  assert.deepEqual(Object.values(runtime.status().runs).map(r => r.state), ['running', 'running', 'running', 'stopped']);
  assert.equal(new Set(Object.values(runtime.status().runs).map(r => r.runId)).size, 4);
  for (const w of h.workers) {
    const kind = w.options.journalKind, call = w.engine.calls[0];
    assert.equal(call.kind, kind); assert.deepEqual(call.raw.wallets.map(w => w.publicKey), raw.runWallets[kind]);
    assert.equal(w.context.accountId, account.id); assert.equal(w.context.version, raw.agreedFeeVersion);
    if (kind !== 'copy') assert.deepEqual(call.raw.strategies[kind].walletBudgets, { 0: kind === 'market' ? '3' : '2' });
  }
  const copyId = runtime.status('copy').runId;
  const market = await h.request('/api/portfolio/status?kind=market', { auth });
  assert.equal(market.body.kind, 'market'); assert.equal(market.body.runs.copy.state, 'running');
  await h.request('/api/portfolio/stop', { auth, body: { kind: 'liquidity' } });
  assert.equal(runtime.status('liquidity').state, 'stopped'); assert.equal(runtime.status('market').state, 'running');
  assert.equal(runtime.status('copy').runId, copyId);
  await h.request('/api/stop', { auth, body: {} }); assert.equal(runtime.status('market').state, 'running');
  await h.request('/api/runtime/stop', { auth, body: {} }); assert.equal(runtime.state, 'stopped'); assert.equal(h.manager.activeCount(), 0);
});

test('simultaneous live starts cannot both reserve the same wallet; paper reuse is isolated', async t => {
  const h = await harness(t), { account } = await h.user('wallet_race'), raw = await concurrentSetup(h, account), runtime = h.manager.get(account.id);
  raw.runWallets.liquidity = raw.runWallets.copy;
  const result = await Promise.allSettled(['copy', 'liquidity'].map(kind => runtime.start(raw, kind)));
  assert.ok(result.some(r => r.status === 'rejected' && /in use by/.test(r.reason.message)));
  assert.ok(h.workers.length <= 1); runtime.stop();
  raw.mode = 'paper'; await Promise.all(['copy', 'liquidity'].map(kind => runtime.start(raw, kind)));
  assert.equal(h.manager.activeCount(), 2);
});

test('other-mode persisted holdings and pending trades block live starts and manual trades after restart', async t => {
  const h = await harness(t), { account } = await h.user('retained_locks'), raw = await concurrentSetup(h, account), runtime = h.manager.get(account.id);
  await h.manager.prepare(account.id); const store = h.accounts.storeFor(account.id), wallet = raw.runWallets.copy[0];
  await store.write('market-live', { lots: [{ wallet, kind: 'market', tokens: {}, id: 'allocation' }], pending: [], events: [] });
  await assert.rejects(runtime.start(raw), /allocation/);
  await assert.rejects(runtime.manualTrade(raw, { id: 'locked-manual', wallets: [wallet] }), /allocation/);
  await store.write('market-live', { lots: [], pending: [{ wallet, signature: 'unresolved' }], events: [] });
  await assert.rejects(runtime.start(raw), /pending transaction/);
  assert.equal(h.workers.length, 0);
});

test('Stop cancels only its startup and Stop All cancels all reserved startups; capacity counts modes', async t => {
  const h = await harness(t, { maxActive: 2 }), { account } = await h.user('start_cancel'), raw = await concurrentSetup(h, account), runtime = h.manager.get(account.id);
  const entered = deferred(), blocked = deferred(), original = h.policy.get.bind(h.policy); let calls = 0;
  h.policy.get = async id => { if (++calls === 2) entered.resolve(); await blocked.promise; return original(id); };
  const starts = ['copy','liquidity'].map(kind => runtime.start(raw, kind)); const outcomes = Promise.allSettled(starts);
  await entered.promise; assert.equal(h.manager.activeCount(), 2);
  await assert.rejects(runtime.start(raw, 'market'), /slots are busy/);
  runtime.stop('copy'); blocked.resolve();
  const results = await outcomes; assert.equal(results[0].status, 'rejected'); assert.equal(results[1].status, 'fulfilled');
  assert.equal(runtime.status('liquidity').state, 'running'); runtime.stop();
  const prepare = h.manager.prepare.bind(h.manager), release = deferred(); h.manager.prepare = async id => { await release.promise; return prepare(id); };
  const next = Promise.allSettled(['copy','market'].map(kind => runtime.start(raw, kind)));
  runtime.stop(); release.resolve(); assert.ok((await next).every(r => r.status === 'rejected'));
});

test('failure in one mode leaves the others running and settings cannot remove active wallets', async t => {
  const h = await harness(t), { account } = await h.user('failure_isolated'), raw = await concurrentSetup(h, account), runtime = h.manager.get(account.id);
  await runtime.start(raw, 'copy'); const copy = h.workers[0].engine;
  const original = h.manager.engineFactory; h.manager.engineFactory = (...args) => { const e = original(...args); e.start = async () => { throw Error('Test LP failure'); }; return e; };
  await assert.rejects(runtime.start(raw, 'liquidity'), /LP failure/); assert.equal(copy.state, 'running');
  const current = await h.manager.readSettings(account.id);
  await assert.rejects(h.manager.saveSettings(account.id, { ...raw, wallets: raw.wallets.slice(1) }, current.revision), /Keep wallets used by active/);
  await h.manager.saveSettings(account.id, { ...raw, buyAmount: '0.2' }, current.revision);
  assert.equal(copy.calls[0].raw.buyAmount, '0.05');
});

test('Telegram menus launch all three, preserve per-mode selections and stop only the chosen run', async t => {
  const h = await harness(t), { account } = await h.user('telegram_three'), raw = await concurrentSetup(h, account);
  const initial = await h.manager.readSettings(account.id); await h.manager.saveSettings(account.id, raw, initial.revision);
  const root = join(h.dir, 'telegram'), master = randomBytes(32), sent = [], id = 99120;
  const { code } = await h.accounts.createLinkCode(account.id); await h.accounts.redeemLinkCode(code, String(id));
  const bot = await new TelegramBot({ root, master, hostStore: new TelegramStore(root, master), accounts: h.accounts, runtimeManager: h.manager,
    feePolicy: id => h.policy.get(id), api: { async call() { return true; } }, outbox: { send(id, text, keyboard) { sent.push({ text, keyboard }); } } }).init();
  t.after(() => bot.close()); let sequence = 0;
  const msg = text => bot.dispatch({ message: { message_id: ++sequence, date: Date.now() / 1000, chat: { id, type: 'private' }, from: { id }, text } });
  const button = label => { const b = sent.at(-1)?.keyboard?.flat().find(b => b.text === label); assert.ok(b, `${label}: ${sent.at(-1)?.text}`); return b.callback_data; };
  const cb = data => bot.dispatch({ callback_query: { id: `cb${++sequence}`, data, from: { id }, message: { message_id: sequence, chat: { type: 'private', id } } } });
  const click = label => cb(button(label));
  const ctx = await bot.context(String(id));
  for (const label of ['Multiwallet / Copy trading', 'LP Management', 'Market Making']) {
    await msg('/start'); await click(label);
    await click('Wallets'); await click('Choose wallets for this mode'); assert.match(sent.at(-1).text, /1 selected/);
    await bot.home(ctx); await click('▶ Start live'); await click('▶ Start LIVE'); await ctx.startTask;
  }
  const runtime = h.manager.get(account.id); assert.equal(h.manager.activeCount(), 3); assert.equal(runtime, ctx.engine);
  await msg('/start'); assert.match(sent.at(-1).text, /LP Management: running/); assert.match(sent.at(-1).text, /Market Making: running/);
  await click('LP Management'); const oldStop = button('⏹ Stop');
  await msg('/start'); await click('Market Making'); await cb(oldStop);
  assert.equal(runtime.status('liquidity').state, 'stopped'); assert.equal(runtime.status('market').state, 'running'); assert.equal(runtime.status('copy').state, 'running');
  await msg('/stopall'); assert.equal(runtime.state, 'stopped');
  await msg('/start'); await click('LP Management'); await click('Wallets'); await click('Choose wallets for this mode'); await click('Clear');
  assert.deepEqual((await h.manager.readSettings(account.id)).settings.runWallets.liquidity, []);
  await click('Select all'); assert.equal((await h.manager.readSettings(account.id)).settings.runWallets.liquidity, null);
});

test('anonymous clients cannot read account settings, positions, exports or administrator data', async t => {
  const h = await harness(t), a = await h.user('private_owner');
  const setup = { ...structuredClone(defaults), ...config({ mode: 'live' }), leads: '' };
  await h.accounts.storeFor(a.account.id).write('settings', setup);
  for (const path of ['/api/account', '/api/account/settings', '/api/status', '/api/portfolio/status', '/api/runtime/status', '/api/admin/accounts']) {
    const response = await h.request(path); assert.equal(response.code, 401); assert.ok(!JSON.stringify(response.body).includes(setup.wallets[0].privateKey));
  }
  const exported = await h.request('/api/account/export', { body: { password, accountId: a.account.id } });
  assert.equal(exported.code, 401);
  const session = await h.request('/api/session'); assert.equal(session.body.authenticated, false); assert.equal(session.body.account, undefined);
});

test('session identity scopes settings, status and main-wallet export even with forged account IDs', async t => {
  const h = await harness(t), a = await h.user('alice_host'), b = await h.user('bob_host');
  await h.accounts.storeFor(a.account.id).write('settings', { ...structuredClone(defaults), heliusKey: 'alice-secret-provider' });
  await h.accounts.storeFor(b.account.id).write('settings', { ...structuredClone(defaults), heliusKey: 'bob-secret-provider' });
  const settings = await h.request(`/api/account/settings?accountId=${b.account.id}`, { auth: a });
  assert.equal(settings.code, 200); assert.match(settings.body.settings.heliusKey, /^relay-saved-v1:/); assert.ok(!JSON.stringify(settings.body).includes('secret-provider'));
  const full = await h.request('/api/account/settings-export', { auth: a, body: { password, settings: settings.body.settings, accountId: b.account.id } });
  assert.equal(full.body.settings.heliusKey, 'alice-secret-provider');
  const data = await h.request(`/api/account?accountId=${b.account.id}`, { auth: a }); assert.equal(data.body.account.id, a.account.id);
  const exported = await h.request('/api/account/export', { auth: a, body: { password, accountId: b.account.id, id: b.account.id } });
  assert.equal(exported.code, 200); assert.equal(exported.body.publicKey, a.account.mainWallet); assert.notEqual(exported.body.publicKey, b.account.mainWallet);
  const denied = await h.request('/api/account/export', { auth: a, body: { password: 'incorrect-password', accountId: b.account.id } }); assert.equal(denied.code, 400);
  assert.equal(await h.accounts.getTelegramAccount('3001'), null);
});

test('login cookies, CSRF, origin protection and logout invalidate access without affecting another account', async t => {
  const h = await harness(t), a = await h.user('session_a'), b = await h.user('session_b');
  const login = await h.request('/api/account/login', { body: { username: a.account.username, password, accountId: b.account.id } });
  assert.equal(login.code, 200); assert.equal(login.body.account.id, a.account.id);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const token = login.headers.get('set-cookie').match(/^launchpad-session=([^;]+)/)[1], auth = { token, csrfToken: login.body.token };
  assert.equal((await h.request('/api/account', { auth, headers: { 'x-control-token': '' } })).code, 403);
  assert.equal((await h.request('/api/account', { auth, headers: { origin: 'https://attacker.invalid' } })).code, 403);
  assert.equal((await h.request('/api/account', { auth, headers: { host: 'attacker.invalid' } })).code, 403);
  assert.equal((await h.request('/api/account', { auth, headers: { 'sec-fetch-site': 'cross-site' } })).code, 403);
  const afterReload = await h.request('/api/session', { auth }); assert.equal(afterReload.body.token, auth.csrfToken);
  const logout = await h.request('/api/account/logout', { auth, body: { accountId: b.account.id } }); assert.equal(logout.code, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await h.request('/api/account', { auth })).code, 401);
  assert.equal((await h.request('/api/account', { auth: b })).code, 200);
});

test('only explicitly designated administrators can change cashback or collection wallets', async t => {
  const h = await harness(t), a = await h.user('regular'), admin = await h.user('administrator');
  const recipient = Keypair.generate().publicKey.toBase58();
  for (const [path, body] of [['/api/admin/cashback', { accountId: a.account.id, cashbackBps: 10000, role: 'admin' }], ['/api/admin/fees', { recipient, role: 'admin' }]]) {
    const response = await h.request(path, { auth: a, body }); assert.equal(response.code, 403); assert.match(response.body.error, /Administrator/);
  }
  assert.equal((await h.accounts.get(a.account.id)).cashbackBps, 0); assert.equal((await h.policy.get(a.account.id)).ready, false);
  await h.accounts.setAdmin(admin.account.id);
  assert.equal((await h.request('/api/admin/fees', { auth: admin, body: { recipient } })).code, 403);
  let now = Date.now(); h.accounts.now = () => now;
  const enrollment = await h.accounts.beginMfa(admin.account.id, password);
  await h.accounts.enableMfa(admin.account.id, password, totp(enrollment.secret, now));
  Object.assign(admin, await h.accounts.createSession(admin.account.id, { mfaVerified: true })); now += 30000;
  assert.equal((await h.request('/api/admin/fees', { auth: admin, body: { recipient, password, code: totp(enrollment.secret, now) } })).code, 200);
  now += 30000;
  assert.equal((await h.request('/api/admin/cashback', { auth: admin, body: { accountId: a.account.id, cashbackBps: 2500, password, code: totp(enrollment.secret, now) } })).code, 200);
  assert.equal((await h.accounts.get(a.account.id)).cashbackBps, 2500);
  await h.accounts.setAdmin(admin.account.id, false);
  assert.equal((await h.request('/api/admin/accounts', { auth: admin })).code, 403);
});

test('legacy setups load as Live without starting and public execution rejects Paper and missing modes', async t => {
  const h = await harness(t), a = await h.user('live_upgrade'), store = h.accounts.storeFor(a.account.id);
  const legacy = { ...structuredClone(defaults), ...config({ mode: 'paper' }), leads: config().leads.join('\n') };
  const history = { lots: [], pending: [], events: [{ level: 'paper', message: 'Old simulated trade' }] };
  await store.write('settings', legacy); await store.write('paper', history);
  const loaded = await h.request('/api/account/settings', { auth: a });
  assert.equal(loaded.body.settings.mode, 'live'); assert.deepEqual(loaded.body.settings.wallets[0], { ...legacy.wallets[0], tool: 'copy' }); assert.equal(loaded.body.settings.wallets.length, 4);
  const saved = await h.request('/api/account/settings', { auth: a, body: { settings: legacy, revision: loaded.body.revision } });
  assert.equal(saved.code, 200); assert.equal(saved.body.settings.mode, 'live');
  assert.equal((await store.read('settings')).mode, 'live'); assert.deepEqual(await store.read('paper'), history);
  for (const mode of ['paper', undefined]) {
    const raw = { ...legacy, mode };
    for (const [path, body] of [
      ['/api/start', raw], ['/api/manual-trade', { config: raw }], ['/api/wallets', raw],
      ...['market', 'liquidity'].map(kind => ['/api/portfolio/start', { config: raw, kind }]),
      ['/api/portfolio/withdraw', { config: raw, wallet: key1.publicKey.toBase58() }],
    ]) {
      const response = await h.request(path, { auth: a, body });
      assert.equal(response.code, 400, path); assert.match(response.body.error, /Paper trading has been removed/, path);
    }
  }
  const addressOnly = await h.request('/api/wallets', { auth: a, body: { mode: 'live', wallets: [{ publicKey: key1.publicKey.toBase58() }] } });
  assert.equal(addressOnly.code, 400); assert.match(addressOnly.body.error, /private key/);
  assert.equal(h.workers.length, 0); assert.equal(h.manager.activeCount(), 0);
  assert.ok(Object.values(h.manager.get(a.account.id).status().runs).every(r => r.state === 'stopped' && r.mode === 'live'));
});

test('public Paper requests are refused; Live starts require current consent and cannot override trusted fee context', async t => {
  const h = await harness(t), a = await h.user('fee_user');
  let response = await h.request('/api/start', { auth: a, body: config() }); assert.equal(response.code, 400); assert.match(response.body.error, /Paper trading has been removed/); assert.equal(h.workers.length, 0);
  await h.request('/api/stop', { auth: a, body: {} });
  response = await h.request('/api/start', { auth: a, body: config({ mode: 'live' }) }); assert.equal(response.code, 400); assert.match(response.body.error, /configure/);
  await h.policy.setRecipient(Keypair.generate().publicKey.toBase58());
  const policy = await h.policy.get(a.account.id);
  response = await h.request('/api/start', { auth: a, body: config({ mode: 'live', agreedFeeVersion: 'outdated' }) }); assert.equal(response.code, 400); assert.match(response.body.error, /accepted/);
  response = await h.request('/api/start', { auth: a, body: config({ mode: 'live', agreedFeeVersion: policy.version, accountId: 'another-account', platformContext: { copyPpm: 0, recipient: a.account.mainWallet }, platformFees: { copyPpm: 0 } }) });
  assert.equal(response.code, 200); assert.equal(h.workers.length, 1);
  const worker = h.workers.at(-1);
  assert.equal(worker.context.recipient, policy.recipient); assert.equal(worker.context.copyPpm, 2500); assert.equal(worker.context.accountId, a.account.id);
  assert.equal(worker.engine.calls[0].raw.platformContext, undefined); assert.equal(worker.engine.calls[0].raw.platformFees, undefined);
  await h.request('/api/stop', { auth: a, body: {} });
  await h.accounts.setCashback(a.account.id, 5000);
  response = await h.request('/api/start', { auth: a, body: config({ mode: 'live', agreedFeeVersion: policy.version }) }); assert.equal(response.code, 400);
});

test('one worker per mode prevents duplicate web/Telegram starts and respects host capacity', async t => {
  const h = await harness(t, { maxActive: 1 }), a = await h.user('shared_a'), b = await h.user('shared_b');
  const telegramView = h.manager.get(a.account.id);
  await h.policy.setRecipient(Keypair.generate().publicKey.toBase58());
  const live = config({ mode: 'live', agreedFeeVersion: (await h.policy.get(a.account.id)).version });
  const first = await h.request('/api/start', { auth: a, body: live }); assert.equal(first.code, 200);
  assert.strictEqual(telegramView, h.manager.get(a.account.id)); assert.equal(telegramView.state, 'running');
  await assert.rejects(telegramView.start(config()), /Stop the current run/);
  const other = await h.request('/api/start', { auth: b, body: live }); assert.equal(other.code, 400); assert.match(other.body.error, /slots are busy/);
  telegramView.stop(); assert.equal((await h.request('/api/runtime/status', { auth: a })).body.state, 'stopped');
  assert.equal(h.workers.length, 1);
});

test('Stop during asynchronous policy loading cancels a start before worker creation', async t => {
  const h = await harness(t), a = await h.user('cancel_policy'), pending = deferred(), entered = deferred();
  const original = h.policy.get.bind(h.policy);
  h.policy.get = async id => { entered.resolve(); await pending.promise; return original(id); };
  const runtime = h.manager.get(a.account.id), start = runtime.start(config());
  await entered.promise; assert.equal(runtime.state, 'starting'); runtime.stop(); pending.resolve();
  await assert.rejects(start, /Run stopped/); assert.equal(runtime.state, 'stopped'); assert.equal(h.workers.length, 0);
});

test('shared settings use compare-and-swap and preserve immutable runs and occupied wallets', async t => {
  const h = await harness(t), a = await h.user('settings_cas');
  const original = await h.manager.readSettings(a.account.id), one = { ...original.settings, buyAmount: '0.11' }, two = { ...original.settings, buyAmount: '0.22' };
  const concurrent = await Promise.all([h.request('/api/account/settings', { auth: a, body: { settings: one, revision: original.revision } }), h.request('/api/account/settings', { auth: a, body: { settings: two, revision: original.revision } })]);
  assert.deepEqual(concurrent.map(r => r.code).sort(), [200, 409]);
  const latest = await h.manager.readSettings(a.account.id); assert.ok(['0.11', '0.22'].includes(latest.settings.buyAmount));
  const imported = { ...latest.settings, ...config({ mode: 'live' }), leads: '', role: 'admin', cashbackBps: 10000, platformContext: { copyPpm: 0 } };
  const saved = await h.manager.saveSettings(a.account.id, imported, latest.revision);
  assert.equal(saved.settings.role, undefined); assert.equal(saved.settings.platformContext, undefined); assert.equal((await h.accounts.get(a.account.id)).role, 'user');
  await h.accounts.storeFor(a.account.id).write('live', { lots: [{ wallet: key1.publicKey.toBase58(), remaining: '100', decimals: 6 }], pending: [], events: [] });
  await assert.rejects(h.manager.saveSettings(a.account.id, { ...saved.settings, wallets: [] }, saved.revision), /Keep wallets/);
  await h.manager.get(a.account.id).start(config());
  const active = await h.request('/api/account/settings', { auth: a, body: { settings: saved.settings, revision: saved.revision } }); assert.equal(active.code, 200); assert.equal(h.workers.at(-1).engine.calls[0].raw.buyAmount, '0.05');
});

test('a pending settings write blocks Start, and Stop cannot make it launch afterward', async t => {
  const h = await harness(t), a = await h.user('save_race'), initial = await h.manager.readSettings(a.account.id);
  const store = h.accounts.storeFor(a.account.id), original = store.write.bind(store), entered = deferred(), unblock = deferred();
  store.write = async (name, value) => { if (name === 'settings') { entered.resolve(); await unblock.promise; } return original(name, value); };
  const save = h.manager.saveSettings(a.account.id, { ...initial.settings, buyAmount: '0.5' }, initial.revision);
  await entered.promise;
  const runtime = h.manager.get(a.account.id);
  await assert.rejects(runtime.start(config()), /current operation/);
  await assert.rejects(runtime.release('allocation-id', 'paper'), /current operation/);
  runtime.stop(); unblock.resolve(); await save;
  assert.equal(h.workers.length, 0); assert.equal(runtime.state, 'stopped');
  assert.equal((await h.manager.readSettings(a.account.id)).settings.buyAmount, '0.5');
  h.manager.closing = true;
  await assert.rejects(runtime.release('allocation-id', 'paper'), /current operation/);
});

test('concurrent public registrations cannot exceed the configured account capacity', async t => {
  const h = await harness(t, { maxUsers: 1 });
  const results = await Promise.all(['capacity_a', 'capacity_b'].map(username => h.request('/api/account/register', { body: { username, password, maxUsers: 10000, role: 'admin' } })));
  assert.deepEqual(results.map(result => result.code).sort(), [200, 400]);
  assert.match(results.find(result => result.code === 400).body.error, /Registration is currently full/);
  assert.equal((await h.accounts.list()).length, 1); assert.equal((await h.accounts.list())[0].role, 'user');
});

test('account status and persisted portfolio views stay scoped to the logged-in account and selected mode', async t => {
  const h = await harness(t), a = await h.user('positions_a'), b = await h.user('positions_b');
  const row = (id, wallet, kind) => ({ id, wallet, kind, tokens: { [key2.publicKey.toBase58()]: '100' }, decimals: { [key2.publicKey.toBase58()]: 2 } });
  await h.accounts.storeFor(a.account.id).write('portfolio-live', { lots: [row('a-live', key1.publicKey.toBase58(), 'market')], pending: [], events: [] });
  await h.accounts.storeFor(a.account.id).write('portfolio-paper', { lots: [row('a-paper', key1.publicKey.toBase58(), 'liquidity')], pending: [], events: [] });
  await h.accounts.storeFor(b.account.id).write('portfolio-live', { lots: [row('b-live', key2.publicKey.toBase58(), 'market')], pending: [], events: [] });
  const live = await h.request(`/api/portfolio/status?kind=market&mode=live&accountId=${b.account.id}`, { auth: a }), paper = await h.request('/api/portfolio/status?mode=paper', { auth: a });
  assert.deepEqual(live.body.positions.map(p => p.id), ['a-live']); assert.equal(live.body.mode, 'live');
  assert.deepEqual(paper.body.positions.map(p => p.id), ['a-paper']); assert.equal(paper.body.mode, 'paper');
  assert.equal(live.body.positions[0].balances[0].amount, '1');
  await h.accounts.storeFor(a.account.id).write('settings', { ...structuredClone(defaults), mode: 'live' });
  await h.manager.get(a.account.id).start(config());
  assert.equal((await h.manager.view(a.account.id, 'liquidity')).mode, 'live');
});

test('shared live-start checks apply to web and direct runtimes, and public Paper starts are refused', async t => {
  let checks = 0;
  const h = await harness(t, { beforeLiveStart: async () => { checks++; throw new Error('Legacy positions require resolution.'); } });
  const a = await h.user('legacy_web');
  await h.policy.setRecipient(Keypair.generate().publicKey.toBase58());
  const raw = config({ mode: 'live', agreedFeeVersion: (await h.policy.get(a.account.id)).version });
  const response = await h.request('/api/start', { auth: a, body: raw });
  assert.equal(response.code, 400); assert.match(response.body.error, /Legacy positions/);
  await assert.rejects(h.manager.get(a.account.id).start(raw), /Legacy positions/);
  assert.equal(checks, 2); assert.equal(h.workers.length, 0);
  assert.equal((await h.request('/api/start', { auth: a, body: config({ mode: 'paper' }) })).code, 400);
  assert.equal(checks, 2);
});

const manual = (overrides = {}) => ({ id: 'manual-request-test', side: 'sell', mint: key2.publicKey.toBase58(), wallets: [key1.publicKey.toBase58()], sellPercent: '100', ...overrides });

test('manual API requires authentication, CSRF, fee acceptance and imported wallets, and returns no private settings', async t => {
  const h = await harness(t), a = await h.user('manual_host');
  const raw = config({ mode: 'live', leads: [] }), body = { config: raw, trade: manual() };
  assert.equal((await h.request('/api/manual-trade', { body })).code, 401);
  assert.equal((await h.request('/api/manual-trade', { auth: a, body, headers: { 'x-control-token': '' } })).code, 403);
  let response = await h.request('/api/manual-trade', { auth: a, body });
  assert.equal(response.code, 400); assert.match(response.body.error, /configure/);
  await h.policy.setRecipient(Keypair.generate().publicKey.toBase58());
  raw.agreedFeeVersion = (await h.policy.get(a.account.id)).version;
  raw.platformContext = { copyPpm: 0 };
  body.trade.id = 'manual-request-configured';
  response = await h.request('/api/manual-trade', { auth: a, body });
  assert.equal(response.code, 200); assert.equal(response.body.state, 'stopped');
  assert.equal(response.body.manualResult.id, body.trade.id);
  assert.equal((await h.manager.readSettings(a.account.id)).settings.mode, 'live');
  const refreshed = await h.request('/api/status', { auth: a });
  assert.equal(refreshed.body.mode, 'live'); assert.equal(refreshed.body.manualResult.id, body.trade.id);
  const worker = h.workers.at(-1); assert.equal(worker.context.copyPpm, 2500); assert.equal(worker.engine.calls[0].raw.platformContext, undefined);
  assert.equal(JSON.stringify(response.body).includes(raw.wallets[0].privateKey), false);
  response = await h.request('/api/manual-trade', { auth: a, body: { config: raw, trade: manual({ id: 'foreign-wallet', wallets: [key2.publicKey.toBase58()] }) } });
  assert.equal(response.code, 400); assert.match(response.body.error, /imported follower/);
});

test('manual trades during copy reuse its configuration and fee snapshot and reject stale reviewed runs', async t => {
  const h = await harness(t), a = await h.user('manual_active');
  await h.policy.setRecipient(Keypair.generate().publicKey.toBase58());
  const raw = config({ mode: 'live', prioritySol: '0.0003', agreedFeeVersion: (await h.policy.get(a.account.id)).version });
  const runtime = h.manager.get(a.account.id); await runtime.start(raw);
  const runId = runtime.status().runId, context = h.workers[0].context;
  await h.accounts.setCashback(a.account.id, 3000);
  await assert.rejects(runtime.manualTrade({ ...raw, mode: 'paper' }, manual({ id: 'changed-mode' })), /run mode changed/);
  const changed = { ...raw, prioritySol: '0.1' };
  const result = await runtime.manualTrade(changed, manual({ expectedRunId: runId }));
  const call = h.workers[0].engine.calls.at(-1);
  assert.equal(call.raw.mode, 'live'); assert.equal(call.raw.prioritySol, '0.0003'); assert.equal(result.state, 'running'); assert.equal(result.runId, runId);
  assert.strictEqual(h.workers[0].context, context); assert.equal(h.workers.length, 1);
  runtime.stop(); await runtime.start(config());
  await assert.rejects(runtime.manualTrade(config(), manual({ id: 'stale-review', expectedRunId: runId })), /run changed/);
});

test('manual retry reuses one operation and host slot; Stop cancels pending policy loading', async t => {
  const h = await harness(t, { maxActive: 1 }), a = await h.user('manual_slot_a'), b = await h.user('manual_slot_b');
  const blocked = deferred(), entered = deferred(), original = h.policy.get.bind(h.policy);
  h.policy.get = async id => { if (id === a.account.id) { entered.resolve(); await blocked.promise; } return original(id); };
  const runtime = h.manager.get(a.account.id), raw = config(), order = manual();
  const first = runtime.manualTrade(raw, order); await entered.promise;
  const retry = runtime.manualTrade(structuredClone(raw), structuredClone(order)); assert.strictEqual(first, retry);
  assert.equal(runtime.status().manualBusy, true); assert.equal(h.manager.activeCount(), 1);
  assert.throws(() => runtime.manualTrade(raw, { ...order, sellPercent: '50' }), /different settings/);
  await assert.rejects(h.manager.get(b.account.id).manualTrade(raw, manual({ id: 'other-user' })), /slots are busy/);
  runtime.stop(); blocked.resolve(); await assert.rejects(first, /Run stopped/);
  assert.equal(h.workers.length, 0); assert.equal(runtime.status().manualBusy, false); assert.equal(h.manager.activeCount(), 0);
});

test('legacy exposure guard applies to stopped live manual exits as well as buys', async t => {
  let checks = 0;
  const h = await harness(t, { beforeLiveStart: async () => { checks++; throw new Error('Legacy positions require resolution.'); } });
  const a = await h.user('manual_legacy'); await h.policy.setRecipient(Keypair.generate().publicKey.toBase58());
  const raw = config({ mode: 'live', agreedFeeVersion: (await h.policy.get(a.account.id)).version });
  await assert.rejects(h.manager.get(a.account.id).manualTrade(raw, manual()), /Legacy positions/);
  assert.equal(checks, 1); assert.equal(h.workers.length, 0);
});

test('account revisions survive worker recreation and stopped disk views so sells cannot be hidden by old revisions', async t => {
  const h = await harness(t), a = await h.user('revision_sell'), runtime = h.manager.get(a.account.id);
  await runtime.start(config());
  h.workers[0].engine.value.views.copy.revision = 500;
  h.workers[0].engine.value.views.copy.positions = [{ wallet: key1.publicKey.toBase58(), remaining: '100' }];
  h.workers[0].engine.emit('change');
  const bought = await h.manager.view(a.account.id);
  runtime.stop(); await runtime.close();
  const stopped = await h.manager.view(a.account.id);
  assert.equal(stopped.positions.length, 0); assert.ok(stopped.revision > bought.revision); assert.equal(stopped.statusStreamId, bought.statusStreamId);
  await runtime.start(config());
  const restarted = await h.manager.view(a.account.id);
  assert.ok(restarted.revision > stopped.revision); assert.equal(restarted.statusStreamId, bought.statusStreamId);
  assert.notEqual(restarted.runId, bought.runId);
});

test('a slow disk read cannot overwrite a newer worker position update', async t => {
  const h = await harness(t), a = await h.user('revision_disk_race'), store = h.accounts.storeFor(a.account.id);
  const entered = deferred(), unblock = deferred(), read = store.read.bind(store); let delayed = false;
  store.read = async (name, fallback) => {
    if (name === 'paper' && !delayed) { delayed = true; entered.resolve(); await unblock.promise; return { lots: [{ wallet: key1.publicKey.toBase58(), remaining: '100', decimals: 2 }], pending: [], events: [] }; }
    return read(name, fallback);
  };
  const oldRead = h.manager.view(a.account.id, 'copy', 'paper'); await entered.promise;
  const runtime = h.manager.get(a.account.id); await runtime.start(config());
  const fresh = await h.manager.view(a.account.id, 'copy', 'paper'); unblock.resolve();
  const delivered = await oldRead;
  assert.deepEqual(delivered.positions, []); assert.ok(delivered.revision >= fresh.revision);
});

test('stopped account positions retain their journal while read-only prices and aggregate PnL refresh', async t => {
  const h = await harness(t), a = await h.user('stopped_prices'), mint = key2.publicKey.toBase58(), wallet = key1.publicKey.toBase58();
  const sol = 'So11111111111111111111111111111111111111112'; let tokenPrice = 10;
  h.manager.positionFeed = { async prices(mints) { assert.deepEqual(mints, [mint]); return new Map([[mint, { price: tokenPrice, receivedAt: Date.now() }], [sol, { price: 100, receivedAt: Date.now() }]]); } };
  await h.accounts.storeFor(a.account.id).write('live', { lots: [{ id: 'held', wallet, mint, original: '100', remaining: '100', decimals: 2,
    costBasis: { version: 1, inputMint: sol, inputAmount: '50000000', inputDecimals: 9, inputPriceUsd: 100, solPriceUsd: 100 } }], pending: [], events: [] });
  const first = await h.manager.view(a.account.id);
  assert.equal(first.positionSummary.openCount, 1); assert.equal(first.positionSummary.totalValueSol, 0.1); assert.equal(first.positionSummary.totalPnlSol, 0.05);
  tokenPrice = 20;
  const next = await h.manager.view(a.account.id);
  assert.equal(next.positionSummary.totalValueSol, 0.2); assert.ok(Math.abs(next.positionSummary.totalPnlSol - 0.15) < 1e-12);
  assert.ok(next.revision > first.revision); assert.equal(next.positions[0].remaining, '100'); assert.equal(next.state, 'stopped');
  assert.equal(h.workers.length, 0);
});

test('stopped live views refresh holdings in a temporary read-only worker without starting trading or exposing keys', async t => {
  let starts = 0;
  const h = await harness(t, { beforeLiveStart: async () => { starts++; } }), a = await h.user('inventory_cold');
  const store = h.accounts.storeFor(a.account.id), raw = config({ mode: 'live', rpcUrl: 'https://rpc.example/?api-key=private-rpc-value' });
  await store.write('settings', { ...structuredClone(defaults), ...raw });
  await store.write('live', { lots: [{ id: 'held', wallet: key1.publicKey.toBase58(), mint: key2.publicKey.toBase58(), remaining: '100', decimals: 2 }], pending: [], events: [] });
  const entered = deferred(), finish = deferred(), created = [];
  h.manager.engineFactory = (target, context) => {
    const engine = new MockEngine(); created.push({ engine, context });
    engine.refreshInventory = async input => {
      assert.deepEqual(Object.keys(input).sort(), ['heliusKey', 'rpcRequestsPerSecond', 'rpcUrl']); assert.equal(input.rpcUrl, raw.rpcUrl);
      entered.resolve(); await finish.promise;
      const data = await target.read('live'); data.lots[0].remaining = '0'; await target.write('live', data);
      engine.value.mode = 'live'; engine.value.views.copy = empty('copy', 'live'); engine.value.inventoryRefresh = { state: 'idle', at: 123, mode: 'live' };
      engine.emit('change'); return engine.status();
    };
    return engine;
  };
  const initial = await h.manager.view(a.account.id); await entered.promise;
  assert.equal(initial.positions.length, 1); assert.equal(h.manager.activeCount(), 0); assert.equal(h.manager.inventoryRefreshWorkers, 1);
  const runtime = h.manager.get(a.account.id), inFlight = runtime.refreshPositions(); assert.strictEqual(inFlight, runtime.refreshPositions());
  finish.resolve(); await inFlight;
  const updated = await h.manager.view(a.account.id);
  assert.deepEqual(updated.positions, []); assert.equal(updated.state, 'stopped'); assert.equal(updated.inventoryRefresh.at, 123);
  assert.equal(created.length, 1); assert.equal(created[0].engine.closed, true); assert.equal(created[0].context, null); assert.equal(created[0].engine.calls.length, 0);
  assert.equal(runtime.worker, null); assert.equal(starts, 0); assert.equal(h.manager.inventoryRefreshWorkers, 0);
  await runtime.refreshPositions(); assert.equal(created.length, 1);
});

test('cold inventory workers are bounded across users and starting trading cancels an existing refresh first', async t => {
  const h = await harness(t), users = await Promise.all(['inventory_slot_a', 'inventory_slot_b', 'inventory_slot_c'].map(name => h.user(name)));
  for (const user of users) {
    await h.accounts.storeFor(user.account.id).write('settings', { ...structuredClone(defaults), ...config({ mode: 'live' }) });
    await h.accounts.storeFor(user.account.id).write('live', { lots: [{ wallet: key1.publicKey.toBase58(), mint: key2.publicKey.toBase58(), remaining: '100', decimals: 2 }], pending: [], events: [] });
  }
  const entered = deferred(), engines = [];
  h.manager.engineFactory = () => {
    const engine = new MockEngine(), unblock = deferred(); engines.push(engine);
    engine.refreshInventory = async () => { if (engines.length === 2) entered.resolve(); await unblock.promise; return engine.status(); };
    engine.cancelInventoryRefresh = async () => { engine.cancelled = true; unblock.resolve(); };
    return engine;
  };
  const runtimes = users.map(user => h.manager.get(user.account.id));
  const tasks = runtimes.map(runtime => runtime.refreshPositions()); await entered.promise;
  await Promise.all(tasks.filter((task, index) => !runtimes[index].worker));
  assert.equal(engines.length, 2); assert.equal(h.manager.inventoryRefreshWorkers, 2); assert.equal(h.manager.activeCount(), 0);
  const active = runtimes.find(runtime => runtime.worker === engines[0]);
  await active.start(config());
  assert.equal(engines[0].cancelled, true); assert.equal(engines[0].closed, true); assert.equal(active.state, 'running');
  await engines[1].cancelInventoryRefresh(); await Promise.all(tasks);
  assert.equal(h.manager.inventoryRefreshWorkers, 0); assert.equal(engines[1].closed, true); active.stop();
});
test('Husher connection reveals the saved key only to its verified owner and never in account status',async t=>{
  const {FundingService}=await import('../src/funding.mjs');const h=await harness(t),owner=await h.user('husher_owner'),other=await h.user('husher_other');let now=Date.now();h.accounts.now=()=>now;
  for(const user of [owner,other]){await h.accounts.setAdmin(user.account.id);const enrollment=await h.accounts.beginMfa(user.account.id,password);user.mfaSecret=enrollment.secret;await h.accounts.enableMfa(user.account.id,password,totp(enrollment.secret,now));Object.assign(user,await h.accounts.createSession(user.account.id,{mfaVerified:true}));}
  await h.accounts.hostStore.write('husher-config',{apiKey:'only-owner-can-read-this-key',ownerAccountId:owner.account.id});now+=30000;
  const ownerView=await h.request('/api/account/connections/husher',{auth:owner});assert.equal(ownerView.code,200);assert(!JSON.stringify(ownerView.body).includes('only-owner-can-read-this-key'));
  assert.notEqual((await h.request('/api/account/connections/husher',{auth:other})).code,200);
  assert.equal((await h.request('/api/account/connections/husher',{auth:owner,headers:{'x-control-token':'wrong'},body:{action:'reveal',password,code:totp(owner.mfaSecret,now)}})).code,403);
  const shown=await h.request('/api/account/connections/husher',{auth:owner,body:{action:'reveal',password,code:totp(owner.mfaSecret,now)}});assert.equal(shown.code,200);assert.equal(shown.body.apiKey,'only-owner-can-read-this-key');
  assert(!JSON.stringify((await h.request('/api/account',{auth:owner})).body).includes('only-owner-can-read-this-key'));
  const rejected=await h.request('/api/account/connections/husher',{auth:other,body:{action:'reveal',password,code:totp(other.mfaSecret,now)}});assert.notEqual(rejected.code,200);assert(!JSON.stringify(rejected.body).includes('only-owner-can-read-this-key'));
  const funding=new FundingService(h.accounts,h.manager,null,{fetcher:async()=>new Response(JSON.stringify({success:true,data:{}}))});await assert.rejects(funding.configure('new-unprivileged-key',other.account.id),/owner/);
});
test('token image uploads require CSRF and account ownership, while image reads use fixed image types',async t=>{
  const {Launchpad}=await import('../src/launchpad.mjs'),h=await harness(t),a=await h.user('image_owner'),b=await h.user('image_other'),png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=';
  assert.equal((await h.request('/api/launchpad/image',{auth:a,headers:{'x-control-token':'wrong'},body:{data:png}})).code,403);
  const upload=await h.request('/api/launchpad/image',{auth:a,body:{data:png}});assert.equal(upload.code,200);assert.match(upload.body.imageId,/^[a-f0-9]{64}\.png$/);
  const image=await fetch(h.base+upload.body.url,{headers:{origin:'https://example.com','sec-fetch-site':'cross-site'}});assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');assert.equal(image.headers.get('x-content-type-options'),'nosniff');assert.equal(Buffer.from(await image.arrayBuffer()).toString('base64'),png);
  const manager=new Launchpad(h.accounts,h.manager);t.after(()=>manager.close());await assert.rejects(manager.ownedImage(b.account.id,upload.body.imageId),/Upload a token image/);assert.equal((await manager.ownedImage(a.account.id,upload.body.imageId)).type,'image/png');
});

test('connected launch signing routes are authenticated, CSRF-protected and scoped to the signed-in account',async t=>{
  const calls=[],launchpad={signature:async(...args)=>{calls.push(['signature',...args]);return{state:'awaiting_signature'};},sign:async(...args)=>{calls.push(['sign',...args]);return{state:'launching'};}};
  const h=await harness(t,{launchpad}),a=await h.user('connected_signer'),b=await h.user('other_signer');
  for(const path of ['/api/launchpad/signature','/api/launchpad/sign']){
    assert.equal((await h.request(path,{body:{id:'draft'}})).code,401);
    assert.equal((await h.request(path,{auth:a,headers:{'x-control-token':'wrong'},body:{id:'draft'}})).code,403);
    assert.equal((await h.request(path,{auth:a})).code,405);
  }
  assert.equal(calls.length,0);
  assert.equal((await h.request('/api/launchpad/signature',{auth:a,body:{id:'draft',operationId:'op',accountId:b.account.id}})).code,200);
  assert.equal((await h.request('/api/launchpad/sign',{auth:a,body:{id:'draft',operationId:'op',transaction:'signed',accountId:b.account.id}})).code,200);
  assert.deepEqual(calls,[['signature',a.account.id,'draft','op'],['sign',a.account.id,'draft','op','signed']]);
  assert.equal((await fetch(h.base+'/launchpad-wallet.mjs')).status,200);const bundle=await fetch(h.base+'/vendor/solana-transaction.mjs');assert.equal(bundle.status,200);assert.match(bundle.headers.get('content-type'),/javascript/);assert((await bundle.text()).includes('VersionedTransaction'));
});

test('live trades support a one-second viewer without sharing slower market or holder-history request limits',async t=>{
  const calls=[],feed={liveTrades:async(...args)=>{calls.push(['live',...args]);return{trades:[],refreshMs:1000};},holderHistory:async(...args)=>{calls.push(['history',...args]);return{coverage:'partial'};},pools:async()=>({pools:[]})};
  const h=await harness(t,{marketData:{forAccount:async id=>{calls.push(['account',id]);return feed;}}}),a=await h.user('live_market_user');
  const base='/api/market/live-trades?chain=solana&address=token&pair=pool';
  assert.equal((await h.request(base)).code,401);
  for(let i=0;i<61;i++)assert.equal((await h.request(base,{auth:a})).code,200);
  assert.equal((await h.request('/api/market/pools?chain=solana&address=token',{auth:a})).code,200);
  assert.equal((await h.request('/api/market/holder-history?chain=solana&address=token&wallet=holder',{auth:a})).code,200);
  assert.deepEqual(calls.find(x=>x[0]==='live'),['live','solana','token','pool']);assert.deepEqual(calls.at(-1),['history','solana','token','holder']);
  assert(calls.filter(x=>x[0]==='account').every(x=>x[1]===a.account.id));
});


test('developer-buy estimate endpoint authenticates, checks CSRF, and ignores supplied account identity',async t=>{
  const calls=[],launchpad={estimate:async(id,body)=>{calls.push({id,body});return{gross:'12',net:'12',maxQuote:'10000000',solBudget:'10000000',asOf:1};}};
  const h=await harness(t,{launchpad}),a=await h.user('estimate_owner'),b=await h.user('estimate_other');
  const body={devBuySol:'.01',accountId:b.account.id};
  assert.equal((await h.request('/api/launchpad/estimate',{body})).code,401);
  assert.equal((await h.request('/api/launchpad/estimate',{auth:a,headers:{'x-control-token':'wrong'},body})).code,403);
  assert.equal(calls.length,0);
  const response=await h.request('/api/launchpad/estimate',{auth:a,body});assert.equal(response.code,200);assert.equal(response.body.solBudget,'10000000');assert.equal(calls[0].id,a.account.id);
  assert.equal((await h.request('/api/launchpad/estimate',{auth:a})).code,405);
});


test('launch preparation and launched-token pages preserve account and CSRF boundaries',async t=>{
  const calls=[],launchpad={prepare:async(id,body)=>{calls.push({id,body});return{prepareId:'a'.repeat(32),review:{minimumSol:'0.04'}};},read:async id=>({launches:[{id:'owned-by-'+id}]})};
  const h=await harness(t,{launchpad}),a=await h.user('prepared_owner'),b=await h.user('prepared_other'),body={accountId:b.account.id,name:'Token'};
  assert.equal((await h.request('/api/launchpad/prepare',{body})).code,401);
  assert.equal((await h.request('/api/launchpad/prepare',{auth:a,headers:{'x-control-token':'wrong'},body})).code,403);assert.equal(calls.length,0);
  assert.equal((await h.request('/api/launchpad/prepare',{auth:a,body})).code,200);assert.equal(calls[0].id,a.account.id);
  assert.equal((await h.request('/api/launchpad/prepare',{auth:a})).code,405);
  assert.deepEqual((await h.request('/api/launchpad?accountId='+b.account.id,{auth:a})).body.launches,[{id:'owned-by-'+a.account.id}]);
  for(const [path,mime]of [['/launched-tokens','text/html'],['/launched-tokens.js','text/javascript'],['/launched-tokens.css','text/css']]){const response=await fetch(h.base+path);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),new RegExp(mime));assert(!(await response.text()).includes('owned-by-'));}
});

test('public explorer is read-only and keeps launch controls authenticated; root preserves legacy trading links',async t=>{
  const calls=[],mint=Keypair.generate().publicKey.toBase58();
  const explore={list:async options=>{calls.push(['list',options]);return{coins:[{mint,name:'Public coin'}],total:1};},updates:async()=>{calls.push(['updates']);return{version:'a'.repeat(64),total:1,stale:false,refreshMs:10000};},users:async options=>{calls.push(['users',options]);return{users:[{username:'public_creator',bio:'Public profile',avatar:null,launchCount:1}],total:1};},token:async value=>({coin:{mint:value}}),market:async value=>({coin:{mint:value},native:null,pool:null}),rewards:async value=>({mint:value,mode:'buyback',buyback:{spentQuote:null},readOnly:true})};
  const h=await harness(t,{explore});
  const data=await h.request('/api/explore?stage=moving&sort=volume&limit=10');
  assert.equal(data.code,200);assert.equal(data.body.coins[0].mint,mint);assert.deepEqual(calls,[['list',{stage:'moving',sort:'volume',limit:'10'}]]);
  const updates=await h.request('/api/explore/updates');assert.equal(updates.code,200);assert.deepEqual(updates.body,{version:'a'.repeat(64),total:1,stale:false,refreshMs:10000});assert.deepEqual(calls.at(-1),['updates']);
  const updateCalls=calls.length;assert.equal((await h.request('/api/explore/updates?accountId=private')).code,400);assert.equal((await h.request('/api/explore/updates',{body:{}})).code,405);assert.equal(calls.length,updateCalls);
  const users=await h.request('/api/explore/users?search=%40public&offset=0&limit=12');assert.equal(users.code,200);assert.equal(users.body.users[0].username,'public_creator');assert.deepEqual(calls.at(-1),['users',{search:'@public',offset:'0',limit:'12'}]);
  assert.equal((await h.request('/api/explore/users',{body:{search:'public'}})).code,405);
  for(const route of ['token','market'])assert.equal((await h.request(`/api/explore/${route}?mint=${mint}`)).body.coin.mint,mint);
  assert.equal((await h.request('/api/explore/rewards?mint='+mint)).body.mint,mint);
  assert.equal((await h.request('/api/explore/rewards?mint='+mint,{body:{action:'distribute'}})).code,405);
  assert.equal((await h.request('/api/explore',{body:{}})).code,405);
  assert.equal((await h.request('/api/explore',{headers:{origin:'https://untrusted.example'}})).code,403);
  assert.equal((await h.request('/api/launchpad/create',{body:{}})).code,401);
  const home=await(await fetch(h.base+'/')).text();assert.match(home,/explore\.js/);assert.doesNotMatch(home,/src="\/app\.js"/);
  for(const route of ['/trade','/?tool=copy','/?token='+mint,'/?account=connections','/?chain=robinhood']){
    const html=await(await fetch(h.base+route)).text();assert.match(html,/app\.js/);assert.doesNotMatch(html,/(?:src|href)="\/explore\.js/);
  }
  for(const route of ['/explore','/coin?mint='+mint,'/explore.js','/explore-view.mjs','/explore.css','/coin.js','/coin.css','/coin-rewards-view.mjs'])assert.equal((await fetch(h.base+route)).status,200);
});

test('adjustable market-cap launch endpoints require verified admin MFA and ignore client account overrides',async t=>{
  const calls=[],launchpad=Object.fromEntries(['prepare','estimate','create'].map(action=>[action,async(...args)=>{calls.push([action,...args]);return{ok:true};}]));
  const h=await harness(t,{launchpad}),owner=await h.user('adminlaunchowner'),other=await h.user('adminlaunchother');
  const capabilities='/api/admin/launchpad/capabilities';
  assert.equal((await h.request(capabilities)).code,401);
  assert.equal((await h.request(capabilities,{auth:owner})).code,403);
  for(const action of ['prepare','estimate','create'])assert.equal((await h.request('/api/admin/launchpad/'+action,{auth:owner,body:{targetUsd:100000,adminLaunch:true}})).code,403);
  await h.accounts.setAdmin(owner.account.id);
  assert.equal((await h.request(capabilities,{auth:owner})).code,403);
  const setup=await h.accounts.beginMfa(owner.account.id,password);await h.accounts.enableMfa(owner.account.id,password,totp(setup.secret,Date.now()));
  const auth=await h.accounts.createSession(owner.account.id,{mfaVerified:true});
  assert.deepEqual((await h.request(capabilities,{auth})).body,{adjustableMarketCap:true,minUsd:20000,maxUsd:100000,defaultUsd:20000});
  assert.equal((await h.request('/api/admin/launchpad/create',{auth,body:{},headers:{'x-control-token':'invalid'}})).code,403);
  for(const action of ['prepare','estimate','create']){
    const body={targetUsd:100000,accountId:other.account.id};assert.equal((await h.request('/api/admin/launchpad/'+action,{auth,body})).code,200);
    assert.deepEqual(calls.at(-1),[action,owner.account.id,body,{adminLaunch:true}]);
  }
  await h.request('/api/launchpad/create',{auth,body:{targetUsd:100000,adminLaunch:true}});
  assert.equal(calls.at(-1).length,3,'normal launch route never supplies trusted admin options');
});

test('central admin panel routes keep overview private and require fresh identity proof for reward actions',async t=>{
  const calls=[],adminPanel={overview:async actor=>{calls.push(['overview',actor]);return {counts:{accounts:2}};},launchAction:async(actor,body)=>{calls.push(['action',actor,body]);return {status:'queued'};}};
  const h=await harness(t,{adminPanel}),owner=await h.user('panelowner'),other=await h.user('panelother');
  assert.equal((await h.request('/api/admin/overview')).code,401);
  assert.equal((await h.request('/api/admin/launches/action',{body:{}})).code,401);
  assert.equal((await h.request('/api/admin/overview',{auth:owner})).code,403);
  assert.equal((await h.request('/api/admin/launches/action',{auth:other,body:{}})).code,403);
  await h.accounts.setAdmin(owner.account.id);
  assert.equal((await h.request('/api/admin/overview',{auth:owner})).code,403);
  let now=Date.now();h.accounts.now=()=>now;
  const enrollment=await h.accounts.beginMfa(owner.account.id,password);
  await h.accounts.enableMfa(owner.account.id,password,totp(enrollment.secret,now));
  const auth=await h.accounts.createSession(owner.account.id,{mfaVerified:true});now+=30000;
  assert.equal((await h.request('/api/admin/overview',{auth,headers:{'x-control-token':'wrong'}})).code,403);
  assert.equal((await h.request('/api/admin/overview',{auth})).code,200);
  assert.deepEqual(calls,[['overview',owner.account.id]]);
  const body={accountId:other.account.id,id:'a'.repeat(32),requestId:'b'.repeat(32),action:'distribute'};
  assert.equal((await h.request('/api/admin/launches/action',{auth,body:{...body,password:'wrong',code:'000000'}})).code,400);
  assert.equal(calls.length,1);
  assert.equal((await h.request('/api/admin/launches/action',{auth,body:{...body,password,code:totp(enrollment.secret,now)}})).code,200);
  assert.equal(calls.at(-1)[1],owner.account.id);
  assert.equal(calls.at(-1)[2].accountId,other.account.id);
  await h.accounts.setAdmin(owner.account.id,false);
  assert.equal((await h.request('/api/admin/overview',{auth})).code,403);
  assert.equal((await h.request('/api/admin/launches/action',{auth,body})).code,403);
  for(const path of ['/admin','/admin.js','/admin.css','/quote-identity.mjs']){const response=await fetch(h.base+path);assert.equal(response.status,200);}
});

test('bulk holder distribution HTTP routes require admin MFA, CSRF and fresh proof and never accept caller launch targets',async t=>{
  const calls=[],adminPanel={readHolderDistributions:async actor=>{calls.push(['read',actor]);return {job:null};},distributeAllHolders:async(actor,input,context)=>{await context.authorize();calls.push(['enqueue',actor,input]);return {job:{requestId:input.requestId,state:'queued'},alreadyRequested:false};}};
  const h=await harness(t,{adminPanel}),owner=await h.user('bulkowner'),other=await h.user('bulkother'),path='/api/admin/holder-distributions';
  for(const method of ['GET','POST']){assert.equal((await h.request(path,{method,...(method==='POST'?{body:{}}:{})})).code,401);assert.equal((await h.request(path,{auth:other,method,...(method==='POST'?{body:{}}:{})})).code,403);}
  await h.accounts.setAdmin(owner.account.id);assert.equal((await h.request(path,{auth:owner})).code,403);
  let now=Date.now();h.accounts.now=()=>now;const enrollment=await h.accounts.beginMfa(owner.account.id,password);await h.accounts.enableMfa(owner.account.id,password,totp(enrollment.secret,now));const auth=await h.accounts.createSession(owner.account.id,{mfaVerified:true});now+=30000;
  assert.equal((await h.request(path,{auth,headers:{'x-control-token':'invalid'}})).code,403);assert.equal((await h.request(path,{auth})).code,200);
  assert.equal((await h.request(path,{auth,body:{requestId:'1'.repeat(32),password:'wrong',code:'000000'}})).code,400);assert.equal(calls.length,1);
  assert.equal((await h.request(path,{auth,body:{requestId:'1'.repeat(32),password,code:totp(enrollment.secret,now),accountId:other.account.id,ids:['injected'],route:'pumpswap'}})).code,202);
  assert.deepEqual(calls.at(-1),['enqueue',owner.account.id,{requestId:'1'.repeat(32)}]);
  await h.accounts.setAdmin(owner.account.id,false);assert.equal((await h.request(path,{auth})).code,403);assert.equal((await h.request(path,{auth,body:{}})).code,403);
});

test('bulk holder enqueue rejects session or administrator role revoked during fresh authentication',async t=>{
  const calls=[],adminPanel={distributeAllHolders:async()=>{calls.push('enqueue');return {};}};
  const h=await harness(t,{adminPanel}),owner=await h.user('bulkrevoked');await h.accounts.setAdmin(owner.account.id);let now=Date.now();h.accounts.now=()=>now;
  const enrollment=await h.accounts.beginMfa(owner.account.id,password);await h.accounts.enableMfa(owner.account.id,password,totp(enrollment.secret,now));
  const original=h.accounts.reauthenticate.bind(h.accounts);
  for(const kind of ['session','role']){
    await h.accounts.setAdmin(owner.account.id,true);const auth=await h.accounts.createSession(owner.account.id,{mfaVerified:true});now+=30000;
    h.accounts.reauthenticate=async(...args)=>{const result=await original(...args);if(kind==='session')await h.accounts.revokeSession(auth.token);else await h.accounts.setAdmin(owner.account.id,false);return result;};
    const result=await h.request('/api/admin/holder-distributions',{auth,body:{requestId:'1'.repeat(32),password,code:totp(enrollment.secret,now)}});assert([401,403].includes(result.code));
  }
  assert.deepEqual(calls,[]);
});

test('an administrator revoked during reauthentication cannot change fee settings',async t=>{
  const calls=[],h=await harness(t,{protocolFees:{configure:async()=>{calls.push('launchpad');return{};}}}),owner=await h.user('revokedadmin');
  await h.accounts.setAdmin(owner.account.id,true);let now=Date.now();h.accounts.now=()=>now;
  const enrollment=await h.accounts.beginMfa(owner.account.id,password);await h.accounts.enableMfa(owner.account.id,password,totp(enrollment.secret,now));
  let auth=await h.accounts.createSession(owner.account.id,{mfaVerified:true}),reauthenticate=h.accounts.reauthenticate.bind(h.accounts);
  h.policy.setRecipient=async()=>{calls.push('toolkit');};
  for(const revoke of ['role','session']){
    for(const path of ['/api/admin/fees','/api/admin/protocol-fees/configure']){
      await h.accounts.setAdmin(owner.account.id,true);auth=await h.accounts.createSession(owner.account.id,{mfaVerified:true});now+=30000;
      h.accounts.reauthenticate=async(...args)=>{const result=await reauthenticate(...args);if(revoke==='role')await h.accounts.setAdmin(owner.account.id,false);else await h.accounts.revokeSession(auth.token);return result;};
      const response=await h.request(path,{auth,body:{password,code:totp(enrollment.secret,now),recipient:Keypair.generate().publicKey.toBase58(),expectedRecipient:'',reason:'Security regression check.'}});
      assert.equal(response.code,403);assert.deepEqual(calls,[]);
    }
  }
});

test('protocol revenue routes bind the administrator identity and freshly authenticate every write',async t=>{
  const calls=[],protocolFees=Object.fromEntries(['read','coins','configure','claim','claimAll','activate'].map(action=>[action,async(...args)=>{calls.push([action,...args]);return {ok:true};}]));
  const h=await harness(t,{protocolFees}),owner=await h.user('protocolowner'),other=await h.user('protocolother');
  for(const path of ['/api/admin/protocol-fees','/api/admin/protocol-fees/coins']){
    assert.equal((await h.request(path)).code,401);
    assert.equal((await h.request(path,{auth:other})).code,403);
  }
  await h.accounts.setAdmin(owner.account.id);
  assert.equal((await h.request('/api/admin/protocol-fees',{auth:owner})).code,403);
  let now=Date.now();h.accounts.now=()=>now;
  const enrollment=await h.accounts.beginMfa(owner.account.id,password);
  await h.accounts.enableMfa(owner.account.id,password,totp(enrollment.secret,now));
  const auth=await h.accounts.createSession(owner.account.id,{mfaVerified:true});now+=30000;
  assert.equal((await h.request('/api/admin/protocol-fees',{auth})).code,200);
  assert.equal((await h.request('/api/admin/protocol-fees/coins',{auth})).code,200);
  assert.deepEqual(calls,[['read',owner.account.id],['coins',owner.account.id]]);
  const body={accountId:other.account.id,actorId:other.account.id,id:'a'.repeat(32),reason:'Collect platform earnings',requestId:'b'.repeat(32)};
  assert.equal((await h.request('/api/admin/protocol-fees/claim',{auth,body:{...body,password:'wrong',code:'000000'}})).code,400);
  assert.equal(calls.length,2);
  for(const action of ['configure','claim','activate','claim-all']){
    const path='/api/admin/protocol-fees/'+action;
    assert.equal((await h.request(path,{auth,headers:{'x-control-token':'wrong'},body})).code,403);
    assert.equal((await h.request(path,{auth})).code,404);
    const input={...body,password,code:totp(enrollment.secret,now)};
    assert.equal((await h.request(path,{auth,body:input})).code,200);
    assert.deepEqual(calls.at(-1),action==='claim-all'?['claimAll',owner.account.id,{requestId:body.requestId}]:[action,owner.account.id,input]);now+=30000;
  }
  await h.accounts.setAdmin(owner.account.id,false);
  assert.equal((await h.request('/api/admin/protocol-fees/claim',{auth,body})).code,403);
});

test('Launchpad onchain branding stays administrator-only and signed requests require fresh identity proof',async t=>{
  const calls=[],branding={list:async actor=>{calls.push(['list',actor]);return {coins:[]};},update:async(actor,body)=>{calls.push(['update',actor,body]);return {queued:true};}};
  const h=await harness(t,{branding}),owner=await h.user('brandowner'),other=await h.user('brandother');
  assert.equal((await h.request('/api/admin/branding')).code,401);
  assert.equal((await h.request('/api/admin/branding',{auth:other})).code,403);
  await h.accounts.setAdmin(owner.account.id);
  assert.equal((await h.request('/api/admin/branding',{auth:owner})).code,403);
  let now=Date.now();h.accounts.now=()=>now;
  const setup=await h.accounts.beginMfa(owner.account.id,password);
  await h.accounts.enableMfa(owner.account.id,password,totp(setup.secret,now));
  const auth=await h.accounts.createSession(owner.account.id,{mfaVerified:true});now+=30000;
  assert.equal((await h.request('/api/admin/branding',{auth})).code,200);
  const body={accountId:other.account.id,actorId:other.account.id,id:'a'.repeat(32),requestId:'b'.repeat(32),reason:'Update the platform brand',confirmPublishedLogo:true};
  assert.equal((await h.request('/api/admin/branding/update',{auth,body,headers:{'x-control-token':'wrong'}})).code,403);
  assert.equal((await h.request('/api/admin/branding/update',{auth,body:{...body,password:'wrong',code:'000000'}})).code,400);
  assert.equal(calls.length,1);
  const request={...body,password,code:totp(setup.secret,now)};
  assert.equal((await h.request('/api/admin/branding/update',{auth,body:request})).code,200);
  assert.deepEqual(calls.at(-1),['update',owner.account.id,request]);
  await h.accounts.setAdmin(owner.account.id,false);
  assert.equal((await h.request('/api/admin/branding/update',{auth,body})).code,403);
});

test('Launchpad logo URLs are readable by onchain metadata viewers without opening cross-origin account APIs',async t=>{
  const h=await harness(t),headers={origin:'https://raydium.io','sec-fetch-site':'cross-site'};
  for(const [path,mime]of [['brand-icon.svg','image/svg+xml'],['brand-logo.svg','image/svg+xml'],['brand-icon.png','image/png'],['brand-avatar.png','image/png'],['brand-avatar.jpg','image/jpeg']]){
    const r=await fetch(h.base+'/'+path,{headers});assert.equal(r.status,200);assert(r.headers.get('content-type').startsWith(mime));assert.equal(r.headers.get('access-control-allow-origin'),'*');assert((await r.arrayBuffer()).byteLength>100);
  }
  assert.equal((await h.request('/api/account',{headers})).code,403);
  assert.equal((await h.request('/brand-avatar.png',{headers,body:{}})).code,403);
});

test('wallet-only launch sessions require a signed browser challenge and cannot access toolkit, exports or admin', async t => {
  const {createPrivateKey,sign}=await import('node:crypto');
  const {request,base,accounts}=await harness(t,{launchpad:{read:async()=>({launches:[]})}});
  const wallet=Keypair.generate(),address=wallet.publicKey.toBase58();
  assert.equal((await request('/api/wallet/challenge',{body:{address}})).code,403);
  const c=await request('/api/wallet/challenge',{body:{address},headers:{origin:base}});assert.equal(c.code,200);
  const signature=sign(null,Buffer.from(c.body.message),createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(wallet.secretKey.slice(0,32))]),format:'der',type:'pkcs8'})).toString('base64');
  const signed=await request('/api/wallet/verify',{body:{nonce:c.body.nonce,signature},headers:{origin:base,cookie:c.headers.get('set-cookie').split(';')[0]}});assert.equal(signed.code,200);
  const headers={cookie:signed.headers.get('set-cookie').split(';')[0],'x-control-token':signed.body.token};
  assert.equal((await request('/api/launchpad',{headers})).code,200);
  const profile=await request('/api/account',{headers});assert.equal(profile.code,200);assert.equal(profile.body.account.mainWallet,address);assert.equal(profile.body.fees.mainWallet,address);assert.equal(profile.body.account.authType,'wallet');
  const walletStore=accounts.storeFor(profile.body.account.id);assert.equal(await walletStore.read('main-wallet',null),null);assert.equal(await walletStore.read('robinhood-account',null),null);assert.deepEqual((await walletStore.read('settings')).wallets,[]);
  for(const path of ['/api/settings','/api/admin/launchpad/capabilities','/api/account/connections/husher','/api/launchpad/export'])assert.equal((await request(path,{headers})).code,403,path);
  assert.equal((await request('/api/launchpad',{headers:{cookie:headers.cookie}})).code,403);
});

test('live revenue endpoint is read-only and protected by administrator role, MFA and control token',async t=>{
  const calls=[],h=await harness(t,{adminRevenue:{read:async id=>{calls.push(id);return{at:1,refreshMs:15000,products:[],totals:[]};}}}),owner=await h.user('revenueowner'),other=await h.user('revenueother');
  assert.equal((await h.request('/api/admin/revenue')).code,401);
  assert.equal((await h.request('/api/admin/revenue',{auth:owner})).code,403);
  await h.accounts.setAdmin(owner.account.id);assert.equal((await h.request('/api/admin/revenue',{auth:owner})).code,403);
  const now=Date.now();h.accounts.now=()=>now;const enrollment=await h.accounts.beginMfa(owner.account.id,password);await h.accounts.enableMfa(owner.account.id,password,totp(enrollment.secret,now));
  const auth=await h.accounts.createSession(owner.account.id,{mfaVerified:true});
  assert.equal((await h.request('/api/admin/revenue',{auth,headers:{'x-control-token':'wrong'}})).code,403);
  assert.equal((await h.request('/api/admin/revenue',{auth:other})).code,403);assert.deepEqual(calls,[]);
  const result=await h.request('/api/admin/revenue',{auth});assert.equal(result.code,200);assert.equal(result.body.refreshMs,15000);assert.deepEqual(calls,[owner.account.id]);
  await h.accounts.setAdmin(owner.account.id,false);assert.equal((await h.request('/api/admin/revenue',{auth})).code,403);assert.equal(calls.length,1);
});

test('owner launch archiving is session scoped, POST only and CSRF protected',async t=>{
  const calls=[],launchId='d'.repeat(32),h=await harness(t,{launchpad:{archive:async(...args)=>{calls.push(args);return {id:args[1],listArchived:args[2].archived};}}});
  const owner=await h.user('archivecreator'),other=await h.user('archiveother'),path='/api/launchpad/archive';
  const body={id:launchId,archived:true,accountId:other.account.id,actorId:other.account.id,hidden:false,state:'failed'};
  assert.equal((await h.request(path,{body})).code,401);
  assert.equal((await h.request(path,{auth:owner,body,headers:{'x-control-token':'wrong'}})).code,403);
  assert.equal((await h.request(path,{auth:owner,body,headers:{origin:'https://other.invalid'}})).code,403);
  assert.notEqual((await h.request(path,{auth:owner})).code,200);
  assert.deepEqual(calls,[]);
  const result=await h.request(path,{auth:owner,body});assert.equal(result.code,200);assert.equal(result.body.listArchived,true);
  assert.deepEqual(calls,[[owner.account.id,launchId,{archived:true}]]);
});

test('admin launch archive routes preserve MFA and actor identity and filter before pagination',async t=>{
  const launchId='f'.repeat(32),hiddenId='e'.repeat(32),mint=Keypair.generate().publicKey.toBase58();let ownerId='',saves=0,demote=false;
  let book={launches:[
    {id:launchId,input:{network:'mainnet-beta',route:'raydium',name:'Failed launch',symbol:'FAILED',feeMode:'creator'},keys:{wallet:{address:mint},mint:{address:mint}},review:{quoteDecimals:9},state:'failed',operations:[],createdAt:2},
    {id:hiddenId,input:{network:'mainnet-beta',route:'raydium',name:'Hidden launch',symbol:'HIDDEN',feeMode:'creator'},keys:{wallet:{address:mint},mint:{address:mint}},review:{quoteDecimals:9},state:'failed',operations:[],createdAt:1,moderation:{hidden:true}},
  ]};
  const launchpad={book:async id=>id===ownerId?structuredClone(book):{launches:[]},locked:async(id,fn)=>{assert.equal(id,ownerId);if(demote)await h.accounts.setAdmin(admin.account.id,false);return fn(structuredClone(book));},find:(b,id)=>{const row=b.launches.find(x=>x.id===id);if(!row)throw Error('Launch not found.');return row;},save:async(id,b)=>{assert.equal(id,ownerId);book=structuredClone(b);saves++;}};
  const h=await harness(t,{launchpad}),admin=await h.user('archiveadmin'),owner=await h.user('archiveowner');ownerId=owner.account.id;
  const path='/api/admin/launches/archive',body={accountId:ownerId,id:launchId,archived:true,actorId:ownerId,hidden:true};
  assert.equal((await h.request(path,{body})).code,401);
  assert.equal((await h.request(path,{auth:owner,body})).code,403);
  await h.accounts.setAdmin(admin.account.id);assert.equal((await h.request(path,{auth:admin,body})).code,403);
  const now=Date.now();h.accounts.now=()=>now;const enrollment=await h.accounts.beginMfa(admin.account.id,password);await h.accounts.enableMfa(admin.account.id,password,totp(enrollment.secret,now));const auth=await h.accounts.createSession(admin.account.id,{mfaVerified:true});
  assert.equal((await h.request(path,{auth,body,headers:{'x-control-token':'wrong'}})).code,403);
  assert.equal((await h.request(path,{auth})).code,405);assert.equal(saves,0);
  let result=await h.request('/api/admin/launches?view=active&limit=1',{auth});assert.equal(result.code,200);assert.equal(result.body.total,1);assert.equal(result.body.launches[0].id,launchId);assert.deepEqual(result.body.counts,{active:1,archived:1});
  result=await h.request(path,{auth,body});assert.equal(result.code,200);assert.equal(result.body.launch.listArchived,true);assert.equal(book.launches[0].listArchive.actorId,admin.account.id);assert.equal(book.launches[0].moderation,undefined);
  result=await h.request('/api/admin/launches?view=archived&limit=1&offset=1',{auth});assert.equal(result.code,200);assert.equal(result.body.total,2);assert.equal(result.body.launches[0].id,hiddenId);assert.deepEqual(result.body.counts,{active:0,archived:2});
  assert.equal((await h.request('/api/admin/launches?view=invalid',{auth})).code,400);
  result=await h.request(path,{auth,body:{...body,archived:false}});assert.equal(result.code,200);assert.equal(result.body.launch.listArchived,false);assert.equal(saves,2);
  demote=true;assert.equal((await h.request(path,{auth,body})).code,403);assert.equal(saves,2);
});

test('one-click launch hide and restore retain admin, MFA, CSRF and audit checks while user bans require fresh proof',async t=>{
  const launchId='e'.repeat(32);let book={launches:[{id:launchId}]},saves=0,proofs=0;
  const launchpad={locked:async(accountId,fn)=>fn(structuredClone(book)),find:(value,id)=>{const row=value.launches.find(l=>l.id===id);if(!row)throw Error('Launch not found.');return row;},save:async(accountId,value)=>{book=structuredClone(value);saves++;}};
  const explore={registryLoaded:true,pendingRegistry:Promise.resolve()};
  const h=await harness(t,{launchpad,explore}),owner=await h.user('visibilityowner'),other=await h.user('visibilitycreator');
  const path='/api/admin/moderation/launch',body={accountId:other.account.id,id:launchId,hidden:true,reason:'Hidden from the admin panel.'};
  assert.equal((await h.request(path,{body})).code,401);assert.equal((await h.request(path,{auth:other,body})).code,403);assert.equal(saves,0);
  await h.accounts.setAdmin(owner.account.id);assert.equal((await h.request(path,{auth:owner,body})).code,403);
  let now=Date.now();h.accounts.now=()=>now;const enrollment=await h.accounts.beginMfa(owner.account.id,password);await h.accounts.enableMfa(owner.account.id,password,totp(enrollment.secret,now));
  await assert.rejects(h.accounts.createSession(owner.account.id,{mfaVerified:false}),/Two-factor authentication required/);
  const auth=await h.accounts.createSession(owner.account.id,{mfaVerified:true});
  assert.equal((await h.request(path,{auth,body,headers:{'x-control-token':'wrong'}})).code,403);assert.equal(saves,0);
  const reauthenticate=h.accounts.reauthenticate.bind(h.accounts);h.accounts.reauthenticate=async(...args)=>{proofs++;return reauthenticate(...args);};
  let result=await h.request(path,{auth,body});assert.equal(result.code,200);assert.equal(result.body.hidden,true);assert.equal(explore.registryLoaded,false);
  result=await h.request(path,{auth,body:{...body,hidden:false,reason:'Restored from the admin panel.'}});assert.equal(result.code,200);assert.equal(result.body.hidden,false);assert.equal(proofs,0);assert.equal(saves,2);
  assert.deepEqual(book.launches[0].moderationHistory.map(({hidden,reason,actorId})=>({hidden,reason,actorId})),[{hidden:true,reason:body.reason,actorId:owner.account.id},{hidden:false,reason:'Restored from the admin panel.',actorId:owner.account.id}]);
  const ban={target:other.account.username,banned:true,reason:'Repeated prohibited content.'};assert.equal((await h.request('/api/admin/moderation/user',{auth,body:ban})).code,400);assert.equal(proofs,1);assert.equal((await h.accounts.get(other.account.id)).banned,false);
  now+=30000;assert.equal((await h.request('/api/admin/moderation/user',{auth,body:{...ban,password,code:totp(enrollment.secret,now)}})).code,200);assert.equal(proofs,2);assert.equal((await h.accounts.get(other.account.id)).banned,true);
  launchpad.locked=async(accountId,fn)=>{await h.accounts.setAdmin(owner.account.id,false);return fn(structuredClone(book));};
  assert.equal((await h.request(path,{auth,body})).code,403);assert.equal(saves,2);assert.equal(book.launches[0].moderation.hidden,false);
});

test('cashback destination HTTP changes are session scoped, CSRF protected, and require fresh manual password and MFA',async t=>{
  const h=await harness(t),auth=await h.user('cashback_http'),other=await h.user('cashback_other'),address=Keypair.generate().publicKey.toBase58(),path='/api/account/cashback-wallet';
  assert.equal((await h.request(path,{body:{address,password}})).code,401);
  assert.equal((await h.request(path,{auth,body:{address,password},headers:{'x-control-token':'wrong'}})).code,403);
  assert.equal((await h.request(path,{auth,body:{address,password},headers:{origin:'https://evil.invalid'}})).code,403);
  assert.equal((await h.request(path,{auth,body:{address}})).code,400);
  assert.equal((await h.request(path+'/challenge',{auth,body:{address}})).code,400);
  const saved=await h.request(path,{auth,body:{address,password,accountId:other.account.id}});assert.equal(saved.code,200);assert.equal(saved.body.account.id,auth.account.id);assert.equal(saved.body.account.cashbackWallet,address);assert.equal(saved.body.account.mainWallet,auth.account.mainWallet);assert.equal((await h.accounts.get(other.account.id)).cashbackWallet,other.account.mainWallet);
  const view=await h.request('/api/account',{auth});assert.equal(view.body.fees.cashbackWallet,address);assert.equal(view.body.fees.mainWallet,auth.account.mainWallet);
  let now=Date.now();h.accounts.now=()=>now;const enrollment=await h.accounts.beginMfa(auth.account.id,password);await h.accounts.enableMfa(auth.account.id,password,totp(enrollment.secret,now));const secured=await h.accounts.createSession(auth.account.id,{mfaVerified:true});
  assert.equal((await h.request(path,{auth,body:{address:auth.account.mainWallet,password}})).code,401);
  assert.equal((await h.request(path,{auth:secured,body:{address:auth.account.mainWallet,password}})).body.mfaRequired,true);
  now+=30000;const restored=await h.request(path,{auth:secured,body:{address:auth.account.mainWallet,password,code:totp(enrollment.secret,now)}});assert.equal(restored.code,200);assert.equal(restored.body.account.cashbackWallet,auth.account.mainWallet);
});
test('wallet cashback destination uses fresh signed proof without giving access to toolkit, key export or admin',async t=>{
  const {createPrivateKey,sign}=await import('node:crypto');const h=await harness(t),wallet=Keypair.generate(),address=Keypair.generate().publicKey.toBase58();
  const key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(wallet.secretKey.slice(0,32))]),format:'der',type:'pkcs8'}),signMessage=message=>sign(null,Buffer.from(message),key).toString('base64');
  const loginChallenge=await h.request('/api/wallet/challenge',{body:{address:wallet.publicKey.toBase58()},headers:{origin:h.base}});
  const login=await h.request('/api/wallet/verify',{body:{nonce:loginChallenge.body.nonce,signature:signMessage(loginChallenge.body.message)},headers:{origin:h.base,cookie:loginChallenge.headers.get('set-cookie').split(';')[0]}});assert.equal(login.code,200);
  const headers={cookie:login.headers.get('set-cookie').split(';')[0],'x-control-token':login.body.token},path='/api/account/cashback-wallet';
  assert.equal((await h.request(path+'/challenge',{body:{address},headers:{cookie:headers.cookie}})).code,403);
  assert.equal((await h.request(path,{body:{address,password},headers})).code,400);
  const challenge=await h.request(path+'/challenge',{body:{address},headers});assert.equal(challenge.code,200);assert(challenge.body.message.includes(address));
  const body={address,nonce:challenge.body.nonce,signature:signMessage(challenge.body.message)},saved=await h.request(path,{body,headers});assert.equal(saved.code,200);assert.equal(saved.body.account.cashbackWallet,address);assert.equal(saved.body.account.mainWallet,wallet.publicKey.toBase58());
  assert.equal((await h.request(path,{body,headers})).code,400);
  const profile=await h.request('/api/account',{headers});assert.equal(profile.body.fees.cashbackWallet,address);
  for(const forbidden of ['/api/settings','/api/account/export','/api/admin/revenue'])assert.equal((await h.request(forbidden,{headers,body:{}})).code,403,forbidden);
  assert.equal(await h.accounts.storeFor(saved.body.account.id).read('main-wallet',null),null);
});

test('verified wallet linking restores the existing MFA admin while preserving the original wallet account and password MFA',async t=>{
  const {createPrivateKey,sign}=await import('node:crypto');
  const h=await harness(t,{adminRevenue:{read:async id=>({accountId:id,products:[],totals:[]})}}),owner=await h.user('linked_owner'),wallet=Keypair.generate(),address=wallet.publicKey.toBase58();
  const key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(wallet.secretKey.slice(0,32))]),format:'der',type:'pkcs8'}),signature=message=>sign(null,Buffer.from(message),key).toString('base64');
  const connect=async(accountId)=>{const challenge=await h.request('/api/wallet/challenge',{body:{address,...(accountId?{accountId}:{})},headers:{origin:h.base}});assert.equal(challenge.code,200,JSON.stringify(challenge.body));const verified=await h.request('/api/wallet/verify',{body:{nonce:challenge.body.nonce,signature:signature(challenge.body.message)},headers:{origin:h.base,cookie:challenge.headers.get('set-cookie').split(';')[0]}});assert.equal(verified.code,200,JSON.stringify(verified.body));return{...verified,auth:{token:verified.headers.get('set-cookie').split(';')[0].slice('launchpad-session='.length),csrfToken:verified.body.token}};};
  let now=Date.now();h.accounts.now=()=>now;await h.accounts.setAdmin(owner.account.id);
  const enrollment=await h.accounts.beginMfa(owner.account.id,password);await h.accounts.enableMfa(owner.account.id,password,totp(enrollment.secret,now));
  const auth=await h.accounts.createSession(owner.account.id,{mfaVerified:true});now+=30000;
  assert.equal((await h.request('/api/account/cashback-wallet',{auth,body:{address,password,code:totp(enrollment.secret,now)}})).code,200);
  const original=await connect();assert.notEqual(original.body.account.id,owner.account.id);assert.equal(original.body.account.role,'user');
  const records={version:1,launches:[{id:'retained-launch',state:'draft'}]};await h.accounts.storeFor(original.body.account.id).write('launchpad',records);
  const path='/api/account/signin-wallet';now+=30000;
  assert.equal((await h.request(path+'/challenge',{auth,body:{address,password},headers:{'x-control-token':'wrong'}})).code,403);
  assert.equal((await h.request(path+'/challenge',{auth,body:{address,password}})).body.mfaRequired,true);
  const challenge=await h.request(path+'/challenge',{auth,body:{address,password,code:totp(enrollment.secret,now)}});assert.equal(challenge.code,200,JSON.stringify(challenge.body));
  const linked=await h.request(path,{auth,body:{nonce:challenge.body.nonce,signature:signature(challenge.body.message)}});assert.equal(linked.code,200,JSON.stringify(linked.body));
  assert.equal(linked.body.account.id,owner.account.id);assert.equal(linked.body.account.signInWallet,address);assert.equal(linked.body.account.mainWallet,owner.account.mainWallet);assert.equal(linked.body.account.cashbackWallet,address);assert.equal(linked.body.account.walletAccount.id,original.body.account.id);
  assert.equal((await h.request('/api/session',{auth:original.auth})).body.authenticated,false);
  const restored=await connect();assert.equal(restored.body.account.id,owner.account.id);assert.equal(restored.body.account.username,owner.account.username);assert.equal(restored.body.account.role,'admin');assert.equal(restored.body.account.mfaEnabled,true);
  const proof=await h.accounts.getSession(restored.auth.token);assert.equal(proof.walletVerified,true);assert.equal(proof.mfaVerified,false);assert.equal(proof.authMethod,'wallet');
  assert.equal((await h.request('/api/session',{auth:restored.auth})).body.monitorAllowed,true);assert.equal((await h.request('/api/admin/revenue',{auth:restored.auth})).code,200);
  const manual=await h.request('/api/account/login',{body:{username:owner.account.username,password}});assert.equal(manual.body.mfaRequired,true);
  const previous=await connect(original.body.account.id);assert.equal(previous.body.account.id,original.body.account.id);assert.equal(previous.body.account.role,'user');assert.equal((await h.request('/api/admin/revenue',{auth:previous.auth})).code,403);assert.deepEqual(await h.accounts.storeFor(original.body.account.id).read('launchpad'),records);
  const forged=await h.request('/api/wallet/challenge',{body:{address,accountId:owner.account.id},headers:{origin:h.base}});assert.equal(forged.code,400);
  now+=30000;const unlinked=await h.request(path+'/unlink',{auth:restored.auth,body:{password,code:totp(enrollment.secret,now)}});assert.equal(unlinked.code,200,JSON.stringify(unlinked.body));assert.ok(unlinked.body.token);assert.ok(unlinked.headers.get('set-cookie'));assert.equal(await h.accounts.getSession(restored.auth.token),null);
  const rotated={token:unlinked.headers.get('set-cookie').split(';')[0].slice('launchpad-session='.length),csrfToken:unlinked.body.token};assert.equal((await h.request('/api/admin/revenue',{auth:rotated})).code,200);assert.equal((await connect()).body.account.id,original.body.account.id);
});

test('wallet linking refuses cross-account and cross-origin mutations without changing account ownership',async t=>{
 const h=await harness(t),owner=await h.user('link_target'),other=await h.user('link_other'),address=Keypair.generate().publicKey.toBase58(),path='/api/account/signin-wallet';
 assert.equal((await h.request(path+'/challenge',{body:{address,password}})).code,401);
 assert.equal((await h.request(path+'/challenge',{auth:owner,body:{address,password},headers:{origin:'https://evil.invalid'}})).code,403);
 const challenge=await h.request(path+'/challenge',{auth:owner,body:{address,password,accountId:other.account.id}});assert.equal(challenge.code,200);assert(challenge.body.message.includes(owner.account.id));assert(!challenge.body.message.includes(other.account.id));
 assert.equal((await h.request(path,{auth:other,body:{nonce:challenge.body.nonce,signature:'A'.repeat(86)+'=='}})).code,400);
 assert.equal((await h.accounts.get(owner.account.id)).signInWallet,'');assert.equal((await h.accounts.get(other.account.id)).signInWallet,'');
});

test('inline launchpad trade routes enforce session, CSRF, method, and server-owned account identity',async t=>{
  const calls=[],trading=Object.fromEntries(['wallet','quote','prepare','submit','status','cancel'].map(action=>[action,async(id,body,context)=>{
    await context.authorize();calls.push({action,id,body,bound:!!context.sessionToken});return{action,ok:true};
  }]));
  const h=await harness(t,{trading}),user=await h.user('inline_trader'),other=await h.user('inline_other');
  for(const action of ['wallet','quote','prepare','submit','status','cancel']){
    const path='/api/launchpad/trading/'+action,body={accountId:other.account.id,mint:'fixture'};
    assert.equal((await h.request(path,{body})).code,401);
    assert.equal((await h.request(path,{auth:user,headers:{'x-control-token':'bad'},body})).code,403);
    assert.equal((await h.request(path,{auth:user})).code,405);
    assert.equal((await h.request(path,{auth:user,body,headers:{origin:'https://other.example'}})).code,403);
    assert.equal((await h.request(path,{auth:user,body})).code,200);
    assert.equal(calls.at(-1).id,user.account.id);assert.equal(calls.at(-1).bound,true);
  }
  assert.equal(calls.length,6);
  assert.equal((await h.request('/api/launchpad/trading/export',{auth:user,body:{}})).code,404);
  assert.equal((await h.request('/api/launchpad/trading/submit',{auth:user,body:{padding:'x'.repeat(17000)}})).code,413);
  for(const path of ['/coin-trade.mjs','/coin-trade.css'])assert.equal((await fetch(h.base+path)).status,200);
});

test('inline trade authorization detects a session revoked during an awaited request',async t=>{
  const entered=deferred(),resume=deferred();let authorized=false;
  const trading={submit:async(id,body,context)=>{entered.resolve();await resume.promise;await context.authorize();authorized=true;return{ok:true};}};
  const h=await harness(t,{trading}),user=await h.user('revoked_inline');
  const response=h.request('/api/launchpad/trading/submit',{auth:user,body:{confirm:true}});
  await entered.promise;await h.accounts.revokeSession(user.token);resume.resolve();
  assert.equal((await response).code,401);assert.equal(authorized,false);
});

test('wallet-authenticated accounts can trade inline without toolkit or admin access',async t=>{
  const {createPrivateKey,sign}=await import('node:crypto');let called=false;
  const h=await harness(t,{trading:{wallet:async(id,body,context)=>{await context.authorize();called=true;return{wallet:{mode:'external',address:body.wallet}};}}});
  const key=Keypair.generate(),wallet=key.publicKey.toBase58(),binding='b'.repeat(64),challenge=await h.accounts.walletChallenge(wallet,h.base,binding);
  const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),key.secretKey.slice(0,32)]),format:'der',type:'pkcs8'});
  const proof=await h.accounts.authenticateWallet({nonce:challenge.nonce,signature:sign(null,Buffer.from(challenge.message),privateKey).toString('base64')},h.base,binding);
  const auth=await h.accounts.createWalletSession(proof);
  const result=await h.request('/api/launchpad/trading/wallet',{auth,body:{mode:'external',wallet,mint:'fixture'}});
  assert.equal(result.code,200);assert.equal(called,true);assert.equal(result.body.wallet.address,wallet);
  assert.equal((await h.request('/api/settings',{auth})).code,403);
  assert.equal((await h.request('/api/admin/accounts',{auth})).code,403);
  assert.equal(await h.accounts.storeFor(proof.id).read('main-wallet',null),null);
});

test('protocol treasury read and signing controls require admin MFA, CSRF and fresh authentication',async t=>{
  const calls=[],lifecycle=[];
  const protocolTreasury={read:async id=>{calls.push(['read',id]);return{enabled:false,address:''};},configure:async(id,body)=>{calls.push(['configure',id,body]);return{enabled:body.enabled};},recognizeRevenue:async(id,body)=>{calls.push(['recognize',id,body]);return{accepted:true};},withdrawRetained:async(id,body)=>{calls.push(['withdraw',id,body]);return{queued:true};},start:()=>lifecycle.push('start'),close:()=>lifecycle.push('close')};
  const h=await harness(t,{protocolTreasury,launchpad:{book:async()=>({launches:[]})}}),owner=await h.user('treasury_operator'),path='/api/admin/protocol-treasury';
  const {launchpadApi}=await import('../src/product-mode.mjs');
  for(const suffix of ['', '/configure','/recognize','/withdraw'])assert.equal(launchpadApi(path+suffix),true);
  assert.equal(launchpadApi(path+'/export-key'),false);
  assert.equal((await h.request(path)).code,401);
  assert.equal((await h.request(path+'/configure',{body:{enabled:true}})).code,401);
  assert.equal((await h.request(path,{auth:owner})).code,403);
  await h.accounts.setAdmin(owner.account.id);
  assert.equal((await h.request(path,{auth:owner})).code,403);
  let now=Date.now();h.accounts.now=()=>now;
  const setup=await h.accounts.beginMfa(owner.account.id,password);
  await h.accounts.enableMfa(owner.account.id,password,totp(setup.secret,now));
  const auth=await h.accounts.createSession(owner.account.id,{mfaVerified:true});
  assert.equal((await h.request(path,{auth})).code,200);assert.deepEqual(calls,[['read',owner.account.id]]);
  assert.equal((await h.request(path+'/configure',{auth,headers:{'x-control-token':'wrong'},body:{enabled:true}})).code,403);
  assert.equal((await h.request(path+'/configure',{auth,body:{enabled:true,password:'wrong',code:'000000'}})).code,400);assert.equal(calls.length,1);
  for(const action of ['configure','recognize','withdraw']){
    now+=30000;
    const body={enabled:true,accountId:'b'.repeat(32),reason:'Explicit protocol treasury administration',password,code:totp(setup.secret,now)};
    assert.equal((await h.request(path+'/'+action,{auth,body})).code,200);
    assert.equal(calls.at(-1)[0],action);assert.equal(calls.at(-1)[1],owner.account.id);
  }
  const reauthenticate=h.accounts.reauthenticate.bind(h.accounts);h.accounts.reauthenticate=async(...args)=>{await reauthenticate(...args);await h.accounts.setAdmin(owner.account.id,false);};
  now+=30000;assert.equal((await h.request(path+'/withdraw',{auth,body:{password,code:totp(setup.secret,now)}})).code,403);assert.equal(calls.length,4);
  const asset=await fetch(h.base+'/admin-treasury-ui.mjs');assert.equal(asset.status,200);assert.match(asset.headers.get('content-type'),/javascript/);
  assert.deepEqual(lifecycle,['start']);await h.server.closeServices();assert.deepEqual(lifecycle,['start','close']);
});

test('recipient fee routes bind wallet proof, enforce CSRF and preserve ordinary launch ownership',async t=>{
  const {createPrivateKey,sign,randomUUID}=await import('node:crypto');
  const {Launchpad}=await import('../src/launchpad.mjs');
  const {newLaunchKeys}=await import('../src/launchpad-receipts.mjs');
  const {launchInput}=await import('../public/launchpad-model.mjs');
  let manager;const launchpad={book:(...args)=>manager.book(...args),locked:(...args)=>manager.locked(...args),save:(...args)=>manager.save(...args),read:(...args)=>manager.read(...args),action:(...args)=>manager.action(...args),known:new Set(),kick(){},close:()=>manager?.close()};
  const h=await harness(t,{launchpad}),owner=await h.user('assignmentoriginal'),wallet=Keypair.generate(),address=wallet.publicKey.toBase58(),launchId='9'.repeat(32);manager=new Launchpad(h.accounts,null);manager.kick=()=>{};
  const c=await h.request('/api/wallet/challenge',{body:{address},headers:{origin:h.base}});assert.equal(c.code,200);
  const signature=sign(null,Buffer.from(c.body.message),createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(wallet.secretKey.slice(0,32))]),format:'der',type:'pkcs8'})).toString('base64');
  const signed=await h.request('/api/wallet/verify',{body:{nonce:c.body.nonce,signature},headers:{origin:h.base,cookie:c.headers.get('set-cookie').split(';')[0]}});assert.equal(signed.code,200);
  const headers={cookie:signed.headers.get('set-cookie').split(';')[0],'x-control-token':signed.body.token};
  const launch={id:launchId,keys:{...newLaunchKeys(),payer:newLaunchKeys().wallet},input:launchInput({name:'Private fee assignment',symbol:'FEE',feeMode:'creator',recipient:address}),review:{minimumSol:'0.02',quoteDecimals:9},feeCustody:'relay',authorizedAt:Date.now(),createdAt:Date.now(),state:'live',curve:Keypair.generate().publicKey.toBase58(),credits:{quote:'0',base:'0'},operations:[],autoFees:false};
  await manager.save(owner.account.id,{version:1,launches:[launch]});
  const path='/api/launchpad/fee-assignments',claimPath=path+'/claim',body={ownerAccountId:owner.account.id,id:launchId,requestId:randomUUID()};
  assert.equal((await h.request(path)).code,401);assert.equal((await h.request(claimPath,{body})).code,401);
  assert.equal((await h.request(path,{headers:{cookie:headers.cookie}})).code,403);assert.equal((await h.request(claimPath,{body,headers:{...headers,'x-control-token':'wrong'}})).code,403);
  const passwordList=await h.request(path,{auth:owner});assert.equal(passwordList.code,200);assert.equal(passwordList.body.requiresWalletSignIn,true);assert.equal((await h.request(claimPath,{auth:owner,body})).code,403);
  const listed=await h.request(path,{headers});assert.equal(listed.code,200);assert.equal(listed.body.assignments.length,1);assert.equal(listed.body.assignments[0].creator.username,'assignmentoriginal');assert.doesNotMatch(JSON.stringify(listed.body),/secret|raw|review|privateKey/);
  assert.equal((await h.request(path,{headers,body:{}})).code,405);assert.equal((await h.request(claimPath,{headers})).code,405);
  const claimed=await h.request(claimPath,{headers,body:{...body,recipient:owner.account.mainWallet,wallet:owner.account.mainWallet}});assert.equal(claimed.code,200);assert.equal(claimed.body.assignment.recipient,address);
  assert.equal((await h.request(claimPath,{headers,body})).body.alreadyRequested,true);assert.equal((await manager.book(owner.account.id)).launches[0].recipientFeeClaims.length,1);
  const owned=await h.request('/api/launchpad',{headers});assert.equal(owned.code,200);assert.deepEqual(owned.body.launches,[]);
  const management=await h.request('/api/launchpad/action',{headers,body:{id:launchId,accountId:owner.account.id,action:'pause'}});assert.equal(management.code,400);assert.match(management.body.error,/not found in this account/);
  assert.equal((await h.request('/api/launchpad',{auth:owner})).body.launches[0].id,launchId);
  assert.equal((await h.request('/api/account/logout',{headers,body:{}})).code,200);assert.equal((await h.request(claimPath,{headers,body})).code,401);
});
