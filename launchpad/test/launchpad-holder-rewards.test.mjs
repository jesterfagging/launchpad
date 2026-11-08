import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {activeRewardsFixture,rewardFixtureReceipt,rewardFixtureHandoffReceipt} from './helpers/rewards-wallet-fixture.mjs';
import { Launchpad, publicLaunch, requestFees } from '../src/launchpad.mjs';
import { newLaunchKeys } from '../src/launchpad-receipts.mjs';
import { launchInput, USDC_MINT, units } from '../public/launchpad-model.mjs';
import { feeCycleDueAt, holderRewardPolicy, holderRewardMinimum, currentHolderRewardMinimum, holderRewardDistributionStats, referenceRewardMinimum, HOLDER_REWARD_INTERVAL_MS, holderRewardCheckDueAt, taxConversionDueAt } from '../src/launchpad-holder-rewards.mjs';
import { TAX_CONVERSION_INTERVAL_MS, TAX_CONVERSION_MAX_UNITS } from '../src/launchpad-tax-conversion.mjs';

const START = 1700000000000;
const address = () => newLaunchKeys().wallet.address;
function launch(extra={}) {
  const input=launchInput({name:'Rewards',symbol:'RWD',feeMode:'holders',quoteMint:USDC_MINT,holderRewardMinimum:'10'}),keys=newLaunchKeys();keys.payer=newLaunchKeys().wallet;keys.platform=keys.wallet;
  return activeRewardsFixture({id:'a'.repeat(32),input,keys,review:{minimumSol:'0.06',quoteDecimals:6,price:{usd:'1'},devBuy:{gross:'0'}},holderRewards:{minimumQuoteUnits:'10000000'},feeCustody:'relay',curve:address(),state:'live',phase:'verify',createdAt:START,authorizedAt:START,lastCycle:START,autoFees:true,feesRequested:false,operations:[],credits:{quote:'0',base:'0'},gas:{day:new Date(START).toISOString().slice(0,10),reserved:'0'},...extra},START);
}
function receipt(l,quote,base=0n) {return rewardFixtureReceipt(l,{quote,base});}

async function harness(t,initial=launch()) {
  const dir=await mkdtemp(join(tmpdir(),'launchpad-holder-rewards-')),books=new Map([['a:launchpad',{version:1,launches:[structuredClone(initial)]}]]),receipts=new Map(),prepared=[],broadcasts=[];
  let now=START,claimReads=0,snapshots=0,kicks=0,claims=true;
  const holders=[{owner:address(),amount:'3'},{owner:address(),amount:'1'}];
  const treasury={recipient:address(),recipientScope:'launchpad'};
  const accounts={dir,hostStore:{read:async(name,fallback)=>name==='launch-protocol-fees'?treasury:fallback},get:async()=>({mainWallet:initial.keys.payer.address}),storeFor:id=>({dir:join(dir,id),read:async(key,fallback)=>structuredClone(books.get(id+':'+key)||fallback),write:async(key,value)=>books.set(id+':'+key,structuredClone(value))})};
  const c={close(){},rewardsGasFundingPlan:async()=>({gasLamports:'0',ready:true}),rewardHandoffInstructions:async()=>['handoff'],holderRewardReference:async l=>({mint:l.input.quoteMint,usd:'1',at:now}),claimInstructions:async()=>{claimReads++;return claims?['claim']:[];},holderSnapshot:async()=>{snapshots++;return {slot:100,rows:holders};},payoutInstructions:async(_,rows)=>rows,receipt:async op=>receipts.get(op.signature)||null,c:{getBlockHeight:async()=>1},prepare:async(l,instructions)=>{const signature='signature-'+(prepared.length+1);prepared.push({launch:l.id,instructions});return {state:'pending',signature,raw:'raw-'+signature,createdAt:now,lastValidBlockHeight:100};},broadcast:async op=>{assert(books.get('a:launchpad').launches[0].operations.some(saved=>saved.signature===op.signature&&saved.raw===op.raw));broadcasts.push(op.signature);}};
  let manager;
  const restart=async()=>{await manager?.close();manager=new Launchpad(accounts,null,{chainFactory:()=>c,now:()=>now});manager.kick=()=>{kicks++;};return manager;};await restart();
  t.after(async()=>{await manager.close();await rm(dir,{recursive:true,force:true});});
  return {books,c,prepared,broadcasts,receipts,holders,restart,async admin(){await manager.locked('a',async b=>{const l=b.launches[0],requestId='admin-'+(l.adminRewardHistory?.length||0);requestFees(l);l.holderDistributionAdminRequest=requestId;l.adminRewardHistory=[...(l.adminRewardHistory||[]),{requestId,actorId:'admin',launchId:l.id,action:'distribute'}];await manager.save('a',b);});},get manager(){return manager;},get saved(){return books.get('a:launchpad').launches[0];},get now(){return now;},get claimReads(){return claimReads;},get snapshots(){return snapshots;},get kicks(){return kicks;},set claims(value){claims=value;},advance(ms){now+=ms;},setTime(value){now=value;},async confirmHandoff(){const l=this.saved,op=l.operations.find(x=>x.state==='pending');assert.equal(op?.kind,'reward-handoff');receipts.set(op.signature,rewardFixtureHandoffReceipt(l,op));await manager.process('a');},async confirm(quote,base=0n){const l=this.saved,op=l.operations.find(x=>x.state==='pending');assert(op);receipts.set(op.signature,receipt(l,quote,base));await manager.process('a');}};
}

test('holder checks wait an entire hour across restarts and schedule their next completed-cycle check',async t=>{
  const h=await harness(t);h.claims=false;
  await h.manager.process('a');assert.equal(h.claimReads,0);assert.equal(h.manager.wakeAt.get('a'),START+HOLDER_REWARD_INTERVAL_MS);
  h.advance(HOLDER_REWARD_INTERVAL_MS-1);await h.manager.process('a');assert.equal(h.claimReads,0);
  await h.restart();await h.manager.process('a');assert.equal(h.claimReads,0,'a restart must not make a scheduled cycle due early');
  h.advance(1);await h.manager.process('a');assert.equal(h.claimReads,1);assert.equal(h.saved.lastCycle,h.now);assert.equal(h.saved.cycle,null);assert.equal(h.manager.wakeAt.get('a'),h.now+HOLDER_REWARD_INTERVAL_MS);
  assert.equal(publicLaunch(h.saved).holderRewards.nextCheckAt,h.now+HOLDER_REWARD_INTERVAL_MS);
  assert.equal(publicLaunch(h.saved).holderRewards.lastDistributionAt,null);
});

test('creator and buyback automatic schedules retain their existing one-minute interval',()=>{
  for(const feeMode of ['creator','buyback']){const l=launch();l.input.feeMode=feeMode;assert.equal(feeCycleDueAt(l),START+60000);}
});

