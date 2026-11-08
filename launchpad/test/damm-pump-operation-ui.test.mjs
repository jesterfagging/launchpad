import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
import {createDammPumpOperation,validDammPumpOperation} from '../public/damm-pump-ui.mjs';
const walletAddress='7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS',mint='GNu1FSuype33KF4RXfow38Dw3ziw9e71FTBLVY5mdrTa',quoteMint='So11111111111111111111111111111111111111112';
const op=extra=>({id:'damm-operation-123',action:'initialize',wallet:walletAddress,mint,state:'awaiting_signature',expiresAt:200000,transaction:'AQID',review:{maxWalletDebitLamports:'20005000',firstBuyRaw:'0',quoteMint,quoteDecimals:9,quoteSymbol:'SOL'},...extra});
function fixture(t,request){const {document}=parseHTML('<div id="root"></div>'),root=document.getElementById('root'),calls=[];let key='account-1';const controller=createDammPumpOperation({document,root,clock:()=>100000,wallet:{state:()=>({address:walletAddress}),sign:async input=>{calls.push(['sign',input]);return 'signed-bytes';}},context:()=>({active:true,key,quoteMint,quoteDecimals:9}),request:async(path,body)=>{calls.push([path,body]);return request(path,body);},setTimer:()=>0,clearTimer:()=>{}});t.after(()=>controller.destroy());return{controller,root,calls,setKey:value=>key=value};}
test('DAMM operations reject fee-claim actions while permitting the paid setup phase',async t=>{
 const f=fixture(t,()=>({operation:op({action:'creator-claim'})}));await f.controller.prepare({action:'initialize'});assert.equal(f.controller.operation,null);assert.equal(f.controller.restore(op({action:'creator-claim'})),false);assert.equal(f.controller.restore(op({action:'configure',state:'finalized'})),true);assert.equal(f.calls.some(([path])=>path==='sign'),false);
});
test('uncertain DAMM submission retries exact signed bytes and uses distinct wallet operation kind',async t=>{
 let attempts=0;const f=fixture(t,path=>{if(path==='/submit'){if(++attempts===1)throw Error('Connection lost');return{operation:op({state:'submitted'})};}return{operation:op()};});await f.controller.prepare({action:'initialize'});await f.controller.submit();const retry=[...f.root.querySelectorAll('button')].find(x=>x.textContent==='Retry saved submission');assert.equal(retry.hidden,false);await retry.onclick();const submissions=f.calls.filter(([path])=>path==='/submit');assert.equal(submissions.length,2);assert.deepEqual(submissions[0][1],submissions[1][1]);const signatures=f.calls.filter(([path])=>path==='sign');assert.equal(signatures.length,1);assert.equal(signatures[0][1].kind,'curve-damm-pump-initialize');
});
test('late DAMM preparation cannot cross session identity',async t=>{
 let resolve;const f=fixture(t,()=>new Promise(done=>resolve=done)),prepare=f.controller.prepare({action:'initialize'});f.setKey('account-2');resolve({operation:op()});await prepare;assert.equal(f.controller.operation,null);assert.equal(f.calls.some(([path])=>path==='sign'),false);
});

