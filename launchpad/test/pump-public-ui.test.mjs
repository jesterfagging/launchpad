import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createPublicPumpOperation,pumpDecimalRaw,validPublicPumpOperation} from '../public/pump-public-ui.mjs';
import {createCoinTrade} from '../public/coin-trade.mjs';
const A='7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS',B='HN22QWXBPb7dfmPhTjCf14jDco4dYzwDKeehWDXcnHEF',M='GNu1FSuype33KF4RXfow38Dw3ziw9e71FTBLVY5mdrTa';
function operation(overrides={}){return{id:'operation-123',action:'initialize',wallet:A,mint:M,state:'awaiting_signature',expiresAt:200000,transaction:'AQID',review:{maxWalletDebitLamports:'120005000',firstBuyLamports:'100000000',launchFeeLamports:'20000000'},...overrides};}
function fixture({request,onConfirmed,onFinalized,onOpenCoin,launchFlow=false,getLaunchInput,clock=()=>100000,setTimer,clearTimer,setDelay,clearDelay}={}){
 const {document}=parseHTML('<div id="root"></div>'),root=document.getElementById('root'),calls=[];let address=A,key='account',signResolve;
 const wallet={state:()=>({address}),sign:async pending=>{calls.push(['sign',pending]);return signResolve?await signResolve():'signed-transaction';}};
 const controller=createPublicPumpOperation({document,root,wallet,clock,onConfirmed,onFinalized,onOpenCoin,launchFlow,getLaunchInput,...(setDelay?{setDelay,clearDelay}:{}),...(setTimer?{setTimer,clearTimer}:{}),context:()=>({active:true,key}),request:async(path,body)=>{calls.push([path,body]);return await request?.(path,body)||{operation:operation()};}});
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
 assert.equal(validPublicPumpOperation(operation({action:'buy'}),{wallet:A,action:'buy',mint:B,now:100000}),false);
});
test('lost submission retains exact signed transaction; retry does not request another signature',async()=>{
 let attempts=0;const f=fixture({request:(path,body)=>{if(path==='/submit'){attempts++;if(attempts===1)throw Error('Network interrupted');return{operation:operation({state:'submitted',signature:'1'.repeat(88)})};}return{operation:operation()};}});
 await f.controller.prepare({action:'initialize'});await f.button('Create coin').onclick();assert.equal(f.button('Retry saved submission').hidden,false);await f.button('Retry saved submission').onclick();const sent=f.calls.filter(x=>x[0]==='/submit');assert.equal(sent.length,2);assert.deepEqual(sent[0][1],sent[1][1]);assert.equal(f.calls.filter(x=>x[0]==='sign').length,1);assert.equal(f.controller.operation.state,'submitted');f.controller.destroy();
});
test('receipt belonging to another operation is never accepted or announced',async()=>{
 const f=fixture({request:path=>({operation:operation(path==='/reconcile'?{id:'different-id',state:'finalized'}:{})})});await f.controller.prepare({action:'initialize'});await f.controller.reconcile();assert.equal(f.controller.operation.state,'awaiting_signature');assert.match(f.root.textContent,/did not match/);f.controller.destroy();
});
test('restored pending operation reconciles without signing or preparing a replacement',async()=>{
 const f=fixture({request:()=>({operation:operation({state:'finalized'})})});assert.equal(f.controller.restore(operation({state:'submitted'})),true);await f.controller.poll();assert.deepEqual(f.calls.map(x=>x[0]),['/reconcile']);assert.match(f.root.textContent,/Your coin is live/);f.controller.destroy();
});
test('trade review includes exact minimum received from the backend',async()=>{
 const f=fixture({request:()=>({operation:operation({action:'buy',review:{inputRaw:'50000000',expectedOutputRaw:'123456789',minOutputRaw:'120000000',maxWalletDebitLamports:'50005000'}})})});await f.controller.prepare({action:'buy',mint:M,amountRaw:'50000000'});assert.match(f.root.textContent,/Minimum receive120 tokens/);f.controller.destroy();
});
test('decimal conversion does not round large token amounts or accept exponent inputs',()=>{
 assert.equal(pumpDecimalRaw('123456789.123456',6),'123456789123456');assert.equal(pumpDecimalRaw('0.000000001',9),'1');for(const input of ['1e2','-1','0.0000000001','Infinity'])assert.throws(()=>pumpDecimalRaw(input,9));
});
test('Pump pre-graduation token selects dedicated trade endpoint; migrated token switches to pool routes',async()=>{
 const {document,window}=parseHTML('<div id="root"></div>');const root=document.getElementById('root'),calls=[];
 const wallet={state:()=>({address:A,wallets:[]}),onChange:()=>()=>{},sign:async()=>{throw Error('Not expected');}};
 const controller=createCoinTrade({document,window,root,setTimer:()=>1,clearTimer(){},walletFactory:()=>wallet,fetcher:async(path,options)=>{calls.push(path);return{ok:true,json:async()=>path.endsWith('/operations')?{operations:[]}:path.endsWith('/wallet')?{wallet:{address:A,mode:'external',available:true,nativeBalanceLamports:'100000000',baseBalanceRaw:'0',baseDecimals:6}}:{trade:null}};}});
 controller.setSession({authenticated:true,token:'csrf',features:{walletOnly:true},account:{id:'u',authType:'wallet',mainWallet:A}});controller.setCoin({mint:M,symbol:'TEST',platform:'pumpswap',stage:'curve',curveStatus:'curve'});await new Promise(r=>setTimeout(r,5));assert(calls.includes('/api/launchpad/pump/wallet'));assert(!calls.includes('/api/launchpad/trading/wallet'));
 controller.setCoin({mint:M,symbol:'TEST',platform:'pumpswap',stage:'graduated'});await new Promise(r=>setTimeout(r,5));assert(calls.includes('/api/launchpad/trading/wallet'));controller.destroy();
});

