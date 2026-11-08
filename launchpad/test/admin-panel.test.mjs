import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Keypair } from '@solana/web3.js';
import { Launchpad } from '../src/launchpad.mjs';
import { LaunchpadAdmin } from '../src/launchpad-admin.mjs';
import { AdminPanel } from '../src/admin-panel.mjs';
import { newLaunchKeys } from '../src/launchpad-receipts.mjs';
import { activeRewardsFixture } from './helpers/rewards-wallet-fixture.mjs';
import { SOL_MINT } from '../public/launchpad-model.mjs';
import { TAX_BURN_MINT, TAX_BURN_WALLET, selectOfficialTaxBurn } from '../src/launchpad-tax-burn.mjs';
import { recordTaxHarvest } from '../src/launchpad-tax-protocol.mjs';

const adminId='a'.repeat(32), userId='b'.repeat(32), otherId='c'.repeat(32);
const address=()=>Keypair.generate().publicKey.toBase58();
const fixture=(index=1,mode='holders')=>({
  id:index.toString(16).padStart(32,'0'),createdAt:index,authorizedAt:10,feeCustody:'relay',curve:address(),
  keys:{...newLaunchKeys(),payer:newLaunchKeys().wallet},
  input:{route:'raydium',network:'mainnet-beta',name:`Coin ${index}`,symbol:`COIN${index}`,quoteMint:address(),feeMode:mode,taxBps:mode==='holders'?300:0,recipient:''},
  review:{quoteSymbol:'USDC',quoteDecimals:6},state:'live',operations:[{state:'confirmed',signature:'launch-signature',kind:'create'}],
  credits:{quote:'12000000',base:'123450000'},gas:{reserved:'9000'},autoFees:true,feesRequested:false,
});

async function harness(t,launches=[fixture()]){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-admin-panel-'));
  const books=new Map([[userId,{launches}],[otherId,{launches:[]}],[adminId,{launches:[]}]]);
  const users=new Map([[adminId,{id:adminId,username:'owner',role:'admin',mfaEnabled:true,mainWallet:address()}],[userId,{id:userId,username:'creator',role:'user',mfaEnabled:true,mainWallet:address()}],[otherId,{id:otherId,username:'another',role:'user',mfaEnabled:false,mainWallet:address()}]]);
  let reads=0,writes=0,policyReads=0,kicks=0,failWrite=false;
  const accounts={dir,get:async id=>structuredClone(users.get(id)),list:async()=>structuredClone([...users.values()]),hostStore:{read:async()=>({recipient:address(),verified:true,privateSetting:'never-export'})},storeFor:id=>({dir:join(dir,id),read:async()=>{reads++;return structuredClone(books.get(id)||{launches:[]});},write:async(key,book)=>{if(failWrite)throw Error('Storage unavailable');writes++;books.set(id,structuredClone(book));}})};
  const launchpad=new Launchpad(accounts,null);launchpad.kick=()=>{kicks++;};
  const launchAdmin=new LaunchpadAdmin({accounts,launchpad,now:()=>12345});
  const policy={get:async()=>{policyReads++;return{recipient:address(),ready:true,copyPpm:1000,sniperPpm:2000,marketPpm:3000,secret:'private-policy',rpcUrl:'private-rpc',description:'Solana fee policy',liquidityDescription:'SOL reference value'};}};
  const robinhoodPolicy={get:()=>{throw Error('Must not initialize wallets');},adapterAddress:()=>address()};
  const panel=new AdminPanel({accounts,launchpad,launchAdmin,policy,robinhoodPolicy,now:()=>12345});
  t.after(async()=>{await launchpad.close();await rm(dir,{recursive:true,force:true});});
  return{panel,launchAdmin,launchpad,books,users,accounts,policy,get reads(){return reads;},get writes(){return writes;},get policyReads(){return policyReads;},get kicks(){return kicks;},set failWrite(value){failWrite=value;}};
}
const request=(launch,extra={})=>({accountId:userId,id:launch.id,action:launch.input.feeMode==='holders'?'distribute':'buyback',reason:'Manual recovery requested.',requestId:'1'.repeat(32),...extra});

test('overview and manual actions reject non-admin and missing MFA before private inventory or policy reads',async t=>{
  const h=await harness(t);
  for(const actor of [userId,otherId]){await assert.rejects(h.panel.overview(actor),e=>e.statusCode===403);await assert.rejects(h.panel.launchAction(actor,{}),e=>e.statusCode===403);}
  h.users.get(adminId).mfaEnabled=false;await assert.rejects(h.panel.overview(adminId),/two-factor/);await assert.rejects(h.panel.launchAction(adminId,{}),/two-factor/);
  assert.equal(h.reads,0);assert.equal(h.policyReads,0);assert.equal(h.writes,0);assert.equal(h.kicks,0);
});

test('overview exposes aggregate controls and fee settings without initializing wallets or exporting secrets',async t=>{
  const holder=fixture(),buyback=fixture(2,'buyback'),creator=fixture(3,'creator');buyback.state='paused';
  const h=await harness(t,[holder,buyback]);h.books.get(otherId).launches.push(creator);
  const result=await h.panel.overview(adminId);
  assert.deepEqual(result.counts,{accounts:3,launches:3,holderLaunches:1,buybackLaunches:1,creatorLaunches:1,gotchiLaunches:0,activeServices:1,pausedServices:1});
  assert.equal(result.fees.solana.marketPpm,3000);assert.equal(result.fees.robinhood.ready,true);assert.equal(result.fees.robinhood.settlement,'eth');
  const json=JSON.stringify(result);for(const secret of [holder.keys.wallet.secret,'private-policy','private-rpc','privateSetting','SOL reference value'])if(secret!=='SOL reference value')assert(!json.includes(secret));
  assert(!result.fees.robinhood.liquidityDescription.includes('SOL'));assert.equal(h.writes,0);assert.equal(h.kicks,0);
  h.policy.get=async()=>{h.users.get(adminId).role='user';return{};};await assert.rejects(h.panel.overview(adminId),/Administrator/);
});