test('automatic holder payouts hold $99.999999 and distribute all earned credits at $100',async t=>{
  const h=await harness(t,launch({credits:{quote:'99999999',base:'0'}}));h.claims=false;h.advance(HOLDER_REWARD_INTERVAL_MS);
  await h.manager.process('a');assert.equal(h.saved.credits.quote,'99999999');assert.equal(h.snapshots,0);assert.equal(h.prepared.length,0);
  const b=await h.manager.book('a');b.launches[0].credits.quote='100000000';await h.manager.save('a',b);h.advance(HOLDER_REWARD_INTERVAL_MS);
  await h.manager.process('a');const payout=h.saved.operations.at(-1);assert.equal(payout.kind,'payout');assert.deepEqual(payout.rewardsWallet,{version:1,source:'rewards',address:h.saved.keys.rewards.address,signerSource:'rewards'});assert.notEqual(h.saved.keys.rewards.address,h.saved.keys.wallet.address);assert.equal(payout.amount,'100000000');assert.deepEqual(payout.payouts.map(x=>x.amount).sort(),['25000000','75000000']);
  assert.equal(publicLaunch(h.saved).holderRewards.lastDistributionAt,null);await h.confirm(-100000000n);await h.manager.process('a');
  assert.equal(h.saved.credits.quote,'0');assert.equal(publicLaunch(h.saved).holderRewards.lastDistributionQuote,'100');assert.equal(publicLaunch(h.saved).holderRewards.minimumUsd,100);
});
test('current quote prices enforce $100 for existing coins despite developer-selected historical values',async t=>{
  const h=await harness(t,launch({holderRewards:{minimumQuoteUnits:'1'},credits:{quote:'100000000',base:'0'}}));h.claims=false;
  h.c.holderRewardReference=async l=>({mint:l.input.quoteMint,usd: h.now===START+HOLDER_REWARD_INTERVAL_MS?'0.5':'2',at:h.now});
  h.advance(HOLDER_REWARD_INTERVAL_MS);await h.manager.process('a');assert.equal(h.snapshots,0);assert.equal(h.saved.holderRewards.minimumQuoteUnits,'200000000');
  h.advance(HOLDER_REWARD_INTERVAL_MS);await h.restart();await h.manager.process('a');assert.equal(h.saved.operations.at(-1).amount,'100000000');assert.equal(h.saved.holderRewards.minimumQuoteUnits,'50000000');
});
test('USDC, SOL and WBTC fixed minima round up in atomic units and ignore custom minimum input',()=>{
  const input={feeMode:'holders'},usdc={quoteDecimals:6,price:{usd:'1'}},wbtc={quoteDecimals:8,price:{usd:'80000'}};
  assert.equal(holderRewardPolicy(input,usdc,'0.000001').minimumQuoteUnits,'100000000');assert.equal(holderRewardPolicy(input,wbtc,'100').minimumQuoteUnits,'125000');
  assert.equal(holderRewardPolicy(input,{quoteDecimals:9,price:{usd:'150'}}).minimumQuoteUnits,'666666667');
  assert.equal(holderRewardPolicy(input,{quoteDecimals:0,price:{usd:'100000000'}}).minimumQuoteUnits,'1');
  assert.equal(referenceRewardMinimum({quoteDecimals:6,price:{usd:'3'}},1n),3334n,'automatic per-holder dust remains separate');
  const l=launch();assert.equal(holderRewardMinimum(l),100000000n);assert.throws(()=>holderRewardPolicy(input,{quoteDecimals:6,price:{usd:'0'}}),/positive/);
  for(const ref of [{mint:l.input.quoteMint,usd:'1',at:START-60001},{mint:l.input.quoteMint,usd:'1',at:START+1},{mint:address(),usd:'1',at:START},{mint:l.input.quoteMint,usd:'1',at:START,stale:true}])assert.throws(()=>currentHolderRewardMinimum(l,ref,START),/fresh quote/);
});
test('new drafts capture the platform minimum without honoring injected developer limits',async t=>{
  const h=await harness(t);h.c.preview=async()=>({minimumSol:'0.06',quoteDecimals:8,price:{usd:'80000'},devBuy:{gross:'0'}});
  h.manager.ownedImage=async()=>({bytes:Buffer.alloc(0),type:'image/png'});h.manager.metadataStorage={prepare:async()=>({uri:'https://example.com/token.json',imageUrl:'https://example.com/token.png',metadata:{},storage:{budget:'0',items:[]}})};
  const {launch:l}=await h.manager.buildDraft('a',{input:{...launch().input,holderRewardMinimum:'0.000000001'},payer:launch().keys.payer,inputHash:'hash'});
  assert.equal(l.holderRewards.minimumUsd,100);assert.equal(l.holderRewards.minimumQuoteUnits,'125000');assert.equal(publicLaunch(l).holderRewards.minimumUsd,100);assert.equal(h.broadcasts.length,0);
});
test('developer actions cannot change the policy, trigger manual holder claims, or forge the admin override',async t=>{
  const h=await harness(t,launch({autoFees:false,credits:{quote:'100000',base:'0'}})),before=structuredClone(h.saved);
  for(const action of ['fees','holder-distribute','rewards-settings'])await assert.rejects(h.manager.action('a',h.saved.id,action,{minimumQuote:'0',admin:true,forceHolderDistribution:true}),e=>e.statusCode===403);
  assert.deepEqual(h.saved,before);assert.equal(h.kicks,0);assert.equal(h.prepared.length,0);
  await assert.rejects(h.manager.action('b',h.saved.id,'holder-distribute'),/not found/);
});
test('legacy force flags cannot bypass the fixed threshold after restart',async t=>{
  const h=await harness(t,launch({feesRequested:true,forceHolderDistribution:true,cycle:{stage:'distribute',index:0,manual:true,forceHolderDistribution:true,holderMinimumQuoteUnits:'1'},credits:{quote:'100000',base:'0'}}));h.claims=false;
  h.advance(HOLDER_REWARD_INTERVAL_MS);await h.restart();await h.manager.process('a');assert.equal(h.prepared.length,0);assert.equal(h.saved.credits.quote,'100000');assert.equal(h.saved.forceHolderDistribution,undefined);
});
test('missing or stale USD prices defer automatic claims and payouts without losing earned credit',async t=>{
  for(const invalid of ['missing','stale','wrong-mint']){
    const h=await harness(t,launch({credits:{quote:'1000000000',base:'0'}}));h.c.holderRewardReference=async l=>{if(invalid==='missing')throw Error('Unavailable');return{mint:invalid==='wrong-mint'?address():l.input.quoteMint,usd:'1',at:h.now-60001};};
    h.advance(HOLDER_REWARD_INTERVAL_MS);await h.manager.process('a');assert.equal(h.claimReads,0);assert.equal(h.prepared.length,0);assert.equal(h.saved.credits.quote,'1000000000');assert.match(h.saved.holderRewards.thresholdNote,/fresh quote price/);assert.equal(h.saved.state,'live');
  }
});
test('admin distribution can claim and distribute below $100 without a price reference, including sub-cent balances',async t=>{
  const h=await harness(t,launch({autoFees:false,state:'paused',credits:{quote:'4',base:'0'}}));h.claims=false;h.c.holderRewardReference=async()=>{throw Error('No price');};
  await h.admin();await h.manager.process('a');assert.equal(h.saved.operations[0].amount,'4');assert.deepEqual(h.saved.operations[0].payouts.map(x=>x.amount).sort(),['1','3']);assert.equal(h.saved.autoFees,false);
  await h.confirm(-4n);await h.manager.process('a');assert.equal(h.saved.holderDistributionAdminRequest,undefined);assert.equal(publicLaunch(h.saved).holderRewards.totalDistributedQuote,'0.000004');
});
test('admin overrides survive restart and finish each unpaid holder exactly once',async t=>{
  const h=await harness(t,launch({autoFees:false,credits:{quote:'12000000',base:'0'}}));h.claims=false;h.holders.splice(0,h.holders.length,...Array.from({length:4},()=>({owner:address(),amount:'1'})));
  await h.admin();await h.manager.process('a');const first=h.saved.operations.at(-1);assert.equal(first.amount,'9000000');await h.confirm(-9000000n);await h.manager.action('a',h.saved.id,'pause');await h.restart();await h.manager.process('a');assert.equal(h.prepared.length,1);
  await h.admin();await h.manager.process('a');const second=h.saved.operations.at(-1);assert.equal(second.amount,'3000000');assert.equal(h.snapshots,1);assert(!first.payouts.some(row=>row.owner===second.payouts[0].owner));
  await h.confirm(-3000000n);await h.manager.process('a');assert.equal(publicLaunch(h.saved).holderRewards.lastDistributionQuote,'12');assert.equal(h.saved.credits.quote,'0');
});

