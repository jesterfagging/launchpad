import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { MeteoraService, verifyMeteoraWalletTransaction } from '../src/meteora-service.mjs';
import { publicRewardAnalytics } from '../src/public-reward-analytics.mjs';
import { VanityMintPool } from '../src/vanity-pool.mjs';
import { generateWallet } from '../src/pump-classic/service.mjs';
import { base58Decode } from '../src/pump-classic/codec.mjs';

const program=Keypair.generate().publicKey, quote='So11111111111111111111111111111111111111112';

test('Meteora reward counters reveal missing retained receipts without inventing payouts or recipients',async()=>{
  const now=1790000000000,mint=Keypair.generate().publicKey.toBase58(),owner=Keypair.generate().publicKey.toBase58(),other=Keypair.generate().publicKey.toBase58();
  const create={mint,id:'create',action:'initialize',state:'finalized',signature:bs58.encode(Buffer.alloc(64,1)),result:{slot:1},finalizedAt:now-1000};
  const paid={mint,id:'paid',action:'payout',state:'finalized',signature:bs58.encode(Buffer.alloc(64,2)),result:{slot:2,payout:{quoteDebitRaw:'1000000000'}},payouts:[{owner,amount:'1000000000'}],finalizedAt:now};
  const base={launches:[{mint,status:'trading',finalizedAt:now-1000,feeMode:'holders',quoteMint:quote,quoteDecimals:9,quoteSymbol:'SOL',ledger:{creatorPaid:'1000000000'},rewards:{totalPayments:1,paidWallets:[owner]}}],operations:[create,paid]};
  const read=async data=>{const before=structuredClone(data),facts=await MeteoraService.prototype.analyticsRewardRecords.call({load:async()=>data,now:()=>now});assert.deepEqual(data,before);return publicRewardAnalytics(facts,{now,pricesByMint:new Map([[quote,{usd:100,at:now}]])}).holders;};
  const complete=await read(base);assert.equal(complete.distributed.usdEstimate,100);assert.equal(complete.uniqueWallets,1);
  const duplicate=structuredClone(base);duplicate.operations.push(structuredClone(paid));assert.equal((await read(duplicate)).distributed.usdEstimate,100);
  for(const change of [d=>d.launches[0].ledger.creatorPaid='2000000000',d=>d.launches[0].ledger.creatorPaid='invalid',d=>d.launches[0].rewards.totalPayments=2,d=>d.launches[0].rewards.paidWallets.push(other),d=>d.historyTruncated=true,d=>d.launches[0].operationsTruncated=true]){
    const data=structuredClone(base);change(data);const partial=await read(data);assert.equal(partial.distributed.usdEstimate,null);assert.equal(partial.distributed.observedUsdEstimate,100);assert.equal(partial.uniqueWallets,null);assert.equal(partial.observedUniqueWallets,1);
  }
  const missing=structuredClone(base);missing.operations=[create];const out=await read(missing);assert.equal(out.distributed.usdEstimate,null);assert.equal(out.distributed.observedUsdEstimate,null);assert.equal(out.distributed.quoteTotals[0].amount,null);assert.equal(out.uniqueWallets,null);assert.equal(out.observedUniqueWallets,null);
});
const record=key=>({address:key.publicKey.toBase58(),secretBase64:Buffer.from(key.secretKey).toString('base64')});
function bundle(payer,additional=[],action='configure'){
  const instruction=new TransactionInstruction({programId:program,keys:[payer,...additional].map(key=>({pubkey:new PublicKey(key),isSigner:true,isWritable:true})),data:Buffer.from([1])});
  const tx=new VersionedTransaction(new TransactionMessage({payerKey:new PublicKey(payer),recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:[instruction]}).compileToV0Message());
  return {action,unsignedTransaction:Buffer.from(tx.serialize()).toString('base64'),lastValidBlockHeight:100,requiredSigners:tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures).map(key=>key.toBase58()),review:{maxWalletDebitLamports:'1000000',totalLaunchMaxDebitLamports:'2000000'}};
}
function sign(b,key){const tx=VersionedTransaction.deserialize(Buffer.from(b.unsignedTransaction,'base64'));tx.sign([key]);return Buffer.from(tx.serialize()).toString('base64');}
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-meteora-service-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const user=Keypair.generate(),authority=Keypair.generate(),treasury=Keypair.generate(),destination=Keypair.generate();let now=1_790_000_000_000,receipt={state:'pending'},state={phase:'trading',partnerFeesPending:'0',creatorFeesPending:'0'};
  let db={schemaVersion:1,config:{authority:authority.publicKey.toBase58(),treasury:treasury.publicKey.toBase58(),migrationFeePercentage:0},authority:record(authority),launches:[],operations:[],enabled:true,cursor:0};
  const observed={prepares:0,sends:0,wire:[],savedBeforeSend:[],payouts:0};
  const accounts={dir,get:async id=>({id,role:'admin',mfaEnabled:true}),list:async()=>[],hostStore:{read:async()=>structuredClone(db),write:async(_key,value)=>{db=structuredClone(value);}}};
  const adapter={
    readiness:async()=>({ready:true,blockers:[]}),
    prepareLaunch:async({wallet,launch})=>{observed.prepares++;return launch.configSignature?bundle(wallet,[launch.mint,launch.creatorAuthority],'initialize'):bundle(wallet,[launch.configAddress],'configure');},
    prepareTrade:async({wallet})=>bundle(wallet,[],'buy'),
    prepareCreatorClaim:async({wallet,launch})=>bundle(wallet,[launch.creatorAuthority],'creator-claim'),
    preparePartnerClaim:async({wallet})=>bundle(wallet,[],'partner-claim'),
    prepareMigration:async({wallet,launch})=>bundle(wallet,launch.migrationPositionMints,'migrate'),
    preparePayout:async({wallet,source})=>{observed.payouts++;return bundle(wallet,[source],'payout');},
    holderSnapshot:async()=>({complete:true,slot:50,rows:[{owner:destination.publicKey.toBase58(),amount:'100'}]}),
    state:async()=>structuredClone(state),
    send:async wire=>{observed.sends++;observed.wire.push(wire);observed.savedBeforeSend.push(db.operations.some(op=>op.signedTransaction===wire&&op.state==='journaled'));throw Error('Ambiguous RPC timeout');},
    reconcile:async()=>structuredClone(receipt),
    wallet:async()=>({balanceRaw:'10'}),marketSnapshot:async()=>null
  };
  const session={account:{id:'alice'},walletVerified:true,walletAddress:user.publicKey.toBase58()},context={sessionToken:'alice-session',authorize:async()=>session};
  const args={accounts,adapter,requireOwner:async()=>{},getQuotePrice:async mint=>({mint,usd:'100',at:now}),getTreasury:async()=>treasury.publicKey.toBase58(),getCreationFee:async()=>({lamports:'15000000',recipient:treasury.publicKey.toBase58()}),publishMetadata:async()=> 'https://example.test/metadata.json',quoteEligibility:async mint=>({mint,symbol:'SOL',decimals:9,launchReady:true}),listPairs:async()=>[{mint:quote,launchReady:true}],pairReadiness:async()=>({complete:true}),now:()=>now};
  const service=new MeteoraService(args);service.closed=true;
  const input={action:'initialize',expectedWallet:user.publicKey.toBase58(),quoteMint:quote,name:'Meteora Test',symbol:'MT',feeMode:'creator'};
  const f={service,args,adapter,session,context,input,user,authority,destination,observed,read:()=>structuredClone(db),change:fn=>{fn(db);},advance:(ms=120001)=>{now+=ms;},receipt:r=>{receipt=r;},state:s=>{state=s;}};
  f.launch=async(mode='creator')=>{let prepared=await service.prepare(session,{...input,feeMode:mode},context);await service.submit(session,{operationId:prepared.operation.id,signedTransaction:sign(db.operations.at(-1).bundle,user)},context);receipt={state:'finalized',slot:10};await service.reconcile(session,{operationId:prepared.operation.id},context);prepared=await service.prepare(session,{action:'initialize',expectedWallet:user.publicKey.toBase58(),mint:prepared.launch.mint},context);await service.submit(session,{operationId:prepared.operation.id,signedTransaction:sign(db.operations.at(-1).bundle,user)},context);receipt={state:'finalized',slot:11,phase:'trading',poolId:Keypair.generate().publicKey.toBase58()};await service.reconcile(session,{operationId:prepared.operation.id},context);receipt={state:'pending'};return db.launches[0].mint;};
  return f;
}

