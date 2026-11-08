// Transfer hook rules (v71.28) in the browser: the launch page's rule section (Meteora only, host-enabled; the
// catalogue's 25 rules in 7 groups with their routes), the three-approval dialog wording, the coin page's Rules card
// with the creator's allowlist manager and the read-only blocklist viewer, the Hooked chip on Explore and My Tokens,
// and the docs and terms.
import {optimizeLaunchImage} from '../public/launch-image.mjs';
import {createChainSelect,initialLaunchChain,launchChainById} from '../public/launch-chains.mjs';
import * as meteoraUiModule from '../public/meteora-ui.mjs';
import * as dammPumpUiModule from '../public/damm-pump-ui.mjs';
import * as pumpPublicUiModule from '../public/pump-public-ui.mjs';
import * as pumpUiModule from '../public/pump-launch-test-ui.mjs';
import * as pumpClassicUiModule from '../public/pump-classic-ui.mjs';
import * as hookUiModule from '../public/hook-ui.mjs';
import {PUMP_CLASSIC_MODES,PUMP_CLASSIC_STRATEGY_MODES,PUMP_CLASSIC_MODE_LABELS,PUMP_CLASSIC_MODE_SUMMARIES,PUMP_CLASSIC_LIMITS,PUMP_CLASSIC_FEE_LINK,PUMP_CLASSIC_SOL_ONLY_MODES,PUMP_CLASSIC_CONVERT_MODES,PUMP_CLASSIC_OPTION_MODES} from '../public/pump-classic-catalog.mjs';
import {PUMP_OPTIONS,pumpOptionRequest,describePumpOption} from '../public/pump-option-catalog.mjs';
import {AGENT_PERSONALITIES,AGENT_FUNDING_SUMMARY,AGENT_LIMITS,AGENT_OBJECTIVES,AGENT_OBJECTIVE_GROUPS,objectiveById,normalizeObjectiveSettings} from '../public/agent-catalog.mjs';
import {GOTCHI_THEMES,gotchiFundingSummary,gotchiTheme} from '../public/gotchi-catalog.mjs';
import {HOOK_GROUPS,HOOK_RULES,HOOK_MAX_RULES,HOOK_LIMITS,HOOK_NOT_OFFERED,HOOK_ROUTES,HOOK_TIMEZONES,WEEKDAYS,hookRuleById,hookRulesConflict,hookSettingApplies,hookLaunchRequest,describeHookRule,hookAppUnavailableText} from '../public/hook-catalog.mjs';
import {createQuoteIcon,createQuoteLabel} from '../public/quote-logos.mjs';
import {CREATOR_FEE_TIERS,creatorFeeForLaunch} from '../public/creator-fee-schedule.mjs';
import {createLaunchpadWallet} from '../public/launchpad-wallet.mjs';
import {launchInput,displayUnits,units,SOL_MINT,USDC_MINT,socialLink} from '../public/launchpad-model.mjs';
import {LAUNCH_ASSETS} from '../public/launch-assets.mjs';
import {createCoinPage} from '../public/coin-view.mjs';
import {createMeteoraOperation,meteoraLaunchNextAction,validMeteoraOperation,hookSetupStep,hookSetupTitle,hookBlocklistRange} from '../public/meteora-ui.mjs';
import {createExploreCard,exploreHookNames,exploreHookRoute,exploreCardVersion} from '../public/explore-view.mjs';
import {createMeteoraAccountLaunches} from '../public/meteora-account-ui.mjs';
import {coinImage} from '../public/coin-image.mjs';
import {createPersonalEarnings} from '../public/personal-earnings.mjs';
import {createHoldersView} from '../public/holders-view.mjs';
import {createLiveTradesView,updateTradeAges} from '../public/live-trades-view.mjs';
import {QUOTE_DISPLAY_ASSETS} from '../public/quote-display-assets.mjs';
import {creatorClaimState,runCreatorClaim} from '../public/creator-claims.mjs';
import {curveChartSnapshot} from '../public/launch-curve-chart.mjs';
import {createCoinRewardsView,validCoinRewards} from '../public/coin-rewards-view.mjs';
import {createCoinTrade} from '../public/coin-trade.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {parseHTML} from 'linkedom';

const ADDRESS='So11111111111111111111111111111111111111112';
const GATE='7rvRFpzP5W18yZcNpPNqtWgPTxLaFrnutz5QPxXpyupc',MINT='GNu1FSuype33KF4RXfow38Dw3ziw9e71FTBLVY5mdrTa',POOL='58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
const W1='HN22QWXBPb7dfmPhTjCf14jDco4dYzwDKeehWDXcnHEF',W2='7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS',W3='9sNtafymXt6ENpr8Z7zhxTMq752AMdkXLq8o6mGJAQ2u',W4='J8WRhbSjG3NbcfRWKmVY5fqnETZZfyUR1zrt5QmM9gQP';
const SIGN='solana:signTransaction',CHAIN='solana:mainnet';
const flush=()=>new Promise(resolve=>setTimeout(resolve,10));
const until=async(check,message)=>{for(let i=0;i<200;i++){if(check())return;await flush();}assert.fail(message);};
const text=(node)=>String(node?.textContent||'').replace(/\s+/g,' ').trim();
const escapeRegExp=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
/** The ids a rule cannot be combined with, in catalogue order (what the launch page must grey out when it is chosen). */
const conflictsOf=(...ids)=>HOOK_RULES.filter(rule=>!ids.includes(rule.id)&&ids.some(id=>hookRulesConflict(id,rule.id))).map(rule=>rule.id);
/** Deterministic base58-looking wallets (digits 1–9 only, so none falls outside the alphabet). */
const blockWallet=i=>'Bkw'+(1+Math.floor(i/9))+(1+i%9)+'x'.repeat(27);