test('cancel review cancels the server operation before allowing a replacement',async()=>{
 const f=fixture({request:path=>({operation:operation(path==='/cancel'?{state:'cancelled'}:{})})});await f.controller.prepare({action:'initialize'});await f.button('Cancel review').onclick();assert(f.calls.some(x=>x[0]==='/cancel'&&x[1].operationId==='operation-123'));assert.equal(f.controller.operation,null);await f.controller.prepare({action:'initialize'});assert.equal(f.calls.filter(x=>x[0]==='/prepare').length,2);f.controller.destroy();
});
test('decimal amounts accept leading dot without rounding',()=>{assert.equal(pumpDecimalRaw('.05',9),'50000000');assert.equal(pumpDecimalRaw('.01',2),'1');});

test('confirmed launch opens its coin while finality is tracked separately and callbacks run once',async()=>{
 let now=100000,confirmed=0,finalized=0,cleared=0,next='confirmed';const f=fixture({clock:()=>now,setTimer:()=>7,clearTimer:id=>{assert.equal(id,7);cleared++;},onConfirmed:()=>confirmed++,onFinalized:()=>finalized++,request:()=>({operation:operation({state:next})})});
 f.controller.restore(operation({state:'submitted'}));await f.controller.poll();assert.equal(confirmed,1);assert.equal(finalized,0);assert.match(f.root.textContent,/Launch confirmed. Final verification continues/);assert.equal(f.root.querySelector('a[href="/coin?mint='+M+'"]').hidden,false);
 now+=1999;await f.controller.poll();assert.equal(f.calls.length,1);now++;await f.controller.poll();assert.equal(f.calls.length,2);assert.equal(confirmed,1);assert.equal(finalized,0);
 now=130001;await f.controller.poll();assert.equal(f.calls.length,3);now=132001;await f.controller.poll();assert.equal(f.calls.length,3);next='finalized';now=135001;await f.controller.poll();assert.equal(finalized,1);assert.equal(confirmed,1);await f.controller.poll();assert.equal(f.calls.length,4);assert.equal(f.calls.some(x=>['sign','/prepare','/submit'].includes(x[0])),false);f.controller.destroy();assert.equal(cleared,1);
});
test('fast receipt polling remains single flight and a failed confirmation removes the open-coin link',async()=>{
 let resolve;const f=fixture({setTimer:()=>1,clearTimer(){},request:()=>new Promise(r=>resolve=r)});f.controller.restore(operation({state:'confirmed'}));const first=f.controller.poll();await Promise.resolve();const second=f.controller.poll();assert.equal(f.calls.length,1);resolve({operation:operation({state:'failed'})});await Promise.all([first,second]);assert.equal(f.controller.operation.state,'failed');assert.equal([...f.root.querySelectorAll('a')].find(x=>x.textContent==='Open coin →').hidden,true);f.controller.destroy();
});

function launchFixture(options={}){
 let now=100000,amountRaw='100000000',timerId=0;const delays=new Map();
 const f=fixture({launchFlow:true,getLaunchInput:()=>({action:'initialize',name:'Test',symbol:'TEST',amountRaw}),clock:()=>now,setTimer:()=>1,clearTimer(){},setDelay:(fn,ms)=>{const id=++timerId;delays.set(id,{fn,at:now+ms});return id;},clearDelay:id=>delays.delete(id),...options});
 return {...f,setAmount:value=>{amountRaw=value;},advance:async(ms=0)=>{now+=ms;for(let i=0;i<30;i++){const due=[...delays].filter(([,timer])=>timer.at<=now);if(!due.length)break;for(const[id,timer]of due){delays.delete(id);timer.fn();}for(let tick=0;tick<12;tick++)await Promise.resolve();}},pendingDelays:()=>delays.size,now:()=>now};
}

