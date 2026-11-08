import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Launchpad} from '../src/launchpad.mjs';
import {heldSolEligibility,heldSolFailureReason} from '../src/launchpad-held-sol.mjs';
import {newLaunchKeys} from '../src/launchpad-receipts.mjs';
import {launchInput,SOL_MINT,USDC_MINT} from '../public/launchpad-model.mjs';
import {activeRewardsFixture,rewardFixtureReceipt} from './helpers/rewards-wallet-fixture.mjs';
import {nativeRewardDebtState} from '../src/launchpad-native-reward-debts.mjs';
import {recordTaxHarvest,recordTaxConversion,TAX_PROTOCOL_POLICY} from '../src/launchpad-tax-protocol.mjs';
import {AdminPanel} from '../src/admin-panel.mjs';
import {LaunchpadAdmin} from '../src/launchpad-admin.mjs';

const START=1700000000000,ACCOUNT='a'.repeat(32),ADMIN='b'.repeat(32),ID='c'.repeat(32),REQUEST='d'.repeat(32),SECOND='e'.repeat(32);
const address=()=>newLaunchKeys().wallet.address;
function launch(extra={}){
  const keys=newLaunchKeys();keys.payer=newLaunchKeys().wallet;keys.platform=keys.wallet;
  return activeRewardsFixture({id:ID,input:launchInput({name:'Rewards',symbol:'RWD',feeMode:'holders',quoteMint:SOL_MINT}),keys,
    review:{minimumSol:'0.06',quoteDecimals:9,price:{usd:'150'},devBuy:{gross:'0'}},holderRewards:{minimumQuoteUnits:'666666667'},feeCustody:'relay',curve:address(),
    state:'paused',phase:'verify',createdAt:START,authorizedAt:START,lastCycle:START,error:'Fee service paused. Pending receipts will still be reconciled.',
    autoFees:false,feeAutomation:{enabled:false,source:'user',updatedAt:START},feesRequested:false,operations:[],credits:{quote:'6000000',base:'1000'},gas:{day:new Date(START).toISOString().slice(0,10),reserved:'0'},...extra},START);
}
async function harness(t,initial=launch()){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-held-sol-')),books=new Map([[ACCOUNT+':launchpad',{version:1,launches:[structuredClone(initial)]}]]),prepared=[],broadcasts=[],receipts=new Map(),holders=Array.from({length:6},()=>({owner:address(),amount:'1'}));
  let now=START,admin={role:'admin',mfaEnabled:true},manager,snapshots=0;
  const accounts={dir,get:async id=>id===ADMIN?admin:{mainWallet:initial.keys.payer.address},storeFor:id=>({dir:join(dir,id),read:async(key,fallback)=>structuredClone(books.get(id+':'+key)||fallback),write:async(key,value)=>books.set(id+':'+key,structuredClone(value))})};
  const forbidden=()=>{throw Error('Held-SOL payout must not claim, convert, hand off or fund.');};
  const c={close(){},claimInstructions:forbidden,swapFeeInstructions:forbidden,rewardHandoffInstructions:forbidden,rewardsGasFundingPlan:forbidden,holderRewardReference:forbidden,
    holderSnapshot:async()=>{snapshots++;return{slot:100,rows:holders};},payoutInstructions:async(_,rows)=>rows,
    prepare:async(l,instructions,extra,kind,options)=>{const signature='sig-'+(prepared.length+1);prepared.push({instructions,options});return{state:'pending',signature,raw:'saved-'+signature,createdAt:now,lastValidBlockHeight:100};},
    broadcast:async op=>{assert(books.get(ACCOUNT+':launchpad').launches[0].operations.some(saved=>saved.signature===op.signature&&saved.raw===op.raw));broadcasts.push(op.signature);},receipt:async op=>receipts.get(op.signature)||null,c:{getBlockHeight:async()=>1}};
  const restart=async()=>{await manager?.close();manager=new Launchpad(accounts,null,{chainFactory:()=>c,now:()=>now});manager.kick=()=>{};return manager;};await restart();
  t.after(async()=>{await manager.close();await rm(dir,{recursive:true,force:true});});
  const h={accounts,books,c,prepared,broadcasts,receipts,holders,restart,get manager(){return manager;},get saved(){return books.get(ACCOUNT+':launchpad').launches[0];},get snapshots(){return snapshots;},set admin(value){admin=value;},advance(ms){now+=ms;},
    queue:requestId=>manager.queueHeldSolDistribution(ADMIN,{accountId:ACCOUNT,id:ID,mint:initial.keys.mint.address,requestId:requestId||REQUEST}),status:requestId=>manager.heldSolDistributionStatus({accountId:ACCOUNT,id:ID,requestId:requestId||REQUEST}),tick:()=>manager.process(ACCOUNT),
    async change(fn){await manager.locked(ACCOUNT,async b=>{fn(b.launches[0]);await manager.save(ACCOUNT,b);});},
    async confirm(err=null){const l=this.saved,op=l.operations.find(row=>row.state==='pending');assert(op);receipts.set(op.signature,rewardFixtureReceipt(l,{operation:op,quote:-BigInt(op.amount),err}));await this.tick();}};
  return h;
}