test('wallet proof rejects mutated message, missing proof and injected managed signatures',()=>{
  const user=Keypair.generate(),server=Keypair.generate(),b=bundle(user.publicKey.toBase58(),[server.publicKey.toBase58()]),wire=sign(b,user);
  assert.doesNotThrow(()=>verifyMeteoraWalletTransaction(wire,b,user.publicKey.toBase58()));
  assert.throws(()=>verifyMeteoraWalletTransaction(b.unsignedTransaction,b,user.publicKey.toBase58()),/did not sign/);
  const changed=VersionedTransaction.deserialize(Buffer.from(wire,'base64'));changed.message.compiledInstructions[0].data[0]=255;changed.sign([user]);assert.throws(()=>verifyMeteoraWalletTransaction(Buffer.from(changed.serialize()).toString('base64'),b,user.publicKey.toBase58()),/changed/);
  const injected=VersionedTransaction.deserialize(Buffer.from(wire,'base64'));injected.sign([server]);assert.throws(()=>verifyMeteoraWalletTransaction(Buffer.from(injected.serialize()).toString('base64'),b,user.publicKey.toBase58()),/changed/);
});
test('launch rejects user-controlled treasury, prices and taxes and stale server prices',async t=>{
  const f=await fixture(t);for(const extra of [{treasury:f.destination.publicKey.toBase58()},{quoteUsd:'1'},{taxBps:300}])await assert.rejects(f.service.prepare(f.session,{...f.input,...extra},f.context),/Unsupported/);
  f.service.getQuotePrice=async()=>({mint:quote,usd:100,at:1});await assert.rejects(f.service.prepare(f.session,f.input,f.context),/fresh quote/);assert.equal(f.observed.prepares,0);
});
test('simultaneous public readiness checks coalesce and expire without caching protected launch checks',async t=>{
  const f=await fixture(t);let calls=0,release;const held=new Promise(resolve=>{release=resolve;});
  f.adapter.readiness=async()=>{calls++;await held;return {ready:true,blockers:[]};};
  const visitors=Array.from({length:50},()=>f.service.publicStatus());
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);release();
  const results=await Promise.all(visitors);assert(results.every(row=>row.available));
  results[0].blockers.push('caller mutation');assert.equal((await f.service.publicStatus()).blockers.length,0);assert.equal(calls,1);
  await f.service.readiness(f.read());assert.equal(calls,2);
  f.advance(5001);await f.service.publicStatus();assert.equal(calls,3);
  f.change(data=>{data.config.treasury=f.destination.publicKey.toBase58();});
  assert.equal((await f.service.publicStatus()).available,false);assert.equal(calls,3);
});
test('failed public readiness snapshots retry quickly and never authorize a launch',async t=>{
  const f=await fixture(t);let calls=0;
  f.adapter.readiness=async()=>{calls++;return {ready:false,blockers:['Gas check pending']};};
  assert.equal((await f.service.publicStatus()).available,false);await f.service.publicStatus();assert.equal(calls,1);
  await assert.rejects(f.service.prepare(f.session,f.input,f.context),/Gas check pending/);assert.equal(calls,2);
  f.advance(1001);await f.service.publicStatus();assert.equal(calls,3);assert.equal(f.observed.prepares,0);
});
test('pair verification saturation stays retryable and creates no launch or operation',async t=>{
  const f=await fixture(t);f.service.quoteEligibility=async()=>({mint:quote,launchReady:false,code:'verification_busy',retryable:true,supportReason:'Pair verification is busy.'});
  await assert.rejects(f.service.prepare(f.session,f.input,f.context),error=>error.statusCode===503&&error.retryable===true&&error.retryAfter===2&&error.code==='verification_busy');
  assert.equal(f.read().launches.length,0);assert.equal(f.read().operations.length,0);assert.equal(f.observed.prepares,0);
});
test('a new Meteora launch holds a vanity address until its first transaction is signed; a failed preparation gives it back',async t=>{
  const f=await fixture(t),docs=new Map(),keys=[generateWallet(),generateWallet()];
  const pool=new VanityMintPool({accounts:f.args.accounts,now:f.args.now,store:{read:async(key,fallback)=>docs.has(key)?structuredClone(docs.get(key)):fallback,write:async(key,value)=>{docs.set(key,structuredClone(value));}}});
  await pool.importKeys({actorId:'admin',entries:[{name:'keys',text:keys.map(k=>k.secret).join('\n')}]});
  f.service.vanity=pool;
  const prepareLaunch=f.adapter.prepareLaunch;f.adapter.prepareLaunch=async()=>{throw Error('RPC unavailable');};
  await assert.rejects(f.service.prepare(f.session,f.input,f.context),/RPC unavailable/);
  assert.equal((await pool.view('admin')).counts.available,2,'a preparation that failed after leasing gives the address back');assert.equal(f.read().launches.length,0);
  f.adapter.prepareLaunch=prepareLaunch;
  const prepared=await f.service.prepare(f.session,f.input,f.context);
  assert.equal(prepared.launch.mint,keys[0].address);
  const saved=f.read().launches[0];assert.equal(saved.keys.mint.address,keys[0].address);assert.deepEqual(saved.vanity,{address:keys[0].address,committed:false,heldAt:f.args.now()});
  assert.equal(Buffer.from(saved.keys.mint.secretBase64,'base64').equals(base58Decode(keys[0].secret)),true,'the launch keeps the vanity key to sign the coin\u2019s creation');
  let view=await pool.view('admin');assert.deepEqual([view.counts.available,view.counts.reserved,view.used.length],[1,1,0],'the draft holds its address until it signs');
  await f.service.submit(f.session,{operationId:prepared.operation.id,signedTransaction:sign(f.read().operations.at(-1).bundle,f.user)},f.context);
  view=await pool.view('admin');assert.deepEqual(view.used.map(r=>[r.address,r.venue,r.symbol]),[[keys[0].address,'meteora','MT']],'used once the first transaction is signed');
  assert.equal(f.read().launches[0].vanity.committed,true);
});

test('a Meteora draft that never signed loses its vanity address after its lease; resuming it then asks for a new launch',async t=>{
  const f=await fixture(t),docs=new Map(),key=generateWallet();
  const pool=new VanityMintPool({accounts:f.args.accounts,now:f.args.now,store:{read:async(k,fallback)=>docs.has(k)?structuredClone(docs.get(k)):fallback,write:async(k,value)=>{docs.set(k,structuredClone(value));}}});
  await pool.importKeys({actorId:'admin',entries:[{name:'keys',text:key.secret}]});f.service.vanity=pool;
  const prepared=await f.service.prepare(f.session,f.input,f.context);assert.equal(prepared.launch.mint,key.address);
  await f.service.cancel(f.session,{operationId:prepared.operation.id},f.context);
  f.advance(61*60000);assert.equal((await pool.view('admin')).counts.available,1,'the lease lapsed');
  assert.equal((await pool.reserve({venue:'raydium',ref:'review-elsewhere'})).address,key.address,'another launch takes it');
  await assert.rejects(f.service.prepare(f.session,{action:'initialize',expectedWallet:f.user.publicKey.toBase58(),mint:prepared.launch.mint},f.context),/no longer available/);
});

