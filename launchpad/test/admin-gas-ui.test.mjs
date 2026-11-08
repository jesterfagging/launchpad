import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createAdminGasFunding } from '../public/admin-gas-ui.mjs';

const ACCOUNT={id:'admin',role:'admin',mfaEnabled:true},WALLET='11111111111111111111111111111111',TARGET='So11111111111111111111111111111111111111112',TX='5'.repeat(88),NOW=1700000000000;
const POLICY={lowWaterLamports:'5000000',targetLamports:'20000000',maxRefillLamports:'20000000',dailyLimitLamports:'100000000',dailyNetworkLimitLamports:'20000000',cooldownMs:3600000,reserveLamports:'10000000',maximumOperationCostLamports:'5000000'};
const state=(patch={})=>({version:1,configured:true,address:WALLET,enabled:false,policy:POLICY,balanceLamports:'200000000',balanceAt:NOW,lowBalance:false,error:'',pending:null,totals:{refilledLamports:'95000000',networkSpentLamports:'10000'},day:{date:'2023-11-14',spentLamports:'50000000',reservedLamports:'0',networkSpentLamports:'5000',reservedNetworkLamports:'0'},targets:[{address:TARGET,roles:['rewards'],balanceLamports:'2500000',checkedAt:NOW,lastRefillAt:null,nextEligibleAt:null,status:'ready'}],history:[{signature:TX,recipient:TARGET,amountLamports:'19000000',state:'confirmed',at:NOW}],...patch});
function page({account=ACCOUNT,respond=async()=>state(),authorize=async()=>({password:'private-password',code:'123456'}),copyText=async()=>{}}={}){
  const {document}=parseHTML('<html><body></body></html>');Object.defineProperty(document,'hidden',{value:false,writable:true});
  const calls=[],messages=[],authorizations=[],timers=new Map();let timer=0,active=true,now=NOW;
  const ui=createAdminGasFunding({document,api:async(path,body)=>{calls.push({path,body});return respond(path,body);},security:{authorize:async(...args)=>{authorizations.push(args);return authorize(...args);}},message:(...args)=>messages.push(args),getAccount:()=>account,isActive:()=>active,clock:()=>now,setTimer:(fn,ms)=>{const id=++timer;timers.set(id,{fn,ms});return id;},clearTimer:id=>timers.delete(id),copyText});document.body.append(ui.element);
  return{ui,document,calls,messages,authorizations,timers,get:id=>document.getElementById(id),setAccount:value=>{account=value;},setActive:value=>{active=value;},advance:ms=>{now+=ms;},visibility:hidden=>{document.hidden=hidden;document.dispatchEvent(new document.defaultView.Event('visibilitychange'));}};
}
const submit=p=>p.get('admin-gas-configure').onsubmit({preventDefault(){}});
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));

test('gas funding is a separate off-by-default card with bounded source, target and refill details',async()=>{
  const p=page();await p.ui.load();assert.deepEqual(p.calls,[{path:'/api/admin/protocol-gas-funding',body:undefined}]);
  assert.match(p.ui.element.textContent,/Automatic gas refills/);assert.match(p.ui.element.textContent,/separate from the buyback treasury/);assert.match(p.ui.element.textContent,/50% LAUNCHPAD buyback allocation are unchanged/);
  assert.match(p.ui.element.textContent,/Gas funding balance0\.2 SOL/);assert.match(p.ui.element.textContent,/Refilled today0\.05 SOL/);assert.match(p.ui.element.textContent,/0\.005 SOL toward 0\.02 SOL/);assert.match(p.ui.element.textContent,/0\.1 SOL in refills per UTC day/);assert.match(p.ui.element.textContent,/separate 0\.02 SOL daily cap/);assert.match(p.ui.element.textContent,/0\.01 SOL stays/);
  assert.match(p.get('admin-gas-activity').textContent,/1 verified wallets/);assert(!p.get('admin-gas-activity').open);assert.equal(p.get('admin-gas-setup').hidden,true);assert.equal(p.get('admin-gas-toggle').textContent,'Enable gas refills');assert.equal(p.authorizations.length,0);
  assert([...p.ui.element.querySelectorAll('a')].every(link=>link.href.startsWith('https://solscan.io/')&&link.rel==='noopener noreferrer'));assert.equal([...p.timers.values()][0].ms,30000);p.ui.destroy();
});

