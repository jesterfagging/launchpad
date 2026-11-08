import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Launchpad} from '../src/launchpad.mjs';
import {LaunchpadAdmin} from '../src/launchpad-admin.mjs';
import {AdminPanel} from '../src/admin-panel.mjs';
import {newLaunchKeys} from '../src/launchpad-receipts.mjs';
import {launchInput,USDC_MINT} from '../public/launchpad-model.mjs';
import {MANUAL_REWARD_AUTH_ERROR,manualHolderAuthorizer} from '../src/launchpad-manual-distribution.mjs';
import {TAX_CONVERSION_MAX_UNITS} from '../src/launchpad-tax-conversion.mjs';
import {activeRewardsFixture,rewardFixtureReceipt} from './helpers/rewards-wallet-fixture.mjs';

const START=1700000000000,OWNER='a'.repeat(32),ACTOR='b'.repeat(32),OTHER='c'.repeat(32),REQUEST='1'.repeat(32),RESUME='2'.repeat(32),CAP=TAX_CONVERSION_MAX_UNITS;
const address=()=>newLaunchKeys().wallet.address;
async function setup(t,{kind='sell',base='9',quote='0'}={}){
  const dir=await mkdtemp(join(tmpdir(),'manual-reward-auth-')),keys=newLaunchKeys();keys.payer=newLaunchKeys().wallet;keys.platform=keys.wallet;
  const input=launchInput({name:'Manual rewards',symbol:'RWD',feeMode:'holders',quoteMint:USDC_MINT});input.taxBps=200;
  const l=activeRewardsFixture({id:'d'.repeat(32),input,keys,review:{minimumSol:'0.06',quoteDecimals:6,quoteSymbol:'USDC',price:{usd:'1'},devBuy:{gross:'0'}},feeCustody:'relay',curve:address(),state:'live',phase:'verify',createdAt:START,authorizedAt:START,lastCycle:START,autoFees:false,feeAutomation:{enabled:false,source:'user',updatedAt:START},feesRequested:false,operations:[],credits:{base,quote},gas:{day:new Date(START).toISOString().slice(0,10),reserved:'0'}},START);
  if(kind==='reward-handoff'){delete l.keys.rewards;delete l.rewardsWallet;}
  if(kind==='existing-payout')l.cycle={stage:'payout',id:'saved-allocation',index:1,payouts:[{owner:address(),amount:'5'},{owner:address(),amount:quote}],distributedQuoteUnits:'5',lastPayoutAt:START-1,holderRewardChecked:true};
  if(kind==='existing-sale')l.cycle={stage:'route',id:'saved-automatic',index:0,createdAt:START-1,manual:false};
  const users=new Map([[OWNER,{id:OWNER,role:'user',mfaEnabled:true,mainWallet:keys.payer.address}],[ACTOR,{id:ACTOR,role:'admin',mfaEnabled:true,username:'first',mainWallet:address()}],[OTHER,{id:OTHER,role:'admin',mfaEnabled:true,username:'second',mainWallet:address()}]]),books=new Map([[OWNER,{version:1,launches:[l]}],[ACTOR,{launches:[]}],[OTHER,{launches:[]}]]);
  const accounts={dir,get:async id=>structuredClone(users.get(id)),list:async()=>structuredClone([...users.values()]),hostStore:{read:async(name,fallback)=>name==='launch-protocol-fees'?{recipient:address(),recipientScope:'launchpad'}:fallback},storeFor:id=>({dir:join(dir,id),read:async()=>structuredClone(books.get(id)),write:async(_name,value)=>books.set(id,structuredClone(value))})};
  const prepared=[],broadcasts=[],receipts=new Map();let beforePrepare=()=>{},manager,panel;
  const chain={close(){},rewardsGasFundingPlan:async()=>({gasLamports:'0',ready:true}),rewardHandoffInstructions:async()=>['handoff'],claimInstructions:async(_l,stage)=>kind==='claim'&&stage==='creator'||kind==='tax'&&stage==='tax'?['claim']:[],holderSnapshot:async()=>({slot:100,rows:[{owner:address(),amount:'1'}]}),payoutInstructions:async(_l,rows)=>rows,taxConversionPlan:async(_l,credit)=>({amount:(BigInt(credit)<CAP?BigInt(credit):CAP).toString()}),swapFeeInstructions:async()=>['sell'],receipt:async op=>receipts.get(op.signature)||null,c:{getBlockHeight:async()=>1},prepare:async(_l,instructions,_extra,_initial,{operation})=>{prepared.push({...operation,instructions});beforePrepare();return{state:'pending',signature:`saved-${prepared.length}`,raw:`signed-${prepared.length}`,createdAt:START,lastValidBlockHeight:100};},broadcast:async op=>{assert(books.get(OWNER).launches[0].operations.some(saved=>saved.signature===op.signature));broadcasts.push(op.signature);}};
  const restart=async()=>{await panel?.close();await manager?.close();manager=new Launchpad(accounts,null,{chainFactory:()=>chain,now:()=>START});manager.kick=()=>{};panel=new AdminPanel({accounts,launchpad:manager,launchAdmin:new LaunchpadAdmin({accounts,launchpad:manager,now:()=>START}),now:()=>START});};await restart();
  t.after(async()=>{await panel.close();await manager.close();await rm(dir,{recursive:true,force:true});});
  return{users,books,prepared,broadcasts,receipts,restart,get saved(){return books.get(OWNER).launches[0];},get panel(){return panel;},set onPrepare(fn){beforePrepare=fn;},async queue(actor=ACTOR,requestId=REQUEST){return panel.launchAction(actor,{accountId:OWNER,id:l.id,action:'distribute',requestId});},async step(){await manager.process(OWNER);},async untilStopped(){for(let n=0;n<8&&!this.saved.operations.some(op=>op.state==='pending')&&this.saved.manualHolderDistribution?.state!=='blocked';n++)await this.step();},async confirm(quoteDelta,baseDelta){const op=this.saved.operations.find(op=>op.state==='pending');assert(op);receipts.set(op.signature,rewardFixtureReceipt(this.saved,{operation:op,quote:quoteDelta,base:baseDelta}));await this.step();}};
}

