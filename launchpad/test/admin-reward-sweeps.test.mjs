import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Keypair} from '@solana/web3.js';
import {Launchpad} from '../src/launchpad.mjs';
import {LaunchpadAdmin} from '../src/launchpad-admin.mjs';
import {AdminPanel} from '../src/admin-panel.mjs';
import {TelegramStore} from '../src/telegram-store.mjs';
import {newLaunchKeys} from '../src/launchpad-receipts.mjs';
import {activeRewardsFixture} from './helpers/rewards-wallet-fixture.mjs';

const ACTOR='a'.repeat(32),OWNER='b'.repeat(32),REQ='1'.repeat(32),NEXT='2'.repeat(32),NAME='admin-reward-sweeps';
const INVENTORY='The creator rewards token account cannot cover its saved credits.';
const address=()=>Keypair.generate().publicKey.toBase58();
const coin=(n=1)=>activeRewardsFixture({id:n.toString(16).padStart(32,'0'),createdAt:n,authorizedAt:10,feeCustody:'relay',curve:address(),
  keys:{...newLaunchKeys(),payer:newLaunchKeys().wallet},input:{route:'raydium',network:'mainnet-beta',name:`Coin ${n}`,symbol:`C${n}`,quoteMint:address(),feeMode:'holders',taxBps:300,recipient:''},
  review:{quoteSymbol:'TSLAx',quoteDecimals:8},state:'live',operations:[{state:'confirmed',signature:'launch-signature',kind:'create'}],
  credits:{quote:'123456789',base:'123450000'},gas:{reserved:'9000'},autoFees:true,feesRequested:false},100);

async function fixture(t,launches=[coin()]){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-reward-sweeps-')),hostStore=new TelegramStore(dir,randomBytes(32));
  const books=new Map([[OWNER,{launches}],[ACTOR,{launches:[]}]]),users=new Map([[ACTOR,{id:ACTOR,username:'operator',role:'admin',mfaEnabled:true,mainWallet:address()}],[OWNER,{id:OWNER,username:'creator',role:'user',mfaEnabled:true,mainWallet:address()}]]);
  let now=1000,kicks=0,scans=0;
  const accounts={dir,hostStore,get:async id=>structuredClone(users.get(id)),list:async()=>structuredClone([...users.values()]),storeFor:id=>({dir:join(dir,id),read:async()=>structuredClone(books.get(id)||{launches:[]}),write:async(_key,book)=>books.set(id,structuredClone(book))})};
  const launchpad=new Launchpad(accounts,null);launchpad.kick=()=>{kicks++;};
  const launchAdmin=new LaunchpadAdmin({accounts,launchpad,now:()=>now}),inventory=launchAdmin.inventory.bind(launchAdmin);
  launchAdmin.inventory=async(...args)=>{scans++;return inventory(...args);};
  const panels=[],create=()=>{const panel=new AdminPanel({accounts,launchpad,launchAdmin,now:()=>now});panel.rewardSweeps.kick=()=>{};panels.push(panel);return panel;};
  const panel=create();t.after(async()=>{await Promise.all(panels.map(p=>p.close()));await launchpad.close();await rm(dir,{recursive:true,force:true});});
  return{accounts,launchpad,launchAdmin,panel,books,users,create,get kicks(){return kicks;},get scans(){return scans;},advance(ms=15000){now+=ms;},saved(n=0){return books.get(OWNER).launches[n];},async run(){await panel.distributeAllRewardSweeps(ACTOR,{requestId:REQ});await panel.rewardSweeps.process();await panel.rewardSweeps.process();},async job(){return(await panel.readRewardSweeps(ACTOR)).job;}};
}

test('bulk persists before discovery, discovers hidden base-only and eight-decimal rewards, and exposes no signing data',async t=>{
  const baseOnly=coin(2);baseOnly.credits.quote='0';baseOnly.archivedAt=100;baseOnly.visibility={hidden:true};
  const unsupported=coin(3);unsupported.input.route='meteora';unsupported.id='12345678-1234-4234-8234-123456789abc';
  const h=await fixture(t,[coin(),baseOnly,unsupported]);
  const initial=await h.panel.distributeAllRewardSweeps(ACTOR,{requestId:REQ,ids:['untrusted']});
  assert.equal(initial.job.state,'queued');assert.equal(h.scans,0);assert.equal(h.kicks,0);
  const restored=h.create();await restored.rewardSweeps.process();await restored.rewardSweeps.process();
  const job=await h.job();assert.equal(job.items.length,3);assert.equal(job.counts.queued,2);assert.equal(job.counts.skipped,1);assert.match(job.items[2].reason,/route/);
  assert.equal(job.items[0].quoteSymbol,'TSLAx');assert.equal(job.items[0].quoteDecimals,8);assert.equal(job.items[0].remainingQuoteUnits,'123456789');
  assert.equal(job.items[1].remainingBaseUnits,'123450000');assert.equal(job.items[1].remainingQuoteUnits,'0');assert.equal(h.kicks,2);
  assert(!JSON.stringify(job).includes(h.saved().keys.wallet.secret));assert(!JSON.stringify(job).includes('launch-signature'));
});

