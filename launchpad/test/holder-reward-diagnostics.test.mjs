import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { holderRewardDiagnostics, HolderRewardDiagnostics } from '../src/holder-reward-diagnostics.mjs';
import { rewardAnalyticsRecord, publicRewardAnalytics } from '../src/public-reward-analytics.mjs';

const NOW=Date.parse('2026-09-27T12:00:00Z'), SOL='So11111111111111111111111111111111111111112';
const MINT=Keypair.generate().publicKey.toBase58(), OTHER=Keypair.generate().publicKey.toBase58(), SOURCE=Keypair.generate().publicKey.toBase58(), RECIPIENT=Keypair.generate().publicKey.toBase58();
const sig=n=>bs58.encode(Buffer.alloc(64,n));
const payout=(n,extra={})=>({kind:'payout',state:'confirmed',signature:sig(n),slot:100+n,amount:'1000000000',payouts:[{owner:RECIPIENT,amount:'1000000000'}],receipt:{quoteDelta:'-1000000000',baseDelta:'0'},...extra});
const launch=(operations=[],extra={})=>({input:{route:'raydium',network:'mainnet-beta',feeMode:'holders',quoteMint:SOL,symbol:'LAUNCHPAD'},keys:{mint:{address:MINT,secret:'MINT_SECRET'},wallet:{address:SOURCE,secret:'SOURCE_SECRET'}},review:{quoteDecimals:9,quoteSymbol:'SOL'},authorizedAt:NOW-10000,createdAt:NOW-10000,state:'live',operations:[{kind:'create',state:'confirmed',signature:sig(99),slot:1,createdAt:NOW-10000},...operations],accountId:'PRIVATE_ACCOUNT',error:'PRIVATE_ERROR',raw:'SIGNED_BYTES',...extra});
const report=(rows,opts={})=>holderRewardDiagnostics(rows,{now:NOW,...opts});

