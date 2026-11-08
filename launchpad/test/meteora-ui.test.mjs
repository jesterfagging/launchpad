import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createMeteoraOperation,meteoraDecimalRaw,validMeteoraOperation} from '../public/meteora-ui.mjs';

const A='7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS',B='HN22QWXBPb7dfmPhTjCf14jDco4dYzwDKeehWDXcnHEF',M='GNu1FSuype33KF4RXfow38Dw3ziw9e71FTBLVY5mdrTa';
function operation(overrides={}){return{id:'operation-123',action:'initialize',wallet:A,mint:M,state:'awaiting_signature',expiresAt:200000,transaction:'AQID',review:{maxWalletDebitLamports:'120005000',firstBuyRaw:'100000000',quoteMint:'So11111111111111111111111111111111111111112',quoteSymbol:'SOL',quoteDecimals:9},...overrides};}
function fixture({request,onConfirmed,onFinalized,onOpenCoin,launchFlow=false,getLaunchInput,clock=()=>100000,setTimer,clearTimer,setDelay,clearDelay}={}){
 const {document}=parseHTML('<div id="root"></div>'),root=document.getElementById('root'),calls=[];let address=A,key='account',signResolve;
 const wallet={state:()=>({address}),sign:async pending=>{calls.push(['sign',pending]);return signResolve?await signResolve():'signed-transaction';}};
 const controller=createMeteoraOperation({document,root,wallet,clock,onConfirmed,onFinalized,onOpenCoin,launchFlow,getLaunchInput,...(setDelay?{setDelay,clearDelay}:{}),...(setTimer?{setTimer,clearTimer}:{}),context:()=>({active:true,key}),request:async(path,body)=>{calls.push([path,body]);return await request?.(path,body)||{operation:operation()};}});
 return{controller,document,root,calls,wallet,setAddress:v=>address=v,setKey:v=>key=v,setSign:v=>signResolve=v,button:text=>[...root.querySelectorAll('button')].find(x=>x.textContent===text)};
}
test('public review calculates launch total exactly and cannot sign before explicit approval',async()=>{
 const f=fixture();await f.controller.prepare({action:'initialize',amountRaw:'100000000'});assert.equal(f.calls.filter(x=>x[0]==='sign').length,0);assert.match(f.root.textContent,/0\.020005 SOL/);assert.match(f.root.textContent,/0\.120005 SOL/);assert.equal(f.button('Create coin').disabled,false);f.controller.destroy();
});
test('changed wallet during approval never submits signed bytes',async()=>{
 let resolve;const f=fixture();f.setSign(()=>new Promise(r=>resolve=r));await f.controller.prepare({action:'initialize'});const pending=f.button('Create coin').onclick();await Promise.resolve();f.setAddress(B);resolve('signed');await pending;assert.equal(f.calls.some(x=>x[0]==='/submit'),false);f.controller.destroy();
});
test('wrong wallet, mint, malformed or expired public preparations never reach signing',async()=>{
 for(const overrides of [{wallet:B},{expiresAt:100000},{transaction:''},{mint:'bad'}]){const f=fixture({request:()=>({operation:operation(overrides)})});await f.controller.prepare({action:'initialize'});assert.equal(f.controller.operation,null);assert.equal(f.calls.some(x=>x[0]==='sign'),false);f.controller.destroy();}
 assert.equal(validMeteoraOperation(operation({action:'buy'}),{wallet:A,action:'buy',mint:B,now:100000}),false);
});
test('lost submission retains exact signed transaction; retry does not request another signature',async()=>{
 let attempts=0;const f=fixture({request:(path,body)=>{if(path==='/submit'){attempts++;if(attempts===1)throw Error('Network interrupted');return{operation:operation({state:'submitted',signature:'1'.repeat(88)})};}return{operation:operation()};}});
 await f.controller.prepare({action:'initialize'});await f.button('Create coin').onclick();assert.equal(f.button('Retry saved submission').hidden,false);await f.button('Retry saved submission').onclick();const sent=f.calls.filter(x=>x[0]==='/submit');assert.equal(sent.length,2);assert.deepEqual(sent[0][1],sent[1][1]);assert.equal(f.calls.filter(x=>x[0]==='sign').length,1);assert.equal(f.controller.operation.state,'submitted');f.controller.destroy();
});
test('definitive unsigned review rejection releases invalid bytes and preserves the paid launch for reapproval',async()=>{
 let attempts=0;const saved=operation({review:{...operation().review,configurationCreated:true}});
 const f=fixture({launchFlow:true,getLaunchInput:()=>{throw Error('Form no longer available');},request:(path)=>{
  if(path==='/submit'&&++attempts===1)throw Object.assign(Error('The wallet approval was rejected. Nothing was submitted.'),{code:'WALLET_TRANSACTION_REJECTED',status:400});
  return{operation:{...saved,state:'finalized'}};
 }});
 try{
  assert(f.controller.restore(saved));await f.button('Create coin').onclick();
  assert.equal(f.controller.operation.mint,M);assert.equal(f.controller.operation.state,'awaiting_signature');
  assert.equal(f.button('Retry saved submission').hidden,true);assert.equal(f.button('Create coin').disabled,false);
  assert.match(f.root.textContent,/Completed setup remains saved/);
  await f.controller.poll();assert.equal(f.calls.some(([path])=>path==='/reconcile'),false);
  await f.button('Create coin').onclick();assert.equal(f.calls.filter(([path])=>path==='sign').length,2);
  assert.equal(f.calls.some(([path])=>path==='/prepare'),false);assert.equal(f.controller.operation.state,'finalized');
 }finally{f.controller.destroy();}
});
test('ambiguous validation or provider errors never discard an unconfirmed signed packet',async()=>{
 for(const error of [Object.assign(Error('RPC proof unavailable'),{status:503,code:'WALLET_TRANSACTION_REJECTED'}),Object.assign(Error('The connection was interrupted.'),{status:503}),Object.assign(Error('Unknown rejection'),{status:400})]){
  const f=fixture({request:path=>{if(path==='/submit')throw error;return{operation:operation()};}});
  try{await f.controller.prepare({action:'initialize'});await f.button('Create coin').onclick();assert.equal(f.button('Retry saved submission').hidden,false);await f.button('Retry saved submission').onclick();assert.equal(f.calls.filter(([path])=>path==='sign').length,1);const sent=f.calls.filter(([path])=>path==='/submit');assert.deepEqual(sent[0][1],sent[1][1]);}finally{f.controller.destroy();}
 }
});
test('a retry with a definitive rejection unlocks a new approval and repeated errors are not duplicated',async()=>{
 let submit=0;const rejected=Object.assign(Error('Wallet review rejected'),{code:'WALLET_TRANSACTION_REJECTED',status:400});
 const f=fixture({request:path=>{if(path==='/submit'){if(++submit===1)throw Error('Wallet review rejected');throw rejected;}if(path==='/reconcile')throw Error('Wallet review rejected');return{operation:operation()};}});
 try{await f.controller.prepare({action:'initialize'});await f.button('Create coin').onclick();await f.controller.reconcile();assert.equal(f.root.querySelector('.meteora-operation-status').textContent,'Wallet review rejected');await f.button('Retry saved submission').onclick();assert.equal(f.button('Retry saved submission').hidden,true);assert.equal(f.button('Create coin').disabled,false);}finally{f.controller.destroy();}
});
test('administrator API rejection uses its HTTP statusCode even when status contains runtime data',async()=>{
 const f=fixture({request:path=>{if(path==='/submit')throw Object.assign(Error('Approval rejected'),{code:'WALLET_TRANSACTION_REJECTED',statusCode:400,status:{state:'stopped'}});return{operation:operation()};}});
 try{await f.controller.prepare({action:'initialize'});await f.button('Create coin').onclick();assert.equal(f.button('Retry saved submission').hidden,true);assert.equal(f.button('Create coin').disabled,false);}finally{f.controller.destroy();}
});
test('receipt belonging to another operation is never accepted or announced',async()=>{
 const f=fixture({request:path=>({operation:operation(path==='/reconcile'?{id:'different-id',state:'finalized'}:{})})});await f.controller.prepare({action:'initialize'});await f.controller.reconcile();assert.equal(f.controller.operation.state,'awaiting_signature');assert.match(f.root.textContent,/did not match/);f.controller.destroy();
});
test('restored pending operation reconciles without signing or preparing a replacement',async()=>{
 const f=fixture({request:()=>({operation:operation({state:'finalized'})})});assert.equal(f.controller.restore(operation({state:'submitted'})),true);await f.controller.poll();assert.deepEqual(f.calls.map(x=>x[0]),['/reconcile']);assert.match(f.root.textContent,/Your coin is live/);f.controller.destroy();
});
test('trade review includes exact minimum received from the backend',async()=>{
 const f=fixture({request:()=>({operation:operation({action:'buy',review:{inputRaw:'50000000',expectedOutputRaw:'123456789',minOutputRaw:'120000000',maxWalletDebitLamports:'50005000',quoteMint:'So11111111111111111111111111111111111111112',quoteSymbol:'SOL',quoteDecimals:9}})})});await f.controller.prepare({action:'buy',mint:M,amountRaw:'50000000'});assert.match(f.root.textContent,/Minimum receive120 tokens/);f.controller.destroy();
});
test('decimal conversion does not round large token amounts or accept exponent inputs',()=>{
 assert.equal(meteoraDecimalRaw('123456789.123456',6),'123456789123456');assert.equal(meteoraDecimalRaw('0.000000001',9),'1');for(const input of ['1e2','-1','0.0000000001','Infinity'])assert.throws(()=>meteoraDecimalRaw(input,9));
});

