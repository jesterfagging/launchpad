import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createLaunchAdmin } from '../public/launch-admin-ui.mjs';

const path='/api/admin/failed-launch-archive';
const preview={scannedCount:105,failedCount:45,eligibleCount:32,excludedCount:13,excludedReasons:[{code:'unsupported',count:7,message:'This launch provider needs individual archive review.'},{code:'pending',count:6,message:'A saved transaction still needs reconciliation.'}]};
const empty={launches:[],total:0,offset:0,nextOffset:null};
function harness(t,{respond,authorize}={}){
  const prior=globalThis.document,{document}=parseHTML('<html><head></head><body></body></html>');globalThis.document=document;
  let account={id:'a'.repeat(32),role:'admin',mfaEnabled:true};const calls=[],proofs=[],messages=[];
  const ui=createLaunchAdmin({api:async(route,body)=>{calls.push({route,body});if(route===path)return respond?respond(body):preview;return empty;},security:{authorize:async(...args)=>{proofs.push(args);return authorize?authorize():{password:'private-proof',code:'123456'};}},getAccount:()=>account,message:(...args)=>messages.push(args),setTimer:()=>1,clearTimer(){}});
  document.body.append(ui.element);t.after(()=>{ui.clear();globalThis.document=prior;});
  const panel=()=>ui.element.querySelector('[aria-label="Archive failed launch requests"]');
  return{ui,calls,proofs,messages,panel,button:()=>ui.element.querySelector('[data-admin-archive-failed]'),confirm:()=>ui.element.querySelector('[data-admin-archive-confirm]'),cancel:()=>ui.element.querySelector('[data-admin-archive-cancel]'),setAccount(value){account=value;}};
}

test('bulk archive previews all-account counts before requesting fresh proof and sends only a request identity',async t=>{
  const h=harness(t,{respond:body=>body?{...preview,requestId:body.requestId,status:'completed',archivedCount:31,skippedCount:1,remainingCount:0,excludedCount:14}:preview});
  await h.ui.load();assert.equal(h.panel().hidden,true);assert.equal(h.calls.some(call=>call.route===path),false);
  await h.button().onclick();assert.equal(h.proofs.length,0);assert.equal(h.calls.filter(call=>call.body).length,0);assert.match(h.panel().textContent,/32 failed requests are eligible/);assert.match(h.panel().textContent,/across all accounts/);assert.match(h.panel().textContent,/7 · This launch provider/);assert.equal(h.confirm().textContent,'Archive 32 failed requests');
  await h.confirm().onclick();assert.deepEqual(h.proofs,[['Archive 32 eligible failed launch requests',{requireCode:true}]]);
  const post=h.calls.find(call=>call.body);assert.equal(post.route,path);assert.deepEqual(Object.keys(post.body).sort(),['code','password','requestId']);assert.match(post.body.requestId,/^[a-f0-9]{32}$/);
  assert.match(h.panel().textContent,/31 failed requests archived · 1 skipped during recheck · 14 excluded in total/);assert.doesNotMatch(h.panel().textContent,/private-proof/);assert.equal(h.confirm().disabled,true);
});

test('partial bulk archive retains its saved request ID and reports remaining work without claiming completion',async t=>{
  let attempt=0;const h=harness(t,{respond:body=>{if(!body)return preview;attempt++;return{...preview,requestId:body.requestId,status:attempt===1?'partial':'completed',archivedCount:attempt===1?12:32,skippedCount:0,remainingCount:attempt===1?20:0};}});
  await h.ui.load();await h.button().onclick();await h.confirm().onclick();assert.match(h.panel().textContent,/12 failed requests archived/);assert.match(h.panel().textContent,/20 still need confirmation/);assert.equal(h.confirm().textContent,'Retry saved archive request');assert.equal(h.cancel().disabled,true);assert.equal(h.button().disabled,true);
  await h.confirm().onclick();const posts=h.calls.filter(call=>call.body);assert.equal(posts.length,2);assert.equal(posts[0].body.requestId,posts[1].body.requestId);assert.match(h.panel().textContent,/32 failed requests archived/);assert.doesNotMatch(h.panel().textContent,/still need confirmation/);assert.equal(h.button().disabled,false);
});

test('uncertain bulk responses retain request identity and duplicate clicks cannot start a second archive',async t=>{
  let release,attempt=0;const h=harness(t,{respond:body=>{if(!body)return preview;attempt++;if(attempt===1)return new Promise(resolve=>{release=resolve;});return{...preview,requestId:body.requestId,status:'completed',archivedCount:32,skippedCount:0,remainingCount:0};}});
  await h.ui.load();await h.button().onclick();const pending=h.confirm().onclick();await new Promise(resolve=>setTimeout(resolve,0));await h.confirm().onclick();assert.equal(h.calls.filter(call=>call.body).length,1);
  release({...preview,requestId:'mismatch',status:'completed',archivedCount:32,skippedCount:0,remainingCount:0});await pending;assert.match(h.panel().textContent,/could not be verified/);assert.equal(h.confirm().textContent,'Retry saved archive request');await h.confirm().onclick();const posts=h.calls.filter(call=>call.body);assert.equal(posts[0].body.requestId,posts[1].body.requestId);
});

test('zero eligibility cannot mutate and exclusion text is rendered without markup',async t=>{
  const h=harness(t,{respond:()=>({...preview,eligibleCount:0,excludedCount:45,excludedReasons:[{count:45,message:'<img src=x onerror=alert(1)>'}]})});await h.ui.load();await h.button().onclick();assert.equal(h.confirm().disabled,true);await h.confirm().onclick();assert.equal(h.proofs.length,0);assert.equal(h.calls.filter(call=>call.body).length,0);assert.equal(h.panel().querySelector('img'),null);assert.match(h.panel().textContent,/<img/);h.cancel().onclick();assert.equal(h.panel().hidden,true);
});

test('closing admin while bulk archive authorization is open suppresses the write',async t=>{
  let approve;const h=harness(t,{authorize:()=>new Promise(resolve=>{approve=resolve;})});await h.ui.load();await h.button().onclick();const pending=h.confirm().onclick();h.ui.clear();approve({code:'123456'});await pending;assert.equal(h.calls.filter(call=>call.body).length,0);assert.equal(h.ui.element.hidden,true);
});

test('late bulk archive preview for a different administrator never enables the mutation',async t=>{
  let resolve;const h=harness(t,{respond:()=>new Promise(done=>{resolve=done;})});await h.ui.load();const pending=h.button().onclick();h.setAccount({id:'different',role:'admin',mfaEnabled:true});resolve(preview);await pending;assert.equal(h.confirm().disabled,true);assert.equal(h.proofs.length,0);
});
