import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { createAdminPage } from '../public/admin.js';
import { createAccountSecurity } from '../public/account-security-ui.js';
const ADMIN='a'.repeat(32),USER='b'.repeat(32),WALLET='11111111111111111111111111111111';
const account={id:ADMIN,username:'owner',role:'admin',mfaEnabled:true};
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
async function page(t,{pumpTestAllowed=false,session={authenticated:true,token:'csrf-admin',account,monitorAllowed:true,pumpTestAllowed,features:{toolkit:true,telegram:true}},respond,authorize,useRealSecurity=false,section='overview',hash='',launchFactory}={}){
  const {document,window}=parseHTML(await readFile(new URL('../public/admin.html',import.meta.url),'utf8'));
  Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return [...this.options].find(option=>option.selected)?.value||this.options[0]?.value||'';},set(value){for(const option of this.options)option.removeAttribute('selected');[...this.options].find(option=>option.value===String(value))?.setAttribute('selected','');}});
  Object.defineProperty(document,'hidden',{value:false,writable:true});for(const dialog of document.querySelectorAll('dialog')){dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;};}
  if(useRealSecurity){const previous=globalThis.document;globalThis.document=document;t.after(()=>{globalThis.document=previous;});}
  const calls=[],authorizations=[],shells=[],events=new Map(),intervals=[],timers=new Map(),location={hash},history=[];let launchLoads=0,launchClears=0;
  const fetcher=async(path,options)=>{calls.push({path,options});let data=await respond?.(path,options);data??=path==='/api/session'?session:path==='/api/admin/overview'?{counts:{accounts:2,launches:4,holderLaunches:2,buybackLaunches:1},fees:{solana:{recipient:WALLET,ready:true},robinhood:{recipient:'0x'+'1'.repeat(40),ready:true}}}:path==='/api/admin/accounts'?{accounts:[account,{id:USER,username:'<img src=x onerror=bad()>',role:'user',mainWallet:WALLET,cashbackBps:2500}]}:path==='/api/account/connections/husher'?options.method==='POST'?JSON.parse(options.body).action==='reveal'?{apiKey:'private-test-key'}:{configured:true}:{configured:true}:path.startsWith('/api/admin/sessions?')?{page:0,pageSize:50,total:1,users:[{id:USER,username:'User one',sessions:[{chain:'solana',kind:'copy',state:'running'}]}]}:path.startsWith('/api/admin/session?')?{account:{id:USER,username:'User one'},state:'running',exportedAt:1700000000000,positions:[],pending:[],metrics:{confirmed:8},events:[{at:1700000000000,level:'info',message:'<script>unsafe()</script>'}]}:{};
    const status=Number(data.status)||200;if(typeof data.html==='string')return{ok:status<400,status,headers:{get:name=>String(name).toLowerCase()==='content-type'?'text/html; charset=utf-8':null},json:async()=>JSON.parse(data.html)};return{ok:status<400,status,json:async()=>data.body||data};};
  const app=createAdminPage({document,window:{setTimeout,clearTimeout,location,history:{pushState:(state,title,url)=>{location.hash=url;history.push(url);},replaceState:(state,title,url)=>{location.hash=url;}},addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name)},fetcher,shell:args=>shells.push(args),setTimer:fn=>{intervals.push(fn);timers.set(intervals.length,fn);return intervals.length;},clearTimer:id=>timers.delete(id),securityFactory:useRealSecurity?createAccountSecurity:()=>({authorize:async(...args)=>{authorizations.push(args);return authorize?authorize(...args):{password:'test-password',code:'123456'};},render(){}}),launchFactory:launchFactory?()=>launchFactory(document):()=>({element:document.createElement('section'),load:async()=>{launchLoads++;},clear:()=>{launchClears++;}})});t.after(()=>app.destroy());await app.ready;if(section!=='overview')await app.selectSection(section);await flush();return {document,app,calls,authorizations,shells,events,intervals,timers,location,history,poll:async()=>{for(const fn of [...timers.values()])fn();await flush();await flush();},get:id=>document.getElementById(id),launchLoads:()=>launchLoads,launchClears:()=>launchClears};
}
test('unauthenticated users, regular accounts, and admins missing verified MFA never load private admin data',async t=>{
  for(const session of [{authenticated:false},{authenticated:true,account:{...account,role:'user'},monitorAllowed:true},{authenticated:true,account:{...account,mfaEnabled:false},monitorAllowed:false},{authenticated:true,account,monitorAllowed:false}]){
    const ui=await page(t,{session});assert.equal(ui.get('admin-main').hidden,true);assert.equal(ui.get('admin-gate').hidden,false);assert.deepEqual(ui.calls.map(call=>call.path),['/api/session']);assert.equal(ui.launchLoads(),0);
  }
});
test('authorized administrators start in a focused overview and load controls when their section opens',async t=>{
  const ui=await page(t);assert.equal(ui.get('admin-main').hidden,false);assert.equal(ui.get('admin-gate').hidden,true);assert.match(ui.get('admin-overview').textContent,/Accounts2/);assert.equal(ui.launchLoads(),0);
  assert.deepEqual(ui.calls.map(call=>call.path),['/api/session','/api/admin/overview','/api/admin/volume']);
  assert.deepEqual([...ui.document.querySelectorAll('[role=tab]')].filter(tab=>!tab.hidden).map(tab=>tab.textContent),['Overview','Revenue','Tokens','Pairs','Users','Settings']);
  for(const key of ['overview','revenue','tokens','pairs','users','pump-test','settings'])assert.equal(ui.get('admin-panel-'+key).hidden,key!=='overview');
  await ui.app.selectSection('revenue');assert.equal(ui.get('admin-fee-forms').querySelectorAll('form').length,2);
  await ui.app.selectSection('tokens');assert.equal(ui.launchLoads(),1);
  await ui.app.selectSection('users');assert.equal(ui.get('admin-user-list').querySelectorAll('form').length,2);assert.equal(ui.get('admin-session-users').querySelectorAll('button').length,1);
  assert.equal(ui.shells[0].page,'admin');assert(ui.calls.filter(call=>call.path!=='/api/session').every(call=>call.options.headers['x-control-token']==='csrf-admin'));assert.equal(ui.get('admin-user-list').querySelector('img'),null);assert.match(ui.get('admin-user-list').textContent,/<img src=x/);
  assert.equal(ui.get('admin-security-open').hidden,false);
});

