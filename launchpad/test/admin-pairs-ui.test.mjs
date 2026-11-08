import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createAdminPairs, optimizePairLogo, validatePairLogoFile, MAX_PAIR_LOGO_BYTES } from '../public/admin-pairs-ui.mjs';
const ACCOUNT={id:'owner',role:'admin',mfaEnabled:true},MINT='11111111111111111111111111111111',SECOND='So11111111111111111111111111111111111111112',LOGO='data:image/webp;base64,AQIDBA==';
const ASSET={mint:MINT,name:'Test Coin',symbol:'TEST',category:'custom',logoPath:'/token-images/'+'a'.repeat(64)+'.webp',supported:true};
function page({account=ACCOUNT,respond,authorize=async()=>({password:'secret',code:'123456'}),optimizeLogo=async()=>LOGO}={}){
 const {document}=parseHTML('<html><head></head><body></body></html>');Object.defineProperty(document,'hidden',{value:false,writable:true});let active=true,now=1700000000000;const calls=[],authorizations=[],messages=[];
 const ui=createAdminPairs({document,api:async(path,body,options)=>{calls.push({path,body,options});const value=await respond?.(path,body,options);return value??(path.endsWith('/check')?{mint:body.mint,supported:true,supportReason:'Launch requirements verified.'}:path.endsWith('/save')?{revision:2,asset:{...ASSET,mint:body.mint}}:{revision:1,assets:[]});},security:{authorize:async(...args)=>{authorizations.push(args);return authorize(...args);}},message:(...args)=>messages.push(args),getAccount:()=>account,isActive:()=>active,clock:()=>now,optimizeLogo});document.body.append(ui.element);
 return{ui,document,calls,authorizations,messages,get:id=>document.getElementById('admin-pairs-'+id),account:value=>{account=value;},active:value=>{active=value;},advance:value=>{now+=value;}};
}
async function logo(p){Object.defineProperty(p.get('image'),'files',{configurable:true,value:[{type:'image/png',size:123}]});await p.get('image').onchange();}
async function ready(p){await p.ui.load();p.get('name').value='Test Coin';p.get('ticker').value='TEST';p.get('mint').value=MINT;p.get('mint').oninput();await p.get('check').onclick();await logo(p);}
const submit=p=>p.get('form').onsubmit({preventDefault(){}});

