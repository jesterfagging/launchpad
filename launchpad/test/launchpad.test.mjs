import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TransferFeeConfigLayout, ExtensionType } from '@solana/spl-token';
import BN from 'bn.js';
import { Launchpad, requestFees } from '../src/launchpad.mjs';
import { LaunchPreparationQueue } from '../src/launchpad-preparation-queue.mjs';
import { LaunchMetadataStorage } from '../src/launchpad-media.mjs';
import { LaunchChain, rayCurveAtTarget, ray, decodeRay, newLaunchKeys, signer, receiptDeltas } from '../src/launchpad-chain.mjs';
import { deserializeTransaction } from '../src/transactions-v1.mjs';
import { verifySignedTransaction } from '../src/providers.mjs';
import { launchInput, LAUNCH_CURVE_POLICY, newLaunchCurvePolicy, weightedRewards, SOL_MINT, USDC_MINT, units } from '../public/launchpad-model.mjs';
import { protocolFeeEligibility } from '../src/launchpad-protocol-fees.mjs';
import { taxProtocolLedger } from '../src/launchpad-tax-protocol.mjs';
import {rewardFixtureReceipt,rewardFixtureHandoffReceipt} from './helpers/rewards-wallet-fixture.mjs';
const pk=x=>new PublicKey(x),newAddress=()=>Keypair.generate().publicKey.toBase58();
const fixture=JSON.parse(await readFile(new URL('./launchpad-accounts.json',import.meta.url),'utf8'));
const account=x=>({...x,owner:pk(x.owner),data:Buffer.from(x.data[0],'base64')});
const cfg=decodeRay(account(fixture.rayConfig.account),ray.LAUNCHPAD_PROGRAM,ray.LaunchpadConfig,'GlobalConfig');
const raw=(extra={})=>({name:'Example test',symbol:'TEST',network:'mainnet-beta',route:'raydium',feeMode:'creator',recipient:newAddress(),quoteMint:SOL_MINT,quoteUsd:'100',metadataUri:'https://example.com/token.json',...extra});
const terms=()=>({...rayCurveAtTarget(cfg,9,'100'),configId:fixture.rayConfig.pubkey,cpConfigId:'D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2',quoteProgram:TOKEN_PROGRAM_ID.toBase58(),quoteDecimals:9,price:{usd:'100'},minimumSol:'0.06',creatorFeeBps:25,protocolFeeBps:25,lp:'Burned',warnings:[]});
const launch=(extra={})=>({keys:newLaunchKeys(),input:launchInput(raw(extra)),review:terms(),uri:'https://example.com/token.json',publicOrigin:'https://app.example.com'});
function txFor(l,{quote=0n,base=0n,nativeDebit=5600n,rent=0n,err=null}={}){
  const native=l.input.route==='pump'&&l.input.quoteMint===SOL_MINT,owner=l.keys.wallet.address;
  const row=(mint,amount,index)=>({accountIndex:index,owner,mint,uiTokenAmount:{amount:String(amount),decimals:9}});
  const before=1000000000000n,balances=[1000000000,2039280,2039280],after=[1000000000-Number(nativeDebit)+(native?Number(quote):0)-Number(rent),2039280+Number(rent),2039280];
  return{slot:10,transaction:{signatures:['sig'],message:{accountKeys:[pk(owner),pk(newAddress()),pk(newAddress())]}},meta:{err,fee:Number(nativeDebit),preBalances:balances,postBalances:after,preTokenBalances:[row(l.input.quoteMint,before,1),row(l.keys.mint.address,before,2)],postTokenBalances:[row(l.input.quoteMint,before+(native?0n:quote),1),row(l.keys.mint.address,before+base,2)]}};
}
test('Raydium actual quote configuration generates the $20k constant-product curve and 80/20 allocation',()=>{
  const c=rayCurveAtTarget(cfg,9,'100');assert(Math.abs(Number(c.actualUsd)-20000)<.0001);assert.equal(c.supply,'1000000000000000');assert.equal(BigInt(c.sell)*100n/BigInt(c.supply),80n);assert(Number(c.graduationUsd)>Number(c.actualUsd));
  const d=rayCurveAtTarget(cfg,9,'200');assert(BigInt(d.raise)<BigInt(c.raise));assert.throws(()=>rayCurveAtTarget(cfg,0,'100000000','100'),/market cap|coarse/);
});
test('holder weights aggregate wallets, retain dust, and never exceed earned credit',()=>{
  const r=weightedRewards(101n,[{owner:'a',amount:'1'},{owner:'a',amount:'2'},{owner:'b',amount:'1'}]);assert.deepEqual(r.payouts,[{owner:'a',amount:'75'},{owner:'b',amount:'25'}]);assert.equal(r.remainder,'1');assert.equal(weightedRewards(1n,[{owner:'a',amount:'2'},{owner:'b',amount:'2'}]).payouts.length,0);
  assert.throws(()=>launchInput(raw({route:'pump',feeMode:'holders',taxPercent:'1'})),/Raydium/);assert.throws(()=>launchInput(raw({taxPercent:'1'})),/holder/);assert.throws(()=>launchInput(raw({creatorFeePercent:'0.51'})),/0.50/);assert.equal(units('0.000000001'),1n);
});
test('real SDK launch instructions preserve creator fees, quote mint, burned LP and token transfer tax',async()=>{
  const c=new LaunchChain({network:'mainnet-beta',connection:{}}),l=launch();const platform=(await c.launchInstructions(l,'platform'))[0];
  assert.equal(platform.data.readBigUInt64LE(8),0n);assert.equal(platform.data.readBigUInt64LE(16),0n);assert.equal(platform.data.readBigUInt64LE(24),1000000n);assert.equal(platform.keys[6].pubkey.toBase58(),l.keys.wallet.address);
  for(const tax of [0,100]){l.input.taxBps=tax;l.input.feeMode=tax?'holders':'creator';const ix=(await c.launchInstructions(l,'create'))[0];assert(ix.programId.equals(ray.LAUNCHPAD_PROGRAM));assert(ix.keys.some(k=>k.isSigner&&k.pubkey.toBase58()===l.keys.mint.address));assert(ix.keys.some(k=>k.pubkey.toBase58()===SOL_MINT));assert(ix.keys.some(k=>k.pubkey.equals(tax?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID)));
    let at=9;for(let i=0;i<3;i++){const n=ix.data.readUInt32LE(at);at+=4+n;}assert.equal(ix.data[at++],0);assert.equal(ix.data.readBigUInt64LE(at),BigInt(l.review.supply));at+=8;assert.equal(ix.data.readBigUInt64LE(at),BigInt(l.review.sell));at+=8;assert.equal(ix.data.readBigUInt64LE(at),BigInt(l.review.raise));at+=8;assert.equal(ix.data[at],1);
  }
});
test('launchpad accepts only Raydium on mainnet',()=>{assert.throws(()=>launchInput(raw({route:'pump'})),/Raydium/);assert.throws(()=>new LaunchChain({network:'devnet',connection:{}}),/mainnet/);});
test('launch preparation signs exact bytes with only the dedicated keys and simulates before returning a broadcastable operation',async()=>{
  const l=launch(),blockhash=newAddress();let simulated=0;
  const c=new LaunchChain({network:'mainnet-beta',connection:{getLatestBlockhash:async()=>({blockhash,lastValidBlockHeight:100}),simulateTransaction:async tx=>{simulated++;verifySignedTransaction(Buffer.from(tx.serialize()),l.keys.wallet.address,tx.signatures.length===2?[l.keys.mint.address]:[]);return{value:{err:null}};}}});
  for(const stage of ['platform','create']){const op=await c.prepare(l,await c.launchInstructions(l,stage),stage==='create'?[signer(l.keys.mint.secret)]:[]);const tx=deserializeTransaction(Buffer.from(op.raw,'base64'));verifySignedTransaction(Buffer.from(op.raw,'base64'),l.keys.wallet.address,stage==='create'?[l.keys.mint.address]:[]);assert.equal(tx.message.staticAccountKeys[0].toBase58(),l.keys.wallet.address);assert.equal(tx.message.recentBlockhash,blockhash);}
  assert.equal(simulated,2);c.c.simulateTransaction=async()=>({value:{err:{InstructionError:[0,'failure']},logs:[]}});await assert.rejects(c.prepare(l,await c.launchInstructions(l,'platform')),/simulation failed/);
});
test('receipt accounting excludes deposited SOL and ATA rent from Pump fee income',()=>{
  const l=launch();l.input.route='pump';let d=receiptDeltas(txFor(l,{quote:100000n,rent:2039280n}),l);assert.equal(d.quote,100000n);assert.equal(d.gasAndRent,2044880n);
  d=receiptDeltas(txFor(l,{quote:-100000n,base:1234n}),l);assert.equal(d.quote,-100000n);assert.equal(d.base,1234n);assert.equal(d.gasAndRent,5600n);
  l.input.route='raydium';d=receiptDeltas(txFor(l,{quote:100000n}),l);assert.equal(d.quote,100000n);assert.equal(d.gasAndRent,5600n);
});
test('Raydium SOL rewards unwrap only the payout amount and pay native SOL with a bounded transaction',async()=>{
  const l=launch(),blockhash=newAddress(),c=new LaunchChain({network:'mainnet-beta',connection:{getMinimumBalanceForRentExemption:async()=>2039280,getLatestBlockhash:async()=>({blockhash,lastValidBlockHeight:100}),simulateTransaction:async()=>({value:{err:null}})}});
  const recipients=Array.from({length:3},()=>({owner:newAddress(),amount:'10000'})),ixs=await c.payoutInstructions(l,recipients),op=await c.prepare(l,ixs);
  assert.equal(ixs[2].data.readBigUInt64LE(1),30000n);assert.equal(ixs.length,7);assert(Buffer.from(op.raw,'base64').length<=1232);assert.equal(deserializeTransaction(Buffer.from(op.raw,'base64')).signatures.length,1);
});
test('tax rewards wait for Raydium authority handover and recover tax harvested into the mint after graduation',async()=>{
  const l=launch({taxPercent:'1',feeMode:'holders'}),c=new LaunchChain({network:'mainnet-beta',connection:{getProgramAccounts:async()=>({context:{slot:100},value:[]})}}),{w,auth}=c.addresses(l);
  const mintInfo=(authority,bps=100)=>{const data=Buffer.alloc(TransferFeeConfigLayout.span+4);data.writeUInt16LE(ExtensionType.TransferFeeConfig);data.writeUInt16LE(TransferFeeConfigLayout.span,2);const fee={epoch:0n,maximumFee:18446744073709551615n,transferFeeBasisPoints:bps};TransferFeeConfigLayout.encode({transferFeeConfigAuthority:authority,withdrawWithheldAuthority:authority,withheldAmount:30000n,olderTransferFee:fee,newerTransferFee:fee},data,4);return{program:TOKEN_2022_PROGRAM_ID,mint:{tlvData:data}};};
  c.mintInfo=async()=>mintInfo(auth);assert.deepEqual(await c.claimInstructions(l,'tax'),[]);
  c.mintInfo=async()=>mintInfo(w);const ix=await c.claimInstructions(l,'tax');assert.equal(ix.length,2);assert(ix[1].programId.equals(TOKEN_2022_PROGRAM_ID));assert(ix[1].keys[2].pubkey.equals(w));assert.equal(ix[1].data[1],2);
  c.mintInfo=async()=>mintInfo(w,500);await assert.rejects(c.claimInstructions(l,'tax'),/tax differs/);
  c.mintInfo=async()=>mintInfo(pk(newAddress()));await assert.rejects(c.claimInstructions(l,'tax'),/authority differs/);
});
async function managerHarness(t,extra={}){
  // These fixtures isolate creator/holder/buyback receipts. Automatic protocol
  // harvesting has separate integration tests and is not implemented by this
  // fake chain; keep it explicitly off rather than inheriting release defaults.
  const dir=await mkdtemp(join(tmpdir(),'launchpad-launch-')),books=new Map();t.after(()=>rm(dir,{recursive:true,force:true}));const stores=new Map(),payer=newLaunchKeys().wallet,accounts={dir,hostStore:{read:async(key,fallback)=>key==='launch-protocol-fees'?{recipient:'9xQeWvG816bUx9EPbHmaT23yvVMEBBcK4RJaymHMNHpJ',autoHarvest:false}:fallback},get:async()=>({mainWallet:payer.address}),storeFor:id=>{if(!stores.has(id))stores.set(id,{dir:join(dir,id),read:async(k,d)=>structuredClone(k==='main-wallet'?{publicKey:payer.address,privateKey:payer.secret}:books.get(id+':'+k)??d),write:async(k,v)=>books.set(id+':'+k,structuredClone(v))});return stores.get(id);}};
  let clock=Date.now(),receipt=null,prepared=0;const broadcasts=[];
  const chain={c:{getBalance:async()=>1000000000,getBlockHeight:async()=>99},preview:async input=>({...terms(),curvePolicy:input.curvePolicy,graduationTargetUsd:input.graduationTargetUsd,protocolFees:structuredClone(input.protocolFees),platformFeeBps:input.protocolFees?.curveFeeBps||0,creatorFeeRatePpm:input.creatorFeeBps*100,creatorFeePolicy:input.creatorFeePolicy}),launchInstructions:async()=>['instruction'],verifyLaunch:async()=>({curve:newAddress()}),prepare:async()=>({signature:'sig-'+ ++prepared,raw:'exact-signed-bytes',createdAt:clock,lastValidBlockHeight:100,state:'pending'}),broadcast:async op=>{const saved=books.get('a:launchpad').launches[0].operations;assert(saved.some(x=>x.signature===op.signature&&x.raw===op.raw));broadcasts.push(op.signature);if(extra.timeout)throw Error('timeout');},receipt:async()=>receipt,holderRewardReference:async l=>({mint:l.input.quoteMint,usd:'100',at:clock}),claimInstructions:async()=>[],holderSnapshot:async()=>({slot:9,rows:[]}),swapFeeInstructions:async()=>['swap'],burnInstructions:async()=>['burn'],payoutInstructions:async()=>['payout']};
  const manager=new Launchpad(accounts,null,{chainFactory:()=>chain,metadataStorage:{prepare:async()=>({uri:'https://gateway.irys.xyz/'+'a'.repeat(43),imageUrl:'https://gateway.irys.xyz/'+'b'.repeat(43),metadata:{},storage:{provider:'irys',budget:'0',items:[]}}),upload:async()=>true},now:()=>clock});manager.kick=()=>{};t.after(()=>manager.close());
  const image=await manager.uploadImage('a','iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=');let created=await manager.create('a',raw({...extra.input,...(extra.input?.feeMode==='buyback'?{feeMode:'creator'}:{}),imageId:image.imageId}));
  // Buyback cases exercise saved legacy journals. Future public creation is
  // intentionally unavailable, so seed only the test's stored fixture.
  if(extra.input?.feeMode==='buyback'){const book=await manager.book('a'),saved=book.launches[0];saved.input.feeMode='buyback';saved.input.recipient='';saved.input.autoFees=true;await manager.save('a',book);created={...created,input:structuredClone(saved.input)};}
  return{manager,chain,created,books,broadcasts,get stored(){return books.get('a:launchpad').launches[0];},get prepared(){return prepared;},set receipt(v){receipt=v;},advance(ms){clock+=ms;}};
}
test('new metadata snapshots use configured coin pages while refresh and draft reuse retain creator intent',async t=>{
  const h=await managerHarness(t),signed=[];let next=0;h.manager.publicUrl='https://launchpad.example/';
  h.manager.metadataStorage=new LaunchMetadataStorage({clientFactory:async()=>({createTransaction:(data)=>{const id=String(++next).padStart(43,'a');return{id,sign:async()=>signed.push(Buffer.from(data)),getPrice:async()=>({toFixed:()=> '0'}),getRaw:()=>Buffer.from(id)};}})});
  const details=raw({imageId:h.created.input.imageId,website:' ',publicOrigin:'https://attacker.example',host:'attacker.example'}),prepared=await h.manager.prepare('a',details);
  const created=await h.manager.create('a',{...details,prepareId:prepared.prepareId}),website='https://launchpad.example/coin?mint='+created.mint,metadata=await h.manager.metadata(created.mint);
  assert.equal(created.mint,prepared.mint);assert.equal(metadata.website,website);assert.equal(metadata.external_url,website);assert.equal(metadata.extensions.website,website);assert.deepEqual(created.input.links,{});assert.deepEqual(JSON.parse(signed[1]),metadata);
  const snapshot=structuredClone((await h.manager.book('a')).launches.find(l=>l.id===created.id));
  h.manager.publicUrl='https://next-launch.example';const refreshed=await h.manager.refresh('a',created.id);
  assert.equal(refreshed.uri,created.uri);assert.deepEqual(await h.manager.metadata(created.mint),metadata);assert.deepEqual((await h.manager.book('a')).launches.find(l=>l.id===created.id).storage,snapshot.storage);assert.equal(signed.length,3);
  const reused=await h.manager.create('a',{...details,website:created.input.links.website}),reusedMetadata=await h.manager.metadata(reused.mint);
  assert.notEqual(reused.mint,created.mint);assert.equal(reusedMetadata.website,'https://next-launch.example/coin?mint='+reused.mint);
  const custom=await h.manager.create('a',{...details,website:'creator.example/project'}),customMetadata=await h.manager.metadata(custom.mint);
  assert.equal(customMetadata.website,'https://creator.example/project');assert.equal(customMetadata.external_url,customMetadata.website);assert.equal(customMetadata.extensions.website,customMetadata.website);assert.equal(custom.input.links.website,customMetadata.website);
});
test('launch authorization is scoped, never exports keys in status, journals before broadcast and reconciles timeout with the same signature',async t=>{
  const h=await managerHarness(t,{timeout:true});assert(!JSON.stringify(h.created).includes(h.stored.keys.wallet.secret));await assert.rejects(h.manager.action('b',h.created.id,'launch',{confirm:true,reviewHash:h.created.reviewHash}),/not found/);
  await assert.rejects(h.manager.action('a',h.created.id,'launch',{confirm:true,reviewHash:'wrong'}),/expired|changed/);
  await h.manager.action('a',h.created.id,'launch',{confirm:true,reviewHash:h.created.reviewHash});await h.manager.process('a');assert.equal(h.prepared,1);assert.equal(h.stored.operations[0].state,'pending');
  h.advance(16000);await h.manager.process('a');assert.deepEqual(h.broadcasts,['sig-1','sig-1']);assert.equal(h.prepared,1);
  h.receipt=txFor(h.stored);await h.manager.process('a');assert.equal(h.stored.phase,'create');assert.equal(h.stored.operations[0].state,'confirmed');await h.manager.process('a');assert.equal(h.prepared,2);
});
test('buyback uses only claimed credit, burns purchased supply, and pause never submits another step',async t=>{
  const h=await managerHarness(t,{input:{feeMode:'buyback'}});let b=structuredClone(h.books.get('a:launchpad')),l=b.launches[0];l.state='live';l.curve='curve';l.authorizedAt=1;l.feesRequested=true;l.credits.quote='10000000';l.cycle={stage:'distribute',index:0};h.books.set('a:launchpad',b);
  await h.manager.process('a');assert.equal(h.stored.operations[0].amount,'10000000');assert.equal(h.stored.operations[0].kind,'buy');h.receipt=txFor(h.stored,{quote:-10000000n,base:9000n});await h.manager.process('a');assert.equal(h.stored.credits.quote,'0');assert.equal(h.stored.credits.base,'9000');assert.equal(h.stored.gas.reserved,'5600');
  await h.manager.action('a',h.created.id,'pause');await h.manager.process('a');assert.equal(h.prepared,1);await h.manager.action('a',h.created.id,'resume');await h.manager.process('a');assert.equal(h.stored.operations[1].kind,'burn');assert.equal(h.stored.operations[1].amount,'9000');
  h.receipt=txFor(h.stored,{base:-9000n});await h.manager.process('a');await h.manager.process('a');assert.equal(h.stored.credits.base,'0');assert.equal(h.prepared,2);
});
test('confirmed failures pause automation; unresolved receipts never cause replacement signatures',async t=>{
  const h=await managerHarness(t);await h.manager.action('a',h.created.id,'launch',{confirm:true,reviewHash:h.created.reviewHash});await h.manager.process('a');h.advance(180001);await h.manager.process('a');assert.equal(h.prepared,1);assert.equal(h.stored.autoFees,false);assert.match(h.stored.error,/unresolved/);
  h.receipt=txFor(h.stored,{err:{InstructionError:[0,'fail']}});await h.manager.process('a');assert.equal(h.stored.state,'error');assert.equal(h.stored.operations[0].state,'failed');await h.manager.process('a');assert.equal(h.prepared,1);
});
test('host shutdown during the launch journal write prevents its subsequent broadcast',async t=>{
  const h=await managerHarness(t),save=h.manager.save.bind(h.manager);
  await h.manager.action('a',h.created.id,'launch',{confirm:true,reviewHash:h.created.reviewHash});
  h.manager.save=async(id,book)=>{await save(id,book);if(book.launches.some(l=>l.operations.some(o=>o.state==='pending')))void h.manager.close();};
  await h.manager.process('a');assert.equal(h.prepared,1);assert.equal(h.stored.operations[0].state,'pending');assert.equal(h.broadcasts.length,0);
});
test('default developer signs creation, managed fee authority stays separate, and a 10% buy is atomic',async()=>{
  for(const taxPercent of ['0','3']){
    const l=launch({feeMode:'holders',taxPercent,devBuyPercent:'10'}),payer=newLaunchKeys().wallet;l.keys.payer=payer;l.keys.platform=l.keys.wallet;
    const c=new LaunchChain({network:'mainnet-beta',connection:{getMinimumBalanceForRentExemption:async()=>2039280,getLatestBlockhash:async()=>({blockhash:newAddress(),lastValidBlockHeight:100}),simulateTransaction:async(tx,config)=>{assert.equal(config.sigVerify,true);verifySignedTransaction(Buffer.from(tx.serialize()),payer.address,[l.keys.mint.address]);return{value:{err:null,unitsConsumed:420000}};}}});
    l.review.devBuy=await c.devBuyEstimate(l.input,l.review,{mint:{tlvData:Buffer.alloc(0)}});
    assert.equal(l.review.devBuy.gross,'100000000000000');assert.equal(l.review.devBuy.net,taxPercent==='3'?'97000000000000':'100000000000000');
    const ixs=await c.launchInstructions(l,'create');assert(ixs[0].programId.equals(ray.LAUNCHPAD_PROGRAM));assert.equal(ixs[0].keys[0].pubkey.toBase58(),payer.address);
    const buy=ixs.find(ix=>ix.programId.equals(ray.LAUNCHPAD_PROGRAM)&&ix.data.length===32);
    assert(buy);assert.equal(buy.keys[0].pubkey.toBase58(),payer.address);assert.equal(buy.data.readBigUInt64LE(8),BigInt(l.review.devBuy.net));assert.equal(buy.data.readBigUInt64LE(16),BigInt(l.review.devBuy.maxQuote));
    assert(buy.keys.some(k=>k.pubkey.equals(ray.getPdaCreatorVault(ray.LAUNCHPAD_PROGRAM,pk(l.keys.wallet.address),pk(SOL_MINT)).publicKey)));
    const op=await c.prepare(l,ixs,[signer(l.keys.mint.secret)],true),tx=deserializeTransaction(Buffer.from(op.raw,'base64'));assert.equal(tx.signatures.length,2);assert(Buffer.from(op.raw,'base64').length<=4096);
    assert.equal(tx.message.compiledInstructions.filter(ix=>tx.message.staticAccountKeys[ix.programIdIndex].equals(ray.LAUNCHPAD_PROGRAM)).length,2);
    l.review.devBuy.gross='100000000000001';await assert.rejects(c.launchInstructions(l,'create'),/limit/);
  }
});
test('developer buy boundaries and removed controls cannot override automatic settings',()=>{
  for(const target of ['100','50000'])assert.equal(launchInput(raw({targetUsd:target})).targetUsd,target);
  for(const target of ['99','50001'])assert.throws(()=>launchInput(raw({targetUsd:target})),/market cap/);
  for(const amount of ['10.01','11','-1','1e2'])assert.throws(()=>launchInput(raw({devBuyPercent:amount})),/Developer buy/);
  const input=launchInput(raw({devBuyPercent:'10',metadataUri:'https://evil.example/meta',quoteUsd:'1',dailyGasSol:'9999',autoFees:false,image:'https://evil.example/p.png'}));
  assert.equal(input.devBuyRaw,'100000000000000');assert.equal(input.autoFees,true);assert.equal(input.dailyGasLamports,'30000000');assert.equal(input.metadataUri,undefined);assert.equal(input.quoteUsd,undefined);assert.equal(input.image,undefined);
});
test('creator launches retain the account payer and use separate fee authorities and platform addresses',async t=>{
  const h=await managerHarness(t),first=h.stored;assert.notEqual(first.keys.wallet.address,first.keys.payer.address);assert.equal(first.input.recipient,first.keys.payer.address);assert.notEqual(first.keys.platform.address,first.keys.payer.address);
  const second=await h.manager.create('a',raw({imageId:first.input.imageId,symbol:'SECOND'})),book=await h.manager.book('a');
  assert.equal(second.developerWallet,h.created.developerWallet);assert.notEqual(book.launches[0].keys.platform.address,book.launches[1].keys.platform.address);
  const c=new LaunchChain({network:'mainnet-beta',connection:{}});assert(!c.addresses(book.launches[0]).platform.equals(c.addresses(book.launches[1]).platform));
  const managed=await h.manager.create('a',raw({imageId:first.input.imageId,feeMode:'holders'}));assert.notEqual(managed.wallet,managed.developerWallet);assert.equal(managed.developerWallet,second.developerWallet);
  const publicData=JSON.stringify(await h.manager.read('a'));for(const l of (await h.manager.book('a')).launches)for(const key of Object.values(l.keys))assert(!publicData.includes(key.secret));
});
test('review idempotence refuses altered inputs and retains the original keys',async t=>{
  const h=await managerHarness(t),requestId='11111111-1111-4111-8111-111111111111',input=raw({requestId,imageId:h.stored.input.imageId});
  const a=await h.manager.create('a',input),b=await h.manager.create('a',input);assert.equal(a.id,b.id);assert.equal(a.mint,b.mint);
  await assert.rejects(h.manager.create('a',{...input,devBuyPercent:'10'}),/different launch/);
});
test('creating again after paid setup returns saved progress despite a newly prepared review',async t=>{
  const h=await managerHarness(t),input=raw({requestId:'33333333-3333-4333-8333-333333333333',imageId:h.stored.input.imageId,walletMode:'external',externalWallet:newAddress()});
  const first=await h.manager.prepare('a',input),created=await h.manager.create('a',{...input,prepareId:first.prepareId});
  const book=await h.manager.book('a'),saved=book.launches.find(l=>l.id===created.id);
  saved.state='awaiting_signature';saved.authorizedAt=1;saved.phase='create';saved.operations=[{kind:'setup',state:'confirmed',signature:'paid-setup'},{kind:'create',state:'awaiting_signature',operationId:'create-only',unsignedRaw:'saved-create',externalSigner:input.externalWallet}];await h.manager.save('a',book);
  const fresh=await h.manager.prepare('a',input);assert.notEqual(fresh.reviewHash,first.reviewHash);assert.notEqual(fresh.mint,first.mint);
  const repeated=await h.manager.create('a',{...input,prepareId:fresh.prepareId});
  assert.equal(repeated.id,created.id);assert.equal(repeated.mint,created.mint);assert.equal(repeated.reviewHash,first.reviewHash);assert.equal(repeated.pendingSignature.operationId,'create-only');assert.equal(repeated.operations[0].signature,'paid-setup');assert.equal((await h.manager.book('a')).launches.length,2);assert.equal(h.prepared,0);assert.equal(h.broadcasts.length,0);
  await assert.rejects(h.manager.create('a',{...input,name:'Different launch',prepareId:fresh.prepareId}),/different launch details/);
});
test('native creator payouts unwrap in place and count their actual gas cost',async()=>{
  const l=launch(),c=new LaunchChain({network:'mainnet-beta',connection:{getMinimumBalanceForRentExemption:async()=>2039280}});
  const ix=await c.payoutInstructions(l,[{owner:l.keys.wallet.address,amount:'1000000'}]);assert.equal(ix.length,4);
  const receipt=txFor(l,{quote:-1000000n,nativeDebit:5600n-1000000n});assert.equal(receiptDeltas(receipt,l,{selfPayout:1000000n}).gasAndRent,5600n);
});
test('quote purchases reject mismatched assets, insufficient output, unexpected signers and excess slippage',async()=>{
  const l=launch({quoteMint:USDC_MINT,devBuyPercent:'1'});l.review.devBuy={gross:l.input.devBuyRaw,net:l.input.devBuyRaw,maxQuote:'1000000',solBudget:'10000000'};
  const instruction={programId:'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',accounts:[{pubkey:l.keys.wallet.address,isSigner:true,isWritable:true}],data:Buffer.from([1]).toString('base64')};
  let body={inputMint:SOL_MINT,outputMint:USDC_MINT,inAmount:'10000000',outAmount:'1100000',otherAmountThreshold:'1089000',slippageBps:100,priceImpactPct:'.001',swapInstruction:instruction};
  const c=new LaunchChain({network:'mainnet-beta',connection:{},fetcher:async()=>new Response(JSON.stringify(body))});c.jupiterGate={acquire:async()=>{}};
  assert.equal((await c.quoteFundingInstructions(l)).length,1);const good=structuredClone(body);
  for(const changes of [{inputMint:USDC_MINT},{inAmount:'10000001'},{otherAmountThreshold:'999999'},{slippageBps:101},{priceImpactPct:'.03'},{tipInstruction:{}},{swapInstruction:{...instruction,accounts:[{pubkey:newAddress(),isSigner:true}]}}]){body={...good,...changes};await assert.rejects(c.quoteFundingInstructions(l));}
});
test('a connected wallet is never asked to sign a pair purchase that reads the instruction list: one retry without the route’s DEXes, then a clear refusal (v71.34)',async()=>{
  const SYSVAR='Sysvar1nstructions1111111111111111111111111',l=launch({quoteMint:USDC_MINT,devBuyPercent:'1'});l.keys.payer={...l.keys.wallet,external:true};l.review.devBuy={gross:l.input.devBuyRaw,net:l.input.devBuyRaw,maxQuote:'1000000',solBudget:'10000000'};
  const payer=(l.keys.payer||l.keys.wallet).address,swap=(keys=[])=>({programId:'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',accounts:[{pubkey:payer,isSigner:true,isWritable:true},...keys.map(pubkey=>({pubkey,isSigner:false,isWritable:false}))],data:Buffer.from([1]).toString('base64')});
  const base={inputMint:SOL_MINT,outputMint:USDC_MINT,inAmount:'10000000',outAmount:'1100000',otherAmountThreshold:'1089000',slippageBps:100,priceImpactPct:'.001'};
  const requests=[];let bodies=[];
  const c=new LaunchChain({network:'mainnet-beta',connection:{},fetcher:async url=>{requests.push(new URL(url));return new Response(JSON.stringify(bodies.shift()));}});c.jupiterGate={acquire:async()=>{}};
  // The first route reads the sysvar through an RFQ-style step; the retry without that DEX is clean and is the one prepared.
  bodies=[{...base,routePlan:[{swapInfo:{label:'Jupiter Z'}}],swapInstruction:swap([SYSVAR])},{...base,routePlan:[{swapInfo:{label:'Raydium'}}],swapInstruction:swap()}];
  assert.equal((await c.quoteFundingInstructions(l)).length,1);
  assert.equal(requests.length,2);assert.equal(requests[0].searchParams.get('excludeDexes'),null);assert.equal(requests[1].searchParams.get('excludeDexes'),'Jupiter Z');assert.equal(requests[1].searchParams.get('taker'),payer);
  // The sysvar hidden in a lookup table counts too; when every route needs it the step is refused before any signature, retryable.
  requests.length=0;bodies=[{...base,routePlan:[{swapInfo:{label:'Obric V2'}}],swapInstruction:swap(),addressesByLookupTableAddress:{[newAddress()]:[SYSVAR,newAddress()]}},{...base,routePlan:[{swapInfo:{label:'Whirlpool'}}],swapInstruction:swap([SYSVAR])}];
  await assert.rejects(c.quoteFundingInstructions(l),error=>error.code==='LAUNCH_FUNDING_INTROSPECTION'&&error.retryable===true&&/reads the transaction’s own instruction list/.test(error.message)&&/Nothing was signed or spent/.test(error.message)&&/USDC/.test(error.message));
  assert.equal(requests.length,2,'exactly one retry');
  // A route with no DEX labels cannot be retried: refused at once.
  requests.length=0;bodies=[{...base,routePlan:[],swapInstruction:swap([SYSVAR])}];
  await assert.rejects(c.quoteFundingInstructions(l),/instruction list/);assert.equal(requests.length,1);
  // A Launchpad-managed payer signs unchanged, so an introspecting route is fine for it.
  requests.length=0;l.keys.payer={...l.keys.wallet,external:false};bodies=[{...base,routePlan:[{swapInfo:{label:'Jupiter Z'}}],swapInstruction:swap([SYSVAR])}];
  assert.equal((await c.quoteFundingInstructions(l)).length,1);assert.equal(requests.length,1);
});
test('a review for a connected wallet refuses a pair whose every purchase route needs instruction introspection, before anything is paid (v71.34)',async()=>{
  const SYSVAR='Sysvar1nstructions1111111111111111111111111',wallet=newAddress();
  const l=launch({quoteMint:USDC_MINT,devBuySol:'0.05',walletMode:'external',externalWallet:wallet});
  const quote={inputMint:SOL_MINT,outputMint:USDC_MINT,inAmount:'50000000',outAmount:'1100000',otherAmountThreshold:'1000000',swapMode:'ExactIn',slippageBps:100,priceImpactPct:'.001',routePlan:[{}]};
  const swap=keys=>({programId:'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',accounts:[{pubkey:wallet,isSigner:true,isWritable:true},...keys.map(pubkey=>({pubkey,isSigner:false,isWritable:false}))],data:Buffer.from([1]).toString('base64')});
  const build=keys=>({...quote,inAmount:'50000000',routePlan:[{swapInfo:{label:'Jupiter Z'}}],swapInstruction:swap(keys)});
  const urls=[];let builds=[];
  const c=new LaunchChain({network:'mainnet-beta',connection:{getEpochInfo:async()=>({epoch:1})},fetcher:async url=>{urls.push(url);return new Response(JSON.stringify(url.includes('/swap/v1/quote')?quote:builds.shift()));}});c.jupiterGate={acquire:async()=>{},cooldown:()=>{}};
  builds=[build([SYSVAR]),build([SYSVAR])];
  await assert.rejects(c.devBuyEstimate(l.input,l.review,{mint:{tlvData:Buffer.alloc(0)}}),/Launchpad can’t buy USDC for this launch with a swap your connected wallet signs.*Launch without a dev buy, or pair with SOL or another asset/);
  assert.deepEqual(urls.map(u=>new URL(u).pathname),['/swap/v1/quote','/swap/v2/build','/swap/v2/build']);
  // A clean retry route (or any clean route) passes the review with the 5% drift allowance applied.
  urls.length=0;builds=[build([SYSVAR]),build([])];
  const d=await c.devBuyEstimate(l.input,l.review,{mint:{tlvData:Buffer.alloc(0)}});
  assert.equal(d.quoteBudget,'950000');assert.equal(d.routeMinimumQuote,'1000000');assert.equal(d.quoteDriftBps,500);
  // A managed launch wallet never builds at review: Launchpad signs the purchase unchanged.
  urls.length=0;const managed=launch({quoteMint:USDC_MINT,devBuySol:'0.05'});
  await c.devBuyEstimate(managed.input,managed.review,{mint:{tlvData:Buffer.alloc(0)}});assert.deepEqual(urls.map(u=>new URL(u).pathname),['/swap/v1/quote']);
});
test('a developer buy cannot be marked live from a receipt for the wrong wallet',async t=>{
  const h=await managerHarness(t),b=await h.manager.book('a'),l=b.launches[0];l.state='launching';l.review.devBuy={gross:'100',net:'100',solBudget:'1'};l.operations=[{kind:'create',state:'pending',signature:'sig',createdAt:Date.now()}];await h.manager.save('a',b);
  const tx=txFor(l,{base:99n});h.receipt=tx;await h.manager.process('a');assert.match(h.stored.error,/developer buy receipt/);assert.equal(h.stored.operations[0].state,'pending');assert.notEqual(h.stored.state,'live');
});
test('funding simulation verifies actual quote delivery and blocks SOL overspending before broadcast',async()=>{
  const {AccountLayout}=await import('@solana/spl-token'),{SystemProgram}=await import('@solana/web3.js');const l=launch({quoteMint:USDC_MINT,devBuyPercent:'1'}),wallet=signer(l.keys.wallet.secret),token=Buffer.alloc(AccountLayout.span);l.review.devBuy={maxQuote:'1000000',solBudget:'10000000'};
  const fill=amount=>AccountLayout.encode({mint:pk(USDC_MINT),owner:wallet.publicKey,amount,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},token);fill(1000000n);
  let debit=10005000;const c=new LaunchChain({network:'mainnet-beta',connection:{getLatestBlockhash:async()=>({blockhash:newAddress(),lastValidBlockHeight:99}),getMultipleAccountsInfoAndContext:async()=>({context:{slot:40},value:[{owner:SystemProgram.programId,lamports:1000000000},null]}),simulateTransaction:async(_,config)=>{assert.equal(config.minContextSlot,40);assert.equal(config.accounts.addresses[0],wallet.publicKey.toBase58());return{value:{err:null,accounts:[{owner:SystemProgram.programId.toBase58(),lamports:1000000000-debit},{owner:TOKEN_PROGRAM_ID.toBase58(),data:[token.toString('base64'),'base64']}]}};}}});
  const instructions=[SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:pk(newAddress()),lamports:1})];assert((await c.prepare(l,instructions,[],'quote-fund')).raw);
  debit=17000000;await assert.rejects(c.prepare(l,instructions,[],'quote-fund'),/SOL budget/);debit=10005000;fill(999999n);await assert.rejects(c.prepare(l,instructions,[],'quote-fund'),/enough pairing tokens/);
});

