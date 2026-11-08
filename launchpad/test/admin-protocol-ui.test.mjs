import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createAdminProtocol } from '../public/admin-protocol-ui.mjs';
const ACCOUNT='a'.repeat(32),ID='b'.repeat(32),MINT='So11111111111111111111111111111111111111112',WALLET='11111111111111111111111111111111';
const policy=()=>({recipient:WALLET,curveFeeBps:100,creationFeeSol:'0',autoHarvest:true,configured:true,lpPolicy:'burn',platformLpPercent:75});
const policyTarget=()=>({upgradeVersion:3,curveFeeBps:100,lpPolicy:'platform_locked',platformLpPercent:75,creatorFeePolicy:'flat-0.5-v2',creatorFeeRatePpm:5000});
const coin=(patch={})=>({policyTarget:policyTarget(),accountId:ACCOUNT,id:ID,name:'Example',symbol:'COIN',mint:MINT,quoteSymbol:'USDC',platformFeeBps:100,recipient:WALLET,eligibility:{allowed:true,reason:''},activation:{allowed:false,reason:'Already active.'},collecting:'12.5',claimed:'40',paid:'27.5',operations:[],...patch});
function page({coins=[coin()],saved=policy(),account={role:'admin',mfaEnabled:true},respond,authorize}={}){
  const {document,window}=parseHTML('<html><body></body></html>');Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return [...this.options].find(option=>option.selected)?.value||this.options[0]?.value||'';},set(value){for(const option of this.options)option.removeAttribute('selected');[...this.options].find(option=>option.value===String(value))?.setAttribute('selected','');}});
  const calls=[],checks=[],messages=[];const ui=createAdminProtocol({document,getAccount:()=>account,api:async(path,body)=>{calls.push({path,body});return await respond?.(path,body)??(path.endsWith('/coins')?{coins}:path.endsWith('/configure')?{policy:saved}:path.endsWith('/claim')||path.endsWith('/activate')?{coin:coins[0],alreadyRequested:false}:saved);},security:{authorize:async(...args)=>{checks.push(args);return authorize?authorize(...args):{password:'test-password',code:'123456'};}},message:(...args)=>messages.push(args)});document.body.append(ui.element);return {ui,document,calls,checks,messages,setAccount:value=>{account=value;}};
}
test('protocol settings retain fixed 75/25 policy and require fresh identity proof for updates',async()=>{
  const p=page();await p.ui.load();assert.match(p.ui.element.textContent,/Launchpad fee wallet/);assert.match(p.ui.element.textContent,/Save launchpad fee wallet/);assert.match(p.ui.element.textContent,/Launchpad protocol fee1%/);assert.match(p.ui.element.textContent,/Revenue from Launchpad coin launches, swaps, transfer taxes and locked LP fees/);const form=p.ui.element.querySelector('.admin-protocol-form'),inputs=form.querySelectorAll('input');assert.equal(form.querySelector('select'),null);assert.match(form.textContent,/New launches always use this allocation and the 1% protocol fee/);inputs[1].value='0.03';inputs[3].value='Update the creation fee.';await form.onsubmit({preventDefault(){}});const request=p.calls.find(call=>call.path.endsWith('/configure'));assert.equal(request.body.lpPolicy,'platform_locked');assert.equal(request.body.platformLpPercent,75);assert.equal(request.body.creationFeeSol,'0.03');assert.equal(request.body.expectedRecipient,WALLET);assert.equal(request.body.autoHarvest,true);assert.equal(p.checks[0][1].requireCode,true);assert(!p.document.body.textContent.includes('test-password'));
});
test('legacy activation requires an explicit future-trade fee acknowledgment before reauthentication',async()=>{
  const p=page({coins:[coin({platformFeeBps:0,recipient:'',activation:{allowed:true,reason:''},eligibility:{allowed:false,reason:'Legacy'}})]});await p.ui.load();const row=p.ui.element.querySelector('.admin-protocol-coin'),form=row.querySelector('form');assert.match(row.textContent,/Apply 1% protocol fees and 0.5% creator fees/);form.querySelector('input[type=text],input:not([type])').value='Approved legacy activation.';await form.onsubmit({preventDefault(){}});assert.equal(p.checks.length,0);assert.equal(p.calls.some(call=>call.body),false);form.querySelector('input[type=checkbox]').checked=true;await form.onsubmit({preventDefault(){}});const post=p.calls.find(call=>call.path.endsWith('/activate'));assert(post);assert.match(post.body.requestId,/^[a-f0-9-]{36}$/);assert.equal(post.body.accountId,ACCOUNT);assert.equal(post.body.policyVersion,3);assert.equal(post.body.id,ID);assert.equal(p.checks[0][1].requireCode,true);assert(p.messages.some(([message])=>message.includes('Wait for onchain confirmation')));
});
test('protocol claims show receiving wallet and exact quote units without claiming success before confirmation',async()=>{
  const p=page();await p.ui.load();const row=p.ui.element.querySelector('.admin-protocol-coin');assert.match(row.textContent,/12.5 USDC/);assert.match(row.textContent,new RegExp(WALLET));const form=row.querySelector('form');form.querySelector('input').value='Collect earned fees manually.';await form.onsubmit({preventDefault(){}});assert(p.calls.some(call=>call.path.endsWith('/claim')));assert(p.messages.some(([message])=>message.includes('collection queued')));
});
test('invalid configuration and unavailable launch actions never post',async()=>{
  const p=page({coins:[coin({eligibility:{allowed:false,reason:'Shared wallet cannot manage protocol revenue.'}})]});await p.ui.load();const form=p.ui.element.querySelector('.admin-protocol-form'),inputs=form.querySelectorAll('input');inputs[3].value='Configuration maintenance.';for(const value of ['-1','0.100000001','0.0000000001']){inputs[1].value=value;await form.onsubmit({preventDefault(){}});}const row=p.ui.element.querySelector('.admin-protocol-coin form');assert.equal(row.querySelector('button').disabled,true);row.querySelector('input').value='Try a manual claim.';await row.onsubmit({preventDefault(){}});assert.equal(p.checks.length,0);assert.equal(p.calls.some(call=>call.body),false);
});
test('clearing permissions while approval is pending suppresses a protocol mutation',async()=>{
  let approve;const p=page({authorize:()=>new Promise(resolve=>{approve=resolve;})});await p.ui.load();const form=p.ui.element.querySelector('.admin-protocol-coin form');form.querySelector('input').value='Collect earned protocol fees.';const pending=form.onsubmit({preventDefault(){}});p.ui.clear();approve({password:'test-password',code:'123456'});await pending;assert.equal(p.calls.some(call=>call.body),false);assert.equal(p.ui.element.hidden,true);
});
test('untrusted coin names render as text and non-admin users cannot load protocol inventory',async()=>{
  const p=page({coins:[coin({name:'<img src=x onerror=bad()>'})]});await p.ui.load();assert.equal(p.ui.element.querySelector('img'),null);assert.match(p.ui.element.textContent,/<img src=x/);const guest=page({account:{role:'user',mfaEnabled:true}});await guest.ui.load();assert.equal(guest.calls.length,0);
});
test('protocol gas wallet exposes a public explorer and distinguishes budget from unknown balance',async()=>{
  const p=page({coins:[coin({feeWallet:WALLET,serviceWalletManaged:true,gas:{initialReserveSol:'0.015',dailyBudgetSol:'0.05',remainingTodaySol:'0.04',balanceSol:null}})]});await p.ui.load();const gas=p.ui.element.querySelector('.admin-protocol-gas');assert.equal(gas.querySelector('h4').textContent,'Service gas wallet');assert.match(gas.textContent,/Send SOL to this wallet to fund fee collection/);assert.equal(gas.querySelector('a').getAttribute('href'),'https://solscan.io/account/'+WALLET);assert.match(gas.textContent,/Initial reserve0.015 SOL/);assert.match(gas.textContent,/Budget remaining today0.04 SOL/);assert.match(gas.textContent,/Current SOL balance: check/);assert(!gas.textContent.includes('Current SOL balance: 0'));assert.match(p.ui.element.textContent,/at least \$5 in quote fees/);
});
test('locked LP revenue ownership and minute checks are distinct from hourly curve fee collection',async()=>{
  const p=page({saved:{...policy(),lpPolicy:'platform_locked',platformLpPercent:75},coins:[coin({lpPolicy:{lpPolicy:'platform_locked',platformLpPercent:75},collectingBase:'15',paidBase:'10'})]});await p.ui.load();const text=p.ui.element.textContent;assert.match(text,/75% of migration LP is permanently locked/);assert.match(text,/25% is burned/);assert.match(text,/100% of fees earned by Launchpad’s locked LP share go to the Launchpad treasury/);assert.match(text,/Creator fees and holder rewards have separate accounting/);assert.match(text,/Launchpad fees are checked hourly when at least \$5 in quote fees/);assert.match(text,/Locked LP fees are checked every minute/);assert.match(text,/10 forwarded from locked LP fees/);assert.match(text,/without a swap/);assert.match(text,/token transfer fees may reduce the treasury receipt/);
});

