// AI influencer (v71.30) on the launch page: the optional block inside the AI Agent settings rendered from the agent
// catalog's `influencer` availability, the tile chips (person vs mascot), the live prompt preview, the X connection
// (GET /connect → popup → #x-connected → postMessage / poll), the reference art upload (magic bytes, size, base64 POST),
// the settings travelling as one `agent.influencer` object, readiness, and the docs and terms.
import {optimizeLaunchImage} from '../public/launch-image.mjs';
import {createChainSelect,initialLaunchChain,launchChainById} from '../public/launch-chains.mjs';
import * as meteoraUiModule from '../public/meteora-ui.mjs';
import * as dammPumpUiModule from '../public/damm-pump-ui.mjs';
import * as pumpPublicUiModule from '../public/pump-public-ui.mjs';
import * as pumpUiModule from '../public/pump-launch-test-ui.mjs';
import * as pumpClassicUiModule from '../public/pump-classic-ui.mjs';
import * as influencerUiModule from '../public/influencer-ui.mjs';
import {PUMP_CLASSIC_MODES,PUMP_CLASSIC_STRATEGY_MODES,PUMP_CLASSIC_MODE_LABELS,PUMP_CLASSIC_MODE_SUMMARIES,PUMP_CLASSIC_LIMITS,PUMP_CLASSIC_FEE_LINK,PUMP_CLASSIC_SOL_ONLY_MODES,PUMP_CLASSIC_CONVERT_MODES,PUMP_CLASSIC_OPTION_MODES} from '../public/pump-classic-catalog.mjs';
import {PUMP_OPTIONS,pumpOptionRequest,describePumpOption} from '../public/pump-option-catalog.mjs';
import {AGENT_PERSONALITIES,AGENT_FUNDING_SUMMARY,AGENT_LIMITS,AGENT_OBJECTIVES,AGENT_OBJECTIVE_GROUPS,objectiveById,normalizeObjectiveSettings,AGENT_RATE_CARD_V2} from '../public/agent-catalog.mjs';
import {GOTCHI_THEMES,gotchiFundingSummary,gotchiTheme} from '../public/gotchi-catalog.mjs';
import {HOOK_GROUPS,HOOK_RULES,HOOK_MAX_RULES,HOOK_LIMITS,HOOK_NOT_OFFERED,HOOK_ROUTES,HOOK_TIMEZONES,WEEKDAYS,hookRuleById,hookRulesConflict,hookSettingApplies,hookLaunchRequest,describeHookRule,hookAppUnavailableText} from '../public/hook-catalog.mjs';
import {createQuoteIcon,createQuoteLabel} from '../public/quote-logos.mjs';
import {CREATOR_FEE_TIERS,creatorFeeForLaunch} from '../public/creator-fee-schedule.mjs';
import {createLaunchpadWallet} from '../public/launchpad-wallet.mjs';
import {launchInput,displayUnits,units,SOL_MINT,USDC_MINT,socialLink,agentLaunchRequest} from '../public/launchpad-model.mjs';
import {LAUNCH_ASSETS} from '../public/launch-assets.mjs';
import {INFLUENCER_TILES,INFLUENCER_LIMITS,INFLUENCER_MEDIA_MODES,INFLUENCER_RULES,influencerLaunchRequest,influencerPrompt,tileGroupsFor,defaultTiles} from '../public/influencer-catalog.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {parseHTML} from 'linkedom';

const ADDRESS='So11111111111111111111111111111111111111112',MINT='GNu1FSuype33KF4RXfow38Dw3ziw9e71FTBLVY5mdrTa';
const SIGN='solana:signTransaction',CHAIN='solana:mainnet';
const X1='a1b2c3d4e5f6a1b2c3d4e5f6',X2='0f0e0d0c0b0a0f0e0d0c0b0a',REFERENCE='c'.repeat(64)+'.png',ORIGIN='http://app.local';
const flush=()=>new Promise(resolve=>setTimeout(resolve,10));
const until=async(check,message)=>{for(let i=0;i<200;i++){if(check())return;await flush();}assert.fail(message);};
const text=node=>String(node?.textContent||'').replace(/\s+/g,' ').trim();
const escapeRegExp=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const PNG=[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,13,73,72,68,82,0,0,1,0,0,0,1,0,8,6,0,0,0];
const pngBytes=(size=64)=>{const bytes=new Uint8Array(size);bytes.set(PNG.slice(0,Math.min(PNG.length,size)));return bytes;};

