import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID} from '@solana/spl-token';
import {PublicKey} from '@solana/web3.js';
import {LaunchChain} from '../src/launchpad-chain.mjs';
import {Launchpad} from '../src/launchpad.mjs';
import {newLaunchKeys} from '../src/launchpad-receipts.mjs';
import {launchInput,USDC_MINT} from '../public/launchpad-model.mjs';
import {setFeeAutomation,rewardResumeBlocker,ensureFeeAutomation} from '../src/launchpad-reward-recovery.mjs';
import {taxProtocolLedger,recordTaxHarvest,recordTaxConversion,TAX_PROTOCOL_POLICY} from '../src/launchpad-tax-protocol.mjs';
import {dedicatedRewardsWallet,provisionRewardsWallet,rewardsWalletSelection,rewardHandoffPlan,recordRewardHandoff,requireManagedRewardSource} from '../src/launchpad-rewards-wallet.mjs';
import {rewardFixtureReceipt,rewardHandoffTx} from './helpers/rewards-wallet-fixture.mjs';

const NOW=Date.parse('2026-09-28T01:00:00Z'),address=()=>newLaunchKeys().wallet.address;
function launch(){return {id:'b'.repeat(32),keys:{...newLaunchKeys(),payer:newLaunchKeys().wallet},input:launchInput({name:'Rewards',symbol:'RWDS',feeMode:'holders',quoteMint:USDC_MINT,taxPercent:'2'}),review:{minimumSol:'0.06',quoteProgram:TOKEN_PROGRAM_ID.toBase58(),quoteDecimals:6,price:{usd:'1'},devBuy:{gross:'0'}},feeCustody:'relay',curve:address(),createdAt:NOW-3600000,authorizedAt:NOW-3600000,state:'live',autoFees:true,feesRequested:true,credits:{base:'0',quote:'0'},operations:[],gas:{day:'2026-09-28',reserved:'0'}};}
function addTax(l,n){l.taxProtocol=recordTaxHarvest(l,n);l.credits.base=(BigInt(l.credits.base)+n).toString();}
function fundingWait(l,overrides={}){return {gasLamports:'0',ready:false,reason:'Insufficient SOL balance for the separate rewards wallet.',gasFundingNeed:{version:1,creatorAddress:l.keys.wallet.address,rewardsAddress:l.keys.rewards.address,creatorMinimumLamports:'12500000',rewardsMinimumLamports:'10000000',creatorPrincipalReserveLamports:'0',...overrides}};}
async function harness(t,l=launch()){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-reward-wallet-'));let data={launches:[structuredClone(l)]},clock=NOW,sequence=0,transaction=null,manager,failSave=false;
  const broadcasts=[],preparations=[],accounts={dir,storeFor:()=>({dir,read:async()=>structuredClone(data),write:async(_,value)=>{if(failSave){failSave=false;throw Error('Test durable write failed.');}data=structuredClone(value);}}),hostStore:{read:async(name,fallback)=>name==='launch-protocol-fees'?{recipient:address(),recipientScope:'launchpad'}:fallback}};
  const c={close(){},c:{getBlockHeight:async()=>10},rewardsGasFundingPlan:async()=>({gasLamports:'0',ready:true}),rewardHandoffInstructions:async(_,plan)=>[{handoff:plan}],holderRewardReference:async()=>({mint:USDC_MINT,usd:'1',at:clock}),claimInstructions:async()=>[],payoutInstructions:async(_,rows)=>rows,taxConversionPlan:async(_,credit)=>({amount:credit}),swapFeeInstructions:async()=>['sell'],holderSnapshot:async()=>({slot:101,rows:[{owner:address(),amount:'1'}]}),prepare:async(_,instructions,extra,initial,options)=>{preparations.push(structuredClone(options?.operation));return {signature:`tx-${++sequence}`,state:'pending',raw:`bytes-${sequence}`,createdAt:clock,lastValidBlockHeight:100};},broadcast:async op=>{assert(data.launches[0].operations.some(row=>row.signature===op.signature&&row.raw===op.raw));broadcasts.push(op.signature);},receipt:async()=>transaction};
  const restart=async()=>{await manager?.close();manager=new Launchpad(accounts,null,{chainFactory:()=>c,now:()=>clock});manager.kick=()=>{};};await restart();t.after(async()=>{await manager.close();await rm(dir,{force:true,recursive:true});});
  return {c,broadcasts,preparations,restart,failNextSave:()=>{failSave=true;},get l(){return data.launches[0];},get manager(){return manager;},advance:n=>{clock+=n;},process:()=>manager.process('owner'),async edit(fn){await manager.locked('owner',async b=>{fn(b.launches[0]);await manager.save('owner',b);});},async confirm(options={}){const current=data.launches[0],op=current.operations.find(row=>row.state==='pending');transaction=op.kind==='reward-handoff'?rewardHandoffTx(current,op,options):rewardFixtureReceipt(current,{operation:op,...options});await manager.process('owner');transaction=null;}};
}

