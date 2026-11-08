import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createAdminBranding} from '../public/admin-branding-ui.mjs';

const ACCOUNT='a'.repeat(32),ID='b'.repeat(32),MINT='So11111111111111111111111111111111111111112';
const coin=(patch={})=>({accountId:ACCOUNT,id:ID,name:'Example',symbol:'COIN',mint:MINT,currentBrand:{name:'Previous name',web:'https://old.example'},status:'legacy',eligibility:{allowed:true,reason:''},...patch});
function page({coins=[coin()],account={role:'admin',mfaEnabled:true},requiresPublishedLogo=true,respond,authorize,brand={name:'Launchpad',web:'https://launchpad.example',img:'https://launchpad.example/brand-avatar.png'}}={}){
  const {document}=parseHTML('<html><body></body></html>'),calls=[],checks=[],messages=[];
  const ui=createAdminBranding({document,getAccount:()=>account,api:async(path,body)=>{calls.push({path,body});return await respond?.(path,body)??(body?{coin:{...coins[0],status:'queued'},alreadyRequested:false}:{brand,requiresPublishedLogo,coins});},security:{authorize:async(...args)=>{checks.push(args);return authorize?authorize(...args):{password:'test-password',code:'123456'};}},message:(...args)=>messages.push(args)});document.body.append(ui.element);return {ui,document,calls,checks,messages};
}
const prepare=p=>{const form=p.ui.element.querySelector('.admin-branding-coin form');form.querySelector('input').value='Update platform attribution to Launchpad.';const ack=form.querySelector('input[type=checkbox]');if(ack)ack.checked=true;return form;};