test('overview includes only sanitized protocol fee policy and retains current-role checks',async t=>{
  const h=await harness(t),recipient=address();let actor;
  h.panel.protocolFees={read:async id=>{actor=id;return {recipient,curveFeeBps:100,curveFeePercent:1,creationFeeSol:'0',configured:true,autoHarvest:true,harvestIntervalMinutes:60,minimumHarvestUsd:5,updatedAt:1234,updatedBy:'owner',lpPolicy:'burn',platformLpPercent:0,existingLaunches:'unchanged',secret:'hidden-fee-signer',rpcUrl:'hidden-rpc',operations:[{signed:'hidden-bytes'}]};}};
  const output=await h.panel.overview(adminId);assert.equal(actor,adminId);
  assert.deepEqual(output.protocolFees,{recipient,curveFeeBps:100,curveFeePercent:1,creationFeeSol:'0',configured:true,autoHarvest:true,harvestIntervalMinutes:60,minimumHarvestUsd:5,updatedAt:1234,updatedBy:'owner',lpPolicy:'burn',platformLpPercent:0,existingLaunches:'unchanged'});
  assert(!JSON.stringify(output).includes('hidden-'));
});

test('admin can queue holder distribution across accounts with durable audit and without changing custody, credits or automatic policy',async t=>{
  const launch=fixture();launch.autoFees=false;launch.state='paused';const before=structuredClone(launch),h=await harness(t,[launch]);
  const result=await h.panel.launchAction(adminId,request(launch)),saved=h.books.get(userId).launches[0];
  assert.equal(result.status,'queued');assert.equal(saved.state,'live');assert.equal(saved.feesRequested,true);assert.equal(saved.manualFeesRequested,true);assert.equal(saved.holderDistributionAdminRequest,'1'.repeat(32));assert.equal(saved.autoFees,false);
  for(const key of ['keys','credits','gas','operations','input'])assert.deepEqual(saved[key],before[key]);
  assert.deepEqual(saved.adminRewardHistory,[{at:12345,actorId:adminId,actor:'owner',accountId:userId,launchId:launch.id,requestId:'1'.repeat(32),action:'distribute',reason:'Manual recovery requested.',status:'queued'}]);
  assert.equal(result.launch.credits.quote,'12');assert.equal(result.launch.credits.base,'123.45');assert.equal(result.launch.rewardsAction.kind,'distribute');
  assert(!JSON.stringify(result).includes(launch.keys.wallet.secret));assert.equal(h.kicks,1);assert.equal(h.writes,1);
});

test('manual buyback reuses the existing fee cycle and keeps pending transaction bytes and spend limits unchanged',async t=>{
  const launch=fixture(1,'buyback');launch.cycle={id:'cycle1',stage:'burn',manual:false,budget:'500',gasLimit:'100'};launch.operations.push({id:'pending1',kind:'burn',state:'pending',signed:'saved-transaction',signature:'saved-signature',amount:'123'});launch.retry={at:999};
  const h=await harness(t,[launch]),result=await h.panel.launchAction(adminId,request(launch)),saved=h.books.get(userId).launches[0];
  assert.equal(result.status,'processing');assert.equal(saved.cycle.id,'cycle1');assert.equal(saved.cycle.manual,true);assert.equal(saved.cycle.budget,'500');assert.equal(saved.cycle.gasLimit,'100');assert.deepEqual(saved.operations,launch.operations);assert.equal(saved.forceHolderDistribution,undefined);assert.equal(saved.retry,undefined);assert.equal(saved.autoFees,true);
});

test('replaying a request is idempotent even after the cycle completes and colliding actors/actions are rejected',async t=>{
  const launch=fixture(),h=await harness(t,[launch]),body=request(launch);
  const both=await Promise.all([h.panel.launchAction(adminId,body),h.panel.launchAction(adminId,body)]);
  assert.deepEqual(both.map(x=>x.status),['queued','already_requested']);assert.equal(h.writes,1);
  const saved=h.books.get(userId).launches[0];saved.feesRequested=false;delete saved.manualFeesRequested;delete saved.holderDistributionAdminRequest;
  assert.equal((await h.panel.launchAction(adminId,body)).status,'already_requested');assert.equal(h.books.get(userId).launches[0].feesRequested,false);assert.equal(saved.adminRewardHistory.length,1);
  await assert.rejects(h.panel.launchAction(adminId,{...body,action:'buyback'}),e=>e.statusCode===409);
  h.users.get(otherId).role='admin';h.users.get(otherId).mfaEnabled=true;await assert.rejects(h.panel.launchAction(otherId,body),e=>e.statusCode===409);assert.equal(h.writes,1);
});

test('per-coin distribution queues behind an active held-SOL cycle without replacing its payouts; resume stays blocked',async t=>{
  for(const state of ['queued','processing']){
    const launch=fixture();launch.heldSolDistribution={state,requestId:'d'.repeat(32)};launch.cycle={stage:'payout',index:2,payouts:[{owner:address(),amount:'123'}],heldSolDistributionRequest:launch.heldSolDistribution.requestId};
    const h=await harness(t,[launch]),before=structuredClone(h.books.get(userId)),row=(await h.launchAdmin.list(adminId)).launches[0];
    assert.equal(row.rewardsAction.allowed,true);assert.equal(row.rewardsAutomation.allowed,false);
    await assert.rejects(h.panel.launchAction(adminId,request(launch,{action:'resume-rewards'})),/held-SOL holder distribution is in progress/);assert.deepEqual(h.books.get(userId),before);assert.equal(h.kicks,0);
    const response=await h.panel.launchAction(adminId,request(launch)),saved=h.books.get(userId).launches[0];
    assert.equal(response.status,'processing');assert.equal(saved.manualHolderDistribution.phase,'existing');
    assert.deepEqual(saved.cycle,launch.cycle);assert.deepEqual(saved.heldSolDistribution,launch.heldSolDistribution);assert.deepEqual(saved.operations,launch.operations);
  }
});

