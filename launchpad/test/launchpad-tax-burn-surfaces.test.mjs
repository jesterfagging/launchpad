import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { parseHTML } from 'linkedom';
import { SOL_MINT } from '../public/launchpad-model.mjs';
import { publicHolderRewards, publicHolderTaxBurn } from '../src/launchpad-holder-rewards.mjs';
import { publicRewardRecord, publicRewardSummary } from '../src/launchpad-public-rewards.mjs';
import { launchAdminRow } from '../src/launchpad-admin.mjs';
import { LaunchProtocolFees } from '../src/launchpad-protocol-fees.mjs';
import { TAX_BURN_MINT, TAX_BURN_WALLET, TAX_BURN_POLICY } from '../src/launchpad-tax-burn.mjs';
import { TAX_BURN_INITIAL_AMOUNT, TAX_BURN_INITIAL_POLICY } from '../src/launchpad-rewards-wallet.mjs';
import { createCoinRewardsView } from '../public/coin-rewards-view.mjs';
import { createLaunchAdmin } from '../public/launch-admin-ui.mjs';
import { publicTaxMaintenance } from '../src/launchpad-tax-maintenance-status.mjs';

const NOW=1_790_000_000_000,signature='3'.repeat(88),key=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
// Automatic burns (v71.24 needs LAUNCHPAD_OFFICIAL_TAX_AUTO_BURN=true for them; `auto` false tests the manual default).
function enabled(t,value='true',auto=value){
  const before=process.env.LAUNCHPAD_OFFICIAL_TAX_BURN_ENABLED,beforeAuto=process.env.LAUNCHPAD_OFFICIAL_TAX_AUTO_BURN;
  process.env.LAUNCHPAD_OFFICIAL_TAX_BURN_ENABLED=value;process.env.LAUNCHPAD_OFFICIAL_TAX_AUTO_BURN=auto;
  t.after(()=>{if(before===undefined)delete process.env.LAUNCHPAD_OFFICIAL_TAX_BURN_ENABLED;else process.env.LAUNCHPAD_OFFICIAL_TAX_BURN_ENABLED=before;if(beforeAuto===undefined)delete process.env.LAUNCHPAD_OFFICIAL_TAX_AUTO_BURN;else process.env.LAUNCHPAD_OFFICIAL_TAX_AUTO_BURN=beforeAuto;});
}
function fixture(){
  const coin={mint:TAX_BURN_MINT,symbol:'LAUNCHPAD',feeMode:'holders',taxBps:200,creatorFeeBps:0,createdAt:NOW-10000,quote:{mint:SOL_MINT,symbol:'SOL'}};
  const chain={curve:key(3),input:{route:'raydium',network:'mainnet-beta',quoteMint:SOL_MINT},keys:{wallet:{address:key(2)},mint:{address:coin.mint}},review:{quoteProgram:key(4),quoteDecimals:9,cpConfigId:key(5)}};
  const launch={id:'b'.repeat(32),...chain,input:{...chain.input,feeMode:'holders',taxBps:200,symbol:'LAUNCHPAD',name:'Launchpad'},keys:{...chain.keys,wallet:{address:key(2),secret:'private-wallet'},rewards:{address:TAX_BURN_WALLET,secret:'private-reward'}},review:{...chain.review,price:{usd:'100'},platformFeeBps:100},feeCustody:'relay',authorizedAt:NOW-10000,createdAt:NOW-10000,autoFees:true,state:'live',credits:{quote:'3500000000',base:'25000000'},holderRewards:{minimumQuoteUnits:'1000000000'},rewardsWallet:{version:1,status:'active',address:TAX_BURN_WALLET,creatorCredits:{base:'0',quote:'0',protocolQuote:'0',taxBase:'0'}},taxBurn:{policy:TAX_BURN_POLICY,selectedAt:NOW-1000,burnCount:1,lastBurnSignature:signature,lastBurnAt:NOW-500},taxProtocol:{policy:'collected-tax-proceeds-v1',shareBps:500,harvestedBase:'30000000',sourceBaseCredit:'15000000',convertedBase:'10000000',burnedBase:'5000000',convertedQuote:'100000000000',holderQuote:'95000000000',accruedQuote:'5000000000',creditQuote:'2000000000',paidQuote:'3000000000',roundingRemainder:'0',handoffBaseLoss:'0',handoffQuoteLoss:'0'},operations:[{kind:'create',state:'confirmed',signature:'4'.repeat(88),slot:100,amount:'0',confirmedAt:NOW-10000},{kind:'payout',state:'confirmed',signature:'5'.repeat(88),slot:101,amount:'2000000000',confirmedAt:NOW-1000,payouts:[{owner:'private-recipient',amount:'2000000000'}]}]};
  return {launch,chain,coin};
}

