import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters } from 'viem';
import { MarketData } from '../src/market-data.mjs';
import { CONTRACTS, poolAbi, poolId, erc20Abi } from '../src/robinhood-contracts.mjs';

const TOKEN='0x'+'11'.repeat(20),QUOTE='0x'+'22'.repeat(20),TRADER='0x'+'33'.repeat(20),OTHER='0x'+'44'.repeat(20);
const KEY='account-blockscout-key',RPC_KEY='account-rpc-key';
const KEY_DATA={currency0:TOKEN,currency1:QUOTE,fee:3000,tickSpacing:60,hooks:'0x'+'00'.repeat(20)};
const POOL=poolId(KEY_DATA),BLOCK='0x'+'bb'.repeat(32),INIT_HASH='0x'+'ee'.repeat(32);
const hash=n=>'0x'+n.toString(16).padStart(64,'0');
const reply=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const pair={chainId:'robinhood',dexId:'uniswap',pairAddress:POOL,baseToken:{address:TOKEN,symbol:'TOKEN',name:'Token'},quoteToken:{address:QUOTE,symbol:'QUOTE',name:'Quote asset'},priceUsd:'2',priceNative:'0.02',liquidity:{usd:100000},volume:{h24:5000},txns:{h24:{buys:10,sells:8}}};