test('configuration finalizes before initialization and continuation survives reopening',async t=>{
  const f=await fixture(t),prepared=await f.service.prepare(f.session,f.input,f.context);assert.equal(prepared.operation.action,'configure');
  await f.service.submit(f.session,{operationId:prepared.operation.id,signedTransaction:sign(f.read().operations[0].bundle,f.user)},f.context);f.receipt({state:'finalized',slot:12});const finalized=await f.service.reconcile(f.session,{operationId:prepared.operation.id},f.context);assert.equal(finalized.nextAction,'initialize');
  assert.equal((await f.service.operations(f.session,f.context)).operations[0].nextAction,'initialize');
  const next=await f.service.prepare(f.session,{action:'initialize',expectedWallet:f.user.publicKey.toBase58(),mint:prepared.launch.mint},f.context);assert.equal(next.operation.action,'initialize');assert.equal(next.operation.review.configurationCreated,true);
  await f.service.cancel(f.session,{operationId:next.operation.id},f.context);const resumed=await f.service.prepare(f.session,{action:'initialize',expectedWallet:f.user.publicKey.toBase58(),mint:prepared.launch.mint},f.context);assert.equal(resumed.operation.action,'initialize');assert.equal(f.read().launches.length,1);
});
test('cross-account/session and changed-wallet submissions fail before signing',async t=>{
  const f=await fixture(t),prepared=await f.service.prepare(f.session,f.input,f.context),input={operationId:prepared.operation.id,signedTransaction:sign(f.read().operations[0].bundle,f.user)};
  const bob={...f.session,account:{id:'bob'}};await assert.rejects(f.service.submit(bob,input,{sessionToken:'bob',authorize:async()=>bob}),/another session/);
  const changed={...f.session,walletAddress:f.destination.publicKey.toBase58()};await assert.rejects(f.service.submit(changed,input,{...f.context,authorize:async()=>changed}),/wallet/);assert.equal(f.observed.sends,0);
});
test('ambiguous broadcast is journaled first and retries preserve exact signed bytes',async t=>{
  const f=await fixture(t),prepared=await f.service.prepare(f.session,f.input,f.context),input={operationId:prepared.operation.id,signedTransaction:sign(f.read().operations[0].bundle,f.user)};
  const first=await f.service.submit(f.session,input,f.context);assert.equal(first.operation.state,'pending');assert.deepEqual(f.observed.savedBeforeSend,[true]);
  const wire=f.read().operations[0].signedTransaction;assert.ok(VersionedTransaction.deserialize(Buffer.from(wire,'base64')).signatures.every(sig=>sig.some(Boolean)));
  const restarted=new MeteoraService(f.args);restarted.closed=true;await restarted.submit(f.session,input,f.context);assert.equal(f.observed.sends,1);assert.equal(f.read().operations[0].signedTransaction,wire);
  await assert.rejects(restarted.cancel(f.session,{operationId:first.operation.id},f.context),/must be reconciled/);
});
test('signature expiry and owner revocation prevent server signing',async t=>{
  const f=await fixture(t);f.change(db=>{db.enabled=false;});let owner=true;f.service.requireOwner=async()=>{if(!owner)throw Error('Owner revoked');};const p=await f.service.prepare(f.session,f.input,f.context),input={operationId:p.operation.id,signedTransaction:sign(f.read().operations[0].bundle,f.user)};owner=false;await assert.rejects(f.service.submit(f.session,input,f.context),/Owner revoked/);owner=true;f.advance();await assert.rejects(f.service.submit(f.session,input,f.context),/expired/);assert.equal(f.observed.sends,0);
});
test('public activation requires full quote scan and concrete adapter lifecycle readiness',async t=>{
  const f=await fixture(t);f.service.pairReadiness=async()=>({complete:false});await assert.rejects(f.service.setEnabled(f.session,{enabled:true},f.context),/full Meteora quote/);f.service.pairReadiness=async()=>({complete:true});f.adapter.readiness=async()=>({ready:false,blockers:['Missing migration gas']});await assert.rejects(f.service.setEnabled(f.session,{enabled:true},f.context),/Missing migration gas/);
});
test('creator fee redirect is original-creator-only and single-use without profile reassignment',async t=>{
  const f=await fixture(t),mint=await f.launch();const result=await f.service.rerouteCreator(f.session,{mint,recipient:f.destination.publicKey.toBase58()},f.context);assert.equal(result.launch.creatorId,'alice');assert.equal(result.launch.creatorWallet,f.user.publicKey.toBase58());assert.equal(result.launch.creatorRecipient,f.destination.publicKey.toBase58());assert.equal(result.launch.feeRedirect.used,true);
  await assert.rejects(f.service.rerouteCreator(f.session,{mint,recipient:Keypair.generate().publicKey.toBase58()},f.context),/already been redirected/);
  const recipient={account:{id:'recipient'},walletVerified:true,walletAddress:f.destination.publicKey.toBase58()};assert.equal((await f.service.listAccount(recipient)).length,1);await assert.rejects(f.service.rerouteCreator(recipient,{mint,recipient:f.user.publicKey.toBase58()},{sessionToken:'recipient',authorize:async()=>recipient}),/original creator/);
});
test('verified fee receipt credits exactly once and unrelated wallet balances never count',async t=>{
  const f=await fixture(t),mint=await f.launch('holders');f.service.getQuotePrice=async()=>({mint:quote,usd:'100000000',at:f.args.now()});f.service.closed=false;f.state({phase:'trading',creatorFeesPending:'90',partnerFeesPending:'0'});await f.service.processLaunch(mint);f.service.closed=true;const op=f.read().operations.at(-1);assert.equal(op.action,'creator-claim');
  f.receipt({state:'finalized',slot:14,fees:{creatorQuoteRaw:'90'}});await f.service.receipt(op);await f.service.receipt(op);assert.equal(f.read().launches[0].ledger.creatorCredit,'90');assert.equal(f.read().launches[0].ledger.creatorClaimed,'90');
  f.change(db=>{db.launches[0].lastCreatorClaimAt=0;});f.service.closed=false;await f.service.processLaunch(mint);f.service.closed=true;const invalid=f.read().operations.at(-1);f.receipt({state:'finalized',slot:15,fees:{}});await assert.rejects(f.service.receipt(invalid),/fee credit/);assert.equal(f.read().launches[0].ledger.creatorCredit,'90');
});
test('holder payout ledger rejects changed recipient or amount and settles once from finalized receipt',async t=>{
  const f=await fixture(t),mint=await f.launch('holders'),owner=f.destination.publicKey.toBase58();f.change(db=>{const l=db.launches[0];l.ledger.creatorCredit='150';l.rewards.cycle={id:'cycle',index:0,payouts:[{owner,amount:'100'}],slot:12};});f.service.closed=false;await f.service.processLaunch(mint);f.service.closed=true;const op=f.read().operations.at(-1);assert.equal(op.action,'payout');
  f.receipt({state:'finalized',slot:20,payout:{quoteDebitRaw:'100',recipients:[{owner:f.user.publicKey.toBase58(),amount:'100'}]}});await assert.rejects(f.service.receipt(op),/differs/);assert.equal(f.read().launches[0].ledger.creatorCredit,'150');
  f.receipt({state:'finalized',slot:20,payout:{quoteDebitRaw:'100',recipients:[{owner,amount:'100'}]}});await f.service.receipt(op);await f.service.receipt(op);const l=f.read().launches[0];assert.equal(l.ledger.creatorCredit,'50');assert.equal(l.ledger.creatorPaid,'100');assert.equal(l.rewards.totalPayments,1);assert.equal(l.rewards.cycle,undefined);assert.equal((await f.service.analyticsRewardRecords())[0].operations.filter(o=>o.kind==='payout').length,1);
});
test('migration requires finalized locked LP proof and managed stable NFT keys survive retry',async t=>{
  const f=await fixture(t),mint=await f.launch();f.state({phase:'bonded'});f.service.closed=false;await f.service.processLaunch(mint);f.service.closed=true;const op=f.read().operations.at(-1);assert.equal(op.action,'migrate');assert.equal(op.bundle.requiredSigners.length,3);assert.ok(op.bundle.requiredSigners.includes(f.authority.publicKey.toBase58()));
  f.receipt({state:'finalized',slot:30,phase:'migrated',poolId:Keypair.generate().publicKey.toBase58(),lpLocked:false});await assert.rejects(f.service.receipt(op),/locked migration/);assert.equal(f.read().launches[0].status,'trading');
  f.receipt({state:'finalized',slot:30,phase:'migrated',poolId:Keypair.generate().publicKey.toBase58(),lpLocked:true});await f.service.receipt(op);assert.equal(f.read().launches[0].status,'migrated');assert.equal(f.read().launches[0].migrationSignature,op.signature);
});
test('public projections retain holder summary and never include managed secrets or signed bytes',async t=>{
  const f=await fixture(t),mint=await f.launch('holders'),view=await f.service.publicDetail(mint);assert.equal(typeof view.holderRewards,'object');assert.equal(view.taxBps,undefined);assert.equal(view.transferTaxBps,0);
  const output=JSON.stringify({view,list:await f.service.publicList(),operations:await f.service.operations(f.session,f.context),rewards:await f.service.publicRewards(mint)});for(const l of f.read().launches)for(const key of Object.values(l.keys))assert.equal(output.includes(key.secretBase64),false);assert.equal(output.includes('signedTransaction'),false);
});
test('busy fees rotate fairly and credited creator earnings are paid before another claim',async t=>{
  const f=await fixture(t),mint=await f.launch();f.service.getQuotePrice=async()=>({mint:quote,usd:'100000000',at:f.args.now()});f.state({phase:'trading',partnerFeesPending:'100',creatorFeesPending:'50'});f.service.closed=false;
  for(const [index,action] of ['partner-claim','partner-payout','creator-claim','payout'].entries()){
    await f.service.processLaunch(mint);const op=f.read().operations.at(-1);assert.equal(op.action,action);
    f.receipt({state:'finalized',slot:20+index,...(action==='partner-claim'?{fees:{partnerQuoteRaw:'100'}}:action==='creator-claim'?{fees:{creatorQuoteRaw:'50'}}:{payout:{quoteDebitRaw:op.payouts[0].amount,recipients:op.payouts}})});await f.service.receipt(op);f.advance(75000);
  }
  const l=f.read().launches[0];assert.equal(l.ledger.partnerPaid,'100');assert.equal(l.ledger.partnerCredit,'0');assert.equal(l.ledger.creatorPaid,'50');f.service.closed=true;
});
test('mixed blocked holders retain exact debt after selling while ready holders receive their shares',async t=>{
  const f=await fixture(t),mint=await f.launch('holders'),owed=Keypair.generate().publicKey.toBase58(),ready=f.destination.publicKey.toBase58();
  f.change(db=>{const l=db.launches[0];l.ledger.creatorCredit='500';l.rewards.cycle={id:'mixed',index:0,slot:12,payouts:[{owner:owed,amount:'100'},{owner:ready,amount:'200'}]};});
  f.adapter.preparePayout=async({wallet,source,payouts})=>({...bundle(wallet,[source],'payout'),payout:{quoteDebitRaw:'200',recipients:[payouts[1]]},deferredPayouts:[{...payouts[0],reason:'rent'}]});
  f.service.closed=false;await f.service.processLaunch(mint);f.service.closed=true;let op=f.read().operations.at(-1);assert.deepEqual(op.payouts,[{owner:ready,amount:'200'}]);assert.equal(op.cycleCount,2);
  f.receipt({state:'finalized',slot:22,payout:{quoteDebitRaw:'200',recipients:op.payouts}});await f.service.receipt(op);let l=f.read().launches[0];assert.deepEqual(l.rewards.debts,[{owner:owed,amount:'100'}]);assert.equal(l.ledger.creatorCredit,'300');
  f.advance(3600001);f.adapter.holderSnapshot=async()=>{throw Error('An old debt must survive without resnapshotting');};f.service.closed=false;await f.service.processLaunch(mint);f.service.closed=true;l=f.read().launches[0];assert.deepEqual(l.rewards.cycle.payouts,[{owner:owed,amount:'100'}]);assert.deepEqual(l.rewards.debts,[]);assert.equal(l.ledger.creatorCredit,'300');
});
test('an entirely blocked batch advances without debit so subsequent holders are not paused',async t=>{
  const f=await fixture(t),mint=await f.launch('holders'),rows=Array.from({length:4},()=>({owner:Keypair.generate().publicKey.toBase58(),amount:'10'}));f.change(db=>{const l=db.launches[0];l.ledger.creatorCredit='40';l.rewards.cycle={id:'blocked',index:0,slot:12,payouts:rows};});
  f.adapter.preparePayout=async({payouts})=>({payout:{quoteDebitRaw:'0',recipients:[]},deferredPayouts:payouts});f.service.closed=false;const before=f.read().operations.length;await f.service.processLaunch(mint);f.service.closed=true;const l=f.read().launches[0];assert.equal(f.read().operations.length,before);assert.equal(l.rewards.cycle.index,3);assert.deepEqual(l.rewards.debts.map(x=>x.owner).sort(),rows.slice(0,3).map(x=>x.owner).sort());assert.equal(l.ledger.creatorCredit,'40');assert.equal(l.retry,null);
});
test('dust fees cannot spend managed gas, while manual claim goes directly to the verified recipient',async t=>{
  const f=await fixture(t),mint=await f.launch();f.state({phase:'trading',creatorFeesPending:'1',partnerFeesPending:'1'});f.service.closed=false;const before=f.read().operations.length;await f.service.processLaunch(mint);f.service.closed=true;assert.equal(f.read().operations.length,before);
  let receiver;f.adapter.prepareCreatorClaim=async args=>{receiver=args.receiver;return bundle(args.wallet,[args.launch.creatorAuthority],'creator-claim');};
  const prepared=await f.service.prepare(f.session,{action:'claim',expectedWallet:f.user.publicKey.toBase58(),mint},f.context);assert.equal(receiver,f.user.publicKey.toBase58());await f.service.submit(f.session,{operationId:prepared.operation.id,signedTransaction:sign(f.read().operations.at(-1).bundle,f.user)},f.context);f.receipt({state:'finalized',slot:30,fees:{creatorQuoteRaw:'1'}});await f.service.reconcile(f.session,{operationId:prepared.operation.id},f.context);assert.equal(f.read().launches[0].ledger.creatorPaid,'1');assert.equal(f.read().launches[0].ledger.creatorCredit,'0');
});
test('manual claim withdraws existing credited funds with the recipient paying transaction fees',async t=>{
  const f=await fixture(t),mint=await f.launch();f.change(db=>{db.launches[0].ledger.creatorCredit='123';});const prepared=await f.service.prepare(f.session,{action:'claim',expectedWallet:f.user.publicKey.toBase58(),mint},f.context);assert.equal(prepared.operation.action,'payout');const op=f.read().operations.at(-1);assert.equal(op.wallet,f.user.publicKey.toBase58());assert.deepEqual(op.payouts,[{owner:f.user.publicKey.toBase58(),amount:'123'}]);await f.service.submit(f.session,{operationId:op.id,signedTransaction:sign(op.bundle,f.user)},f.context);f.receipt({state:'finalized',slot:30,payout:{quoteDebitRaw:'123',recipients:op.payouts}});await f.service.reconcile(f.session,{operationId:op.id},f.context);assert.equal(f.read().launches[0].ledger.creatorPaid,'123');assert.equal(f.read().launches[0].ledger.creatorCredit,'0');
});
test('an unsigned third-party trade cannot hold migration hostage',async t=>{
  const f=await fixture(t),mint=await f.launch();f.change(db=>db.operations.push({id:'unsigned-trade',mint,ownerId:'other',wallet:f.destination.publicKey.toBase58(),action:'buy',state:'awaiting_signature',expiresAt:f.args.now()+120000}));f.state({phase:'bonded'});f.service.closed=false;await f.service.processLaunch(mint);f.service.closed=true;assert.equal(f.read().operations.at(-1).action,'migrate');
});
test('failed durable journal write never reaches the network sender',async t=>{
  const f=await fixture(t),prepared=await f.service.prepare(f.session,f.input,f.context),op=f.read().operations.at(-1);f.args.accounts.hostStore.write=async()=>{throw Error('Disk unavailable');};await assert.rejects(f.service.submit(f.session,{operationId:prepared.operation.id,signedTransaction:sign(op.bundle,f.user)},f.context),/Disk unavailable/);assert.equal(f.observed.sends,0);assert.equal(f.read().operations.at(-1).signedTransaction,undefined);
});
test('new launch readiness and creation fees must match the current verified protocol treasury',async t=>{
  const f=await fixture(t);f.service.getCreationFee=async()=>({lamports:'15000000',recipient:f.destination.publicKey.toBase58()});await assert.rejects(f.service.prepare(f.session,f.input,f.context),/creation fee recipient differs/);assert.equal(f.observed.prepares,0);
  f.service.getTreasury=async()=>f.destination.publicKey.toBase58();assert.equal((await f.service.readiness(f.read())).ready,false);await assert.rejects(f.service.setEnabled(f.session,{enabled:true},f.context),/saved Meteora treasury differs/);
});
test('future protocol payments use the configured treasury while historical launch terms remain unchanged',async t=>{
  const f=await fixture(t),mint=await f.launch(),original=f.read().launches[0].treasury;f.service.getTreasury=async()=>f.destination.publicKey.toBase58();let prepared;
  await f.service.automatic(mint,'partner-claim',async(_data,launch)=>{prepared=launch;return null;});assert.equal(prepared.treasury,f.destination.publicKey.toBase58());assert.equal(f.read().launches[0].treasury,original);
  f.change(db=>{db.launches[0].ledger.partnerCredit='7';});let calls=0;
  await assert.rejects(f.service.automatic(mint,'partner-payout',async()=>{calls++;},{payouts:[{owner:original,amount:'7'}]}),/current treasury/);assert.equal(calls,0);
});

