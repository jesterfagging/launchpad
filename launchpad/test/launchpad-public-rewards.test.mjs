import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { publicRewardRecord, publicRewardSummary, PublicLaunchRewards } from '../src/launchpad-public-rewards.mjs';
import { USDC_MINT } from '../public/launchpad-model.mjs';
const NOW=1_790_000_000_000,key=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const sig=n=>'123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[n%58].repeat(64);
const op=(n,kind,patch={})=>({kind,state:'confirmed',signature:sig(n),operationId:'op-'+n,slot:100+n,amount:'0',createdAt:NOW-n*1000,confirmedAt:NOW-n*1000,...patch});
function fixture(mode='holders'){
  const mint=key(1),wallet=key(2),coin={mint,symbol:'TEST',feeMode:mode,taxBps:mode==='holders'?400:0,creatorFeeBps:25,createdAt:NOW-10000,quote:{mint:USDC_MINT,symbol:'USDC'}};
  const chain={curve:key(3),input:{route:'raydium',network:'mainnet-beta',quoteMint:USDC_MINT},keys:{wallet:{address:wallet},mint:{address:mint}},review:{quoteProgram:key(4),quoteDecimals:6,cpConfigId:key(5)}};
  const launch={id:'PRIVATE-ID',input:{...chain.input,feeMode:mode,privateKey:'PRIVATE-INPUT'},review:{...chain.review,price:{usd:'1',source:'PRIVATE-RPC'}},keys:{wallet:{address:wallet,secret:'PRIVATE-WALLET'},mint:{address:mint,secret:'PRIVATE-MINT'}},feeCustody:'relay',authorizedAt:NOW-10000,createdAt:NOW-10000,autoFees:true,state:'live',credits:{quote:'3500000',base:'2000000'},holderRewards:{minimumQuoteUnits:'1000000'},operations:[op(1,'create')]};
  return {launch,coin,chain,record:()=>publicRewardRecord(launch,chain,coin)};
}
const chainView=coin=>({mint:coin.mint,asOf:NOW,stale:false,unclaimedCreatorQuote:'3',wallet:{quoteBalance:'9999',nativeSol:'9999',address:'PRIVATE-PERSONAL'},taxes:{withheldTokens:'42',asOf:NOW,stale:false},private:'PRIVATE-VIEW'});
function viewer(t,{coin,record},{snapshot,fail=false,poolQuote='500000',poolBase='900000',shared=false,missingPool=false}={}){
  let calls=0,poolCalls=0,now=NOW;
  const scopes=[],view={read:async(scope,r)=>{calls++;scopes.push([scope,r]);if(fail)throw Error('https://PRIVATE-RPC/?key=SECRET');return snapshot||chainView(coin);},close(){}},chain={c:{},migratedRayPool:async()=>{poolCalls++;if(missingPool)return null;return {pool:{mintA:new PublicKey(coin.mint),mintB:new PublicKey(coin.quote.mint),poolCreator:new PublicKey(record.keys.wallet.address),creatorFeesMintA:{toString:()=>poolBase},creatorFeesMintB:{toString:()=>poolQuote}}};}};
  const service=new PublicLaunchRewards({view,chainFor:async()=>chain,now:()=>now});t.after(()=>service.close());
  return {service,scopes,advance(ms){now+=ms;},get calls(){return calls;},get poolCalls(){return poolCalls;}};
}

test('sanitized reward record excludes private account state, recipients, signed payloads and RPC credentials',()=>{
  const f=fixture();f.launch.operations.push(op(2,'payout',{amount:'1000000',payouts:[{owner:'PRIVATE-RECIPIENT',amount:'1000000'}],raw:'PRIVATE-SIGNED',externalSignature:'PRIVATE-EXTERNAL'}));
  const record=f.record(),text=JSON.stringify(record);assert(!text.includes('PRIVATE'));assert.equal(record.operations[1].payouts[0].amount,'1000000');assert.equal(record.keys.wallet.secret,undefined);assert.equal(record.id,f.coin.mint);
});

test('holder totals count exact confirmed payouts once and keep earned credits distinct from wallet deposits',()=>{
  const f=fixture(),payout=op(2,'payout',{amount:'2000000',payouts:[{owner:key(8),amount:'1000000'},{owner:key(9),amount:'1000000'}]});f.launch.operations.push(payout,{...payout},op(3,'payout',{state:'pending',amount:'1000000000',payouts:[{amount:'1000000000'}]}));
  const data=publicRewardSummary(f.record(),f.coin,NOW);assert.equal(data.holder.distributedQuote,'2');assert.equal(data.holder.payments,2);assert.equal(data.holder.pendingQuote,'3.5');assert.equal(data.holder.unconvertedTaxTokens,'2');assert.equal(data.holder.pendingOperations,1);assert.equal(data.status,'processing');assert.equal(data.holder.minimumUsd,100);assert.equal(data.holder.minimumQuote,null);assert.equal(data.holder.historyComplete,true);assert(!JSON.stringify(data).includes('signature'));
});