test('dedicated role is distinct while old pending signatures keep creator ownership',()=>{
  const l=launch();provisionRewardsWallet(l,NOW);l.rewardsWallet.status='active';
  assert.equal(dedicatedRewardsWallet(l),true);assert.notEqual(l.keys.rewards.address,l.keys.wallet.address);
  assert.deepEqual(rewardsWalletSelection(l,{kind:'tax'}),{version:1,source:'rewards',address:l.keys.rewards.address,signerSource:'wallet'});
  assert.equal(rewardsWalletSelection(l,{kind:'sell'}).signerSource,'rewards');assert.equal(rewardsWalletSelection(l,{kind:'claim'}).source,'wallet');
  assert.equal(rewardsWalletSelection(l,{operation:{kind:'sell'}}).source,'wallet');
  assert.throws(()=>rewardsWalletSelection(l,{operation:{kind:'claim',rewardsWallet:{version:1,source:'rewards',address:l.keys.rewards.address,signerSource:'rewards'}}}),/does not match/);
});

test('missing/external/exported/compromised, aliased and mismatched keys fail before transferring',()=>{
  const original=launch();provisionRewardsWallet(original,NOW);
  for(const edit of [l=>delete l.keys.rewards.secret,l=>l.keys.rewards.external=true,l=>l.keys.rewards.exported=true,l=>l.keys.rewards.compromisedAt=1,l=>l.keys.rewards=l.keys.wallet,l=>l.keys.rewards.secret=newLaunchKeys().wallet.secret,l=>l.keys.rewards.address='not a wallet']){const l=structuredClone(original);edit(l);assert.equal(dedicatedRewardsWallet(l),false);assert.throws(()=>rewardHandoffPlan(l),/wallet state/);}
  for(const edit of [l=>delete l.feeCustody,l=>l.keys.wallet.exported=true,l=>l.walletExportedAt=1,l=>l.keys.wallet.external=true,l=>l.keys.wallet.secret=newLaunchKeys().wallet.secret,l=>{l.keys.platform={...l.keys.wallet,exported:true};},l=>{l.keys.platform=l.keys.wallet;l.platformWalletCompromisedAt=1;}]){const l=launch();edit(l);assert.throws(()=>requireManagedRewardSource(l),/custodian/);}
});

test('taxed handoff preserves gross history, net credits and proportional protocol reserve',()=>{
  const l=launch();l.credits={base:'40',quote:'100'};addTax(l,100n);
  const split=recordTaxConversion(l,{amount:'60',taxSource:'withheld-tax',taxProtocolPolicy:TAX_PROTOCOL_POLICY},60n,200n);l.taxProtocol=split.ledger;l.credits={base:'80',quote:'290'};provisionRewardsWallet(l,NOW);
  l.cycle={stage:'payout',index:0,payouts:[{owner:address(),amount:'290'}]};const op={signature:'saved',rewardHandoff:rewardHandoffPlan(l)},beforeWallet=structuredClone(l.keys.wallet);
  recordRewardHandoff(l,op,{baseDebit:80n,baseCredit:76n,quoteDebit:300n,quoteCredit:294n},NOW);
  assert.deepEqual(l.credits,{base:'76',quote:'285'});assert.equal(l.taxProtocol.sourceBaseCredit,'38');assert.equal(l.taxProtocol.handoffBaseLoss,'2');assert.equal(l.taxProtocol.harvestedBase,'100');assert.equal(l.taxProtocol.convertedBase,'60');assert.equal(l.taxProtocol.creditQuote,'9');assert.equal(l.taxProtocol.paidQuote,'0');assert.equal(l.taxProtocol.handoffQuoteLoss,'1');assert.equal(taxProtocolLedger(l).accruedQuote,'10');assert.equal(l.cycle.stage,'distribute');assert.equal(l.cycle.payouts,undefined);assert.deepEqual(l.keys.wallet,beforeWallet);
  assert.throws(()=>recordRewardHandoff(l,op,{baseDebit:80n,baseCredit:76n,quoteDebit:300n,quoteCredit:294n}),/allocation/);
});