test('connected launch wallet stores only its public address and preserves managed fee identities',async t=>{
  const address=newAddress(),h=await managerHarness(t,{input:{walletMode:'external',externalWallet:address}});
  assert.deepEqual(h.stored.keys.payer,{address,external:true});assert.notEqual(h.stored.keys.wallet.address,address);assert.equal(h.stored.feeCustody,'relay');assert(h.stored.keys.wallet.secret);assert.equal(h.stored.input.recipient,address);
  assert.notEqual(h.stored.keys.platform.address,address);assert(h.stored.keys.platform.secret);
  assert.equal(h.created.walletMode,'external');assert.equal(h.created.developerWallet,address);assert.equal(h.stored.input.autoFees,false);
  await assert.rejects(h.manager.exportWallet('a',h.created.id),/cannot be exported/);
  const managed=await h.manager.create('a',raw({imageId:h.stored.input.imageId,walletMode:'external',externalWallet:address,feeMode:'holders'}));
  assert.notEqual(managed.wallet,address);assert.equal(managed.developerWallet,address);assert.equal(managed.input.autoFees,true);
  assert.throws(()=>launchInput(raw({walletMode:'external'})),/Connect/);
  await assert.rejects(h.manager.create('a',raw({imageId:h.stored.input.imageId,walletMode:'external',externalWallet:PublicKey.findProgramAddressSync([Buffer.from('test')],ray.LAUNCHPAD_PROGRAM)[0].toBase58()})),/valid Solana wallet/);
});