// ---- Launch page harness (as test/hook-ui.test.mjs mounts launchpad.js), with the influencer module in place of its lazy import.
function mockWallet({address=ADDRESS}={}){
  const calls={connect:0,sign:[]};let change;
  const account={address,chains:[CHAIN],features:[SIGN],publicKey:new Uint8Array(32)};
  const wallet={name:'Test wallet',chains:[CHAIN],accounts:[],features:{
    'standard:connect':{async connect(){calls.connect++;wallet.accounts=[account];return{accounts:wallet.accounts};}},
    'standard:events':{on(type,fn){change=fn;return()=>{change=null;};}},
    'standard:disconnect':{async disconnect(){wallet.accounts=[];}},
    [SIGN]:{supportedTransactionVersions:[0],async signTransaction(input){calls.sign.push(input);return[{signedTransaction:new Uint8Array([4,5,6])}];}}
  }};
  return{wallet,calls,change(accounts){wallet.accounts=accounts;change?.({accounts});}};
}
const pairs=[{mint:SOL_MINT,symbol:'SOL',name:'Solana',decimals:9,category:'crypto',launchReady:true,supported:true},{mint:USDC_MINT,symbol:'USDC',name:'USD Coin',decimals:6,category:'crypto',launchReady:true,supported:true}];
const account=(id,handle,over={})=>({id,handle,displayName:handle+' display',state:'connected',stateReason:'',agentMint:null,connectedAt:1700000000000+id.charCodeAt(0),lastPostAt:0,postsToday:0,...over});
function launchServer({influencer={open:true,xOpen:true,mediaOpen:true},accounts=[]}={}){
  const state={prepares:[],accounts:accounts.slice(),connects:[],disconnects:[],references:[],authenticated:true};
  state.route=async(path,body)=>{
    const url=new URL(path,'http://app.local');
    if(path==='/api/session')return{authenticated:true,token:'public-csrf',features:{walletOnly:true},account:{id:'public-user',authType:'wallet',mainWallet:ADDRESS}};
    if(url.pathname==='/api/launchpad/agents/catalog')return{intakeOpen:true,models:[{id:'openai/gpt-6-luna',name:'Luna'}],defaultModel:'openai/gpt-6-luna',domainAllowlist:[],...(influencer?{influencer:{intakeOpen:true,dryRun:false,limits:INFLUENCER_LIMITS,featureClipLengths:[10,15,30],rateCard:{version:AGENT_RATE_CARD_V2.version,imageUsd:AGENT_RATE_CARD_V2.imageUsd,editUsd:AGENT_RATE_CARD_V2.editUsd,videoSecondUsd:AGENT_RATE_CARD_V2.videoSecondUsd,videoOverheadUsd:AGENT_RATE_CARD_V2.videoOverheadUsd,mediaCheckUsd:AGENT_RATE_CARD_V2.mediaCheckUsd,xPostUsd:AGENT_RATE_CARD_V2.xPostUsd,xPostLinkUsd:AGENT_RATE_CARD_V2.xPostLinkUsd},rules:INFLUENCER_RULES,...influencer}}:{})};
    if(url.pathname==='/api/launchpad/meteora/status')return{available:true,publicEnabled:true};
    if(url.pathname==='/api/launchpad/meteora/pairs')return{pairs};
    if(url.pathname==='/api/launchpad/meteora/operations')return{operations:[]};
    if(url.pathname==='/api/launchpad/meteora/prepare'){state.prepares.push(body);return{operation:{id:'meteora-operation-123',action:'initialize',wallet:ADDRESS,mint:MINT,state:'awaiting_signature',transaction:'AQID',expiresAt:Date.now()+120000,review:{maxWalletDebitLamports:'20000000',firstBuyRaw:'0',quoteMint:SOL_MINT,quoteDecimals:9,quoteSymbol:'SOL',stage:'initialize',stages:2}}};}
    if(url.pathname==='/api/launchpad/x/accounts')return{accounts:state.accounts,available:true,at:Date.now()};
    if(url.pathname==='/api/launchpad/x/connect'){state.connects.push(url.searchParams.get('returnTo'));return{url:'https://x.com/i/oauth2/authorize?response_type=code&client_id=abc&state=s1&code_challenge=c1',expiresAt:Date.now()+600000};}
    if(url.pathname==='/api/launchpad/x/disconnect'){state.disconnects.push(body);state.accounts=state.accounts.filter(row=>row.id!==body.xAccountId);return{accounts:state.accounts};}
    if(url.pathname==='/api/launchpad/agents/influencer/reference'){state.references.push(body);return{referenceId:REFERENCE,bytes:Math.floor(String(body.data).length*3/4),type:'png'};}
    return undefined;
  };
  return state;
}
async function launchPage({route,mock=mockWallet(),href='http://app.local/launchpad'}={}){
  const {document,window}=parseHTML(await readFile(new URL('../public/launchpad.html',import.meta.url),'utf8'));
  Object.defineProperty(window,'location',{value:{href},configurable:true});
  Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return[...this.options].find(o=>o.selected)?.value||this.options[0]?.value||'';},set(value){for(const o of this.options)o.removeAttribute('selected');[...this.options].find(o=>o.value===String(value))?.setAttribute('selected','');}});
  for(const input of document.querySelectorAll('input[type=radio],input[type=checkbox]'))input.checked=input.hasAttribute('checked');
  const form=document.getElementById('launch-form'),fields={namedItem(name){const rows=[...form.querySelectorAll('[name]')].filter(x=>x.name===name);return rows.length===1?rows[0]:{get value(){return rows.find(x=>x.checked)?.value||'';}};}};
  Object.defineProperty(form,'elements',{value:fields});
  window.HTMLCanvasElement.prototype.getContext=()=>({clearRect(){},drawImage(){}});window.HTMLCanvasElement.prototype.toBlob=fn=>fn({size:30});
  window.HTMLElement.prototype.scrollIntoView=function(){};window.HTMLElement.prototype.showModal=function(){this.open=true;};window.HTMLElement.prototype.close=function(){this.open=false;};
  class FileReader{readAsDataURL(){this.result='data:image/webp;base64,AAAA';this.onload();}}
  class FormData{constructor(form){this.form=form;}*[Symbol.iterator](){for(const input of this.form.querySelectorAll('[name]'))if(!input.disabled&&(!['checkbox','radio'].includes(input.type)||input.checked))yield[input.name,input.value];}}
  const calls=[],intervals=new Map(),opened=[];
  Object.defineProperty(window,'open',{value:(url,name,features)=>{opened.push({url,name,features});return opened.blocked?null:{closed:false,close(){}};},configurable:true});
  Object.defineProperty(window,'confirm',{value:()=>true,configurable:true});
  const fetch=async(path,options={})=>{const body=options.body?JSON.parse(options.body):undefined;calls.push({path,body,method:options.method||'GET',headers:options.headers||{}});const data=await route?.(path,body);if(data)return{ok:data.ok!==false,status:data.status||200,json:async()=>data.body??data};return{ok:true,status:200,json:async()=>path.endsWith('/quotes')?{assets:LAUNCH_ASSETS.map(a=>({...a,supported:true})),canViewComingSoon:false}:path.endsWith('/image')?{imageId:'a'.repeat(64)+'.webp'}:{launches:[]}};};
  window.addEventListener('wallet-standard:app-ready',event=>event.detail.register(mock.wallet));
  const source=(await readFile(new URL('../public/launchpad.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace(/^export /gm,'').replace("await import('./pump-launch-test-ui.mjs')",'pumpUiModule').replace("await import('./pump-public-ui.mjs')",'pumpPublicUiModule').replace("await import('./meteora-ui.mjs')",'meteoraUiModule').replace("await import('./damm-pump-ui.mjs')",'dammPumpUiModule').replace("await import('./pump-classic-ui.mjs')",'pumpClassicUiModule').replace("import('./influencer-ui.mjs')",'Promise.resolve(influencerUiModule)').replace(/bootPage\('launchpad',mountPage\);/,'')+'\nconst pageController=mountPage({document,window:document.defaultView});await pageController.ready;return pageController;';
  const deps={createChainSelect,initialLaunchChain,launchChainById,optimizeLaunchImage,meteoraUiModule,dammPumpUiModule,pumpUiModule,pumpPublicUiModule,pumpClassicUiModule,influencerUiModule,PUMP_CLASSIC_MODES,PUMP_CLASSIC_STRATEGY_MODES,PUMP_CLASSIC_MODE_LABELS,PUMP_CLASSIC_MODE_SUMMARIES,PUMP_CLASSIC_LIMITS,PUMP_CLASSIC_FEE_LINK,PUMP_CLASSIC_SOL_ONLY_MODES,PUMP_CLASSIC_CONVERT_MODES,PUMP_CLASSIC_OPTION_MODES,PUMP_OPTIONS,pumpOptionRequest,describePumpOption,AGENT_PERSONALITIES,AGENT_FUNDING_SUMMARY,AGENT_LIMITS,AGENT_OBJECTIVES,AGENT_OBJECTIVE_GROUPS,objectiveById,normalizeObjectiveSettings,GOTCHI_THEMES,gotchiFundingSummary,gotchiTheme,HOOK_GROUPS,HOOK_RULES,HOOK_MAX_RULES,HOOK_LIMITS,HOOK_NOT_OFFERED,HOOK_ROUTES,HOOK_TIMEZONES,WEEKDAYS,hookRuleById,hookRulesConflict,hookSettingApplies,hookLaunchRequest,describeHookRule,hookAppUnavailableText,createQuoteIcon,createQuoteLabel,CREATOR_FEE_TIERS,creatorFeeForLaunch,document,fetch,FileReader,createImageBitmap:async()=>({width:8,height:8,close(){}}),crypto:{randomUUID},FormData,requestAnimationFrame:fn=>{setTimeout(fn,0);return 1;},setInterval:(fn,ms)=>{intervals.set(ms,fn);return ms;},clearInterval:ms=>{intervals.delete(ms);},setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,10)),matchMedia:()=>({matches:true}),createWorkspaceShell:()=>{},launchInput,displayUnits,units,SOL_MINT,USDC_MINT,socialLink,LAUNCH_ASSETS,createLaunchpadWallet};
  const controller=await new (Object.getPrototypeOf(async()=>{}).constructor)(...Object.keys(deps),source)(...Object.values(deps));await flush();
  const $=id=>document.getElementById(id);
  const p={controller,document,window,form,$,calls,mock,intervals,opened,
    async meteora(){document.querySelector('[data-launch-venue=meteora]').onclick();await flush();await flush();},
    option(value){for(const radio of form.querySelectorAll('[name=feeMode]'))radio.checked=radio.value===value;form.dispatchEvent(new window.Event('change'));},
    async agent(){p.option('agent');await flush();await flush();await flush();},
    check(id,on=true){const input=$(id);assert(input,id);assert.equal(input.disabled,false,id+' is disabled');input.checked=on;input.dispatchEvent(new window.Event('change',{bubbles:true}));},
    pick(name,value){const radio=form.querySelector('input[name="'+name+'"][value="'+value+'"]');assert(radio,name+'='+value);assert.equal(radio.disabled,false,name+'='+value+' is disabled');radio.checked=true;radio.dispatchEvent(new window.Event('change',{bubbles:true}));},
    type(id,value){const input=$(id);assert(input,id);input.value=String(value);input.dispatchEvent(new window.Event('input',{bubbles:true}));},
    select(id,value){const select=$(id);assert(select,id);select.value=String(value);select.dispatchEvent(new window.Event('change',{bubbles:true}));},
    groups:()=>[...$('launch-influencer-tiles').querySelectorAll('.launch-influencer-group')].filter(group=>!group.hidden).map(group=>group.dataset.group),
    message(data,origin=ORIGIN){window.dispatchEvent(new window.MessageEvent('message',{data,origin}));},
    async image(){Object.defineProperty($('launch-image'),'files',{value:[{type:'image/png',size:30}],configurable:true});await $('launch-image').onchange();},
    async fill(){form.elements.namedItem('name').value='Example';form.elements.namedItem('symbol').value='EXAMPLE';p.type('launch-agent-mission','Tell holders what changed and why.');await this.image();},
    async open(){$('launch-open').onclick();await flush();await flush();},
    async connect(){$('launch-connect').onclick();document.querySelector('#launch-wallet-options button').onclick();await flush();},
    async upload(file){const input=$('launch-influencer-reference-file');Object.defineProperty(input,'files',{value:file?[file]:[],configurable:true});input.dispatchEvent(new window.Event('change',{bubbles:true}));await flush();await flush();await flush();}};
  return p;
}