test('gas activity explains earlier reward-wallet funding and protected reward shortfalls',async()=>{
  let target={address:TARGET,roles:['rewards'],balanceLamports:'7000000',requiredBalanceLamports:'14128560',reservedPrincipalLamports:'0',checkedAt:NOW,status:'ready'};const p=page({respond:async()=>state({enabled:true,targets:[target]})});await p.ui.load();assert.match(p.ui.element.textContent,/Reward wallet preparation can request an earlier refill under the same limits/);assert.match(p.get('admin-gas-targets').textContent,/need a balance of 0\.01412856 SOL/);
  target={...target,status:'principal_shortfall',requiredBalanceLamports:'<img src=x onerror=x>'};await p.ui.load();assert.match(p.get('admin-gas-targets').textContent,/Reward balance needs review/);assert.match(p.get('admin-gas-targets').textContent,/Gas refills cannot replace missing reward funds/);assert.equal(p.get('admin-gas-targets').querySelector('img'),null);assert.doesNotMatch(p.get('admin-gas-targets').textContent,/need a balance/);p.ui.destroy();
});

test('enable needs acknowledgement and fresh MFA and submits only the reviewed wallet and enabled setting',async()=>{
  const p=page({respond:async(path,body)=>state(body?{enabled:body.enabled}:{})});await p.ui.load();p.get('admin-gas-reason').value='Enable gas operating reserve';
  await submit(p);assert.equal(p.authorizations.length,0);p.get('admin-gas-ack').checked=true;await submit(p);
  assert.equal(p.authorizations[0][1].requireCode,true);assert.deepEqual(p.calls[1],{path:'/api/admin/protocol-gas-funding/configure',body:{enabled:true,expectedAddress:WALLET,reason:'Enable gas operating reserve',password:'private-password',code:'123456'}});
  assert.equal(p.get('admin-gas-toggle').textContent,'Pause gas refills');assert.equal(p.get('admin-gas-reason').value,'');assert.equal(p.get('admin-gas-ack').checked,false);assert(!p.ui.element.textContent.includes('private-password'));p.ui.destroy();
});

test('pause remains available without enable acknowledgement and preserves the pending refill',async()=>{
  const pending={recipient:TARGET,inputAmount:'17500000',signature:TX,state:'pending'};
  const p=page({respond:async(path,body)=>state({enabled:body?body.enabled:true,pending})});await p.ui.load();p.get('admin-gas-reason').value='Pause new refills during maintenance';await submit(p);
  assert.equal(p.calls[1].body.enabled,false);assert.match(p.ui.element.textContent,/Checking a saved refill/);assert.match(p.get('admin-gas-pending').textContent,/0\.0175 SOL/);assert.equal(p.get('admin-gas-pending').querySelectorAll('a').length,2);p.ui.destroy();
});

test('fresh gas setup stays off and offers only a copyable private VPS command',async()=>{
  let copied='';const p=page({respond:async()=>state({configured:false,address:'',balanceLamports:null,balanceAt:null}),copyText:async value=>{copied=value;}});await p.ui.load();
  assert.equal(p.get('admin-gas-toggle').disabled,true);assert.equal(p.get('admin-gas-ack').disabled,true);assert.equal(p.get('admin-gas-setup').hidden,false);assert(!p.get('admin-gas-setup').open);assert.equal(p.get('admin-gas-setup').querySelector('input,textarea'),null);
  await p.get('admin-gas-setup-copy').onclick();assert.equal(copied,p.get('admin-gas-setup-command').textContent);assert.match(copied,/--uid=launchpad .*--property=UMask=0077 --property=LimitCORE=0 .*\/scripts\/setup-gas-wallet.mjs$/);assert.match(p.get('admin-gas-setup').textContent,/Setup leaves refills off/);
  p.get('admin-gas-reason').value='Attempt enable without wallet';p.get('admin-gas-ack').checked=true;await submit(p);assert.equal(p.calls.length,1);assert.equal(p.authorizations.length,0);p.ui.destroy();
});

