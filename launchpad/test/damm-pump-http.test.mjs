import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {AccountService} from '../src/accounts.mjs';
import {createAccountApp} from '../src/account-app.mjs';
import {PumpTestService} from '../src/pump-test-service.mjs';
import {totp} from '../src/totp.mjs';
import {SharedRpcGate} from '../src/shared-rpc-gate.mjs';
import {DammPumpService,DAMM_PUMP_SOL} from '../src/damm-pump-service.mjs';

async function httpFixture(t,{moderation=false}={}){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-public-pump-http-')),accounts=await new AccountService(dir).init(),password='public-pump-http-only-123';
  const ownerAccount=await accounts.register('pump_owner',password);await accounts.setAdmin(ownerAccount.id);const mfa=await accounts.beginMfa(ownerAccount.id,password);await accounts.enableMfa(ownerAccount.id,password,totp(mfa.secret,Date.now()));
  const owner=await accounts.createSession(ownerAccount.id,{mfaVerified:true}),otherAccount=await accounts.register('pump_other',password),other=await accounts.createSession(otherAccount.id),calls=[];
  const service=moderation?new DammPumpService({accounts,adapter:{}}):{publicStatus:async()=>({available:true,publicEnabled:true,pairs:[{mint:'So11111111111111111111111111111111111111112',symbol:'SOL',launchReady:true}]})};
  service.start=()=>{calls.push('start');};service.stop=()=>{calls.push('stop');};
  for(const name of ['listAccount','operations','ownerStatus'])service[name]=async(session,context)=>{await context.authorize();calls.push(name);return {ok:true};};
  for(const name of ['prepare','submit','reconcile','cancel','wallet','setup','setEnabled','claimFees'])service[name]=async(session,input,context)=>{await context.authorize();calls.push(name);return {ok:true};};
  const publicDeployment={};for(const name of ['status','prepare','submit','reconcile'])publicDeployment[name]=async(session,...args)=>{await args.at(-1).authorize();calls.push('deployment-'+name);return {ok:true};};publicDeployment.configuration=publicDeployment;
  const explore={registryLoaded:true};
  const server=createAccountApp({dammPumpDeployment:publicDeployment,accounts,runtimes:{},policy:{},dammPump:service,pumpTest:new PumpTestService({accounts,ownerId:ownerAccount.id}),launchpad:{book:async()=>({launches:[]})},marketData:{},protocolFees:{},protocolTreasury:{},protocolGasFunding:{},branding:{},adminPanel:{},adminRevenue:{},adminRevenueAudit:{},explore,trading:{},adminVolume:{},lifetimeVolume:{},publicAnalytics:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await server.closeServices();await rm(dir,{recursive:true,force:true});});
  async function request(path,{auth,body,method=body===undefined?'GET':'POST',headers={}}={}){const response=await fetch(base+path,{method,headers:{...(auth?{cookie:`launchpad-session=${auth.token}`,'x-control-token':auth.csrfToken}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,headers:response.headers,body:await response.json()};}
  return {accounts,owner,other,ownerAccount,otherAccount,request,calls,service,explore};
}

test('DAMM administrator inventory UUID routes to its own hide and restore service with exact owner and mint checks',async t=>{
  const h=await httpFixture(t,{moderation:true}),key=()=>Keypair.generate().publicKey.toBase58(),launch={id:randomUUID(),mint:key(),creatorId:h.otherAccount.id,creatorWallet:key(),name:'CrashBandicootWumpaWhipCoin',symbol:'COIN',status:'trading',createdAt:Date.now(),quoteMint:DAMM_PUMP_SOL,quoteSymbol:'SOL',quoteDecimals:9,publicProgramId:key(),custodyAuthority:key()};
  const data={schemaVersion:1,config:null,relayer:{secretBase64:'PRIVATE_TEST_SENTINEL'},launches:[launch],operations:[{mint:launch.mint,action:'initialize',state:'finalized',signedTransaction:'PRIVATE_SAVED_WIRE'}]};await h.service.save(data);
  const listed=await h.request('/api/admin/launches',{auth:h.owner});assert.equal(listed.status,200);assert.equal(listed.body.launches.length,1);
  const row=listed.body.launches[0];assert.equal(row.route,'damm-pump');assert.equal(row.id,launch.id);assert.equal(row.mint,launch.mint);assert.equal(row.accountId,h.otherAccount.id);assert.doesNotMatch(JSON.stringify(listed.body),/PRIVATE_|signedTransaction|secretBase64/);
  const path='/api/admin/moderation/launch',body={route:row.route,accountId:row.accountId,id:row.id,mint:row.mint,hidden:true,reason:'Administrator hid this test coin from public lists.'};
  assert.equal((await h.request(path,{auth:h.other,body})).status,403);
  assert.equal((await h.request(path,{auth:h.owner,body,headers:{'x-control-token':'wrong'}})).status,403);
  for(const extra of [{accountId:h.ownerAccount.id},{id:randomUUID()},{mint:key()}])assert.equal((await h.request(path,{auth:h.owner,body:{...body,...extra}})).status,404);
  const {route,mint,...unrouted}=body,legacy=await h.request(path,{auth:h.owner,body:unrouted});assert.equal(legacy.status,400);assert.match(legacy.body.error,/Invalid account or launch ID/);
  assert.deepEqual(await h.service.load(),data);
  const hidden=await h.request(path,{auth:h.owner,body});assert.equal(hidden.status,200);assert.deepEqual(hidden.body,{route:'damm-pump',id:launch.id,mint:launch.mint,hidden:true});assert.equal(h.explore.registryLoaded,false);
  assert.equal((await h.service.publicList()).length,0);assert.equal((await h.request('/api/admin/launches?view=archived',{auth:h.owner})).body.launches[0].route,'damm-pump');
  const shown=await h.request(path,{auth:h.owner,body:{...body,hidden:false}});assert.equal(shown.status,200);assert.equal(shown.body.hidden,false);assert.equal((await h.service.publicList()).length,1);
  const after=await h.service.load();assert.deepEqual(after.operations,data.operations);assert.deepEqual(after.relayer,data.relayer);assert.equal(after.launches[0].moderationHistory.length,2);assert(after.launches[0].moderationHistory.every(event=>event.actorId===h.ownerAccount.id));
});

test('DAMM public launch routes require current authentication and CSRF for mutations, without an owner gate',async t=>{
  const h=await httpFixture(t);
  for(const action of ['status','pairs']) {const r=await h.request('/api/launchpad/damm-pump/'+action);assert.equal(r.status,200);assert.equal(r.body.publicEnabled,true);assert.equal(r.body.pairs.length,1);}
  for(const action of ['prepare','submit','reconcile','cancel','wallet']) {
    const path='/api/launchpad/damm-pump/'+action;
    assert.equal((await h.request(path,{body:{}})).status,401);
    assert.equal((await h.request(path,{auth:h.other,body:{},headers:{'x-control-token':'wrong'}})).status,403);
    assert.equal((await h.request(path,{auth:h.other})).status,405);
    assert.equal((await h.request(path,{auth:h.other,body:{}})).status,200);
  }
  for(const action of ['launches','operations'])assert.equal((await h.request('/api/launchpad/damm-pump/'+action,{auth:h.other})).status,200);
  assert.equal((await h.request('/api/launchpad/damm-pump/submit?rpcUrl=evil',{auth:h.other,body:{}})).status,400);
});
test('DAMM deployment and configuration are protected by owner and MFA, with exact routes',async t=>{
  const h=await httpFixture(t);
  for(const path of ['/api/admin/damm-pump/status','/api/admin/damm-pump/deployment/status','/api/admin/damm-pump/configuration/status']) {
    assert.equal((await h.request(path)).status,401);assert.equal((await h.request(path,{auth:h.other})).status,403);assert.equal((await h.request(path,{auth:h.owner})).status,200);
  }
  for(const action of ['setup','claim-fees','deployment/prepare','deployment/submit','deployment/reconcile','configuration/prepare','configuration/submit','configuration/reconcile']) {
    const path='/api/admin/damm-pump/'+action;assert.equal((await h.request(path,{auth:h.other,body:{}})).status,403);assert.equal((await h.request(path,{auth:h.owner,body:{}})).status,200);
  }
  assert(h.calls.includes('start'));assert(h.calls.includes('deployment-submit'));
});
test('DAMM route rechecks session after async work and invalidates discovery only for verified initialization',async t=>{
  const h=await httpFixture(t);h.service.reconcile=async()=>({operation:{action:'configure',state:'finalized'}});
  await h.request('/api/launchpad/damm-pump/reconcile',{auth:h.other,body:{}});assert.equal(h.explore.registryLoaded,true);
  h.service.reconcile=async()=>({operation:{action:'initialize',state:'finalized'}});
  await h.request('/api/launchpad/damm-pump/reconcile',{auth:h.other,body:{}});assert.equal(h.explore.registryLoaded,false);
  h.service.prepare=async()=>{await h.accounts.revokeSession(h.other.token);return {secretResult:'never-return'};};
  const response=await h.request('/api/launchpad/damm-pump/prepare',{auth:h.other,body:{}});assert.equal(response.status,401);assert.doesNotMatch(JSON.stringify(response.body),/never-return/);
});

test('DAMM HTTP preserves scheduler capacity and cooldown as temporary failures with bounded retry advice',async t=>{
 const h=await httpFixture(t),gate=new SharedRpcGate();t.after(()=>gate.close());
 h.service.reconcile=()=>gate.acquire('capacity','launch',1,{maxQueue:0});
 const capacity=await h.request('/api/launchpad/damm-pump/reconcile',{auth:h.other,body:{}});assert.equal(capacity.status,503);assert.equal(capacity.body.code,'DAMM_RPC_BUSY');assert.equal(capacity.body.retryAfterMs,1000);assert.equal(capacity.headers.get('retry-after'),'1');
 gate.cooldown('cooling',30000);h.service.reconcile=()=>gate.acquire('cooling','launch',1);
 const cooling=await h.request('/api/launchpad/damm-pump/reconcile',{auth:h.other,body:{}});assert.equal(cooling.status,429);assert.equal(cooling.body.code,'DAMM_RPC_BUSY');assert(cooling.body.retryAfterMs>0&&cooling.body.retryAfterMs<=30000);
 h.service.reconcile=()=>{throw Object.assign(Error('Capacity busy'),{retryable:true,capacityLimited:true,retryAfterMs:900000});};
 const bounded=await h.request('/api/launchpad/damm-pump/reconcile',{auth:h.other,body:{}});assert.equal(bounded.body.retryAfterMs,300000);assert.equal(bounded.headers.get('retry-after'),'300');
});
test('DAMM HTTP exposes only recognized temporary codes and keeps validation and signature rejections hard',async t=>{
 const h=await httpFixture(t);
 for(const code of ['DAMM_VENUE_RPC','SOL_ROUTE_RATE_LIMITED','SOL_ROUTE_PROVIDER_UNAVAILABLE','SOL_ROUTE_NETWORK','SOL_ROUTE_TIMEOUT','SOL_ROUTE_NOT_FOUND']){
  h.service.reconcile=()=>{throw Object.assign(Error('Temporary provider failure'),{code,statusCode:503,...(code==='SOL_ROUTE_RATE_LIMITED'?{rateLimited:true}:{})});};
  const result=await h.request('/api/launchpad/damm-pump/reconcile',{auth:h.other,body:{}});assert.equal(result.status,code==='SOL_ROUTE_RATE_LIMITED'?429:503);assert.equal(result.body.code,code);
 }
 for(const [code,statusCode]of [['DAMM_SIMULATION',400],['SOL_ROUTE_AUTH',503],['PRIVATE_INTERNAL_CODE',400],['WALLET_TRANSACTION_REJECTED',400]]){
  h.service.reconcile=()=>{throw Object.assign(Error('Original rejection remains visible'),{code,statusCode,retryable:true,capacityLimited:true});};
  const result=await h.request('/api/launchpad/damm-pump/reconcile',{auth:h.other,body:{}});assert.equal(result.status,statusCode);assert.equal(result.body.error,'Original rejection remains visible');assert.equal(result.body.code,code==='WALLET_TRANSACTION_REJECTED'?code:undefined);
 }
 h.service.reconcile=()=>{throw Object.assign(Error('Invalid launch input'),{statusCode:400,retryable:true,capacityLimited:true});};
 const invalid=await h.request('/api/launchpad/damm-pump/reconcile',{auth:h.other,body:{}});assert.equal(invalid.status,400);assert.equal(invalid.body.code,undefined);
});
