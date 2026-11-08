import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { PublicKey, TransactionMessage, AddressLookupTableProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, MintLayout, MINT_SIZE, ACCOUNT_SIZE, AccountType, ExtensionType, TransferHookLayout, getMintLen } from '@solana/spl-token';
import BN from 'bn.js';
import { LaunchRouter, mintInfo } from '../src/launches.mjs';
import { makeTransaction } from '../src/providers.mjs';
import { validateConfig,PUMP,LAUNCHLAB,SOL,DirectRouteUnavailableError } from '../src/core.mjs';
import { config,mint,quote,lead,key1,blockhash,build } from './fixtures.mjs';
const pk=x=>new PublicKey(x),bn=x=>new BN(String(x));



test('pool reads stay shared during slot catch-up and failed reads can be retried immediately',async()=>{
  const router=new LaunchRouter({}),v={type:'pump',pool:lead};let calls=0,release;
  const held=new Promise(r=>release=r);router.loadState=async()=>{calls++;await held;return {ok:true};};
  const first=router.state(v,123);await delay(210);const second=router.state(v,123);release();
  assert.deepEqual(await Promise.all([first,second]),[{ok:true},{ok:true}]);assert.equal(calls,1);
  router.loadState=async()=>{calls++;throw Error('behind');};await assert.rejects(router.state(v,124),/behind/);
  router.loadState=async()=>{calls++;return {ok:true};};assert.deepEqual(await router.state(v,124),{ok:true});assert.equal(calls,3);
});

function mintAccount(hookProgram = null, owner = TOKEN_2022_PROGRAM_ID, authority = PublicKey.default) {
  const data = Buffer.alloc(hookProgram === null ? MINT_SIZE : getMintLen([ExtensionType.TransferHook]));
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1000000000000000n,
    decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
  if (hookProgram !== null) {
    data[ACCOUNT_SIZE] = AccountType.Mint;
    data.writeUInt16LE(ExtensionType.TransferHook, ACCOUNT_SIZE + 1);
    data.writeUInt16LE(TransferHookLayout.span, ACCOUNT_SIZE + 3);
    TransferHookLayout.encode({ authority, programId: hookProgram }, data.subarray(ACCOUNT_SIZE + 5));
  }
  return { data, owner, executable: false, lamports: 10000000, rentEpoch: 0 };
}

test('mint decoding accepts absent and disabled transfer hooks, including retained update authority', () => {
  for (const owner of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) assert.equal(mintInfo(pk(mint), mintAccount(null, owner)).info.decimals, 6);
  for (const authority of [PublicKey.default, pk(lead)]) {
    const info = mintInfo(pk(mint), mintAccount(PublicKey.default, TOKEN_2022_PROGRAM_ID, authority));
    assert(info.program.equals(TOKEN_2022_PROGRAM_ID)); assert.equal(info.info.supply, 1000000000000000n);
  }
});

test('active hooks require another route while invalid mint data remains an integrity error', () => {
  assert.throws(() => mintInfo(pk(mint), mintAccount(pk(lead))), e => e instanceof DirectRouteUnavailableError && e.message.includes(mint));
  assert.throws(() => mintInfo(pk(mint), mintAccount(null, pk(lead))), e => !(e instanceof DirectRouteUnavailableError));
  assert.throws(() => mintInfo(pk(mint), { ...mintAccount(), data: Buffer.alloc(12) }), e => !(e instanceof DirectRouteUnavailableError));
});

test('Pump buy and sell build directly with a decoded disabled-hook quote mint', async () => {
  const c=validateConfig(config()),p={c,blockhash:{blockhash,lastValidBlockHeight:1000,at:Date.now()}},router=new LaunchRouter(p);
  router.state=async()=>({base:pk(mint),quote:pk(quote),baseInfo:mintInfo(pk(mint),mintAccount()),quoteInfo:mintInfo(pk(quote),mintAccount(PublicKey.default,TOKEN_2022_PROGRAM_ID,pk(lead))),
    curveAccount:{data:Buffer.alloc(0)},global:{feeRecipient:pk(lead),feeRecipients:[pk(lead)],feeBasisPoints:bn(100),creatorFeeBasisPoints:bn(50),creatorFeeConfigurable:false},feeConfig:null,
    curve:{quoteMint:pk(quote),creator:pk(lead),isMayhemMode:false,virtualTokenReserves:bn(1000000000000000),virtualQuoteReserves:bn(1000000000000),realTokenReserves:bn(500000000000000),creatorFeeBps:bn(0)}});
  const venue={type:'pump',baseMint:mint,quoteMint:quote,pool:lead};
  for (const isBuy of [true,false]) {
    const b=await router.build({inputMint:isBuy?quote:mint,outputMint:isBuy?mint:quote,amount:1000000n,venue},c.wallets[0]);
    assert.equal(b.routeName,'Pump curve');assert(b.nativeInstructions.some(ix=>ix.programId.equals(pk(PUMP))));
    assert(makeTransaction(b,c.wallets[0],c,[]).tx.serialize().length<=1232);
  }
});