test('stock first buy uses quote decimals and is separate from the SOL budget',async()=>{
 const f=fixture({request:()=>({operation:operation({review:{maxWalletDebitLamports:'20000000',firstBuyRaw:'1234567',quoteMint:B,quoteDecimals:6,quoteSymbol:'NOK'}})})});await f.controller.prepare({action:'initialize'});assert.match(f.root.textContent,/Your first buy1.234567 NOK/);assert.match(f.root.textContent,/Total budget0.02 SOL \+ 1.234567 NOK/);assert(!f.root.textContent.includes('1.234567 SOL'));f.controller.destroy();
});
test('unsupported decimals and changed quote identities cannot validate a transaction',()=>{
 assert.equal(validMeteoraOperation(operation(),{wallet:A,quoteMint:B,now:100000}),false);assert.equal(validMeteoraOperation(operation(),{wallet:A,quoteDecimals:6,now:100000}),false);assert.equal(validMeteoraOperation(operation({review:{maxWalletDebitLamports:'1',firstBuyRaw:'1',quoteMint:B,quoteDecimals:-1}}),{now:100000}),false);
});
test('venue change during preparation discards stale operations and no signing occurs',async()=>{
 let resolve;const f=fixture({request:()=>new Promise(r=>resolve=r)});const pending=f.controller.prepare({action:'initialize'});f.setKey('other-venue');resolve({operation:operation()});await pending;assert.equal(f.controller.operation,null);assert.equal(f.calls.some(x=>x[0]==='sign'),false);f.controller.destroy();
});
test('configuration finality continues with one more approval after Create, and only initialized coin can open',async()=>{
 let stage='configure';const input={action:'initialize',name:'Test',symbol:'TEST',amountRaw:'100000000'};const f=fixture({launchFlow:true,getLaunchInput:()=>input,request:(path,body)=>{
  if(path==='/prepare'){if(body.mint)stage='initialize';return{operation:operation({id:'operation-'+stage,action:stage})};}
  return{operation:operation({id:'operation-'+stage,action:stage,state:'finalized'}),nextAction:stage==='configure'?'initialize':null};
 }});await f.controller.prepare(input);await f.button('Create coin').onclick();for(let i=0;i<40;i++)await Promise.resolve();assert.deepEqual(f.calls.filter(x=>x[0]==='/prepare').map(x=>x[1].mint),[undefined,M]);assert.equal(f.calls.filter(x=>x[0]==='sign').length,2);assert.equal(f.controller.operation.action,'initialize');assert.equal(f.controller.operation.state,'finalized');assert.equal([...f.root.querySelectorAll('a')].find(x=>x.textContent==='Open coin →').hidden,false);f.controller.destroy();
});
test('restored configuration waits for Continue before requesting a second approval',async()=>{
 const f=fixture({launchFlow:true,getLaunchInput:()=>({action:'initialize'}),request:(path)=>({operation:operation({id:'operation-next',action:'initialize',state:path==='/submit'?'finalized':'awaiting_signature'})})});assert(f.controller.restore(operation({action:'configure',state:'finalized'})));await Promise.resolve();assert.equal(f.calls.length,0);assert.equal([...f.root.querySelectorAll('a')].find(x=>x.textContent==='Open coin →').hidden,true);await f.button('Continue launch').onclick();assert.equal(f.calls.filter(x=>x[0]==='sign').length,1);assert.equal(f.controller.operation.state,'finalized');f.controller.destroy();
});
test('rejected second approval preserves initialized configuration and does not automatically reprompt',async()=>{
 const f=fixture({launchFlow:true,getLaunchInput:()=>({action:'initialize'}),request:()=>({operation:operation({action:'initialize'})})});f.controller.restore(operation({action:'configure',state:'finalized'}));f.setSign(()=>{throw Error('User rejected');});await f.button('Continue launch').onclick();for(let i=0;i<15;i++)await Promise.resolve();assert.equal(f.calls.filter(x=>x[0]==='sign').length,1);assert.equal(f.calls.filter(x=>x[0]==='/prepare').length,1);assert.equal(f.controller.operation.state,'awaiting_signature');assert.equal(f.button('Create coin').disabled,false);f.controller.destroy();
});

