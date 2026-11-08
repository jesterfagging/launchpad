import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createAdminTreasury } from '../public/admin-treasury-ui.mjs';
import { includeManualProtocolHistory, MANUAL_PROTOCOL_HISTORY } from '../src/protocol-manual-history.mjs';

const admin={id:'admin',role:'admin',mfaEnabled:true};
const wallet='11111111111111111111111111111111',curveMint='7rvRFpzP5W18yZcNpPNqtWgPTxLaFrnutz5QPxXpyupc',solMint='So11111111111111111111111111111111111111112',signature='1'.repeat(64);
const totals={receivedSol:'9007199254740993123456',convertedSol:'1000000000',buybackAvailable:'500000000',retainedSol:'500000000',buybackSpent:'1',curveBurned:'123456',burnAvailable:'321',networkSpent:'5000'};
const data={version:1,configured:true,enabled:true,address:wallet,recipient:wallet,expectedRecipient:wallet,previousRecipients:[curveMint],curveMint,curveDecimals:6,totals,availableRetainedSol:'490000000',pendingWithdrawal:null,assets:[{symbol:'OPENAI',mint:curveMint,decimals:6,received:'1000000',credit:'1000000',converted:'0',error:'private-rpc-error',nextAttemptAt:1800840000000}],recognitionAssets:[{mint:solMint,symbol:'SOL',decimals:9}],pending:{kind:'buy',signature,state:'pending'},history:[{kind:'burn',signature,state:'confirmed',confirmedAt:1800840000000}],updatedAt:1800840000000};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function page({account=admin,respond=async()=>data,authorize=async()=>({password:'private-password',code:'123456'}),copyText,clock}={}){
  const {document}=parseHTML('<html><body></body></html>');Object.defineProperty(document,'hidden',{value:false,writable:true});
  Object.defineProperty(document.defaultView.HTMLSelectElement.prototype,'value',{configurable:true,get(){return [...this.options].find(option=>option.selected)?.value||this.options[0]?.value||'';},set(value){for(const option of this.options)option.removeAttribute('selected');[...this.options].find(option=>option.value===String(value))?.setAttribute('selected','');}});
  const calls=[],messages=[],authorizations=[],timers=new Map();let nextTimer=0,configured=0;
  const ui=createAdminTreasury({document,getAccount:()=>account,api:async(path,body)=>{calls.push({path,body});return respond(path,body);},copyText,clock,security:{authorize:async(...args)=>{authorizations.push(args);return authorize(...args);}},message:(...args)=>messages.push(args),onConfigured:async()=>{configured++;},setTimer:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearTimer:id=>timers.delete(id)});document.body.append(ui.element);
  return{ui,document,calls,messages,authorizations,timers,get:id=>document.getElementById(id),setAccount:value=>{account=value;},get configured(){return configured;},visibility:hidden=>{document.hidden=hidden;document.dispatchEvent(new document.defaultView.Event('visibilitychange'));}};
}
const submit=node=>node.onsubmit({preventDefault(){}});

test('paused treasury separates actual finalized wallet SOL from unchanged recorded revenue and buyback allocations',async()=>{
  const now=1800840000000,p=page({clock:()=>now,respond:async()=>({...data,enabled:false,walletBalance:{status:'available',address:wallet,lamports:'230000000',observedAt:now,slot:5,commitment:'finalized'}})});
  await p.ui.load();assert.equal(p.get('admin-treasury-wallet-balance-value').textContent,'0.23 SOL');assert.match(p.get('admin-treasury-wallet-balance').textContent,/Actual wallet balance/);assert.match(p.get('admin-treasury-wallet-balance').textContent,/not automatically treated as protocol revenue/);assert.match(p.ui.element.textContent,/Available buyback budget0\.5 SOL/);assert.equal(p.get('admin-treasury-toggle').textContent,'Enable automatic buybacks');assert.equal(p.calls.length,1);assert.equal(p.authorizations.length,0);p.ui.destroy();
});

test('wallet balance freshness, identity and integer validation distinguish unavailable data from a verified zero',async()=>{
  const now=1800840000000,valid={status:'available',address:wallet,lamports:'0',observedAt:now,slot:5,commitment:'finalized'};
  for(const patch of [{},{status:'unavailable'},{address:curveMint},{observedAt:now-120001},{observedAt:now+1},{lamports:'18446744073709551616'},{lamports:'not-an-amount'},{commitment:'processed'},{slot:-1}]){
    const p=page({clock:()=>now,respond:async()=>({...data,walletBalance:{...valid,...patch}})});await p.ui.load();assert.equal(p.get('admin-treasury-wallet-balance-value').textContent,Object.keys(patch).length?'—':'0 SOL');p.ui.destroy();
  }
});

