import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import { LaunchChain, ray } from '../src/launchpad-chain.mjs';
import { CREATOR_FEE_POLICY,HOLDER_CREATOR_FEE_POLICY } from '../public/creator-fee-schedule.mjs';
import {protocolPolicyTarget} from '../src/launchpad-policy-upgrade.mjs';
import { SOL_MINT } from '../public/launchpad-model.mjs';
const bn=n=>new BN(String(n)),key=()=>Keypair.generate().publicKey,text=(s,size)=>[...Buffer.concat([Buffer.from(s),Buffer.alloc(size-Buffer.byteLength(s))])];
function account(layout,name,fields,owner=ray.LAUNCHPAD_PROGRAM){const data=Buffer.alloc(layout.span);layout.encode({...layout.decode(data),...fields},data);createHash('sha256').update('account:'+name).digest().copy(data,0,0,8);return{owner,data,executable:false,lamports:1000000};}
function harness(){
  const w=key(),admin=key(),m=key(),q=new PublicKey(SOL_MINT),configId=key(),cpConfigId=key();
  const l={curve:'',feeCustody:'relay',input:{route:'raydium',network:'mainnet-beta',quoteMint:SOL_MINT,creatorFeeBps:25},review:{configId:configId.toBase58(),cpConfigId:cpConfigId.toBase58(),platformFeeBps:0},keys:{wallet:{address:w.toBase58()},platform:{address:admin.toBase58()},mint:{address:m.toBase58()}},protocolActivation:protocolPolicyTarget()};
  let slot=101,accounts=[];const calls=[];
  const chain=new LaunchChain({network:'mainnet-beta',connection:{getMultipleAccountsInfoAndContext:async(keys,options)=>{calls.push({keys:keys.map(String),options});return {context:{slot},value:accounts};},getAccountInfoAndContext:async()=>({context:{slot},value:accounts[1]}),getProgramAccounts:async()=>({context:{slot},value:[{pubkey:new PublicKey(l.curve),account:accounts[0]}]})}});
  const a=chain.addresses(l);l.curve=a.pool.toBase58();
  const state={status:0,migrateType:1,mintA:m,mintB:q,creator:w,platformId:a.platform,configId};
  const platform={platformClaimFeeWallet:w,platformLockNftWallet:w,platformVestingWallet:key(),cpConfigId,platformScale:bn(0),creatorScale:bn(0),burnScale:bn(1000000),feeRate:bn(0),creatorFeeRate:bn(2500),name:text('Platform',64),web:text('https://app.example/',256),img:text('https://app.example/logo.png',256),transferFeeExtensionAuth:key(),platformVestingScale:bn(12),platformCpCreator:PublicKey.default,restrictGlobalConfig:1,restrictCurveParam:1,curveRuleManager:key()};
  const reset=()=>{accounts=[account(ray.LaunchpadPool,'PoolState',state),account(ray.PlatformConfig,'PlatformConfig',platform)];};reset();
  return {l,chain,a,state,platform,calls,reset,get accounts(){return accounts;},set slot(value){slot=value;}};
}
function applyPolicy(h){Object.assign(h.platform,{feeRate:bn(10000),creatorFeeRate:bn(5000),platformScale:bn(750000),creatorScale:bn(0),burnScale:bn(250000)});h.reset();}
function decodeUpdate(ix){let offset=8;const bytes=n=>{const value=ix.data.subarray(offset,offset+n);offset+=n;return value;},u64=()=>bytes(8).readBigUInt64LE().toString(),pk=()=>new PublicKey(bytes(32)).toBase58(),str=()=>{const n=bytes(4).readUInt32LE();return bytes(n).toString('utf8');};assert.equal(bytes(1)[0],8);return{platformClaimFeeWallet:pk(),platformLockNftWallet:pk(),platformScale:u64(),creatorScale:u64(),burnScale:u64(),feeRate:u64(),name:str(),web:str(),img:str(),transferFeeExtensionAuth:pk(),creatorFeeRate:u64(),platformVestingScale:u64(),platformVestingWallet:pk()};}