test('actual buyback receipt debits are used instead of larger authorized budgets',()=>{
  const f=fixture('buyback');f.launch.operations.push(op(2,'claim',{receipt:{quoteDelta:'17000000',baseDelta:'30000000'}}),op(3,'buy',{amount:'20000000',receipt:{quoteDelta:'-10000000',baseDelta:'75000000'}}),op(4,'burn',{amount:'50000000',receipt:{quoteDelta:'0',baseDelta:'-50000000'}}));
  const data=publicRewardSummary(f.record(),f.coin,NOW),b=data.buyback;assert.equal(b.totalQuoteSpent,'10');assert.equal(b.tokensBought,'75');assert.equal(b.tokensBurned,'50');assert.equal(b.totalClaimedQuote,'17');assert.equal(b.totalClaimedTokens,'30');assert.equal(b.completedBuys,1);assert.equal(b.completedBurns,1);assert.equal(b.buybackPercent,100);assert.equal(b.historyComplete,true);assert.equal(data.enabled,true);
});

test('legacy buys and claims with missing receipt amounts remain unknown rather than budget or zero totals',()=>{
  const f=fixture('buyback');f.launch.operations.push(op(2,'claim'),op(3,'buy',{amount:'20000000'}),op(4,'burn',{amount:'50000000'}));const b=publicRewardSummary(f.record(),f.coin,NOW).buyback;
  assert.equal(b.totalQuoteSpent,null);assert.equal(b.tokensBought,null);assert.equal(b.totalClaimedQuote,null);assert.equal(b.tokensBurned,'50');assert.equal(b.completedBuys,1);assert.equal(b.historyComplete,false);assert.match(b.historyNote,/purchase budgets are not treated as spending/);
});

test('missing creation journal cannot assert lifetime zero and paused services do not claim enabled',()=>{
  const f=fixture('buyback');f.launch.operations=[];f.launch.autoFees=false;f.launch.state='paused';const data=publicRewardSummary(f.record(),f.coin,NOW);assert.equal(data.buyback.totalQuoteSpent,null);assert.equal(data.buyback.totalClaimedQuote,null);assert.equal(data.buyback.tokensBurned,null);assert.equal(data.enabled,false);assert.equal(data.status,'paused');
});

test('pending, failed, malformed and duplicate confirmations cannot inflate public buyback totals',()=>{
  const f=fixture('buyback'),buy=op(2,'buy',{amount:'20000000',receipt:{quoteDelta:'-10000000',baseDelta:'75000000'}});f.launch.operations.push(buy,{...buy},op(3,'buy',{state:'failed',amount:'9999999999'}),op(4,'buy',{state:'pending',amount:'9999999999'}),op(5,'buy',{slot:null,amount:'9999999999'}));const b=publicRewardSummary(f.record(),f.coin,NOW).buyback;
  assert.equal(b.totalQuoteSpent,null);assert.equal(b.tokensBought,null);assert.equal(b.completedBuys,1);assert.equal(b.pendingOperations,1);assert.equal(b.historyComplete,false);
});

test('public reward balances use host namespace and expose no wallet balances, signer fields or operator controls',async t=>{
  const f=fixture(),record=f.record(),h=viewer(t,{coin:f.coin,record});const data=await h.service.read(record,f.coin);
  assert.equal(data.holder.distributedQuote,'0');assert.equal(data.holder.pendingQuote,'3.5');assert.equal(data.holder.unclaimedCreatorQuote,'3.5');assert.equal(data.holder.unclaimedScope,'curve_and_pool');assert.equal(data.holder.unclaimedPoolQuote,'0.5');assert.equal(data.holder.unclaimedBaseTokens,'0.9');assert.equal(data.holder.withheldTokens,'42');assert.equal(data.holder.withheldIsEstimate,true);assert.equal(data.stale,false);
  const json=JSON.stringify(data);assert(!json.includes('PRIVATE'));assert(!json.includes('9999'));assert(!json.includes('signature'));assert(!json.includes('nativeSol'));assert.equal(h.scopes[0][0],'public-discovery');assert(!JSON.stringify(h.scopes).includes('PRIVATE'));
});

