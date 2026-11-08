import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createAdminPumpDeployment} from '../public/admin-pump-deployment-ui.mjs';
const OPERATOR='7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS';
const snapshot={operator:OPERATOR,stage:'buffer',uploadedChunks:0,totalChunks:192,estimatedRentLamports:'863523800',programId:'4SG2WEqAqnt6orNUqcEZdVYoKJQAFT3VLvEdKi7uAYqm'};
const plan={planId:'p1',pendingSignatures:[{wallet:OPERATOR,transaction:'AQID'}],maxWalletDebitLamports:'862660040',totalNetworkFeeLamports:'10000',stage:'buffer'};
function harness({route,sign}={}){
  const {document}=parseHTML('<html><body></body></html>');let account={id:'owner',role:'admin',mfaEnabled:true},active=true,listener,signCount=0;const calls=[],timers=[];
  const wallet={state:()=>({address:OPERATOR,name:'Test wallet',batchSigning:true,wallets:[{id:'1',name:'Test wallet'}]}),onChange:fn=>{listener=fn;return()=>{};},connect:async()=>{},signBatch:async pending=>{signCount++;return sign?sign(pending):['AQID'];}};
  let submitted=false;
  const api=async(path,body)=>{calls.push({path,body});const custom=await route?.(path,body);if(custom)return custom;if(path.endsWith('/submit')){submitted=true;return {state:'pending',batch:{planId:'p1'},resubmitted:false};}return path.endsWith('/prepare')?plan:{...snapshot,...(submitted?{verifiedDeployment:true}:{})};};
  const ui=createAdminPumpDeployment({document,api,getAccount:()=>account,isActive:()=>active,walletFactory:()=>wallet,setTimer:fn=>{timers.push(fn);return timers.length;},clearTimer:()=>{}});document.body.append(ui.element);
  const button=text=>[...ui.element.querySelectorAll('button')].find(x=>x.textContent.startsWith(text));
  return{ui,document,calls,timers,button,get signCount(){return signCount;},setAccount(a){account=a;document.dispatchEvent(new document.defaultView.Event('curve-account-updated'));},setActive(a){active=a;},change(){listener();}};
}
test('setup status and review do not request signatures or submit automatically',async()=>{
  const h=harness();await h.ui.load();assert.equal(h.signCount,0);assert.equal(h.calls.length,1);
  await h.button('Review next').onclick();assert.equal(h.signCount,0);assert.equal(h.calls.length,2);assert.match(h.ui.element.textContent,/0.86266004 SOL/);
  await h.button('Approve').onclick();assert.equal(h.signCount,1);assert.deepEqual(h.calls[2].body,{planId:'p1',signedTransactions:['AQID']});assert.match(h.ui.element.textContent,/Contract verified/);assert.equal(h.timers.length,0);
});
test('revoking owner access removes review and prevents signing',async()=>{
  const h=harness();await h.ui.load();await h.button('Review next').onclick();h.setAccount({id:'owner',role:'user',mfaEnabled:true});
  await h.button('Approve').onclick();assert.equal(h.ui.element.hidden,true);assert.equal(h.signCount,0);assert.equal(h.calls.length,2);
});
test('leaving admin during wallet approval prevents late submission',async()=>{
  let finish;const h=harness({sign:()=>new Promise(resolve=>{finish=resolve;})});await h.ui.load();await h.button('Review next').onclick();
  const signing=h.button('Approve').onclick();h.setActive(false);h.ui.pause();finish(['AQID']);await signing;
  assert.equal(h.calls.some(c=>c.path.endsWith('/submit')),false);
});
test('unknown submission result switches to reconciliation without another wallet prompt',async()=>{
  const h=harness({route:path=>{if(path.endsWith('/submit'))throw Error('Response timed out.');}});await h.ui.load();await h.button('Review next').onclick();await h.button('Approve').onclick();
  assert.equal(h.signCount,1);assert.equal(h.timers.length,1);await h.timers[0]();await new Promise(resolve=>setTimeout(resolve,0));
  assert(h.calls.some(c=>c.path.endsWith('/reconcile')));assert.equal(h.signCount,1);
});
test('malformed plans and wrong operator never reach wallet signing',async()=>{
  for(const value of [{...plan,pendingSignatures:[{wallet:'wrong',transaction:'AQID'}]},{...plan,maxWalletDebitLamports:'NaN'}]){
    const h=harness({route:path=>path.endsWith('/prepare')?value:null});await h.ui.load();await h.button('Review next').onclick();await h.button('Approve').onclick();assert.equal(h.signCount,0);assert.equal(h.calls.length,2);
  }
});
test('stable wallet events preserve a review while cancel explicitly discards it',async()=>{
  const h=harness();await h.ui.load();await h.button('Review next').onclick();h.change();assert.equal(h.button('Approve').disabled,false);h.button('Cancel review').onclick();await h.button('Approve').onclick();assert.equal(h.signCount,0);
});
test('actual submit response is followed by status and reconciliation until finalized',async()=>{
  let submitted=false,finalized=false;
  const h=harness({route:path=>{
    if(path.endsWith('/submit')){submitted=true;return {state:'pending',batch:{planId:'p1'},resubmitted:false};}
    if(path.endsWith('/reconcile')){finalized=true;return {...snapshot,stage:'write',uploadedChunks:25,pendingBatch:null,canPrepare:true};}
    if(path.endsWith('/status'))return {...snapshot,pendingBatch:submitted&&!finalized?{state:'pending'}:null};
  }});
  await h.ui.load();await h.button('Review next').onclick();await h.button('Approve').onclick();
  assert.equal(h.calls.at(-1).path,'/api/admin/pump-test/deployment/status');assert.equal(h.button('Review next').disabled,true);assert.equal(h.timers.length,1);
  await h.timers[0]();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(h.button('Review next').disabled,false);assert.equal(h.signCount,1);
});
test('reload or cancel of an unsigned saved review allows explicit review again',async()=>{
  const h=harness({route:path=>path.endsWith('/status')?{...snapshot,pendingBatch:{state:'prepared'},canPrepare:false}:null});
  await h.ui.load();assert.equal(h.timers.length,0);assert.equal(h.button('Review next').disabled,false);
  await h.button('Review next').onclick();h.button('Cancel review').onclick();await h.button('Review next').onclick();
  assert.equal(h.signCount,0);assert.equal(h.calls.filter(x=>x.path.endsWith('/prepare')).length,2);assert.equal(h.calls.some(x=>x.path.endsWith('/reconcile')),false);
});