test('legacy or unverified fee wallets never show dedicated-service funding instructions or gas budgets',async()=>{
  for(const managed of [false,undefined,'true']){
    const p=page({coins:[coin({platformFeeBps:0,feeWallet:WALLET,serviceWalletManaged:managed,activation:{allowed:false,reason:'The existing fee wallet is not an eligible dedicated protocol signer.'},gas:{initialReserveSol:'0.015',dailyBudgetSol:'0.05',remainingTodaySol:'0.04',balanceSol:'0.9'}})]});await p.ui.load();
    const row=p.ui.element.querySelector('.admin-protocol-coin'),gas=row.querySelector('.admin-protocol-gas');assert.equal(gas.querySelector('h4').textContent,'Legacy fee wallet');assert.equal(gas.querySelector('.account-address').textContent,WALLET);assert.equal(gas.querySelector('a').getAttribute('href'),'https://solscan.io/account/'+WALLET);assert.equal(gas.querySelector('button').textContent,'Copy address');assert.match(gas.textContent,/This launch uses its existing fee wallet\. It is not configured as a dedicated Launchpad protocol signer\. Adding SOL does not enable protocol fees\./);assert.doesNotMatch(gas.textContent,/Send SOL|Service gas wallet|Initial reserve|Daily gas budget|Budget remaining today/);assert.equal(gas.querySelector('.admin-protocol-facts'),null);assert.match(row.querySelector('form').textContent,/existing fee wallet is not an eligible dedicated protocol signer/);assert.equal(row.querySelector('form button').disabled,true);
  }
});

