import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {Launchpad} from '../src/launchpad.mjs';
import {newLaunchKeys} from '../src/launchpad-receipts.mjs';
import {launchInput,SOL_MINT} from '../public/launchpad-model.mjs';
import {HOLDER_REWARD_POLICY} from '../src/launchpad-holder-rewards.mjs';
import {provisionRewardsWallet} from '../src/launchpad-rewards-wallet.mjs';
import {setFeeAutomation} from '../src/launchpad-reward-recovery.mjs';
import {nativeRewardDebtState,deferNativeRewardPayouts,queueNativeRewardPayouts,resetNativeRewardAllocation,deferredRewardSummary} from '../src/launchpad-native-reward-debts.mjs';
import {activeRewardsFixture,rewardFixtureReceipt,rewardHandoffTx} from './helpers/rewards-wallet-fixture.mjs';

const NOW=Date.parse('2026-09-28T01:00:00Z'),address=()=>newLaunchKeys().wallet.address;
const payout=(owner,amount)=>({owner,amount:String(amount)});
function launch(credit='1000'){
  return activeRewardsFixture({id:'b'.repeat(32),keys:newLaunchKeys(),input:launchInput({name:'Rewards',symbol:'RWDS',feeMode:'holders',quoteMint:SOL_MINT,taxPercent:'2'}),review:{minimumSol:'0.06',quoteProgram:TOKEN_PROGRAM_ID.toBase58(),quoteDecimals:9,price:{usd:'100'},devBuy:{gross:'0'}},feeCustody:'relay',curve:address(),createdAt:NOW-7200000,authorizedAt:NOW-7200000,state:'live',autoFees:true,feesRequested:true,lastHolderRewardCheck:NOW,credits:{base:'0',quote:credit},operations:[],gas:{day:'2026-09-28',reserved:'0'}},NOW-1000);
}
const cycle=rows=>({stage:'payout',index:0,payouts:rows,holderRewardPolicy:HOLDER_REWARD_POLICY});
const rentError=rows=>Object.assign(Error('A holder reward is below the recipient account rent minimum.'),{code:'REWARD_RECIPIENT_RENT',payouts:structuredClone(rows)});
async function harness(t,l=launch()){
  if(!l.feeAutomation)setFeeAutomation(l,true,NOW-1000,'legacy-enabled');
  const dir=await mkdtemp(join(tmpdir(),'launchpad-native-debt-'));let data={launches:[structuredClone(l)]},clock=NOW,sequence=0,transaction=null,manager,failSave=false;
  const broadcasts=[],preparations=[],blocked=new Set(),accounts={dir,storeFor:()=>({dir,read:async()=>structuredClone(data),write:async(_,value)=>{if(failSave){failSave=false;throw Error('Test durable write failed.');}data=structuredClone(value);}})};
  const c={close(){},c:{getBlockHeight:async()=>10},rewardsGasFundingPlan:async()=>({gasLamports:'0',ready:true}),rewardHandoffInstructions:async(_,plan)=>[{handoff:plan}],holderRewardReference:async()=>({mint:SOL_MINT,usd:'100',at:clock}),claimInstructions:async()=>[],payoutInstructions:async(_,rows)=>{const rejected=rows.filter(row=>blocked.has(row.owner));if(rejected.length)throw rentError(rejected);return rows;},holderSnapshot:async()=>{throw Error('Unexpected new holder allocation.');},prepare:async(_,instructions,extra,initial,options)=>{preparations.push(structuredClone(options?.operation));return {signature:`tx-${++sequence}`,state:'pending',raw:`bytes-${sequence}`,createdAt:clock,lastValidBlockHeight:100};},broadcast:async op=>{assert(data.launches[0].operations.some(row=>row.signature===op.signature&&row.raw===op.raw));broadcasts.push(op.signature);},receipt:async()=>transaction};
  const restart=async()=>{await manager?.close();manager=new Launchpad(accounts,null,{chainFactory:()=>c,now:()=>clock});manager.kick=()=>{};};await restart();t.after(async()=>{await manager.close();await rm(dir,{force:true,recursive:true});});
  return {c,blocked,broadcasts,preparations,restart,failNextSave:()=>{failSave=true;},get l(){return data.launches[0];},get manager(){return manager;},advance:n=>{clock+=n;},process:()=>manager.process('owner'),async edit(fn){await manager.locked('owner',async b=>{fn(b.launches[0]);await manager.save('owner',b);});},async confirm(options={}){const current=data.launches[0],op=current.operations.find(row=>row.state==='pending');assert(op,'a pending operation must exist');transaction=op.kind==='reward-handoff'?rewardHandoffTx(current,op,options):rewardFixtureReceipt(current,{operation:op,quote:op.kind==='payout'?-BigInt(op.amount):0n,...options});await manager.process('owner');transaction=null;}};
}