test('manual service controls reject unsafe custody, unconfirmed launch setup and mode mismatch without side effects',async t=>{
  const changes=[l=>{delete l.authorizedAt;},l=>{delete l.curve;},l=>{l.state='draft';},l=>{l.input.network='devnet';},l=>{l.input.feeMode='creator';},l=>{l.feeCustody='legacy';},l=>{l.keys.wallet.external=true;},l=>{l.keys.payer=l.keys.wallet;},l=>{l.walletExportedAt=1;},l=>{l.feeWalletExportedAt=1;},l=>{l.keys.wallet.exportedAt=1;},l=>{l.keys.wallet.secret='invalid';},l=>{l.keys.wallet.address=address();},l=>{l.operations.push({kind:'create',state:'pending'});},l=>{l.operations.push({kind:'fund',state:'awaiting_signature'});}];
  for(const change of changes){const launch=fixture();change(launch);const h=await harness(t,[launch]),before=structuredClone(h.books.get(userId));await assert.rejects(h.panel.launchAction(adminId,request(launch,{action:'distribute'})),e=>e.statusCode===409);assert.deepEqual(h.books.get(userId),before);assert.equal(h.kicks,0);assert.equal(h.writes,0);}
  const launch=fixture(),h=await harness(t,[launch]);await assert.rejects(h.panel.launchAction(adminId,request(launch,{action:'buyback'})),/reward mode changed/);
});

test('shared cross-account and personal main wallets cannot be triggered by admin service controls',async t=>{
  const launch=fixture(),h=await harness(t,[launch]),other=fixture(2);other.keys.wallet=launch.keys.wallet;h.books.get(otherId).launches.push(other);
  await assert.rejects(h.panel.launchAction(adminId,request(launch)),/shared or personal/);
  h.books.get(otherId).launches=[];h.users.get(otherId).mainWallet=launch.keys.wallet.address;await assert.rejects(h.panel.launchAction(adminId,request(launch)),/shared or personal/);assert.equal(h.writes,0);assert.equal(h.kicks,0);
});

test('admin can operate their own older service through the existing owner guards, but cannot assert ownership of another account',async t=>{
  const launch=fixture();delete launch.feeCustody;launch.keys.payer=launch.keys.wallet;launch.walletExportedAt=1;
  const h=await harness(t,[]);h.books.get(adminId).launches.push(launch);h.users.get(adminId).mainWallet=launch.keys.wallet.address;
  const row=(await h.launchAdmin.list(adminId)).launches[0];assert.equal(row.rewardsAction.allowed,true);assert.equal(row.eligibility.allowed,false);
  const result=await h.panel.launchAction(adminId,request(launch,{accountId:adminId}));assert.equal(result.status,'queued');assert.equal(h.books.get(adminId).launches[0].holderDistributionAdminRequest,'1'.repeat(32));
  const foreign=fixture(2);delete foreign.feeCustody;h.books.get(userId).launches.push(foreign);
  await assert.rejects(h.panel.launchAction(adminId,request(foreign,{ownerMatch:true})),/shared or personal/);
  const external=fixture(3);external.keys.wallet.external=true;h.books.get(adminId).launches.push(external);
  await assert.rejects(h.panel.launchAction(adminId,request(external,{accountId:adminId})),/connected wallet/);
});

test('malformed action bodies are rejected and revocation during cross-account inventory cannot commit',async t=>{
  const launch=fixture(),h=await harness(t,[launch]);
  for(const extra of [{accountId:'unknown'},{id:'1'},{requestId:'bad'},{action:'transfer'},{reason:'no'},{reason:'x'.repeat(501)}])await assert.rejects(h.panel.launchAction(adminId,request(launch,extra)));
  const original=h.accounts.list;h.accounts.list=async()=>{const users=await original();h.users.get(adminId).role='user';return users;};
  await assert.rejects(h.panel.launchAction(adminId,request(launch)),/Administrator/);assert.deepEqual(h.books.get(userId).launches[0],launch);assert.equal(h.writes,0);assert.equal(h.kicks,0);
});

test('storage failure cannot kick an unaudited manual action',async t=>{
  const launch=fixture(),h=await harness(t,[launch]);h.failWrite=true;
  await assert.rejects(h.panel.launchAction(adminId,request(launch)),/Storage unavailable/);assert.deepEqual(h.books.get(userId).launches[0],launch);assert.equal(h.kicks,0);
});

test('manual holder distribution queues a new conversion behind an existing saved cycle without changing its budget or pacing',async t=>{
  const launch=fixture();launch.state='error';launch.cycle={id:'existing',stage:'sell',forceHolderDistribution:false,taxTranche:'1000',nextTaxSaleAt:999999};
  const h=await harness(t,[launch]);await h.panel.launchAction(adminId,request(launch));const saved=h.books.get(userId).launches[0];
  assert.equal(saved.holderDistributionAdminRequest,'1'.repeat(32));assert.deepEqual(saved.cycle,launch.cycle);assert.equal(saved.manualHolderDistribution.phase,'existing');assert.equal(saved.cycle.nextTaxSaleAt,999999);assert.equal(saved.cycle.taxTranche,'1000');assert.equal(saved.state,'live');assert.equal(saved.autoFees,true);
});