test('branding inventory loads only for verified admin accounts and never starts an update automatically',async()=>{
  for(const account of [null,{role:'user',mfaEnabled:true},{role:'admin',mfaEnabled:false}]){const p=page({account});await p.ui.load();assert.equal(p.calls.length,0);assert.equal(p.ui.element.hidden,true);}
  const p=page();await p.ui.load();assert.deepEqual(p.calls.map(call=>call.path),['/api/admin/branding']);assert.match(p.ui.element.textContent,/Coin names, tickers, images, fees and liquidity stay unchanged/);assert.equal(p.ui.element.querySelector('a').href,'https://launchpad.example/');assert.match(p.ui.element.textContent,/Current attribution: Previous name/);
});
test('canonical logo updates require explicit publication acknowledgment before fresh MFA',async()=>{
  const p=page();await p.ui.load();const form=prepare(p);form.querySelector('input[type=checkbox]').checked=false;await form.onsubmit({preventDefault(){}});assert.equal(p.checks.length,0);assert(!p.calls.some(call=>call.body));form.querySelector('input[type=checkbox]').checked=true;await form.onsubmit({preventDefault(){}});
  const post=p.calls.find(call=>call.body);assert.equal(post.path,'/api/admin/branding/update');assert.equal(post.body.confirmPublishedLogo,true);assert.equal(post.body.accountId,ACCOUNT);assert.equal(post.body.id,ID);assert.match(post.body.requestId,/^[a-f0-9-]{36}$/);assert.equal(p.checks[0][1].requireCode,true);assert.equal(post.body.code,'123456');assert.equal(p.document.body.textContent.includes('test-password'),false);assert.match(p.ui.element.textContent,/Update queued/);assert.equal(p.ui.element.querySelector('.admin-branding-coin button').disabled,true);assert(p.messages.some(([text])=>text.includes('Wait for onchain confirmation')));
});
test('permanent logo updates do not require the deployment checkbox and cannot mutate user token metadata',async()=>{
  const p=page({requiresPublishedLogo:false,brand:{name:'Launchpad',web:'https://launchpad.example',img:'https://gateway.irys.xyz/verified'}});await p.ui.load();const form=prepare(p);assert.equal(form.querySelector('input[type=checkbox]'),null);await form.onsubmit({preventDefault(){}});const body=p.calls.find(call=>call.body).body;assert.deepEqual(Object.keys(body).sort(),['accountId','code','id','password','reason','requestId']);
});
test('branding permission loss cancels an awaiting approval and late inventory responses',async()=>{
  let approve;const p=page({authorize:()=>new Promise(resolve=>{approve=resolve;})});await p.ui.load();const pending=prepare(p).onsubmit({preventDefault(){}});p.ui.clear();approve({password:'test-password',code:'123456'});await pending;assert(!p.calls.some(call=>call.body));assert.equal(p.ui.element.hidden,true);assert.equal(p.ui.element.querySelector('.admin-branding-coin'),null);
  let resolve;const delayed=page({respond:()=>new Promise(done=>{resolve=done;})});const loading=delayed.ui.load();delayed.ui.clear();resolve({brand:{name:'Launchpad'},coins:[coin()]});await loading;assert.equal(delayed.ui.element.hidden,true);assert.equal(delayed.ui.element.querySelector('.admin-branding-coin'),null);
});
test('uncertain branding mutations reuse their request ID instead of queuing a second transaction',async()=>{
  let attempts=0;const p=page({respond:(path,body)=>{if(body&&attempts++===0)throw Error('Network interrupted.');}});await p.ui.load();const form=prepare(p);await form.onsubmit({preventDefault(){}});await form.onsubmit({preventDefault(){}});const posts=p.calls.filter(call=>call.body);assert.equal(posts.length,2);assert.equal(posts[0].body.requestId,posts[1].body.requestId);assert.equal(p.checks.length,2);
});
test('ineligible or pending records are disabled and unsafe metadata remains inert text',async()=>{
  const p=page({coins:[coin({name:'<img src=x onerror=bad()>',currentBrand:{name:'<script>bad()</script>',web:'javascript:bad()'},eligibility:{allowed:false,reason:'Platform authority unavailable.'}})],brand:{name:'Launchpad',web:'javascript:bad()',img:'data:text/html,bad'}});await p.ui.load();assert.equal(p.ui.element.querySelector('img,script,a'),null);assert.match(p.ui.element.textContent,/<img src=x/);const form=prepare(p);assert.equal(form.querySelector('button').disabled,true);await form.onsubmit({preventDefault(){}});assert.equal(p.checks.length,0);
  for(const status of ['queued','pending','updated']){const other=page({coins:[coin({status})]});await other.ui.load();await prepare(other).onsubmit({preventDefault(){}});assert.equal(other.checks.length,0);}
});
test('search and pagination operate on actual branding records without showing fabricated launches',async()=>{
  const p=page({coins:Array.from({length:12},(_,i)=>coin({id:String(i),name:'Coin '+i}))});await p.ui.load();assert.equal(p.ui.element.querySelectorAll('.admin-branding-coin').length,10);p.ui.element.querySelector('.admin-pagination button:last-child').onclick();assert.equal(p.ui.element.querySelectorAll('.admin-branding-coin').length,2);const search=p.ui.element.querySelector('input[type=search]');search.value='missing';search.oninput();assert.equal(p.ui.element.querySelectorAll('.admin-branding-coin').length,0);assert.match(p.ui.element.textContent,/No matching launch records/);
});


test('unpublished-domain branding distinguishes the installed preview from the public onchain logo',async()=>{
  const p=page();await p.ui.load();
  const links=[...p.ui.element.querySelectorAll('a')];
  assert.equal(links.find(link=>link.textContent==='Preview installed logo ↗')?.getAttribute('href'),'/brand-avatar.png');
  assert.equal(links.find(link=>link.textContent==='Check public logo ↗')?.href,'https://launchpad.example/brand-avatar.png');
  assert.match(p.ui.element.textContent,/running it on localhost does not publish the logo/);
  assert.equal(p.calls.filter(call=>call.body).length,0);
  const permanent=page({requiresPublishedLogo:false,brand:{name:'Launchpad',web:'https://launchpad.example',img:'https://gateway.irys.xyz/verified'}});await permanent.ui.load();
  assert(![...permanent.ui.element.querySelectorAll('a')].some(link=>link.textContent.includes('installed logo')));
});