test('deferral preserves the confirmed prefix, exact credit and unpaid neighbors',()=>{
  const l=launch('900'),paid=address(),blocked=address(),ready=address();l.cycle={...cycle([payout(paid,100),payout(blocked,400),payout(ready,500)]),index:1};
  const credits=structuredClone(l.credits);deferNativeRewardPayouts(l,l.cycle.payouts.slice(1),[payout(blocked,400)]);
  assert.deepEqual(l.cycle.payouts,[payout(paid,100),payout(ready,500)]);assert.equal(l.cycle.index,1);assert.deepEqual(l.credits,credits);
  assert.deepEqual(deferredRewardSummary(l),{wallets:1,amountUnits:'400'});assert.equal(nativeRewardDebtState(l).reserved,400n);
  assert.throws(()=>deferNativeRewardPayouts(l,[payout(blocked,400)],[payout(blocked,400)]),/differs/);assert.equal(nativeRewardDebtState(l).reserved,400n);
});

test('an old partially paid batch finishes and the exact deferred debt later pays once',async t=>{
  const l=launch('900'),paid=address(),blocked=address(),ready=address();delete l.keys.rewards;delete l.rewardsWallet;l.cycle={...cycle([payout(paid,100),payout(blocked,400),payout(ready,500)]),index:1};
  const h=await harness(t,l);h.blocked.add(blocked);await h.process();assert.equal(h.l.operations.length,0);assert.equal(h.l.cycle.index,1);assert.deepEqual(h.l.nativeRewardDebts.payouts,[payout(blocked,400)]);assert.equal(h.l.rewardsWallet,undefined);
  await h.restart();await h.process();assert.deepEqual(h.l.operations[0].payouts,[payout(ready,500)]);assert.equal(h.l.operations[0].rewardsWallet.source,'wallet');await h.confirm();assert.equal(h.l.credits.quote,'400');assert.equal(h.l.cycle.index,2);await h.process();assert.equal(h.l.cycle,null);
  h.advance(300001);await h.process();assert.equal(h.l.operations.at(-1).kind,'reward-handoff');assert.equal(h.l.operations.at(-1).rewardHandoff.holderQuoteUnits,'400');await h.confirm();assert.equal(h.l.rewardsWallet.status,'active');assert.deepEqual(h.l.nativeRewardDebts.payouts,[payout(blocked,400)]);
  h.blocked.clear();await h.process();await h.process();const op=h.l.operations.at(-1);assert.deepEqual(op.payouts,[payout(blocked,400)]);assert.equal(op.rewardsWallet.source,'rewards');assert.equal(h.l.nativeRewardDebts.payouts.length,0);assert.deepEqual(deferredRewardSummary(h.l),{wallets:1,amountUnits:'400'});
  const before=structuredClone(op);await h.restart();await h.process();assert.deepEqual(h.l.operations.at(-1),before);await h.confirm();assert.equal(h.l.credits.quote,'0');assert.deepEqual(deferredRewardSummary(h.l),{wallets:0,amountUnits:'0'});await h.process();assert.equal(h.l.cycle,null);assert.equal(h.l.operations.filter(row=>row.kind==='payout'&&row.state==='confirmed').length,2);
});