test('mint availability is checked before saving; save uses current revision and fresh MFA with raw image bytes',async()=>{
 const p=page();await ready(p);assert.equal(p.get('save').disabled,false);assert.match(p.get('support').textContent,/Available for pairing/);assert.equal(p.authorizations.length,0);assert.equal(p.calls.filter(c=>c.path.endsWith('/check')).length,1);
 await submit(p);assert.deepEqual(p.authorizations,[['Add TEST as a pair',{requireCode:true}]]);const call=p.calls.find(c=>c.path.endsWith('/save'));assert.deepEqual(call.body,{revision:1,name:'Test Coin',ticker:'TEST',mint:MINT,image:'AQIDBA==',password:'secret',code:'123456'});assert.equal(p.get('mint').value,'');assert.equal(p.get('preview').querySelector('img'),null);assert.match(p.get('status').textContent,/saved and available for pairing/);assert(!p.ui.element.textContent.includes('secret'));p.ui.destroy();
});
test('Coming Soon is saveable after a definitive check; unknown and duplicate status cannot save',async()=>{
 for(const supported of [false,null]){const p=page({respond:async(path,body)=>path.endsWith('/check')?{mint:body.mint,supported,supportReason:'Awaiting configuration'}:path.endsWith('/save')?{revision:2,asset:{...ASSET,supported:false}}:undefined});await ready(p);assert.match(p.get('support').textContent,supported===false?/Coming Soon/:/Unable to verify/);await submit(p);assert.equal(p.authorizations.length,supported===false?1:0);if(supported===false)assert.match(p.get('status').textContent,/Coming Soon/);p.ui.destroy();}
 const p=page({respond:async(path,body)=>path.endsWith('/check')?{mint:body.mint,supported:true,alreadyListed:true}:undefined});await ready(p);await submit(p);assert.equal(p.authorizations.length,0);assert.match(p.get('support').textContent,/Already listed/);p.ui.destroy();
});
test('editing a mint invalidates prior status and cannot adopt a late check from the previous mint',async()=>{
 let finish;const p=page({respond:path=>path.endsWith('/check')?new Promise(resolve=>{finish=resolve;}):undefined});await p.ui.load();p.get('mint').value=MINT;p.get('mint').oninput();const request=p.get('check').onclick();p.get('mint').value=SECOND;p.get('mint').oninput();finish({mint:MINT,supported:true});await request;assert(!p.get('support').textContent.includes('Available for pairing'));assert.equal(p.get('save').disabled,true);p.ui.destroy();
});
test('support responses with a mismatched mint fail closed and show a readable retry status',async()=>{
 const p=page({respond:path=>path.endsWith('/check')?{mint:SECOND,supported:true}:undefined});await ready(p);assert.match(p.get('support').textContent,/Unable to verify/);await submit(p);assert.equal(p.authorizations.length,0);p.ui.destroy();
});
test('stale check expires and invalid names or tickers never prompt for authorization',async()=>{
 const p=page();await ready(p);p.advance(300001);await submit(p);assert.equal(p.authorizations.length,0);assert.match(p.get('status').textContent,/five minutes/);await p.get('check').onclick();p.get('ticker').value='<script>';await submit(p);assert.equal(p.authorizations.length,0);p.get('ticker').value='TEST';p.get('name').value='<script>';await submit(p);assert.equal(p.authorizations.length,0);p.ui.destroy();
});
test('unverified accounts cannot read; changing admin clears draft and catalogue before refresh',async()=>{
 for(const account of [null,{...ACCOUNT,role:'user'},{...ACCOUNT,mfaEnabled:false}]){const p=page({account});await p.ui.load();assert.equal(p.calls.length,0);assert.equal(p.ui.element.hidden,true);p.ui.destroy();}
 const p=page();await ready(p);p.account({...ACCOUNT,id:'new'});await p.ui.load();assert.equal(p.get('mint').value,'');assert.equal(p.get('preview').querySelector('img'),null);p.ui.destroy();
});
test('late catalogue reads and image conversions cannot reappear after clearing or changing identity',async()=>{
 let finish;const p=page({respond:()=>new Promise(resolve=>{finish=resolve;})});const load=p.ui.load();p.ui.clear();finish({revision:1,assets:[ASSET]});await load;assert.equal(p.ui.element.hidden,true);assert(!p.get('list').textContent.includes('Test Coin'));p.ui.destroy();
 let convert;const q=page({optimizeLogo:()=>new Promise(resolve=>{convert=resolve;})});await q.ui.load();const processing=logo(q);q.account({...ACCOUNT,id:'other'});convert(LOGO);await processing;assert.equal(q.get('preview').querySelector('img'),null);assert.equal(q.ui.element.hidden,true);q.ui.destroy();
});
test('account change or tab departure while MFA is pending cannot submit',async()=>{
 for(const change of ['account','tab']){let confirm;const p=page({authorize:()=>new Promise(resolve=>{confirm=resolve;})});await ready(p);const save=submit(p);if(change==='account')p.account({...ACCOUNT,id:'other'});else{p.active(false);p.ui.pause();}confirm({code:'123456'});await save;assert.equal(p.calls.some(c=>c.path.endsWith('/save')),false);p.ui.destroy();}
});
test('MFA uses captured reviewed details, disables edits and cannot double submit',async()=>{
 let confirm;const p=page({authorize:()=>new Promise(resolve=>{confirm=resolve;})});await ready(p);const save=submit(p);assert.equal(p.get('mint').disabled,true);assert.equal(p.get('image').disabled,true);await submit(p);assert.equal(p.authorizations.length,1);p.get('name').value='Programmatic change';confirm({code:'123456'});await save;assert.equal(p.calls.find(c=>c.path.endsWith('/save')).body.name,'Test Coin');p.ui.destroy();
});
test('catalogue is compact, searchable, escaped and uses only canonical custom logo paths',async()=>{
 const assets=Array.from({length:25},(_,i)=>({...ASSET,name:i?'Asset '+i:'<img src=x>',symbol:'TOK'+i,mint:'2'.repeat(31)+String(i%9+1)}));assets[0].logoPath='https://untrusted.invalid/logo';const p=page({respond:path=>path==='/api/admin/pairs'?{revision:1,assets}:undefined});await p.ui.load();assert.equal(p.get('list').children.length,20);assert.equal(p.get('catalog').open,undefined);assert.equal(p.get('list').querySelector('img[src="https://untrusted.invalid/logo"]'),null);assert.equal(p.get('list').querySelector('script'),null);p.get('search').value='Asset 24';p.get('search').oninput();assert.equal(p.get('list').children.length,1);assert.match(p.get('list').textContent,/Asset 24/);p.ui.destroy();
});
test('read and save errors disable stale submission without exposing raw provider details',async()=>{
 const p=page({respond:path=>{if(path.endsWith('/save'))throw Error('https://rpc.invalid/private-secret');}});await ready(p);await submit(p);assert(!p.ui.element.textContent.includes('private-secret'));assert.equal(p.get('save').disabled,true);p.ui.destroy();
 const q=page({respond:()=>{throw Error('private-secret');}});await q.ui.load();assert.match(q.get('status').textContent,/temporarily unavailable/);assert.equal(q.get('save').disabled,true);q.ui.destroy();
});
test('pause aborts active reads and invalidates responses, destroy removes private draft',async()=>{
 let finish;const p=page({respond:()=>new Promise(resolve=>{finish=resolve;})});const read=p.ui.load(),signal=p.calls[0].options.signal;p.active(false);p.ui.pause();assert.equal(signal.aborted,true);finish({revision:1,assets:[ASSET]});await read;assert(!p.get('list').textContent.includes('Test Coin'));p.ui.destroy();assert.equal(p.ui.element.hidden,true);
});
test('logo helper crops the center square, bounds output and closes decoded bitmap',async()=>{
 let args,closed=0;const bitmap={width:600,height:400,close(){closed++;}},canvas={getContext:()=>({clearRect(){},drawImage(...a){args=a;}}),toBlob:callback=>callback({type:'image/webp',size:4})};const result=await optimizePairLogo({type:'image/png',size:100},{document:{createElement:()=>canvas},decode:async()=>bitmap,readBlob:async()=>LOGO});assert.equal(result,LOGO);assert.deepEqual(args.slice(1),[100,0,400,400,0,0,256,256]);assert.equal(closed,1);assert.equal(canvas.width,canvas.height);
 assert.throws(()=>validatePairLogoFile({type:'image/svg+xml',size:100}),/PNG/);assert.throws(()=>validatePairLogoFile({type:'image/png',size:6*1024*1024}),/5 MB/);
 let attempts=0;canvas.toBlob=callback=>{attempts++;callback({type:'image/webp',size:MAX_PAIR_LOGO_BYTES+1});};await assert.rejects(optimizePairLogo({type:'image/png',size:100},{document:{createElement:()=>canvas},decode:async()=>bitmap,readBlob:async()=>LOGO}),/96 KB/);assert.equal(attempts,7);assert.equal(closed,2);
});

