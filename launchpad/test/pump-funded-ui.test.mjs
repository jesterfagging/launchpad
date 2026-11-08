import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
import {createPumpFundedTestUi,fundedTestReady,validFundedOperation} from '../public/pump-launch-test-ui.mjs';
const operator='7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS',treasury='HN22QWXBPb7dfmPhTjCf14jDco4dYzwDKeehWDXcnHEF',sol='So11111111111111111111111111111111111111112';
const now=1800000000000;
const status={enabled:true,verifiedDeployment:true,operator,treasury,quoteMint:sol,preset:'micro-test',cluster:'mainnet-beta',phase:'uninitialized',actions:['initialize'],activeOperation:null,blockers:[]};
const operation={id:'operation-123',action:'initialize',wallet:operator,transaction:'AQID',expiresAt:now+90000,state:'awaiting_signature',review:{maxWalletDebitLamports:'50000000',solUsdMicros:'150000000'}};
async function fixture({respond,sign,initialStatus=status}={}){
 const {document}=parseHTML(await readFile(new URL('../public/launchpad.html',import.meta.url),'utf8'));const calls=[],signs=[];let connected=operator,active=true,quoteMint=sol,clock=now,changed=0;
 const request=async(path,body)=>{calls.push({path,body});const custom=await respond?.(path,body);if(custom)return custom;if(path==='/funded/status')return structuredClone(initialStatus);if(path==='/funded/prepare')return{operation:structuredClone(operation)};return{operation:{...operation,state:path==='/funded/reconcile'?'finalized':'pending',signature:'1'.repeat(88)}};};
 const wallet={state:()=>({address:connected}),sign:async(value)=>{signs.push(value);return sign?sign(value):'BAUG';}};
 const controller=createPumpFundedTestUi({document,request,wallet,context:()=>({active,quoteMint}),openWallets(){},onChange(){changed++;},now:()=>clock});
 const $=id=>document.getElementById(id);$('launch-pump-funded-price').value='150';const button=action=>document.querySelector('[data-pump-funded-action="'+action+'"]');
 return{document,controller,calls,signs,$,button,async ready(){await controller.refresh();},wallet(address){connected=address;controller.walletChanged();},active(value){active=value;controller.contextChanged();},pair(value){quoteMint=value;controller.contextChanged();},clock(value){clock=value;controller.render();},changed:()=>changed};
}
test('funded readiness requires the exact pinned identities, mainnet, SOL and reviewed microtest',()=>{
 assert.equal(fundedTestReady(status),true);for(const patch of [{verifiedDeployment:false},{operator:treasury},{treasury:operator},{quoteMint:operator},{preset:'standard'},{cluster:'devnet'},{actions:['transfer']}])assert.equal(fundedTestReady({...status,...patch}),false);
 assert.equal(validFundedOperation(operation,{now}),true);for(const patch of [{wallet:treasury},{expiresAt:now-1},{action:'withdraw'},{review:{maxWalletDebitLamports:'3300000001'}},{state:'pending'},{transaction:''}])assert.equal(validFundedOperation({...operation,...patch},{now}),false);
});
test('unverified deployment exposes no enabled funded action or wallet signature',async()=>{
 const p=await fixture({initialStatus:{...status,enabled:false,verifiedDeployment:false,blockers:['No matching deployment.']}});await p.ready();assert.equal(p.$('launch-pump-funded-actions').hidden,true);await p.button('initialize').onclick();await p.$('launch-pump-funded-sign').onclick();assert.equal(p.signs.length,0);assert(!p.calls.some(c=>c.path==='/funded/prepare'||c.path==='/funded/submit'));p.controller.destroy();
});
test('funded operation is first reviewed and only signs after explicit approval',async()=>{
 const p=await fixture();await p.ready();await p.button('initialize').onclick();assert.equal(p.signs.length,0);assert.match(p.$('launch-pump-funded-facts').textContent,/0.05 SOL/);assert.equal(p.$('launch-pump-funded-sign').disabled,false);await p.$('launch-pump-funded-sign').onclick();assert.equal(p.signs.length,1);assert.deepEqual(p.calls.find(c=>c.path==='/funded/submit').body,{operationId:operation.id,signedTransaction:'BAUG'});assert.equal(p.signs[0].transaction,'AQID');assert.equal(p.signs[0].wallet,operator);assert.equal(p.$('launch-pump-funded-sign').hidden,true);p.controller.destroy();
});
test('wrong wallet, different pair or unallowed action never prepares or signs',async()=>{
 const p=await fixture();await p.ready();p.wallet(treasury);await p.button('initialize').onclick();assert(!p.calls.some(c=>c.path==='/funded/prepare'));p.wallet(operator);p.pair(treasury);await p.ready();await p.button('initialize').onclick();assert(!p.calls.some(c=>c.path==='/funded/prepare'));p.pair(sol);await p.ready();await p.button('migrate').onclick();assert(!p.calls.some(c=>c.path==='/funded/prepare'));assert.equal(p.signs.length,0);p.controller.destroy();
});
test('expired or changed review cannot be signed, including direct handler invocation',async()=>{
 for(const bad of [{...operation,wallet:treasury},{...operation,action:'migrate'},{...operation,review:{maxWalletDebitLamports:'3300000001'}}]){const p=await fixture({respond:path=>path==='/funded/prepare'?{operation:bad}:undefined});await p.ready();await p.button('initialize').onclick();await p.$('launch-pump-funded-sign').onclick();assert.equal(p.signs.length,0);p.controller.destroy();}
 const p=await fixture();await p.ready();await p.button('initialize').onclick();p.clock(now+100000);await p.$('launch-pump-funded-sign').onclick();assert.equal(p.signs.length,0);p.controller.destroy();
});
test('wallet rejection creates no submission and allows review to remain',async()=>{
 const p=await fixture({sign:()=>{throw Error('User rejected');}});await p.ready();await p.button('initialize').onclick();await p.$('launch-pump-funded-sign').onclick();assert(!p.calls.some(c=>c.path==='/funded/submit'));assert.match(p.$('launch-pump-funded-state').textContent,/User rejected/);assert.equal(p.$('launch-pump-funded-sign').disabled,false);p.controller.destroy();
});
test('interrupted submission retries identical signed bytes without another wallet prompt',async()=>{
 let first=true;const p=await fixture({respond:path=>{if(path==='/funded/submit'&&first){first=false;throw Error('Network disconnected');}}});await p.ready();await p.button('initialize').onclick();await p.$('launch-pump-funded-sign').onclick();assert.equal(p.$('launch-pump-funded-retry-submit').hidden,false);await p.$('launch-pump-funded-retry-submit').onclick();const requests=p.calls.filter(c=>c.path==='/funded/submit');assert.equal(requests.length,2);assert.deepEqual(requests[0].body,requests[1].body);assert.equal(p.signs.length,1);assert.equal(p.calls.filter(c=>c.path==='/funded/prepare').length,1);p.controller.destroy();
});
test('account or wallet change during signing discards the late signed response',async()=>{
 for(const change of ['wallet','account']){let release;const promise=new Promise(resolve=>{release=resolve;});const p=await fixture({sign:()=>promise});await p.ready();await p.button('initialize').onclick();const signing=p.$('launch-pump-funded-sign').onclick();if(change==='wallet')p.wallet(treasury);else p.active(false);release('BAUG');await signing;assert(!p.calls.some(c=>c.path==='/funded/submit'));assert.equal(p.$('launch-pump-funded-retry-submit').hidden,true);p.controller.destroy();}
});
test('saved pending transaction reconciles without constructing or signing a replacement',async()=>{
 const p=await fixture({initialStatus:{...status,actions:[],activeOperation:{...operation,state:'pending',signature:'1'.repeat(88)}}});await p.ready();await p.controller.poll();assert(p.calls.some(c=>c.path==='/funded/reconcile'));assert(!p.calls.some(c=>c.path==='/funded/prepare'||c.path==='/funded/submit'));assert.equal(p.signs.length,0);assert.match(p.$('launch-pump-funded-state').textContent,/finalized/);p.controller.destroy();
});
test('migrate review states the irreversible LP burn and uses a single explicit wallet approval',async()=>{
 const migration={...operation,action:'migrate',review:{maxWalletDebitLamports:'5000',details:{poolQuoteLamports:'240000000',graduationFeeLamports:'100000000'}}};const p=await fixture({initialStatus:{...status,phase:'bonded',actions:['migrate','sell-recovery']},respond:path=>path==='/funded/prepare'?{operation:migration}:undefined});await p.ready();await p.button('migrate').onclick();assert.match(p.$('launch-pump-funded-operation-note').textContent,/permanently burns every LP token/);assert.match(p.$('launch-pump-funded-facts').textContent,/0.24 SOL/);assert.equal(p.signs.length,0);p.controller.destroy();
});
test('expired unsigned review can be replaced when the server advertises its action again',async()=>{
 const old={...operation,expiresAt:now-1};const p=await fixture({initialStatus:{...status,activeOperation:old}});await p.ready();assert.equal(p.$('launch-pump-funded-sign').disabled,true);assert.equal(p.button('initialize').disabled,false);await p.button('initialize').onclick();assert.equal(p.calls.filter(c=>c.path==='/funded/prepare').length,1);assert.equal(p.$('launch-pump-funded-sign').disabled,false);assert.equal(p.signs.length,0);p.controller.destroy();
});
test('an expired review with cached signed bytes remains locked until its receipt is resolved',async()=>{
 const p=await fixture({respond:path=>{if(path==='/funded/submit')throw Error('Network disconnected');}});await p.ready();await p.button('initialize').onclick();await p.$('launch-pump-funded-sign').onclick();p.clock(now+100000);assert.equal(p.button('initialize').disabled,true);await p.button('initialize').onclick();assert.equal(p.calls.filter(c=>c.path==='/funded/prepare').length,1);assert.equal(p.$('launch-pump-funded-retry-submit').hidden,false);p.controller.destroy();
});
test('initialize requires a manual SOL snapshot and freezes exactly the reviewed price',async()=>{
 const p=await fixture();await p.ready();p.$('launch-pump-funded-price').value='';await p.button('initialize').onclick();assert(!p.calls.some(c=>c.path==='/funded/prepare'));p.$('launch-pump-funded-price').value='150';await p.button('initialize').onclick();assert.deepEqual(p.calls.find(c=>c.path==='/funded/prepare').body,{action:'initialize',expectedWallet:operator,solUsdMicros:'150000000'});assert.equal(p.$('launch-pump-funded-price').readOnly,true);assert.match(p.$('launch-pump-funded-facts').textContent,/Manual SOL\/USD reference/);p.$('launch-pump-funded-price').value='151';await p.$('launch-pump-funded-sign').onclick();assert.equal(p.signs.length,0);assert(!p.calls.some(c=>c.path==='/funded/submit'));p.controller.destroy();
});
test('server price mismatch is rejected before wallet signing',async()=>{
 const p=await fixture({respond:path=>path==='/funded/prepare'?{operation:{...operation,review:{...operation.review,solUsdMicros:'149000000'}}}:undefined});await p.ready();await p.button('initialize').onclick();await p.$('launch-pump-funded-sign').onclick();assert.equal(p.signs.length,0);p.controller.destroy();
});
test('a sell-recovery request never sends or mutates the fixed USD price',async()=>{
 const recovery={...operation,action:'sell-recovery'};const p=await fixture({initialStatus:{...status,phase:'bonded',actions:['sell-recovery']},respond:path=>path==='/funded/prepare'?{operation:recovery}:undefined});await p.ready();await p.button('sell-recovery').onclick();assert.deepEqual(p.calls.find(c=>c.path==='/funded/prepare').body,{action:'sell-recovery',expectedWallet:operator});p.controller.destroy();
});
