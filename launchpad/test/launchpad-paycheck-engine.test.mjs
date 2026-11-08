import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {Launchpad} from '../src/launchpad.mjs';
import {newLaunchKeys} from '../src/launchpad-receipts.mjs';
import {launchInput,SOL_MINT} from '../public/launchpad-model.mjs';
import {holderRewardPolicy,feeCycleDueAt,holderRewardCheckDueAt,publicHolderRewards} from '../src/launchpad-holder-rewards.mjs';
import {PAYCHECK_POLICY,paycheckLedger,paycheckLedgerTotal} from '../src/launchpad-paycheck.mjs';
import {setFeeAutomation} from '../src/launchpad-reward-recovery.mjs';
import {activeRewardsFixture,rewardFixtureReceipt,rewardHandoffTx} from './helpers/rewards-wallet-fixture.mjs';

// v71.44: Paycheck through the engine. The fixture mirrors launchpad-native-reward-debts.test.mjs: a live SOL-paired
// holder launch with an active rewards wallet, a fake chain and a $100 SOL price, so $1 is 10,000,000 lamports and the
// $0.50 payout line is 5,000,000 lamports. Cycles start at the distribute stage with the credit already claimed.
const NOW=Date.parse('2026-09-28T01:00:00Z'),address=()=>newLaunchKeys().wallet.address,CREATOR=address(),TREASURY=address();
const payout=(owner,amount)=>({owner,amount:String(amount)});
function launch(credit='4000000000'){
  const input=launchInput({name:'Paycheck',symbol:'PAY',feeMode:'paycheck',quoteMint:SOL_MINT});input.recipient=CREATOR;
  const review={minimumSol:'0.06',quoteProgram:TOKEN_PROGRAM_ID.toBase58(),quoteDecimals:9,price:{usd:'100'},devBuy:{gross:'0'}};
  const l=activeRewardsFixture({id:'c'.repeat(32),keys:newLaunchKeys(),input,review,feeCustody:'relay',curve:address(),createdAt:NOW-7200000,authorizedAt:NOW-7200000,state:'live',autoFees:true,feesRequested:true,lastHolderRewardCheck:NOW-900001,credits:{base:'0',quote:credit},operations:[],gas:{day:'2026-09-28',reserved:'0'},cycle:{stage:'distribute',index:0}},NOW-1000);
  l.holderRewards=holderRewardPolicy(input,review);return l;
}
async function harness(t,l=launch(),rows=[payout(address(),3),payout(address(),1)]){
  if(!l.feeAutomation)setFeeAutomation(l,true,NOW-1000,'legacy-enabled');
  const dir=await mkdtemp(join(tmpdir(),'launchpad-paycheck-'));let data={launches:[structuredClone(l)]},clock=NOW,sequence=0,transaction=null,manager;
  const host=new Map([['launch-protocol-fees',{recipient:TREASURY,recipientScope:'launchpad'}],['fee-policy',{recipient:address()}]]);
  const accounts={dir,hostStore:{read:async(name,fallback=null)=>structuredClone(host.get(name)??fallback)},storeFor:()=>({dir,read:async()=>structuredClone(data),write:async(_,value)=>{data=structuredClone(value);}})};
  const snapshots=[],c={close(){},c:{getBlockHeight:async()=>10},rewardsGasFundingPlan:async()=>({gasLamports:'0',ready:true}),rewardHandoffInstructions:async(_,plan)=>[{handoff:plan}],holderRewardReference:async()=>({mint:SOL_MINT,usd:'100',at:clock}),claimInstructions:async()=>[],payoutInstructions:async(_,rows)=>rows,holderSnapshot:async()=>{snapshots.push(clock);return {slot:101,rows:structuredClone(rows)};},prepare:async(_,instructions,extra,initial,options)=>({signature:`tx-${++sequence}`,state:'pending',raw:`bytes-${sequence}`,createdAt:clock,lastValidBlockHeight:100}),broadcast:async op=>{assert(data.launches[0].operations.some(row=>row.signature===op.signature&&row.raw===op.raw));},receipt:async()=>transaction};
  const restart=async()=>{await manager?.close();manager=new Launchpad(accounts,null,{chainFactory:()=>c,now:()=>clock});manager.kick=()=>{};};await restart();t.after(async()=>{await manager.close();await rm(dir,{force:true,recursive:true});});
  return {c,rows,snapshots,restart,get l(){return data.launches[0];},advance:n=>{clock+=n;},process:()=>manager.process('owner'),async edit(fn){await manager.locked('owner',async b=>{fn(b.launches[0]);await manager.save('owner',b);});},
    async confirm(){const current=data.launches[0],op=current.operations.find(row=>row.state==='pending');assert(op,'a pending operation must exist');transaction=op.kind==='reward-handoff'?rewardHandoffTx(current,op):rewardFixtureReceipt(current,{operation:op,quote:op.kind==='payout'?-BigInt(op.amount):0n});await manager.process('owner');transaction=null;},
    async settle(){for(let step=0;step<20;step++){const pending=data.launches[0].operations.find(row=>row.state==='pending');if(pending)await this.confirm();else if(data.launches[0].cycle)await this.process();else return;}throw Error('The cycle did not finish.');}};
}
const byOwner=ops=>{const map=new Map();for(const op of ops)for(const row of op.payouts)map.set(row.owner,(map.get(row.owner)||0n)+BigInt(row.amount));return map;};

