import { Keypair } from '@solana/web3.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { rewardAnalyticsRecord, publicRewardAnalytics, holderRewardJournalAudit } from '../src/public-reward-analytics.mjs';

const NOW = 1_790_000_000_000;
const MINT = 'B'.repeat(32), OTHER = 'C'.repeat(32), SOL = 'So11111111111111111111111111111111111111112', USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const sig = n => '4'.repeat(70) + '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[n];
const op = (kind, n, amount, q, b, extra = {}) => ({ kind, state: 'confirmed', signature: sig(n), slot: 100 + n, createdAt: NOW - 100_000 + n, confirmedAt: NOW - 99_000 + n, operationId: `op-${n}`, ...(amount === undefined ? {} : {amount}), ...(q === undefined ? {} : {receipt:{quoteDelta:q,baseDelta:b}}), ...extra });
const create = () => op('create',0);
const launch = (mode, operations, extra = {}) => ({ input:{feeMode:mode, quoteMint:SOL}, keys:{mint:{address:MINT},wallet:{address:'private-fee-wallet',secret:'secret-key'}}, review:{quoteDecimals:9,quoteSymbol:'SOL',price:{usd:'1'}}, operations:[create(),...operations], userId:'private-user', raw:'secret-signed-bytes', ...extra });
const fact = (mode, operations, extra) => rewardAnalyticsRecord(launch(mode,operations,extra));
const pricesByMint = {[SOL]:{usd:'100',at:NOW,stale:false},[USDC]:{usd:'1',at:NOW,stale:false}};
const stats = (records, opts={}) => publicRewardAnalytics(records,{pricesByMint,now:NOW,...opts});
const payout = (n, amount, extra={}) => op('payout',n,amount,`-${amount}`,'0',{payouts:[{amount,wallet:'private-recipient'}],...extra});
const buy = (n=2,extra={}) => op('buy',n,'2000000000','-1500000000','1000000',extra);
const burn = (n=3,amount='1000000',extra={}) => op('burn',n,amount,'0',`-${amount}`,extra);