test('migration journals only earned inventory before broadcast and survives restart without resubmission',async t=>{
  const l=launch();l.credits={base:'1000',quote:'2000'};const h=await harness(t,l);await h.process();const op=structuredClone(h.l.operations.at(-1));assert.equal(op.kind,'reward-handoff');assert.equal(op.rewardHandoff.baseUnits,'1000');assert.equal(op.rewardHandoff.quoteUnits,'2000');assert.equal(op.rewardsWallet.source,'wallet');assert.equal(h.l.rewardsWallet.status,'migrating');assert.deepEqual(h.l.credits,l.credits);
  await h.restart();await h.process();assert.equal(h.l.operations.length,1);assert.equal(h.l.operations[0].raw,op.raw);assert.equal(h.broadcasts.length,1);await h.confirm({baseCredit:980n});assert.equal(h.l.rewardsWallet.status,'active');assert.deepEqual(h.l.credits,{base:'980',quote:'2000'});assert.equal(h.l.keys.wallet.address,l.keys.wallet.address);assert.equal(h.l.operations.at(-1).state,'confirmed');
  const before=structuredClone(h.l);await h.manager.locked('owner',async b=>{const saved=b.launches[0];await h.manager.reconcile('owner',b,saved,h.c,saved.operations.at(-1));});assert.deepEqual(h.l,before);
});

test('unresolved old receipt prevents key provisioning and preserves its exact operation',async t=>{
  const l=launch();l.cycle={stage:'route',index:0};l.operations=[{kind:'sell',taxConversionPolicy:'paced-v1',state:'pending',signature:'prior',raw:'unchanged',createdAt:NOW,lastValidBlockHeight:100,amount:'10'}];const h=await harness(t,l);await h.process();await h.restart();await h.process();assert.equal(h.l.keys.rewards,undefined);assert.equal(h.l.rewardsWallet,undefined);assert.deepEqual(h.l.operations,l.operations);assert.equal(h.broadcasts.length,0);
});

test('an explicitly paused launch stays paused with no unsigned migration',async t=>{
  const l=launch();setFeeAutomation(l,false,NOW,'user');l.feesRequested=false;l.state='paused';const h=await harness(t,l);await h.process();assert.equal(h.l.keys.rewards,undefined);assert.equal(h.l.operations.length,0);assert.equal(h.l.feeAutomation.enabled,false);assert.equal(h.l.state,'paused');
});

test('partly paid legacy snapshot completes from original wallet before migration',async t=>{
  const l=launch(),paid=address(),unpaid=address();l.credits.quote='200';l.cycle={stage:'payout',index:1,payouts:[{owner:paid,amount:'100'},{owner:unpaid,amount:'200'}]};const h=await harness(t,l);await h.process();const op=h.l.operations.at(-1);assert.equal(op.kind,'payout');assert.deepEqual(op.payouts,[{owner:unpaid,amount:'200'}]);assert.equal(op.rewardsWallet.source,'wallet');assert.equal(h.l.rewardsWallet,undefined);await h.confirm({quote:-200n});assert.equal(h.l.cycle.index,2);await h.process();assert.equal(h.l.cycle,null);assert.equal(h.l.keys.rewards,undefined);await h.edit(l=>{l.feesRequested=true;});await h.process();assert.equal(h.l.rewardsWallet.status,'active');assert.deepEqual(h.l.credits,{base:'0',quote:'0'});
});

test('insufficient initial gas retries without moving inventory and principal is not network spend',async t=>{
  const h=await harness(t);h.c.rewardsGasFundingPlan=async l=>fundingWait(l,{creatorMinimumLamports:'0',rewardsMinimumLamports:'10000000'});await h.process();assert.equal(h.l.rewardsWallet.status,'migrating');assert.equal(h.l.rewardsWallet.gasInitializedAt,undefined);assert.equal(h.l.operations.length,0);assert.equal(h.l.rewardRetry.kind,'funding');h.c.rewardsGasFundingPlan=async()=>({gasLamports:'10000000',ready:true});h.advance(300001);await h.process();assert.equal(h.l.operations.at(-1).rewardHandoff.gasLamports,'10000000');await h.confirm();assert.equal(h.l.rewardsWallet.status,'active');assert(BigInt(h.l.gas.reserved)<10000000n,'transferred SOL principal must not consume daily network-cost budget');assert.deepEqual(h.l.credits,{quote:'0',base:'0'});
});

