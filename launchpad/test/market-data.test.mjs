import test from 'node:test';
import assert from 'node:assert/strict';
import { MarketData, AccountMarketData, marketAddress } from '../src/market-data.mjs';
const token='0x1111111111111111111111111111111111111111',quote='0x2222222222222222222222222222222222222222',pool='0x3333333333333333333333333333333333333333';
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const dexPair = (override={}) => ({ chainId:'robinhood',dexId:'uniswap',pairAddress:pool,baseToken:{address:token,symbol:'MEME',name:'Meme'},quoteToken:{address:quote,symbol:'STOCK',name:'Stock'},priceUsd:'1.23',priceNative:'0.01',marketCap:4000,fdv:5000,liquidity:{usd:10000},volume:{m5:10,h1:30,h6:100,h24:500},txns:{h24:{buys:20,sells:10}},priceChange:{m5:1,h24:-2},pairCreatedAt:100000,...override });
test('DEX Screener search needs no key, coalesces tabs and preserves quote-asset price without relabeling base metrics',async()=>{
  let count=0;const feed=new MarketData({fetcher:async (url,options)=>{count++;assert(url.startsWith('https://api.dexscreener.com/token-pairs/v1/robinhood/'));assert.deepEqual(options.headers,{accept:'application/json'});return json([dexPair()]);}});
  const [a,b]=await Promise.all([feed.pools('robinhood',token),feed.pools('robinhood',token)]);assert.equal(count,1);assert.deepEqual(a,b);assert.equal(a.source,'DEX Screener');assert.equal(a.pools[0].quote.symbol,'STOCK');assert.equal(a.pools[0].marketCapUsd,4000);assert.equal(a.pools[0].chart,`https://dexscreener.com/robinhood/${pool}?embed=1&theme=dark&info=0&trades=0`);assert.equal(a.pools[0].priceChange.h24,-2);assert.equal(a.pools[0].volume.h1,30);assert.deepEqual(a.pools[0].txns.h24,{buys:20,sells:10});
  const q=await feed.pools('robinhood',quote);assert.equal(q.pools[0].priceUsd,123);assert.equal(q.pools[0].marketCapUsd,null);assert.equal(q.pools[0].fdvUsd,null);assert.equal(q.pools[0].priceChange,null);assert.equal(q.pools[0].isBase,false);
  assert.throws(()=>marketAddress('ethereum',token));assert.throws(()=>marketAddress('robinhood','https://localhost/private'));assert.throws(()=>marketAddress('solana',token));
});
test('DEX Screener rejects wrong-chain, wrong-token, malformed and duplicate pairs while accepting v4 pool IDs',async()=>{
  const v4=`0x${'ab'.repeat(32)}`;
  const feed=new MarketData({fetcher:async()=>json([dexPair({chainId:'ethereum'}),dexPair({baseToken:{address:pool},quoteToken:{address:quote}}),dexPair({pairAddress:'https://evil.example'}),dexPair({quoteToken:{address:'not a contract'}}),dexPair({pairAddress:v4.toUpperCase().replace('0X','0x'),url:'https://evil.example',liquidity:{usd:20000}}),dexPair({pairAddress:v4}),dexPair()])});
  const result=await feed.pools('robinhood',token.toUpperCase().replace('0X','0x'));assert.equal(result.pools.length,2);assert.equal(result.pools[0].address,v4);assert.equal(result.pools[0].url,`https://dexscreener.com/robinhood/${v4}`);assert.equal(result.pools[1].address,pool);
});
test('Solana DEX Screener pools use exact mint matches and reject EVM pool addresses',async()=>{
  const sol='So11111111111111111111111111111111111111112',usdc='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',solPool='58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
  const valid=dexPair({chainId:'solana',pairAddress:solPool,baseToken:{address:sol,symbol:'SOL'},quoteToken:{address:usdc,symbol:'USDC'},priceUsd:'100',priceNative:'100'});
  const feed=new MarketData({fetcher:async url=>{assert.equal(url,`https://api.dexscreener.com/token-pairs/v1/solana/${sol}`);return json([valid,{...valid,chainId:'robinhood'},{...valid,pairAddress:pool},{...valid,baseToken:{address:sol.toLowerCase()}}]);}});
  const result=await feed.pools('solana',sol);assert.equal(result.pools.length,1);assert.equal(result.pools[0].isBase,true);assert.equal(result.pools[0].priceUsd,100);assert.equal(result.pools[0].url,`https://dexscreener.com/solana/${solPool}`);
});
test('DEX Screener does not invent prices or counts from missing and malformed numbers',async()=>{
  const feed=new MarketData({fetcher:async()=>json([dexPair({priceNative:'0',marketCap:true,fdv:-1,volume:{h24:[]},priceChange:{h24:'0x20'},txns:{h24:{buys:1.5,sells:-1}},pairCreatedAt:0})])});
  const base=(await feed.pools('robinhood',token)).pools[0];assert.equal(base.marketCapUsd,null);assert.equal(base.fdvUsd,null);assert.equal(base.priceChange.h24,null);assert.equal(base.volume24h,null);assert.deepEqual(base.txns.h24,{buys:null,sells:null});assert.equal(base.createdAt,null);
  assert.equal((await feed.pools('robinhood',quote)).pools[0].priceUsd,null);
});
test('DEX Screener shares Retry-After across feeds, recovers after cooldown and marks cached data stale',async()=>{
  let count=0,now=100000,limited=false;const fetcher=async()=>{count++;return limited?new Response('',{status:429,headers:{'retry-after':'120'}}):json([dexPair()]);};
  const a=new MarketData({now:()=>now,fetcher}),b=new MarketData({now:()=>now,fetcher,marketRefreshSeconds:'300'});
  const first=await a.pools('robinhood',token);assert.equal((await b.pools('robinhood',token)).refreshMs,300000);assert.equal(count,1);
  now+=61000;limited=true;const stale=await a.pools('robinhood',token);assert.equal(stale.stale,true);assert.equal(stale.at,first.at);assert.equal(stale.retryAt,now+120000);assert.match(stale.warning,/rate limited/);
  await assert.rejects(b.pools('robinhood',quote),error=>error.statusCode===503&&error.retryAfterMs===120000);assert.equal(count,2);assert.equal(a.dex.pending.size,0);
  now+=120000;limited=false;assert.equal((await b.pools('robinhood',quote)).stale,undefined);assert.equal(count,3);
});
test('DEX Screener has a sliding server request budget and does not prompt for private keys on provider failure',async()=>{
  let now=100000,count=0;const fetcher=async()=>{count++;return json([]);};const a=new MarketData({now:()=>now,fetcher}),b=new MarketData({now:()=>now,fetcher});
  for(let i=1;i<=240;i++)await (i%2?a:b).pools('robinhood',`0x${i.toString(16).padStart(40,'0')}`);
  await assert.rejects(b.pools('robinhood',pool),error=>error.retryAfterMs===60000);assert.equal(count,240);
  now+=60000;await b.pools('robinhood',pool);assert.equal(count,241);
  const rejected=new MarketData({fetcher:async()=>new Response('',{status:403})});await assert.rejects(rejected.pools('robinhood',token),error=>error.statusCode===503&&!error.connectionRequired&&!/key/i.test(error.message));
  const malformed=new MarketData({fetcher:async()=>json({pairs:[]})});await assert.rejects(malformed.pools('robinhood',token),/invalid pair/);
});
test('account changes preserve the public DEX Screener cooldown without sending account credentials',async()=>{
  let revision=1,calls=0;
  const connections={market:{readSettings:async id=>({revision,settings:{coingeckoKey:`private-${id}`,marketRefreshSeconds:id==='a'?'60':'300'}})},solana:{readSettings:async()=>({settings:{}})}};
  const service=new AccountMarketData(connections,{rpcFetcher:async()=>assert.fail('RPC unused'),fetcher:async(url,options)=>{calls++;assert.equal(new URL(url).hostname,'api.dexscreener.com');assert.deepEqual(options.headers,{accept:'application/json'});return new Response('',{status:429,headers:{'retry-after':'120'}});}});
  try {
    const a=await service.forAccount('a');await assert.rejects(a.pools('robinhood',token),/rate limited/);
    const b=await service.forAccount('b');assert.equal(b.refreshMs,300000);await assert.rejects(b.pools('robinhood',quote),error=>error.retryAfterMs>110000);
    revision++;const rotated=await service.forAccount('a');assert.notEqual(rotated,a);await assert.rejects(rotated.pools('robinhood',token),error=>error.retryAfterMs>110000);assert.equal(calls,1);
  } finally {service.close();}
});

