import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {activeRewardsFixture,rewardFixtureReceipt,rewardFixtureHandoffReceipt} from './helpers/rewards-wallet-fixture.mjs';
import {Launchpad,requestFees} from '../src/launchpad.mjs';
import {newLaunchKeys} from '../src/launchpad-receipts.mjs';
import {launchInput,USDC_MINT} from '../public/launchpad-model.mjs';
import {TAX_PROTOCOL_POLICY,taxProtocolLedger,recordTaxHarvest,taxConversionSource,recordTaxConversion,recordTaxProtocolPayout} from '../src/launchpad-tax-protocol.mjs';

const START=1700000000000,address=()=>newLaunchKeys().wallet.address;
const launch=()=>activeRewardsFixture({id:'c'.repeat(32),keys:{...newLaunchKeys(),payer:newLaunchKeys().wallet},input:launchInput({name:'Tax rewards',symbol:'TAX',feeMode:'holders',quoteMint:USDC_MINT,taxPercent:'4'}),review:{minimumSol:'0.06',quoteDecimals:6,price:{usd:'1'},devBuy:{gross:'0'}},feeCustody:'relay',authorizedAt:START,createdAt:START,lastCycle:START,state:'live',curve:address(),credits:{quote:'0',base:'0'},operations:[],gas:{day:new Date(START).toISOString().slice(0,10),reserved:'0'},autoFees:false,feesRequested:true,cycle:{stage:'claim',index:0}},START);
const sale=(amount='100')=>({amount,taxProtocolPolicy:TAX_PROTOCOL_POLICY,taxSource:'withheld-tax'});
function harvested(l,base){l.taxProtocol=recordTaxHarvest(l,base);l.credits.base=(BigInt(l.credits.base)+BigInt(base)).toString();}
function converted(l,base,quote){const split=recordTaxConversion(l,sale(String(base)),base,quote);l.taxProtocol=split.ledger;l.credits.base=(BigInt(l.credits.base)-BigInt(base)).toString();l.credits.quote=(BigInt(l.credits.quote)+split.holderQuote).toString();return split;}
function receipt(l,delta={}){return rewardFixtureReceipt(l,delta);}
async function harness(t,initial=launch()){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-tax-share-'));let book={launches:[structuredClone(initial)]},clock=START,count=0,manager,tx=null;const plans=[],broadcasts=[],policy={recipient:address(),recipientScope:'launchpad'},toolkit={recipient:address()};
  const accounts={dir,hostStore:{read:async(name,fallback)=>name==='launch-protocol-fees'?structuredClone(policy):name==='fee-policy'?toolkit:fallback},storeFor:()=>({dir,read:async()=>structuredClone(book),write:async(_,v)=>{book=structuredClone(v);}})};
  const c={close(){},rewardsGasFundingPlan:async()=>({gasLamports:'0',ready:true}),rewardHandoffInstructions:async()=>['handoff'],c:{getBlockHeight:async()=>9},claimInstructions:async()=>['claim'],holderRewardReference:async()=>({mint:USDC_MINT,usd:'1',at:clock}),taxConversionPlan:async(_,credit)=>{plans.push(credit);return {amount:credit};},swapFeeInstructions:async()=>['sale'],payoutInstructions:async(_,payouts)=>payouts,prepare:async()=>({signature:'sig'+ ++count,state:'pending',raw:'signed'+count,createdAt:clock,lastValidBlockHeight:100}),broadcast:async op=>{assert(book.launches[0].operations.some(saved=>saved.signature===op.signature&&saved.raw===op.raw));broadcasts.push(op.signature);},receipt:async()=>tx};
  const restart=async()=>{await manager?.close();manager=new Launchpad(accounts,null,{chainFactory:()=>c,now:()=>clock});manager.kick=()=>{};};await restart();t.after(async()=>{await manager.close();await rm(dir,{recursive:true,force:true});});
  return {c,plans,policy,toolkit,broadcasts,restart,get manager(){return manager;},get l(){return book.launches[0];},get count(){return count;},advance:n=>{clock+=n;},async process(){await manager.process('a');},async confirmHandoff(){const l=book.launches[0],op=l.operations.find(x=>x.state==='pending');assert.equal(op?.kind,'reward-handoff');tx=rewardFixtureHandoffReceipt(l,op);await manager.process('a');tx=null;},async confirm(delta){tx=receipt(book.launches[0],delta);await manager.process('a');tx=null;},async edit(fn){await manager.locked('a',async b=>{fn(b.launches[0]);await manager.save('a',b);});}};
}