test('new creator claims hand off earned credit before direct tax collection or a sale',async t=>{
  const h=await harness(t);h.c.claimInstructions=async(_,kind)=>kind==='tax'?['tax']:['claim'];await h.process();assert.equal(h.l.operations.at(-1).kind,'claim');assert.equal(h.l.operations.at(-1).rewardsWallet.source,'wallet');await h.confirm({quote:200n,base:100n});assert.deepEqual(h.l.rewardsWallet.creatorCredits,{base:'100',quote:'200',protocolQuote:'0',taxBase:'0'});await h.process();assert.equal(h.l.operations.at(-1).kind,'reward-handoff');await h.confirm({baseCredit:98n});await h.process();const tax=h.l.operations.at(-1);assert.equal(tax.kind,'tax');assert.equal(tax.rewardsWallet.source,'rewards');assert.equal(tax.rewardsWallet.signerSource,'wallet');await h.confirm({base:1000n});assert.equal(h.l.rewardsWallet.creatorCredits.base,'0');assert.equal(h.l.taxProtocol.sourceBaseCredit,'1000');await h.process();assert.equal(h.l.operations.at(-1).kind,'sell');assert.equal(h.l.operations.at(-1).rewardsWallet.source,'rewards');
});

test('a finalized handoff can reconcile after key exposure but no further signing is allowed',async t=>{
  const l=launch();l.credits.base='100';const h=await harness(t,l);await h.process();await h.edit(l=>{delete l.keys.rewards.secret;l.keys.rewards.exportedAt=NOW;});await h.confirm();assert.equal(h.l.operations.at(-1).state,'confirmed');assert.equal(h.l.rewardsWallet.status,'active');assert.equal(h.l.credits.base,'100');await h.process();assert.equal(h.l.operations.length,1);assert.equal(h.l.state,'paused');assert.match(h.l.error,/wallet state/);
});

test('late allocation validation rolls back all receipt accounting before the error is saved',async t=>{
  const h=await harness(t);h.c.claimInstructions=async()=>['claim'];await h.process();await h.edit(l=>{l.rewardsWallet.creatorCredits.quote='malformed';});const credits=structuredClone(h.l.credits),cycle=structuredClone(h.l.cycle),operation=structuredClone(h.l.operations.at(-1));await h.confirm({quote:100n,base:20n});assert.deepEqual(h.l.credits,credits);assert.deepEqual(h.l.cycle,cycle);assert.equal(h.l.rewardsWallet.creatorCredits.base,'0');assert.equal(h.l.operations.at(-1).state,'pending');assert.equal(h.l.operations.at(-1).raw,operation.raw);await h.edit(l=>{l.rewardsWallet.creatorCredits.quote='0';});await h.confirm({quote:100n,base:20n});assert.deepEqual(h.l.credits,{quote:'100',base:'20'});assert.equal(h.l.operations.at(-1).state,'confirmed');
});

test('a failed durable receipt save preserves the pending operation and retry applies once',async t=>{
  const h=await harness(t);h.c.claimInstructions=async()=>['claim'];await h.process();h.failNextSave();await h.confirm({quote:100n});assert.deepEqual(h.l.credits,{quote:'0',base:'0'});assert.equal(h.l.operations.at(-1).state,'pending');assert.equal(h.l.rewardsWallet.creatorCredits.quote,'0');await h.restart();await h.confirm({quote:100n});assert.equal(h.l.credits.quote,'100');assert.equal(h.l.rewardsWallet.creatorCredits.quote,'100');assert.equal(h.l.operations.length,1);assert.equal(h.l.operations[0].state,'confirmed');
});

test('new original-authority work stops when custody becomes exposed after activation',async t=>{
  const h=await harness(t);provisionRewardsWallet(h.l,NOW);h.l.rewardsWallet.status='active';h.c.claimInstructions=async()=>['claim'];await h.edit(l=>{provisionRewardsWallet(l,NOW);l.rewardsWallet.status='active';l.keys.wallet.exported=true;});await h.process();assert.equal(h.l.operations.length,0);assert.equal(h.l.state,'paused');assert.match(h.l.error,/custodian/);
});