test('a failed treasury refresh clears the displayed actual balance while preserving recorded ledger values',async()=>{
  const now=1800840000000;let fail=false;const p=page({clock:()=>now,respond:async()=>{if(fail)throw Error('private provider details');return{...data,walletBalance:{status:'available',address:wallet,lamports:'230000000',observedAt:now,slot:5,commitment:'finalized'}};}});
  await p.ui.load();fail=true;await p.ui.load();assert.equal(p.get('admin-treasury-wallet-balance-value').textContent,'—');assert.match(p.ui.element.textContent,/Available buyback budget0\.5 SOL/);assert(!p.ui.element.textContent.includes('private provider details'));assert.equal(p.ui.element.querySelectorAll('#admin-treasury-wallet-balance').length,1);p.ui.destroy();
});

test('treasury renders exact SOL totals, pending burns and transactions without raw errors or secrets',async()=>{
  const p=page();await p.ui.load();assert.equal(p.calls[0].path,'/api/admin/protocol-treasury');
  assert.match(p.ui.element.textContent,/9,007,199,254,740\.993123456 SOL/);assert.match(p.ui.element.textContent,/LAUNCHPAD burned0\.123456 LAUNCHPAD/);assert.match(p.ui.element.textContent,/LAUNCHPAD awaiting burn0\.000321 LAUNCHPAD/);
  assert.match(p.ui.element.textContent,/1% slippage/);assert.match(p.ui.element.textContent,/0\.01 SOL operating reserve/);assert.match(p.ui.element.textContent,/0\.001 SOL/);assert.match(p.ui.element.textContent,/Waiting to retry conversion/);
  assert(!p.ui.element.textContent.includes('private-rpc-error'));assert(!p.ui.element.textContent.includes('private-password'));
  const links=[...p.ui.element.querySelectorAll('a')];assert(links.some(link=>link.href==='https://solscan.io/tx/'+signature));assert(links.every(link=>link.rel==='noopener noreferrer'));
  assert.equal(p.get('admin-treasury-toggle').textContent,'Pause automatic buybacks');assert.equal(p.authorizations.length,0);assert.equal([...p.timers.values()][0].ms,15000);p.ui.destroy();
});
test('enabling an owner-provided wallet needs backup acknowledgement and fresh MFA, binds both reviewed addresses and refreshes fee settings',async()=>{
  const disabled={...data,enabled:false,signerOrigin:'owner-provided',ownerControlled:true};
  const p=page({respond:async(path,body)=>body?data:disabled});await p.ui.load();p.get('admin-treasury-reason').value='Enable the revenue policy';
  assert.match(p.ui.element.textContent,/I have backed up this wallet and verified its address/);assert.match(p.ui.element.textContent,/Your backup gives you direct wallet access/);
  await submit(p.get('admin-treasury-configure'));assert.equal(p.authorizations.length,0);assert.equal(p.calls.length,1);
  p.get('admin-treasury-ack').checked=true;await submit(p.get('admin-treasury-configure'));
  assert.equal(p.authorizations[0][1].requireCode,true);assert.deepEqual(p.calls[1],{path:'/api/admin/protocol-treasury/configure',body:{enabled:true,expectedRecipient:wallet,expectedTreasuryAddress:wallet,reason:'Enable the revenue policy',password:'private-password',code:'123456'}});
  assert.equal(p.configured,1);assert.equal(p.get('admin-treasury-reason').value,'');assert.equal(p.get('admin-treasury-ack').checked,false);assert(!p.ui.element.textContent.includes('private-password'));p.ui.destroy();
});
test('fresh or invalid treasury setup cannot enable, recognize revenue or withdraw and never requests browser key entry',async()=>{
  for(const extra of [{configured:false,address:null},{configured:false,address:wallet},{configured:true,address:'invalid'}]){
    const p=page({respond:async()=>({...data,enabled:false,...extra})});await p.ui.load();
    assert.equal(p.get('admin-treasury-toggle').disabled,true);assert.equal(p.get('admin-treasury-ack').disabled,true);assert.equal(p.get('admin-treasury-recognize-submit').disabled,true);assert.equal(p.get('admin-treasury-withdraw-submit').disabled,true);
    assert.match(p.ui.element.textContent,/Wallet setup required/);assert.match(p.ui.element.textContent,/Installing your wallet does not activate automation, redirect fees or transfer funds/);
    assert(!p.ui.element.textContent.includes('created when you enable'));assert.equal(p.ui.element.querySelector('input[type="password"],input[name="secretKey"],textarea'),null);
    p.get('admin-treasury-reason').value='Enable the revenue policy';p.get('admin-treasury-ack').checked=true;await submit(p.get('admin-treasury-configure'));assert.equal(p.calls.length,1);assert.equal(p.authorizations.length,0);p.ui.destroy();
  }
});
test('existing generated treasury keeps enable and pause controls without claiming an owner backup',async()=>{
  const p=page({respond:async(path,body)=>body?data:{...data,enabled:false}});await p.ui.load();
  assert.equal(p.get('admin-treasury-toggle').disabled,false);assert.match(p.ui.element.textContent,/Existing service-managed treasury wallet/);assert(!p.ui.element.textContent.includes('I have backed up this wallet'));
  p.get('admin-treasury-reason').value='Resume existing automation';p.get('admin-treasury-ack').checked=true;await submit(p.get('admin-treasury-configure'));
  assert.equal(p.calls[1].body.expectedTreasuryAddress,wallet);assert.equal(p.get('admin-treasury-toggle').textContent,'Pause automatic buybacks');p.ui.destroy();
});
test('refresh preserves an unchanged wallet acknowledgement but clears it when the reviewed treasury or recipient changes',async()=>{
  let state={...data,enabled:false,signerOrigin:'owner-provided',ownerControlled:true};const p=page({respond:async()=>state});await p.ui.load();p.get('admin-treasury-ack').checked=true;
  await p.ui.load();assert.equal(p.get('admin-treasury-ack').checked,true);
  state={...state,address:curveMint};await p.ui.load();assert.equal(p.get('admin-treasury-ack').checked,false);
  p.get('admin-treasury-ack').checked=true;state={...state,expectedRecipient:solMint};await p.ui.load();assert.equal(p.get('admin-treasury-ack').checked,false);p.ui.destroy();
});
test('pause requests only change enabled state after MFA and preserve allocations',async()=>{
  const p=page({respond:async(path,body)=>body?{...data,enabled:false}:data});await p.ui.load();p.get('admin-treasury-reason').value='Pause treasury processing';
  assert.match(p.ui.element.textContent,/Already submitted transactions are still checked/);
  await submit(p.get('admin-treasury-configure'));assert.deepEqual(p.calls[1].body,{enabled:false,expectedRecipient:wallet,reason:'Pause treasury processing',password:'private-password',code:'123456'});
  assert.equal(p.get('admin-treasury-toggle').textContent,'Enable automatic buybacks');assert.match(p.ui.element.textContent,/Available buyback budget0\.5 SOL/);p.ui.destroy();
});
test('recognition accepts only listed revenue mints and verified signature shape after MFA',async()=>{
  const p=page();await p.ui.load();p.get('admin-treasury-signature').value=signature;p.get('admin-treasury-transfer-reason').value='Protocol fees collected previously';
  await submit(p.get('admin-treasury-recognize'));assert.deepEqual(p.calls[1],{path:'/api/admin/protocol-treasury/recognize',body:{signature,mint:solMint,reason:'Protocol fees collected previously',password:'private-password',code:'123456'}});assert.equal(p.authorizations[0][1].requireCode,true);assert.equal(p.get('admin-treasury-signature').value,'');
  p.get('admin-treasury-signature').value='not-a-signature';await submit(p.get('admin-treasury-recognize'));assert.equal(p.calls.length,2);
  const malicious=p.document.createElement('option');malicious.value=wallet;malicious.textContent='Unrecognized deposit';p.get('admin-treasury-asset').append(malicious);p.get('admin-treasury-asset').value=wallet;p.get('admin-treasury-signature').value=signature;
  await submit(p.get('admin-treasury-recognize'));assert.equal(p.calls.length,2);assert.match(p.messages.at(-1)[0],/recorded protocol revenue asset/);p.ui.destroy();
});
test('unconfigured treasury and no prior revenue cannot recognize arbitrary wallet deposits',async()=>{
  for(const extra of [{configured:false,address:''},{previousRecipients:[]},{recognitionAssets:[]}]){const p=page({respond:async()=>({...data,...extra})});await p.ui.load();assert.equal(p.get('admin-treasury-recognize-submit').disabled,true);await submit(p.get('admin-treasury-recognize'));assert.equal(p.authorizations.length,0);p.ui.destroy();}
});
test('polling preserves all drafts, does not overlap, pauses when hidden and cleans up on logout',async()=>{
  const p=page();await p.ui.load();p.get('admin-treasury-reason').value='Unsaved setting';p.get('admin-treasury-signature').value=signature;p.get('admin-treasury-transfer-reason').value='Unsaved recognition';
  [...p.timers.values()][0].fn();await tick();assert.equal(p.calls.length,2);assert.equal(p.get('admin-treasury-reason').value,'Unsaved setting');assert.equal(p.get('admin-treasury-signature').value,signature);assert.equal(p.get('admin-treasury-transfer-reason').value,'Unsaved recognition');
  p.visibility(true);assert.equal(p.timers.size,0);await p.ui.load();assert.equal(p.calls.length,2);p.visibility(false);await tick();assert.equal(p.calls.length,3);
  p.setAccount(null);await p.ui.load();assert.equal(p.ui.element.hidden,true);assert.equal(p.timers.size,0);assert.equal(p.get('admin-treasury-signature').value,'');assert.equal(p.ui.element.querySelector('.admin-protocol-facts').children.length,0);p.ui.destroy();
});
test('late reads and MFA prompts cannot expose data or submit after account changes or clear',async()=>{
  let finish;const p=page({respond:()=>new Promise(resolve=>{finish=resolve;})});const load=p.ui.load();p.ui.clear();finish(data);await load;assert.equal(p.ui.element.hidden,true);assert.equal(p.timers.size,0);p.ui.destroy();
  let authorize;const pending=page({authorize:()=>new Promise(resolve=>{authorize=resolve;})});await pending.ui.load();pending.get('admin-treasury-reason').value='Pause for maintenance';const mutation=submit(pending.get('admin-treasury-configure'));pending.setAccount({...admin,id:'other-admin'});authorize({password:'private',code:'123456'});await mutation;assert.equal(pending.calls.length,1);pending.ui.destroy();
});
test('permission gates, activation pending, cancellation and service errors never trigger extra mutations',async()=>{
  for(const account of [null,{role:'user',mfaEnabled:true},{role:'admin',mfaEnabled:false}]){const p=page({account});await p.ui.load();assert.equal(p.calls.length,0);assert.equal(p.ui.element.hidden,true);p.ui.destroy();}
  const activating=page({respond:async()=>({...data,activationPending:true})});await activating.ui.load();assert.equal(activating.get('admin-treasury-toggle').disabled,true);activating.ui.destroy();
  const p=page({authorize:async()=>{throw Error('Cancelled.');}});await p.ui.load();p.get('admin-treasury-reason').value='Pause for maintenance';await submit(p.get('admin-treasury-configure'));assert.equal(p.messages.length,0);assert.equal(p.calls.length,1);p.ui.destroy();
  const failing=page({respond:async(path,body)=>{if(body)throw Error('https://rpc.invalid/private-api-secret');return data;}});await failing.ui.load();failing.get('admin-treasury-reason').value='Pause for maintenance';await submit(failing.get('admin-treasury-configure'));assert.equal(failing.calls.length,2);assert.equal(failing.get('admin-treasury-toggle').textContent,'Pause automatic buybacks');assert(!JSON.stringify(failing.messages).includes('private-api-secret'));assert.equal(failing.timers.size,1);failing.ui.destroy();
});
test('untrusted metadata stays inert and raw token units are labeled when decimals are unavailable',async()=>{
  const p=page({respond:async()=>({...data,curveDecimals:null,address:'javascript:alert(1)',assets:[{...data.assets[0],symbol:'<img src=x onerror=bad()>',mint:'javascript:alert(1)'}],history:[{kind:'<script>bad()</script>',signature:'javascript:alert(1)'}]})});await p.ui.load();assert.equal(p.ui.element.querySelector('script,img'),null);assert.match(p.ui.element.textContent,/<img src=x/);assert.match(p.ui.element.textContent,/123,456 base units/);assert([...p.ui.element.querySelectorAll('a')].every(link=>link.href.startsWith('https://solscan.io/')));p.ui.destroy();
});
test('withdrawal validates the retained allocation exactly and queues a single MFA protected request',async()=>{
  const p=page({respond:async(path,body)=>body?{...data,pendingWithdrawal:{requestId:body.requestId,amount:'100000001',recipient:curveMint}}:data});await p.ui.load();
  p.get('admin-treasury-withdraw-recipient').value=curveMint;p.get('admin-treasury-withdraw-reason').value='Platform operating expenses';
  for(const invalid of ['0','-1','0.490000001','0.1000000001','1e-9']){p.get('admin-treasury-withdraw-amount').value=invalid;await submit(p.get('admin-treasury-withdraw'));}assert.equal(p.authorizations.length,0);
  p.get('admin-treasury-withdraw-amount').value='0.100000001';await submit(p.get('admin-treasury-withdraw'));
  const post=p.calls[1];assert.equal(post.path,'/api/admin/protocol-treasury/withdraw');assert.equal(post.body.amountSol,'0.100000001');assert.equal(post.body.recipient,curveMint);assert.match(post.body.requestId,/^[a-f0-9-]{36}$/);assert.equal(p.authorizations[0][1].requireCode,true);
  assert.match(p.ui.element.textContent,/Queued withdrawal: 0\.100000001 SOL/);assert.equal(p.get('admin-treasury-withdraw-submit').disabled,true);assert.equal(p.get('admin-treasury-withdraw-amount').value,'');p.ui.destroy();
});
test('uncertain withdrawal retries preserve request identity and cannot switch amount or recipient',async()=>{
  let fail=true;const p=page({respond:async(path,body)=>{if(body&&fail)throw Error('Connection lost');return data;}});await p.ui.load();p.get('admin-treasury-withdraw-recipient').value=curveMint;p.get('admin-treasury-withdraw-reason').value='Platform operating expenses';p.get('admin-treasury-withdraw-amount').value='0.1';
  await submit(p.get('admin-treasury-withdraw'));const request=p.calls[1].body.requestId;p.get('admin-treasury-withdraw-amount').value='0.2';await submit(p.get('admin-treasury-withdraw'));assert.equal(p.calls.length,2);assert.match(p.messages.at(-1)[0],/original details/);
  p.get('admin-treasury-withdraw-amount').value='0.1';fail=false;await submit(p.get('admin-treasury-withdraw'));assert.equal(p.calls[2].body.requestId,request);assert.equal(p.get('admin-treasury-withdraw-amount').value,'');
  p.get('admin-treasury-withdraw-amount').value='0.2';p.get('admin-treasury-withdraw-recipient').value=curveMint;p.get('admin-treasury-withdraw-reason').value='A different platform expense';await submit(p.get('admin-treasury-withdraw'));assert.notEqual(p.calls[3].body.requestId,request);p.ui.destroy();
});
test('cancelled withdrawal MFA does not bind a request and logout removes all withdrawal details',async()=>{
  let cancel=true;const p=page({authorize:async()=>{if(cancel)throw Error('Cancelled.');return {code:'123456'};}});await p.ui.load();p.get('admin-treasury-withdraw-recipient').value=curveMint;p.get('admin-treasury-withdraw-reason').value='Platform operating expenses';p.get('admin-treasury-withdraw-amount').value='0.1';await submit(p.get('admin-treasury-withdraw'));assert.equal(p.calls.length,1);
  cancel=false;p.get('admin-treasury-withdraw-amount').value='0.2';await submit(p.get('admin-treasury-withdraw'));assert.equal(p.calls[1].body.amountSol,'0.2');p.get('admin-treasury-withdraw-recipient').value=curveMint;p.ui.clear();assert.equal(p.get('admin-treasury-withdraw-recipient').value,'');assert.equal(p.get('admin-treasury-withdraw-submit').disabled,true);p.ui.destroy();
});