test('a selected DEX Screener pool remains available after falling below the top 20 and shares its public cache', async () => {
  let now=100000;
  const selected=`0x${'ab'.repeat(32)}`, calls=[];
  const leaders=Array.from({length:20},(_,i)=>dexPair({pairAddress:`0x${(i+1).toString(16).padStart(40,'0')}`,liquidity:{usd:20000-i}}));
  const fetcher=async(url,options)=>{
    calls.push(url);assert.deepEqual(options.headers,{accept:'application/json'});
    if(url.includes('/token-pairs/'))return json([...leaders,dexPair({pairAddress:selected,liquidity:{usd:1}})]);
    assert.equal(url,`https://api.dexscreener.com/latest/dex/pairs/robinhood/${selected}`);
    return json({schemaVersion:'1.0.0',pairs:[dexPair({pairAddress:selected,liquidity:{usd:1},priceUsd:'4.56'})]});
  };
  const a=new MarketData({now:()=>now,fetcher,coingeckoKey:'never-send',blockscoutKey:'never-send'});
  const b=new MarketData({now:()=>now,fetcher,marketRefreshSeconds:'300'});
  const first=await a.pools('robinhood',token);assert.equal(first.pools.length,20);assert(!first.pools.some(row=>row.address===selected));
  const retained=await a.pools('robinhood',token,selected.toUpperCase().replace('0X','0x'));
  assert.equal(retained.pools.length,21);assert.equal(retained.pools.at(-1).address,selected);assert.equal(retained.pools.at(-1).priceUsd,4.56);
  assert.equal((await b.pools('robinhood',token,selected)).refreshMs,300000);assert.equal(calls.length,2);
  assert.equal((await a.pools('robinhood',token)).pools.length,20,'a selected pair never contaminates the shared token ranking');
  now+=61000;await a.pools('robinhood',token,selected);assert.equal(calls.length,4);
});