test('projects only aggregate facts and exposes no private or per-coin receipt identity',()=>{
  const record=rewardAnalyticsRecord(launch('holders',[payout(1,'2500000000')]));
  const projected=JSON.stringify(record), result=JSON.stringify(stats([record]));
  for(const forbidden of ['private-user','private-fee-wallet','secret-key','secret-signed-bytes','private-recipient']) assert.ok(!projected.includes(forbidden));
  assert.ok(!result.includes(sig(1)));assert.ok(!result.includes(MINT));assert.ok(!result.includes('op-1'));
  assert.equal(rewardAnalyticsRecord(launch('creator',[])),null);
});
test('sums confirmed exact sent holder amounts, including historic exact payout records',()=>{
  const result=stats([fact('holders',[payout(1,'2500000000'),payout(2,'1000000000',{receipt:undefined})])]);
  assert.equal(result.holders.distributed.usdEstimate,350);
  assert.equal(result.holders.distributed.quoteTotals[0].amount,'3.5');
  assert.equal(result.holders.distributedBasis,'quote_sent');assert.equal(result.holders.payments,2);
});
test('recovers an absent payout amount only from its saved confirmed receipt and exact recipient plan',()=>{
  const owner=Keypair.generate().publicKey.toBase58(), raw=launch('holders',[payout(1,'2500000000',{amount:undefined,payouts:[{owner,amount:'2500000000'}]})]);
  const before=structuredClone(raw), record=rewardAnalyticsRecord(raw), result=stats([record]);
  assert.deepEqual(raw,before);assert.equal(record.operations[1].amount,'2500000000');
  assert.equal(record.operations[1].amountSource,'saved-confirmed-receipt');
  assert.equal(result.holders.distributed.usdEstimate,250);assert.equal(result.holders.uniqueWallets,1);
  const audit=holderRewardJournalAudit([record])[0];
  assert.equal(audit.countedQuoteUnits,'2500000000');assert.equal(audit.recoveredPayoutAmounts,1);
  assert.equal(audit.details[0].signature,sig(1));assert.equal(audit.details[0].counted,true);
});
test('receipt recovery never replaces malformed or contradictory saved quantities',()=>{
  const owner=Keypair.generate().publicKey.toBase58();
  for(const extra of [{amount:'bad'},{amount:'0'},{amount:'1'},{amount:7},{amount:undefined,receipt:{quoteDelta:'-2499999999',baseDelta:'0'}},{amount:undefined,receipt:{quoteDelta:'-2500000000',baseDelta:'1'}}]) {
    const record=fact('holders',[payout(1,'2500000000',{payouts:[{owner,amount:'2500000000'}],...extra})]);
    assert.equal(record.operations[1].amountSource,undefined);assert.equal(stats([record]).holders.distributed.observedUsdEstimate,null);
  }
});
test('receipt recovery requires finalized identity and a complete distinct recipient plan',()=>{
  const owner=Keypair.generate().publicKey.toBase58();
  for(const extra of [{state:'pending'},{slot:0},{signature:'invalid'},{payouts:null},{payouts:[]},{payouts:[{owner,amount:'1'}]},{payouts:[{owner:'bad',amount:'2500000000'}]},{payouts:[{owner,amount:'1250000000'},{owner,amount:'1250000000'}]},{receipt:null}]) {
    const record=fact('holders',[payout(1,'2500000000',{amount:undefined,payouts:[{owner,amount:'2500000000'}],...extra})]);
    assert.equal(record.operations[1].amount,null);assert.equal(record.operations[1].amountSource,undefined);
  }
});
test('recovered and complete copies of the same payout deduplicate to one payment',()=>{
  const owner=Keypair.generate().publicKey.toBase58(), row=payout(1,'2500000000',{payouts:[{owner,amount:'2500000000'}]});
  const records=[fact('holders',[{...row,amount:undefined}]),fact('holders',[row])], result=stats(records);
  assert.equal(result.holders.distributed.usdEstimate,250);assert.equal(result.holders.payments,1);assert.equal(result.holders.uniqueWallets,1);
  assert.equal(holderRewardJournalAudit(records)[0].reasons.duplicate_signature,1);
});
test('diagnostic audit shares cross-launch signature and operation conflict exclusions',()=>{
  const a=fact('holders',[payout(1,'1000000000')]), b=fact('holders',[payout(1,'1000000000')],{keys:{mint:{address:OTHER}}});
  const rows=holderRewardJournalAudit([a,b]);
  assert.ok(rows.every(row=>row.countedQuoteUnits==='0'&&row.reasons.conflicting_signature===1));
  const reused=holderRewardJournalAudit([fact('holders',[payout(1,'1'),payout(2,'2',{operationId:'op-1'})])])[0];
  assert.equal(reused.countedQuoteUnits,'0');assert.equal(reused.reasons.conflicting_operation_id,2);
  assert.equal(holderRewardJournalAudit([a,b],{maxDetails:1}).reduce((sum,row)=>sum+row.details.length,0),1);
});

