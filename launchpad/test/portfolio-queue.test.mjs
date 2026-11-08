import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { PortfolioEngine } from '../src/portfolio.mjs';
import { portfolioConfig, planInventory } from '../src/portfolio-plan.mjs';
import { resolvedStrategy } from '../public/strategy-settings.mjs';
import { SOL } from '../src/core.mjs';
import { config, key1, mint, build } from './fixtures.mjs';

async function queuedSwap(kind, removedFunds=false) {
  const book={data:{lots:[],pending:[],events:[],seen:[],trades:0},save:async()=>{},addEvent(e){this.data.events.push(e);}},e=new PortfolioEngine({live:book,paper:book});
  const strategy=resolvedStrategy({baseMint:mint,quoteMint:SOL,budgetSol:'1'});
  e.c=portfolioConfig(config({mode:'live',strategy}),'market');e.kind=kind;e.ledger=book;e.accepting=true;e.abort=new AbortController();
  e.prices={[SOL]:100000000000000n,[mint]:1000000000000n};e.pricesAt=Date.now();e.decimals={[SOL]:9,[mint]:6};
  const r={id:'allocation',kind,wallet:key1.publicKey.toBase58(),walletLabel:'Wallet',baseMint:mint,quoteMint:SOL,budget:'1000000000',cashReserve:'300000000',tokens:{[SOL]:'1000000000'},initialized:false,initialValue:'100000000000000',fees:'0',turnover:'0',failures:0,day:e.day(),strategy};
  book.data.lots.push(r);e.activeIds=new Set([r.id]);let quoted=false,checksAfterQuote=0,submitted=null;
  e.p={closed:false,jitoTips:[],balance:async()=>{if(quoted)checksAfterQuote++;return quoted&&removedFunds?0n:2000000000n;},jupiterBuild:async(order,w)=>{await delay(150);quoted=true;return{...build(order,w),outAmount:'35000000',otherAmountThreshold:'34500000',routeName:'Jupiter'};}};
  e.sendPrepared=async(_r,_w,order,tx)=>{assert(tx.message);submitted=order;};
  await e.executeSwap(r,e.c.wallets[0],planInventory(r,strategy,e.prices,e.decimals));return{r,book,submitted,checksAfterQuote};
}
test('MM and LP inventory routes can wait unsigned, then use a fresh quote window and fresh balances',async()=>{
  for(const kind of ['market','liquidity']){const h=await queuedSwap(kind);assert(h.submitted,JSON.stringify(h.book.data.events));assert(h.submitted.receivedAt-h.submitted.requestedAt>=100);assert.equal(h.submitted.signalSource,'strategy');assert(h.checksAfterQuote>0);assert.equal(h.r.failures,0);}
});
test('funds removed while MM or LP waits for a route cannot reach transaction signing',async()=>{
  for(const kind of ['market','liquidity']){const h=await queuedSwap(kind,true);assert.equal(h.submitted,null);assert(h.checksAfterQuote>0);assert(h.book.data.events.some(e=>/balance.*allocation/.test(e.message)));}
});
test('a strategy price reference that expires during simulation prevents signing and journaling',async()=>{
  const book={data:{lots:[],pending:[],events:[]}},e=new PortfolioEngine({live:book,paper:book});e.c=portfolioConfig(config({mode:'live',strategy:resolvedStrategy({baseMint:mint,quoteMint:SOL,budgetSol:'1'})}),'market');e.ledger=book;e.accepting=true;e.abort=new AbortController();
  const r={tokens:{[SOL]:'1000000000'}},order={kind:'rebalance',receivedAt:Date.now(),routeQuotedAt:Date.now(),priceExpiresAt:Date.now()+60000};let signed=false;
  const tx={serialize:()=>new Uint8Array([1]),sign(){signed=true;}};
  e.p={balance:async()=>1000000000n,rpc:async()=>{order.priceExpiresAt=Date.now()-1;return{value:{err:null,accounts:[{lamports:999995000}]}};}};
  await assert.rejects(e.sendPrepared(r,e.c.wallets[0],order,tx,1000,[]),/quote expired/);assert.equal(signed,false);assert.equal(book.data.pending.length,0);
});
