import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey} from '@solana/web3.js';
import {LaunchpadExplore} from '../src/launchpad-explore.mjs';
import {ray} from '../src/launchpad-chain.mjs';
import {SOL_MINT} from '../public/launchpad-model.mjs';
import {LAUNCH_ASSETS} from '../public/launch-assets.mjs';

const NOW=1790600000000,key=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const stock=LAUNCH_ASSETS.find(asset=>asset.category==='stocks');
function rayLaunch(n,quoteMint=SOL_MINT){const mint=key(n);return{id:'ray-'+n,createdAt:NOW-n*1000,authorizedAt:NOW-n*1000,state:'live',curve:ray.getPdaLaunchpadPoolId(ray.LAUNCHPAD_PROGRAM,new PublicKey(mint),new PublicKey(quoteMint)).publicKey.toBase58(),input:{route:'raydium',network:'mainnet-beta',name:'Ray coin '+n,symbol:'R'+n,quoteMint,feeMode:'creator',creatorFeeBps:50},keys:{mint:{address:mint},wallet:{address:key(200)}},review:{quoteSymbol:quoteMint===SOL_MINT?'SOL':stock.symbol},operations:[]};}
function pumpLaunch(n){return{id:'pump-'+n,mint:key(n),creatorId:'creator',creatorWallet:key(200),platform:'pumpswap',status:n===4?'migrated':'trading',poolId:n===4?key(240):null,stateAddress:key(100+n),custodyAuthority:key(150+n),publicProgramId:key(180),quoteMint:SOL_MINT,createdAt:NOW-n*1000,name:'Pump coin '+n,symbol:'P'+n};}
function fixture(t,{rays=[rayLaunch(1,stock.mint),rayLaunch(3)],pumps=[pumpLaunch(2),pumpLaunch(4)]}={}){
  const calls={ray:[],pump:[],dex:[],registry:0},all=new Map([...rays.map(row=>[row.keys.mint.address,{mint:row.keys.mint.address,curve:row.curve,quote:row.input.quoteMint,graduated:false}]),...pumps.map(row=>[row.mint,{mint:row.mint,curve:row.stateAddress,quote:row.quoteMint,graduated:row.status==='migrated'}])]);
  const snapshot=mint=>{const row=all.get(mint);return{mint,curve:row.curve,status:row.graduated?'migrated':'curve',at:NOW,slot:100,supply:1e9,priceQuote:.000001,fdvQuote:1000,priceUsd:.0001,fdvUsd:100000,progressPercent:row.graduated?100:20,raisedQuote:20,targetQuote:100,quote:{mint:row.quote,symbol:'Q',usd:100,at:NOW,stale:false}};};
  const accounts={list:async()=>{calls.registry++;return[{id:'creator',username:'public_creator'}];},storeFor:()=>({read:async()=>({launches:rays})})};
  const service=new LaunchpadExplore({accounts,now:()=>NOW,listWaitMs:500,pumpPublic:{publicList:async()=>pumps,marketSnapshot:async mint=>{calls.pump.push(mint);return snapshot(mint);},trades:async()=>[]},chainFactory:async()=>({marketSnapshot:async row=>{calls.ray.push(row.keys.mint.address);return snapshot(row.keys.mint.address);},close(){}}),marketData:{pools:async(_chain,mint)=>{calls.dex.push(mint);return{tokenAddress:mint,at:NOW,pools:[]};}},activity:{read:async()=>null,close(){}},history:{read:async()=>null,close(){}}});
  t.after(()=>service.close());return{service,calls};
}

