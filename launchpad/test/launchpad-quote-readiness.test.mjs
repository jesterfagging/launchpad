import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { Launchpad } from '../src/launchpad.mjs';
import { LAUNCH_ASSETS } from '../public/launch-assets.mjs';

const PENG='PENGTDQeQSXEjKcYw3CTQi9qznxcTHXAA7LMfUNrxLV';
const AMBA='AMBAHqGPjjtJaHPPSuvPu2mPCJdkGZpmhHQa5pkXbxrM';
const watched=[PENG,AMBA];
const other=LAUNCH_ASSETS.find(a=>a.symbol==='NOK');
const assets=[...watched.map(mint=>LAUNCH_ASSETS.find(a=>a.mint===mint)),other];
const recipient=Keypair.fromSeed(Buffer.alloc(32,71)).publicKey.toBase58();

function setup(t) {
  let now=1000000;
  const counts={mint:[],preview:[],closed:0,writes:0,active:0,maxActive:0};
  const options={approved:assets.map(a=>a.mint),error:'NO_ROUTES_FOUND from https://private.rpc/api?secret=private',byAccount:new Map(),hook:null,configError:false};
  const accounts={hostStore:{
    read:async(name,fallback)=>name==='launch-protocol-fees'?{recipient,creationFeeSol:'0.015'}:fallback,
    write:async()=>{counts.writes++;throw Error('Readiness must never write state.');},
  }};
  const service=new Launchpad(accounts,null,{now:()=>now,quoteCatalogue:{read:async()=>({assets,source:'verified'}),close(){}}});
  service.chain=async actorId=>({
    approvedQuotes:async()=>{if(options.configError)throw Error('RPC unavailable');return options.approved;},
    mintInfo:async mint=>{counts.mint.push({actorId,mint});return {key:new PublicKey(mint),program:TOKEN_2022_PROGRAM_ID,mint:{isInitialized:true,decimals:6,tlvData:Buffer.alloc(0)}};},
    preview:async input=>{
      counts.preview.push({actorId,mint:input.quoteMint});counts.active++;counts.maxActive=Math.max(counts.maxActive,counts.active);
      try{
        assert.equal(input.network,'mainnet-beta');assert.equal(input.devBuyLamports,'0');assert.equal(input.targetUsd,'20000');assert.equal(input.graduationTargetUsd,'50000');
        assert.equal(input.protocolFees.curveFeeBps,100);assert.equal(input.protocolFees.platformLpPercent,75);
        if(options.hook)await options.hook(actorId,input.quoteMint);
        const error=options.byAccount.has(actorId)?options.byAccount.get(actorId):options.error;
        if(error)throw Error(error);
        return {quoteProgram:TOKEN_2022_PROGRAM_ID.toBase58(),quoteDecimals:6,price:{usd:'12.50'}};
      }finally{counts.active--;}
    },
    close:()=>counts.closed++,
  });
  t.after(()=>service.close());
  return {service,counts,options,advance:ms=>now+=ms};
}

test('configured AMBA/PENG stay unavailable after failed full previews, with safe admin reasons and original metadata',async t=>{
  const h=setup(t),result=await h.service.quotes('alice');
  assert.deepEqual(result.assets.map(a=>a.mint),assets.map(a=>a.mint));
  assert.deepEqual(result.assets.filter(a=>a.supported===true).map(a=>a.mint),[other.mint],'existing HTTP public filter hides unknown pairs');
  for(const [index,row] of result.assets.slice(0,2).entries()){
    assert.equal(row.supported,null);assert.match(row.supportReason,/preview.*check again automatically/);
    assert.equal(row.category,assets[index].category);assert.equal(row.name,assets[index].name);assert.equal(row.issuer,assets[index].issuer);
  }
  assert(!JSON.stringify(result).includes('private.rpc'));assert(!JSON.stringify(result).includes('NO_ROUTES_FOUND'));
  assert.deepEqual(h.counts.preview.map(c=>c.mint),watched);assert.equal(h.counts.writes,0);
  assert(assets.every(a=>a.supported===undefined),'issuer catalogue entries remain immutable');
});