test('manual protocol collection survives restart and pays treasury despite a stuck holder cycle and retry',async t=>{
  const f=await fixture(t),mint=await f.launch('holders');
  f.change(db=>{const l=db.launches[0];l.ledger.creatorCredit='101';l.ledger.partnerCredit='7';l.rewards.cycle={id:'holder',index:0,payouts:[{owner:f.user.publicKey.toBase58(),amount:'101'}]};l.retry={at:f.args.now()+3600000,attempt:4,reason:'Saved holder retry'};});
  const launch=f.read().launches[0],creatorBefore={credit:launch.ledger.creatorCredit,rewards:launch.rewards,retry:launch.retry},input={accountId:launch.creatorId,id:launch.id,mint,requestId:'a'.repeat(32)};
  f.service.getTreasury=async()=>f.destination.publicKey.toBase58();f.state({phase:'trading',partnerFeesPending:'123',creatorFeesPending:'999'});
  assert.equal((await f.service.collectProtocolFees('owner',input)).queued,true);assert.equal((await f.service.collectProtocolFees('owner',input)).alreadyRequested,true);
  const restarted=new MeteoraService({...f.args,getTreasury:f.service.getTreasury});restarted.closed=false;await restarted.processLaunch(mint);
  const claim=f.read().operations.at(-1);assert.equal(claim.action,'partner-claim');assert.equal(claim.protocolRequestId,input.requestId);const sent=f.observed.sends;await restarted.processLaunch(mint);assert.equal(f.observed.sends,sent);
  f.receipt({state:'finalized',slot:31,fees:{partnerQuoteRaw:'123'}});await restarted.receipt(claim);await restarted.receipt(claim);
  let payoutArgs;f.adapter.preparePayout=async args=>{payoutArgs=args;return bundle(args.wallet,[],'partner-payout');};
  await restarted.processLaunch(mint);const payout=f.read().operations.at(-1);assert.equal(payout.action,'partner-payout');assert.equal(payout.protocolRecipient,f.destination.publicKey.toBase58());assert.equal(payoutArgs.launch.treasury,payout.protocolRecipient);assert.deepEqual(payout.payouts,[{owner:payout.protocolRecipient,amount:'130'}]);assert(f.observed.savedBeforeSend.every(Boolean));
  // Changing settings after signing cannot rewrite the saved destination.
  restarted.getTreasury=async()=>Keypair.generate().publicKey.toBase58();f.receipt({state:'finalized',slot:32,payout:{quoteDebitRaw:'130',recipients:payout.payouts}});await restarted.receipt(payout);await restarted.receipt(payout);
  const after=f.read().launches[0];assert.equal(after.protocolCollection.status,'completed');assert.equal(after.ledger.partnerCredit,'0');assert.equal(after.ledger.partnerPaid,'130');assert.equal(after.treasury,launch.treasury);assert.deepEqual({credit:after.ledger.creatorCredit,rewards:after.rewards,retry:after.retry},creatorBefore);
  restarted.closed=true;assert.equal((await restarted.collectProtocolFees('owner',input)).alreadyRequested,true);
});

test('manual protocol inventory and queue wait for signed claims without exposing keys or touching reward requests',async t=>{
  const f=await fixture(t),mint=await f.launch('holders'),l=f.read().launches[0],input={accountId:l.creatorId,id:l.id,mint,requestId:'b'.repeat(32)};
  f.change(db=>{db.operations.push({id:'saved',mint,action:'payout',state:'pending',signature:'saved-signature'});db.launches[0].heldSolDistribution={status:'queued',requestId:'held',actorId:'owner'};});
  const prior=f.read().launches[0].heldSolDistribution,rows=await f.service.protocolInventoryRows('owner');assert.equal(rows.length,1);assert.equal(rows[0].route,'meteora');assert.equal(rows[0].eligibility.allowed,true);assert.equal(rows[0].waitingForOperation.signature,'saved-signature');assert(!JSON.stringify(rows).includes('secretBase64'));
  await f.service.collectProtocolFees('owner',input);const count=f.observed.sends;f.service.closed=false;await f.service.processLaunch(mint);f.service.closed=true;assert.equal(f.observed.sends,count);assert.equal(f.read().operations.at(-1).signature,'saved-signature');assert.deepEqual(f.read().launches[0].heldSolDistribution,prior);
  await assert.rejects(f.service.collectProtocolFees('other',input),/another administrator/);
});

test('manual protocol preparation rechecks administrator and treasury before signing',async t=>{
  for(const change of ['administrator','treasury']){
    const f=await fixture(t),mint=await f.launch(),l=f.read().launches[0],input={accountId:l.creatorId,id:l.id,mint,requestId:'c'.repeat(32)};
    f.change(db=>{db.launches[0].ledger.partnerCredit='11';});await f.service.collectProtocolFees('owner',input);const count=f.observed.sends;
    f.adapter.preparePayout=async args=>{if(change==='administrator')f.args.accounts.get=async()=>({role:'user',mfaEnabled:true});else f.service.getTreasury=async()=>f.destination.publicKey.toBase58();return bundle(args.wallet,[],'partner-payout');};
    f.service.closed=false;await f.service.processLaunch(mint);f.service.closed=true;assert.equal(f.observed.sends,count);assert.equal(f.read().launches[0].ledger.partnerCredit,'11');assert.equal(f.read().operations.filter(op=>op.protocolRequestId).length,0);
  }
});

test('overlapping collection request IDs remain idempotent after completion and failed transactions back off',async t=>{
  const f=await fixture(t),mint=await f.launch(),l=f.read().launches[0],input={accountId:l.creatorId,id:l.id,mint,requestId:'d'.repeat(32)},alias={...input,requestId:'e'.repeat(32)};
  await f.service.collectProtocolFees('owner',input);assert.equal((await f.service.collectProtocolFees('owner',alias)).alreadyRequested,true);
  f.state({phase:'trading',partnerFeesPending:'9'});f.service.closed=false;await f.service.processLaunch(mint);const op=f.read().operations.at(-1);f.receipt({state:'failed',slot:50});await f.service.receipt(op);
  const saved=f.read().launches[0],count=f.observed.sends;assert(saved.protocolCollection.retryAt>f.args.now());assert.equal(saved.protocolCollection.stage,'claim');await f.service.processLaunch(mint);assert.equal(f.observed.sends,count);
  f.advance(300001);f.state({phase:'trading',partnerFeesPending:'0'});await f.service.processLaunch(mint);f.service.closed=true;assert.equal(f.read().launches[0].protocolCollection.status,'completed');assert.equal((await f.service.collectProtocolFees('owner',alias)).alreadyRequested,true);assert.equal(f.read().launches[0].protocolCollection.status,'completed');
});

test('automatic partner claims and payouts continue between saved holder batches',async t=>{
  const f=await fixture(t),mint=await f.launch('holders');f.service.getQuotePrice=async()=>({mint:quote,usd:'100000000',at:f.args.now()});
  f.change(db=>{const l=db.launches[0];l.ledger.creatorCredit='100';l.rewards.cycle={id:'holder',index:0,payouts:[{owner:f.user.publicKey.toBase58(),amount:'100'}]};});const cycle=f.read().launches[0].rewards.cycle;
  f.state({phase:'trading',partnerFeesPending:'99',creatorFeesPending:'88'});f.service.closed=false;await f.service.processLaunch(mint);let op=f.read().operations.at(-1);assert.equal(op.action,'partner-claim');f.receipt({state:'finalized',slot:41,fees:{partnerQuoteRaw:'99'}});await f.service.receipt(op);
  await f.service.processLaunch(mint);op=f.read().operations.at(-1);assert.equal(op.action,'partner-payout');assert.deepEqual(f.read().launches[0].rewards.cycle,cycle);assert.equal(f.read().launches[0].ledger.creatorCredit,'100');f.service.closed=true;
});


test('one creator fee obligation cannot be prepared twice from separate accounts using the same recipient wallet',async t=>{
  const f=await fixture(t),mint=await f.launch();
  f.change(db=>{db.launches[0].ledger.creatorCredit='10000000';});
  const claim={action:'claim',expectedWallet:f.user.publicKey.toBase58(),mint};
  const first=await f.service.prepare(f.session,claim,f.context);
  assert.equal(first.operation.action,'payout');
  const other={...f.session,account:{id:'other-account'}},context={sessionToken:'other-account-session',authorize:async()=>other};
  await assert.rejects(f.service.prepare(other,claim,context),/unsettled transaction/);
  assert.equal(f.read().operations.filter(op=>op.action==='payout'&&op.state==='awaiting_signature').length,1);
  assert.equal(f.observed.sends,2);
});

