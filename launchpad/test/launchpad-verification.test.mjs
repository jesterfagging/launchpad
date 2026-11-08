import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import { MintLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TransferFeeConfigLayout, ExtensionType, getMintLen } from '@solana/spl-token';
import BN from 'bn.js';
import { LaunchChain, ray } from '../src/launchpad-chain.mjs';

const key=()=>Keypair.generate().publicKey;
const bn=value=>new BN(String(value));
function rayAccount(layout,name,fields){const data=Buffer.alloc(layout.span);layout.encode({...layout.decode(data),...fields},data);createHash('sha256').update(`account:${name}`).digest().copy(data,0,0,8);return{owner:ray.LAUNCHPAD_PROGRAM,data,lamports:1000000,executable:false};}
function mintAccount(program,decimals,fee){
  const data=Buffer.alloc(fee?getMintLen([ExtensionType.TransferFeeConfig]):MintLayout.span);
  MintLayout.encode({mintAuthorityOption:0,mintAuthority:PublicKey.default,supply:1000000000000000n,decimals,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},data);
  if(fee){data[165]=1;data.writeUInt16LE(ExtensionType.TransferFeeConfig,166);data.writeUInt16LE(TransferFeeConfigLayout.span,168);TransferFeeConfigLayout.encode(fee,data,170);}
  return{owner:program,data,lamports:1000000,executable:false};
}
function harness({taxBps=0,quote2022=false}={}){
  const w=key(),m=key(),q=key(),admin=key(),configId=key(),cpConfigId=key();let accounts,slot=501;const calls=[];
  const l={keys:{wallet:{address:w.toBase58()},mint:{address:m.toBase58()},platform:{address:admin.toBase58()}},input:{route:'raydium',network:'mainnet-beta',quoteMint:q.toBase58(),taxBps,creatorFeeBps:25,feeMode:taxBps?'holders':'creator'},review:{supply:'1000000000000000',sell:'800000000000000',raise:'64000000000',virtualBase:'1100000000000000',virtualQuote:'2200000000',configId:configId.toBase58(),cpConfigId:cpConfigId.toBase58(),quoteProgram:(quote2022?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID).toBase58(),quoteDecimals:8},operations:[{kind:'setup',state:'confirmed',slot:300},{kind:'create',state:'confirmed',slot:500}]};
  const c=new LaunchChain({network:'mainnet-beta',connection:{getMultipleAccountsInfoAndContext:async(keys,options)=>{calls.push({keys:keys.map(String),options});return{context:{slot},value:accounts};},getAccountInfo:()=>assert.fail('verification must use a single account snapshot')}});
  const a=c.addresses(l);
  const state={mintDecimalsA:6,mintDecimalsB:8,migrateType:1,supply:bn(l.review.supply),totalSellA:bn(l.review.sell),totalFundRaisingB:bn(l.review.raise),virtualA:bn(l.review.virtualBase),virtualB:bn(l.review.virtualQuote),creator:w,mintA:m,mintB:q,configId,platformId:a.platform,mintProgramFlag:(taxBps?1:0)|(quote2022?2:0),cpmmCreatorFeeOn:ray.CpmmCreatorFeeOn.OnlyTokenB};
  const platform={burnScale:bn(1000000),creatorScale:bn(0),platformScale:bn(0),feeRate:bn(0),creatorFeeRate:bn(2500),cpConfigId,transferFeeExtensionAuth:w};
  const feeSchedule={epoch:0n,maximumFee:18446744073709551615n,transferFeeBasisPoints:taxBps};
  const fee={transferFeeConfigAuthority:a.auth,withdrawWithheldAuthority:w,olderTransferFee:feeSchedule,newerTransferFee:feeSchedule,withheldAmount:0n};
  const reset=()=>{accounts=[mintAccount(taxBps?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID,6,taxBps?fee:null),rayAccount(ray.LaunchpadPool,'PoolState',state),rayAccount(ray.PlatformConfig,'PlatformConfig',platform),mintAccount(quote2022?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID,8)];};reset();
  return{l,c,a,state,platform,fee,reset,calls,get accounts(){return accounts;},set slot(value){slot=value;}};
}
test('verification reads mint, curve, platform and custom quote in one finalized snapshot after the create receipt',async()=>{
  const h=harness(),out=await h.c.verifyLaunch(h.l);assert.deepEqual(out,{mint:h.a.m.toBase58(),curve:h.a.pool.toBase58(),slot:501});assert.deepEqual(h.calls,[{keys:[h.a.m,h.a.pool,h.a.platform,h.a.q].map(String),options:{commitment:'finalized',minContextSlot:500}}]);
});
test('missing or stale post-create accounts are retried instead of misclassifying an onchain launch as failed',async()=>{
  for(const missing of [0,1,2,3]){const h=harness();h.accounts[missing]=null;await assert.rejects(h.c.verifyLaunch(h.l),e=>e.retryable===true&&e.code==='LAUNCH_VERIFICATION_PENDING');h.reset();assert((await h.c.verifyLaunch(h.l)).curve);}
  const h=harness();h.slot=499;await assert.rejects(h.c.verifyLaunch(h.l),e=>e.retryable===true);h.slot=undefined;await assert.rejects(h.c.verifyLaunch(h.l),e=>e.retryable===true);
});
test('holder-reward Token-2022 base and custom Token-2022 quote verify all four program flag combinations',async()=>{
  for(const taxBps of [0,300])for(const quote2022 of [false,true]){const h=harness({taxBps,quote2022});assert((await h.c.verifyLaunch(h.l)).curve);}
});
test('mixed LaunchLab config authority and managed withdraw authority remain valid before tax-token graduation',async()=>{
  const h=harness({taxBps:300,quote2022:true});assert((await h.c.verifyLaunch(h.l)).curve);
  h.fee.transferFeeConfigAuthority=h.a.w;h.reset();assert((await h.c.verifyLaunch(h.l)).curve);
  h.fee.withdrawWithheldAuthority=key();h.reset();await assert.rejects(h.c.verifyLaunch(h.l),/tax authority differs/);
});
test('verification still rejects altered curve economic terms with actionable field errors',async()=>{
  for(const [field,expected] of [['supply',/supply/],['totalSellA',/sale allocation/],['totalFundRaisingB',/fundraising/],['virtualA',/virtual reserves/],['virtualB',/virtual reserves/]]){const h=harness();h.state[field]=h.state[field].addn(1);h.reset();await assert.rejects(h.c.verifyLaunch(h.l),e=>!e.retryable&&e.code==='LAUNCH_VERIFICATION_MISMATCH'&&expected.test(e.message));}
});
test('wrong token owners, mint identities, creator and liquidity policies are never approved by retry handling',async()=>{
  for(const mutate of [h=>{h.accounts[0].owner=TOKEN_2022_PROGRAM_ID;},h=>{h.accounts[3].owner=TOKEN_2022_PROGRAM_ID;},h=>{h.state.creator=key();h.reset();},h=>{h.state.mintB=key();h.reset();},h=>{h.state.platformId=key();h.reset();},h=>{h.platform.burnScale=bn(0);h.reset();},h=>{h.platform.creatorFeeRate=bn(2600);h.reset();},h=>{h.platform.transferFeeExtensionAuth=key();h.reset();},h=>{h.state.migrateType=0;h.reset();},h=>{h.state.mintProgramFlag=3;h.reset();}]){const h=harness();mutate(h);await assert.rejects(h.c.verifyLaunch(h.l),e=>e.retryable!==true);}
  const h=harness();h.accounts[1].owner=SystemProgram.programId;await assert.rejects(h.c.verifyLaunch(h.l),/wrong program owner/);
});
test('verified creation remains valid when trading has already changed real reserves or a holder burned supply',async()=>{
  const h=harness();h.state.realA=bn(9000000);h.state.realB=bn(1000000);h.reset();h.accounts[0].data.writeBigUInt64LE(999000000000000n,36);assert((await h.c.verifyLaunch(h.l)).curve);
});