test('5% means a share of realized tax proceeds, preserving95% and all unconverted source credit',()=>{
  const l=launch();l.credits={base:'987',quote:'1234'};harvested(l,200n);const r=converted(l,100n,1000n);
  assert.equal(r.protocolQuote,50n);assert.equal(l.credits.quote,'2184');assert.equal(l.credits.base,'1087');assert.equal(l.taxProtocol.sourceBaseCredit,'100');assert.equal(l.taxProtocol.creditQuote,'50');assert.equal(l.taxProtocol.harvestedBase,'200');assert.deepEqual(taxConversionSource(l),{credit:'100',operationData:{taxProtocolPolicy:TAX_PROTOCOL_POLICY,taxSource:'withheld-tax'}});assert.equal(l.input.taxBps,400);assert.equal(taxProtocolLedger(l).paidQuote,'0');
});

test('integer remainder carries across tiny batches so splitting cannot evade protocol fees',()=>{
  const l=launch();harvested(l,100n);for(let i=0;i<100;i++)converted(l,1n,1n);
  assert.equal(l.taxProtocol.convertedQuote,'100');assert.equal(l.taxProtocol.accruedQuote,'5');assert.equal(l.taxProtocol.holderQuote,'95');assert.equal(l.taxProtocol.roundingRemainder,'0');assert.equal(l.credits.quote,'95');assert.equal(taxProtocolLedger(l).sourceBaseCredit,'0');
});

test('unknown legacy balances, LP/creator fees and wallet deposits never create tax fee credit',()=>{
  const l=launch();l.credits={base:'200',quote:'9999'};assert.deepEqual(taxConversionSource(l),{credit:'200',operationData:{}});assert.equal(taxProtocolLedger(l).creditQuote,'0');assert.throws(()=>recordTaxConversion(l,sale(),100n,100n),/source credit/);
  for(const feeMode of ['creator','buyback']){const other=launch();other.input.feeMode=feeMode;assert.throws(()=>recordTaxHarvest(other,10n),/Only collected transfer taxes/);}
});

test('ledger rejects overdraws, malformed attribution, negative values and destination mismatches',()=>{
  const l=launch();harvested(l,100n);assert.throws(()=>recordTaxConversion(l,sale(),101n,100n),/source credit/);assert.throws(()=>recordTaxConversion(l,{amount:'100'},100n,100n),/authorized/);assert.throws(()=>recordTaxConversion(l,sale(),1n,0n),/source credit/);converted(l,100n,100n);
  const recipient=address(),op={amount:'5',taxProtocolPolicy:TAX_PROTOCOL_POLICY,taxProtocolRecipient:recipient,payouts:[{owner:recipient,amount:'5'}]};
  assert.throws(()=>recordTaxProtocolPayout(l,{...op,amount:'6'},{quote:-6n,base:0n}),/destination/);assert.throws(()=>recordTaxProtocolPayout(l,op,{quote:-5n,base:-1n}),/reserved credit/);assert.throws(()=>recordTaxProtocolPayout(l,{...op,taxProtocolRecipient:address()},{quote:-5n,base:0n}),/destination/);
  l.taxProtocol.sourceBaseCredit='-1';assert.throws(()=>taxProtocolLedger(l),/Invalid/);
});

