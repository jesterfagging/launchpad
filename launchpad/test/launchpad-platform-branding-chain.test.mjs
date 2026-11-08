import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import { LaunchChain, ray } from '../src/launchpad-chain.mjs';
import { platformBrand } from '../src/launchpad-branding.mjs';
import { CREATOR_FEE_POLICY } from '../public/creator-fee-schedule.mjs';
import { creatorFeeDecision } from '../src/launchpad-creator-fees.mjs';
import { SOL_MINT } from '../public/launchpad-model.mjs';
process.env.LAUNCHPAD_PUBLIC_URL='https://launchpad.example';
const BRAND=platformBrand();
const bn=n=>new BN(String(n)),key=()=>Keypair.generate().publicKey,text=(s,size)=>[...Buffer.concat([Buffer.from(s),Buffer.alloc(size-Buffer.byteLength(s))])];
function account(layout,name,fields,owner=ray.LAUNCHPAD_PROGRAM){const data=Buffer.alloc(layout.span);layout.encode({...layout.decode(data),...fields},data);createHash('sha256').update('account:'+name).digest().copy(data,0,0,8);return{owner,data,executable:false,lamports:1000000};}
function harness(){
  const w=key(),admin=key(),m=key(),q=new PublicKey(SOL_MINT),configId=key(),cpConfigId=key(),l={curve:'',feeCustody:'relay',input:{route:'raydium',network:'mainnet-beta',quoteMint:SOL_MINT,creatorFeeBps:30,creatorFeePolicy:CREATOR_FEE_POLICY},review:{configId:configId.toBase58(),cpConfigId:cpConfigId.toBase58(),platformFeeBps:100,creatorFeeRatePpm:3000,creatorFeePolicy:CREATOR_FEE_POLICY},keys:{wallet:{address:w.toBase58()},platform:{address:admin.toBase58()},mint:{address:m.toBase58()}}};
  let slot=101,accounts=[];const calls=[];
  const chain=new LaunchChain({network:'mainnet-beta',connection:{getMultipleAccountsInfoAndContext:async(keys,options)=>{calls.push({keys:keys.map(String),options});return{context:{slot},value:accounts};},getAccountInfoAndContext:async(_key,options)=>{calls.push({options});return{context:{slot},value:accounts[1]};}}});
  const a=chain.addresses(l);l.curve=a.pool.toBase58();
  const state={status:0,mintA:m,mintB:q,creator:w,platformId:a.platform,configId};
  const platform={platformClaimFeeWallet:w,platformLockNftWallet:key(),platformVestingWallet:key(),cpConfigId,platformScale:bn(750000),creatorScale:bn(0),burnScale:bn(250000),feeRate:bn(10000),creatorFeeRate:bn(3000),name:text('Previous name',64),web:text('https://previous.example/',256),img:text('https://previous.example/logo.png',256),transferFeeExtensionAuth:key(),platformVestingScale:bn(12),platformCpCreator:key(),restrictGlobalConfig:1,restrictCurveParam:1,curveRuleManager:key()};
  const reset=()=>{accounts=[account(ray.LaunchpadPool,'PoolState',state),account(ray.PlatformConfig,'PlatformConfig',platform)];};reset();
  const decision={target:{...BRAND}};
  return{l,chain,a,state,platform,decision,calls,reset,get accounts(){return accounts;},set slot(value){slot=value;}};
}

