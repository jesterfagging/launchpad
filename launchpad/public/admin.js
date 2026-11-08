import { createWorkspaceShell } from './workspace-shell.js';
import { createAccountSecurity } from './account-security-ui.js';
import { createLaunchAdmin } from './launch-admin-ui.mjs';
import { createAdminProtocol } from './admin-protocol-ui.mjs';
import { createAdminBranding } from './admin-branding-ui.mjs';
import { createAdminRevenue } from './admin-revenue-ui.mjs';
import { createAdminVolume } from './admin-volume-ui.mjs';
import { createAdminRevenueAudit } from './admin-revenue-audit-ui.mjs';
import { createAdminTreasury } from './admin-treasury-ui.mjs';
import { createAdminBurnHistory } from './admin-burn-history-ui.mjs';
import { createAdminGasFunding } from './admin-gas-ui.mjs';
import { createAdminGotchi } from './admin-gotchi-ui.mjs';
import { createAdminAgents } from './admin-agents-ui.mjs';
import { createAdminPumpClassic } from './admin-pump-classic-ui.mjs';
import { createAdminRobinhood } from './admin-robinhood-ui.mjs';
import { createAdminVanity } from './admin-vanity-ui.mjs';
import { createAdminPairs } from './admin-pairs-ui.mjs';
import { createAdminRewardDiagnostics } from './admin-reward-diagnostics-ui.mjs';
import { createAdminHealth } from './admin-health-ui.mjs';
import { createAdminCleanup } from './admin-cleanup-ui.mjs';
import { openPositionCount } from './ui-performance.mjs';
import { hashState } from './admin-list-kit.mjs';

// A white-label launchpad (<body data-product="tenant">): the sections for the venues and launch modes its owner picked. The
// treasury is managed (no setup, no buybacks), so its buyback, gas-refill and onchain re-branding cards stay off.
const TENANT = typeof document !== 'undefined' && document.body?.dataset?.product === 'tenant';
const tenantList = key => String((typeof document !== 'undefined' && document.body?.dataset?.[key]) || '').split(' ').filter(Boolean);
const TENANT_HIDDEN = new Set(['burns', 'gas', 'branding', 'pumpswap', 'admin-test', 'legacy', 'robinhood', 'toolkit', 'connections', 'activity']);
const tenantShows = sub => { if (!TENANT) return true; if (TENANT_HIDDEN.has(sub.key)) return false; if (sub.key === 'gotchi') return tenantList('modes').includes('gotchi'); if (sub.key === 'agents') return tenantList('modes').includes('agent'); if (sub.key === 'pump-fun') return tenantList('venues').includes('pump-classic'); if (sub.key === 'meteora') return tenantList('venues').includes('meteora'); return true; };
function createPrivatePumpTest(options) {
  const element = options.document.createElement('div');
  let instance, deployment, publicMode, meteoraMode, dammMode, legacy, pending, closed = false, revision = 0;
  return {
    element,
    async load() {
      if (closed || !options.isActive() || !options.getAccount()) return;
      const generation = revision, owner = options.getAccount().id;
      pending ||= (TENANT ? Promise.all([null, null, null, tenantList('venues').includes('meteora') ? import('./admin-meteora-ui.mjs') : { createAdminMeteora: null }, null]) : Promise.all([import('./admin-pump-test-ui.mjs'),import('./admin-pump-deployment-ui.mjs'),import('./admin-pump-public-ui.mjs'),import('./admin-meteora-ui.mjs'),import('./admin-damm-pump-ui.mjs')])).finally(() => { pending = null; });
      try {
        const [pumpTestModule, deploymentModule, publicModule, { createAdminMeteora }, dammModule] = await pending;
        if (closed || generation !== revision || !options.isActive() || options.getAccount()?.id !== owner) return;
        // A launchpad: the Meteora card only, when it offers Meteora (Pump.fun is managed under Tokens).
        if (TENANT) { if (!createAdminMeteora) return; if (!meteoraMode) { meteoraMode = createAdminMeteora(options); element.replaceChildren(meteoraMode.element); } await meteoraMode.load(); return; }
        const { createAdminPumpTest } = pumpTestModule, { createAdminPumpDeployment } = deploymentModule, { createAdminPumpPublic } = publicModule, { createAdminDammPump } = dammModule;
        if (!instance) { legacy=options.document.createElement('details');legacy.className='admin-card admin-pump-legacy';const title=options.document.createElement('summary');title.textContent='Existing Pump launches and owner test tools';legacy.append(title);const privateOptions={...options,isActive:()=>options.isActive()&&legacy.open};instance=createAdminPumpTest(privateOptions);deployment=createAdminPumpDeployment(privateOptions);publicMode=createAdminPumpPublic(privateOptions);meteoraMode=createAdminMeteora(options);dammMode=createAdminDammPump(options);legacy.append(publicMode.element,deployment.element,instance.element);legacy.addEventListener('toggle',()=>{if(legacy.open){void instance.load();void deployment.load();void publicMode.load();}else{instance.pause?.();deployment.pause?.();publicMode.pause?.();}});element.replaceChildren(dammMode.element,meteoraMode.element,legacy); }
        await Promise.all([dammMode.load(),meteoraMode.load(),...(legacy.open?[publicMode.load(),instance.load(),deployment.load()]:[])]);
      } catch {
        if (!closed && generation === revision && options.getAccount()?.id === owner) {
          options.onUnavailable?.();
          element.textContent = 'Launch mode setup is unavailable. Refresh this section to try again.';
        }
      }
    },
    clear() { revision++; if (legacy) legacy.open = false; instance?.clear(); deployment?.clear(); publicMode?.clear(); meteoraMode?.clear(); dammMode?.clear(); if (!instance) element.replaceChildren(); },
    pause() { revision++; instance?.pause(); deployment?.pause(); publicMode?.pause(); meteoraMode?.pause(); dammMode?.pause(); },
    destroy() { closed = true; revision++; instance?.destroy(); deployment?.destroy(); publicMode?.destroy(); meteoraMode?.destroy(); dammMode?.destroy(); element.replaceChildren(); }
  };
}

