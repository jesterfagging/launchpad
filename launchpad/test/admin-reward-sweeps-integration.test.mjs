import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Launchpad} from '../src/launchpad.mjs';
import {LaunchpadAdmin} from '../src/launchpad-admin.mjs';
import {AdminPanel} from '../src/admin-panel.mjs';
import {TelegramStore} from '../src/telegram-store.mjs';
import {newLaunchKeys} from '../src/launchpad-receipts.mjs';
import {launchInput,SOL_MINT} from '../public/launchpad-model.mjs';
import {TAX_CONVERSION_MAX_UNITS} from '../src/launchpad-tax-conversion.mjs';
import {recordTaxHarvest} from '../src/launchpad-tax-protocol.mjs';
import {activeRewardsFixture,rewardFixtureReceipt} from './helpers/rewards-wallet-fixture.mjs';

const ACTOR='a'.repeat(32),OWNER='b'.repeat(32),OTHER='c'.repeat(32),REQUEST='1'.repeat(32),ALIAS='2'.repeat(32),OLD='3'.repeat(32);
const TSLA='XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB',START=1700000000000,CAP=TAX_CONVERSION_MAX_UNITS;
const address=()=>newLaunchKeys().wallet.address;
function coin(id,quoteMint,quoteDecimals,base,quote){
 const input=launchInput({name:quoteMint===SOL_MINT?'Native reward':'Model reward',symbol:quoteMint===SOL_MINT?'NATIVE':'ALPHA',feeMode:'holders',quoteMint});input.taxBps=200;
 const keys=newLaunchKeys();keys.payer=newLaunchKeys().wallet;keys.platform=keys.wallet;
 return activeRewardsFixture({id:id.toString(16).padStart(32,'0'),input,keys,review:{minimumSol:'0.06',quoteDecimals,quoteSymbol:quoteMint===SOL_MINT?'SOL':'TSLAx',price:{usd:'500'},devBuy:{gross:'0'}},feeCustody:'relay',curve:address(),state:'live',phase:'verify',createdAt:START,authorizedAt:START,lastCycle:START,autoFees:false,feeAutomation:{enabled:false,source:'user',updatedAt:START},feesRequested:false,operations:[],credits:{base,quote},gas:{day:new Date(START).toISOString().slice(0,10),reserved:'0'}},START);
}
async function setup(t){
 const dir=await mkdtemp(join(tmpdir(),'bulk-worker-integration-')),secret=randomBytes(32),hostStore=new TelegramStore(join(dir,'host'),secret),stores=new Map();
 const users=new Map([[ACTOR,{id:ACTOR,role:'admin',mfaEnabled:true,username:'operator',mainWallet:address()}],[OTHER,{id:OTHER,role:'admin',mfaEnabled:true,username:'second',mainWallet:address()}],[OWNER,{id:OWNER,role:'user',mfaEnabled:true,username:'creator',mainWallet:address()}]]);
 const accounts={dir,hostStore,get:async id=>structuredClone(users.get(id)),list:async()=>structuredClone([...users.values()]),storeFor:id=>{if(!stores.has(id))stores.set(id,new TelegramStore(join(dir,id),secret));return stores.get(id);}};
 const native=coin(1,SOL_MINT,9,'0','1000'),tsla=coin(2,TSLA,8,(CAP+13n).toString(),'0');tsla.taxProtocol=recordTaxHarvest(tsla,CAP);tsla.visibility={hidden:true};
 await accounts.storeFor(OWNER).write('launchpad',{version:1,launches:[native,tsla]});await hostStore.write('launch-protocol-fees',{recipient:address(),recipientScope:'launchpad'});
 let now=START,manager,panel;const prepared=[],broadcasts=[],receipts=new Map(),holders=new Map([[native.id,address()],[tsla.id,address()]]);
 const chain={close(){},rewardsGasFundingPlan:async()=>({gasLamports:'0',ready:true}),rewardHandoffInstructions:async()=>assert.fail('Active custody does not need a handoff'),claimInstructions:async()=>[],holderSnapshot:async l=>({slot:100,rows:[{owner:holders.get(l.id),amount:'1'}]}),payoutInstructions:async(_,rows)=>rows,holderRewardReference:async()=>assert.fail('Manual payouts cannot require a price threshold'),taxConversionPlan:async(_,credit)=>({amount:(BigInt(credit)<CAP?BigInt(credit):CAP).toString()}),swapFeeInstructions:async()=>['sale'],receipt:async op=>receipts.get(op.signature)||null,c:{getBlockHeight:async()=>1},prepare:async(l,instructions,_extra,_initial,{operation})=>{const signature=`saved-${prepared.length+1}`;prepared.push({id:l.id,kind:operation.kind,amount:operation.amount,instructions,signature});return{state:'pending',signature,raw:`bytes-${signature}`,createdAt:now,lastValidBlockHeight:100};},broadcast:async op=>{const book=await accounts.storeFor(OWNER).read('launchpad');assert(book.launches.some(l=>l.operations.some(saved=>saved.signature===op.signature&&saved.raw===op.raw)));broadcasts.push(op.signature);}};
 const restart=async()=>{await panel?.close();await manager?.close();manager=new Launchpad(accounts,null,{chainFactory:()=>chain,now:()=>now});manager.kick=()=>{};const launchAdmin=new LaunchpadAdmin({accounts,launchpad:manager,now:()=>now});panel=new AdminPanel({accounts,launchpad:manager,launchAdmin,now:()=>now});panel.rewardSweeps.kick=()=>{};};await restart();
 t.after(async()=>{await panel.close();await manager.close();await rm(dir,{recursive:true,force:true});});
 return{accounts,users,prepared,broadcasts,receipts,holders,restart,native,tsla,get manager(){return manager;},get panel(){return panel;},advance(ms=15001){now+=ms;},book:()=>accounts.storeFor(OWNER).read('launchpad'),async status(){return(await panel.readRewardSweeps(ACTOR)).job;},async confirmPending(){const book=await this.book();for(const l of book.launches){const op=l.operations.find(op=>op.state==='pending');if(!op)continue;const selling=op.kind==='sell';assert(selling||op.kind==='payout'||op.kind==='tax-protocol-payout',`Unexpected ${op.kind}`);receipts.set(op.signature,rewardFixtureReceipt(l,{operation:op,quote:selling?(op.taxSource==='withheld-tax'?100n:20n):-BigInt(op.amount),base:selling?-BigInt(op.amount):0n}));}await manager.process(OWNER);}};
}