test('a Paycheck launch runs on the 15-minute schedule with a $1 claim floor and a $0.50 payout line',()=>{
  const l=launch();l.lastCycle=NOW-1;l.lastHolderRewardCheck=NOW-1;
  assert.equal(feeCycleDueAt(l),NOW-1+900000);assert.equal(holderRewardCheckDueAt(l),NOW-1+900000);
  assert.equal(l.holderRewards.policy,PAYCHECK_POLICY);assert.equal(l.holderRewards.minimumUsd,1);assert.equal(l.holderRewards.thresholdUsd,0.5);assert.equal(l.holderRewards.minimumQuoteUnits,'10000000');assert.equal(l.holderRewards.thresholdQuoteUnits,'5000000');
  const view=publicHolderRewards(l);assert.equal(view.intervalMinutes,15);assert.equal(view.minimumUsd,1);assert.equal(view.minimumPolicy,PAYCHECK_POLICY);assert.equal(view.paycheck.policy,PAYCHECK_POLICY);assert.equal(view.paycheck.claimed,'0');
});

test('a cycle splits the claimed credit, pays holders, the creator and the treasury, and records the ledger',async t=>{
  const [a,b]=[address(),address()],h=await harness(t,launch('4000000000'),[payout(a,3),payout(b,1)]);
  await h.process();
  const l=h.l;assert.equal(l.cycle.stage,'payout');assert.equal(l.cycle.holderRewardPolicy,PAYCHECK_POLICY);assert.equal(l.cycle.payouts.length,4);assert.equal(h.snapshots.length,1);
  assert.equal(l.paycheck.totals.claimed,'4000000000');assert.equal(l.paycheck.totals.holders,'2000000000');assert.equal(l.paycheck.totals.burn,'1400000000');assert.equal(l.paycheck.totals.curve,'400000000');assert.equal(l.paycheck.totals.creator,'200000000');
  assert.deepEqual(l.paycheck.holders,{},'every share was above the payout line');assert.equal(paycheckLedgerTotal(paycheckLedger(l)),0n);
  assert.equal(l.cycle.paycheck.protocolRecipient,TREASURY);assert.equal(l.cycle.paycheck.creatorRecipient,CREATOR);assert.equal(l.cycle.paycheck.holderUnits,'2000000000');assert.equal(l.cycle.paycheck.protocolUnits,'1800000000');assert.equal(l.cycle.paycheck.burnUnits,'1400000000');
  assert.equal(l.operations.length,1);assert.equal(l.operations[0].kind,'payout');assert.equal(l.operations[0].paycheck.policy,PAYCHECK_POLICY);assert.equal(l.operations[0].rewardsWallet.source,'rewards');
  await h.settle();
  const ops=h.l.operations.filter(op=>op.kind==='payout'&&op.state==='confirmed'),paid=byOwner(ops);
  assert.equal(ops.length,2,'four rows in two batches of three');assert.equal(paid.get(a),1500000000n);assert.equal(paid.get(b),500000000n);assert.equal(paid.get(CREATOR),200000000n);assert.equal(paid.get(TREASURY),1800000000n);
  assert.equal(h.l.credits.quote,'0');assert.equal(h.l.cycle,null);assert.equal(h.l.lastHolderRewardCheck,NOW);
  assert.deepEqual(h.l.paycheck.paid,{holders:'2000000000',creator:'200000000',protocol:'1800000000'});
  const treasuryOp=ops.find(op=>op.payouts.some(row=>row.owner===TREASURY));assert.equal(treasuryOp.paycheck.protocolUnits,'1800000000');assert.equal(treasuryOp.paycheck.curveUnits,'400000000');assert.equal(treasuryOp.paycheck.burnUnits,'1400000000');
  const view=publicHolderRewards(h.l);assert.equal(view.paycheck.paidToHolders,'2');assert.equal(view.paycheck.paidToProtocol,'1.8');assert.equal(view.paycheck.cycles,1);assert.equal(view.paycheck.accruingWallets,0);
});