test('shared legacy vault balances cannot be attributed to one coin or expose a personal wallet explorer',async t=>{
  const f=fixture('buyback');f.launch.feeCustody='legacy';const record=f.record(),h=viewer(t,{coin:f.coin,record}),data=await h.service.read(record,f.coin);
  assert.equal(data.buyback.unclaimedCreatorQuote,null);assert.equal(data.buyback.totalClaimedQuote,null);assert.equal(data.buyback.totalClaimedTokens,null);assert.equal(data.buyback.unclaimedShared,true);assert.equal(data.buyback.unclaimedPoolQuote,'0.5');assert.equal(data.activityUrl,null);assert.match(data.buyback.unclaimedNote,/shares a fee vault/);
});

test('public statistics link only the dedicated managed service wallet',()=>{
  const f=fixture('buyback');assert.equal(publicRewardSummary(f.record(),f.coin).activityUrl,'https://solscan.io/account/'+f.chain.keys.wallet.address);delete f.launch.feeCustody;assert.equal(publicRewardSummary(f.record(),f.coin).activityUrl,null);
});

test('holder role projection links the active execution wallet while retaining original creator identity',()=>{
  const f=fixture(),reward=key(12);f.launch.keys.rewards={address:reward,secret:'PRIVATE-REWARDS'};f.launch.rewardsWallet={version:1,status:'active',address:reward,creatorCredits:{base:'1',quote:'2'},private:'PRIVATE-STATE'};f.launch.operations.push(op(7,'reward-handoff',{state:'pending'}));
  const record=f.record(),data=publicRewardSummary(record,f.coin,NOW);assert.equal(record.keys.wallet.address,f.chain.keys.wallet.address);assert.deepEqual(record.keys.rewards,{address:reward});assert(!JSON.stringify(record).includes('PRIVATE'));assert.equal(data.activityUrl,'https://solscan.io/account/'+reward);assert.deepEqual(data.wallets,{creatorAddress:f.chain.keys.wallet.address,rewardsAddress:reward,status:'active'});assert.equal(data.holder.pendingOperations,1);assert.equal(data.holder.distributedQuote,'0');
});

test('an invalid active role stays unavailable instead of falsely reverting to the creator wallet',async t=>{
  const f=fixture(),reward=key(12);f.launch.keys.rewards={address:reward,exported:true};f.launch.rewardsWallet={version:1,status:'active',address:reward};
  const record=f.record(),data=publicRewardSummary(record,f.coin,NOW);assert.equal(record.rewardsWallet.status,'active');assert.equal(record.rewardsWallet.available,false);assert.equal(data.wallets.status,'unavailable');assert.equal(data.wallets.rewardsAddress,reward);assert.equal(data.activityUrl,'https://solscan.io/account/'+reward);
  const service=new PublicLaunchRewards({now:()=>NOW,chainFor:async()=>{throw Error('An invalid active role must not read creator balances.');}});t.after(()=>service.close());const response=await service.read(record,f.coin);assert.equal(response.stale,true);assert.equal(response.holder.unclaimedCreatorQuote,null);assert.match(response.error,/unavailable/);
  f.launch.rewardsWallet.address='not-an-address';const malformed=publicRewardSummary(f.record(),f.coin,NOW);assert.equal(malformed.activityUrl,null);assert.equal(malformed.wallets.status,'unavailable');
});

test('public balance cache is replaced immediately when a reward wallet activates',async t=>{
  const f=fixture(),h=viewer(t,{coin:f.coin,record:f.record()});await h.service.read(f.record(),f.coin);assert.equal(h.calls,1);
  const reward=key(12);f.launch.keys.rewards={address:reward};f.launch.rewardsWallet={version:1,status:'active',address:reward};const active=await h.service.read(f.record(),f.coin);assert.equal(h.calls,2);assert.equal(active.wallets.rewardsAddress,reward);assert.equal(h.scopes[1][1].keys.wallet.address,f.chain.keys.wallet.address);assert.equal(h.scopes[1][1].keys.rewards.address,reward);
});

test('cached chain snapshots coalesce but current saved ledger amounts update on every call',async t=>{
  const f=fixture(),record=f.record(),h=viewer(t,{coin:f.coin,record});const [a,b]=await Promise.all([h.service.read(record,f.coin),h.service.read(record,f.coin)]);assert.equal(a.holder.unclaimedCreatorQuote,b.holder.unclaimedCreatorQuote);assert.equal(h.calls,1);assert.equal(h.poolCalls,1);
  record.credits.quote='1250000';assert.equal((await h.service.read(record,f.coin)).holder.pendingQuote,'1.25');assert.equal(h.calls,1);h.advance(30_001);await h.service.read(record,f.coin);assert.equal(h.calls,2);
});