test('automatic partial payouts retry transient preparation after restart without paying confirmed recipients twice',async t=>{
  const h=await harness(t,launch({feeAutomation:{enabled:true},credits:{quote:'400000000',base:'0'}}));h.claims=false;
  h.holders.splice(0,h.holders.length,...Array.from({length:4},()=>({owner:address(),amount:'1'})));h.advance(HOLDER_REWARD_INTERVAL_MS);
  await h.manager.process('a');const first=structuredClone(h.saved.operations.at(-1));assert.equal(first.kind,'payout');assert.equal(first.payouts.length,3);await h.confirm(-300000000n);
  const cycle=structuredClone(h.saved.cycle);assert.equal(cycle.index,3);let attempts=0;
  h.c.payoutInstructions=async(_,rows)=>{attempts++;if(attempts===1)throw Object.assign(Error('RPC connection reset'),{code:'ECONNRESET'});return rows;};
  await h.manager.process('a');assert.equal(h.saved.state,'live');assert.equal(h.saved.autoFees,true);assert.equal(h.saved.feeAutomation.enabled,true);assert.deepEqual(h.saved.cycle,cycle);assert.equal(h.saved.credits.quote,'100000000');assert.equal(h.prepared.length,1);
  const retry=structuredClone(h.saved.rewardRetry);assert.equal(retry.at,h.now+30000);assert.equal(retry.attempt,1);
  await h.restart();await h.manager.process('a');assert.equal(attempts,1);assert.equal(h.prepared.length,1);assert.deepEqual(h.saved.rewardRetry,retry);
  h.setTime(retry.at-1);await h.manager.process('a');assert.equal(attempts,1);h.advance(1);await h.manager.process('a');assert.equal(attempts,2);assert.equal(h.prepared.length,2);assert.equal(h.snapshots,1);
  const second=h.saved.operations.at(-1);assert.equal(second.kind,'payout');assert.equal(second.amount,'100000000');assert.equal(second.payouts.length,1);assert(!first.payouts.some(row=>row.owner===second.payouts[0].owner));assert.deepEqual(h.saved.rewardRetry,retry);
  await h.manager.process('a');assert.equal(h.prepared.length,2,'empty pending receipt cannot prepare a third payout');assert.equal(h.saved.cycle.index,3);
  await h.confirm(-100000000n);assert.equal(h.saved.cycle.index,4);assert.equal(h.saved.rewardRetry,undefined);await h.manager.process('a');assert.equal(h.saved.credits.quote,'0');assert.equal(h.saved.autoFees,true);assert.equal(publicLaunch(h.saved).holderRewards.lastDistributionQuote,'400');
});

test('deliberate pause cancels persisted automatic reward backoff across restart',async t=>{
  const h=await harness(t,launch({feeAutomation:{enabled:true},credits:{quote:'100000000',base:'0'}}));h.claims=false;let attempts=0;
  h.c.payoutInstructions=async()=>{attempts++;throw Object.assign(Error('RPC connection reset'),{code:'ECONNRESET'});};
  h.advance(HOLDER_REWARD_INTERVAL_MS);await h.manager.process('a');assert.equal(attempts,1);assert(h.saved.rewardRetry);
  await h.manager.action('a',h.saved.id,'pause');assert.equal(h.saved.feeAutomation.enabled,false);assert.equal(h.saved.autoFees,false);assert.equal(h.saved.feesRequested,false);assert.equal(h.saved.rewardRetry,undefined);
  await h.restart();h.advance(HOLDER_REWARD_INTERVAL_MS);await h.manager.process('a');assert.equal(attempts,1);assert.equal(h.prepared.length,0);assert.equal(h.saved.credits.quote,'100000000');assert.equal(h.saved.feeAutomation.enabled,false);assert.equal(h.saved.rewardRetry,undefined);
});

test('automatic reward recovery does not retry a payout identity mismatch or change earned balances',async t=>{
  const h=await harness(t,launch({feeAutomation:{enabled:true},credits:{quote:'100000000',base:'0'}}));h.claims=false;let attempts=0;
  h.c.payoutInstructions=async()=>{attempts++;throw Error('The payout destination differs from the saved distribution.');};
  h.advance(HOLDER_REWARD_INTERVAL_MS);await h.manager.process('a');assert.equal(attempts,1);assert.equal(h.saved.state,'paused');assert.equal(h.saved.rewardRetry,undefined);assert.equal(h.saved.credits.quote,'100000000');assert.equal(h.prepared.length,0);
  await h.restart();h.advance(HOLDER_REWARD_INTERVAL_MS);await h.manager.process('a');assert.equal(attempts,1);assert.equal(h.saved.rewardRetry,undefined);assert.equal(h.saved.credits.quote,'100000000');assert.equal(h.prepared.length,0);
});