test('known failed or expired handoffs can be resumed without overriding explicit pauses',()=>{
  for(const error of ['reward-handoff failed onchain. Fees are paused. Resume to retry this step.','The saved reward-handoff transaction expired without landing. Its signature remains in history. Resume rewards to continue the saved step.','gas-sell failed onchain. Fees are paused. Resume to retry this step.','The saved gas-sell transaction expired without landing. Its signature remains in history. Resume rewards to continue the saved step.']){
    const l=launch();l.error=error;setFeeAutomation(l,false,NOW,'user');l.state='paused';assert.equal(rewardResumeBlocker(l),'');ensureFeeAutomation(l,NOW+1000);assert.equal(l.autoFees,false);assert.equal(l.feeAutomation.enabled,false);
  }
  const l=launch();l.error='Reward handoff receipt differs from its earned inventory.';assert.match(rewardResumeBlocker(l),/Review the saved reward error/);
});

test('blocked migration durably records exact refill minima and recovers without duplicate handoffs',async t=>{
  const l=launch();l.credits.base='1000';const h=await harness(t,l);let funded=false,reads=0;
  h.c.rewardsGasFundingPlan=async current=>{reads++;return funded?{gasLamports:'0',ready:true}:fundingWait(current,{creatorMinimumLamports:'12500000'});};
  await h.process();const hint=structuredClone(h.l.rewardsWallet.gasFundingNeed);
  assert.deepEqual(hint,{version:1,creatorAddress:l.keys.wallet.address,rewardsAddress:h.l.keys.rewards.address,creatorMinimumLamports:'12500000',rewardsMinimumLamports:'10000000',creatorPrincipalReserveLamports:'0',observedAt:NOW});
  assert.equal(h.l.rewardRetry.kind,'funding');assert.equal(h.l.operations.length,0);assert.deepEqual(h.l.credits,l.credits);
  await h.restart();await h.process();assert.equal(reads,1);assert.deepEqual(h.l.rewardsWallet.gasFundingNeed,hint);
  funded=true;h.advance(300001);await h.process();assert.equal(h.l.rewardsWallet.gasFundingNeed,undefined);assert.equal(h.l.operations.length,1);const pending=structuredClone(h.l.operations[0]);assert.equal(pending.rewardHandoff.gasLamports,'0');
  await h.restart();await h.process();assert.equal(reads,2);assert.equal(h.broadcasts.length,1);assert.deepEqual(h.l.operations[0],pending);
  await h.confirm();assert.equal(h.l.rewardsWallet.status,'active');assert.equal(h.l.rewardsWallet.gasFundingNeed,undefined);assert.equal(h.l.operations[0].state,'confirmed');assert.equal(h.l.credits.base,'1000');
});

test('active forwarding checks creator-paid costs while preserving completed gas initialization',async t=>{
  const l=launch();l.credits.quote='100';provisionRewardsWallet(l,NOW-1000);l.rewardsWallet.status='active';l.rewardsWallet.gasInitializedAt=NOW-1000;const h=await harness(t,l);let ready=false,reads=0;
  h.c.rewardsGasFundingPlan=async current=>{reads++;assert.equal(current.rewardsWallet.gasInitializedAt,NOW-1000);return ready?{gasLamports:'0',ready:true}:fundingWait(current,{creatorMinimumLamports:'10050000',rewardsMinimumLamports:'0'});};
  await h.process();assert.equal(reads,1);assert.equal(h.l.operations.length,0);assert.equal(h.l.rewardsWallet.status,'active');assert.equal(h.l.rewardsWallet.gasFundingNeed.rewardsMinimumLamports,'0');assert.equal(h.l.rewardsWallet.gasFundingNeed.creatorMinimumLamports,'10050000');
  ready=true;h.advance(300001);await h.process();assert.equal(reads,2);assert.equal(h.l.operations[0].rewardHandoff.gasLamports,'0');await h.confirm();assert.equal(h.l.rewardsWallet.gasInitializedAt,NOW-1000);assert.equal(h.l.credits.quote,'100');assert.equal(h.l.rewardsWallet.creatorCredits.quote,'0');assert.equal(h.l.rewardsWallet.gasFundingNeed,undefined);
});

