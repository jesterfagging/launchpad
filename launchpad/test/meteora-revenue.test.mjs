import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import {randomBytes} from 'node:crypto';
import bs58 from 'bs58';
import {meteoraTreasurySources,meteoraRevenueAnalyticsSources} from '../src/meteora-revenue-records.mjs';
import {protocolTreasurySources} from '../src/protocol-treasury.mjs';
import {AdminRevenue} from '../src/admin-revenue.mjs';
import {buildAdminRevenueAudit} from '../src/admin-revenue-audit.mjs';
import {SOL_MINT} from '../public/launchpad-model.mjs';
const address=()=>Keypair.generate().publicKey.toBase58(),signature=()=>bs58.encode(randomBytes(64));
function book(){
 const launch={mint:address(),creatorWallet:address(),partnerAuthority:address(),treasury:address(),quoteMint:address(),quoteSymbol:'STOCK',quoteDecimals:6};
 launch.creationFee={recipient:launch.treasury,lamports:'15000000'};
 const paid={action:'partner-payout',mint:launch.mint,wallet:launch.partnerAuthority,state:'finalized',signature:signature(),finalizedAt:100000,payouts:[{owner:launch.treasury,amount:'1234567'}],result:{slot:200,payout:{quoteDebitRaw:'1234567',recipients:[{owner:launch.treasury,amount:'1234567'}]}}};
 const created={action:'initialize',mint:launch.mint,wallet:launch.creatorWallet,state:'finalized',signature:signature(),finalizedAt:90000,result:{slot:199,creationFeeReceipt:{mint:SOL_MINT,decimals:9,amount:'15000000',recipient:launch.treasury,selfPayment:false}}};
 return {schemaVersion:1,launches:[launch],operations:[created,paid]};
}
test('Meteora treasury candidates contain only exact finalized outward payments, not custody claims or secrets',()=>{
 const data=book(),paid=data.operations[1];data.launches[0].keys={secret:'PRIVATE'};data.operations.push({...paid,action:'partner-claim',signature:signature(),bundle:{raw:'PRIVATE'}});
 const sources=meteoraTreasurySources(data);assert.equal(sources.length,2);assert.equal(sources[0].kind,'creation');assert.equal(sources[1].kind,'meteora-partner-payout');assert.equal(sources[1].amount,'1234567');assert.equal(sources[1].decimals,6);assert(!JSON.stringify(sources).includes('PRIVATE'));
 for(const change of [op=>op.state='confirmed',op=>op.result.slot=0,op=>op.finalizedAt=undefined,op=>op.wallet=address(),op=>op.payouts[0].owner=address(),op=>op.result.payout.recipients[0].owner=address(),op=>op.payouts[0].amount='1234568',op=>op.result.payout.quoteDebitRaw='18446744073709551616',op=>op.result.payout.recipients.push({...op.result.payout.recipients[0]})]){const bad=book();change(bad.operations[1]);assert.equal(meteoraTreasurySources(bad).length,1);}
});
test('creation payment projection requires the finalized exact amount and actual external recipient',()=>{
 for(const change of [op=>op.result.creationFeeReceipt.amount='15000001',op=>op.result.creationFeeReceipt.recipient=address(),op=>op.result.creationFeeReceipt.selfPayment=true,op=>op.wallet=address(),op=>op.result.creationFeeReceipt.decimals=6]){const data=book();change(data.operations[0]);assert.equal(meteoraTreasurySources(data).length,1);}
 const data=book();data.launches[0].creationFee.recipient=data.launches[0].creatorWallet;data.operations[0].result.creationFeeReceipt.recipient=data.launches[0].creatorWallet;assert.equal(meteoraTreasurySources(data).length,1);
});
test('a finalized protocol payout retains its journaled treasury after the configured destination changes',()=>{
 const data=book(),op=data.operations[1],original=data.launches[0].treasury,destination=address();op.protocolRecipient=destination;op.payouts[0].owner=destination;op.result.payout.recipients[0].owner=destination;
 const sources=meteoraTreasurySources(data);assert.equal(sources.length,2);assert.equal(sources[0].wallet,original);assert.equal(sources[1].wallet,destination);assert.equal(data.launches[0].treasury,original);
 const bad=structuredClone(data);bad.operations[1].protocolRecipient=address();assert.equal(meteoraTreasurySources(bad).length,1);
});
test('treasury global source identity deduplicates sources and rejects conflicting authority',()=>{
 const source=meteoraTreasurySources(book())[1];let merged=protocolTreasurySources([], [source,{...source,amount:'1234000'}]);assert.equal(merged.length,1);assert.equal(merged[0].amount,'1234000');
 assert.equal(protocolTreasurySources([], [source,{...source,sourceWallet:address()}]).length,0);
 const creation=meteoraTreasurySources(book())[0],ray={input:{route:'raydium',network:'mainnet-beta'},keys:{payer:{address:creation.sourceWallet}},operations:[{kind:'create',state:'confirmed',signature:creation.signature,creationFeeReceipt:{mint:SOL_MINT,decimals:9,recipient:creation.wallet,amount:creation.amount}}]};
 assert.equal(protocolTreasurySources([ray],[creation]).length,1);
});
test('admin revenue and audit count finalized treasury payouts once and preserve six-decimal assets',async()=>{
 const data=book(),source=meteoraTreasurySources(data),admin={id:'a'.repeat(32),role:'admin',mfaEnabled:true},accounts={list:async()=>[],get:async()=>admin,hostStore:{read:async(name,fallback)=>name==='launch-protocol-fees'?{recipient:data.launches[0].treasury,creationFeeSol:'0.015'}:fallback}};
 const revenue=new AdminRevenue({accounts,launchpad:{book:async()=>({launches:[]})},meteoraSources:async()=>[...source,...source],toolkit:false});
 const result=await revenue.read(admin.id),product=result.products.find(x=>x.id==='meteora');assert.equal(product.totals[0].grossAmount,'1234567');assert.equal(product.totals[0].paidAmount,'1234567');assert.equal(product.totals[0].pendingAmount,'0');assert.equal(product.totals[0].decimals,6);assert.equal(result.products.find(x=>x.id==='creation').totals[0].grossAmount,'15000000');
 const audit=buildAdminRevenueAudit({additionalSources:[...source,...source],savedPolicy:{recipient:data.launches[0].treasury,creationFeeSol:'0.015'}});assert.equal(audit.summary.meteoraReceipts,1);assert.equal(audit.transfers.length,2);
 const missing=new AdminRevenue({accounts,toolkit:false,meteoraSources:async()=>{throw Error('SECRET');}});const unavailable=await missing.read(admin.id);assert.equal(unavailable.products.find(x=>x.id==='meteora').status,'unavailable');assert(!JSON.stringify(unavailable).includes('SECRET'));
});