test('bulk held-SOL distribution bypasses minimum once, batches journaled payouts, and preserves paused automation and other assets',async t=>{
  const initial=launch();initial.input.taxBps=100;initial.taxProtocol=recordTaxHarvest(initial,1000n);initial.taxProtocol=recordTaxConversion(initial,{taxProtocolPolicy:TAX_PROTOCOL_POLICY,taxSource:'withheld-tax',amount:'1000'},1000n,10000n).ledger;initial.credits.base='0';
  const h=await harness(t,initial),originalTax=structuredClone(initial.taxProtocol);assert.equal(await h.status(),null);
  assert.equal((await h.queue()).state,'queued');await h.tick();assert.equal(h.prepared.length,1);assert.equal(h.saved.operations[0].payouts.length,3);assert.equal(h.saved.operations[0].amount,'3000000');assert.equal(h.prepared[0].options.operation.rewardsWallet.source,'rewards');
  await h.confirm();await h.tick();assert.equal(h.prepared.length,2);assert.equal(h.saved.operations[1].payouts.length,3);await h.confirm();await h.tick();
  const status=await h.status();assert.equal(status.state,'completed');assert.equal(status.paidLamports,'6000000');assert.equal(status.remainingLamports,'0');assert.equal(status.deferredLamports,'0');assert.equal(h.saved.credits.quote,'0');assert.deepEqual(h.saved.taxProtocol,originalTax);assert.equal(h.saved.credits.base,'0');assert.equal(h.saved.autoFees,false);assert.equal(h.saved.feeAutomation.enabled,false);assert.equal(h.saved.state,'paused');assert.equal(h.saved.cycle,null);assert.equal(h.snapshots,1);
  assert.deepEqual(await h.queue(),status);await h.tick();assert.equal(h.prepared.length,2);
  await h.change(l=>l.credits.quote='6');await h.queue(SECOND);await h.tick();await h.confirm();await h.tick();await h.confirm();await h.tick();assert.equal((await h.status(SECOND)).paidLamports,'6');assert.deepEqual(await h.queue(),status);assert.equal(h.prepared.length,4);
});

test('pending payout survives restart and unknown receipt without replacement, then continues the saved recipients',async t=>{
  const h=await harness(t);await h.queue();await h.tick();const first=structuredClone(h.saved.operations[0]);await h.restart();await h.tick();assert.equal(h.prepared.length,1);assert.equal((await h.queue()).state,'processing');
  h.advance(16000);await h.tick();assert.equal(h.prepared.length,1);assert.deepEqual(h.broadcasts,[first.signature,first.signature]);await h.confirm();h.holders.reverse();await h.restart();await h.tick();assert.equal(h.snapshots,1);const second=h.saved.operations[1];assert(second.payouts.every(row=>!first.payouts.some(old=>row.owner===old.owner)));await h.confirm();await h.tick();assert.equal((await h.status()).paidLamports,'6000000');
});