test('DAMM setup includes rent in the combined budget and continues only with the same mint',async t=>{
 const {document}=parseHTML('<div id="root"></div>'),root=document.getElementById('root'),calls=[],input={action:'initialize',name:'Test',symbol:'TEST',amountRaw:'100000000'};let stage='configure';
 const controller=createDammPumpOperation({document,root,clock:()=>100000,launchFlow:true,getLaunchInput:()=>input,wallet:{state:()=>({address:walletAddress}),sign:async value=>{calls.push(['sign',value]);return 'signed';}},context:()=>({active:true,key:'account',quoteMint,quoteDecimals:9}),request:async(path,body)=>{calls.push([path,body]);if(path==='/prepare'){stage=body.mint?'initialize':'configure';return{operation:op({id:'damm-'+stage,action:stage,review:{...op().review,firstBuyRaw:'100000000',setupRentLamports:'1000000',totalLaunchMaxDebitLamports:'121005000'}})};}return{operation:op({id:'damm-'+stage,action:stage,state:'finalized'}),nextAction:stage==='configure'?'initialize':null};},setTimer:()=>0,clearTimer:()=>{}});t.after(()=>controller.destroy());
 await controller.prepare(input);assert.match(root.textContent,/Included setup rent0.001 SOL/);assert.match(root.textContent,/Estimated total budget0.121005 SOL/);assert.equal(calls.filter(([path])=>path==='sign').length,0);await [...root.querySelectorAll('button')].find(x=>x.textContent==='Create coin').onclick();for(let i=0;i<50;i++)await Promise.resolve();assert.equal(controller.operation.action,'initialize');assert.equal(controller.operation.state,'finalized');assert.deepEqual(calls.filter(([path])=>path==='/prepare').map(([,body])=>body.mint),[undefined,mint]);assert.equal(calls.filter(([path])=>path==='sign').length,2);
});

test('setup-only debit is never described as the complete launch budget',async t=>{
 const f=fixture(t,()=>({operation:op({action:'configure',review:{...op().review,maxWalletDebitLamports:'2000000',lookupTableRentLamports:'1995000',firstBuyRaw:'100000000'}})}));await f.controller.prepare({action:'initialize'});assert.match(f.root.textContent,/This setup approval0.002 SOL/);assert.match(f.root.textContent,/First buy at coin creation0.1 SOL/);assert.match(f.root.textContent,/Coin creation and first buy, reviewed separately/);assert.doesNotMatch(f.root.textContent,/Total SOL budget/);
});