test('launchpad-only overview retains launch controls without reading inactive toolkit policies',async t=>{
  const h=await harness(t),before=structuredClone(h.books),hostReads=[];
  const read=h.accounts.hostStore.read;h.accounts.hostStore.read=async(...args)=>{hostReads.push(args[0]);return read(...args);};
  h.panel.toolkit=false;h.panel.robinhoodPolicy.adapterAddress=()=>assert.fail('inactive chain must not be inspected');
  const result=await h.panel.overview(adminId);
  assert.equal(result.fees,undefined);assert.equal(h.policyReads,0);assert(!hostReads.includes('robinhood-fee-policy'));
  assert.deepEqual(result.capabilities,{manualHolderRewards:true,manualBuyback:true,creatorFeeRouting:true,administratorLaunch:true});
  assert.equal(result.counts.launches,1);assert.equal(result.counts.accounts,3);assert.deepEqual(h.books,before);assert.equal(h.writes,0);assert.equal(h.kicks,0);
  assert(!/cashback|toolkit|robinhood/i.test(JSON.stringify(result)));
  h.users.get(adminId).role='user';await assert.rejects(h.panel.overview(adminId),e=>e.statusCode===403);
});

test('admin Resume rewards persists automatic opt-in without adding manual payout overrides or changing saved work',async t=>{
  for(const mode of ['holders','buyback']){
    const launch=fixture(1,mode);Object.assign(launch,{state:'paused',autoFees:false,feeAutomation:{enabled:false,source:'user',updatedAt:100},error:'Fee service paused. Pending receipts will still be reconciled.',cycle:{stage:mode==='holders'?'payout':'burn',index:3,payouts:[{owner:address(),amount:'100'}],nextTaxSaleAt:999999},rewardRetry:{at:99999,attempt:2},lastTaxConversionAt:1234});
    const before=structuredClone(launch),h=await harness(t,[launch]);
    const row=(await h.launchAdmin.list(adminId)).launches[0];assert.deepEqual(row.rewardsAutomation,{allowed:true,enabled:false,status:'paused',reason:'',pending:false,needed:true,pauseAllowed:true,pauseReason:'',pauseNeeded:false});
    const result=await h.panel.launchAction(adminId,request(launch,{action:'resume-rewards',reason:''})),saved=h.books.get(userId).launches[0];
    assert.equal(result.status,'resumed');assert.equal(saved.autoFees,true);assert.equal(saved.state,'live');assert.equal(saved.feesRequested,true);assert.deepEqual(saved.feeAutomation,{enabled:true,source:'admin',updatedAt:12345});assert.equal(saved.rewardRetry,undefined);
    for(const field of ['keys','credits','gas','operations','cycle','input','lastTaxConversionAt'])assert.deepEqual(saved[field],before[field]);
    for(const field of ['manualFeesRequested','forceHolderDistribution','holderDistributionAdminRequest','buybackAdminRequest'])assert.equal(saved[field],undefined);
    assert.equal(saved.adminRewardHistory[0].action,'resume-rewards');assert.equal(saved.adminRewardHistory[0].reason,'Automatic rewards resumed from the admin panel.');assert.equal(h.kicks,1);assert.equal(h.writes,1);
    assert.equal(result.launch.rewardsAutomation.needed,false);assert(!JSON.stringify(result).includes(launch.keys.wallet.secret));
  }
});

test('admin pause remains available during retries and preserves signed transactions and payout checkpoints',async t=>{
  const launch=fixture();Object.assign(launch,{feesRequested:true,feeAutomation:{enabled:true,source:'launch',updatedAt:100},rewardRetry:{at:99999,attempt:2,kind:'network',reason:'RPC unavailable'},cycle:{stage:'payout',index:3,payouts:[{owner:address(),amount:'100'}]},error:'Automatic rewards are waiting to retry automatically.'});launch.operations.push({kind:'payout',state:'pending',signature:'saved-pause-signature',raw:'exact-saved-payout',amount:'100',createdAt:1,lastValidBlockHeight:10});
  const h=await harness(t,[launch]),before=structuredClone(launch),body=request(launch,{action:'pause-rewards',reason:''});
  const rows=(await h.launchAdmin.list(adminId)).launches;assert.equal(rows[0].rewardsAutomation.pauseAllowed,true);assert.equal(rows[0].rewardsAutomation.pauseNeeded,true);
  const response=await h.panel.launchAction(adminId,body),saved=h.books.get(userId).launches[0];
  assert.equal(response.status,'paused');assert.equal(saved.autoFees,false);assert.equal(saved.feesRequested,false);assert.deepEqual(saved.feeAutomation,{enabled:false,source:'admin',updatedAt:12345});assert.equal(saved.rewardRetry,undefined);assert.equal(saved.error,before.error);
  for(const field of ['keys','credits','gas','operations','cycle','input','state'])assert.deepEqual(saved[field],before[field]);
  assert.equal(saved.adminRewardHistory[0].action,'pause-rewards');assert.equal(saved.adminRewardHistory[0].reason,'Automatic rewards paused from the admin panel.');assert.equal(h.writes,1);
  let checks=0;h.launchpad.now=()=>400000;h.launchpad.chainFactory=()=>({receipt:async op=>{checks++;assert.equal(op.raw,'exact-saved-payout');return null;},pendingTransactionState:async()=>({state:'unknown',reason:'Historical receipt unavailable.'}),prepare:()=>assert.fail('Paused service must not sign new work'),broadcast:()=>assert.fail('An unknown expired receipt must not be replaced')});
  await h.launchpad.process(userId);assert.equal(checks,1);assert.equal(h.books.get(userId).launches[0].autoFees,false);assert.equal(h.books.get(userId).launches[0].feeAutomation.enabled,false);assert.deepEqual(h.books.get(userId).launches[0].credits,before.credits);
});