test('legacy connected launch resumes its original signing sequence without repeated broadcasts',async t=>{
  const h=await managerHarness(t,{input:{walletMode:'external',externalWallet:newAddress()}});let prepared=0;
  const legacy=await h.manager.book('a');delete legacy.launches[0].executionPlan;await h.manager.save('a',legacy);
  h.chain.prepare=async()=>({needsSignature:true,state:'awaiting_signature',unsignedRaw:'partial-bytes',externalSigner:h.created.developerWallet,createdAt:Date.now(),lastValidBlockHeight:100});
  const prep=h.chain.prepare;h.chain.prepare=async()=>{prepared++;return prep();};
  h.chain.acceptSigned=async(op,transaction)=>{assert.equal(transaction,'approved-by-wallet');return{...op,needsSignature:false,state:'pending',signature:'connected-signature',raw:'signed-bytes',createdAt:Date.now()};};
  await h.manager.action('a',h.created.id,'launch',{confirm:true,reviewHash:h.created.reviewHash});
  await h.manager.process('a');const op=h.stored.operations[0];
  assert.equal(h.stored.state,'awaiting_signature');assert.equal(h.broadcasts.length,0);assert.equal(op.kind,'platform');
  const view=(await h.manager.read('a')).launches[0];assert.deepEqual(view.pendingSignature,{operationId:op.operationId,kind:'platform',transaction:'partial-bytes',wallet:h.created.developerWallet});
  await h.manager.process('a');await h.manager.action('a',h.created.id,'resume',{autoFees:true});await h.manager.process('a');assert.equal(prepared,1);assert.equal(h.stored.autoFees,false);
  await assert.rejects(h.manager.sign('b',h.created.id,op.operationId,'approved-by-wallet'),/not found/);
  await assert.rejects(h.manager.sign('a',h.created.id,'wrong-operation','approved-by-wallet'),/not found/);
  await h.manager.sign('a',h.created.id,op.operationId,'approved-by-wallet');assert.deepEqual(h.broadcasts,['connected-signature']);assert.equal(h.stored.operations[0].unsignedRaw,undefined);
  await h.manager.sign('a',h.created.id,op.operationId,'approved-by-wallet');assert.deepEqual(h.broadcasts,['connected-signature']);
  assert.equal((await h.manager.read('a')).launches[0].pendingSignature,null);
  h.receipt=txFor(h.stored);await h.manager.process('a');assert.equal(h.stored.phase,'create');assert.equal(h.stored.operations[0].state,'confirmed');
});

test('rejected or changed connected signatures leave the saved request untouched',async t=>{
  const h=await managerHarness(t,{input:{walletMode:'external',externalWallet:newAddress()}});
  h.chain.prepare=async()=>({needsSignature:true,state:'awaiting_signature',unsignedRaw:'partial',externalSigner:h.created.developerWallet,createdAt:Date.now(),lastValidBlockHeight:100});
  h.chain.acceptSigned=async()=>{throw Error('Signed transaction changed.');};
  await h.manager.action('a',h.created.id,'launch',{confirm:true,reviewHash:h.created.reviewHash});await h.manager.process('a');
  const before=structuredClone(h.stored);await assert.rejects(h.manager.sign('a',h.created.id,before.operations[0].operationId,'changed'),/changed/);
  assert.deepEqual(h.stored,before);assert.equal(h.broadcasts.length,0);
});

test('wallet guard co-signers are limited to the original saved launch step and never exposed publicly',async t=>{
  const h=await managerHarness(t,{input:{walletMode:'external',externalWallet:newAddress()}});
  await h.manager.action('a',h.created.id,'launch',{confirm:true,reviewHash:h.created.reviewHash});
  const original=structuredClone(h.books.get('a:launchpad'));
  for(const [kind,executionPlan,which] of [['create','compact-v3',['mint']],['setup','compact-v2',['platform']],['platform',undefined,['platform']],['launch-all','compact-v3',['mint','platform']]]){
    const book=structuredClone(original),l=book.launches[0];l.executionPlan=executionPlan;l.phase=kind;l.state='awaiting_signature';
    const op={operationId:'guard-'+kind,kind,state:'awaiting_signature',needsSignature:true,unsignedRaw:'partial',externalSigner:l.keys.payer.address};l.operations=[op];h.books.set('a:launchpad',book);
    const required=which.map(key=>l.keys[key].address);let callbacks=0;
    h.chain.acceptSigned=async(saved,transaction,{resolveAdditionalSigners})=>{
      assert.equal(saved.operationId,op.operationId);assert.equal(transaction,'approved-with-guard');callbacks++;
      assert.throws(()=>resolveAdditionalSigners([newAddress()]),/invalid Launchpad signer set/);
      assert.throws(()=>resolveAdditionalSigners([...required,newAddress()]),/invalid Launchpad signer set/);
      const signers=resolveAdditionalSigners(required);assert.deepEqual(signers.map(key=>key.publicKey.toBase58()).sort(),required.sort());
      return{...saved,state:'pending',needsSignature:false,signature:'guard-signed-'+kind,raw:'guard-bytes'};
    };
    const result=await h.manager.sign('a',l.id,op.operationId,'approved-with-guard');assert.equal(callbacks,1);
    for(const key of Object.values(l.keys))if(key.secret)assert(!JSON.stringify(result).includes(key.secret));
    assert.equal(h.stored.operations[0].raw,'guard-bytes');assert.equal(h.stored.operations[0].unsignedRaw,undefined);
  }
});

test('wallet guard co-signing rejects stale phases, live reward requests, and unrelated key requests without saving',async t=>{
  const h=await managerHarness(t,{input:{walletMode:'external',externalWallet:newAddress()}});await h.manager.action('a',h.created.id,'launch',{confirm:true,reviewHash:h.created.reviewHash});
  const original=structuredClone(h.books.get('a:launchpad'));
  for(const changes of [{phase:'setup',kind:'create'},{phase:'claim',kind:'claim',curve:'live-curve'},{phase:'setup',kind:'setup',executionPlan:'compact-v3'},{phase:'burn',kind:'burn'}]){
    const book=structuredClone(original),l=book.launches[0];Object.assign(l,changes,{state:'awaiting_signature'});
    l.operations=[{operationId:'guard-invalid',kind:changes.kind,state:'awaiting_signature',needsSignature:true,unsignedRaw:'partial',externalSigner:l.keys.payer.address}];h.books.set('a:launchpad',book);const before=structuredClone(h.stored);
    h.chain.acceptSigned=async(saved,input,{resolveAdditionalSigners})=>{resolveAdditionalSigners([l.keys.mint.address]);throw Error('Unreachable');};
    await assert.rejects(h.manager.sign('a',l.id,'guard-invalid','guard-bytes'),/cannot be co-signed|invalid Launchpad signer set/);assert.deepEqual(h.stored,before);
  }
  assert.equal(h.broadcasts.length,0);
});

test('only an expired unsigned wallet request may be regenerated',async t=>{
  const h=await managerHarness(t,{input:{walletMode:'external',externalWallet:newAddress()}});
  h.chain.prepare=async()=>({needsSignature:true,state:'awaiting_signature',unsignedRaw:'partial',messageHash:'hash',externalSigner:h.created.developerWallet,createdAt:Date.now(),lastValidBlockHeight:100});
  await h.manager.action('a',h.created.id,'launch',{confirm:true,reviewHash:h.created.reviewHash});await h.manager.process('a');const op=h.stored.operations[0];
  const fresh=await h.manager.signature('a',h.created.id,op.operationId);assert.equal(fresh.pendingSignature.operationId,op.operationId);
  h.chain.c.getBlockHeight=async()=>101;const expired=await h.manager.signature('a',h.created.id,op.operationId);assert.equal(expired.pendingSignature,null);assert.equal(h.stored.operations[0].state,'expired');assert.equal(h.stored.operations[0].unsignedRaw,undefined);
  await h.manager.process('a');assert.equal(h.stored.operations.length,2);assert.notEqual(h.stored.operations[1].operationId,op.operationId);assert.equal(h.broadcasts.length,0);
  await assert.rejects(h.manager.sign('a',h.created.id,op.operationId,'old'),/no longer active/);
});