test('legacy PumpSwap Lab stays collapsed until opened, remains model-only and clears on session expiry',async t=>{
  let expired=false;
  const ui=await page(t,{pumpTestAllowed:true,respond:path=>path==='/api/admin/pump-test'?expired?{status:401,body:{error:'Sign in again.'}}:{mode:'local-test',network:'none',fundedLaunchEnabled:false,publicLaunchEnabled:false,verification:{model:'passed'}}:path==='/api/admin/pump-test/preview'?{estimate:{quoteCollectedUsd:'21808',graduationFeeUsd:'6291',lpQuoteUsd:'15517.5',lpTokenValueUsd:'15517.5',lpTotalUsd:'31035',poolOpeningFdvUsd:'50000'}}:undefined});
  assert.equal(ui.calls.some(call=>call.path.includes('/pump-test')),false);
  assert.equal(ui.get('admin-pump-test'),null);
  await ui.app.selectSection('pump-test');
  const legacy=ui.document.querySelector('.admin-pump-legacy');assert.equal(!!legacy.open,false);assert.equal(ui.calls.some(call=>call.path.includes('/pump-test')),false);
  assert(ui.get('admin-meteora'));legacy.open=true;await ui.app.refresh();
  assert.match(ui.get('admin-pump-test').textContent,/Simulation only • no funds moved/);
  assert.equal(ui.get('admin-pump-test').closest('#admin-panel-pump-test').id,'admin-panel-pump-test');
  ui.get('admin-pump-test-graduation-fee').value='28.85';ui.get('admin-pump-test-sol-usd').value='150';
  await ui.get('admin-pump-test-form').onsubmit({preventDefault(){}});
  const post=ui.calls.find(call=>call.path==='/api/admin/pump-test/preview');assert(post);assert.equal(post.options.method,'POST');assert.equal(post.options.headers['x-control-token'],'csrf-admin');
  assert.match(ui.get('admin-pump-test-results').textContent,/\$31,035\.00/);
  assert.equal(ui.authorizations.length,0);
  expired=true;await ui.app.refresh();
  assert.equal(ui.get('admin-main').hidden,true);assert.equal(ui.get('admin-pump-test').hidden,true);assert.equal(ui.get('admin-pump-test-results').children.length,0);assert.equal(ui.get('admin-pump-test-sol-usd').value,'');
});

test('other administrators cannot open PumpSwap Lab by hash or keyboard without its owner capability',async t=>{
  const ui=await page(t,{hash:'#pump-test'});
  assert.equal(ui.get('admin-main').hidden,false);assert.equal(ui.get('admin-pump-test-nav').hidden,true);assert.equal(ui.get('admin-panel-pump-test').hidden,true);
  assert.equal(ui.get('admin-panel-overview').hidden,false);assert.equal(ui.get('admin-pump-test'),null);assert.equal(ui.calls.some(call=>call.path.includes('/pump-test')),false);
  assert.equal(ui.get('admin-meteora'),null);assert.equal(ui.calls.some(call=>call.path.includes('/meteora')),false);
  await ui.app.selectSection('users');let focused='';ui.get('admin-settings-nav').focus=()=>{focused='settings';};
  await ui.get('admin-users-nav').onkeydown({key:'ArrowRight',preventDefault(){}});assert.equal(focused,'settings');
  await ui.app.selectSection('pump-test');assert.equal(ui.get('admin-panel-overview').hidden,false);assert.equal(ui.calls.some(call=>call.path.includes('/pump-test')),false);
});

test('losing only PumpSwap owner access clears the lab without closing the rest of administration',async t=>{
  let denied=false;
  const ui=await page(t,{pumpTestAllowed:true,section:'pump-test',respond:path=>path==='/api/admin/pump-test'?denied?{status:403,body:{error:'Private owner access unavailable.'}}:{mode:'local-test',network:'none',fundedLaunchEnabled:false,publicLaunchEnabled:false}:undefined});
  ui.document.querySelector('.admin-pump-legacy').open=true;await ui.app.refresh();
  assert.equal(ui.get('admin-pump-test-nav').hidden,false);ui.get('admin-pump-test-sol-usd').value='150';
  denied=true;await ui.app.refresh();await flush();
  assert.equal(ui.get('admin-main').hidden,false);assert.equal(ui.get('admin-gate').hidden,true);assert.equal(ui.get('admin-pump-test-nav').hidden,true);
  assert.equal(ui.get('admin-panel-overview').hidden,false);assert.equal(ui.get('admin-pump-test-sol-usd').value,'');
  await ui.app.selectSection('users');assert.equal(ui.get('admin-panel-users').hidden,false);
});

test('Meteora setup and opening use the owner Launch modes section with CSRF and no automatic legacy requests',async t=>{
  let configured=false,enabled=false;const ui=await page(t,{pumpTestAllowed:true,respond:(path,options)=>{
    if(path==='/api/admin/meteora/status')return {configured,publicEnabled:enabled,canEnable:configured,authority:WALLET,balanceLamports:'100000000',minimumBalanceLamports:'100000000',pairSummary:{available:2,complete:true},blockers:[]};
    if(path==='/api/admin/meteora/setup'){configured=true;return {configured:true};}
    if(path==='/api/admin/meteora/configure'){enabled=JSON.parse(options.body).enabled;return {publicEnabled:enabled};}
  }});
  assert.equal(ui.calls.some(c=>c.path.includes('/meteora')),false);await ui.app.selectSection('pump-test');assert.equal(ui.get('admin-meteora').hidden,false);assert.equal(ui.calls.some(c=>c.path.includes('/pump-test')||c.path.includes('/pump-public')),false);
  await ui.get('admin-meteora-setup').onclick();await ui.get('admin-meteora-enable').onclick();await ui.get('admin-meteora-confirm').onclick();assert.match(ui.get('admin-meteora-status').textContent,/open for new launches/);
  const writes=ui.calls.filter(c=>c.path.startsWith('/api/admin/meteora/')&&c.options.method==='POST');assert.deepEqual(writes.map(c=>[c.path,JSON.parse(c.options.body)]),[['/api/admin/meteora/setup',{}],['/api/admin/meteora/configure',{enabled:true}]]);assert(writes.every(c=>c.options.headers['x-control-token']==='csrf-admin'));
});

test('Meteora owner capability denial clears Launch modes while keeping ordinary administration available',async t=>{
  let denied=false;const ui=await page(t,{pumpTestAllowed:true,section:'pump-test',respond:path=>path==='/api/admin/meteora/status'?denied?{status:403,body:{error:'Private owner access unavailable.'}}:{configured:true,publicEnabled:false,canEnable:true,authority:WALLET,pairSummary:{complete:true,available:1},blockers:[]}:undefined});
  assert.equal(ui.get('admin-meteora').hidden,false);denied=true;await ui.app.refresh();await flush();
  assert.equal(ui.get('admin-main').hidden,false);assert.equal(ui.get('admin-pump-test-nav').hidden,true);assert.equal(ui.get('admin-panel-overview').hidden,false);assert.equal(ui.get('admin-meteora').hidden,true);assert.equal(ui.get('admin-meteora-facts').children.length,0);
  await ui.app.selectSection('users');assert.equal(ui.get('admin-panel-users').hidden,false);
});