test('old debt can pay below the new allocation minimum and without a price or holder snapshot',async t=>{
  const l=launch('900'),old=address();l.nativeRewardDebts={version:1,payouts:[payout(old,400)]};l.cycle={stage:'distribute',index:0};const h=await harness(t,l);h.c.holderRewardReference=async()=>{throw Error('Price unavailable.');};await h.process();assert.equal(h.l.operations.length,1);assert.deepEqual(h.l.operations[0].payouts,[payout(old,400)]);assert.equal(h.l.lastHolderRewardCheck,NOW);await h.confirm();await h.process();assert.equal(h.l.credits.quote,'500');assert.equal(h.l.lastHolderRewardCheck,NOW);
});

test('new allocations exclude all owed credit and merge exact new shares with old debts',async t=>{
  const old=address(),fresh=address(),l=launch('2000000000');l.lastHolderRewardCheck=NOW-3600001;l.nativeRewardDebts={version:1,payouts:[payout(old,400000000)]};l.cycle={stage:'distribute',index:0};const h=await harness(t,l);h.c.holderSnapshot=async()=>({slot:101,rows:[payout(old,1),payout(fresh,1)]});await h.process();const op=h.l.operations[0],byOwner=new Map(op.payouts.map(row=>[row.owner,row.amount]));assert.equal(op.amount,'2000000000');assert.equal(byOwner.get(old),'1200000000');assert.equal(byOwner.get(fresh),'800000000');assert.deepEqual(deferredRewardSummary(h.l),{wallets:1,amountUnits:'400000000'});await h.confirm();assert.equal(h.l.credits.quote,'0');assert.equal(deferredRewardSummary(h.l).amountUnits,'0');
});

test('the total including debt cannot bypass the $100 new allocation floor',async t=>{
  const old=address(),l=launch('1300000000');l.lastHolderRewardCheck=NOW-3600001;l.nativeRewardDebts={version:1,payouts:[payout(old,400000000)]};l.cycle={stage:'distribute',index:0};const h=await harness(t,l);await h.process();assert.deepEqual(h.l.operations[0].payouts,[payout(old,400000000)]);await h.confirm();assert.equal(h.l.credits.quote,'900000000');
});

test('sub-cent new shares accrue to an existing debt rather than being lost',async t=>{
  const old=address(),large=address(),l=launch('1000000500');l.lastHolderRewardCheck=NOW-3600001;l.nativeRewardDebts={version:1,payouts:[payout(old,500)]};l.cycle={stage:'distribute',index:0};const h=await harness(t,l);h.c.holderSnapshot=async()=>({slot:101,rows:[payout(old,1),payout(large,999999)]});await h.process();const byOwner=new Map(h.l.operations[0].payouts.map(row=>[row.owner,row.amount]));assert.equal(byOwner.get(old),'1500');assert.equal(byOwner.get(large),'999999000');assert.equal(h.l.operations[0].amount,'1000000500');
});

test('repeated unpayable checks keep one obligation and still complete cycles',async t=>{
  const owner=address(),l=launch('400');l.nativeRewardDebts={version:1,payouts:[payout(owner,400)]};l.cycle={stage:'distribute',index:0};const h=await harness(t,l);h.blocked.add(owner);
  for(let i=0;i<3;i++){await h.process();assert.equal(h.l.nativeRewardDebts.payouts[0].amount,'400');assert.equal(h.l.operations.length,0);for(let step=0;h.l.cycle&&step<3;step++)await h.process();assert.equal(h.l.cycle,null);assert.equal(h.l.credits.quote,'400');h.advance(300001);}
});

