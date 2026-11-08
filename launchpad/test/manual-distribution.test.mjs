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
import {TAX_CONVERSION_MAX_UNITS} from '../src/launchpad-tax-conversion.mjs';
import {recordTaxHarvest} from '../src/launchpad-tax-protocol.mjs';
import {activeRewardsFixture,rewardFixtureReceipt,rewardFixtureHandoffReceipt} from './helpers/rewards-wallet-fixture.mjs';
const START=1700000000000,ADMIN='c'.repeat(32),cap=TAX_CONVERSION_MAX_UNITS,address=()=>newLaunchKeys().wallet.address;
async function harness(t,{base='0',quote='0',tax='0',cycle,auto=false,legacy=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'manual-rewards-'));let now=START;
 const input=launchInput({name:'Rewards',symbol:'RWD',feeMode:'holders',quoteMint:USDC_MINT}),keys=newLaunchKeys();keys.payer=newLaunchKeys().wallet;keys.platform=keys.wallet;input.taxBps=200;
 const initial=activeRewardsFixture({id:'a'.repeat(32),input,keys,review:{minimumSol:'0.06',quoteDecimals:6,price:{usd:'1'},devBuy:{gross:'0'}},feeCustody:'relay',curve:address(),state:'live',phase:'verify',createdAt:START,authorizedAt:START,lastCycle:START,autoFees:auto,feeAutomation:{enabled:auto,source:'user',updatedAt:START},feesRequested:false,operations:[],credits:{quote,base},gas:{day:new Date(START).toISOString().slice(0,10),reserved:'0'},...(cycle?{cycle}:{} )},START);
 if(tax!=='0')initial.taxProtocol=recordTaxHarvest({...initial,credits:{quote,base}},BigInt(tax));
 if(legacy){delete initial.rewardsWallet;delete initial.keys.rewards;}
 const books=new Map([['a:launchpad',{version:1,launches:[initial]}]]),receipts=new Map(),prepared=[],broadcasts=[],plans=[],holder=address();
 const accounts={dir,hostStore:{read:async(name,fallback)=>name==='launch-protocol-fees'?{recipient:address(),recipientScope:'launchpad'}:fallback},get:async id=>({mainWallet:keys.payer.address,...(id===ADMIN?{id:ADMIN,role:'admin',mfaEnabled:true}:{})}),storeFor:id=>({dir:join(dir,id),read:async(key,fallback)=>structuredClone(books.get(id+':'+key)||fallback),write:async(key,value)=>books.set(id+':'+key,structuredClone(value))})};
 const c={close(){},rewardsGasFundingPlan:async()=>({gasLamports:'0',ready:true}),rewardHandoffInstructions:async()=>['handoff'],claimInstructions:async()=>[],holderSnapshot:async()=>({slot:100,rows:[{owner:holder,amount:'1'}]}),payoutInstructions:async(_,rows)=>rows,holderRewardReference:async()=>{throw Error('Manual payouts must not require a USD price');},taxConversionPlan:async(_,credit)=>{plans.push(credit);return {amount:(BigInt(credit)<cap?BigInt(credit):cap).toString()};},swapFeeInstructions:async()=>['sell'],receipt:async op=>receipts.get(op.signature)||null,c:{getBlockHeight:async()=>1},prepare:async(l,instructions)=>{const signature='signature-'+(prepared.length+1);prepared.push(instructions);return {state:'pending',signature,raw:'raw-'+signature,createdAt:now,lastValidBlockHeight:100};},broadcast:async op=>{assert(books.get('a:launchpad').launches[0].operations.some(row=>row.signature===op.signature));broadcasts.push(op.signature);}};
 let manager;const restart=async()=>{await manager?.close();manager=new Launchpad(accounts,null,{chainFactory:()=>c,now:()=>now});manager.kick=()=>{};};await restart();
 t.after(async()=>{await manager.close();await rm(dir,{recursive:true,force:true});});
 const h={c,plans,prepared,broadcasts,books,receipts,holder,restart,get manager(){return manager;},get saved(){return books.get('a:launchpad').launches[0];},advance(ms){now+=ms;},async edit(fn){await manager.locked('a',async b=>{fn(b.launches[0]);await manager.save('a',b);});},async queue(){await this.edit(l=>{let requestId=l.manualHolderDistribution&&['queued','processing','waiting','blocked'].includes(l.manualHolderDistribution.state)?l.manualHolderDistribution.requestId:'request-'+(l.adminRewardHistory?.length||0);if(requestId!==l.holderDistributionAdminRequest){l.holderDistributionAdminRequest=requestId;l.adminRewardHistory=[...(l.adminRewardHistory||[]),{requestId,actorId:ADMIN,launchId:l.id,action:'distribute'}];}queueManualHolderDistribution(l,requestId,now);});},async step(){await manager.process('a');},async pending(){for(let i=0;i<8;i++){if(this.saved.operations.some(op=>op.state==='pending'))return this.saved.operations.find(op=>op.state==='pending');await this.step();}return null;},async confirm(quoteDelta=0n,baseDelta=0n,{failed=false}={}){const l=this.saved,op=l.operations.find(x=>x.state==='pending');assert(op);const tx=op.kind==='reward-handoff'?rewardFixtureHandoffReceipt(l,op):rewardFixtureReceipt(l,{quote:quoteDelta,base:baseDelta,err:failed?{InstructionError:[0,'SlippageExceeded']}:null});receipts.set(op.signature,tx);await this.step();}};
 return h;
}
test('manual request sells finite snapshot across guarded clips without cooldown, survives restart and pays tiny SPL quote',async t=>{
 const h=await harness(t,{base:(2n*cap+7n).toString(),quote:'1'});await h.queue();
 for(const amount of [cap,cap,7n]){const op=await h.pending();assert.equal(op.kind,'sell');assert.equal(op.amount,amount.toString());await h.restart();await h.step();assert.equal(h.prepared.length,h.broadcasts.length);await h.confirm(1n,-amount);}
 const op=await h.pending();assert.equal(op.kind,'payout');assert.equal(op.amount,'4');await h.confirm(-4n);await h.step();
 assert.equal(h.saved.manualHolderDistribution.state,'completed');assert.equal(h.saved.credits.base,'0');assert.equal(h.saved.credits.quote,'0');assert.equal(h.saved.autoFees,false);assert.equal(h.saved.feeAutomation.enabled,false);assert.equal(h.plans.length,3);
 await h.restart();await h.step();assert.equal(h.prepared.length,4);
});
test('a sweep with no eligible holders preserves its quote credit and reports the actual reason',async t=>{
 const h=await harness(t,{quote:'123456'});h.c.holderSnapshot=async()=>({slot:100,rows:[]});await h.queue();
 for(let n=0;n<5&&h.saved.manualHolderDistribution.state!=='partial';n++)await h.step();
 assert.equal(h.saved.manualHolderDistribution.state,'partial');assert.equal(h.saved.credits.quote,'123456');assert.equal(h.prepared.length,0);
 assert.match(h.saved.manualHolderDistribution.reason,/No eligible holders/);
});
test('manual snapshot excludes subsequent inflows and drains isolated tax then ordinary base with exact protocol split',async t=>{
 const h=await harness(t,{base:(cap+13n).toString(),tax:cap.toString()});await h.queue();const first=await h.pending();assert.equal(first.taxSource,'withheld-tax');
 await h.edit(l=>{l.credits.base=(BigInt(l.credits.base)+99n).toString();});await h.confirm(100n,-cap);
 const second=await h.pending();assert.equal(second.kind,'sell');assert.equal(second.taxSource,undefined);assert.equal(second.amount,'13');await h.confirm(20n,-13n);
 const protocol=await h.pending();assert.equal(protocol.kind,'tax-protocol-payout');assert.equal(protocol.amount,'5');await h.confirm(-5n);
 const payout=await h.pending();assert.equal(payout.amount,'115');await h.confirm(-115n);await h.step();assert.equal(h.saved.credits.base,'99');assert.equal(h.saved.manualHolderDistribution.state,'completed');
});
test('existing partly paid allocation finishes before fresh sweep and fresh quote allocation',async t=>{
 const oldHolder=address(),h=await harness(t,{base:'9',quote:'2',cycle:{stage:'payout',id:'older',index:1,payouts:[{owner:address(),amount:'5'},{owner:oldHolder,amount:'2'}],distributedQuoteUnits:'5',lastPayoutAt:START-1,holderRewardChecked:true}});await h.queue();
 const old=await h.pending();assert.equal(old.kind,'payout');assert.deepEqual(old.payouts,[{owner:oldHolder,amount:'2'}]);await h.confirm(-2n);await h.step();assert.equal(h.saved.holderRewards.lastDistributionQuoteUnits,'7');
 const sale=await h.pending();assert.equal(sale.kind,'sell');assert.equal(sale.amount,'9');await h.confirm(1n,-9n);const payout=await h.pending();assert.deepEqual(payout.payouts,[{owner:h.holder,amount:'1'}]);await h.confirm(-1n);await h.step();assert.equal(h.saved.manualHolderDistribution.state,'completed');
});
test('TSLAx eight-decimal sweep preserves the existing payout then converts every tax and legacy clip below the USD minimum',async t=>{
 const quoteMint='XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB',oldPaid=address(),oldUnpaid=address();
 const h=await harness(t,{base:(2n*cap+13n).toString(),tax:(cap+7n).toString(),quote:'2',cycle:{stage:'payout',id:'existing-tslax',index:1,payouts:[{owner:oldPaid,amount:'5'},{owner:oldUnpaid,amount:'2'}],distributedQuoteUnits:'5',lastPayoutAt:START-1,holderRewardChecked:true}});
 await h.edit(l=>{l.input.quoteMint=quoteMint;l.review.quoteDecimals=8;l.review.price.usd='500';});
 const payoutChain=new LaunchChain({network:'mainnet-beta',connection:{}}),checkedTransfers=[];
 h.c.payoutInstructions=async(l,rows,options)=>{
  const instructions=await payoutChain.payoutInstructions(l,rows,options);
  for(const ix of instructions.filter(ix=>ix.programId.equals(TOKEN_PROGRAM_ID)&&ix.data[0]===12)){
   const transfer=decodeTransferCheckedInstruction(ix);assert.equal(transfer.keys.mint.pubkey.toBase58(),quoteMint);assert.equal(transfer.data.decimals,8);assert.equal(transfer.keys.owner.pubkey.toBase58(),l.keys.rewards.address);checkedTransfers.push(transfer.data.amount.toString());
  }
  return instructions;
 };
 const originalPlan=h.c.taxConversionPlan;h.c.taxConversionPlan=async(l,credit)=>{assert.equal(l.input.quoteMint,quoteMint);assert.equal(l.review.quoteDecimals,8);return originalPlan(l,credit);};
 await h.queue();const old=await h.pending();assert.equal(old.kind,'payout');assert.deepEqual(old.payouts,[{owner:oldUnpaid,amount:'2'}]);assert.equal(h.plans.length,0);await h.confirm(-2n);
 for(const [amount,quote,taxed] of [[cap,100n,true],[7n,20n,true],[cap,30n,false],[6n,1n,false]]){
  const sale=await h.pending();assert.equal(sale.kind,'sell');assert.equal(sale.amount,amount.toString());assert.equal(sale.taxSource,taxed?'withheld-tax':undefined);await h.confirm(quote,-amount);
 }
 const protocol=await h.pending();assert.equal(protocol.kind,'tax-protocol-payout');assert.equal(protocol.amount,'6');await h.confirm(-6n);
 const payout=await h.pending();assert.equal(payout.kind,'payout');assert.deepEqual(payout.payouts,[{owner:h.holder,amount:'145'}]);assert(145n*500n<100n*100000000n);await h.confirm(-145n);await h.step();
 assert.deepEqual(checkedTransfers,['2','6','145']);assert.deepEqual(h.saved.credits,{base:'0',quote:'0'});assert.equal(h.saved.taxProtocol.sourceBaseCredit,'0');assert.equal(h.saved.taxProtocol.paidQuote,'6');assert.equal(h.saved.manualHolderDistribution.soldBaseUnits,(2n*cap+13n).toString());assert.equal(h.saved.manualHolderDistribution.distributedQuoteUnits,'145');assert.equal(h.saved.manualHolderDistribution.state,'completed');assert.equal(h.saved.operations.filter(op=>op.kind==='payout').length,2);
});
test('manual funding and market waits retry while automatic preference stays disabled',async t=>{
 const h=await harness(t,{base:'9'});let fail=true;h.c.swapFeeInstructions=async()=>{if(fail)throw Object.assign(Error('Insufficient SOL for network fee'),{code:'REWARD_SOL_REQUIRED'});return ['sell'];};await h.queue();await h.step();await h.step();
 assert.equal(h.saved.manualHolderDistribution.state,'waiting');assert.equal(h.saved.rewardRetry.kind,'funding');assert.equal(h.saved.autoFees,false);await h.restart();await h.step();assert.equal(h.prepared.length,0);
 fail=false;h.advance(300001);assert.equal((await h.pending()).kind,'sell');await h.confirm(1n,-9n);assert.equal((await h.pending()).kind,'payout');
});
test('successful saved sale settles once while an explicit manual pause prevents continuation',async t=>{
 const h=await harness(t,{base:(2n*cap).toString()});await h.queue();await h.pending();await h.edit(l=>{l.manualHolderDistribution.state='blocked';l.manualHolderDistribution.pausedByAdmin=true;l.state='paused';l.feesRequested=false;});await h.confirm(2n,-cap);await h.step();
 assert.equal(h.saved.manualHolderDistribution.state,'blocked');assert.equal(h.saved.state,'paused');assert.equal(h.prepared.length,1);assert.equal(h.saved.manualHolderDistribution.soldBaseUnits,cap.toString());
 await h.queue();assert.equal((await h.pending()).amount,cap.toString());assert.equal(h.saved.manualHolderDistribution.pausedByAdmin,undefined);
});
test('zero executable amount distributes quote and reports partial unsold base',async t=>{
 const h=await harness(t,{base:'1',quote:'1'});h.c.taxConversionPlan=async()=>({amount:'0'});await h.queue();const op=await h.pending();assert.equal(op.kind,'payout');await h.confirm(-1n);await h.step();assert.equal(h.saved.manualHolderDistribution.state,'partial');assert.equal(h.saved.manualHolderDistribution.remainingBaseUnits,'1');assert.match(h.saved.manualHolderDistribution.reason,/cannot currently produce/);
});
test('hard source mismatch blocks manual request without retry or mutation of balances',async t=>{
 const h=await harness(t,{base:'1'});h.c.taxConversionPlan=async()=>{throw Object.assign(Error('Mint authority mismatch'),{status:503});};await h.queue();await h.step();await h.step();assert.equal(h.saved.manualHolderDistribution.state,'blocked');assert.equal(h.saved.rewardRetry,undefined);assert.equal(h.saved.credits.base,'1');assert.equal(h.prepared.length,0);
});
test('legacy creator inventory is handed off before a manual sweep snapshot and payout',async t=>{
 const h=await harness(t,{base:'9',quote:'1',legacy:true});await h.queue();assert.equal((await h.pending()).kind,'reward-handoff');await h.confirm();assert.equal((await h.pending()).kind,'sell');await h.confirm(1n,-9n);assert.equal((await h.pending()).amount,'2');await h.confirm(-2n);await h.step();assert.equal(h.saved.manualHolderDistribution.state,'completed');
});
test('official burn selection records a reserved exclusion rather than a conversion remainder',async t=>{
 const h=await harness(t,{base:'9'});await h.queue();await h.edit(l=>{l.cycle={stage:'route',index:0,manualHolderDistributionRequest:l.holderDistributionAdminRequest};snapshotManualHolderBase(l,START,{burnOnly:true});});const r=h.saved.manualHolderDistribution;assert.equal(r.remainingBaseUnits,'0');assert.equal(r.remainingTaxBaseUnits,'0');assert.equal(r.reservedForBurnBaseUnits,'9');
});
test('unexecutable tax dust does not prevent conversion of the ordinary reward source',async t=>{
 const h=await harness(t,{base:'10',tax:'1'});h.c.taxConversionPlan=async(_,credit)=>({amount:credit==='1'?'0':credit});await h.queue();const op=await h.pending();assert.equal(op.kind,'sell');assert.equal(op.taxSource,undefined);assert.equal(op.amount,'9');await h.confirm(1n,-9n);assert.equal((await h.pending()).kind,'payout');await h.confirm(-1n);await h.step();assert.equal(h.saved.manualHolderDistribution.state,'partial');assert.equal(h.saved.manualHolderDistribution.remainingTaxBaseUnits,'1');
});
test('post-fee dust pays quote while unavailable pool remains a retryable manual request',async t=>{
 for(const waiting of [false,true]){
  const h=await harness(t,{base:'1',quote:'1'});if(waiting)h.c.taxConversionPlan=async()=>({amount:'0',waiting:true,reason:'Waiting for the graduated pool.'});else h.c.swapFeeInstructions=async()=>{throw Object.assign(Error('Tax conversion is too small after fees and will be checked again later.'),{code:'TAX_CONVERSION_DEFERRED'});};await h.queue();await h.step();await h.step();
  if(waiting){assert.equal(h.saved.manualHolderDistribution.state,'waiting');assert.equal(h.saved.rewardRetry.kind,'market');assert.equal(h.prepared.length,0);}else{assert.equal((await h.pending()).kind,'payout');await h.confirm(-1n);await h.step();assert.equal(h.saved.manualHolderDistribution.state,'partial');}
 }
});
test('failed saved conversion retries the same snapshot after backoff without enabling automation or debiting twice',async t=>{
 const h=await harness(t,{base:'9'});await h.queue();const failed=await h.pending();await h.confirm(0n,0n,{failed:true});assert.equal(h.saved.operations[0].state,'failed');assert.equal(h.saved.credits.base,'9');assert.equal(h.saved.manualHolderDistribution.remainingBaseUnits,'9');assert.equal(h.saved.cycle.stage,'route');assert.equal(h.saved.rewardRetry.kind,'transaction');assert.equal(h.saved.autoFees,false);
 await h.restart();await h.step();assert.equal(h.prepared.length,1);h.advance(30001);const retry=await h.pending();assert.equal(retry.kind,'sell');assert.notEqual(retry.signature,failed.signature);assert.equal(retry.amount,'9');await h.confirm(1n,-9n);assert.equal(h.saved.manualHolderDistribution.soldBaseUnits,'9');assert.equal((await h.pending()).kind,'payout');await h.confirm(-1n);await h.step();assert.equal(h.saved.manualHolderDistribution.state,'completed');assert.equal(h.saved.credits.base,'0');
});