test('session capability refresh and explicit revocation both clear the active owner lab',async t=>{
  let capability=true;
  const ui=await page(t,{section:'pump-test',respond:path=>path==='/api/session'?{authenticated:true,token:'csrf-admin',account,monitorAllowed:true,pumpTestAllowed:capability,features:{toolkit:true,telegram:true}}:path==='/api/admin/pump-test'?{mode:'local-test',network:'none',fundedLaunchEnabled:false,publicLaunchEnabled:false}:undefined});
  assert.equal(ui.get('admin-pump-test-nav').hidden,false);ui.get('admin-pump-test-sol-usd').value='150';capability=false;await ui.app.initialize();
  assert.equal(ui.get('admin-pump-test-nav').hidden,true);assert.equal(ui.get('admin-panel-overview').hidden,false);assert.equal(ui.get('admin-pump-test-sol-usd').value,'');
  capability=true;await ui.app.initialize();await ui.app.selectSection('pump-test');ui.get('admin-pump-test-sol-usd').value='200';
  ui.document.dispatchEvent(new ui.document.defaultView.CustomEvent('curve-account-updated',{detail:{account,pumpTestAllowed:false}}));await flush();
  assert.equal(ui.get('admin-pump-test-nav').hidden,true);assert.equal(ui.get('admin-panel-overview').hidden,false);assert.equal(ui.get('admin-pump-test-sol-usd').value,'');assert.equal(ui.get('admin-main').hidden,false);
});
test('volume is in Overview and financial controls share the Revenue section',async t=>{
  const ui=await page(t,{respond:path=>path==='/api/admin/volume'?{at:Date.now(),volumeUsd:1234.5,observedVolumeUsd:1234.5,lifetime:{recordedVolumeUsdEstimate:1234.5,pricedVolumeUsdEstimate:1234.5,tradeCount:12,quoteTotals:[],coverage:{historyComplete:true,launches:2,backfilledLaunches:2}},coverage:{launches:2,complete:2,usdComplete:2,inventoryComplete:true},quoteTotals:[],coins:[]}:undefined});
  assert.match(ui.get('admin-volume').textContent,/\$1,234.50/);
  assert.equal(ui.get('admin-volume').parentElement.id,'admin-panel-overview');
  assert.equal(ui.get('admin-revenue-audit').parentElement.id,'admin-panel-revenue');
  assert.equal(ui.calls.some(call=>call.path==='/api/admin/revenue-audit'),false);
  await ui.app.selectSection('revenue');
  for(const id of ['admin-protocol','admin-treasury','admin-burn-history','admin-gas-funding','admin-revenue','admin-revenue-audit','admin-platform'])assert.equal(ui.get(id).parentElement.id,'admin-panel-revenue');
  assert.equal(ui.calls.some(call=>call.path==='/api/admin/revenue-audit'),false,'Revenue checks load only on their own page');
  await ui.app.selectSection('revenue',{sub:'checks'});assert(ui.calls.some(call=>call.path==='/api/admin/revenue-audit'));
  assert.equal(ui.calls.some(call=>call.options.method==='POST'),false);
});
test('fee settings and cashback require a fresh identity check, with no credentials rendered',async t=>{
  const ui=await page(t,{section:'revenue'});const form=ui.get('admin-fee-forms').querySelector('form');form.querySelector('input').value=WALLET;await form.onsubmit({preventDefault(){}});assert.equal(ui.authorizations.length,1);assert.equal(ui.authorizations[0][1].requireCode,true);let post=ui.calls.find(call=>call.path==='/api/admin/fees');assert(post);assert.deepEqual(JSON.parse(post.options.body),{recipient:WALLET,password:'test-password',code:'123456'});
  await ui.app.selectSection('users');const userForm=ui.get('admin-user-list').querySelectorAll('form')[1];userForm.querySelector('input').value='12.34';await userForm.onsubmit({preventDefault(){}});post=ui.calls.find(call=>call.path==='/api/admin/cashback');assert.equal(JSON.parse(post.options.body).cashbackBps,1234);assert.equal(JSON.parse(post.options.body).accountId,USER);assert.equal(ui.authorizations.length,2);assert(!ui.document.body.textContent.includes('test-password'));
});
test('invalid cashback is rejected before authorization or mutation',async t=>{
  const ui=await page(t,{section:'users'}),form=ui.get('admin-user-list').querySelector('form');for(const value of ['','-1','100.01','2.345']){form.querySelector('input').value=value;await form.onsubmit({preventDefault(){}});}assert.equal(ui.authorizations.length,0);assert.equal(ui.calls.some(call=>call.options.method==='POST'),false);assert.match(ui.get('admin-message').textContent,/two decimal places/);
});
test('cancelled identity checks cannot update fee wallets',async t=>{
  const ui=await page(t,{section:'revenue',authorize:async()=>{throw Error('Cancelled.');}});await ui.get('admin-fee-forms').querySelector('form').onsubmit({preventDefault(){}});assert.equal(ui.calls.some(call=>call.options.method==='POST'),false);assert.equal(ui.get('admin-message').hidden,true);
});
test('admin financial settings reuse the account identity dialog and clear submitted credentials',async t=>{
  const ui=await page(t,{section:'revenue',useRealSecurity:true}),dialog=ui.get('security-auth');dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;dialog.dispatchEvent(new ui.document.defaultView.Event('close'));};ui.get('security-auth-form').reset=()=>{for(const input of ui.get('security-auth-form').querySelectorAll('input'))input.value='';};
  const pending=ui.get('admin-fee-forms').querySelector('form').onsubmit({preventDefault(){}});await flush();assert.equal(dialog.open,true);assert.equal(ui.get('security-auth-code').required,true);ui.get('security-auth-password').value='confirmed-secret';ui.get('security-auth-code').value='654321';ui.get('security-auth-form').onsubmit({preventDefault(){}});await pending;const post=ui.calls.find(call=>call.path==='/api/admin/fees');assert.equal(JSON.parse(post.options.body).password,'confirmed-secret');assert.equal(JSON.parse(post.options.body).code,'654321');assert.equal(dialog.open,false);assert.equal(ui.get('security-auth-password').value,'');assert.equal(ui.get('security-auth-code').value,'');
});
test('saved Husher key is never fetched automatically, requires explicit authorization and clears when hidden',async t=>{
  const ui=await page(t,{section:'settings'});assert.equal(ui.get('admin-husher-key').value,'');assert(!ui.document.body.textContent.includes('private-test-key'));assert.equal(ui.calls.some(call=>call.options.method==='POST'),false);await ui.get('admin-husher-reveal').onclick();assert.equal(ui.get('admin-husher-key').value,'private-test-key');assert.equal(ui.get('admin-husher-key').type,'text');assert.equal(ui.authorizations[0][1].requireCode,true);ui.document.hidden=true;ui.document.dispatchEvent(new ui.document.defaultView.Event('visibilitychange'));assert.equal(ui.get('admin-husher-key').value,'');assert.equal(ui.get('admin-husher-key').type,'password');
});
test('session inspector loads actual selected user activity and treats event content as text',async t=>{
  const ui=await page(t,{section:'users'});ui.get('admin-session-users').querySelector('button').onclick();await flush();await flush();assert.match(ui.get('admin-session-detail').textContent,/running/);assert.match(ui.get('admin-session-detail').textContent,/Confirmed8/);assert.match(ui.get('admin-session-detail').textContent,/<script>unsafe\(\)<\/script>/);assert.equal(ui.get('admin-session-detail').querySelector('script'),null);assert(ui.calls.some(call=>call.path.includes('accountId='+USER)&&call.path.includes('chain=solana')&&call.path.includes('kind=copy')));
});
test('expired authorization clears private panels and pending identity prompts cannot submit',async t=>{
  let confirm,expired=false;const ui=await page(t,{section:'revenue',authorize:()=>new Promise(resolve=>{confirm=resolve;}),respond:path=>expired&&path==='/api/admin/accounts'?{status:401,body:{error:'Sign in again.'}}:undefined});const promise=ui.get('admin-fee-forms').querySelector('form').onsubmit({preventDefault(){}});await flush();expired=true;await ui.app.selectSection('users');assert.equal(ui.get('admin-main').hidden,true);assert.equal(ui.get('admin-user-list').children.length,0);confirm({password:'test-password',code:'123456'});await promise;assert.equal(ui.calls.some(call=>call.options.method==='POST'),false);
});