test('owner held-SOL pass bypasses time and value thresholds without claims, migration or protocol spending',async t=>{
  const f=await fixture(t),mint=await f.launch('holders');
  f.change(db=>{const l=db.launches[0];l.ledger.creatorCredit='100';l.ledger.partnerCredit='999';l.rewards.nextCheckAt=f.args.now()+3600000;});
  const l=f.read().launches[0],input={accountId:l.creatorId,id:l.id,mint,requestId:'a'.repeat(32)};
  const queued=await f.service.queueHeldSolDistribution('owner',input);assert.equal(queued.state,'queued');assert.equal(queued.amountLamports,'100');
  assert.equal(await f.service.heldSolDistributionStatus({...input,requestId:'b'.repeat(32)}),null);
  f.adapter.state=async()=>{throw Error('No curve read or migration during held-only distribution');};f.service.getQuotePrice=async()=>{throw Error('No USD price needed for held SOL');};
  f.service.closed=false;await f.service.processLaunch(mint);let saved=f.read().launches[0];assert.equal(saved.heldSolDistribution.status,'processing');assert.equal(saved.rewards.cycle.heldSolRequestId,input.requestId);assert.deepEqual(saved.rewards.cycle.payouts,[{owner:f.destination.publicKey.toBase58(),amount:'100'}]);
  await f.service.processLaunch(mint);f.service.closed=true;const op=f.read().operations.at(-1);assert.equal(op.action,'payout');assert.equal(op.payouts[0].amount,'100');assert.equal(f.read().launches[0].ledger.partnerCredit,'999');assert.equal(f.read().launches[0].status,l.status);assert(f.observed.savedBeforeSend.every(Boolean));
  const restarted=new MeteoraService(f.args);restarted.closed=false;const count=f.observed.sends;await restarted.processLaunch(mint);assert.equal(f.observed.sends,count);assert.equal(f.read().operations.at(-1).signedTransaction,op.signedTransaction);
  f.receipt({state:'finalized',slot:60,payout:{quoteDebitRaw:'100',recipients:op.payouts}});await restarted.receipt(op);await restarted.receipt(op);
  const completed=await restarted.heldSolDistributionStatus(input);assert.equal(completed.state,'completed');assert.equal(completed.paidLamports,'100');assert.equal(completed.deferredLamports,'0');assert.equal(f.read().launches[0].ledger.creatorCredit,'0');assert.equal(f.read().launches[0].ledger.partnerCredit,'999');assert.equal(f.read().launches[0].rewards.totalPayments,1);
  assert.deepEqual(await restarted.queueHeldSolDistribution('owner',input),completed);
  f.change(db=>{db.launches[0].ledger.creatorCredit='50';});assert.equal((await restarted.queueHeldSolDistribution('owner',{...input,requestId:'c'.repeat(32)})).state,'queued');assert.deepEqual(await restarted.queueHeldSolDistribution('owner',input),completed);restarted.closed=true;
});

test('held-SOL requests skip unsafe states and do not resume or replace saved cycles',async t=>{
  const f=await fixture(t),mint=await f.launch('holders');f.change(db=>{db.launches[0].ledger.creatorCredit='100';});let request=0;
  const input=()=>({accountId:f.read().launches[0].creatorId,id:f.read().launches[0].id,mint,requestId:(++request).toString(16).padStart(32,'0')});
  f.change(db=>{db.launches[0].quoteMint=Keypair.generate().publicKey.toBase58();});assert.equal((await f.service.queueHeldSolDistribution('owner',input())).state,'skipped');
  f.change(db=>{db.launches[0].quoteMint=quote;db.launches[0].rewards.cycle={id:'original',index:0,payouts:[{owner:f.destination.publicKey.toBase58(),amount:'100'}]};});assert.match((await f.service.queueHeldSolDistribution('owner',input())).reason,/existing reward cycle/);assert.equal(f.read().launches[0].rewards.cycle.id,'original');
  f.change(db=>{delete db.launches[0].rewards.cycle;db.launches[0].retry={at:1,reason:'original pause',attempt:3};});assert.match((await f.service.queueHeldSolDistribution('owner',input())).reason,/existing Meteora reward retry/);assert.deepEqual(f.read().launches[0].retry,{at:1,reason:'original pause',attempt:3});
  f.change(db=>{delete db.launches[0].retry;db.operations.push({id:'pending',mint,state:'pending',action:'payout',signature:'saved-signature'});});const pendingInput=input();assert.equal((await f.service.queueHeldSolDistribution('owner',pendingInput)).state,'waiting');assert.equal(f.read().operations.at(-1).signature,'saved-signature');assert.equal(await f.service.heldSolDistributionStatus(pendingInput),null);
  f.change(db=>{db.operations.at(-1).state='finalized';});assert.equal((await f.service.queueHeldSolDistribution('owner',pendingInput)).state,'queued');assert.equal(f.read().launches[0].heldSolDistribution.requestId,pendingInput.requestId);
  f.args.accounts.get=async()=>({role:'user',mfaEnabled:true});await assert.rejects(f.service.queueHeldSolDistribution('owner',input()),/Administrator/);
});

test('held-SOL pass preserves old debts and retains blocked recipients instead of paying them twice',async t=>{
  const f=await fixture(t),mint=await f.launch('holders'),owed=Keypair.generate().publicKey.toBase58(),ready=f.destination.publicKey.toBase58();
  f.change(db=>{const l=db.launches[0];l.ledger.creatorCredit='100';l.ledger.partnerCredit='999';l.rewards.debts=[{owner:owed,amount:'30'}];});
  const l=f.read().launches[0],input={accountId:l.creatorId,id:l.id,mint,requestId:'d'.repeat(32)};await f.service.queueHeldSolDistribution('owner',input);
  f.service.closed=false;await f.service.processLaunch(mint);assert.deepEqual(new Map(f.read().launches[0].rewards.cycle.payouts.map(p=>[p.owner,p.amount])),new Map([[owed,'30'],[ready,'70']]));
  f.adapter.preparePayout=async({wallet,source,payouts})=>({...bundle(wallet,[source],'payout'),payout:{quoteDebitRaw:'70',recipients:payouts.filter(p=>p.owner===ready)},deferredPayouts:payouts.filter(p=>p.owner===owed)});
  await f.service.processLaunch(mint);f.service.closed=true;const op=f.read().operations.at(-1);f.receipt({state:'finalized',slot:60,payout:{quoteDebitRaw:'70',recipients:op.payouts}});await f.service.receipt(op);
  const saved=f.read().launches[0],status=await f.service.heldSolDistributionStatus(input);assert.equal(status.state,'completed');assert.equal(status.paidLamports,'70');assert.equal(status.deferredLamports,'30');assert.match(status.reason,/remain owed/);assert.deepEqual(saved.rewards.debts,[{owner:owed,amount:'30'}]);assert.equal(saved.ledger.creatorCredit,'30');assert.equal(saved.ledger.partnerCredit,'999');
});

test('an RPC failure retries the saved held-SOL request without changing ordinary automation state',async t=>{
  const f=await fixture(t),mint=await f.launch('holders');f.change(db=>{db.launches[0].ledger.creatorCredit='100';});const l=f.read().launches[0],input={accountId:l.creatorId,id:l.id,mint,requestId:'e'.repeat(32)};
  await f.service.queueHeldSolDistribution('owner',input);const snapshot=f.adapter.holderSnapshot;f.adapter.holderSnapshot=async()=>{throw Error('RPC private credential must not be persisted');};const before=f.observed.sends;f.service.closed=false;await f.service.processLaunch(mint);f.service.closed=true;
  let saved=f.read().launches[0];assert.equal(saved.retry,null);assert.equal(saved.heldSolDistribution.status,'queued');assert.equal(saved.heldSolDistribution.attempt,1);assert.match(saved.heldSolDistribution.reason,/saved request will retry/);assert(!JSON.stringify(saved).includes('credential'));assert.equal(f.observed.sends,before);
  f.advance(60000);f.adapter.holderSnapshot=snapshot;f.service.closed=false;await f.service.processLaunch(mint);f.service.closed=true;assert.equal(f.read().launches[0].heldSolDistribution.status,'processing');
});

test('a fee claim prepared before held-SOL queue cannot be journaled after the request takes ownership',async t=>{
  const f=await fixture(t),mint=await f.launch('holders');f.change(db=>{db.launches[0].ledger.creatorCredit='100';});const l=f.read().launches[0],input={accountId:l.creatorId,id:l.id,mint,requestId:'f'.repeat(32)},before=f.observed.sends;
  await assert.rejects(f.service.automatic(mint,'creator-claim',async(d,launch)=>{await f.service.queueHeldSolDistribution('owner',input);return bundle(d.authority.address,[launch.creatorAuthority],'creator-claim');}),/allocation changed/);
  assert.equal(f.observed.sends,before);assert.equal(f.read().launches[0].heldSolDistribution.status,'queued');assert.equal(f.read().operations.filter(op=>op.action==='creator-claim').length,0);
});

test('a held-SOL request cannot be replayed by a different administrator',async t=>{
  const f=await fixture(t),mint=await f.launch('holders');f.change(db=>{db.launches[0].ledger.creatorCredit='100';});const l=f.read().launches[0],input={accountId:l.creatorId,id:l.id,mint,requestId:'1'.repeat(32)};
  await f.service.queueHeldSolDistribution('owner',input);await assert.rejects(f.service.queueHeldSolDistribution('different-admin',input),/another administrator/);assert.equal(f.read().launches[0].heldSolDistribution.actorId,'owner');
});

test('admin revocation during held-SOL payout preparation prevents signing and reserves unpaid allocations',async t=>{
  const f=await fixture(t),mint=await f.launch('holders');f.change(db=>{db.launches[0].ledger.creatorCredit='100';});const l=f.read().launches[0],input={accountId:l.creatorId,id:l.id,mint,requestId:'2'.repeat(32)};
  await f.service.queueHeldSolDistribution('owner',input);f.service.closed=false;await f.service.processLaunch(mint);const before=f.observed.sends,priorCheck=f.read().launches[0].rewards.nextCheckAt;
  f.adapter.preparePayout=async({wallet,source})=>{f.args.accounts.get=async()=>({role:'user',mfaEnabled:true});return bundle(wallet,[source],'payout');};
  await f.service.processLaunch(mint);f.service.closed=true;const saved=f.read().launches[0];assert.equal(f.observed.sends,before);assert.equal(saved.heldSolDistribution.status,'failed');assert.match(saved.heldSolDistribution.reason,/Administrator access changed/);assert.equal(saved.rewards.cycle,undefined);assert.deepEqual(saved.rewards.debts,[{owner:f.destination.publicKey.toBase58(),amount:'100'}]);assert.equal(saved.ledger.creatorCredit,'100');assert.equal(saved.rewards.nextCheckAt,priorCheck);assert.equal(saved.retry,null);
});

