import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { MintLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import { LaunchChain, ray } from '../src/launchpad-chain.mjs';
import { LAUNCH_ASSETS } from '../public/launch-assets.mjs';

const bn = value => new BN(String(value));
function account(layout, name, value) {
  const data = Buffer.alloc(layout.span);
  layout.encode({...layout.decode(data), ...value},data);
  createHash('sha256').update(`account:${name}`).digest().copy(data,0,0,8);
  return {data, owner:ray.LAUNCHPAD_PROGRAM, lamports:1000000, executable:false};
}
function mintAccount(decimals, supply, owner = TOKEN_PROGRAM_ID) {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode({mintAuthorityOption:0,mintAuthority:PublicKey.default,supply:BigInt(supply),decimals,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},data);
  return {data,owner,lamports:1000000,executable:false};
}
function harness() {
  const m=Keypair.generate().publicKey, w=Keypair.generate().publicKey, q=new PublicKey(LAUNCH_ASSETS.find(x=>x.symbol==='WBTC').mint);
  const program=ray.LAUNCHPAD_PROGRAM, platform=ray.getPdaPlatformId(program,w).publicKey, pool=ray.getPdaLaunchpadPoolId(program,m,q);
  const configId=ray.getPdaLaunchpadConfigId(program,q,0,2).publicKey;
  const state={bump:ray.getPdaLaunchpadAuth(program).nonce,status:0,mintDecimalsA:6,mintDecimalsB:8,migrateType:1,supply:bn('1000000000000000'),totalSellA:bn('800000000000000'),virtualA:bn('1100000000000000'),virtualB:bn('22000000'),realA:bn('100000000000000'),realB:bn('10000000'),totalFundRaisingB:bn('100000000'),protocolFee:bn('9999999'),platformFee:bn('9999999'),configId,platformId:platform,mintA:m,mintB:q,vaultA:ray.getPdaLaunchpadVaultId(program,pool.publicKey,m).publicKey,vaultB:ray.getPdaLaunchpadVaultId(program,pool.publicKey,q).publicKey,creator:w};
  const config={mintB:q,index:2,curveType:0};
  const launch={keys:{wallet:{address:w.toBase58()},mint:{address:m.toBase58()}},curve:pool.publicKey.toBase58(),input:{network:'mainnet-beta',route:'raydium',quoteMint:q.toBase58()},review:{supply:state.supply.toString(),sell:state.totalSellA.toString(),virtualBase:state.virtualA.toString(),virtualQuote:state.virtualB.toString(),raise:state.totalFundRaisingB.toString(),configId:configId.toBase58(),quoteProgram:TOKEN_PROGRAM_ID.toBase58(),quoteDecimals:8,price:{usd:'80000',at:Date.now()-3600000,source:'Launch review'}}};
  const calls=[];
  const connection={getMultipleAccountsInfoAndContext:async(keys,options)=>{calls.push({keys:keys.map(k=>k.toBase58()),options});return {context:{slot:12345},value:accounts};}};
  let accounts;
  const reset=()=>{accounts=[account(ray.LaunchpadPool,'PoolState',state),mintAccount(6,'1000000000000000'),mintAccount(8,'3000000000000'),account(ray.LaunchpadConfig,'GlobalConfig',config)];};reset();
  const chain=new LaunchChain({network:'mainnet-beta',connection});
  let lookups=0;
  chain.referencePrice=async(input,mint)=>{lookups++;assert.equal(input.quoteMint,q.toBase58());assert.equal(mint.mint.decimals,8);return {usd:'100000',at:Date.now(),source:'Live market reference'};};
  return {chain,launch,state,config,reset,calls,pool,q,m,configId,get accounts(){return accounts;},get lookups(){return lookups;}};
}

test('WBTC launch market reads one same-slot batch and uses SDK reserve pricing with 8 quote decimals',async()=>{
  const h=harness(),result=await h.chain.marketSnapshot(h.launch);
  assert.equal(h.calls.length,1);assert.deepEqual(h.calls[0],{keys:[h.pool.publicKey.toBase58(),h.m.toBase58(),h.q.toBase58(),h.configId.toBase58()],options:{commitment:'confirmed'}});
  assert.equal(result.source,'Raydium onchain');assert.equal(result.status,'curve');assert.equal(result.slot,12345);
  assert.equal(result.priceQuote,3.2e-10);assert.equal(result.supply,1e9);assert.equal(result.fdvQuote,.32);assert.equal(result.priceUsd,.000032);assert.equal(result.fdvUsd,32000);
  assert.equal(result.raisedQuote,.1);assert.equal(result.targetQuote,1);assert.equal(result.progressPercent,10);assert.equal(result.quote.symbol,'WBTC');assert.equal(result.quote.stale,false);assert.equal(h.lookups,1);
  assert(!JSON.stringify(result).includes('keys'));assert.equal(result.warning,'');
});

test('changed onchain reserves update the price and actual burned mint supply changes valuation',async()=>{
  const h=harness(),first=await h.chain.marketSnapshot(h.launch);
  h.state.realA=bn('200000000000000');h.state.realB=bn('20000000');h.reset();
  h.accounts[1]=mintAccount(6,'900000000000000');
  const next=await h.chain.marketSnapshot(h.launch,{quoteReference:first.quote});
  const sdk=ray.Launchpad.getPrice({poolInfo:h.state,curveType:0,decimalA:6,decimalB:8}).toNumber();
  assert.equal(next.priceQuote,sdk);assert(next.priceQuote>first.priceQuote);assert.equal(next.supply,9e8);assert.equal(next.fdvQuote,sdk*9e8);assert.equal(h.lookups,1);
});

test('read-only immediate native quote works without a provider; stale review never becomes current USD',async()=>{
  const h=harness();h.chain.referencePrice=async()=>{throw Error('provider unavailable');};
  const result=await h.chain.marketSnapshot(h.launch);
  assert.equal(result.priceQuote,3.2e-10);assert.equal(result.quote.usd,80000);assert.equal(result.quote.stale,true);assert.equal(result.priceUsd,null);assert.equal(result.fdvUsd,null);assert.match(result.warning,/current USD reference is unavailable/);
  h.chain.referencePrice=()=>assert.fail('null reference must skip lookup');
  assert.equal((await h.chain.marketSnapshot(h.launch,{quoteReference:null})).quote.stale,true);
});

test('a reference for another mint, a future reference, or an expired reference cannot price this curve',async()=>{
  for(const ref of [{mint:PublicKey.default.toBase58(),at:Date.now()},{at:Date.now()+100000},{at:Date.now()-61000}]){
    const h=harness();h.chain.referencePrice=async()=>{throw Error('unavailable');};
    const result=await h.chain.marketSnapshot(h.launch,{quoteReference:{mint:h.q.toBase58(),usd:777777,source:'cached',...ref}});
    assert.equal(result.quote.stale,true);assert.equal(result.priceUsd,null);assert.equal(result.fdvUsd,null);
    if(ref.mint)assert.equal(result.quote.usd,80000);
  }
});

test('market snapshots reject boolean and nonnumeric USD references instead of coercing them to one dollar',async()=>{
  for(const usd of [true,false,{},[],null,'','Infinity']){
    const h=harness();h.chain.referencePrice=async()=>({usd,at:Date.now()});
    const result=await h.chain.marketSnapshot(h.launch);
    assert.equal(result.priceUsd,null);assert.equal(result.fdvUsd,null);assert.equal(result.quote.stale,true);
  }
});

test('graduating and migrated curves do not report their frozen price as a live market',async()=>{
  for(const [status,expected] of [[1,'migrating'],[2,'migrated']]){
    const h=harness();h.state.status=status;h.reset();
    const result=await h.chain.marketSnapshot(h.launch);
    assert.equal(result.status,expected);assert.equal(result.priceQuote,null);assert.equal(result.fdvQuote,null);assert.equal(result.priceUsd,null);assert.equal(result.fdvUsd,null);assert.match(result.warning,/AMM market/);
  }
});

test('wrong program owners and discriminators are rejected for both curve and configuration',async()=>{
  for(const index of [0,3])for(const mutation of ['owner','discriminator']){
    const h=harness();if(mutation==='owner')h.accounts[index].owner=SystemProgram.programId;else h.accounts[index].data[0]^=1;
    await assert.rejects(h.chain.marketSnapshot(h.launch),/owner|discriminator/);assert.equal(h.lookups,0);
  }
});

test('pool, mint, config, platform, creator and vault identities must match the owned launch',async()=>{
  const mutations=[h=>{h.launch.curve=Keypair.generate().publicKey.toBase58();},...['mintA','mintB','configId','platformId','creator','vaultA','vaultB'].map(key=>h=>{h.state[key]=Keypair.generate().publicKey;h.reset();}),h=>{h.state.bump^=1;h.reset();},h=>{h.config.index++;h.reset();},h=>{h.config.mintB=PublicKey.default;h.reset();}];
  for(const mutate of mutations){const h=harness();mutate(h);await assert.rejects(h.chain.marketSnapshot(h.launch),/match|different/);assert.equal(h.lookups,0);}
});

test('mismatched decimals, invalid mint owner, impossible supply or unsupported state fail closed',async()=>{
  const mutations=[h=>{h.accounts[2]=mintAccount(9,1n);},h=>{h.accounts[1].owner=SystemProgram.programId;},h=>{h.accounts[1]=mintAccount(6,'1000000000000001');},h=>{h.accounts[2]=mintAccount(8,1n,TOKEN_2022_PROGRAM_ID);},h=>{h.state.status=9;h.reset();},h=>{h.state.realA=h.state.virtualA;h.reset();},h=>{h.state.virtualB=bn(0);h.launch.review.virtualQuote='0';h.reset();}];
  for(const mutate of mutations){const h=harness();mutate(h);await assert.rejects(h.chain.marketSnapshot(h.launch),/decimals|owner|supply|status|reserves/);assert.equal(h.lookups,0);}
});

test('a slow USD provider is bounded and cannot indefinitely block the immediate onchain chart',async()=>{
  const h=harness();h.chain.referencePrice=()=>new Promise(()=>{});
  const start=Date.now(),result=await h.chain.marketSnapshot(h.launch);
  assert(Date.now()-start<2500);assert.equal(result.priceQuote,3.2e-10);assert.equal(result.priceUsd,null);assert.equal(result.quote.stale,true);
});