test('pause is idempotent and replay cannot override a later explicit resume',async t=>{
  const launch=fixture(),h=await harness(t,[launch]),body=request(launch,{action:'pause-rewards'});
  const responses=await Promise.all([h.panel.launchAction(adminId,body),h.panel.launchAction(adminId,body)]);assert.deepEqual(responses.map(row=>row.status),['paused','already_requested']);assert.equal(h.writes,1);
  await h.panel.launchAction(adminId,{...body,action:'resume-rewards',requestId:'2'.repeat(32)});const before=structuredClone(h.books.get(userId));assert.equal(before.launches[0].autoFees,true);
  assert.equal((await h.panel.launchAction(adminId,body)).status,'already_requested');assert.deepEqual(h.books.get(userId),before);assert.equal(h.writes,2);
  await assert.rejects(h.panel.launchAction(adminId,{...body,action:'resume-rewards'}),e=>e.statusCode===409);
});

test('pause needs no usable signer and cannot erase an accounting failure to permit resume',async t=>{
  const launch=fixture();launch.keys.wallet.secret='unavailable';launch.error='Fee-credit invariant failed.';const h=await harness(t,[launch]);
  const result=await h.panel.launchAction(adminId,request(launch,{action:'pause-rewards'}));assert.equal(result.status,'paused');const saved=h.books.get(userId).launches[0];assert.equal(saved.error,'Fee-credit invariant failed.');assert.equal(saved.autoFees,false);assert.equal(result.launch.rewardsAutomation.allowed,false);
  await assert.rejects(h.panel.launchAction(adminId,request(launch,{action:'resume-rewards',requestId:'2'.repeat(32)})),/Review the saved reward error/);
});

test('pause requires current administrator MFA and durable storage before waking reconciliation',async t=>{
  const launch=fixture(),h=await harness(t,[launch]),body=request(launch,{action:'pause-rewards'});
  for(const actor of [userId,otherId])await assert.rejects(h.panel.launchAction(actor,body),e=>e.statusCode===403);
  h.users.get(adminId).mfaEnabled=false;await assert.rejects(h.panel.launchAction(adminId,body),e=>e.statusCode===403);h.users.get(adminId).mfaEnabled=true;
  h.failWrite=true;await assert.rejects(h.panel.launchAction(adminId,body),/Storage unavailable/);assert.deepEqual(h.books.get(userId).launches[0],launch);assert.equal(h.kicks,0);
});

test('Resume rewards keeps unresolved signed bytes and reconciles their receipt before any new work',async t=>{
  for(const kind of ['payout','tax-protocol-payout']){
  const launch=fixture();Object.assign(launch,{state:'paused',autoFees:false,error:'Transaction receipt is still unresolved. Automatic work is paused while Launchpad checks the saved signature.',feeAutomation:{enabled:false,source:'user',updatedAt:100},cycle:{stage:'payout',index:3,payouts:[],holderRewardPolicy:'fixed-usd-100-v1'}});
  const pending={kind,state:'pending',signature:'saved-signature',raw:'exact-signed-bytes',amount:'100',createdAt:1,lastValidBlockHeight:10,payouts:[{owner:address(),amount:'100'}]};launch.operations.push(pending);
  const h=await harness(t,[launch]);let checks=0;h.launchpad.now=()=>400000;h.launchpad.chainFactory=()=>({receipt:async op=>{checks++;assert.equal(op.signature,pending.signature);return null;},pendingTransactionState:async()=>({state:'unknown',reason:'Historical receipt unavailable.'}),prepare:()=>assert.fail('No replacement may be signed before receipt resolution'),broadcast:()=>assert.fail('An unresolved expired transaction cannot be rebroadcast')});
  await h.panel.launchAction(adminId,request(launch,{action:'resume-rewards'}));assert.deepEqual(h.books.get(userId).launches[0].operations,launch.operations);
  await h.launchpad.process(userId);const saved=h.books.get(userId).launches[0];assert.equal(checks,1);assert.equal(saved.operations.at(-1).state,'pending');assert.equal(saved.operations.at(-1).signature,pending.signature);assert.equal(saved.operations.at(-1).raw,pending.raw);assert.deepEqual(saved.credits,launch.credits);assert.equal(saved.cycle.index,3);assert.equal(saved.autoFees,true);
  }
});

test('admin can resume the reported closed scheduler failure and checks the saved receipt before any new payout',async t=>{
  const launch=fixture();Object.assign(launch,{state:'paused',autoFees:false,feesRequested:false,error:'failed to get info about account 5eqQJP9Ms7Rq6gqz1wKY9mNTiQckw2eQNh4hRtCB5Hh5: Error: RPC scheduler closed',feeAutomation:{enabled:true,source:'launch',updatedAt:100},cycle:{stage:'payout',index:2,payouts:[{owner:address(),amount:'100'}],holderRewardPolicy:'fixed-usd-100-v1',nextTaxSaleAt:999999}});
  const pending={kind:'payout',state:'pending',signature:'scheduler-saved-signature',raw:'scheduler-exact-signed-bytes',amount:'100',createdAt:1,lastValidBlockHeight:10,payouts:[{owner:address(),amount:'100'}]};launch.operations.push(pending);
  const before=structuredClone(launch),h=await harness(t,[launch]);let checks=0;
  const row=(await h.launchAdmin.list(adminId)).launches[0];assert.equal(row.rewardsAutomation.allowed,true);assert.equal(row.rewardsAutomation.needed,true);assert.equal(row.rewardsAutomation.pending,true);assert.equal(row.rewardsAutomation.reason,'');
  h.launchpad.now=()=>400000;h.launchpad.chainFactory=()=>({receipt:async op=>{checks++;assert.equal(op.signature,pending.signature);assert.equal(op.raw,pending.raw);return null;},pendingTransactionState:async()=>({state:'unknown',reason:'Historical receipt unavailable.'}),prepare:()=>assert.fail('A scheduler restart cannot authorize a replacement payout'),broadcast:()=>assert.fail('An unresolved expired payout must not be rebroadcast')});
  const result=await h.panel.launchAction(adminId,request(launch,{action:'resume-rewards'}));assert.equal(result.status,'resumed');const resumed=h.books.get(userId).launches[0];
  for(const key of ['keys','credits','gas','operations','cycle','input'])assert.deepEqual(resumed[key],before[key]);
  assert.equal(resumed.feeAutomation.enabled,true);assert.equal(resumed.feeAutomation.source,'admin');assert.equal(resumed.manualFeesRequested,undefined);assert.equal(resumed.forceHolderDistribution,undefined);assert.equal(h.writes,1);assert.equal(h.kicks,1);
  await h.launchpad.process(userId);const saved=h.books.get(userId).launches[0];assert.equal(checks,1);assert.equal(saved.operations.at(-1).state,'pending');assert.equal(saved.operations.at(-1).signature,pending.signature);assert.equal(saved.operations.at(-1).raw,pending.raw);assert.deepEqual(saved.credits,before.credits);assert.deepEqual(saved.cycle,before.cycle);assert.equal(saved.autoFees,true);
});