test('unconfigured treasury offers a collapsed VPS setup command without browser key fields or activation',async()=>{
  let snapshot={...data,configured:false,address:null,enabled:false},copied='';const p=page({respond:async()=>snapshot,copyText:async text=>{copied=text;}});await p.ui.load();
  const setup=p.get('admin-treasury-setup'),command=p.get('admin-treasury-setup-command').textContent;
  assert.equal(setup.hidden,false);assert(!setup.open);assert.match(setup.textContent,/Set up your own treasury wallet/);assert.match(command,/^sudo systemd-run --pty --wait --collect --uid=launchpad /);assert.match(command,/--property=EnvironmentFile=\/etc\/curve.env/);assert.match(command,/--property=UMask=0077 --property=LimitCORE=0 \/usr\/bin\/node \/opt\/curve\/app\/scripts\/setup-treasury-wallet.mjs$/);
  assert.match(setup.textContent,/Setup does not enable spending or redirect fees/);assert.equal(setup.querySelector('input,textarea'),null);assert.equal(p.get('admin-treasury-toggle').disabled,true);
  await p.get('admin-treasury-setup-copy').onclick();assert.equal(copied,command);assert.match(setup.textContent,/Command copied/);assert.equal(p.calls.length,1);assert.equal(p.authorizations.length,0);
  setup.open=true;await p.ui.load();assert.equal(setup.open,true);
  snapshot={...data,enabled:false};await p.ui.load();assert.equal(setup.hidden,true);assert.equal(setup.open,false);await p.get('admin-treasury-setup-copy').onclick();assert.equal(p.calls.length,3);p.ui.destroy();
});