test('admin pair labels share exact backend Unicode and punctuation rules without ticker case conversion',async()=>{
 const accepted=[['Xavier: Renegade Angel','Xavier'],['Energy','$NRG'],['Laugh coin','LMAO!'],['Gork','@gork'],['熊猫','熊猫'],['"　"','"　"'],['Case sensitive','aBc'],['🟥🟪🟦🟩🟨🟧','🟥🟩'],['You’ll','You’ll'],['我的刀盾','我的刀盾'],['Duplicate label','BUTTHOLE'],['Duplicate label','GORK']];
 for(const [name,ticker] of accepted){const p=page();await ready(p);p.get('name').value=name;p.get('ticker').value=ticker;await submit(p);const saved=p.calls.find(c=>c.path.endsWith('/save'));assert(saved,`${name}/${ticker} accepted`);assert.equal(saved.body.name,name);assert.equal(saved.body.ticker,ticker);p.ui.destroy();}
 for(const label of ['<script>','invisible\u200bname','bidi\u202ename','line\nname','control\u0000name']){const p=page();await ready(p);p.get('ticker').value=label;await submit(p);assert.equal(p.authorizations.length,0);p.ui.destroy();}
 const p=page();await ready(p);p.get('ticker').value='A'.repeat(25);await submit(p);assert.equal(p.authorizations.length,0);p.get('ticker').value='OK';p.get('name').value='A'.repeat(81);await submit(p);assert.equal(p.authorizations.length,0);p.ui.destroy();
});
test('a wrong 2FA code or rate limit is shown as given and keeps the successful mint check',async()=>{
 for(const error of [Object.assign(Error('Invalid or already used authentication code. Use a new code.'),{status:400,known:true}),Object.assign(Error('Too many attempts. Try again in 12 minutes.'),{status:429,known:true})]){
  let fail=true;const p=page({respond:path=>{if(path.endsWith('/save')&&fail)throw error;}});await ready(p);await submit(p);
  assert.equal(p.get('status').textContent,error.message);assert.match(p.get('support').textContent,/Available for pairing/);assert.equal(p.get('save').disabled,false);assert.equal(p.calls.filter(c=>c.path.endsWith('/check')).length,1);
  fail=false;await submit(p);assert.match(p.get('status').textContent,/saved and available for pairing/);p.ui.destroy();
 }
});