test('the block renders from the agent catalog inside the AI Agent settings: legend, hint, the master toggle off by default, both layers and the disclosure bullets hidden until it is on',async t=>{
  const s=launchServer(),p=await launchPage({route:s.route});t.after(()=>p.controller.destroy());
  const block=p.$('launch-influencer-block');assert(block,'the fieldset ships in launchpad.html');assert.equal(block.hidden,false,'the module shows it');assert.equal(block.closest('#launch-agent-settings')!==null,true,'inside the agent settings');
  assert.equal(block.previousElementSibling.id,'launch-agent-model-block','after the Model block');assert.match(text(block.nextElementSibling),/^Research domains/);
  assert.equal(text(block.querySelector('.launch-agent-block-title')),'AI influencer (optional)');assert.match(text(block.querySelector('.launch-agent-block-hint')),/Give the agent a face and an X account\. Posts and media are capped per day and charged to the agent’s operating credit\./);
  await p.connect();await p.meteora();await p.fill();await p.agent();
  assert.equal(p.$('launch-agent-settings').hidden,false);assert.equal(p.$('launch-influencer-enabled').checked,false);assert.equal(p.$('launch-influencer-enabled').disabled,false,'the host offers the option');assert.equal(p.$('launch-influencer-status').textContent,'');
  assert.equal(p.$('launch-influencer').querySelector('.launch-influencer-layers').hidden,true,'everything below the master toggle is hidden while it is off');
  for(const item of p.document.querySelectorAll('[data-influencer-disclosure]'))assert.equal(item.hidden,true,'disclosure bullets hidden while off');
  assert.equal(p.$('launch-card-influencer-row').hidden,true);
  assert.deepEqual(influencerUiModule.influencerSettings(p.form),{enabled:false},'off: the agent object says enabled: false, which the shared model turns into "no influencer"');
  p.check('launch-influencer-enabled');await flush();
  assert.equal(p.$('launch-influencer').querySelector('.launch-influencer-layers').hidden,false);
  const bullets=[...p.document.querySelectorAll('#launch-agent-disclosure [data-influencer-disclosure]')];assert.equal(bullets.length,4);for(const item of bullets)assert.equal(item.hidden,false);
  assert.match(text(bullets[0]),/original, fictional adult \(or a non-human mascot\)/);assert.match(text(bullets[0]),/No real people, celebrities, brand mascots or minors/);
  assert.match(text(bullets[1]),/You keep the X account/);assert.match(text(bullets[1]),/labelling the account as automated/);
  assert.match(text(bullets[2]),/\$0\.01 per picture \(\$0\.05 for an edited one\), \$0\.65 per 5-second clip, \$0\.01 per consistency check, \$0\.02 per post or \$0\.22 per post with the coin link/);assert.match(text(bullets[2]),/operating credit/);
  assert.match(text(bullets[3]),/Launchpad can pause an influencer/);assert.match(text(bullets[3]),/Nothing an influencer posts is financial advice/);
  // On with neither layer: the catalogue's complaint shows, the launch is blocked and the summary says so.
  assert.equal(text(p.$('launch-influencer-error')),'Turn on posting to X, a character, or both; otherwise switch the influencer off.');assert.equal(p.$('launch-influencer-error').hidden,false);
  assert.equal(p.$('launch-card-influencer-row').hidden,false);assert.equal(text(p.$('launch-card-influencer')),'on, nothing chosen yet');
  assert.equal(p.$('launch-open').disabled,true);assert.match(p.$('launch-ready-text').textContent,/finish the AI influencer settings/);
  p.check('launch-influencer-enabled',false);await flush();assert.equal(p.$('launch-open').disabled,false);assert.equal(p.$('launch-card-influencer-row').hidden,true);
});