test('bulk parent drives SOL and hidden base-only TSLAx workers, survives pending restart and replay without duplicate payouts',async t=>{
 const h=await setup(t);
 // Keep the original held-SOL request genuinely pending while the independent
 // all-assets parent queues its new manual work behind the same transaction.
 await h.manager.queueHeldSolDistribution(ACTOR,{accountId:OWNER,id:h.native.id,mint:h.native.keys.mint.address,requestId:OLD});await h.manager.process(OWNER);
 let book=await h.book();const old=structuredClone(book.launches[0].operations[0]);assert.equal(old.kind,'payout');assert.equal(old.amount,'1000');
 const oldIndex={version:1,latest:'f'.repeat(32),requests:{}};await h.accounts.hostStore.write('admin-holder-distributions',oldIndex);
 await h.panel.distributeAllRewardSweeps(ACTOR,{requestId:REQUEST});await h.panel.rewardSweeps.process();await h.panel.rewardSweeps.process();
 let job=await h.status();assert.equal(job.items.length,2);assert(job.items.every(row=>row.manualRequestId));assert.equal(job.items.find(row=>row.quoteMint===TSLA).quoteDecimals,8);
 const alias=await h.panel.distributeAllRewardSweeps(ACTOR,{requestId:ALIAS});assert.equal(alias.alreadyRequested,true);assert.equal(alias.job.requestId,REQUEST);
 await assert.rejects(h.panel.distributeAllRewardSweeps(OTHER,{requestId:REQUEST}),/another administrator/);
 for(let i=0;i<3&&!h.prepared.some(row=>row.kind==='sell');i++)await h.manager.process(OWNER);
 book=await h.book();assert.deepEqual(book.launches[0].operations[0],old);assert.equal(book.launches[1].operations[0].kind,'sell');
 const beforeRestart=structuredClone(book),prepared=h.prepared.length;await h.restart();await h.manager.process(OWNER);await h.panel.rewardSweeps.process();
 assert.equal(h.prepared.length,prepared);book=await h.book();for(let i=0;i<2;i++)assert.deepEqual(book.launches[i].operations,beforeRestart.launches[i].operations);
 for(let i=0;i<30;i++){await h.confirmPending();await h.manager.process(OWNER);h.advance();await h.panel.rewardSweeps.process();job=await h.status();if(job.state==='completed')break;}
 assert.equal(job.state,'completed');assert.equal(job.counts.completed,2);book=await h.book();
 for(const l of book.launches){assert.deepEqual(l.credits,{base:'0',quote:'0'});assert.equal(l.manualHolderDistribution.state,'completed');assert.equal(l.feeAutomation.enabled,false);assert(l.operations.every(op=>op.state==='confirmed'));}
 const native=book.launches[0],tsla=book.launches[1];assert.equal(native.operations.filter(op=>op.kind==='payout').length,1);assert.equal(native.heldSolDistribution.paidLamports,'1000');
 assert.deepEqual(tsla.operations.filter(op=>op.kind==='sell').map(op=>op.amount),[CAP.toString(),'13']);assert.equal(tsla.operations.find(op=>op.kind==='tax-protocol-payout').amount,'5');assert.equal(tsla.operations.find(op=>op.kind==='payout').amount,'115');
 const row=job.items.find(row=>row.quoteMint===TSLA);assert.equal(row.remainingBaseUnits,'0');assert.equal(row.remainingQuoteUnits,'0');assert.equal(row.distributedQuoteUnits,'115');assert.equal(new Set(h.prepared.map(row=>row.signature)).size,h.prepared.length);
 const final=structuredClone(book),count=h.prepared.length;await h.restart();for(const requestId of[REQUEST,ALIAS]){const replay=await h.panel.distributeAllRewardSweeps(ACTOR,{requestId});assert.equal(replay.alreadyRequested,true);assert.equal(replay.job.requestId,REQUEST);}
 await h.manager.process(OWNER);await h.panel.rewardSweeps.process();assert.equal(h.prepared.length,count);assert.deepEqual(await h.book(),final);assert.deepEqual(await h.accounts.hostStore.read('admin-holder-distributions'),oldIndex);
});