test('diagnostic audit includes bounded public transaction identities for ordinary counted payouts',()=>{
  const owner=Keypair.generate().publicKey.toBase58(),rows=[1,2,3].map(n=>payout(n,'1000000000',{payouts:[{owner,amount:'1000000000'}]}));
  const out=holderRewardJournalAudit([fact('holders',rows)],{maxDetails:2})[0];assert.equal(out.countedQuoteUnits,'3000000000');assert.equal(out.countedPayouts,3);assert.equal(out.reasons.confirmed_payout,3);assert.equal(out.details.length,2);assert.equal(out.omittedDetails,1);
  assert.deepEqual(out.details.map(row=>row.signature),[sig(1),sig(2)]);assert(out.details.every(row=>row.counted&&row.reason==='confirmed_payout'));assert(!JSON.stringify(out).includes(owner));
});
test('pending and failed payouts do not count or turn known zero into unknown',()=>{
  const result=stats([fact('holders',[payout(1,'2500000000',{state:'pending'}),payout(2,'1000000000',{state:'failed'})])]);
  assert.equal(result.holders.distributed.usdEstimate,0);assert.equal(result.holders.payments,0);
});
test('malformed confirmed payouts and contradictory receipts are excluded and mark subtotal',()=>{
  const result=stats([fact('holders',[payout(1,'1000000000'),payout(2,'2000000000',{receipt:{quoteDelta:'-1',baseDelta:'0'}}),payout(3,'7',{slot:0})])]);
  assert.equal(result.holders.distributed.usdEstimate,null);assert.equal(result.holders.distributed.observedUsdEstimate,100);
  assert.equal(result.holders.distributed.quoteTotals[0].amount,'1');assert.equal(result.holders.historyComplete,false);
});
test('recipient counts are unknown for missing payout breakdown but exact sent total survives',()=>{
  const result=stats([fact('holders',[payout(1,'1000000000',{payouts:undefined})])]);
  assert.equal(result.holders.distributed.usdEstimate,100);assert.equal(result.holders.payments,null);
});
test('a confirmed buy uses actual spending rather than authorized budget',()=>{
  const result=stats([fact('buyback',[buy()])]);
  assert.equal(result.agents.buybacks.usdEstimate,150);assert.equal(result.agents.boughtAndBurned.usdEstimate,0);
  assert.equal(result.agents.pendingBurnBuys,1);assert.equal(result.agents.completedBurns,0);
});
test('a fully reconciled confirmed buy and burn attributes actual purchase cost only once',()=>{
  const result=stats([fact('buyback',[buy(),burn()])]);
  assert.equal(result.agents.buybacks.usdEstimate,150);assert.equal(result.agents.boughtAndBurned.usdEstimate,150);
  assert.equal(result.agents.pendingBurnBuys,0);assert.equal(result.agents.completedBurns,1);
});
test('base tokens claimed as fees are burned but never counted as purchased USD',()=>{
  const result=stats([fact('buyback',[op('claim',1,undefined,'3000000000','500000'),buy(),burn(3,'1500000')])]);
  assert.equal(result.agents.boughtAndBurned.usdEstimate,150);
  const onlyClaim=stats([fact('buyback',[op('claim',1,undefined,'0','500000'),burn(3,'500000')])]);
  assert.equal(onlyClaim.agents.boughtAndBurned.usdEstimate,0);assert.equal(onlyClaim.agents.completedBurns,1);
});
test('pending and failed burns never inflate confirmed bought-and-burned amount',()=>{
  for(const state of ['pending','failed']) {
    const result=stats([fact('buyback',[buy(),burn(3,'1000000',{state})])]);
    assert.equal(result.agents.buybacks.usdEstimate,150);assert.equal(result.agents.boughtAndBurned.usdEstimate,0);
  }
});
test('partial burns and unknown claimed credits do not invent purchase-to-burn attribution',()=>{
  const partial=stats([fact('buyback',[buy(),burn(3,'500000')])]);
  assert.equal(partial.agents.boughtAndBurned.usdEstimate,null);assert.equal(partial.agents.boughtAndBurned.observedUsdEstimate,null);
  assert.equal(partial.agents.buybacks.usdEstimate,150);
  const unknown=stats([fact('buyback',[op('claim',1),buy(),burn()])]);
  assert.equal(unknown.agents.boughtAndBurned.usdEstimate,null);assert.equal(unknown.agents.buybacks.usdEstimate,150);
});
test('malformed buy receipts and missing burn receipts remain incomplete',()=>{
  const missing=stats([fact('buyback',[buy(2,{receipt:undefined}),burn()])]);
  assert.equal(missing.agents.buybacks.usdEstimate,null);assert.equal(missing.agents.buybacks.observedUsdEstimate,null);
  const budget=stats([fact('buyback',[buy(2,{amount:'1'})])]);assert.equal(budget.agents.buybacks.usdEstimate,null);
  const burnMissing=stats([fact('buyback',[buy(),burn(3,'1000000',{receipt:undefined})])]);
  assert.equal(burnMissing.agents.boughtAndBurned.usdEstimate,null);
});
test('duplicate migrated records and repeated signatures never double count',()=>{
  const record=fact('buyback',[buy(),burn()]);
  const result=stats([record,structuredClone(record)]);
  assert.equal(result.agents.coins,1);assert.equal(result.agents.buybacks.usdEstimate,150);assert.equal(result.agents.boughtAndBurned.usdEstimate,150);
  const holder=fact('holders',[payout(1,'1000000000'),payout(1,'1000000000')]);
  assert.equal(stats([holder,holder]).holders.distributed.usdEstimate,100);
});
test('conflicting reused signatures across mints are excluded globally',()=>{
  const a=fact('holders',[payout(1,'1000000000')]), b=fact('holders',[payout(1,'1000000000')],{keys:{mint:{address:OTHER}}});
  const result=stats([a,b]);
  assert.equal(result.holders.distributed.usdEstimate,null);assert.equal(result.holders.distributed.observedUsdEstimate,null);
  assert.ok(result.holders.distributed.quoteTotals.every(row=>row.amount===null&&row.usdEstimate===null&&row.coverage==='unavailable'));
});
test('different confirmed signatures sharing one operation ID are ambiguous, not double counted',()=>{
  const result=stats([fact('holders',[payout(1,'1000000000'),payout(2,'1000000000',{operationId:'op-1'})])]);
  assert.equal(result.holders.distributed.usdEstimate,null);assert.equal(result.holders.distributed.observedUsdEstimate,null);
});
test('truncated history shows observed holder and buyback subtotals, never a false lifetime total',()=>{
  const result=stats([fact('holders',[payout(1,'1000000000')],{historyTruncated:true}),fact('buyback',[buy(),burn()],{keys:{mint:{address:OTHER}},operationsTruncated:true})]);
  assert.equal(result.holders.distributed.usdEstimate,null);assert.equal(result.holders.distributed.observedUsdEstimate,100);
  assert.equal(result.agents.buybacks.usdEstimate,null);assert.equal(result.agents.buybacks.observedUsdEstimate,150);
  assert.equal(result.agents.boughtAndBurned.usdEstimate,null);
});
test('missing creation record and incomplete inventory cannot report false zero totals',()=>{
  const noCreation=rewardAnalyticsRecord(launch('holders',[],{operations:[]}));
  assert.equal(stats([noCreation]).holders.distributed.usdEstimate,null);
  assert.equal(stats([],{inventoryComplete:false}).holders.distributed.observedUsdEstimate,null);
  assert.equal(stats([]).holders.distributed.usdEstimate,0);
});
test('mixed native quote totals retain unpriced assets and label fresh price estimates',()=>{
  const sol=fact('holders',[payout(1,'1000000000')]);
  const usd=fact('holders',[op('create',4),payout(5,'5000000')],{keys:{mint:{address:OTHER}},input:{feeMode:'holders',quoteMint:USDC},review:{quoteDecimals:6,quoteSymbol:'USDC'},operations:[op('create',4),payout(5,'5000000')]});
  const result=stats([sol,usd],{pricesByMint:{[SOL]:pricesByMint[SOL]}}).holders.distributed;
  assert.equal(result.usdEstimate,null);assert.equal(result.observedUsdEstimate,100);assert.equal(result.unpricedQuoteAssets,1);
  assert.equal(result.quoteTotals.find(row=>row.symbol==='USDC').amount,'5');assert.equal(result.valuationBasis,'current_quote_prices');
  assert.equal(stats([sol,usd]).holders.distributed.usdEstimate,105);
});
test('stale, future, nonfinite and malformed price observations are not current USD',()=>{
  const record=fact('holders',[payout(1,'1000000000')]);
  for(const price of [{usd:100,at:NOW-120_001},{usd:100,at:NOW+1},{usd:100,at:NOW,stale:true},{usd:Infinity,at:NOW},{usd:'100USD',at:NOW},{usd:-1,at:NOW},{usd:true,at:NOW}]) {
    const metric=stats([record],{pricesByMint:{[SOL]:price}}).holders.distributed;
    assert.equal(metric.usdEstimate,null);assert.equal(metric.observedUsdEstimate,null);assert.equal(metric.quoteTotals[0].amount,'1');
  }
});
test('USD is not inferred from launch review price and token amounts are not summed across mints',()=>{
  const result=stats([fact('buyback',[buy(),burn()])],{pricesByMint:{}});
  assert.equal(result.agents.boughtAndBurned.usdEstimate,null);
  assert.equal(result.agents.boughtAndBurned.quoteTotals[0].amount,'1.5');
  assert.equal(result.agents.tokensBurned,undefined);assert.equal(result.agents.boughtAndBurned.tokensBurned,undefined);
});
test('conflicting quote metadata for the same mint cannot mix units into one subtotal',()=>{
  const first=fact('holders',[payout(1,'1000000000')]);
  const second=fact('holders',[payout(2,'5000000')],{input:{feeMode:'holders',quoteMint:USDC},review:{quoteDecimals:6,quoteSymbol:'USDC'}});
  const metric=stats([first,second]).holders.distributed;
  assert.equal(metric.usdEstimate,null);assert.equal(metric.observedUsdEstimate,null);assert.deepEqual(metric.quoteTotals,[]);
});
test('missing inventory argument value remains unknown rather than showing a zero total',()=>{
  assert.equal(stats(null).holders.distributed.usdEstimate,null);
  assert.equal(stats(null).agents.buybacks.observedUsdEstimate,null);
});
test('multiple buy and burn cycles retain the separate pending purchase balance',()=>{
  const result=stats([fact('buyback',[buy(1),burn(2),buy(3),burn(4),buy(5)])]);
  assert.equal(result.agents.buybacks.usdEstimate,450);assert.equal(result.agents.boughtAndBurned.usdEstimate,300);
  assert.equal(result.agents.completedBuys,3);assert.equal(result.agents.completedBurns,2);assert.equal(result.agents.pendingBurnBuys,1);
});

