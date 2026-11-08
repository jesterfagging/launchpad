import test from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { launchInput,SOL_MINT } from '../public/launchpad-model.mjs';
import { invertDeveloperBudget,MAX_DEVELOPER_BUY_RAW } from '../src/launchpad-buy.mjs';
import liquiditySdks from '../src/liquidity-sdks.cjs';

const raw=extra=>({name:'Test token',symbol:'TEST',feeMode:'creator',quoteMint:SOL_MINT,...extra});
const pad=amount=>(amount*101n+99n)/100n;
test('developer buy accepts arbitrary SOL decimals down to one lamport without a supply-percentage minimum',()=>{
 for(const [value,lamports]of [['.01','10000000'],['0.000000001','1'],['1.234567891','1234567891'],['','0'],['0','0']]){
   const input=launchInput(raw({devBuySol:value}));assert.equal(input.devBuyMode,'sol');assert.equal(input.devBuyLamports,lamports);assert.equal(input.devBuyRaw,'0');assert.equal(input.devBuyBps,0);
 }
 assert.equal(launchInput(raw({devBuySol:'.01'})).devBuySol,'0.01');assert.equal(launchInput(raw({})).devBuyMode,'sol');
 for(const value of ['-0.01','0.0000000001','1e-2','NaN','Infinity','18446744074'])assert.throws(()=>launchInput(raw({devBuySol:value})),/Developer buy/);
});
test('explicit legacy percent requests remain compatible while new SOL input takes precedence',()=>{
 const old=launchInput(raw({devBuyPercent:'10'}));assert.equal(old.devBuyMode,'percent');assert.equal(old.devBuyBps,1000);assert.equal(old.devBuyRaw,MAX_DEVELOPER_BUY_RAW.toString());
 assert.throws(()=>launchInput(raw({devBuyPercent:'10.01'})),/10%/);
 const current=launchInput(raw({devBuySol:'0.01',devBuyPercent:'999'}));assert.equal(current.devBuyMode,'sol');assert.equal(current.devBuyLamports,'10000000');assert.equal(current.devBuyRaw,'0');
});
test('integer budget inversion includes the 1% allowance inside the budget and uses the largest affordable token amount',()=>{
 const cost=gross=>gross*2n,result=invertDeveloperBudget({quoteBudget:10000000n,quoteCost:cost});
 assert.equal(result.gross,'4950495');assert.equal(result.net,result.gross);assert.equal(result.maxQuote,'10000000');assert.equal(result.estimatedQuote,'9900990');
 assert(BigInt(result.maxQuote)<=10000000n);assert(pad(cost(BigInt(result.gross)+1n))>10000000n);
});
test('tax reduces received supply without increasing SOL spend or bypassing the gross 100M cap',()=>{
 const cost=gross=>gross*2n,budget=pad(cost(MAX_DEVELOPER_BUY_RAW));
 const result=invertDeveloperBudget({quoteBudget:budget,quoteCost:cost,taxBps:300});assert.equal(result.gross,MAX_DEVELOPER_BUY_RAW.toString());assert.equal(result.net,'97000000000000');assert.equal(BigInt(result.maxQuote),budget);
 assert.throws(()=>invertDeveloperBudget({quoteBudget:budget+1n,quoteCost:cost,taxBps:300}),error=>error.code==='DEV_BUY_SUPPLY_CAP'&&error.maxQuoteBudget===budget.toString()&&error.maxGross===MAX_DEVELOPER_BUY_RAW.toString());
});
test('a non-SOL route minimum output can directly bound pairing-token spend, independent of any USD oracle',()=>{
 const quoteMinimum=123456n,cost=gross=>(gross*7n+10n)/11n;
 const result=invertDeveloperBudget({quoteBudget:quoteMinimum,quoteCost:cost,taxBps:500});
 assert(BigInt(result.maxQuote)<=quoteMinimum);assert(pad(cost(BigInt(result.gross)+1n))>quoteMinimum);assert.equal(BigInt(result.net),BigInt(result.gross)-(BigInt(result.gross)*500n+9999n)/10000n);
});
test('actual installed Raydium curve and creator/protocol fees produce a bounded 0.01 SOL buy at raw-token precision',()=>{
 const ray=liquiditySdks.raydium(),poolInfo={virtualA:new BN('1000000000000000'),virtualB:new BN('200000000000'),realA:new BN(0),realB:new BN(0)};
 const cost=gross=>BigInt(ray.Launchpad.calculatePreFee({postFeeAmount:ray.Launchpad.getCurve(0).buyExactOut({poolInfo,amount:new BN(gross.toString())}),feeRate:new BN(5000)}).toString());
 const result=invertDeveloperBudget({quoteBudget:10000000n,quoteCost:cost,taxBps:300});
 assert(BigInt(result.gross)>0n);assert(BigInt(result.gross)<1000000000000n,'0.01 SOL must not force the former 0.1% / 1M-token UI minimum');assert(BigInt(result.maxQuote)<=10000000n);assert(pad(cost(BigInt(result.gross)+1n))>10000000n);assert(BigInt(result.net)<BigInt(result.gross));
});
test('zero buys skip price reads and tiny, invalid or unsafe budgets fail without an invented fill',()=>{
 const zero=invertDeveloperBudget({quoteBudget:0n,quoteCost:()=>{throw Error('must not price zero');}});assert.equal(zero.gross,'0');assert.equal(zero.maxQuote,'0');
 assert.throws(()=>invertDeveloperBudget({quoteBudget:1n,quoteCost:g=>g*2n}),/too small/);
 assert.throws(()=>invertDeveloperBudget({quoteBudget:2n,quoteCost:g=>g,taxBps:500}),/too small/);
 for(const budget of [-1n,18446744073709551616n,Number.MAX_SAFE_INTEGER+1,'garbage'])assert.throws(()=>invertDeveloperBudget({quoteBudget:budget,quoteCost:g=>g}),/invalid budget/);
 for(const bad of [{taxBps:10000},{taxBps:-1},{slippageBps:1001},{slippageBps:.5},{maxGross:MAX_DEVELOPER_BUY_RAW+1n}])assert.throws(()=>invertDeveloperBudget({quoteBudget:2n,quoteCost:g=>g,...bad}));
 assert.throws(()=>invertDeveloperBudget({quoteBudget:2n,quoteCost:()=>0n}),/invalid price/);
});
test('monotone rounded prices preserve the maximum-spend invariant across small budgets and tax rates',()=>{
 const cost=gross=>(gross*17n+22n)/23n;
 for(let budget=10n;budget<500n;budget+=7n)for(const taxBps of [0,1,300,500]){
   const result=invertDeveloperBudget({quoteBudget:budget,quoteCost:cost,taxBps,maxGross:10000n});
   assert(BigInt(result.maxQuote)<=budget);assert(pad(cost(BigInt(result.gross)+1n))>budget);assert(BigInt(result.net)>0n);assert(BigInt(result.net)<=BigInt(result.gross));
 }
});