test('confirmed tax-only conversion excludes creator/LP source and segregates payout across restart',async t=>{
  const h=await harness(t);await h.process();assert.equal(h.l.operations.at(-1).kind,'claim');await h.confirm({quote:2000n,base:30n});await h.process();
  const handoff=h.l.operations.at(-1);assert.equal(handoff.kind,'reward-handoff');assert.equal(handoff.rewardHandoff.quoteUnits,'2000');assert.equal(handoff.rewardHandoff.baseUnits,'30');assert.equal(handoff.rewardHandoff.taxBaseUnits,'0');assert.deepEqual(h.l.credits,{quote:'2000',base:'30'});await h.confirmHandoff();assert.deepEqual(h.l.credits,{quote:'2000',base:'30'});await h.process();assert.equal(h.l.operations.at(-1).kind,'tax');assert.equal(h.l.operations.at(-1).rewardsWallet.address,h.l.keys.rewards.address);assert.equal(h.l.operations.at(-1).rewardsWallet.signerSource,'wallet');assert.equal(h.l.operations.at(-1).taxProtocolPolicy,TAX_PROTOCOL_POLICY);
  await h.confirm({base:200n});await h.process();assert.deepEqual(h.plans,['200']);assert.equal(h.l.operations.at(-1).taxSource,'withheld-tax');await h.confirm({base:-100n,quote:1000n});
  assert.deepEqual(h.l.credits,{base:'130',quote:'2950'});assert.equal(h.l.taxProtocol.creditQuote,'50');assert.equal(h.l.taxProtocol.sourceBaseCredit,'100');assert.equal(h.l.taxProtocol.paidQuote,'0');assert.deepEqual(h.l.operations.at(-1).taxProtocolReceipt,{policy:TAX_PROTOCOL_POLICY,baseUnits:'100',quoteUnits:'1000',protocolQuoteUnits:'50',holderQuoteUnits:'950'});
  await h.restart();await h.process();const payout=structuredClone(h.l.operations.at(-1));assert.equal(payout.kind,'tax-protocol-payout');assert.deepEqual(payout.rewardsWallet,{version:1,source:'rewards',address:h.l.keys.rewards.address,signerSource:'rewards'});assert.equal(payout.amount,'50');assert.deepEqual(payout.payouts,[{owner:h.policy.recipient,amount:'50'}]);
  h.policy.recipient=address();await h.restart();await h.process();assert.deepEqual(h.l.operations.at(-1),payout);assert.equal(h.count,5);await h.confirm({quote:-50n});assert.equal(h.l.taxProtocol.paidQuote,'50');assert.equal(h.l.taxProtocol.creditQuote,'0');assert.equal(h.l.credits.quote,'2950');
  const before=structuredClone(h.l);await h.manager.locked('a',async b=>{const l=b.launches[0];await h.manager.reconcile('a',b,l,h.c,l.operations.at(-1));});assert.deepEqual(h.l,before,'duplicate reconciliation must not debit credit twice');await h.process();assert.equal(h.count,5);
});

test('legacy pending harvests remain untaxed, while future prepared harvests snapshot the new policy',async t=>{
  const l=launch();l.cycle.stage='tax';l.operations=[{kind:'tax',amount:'0',state:'pending',signature:'legacy',createdAt:START,raw:'old',reserve:'0'}];const h=await harness(t,l);await h.confirm({base:100n});assert.equal(h.l.taxProtocol,undefined);assert.equal(h.l.operations[0].rewardsWallet,undefined);assert.equal(h.l.rewardsWallet.creatorCredits.base,'100');await h.process();assert.equal(h.l.operations.at(-1).kind,'reward-handoff');assert.equal(h.l.operations.at(-1).rewardHandoff.baseUnits,'100');assert.equal(h.l.operations.at(-1).rewardHandoff.taxBaseUnits,'0');await h.confirmHandoff();assert.equal(h.l.taxProtocol,undefined);await h.process();assert.equal(h.l.operations.at(-1).kind,'sell');assert.equal(h.l.operations.at(-1).taxSource,undefined);assert.equal(h.l.operations.at(-1).rewardsWallet.address,h.l.keys.rewards.address);await h.confirm({base:-100n,quote:1000n});assert.equal(h.l.credits.quote,'1000');assert.equal(h.l.taxProtocol,undefined);
});