test('public quote totals omit arbitrary paired token addresses',()=>{
  const hidden='D'.repeat(32), record=fact('holders',[payout(1,'1000000000')],{input:{feeMode:'holders',quoteMint:hidden},review:{quoteDecimals:9,quoteSymbol:'PRIVATE'}});
  const result=stats([record],{pricesByMint:{[hidden]:{usd:2,at:NOW}}});assert.ok(!JSON.stringify(result).includes(hidden));assert.equal(result.holders.distributed.usdEstimate,2);
});

const walletA = Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey.toBase58();
const walletB = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey.toBase58();
const paid = (n, owner = walletA, extra = {}) => payout(n, '1000000000', { payouts: [{ owner, amount: '1000000000' }], ...extra });

test('wallet recipients are unique across cycles, duplicate records and different holder coins', () => {
  const a = fact('holders', [paid(1), paid(2)]);
  const b = fact('holders', [], { keys: { mint: { address: OTHER } }, operations: [op('create', 3), paid(4), paid(5, walletB)] });
  const result = stats([a, a, b]);
  assert.equal(result.holders.uniqueWallets, 2); assert.equal(result.holders.payments, 4);
  assert.equal(result.holders.walletsComplete, true); assert.equal(result.holders.observedUniqueWallets, 2);
  for (const address of [walletA, walletB]) assert.ok(!JSON.stringify(a).includes(address) && !JSON.stringify(result).includes(address));
  assert.ok(!JSON.stringify(result).includes(a.operations[1].payouts[0].recipient));
});
test('only confirmed validated holder payouts count toward unique paid wallets', () => {
  const result = stats([fact('holders', [paid(1), paid(2, walletB, { state: 'pending' }), paid(3, walletB, { state: 'failed' })])]);
  assert.equal(result.holders.uniqueWallets, 1); assert.equal(result.holders.payments, 1);
  const contradiction = stats([fact('holders', [paid(1), paid(2, walletB, { receipt: { quoteDelta: '-1', baseDelta: '0' } })])]);
  assert.equal(contradiction.holders.uniqueWallets, null); assert.equal(contradiction.holders.observedUniqueWallets, 1);
});
test('missing recipient identities preserve monetary totals while labelling only observed wallet subtotal', () => {
  const result = stats([fact('holders', [paid(1), payout(2, '1000000000')])]);
  assert.equal(result.holders.uniqueWallets, null); assert.equal(result.holders.observedUniqueWallets, 1);
  assert.equal(result.holders.distributed.usdEstimate, 200); assert.equal(result.holders.walletsComplete, false);
  const none = stats([fact('holders', [payout(1, '1000000000')])]);
  assert.equal(none.holders.observedUniqueWallets, null);
});
test('invalid payout totals and recipient disagreements cannot inflate distinct wallet count', () => {
  const a = fact('holders', [paid(1)]), contradictory = fact('holders', [paid(1, walletB)]);
  const conflict = stats([a, contradictory]);
  assert.equal(conflict.holders.uniqueWallets, null); assert.equal(conflict.holders.observedUniqueWallets, null);
  const badRows = stats([fact('holders', [paid(1, walletA, { payouts: [{ owner: walletA, amount: '2000000000' }] })])]);
  assert.equal(badRows.holders.uniqueWallets, null); assert.equal(badRows.holders.observedUniqueWallets, null);
});
test('known empty holder history reports zero wallets while missing inventory remains unknown', () => {
  assert.equal(stats([]).holders.uniqueWallets, 0); assert.equal(stats([fact('holders', [])]).holders.uniqueWallets, 0);
  assert.equal(stats([], { inventoryComplete: false }).holders.uniqueWallets, null);
  assert.equal(stats([], { inventoryComplete: false }).holders.observedUniqueWallets, null);
  const partial = stats([fact('holders', [paid(1)], { historyTruncated: true })]);
  assert.equal(partial.holders.uniqueWallets, null); assert.equal(partial.holders.observedUniqueWallets, 1);
});

