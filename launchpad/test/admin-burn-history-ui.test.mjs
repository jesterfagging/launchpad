import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createAdminBurnHistory } from '../public/admin-burn-history-ui.mjs';

const account={id:'owner',role:'admin',mfaEnabled:true};
const burnSignature='22TcPEZoA5t5HYWhmRWYZN1CxwjUMmPWoe1qh2ZZcNwg6H5h28dxUE7ieCApuPKBAtHTujgkNZiLmmm66Bc76EY5';
const buySignature='3P4DRKBuHcNta7aAgDPw5W2mGkwR517mRLHhz2NxRc1gSc1wbAYQB4Dyw3UiTK3tse9Ss37S2mmLWC6c1ZzikjmH';
const link=signature=>'https://solscan.io/tx/'+signature;
const burn={kind:'burn',signature:burnSignature,inputAmount:'50000000000000',outputAmount:'0',curveDecimals:6,confirmedAt:1790647124000,source:'admin'};
const buy={kind:'buy',signature:buySignature,inputAmount:'9007199254740993123456',outputAmount:'91521348000001',curveDecimals:6,confirmedAt:1790647123000,source:'admin'};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const submit=p=>p.get('admin-burn-history-form').onsubmit({preventDefault(){}});
function page({respond=async()=>({history:[]}),authorize=async()=>({password:'private-test',code:'123456'}),owner=account}={}){
  const {document}=parseHTML('<html><body></body></html>');let currentAccount=owner,active=true;
  const calls=[],authorizations=[];
  const ui=createAdminBurnHistory({document,getAccount:()=>currentAccount,isActive:()=>active,
    api:async(path,body,options)=>{calls.push({path,body,options});return respond(path,body,options);},
    protectedAction:async(title,task)=>{authorizations.push(title);return task(await authorize());}});
  document.body.append(ui.element);
  return {ui,document,calls,authorizations,get:id=>document.getElementById(id),setAccount:value=>{currentAccount=value;},setActive:value=>{active=value;},fill:(buyback='')=>{document.getElementById('admin-burn-history-burn').value=link(burnSignature);document.getElementById('admin-burn-history-buyback').value=buyback;}};
}

test('burn-only import uses a required burn field, optional buyback, verified exact receipt and analytics link',async()=>{
  const p=page({respond:async(path,body)=>({history:body?[burn]:[],added:1})});await p.ui.load();
  assert.equal(p.get('admin-burn-history-burn').required,true);assert.notEqual(p.get('admin-burn-history-buyback').required,true);
  assert.match(p.ui.element.textContent,/Leave buyback blank to record a burn only/);assert.equal(p.ui.element.querySelectorAll('input').length,2);
  p.fill();p.get('admin-burn-history-burn').value='https://www.solscan.io/tx/'+burnSignature;await submit(p);
  assert.deepEqual(p.calls[1].body,{burnLink:'https://www.solscan.io/tx/'+burnSignature,password:'private-test',code:'123456'});
  assert.equal(p.authorizations.length,1);assert.match(p.get('admin-burn-history-status').textContent,/Added to analytics/);
  assert.match(p.get('admin-burn-history-records').textContent,/50,000,000 LAUNCHPAD/);
  assert.equal(p.get('admin-burn-history-analytics').href,'/analytics');assert.equal(p.get('admin-burn-history-analytics').hidden,false);
  assert.equal(p.get('admin-burn-history-burn').value,'');assert(!p.ui.element.textContent.includes('private-test'));p.ui.destroy();
});

test('buyback and burn imports show exact SOL and LAUNCHPAD amounts and durable history reloads',async()=>{
  let saved=[];const p=page({respond:async(path,body)=>{if(body)saved=[burn,buy];return {history:saved,added:body?2:0};}});
  await p.ui.load();p.fill(link(buySignature));await submit(p);
  assert.equal(p.calls[1].body.buybackLink,link(buySignature));
  assert.match(p.ui.element.textContent,/9,007,199,254,740\.993123456 SOL spent/);
  assert.match(p.ui.element.textContent,/91,521,348\.000001 LAUNCHPAD/);
  p.ui.clear();await p.ui.load();assert.match(p.get('admin-burn-history-records').textContent,/50,000,000 LAUNCHPAD/);
  const links=[...p.get('admin-burn-history-records').querySelectorAll('a')];assert.deepEqual(links.map(n=>n.href),[link(burnSignature),link(buySignature)]);
  assert(links.every(n=>n.target==='_blank'&&n.rel==='noopener noreferrer'));p.ui.destroy();
});

