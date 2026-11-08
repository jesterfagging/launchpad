import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createLaunchAdmin} from '../public/launch-admin-ui.mjs';
const click={preventDefault(){},stopPropagation(){}};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const job=(requestId='a'.repeat(32),patch={})=>({requestId,state:'queued',counts:{queued:2,processing:0,completed:0,skipped:0,failed:0},items:[{symbol:'ONE',state:'queued'},{symbol:'TWO',state:'queued'}],...patch});
function setup(t,{api:provided,authorize=async()=>({password:'private-password',code:'123456'})}={}){
  const previous=globalThis.document,{document}=parseHTML('<html><head></head><body></body></html>');globalThis.document=document;
  let account={id:'admin',role:'admin',mfaEnabled:true},index=0;const timers=new Map(),calls=[],proofs=[];
  const ui=createLaunchAdmin({api:async(path,body)=>{calls.push({path,body});if(path==='/api/admin/holder-distributions')return provided?provided(path,body):{job:null};if(path==='/api/admin/reward-sweeps')return{job:null};return{launches:[],total:0,offset:0,nextOffset:null};},security:{authorize:async(...args)=>{proofs.push(args);return authorize(...args);}},message(){},getAccount:()=>account,setTimer(fn,delay){const id=++index;timers.set(id,{fn,delay});return id;},clearTimer(id){timers.delete(id);}});
  const load=ui.load;ui.load=async(...args)=>{await load(...args);await ui.refreshRewardSweeps();};
  document.body.append(ui.element);t.after(()=>{ui.clear();globalThis.document=previous;});
  return{ui,document,timers,calls,proofs,button:()=>ui.element.querySelector('[data-admin-distribute-all]'),setAccount(value){account=value;},async tick(){const [id,timer]=timers.entries().next().value;timers.delete(id);assert.equal(timer.delay,5000);await timer.fn();}};
}
test('Distribute all sends one secured global request independent of search, page or archived view',async t=>{
  const h=setup(t,{api:async(_,body)=>({job:body?job(body.requestId):null})});await h.ui.load();
  h.ui.element.querySelector('input[type=search]').value='ONLYTHIS';await h.ui.element.querySelector('[data-view=archived]').onclick();await h.button().onclick();
  const posts=h.calls.filter(c=>c.body);assert.equal(posts.length,1);assert.equal(posts[0].path,'/api/admin/holder-distributions');assert.deepEqual(Object.keys(posts[0].body).sort(),['code','password','requestId']);assert.match(posts[0].body.requestId,/^[a-f0-9]{32}$/);
  assert.deepEqual(h.proofs,[['Distribute all holder rewards',{requireCode:true}]]);assert.equal(h.button().disabled,true);assert.match(h.ui.element.textContent,/2 queued.*0 finished/);assert.match(h.ui.element.textContent,/Gas reserves remain untouched/);assert.match(h.ui.element.textContent,/Other tokens are not converted/);assert(!h.ui.element.textContent.includes('private-password'));
});
test('closing admin or changing account during step-up never sends a distribution request',async t=>{
  for(const change of ['clear','account']){const proof=deferred(),h=setup(t,{authorize:()=>proof.promise});await h.ui.load();const pending=h.button().onclick();if(change==='clear')h.ui.clear();else h.setAccount({id:'other-admin',role:'admin',mfaEnabled:true});proof.resolve({password:'secret',code:'123456'});await pending;assert.equal(h.calls.filter(c=>c.body).length,0);}
});
test('duplicate clicks send one request and discarded replies cannot repopulate a cleared panel',async t=>{
  const response=deferred(),h=setup(t,{api:()=>response.promise});await h.ui.load();const pending=h.button().onclick();await new Promise(setImmediate);await h.button().onclick();assert.equal(h.calls.filter(c=>c.body).length,1);const id=h.calls.find(c=>c.body).body.requestId;h.ui.clear();response.resolve({job:job(id)});await pending;assert.equal(h.ui.element.hidden,true);assert.equal(h.ui.element.querySelector('[aria-label="Bulk holder distributions"] .launch-admin-distribution-rows').children.length,0);assert.equal(h.timers.size,0);
});
test('uncertain submission retries the same ID rather than creating another payment run',async t=>{
  let attempt=0;const h=setup(t,{api:async(_,body)=>{if(!body)return{job:null};if(++attempt===1)throw Error('Connection lost after submission.');return{job:job(body.requestId)};}});await h.ui.load();await h.button().onclick();assert.match(h.button().textContent,/Retry/);await h.ui.refreshDistributions();await h.button().onclick();const posts=h.calls.filter(c=>c.body);assert.equal(posts.length,2);assert.equal(posts[0].body.requestId,posts[1].body.requestId);assert.equal(h.proofs.length,2);assert.equal(h.button().disabled,true);
});
test('status polling restores a running job, reports real outcomes and renders names and errors as text',async t=>{
  let current=job('b'.repeat(32),{state:'running',counts:{queued:0,processing:1,completed:0,skipped:1,failed:0},items:[{symbol:'<img src=x onerror=alert(1)>',state:'processing',reason:'<script>bad</script>'},{symbol:'OTHER',state:'skipped',reason:'No credited SOL.'}]});const h=setup(t,{api:async()=>({job:current})});await h.ui.load();await h.tick();assert.equal(h.button().disabled,true);assert.match(h.ui.element.textContent,/1 processing.*1 skipped/);assert(h.ui.element.textContent.includes('<script>bad</script>'));assert.equal(h.ui.element.querySelector('img,script'),null);
  current=job('b'.repeat(32),{state:'completed',counts:{queued:0,processing:0,completed:0,skipped:1,failed:1},items:[{symbol:'ONE',state:'failed',reason:'RPC unavailable.'},{symbol:'TWO',state:'skipped',reason:'No credited SOL.'}]});await h.tick();assert.match(h.ui.element.textContent,/0 finished.*1 skipped.*1 failed/);assert.match(h.ui.element.textContent,/ONE · Failed/);assert.equal(h.button().disabled,false);assert.equal(h.timers.size,0);assert.equal(h.calls.filter(c=>c.body).length,0);
});
test('hidden Tokens panels do not poll and cleared panels stop their timer',async t=>{
  const h=setup(t);await h.ui.load();h.ui.element.hidden=true;await h.tick();assert.equal(h.calls.filter(c=>c.path==='/api/admin/holder-distributions').length,0);h.ui.element.hidden=false;await h.tick();assert.equal(h.calls.filter(c=>c.path==='/api/admin/holder-distributions').length,1);assert.equal(h.timers.size,0);h.ui.clear();assert.equal(h.timers.size,0);
});
test('a status read begun before submission cannot overwrite the newly accepted job',async t=>{
  const status=deferred(),h=setup(t,{api:async(_,body)=>body?{job:job(body.requestId)}:status.promise});await h.ui.load();const reading=h.ui.refreshDistributions();await h.button().onclick();status.resolve({job:null});await reading;assert.match(h.ui.element.textContent,/Distributions queued/);assert.equal(h.button().disabled,true);
});
test('non-admins cannot read or start bulk distributions, and authorization cancellation sends nothing',async t=>{
  const h=setup(t,{authorize:async()=>{throw Error('Cancelled.');}});await h.ui.load();await h.button().onclick();assert.equal(h.calls.filter(c=>c.body).length,0);assert.doesNotMatch(h.ui.element.textContent,/Cancelled/);const before=h.calls.length;h.setAccount({id:'user',role:'user',mfaEnabled:true});await h.ui.refreshDistributions();await h.button().onclick();assert.equal(h.calls.length,before);assert.equal(h.ui.element.hidden,true);
});
test('existing global jobs returned by the server are shown without falsely claiming a new run',async t=>{
  const h=setup(t,{api:async()=>({alreadyRequested:true,job:job('c'.repeat(32),{state:'running'})})});await h.ui.load();await h.button().onclick();assert.match(h.ui.element.textContent,/Distributions processing/);assert.equal(h.button().disabled,true);assert.equal(h.calls.filter(c=>c.body).length,1);
});