test('sanitized diagnostics explain exact exclusions without copying private journal data',()=>{
  const raw=launch([payout(1),payout(2,{receipt:{quoteDelta:'-1',baseDelta:'0'}}),payout(3,{slot:0}),payout(4,{state:'pending'}),payout(5,{amount:undefined})]);
  const before=structuredClone(raw), result=report([raw]), row=result.launches[0], out=JSON.stringify(result);
  assert.deepEqual(raw,before);assert.equal(row.includedInAnalytics,true);assert.equal(row.analytics.countedPayouts,2);assert.equal(row.analytics.countedQuoteAmount,'2');
  assert.equal(row.analytics.recoveredPayoutAmounts,1);assert.equal(row.analytics.reasons.contradictory_receipt,1);assert.equal(row.analytics.reasons.missing_or_invalid_finalized_slot,1);assert.equal(row.analytics.reasons.not_confirmed,1);
  assert.equal(row.payoutStates.pending,1);assert.equal(row.sourceWallet,SOURCE);assert.ok(row.analytics.transactions.some(tx=>tx.signature===sig(2)&&tx.reason==='contradictory_receipt'));
  for(const secret of ['MINT_SECRET','SOURCE_SECRET','PRIVATE_ACCOUNT','PRIVATE_ERROR','SIGNED_BYTES',RECIPIENT])assert.ok(!out.includes(secret));
});
test('diagnostics exclude actual inventory failures and reveal missing cycle history without manufacturing totals',()=>{
  const a=launch([],{holderRewards:{lastDistributionAt:NOW-100,lastDistributionQuoteUnits:'9000000000'}}), b=launch([payout(1)],{keys:{mint:{address:OTHER},wallet:{address:SOURCE}},state:'draft'});
  const result=report([a,b]), row=result.launches.find(row=>row.mint===MINT), draft=result.launches.find(row=>row.mint===OTHER);
  assert.equal(result.includedLaunches,1);assert.equal(row.analytics.countedQuoteUnits,'0');assert.equal(row.analytics.historyComplete,false);assert.ok(row.historyFlags.includes('cycle_counter_exceeds_retained_payouts'));
  assert.equal(draft.analytics,null);assert.equal(draft.includedInAnalytics,false);assert.deepEqual(draft.excludedLaunchReasons,['draft']);
});
test('duplicate journal copies and cross-mint conflicts match public accounting exactly',()=>{
  const a=launch([payout(1)]), dup=report([a,structuredClone(a)]).launches[0];
  assert.equal(dup.journalCopies,2);assert.equal(dup.payoutStates.confirmed,2);assert.equal(dup.analytics.countedQuoteAmount,'1');assert.equal(dup.analytics.reasons.duplicate_signature,1);
  const b=launch([payout(1)],{keys:{mint:{address:OTHER},wallet:{address:SOURCE}}});
  assert.ok(report([a,b]).launches.every(row=>row.analytics.countedQuoteUnits==='0'&&row.analytics.reasons.conflicting_signature===1));
});
test('diagnostic transaction details are bounded while counts retain all excluded operations',()=>{
  const row=report([launch(Array.from({length:70},(_,i)=>payout(i+1,{state:'pending'})))],{maxDetails:7}).launches[0];
  assert.equal(row.analytics.transactions.length,7);assert.equal(row.analytics.omittedTransactions,63);assert.equal(row.analytics.reasons.not_confirmed,70);
});
function service({actor={id:'admin',role:'admin',mfaEnabled:true},books=[{launches:[launch([payout(1)])]}],...options}={}){
  let reads=0,writes=0,now=NOW;
  const accounts={get:async()=>actor,list:async()=>books.map((_,i)=>({id:String(i)})),storeFor:id=>({read:async()=>{reads++;const book=books[Number(id)];if(book instanceof Error)throw book;return structuredClone(book);},write:async()=>{writes++;throw Error('No writes allowed');}})};
  const instance=new HolderRewardDiagnostics({accounts,now:()=>now,...options});
  return {instance,reads:()=>reads,writes:()=>writes,advance:()=>{now+=30001;}};
}
test('diagnostics require admin MFA before any scan and never write launch books',async()=>{
  for(const actor of [null,{id:'user',role:'user',mfaEnabled:true},{id:'admin',role:'admin',mfaEnabled:false},{id:'admin',role:'admin',mfaEnabled:true,banned:true}]){
    const p=service({actor});await assert.rejects(p.instance.read('actor'),error=>error.statusCode===403);assert.equal(p.reads(),0);
  }
  const p=service();await p.instance.read('admin');assert.equal(p.reads(),1);assert.equal(p.writes(),0);
});
test('shared cache and one in-flight scan prevent repeated admin polling from rescanning books',async()=>{
  const p=service();const [a,b]=await Promise.all([p.instance.read('admin'),p.instance.read('admin')]);assert.equal(p.reads(),1);assert.deepEqual(a,b);
  a.launches.length=0;assert.equal((await p.instance.read('admin')).launches.length,1);assert.equal(p.reads(),1);
  p.advance();await p.instance.read('admin');assert.equal(p.reads(),2);p.instance.close();await assert.rejects(p.instance.read('admin'),/restarting/);
});
test('unavailable books and scan caps never claim complete inventory',async()=>{
  const p=service({books:[{launches:[launch()]},new Error('https://PRIVATE_RPC')]});const result=await p.instance.read('admin');assert.equal(result.inventoryComplete,false);assert.equal(result.storesUnavailable,1);assert.ok(!JSON.stringify(result).includes('PRIVATE_RPC'));
  for(const options of [{maxAccounts:0},{maxLaunches:0},{maxOperations:0}])await assert.rejects(service(options).instance.read('admin'),/scan limit/);
});

