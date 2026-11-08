import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { Keypair } from '@solana/web3.js';
import { holderRewardDiagnostics } from '../src/holder-reward-diagnostics.mjs';
import { createAdminRewardDiagnostics, safeHolderRewardDiagnostics } from '../public/admin-reward-diagnostics-ui.mjs';

const ADMIN={id:'admin',role:'admin',mfaEnabled:true}, MINT='So11111111111111111111111111111111111111112', SIGNATURE='4'.repeat(88);
const report={version:1,generatedAt:Date.parse('2026-09-27T12:00:00Z'),inventoryComplete:true,storesRead:1,storesUnavailable:0,holderLaunches:1,includedLaunches:1,
  launches:[{mint:MINT,symbol:'LAUNCHPAD',quote:{mint:MINT,symbol:'SOL',decimals:9},sourceWallet:MINT,includedInAnalytics:true,excludedLaunchReasons:[],journalCopies:1,retainedOperations:4,payoutStates:{confirmed:1,pending:1,failed:0,expired:0,other:0},historyFlags:['analytics_history_incomplete'],cycleEvidence:[{lastDistributionAt:null,lastCycleQuoteUnits:'1000000000',currentCycleQuoteUnits:null}],omittedCycleEvidence:0,
    analytics:{historyComplete:false,countedPayouts:1,recoveredPayoutAmounts:0,countedQuoteUnits:'1000000000',countedQuoteAmount:'1',reasons:{not_confirmed:1},transactions:[{signature:SIGNATURE,slot:100,counted:false,reason:'not_confirmed'}],omittedTransactions:0}}]};
function page({respond=async()=>report,account=ADMIN}={}){
  const {document}=parseHTML('<html><body></body></html>'),calls=[],downloads=[];let active=true;
  const ui=createAdminRewardDiagnostics({document,getAccount:()=>account,isActive:()=>active,api:async(...args)=>{calls.push(args);return respond();},downloadFile:async file=>downloads.push(file)});document.body.append(ui.element);
  return {ui,document,calls,downloads,button:ui.element.querySelector('button'),account:value=>{account=value;},active:value=>{active=value;}};
}
test('report downloads only on explicit click and use one read-only authenticated request',async()=>{
  const p=page();await p.ui.load();assert.equal(p.calls.length,0);assert.equal(p.ui.element.hidden,false);assert.equal(p.ui.element.id,'admin-reward-diagnostics');
  await p.button.onclick();assert.equal(p.calls.length,1);assert.equal(p.calls[0][0],'/api/admin/reward-diagnostics');assert.equal(p.calls[0][1],undefined);assert.equal(p.calls[0][2].signal.aborted,false);
  assert.equal(p.downloads[0].name,'Launchpad-Reward-Diagnostics-2026-09-27.json');assert.equal(p.downloads[0].type,'application/json');assert.equal(JSON.parse(p.downloads[0].contents).launches[0].analytics.transactions[0].signature,SIGNATURE);p.ui.destroy();
});
test('defensive JSON projection omits recipient identities and all unrecognized sensitive fields',async()=>{
  const data=structuredClone(report);Object.assign(data,{secret:'TOP_SECRET',accountId:'PRIVATE_ACCOUNT',raw:'SIGNED_RAW',rpcUrl:'PRIVATE_RPC',liveChainVerified:true});
  Object.assign(data.launches[0],{keys:{wallet:{secret:'PRIVATE_KEY'}},recipients:['PRIVATE_RECIPIENT'],error:'PRIVATE_ERROR'});Object.assign(data.launches[0].analytics.transactions[0],{raw:'TX_RAW',recipient:'PRIVATE_RECIPIENT'});
  const p=page({respond:async()=>data});p.ui.load();await p.button.onclick();const out=p.downloads[0].contents;
  for(const secret of ['TOP_SECRET','PRIVATE_ACCOUNT','SIGNED_RAW','PRIVATE_RPC','PRIVATE_KEY','PRIVATE_RECIPIENT','PRIVATE_ERROR','TX_RAW'])assert.ok(!out.includes(secret));
  assert.equal(JSON.parse(out).liveChainVerified,false);assert.equal(JSON.parse(out).launches[0].sourceWallet,MINT);p.ui.destroy();
});
test('permission and Revenue visibility gates prevent background requests',async()=>{
  for(const account of [null,{...ADMIN,role:'user'},{...ADMIN,mfaEnabled:false},{...ADMIN,banned:true}]){
    const p=page({account});p.ui.load();await p.button.onclick();assert.equal(p.ui.element.hidden,true);assert.equal(p.calls.length,0);p.ui.destroy();
  }
  const p=page();p.active(false);p.ui.load();await p.button.onclick();assert.equal(p.calls.length,0);p.ui.destroy();
});
test('pause and identity changes abort or suppress late downloads',async()=>{
  let resolve;const p=page({respond:()=>new Promise(done=>{resolve=done;})});p.ui.load();const pending=p.button.onclick();assert.equal(p.button.disabled,true);
  p.ui.pause();assert.equal(p.calls[0][2].signal.aborted,true);resolve(report);await pending;assert.equal(p.downloads.length,0);assert.equal(p.button.disabled,false);
  p.ui.load();const switched=p.button.onclick();p.account({...ADMIN,id:'other'});resolve(report);await switched;assert.equal(p.downloads.length,0);assert.equal(p.ui.element.hidden,true);p.ui.destroy();
});
test('old response cannot clear a newer administrator report control',async()=>{
  const resolvers=[];const p=page({respond:()=>new Promise(done=>resolvers.push(done))});p.ui.load();const old=p.button.onclick();p.account({...ADMIN,id:'other'});p.ui.clear();p.ui.load();const next=p.button.onclick();
  resolvers[0](report);await old;assert.equal(p.ui.element.hidden,false);assert.equal(p.button.disabled,true);assert.equal(p.downloads.length,0);
  resolvers[1](report);await next;assert.equal(p.downloads.length,1);assert.equal(p.button.disabled,false);p.ui.destroy();
});
test('malformed response and provider errors never download unknown data or display raw errors',async()=>{
  for(const respond of [async()=>({version:1}),async()=>{throw Error('https://RPC_SECRET');}]){
    const p=page({respond});p.ui.load();await p.button.onclick();assert.equal(p.downloads.length,0);assert.match(p.ui.element.textContent,/could not be downloaded/);assert.ok(!p.ui.element.textContent.includes('RPC_SECRET'));p.ui.destroy();
  }
  assert.throws(()=>safeHolderRewardDiagnostics({}),/Invalid/);
});