test('admin keeps wallet-connected and manually created accounts separate and searches usernames within each section',async t=>{
 const walletUser={id:'c'.repeat(32),username:'sunrise-otter-1234abcd',authType:'wallet',role:'user',mainWallet:WALLET,cashbackBps:0};
 const ui=await page(t,{section:'users',respond:path=>path==='/api/admin/accounts'?{accounts:[account,walletUser]}:undefined});
 assert.match(ui.get('admin-user-list').textContent,/owner/);assert(!ui.get('admin-user-list').textContent.includes(walletUser.username));
 ui.get('admin-users-wallet').click();assert.match(ui.get('admin-user-list').textContent,/sunrise-otter/);assert(!ui.get('admin-user-list').textContent.includes('owner'));assert.equal(ui.get('admin-users-wallet').getAttribute('aria-pressed'),'true');
 ui.get('admin-user-search').value='no-match';ui.get('admin-user-search').dispatchEvent(new ui.document.defaultView.Event('input'));assert.match(ui.get('admin-user-list').textContent,/No users/);
});

test('automatic revenue refresh preserves unsaved admin forms and stops when access is revoked',async t=>{
  let expired=false;
  const ui=await page(t,{hash:'#revenue/report',respond:path=>path==='/api/admin/revenue'?expired?{status:401,body:{error:'Sign in again.'}}:{at:Date.now(),products:[],totals:[]}:undefined});
  const input=ui.get('admin-fee-forms').querySelector('input');input.value='Unsaved collection wallet';
  const revenuePoll=ui.poll;await revenuePoll();
  assert.equal(ui.get('admin-fee-forms').querySelector('input'),input);assert.equal(input.value,'Unsaved collection wallet');
  expired=true;await revenuePoll();assert.equal(ui.get('admin-main').hidden,true);assert.equal(ui.get('admin-revenue').hidden,true);
  const calls=ui.calls.length;await revenuePoll();assert.equal(ui.calls.length,calls);
});

test('account overlay updates rotate admin CSRF without losing edits and revoke stale account access',async t=>{
  const ui=await page(t,{section:'revenue'}),input=ui.get('admin-fee-forms').querySelector('input');input.value='Unsaved fee wallet';
  ui.document.dispatchEvent(new ui.document.defaultView.CustomEvent('curve-account-updated',{detail:{account:{...account,username:'renamed_owner'},token:'rotated-csrf'}}));
  assert.equal(ui.get('admin-fee-forms').querySelector('input'),input);assert.equal(input.value,'Unsaved fee wallet');
  await ui.get('admin-users-refresh').onclick();
  assert.equal(ui.calls.filter(call=>call.path==='/api/admin/accounts').at(-1).options.headers['x-control-token'],'rotated-csrf');
  ui.document.dispatchEvent(new ui.document.defaultView.CustomEvent('curve-account-updated',{detail:{account:{...account,id:USER,role:'user'},token:'other-account-csrf'}}));
  assert.equal(ui.get('admin-main').hidden,true);assert.equal(ui.get('admin-user-list').children.length,0);
  const count=ui.calls.length;await ui.app.refresh();assert.equal(ui.calls.length,count);
});


test('launchpad-only administration hides inactive controls and does not request toolkit data',async t=>{
  for(const features of [undefined,{toolkit:false,telegram:false}]){
    const ui=await page(t,{session:{authenticated:true,token:'csrf-admin',account,monitorAllowed:true,features}});
    assert.equal(ui.get('admin-main').hidden,false);assert.equal(ui.get('admin-platform').hidden,true);assert.equal(ui.get('admin-sessions').hidden,true);
    assert.equal(ui.get('admin-fee-forms').children.length,0);assert.equal(ui.get('admin-user-list').querySelectorAll('input,button').length,0);
    assert.equal(ui.get('admin-users-title').textContent,'Account management');assert.equal(ui.get('admin-users-nav').textContent,'Users');assert.equal(ui.launchLoads(),0);
    await ui.app.selectSection('users');assert(ui.get('admin-moderation').querySelector('form'));assert.match(ui.get('admin-user-list').textContent,/owner/);
    const count=ui.calls.length;await ui.app.loadSessions();await ui.app.loadDetail();await ui.get('admin-husher-reveal').onclick();assert.equal(ui.calls.length,count);
    assert(!ui.calls.some(call=>/\/api\/(?:robinhood|admin\/(?:sessions?|fees|cashback)|account\/connections)/.test(call.path)));
    const visible=ui.document.body.cloneNode(true);for(const node of visible.querySelectorAll('[hidden]'))node.remove();
    assert(!/toolkit|cashback|Robinhood|Husher|Full diagnostics/.test(visible.textContent));
    for(const section of ['revenue','tokens','settings'])await ui.app.selectSection(section);assert.equal(ui.launchLoads(),1);
    assert(!ui.calls.some(call=>/\/api\/(?:robinhood|admin\/(?:sessions?|fees|cashback)|account\/connections)/.test(call.path)));
    assert.equal(ui.get('admin-signin').getAttribute('href'),'/?account=overview');
  }
});


test('tab keyboard controls, browser history, and legacy links select one accessible panel',async t=>{
  const ui=await page(t,{hash:'#admin-treasury'});
  assert.equal(ui.get('admin-revenue-nav').getAttribute('aria-selected'),'true');
  assert.equal(ui.get('admin-panel-revenue').hidden,false);
  assert.equal(ui.calls.some(call=>call.path==='/api/admin/volume'),false);
  let focused='',prevented=0;
  for(const key of ['overview','revenue','tokens','pairs','users','pump-test','settings'])ui.get('admin-'+key+'-nav').focus=()=>{focused=key;};
  await ui.get('admin-revenue-nav').onkeydown({key:'ArrowRight',preventDefault(){prevented++;}});
  assert.equal(focused,'tokens');assert.equal(ui.location.hash,'#tokens');assert.equal(ui.launchLoads(),1);
  await ui.get('admin-tokens-nav').onkeydown({key:'End',preventDefault(){prevented++;}});
  assert.equal(focused,'settings');assert.equal(ui.get('admin-settings-nav').getAttribute('tabindex'),'0');
  await ui.get('admin-settings-nav').onkeydown({key:'Home',preventDefault(){prevented++;}});
  assert.equal(focused,'overview');assert.equal(prevented,3);
  ui.location.hash='#admin-moderation';ui.events.get('hashchange')();await flush();await flush();
  assert.equal(ui.get('admin-users-nav').getAttribute('aria-selected'),'true');
  assert.equal(ui.get('admin-panel-users').hidden,false);
  ui.location.hash='#revenue';ui.events.get('popstate')();await flush();await flush();
  assert.equal(ui.get('admin-revenue-nav').getAttribute('aria-selected'),'true');
  assert.equal([...ui.document.querySelectorAll('[role=tabpanel]')].filter(node=>!node.hidden).length,1);
  assert.equal([...ui.document.querySelectorAll('[role=tab]')].filter(node=>node.getAttribute('tabindex')==='0').length,1);
  const count=ui.history.length;
  ui.get('admin-tokens-nav').onclick({ctrlKey:true,preventDefault(){throw Error('Modified link clicks retain native behavior.');}});
  assert.equal(ui.history.length,count);
});