test('admin shows verified manual protocol buybacks separately from unchanged automatic allocations and controls',async()=>{
  const manualHistory=MANUAL_PROTOCOL_HISTORY;
  const recordedBuybackTotals=includeManualProtocolHistory({status:'unconfigured',solSpent:'0',curveBought:'0',curveBurned:'0',history:[]},Math.max(...manualHistory.map(row=>row.confirmedAt)));
  const p=page({respond:async()=>({...data,configured:false,address:'',enabled:false,recordedBuybackTotals})});await p.ui.load();const panel=p.get('admin-treasury-recorded-buybacks');
  assert.equal(panel.hidden,false);assert.match(panel.textContent,/SOL spent8\.916645858 SOL/);assert.match(panel.textContent,/LAUNCHPAD acquired2,314,783\.626758 LAUNCHPAD/);assert.match(panel.textContent,/LAUNCHPAD burned7,414,695\.326644 LAUNCHPAD/);assert.match(panel.textContent,/Manual receipts do not change the available automatic buyback budget/);assert.match(p.ui.element.textContent,/Automatic treasury accounting/);assert.match(p.ui.element.textContent,/Available buyback budget0\.5 SOL/);
  const links=[...panel.querySelectorAll('a')];assert.equal(links.length,7);assert.deepEqual(links.map(row=>row.href).sort(),manualHistory.map(row=>'https://solscan.io/tx/'+row.signature).sort());assert(links.every(row=>row.rel==='noopener noreferrer'));assert.equal(panel.querySelector('details').hasAttribute('open'),false);assert.equal(p.get('admin-treasury-toggle').disabled,true);assert.equal(p.calls.length,1);assert.equal(p.authorizations.length,0);p.ui.clear();assert.equal(panel.hidden,true);assert.equal(panel.textContent,'');p.ui.destroy();
});
test('admin identifies contributed burns without adding a protocol purchase or automatic budget',async()=>{
  const recordedBuybackTotals={status:'available',manualIncluded:true,curveDecimals:6,solSpent:'1456699449',curveBought:'1233140587131',curveBurned:'6333052287017',manualContributionBurned:'5099911699886',history:[{kind:'burn',source:'manual',funding:'external-contribution',signature,confirmedAt:1790647124000}]};
  const p=page({respond:async()=>({...data,recordedBuybackTotals})});await p.ui.load();const panel=p.get('admin-treasury-recorded-buybacks');
  assert.match(panel.textContent,/SOL spent1\.456699449 SOL/);assert.match(panel.textContent,/LAUNCHPAD acquired1,233,140\.587131 LAUNCHPAD/);assert.match(panel.textContent,/LAUNCHPAD burned6,333,052\.287017 LAUNCHPAD/);
  assert.match(panel.textContent,/5,099,911\.699886 LAUNCHPAD in this burn total came from tokens contributed to the treasury; no protocol buyback spend is recorded for them\./);
  assert.equal(panel.querySelector('a').textContent,'Contributed LAUNCHPAD burn');assert.equal(panel.querySelector('a').href,'https://solscan.io/tx/'+signature);assert.match(p.ui.element.textContent,/Available buyback budget0\.5 SOL/);assert.equal(p.calls.length,1);assert.equal(p.authorizations.length,0);p.ui.destroy();
});
test('admin does not invent a contributed burn amount from absent or invalid contribution metadata',async()=>{
  for(const extra of [{},{manualContributionBurned:null},{manualContributionBurned:'0'},{manualContributionBurned:'-1'},{manualContributionBurned:'1e8'},{manualContributionBurned:5099911699886},{manualContributionBurned:'5099911699886',curveDecimals:null}]){
    const recordedBuybackTotals={status:'available',manualIncluded:true,curveDecimals:6,solSpent:'0',curveBought:'0',curveBurned:'0',history:[],...extra};
    const p=page({respond:async()=>({...data,recordedBuybackTotals})});await p.ui.load();assert.doesNotMatch(p.get('admin-treasury-recorded-buybacks').textContent,/tokens contributed to the treasury/);p.ui.destroy();
  }
});
test('a projection without eligible historical manual receipts does not invent a manual total',async()=>{
  const recordedBuybackTotals=includeManualProtocolHistory({status:'unconfigured',history:[]},MANUAL_PROTOCOL_HISTORY[0].confirmedAt-1),p=page({respond:async()=>({...data,recordedBuybackTotals})});await p.ui.load();assert.equal(p.get('admin-treasury-recorded-buybacks').hidden,true);assert.doesNotMatch(p.ui.element.textContent,/1,975,831/);p.ui.destroy();
});