const stockMint='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const solFundingReview={maxWalletDebitLamports:'2000000',totalLaunchMaxDebitLamports:'130000000',firstBuyRaw:'1999999',quoteMint:stockMint,quoteDecimals:6,quoteSymbol:'USDC',fundingMode:'sol',firstBuySolLamports:'100000000',quoteFundingInLamports:'100000000',quoteFundingExpectedRaw:'2020000',quoteFundingMinRaw:'2000000'};
const fundingOp=(action,extra={})=>op({id:'funded-'+action,action,review:{...solFundingReview},...extra});
function fundedFixture(t,request,{input={action:'initialize',firstBuySolLamports:'100000000',quoteMint:stockMint},pairMint=stockMint,pairDecimals=6,clock=()=>100000}={}){
 const {document}=parseHTML('<div id="root"></div>'),root=document.getElementById('root'),calls=[];let account='account';
 const controller=createDammPumpOperation({document,root,clock,launchFlow:true,getLaunchInput:typeof input==='function'?input:()=>input,wallet:{state:()=>({address:walletAddress}),sign:async value=>{calls.push(['sign',value]);return 'signed-'+value.operationId;}},context:()=>({active:true,key:account,quoteMint:pairMint,quoteDecimals:pairDecimals}),request:async(path,body)=>{calls.push([path,body]);return request(path,body);},setTimer:()=>0,clearTimer:()=>{}});
 t.after(()=>controller.destroy());return{controller,root,calls,setAccount:value=>account=value,button:text=>[...root.querySelectorAll('button')].find(x=>x.textContent===text)};
}
const microtasks=async()=>{for(let i=0;i<120;i++)await Promise.resolve();};
test('SOL-funded launch uses two approvals when conversion and creation fit together',async t=>{
 let stage='configure';const f=fundedFixture(t,(path,body)=>{if(path==='/prepare'){stage=body.mint?'initialize':'configure';return{operation:fundingOp(stage)};}return{operation:fundingOp(stage,{state:'finalized',nextAction:stage==='configure'?'initialize':null})};});
 await f.controller.prepare({action:'initialize',firstBuySolLamports:'100000000',quoteMint:stockMint});assert.match(f.root.textContent,/Total SOL budget0.13 SOL/);assert.match(f.root.textContent,/Your first buy0.1 SOL/);assert.doesNotMatch(f.root.textContent,/SOL \+/);await f.button('Create coin').onclick();await microtasks();assert.equal(f.controller.operation.state,'finalized');assert.deepEqual(f.calls.filter(([path])=>path==='sign').map(([,value])=>value.kind),['curve-damm-pump-configure','curve-damm-pump-initialize']);assert.deepEqual(f.calls.filter(([path])=>path==='/prepare').map(([,value])=>value.mint),[undefined,mint]);
});
test('large-route fallback automatically converts SOL then initializes the same mint',async t=>{
 let stage='configure',funded=false;const f=fundedFixture(t,(path,body)=>{if(path==='/prepare'){stage=body.mint?(funded?'initialize':'fund-quote'):'configure';return{operation:fundingOp(stage)};}if(stage==='fund-quote')funded=true;return{operation:fundingOp(stage,{state:'finalized'}),nextAction:stage==='initialize'?null:'initialize'};});
 await f.controller.prepare({action:'initialize',firstBuySolLamports:'100000000',quoteMint:stockMint});await f.button('Create coin').onclick();await microtasks();assert.equal(f.controller.operation.action,'initialize');assert.equal(f.controller.operation.state,'finalized');assert.deepEqual(f.calls.filter(([path])=>path==='sign').map(([,value])=>value.kind),['curve-damm-pump-configure','curve-damm-pump-fund-quote','curve-damm-pump-initialize']);assert.deepEqual(f.calls.filter(([path])=>path==='/prepare').map(([,value])=>[value.action,value.mint]),[['initialize',undefined],['initialize',mint],['initialize',mint]]);
});
test('zero first buy shows the automatic seed conversion inside the total SOL budget',async t=>{
 const review={...solFundingReview,firstBuySolLamports:'0',firstBuyRaw:'0',quoteFundingInLamports:'100000',totalLaunchMaxDebitLamports:'30100000'};const f=fundedFixture(t,()=>({operation:fundingOp('configure',{review})}));await f.controller.prepare({action:'initialize',firstBuySolLamports:'0',quoteMint:stockMint});assert.match(f.root.textContent,/Pool seed conversion0.0001 SOL/);assert.match(f.root.textContent,/Launch fees0.03 SOL/);assert.match(f.root.textContent,/Total SOL budget0.0301 SOL/);assert.equal(f.calls.filter(([path])=>path==='sign').length,0);
});
test('uncertain funding submission retries identical bytes without another conversion approval',async t=>{
 let submissions=0;const f=fundedFixture(t,path=>{if(path==='/submit'){if(++submissions===1)throw Object.assign(Error('RPC temporarily unavailable'),{code:'DAMM_VENUE_RPC',status:503});return{operation:fundingOp('fund-quote',{state:'finalized',nextAction:'initialize'})};}return{operation:fundingOp('fund-quote')};});
 f.controller.restore(fundingOp('fund-quote'));await f.button('Create coin').onclick();assert.equal(f.root.querySelector('.meteora-operation-status').classList.contains('negative'),false);assert.equal(f.button('Retry saved submission').hidden,false);await f.button('Retry saved submission').onclick();assert.deepEqual(f.calls.filter(([path])=>path==='/submit').map(([,body])=>body),[{operationId:'funded-fund-quote',signedTransaction:'signed-funded-fund-quote'},{operationId:'funded-fund-quote',signedTransaction:'signed-funded-fund-quote'}]);assert.equal(f.calls.filter(([path])=>path==='sign').length,1);assert.equal(f.calls.filter(([path])=>path==='/prepare').length,0);
});
test('reload during funding reconciles first and never repeats a completed conversion',async t=>{
 const f=fundedFixture(t,(path)=>path==='/reconcile'?{operation:fundingOp('fund-quote',{state:'finalized',nextAction:'initialize'})}:path==='/prepare'?{operation:fundingOp('initialize')}:{operation:fundingOp('initialize',{state:'finalized'})},{input:()=>{throw Error('No local draft or image');}});
 assert(f.controller.restore(fundingOp('fund-quote',{state:'submitted'})));await f.controller.poll();assert.deepEqual(f.calls.map(([path])=>path),['/reconcile']);assert.match(f.root.textContent,/conversion confirmed/i);await f.button('Continue launch').onclick();await microtasks();assert.deepEqual(f.calls.filter(([path])=>path==='/prepare').map(([,body])=>body),[{action:'initialize',mint,expectedWallet:walletAddress}]);assert.equal(f.calls.filter(([path])=>path==='sign').length,1);assert.equal(f.controller.operation.state,'finalized');
});
test('funding receipt with an unexpected next action never auto-continues',async t=>{
 const f=fundedFixture(t,()=>{throw Error('Must not prepare');});assert(f.controller.restore(fundingOp('fund-quote',{state:'finalized',nextAction:'sell'})));await microtasks();assert.equal(f.calls.length,0);assert.equal(f.button('Continue launch'),undefined);
});
test('known temporary RPC errors are neutral while configuration and simulation errors stay red',async t=>{
 for(const [error,negative]of [[Object.assign(Error('Admin request rate limited'),{statusCode:429}),false],[Object.assign(Error('Wait for RPC'),{code:'DAMM_VENUE_RPC',status:503}),false],[Object.assign(Error('Wallet safety verification is waiting for RPC'),{code:'DAMM_WALLET_GUARD_RPC',status:503}),false],[Object.assign(Error('Wait for route provider'),{code:'SOL_ROUTE_PROVIDER_UNAVAILABLE',status:503}),false],[Object.assign(Error('Rate limited'),{code:'SOL_ROUTE_RATE_LIMITED',status:503}),false],[Object.assign(Error('Provider credentials are invalid'),{code:'SOL_ROUTE_AUTH',status:503}),true],[Object.assign(Error('Simulation failed'),{code:'DAMM_SIMULATION',status:503}),true]]){const f=fundedFixture(t,()=>{throw error;});await f.controller.prepare({action:'initialize',firstBuySolLamports:'0'});assert.equal(f.root.querySelector('.meteora-operation-status').classList.contains('negative'),negative);assert.equal(f.calls.filter(([path])=>path==='sign').length,0);}
});
test('late funding preparation cannot cross the signed-in account',async t=>{
 let resolve;const f=fundedFixture(t,()=>new Promise(done=>resolve=done));const pending=f.controller.prepare({action:'fund-quote',mint});f.setAccount('other-account');resolve({operation:fundingOp('fund-quote')});await pending;assert.equal(f.controller.operation,null);assert.equal(f.calls.some(([path])=>path==='sign'),false);
});
test('malformed or oversized funding debit never reaches wallet approval',async t=>{
 for(const review of [{...solFundingReview,quoteFundingInLamports:'200000000'},{...solFundingReview,quoteFundingMinRaw:'0'},{...solFundingReview,quoteFundingExpectedRaw:'1999999'},{...solFundingReview,firstBuySolLamports:undefined}]){const f=fundedFixture(t,()=>({operation:fundingOp('fund-quote',{review})}));await f.controller.prepare({action:'initialize',mint});assert.equal(f.controller.operation,null);assert.equal(f.calls.some(([path])=>path==='sign'),false);}
});
test('actual simulation errors after signing stay visible while exact bytes remain recoverable',async t=>{
 const f=fundedFixture(t,path=>{if(path==='/submit')throw Object.assign(Error('Simulation failed: insufficient funds'),{code:'DAMM_SIMULATION',status:400});return{operation:fundingOp('fund-quote')};});f.controller.restore(fundingOp('fund-quote'));await f.button('Create coin').onclick();assert.match(f.root.textContent,/Simulation failed: insufficient funds/);assert.equal(f.root.querySelector('.meteora-operation-status').classList.contains('negative'),true);assert.equal(f.button('Retry saved submission').hidden,false);assert.equal(f.calls.filter(([path])=>path==='sign').length,1);
});
test('interrupted signed funding checks its saved receipt automatically without signing again',async t=>{
 const f=fundedFixture(t,path=>{if(path==='/submit')throw Object.assign(Error('Request timed out'),{code:'LAUNCH_REQUEST_TIMEOUT',status:408});if(path==='/reconcile')return{operation:fundingOp('fund-quote',{state:'finalized',nextAction:'initialize'})};return{operation:fundingOp('fund-quote')};});f.controller.restore(fundingOp('fund-quote'));await f.button('Create coin').onclick();assert.equal(f.root.querySelector('.meteora-operation-status').classList.contains('negative'),false);await f.controller.poll();assert.equal(f.controller.operation.state,'finalized');assert.equal(f.calls.filter(([path])=>path==='/reconcile').length,1);assert.equal(f.calls.filter(([path])=>path==='sign').length,1);assert.equal(f.calls.filter(([path])=>path==='/prepare').length,0);
});
test('already converted first buy can display a smaller capped quote buy and retained surplus',async t=>{
 const review={...solFundingReview,quoteFundingComplete:true,firstBuyAdjusted:true,firstBuyBudgetRaw:'1999999',firstBuyRaw:'1500000'};const f=fundedFixture(t,()=>({operation:fundingOp('initialize',{review})}));await f.controller.prepare({action:'initialize',mint});assert.match(f.root.textContent,/SOL converted0.1 SOL/);assert.match(f.root.textContent,/Your first buy1.5 USDC/);assert.match(f.root.textContent,/First buy adjusted to stay within the 10% limit. Unused USDC stays in your wallet./);assert.equal(f.root.querySelector('.meteora-operation-status').classList.contains('negative'),false);assert.equal(f.calls.filter(([path])=>path==='sign').length,0);
});

