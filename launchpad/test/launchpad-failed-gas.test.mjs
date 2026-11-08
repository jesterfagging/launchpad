import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PublicKey} from '@solana/web3.js';
import {Launchpad} from '../src/launchpad.mjs';
import {newLaunchKeys} from '../src/launchpad-receipts.mjs';
import {launchInput,USDC_MINT} from '../public/launchpad-model.mjs';
import {HOLDER_REWARD_POLICY} from '../src/launchpad-holder-rewards.mjs';
import {activeRewardsFixture} from './helpers/rewards-wallet-fixture.mjs';

const NOW=Date.parse('2026-09-29T12:00:00Z');
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-failed-gas-')),saved=new Map();let now=NOW,receiptReads=0;const receipts=new Map();
  const l=activeRewardsFixture({id:'a'.repeat(32),input:{...launchInput({name:'Reward gas',symbol:'GAS',feeMode:'holders',quoteMint:USDC_MINT}),dailyGasLamports:'30000000'},keys:{...newLaunchKeys(),payer:newLaunchKeys().wallet},review:{quoteDecimals:6},feeCustody:'relay',authorizedAt:NOW-1,createdAt:NOW-1,curve:newLaunchKeys().mint.address,state:'live',autoFees:true,feesRequested:true,feeAutomation:{enabled:true,source:'launch',updatedAt:NOW-1},credits:{base:'0',quote:'200000000'},cycle:{stage:'payout',index:0,holderRewardPolicy:HOLDER_REWARD_POLICY,payouts:[{owner:newLaunchKeys().wallet.address,amount:'200000000'}]},gas:{day:'2026-09-29',reserved:'0'},operations:[]},NOW),book={launches:[l]};
  const accounts={dir,storeFor:()=>({dir,read:async(name,fallback)=>name==='launchpad'?book:fallback,write:async(name,value)=>saved.set(name,structuredClone(value))})};
  const manager=new Launchpad(accounts,null,{now:()=>now,chainFactory:()=>c});manager.kick=()=>{};
  const c={prepare:async()=>({signature:'failed-'+(l.operations.length+1),state:'pending',raw:'saved-bytes',createdAt:now}),broadcast:async()=>{},close(){},payoutInstructions:async()=>['payout'],receipt:async op=>{receiptReads++;return receipts.get(op.signature)||null;}};
  const send=async(kind='payout')=>{await manager.send('a',book,l,c,kind,['instruction'],{amount:'200000000',payouts:l.cycle.payouts,reserve:'10000000'});return l.operations.at(-1);};
  const fail=async(op,mutate=()=>{})=>{
    const payer=op.kind.startsWith('protocol-')?l.keys[op.protocolFeeWallet.source].address:l.keys[op.rewardsWallet?.signerSource||'wallet'].address;
    const receipt={slot:100,transaction:{signatures:[op.signature],message:{accountKeys:[new PublicKey(payer)]}},meta:{err:{InstructionError:[0,{Custom:1}]},fee:5000,preBalances:[100000000],postBalances:[99995000]}};
    mutate(receipt);receipts.set(op.signature,receipt);await manager.reconcile('a',book,l,c,op);
  };
  t.after(async()=>{await manager.close();await rm(dir,{recursive:true,force:true});});
  return {l,book,manager,send,fail,receipts,get receiptReads(){return receiptReads;},get saved(){return saved.get('launchpad')?.launches[0];},advance(ms){now+=ms;}};
}

test('failed payout receipts charge actual fees, allowing later retries within the original daily budget',async t=>{
  const h=await fixture(t),credits=structuredClone(h.l.credits),cycle=structuredClone(h.l.cycle);
  for(let count=1;count<=8;count++){
    const op=await h.send();await h.fail(op);
    assert.equal(op.state,'failed');assert.equal(op.failedNetworkCostLamports,'5000');assert.equal(h.l.gas.reserved,String(count*5000));assert.equal(h.l.rewardRetry.kind,'transaction');
    assert.deepEqual(h.l.credits,credits);assert.deepEqual(h.l.cycle,cycle);
    const settled=h.l.gas.reserved;await h.manager.reconcile('a',h.book,h.l,{receipt:async()=>{throw Error('already terminal');}},op);assert.equal(h.l.gas.reserved,settled,'the same failed receipt cannot release its reserve twice');
  }
  assert.equal(h.saved.gas.reserved,'40000');assert(h.l.operations.every(op=>op.state==='failed'));assert.equal(h.l.input.dailyGasLamports,'30000000');
});