function initLog(){return{address:CONTRACTS.poolManager,transactionHash:INIT_HASH,blockHash:BLOCK,blockNumber:'0x64',logIndex:'0x0',data:encodeAbiParameters(parseAbiParameters('uint24,int24,address,uint160,int24'),[3000,60,KEY_DATA.hooks,1n,0]),topics:encodeEventTopics({abi:poolAbi,eventName:'Initialize',args:{id:POOL,currency0:TOKEN,currency1:QUOTE}})};}
function swapLog(n,{buy=true,pool=POOL}={}){
 return{address:{hash:CONTRACTS.poolManager,is_contract:true},transaction_hash:hash(n),block_hash:BLOCK,block_number:100,block_timestamp:'2026-09-24T12:00:00.000000Z',index:n,data:encodeAbiParameters(parseAbiParameters('int128,int128,uint160,uint128,int24,uint24'),buy?[100000000n,-2000000000000000000n,1n,1n,0,3000]:[-50000000n,900000000000000000n,1n,1n,0,3000]),topics:[...encodeEventTopics({abi:poolAbi,eventName:'Swap',args:{id:pool,sender:TRADER}}),null]};
}
function transaction(n,{status='ok',confirmations=4}={}){return{hash:hash(n),status,confirmations,block_number:100,timestamp:'2026-09-24T12:00:00.000000Z',from:{hash:TRADER,is_contract:false},to:{hash:CONTRACTS.poolManager,is_contract:true},gas_used:'21000',gas_price:'1000000000',fee:{type:'actual',value:'21000000000000'}};}
function harness(t,{withKey=true}={}){
 let now=Date.parse('2026-09-24T12:00:10.000Z'),limited=false;
 const calls=[],rpcCalls=[];
 const logs=[swapLog(1),swapLog(2,{buy:false}),swapLog(3,{pool:'0x'+'aa'.repeat(32)}),swapLog(4),swapLog(5),
   {address:{hash:CONTRACTS.poolManager},transaction_hash:hash(6),block_hash:BLOCK,block_number:100,index:6,data:encodeAbiParameters(parseAbiParameters('uint256'),[1000000n]),topics:encodeEventTopics({abi:erc20Abi,eventName:'Transfer',args:{from:TRADER,to:OTHER}})}];
 const fetcher=async(url,options={})=>{
   const parsed=new URL(url);calls.push({url,headers:options.headers});
   if(parsed.hostname==='api.dexscreener.com'){
     assert(!url.includes(KEY));assert(!url.includes(RPC_KEY));assert.equal(JSON.stringify(options.headers).includes(KEY),false);return reply([pair]);
   }
   assert.equal(parsed.hostname,withKey?'api.blockscout.com':'robinhoodchain.blockscout.com');assert.equal(parsed.searchParams.get('apikey'),withKey?KEY:null);assert(!url.includes(RPC_KEY));assert(!JSON.stringify(options.headers).includes(RPC_KEY));
   if(limited)return new Response('',{status:429,headers:{'retry-after':'120'}});
   const path=parsed.pathname.replace(/^\/4663/,'');
   if(path==='/api'){
     assert.equal(parsed.searchParams.get('module'),'logs');assert.equal(parsed.searchParams.get('action'),'getLogs');assert.equal(parsed.searchParams.get('address').toLowerCase(),CONTRACTS.poolManager.toLowerCase());assert.equal(parsed.searchParams.get('topic1'),POOL);return reply({status:'1',message:'OK',result:[initLog()]});
   }
   if(path===`/api/v2/addresses/${CONTRACTS.poolManager}/logs`||path===`/api/v2/addresses/${CONTRACTS.poolManager.toLowerCase()}/logs`)return reply({items:logs,next_page_params:null});
   if(path===`/api/v2/tokens/${TOKEN}/holders`)return reply({items:[{address:{hash:TRADER,is_contract:false},value:'250000000000000'},{address:{hash:OTHER,is_contract:true},value:'100000000000000'}],next_page_params:null});
   if(path===`/api/v2/tokens/${TOKEN}`)return reply({address_hash:TOKEN,symbol:'TOKEN',decimals:'6',total_supply:'1000000000000000',holders_count:'42'});
   if(path===`/api/v2/tokens/${QUOTE}`)return reply({address_hash:QUOTE,symbol:'QUOTE',decimals:'18',total_supply:'1000000000000000000000'});
   if(path.startsWith('/api/v2/transactions/')){const n=Number(BigInt(path.split('/').at(-1)));return reply(transaction(n,n===4?{status:'error'}:n===5?{confirmations:0}:{}));}
   assert.fail('Unexpected read-only explorer endpoint: '+path);
 };
 const feed=new MarketData({now:()=>now,blockscoutKey:withKey?KEY:'',robinhoodRpcUrl:`https://rpc.example.org/?token=${RPC_KEY}`,rpcGate:{acquire:async()=>{},cooldown:()=>{},removeClient:()=>{}},fetcher,rpcFetcher:async(url,options)=>{rpcCalls.push({url,options});assert(!url.includes(KEY));assert(!JSON.stringify(options).includes(KEY));return new Response('',{status:405});}});
 t.after(()=>feed.close());return{feed,calls,rpcCalls,logs,get now(){return now;},advance:ms=>{now+=ms;},limit:()=>{limited=true;},recover:()=>{limited=false;}};
}

test('Robinhood RPC 405 falls back to selected-pool indexed swaps, while the same account key supplies holder balances and percentages',async t=>{
 const h=harness(t),result=await h.feed.liveTrades('robinhood',TOKEN,POOL);
 assert.equal(result.indexed,true);assert.equal(result.rpcUnavailable,true);assert.match(result.source,/Blockscout/);assert(result.refreshMs>=5000);assert.equal(result.partial,true);
 assert.equal(result.trades.length,2,'Only the two confirmed selected-pool Swap events qualify');
 const buy=result.trades.find(row=>row.side==='buy'),sell=result.trades.find(row=>row.side==='sell');assert(buy);assert(sell);
 assert.equal(buy.tokenAmount,'100');assert.equal(buy.quoteAmount,'2');assert.equal(buy.amountUsd,200);assert.equal(buy.fdvUsd,2000000000);assert.equal(buy.marketCapUsd,null);assert.equal(buy.usdEstimate,true);assert.equal(buy.wallet,TRADER);assert.equal(buy.gasNative,'0.000021');
 assert.equal(sell.tokenAmount,'50');assert.equal(sell.quoteAmount,'0.9');assert.equal(sell.amountUsd,90);assert.equal(sell.wallet,TRADER);
 const holders=await h.feed.holders('robinhood',TOKEN);assert.equal(holders.rows[0].amount,'250000000');assert.equal(holders.rows[0].supplyPercent,25);assert.equal(holders.rows[1].supplyPercent,10);assert.equal(holders.listedSupplyPercent,35);assert.equal(holders.total,42);assert.equal(holders.supply,'1000000000');
 assert(h.rpcCalls.length>=1);assert(!JSON.stringify({result,holders}).includes(KEY));assert(!JSON.stringify({result,holders}).includes(RPC_KEY));
 assert(h.calls.some(call=>call.url.includes('/holders')));assert(h.calls.every(call=>new URL(call.url).hostname==='api.blockscout.com'||!call.url.includes(KEY)));
});