test('Character: tile chips as radio groups from the catalogue, the kind switch swaps person and mascot groups, the preview sentence is the catalogue prompt with the coin name, media modes show and hide the daily caps',async t=>{
  const s=launchServer(),p=await launchPage({route:s.route});t.after(()=>p.controller.destroy());
  await p.meteora();await p.agent();p.check('launch-influencer-enabled');p.check('launch-influencer-character');await flush();
  const body=p.$('launch-influencer').querySelector('.launch-influencer-char');assert.equal(body.hidden,false);assert.equal(p.$('launch-influencer').querySelector('.launch-influencer-x').hidden,true,'Post to X stays off');
  // Source segments and every tile group, each a labelled radiogroup of chips with the catalogue's options.
  assert.deepEqual([...body.querySelectorAll('.launch-influencer-source input')].map(input=>[input.value,input.checked]),[['tiles',true],['reference',false]]);
  const groups=[...p.$('launch-influencer-tiles').querySelectorAll('.launch-influencer-group')];assert.deepEqual(groups.map(group=>group.dataset.group),INFLUENCER_TILES.map(group=>group.key));
  for(const group of groups){const item=INFLUENCER_TILES.find(row=>row.key===group.dataset.group),chips=group.querySelector('.launch-influencer-chips');assert.equal(chips.getAttribute('role'),'radiogroup');assert.equal(p.document.getElementById(chips.getAttribute('aria-labelledby')).textContent,item.label);assert.deepEqual([...chips.querySelectorAll('input')].map(input=>[input.type,input.name,input.value]),item.options.map(option=>['radio','influencerTile_'+item.key,option.id]));assert.deepEqual([...chips.querySelectorAll('label span')].map(text),item.options.map(option=>option.label));}
  assert.deepEqual(p.groups(),tileGroupsFor('person').map(group=>group.key),'person groups by default');
  const defaults=defaultTiles('person');for(const [key,value] of Object.entries(defaults))assert.equal(p.form.querySelector('input[name="influencerTile_'+key+'"]:checked')?.value,value,key+' defaults to the first option');
  assert.equal(text(p.$('launch-influencer-preview').querySelector('.launch-influencer-preview-text')),influencerPrompt(defaults,{name:'',symbol:''}));
  // The kind switch: mascot hides the person-only groups, shows Creature, and the preview follows; the coin name travels into it.
  p.pick('influencerTile_kind','mascot');await flush();
  assert.deepEqual(p.groups(),tileGroupsFor('mascot').map(group=>group.key));assert.equal(p.groups().includes('presentsAs'),false);assert.equal(p.groups().includes('creature'),true);
  assert.equal(p.$('launch-influencer-tiles').querySelector('[data-group=presentsAs] input').disabled,true,'hidden groups are disabled');
  p.form.elements.namedItem('name').value='Moon Fox';p.form.elements.namedItem('symbol').value='fox';p.pick('influencerTile_creature','fox');p.pick('influencerTile_style','anime');await flush();
  const expected=influencerLaunchRequest({enabled:true,character:true,tiles:{kind:'mascot',creature:'fox',style:'anime'}}).tiles;
  assert.equal(text(p.$('launch-influencer-preview').querySelector('.launch-influencer-preview-text')),influencerPrompt(expected,{name:'Moon Fox',symbol:'FOX'}));assert.match(text(p.$('launch-influencer-preview')),/a cartoon fox/);assert.match(text(p.$('launch-influencer-preview')),/the face of the coin Moon Fox \(FOX\)/);
  p.pick('influencerTile_kind','person');await flush();assert.deepEqual(p.groups(),tileGroupsFor('person').map(group=>group.key));assert.equal(p.$('launch-influencer-tiles').querySelector('[data-group=presentsAs] input').disabled,false);
  // Media modes from the catalogue: pictures by default (pictures cap shown), clips add the clip cap, text hides both.
  assert.deepEqual([...body.querySelectorAll('.launch-influencer-media input')].map(input=>[input.value,input.checked]),INFLUENCER_MEDIA_MODES.map(mode=>[mode.id,mode.id==='images']));
  assert.equal(p.$('launch-influencer-daily-images').closest('label').hidden,false);assert.equal(p.$('launch-influencer-daily-videos').closest('label').hidden,true);assert.equal(p.$('launch-influencer-daily-images').value,String(INFLUENCER_LIMITS.dailyImagesDefault));
  p.pick('influencerMedia','video');await flush();assert.equal(p.$('launch-influencer-daily-videos').closest('label').hidden,false);assert.equal(p.$('launch-influencer-daily-videos').value,'0');
  p.pick('influencerMedia','text');await flush();assert.equal(p.$('launch-influencer-daily-images').closest('label').hidden,true);assert.equal(p.$('launch-influencer-daily-videos').closest('label').hidden,true);
  assert.match(text(p.$('launch-influencer-costs')),/^\$0\.01 per picture \(\$0\.05 edited\) · \$0\.65 per 5-second clip · \$0\.01 per consistency check/);
  // Invalid numbers: the catalogue's message, aria-invalid on the field, the launch blocked; a valid number clears it.
  p.pick('influencerMedia','images');p.type('launch-influencer-daily-images','9');await flush();
  assert.equal(text(p.$('launch-influencer-error')),'Daily pictures must be a whole number between 0 and 6.');assert.equal(p.$('launch-influencer-daily-images').getAttribute('aria-invalid'),'true');assert.equal(p.$('launch-open').disabled,true);
  p.type('launch-influencer-daily-images','0');await flush();assert.equal(text(p.$('launch-influencer-error')),'Allow at least one picture or clip a day, or choose text only.');
  p.type('launch-influencer-daily-images','3');await flush();assert.equal(p.$('launch-influencer-error').hidden,true);assert.equal(p.$('launch-influencer-daily-images').getAttribute('aria-invalid'),'false');
  assert.equal(text(p.$('launch-card-influencer')),'character from tiles, pictures');
});