test('launch mode filters mixed inventory before warming, counts, sorting and paging',async t=>{
  const h=fixture(t);
  const first=await h.service.list({launchMode:'pumpswap',limit:1});
  assert.deepEqual(first.coins.map(c=>c.symbol),['P2']);assert.equal(first.total,2);assert.equal(first.nextOffset,1);assert.deepEqual(first.counts,{all:2,new:1,graduated:1,moving:0});assert.equal(first.coverage.total,2);
  assert.equal(h.calls.ray.length,0,'Pump filter must not warm unrelated Raydium launches');assert(h.calls.dex.every(mint=>[key(2),key(4)].includes(mint)));
  const second=await h.service.list({launchMode:'pumpswap',offset:1,limit:1});assert.deepEqual(second.coins.map(c=>c.symbol),['P4']);assert.equal(second.total,2);assert.equal(second.nextOffset,null);
  const graduated=await h.service.list({launchMode:'pumpswap',stage:'graduated'});assert.deepEqual(graduated.coins.map(c=>c.symbol),['P4']);assert.equal(graduated.total,1);assert.equal(graduated.counts.all,2);
  const oldest=await h.service.list({launchMode:'raydium',sort:'oldest'});assert.deepEqual(oldest.coins.map(c=>c.symbol),['R3','R1']);assert.equal(oldest.total,2);assert(oldest.coins.every(c=>c.platform==='raydium'&&c.launchMode==='raydium'));
  const all=await h.service.list();assert.deepEqual(all.coins.map(c=>c.symbol),['R1','P2','R3','P4']);assert.equal(all.total,4);assert.deepEqual(await h.service.list({launchMode:'all'}),all);
});

test('launch mode combines with asset, search, age and chain filters without cross-venue fallback',async t=>{
  const h=fixture(t);
  const stocks=await h.service.list({launchMode:'raydium',category:'stocks',search:' RAY ',age:'24h',chain:'solana',quote:stock.mint});assert.deepEqual(stocks.coins.map(c=>c.symbol),['R1']);assert.equal(stocks.total,1);
  for(const filters of [{launchMode:'pumpswap',category:'stocks'},{launchMode:'raydium',search:'Pump'},{launchMode:'pumpswap',chain:'robinhood'},{launchMode:'pumpswap',offset:9}]){
    const result=await h.service.list(filters);assert.deepEqual(result.coins,[]);assert.equal(result.nextOffset,null);if(!filters.offset){assert.equal(result.total,0);assert.equal(result.counts.all,0);assert.equal(result.coverage.total,0);}
  }
});

test('an empty venue stays empty and does not fetch or warm the other venue',async t=>{
  const h=fixture(t,{pumps:[]});const empty=await h.service.list({launchMode:'pumpswap'});assert.deepEqual(empty.coins,[]);assert.equal(empty.total,0);assert.equal(empty.coverage.total,0);assert.deepEqual(h.calls.ray,[]);assert.deepEqual(h.calls.dex,[]);assert.deepEqual(h.calls.pump,[]);
  assert.equal((await h.service.list({launchMode:'raydium'})).total,2);
});

test('venue metadata comes from the verified record adapter, including older Raydium records',async t=>{
  const row=rayLaunch(1);row.platform='pumpswap';row.launchMode='pumpswap';const h=fixture(t,{rays:[row],pumps:[pumpLaunch(2)]});
  const rayCoin=(await h.service.token(key(1))).coin,pumpCoin=(await h.service.token(key(2))).coin;
  assert.equal(rayCoin.platform,'raydium');assert.equal(rayCoin.launchMode,'raydium');assert.equal(pumpCoin.platform,'pumpswap');assert.equal(pumpCoin.launchMode,'pumpswap');
  const profile=await h.service.creator('public_creator');assert.deepEqual(profile.coins.map(c=>c.launchMode),['raydium','pumpswap']);
});

test('invalid launch modes fail before registry or market work',async t=>{
  const h=fixture(t);for(const launchMode of ['', 'pumpfun', 'Raydium', 'other', ['pumpswap'], {}, 1])await assert.rejects(h.service.list({launchMode}),{statusCode:400});assert.equal(h.calls.registry,0);assert.deepEqual(h.calls.ray,[]);assert.deepEqual(h.calls.pump,[]);
});