test('same and concurrent request IDs coalesce; terminal replay cannot create a second child',async t=>{
  const h=await fixture(t),results=await Promise.all([h.panel.distributeAllRewardSweeps(ACTOR,{requestId:REQ}),h.panel.distributeAllRewardSweeps(ACTOR,{requestId:NEXT})]);
  assert.equal(results.filter(x=>!x.alreadyRequested).length,1);const parent=results[0].job.requestId;
  await h.panel.rewardSweeps.process();await h.panel.rewardSweeps.process();assert.equal(h.kicks,1);
  Object.assign(h.saved().manualHolderDistribution,{state:'completed',remainingBaseUnits:'0',remainingTaxBaseUnits:'0',remainingQuoteUnits:'0',distributedQuoteUnits:'123456789'});
  h.advance();await h.create().rewardSweeps.process();assert.equal((await h.job()).state,'completed');
  for(const requestId of [REQ,NEXT]){const replay=await h.panel.distributeAllRewardSweeps(ACTOR,{requestId});assert.equal(replay.alreadyRequested,true);assert.equal(replay.job.requestId,parent);assert.equal(replay.job.items[0].distributedQuoteUnits,'123456789');}
  assert.equal(h.kicks,1);assert.equal(h.saved().adminRewardHistory.length,1);
});

test('crash before child queue recovers the persisted deterministic identity',async t=>{
  const h=await fixture(t);await h.panel.distributeAllRewardSweeps(ACTOR,{requestId:REQ});await h.panel.rewardSweeps.process();
  const stored=await h.accounts.hostStore.read(`${NAME}-${REQ}`),child=stored.items[0].requestId;
  Object.assign(stored.items[0],{attempted:true,state:'processing'});await h.accounts.hostStore.write(`${NAME}-${REQ}`,stored);
  await h.create().rewardSweeps.process();assert.equal(h.saved().manualHolderDistribution.requestId,child);assert.equal(h.kicks,1);
});

test('lost coalesced response and restart recover the actual existing manual request from its durable audit',async t=>{
  const h=await fixture(t),original='e'.repeat(32);
  await h.panel.launchAction(ACTOR,{accountId:OWNER,id:h.saved().id,action:'distribute',requestId:original});
  const action=h.panel.launchAction.bind(h.panel);h.panel.launchAction=async(...args)=>{await action(...args);throw Error('Lost response from https://secret.example/key');};
  await h.run();let job=await h.job();assert.equal(job.items[0].manualRequestId,original);assert.equal(h.kicks,2);
  const stored=await h.accounts.hostStore.read(`${NAME}-${REQ}`);delete stored.items[0].manualRequestId;await h.accounts.hostStore.write(`${NAME}-${REQ}`,stored);
  h.advance();await h.create().rewardSweeps.process();job=await h.job();assert.equal(job.items[0].manualRequestId,original);assert.equal(h.kicks,2);
  assert.equal(h.saved().adminRewardHistory[1].coalescedRequestId,original);assert.equal(h.saved().manualHolderDistribution.requestId,original);
});

test('a separate active held-SOL parent never blocks the new full sweep and pending payouts remain exact',async t=>{
  const l=coin();l.heldSolDistribution={state:'processing',requestId:'d'.repeat(32)};l.cycle={stage:'payout',index:2,payouts:[{owner:address(),amount:'111'}],heldSolDistributionRequest:l.heldSolDistribution.requestId};
  l.operations.push({kind:'payout',state:'pending',signature:'saved-signature',raw:'EXACT_SIGNED_BYTES',amount:'111'});
  const before=structuredClone(l),h=await fixture(t,[l]);
  const old={version:1,latest:'f'.repeat(32),requests:{}};await h.accounts.hostStore.write('admin-holder-distributions',old);
  await h.run();assert.equal(h.kicks,1);assert.equal(h.saved().manualHolderDistribution.phase,'existing');
  for(const field of ['heldSolDistribution','cycle','credits','operations'])assert.deepEqual(h.saved()[field],before[field]);
  assert.deepEqual(await h.accounts.hostStore.read('admin-holder-distributions'),old);assert.match((await h.job()).items[0].reason,/saved transaction/);
});