test('analytics revenue coverage detects missing finalized payouts and counters without changing treasury candidates',()=>{
 const original=book();original.launches[0].ledger={partnerPaid:'1234567'};original.launches[0].finalizedAt=90000;
 for(const change of [data=>data.historyTruncated=true,data=>data.operationsTruncated=true,data=>data.launches[0].historyTruncated=true,data=>data.launches[0].operationsTruncated=true,data=>data.launches[0].ledger.partnerPaid='999999999',data=>data.launches[0].ledger.partnerPaid='invalid',data=>data.operations[1].result.payout=undefined,data=>data.operations[1].signature='bad',data=>data.operations.splice(1,1),data=>data.operations.splice(0,1)]){
  const data=structuredClone(original);change(data);const before=structuredClone(data),expected=meteoraTreasurySources(data),out=meteoraRevenueAnalyticsSources(data);assert.equal(out.complete,false);assert.deepEqual(out.sources,expected);assert.deepEqual(data,before);
 }
 const out=meteoraRevenueAnalyticsSources(original);assert.equal(out.complete,true);assert.deepEqual(out.sources,meteoraTreasurySources(original));
});
test('analytics metadata deduplicates payout evidence and excludes creator claims, pending payouts and genuine zero/self creation fees',()=>{
 const data=book();data.launches[0].ledger={partnerPaid:'1234567'};data.operations.push(structuredClone(data.operations[1]),{...data.operations[1],state:'pending',signature:signature()},{...data.operations[1],action:'creator-claim',signature:signature()});
 assert.equal(meteoraRevenueAnalyticsSources(data).complete,true);data.launches[0].ledger.partnerPaid='2469134';assert.equal(meteoraRevenueAnalyticsSources(data).complete,false);
 for(const self of [false,true]){const value=book(),launch=value.launches[0];launch.finalizedAt=90000;launch.ledger={partnerPaid:'1234567'};if(self){launch.creationFee.recipient=launch.creatorWallet;value.operations[0].result.creationFeeReceipt.recipient=launch.creatorWallet;value.operations[0].result.creationFeeReceipt.selfPayment=true;}else{launch.creationFee.lamports='0';delete value.operations[0].result.creationFeeReceipt;}const out=meteoraRevenueAnalyticsSources(value);assert.equal(out.complete,true);assert.equal(out.sources.length,1);}
});
test('metadata callback takes precedence and incomplete Meteora revenue remains a known USD subtotal',async()=>{
 const data=book(),launch=data.launches[0],now=1800000000000,admin={id:'a'.repeat(32),role:'admin',mfaEnabled:true};launch.ledger={partnerPaid:'999999999'};
 const accounts={list:async()=>[],get:async()=>admin,hostStore:{read:async(name,fallback)=>name==='launch-protocol-fees'?{recipient:launch.treasury,creationFeeSol:'0.015'}:fallback}};
 const revenue=new AdminRevenue({accounts,toolkit:false,now:()=>now,meteoraSources:()=>assert.fail('metadata path must be preferred'),meteoraRevenueSources:async()=>meteoraRevenueAnalyticsSources(data)});
 const out=await revenue.readPublic({pricesByMint:new Map([[SOL_MINT,{usd:150,at:now}],[launch.quoteMint,{usd:2,at:now}]])});assert.equal(out.historyComplete,false);assert.equal(out.totalUsdEstimate,null);assert.equal(out.pricedUsdEstimate,4.719134);assert.equal(out.status,'partial');
 const detailed=await revenue.read(admin.id);assert.equal(detailed.products.find(row=>row.id==='meteora').totals[0].grossAmount,'1234567');assert.equal(detailed.products.find(row=>row.id==='creation').revenueComplete,false);
});
