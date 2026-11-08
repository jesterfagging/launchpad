import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createAdminRevenue,revenueAmount} from '../public/admin-revenue-ui.mjs';

const admin={role:'admin',mfaEnabled:true};
const asset={scope:'launchpad',chain:'solana',symbol:'SOL',mint:'So11111111111111111111111111111111111111112',decimals:9,grossAmount:'5000000000',cashbackAmount:'1000000000',netAmount:'4000000000',paidAmount:'3000000000',pendingAmount:'2000000000',cashbackPendingAmount:'1000000000'};
const result={at:1800840000000,coverage:'recorded-confirmed-history',note:'Confirmed receipts only.',totals:[asset],products:[{id:'tax',scope:'launchpad',label:'Transfer tax',feeLabel:'5%',feeBasis:'of collected transfer taxes',status:'partial',totals:[{...asset,paidAmount:null,pendingAmount:null}],note:'Historical receipts may be incomplete.'},{id:'lp',scope:'launchpad',label:'Locked LP yield',feeLabel:'75%',feeBasis:'of the launchpad LP fee entitlement',status:'available',totals:[]}]};
function page({account=admin,respond=async()=>result,features={toolkit:true}}={}){
  const {document}=parseHTML('<html><body></body></html>');Object.defineProperty(document,'hidden',{value:false,writable:true});
  const calls=[],timers=new Map();let nextTimer=0;
  const ui=createAdminRevenue({document,getAccount:()=>account,getFeatures:()=>features,api:async path=>{calls.push(path);return respond();},setTimer:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearTimer:id=>timers.delete(id)});document.body.append(ui.element);
  return{ui,document,calls,timers,setAccount:value=>{account=value;},visibility:hidden=>{document.hidden=hidden;document.dispatchEvent(new document.defaultView.Event('visibilitychange'));}};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

test('revenue uses exact asset decimals beyond Number precision and keeps missing amounts unknown',()=>{
  assert.equal(revenueAmount('9007199254740993123456',9),'9,007,199,254,740.993123456');
  assert.equal(revenueAmount('1',18),'0.000000000000000001');assert.equal(revenueAmount('0',9),'0');
  for(const value of [null,undefined,'1.5','-10','Infinity','<script>'])assert.equal(revenueAmount(value,9),null);
  assert.equal(revenueAmount('1',19),null);
});
test('revenue renders tax and LP percentage bases, real per-asset totals and missing settlement attribution',async()=>{
  const p=page();await p.ui.load();assert.deepEqual(p.calls,['/api/admin/revenue']);
  assert.match(p.ui.element.textContent,/5%of collected transfer taxes/);assert.match(p.ui.element.textContent,/75%of the launchpad LP fee entitlement/);
  assert.match(p.ui.element.textContent,/Historical receipts may be incomplete/);assert.match(p.ui.element.textContent,/Sent to treasury and pending transfer are gross amounts/);
  const amounts=[...p.ui.element.querySelectorAll('.admin-revenue-totals table .admin-revenue-amount')].map(el=>el.textContent);
  assert.deepEqual(amounts,['4','3','2','1']);assert.match(p.ui.element.querySelector('.admin-revenue-totals').textContent,/Launchpad wallet/);
  assert.deepEqual([...p.ui.element.querySelectorAll('.admin-revenue-product:first-child table .admin-revenue-amount')].map(el=>el.textContent),['4','—','—','1']);
  assert.match(p.ui.element.querySelector('.admin-revenue-gross').textContent,/Gross fees: 5 · Cashback allocated: 1/);
  assert.match(p.ui.element.textContent,/Updated /);assert.equal(p.timers.size,1);assert.equal([...p.timers.values()][0].ms,15000);p.ui.destroy();
});
test('revenue polls only for verified administrators while visible and clears after permission loss',async()=>{
  for(const account of [null,{role:'user',mfaEnabled:true},{role:'admin',mfaEnabled:false}]){const p=page({account});await p.ui.load();assert.equal(p.calls.length,0);assert.equal(p.timers.size,0);assert.equal(p.ui.element.hidden,true);p.ui.destroy();}
  const p=page();await p.ui.load();[...p.timers.values()][0].fn();await tick();assert.equal(p.calls.length,2);
  p.visibility(true);assert.equal(p.timers.size,0);await p.ui.load();assert.equal(p.calls.length,2);
  p.visibility(false);await tick();assert.equal(p.calls.length,3);assert.equal(p.timers.size,1);
  p.setAccount(null);await p.ui.load();assert.equal(p.timers.size,0);assert.equal(p.ui.element.hidden,true);assert.equal(p.ui.element.querySelector('table'),null);assert.equal(p.calls.length,3);
  p.ui.destroy();p.visibility(false);await tick();assert.equal(p.calls.length,3);
});
test('late responses cannot restore revenue after authentication gate or destroy',async()=>{
  let resolve;const p=page({respond:()=>new Promise(done=>{resolve=done;})});const loading=p.ui.load();p.ui.clear();resolve(result);await loading;
  assert.equal(p.ui.element.hidden,true);assert.equal(p.ui.element.querySelector('table'),null);assert.equal(p.timers.size,0);
  const second=p.ui.load();p.ui.destroy();resolve(result);await second;assert.equal(p.timers.size,0);assert.equal(p.ui.element.querySelector('table'),null);
});
test('clear lets a fresh authorized session load while an old request is still pending',async()=>{
  const resolvers=[];const p=page({respond:()=>new Promise(resolve=>resolvers.push(resolve))});const old=p.ui.load();p.ui.clear();const fresh=p.ui.load();
  assert.equal(resolvers.length,2);resolvers[0]({...result,note:'Old private snapshot'});await old;assert.equal(p.ui.element.querySelector('table'),null);
  resolvers[1](result);await fresh;assert.match(p.ui.element.textContent,/Confirmed receipts only/);assert(!p.ui.element.textContent.includes('Old private snapshot'));assert.equal(p.timers.size,1);p.ui.destroy();
});
test('refresh avoids overlap, preserves last confirmed values on failure and keeps metadata inert',async()=>{
  let fail=false;const p=page({respond:async()=>{if(fail)throw Error('private backend error');return {...result,note:'<script>bad()</script>',products:[{...result.products[0],label:'<img src=x onerror=bad()>',feeBasis:'<script>unsafe()</script>'}]};}});
  await p.ui.load();assert.match(p.ui.element.textContent,/<img src=x/);assert.equal(p.ui.element.querySelector('img,script'),null);
  fail=true;await p.ui.element.querySelector('button').onclick();assert.match(p.ui.element.textContent,/Showing the last confirmed snapshot/);assert.equal(p.ui.element.querySelector('.admin-revenue-amount').textContent,'4');assert(!p.ui.element.textContent.includes('private backend error'));p.ui.destroy();
  let resolve;const pending=page({respond:()=>new Promise(done=>{resolve=done;})});const one=pending.ui.load();await pending.ui.load();assert.equal(pending.calls.length,1);resolve(result);await one;pending.ui.destroy();
});
test('visible empty unavailable products do not imply zero earnings',async()=>{
  const p=page({respond:async()=>({...result,totals:[],products:[{...result.products[0],totals:[],status:'unavailable'}]})});await p.ui.load();assert.match(p.ui.element.textContent,/History unavailable/);assert.match(p.ui.element.textContent,/No confirmed totals are available/);assert.equal(p.ui.element.querySelector('.admin-revenue-amount'),null);p.ui.destroy();
});

test('funding with no protocol markup explicitly shows zero protocol earnings',async()=>{
  const p=page({respond:async()=>({...result,totals:[],products:[{id:'funding',label:'Funding',scope:'toolkit',feeLabel:'0%',feeBasis:'Third-party provider and network charges are separate.',noFees:true,totals:[],status:'available'}]})});await p.ui.load();assert.match(p.ui.element.querySelector('.admin-revenue-product').textContent,/0 protocol earnings. No Launchpad protocol fee applies/);assert(!p.ui.element.querySelector('.admin-revenue-product').textContent.includes('No confirmed'));p.ui.destroy();
});


test('launchpad-only revenue rejects toolkit rows and hides cashback copy while keeping tax and LP totals',async()=>{
  const mixed={...result,note:'Cashback from toolkit activity.',totals:[asset,{...asset,scope:'toolkit',symbol:'ETH',chain:'robinhood'}],products:[...result.products,{...result.products[0],id:'copy',label:'Copy trading',scope:'toolkit'}]};
  for(const features of [{},{toolkit:false}]){
    const p=page({features,respond:async()=>mixed});await p.ui.load();
    assert(!/cashback|toolkit|robinhood|Copy trading/i.test(p.ui.element.textContent));
    assert.equal(p.ui.element.querySelectorAll('.admin-revenue-product').length,2);assert.match(p.ui.element.textContent,/Transfer tax/);assert.match(p.ui.element.textContent,/Locked LP yield/);
    assert.deepEqual([...p.ui.element.querySelectorAll('.admin-revenue-totals th')].map(n=>n.textContent),['Asset','Earned','Sent to treasury','Pending transfer']);
    assert.deepEqual([...p.ui.element.querySelectorAll('.admin-revenue-totals table .admin-revenue-amount')].map(n=>n.textContent),['4','3','2']);p.ui.destroy();
  }
});