test('Post to X: the connect flow asks the server for the authorize URL, opens it in a popup, hears the popup’s same-origin message (and ignores others), lists the accounts with the newest free one chosen, polls while waiting, and Disconnect asks the server',async t=>{
  const s=launchServer(),p=await launchPage({route:s.route});t.after(()=>p.controller.destroy());
  await p.meteora();await p.agent();p.check('launch-influencer-enabled');p.check('launch-influencer-post');await flush();await flush();
  const xBody=p.$('launch-influencer').querySelector('.launch-influencer-x');assert.equal(xBody.hidden,false);
  assert.equal(p.calls.filter(call=>call.path==='/api/launchpad/x/accounts').length,1,'the account list is read once the layer shows');assert.equal(p.calls.find(call=>call.path==='/api/launchpad/x/accounts').headers['x-control-token'],'public-csrf','the session token travels');
  assert.match(text(p.$('launch-influencer-accounts')),/No X account connected yet/);assert.equal(text(p.$('launch-influencer-error')),'Connect the X account the agent will post to.');assert.equal(p.$('launch-open').disabled,true);
  assert.equal(p.$('launch-influencer-cadence').value,'6');assert.deepEqual([...p.$('launch-influencer-cadence').options].map(option=>option.value),INFLUENCER_LIMITS.cadenceHours.map(String));assert.equal(p.$('launch-influencer-daily-posts').value,'4');assert.equal(p.$('launch-influencer-coin-link').checked,true);
  assert.equal(text(p.$('launch-influencer-coin-link').closest('label')),'Add the coin page link to every post ($0.22 per post with a link, $0.02 without)');
  // Connect X: GET /connect with returnTo=launchpad, the URL opened as a named popup, then the page waits.
  p.$('launch-influencer-connect').onclick();await flush();await flush();
  assert.deepEqual(s.connects,['launchpad']);assert.equal(p.opened.length,1);assert.equal(p.opened[0].url,'https://x.com/i/oauth2/authorize?response_type=code&client_id=abc&state=s1&code_challenge=c1');assert.equal(p.opened[0].name,'curve-x');assert.equal(p.opened[0].features,'popup,width=600,height=750');
  assert.match(text(p.$('launch-influencer-x-status')),/Waiting for X/);assert(p.intervals.has(2000),'polls the account list every 2 s');
  // A message from another origin, or of another shape, changes nothing.
  s.accounts.push(account(X1,'moonfox'));
  p.message({type:'curve-x-connected',id:X1},'https://evil.example');await flush();await flush();
  assert.equal(p.$('launch-influencer-x-account').value,'');
  p.message({type:'curve-x-connected',id:'not-an-id'});p.message('curve-x-connected');await flush();assert.equal(p.$('launch-influencer-x-account').value,'');
  // The popup's message: the list is read again, the new account is chosen, the hidden field and the summary follow, the launch unblocks.
  p.message({type:'curve-x-connected',id:X1});await flush();await flush();await flush();
  assert.equal(p.$('launch-influencer-x-account').value,X1);assert.equal(p.$('launch-influencer-x-account').name,'influencerXAccountId');
  const rows=[...p.$('launch-influencer-accounts').querySelectorAll('.launch-influencer-account')];assert.equal(rows.length,1);assert.equal(text(rows[0].querySelector('strong')),'@moonfox');assert.equal(rows[0].querySelector('input').checked,true);assert.equal(rows[0].querySelector('input').name,'influencerXAccountChoice');
  assert.match(text(p.$('launch-influencer-x-status')),/@moonfox connected/);assert.equal(p.$('launch-influencer-error').hidden,true);assert.equal(p.$('launch-open').disabled,false);
  assert.equal(text(p.$('launch-card-influencer')),'posts to @moonfox every 6 h, up to 4/day with the coin link');
  assert.equal(p.intervals.has(2000),false,'polling stops once the account arrived');
  // Connecting another account: the poll (every 2 s) finds it and the account just connected becomes the choice; the creator can switch back.
  s.accounts.push(account(X2,'nightowl',{connectedAt:1800000000000}));p.$('launch-influencer-connect').onclick();await flush();await flush();
  assert.equal(text(p.$('launch-influencer-connect')),'Connect another X account');assert(p.intervals.has(2000),'polls again');
  p.intervals.get(2000)();await flush();await flush();
  assert.equal([...p.$('launch-influencer-accounts').querySelectorAll('.launch-influencer-account')].length,2);assert.equal(p.$('launch-influencer-x-account').value,X2,'the account just connected is chosen');assert.equal(text(p.$('launch-card-influencer')),'posts to @nightowl every 6 h, up to 4/day with the coin link');
  p.pick('influencerXAccountChoice',X1);await flush();assert.equal(p.$('launch-influencer-x-account').value,X1);assert.equal(text(p.$('launch-card-influencer')),'posts to @moonfox every 6 h, up to 4/day with the coin link');
  // Disconnect: confirmed, posted with the id, the list follows and the choice stays with the remaining account.
  [...p.$('launch-influencer-accounts').querySelectorAll('.launch-influencer-disconnect')].find(button=>button.getAttribute('aria-label')==='Disconnect @nightowl').onclick();await flush();await flush();
  assert.deepEqual(s.disconnects,[{xAccountId:X2}]);assert.equal(p.calls.find(call=>call.path==='/api/launchpad/x/disconnect').headers['x-control-token'],'public-csrf');
  assert.equal([...p.$('launch-influencer-accounts').querySelectorAll('.launch-influencer-account')].length,1);assert.equal(p.$('launch-influencer-x-account').value,X1);
  // A popup error message reads as text; a revoked account is listed but cannot be chosen.
  p.message({type:'curve-x-error',message:'You cancelled the X sign-in.'});await flush();assert.match(text(p.$('launch-influencer-x-status')),/You cancelled the X sign-in\./);
  s.accounts=[account(X1,'moonfox',{state:'revoked',stateReason:'X revoked the connection. Reconnect the account from the coin page.'})];p.message({type:'curve-x-connected',id:X1});await flush();await flush();
  const revoked=p.$('launch-influencer-accounts').querySelector('.launch-influencer-account');assert.equal(revoked.classList.contains('is-revoked'),true);assert.equal(revoked.querySelector('input').disabled,true);assert.match(text(revoked),/Reconnect/);assert.equal(p.$('launch-influencer-x-account').value,'','a revoked account is not a usable choice');
  assert.equal(text(p.$('launch-influencer-error')),'Connect the X account the agent will post to.');assert.equal(p.$('launch-open').disabled,true);
});

test('a blocked popup falls back to a link; the callback hash on this page posts to the opener and closes, or shows here without one',async t=>{
  const s=launchServer(),p=await launchPage({route:s.route});t.after(()=>p.controller.destroy());
  await p.meteora();await p.agent();p.check('launch-influencer-enabled');p.check('launch-influencer-post');await flush();
  p.opened.blocked=true;p.$('launch-influencer-connect').onclick();await flush();await flush();
  const link=p.$('launch-influencer').querySelector('.launch-influencer-popup-link');assert.equal(link.hidden,false);assert.equal(link.href,'https://x.com/i/oauth2/authorize?response_type=code&client_id=abc&state=s1&code_challenge=c1');assert.equal(link.rel,'noopener noreferrer');assert.match(text(p.$('launch-influencer-x-status')),/popup was blocked/);
  // The popup side (pure): the hash names the account, the opener gets the message for this origin only, the popup closes.
  const posted=[];let closed=false,replaced=null;
  const popup={location:{hash:'#x-connected='+X1,pathname:'/launchpad',search:'',origin:'https://launchpad.test',href:'https://launchpad.test/launchpad#x-connected='+X1},opener:{postMessage(message,origin){posted.push([message,origin]);}},history:{replaceState(state,title,url){replaced=url;}},close(){closed=true;}};
  assert.deepEqual(influencerUiModule.handleXReturn({window:popup}),{connected:X1,posted:true});assert.deepEqual(posted,[[{type:'curve-x-connected',id:X1},'https://launchpad.test']]);assert.equal(closed,true);assert.equal(replaced,'/launchpad');
  const failed={...popup,location:{...popup.location,hash:'#agent&x-error=This%20X%20connection%20link%20expired.%20Start%20again%20from%20the%20launch%20page.',pathname:'/coin',search:'?mint='+MINT},close(){closed='again';}};posted.length=0;
  assert.deepEqual(influencerUiModule.handleXReturn({window:failed}),{error:'This X connection link expired. Start again from the launch page.',posted:true});assert.deepEqual(posted[0],[{type:'curve-x-error',message:'This X connection link expired. Start again from the launch page.'},'https://launchpad.test']);assert.equal(replaced,'/coin?mint='+MINT+'#agent','the agent anchor survives');
  // Without an opener nothing is posted and the page keeps the result for itself; a hash that names nothing is null; a bad id is ignored.
  assert.deepEqual(influencerUiModule.handleXReturn({window:{...popup,opener:null}}),{connected:X1,posted:false});
  assert.equal(influencerUiModule.handleXReturn({window:{...popup,location:{...popup.location,hash:'#agent'}}}),null);assert.equal(influencerUiModule.xReturnFromHash('#x-connected=../../etc/passwd'),null);assert.equal(influencerUiModule.xReturnFromHash(''),null);
  // The launch page itself landing with the hash and no opener: the status says so and the account is chosen once the list arrives.
  s.accounts.push(account(X1,'moonfox'));
  const q=await launchPage({route:s.route,href:'http://app.local/launchpad#x-connected='+X1});t.after(()=>q.controller.destroy());
  await q.meteora();await q.agent();assert.equal(q.$('launch-influencer-enabled').checked,false);
  q.check('launch-influencer-enabled');await flush();assert.match(text(q.$('launch-influencer-status')),/X account connected\. Turn on Post to X to use it\./);
  q.check('launch-influencer-post');await flush();await flush();await flush();
  assert.equal(q.$('launch-influencer-x-account').value,X1);assert.match(text(q.$('launch-influencer-x-status')),/@moonfox connected/);assert.doesNotMatch(text(q.$('launch-influencer-status')),/Turn on Post to X/);
});