test('revocation never replaces a pending signed payout and reserves only its unpaid remainder after receipt',async t=>{
  const f=await fixture(t),mint=await f.launch('holders'),holders=Array.from({length:4},()=>({owner:Keypair.generate().publicKey.toBase58(),amount:'1'}));f.adapter.holderSnapshot=async()=>({complete:true,slot:55,rows:holders});f.change(db=>{db.launches[0].ledger.creatorCredit='40';});const l=f.read().launches[0],input={accountId:l.creatorId,id:l.id,mint,requestId:'3'.repeat(32)};
  await f.service.queueHeldSolDistribution('owner',input);f.service.closed=false;await f.service.processLaunch(mint);await f.service.processLaunch(mint);let op=f.read().operations.at(-1);assert.equal(op.payouts.length,3);const sends=f.observed.sends;
  f.args.accounts.get=async()=>({role:'admin',mfaEnabled:false});await f.service.processLaunch(mint);assert.equal(f.observed.sends,sends);assert.equal(f.read().operations.at(-1).signedTransaction,op.signedTransaction);assert.equal(f.read().launches[0].heldSolDistribution.status,'processing');
  f.receipt({state:'finalized',slot:60,payout:{quoteDebitRaw:'30',recipients:op.payouts}});await f.service.receipt(op);await f.service.processLaunch(mint);f.service.closed=true;const saved=f.read().launches[0];assert.equal(saved.heldSolDistribution.status,'failed');assert.equal(saved.heldSolDistribution.paidLamports,'30');assert.equal(saved.heldSolDistribution.deferredLamports,'10');assert.equal(saved.rewards.debts.length,1);assert.equal(saved.ledger.creatorCredit,'10');assert.equal(f.observed.sends,sends);
});

test('ordinary holder allocation cannot overwrite a manual request queued during its snapshot',async t=>{
  const f=await fixture(t),mint=await f.launch('holders');f.change(db=>{const l=db.launches[0];l.ledger.creatorCredit='2000000000';l.rewards.nextCheckAt=0;});const l=f.read().launches[0],input={accountId:l.creatorId,id:l.id,mint,requestId:'4'.repeat(32)},holderSnapshot=f.adapter.holderSnapshot;
  f.adapter.holderSnapshot=async launch=>{await f.service.queueHeldSolDistribution('owner',input);return holderSnapshot(launch);};
  f.service.closed=false;await f.service.processLaunch(mint);let saved=f.read().launches[0];assert.equal(saved.heldSolDistribution.status,'queued');assert.equal(saved.rewards.cycle,undefined);assert.equal(saved.rewards.nextCheckAt,0);
  await f.service.processLaunch(mint);f.service.closed=true;saved=f.read().launches[0];assert.equal(saved.heldSolDistribution.status,'processing');assert.equal(saved.rewards.cycle.heldSolRequestId,input.requestId);
});

test('ordinary minimum-delay write does not change a concurrently queued manual request schedule',async t=>{
  const f=await fixture(t),mint=await f.launch('holders');f.change(db=>{const l=db.launches[0];l.ledger.creatorCredit='100';l.rewards.nextCheckAt=0;});const l=f.read().launches[0],input={accountId:l.creatorId,id:l.id,mint,requestId:'5'.repeat(32)};let calls=0;
  f.service.getQuotePrice=async()=>{if(++calls===2)await f.service.queueHeldSolDistribution('owner',input);return {mint:quote,usd:'100',at:f.args.now()};};
  f.service.closed=false;await f.service.processLaunch(mint);f.service.closed=true;const saved=f.read().launches[0];assert.equal(saved.heldSolDistribution.status,'queued');assert.equal(saved.rewards.nextCheckAt,0);assert.equal(saved.rewards.cycle,undefined);
});

test('hard held-SOL budget mismatch terminates the job without mislabeling it an RPC retry',async t=>{
  const f=await fixture(t),mint=await f.launch('holders');f.change(db=>{db.launches[0].ledger.creatorCredit='100';});const l=f.read().launches[0],input={accountId:l.creatorId,id:l.id,mint,requestId:'6'.repeat(32)};
  await f.service.queueHeldSolDistribution('owner',input);f.change(db=>{db.launches[0].ledger.creatorCredit='99';});const sends=f.observed.sends;f.service.closed=false;await f.service.processLaunch(mint);f.service.closed=true;const saved=f.read().launches[0];assert.equal(saved.heldSolDistribution.status,'failed');assert.match(saved.heldSolDistribution.reason,/administrator review/);assert.equal(saved.heldSolDistribution.retryAt,undefined);assert.equal(saved.ledger.creatorCredit,'99');assert.equal(saved.retry,null);assert.equal(f.observed.sends,sends);
});

test('mismatched manual cycle requires intervention and is never silently unwound or executed',async t=>{
  const f=await fixture(t),mint=await f.launch('holders');f.change(db=>{db.launches[0].ledger.creatorCredit='100';});const l=f.read().launches[0],input={accountId:l.creatorId,id:l.id,mint,requestId:'7'.repeat(32)};
  await f.service.queueHeldSolDistribution('owner',input);const cycle={id:'saved-other-cycle',heldSolRequestId:'8'.repeat(32),index:0,payouts:[{owner:f.destination.publicKey.toBase58(),amount:'100'}]};f.change(db=>{db.launches[0].rewards.cycle=structuredClone(cycle);});const sends=f.observed.sends;f.service.closed=false;await f.service.processLaunch(mint);await f.service.processLaunch(mint);f.service.closed=true;
  const saved=f.read().launches[0];assert.equal(saved.heldSolDistribution.status,'failed');assert.match(saved.heldSolDistribution.reason,/administrator review/);assert.deepEqual(saved.rewards.cycle,cycle);assert.equal(saved.ledger.creatorCredit,'100');assert.equal(f.observed.sends,sends);
});

test('analytics revenue metadata marks missing finalized creation receipts without changing treasury candidate discovery',async t=>{
 const f=await fixture(t);await f.launch();const before=f.read(),sent=f.observed.sends;
 const candidates=await f.service.treasurySources(),report=await f.service.analyticsRevenueSources();assert.equal(report.complete,false);assert.deepEqual(report.sources,candidates);assert.deepEqual(f.read(),before);assert.equal(f.observed.sends,sent);
});

test('Meteora coin text is trimmed onto one line, @handles become profile links and each limit is named with its field',async t=>{
  const f=await fixture(t),published=[];
  for(const [fields,message] of [
    [{name:'Café Ünïcödé Rocket Club 🚀'},/^The coin name is too long\. Use at most 32 characters; emoji and accented letters count as 2 to 4 each\.$/],
    [{name:' \n '},/^Enter a coin name\.$/],
    [{symbol:'TICKER2LONG'},/^The ticker is too long\. Use at most 10 characters/],
    [{description:'é'.repeat(501)},/^The description is too long\. Use at most 1,000 characters/],
    [{website:'https://@examplecoin'},/^Enter the website as an https:\/\/ address with a domain/],
    [{twitter:'https://@this_is_far_too_long'},/^Enter X as @handle/],
    [{telegram:'http://t.me/examplechat'},/^Enter Telegram as @username/],
  ])await assert.rejects(f.service.prepare(f.session,{...f.input,...fields},f.context),error=>error.statusCode===400&&message.test(error.message));
  assert.equal(f.observed.prepares,0,'refused text prepares nothing');
  // Before v71.25 a two-line description or a trailing space was refused as "Invalid description.", and "@examplecoin"
  // (sent by the launch page as "https://@examplecoin") was saved as a broken link.
  f.service.publishMetadata=async meta=>{published.push(meta);return 'https://example.test/metadata.json';};
  await f.service.prepare(f.session,{...f.input,name:' Meteora Test \n',description:'First line.\nSecond line. ',website:'https://launch.example',twitter:'https://@examplecoin',telegram:'@examplechat'},f.context).catch(()=>{});
  const saved={name:'Meteora Test',symbol:'MT',description:'First line. Second line.',website:'https://launch.example/',twitter:'https://x.com/examplecoin',telegram:'https://t.me/examplechat'};
  assert.deepEqual(Object.fromEntries(Object.keys(saved).map(key=>[key,published[0]?.[key]])),saved,'the published metadata carries the cleaned text and links');
});

