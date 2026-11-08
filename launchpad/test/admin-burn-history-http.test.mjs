import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createAccountApp } from '../src/account-app.mjs';
import { launchpadApi } from '../src/product-mode.mjs';

async function fixture(t) {
  let session={account:{id:'a'.repeat(32),role:'admin',mfaEnabled:true,authType:'password'},mfaVerified:true};
  let invalidations=0,reads=0,writes=0,reauth=0,beforeSave=()=>{},fail=false;
  const calls=[];
  const accounts={master:Buffer.alloc(32),hostStore:{read:async()=>null},list:async()=>[],registry:async()=>({accounts:[]}),
    getSession:async token=>token==='admin-session'?session:null,
    getSessionWithCsrf:async(token,csrf)=>({session:token==='admin-session'?session:null,csrfValid:csrf==='admin-csrf'}),
    reauthenticate:async(id,password,code)=>{reauth++;if(password!=='test-password'||code!=='123456')throw Object.assign(Error('Authentication failed.'),{statusCode:403});},
  };
  const service={read:async()=>{reads++;return {status:'available',history:[]};},add:async(id,body,{authorize})=>{
    calls.push({id,body});await beforeSave();await authorize();if(fail)throw Object.assign(Error('Transaction was not finalized.'),{statusCode:409});writes++;return {status:'available',history:[],added:1};
  }};
  const server=createAccountApp({accounts,runtimes:{},policy:{},publicUrl:'https://launch.example',launchpad:{},marketData:{},funding:{},protocolFees:{},protocolTreasury:{},branding:{},adminPanel:{},adminRevenue:{},explore:{},trading:{},adminVolume:{},lifetimeVolume:{},adminBurnHistory:service,publicAnalytics:{invalidate(){invalidations++;},read:async()=>({burns:{curveBurned:'123'}})}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await server.closeServices();});
  const request=(path='/api/admin/burn-history',{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
    const req=httpRequest({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{host:'launch.example','x-forwarded-proto':'https','x-forwarded-for':'192.0.2.9',origin:'https://launch.example',cookie:'launchpad-session=admin-session','x-control-token':'admin-csrf','content-type':'application/json',...headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const text=Buffer.concat(chunks).toString();resolve({status:res.statusCode,text,data:res.headers['content-type']?.includes('application/json')?JSON.parse(text):null});});res.on('error',reject);
    });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
  return {request,calls,setSession:value=>{session=value;},setBeforeSave:fn=>{beforeSave=fn;},setFail:value=>{fail=value;},get invalidations(){return invalidations;},get reads(){return reads;},get writes(){return writes;},get reauth(){return reauth;}};
}
const body={burnLink:'burn-signature',password:'test-password',code:'123456'};

test('burn import route is available in launchpad mode and protects admin data and writes',async t=>{
  assert.equal(launchpadApi('/api/admin/burn-history'),true);
  assert.equal(launchpadApi('/api/admin/burn-history/private'),false);
  const f=await fixture(t);
  assert.equal((await f.request()).status,200);
  for(const headers of [{cookie:''},{'x-control-token':'wrong'},{origin:'https://other.example'}]){
    assert.ok([401,403].includes((await f.request(undefined,{method:'POST',headers,body})).status));
  }
  f.setSession({account:{id:'a'.repeat(32),role:'user',mfaEnabled:true},mfaVerified:true});
  assert.equal((await f.request()).status,403);
  f.setSession({account:{id:'a'.repeat(32),role:'admin',mfaEnabled:true},mfaVerified:false});
  assert.equal((await f.request(undefined,{method:'POST',body})).status,403);
  assert.equal(f.writes,0);assert.equal(f.reauth,0);assert.equal(f.reads,1);
});

test('burn-only and optional buyback payloads use authenticated import and invalidate analytics',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request(undefined,{method:'POST',body})).status,200);
  assert.deepEqual(f.calls[0].body,{burnLink:body.burnLink,buybackLink:undefined});
  assert.equal((await f.request(undefined,{method:'POST',body:{...body,buybackLink:'buy-signature',solSpent:'999',rpcUrl:'https://untrusted.invalid'}})).status,200);
  assert.deepEqual(f.calls[1].body,{burnLink:body.burnLink,buybackLink:'buy-signature'});
  assert.equal(f.writes,2);assert.equal(f.reauth,2);assert.equal(f.invalidations,2);
});

test('failed authentication, failed receipt and revoked sessions cannot publish an import',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request(undefined,{method:'POST',body:{...body,code:'bad'}})).status,403);
  assert.equal(f.calls.length,0);
  f.setFail(true);assert.equal((await f.request(undefined,{method:'POST',body})).status,409);
  f.setFail(false);f.setBeforeSave(()=>f.setSession(null));
  assert.equal((await f.request(undefined,{method:'POST',body})).status,401);
  assert.equal(f.writes,0);assert.equal(f.invalidations,0);
});

test('import rejects unsupported methods, query parameters and oversized payloads before verification',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request(undefined,{method:'PUT',body})).status,405);
  assert.equal((await f.request('/api/admin/burn-history?force=1')).status,400);
  assert.equal((await f.request(undefined,{method:'POST',body:{...body,burnLink:'x'.repeat(9000)}})).status,413);
  assert.equal(f.writes,0);assert.equal(f.calls.length,0);assert.equal(f.reauth,0);
});

test('admin import module is served as JavaScript',async t=>{
  const f=await fixture(t),response=await f.request('/admin-burn-history-ui.mjs');
  assert.equal(response.status,200);assert.match(response.text,/createAdminBurnHistory/);
});