test('current role, MFA and ban checks stop manual claims, handoffs, sales and saved payouts before signing',async t=>{
  for(const [kind,revoke] of [['claim',u=>{u.role='user';}],['tax',u=>{u.mfaEnabled=false;}],['reward-handoff',u=>{u.banned=true;}],['sell',u=>{u.role='user';}],['existing-payout',u=>{u.mfaEnabled=false;}]]){
    const h=await setup(t,{kind,base:'9',quote:'2'});await h.queue();const credits=structuredClone(h.saved.credits),cycle=structuredClone(h.saved.cycle);
    revoke(h.users.get(ACTOR));await h.untilStopped();assert.equal(h.saved.manualHolderDistribution.state,'blocked',kind);assert.equal(h.saved.error,MANUAL_REWARD_AUTH_ERROR,kind);assert.equal(h.prepared.length,0,kind);assert.equal(h.broadcasts.length,0);assert.deepEqual(h.saved.credits,credits);assert.equal(h.saved.operations.length,0);if(cycle)assert.deepEqual(h.saved.cycle,cycle);
  }
});

test('revocation during preparation prevents committing or broadcasting newly signed manual bytes',async t=>{
  const h=await setup(t);await h.queue();const credits=structuredClone(h.saved.credits);h.onPrepare=()=>{h.users.get(ACTOR).mfaEnabled=false;};await h.untilStopped();
  assert.equal(h.prepared.length,1);assert.equal(h.prepared[0].manualHolderDistributionRequest,REQUEST);assert.equal(h.broadcasts.length,0);assert.equal(h.saved.operations.length,0);assert.deepEqual(h.saved.credits,credits);assert.equal(h.saved.manualHolderDistribution.state,'blocked');assert.equal(h.saved.error,MANUAL_REWARD_AUTH_ERROR);assert.equal(h.saved.gas.reserved,'0');
});

test('a revoked actor cannot sign again after its saved receipt settles; a new audited administrator continues the same snapshot',async t=>{
  const h=await setup(t,{base:(CAP+9n).toString()});await h.queue();await h.untilStopped();const original=structuredClone(h.saved.operations[0]);assert.equal(original.kind,'sell');
  h.users.get(ACTOR).role='user';await h.restart();await h.step();assert.deepEqual(h.saved.operations[0],original);assert.equal(h.prepared.length,1);
  await h.confirm(10n,-CAP);assert.equal(h.saved.operations[0].state,'confirmed');assert.equal(h.saved.manualHolderDistribution.remainingBaseUnits,'9');await h.untilStopped();
  assert.equal(h.saved.manualHolderDistribution.state,'blocked');assert.deepEqual(h.saved.credits,{base:'9',quote:'10'});assert.equal(h.prepared.length,1);const snapshot=structuredClone(h.saved.manualHolderDistribution);
  await assert.rejects(h.panel.launchAction(OTHER,{accountId:OWNER,id:h.saved.id,action:'resume-rewards',requestId:'3'.repeat(32)}),/Distribute now/);
  const response=await h.queue(OTHER,RESUME);assert.equal(response.requestId,REQUEST);assert.equal(h.saved.manualHolderDistribution.requestId,REQUEST);assert.equal(h.saved.manualHolderDistribution.snapshotAt,snapshot.snapshotAt);assert.equal(h.saved.manualHolderDistribution.remainingBaseUnits,'9');assert.equal(manualHolderAuthorizer(h.saved,REQUEST),OTHER);
  await h.untilStopped();assert.equal(h.prepared.length,2);assert.equal(h.saved.operations[1].amount,'9');assert.equal(h.saved.operations[1].manualHolderDistributionRequest,REQUEST);assert.equal(h.saved.operations[0].signature,original.signature);
  // Restoring/replaying the original actor does not replace the newer audit.
  h.users.get(ACTOR).role='admin';await h.queue(ACTOR,REQUEST);assert.equal(manualHolderAuthorizer(h.saved,REQUEST),OTHER);h.users.get(OTHER).mfaEnabled=false;
  await h.confirm(1n,-9n);await h.untilStopped();assert.equal(h.saved.manualHolderDistribution.state,'blocked');assert.equal(h.prepared.length,2);assert.deepEqual(h.saved.credits,{base:'0',quote:'11'});assert.equal(h.saved.operations.filter(op=>op.state==='confirmed').length,2);
});

test('a manual request waiting behind an automatic sale retains the automatic receipt accounting',async t=>{
  const h=await setup(t,{kind:'existing-sale',base:(CAP+9n).toString()});await h.queue();assert.equal(h.saved.manualHolderDistribution.phase,'existing');await h.untilStopped();
  const op=h.saved.operations[0];assert.equal(op.kind,'sell');assert.equal(op.amount,CAP.toString());assert.equal(op.manualHolderDistributionRequest,undefined);assert.equal(h.saved.manualHolderDistribution.snapshotAt,undefined);
  await h.confirm(10n,-CAP);assert.equal(h.saved.operations[0].state,'confirmed');assert.deepEqual(h.saved.credits,{base:'9',quote:'10'});assert.equal(h.saved.manualHolderDistribution.snapshotAt,undefined);assert.notEqual(h.saved.manualHolderDistribution.state,'blocked');assert.equal(h.saved.error,'');
});