test('a healthy retry restores both pairs automatically; cached success expires and fails closed',async t=>{
  const h=setup(t);await h.service.quotes('alice');h.options.error='';
  h.advance(29999);assert.equal((await h.service.quotes('alice')).assets[0].supported,null);assert.equal(h.counts.preview.length,2);
  h.advance(1);const result=await h.service.quotes('alice');assert(result.assets.every(a=>a.supported===true));assert.equal(h.counts.preview.length,4);
  h.options.error='No usable market reference';h.advance(299999);assert.equal((await h.service.quotes('alice')).assets[0].supported,true);assert.equal(h.counts.preview.length,4);
  h.advance(1);assert.equal((await h.service.quotes('alice')).assets[0].supported,null);assert.equal(h.counts.preview.length,6);assert.equal(h.counts.writes,0);
});

test('a failed account RPC cannot poison another account preview cache',async t=>{
  const h=setup(t);h.options.byAccount.set('bob','');
  assert.equal((await h.service.quotes('alice')).assets[0].supported,null);
  assert.equal((await h.service.quotes('bob')).assets[0].supported,true);
  assert.equal((await h.service.quotes('alice')).assets[0].supported,null);
  assert.equal(h.counts.preview.filter(row=>row.actorId==='alice').length,2);assert.equal(h.counts.preview.filter(row=>row.actorId==='bob').length,2);
});

test('missing or failed canonical config checks never preview known problem mints or trust cached success',async t=>{
  const h=setup(t);h.options.approved=[other.mint];
  const unconfigured=await h.service.quotes('alice');assert(unconfigured.assets.slice(0,2).every(a=>a.supported===false));assert.equal(h.counts.mint.length,0);
  h.options.approved=assets.map(a=>a.mint);h.options.error='';h.advance(60000);
  assert.equal((await h.service.quotes('alice')).assets[0].supported,true);assert.equal(h.counts.preview.length,2);
  h.options.configError=true;h.advance(60000);
  assert((await h.service.quotes('alice')).assets.every(a=>a.supported===null));assert.equal(h.counts.preview.length,2);
  h.options.configError=false;h.options.approved=[other.mint];
  assert.equal((await h.service.quotes('alice')).assets[0].supported,false);assert.equal(h.counts.preview.length,2);
});

test('ordinary catalogue assets require no new live preview calls',async t=>{
  const h=setup(t),ordinary=LAUNCH_ASSETS.filter(a=>!watched.includes(a.mint));
  h.service.quoteCatalogue.read=async()=>({assets:ordinary});h.options.approved=ordinary.map(a=>a.mint);
  assert((await h.service.quotes('alice')).assets.every(a=>a.supported===true));assert.equal(h.counts.mint.length,0);assert.equal(h.counts.preview.length,0);
});

test('concurrent viewers coalesce per account and share the existing four-preview ceiling',async t=>{
  const h=setup(t);let release;const gate=new Promise(resolve=>{release=resolve;});h.options.error='';h.options.hook=()=>gate;
  const alice=h.service.quotes('alice'),sameAlice=h.service.quotes('alice'),bob=h.service.quotes('bob');
  while(h.counts.preview.length<4)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.counts.preview.length,4);assert.equal(h.service.customPairs.pending.size,4);
  const busy=await h.service.quotes('carol');assert(busy.assets.slice(0,2).every(a=>a.supported===null));assert.equal(h.counts.preview.length,4);
  release();await Promise.all([alice,sameAlice,bob]);h.options.hook=null;
  assert.equal((await h.service.quotes('carol')).assets[0].supported,true);assert.equal(h.counts.preview.length,6);assert.equal(h.counts.maxActive,4);
});