test('distributed totals use each verified journal payout once and never include unclaimed credits or stored totals again',()=>{
  const l=launch(),row=(amount,signature,operationId,slot=10)=>({kind:'payout',state:'confirmed',signature,operationId,slot,createdAt:START,confirmedAt:START+1000,amount,payouts:[{owner:address(),amount}],holderRewardCycleId:'cycle'});
  const first=row('1000000','first','one'),second=row('2000000','second','two',11);
  l.operations=[first,structuredClone(first),second,{...row('7000000','third','three'),state:'pending'},{...row('8000000','fourth','four'),state:'failed'},{...row('9000000','fifth','five'),slot:undefined},{...row('10000000','sixth','six'),signature:''},{...row('11000000','seventh','seven'),kind:'claim'}];
  l.holderRewards.totalDistributedQuoteUnits='999999999';l.credits={quote:'123000000',base:'2500000'};
  const stats=holderRewardDistributionStats(l);assert.equal(stats.totalDistributedQuote,'3');assert.equal(stats.totalPayments,2);assert.equal(stats.lastDistributionQuote,'3');assert.equal(stats.lastDistributionAt,START+1000);
  const view=publicLaunch(l).holderRewards;assert.equal(view.pendingQuote,'123');assert.equal(view.unconvertedTaxTokens,'2.5');assert.equal(view.totalDistributedQuote,'3');
  delete first.holderRewardCycleId;delete second.holderRewardCycleId;l.operations=[first,second];assert.equal(holderRewardDistributionStats(l).lastDistributionQuote,'2','legacy records without cycle IDs report the last verified batch');
});

test('no eligible recipients do not produce a false completed distribution or lose credits',async t=>{
  const h=await harness(t,launch({autoFees:false,credits:{quote:'12000000',base:'0'}}));h.claims=false;h.holders.length=0;
  await h.admin();await h.manager.process('a');assert.equal(h.prepared.length,0);assert.equal(h.saved.credits.quote,'12000000');assert.equal(h.saved.cycle,null);
  const state=publicLaunch(h.saved).holderRewards;assert.equal(state.lastDistributionAt,null);assert.equal(state.lastDistributionQuote,null);assert.equal(state.pendingQuote,'12');
});

test('an already-created holder coin retries verification beyond eight attempts and fifteen minutes without creation or refunds',async t=>{
  const l=launch({curve:null,state:'launching',phase:'verify',operations:[{kind:'create',state:'confirmed',signature:'confirmed-create',slot:99,createdAt:START}],lastCycle:0}),h=await harness(t,l);let reads=0;
  h.c.verifyLaunch=async()=>{reads++;throw Object.assign(Error('RPC account snapshot is catching up'),{code:'LAUNCH_VERIFICATION_PENDING'});};
  h.c.c.getEpochInfo=async()=>{throw Error('Confirmed creation must not enter refund recovery');};
  for(let attempt=1;attempt<=10;attempt++){
    await h.manager.process('a');assert.equal(h.saved.state,'launching');assert.equal(h.saved.phase,'verify');assert.equal(h.saved.retry.attempt,attempt);assert.equal(h.saved.recovery,undefined);
    const wait=h.saved.retry.at-h.now;assert.equal(wait,attempt>8?60000:Math.min(8000,1000*2**Math.min(attempt-1,3)));
    await h.manager.process('a');assert.equal(reads,attempt,'cooldown must prevent a hot loop');h.setTime(h.saved.retry.at);
  }
  h.setTime(START+3600000);await h.restart();await h.manager.process('a');assert.equal(reads,11);assert.equal(h.saved.recovery,undefined);assert.equal(h.saved.operations.length,1);assert.equal(h.prepared.length,0);assert.equal(h.broadcasts.length,0);
  h.c.verifyLaunch=async()=>({curve:l.keys.mint.address});h.setTime(h.saved.retry.at);await h.manager.process('a');assert.equal(h.saved.state,'live');assert.equal(h.saved.curve,l.keys.mint.address);assert.equal(h.saved.retry,undefined);assert.equal(h.saved.error,'');assert.equal(h.saved.lastCycle,h.now);
});

test('a confirmed creation with a real verification mismatch is never marked live',async t=>{
  const h=await harness(t,launch({curve:null,state:'launching',phase:'verify',operations:[{kind:'create',state:'confirmed',signature:'confirmed-create',slot:99,createdAt:START}]}));
  h.c.verifyLaunch=async()=>{throw Error('The mint owner does not match this launch');};await h.manager.process('a');assert.equal(h.saved.state,'error');assert.equal(h.saved.curve,null);assert.match(h.saved.error,/mint owner/);assert.equal(h.saved.retry,undefined);assert.equal(h.prepared.length,0);
});

function taxedLaunch(extra={}) {
  const l=launch(extra);l.input.taxBps=400;return l;
}
function pacedChain(h,amount=TAX_CONVERSION_MAX_UNITS) {
  const plans=[],swaps=[];
  h.c.taxConversionPlan=async(l,credit)=>{plans.push({at:h.now,credit});return {amount:(BigInt(credit)<amount?BigInt(credit):amount).toString()};};
  h.c.swapFeeInstructions=async(l,side,amount)=>{swaps.push({at:h.now,side,amount});return ['paced-sell'];};
  return {plans,swaps};
}

test('tax conversions run in bounded five-minute chunks while payout checks retain their separate hourly clock',async t=>{
  const h=await harness(t,taxedLaunch({credits:{quote:'120000000',base:(9n*TAX_CONVERSION_MAX_UNITS).toString()}}));h.claims=false;const {plans,swaps}=pacedChain(h);
  assert.equal(feeCycleDueAt(h.saved),START+TAX_CONVERSION_INTERVAL_MS);
  assert.equal(publicLaunch(h.saved).holderRewards.nextCheckAt,START+HOLDER_REWARD_INTERVAL_MS);
  for(let cycle=1;cycle<=12;cycle++){
    h.setTime(START+cycle*TAX_CONVERSION_INTERVAL_MS);
    await h.manager.process('a');
    if(cycle<=9){
      // A creator claim with no instructions advances to tax on a later tick.
      if(!h.saved.operations.some(op=>op.state==='pending'))await h.manager.process('a');
      const sale=h.saved.operations.at(-1);assert.equal(sale.kind,'sell');assert.equal(sale.amount,TAX_CONVERSION_MAX_UNITS.toString());assert.equal(sale.taxConversionPolicy,'paced-v1');
      assert.equal(plans.length,cycle);assert.equal(swaps.length,cycle);
      await h.confirm(1000000n,-TAX_CONVERSION_MAX_UNITS);await h.manager.process('a');
    }else if(h.saved.cycle?.stage==='tax')await h.manager.process('a');
    if(cycle<12){assert.equal(h.snapshots,0,'conversion ticks must not pay early');assert.equal(h.saved.lastHolderRewardCheck,START);assert.equal(holderRewardCheckDueAt(h.saved),START+HOLDER_REWARD_INTERVAL_MS);}
  }
  const payout=h.saved.operations.at(-1);assert.equal(payout.kind,'payout');assert.equal(payout.amount,'129000000');assert.equal(h.saved.credits.base,'0');
  await h.confirm(-129000000n);await h.manager.process('a');assert.equal(h.saved.lastHolderRewardCheck,h.now);assert.equal(h.saved.credits.quote,'0');
});