test('external image funding credits the managed signer before its own storage payment',async t=>{
  const h=await managerHarness(t,{input:{walletMode:'external',externalWallet:newAddress()}});
  const original=h.manager.metadataStorage.prepare;
  h.manager.metadataStorage.prepare=async(...args)=>({...await original(...args),storage:{provider:'irys',budget:'1000000',recipient:newAddress(),items:[]}});
  const v=await h.manager.create('a',raw({imageId:h.stored.input.imageId,walletMode:'external',externalWallet:newAddress(),symbol:'SECOND'}));
  let book=await h.manager.book('a'),l=book.launches.find(x=>x.id===v.id);assert.equal(l.phase,'setup');assert.equal(l.review.storageSol,'0.001');assert.equal(v.review.storageSol,undefined);assert.equal(v.review.launchFeesSol,'0.061075');assert.equal(l.review.minimumSol,'0.061075');
  l.state='launching';l.operations=[{kind:'setup',state:'pending',signature:'credit',createdAt:Date.now()}];await h.manager.save('a',book);
  h.receipt=txFor(l);await h.manager.process('a');book=await h.manager.book('a');l=book.launches.find(x=>x.id===v.id);assert.equal(l.phase,'platform-setup');
});


test('SOL token estimates are account-scoped, coalesced, bounded by time and have no launch side effects',async t=>{
  const h=await managerHarness(t),before=structuredClone(h.books),calls=[];
  let release;const gate=new Promise(resolve=>{release=resolve;});
  h.chain.preview=async input=>{calls.push(input);await gate;return {...terms(),devBuy:{gross:'900000000000',net:'900000000000',maxQuote:'10000000',solBudget:input.devBuyLamports}};};
  const input={devBuySol:'.01',quoteMint:SOL_MINT,targetUsd:'20000',walletMode:'external',externalWallet:'invalid',imageId:'not-an-image'};
  const a=h.manager.estimate('a',input),b=h.manager.estimate('a',input);release();
  const [one,two]=await Promise.all([a,b]);assert.deepEqual(one,two);assert.equal(calls.length,1);assert.equal(one.solBudget,'10000000');assert.equal(calls[0].walletMode,'default');assert.equal(calls[0].imageId,'');
  one.net='tampered';assert.equal((await h.manager.estimate('a',input)).net,'900000000000');assert.equal(calls.length,1);
  await h.manager.estimate('b',input);assert.equal(calls.length,2);
  h.advance(15001);await h.manager.estimate('a',input);assert.equal(calls.length,3);
  assert.deepEqual(await h.manager.estimate('a',{devBuySol:'0'}),{gross:'0',net:'0',maxQuote:'0',solBudget:'0',asOf:one.asOf+15001});assert.equal(calls.length,3);
  await assert.rejects(h.manager.estimate('a',{...input,devBuySol:'-1'}),/Developer buy/);
  assert.deepEqual(h.books,before);assert.equal(h.broadcasts.length,0);assert.equal(h.prepared,0);
});

test('failed estimate requests are not cached and do not block later estimates',async t=>{
  const h=await managerHarness(t);let calls=0;
  h.chain.preview=async input=>{calls++;if(calls===1)throw Error('Quote unavailable');return {...terms(),devBuy:{gross:'1',net:'1',maxQuote:'1',solBudget:input.devBuyLamports}};};
  await assert.rejects(h.manager.estimate('a',{devBuySol:'.01'}),/Quote unavailable/);
  assert.equal(h.manager.pendingEstimates.size,0);assert.equal((await h.manager.estimate('a',{devBuySol:'.01'})).solBudget,'10000000');assert.equal(calls,2);
});


test('compact launch checks the complete reviewed balance before any paid setup',async t=>{
 const h=await managerHarness(t,{input:{walletMode:'external',externalWallet:newAddress()}}),b=await h.manager.book('a'),l=b.launches[0];
 l.phase='setup';l.review.minimumSol='0.06';l.review.setupLamports='10000000';l.storage.budget='1000000';await h.manager.save('a',b);
 h.chain.c.getBalance=async()=>20000000;
 await h.manager.action('a',l.id,'launch',{confirm:true,reviewHash:l.reviewHash});await h.manager.process('a');
 assert.equal(h.stored.state,'error');assert.match(h.stored.error,/Add SOL/);assert.equal(h.prepared,0);assert.equal(h.broadcasts.length,0);
});


test('preparation creates no draft or payment and creation consumes the exact reviewed keys and budget',async t=>{
  const h=await managerHarness(t),input=raw({imageId:h.stored.input.imageId,name:'Prepared token',devBuySol:'.01',requestId:'22222222-2222-4222-8222-222222222222'});
  let previews=0;const preview=h.chain.preview;h.chain.preview=async(...args)=>{previews++;return preview(...args);};
  const [a,b]=await Promise.all([h.manager.prepare('a',input),h.manager.prepare('a',input)]);
  assert.equal(a.prepareId,b.prepareId);assert.equal(previews,1);assert.equal((await h.manager.book('a')).launches.length,1);assert.equal(h.broadcasts.length,0);assert.equal(h.prepared,0);
  const staged=h.manager.preparedLaunches.get('a:'+a.prepareId);for(const k of Object.values(staged.launch.keys))if(k.secret)assert(!JSON.stringify(a).includes(k.secret));
  await assert.rejects(h.manager.create('b',{...input,prepareId:a.prepareId}),/changed|expired/);
  await assert.rejects(h.manager.create('a',{...input,name:'Changed',prepareId:a.prepareId}),/changed|expired/);
  const created=await h.manager.create('a',{...input,prepareId:a.prepareId});assert.equal(created.id,a.prepareId);assert.equal(created.mint,a.mint);assert.equal(created.reviewHash,a.reviewHash);assert.deepEqual(created.review,a.review);assert.equal(previews,1);
  assert.equal(h.manager.preparedLaunches.size,0);assert.equal((await h.manager.book('a')).launches.length,2);assert.equal(h.broadcasts.length,0);
  assert.equal((await h.manager.create('a',{...input,prepareId:a.prepareId})).id,created.id);assert.equal((await h.manager.book('a')).launches.length,2);
});
test('accepted reviews remain usable until expiry and excessive owner admission cannot evict earlier reviews',async t=>{
  const h=await managerHarness(t),input=raw({imageId:h.stored.input.imageId});
  const first=await h.manager.prepare('a',{...input,name:'First'});await h.manager.prepare('a',{...input,name:'Second'});await h.manager.prepare('a',{...input,name:'Third'});
  assert.equal(h.manager.preparedLaunches.size,3);
  for(let i=4;i<=8;i++)await h.manager.prepare('a',{...input,name:'Review '+i});
  await assert.rejects(h.manager.prepare('a',{...input,name:'Ninth'}),e=>e.statusCode===503&&e.retryAfter===2);
  assert.equal((await h.manager.create('a',{...input,name:'First',prepareId:first.prepareId})).id,first.prepareId);
  const current=await h.manager.prepare('a',input);h.advance(180001);await assert.rejects(h.manager.create('a',{...input,prepareId:current.prepareId}),/expired/);assert.equal(h.broadcasts.length,0);assert.equal((await h.manager.book('a')).launches.length,2);
});

test('interrupted legacy image writes are rejected on read and atomically repaired on identical retry',async t=>{
  const h=await managerHarness(t),imageId=h.stored.input.imageId,path=join(h.manager.accounts.dir,'token-images',imageId),original=await readFile(path);
  await writeFile(path,Buffer.from([0]));await assert.rejects(h.manager.image(imageId),/incomplete/);
  const results=await Promise.all(['a','b','c'].map(id=>h.manager.uploadImage(id,original.toString('base64'))));
  assert(results.every(value=>value.imageId===imageId));assert.deepEqual((await h.manager.image(imageId)).bytes,original);
  await assert.rejects(h.manager.ownedImage('unrelated',imageId),/Upload a token image/);
  assert((await readdir(join(h.manager.accounts.dir,'token-images'))).every(name=>!name.endsWith('.tmp')));
});

test('1000 accepted reviews survive a concurrent wave and the earliest can still be created',async t=>{
  const h=await managerHarness(t),imageId=h.stored.input.imageId,bytes=await h.manager.image(imageId);
  const users=Array.from({length:1000},(_,i)=>'review-owner-'+i);
  await Promise.all(users.map(id=>h.manager.uploadImage(id,bytes.bytes.toString('base64'))));
  const input=raw({imageId});const reviews=await Promise.all(users.map(id=>h.manager.prepare(id,input)));
  assert.equal(reviews.length,1000);assert.equal(h.manager.preparedLaunches.size,1000);
  const created=await h.manager.create(users[0],{...input,prepareId:reviews[0].prepareId});assert.equal(created.id,reviews[0].prepareId);assert.equal(h.broadcasts.length,0);
});

test('a queued review rechecks account bans before chain work and oversized reviews cannot displace accepted ones',async t=>{
  const h=await managerHarness(t),input=raw({imageId:h.stored.input.imageId}),originalGet=h.manager.accounts.get,preview=h.chain.preview;
  h.manager.preparationQueue.close();h.manager.preparationQueue=new LaunchPreparationQueue({concurrency:1});
  const image=await h.manager.image(input.imageId);await h.manager.uploadImage('b',image.bytes.toString('base64'));
  let release,entered,banned=false,calls=0;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  h.chain.preview=async(...args)=>{calls++;entered();await gate;return preview(...args);};h.manager.accounts.get=async id=>({...await originalGet(id),banned:id==='b'&&banned});
  const first=h.manager.prepare('a',input);await started;const second=h.manager.prepare('b',input);while(h.manager.pendingPreparations.size<2)await new Promise(resolve=>setImmediate(resolve));
  banned=true;const rejected=assert.rejects(second,/banned/);release();const accepted=await first;await rejected;assert.equal(calls,1);
  const prepare=h.manager.metadataStorage.prepare;h.manager.metadataStorage.prepare=async(...args)=>({...await prepare(...args),storage:{provider:'irys',budget:'0',items:[{raw:'x'.repeat(384*1024)}]}});
  await assert.rejects(h.manager.prepare('a',{...input,name:'Oversized'}),/too large/);
  assert(h.manager.preparedLaunches.has('a:'+accepted.prepareId));assert.equal(h.broadcasts.length,0);
});

test('legacy create requests use bounded preparation and coalesce before saving one exact draft',async t=>{
  const h=await managerHarness(t),input=raw({imageId:h.stored.input.imageId,name:'Legacy request',requestId:'55555555-5555-4555-8555-555555555555'}),preview=h.chain.preview;
  h.manager.preparationQueue.close();h.manager.preparationQueue=new LaunchPreparationQueue({concurrency:1});
  let release,calls=0;const blocker=h.manager.preparationQueue.run('busy',()=>new Promise(resolve=>{release=resolve;}));
  h.chain.preview=async(...args)=>{calls++;return preview(...args);};
  const first=h.manager.create('a',input),second=h.manager.create('a',input);
  while(!h.manager.pendingPreparations.size)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,0);assert.equal(h.manager.preparationQueue.count,2);
  await h.manager.locked('a',async()=>{}); // Waiting must not lock out saved transaction work.
  release();await blocker;const [a,b]=await Promise.all([first,second]);
  assert.equal(a.id,b.id);assert.equal(a.mint,b.mint);assert.equal(calls,1);assert.equal((await h.manager.book('a')).launches.length,2);assert.equal(h.broadcasts.length,0);
});

test('queued draft refreshes coalesce outside the account lock and overload leaves the draft untouched',async t=>{
  const h=await managerHarness(t),before=structuredClone(h.stored),preview=h.chain.preview;let calls=0,release;
  h.manager.preparationQueue.close();h.manager.preparationQueue=new LaunchPreparationQueue({concurrency:1,waitMs:15});
  const blocker=h.manager.preparationQueue.run('busy',()=>new Promise(resolve=>{release=resolve;}));
  h.chain.preview=async(...args)=>{calls++;return preview(...args);};
  const refresh=h.manager.refresh('a',h.created.id),duplicate=h.manager.refresh('a',h.created.id);
  const rejected=Promise.all([assert.rejects(refresh,e=>e.code==='LAUNCH_PREPARATION_BUSY'&&e.retryable),assert.rejects(duplicate,e=>e.code==='LAUNCH_PREPARATION_BUSY'&&e.retryable)]);
  await h.manager.locked('a',async()=>{});assert.equal(h.manager.pendingRefreshes.size,1);
  await new Promise(resolve=>setTimeout(resolve,30));await rejected;
  assert.deepEqual(h.stored,before);assert.equal(calls,0);assert.equal(h.broadcasts.length,0);
  release();await blocker;await h.manager.refresh('a',h.created.id);assert.equal(calls,1);assert.equal(h.stored.keys.mint.address,before.keys.mint.address);
});

test('saved receipts and authorized launches run before periodic fees without changing book order',async t=>{
  const h=await managerHarness(t),base=structuredClone(h.stored),now=h.manager.now(),seen=[];
  const fee={...structuredClone(base),id:'1'.repeat(32),state:'live',curve:newAddress(),feesRequested:true};
  const creating={...structuredClone(base),id:'2'.repeat(32),state:'launching',authorizedAt:now};
  const pending={...structuredClone(base),id:'3'.repeat(32),state:'launching',authorizedAt:now,operations:[{kind:'create',state:'pending',signature:'saved-signature',createdAt:now}]};
  await h.manager.save('a',{version:1,launches:[fee,creating,pending]});
  h.manager.reconcile=async(_id,_b,l)=>{seen.push(l.id);};h.manager.advanceLaunch=async(_id,_b,l)=>{seen.push(l.id);};h.manager.advanceFees=async(_id,_b,l)=>{seen.push(l.id);};
  await h.manager.process('a');assert.deepEqual(seen,[pending.id,creating.id,fee.id]);
  assert.deepEqual((await h.manager.book('a')).launches.map(l=>l.id),[fee.id,creating.id,pending.id]);assert.equal(h.broadcasts.length,0);
});

test('transient metadata provider failures retry the saved upload without changing its IDs or repeating completed items',async t=>{
  for(const failure of [Object.assign(Error('timeout of 10000ms exceeded'),{code:'ECONNABORTED'}),Object.assign(Error('provider busy'),{response:{status:429}})]){
    const h=await managerHarness(t);let attempts=0;const ids=['saved-image','saved-metadata'];
    await h.manager.locked('a',async b=>{b.launches[0].storage.items=ids.map(id=>({id,state:'prepared',raw:id}));await h.manager.save('a',b);});
    h.manager.metadataStorage.upload=async(l,persist)=>{attempts++;assert.deepEqual(l.storage.items.map(item=>item.id),ids);if(attempts===1){l.storage.items[0].state='uploaded';delete l.storage.items[0].raw;await persist();throw failure;}assert.equal(l.storage.items[0].state,'uploaded');assert.equal(l.storage.items[1].raw,'saved-metadata');l.storage.items[1].state='uploaded';delete l.storage.items[1].raw;await persist();return true;};
    await h.manager.action('a',h.created.id,'launch',{confirm:true,reviewHash:h.created.reviewHash});await h.manager.process('a');
    assert.equal(h.stored.state,'launching');assert.equal(h.stored.retry.attempt,1);assert.equal(h.stored.recovery,undefined);assert.equal(h.broadcasts.length,0);
    h.advance(1000);await h.manager.process('a');assert.equal(attempts,2);assert.equal(h.stored.recovery,undefined);assert.equal(h.broadcasts.length,1);assert.deepEqual(h.stored.storage.items.map(item=>item.id),ids);
  }
});
test('unsubmitted v2 errors can be reviewed with the repaired plan while submitted launches retain their original plan',async t=>{
  const h=await managerHarness(t,{input:{walletMode:'external',externalWallet:newAddress()}});
  let book=await h.manager.book('a'),l=book.launches[0];l.executionPlan='compact-v2';l.state='error';l.authorizedAt=1;l.retry={attempt:8,at:0};l.error='Minimum context slot has not been reached';await h.manager.save('a',book);
  const fresh=await h.manager.refresh('a',l.id);assert.equal(fresh.executionPlan,'compact-v3');assert.equal(fresh.state,'draft');assert.equal(fresh.mint,l.keys.mint.address);assert.equal(fresh.retry,null);assert.equal(h.stored.authorizedAt,undefined);assert.equal(h.broadcasts.length,0);
  book=await h.manager.book('a');l=book.launches[0];l.executionPlan='compact-v2';l.state='error';l.operations=[{kind:'setup',signature:'saved-signature',state:'confirmed'}];await h.manager.save('a',book);
  await assert.rejects(h.manager.refresh('a',l.id),/submitted transaction/);assert.equal(h.stored.executionPlan,'compact-v2');
});