test('selected LAUNCHPAD tax burning exposes only tracked tax credit and preserves confirmed SOL rewards',t=>{
  enabled(t);const {launch,chain,coin}=fixture(),before=structuredClone(launch);
  launch.operations.push({kind:'tax-burn',state:'pending',signature:'6'.repeat(88),amount:'15000000',raw:'private-signed-bytes'});
  const schedule=publicHolderRewards(launch),record=publicRewardRecord(launch,chain,coin),summary=publicRewardSummary(record,coin,NOW);
  assert.equal(schedule.taxConversion.enabled,false);assert.equal(schedule.taxConversion.nextAt,null);assert.equal(schedule.unconvertedTaxTokens,null);
  assert.equal(schedule.taxBurn.tokensBurned,'5');assert.equal(schedule.taxBurn.pendingTaxTokens,'15');assert.equal(schedule.taxBurn.unattributedTokens,'10');assert.equal(schedule.taxBurn.completedBurns,1);
  assert.equal(summary.taxBurn.tokensBurned,'5');assert.equal(summary.taxBurn.lastBurnSignature,signature);assert.equal(summary.holder.unconvertedTaxTokens,null);assert.equal(summary.holder.pendingQuote,'3.5');assert.equal(summary.holder.distributedQuote,'2');assert.equal(summary.holder.pendingOperations,1);assert.equal(summary.buyback,null);
  assert(!JSON.stringify(record).includes('private-'));assert(!JSON.stringify(summary).includes('totalQuoteSpent'));assert.deepEqual(launch.taxProtocol,before.taxProtocol);assert.deepEqual(launch.credits,before.credits);
});

test('disabling a selected tax burn reports a pause and never relabels tax as a sale',t=>{
  enabled(t,'false');const {launch}=fixture(),view=publicHolderRewards(launch);
  assert.equal(view.taxBurn.selected,true);assert.equal(view.taxBurn.enabled,false);assert.equal(view.taxBurn.paused,true);assert.equal(view.taxConversion.enabled,false);assert.equal(view.unconvertedTaxTokens,null);
  delete launch.taxBurn;assert.equal(publicHolderTaxBurn(launch),null);assert.equal(publicHolderRewards(launch).taxConversion.enabled,true);
});

test('v71.24 default: without automatic burns the collected tax is kept for the owner, shown as manual everywhere',t=>{
  enabled(t,'true','false');const {launch}=fixture(),view=publicHolderRewards(launch);
  assert.deepEqual([view.taxBurn.selected,view.taxBurn.enabled,view.taxBurn.automatic,view.taxBurn.manual,view.taxBurn.manualRequested,view.taxBurn.paused,view.taxBurn.pendingTaxTokens],[true,true,false,true,false,false,'15']);
  assert.equal(view.taxConversion.enabled,false,'the tax is never sold');
  const row=launchAdminRow({id:'a'.repeat(32),username:'owner'},launch,{ownerMatch:true});assert.equal(row.taxBurn.manual,true);assert.equal(row.taxBurn.pendingTaxTokens,'15');
  launch.taxProtocol.creditQuote='0';launch.taxProtocol.paidQuote='5000000000';
  assert.equal(new LaunchProtocolFees({now:()=>NOW}).row({id:'a'},launch,{ownerMatch:true}).taxRevenue.status,'tax_burn_manual');
  launch.taxBurnRequest={version:1,requestId:'f'.repeat(32),actorId:'a'.repeat(32),at:NOW};assert.equal(publicHolderRewards(launch).taxBurn.manualRequested,true);
});