function applyBrand(h){for(const field of ['name','web','img'])h.platform[field]=text(h.decision.target[field],field==='name'?64:256);h.reset();}
test('platform branding changes only the three text fields and preserves all financial and authority state',async()=>{
  const h=harness(),before=structuredClone(h.l),ixs=await h.chain.platformBrandUpdateInstructions(h.l,h.decision);
  assert.deepEqual(h.l,before);assert.equal(ixs.length,3);
  for(const [index,field]of ['name','web','img'].entries()){
    const ix=ixs[index];assert(ix.programId.equals(ray.LAUNCHPAD_PROGRAM));assert(ix.keys[0].pubkey.equals(h.a.admin));assert(ix.keys[1].pubkey.equals(h.a.platform));
    assert.equal(ix.data.readUInt8(8),index+4);assert.equal(ix.data.subarray(13).toString('utf8'),h.decision.target[field]);
  }
  assert.deepEqual(h.calls[0].options,{commitment:'finalized'});assert.equal(h.decision.platformSlot,101);assert.match(h.decision.platformHash,/^[a-f0-9]{64}$/);
  applyBrand(h);assert.equal(await h.chain.verifyPlatformBrandUpdate(h.l,h.decision,101),true);assert.deepEqual(h.calls.at(-1).options,{commitment:'finalized',minContextSlot:101});
});
test('brand updates accept graduated platforms but reject an unrelated pool or untrusted brand URL',async()=>{
  const graduated=harness();graduated.state.status=2;graduated.reset();assert.equal((await graduated.chain.platformBrandUpdateInstructions(graduated.l,graduated.decision)).length,3);
  for(const mutate of [h=>{h.state.creator=key();h.reset();},h=>{h.state.mintA=key();h.reset();},h=>{h.state.mintB=key();h.reset();},h=>{h.state.platformId=key();h.reset();},h=>{h.state.configId=key();h.reset();},h=>{h.accounts[1].owner=SystemProgram.programId;},h=>{h.accounts[1].executable=true;},h=>{h.decision.target.img='https://evil.example/logo.png';},h=>{h.decision.target.web='https://elsewhere.example';},h=>{h.decision.target.name='Other';}]){const h=harness();mutate(h);await assert.rejects(h.chain.platformBrandUpdateInstructions(h.l,h.decision));}
});
test('brand receipts require finalized exact text and unchanged fees, LP allocations, wallets and authorities',async()=>{
  for(const mutate of [h=>{h.platform.creatorFeeRate=bn(5000);},h=>{h.platform.feeRate=bn(0);},h=>{h.platform.burnScale=bn(1000000);},h=>{h.platform.platformClaimFeeWallet=key();},h=>{h.platform.platformLockNftWallet=key();},h=>{h.platform.platformVestingWallet=key();},h=>{h.platform.platformCpCreator=key();},h=>{h.platform.curveRuleManager=key();},h=>{h.platform.transferFeeExtensionAuth=key();},h=>{h.platform.name=text('Wrong',64);},h=>{h.slot=100;}]){
    const h=harness();await h.chain.platformBrandUpdateInstructions(h.l,h.decision);applyBrand(h);mutate(h);h.reset();await assert.rejects(h.chain.verifyPlatformBrandUpdate(h.l,h.decision,101));
  }
  const h=harness();await h.chain.platformBrandUpdateInstructions(h.l,h.decision);applyBrand(h);h.platform.epoch=bn(99);h.reset();assert.equal(await h.chain.verifyPlatformBrandUpdate(h.l,h.decision,101),true);
});

// A queued target keeps the uploaded copy of its logo; a renamed or moved platform needs a new review.
test('queued platform updates keep their uploaded logo, and a renamed or moved platform needs a new review',async()=>{
  const h=harness();h.decision.target={...BRAND,img:'https://gateway.irys.xyz/'+'A'.repeat(43)};
  const before=structuredClone(h.decision.target),ixs=await h.chain.platformBrandUpdateInstructions(h.l,h.decision);
  assert.deepEqual(h.decision.target,before);assert(ixs[2].data.includes(Buffer.from(before.img)));
  applyBrand(h);assert.equal(await h.chain.verifyPlatformBrandUpdate(h.l,h.decision,101),true);
  for(const change of [{version:'unrecognized'},{name:'Another name'},{web:'https://another.example'},{img:'https://another.example/logo.png'}]){
    h.decision.target={...before,...change};await assert.rejects(h.chain.platformBrandUpdateInstructions(h.l,h.decision),/Invalid platform branding/);
  }
});