test('replayed Resume request cannot turn rewards back on after a later deliberate pause',async t=>{
  const launch=fixture();launch.autoFees=false;launch.review.minimumSol='0.05';const h=await harness(t,[launch]),body=request(launch,{action:'resume-rewards'});
  const both=await Promise.all([h.panel.launchAction(adminId,body),h.panel.launchAction(adminId,body)]);assert.deepEqual(both.map(r=>r.status),['resumed','already_requested']);assert.equal(h.writes,1);
  await h.launchpad.action(userId,launch.id,'pause');const before=structuredClone(h.books.get(userId));
  assert.equal((await h.panel.launchAction(adminId,body)).status,'already_requested');assert.deepEqual(h.books.get(userId),before);assert.equal(before.launches[0].autoFees,false);
  await assert.rejects(h.panel.launchAction(adminId,{...body,action:'distribute'}),e=>e.statusCode===409);
});

test('Resume does not bypass custody, signer, setup or saved accounting and snapshot errors',async t=>{
  const mutations=[l=>{l.input.feeMode='creator';},l=>{delete l.curve;},l=>{l.keys.wallet.external=true;},l=>{l.feeCustody='legacy';},l=>{l.keys.wallet.secret='bad';},l=>{l.operations.push({kind:'create',state:'pending'});},...['Fee-credit invariant failed.','Payout receipt differs from its earned-fee budget.','The token-account scan returned malformed account data.','The token-account scan returned an incomplete or invalid page.','Unknown service failure.','Invalid holder account; RPC scheduler closed','Payout receipt differs from its earned-fee budget; RPC scheduler closed','Fee-credit invariant failed; RPC scheduler closed'].map(message=>l=>{l.error=message;})];
  for(const mutate of mutations){const launch=fixture();launch.autoFees=false;launch.state='paused';mutate(launch);const h=await harness(t,[launch]),before=structuredClone(h.books.get(userId));await assert.rejects(h.panel.launchAction(adminId,request(launch,{action:'resume-rewards'})),e=>e.statusCode===409);assert.deepEqual(h.books.get(userId),before);assert.equal(h.kicks,0);assert.equal(h.writes,0);}
});

test('Resume requires current admin MFA and a durable audit before the worker is woken',async t=>{
  const launch=fixture(),h=await harness(t,[launch]),body=request(launch,{action:'resume-rewards'});
  for(const actor of [userId,otherId])await assert.rejects(h.panel.launchAction(actor,body),e=>e.statusCode===403);
  h.users.get(adminId).mfaEnabled=false;await assert.rejects(h.panel.launchAction(adminId,body),e=>e.statusCode===403);h.users.get(adminId).mfaEnabled=true;
  h.failWrite=true;await assert.rejects(h.panel.launchAction(adminId,body),/Storage unavailable/);assert.deepEqual(h.books.get(userId).launches[0],launch);assert.equal(h.kicks,0);
});

test('Resume retains the automatic $100 minimum when the resumed cycle runs',async t=>{
  const launch=fixture();Object.assign(launch,{autoFees:false,state:'paused',lastHolderRewardCheck:1,cycle:{stage:'distribute',index:0},credits:{quote:'12000000',base:'0'}});launch.input.taxBps=0;launch.review.price={usd:'1'};
  // This checks the payout minimum after wallet migration has already settled.
  activeRewardsFixture(launch,1);
  const h=await harness(t,[launch]);h.launchpad.now=()=>4000000;h.launchpad.chainFactory=()=>({holderRewardReference:async()=>({mint:launch.input.quoteMint,usd:'1',at:4000000}),holderSnapshot:()=>assert.fail('The $12 balance is below the automatic $100 minimum'),prepare:()=>assert.fail('Resume must not force a below-threshold payout')});
  await h.panel.launchAction(adminId,request(launch,{action:'resume-rewards'}));await h.launchpad.process(userId);
  const saved=h.books.get(userId).launches[0];assert.equal(saved.cycle,null);assert.equal(saved.autoFees,true);assert.equal(saved.feesRequested,false);assert.equal(saved.credits.quote,'12000000');assert.deepEqual(saved.operations,launch.operations);
});

test('Resume cannot reset a used daily gas budget and the saved payout waits until its next reset',async t=>{
  const launch=fixture(),now=10000000;Object.assign(launch,{autoFees:true,state:'live',feeAutomation:{enabled:true},error:'Automatic rewards will continue after the daily gas budget resets.',rewardRetry:{at:86401000,kind:'gas-budget',attempt:1},cycle:{stage:'payout',index:1,payouts:[{owner:address(),amount:'100'},{owner:address(),amount:'100'}],holderRewardPolicy:'fixed-usd-100-v1'},gas:{day:'1970-01-01',reserved:'100000000'}});launch.input.dailyGasLamports='100000000';
  const h=await harness(t,[launch]);h.launchpad.now=()=>now;h.launchpad.chainFactory=()=>({payoutInstructions:async()=>['payout'],prepare:()=>assert.fail('An exhausted budget must not sign more work')});
  await h.panel.launchAction(adminId,request(launch,{action:'resume-rewards'}));await h.launchpad.process(userId);
  const saved=h.books.get(userId).launches[0];assert.deepEqual(saved.gas,launch.gas);assert.deepEqual(saved.operations,launch.operations);assert.deepEqual(saved.credits,launch.credits);assert.equal(saved.cycle.index,1);assert.equal(saved.rewardRetry.at,86401000);assert.equal(saved.rewardRetry.kind,'gas-budget');assert.equal(saved.autoFees,true);
});