test('RPC errors remain generic without disguising unavailable chain balances as zero',async t=>{
  const f=fixture(),record=f.record(),h=viewer(t,{coin:f.coin,record},{fail:true});const data=await h.service.read(record,f.coin);assert.equal(data.holder.unclaimedCreatorQuote,null);assert.equal(data.holder.withheldTokens,null);assert.equal(data.holder.pendingQuote,'3.5');assert.equal(data.stale,true);assert(!JSON.stringify(data).includes('PRIVATE'));assert.match(data.error,/temporarily unavailable/);
});

test('full journal totals are not calculated from a truncated recent-operations window',()=>{
  const f=fixture();for(let n=0;n<100;n++)f.launch.operations.push(op(n+2,'payout',{signature:key(n+20)+key(n+21),amount:'1000000',payouts:[{amount:'1000000'}]}));const result=publicRewardSummary(f.record(),f.coin,NOW);assert.equal(result.holder.distributedQuote,'100');assert.equal(result.holder.payments,100);
});

test('global anonymous balance checks have a bounded request allowance',async t=>{
  const f=fixture('buyback'),record=f.record(),h=viewer(t,{coin:f.coin,record});let busy=0;for(let n=10;n<40;n++){const coin={...f.coin,mint:key(n)},r={...record,id:key(n),keys:{...record.keys,mint:{address:key(n)}}};const data=await h.service.read(r,coin);if(data.error?.includes('refreshing'))busy++;}assert.equal(h.calls,20);assert.equal(busy,10);
});

test('malformed confirmed payout evidence makes lifetime holder totals unknown',()=>{
  const f=fixture();f.launch.operations.push(op(2,'payout',{signature:'invalid',amount:'1000000',payouts:[{amount:'1000000'}]}));const data=publicRewardSummary(f.record(),f.coin,NOW);assert.equal(data.holder.distributedQuote,null);assert.equal(data.holder.payments,null);assert.equal(data.holder.historyComplete,false);
});

test('missing graduated pool counters remain unknown, including after stage changes during the cache window',async t=>{
  const f=fixture('buyback'),record=f.record(),h=viewer(t,{coin:f.coin,record},{missingPool:true});
  const curve=await h.service.read(record,{...f.coin,curveStatus:'curve'});assert.equal(curve.buyback.unclaimedCreatorQuote,'3');assert.equal(curve.buyback.unclaimedScope,'curve');assert.equal(curve.buyback.unclaimedPoolQuote,null);assert.equal(curve.stale,false);
  const graduated=await h.service.read(record,{...f.coin,curveStatus:'migrated'});assert.equal(graduated.buyback.unclaimedCreatorQuote,null);assert.equal(graduated.buyback.unclaimedCurveQuote,'3');assert.equal(graduated.buyback.unclaimedPoolQuote,null);assert.equal(graduated.buyback.unclaimedBaseTokens,null);assert.equal(graduated.buyback.unclaimedScope,'curve');assert.equal(graduated.buyback.unclaimedPoolPending,true);assert.equal(graduated.stale,true);assert.match(graduated.error,/Graduated pool/);assert.match(graduated.buyback.unclaimedNote,/total unclaimed creator fees are unknown/);assert.equal(h.poolCalls,1);
});

test('SV151 holder and buyback statistics replace stored QUOTE units without changing reward amounts',async t=>{
  for(const mode of ['holders','buyback']){
    const f=fixture(mode);f.coin.quote={mint:'SV151D5pjygAKA8aJJcKzm4wFnRX5G92Fye94jQJk7g',symbol:'QUOTE'};f.chain.input.quoteMint=f.coin.quote.mint;f.launch.input.quoteMint=f.coin.quote.mint;f.launch.review.quoteSymbol='QUOTE';
    const record=f.record(),h=viewer(t,{coin:f.coin,record});assert.equal(record.review.quoteSymbol,'SV151');const data=await h.service.read(record,f.coin);assert.equal(data.quote.symbol,'SV151');assert.equal((data.holder||data.buyback).pendingQuote,'3.5');assert.equal(f.launch.review.quoteSymbol,'QUOTE');
  }
});