test('combined and platform diagnostics share public reward arithmetic and deduplicate recipient addresses across platforms',()=>{
  const first=launch([payout(1)]), other=launch([],{keys:{mint:{address:OTHER},wallet:{address:SOURCE}},operations:[{kind:'create',state:'confirmed',signature:sig(98),slot:1},payout(2)]});
  const additional=rewardAnalyticsRecord(other), pricesByMint=new Map([[SOL,{usd:100,at:NOW}]]);
  additional.secret='ADDITIONAL_PRIVATE';additional.quote.secret='QUOTE_PRIVATE';
  const out=report([first],{additionalRecords:[additional],pricesByMint}), expected=publicRewardAnalytics([rewardAnalyticsRecord(first),additional],{now:NOW,pricesByMint});
  assert.equal(out.holders.distributed.usdEstimate,expected.holders.distributed.usdEstimate);assert.equal(out.holders.distributed.usdEstimate,200);
  assert.equal(out.holders.uniqueWallets,1);assert.equal(out.holders.payments,2);assert.equal(out.holders.distributed.quoteTotals[0].amountUnits,'2000000000');
  assert.equal(out.platforms.length,2);assert(out.platforms.every(row=>row.holders.uniqueWallets===1&&row.holders.distributed.usdEstimate===100));
  assert.deepEqual(out.launches.find(row=>row.mint===OTHER).platforms,['meteora']);
  for(const secret of [RECIPIENT,'ADDITIONAL_PRIVATE','QUOTE_PRIVATE','MINT_SECRET','PRIVATE_ACCOUNT'])assert(!JSON.stringify(out).includes(secret));
});

test('same payout returned by two platform sources counts only once in the combined report',()=>{
  const original=launch([payout(1)]), out=report([original],{additionalRecords:[rewardAnalyticsRecord(original)],pricesByMint:new Map([[SOL,{usd:100,at:NOW}]])});
  assert.equal(out.holders.distributed.usdEstimate,100);assert.equal(out.holders.uniqueWallets,1);assert.equal(out.holders.payments,1);
  assert.equal(out.launches[0].analytics.countedQuoteUnits,'1000000000');assert.equal(out.launches[0].analytics.reasons.duplicate_signature,1);
  assert.deepEqual(out.launches[0].platforms,['meteora','raydium']);
});

test('unavailable additional platform keeps confirmed subtotals but cannot claim complete reward or wallet totals',async()=>{
  let additionalReads=0,priceReads=0;
  const p=service({additionalRecords:async()=>{additionalReads++;throw Error('PRIVATE_RPC_SECRET');},pricesByMint:()=>{priceReads++;return new Map([[SOL,{usd:100,at:NOW}]]);}});
  const out=await p.instance.read('admin');assert.equal(out.inventoryComplete,false);assert.equal(out.holders.distributed.usdEstimate,null);assert.equal(out.holders.distributed.observedUsdEstimate,100);
  assert.equal(out.holders.uniqueWallets,null);assert.equal(out.holders.observedUniqueWallets,1);assert.equal(out.platforms[1].inventoryComplete,false);assert.equal(out.platforms[1].holders.distributed.observedUsdEstimate,null);
  assert(!JSON.stringify(out).includes('PRIVATE_RPC_SECRET'));await p.instance.read('admin');assert.equal(additionalReads,1);assert.equal(priceReads,1);assert.equal(p.writes(),0);
});

test('additional record scan limits stay bounded and unavailable prices leave exact units visible',async()=>{
  const additional=rewardAnalyticsRecord(launch([payout(1)]));
  const missingPrice=service({additionalRecords:async()=>[additional],pricesByMint:()=>{throw Error('PRIVATE_PRICE');}});
  const out=await missingPrice.instance.read('admin');assert.equal(out.holders.distributed.usdEstimate,null);assert.equal(out.holders.distributed.quoteTotals[0].amountUnits,'1000000000');assert.equal(out.holders.uniqueWallets,1);
  const bounded=service({books:[{launches:[]}],additionalRecords:async()=>[additional],maxOperations:1});const limited=await bounded.instance.read('admin');assert.equal(limited.inventoryComplete,false);assert.equal(limited.platforms[1].inventoryComplete,false);assert.equal(limited.holders.uniqueWallets,null);
});

