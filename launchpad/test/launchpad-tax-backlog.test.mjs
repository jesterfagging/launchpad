import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Launchpad} from '../src/launchpad.mjs';
import {LaunchChain} from '../src/launchpad-chain.mjs';
import {decodeTransferCheckedInstruction,TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {newLaunchKeys} from '../src/launchpad-receipts.mjs';
import {launchInput,USDC_MINT} from '../public/launchpad-model.mjs';
import {queueManualHolderDistribution,snapshotManualHolderBase} from '../src/launchpad-manual-distribution.mjs';
import {TAX_CONVERSION_MAX_UNITS,TAX_CONVERSION_BACKLOG_UNITS,TAX_CONVERSION_BURST_POLICY,taxConversionAmount} from '../src/launchpad-tax-conversion.mjs';
import {recordTaxHarvest} from '../src/launchpad-tax-protocol.mjs';
import {activeRewardsFixture,rewardFixtureReceipt,rewardFixtureHandoffReceipt} from './helpers/rewards-wallet-fixture.mjs';
import {automaticTaxBacklog,feeCycleDueAt,taxConversionDueAt} from '../src/launchpad-holder-rewards.mjs';
const START=1700000000000,ADMIN='c'.repeat(32),cap=TAX_CONVERSION_MAX_UNITS,burst=TAX_CONVERSION_BACKLOG_UNITS,address=()=>newLaunchKeys().wallet.address;
async function harness(t,{base='0',quote='0',tax='0',cycle,auto=true,legacy=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'manual-rewards-'));let now=START;
 const input=launchInput({name:'Rewards',symbol:'RWD',feeMode:'holders',quoteMint:USDC_MINT}),keys=newLaunchKeys();keys.payer=newLaunchKeys().wallet;keys.platform=keys.wallet;input.taxBps=200;
 const initial=activeRewardsFixture({id:'a'.repeat(32),input,keys,review:{minimumSol:'0.06',quoteDecimals:6,price:{usd:'1'},devBuy:{gross:'0'}},feeCustody:'relay',curve:address(),state:'live',phase:'verify',createdAt:START,authorizedAt:START,lastCycle:START,autoFees:auto,feeAutomation:{enabled:auto,source:'user',updatedAt:START},feesRequested:false,operations:[],credits:{quote,base},gas:{day:new Date(START).toISOString().slice(0,10),reserved:'0'},...(cycle?{cycle}:{} )},START);
 if(tax!=='0')initial.taxProtocol=recordTaxHarvest({...initial,credits:{quote,base}},BigInt(tax));
 if(legacy){delete initial.rewardsWallet;delete initial.keys.rewards;}
 const books=new Map([['a:launchpad',{version:1,launches:[initial]}]]),receipts=new Map(),prepared=[],broadcasts=[],plans=[],holder=address();
 const accounts={dir,hostStore:{read:async(name,fallback)=>name==='launch-protocol-fees'?{recipient:address(),recipientScope:'launchpad'}:fallback},get:async id=>({mainWallet:keys.payer.address,...(id===ADMIN?{id:ADMIN,role:'admin',mfaEnabled:true}:{})}),storeFor:id=>({dir:join(dir,id),read:async(key,fallback)=>structuredClone(books.get(id+':'+key)||fallback),write:async(key,value)=>books.set(id+':'+key,structuredClone(value))})};
 const c={close(){},rewardsGasFundingPlan:async()=>({gasLamports:'0',ready:true}),rewardHandoffInstructions:async()=>['handoff'],claimInstructions:async()=>[],holderSnapshot:async()=>({slot:100,rows:[{owner:holder,amount:'1'}]}),payoutInstructions:async(_,rows)=>rows,holderRewardReference:async l=>({mint:l.input.quoteMint,usd:'1',at:now}),taxConversionPlan:async(_,credit,{policy='paced-v1'}={})=>{const maximum=policy===TAX_CONVERSION_BURST_POLICY?burst:cap;plans.push({credit,policy});return {amount:(BigInt(credit)<maximum?BigInt(credit):maximum).toString()};},swapFeeInstructions:async()=>['sell'],receipt:async op=>receipts.get(op.signature)||null,c:{getBlockHeight:async()=>1},prepare:async(l,instructions)=>{const signature='signature-'+(prepared.length+1);prepared.push(instructions);return {state:'pending',signature,raw:'raw-'+signature,createdAt:now,lastValidBlockHeight:100};},broadcast:async op=>{assert(books.get('a:launchpad').launches[0].operations.some(row=>row.signature===op.signature));broadcasts.push(op.signature);}};
 let manager;const restart=async()=>{await manager?.close();manager=new Launchpad(accounts,null,{chainFactory:()=>c,now:()=>now});manager.kick=()=>{};};await restart();
 t.after(async()=>{await manager.close();await rm(dir,{recursive:true,force:true});});
 const h={c,plans,prepared,broadcasts,books,receipts,holder,restart,get manager(){return manager;},get saved(){return books.get('a:launchpad').launches[0];},advance(ms){now+=ms;},async edit(fn){await manager.locked('a',async b=>{fn(b.launches[0]);await manager.save('a',b);});},async queue(){await this.edit(l=>{let requestId=l.manualHolderDistribution&&['queued','processing','waiting','blocked'].includes(l.manualHolderDistribution.state)?l.manualHolderDistribution.requestId:'request-'+(l.adminRewardHistory?.length||0);if(requestId!==l.holderDistributionAdminRequest){l.holderDistributionAdminRequest=requestId;l.adminRewardHistory=[...(l.adminRewardHistory||[]),{requestId,actorId:ADMIN,launchId:l.id,action:'distribute'}];}queueManualHolderDistribution(l,requestId,now);});},async step(){await manager.process('a');},async pending(){for(let i=0;i<8;i++){if(this.saved.operations.some(op=>op.state==='pending'))return this.saved.operations.find(op=>op.state==='pending');await this.step();}return null;},async confirm(quoteDelta=0n,baseDelta=0n,{failed=false}={}){const l=this.saved,op=l.operations.find(x=>x.state==='pending');assert(op);const tx=op.kind==='reward-handoff'?rewardFixtureHandoffReceipt(l,op):rewardFixtureReceipt(l,{quote:quoteDelta,base:baseDelta,err:failed?{InstructionError:[0,'SlippageExceeded']}:null});receipts.set(op.signature,tx);await this.step();}};
 return h;
}
test('exactly ten million accounted base tokens schedules one ten-million sale immediately',async t=>{
 const h=await harness(t,{base:burst.toString(),quote:'1'});assert.equal(automaticTaxBacklog(h.saved),true);assert.equal(feeCycleDueAt(h.saved),0);assert.equal(taxConversionDueAt(h.saved),0);
 const op=await h.pending();assert.equal(op.kind,'sell');assert.equal(op.amount,burst.toString());assert.equal(op.taxConversionPolicy,TAX_CONVERSION_BURST_POLICY);assert.deepEqual(h.plans,[{credit:burst.toString(),policy:TAX_CONVERSION_BURST_POLICY}]);await h.confirm(100n,-burst);await h.step();assert.equal(h.saved.credits.base,'0');assert.equal(h.saved.credits.quote,'101');assert.equal(h.saved.cycle,null);assert.equal(h.prepared.length,1,'automatic quote payouts retain their hourly/$100 floor');
});
test('twenty-one million becomes two sequential ten-million sales then normal one-million cadence',async t=>{
 const h=await harness(t,{base:(21n*cap).toString()});for(let i=0;i<2;i++){const op=await h.pending();assert.equal(op.amount,burst.toString());assert.equal(op.taxConversionPolicy,TAX_CONVERSION_BURST_POLICY);await h.confirm(100n,-burst);}await h.step();assert.equal(h.saved.credits.base,cap.toString());assert.equal(h.prepared.length,2);assert.equal(automaticTaxBacklog(h.saved),false);
 await h.restart();await h.step();assert.equal(h.prepared.length,2);h.advance(299999);await h.step();assert.equal(h.prepared.length,2);h.advance(1);const normal=await h.pending();assert.equal(normal.amount,cap.toString());assert.equal(normal.taxConversionPolicy,'paced-v1');
});
test('below ten million and quote balances do not trigger an early sale; one-million limit remains the default',async t=>{
 const h=await harness(t,{base:(burst-1n).toString(),quote:(100n*burst).toString()});assert.equal(automaticTaxBacklog(h.saved),false);await h.step();assert.equal(h.prepared.length,0);h.advance(300000);assert.equal((await h.pending()).amount,cap.toString());
 const normal=taxConversionAmount(30n*cap,598734261904415n),fast=taxConversionAmount(30n*cap,598734261904415n,{policy:TAX_CONVERSION_BURST_POLICY});assert.equal(normal.amount,cap.toString());assert.equal(normal.maxPriceImpactBps,50);assert.equal(fast.amount,burst.toString());assert(fast.priceImpactBps<=500);assert.equal(fast.maxPriceImpactBps,500);
});
test('saved pending ten-million signature survives restart without preparing or broadcasting another sale',async t=>{
 const h=await harness(t,{base:(21n*cap).toString()});const op=await h.pending();await h.restart();for(let n=0;n<4;n++)await h.step();assert.equal(h.prepared.length,1);assert.equal(h.broadcasts.length,1);assert.equal(h.saved.operations[0].signature,op.signature);await h.confirm(100n,-burst);const next=await h.pending();assert.notEqual(next.signature,op.signature);assert.equal(next.amount,burst.toString());
});
test('mixed tax and ordinary base are sold in one exact ten-million transaction with receipt-proportional tax fee',async t=>{
 const h=await harness(t,{base:(15n*cap).toString(),tax:(7n*cap).toString()});const op=await h.pending();assert.equal(op.amount,burst.toString());assert.equal(op.taxSource,'mixed-earned');assert.equal(op.taxBaseUnits,(7n*cap).toString());assert.equal(op.ordinaryBaseUnits,(3n*cap).toString());await h.confirm(100n,-burst);assert.equal(h.saved.credits.base,(5n*cap).toString());assert.equal(h.saved.credits.quote,'97');assert.equal(h.saved.taxProtocol.creditQuote,'3');assert.equal(h.saved.taxProtocol.convertedBase,(7n*cap).toString());assert.equal(h.saved.taxProtocol.convertedQuote,'70');assert.equal(h.saved.operations[0].taxProtocolReceipt.ordinaryQuoteUnits,'30');const audit=h.saved.operations[0].taxProtocolReceipt;assert.equal(audit.holderQuoteUnits,'67');assert.equal(BigInt(audit.quoteUnits),BigInt(audit.holderQuoteUnits)+BigInt(audit.protocolQuoteUnits));assert.equal(BigInt(h.saved.credits.quote),BigInt(audit.holderQuoteUnits)+BigInt(audit.ordinaryQuoteUnits));assert.equal((await h.pending()).kind,'tax-protocol-payout');
});
test('an unexecutable full burst waits with persistent backoff instead of silently splitting into small clips',async t=>{
 const h=await harness(t,{base:(12n*cap).toString()});let attempts=0;h.c.taxConversionPlan=async()=>{attempts++;return {amount:cap.toString()};};await h.step();await h.step();assert.equal(h.saved.rewardRetry.kind,'market');assert.match(h.saved.error,/waiting/);assert.equal(h.saved.cycle.stage,'route');assert.equal(h.saved.cycle.taxConversionAttempted,false);assert.equal(h.prepared.length,0);await h.restart();for(let n=0;n<5;n++)await h.step();assert.equal(attempts,1);h.advance(30001);await h.step();assert.equal(attempts,2);assert.equal(h.prepared.length,0);
});
test('explicit pause, disabled automation, hard errors and official burn reservations cannot activate burst sales',async t=>{
 for(const kind of ['paused','disabled','error','burn']){
  const h=await harness(t,{base:(12n*cap).toString()});await h.edit(l=>{if(kind==='paused')l.state='paused';if(kind==='disabled'){l.autoFees=false;l.feeAutomation.enabled=false;}if(kind==='error')l.state='error';if(kind==='burn')l.taxBurn={policy:'official-token-tax-burn-v1'};});assert.equal(automaticTaxBacklog(h.saved),false);await h.step();assert.equal(h.prepared.length,0);
 }
});
test('manual full sweep still consumes all inventory in its authorized one-million clips',async t=>{
 const h=await harness(t,{base:(11n*cap).toString()});await h.queue();for(let n=0;n<11;n++){const op=await h.pending();assert.equal(op.kind,'sell');assert.equal(op.amount,cap.toString());assert.equal(op.taxConversionPolicy,'paced-v1');await h.confirm(1n,-cap);}const payout=await h.pending();assert.equal(payout.kind,'payout');assert.equal(payout.amount,'11');await h.confirm(-11n);await h.step();assert.equal(h.saved.manualHolderDistribution.state,'completed');assert.equal(h.saved.credits.base,'0');
});
test('incorrect short burst receipt fails closed without consuming either source budget',async t=>{
 const h=await harness(t,{base:(15n*cap).toString(),tax:(7n*cap).toString()});await h.pending();await h.confirm(100n,-cap);assert.equal(h.saved.operations[0].state,'pending');assert.equal(h.saved.credits.base,(15n*cap).toString());assert.equal(h.saved.taxProtocol.convertedBase,'0');assert.equal(h.saved.rewardRetry,undefined);assert.match(h.saved.error,/exact authorized/);
});
