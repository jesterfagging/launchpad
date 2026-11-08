import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AccountService} from '../src/accounts.mjs';
import {createAccountApp} from '../src/account-app.mjs';
import {PumpTestService} from '../src/pump-test-service.mjs';
import {totp} from '../src/totp.mjs';
import {launchpadApi} from '../src/product-mode.mjs';

const prefix='/api/admin/damm-pump-test/';
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-micro-http-')),accounts=await new AccountService(dir).init(),password='micro-http-only-123456';
  const registerAdmin=async name=>{const account=await accounts.register(name,password);await accounts.setAdmin(account.id);const mfa=await accounts.beginMfa(account.id,password);await accounts.enableMfa(account.id,password,totp(mfa.secret,Date.now()));return {account,session:await accounts.createSession(account.id,{mfaVerified:true})};};
  const owner=await registerAdmin('micro_owner'),otherAdmin=await registerAdmin('micro_other_admin'),user=await accounts.register('micro_user',password),other=await accounts.createSession(user.id),weak=await accounts.register('micro_weak_admin',password),calls=[];await accounts.setAdmin(weak.id);const noMfa=await accounts.createSession(weak.id);
  const service={start(){calls.push('test-start');},stop(){calls.push('test-stop');}};
  for(const name of ['ownerStatus','listAccount','operations'])service[name]=async(session,context)=>{await context.authorize();calls.push(name);return {privateSentinel:'owner-only',ok:true};};
  for(const name of ['prepare','submit','reconcile','cancel','wallet','setup','market'])service[name]=async(session,input,context)=>{await context.authorize();calls.push(name);return {ok:true};};
  const deployment={};for(const name of ['status','prepare','submit','reconcile'])deployment[name]=async(session,...args)=>{await args.at(-1).authorize();calls.push('deployment-'+name);return {ok:true};};deployment.configuration=deployment;
  const production={publicStatus:async()=>({available:true,defaults:{initialFdvUsd:20000,graduationFdvUsd:50000},pairs:[]}),publicList:async()=>[],start(){},stop(){}},explore={registryLoaded:true};
  const server=createAccountApp({dammPumpTest:service,dammPumpTestDeployment:deployment,dammPump:production,accounts,runtimes:{},policy:{},pumpTest:new PumpTestService({accounts,ownerId:owner.account.id}),launchpad:{},marketData:{},protocolFees:{},protocolTreasury:{},protocolGasFunding:{},branding:{},adminPanel:{},adminRevenue:{},adminRevenueAudit:{},explore,trading:{},adminVolume:{},lifetimeVolume:{},publicAnalytics:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await server.closeServices();await rm(dir,{recursive:true,force:true});});
  const request=async(path,{auth,body,method=body===undefined?'GET':'POST',headers={}}={})=>{const response=await fetch(base+path,{method,headers:{...(auth?{cookie:`launchpad-session=${auth.token}`,'x-control-token':auth.csrfToken}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}return {status:response.status,data,headers:response.headers};};
  return {accounts,owner:owner.session,otherAdmin:otherAdmin.session,other,noMfa,calls,service,explore,request};
}

test('every private launch and deployment route requires the current configured owner and MFA',async t=>{
  const h=await fixture(t),reads=['status','launches','operations','deployment/status','configuration/status'],writes=['setup','prepare','submit','reconcile','cancel','wallet','market','deployment/prepare','deployment/submit','deployment/reconcile','configuration/prepare','configuration/submit','configuration/reconcile'];
  for(const action of [...reads,...writes]){
    const body=writes.includes(action)?{}:undefined,path=prefix+action;assert.equal(launchpadApi(path),true);
    assert.equal((await h.request(path,{body})).status,401,action+' anonymous');
    for(const auth of [h.other,h.otherAdmin,h.noMfa])assert.equal((await h.request(path,{auth,body})).status,403,action+' unauthorized');
    assert.equal((await h.request(path,{auth:h.owner,body})).status,200,action+' owner');
  }
  assert(h.calls.includes('test-start'));assert(h.calls.includes('deployment-submit'));assert(h.calls.includes('market'));
});

test('private routes reject bad CSRF, methods, extra paths and query injection without changing public defaults',async t=>{
  const h=await fixture(t);
  for(const action of ['setup','prepare','submit','reconcile','cancel','wallet','market']){
    assert.equal((await h.request(prefix+action,{auth:h.owner,body:{},headers:{'x-control-token':'wrong'}})).status,403);
    assert.equal((await h.request(prefix+action,{auth:h.owner})).status,405);
  }
  assert.equal((await h.request(prefix+'status?rpcUrl=evil',{auth:h.owner})).status,400);assert.equal((await h.request(prefix+'prepare/extra',{auth:h.owner,body:{}})).status,404);assert.equal(launchpadApi(prefix+'prepare/extra'),false);
  const status=await h.request('/api/launchpad/damm-pump/status');assert.deepEqual(status.data.defaults,{initialFdvUsd:20000,graduationFdvUsd:50000});assert.equal(status.data.privateSentinel,undefined);
  assert.equal((await h.request('/admin-damm-pump-test-ui.mjs')).status,401);assert.equal((await h.request('/admin-damm-pump-test-ui.mjs',{auth:h.other})).status,403);const module=await h.request('/admin-damm-pump-test-ui.mjs',{auth:h.owner});assert.equal(module.status,200);assert.match(module.headers.get('cache-control'),/private, no-store/);
});

test('private finalized launches do not invalidate public discovery and revoked owners receive no late response',async t=>{
  const h=await fixture(t);h.service.reconcile=async()=>({operation:{action:'initialize',state:'finalized'}});await h.request(prefix+'reconcile',{auth:h.owner,body:{}});assert.equal(h.explore.registryLoaded,true);
  h.service.market=async()=>{await h.accounts.revokeSession(h.owner.token);return {privateSentinel:'must-not-return'};};const result=await h.request(prefix+'market',{auth:h.owner,body:{}});assert.equal(result.status,403);assert.doesNotMatch(JSON.stringify(result.data),/must-not-return/);
});