test('failed durable deferral restores both cycle and ledger before outer error save',async t=>{
  const owner=address(),l=launch('400');l.cycle=cycle([payout(owner,400)]);const h=await harness(t,l);h.blocked.add(owner);h.failNextSave();await h.process();assert.equal(h.l.nativeRewardDebts,undefined);assert.deepEqual(h.l.cycle.payouts,[payout(owner,400)]);assert.equal(h.l.cycle.index,0);assert.equal(h.l.operations.length,0);
  await h.edit(l=>{l.state='live';l.feesRequested=true;});await h.process();assert.deepEqual(h.l.nativeRewardDebts.payouts,[payout(owner,400)]);assert.equal(h.l.cycle.payouts.length,0);
});

test('failed durable queue allocation leaves the old debt in its original ledger',async t=>{
  const owner=address(),l=launch('400');l.nativeRewardDebts={version:1,payouts:[payout(owner,400)]};l.cycle={stage:'distribute',index:0};const h=await harness(t,l);h.failNextSave();await h.process();assert.deepEqual(h.l.nativeRewardDebts.payouts,[payout(owner,400)]);assert.equal(h.l.cycle.stage,'distribute');assert.equal(h.l.cycle.payouts,undefined);assert.equal(h.l.operations.length,0);
});

test('a failed receipt save does not pay or forget queued debt and retry applies once',async t=>{
  const owner=address(),l=launch('400');l.nativeRewardDebts={version:1,payouts:[payout(owner,400)]};l.cycle={stage:'distribute',index:0};const h=await harness(t,l);await h.process();h.failNextSave();await h.confirm();assert.equal(h.l.operations[0].state,'pending');assert.equal(h.l.credits.quote,'400');assert.equal(h.l.cycle.index,0);assert.deepEqual(deferredRewardSummary(h.l),{wallets:1,amountUnits:'400'});await h.restart();await h.confirm();assert.equal(h.l.credits.quote,'0');assert.equal(h.l.operations[0].state,'confirmed');assert.equal(deferredRewardSummary(h.l).amountUnits,'0');
});

test('unsigned snapshot rebuild restores old debts but may reallocate fresh shares',()=>{
  const old=address(),fresh=address(),l=launch('1000');l.nativeRewardDebts={version:1,payouts:[payout(old,400)]};l.cycle={stage:'distribute',index:0};queueNativeRewardPayouts(l,[payout(old,200),payout(fresh,400)]);l.cycle.stage='payout';assert.deepEqual(deferredRewardSummary(l),{wallets:1,amountUnits:'400'});resetNativeRewardAllocation(l);assert.deepEqual(l.nativeRewardDebts.payouts,[payout(old,400)]);assert.equal(l.cycle.payouts,undefined);assert.equal(l.credits.quote,'1000');
});

test('a v55 restart with a saved distribute-stage payout array reuses its exact recipients',async t=>{
  const owner=address(),l=launch('1000');l.cycle={...cycle([payout(owner,1000)]),stage:'distribute'};const h=await harness(t,l);await h.restart();await h.process();assert.equal(h.l.cycle.stage,'payout');assert.deepEqual(h.l.operations[0].payouts,[payout(owner,1000)]);assert.equal(h.l.credits.quote,'1000');await h.confirm();assert.equal(h.l.credits.quote,'0');
});

test('a legacy policy reset preserves queued old debt before rebuilding unsigned allocation',async t=>{
  const owner=address(),l=launch('1000');l.nativeRewardDebts={version:1,payouts:[payout(owner,400)]};l.cycle={stage:'distribute',index:0};queueNativeRewardPayouts(l,[payout(address(),600)]);l.cycle.stage='payout';l.cycle.holderRewardPolicy='legacy';const h=await harness(t,l);await h.process();assert.deepEqual(h.l.operations[0].payouts,[payout(owner,400)]);assert.equal(h.l.credits.quote,'1000');assert.equal(deferredRewardSummary(h.l).amountUnits,'400');
});

