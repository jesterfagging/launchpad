import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createAdminPumpPublic} from '../public/admin-pump-public-ui.mjs';
const A='7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS',R='HN22QWXBPb7dfmPhTjCf14jDco4dYzwDKeehWDXcnHEF';
async function setup({enabled=false,ready=true,chainEnabled=true,pending=false}={}){
 const {document}=parseHTML('<main></main>');let account={id:'owner',role:'admin',mfaEnabled:true},active=true;const calls=[],wallet={state:()=>({address:A,name:'Test wallet',wallets:[{id:'test',name:'Test wallet'}]}),onChange:()=>()=>{},connect:async()=>{},signBatch:async value=>{calls.push(['sign',value]);return['signed'];}};
 const ui=createAdminPumpPublic({document,getAccount:()=>account,isActive:()=>active,walletFactory:()=>wallet,setTimer:()=>0,clearTimer(){},api:async(path,body)=>{calls.push([path,body]);if(path.endsWith('/deployment/status'))return{operator:A,stage:'deployed',verifiedDeployment:true};if(path.endsWith('/configuration/prepare'))return{planId:'plan',pendingSignatures:[{wallet:A,transaction:'AQID'}],maxWalletDebitLamports:'5000'};if(path.includes('/configuration/'))return{operator:A,configured:true,chainEnabled,canPrepare:true,...(pending?{pendingBatch:{state:'submitted'}}:{})};if(path.endsWith('/configure')){enabled=body.enabled;return{publicEnabled:enabled};}return{publicEnabled:enabled,ready,canEnable:ready,relayer:R,relayerBalanceLamports:'10000000',relayerMinimumBalanceLamports:'1000000',recommendedBalanceLamports:'10000000'};}});
 document.querySelector('main').append(ui.element);await ui.load();return{ui,document,calls,setAccount:v=>account=v,setActive:v=>active=v,button:text=>[...ui.element.querySelectorAll('button')].find(n=>n.textContent===text)};
}
test('public launch activation is disabled until verified readiness and chain activation',async()=>{
 for(const options of [{ready:false},{chainEnabled:false}]){const f=await setup(options);assert.equal(f.button('Open public launches').disabled,true);assert.equal(f.calls.some(x=>x[0]==='sign'),false);f.ui.destroy();}
});
test('enabling public launch uses explicit host switch after verified configuration',async()=>{
 const f=await setup();assert.equal(f.button('Open public launches').disabled,false);await f.button('Open public launches').onclick();assert.equal(f.calls.some(x=>x[0]==='/api/admin/pump-public/configure'),false,'the first click only asks for confirmation');f.button('Cancel').onclick();assert.equal(f.document.getElementById('admin-pump-public-open-review').hidden,true);await f.button('Open public launches').onclick();await f.button('Confirm: open public launches').onclick();assert(f.calls.some(x=>x[0]==='/api/admin/pump-public/configure'&&x[1].enabled===true));assert.equal(f.calls.some(x=>x[0]==='sign'),false);assert.match(f.ui.element.textContent,/0.01 SOL/);assert.match(f.ui.element.textContent,/prepaid in each launch/);f.ui.destroy();
});
test('config activation prepares wallet review without signing automatically',async()=>{
 const f=await setup({chainEnabled:false});await f.button('Review public activation').onclick();assert(f.calls.some(x=>x[0]==='/api/admin/pump-public/configuration/prepare'&&x[1].enabled===true));assert.equal(f.calls.some(x=>x[0]==='sign'),false);f.setAccount(null);await f.button('Approve in deployment wallet').onclick();assert.equal(f.calls.some(x=>x[0]==='sign'),false);f.ui.destroy();
});
test('refresh reconciles a pending configuration instead of starting another approval',async()=>{
 const f=await setup({pending:true});await f.ui.load();assert(f.calls.some(x=>x[0]==='/api/admin/pump-public/configuration/reconcile'));assert.equal(f.calls.some(x=>x[0].endsWith('/prepare')),false);f.ui.destroy();
});
