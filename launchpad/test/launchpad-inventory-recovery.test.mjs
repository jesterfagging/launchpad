import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Launchpad} from '../src/launchpad.mjs';
import {newLaunchKeys} from '../src/launchpad-receipts.mjs';
import {launchInput,USDC_MINT,SOL_MINT} from '../public/launchpad-model.mjs';
import {activeRewardsFixture} from './helpers/rewards-wallet-fixture.mjs';
import {recoverRewardInventory,rewardInventoryRecoveryDueAt,REWARD_INVENTORY_RECHECK_MS} from '../src/launchpad-inventory-recovery.mjs';

const NOW=Date.parse('2026-09-30T12:00:00Z');
const HANDOFF='The creator rewards token account cannot cover its saved credits.';
const BURN='LAUNCHPAD tax burn exceeds its verified rewards-wallet inventory.';
const ATA='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const ATA_ERROR=`Onchain simulation failed during fee processing (instruction 4, program ${ATA}): {"InstructionError":[4,{"Custom":1}]}.`;
const TSLA='XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';
const key=()=>newLaunchKeys().wallet.address;
function launch(error=HANDOFF){
  const keys=newLaunchKeys();keys.payer=newLaunchKeys().wallet;
  return activeRewardsFixture({id:'a'.repeat(32),input:{...launchInput({name:'Recovery',symbol:'RWD',feeMode:'holders',quoteMint:USDC_MINT}),taxBps:0},
    keys,curve:newLaunchKeys().mint.address,authorizedAt:NOW-4000000,createdAt:NOW-4000000,lastCycle:NOW-4000000,
    state:'paused',phase:'verify',autoFees:true,feesRequested:false,feeAutomation:{enabled:true,source:'admin',updatedAt:NOW-1000},error,feeCustody:'relay',
    review:{quoteDecimals:6,price:{usd:'1'}},operations:[{kind:'claim',state:'confirmed',signature:'previous-earned-claim',slot:90}],
    credits:{quote:'200000000',base:'0'},cycle:{stage:'payout',index:1,createdAt:NOW-2000,payouts:[{owner:key(),amount:'100000000'},{owner:key(),amount:'100000000'},{owner:key(),amount:'100000000'}]},
    gas:{day:'2026-09-30',reserved:'0'}},NOW);
}
function request(l,{paused=false}={}){
  const id='b'.repeat(32);l.holderDistributionAdminRequest=id;
  l.adminRewardHistory=[{requestId:id,action:'distribute',actorId:'admin',launchId:l.id}];
  l.manualHolderDistribution={version:1,requestId:id,state:'blocked',phase:'payout',reason:l.error,snapshotAt:NOW-2000,remainingBaseUnits:'0',remainingTaxBaseUnits:'0',soldBaseUnits:'1000',...(paused?{pausedByAdmin:true}:{})};
  l.cycle.manualHolderDistributionRequest=id;
}
function ataLaunch(){
  const l=launch(ATA_ERROR);l.input.quoteMint=TSLA;l.review.quoteDecimals=8;
  l.credits={quote:'17305842',base:'73419206851937'};l.cycle.payouts[0].amount='5';
  l.cycle.payouts[1].amount='10000000';l.cycle.payouts[2].amount='7305842';l.cycle.distributedQuoteUnits='5';l.cycle.id='saved-payout';l.cycle.holderRewardChecked=true;
  return l;
}