// ---- Reward baskets (v71.33) ------------------------------------------------------------------------------------------------------
const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',STOCK=Keypair.generate().publicKey.toBase58();
const ASSETS={[quote]:{symbol:'SOL',decimals:9},[USDC]:{symbol:'USDC',decimals:6},[STOCK]:{symbol:'TSLAx',decimals:8,program:'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'}};
function basketFixture(f){
  f.service.quoteEligibility=async mint=>ASSETS[mint]?{mint,...ASSETS[mint],launchReady:true}:{mint,launchReady:false,reason:'Not catalogued.'};
  f.service.getQuotePrice=async mint=>({mint,usd:mint===quote?'100':mint===USDC?'1':'250',at:f.args.now()});
  f.observed.routeChecks=[];f.observed.conversions=[];f.observed.assetPayouts=[];
  f.adapter.basketsAvailable=()=>true;f.adapter.basketRouteCheck=async args=>{f.observed.routeChecks.push(args);if(f.noRoute?.has(args.outputMint))throw Object.assign(Error('No swap route is available for this basket asset right now.'),{statusCode:409});return {outAmount:'1',priceImpactPct:'0.001'};};
  f.adapter.prepareBasketConversion=async({wallet,launch,asset,inputRaw})=>{f.observed.conversions.push({asset:asset.mint,inputRaw});if(f.noRoute?.has(asset.mint))throw Object.assign(Error('No conversion route is available right now.'),{statusCode:409,code:'SOL_ROUTE_NOT_FOUND'});return {...bundle(wallet,[launch.creatorAuthority],'basket-convert'),conversion:{inputMint:launch.quoteMint,outputMint:asset.mint,inputRaw,expectedRaw:String(BigInt(inputRaw)/10n),minimumRaw:String(BigInt(inputRaw)/11n),source:'src',destination:'dst',decimals:asset.decimals,program:asset.program||null,lookupTables:1}};};
  f.adapter.preparePayout=async({wallet,source,payouts,asset})=>{f.observed.payouts++;f.observed.assetPayouts.push({asset:asset?.mint||null,payouts});return bundle(wallet,[source],'payout');};
  f.adapter.holderSnapshot=async()=>{f.observed.snapshots=(f.observed.snapshots||0)+1;return {complete:true,slot:50,rows:[{owner:f.destination.publicKey.toBase58(),amount:'300'},{owner:f.holder2,amount:'100'}]};};
  f.holder2=Keypair.generate().publicKey.toBase58();
  f.launchBasket=async(extras=[USDC,STOCK])=>{let prepared=await f.service.prepare(f.session,{...f.input,feeMode:'holders',basket:extras},f.context);await f.service.submit(f.session,{operationId:prepared.operation.id,signedTransaction:sign(f.read().operations.at(-1).bundle,f.user)},f.context);f.receipt({state:'finalized',slot:10});await f.service.reconcile(f.session,{operationId:prepared.operation.id},f.context);prepared=await f.service.prepare(f.session,{action:'initialize',expectedWallet:f.user.publicKey.toBase58(),mint:prepared.launch.mint},f.context);await f.service.submit(f.session,{operationId:prepared.operation.id,signedTransaction:sign(f.read().operations.at(-1).bundle,f.user)},f.context);f.receipt({state:'finalized',slot:11,phase:'trading',poolId:Keypair.generate().publicKey.toBase58()});await f.service.reconcile(f.session,{operationId:prepared.operation.id},f.context);f.receipt({state:'pending'});return f.read().launches[0].mint;};
  // One worker pass, then the receipt of the operation it journaled (if any), settled.
  f.pass=async(mint,result)=>{f.service.closed=false;await f.service.processLaunch(mint);f.service.closed=true;const op=f.read().operations.at(-1);if(result&&op&&!['finalized','failed','expired','cancelled'].includes(op.state)){f.receipt(typeof result==='function'?result(op):result);await f.service.receipt(op);f.receipt({state:'pending'});}return f.read().operations.at(-1);};
  return f;
}
test('reward baskets: a holder-rewards Meteora launch may add up to two verified, routable assets; the basket is frozen on the record and shown publicly',async t=>{
  const f=basketFixture(await fixture(t));
  await assert.rejects(f.service.prepare(f.session,{...f.input,feeMode:'creator',basket:[USDC]},f.context),/for holder rewards/);
  await assert.rejects(f.service.prepare(f.session,{...f.input,feeMode:'holders',basket:[USDC,STOCK,Keypair.generate().publicKey.toBase58()]},f.context),/at most 3 assets/);
  await assert.rejects(f.service.prepare(f.session,{...f.input,feeMode:'holders',basket:[quote]},f.context),/already in the basket/);
  await assert.rejects(f.service.prepare(f.session,{...f.input,feeMode:'holders',basket:[USDC,USDC]},f.context),/each asset once/);
  await assert.rejects(f.service.prepare(f.session,{...f.input,feeMode:'holders',basket:'USDC'},f.context),/mint addresses/);
  await assert.rejects(f.service.prepare(f.session,{...f.input,feeMode:'holders',basket:[Keypair.generate().publicKey.toBase58()]},f.context),/Not catalogued/);
  f.noRoute=new Set([STOCK]);await assert.rejects(f.service.prepare(f.session,{...f.input,feeMode:'holders',basket:[STOCK]},f.context),/TSLAx cannot join the basket: No swap route/);f.noRoute=null;
  const unavailable=f.adapter.basketsAvailable;f.adapter.basketsAvailable=()=>false;await assert.rejects(f.service.prepare(f.session,{...f.input,feeMode:'holders',basket:[USDC]},f.context),/not available on this host/);f.adapter.basketsAvailable=unavailable;
  assert.equal((await f.service.publicStatus()).basketsEnabled,true);assert.deepEqual((await f.service.publicStatus()).basketLimits,{maxAssets:3,maxExtras:2});
  assert.equal(f.read().launches.length,0,'nothing was saved by the refusals');assert.equal(f.observed.prepares,0);
  // An empty basket is no basket.
  const plain=await f.service.prepare(f.session,{...f.input,feeMode:'holders',basket:[]},f.context);assert.equal(plain.launch.basket,null);assert.equal(f.read().launches[0].basket,undefined);
  await f.service.cancel(f.session,{operationId:plain.operation.id},f.context);f.change(db=>{db.launches=[];db.operations=[];});f.observed.routeChecks=[];
  const mint=await f.launchBasket();
  const l=f.read().launches[0];assert.deepEqual(l.basket.assets.map(a=>[a.mint,a.symbol,a.decimals]),[[quote,'SOL',9],[USDC,'USDC',6],[STOCK,'TSLAx',8]]);assert.equal(l.basket.assets[2].program,ASSETS[STOCK].program);assert.equal(l.basket.shares,'equal');
  assert.deepEqual(l.ledger.basket,{[USDC]:{credit:'0',paid:'0',converted:'0',payments:0},[STOCK]:{credit:'0',paid:'0',converted:'0',payments:0}});assert.deepEqual(l.rewards.basketDebts,{});
  assert.deepEqual(f.observed.routeChecks.map(r=>[r.inputMint,r.outputMint,r.amountRaw]),[[quote,USDC,'500000000'],[quote,STOCK,'500000000']],'a $50 slice of the pair asset must route into each extra asset');
  const view=await f.service.publicDetail(mint);assert.deepEqual(view.basket,{version:1,shares:'equal',count:3,assets:[{mint:quote,symbol:'SOL',decimals:9},{mint:USDC,symbol:'USDC',decimals:6},{mint:STOCK,symbol:'TSLAx',decimals:8}],description:'SOL, USDC and TSLAx'});
  assert.deepEqual(view.holderRewards.basket.map(r=>[r.symbol,r.pending,r.distributed]),[['SOL','0','0'],['USDC','0','0'],['TSLAx','0','0']]);assert.deepEqual(view.holderRewards.rounds,[]);
  const rewards=await f.service.publicRewards(mint);assert.equal(rewards.basket.count,3);assert.equal(rewards.holder.basket.length,3);
  const text=JSON.stringify({view,rewards,status:await f.service.publicStatus()});for(const key of Object.values(l.keys))assert.equal(text.includes(key.secretBase64),false);
  // The review of the launch transaction named the basket.
  assert.deepEqual(f.read().operations[0].review.basket.assets.map(a=>a.symbol),['SOL','USDC','TSLAx']);
});
test('reward baskets: a round converts the extra shares one at a time, snapshots holders once, airdrops every asset to every holder and settles each asset from its own receipts',async t=>{
  const f=basketFixture(await fixture(t)),mint=await f.launchBasket(),owner=f.destination.publicKey.toBase58();
  f.change(db=>{db.launches[0].ledger.creatorCredit='3000000001';db.launches[0].rewards.nextCheckAt=0;});
  // Round start: $300 of SOL ready → three equal shares, the remainder with the pair asset; two conversion legs queued.
  let op=await f.pass(mint);let l=f.read().launches[0];assert.equal(l.rewards.cycle.basket,true);assert.equal(l.rewards.cycle.stage,'convert');assert.equal(l.rewards.cycle.mainRaw,'1000000001');
  assert.deepEqual(l.rewards.cycle.legs.map(x=>[x.mint,x.inputRaw,x.state]),[[USDC,'1000000000','queued'],[STOCK,'1000000000','queued']]);assert.equal(f.observed.conversions.length,0);
  // Leg 1: a basket-convert operation signed by the gas wallet and the creator authority, settled from the finalized conversion receipt.
  op=await f.pass(mint,op=>({state:'finalized',slot:20,conversion:{inputMint:quote,outputMint:USDC,inputRaw:'1000000000',outputRaw:'100000000'}}));
  assert.equal(op.action,'basket-convert');assert.equal(op.state,'finalized');assert.deepEqual(op.bundle.requiredSigners,[f.authority.publicKey.toBase58(),f.read().launches[0].creatorAuthority]);assert.equal(op.legIndex,0);assert.equal(op.conversion.outputMint,USDC);
  l=f.read().launches[0];assert.equal(l.ledger.creatorCredit,'2000000001');assert.equal(l.ledger.basket[USDC].credit,'100000000');assert.equal(l.ledger.basket[USDC].converted,'100000000');assert.deepEqual(l.rewards.cycle.legs[0].state,'done');assert.equal(l.rewards.cycle.legs[0].outputRaw,'100000000');assert.equal(l.rewards.cycle.stage,'convert');
  assert.deepEqual(f.observed.conversions,[{asset:USDC,inputRaw:'1000000000'}]);
  // A receipt that names a different leg or amount is refused.
  // Leg 2 (the stock, Token-2022): settled; the round moves on to allocation.
  op=await f.pass(mint,{state:'finalized',slot:21,conversion:{inputMint:quote,outputMint:STOCK,inputRaw:'1000000000',outputRaw:'40000000'}});
  l=f.read().launches[0];assert.equal(l.ledger.creatorCredit,'1000000001');assert.equal(l.ledger.basket[STOCK].credit,'40000000');assert.equal(l.rewards.cycle.stage,'allocate');
  // Allocation: one snapshot for every asset, pro-rata (300:100), the pair-asset remainder included, nothing paid yet.
  await f.pass(mint);l=f.read().launches[0];assert.equal(f.observed.snapshots,1);assert.equal(l.rewards.cycle.stage,'payout');assert.equal(l.rewards.cycle.assetIndex,0);
  const byOwner=rows=>rows.slice().sort((a,b)=>a.owner.localeCompare(b.owner));
  assert.deepEqual(l.rewards.cycle.assets.map(a=>[a.symbol,a.amount,a.payouts]),[['SOL','1000000001',byOwner([{owner,amount:'750000000'},{owner:f.holder2,amount:'250000000'}])],['USDC','100000000',byOwner([{owner,amount:'75000000'},{owner:f.holder2,amount:'25000000'}])],['TSLAx','40000000',byOwner([{owner,amount:'30000000'},{owner:f.holder2,amount:'10000000'}])]]);
  // Payouts: the pair asset first (the ordinary builder), then each basket asset with its own mint; each settles against its own ledger.
  const expectations=[[null,quote,'creatorCredit'],[USDC,USDC,'basket'],[STOCK,STOCK,'basket']];
  for(const [assetArg,assetMint,ledgerKey] of expectations){
    const before=f.observed.assetPayouts.length;
    op=await f.pass(mint,op=>({state:'finalized',slot:30,payout:{quoteDebitRaw:op.payouts.reduce((n,p)=>n+BigInt(p.amount),0n).toString(),recipients:op.payouts,mint:assetMint}}));
    assert.equal(op.action,'payout');assert.equal(op.assetMint,assetMint);assert.equal(op.state,'finalized');assert.equal(f.observed.assetPayouts[before].asset,assetArg);assert.equal(op.payouts.length,2);
    l=f.read().launches[0];
    if(ledgerKey==='creatorCredit'){assert.equal(l.ledger.creatorCredit,'1');assert.equal(l.ledger.creatorPaid,'1000000000');}
    else{assert.equal(l.ledger.basket[assetMint].credit,'0');assert.equal(l.ledger.basket[assetMint].paid,assetMint===USDC?'100000000':'40000000');assert.equal(l.ledger.basket[assetMint].payments,2);}
  }
  l=f.read().launches[0];assert.equal(l.rewards.cycle,undefined,'the round closed');assert.equal(l.rewards.totalPayments,6);assert.deepEqual([...l.rewards.paidWallets].sort(),[owner,f.holder2].sort());assert.equal(l.rewards.nextCheckAt,f.args.now()+3600000);
  assert.equal(l.rewards.rounds.length,1);assert.deepEqual(l.rewards.rounds[0].assets.map(a=>[a.symbol,a.amountRaw,a.recipients]),[['SOL','1000000001',2],['USDC','100000000',2],['TSLAx','40000000',2]]);assert.deepEqual(l.rewards.rounds[0].skipped,[]);
  const view=await f.service.publicDetail(mint);assert.deepEqual(view.holderRewards.basket.map(r=>[r.symbol,r.pending,r.distributed]),[['SOL','0.000000001','1'],['USDC','0','100'],['TSLAx','0','0.4']]);assert.equal(view.holderRewards.rounds.length,1);assert.equal(view.holderRewards.stage,null);
  // Wrong-asset receipts never settle: a basket-asset payout receipt that names the pair asset is refused.
  f.change(db=>{const l=db.launches[0];l.ledger.basket[USDC].credit='500';l.rewards.cycle={id:'c2',basket:true,stage:'payout',mainRaw:'0',legs:[],assets:[{mint:USDC,symbol:'USDC',decimals:6,program:null,amount:'500',payouts:[{owner,amount:'500'}],index:0}],assetIndex:0};});
  op=await f.pass(mint);f.receipt({state:'finalized',slot:40,payout:{quoteDebitRaw:'500',recipients:op.payouts,mint:quote}});await assert.rejects(f.service.receipt(op),/names a different asset/);assert.equal(f.read().launches[0].ledger.basket[USDC].credit,'500');
  f.receipt({state:'finalized',slot:40,payout:{quoteDebitRaw:'500',recipients:op.payouts,mint:USDC}});await f.service.receipt(op);assert.equal(f.read().launches[0].ledger.basket[USDC].credit,'0');assert.equal(f.read().launches[0].rewards.cycle,undefined);
  assert.equal((await f.service.analyticsRewardRecords())[0].operations.filter(o=>o.kind==='payout').length,1,'only pair-asset payouts feed the quote-denominated analytics');
});
test('reward baskets: a share whose conversion keeps failing is paid in the pair asset after three attempts, a conversion that does not land is retried, and the round says what was skipped',async t=>{
  const f=basketFixture(await fixture(t)),mint=await f.launchBasket([STOCK]),owner=f.destination.publicKey.toBase58();
  f.change(db=>{db.launches[0].ledger.creatorCredit='3000000000';db.launches[0].rewards.nextCheckAt=0;});
  await f.pass(mint);let l=f.read().launches[0];assert.deepEqual(l.rewards.cycle.legs.map(x=>[x.mint,x.inputRaw,x.state]),[[STOCK,'1500000000','queued']]);assert.equal(l.rewards.cycle.mainRaw,'1500000000');
  // No route: each attempt is counted and backs off; the third marks the leg skipped.
  f.noRoute=new Set([STOCK]);
  for(const attempt of [1,2,3]){f.change(db=>{db.launches[0].retry=null;});f.service.closed=false;await f.service.processLaunch(mint);f.service.closed=true;l=f.read().launches[0];assert.equal(l.rewards.cycle.legs[0].attempts,attempt);assert.equal(l.rewards.cycle.legs[0].state,attempt<3?'queued':'skipped');assert.match(l.rewards.cycle.legs[0].note,/No conversion route/);assert.ok(l.retry,'the failure backs off like any reward failure');}
  assert.equal(f.read().operations.filter(o=>o.action==='basket-convert').length,0,'nothing was journaled');
  f.change(db=>{db.launches[0].retry=null;});f.noRoute=null;
  await f.pass(mint);l=f.read().launches[0];assert.equal(l.rewards.cycle.stage,'allocate');
  await f.pass(mint);l=f.read().launches[0];assert.equal(l.rewards.cycle.stage,'payout');assert.deepEqual(l.rewards.cycle.assets.map(a=>[a.symbol,a.amount]),[['SOL','3000000000']],'the skipped share stays with the pair asset');
  let op=await f.pass(mint,op=>({state:'finalized',slot:30,payout:{quoteDebitRaw:'3000000000',recipients:op.payouts,mint:quote}}));assert.equal(op.assetMint,quote);
  l=f.read().launches[0];assert.equal(l.rewards.cycle,undefined);assert.equal(l.ledger.creatorCredit,'0');assert.deepEqual(l.rewards.rounds[0].skipped,[{mint:STOCK,inputRaw:'1500000000',note:'No conversion route is available right now.'}]);
  // A conversion that is journaled but fails on chain goes back to queued with the attempt counted; after the limit it is skipped.
  f.change(db=>{db.launches[0].ledger.creatorCredit='2000000000';db.launches[0].rewards.nextCheckAt=0;});
  await f.pass(mint);op=await f.pass(mint,{state:'failed',error:'The Meteora transaction failed on chain; its transfers were rolled back.'});
  l=f.read().launches[0];assert.equal(op.action,'basket-convert');assert.equal(op.state,'failed');assert.deepEqual([l.rewards.cycle.legs[0].state,l.rewards.cycle.legs[0].attempts],['queued',1]);assert.equal(l.ledger.creatorCredit,'2000000000','nothing moved');
  op=await f.pass(mint,{state:'expired'});l=f.read().launches[0];assert.deepEqual([l.rewards.cycle.legs[0].state,l.rewards.cycle.legs[0].attempts],['queued',2]);
  op=await f.pass(mint,{state:'failed'});l=f.read().launches[0];assert.deepEqual([l.rewards.cycle.legs[0].state,l.rewards.cycle.legs[0].attempts],['skipped',3]);
  // A conversion receipt that names a different amount than the saved leg is refused.
  f.change(db=>{const l=db.launches[0];l.rewards.cycle.legs[0]={mint:STOCK,inputRaw:'1000000000',state:'queued',attempts:0,outputRaw:'0',note:''};});
  op=await f.pass(mint);f.receipt({state:'finalized',slot:50,conversion:{inputMint:quote,outputMint:STOCK,inputRaw:'999999999',outputRaw:'1'}});await assert.rejects(f.service.receipt(op),/differs from its saved leg/);assert.equal(f.read().launches[0].ledger.creatorCredit,'2000000000');
});
test('reward baskets: recipients a basket asset cannot reach yet are kept as that asset’s debt and paid in the next round without converting again; the pair asset keeps its own debts',async t=>{
  const f=basketFixture(await fixture(t)),mint=await f.launchBasket([USDC]),owner=f.destination.publicKey.toBase58();
  f.change(db=>{db.launches[0].ledger.creatorCredit='2000000000';db.launches[0].rewards.nextCheckAt=0;});
  await f.pass(mint);await f.pass(mint,{state:'finalized',slot:20,conversion:{inputMint:quote,outputMint:USDC,inputRaw:'1000000000',outputRaw:'100000000'}});await f.pass(mint);
  // The pair-asset batch: holder 2 is blocked (rent) and becomes a pair-asset debt; the USDC batch: holder 1 is frozen and becomes a USDC debt.
  f.adapter.preparePayout=async({wallet,source,payouts,asset})=>{const blocked=asset?payouts.find(p=>p.owner===owner):payouts.find(p=>p.owner===f.holder2),ready=payouts.filter(p=>p!==blocked);return {...bundle(wallet,[source],'payout'),payout:{quoteDebitRaw:ready.reduce((n,p)=>n+BigInt(p.amount),0n).toString(),recipients:ready,mint:asset?.mint||quote},deferredPayouts:blocked?[{...blocked,reason:asset?'recipient-frozen':'recipient-rent'}]:[]};};
  let op=await f.pass(mint,op=>({state:'finalized',slot:30,payout:{quoteDebitRaw:op.payouts.reduce((n,p)=>n+BigInt(p.amount),0n).toString(),recipients:op.payouts,mint:quote}}));
  let l=f.read().launches[0];assert.deepEqual(op.payouts,[{owner,amount:'750000000'}]);assert.deepEqual(l.rewards.debts,[{owner:f.holder2,amount:'250000000'}]);assert.equal(l.ledger.creatorCredit,'250000000');
  op=await f.pass(mint,op=>({state:'finalized',slot:31,payout:{quoteDebitRaw:op.payouts.reduce((n,p)=>n+BigInt(p.amount),0n).toString(),recipients:op.payouts,mint:USDC}}));
  l=f.read().launches[0];assert.deepEqual(op.payouts,[{owner:f.holder2,amount:'25000000'}]);assert.deepEqual(l.rewards.basketDebts,{[USDC]:[{owner,amount:'75000000'}]});assert.equal(l.ledger.basket[USDC].credit,'75000000');assert.equal(l.rewards.cycle,undefined);
  // Next check: below the $100 minimum, but debts wait → a round with nothing to convert pays the debts only, from the saved credits, with no new snapshot.
  f.adapter.preparePayout=async({wallet,source,payouts,asset})=>({...bundle(wallet,[source],'payout'),payout:{quoteDebitRaw:payouts.reduce((n,p)=>n+BigInt(p.amount),0n).toString(),recipients:payouts,mint:asset?.mint||quote},deferredPayouts:[]});
  f.advance(3600001);const snapshots=f.observed.snapshots;await f.pass(mint);l=f.read().launches[0];assert.equal(l.rewards.cycle.stage,'allocate');assert.deepEqual(l.rewards.cycle.legs,[{mint:USDC,inputRaw:'0',state:'skipped',attempts:0,outputRaw:'0',note:'nothing to convert this round'}]);
  await f.pass(mint);l=f.read().launches[0];assert.equal(f.observed.snapshots,snapshots,'debts only: no new snapshot');assert.deepEqual(l.rewards.cycle.assets.map(a=>[a.symbol,a.payouts]),[['SOL',[{owner:f.holder2,amount:'250000000'}]],['USDC',[{owner,amount:'75000000'}]]]);assert.deepEqual(l.rewards.debts,[]);assert.deepEqual(l.rewards.basketDebts,{});
  await f.pass(mint,op=>({state:'finalized',slot:40,payout:{quoteDebitRaw:'250000000',recipients:op.payouts,mint:quote}}));await f.pass(mint,op=>({state:'finalized',slot:41,payout:{quoteDebitRaw:'75000000',recipients:op.payouts,mint:USDC}}));
  l=f.read().launches[0];assert.equal(l.rewards.cycle,undefined);assert.equal(l.ledger.creatorCredit,'0');assert.equal(l.ledger.basket[USDC].credit,'0');assert.equal(l.ledger.basket[USDC].paid,'100000000');assert.equal(l.rewards.rounds.length,2);
  // Held-SOL distributions do not apply to basket launches.
  const held=await f.service.queueHeldSolDistribution('alice',{accountId:'alice',id:l.id,mint,requestId:'a'.repeat(32)});assert.equal(held.state,'skipped');assert.match(held.reason,/Reward-basket launches/);
});