test('a different mint with the LAUNCHPAD ticker is not opted into burning',t=>{
  enabled(t);const {launch}=fixture();delete launch.taxBurn;launch.keys.mint.address=key(25);
  assert.equal(publicHolderTaxBurn(launch),null);assert.equal(publicHolderRewards(launch).taxConversion.enabled,true);
});

test('invalid tax accounting stays unavailable instead of showing balances as burnable',t=>{
  enabled(t);const {launch}=fixture();launch.taxProtocol.sourceBaseCredit='999999999';
  const view=publicHolderRewards(launch);assert.equal(view.taxBurn.accountingUnavailable,true);assert.equal(view.taxBurn.tokensBurned,null);assert.equal(view.taxBurn.pendingTaxTokens,null);assert.equal(view.taxBurn.enabled,false);assert.equal(view.taxConversion.enabled,false);
});

test('one-time initial inventory appears as a separate overlapping approval, not additional tax accrual',t=>{
  enabled(t);const before=process.env.LAUNCHPAD_OFFICIAL_INITIAL_BURN_ENABLED;process.env.LAUNCHPAD_OFFICIAL_INITIAL_BURN_ENABLED='false';t.after(()=>{if(before===undefined)delete process.env.LAUNCHPAD_OFFICIAL_INITIAL_BURN_ENABLED;else process.env.LAUNCHPAD_OFFICIAL_INITIAL_BURN_ENABLED=before;});
  const {launch,chain,coin}=fixture();launch.credits.base=TAX_BURN_INITIAL_AMOUNT;launch.taxBurn.initialInventory={version:1,policy:TAX_BURN_INITIAL_POLICY,approvedBase:TAX_BURN_INITIAL_AMOUNT,status:'authorized',trackedBurnedBase:'0',legacyBurnedBase:'0',completedAt:null,signature:null};
  const schedule=publicHolderRewards(launch);assert.equal(schedule.taxBurn.initialInventory.approvedTokens,'50000000');assert.equal(schedule.taxBurn.pendingTaxTokens,'15');assert.equal(schedule.taxBurn.paused,true);assert.equal(schedule.taxBurn.tokensBurned,'5');
  const {document}=parseHTML('<html><body><section id="rewards"></section></body></html>'),root=document.getElementById('rewards');createCoinRewardsView({document,root}).render({coin,data:publicRewardSummary(publicRewardRecord(launch,chain,coin),coin,NOW)});
  assert.equal(root.querySelector('[data-reward-metric="initial-burn"] strong').title,'50000000 LAUNCHPAD');assert.equal(root.querySelector('[data-reward-metric="tax-reserved"]'),null);assert.match(root.textContent,/includes collected tax/);assert.match(root.textContent,/Tax burns are paused/);assert.doesNotMatch(root.textContent,/is burned automatically after collection confirms/);
});

test('admin pending tax burns are reward work, and old protocol revenue remains payable',t=>{
  enabled(t);const {launch}=fixture();launch.operations.push({kind:'tax-burn',state:'pending',signature:'6'.repeat(88),amount:'15000000',raw:'private-signed-bytes'});
  const row=launchAdminRow({id:'a'.repeat(32),username:'owner'},launch,{ownerMatch:true});
  assert.equal(row.rewardsAction.allowed,true);assert.equal(row.pendingOperation.kind,'tax-burn');assert.equal(row.taxBurn.pendingTaxTokens,'15');assert(!JSON.stringify(row).includes('private-'));
  const protocol=new LaunchProtocolFees({now:()=>NOW}),revenue=protocol.row({id:'a'},launch,{ownerMatch:true}).taxRevenue;
  assert.equal(revenue.shareBps,500);assert.equal(revenue.currentShareBps,0);assert.equal(revenue.pendingQuote,'2');assert.equal(revenue.paidQuote,'3');assert.equal(revenue.status,'awaiting_payout');assert.equal(revenue.taxBurn.tokensBurned,'5');
  launch.taxProtocol.creditQuote='0';launch.taxProtocol.paidQuote='5000000000';assert.equal(protocol.row({id:'a'},launch,{ownerMatch:true}).taxRevenue.status,'tax_burn_enabled');
});