test('resuming an interrupted managed launch retains its automatic reward policy',async t=>{
  for(const feeMode of ['holders','buyback']){
    const h=await managerHarness(t,{input:{feeMode,walletMode:'external',externalWallet:newAddress()}}),book=await h.manager.book('a'),l=book.launches[0];
    l.state='error';l.phase='verify';l.authorizedAt=1;l.autoFees=false;l.operations=[{kind:'setup',state:'confirmed',signature:'existing-setup'}];await h.manager.save('a',book);
    const resumed=await h.manager.action('a',l.id,'resume');assert.equal(resumed.autoFees,true);await h.manager.process('a');assert.equal(h.stored.state,'live');assert.equal(h.stored.autoFees,true);assert.equal(h.broadcasts.length,0);
    await h.manager.action('a',l.id,'pause');assert.equal(h.stored.autoFees,false);await h.manager.action('a',l.id,'resume',{autoFees:false});assert.equal(h.stored.autoFees,false);
  }
});


test('new public launch requests enforce $20k regardless of raw admin flags and trusted admin mode checks account authority',async t=>{
  const h=await managerHarness(t);
  const input=raw({imageId:h.stored.input.imageId,targetUsd:'100000',adminLaunch:true,marketCapPolicy:'admin',role:'admin'});
  for(const method of ['estimate','prepare','create'])await assert.rejects(h.manager[method]('a',input),/Public launches start at a \$20,000/);
  await assert.rejects(h.manager.prepare('a',input,{adminLaunch:true}),/Administrator access/);
  const originalGet=h.manager.accounts.get;
  h.manager.accounts.get=async id=>({...await originalGet(id),role:'admin',mfaEnabled:false});
  await assert.rejects(h.manager.create('a',input,{adminLaunch:true}),/two-factor/);
  h.manager.accounts.get=async id=>({...await originalGet(id),role:'admin',mfaEnabled:true});
  for(const targetUsd of ['19999','100000.01','200000'])await assert.rejects(h.manager.prepare('a',{...input,targetUsd},{adminLaunch:true}),/between \$20,000 and \$100,000/);
  const prepared=await h.manager.prepare('a',input,{adminLaunch:true});
  assert.equal(prepared.input.targetUsd,'100000');
  await assert.rejects(h.manager.create('a',{...input,prepareId:prepared.prepareId}),/Public launches/);
  await assert.rejects(h.manager.create('a',{...input,targetUsd:'20000',prepareId:prepared.prepareId}),/details changed/);
  const created=await h.manager.create('a',{...input,prepareId:prepared.prepareId},{adminLaunch:true});
  assert.equal(created.input.targetUsd,'100000');
  assert.equal(h.broadcasts.length,0);
});

test('public default cap stays $20k while historical saved launches retain their curve during review refresh',async t=>{
  const h=await managerHarness(t),original=h.stored.id,book=await h.manager.book('a');
  assert.equal(h.created.input.targetUsd,'20000');
  book.launches[0].input.targetUsd='5000';await h.manager.save('a',book);
  const refreshed=await h.manager.refresh('a',original);
  assert.equal(refreshed.input.targetUsd,'5000');assert.equal(refreshed.id,original);
  assert.equal(h.broadcasts.length,0);
  const defaultAgain=await h.manager.create('a',raw({imageId:h.stored.input.imageId,symbol:'NEW'}));
  assert.equal(defaultAgain.input.targetUsd,'20000');
});

test('new launch entrypoints enforce holder tax despite forged historical policy flags',async t=>{
  const h=await managerHarness(t),rawInput=raw({imageId:h.stored.input.imageId,feeMode:'holders',marketCapPolicy:'historical',taxPolicy:'historical'});
  for(const taxPercent of ['0','0.5','0.99','3.01','4','5','5.01'])for(const method of ['estimate','prepare','create'])await assert.rejects(h.manager[method]('a',{...rawInput,taxPercent}),/between 1% and 3%/);
  const prepared=await h.manager.prepare('a',rawInput);assert.equal(prepared.input.taxBps,200);
  const created=await h.manager.create('a',{...rawInput,prepareId:prepared.prepareId});assert.equal(created.input.taxBps,200);assert.equal(h.broadcasts.length,0);
  const get=h.manager.accounts.get;h.manager.accounts.get=async id=>({...await get(id),role:'admin',mfaEnabled:true});
  for(const method of ['estimate','prepare','create'])await assert.rejects(h.manager[method]('a',{...rawInput,taxPercent:'0.99'},{adminLaunch:true}),/between 1% and 3%/);
});

test('old low-tax drafts require a new review while already-live holder launches keep their tax',async t=>{
  for(const taxBps of [0,99,301,400,500]){
    const h=await managerHarness(t),book=await h.manager.book('a'),l=book.launches[0];l.input.feeMode='holders';l.input.taxBps=taxBps;await h.manager.save('a',book);
    const before=structuredClone(await h.manager.book('a'));
    await assert.rejects(h.manager.refresh('a',l.id),/between 1% and 3%/);
    await assert.rejects(h.manager.action('a',l.id,'launch',{confirm:true,reviewHash:l.reviewHash}),/between 1% and 3%/);
    assert.deepEqual(await h.manager.book('a'),before);assert.equal(h.broadcasts.length,0);
    l.curve=newAddress();l.authorizedAt=1;l.state='paused';l.autoFees=false;await h.manager.save('a',book);
    const resumed=await h.manager.action('a',l.id,'resume',{autoFees:false});assert.equal(resumed.input.taxBps,taxBps);assert.equal(resumed.state,'live');assert.equal(resumed.autoFees,false);
    assert.equal(h.stored.keys.mint.address,l.keys.mint.address);
  }
});

test('administrator $100k constant-product curve increases quote reserves and graduation funding with starting cap',()=>{
  const normal=rayCurveAtTarget(cfg,9,'100','20000'),admin=rayCurveAtTarget(cfg,9,'100','100000');
  assert(Math.abs(Number(admin.actualUsd)-100000)<0.001);
  assert(BigInt(admin.raise)>BigInt(normal.raise));assert(BigInt(admin.virtualQuote)>BigInt(normal.virtualQuote));
  assert.equal(admin.supply,normal.supply);assert.equal(admin.sell,normal.sell);
});


test('confirmed fee receipts persist actual buy debits rather than the authorized budget',async t=>{
  const h=await managerHarness(t,{input:{feeMode:'buyback'}}),book=await h.manager.book('a'),l=book.launches[0];
  l.state='live';l.curve='curve';l.authorizedAt=1;l.feesRequested=true;l.credits.quote='10000000';l.cycle={stage:'distribute',index:0};await h.manager.save('a',book);
  await h.manager.process('a');assert.equal(h.stored.operations[0].kind,'buy');assert.equal(h.stored.operations[0].amount,'10000000');assert.equal(h.stored.operations[0].receipt,undefined);
  h.receipt=txFor(h.stored,{quote:-9000000n,base:9000n});await h.manager.process('a');
  assert.equal(h.stored.operations[0].state,'confirmed');assert.deepEqual(h.stored.operations[0].receipt,{quoteDelta:'-9000000',baseDelta:'9000'});
  assert.equal(h.stored.credits.quote,'1000000');assert.equal(h.stored.credits.base,'9000');
  await h.manager.process('a');assert.equal(h.stored.operations[1].kind,'burn');
  h.receipt=txFor(h.stored,{base:-9000n});await h.manager.process('a');
  assert.equal(h.stored.operations[1].state,'confirmed');assert.deepEqual(h.stored.operations[1].receipt,{quoteDelta:'0',baseDelta:'-9000'});
});

test('failed and out-of-budget receipts never publish confirmed reward deltas',async t=>{
  for(const receipt of [{err:{InstructionError:[0,'failure']}},{quote:-11000000n,base:1000n}]){
    const h=await managerHarness(t,{input:{feeMode:'buyback'}}),book=await h.manager.book('a'),l=book.launches[0];
    l.state='live';l.curve='curve';l.authorizedAt=1;l.feesRequested=true;l.credits.quote='10000000';l.cycle={stage:'distribute',index:0};await h.manager.save('a',book);
    await h.manager.process('a');h.receipt=txFor(h.stored,receipt);await h.manager.process('a');
    assert.notEqual(h.stored.operations[0].state,'confirmed');assert.equal(h.stored.operations[0].receipt,undefined);
    assert.equal(h.stored.credits.quote,'10000000');assert.equal(h.stored.credits.base,'0');
  }
});


test('creator claim reporting records validated quote and base income even when the operation amount is zero',async t=>{
  const h=await managerHarness(t,{input:{feeMode:'holders'}}),book=await h.manager.book('a'),l=book.launches[0];
  l.state='live';l.curve='curve';l.authorizedAt=1;l.feesRequested=true;l.cycle={stage:'claim',index:0};await h.manager.save('a',book);h.chain.claimInstructions=async()=>['claim'];
  h.chain.rewardsGasFundingPlan=async()=>({gasLamports:'0',ready:true});h.chain.rewardHandoffInstructions=async()=>{throw Error('A zero-credit activation needs no asset handoff');};
  await h.manager.process('a');assert.equal(h.stored.rewardsWallet.status,'active');assert.equal(h.stored.operations[0].rewardsWallet.address,h.stored.keys.wallet.address);assert.equal(h.stored.operations[0].kind,'claim');assert.equal(h.stored.operations[0].amount,'0');
  h.receipt=txFor(h.stored,{quote:123456n,base:789n});await h.manager.process('a');
  assert.equal(h.stored.operations[0].state,'confirmed');assert.deepEqual(h.stored.operations[0].receipt,{quoteDelta:'123456',baseDelta:'789'});
  assert.equal(h.stored.credits.quote,'123456');assert.equal(h.stored.credits.base,'789');
});

test('only an audited admin buyback bypasses the automatic dollar floor and continues to burn',async t=>{
  for(const admin of [false,true]){
    const h=await managerHarness(t,{input:{feeMode:'buyback'}}),b=await h.manager.book('a'),l=b.launches[0];
    Object.assign(l,{state:'live',curve:'curve',authorizedAt:1,feesRequested:true,manualFeesRequested:true,cycle:{stage:'distribute',index:0,manual:true},credits:{quote:'1000',base:'0'}});
    if(admin){l.buybackAdminRequest='admin-request';l.adminRewardHistory=[{action:'buyback',requestId:'admin-request',actorId:'admin',launchId:l.id}];}
    await h.manager.save('a',b);await h.manager.process('a');
    assert.equal(h.stored.operations.length,admin?1:0);
    if(admin){assert.equal(h.stored.operations[0].kind,'buy');assert.equal(h.stored.operations[0].amount,'1000');h.receipt=txFor(h.stored,{quote:-900n,base:100n});await h.manager.process('a');await h.manager.process('a');assert.equal(h.stored.operations[1].kind,'burn');assert.equal(h.stored.operations[1].amount,'100');}
  }
});
test('remaining earned tokens burn even when there is no quote credit for another buy',async t=>{
  const h=await managerHarness(t,{input:{feeMode:'buyback'}}),b=await h.manager.book('a'),l=b.launches[0];
  Object.assign(l,{state:'live',curve:'curve',authorizedAt:1,feesRequested:true,cycle:{stage:'distribute',index:0},credits:{quote:'0',base:'300'}});
  await h.manager.save('a',b);await h.manager.process('a');assert.equal(h.stored.operations[0].kind,'burn');assert.equal(h.stored.operations[0].amount,'300');
});

test('manual admin buyback finishes an old saved cycle then claims and buys with the remaining credit',async t=>{
 const h=await managerHarness(t,{input:{feeMode:'buyback'}}),b=await h.manager.book('a'),l=b.launches[0];
 Object.assign(l,{state:'live',curve:'curve',authorizedAt:1,feesRequested:true,buybackAdminRequest:'request',adminRewardHistory:[{requestId:'request',action:'buyback',actorId:'admin',launchId:l.id}],cycle:{stage:'done',index:0,restartAfterCompletion:true},credits:{quote:'1000',base:'0'}});
 h.chain.claimInstructions=async()=>[];await h.manager.save('a',b);await h.manager.process('a');assert.equal(h.stored.operations[0].kind,'buy');assert.equal(h.stored.operations[0].amount,'1000');
});


test('BlockhashNotFound is rebuilt only before broadcast, with bounded retries and unchanged instructions',async()=>{
  const l=launch(),hashes=[newAddress(),newAddress(),newAddress()],seen=[],waits=[];let count=0;
  const chain=new LaunchChain({network:'mainnet-beta',sleep:async ms=>waits.push(ms),connection:{
    getLatestBlockhash:async()=>({blockhash:hashes[count],lastValidBlockHeight:200+count}),
    simulateTransaction:async tx=>{seen.push(tx);count++;return{context:{slot:300+count},value:{err:count<3?'BlockhashNotFound':null}};},
    sendRawTransaction:async()=>{throw Error('Preparation must never broadcast');}
  }});
  const instructions=await chain.launchInstructions(l,'platform'),op=await chain.prepare(l,instructions);
  assert.equal(seen.length,3);assert.deepEqual(waits,[250,750]);assert.equal(op.blockhash,hashes[2]);assert.equal(op.preparedSlot,303);
  assert(seen.every(tx=>JSON.stringify(tx.message.compiledInstructions)===JSON.stringify(seen[0].message.compiledInstructions)));
  assert.equal(new Set(seen.map(tx=>tx.message.recentBlockhash)).size,3);
  count=0;chain.c.simulateTransaction=async()=>{count++;return{value:{err:'BlockhashNotFound'}};};
  await assert.rejects(chain.prepare(l,instructions),error=>error.code==='LAUNCH_SIMULATION_BLOCKHASH'&&/Nothing was submitted/.test(error.message));assert.equal(count,3);
  count=0;chain.c.simulateTransaction=async()=>{count++;return{value:{err:{InstructionError:[0,'InsufficientFunds']}}};};
  await assert.rejects(chain.prepare(l,instructions),/InsufficientFunds/);assert.equal(count,1);
});