test('reference art: PNG, JPEG or WebP by magic bytes within 1.5 MB is sent as base64 and its id kept; other files and oversized images are refused before any request',async t=>{
  const s=launchServer(),p=await launchPage({route:s.route});t.after(()=>p.controller.destroy());
  await p.meteora();await p.agent();p.check('launch-influencer-enabled');p.check('launch-influencer-character');await flush();
  assert.equal(p.$('launch-influencer').querySelector('.launch-influencer-reference').hidden,true);
  p.pick('influencerSource','reference');await flush();
  const box=p.$('launch-influencer').querySelector('.launch-influencer-reference');assert.equal(box.hidden,false);assert.match(text(box),/Must be your own original art of a fictional adult character\. Not a photo of a real person\./);
  assert.equal(p.$('launch-influencer-reference-file').getAttribute('accept'),'image/png,image/jpeg,image/webp');assert.equal(p.$('launch-influencer-reference-file').name,'influencerReferenceFile');
  assert.equal(text(p.$('launch-influencer-error')),'Upload the reference image first.');assert.equal(p.$('launch-open').disabled,true);
  // Not an image: refused client-side, nothing posted.
  await p.upload(new p.window.File([new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],'art.svg',{type:'image/svg+xml'}));
  assert.equal(s.references.length,0);assert.equal(text(p.$('launch-influencer-reference-status')),'Choose a PNG, JPEG or WebP image.');assert.equal(p.$('launch-influencer-reference-status').classList.contains('negative'),true);assert.equal(p.$('launch-influencer-reference-id').value,'');
  // Too large: refused by size, nothing posted.
  await p.upload(new p.window.File([pngBytes(INFLUENCER_LIMITS.referenceBytes+1)],'big.png',{type:'image/png'}));
  assert.equal(s.references.length,0);assert.equal(text(p.$('launch-influencer-reference-status')),'The reference image is too large. Use at most 1.5 MB.');
  // A PNG by its bytes (whatever the file name says): base64 travels, the id comes back, the thumbnail shows and the launch unblocks.
  const bytes=pngBytes(96);await p.upload(new p.window.File([bytes],'art.jpg',{type:'image/jpeg'}));
  assert.equal(s.references.length,1);assert.equal(s.references[0].data,influencerUiModule.bytesToBase64(bytes));assert.equal(p.calls.find(call=>call.path==='/api/launchpad/agents/influencer/reference').headers['x-control-token'],'public-csrf');
  assert.equal(p.$('launch-influencer-reference-id').value,REFERENCE);assert.equal(p.$('launch-influencer-reference-id').name,'influencerReferenceId');assert.match(text(p.$('launch-influencer-reference-status')),/Reference art uploaded \(0 KB PNG\)/);assert.equal(p.$('launch-influencer-reference-status').classList.contains('negative'),false);
  assert.equal(box.querySelector('img').hidden,false);assert.equal(p.$('launch-influencer-error').hidden,true);assert.equal(p.$('launch-open').disabled,false);
  assert.equal(text(p.$('launch-card-influencer')),'character from reference art, pictures');
  // Switching back to tiles keeps the upload but no longer requires it; the pure inspector agrees on every type.
  p.pick('influencerSource','tiles');await flush();assert.equal(box.hidden,true);assert.equal(p.$('launch-influencer-error').hidden,true);
  assert.deepEqual(influencerUiModule.inspectReferenceImage(new Uint8Array([0xff,0xd8,0xff,0xe0,...new Array(20).fill(0)])),{ok:true,type:'jpg'});
  assert.deepEqual(influencerUiModule.inspectReferenceImage(new Uint8Array([...new TextEncoder().encode('RIFF'),0,0,0,0,...new TextEncoder().encode('WEBPVP8 '),0,0,0,0])),{ok:true,type:'webp'});
  assert.equal(influencerUiModule.inspectReferenceImage(new Uint8Array(8)).ok,false);assert.equal(influencerUiModule.inspectReferenceImage(new TextEncoder().encode('GIF89a'+'x'.repeat(20))).ok,false);
});

