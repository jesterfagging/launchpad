import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PublicKey} from '@solana/web3.js';
import {parseHTML} from 'linkedom';
import {LaunchpadExplore,meteoraDiscoveryRecord} from '../src/launchpad-explore.mjs';
import {PersistentLifetimeVolume} from '../src/public-lifetime-volume.mjs';
import {publicCreatorEarnings} from '../src/public-creator-earnings.mjs';
import {launchAmm,createLaunchAmmBadge} from '../public/amm-branding.mjs';
import {exploreFilters} from '../public/explore-view.mjs';
const NOW=1790668800000,key=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const launch=extra=>({id:'dbc-launch',mint:key(1),dbcPoolId:key(2),configAddress:key(3),creatorWallet:key(4),creatorId:'a'.repeat(32),creatorRecipient:key(5),createdAt:NOW-100000,platform:'meteora',launchMode:'meteora',quoteMint:key(6),quoteSymbol:'STOCK',quoteDecimals:6,baseDecimals:6,feeMode:'creator',name:'Stock coin',symbol:'STOCKCOIN',status:'trading',creatorRewards:{totalClaimedRaw:'12340000',totalPaidRaw:'10000000',pendingRaw:'2340000',historyComplete:true,at:NOW},privateSecret:'DO_NOT_EXPOSE',...extra});
function fixture(t,rows){
 const account={id:'a'.repeat(32),username:'launch_creator',mainWallet:key(4)},calls={ray:0,meteora:0};
 const meteora={publicList:async()=>rows.filter(row=>!row.hidden),publicDetail:async mint=>rows.find(row=>row.mint===mint),marketSnapshot:async mint=>{calls.meteora++;const row=rows.find(row=>row.mint===mint);return {mint,curve:row.dbcPoolId,quote:{mint:row.quoteMint,usd:5,at:NOW,stale:false},status:row.status==='migrated'?'migrated':'curve',at:NOW,slot:100,supply:1e9,priceQuote:.000004,fdvQuote:4000,priceUsd:.00002,fdvUsd:20000,raisedQuote:100,targetQuote:4000,progressPercent:2.5};},trades:async()=>[],publicRewards:async mint=>({mint,mode:'holders',quote:{mint:key(6)},holder:{distributedQuote:'12'}})};
 const service=new LaunchpadExplore({accounts:{list:async()=>[account],get:async()=>account,storeFor:()=>({read:async()=>({launches:[]})})},meteora,now:()=>NOW,chainFactory:async()=>{calls.ray++;throw Error('Meteora must not use Raydium');},marketData:{pools:async(_chain,mint)=>({tokenAddress:mint,at:NOW,pools:[]})},history:{close(){}},activity:{close(){}},listWaitMs:500});t.after(()=>service.close());return{service,calls};
}
test('Meteora projection validates exact mint/pool identity and never leaks its journal',()=>{
 const row=launch(),record=meteoraDiscoveryRecord(row,NOW);assert.equal(record.coin.platform,'meteora');assert.equal(record.coin.quote.decimals,6);assert.equal(record.chainRecord.input.route,'meteora');assert.equal(record.coin.taxBps,0);assert.doesNotMatch(JSON.stringify(record),/DO_NOT_EXPOSE|creatorId|creatorWallet/);
 for(const extra of [{status:'draft'},{quoteDecimals:undefined},{dbcPoolId:'bad'},{configAddress:null},{status:'migrated',poolId:null},{feeMode:'buyback'}])assert.equal(meteoraDiscoveryRecord(launch(extra),NOW),null);
 assert.equal(meteoraDiscoveryRecord(launch({hidden:true}),NOW),null);assert(meteoraDiscoveryRecord(launch({hidden:true}),NOW,{includeHidden:true}));
});
test('Meteora search and profiles retain original creator and use native snapshots only',async t=>{
 const h=fixture(t,[launch()]);const list=await h.service.list({launchMode:'meteora'});assert.equal(list.total,1);assert.equal(list.coins[0].fdvUsd,20000);assert.equal(list.coins[0].marketSource,'Meteora onchain');assert.equal(h.calls.ray,0);assert(h.calls.meteora>0);assert.equal((await h.service.list({launchMode:'raydium'})).total,0);
 const profile=await h.service.creator('launch_creator');assert.equal(profile.coins.length,1);assert.equal(profile.coins[0].creator.username,'launch_creator');
});
test('hidden Meteora coins stay off public lists while holders can still open and trade them',async t=>{
 const h=fixture(t,[launch({hidden:true})]);assert.equal((await h.service.list()).total,0);assert.equal((await h.service.findForTrade(key(1))).coin.mint,key(1));assert.equal((await h.service.find(key(1))).coin.platform,'meteora');
});
test('Meteora rewards delegate to fee-funded service and do not enter Raydium rewards code',async t=>{
 const h=fixture(t,[launch({feeMode:'holders'})]);assert.equal((await h.service.rewards(key(1))).holder.distributedQuote,'12');assert.equal(h.calls.ray,0);
});
test('creator counters retain raw precision and unavailable history never becomes zero',()=>{
 const row=launch(),coin=meteoraDiscoveryRecord(row,NOW).coin,summary=publicCreatorEarnings(row,coin,{now:NOW});assert.equal(summary.earnedRaw,'12340000');assert.equal(summary.quote.decimals,6);assert.equal(summary.status,'available');assert.equal(summary.recipient,key(5));const missing=publicCreatorEarnings({...row,creatorRewards:{}},coin,{now:NOW});assert.equal(missing.earnedRaw,null);assert.equal(missing.status,'unavailable');
});
test('Meteora lifetime reporting scales stock quote atomic units by quote decimals and deduplicates restarts',async()=>{
 let saved=null;const store={read:async(_key,fallback)=>saved||fallback,write:async(_key,data)=>{saved=structuredClone(data);}},record={mint:key(1),curve:key(2),platform:'meteora',quote:{mint:key(6),symbol:'STOCK',decimals:6}},trade={time:Math.floor(NOW/1000),side:'buy',wallet:key(4),signature:'2'.repeat(88),quoteRaw:'1234567',quote:1.234567,amount:22};
 const first=new PersistentLifetimeVolume({store,inventory:async()=>({records:[],complete:true}),meteoraTrades:async()=>[trade],now:()=>NOW});await first.load();await first.step(record);assert.equal(first.data.pools[key(2)].totalAtoms,'1234567000000000000');await first.close();const second=new PersistentLifetimeVolume({store,meteoraTrades:async()=>[trade],now:()=>NOW});await second.load();await second.step(record);assert.equal(second.data.pools[key(2)].totalAtoms,'1234567000000000000');await second.close();
});
test('Meteora badges and filters name the actual DBC and graduated DAMM venue',async()=>{
 const {document}=parseHTML('<html><head></head><body></body></html>');assert.equal(launchAmm({platform:'meteora'}),'meteora');assert.equal(exploreFilters(new URLSearchParams('launchMode=meteora')).launchMode,'meteora');const badge=createLaunchAmmBadge(document,{platform:'meteora',stage:'new'});assert.equal(badge.title,'Meteora DBC → DAMM v2');const graduated=createLaunchAmmBadge(document,{platform:'meteora',stage:'graduated'});assert.equal(graduated.title,'Meteora DAMM v2');const image=badge.querySelector('img');assert((await readFile(new URL('../public'+image.src,import.meta.url))).length>0);
});