test('Pump V2 direct route uses arbitrary quote mint, distinct token programs, and a fixed input cap',async()=>{
  const c=validateConfig(config()),p={c,blockhash:{blockhash,lastValidBlockHeight:1000,at:Date.now()}},router=new LaunchRouter(p);
  router.state=async()=>({base:pk(mint),quote:pk(quote),baseInfo:{program:TOKEN_2022_PROGRAM_ID,info:{supply:1000000000000000n}},quoteInfo:{program:TOKEN_PROGRAM_ID},
    curveAccount:{data:Buffer.alloc(0)},global:{feeRecipient:pk(lead),feeRecipients:[pk(lead)],feeBasisPoints:bn(100),creatorFeeBasisPoints:bn(50),creatorFeeConfigurable:false},feeConfig:null,
    curve:{quoteMint:pk(quote),creator:pk(lead),isMayhemMode:false,virtualTokenReserves:bn(1000000000000000),virtualQuoteReserves:bn(1000000000000),realTokenReserves:bn(500000000000000),creatorFeeBps:bn(0)}});
  const wallet=c.wallets[0],amount=100000000n,venue={type:'pump',baseMint:mint,quoteMint:quote,pool:lead};
  const result=await router.build({inputMint:quote,outputMint:mint,amount,venue},wallet);
  const ix=result.nativeInstructions.find(x=>x.programId.equals(pk(PUMP)));
  assert.equal(ix.keys[1].pubkey.toBase58(),mint);assert.equal(ix.keys[2].pubkey.toBase58(),quote);
  assert(ix.keys[3].pubkey.equals(TOKEN_2022_PROGRAM_ID));assert(ix.keys[4].pubkey.equals(TOKEN_PROGRAM_ID));
  assert.equal(ix.data.readBigUInt64LE(16),amount);assert(ix.data.readBigUInt64LE(8)>0n);
  const built=makeTransaction(result,wallet,c,[]);assert(built.tx.serialize().length<=1232);
  const sell=await router.build({inputMint:mint,outputMint:quote,amount:1000000n,venue},wallet);
  assert(sell.nativeInstructions.some(x=>x.programId.equals(pk(PUMP))));
});
test('LaunchLab curve builds quote-token buy and sell instructions with the correct direction and no referral fee',async()=>{
  const c=validateConfig(config()),p={c,blockhash:{blockhash,lastValidBlockHeight:1000,at:Date.now()}},router=new LaunchRouter(p);
  router.state=async()=>({base:pk(mint),quote:pk(quote),baseInfo:{program:TOKEN_2022_PROGRAM_ID,info:{}},quoteInfo:{program:TOKEN_PROGRAM_ID,info:{}},
    config:{tradeFeeRate:bn(2500),curveType:0},platform:{feeRate:bn(10000),creatorFeeRate:bn(0)},stateSlot:100000,
    pool:{configId:pk(lead),platformId:pk(lead),creator:pk(lead),vaultA:pk(mint),vaultB:pk(quote),virtualA:bn(1000000000000000),virtualB:bn(1000000000000),realA:bn(0),realB:bn(0),totalSellA:bn(800000000000000)}});
  const venue={type:'launchlab',baseMint:mint,quoteMint:quote,pool:lead},wallet=c.wallets[0];
  for(const isBuy of [true,false]) {
    const result=await router.build({inputMint:isBuy?quote:mint,outputMint:isBuy?mint:quote,amount:100000000n,venue},wallet);
    const ix=result.nativeInstructions.find(x=>x.programId.equals(pk(LAUNCHLAB)));
    assert.equal(ix.keys[9].pubkey.toBase58(),mint);assert.equal(ix.keys[10].pubkey.toBase58(),quote);
    assert.equal(ix.data.readBigUInt64LE(8),100000000n);assert.equal(ix.data.readBigUInt64LE(24),0n);assert(ix.data.readBigUInt64LE(16)>0n);
    const built=makeTransaction(result,wallet,c,[]);assert(built.tx.serialize().length<=1232);
  }
});