test('one atomic instruction upgrades 75/25 LP, 1% platform and 0.5% creator fees while preserving every wallet and unrelated setting',async()=>{
  const h=harness(),before=structuredClone(h.l.review),ixs=await h.chain.protocolActivationInstructions(h.l),value=decodeUpdate(ixs[0]);
  assert.equal(ixs.length,1);assert.equal(value.creatorFeeRate,'5000');assert.equal(value.feeRate,'10000');assert.equal(value.platformScale,'750000');assert.equal(value.creatorScale,'0');assert.equal(value.burnScale,'250000');
  for(const field of ['platformClaimFeeWallet','platformLockNftWallet','platformVestingWallet','transferFeeExtensionAuth'])assert.equal(value[field],h.platform[field].toBase58());
  assert.equal(value.platformVestingScale,'12');assert.equal(value.name,'Platform');assert.equal(value.web,'https://app.example/');assert.equal(value.img,'https://app.example/logo.png');
  assert(ixs[0].keys[0].pubkey.equals(h.a.admin));assert(ixs[0].keys[1].pubkey.equals(h.a.platform));assert.equal(ixs[0].keys[2].pubkey.toBase58(),h.l.review.cpConfigId);assert.deepEqual(h.l.review,before);
  assert.equal(h.l.protocolActivation.platformSlot,101);assert.match(h.l.protocolActivation.platformHash,/^[a-f0-9]{64}$/);
  applyPolicy(h);assert.equal(await h.chain.verifyProtocolActivation(h.l,101),true);assert.deepEqual(h.calls.at(-1).options,{commitment:'finalized',minContextSlot:101});
});
test('already activated legacy launches can also upgrade their LP allocation and creator rate',async()=>{
  const h=harness();h.l.review.platformFeeBps=100;h.platform.feeRate=bn(10000);h.l.creatorFees={policy:'sol-market-cap-v1',ratePpm:2750};h.platform.creatorFeeRate=bn(2750);h.reset();
  assert.equal(decodeUpdate((await h.chain.protocolActivationInstructions(h.l))[0]).creatorFeeRate,'5000');applyPolicy(h);assert.equal(await h.chain.verifyProtocolActivation(h.l,101),true);
});
test('policy builds reject graduated curves, substituted accounts, altered rates, LP shares and authorities',async()=>{
  const mutations=[h=>{h.state.status=1;},h=>{h.state.status=2;},h=>{h.state.migrateType=0;},h=>{h.l.curve=key().toBase58();},h=>{h.state.creator=key();},h=>{h.state.mintA=key();},h=>{h.state.mintB=key();},h=>{h.state.platformId=key();},h=>{h.state.configId=key();},h=>{h.platform.creatorFeeRate=bn(3000);},h=>{h.platform.feeRate=bn(10000);},h=>{h.platform.platformScale=bn(750000);},h=>{h.platform.burnScale=bn(250000);},h=>{h.platform.creatorScale=bn(1);},h=>{h.platform.cpConfigId=key();},h=>{h.platform.platformClaimFeeWallet=key();},h=>{h.platform.platformLockNftWallet=key();},h=>{h.platform.platformCpCreator=key();},h=>{h.l.protocolActivation.platformLpPercent=100;},h=>{h.l.protocolActivation.creatorFeeRatePpm=3000;},h=>{h.l.feeCustody='creator';},h=>{h.slot=0;}];
  for(const mutate of mutations){const h=harness();mutate(h);h.reset();await assert.rejects(h.chain.protocolActivationInstructions(h.l));}
  for(const mutate of [h=>{h.accounts[1].owner=SystemProgram.programId;},h=>{h.accounts[1].executable=true;},h=>{h.accounts[0]=null;}]){const h=harness();mutate(h);await assert.rejects(h.chain.protocolActivationInstructions(h.l));}
});
test('upgrade receipts require the entire finalized target state and fail closed if graduation overlaps confirmation',async()=>{
  const mutations=[h=>{h.platform.creatorFeeRate=bn(4500);},h=>{h.platform.platformScale=bn(500000);},h=>{h.platform.burnScale=bn(1000000);},h=>{h.platform.feeRate=bn(0);},h=>{h.platform.platformClaimFeeWallet=key();},h=>{h.platform.platformLockNftWallet=key();},h=>{h.platform.platformVestingWallet=key();},h=>{h.platform.platformCpCreator=key();},h=>{h.platform.curveRuleManager=key();},h=>{h.platform.transferFeeExtensionAuth=key();},h=>{h.platform.name=text('Changed',64);},h=>{h.state.status=2;},h=>{h.state.mintA=key();},h=>{h.slot=100;}];
  for(const mutate of mutations){const h=harness();await h.chain.protocolActivationInstructions(h.l);applyPolicy(h);mutate(h);h.reset();await assert.rejects(h.chain.verifyProtocolActivation(h.l,101));}
  const h=harness();await h.chain.protocolActivationInstructions(h.l);applyPolicy(h);h.platform.epoch=bn(99);h.state.status=1;h.reset();assert.equal(await h.chain.verifyProtocolActivation(h.l,101),true);
});
test('v32 requests already queued retain their fee-only scope after installing v33',async()=>{
  const h=harness();h.l.protocolActivation={curveFeeBps:100,lpPolicy:'burn',platformLpPercent:0};
  const [ix]=await h.chain.protocolActivationInstructions(h.l);assert.equal(ix.data[8],3);assert.equal(ix.data.readBigUInt64LE(9),10000n);assert.equal(h.l.protocolActivation.upgradeVersion,undefined);
});
test('new previews use 0.5% for every valuation and never fetch a separate SOL fee reference',async()=>{
  for(const [quoteMint,solUsd,target,expected] of [[SOL_MINT,'50','20000',5000],[SOL_MINT,'40','20000',5000],[key().toBase58(),'200','100000',5000]]){
    const q=new PublicKey(quoteMint),config={mintB:q,curveType:0,index:0,migrateFee:bn(0),minFundRaisingB:bn(1),minSupplyA:bn(10000000),minSellRateA:bn(1),minMigrateRateA:bn(150000),maxLockRate:bn(999999),tradeFeeRate:bn(2500)},configId=ray.getPdaLaunchpadConfigId(ray.LAUNCHPAD_PROGRAM,q,0,0).publicKey,cpId=key();
    const chain=new LaunchChain({network:'mainnet-beta',connection:{getProgramAccounts:async program=>program.equals(ray.LAUNCHPAD_PROGRAM)?[{pubkey:configId,account:account(ray.LaunchpadConfig,'GlobalConfig',config)}]:[{pubkey:cpId,account:account(ray.CpmmConfigInfoLayout,'AmmConfig',{creatorFeeRate:bn(500),tradeFeeRate:bn(2500)},ray.CREATE_CPMM_POOL_PROGRAM)}]}});
    chain.mintInfo=async mint=>({key:new PublicKey(mint),program:TOKEN_PROGRAM_ID,mint:{decimals:9,freezeAuthority:null},extensions:[]});chain.referencePrice=async input=>{assert.equal(input.quoteMint,quoteMint);return {usd:input.quoteMint===SOL_MINT?solUsd:'60000',at:Date.now(),stale:false};};chain.fundingEstimate=async()=>({minimumSol:'0.1'});chain.devBuyEstimate=async(_input,review)=>{assert.equal(review.creatorFeeRatePpm,expected);return{solBudget:'0',gross:'0',net:'0',maxQuote:'0'};};
    const review=await chain.preview({network:'mainnet-beta',route:'raydium',quoteMint,creatorFeeBps:30,creatorFeePolicy:CREATOR_FEE_POLICY,targetUsd:target,taxBps:0});assert.equal(review.creatorFeeRatePpm,expected);assert.equal(review.creatorFeeBps,expected/100);assert.equal(review.creatorFeePolicy,CREATOR_FEE_POLICY);
  }
});