test('exact inventory revalidation resumes saved work without changing credits or payout prefix',async()=>{
  for(const error of [HANDOFF]){
    const l=launch(error);request(l);const before=structuredClone(l);let saves=0,reads=0;
    l.rewardRetry={at:NOW-1,reason:error};l.taxMaintenance={nextAt:NOW-1,retry:{at:NOW-1,reason:error}};
    const result=await recoverRewardInventory(l,{now:NOW,persist:async()=>{saves++;},read:async(copy,options)=>{reads++;assert.equal(options.error,error);assert.equal(saves,1);copy.credits.quote='0';return{slot:101};}});
    assert.equal(result,true);assert.equal(reads,1);assert.equal(saves,2);assert.equal(l.state,'live');assert.equal(l.feesRequested,true);assert.equal(l.error,'');
    for(const field of ['credits','cycle','operations','feeAutomation'])assert.deepEqual(l[field],before[field]);
    assert.equal(l.manualHolderDistribution.requestId,before.manualHolderDistribution.requestId);assert.equal(l.manualHolderDistribution.state,'processing');assert.equal(l.manualHolderDistribution.snapshotAt,before.manualHolderDistribution.snapshotAt);
    assert.equal(l.rewardRetry,undefined);assert.equal(l.taxMaintenance.retry,undefined);assert.equal(l.taxMaintenance.nextAt,NOW);assert.equal(l.rewardInventoryRecovery.verifiedSlot,101);
  }
});

test('a real shortfall stays paused and read-only retries are throttled across restored journals',async()=>{
  let l=launch(),reads=0,saves=0;const before=structuredClone(l);
  const run=now=>recoverRewardInventory(l,{now,persist:async()=>{saves++;},read:async()=>{reads++;throw Error(HANDOFF);}});
  assert.equal(await run(NOW),false);assert.equal(l.error,HANDOFF);assert.equal(l.state,'paused');assert.equal(l.feesRequested,false);
  for(const field of ['credits','cycle','operations','feeAutomation'])assert.deepEqual(l[field],before[field]);
  l=structuredClone(l);assert.equal(await run(NOW+59999),false);assert.equal(reads,1);assert.equal(saves,1);
  assert.equal(rewardInventoryRecoveryDueAt(l,NOW+59999),NOW+REWARD_INVENTORY_RECHECK_MS);
  assert.equal(await run(NOW+60000),false);assert.equal(reads,2);assert.equal(l.rewardInventoryRecovery.attempt,2);
});

test('explicit pauses, pending transactions, invalid custody and unrelated errors are untouched',async()=>{
  const patches=[l=>{l.feeAutomation.enabled=false;},l=>{request(l,{paused:true});},l=>{request(l);l.manualHolderDistribution.reason='Separate accounting review required.';},
    l=>{l.operations.push({kind:'payout',state:'pending',raw:'saved-signed-bytes'});},l=>{l.operations.push({kind:'payout',state:'awaiting_signature'});},
    l=>{l.keys.rewards.exportedAt=NOW;},l=>{l.rewardsWallet.creatorCredits.quote='200000001';},l=>{l.input.feeMode='buyback';},l=>{l.error=BURN;},l=>{l.error='Invalid reward accounting. '+HANDOFF;}];
  for(const patch of patches){const l=launch();patch(l);const before=structuredClone(l);
    assert.equal(await recoverRewardInventory(l,{now:NOW,persist:async()=>assert.fail('No write allowed'),read:async()=>assert.fail('No read allowed')}),false);
    assert.equal(rewardInventoryRecoveryDueAt(l,NOW),Infinity);assert.deepEqual(l,before);
  }
});

test('successful read preserves unrelated funding and tax retry schedules',async()=>{
  const l=launch();l.rewardRetry={reason:'Insufficient SOL',at:NOW+300000,kind:'funding'};l.taxMaintenance={nextAt:NOW+300000,retry:{reason:'RPC timeout',at:NOW+300000,kind:'network'}};
  const retry=structuredClone(l.rewardRetry),tax=structuredClone(l.taxMaintenance);
  await recoverRewardInventory(l,{now:NOW,persist:async()=>{},read:async()=>({slot:101})});assert.deepEqual(l.rewardRetry,retry);assert.deepEqual(l.taxMaintenance,tax);
});