// ---- Launch page ------------------------------------------------------------------------------------------------
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
// The status carries each named app's mark as the service views it (v71.36): { kind, key, index, text } or null.
const FOMO_MARK={kind:'signer',key:'FoMo1111111111111111111111111111111111111111',index:0,text:'FOMO: the wallet FoMo…1111 must sign the trade (FOMO’s co-signer).'},PUMP_APP_MARK={kind:'program-account',key:'PumpApp1111111111111111111111111111111111111',index:5,text:'Pump App: a top-level instruction of program Pump…1111 with its account 6 filled (a commission or referral slot) must be in the trade.'};
function launchServer({hooksEnabled=true,hookApps={fomo:FOMO_MARK,pumpApp:PUMP_APP_MARK}}={}){
  const state={prepares:[]};
  state.route=async(path,body)=>{
    if(path==='/api/session')return{authenticated:true,token:'public-csrf',features:{walletOnly:true},account:{id:'public-user',authType:'wallet',mainWallet:ADDRESS}};
    if(path==='/api/launchpad/agents/catalog')return{intakeOpen:true,models:[{id:'openai/gpt-6-luna',name:'Luna'}],defaultModel:'openai/gpt-6-luna',domainAllowlist:[]};
    if(path==='/api/launchpad/meteora/status')return{available:true,publicEnabled:true,...(hooksEnabled?{hooksEnabled:true,hookProgramId:W4,hookApps}:{})};
    if(path==='/api/launchpad/meteora/pairs')return{pairs};
    if(path==='/api/launchpad/meteora/operations')return{operations:[]};
    // A hooked launch starts with the curve configuration of a three-approval setup (review.stages === 3); a plain one with the coin creation.
    if(path==='/api/launchpad/meteora/prepare'){state.prepares.push(body);return{operation:{id:'meteora-operation-123',action:body.hook?'configure':'initialize',wallet:ADDRESS,mint:MINT,state:'awaiting_signature',transaction:'AQID',expiresAt:Date.now()+120000,review:{maxWalletDebitLamports:'20000000',firstBuyRaw:'0',quoteMint:SOL_MINT,quoteDecimals:9,quoteSymbol:'SOL',...(body.hook?{hook:body.hook,stage:'configure',stages:3}:{stage:'initialize',stages:2})}}};}
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
  const calls=[],intervals=new Map();
  const fetch=async(path,options={})=>{const body=options.body?JSON.parse(options.body):undefined;calls.push({path,body,method:options.method||'GET'});const data=await route?.(path,body);if(data)return{ok:data.ok!==false,status:data.status||200,json:async()=>data.body??data};return{ok:true,status:200,json:async()=>path.endsWith('/quotes')?{assets:LAUNCH_ASSETS.map(a=>({...a,supported:true})),canViewComingSoon:false}:path.endsWith('/image')?{imageId:'a'.repeat(64)+'.webp'}:{launches:[]}};};
  window.addEventListener('wallet-standard:app-ready',event=>event.detail.register(mock.wallet));
  const source=(await readFile(new URL('../public/launchpad.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace(/^export /gm,'').replace("await import('./pump-launch-test-ui.mjs')",'pumpUiModule').replace("await import('./pump-public-ui.mjs')",'pumpPublicUiModule').replace("await import('./meteora-ui.mjs')",'meteoraUiModule').replace("await import('./damm-pump-ui.mjs')",'dammPumpUiModule').replace("await import('./pump-classic-ui.mjs')",'pumpClassicUiModule').replace(/bootPage\('launchpad',mountPage\);/,'')+'\nconst pageController=mountPage({document,window:document.defaultView});await pageController.ready;return pageController;';
  const deps={createChainSelect,initialLaunchChain,launchChainById,optimizeLaunchImage,meteoraUiModule,dammPumpUiModule,pumpUiModule,pumpPublicUiModule,pumpClassicUiModule,PUMP_CLASSIC_MODES,PUMP_CLASSIC_STRATEGY_MODES,PUMP_CLASSIC_MODE_LABELS,PUMP_CLASSIC_MODE_SUMMARIES,PUMP_CLASSIC_LIMITS,PUMP_CLASSIC_FEE_LINK,PUMP_CLASSIC_SOL_ONLY_MODES,PUMP_CLASSIC_CONVERT_MODES,PUMP_CLASSIC_OPTION_MODES,PUMP_OPTIONS,pumpOptionRequest,describePumpOption,AGENT_PERSONALITIES,AGENT_FUNDING_SUMMARY,AGENT_LIMITS,AGENT_OBJECTIVES,AGENT_OBJECTIVE_GROUPS,objectiveById,normalizeObjectiveSettings,GOTCHI_THEMES,gotchiFundingSummary,gotchiTheme,HOOK_GROUPS,HOOK_RULES,HOOK_MAX_RULES,HOOK_LIMITS,HOOK_NOT_OFFERED,HOOK_ROUTES,HOOK_TIMEZONES,WEEKDAYS,hookRuleById,hookRulesConflict,hookSettingApplies,hookLaunchRequest,describeHookRule,hookAppUnavailableText,createQuoteIcon,createQuoteLabel,CREATOR_FEE_TIERS,creatorFeeForLaunch,document,fetch,FileReader,createImageBitmap:async()=>({width:8,height:8,close(){}}),crypto:{randomUUID},FormData,requestAnimationFrame:fn=>{setTimeout(fn,0);return 1;},setInterval:(fn,ms)=>{intervals.set(ms,fn);return ms;},clearInterval:()=>{},setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,10)),matchMedia:()=>({matches:true}),createWorkspaceShell:()=>{},launchInput,displayUnits,units,SOL_MINT,USDC_MINT,socialLink,LAUNCH_ASSETS,createLaunchpadWallet};
  const controller=await new (Object.getPrototypeOf(async()=>{}).constructor)(...Object.keys(deps),source)(...Object.values(deps));await flush();
  const $=id=>document.getElementById(id);
  const p={controller,document,window,form,$,calls,mock,intervals,
    venue:name=>document.querySelector('[data-launch-venue='+name+']'),
    // v71.37: the rule cards are folded behind "Add hooks"; the helper unfolds them so the tests below see the cards (the fold itself has its own test).
    async meteora({unfold=true}={}){document.querySelector('[data-launch-venue=meteora]').onclick();await flush();await flush();if(unfold&&!$('launch-hooks').hidden&&$('launch-hooks-toggle').getAttribute('aria-expanded')==='false'){$('launch-hooks-toggle').onclick();await flush();}},
    async hooks(){$('launch-hooks-toggle').onclick();await flush();},
    async raydium(){document.querySelector('[data-launch-venue=raydium]').onclick();await flush();await flush();},
    option(value){for(const radio of form.querySelectorAll('[name=feeMode]'))radio.checked=radio.value===value;form.dispatchEvent(new window.Event('change'));},
    card:id=>document.querySelector('.launch-hook-rule[data-rule="'+id+'"]'),
    group:id=>$('launch-hooks-settings').querySelector('.launch-hook-setting-group[data-rule="'+id+'"]'),
    rule(id,on=true){const input=p.card(id).querySelector('input');assert(input,id);assert.equal(input.disabled,false,id+' is disabled');input.checked=on;input.dispatchEvent(new window.Event('change',{bubbles:true}));},
    type(id,value){const input=$(id);assert(input,id);input.value=String(value);input.dispatchEvent(new window.Event('input',{bubbles:true}));},
    select(id,value){const select=$(id);assert(select,id);select.value=String(value);select.dispatchEvent(new window.Event('change',{bubbles:true}));},
    enforce:()=>[...$('launch-hooks-enforce-list').querySelectorAll('li[data-rule]')].map(row=>[row.dataset.rule,text(row.querySelector('span'))]),
    routeRow:()=>$('launch-hooks-enforce-list').querySelector('.launch-hooks-enforce-route'),
    disabled:()=>[...$('launch-hooks-groups').querySelectorAll('.launch-hook-rule')].filter(card=>card.querySelector('input').disabled).map(card=>card.dataset.rule),
    async image(){Object.defineProperty($('launch-image'),'files',{value:[{type:'image/png',size:30}],configurable:true});await $('launch-image').onchange();},
    async fill(){form.elements.namedItem('name').value='Example';form.elements.namedItem('symbol').value='EXAMPLE';await this.image();},
    async open(){$('launch-open').onclick();await flush();await flush();},
    async connect(){$('launch-connect').onclick();document.querySelector('#launch-wallet-options button').onclick();await flush();}};
  return p;
}

test('the Transfer hook rules section exists on Meteora only, when the host enables it, with the seven groups, 27 cards, their route badges and the not-offered list',async t=>{
  const off=await launchPage({route:launchServer({hooksEnabled:false}).route});t.after(()=>off.controller.destroy());
  await off.meteora();assert.equal(off.$('launch-hooks').hidden,true,'no hook program on the host: nothing is offered');assert.equal(off.$('launch-card-hooks-row').hidden,true);
  const p=await launchPage({route:launchServer().route});t.after(()=>p.controller.destroy());
  assert.equal(p.$('launch-hooks').hidden,true,'Raydium offers no transfer hook rules');
  await p.meteora();assert.equal(p.$('launch-hooks').hidden,false);assert.equal(p.$('launch-card-hooks-row').hidden,false);assert.equal(p.$('launch-card-hooks').textContent,'None');
  assert.equal(HOOK_RULES.length,27);assert.equal(HOOK_GROUPS.length,7);assert.equal(text(p.$('launch-hooks-hint')),'Optional · Meteora only · up to 4 of 27 rules');
  assert.match(p.$('launch-hooks-intro').textContent,/while it is on the curve/);assert.match(p.$('launch-hooks-intro').textContent,/every rule ends at graduation/);assert.match(p.$('launch-hooks-intro').textContent,/never takes a fee or moves tokens/);assert.match(p.$('launch-hooks-intro').textContent,/sealed by the first trade/);
  assert.equal(HOOK_RULES.filter(rule=>rule.route==='curve').length,4);assert.equal(HOOK_RULES.filter(rule=>rule.route==='app').length,2);assert.match(text(p.$('launch-hooks-routes')),/^21 rules are marked “Trades anywhere”: Trades through Meteora’s swap path/);assert.match(text(p.$('launch-hooks-routes')),/ 4 are marked “Launchpad route only”: Trades on Launchpad while it is on the curve/);assert.match(text(p.$('launch-hooks-routes')),/ 2 are marked “App only”: Trades only through the named app while it is on the curve/);
  assert.match(text(p.$('launch-hooks-enforce-note')),/“App only” rules \(FOMO-only, Pump App-only\) allow pool trades only when the transaction carries that app’s mark, so Launchpad’s own Buy and Sell are off for the coin until it graduates/);
  assert.deepEqual([...p.$('launch-hooks-groups').querySelectorAll('.launch-hook-group')].map(group=>[group.dataset.group,text(group.querySelector('h4')),group.querySelectorAll('.launch-hook-rule').length]),HOOK_GROUPS.map(group=>[group.id,group.name,HOOK_RULES.filter(rule=>rule.group===group.id).length]));
  const cards=[...p.$('launch-hooks-groups').querySelectorAll('.launch-hook-rule')];assert.equal(cards.length,27);
  assert.deepEqual(cards.map(card=>card.dataset.rule),HOOK_RULES.map(rule=>rule.id));
  for(const card of cards){const rule=hookRuleById(card.dataset.rule);assert.equal(text(card.querySelector('.launch-agent-choice-title')),rule.name);assert.equal(text(card.querySelector('.launch-agent-choice-text')),rule.summary);assert.equal(card.querySelector('input').type,'checkbox');assert.equal(card.querySelector('input').name,'hookRule');assert.equal(card.querySelector('input').value,rule.id);
    const badge=card.querySelector('.launch-hook-route');assert(badge,rule.id+' has a route badge');assert.equal(text(badge),HOOK_ROUTES[rule.route].name,rule.id);assert.equal(badge.getAttribute('title'),HOOK_ROUTES[rule.route].text);assert.equal(badge.dataset.route,rule.route);assert.equal(card.dataset.route,rule.route);assert.equal(badge.classList.contains('is-curve'),rule.route==='curve');assert.equal(badge.classList.contains('is-app'),rule.route==='app');}
  assert.deepEqual(cards.filter(card=>card.dataset.route==='curve').map(card=>card.dataset.rule),['allowlist','holder_gated','holder_vesting','tithe'],'the four Launchpad-route rules');
  assert.deepEqual(cards.filter(card=>card.dataset.route==='app').map(card=>[card.dataset.rule,text(card.querySelector('.launch-hook-route'))]),[['fomo_only','App only'],['pump_app_only','App only']],'the two app-only rules (v71.35)');
  assert.equal(cards.filter(card=>card.classList.contains('is-unavailable')).length,0,'both apps are named by this host');
  assert.equal(cards.filter(card=>[...card.querySelectorAll('.cv-pill')].some(chip=>/wallet record/i.test(chip.textContent))).length,0,'no wallet-record chip any more');
  assert.deepEqual([...p.$('launch-hooks-not-offered-list').querySelectorAll('dt')].map(text),HOOK_NOT_OFFERED.map(row=>row.name));
  assert.deepEqual([...p.$('launch-hooks-not-offered-list').querySelectorAll('dd')].map(text),HOOK_NOT_OFFERED.map(row=>row.why));
  assert.equal(p.$('launch-hooks-settings').hidden,true);assert.equal(p.$('launch-hooks-enforce').hidden,true);assert.match(p.$('launch-hooks-count').textContent,/No rules chosen/);
  // Leaving Meteora hides the section and drops the choice: the rules exist on that venue only.
  p.rule('venue_locked');await flush();assert.equal(p.$('launch-card-hooks').textContent,'1 rule · Venue-locked');
  await p.raydium();assert.equal(p.$('launch-hooks').hidden,true);assert.equal(p.card('venue_locked').querySelector('input').checked,false);
  await p.meteora();assert.equal(p.$('launch-card-hooks').textContent,'None');
});

test('the rule cards are folded behind “Add hooks” (v71.37): the Meteora form shows one line and a button until the creator asks; chosen rules are summarised on the fold, a problem opens it, and the request is unchanged',async t=>{
  const s=launchServer(),p=await launchPage({route:s.route});t.after(()=>p.controller.destroy());
  await p.meteora({unfold:false});
  const wrap=p.$('launch-hooks'),toggle=p.$('launch-hooks-toggle'),body=p.$('launch-hooks-body');
  assert.equal(wrap.hidden,false);assert.equal(wrap.classList.contains('is-collapsed'),true);assert.equal(body.hidden,true);assert.equal(toggle.textContent,'Add hooks');assert.equal(toggle.getAttribute('aria-expanded'),'false');
  assert.equal(p.document.querySelectorAll('.launch-hook-rule').length,0,'the 27 cards are not built until the fold opens');
  assert.equal(text(p.$('launch-hooks-count')),'No rules · a plain Meteora launch. Add rules the hook program enforces on every transfer while the coin is on the curve.');
  assert.equal(text(p.$('launch-hooks-hint')),'Optional · Meteora only · up to 4 of 27 rules');assert.equal(p.$('launch-card-hooks').textContent,'None');
  await p.hooks();
  assert.equal(wrap.classList.contains('is-collapsed'),false);assert.equal(body.hidden,false);assert.equal(toggle.textContent,'Hide rules');assert.equal(toggle.getAttribute('aria-expanded'),'true');
  assert.equal(p.document.querySelectorAll('.launch-hook-rule').length,HOOK_RULES.length);assert.equal(text(p.$('launch-hooks-count')),'No rules chosen · a plain Meteora launch.');
  p.rule('max_per_wallet');await flush();p.rule('anti_bundle');await flush();
  assert.equal(text(p.$('launch-hooks-count')),'2 of 4 rules chosen.');
  await p.hooks();
  assert.equal(body.hidden,true);assert.equal(toggle.textContent,'Edit rules');assert.equal(wrap.classList.contains('has-rules'),true);
  assert.equal(text(p.$('launch-hooks-count')),'2 of 4 rules chosen: Max per wallet, Anti-bundle.');assert.equal(p.$('launch-card-hooks').textContent,'2 rules · Max per wallet, Anti-bundle');
  // Folded rules still travel: the request carries both.
  await p.connect();await p.fill();await p.open();await until(()=>s.prepares.length===1,'the launch was not prepared');
  assert.deepEqual(s.prepares[0].hook,{rules:[{id:'max_per_wallet',settings:{maxPct:1}},{id:'anti_bundle',settings:{maxTradesPerBlock:3}}]});
  // A problem in a folded rule's settings opens the fold so the message is in view.
  await p.hooks();p.type('hook_max_per_wallet_maxPct','0');await flush();assert.equal(p.$('launch-hooks-error').hidden,false);
  await p.hooks();assert.equal(body.hidden,false,'a rule with a problem keeps the fold open');assert.equal(toggle.textContent,'Hide rules');
  p.type('hook_max_per_wallet_maxPct','1');await flush();assert.equal(p.$('launch-hooks-error').hidden,true);await p.hooks();assert.equal(body.hidden,true);
  // Rules on an AI Agent launch open the fold with the conflict notice, which sits outside the fold.
  p.option('agent');await flush();assert.equal(body.hidden,false);assert.equal(p.$('launch-hooks-agent').hidden,false);assert.equal(p.$('launch-hooks-agent').closest('#launch-hooks-body'),null);
});

test('rule cards: checkboxes up to four, the catalogue’s conflicts disable the other cards with the reason, the route follows the choice and the preview lists it',async t=>{
  const p=await launchPage({route:launchServer().route});t.after(()=>p.controller.destroy());
  await p.meteora();
  assert.deepEqual(p.disabled(),[]);
  p.rule('anti_dump');await flush();
  assert.deepEqual(p.disabled(),conflictsOf('anti_dump'),'exactly the catalogue’s conflict pairs');assert(p.disabled().includes('sliding_caps')&&p.disabled().includes('momentum')&&p.disabled().includes('trade_guard'));
  for(const id of p.disabled()){assert.equal(p.card(id).getAttribute('title'),'Cannot combine with Anti-dump caps',id);assert.equal(p.card(id).classList.contains('is-blocked'),true);assert.equal(text(p.card(id).querySelector('.launch-hook-rule-block')),'Cannot combine with Anti-dump caps');}
  assert.equal(p.card('max_per_wallet').getAttribute('title'),null);assert.equal(p.card('anti_dump').classList.contains('is-selected'),true);
  p.rule('max_per_wallet');await flush();
  assert.deepEqual(p.disabled(),conflictsOf('anti_dump','max_per_wallet'));
  assert.equal(p.card('rising_max_per_wallet').getAttribute('title'),'Cannot combine with Max per wallet');assert.equal(p.card('chapters').getAttribute('title'),'Cannot combine with Max per wallet');
  assert.equal(p.$('launch-card-hooks').textContent,'2 rules · Anti-dump caps, Max per wallet');assert.equal(text(p.$('launch-hooks-count')),'2 of 4 rules chosen.');
  // Two "Trades anywhere" rules: the enforce list opens with the route line.
  const route=p.routeRow();assert(route,'the enforce list has a route line');assert.equal(route.dataset.route,'any');assert.equal(text(route.querySelector('strong')),'Trades anywhere');assert.equal(text(route.querySelector('span')),HOOK_ROUTES.any.text);
  assert.deepEqual(p.enforce().map(([id])=>id),['anti_dump','max_per_wallet']);
  // A Launchpad-route rule turns the coin into a Launchpad-route coin: the count, the preview and the route line say so.
  p.rule('allowlist');await flush();
  assert.equal(text(p.$('launch-hooks-count')),'3 of 4 rules chosen. Launchpad route only until graduation.');assert.equal(p.$('launch-card-hooks').textContent,'3 rules · Allowlist, Anti-dump caps, Max per wallet · Launchpad route only');
  assert.equal(p.routeRow().dataset.route,'curve');assert.equal(text(p.routeRow().querySelector('strong')),'Launchpad route only');assert.match(text(p.routeRow().querySelector('span')),/^Trades on Launchpad only until graduation: Allowlist needs an account per wallet or a payment that only Launchpad adds to a trade/);assert.match(text(p.routeRow().querySelector('span')),/Trades anywhere after graduation\.$/);
  assert.deepEqual(p.disabled(),conflictsOf('allowlist','anti_dump','max_per_wallet'));assert.equal(p.card('blocklist').getAttribute('title'),'Cannot combine with Allowlist');
  p.rule('market_hours');await flush();
  assert.match(p.$('launch-hooks-count').textContent,/4 of 4 rules chosen · that is the most a coin can carry/);
  const open=[...p.$('launch-hooks-groups').querySelectorAll('.launch-hook-rule')].filter(card=>!card.querySelector('input').checked);
  assert(open.length===HOOK_RULES.length-4&&open.every(card=>card.querySelector('input').disabled),'every unchecked card is disabled at four rules');
  assert.equal(p.card('venue_locked').getAttribute('title'),'Up to '+HOOK_MAX_RULES+' rules');assert.equal(p.card('tithe').getAttribute('title'),'Up to 4 rules');
  assert.equal(p.$('launch-card-hooks').textContent,'4 rules · Allowlist, Anti-dump caps, Max per wallet, Market hours · Launchpad route only');
  p.rule('allowlist',false);await flush();
  assert.equal(p.card('venue_locked').querySelector('input').disabled,false);assert.equal(p.card('venue_locked').getAttribute('title'),null);assert.equal(p.card('sliding_caps').getAttribute('title'),'Cannot combine with Anti-dump caps');
  assert.equal(p.routeRow().dataset.route,'any');assert.equal(p.$('launch-card-hooks').textContent,'3 rules · Anti-dump caps, Max per wallet, Market hours');
  assert.deepEqual(p.enforce().map(([id])=>id),['anti_dump','max_per_wallet','market_hours'],'the enforce list follows the catalogue order');
});

test('app-only rules (v71.36): offered per app whose mark the host names in the status (hookApps), greyed out with the reason otherwise; choosing one makes an App-only coin whose preview says Launchpad’s Buy and Sell are off until graduation, and the request carries only the rule',async t=>{
  // Only FOMO named: the FOMO-only card can be chosen, the Pump App-only card cannot.
  const s=launchServer({hookApps:{fomo:FOMO_MARK,pumpApp:null}}),p=await launchPage({route:s.route});t.after(()=>p.controller.destroy());
  await p.connect();await p.meteora();await p.fill();
  assert.equal(p.card('pump_app_only').querySelector('input').disabled,true);assert.equal(p.card('pump_app_only').classList.contains('is-unavailable'),true);assert.equal(p.card('pump_app_only').classList.contains('is-blocked'),true);
  assert.equal(text(p.card('pump_app_only').querySelector('.launch-hook-rule-block')),'Pump App-only is not enabled on this host: the owner has not named the Pump App app’s mark.');assert.equal(p.card('pump_app_only').getAttribute('title'),'Pump App-only is not enabled on this host: the owner has not named the Pump App app’s mark.');
  assert.equal(p.card('fomo_only').querySelector('input').disabled,false);assert.equal(p.card('fomo_only').classList.contains('is-unavailable'),false);assert.equal(text(p.card('fomo_only').querySelector('.launch-agent-choice-text')),'While on the curve it trades only through the FOMO app.');
  assert.equal(text(p.card('fomo_only').querySelector('.launch-hook-route')),'App only');assert.equal(p.card('fomo_only').querySelector('.launch-hook-route').getAttribute('title'),HOOK_ROUTES.app.text);
  p.rule('fomo_only');await flush();
  assert.deepEqual(p.disabled().filter(id=>id!=='pump_app_only'),conflictsOf('fomo_only').filter(id=>id!=='pump_app_only'),'the catalogue’s app-only conflicts (venue rules, Launchpad-route rules) are greyed out');
  for(const id of ['venue_locked','dex_only','p2p_only','allowlist','holder_gated','holder_vesting','tithe'])assert.equal(p.card(id).getAttribute('title'),'Cannot combine with FOMO-only',id);
  assert.equal(p.card('pump_app_only').getAttribute('title'),'Pump App-only is not enabled on this host: the owner has not named the Pump App app’s mark.','the host reason wins over the conflict');
  assert.equal(text(p.$('launch-hooks-count')),'1 of 4 rule chosen. Trades only in FOMO until graduation.');assert.equal(p.$('launch-card-hooks').textContent,'1 rule · FOMO-only · FOMO only');
  assert.equal(p.routeRow().dataset.route,'app');assert.equal(text(p.routeRow().querySelector('strong')),'App only');
  assert.equal(text(p.routeRow().querySelector('span')),'Trades only in FOMO until graduation: FOMO-only allows pool trades only when the transaction carries the FOMO app’s mark (its co-signing wallet, or the swap it builds), so Launchpad’s Buy and Sell (and every other route) are off for this coin while it is on the curve. Holders trade it in FOMO; after graduation it trades anywhere, Launchpad included.');
  assert.deepEqual(p.enforce(),[['fomo_only','While on the curve, this coin trades only through the FOMO app; Launchpad’s Buy and Sell are off until it graduates. Sends always work.']]);
  assert.equal(p.$('launch-hooks-settings').hidden,true,'an app-only rule has no settings: the mark comes from the host');
  // It combines with a "Trades anywhere" cap; the preview keeps the app route.
  p.rule('max_per_wallet');await flush();assert.equal(p.routeRow().dataset.route,'app');assert.equal(p.$('launch-card-hooks').textContent,'2 rules · Max per wallet, FOMO-only · FOMO only');
  // The request carries the rule id only: no mark, no app field (the server freezes the mark it was configured with).
  await p.open();await until(()=>s.prepares.length===1,'the app-only launch was not prepared');
  const body=s.prepares[0];assert.equal(body.amountRaw,'0');assert.equal(p.$('launch-meteora-hook-note').hidden,false);assert.deepEqual(body.hook,{rules:[{id:'max_per_wallet',settings:{maxPct:1}},{id:'fomo_only',settings:{}}]});assert.equal('app' in body.hook,false);assert.equal('appMark' in body.hook,false);assert.equal('appProgram' in body.hook,false);
  const plan=hookLaunchRequest(body.hook);assert.equal(plan.route,'app');assert.equal(plan.app,'fomo');assert.equal(plan.appName,'FOMO');assert.equal(plan.needsSysvar,true);
  // No app named at all (an older host, or an owner who has not configured one): both cards are greyed out and nothing else changes.
  const none=launchServer({hookApps:null}),q=await launchPage({route:none.route});t.after(()=>q.controller.destroy());
  await q.meteora();assert.equal(q.card('fomo_only').querySelector('input').disabled,true);assert.equal(q.card('pump_app_only').querySelector('input').disabled,true);assert.equal(q.card('max_per_wallet').querySelector('input').disabled,false);
  assert.equal(text(q.card('fomo_only').querySelector('.launch-hook-rule-block')),'FOMO-only is not enabled on this host: the owner has not named the FOMO app’s mark.');
});

test('settings: sliders with exact fields, segmented options with the catalogue’s labels, rows that apply by level or mode, and the live enforce list; invalid numbers block the launch',async t=>{
  const p=await launchPage({route:launchServer().route});t.after(()=>p.controller.destroy());
  await p.connect();await p.meteora();await p.fill();await flush();assert.equal(p.$('launch-open').disabled,false);
  p.rule('anti_dump');await flush();
  const group=p.group('anti_dump');assert(group);assert.equal(p.$('launch-hooks-settings').hidden,false);
  assert.equal(text(group.querySelector('.launch-hook-setting-head strong')),'Anti-dump caps');assert.equal(text(group.querySelector('.launch-hook-setting-rule')),hookRuleById('anti_dump').rule);assert.equal(text(group.querySelector('.launch-hook-setting-head .launch-hook-route')),'Trades anywhere');
  assert.equal(p.$('hook_anti_dump_maxSellPct').value,'0.25');assert.equal(p.$('hook_anti_dump_maxSellPct').type,'number');assert.equal(p.$('hook_anti_dump_maxSellPct_range').type,'range');assert.equal(p.$('hook_anti_dump_maxSellPct').step,'0.05');
  assert.equal(text(group.querySelector('.launch-hook-setting[data-setting=maxSellPct] .launch-agent-setting-range')),'0.1–2 % of supply');assert.equal(text(group.querySelector('.launch-hook-setting[data-setting=maxBuyPct] .launch-agent-setting-range')),'0–5 % of supply · 0 = no buy cap');
  assert.deepEqual(p.enforce(),[['anti_dump',describeHookRule('anti_dump',{})]]);assert.equal(p.enforce()[0][1],'No buy above 2% of supply; no sell or send above 0.25% of supply.');
  p.type('hook_anti_dump_maxSellPct','0.5');await flush();
  assert.equal(p.enforce()[0][1],'No buy above 2% of supply; no sell or send above 0.5% of supply.');assert.equal(p.$('hook_anti_dump_maxSellPct_range').value,'0.5');
  // Out of range: the catalogue's message, the field marked invalid, Create coin blocked and the checklist pointing at the rules.
  p.type('hook_anti_dump_maxSellPct','5');await flush();
  assert.equal(p.$('launch-hooks-error').hidden,false);assert.equal(text(p.$('launch-hooks-error')),'Anti-dump caps: Max per sell must be between 0.1 and 2 % of supply.');
  assert.equal(p.$('hook_anti_dump_maxSellPct').getAttribute('aria-invalid'),'true');assert.equal(p.$('launch-open').disabled,true);assert.match(p.$('launch-ready-text').textContent,/fix the transfer hook rules/);
  assert.equal(p.enforce()[0][1],'Anti-dump caps: Max per sell must be between 0.1 and 2 % of supply.');assert.equal(p.$('launch-hooks-enforce-list').querySelector('li[data-rule]').classList.contains('is-invalid'),true);
  p.type('hook_anti_dump_maxSellPct','0.3');await flush();
  assert.equal(p.$('launch-hooks-error').hidden,true);assert.equal(p.$('hook_anti_dump_maxSellPct').getAttribute('aria-invalid'),'false');assert.equal(p.$('launch-open').disabled,false);
  // Sliding caps (a sell cap too, so Anti-dump goes first): the Levels segmented control shows and hides the breakpoint rows.
  p.rule('anti_dump',false);await flush();p.rule('sliding_caps');await flush();
  const sliding=p.group('sliding_caps'),levels=[...sliding.querySelectorAll('.launch-hook-setting[data-setting=levels] .cv-segmented button')];
  assert.deepEqual(levels.map(text),['1','2','3','4','5']);assert.equal(p.$('hook_sliding_caps_levels').type,'hidden');assert.equal(p.$('hook_sliding_caps_levels').value,'3');
  const visible=()=>[...sliding.querySelectorAll('.launch-hook-setting')].filter(row=>!row.hidden).map(row=>row.dataset.setting);
  assert.deepEqual(visible(),['levels','buy0','sell0','at1','buy1','sell1','at2','buy2','sell2'],'three levels: breakpoints 1 and 2');
  assert.equal(sliding.querySelector('.launch-hook-setting[data-setting=at3]').dataset.when,'4');
  assert.equal(p.enforce().find(([id])=>id==='sliding_caps')[1],describeHookRule('sliding_caps',{levels:3}));
  levels[4].click();await flush();assert.equal(p.$('hook_sliding_caps_levels').value,'5');assert.deepEqual(visible().slice(-3),['at4','buy4','sell4']);assert.equal(visible().length,15);assert.match(p.enforce().find(([id])=>id==='sliding_caps')[1],/from 90% of the way to graduation buys up to 20%, sells up to 10%\.$/);
  levels[0].click();await flush();assert.deepEqual(visible(),['levels','buy0','sell0']);assert.equal(p.enforce().find(([id])=>id==='sliding_caps')[1],'At launch buys up to 2%, sells up to 1% of supply.');
  levels[2].click();await flush();p.type('hook_sliding_caps_at2','20');await flush();
  assert.equal(text(p.$('launch-hooks-error')),'Sliding caps: each breakpoint must be above the one before it.');assert.equal(p.$('launch-open').disabled,true);
  p.type('hook_sliding_caps_at2','60');await flush();assert.equal(p.$('launch-hooks-error').hidden,true);
  // Rising max per wallet: the mode's labels, and the step row only in Fixed step mode.
  p.rule('rising_max_per_wallet');await flush();
  const rising=p.group('rising_max_per_wallet'),modes=[...rising.querySelectorAll('.launch-hook-setting[data-setting=mode] .cv-segmented button')];
  assert.deepEqual(modes.map(text),['Fixed step','Doubles']);assert.deepEqual(modes.map(button=>button.getAttribute('aria-pressed')),['true','false']);assert.equal(p.$('hook_rising_max_per_wallet_mode').value,'0');
  assert.equal(rising.querySelector('.launch-hook-setting[data-setting=stepPct]').hidden,false);assert.equal(rising.querySelector('.launch-hook-setting[data-setting=stepPct]').dataset.when,'mode:0');
  assert.match(p.enforce().find(([id])=>id==='rising_max_per_wallet')[1],/rises by 0\.1% every 5 min\.$/);
  modes[1].click();await flush();assert.equal(p.$('hook_rising_max_per_wallet_mode').value,'1');assert.equal(rising.querySelector('.launch-hook-setting[data-setting=stepPct]').hidden,true);assert.match(p.enforce().find(([id])=>id==='rising_max_per_wallet')[1],/doubles every 5 min\.$/);
  // Market hours: two labelled segmented controls, no numbers.
  p.rule('market_hours');await flush();
  const hours=p.group('market_hours');assert.deepEqual([...hours.querySelectorAll('.cv-segmented button')].map(text),['Buys and sells closed','Sells stay open','Closed on holidays','Ignore holidays']);
  assert.equal(p.enforce().find(([id])=>id==='market_hours')[1],'Pool trades only Monday to Friday 9:30–16:00 New York time, closed on NYSE holidays.');
  [...hours.querySelectorAll('.cv-segmented button')][1].click();await flush();assert.match(p.enforce().find(([id])=>id==='market_hours')[1],/; sells stay open after hours\.$/);
  assert.deepEqual(p.enforce().map(([id])=>id),['sliding_caps','rising_max_per_wallet','market_hours'],'the settings and the enforce list follow the catalogue order');
  assert.deepEqual([...p.$('launch-hooks-settings').children].map(child=>child.dataset.rule),['sliding_caps','rising_max_per_wallet','market_hours']);
});

test('special inputs: hh:mm and time-zone pickers with weekday chips, the gate token mint, the blocklist with its live count and the tithe recipient',async t=>{
  const p=await launchPage({route:launchServer().route});t.after(()=>p.controller.destroy());
  await p.connect();await p.meteora();await p.fill();await flush();
  // Trading hours: opens / closes as hh:mm selects (5-minute steps, 24:00 only for the close), the day chips and one time-zone select writing the hidden offset and rule.
  p.rule('trading_hours');await flush();
  const hours=p.group('trading_hours'),opens=p.$('hook_trading_hours_openMinute'),closes=p.$('hook_trading_hours_closeMinute');
  assert.equal(opens.tagName,'SELECT');assert.equal(opens.name,'hook_trading_hours_openMinute');assert.equal(opens.value,'540');assert.equal(closes.value,'1020');
  assert.equal(opens.options.length,288);assert.equal(closes.options.length,288);assert.deepEqual([opens.options[0].textContent,opens.options[1].textContent,opens.options[opens.options.length-1].textContent],['00:00','00:05','23:55']);assert.deepEqual([closes.options[0].textContent,closes.options[closes.options.length-1].textContent,closes.options[closes.options.length-1].value],['00:05','24:00','1440']);
  assert.equal([...opens.options].find(o=>o.selected).textContent,'09:00');assert.equal([...closes.options].find(o=>o.selected).textContent,'17:00');
  const days=[...hours.querySelectorAll('.launch-hook-days button')];assert.deepEqual(days.map(text),[...WEEKDAYS]);assert.equal(p.$('hook_trading_hours_weekdays').type,'hidden');assert.equal(p.$('hook_trading_hours_weekdays').value,'31');
  assert.deepEqual(days.map(button=>button.getAttribute('aria-pressed')),['true','true','true','true','true','false','false']);
  const zone=p.$('launch-hook-trading-timezone');assert(zone,'the time-zone select');assert.equal(zone.name,'hookTradingTimezone');assert.equal(zone.options.length,HOOK_TIMEZONES.length);assert.deepEqual([...zone.options].map(o=>o.value),HOOK_TIMEZONES.map(z=>z.id));assert.equal(zone.value,'UTC');
  assert.equal(text([...zone.options].find(o=>o.value==='America/New_York')),'New York (Eastern) (UTC−05:00, US daylight saving)');assert.equal(text([...zone.options].find(o=>o.value==='Europe/Berlin')),'Berlin, Paris, Madrid (UTC+01:00, EU daylight saving)');
  assert.equal(p.$('hook_trading_hours_tzOffset').type,'hidden');assert.equal(p.$('hook_trading_hours_tzOffset').value,'0');assert.equal(p.$('hook_trading_hours_dst').type,'hidden');assert.equal(p.$('hook_trading_hours_dst').value,'0');
  assert.equal(hours.querySelector('.launch-hook-setting[data-setting=tzOffset]'),null,'the raw offset has no row of its own');assert.equal(hours.querySelector('.launch-hook-setting[data-setting=dst]'),null);
  assert.deepEqual(p.enforce(),[['trading_hours','Pool trades only 09:00–17:00 UTC on Mon, Tue, Wed, Thu, Fri.']]);
  p.select('launch-hook-trading-timezone','America/New_York');await flush();
  assert.equal(p.$('hook_trading_hours_tzOffset').value,'-300');assert.equal(p.$('hook_trading_hours_dst').value,'1');assert.deepEqual(p.enforce(),[['trading_hours','Pool trades only 09:00–17:00 New York (Eastern) on Mon, Tue, Wed, Thu, Fri.']]);
  days[5].click();await flush();assert.equal(p.$('hook_trading_hours_weekdays').value,'63');assert.match(p.enforce()[0][1],/Fri, Sat\.$/);
  for(const index of [0,1,2,3,4,5])days[index].click();await flush();
  assert.equal(p.$('hook_trading_hours_weekdays').value,'0');assert.equal(text(p.$('launch-hooks-error')),'Trading hours: choose at least one day.');assert.equal(p.$('launch-open').disabled,true);
  days[6].click();await flush();assert.equal(p.$('hook_trading_hours_weekdays').value,'64');assert.equal(p.$('launch-hooks-error').hidden,true);assert.match(p.enforce()[0][1],/on Sun\.$/);
  p.select('hook_trading_hours_openMinute','1320');p.select('hook_trading_hours_closeMinute','120');await flush();
  assert.equal(p.enforce()[0][1],'Pool trades only 22:00–02:00 New York (Eastern) on Sun (past midnight).');assert.equal(p.$('launch-open').disabled,false,'a window past midnight is allowed');
  p.select('hook_trading_hours_closeMinute','1440');p.select('hook_trading_hours_openMinute','0');await flush();assert.equal(p.enforce()[0][1],describeHookRule('trading_hours',{openMinute:0,closeMinute:1440,weekdays:64,tzOffset:-300,dst:1}),'an all-day window reads as the catalogue describes it');assert.doesNotMatch(p.enforce()[0][1],/past midnight/);assert.equal(p.$('launch-hooks-error').hidden,true);
  assert.deepEqual([...hours.querySelectorAll('.launch-hook-setting[data-setting=afterHours] .cv-segmented button')].map(text),['Buys and sells closed','Sells stay open']);
  // Holder-gated: the gate token mint with base58 validation; its amount is an exact field (no slider over fifteen orders of magnitude).
  p.rule('holder_gated');await flush();
  const gated=p.group('holder_gated');assert(gated);assert.equal(p.$('launch-hooks-settings').firstElementChild,gated,'settings follow the catalogue order');assert.equal(text(gated.querySelector('.launch-hook-setting-head .launch-hook-route')),'Launchpad route only');
  assert.equal(p.$('launch-hook-gate-mint').name,'hookGateMint');assert.equal(text(p.$('launch-hooks-error')),'Holder-gated: enter the gate token’s mint address.');assert.equal(p.$('launch-open').disabled,true);
  assert.equal(p.$('hook_holder_gated_minAmount').value,'1');assert.equal(p.$('hook_holder_gated_minAmount_range'),null);assert.equal(gated.querySelector('.launch-agent-setting-field').classList.contains('is-exact'),true);
  p.type('launch-hook-gate-mint','not-a-mint');await flush();assert.equal(text(p.$('launch-hooks-error')),'Holder-gated: enter the gate token’s mint address.');assert.equal(p.$('launch-hook-gate-mint').getAttribute('aria-invalid'),'true');
  p.type('launch-hook-gate-mint',GATE);await flush();assert.equal(p.$('launch-hooks-error').hidden,true);assert.equal(p.$('launch-open').disabled,false);assert.equal(p.$('launch-hook-gate-mint').getAttribute('aria-invalid'),'false');
  assert.deepEqual(p.enforce()[0],['holder_gated','Receiving wallets must hold at least 1 of the gate token.']);assert.equal(p.routeRow().dataset.route,'curve');
  // Blocklist (cannot be combined with Holder-gated): the textarea, one address per line or comma-separated, with the live "n of 200".
  p.rule('holder_gated',false);await flush();assert.equal(p.card('blocklist').querySelector('input').disabled,false);p.rule('blocklist');await flush();
  const block=p.group('blocklist'),textarea=p.$('launch-hook-blocklist');assert(block);assert.equal(textarea.tagName,'TEXTAREA');assert.equal(textarea.name,'hookBlocklist');
  assert.equal(text(p.$('launch-hook-blocklist-count')),'0 of 200');assert.equal(text(p.$('launch-hooks-error')),'Blocklist: enter at least one wallet address.');assert.equal(p.$('launch-open').disabled,true);
  assert.match(text(block.querySelector('.launch-hook-setting-note')),/sealed by the first trade/);
  p.type('launch-hook-blocklist',W1+', '+W2+'\n'+W1+'\nnot-a-wallet\n');await flush();
  assert.equal(text(p.$('launch-hook-blocklist-count')),'2 of 200 · 1 line is not a wallet address');assert.equal(text(p.$('launch-hooks-error')),'Blocklist: “not-a-wallet…” is not a wallet address.');assert.equal(textarea.getAttribute('aria-invalid'),'true');
  p.type('launch-hook-blocklist',W1+', '+W2+'\n'+W1+'\n');await flush();
  assert.equal(text(p.$('launch-hook-blocklist-count')),'2 of 200');assert.equal(p.$('launch-hooks-error').hidden,true);assert.equal(p.$('launch-open').disabled,false);assert.equal(textarea.getAttribute('aria-invalid'),'false');
  assert.deepEqual(p.enforce()[0],['blocklist','Wallets on the blocklist, sealed at launch, can never receive this coin.']);assert.equal(p.routeRow().dataset.route,'any');
  // Tithe: the recipient wallet and the donation; a Launchpad-route rule.
  p.rule('tithe');await flush();
  const tithe=p.group('tithe'),recipient=p.$('launch-hook-tithe-recipient');assert(tithe);assert.equal(recipient.name,'hookTitheRecipient');assert.equal(text(p.$('launch-hooks-error')),'Tithe: enter the recipient’s wallet address.');
  assert.equal(p.$('hook_tithe_donationSol').value,'0.005');assert.equal(text(tithe.querySelector('.launch-agent-setting-range')),'0.001–0.5 SOL');
  p.type('launch-hook-tithe-recipient',W3);await flush();assert.equal(p.$('launch-hooks-error').hidden,true);
  assert.equal(p.enforce().at(-1)[1],'Every pool trade pays at least 0.005 SOL to the tithe recipient.');assert.equal(p.routeRow().dataset.route,'curve');assert.match(text(p.routeRow().querySelector('span')),/^Trades on Launchpad only until graduation: Tithe needs /);
  assert.equal(p.$('launch-card-hooks').textContent,'3 rules · Blocklist, Trading hours, Tithe · Launchpad route only');
});

test('the Meteora request carries one `hook` object only when rules are chosen, with the blocklist and the tithe recipient; the first buy is hidden and the raw fields never travel',async t=>{
  // No rule: a plain launch with the typed first buy and no `hook` key at all.
  const plain=launchServer(),a=await launchPage({route:plain.route});t.after(()=>a.controller.destroy());
  await a.connect();await a.meteora();await a.fill();a.$('launch-meteora-buy').value='0.5';await a.open();await until(()=>plain.prepares.length===1,'the plain launch was not prepared');
  assert.equal('hook' in plain.prepares[0],false);assert.equal(plain.prepares[0].amountRaw,'500000000');assert.equal(a.$('launch-meteora-buy').disabled,false);assert.equal(a.$('launch-meteora-hook-note').hidden,true);
  // Three rules with typed numbers: one `hook` object, no first buy, nothing else hook-related in the body.
  const s=launchServer(),p=await launchPage({route:s.route});t.after(()=>p.controller.destroy());
  await p.connect();await p.meteora();await p.fill();
  p.rule('holder_gated');p.rule('sliding_caps');p.rule('trading_hours');await flush();
  p.type('launch-hook-gate-mint',' '+GATE+' ');p.type('hook_sliding_caps_buy1','4');p.select('launch-hook-trading-timezone','America/New_York');[...p.group('trading_hours').querySelectorAll('.launch-hook-days button')][5].click();await flush();
  assert.equal(p.$('launch-card-buy').textContent,'After launch');assert.equal(p.$('launch-meteora-buy').disabled,true);assert.equal(p.$('launch-meteora-buy-field').hidden,true,'the first-buy field is hidden, not just disabled');assert.equal(p.$('launch-meteora-hook-note').hidden,false);assert.match(p.$('launch-meteora-hook-note').textContent,/separate trade after launch/);assert.match(p.$('launch-meteora-hook-note').textContent,/three approvals/);assert.match(p.$('launch-meteora-hook-note').textContent,/batches of up to 28 wallets/);
  const track=p.$('launch-meteora-dialog').querySelector('.launch-flow-track');assert.equal(track.classList.contains('is-hooked'),true);assert.deepEqual([...track.querySelectorAll('[data-flow-step]')].filter(step=>!step.hidden).map(step=>step.dataset.flowStep),['setup','hooks','create','live'],'a hooked launch shows the Hook setup approval step');
  assert.equal(a.$('launch-meteora-buy-field').hidden,false);assert.deepEqual([...a.$('launch-meteora-dialog').querySelectorAll('[data-flow-step]')].filter(step=>!step.hidden).map(step=>step.dataset.flowStep),['setup','create','live']);
  p.$('launch-meteora-buy').value='0.5';await p.open();await until(()=>s.prepares.length===1,'the hooked launch was not prepared');
  const body=s.prepares[0];
  assert.deepEqual(body.hook,{rules:[{id:'holder_gated',settings:{minAmount:1}},{id:'sliding_caps',settings:{levels:3,buy0:2,sell0:1,at1:25,buy1:4,sell1:1.5,at2:60,buy2:5,sell2:2}},{id:'trading_hours',settings:{openMinute:540,closeMinute:1020,weekdays:63,tzOffset:-300,dst:1,afterHours:0}}],gateMint:GATE});
  const plan=hookLaunchRequest(body.hook);assert.equal(plan.rules.length,3,'the server validates the same object with the shared catalogue');assert.equal(plan.route,'curve');
  assert.equal(body.amountRaw,'0','a hooked coin has no first buy in its creation, whatever the field holds');assert.equal(body.action,'initialize');assert.equal(body.feeMode,'creator');
  assert.deepEqual(Object.keys(body).filter(key=>/^hook/i.test(key)),['hook'],'hookRule, hook_<rule>_<key>, hookGateMint, hookBlocklist, hookTitheRecipient and hookTradingTimezone never travel on their own');
  assert.match(p.$('launch-meteora-note').textContent,/your first buy follows as a separate trade/);assert.equal(p.$('launch-meteora-buy').disabled,true);
  assert.equal(track.classList.contains('is-hooked'),true,'the prepared three-stage setup keeps the Hook setup step');assert.equal(track.querySelector('[aria-current=step]').dataset.flowStep,'setup');assert.equal(track.dataset.state,'approve');
  // A blocklist and a tithe: the addresses travel as `blocklist` (deduplicated) and `titheRecipient`.
  const paid=launchServer(),q=await launchPage({route:paid.route});t.after(()=>q.controller.destroy());
  await q.connect();await q.meteora();await q.fill();q.rule('blocklist');q.rule('tithe');await flush();
  q.type('launch-hook-blocklist',W1+', '+W2+'\n'+W1+'\n');q.type('launch-hook-tithe-recipient',' '+W3+' ');await flush();await q.open();await until(()=>paid.prepares.length===1,'the blocklist launch was not prepared');
  assert.deepEqual(paid.prepares[0].hook,{rules:[{id:'blocklist',settings:{}},{id:'tithe',settings:{donationSol:0.005}}],blocklist:[W1,W2],titheRecipient:W3});
  assert.deepEqual(hookLaunchRequest(paid.prepares[0].hook).blocklist,[W1,W2]);assert.equal(hookLaunchRequest(paid.prepares[0].hook).titheRecipient,W3);
  // The `hook` object is validated before anything is prepared: an invalid number blocks Create coin and stops at the dialog with the message.
  const bad=launchServer(),b=await launchPage({route:bad.route});t.after(()=>b.controller.destroy());
  await b.connect();await b.meteora();await b.fill();b.rule('anti_dump');await flush();b.type('hook_anti_dump_maxSellPct','0');await flush();
  assert.equal(b.$('launch-open').disabled,true);b.$('launch-open').disabled=false;await b.open();await flush();
  assert.equal(bad.prepares.length,0);assert.match(b.$('launch-meteora-note').textContent,/Anti-dump caps: Max per sell must be between 0.1 and 2/);
});

test('AI Agent and transfer hook rules are mutually exclusive, with the reason shown and the launch blocked',async t=>{
  const p=await launchPage({route:launchServer().route});t.after(()=>p.controller.destroy());
  await p.connect();await p.meteora();await p.fill();await flush();
  p.rule('ping_pong');await flush();assert.equal(p.$('launch-hooks-agent').hidden,true);assert.equal(p.$('launch-open').disabled,false);
  p.option('agent');await flush();await flush();
  assert.equal(p.$('launch-hooks-agent').hidden,false);assert.match(p.$('launch-hooks-agent').textContent,/An AI Agent launch cannot carry transfer hook rules/);assert.match(p.$('launch-hooks-agent').textContent,/Choose the agent or the rules/);
  assert.equal(p.$('launch-open').disabled,true);assert.match(p.$('launch-ready-text').textContent,/choose the AI Agent or the transfer hook rules/);
  p.option('creator');await flush();assert.equal(p.$('launch-hooks-agent').hidden,true);assert.equal(p.$('launch-open').disabled,false);
  p.rule('ping_pong',false);p.option('agent');await flush();await flush();assert.equal(p.$('launch-hooks-agent').hidden,true,'without a rule the agent launch is not blocked by the hook section');
  assert.doesNotMatch(p.$('launch-ready-text').textContent,/transfer hook/);
});

// ---- Coin page --------------------------------------------------------------------------------------------------
const NOW=1700000100000;
const RULES={allowlist:{id:'allowlist',name:'Allowlist',text:'Only wallets on the creator’s allowlist can receive this coin.'},holder_gated:{id:'holder_gated',name:'Holder-gated',text:'Receiving wallets must hold at least 1000 of the gate token.'},anti_dump:{id:'anti_dump',name:'Anti-dump caps',text:'No buy above 2% of supply; no sell or send above 0.25% of supply.'},blocklist:{id:'blocklist',name:'Blocklist',text:'Wallets on the blocklist, sealed at launch, can never receive this coin.'},max_per_wallet:{id:'max_per_wallet',name:'Max per wallet',text:'No wallet can hold more than 2% of the supply.'},tithe:{id:'tithe',name:'Tithe',text:'Every pool trade pays at least 0.005 SOL to the tithe recipient.'}};
const hookedCoin=(patch={},hook={})=>({mint:MINT,name:'Velvet Rope',symbol:'ROPE',description:'Members only.',chain:'solana',createdAt:NOW,quote:{mint:SOL_MINT,symbol:'SOL'},stage:'new',curveStatus:'curve',curve:POOL,platform:'meteora',feeMode:'creator',taxBps:0,marketCapUsd:null,fdvUsd:22900,priceUsd:.0000229,progressPercent:12,marketSource:'Meteora onchain',creator:{username:'mira_builds',bio:'',avatar:null},
  hook:{rules:[RULES.allowlist,RULES.holder_gated,RULES.anti_dump],route:'curve',gateMint:GATE,titheRecipient:null,blocklistCount:null,active:true,ended:false,...hook},...patch});
const nativeSnapshot=()=>({mint:MINT,curve:POOL,status:'curve',at:NOW,slot:12,priceQuote:.00000015,fdvQuote:150,supply:1e9,raisedQuote:10,targetQuote:85,progressPercent:12,quote:{mint:SOL_MINT,symbol:'SOL',stale:false},priceUsd:.0000229,fdvUsd:22900,stale:false,points:[{time:1700000100,priceQuote:.00000015}]});
function coinWallet({address=W4}={}){const calls={sign:[],connect:0};return {calls,factory:()=>({state:()=>({address,wallets:[{id:'test',name:'Test wallet'}]}),onChange:()=>()=>{},async connect(){calls.connect++;},async sign(input){calls.sign.push(input);return 'c2lnbmVk';}})};}
async function coinPage(t,{coin=hookedCoin(),respond,wallet=coinWallet()}={}){
  const {document}=parseHTML(await readFile(new URL('../public/coin.html',import.meta.url),'utf8'));
  Object.defineProperty(document,'hidden',{value:false,writable:true});
  const calls=[],copied=[],events=new Map();let now=NOW;
  const window={location:{search:'?mint='+encodeURIComponent(coin.mint)},setTimeout,clearTimeout,Event:document.defaultView.Event,CustomEvent:document.defaultView.CustomEvent,dispatchEvent:()=>true,navigator:{clipboard:{writeText:async value=>copied.push(value)}},addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name)};
  const fetcher=async(path,options={})=>{const body=options.body?JSON.parse(options.body):undefined;calls.push({path,body,method:options.method||'GET',headers:options.headers||{}});let value=await respond?.(path,body,options);if(value===undefined)value=path.startsWith('/api/explore/token?')?{coin}:path.startsWith('/api/explore/market?')?{coin,native:nativeSnapshot(),pool:null,at:now,refreshMs:15000}:{};const status=typeof value.status==='number'?value.status:200;return {status,ok:status<400,json:async()=>status<400?value:value.body};};
  const app=createCoinPage({document,window,fetcher,clock:()=>now,shell:()=>{},setTimer:()=>1,clearTimer:()=>{},chartFactory:async root=>({root,set(){},remove(){}}),hookFactory:async()=>hookUiModule,walletFactory:wallet.factory});t.after(()=>app.destroy());
  await app.ready;await flush();await flush();
  return {document,app,calls,copied,wallet,get:id=>document.getElementById(id),card:()=>document.getElementById('coin-hook'),async tick(ms){now+=ms;await app.tick();await flush();}};
}
const creatorSession={authenticated:true,token:'csrf-1',account:{id:'acct-mira',username:'mira_builds',mainWallet:W4}};

test('the coin page shows a Rules card for a hooked coin: the state and route pills, one row per rule with the Launchpad-route chips, the gate token with copy, and the route sentence',async t=>{
  const ui=await coinPage(t);
  const card=ui.card();assert(card,'the Rules card is mounted');assert.equal(card.hidden,false);assert.equal(card.getAttribute('aria-label'),'Transfer hook rules');assert.equal(card.previousElementSibling.id,'coin-creator-earnings','it sits between creator earnings and the coin facts');
  assert.equal(text(card.querySelector('h2')),'Rules');assert.equal(text(card.querySelector('.hook-pill')),'Active on the curve');assert.equal(card.querySelector('.hook-pill').classList.contains('is-active'),true);assert.equal(card.dataset.hookState,'active');
  const route=card.querySelector('.hook-route-pill');assert(route,'the route pill');assert.equal(text(route),'Launchpad route only');assert.equal(route.classList.contains('is-curve'),true);assert.equal(route.dataset.route,'curve');assert.equal(card.dataset.route,'curve');assert.match(route.getAttribute('title'),/^Trades on Launchpad only until graduation/);
  assert.deepEqual([...card.querySelectorAll('.hook-rule')].map(row=>[row.dataset.rule,row.dataset.route,text(row.querySelector('strong')).replace(/\s*Launchpad route$/,''),text(row.querySelector('.hook-rule-text'))]),[['allowlist','curve','Allowlist',RULES.allowlist.text],['holder_gated','curve','Holder-gated',RULES.holder_gated.text],['anti_dump','any','Anti-dump caps',RULES.anti_dump.text]]);
  assert.deepEqual([...card.querySelectorAll('.hook-rule')].map(row=>text(row.querySelector('.hook-rule-chip'))),['Launchpad route','Launchpad route',''],'only the Launchpad-route rules carry the chip');
  const gate=card.querySelector('.hook-gate-mint');assert(gate);assert.equal(text(gate.querySelector('code')),GATE.slice(0,6)+'…'+GATE.slice(-6));assert.equal(gate.querySelector('code').getAttribute('title'),GATE);assert.equal(gate.querySelector('a').href,'https://solscan.io/token/'+GATE);
  await gate.querySelector('button').onclick();await flush();assert.deepEqual(ui.copied,[GATE]);assert.equal(text(gate.querySelector('button')),'Copied ✓');
  assert.equal(card.querySelector('.hook-tithe'),null,'no tithe recipient without the Tithe rule');
  const fine=text(card.querySelector('.hook-fine'));assert.match(fine,/The swap that completes the curve removes the hook, so every rule ends at graduation/);assert.match(fine,/Trades on Launchpad only until graduation: its rules need accounts or a payment that only Launchpad adds to a trade/);assert.match(fine,/never takes a fee or moves tokens/);
  assert.equal(card.querySelector('.hook-allowlist'),null,'anonymous visitors see no allowlist manager');assert.equal(ui.calls.some(call=>call.path.includes('hook-allowlist')),false);
  assert.equal(card.querySelector('.hook-blocklist'),null,'no blocklist viewer without the Blocklist rule');assert.equal(ui.calls.some(call=>call.path.includes('hook-blocklist')),false);
  // Nothing about the supply: hooked coins are created with a fixed supply like every Launchpad coin.
  assert.equal(card.querySelector('.hook-supply-pill'),null);assert.equal(card.querySelector('.hook-freeze'),null);assert.equal(hookUiModule.createHookFreezeControl,undefined);assert.equal(hookUiModule.hookSupplyState,undefined);
  // Market refreshes keep the card as it is.
  await ui.tick(16000);assert.equal(ui.card(),card);assert.equal(card.querySelectorAll('.hook-rule').length,3);
  // A "Trades anywhere" coin, with the route derived from the catalogue when the row does not say, and a tithe recipient.
  const any=await coinPage(t,{coin:hookedCoin({},{rules:[RULES.anti_dump,RULES.max_per_wallet],route:undefined,gateMint:null})});
  assert.equal(text(any.card().querySelector('.hook-route-pill')),'Trades anywhere');assert.equal(any.card().querySelector('.hook-route-pill').classList.contains('is-any'),true);assert.equal(any.card().dataset.route,'any');assert.equal(any.card().querySelectorAll('.hook-rule-chip').length,0);assert.match(text(any.card().querySelector('.hook-fine')),/Trades anywhere: Trades through Meteora’s swap path/);
  const paid=await coinPage(t,{coin:hookedCoin({},{rules:[RULES.tithe,RULES.anti_dump],route:undefined,gateMint:null,titheRecipient:W3})});
  assert.equal(paid.card().dataset.route,'curve','Tithe is a Launchpad-route rule');const tithe=paid.card().querySelector('.hook-tithe');assert(tithe,'the tithe recipient row');assert.equal(text(tithe.querySelector('span')),'Tithe recipient');assert.equal(tithe.querySelector('code').getAttribute('title'),W3);assert.equal(tithe.querySelector('a').href,'https://solscan.io/account/'+W3);
  await tithe.querySelector('button').onclick();await flush();assert.deepEqual(paid.copied,[W3]);
  // Legacy supply fields on a row change nothing.
  const legacy=await coinPage(t,{coin:hookedCoin({},{supplyFrozen:false,mintAuthority:'held',mintAuthorityHolder:'curve-managed'})});legacy.app.setSession(creatorSession);await flush();await flush();
  assert.equal(legacy.card().querySelector('.hook-supply-pill'),null);assert.equal(legacy.card().querySelector('.hook-freeze'),null);assert.equal(legacy.calls.some(call=>call.body?.action==='hook-freeze-mint'),false);
});

test('an App-only coin (v71.35): the Rules card names the app in its route pill, chip and sentence; the trade box turns Buy and Sell off with the explanation (the server’s sentence when the row carries it) and the Review button says where it trades; graduation brings them back',async t=>{
  const FOMO={id:'fomo_only',name:'FOMO-only',text:'While on the curve, this coin trades only through the FOMO app; Launchpad’s Buy and Sell are off until it graduates. Sends always work.'};
  const note='Launchpad’s Buy and Sell are off for this coin while it is on the curve: its FOMO-only rule allows pool trades only through the FOMO app. Trade it in FOMO; after graduation it trades anywhere, Launchpad included.';
  const ui=await coinPage(t,{coin:hookedCoin({},{rules:[RULES.max_per_wallet,FOMO],route:'app',app:'fomo',appName:'FOMO',curveTrading:false,tradeNote:note,gateMint:null})});
  const card=ui.card();assert.equal(card.dataset.route,'app');
  const route=card.querySelector('.hook-route-pill');assert.equal(text(route),'FOMO only');assert.equal(route.classList.contains('is-app'),true);assert.equal(route.dataset.route,'app');assert.match(route.getAttribute('title'),/^Trades only in FOMO until graduation: its rule allows pool trades only when FOMO’s program is in the transaction/);
  assert.deepEqual([...card.querySelectorAll('.hook-rule')].map(row=>[row.dataset.rule,row.dataset.route,text(row.querySelector('.hook-rule-chip'))]),[['max_per_wallet','any',''],['fomo_only','app','FOMO only']]);
  assert.equal(card.querySelector('.hook-rule[data-rule=fomo_only] .hook-rule-chip').getAttribute('title'),HOOK_ROUTES.app.text);
  const fine=[...card.querySelectorAll('.hook-fine')].map(text);assert.match(fine[0],/Trades only in FOMO until graduation/);assert.equal(fine[1],note,'the trade-lock sentence sits on the card too');
  // The trade box: the lock note where the form would be, Buy/Sell/Review disabled, the Review button naming the app, no form even when signed in with a wallet.
  const trade=ui.get('coin-trade');assert.equal(trade.dataset.tradeLock,'app');
  const lock=trade.querySelector('[data-mt-lock]');assert.equal(lock.hidden,false);assert.equal(text(lock),note);
  for(const name of ['buy','sell'])assert.equal(trade.querySelector('[data-mt-'+name+']').disabled,true,name);
  const review=trade.querySelector('[data-mt-review]');assert.equal(review.disabled,true);assert.equal(text(review),'Trades in FOMO only');assert.equal(review.getAttribute('title'),note);
  ui.app.setSession(creatorSession);await flush();await flush();
  assert.equal(trade.querySelector('[data-mt-form]').hidden,true,'no amount field for a locked coin');assert.equal(trade.querySelector('[data-mt-connect]').disabled,false,'the wallet can still be connected (for sends elsewhere, and for graduation)');
  assert.equal(ui.calls.some(call=>call.path.includes('/meteora/prepare')),false);
  // Without the server sentence the catalogue's own is used; a row that only names the rule still locks (the route is derived).
  const bare=await coinPage(t,{coin:hookedCoin({},{rules:[FOMO],route:undefined,gateMint:null,curveTrading:undefined,tradeNote:undefined})});
  assert.equal(bare.get('coin-trade').dataset.tradeLock,'app');assert.equal(text(bare.get('coin-trade').querySelector('[data-mt-lock]')),note);assert.equal(text(bare.card().querySelector('.hook-route-pill')),'FOMO only');
  const pump=await coinPage(t,{coin:hookedCoin({},{rules:[{id:'pump_app_only',name:'Pump App-only',text:'x'}],route:'app',app:'pumpApp',appName:'Pump App',curveTrading:false,tradeNote:null,gateMint:null})});
  assert.equal(text(pump.get('coin-trade').querySelector('[data-mt-review]')),'Trades in Pump App only');assert.match(text(pump.get('coin-trade').querySelector('[data-mt-lock]')),/^Launchpad’s Buy and Sell are off for this coin while it is on the curve: its Pump App-only rule allows pool trades only through the Pump App app\. Trade it in Pump App;/);
  // Graduated: the rules ended, the lock is gone and the box trades again; the pill says it traded only in FOMO while on the curve.
  const done=await coinPage(t,{coin:hookedCoin({stage:'graduated',curveStatus:'migrated'},{rules:[FOMO],route:'app',app:'fomo',appName:'FOMO',curveTrading:true,tradeNote:null,active:false,ended:true,gateMint:null})});
  assert.equal(done.get('coin-trade').dataset.tradeLock,'');assert.equal(done.get('coin-trade').querySelector('[data-mt-lock]').hidden,true);assert.equal(done.get('coin-trade').querySelector('[data-mt-buy]').disabled,false);assert.equal(text(done.get('coin-trade').querySelector('[data-mt-review]')),'Connect wallet');
  assert.equal(text(done.card().querySelector('.hook-route-pill')),'FOMO only');assert.match(done.card().querySelector('.hook-route-pill').getAttribute('title'),/^Traded only in FOMO while it was on the curve; now it trades anywhere, Launchpad included\./);assert.equal(done.card().querySelector('.hook-trade-lock'),null);
  // The shared helpers.
  assert.equal(hookUiModule.hookRoute({rules:[FOMO]}),'app');assert.equal(hookUiModule.hookAppName({rules:[FOMO]}),'FOMO');assert.equal(hookUiModule.hookCurveTrading({hook:{rules:[FOMO],route:'app'}}),false);assert.equal(hookUiModule.hookCurveTrading({hook:{rules:[FOMO],route:'app',ended:true}}),true);assert.equal(hookUiModule.hookCurveTrading({hook:{rules:[RULES.tithe],route:'curve'}}),true);assert.equal(hookUiModule.hookTradeLockText({hook:{rules:[FOMO],route:'app'}}),note);
  const chip=hookUiModule.createHookChip(ui.document,{rules:[FOMO],route:'app',appName:'FOMO'});assert.equal(chip.dataset.route,'app');assert.equal(text(chip.querySelector('.hook-chip-route')),'FOMO only');assert.equal(chip.getAttribute('title'),'Transfer hook rules: FOMO-only · FOMO only');
});

test('the creator manages the allowlist from the coin page: current wallets, add and remove, one prepared hook-allow transaction, then approval',async t=>{
  let allowlist=[W1,W2];const operations=[];
  const ui=await coinPage(t,{respond:(path,body)=>{
    if(path.startsWith('/api/launchpad/meteora/hook-allowlist?'))return {mint:MINT,hooked:true,hasAllowlist:true,active:true,ended:false,wallets:allowlist.slice(),source:allowlist.length===2?'chain':'curve',recorded:NOW};
    if(path==='/api/launchpad/meteora/operations')return {operations:[]};
    if(path==='/api/launchpad/meteora/prepare'){const operation={id:'hook-allow-1234',action:'hook-allow',wallet:body.expectedWallet,mint:body.mint,state:'awaiting_signature',transaction:'AQID',expiresAt:NOW+120000,review:{add:body.add,remove:body.remove,maxWalletDebitLamports:'1007240',quoteMint:SOL_MINT,quoteDecimals:9}};operations.push(operation);return {operation};}
    if(path==='/api/launchpad/meteora/submit'){allowlist=[W1,W3];return {operation:{...operations.at(-1),state:'confirmed',signature:'5'.repeat(88),transaction:undefined}};}
    return undefined;
  }});
  assert.equal(ui.card().querySelector('.hook-allowlist'),null);
  ui.app.setSession(creatorSession);await flush();await flush();
  const manager=ui.card().querySelector('.hook-allowlist');assert(manager,'the signed-in creator gets the allowlist manager');
  const read=ui.calls.find(call=>call.path.startsWith('/api/launchpad/meteora/hook-allowlist?'));assert(read);assert.equal(new URL(read.path,'https://app.local').searchParams.get('mint'),MINT);assert.equal(read.method,'GET');assert.equal(read.headers['x-control-token'],'csrf-1');
  assert.equal(text(manager.querySelector('.hook-allowlist-title')),'Allowlist');assert.equal(text(manager.querySelector('.hook-allowlist-count')),'2 wallets');
  assert.equal(manager.querySelector('.hook-allowlist-source').hidden,false);assert.match(text(manager.querySelector('.hook-allowlist-source')),/^Read from chain · \d/,'the read names its source and time');
  assert.deepEqual([...manager.querySelectorAll('.hook-allowlist-item')].map(item=>[item.dataset.wallet,text(item.querySelector('code')),text(item.querySelector('button'))]),[[W1,W1.slice(0,6)+'…'+W1.slice(-6),'Remove'],[W2,W2.slice(0,6)+'…'+W2.slice(-6),'Remove']]);
  const prepare=manager.querySelector('.hook-allowlist-prepare'),textarea=manager.querySelector('textarea');
  assert.equal(text(prepare),'Prepare transaction');assert.equal(prepare.disabled,true,'nothing to change yet');
  textarea.value=W3+'\n'+W1+'\nnot-a-wallet\n';textarea.oninput();
  assert.equal(text(manager.querySelector('.hook-allowlist-summary')),'1 to add · 1 line is not a wallet address');assert.equal(prepare.disabled,true);
  textarea.value=W3+'\n'+W1+'\n';textarea.oninput();assert.equal(text(manager.querySelector('.hook-allowlist-summary')),'1 to add');assert.equal(prepare.disabled,false);
  manager.querySelectorAll('.hook-allowlist-item')[1].querySelector('button').onclick();
  assert.equal(text(manager.querySelector('.hook-allowlist-summary')),'1 to add · 1 to remove');assert.equal(manager.querySelectorAll('.hook-allowlist-item')[1].classList.contains('is-removed'),true);assert.equal(text(manager.querySelectorAll('.hook-allowlist-item')[1].querySelector('button')),'Undo');
  await prepare.onclick();await flush();await flush();
  const prepared=ui.calls.find(call=>call.path==='/api/launchpad/meteora/prepare');assert(prepared,'the change is prepared through the Meteora flow');
  assert.deepEqual(prepared.body,{action:'hook-allow',mint:MINT,add:[W3],remove:[W2],expectedWallet:W4});assert.equal(prepared.headers['x-control-token'],'csrf-1');
  assert.equal(ui.wallet.calls.sign.length,0,'preparing never opens the wallet');
  const facts=[...manager.querySelectorAll('.meteora-operation-facts div')].map(row=>[text(row.querySelector('dt')),text(row.querySelector('dd'))]);
  assert.deepEqual(facts,[['Wallets added','1'],['Wallets removed','1'],['Maximum SOL debit','0.00100724 SOL']]);
  const approve=[...manager.querySelectorAll('.meteora-operation-actions button')].find(button=>text(button)==='Approve allowlist change');assert(approve);assert.equal(approve.hidden,false);assert.equal(approve.disabled,false);
  assert.equal(text(prepare),'Transaction prepared');assert.equal(prepare.disabled,true);assert.equal(textarea.disabled,true);assert.match(text(manager.querySelector('.hook-allowlist-status')),/Review the change below/);
  assert.equal(ui.app.canLeave(),false,'an unsigned transaction keeps the page');
  await approve.onclick();await flush();await flush();
  assert.equal(ui.wallet.calls.sign.length,1);assert.equal(ui.wallet.calls.sign[0].kind,'curve-hook-hook-allow');assert.equal(ui.wallet.calls.sign[0].operationId,'hook-allow-1234');
  const submitted=ui.calls.find(call=>call.path==='/api/launchpad/meteora/submit');assert.deepEqual(submitted.body,{operationId:'hook-allow-1234',signedTransaction:'c2lnbmVk'});
  await until(()=>ui.calls.filter(call=>call.path.startsWith('/api/launchpad/meteora/hook-allowlist?')).length===2,'the list is read again once the change confirms');await flush();
  assert.equal(textarea.value,'');assert.deepEqual([...manager.querySelectorAll('.hook-allowlist-item')].map(item=>item.dataset.wallet),[W1,W3]);
  assert.match(text(manager.querySelector('.meteora-operation-status')),/Allowlist change confirmed/);
  allowlist=[W1,W3,W4];manager.querySelector('.hook-allowlist-refresh').onclick();await flush();await flush();
  assert.equal(text(manager.querySelector('.hook-allowlist-source')).startsWith('Recorded by Launchpad (chain read unavailable)'),true,'a read that fell back to Launchpad’s record says so');
});

test('no manager without the Allowlist rule, for another account or once the rules ended at graduation; unhooked coins get no card',async t=>{
  const ended=await coinPage(t,{coin:hookedCoin({stage:'graduated',curveStatus:'migrated'},{active:false,ended:true})});
  ended.app.setSession(creatorSession);await flush();
  assert.equal(text(ended.card().querySelector('.hook-pill')),'Ended at graduation');assert.equal(ended.card().querySelector('.hook-pill').classList.contains('is-ended'),true);assert.equal(ended.card().dataset.hookState,'ended');
  assert.match(text(ended.card().querySelector('.hook-fine')),/ended when the coin graduated: the swap that completed the curve removed the hook/);assert.match(text(ended.card().querySelector('.hook-fine')),/Traded on Launchpad only while it was on the curve; now it trades anywhere/);assert.equal(ended.card().querySelector('.hook-allowlist'),null);
  assert.equal(text(ended.card().querySelector('.hook-route-pill')),'Launchpad route only');assert.match(ended.card().querySelector('.hook-route-pill').getAttribute('title'),/^Traded on Launchpad only while it was on the curve/);
  const other=await coinPage(t);other.app.setSession({authenticated:true,token:'csrf-2',account:{id:'acct-else',username:'someone_else'}});await flush();
  assert.equal(other.card().querySelector('.hook-allowlist'),null);assert.equal(other.calls.some(call=>call.path.includes('hook-allowlist')),false);
  const capsOnly=await coinPage(t,{coin:hookedCoin({},{rules:[RULES.max_per_wallet],route:'any',gateMint:null})});
  capsOnly.app.setSession(creatorSession);await flush();assert.equal(capsOnly.card().querySelector('.hook-allowlist'),null);assert.equal(capsOnly.card().querySelector('.hook-gate-mint'),null);assert.equal(capsOnly.card().querySelectorAll('.hook-rule').length,1);
  const plain=await coinPage(t,{coin:hookedCoin({hook:undefined})});assert.equal(plain.card(),null,'no hook, no card, no module');
  const malformed=await coinPage(t,{coin:hookedCoin({hook:{rules:'nope'}})});assert.equal(malformed.card(),null);
});

test('the blocklist viewer: a coin with the Blocklist rule lists its sealed wallets for everyone, read once, with Show all; a failed read offers a retry',async t=>{
  const wallets=Array.from({length:44},(_,i)=>blockWallet(i));let fail=false,reads=0;
  const respond=path=>{if(path.startsWith('/api/launchpad/meteora/hook-blocklist?')){reads++;return fail?{status:503,body:{error:'The chain could not be read.'}}:{mint:MINT,wallets,count:44,source:'chain',recorded:NOW};}return undefined;};
  const ui=await coinPage(t,{coin:hookedCoin({},{rules:[RULES.blocklist,RULES.max_per_wallet],route:'any',gateMint:null,blocklistCount:44}),respond});
  await until(()=>ui.card()?.querySelector('.hook-blocklist-item'),'the blocklist was not read');
  const viewer=ui.card().querySelector('.hook-blocklist');assert(viewer,'anonymous visitors see the blocklist');
  const read=ui.calls.find(call=>call.path.startsWith('/api/launchpad/meteora/hook-blocklist?'));assert.equal(read.method,'GET');assert.equal(new URL(read.path,'https://app.local').searchParams.get('mint'),MINT);
  assert.equal(text(viewer.querySelector('.hook-allowlist-title')),'Blocklist');assert.equal(text(viewer.querySelector('.hook-blocklist-count')),'44 wallets');assert.match(text(viewer.querySelector('.hook-allowlist-intro')),/sealed by the first trade: nobody can add or remove a wallet/);
  assert.equal(viewer.querySelectorAll('.hook-blocklist-item').length,8,'the first eight, then Show all');assert.deepEqual([...viewer.querySelectorAll('.hook-blocklist-item')].slice(0,2).map(item=>[item.dataset.wallet,text(item.querySelector('code'))]),[[wallets[0],wallets[0].slice(0,6)+'…'+wallets[0].slice(-6)],[wallets[1],wallets[1].slice(0,6)+'…'+wallets[1].slice(-6)]]);
  assert.equal(viewer.querySelector('button.hook-allowlist-remove'),null,'nothing to remove: the list is sealed');
  const toggle=viewer.querySelector('.hook-blocklist-toggle');assert.equal(toggle.hidden,false);assert.equal(text(toggle),'Show all 44');toggle.onclick();
  assert.equal(viewer.querySelectorAll('.hook-blocklist-item').length,44);assert.equal(text(toggle),'Show fewer');assert.equal(toggle.getAttribute('aria-expanded'),'true');
  assert.match(text(viewer.querySelector('.hook-allowlist-source')),/^Read from chain · \d/);
  assert.equal(ui.card().querySelector('.hook-allowlist'),null);assert.equal(ui.card().querySelector('.hook-route-pill').textContent,'Trades anywhere');
  // Market refreshes do not read the list again; the creator sees the same viewer (and no manager without the Allowlist rule).
  await ui.tick(16000);assert.equal(reads,1);ui.app.setSession(creatorSession);await flush();await flush();assert.equal(reads,1);assert.equal(ui.card().querySelector('.hook-blocklist'),viewer);assert.equal(ui.card().querySelector('.hook-allowlist'),null);
  // A failed read: the row's count still shows, the error is announced and Try again reads once more.
  fail=true;const broken=await coinPage(t,{coin:hookedCoin({},{rules:[RULES.blocklist],route:'any',gateMint:null,blocklistCount:44}),respond});
  await until(()=>broken.card()?.querySelector('.hook-blocklist-retry')&&!broken.card().querySelector('.hook-blocklist-retry').hidden,'the failed read was not reported');
  const failed=broken.card().querySelector('.hook-blocklist');assert.equal(text(failed.querySelector('.hook-blocklist-count')),'44 wallets','the row’s count');assert.equal(text(failed.querySelector('.hook-blocklist-status')),'The chain could not be read.');assert.equal(text(failed.querySelector('.hook-allowlist-empty')),'The blocklist could not be read.');
  fail=false;failed.querySelector('.hook-blocklist-retry').onclick();await until(()=>failed.querySelectorAll('.hook-blocklist-item').length===8,'the retry did not read the list');assert.equal(failed.querySelector('.hook-blocklist-retry').hidden,true);
});

test('three approvals for a hooked launch: the dialog wording follows review.stage and the setup continues configure → hook setup → initialize',async()=>{
  const op=(overrides={})=>({id:'operation-1',action:'configure',wallet:W4,mint:MINT,state:'finalized',expiresAt:NOW+120000,transaction:'AQID',review:{maxWalletDebitLamports:'20000000',firstBuyRaw:'0',quoteMint:SOL_MINT,quoteSymbol:'SOL',quoteDecimals:9,stage:'configure',stages:3},...overrides});
  assert.equal(meteoraLaunchNextAction(op()),'initialize','the continuation request is always initialize: the server picks the stage (the first build asked for configure, which the server refuses)');assert.equal(meteoraLaunchNextAction(op({review:{...op().review,stage:'hook-setup'}})),'initialize');assert.equal(meteoraLaunchNextAction(op({review:{...op().review,stage:'configure',stages:2}})),'initialize');assert.equal(meteoraLaunchNextAction(op({state:'awaiting_signature'})),null);
  assert.equal(validMeteoraOperation({...op({state:'awaiting_signature'}),action:'hook-freeze-mint'},{wallet:W4,now:NOW}),false,'the supply freeze action no longer exists');
  const {document}=parseHTML('<div id="root"></div>'),root=document.getElementById('root'),calls=[];let holdInitialize=null;
  const hookSetup=op({id:'hook-setup-op',state:'awaiting_signature',review:{...op().review,stage:'hook-setup',maxWalletDebitLamports:'3100000',hook:{rules:[{id:'anti_dump'},{id:'market_hours'}]}}}),initialize=op({id:'initialize-op',action:'initialize',state:'awaiting_signature',review:{...op().review,stage:'initialize'}});
  const controller=createMeteoraOperation({document,root,wallet:{state:()=>({address:W4}),sign:async pending=>{calls.push(['sign',pending]);return 'signed';}},clock:()=>NOW,launchFlow:true,getLaunchInput:()=>({action:'initialize'}),context:()=>({active:true,key:'k'}),request:async(path,body)=>{calls.push([path,body]);
    // The real server accepts only initialize/buy/sell/claim/hook-allow: every continuation is `initialize`, and the server answers
    // with the stage chain state calls for (first the hook setup, a configure-kind bundle; after it, the coin creation).
    if(path==='/prepare'&&body.action!=='initialize')throw Error('Choose a launch, buy, sell, creator fee claim or allowlist change.');
    if(path==='/prepare'&&!calls.some(([p,b])=>p==='/submit'&&b.operationId==='hook-setup-op'))return {operation:hookSetup};
    if(path==='/submit'&&body.operationId==='hook-setup-op')return {operation:{...hookSetup,state:'finalized',transaction:undefined}};
    if(path==='/prepare'){await new Promise(resolve=>{holdInitialize=resolve;});return {operation:initialize};}
    if(path==='/submit'&&body.operationId==='initialize-op')return {operation:{...initialize,state:'finalized',transaction:undefined}};
    return {operation:op()};}});
  const button=label=>[...root.querySelectorAll('button')].find(b=>text(b)===label);
  // After the curve configuration: the saved setup announces the second approval.
  assert(controller.restore(op()));assert.match(text(root),/Your launch configuration is ready\. Next: the transfer hook setup approval \(2 of 3\)\./);assert.equal(button('Continue launch').disabled,false);
  const continuing=button('Continue launch').onclick();await flush();await flush();
  assert.deepEqual(calls.filter(([path])=>path==='/prepare').map(([,body])=>body.action),['initialize','initialize'],'both continuations ask the server to resume (initialize); the server returned the hook setup first, then the coin creation');assert.deepEqual(calls.filter(([path])=>path==='/submit').map(([,body])=>body.operationId),['hook-setup-op'],'the hook setup is signed and submitted; the coin creation is still being prepared');
  assert.equal(calls.filter(([path])=>path==='sign').length,1);assert.equal(calls.find(([path])=>path==='sign')[1].operationId,'hook-setup-op');
  // While the coin creation is being prepared the finalized hook setup is still the reviewed operation, with its own facts.
  assert.deepEqual([...root.querySelectorAll('.meteora-operation-facts div')].map(row=>[text(row.querySelector('dt')),text(row.querySelector('dd'))]),[['Transfer hook setup','2 rules written on chain with the hook accounts'],['This approval','0.0031 SOL'],['Next approval','Coin creation (3 of 3)']]);
  holdInitialize();await continuing;await flush();await flush();
  assert.equal(controller.operation.id,'initialize-op');assert.equal(controller.operation.state,'finalized');assert.equal(calls.filter(([path])=>path==='sign').length,2);
  controller.destroy();
  // A reload after the hook setup: the restored stage names the last approval.
  const again=createMeteoraOperation({document,root:document.getElementById('root'),wallet:{state:()=>({address:W4}),sign:async()=>'signed'},clock:()=>NOW,launchFlow:true,getLaunchInput:()=>({action:'initialize'}),context:()=>({active:true,key:'k'}),request:async()=>({operation:initialize})});
  assert(again.restore({...hookSetup,state:'finalized',transaction:undefined}));assert.match(text(document.getElementById('root')),/Your transfer hook setup is ready\. Next: the coin creation approval \(3 of 3\)\./);
  // A plain two-approval launch keeps its wording.
  again.restore(op({review:{...op().review,stages:2}}));assert.match(text(document.getElementById('root')),/Your launch configuration is ready\. Continue to create the coin\./);again.destroy();
});

test('a long blocklist repeats the hook-setup stage: review.step and review.blocklist name each approval ("Hook setup 2 of 3: blocklist wallets 17–44") and the launch continues with configure until the last one',async()=>{
  // The server places each approval's wallets with review.blocklistWallets (written now) and review.blocklistCountAfter (the chain's count once it lands); the whole list travels in review.hook.blocklist.
  const place=(wallets,after)=>({blocklistWallets:wallets,blocklistCountAfter:after});
  const op=(step,placed,overrides={})=>({id:'hook-setup-'+step.replace('/','of'),action:'configure',wallet:W4,mint:MINT,state:'finalized',expiresAt:NOW+120000,transaction:'AQID',review:{maxWalletDebitLamports:'3100000',firstBuyRaw:'0',quoteMint:SOL_MINT,quoteSymbol:'SOL',quoteDecimals:9,stage:'hook-setup',stages:3,step,hookSetupStep:Number(step.split('/')[0]),hookSetupSteps:Number(step.split('/')[1]),...placed,hook:{rules:[{id:'blocklist'},{id:'anti_dump'}],blocklist:Array.from({length:72},(_,i)=>blockWallet(i))}},...overrides});
  assert.deepEqual(hookSetupStep(op('1/3')),{step:1,steps:3});assert.deepEqual(hookSetupStep({review:{}}),{step:1,steps:1});assert.deepEqual(hookSetupStep({review:{step:'2 of 3'}}),{step:2,steps:3});
  assert.equal(hookBlocklistRange(op('2/3',place(28,44))),'17–44 of 72');assert.equal(hookBlocklistRange({review:{blocklistWallets:28,blocklistCountAfter:44}}),'17–44','no total known');assert.equal(hookBlocklistRange({review:{blocklist:{from:17,to:44,total:72}}}),'17–44 of 72','a literal range is read too');assert.equal(hookBlocklistRange(op('2/3',{})),'');assert.equal(hookBlocklistRange({review:{blocklistWallets:0,blocklistCountAfter:0}}),'');
  assert.equal(hookSetupTitle(op('2/3',place(28,44))),'Hook setup 2 of 3: blocklist wallets 17–44 of 72');assert.equal(hookSetupTitle({review:{step:'2/3',blocklistWallets:28,blocklistCountAfter:44}}),'Hook setup 2 of 3: blocklist wallets 17–44');assert.equal(hookSetupTitle(op('1/1',place(16,16))),'Transfer hook setup');
  assert.equal(meteoraLaunchNextAction(op('1/3')),'initialize','more blocklist batches: the request is still initialize, the server answers with the next hook-setup approval');assert.equal(meteoraLaunchNextAction(op('2/3')),'initialize');assert.equal(meteoraLaunchNextAction(op('3/3')),'initialize','the last batch: the coin creation');
  const {document}=parseHTML('<div id="root"></div>'),root=document.getElementById('root');
  const controller=createMeteoraOperation({document,root,wallet:{state:()=>({address:W4}),sign:async()=>'signed'},clock:()=>NOW,launchFlow:true,getLaunchInput:()=>({action:'initialize'}),context:()=>({active:true,key:'k'}),request:async()=>({operation:op('3/3')})});
  // The first hook-setup approval, awaiting its signature: the facts name the batch and the next approval.
  assert(controller.restore(op('1/3',place(16,16),{state:'awaiting_signature'})));
  assert.deepEqual([...root.querySelectorAll('.meteora-operation-facts div')].map(row=>[text(row.querySelector('dt')),text(row.querySelector('dd'))]),[['Hook setup 1 of 3','2 rules written on chain with the hook accounts · blocklist wallets 1–16 of 72'],['This approval','0.0031 SOL'],['Next approval','Hook setup 2 of 3']]);
  // The second one, finalized: the restored message names the third.
  assert(controller.restore(op('2/3',place(28,44))));assert.match(text(root),/Your hook setup 2 of 3 is confirmed\. Next: hook setup 3 of 3, then the coin creation approval\./);
  assert.deepEqual([...root.querySelectorAll('.meteora-operation-facts div')].map(row=>[text(row.querySelector('dt')),text(row.querySelector('dd'))]),[['Hook setup 2 of 3','Blocklist wallets 17–44 of 72 written on chain'],['This approval','0.0031 SOL'],['Next approval','Hook setup 3 of 3']]);
  // The last one, finalized: the coin creation follows.
  assert(controller.restore(op('3/3',place(28,72))));assert.match(text(root),/Your transfer hook setup is ready\. Next: the coin creation approval \(3 of 3\)\./);
  assert.deepEqual([...root.querySelectorAll('.meteora-operation-facts div')].map(row=>[text(row.querySelector('dt')),text(row.querySelector('dd'))]).at(-1),['Next approval','Coin creation (3 of 3)']);
  controller.destroy();
});

// ---- Explore and My Tokens --------------------------------------------------------------------------------------
test('Explore cards carry a Hooked chip whose title lists the rule names, plus a Launchpad-route marker when the coin trades on Launchpad only; the card version changes with the rules and the route',async()=>{
  const {document}=parseHTML('<!doctype html><html><body></body></html>');
  const coin={mint:MINT,name:'Lantern Market',symbol:'LAMP',image:null,stage:'new',curveStatus:'curve',feeMode:'creator',platform:'meteora',launchMode:'meteora',marketCapUsd:null,fdvUsd:27400,progressPercent:31.5,createdAt:NOW,quote:{mint:SOL_MINT,symbol:'SOL'},hook:{rules:[{id:'max_per_wallet',name:'Max per wallet',text:''},{id:'anti_dump',name:'Anti-dump caps',text:''},{id:'market_hours',name:'Market hours',text:''}],route:'any',gateMint:null,active:true,ended:false}};
  const card=createExploreCard(document,coin,{stage:'new',now:NOW}),chip=card.querySelector('.explore-coin-badge.is-hooked');
  assert(chip);assert.equal(text(chip),'Hooked');assert.equal(chip.getAttribute('title'),'Transfer hook rules: Max per wallet · Anti-dump caps · Market hours');assert.equal(chip.getAttribute('aria-label'),'Transfer hook rules: Max per wallet, Anti-dump caps, Market hours');
  assert.equal(card.querySelector('.explore-coin-badge.is-creator').nextElementSibling,chip,'after the reward badge');assert.equal(card.querySelector('.is-curve-route'),null,'no route marker for a coin that trades anywhere');
  assert.deepEqual(exploreHookNames(coin),['Max per wallet','Anti-dump caps','Market hours']);assert.deepEqual(exploreHookNames({...coin,hook:{rules:[{id:'ping_pong'},'venue_locked',{name:'<b>x</b>'},null]}}),['ping_pong','venue_locked','<b>x</b>']);
  assert.equal(exploreHookRoute(coin),'any');assert.equal(exploreHookRoute({...coin,hook:{...coin.hook,route:'curve'}}),'curve');assert.equal(exploreHookRoute({...coin,hook:null}),'');
  const curve=createExploreCard(document,{...coin,hook:{rules:[{id:'allowlist',name:'Allowlist'}],route:'curve'}},{stage:'new',now:NOW}),marker=curve.querySelector('.explore-coin-badge.is-curve-route');
  assert(marker,'the Launchpad-route marker');assert.equal(text(marker),'Launchpad route');assert.equal(marker.previousElementSibling,curve.querySelector('.explore-coin-badge.is-hooked'));assert.match(marker.getAttribute('title'),/^Launchpad route only: trades on Launchpad while it is on the curve/);
  assert.notEqual(exploreCardVersion(coin,{stage:'new'}),exploreCardVersion({...coin,hook:null},{stage:'new'}));assert.notEqual(exploreCardVersion(coin,{stage:'new'}),exploreCardVersion({...coin,hook:{...coin.hook,route:'curve'}},{stage:'new'}));
  for(const hook of [undefined,null,{},{rules:[]},{rules:'x'},{rules:[{}]},{route:'curve'}])assert.equal(createExploreCard(document,{...coin,hook},{stage:'new',now:NOW}).querySelector('.is-hooked'),null,JSON.stringify(hook));
  assert.equal(createExploreCard(document,{...coin,hook:{rules:[{id:'allowlist',name:'<img src=x onerror=alert(1)>'}]}},{stage:'new',now:NOW}).querySelector('.is-hooked img'),null,'names stay text');
});

test('My Tokens: a hooked Meteora launch gets the Hooked chip with the Launchpad-route marker, the rules and the allowlist manager that prepares through hook-allow',async t=>{
  const {document,window}=parseHTML(await readFile(new URL('../public/launched-tokens.html',import.meta.url),'utf8'));
  Object.defineProperty(document,'hidden',{value:false,writable:true});
  const ID='a'.repeat(32),calls=[],events=new Map();let now=NOW;
  const row={platform:'meteora',mint:MINT,name:'Velvet Rope',symbol:'ROPE',status:'trading',creatorId:ID,creatorRecipient:W4,creatorWallet:W4,quoteMint:SOL_MINT,quoteDecimals:9,quoteSymbol:'SOL',feeMode:'creator',feeRedirect:{canRedirect:true,recipient:W4},hook:{rules:[{id:'allowlist',name:'Allowlist',text:'Only wallets on the creator’s allowlist can receive this coin.'},{id:'holder_vesting',name:'Holder vesting',text:'Bought tokens unlock 10% every 24 h after a 24 h cliff; receipts under 0.05% of supply are free.'}],route:'curve',gateMint:null,titheRecipient:null,blocklistCount:null,active:true,ended:false,allowlist:[W1]}};
  const environment={Event:window.Event,CustomEvent:window.CustomEvent,dispatchEvent:()=>{},removeEventListener:(event,fn)=>{if(events.get(event)===fn)events.delete(event);},location:{search:''},setTimeout,clearTimeout,navigator:{clipboard:{writeText:async()=>{}}},addEventListener:(event,fn)=>events.set(event,fn)};
  const fetcher=async(path,options={})=>{
    const body=options.body?JSON.parse(options.body):undefined;calls.push({path,body,method:options.method||'GET'});let value;
    if(path==='/api/session')value={authenticated:true,token:'csrf',account:{id:ID,username:'mira_builds',mainWallet:W4}};
    else if(path==='/api/launchpad')value={launches:[]};
    else if(path==='/api/launchpad/meteora/launches')value={launches:[row]};
    else if(path==='/api/launchpad/meteora/operations')value={operations:[]};
    else if(path.startsWith('/api/launchpad/meteora/hook-allowlist?'))value={mint:MINT,allowlist:[W1,W2]};
    else if(path==='/api/launchpad/meteora/prepare')value={operation:{id:'hook-allow-9',action:'hook-allow',wallet:W4,mint:MINT,state:'awaiting_signature',transaction:'AQID',expiresAt:now+120000,review:{add:body.add,remove:body.remove,maxWalletDebitLamports:'5000',quoteMint:SOL_MINT,quoteDecimals:9}}};
    else if(path==='/api/launchpad/fee-assignments')value={wallet:W4,assignments:[],refreshMs:5000};
    else if(/^\/api\/launchpad\/(pump|damm-pump|pump-classic)\/launches$/.test(path))value={launches:[]};
    else value={};
    return {ok:true,status:200,json:async()=>value};
  };
  for(const dialog of document.querySelectorAll('dialog')){dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;};}
  const source=(await readFile(new URL('../public/launched-tokens.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replaceAll('export function ','function ').replace(/^bootPage\([^\n]+\n?$/m,'');
  const factory=new Function('createMeteoraAccountLaunches','coinImage','createPersonalEarnings','createQuoteLabel','createWorkspaceShell','createHoldersView','createLiveTradesView','updateTradeAges','LAUNCH_ASSETS','createLaunchpadWallet','creatorClaimState','runCreatorClaim','createCoinRewardsView','validCoinRewards','curveChartSnapshot','createCoinTrade','createHookRulesCard','createHookChip',source+'\nreturn createLaunchedTokensPage;')(createMeteoraAccountLaunches,coinImage,createPersonalEarnings,createQuoteLabel,()=>{},createHoldersView,createLiveTradesView,updateTradeAges,QUOTE_DISPLAY_ASSETS,createLaunchpadWallet,creatorClaimState,runCreatorClaim,createCoinRewardsView,validCoinRewards,curveChartSnapshot,createCoinTrade,hookUiModule.createHookRulesCard,hookUiModule.createHookChip);
  const wallet=coinWallet();
  const app=factory({document,window:environment,fetcher,walletFactory:wallet.factory,claimWait:async()=>{},clock:()=>now,setTimer:()=>1,clearTimer:()=>{},shell:()=>{},chartFactory:async()=>({set(){},remove(){}})});t.after(()=>app.destroy());
  await app.ready;await flush();await flush();await flush();
  const section=document.getElementById('tokens-meteora'),card=section.querySelector('article.token-card');assert(card,'the Meteora card renders');
  await until(()=>!!card.querySelector('.token-hook-chip'),'the card was not decorated');
  const chip=card.querySelector('.token-hook-chip');assert.equal(text(chip),'Hooked Launchpad route');assert.equal(chip.dataset.route,'curve');assert.equal(chip.getAttribute('title'),'Transfer hook rules: Allowlist · Holder vesting · Launchpad route only');assert.equal(chip.parentElement.classList.contains('token-card-state'),true);
  const marker=chip.querySelector('.hook-chip-route');assert(marker,'the Launchpad-route marker sits inside the chip');assert.equal(text(marker),'Launchpad route');
  const rules=card.querySelector('.token-card-body .token-hook-rules');assert(rules);assert.equal(text(rules.querySelector('h2')),'Transfer hook rules');assert.deepEqual([...rules.querySelectorAll('.hook-rule')].map(row=>row.dataset.rule),['allowlist','holder_vesting']);assert.equal(text(rules.querySelector('.hook-route-pill')),'Launchpad route only');
  assert.equal(rules.querySelector('.hook-freeze'),null);assert.equal(rules.querySelector('.hook-supply-pill'),null);
  await until(()=>rules.querySelectorAll('.hook-allowlist-item').length===2,'the allowlist was not read');
  const manager=rules.querySelector('.hook-allowlist');assert.deepEqual([...manager.querySelectorAll('.hook-allowlist-item')].map(item=>item.dataset.wallet),[W1,W2]);
  manager.querySelector('textarea').value=W3;manager.querySelector('textarea').oninput();await manager.querySelector('.hook-allowlist-prepare').onclick();await flush();await flush();
  const prepared=calls.find(call=>call.path==='/api/launchpad/meteora/prepare');assert.deepEqual(prepared.body,{action:'hook-allow',mint:MINT,add:[W3],remove:[],expectedWallet:W4});
  assert([...manager.querySelectorAll('button')].some(button=>text(button)==='Approve allowlist change'));assert.equal(app.canLeave(),false);
  // A second render of the section (its own re-render) keeps the same panel instance with its prepared transaction.
  const panel=rules;await app.tick();await flush();await flush();assert.equal(section.querySelector('.token-hook-rules'),panel);assert(section.querySelector('.token-hook-rules .hook-allowlist textarea').disabled,'the prepared change stays locked across re-renders');
  // The shared chip helper: no marker for a coin that trades anywhere, the route derived from the catalogue when the row does not say.
  const any=hookUiModule.createHookChip(document,{rules:[{id:'anti_dump',name:'Anti-dump caps'}]});assert.equal(text(any),'Hooked');assert.equal(any.dataset.route,'any');assert.equal(any.querySelector('.hook-chip-route'),null);
  assert.equal(hookUiModule.createHookChip(document,{rules:[{id:'tithe',name:'Tithe'}]}).dataset.route,'curve');assert.equal(hookUiModule.createHookChip(document,{rules:[]}),null);
});

// ---- Docs and terms ---------------------------------------------------------------------------------------------
test('the docs describe the feature with every rule, its route and ranges, the three routes, the three approvals, blocklist sealing, vesting records, graduation and the not-offered list; the terms carry the clause; nothing about freezing the supply remains',async()=>{
  const {document}=parseHTML(await readFile(new URL('../public/docs.html',import.meta.url),'utf8'));
  const section=document.getElementById('hooks');assert(section);assert.equal(text(section.querySelector('h2')),'Transfer hook rules');
  assert.equal(document.querySelector('.documentation-jump a[href="#hooks"]').textContent,'Transfer hook rules');
  const copy=text(section);
  for(const phrase of ['27 rules','seven groups','Meteora launches only','every rule ends at graduation','revokes the hook','never takes a fee, moves tokens','Three routes','Trades anywhere','Launchpad route only','App only','Launchpad’s Buy and Sell are off for the coin until it graduates','LAUNCHPAD_HOOK_FOMO_MARK','LAUNCHPAD_HOOK_PUMP_APP_MARK','co-signing wallet','up to four rules','three approvals','sealed by the first trade','Hook setup 2 of 3: blocklist wallets 17–44','Vesting records','Managing the allowlist','Not offered, and why','these eight are not offered','AI Agent launch cannot carry transfer hook rules','separate trade after launch','supply is fixed at creation'])assert.match(copy,new RegExp(escapeRegExp(phrase)),phrase);
  assert.doesNotMatch(copy,/freez|mint authority/i,'no supply-freeze language');
  const table=section.querySelector('.documentation-hook-table');assert(table);
  const rows=[...table.querySelectorAll('tbody tr')].filter(row=>row.querySelector('td'));
  assert.deepEqual(rows.map(row=>text(row.querySelector('td strong'))),HOOK_RULES.map(rule=>rule.name),'all 27 rules, in catalogue order');
  assert.deepEqual(rows.map(row=>text(row.querySelector('td em'))),HOOK_RULES.map(rule=>HOOK_ROUTES[rule.route].name),'each rule’s route');
  assert.deepEqual(rows.map(row=>text(row.querySelectorAll('td')[1]).startsWith(hookRuleById(HOOK_RULES[rows.indexOf(row)].id).rule)),HOOK_RULES.map(()=>true),'the catalogue’s own sentence for every rule');
  assert.deepEqual([...table.querySelectorAll('th[scope=rowgroup]')].map(cell=>text(cell).split(' — ')[0]),HOOK_GROUPS.map(group=>group.name));
  const numbers=Object.fromEntries(rows.map(row=>[text(row.querySelector('td strong')),text(row.querySelectorAll('td')[2])]));
  const hhmm=minute=>String(Math.floor(minute/60)).padStart(2,'0')+':'+String(minute%60).padStart(2,'0');
  for(const rule of HOOK_RULES)for(const setting of rule.settings){
    if(setting.options){for(const label of setting.labels||setting.options.map(String))assert.match(numbers[rule.name],new RegExp(escapeRegExp(label)),rule.name+' lists '+label);continue;}
    if(setting.key==='weekdays')continue;
    const bounds=setting.unit==='hh:mm'?[hhmm(setting.min),hhmm(setting.max)]:[setting.min,setting.max].map(bound=>Number(bound).toLocaleString('en-US',{maximumFractionDigits:6}));
    for(const bound of bounds)assert.match(numbers[rule.name],new RegExp('(^|[^0-9,.:])'+escapeRegExp(bound)+'($|[^0-9,:])'),rule.name+' lists '+bound);
  }
  assert.match(numbers['Blocklist'],/1 to 200 wallet addresses/);assert.match(numbers['Tithe'],/recipient wallet address/);assert.match(numbers['Holder-gated'],/gate token/);assert.match(numbers['FOMO-only'],/LAUNCHPAD_HOOK_FOMO_MARK/);assert.match(numbers['Pump App-only'],/LAUNCHPAD_HOOK_PUMP_APP_MARK/);
  for(const row of HOOK_NOT_OFFERED){assert.match(copy,new RegExp(escapeRegExp(row.name.split(',')[0])),row.name);assert.match(copy,new RegExp(escapeRegExp(row.why.slice(0,40))),row.name+' reason');}
  assert.doesNotMatch(copy,/guarantee|will (rise|pump|moon)/i,'no promised outcomes');
  const terms=parseHTML(await readFile(new URL('../public/terms.html',import.meta.url),'utf8')).document,clause=[...terms.querySelectorAll('p')].find(p=>/^Transfer hook rules\./.test(text(p)));
  assert(clause,'the terms carry a transfer hook clause');const words=text(clause);
  for(const phrase of ['your choice','enforced by a program on Solana','permanent','every rule ends at graduation','never takes a fee or moves tokens','Launchpad route only','trades on Launchpad only until graduation','App only','cannot be bought or sold on Launchpad until it graduates','third party Launchpad does not operate','sealed by the first trade','never holds the hook authority','does not promise'])assert.match(words,new RegExp(escapeRegExp(phrase)),phrase);
  assert.doesNotMatch(words,/freez|mint authority/i);assert.equal(clause.querySelector('a[href="/docs#hooks"]')!==null,true);
});