test('restored initialize after configuration can resume with no unsaved form or image',async()=>{
 const saved=operation({review:{...operation().review,configurationCreated:true}});const f=fixture({launchFlow:true,getLaunchInput:()=>{throw Error('No image yet');},request:()=>({operation:{...saved,state:'finalized'}})});assert(f.controller.restore(saved));assert.equal(f.button('Create coin').disabled,false);await f.button('Create coin').onclick();assert.equal(f.calls.filter(x=>x[0]==='sign').length,1);assert.equal(f.controller.operation.state,'finalized');f.controller.destroy();
});
test('creator claim preparation accepts service action name but still requires matching wallet',async()=>{
 const f=fixture({request:()=>({operation:operation({action:'creator-claim'})})});await f.controller.prepare({action:'claim',mint:M});assert.equal(f.controller.operation.action,'creator-claim');assert.equal(f.button('Claim fees').disabled,false);assert.equal(validMeteoraOperation(operation({action:'creator-claim'}),{wallet:B,action:'claim',now:100000}),false);f.controller.destroy();
});

test('creator claim can resume prior custody payout and accurately explains direct WSOL delivery',async()=>{
 for(const action of ['creator-claim','payout']){
  const op=operation({action});op.review.quoteDelivery='token-account';
  const f=fixture({request:()=>({operation:op})});await f.controller.prepare({action:'claim',mint:M});assert.equal(f.controller.operation.action,action);assert.equal(f.button('Claim fees').disabled,false);assert.match(f.root.textContent,/Wrapped SOL \(WSOL\)/);
  assert.equal(validMeteoraOperation(op,{wallet:B,action:'claim',now:100000}),false);assert.equal(validMeteoraOperation(op,{wallet:A,action:'buy',now:100000}),false);f.controller.destroy();
 }
});

test('generic Meteora cannot prepare or restore the PumpSwap SOL-funding action',async()=>{
 const f=fixture({request:()=>({operation:operation({action:'fund-quote'})})});try{await f.controller.prepare({action:'initialize'});assert.equal(f.controller.operation,null);assert.equal(f.controller.restore(operation({action:'fund-quote',state:'finalized'})),false);assert.equal(validMeteoraOperation(operation({action:'fund-quote'}),{now:100000}),false);assert.equal(f.calls.some(([path])=>path==='sign'),false);}finally{f.controller.destroy();}
});