test('blocked jobs explain the problem and invalid progress counts never announce completion',async t=>{
  let current=job('d'.repeat(32),{state:'blocked',reason:'Inventory could not be read safely.',counts:{queued:0,processing:0,completed:0,skipped:0,failed:0},items:[]});const h=setup(t,{api:async()=>({job:current})});await h.ui.load();await h.ui.refreshDistributions();assert.match(h.ui.element.textContent,/needs attention/);assert.match(h.ui.element.textContent,/Inventory could not be read safely/);assert.equal(h.button().disabled,false);assert.equal(h.timers.size,0);
  current=job('d'.repeat(32),{state:'completed',counts:{queued:0,processing:0,completed:-1,skipped:0,failed:0}});await h.ui.refreshDistributions();assert.match(h.ui.element.textContent,/status could not be verified/);assert.doesNotMatch(h.ui.element.textContent,/run finished/);
});

test('waiting and failed launches remain visible while irrelevant inventory is grouped',async t=>{
  const current=job('e'.repeat(32),{state:'running',counts:{queued:0,waiting:1,processing:0,completed:0,skipped:2,failed:1},excludedCount:80,excludedReasons:[{count:80,reason:'Only live holder rewards with SOL as the reward asset are included.'}],items:[
    {symbol:'UNSUPPORTED',state:'skipped',reason:'Only SOL-paired Raydium holder rewards are eligible.'},
    {symbol:'LEGACYBUSY',state:'skipped',reason:'A saved operation or reward cycle is already in progress.'},
    {symbol:'WAIT',state:'waiting',reason:'Complete the saved wallet signature request.'},
    {symbol:'ERROR',state:'failed',reason:'RPC unavailable.'}
  ]});
  const h=setup(t,{api:async()=>({job:current})});await h.ui.load();await h.ui.refreshDistributions();
  const rows=h.ui.element.querySelector('[aria-label="Bulk holder distributions"] .launch-admin-distribution-rows'),excluded=h.ui.element.querySelector('[data-distribution-excluded]');
  assert.equal(rows.children.length,3);assert.match(rows.children[0].textContent,/ERROR · Failed/);assert.match(rows.children[1].textContent,/WAIT · Waiting/);assert.match(rows.children[2].textContent,/LEGACYBUSY · Skipped/);assert.equal(rows.parentElement.open,true);
  assert.doesNotMatch(rows.textContent,/UNSUPPORTED/);assert.match(excluded.textContent,/81 launches excluded/);assert.match(excluded.textContent,/80 · Only live holder/);assert.equal(excluded.open,false);assert.equal(excluded.hidden,false);assert.match(h.ui.element.textContent,/1 waiting/);assert.equal(h.button().disabled,true);
});