test('inactive sections stop polling and resume without replacing unsaved financial forms',async t=>{
  const ui=await page(t,{section:'revenue'});
  const wallet=ui.get('admin-fee-forms').querySelector('input'),protocol=ui.get('admin-protocol').querySelector('input'),reason=ui.get('admin-treasury-reason');
  wallet.value='Draft toolkit wallet';protocol.value='Draft launchpad wallet';reason.value='Draft treasury reason';
  const financialPaths=()=>ui.calls.filter(call=>/\/api\/admin\/(?:revenue|protocol)/.test(call.path));
  const reportsBefore=financialPaths().length;
  await ui.app.selectSection('tokens');
  ui.document.hidden=true;ui.document.dispatchEvent(new ui.document.defaultView.Event('visibilitychange'));
  ui.document.hidden=false;ui.document.dispatchEvent(new ui.document.defaultView.Event('visibilitychange'));
  await ui.poll();assert.equal(financialPaths().length,reportsBefore);
  // A Tokens refresh reloads the visible page (Token management, its own loader). The owner-only pages (Gotchi,
  // AI Agents, Pump.fun, Vanity) make no requests for an administrator without the owner capability.
  const callsBeforeRefresh=ui.calls.length;await ui.app.refresh();assert.equal(ui.launchLoads(),2);assert.deepEqual(ui.calls.slice(callsBeforeRefresh).map(call=>call.path),[]);
  await ui.app.selectSection('revenue',{sub:'report'});assert(financialPaths().length>reportsBefore);
  assert.equal(ui.get('admin-fee-forms').querySelector('input')===wallet,true);assert.equal(wallet.value,'Draft toolkit wallet');
  assert.equal(ui.get('admin-protocol').querySelector('input')===protocol,true);assert.equal(protocol.value,'Draft launchpad wallet');assert.equal(reason.value,'Draft treasury reason');
  assert.equal(ui.calls.filter(call=>call.path==='/api/admin/protocol-fees').length,1);
  const volumeCalls=ui.calls.filter(call=>call.path==='/api/admin/volume').length;
  await ui.poll();assert.equal(ui.calls.filter(call=>call.path==='/api/admin/volume').length,volumeCalls);
});

test('leaving Settings clears a revealed private connection key',async t=>{
  const ui=await page(t,{section:'settings'});await ui.get('admin-husher-reveal').onclick();
  assert.equal(ui.get('admin-husher-key').value,'private-test-key');await ui.app.selectSection('overview');
  assert.equal(ui.get('admin-husher-key').value,'');assert.equal(ui.get('admin-husher-key').type,'password');
});

test('logout clears all loaded panels and late private responses cannot restore them',async t=>{
  let resolveUsers,pending=false;
  const ui=await page(t,{section:'revenue',respond:path=>pending&&path==='/api/admin/accounts'?new Promise(resolve=>{resolveUsers=resolve;}):undefined});
  pending=true;const loading=ui.app.selectSection('users');await flush();
  ui.document.dispatchEvent(new ui.document.defaultView.CustomEvent('curve-account-updated',{detail:{account:null,token:''}}));
  assert.equal(ui.get('admin-main').hidden,true);assert.equal(ui.get('admin-security-open').hidden,true);
  assert.equal(ui.get('admin-fee-forms').children.length,0);assert.equal(ui.get('admin-revenue').hidden,true);
  resolveUsers({accounts:[{...account,username:'Stale private owner'}]});await loading;await ui.poll();
  assert.equal(ui.get('admin-user-list').children.length,0);assert.doesNotMatch(ui.document.body.textContent,/Stale private owner/);
  const count=ui.calls.length;await ui.app.selectSection('settings');await ui.app.refresh();assert.equal(ui.calls.length,count);
});

test('an earlier failed request cannot revoke a newly authenticated administrator session',async t=>{
  let resolveOld,pending=false;
  const ui=await page(t,{respond:path=>pending&&path==='/api/admin/accounts'?new Promise(resolve=>{resolveOld=resolve;}):undefined});
  pending=true;const oldLoad=ui.app.selectSection('users');await flush();
  ui.document.dispatchEvent(new ui.document.defaultView.CustomEvent('curve-account-updated',{detail:{account:null}}));
  pending=false;await ui.app.initialize();assert.equal(ui.get('admin-main').hidden,false);
  resolveOld({status:401,body:{error:'Old session expired.'}});await oldLoad;
  assert.equal(ui.get('admin-main').hidden,false);assert.match(ui.get('admin-user-list').textContent,/owner/);
  assert.doesNotMatch(ui.get('admin-message').textContent,/Old session expired/);
});

test('fast tab changes preserve in-flight requests and restart only the active polling panel',async t=>{
  let resolveRevenue,pending=true;
  const ui=await page(t,{respond:path=>pending&&path==='/api/admin/revenue'?new Promise(resolve=>{resolveRevenue=resolve;}):undefined});
  const first=ui.app.selectSection('revenue',{sub:'report'});await flush();
  await ui.app.selectSection('tokens');await ui.app.selectSection('revenue',{sub:'report'});
  pending=false;resolveRevenue({at:Date.now(),products:[],totals:[]});await first;
  const before=ui.calls.filter(call=>call.path==='/api/admin/revenue').length;await ui.poll();
  assert.equal(ui.calls.filter(call=>call.path==='/api/admin/revenue').length,before+1);
  assert.equal(ui.get('admin-panel-revenue').hidden,false);
});

test('Pairs loads only in its own tab, keeps read-only checks separate and clears drafts on logout',async t=>{
 const ui=await page(t,{respond:path=>path==='/api/admin/pairs'?{revision:0,assets:[]}:undefined});assert.equal(ui.calls.some(c=>c.path==='/api/admin/pairs'),false);await ui.app.selectSection('pairs');assert.equal(ui.get('admin-pairs').parentElement.id,'admin-panel-pairs');assert.equal(ui.calls.filter(c=>c.path==='/api/admin/pairs').length,1);assert.equal(ui.calls.some(c=>c.options.method==='POST'),false);ui.get('admin-pairs-name').value='Private draft';await ui.app.selectSection('tokens');assert.equal(ui.get('admin-pairs-name').value,'Private draft');ui.document.dispatchEvent(new ui.document.defaultView.CustomEvent('curve-account-updated',{detail:{account:null}}));assert.equal(ui.get('admin-pairs-name').value,'');assert.equal(ui.get('admin-pairs').hidden,true);
});
test('reward diagnostics never auto-fetch and leaving Revenue aborts an explicit download',async t=>{
 let finish;const ui=await page(t,{section:'revenue',respond:path=>path==='/api/admin/reward-diagnostics'?new Promise(resolve=>{finish=resolve;}):undefined});assert.equal(ui.get('admin-reward-diagnostics').parentElement.id,'admin-panel-revenue');assert.equal(ui.calls.some(c=>c.path==='/api/admin/reward-diagnostics'),false);const download=ui.get('admin-reward-diagnostics-download').onclick();await flush();const request=ui.calls.find(c=>c.path==='/api/admin/reward-diagnostics');assert(request);await ui.app.selectSection('tokens');assert.equal(request.options.signal.aborted,true);finish({version:1,generatedAt:Date.now(),launches:[]});await download;assert.equal(ui.get('admin-reward-diagnostics').querySelector('[role=status]').textContent,'');
});