test('unverified read evidence and a closed worker cannot clear the original stop',async()=>{
  for(const options of [{evidence:{}},{evidence:{slot:0}},{evidence:{slot:101},closed:true}]){
    const l=launch();await recoverRewardInventory(l,{now:NOW,persist:async()=>{},read:async()=>options.evidence,closed:()=>options.closed===true});
    assert.equal(l.state,'paused');assert.equal(l.error,HANDOFF);assert.equal(l.rewardInventoryRecovery.verifiedSlot,undefined);
  }
});

test('worker rechecks the stopped inventory and resumes only the unpaid saved payout suffix',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'launchpad-inventory-recovery-'));let stored={version:1,launches:[launch()]},reads=0;
  const initial=structuredClone(stored.launches[0]),prepared=[],broadcasts=[];
  const accounts={dir,get:async()=>({mainWallet:initial.keys.payer.address}),storeFor:()=>({dir:join(dir,'owner'),read:async()=>structuredClone(stored),write:async(_,book)=>{stored=structuredClone(book);}})};
  const chain={close(){},revalidateRewardInventory:async(l,{error})=>{reads++;assert.equal(error,HANDOFF);assert.equal(l.cycle.index,1);return{slot:101};},
    payoutInstructions:async(_l,rows)=>{assert.deepEqual(rows,initial.cycle.payouts.slice(1));return['payout'];},
    prepare:async()=>{prepared.push(true);return{state:'pending',signature:'new-inventory-payout',raw:'signed-bytes',createdAt:NOW,lastValidBlockHeight:100};},
    broadcast:async op=>{assert.equal(stored.launches[0].operations.at(-1).raw,op.raw);broadcasts.push(op.signature);}};
  const manager=new Launchpad(accounts,null,{now:()=>NOW,chainFactory:()=>chain});manager.kick=()=>{};
  t.after(async()=>{await manager.close();await rm(dir,{recursive:true,force:true});});
  await manager.process('owner');const l=stored.launches[0];
  assert.equal(reads,1);assert.equal(prepared.length,1);assert.equal(broadcasts.length,1);assert.equal(l.state,'live');
  assert.equal(l.cycle.index,1);assert.deepEqual(l.cycle.payouts,initial.cycle.payouts);assert.deepEqual(l.credits,initial.credits);
  assert.deepEqual(l.operations[0],initial.operations[0]);assert.deepEqual(l.operations.at(-1).payouts,initial.cycle.payouts.slice(1));assert.equal(l.operations.at(-1).amount,'200000000');
});

test('worker schedules the next inventory check even while ordinary fee work remains paused',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'launchpad-inventory-wake-'));let stored={version:1,launches:[launch()]};
  const accounts={dir,storeFor:()=>({dir:join(dir,'owner'),read:async()=>structuredClone(stored),write:async(_,book)=>{stored=structuredClone(book);}})};
  const manager=new Launchpad(accounts,null,{now:()=>NOW,chainFactory:()=>({close(){},revalidateRewardInventory:async()=>{throw Error(HANDOFF);}})});manager.kick=()=>{};
  t.after(async()=>{await manager.close();await rm(dir,{recursive:true,force:true});});
  await manager.process('owner');assert.equal(manager.wakeAt.get('owner'),NOW+60000);assert.equal(stored.launches[0].state,'paused');assert.equal(stored.launches[0].error,HANDOFF);
});

test('saved ATA failures remain paused on failed or stale simulation and retain the durable retry delay',async()=>{
  for(const evidence of [null,{slot:89}]){
    let l=ataLaunch();request(l);const before=structuredClone(l);let reads=0,writes=0;
    const run=now=>recoverRewardInventory(l,{now,persist:async()=>{writes++;},read:async copy=>{reads++;copy.credits.quote='0';if(!evidence)throw Error('Current payout simulation still fails.');return evidence;}});
    assert.equal(await run(NOW),false);assert.equal(l.state,'paused');assert.equal(l.error,ATA_ERROR);assert.equal(l.manualHolderDistribution.state,'blocked');
    for(const field of ['credits','cycle','operations','feeAutomation'])assert.deepEqual(l[field],before[field]);
    l=structuredClone(l);assert.equal(await run(NOW+59999),false);assert.equal(reads,1);assert.equal(writes,1);
    assert.equal(rewardInventoryRecoveryDueAt(l,NOW+59999),NOW+60000);assert.equal(await run(NOW+60000),false);assert.equal(reads,2);assert.equal(l.rewardInventoryRecovery.attempt,2);
  }
});