test('the settings round-trip: influencerSettings() is what influencerLaunchRequest() normalizes, the Meteora request carries one agent.influencer object and no influencer* field of its own, and the shared model accepts it',async t=>{
  const s=launchServer({accounts:[account(X1,'moonfox')]}),p=await launchPage({route:s.route});t.after(()=>p.controller.destroy());
  await p.connect();await p.meteora();await p.fill();await p.agent();
  p.check('launch-influencer-enabled');p.check('launch-influencer-post');p.check('launch-influencer-character');await flush();await flush();await flush();
  assert.equal(p.$('launch-influencer-x-account').value,X1,'the only connected account is chosen');
  p.select('launch-influencer-cadence','12');p.type('launch-influencer-daily-posts','6');p.check('launch-influencer-coin-link',false);
  p.pick('influencerTile_kind','mascot');p.pick('influencerTile_creature','owl');p.pick('influencerTile_palette','pastel');p.pick('influencerMedia','video');p.type('launch-influencer-daily-images','1');p.type('launch-influencer-daily-videos','1');await flush();
  // The step's own reading, normalized by the catalogue, is exactly what the server will compute again.
  const settings=influencerUiModule.influencerSettings(p.form);
  assert.deepEqual(settings,{enabled:true,postToX:true,xAccountId:X1,cadenceHours:'12',dailyPosts:'6',coinLink:false,character:true,source:'tiles',kind:'mascot',tiles:{kind:'mascot',creature:'owl',outfit:'streetwear',style:'photoreal',palette:'pastel',setting:'studio',vibe:'confident'},referenceId:'',media:'video',dailyImages:'1',dailyVideos:'1',featureClipSeconds:'0'});
  assert.deepEqual(influencerLaunchRequest(settings),{version:1,postToX:true,xAccountId:X1,cadenceHours:12,dailyPosts:6,coinLink:false,character:true,source:'tiles',tiles:{kind:'mascot',creature:'owl',outfit:'streetwear',style:'photoreal',palette:'pastel',setting:'studio',vibe:'confident'},referenceId:'',media:'video',dailyImages:1,dailyVideos:1,featureClipSeconds:0});
  assert.equal(text(p.$('launch-card-influencer')),'posts to @moonfox every 12 h, up to 6/day; character from tiles, pictures and clips');
  // The daily feature clip (v71.32) travels as its seconds and shows on the preview card.
  p.select('launch-influencer-feature-clip','15');await flush();
  const withFeature=influencerUiModule.influencerSettings(p.form);assert.equal(withFeature.featureClipSeconds,'15');
  const normalized=influencerLaunchRequest(withFeature);assert.equal(normalized.featureClipSeconds,15);
  assert.equal(text(p.$('launch-card-influencer')),'posts to @moonfox every 12 h, up to 6/day; character from tiles, pictures and clips, one 15-second feature clip a day');
  assert.equal(p.$('launch-open').disabled,false);
  await p.open();await until(()=>s.prepares.length===1,'the launch was not prepared');
  const body=s.prepares[0];assert.equal(body.feeMode,'agent');assert.deepEqual(body.agent.influencer,withFeature,'the raw settings travel inside agent');
  assert.deepEqual(Object.keys(body).filter(key=>/^influencer/i.test(key)),[],'influencerEnabled, influencerTile_*, influencerXAccountChoice and the rest never travel on their own');
  assert.deepEqual(agentLaunchRequest(body.agent).influencer,normalized,'the shared launch model normalizes the same object');
  // Off: the object says so and the model drops it.
  p.check('launch-influencer-enabled',false);await flush();
  assert.deepEqual(influencerUiModule.influencerSettings(p.form),{enabled:false});assert.equal('influencer' in agentLaunchRequest({...body.agent,influencer:{enabled:false}}),false);
});

test('daily feature clip (v71.32): the select shows with clips only, lists Off and the lengths the host offers with their prices, a host without video joining offers no 30 s, switching clips off sends 0, the costs line and the disclosure quote it, the pure check names an unavailable length',async t=>{
  const s=launchServer(),p=await launchPage({route:s.route});t.after(()=>p.controller.destroy());
  await p.meteora();await p.agent();p.check('launch-influencer-enabled');p.check('launch-influencer-character');await flush();
  const wrap=()=>p.$('launch-influencer-feature-clip').closest('label'),select=()=>p.$('launch-influencer-feature-clip');
  assert.equal(wrap().hidden,true,'pictures only: no feature clip');assert.equal(select().name,'influencerFeatureClipSeconds');
  p.pick('influencerMedia','video');await flush();
  assert.equal(wrap().hidden,false);assert.deepEqual([...select().options].map(option=>[option.value,text(option)]),[['0','Off'],['10','10 seconds · $1.31'],['15','15 seconds · $1.91'],['30','30 seconds · $3.76']]);assert.equal(select().value,'0','off by default');
  assert.match(text(wrap()),/One per UTC day on top of the 5-second clips/);assert.doesNotMatch(text(wrap()),/not available here/);
  assert.match(text(p.$('launch-influencer-costs')),/\$0\.01 per consistency check · one feature clip a day, when you turn it on: \$1\.31 for 10 seconds, \$1\.91 for 15 or \$3\.76 for 30, from the agent’s operating credit/);
  const bullet=[...p.document.querySelectorAll('#launch-agent-disclosure [data-influencer-disclosure]')][2];assert.match(text(bullet),/A daily feature clip, when you turn one on, costs \$1\.31 for 10 seconds, \$1\.91 for 15 or \$3\.76 for 30 and runs only when it fits the agent’s day budget \(at most 20% of the credit it started the day with\)/);
  p.select('launch-influencer-feature-clip','30');await flush();
  assert.equal(influencerUiModule.influencerSettings(p.form).featureClipSeconds,'30');assert.equal(p.$('launch-influencer-error').hidden,true);assert.equal(text(p.$('launch-card-influencer')),'character from tiles, pictures and clips, one 30-second feature clip a day');
  assert.equal(influencerLaunchRequest(influencerUiModule.influencerSettings(p.form)).featureClipSeconds,30);
  // Clips off again: the select hides and the settings say 0 while the choice is kept for when clips return.
  p.pick('influencerMedia','images');await flush();assert.equal(wrap().hidden,true);assert.equal(influencerUiModule.influencerSettings(p.form).featureClipSeconds,'0');assert.equal(p.$('launch-influencer-error').hidden,true);assert.equal(text(p.$('launch-card-influencer')),'character from tiles, pictures');
  p.pick('influencerMedia','video');await flush();assert.equal(select().value,'30');assert.equal(influencerUiModule.influencerSettings(p.form).featureClipSeconds,'30');
  p.check('launch-influencer-character',false);await flush();assert.equal(influencerUiModule.influencerSettings(p.form).featureClipSeconds,'0','no character: no feature clip');
  // A host that cannot join video offers 10 and 15 only and says why; the pure check refuses a length the host does not offer before the catalogue speaks.
  const q=await launchPage({route:launchServer({influencer:{open:true,xOpen:true,mediaOpen:true,featureClipLengths:[10,15]}}).route});t.after(()=>q.controller.destroy());
  await q.meteora();await q.agent();q.check('launch-influencer-enabled');q.check('launch-influencer-character');q.pick('influencerMedia','video');await flush();
  assert.deepEqual([...q.$('launch-influencer-feature-clip').options].map(option=>option.value),['0','10','15']);assert.match(text(q.$('launch-influencer-feature-clip').closest('label')),/30-second clip needs video joining on the host \(not available here\)/);
  assert.match(text(q.$('launch-influencer-costs')),/one feature clip a day, when you turn it on: \$1\.31 for 10 seconds or \$1\.91 for 15, from/);
  const catalog={influencer:{open:true,xOpen:true,mediaOpen:true,featureClipLengths:[10,15]}},base={enabled:true,character:true,media:'video',dailyImages:'1',dailyVideos:'1'};
  assert.equal(influencerUiModule.influencerProblem({...base,featureClipSeconds:'30'},{catalog}),'A 30-second daily feature clip is not available on this host. Choose 10 seconds or 15 seconds or Off.');
  assert.equal(influencerUiModule.influencerProblem({...base,featureClipSeconds:'15'},{catalog}),'');
  assert.equal(influencerUiModule.influencerProblem({...base,featureClipSeconds:'15'},{catalog:{influencer:{open:true,xOpen:true,mediaOpen:true}}}),'A 15-second daily feature clip is not available on this host. Choose Off.','a catalog from before the option offers no lengths');
  assert.equal(influencerUiModule.influencerProblem({...base,featureClipSeconds:'7'},{catalog}),'The daily feature clip must be off or 10, 15, 30 seconds.','a value outside the catalogue is the catalogue’s complaint');
  assert.equal(influencerUiModule.influencerProblem({...base,media:'images',featureClipSeconds:'30'},{catalog}),'A daily feature clip needs a character with pictures and clips enabled.','the raw object may still say so; the step itself sends 0 then');
  // A host that offers none (or an older catalog) hides the whole select; the catalog's lengths are read defensively.
  const none=await launchPage({route:launchServer({influencer:{open:true,xOpen:true,mediaOpen:true,featureClipLengths:'30'}}).route});t.after(()=>none.controller.destroy());
  await none.meteora();await none.agent();none.check('launch-influencer-enabled');none.check('launch-influencer-character');none.pick('influencerMedia','video');await flush();
  assert.deepEqual([...none.$('launch-influencer-feature-clip').options].map(option=>option.value),['0']);assert.match(text(none.$('launch-influencer-feature-clip').closest('label')),/Not available on this host\./);assert.doesNotMatch(text(none.$('launch-influencer-costs')),/feature clip/);
  assert.deepEqual(influencerUiModule.featureClipLengths({featureClipLengths:[15,'10',99,30.5,null]}),[10,15]);assert.deepEqual(influencerUiModule.featureClipLengths(null),[]);
  assert.deepEqual(influencerUiModule.influencerCosts(null).feature,{10:'$1.31',15:'$1.91',30:'$3.76'});assert.equal(influencerUiModule.featureClipLabel(0),'Off');assert.equal(influencerUiModule.featureClipLabel(15,influencerUiModule.influencerCosts(null)),'15 seconds · $1.91');
});