test('shares below $0.50 accrue in the ledger, a seller forfeits them and the rest is paid once it is due',async t=>{
  const [a,b]=[address(),address()],h=await harness(t,launch('20000000'),[payout(a,3),payout(b,1)]);
  await h.process();await h.settle();
  // Holders 10,000,000: A 7,500,000 (paid), B 2,500,000 (accrues). Creator 1,000,000 waits; the treasury's 9,000,000 is paid.
  let l=h.l,paid=byOwner(l.operations.filter(op=>op.kind==='payout'&&op.state==='confirmed'));
  assert.equal(paid.get(a),7500000n);assert.equal(paid.get(b),undefined);assert.equal(paid.get(CREATOR),undefined);assert.equal(paid.get(TREASURY),9000000n);
  assert.equal(l.credits.quote,'3500000');assert.deepEqual(l.paycheck.holders,{[b]:{accrued:'2500000',balance:'1'}});assert.deepEqual(l.paycheck.split,{creator:'1000000',burn:'0',curve:'0'});
  assert.equal(paycheckLedgerTotal(paycheckLedger(l)),3500000n,'the unpaid shares are exactly the remaining credit');
  // Fifteen minutes later nothing new was claimed: the ledger waits and no snapshot is taken.
  h.advance(900001);await h.edit(l=>{l.feesRequested=true;l.cycle={stage:'distribute',index:0};});await h.process();await h.settle();
  assert.equal(h.snapshots.length,1);assert.equal(h.l.credits.quote,'3500000');assert.equal(h.l.paycheck.cycles,2);
  // Another 20,000,000 arrives and B has sold: B's 2,500,000 goes to A with the new holder share; the creator reaches the line later.
  h.rows.splice(1,1);h.advance(900001);await h.edit(l=>{l.feesRequested=true;l.credits.quote='23500000';l.cycle={stage:'distribute',index:0};});await h.process();await h.settle();
  l=h.l;const second=byOwner(l.operations.filter(op=>op.kind==='payout'&&op.state==='confirmed'));
  assert.equal(second.get(a),7500000n+12500000n);assert.equal(second.get(TREASURY),18000000n);assert.equal(second.get(b),undefined);
  assert.equal(l.paycheck.totals.forfeited,'2500000');assert.deepEqual(l.paycheck.holders,{});assert.deepEqual(l.paycheck.split,{creator:'2000000',burn:'0',curve:'0'});assert.equal(l.credits.quote,'2000000');
  assert.equal(h.snapshots.length,2);
});