test('repeated full distribution clicks preserve a saved payout and original request identity, including after completion',async t=>{
  const launch=fixture();launch.cycle={stage:'payout',index:3,payouts:[{owner:address(),amount:'10'}],slot:123};
  launch.operations.push({id:'signed',kind:'payout',state:'pending',raw:'exact-signed-bytes',signature:'saved-signature',amount:'10'});
  const h=await harness(t,[launch]);await h.panel.launchAction(adminId,request(launch));const queued=structuredClone(h.books.get(userId).launches[0]);
  const second=request(launch,{requestId:'2'.repeat(32)}),response=await h.panel.launchAction(adminId,second),saved=h.books.get(userId).launches[0];
  assert.equal(response.status,'already_requested');assert.equal(saved.holderDistributionAdminRequest,'1'.repeat(32));assert.deepEqual(saved.manualHolderDistribution,queued.manualHolderDistribution);assert.deepEqual(saved.cycle,launch.cycle);assert.deepEqual(saved.operations,launch.operations);
  saved.manualHolderDistribution.state='completed';saved.cycle=null;saved.feesRequested=false;delete saved.holderDistributionAdminRequest;
  const completed=structuredClone(h.books.get(userId));assert.equal((await h.panel.launchAction(adminId,second)).status,'already_requested');assert.deepEqual(h.books.get(userId),completed);
});

test('one-off distribution and retries preserve disabled automation while pause blocks the request and keeps signed work',async t=>{
  const launch=fixture();Object.assign(launch,{state:'paused',autoFees:false,feeAutomation:{enabled:false,source:'admin',updatedAt:5},error:'Automatic rewards are waiting for SOL and will retry automatically.'});
  launch.operations.push({id:'signed',kind:'sell',state:'pending',raw:'exact-signed-bytes',signature:'saved-signature',amount:'10'});
  const h=await harness(t,[launch]);await h.panel.launchAction(adminId,request(launch));
  let saved=h.books.get(userId).launches[0];assert.deepEqual(saved.feeAutomation,launch.feeAutomation);assert.equal(saved.autoFees,false);assert.deepEqual(saved.operations,launch.operations);
  saved.manualHolderDistribution.state='waiting';saved.error='Manual rewards are waiting for SOL and will retry automatically.';
  await h.panel.launchAction(adminId,request(launch,{action:'pause-rewards',requestId:'2'.repeat(32)}));saved=h.books.get(userId).launches[0];
  assert.equal(saved.error,'Manual rewards are waiting for SOL and will retry automatically.');assert.equal(saved.manualHolderDistribution.state,'blocked');assert.equal(saved.manualHolderDistribution.pausedByAdmin,true);assert.equal(saved.feesRequested,false);assert.deepEqual(saved.operations,launch.operations);
  await assert.rejects(h.panel.launchAction(adminId,request(launch,{action:'resume-rewards',requestId:'4'.repeat(32)})),/Use Distribute now to continue/);
  await h.panel.launchAction(adminId,request(launch,{requestId:'3'.repeat(32)}));saved=h.books.get(userId).launches[0];
  assert.equal(saved.manualHolderDistribution.requestId,'1'.repeat(32));assert.equal(saved.manualHolderDistribution.state,'queued');assert.equal(saved.autoFees,false);assert.deepEqual(saved.operations,launch.operations);
});

test('full distribution cannot clear unknown or integrity failures; known waits remain actionable',async t=>{
  for(const error of ['Unknown service failure.','Fee-credit invariant failed.','Payout receipt differs from its earned-fee budget.','Invalid holder account; RPC timeout']){
    const launch=fixture();launch.state='paused';launch.error=error;const h=await harness(t,[launch]),before=structuredClone(h.books.get(userId));
    assert.equal((await h.launchAdmin.list(adminId)).launches[0].rewardsAction.allowed,false);
    await assert.rejects(h.panel.launchAction(adminId,request(launch)),/Review the saved reward error/);assert.deepEqual(h.books.get(userId),before);assert.equal(h.kicks,0);
  }
  const launch=fixture(),h=await harness(t,[launch]);await h.panel.launchAction(adminId,request(launch));
  const saved=h.books.get(userId).launches[0];saved.manualHolderDistribution.state='waiting';saved.error='Manual rewards are waiting for SOL and will retry automatically.';
  assert.equal((await h.launchAdmin.list(adminId)).launches[0].rewardsAction.allowed,true);const prior=structuredClone(saved.manualHolderDistribution);
  const reply=await h.panel.launchAction(adminId,request(launch,{requestId:'2'.repeat(32)}));assert.equal(reply.status,'already_requested');assert.deepEqual(h.books.get(userId).launches[0].manualHolderDistribution,prior);
});