test('unknown and old balances stay unknown while fresh low funding gets an actionable wallet warning',async()=>{
  for(const patch of [{balanceLamports:null,balanceAt:null},{balanceLamports:'999999999',balanceAt:NOW-120001},{balanceLamports:'999999999',balanceAt:NOW+1}]){const p=page({respond:async()=>state({...patch,lowBalance:true})});await p.ui.load();assert.match(p.ui.element.textContent,/Gas funding balance—/);assert.equal(p.get('admin-gas-warning').hidden,true);assert.match(p.ui.element.textContent,/awaiting a fresh check/);p.ui.destroy();}
  const p=page({respond:async()=>state({balanceLamports:'1000000',lowBalance:true})});await p.ui.load();assert.equal(p.get('admin-gas-warning').hidden,false);assert.match(p.get('admin-gas-warning').textContent,/Deposit SOL into the gas funding wallet/);p.ui.destroy();
});

test('polling keeps drafts, coalesces overlapping reads, stops while hidden/inactive and cleans up',async()=>{
  let finish,wait=false;const p=page({respond:async()=>wait?new Promise(resolve=>{finish=resolve;}):state()});await p.ui.load();p.get('admin-gas-reason').value='Unsaved operating policy';p.get('admin-gas-ack').checked=true;
  wait=true;const pending=p.ui.load();await p.ui.load();assert.equal(p.calls.length,2);finish(state());await pending;assert.equal(p.get('admin-gas-reason').value,'Unsaved operating policy');assert.equal(p.get('admin-gas-ack').checked,true);
  p.visibility(true);assert.equal(p.timers.size,0);await p.ui.load();assert.equal(p.calls.length,2);p.setActive(false);p.visibility(false);await p.ui.load();assert.equal(p.calls.length,2);p.ui.destroy();assert.equal(p.timers.size,0);
});

test('permission gates make no reads and account changes remove old balances before a fresh read',async()=>{
  for(const account of [null,{role:'user',mfaEnabled:true},{role:'admin',mfaEnabled:false}]){const p=page({account});await p.ui.load();assert.equal(p.calls.length,0);assert.equal(p.ui.element.hidden,true);p.ui.destroy();}
  let finish,wait=false;const p=page({respond:async()=>wait?new Promise(resolve=>{finish=resolve;}):state()});await p.ui.load();p.setAccount({...ACCOUNT,id:'other'});wait=true;const read=p.ui.load();assert(!p.ui.element.textContent.includes('Gas funding balance0.2 SOL'));finish(state({balanceLamports:'300000000'}));await read;assert.match(p.ui.element.textContent,/Gas funding balance0\.3 SOL/);p.ui.clear();assert.equal(p.ui.element.hidden,true);assert(!p.ui.element.textContent.includes('0.3 SOL'));p.ui.destroy();
});

test('late reads and MFA cannot repopulate or submit after account changes',async()=>{
  let finish;const p=page({respond:()=>new Promise(resolve=>{finish=resolve;})});const read=p.ui.load();p.ui.clear();finish(state());await read;assert.equal(p.ui.element.hidden,true);assert.equal(p.timers.size,0);p.ui.destroy();
  let confirm;const q=page({authorize:()=>new Promise(resolve=>{confirm=resolve;})});await q.ui.load();q.get('admin-gas-reason').value='Enable bounded gas refills';q.get('admin-gas-ack').checked=true;const save=submit(q);q.setAccount({...ACCOUNT,id:'changed'});confirm({password:'private',code:'123456'});await save;assert.equal(q.calls.length,1);assert.equal(q.ui.element.hidden,true);q.ui.destroy();
});

