import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Keypair,PublicKey } from '@solana/web3.js';
import { encodeEventTopics,encodeAbiParameters,parseAbiParameters } from 'viem';
import bs58 from 'bs58';
import { LiveMarketTrades,decodeSolanaPoolSwap,decodeEvmPoolSwap,decodeExplorerPoolSwap } from '../src/live-market-trades.mjs';
import { pairAbi,v3PoolAbi,curveAbi } from '../src/robinhood-legacy-contracts.mjs';
import { poolAbi,CONTRACTS,poolId } from '../src/robinhood-contracts.mjs';
import liquiditySdks from '../src/liquidity-sdks.cjs';

const pk=n=>Keypair.fromSeed(Buffer.alloc(32,n)).publicKey.toBase58();
const A=pk(1),B=pk(2),POOL=pk(3),V0=pk(4),V1=pk(5),USER=pk(6),PROGRAM='CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const solPool={address:POOL,program:PROGRAM,protocol:'cpmm',mints:[A,B],vaults:[V0,V1],supply:{amount:'100000000000000',decimals:6}};
const solPair={address:POOL,base:{address:A,symbol:'COIN'},quote:{address:B,symbol:'SOL'}};
const context={tokenAddress:A,quoteUsd:100,quoteSymbol:'SOL',supply:solPool.supply};
function solTx(signature='sig1'){
 const balances=(base,quote)=>[{accountIndex:2,mint:A,uiTokenAmount:{amount:String(base),decimals:6}},{accountIndex:3,mint:B,uiTokenAmount:{amount:String(quote),decimals:9}}];
 return{slot:500,blockTime:1700000000,transaction:{signatures:[signature],message:{accountKeys:[{pubkey:USER,signer:true},{pubkey:POOL},V0,V1],instructions:[{programId:PROGRAM,accounts:[USER,POOL,V0,V1],data:bs58.encode(Buffer.concat([createHash('sha256').update('global:swap_base_input').digest().subarray(0,8),Buffer.alloc(16)]))}]}},meta:{err:null,fee:5000,preTokenBalances:balances(1000000000,10000000000),postTokenBalances:balances(900000000,12000000000)}};
}
test('Solana selected-pool swaps have exact units, fees and clearly estimated USD/FDV',()=>{
 const row=decodeSolanaPoolSwap(solTx(),solPool,context);assert.equal(row.side,'buy');assert.equal(row.tokenAmount,'100');assert.equal(row.quoteAmount,'2');assert.equal(row.amountUsd,200);assert.equal(row.priceUsd,2);assert.equal(row.fdvUsd,200000000);assert.equal(row.marketCapUsd,null);assert.equal(row.gasNative,'0.000005');assert.equal(row.wallet,USER);assert.equal(row.walletRole,'transaction payer');assert.equal(row.usdEstimate,true);
 const reversed=decodeSolanaPoolSwap(solTx(),solPool,{tokenAddress:B,quoteUsd:2,quoteSymbol:'COIN'});assert.equal(reversed.side,'sell');assert.equal(reversed.tokenAmount,'2');assert.equal(reversed.quoteAmount,'100');assert.equal(reversed.fdvUsd,null);
 const noPrice=decodeSolanaPoolSwap(solTx(),solPool,{tokenAddress:A});assert.equal(noPrice.amountUsd,null);assert.equal(noPrice.priceUsd,null);
});
test('Solana plain transfers, liquidity actions, another pool, failed txs and mixed operations never become swap rows',()=>{
 for(const change of [
   tx=>tx.transaction.message.instructions=[],
   tx=>tx.transaction.message.instructions[0].programId=pk(7),
   tx=>tx.transaction.message.instructions[0].accounts=[USER,pk(7),V0,V1],
   tx=>tx.transaction.message.instructions[0].data=bs58.encode(createHash('sha256').update('global:deposit').digest().subarray(0,8)),
   tx=>tx.meta.err={InstructionError:[0,'Error']},
   tx=>tx.meta.postTokenBalances[0].uiTokenAmount.amount='1100000000',
   tx=>tx.meta.postTokenBalances[0].mint=pk(7),
   tx=>tx.transaction.message.instructions.push({...tx.transaction.message.instructions[0]}),
   tx=>tx.transaction.message.instructions.push({...tx.transaction.message.instructions[0],data:bs58.encode(createHash('sha256').update('global:deposit').digest().subarray(0,8))}),
 ]){const tx=solTx();change(tx);assert.equal(decodeSolanaPoolSwap(tx,solPool,context),null);}
});
test('Solana CPI swaps are decoded only when the same verified pool and vaults occur in the swap instruction',()=>{
 const tx=solTx(),swap=tx.transaction.message.instructions.pop();tx.meta.innerInstructions=[{index:0,instructions:[swap]}];assert.equal(decodeSolanaPoolSwap(tx,solPool,context).side,'buy');swap.accounts.pop();assert.equal(decodeSolanaPoolSwap(tx,solPool,context),null);
});
test('unrelated vault transfers cannot inflate swap amounts, including CPI transfers after a swap returns',()=>{
 const transfer={programId:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',parsed:{type:'transfer',info:{source:USER,destination:V1,amount:'1000000000'}},stackHeight:3};
 const direct=solTx();direct.transaction.message.instructions.push(transfer);assert.equal(decodeSolanaPoolSwap(direct,solPool,context),null);
 const nested=solTx(),swap=nested.transaction.message.instructions.pop();swap.stackHeight=2;nested.meta.innerInstructions=[{index:0,instructions:[swap,transfer]}];assert(decodeSolanaPoolSwap(nested,solPool,context));
 nested.meta.innerInstructions[0].instructions.splice(1,0,{programId:pk(10),stackHeight:2});assert.equal(decodeSolanaPoolSwap(nested,solPool,context),null);
});
test('live Solana descriptor decodes the installed CPMM layout and rejects wrong pool discriminators or mints',async()=>{
 const ray=liquiditySdks.raydium(),layout=ray.CpmmPoolInfoLayout,data=Buffer.alloc(layout.span);createHash('sha256').update('account:PoolState').digest().copy(data,0,0,8);
 for(const [name,value]of Object.entries({mintA:A,mintB:B,vaultA:V0,vaultB:V1}))new PublicKey(value).toBuffer().copy(data,layout.offsetOf(name));
 let owner=PROGRAM;const feed=new LiveMarketTrades({rpc:async(chain,method)=>method==='getAccountInfo'?{value:{owner,data:[data.toString('base64'),'base64']}}:{value:solPool.supply}});
 const descriptor=await feed.describe('solana',solPair,A);assert.deepEqual(descriptor.mints,[A,B]);assert.deepEqual(descriptor.vaults,[V0,V1]);
 data[0]^=1;await assert.rejects(feed.describe('solana',solPair,A),/not a verified pool/);data[0]^=1;
 await assert.rejects(feed.describe('solana',{...solPair,base:{address:pk(8)}},A),/currencies/);owner=pk(9);await assert.rejects(feed.describe('solana',solPair,A),/not yet supported/);
});
const E0='0x'+'11'.repeat(20),E1='0x'+'22'.repeat(20),EP='0x'+'33'.repeat(20),EU='0x'+'44'.repeat(20),HASH='0x'+'55'.repeat(32),BLOCK='0x'+'66'.repeat(32);
const evmContext={tokenAddress:E0,quoteUsd:100,quoteSymbol:'ETH',supply:{amount:'100000000000000',decimals:6}};
function evmFixture(protocol='v3'){
 const pool={address:EP,protocol,mints:[E0,E1],decimals:[6,18]},receipt={status:'0x1',transactionHash:HASH,blockHash:BLOCK,from:EU,gasUsed:'0x5208',effectiveGasPrice:'0x3b9aca00'},block={hash:BLOCK,timestamp:'0x6553f100'};
 let topics,data;
 if(protocol==='v3'){topics=encodeEventTopics({abi:v3PoolAbi,eventName:'Swap',args:{sender:EU,recipient:EU}});data=encodeAbiParameters(parseAbiParameters('int256,int256,uint160,uint128,int24'),[-100000000n,2000000000000000000n,1n,1n,0]);}
 if(protocol==='v2'){topics=encodeEventTopics({abi:pairAbi,eventName:'Swap',args:{sender:EU,to:EU}});data=encodeAbiParameters(parseAbiParameters('uint256,uint256,uint256,uint256'),[0n,2000000000000000000n,100000000n,0n]);}
 if(protocol==='v4'){pool.id='0x'+'77'.repeat(32);pool.logAddress=CONTRACTS.poolManager;topics=encodeEventTopics({abi:poolAbi,eventName:'Swap',args:{id:pool.id,sender:EU}});data=encodeAbiParameters(parseAbiParameters('int128,int128,uint160,uint128,int24,uint24'),[100000000n,-2000000000000000000n,1n,1n,0,3000]);}
 if(protocol==='pons-curve'){pool.token=E0;topics=encodeEventTopics({abi:curveAbi,eventName:'CurveBuy',args:{buyer:EU,recipient:EU}});data=encodeAbiParameters(parseAbiParameters('uint256,uint256,uint256,uint256'),[2000000000000000000n,100000000n,1n,1n]);}
 return{pool,receipt,block,log:{address:pool.logAddress||EP,transactionHash:HASH,blockHash:BLOCK,blockNumber:'0x64',logIndex:'0x1',topics,data}};
}
test('verified V2, V3, V4 and Pons swap events preserve side, exact units, sender and transaction gas',()=>{
 for(const protocol of ['v2','v3','v4','pons-curve']){const {pool,receipt,block,log}=evmFixture(protocol),row=decodeEvmPoolSwap(log,pool,receipt,block,evmContext);assert(row,protocol);assert.equal(row.side,'buy',protocol);assert.equal(row.tokenAmount,'100');assert.equal(row.quoteAmount,'2');assert.equal(row.amountUsd,200);assert.equal(row.gasNative,'0.000021');assert.equal(row.wallet,EU);
 const reversed=decodeEvmPoolSwap(log,pool,receipt,block,{tokenAddress:E1,quoteUsd:2});assert.equal(reversed.side,'sell');assert.equal(reversed.tokenAmount,'2');}
});
test('EVM swaps reject unrelated pools, pool IDs, failed receipts, removed logs and mismatched transaction/block identities',()=>{
 for(const change of [f=>f.log.address=EU,f=>f.log.removed=true,f=>f.receipt.status='0x0',f=>f.receipt.transactionHash=BLOCK,f=>f.receipt.blockHash=HASH,f=>f.block.hash=HASH,f=>f.log.data='0x']){const f=evmFixture();change(f);assert.equal(decodeEvmPoolSwap(f.log,f.pool,f.receipt,f.block,evmContext),null);}
 const f=evmFixture('v4');f.pool.id=HASH;assert.equal(decodeEvmPoolSwap(f.log,f.pool,f.receipt,f.block,evmContext),null);
});
test('live requests coalesce, respect 1s cache, bound high activity and do not decode a signature twice',async()=>{
 let time=1000,reads=0;const signatures=Array.from({length:40},(_,i)=>({signature:'sig'+i,err:null}));
 const feed=new LiveMarketTrades({now:()=>time,rpc:async(chain,method,params)=>{if(method==='getSignaturesForAddress')return signatures;if(method==='getTransaction'){reads++;return solTx(params[0]);}throw Error(method);}});feed.describe=async()=>solPool;
 const query={chain:'solana',pair:solPair,...context},[a,b]=await Promise.all([feed.read(query),feed.read(query)]);assert.equal(reads,6);assert.deepEqual(a,b);assert.equal(a.trades.length,6);assert.equal(a.refreshMs,1000);assert.equal(a.backlog,34);assert(a.partial);assert.match(a.warning,/High activity/);
 await feed.read(query);assert.equal(reads,6);time+=1001;const next=await feed.read(query);assert.equal(reads,12);assert.equal(next.trades.length,12);for(let i=0;i<6;i++){time+=1001;await feed.read(query);}assert.equal(reads,40);
});
test('null RPC details are retried and provider failures retain stale rows with cooldown and no credentials',async()=>{
 let time=1000,mode='null',calls=0;const feed=new LiveMarketTrades({now:()=>time,rpc:async(chain,method,params)=>{calls++;if(mode==='error')throw Object.assign(Error('secret-key-in-endpoint'),{retryAfterMs:60000});if(method==='getSignaturesForAddress')return[{signature:'sig1',err:null}];return mode==='null'?null:solTx(params[0]);}});feed.describe=async()=>solPool;
 const query={chain:'solana',pair:solPair,...context};assert.equal((await feed.read(query)).backlog,1);mode='ok';time+=1001;const good=await feed.read(query);assert.equal(good.trades.length,1);mode='error';time+=1001;const stale=await feed.read(query);assert.equal(stale.stale,true);assert.equal(stale.at,good.at);assert.equal(stale.trades.length,1);assert.equal(stale.refreshMs,60000);assert(!JSON.stringify(stale).includes('secret'));const count=calls;await feed.read(query);assert.equal(calls,count);
});
test('EVM polling filters exact pool logs, deduplicates receipt reads, scans bounded blocks and removes shallow-reorg rows',async()=>{
 const f=evmFixture(),requests=[];let time=1000,logs=[f.log];const feed=new LiveMarketTrades({now:()=>time,rpc:async(chain,method,params)=>{requests.push([method,params]);if(method==='eth_blockNumber')return'0x66';if(method==='eth_getLogs')return logs;if(method==='eth_getTransactionReceipt')return f.receipt;if(method==='eth_getBlockByNumber')return f.block;throw Error(method);}});feed.describe=async()=>({...f.pool,supply:evmContext.supply});
 const pair={address:EP,base:{address:E0,symbol:'TOKEN'},quote:{address:E1,symbol:'ETH'}},query={chain:'robinhood',pair,...evmContext};const first=await feed.read(query);assert.equal(first.trades.length,1);const filter=requests.find(x=>x[0]==='eth_getLogs')[1][0];assert.equal(filter.address,EP);assert.equal(filter.toBlock,'0x65');assert.equal(filter.fromBlock,'0x0');
 time+=1001;await feed.read(query);assert.equal(requests.filter(x=>x[0]==='eth_getTransactionReceipt').length,1);
 logs=[];time+=1001;assert.equal((await feed.read(query)).trades.length,0);
});
test('unsupported pools are explicit and separately cached from supported markets',async()=>{
 let calls=0;const feed=new LiveMarketTrades({rpc:async()=>{throw Error('no RPC');}});feed.describe=async()=>{calls++;throw Object.assign(Error('Unsupported pool program.'),{unsupported:true});};
 const query={chain:'solana',pair:solPair,tokenAddress:A},a=await feed.read(query);assert.equal(a.unsupported,true);assert.equal(a.trades.length,0);assert.equal(a.refreshMs,60000);await feed.read(query);assert.equal(calls,1);await feed.read({...query,pair:{...solPair,address:pk(9)}});assert.equal(calls,2);feed.close();assert.equal(feed.feeds.size,0);
});
test('missing RPC configuration returns a sanitized connection hint with a bounded retry',async()=>{
 const feed=new LiveMarketTrades({rpc:async()=>{throw Object.assign(Error('do not echo credentials'),{statusCode:428,connectionRequired:true});}});
 const result=await feed.read({chain:'solana',pair:solPair,tokenAddress:A});assert.equal(result.connectionRequired,true);assert.equal(result.refreshMs,60000);assert.match(result.warning,/Account → Connections/);assert(!result.warning.includes('credentials'));
});
test('a failed detail batch waits for all active reads and stops starting further reads before releasing its pending slot',async()=>{
 let active=0,reads=0;const feed=new LiveMarketTrades({rpc:async(chain,method,params)=>{if(method==='getSignaturesForAddress')return Array.from({length:10},(_,i)=>({signature:'sig'+i}));active++;reads++;try{if(params[0]==='sig0')throw Error('RPC failure');await new Promise(resolve=>setTimeout(resolve,20));return solTx(params[0]);}finally{active--;}}});feed.describe=async()=>solPool;
 const result=await feed.read({chain:'solana',pair:solPair,...context});assert.equal(active,0);assert.equal(reads,3);assert.match(result.warning,/temporarily unavailable/);assert.equal([...feed.feeds.values()][0].pending,null);
});

test('V4 descriptor resolves the selected pool ID rather than choosing another market with the same tokens',async()=>{
 const selected={currency0:E0,currency1:E1,fee:3000,tickSpacing:60,hooks:'0x'+'00'.repeat(20)},other={...selected,fee:500,tickSpacing:10},id=poolId(selected);
 const initialize=p=>({address:CONTRACTS.poolManager,topics:encodeEventTopics({abi:poolAbi,eventName:'Initialize',args:{id:poolId(p),currency0:E0,currency1:E1}}),data:encodeAbiParameters(parseAbiParameters('uint24,int24,address,uint160,int24'),[p.fee,p.tickSpacing,p.hooks,1n,0])});
 const requests=[],feed=new LiveMarketTrades({rpc:async(chain,method,params)=>{requests.push([method,params]);if(method==='eth_getLogs')return[initialize(other),initialize(selected)];if(method==='eth_call'){const call=params[0];if(call.data==='0x313ce567')return encodeAbiParameters(parseAbiParameters('uint8'),[call.to.toLowerCase()===E0?6:18]);if(call.data==='0x18160ddd')return encodeAbiParameters(parseAbiParameters('uint256'),[100000000000000n]);}throw Error('Unexpected discovery RPC');}});
 const descriptor=await feed.describe('robinhood',{address:id,base:{address:E0},quote:{address:E1}},E0);assert.equal(descriptor.id,id);assert.equal(descriptor.fee,3000);assert.deepEqual(descriptor.mints,[E0,E1]);assert.equal(requests[0][1][0].topics[1],id);
});

test('quiet EVM pools scan recent history and bounded older windows without deleting earlier indexed rows',async()=>{
 const f=evmFixture(),ranges=[];let time=1000,head=10000n;f.log.blockNumber='0x1770';
 const feed=new LiveMarketTrades({now:()=>time,rpc:async(chain,method,params)=>{if(method==='eth_blockNumber')return'0x'+head.toString(16);if(method==='eth_getLogs'){const query=params[0];ranges.push(query);return BigInt(query.fromBlock)<=6000n&&BigInt(query.toBlock)>=6000n?[f.log]:[];}if(method==='eth_getTransactionReceipt')return f.receipt;if(method==='eth_getBlockByNumber')return f.block;throw Error(method);}});feed.describe=async()=>f.pool;
 const query={chain:'robinhood',pair:{address:EP,base:{address:E0},quote:{address:E1}},...evmContext};
 const first=await feed.read(query);assert.equal(first.trades.length,0);assert.match(first.warning,/older confirmed/);assert.equal(BigInt(ranges[0].toBlock)-BigInt(ranges[0].fromBlock),2048n);
 time+=1001;head++;const second=await feed.read(query);assert.equal(second.trades.length,1);assert.equal(second.trades[0].blockNumber,6000);assert.equal(ranges.length,3);
 time+=1001;head++;assert.equal((await feed.read(query)).trades.length,1,'a recent empty scan does not remove older history');
});

test('explorer pool verification preserves fast polling when only historical RPC discovery is restricted',async()=>{
 const f=evmFixture();let described=0,now=1000;
 const feed=new LiveMarketTrades({now:()=>now,explorer:async()=>({items:[]}),rpc:async(chain,method)=>{if(method==='eth_blockNumber')return'0x66';if(method==='eth_getLogs')return[f.log];if(method==='eth_getTransactionReceipt')return f.receipt;if(method==='eth_getBlockByNumber')return f.block;throw Error(method);}});
 feed.describe=async()=>{throw Error('Historical block range is unavailable');};feed.describeExplorer=async()=>{described++;return f.pool;};
 const result=await feed.read({chain:'robinhood',pair:{address:EP,base:{address:E0},quote:{address:E1}},...evmContext});assert.equal(result.trades.length,1);assert.equal(result.refreshMs,1000);assert.equal(result.rpcUnavailable,undefined);assert.match(result.source,/Confirmed onchain/);assert(described>=1);
 now+=1001;assert.equal((await feed.read({chain:'robinhood',pair:{address:EP,base:{address:E0},quote:{address:E1}},...evmContext})).refreshMs,1000);
 now+=300001;const renewed=await feed.read({chain:'robinhood',pair:{address:EP,base:{address:E0},quote:{address:E1}},...evmContext});assert.equal(renewed.refreshMs,1000);assert.equal(renewed.indexed,undefined,'descriptor expiry still recovers fast RPC reads');
});

test('explorer and RPC rows share canonical identities and explorer rows require confirmed matching receipts',()=>{
 const f=evmFixture(),raw={address:{hash:EP.toUpperCase().replace('0X','0x')},topics:[...f.log.topics,null],data:f.log.data,transaction_hash:HASH.toUpperCase().replace('0X','0x'),block_hash:BLOCK,block_number:100,index:1,block_timestamp:new Date(Number(BigInt(f.block.timestamp))*1000).toISOString()},tx={hash:HASH,status:'ok',block_number:100,confirmations:2,timestamp:raw.block_timestamp,from:{hash:EU},gas_used:'21000',gas_price:'1000000000',fee:{type:'actual',value:'21000000000000'}};
 const row=decodeExplorerPoolSwap(raw,f.pool,tx,evmContext);assert(row);assert.equal(row.id,decodeEvmPoolSwap(f.log,f.pool,f.receipt,f.block,evmContext).id);assert.equal(row.signature,HASH);assert.equal(row.gasNative,'0.000021');
 assert.equal(decodeExplorerPoolSwap(raw,f.pool,{...tx,fee:{type:'actual',value:'12345'}},evmContext).gasNative,'0.000000000000012345');
 for(const mutate of [t=>t.status='error',t=>t.confirmations=0,t=>t.hash=BLOCK,t=>t.block_number=99,t=>t.block_hash=HASH,t=>t.timestamp='2020-01-01T00:00:00Z',t=>t.fee.type='maximum']){const bad=structuredClone(tx);mutate(bad);assert.equal(decodeExplorerPoolSwap(raw,f.pool,bad,evmContext),null);}
});