test('rent-blocked holders retain exact debts and terminal status reports unpaid totals',async t=>{
  const h=await harness(t);let rejected;
  h.c.payoutInstructions=async(_,rows)=>{if(!rejected){rejected=rows[0];throw Object.assign(Error('Recipient needs rent'),{code:'REWARD_RECIPIENT_RENT',payouts:[rejected]});}return rows;};
  await h.queue();await h.tick();assert.equal(h.prepared.length,0);await h.tick();await h.confirm();await h.tick();await h.confirm();await h.tick();
  const status=await h.status();assert.equal(status.state,'completed');assert.equal(status.paidLamports,'5000000');assert.equal(status.remainingLamports,'1000000');assert.equal(status.deferredLamports,'1000000');assert.equal(status.deferredWallets,1);assert.match(status.reason,/unpaid/);assert.deepEqual(nativeRewardDebtState(h.saved).owed,[rejected]);
  h.holders.length=0;await h.queue(SECOND);await h.tick();assert.deepEqual(h.saved.operations.at(-1).payouts,[rejected]);await h.confirm();await h.tick();assert.equal((await h.status(SECOND)).paidLamports,'1000000');assert.equal(h.saved.credits.quote,'0');
});

test('authorization revocation cannot sign further batches and cannot prevent saved receipt reconciliation',async t=>{
  const h=await harness(t);await h.queue();await h.tick();h.admin={role:'user',mfaEnabled:true};await h.confirm();await h.tick();assert.equal(h.prepared.length,1);const status=await h.status();assert.equal(status.state,'failed');assert.equal(status.paidLamports,'3000000');assert.equal(status.deferredLamports,'3000000');assert.equal(status.deferredWallets,3);assert.equal(h.saved.credits.quote,'3000000');
});

test('authorization is checked again after preparation before journal or broadcast',async t=>{
  const h=await harness(t),prepare=h.c.prepare;h.c.prepare=async(...args)=>{const op=await prepare(...args);h.admin={role:'admin',mfaEnabled:false};return op;};await h.queue();await h.tick();assert.equal(h.prepared.length,1);assert.equal(h.broadcasts.length,0);assert.equal(h.saved.operations.length,0);assert.equal((await h.status()).state,'failed');assert.equal((await h.status()).deferredLamports,'6000000');
});

test('explicit pause reconciles pending payout and preserves unpaid debts without resuming automation',async t=>{
  const h=await harness(t,launch({state:'live',error:'',autoFees:true,feeAutomation:{enabled:true,source:'user',updatedAt:START}}));await h.queue();await h.tick();await h.manager.action(ACCOUNT,ID,'pause');await h.confirm();await h.tick();assert.equal(h.prepared.length,1);assert.equal((await h.status()).deferredLamports,'3000000');assert.equal(h.saved.autoFees,false);assert.equal(h.saved.feeAutomation.enabled,false);assert.match(h.saved.error,/paused/);
});

test('admin pause during held-SOL payout reconciles signed recipients and keeps every unpaid amount owed',async t=>{
  const h=await harness(t,launch({state:'live',error:'',autoFees:true,feeAutomation:{enabled:true,source:'user',updatedAt:START}}));
  const get=h.accounts.get;h.accounts.get=async id=>({...await get(id),id,username:id===ADMIN?'admin':'owner'});h.accounts.list=async()=>[await h.accounts.get(ACCOUNT),await h.accounts.get(ADMIN)];
  const launchAdmin=new LaunchpadAdmin({accounts:h.accounts,launchpad:h.manager,now:()=>START}),panel=new AdminPanel({accounts:h.accounts,launchpad:h.manager,launchAdmin,now:()=>START});
  await h.queue();await h.tick();const before=structuredClone(h.saved),unpaid=before.cycle.payouts.slice(3),request={accountId:ACCOUNT,id:ID,requestId:'f'.repeat(32),action:'pause-rewards'};
  const paused=await panel.launchAction(ADMIN,request);assert.equal(paused.status,'paused');assert.equal(h.saved.heldSolDistribution.cancelRequested,true);assert.deepEqual(h.saved.cycle,before.cycle);assert.deepEqual(h.saved.operations,before.operations);assert.deepEqual(h.saved.credits,before.credits);
  await h.confirm();await h.tick();assert.equal(h.prepared.length,1);assert.equal((await h.status()).paidLamports,'3000000');assert.equal((await h.status()).deferredLamports,'3000000');assert.deepEqual(nativeRewardDebtState(h.saved).owed,unpaid);assert.equal(h.saved.credits.quote,'3000000');assert.equal(h.saved.feeAutomation.enabled,false);
  await h.restart();h.advance(3600000);await h.tick();assert.equal(h.prepared.length,1);assert.deepEqual(nativeRewardDebtState(h.saved).owed,unpaid);
});