const nativeReview={...op().review,firstBuyRaw:'10000000',firstBuySolLamports:'10000000',fundingMode:'sol',configurationCreated:true,maxWalletDebitLamports:'2044280',nativeAccountRentLamports:'2039280'};
const nativeOp=(action,extra={})=>op({id:'native-'+action,action,review:{...nativeReview},...extra});
const nativeOptions={pairMint:quoteMint,pairDecimals:9,input:()=>{throw Error('Saved launch must not need a new draft');}};
test('saved native setup repairs its account then initializes and buys using the same mint',async t=>{
 let stage='prepare-buy',prepared=false;const f=fundedFixture(t,(path)=>{if(path==='/prepare'){stage=prepared?'initialize':'prepare-buy';return{operation:nativeOp(stage)};}if(stage==='prepare-buy')prepared=true;return{operation:nativeOp(stage,{state:'finalized',nextAction:stage==='prepare-buy'?'initialize':null})};},nativeOptions);
 assert(f.controller.restore(nativeOp('configure',{state:'finalized',nextAction:'initialize'})));await f.button('Continue launch').onclick();await microtasks();
 assert.equal(f.controller.operation.action,'initialize');assert.equal(f.controller.operation.state,'finalized');assert.deepEqual(f.calls.filter(([path])=>path==='sign').map(([,body])=>body.kind),['curve-damm-pump-prepare-buy','curve-damm-pump-initialize']);assert.deepEqual(f.calls.filter(([path])=>path==='/prepare').map(([,body])=>body),[{action:'initialize',mint,expectedWallet:walletAddress},{action:'initialize',mint,expectedWallet:walletAddress}]);
});
test('native account setup clearly reviews rent and cannot accept a non-native or zero-buy repair',async t=>{
 const f=fundedFixture(t,()=>({operation:nativeOp('prepare-buy')}),nativeOptions);await f.controller.prepare({action:'initialize',mint});assert.match(f.root.textContent,/Included account rent0.00203928 SOL/);assert.match(f.root.textContent,/This setup approval0.00204428 SOL/);assert.match(f.root.textContent,/First buy at coin creation0.01 SOL/);assert.doesNotMatch(f.root.textContent,/Total SOL budget|SOL converted/);assert(f.button('Complete launch setup'));assert.equal(f.calls.some(([path])=>path==='sign'),false);
 for(const review of [{...nativeReview,quoteMint:stockMint,quoteDecimals:6},{...nativeReview,firstBuyRaw:'0'},{...nativeReview,firstBuyRaw:undefined}])assert.equal(validDammPumpOperation(nativeOp('prepare-buy',{review}),{now:100000}),false);
});
test('reloading native account setup reconciles its exact saved receipt before initialization',async t=>{
 const f=fundedFixture(t,path=>path==='/reconcile'?{operation:nativeOp('prepare-buy',{state:'finalized',nextAction:'initialize'})}:path==='/prepare'?{operation:nativeOp('initialize')}:{operation:nativeOp('initialize',{state:'finalized'})},nativeOptions);
 assert(f.controller.restore(nativeOp('prepare-buy',{state:'submitted'})));await f.controller.poll();assert.deepEqual(f.calls.map(([path])=>path),['/reconcile']);assert.match(f.root.textContent,/Launch account setup confirmed/);assert(f.controller.inputLocked);await f.button('Continue launch').onclick();await microtasks();assert.equal(f.controller.operation.state,'finalized');assert.equal(f.calls.filter(([path])=>path==='sign').length,1);assert.deepEqual(f.calls.filter(([path])=>path==='/prepare').map(([,body])=>body),[{action:'initialize',mint,expectedWallet:walletAddress}]);
});