test('public card separates tax burns from SOL payouts and links only valid burn receipts',t=>{
  enabled(t);const {launch,chain,coin}=fixture(),{document}=parseHTML('<html><body><section id="rewards"></section></body></html>'),root=document.getElementById('rewards'),view=createCoinRewardsView({document,root}),data=publicRewardSummary(publicRewardRecord(launch,chain,coin),coin,NOW);
  view.render({coin,data});assert.match(root.textContent,/2% transfer tax/);assert.match(root.textContent,/burned directly/);assert.match(root.textContent,/Separately accrued creator fees in SOL/);assert.match(root.textContent,/Previously owed SOL rewards remain payable/);assert.doesNotMatch(root.textContent,/95% funds holder rewards|Tokens awaiting conversion/);
  assert.equal(root.querySelector('[data-reward-metric="conversion"]'),null);assert.equal(root.querySelector('[data-reward-metric="tax-burned"] strong').title,'5 LAUNCHPAD');assert.equal(root.querySelector('[data-reward-metric="tax-burn-pending"] strong').title,'15 LAUNCHPAD');assert.equal(root.querySelector('[data-reward-metric="tax-reserved"] strong').title,'10 LAUNCHPAD');assert.equal(root.querySelector('a[href="https://solscan.io/tx/'+signature+'"]').rel,'noopener noreferrer');
  data.taxBurn={...data.taxBurn,enabled:false,lastBurnSignature:'javascript:alert(1)'};view.render({coin,data});assert.match(root.textContent,/Tax burns are paused/);assert.equal(root.querySelector('a[href^="javascript:"]'),null);assert.equal(root.querySelector('a[href^="https://solscan.io/tx/"]'),null);
});

test('admin tax-burn display preserves owed SOL and does not turn other credit into burnable tokens',async t=>{
  enabled(t);const prior=globalThis.document,{document}=parseHTML('<html><body></body></html>');globalThis.document=document;t.after(()=>{globalThis.document=prior;});const {launch}=fixture(),row=launchAdminRow({id:'a'.repeat(32),username:'owner'},launch,{ownerMatch:true});row.deferredRewards={wallets:187,amount:'0.03'};
  let writes=0;const ui=createLaunchAdmin({api:async(_,body)=>{if(body)writes++;return{launches:[row],total:1,offset:0,nextOffset:null};},security:{},getAccount:()=>({id:'admin',role:'admin',mfaEnabled:true}),message(){}});await ui.load();
  const section=ui.element.querySelector('.launch-admin-reward');assert.match(section.textContent,/15 LAUNCHPAD collected tax awaiting burn/);assert.match(section.textContent,/10 LAUNCHPAD other token credit reserved/);assert.match(section.textContent,/0.03 SOL is still owed to 187 wallets/);assert.doesNotMatch(section.textContent,/25 LAUNCHPAD awaiting burn|Tax conversion limits/);assert.equal(writes,0);
});

test('saved automation opt-out takes precedence over runtime flags and burn permission in both views',async t=>{
  enabled(t);const {launch,chain,coin}=fixture();launch.feeAutomation={enabled:false,source:'user',updatedAt:NOW};launch.state='paused';
  const row=launchAdminRow({id:'a'.repeat(32),username:'owner'},launch,{ownerMatch:true}),data=publicRewardSummary(publicRewardRecord(launch,chain,coin),coin,NOW);
  assert.equal(row.taxBurn.enabled,true);assert.equal(row.rewardsAutomation.enabled,false);assert.equal(row.rewardsAutomation.status,'paused');assert.equal(data.enabled,false);assert.equal(data.automation.enabled,false);
  const prior=globalThis.document,{document}=parseHTML('<html><body><section id="rewards"></section></body></html>');globalThis.document=document;t.after(()=>{globalThis.document=prior;});const root=document.getElementById('rewards');createCoinRewardsView({document,root}).render({coin,data});
  assert.match(root.textContent,/Automatic tax collection is paused with the reward service/);assert.doesNotMatch(root.textContent,/Automatic tax collection and burning are enabled/);
  const ui=createLaunchAdmin({api:async()=>({launches:[row],total:1,offset:0,nextOffset:null}),security:{},getAccount:()=>({id:'admin',role:'admin',mfaEnabled:true}),message(){}});await ui.load();
  assert.match(ui.element.textContent,/Automatic tax collection is paused with this coin’s reward service/);assert.match(ui.element.textContent,/Use Resume rewards/);assert.match(ui.element.textContent,/3.5 SOL recorded holder rewards/);assert.match(ui.element.textContent,/not the wallet’s spendable gas balance/);
});