test('unknown per-asset payout history never becomes a zero amount or zero USD estimate',()=>{
  for(const record of [
    fact('holders',[],{historyTruncated:true}),
    rewardAnalyticsRecord(launch('holders',[],{operations:[]})),
    fact('holders',[payout(1,'1000000000',{receipt:{quoteDelta:'-1',baseDelta:'0'}})]),
  ]){
    const metric=stats([record]).holders.distributed,row=metric.quoteTotals[0];
    assert.equal(row.amount,null);assert.equal(row.usdEstimate,null);assert.equal(row.priceAt,null);assert.equal(row.historyComplete,false);assert.equal(row.coverage,'unavailable');assert.equal(metric.usdEstimate,null);assert.equal(metric.observedUsdEstimate,null);
  }
  const row=stats([fact('holders',[])],{inventoryComplete:false}).holders.distributed.quoteTotals[0];assert.equal(row.amount,null);assert.equal(row.coverage,'unavailable');
});

test('each paired asset preserves its own complete zero, confirmed subtotal and unavailable USD price',()=>{
  const completeZero=fact('holders',[],{input:{feeMode:'holders',quoteMint:USDC},review:{quoteDecimals:6,quoteSymbol:'USDC'}});
  const incompleteSol=fact('holders',[],{keys:{mint:{address:OTHER}},operations:[op('create',4),payout(5,'2000000000')],historyTruncated:true});
  const metric=stats([completeZero,incompleteSol],{pricesByMint:{}}).holders.distributed,usd=metric.quoteTotals.find(row=>row.symbol==='USDC'),sol=metric.quoteTotals.find(row=>row.symbol==='SOL');
  assert.equal(usd.amount,'0');assert.equal(usd.usdEstimate,0);assert.equal(usd.historyComplete,true);assert.equal(usd.coverage,'complete');
  assert.equal(sol.amount,'2');assert.equal(sol.usdEstimate,null);assert.equal(sol.historyComplete,false);assert.equal(sol.coverage,'subtotal');assert.equal(metric.unpricedQuoteAssets,1);
});