test('service evidence preserves individual reward wallets, saved pause intent and credits without mutating journals',()=>{
  const first=launch([],{error:'Fee service paused. Pending receipts will still be reconciled.',curve:{},state:'paused',feeAutomation:{enabled:false,source:'admin',updatedAt:NOW-20},keys:{mint:{address:MINT},wallet:{address:SOURCE,secret:'SECRET_CREATOR'},rewards:{address:OTHER,secret:'SECRET_REWARD'}},credits:{base:'73419206851937',quote:'17305842'},holderRewards:{minimumQuoteUnits:'30000000'},gas:{day:'2026-09-27',reserved:'10000000'}});
  const second=structuredClone(first);second.keys.rewards.address=RECIPIENT;second.feeAutomation={enabled:true,source:'admin',updatedAt:NOW};second.state='live';second.error='Automatic rewards are waiting for SOL and will retry automatically.';second.rewardRetry={kind:'sell',at:NOW+300000,attempt:3,reason:'Insufficient SOL at https://PRIVATE_RPC/APIKEY'};
  const before=structuredClone([first,second]),out=report([first,second]),evidence=out.launches[0].serviceEvidence;
  assert.deepEqual([first,second],before);assert.equal(evidence.length,2);assert.equal(evidence[0].creatorWallet,SOURCE);assert.equal(evidence[0].rewardsWallet,OTHER);assert.equal(evidence[1].rewardsWallet,RECIPIENT);
  assert(evidence[0].blockers.includes('intentional_pause'));assert(evidence[0].blockers.includes('runtime_paused'));assert(evidence[0].blockers.includes('below_saved_quote_threshold'));assert.equal(evidence[0].enabled,false);assert.equal(evidence[0].credits.baseUnits,'73419206851937');
  assert.equal(evidence[1].failureCategory,'funding');assert(evidence[1].blockers.includes('native_funding_required'));assert(evidence[1].blockers.includes('reward_retry_scheduled'));assert.equal(evidence[1].retryAt,NOW+300000);assert.equal(evidence[1].retryKind,'sell');assert.equal(evidence[1].gasBudget.liveBalanceVerified,false);
  for(const secret of ['PRIVATE_RPC','APIKEY','SECRET_CREATOR','SECRET_REWARD'])assert(!JSON.stringify(out).includes(secret));
});

test('diagnostics distinguish saved signature, receipt, unsafe unknown pause and expired budget wait',()=>{
  const base=launch([],{curve:{},error:'',credits:{base:'0',quote:'0'},autoFees:true,feeAutomation:{enabled:true,source:'legacy-enabled',updatedAt:NOW-10}});
  const cases=[
    [{operations:[{kind:'sell',state:'awaiting_signature',unsignedRaw:'PRIVATE_BYTES'}]},'awaiting_wallet_signature'],
    [{operations:[{kind:'payout',state:'pending',raw:'PRIVATE_BYTES',receiptCheckAfter:NOW+1000}]},'awaiting_transaction_receipt'],
    [{state:'paused',error:'Invalid holder recipient balance check. PRIVATE_PROVIDER'},'unclassified_error'],
    [{feeAutomation:{enabled:false,source:'legacy-paused'}},'legacy_pause_needs_review'],
    [{feeAutomation:{enabled:'PRIVATE_INTENT',source:'PRIVATE_SOURCE'}},'invalid_automation_intent'],
    [{feeAutomation:{enabled:false,source:'policy-review'}},'policy_review_required'],
    [{rewardRetry:{at:NOW-1,kind:'gas-budget',attempt:1,reason:'PRIVATE_RAW'}},'reward_retry_due'],
  ];
  for(const [patch,blocker] of cases){const out=report([{...base,...patch}]),ev=out.launches[0].serviceEvidence[0];assert(ev.blockers.includes(blocker),blocker);assert(!JSON.stringify(out).includes('PRIVATE_'));}
});