test('a repeated deferral retains the full combined debt instead of only its old portion',()=>{
  const owner=address(),l=launch('1000');l.nativeRewardDebts={version:1,payouts:[payout(owner,400)]};l.cycle={stage:'distribute',index:0};queueNativeRewardPayouts(l,[payout(owner,600)]);l.cycle.stage='payout';deferNativeRewardPayouts(l,[payout(owner,1000)],[payout(owner,1000)]);assert.deepEqual(l.nativeRewardDebts.payouts,[payout(owner,1000)]);assert.deepEqual(l.cycle.nativeRewardDebts,[]);assert.equal(l.credits.quote,'1000');assert.deepEqual(deferredRewardSummary(l),{wallets:1,amountUnits:'1000'});
});

test('a handoff reset cannot redistribute a former holder’s queued debt',async t=>{
  const owner=address(),l=launch('1000');delete l.keys.rewards;delete l.rewardsWallet;provisionRewardsWallet(l,NOW-1000);l.nativeRewardDebts={version:1,payouts:[payout(owner,400)]};l.cycle={stage:'distribute',index:0};queueNativeRewardPayouts(l,[payout(address(),600)]);l.cycle.stage='payout';l.cycle.holderRewardPolicy=HOLDER_REWARD_POLICY;const h=await harness(t,l);await h.process();assert.equal(h.l.operations[0].kind,'reward-handoff');await h.confirm();assert.deepEqual(h.l.nativeRewardDebts.payouts,[payout(owner,400)]);assert.equal(h.l.cycle.payouts,undefined);assert.equal(h.l.credits.quote,'1000');await h.process();assert.deepEqual(h.l.operations.at(-1).payouts,[payout(owner,400)]);
});

test('unproven rent errors and malformed subsets cannot move or duplicate any allocation',async t=>{
  for(const error of [Error('InsufficientFundsForRent'),rentError([payout(address(),400)]),rentError([])]){
    const owner=address(),l=launch('400');l.cycle=cycle([payout(owner,400)]);const h=await harness(t,l);h.c.payoutInstructions=async()=>{throw error;};await h.process();assert.equal(h.l.nativeRewardDebts,undefined);assert.deepEqual(h.l.cycle.payouts,[payout(owner,400)]);assert.equal(h.l.credits.quote,'400');assert.equal(h.l.operations.length,0);
  }
});

test('a typed simulation race can defer before journaling, never after a pending operation exists',async t=>{
  const owner=address(),l=launch('400');l.cycle=cycle([payout(owner,400)]);const h=await harness(t,l);h.c.prepare=async()=>{throw rentError([payout(owner,400)]);};await h.process();assert.deepEqual(h.l.nativeRewardDebts.payouts,[payout(owner,400)]);assert.equal(h.l.operations.length,0);
  const pendingLaunch=launch('400');pendingLaunch.cycle=cycle([payout(owner,400)]);pendingLaunch.operations=[{kind:'payout',amount:'400',payouts:[payout(owner,400)],state:'pending',signature:'saved',raw:'do-not-change',createdAt:NOW,lastValidBlockHeight:100}];const h2=await harness(t,pendingLaunch);h2.blocked.add(owner);await h2.process();assert.deepEqual(h2.l.operations,pendingLaunch.operations);assert.equal(h2.l.nativeRewardDebts,undefined);assert.throws(()=>deferNativeRewardPayouts(h2.l,[payout(owner,400)],[payout(owner,400)]),/signed/);
});

test('malformed reserves fail closed and explicit pauses retain their debts',async t=>{
  const l=launch('400');l.nativeRewardDebts={version:1,payouts:[payout(address(),401)]};const h=await harness(t,l);await h.process();assert.equal(h.l.operations.length,0);assert.equal(h.l.state,'paused');assert.equal(deferredRewardSummary(h.l),null);assert.equal(h.l.credits.quote,'400');
  const paused=launch('400');paused.nativeRewardDebts={version:1,payouts:[payout(address(),400)]};setFeeAutomation(paused,false,NOW,'user');paused.state='paused';paused.feesRequested=false;const h2=await harness(t,paused);await h2.process();assert.equal(h2.l.operations.length,0);assert.deepEqual(h2.l.nativeRewardDebts,paused.nativeRewardDebts);assert.equal(h2.l.state,'paused');
});