test('selected-pair validation happens before network access and visible selections need no extra lookup', async () => {
  let calls=0;const feed=new MarketData({fetcher:async()=>{calls++;return json([dexPair()]);}});
  for(const selected of ['https://attacker.invalid/pool',`${pool}/extra`,null,{}])await assert.rejects(feed.pools('robinhood',token,selected),error=>error.statusCode===400);
  assert.equal(calls,0);
  assert.equal((await feed.pools('robinhood',token,pool)).pools[0].address,pool);assert.equal(calls,1);
});

test('selected-pair lookup rejects another pool, token, chain or malformed provider response', async () => {
  for(const response of [
    {pairs:[dexPair({pairAddress:quote})]},
    {pairs:[dexPair({baseToken:{address:pool},quoteToken:{address:quote}})]},
    {pairs:[dexPair({chainId:'ethereum'})]},
    {pairs:[dexPair({quoteToken:{address:'invalid'}})]},
    {pairs:'invalid'}, {},
  ]) {
    const feed=new MarketData({fetcher:async url=>json(url.includes('/token-pairs/')?[]:response)});
    await assert.rejects(feed.pools('robinhood',token,pool),error=>error.statusCode===503);
  }
  const feed=new MarketData({fetcher:async url=>json(url.includes('/token-pairs/')?[]:{pairs:[dexPair({pairAddress:quote}),dexPair()]})});
  const quoteSide=await feed.pools('robinhood',quote,pool);
  assert.equal(quoteSide.pools.length,1);assert.equal(quoteSide.pools[0].address,pool);assert.equal(quoteSide.pools[0].token,quote);
  assert.equal(quoteSide.pools[0].priceUsd,123);assert.equal(quoteSide.pools[0].marketCapUsd,null);
});

test('a confirmed empty or missing selected-pair response permits removal', async () => {
  for(const response of [()=>json({pairs:[]}),()=>json({pairs:null}),()=>new Response('',{status:404})]) {
    const feed=new MarketData({fetcher:async url=>url.includes('/token-pairs/')?json([]):response()});
    const result=await feed.pools('robinhood',token,pool);assert.deepEqual(result.pools,[]);assert.equal(result.stale,undefined);
  }
});