test('unknown error is terminal with the precise sanitized reason and unchanged earned balances',async t=>{
  const l=coin();l.state='paused';l.error='Model inventory inconsistency at https://provider.example/private-key';const before=structuredClone(l),h=await fixture(t,[l]);
  await h.run();const job=await h.job();assert.equal(job.state,'completed');assert.equal(job.items[0].state,'blocked');
  assert.equal(job.items[0].reason,'Model inventory inconsistency at [provider]');assert.equal(job.items[0].remainingBaseUnits,'123450000');assert.equal(job.items[0].remainingQuoteUnits,'123456789');
  assert.equal(h.kicks,0);assert.deepEqual(h.saved(),before);
});

test('known inventory pauses wait without queueing, then recover or stop waiting after two minutes',async t=>{
  for(const recovers of [true,false]){
    const l=coin();l.state='paused';l.error=INVENTORY;const h=await fixture(t,[l]);await h.run();
    assert.equal((await h.job()).items[0].state,'waiting');assert.equal(h.kicks,0);
    if(recovers){h.saved().state='live';h.saved().error='';h.advance();await h.create().rewardSweeps.process();assert.equal(h.kicks,1);assert.equal((await h.job()).items[0].state,'queued');}
    else{h.advance(120000);await h.create().rewardSweeps.process();const job=await h.job();assert.equal(job.state,'completed');assert.equal(job.items[0].state,'blocked');assert.equal(job.items[0].reason,INVENTORY);assert.equal(h.kicks,0);}
  }
});

test('explicit pause and unsafe connected custody are never bypassed by inventory waiting or a bulk child',async t=>{
  const paused=coin(),external=coin(2);paused.state='paused';paused.autoFees=false;paused.feeAutomation={enabled:false,source:'admin'};paused.error=INVENTORY;external.keys.wallet.external=true;
  const before=structuredClone([paused,external]),h=await fixture(t,[paused,external]);await h.run();
  assert.equal(h.kicks,0);const job=await h.job();assert.equal(job.counts.blocked,2);assert.equal(job.items[0].reason,INVENTORY);assert.match(job.items[1].reason,/connected wallet/);assert.deepEqual(h.books.get(OWNER).launches,before);
});

test('no eligible holders remains partial with reserved quote and base displayed independently',async t=>{
  const h=await fixture(t);await h.run();Object.assign(h.saved().manualHolderDistribution,{state:'completed',phase:'done',remainingTaxBaseUnits:'100',remainingBaseUnits:'200',remainingQuoteUnits:'123456789',distributedQuoteUnits:'0',reason:'No eligible holders were found. The remaining quote rewards stay reserved.'});
  h.advance();await h.panel.rewardSweeps.process();const job=await h.job();assert.equal(job.state,'completed');assert.equal(job.items[0].state,'partial');assert.equal(job.items[0].remainingBaseUnits,'300');assert.equal(job.items[0].remainingQuoteUnits,'123456789');assert.equal(job.items[0].distributedQuoteUnits,'0');assert.match(job.items[0].reason,/No eligible holders/);
});

test('configured burn-only snapshot reports the actual remaining credit rather than a zero sale budget',async t=>{
  const h=await fixture(t);await h.run();Object.assign(h.saved().manualHolderDistribution,{state:'completed',phase:'done',remainingTaxBaseUnits:'0',remainingBaseUnits:'0',reservedForBurnBaseUnits:'123450000',remainingQuoteUnits:'0',distributedQuoteUnits:'123456789'});
  h.saved().credits.base='23450000';h.advance();await h.panel.rewardSweeps.process();
  const item=(await h.job()).items[0];assert.equal(item.state,'partial');assert.equal(item.remainingBaseUnits,'23450000');assert.match(item.reason,/configured LAUNCHPAD tax-burn policy/);assert.match(item.reason,/did not sell/);
});

test('MFA authorization before publish and administrator revocation before each child prevent new intent',async t=>{
  const h=await fixture(t,[coin(),coin(2)]);let calls=0;
  await assert.rejects(h.panel.distributeAllRewardSweeps(ACTOR,{requestId:REQ},{authorize:async()=>{if(++calls===3)throw Error('Session revoked');}}),/Session revoked/);
  assert.equal(await h.job(),null);assert.equal(h.kicks,0);
  await h.panel.distributeAllRewardSweeps(ACTOR,{requestId:REQ});await h.panel.rewardSweeps.process();h.users.get(ACTOR).role='user';await h.panel.rewardSweeps.process();h.users.get(ACTOR).role='admin';
  assert.equal((await h.job()).counts.skipped,2);assert.equal(h.kicks,0);
});

test('inventory capacity blocks the entire run without silently truncating targets',async t=>{
  const h=await fixture(t,[coin(),coin(2)]);h.panel.rewardSweeps.maxTargets=1;await h.panel.distributeAllRewardSweeps(ACTOR,{requestId:REQ});await h.panel.rewardSweeps.process();
  const job=await h.job();assert.equal(job.state,'blocked');assert.equal(job.discovered,false);assert.match(job.reason,/not truncated/);assert.equal(h.kicks,0);
});