test('a genuine legacy policy update rotates only protocol and LP wallets to its original platform admin',async()=>{
  const h=harness();delete h.l.feeCustody;h.l.keys.payer=h.l.keys.wallet;h.l.walletExportedAt=1;
  h.l.protocolActivation.protocolFeeWallet={source:'platform',address:h.l.keys.platform.address};const original=structuredClone(h.l);
  const value=decodeUpdate((await h.chain.protocolActivationInstructions(h.l))[0]);
  assert.equal(value.platformClaimFeeWallet,h.l.keys.platform.address);assert.equal(value.platformLockNftWallet,h.l.keys.platform.address);
  assert.equal(value.transferFeeExtensionAuth,h.platform.transferFeeExtensionAuth.toBase58());assert.equal(value.platformVestingWallet,h.platform.platformVestingWallet.toBase58());assert.equal(value.creatorFeeRate,'5000');assert.equal(value.platformScale,'750000');
  applyPolicy(h);await assert.rejects(h.chain.verifyProtocolActivation(h.l,101),/protocol wallets/);
  h.platform.platformClaimFeeWallet=h.a.admin;h.platform.platformLockNftWallet=h.a.admin;h.reset();assert.equal(await h.chain.verifyProtocolActivation(h.l,101),true);
  assert.equal(h.state.creator.toBase58(),original.keys.wallet.address);assert(h.platform.platformCpCreator.equals(PublicKey.default));assert.deepEqual(h.l.keys,original.keys);assert.deepEqual(h.l.review,original.review);assert.equal(h.l.feeCustody,undefined);
});