test('legacy activation identifies an unresolved reward receipt and cannot authorize or submit',async()=>{
  const signature='V41H8FyUoUEUdzcRTyQQ2mmHCm7gEphecYRXHxFGzWFXbHvwChfLrLrq2jdL2ZKq9fnvSVqGpmESjWd2TFqeTER';
  const p=page({coins:[coin({platformFeeBps:0,activation:{allowed:false,reason:'The saved distribute transaction is awaiting confirmation. Check its receipt before activating protocol fees.',blockingOperation:{kind:'distribute',state:'pending',signature,createdAt:1234,raw:'private-raw-transaction'}},operations:[]})]});await p.ui.load();
  const form=p.ui.element.querySelector('.admin-protocol-coin form'),note=form.querySelector('.admin-protocol-blocker'),link=note.querySelector('a');assert.match(form.textContent,/saved distribute transaction is awaiting confirmation/);assert.match(note.textContent,/Blocking transaction: distribute · awaiting confirmation/);assert.equal(link.textContent,'View blocking transaction ↗');assert.equal(link.getAttribute('href'),'https://solscan.io/tx/'+signature);assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer');assert.doesNotMatch(form.textContent,/private-raw-transaction/);assert.equal(form.querySelector('button').disabled,true);
  form.querySelector('input').value='Enable legacy protocol fees.';form.querySelector('input[type=checkbox]').checked=true;await form.onsubmit({preventDefault(){}});assert.equal(p.checks.length,0);assert.equal(p.calls.some(call=>call.body),false);
});

test('blocking receipt links require a valid Solana signature and never render arbitrary fields',async()=>{
  for(const signature of ['javascript:alert(1)','https://malicious.example/tx','z'.repeat(88),'2'.repeat(64),undefined]){
    const p=page({coins:[coin({platformFeeBps:0,activation:{allowed:false,reason:'The saved claim transaction is awaiting signature.',blockingOperation:{kind:'claim',state:'awaiting_signature',signature,raw:'private-raw',secret:'private-key'}}})]});await p.ui.load();const note=p.ui.element.querySelector('.admin-protocol-blocker');assert.match(note.textContent,/claim · awaiting signature/);assert.equal(note.querySelector('a'),null);assert.doesNotMatch(p.ui.element.textContent,/private-raw|private-key|malicious/);
  }
});

test('an eligible paused legacy reward cycle can request activation after acknowledgement and identity proof',async()=>{
  const p=page({coins:[coin({platformFeeBps:0,cycle:{stage:'claim'},feesRequested:true,state:'paused',activation:{allowed:true,reason:''}})]});await p.ui.load();const form=p.ui.element.querySelector('.admin-protocol-coin form');assert.equal(form.querySelector('button').disabled,false);form.querySelector('input').value='Activate this paused legacy coin.';form.querySelector('input[type=checkbox]').checked=true;await form.onsubmit({preventDefault(){}});assert.equal(p.checks.length,1);assert.equal(p.checks[0][1].requireCode,true);assert.equal(p.calls.filter(call=>call.path.endsWith('/activate')).length,1);assert(p.messages.some(([text])=>text.includes('upgrade queued')));
});

test('queued requests and stale accepted forms cannot submit another activation',async()=>{
  const p=page({coins:[coin({platformFeeBps:0,requested:true,activation:{allowed:true,reason:''}})]});await p.ui.load();const form=p.ui.element.querySelector('.admin-protocol-coin form');assert.match(form.textContent,/saved and queued/);assert.equal(form.querySelector('button').disabled,true);form.querySelector('input').value='Duplicate requested activation.';form.querySelector('input[type=checkbox]').checked=true;await form.onsubmit({preventDefault(){}});assert.equal(p.checks.length,0);assert.equal(p.calls.some(call=>call.body),false);
  const accepted=page({coins:[coin({platformFeeBps:0,activation:{allowed:true,reason:''}})],respond:(path,body)=>{if(path.endsWith('/coins')&&accepted.calls.filter(call=>call.path.endsWith('/coins')).length>1)throw Error('Refresh temporarily unavailable.');}});await accepted.ui.load();const stale=accepted.ui.element.querySelector('.admin-protocol-coin form');stale.querySelector('input').value='Submit activation only once.';stale.querySelector('input[type=checkbox]').checked=true;await stale.onsubmit({preventDefault(){}});assert.equal(stale.querySelector('button').disabled,true);await stale.onsubmit({preventDefault(){}});assert.equal(accepted.checks.length,1);assert.equal(accepted.calls.filter(call=>call.path.endsWith('/activate')).length,1);
});


test('already activated coins retain collection alongside an explicit 75/25 and flat-fee upgrade',async()=>{
  const p=page({coins:[coin({platformFeeBps:100,policyCurrent:false,creatorFeeRatePpm:2500,lpPolicy:{lpPolicy:'burn',platformLpPercent:0},activation:{allowed:true,reason:''}})]});await p.ui.load();
  const row=p.ui.element.querySelector('.admin-protocol-coin'),forms=row.querySelectorAll('form');assert.equal(forms.length,2);assert.match(forms[0].textContent,/75% of migration LP/);assert.match(forms[1].textContent,/Collect protocol fees/);assert.match(row.textContent,/0.25%/);assert.match(row.textContent,/100% burned/);
});
test('taxed holder upgrade reviews zero creator fees while keeping the current confirmed fee visible',async()=>{
  const p=page({coins:[coin({platformFeeBps:100,policyCurrent:false,creatorFeeRatePpm:5000,policyTarget:{...policyTarget(),creatorFeePolicy:'taxed-holders-0-v3',creatorFeeRatePpm:0},lpPolicy:{lpPolicy:'platform_locked',platformLpPercent:75},activation:{allowed:true,reason:''}})]});await p.ui.load();
  const row=p.ui.element.querySelector('.admin-protocol-coin'),form=row.querySelector('form');assert.match(row.textContent,/Creator fee on curve: 0.5%/);assert.match(form.textContent,/Apply 1% protocol fees and 0% creator fees/);assert.match(form.textContent,/Raydium fees, the token’s transfer-tax rate and separate graduated-pool creator fees stay unchanged/);assert.equal(form.querySelector('button').textContent,'Upgrade to 75% locked + 0% creator');
  form.querySelector('input').value='Apply the taxed holder policy.';form.querySelector('input[type=checkbox]').checked=true;await form.onsubmit({preventDefault(){}});assert.match(p.checks[0][0],/0% creator fee, 1% protocol fee/);assert.equal(p.calls.find(call=>call.path.endsWith('/activate')).body.policyVersion,3);assert.match(p.ui.element.querySelector('.admin-protocol-coin').textContent,/Creator fee on curve: 0.5%/);
});
test('missing or inconsistent upgrade targets require refresh without blocking current fee collection',async()=>{
  for(const target of [undefined,{...policyTarget(),upgradeVersion:2},{...policyTarget(),creatorFeeRatePpm:0},{...policyTarget(),platformLpPercent:50}]){
    const p=page({coins:[coin({policyCurrent:false,policyTarget:target,activation:{allowed:true,reason:''}})]});await p.ui.load();const [upgrade,claim]=p.ui.element.querySelectorAll('.admin-protocol-coin form');assert.equal(upgrade.querySelector('button').disabled,true);assert.match(upgrade.textContent,/Refresh this coin to verify/);assert.equal(claim.querySelector('button').disabled,false);upgrade.querySelector('input').value='Do not submit an unknown target.';upgrade.querySelector('input[type=checkbox]').checked=true;await upgrade.onsubmit({preventDefault(){}});assert.equal(p.checks.length,0);assert.equal(p.calls.some(call=>call.body),false);
  }
});