test('unsigned server reconciliation preserves the original submit error after the browser has signed',async t=>{
 let now=100000;const original='New launches are waiting for graduation gas funding.',saved=nativeOp('initialize'),f=fundedFixture(t,path=>{if(path==='/submit')throw Error(original);if(path==='/reconcile')return{operation:saved};return{operation:saved};},{...nativeOptions,clock:()=>now});
 assert(f.controller.restore(saved));await f.button('Create coin').onclick();assert.match(f.root.textContent,/graduation gas funding/);assert.equal(f.calls.filter(([path])=>path==='sign').length,1);await f.controller.poll();assert.match(f.root.textContent,/graduation gas funding/);assert.match(f.root.textContent,/Launchpad has not confirmed receipt of your signed approval/);assert.equal(f.root.querySelector('.meteora-operation-status').classList.contains('negative'),true);
 now=200001;await f.controller.poll();assert.match(f.root.textContent,/graduation gas funding/);assert.doesNotMatch(f.root.textContent,/incomplete or invalid|Nothing was signed/);assert.equal(f.button('Retry saved submission').hidden,false);assert.equal(f.calls.filter(([path])=>path==='sign').length,1);assert.equal(f.calls.filter(([path])=>path==='/prepare').length,0);
});
test('expired unjournaled launch receipt releases the old signature and reviews the same mint on explicit retry',async t=>{
 let now=100000,renewed=false;const original=nativeOp('initialize'),replacement=nativeOp('initialize',{id:'native-initialize-renewed',expiresAt:400000}),f=fundedFixture(t,(path)=>{if(path==='/submit'){if(!renewed)throw Error('The review expired before submission.');return{operation:{...replacement,state:'finalized'}};}if(path==='/reconcile')return{operation:{...original,state:'expired'}};if(path==='/prepare'){renewed=true;return{operation:replacement};}throw Error('Unexpected request');},{...nativeOptions,clock:()=>now});
 assert(f.controller.restore(original));await f.button('Create coin').onclick();now=200001;await f.controller.poll();assert.equal(f.controller.operation.state,'expired');assert.equal(f.button('Retry saved submission').hidden,true);assert.equal(f.calls.filter(([path])=>path==='/prepare').length,0);await f.button('Create coin').onclick();await microtasks();assert.equal(f.controller.operation.state,'finalized');assert.deepEqual(f.calls.filter(([path])=>path==='/prepare').map(([,body])=>body),[{action:'initialize',mint,expectedWallet:walletAddress}]);assert.equal(f.calls.filter(([path])=>path==='sign').length,2);
});
test('expired newly prepared transactions still fail before any wallet approval',async t=>{
 const f=fundedFixture(t,()=>({operation:nativeOp('initialize',{expiresAt:100000})}),nativeOptions);await f.controller.prepare({action:'initialize',mint});assert.equal(f.controller.operation,null);assert.match(f.root.textContent,/incomplete or invalid. Nothing was signed/);assert.equal(f.calls.filter(([path])=>path==='sign').length,0);
});