test('legacy rotation rejects substituted, exported, shared-with-creator and already funded protocol authorities',async()=>{
  for(const mutate of [h=>{h.l.protocolActivation.protocolFeeWallet.address=key().toBase58();},h=>{h.l.protocolActivation.protocolFeeWallet.source='wallet';},h=>{h.l.keys.platform.exportedAt=1;},h=>{h.l.keys.platform.external=true;},h=>{h.l.keys.payer=h.l.keys.platform;},h=>{h.l.keys.wallet=h.l.keys.platform;},h=>{h.l.protocolCredit='1';},h=>{h.l.review.platformFeeBps=100;h.platform.feeRate=bn(10000);},h=>{h.state.status=2;}]){
    const h=harness();delete h.l.feeCustody;h.l.protocolActivation.protocolFeeWallet={source:'platform',address:h.l.keys.platform.address};mutate(h);h.reset();await assert.rejects(h.chain.protocolActivationInstructions(h.l));
  }
});

function freshLegacy(h){
  delete h.l.feeCustody;h.l.keys.platform=h.l.keys.wallet;h.l.keys.payer=h.l.keys.wallet;h.l.keys.wallet.exportedAt=1;
  h.l.keys.protocol={address:key().toBase58(),purpose:'protocol-fees'};
  h.l.protocolActivation.protocolFeeWallet={source:'protocol',address:h.l.keys.protocol.address};
  h.state.platformId=h.chain.addresses(h.l).platform;h.reset();return h;
}
test('owner legacy layout can assign a fresh fee recipient without requiring it to sign or changing creator authorities',async()=>{
  const h=freshLegacy(harness()),creator=h.l.keys.wallet.address,before=structuredClone(h.l.keys),[ix]=await h.chain.protocolActivationInstructions(h.l),value=decodeUpdate(ix);
  assert.equal(ix.keys[0].pubkey.toBase58(),creator);assert.equal(ix.keys[0].isSigner,true);
  assert.equal(ix.keys.some(row=>row.isSigner&&row.pubkey.toBase58()===h.l.keys.protocol.address),false);
  assert.equal(value.platformClaimFeeWallet,h.l.keys.protocol.address);assert.equal(value.platformLockNftWallet,h.l.keys.protocol.address);
  assert.equal(value.platformVestingWallet,h.platform.platformVestingWallet.toBase58());assert.equal(value.transferFeeExtensionAuth,h.platform.transferFeeExtensionAuth.toBase58());
  applyPolicy(h);await assert.rejects(h.chain.verifyProtocolActivation(h.l,101),/protocol wallets/);
  h.platform.platformClaimFeeWallet=new PublicKey(h.l.keys.protocol.address);h.platform.platformLockNftWallet=new PublicKey(h.l.keys.protocol.address);h.reset();
  assert.equal(await h.chain.verifyProtocolActivation(h.l,101),true);assert.deepEqual(h.l.keys,before);assert.equal(h.state.creator.toBase58(),creator);
});
test('fresh legacy recipient requires complete finalized single-pool platform scope before producing instructions',async()=>{
  for(const bad of ['unavailable','stale','empty','shared','wrong-owner','wrong-pool']){
    const h=freshLegacy(harness());
    h.chain.c.getProgramAccounts=bad==='unavailable'?undefined:async(_program,options)=>{
      assert.equal(options.withContext,true);assert.equal(options.commitment,'finalized');assert.equal(options.minContextSlot,101);
      assert.deepEqual(options.filters,[{dataSize:429},{memcmp:{offset:173,bytes:h.state.platformId.toBase58()}}]);
      const row={pubkey:new PublicKey(h.l.curve),account:h.accounts[0]};
      if(bad==='wrong-owner')row.account={...row.account,owner:SystemProgram.programId};
      if(bad==='wrong-pool')row.pubkey=key();
      return {context:{slot:bad==='stale'?100:101},value:bad==='empty'?[]:bad==='shared'?[row,{...row,pubkey:key()}]:[row]};
    };
    await assert.rejects(h.chain.protocolActivationInstructions(h.l));assert.equal(h.l.protocolActivation.platformHash,undefined);
  }
});
test('fresh legacy recipients reject collisions, exports, compromise, external admins and existing protocol credits',async()=>{
  for(const mutate of [h=>{h.l.keys.protocol.address=h.l.keys.wallet.address;h.l.protocolActivation.protocolFeeWallet.address=h.l.keys.wallet.address;},h=>{h.l.keys.protocol.exportedAt=1;},h=>{h.l.keys.protocol.compromisedAt=1;},h=>{h.l.keys.protocol.external=true;},h=>{h.l.keys.platform.external=true;},h=>{h.l.keys.platform.compromised=true;},h=>{h.l.platformWalletCompromisedAt=1;},h=>{h.l.protocolCredit='1';}]){
    const h=freshLegacy(harness());mutate(h);await assert.rejects(h.chain.protocolActivationInstructions(h.l));
  }
});