test('unsafe, non-native and migrating launches are skipped durably without changing their saved work',async t=>{
  const variants=[l=>l.input.quoteMint=USDC_MINT,l=>l.rewardsWallet.status='migrating',l=>l.rewardsWallet.creatorCredits.quote='1',l=>l.error='Permanent identity mismatch',l=>l.rewardRetry={at:START},l=>l.keys.rewards.exported=true,l=>l.walletExported=true];
  for(const change of variants){const initial=launch();change(initial);assert(heldSolEligibility(initial));const h=await harness(t,initial),result=await h.queue();assert.equal(result.state,'skipped');assert.equal(h.prepared.length,0);assert.deepEqual(h.saved.cycle,initial.cycle);assert.deepEqual(h.saved.operations,initial.operations);assert.deepEqual(h.saved.credits,initial.credits);assert.deepEqual(await h.status(),result);}
});

test('busy launches wait without replacing cycles or making the exact request ID permanently skipped',async t=>{
  for(const change of [l=>l.cycle={stage:'tax',index:0},l=>l.operations.push({state:'pending',kind:'claim'}),l=>l.operations.push({state:'awaiting_signature',kind:'claim'})]){
    const initial=launch();change(initial);const h=await harness(t,initial),waiting=await h.queue();
    assert.equal(waiting.state,'waiting');assert.equal(await h.status(),null);assert.equal(h.prepared.length,0);assert.deepEqual(h.saved,initial);
    if(initial.operations[0]?.state==='awaiting_signature')assert.match(waiting.reason,/Complete or cancel/);
    else if(initial.cycle)assert.match(waiting.reason,/Resume rewards/);
    await h.change(l=>{l.cycle=null;l.operations=l.operations.map(op=>({...op,state:'confirmed'}));});
    assert.equal((await h.queue()).state,'queued');assert.equal(h.saved.heldSolDistribution.requestId,REQUEST);
    assert.equal((await h.queue()).state,'queued');assert.equal(h.saved.adminRewardHistory.length,1);assert.equal(h.prepared.length,0);
  }
});

test('a cycle that pays all credit while the bulk request waits does not trigger another payout',async t=>{
  const h=await harness(t,launch({cycle:{stage:'payout',index:0}}));assert.equal((await h.queue()).state,'waiting');
  await h.change(l=>{l.cycle=null;l.credits.quote='0';});const result=await h.queue();
  assert.equal(result.state,'skipped');assert.match(result.reason,/No confirmed SOL reward credit/);assert.equal(h.prepared.length,0);assert.equal(h.broadcasts.length,0);assert.deepEqual(await h.status(),result);assert.deepEqual(await h.queue(),result);
});

test('onchain failure reserves all unpaid obligations and never signs a replacement for the same request',async t=>{
  const h=await harness(t);await h.queue();await h.tick();await h.confirm({InstructionError:[0,{Custom:1}]});assert.equal((await h.status()).state,'failed');assert.equal((await h.status()).deferredLamports,'6000000');assert.equal(h.saved.credits.quote,'6000000');await h.tick();assert.equal(h.prepared.length,1);assert.equal(h.saved.rewardRetry,undefined);
});