test('download preserves only safe combined and platform aggregates, exact raw amounts and coverage',()=>{
  const data=structuredClone(report), holders={distributed:{usdEstimate:12.5,observedUsdEstimate:12.5,quoteTotals:[{symbol:'SOL',decimals:18,amount:'0.000000000000000123',amountUnits:'123',usdEstimate:12.5,priceAt:data.generatedAt,historyComplete:true,coverage:'complete',recipient:'PRIVATE_RECIPIENT'}],historyComplete:true,valuationComplete:true,evidenceCount:2,unpricedQuoteAssets:0,private:'PRIVATE_DISTRIBUTED'},uniqueWallets:1,observedUniqueWallets:1,walletsComplete:true,payments:2,observedPayments:2,coins:2,historyComplete:true,recipients:['PRIVATE_RECIPIENT'],secret:'PRIVATE_HOLDER'};
  data.holders=holders;data.platforms=[{id:'raydium',inventoryComplete:true,holders,secret:'PRIVATE_PLATFORM'},{id:'meteora',inventoryComplete:false,holders:{...holders,uniqueWallets:null,distributed:{...holders.distributed,usdEstimate:null,historyComplete:false}}},{id:'unknown',holders}];data.launches[0].platforms=['raydium','meteora','PRIVATE_PLATFORM'];data.launches[0].quote.decimals=18;data.launches[0].analytics.countedQuoteAmount='0.000000000000000123';
  const out=safeHolderRewardDiagnostics(data);assert.equal(out.holders.distributed.quoteTotals[0].amountUnits,'123');assert.equal(out.holders.distributed.quoteTotals[0].amount,'0.000000000000000123');assert.equal(out.holders.distributed.usdEstimate,12.5);
  assert.equal(out.holders.uniqueWallets,1);assert.equal(out.platforms.length,2);assert.equal(out.platforms[1].holders.uniqueWallets,null);assert.equal(out.platforms[1].holders.distributed.usdEstimate,null);assert.deepEqual(out.launches[0].platforms,['raydium','meteora']);assert.equal(out.launches[0].quote.decimals,18);assert.equal(out.launches[0].analytics.countedQuoteAmount,'0.000000000000000123');
  assert(!JSON.stringify(out).includes('PRIVATE_'));assert.match(out.note,/distinct recipient addresses/);assert.equal(out.liveChainVerified,false);
  data.launches[0].analytics.transactions[0].reason='confirmed_payout';data.launches[0].analytics.transactions[0].counted=true;assert.equal(safeHolderRewardDiagnostics(data).launches[0].analytics.transactions[0].reason,'confirmed_payout');
});

