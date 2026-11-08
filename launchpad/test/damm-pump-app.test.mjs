import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,MintLayout,ExtensionType,getMintLen} from '@solana/spl-token';
import {inspectDammPumpQuote} from '../src/damm-pump-chain.mjs';
import {createDammPumpIntegration} from '../src/damm-pump-app.mjs';
import {METEORA_EXTRA_ASSETS} from '../public/meteora-extra-assets.mjs';
const SOL='So11111111111111111111111111111111111111112',USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

test('offered-pair warmup batches at most100, coalesces visitors and caches incompatible mints for an hour',async t=>{
  let now=1790000000000,batches=0,singles=0,active=0,peak=0;const stores=new Map(),batchMints=[];
  const accounts={hostStore:{read:async(k,f)=>structuredClone(stores.get(k)??f),write:async(k,v)=>stores.set(k,structuredClone(v))}};
  const otherAssets=Array.from({length:205},(_,i)=>({mint:Keypair.generate().publicKey.toBase58(),name:'Offered asset '+i,symbol:'Q'+i}));
  const launches={quoteCatalogue:{read:async()=>({assets:[...otherAssets,{mint:SOL,name:'Solana',symbol:'SOL'},{mint:USDC,name:'USD Coin',symbol:'USDC',retired:true}]})}};
  const result=asset=>({mint:asset.mint,launchReady:asset.mint===SOL,compatibilityVerified:true,tokenProgram:TOKEN_PROGRAM_ID.toBase58(),decimals:9});
  const adapter={quoteReadinessBatch:async assets=>{batches++;active++;peak=Math.max(peak,active);assert(assets.length<=100);batchMints.push(assets.map(a=>a.mint));await Promise.resolve();active--;return assets.map(result);},quoteReadiness:async asset=>{singles++;return result(asset);}};
  const integration=createDammPumpIntegration({accounts,launches,discovery:{chain(){throw Error('Warmup must not fetch asset prices');}},adapter,now:()=>now});t.after(()=>integration.stop());
  await Promise.all([integration.warm(),integration.warm(),integration.warm()]);
  assert(batches>1);assert.equal(peak,1);assert.equal(singles,0);assert.equal(batchMints[0][0],SOL);assert(!batchMints.flat().includes(USDC));assert(!batchMints.flat().includes(METEORA_EXTRA_ASSETS.find(a=>a.mint!==SOL&&a.mint!==USDC).mint),'Candidate-only assets are not offered pairs');assert(stores.get('damm-pump-pairs').pairs.length>100);
  const first=batches;const pairs=await integration.service.listPairs();assert.equal(pairs.length,206);assert.deepEqual(pairs.filter(a=>a.launchReady).map(a=>a.mint),[SOL]);assert(pairs.filter(a=>a.mint!==SOL).every(a=>a.availability==='coming-soon'&&a.comingSoon));await integration.warm();assert.equal(batches,first);
  const undeployed=await integration.service.publicStatus();
  assert.equal(undeployed.available,false);assert.equal(undeployed.configured,false);
  assert.equal(undeployed.blockers[0],'PumpSwap launch setup is not complete yet.');
  assert.deepEqual(undeployed.pairs.filter(a=>a.launchReady).map(a=>[a.mint,a.launchReady]),[[SOL,true]],'Pair compatibility stays available before controller setup');
  now+=61000;await integration.warm();assert.equal(batches,first,'Negative checks do not repeat each minute');
  now+=900000;await integration.warm();assert.equal(batches,first+1);assert.deepEqual(batchMints.at(-1),[SOL],'Only compatible cache entries refresh at15min');
  assert.equal((await integration.service.quoteEligibility(SOL)).launchReady,true);assert.equal(singles,1,'Selected pair is checked afresh');
  assert.equal((await integration.service.quoteEligibility(Keypair.generate().publicKey.toBase58())).launchReady,false);assert.equal(singles,1,'An arbitrary unoffered mint never reaches RPC');
  now+=3600000;await integration.warm();assert(batches>first+2,'Negative cache refreshes after an hour');
});

test('a malformed batch cannot publish unverified quote assets',async t=>{
  const accounts={hostStore:{read:async(_k,f)=>f,write:async()=>{}}},launches={quoteCatalogue:{read:async()=>({assets:[{mint:SOL,name:'Solana',symbol:'SOL'}]})}};
  const adapter={quoteReadinessBatch:async()=>[{mint:USDC,launchReady:true}]};
  const integration=createDammPumpIntegration({accounts,launches,discovery:{},adapter});t.after(()=>integration.stop());
  await integration.warm();const pairs=await integration.service.listPairs();assert.equal(pairs.length,1);assert.equal(pairs[0].mint,SOL);assert.equal(pairs[0].launchReady,false);assert.equal(pairs[0].availability,'unavailable');assert.equal(pairs[0].comingSoon,false);
});


test('mint diagnostics distinguish verified unsupported extensions from missing and truncated accounts',()=>{
  const mint=Keypair.generate().publicKey, data=Buffer.alloc(getMintLen([ExtensionType.TransferFeeConfig]));
  MintLayout.encode({mintAuthorityOption:0,mintAuthority:mint,supply:1000000n,decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:mint},data);
  data[165]=1;data.writeUInt16LE(ExtensionType.TransferFeeConfig,166);data.writeUInt16LE(data.length-170,168);
  const account={owner:TOKEN_2022_PROGRAM_ID,data,executable:false,lamports:3000000};
  const rejected=inspectDammPumpQuote(String(mint),account);
  assert.equal(rejected.launchReady,false);assert.equal(rejected.compatibilityVerified,true);assert.equal(rejected.comingSoon,true);assert.equal(rejected.availability,'coming-soon');assert.deepEqual(rejected.extensions,[ExtensionType.TransferFeeConfig]);
  for(const unavailable of [null,{...account,data:data.subarray(0,data.length-1)}]){const result=inspectDammPumpQuote(String(mint),unavailable);assert.equal(result.launchReady,false);assert.equal(result.compatibilityVerified,false);assert.equal(result.comingSoon,false);assert.equal(result.availability,'unavailable');}
});

test('unavailable pair checks retry promptly without claiming incompatibility, then recover',async t=>{
  let now=1790000000000,calls=0,fail=true;const stores=new Map();
  const accounts={hostStore:{read:async(k,f)=>structuredClone(stores.get(k)??f),write:async(k,v)=>stores.set(k,structuredClone(v))}}, launches={quoteCatalogue:{read:async()=>({assets:[{mint:SOL,name:'Solana',symbol:'SOL',category:'crypto'}]})}};
  const adapter={quoteReadinessBatch:async assets=>{calls++;if(fail)throw Error('provider temporarily unavailable');return assets.map(a=>({mint:a.mint,launchReady:true,compatibilityVerified:true}));}};
  const integration=createDammPumpIntegration({accounts,launches,discovery:{},adapter,now:()=>now});t.after(()=>integration.stop());
  await integration.warm();let pairs=await integration.service.listPairs();assert.equal(pairs[0].launchReady,false);assert.equal(pairs[0].comingSoon,false);assert.equal(pairs[0].availability,'unavailable');assert.match(pairs[0].supportReason,/retry automatically/);
  await integration.warm();assert.equal(calls,1);now+=30001;fail=false;await integration.warm();assert.equal(calls,2);pairs=await integration.service.listPairs();assert.equal(pairs[0].launchReady,true);assert.equal(pairs[0].availability,'ready');assert.equal(pairs[0].comingSoon,false);
});