test('public holder schedule reports the one-million clip and updated bounded impact policy',()=>{
  const conversion=publicLaunch(taxedLaunch()).holderRewards.taxConversion;
  assert.equal(conversion.maxTokens,'1000000');
  assert.equal(conversion.maximumSupplyPercent,0.1);
  assert.equal(conversion.maxReserveBps,25);
  assert.equal(conversion.maximumReservePercent,0.25);
  assert.equal(conversion.maxPriceImpactBps,50);
  assert.equal(conversion.maximumPriceImpactPercent,0.5);
  assert.equal(conversion.intervalMinutes,5);
});

test('manual distribution bypasses the payout minimum and clock but never conversion size or cooldown after restart',async t=>{
  const h=await harness(t,taxedLaunch({autoFees:false,credits:{quote:'200000',base:(10n*TAX_CONVERSION_MAX_UNITS).toString()}}));h.claims=false;const {plans}=pacedChain(h);
  await h.admin();await h.manager.process('a');await h.manager.process('a');
  assert.equal(h.saved.operations.at(-1).kind,'sell');assert.equal(h.saved.operations.at(-1).amount,TAX_CONVERSION_MAX_UNITS.toString());
  await h.confirm(1000000n,-TAX_CONVERSION_MAX_UNITS);await h.manager.process('a');await h.confirm(-1200000n);await h.manager.process('a');
  assert.equal(h.saved.credits.base,(9n*TAX_CONVERSION_MAX_UNITS).toString());assert.equal(plans.length,1);await h.restart();
  for(const action of ['fees','holder-distribute','holder-distribute']){await h.admin();await h.manager.process('a');await h.manager.process('a');}
  assert.equal(plans.length,1);assert.equal(h.saved.credits.base,(9n*TAX_CONVERSION_MAX_UNITS).toString());
  h.advance(TAX_CONVERSION_INTERVAL_MS-1);await h.admin();await h.manager.process('a');await h.manager.process('a');assert.equal(plans.length,1);
  h.advance(1);await h.admin();await h.manager.process('a');await h.manager.process('a');assert.equal(plans.length,2);assert.equal(h.saved.operations.at(-1).amount,TAX_CONVERSION_MAX_UNITS.toString());
});

test('a failed conversion plan persists its cooldown and cannot spend base on repeated manual resumes',async t=>{
  const h=await harness(t,taxedLaunch({autoFees:false,credits:{quote:'12000000',base:'1000000000000'}}));h.claims=false;const {plans}=pacedChain(h);let attempts=0;
  h.c.taxConversionPlan=async()=>{attempts++;throw Error('Quote impact is unsafe');};
  await h.admin();await h.manager.process('a');await h.manager.process('a');
  assert.equal(h.saved.state,'paused');assert.equal(h.saved.lastTaxConversionAt,START);assert.equal(taxConversionDueAt(h.saved),START+TAX_CONVERSION_INTERVAL_MS);assert.equal(h.prepared.length,0);
  await h.restart();await h.admin();await h.manager.process('a');assert.equal(h.saved.operations.at(-1).kind,'payout');assert.equal(h.saved.credits.base,'1000000000000');assert.equal(attempts,1);assert.equal(plans.length,0);
});

test('zero-size dust plans skip conversion while allowing earned quote payouts',async t=>{
  const h=await harness(t,taxedLaunch({autoFees:false,credits:{quote:'12000000',base:'1'}}));h.claims=false;const {plans,swaps}=pacedChain(h,0n);
  await h.admin();await h.manager.process('a');await h.manager.process('a');assert.equal(plans.length,1);assert.equal(swaps.length,0);assert.equal(h.saved.operations.at(-1).kind,'payout');assert.equal(h.saved.credits.base,'1');
});

test('oversized or unearned conversion plans are rejected before preparation',async t=>{
  for(const amount of [TAX_CONVERSION_MAX_UNITS+1n,-1n]){
    const h=await harness(t,taxedLaunch({autoFees:false,credits:{quote:'0',base:'1000000000000'}}));h.claims=false;h.c.taxConversionPlan=async()=>({amount:amount.toString()});h.c.swapFeeInstructions=async()=>{throw Error('Should not build a swap');};
    await h.admin();await h.manager.process('a');await h.manager.process('a');assert.equal(h.prepared.length,0);assert.match(h.saved.error,/paced earned-token budget/);assert.equal(h.saved.credits.base,'1000000000000');
  }
});

test('legacy pending bulk sales are reconciled read-only across retries and account confirmed proceeds exactly once',async t=>{
  const op={kind:'sell',operationId:'old-sale',signature:'old-signature',state:'pending',amount:'1000000000000',raw:'old-bulk-sale',createdAt:START,lastValidBlockHeight:100,reserve:'5000000'};
  const h=await harness(t,taxedLaunch({feesRequested:true,cycle:{stage:'route',index:0,manual:true},credits:{quote:'12000000',base:'1000000000000'},operations:[op]}));h.c.c.getBlockHeight=async()=>{throw Error('Legacy sales must not enter rebroadcast logic');};
  h.advance(16000);await h.manager.process('a');await h.restart();h.advance(180000);await h.manager.process('a');assert.equal(h.broadcasts.length,0);assert.equal(h.prepared.length,0);assert.equal(h.saved.operations[0].state,'pending');assert.equal(h.saved.autoFees,true);assert.equal(h.saved.feeAutomation.enabled,true);
  h.receipts.set(op.signature,receipt(h.saved,2000000n,-1000000000000n));h.advance(10001);await h.manager.process('a');assert.equal(h.saved.operations[0].state,'confirmed');assert.equal(h.saved.credits.base,'0');assert.equal(h.saved.credits.quote,'14000000');assert.equal(h.saved.lastTaxConversionAt,h.now);
  await h.manager.process('a');assert.equal(h.saved.credits.quote,'14000000');assert.equal(h.broadcasts.length,0);
});