test('selected-pair failures retain a known market as stale and never masquerade as confirmed removal', async () => {
  let now=100000,limited=false,calls=0;
  const fetcher=async url=>{
    calls++;
    if(url.includes('/token-pairs/'))return json([]);
    return limited?new Response('',{status:429,headers:{'retry-after':'120'}}):json({pairs:[dexPair()]});
  };
  const feed=new MarketData({fetcher,now:()=>now});
  const first=await feed.pools('robinhood',token,pool);assert.equal(first.pools[0].address,pool);
  now+=61000;limited=true;
  const delayed=await feed.pools('robinhood',token,pool);assert.equal(delayed.stale,true);assert.equal(delayed.at,first.at);assert.equal(delayed.pools[0].address,pool);assert.equal(delayed.retryAt,now+120000);assert.match(delayed.warning,/rate limited/);
  const before=calls;await assert.rejects(feed.pools('robinhood',token,quote),error=>error.statusCode===503&&error.retryAfterMs===120000);assert.equal(calls,before);
  const fresh=new MarketData({fetcher:async url=>url.includes('/token-pairs/')?json([]):new Response('',{status:429,headers:{'retry-after':'60'}})});
  await assert.rejects(fresh.pools('robinhood',token,pool),error=>error.statusCode===503&&error.retryAfterMs===60000);
});

test('holder read uses the account RPC and accurately labels Solana top accounts',async()=>{
  const sol='So11111111111111111111111111111111111111112',calls=[];
  const feed=new MarketData({coingeckoKey:'fixture-cg',solanaRpcUrl:'https://example.com/my-rpc',fetcher:async(url,options)=>{calls.push(url);const q=JSON.parse(options.body);return json({result:q.method==='getTokenSupply'?{value:{amount:'1000000000',decimals:6}}:q.method==='getTokenLargestAccounts'?{value:[{address:sol,amount:'100000000',uiAmountString:'100'}]}:{value:[{data:{parsed:{info:{owner:sol,mint:sol,tokenAmount:{amount:'100000000',decimals:6}}}}}]}});}});
  const holders=await feed.holders('solana',sol);assert.equal(holders.total,null);assert.match(holders.note,/not a complete holder count/);assert.equal(holders.rows[0].tokenAccount,sol);assert(calls.every(url=>url==='https://example.com/my-rpc'));
});

test('Robinhood holders support the official API key route without disclosing its credential',async()=>{
  const urls=[],key='test-blockscout-credential',feed=new MarketData({coingeckoKey:'fixture-cg',blockscoutKey:key,fetcher:async url=>{urls.push(url);return json(url.includes('/holders')?{items:[{address:{hash:token,is_contract:true},value:'1230000'}]}:{decimals:'6',holders_count:'50'});}});
  const value=await feed.holders('robinhood',token);assert.equal(value.rows[0].amount,'1.23');assert.equal(value.total,50);assert(!JSON.stringify(value).includes(key));assert(urls.every(url=>url.startsWith('https://api.blockscout.com/4663/api/v2/tokens/')&&url.endsWith(`?apikey=${key}`)));
});

test('candles support v4 pool IDs and quote assets, sort/deduplicate bars and reject invalid OHLC',async()=>{
  const now=Math.floor(Date.now()/1000)-120,poolId=`0x${'ab'.repeat(32)}`,urls=[];
  const feed=new MarketData({coingeckoKey:'fixture-cg',fetcher:async url=>{urls.push(url);return json({data:{attributes:{ohlcv_list:[[now,2,3,1,2.5,50],[now-60,1,2,1,2,20],[now,2,3,1,2.5,50],[now+1,2,1,2,3,1],[now+2,0,1,0,0.5,1]]}}});}});
  const value=await feed.candles('robinhood',poolId,'5m','quote');assert.equal(value.candles.length,2);assert.equal(value.candles[0].time,now-60);assert(urls[0].includes('ohlcv/minute?aggregate=5'));assert(urls[0].endsWith('token=quote'));assert.equal(value.currency,'USD');
  await assert.rejects(feed.candles('robinhood',poolId,'__proto__'),/interval/);
});