test('legacy upgrade shows its separate gas wallet and enables the acknowledged upgrade',async()=>{
  const p=page({coins:[coin({platformFeeBps:0,policyCurrent:false,feeWallet:MINT,creatorFeeWallet:WALLET,serviceWalletManaged:true,serviceWalletForUpgrade:true,activation:{allowed:true,reason:''}})]});await p.ui.load();
  const row=p.ui.element.querySelector('.admin-protocol-coin'),gas=row.querySelector('.admin-protocol-gas'),form=row.querySelector('form');
  assert.equal(gas.querySelector('h4').textContent,'Upgrade gas wallet');assert.equal(gas.querySelector('.account-address').textContent,MINT);assert.equal(gas.querySelector('a').getAttribute('href'),'https://solscan.io/account/'+MINT);
  assert.match(gas.textContent,/0.01 SOL/);assert.match(gas.textContent,/Creator rewards keep their current wallet and destination/);assert.doesNotMatch(gas.textContent,/Adding SOL does not enable/);assert.match(form.textContent,/assigns protocol collection and the future LP Fee Key/);
  assert.equal(form.querySelector('button').disabled,false);form.querySelector('input').value='Bring this legacy coin onto the current policy.';form.querySelector('input[type=checkbox]').checked=true;await form.onsubmit({preventDefault(){}});
  assert.equal(p.calls.filter(call=>call.path.endsWith('/activate')).length,1);assert.equal(p.checks[0][1].requireCode,true);
});


test('fresh legacy protocol wallet separates the original upgrade gas payer from collection funding',async()=>{
  const p=page({coins:[coin({platformFeeBps:0,policyCurrent:false,feeWallet:MINT,creatorFeeWallet:MINT,serviceWalletManaged:false,serviceWalletForUpgrade:true,separateProtocolWalletForUpgrade:true,protocolFeeWalletAddress:WALLET,activation:{allowed:true,reason:''}})]});await p.ui.load();
  const row=p.ui.element.querySelector('.admin-protocol-coin'),gas=row.querySelector('.admin-protocol-gas'),form=row.querySelector('form');
  assert.equal(gas.querySelector('h4').textContent,'Upgrade gas wallet');assert.equal(gas.querySelector('.account-address').textContent,MINT);
  assert.match(gas.textContent,/original platform administrator pays the upgrade network fee/);assert.match(row.textContent,/Protocol collection wallet after confirmation/);assert.match(row.textContent,/does not need SOL to complete the upgrade/);
  assert.match(form.textContent,/dedicated protocol fee wallet/);assert.match(form.textContent,/Creator rewards keep their current wallet and destination/);assert.match(form.textContent,/original platform administrator remains unchanged/);
  assert.doesNotMatch(gas.textContent,/Fund it with SOL before upgrading|0.01 SOL|Adding SOL does not enable/);
  form.querySelector('input').value='Upgrade the original owner launch.';form.querySelector('input[type=checkbox]').checked=true;await form.onsubmit({preventDefault(){}});assert.equal(p.calls.filter(call=>call.path.endsWith('/activate')).length,1);
});

const bulkButton=p=>p.ui.element.querySelector('#admin-protocol-claim-all');
const bulkCalls=p=>p.calls.filter(call=>call.path==='/api/admin/protocol-fees/claim-all');
const batch=(patch={})=>({queued:[],alreadyRequested:[],skipped:[],failed:[],...patch});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

test('collect all is available in the header even when no coin has a per-coin claim button',async()=>{
  for(const coins of [[],[coin({platformFeeBps:0,eligibility:{allowed:false,reason:'Legacy launch.'}})]]){
    const p=page({coins,respond:path=>path.endsWith('/claim-all')?batch({skipped:coins.map(row=>({...row,reason:'Legacy launch.'}))}):undefined});await p.ui.load();const button=bulkButton(p);
    assert.equal(button.textContent,'Collect all protocol fees');assert.equal(button.disabled,false);assert.equal(button.closest('.admin-card-heading')!==null,true);
    await button.onclick();assert.equal(bulkCalls(p).length,1);assert.match(p.ui.element.querySelector('.admin-protocol-collection-result').textContent,new RegExp(`${coins.length} skipped`));
  }
});