test('verified rewards snapshot supplies the symbol for custom quote mints absent the catalogue',async t=>{
  const f=fixture('buyback');f.coin.quote={mint:key(9),symbol:'QUOTE'};f.chain.input.quoteMint=f.coin.quote.mint;const snapshot=chainView(f.coin);snapshot.wallet.quoteSymbol='ASTRA';
  const record=f.record(),h=viewer(t,{coin:f.coin,record},{snapshot});assert.equal((await h.service.read(record,f.coin)).quote.symbol,'ASTRA');
});

test('legacy buy receipts recover from verified finalized transaction amounts without changing credits',async t=>{
  const f=fixture('buyback'),buy=op(3,'buy',{amount:'2000000'});f.launch.operations.push(buy);let calls=0;
  const row=(mint,amount,index)=>({owner:f.chain.keys.wallet.address,mint,accountIndex:index,uiTokenAmount:{amount}});
  const tx={slot:buy.slot,transaction:{signatures:[buy.signature],message:{staticAccountKeys:[f.chain.keys.wallet.address]}},meta:{err:null,fee:5000,preBalances:[100000],postBalances:[95000],preTokenBalances:[row(f.coin.quote.mint,'5000000',1)],postTokenBalances:[row(f.coin.quote.mint,'3500000',1),row(f.coin.mint,'2500000',2)]}};
  const service=new PublicLaunchRewards({now:()=>NOW,view:{read:async()=>chainView(f.coin)},chainFor:async()=>({receipt:async()=>{calls++;return tx;}})});t.after(()=>service.close());
  const record=f.record(),before=JSON.stringify(record),data=await service.read(record,f.coin);
  assert.equal(data.buyback.totalQuoteSpent,'1.5');assert.equal(data.buyback.tokensBought,'2.5');assert.equal(JSON.stringify(record),before);
  await service.read(record,f.coin);assert.equal(calls,1);
});
test('historical mismatched signature or slot cannot become confirmed buy totals',async t=>{
  for(const wrong of ['signature','slot']){
    const f=fixture('buyback'),buy=op(3,'buy',{amount:'2000000'});f.launch.operations.push(buy);
    const service=new PublicLaunchRewards({now:()=>NOW,view:{read:async()=>chainView(f.coin)},chainFor:async()=>({receipt:async()=>({slot:wrong==='slot'?1:buy.slot,transaction:{signatures:[wrong==='signature'?'bad':buy.signature]},meta:{err:null}})})});t.after(()=>service.close());
    const data=await service.read(f.record(),f.coin);assert.equal(data.buyback.totalQuoteSpent,null);assert.equal(data.buyback.tokensBought,null);
  }
});
test('a stopped saved cycle is paused rather than processing when no transaction is pending',()=>{
  const f=fixture('buyback');Object.assign(f.launch,{autoFees:false,state:'paused',cycle:{stage:'burn'},feesRequested:false});assert.equal(publicRewardSummary(f.record(),f.coin,NOW).status,'paused');
});


test('public reward retries expose only a valid future check time for enabled automation',()=>{
  for(const mode of ['holders','buyback']){
    const f=fixture(mode);Object.assign(f.launch,{feesRequested:true,cycle:{stage:'distribute'},rewardRetry:{at:NOW+30000,attempt:2,kind:'network',reason:'PRIVATE-RPC-CREDENTIAL',accountId:'PRIVATE-ACCOUNT'},error:'PRIVATE-PROVIDER-ERROR'});
    const record=f.record(),summary=publicRewardSummary(record,f.coin,NOW);
    assert.equal(record.rewardRetryAt,NOW+30000);assert.equal(summary.status,'retrying');assert.equal(summary.retryAt,NOW+30000);assert.equal(summary.enabled,true);
    assert.equal((summary.holder||summary.buyback).pendingQuote,'3.5');assert(!JSON.stringify(record).includes('PRIVATE'));assert(!JSON.stringify(summary).includes('PRIVATE'));
    assert.equal(publicRewardSummary(record,f.coin,NOW+30000).status,'processing');assert.equal(publicRewardSummary(record,f.coin,NOW+30000).retryAt,null);
    Object.assign(f.launch,{autoFees:false,state:'paused',feesRequested:false});const paused=publicRewardSummary(f.record(),f.coin,NOW);assert.equal(paused.status,'paused');assert.equal(paused.retryAt,null);
  }
});

test('invalid or stale reward retry timestamps cannot claim a scheduled automatic check',()=>{
  for(const at of [null,0,-1,'1790000030000',Infinity,NaN,8640000000000001,NOW-1]){
    const f=fixture();Object.assign(f.launch,{feesRequested:true,rewardRetry:{at}});const data=publicRewardSummary(f.record(),f.coin,NOW);
    assert.equal(data.status,'processing');assert.equal(data.retryAt,null);
  }
});