test('failed verification preserves both fields and a successful retry is idempotently reported',async()=>{
  let fail=true;const p=page({respond:async(path,body)=>{if(body&&fail)throw Error('Burn transaction has not finalized. Try again shortly.');return {history:body?[burn,buy]:[],added:0};}});
  await p.ui.load();p.fill(link(buySignature));await submit(p);
  assert.match(p.get('admin-burn-history-status').textContent,/has not finalized/);assert.equal(p.get('admin-burn-history-burn').value,link(burnSignature));assert.equal(p.get('admin-burn-history-buyback').value,link(buySignature));assert.equal(p.get('admin-burn-history-submit').disabled,false);
  fail=false;await submit(p);assert.match(p.get('admin-burn-history-status').textContent,/Already recorded.*No duplicate/);assert.equal(p.get('admin-burn-history-records').querySelectorAll('li').length,2);p.ui.destroy();
});

test('malformed links and non-mainnet links do not request authorization; returned HTML and links stay inert',async()=>{
  const p=page({respond:async()=>({history:[{...burn,signature:'javascript:alert(1)'},{...burn,inputAmount:'<img src=x onerror=bad()>',signature:burnSignature,link:'javascript:alert(1)'}]})});await p.ui.load();
  for(const invalid of ['',link(burnSignature)+'?cluster=devnet','https://evil.example/tx/'+burnSignature,'https://solscan.io.evil.example/tx/'+burnSignature,'https://user:pass@solscan.io/tx/'+burnSignature,'<img src=x>']){
    p.get('admin-burn-history-burn').value=invalid;await submit(p);
  }
  assert.equal(p.authorizations.length,0);assert.equal(p.calls.length,1);assert.equal(p.ui.element.querySelector('img,script'),null);
  const links=[...p.get('admin-burn-history-records').querySelectorAll('a')];assert.deepEqual(links.map(n=>n.href),[link(burnSignature)]);assert.match(p.get('admin-burn-history-records').textContent,/LAUNCHPAD burned —/);
  p.fill('https://solscan.io/account/'+burnSignature);await submit(p);assert.equal(p.authorizations.length,0);p.ui.destroy();
});

test('overlapping submits are blocked and a late history response cannot replace an import receipt',async()=>{
  let finishRead,finishPost;const p=page({respond:async(path,body)=>new Promise(resolve=>{if(body)finishPost=resolve;else finishRead=resolve;})});
  const loading=p.ui.load();p.fill();const saving=submit(p);await tick();await submit(p);
  assert.equal(p.calls.length,2);assert.equal(p.authorizations.length,1);assert.equal(p.calls[0].options.signal.aborted,true);
  for(const id of ['admin-burn-history-burn','admin-burn-history-buyback','admin-burn-history-submit','admin-burn-history-refresh'])assert.equal(p.get(id).disabled,true);
  finishPost({history:[burn],added:1});await saving;finishRead({history:[]});await loading;
  assert.match(p.get('admin-burn-history-records').textContent,/50,000,000/);assert.match(p.get('admin-burn-history-status').textContent,/Added to analytics/);p.ui.destroy();
});

test('logout before authorization blocks import; late POST or GET cannot restore cleared data',async()=>{
  let authorize;const before=page({authorize:()=>new Promise(resolve=>{authorize=resolve;})});await before.ui.load();before.fill();const saving=submit(before);before.setAccount(null);before.ui.clear();authorize({code:'123456'});await saving;
  assert.equal(before.calls.length,1);assert.equal(before.ui.element.hidden,true);assert.equal(before.get('admin-burn-history-burn').value,'');before.ui.destroy();
  for(const mode of ['GET','POST']){
    let finish;const p=page({respond:async(path,body)=>mode==='GET'||body?new Promise(resolve=>{finish=resolve;}):{history:[]}});
    let pending;if(mode==='POST'){await p.ui.load();p.fill();pending=submit(p);await tick();}else pending=p.ui.load();
    p.setAccount(null);p.ui.clear();finish({history:[burn],added:1});await pending;
    assert.equal(p.ui.element.hidden,true);assert.equal(p.get('admin-burn-history-records').children.length,0);assert.equal(p.get('admin-burn-history-analytics').hidden,true);p.ui.destroy();
  }
});

test('access and inactive section prevent requests; cancel preserves input without claiming success',async()=>{
  for(const owner of [null,{...account,role:'user'},{...account,mfaEnabled:false}]){
    const p=page({owner});await p.ui.load();p.fill();await submit(p);assert.equal(p.calls.length,0);assert.equal(p.ui.element.hidden,true);p.ui.destroy();
  }
  const p=page({authorize:async()=>{throw Error('Cancelled.');}});await p.ui.load();p.fill();await submit(p);assert.equal(p.calls.length,1);assert.equal(p.get('admin-burn-history-burn').value,link(burnSignature));assert.match(p.get('admin-burn-history-status').textContent,/Nothing was added/);
  p.setActive(false);await p.ui.load();await submit(p);assert.equal(p.calls.length,1);p.ui.destroy();
});