test('service evidence download retains useful wallet blockers but rejects injected private diagnostic values',()=>{
  const data=structuredClone(report);data.launches[0].serviceEvidence=[{creatorWallet:MINT,rewardsWallet:MINT,state:'paused',enabled:false,
    automationIntent:{saved:true,enabled:false,source:'admin',updatedAt:data.generatedAt,actorId:'PRIVATE_ACCOUNT'},failureCategory:'funding',
    blockers:['native_funding_required','runtime_paused','PRIVATE_ERROR'],credits:{baseUnits:'73419206851937',quoteUnits:'17305842',raw:'PRIVATE_CREDIT'},
    pendingOperation:{kind:'sell',state:'pending',createdAt:data.generatedAt,raw:'PRIVATE_RAW'},retryAt:data.generatedAt+300000,retryAttempt:2,retryKind:'sell',cycleStage:'route',
    gasBudget:{day:'2026-09-27',reservedLamports:'3000000',dailyLimitLamports:'50000000',liveBalanceVerified:true,secret:'PRIVATE_GAS'},error:'PRIVATE_PROVIDER',recipients:['PRIVATE_RECIPIENT']}];
  data.launches[0].omittedServiceEvidence=2;
  const out=safeHolderRewardDiagnostics(data),ev=out.launches[0].serviceEvidence[0];
  assert.equal(ev.rewardsWallet,MINT);assert.equal(ev.automationIntent.source,'admin');assert.equal(ev.failureCategory,'funding');assert.deepEqual(ev.blockers,['native_funding_required','runtime_paused']);assert.equal(ev.credits.baseUnits,'73419206851937');assert.equal(ev.gasBudget.liveBalanceVerified,false);assert.equal(out.launches[0].omittedServiceEvidence,2);assert(!JSON.stringify(out).includes('PRIVATE_'));
  data.launches[0].serviceEvidence=Array.from({length:30},()=>({state:'PRIVATE_STATE',failureCategory:'PRIVATE_FAILURE',cycleStage:'PRIVATE_STAGE',automationIntent:{source:'PRIVATE_SOURCE'},pendingOperation:{kind:'PRIVATE_KIND',state:'PRIVATE_STATE'},retryKind:'PRIVATE_KIND'}));
  const bounded=safeHolderRewardDiagnostics(data);assert.equal(bounded.launches[0].serviceEvidence.length,10);assert(!JSON.stringify(bounded).includes('PRIVATE_'));
});


test('the actual downloaded report preserves server ATA simulation evidence, exact migration credits and deferred amounts',async()=>{
  const program='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',error=`Onchain simulation failed during fee processing (instruction 4, program ${program}): {"InstructionError":[4,{"Custom":1}]}.`,recipient=Keypair.generate().publicKey.toBase58(),handoffSignature='1'.repeat(64),now=report.generatedAt;
  const source={id:'a'.repeat(32),input:{route:'raydium',network:'mainnet-beta',feeMode:'holders',quoteMint:MINT,symbol:'ALPHA'},keys:{mint:{address:MINT},wallet:{address:MINT,secret:'PRIVATE_KEY'},rewards:{address:MINT,secret:'PRIVATE_REWARDS'}},review:{quoteDecimals:9,quoteSymbol:'SOL'},curve:{},authorizedAt:now-100,state:'paused',autoFees:true,error:error+' Error: PRIVATE_PROVIDER https://PRIVATE_RPC/?api-key=PRIVATE_TOKEN',credits:{base:'73419206851937',quote:'9007199254740993'},operations:[{kind:'reward-handoff',state:'confirmed',signature:handoffSignature,slot:123456789,raw:'PRIVATE_SIGNED'}],
    rewardsWallet:{status:'active',creatorCredits:{base:'73419206851937',quote:'9007199254740993',protocolQuote:'0',taxBase:'73419206851937'},lastHandoff:{signature:handoffSignature,at:now-50,baseDebit:'9007199254740993',baseCredit:'9007199254740992',quoteDebit:'10',quoteCredit:'10',taxBaseLoss:'1',protocolQuoteLoss:'0',gasLamports:'5000000'}},nativeRewardDebts:{version:1,payouts:[{owner:recipient,amount:'9007199254740993'}]}};
  const backend=holderRewardDiagnostics([source],{now}),serverEvidence=backend.launches[0].serviceEvidence[0],p=page({respond:async()=>backend});p.ui.load();await p.button.onclick();assert.equal(p.downloads.length,1);
  const raw=p.downloads[0].contents,downloaded=JSON.parse(raw).launches[0].serviceEvidence[0];
  assert.equal(downloaded.serviceError,error);assert.deepEqual(downloaded.simulationFailure,{instruction:4,program,customCode:1,errorKind:'Custom'});assert.equal(downloaded.errorFingerprint,serverEvidence.errorFingerprint);assert.match(downloaded.errorFingerprint,/^[a-f0-9]{64}$/);
  assert.equal(downloaded.rewardsWalletStatus,'active');assert.deepEqual(downloaded.creatorCredits,serverEvidence.creatorCredits);assert.equal(downloaded.creatorCredits.quote,'9007199254740993');assert.deepEqual(downloaded.lastHandoff,serverEvidence.lastHandoff);assert.equal(downloaded.lastHandoff.slot,123456789);assert.deepEqual(downloaded.deferredRewards,{wallets:1,amountUnits:'9007199254740993'});
  assert(!raw.includes('PRIVATE_'));assert(!raw.includes('https://'));assert(!raw.includes(recipient));assert.equal(p.calls.length,1);assert.equal(p.calls[0][1],undefined);p.ui.destroy();
});