test('taxed holder upgrade removes only the curve creator fee, preserves CPMM tier, and verifies zero onchain',async()=>{
  const h=harness();h.l.input.feeMode='holders';h.l.input.taxBps=500;h.l.protocolActivation=protocolPolicyTarget(h.l);const cpBefore=h.l.review.cpConfigId,keysBefore=structuredClone(h.l.keys),[ix]=await h.chain.protocolActivationInstructions(h.l),value=decodeUpdate(ix);
  assert.equal(value.creatorFeeRate,'0');assert.equal(value.feeRate,'10000');assert.equal(value.platformScale,'750000');assert.equal(value.burnScale,'250000');assert.equal(ix.keys[2].pubkey.toBase58(),cpBefore);assert.equal(h.l.review.cpConfigId,cpBefore);assert.equal(h.l.input.taxBps,500);assert.deepEqual(h.l.keys,keysBefore);
  applyPolicy(h);await assert.rejects(h.chain.verifyProtocolActivation(h.l,101),/confirmed fees/);h.platform.creatorFeeRate=bn(0);h.reset();assert.equal(await h.chain.verifyProtocolActivation(h.l,101),true);
});
test('saved version2 holder upgrade keeps its already-approved flat rate while new version3 target must match its mode',async()=>{
  const h=harness();h.l.input.feeMode='holders';h.l.input.taxBps=300;h.l.protocolActivation={...protocolPolicyTarget(),upgradeVersion:2};assert.equal(decodeUpdate((await h.chain.protocolActivationInstructions(h.l))[0]).creatorFeeRate,'5000');applyPolicy(h);assert.equal(await h.chain.verifyProtocolActivation(h.l,101),true);
  const fresh=harness();fresh.l.input.feeMode='holders';fresh.l.input.taxBps=300;await assert.rejects(fresh.chain.protocolActivationInstructions(fresh.l),/policy upgrade is invalid/);
});
test('zero creator-fee previews preserve 1% platform and configured CPMM fees independently',async()=>{
  const q=new PublicKey(SOL_MINT),config={mintB:q,curveType:0,index:0,migrateFee:bn(0),minFundRaisingB:bn(1),minSupplyA:bn(10000000),minSellRateA:bn(1),minMigrateRateA:bn(150000),maxLockRate:bn(999999),tradeFeeRate:bn(2500)},configId=ray.getPdaLaunchpadConfigId(ray.LAUNCHPAD_PROGRAM,q,0,0).publicKey,cpId=key();
  const chain=new LaunchChain({network:'mainnet-beta',connection:{getProgramAccounts:async program=>program.equals(ray.LAUNCHPAD_PROGRAM)?[{pubkey:configId,account:account(ray.LaunchpadConfig,'GlobalConfig',config)}]:[{pubkey:cpId,account:account(ray.CpmmConfigInfoLayout,'AmmConfig',{creatorFeeRate:bn(500),tradeFeeRate:bn(2500)},ray.CREATE_CPMM_POOL_PROGRAM)}]}});
  chain.mintInfo=async mint=>({key:new PublicKey(mint),program:TOKEN_PROGRAM_ID,mint:{decimals:9,freezeAuthority:null},extensions:[]});chain.referencePrice=async()=>({usd:'100',at:Date.now()});chain.fundingEstimate=async()=>({minimumSol:'0.1'});chain.devBuyEstimate=async()=>({solBudget:'0',gross:'0',net:'0',maxQuote:'0'});
  for(const taxBps of [100,200,300]){const review=await chain.preview({network:'mainnet-beta',route:'raydium',quoteMint:SOL_MINT,feeMode:'holders',creatorFeeBps:0,creatorFeePolicy:HOLDER_CREATOR_FEE_POLICY,taxBps,targetUsd:'20000',protocolFees:{curveFeeBps:100}});assert.equal(review.creatorFeeRatePpm,0);assert.equal(review.creatorFeePolicy,HOLDER_CREATOR_FEE_POLICY);assert.equal(review.protocolFeeBps,25);assert.equal(review.platformFeeBps,100);assert.equal(review.cpConfigId,cpId.toBase58());assert.equal(review.postGradCreatorBps,5);assert.equal(review.postGradTradeBps,25);}
  await assert.rejects(chain.preview({network:'mainnet-beta',route:'raydium',quoteMint:SOL_MINT,feeMode:'buyback',creatorFeeBps:0,creatorFeePolicy:HOLDER_CREATOR_FEE_POLICY,taxBps:0,targetUsd:'20000'}),/only to taxed holder/);
});