test('harvesting and source conversion fail closed for missing, shared-toolkit or legacy treasury settings',async t=>{
  for(const mode of ['missing','toolkit','legacy'])for(const stage of ['tax','route']){
    const l=launch();l.cycle.stage=stage;if(stage==='route')harvested(l,100n);const h=await harness(t,l);
    if(mode==='missing')delete h.policy.recipient;if(mode==='toolkit')h.policy.recipient=h.toolkit.recipient;if(mode==='legacy')h.policy.recipientScope='legacy';
    await h.process();assert.equal(h.count,0);assert.equal(h.l.state,'paused');assert.match(h.l.error,/launchpad fee wallet/);assert.equal(h.l.credits.base,stage==='route'?'100':'0');assert.equal(h.l.taxProtocol?.creditQuote||'0','0');
  }
});

test('failed tax receipts and unexpected quote changes do not create tax credits',async t=>{
  for(const delta of [{base:100n,err:{InstructionError:[0,'rejected']}},{base:100n,quote:1n}]){
    const l=launch();l.cycle.stage='tax';const h=await harness(t,l);await h.process();await h.confirm(delta);assert.equal(h.l.taxProtocol,undefined);assert.deepEqual(h.l.credits,{base:'0',quote:'0'});assert.notEqual(h.l.operations.at(-1).state,'confirmed');
  }
});

test('insufficient gas and failed treasury payout preserve accrued fee and all holder credit for retry',async t=>{
  const l=launch();harvested(l,100n);converted(l,100n,1000n);l.cycle.stage='tax-protocol';l.input.dailyGasLamports='1';const h=await harness(t,l);await h.process();assert.equal(h.count,0);assert.equal(h.l.taxProtocol.creditQuote,'50');assert.equal(h.l.credits.quote,'950');
  await h.edit(l=>{l.input.dailyGasLamports='100000000';requestFees(l);});await h.process();assert.equal(h.count,1);await h.confirm({err:{InstructionError:[0,'insufficient funds']}});assert.equal(h.l.taxProtocol.creditQuote,'50');assert.equal(h.l.taxProtocol.paidQuote,'0');assert.equal(h.l.credits.quote,'950');
  await h.edit(l=>requestFees(l));await h.restart();await h.process();assert.equal(h.count,2);await h.confirm({quote:-50n});assert.equal(h.l.taxProtocol.creditQuote,'0');assert.equal(h.l.taxProtocol.paidQuote,'50');assert.equal(h.l.credits.quote,'950');
});

test('unresolved payout keeps exact bytes and reserved tax credit instead of issuing a replacement',async t=>{
  const l=launch();harvested(l,100n);converted(l,100n,1000n);l.cycle.stage='tax-protocol';const h=await harness(t,l);await h.process();const op=structuredClone(h.l.operations.at(-1));h.advance(181000);await h.process();await h.restart();await h.process();assert.equal(h.count,1);const {receiptCheckAfter,...pending}=h.l.operations.at(-1);assert.equal(receiptCheckAfter,START+191000);assert.deepEqual(pending,op);assert.equal(h.l.taxProtocol.creditQuote,'50');assert.equal(h.l.taxProtocol.paidQuote,'0');
});

test('duplicate prepared signatures cannot create a second broadcast or reserve gas twice',async t=>{
  const l=launch();harvested(l,100n);converted(l,100n,1000n);l.cycle.stage='tax-protocol';l.operations=[{kind:'claim',state:'confirmed',signature:'sig1',slot:1,confirmedAt:START}];const h=await harness(t,l);await h.process();assert.equal(h.l.operations.length,1);assert.equal(h.broadcasts.length,0);assert.equal(h.l.gas.reserved,'0');assert.equal(h.l.taxProtocol.creditQuote,'50');assert.equal(h.l.taxProtocol.paidQuote,'0');assert.match(h.l.error,/signature is already saved/);
});