test('readiness clears obsolete funding hints before a no-transaction activation',async t=>{
  const l=launch();provisionRewardsWallet(l,NOW-1000);l.rewardsWallet.gasFundingNeed={...fundingWait(l).gasFundingNeed,observedAt:NOW-1000};const h=await harness(t,l);
  h.c.rewardsGasFundingPlan=async()=>({gasLamports:'0',ready:true,creatorRequiredLamports:'0'});await h.process();assert.equal(h.l.rewardsWallet.status,'active');assert.equal(h.l.rewardsWallet.gasFundingNeed,undefined);assert.equal(h.l.operations.length,0);
});

test('invalid, wrong-wallet or principal-consuming funding hints cannot authorize gas refill',async t=>{
  for(const mutate of [need=>{need.creatorAddress=address();},need=>{need.rewardsAddress=address();},need=>{need.creatorMinimumLamports='50000001';},need=>{need.rewardsMinimumLamports='20000000';},need=>{need.creatorPrincipalReserveLamports='1';},need=>{need.creatorMinimumLamports='-1';}]){
    const h=await harness(t);h.c.rewardsGasFundingPlan=async l=>{const result=fundingWait(l);mutate(result.gasFundingNeed);return result;};await h.process();assert.equal(h.l.operations.length,0);assert.equal(h.l.rewardsWallet.gasFundingNeed,undefined);assert.equal(h.l.rewardRetry,undefined);assert.equal(h.l.state,'paused');
  }
});

test('a saved pending handoff keeps its hint and signed bytes until verified receipt completion',async t=>{
  const l=launch();l.credits.base='100';const h=await harness(t,l);await h.process();await h.edit(l=>{l.rewardsWallet.gasFundingNeed={...fundingWait(l).gasFundingNeed,observedAt:NOW};});const pending=structuredClone(h.l.operations[0]),hint=structuredClone(h.l.rewardsWallet.gasFundingNeed);
  h.c.rewardsGasFundingPlan=async()=>{throw Error('Pending transactions must not be replanned.');};await h.process();assert.deepEqual(h.l.operations[0],pending);assert.deepEqual(h.l.rewardsWallet.gasFundingNeed,hint);await h.confirm();assert.equal(h.l.rewardsWallet.gasFundingNeed,undefined);assert.equal(h.l.operations[0].state,'confirmed');assert.equal(h.l.operations.length,1);
});

test('real gas planning unblocks both above-threshold migration stalls after targeted refills',async t=>{
  for(const [creatorSol,rewardsSol]of [[7000000,20000000],[12000000,7000000]]){
    const l=launch();l.credits={base:'1000',quote:'2000'};provisionRewardsWallet(l,NOW-1000);const balances=new Map([[l.keys.wallet.address,creatorSol],[l.keys.rewards.address,rewardsSol]]),h=await harness(t,l);
    const planner={c:{getBalance:async key=>balances.get(key.toBase58()),getAccountInfo:async()=>null,getMinimumBalanceForRentExemption:async()=>2039280},mintInfo:async value=>({key:new PublicKey(value),program:value===l.keys.mint.address?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID,mint:{decimals:6,tlvData:Buffer.alloc(0)}})};
    h.c.rewardsGasFundingPlan=current=>LaunchChain.prototype.rewardsGasFundingPlan.call(planner,current);
    await h.process();const need=h.l.rewardsWallet.gasFundingNeed;assert(need);assert.equal(need.creatorPrincipalReserveLamports,'0');assert(BigInt(need.creatorMinimumLamports)>BigInt(creatorSol));assert.equal(need.rewardsMinimumLamports,'10000000');assert.equal(h.l.operations.length,0);
    // Model the gas service delivering each verified minimum independently.
    balances.set(need.creatorAddress,Number(need.creatorMinimumLamports));balances.set(need.rewardsAddress,Math.max(rewardsSol,Number(need.rewardsMinimumLamports)));
    h.advance(300001);await h.process();assert.equal(h.l.rewardsWallet.gasFundingNeed,undefined);assert.equal(h.l.operations.length,1);assert.equal(h.l.operations[0].rewardHandoff.gasLamports,'0');await h.confirm();assert.equal(h.l.rewardsWallet.status,'active');assert.equal(h.broadcasts.length,1);assert.deepEqual(h.l.credits,l.credits);
  }
});