test('confirmed payout and reserved credits are formatted exactly and never double counted',async t=>{
  const mint='So11111111111111111111111111111111111111112';
  const current=job('f'.repeat(32),{state:'completed',counts:{queued:0,processing:0,completed:3,skipped:0,failed:0},items:[
    {symbol:'SAME',mint,state:'completed',paidLamports:'9007199254740993',remainingLamports:'2',deferredLamports:'1'},
    {symbol:'SAME',launchId:'different-launch',state:'completed',paidLamports:'0',remainingLamports:'1000000001',deferredLamports:'1000000000'},
    {symbol:'OLD',state:'completed',paidLamports:'1',deferredLamports:'3'}
  ]});
  const h=setup(t,{api:async()=>({job:current})});await h.ui.load();await h.ui.refreshDistributions();const rows=h.ui.element.querySelector('[aria-label="Bulk holder distributions"] .launch-admin-distribution-rows');
  assert.match(rows.children[0].textContent,/SAME · Paid/);assert.match(rows.children[0].textContent,/9007199\.254740993 SOL paid/);assert.match(rows.children[1].textContent,/SAME · Reserved/);assert.doesNotMatch(rows.children[1].textContent,/Done|Paid/);assert.match(rows.children[1].textContent,/Launch different-la/);
  assert.match(h.ui.element.textContent,/Reported paid: 9007199\.254740994 SOL/);assert.match(h.ui.element.textContent,/Reported reserved \(unpaid or rounding\): 1\.000000006 SOL/);
  assert.equal(rows.querySelector('a').href,'https://solscan.io/token/'+mint);assert.equal(rows.querySelector('a').title,mint);assert.equal(rows.querySelector('a').rel,'noopener noreferrer');assert.equal(h.button().textContent,'Distribute SOL rewards');
});

test('untrusted mint and exclusion text cannot create markup or links',async t=>{
  const current=job('9'.repeat(32),{state:'completed',counts:{queued:0,processing:0,completed:1,skipped:0,failed:0},excludedCount:1,excludedReasons:[{count:1,reason:'<img src=x onerror=alert(1)>'}],items:[{symbol:'SAFE',mint:'javascript:alert(1)',state:'completed',paidLamports:'invalid',remainingLamports:'invalid'}]});
  const h=setup(t,{api:async()=>({job:current})});await h.ui.load();await h.ui.refreshDistributions();const rows=h.ui.element.querySelector('[aria-label="Bulk holder distributions"] .launch-admin-distribution-rows');
  assert.equal(rows.querySelector('a'),null);assert.equal(h.ui.element.querySelector('img,script'),null);assert(h.ui.element.textContent.includes('<img src=x onerror=alert(1)>'));assert.doesNotMatch(rows.textContent,/NaN|SOL paid/);
});