test('an expired buyback stays journaled and paused until two finalized checks agree and the owner explicitly retries',async t=>{
  const h=await managerHarness(t,{input:{feeMode:'buyback'}}),b=await h.manager.book('a'),l=b.launches[0];
  Object.assign(l,{state:'live',curve:'curve',authorizedAt:1,autoFees:false,feeAutomation:{enabled:false},feesRequested:true,cycle:{stage:'distribute',index:0},credits:{quote:'10000000',base:'0'}});await h.manager.save('a',b);
  await h.manager.process('a');const signature=h.stored.operations[0].signature;h.advance(180001);let checks=0;
  h.chain.pendingTransactionState=async op=>({state:'expired',signature:op.signature,checkpoint:{height:201+checks,slot:301+checks++},historyFromSlot:0});
  await h.manager.process('a');assert.equal(h.prepared,1);assert.equal(h.stored.operations[0].state,'pending');assert.equal(h.stored.state,'paused');assert.equal(h.stored.operations[0].raw,'exact-signed-bytes');
  await h.manager.process('a');assert.equal(checks,1,'pending checks are paced');
  h.advance(10001);await h.manager.process('a');assert.equal(h.prepared,1);assert.equal(h.stored.operations[0].state,'expired');assert.equal(h.stored.operations[0].signature,signature);assert.equal(h.stored.operations[0].raw,undefined);assert.equal(h.stored.operations[0].expiryProof.first.slot,301);
  assert.deepEqual(h.stored.credits,{quote:'10000000',base:'0'});assert.equal(h.stored.cycle.stage,'distribute');assert.equal(h.stored.autoFees,false);assert.equal(h.stored.feesRequested,false);
  await h.manager.process('a');assert.equal(h.prepared,1,'expiry alone never signs a replacement');
  const retry=await h.manager.book('a');requestFees(retry.launches[0]);await h.manager.save('a',retry);await h.manager.process('a');assert.equal(h.prepared,2);assert.equal(h.stored.operations[1].kind,'buy');assert.notEqual(h.stored.operations[1].signature,signature);
});

test('unknown or inconsistent expiry evidence never releases a pending buyback or changes credits',async t=>{
  const h=await managerHarness(t,{input:{feeMode:'buyback'}}),b=await h.manager.book('a'),l=b.launches[0];Object.assign(l,{state:'live',curve:'curve',authorizedAt:1,feesRequested:true,cycle:{stage:'distribute',index:0},credits:{quote:'10000000',base:'0'}});await h.manager.save('a',b);await h.manager.process('a');h.advance(180001);
  let result={state:'unknown',reason:'Insufficient retained history.'};h.chain.pendingTransactionState=async()=>result;
  for(let i=0;i<2;i++){await h.manager.process('a');h.advance(10001);}assert.equal(h.prepared,1);assert.equal(h.stored.operations[0].state,'pending');assert.equal(h.stored.operations[0].expiryCheck,undefined);
  result={state:'expired',signature:h.stored.operations[0].signature,checkpoint:{height:201,slot:301},historyFromSlot:0};
  for(let i=0;i<3;i++){await h.manager.process('a');h.advance(10001);}assert.equal(h.stored.operations[0].state,'pending','stalled checkpoints do not establish expiry');
  h.receipt=txFor(h.stored,{quote:-10000000n,base:9000n});await h.manager.process('a');assert.equal(h.stored.operations[0].state,'confirmed');assert.equal(h.stored.credits.quote,'0');assert.equal(h.stored.credits.base,'9000');assert.equal(h.prepared,1);
});

test('automatic buyback recovery survives restart, waits its backoff, and buys and burns only the confirmed amounts',async t=>{
  const h=await managerHarness(t,{input:{feeMode:'buyback'}}),book=await h.manager.book('a'),l=book.launches[0];
  Object.assign(l,{state:'live',curve:newAddress(),authorizedAt:1,autoFees:true,feeAutomation:{enabled:true},feesRequested:true,cycle:{stage:'distribute',index:0},credits:{quote:'10000000',base:'0'}});await h.manager.save('a',book);
  await h.manager.process('a');const first=structuredClone(h.stored.operations[0]);let checks=0;
  h.chain.pendingTransactionState=async op=>({state:'expired',signature:op.signature,checkpoint:{height:201+checks,slot:301+checks++},historyFromSlot:0});
  h.advance(180001);await h.manager.process('a');h.advance(10001);await h.manager.process('a');
  assert.equal(h.stored.operations[0].state,'expired');assert.equal(h.stored.autoFees,true);assert.equal(h.stored.state,'live');assert.deepEqual(h.stored.credits,{quote:'10000000',base:'0'});const retry=structuredClone(h.stored.rewardRetry);assert.equal(retry.at,h.manager.now()+30000);
  await h.manager.close();const restarted=new Launchpad(h.manager.accounts,null,{chainFactory:()=>h.chain,now:h.manager.now});restarted.kick=()=>{};t.after(()=>restarted.close());
  await restarted.process('a');assert.equal(h.prepared,1);assert.deepEqual(h.stored.rewardRetry,retry);h.advance(29999);await restarted.process('a');assert.equal(h.prepared,1);
  h.advance(1);await restarted.process('a');assert.equal(h.prepared,2);const replacement=h.stored.operations[1];assert.equal(replacement.kind,'buy');assert.equal(replacement.amount,'10000000');assert.notEqual(replacement.signature,first.signature);assert.deepEqual(h.stored.rewardRetry,retry);
  await restarted.process('a');assert.equal(h.prepared,2);assert.equal(h.stored.operations.length,2);assert.deepEqual(h.stored.credits,{quote:'10000000',base:'0'});
  h.receipt=txFor(h.stored,{quote:-9000000n,base:9000n});await restarted.process('a');assert.equal(h.stored.operations[1].state,'confirmed');assert.equal(h.stored.rewardRetry,undefined);assert.deepEqual(h.stored.credits,{quote:'1000000',base:'9000'});
  h.receipt=null;await restarted.process('a');assert.equal(h.prepared,3);assert.equal(h.stored.operations[2].kind,'burn');assert.equal(h.stored.operations[2].amount,'9000');
  h.receipt=txFor(h.stored,{base:-9000n});await restarted.process('a');assert.equal(h.stored.operations[2].state,'confirmed');assert.deepEqual(h.stored.credits,{quote:'1000000',base:'0'});assert.equal(h.stored.autoFees,true);assert.equal(h.stored.operations.filter(op=>op.kind==='buy'&&op.state==='confirmed').length,1);
});

test('deliberately pausing a pending automatic buyback survives restart while its receipt still reconciles without a follow-on burn',async t=>{
  const h=await managerHarness(t,{input:{feeMode:'buyback'}}),book=await h.manager.book('a'),l=book.launches[0];
  Object.assign(l,{state:'live',curve:newAddress(),authorizedAt:1,autoFees:true,feeAutomation:{enabled:true},feesRequested:true,cycle:{stage:'distribute',index:0},credits:{quote:'10000000',base:'0'}});await h.manager.save('a',book);await h.manager.process('a');assert.equal(h.prepared,1);
  const pending=structuredClone(h.stored.operations[0]);await h.manager.action('a',h.created.id,'pause');assert.equal(h.stored.feeAutomation.enabled,false);assert.equal(h.stored.autoFees,false);assert.equal(h.stored.rewardRetry,undefined);
  await h.manager.close();const restarted=new Launchpad(h.manager.accounts,null,{chainFactory:()=>h.chain,now:h.manager.now});restarted.kick=()=>{};t.after(()=>restarted.close());
  h.receipt=txFor(h.stored,{quote:-9000000n,base:9000n});await restarted.process('a');assert.equal(h.stored.operations[0].state,'confirmed');assert.equal(h.stored.operations[0].signature,pending.signature);assert.deepEqual(h.stored.credits,{quote:'1000000',base:'9000'});
  h.receipt=null;h.advance(3600000);await restarted.process('a');assert.equal(h.prepared,1);assert.equal(h.stored.operations.length,1);assert.equal(h.stored.feeAutomation.enabled,false);assert.equal(h.stored.autoFees,false);assert.equal(h.stored.feesRequested,false);assert.equal(h.stored.rewardRetry,undefined);
});

test('positive pending-signature observations are durable even before the next rebroadcast',async t=>{
  const h=await managerHarness(t,{input:{feeMode:'buyback'}}),b=await h.manager.book('a'),l=b.launches[0];
  Object.assign(l,{state:'live',curve:'curve',authorizedAt:1,feesRequested:true,cycle:{stage:'distribute',index:0},credits:{quote:'10000000',base:'0'}});await h.manager.save('a',b);await h.manager.process('a');
  h.chain.receipt=async op=>{op.observedSignatureStatus={confirmationStatus:'confirmed',slot:301};return null;};
  await h.manager.process('a');assert.deepEqual(h.stored.operations[0].observedSignatureStatus,{confirmationStatus:'confirmed',slot:301});assert.equal(h.prepared,1);assert.equal(h.broadcasts.length,1);
});

async function pendingHolderSale(t,{paced=false,sameGasDay=true}={}){
  const h=await managerHarness(t,{input:{feeMode:'holders'}}),book=await h.manager.book('a'),l=book.launches[0],createdAt=h.manager.now();
  // The saved index represents two already-paid rows; expiry must preserve
  // that valid prefix without manufacturing another holder payout.
  Object.assign(l,{state:'live',curve:newAddress(),authorizedAt:1,autoFees:true,feeAutomation:{enabled:true},feesRequested:true,credits:{quote:'700',base:'1000'},cycle:{stage:'route',index:2,slot:91,claimedQuote:'600',payouts:[{owner:newAddress(),amount:'13'},{owner:newAddress(),amount:'17'}]}});
  l.review.platformFeeBps=0;l.taxProtocol={...taxProtocolLedger(l),harvestedBase:'500',sourceBaseCredit:'500'};
  l.gas={day:sameGasDay?new Date(createdAt).toISOString().slice(0,10):'1999-01-01',reserved:'5001000'};
  l.operations=[{kind:'sell',state:'pending',signature:'saved-holder-sale',raw:'saved-holder-sale-bytes',createdAt,lastValidBlockHeight:100,preparedSlot:100,amount:'100',reserve:'5000000',...(paced?{taxConversionPolicy:'paced-v1'}:{})}];
  await h.manager.save('a',book);return h;
}

test('legacy holder sale expires after durable advancing checks and resumes automatically without repeating the old sale',async t=>{
  const h=await pendingHolderSale(t),before=structuredClone(h.stored);let checks=0;
  h.chain.pendingTransactionState=async op=>({state:'expired',signature:op.signature,checkpoint:{height:201+checks,slot:301+checks++},historyFromSlot:0});
  assert.equal(protocolFeeEligibility(h.stored,{activate:true}).allowed,false);assert.equal(protocolFeeEligibility(h.stored,{activate:true}).blockingOperation.kind,'sell');
  h.advance(180001);await h.manager.process('a');assert.equal(checks,1);assert.equal(h.stored.operations[0].state,'pending');assert.equal(h.stored.operations[0].raw,'saved-holder-sale-bytes');
  const first=structuredClone(h.stored.operations[0].expiryCheck);assert.equal(first.slot,301);await h.manager.process('a');assert.equal(checks,1);
  await h.manager.close();const restarted=new Launchpad(h.manager.accounts,null,{chainFactory:()=>h.chain,now:h.manager.now});restarted.kick=()=>{};t.after(()=>restarted.close());
  h.advance(9999);await restarted.process('a');assert.equal(checks,1,'restart cannot skip the second-check delay');assert.deepEqual(h.stored.operations[0].expiryCheck,first);
  h.advance(2);await restarted.process('a');const op=h.stored.operations[0];assert.equal(checks,2);assert.equal(op.state,'expired');assert.equal(op.signature,before.operations[0].signature);assert.equal(op.raw,undefined);assert.deepEqual(op.expiryProof.first,first);assert.equal(op.expiryProof.second.slot,302);assert.equal(op.expiryProof.historyFromSlot,0);
  assert.equal(h.stored.state,'live');assert.equal(h.stored.autoFees,true);assert.equal(h.stored.feeAutomation.enabled,true);assert.equal(h.stored.gas.reserved,'1000');assert.equal(h.stored.lastTaxConversionAt,h.manager.now());
  assert.equal(h.stored.rewardRetry.at,h.manager.now()+30000);assert.equal(h.stored.rewardRetry.attempt,1);assert(h.stored.rewardRetry.kind);
  assert.deepEqual(h.stored.cycle,{...before.cycle,stage:'tax-protocol',taxConversionAttempted:true});assert.deepEqual(h.stored.credits,before.credits);assert.deepEqual(h.stored.taxProtocol,before.taxProtocol);assert.equal(protocolFeeEligibility(h.stored,{activate:true}).allowed,true);
  await restarted.process('a');assert.equal(h.prepared,0);assert.deepEqual(h.broadcasts,[]);
  h.advance(29999);await restarted.process('a');assert.equal(h.prepared,0);assert.equal(h.stored.cycle.stage,'tax-protocol');
  h.advance(1);await restarted.process('a');assert.equal(h.prepared,0,'automatic recovery continues the saved cycle without another sale');assert.deepEqual(h.broadcasts,[]);assert.equal(h.stored.operations.length,1);assert.deepEqual(h.stored.credits,before.credits);assert.deepEqual(h.stored.taxProtocol,before.taxProtocol);assert.equal(h.stored.rewardRetry,undefined);assert.equal(h.stored.autoFees,true);
});

test('paced holder sale expiry preserves credits and never releases another day’s gas reserve',async t=>{
  const h=await pendingHolderSale(t,{paced:true,sameGasDay:false}),before=structuredClone(h.stored);let checks=0;
  h.chain.pendingTransactionState=async op=>({state:'expired',signature:op.signature,checkpoint:{height:201+checks,slot:301+checks++},historyFromSlot:0});
  h.advance(180001);await h.manager.process('a');h.advance(10001);await h.manager.process('a');
  assert.equal(h.stored.operations[0].state,'expired');assert.equal(h.stored.operations[0].signature,'saved-holder-sale');assert.equal(h.stored.gas.reserved,before.gas.reserved);assert.equal(h.stored.cycle.stage,'tax-protocol');assert.equal(h.stored.cycle.taxConversionAttempted,true);
  assert.deepEqual(h.stored.credits,before.credits);assert.deepEqual(h.stored.taxProtocol,before.taxProtocol);assert.equal(h.prepared,0);assert.deepEqual(h.broadcasts,[]);
});

test('a reward recovery cooldown allows an explicit protocol upgrade without preparing another holder sale',async t=>{
  const h=await pendingHolderSale(t);let checks=0;
  h.chain.pendingTransactionState=async op=>({state:'expired',signature:op.signature,checkpoint:{height:201+checks,slot:301+checks++},historyFromSlot:0});
  h.advance(180001);await h.manager.process('a');h.advance(10001);await h.manager.process('a');const retry=structuredClone(h.stored.rewardRetry),cycle=structuredClone(h.stored.cycle);
  const book=await h.manager.book('a'),l=book.launches[0];l.protocolFeesRequested=true;l.protocolClaimStage='activate';l.protocolActivation={recipient:newAddress(),curveFeeBps:100,creationFeeSol:'0'};await h.manager.save('a',book);
  h.chain.protocolActivationInstructions=async()=>['upgrade'];h.chain.verifyProtocolActivation=async()=>true;
  await h.manager.process('a');assert.equal(h.prepared,1);assert.equal(h.stored.operations.at(-1).kind,'protocol-enable');assert(h.manager.now()<retry.at);assert.deepEqual(h.stored.rewardRetry,retry);assert.deepEqual(h.stored.cycle,cycle);
  h.receipt=txFor(h.stored);await h.manager.process('a');assert.equal(h.stored.operations.at(-1).state,'confirmed');assert.deepEqual(h.stored.rewardRetry,retry);assert.equal(h.stored.review.platformFeeBps,100);assert.equal(h.stored.operations.filter(op=>op.kind==='sell').length,1);
});