test('tax status reports blocked automation honestly without relabeling it as operator opt-out',t=>{
  enabled(t);const {launch,chain,coin}=fixture();launch.feeAutomation={enabled:true,source:'user',updatedAt:NOW};launch.state='error';launch.error='Saved tax receipt needs review.';
  const row=launchAdminRow({id:'a'.repeat(32)},launch,{ownerMatch:true}),data=publicRewardSummary(publicRewardRecord(launch,chain,coin),coin,NOW);
  assert.equal(row.rewardsAutomation.enabled,true);assert.equal(row.rewardsAutomation.status,'blocked');assert.equal(data.enabled,false);assert.equal(data.automation.enabled,true);
  const {document}=parseHTML('<html><body><section id="rewards"></section></body></html>'),root=document.getElementById('rewards');createCoinRewardsView({document,root}).render({coin,data});
  assert.equal(root.querySelector('#rewards-state').textContent,'Needs attention');assert.match(root.textContent,/Automatic tax collection and burning need operator attention/);
});

test('admin uncollected-tax check is on demand, read only and distinguishes delayed estimates',async t=>{
  enabled(t);const prior=globalThis.document,{document}=parseHTML('<html><body></body></html>');globalThis.document=document;t.after(()=>{globalThis.document=prior;});const {launch,chain,coin}=fixture(),row=launchAdminRow({id:'a'.repeat(32),username:'owner'},launch,{ownerMatch:true});
  const data=publicRewardSummary(publicRewardRecord(launch,chain,coin),coin,NOW);Object.assign(data.holder,{withheldTokens:'20230593.990674',withheldStale:false,withheldAsOf:Date.now()});const calls=[];
  const ui=createLaunchAdmin({api:async(path,body)=>{calls.push({path,body});return path.startsWith('/api/explore/rewards?')?data:{launches:[row],total:1,offset:0,nextOffset:null};},security:{authorize(){throw Error('Read-only operation must not request a signature');}},getAccount:()=>({id:'admin',role:'admin',mfaEnabled:true}),message(){}});await ui.load();
  assert.equal(calls.length,1);assert.match(ui.element.textContent,/Uncollected tax has not been checked/);const check=ui.element.querySelector('[data-admin-tax-check]');await check.onclick();
  assert.equal(calls.at(-1).path,'/api/explore/rewards?mint='+TAX_BURN_MINT);assert.equal(calls.at(-1).body,undefined);assert.match(ui.element.querySelector('.launch-admin-uncollected-tax').textContent,/20230593.990674 LAUNCHPAD uncollected transfer tax · estimate/);assert.match(ui.element.textContent,/15 LAUNCHPAD collected tax awaiting burn/);
  data.holder.withheldStale=true;await check.onclick();assert.match(ui.element.querySelector('.launch-admin-uncollected-tax').textContent,/last observed estimate; balance delayed/);
  data.holder.withheldTokens=null;await check.onclick();assert.match(ui.element.querySelector('.launch-admin-uncollected-tax').textContent,/currently unavailable/);assert.doesNotMatch(ui.element.querySelector('.launch-admin-uncollected-tax').textContent,/20230593/);
  data.mint=key(7);await check.onclick();assert.match(ui.element.querySelector('.launch-admin-uncollected-tax').textContent,/response did not match this coin/);
});

