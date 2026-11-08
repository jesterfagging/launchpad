import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createAdminMeteora } from '../public/admin-meteora-ui.mjs';

const OWNER={id:'owner',role:'admin',mfaEnabled:true},WALLET='So11111111111111111111111111111111111111112';
const status=(patch={})=>({configured:true,publicEnabled:false,canEnable:true,authority:WALLET,treasury:'11111111111111111111111111111111',balanceLamports:'120000000',minimumBalanceLamports:'100000000',pairSummary:{available:432,complete:true},blockers:[],...patch});
function page({account=OWNER,respond=async()=>status()}={}){
  const {document}=parseHTML('<html><body></body></html>');Object.defineProperty(document,'hidden',{value:false,writable:true});const calls=[];let active=true;
  const ui=createAdminMeteora({document,getAccount:()=>account,isActive:()=>active,api:async(path,body)=>{calls.push({path,body});return respond(path,body);}});document.body.append(ui.element);
  return {ui,document,calls,get:id=>document.getElementById(id),account:value=>{account=value;},active:value=>{active=value;}};
}

test('Meteora controls require an active authenticated owner-supplied admin identity with MFA',async()=>{
  for(const account of [null,{}, {...OWNER,id:''},{...OWNER,role:'user'},{...OWNER,mfaEnabled:false},{...OWNER,banned:true}]){
    const p=page({account});await p.ui.load();await p.get('admin-meteora-setup').onclick();assert.equal(p.calls.length,0);assert.equal(p.ui.element.hidden,true);p.ui.destroy();
  }
  const p=page();p.active(false);await p.ui.load();assert.equal(p.calls.length,0);p.active(true);p.document.hidden=true;await p.ui.load();assert.equal(p.calls.length,0);p.ui.destroy();
});

test('status shows exact gas reserve, current treasury and catalogue readiness before enabling',async()=>{
  const p=page();await p.ui.load();assert.deepEqual(p.calls,[{path:'/api/admin/meteora/status',body:undefined}]);
  assert.equal(p.ui.element.hidden,false);assert.match(p.get('admin-meteora-facts').textContent,/Gas balance0\.12 SOL/);assert.match(p.get('admin-meteora-facts').textContent,/Minimum gas reserve0\.1 SOL/);assert.match(p.get('admin-meteora-facts').textContent,/Available pairs432/);
  assert.equal(p.get('admin-meteora-enable').disabled,false);assert.equal(p.get('admin-meteora-setup').hidden,true);assert.equal(p.get('admin-meteora-copy').hidden,false);p.ui.destroy();
});

test('setup does not open public launches and configure uses only the selected boolean',async()=>{
  let saved=status({configured:false,canEnable:false,authority:null,balanceLamports:null});const p=page({respond:async(path,body)=>{
    if(path.endsWith('/setup')){saved=status();return {configured:true};}
    if(path.endsWith('/configure')){saved=status({publicEnabled:body.enabled});return {publicEnabled:body.enabled};}
    return saved;
  }});
  await p.ui.load();assert.equal(p.get('admin-meteora-setup').disabled,false);assert.equal(p.get('admin-meteora-enable').disabled,true);await p.get('admin-meteora-enable').onclick();assert.equal(p.calls.length,1);
  await p.get('admin-meteora-setup').onclick();assert.deepEqual(p.calls[1],{path:'/api/admin/meteora/setup',body:{}});assert.equal(p.get('admin-meteora-pause').hidden,true);
  await p.get('admin-meteora-enable').onclick();await p.get('admin-meteora-confirm').onclick();assert.equal(p.get('admin-meteora-pause').hidden,false);assert.match(p.get('admin-meteora-status').textContent,/open for new launches/);
  await p.get('admin-meteora-pause').onclick();await p.get('admin-meteora-confirm').onclick();assert.deepEqual(p.calls.filter(c=>c.path.endsWith('/configure')).map(c=>c.body),[{enabled:true},{enabled:false}]);p.ui.destroy();
});

test('a incomplete catalogue, zero eligible pairs, unknown counts or server blockers cannot enable through a disabled handler',async()=>{
  for(const patch of [{canEnable:false,blockers:['Gas wallet needs SOL.']},{pairSummary:{available:3,complete:false}},{pairSummary:{available:0,complete:true}},{pairSummary:{complete:true}},{pairSummary:null}]){
    const p=page({respond:async()=>status(patch)});await p.ui.load();assert.equal(p.get('admin-meteora-enable').disabled,true);await p.get('admin-meteora-enable').onclick();assert.equal(p.calls.length,1);p.ui.destroy();
  }
});

test('an enabled mode waiting for gas or RPC checks still exposes its pause control',async()=>{
  const p=page({respond:async(path,body)=>status({launchesEnabled:body?body.enabled:true,publicEnabled:false,canEnable:false,blockers:['The gas wallet needs SOL.']})});await p.ui.load();assert.equal(p.get('admin-meteora-pause').hidden,false);assert.equal(p.get('admin-meteora-pause').disabled,false);assert.match(p.ui.element.textContent,/Enabled; waiting for checks/);
  await p.get('admin-meteora-pause').onclick();await p.get('admin-meteora-confirm').onclick();assert.deepEqual(p.calls[1],{path:'/api/admin/meteora/configure',body:{enabled:false}});p.ui.destroy();
});