test('automatic recovery after holder sale expiry pays existing tax protocol credit before any new conversion',async t=>{
  const h=await pendingHolderSale(t),book=await h.manager.book('a'),l=book.launches[0],recipient=newAddress();
  Object.assign(l.taxProtocol,{harvestedBase:'600',convertedBase:'100',convertedQuote:'1000',holderQuote:'950',accruedQuote:'50',creditQuote:'50'});
  // This saved pre-migration sale and its credits belong to the original creator.
  delete l.rewardsWallet;delete l.keys.rewards;
  h.chain.rewardsGasFundingPlan=async()=>({gasLamports:'0',ready:true});h.chain.rewardHandoffInstructions=async()=>['handoff'];
  assert(l.input.taxBps>0);assert.equal(taxProtocolLedger(l).creditQuote,'50');await h.manager.save('a',book);
  const read=h.manager.accounts.hostStore.read;h.manager.accounts.hostStore.read=async(name,fallback)=>name==='launch-protocol-fees'?{recipient,recipientScope:'launchpad'}:read(name,fallback);
  const before=structuredClone(h.stored);let checks=0;
  h.chain.pendingTransactionState=async op=>({state:'expired',signature:op.signature,checkpoint:{height:201+checks,slot:301+checks++},historyFromSlot:0});
  h.advance(180001);await h.manager.process('a');h.advance(10001);await h.manager.process('a');assert.equal(h.stored.operations[0].state,'expired');assert.equal(h.stored.cycle.stage,'tax-protocol');
  assert.deepEqual(h.stored.taxProtocol,before.taxProtocol);assert.deepEqual(h.stored.credits,before.credits);assert.equal(h.prepared,0);
  h.chain.payoutInstructions=async(view,payouts,{operation})=>{assert.equal(view.keys.wallet.address,before.keys.wallet.address);assert.deepEqual(operation.rewardsWallet,{version:1,source:'rewards',address:h.stored.keys.rewards.address,signerSource:'rewards'});assert.deepEqual(payouts,[{owner:recipient,amount:'50'}]);return ['tax-payout'];};
  assert.equal(h.stored.rewardRetry.at,h.manager.now()+30000);await h.manager.process('a');assert.equal(h.prepared,0);
  h.advance(30000);await h.manager.process('a');
  assert.equal(h.prepared,1);assert.equal(h.stored.operations.length,2);const handoff=h.stored.operations[1];assert.equal(handoff.kind,'reward-handoff');assert.equal(handoff.rewardHandoff.baseUnits,'1000');assert.equal(handoff.rewardHandoff.quoteUnits,'750');assert.equal(handoff.rewardHandoff.protocolQuoteUnits,'50');assert.equal(handoff.rewardHandoff.taxBaseUnits,'500');assert.deepEqual(h.stored.credits,before.credits);assert.deepEqual(h.stored.taxProtocol,before.taxProtocol);
  h.receipt=rewardFixtureHandoffReceipt(h.stored,handoff);await h.manager.process('a');assert.equal(h.stored.operations[1].state,'confirmed');assert.equal(h.stored.rewardsWallet.status,'active');assert.deepEqual(h.stored.credits,before.credits);assert.deepEqual(h.stored.taxProtocol,before.taxProtocol);h.receipt=null;await h.manager.process('a');
  assert.equal(h.prepared,2);assert.equal(h.stored.operations.length,3);const payout=h.stored.operations[2];
  assert.equal(payout.kind,'tax-protocol-payout');assert.equal(payout.amount,'50');assert.equal(payout.taxProtocolPolicy,before.taxProtocol.policy);assert.equal(payout.taxProtocolRecipient,recipient);assert.deepEqual(payout.payouts,[{owner:recipient,amount:'50'}]);assert.equal(payout.state,'pending');
  assert.deepEqual(h.stored.taxProtocol,before.taxProtocol);assert.deepEqual(h.stored.credits,before.credits);assert.deepEqual(h.broadcasts,[handoff.signature,payout.signature]);
  h.receipt=rewardFixtureReceipt(h.stored,{quote:-50n,operation:payout});await h.manager.process('a');assert.equal(h.stored.operations[2].state,'confirmed');assert.equal(h.stored.taxProtocol.creditQuote,'0');assert.equal(h.stored.taxProtocol.paidQuote,'50');assert.equal(h.stored.taxProtocol.sourceBaseCredit,'500');assert.deepEqual(h.stored.credits,before.credits);assert.equal(h.stored.cycle.stage,'distribute');assert.equal(h.prepared,2);assert.equal(h.stored.operations.filter(op=>op.kind==='sell').length,1);assert.equal(h.stored.rewardRetry,undefined);assert.equal(h.stored.autoFees,true);
});

test('unknown, stale and positively observed holder sale outcomes remain pending and a late receipt keeps exact accounting',async t=>{
  const h=await pendingHolderSale(t),before=structuredClone(h.stored);h.advance(180001);
  let result={state:'unknown',reason:'Retained transaction history is incomplete.'};h.chain.pendingTransactionState=async()=>result;
  for(let i=0;i<2;i++){await h.manager.process('a');h.advance(10001);}assert.equal(h.stored.operations[0].expiryCheck,undefined);
  result={state:'expired',signature:'saved-holder-sale',checkpoint:{height:201,slot:301},historyFromSlot:0};
  for(let i=0;i<3;i++){await h.manager.process('a');h.advance(10001);}assert.equal(h.stored.operations[0].state,'pending','stalled finalized checkpoints cannot retire a sale');
  result={state:'observed',reason:'The signature has been observed.'};const receipt=h.chain.receipt;
  h.chain.receipt=async op=>{op.observedSignatureStatus={confirmationStatus:'confirmed',slot:302};return null;};
  await h.manager.process('a');assert.deepEqual(h.stored.operations[0].observedSignatureStatus,{confirmationStatus:'confirmed',slot:302});assert.equal(h.stored.operations[0].expiryCheck,undefined);
  h.advance(10001);await h.manager.process('a');assert.equal(h.stored.operations[0].state,'pending');assert.equal(h.stored.operations[0].raw,before.operations[0].raw);assert.deepEqual(h.stored.credits,before.credits);assert.deepEqual(h.stored.taxProtocol,before.taxProtocol);assert.equal(h.prepared,0);assert.deepEqual(h.broadcasts,[]);
  h.chain.receipt=receipt;h.receipt=txFor(h.stored,{quote:80n,base:-100n});h.advance(10001);await h.manager.process('a');
  assert.equal(h.stored.operations[0].state,'confirmed');assert.equal(h.stored.operations[0].expiryProof,undefined);assert.deepEqual(h.stored.operations[0].receipt,{quoteDelta:'80',baseDelta:'-100'});assert.deepEqual(h.stored.credits,{quote:'780',base:'900'});assert.deepEqual(h.stored.taxProtocol,before.taxProtocol);assert.equal(h.prepared,0);
});

test('a finalized holder sale receipt wins over expiry and a confirmed failure schedules automatic recovery without repeating the sale',async t=>{
  for(const failed of [false,true]){
    const h=await pendingHolderSale(t),before=structuredClone(h.stored);let checks=0;
    h.chain.pendingTransactionState=async op=>{checks++;return {state:'expired',signature:op.signature,checkpoint:{height:200+checks,slot:300+checks},historyFromSlot:0};};
    h.advance(180001);await h.manager.process('a');assert.equal(checks,1);h.advance(10001);
    h.receipt=txFor(h.stored,failed?{err:{InstructionError:[0,'Rejected']}}:{quote:80n,base:-100n});await h.manager.process('a');
    assert.equal(checks,1,'finalized receipt is checked before any expiry proof');assert.equal(h.stored.operations[0].state,failed?'failed':'confirmed');assert.equal(h.stored.operations[0].expiryProof,undefined);assert.equal(h.stored.operations[0].raw,undefined);assert.equal(h.prepared,0);assert.deepEqual(h.broadcasts,[]);assert.deepEqual(h.stored.taxProtocol,before.taxProtocol);
    if(failed){assert.deepEqual(h.stored.credits,before.credits);assert.equal(h.stored.state,'live');assert.equal(h.stored.autoFees,true);assert.equal(h.stored.feesRequested,true);assert.equal(h.stored.cycle.stage,'tax-protocol');assert.equal(h.stored.cycle.taxConversionAttempted,true);assert.equal(h.stored.operations[0].receipt,undefined);assert.equal(h.stored.rewardRetry.at,h.manager.now()+30000);}
    else {assert.deepEqual(h.stored.credits,{quote:'780',base:'900'});assert.equal(h.stored.cycle.stage,'tax-protocol');}
  }
});

test('wallet-only launch preparation rejects managed payers while preserving dedicated service keys',async t=>{
  const h=await managerHarness(t);h.manager.walletOnly=true;const imageId=h.stored.input.imageId,oldSecret=h.stored.keys.payer.secret;
  const account=h.manager.accounts.storeFor('a'),read=account.read.bind(account);let payerReads=0;
  account.read=async(name,...args)=>{if(name==='main-wallet'){payerReads++;throw Error('main private key must not be read');}return read(name,...args);};
  await assert.rejects(h.manager.prepare('a',raw({imageId})),/Connect your wallet to launch/);await assert.rejects(h.manager.create('a',raw({imageId})),/Stored account wallets are disabled/);
  const address=newAddress(),created=await h.manager.create('a',raw({imageId,walletMode:'external',externalWallet:address,symbol:'NEW'}));
  const saved=(await h.manager.book('a')).launches.find(l=>l.id===created.id);assert.deepEqual(saved.keys.payer,{address,external:true});assert(saved.keys.wallet.secret);assert(saved.keys.mint.secret);assert.equal(saved.keys.platform.address,saved.keys.wallet.address);assert.equal(saved.feeCustody,'relay');assert.equal(payerReads,0);
  assert.equal(h.stored.keys.payer.secret,oldSecret,'existing funded-wallet recovery records must remain intact');
});

test('wallet-only launch upgrade refuses new managed signing but retains existing launch receipt reconciliation',async t=>{
  const h=await managerHarness(t);await h.manager.action('a',h.created.id,'launch',{confirm:true,reviewHash:h.created.reviewHash});await h.manager.process('a');assert.equal(h.prepared,1);
  h.manager.walletOnly=true;h.receipt=txFor(h.stored);await h.manager.process('a');assert.equal(h.stored.operations[0].state,'confirmed');assert.equal(h.prepared,1);
  h.chain.prepare=async()=>{throw Error('managed signing must remain disabled');};
  await assert.rejects(h.manager.advanceLaunch('a',await h.manager.book('a'),h.stored,h.chain),/stored account wallet/);assert.equal(h.broadcasts.length,1);
});

test('wallet-only launch upgrade does not interrupt existing service-wallet buyback work',async t=>{
  const h=await managerHarness(t,{input:{feeMode:'buyback'}});h.manager.walletOnly=true;const b=await h.manager.book('a'),l=b.launches[0];l.state='live';l.curve='curve';l.authorizedAt=1;l.feesRequested=true;l.credits.quote='10000000';l.cycle={stage:'distribute',index:0};await h.manager.save('a',b);
  await h.manager.process('a');assert.equal(h.prepared,1);assert.equal(h.stored.operations[0].kind,'buy');assert.equal(h.stored.operations[0].amount,'10000000');
});

test('new holder launches accept selectable 1–3% tax with 2% default and no curve creator fee',async t=>{
  const h=await managerHarness(t);
  for(const taxPercent of ['1','1.5','2','2.75','3']){const input=await h.manager.newLaunchInput('a',raw({feeMode:'holders',taxPercent}));assert.equal(input.taxBps,Number(taxPercent)*100);assert.equal(input.creatorFeeBps,0);assert.equal(input.creatorFeePolicy,'taxed-holders-0-v3');}
  const defaults=await h.manager.newLaunchInput('a',raw({feeMode:'holders',taxPercent:undefined}));assert.equal(defaults.taxBps,200);
  assert.equal(launchInput(raw({feeMode:'holders',taxPercent:'5'})).taxBps,500);
});
test('unsigned old holder fee reviews must be refreshed; signed or authorized legacy tax work keeps its saved terms',async t=>{
  const h=await managerHarness(t),book=await h.manager.book('a'),l=book.launches[0];l.input.feeMode='holders';l.input.taxBps=200;l.input.creatorFeeBps=50;l.input.creatorFeePolicy='flat-0.5-v2';l.review.creatorFeeRatePpm=5000;l.review.creatorFeePolicy='flat-0.5-v2';await h.manager.save('a',book);
  await assert.rejects(h.manager.action('a',l.id,'launch',{confirm:true,reviewHash:l.reviewHash}),/creator-fee policy changed/);
  const preview=h.chain.preview;h.chain.preview=async input=>({...await preview(input),creatorFeeRatePpm:input.creatorFeeBps*100,creatorFeePolicy:input.creatorFeePolicy});const refreshed=await h.manager.refresh('a',l.id);assert.equal(refreshed.input.creatorFeeBps,0);assert.equal(refreshed.review.creatorFeeRatePpm,0);assert.equal(refreshed.input.taxBps,200);
  const legacy=await h.manager.book('a'),saved=legacy.launches[0];saved.input.taxBps=500;saved.input.creatorFeeBps=50;saved.input.creatorFeePolicy='flat-0.5-v2';saved.review.creatorFeeRatePpm=5000;saved.review.creatorFeePolicy='flat-0.5-v2';saved.state='pending';saved.authorizedAt=1;saved.operations=[{kind:'create',state:'pending',signature:'saved-old-create',raw:'original-signed-bytes'}];await h.manager.save('a',legacy);const original=structuredClone(saved);
  const resumed=await h.manager.action('a',saved.id,'resume');assert.equal(resumed.input.taxBps,500);assert.equal(resumed.review.creatorFeeRatePpm,5000);assert.deepEqual(h.stored.operations,original.operations);
});

test('new launches enforce 1% platform fees and 75/25 LP despite old saved burn settings and forged client policy',async t=>{
  const h=await managerHarness(t),recipient=newAddress(),chain=new LaunchChain({network:'mainnet-beta',connection:{}});
  h.manager.accounts.hostStore.read=async(key,fallback)=>key==='launch-protocol-fees'?{recipient,creationFeeSol:'0.015',curveFeeBps:0,lpPolicy:'burn',platformLpPercent:0,liquidityPolicyVersion:1}:fallback;
  for(const feeMode of ['creator','holders']){
    const created=await h.manager.create('a',raw({imageId:h.stored.input.imageId,feeMode,taxPercent:feeMode==='holders'?'3':'0',protocolFees:{recipient:newAddress(),curveFeeBps:0,lpPolicy:'burn'},creatorFeePercent:'0.01'}));
    const l=(await h.manager.book('a')).launches.find(row=>row.id===created.id),policy=l.review.protocolFees;
    assert.equal(policy.recipient,recipient);assert.equal(policy.curveFeeBps,100);assert.equal(policy.creationFeeSol,'0.015');assert.equal(policy.lpPolicy,'platform_locked');assert.equal(policy.platformLpPercent,75);assert.equal(l.review.platformFeeBps,100);assert.equal(l.review.creatorFeeRatePpm,feeMode==='holders'?0:5000);
    l.review.platformRent='15000000';
    const instruction=(await chain.launchInstructions(l,'platform')).find(ix=>ix.programId.equals(ray.LAUNCHPAD_PROGRAM));
    assert.equal(instruction.data.readBigUInt64LE(8),750000n);assert.equal(instruction.data.readBigUInt64LE(16),0n);assert.equal(instruction.data.readBigUInt64LE(24),250000n);assert.equal(instruction.data.readBigUInt64LE(32),10000n);let at=40;for(let field=0;field<3;field++)at+=4+instruction.data.readUInt32LE(at);assert.equal(instruction.data.readBigUInt64LE(at),feeMode==='holders'?0n:5000n);
    await h.manager.action('a',created.id,'launch',{confirm:true,reviewHash:created.reviewHash});
  }
  assert.equal(h.broadcasts.length,0);
});