test('compact funding quotes rebuild the Pump buy against their new guaranteed minimum output',async()=>{
  const c=validateConfig(config()),requests=[],p={c,jupiterBuild:async(order,wallet,signal,maxAccounts)=>{
    requests.push({inputMint:order.inputMint,outputMint:order.outputMint,amount:order.amount,maxAccounts});
    return {...build(order,wallet),outAmount:maxAccounts===16?'1200000':'2100000',otherAmountThreshold:maxAccounts===16?'1000000':'2000000'};
  }},router=new LaunchRouter(p);
  router.state=async()=>({base:pk(mint),quote:pk(quote),baseInfo:{program:TOKEN_2022_PROGRAM_ID,info:{supply:1000000000000000n}},quoteInfo:{program:TOKEN_PROGRAM_ID},
    curveAccount:{data:Buffer.alloc(0)},global:{feeRecipient:pk(lead),feeRecipients:[pk(lead)],feeBasisPoints:bn(100),creatorFeeBasisPoints:bn(50),creatorFeeConfigurable:false},feeConfig:null,
    curve:{quoteMint:pk(quote),creator:pk(lead),isMayhemMode:false,virtualTokenReserves:bn(1000000000000000),virtualQuoteReserves:bn(1000000000000),realTokenReserves:bn(500000000000000),creatorFeeBps:bn(0)}});
  const order={inputMint:SOL,outputMint:mint,amount:50000000n,venue:{type:'pump',baseMint:mint,quoteMint:quote,pool:lead}},wallet=c.wallets[0];
  const regular=await router.build(order,wallet),compact=await router.build(order,wallet,undefined,16);
  const ix=b=>b.nativeInstructions.find(i=>i.programId.equals(pk(PUMP)));
  assert.deepEqual(requests,[{inputMint:SOL,outputMint:quote,amount:50000000n,maxAccounts:undefined},{inputMint:SOL,outputMint:quote,amount:50000000n,maxAccounts:16}]);
  assert.equal(ix(regular).data.readBigUInt64LE(16),2000000n);assert.equal(ix(compact).data.readBigUInt64LE(16),1000000n);
  assert(ix(compact).data.readBigUInt64LE(8)<ix(regular).data.readBigUInt64LE(8));
  assert.equal(compact.inAmount,'50000000');assert.equal(compact.outputMint,mint);assert.equal(compact.routeName,'Jupiter → Pump curve');
  assert.equal(compact.fundingLeg.outputMint,quote);assert.equal(compact.fundingLeg.minimumOutput,'1000000');
});

test('lead lookup tables load in one shared batch across 20 followers and failed reads can retry',async()=>{
  const router=new LaunchRouter({}),keys=[lead,mint,quote],data=Buffer.alloc(56+64);
  data.writeUInt32LE(1);data.writeBigUInt64LE(18446744073709551615n,4);pk(mint).toBuffer().copy(data,56);pk(quote).toBuffer().copy(data,88);
  let calls=0,release;router.accounts=async requested=>{
    calls++;assert.deepEqual(requested,keys);await new Promise(r=>{release=r;});
    return {values:requested.map(()=>({owner:AddressLookupTableProgram.programId,data}))};
  };
  const builds=Array.from({length:20},()=>router.lookups(keys));assert.equal(calls,1);release();
  const results=await Promise.all(builds);assert(results.every(r=>JSON.stringify(r)===JSON.stringify(results[0])));
  assert.deepEqual(results[0][lead],[mint,quote]);await router.lookups(keys);assert.equal(calls,1);
  router.lookupCache.clear();router.accounts=async()=>{calls++;throw new Error('RPC unavailable');};
  await assert.rejects(router.lookups(keys),/RPC unavailable/);assert.equal(router.lookupCache.size,0);
  router.accounts=async requested=>{calls++;return {values:requested.map(()=>({owner:AddressLookupTableProgram.programId,data}))};};
  assert.deepEqual((await router.lookups(keys))[lead],[mint,quote]);assert.equal(calls,3);
});

test('funding quotes start before a held pool read completes, and graduated pools still fall back',async()=>{
  const c=validateConfig(config()),calls=[];let release;
  const held=new Promise(r=>release=r),p={c,jupiterBuild:async()=>{calls.push('funding');throw Object.assign(Error('no funding route'),{routeUnavailable:true});}},router=new LaunchRouter(p);
  router.state=async()=>{calls.push('state');await held;return {graduated:true};};
  const job=router.build({inputMint:SOL,outputMint:mint,amount:50000000n,venue:{type:'pump',baseMint:mint,quoteMint:quote,pool:lead}},c.wallets[0]);
  assert(calls.includes('funding'));assert(calls.includes('state'));release();assert.equal(await job,null);
});
