import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createAdminDammPump} from '../public/admin-damm-pump-ui.mjs';
const A='7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS',R='HN22QWXBPb7dfmPhTjCf14jDco4dYzwDKeehWDXcnHEF';
async function setup(t,{chainEnabled=false,pending=false,route,sign}={}){
 const {document}=parseHTML('<main></main>');let account={id:'owner',role:'admin',mfaEnabled:true},active=true;const calls=[],wallet={state:()=>({address:A,name:'Test',wallets:[{id:'test',name:'Test'}]}),onChange:()=>()=>{},connect:async()=>{},signBatch:async value=>{calls.push(['sign',value]);return sign?sign(value):['signed'];}};
 const ui=createAdminDammPump({document,getAccount:()=>account,isActive:()=>active,walletFactory:()=>wallet,setTimer:()=>0,clearTimer(){},api:async(path,body)=>{calls.push([path,body]);const custom=await route?.(path,body);if(custom)return custom;if(path.endsWith('/deployment/status'))return{operator:A,stage:'deployed',verifiedDeployment:true};if(path.endsWith('/configuration/prepare'))return{planId:'plan',pendingSignatures:[{wallet:A,transaction:'AQID'}],maxWalletDebitLamports:'5000',enabled:body.enabled};if(path.endsWith('/configuration/submit')){chainEnabled=!chainEnabled;return{state:'pending'};}if(path.includes('/configuration/'))return{operator:A,configured:true,chainEnabled,canPrepare:true,...(pending?{pendingBatch:{state:'submitted'}}:{})};return{configured:true,publicEnabled:chainEnabled,ready:true,relayer:R,relayerBalanceLamports:'30000000',relayerMinimumBalanceLamports:'1000000',recommendedBalanceLamports:'30000000'};}});t.after(()=>ui.destroy());document.querySelector('main').append(ui.element);await ui.load();return{ui,document,calls,setAccount:v=>account=v,setActive:v=>active=v,button:text=>[...ui.element.querySelectorAll('button')].find(n=>n.textContent===text)};
}
test('separate deployment is visible and public activation requires explicit wallet approval',async t=>{
 const f=await setup(t);assert(f.document.getElementById('admin-damm-pump-deployment'));assert.match(f.ui.element.textContent,/Deploy the controller for new launches/);assert.match(f.ui.element.textContent,/Existing launches retain their original controller and saved wallets/);assert.doesNotMatch(f.ui.element.textContent,/Meteora → PumpSwap|METEORA → PUMPSWAP/);assert(f.calls.some(([path])=>path==='/api/admin/damm-pump/deployment/status'));await f.button('Review public activation').onclick();assert.equal(f.calls.some(([path])=>path==='sign'),false);assert.match(f.ui.element.textContent,/0.000005 SOL/);await f.button('Approve in deployment wallet').onclick();assert.equal(f.calls.filter(([path])=>path==='sign').length,1);assert(f.calls.some(([path])=>path==='/api/admin/damm-pump/configuration/submit'));assert(!f.calls.some(([path])=>path==='/api/admin/damm-pump/configure'));assert.match(f.ui.element.textContent,/open for public launches/);
});
test('pausing new launches is a reviewed wallet configuration change',async t=>{
 const f=await setup(t,{chainEnabled:true});await f.button('Review pause for new launches').onclick();assert(f.calls.some(([path,body])=>path.endsWith('/configuration/prepare')&&body.enabled===false));assert.match(f.ui.element.textContent,/Existing launches and graduation remain available/);assert.equal(f.calls.some(([path])=>path==='sign'),false);
});
test('pending configuration reconciles on refresh without another signature',async t=>{
 const f=await setup(t,{pending:true});await f.ui.load();assert(f.calls.some(([path])=>path.endsWith('/configuration/reconcile')));assert.equal(f.button('Review public activation').disabled,true);assert.equal(f.calls.some(([path])=>path==='sign'),false);
});
test('a session change during deployment configuration signing prevents submission',async t=>{
 let finish;const f=await setup(t,{sign:()=>new Promise(resolve=>finish=resolve)});await f.button('Review public activation').onclick();const signing=f.button('Approve in deployment wallet').onclick();await Promise.resolve();f.setActive(false);f.ui.pause();finish(['signed']);await signing;assert.equal(f.calls.some(([path])=>path.endsWith('/configuration/submit')),false);
});
test('uncertain configuration retry preserves exact signed bytes without signing again',async t=>{
 let attempts=0;const f=await setup(t,{route:path=>{if(path.endsWith('/configuration/submit')&&++attempts===1)throw Error('Connection interrupted');}});await f.button('Review public activation').onclick();await f.button('Approve in deployment wallet').onclick();const retry=f.button('Retry saved approval');assert(retry&&!retry.disabled);await retry.onclick();const sent=f.calls.filter(([path])=>path.endsWith('/configuration/submit'));assert.equal(sent.length,2);assert.deepEqual(sent[0][1],sent[1][1]);assert.equal(f.calls.filter(([path])=>path==='sign').length,1);
});

test('manual protocol claims require a click and do not change automatic activation or wallet signatures',async t=>{
 const f=await setup(t,{route:path=>path.endsWith('/claim-fees')?{requested:2,pending:1,skipped:3,notices:[{notice:'One coin is waiting for graduation.'}]}:null});
 assert.equal(f.calls.some(([path])=>path.endsWith('/claim-fees')),false);
 const button=f.button('Claim available protocol fees');assert(button&&!button.disabled);assert.match(button.title,/gas/);
 // v71.25: the claim spends graduation-wallet gas, so the first click asks for confirmation and Cancel sends nothing.
 const review=f.document.getElementById('admin-damm-pump-claim-review');button.onclick();assert.equal(review.hidden,false);assert.match(review.textContent,/graduation wallet/);assert.equal(f.calls.some(([path])=>path.endsWith('/claim-fees')),false);
 review.querySelector('.text-button').onclick();assert.equal(review.hidden,true);assert.equal(f.calls.some(([path])=>path.endsWith('/claim-fees')),false);
 button.onclick();await f.document.getElementById('admin-damm-pump-claim-confirm').onclick();assert.equal(f.calls.filter(([path])=>path.endsWith('/claim-fees')).length,1);assert.equal(review.hidden,true);
 assert.match(f.ui.element.textContent,/2 submitted, 1 already pending, 3 skipped/);assert.match(f.ui.element.textContent,/waiting for graduation/);
 assert.equal(f.calls.some(([path])=>path==='sign'||path.endsWith('/configuration/submit')),false);
});

test('leaving Launch modes during a status read leaves the PumpSwap card usable when it is opened again',async t=>{
 let release,hold=false;const f=await setup(t,{route:path=>hold&&path==='/api/admin/damm-pump/status'?new Promise(resolve=>{release=resolve;}):null});
 hold=true;const reading=f.ui.load();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(f.button('Refresh readiness').disabled,true);
 f.setActive(false);f.ui.pause();release({configured:true,publicEnabled:false,ready:true,relayer:R,relayerBalanceLamports:'30000000',relayerMinimumBalanceLamports:'1000000'});await reading;hold=false;
 f.setActive(true);await f.ui.load();
 assert.equal(f.document.getElementById('admin-damm-pump-configuration').hidden,false);
 for(const label of ['Refresh readiness','Copy graduation wallet','Review public activation','Claim available protocol fees'])assert.equal(f.button(label).disabled,false,label);
});