test('late tax reads cannot repopulate cleared administration or cross account sessions',async t=>{
  enabled(t);const prior=globalThis.document,{document}=parseHTML('<html><body></body></html>');globalThis.document=document;t.after(()=>{globalThis.document=prior;});
  for(const change of ['clear','account']){
    const {launch}=fixture(),row=launchAdminRow({id:'a'.repeat(32),username:'owner'},launch,{ownerMatch:true});let account={id:'admin',role:'admin',mfaEnabled:true},finish,reads=0;
    const ui=createLaunchAdmin({api:async path=>path.startsWith('/api/explore/rewards?')?(reads++,new Promise(resolve=>{finish=resolve;})):{launches:[row],total:1,offset:0,nextOffset:null},security:{},getAccount:()=>account,message(){}});await ui.load();
    const check=ui.element.querySelector('[data-admin-tax-check]'),note=ui.element.querySelector('.launch-admin-uncollected-tax'),before=note.textContent,pending=check.onclick();await check.onclick();assert.equal(reads,1);
    if(change==='clear')ui.clear();else account={...account,id:'other-admin'};finish({mint:TAX_BURN_MINT,mode:'holders',quote:{mint:SOL_MINT},taxBurn:{selected:true},holder:{withheldTokens:'123',withheldStale:false,withheldAsOf:Date.now()}});await pending;
    assert.equal(note.textContent,before);if(change==='clear'){assert.equal(ui.element.hidden,true);assert.equal(ui.element.querySelector('.launch-admin-uncollected-tax'),null);}
  }
});

test('tax maintenance retry is separate from holder payout retry and publicly exposes timing only',async t=>{
  enabled(t);const {launch,chain,coin}=fixture(),at=Date.now()+300000;
  launch.feesRequested=true;launch.rewardRetry={at:at+600000,attempt:1,kind:'funding',reason:'Private holder funding reason'};
  launch.taxMaintenance={version:1,nextAt:at,lastAttemptAt:at-60000,lastCompletedAt:at-120000,retry:{at,attempt:2,kind:'funding',reason:'Insufficient SOL in wallet '+TAX_BURN_WALLET+'. Add at least 0.001 SOL. https://private.rpc/key'},privateKey:'NEVER-EXPORT'};
  const before=structuredClone(launch),admin=publicTaxMaintenance(launch,{includeReason:true}),record=publicRewardRecord(launch,chain,coin),data=publicRewardSummary(record,coin,Date.now());
  assert.equal(admin.retry.at,at);assert.match(admin.retry.reason,/Insufficient SOL in wallet/);assert.doesNotMatch(admin.retry.reason,/private\.rpc/);assert.equal(data.taxMaintenance.retry.at,at);assert.equal(data.taxMaintenance.retry.reason,undefined);assert(!JSON.stringify(record).includes('NEVER-EXPORT'));assert(!JSON.stringify(record).includes('Insufficient SOL in wallet'));assert.deepEqual(launch,before);
  const prior=globalThis.document,{document}=parseHTML('<html><body><section id="rewards"></section></body></html>');globalThis.document=document;t.after(()=>{globalThis.document=prior;});const root=document.getElementById('rewards');createCoinRewardsView({document,root}).render({coin,data,now:Date.now()});
  assert.match(root.textContent,/Next automatic holder reward check/);assert.match(root.textContent,/Next tax check:/);
  const row=launchAdminRow({id:'a'.repeat(32)},launch,{ownerMatch:true}),ui=createLaunchAdmin({api:async()=>({launches:[row],total:1,offset:0,nextOffset:null}),security:{},getAccount:()=>({id:'admin',role:'admin',mfaEnabled:true}),message(){}});await ui.load();
  assert.match(ui.element.querySelector('.launch-admin-tax-retry').textContent,/Tax retry reason: Insufficient SOL in wallet/);assert.match(ui.element.querySelector('.launch-admin-tax-next').textContent,/Next automatic tax check:/);
  delete launch.taxMaintenance.retry;const independent=publicRewardSummary(publicRewardRecord(launch,chain,coin),coin,Date.now());createCoinRewardsView({document,root}).render({coin,data:independent});assert.match(root.textContent,/checked separately from holder payouts/);assert.doesNotMatch(root.textContent,/Tax collection and burning are waiting to retry/);
  launch.feeAutomation={enabled:false};launch.state='paused';const pausedRow=launchAdminRow({id:'a'.repeat(32)},launch,{ownerMatch:true});row.rewardsAutomation=pausedRow.rewardsAutomation;row.state=pausedRow.state;await ui.load();assert.equal(ui.element.querySelector('.launch-admin-tax-next'),null);
});