test('burn-history jump opens Revenue and records a burn through normal fresh MFA and CSRF controls',async t=>{
  const signature='22TcPEZoA5t5HYWhmRWYZN1CxwjUMmPWoe1qh2ZZcNwg6H5h28dxUE7ieCApuPKBAtHTujgkNZiLmmm66Bc76EY5';
  const ui=await page(t,{hash:'#admin-burn-history',respond:(path,options)=>path==='/api/admin/burn-history'?{history:options.method==='POST'?[{kind:'burn',signature,inputAmount:'50000000000000',outputAmount:'0',confirmedAt:1790647124000,curveDecimals:6,source:'admin'}]:[],added:options.method==='POST'?1:0}:undefined});
  assert.equal(ui.get('admin-revenue-nav').getAttribute('aria-selected'),'true');assert.equal(ui.get('admin-burn-history').hidden,false);
  assert.equal(ui.document.querySelector('a[href="#revenue/burns"]').textContent,'Buybacks & burns');
  ui.get('admin-burn-history-burn').value='https://solscan.io/tx/'+signature;
  await ui.get('admin-burn-history-form').onsubmit({preventDefault(){}});
  assert.equal(ui.authorizations[0][1].requireCode,true);
  const post=ui.calls.find(c=>c.path==='/api/admin/burn-history'&&c.options.method==='POST');
  assert.equal(post.options.headers['x-control-token'],'csrf-admin');assert.deepEqual(JSON.parse(post.options.body),{burnLink:'https://solscan.io/tx/'+signature,password:'test-password',code:'123456'});
  assert.match(ui.get('admin-burn-history-status').textContent,/Added to analytics/);assert.match(ui.get('admin-burn-history-records').textContent,/50,000,000 LAUNCHPAD/);
  ui.document.dispatchEvent(new ui.document.defaultView.CustomEvent('curve-account-updated',{detail:{account:null}}));
  assert.equal(ui.get('admin-burn-history').hidden,true);assert.equal(ui.get('admin-burn-history-records').children.length,0);
});

// ---- v71.25 regression tests ----
const gotchiSnapshot=()=>({version:1,enabled:true,at:Date.now(),gotchis:[],controls:[],policy:{goalUsd:1000,topHolders:10,gasReserveLamports:'20000000',dailyNetworkLimitLamports:'100000000'}});
const ownerReads=calls=>calls.filter(call=>/^\/api\/admin\/(?:gotchi|agents|pump-classic|vanity)(?:[/?]|$)/.test(call.path));
test('administrators without the owner capability keep Tokens: owner-only pages show a notice and never call their APIs',async t=>{
  const ui=await page(t,{hash:'#tokens/gotchi'});
  assert.equal(ui.get('admin-main').hidden,false);assert.equal(ui.get('admin-gate').hidden,true);assert.equal(ui.get('admin-panel-tokens').hidden,false);
  assert.equal(ui.get('admin-tokens-nav').getAttribute('aria-selected'),'true');assert.equal(ui.get('admin-panel-tokens').dataset.adminView,'gotchi');
  const notice=ui.get('admin-gotchi-owner-only');assert.equal(notice.hidden,false);assert.match(notice.textContent,/Owner-only: available to the platform owner\./);assert.match(notice.textContent,/Gotchi races/);
  assert.equal(ui.get('admin-gotchi').hidden,true);
  for(const sub of ['agents','pump-fun','vanity']){await ui.app.selectSection('tokens',{sub});assert.equal(ui.get(({agents:'admin-agents','pump-fun':'admin-pump-classic',vanity:'admin-vanity'})[sub]+'-owner-only').hidden,false);}
  await ui.app.refresh();assert.deepEqual(ownerReads(ui.calls),[]);
  // "Check access again" (and any session re-check) on #tokens keeps the panel open instead of looping to the gate.
  await ui.app.initialize();assert.equal(ui.get('admin-gate').hidden,true);assert.equal(ui.get('admin-panel-tokens').hidden,false);assert.deepEqual(ownerReads(ui.calls),[]);
});
test('an owner-only refusal hides the owner features and keeps the rest of administration open',async t=>{
  for(const body of [{error:'This test mode is available only to the configured platform owner.',code:'OWNER_ONLY'},{error:'This test mode is available only to the configured platform owner.'}]){
    let denied=false;
    const ui=await page(t,{pumpTestAllowed:true,hash:'#tokens/gotchi',respond:path=>path==='/api/admin/gotchi'?denied?{status:403,body}:gotchiSnapshot():undefined});
    assert.equal(ui.get('admin-gotchi').hidden,false);assert.equal(ui.get('admin-gotchi-owner-only').hidden,true);assert.equal(ui.get('admin-pump-test-nav').hidden,false);
    denied=true;await ui.app.refresh();await flush();
    assert.equal(ui.get('admin-main').hidden,false);assert.equal(ui.get('admin-gate').hidden,true);assert.equal(ui.get('admin-pump-test-nav').hidden,true);
    assert.equal(ui.get('admin-gotchi').hidden,true);assert.equal(ui.get('admin-gotchi-owner-only').hidden,false);
    const reads=ownerReads(ui.calls).length;await ui.app.selectSection('tokens',{sub:'agents'});assert.equal(ownerReads(ui.calls).length,reads);
    await ui.app.selectSection('users');assert.equal(ui.get('admin-panel-users').hidden,false);assert.equal(ui.get('admin-gate').hidden,true);
  }
});
test('only an expired session or a refused general admin read shows the gate, whose link returns to the same admin page',async t=>{
  let mode='';
  const ui=await page(t,{hash:'#users',respond:path=>mode==='post'&&path==='/api/admin/moderation/user'||mode==='read'&&path==='/api/admin/accounts'?{status:403,body:{error:'Administrator access required.'}}:mode==='expired'&&path==='/api/admin/accounts'?{status:401,body:{error:'Sign in again.'}}:undefined});
  const form=ui.get('admin-moderation').querySelector('form'),[target,reason]=form.querySelectorAll('input');target.value='someone';reason.value='Repeated spam reports';
  mode='post';await form.onsubmit({preventDefault(){}});
  assert.equal(ui.get('admin-main').hidden,false,'a refused action reports its error without closing the panel');assert.equal(ui.get('admin-message').textContent,'Administrator access required.');
  mode='read';await ui.get('admin-users-refresh').onclick();
  assert.equal(ui.get('admin-gate').hidden,false);assert.equal(ui.get('admin-signin').textContent,'Open your account');assert.equal(ui.get('admin-signin').getAttribute('href'),'/admin?account=overview#users');
  mode='';await ui.app.initialize();assert.equal(ui.get('admin-gate').hidden,true);
  mode='expired';await ui.get('admin-users-refresh').onclick();
  assert.equal(ui.get('admin-gate').hidden,false);assert.equal(ui.get('admin-signin').textContent,'Sign in to Launchpad');assert.equal(ui.get('admin-signin').getAttribute('href'),'/admin?signin=1#users');
});
test('HTML error pages show a readable message, and an HTML 401 still closes the panel',async t=>{
  let mode='';
  const ui=await page(t,{hash:'#users',respond:path=>mode&&path==='/api/admin/accounts'?{status:mode==='502'?502:401,html:'<html><head><title>502 Bad Gateway</title></head></html>'}:undefined});
  mode='502';await ui.get('admin-users-refresh').onclick();
  assert.equal(ui.get('admin-main').hidden,false);assert.equal(ui.get('admin-message').textContent,'The server is unavailable. Try again.');assert.doesNotMatch(ui.document.body.textContent,/Unexpected token|valid JSON/);
  mode='401';await ui.get('admin-users-refresh').onclick();
  assert.equal(ui.get('admin-gate').hidden,false);assert.match(ui.get('admin-gate-message').textContent,/session expired/);
});
test('a rate-limited admin action says how long to wait, from the server retry time',async t=>{
  const ui=await page(t,{section:'users',respond:path=>path==='/api/admin/cashback'?{status:429,body:{error:'Too many attempts. Try again shortly.',retryAfterMs:600000}}:undefined});
  const form=ui.get('admin-user-list').querySelectorAll('form')[1];form.querySelector('input').value='12.34';await form.onsubmit({preventDefault(){}});
  assert.equal(ui.get('admin-message').textContent,'Too many attempts. Try again in 10 minutes.');assert.equal(ui.get('admin-main').hidden,false);
});
test('an invalid toolkit fee wallet is rejected before the identity prompt',async t=>{
  const ui=await page(t,{section:'revenue'}),[solana,robinhood]=ui.get('admin-fee-forms').querySelectorAll('form');
  solana.querySelector('input').value='not-a-wallet';await solana.onsubmit({preventDefault(){}});
  robinhood.querySelector('input').value='0x1234';await robinhood.onsubmit({preventDefault(){}});
  assert.equal(ui.authorizations.length,0);assert.equal(ui.calls.some(call=>call.options.method==='POST'),false);assert.match(ui.get('admin-message').textContent,/valid Robinhood Chain wallet/);
});
test('panel messages stay out of Account security and clear when the section changes',async t=>{
  const ui=await page(t,{section:'users',respond:path=>path==='/api/admin/cashback'?{status:400,body:{error:'Cashback could not be saved.'}}:undefined});
  const form=ui.get('admin-user-list').querySelectorAll('form')[1];form.querySelector('input').value='12.34';await form.onsubmit({preventDefault(){}});
  assert.equal(ui.get('admin-message').textContent,'Cashback could not be saved.');assert.equal(ui.get('admin-security-message').textContent,'');
  await ui.app.selectSection('settings');assert.equal(ui.get('admin-message').hidden,true);assert.equal(ui.get('admin-message').textContent,'');
});
test('hashes that name no admin page are ignored and unavailable pages are rewritten to the page shown',async t=>{
  const ui=await page(t,{hash:'#users/activity',session:{authenticated:true,token:'csrf-admin',account,monitorAllowed:true,features:{toolkit:false}}});
  assert.equal(ui.get('admin-panel-users').hidden,false);assert.equal(ui.get('admin-panel-users').dataset.adminView,'accounts');assert.equal(ui.location.hash,'#users');
  await ui.app.selectSection('tokens');const calls=ui.calls.length;
  ui.location.hash='#admin-workspace';ui.events.get('hashchange')();await flush();
  assert.equal(ui.get('admin-panel-tokens').hidden,false);assert.equal(ui.get('admin-panel-overview').hidden,true);assert.equal(ui.calls.length,calls);
});
test('only the visible page loads and polls, and returning to a page reuses fresh data',async t=>{
  const ui=await page(t,{section:'revenue'}),count=path=>ui.calls.filter(call=>call.path===path).length;
  for(const path of ['/api/admin/protocol-treasury','/api/admin/protocol-gas-funding','/api/admin/revenue','/api/admin/revenue-audit','/api/admin/burn-history'])assert.equal(count(path),0,path+' waits for its page');
  await ui.app.selectSection('revenue',{sub:'treasury'});assert.equal(count('/api/admin/protocol-treasury'),1);
  await ui.app.selectSection('revenue',{sub:'gas'});assert.equal(count('/api/admin/protocol-gas-funding'),1);
  await ui.poll();assert.equal(count('/api/admin/protocol-treasury'),1,'a hidden page does not poll');assert.equal(count('/api/admin/protocol-gas-funding'),2);
  await ui.app.selectSection('revenue',{sub:'treasury'});assert.equal(count('/api/admin/protocol-treasury'),1,'fresh treasury data is reused');
  await ui.poll();assert.equal(count('/api/admin/protocol-treasury'),2,'and its polling resumes');
  await ui.app.selectSection('overview');await ui.app.selectSection('overview',{sub:'health'});assert.equal(count('/api/admin/health'),1);
});
test('Refresh section on Tokens reloads the page of coins being viewed and marks hidden pages for a fresh read',async t=>{
  let loads=0,reloads=0;
  const ui=await page(t,{pumpTestAllowed:true,hash:'#tokens',launchFactory:doc=>({element:doc.createElement('section'),load:async()=>{loads++;},reload:async()=>{reloads++;},clear(){}}),respond:path=>path==='/api/admin/gotchi'?gotchiSnapshot():undefined});
  assert.equal(loads,1);assert.deepEqual(ownerReads(ui.calls),[]);
  await ui.app.selectSection('tokens',{sub:'gotchi'});assert.equal(ownerReads(ui.calls).length,1);
  await ui.app.selectSection('tokens',{sub:'launches'});await ui.app.refresh();assert.equal(reloads,1);assert.equal(loads,1);
  await ui.app.selectSection('tokens',{sub:'gotchi'});assert.equal(ownerReads(ui.calls).length,2,'a page passed over by Refresh section reads again when opened');
});

