import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PublicKey, Keypair, SystemProgram, TransactionMessage, ComputeBudgetProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { LaunchChain, ray, decodeRay, rayCurveAtTarget, rayCurveForLaunch } from '../src/launchpad-chain.mjs';
import { newLaunchKeys } from '../src/launchpad-receipts.mjs';
import { platformBrand } from '../src/launchpad-branding.mjs';
process.env.LAUNCHPAD_PUBLIC_URL='https://launchpad.example';
const LAUNCHPAD_PLATFORM_BRAND=platformBrand();
import { Launchpad } from '../src/launchpad.mjs';
import { launchInput, SOL_MINT, units } from '../public/launchpad-model.mjs';
import { transactionSize } from '../src/providers.mjs';

const fixture=JSON.parse(await readFile(new URL('./launchpad-accounts.json',import.meta.url),'utf8'));
const config=decodeRay({...fixture.rayConfig.account,owner:new PublicKey(fixture.rayConfig.account.owner),data:Buffer.from(fixture.rayConfig.account.data[0],'base64')},ray.LAUNCHPAD_PROGRAM,ray.LaunchpadConfig,'GlobalConfig');
function draft(name='Coin',symbol='COIN'){
  const keys=newLaunchKeys();keys.platform=keys.wallet;keys.payer={external:true,address:Keypair.generate().publicKey.toBase58()};
  const input=launchInput({name,symbol,quoteMint:SOL_MINT,feeMode:'creator',walletMode:'external',externalWallet:keys.payer.address,devBuySol:'0'});
  return {keys,input,feeCustody:'relay',executionPlan:'compact-v3',uri:'https://gateway.irys.xyz/'+'b'.repeat(44),storage:{provider:'irys',budget:'0',platformImage:'https://gateway.irys.xyz/'+'c'.repeat(44)},publicOrigin:'http://localhost:3000',review:{...rayCurveAtTarget(config,9,'100'),configId:fixture.rayConfig.pubkey,cpConfigId:'D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2',quoteProgram:TOKEN_PROGRAM_ID.toBase58(),platformRent:'15000000',serviceReserve:'20000000',storageWalletRent:'890880',minimumSol:'0.06',devBuy:{gross:'0'}}};
}
const chain=()=>new LaunchChain({network:'mainnet-beta',connection:{getAccountInfoAndContext:async()=>({context:{slot:100},value:null})}});
const packet=(payer,instructions)=>transactionSize(new TransactionMessage({payerKey:new PublicKey(payer),recentBlockhash:SystemProgram.programId.toBase58(),instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:10000}),...instructions]}).compileToV0Message());

test('a review without a brand snapshot carries the platform name, its uploaded logo and compact branding',async()=>{
  const c=chain(),l=draft();l.input.image='https://example.com/creator-token.png';
  const platform=(await c.launchInstructions(l,'platform-setup'))[0],creation=(await c.launchInstructions(l,'create'))[0];
  assert(platform.data.includes(Buffer.from('Launchpad')));assert(platform.data.includes(Buffer.from(l.storage.platformImage)));
  assert(!platform.data.includes(Buffer.from(l.input.image)));assert(!platform.data.includes(Buffer.from(l.publicOrigin)));
  assert(creation.data.includes(Buffer.from(l.uri)));assert(!creation.data.includes(Buffer.from(l.storage.platformImage)));
});

test('a maximum-size free-storage launch selects a fitting setup before asking for wallet approval',async()=>{
  const c=chain(),l=draft('N'.repeat(32),'T'.repeat(10));
  const combined=await c.launchInstructions(l,'launch-all');assert(packet(l.keys.payer.address,combined)>1232,'reproduce logo pushing the combined transaction over the packet limit');
  const plan=await c.preflightWalletSize(l);assert.equal(l.splitPlatformSetup,true);assert.equal(plan.transactions,2);assert.equal(plan.setupLamports,c.setupCost(l));
  for(const stage of ['setup','platform-setup','create']){
    const payer=stage==='platform-setup'?l.keys.platform.address:l.keys.payer.address,ixs=await c.launchInstructions(l,stage);
    assert(packet(payer,ixs)<=1232,stage+' fits without a shared lookup table');
  }
  assert.equal((await c.preflightWalletSize(l)).transactions,2,'re-preflight keeps the selected sequence stable');
});

test('a short branded launch still uses one combined approval when it fits',async()=>{
  const c=chain(),l=draft();const plan=await c.preflightWalletSize(l);
  assert.equal(plan.transactions,1);assert.equal(l.splitPlatformSetup,undefined);assert(packet(l.keys.payer.address,await c.launchInstructions(l,'launch-all'))<=1232);
});