test('failed reads block enabling from stale status and raw provider errors stay out of the page',async()=>{
  let fail=false;const p=page({respond:async()=>{if(fail)throw Error('https://private-rpc.invalid/api-secret');return state();}});await p.ui.load();fail=true;await p.ui.load();assert.equal(p.get('admin-gas-toggle').disabled,true);assert.match(p.ui.element.textContent,/last saved status/);assert(!p.ui.element.textContent.includes('api-secret'));p.ui.destroy();
  const q=page({respond:async(path,body)=>{if(body)throw Error('https://private-rpc.invalid/api-secret');return state();}});await q.ui.load();q.get('admin-gas-reason').value='Enable bounded gas refills';q.get('admin-gas-ack').checked=true;await submit(q);assert.equal(q.get('admin-gas-toggle').disabled,true);assert(!JSON.stringify(q.messages).includes('api-secret'));q.ui.destroy();
});

test('changed source wallet resets acknowledgement; cancellation and malformed reason never mutate',async()=>{
  let current=state(),cancel=true;const p=page({respond:async()=>current,authorize:async()=>{if(cancel)throw Error('Cancelled.');return {code:'123456'};}});await p.ui.load();p.get('admin-gas-ack').checked=true;current=state({address:TARGET});await p.ui.load();assert.equal(p.get('admin-gas-ack').checked,false);
  p.get('admin-gas-reason').value='no';p.get('admin-gas-ack').checked=true;await submit(p);assert.equal(p.authorizations.length,0);p.get('admin-gas-reason').value='Enable reviewed wallet';await submit(p);assert.equal(p.calls.length,2);assert.equal(p.messages.some(row=>row[0].includes('Cancelled')),false);p.ui.destroy();
});

test('untrusted target metadata stays inert and malformed amounts cannot become SOL zero',async()=>{
  const p=page({respond:async()=>state({error:'private-secret',balanceLamports:'-1',targets:[{address:'javascript:bad()',roles:['<script>'],status:'ready'},{address:TARGET,roles:['<img src=x>'],status:'<script>',balanceLamports:null,checkedAt:null}],history:[{signature:'javascript:bad()',state:'expired',amountLamports:'bogus'}]})});await p.ui.load();assert.equal(p.ui.element.querySelector('img,script'),null);assert(!p.ui.element.textContent.includes('private-secret'));assert.match(p.ui.element.textContent,/Gas funding balance—/);assert.match(p.get('admin-gas-history').textContent,/Not completed · —/);assert.equal(p.get('admin-gas-targets').children.length,1);p.ui.destroy();
});

test('an account changed before clicking or a tab changed during MFA cannot apply a stale gas configuration',async()=>{
  const p=page();await p.ui.load();p.get('admin-gas-reason').value='Enable bounded gas refills';p.get('admin-gas-ack').checked=true;p.setAccount({...ACCOUNT,id:'other-admin'});await submit(p);assert.equal(p.calls.length,1);assert.equal(p.authorizations.length,0);assert.equal(p.ui.element.hidden,true);p.ui.destroy();
  let confirm;const q=page({authorize:()=>new Promise(resolve=>{confirm=resolve;})});await q.ui.load();q.get('admin-gas-reason').value='Enable bounded gas refills';q.get('admin-gas-ack').checked=true;const save=submit(q);q.setActive(false);confirm({code:'123456'});await save;assert.equal(q.calls.length,1);assert.equal(q.timers.size,0);q.ui.destroy();
});

test('a wrong password, 2FA code or rate limit is shown as given and does not block the next attempt',async()=>{
  for(const error of [Object.assign(Error('Invalid username or password.'),{status:400,known:true}),Object.assign(Error('Too many attempts. Try again in 3 minutes.'),{status:429,known:true})]){
    const p=page({respond:async(path,body)=>{if(body)throw error;return state();}});await p.ui.load();p.get('admin-gas-reason').value='Turn on refills';p.get('admin-gas-ack').checked=true;await submit(p);
    assert.equal(p.messages.at(-1)[0],error.message);assert.equal(p.messages.at(-1)[1],true);assert.equal(p.get('admin-gas-toggle').disabled,false);p.ui.destroy();
  }
  const p=page({respond:async(path,body)=>{if(body)throw Error('https://rpc.invalid/private');return state();}});await p.ui.load();p.get('admin-gas-reason').value='Turn on refills';p.get('admin-gas-ack').checked=true;await submit(p);
  assert.match(p.messages.at(-1)[0],/could not be confirmed/);assert(!JSON.stringify(p.messages).includes('private'));p.ui.destroy();
});