test('a failed signed conversion starts cooldown from its receipt and resumes available quote payouts without repeating the sale',async t=>{
  const h=await harness(t,taxedLaunch({autoFees:false,credits:{quote:'12000000',base:'1000000000000'}}));h.claims=false;const {plans}=pacedChain(h);
  await h.admin();await h.manager.process('a');await h.manager.process('a');const sale=h.saved.operations.at(-1);
  h.advance(45000);const failed=receipt(h.saved,0n);failed.meta.err={InstructionError:[0,'SlippageExceeded']};h.receipts.set(sale.signature,failed);await h.manager.process('a');assert.equal(h.saved.lastTaxConversionAt,h.now);assert.equal(h.saved.operations.at(-1).state,'failed');assert.equal(h.saved.credits.base,'1000000000000');
  await h.restart();await h.admin();await h.manager.process('a');assert.equal(h.saved.operations.at(-1).kind,'payout');assert.equal(plans.length,1);
});

test('old unsigned bulk sale requests are hidden, rejected, and cancelled without a broadcast',async t=>{
  const op={kind:'sell',operationId:'old-sale',state:'awaiting_signature',needsSignature:true,unsignedRaw:'old',messageHash:'old',amount:'1000000000000',createdAt:START,lastValidBlockHeight:100,reserve:'5000000'};
  const h=await harness(t,taxedLaunch({state:'awaiting_signature',feesRequested:true,cycle:{stage:'route',index:0},credits:{quote:'0',base:'1000000000000'},operations:[op]}));
  assert.equal(publicLaunch(h.saved).pendingSignature,null);await assert.rejects(h.manager.sign('a',h.saved.id,op.operationId,'signed-old'),/earlier conversion request/);await assert.rejects(h.manager.signature('a',h.saved.id,op.operationId),/earlier conversion request/);
  await h.manager.process('a');assert.equal(h.saved.operations[0].state,'cancelled');assert.equal(h.saved.operations[0].unsignedRaw,undefined);assert.equal(h.broadcasts.length,0);assert.equal(h.prepared.length,0);
});

test('creator fees and full accrued tax credit are collected before converting only one capped portion',async t=>{
  const h=await harness(t,taxedLaunch());const {plans}=pacedChain(h);const kinds=[];h.c.claimInstructions=async(l,kind)=>{kinds.push(kind);return ['claim'];};
  h.advance(TAX_CONVERSION_INTERVAL_MS);await h.manager.process('a');assert.equal(h.saved.operations.at(-1).kind,'claim');await h.confirm(2000000n);await h.manager.process('a');
  const handoff=h.saved.operations.at(-1);assert.equal(handoff.kind,'reward-handoff');assert.equal(handoff.rewardHandoff.quoteUnits,'2000000');assert.equal(handoff.rewardHandoff.baseUnits,'0');assert.equal(h.saved.credits.quote,'2000000');await h.confirmHandoff();await h.manager.process('a');
  assert.equal(h.saved.operations.at(-1).kind,'tax');assert.equal(h.saved.operations.at(-1).rewardsWallet.address,h.saved.keys.rewards.address);assert.equal(h.saved.operations.at(-1).rewardsWallet.signerSource,'wallet');await h.confirm(0n,3308741776910n);await h.manager.process('a');assert.deepEqual(kinds,['holder-auto','tax']);assert.equal(plans[0].credit,'3308741776910');
  await h.confirm(1000000n,-TAX_CONVERSION_MAX_UNITS);await h.manager.process('a');assert.equal(h.saved.credits.base,(3308741776910n-TAX_CONVERSION_MAX_UNITS).toString());assert.equal(h.saved.credits.quote,'2950000');assert.equal(h.saved.operations.at(-1).kind,'tax-protocol-payout');assert.equal(h.saved.operations.at(-1).amount,'50000');
  await h.confirm(-50000n);await h.manager.process('a');assert.equal(h.saved.taxProtocol.paidQuote,'50000');assert.equal(h.saved.cycle,null);assert.equal(h.snapshots,0);assert.equal(h.saved.lastHolderRewardCheck,START);
});

test('a fresh quote that defers conversion keeps hourly rewards available and retains cooldown',async t=>{
  const h=await harness(t,taxedLaunch({autoFees:false,credits:{quote:'12000000',base:'1000000000000'}}));h.claims=false;const {plans}=pacedChain(h);
  h.c.swapFeeInstructions=async()=>{throw Object.assign(Error('Liquidity changed; waiting for the next conversion check.'),{code:'TAX_CONVERSION_DEFERRED'});};
  await h.admin();await h.manager.process('a');await h.manager.process('a');assert.equal(h.saved.state,'live');assert.equal(h.saved.operations.at(-1).kind,'payout');assert.equal(h.saved.credits.base,'1000000000000');assert.equal(h.prepared.length,1);
  const view=publicLaunch(h.saved).holderRewards;assert.match(view.taxConversion.note,/Liquidity changed/);assert.equal(view.taxConversion.lastAt,START);assert.equal(plans.length,1);
});

// Payout gas (v71.37): a payout on a pair asset other than SOL needs SOL the dedicated rewards wallet never receives on its own.
function starvedPrepare(h,{shortfall='592080'}={}){
  const prepare=h.c.prepare;let starved=true;const payoutAttempts=[];
  h.c.prepare=async(l,instructions,extra,initial,options)=>{
    if(options?.operation?.kind==='payout'){payoutAttempts.push(options.operation.amount);if(starved)throw Object.assign(Error(`Insufficient SOL in wallet ${l.keys.rewards.address}. Add at least 0.00059208 SOL for recipient token-account rent. Nothing was submitted.`),{code:'REWARD_NATIVE_FUNDS',retryable:true,fundingWallet:l.keys.rewards.address,fundingShortfallLamports:shortfall});}
    return prepare(l,instructions,extra,initial,options);
  };
  return {payoutAttempts,fund(){starved=false;}};
}
function gasSaleChain(h,{perLamport=1n,divisor=5n}={}){
  const sizes=[],builds=[];
  h.c.payoutGasSaleAmount=async(l,lamports)=>{sizes.push(lamports);return BigInt(lamports)*perLamport/divisor;};
  h.c.payoutGasSaleInstructions=async(l,amount,{operation}={})=>{builds.push({amount,operation:structuredClone(operation)});const result=['gas-sell'];result.payoutGas={expectedLamports:'2700000',minimumLamports:'2650000',dexes:['Raydium']};return result;};
  return {sizes,builds};
}

