import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createAccountApp } from '../src/account-app.mjs';

const id='a'.repeat(32),otherId='b'.repeat(32),path='/api/admin/protocol-gas-funding';
async function fixture(t){
  const admin={id,role:'admin',mfaEnabled:true,authType:'password'},other={...admin,id:otherId};
  let session={account:admin,mfaVerified:true},readHook=async()=>{},authHook=async()=>{},closeHook=async()=>{};
  const calls={read:[],configure:[],auth:[],start:0,close:0};
  const accounts={master:Buffer.alloc(32),list:async()=>[admin,other],get:async x=>x===id?admin:other,hostStore:{read:async()=>null},storeFor:()=>({read:async()=>({launches:[]})}),registry:async()=>({accounts:[admin,other]}),
    getSessionWithCsrf:async(token,csrf)=>({session:token==='valid'?session:null,csrfValid:csrf==='csrf'}),getSession:async token=>token==='valid'?session:null,
    reauthenticate:async(actor,password,code)=>{calls.auth.push({actor,password,code});if(password!=='password'||code!=='123456')throw Object.assign(Error('Fresh authentication required.'),{statusCode:403});await authHook();}};
  const gas={read:async actor=>{calls.read.push(actor);await readHook();return {configured:true,enabled:false,address:'public-address'};},
    configure:async(actor,body)=>{calls.configure.push({actor,body});return {enabled:body.enabled};},
    start(){calls.start++;},async close(){calls.close++;await closeHook();}};
  const volume={},lifetime={};
  const pairs={read:async()=>({revision:0,assets:[]}),previewMint:async(actor,body)=>{calls.pairCheck={actor,body};return {mint:body.mint,supported:false,supportReason:'Coming soon'};},save:async(actor,body)=>{calls.pairSave={actor,body};return {revision:1};}};
  const launchpad={customPairs:pairs,quotes:async()=>({assets:[{mint:'available',supported:true},{mint:'waiting',supported:false},{mint:'unknown',supported:null}]})};
  const server=createAccountApp({accounts,runtimes:{},policy:{},launchpad,marketData:{},protocolFees:{},protocolTreasury:{},protocolGasFunding:gas,
    branding:{},adminPanel:{},adminRevenue:{},explore:{},trading:{},adminVolume:volume,lifetimeVolume:lifetime});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await server.closeServices();});
  const headers={cookie:'launchpad-session=valid','x-control-token':'csrf','content-type':'application/json'};
  const request=(url=path,{method='GET',headers:extra=headers,body}={})=>new Promise((resolve,reject)=>{
    const req=httpRequest({hostname:'127.0.0.1',port:server.address().port,path:url,method,headers:extra},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(chunks).toString()}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
  return {request,headers,calls,server,admin,other,volume,lifetime,pairs,accounts,launchpad,set session(v){session=v;},set readHook(v){readHook=v;},set authHook(v){authHook=v;},set closeHook(v){closeHook=v;}};
}

test('gas funding report requires administrator MFA and CSRF and never accepts actor overrides',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request(path,{headers:{}})).status,401);
  assert.equal((await f.request(path,{headers:{cookie:f.headers.cookie}})).status,403);
  f.session={account:{...f.admin,role:'user'},mfaVerified:true};assert.equal((await f.request()).status,403);
  f.session={account:f.admin,mfaVerified:false};assert.equal((await f.request()).status,403);
  assert.deepEqual(f.calls.read,[]);
  f.session={account:f.admin,mfaVerified:true};const ok=await f.request(path+'?accountId='+otherId+'&wallet=override');
  assert.equal(ok.status,200);assert.equal(ok.headers['cache-control'],'no-store');assert.deepEqual(f.calls.read,[id]);
  assert.equal((await f.request(path,{method:'DELETE'})).status,405);
});

test('gas funding report suppresses results if session changes during read',async t=>{
  const f=await fixture(t);f.readHook=async()=>{f.session={account:f.other,mfaVerified:true};};
  const result=await f.request();assert.equal(result.status,401);assert.doesNotMatch(result.text,/public-address/);
});

test('gas funding configure uses fresh authentication and allowlisted settings only',async t=>{
  const f=await fixture(t),url=path+'/configure',body={enabled:true,expectedAddress:'reviewed-address',reason:'Enable bounded refills'};
  assert.equal((await f.request(url,{method:'POST',body})).status,403);assert.equal(f.calls.configure.length,0);
  const result=await f.request(url,{method:'POST',body:{...body,password:'password',code:'123456',accountId:otherId,secretKey:'must-not-forward',recipient:'override',amount:'999',dailyLimit:'999'}});
  assert.equal(result.status,200);assert.deepEqual(f.calls.configure,[{actor:id,body}]);
  assert.equal((await f.request(path+'/install-signer',{method:'POST',body:{password:'password',code:'123456',secretKey:'never-import-over-http'}})).status,404);
  assert.equal(f.calls.configure.length,1);
});

test('gas funding configuration rejects session switch during reauthentication',async t=>{
  const f=await fixture(t);f.authHook=async()=>{f.session={account:f.other,mfaVerified:true};};
  const result=await f.request(path+'/configure',{method:'POST',body:{enabled:true,password:'password',code:'123456'}});
  assert.equal(result.status,401);assert.equal(f.calls.configure.length,0);
});