test('rate limits honor Retry-After and preserve a recent snapshot with an explicit stale label',async()=>{
  let now=100000,limited=false,calls=0;
  const feed=new MarketData({coingeckoKey:'fixture-cg',now:()=>now,fetcher:async()=>{calls++;return limited?new Response('',{status:429,headers:{'retry-after':'120'}}):json({data:[{id:'swap',attributes:{kind:'buy',volume_in_usd:'5'}}]});}});
  const first=await feed.trades('robinhood',pool);assert.equal(first.trades.length,1);
  now+=61000;limited=true;const stale=await feed.trades('robinhood',pool);assert.equal(stale.stale,true);assert.equal(stale.at,first.at);assert.equal(stale.retryAt,now+120000);assert.match(stale.warning,/rate limited/);
  const again=await feed.trades('robinhood',pool);assert.equal(again.stale,true);assert.equal(calls,2);
  await assert.rejects(feed.trades('robinhood',quote),error=>error.retryAfterMs===120000);
  now+=301000;await assert.rejects(feed.trades('robinhood',pool),/rate limited/);assert.equal(calls,3);
});

test('personal data keys stay scoped to their provider and absent keys never use the host key', async () => {
  const calls = [], feed = new MarketData({coingeckoKey:'my-demo-key',blockscoutKey:'my-block-key',fetcher:async(url,options)=>{calls.push({url,headers:options.headers});return json(url.includes('/holders')?{items:[]} : url.includes('blockscout')?{decimals:'9',holders_count:'0'}:{data:[]});}});
  await feed.trades('robinhood',pool); await feed.holders('robinhood',token);
  assert.equal(calls[0].headers['x-cg-demo-api-key'],'my-demo-key');
  assert(calls.slice(1).every(call=>!call.headers['x-cg-demo-api-key'] && call.url.includes('my-block-key')));
  const paid = new MarketData({coingeckoKey:'my-pro-key',coingeckoPlan:'pro',fetcher:async(url,options)=>{assert(url.startsWith('https://pro-api.coingecko.com/api/v3/onchain/'));assert.equal(options.headers['x-cg-pro-api-key'],'my-pro-key');assert(!options.headers['x-cg-demo-api-key']);return json({data:[]});}});
  await paid.trades('robinhood',pool);
  const previous=process.env.LAUNCHPAD_BLOCKSCOUT_API_KEY;process.env.LAUNCHPAD_BLOCKSCOUT_API_KEY='host-key-must-not-be-used';
  try {
    const missing=new MarketData({fetcher:async()=>assert.fail('No shared or public fallback should run')});
    await assert.rejects(missing.holders('robinhood',token),error=>error.statusCode===428 && /your Blockscout/.test(error.message));
    await assert.rejects(missing.trades('robinhood',pool),error=>error.statusCode===428 && /your CoinGecko/.test(error.message));
    await assert.rejects(missing.holders('solana','So11111111111111111111111111111111111111112'),/your Solana RPC/);
  } finally { if(previous===undefined)delete process.env.LAUNCHPAD_BLOCKSCOUT_API_KEY;else process.env.LAUNCHPAD_BLOCKSCOUT_API_KEY=previous; }
});

test('account feeds isolate rate limits, replace rotated keys and keep provider caches separate', async()=>{
  const keys={a:'account-a',b:'account-b'},calls=[];
  const connections={market:{readSettings:async id=>({revision:keys[id],settings:{coingeckoKey:keys[id],blockscoutKey:keys[id]}})},solana:{readSettings:async()=>({settings:{}})}};
  const service=new AccountMarketData(connections,{rpcFetcher:async()=>assert.fail('RPC unused'),fetcher:async(url,options)=>{calls.push([url,options.headers]);if(options.headers['x-cg-demo-api-key']==='account-a')return new Response('',{status:429,headers:{'retry-after':'120'}});return json(url.includes('/holders')?{items:[]} : url.includes('blockscout')?{decimals:'9',holders_count:'0'}:{data:[]});}});
  const a=await service.forAccount('a'),b=await service.forAccount('b');
  await assert.rejects(a.trades('robinhood',pool),/rate limited/);
  assert.equal((await b.trades('robinhood',pool)).trades.length,0);
  assert.equal((await a.holders('robinhood',token)).total,0);
  assert.equal(await service.forAccount('a'),a);await assert.rejects(a.trades('robinhood',pool),/allowance/);
  keys.a='rotated-a';const rotated=await service.forAccount('a');assert.notEqual(rotated,a);await rotated.trades('robinhood',pool);
  assert.equal(calls.at(-1)[1]['x-cg-demo-api-key'],'rotated-a');service.close();
});