test('one verification queues all coins without forwarding a search filter or page to the bulk endpoint',async()=>{
  const coins=Array.from({length:21},(_,i)=>coin({id:String(i).padStart(32,'0'),name:'Example '+i,symbol:'COIN'+i}));
  const p=page({coins,respond:path=>path.endsWith('/claim-all')?batch({queued:coins}):undefined});await p.ui.load();
  const next=[...p.ui.element.querySelectorAll('.admin-pagination button')].find(node=>node.textContent==='Next');next.onclick();assert.equal(p.ui.element.querySelector('.admin-pagination span').textContent,'2 / 3');
  const search=p.ui.element.querySelector('input[type=search]');search.value='COIN20';search.oninput();assert.equal(p.ui.element.querySelectorAll('.admin-protocol-coin').length,1);
  await bulkButton(p).onclick();assert.equal(bulkCalls(p).length,1);assert.deepEqual(p.checks,[['Collect all protocol fees',{requireCode:true}]]);const body=bulkCalls(p)[0].body;
  assert.deepEqual(Object.keys(body).sort(),['code','password','requestId']);assert.match(body.requestId,/^[a-f0-9-]{36}$/);assert.equal(body.code,'123456');assert.doesNotMatch(p.document.body.textContent,/test-password|123456/);
  assert.match(p.ui.element.querySelector('.admin-protocol-collection-result').textContent,/21 queued/);assert.equal(p.ui.element.querySelectorAll('.admin-protocol-coin').length,1);
});

test('bulk results retain queued, duplicate, skipped, and failure details across refresh',async()=>{
  const p=page({respond:path=>path.endsWith('/claim-all')?batch({queued:[coin()],alreadyRequested:[coin({symbol:'OLD'})],skipped:[coin({symbol:'LEGACY',reason:'Policy upgrade required.'})],failed:[coin({symbol:'<img src=x onerror=bad()>',reason:'Gas reserve unavailable.'})]}):undefined});await p.ui.load();await bulkButton(p).onclick();
  const result=p.ui.element.querySelector('.admin-protocol-collection-result');assert.equal(result.hidden,false);assert.match(result.textContent,/1 queued · 1 already requested · 1 skipped · 1 failed/);assert.match(result.textContent,/onchain confirmation/);assert.match(result.textContent,/LEGACY: Policy upgrade required/);assert.match(result.textContent,/Gas reserve unavailable/);assert.equal(result.querySelector('img'),null);
  await p.ui.load();assert.match(result.textContent,/1 queued · 1 already requested · 1 skipped · 1 failed/);assert.equal(result.hidden,false);
});

test('repeat bulk clicks are ignored throughout authorization and the pending POST',async()=>{
  const auth=deferred(),post=deferred(),p=page({authorize:()=>auth.promise,respond:path=>path.endsWith('/claim-all')?post.promise:undefined});await p.ui.load();const button=bulkButton(p),pending=button.onclick();
  assert.equal(button.disabled,true);await button.onclick();assert.equal(p.checks.length,1);assert.equal(bulkCalls(p).length,0);
  auth.resolve({password:'test-password',code:'123456'});await Promise.resolve();await Promise.resolve();assert.equal(bulkCalls(p).length,1);await button.onclick();assert.equal(bulkCalls(p).length,1);assert.equal(p.checks.length,1);
  post.resolve(batch({queued:[coin()]}));await pending;assert.equal(button.disabled,false);assert.equal(button.textContent,'Collect all protocol fees');
});

test('cancelled or failed bulk verification never posts and leaves the button usable',async()=>{
  for(const explanation of ['Cancelled.','Verification failed.']){
    let failure=true;const p=page({authorize:()=>{if(failure)throw Error(explanation);return {code:'123456'};},respond:path=>path.endsWith('/claim-all')?batch():undefined});await p.ui.load();await bulkButton(p).onclick();
    assert.equal(bulkCalls(p).length,0);assert.equal(bulkButton(p).disabled,false);assert.equal(p.messages.length,explanation==='Cancelled.'?0:1);
    failure=false;await bulkButton(p).onclick();assert.equal(bulkCalls(p).length,1);assert.equal(p.checks.length,2);
  }
});

test('an uncertain bulk response reuses its batch ID through refresh and only resets after acceptance',async()=>{
  let attempts=0;const p=page({respond:path=>{if(path.endsWith('/claim-all')){if(++attempts===1)throw Error('Connection interrupted.');return batch({alreadyRequested:[coin()]});}}});await p.ui.load();await bulkButton(p).onclick();
  const result=p.ui.element.querySelector('.admin-protocol-collection-result');assert.match(result.textContent,/safely check and retry the same request/);await p.ui.load();assert.match(result.textContent,/safely check and retry the same request/);
  await bulkButton(p).onclick();assert.equal(bulkCalls(p)[0].body.requestId,bulkCalls(p)[1].body.requestId);assert.match(result.textContent,/1 already requested/);
  await bulkButton(p).onclick();assert.notEqual(bulkCalls(p)[1].body.requestId,bulkCalls(p)[2].body.requestId);assert.equal(p.checks.length,3);
});

test('clearing the panel or changing accounts during bulk verification suppresses the POST',async()=>{
  for(const change of [p=>p.ui.clear(),p=>p.setAccount({id:'another-admin',role:'admin',mfaEnabled:true}),p=>p.setAccount({role:'user',mfaEnabled:true})]){
    const auth=deferred(),p=page({account:{id:'first-admin',role:'admin',mfaEnabled:true},authorize:()=>auth.promise});await p.ui.load();const pending=bulkButton(p).onclick();change(p);auth.resolve({code:'123456'});await pending;assert.equal(bulkCalls(p).length,0);assert.equal(p.ui.element.querySelector('.admin-protocol-collection-result').hidden,true);assert.equal(p.messages.length,0);
  }
});