test('failed refresh revokes stale enablement and never displays raw provider payloads',async()=>{
  let fail=false;const p=page({respond:async()=>{if(fail)throw Error('https://private-provider/?api-key=secret');return status();}});await p.ui.load();assert.equal(p.get('admin-meteora-enable').disabled,false);fail=true;await p.ui.load();assert.equal(p.get('admin-meteora-enable').disabled,true);assert.doesNotMatch(p.ui.element.textContent,/api-key|secret/);await p.get('admin-meteora-enable').onclick();assert.equal(p.calls.length,2);p.ui.destroy();
});

test('account changes during reads clear private facts and late responses cannot restore cleared or destroyed panels',async()=>{
  for(const change of ['account','clear','destroy']){
    let finish;const p=page({respond:()=>new Promise(resolve=>{finish=resolve;})}),pending=p.ui.load();
    if(change==='account')p.account({...OWNER,id:'another'});else p.ui[change]();finish(status());await pending;
    assert.equal(p.ui.element.hidden,true);assert.doesNotMatch(p.ui.element.textContent,/0\.12 SOL|Available pairs432/);p.ui.destroy();
  }
});

test('changing account before a mutation blocks it and a late save cannot trigger another private read',async()=>{
  let finish,writing=false;const p=page({respond:async(path,body)=>{if(body){writing=true;return new Promise(resolve=>{finish=resolve;});}return status();}});await p.ui.load();
  p.account({...OWNER,id:'another'});await p.get('admin-meteora-enable').onclick();assert.equal(p.calls.length,1);p.account(OWNER);
  p.get('admin-meteora-enable').onclick();const save=p.get('admin-meteora-confirm').onclick();assert.equal(writing,true);p.ui.clear();finish({publicEnabled:true});await save;assert.equal(p.calls.length,2);assert.equal(p.ui.element.hidden,true);p.ui.destroy();
});

test('pause discards a late status read, and resume requires a fresh readiness result',async()=>{
  let finish,wait=false;const p=page({respond:async()=>wait?new Promise(resolve=>{finish=resolve;}):status()});await p.ui.load();wait=true;const read=p.ui.load();p.active(false);p.ui.pause();finish(status({balanceLamports:'900000000'}));await read;assert.equal(p.ui.element.hidden,true);assert.doesNotMatch(p.ui.element.textContent,/0\.9 SOL/);
  p.active(true);wait=false;await p.ui.load();assert.match(p.ui.element.textContent,/Gas balance0\.12 SOL/);assert.equal(p.get('admin-meteora-enable').disabled,false);p.ui.destroy();
});

test('untrusted display values stay inert and malformed balances remain unknown',async()=>{
  const p=page({respond:async()=>status({authority:'javascript:bad()',balanceLamports:'-1',minimumBalanceLamports:'9'.repeat(1000),treasury:'<img src=x onerror=bad()>',blockers:['<script>bad()</script>']})});await p.ui.load();assert.equal(p.ui.element.querySelector('img,script'),null);assert.match(p.ui.element.textContent,/Gas balance—/);assert.match(p.ui.element.textContent,/Minimum gas reserve—/);assert.equal(p.get('admin-meteora-copy').hidden,true);p.ui.destroy();
});

test('opening or pausing launches needs a confirming click, and Cancel sends nothing',async()=>{
  let saved=status();const p=page({respond:async(path,body)=>{if(path.endsWith('/configure')){saved=status({publicEnabled:body.enabled});return {publicEnabled:body.enabled};}return saved;}});await p.ui.load();
  const review=p.get('admin-meteora-review');assert.equal(review.hidden,true);
  await p.get('admin-meteora-enable').onclick();assert.equal(review.hidden,false);assert.match(review.textContent,/Open Meteora to new public launches now\?/);assert.equal(p.calls.length,1);
  p.get('admin-meteora-cancel').onclick();assert.equal(review.hidden,true);await p.get('admin-meteora-confirm').onclick();assert.equal(p.calls.length,1,'nothing is sent after Cancel');
  await p.get('admin-meteora-enable').onclick();await p.get('admin-meteora-confirm').onclick();assert.deepEqual(p.calls[1],{path:'/api/admin/meteora/configure',body:{enabled:true}});assert.equal(review.hidden,true);
  await p.get('admin-meteora-pause').onclick();assert.match(review.textContent,/Pause new Meteora launches now\?/);assert.equal(p.calls.filter(c=>c.body).length,1);p.ui.destroy();
});
test('a rate limit or re-authentication error is shown as the server gave it; other errors stay generic',async()=>{
  for(const [error,expected] of [[Object.assign(Error('Too many attempts. Try again in 4 minutes.'),{status:429,known:true}),/Try again in 4 minutes/],[Error('https://private-provider/?api-key=secret'),/could not be saved/]]){
    const p=page({respond:async(path,body)=>{if(body)throw error;return status();}});await p.ui.load();await p.get('admin-meteora-enable').onclick();await p.get('admin-meteora-confirm').onclick();
    assert.match(p.get('admin-meteora-status').textContent,expected);assert.doesNotMatch(p.ui.element.textContent,/api-key/);p.ui.destroy();
  }
});