test('expired internal native preparation refreshes through initialize for the same mint',async t=>{
 const saved=nativeOp('prepare-buy',{state:'expired'}),f=fundedFixture(t,path=>path==='/prepare'?{operation:nativeOp('initialize')}:{operation:nativeOp('initialize',{state:'finalized'})},nativeOptions);assert(f.controller.restore(saved));await f.button('Complete launch setup').onclick();await microtasks();assert.equal(f.controller.operation.state,'finalized');assert.deepEqual(f.calls.filter(([path])=>path==='/prepare').map(([,body])=>body),[{action:'initialize',mint,expectedWallet:walletAddress}]);assert.deepEqual(f.calls.filter(([path])=>path==='sign').map(([,body])=>body.kind),['curve-damm-pump-initialize']);
});

test('unavailable confirmation polling backs off to thirty seconds without resubmitting or signing',async t=>{
 let now=100000;const f=fundedFixture(t,()=>{throw Object.assign(Error('RPC capacity is busy'),{code:'DAMM_RPC_BUSY',status:503});},{...nativeOptions,clock:()=>now});
 assert(f.controller.restore(nativeOp('initialize',{state:'submitted'})));
 const times=[];for(let elapsed=0;elapsed<120000;elapsed+=1000){now=100000+elapsed;const before=f.calls.length;await f.controller.poll();if(f.calls.length>before)times.push(elapsed);}
 assert.deepEqual(times,[0,5000,15000,35000,65000,95000]);assert.equal(f.root.querySelector('.meteora-operation-status').classList.contains('negative'),false);assert(f.calls.every(([path])=>path==='/reconcile'));
});
test('confirmation polling honors bounded server cooldown and resumes normal cadence after a receipt',async t=>{
 let now=100000,fail=true,retryAfterMs=900000;const saved=nativeOp('initialize',{state:'submitted'}),f=fundedFixture(t,()=>{if(fail)throw Object.assign(Error('Provider cooling down'),{code:'DAMM_RPC_BUSY',status:429,retryAfterMs});return{operation:saved};},{...nativeOptions,clock:()=>now});
 assert(f.controller.restore(saved));await f.controller.poll();now+=299999;await f.controller.poll();assert.equal(f.calls.length,1);now++;fail=false;await f.controller.poll();assert.equal(f.calls.length,2);
 now+=2499;await f.controller.poll();assert.equal(f.calls.length,2);now++;await f.controller.poll();assert.equal(f.calls.length,3);
 fail=true;retryAfterMs=0;now+=2500;await f.controller.poll();assert.equal(f.calls.length,4);now+=4999;await f.controller.poll();assert.equal(f.calls.length,4);now++;await f.controller.poll();assert.equal(f.calls.length,5);
});
test('a slow confirmation request cannot overlap timer or manual checks and timeouts delay the next check',async t=>{
 let now=100000,reject;const f=fundedFixture(t,()=>new Promise((resolve,fail)=>{reject=fail;}),{...nativeOptions,clock:()=>now});assert(f.controller.restore(nativeOp('initialize',{state:'submitted'})));
 const checking=f.controller.poll();await microtasks();now+=30000;await Promise.all([f.controller.poll(),f.controller.poll(),f.controller.reconcile()]);assert.equal(f.calls.length,1);
 reject(Object.assign(Error('Confirmation request timed out'),{code:'LAUNCH_REQUEST_TIMEOUT',status:408}));await checking;assert.equal(f.controller.busy,false);await f.controller.poll();assert.equal(f.calls.length,1);now+=4999;await f.controller.poll();assert.equal(f.calls.length,1);
 now++;const second=f.controller.poll();assert.equal(f.calls.length,2);reject(Object.assign(Error('Confirmation request timed out'),{code:'LAUNCH_REQUEST_TIMEOUT',status:408}));await second;now+=9999;await f.controller.poll();assert.equal(f.calls.length,2);
});
test('temporary confirmation failures preserve the original rejection and the exact signed transaction',async t=>{
 let now=100000;const f=fundedFixture(t,path=>{if(path==='/submit')throw Object.assign(Error('Simulation failed: insufficient funds'),{code:'DAMM_SIMULATION',status:400});if(path==='/reconcile')throw Object.assign(Error('RPC capacity is busy'),{code:'DAMM_RPC_BUSY',status:503});return{operation:nativeOp('initialize')};},{...nativeOptions,clock:()=>now});
 assert(f.controller.restore(nativeOp('initialize')));await f.button('Create coin').onclick();await f.controller.poll();assert.match(f.root.textContent,/Simulation failed: insufficient funds/);assert.match(f.root.textContent,/RPC capacity is busy/);assert.equal(f.root.querySelector('.meteora-operation-status').classList.contains('negative'),true);assert.equal(f.button('Retry saved submission').hidden,false);
 await f.button('Retry saved submission').onclick();const sent=f.calls.filter(([path])=>path==='/submit');assert.equal(sent.length,2);assert.deepEqual(sent[0][1],sent[1][1]);assert.equal(f.calls.filter(([path])=>path==='sign').length,1);assert.equal(f.calls.filter(([path])=>path==='/prepare').length,0);
});
test('an unsigned review does not poll or request wallet approval while idle',async t=>{
 let now=100000;const f=fundedFixture(t,()=>{throw Error('No RPC is needed for an unsigned review');},{...nativeOptions,clock:()=>now});assert(f.controller.restore(nativeOp('initialize')));for(let i=0;i<120;i++){now+=1000;await f.controller.poll();}assert.equal(f.calls.length,0);
});