test('a stale bulk response does not reveal results and its ID is not reused by a different admin',async()=>{
  const post=deferred();let attempts=0;const p=page({account:{id:'first-admin',role:'admin',mfaEnabled:true},respond:path=>path.endsWith('/claim-all')?(++attempts===1?post.promise:batch()):undefined});await p.ui.load();const pending=bulkButton(p).onclick();await Promise.resolve();await Promise.resolve();assert.equal(bulkCalls(p).length,1);
  p.ui.clear();p.setAccount({id:'second-admin',role:'admin',mfaEnabled:true});post.resolve(batch({failed:[coin({reason:'Prior account details.'})]}));await pending;assert.equal(p.ui.element.querySelector('.admin-protocol-collection-result').hidden,true);assert.doesNotMatch(p.ui.element.textContent,/Prior account details/);assert.equal(p.messages.length,0);
  await p.ui.load();await bulkButton(p).onclick();assert.equal(bulkCalls(p).length,2);assert.notEqual(bulkCalls(p)[0].body.requestId,bulkCalls(p)[1].body.requestId);
});

test('partial bulk failures retain the batch ID so retry does not requeue successful coins',async()=>{
  let attempts=0;const p=page({respond:path=>path.endsWith('/claim-all')?(++attempts===1?batch({queued:[coin()],failed:[coin({id:'c'.repeat(32),symbol:'RETRY',uncertain:true,reason:'Could not confirm this request.'})]}):batch({alreadyRequested:[coin()],queued:[coin({id:'c'.repeat(32),symbol:'RETRY'})]})):undefined});await p.ui.load();await bulkButton(p).onclick();
  const result=p.ui.element.querySelector('.admin-protocol-collection-result');assert.match(result.textContent,/Previously accepted collections will not be queued twice/);assert.match(result.textContent,/RETRY: Could not confirm this request/);
  await bulkButton(p).onclick();assert.equal(bulkCalls(p)[0].body.requestId,bulkCalls(p)[1].body.requestId);assert.match(result.textContent,/1 queued · 1 already requested · 0 skipped · 0 failed/);
  await bulkButton(p).onclick();assert.notEqual(bulkCalls(p)[1].body.requestId,bulkCalls(p)[2].body.requestId);
});

test('background refresh during bulk authorization or submission cannot discard its accepted result',async()=>{
  const auth=deferred(),post=deferred(),p=page({authorize:()=>auth.promise,respond:path=>path.endsWith('/claim-all')?post.promise:undefined});await p.ui.load();const pending=bulkButton(p).onclick();await p.ui.load();assert.equal(p.calls.filter(call=>call.path.endsWith('/coins')).length,1);
  auth.resolve({code:'123456'});await Promise.resolve();await Promise.resolve();await p.ui.load();assert.equal(p.calls.filter(call=>call.path.endsWith('/coins')).length,1);assert.equal(bulkCalls(p).length,1);
  post.resolve(batch({queued:[coin()]}));await pending;assert.match(p.ui.element.querySelector('.admin-protocol-collection-result').textContent,/1 queued/);assert.equal(p.calls.filter(call=>call.path.endsWith('/coins')).length,2);assert.equal(bulkButton(p).disabled,false);
});


test('tax revenue is distinct from platform totals and exposes saved payout destinations safely',async()=>{
  const signature='V41H8FyUoUEUdzcRTyQQ2mmHCm7gEphecYRXHxFGzWFXbHvwChfLrLrq2jdL2ZKq9fnvSVqGpmESjWd2TFqeTER';
  const p=page({coins:[coin({taxRevenue:{eligible:true,status:'pending_receipt',accruedQuote:'5',pendingQuote:'2',paidQuote:'3',unconvertedBase:'12',operations:[{amount:'2',state:'pending',recipient:WALLET,signature,raw:'must-not-render'}]}})]});
  await p.ui.load();const section=p.ui.element.querySelector('.admin-tax-revenue');
  assert.match(section.textContent,/Accrued tax share5 USDC/);assert.match(section.textContent,/Awaiting payout2 USDC/);assert.match(section.textContent,/Forwarded tax share3 USDC/);
  assert.match(section.textContent,/12 COIN collected and awaiting conversion/);assert.match(section.textContent,/awaiting its saved transaction receipt/);
  assert.match(section.textContent,/Separate from the curve and locked-LP totals/);assert.match(section.textContent,/other 95% funds holder rewards/);
  assert.match(section.textContent,new RegExp(WALLET));assert.equal(section.querySelector('a').href,'https://solscan.io/tx/'+signature);assert.doesNotMatch(section.textContent,/must-not-render/);
  assert.match(p.ui.element.querySelector('.admin-protocol-coin').textContent,/Total claimed40 USDC/);
});

test('official LAUNCHPAD tax-burn revenue keeps earlier proceeds separate from new direct burns',async()=>{
  const p=page({coins:[coin({symbol:'LAUNCHPAD',quoteSymbol:'SOL',taxRevenue:{eligible:true,status:'tax_burn_paused',shareBps:500,currentShareBps:0,accruedQuote:'5',pendingQuote:'2',paidQuote:'3',unconvertedBase:'12',taxBurn:{selected:true,enabled:false},operations:[]}})]});await p.ui.load();
  const section=p.ui.element.querySelector('.admin-tax-revenue');assert.match(section.textContent,/Historical transfer-tax revenue/);assert.match(section.textContent,/100% burned, no new tax-sale revenue/);assert.match(section.textContent,/Previously accrued protocol SOL remains reserved/);assert.match(section.textContent,/12 LAUNCHPAD collected and awaiting burn/);assert.match(section.textContent,/2 SOL/);assert.doesNotMatch(section.textContent,/awaiting conversion|other 95% funds holder rewards/);assert.equal(p.calls.some(call=>call.body),false);
});