test('download rejects arbitrary errors, malformed simulation metadata and noncanonical credit strings',async()=>{
  const data=structuredClone(report);data.launches[0].serviceEvidence=[{state:'paused',serviceError:'Unknown PRIVATE_PASSWORD https://PRIVATE_RPC/api-key',retryReason:'The creator rewards token account cannot cover its saved credits. PRIVATE_TOKEN',errorTextOmitted:false,retryReasonTextOmitted:false,errorFingerprint:'PRIVATE_HASH',simulationFailure:{instruction:4,program:'PRIVATE_PROGRAM',customCode:1,errorKind:'Custom',raw:'PRIVATE_BYTES'},rewardsWalletStatus:'PRIVATE_STATUS',creatorCredits:{base:'01',quote:'1e9',protocolQuote:'PRIVATE_SECRET',taxBase:-1,secret:'PRIVATE_KEY'},lastHandoff:{signature:'PRIVATE_SIGNATURE',at:'PRIVATE_TIME',slot:1.5,baseDebit:'1.1',raw:'PRIVATE_RAW'},deferredRewards:{wallets:1,amountUnits:'01',recipients:['PRIVATE_RECIPIENT']}}];
  const p=page({respond:async()=>data});p.ui.load();await p.button.onclick();const raw=p.downloads[0].contents,ev=JSON.parse(raw).launches[0].serviceEvidence[0];
  assert.equal(ev.serviceError,null);assert.equal(ev.retryReason,null);assert.equal(ev.errorTextOmitted,true);assert.equal(ev.retryReasonTextOmitted,true);assert.equal(ev.errorFingerprint,null);assert.equal(ev.simulationFailure,null);assert.equal(ev.rewardsWalletStatus,null);
  assert.deepEqual(ev.creatorCredits,{base:null,quote:null,protocolQuote:null,taxBase:null});assert.equal(ev.lastHandoff.signature,null);assert.equal(ev.lastHandoff.slot,null);assert.deepEqual(ev.deferredRewards,{unavailable:true});assert(!raw.includes('PRIVATE_'));assert(!raw.includes('https://'));p.ui.destroy();
});

test('safe local messages survive the download projection while mismatched simulation codes fail closed',()=>{
  const data=structuredClone(report);data.launches[0].serviceEvidence=[{serviceError:'The creator rewards token account cannot cover its saved credits.',retryReason:'Automatic rewards are waiting for SOL and will retry automatically.',simulationFailure:{instruction:4,program:'11111111111111111111111111111111',customCode:-1,errorKind:'Custom'},deferredRewards:{wallets:0,amountUnits:'0'}}];
  const ev=safeHolderRewardDiagnostics(data).launches[0].serviceEvidence[0];assert.equal(ev.serviceError,data.launches[0].serviceEvidence[0].serviceError);assert.equal(ev.retryReason,data.launches[0].serviceEvidence[0].retryReason);assert.equal(ev.simulationFailure,null);assert.deepEqual(ev.deferredRewards,{wallets:0,amountUnits:'0'});
});