test('v71.24: the owner burns the collected LAUNCHPAD tax on request when automatic burning is off',async t=>{
  const names=['LAUNCHPAD_OFFICIAL_TAX_BURN_ENABLED','LAUNCHPAD_OFFICIAL_TAX_AUTO_BURN','LAUNCHPAD_OFFICIAL_INITIAL_BURN_ENABLED'],old=names.map(name=>process.env[name]);
  process.env.LAUNCHPAD_OFFICIAL_TAX_BURN_ENABLED='true';delete process.env.LAUNCHPAD_OFFICIAL_TAX_AUTO_BURN;process.env.LAUNCHPAD_OFFICIAL_INITIAL_BURN_ENABLED='false';
  t.after(()=>names.forEach((name,i)=>old[i]===undefined?delete process.env[name]:process.env[name]=old[i]));
  const official=n=>{const l=fixture(n);return Object.assign(l,{input:{...l.input,quoteMint:SOL_MINT,taxBps:200,symbol:'LAUNCHPAD'},keys:{...l.keys,mint:{address:TAX_BURN_MINT},rewards:{address:TAX_BURN_WALLET}},credits:{quote:'0',base:'0'},feeAutomation:{enabled:true,source:'admin',updatedAt:1},
    rewardsWallet:{version:1,status:'active',address:TAX_BURN_WALLET,createdAt:1,activatedAt:1,gasInitializedAt:1,creatorCredits:{base:'0',quote:'0',protocolQuote:'0',taxBase:'0'}},review:{...l.review,quoteSymbol:'SOL',quoteDecimals:9}});};
  const curve=official(7),empty=official(9);
  curve.taxProtocol=recordTaxHarvest(curve,100n);curve.credits.base='100';assert.equal(selectOfficialTaxBurn(curve,12345),true);assert.equal(selectOfficialTaxBurn(empty,12345),true);
  const other=fixture(8),h=await harness(t,[curve,other,empty]),kicks=h.kicks,id='7'.repeat(32);
  const result=await h.panel.launchAction(adminId,{accountId:userId,id:curve.id,action:'burn-tax',requestId:id});
  assert.equal(result.status,'queued');assert.equal(result.launch.taxBurn.manual,true);assert.equal(result.launch.taxBurn.manualRequested,true);
  const saved=h.books.get(userId).launches.find(l=>l.id===curve.id);
  assert.deepEqual([saved.taxBurnRequest.requestId,saved.taxBurnRequest.actorId,saved.adminRewardHistory.at(-1).action],[id,adminId,'burn-tax']);assert.equal(h.kicks,kicks+1);
  assert.equal((await h.panel.launchAction(adminId,{accountId:userId,id:curve.id,action:'burn-tax',requestId:id})).status,'already_requested');
  await assert.rejects(h.panel.launchAction(adminId,{accountId:userId,id:curve.id,action:'burn-tax',requestId:'8'.repeat(32)}),/already requested/);
  await assert.rejects(h.panel.launchAction(adminId,{accountId:userId,id:other.id,action:'burn-tax',requestId:'9'.repeat(32)}),/official LAUNCHPAD/);
  await assert.rejects(h.panel.launchAction(userId,{accountId:userId,id:curve.id,action:'burn-tax',requestId:'6'.repeat(32)}),/Administrator|admin/i);
  delete saved.taxBurnRequest;process.env.LAUNCHPAD_OFFICIAL_TAX_AUTO_BURN='true';
  await assert.rejects(h.panel.launchAction(adminId,{accountId:userId,id:curve.id,action:'burn-tax',requestId:'5'.repeat(32)}),/already burns automatically/);
  delete process.env.LAUNCHPAD_OFFICIAL_TAX_AUTO_BURN;
  await assert.rejects(h.panel.launchAction(adminId,{accountId:userId,id:empty.id,action:'burn-tax',requestId:'4'.repeat(32)}),/no collected tax/);
});

// ---- v71.26: the "Needs you" inbox on the overview ----
test('the overview lists what needs an operator, with the admin page that handles each item, and never fails on an optional service',async t=>{
  const holder=fixture(),failed=fixture(2,'creator'),paused=fixture(3,'holders');
  failed.state='failed';failed.curve=null;failed.operations=[{state:'failed',kind:'create'}];failed.error='The launch transaction expired before it executed.';
  paused.state='paused';paused.autoFees=false;paused.feeAutomation={enabled:false};
  const h=await harness(t,[holder,failed,paused]);
  h.launchAdmin.pumpClassic={adminAttention:async actorId=>{assert.equal(actorId,adminId);return {refunds:2,strategiesPaused:1,payoutsBlocked:0,stuck:1,failed:3};}};
  const result=await h.panel.overview(adminId);
  assert.deepEqual(result.counts,{accounts:3,launches:3,holderLaunches:2,buybackLaunches:0,creatorLaunches:1,gotchiLaunches:0,activeServices:1,pausedServices:1},'counts keep their shape');
  const byCode=Object.fromEntries(result.attention.map(item=>[item.code,item]));
  assert.deepEqual([byCode['failed-launches'].count,byCode['failed-launches'].hash],[5,'#tokens/cleanup'],'one Raydium failure plus the Pump.fun failures and stuck funding');
  assert.deepEqual([byCode['refunds-waiting'].count,byCode['refunds-waiting'].hash],[2,'#tokens/cleanup?kind=refund']);
  assert.deepEqual([byCode['strategies-paused'].count,byCode['strategies-paused'].hash],[1,'#tokens/pump-fun?state=attention']);
  assert.ok(byCode['rewards-paused']?.count>=1,'a paused reward service is listed');
  assert.equal(byCode['payouts-blocked'],undefined,'nothing blocked, no item');
  for(const item of result.attention){assert.match(item.hash,/^#[a-z-]+(\/[a-z-]+)?(\?[\w.=&-]*)?$/);assert.ok(item.label&&item.detail&&item.count>0);}
  h.launchAdmin.pumpClassic={adminAttention:async()=>{throw Error('Pump.fun database unavailable');}};
  const again=await h.panel.overview(adminId);
  assert.equal(Object.fromEntries(again.attention.map(item=>[item.code,item]))['failed-launches'].count,1,'an unavailable Pump.fun service never fails the overview');
  assert.equal(h.writes,0);assert.equal(h.kicks,0);
});
