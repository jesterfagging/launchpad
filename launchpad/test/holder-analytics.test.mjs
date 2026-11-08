import test from 'node:test';
import assert from 'node:assert/strict';
import { rawAmount, supplyPercent, heliusHolderHistory, blockscoutHolderHistory, blockscoutNativeDelta } from '../src/holder-analytics.mjs';
const SOL='So11111111111111111111111111111111111111112',USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',mint='58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',wallet='11111111111111111111111111111111';
const leg=(mint,amount,userAccount=wallet)=>({mint,userAccount,rawTokenAmount:{tokenAmount:String(amount),decimals:6}});
const swap=(signature,inputs,outputs,extra={})=>({signature,type:'SWAP',timestamp:1000,events:{swap:{tokenInputs:inputs,tokenOutputs:outputs}},...extra});
test('supply fractions preserve large integer precision and invalid supplies stay unknown',()=>{
  assert.equal(rawAmount('1234567890000000000000000',18),'1234567.89');
  assert.equal(supplyPercent('999999999999999999999999','1000000000000000000000000'),99.99999999);
  assert.equal(supplyPercent('1','0'),null);assert.equal(supplyPercent('11','10'),null);assert.equal(supplyPercent('1e9','100'),null);
  assert.equal(rawAmount('42',-1),null);assert.equal(rawAmount('42',37),null);assert.equal(rawAmount(42,6),null);
});
test('Helius history weights actual quote entry/exit by tokens without repricing history in current USD',()=>{
  const records=[swap('a',[leg(USDC,2000000)],[leg(mint,10000000)]),swap('b',[leg(USDC,8000000)],[leg(mint,20000000)]),swap('c',[leg(mint,5000000)],[leg(USDC,4000000)])];
  const result=heliusHolderHistory(records,mint,wallet,2000000);
  assert.deepEqual(result.bought,{tokens:30,usd:null,count:2});assert.deepEqual(result.sold,{tokens:5,usd:null,count:1});
  assert.deepEqual(result.quotes,[{mint:USDC,symbol:'USDC',bought:10,sold:4,averageEntry:10/30,averageExit:.8}]);
  assert.equal(result.pnl,null);assert.equal(result.coverage.complete,false);assert.equal(result.coverage.from,1000000);
});
test('Helius transfers, failed transactions, duplicate signatures and other-wallet swaps never count as buys',()=>{
  const buy=swap('buy',[leg(USDC,1000000)],[leg(mint,2000000)]);
  const records=[buy,buy,{...buy,signature:'transfer',type:'TRANSFER'}, {...buy,signature:'failed',transactionError:{error:'fail'}},swap('other',[leg(USDC,1000000,SOL)],[leg(mint,2000000,SOL)]),swap('bundle',[leg(USDC,1000000)],[leg(mint,2000000),leg(SOL,3000000)])];
  const result=heliusHolderHistory(records,mint,wallet,2000000);assert.equal(result.bought.count,1);assert.equal(result.bought.tokens,2);
});
test('Helius native SOL legs are priced in SOL and mixed quote assets are never averaged together',()=>{
  const native=swap('sol',[],[leg(mint,5000000)]);native.events.swap.nativeInput={account:wallet,amount:2000000000};
  const result=heliusHolderHistory([native,swap('usdc',[leg(USDC,15000000)],[leg(mint,5000000)])],mint,wallet,1);
  assert.equal(result.bought.tokens,10);assert.equal(result.quotes.length,2);assert.equal(result.quotes[0].averageEntry,.4);assert.equal(result.quotes[1].averageEntry,3);assert.equal(result.bought.usd,null);
});
const evmToken='0x1111111111111111111111111111111111111111',evmQuote='0x2222222222222222222222222222222222222222',evmWallet='0x3333333333333333333333333333333333333333',pool='0x4444444444444444444444444444444444444444';
const transfer=(mint,value,from,to,index=0)=>({transaction_hash:`0x${'a'.repeat(64)}`,log_index:index,from:{hash:from},to:{hash:to},token:{address_hash:mint,type:'ERC-20',symbol:mint===evmQuote?'USDG':'TOKEN'},total:{value,decimals:'6'},timestamp:'2026-01-01T00:00:00Z'});
const tx=()=>({hash:`0x${'a'.repeat(64)}`,status:'ok',from:{hash:evmWallet},token_transfers_overflow:false,value:'0',actions:[{type:'swap',protocol:'uniswap_v3'}],token_transfers:[transfer(evmToken,'10000000',pool,evmWallet,1),transfer(evmQuote,'20000000',evmWallet,pool,2)]});
test('Blockscout swaps require decoded swap actions and complete net token movements',()=>{
  const t=tx(),result=blockscoutHolderHistory(t.token_transfers,[t],evmToken,evmWallet,10);
  assert.deepEqual(result.bought,{tokens:10,usd:null,count:1});assert.equal(result.quotes[0].averageEntry,2);assert.equal(result.quotes[0].symbol,'USDG');assert.equal(result.pnl,null);
});
test('Blockscout transfer-only activity does not become a zero-cost buy or a realized gain',()=>{
  for(const patch of [{actions:[]},{token_transfers_overflow:true},{status:'error'},{value:'10000'},{from:{hash:pool}},{actions:[{type:'add_liquidity'}]}]){
    const t={...tx(),...patch},result=blockscoutHolderHistory(t.token_transfers,[t],evmToken,evmWallet,10);
    assert.equal(result.available,false);assert.equal(result.bought.tokens,null);assert.equal(result.bought.count,null);assert.deepEqual(result.transferred,{in:10,out:0,count:1});
  }
});
test('Blockscout swap aggregation deduplicates and rejects mixed positive inflows and malformed amounts',()=>{
  const good=tx(),result=blockscoutHolderHistory([...good.token_transfers,...good.token_transfers],[good,good],evmToken,evmWallet,10);assert.equal(result.bought.count,1);assert.equal(result.transferred.in,10);
  const malformed=tx();malformed.token_transfers[1].total.value='1e10';assert.equal(blockscoutHolderHistory([], [malformed],evmToken,evmWallet,10).available,false);
  const bothIn=tx();bothIn.token_transfers[1].from.hash=pool;bothIn.token_transfers[1].to.hash=evmWallet;assert.equal(blockscoutHolderHistory([], [bothIn],evmToken,evmWallet,10).available,false);
});
const trace=(from,to,value,traceAddress=[],subtraces=0,callType='call')=>({type:'call',action:{from,to,value,callType},traceAddress,subtraces});
test('native ETH buys subtract refunds and exclude delegatecall inherited value and gas',()=>{
  const t={...tx(),to:{hash:pool},value:'2000000000000000000',token_transfers:[transfer(evmToken,'10000000',pool,evmWallet,1)]};
  t.raw_trace=[trace(evmWallet,pool,'0x1bc16d674ec80000',[],2),trace(pool,pool,'0x1bc16d674ec80000',[0],0,'delegatecall'),trace(pool,evmWallet,'500000000000000000',[1])];
  assert.equal(blockscoutNativeDelta(t,evmWallet),'-1500000000000000000');
  const result=blockscoutHolderHistory(t.token_transfers,[t],evmToken,evmWallet,10);
  assert.equal(result.bought.tokens,10);assert.equal(result.quotes[0].symbol,'ETH');assert.equal(result.quotes[0].bought,1.5);assert.equal(result.quotes[0].averageEntry,.15);assert.equal(result.bought.usd,null);assert.equal(result.pnl,null);
});
test('native ETH sales need a complete successful trace and may have zero transaction value',()=>{
  const t={...tx(),to:{hash:pool},token_transfers:[transfer(evmToken,'10000000',evmWallet,pool,1)]};
  t.raw_trace=[trace(evmWallet,pool,'0',[],1),trace(pool,evmWallet,'3000000000000000000',[0])];
  assert.equal(blockscoutNativeDelta(t,evmWallet),'3000000000000000000');
  const result=blockscoutHolderHistory(t.token_transfers,[t],evmToken,evmWallet,10);assert.equal(result.sold.tokens,10);assert.equal(result.quotes[0].sold,3);assert.equal(result.quotes[0].averageExit,.3);
  for(const raw_trace of [[],[t.raw_trace[0]], [...t.raw_trace,t.raw_trace[1]], [t.raw_trace[0],{...t.raw_trace[1],error:'Reverted'}],[{...t.raw_trace[0],action:{...t.raw_trace[0].action,value:'1'}},t.raw_trace[1]]]){
    const bad={...t,raw_trace};assert.equal(blockscoutNativeDelta(bad,evmWallet),null);assert.equal(blockscoutHolderHistory([], [bad],evmToken,evmWallet,10).available,false);
  }
});
test('undecoded explorer swaps require verified evidence matching both actual wallet legs',()=>{
  const t={...tx(),actions:[],relaySwapEvidence:{quoteMint:evmQuote,tokenAmount:'10',quoteAmount:'20',side:'buy'}};
  assert.equal(blockscoutHolderHistory([], [t],evmToken,evmWallet,10).bought.tokens,10);
  for(const patch of [{quoteAmount:'21'},{tokenAmount:'11'},{quoteMint:pool},{side:'sell'}])assert.equal(blockscoutHolderHistory([], [{...t,relaySwapEvidence:{...t.relaySwapEvidence,...patch}}],evmToken,evmWallet,10).available,false);
  assert.equal(blockscoutHolderHistory([], [{...t,actions:[{type:'mint'}]}],evmToken,evmWallet,10).available,false);
});