test('a missing history on another coin with the same paired asset prevents a complete per-asset total',()=>{
  const paidRecord=fact('holders',[payout(1,'1000000000')]);
  const missing=fact('holders',[],{keys:{mint:{address:OTHER}},operations:[op('create',4)],historyTruncated:true});
  const metric=stats([paidRecord,missing]).holders.distributed,row=metric.quoteTotals[0];assert.equal(row.amount,'1');assert.equal(row.usdEstimate,100);assert.equal(row.historyComplete,false);assert.equal(row.coverage,'subtotal');assert.equal(metric.usdEstimate,null);assert.equal(metric.observedUsdEstimate,100);
});

test('cycle distribution summaries reveal missing journal coverage without being counted as lifetime payouts',()=>{
  for(const extra of [{holderRewards:{lastDistributionQuoteUnits:'2000000000'}},{cycle:{distributedQuoteUnits:'2000000000'}}]){
    const empty=stats([fact('holders',[],extra)]).holders;assert.equal(empty.distributed.quoteTotals[0].amount,null);assert.equal(empty.distributed.usdEstimate,null);assert.equal(empty.uniqueWallets,null);
    const partial=stats([fact('holders',[paid(1)],extra)]).holders;assert.equal(partial.distributed.quoteTotals[0].amount,'1');assert.equal(partial.distributed.quoteTotals[0].coverage,'subtotal');assert.equal(partial.distributed.observedUsdEstimate,100);assert.equal(partial.observedUniqueWallets,1);
  }
  const covered=stats([fact('holders',[paid(1)],{holderRewards:{lastDistributionQuoteUnits:'1000000000'},cycle:{distributedQuoteUnits:'1000000000'}})]).holders;
  assert.equal(covered.distributed.usdEstimate,100);assert.equal(covered.uniqueWallets,1);assert.equal(covered.distributed.quoteTotals[0].coverage,'complete');
});
test('a quote price awaiting its next scheduled refresh still values rewards instead of flickering to a subtotal',()=>{
  const metric=stats([fact('holders',[payout(1,'1000000000')])],{pricesByMint:{[SOL]:{usd:100,at:NOW-90_000}}}).holders.distributed;
  assert.equal(metric.usdEstimate,100);assert.equal(metric.quoteTotals[0].usdEstimate,100);
});