test('invalid tax ledger displays unavailable totals and no arbitrary error HTML or unsafe receipt links',async()=>{
  const p=page({coins:[coin({taxRevenue:{eligible:true,status:'invalid_ledger',error:'<img onerror=bad()>',accruedQuote:null,pendingQuote:null,paidQuote:null,operations:[{amount:'bogus',state:'pending',signature:'javascript:alert(1)',recipient:'<script>bad()</script>'}]}})]});
  await p.ui.load();const section=p.ui.element.querySelector('.admin-tax-revenue');
  assert.match(section.textContent,/Accrued tax shareUnavailable/);assert.match(section.textContent,/accounting needs review/);
  assert.doesNotMatch(section.textContent,/0 USDC|<img/);assert.equal(section.querySelector('script'),null);assert.equal(section.querySelector('a'),null);
});

const OFFICIAL_TOKEN_MINT='7rvRFpzP5W18yZcNpPNqtWgPTxLaFrnutz5QPxXpyupc';
test('official LAUNCHPAD is pinned open above search independently of pagination without a duplicate row',async()=>{
  const regular=Array.from({length:21},(_,i)=>coin({id:String(i).padStart(32,'0'),name:'Example '+i,symbol:'COIN'+i}));
  const official=coin({id:'f'.repeat(32),mint:OFFICIAL_TOKEN_MINT,name:'Launchpad',symbol:'LAUNCHPAD',quoteSymbol:'SOL'}),p=page({coins:[...regular,official]});await p.ui.load();
  const pinned=p.ui.element.querySelector('#admin-protocol-curve'),search=p.ui.element.querySelector('input[type=search]'),list=p.ui.element.querySelector('.admin-protocol-coins');
  assert.equal(pinned.hidden,false);assert.equal(pinned.querySelector('h3').textContent,'LAUNCHPAD fees');assert.equal(pinned.querySelector('.admin-protocol-coin').hasAttribute('open'),true);
  assert.equal(pinned.nextElementSibling.contains(search),true);assert.equal(pinned.querySelector('.account-address').textContent,OFFICIAL_TOKEN_MINT);
  assert.equal(list.querySelectorAll('.admin-protocol-coin').length,10);assert.doesNotMatch(list.textContent,new RegExp(OFFICIAL_TOKEN_MINT));
  assert.equal(p.ui.element.querySelector('.admin-pagination span').textContent,'1 / 3');
  [...p.ui.element.querySelectorAll('.admin-pagination button')].find(node=>node.textContent==='Next').onclick();assert.equal(pinned.querySelectorAll('.admin-protocol-coin').length,1);assert.doesNotMatch(list.textContent,new RegExp(OFFICIAL_TOKEN_MINT));
  search.value='COIN20';search.oninput();assert.equal(list.querySelectorAll('.admin-protocol-coin').length,1);assert.match(list.textContent,/COIN20/);assert.equal(pinned.hidden,false);assert.match(pinned.textContent,new RegExp(OFFICIAL_TOKEN_MINT));
  search.value=OFFICIAL_TOKEN_MINT;search.oninput();assert.equal(p.ui.element.querySelectorAll('.admin-protocol-coin').length,1);assert.equal(list.querySelectorAll('.admin-protocol-coin').length,0);
});

test('a LAUNCHPAD symbol or similar mint cannot impersonate the pinned official coin',async()=>{
  for(const mint of [MINT,OFFICIAL_TOKEN_MINT+'1',OFFICIAL_TOKEN_MINT.toLowerCase()]){
    const p=page({coins:[coin({name:'Launchpad',symbol:'LAUNCHPAD',mint})]});await p.ui.load();const pinned=p.ui.element.querySelector('#admin-protocol-curve');assert.equal(pinned.hidden,true);assert.equal(pinned.textContent,'');assert.equal(p.ui.element.querySelector('.admin-protocol-coins .admin-protocol-coin')!==null,true);
  }
});

test('pinned LAUNCHPAD retains full balances and submits only its own coin through existing MFA claim flow',async()=>{
  const official=coin({accountId:'e'.repeat(32),id:'f'.repeat(32),mint:OFFICIAL_TOKEN_MINT,name:'Launchpad',symbol:'LAUNCHPAD',quoteSymbol:'SOL',error:'Saved collection error.'}),p=page({coins:[coin(),official]});await p.ui.load();
  const pinned=p.ui.element.querySelector('#admin-protocol-curve');assert.match(pinned.textContent,/Collected, awaiting payout12.5 SOL/);assert.match(pinned.textContent,/Saved collection error/);assert.match(pinned.textContent,new RegExp('Receiving wallet: '+WALLET));
  const form=pinned.querySelector('form');form.querySelector('input').value='Collect official LAUNCHPAD revenue.';await form.onsubmit({preventDefault(){}});
  assert.deepEqual(p.checks,[['Collect LAUNCHPAD protocol fees',{requireCode:true}]]);const posts=p.calls.filter(call=>call.body);assert.equal(posts.length,1);assert.equal(posts[0].path,'/api/admin/protocol-fees/claim');assert.equal(posts[0].body.accountId,official.accountId);assert.equal(posts[0].body.id,official.id);assert.equal(posts[0].body.code,'123456');assert.equal(bulkCalls(p).length,0);assert.doesNotMatch(p.ui.element.textContent,/test-password|123456/);
});