test('gas funding starts once and shutdown drains the service before resolving',async t=>{
  const f=await fixture(t);assert.equal(f.calls.start,1);assert.equal(f.volume.lifetime,f.lifetime);
  let release,closed=false;f.closeHook=()=>new Promise(resolve=>{release=resolve;});
  const first=f.server.closeServices(),second=f.server.closeServices();assert.equal(first,second);
  first.then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);assert.equal(f.calls.close,1);
  release();await first;assert.equal(closed,true);
});

test('gas funding browser module is served without authentication and contains no private signer setup field',async t=>{
  const f=await fixture(t),result=await f.request('/admin-gas-ui.mjs',{headers:{}});
  assert.equal(result.status,200);assert.match(result.headers['content-type'],/javascript/);assert.match(result.text,/setup-gas-wallet/);
});

test('custom pair verification is admin-only read work and saving requires fresh MFA with an allowlisted payload',async t=>{
  const f=await fixture(t),base='/api/admin/pairs';
  assert.equal((await f.request(base,{headers:{}})).status,401);
  f.session={account:{...f.admin,role:'user'},mfaVerified:true};assert.equal((await f.request(base)).status,403);
  f.session={account:f.admin,mfaVerified:true};assert.equal((await f.request(base)).status,200);
  const check=await f.request(base+'/check',{method:'POST',body:{mint:'reviewed-mint',rpcUrl:'https://untrusted.example',accountId:otherId}});
  assert.equal(check.status,200);assert.deepEqual(f.calls.pairCheck,{actor:id,body:{mint:'reviewed-mint'}});assert.equal(f.calls.auth.length,0);
  assert.equal((await f.request(base+'/save',{method:'POST',body:{}})).status,403);assert.equal(f.calls.pairSave,undefined);
  const payload={revision:0,name:'Token',ticker:'TOKEN',mint:'reviewed-mint',image:'validated-by-service'};
  assert.equal((await f.request(base+'/save',{method:'POST',body:{...payload,password:'password',code:'123456',supported:true,logoPath:'/etc/passwd',accountId:otherId}})).status,200);
  assert.deepEqual(f.calls.pairSave,{actor:id,body:payload});
});

test('custom pair check cannot return private results to a switched session',async t=>{
  const f=await fixture(t);f.pairs.previewMint=async()=>{f.session={account:f.other,mfaVerified:true};return {privateResult:'not-for-current-user'};};
  const result=await f.request('/api/admin/pairs/check',{method:'POST',body:{mint:'mint'}});assert.equal(result.status,401);assert.doesNotMatch(result.text,/not-for-current-user/);
});

test('Coming Soon quotes are visible only to an authenticated administrator with MFA',async t=>{
  const f=await fixture(t),url='/api/launchpad/quotes';
  assert.equal((await f.request(url,{headers:{}})).status,401);
  f.session={account:{...f.admin,role:'user'},mfaVerified:true};
  const publicResult=JSON.parse((await f.request(url+'?canViewComingSoon=true')).text);
  assert.equal(publicResult.canViewComingSoon,false);
  assert.deepEqual(publicResult.assets,[{mint:'available',supported:true}]);
  f.session={account:f.admin,mfaVerified:false};
  const withoutMfa=JSON.parse((await f.request(url)).text);
  assert.equal(withoutMfa.canViewComingSoon,false);assert.equal(withoutMfa.assets.length,1);
  f.session={account:f.admin,mfaVerified:true};
  const adminResult=JSON.parse((await f.request(url)).text);
  assert.equal(adminResult.canViewComingSoon,true);assert.equal(adminResult.assets.length,3);
});

test('quote visibility rechecks the current session after availability work completes',async t=>{
  const f=await fixture(t),url='/api/launchpad/quotes',quotes=f.launchpad.quotes;
  f.launchpad.quotes=async()=>{f.session={account:{...f.admin,role:'user'},mfaVerified:true};return quotes();};
  const downgraded=JSON.parse((await f.request(url)).text);
  assert.equal(downgraded.canViewComingSoon,false);assert.equal(downgraded.assets.length,1);
  f.session={account:f.admin,mfaVerified:true};
  f.launchpad.quotes=async()=>{f.session={account:f.other,mfaVerified:true};return quotes();};
  const switched=await f.request(url);assert.equal(switched.status,401);assert.doesNotMatch(switched.text,/waiting/);
});

test('reward diagnostics are protected read-only reports and recheck identity after the scan',async t=>{
  const f=await fixture(t),url='/api/admin/reward-diagnostics';
  assert.equal((await f.request(url,{headers:{}})).status,401);
  assert.equal((await f.request(url,{method:'POST',body:{}})).status,405);
  const response=await f.request(url);assert.equal(response.status,200);assert.equal(response.headers['cache-control'],'no-store');assert.equal(JSON.parse(response.text).holderLaunches,0);
  assert.doesNotMatch(response.text,new RegExp(id+'|'+otherId));
  f.session={account:{...f.admin,mfaEnabled:false},mfaVerified:true};assert.equal((await f.request(url)).status,403);
});