test('launch flow automatically debounces costs and one Create click signs exactly once',async()=>{
 let state='submitted';const f=launchFixture({request:path=>({operation:operation({state:path==='/submit'||path==='/reconcile'?state:'awaiting_signature'})})});
 f.controller.schedulePrepare(400);f.setAmount('200000000');f.controller.schedulePrepare(400);await f.advance(399);assert.equal(f.calls.length,0);await f.advance(1);assert.equal(f.calls.filter(x=>x[0]==='/prepare').length,1);assert.equal(f.calls[0][1].amountRaw,'200000000');assert.equal(f.button('Create coin').disabled,false);
 await f.button('Create coin').onclick();assert.equal(f.calls.filter(x=>x[0]==='sign').length,1);assert.equal(f.calls.filter(x=>x[0]==='/submit').length,1);assert.equal(f.controller.inputLocked,true);assert.equal(f.button('Create coin').hidden,true);
 state='confirmed';await f.controller.reconcile();assert.equal(f.root.querySelector('dl').hidden,true);assert.equal(f.button('Check confirmation').hidden,true);const link=[...f.root.querySelectorAll('a')].find(x=>x.textContent==='Open coin →');assert.equal(link.hidden,false);assert.equal(link.className,'primary');assert.equal(f.controller.canLeave(),true);
 state='finalized';await f.controller.reconcile();f.controller.schedulePrepare(0);await f.advance();await f.controller.prepare({action:'initialize',amountRaw:'0'});await f.button('Create coin').onclick();assert.equal(f.calls.filter(x=>x[0]==='/prepare').length,1);assert.equal(f.calls.filter(x=>x[0]==='sign').length,1);assert.equal(f.button('Create coin').hidden,true);assert.equal(f.button('Check confirmation').hidden,true);f.controller.destroy();
});

test('typing during preparation cancels the stale unsigned plan before preparing only the latest amount',async()=>{
 let resolveFirst,prepares=0,current=operation();const f=launchFixture({request:async(path,body)=>{if(path==='/prepare'){prepares++;current=operation({id:'operation-'+prepares});if(prepares===1)return await new Promise(resolve=>resolveFirst=resolve);return{operation:current};}if(path==='/cancel')return{operation:{...current,state:'cancelled'}};return{operation:current};}});
 f.controller.schedulePrepare(0);await f.advance();assert.equal(prepares,1);assert.equal(f.controller.inputLocked,false);f.setAmount('200000000');f.controller.schedulePrepare(400);f.setAmount('300000000');f.controller.schedulePrepare(400);await f.advance(400);assert.equal(prepares,1);assert.equal(f.button('Create coin').disabled,true);
 resolveFirst({operation:current});for(let i=0;i<20;i++)await Promise.resolve();await f.advance(400);assert.equal(prepares,2);assert.deepEqual(f.calls.filter(x=>x[0]==='/prepare').map(x=>x[1].amountRaw),['100000000','300000000']);assert.deepEqual(f.calls.filter(x=>x[0]!=='sign').map(x=>x[0]),['/prepare','/cancel','/prepare']);assert.equal(f.button('Create coin').disabled,false);assert.equal(f.calls.some(x=>x[0]==='sign'),false);f.controller.destroy();
});

test('expired launch review refreshes only on Create, then signs the fresh plan once',async()=>{
 let counter=0,current;const f=launchFixture({request:path=>{if(path==='/prepare'){current=operation({id:'operation-'+(++counter),expiresAt:f.now()+10000});return{operation:current};}if(path==='/cancel')return{operation:{...current,state:'cancelled'}};if(path==='/submit')return{operation:{...current,state:'submitted'}};}});
 f.controller.schedulePrepare(0);await f.advance();await f.advance(11000);assert.equal(counter,1);assert.equal(f.pendingDelays(),0);await f.button('Create coin').onclick();assert.equal(counter,2);assert.equal(f.calls.filter(x=>x[0]==='sign').length,1);assert.equal(f.calls.find(x=>x[0]==='sign')[1].operationId,'operation-2');assert.equal(f.calls.filter(x=>x[0]==='/submit').length,1);f.controller.destroy();
});

test('reset while an automatic preparation is waiting cannot cancel or replace a new review',async()=>{
 let resolve,prepares=0;const f=launchFixture({request:path=>{if(path==='/prepare'&&++prepares===1)return new Promise(r=>resolve=r);return{operation:operation({id:'operation-new'})};}});
 f.controller.schedulePrepare(0);await f.advance();f.controller.reset();f.controller.schedulePrepare(0);await f.advance();assert.equal(f.controller.operation.id,'operation-new');resolve({operation:operation({id:'operation-old'})});for(let i=0;i<20;i++)await Promise.resolve();await f.advance(1000);assert.equal(f.controller.operation.id,'operation-new');assert.equal(f.calls.some(x=>x[0]==='/cancel'),false);assert.equal(prepares,2);f.controller.destroy();
});