const short=value=>typeof value==='string'&&value.length>20?`${value.slice(0,8)}…${value.slice(-6)}`:value||'—';
const tools={copy:'Copy trading',sniper:'Launch sniper',liquidity:'Liquidity manager',market:'Market maker'};
// Presentation only: each tab shows one page (sub-section) at a time. Targets are
// existing module roots; nothing here loads data or changes what a module does.
const SUBSECTIONS={
  overview:[
    {key:'volume',label:'Trading volume',targets:['admin-volume'],terms:'volume trades lifetime 24h quote assets'},
    {key:'health',label:'Platform health',targets:['admin-health'],terms:'health server requests latency memory rpc capacity'}],
  revenue:[
    {key:'fees',label:'Fee collection',targets:['admin-protocol'],terms:'protocol fees collect launchpad fee wallet creation fee policy upgrade curve'},
    {key:'treasury',label:'Treasury',targets:['admin-treasury'],terms:'buybacks treasury withdraw retained recognize automation wallet balance'},
    {key:'burns',label:'Buybacks & burns',targets:['admin-burn-history'],terms:'burn buyback analytics import transaction'},
    {key:'gas',label:'Gas refills',targets:['admin-gas-funding'],terms:'gas refill network fees sol wallet'},
    {key:'diagnostics',label:'Reward diagnostics',targets:['admin-reward-diagnostics'],terms:'holder rewards download diagnostics history report',open:true},
    {key:'report',label:'Revenue report',targets:['admin-revenue'],terms:'revenue earnings report products totals'},
    {key:'checks',label:'Revenue checks',targets:['admin-revenue-audit'],terms:'audit checks reconcile routing issues',open:true},
    {key:'toolkit',label:'Toolkit fee wallets',targets:['admin-platform'],terms:'trading fee wallets',toolkit:true}],
  tokens:[
    {key:'launches',label:'Token management',targets:['admin-launches'],terms:'launches coins tokens hide archive rewards distribute'},
    {key:'cleanup',label:'Cleanup',targets:['admin-cleanup'],terms:'cleanup failed unfinished errors never finished archive refund refunds stuck expired drafts abandoned quotes broken'},
    {key:'gotchi',label:'Gotchi Mode',curve:true,targets:['admin-gotchi','admin-gotchi-owner-only'],terms:'gotchi race pot vault pause resume settlement conversion sampling retry'},
    {key:'agents',label:'AI Agents',curve:true,targets:['admin-agents','admin-agents-owner-only'],terms:'agents ai agent flags solvency provider backing openrouter browserbase reimbursement keys ledger'},
    {key:'pump-fun',label:'Pump.fun',targets:['admin-pump-classic','admin-pump-classic-owner-only'],terms:'pump.fun pump fun classic launches market maker liquidity manager fee sharing holders strategies refund keys backup'},
    {key:'robinhood',label:'Robinhood Chain',robinhood:true,curve:true,targets:['admin-robinhood','admin-robinhood-owner-only'],terms:'robinhood chain evm uniswap v4 factory escrow locker pairs stocks etf usdg launches holders refund keys backup owner'},
    {key:'vanity',label:'Vanity addresses',targets:['admin-vanity','admin-vanity-owner-only'],terms:'vanity contract address ca mint pool keys grind solana-keygen used'}],
  users:[
    {key:'accounts',label:'Accounts',targets:['admin-users'],terms:'users accounts wallet search manual'},
    {key:'moderation',label:'Moderation',targets:['admin-moderation'],terms:'ban restore access moderation block'},
    {key:'activity',label:'User activity',targets:['admin-sessions'],terms:'sessions activity tools',toolkit:true}],
  'pump-test':[
    {key:'pumpswap',label:'PumpSwap',curve:true,targets:['admin-damm-pump-deployment','admin-damm-pump-configuration'],terms:'pumpswap controller graduation deploy public launches damm'},
    {key:'admin-test',label:'Admin test',curve:true,targets:['admin-damm-pump-test'],terms:'test micro fdv owner',open:true},
    {key:'meteora',label:'Meteora',curve:true,targets:['admin-meteora'],terms:'meteora dbc damm pairs'},
    {key:'legacy',label:'Legacy Pump tools',curve:true,targets:['.admin-pump-legacy'],terms:'legacy pump lab owner test funded',open:true}],
  settings:[
    {key:'branding',label:'Platform branding',targets:['admin-branding'],terms:'branding onchain metadata platform name image logo'},
    {key:'connections',label:'Funding connection',targets:['admin-integrations'],terms:'funding api key connection',toolkit:true}],
};
const SECTION_TERMS={overview:'dashboard totals stats home',revenue:'money fees treasury income',tokens:'launches coins tokens hide archive rewards distribute',pairs:'quote pairs assets mint catalogue',users:'accounts community people',['pump-test']:'launch modes venues pumpswap meteora',settings:'preferences branding configuration'};
// Owner-only server areas (pumpLab.requireOwner). A 403 from one of them, or any 403 with code OWNER_ONLY,
// means the platform-owner capability is unavailable; it is not lost administrator access.
const OWNER_PATH=/^\/api\/admin\/(?:pump-test|damm-pump|damm-pump-test|pump-public|meteora|gotchi|agents|pump-classic|robinhood|vanity)(?:[/?]|$)/;
const OWNER_ONLY_TEXT='Owner-only: available to the platform owner.';
// Server texts that are safe and useful to show as written: re-authentication results and rate limits.
const KNOWN_ERRORS=/^(?:Invalid username or password\.|Invalid or already used authentication code\.|Enter your authenticator code or a recovery code\.|Account security changed\.|This account is banned from Launchpad\.|Too many |Sign-in is busy\.)/;
const BASE58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// A base58 string that decodes to exactly 32 bytes: a Solana wallet address.
const solanaAddress=value=>{if(typeof value!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))return false;let number=0n,bytes=0;for(const char of value)number=number*58n+BigInt(BASE58.indexOf(char));for(;number>0n;number>>=8n)bytes++;return value.match(/^1*/)[0].length+bytes===32;};
const waitText=ms=>{const minutes=Math.ceil(ms/60000),seconds=Math.max(1,Math.ceil(ms/1000));return ms>=60000?`${minutes} minute${minutes===1?'':'s'}`:`${seconds} second${seconds===1?'':'s'}`;};
// Reads a JSON body only when the response declares one; a proxy's HTML error page yields null.
async function responseJson(response){
  const type=typeof response?.headers?.get==='function'?String(response.headers.get('content-type')||''):null;
  if(type!==null&&!/json/i.test(type))return null;
  try{const data=await response.json();return data&&typeof data==='object'?data:null;}catch{return null;}
}
// One error for every failed request: the status, the server's code and wait time, and `known` when the
// message may be shown as written (modules hide any other server text behind their own wording).
function requestError(response,data){
  const status=Number(response?.status)||0,text=typeof data?.error==='string'?data.error.trim().slice(0,500):'',header=Number(response?.headers?.get?.('retry-after'));
  const retryAfterMs=Number.isFinite(data?.retryAfterMs)&&data.retryAfterMs>0?data.retryAfterMs:Number.isFinite(header)&&header>0?header*1000:0;
  let message=text||'This request could not be completed.',known=KNOWN_ERRORS.test(text)||data?.mfaRequired===true;
  if(status===429){known=true;if(!text)message='Too many attempts. Try again shortly.';if(retryAfterMs){message=message.replace(/\s*(?:please\s+)?(?:try again|wait)\b[^.]*\.?\s*$/i,'').replace(/[\s;,:-]+$/,'');message=(message?message+(/[.!?]$/.test(message)?' ':'. '):'')+`Try again in ${waitText(retryAfterMs)}.`;}}
  else if(!data){known=true;message=status===401?'Your session expired. Sign in again.':status===0||status>=500?'The server is unavailable. Try again.':response?.ok?'The server sent an unexpected response. Try again.':'This request could not be completed.';}
  else if(data.code==='OWNER_ONLY'){known=true;message=OWNER_ONLY_TEXT;}
  const error=Error(message);error.status=status;if(typeof data?.code==='string')error.code=data.code;if(retryAfterMs)error.retryAfterMs=retryAfterMs;if(known)error.known=true;return error;
}
export function createAdminPage({document,window,fetcher=fetch,shell=createWorkspaceShell,securityFactory=createAccountSecurity,launchFactory=createLaunchAdmin,protocolFactory=createAdminProtocol,brandingFactory=createAdminBranding,revenueFactory=createAdminRevenue,volumeFactory=createAdminVolume,revenueAuditFactory=createAdminRevenueAudit,treasuryFactory=createAdminTreasury,burnHistoryFactory=createAdminBurnHistory,gasFactory=createAdminGasFunding,gotchiFactory=createAdminGotchi,agentsFactory=createAdminAgents,pumpClassicFactory=createAdminPumpClassic,robinhoodFactory=createAdminRobinhood,vanityFactory=createAdminVanity,pairsFactory=createAdminPairs,diagnosticsFactory=createAdminRewardDiagnostics,pumpTestFactory=createPrivatePumpTest,cleanupFactory=createAdminCleanup,setTimer=setInterval,clearTimer=clearInterval}={}){
  const $=id=>document.getElementById(id),el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==null&&text!==undefined)node.textContent=String(text);if(cls)node.className=cls;return node;};
  let features={},account=null,csrf='',allowed=false,disposed=false,revision=0,action=false,overview=null,users=[],userPage=0,userAccountType='password',usersBusy=false,sessionPage=0,sessionsBusy=false,sessionRevision=0,chosen=null,detailBusy=false,detailRevision=0,husherRevision=0,husherTimer=null,initializing=false,activeSection='overview',pumpTestAllowed=false;
  const sectionKeys=['overview','revenue','tokens','pairs','users','pump-test','settings'],loadedSections=new Set(),lastSub={},sectionBusy=new Map();
  // Sub-pages backed by their own modules: only the visible page loads and polls. `loadedPages` holds the
  // pages opened in this administrator session, `stalePages` the hidden pages a "Refresh section" passed over.
  let pageModules={};const loadedPages=new Set(),stalePages=new Set(),onceModules=new Set(),ownerNotices=new Map();
  const sectionAliases={'admin-overview':'overview','admin-volume':'overview','admin-health':'overview','admin-revenue':'revenue','admin-revenue-audit':'revenue','admin-protocol':'revenue','admin-treasury':'revenue','admin-burn-history':'revenue','admin-gas-funding':'revenue','admin-reward-diagnostics':'revenue','admin-pairs':'pairs','admin-platform':'revenue','admin-launches':'tokens','admin-cleanup':'tokens','admin-gotchi':'tokens','admin-agents':'tokens','admin-pump-classic':'tokens','admin-vanity':'tokens','admin-users':'users','admin-moderation':'users','admin-sessions':'users','admin-branding':'settings','admin-integrations':'settings','admin-pump-test':'pump-test'};
  const controllers=new Set();let security,launchAdmin,protocolAdmin,brandingAdmin,revenueAdmin,volumeAdmin,revenueAuditAdmin,healthAdmin,treasuryAdmin,burnHistoryAdmin,gasAdmin,gotchiAdmin,agentsAdmin,pumpClassicAdmin,robinhoodAdmin,vanityAdmin,pairsAdmin,diagnosticsAdmin,pumpTestAdmin,cleanupAdmin;
  const toolkitEnabled=()=>features.toolkit===true;
  function renderFeatures(){
    for(const node of document.querySelectorAll('[data-toolkit-only]'))node.hidden=!toolkitEnabled();
    document.body.classList.toggle('admin-launchpad-only',!toolkitEnabled());
    ($('admin-users-nav').querySelector('.admin-tab-label')||$('admin-users-nav')).textContent='Users';
    $('admin-users-title').textContent=toolkitEnabled()?'Cashback management':'Account management';
    $('admin-users-description').textContent=toolkitEnabled()?"Cashback is a share of Launchpad platform fees, credited to each user's main wallet.":'Find accounts by username or wallet and manage your launchpad community.';
    if(!toolkitEnabled()){clearKey();$('admin-fee-forms').replaceChildren();$('admin-session-users').replaceChildren();$('admin-session-detail').replaceChildren();chosen=null;sessionRevision++;detailRevision++;}
    applyView(activeSection);
  }
  const permitted=()=>allowed&&!disposed&&account?.role==='admin'&&account?.mfaEnabled;
  // The owner capability (session pumpTestAllowed) gates Launch modes and the owner-only Tokens pages
  // (Gotchi, AI Agents, Pump.fun, Vanity). Without it those pages show an owner-only notice and never call the API.
  const ownerModules=()=>[gotchiAdmin,agentsAdmin,pumpClassicAdmin,robinhoodAdmin,vanityAdmin];
  function renderOwnerNotices(){for(const card of ownerNotices.values())card.hidden=pumpTestAllowed||!permitted();}
  function setPumpTestAccess(value,{fallback=true}={}) {
    const before=pumpTestAllowed;pumpTestAllowed=value===true;$('admin-pump-test-nav').hidden=!pumpTestAllowed;renderOwnerNotices();if(typeof renderGroups==='function')renderGroups();
    if(!pumpTestAllowed){loadedSections.delete('pump-test');pumpTestAdmin?.clear();for(const module of ownerModules())module?.clear();for(const key of ['gotchi','agents','pump-fun','vanity'])loadedPages.delete('tokens/'+key);if(fallback&&activeSection==='pump-test'&&permitted())void selectSection('overview');}
    else if(!before&&permitted()&&activeSection==='tokens'&&loadedSections.has('tokens'))void loadSection('tokens',{pagesOnly:true});
  }
  // Toast for panel results. Account security writes only to its own dialog line (securityMessage).
  function message(text='',negative=false){$('admin-message').textContent=text;$('admin-message').hidden=!text;$('admin-message').classList.toggle('negative',negative);
    // Presentation: the status line floats as a toast. Replaying the class restarts its entrance and auto-fade.
    const region=$('admin-message').parentElement;region?.classList.remove('is-live');if(text){void region?.offsetWidth;region?.classList.add('is-live');}region?.classList.toggle('is-negative',!!text&&negative);}
  function securityMessage(text=''){$('admin-security-message').textContent=text;}
  function clearKey(){husherRevision++;window.clearTimeout(husherTimer);$('admin-husher-key').value='';$('admin-husher-key').type='password';$('admin-husher-clear').hidden=true;}
  function gate(text,{mfa=false,signedIn=false}={}){allowed=false;setPumpTestAccess(false,{fallback:false});revision++;loadedSections.clear();loadedPages.clear();stalePages.clear();renderOwnerNotices();message();
    // Signing in (or opening the account) returns to this admin page and section, not the home page.
    $('admin-signin').setAttribute('href','/admin?'+(signedIn?'account=overview':'signin=1')+String(window.location?.hash||''));usersBusy=false;sessionsBusy=false;detailBusy=false;sessionRevision++;detailRevision++;for(const controller of controllers)controller.abort();clearKey();launchAdmin?.clear();protocolAdmin?.clear();brandingAdmin?.clear();revenueAdmin?.clear();volumeAdmin?.clear();revenueAuditAdmin?.clear();healthAdmin?.clear();treasuryAdmin?.clear();burnHistoryAdmin?.clear();gasAdmin?.clear();gotchiAdmin?.clear();agentsAdmin?.clear();pumpClassicAdmin?.clear();robinhoodAdmin?.clear();vanityAdmin?.clear();pairsAdmin?.clear();diagnosticsAdmin?.clear();pumpTestAdmin?.clear();cleanupAdmin?.clear();renderInbox([]);if($('security-auth')?.open)$('security-auth').close();if($('admin-security-dialog').open)$('admin-security-dialog').close();if($('admin-command')?.open)$('admin-command').close();setBadge('tokens',null);setBadge('users',null);setBadge('pairs',null);$('admin-main').hidden=true;$('admin-gate').hidden=false;if($('admin-back-to-top'))$('admin-back-to-top').hidden=true;$('admin-gate-message').textContent=text;$('admin-gate-security').hidden=!mfa;$('admin-signin').textContent=signedIn?'Open your account':'Sign in to Launchpad';$('admin-overview').replaceChildren();$('admin-fee-forms').replaceChildren();$('admin-user-list').replaceChildren();$('admin-session-users').replaceChildren();$('admin-session-detail').replaceChildren();users=[];overview=null;chosen=null;$('admin-users-pages').replaceChildren();$('admin-session-pages').replaceChildren();}
  async function api(path,body,{signal}={}){
    if(disposed)throw Error('Page closed.');const generation=revision,controller=new AbortController();controllers.add(controller);const cancel=()=>controller.abort();if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});const timeout=window.setTimeout(()=>controller.abort(),body===undefined?15000:120000);
    try{const response=await fetcher(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{...(csrf?{'x-control-token':csrf}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:controller.signal});const data=await responseJson(response);if(disposed||generation!==revision)throw Error('This administrator session changed. Refresh before continuing.');
      if(!response.ok||data===null){const error=requestError(response,data);
        // Only an expired session (401) or a general admin read refused with 403 closes the panel. Owner-only
        // refusals hide the owner features; a refused POST reports its error where the action was taken.
        if(error.status===401)gate('Your session expired. Sign in again.');
        else if(error.status===403&&(error.code==='OWNER_ONLY'||OWNER_PATH.test(path)))setPumpTestAccess(false);
        else if(error.status===403&&body===undefined&&path.startsWith('/api/admin/'))gate('Administrator access is unavailable. Sign in again with two-factor authentication.',{signedIn:true});
        throw error;}
      if(path==='/api/account/mfa/enable'&&data.token){csrf=data.token;account=data.account||account;}return data;}finally{window.clearTimeout(timeout);signal?.removeEventListener('abort',cancel);controllers.delete(controller);}
  }
  async function protectedAction(title,task){
    if(action||!permitted())return;action=true;const generation=revision;message();
    try{const credentials=await security.authorize(title,{requireCode:true});if(!permitted()||generation!==revision)return;return await task(credentials);}
    catch(error){if(error.message!=='Cancelled.'&&generation===revision)message(error.message,true);}
    finally{action=false;}
  }
  function feeForm(chain,data){
    const form=el('form',null,'admin-fee-form'),heading=el('div',null,'admin-fee-heading');heading.append(el('h3',chain==='solana'?'Solana':'Robinhood'),el('span',data?.ready?'Connected':data?'Needs setup':'Unavailable','admin-fee-status'+(data?.ready?'':' is-missing')));form.append(heading);
    if(!data){form.setAttribute('aria-disabled','true');form.append(el('p','Robinhood is not configured on this host.','help'));return form;}
    const label=el('label','Toolkit fee collection wallet'),input=el('input');input.value=data.recipient||'';input.required=true;input.maxLength=chain==='solana'?44:42;input.autocomplete='off';input.spellcheck=false;input.setAttribute('aria-label',(chain==='solana'?'Solana':'Robinhood')+' fee collection wallet');label.append(input);
    const button=el('button','Save collection wallet','small-button');button.type='submit';form.append(label,el('p',chain==='solana'?'Use a regular wallet you control, funded with SOL.':'Use a wallet you control on Robinhood Chain.','help'),button);
    form.onsubmit=async event=>{event.preventDefault();if(!toolkitEnabled()||!input.value.trim())return;const recipient=input.value.trim();if(!(chain==='solana'?solanaAddress(recipient):/^0x[0-9a-fA-F]{40}$/.test(recipient))){message(chain==='solana'?'Enter a valid Solana wallet address.':'Enter a valid Robinhood Chain wallet address: 0x followed by 40 hexadecimal characters.',true);return;}button.disabled=true;try{await protectedAction('Change '+(chain==='solana'?'Solana':'Robinhood')+' collection wallet',async credentials=>{await api(chain==='solana'?'/api/admin/fees':'/api/robinhood/admin/fees',{recipient,...credentials});message('Collection wallet saved. Updated settings apply to future operations.');await loadOverview({wallets:true});});}finally{button.disabled=false;}};return form;
  }
  async function loadOverview({wallets=false}={}){if(!permitted())return;const generation=revision;try{const data=await api('/api/admin/overview');if(!permitted()||generation!==revision)return;overview=data;const counts=data.counts||{};if(!users.length)setBadge('users',counts.accounts);renderInbox(Array.isArray(data.attention)?data.attention:[]);$('admin-overview').replaceChildren(...[['Accounts',counts.accounts],['Launch records',counts.launches],['Holder reward launches',counts.holderLaunches],['Buyback launches',counts.buybackLaunches]].map(([label,value])=>{const item=el('div');item.append(el('span',label),el('strong',Number.isFinite(Number(value))?Number(value).toLocaleString():'—'));return item;}));if(wallets&&toolkitEnabled())$('admin-fee-forms').replaceChildren(feeForm('solana',data.fees?.solana),feeForm('robinhood',data.fees?.robinhood));}catch(error){if(generation===revision)message(error.message,true);}}
  // "Needs you": the overview's alerts (from /api/admin/overview), each a plain link to the page that handles it.
  function renderInbox(items){
    const box=$('admin-inbox'),list=$('admin-inbox-list'),summary=$('admin-inbox-summary');if(!box||!list)return;
    const rows=(Array.isArray(items)?items:[]).filter(item=>item&&typeof item.label==='string'&&Number(item.count)>0).slice(0,12);
    list.replaceChildren(...rows.map(item=>{
      const li=el('li',null,'admin-inbox-item'+(item.tone==='bad'?' is-bad':'')),link=el('a',null,'admin-inbox-link');
      link.href=typeof item.hash==='string'&&/^#[a-z-]+(?:\/[a-z-]+)?(?:\?[\w.=&%-]*)?$/.test(item.hash)?item.hash:'#overview';link.dataset.inbox=String(item.code||'').slice(0,40);
      const body=el('span',null,'admin-inbox-body');body.append(el('span',String(item.label).slice(0,80),'admin-inbox-label'),el('small',String(item.detail||'').slice(0,200)));
      link.append(el('strong',Number(item.count).toLocaleString('en-US'),'admin-inbox-count'),body,el('span','Open','admin-inbox-open'));li.append(link);return li;
    }));
    box.hidden=!rows.length;if(summary)summary.textContent=rows.length?`${rows.reduce((n,item)=>n+Number(item.count),0).toLocaleString('en-US')} ${rows.length===1?'thing needs':'things need'} an operator. Everything else is running on its own.`:'';
    setBadge('overview',rows.length||null);
  }
  function renderUsers(){
    $('admin-users-type-heading').textContent=userAccountType==='wallet'?'Wallet-connected accounts':'Manually created accounts';
    $('admin-users-manual').setAttribute('aria-pressed',String(userAccountType==='password'));$('admin-users-wallet').setAttribute('aria-pressed',String(userAccountType==='wallet'));
    const query=$('admin-user-search').value.trim().toLowerCase(),matches=users.filter(user=>(user.authType||'password')===userAccountType).filter(user=>[user.username,user.mainWallet].some(value=>String(value||'').toLowerCase().includes(query))),total=matches.length;userPage=Math.min(userPage,Math.max(0,Math.ceil(total/20)-1));
    const rows=matches.slice(userPage*20,userPage*20+20).map(user=>{const form=el('form',null,'admin-user-row'),info=el('div',null,'admin-user-info');info.append(el('strong',user.username),el('small',(user.banned?'Banned':user.role==='admin'?'Administrator':'User')+' · '+short(user.mainWallet)));form.append(info);if(!toolkitEnabled())return form;const label=el('label','Cashback %'),input=el('input');input.type='number';input.min='0';input.max='100';input.step='0.01';input.required=true;input.value=String(Number(user.cashbackBps||0)/100);input.setAttribute('aria-label',`${user.username} cashback percent`);label.append(input);const save=el('button','Save rate','small-button');save.type='submit';form.append(info,label,save);
      form.onsubmit=async event=>{event.preventDefault();if(!toolkitEnabled())return;const raw=input.value.trim(),percentage=Number(raw),cashbackBps=Math.round(percentage*100);if(!raw||!Number.isFinite(percentage)||percentage<0||percentage>100||Math.abs(percentage*100-cashbackBps)>1e-7){message('Enter cashback from 0% to 100%, with up to two decimal places.',true);return;}save.disabled=true;try{await protectedAction('Change cashback for '+user.username,async credentials=>{const data=await api('/api/admin/cashback',{accountId:user.id,cashbackBps,...credentials});user.cashbackBps=data.account?.cashbackBps??cashbackBps;message('Cashback rate saved for '+user.username+'.');renderUsers();});}finally{save.disabled=false;}};return form;});
    $('admin-user-list').replaceChildren(...(rows.length?rows:[el('p','No users match your search.','admin-muted')]));const pages=$('admin-users-pages');pages.replaceChildren();if(total>20){const prev=el('button','Previous','small-button'),next=el('button','Next','small-button');prev.type=next.type='button';prev.disabled=userPage===0;next.disabled=(userPage+1)*20>=total;prev.onclick=()=>{userPage--;renderUsers();writeUsersState({push:true});};next.onclick=()=>{userPage++;renderUsers();writeUsersState({push:true});};pages.append(prev,el('span',`${userPage+1} / ${Math.ceil(total/20)}`),next);}
  }
  const moderation=el('section',null,'admin-card');moderation.id='admin-moderation';const moderationHeading=el('div',null,'admin-card-heading'),moderationCopy=el('div');moderationCopy.append(el('p','COMMUNITY / MODERATION','eyebrow'),el('h2','User moderation'),el('p','Ban or restore access by username or Solana wallet. Existing sessions are revoked when banned.','help'));moderationHeading.append(moderationCopy);moderation.append(moderationHeading);
  const banForm=el('form',null,'admin-moderation-form'),targetLabel=el('label','Username or wallet'),targetInput=el('input'),reasonLabel=el('label','Reason'),reasonInput=el('input'),actionLabel=el('label','Action'),banAction=el('select'),banSubmit=el('button','Apply','small-button');
  targetInput.required=true;targetInput.maxLength=44;targetInput.placeholder='Username or full wallet address';reasonInput.required=true;reasonInput.minLength=5;reasonInput.maxLength=500;reasonInput.placeholder='Reason for moderation';
  for(const [value,label]of [['ban','Ban access'],['unban','Restore access']]){const option=el('option',label);option.value=value;banAction.append(option);}targetLabel.append(targetInput);reasonLabel.append(reasonInput);actionLabel.append(banAction);banSubmit.type='submit';banForm.append(targetLabel,actionLabel,reasonLabel,banSubmit);moderation.append(banForm);$('admin-users').before(moderation);
  banForm.onsubmit=async event=>{event.preventDefault();banSubmit.disabled=true;try{await protectedAction(banAction.value==='ban'?'Ban user access':'Restore user access',async credentials=>{const data=await api('/api/admin/moderation/user',{target:targetInput.value.trim(),banned:banAction.value==='ban',reason:reasonInput.value.trim(),...credentials});message(`${data.target}: access ${data.banned?'banned':'restored'}.`);await loadUsers();});}finally{banSubmit.disabled=false;}};
  // The Users page keeps its search, account type and page in the hash (#users?users.q=…&users.page=2) so Back returns to them.
  const usersState=hashState(window,{prefix:'users'});
  function writeUsersState(options){usersState.set({q:$('admin-user-search').value.trim(),type:userAccountType==='wallet'?'wallet':'',page:userPage?userPage+1:0},options);}
  function readUsersState(){const q=usersState.get('q'),type=usersState.get('type'),page=Number(usersState.get('page'));if(q)$('admin-user-search').value=q.slice(0,64);if(type==='wallet')userAccountType='wallet';if(Number.isSafeInteger(page)&&page>1)userPage=page-1;}
  $('admin-users-manual').onclick=()=>{userAccountType='password';userPage=0;renderUsers();writeUsersState();};
  $('admin-users-wallet').onclick=()=>{userAccountType='wallet';userPage=0;renderUsers();writeUsersState();};
  async function loadUsers(){if(!permitted()||usersBusy)return;usersBusy=true;$('admin-users-refresh').disabled=true;const generation=revision;try{const data=await api('/api/admin/accounts');if(!permitted()||generation!==revision)return;users=Array.isArray(data.accounts)?data.accounts:[];setBadge('users',users.length);renderUsers();}catch(error){if(generation===revision)message(error.message,true);}finally{if(generation===revision){usersBusy=false;$('admin-users-refresh').disabled=false;}}}
  async function loadHusher(){if(!permitted()||!toolkitEnabled())return;const generation=revision;try{const data=await api('/api/account/connections/husher');if(!permitted()||generation!==revision)return;$('admin-husher-state').textContent=data.configured?'Key configured':'Not configured';$('admin-husher-note').textContent='Verify your identity to reveal the saved key or set a replacement.';}catch(error){if(generation===revision)$('admin-husher-state').textContent='Connection unavailable';}}
  async function husherAction(mode){
    if(!permitted()||!toolkitEnabled())return;const key=$('admin-husher-key').value.trim();if(mode==='save'&&!key){$('admin-husher-note').textContent='Paste a Husher API key first.';return;}
    $('admin-husher-save').disabled=$('admin-husher-reveal').disabled=true;const version=++husherRevision;
    try{await protectedAction(mode==='reveal'?'Reveal the private Husher key':'Update the Husher funding key',async credentials=>{const data=await api('/api/account/connections/husher',{action:mode,...(mode==='save'?{apiKey:key}:{}),...credentials});if(!permitted()||version!==husherRevision)return;
      if(mode==='reveal'){$('admin-husher-key').value=typeof data.apiKey==='string'?data.apiKey:'';$('admin-husher-key').type='text';$('admin-husher-clear').hidden=false;$('admin-husher-note').textContent='Visible in this administrator session. Clears automatically after one minute.';window.clearTimeout(husherTimer);husherTimer=window.setTimeout(clearKey,60000);}else{clearKey();$('admin-husher-state').textContent='Key configured';$('admin-husher-note').textContent='Husher key verified and saved.';message('Husher funding connection updated.');}});}finally{$('admin-husher-save').disabled=$('admin-husher-reveal').disabled=false;}
  }
  function sessionPanel(user){
    const root=$('admin-session-detail');root.replaceChildren(el('h3',user.username));const controls=el('div',null,'admin-session-controls');
    const chainLabel=el('label','Network'),chain=el('select');chain.id='admin-session-chain';for(const [value,label]of [['solana','Solana'],['robinhood','Robinhood']]){const option=el('option',label);option.value=value;chain.append(option);}chainLabel.append(chain);
    const kindLabel=el('label','Tool'),kind=el('select');kind.id='admin-session-kind';for(const [value,label]of Object.entries(tools)){const option=el('option',label);option.value=value;kind.append(option);}kindLabel.append(kind);const refresh=el('button','Refresh','small-button');refresh.type='button';refresh.id='admin-session-detail-refresh';controls.append(chainLabel,kindLabel,refresh);root.append(controls,el('p','Loading activity…','admin-session-state'),el('div',null,'admin-session-metrics'),el('ol',null,'admin-session-events'));const running=(user.sessions||[]).find(row=>row.state!=='stopped');if(running){chain.value=running.chain;kind.value=running.kind;}chain.onchange=kind.onchange=()=>{detailRevision++;loadDetail(true);};refresh.onclick=()=>loadDetail(true);
  }
  async function loadDetail(force=false){
    if(!permitted()||activeSection!=='users'||!toolkitEnabled()||!chosen||detailBusy)return;const generation=revision,request=++detailRevision,id=chosen.id,chain=$('admin-session-chain')?.value,kind=$('admin-session-kind')?.value;if(!chain||!kind)return;detailBusy=true;const refresh=$('admin-session-detail-refresh');if(refresh)refresh.disabled=true;
    try{const data=await api('/api/admin/session?'+new URLSearchParams({accountId:id,chain,kind}));if(!permitted()||generation!==revision||request!==detailRevision||id!==chosen?.id)return;const root=$('admin-session-detail');root.querySelector('.admin-session-state').textContent=`${data.state||'Unknown'} · ${chain==='solana'?'Solana':'Robinhood'} · ${tools[kind]} · ${new Date(data.exportedAt||Date.now()).toLocaleTimeString()}`;root.querySelector('.admin-session-metrics').replaceChildren(...[['Open positions',openPositionCount(data.positions||[])],['Pending',(data.pending||[]).length],['Confirmed',data.metrics?.confirmed??data.metrics?.fills??'—']].map(([label,value])=>{const item=el('div');item.append(el('span',label),el('strong',value));return item;}));const events=(data.events||[]).slice(0,15).map(event=>{const item=el('li');const time=Number(event.at)>0?new Date(Number(event.at)).toLocaleString():'Recent activity';item.append(el('small',`${time} · ${event.level||'info'}`),el('p',event.message||'Activity recorded'));return item;});root.querySelector('.admin-session-events').replaceChildren(...(events.length?events:[el('li','No retained activity for this tool.','admin-muted')]));
    }catch(error){if(generation===revision&&request===detailRevision){const status=$('admin-session-detail').querySelector('.admin-session-state');if(status)status.textContent=error.message;}}
    finally{if(generation===revision){detailBusy=false;if(refresh)refresh.disabled=false;if(permitted()&&activeSection==='users'&&request!==detailRevision)loadDetail(true);}}
  }
  async function loadSessions(page=sessionPage){
    if(!permitted()||!toolkitEnabled()||sessionsBusy)return;sessionsBusy=true;const generation=revision,request=++sessionRevision;try{const data=await api('/api/admin/sessions?'+new URLSearchParams({page:String(page),search:$('admin-session-search').value.trim()}));if(!permitted()||generation!==revision||request!==sessionRevision)return;sessionPage=Number(data.page)||0;const rows=(data.users||[]).map(user=>{const button=el('button',user.username);button.type='button';button.setAttribute('aria-pressed',String(user.id===chosen?.id));button.append(el('small',`${(user.sessions||[]).filter(row=>row.state!=='stopped').length} active tools`));button.onclick=()=>{chosen=user;detailRevision++;for(const sibling of $('admin-session-users').children)sibling.setAttribute('aria-pressed',String(sibling===button));sessionPanel(user);loadDetail(true);};return button;});$('admin-session-users').replaceChildren(...(rows.length?rows:[el('p','No matching users.','admin-muted')]));const pages=$('admin-session-pages');pages.replaceChildren();const pageSize=Number(data.pageSize)||50;if(Number(data.total)>pageSize){const prev=el('button','Previous','small-button'),next=el('button','Next','small-button');prev.type=next.type='button';prev.disabled=sessionPage===0;next.disabled=(sessionPage+1)*pageSize>=Number(data.total);prev.onclick=()=>loadSessions(sessionPage-1);next.onclick=()=>loadSessions(sessionPage+1);pages.append(prev,el('span',`${sessionPage+1} / ${Math.ceil(data.total/pageSize)}`),next);}}
    catch(error){if(generation===revision)message(error.message,true);}finally{if(generation===revision)sessionsBusy=false;}
  }
  // A module page is active while its section is selected and the page is the one shown (or the section shows one page).
  function pageActive(section,key){if(disposed||activeSection!==section)return false;const view=$('admin-panel-'+section)?.dataset.adminView||'';return !view||view===key;}
  // Opens the visible page's modules and pauses the hidden ones. A page opened before reuses fresh data:
  // polling modules only restart their timer (show), one-time modules keep their content until a refresh.
  function openPages(section,{force=false}={}){
    const loads=[];
    for(const [key,modules] of Object.entries(pageModules[section]||{})){
      const id=section+'/'+key;
      if(!pageActive(section,key)){for(const module of modules)module.pause?.();if(force&&loadedPages.has(id))stalePages.add(id);continue;}
      const first=!loadedPages.has(id),stale=stalePages.delete(id);loadedPages.add(id);
      for(const module of modules){
        if(first)loads.push(module.load());
        else if(force||stale)loads.push(module.reload?module.reload():module.load());
        else if(!onceModules.has(module))loads.push(module.show?module.show():module.load());
      }
    }
    return loads;
  }
  async function loadSection(section=activeSection,{force=false,pagesOnly=false}={}){
    if(!permitted()||section!==activeSection)return;
    const first=!loadedSections.has(section);
    loadedSections.add(section);
    const loads=[];
    // Section-wide content; pagesOnly is a page change inside an open section.
    if(!pagesOnly){
      if(section==='overview'){
        if(first||force)loads.push(loadOverview());
      }else if(section==='revenue'){
        if((first||force)&&toolkitEnabled())loads.push(loadOverview({wallets:true}));
        loads.push(diagnosticsAdmin.load());
      }else if(section==='pairs'){
        loads.push(pairsAdmin.load());
      }else if(section==='pump-test'){
        loads.push(pumpTestAdmin.load());
      }else if(section==='users'){
        if(first)readUsersState();
        if(first||force)loads.push(loadUsers(),loadSessions());
        if(chosen)loads.push(loadDetail());
      }else if(section==='settings'&&!TENANT&&(first||force))loads.push(brandingAdmin.load(),loadHusher());
    }
    loads.push(...openPages(section,{force}));
    const panel=$('admin-panel-'+section);sectionBusy.set(section,(sectionBusy.get(section)||0)+1);panel?.setAttribute('aria-busy','true');
    try{await Promise.allSettled(loads);}finally{const left=(sectionBusy.get(section)||1)-1;sectionBusy.set(section,left);if(!left)panel?.removeAttribute('aria-busy');}
    if(section==='pump-test'&&section===activeSection&&!disposed)applyView(section);
    if(section===activeSection&&!disposed)requestTopbarSync();
  }
  async function refresh(){
    if(!permitted())return;
    const section=activeSection,generation=revision;$('admin-refresh').disabled=true;
    try{await loadSection(section,{force:true});}finally{if(generation===revision&&section===activeSection)$('admin-refresh').disabled=false;}
  }
  // The part of the hash after "?" belongs to the page shown (its filter and page number) and is left to it.
  const hashParts=()=>{const raw=String(window.location?.hash||'').slice(1),at=raw.indexOf('?');return {base:at>=0?raw.slice(0,at):raw,query:at>=0?raw.slice(at):''};};
  function sectionFromHash(){
    const hash=hashParts().base,[head,tail='']=hash.split('/');
    if(sectionKeys.includes(head)){const subs=SUBSECTIONS[head]||[];return {section:head,target:'',sub:subs.some(sub=>sub.key===tail)?tail:subs[0]?.key||''};}
    const section=sectionAliases[hash];return {section:section||'overview',target:section?hash:'',sub:section?subForTarget(section,hash):''};
  }
  // ---- Presentation: one page per tab, sidebar sub-navigation, transitions ----
  const reducedMotion=()=>{try{return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches===true;}catch{return false;}};
  const sectionLabel=section=>($('admin-'+section+'-nav')?.querySelector('.admin-tab-label')||$('admin-'+section+'-nav'))?.textContent||section;
  function subTargets(sub){return sub.targets.flatMap(target=>target.startsWith('.')?[...document.querySelectorAll(target)]:[$(target)]).filter(node=>node&&!node.closest?.('[data-admin-skip]'));}
  const robinhoodOn=()=>document.body?.dataset?.robinhood!=='off';
  const curveOnlyOff=sub=>tenantShows(sub);
  function availableSubs(section){return (SUBSECTIONS[section]||[]).filter(sub=>curveOnlyOff(sub)&&(!sub.toolkit||toolkitEnabled())&&(!sub.robinhood||robinhoodOn())&&subTargets(sub).length);}
  function subForTarget(section,target){return (SUBSECTIONS[section]||[]).find(sub=>sub.targets.includes(target))?.key||'';}
  function hashFor(section,sub,explicit=false){const subs=SUBSECTIONS[section]||[];return '#'+section+(sub&&(explicit||sub!==subs[0]?.key)?'/'+sub:'');}
  function setBadge(section,value){const tab=$('admin-'+section+'-nav');if(!tab)return;const number=Number(value);if(value===null||value===undefined||!Number.isFinite(number)||number<0){tab.removeAttribute('data-admin-count');return;}tab.dataset.adminCount=number>=10000?Math.floor(number/1000)+'k':number.toLocaleString('en-US');}
  function animate(node,name){if(!node||reducedMotion())return;node.classList.remove('admin-enter','admin-enter-forward','admin-enter-back');void node.offsetWidth;node.classList.add('admin-enter',name);node.addEventListener?.('animationend',()=>node.classList.remove('admin-enter',name),{once:true});}
  function centerInScroller(scroller,node){if(!scroller||!node||!(scroller.scrollWidth>scroller.clientWidth))return;const left=node.offsetLeft-(scroller.clientWidth-node.offsetWidth)/2;scroller.scrollTo?.({left:Math.max(0,left),behavior:reducedMotion()?'auto':'smooth'});}
  // The sidebar lists every section's pages in collapsible groups (desktop); on narrow screens the active
  // section's pages are a row of chips under the tab bar (#admin-subnav). Both come from SUBSECTIONS.
  function positionSubnav(){}
  function pageLink(section,sub,current){const link=el('a',null,'admin-subnav-link');link.href=hashFor(section,sub.key,true);link.dataset.adminSubLink=sub.key;link.append(el('span',sub.label));if(current)link.setAttribute('aria-current','page');link.onclick=event=>{if(event&&(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||event.button>0))return;event?.preventDefault();return section===activeSection?selectSub(sub.key):selectSection(section,{sub:sub.key});};return link;}
  const openGroups=new Set();try{for(const key of JSON.parse(window.localStorage?.getItem('curve-admin-groups')||'[]'))if(sectionKeys.includes(key))openGroups.add(key);}catch{/* no stored preference */}
  function rememberGroups(){try{window.localStorage?.setItem('curve-admin-groups',JSON.stringify([...openGroups]));}catch{/* storage unavailable */}}
  // Launch modes creates its pages when first opened, so its group lists them from the catalogue.
  const groupSubs=section=>section==='pump-test'?(SUBSECTIONS[section]||[]).filter(sub=>curveOnlyOff(sub)&&(!sub.toolkit||toolkitEnabled())&&(!sub.robinhood||robinhoodOn())):availableSubs(section);
  function renderGroups(){
    for(const section of sectionKeys){
      const group=document.querySelector('[data-admin-group="'+section+'"]'),pages=document.querySelector('[data-admin-group-pages="'+section+'"]'),toggle=document.querySelector('[data-admin-group-toggle="'+section+'"]'),tab=$('admin-'+section+'-nav');
      if(!group||!pages||!tab)continue;
      const subs=tab.hidden?[]:groupSubs(section),current=section===activeSection?currentView(section):'',expanded=subs.length>1&&(section===activeSection||openGroups.has(section));
      group.hidden=tab.hidden;group.dataset.expanded=String(expanded);group.dataset.active=String(section===activeSection);
      if(toggle){toggle.hidden=subs.length<2;toggle.setAttribute('aria-expanded',String(expanded));toggle.setAttribute('aria-label',(expanded?'Hide ':'Show ')+sectionLabel(section)+' pages');toggle.disabled=section===activeSection;}
      const signature=subs.map(sub=>sub.key+':'+(sub.key===current)).join(',');
      if(pages.dataset.signature!==signature){pages.dataset.signature=signature;pages.replaceChildren(...subs.map(sub=>pageLink(section,sub,sub.key===current)));}
      pages.hidden=!expanded||subs.length<2;
    }
  }
  for(const toggle of document.querySelectorAll('[data-admin-group-toggle]'))toggle.onclick=()=>{const key=toggle.dataset.adminGroupToggle;if(key===activeSection)return;if(openGroups.has(key))openGroups.delete(key);else openGroups.add(key);rememberGroups();renderGroups();};
  let subnavSignature='';
  function renderSubnav(section,key,subs){
    const nav=$('admin-subnav');if(!nav)return;
    if(subs.length<2){nav.hidden=true;nav.replaceChildren();subnavSignature='';return;}
    const signature=section+'|'+subs.map(sub=>sub.key).join(',');
    if(signature!==subnavSignature){
      subnavSignature=signature;nav.setAttribute('aria-label',sectionLabel(section)+' pages');
      nav.replaceChildren(...subs.map(sub=>pageLink(section,sub,false)));
      nav.hidden=false;animate(nav,'admin-enter-forward');
    }
    for(const link of nav.children){if(link.dataset.adminSubLink===key)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}
    centerInScroller(nav,nav.querySelector('[aria-current]'));
  }
  // The sticky top bar carries the page's one-line summary (data-admin-summary on its card) and mirrors its
  // primary actions ([data-admin-page-action] buttons or links), so they are reachable without scrolling.
  const topbarProxies=new Map();
  function pageRoots(section,key){const sub=(SUBSECTIONS[section]||[]).find(item=>item.key===key);return sub?subTargets(sub):[$('admin-panel-'+section)].filter(Boolean);}
  function syncTopbar(){
    if(disposed)return;const section=activeSection,roots=pageRoots(section,currentView(section)),summary=$('admin-topbar-summary'),tools=$('admin-topbar-tools');
    // Only changed values are written: the observer below watches these attributes too.
    const set=(node,prop,value)=>{if(node&&node[prop]!==value)node[prop]=value;};
    const line=permitted()?roots.map(root=>root?.dataset?.adminSummary||'').find(Boolean)||'':'';
    if(summary){set(summary,'textContent',line);set(summary,'hidden',!line);}
    if(!tools)return;
    const actions=permitted()?roots.flatMap(root=>[...root.querySelectorAll('[data-admin-page-action]')]):[],wanted=new Set(actions);
    for(const [source,proxy] of topbarProxies)if(!wanted.has(source)){proxy.remove();topbarProxies.delete(source);}
    for(const source of actions){
      let proxy=topbarProxies.get(source);
      if(!proxy){proxy=el(source.tagName==='A'?'a':'button',null,'small-button admin-topbar-action');if(source.tagName==='A')proxy.href=source.getAttribute('href')||'#';else{proxy.type='button';proxy.onclick=()=>{source.click?.();};}topbarProxies.set(source,proxy);tools.append(proxy);}
      set(proxy,'textContent',source.textContent);proxy.classList.toggle('admin-primary',source.classList.contains('admin-primary'));proxy.classList.toggle('admin-danger',source.classList.contains('admin-danger'));
      set(proxy,'disabled',source.disabled===true);set(proxy,'hidden',source.hidden===true||!!source.closest?.('[hidden]'));
    }
    set(tools,'hidden',![...tools.children].some(node=>!node.hidden));
  }
  let topbarSync=false;const requestTopbarSync=()=>{if(topbarSync)return;topbarSync=true;Promise.resolve().then(()=>{topbarSync=false;syncTopbar();});};
  const topbarObserver=window.MutationObserver?new window.MutationObserver(records=>{if(records.some(record=>!record.target?.closest?.('.admin-topbar')))requestTopbarSync();}):null;
  topbarObserver?.observe($('admin-main'),{attributes:true,subtree:true,attributeFilter:['data-admin-summary','disabled','hidden']});
  function applyView(section,requested='',{motion=''}={}){
    const panel=$('admin-panel-'+section);if(!panel)return '';
    const subs=availableSubs(section),has=key=>subs.some(sub=>sub.key===key),before=panel.dataset.adminView||'';
    for(const sub of SUBSECTIONS[section]||[])for(const node of subTargets(sub)){node.dataset.adminSub=sub.key;node.classList.remove('admin-sub-current');}
    if(requested&&!has(requested)&&(SUBSECTIONS[section]||[]).some(sub=>sub.key===requested))lastSub[section]=requested;
    let key='';
    if(subs.length>1){
      key=has(requested)?requested:has(lastSub[section])?lastSub[section]:subs[0].key;
      if(has(requested)||!lastSub[section]||has(lastSub[section]))lastSub[section]=key;
      panel.dataset.adminView=key;
      const chosen=subs.find(sub=>sub.key===key);
      for(const node of subTargets(chosen)){node.classList.add('admin-sub-current');if(chosen.open&&node.tagName==='DETAILS'&&!node.open)node.open=true;}
      if(motion==='sub'&&before&&before!==key){const order=subs.map(sub=>sub.key);for(const node of subTargets(chosen))animate(node,order.indexOf(key)>=order.indexOf(before)?'admin-enter-forward':'admin-enter-back');}
    }else panel.removeAttribute('data-admin-view');
    if(section===activeSection){
      renderSubnav(section,key,subs);
      $('admin-topbar-section').textContent=key?sectionLabel(section):'Admin panel';
      $('admin-topbar-title').textContent=key?subs.find(sub=>sub.key===key).label:sectionLabel(section);
      renderGroups();requestTopbarSync();
    }
    return key;
  }
  function revealContent(){const top=$('admin-main').getBoundingClientRect?.().top;if(top<0)$('admin-main').scrollIntoView?.({block:'start',behavior:reducedMotion()?'auto':'smooth'});}
  function pushHash(hash){if(window.location?.hash===hash)return;if(window.history?.pushState)window.history.pushState(null,'',hash);else if(window.location)window.location.hash=hash.slice(1);}
  function replaceHash(hash){if(window.location?.hash===hash)return;if(window.history?.replaceState)window.history.replaceState(null,'',hash);}
  // A section hash naming a page that is unavailable here (#users/activity without the toolkit, #pump-test
  // without the owner capability) is rewritten to the page actually shown. Legacy card links are left as they are.
  function normaliseHash(section,view){const {base,query}=hashParts();if(!sectionKeys.includes(base.split('/')[0]))return;const canonical=hashFor(section,view);if('#'+base!==canonical)replaceHash(canonical+query);}
  const currentView=section=>$('admin-panel-'+section)?.dataset.adminView||'';
  // Each page remembers where it was scrolled to, so coming back lands on the same rows.
  const scrollMemory=new Map();
  function rememberScroll(){const y=Number(window.scrollY);if(Number.isFinite(y)&&y>=0)scrollMemory.set(activeSection+'/'+currentView(activeSection),y);}
  function restoreScroll(key){const y=scrollMemory.get(key);if(y>0&&typeof window.scrollTo==='function')window.scrollTo({top:y,behavior:'auto'});}
  function selectSub(sub,{updateHash=true,target=''}={}){
    if(disposed||!permitted())return;
    rememberScroll();
    const before=currentView(activeSection),key=applyView(activeSection,sub,{motion:'sub'});
    if(updateHash)pushHash(hashFor(activeSection,key));else normaliseHash(activeSection,key);
    if(target)$(target)?.scrollIntoView?.({block:'start'});else if(updateHash)revealContent();
    // Only the shown page loads and polls: open the new page and pause the one left.
    if(key!==before){message();const section=activeSection;void loadSection(section,{pagesOnly:loadedSections.has(section)}).then(()=>{if(!target&&updateHash&&section===activeSection&&currentView(section)===key)restoreScroll(section+'/'+key);});}
  }
  async function selectSection(section,{updateHash=true,focus=false,target='',sub=''}={}){
    if(!sectionKeys.includes(section)||disposed)return;
    if((section==='pump-test'&&!pumpTestAllowed)||(section==='settings'&&TENANT)){section='overview';target='';sub='';}
    const changed=section!==activeSection,before=currentView(section);if(changed&&permitted())rememberScroll();activeSection=section;
    for(const key of sectionKeys){const selected=key===section,tab=$('admin-'+key+'-nav');$('admin-panel-'+key).hidden=!selected;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;}
    $('admin-refresh').disabled=false;
    if(changed){message();clearKey();if(section!=='overview'){volumeAdmin.pause?.();}if(section!=='revenue'){revenueAdmin.pause?.();revenueAuditAdmin.pause?.();treasuryAdmin.pause?.();burnHistoryAdmin.pause?.();gasAdmin.pause?.();diagnosticsAdmin.pause?.();}if(section!=='pairs')pairsAdmin.pause?.();if(section!=='tokens'){gotchiAdmin.pause?.();agentsAdmin.pause?.();pumpClassicAdmin.pause?.();robinhoodAdmin.pause?.();vanityAdmin.pause?.();cleanupAdmin?.pause?.();}if(section!=='pump-test')pumpTestAdmin.pause?.();}
    const view=applyView(section,sub||subForTarget(section,target),{motion:changed?'':'sub'});
    if(!changed&&view!==before)message();
    if(changed)animate($('admin-panel-'+section),'admin-enter-forward');
    centerInScroller(document.querySelector('.admin-tabs'),$('admin-'+section+'-nav'));
    if(updateHash)pushHash(hashFor(section,view));else normaliseHash(section,view);
    if(focus)$('admin-'+section+'-nav').focus();
    if(changed&&updateHash&&!target&&permitted())revealContent();
    await loadSection(section);
    if(target&&section===activeSection&&permitted())$(target)?.scrollIntoView?.({block:'start'});
    else if(changed&&updateHash&&section===activeSection&&permitted())restoreScroll(section+'/'+currentView(section));
  }
  // Sticky offsets follow the real header and top bar heights (the top bar grows with its summary line).
  function updateHeaderOffset(){const height=document.querySelector('.app-header')?.getBoundingClientRect?.().height;if(height>0)document.documentElement.style.setProperty('--admin-header-height',Math.ceil(height)+'px');const bar=document.querySelector('.admin-topbar')?.getBoundingClientRect?.().height;if(bar>0)document.body?.style?.setProperty?.('--admin-topbar-height',Math.ceil(bar)+'px');positionSubnav();}
  // A hash that names no admin section or card (the shell's skip link targets #admin-workspace) leaves the view as it is.
  const adminHash=raw=>!raw||sectionKeys.includes(raw.split('/')[0])||Object.hasOwn(sectionAliases,raw);
  const hashChanged=()=>{if(!adminHash(hashParts().base))return;const {section,target,sub}=sectionFromHash();if(section===activeSection&&loadedSections.has(section)&&permitted()&&(sub||target)){selectSub(sub,{updateHash:false,target});return;}void selectSection(section,{updateHash:false,target,sub});};
  // The gate's links open sign-in (?signin=1) or the account (?account=overview) on this page; once the shell
  // has opened that dialog the query is dropped so a reload does not open it again.
  function dropAccountQuery(){const search=String(window.location?.search||'');if(!/[?&](?:signin|account)=/.test(search)||!window.history?.replaceState)return;const params=new URLSearchParams(search);params.delete('signin');params.delete('account');const rest=params.toString();window.history.replaceState(null,'',String(window.location.pathname||'/admin')+(rest?'?'+rest:'')+String(window.location.hash||''));}
  async function initialize(){
    if(initializing||disposed)return;initializing=true;const generation=revision;try{const session=await api('/api/session');if(disposed||generation!==revision)return;if(account?.id&&session.account?.id!==account.id)gate('Checking administrator access…');account=session.account||null;csrf=session.token||'';features=session.features||{};renderFeatures();shell({page:'admin',session});dropAccountQuery();updateHeaderOffset();$('admin-security-open').hidden=!account||account.role!=='admin';
      if(!session.authenticated){gate('Sign in with your administrator account to manage Launchpad.');return;}
      if(account?.role!=='admin'){gate('This page is available to the platform administrator.',{signedIn:true});return;}
      security.render();if(!account.mfaEnabled){gate('Enable two-factor authentication to unlock your admin panel.',{mfa:true,signedIn:true});return;}
      if(!session.monitorAllowed){gate('Sign in again with your authenticator to unlock administration.',{signedIn:true});return;}
      allowed=true;revision++;setPumpTestAccess(session.pumpTestAllowed,{fallback:false});$('admin-gate').hidden=true;$('admin-main').hidden=false;const {section,target,sub}=sectionFromHash();await selectSection(section,{updateHash:false,target,sub});positionSubnav();
    }catch(error){if(!disposed&&generation===revision)gate(error.message);}finally{initializing=false;}
  }
  const getAdminAccount=()=>permitted()?account:null;
  security=securityFactory({api,dialog:$('admin-security-dialog'),getAccount:()=>account,refresh:initialize,message:securityMessage});
  launchAdmin=launchFactory({api,security,message,getAccount:getAdminAccount,isActive:()=>pageActive('tokens','launches')});$('admin-launch-panel').append(launchAdmin.element);
  // Presentation: mirror the Tokens list's own active-coin count as a sidebar badge.
  const activeCoins=launchAdmin.element.querySelector?.('[data-view=active]'),coinObserver=activeCoins&&window.MutationObserver?new window.MutationObserver(()=>{const match=/\((\d[\d,]*)\)/.exec(activeCoins.textContent||'');setBadge('tokens',match&&permitted()?Number(match[1].replace(/,/g,'')):null);}):null;coinObserver?.observe(activeCoins,{childList:true,characterData:true,subtree:true});
  cleanupAdmin=cleanupFactory({document,api,security,message,getAccount:getAdminAccount,ownerAllowed:()=>pumpTestAllowed,isActive:()=>pageActive('tokens','cleanup'),setTimer,clearTimer});$('admin-launches').after(cleanupAdmin.element);
  protocolAdmin=protocolFactory({document,api,security,message,getAccount:getAdminAccount});$('admin-platform').before(protocolAdmin.element);
  brandingAdmin=brandingFactory({document,api,security,message,getAccount:getAdminAccount});$('admin-integrations').before(brandingAdmin.element);
  // Launchpads: platform branding and the funding connection are set by the host, so Settings has no pages.
  if(TENANT)$('admin-settings-nav').hidden=true;
  revenueAdmin=revenueFactory({document,api,getAccount:getAdminAccount,getFeatures:()=>features,isActive:()=>pageActive('revenue','report'),setTimer,clearTimer});$('admin-platform').before(revenueAdmin.element);
  volumeAdmin=volumeFactory({document,api,getAccount:getAdminAccount,isActive:()=>pageActive('overview','volume'),setTimer,clearTimer});$('admin-overview').after(volumeAdmin.element);
  revenueAuditAdmin=revenueAuditFactory({document,api,getAccount:getAdminAccount,isActive:()=>pageActive('revenue','checks'),setTimer,clearTimer});$('admin-platform').before(revenueAuditAdmin.element);
  healthAdmin=createAdminHealth({document,api,getAccount:getAdminAccount,isActive:()=>pageActive('overview','health'),setTimer,clearTimer});volumeAdmin.element.after(healthAdmin.element);
  treasuryAdmin=treasuryFactory({document,api,security,message,getAccount:getAdminAccount,isActive:()=>pageActive('revenue','treasury'),onConfigured:()=>protocolAdmin.load(),setTimer,clearTimer});protocolAdmin.element.after(treasuryAdmin.element);
  burnHistoryAdmin=burnHistoryFactory({document,api,protectedAction,getAccount:getAdminAccount,isActive:()=>pageActive('revenue','burns')});treasuryAdmin.element.after(burnHistoryAdmin.element);
  gasAdmin=gasFactory({document,api,security,message,getAccount:getAdminAccount,isActive:()=>pageActive('revenue','gas'),setTimer,clearTimer});burnHistoryAdmin.element.after(gasAdmin.element);
  // Owner-only pages: without the owner capability these modules see no account, so they stay empty and never call the API.
  const ownerAccount=()=>pumpTestAllowed?getAdminAccount():null;
  gotchiAdmin=gotchiFactory({document,api,security,message,getAccount:ownerAccount,isActive:()=>pageActive('tokens','gotchi'),setTimer,clearTimer});$('admin-launches').after(gotchiAdmin.element);
  agentsAdmin=agentsFactory({document,api,security,message,getAccount:ownerAccount,isActive:()=>pageActive('tokens','agents'),setTimer,clearTimer});gotchiAdmin.element.after(agentsAdmin.element);
  pumpClassicAdmin=pumpClassicFactory({document,api,security,message,getAccount:ownerAccount,isActive:()=>pageActive('tokens','pump-fun'),setTimer,clearTimer});agentsAdmin.element.after(pumpClassicAdmin.element);
  robinhoodAdmin=robinhoodFactory({document,api,security,message,getAccount:ownerAccount,isActive:()=>pageActive('tokens','robinhood'),setTimer,clearTimer});pumpClassicAdmin.element.after(robinhoodAdmin.element);
  vanityAdmin=vanityFactory({document,api,security,message,getAccount:ownerAccount,isActive:()=>pageActive('tokens','vanity'),setTimer,clearTimer});robinhoodAdmin.element.after(vanityAdmin.element);
  // Each owner-only page shows a short notice in place of its module for administrators without the owner capability.
  for(const module of ownerModules()){const card=el('section',null,'admin-card admin-owner-only');card.id=module.element.id+'-owner-only';card.hidden=true;card.append(el('p',module.element.querySelector('.eyebrow')?.textContent||'OWNER TOOLS','eyebrow'),el('h2',module.element.querySelector('h2')?.textContent||'Owner tools'),el('p',OWNER_ONLY_TEXT,'help'));module.element.after(card);ownerNotices.set(module,card);}
  pairsAdmin=pairsFactory({document,api,security,message,getAccount:getAdminAccount,isActive:()=>activeSection==='pairs'});$('admin-panel-pairs').append(pairsAdmin.element);
  // Presentation: mirror the catalogue's own "Pairs added here · N" summary as a sidebar badge.
  const pairsSummary=pairsAdmin.element.querySelector?.('#admin-pairs-catalog>summary'),pairsObserver=pairsSummary&&window.MutationObserver?new window.MutationObserver(()=>{const match=/·\s*(\d[\d,]*)\s*$/.exec(pairsSummary.textContent||'');setBadge('pairs',match&&permitted()&&!pairsAdmin.element.hidden?Number(match[1].replace(/,/g,'')):null);}):null;pairsObserver?.observe(pairsSummary,{childList:true,characterData:true,subtree:true});
  diagnosticsAdmin=diagnosticsFactory({document,window,api,getAccount:getAdminAccount,isActive:()=>activeSection==='revenue'});gasAdmin.element.after(diagnosticsAdmin.element);
  pumpTestAdmin=pumpTestFactory({document,api,getAccount:()=>pumpTestAllowed?getAdminAccount():null,isActive:()=>pumpTestAllowed&&activeSection==='pump-test',onUnavailable:()=>setPumpTestAccess(false)});$('admin-panel-pump-test').append(pumpTestAdmin.element);
  pageModules={overview:{volume:[volumeAdmin],health:[healthAdmin]},revenue:{fees:[protocolAdmin],treasury:[treasuryAdmin],burns:[burnHistoryAdmin],gas:[gasAdmin],report:[revenueAdmin],checks:[revenueAuditAdmin]},tokens:{launches:[launchAdmin],cleanup:[cleanupAdmin],gotchi:[gotchiAdmin],agents:[agentsAdmin],'pump-fun':[pumpClassicAdmin],robinhood:[robinhoodAdmin],vanity:[vanityAdmin]}};
  // Loaded once per administrator session (and on Refresh section); they do not poll.
  onceModules.add(protocolAdmin);onceModules.add(launchAdmin);
  for(const [index,section]of sectionKeys.entries()){
    const tab=$('admin-'+section+'-nav');
    tab.onclick=event=>{if(event&&(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||event.button>0))return;event?.preventDefault();return selectSection(section);};
    tab.onkeydown=event=>{if(tab.hidden)return;const visible=sectionKeys.filter(key=>!$('admin-'+key+'-nav').hidden),position=visible.indexOf(section);let next;if(event.key==='ArrowRight'||event.key==='ArrowDown')next=(position+1)%visible.length;else if(event.key==='ArrowLeft'||event.key==='ArrowUp')next=(position+visible.length-1)%visible.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=visible.length-1;else if(event.key===' '){event.preventDefault();return selectSection(section);}else return;event.preventDefault();return selectSection(visible[next],{focus:true});};
  }
  const headerObserver=window.ResizeObserver?new window.ResizeObserver(updateHeaderOffset):null;
  if(headerObserver){headerObserver.observe(document.querySelector('.app-header'));const bar=document.querySelector('.admin-topbar');if(bar)headerObserver.observe(bar);}
  window.addEventListener?.('resize',updateHeaderOffset);
  window.addEventListener?.('hashchange',hashChanged);
  window.addEventListener?.('popstate',hashChanged);
  const openSecurity=()=>{if(!account||account.role!=='admin')return;securityMessage();security.render();$('admin-security-dialog').showModal();};$('admin-security-open').onclick=$('admin-gate-security').onclick=openSecurity;$('admin-security-close').onclick=()=>$('admin-security-dialog').close();$('admin-access-refresh').onclick=initialize;$('admin-refresh').onclick=refresh;$('admin-users-refresh').onclick=loadUsers;$('admin-user-search').oninput=()=>{userPage=0;renderUsers();writeUsersState();};$('admin-husher-form').onsubmit=event=>{event.preventDefault();return husherAction('save');};$('admin-husher-reveal').onclick=()=>husherAction('reveal');$('admin-husher-clear').onclick=clearKey;$('admin-session-search-form').onsubmit=event=>{event.preventDefault();return loadSessions(0);};
  // ---- Presentation: quick jump palette (Ctrl/Cmd+K). Navigation only. ----
  const commandDialog=$('admin-command'),commandInput=$('admin-command-input'),commandList=$('admin-command-list');let commandItems=[],commandIndex=0;
  // Coins and users from the server, for queries of two characters or more (debounced; the newest query wins).
  let commandRemote={query:'',items:[],timer:null,generation:0};
  const venueName=route=>route==='pump-classic'?'Pump.fun':route==='robinhood'?'Robinhood Chain':route==='meteora'?'Meteora':route==='pumpswap'||route==='damm-pump'?'PumpSwap':'Raydium';
  function scheduleRemote(query){
    if(commandRemote.timer!==null){window.clearTimeout(commandRemote.timer);commandRemote.timer=null;}
    if(query.length<2||!permitted()){commandRemote={...commandRemote,query:'',items:[]};return;}
    if(query===commandRemote.query)return;
    commandRemote.timer=window.setTimeout(async()=>{
      commandRemote.timer=null;const generation=++commandRemote.generation,q=query;
      const results=await Promise.allSettled([api('/api/admin/launches?'+new URLSearchParams({search:q,offset:'0',limit:'6',view:'all'})),api('/api/admin/accounts?'+new URLSearchParams({search:q,offset:'0',limit:'6'}))]);
      if(disposed||generation!==commandRemote.generation||!commandDialog.open||commandInput.value.trim()!==q)return;
      const items=[],launches=results[0].status==='fulfilled'&&Array.isArray(results[0].value?.launches)?results[0].value.launches:[],users=results[1].status==='fulfilled'&&Array.isArray(results[1].value?.accounts)?results[1].value.accounts:[];
      for(const row of launches.slice(0,6)){if(typeof row?.id!=='string')continue;items.push({coin:row,label:(row.symbol?'$'+String(row.symbol).slice(0,24)+' · ':'')+String(row.name||'Unnamed').slice(0,60),parent:'Coin · '+venueName(row.route)+(row.username?' · '+String(row.username).slice(0,32):''),terms:''});}
      for(const user of users.slice(0,6)){if(typeof user?.username!=='string')continue;items.push({user,label:user.username.slice(0,40),parent:'User · '+(user.authType==='wallet'?'wallet':'manual')+(user.banned?' · banned':user.role==='admin'?' · administrator':''),terms:''});}
      commandRemote={...commandRemote,query:q,items};renderCommands();
    },220);
  }
  function commandEntries(){
    const entries=[];
    for(const section of sectionKeys){
      if($('admin-'+section+'-nav').hidden)continue;const label=sectionLabel(section);
      entries.push({section,sub:'',label,parent:'Section',terms:SECTION_TERMS[section]||''});
      for(const sub of SUBSECTIONS[section]||[]){if(!curveOnlyOff(sub)||sub.toolkit&&!toolkitEnabled()||section!=='pump-test'&&!subTargets(sub).length)continue;entries.push({section,sub:sub.key,label:sub.label,parent:label,terms:sub.terms||''});}
    }
    entries.push({action:'refresh',label:'Refresh this section',parent:'Action',terms:'reload update'},{action:'security',label:'Account security',parent:'Action',terms:'two-factor authenticator password mfa'});
    return entries;
  }
  function highlightCommand(){for(const node of commandList.children){if(node.getAttribute('role')!=='option')continue;const on=node.dataset.index===String(commandIndex);node.setAttribute('aria-selected',String(on));if(on){commandInput.setAttribute('aria-activedescendant',node.id);node.scrollIntoView?.({block:'nearest'});}}}
  function renderCommands(){
    const query=commandInput.value.trim().toLowerCase(),words=query.split(/\s+/).filter(Boolean);
    commandItems=commandEntries().map((entry,order)=>{const label=entry.label.toLowerCase(),text=(entry.label+' '+entry.parent+' '+entry.terms).toLowerCase();if(words.some(word=>!text.includes(word)))return null;return {entry,order,score:!query?0:label.startsWith(query)?0:label.split(/[^a-z0-9]+/).some(word=>word.startsWith(words[0]))?1:label.includes(query)?2:3};}).filter(Boolean).sort((a,b)=>a.score-b.score||a.order-b.order).map(item=>item.entry);
    if(query.length>=2&&commandRemote.query===query)commandItems.push(...commandRemote.items);
    commandIndex=Math.min(commandIndex,Math.max(0,commandItems.length-1));commandInput.removeAttribute('aria-activedescendant');
    commandList.replaceChildren(...(commandItems.length?commandItems.map((entry,index)=>{const item=el('li',null,'admin-command-item'+(entry.sub?' is-page':'')+(entry.coin?' is-coin':'')+(entry.user?' is-user':''));item.id='admin-command-item-'+index;item.dataset.index=String(index);item.setAttribute('role','option');item.append(el('span',entry.label,'admin-command-label'),el('span',entry.parent,'admin-command-meta'));item.onmousemove=()=>{if(commandIndex!==index){commandIndex=index;highlightCommand();}};item.onclick=()=>runCommand(entry);return item;}):[el('li','No matching sections.','admin-command-empty')]));
    highlightCommand();
  }
  // Opens with the page being viewed already selected, so Enter (or a tap elsewhere) starts from where you are.
  function openCommands(){if(!permitted()||$('admin-main').hidden||commandDialog.open)return;commandInput.value='';commandRemote={query:'',items:[],timer:null,generation:commandRemote.generation};const view=currentView(activeSection);commandIndex=Math.max(0,commandEntries().findIndex(entry=>entry.section===activeSection&&(entry.sub||'')===view));renderCommands();commandDialog.showModal?.();highlightCommand();commandInput.focus();}
  function closeCommands(){if(commandDialog.open)commandDialog.close();}
  async function runCommand(entry){
    closeCommands();if(entry.action==='refresh')return refresh();if(entry.action==='security')return openSecurity();
    if(entry.coin){await selectSection('tokens',{sub:'launches'});if(permitted()&&typeof launchAdmin.find==='function')await launchAdmin.find(String(entry.coin.mint||entry.coin.symbol||entry.coin.name||''),{row:entry.coin});return;}
    if(entry.user){userAccountType=entry.user.authType==='wallet'?'wallet':'password';userPage=0;await selectSection('users',{sub:'accounts'});if(!permitted())return;$('admin-user-search').value=entry.user.username;userPage=0;renderUsers();return;}
    return entry.section===activeSection&&entry.sub?selectSub(entry.sub):selectSection(entry.section,{sub:entry.sub});
  }
  commandInput.oninput=()=>{commandIndex=0;scheduleRemote(commandInput.value.trim());renderCommands();};
  commandInput.onkeydown=event=>{const count=commandItems.length;if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();if(count){commandIndex=(commandIndex+(event.key==='ArrowDown'?1:count-1))%count;highlightCommand();}}else if(event.key==='Home'||event.key==='End'){if(!count)return;event.preventDefault();commandIndex=event.key==='Home'?0:count-1;highlightCommand();}else if(event.key==='Enter'){event.preventDefault();if(commandItems[commandIndex])runCommand(commandItems[commandIndex]);}else if(event.key==='Escape'){event.preventDefault();closeCommands();}};
  commandDialog.addEventListener('click',event=>{if(event.target===commandDialog)closeCommands();});
  $('admin-command-open').onclick=$('admin-command-mobile').onclick=openCommands;if($('admin-command-close'))$('admin-command-close').onclick=closeCommands;
  if(/Mac|iPhone|iPad/.test(window.navigator?.platform||''))$('admin-command-open').querySelector('kbd').textContent='⌘K';
  const commandShortcut=event=>{if(!(event.ctrlKey||event.metaKey)||event.altKey||String(event.key).toLowerCase()!=='k'||!permitted()||$('admin-main').hidden||document.querySelector('dialog[open]:not(#admin-command)'))return;event.preventDefault();event.stopPropagation?.();if(commandDialog.open)closeCommands();else openCommands();};
  document.addEventListener('keydown',commandShortcut,true);
  // "Back to top" appears once the top of the panel has scrolled 400px out of view (no scroll handler: an observer on a sentinel).
  const backToTop=$('admin-back-to-top'),topSentinel=$('admin-top-sentinel');
  const topObserver=backToTop&&topSentinel&&window.IntersectionObserver?new window.IntersectionObserver(entries=>{for(const entry of entries)backToTop.hidden=entry.isIntersecting||$('admin-main').hidden||!permitted();},{rootMargin:'400px 0px 0px 0px'}):null;
  topObserver?.observe(topSentinel);
  if(backToTop)backToTop.onclick=()=>{window.scrollTo?.({top:0,behavior:reducedMotion()?'auto':'smooth'});backToTop.hidden=true;};
  // Keyboard: "/" focuses the page's search (or opens the palette), "?" opens the palette, j/k move between rows,
  // "o" opens or closes the focused row, Esc leaves the rows. Never while typing or while a dialog is open.
  let rowCursor=null;
  const typing=target=>{const tag=target?.tagName;return tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'||target?.isContentEditable===true;};
  const pageSearch=()=>{for(const root of pageRoots(activeSection,currentView(activeSection))){const input=[...root.querySelectorAll('input[type=search]')].find(node=>!node.hidden&&!node.disabled&&!node.closest('[hidden]'));if(input)return input;}return null;};
  const pageRowsList=()=>pageRoots(activeSection,currentView(activeSection)).flatMap(root=>[...root.querySelectorAll('details.launch-admin-row,details.admin-launch-row,.admin-cleanup-row,.admin-user-row,.admin-gotchi-card,details.admin-protocol-coin,.admin-inbox-item')]).filter(node=>!node.closest('[hidden]')&&(node.tagName==='DETAILS'||!node.closest('details.admin-launch-row')));
  const shortcutKeys=event=>{
    if(!permitted()||$('admin-main').hidden||event.ctrlKey||event.metaKey||event.altKey||document.querySelector('dialog[open]')||typing(event.target))return;
    const key=event.key;
    if(key==='/'){event.preventDefault();const input=pageSearch();if(input){input.focus?.();input.select?.();}else openCommands();return;}
    if(key==='?'){event.preventDefault();openCommands();return;}
    if(key==='j'||key==='k'){const rows=pageRowsList();if(!rows.length)return;event.preventDefault();const active=document.activeElement,current=rows.findIndex(row=>row===rowCursor||(active&&row.contains(active)));const index=current<0?(key==='j'?0:rows.length-1):Math.min(rows.length-1,Math.max(0,current+(key==='j'?1:-1)));rowCursor=rows[index];const focusable=rowCursor.tagName==='DETAILS'?rowCursor.querySelector(':scope>summary'):rowCursor.querySelector('a,button,input,[tabindex]')||rowCursor;if(focusable&&focusable.tagName!=='SUMMARY'&&!focusable.hasAttribute('tabindex')&&!/^(A|BUTTON|INPUT)$/.test(focusable.tagName))focusable.tabIndex=-1;focusable?.focus?.();rowCursor.scrollIntoView?.({block:'nearest'});return;}
    if(key==='o'&&rowCursor?.tagName==='DETAILS'){event.preventDefault();rowCursor.open=!rowCursor.open;return;}
    if(key==='Escape'&&rowCursor){rowCursor=null;document.activeElement?.blur?.();}
  };
  document.addEventListener('keydown',shortcutKeys);
  $('admin-message-close').onclick=()=>$('admin-message').parentElement?.classList.remove('is-live');
  const visibility=()=>{if(document.hidden)clearKey();};document.addEventListener('visibilitychange',visibility);const timer=setTimer(()=>{if(!document.hidden&&permitted()&&pageActive('users','activity')&&toolkitEnabled()&&chosen&&!action)loadDetail();},15000);
  const accountUpdated=event=>{
    if(disposed||!event.detail||!Object.hasOwn(event.detail,'account'))return;
    const next=event.detail.account;
    if(!next){account=null;csrf='';$('admin-security-open').hidden=true;gate('Your session ended. Sign in again.');return;}
    if(account?.id&&next.id!==account.id){account=null;csrf='';$('admin-security-open').hidden=true;gate('Your account changed. Refresh before continuing.');return;}
    account=next;if(typeof event.detail.token==='string'&&event.detail.token)csrf=event.detail.token;
    if(account.role!=='admin'||!account.mfaEnabled){$('admin-security-open').hidden=account.role!=='admin';gate('Administrator access with two-factor authentication is required.',{signedIn:true});return;}
    if(Object.hasOwn(event.detail,'pumpTestAllowed'))setPumpTestAccess(event.detail.pumpTestAllowed);
    security.render();if(!allowed)void initialize();
  };
  document.addEventListener('curve-account-updated',accountUpdated);
  function destroy(){if(disposed)return;disposed=true;coinObserver?.disconnect();pairsObserver?.disconnect();allowed=false;revision++;loadedSections.clear();headerObserver?.disconnect();window.removeEventListener?.('resize',updateHeaderOffset);window.removeEventListener?.('hashchange',hashChanged);window.removeEventListener?.('popstate',hashChanged);clearTimer(timer);clearKey();launchAdmin.clear();protocolAdmin.clear();brandingAdmin.clear();revenueAdmin.destroy();volumeAdmin.destroy();revenueAuditAdmin.destroy();healthAdmin.destroy();treasuryAdmin.destroy();burnHistoryAdmin.destroy();gasAdmin.destroy();gotchiAdmin.destroy();agentsAdmin?.destroy();pumpClassicAdmin?.destroy();robinhoodAdmin?.destroy();vanityAdmin?.destroy();pairsAdmin.destroy();diagnosticsAdmin.destroy();pumpTestAdmin.destroy();cleanupAdmin?.destroy();topbarObserver?.disconnect();topObserver?.disconnect();document.removeEventListener('keydown',shortcutKeys);for(const controller of controllers)controller.abort();controllers.clear();document.removeEventListener('visibilitychange',visibility);document.removeEventListener('curve-account-updated',accountUpdated);document.removeEventListener('keydown',commandShortcut,true);closeCommands();if($('security-auth')?.open)$('security-auth').close();if($('admin-security-dialog').open)$('admin-security-dialog').close();}
  window.addEventListener?.('pagehide',event=>{clearKey();if(!event.persisted)destroy();});
  return {ready:initialize(),refresh,initialize,selectSection,loadDetail,loadSessions,destroy};
}
if(typeof document!=='undefined'&&document.body.dataset.page==='admin')createAdminPage({document,window});