// ---- v71.26: easier to get around ----
const attention=[{code:'failed-launches',count:7,label:'Failed or unfinished launches',detail:'Launches that stopped before finishing.',hash:'#tokens/cleanup',tone:'warn'},{code:'payouts-blocked',count:1,label:'Blocked payouts',detail:'Holder payouts that stopped.',hash:'#tokens/launches?filter=attention',tone:'bad'},{code:'bad',count:2,label:'Scripted',detail:'',hash:'javascript:alert(1)'},{code:'none',count:0,label:'Nothing',detail:'',hash:'#overview'}];
test('the overview inbox lists what needs an operator as plain links to the right page, from the overview response only',async t=>{
  const ui=await page(t,{respond:path=>path==='/api/admin/overview'?{counts:{accounts:2,launches:4,holderLaunches:2,buybackLaunches:1},attention}:undefined});
  assert.deepEqual(ui.calls.map(call=>call.path),['/api/session','/api/admin/overview','/api/admin/volume'],'no extra request for the inbox');
  const items=[...ui.get('admin-inbox-list').querySelectorAll('.admin-inbox-item')];
  assert.equal(ui.get('admin-inbox').hidden,false);assert.equal(items.length,3,'items with a count only');
  assert.deepEqual(items.map(item=>item.querySelector('a').getAttribute('href')),['#tokens/cleanup','#tokens/launches?filter=attention','#overview'],'only admin hashes are linked');
  assert.match(items[0].textContent,/7.*Failed or unfinished launches.*Open/);assert.equal(items[1].classList.contains('is-bad'),true);
  assert.equal(ui.get('admin-overview-nav').dataset.adminCount,'3','the Overview tab shows how many items wait');
  assert.match(ui.get('admin-inbox-summary').textContent,/10 things need an operator/);
  ui.document.dispatchEvent(new ui.document.defaultView.CustomEvent('curve-account-updated',{detail:{account:null}}));
  assert.equal(ui.get('admin-inbox').hidden,true);assert.equal(ui.get('admin-inbox-list').children.length,0);assert.equal(ui.get('admin-overview-nav').hasAttribute('data-admin-count'),false);
});
test('Cleanup is a Tokens page that loads only when opened, keeps the page query in the hash and shows its summary in the top bar',async t=>{
  const cleanup={at:Date.now(),version:1,counts:{total:3,failed:2,unfinished:1,refund:0,abandoned:0,archived:0,byVenue:{},moneyRows:1,bulkEligible:1,pumpEligible:0},kinds:{},venues:{},rows:[{key:'raydium:'+USER+':'+'1'.repeat(32),route:'raydium',venue:'Raydium',accountId:USER,username:'maker',id:'1'.repeat(32),mint:WALLET,name:'Broken Coin',symbol:'BRK',state:'failed',stateLabel:'Failed',kind:'failed',reason:'The launch transaction expired before it executed.',createdAt:Date.now()-86400000,updatedAt:Date.now()-3600000,money:'0.1 SOL reserved',moneyZero:false,pending:false,recovery:false,archived:false,hidden:false,listArchived:false,archiveReason:'',bulkEligible:false,bulkCode:'',actions:['archive']}],total:3,offset:0,limit:25,nextOffset:null,includeArchived:false,search:'',venue:'',kind:''};
  const ui=await page(t,{hash:'#tokens',respond:path=>path.startsWith('/api/admin/cleanup')?cleanup:undefined});
  assert.equal(ui.calls.some(call=>call.path.startsWith('/api/admin/cleanup')),false,'Token management is shown first; Cleanup waits');
  assert.equal(ui.document.querySelector('a[href="#tokens/cleanup"]').textContent,'Cleanup');
  await ui.app.selectSection('tokens',{sub:'cleanup'});await flush();
  assert.equal(ui.get('admin-panel-tokens').dataset.adminView,'cleanup');assert.equal(ui.location.hash,'#tokens/cleanup');
  assert.equal(ui.calls.filter(call=>call.path.startsWith('/api/admin/cleanup')).length,1);assert.equal(ui.calls.at(-1).path,'/api/admin/cleanup?offset=0&limit=25');
  assert.equal(ui.get('admin-cleanup').hidden,false);assert.match(ui.get('admin-cleanup').textContent,/\$BRK · Broken Coin/);
  assert.equal(ui.get('admin-topbar-title').textContent,'Cleanup');assert.equal(ui.get('admin-topbar-summary').hidden,false);assert.match(ui.get('admin-topbar-summary').textContent,/3 unfinished/);
  const proxy=ui.get('admin-topbar-tools').querySelector('button');assert.equal(proxy.textContent,'Archive all finished failures','the page action is mirrored in the sticky top bar');
  // A hash with the page's own query opens the page and leaves the query to it.
  ui.location.hash='#tokens/cleanup?cleanup.kind=refund';ui.events.get('hashchange')();await flush();await flush();
  assert.equal(ui.get('admin-panel-tokens').dataset.adminView,'cleanup');assert.equal(ui.location.hash,'#tokens/cleanup?cleanup.kind=refund','the page query survives normalisation');
  await ui.app.selectSection('tokens',{sub:'launches'});assert.equal(ui.get('admin-cleanup').closest('.admin-sub-current'),null);assert.equal(ui.get('admin-topbar-tools').hidden,true);
});
test('the sidebar lists every section’s pages in groups; the open section is expanded and others open on their chevron',async t=>{
  const ui=await page(t,{hash:'#revenue/treasury'});
  const groups=Object.fromEntries([...ui.document.querySelectorAll('[data-admin-group]')].map(group=>[group.dataset.adminGroup,group]));
  assert.equal(groups.revenue.dataset.expanded,'true');assert.equal(groups.tokens.dataset.expanded,'false');assert.equal(groups['pump-test'].hidden,true,'owner-only sections stay out of the sidebar');
  const revenuePages=[...ui.document.querySelector('[data-admin-group-pages=revenue]').querySelectorAll('a')];
  assert.deepEqual(revenuePages.map(link=>link.getAttribute('href')).slice(0,3),['#revenue/fees','#revenue/treasury','#revenue/burns']);
  assert.equal(revenuePages.find(link=>link.getAttribute('aria-current')==='page').textContent,'Treasury');
  assert.equal(ui.document.querySelector('[data-admin-group-pages=tokens]').hidden,true);
  ui.document.querySelector('[data-admin-group-toggle=tokens]').onclick();
  assert.equal(groups.tokens.dataset.expanded,'true');assert.equal(ui.document.querySelector('[data-admin-group-pages=tokens]').hidden,false);
  assert.deepEqual([...ui.document.querySelector('[data-admin-group-pages=tokens]').querySelectorAll('a')].map(link=>link.textContent),['Token management','Cleanup','Gotchi Mode','AI Agents','Pump.fun','Robinhood Chain','Vanity addresses'],'every Tokens page, owner-only ones included (they show their notice)');
  await ui.document.querySelector('[data-admin-group-pages=tokens] a[href="#tokens/cleanup"]').onclick({preventDefault(){}});
  assert.equal(ui.get('admin-tokens-nav').getAttribute('aria-selected'),'true');assert.equal(ui.get('admin-panel-tokens').dataset.adminView,'cleanup');assert.equal(groups.revenue.dataset.expanded,'false');
  assert.equal(ui.document.querySelector('[data-admin-group-toggle=tokens]').disabled,true,'the open section cannot be collapsed');
});
test('the palette finds coins and users on the server for queries of two characters or more and jumps to them',async t=>{
  const coin={accountId:USER,id:'2'.repeat(32),route:undefined,name:'Orbit Garden',symbol:'ORBIT',mint:WALLET,username:'maker',listArchived:false};
  let found='';const ui=await page(t,{launchFactory:doc=>({element:doc.createElement('section'),load:async()=>{},clear(){},find:async(query,{row})=>{found=query+':'+row.id;}}),respond:path=>path.startsWith('/api/admin/launches?')?{launches:[coin],total:1,offset:0,limit:6,nextOffset:null}:path.startsWith('/api/admin/accounts?')?{accounts:[{id:USER,username:'orbit_fan',authType:'wallet',role:'user'}],total:1}:undefined});
  ui.get('admin-command-open').onclick();assert.equal(ui.get('admin-command').open,true);
  ui.get('admin-command-input').value='o';ui.get('admin-command-input').oninput();await new Promise(resolve=>setTimeout(resolve,260));
  assert.equal(ui.calls.some(call=>call.path.startsWith('/api/admin/launches?')),false,'one character searches nothing');
  ui.get('admin-command-input').value='orb';ui.get('admin-command-input').oninput();await new Promise(resolve=>setTimeout(resolve,300));await flush();
  const search=ui.calls.find(call=>call.path.startsWith('/api/admin/launches?'));assert.ok(search);assert.match(search.path,/search=orb&offset=0&limit=6&view=all/);
  assert.ok(ui.calls.some(call=>call.path==='/api/admin/accounts?search=orb&offset=0&limit=6'));
  const items=[...ui.get('admin-command-list').querySelectorAll('.admin-command-item')];
  const coinItem=items.find(item=>item.classList.contains('is-coin')),userItem=items.find(item=>item.classList.contains('is-user'));
  assert.match(coinItem.textContent,/\$ORBIT · Orbit Garden.*Coin · Raydium · maker/);assert.match(userItem.textContent,/orbit_fan.*User · wallet/);
  await coinItem.onclick();await flush();await flush();
  assert.equal(ui.get('admin-command').open,false);assert.equal(ui.get('admin-tokens-nav').getAttribute('aria-selected'),'true');assert.equal(ui.get('admin-panel-tokens').dataset.adminView,'launches');assert.equal(found,WALLET+':'+'2'.repeat(32));
  ui.get('admin-command-open').onclick();ui.get('admin-command-input').value='orb';ui.get('admin-command-input').oninput();await new Promise(resolve=>setTimeout(resolve,300));await flush();
  await [...ui.get('admin-command-list').querySelectorAll('.admin-command-item')].find(item=>item.classList.contains('is-user')).onclick();await flush();await flush();
  assert.equal(ui.get('admin-users-nav').getAttribute('aria-selected'),'true');assert.equal(ui.get('admin-user-search').value,'orbit_fan');assert.equal(ui.get('admin-users-wallet').getAttribute('aria-pressed'),'true');
});