test('clearing or losing admin access removes all pinned LAUNCHPAD data and cancels pending authorization',async()=>{
  for(const clear of [p=>p.ui.clear(),async p=>{p.setAccount({role:'user',mfaEnabled:true});await p.ui.load();}]){
    const auth=deferred(),p=page({coins:[coin({mint:OFFICIAL_TOKEN_MINT,name:'Launchpad',symbol:'LAUNCHPAD'})],authorize:()=>auth.promise});await p.ui.load();const pinned=p.ui.element.querySelector('#admin-protocol-curve'),form=pinned.querySelector('form');form.querySelector('input').value='Collect official LAUNCHPAD revenue.';const pending=form.onsubmit({preventDefault(){}});
    await clear(p);assert.equal(pinned.hidden,true);assert.equal(pinned.textContent,'');assert.equal(p.ui.element.hidden,true);auth.resolve({password:'test-password',code:'123456'});await pending;assert.equal(p.calls.some(call=>call.body),false);assert.doesNotMatch(p.ui.element.textContent,new RegExp(OFFICIAL_TOKEN_MINT));
  }
});


test('manual collection remains available while a saved reward transaction waits for its receipt or signature',async()=>{
  for(const state of ['pending','awaiting_signature']){
    const waitingForOperation={kind:'payout',state,signature:'5'.repeat(88),createdAt:100,raw:'private-signed-bytes'},p=page({coins:[coin({eligibility:{allowed:true,reason:'',waitingForOperation},waitingForOperation})]});await p.ui.load();
    const row=p.ui.element.querySelector('.admin-protocol-coin'),form=row.querySelector('form');assert.equal(form.querySelector('button').disabled,false);assert.match(row.textContent,/Collection can be queued behind the saved payout transaction/);assert.doesNotMatch(row.textContent,/private-signed-bytes/);
    if(state==='awaiting_signature')assert.match(row.textContent,/Complete or cancel its wallet signature request/);else assert.match(row.textContent,/verify its saved receipt/);
    form.querySelector('input').value='Queue protocol collection after rewards.';await form.onsubmit({preventDefault(){}});assert.equal(p.calls.filter(call=>call.path.endsWith('/claim')&&call.body).length,1);
  }
});

test('queued waiting and retry states do not imply a confirmed protocol transaction',async()=>{
  const waiting=coin({requested:true,waitingForOperation:{kind:'claim',state:'awaiting_signature'},eligibility:{allowed:false,reason:'A protocol operation is already queued.'}}),retry=coin({id:'c'.repeat(32),requested:true,protocolRetry:{at:1800000000000,attempt:2,kind:'funding',reason:'Waiting for SOL.'},eligibility:{allowed:false,reason:'A protocol operation is already queued.'}}),p=page({coins:[waiting,retry]});await p.ui.load();
  const rows=p.ui.element.querySelectorAll('.admin-protocol-coin');assert.match(rows[0].querySelector('summary').textContent,/Queued · waiting for reward transaction/);assert.match(rows[0].textContent,/Complete or cancel/);assert.match(rows[1].querySelector('summary').textContent,/Queued · retry scheduled/);assert.match(rows[1].querySelector('.admin-protocol-retry').textContent,/Waiting for SOL.*remains queued/);
  for(const row of rows){assert.equal(row.querySelector('form button').disabled,true);assert.doesNotMatch(row.textContent,/queued and awaiting onchain confirmation/);}
});

test('Meteora protocol rows collect through the shared flow without offering Raydium policy upgrades',async()=>{
  const met=coin({route:'meteora',id:'12345678-1234-4123-8123-123456789abc',platformFeeBps:0,policyCurrent:true,creatorFeeRatePpm:undefined,lpPolicy:{lpPolicy:'platform_locked',platformLpPercent:67},pending:true,waitingForOperation:{kind:'partner-claim',state:'pending'}}),p=page({coins:[met]});await p.ui.load();
  const row=p.ui.element.querySelector('.admin-protocol-coin'),forms=row.querySelectorAll('form');assert.equal(forms.length,1);const form=forms[0];assert.equal(form.querySelector('button').textContent,'Collect protocol fees');assert.equal(form.querySelector('button').disabled,false);assert.equal(form.querySelector('input[type=checkbox]'),null);assert.doesNotMatch(row.textContent,/Upgrade to|67% locked|Creator fee on curve/);assert.match(row.textContent,/100% permanently locked liquidity/);
  form.querySelector('input').value='Collect Meteora protocol revenue.';await form.onsubmit({preventDefault(){}});const calls=p.calls.filter(call=>call.body);assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/admin/protocol-fees/claim');assert.equal(calls[0].body.route,'meteora');assert.equal(calls[0].body.id,met.id);assert.equal(calls[0].body.mint,met.mint);assert.equal(calls[0].body.accountId,met.accountId);assert.equal(calls[0].body.code,'123456');
});
test('an invalid launchpad fee wallet is rejected before the identity prompt',async()=>{
  const p=page();await p.ui.load();const form=p.ui.element.querySelector('.admin-protocol-form'),inputs=form.querySelectorAll('input');
  inputs[0].value='not-a-wallet';inputs[3].value='Move fees to the new treasury.';await form.onsubmit({preventDefault(){}});
  assert.equal(p.checks.length,0);assert.equal(p.calls.some(call=>call.path.endsWith('/configure')),false);assert.match(p.messages.at(-1)[0],/valid Solana wallet address/);
  inputs[0].value=' '+WALLET+' ';await form.onsubmit({preventDefault(){}});assert.equal(p.checks.length,1);assert.equal(p.calls.find(call=>call.path.endsWith('/configure')).body.recipient,WALLET);
});