test('saving refresh settings or another provider key preserves unchanged provider cooldowns', async()=>{
  let revision=1, calls=0;
  const settings={coingeckoKey:'chart-original',blockscoutKey:'holders-original',coingeckoPlan:'demo',marketRefreshSeconds:'60'};
  const connections={market:{readSettings:async()=>({revision:String(revision),settings:{...settings}})},solana:{readSettings:async()=>({settings:{}})}};
  const service=new AccountMarketData(connections,{rpcFetcher:async()=>assert.fail('RPC unused'),fetcher:async(url,options)=>{
    calls++;
    if(options.headers['x-cg-demo-api-key']==='chart-original'||url.includes('holders-original'))return new Response('',{status:429,headers:{'retry-after':'120'}});
    return json(url.includes('/holders')?{items:[]}:url.includes('blockscout')?{decimals:'9',holders_count:'0'}:{data:[]});
  }});
  try {
    const first=await service.forAccount('account');
    await assert.rejects(first.trades('robinhood',pool),/rate limited/);
    await assert.rejects(first.holders('robinhood',token),/rate limited/);
    assert.equal(calls,2);
    settings.marketRefreshSeconds='300';revision++;
    const edited=await service.forAccount('account');assert.equal(edited.refreshMs,300000);
    await assert.rejects(edited.trades('robinhood',pool),error=>error.retryAfterMs>110000);
    await assert.rejects(edited.holders('robinhood',token),/allowance/);assert.equal(calls,2);
    settings.blockscoutKey='holders-rotated';revision++;
    const rotated=await service.forAccount('account');
    assert.equal((await rotated.holders('robinhood',token)).total,0);
    await assert.rejects(rotated.trades('robinhood',pool),/allowance/);assert.equal(calls,4);
    settings.coingeckoKey='chart-rotated';revision++;
    assert.deepEqual((await (await service.forAccount('account')).trades('robinhood',pool)).trades,[]);
    assert.equal(calls,5);
  } finally { service.close(); }
});

