import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountService } from '../src/accounts.mjs';
import { createAccountApp } from '../src/account-app.mjs';
import { totp } from '../src/totp.mjs';
import { publicStatus } from '../src/session-diagnostics.mjs';

test('owner sessions require role, MFA and CSRF; every user is visible but credentials never enter diagnostic exports', async t => {
  const dir = await mkdtemp(join(tmpdir(),'launchpad-session-test-')), accounts = await new AccountService(dir).init(), password = 'test-owner-password-24680';
  const owner=await accounts.register('owner_diagnostics',password), user=await accounts.register('trader_diagnostics',password), other=await accounts.register('another_trader',password);
  const status = { state:'running', runId:'active-web-and-telegram-run', metrics:{detectionToSendMs:42}, rpc:{requests:19}, positions:[],pending:[],events:[] };
  const runtimes={runtimes:new Map([[user.id,{lanes:new Map([['copy',{status:()=>status,runConfig:null}]])}]]),get:()=>{throw Error('Diagnostics must not start a runtime.');},view:async()=>status};
  const server=createAccountApp({accounts,runtimes,policy:{get:async()=>({})},features:{toolkit:true,telegram:true,walletOnly:false}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const call=async(path,auth,csrf=true)=>{const response=await fetch(base+path,{headers:auth?{cookie:`launchpad-session=${auth.token}`,...(csrf?{'x-control-token':auth.csrfToken}:{})}:{}});return {code:response.status,body:await response.json()};};
  const authUser=await accounts.createSession(user.id), authOwner=await accounts.createSession(owner.id);
  assert.equal((await call('/api/admin/sessions')).code,401);
  assert.equal((await call('/api/admin/sessions',authUser)).code,403);
  await accounts.setAdmin(owner.id,true);
  assert.equal((await call('/api/admin/sessions',authOwner)).code,403);
  const enrollment=await accounts.beginMfa(owner.id,password);await accounts.enableMfa(owner.id,password,totp(enrollment.secret));
  const admin=await accounts.createSession(owner.id,{mfaVerified:true});
  assert.equal((await call('/api/admin/sessions',admin,false)).code,403);
  const listed=await call('/api/admin/sessions',admin);assert.equal(listed.code,200);assert.equal(listed.body.total,3);assert(listed.body.users.some(row=>row.id===other.id));
  assert.equal(listed.body.users.find(row=>row.id===user.id).sessions.find(s=>s.chain==='solana'&&s.kind==='copy').state,'running');
  const store=accounts.storeFor(user.id), settings=await store.read('settings');
  settings.heliusKey='provider-credential-in-error';settings.rpcUrl='https://example.com/private-path?api-key=query-secret';await store.write('settings',settings);
  await store.write('live',{lots:[],pending:[{wallet:'public-wallet',signature:'public-signature',signed:'signed-transaction-secret',context:{privateKey:'hidden-context-key'}}],events:[{id:'e1',at:1234,level:'error',message:`RPC ${settings.rpcUrl} ${settings.heliusKey} ${settings.wallets[0].privateKey}`,privateKey:'hidden-field-key',timing:{routeMs:7,secret:'hidden-timing-secret'}}],secret:'hidden-top-key'});
  const path=`/api/admin/session?accountId=${user.id}&chain=solana&kind=copy&export=1`;
  assert.equal((await call(path,authUser)).code,403);
  const exported=await call(path,admin), raw=JSON.stringify(exported.body);assert.equal(exported.code,200);assert.equal(exported.body.account.username,user.username);assert.equal(exported.body.events[0].timing.routeMs,7);
  for(const secret of [settings.rpcUrl,settings.heliusKey,settings.wallets[0].privateKey,'query-secret','signed-transaction-secret','hidden-context-key','hidden-field-key','hidden-timing-secret','hidden-top-key'])assert(!raw.includes(secret),secret);
  const own=await call('/api/status',authUser);assert.equal(own.body.metrics,undefined);assert.equal(own.body.rpc,undefined);
  const forged=await call(`/api/trading-overview?chain=solana&accountId=${other.id}`,authUser);assert.equal(forged.body.sessions[0].account.id,user.id);
  assert.equal((await call('/api/session',admin)).body.monitorAllowed,true);assert.equal((await call('/api/session',authUser)).body.monitorAllowed,false);
  await accounts.setAdmin(owner.id,false);assert.equal((await call(path,admin)).code,403);
});

test('ordinary status responses strip nested monitor details and preserve essential connection/position state',()=>{
  const value={metrics:{detected:1},rpc:{requests:2},stream:{mode:'logs',secret:'internal'},events:[{message:'Bought',timing:{routeMs:3}}],views:{copy:{metrics:{fills:1},pending:[]}},positions:[{remaining:'123'}]};
  const result=publicStatus(value,false);assert(!JSON.stringify(result).includes('routeMs'));assert(!JSON.stringify(result).includes('metrics'));assert.deepEqual(result.positions,value.positions);assert.deepEqual(result.stream,{mode:'logs'});assert.equal(value.metrics.detected,1);
});