test('availability: a host without the option shows the block closed with the reason; a layer the host does not configure is locked with its reason; the readiness check and the venue input refuse what the host cannot do',async t=>{
  const closed=await launchPage({route:launchServer({influencer:{open:false,xOpen:false,mediaOpen:false}}).route});t.after(()=>closed.controller.destroy());
  await closed.meteora();await closed.agent();
  assert.equal(text(closed.$('launch-influencer-status')),'Not available on this host right now.');assert.equal(closed.$('launch-influencer-status').dataset.state,'closed');assert.equal(closed.$('launch-influencer-enabled').disabled,true);assert.equal(closed.$('launch-open').disabled,false,'the launch itself is not blocked');
  const none=await launchPage({route:launchServer({influencer:null}).route});t.after(()=>none.controller.destroy());
  await none.meteora();await none.agent();assert.equal(text(none.$('launch-influencer-status')),'Not available on this host right now.','an older catalog without the object counts as closed');assert.equal(none.$('launch-influencer-enabled').disabled,true);
  const xOnly=await launchPage({route:launchServer({influencer:{open:true,xOpen:true,mediaOpen:false}}).route});t.after(()=>xOnly.controller.destroy());
  await xOnly.meteora();await xOnly.agent();assert.equal(xOnly.$('launch-influencer-enabled').disabled,false);xOnly.check('launch-influencer-enabled');await flush();
  assert.equal(xOnly.$('launch-influencer-character').disabled,true);assert.equal(text(xOnly.$('launch-influencer-character').closest('label').querySelector('[data-influencer-reason]')),'Character generation is not configured on this host.');assert.equal(xOnly.$('launch-influencer-post').disabled,false);
  const mediaOnly=await launchPage({route:launchServer({influencer:{open:true,xOpen:false,mediaOpen:true}}).route});t.after(()=>mediaOnly.controller.destroy());
  await mediaOnly.connect();await mediaOnly.meteora();await mediaOnly.fill();await mediaOnly.agent();mediaOnly.check('launch-influencer-enabled');await flush();
  assert.equal(mediaOnly.$('launch-influencer-post').disabled,true);assert.equal(text(mediaOnly.$('launch-influencer-post').closest('label').querySelector('[data-influencer-reason]')),'Posting to X is not configured on this host.');
  mediaOnly.check('launch-influencer-character');await flush();assert.equal(mediaOnly.$('launch-open').disabled,false);
  // The pure check names the host before the catalogue, and the venue input refuses a settings object the host cannot serve.
  const catalog={influencer:{open:true,xOpen:false,mediaOpen:true}};
  assert.equal(influencerUiModule.influencerProblem({enabled:true,postToX:true,xAccountId:X1},{catalog}),'Posting to X is not available on this host. Switch Post to X off.');
  assert.equal(influencerUiModule.influencerProblem({enabled:true,character:true},{catalog:{influencer:{open:false}}}),'The AI influencer option is not available on this host right now. Switch it off to launch.');
  assert.equal(influencerUiModule.influencerProblem({enabled:true,character:true},{catalog:null}),'Wait for the AI influencer availability check.');
  assert.equal(influencerUiModule.influencerProblem({enabled:true,character:true,source:'reference'},{catalog,busy:true}),'Wait for the reference art upload to finish.');
  assert.equal(influencerUiModule.influencerProblem({enabled:false},{catalog:null}),'');assert.equal(influencerUiModule.influencerProblem({enabled:true,character:true},{catalog}),'');
  // Dry run is said plainly.
  const dry=await launchPage({route:launchServer({influencer:{open:true,xOpen:true,mediaOpen:true,dryRun:true}}).route});t.after(()=>dry.controller.destroy());
  await dry.meteora();await dry.agent();assert.match(text(dry.$('launch-influencer-status')),/^Dry-run mode: nothing is generated or posted/);
});

// ---- Docs and terms ---------------------------------------------------------------------------------------------
test('the docs describe the option (two layers, the X app and callback URL, labelling, the rate card, caps, the checks, revocation, dry run) and the fees note; the terms carry the clause',async()=>{
  const {document}=parseHTML(await readFile(new URL('../public/docs.html',import.meta.url),'utf8'));
  const section=document.getElementById('influencer');assert(section,'an #influencer section');assert.equal(text(section.querySelector('h2')),'AI influencer');
  assert.equal(document.querySelector('.documentation-jump a[href="#influencer"]')?.textContent,'AI influencer');
  const copy=text(section);
  for(const phrase of ['Post to X','Character','fictional','adult','no real people','developer','/api/launchpad/x/callback','automated','rate card','operating credit','$0.01','$0.65','$0.02','$0.20','12 posts','6 pictures','2 clips','consistency','minor','revoke','Dry run','financial advice','platform share'])assert.match(copy,new RegExp(escapeRegExp(phrase),'i'),phrase);
  const table=section.querySelector('.documentation-table');assert(table,'a costs table');assert.match(text(table),/picture/i);assert.match(text(table),/clip/i);assert.match(text(table),/post with the coin link/i);
  assert.doesNotMatch(copy,/guarantee|will (rise|pump|moon)/i,'no promised outcomes');
  assert.match(text(document.getElementById('revenue')),/influencer/i,'the revenue section notes that an influencer launch is an agent launch');
  const terms=parseHTML(await readFile(new URL('../public/terms.html',import.meta.url),'utf8')).document,clause=[...terms.querySelectorAll('p')].find(p=>/^AI influencer\./.test(text(p)));
  assert(clause,'the terms carry an AI influencer clause');const words=text(clause);
  for(const phrase of ['fictional','adult','real person','rights','X’s terms','label','pause','remove','financial advice','operating credit'])assert.match(words,new RegExp(escapeRegExp(phrase),'i'),phrase);
  assert.equal(clause.querySelector('a[href="/docs#influencer"]')!==null,true);
});