test('indexed fallback caches concurrent viewer polls and labels its slower refresh honestly',async t=>{
 const h=harness(t);const [a,b]=await Promise.all([h.feed.liveTrades('robinhood',TOKEN,POOL),h.feed.liveTrades('robinhood',TOKEN,POOL)]);assert.equal(a.trades.length,2);assert.deepEqual(a,b);
 const count=h.calls.length,rpcCount=h.rpcCalls.length;h.advance(1000);const cached=await h.feed.liveTrades('robinhood',TOKEN,POOL);assert.deepEqual(cached,a);assert.equal(h.calls.length,count);assert.equal(h.rpcCalls.length,rpcCount);assert(cached.refreshMs>=5000);
 h.advance(5001);const next=await h.feed.liveTrades('robinhood',TOKEN,POOL);assert.equal(next.trades.length,2);assert(h.calls.length>count);assert.equal(next.source,a.source);assert.equal(next.indexed,true);
});

test('indexed fallback keeps buy/sell and amounts relative to the searched quote token',async t=>{
 const h=harness(t),result=await h.feed.liveTrades('robinhood',QUOTE,POOL);
 assert.equal(result.tokenAddress,QUOTE);assert.equal(result.trades.length,2);
 const row=result.trades.find(trade=>trade.signature===hash(1));assert.equal(row.side,'sell');assert.equal(row.tokenAmount,'2');assert.equal(row.quoteAmount,'100');assert.equal(row.quoteSymbol,'TOKEN');assert.equal(row.amountUsd,200);assert.equal(row.fdvUsd,100000);
});

test('indexed fallback keeps prior rows stale during explorer throttling and honors Retry-After',async t=>{
 const h=harness(t),first=await h.feed.liveTrades('robinhood',TOKEN,POOL);assert.equal(first.trades.length,2);
 h.advance(6001);h.limit();const stale=await h.feed.liveTrades('robinhood',TOKEN,POOL);assert.equal(stale.stale,true);assert.equal(stale.trades.length,2);assert.match(stale.warning,/retry|limited|cool/i);assert(stale.retryAt>=h.now+120000||stale.refreshMs>=120000);
 const count=h.calls.length;h.advance(1000);const cached=await h.feed.liveTrades('robinhood',TOKEN,POOL);assert.equal(cached.stale,true);assert.equal(h.calls.length,count);
 h.advance(121000);h.recover();const recovered=await h.feed.liveTrades('robinhood',TOKEN,POOL);assert.equal(recovered.trades.length,2);assert.notEqual(recovered.stale,true);
});

test('a public explorer fallback without a key never borrows another account’s credentials or treats transfers as trades',async t=>{
 const h=harness(t,{withKey:false}),result=await h.feed.liveTrades('robinhood',TOKEN,POOL);assert.equal(result.trades.length,2);assert(h.calls.every(call=>['api.dexscreener.com','robinhoodchain.blockscout.com'].includes(new URL(call.url).hostname)));assert(h.calls.every(call=>!call.url.includes(KEY)&&!JSON.stringify(call.headers).includes(KEY)));assert(!JSON.stringify(result).includes(KEY));
});