test('payout gas (v71.37): a holder payout on a non-SOL pair that lacks SOL sells a little of the rewards for it, then pays from the smaller credit',async t=>{
  const h=await harness(t,launch({credits:{quote:'100000000',base:'0'}}));h.claims=false;const starve=starvedPrepare(h),chain=gasSaleChain(h);
  h.advance(HOLDER_REWARD_INTERVAL_MS);await h.manager.process('a');
  // The payout was simulated once, refused for SOL, and a sale sized from the shortfall plus headroom (0.00059208 + 0.002 SOL) with a 25% margin was signed instead.
  assert.deepEqual(starve.payoutAttempts,['100000000']);assert.deepEqual(chain.sizes,['2592080']);
  const sale=h.saved.operations.at(-1);assert.equal(sale.kind,'gas-sell');assert.equal(sale.state,'pending');assert.equal(sale.amount,'648020');
  assert.deepEqual(sale.rewardsWallet,{version:1,source:'rewards',address:h.saved.keys.rewards.address,signerSource:'rewards'});
  assert.deepEqual(sale.payoutGas,{shortfallLamports:'592080',targetLamports:'2592080',sizing:'shortfall',expectedLamports:'2700000',minimumLamports:'2650000'});
  assert.equal(chain.builds[0].amount,'648020');assert.equal(chain.builds[0].operation.kind,'gas-sell');assert.deepEqual(chain.builds[0].operation.payoutGas,{shortfallLamports:'592080',targetLamports:'2592080',sizing:'shortfall'});
  assert.equal(h.saved.credits.quote,'100000000');assert.equal(h.saved.cycle.stage,'payout');assert.deepEqual(h.saved.cycle.payouts.map(x=>x.amount).sort(),['25000000','75000000']);
  // Nothing else is signed while the sale is pending.
  await h.manager.process('a');assert.equal(h.saved.operations.length,1);
  // Its receipt shrinks the credit and the unpaid rows together; the SOL it bought is the wallet's gas now, so the payout goes through.
  await h.confirm(-648020n);const confirmed=h.saved.operations[0];assert.equal(confirmed.state,'confirmed');assert.equal(confirmed.receipt.quoteDelta,'-648020');
  assert.equal(h.saved.credits.quote,'99351980');assert.equal(h.saved.cycle.gasSales,1);assert.equal(h.saved.cycle.lastGasSaleAt,h.now);assert.equal(h.saved.cycle.payoutGasShrunk,1);assert.equal(h.saved.cycle.stage,'payout');
  assert.deepEqual(h.saved.cycle.payouts.map(x=>x.amount).sort(),['24837995','74513985']);
  starve.fund();await h.manager.process('a');const payout=h.saved.operations.at(-1);assert.equal(payout.kind,'payout');assert.equal(payout.amount,'99351980');assert.deepEqual(payout.payouts.map(x=>x.amount).sort(),['24837995','74513985']);
  await h.confirm(-99351980n);await h.manager.process('a');assert.equal(h.saved.credits.quote,'0');assert.equal(h.saved.cycle,null);assert.equal(publicLaunch(h.saved).holderRewards.lastDistributionQuote,'99.35198');
  assert.deepEqual(h.saved.operations.map(op=>[op.kind,op.state]),[['gas-sell','confirmed'],['payout','confirmed']]);
});

test('payout gas (v71.37): the sale is refused when the receipt spends more than its budget or touches the coin',async t=>{
  for(const [quote,base] of [[-648021n,0n],[-648020n,5n],[1n,0n]]){
    const h=await harness(t,launch({credits:{quote:'100000000',base:'0'}}));h.claims=false;starvedPrepare(h);gasSaleChain(h);
    h.advance(HOLDER_REWARD_INTERVAL_MS);await h.manager.process('a');assert.equal(h.saved.operations.at(-1).kind,'gas-sell');
    await h.confirm(quote,base);assert.equal(h.saved.operations[0].state,'pending');assert.equal(h.saved.credits.quote,'100000000');assert.match(h.saved.error,/Payout gas sale receipt differs from its budget/);
  }
});

test('payout gas (v71.37): rewards too small to pay for their own delivery stay reserved for a bigger payout',async t=>{
  // The sale would need more than a fifth of the rewards (10 SOL-lamports of USDC per lamport): no sale, no payout, the credit untouched.
  const h=await harness(t,launch({credits:{quote:'100000000',base:'0'}}));h.claims=false;const starve=starvedPrepare(h),chain=gasSaleChain(h,{perLamport:10n,divisor:1n});
  h.advance(HOLDER_REWARD_INTERVAL_MS);await h.manager.process('a');
  assert.deepEqual(starve.payoutAttempts,['100000000']);assert.deepEqual(chain.sizes,['2592080']);assert.equal(chain.builds.length,0);assert.equal(h.saved.operations.length,0);assert.equal(h.saved.credits.quote,'100000000');
  assert.match(h.saved.payoutGasNote,/too small to pay for the holders’ new token accounts and network fees \(0\.00259208 SOL needed, about 32\.401 of 100 USDC\)/);
  await h.manager.process('a');assert.equal(h.saved.cycle,null);assert.equal(h.saved.state,'live');assert.equal(h.saved.error,'');
  // The next payout that fits sells and clears the note.
  h.c.payoutGasSaleAmount=async(l,lamports)=>BigInt(lamports)/5n;h.advance(HOLDER_REWARD_INTERVAL_MS);await h.manager.process('a');assert.equal(h.saved.operations.at(-1).kind,'gas-sell');assert.equal(h.saved.payoutGasNote,undefined);
});

test('payout gas (v71.37): at most three sales per cycle and six in a day; beyond them the ordinary SOL wait applies',async t=>{
  const h=await harness(t,launch({credits:{quote:'100000000',base:'0'}}));h.claims=false;starvedPrepare(h);const chain=gasSaleChain(h);
  h.advance(HOLDER_REWARD_INTERVAL_MS);
  for(let sale=1;sale<=3;sale++){await h.manager.process('a');const op=h.saved.operations.at(-1);assert.equal(op.kind,'gas-sell');await h.confirm(-BigInt(op.amount));assert.equal(h.saved.cycle.gasSales,sale);}
  await h.manager.process('a');assert.equal(h.saved.operations.length,3);assert.equal(chain.builds.length,3);assert.equal(h.saved.rewardRetry.kind,'funding');assert.match(h.saved.rewardRetry.reason,/Insufficient SOL in wallet/);assert.match(h.saved.rewardRetry.reason,/already sold rewards for network costs 3 times in this cycle and 3 in the last 24 hours/);
  assert.equal(h.saved.error,'Automatic rewards are waiting for SOL and will retry automatically.');assert.equal(h.saved.cycle.stage,'payout');
  // A new cycle starts the per-cycle count again but the day's count carries; six in a day is the ceiling.
  await h.manager.locked('a',async b=>{b.launches[0].cycle.gasSales=0;delete b.launches[0].rewardRetry;await h.manager.save('a',b);});
  for(let sale=4;sale<=6;sale++){h.advance(5*60000+1);await h.manager.process('a');const op=h.saved.operations.at(-1);assert.equal(op.kind,'gas-sell');await h.confirm(-BigInt(op.amount));}
  await h.manager.locked('a',async b=>{b.launches[0].cycle.gasSales=0;delete b.launches[0].rewardRetry;await h.manager.save('a',b);});
  h.advance(5*60000+1);await h.manager.process('a');assert.equal(h.saved.operations.length,6);assert.match(h.saved.rewardRetry.reason,/0 times in this cycle and 6 in the last 24 hours/);
});