test('service evidence is bounded across retained copies and unavailable for receipt-only platforms',()=>{
  const rows=Array.from({length:13},()=>launch([],{curve:{},error:'',autoFees:true,credits:{base:'0',quote:'0'}})),out=report(rows,{additionalRecords:[rewardAnalyticsRecord(rows[0])]});
  assert.equal(out.launches[0].serviceEvidence.length,10);assert.equal(out.launches[0].omittedServiceEvidence,3);assert.equal(out.launches[0].journalCopies,14);assert.equal(out.launches[0].serviceEvidenceUnavailable,true);
  assert.equal(out.liveChainVerified,false);assert.match(out.note,/not live wallet balances/);
});


test('saved retry category survives the loss of transient error codes and keeps integrity failures unclassified',()=>{
  const base=launch([],{curve:{},error:'Automatic rewards are waiting to retry automatically.',autoFees:true,credits:{base:'0',quote:'0'}});
  for(const [kind,reason,blocker] of [
    ['gas-budget','The daily reward network-cost budget is used. The next budget starts at midnight UTC.','daily_budget_retry_scheduled'],
    ['transaction','The reward transaction failed onchain. Its saved step will be prepared again using current chain state.','transaction_retry'],
  ]){const ev=report([{...base,rewardRetry:{kind,reason,at:NOW+1000,attempt:1}}]).launches[0].serviceEvidence[0];assert.equal(ev.failureCategory,kind);assert(ev.blockers.includes(blocker));}
  const ev=report([{...base,error:'Invalid holder recipient balance check.',rewardRetry:{kind:'network',reason:'Invalid holder recipient balance check.',at:NOW+1000,attempt:1}}]).launches[0].serviceEvidence[0];assert.equal(ev.failureCategory,null);
});


test('service diagnostics expose exact local inventory errors and precise wallet handoff/debt evidence without identities or secrets',()=>{
  const handoffSignature=sig(88),row=launch([{kind:'reward-handoff',state:'confirmed',signature:handoffSignature,slot:345678901,raw:'PRIVATE_SIGNED',rewardHandoff:{privateKey:'PRIVATE_PLAN'}}],{
    curve:{},error:'The creator rewards token account cannot cover its saved credits.',credits:{base:'73419206851937',quote:'9007199254740993'},
    rewardsWallet:{status:'active',creatorCredits:{base:'73419206851937',quote:'9007199254740993',protocolQuote:'0',taxBase:'73419206851937',privateKey:'PRIVATE_LEDGER'},lastHandoff:{signature:handoffSignature,at:NOW-500,baseDebit:'9007199254740993',baseCredit:'9007199254740992',quoteDebit:'9007199254740994',quoteCredit:'9007199254740993',taxBaseLoss:'1',protocolQuoteLoss:'0',gasLamports:'10000000',raw:'PRIVATE_HANDOFF'}},
    nativeRewardDebts:{version:1,payouts:[{owner:RECIPIENT,amount:'9007199254740993'}]},
  }),before=structuredClone(row),out=report([row]),ev=out.launches[0].serviceEvidence[0];
  assert.deepEqual(row,before);assert.equal(ev.serviceError,row.error);assert.equal(ev.errorTextOmitted,false);assert.equal(ev.rewardsWalletStatus,'active');
  assert.deepEqual(ev.creatorCredits,{base:'73419206851937',quote:'9007199254740993',protocolQuote:'0',taxBase:'73419206851937'});
  assert.deepEqual(ev.lastHandoff,{signature:handoffSignature,at:NOW-500,slot:345678901,baseDebit:'9007199254740993',baseCredit:'9007199254740992',quoteDebit:'9007199254740994',quoteCredit:'9007199254740993',taxBaseLoss:'1',protocolQuoteLoss:'0',gasLamports:'10000000'});
  assert.deepEqual(ev.deferredRewards,{wallets:1,amountUnits:'9007199254740993'});
  for(const secret of ['PRIVATE_',RECIPIENT])assert(!JSON.stringify(out).includes(secret));
});