test('one finalized signature cannot credit two different harvest operations',async t=>{
  const l=launch();l.cycle.stage='tax';harvested(l,100n);const op={kind:'tax',taxProtocolPolicy:TAX_PROTOCOL_POLICY,amount:'0',signature:'same-finalized',createdAt:START,operationId:'original'};l.operations=[{...op,state:'confirmed',slot:42},{...op,operationId:'duplicate',state:'pending',raw:'same-signed'}];const h=await harness(t,l);await h.confirm({base:100n});assert.equal(h.l.taxProtocol.harvestedBase,'100');assert.equal(h.l.taxProtocol.sourceBaseCredit,'100');assert.equal(h.l.credits.base,'100');assert.equal(h.l.operations.at(-1).state,'pending');assert.match(h.l.error,/already applied/);assert.equal(h.count,0);
});

test('zero creator-fee holders automatically harvest tax, convert it, pay the protocol share and distribute to holders',async t=>{
  const l=launch();l.input.taxBps=200;l.input.creatorFeeBps=0;l.input.creatorFeePolicy='taxed-holders-0-v3';l.review.creatorFeeRatePpm=0;l.review.creatorFeePolicy='taxed-holders-0-v3';l.autoFees=true;l.feesRequested=false;
  const h=await harness(t,l),sources=[],holders=[{owner:address(),amount:'3'},{owner:address(),amount:'1'}];
  h.c.claimInstructions=async(_launch,source)=>{sources.push(source);return source==='tax'?['harvest-tax']:[];};
  h.c.holderSnapshot=async()=>({slot:42,rows:holders});h.advance(3600000);
  await h.process();assert.deepEqual(sources,['holder-auto']);assert.equal(h.l.cycle.stage,'tax');assert.equal(h.l.operations.length,0);assert.equal(h.l.autoFees,true);assert.equal(h.l.state,'live');
  await h.process();assert.equal(h.l.operations.at(-1).kind,'tax');assert.equal(h.l.operations.at(-1).taxProtocolPolicy,TAX_PROTOCOL_POLICY);await h.confirm({base:200n});
  await h.process();assert.equal(h.l.operations.at(-1).kind,'sell');assert.equal(h.l.operations.at(-1).taxSource,'withheld-tax');assert.deepEqual(h.plans,['200']);await h.confirm({base:-200n,quote:200000000n});
  assert.equal(h.l.taxProtocol.creditQuote,'10000000');assert.equal(h.l.credits.quote,'190000000');assert.equal(h.l.autoFees,true);
  await h.process();assert.equal(h.l.operations.at(-1).kind,'tax-protocol-payout');assert.deepEqual(h.l.operations.at(-1).payouts,[{owner:h.policy.recipient,amount:'10000000'}]);await h.confirm({quote:-10000000n});
  await h.process();const payout=h.l.operations.at(-1);assert.equal(payout.kind,'payout');assert.equal(payout.amount,'190000000');assert.deepEqual(new Map(payout.payouts.map(row=>[row.owner,row.amount])),new Map([[holders[0].owner,'142500000'],[holders[1].owner,'47500000']]));await h.confirm({quote:-190000000n});await h.process();
  assert.deepEqual(h.l.operations.map(op=>op.kind),['tax','sell','tax-protocol-payout','payout']);assert(h.l.operations.every(op=>op.state==='confirmed'));assert.deepEqual(h.l.credits,{quote:'0',base:'0'});assert.equal(h.l.taxProtocol.paidQuote,'10000000');assert.equal(h.l.taxProtocol.holderQuote,'190000000');assert.equal(h.l.holderRewards.lastDistributionQuoteUnits,'190000000');assert.equal(h.l.cycle,null);assert.equal(h.l.autoFees,true);assert.equal(h.l.state,'live');assert.equal(h.l.error,'');assert.equal(h.l.input.taxBps,200);assert.equal(h.l.review.creatorFeeRatePpm,0);
});