test('shared administrator API preserves classified errors and cooldown for the launch controller',async t=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8'),apiSource=source.match(/^async function api\(path, body\) \{[\s\S]*?^\}/m)?.[0];assert(apiSource);
 let now=100000,fail=true;const runtimeStatus={state:'stopped'},saved=nativeOp('initialize',{state:'submitted'});
 const api=new Function('fetch','token','accountUI',apiSource+'\nreturn api;')(async()=>({ok:!fail,status:fail?503:200,json:async()=>fail?{error:'RPC capacity is busy',code:'DAMM_RPC_BUSY',retryAfterMs:60000,status:runtimeStatus}:{operation:saved}}),'test-csrf',null);
 await assert.rejects(api('/api/admin/damm-pump-test/reconcile',{}),error=>error.code==='DAMM_RPC_BUSY'&&error.statusCode===503&&error.status===runtimeStatus&&error.retryAfterMs===60000);
 const f=fundedFixture(t,(path,body)=>api('/api/admin/damm-pump-test'+path,body),{...nativeOptions,clock:()=>now});assert(f.controller.restore(saved));await f.controller.poll();assert.equal(f.root.querySelector('.meteora-operation-status').classList.contains('negative'),false);
 now+=59999;await f.controller.poll();assert.equal(f.calls.length,1);now++;fail=false;await f.controller.poll();assert.equal(f.calls.length,2);assert(f.calls.every(([path])=>path==='/reconcile'));
});