test('diagnostic local error allowlist fails closed for appended credentials and malformed wallet evidence',()=>{
  for(const error of ['The creator rewards token account cannot cover its saved credits. https://private:password@example.test?api-key=secret', 'LAUNCHPAD tax burn exceeds its verified rewards-wallet inventory. SECRET_KEY', 'Invalid public key input: PRIVATE_BYTES', 'authorization=PRIVATE_TOKEN https://PRIVATE_PROVIDER']){
    const row=launch([],{error,rewardRetry:{reason:error},rewardsWallet:{status:'PRIVATE_STATUS',creatorCredits:{base:'01',quote:'1e9',protocolQuote:'PRIVATE_KEY',taxBase:-1},lastHandoff:{signature:'PRIVATE_SIGNATURE',at:'PRIVATE_TIME',baseDebit:'1.5'}},nativeRewardDebts:{version:1,payouts:[]}}),ev=report([row]).launches[0].serviceEvidence[0];
    assert.equal(ev.serviceError,null);assert.equal(ev.retryReason,null);assert.equal(ev.errorTextOmitted,true);assert.equal(ev.retryReasonTextOmitted,true);
    assert.deepEqual(ev.creatorCredits,{base:null,quote:null,protocolQuote:null,taxBase:null});assert.equal(ev.rewardsWalletStatus,null);assert.equal(ev.lastHandoff.signature,null);assert.equal(ev.lastHandoff.at,null);assert.equal(ev.lastHandoff.slot,null);assert.equal(ev.lastHandoff.baseDebit,null);assert.deepEqual(ev.deferredRewards,{unavailable:true});
    const out=JSON.stringify(ev);assert(!out.includes('PRIVATE_'));assert(!out.includes('https://'));assert(!out.includes('SECRET_KEY'));assert(!out.includes('password'));
  }
  const ev=report([launch([],{error:'LAUNCHPAD tax burn exceeds its verified rewards-wallet inventory.',rewardRetry:{reason:'Automatic rewards are waiting for SOL and will retry automatically.'}})]).launches[0].serviceEvidence[0];
  assert.equal(ev.serviceError,'LAUNCHPAD tax burn exceeds its verified rewards-wallet inventory.');assert.equal(ev.retryReason,'Automatic rewards are waiting for SOL and will retry automatically.');assert.equal(ev.retryReasonTextOmitted,false);
});


test('diagnostics decode only fixed simulation fields and omit arbitrary appended provider details',()=>{
  const prefix='Onchain simulation failed during fee processing (instruction 2, program 11111111111111111111111111111111): {"InstructionError":[2,{"Custom":1}]}.',ev=report([launch([],{error:prefix+' Error: PRIVATE_KEY https://PRIVATE_PROVIDER'})]).launches[0].serviceEvidence[0];
  assert.equal(ev.serviceError,prefix);assert.deepEqual(ev.simulationFailure,{instruction:2,program:'11111111111111111111111111111111',customCode:1,errorKind:'Custom'});assert.match(ev.errorFingerprint,/^[a-f0-9]{64}$/);assert(!JSON.stringify(ev).includes('PRIVATE_'));
  const unknown=report([launch([],{error:'Onchain simulation failed during fee processing (instruction 2, program 11111111111111111111111111111111): {"InstructionError":[2,"PRIVATE_PAYLOAD"]}.'})]).launches[0].serviceEvidence[0];assert.equal(unknown.serviceError,null);assert.equal(unknown.simulationFailure,null);assert.equal(unknown.errorTextOmitted,true);
});
test('diagnostics cover more than 1,000 accounts up to the registry ceiling',async()=>{
  const p=service({books:[{launches:[launch([payout(1)])]},...Array.from({length:1500},()=>({launches:[]}))]});
  const result=await p.instance.read('admin');assert.equal(result.storesRead,1501);assert.equal(result.holderLaunches,1);
  const over=service({books:Array.from({length:10001},()=>({launches:[]}))});await assert.rejects(over.instance.read('admin'),/account scan limit/);
});