test('conflicting manual receipt projection shows reconciliation instead of a zero or combined total',async()=>{
  const p=page({respond:async()=>({...data,recordedBuybackTotals:{status:'unavailable',solSpent:null,curveBought:null,curveBurned:null}})});await p.ui.load();const panel=p.get('admin-treasury-recorded-buybacks');assert.equal(panel.hidden,false);assert.match(panel.textContent,/needs reconciliation/);assert.equal(panel.querySelector('strong'),null);assert.match(p.ui.element.textContent,/Available buyback budget0.5 SOL/);assert.equal(p.calls.length,1);p.ui.destroy();
});


test('treasury displays the safe blocker and retry schedule without changing automation',async()=>{
  const reason='The quoted treasury swap exceeds the 2% price-impact limit. No transaction was submitted.';
  const p=page({respond:async()=>({...data,pending:null,error:reason,buyRetry:{attempts:4,nextAttemptAt:1800840000000,reason},burnRetry:null})});
  await p.ui.load();const text=p.get('admin-treasury-status').textContent;assert.match(text,/Automation enabled/);assert.match(text,/2% price-impact limit/);assert.match(text,/Buyback retry 4/);assert.match(text,/Next attempt:/);assert(!text.includes('Waiting for the next service check'));assert.equal(p.calls.length,1);assert.equal(p.authorizations.length,0);assert.equal(p.get('admin-treasury-toggle').textContent,'Pause automatic buybacks');p.ui.destroy();
  const paused=page({respond:async()=>({...data,enabled:false,burnRetry:{attempts:2,nextAttemptAt:1800840000000,reason:'Burn is waiting for a finalized receipt.'}})});await paused.ui.load();assert.match(paused.get('admin-treasury-status').textContent,/Burn retry 2/);assert(!paused.get('admin-treasury-status').textContent.includes('Next attempt:'));paused.ui.destroy();
});
test('a wrong 2FA code or a rate limit with its wait time is shown as given; unknown errors stay hidden',async()=>{
  for(const [error,expected] of [[Object.assign(Error('Invalid or already used authentication code. Use a new code.'),{status:400,known:true}),'Invalid or already used authentication code. Use a new code.'],[Object.assign(Error('Too many attempts. Try again in 15 minutes.'),{status:429,known:true,retryAfterMs:900000}),'Too many attempts. Try again in 15 minutes.'],[Error('https://rpc.invalid/private-api-secret'),'The treasury update could not be confirmed. Refresh status before trying again.']]){
    const p=page({respond:async(path,body)=>{if(body)throw error;return data;}});await p.ui.load();p.get('admin-treasury-reason').value='Pause for maintenance';await submit(p.get('admin-treasury-configure'));
    assert.deepEqual(p.messages.at(-1),[expected,true]);p.ui.destroy();
  }
});