test('the controller prices the branded split once and executes setup, platform setup and creation in order',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'launchpad-branding-controller-')),books=new Map(),template=draft('N'.repeat(32),'T'.repeat(10)),c=chain(),prepared=[],broadcasts=[];
  const accounts={dir,hostStore:{read:async(key,fallback)=>key==='launch-protocol-fees'?{recipient:'9xQeWvG816bUx9EPbHmaT23yvVMEBBcK4RJaymHMNHpJ'}:fallback},get:async()=>({mainWallet:template.keys.payer.address}),storeFor:id=>({dir:join(dir,id),read:async(key,fallback)=>structuredClone(books.get(id+':'+key)||fallback),write:async(key,value)=>books.set(id+':'+key,structuredClone(value))})};
  let balance=0,uploads=0;
  c.preview=async input=>({...structuredClone(template.review),...rayCurveForLaunch(config,9,'100',input),platformFeeBps:input.protocolFees?.curveFeeBps||0,protocolFees:structuredClone(input.protocolFees),creatorFeeRatePpm:input.creatorFeeBps*100,creatorFeePolicy:input.creatorFeePolicy});c.c.getBalance=async()=>balance;
  c.prepare=async(l,instructions,extra,kind)=>{
    const payer=kind==='platform-setup'?l.keys.platform.address:l.keys.payer.address;
    assert(packet(payer,instructions)<=1232,kind+' fits in the controller-selected sequence');prepared.push(kind);
    return {createdAt:Date.now(),lastValidBlockHeight:100,...(kind==='platform-setup'?{state:'pending',signature:'platform-signature',raw:'platform-bytes'}:{state:'awaiting_signature',needsSignature:true,unsignedRaw:kind+'-bytes',externalSigner:l.keys.payer.address})};
  };
  c.acceptSigned=async op=>({state:'pending',needsSignature:false,signature:op.kind+'-signature',raw:op.kind+'-signed'});
  c.broadcast=async op=>broadcasts.push(op.kind);
  c.receipt=async()=>({slot:101,meta:{err:null,preTokenBalances:[],postTokenBalances:[]}});
  c.preflightLaunch=async()=>{};c.verifyLaunch=async l=>({curve:c.addresses(l).pool.toBase58()});
  const manager=new Launchpad(accounts,null,{chainFactory:()=>c,metadataStorage:{prepare:async()=>({uri:template.uri,imageUrl:'https://gateway.irys.xyz/'+'d'.repeat(44),metadata:{},storage:structuredClone(template.storage)}),upload:async()=>{uploads++;return true;}}});
  manager.ownedImage=async()=>({bytes:Buffer.alloc(0),type:'image/png'});manager.kick=()=>{};
  t.after(async()=>{await manager.close();await rm(dir,{recursive:true,force:true});});
  const {launch}=await manager.buildDraft('a',{input:structuredClone(template.input),payer:template.keys.payer,inputHash:'test-hash'});
  assert.equal(launch.splitPlatformSetup,true);assert.equal(launch.review.approvals,2);assert.equal(launch.review.minimumSol,'0.06091588');assert.equal(launch.phase,'metadata');assert.deepEqual(prepared,[]);
  await manager.save('a',{version:1,launches:[launch]});
  for(let attempt=0;attempt<2;attempt++){
    const refreshed=await manager.refresh('a',launch.id);assert.equal(refreshed.review.minimumSol,'0.06091588','refresh must not add the extra setup reserve twice');assert.equal(refreshed.review.approvals,2);
  }
  let book=await manager.book('a'),current=book.launches[0];
  await manager.action('a',current.id,'launch',{confirm:true,reviewHash:current.reviewHash});book=await manager.book('a');current=book.launches[0];
  balance=Number(units(current.review.minimumSol)-1n);
  await assert.rejects(manager.advanceLaunch('a',book,current,c),/Add SOL/);assert.equal(current.phase,'setup');assert.deepEqual(prepared,[],'nothing is signed while below the newly reviewed total');
  balance=Number(units(current.review.minimumSol));await manager.advanceLaunch('a',book,current,c);assert.deepEqual(prepared,['setup']);assert.equal(uploads,1);
  const approve=async()=>{const l=(await manager.book('a')).launches[0],op=l.operations.find(o=>o.state==='awaiting_signature');assert(op);await manager.sign('a',l.id,op.operationId,'wallet-approved');};
  await approve();await manager.process('a');assert.equal((await manager.book('a')).launches[0].phase,'platform-setup');
  await manager.process('a');assert.deepEqual(prepared,['setup','platform-setup']);await manager.process('a');assert.equal((await manager.book('a')).launches[0].phase,'create');
  await manager.process('a');assert.deepEqual(prepared,['setup','platform-setup','create']);await approve();await manager.process('a');await manager.process('a');
  const finished=(await manager.book('a')).launches[0];assert.equal(finished.state,'live');assert.equal(finished.review.minimumSol,'0.06091588');assert.deepEqual(broadcasts,['setup','platform-setup','create']);assert.equal(uploads,1,'metadata is not uploaded again after the platform step');
});


test('new Launchpad launches snapshot the canonical website and permanent logo without changing coin identity',async()=>{
 const c=chain(),l=draft('Creator coin','COIN');l.review.platformBrand={...LAUNCHPAD_PLATFORM_BRAND,img:l.storage.platformImage};l.input.image='https://example.com/creator-token.png';
 const original=structuredClone(l),[platform]=await c.launchInstructions(l,'platform-setup'),[creation]=await c.launchInstructions(l,'create');
 for(const value of ['Launchpad','https://launchpad.example',l.storage.platformImage])assert(platform.data.includes(Buffer.from(value)));
 assert(!platform.data.includes(Buffer.from('Previous name')));assert(!platform.data.includes(Buffer.from(l.input.image)));assert(creation.data.includes(Buffer.from('Creator coin')));assert.deepEqual(l,original);
});

test('maximum-size Launchpad branding with a creation fee fits the preapproved connected-wallet plan',async()=>{
 const c=chain(),l=draft('N'.repeat(32),'T'.repeat(10));l.review.platformBrand={...LAUNCHPAD_PLATFORM_BRAND,img:l.storage.platformImage};l.review.protocolFees={creationFeeSol:'0.03',recipient:Keypair.generate().publicKey.toBase58()};
 const plan=await c.preflightWalletSize(l);assert.equal(plan.transactions,2);assert.equal(l.splitPlatformSetup,true);
 for(const stage of ['setup','platform-setup','create']){const payer=stage==='platform-setup'?l.keys.platform.address:l.keys.payer.address;assert(packet(payer,await c.launchInstructions(l,stage))<=1232,stage+' must fit');}
});