test('missing child returns null, while stale missing-launch inventory is terminal skipped',async t=>{
  const h=await harness(t);assert.equal(await h.status(),null);assert.equal((await h.manager.heldSolDistributionStatus({accountId:ACCOUNT,id:'f'.repeat(32),requestId:REQUEST})).state,'skipped');
  assert.equal((await h.manager.queueHeldSolDistribution(ADMIN,{accountId:ACCOUNT,id:'f'.repeat(32),requestId:REQUEST})).state,'skipped');
});

test('network-cost budget is not bypassed and reports a safe actionable reason',async t=>{
  const h=await harness(t);await h.change(l=>l.gas.reserved=l.input.dailyGasLamports);const gas=structuredClone(h.saved.gas);await h.queue();await h.tick();assert.equal(h.prepared.length,0);assert.equal(h.broadcasts.length,0);assert.deepEqual(h.saved.gas,gas);assert.match((await h.status()).reason,/midnight UTC/);assert.equal((await h.status()).deferredLamports,'6000000');
  for(const error of [Object.assign(Error('secret https://provider.invalid/key=secret'),{code:'REWARD_NATIVE_FUNDS'}),Error('secret InsufficientFundsForRent'),Object.assign(Error('secret'),{code:'ETIMEDOUT'}),Error('secret')])assert(!heldSolFailureReason(error).includes('secret'));
});

test('receipt-save failure retains pending journal and retries same receipt without a duplicate payout',async t=>{
  const h=await harness(t);await h.queue();await h.tick();const save=h.manager.save.bind(h.manager);let failed=false;
  h.manager.save=async(id,b)=>{if(!failed&&b.launches[0].operations[0].state==='confirmed'){failed=true;throw Error('Storage temporarily unavailable');}return save(id,b);};
  await h.confirm();assert.equal(h.saved.operations[0].state,'pending');assert.equal(h.saved.credits.quote,'6000000');assert.equal(h.saved.cycle.index,0);assert.equal(h.saved.heldSolDistribution.nextAttemptAt,START+15000);await h.restart();h.advance(15000);await h.tick();assert.equal(h.saved.operations[0].state,'confirmed');assert.equal(h.saved.credits.quote,'3000000');await h.tick();assert.equal(h.prepared.length,2);await h.confirm();await h.tick();assert.equal((await h.status()).paidLamports,'6000000');
});

test('terminal-save failure restores the cycle before safely recording the paid and deferred result',async t=>{
  const h=await harness(t);await h.queue();await h.tick();await h.confirm();await h.tick();await h.confirm();const save=h.manager.save.bind(h.manager);let failed=false;
  h.manager.save=async(id,b)=>{if(!failed&&b.launches[0].heldSolDistribution.state==='completed'){failed=true;throw Error('Storage temporarily unavailable');}return save(id,b);};
  await h.tick();assert.equal((await h.status()).state,'failed');assert.equal((await h.status()).paidLamports,'6000000');assert.equal(h.saved.credits.quote,'0');assert.equal(h.saved.cycle,null);await h.restart();await h.tick();assert.equal(h.prepared.length,2);
});

test('directory durability failure prevents broadcast and recovery reuses the same saved signature',async t=>{
  const h=await harness(t);await h.queue();const original=h.accounts.storeFor;
  h.accounts.storeFor=id=>{const store=original(id),write=store.write;store.write=async(key,value)=>{await write(key,value);if(value.launches[0].operations.some(op=>op.state==='pending'))store.dir=join(store.dir,'missing-journal-directory');};return store;};
  await assert.rejects(h.tick(),error=>error.code==='ENOENT');assert.equal(h.prepared.length,1);assert.equal(h.broadcasts.length,0);const signature=h.saved.operations[0].signature;assert.equal(h.saved.operations[0].state,'pending');
  h.accounts.storeFor=original;await h.restart();h.advance(16000);await h.tick();assert.equal(h.prepared.length,1);assert.deepEqual(h.broadcasts,[signature]);await h.confirm();assert.equal(h.saved.credits.quote,'3000000');
});
