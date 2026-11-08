import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createLaunchAdmin} from '../public/launch-admin-ui.mjs';
const states=['queued','waiting','processing','completed','partial','blocked','failed','skipped'];
const job=(requestId='a'.repeat(32),items=[],state='running')=>({requestId,state,items,counts:Object.fromEntries(states.map(key=>[key,items.filter(row=>row.state===key).length]))});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function setup(t,{respond=async()=>({job:null}),authorize=async()=>({password:'PRIVATE_PROOF',code:'123456'}),oldJob=null}={}){
  const prior=globalThis.document,{document}=parseHTML('<html><head></head><body></body></html>');globalThis.document=document;
  let account={id:'admin',role:'admin',mfaEnabled:true},index=0;const calls=[],proofs=[],timers=new Map();
  const ui=createLaunchAdmin({api:async(path,body)=>{calls.push({path,body});if(path==='/api/admin/reward-sweeps')return respond(body);if(path==='/api/admin/holder-distributions')return{job:oldJob};return{launches:[],total:0,offset:0,nextOffset:null};},security:{authorize:async(...args)=>{proofs.push(args);return authorize(...args);}},message(){},getAccount:()=>account,setTimer(fn,delay){const id=++index;timers.set(id,{fn,delay});return id;},clearTimer(id){timers.delete(id);}});
  document.body.append(ui.element);t.after(()=>{ui.clear();globalThis.document=prior;});
  return{ui,calls,proofs,timers,button:()=>ui.element.querySelector('[data-admin-sweep-all]'),panel:()=>ui.element.querySelector('.launch-admin-reward-sweeps'),setAccount(value){account=value;},async tick(){const scheduled=[...timers];for(const[id,timer]of scheduled){if(!timers.has(id))continue;timers.delete(id);assert.equal(timer.delay,5000);await timer.fn();}}};
}
test('new global button is adjacent to existing distribution and starts every quote with one MFA request independent of current list',async t=>{
  const oldJob={requestId:'b'.repeat(32),state:'running',counts:{queued:0,processing:1,completed:0,skipped:0,failed:0},items:[{symbol:'OLD',state:'processing'}]};
  const h=setup(t,{oldJob,respond:async body=>({job:body?job(body.requestId,[{symbol:'ALPHA',state:'queued',quoteSymbol:'TSLAx',quoteDecimals:8}]):null})});await h.ui.load();await h.ui.refreshDistributions();
  assert.equal(h.button().previousElementSibling.dataset.adminDistributeAll,'true');assert.equal(h.button().disabled,false);
  h.ui.element.querySelector('input[type=search]').value='BETA';await h.ui.element.querySelector('[data-view=archived]').onclick();await h.button().onclick();
  const posts=h.calls.filter(row=>row.body);assert.equal(posts.length,1);assert.equal(posts[0].path,'/api/admin/reward-sweeps');assert.deepEqual(Object.keys(posts[0].body).sort(),['code','password','requestId']);assert.match(posts[0].body.requestId,/^[a-f0-9]{32}$/);
  assert.deepEqual(h.proofs,[['Sell and distribute all holder rewards',{requireCode:true}]]);assert.equal(h.button().disabled,true);assert.match(h.panel().textContent,/ALPHA · Queued/);assert(!h.ui.element.textContent.includes('PRIVATE_PROOF'));
});
test('all-quote progress keeps exact decimals, prioritizes blocked balances and shows real partial payout amounts',async t=>{
  const current=job('c'.repeat(32),[
    {symbol:'BETA',state:'partial',quoteSymbol:'SV151',quoteDecimals:6,remainingBaseUnits:'1',distributedQuoteUnits:'36518743',remainingQuoteUnits:'3',reason:'Unpaid dust remains reserved.'},
    {symbol:'ALPHA',state:'blocked',quoteSymbol:'TSLAx',quoteDecimals:8,remainingBaseUnits:'73419206851937',distributedQuoteUnits:'0',remainingQuoteUnits:'9254317',reason:'The creator rewards token account cannot cover its saved credits.'},
    {symbol:'GAMMA',state:'completed',quoteSymbol:'OPENAI',quoteDecimals:9,remainingBaseUnits:'0',distributedQuoteUnits:'31876502',remainingQuoteUnits:'0'},
    {symbol:'EXACT',state:'completed',quoteSymbol:'TEST',quoteDecimals:0,remainingBaseUnits:'0',distributedQuoteUnits:'9007199254740993',remainingQuoteUnits:'0'},
  ],'completed');const h=setup(t,{respond:async()=>({job:current})});await h.ui.load();await h.ui.refreshRewardSweeps();
  const rows=h.panel().querySelectorAll('li');assert.match(rows[0].textContent,/ALPHA · Blocked/);assert.match(rows[0].textContent,/73419206.851937 ALPHA awaiting conversion/);assert.match(rows[0].textContent,/0.09254317 TSLAx reserved/);assert.match(rows[0].textContent,/Rewards are waiting/);assert.equal(rows[0].classList.contains('negative'),true);
  assert.match(h.panel().textContent,/36.518743 SV151 paid/);assert.match(h.panel().textContent,/0.000003 SV151 reserved/);assert.match(h.panel().textContent,/0.031876502 OPENAI paid/);assert.match(h.panel().textContent,/9007199254740993 TEST paid/);assert.doesNotMatch(h.panel().textContent,/SOL paid|Reported paid/);assert.equal(h.button().disabled,false);
});
test('network retries retain one global request and duplicate clicks cannot submit twice',async t=>{
  let attempts=0;const wait=deferred(),h=setup(t,{respond:async body=>{if(!body)return{job:null};if(++attempts===1)throw Error('Connection lost after saving.');return wait.promise;}});await h.ui.load();await h.button().onclick();const original=h.calls.find(row=>row.body).body.requestId;assert.match(h.button().textContent,/Retry/);
  const submitting=h.button().onclick();await new Promise(setImmediate);await h.button().onclick();const posts=h.calls.filter(row=>row.body);assert.equal(posts.length,2);assert.equal(posts[1].body.requestId,original);wait.resolve({job:job(original)});await submitting;assert.equal(h.button().disabled,true);
});
test('clearing or changing account during authorization prevents mutation and late replies cannot restore private progress',async t=>{
  for(const action of ['clear','account']){const proof=deferred(),h=setup(t,{authorize:()=>proof.promise});await h.ui.load();const pending=h.button().onclick();if(action==='clear')h.ui.clear();else h.setAccount({id:'different',role:'admin',mfaEnabled:true});proof.resolve({code:'123456'});await pending;assert.equal(h.calls.filter(row=>row.body).length,0);}
  const response=deferred(),h=setup(t,{respond:()=>response.promise});await h.ui.load();const pending=h.ui.refreshRewardSweeps();h.ui.clear();response.resolve({job:job('c'.repeat(32),[{symbol:'PRIVATE_BALANCE',state:'blocked'}])});await pending;assert.equal(h.ui.element.hidden,true);assert.equal(h.timers.size,0);assert(!h.ui.element.textContent.includes('PRIVATE_BALANCE'));
});
test('polling restores saved all-quote jobs, stops on completion and never trusts malformed amounts or markup',async t=>{
  let current=job('d'.repeat(32),[{symbol:'<img src=x onerror=alert(1)>',state:'waiting',quoteSymbol:'<script>bad</script>',quoteDecimals:100,distributedQuoteUnits:'1',remainingQuoteUnits:'1',remainingBaseUnits:'invalid',reason:'<img src=x onerror=alert(1)>'}]);const h=setup(t,{respond:async()=>({job:current})});await h.ui.load();await h.tick();assert.equal(h.button().disabled,true);assert.equal(h.panel().querySelector('img,script'),null);assert.doesNotMatch(h.panel().textContent,/NaN|quote tokens paid|<script>bad<\/script> paid/);
  current=job(current.requestId,[],'completed');await h.tick();assert.match(h.panel().textContent,/run finished/);assert.equal(h.button().disabled,false);assert.equal(h.timers.size,0);assert.equal(h.calls.filter(row=>row.body).length,0);
});
test('stale reads cannot replace a submitted sweep and non-admins never read or mutate global rewards',async t=>{
  const read=deferred(),h=setup(t,{respond:async body=>body?{job:job(body.requestId)}:read.promise});await h.ui.load();const reading=h.ui.refreshRewardSweeps();await h.button().onclick();read.resolve({job:null});await reading;assert.equal(h.button().disabled,true);assert.match(h.panel().textContent,/Selling and distributing rewards/);
  const before=h.calls.length;h.setAccount({id:'user',role:'user',mfaEnabled:true});await h.ui.refreshRewardSweeps();await h.button().onclick();assert.equal(h.calls.length,before);assert.equal(h.ui.element.hidden,true);
});