test('payout gas (v71.37): a SOL pair, an inactive rewards wallet or another wallet short of SOL never sells',async t=>{
  // Another wallet short of SOL (the creator wallet signing an older payout, say) is not the rewards wallet's problem.
  const h=await harness(t,launch({credits:{quote:'100000000',base:'0'}}));h.claims=false;const chain=gasSaleChain(h);
  const prepare=h.c.prepare;h.c.prepare=async(l,instructions,extra,initial,options)=>{if(options?.operation?.kind==='payout')throw Object.assign(Error(`Insufficient SOL in wallet ${l.keys.wallet.address}. Add SOL for transaction fees and account rent, then retry. Nothing was submitted.`),{code:'REWARD_NATIVE_FUNDS',retryable:true,fundingWallet:l.keys.wallet.address});return prepare(l,instructions,extra,initial,options);};
  h.advance(HOLDER_REWARD_INTERVAL_MS);await h.manager.process('a');assert.equal(chain.sizes.length,0);assert.equal(h.saved.operations.length,0);assert.equal(h.saved.rewardRetry.kind,'funding');
  // A payout gas sale cannot be signed outside its conditions.
  const l=h.saved;const manager=h.manager;
  await assert.rejects(manager.locked('a',async b=>{const live=b.launches[0];live.input.quoteMint='So11111111111111111111111111111111111111112';await manager.send('a',b,live,h.c,'gas-sell',['gas-sell'],{amount:'1000',operationData:{payoutGas:{shortfallLamports:'592080'}}});}),/exceeds its budget/);
  await assert.rejects(manager.locked('a',async b=>{const live=b.launches[0];await manager.send('a',b,live,h.c,'gas-sell',['gas-sell'],{amount:'20000001',operationData:{payoutGas:{shortfallLamports:'592080'}}});}),/exceeds its budget/);
  await assert.rejects(manager.locked('a',async b=>{const live=b.launches[0];await manager.send('a',b,live,h.c,'gas-sell',['gas-sell'],{amount:'1000',operationData:{payoutGas:{shortfallLamports:'0'}}});}),/exceeds its budget/);
  assert.equal(h.saved.operations.length,0);assert.equal(l.credits.quote,'100000000');
});

test('payout gas (v71.37): a sale in the middle of a cycle shrinks only the rows still unpaid',async t=>{
  const paid=address(),rows=[{owner:paid,amount:'50000000'},{owner:address(),amount:'30000000'},{owner:address(),amount:'20000000'}];
  const h=await harness(t,launch({credits:{quote:'50000000',base:'0'},cycle:{stage:'payout',index:1,payouts:rows,createdAt:START,slot:100}}));h.claims=false;const starve=starvedPrepare(h);gasSaleChain(h);
  h.advance(HOLDER_REWARD_INTERVAL_MS);await h.manager.process('a');assert.deepEqual(starve.payoutAttempts,['50000000']);assert.equal(h.saved.operations.at(-1).kind,'gas-sell');assert.equal(h.saved.operations.at(-1).amount,'648020');
  await h.confirm(-648020n);assert.equal(h.saved.credits.quote,'49351980');assert.deepEqual(h.saved.cycle.payouts.map(x=>x.amount),['50000000','29611188','19740792']);assert.equal(h.saved.cycle.index,1);
  starve.fund();await h.manager.process('a');const payout=h.saved.operations.at(-1);assert.equal(payout.kind,'payout');assert.equal(payout.amount,'49351980');assert.deepEqual(payout.payouts.map(x=>x.owner),rows.slice(1).map(x=>x.owner));
  await h.confirm(-49351980n);await h.manager.process('a');assert.equal(h.saved.credits.quote,'0');assert.equal(h.saved.cycle,null);
});

test('payout gas (v71.37): when the chain can count the recipients without a token account, one sale covers the whole cycle; too big a cycle falls back to the reported shortfall',async t=>{
  const h=await harness(t,launch({credits:{quote:'100000000',base:'0'}}));h.claims=false;starvedPrepare(h);const chain=gasSaleChain(h);const reads=[];
  h.c.payoutRecipientRentLamports=async(l,rows)=>{reads.push(rows.map(row=>row.owner));return {recipients:rows.length,missing:2,rentLamports:'4078560',lamports:'4128560'};};
  h.advance(HOLDER_REWARD_INTERVAL_MS);await h.manager.process('a');
  // Two recipients lack an account: 2 × rent + the batch fee allowance + 0.002 SOL headroom, in one quote.
  assert.equal(reads.length,1);assert.equal(reads[0].length,2);assert.deepEqual(chain.sizes,['6128560']);
  const sale=h.saved.operations.at(-1);assert.equal(sale.kind,'gas-sell');assert.equal(sale.amount,'1532140');assert.deepEqual(sale.payoutGas,{shortfallLamports:'592080',targetLamports:'6128560',sizing:'cycle',recipients:2,missingAccounts:2,expectedLamports:'2700000',minimumLamports:'2650000'});
  // A cycle whose rent would take more than a fifth of the rewards: the shortfall alone is sold so the current batch can go out.
  const big=await harness(t,launch({credits:{quote:'100000000',base:'0'}}));big.claims=false;starvedPrepare(big);const bigChain=gasSaleChain(big);
  big.c.payoutRecipientRentLamports=async(l,rows)=>({recipients:rows.length,missing:200,rentLamports:'407856000',lamports:'411256000'});
  big.advance(HOLDER_REWARD_INTERVAL_MS);await big.manager.process('a');
  assert.deepEqual(bigChain.sizes,['413256000','2592080']);const fallback=big.saved.operations.at(-1);assert.equal(fallback.kind,'gas-sell');assert.equal(fallback.amount,'648020');assert.equal(fallback.payoutGas.sizing,'shortfall');assert.equal(fallback.payoutGas.targetLamports,'2592080');
  // A failing account read never blocks the sale: the shortfall sizing applies.
  const blind=await harness(t,launch({credits:{quote:'100000000',base:'0'}}));blind.claims=false;starvedPrepare(blind);const blindChain=gasSaleChain(blind);
  blind.c.payoutRecipientRentLamports=async()=>{throw Error('RPC unavailable');};
  blind.advance(HOLDER_REWARD_INTERVAL_MS);await blind.manager.process('a');assert.deepEqual(blindChain.sizes,['2592080']);assert.equal(blind.saved.operations.at(-1).amount,'648020');assert.equal(blind.saved.operations.at(-1).payoutGas.recipients,undefined);
});