test('ATA recovery excludes explicit pauses, pending receipts, wrong saved steps and unrelated custom errors',async()=>{
  const patches=[l=>{l.feeAutomation.enabled=false;},l=>{request(l,{paused:true});},l=>{request(l);l.manualHolderDistribution.reason='Different stop';},
    l=>{l.operations.push({kind:'payout',state:'pending',raw:'saved'});},l=>{l.operations.push({kind:'payout',state:'awaiting_signature'});},l=>{l.keys.rewards.exportedAt=NOW;},
    l=>{l.input.quoteMint=SOL_MINT;},l=>{l.cycle.stage='route';},l=>{l.cycle.index=3;},l=>{l.credits.quote='1';},
    l=>{l.error=ATA_ERROR.replace('"Custom":1','"Custom":0');},l=>{l.error=ATA_ERROR.replace('instruction 4','instruction 2');},l=>{l.error=ATA_ERROR+' Extra text';}];
  for(const patch of patches){const l=ataLaunch();patch(l);const before=structuredClone(l);
    assert.equal(rewardInventoryRecoveryDueAt(l,NOW),Infinity);assert.equal(await recoverRewardInventory(l,{now:NOW,persist:async()=>assert.fail('No write'),read:async()=>assert.fail('No simulation')}),false);assert.deepEqual(l,before);
  }
});

test('worker revalidates an unsigned TSLAx payout and resumes only its saved unpaid suffix with MI inventory untouched',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'launchpad-ata-recovery-'));let stored={version:1,launches:[ataLaunch()]},reads=0;
  const initial=structuredClone(stored.launches[0]),prepared=[],broadcasts=[];
  const accounts={dir,get:async()=>({mainWallet:initial.keys.payer.address}),storeFor:()=>({dir:join(dir,'owner'),read:async()=>structuredClone(stored),write:async(_,book)=>{stored=structuredClone(book);}})};
  const chain={close(){},revalidateRewardInventory:async(l,{error})=>{reads++;assert.equal(error,ATA_ERROR);assert.equal(l.cycle.index,1);assert.equal(prepared.length,0);assert.equal(broadcasts.length,0);assert.equal(stored.launches[0].rewardInventoryRecovery.nextCheckAt,NOW+60000);return{slot:101};},
    payoutInstructions:async(_l,rows)=>{assert.deepEqual(rows,initial.cycle.payouts.slice(1));return['same-payout'];},
    prepare:async()=>{prepared.push(true);return{state:'pending',signature:'new-ata-payout',raw:'signed-bytes',createdAt:NOW,lastValidBlockHeight:100};},
    broadcast:async op=>{assert.equal(stored.launches[0].operations.at(-1).raw,op.raw);broadcasts.push(op.signature);}};
  const manager=new Launchpad(accounts,null,{now:()=>NOW,chainFactory:()=>chain});manager.kick=()=>{};
  t.after(async()=>{await manager.close();await rm(dir,{recursive:true,force:true});});
  await manager.process('owner');const l=stored.launches[0];assert.equal(reads,1);assert.equal(prepared.length,1);assert.equal(broadcasts.length,1);assert.equal(l.state,'live');assert.equal(l.error,'');
  assert.deepEqual(l.cycle,initial.cycle);assert.deepEqual(l.credits,initial.credits);assert.deepEqual(l.operations[0],initial.operations[0]);
  assert.deepEqual(l.operations.at(-1).payouts,initial.cycle.payouts.slice(1));assert.equal(l.operations.at(-1).amount,'17305842');assert.equal(l.rewardInventoryRecovery.verifiedSlot,101);
});