test('holder supply snapshots combine Solana accounts by owner and reject unrelated token accounts',async t=>{
  const mint='So11111111111111111111111111111111111111112',owner='11111111111111111111111111111111',a='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',b='58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
  const account=(amount,mintValue=mint)=>({data:{parsed:{info:{mint:mintValue,owner,tokenAmount:{amount,decimals:6}}}}});
  const feed=new MarketData({solanaRpcUrl:'https://example.com/rpc',fetcher:async(url,options)=>{
    const q=JSON.parse(options.body);
    if(q.method==='getTokenSupply')return json({result:{value:{amount:'1000000000',decimals:6}}});
    if(q.method==='getTokenLargestAccounts')return json({result:{value:[{address:a},{address:b},{address:mint},{address:a}]}});
    assert.equal(q.method,'getMultipleAccounts');assert.deepEqual(q.params[0],[a,b,mint]);
    return json({result:{value:[account('100000000'),account('50000000'),account('100000000',a)]}});
  }});t.after(()=>feed.close());
  const value=await feed.holders('solana',mint);assert.equal(value.rows.length,1);assert.equal(value.rows[0].amount,'150');assert.equal(value.rows[0].supplyPercent,15);assert.equal(value.listedSupplyPercent,15);assert.equal(value.supply,'1000');assert.equal(value.historyAvailable,false);assert.equal(value.rows[0].balanceCoverage,'listed-accounts');assert.deepEqual(value.rows[0].tokenAccounts,[a,b]);
});
test('holder history uses only the account Helius key and coalesces requests per wallet',async t=>{
  const sol='So11111111111111111111111111111111111111112',wallet='11111111111111111111111111111111',calls=[];
  const feed=new MarketData({heliusKey:'account-helius',solanaRpcUrl:'https://example.com/private-provider?api-key=do-not-forward',fetcher:async url=>{calls.push(url);return json([]);}});t.after(()=>feed.close());
  const [a,b]=await Promise.all([feed.holderHistory('solana',sol,wallet),feed.holderHistory('solana',sol,wallet)]);
  assert.deepEqual(a,b);assert.equal(calls.length,1);assert(calls[0].startsWith(`https://api-mainnet.helius-rpc.com/v0/addresses/${wallet}/transactions?`));assert(calls[0].includes('api-key=account-helius'));assert(!calls[0].includes('do-not-forward'));assert(calls[0].includes('token-accounts=balanceChanged'));assert(!JSON.stringify(a).includes('account-helius'));
  const unsupported=new MarketData({solanaRpcUrl:'https://example.com/rpc?api-key=do-not-forward',fetcher:async()=>assert.fail('Credential must not leave its provider')});t.after(()=>unsupported.close());
  await assert.rejects(unsupported.holderHistory('solana',sol,wallet),error=>error.statusCode===428);
});
test('Robinhood holder history fetches at most six details and never calls transfers buys',async t=>{
  const wallet='0x4444444444444444444444444444444444444444',urls=[];
  const transfers=Array.from({length:20},(_,i)=>({transaction_hash:`0x${String(i).padStart(64,'0')}`,log_index:i,token:{address_hash:token,type:'ERC-20'},total:{value:'1000000',decimals:'6'},from:{hash:quote},to:{hash:wallet}}));
  const feed=new MarketData({blockscoutKey:'my-private-key',fetcher:async url=>{urls.push(url);if(url.includes('/token-transfers?'))return json({items:transfers});const hash=new URL(url).pathname.split('/').at(-1);return json({hash,status:'ok',from:{hash:wallet},value:'0',token_transfers_overflow:false,actions:[],token_transfers:[]});}});t.after(()=>feed.close());
  const value=await feed.holderHistory('robinhood',token,wallet);assert.equal(urls.length,7);assert.equal(value.available,false);assert.equal(value.transferred.in,20);assert.equal(value.bought.tokens,null);assert(!JSON.stringify(value).includes('my-private-key'));await feed.holderHistory('robinhood',token,wallet);assert.equal(urls.length,7);
  await assert.rejects(feed.holderHistory('robinhood',token,'https://private.example'),error=>error.statusCode===400);assert.equal(urls.length,7);
});
test('RPC market reads share endpoint budgets across accounts and accept legitimate null transaction results',async t=>{
  const acquired=[],removed=[],feed=new MarketData({solanaRpcUrl:'https://example.com/rpc',robinhoodRpcUrl:'https://example.com/evm',rpcRequestsPerSecond:'8',robinhoodRpcRequestsPerSecond:10,rpcScope:'alice',rpcGate:{acquire:async(...args)=>acquired.push(args),removeClient:client=>removed.push(client),cooldown:()=>assert.fail('No cooldown expected')},fetcher:async()=>json({result:null})});t.after(()=>feed.close());
  assert.equal(await feed.rpcRead('solana','getTransaction',['sig']),null);assert.equal(await feed.rpcRead('robinhood','eth_getTransactionByHash',['hash']),null);assert.equal(acquired[0][2],8);assert.equal(acquired[1][2],10);assert.match(acquired[0][0],/^rpc:[a-f0-9]{64}$/);assert.match(acquired[1][0],/^rpc:[a-f0-9]{64}$/);assert.equal(acquired[0][1],acquired[1][1]);assert(!acquired[0][0].includes('example'));
});

test('live swaps receive the exact verified pair and the opposite token USD reference',async t=>{
  const feed=new MarketData({fetcher:async()=>json([dexPair()])});t.after(()=>feed.close());const reads=[];
  feed.liveFeed={read:async input=>{reads.push(input);return {trades:[]};}};
  await feed.liveTrades('robinhood',token,pool);assert.equal(reads[0].tokenAddress,token);assert.equal(reads[0].pair.address,pool);assert.equal(reads[0].quoteUsd,123);
  await feed.liveTrades('robinhood',quote,pool);assert.equal(reads[1].quoteUsd,1.23);assert.equal(reads[1].pair.isBase,false);
  await assert.rejects(feed.liveTrades('robinhood',token,'bad'),error=>error.statusCode===400);assert.equal(reads.length,2);
});