test('refreshing an unsigned legacy draft installs the current protocol snapshot and requires its new review',async t=>{
  const h=await managerHarness(t,{input:{feeMode:'holders',taxPercent:'2'}}),book=await h.manager.book('a'),l=book.launches[0],oldHash=l.reviewHash;
  delete l.input.protocolFees;delete l.review.protocolFees;l.review.platformFeeBps=0;await h.manager.save('a',book);
  const before=structuredClone(h.stored);
  await assert.rejects(h.manager.action('a',l.id,'launch',{confirm:true,reviewHash:oldHash}),/protocol policy changed/);assert.deepEqual(h.stored,before);
  const refreshed=await h.manager.refresh('a',l.id);assert.notEqual(refreshed.reviewHash,oldHash);assert.equal(refreshed.review.platformFeeBps,100);assert.equal(refreshed.review.protocolFees.platformLpPercent,75);assert.equal(refreshed.review.creatorFeeRatePpm,0);assert.equal(refreshed.mint,l.keys.mint.address);
  await assert.rejects(h.manager.action('a',l.id,'launch',{confirm:true,reviewHash:oldHash}),/expired or changed/);
  await h.manager.action('a',l.id,'launch',{confirm:true,reviewHash:refreshed.reviewHash});assert.equal(h.stored.state,'launching');assert.equal(h.broadcasts.length,0);
});

test('protocol changes or an unconfigured recipient block first payment without rewriting a reviewed draft',async t=>{
  const h=await managerHarness(t),original=structuredClone(h.stored),newRecipient=newAddress();
  h.manager.accounts.hostStore.read=async(key,fallback)=>key==='launch-protocol-fees'?{recipient:newRecipient}:fallback;
  await assert.rejects(h.manager.action('a',original.id,'launch',{confirm:true,reviewHash:original.reviewHash}),/protocol policy changed/);assert.deepEqual(h.stored,original);
  const refreshed=await h.manager.refresh('a',original.id);assert.equal(refreshed.review.protocolFees.recipient,newRecipient);
  h.manager.accounts.hostStore.read=async(_key,fallback)=>fallback;
  const before=structuredClone(h.stored);
  await assert.rejects(h.manager.action('a',original.id,'launch',{confirm:true,reviewHash:refreshed.reviewHash}),/Configure Launchpad/);await assert.rejects(h.manager.refresh('a',original.id),/Configure Launchpad/);assert.deepEqual(h.stored,before);assert.equal(h.broadcasts.length,0);assert.equal(h.prepared,0);
});

test('an old authorized launch with no signed work cannot resume or start setup under the obsolete policy',async t=>{
  const h=await managerHarness(t),book=await h.manager.book('a'),l=book.launches[0];l.authorizedAt=h.manager.now();l.state='error';l.review.platformFeeBps=0;delete l.review.protocolFees;delete l.input.protocolFees;await h.manager.save('a',book);
  let uploads=0;h.manager.metadataStorage.upload=async()=>{uploads++;return true;};
  await assert.rejects(h.manager.action('a',l.id,'resume'),/protocol policy changed/);
  l.state='launching';await h.manager.save('a',book);await h.manager.process('a');assert.equal(h.stored.state,'draft');assert.equal(h.stored.authorizedAt,undefined);assert.equal(h.stored.reviewExpires,0);assert.match(h.stored.error,/protocol policy changed/);await h.manager.process('a');assert.equal(h.stored.recovery,undefined);assert.equal(uploads,0);assert.equal(h.prepared,0);assert.equal(h.broadcasts.length,0);
});

test('an already-signed legacy launch retains its reviewed recipient fees and exact saved transaction',async t=>{
  const h=await managerHarness(t),book=await h.manager.book('a'),l=book.launches[0];l.authorizedAt=1;l.state='pending';l.review.platformFeeBps=0;delete l.review.protocolFees;delete l.input.protocolFees;l.operations=[{kind:'setup',state:'pending',signature:'saved-old-policy-setup',raw:'exact-old-reviewed-bytes'}];await h.manager.save('a',book);const before=structuredClone(l);
  h.manager.accounts.hostStore.read=async(_key,fallback)=>fallback;
  await h.manager.action('a',l.id,'resume');assert.equal(h.stored.review.platformFeeBps,0);assert.deepEqual(h.stored.review,before.review);assert.deepEqual(h.stored.operations,before.operations);assert.equal(h.prepared,0);assert.equal(h.broadcasts.length,0);
});

test('new agent buyback requests are retired across every creation entrypoint without preparing or spending',async t=>{
  const h=await managerHarness(t),before=structuredClone(h.stored),input=raw({imageId:h.stored.input.imageId,feeMode:'buyback',devBuySol:'1',legacy:true,allowRetiredMode:true});
  let previews=0,uploads=0;h.chain.preview=async()=>{previews++;throw Error('must not preview retired launch');};h.manager.metadataStorage.prepare=async()=>{uploads++;throw Error('must not prepare retired launch');};
  for(const method of ['newLaunchInput','estimate','prepare','create'])await assert.rejects(h.manager[method]('a',input),error=>error.code==='LAUNCH_MODE_RETIRED'&&error.statusCode===409&&/no longer available/.test(error.message));
  const originalGet=h.manager.accounts.get;h.manager.accounts.get=async id=>({...await originalGet(id),role:'admin',mfaEnabled:true});
  await assert.rejects(h.manager.create('a',input,{adminLaunch:true}),error=>error.code==='LAUNCH_MODE_RETIRED');
  assert.equal(previews,0);assert.equal(uploads,0);assert.equal(h.prepared,0);assert.equal(h.broadcasts.length,0);assert.deepEqual(h.stored,before);assert.equal((await h.manager.book('a')).launches.length,1);
  assert.equal(launchInput(raw({feeMode:'buyback'})).feeMode,'buyback','historical parser remains compatible');
});

test('saved unspent agent drafts cannot refresh, approve, or resume and are never silently converted',async t=>{
  const h=await managerHarness(t,{input:{feeMode:'buyback'}}),book=await h.manager.book('a'),l=book.launches[0];
  const original=structuredClone(l);
  await assert.rejects(h.manager.refresh('a',l.id),error=>error.code==='LAUNCH_MODE_RETIRED');
  await assert.rejects(h.manager.action('a',l.id,'launch',{confirm:true,reviewHash:l.reviewHash}),error=>error.code==='LAUNCH_MODE_RETIRED');
  assert.deepEqual(h.stored,original);
  for(const state of ['error','launching']){
    l.state=state;l.authorizedAt=h.manager.now();await h.manager.save('a',book);const before=structuredClone(l);
    await assert.rejects(h.manager.action('a',l.id,'resume'),error=>error.code==='LAUNCH_MODE_RETIRED');
    await assert.rejects(h.manager.action('a',l.id,'launch',{confirm:true,reviewHash:l.reviewHash}),error=>error.code==='LAUNCH_MODE_RETIRED');
    assert.deepEqual(h.stored,before);
  }
  assert.equal(h.stored.input.feeMode,'buyback');assert.equal(h.prepared,0);assert.equal(h.broadcasts.length,0);
});

test('a previously authorized unspent agent draft stops before metadata upload or its first transaction',async t=>{
  const h=await managerHarness(t,{input:{feeMode:'buyback'}}),book=await h.manager.book('a'),l=book.launches[0];
  l.state='launching';l.authorizedAt=h.manager.now();l.autoFees=true;const savedInput=structuredClone(l.input);await h.manager.save('a',book);
  let uploads=0;h.manager.metadataStorage.upload=async()=>{uploads++;return true;};
  await h.manager.process('a');
  assert.equal(h.stored.state,'draft');assert.equal(h.stored.reviewExpires,0);assert.equal(h.stored.authorizedAt,undefined);assert.equal(h.stored.autoFees,false);assert.equal(h.stored.feesRequested,false);assert.match(h.stored.error,/Agent buyback launches are no longer available/);assert.deepEqual(h.stored.input,savedInput);
  await h.manager.process('a');assert.equal(h.stored.recovery,undefined);assert.equal(uploads,0);assert.equal(h.prepared,0);assert.equal(h.broadcasts.length,0);
});

test('saved paid, pending and wallet-signature agent launches retain their legacy continuation',async t=>{
  for(const state of ['confirmed','pending','awaiting_signature']){
    const h=await managerHarness(t,{input:{feeMode:'buyback'}}),book=await h.manager.book('a'),l=book.launches[0];
    l.state='error';l.authorizedAt=1;l.phase='create';l.operations=[{kind:'setup',state,signature:state==='awaiting_signature'?undefined:'legacy-setup-signature',operationId:'legacy-setup',raw:state==='pending'?'exact-legacy-bytes':undefined,unsignedRaw:state==='awaiting_signature'?'legacy-wallet-bytes':undefined}];
    await h.manager.save('a',book);const previous=structuredClone(l);
    const resumed=await h.manager.action('a',l.id,'resume');
    assert.equal(resumed.input.feeMode,'buyback');assert.deepEqual(h.stored.input,previous.input);assert.deepEqual(h.stored.operations,previous.operations);
    if(state==='confirmed'){
      await h.manager.process('a');assert.equal(h.stored.operations[1].kind,'create');assert.equal(h.stored.operations[1].state,'pending');assert.equal(h.prepared,1);assert.equal(h.broadcasts.length,1);
    }else {assert.equal(h.prepared,0);assert.equal(h.broadcasts.length,0);}
  }
});

test('new launch requests install the current 20k to 50k curve policy despite forged client fields',async t=>{
  const h=await managerHarness(t);
  for(const feeMode of ['creator','holders']){
    const request=raw({imageId:h.stored.input.imageId,feeMode,curvePolicy:'legacy-80-percent',graduationTargetUsd:'75000'});
    const input=await h.manager.newLaunchInput('a',request);
    assert.equal(input.targetUsd,'20000');assert.equal(input.curvePolicy,LAUNCH_CURVE_POLICY);assert.equal(input.graduationTargetUsd,'50000');
    const prepared=await h.manager.prepare('a',request);assert.equal(prepared.review.curvePolicy,LAUNCH_CURVE_POLICY);assert.equal(prepared.review.graduationTargetUsd,'50000');
    const created=await h.manager.create('a',{...request,prepareId:prepared.prepareId});
    assert.equal(created.input.curvePolicy,LAUNCH_CURVE_POLICY);assert.equal(created.review.graduationTargetUsd,'50000');
  }
  const get=h.manager.accounts.get;h.manager.accounts.get=async id=>({...await get(id),role:'admin',mfaEnabled:true});
  const admin=await h.manager.newLaunchInput('a',raw({targetUsd:'100000',graduationTargetUsd:'80000'}),{adminLaunch:true});
  assert.equal(admin.graduationTargetUsd,'250000');assert.equal(admin.curvePolicy,LAUNCH_CURVE_POLICY);
  assert.equal(launchInput(raw()).curvePolicy,undefined,'historical inputs do not gain new economics implicitly');assert.equal(h.broadcasts.length,0);
});

test('unspent legacy curve drafts need a new review and refresh changes only unsigned launch economics',async t=>{
  const h=await managerHarness(t),book=await h.manager.book('a'),l=book.launches[0];
  delete l.input.curvePolicy;delete l.input.graduationTargetUsd;delete l.review.curvePolicy;delete l.review.graduationTargetUsd;l.inputHash='old-curve-input-hash';
  await h.manager.save('a',book);const before=structuredClone(l),oldHash=l.reviewHash;
  await assert.rejects(h.manager.action('a',l.id,'launch',{confirm:true,reviewHash:oldHash}),error=>error.code==='LAUNCH_POLICY_REVIEW_REQUIRED'&&/curve policy changed/.test(error.message));
  assert.deepEqual(h.stored,before);
  const refreshed=await h.manager.refresh('a',l.id);
  assert.equal(refreshed.input.curvePolicy,LAUNCH_CURVE_POLICY);assert.equal(refreshed.input.graduationTargetUsd,'50000');assert.equal(refreshed.review.curvePolicy,LAUNCH_CURVE_POLICY);assert.notEqual(refreshed.reviewHash,oldHash);assert.notEqual(h.stored.inputHash,before.inputHash);assert.equal(refreshed.mint,before.keys.mint.address);assert.equal(refreshed.input.feeMode,before.input.feeMode);assert.equal(refreshed.input.targetUsd,before.input.targetUsd);
  const normalized=await h.manager.normalized('a',raw({imageId:h.stored.input.imageId}));assert.equal(h.stored.inputHash,normalized.inputHash);
  await assert.rejects(h.manager.action('a',l.id,'launch',{confirm:true,reviewHash:oldHash}),/expired or changed/);
  await h.manager.action('a',l.id,'launch',{confirm:true,reviewHash:refreshed.reviewHash});assert.equal(h.stored.state,'launching');assert.equal(h.broadcasts.length,0);
});

test('a queued unspent old curve is stopped before any upload or initial payment',async t=>{
  const h=await managerHarness(t),book=await h.manager.book('a'),l=book.launches[0];
  delete l.input.curvePolicy;delete l.input.graduationTargetUsd;delete l.review.curvePolicy;delete l.review.graduationTargetUsd;l.state='launching';l.authorizedAt=h.manager.now();await h.manager.save('a',book);
  let uploads=0;h.manager.metadataStorage.upload=async()=>{uploads++;return true;};const termsBefore=structuredClone(l.review);
  await h.manager.process('a');assert.equal(h.stored.state,'draft');assert.equal(h.stored.authorizedAt,undefined);assert.equal(h.stored.reviewExpires,0);assert.match(h.stored.error,/curve policy changed/);assert.deepEqual(h.stored.review,termsBefore);
  await h.manager.process('a');assert.equal(h.stored.recovery,undefined);assert.equal(uploads,0);assert.equal(h.prepared,0);assert.equal(h.broadcasts.length,0);
});

test('saved paid and pending old curves keep exact reviewed terms after the default graduation policy changes',async t=>{
  for(const state of ['confirmed','pending','awaiting_signature']){
    const h=await managerHarness(t),book=await h.manager.book('a'),l=book.launches[0];
    delete l.input.curvePolicy;delete l.input.graduationTargetUsd;delete l.review.curvePolicy;delete l.review.graduationTargetUsd;l.state='error';l.authorizedAt=1;l.phase='create';
    l.operations=[{kind:'setup',state,signature:state==='awaiting_signature'?undefined:'saved-original-policy',operationId:'saved-original-setup',raw:state==='pending'?'original-signed-bytes':undefined}];await h.manager.save('a',book);const before=structuredClone(l);
    await assert.rejects(h.manager.refresh('a',l.id),/submitted transaction/);
    await h.manager.action('a',l.id,'resume');assert.deepEqual(h.stored.review,before.review);assert.deepEqual(h.stored.input,before.input);assert.deepEqual(h.stored.operations,before.operations);
    if(state==='confirmed'){await h.manager.process('a');assert.equal(h.prepared,1);assert.equal(h.stored.operations[1].kind,'create');assert.deepEqual(h.stored.review,before.review);assert.equal(h.stored.input.curvePolicy,undefined);}
    else{assert.equal(h.prepared,0);assert.equal(h.broadcasts.length,0);}
  }
});

test('already initialized launches including official LAUNCHPAD retain original curve terms and cannot refresh them',async t=>{
  for(const mint of [newAddress(),'7rvRFpzP5W18yZcNpPNqtWgPTxLaFrnutz5QPxXpyupc']){
    const h=await managerHarness(t),book=await h.manager.book('a'),l=book.launches[0];
    delete l.input.curvePolicy;delete l.input.graduationTargetUsd;delete l.review.curvePolicy;delete l.review.graduationTargetUsd;l.keys.mint.address=mint;l.state='live';l.curve=newAddress();l.authorizedAt=1;l.autoFees=false;l.operations=[{kind:'create',state:'confirmed',signature:'original-created-pool'}];await h.manager.save('a',book);const before=structuredClone(l);
    await assert.rejects(h.manager.refresh('a',l.id),/submitted transaction/);
    await h.manager.action('a',l.id,'resume',{autoFees:false});assert.equal(h.stored.keys.mint.address,mint);assert.equal(h.stored.curve,before.curve);assert.deepEqual(h.stored.review,before.review);assert.deepEqual(h.stored.input,before.input);assert.deepEqual(h.stored.operations,before.operations);assert.equal(h.prepared,0);assert.equal(h.broadcasts.length,0);
  }
});