test('failed fee accounting requires finalized identity, exact saved payer and complete native fee evidence',async t=>{
  const changes=[
    tx=>{delete tx.meta.fee;},tx=>{tx.meta.fee=-1;},tx=>{tx.meta.fee=Number.MAX_SAFE_INTEGER+1;},
    tx=>{tx.transaction.signatures[0]='another-signature';},tx=>{tx.transaction.message.accountKeys[0]=new PublicKey(newLaunchKeys().wallet.address);},
    tx=>{tx.confirmationStatus='confirmed';},tx=>{tx.slot=0;},tx=>{tx.meta.postBalances[0]--;},
    tx=>{tx.meta.preBalances.push(1);},tx=>{tx.meta.postBalances=[];},
    tx=>{tx.transaction.message.accountKeys.push(new PublicKey(newLaunchKeys().wallet.address));tx.meta.preBalances.push(2);tx.meta.postBalances.push(1);},
  ];
  for(const mutate of changes){const h=await fixture(t),op=await h.send();await h.fail(op,mutate);assert.equal(op.state,'failed');assert.equal(op.failedNetworkCostLamports,undefined);assert.equal(h.l.gas.reserved,'10000000');assert.equal(h.l.credits.quote,'200000000');}
});

test('a late failed receipt cannot deduct yesterday’s reservation from a newer gas day',async t=>{
  const h=await fixture(t),op=await h.send();h.advance(86400000);h.l.gas={day:'2026-09-30',reserved:'25000000'};await h.fail(op);
  assert.equal(h.l.gas.reserved,'25000000');assert.equal(op.failedNetworkCostLamports,undefined);assert.equal(op.state,'failed');
});

test('protocol failure uses its saved signer and explicit reward pauses remain disabled',async t=>{
  const h=await fixture(t);h.l.keys.protocol=newLaunchKeys().wallet;h.l.protocolFeeWallet={source:'protocol',address:h.l.keys.protocol.address};
  const op=await h.send('protocol-claim');h.l.autoFees=false;h.l.feeAutomation.enabled=false;h.l.feeAutomation.source='user';await h.fail(op);
  assert.equal(op.failedNetworkCostLamports,'5000');assert.equal(h.l.gas.reserved,'5000');assert.equal(h.l.autoFees,false);assert.equal(h.l.feeAutomation.enabled,false);assert.equal(h.l.rewardRetry,undefined);assert.equal(h.l.credits.quote,'200000000');
});

test('today’s legacy failed reservations recover one receipt per pass and resume without waiting for midnight',async t=>{
  const h=await fixture(t);
  for(let i=0;i<3;i++){const op=await h.send();await h.fail(op,tx=>{delete tx.meta.fee;});h.receipts.get(op.signature).meta.fee=5000;}
  h.l.rewardRetry={kind:'gas-budget',at:NOW+43201000,attempt:1,reason:'Daily budget used'};h.l.error='Automatic rewards will continue after the daily gas budget resets.';
  const before=structuredClone(h.l.credits),reads=h.receiptReads;assert.equal(h.l.gas.reserved,'30000000');
  await h.manager.process('a');assert.equal(h.receiptReads,reads+1);assert.equal(h.l.gas.reserved,'20005000');assert.equal(h.l.rewardRetry.kind,'gas-budget');assert.equal(h.manager.wakeAt.get('a'),NOW+1000);assert.equal(h.l.operations.length,3);
  await h.manager.process('a');assert.equal(h.receiptReads,reads+2);assert.equal(h.l.rewardRetry,undefined);assert.equal(h.l.state,'live');assert.equal(h.l.operations.length,4);assert.equal(h.l.operations[3].state,'pending');assert.equal(h.l.gas.reserved,'14010000');assert.deepEqual(h.l.credits,before);
  assert.equal(h.l.operations.filter(op=>op.failedNetworkCostLamports==='5000').length,2);assert.equal(h.l.operations[2].failedNetworkCostLamports,undefined);
});

test('legacy gas repair retains unavailable receipts, backs off and respects explicit owner pauses',async t=>{
  const h=await fixture(t),op=await h.send();await h.fail(op,tx=>{delete tx.meta.fee;});h.l.gas.reserved='30000000';h.l.rewardRetry={kind:'gas-budget',at:NOW+43201000,attempt:1,reason:'Daily budget used'};h.l.error='Automatic rewards will continue after the daily gas budget resets.';
  const reads=h.receiptReads;await h.manager.process('a');assert.equal(h.receiptReads,reads+1);assert.equal(h.l.gas.reserved,'30000000');assert.equal(h.l.operations.length,1);assert.equal(op.failedFeeCheckAfter,NOW+60000);assert.equal(h.manager.wakeAt.get('a'),NOW+60000);
  await h.manager.process('a');assert.equal(h.receiptReads,reads+1);h.advance(60000);h.l.feeAutomation.enabled=false;h.l.autoFees=false;h.l.feesRequested=false;h.l.state='paused';const before=structuredClone(h.l);await h.manager.process('a');assert.equal(h.receiptReads,reads+1);assert.deepEqual(h.l,before);
});