test('Blockscout cooldown covers the raised explorer allowance and credentials stay on its origin',async t=>{
  const calls=[],gate=[];
  const feed=new MarketData({blockscoutKey:'private-explorer-key',rpcGate:{acquire:async(...args)=>gate.push(args),removeClient(){}},fetcher:async url=>{calls.push(url);return new Response('',{status:429,headers:{'retry-after':'90'}});}});t.after(()=>feed.close());
  await assert.rejects(feed.explorer('/api/v2/tokens/'+token),error=>error.retryAfterMs>=89000);
  await assert.rejects(feed.explorer('/api/v2/tokens/'+token+'/holders'),error=>error.retryAfterMs>=89000);
  assert.equal(calls.length,1);assert(calls[0].startsWith('https://api.blockscout.com/4663/api/v2/'));assert(calls[0].endsWith('apikey=private-explorer-key'));
  assert.equal(gate[0][2],2);assert(Number.isFinite(gate[0][3].deadline));assert(gate[0][3].signal);assert(!gate[0][0].includes('private-explorer-key'));
  assert.throws(()=>feed.explorer('https://attacker.invalid/api/v2/tokens/'+token),/Unsupported explorer/);
  assert.throws(()=>feed.explorer('/api?module=account&action=txlist'),/Unsupported explorer/);
});
test('holder balances refresh independently after fifteen seconds without loading history',async t=>{
  let now=1000,calls=0;
  const feed=new MarketData({blockscoutKey:'holder-key',now:()=>now,rpcGate:{acquire:async()=>{},removeClient(){}},fetcher:async url=>{calls++;return json(url.includes('/holders')?{items:[{address:{hash:quote,is_contract:false},value:'250000000'}]}:{decimals:'6',holders_count:'1',total_supply:'1000000000'});}});t.after(()=>feed.close());
  const first=await feed.holders('robinhood',token);assert.equal(first.rows[0].supplyPercent,25);assert.equal(first.listedSupplyPercent,25);assert.equal(calls,2);
  now+=14999;await feed.holders('robinhood',token);assert.equal(calls,2);
  now+=1;await feed.holders('robinhood',token);assert.equal(calls,4);
});
test('native ETH wallet history loads a complete execution trace without repricing in current USD',async t=>{
  const wallet='0x4444444444444444444444444444444444444444',hash='0x'+'a'.repeat(64),urls=[];
  const transfer={transaction_hash:hash,log_index:1,token:{address_hash:token,type:'ERC-20'},total:{value:'1000000',decimals:'6'},from:{hash:pool},to:{hash:wallet}};
  const tx={hash,status:'ok',from:{hash:wallet},to:{hash:pool},value:'1000000000000000000',token_transfers_overflow:false,actions:[{type:'swap'}],token_transfers:[transfer]};
  const trace=[{type:'call',traceAddress:[],subtraces:0,action:{from:wallet,to:pool,value:'0xde0b6b3a7640000',callType:'call'}}];
  const feed=new MarketData({blockscoutKey:'holder-key',rpcGate:{acquire:async()=>{},removeClient(){}},fetcher:async url=>{urls.push(url);return json(url.includes('/token-transfers?')?{items:[transfer]}:url.includes('/raw-trace?')?trace:tx);}});t.after(()=>feed.close());
  const result=await feed.holderHistory('robinhood',token,wallet);assert.equal(urls.length,3);assert.equal(result.bought.tokens,1);assert.equal(result.quotes[0].symbol,'ETH');assert.equal(result.quotes[0].bought,1);assert.equal(result.bought.usd,null);assert.equal(result.coverage.complete,false);
});
test('a queued explorer request does not bypass a new provider cooldown',async t=>{
  let release,starts=0,calls=0;
  const feed=new MarketData({blockscoutKey:'queued-key',rpcGate:{acquire:()=>++starts===1?Promise.resolve():new Promise(resolve=>{release=resolve;}),removeClient(){}},fetcher:async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'60'}});}});t.after(()=>feed.close());
  const first=feed.explorer('/api/v2/tokens/'+token),queued=feed.explorer('/api/v2/tokens/'+quote);
  await assert.rejects(first,error=>error.statusCode===503);release();await assert.rejects(queued,error=>error.statusCode===503);assert.equal(calls,1);
});
