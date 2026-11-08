import { openPositionCount } from './ui-performance.mjs';
import { chainToolHref, robinhoodEnabled } from './chains.mjs';
import { mountExploreHeaderSearch } from './explore-search.mjs';
import { mountCurvePriceBadge } from './curve-price-badge.mjs';
import { mountSiteTape } from './site-tape.mjs';

const tools = [
  ['terminal','Markets','Charts and your trading activity','M3 17l5-5 4 3 8-11M14 4h6v6'],
  ['copy','Copy trading','Follow target wallets','M8 8h12v12H8zM4 16H3V3h13v1'],
  ['sniper','Launch sniper','Watch new token launches','M12 3v3m0 12v3M3 12h3m12 0h3M18 12a6 6 0 11-12 0 6 6 0 0112 0z'],
  ['liquidity','Liquidity manager','Manage pools and earned fees','M12 3C9 7 5 11 5 15a7 7 0 0014 0c0-4-4-8-7-12z'],
  ['market','Market maker','Manage your inventory','M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4'],
];
const publicAccounts=new WeakMap(),publicSignIns=new WeakMap(),publishedSessions=new WeakMap(),shellSessions=new WeakMap(),openedAccountRoutes=new WeakSet(),navigationSessions=new WeakSet(),accountMenus=new WeakMap(),documentMenus=new WeakMap(),headerAccountViews=new WeakMap();
function publishAccount(next){publishedSessions.set(document,next);document.dispatchEvent(new document.defaultView.CustomEvent('curve-account-updated',{detail:next}));}
async function openSignIn(source){
 let entry=publicSignIns.get(document);if(!entry){entry=import('./signin-overlay.mjs').then(({createSignInOverlay})=>createSignInOverlay({document,window:document.defaultView,onSession:publishAccount,getFeatures:()=>shellSessions.get(document)?.features||{}}));publicSignIns.set(document,entry);}
 try{(await entry).open(source);}catch{source.title='Could not open sign in. Please try again.';publicSignIns.delete(document);}
}
async function openPublicAccount(session,source){
  let entry=publicAccounts.get(document);
  if(!entry){entry=import('./account-overlay.mjs').then(({createAccountOverlay})=>createAccountOverlay({document,window:document.defaultView,onAccount:publishAccount}));publicAccounts.set(document,entry);}
  try{await(await entry).open(session,source);}catch{source.title='Could not open your account. Please try again.';publicAccounts.delete(document);}
}
const element=(tag,text,cls)=>{const el=document.createElement(tag);if(text)el.textContent=text;if(cls)el.className=cls;return el;};
function icon(path) {
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.classList.add('tool-icon');
  const shape=document.createElementNS(svg.namespaceURI,'path');shape.setAttribute('d',path);svg.append(shape);return svg;
}
const motion=target=>{
  if(!target?.animate||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  target.getAnimations().forEach(animation=>animation.cancel());
  target.animate([{opacity:.55,transform:'translateY(5px)'},{opacity:1,transform:'translateY(0)'}],{duration:180,easing:'cubic-bezier(.2,.8,.2,1)'});
};
export function renderHeaderAccount(control, account) {
  if (!control) return;
  const label=account?.username;
  const avatarPath=/^\/token-images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(account?.avatar||'')?account.avatar:'';
  const key=JSON.stringify([label||'',avatarPath,accountMenus.has(control)]),previous=headerAccountViews.get(control);
  // Route mounts and session refreshes reuse the loaded avatar and text. Keep
  // the real profile-change/sign-out path, and tolerate legacy control edits.
  if(previous?.key===key&&previous.nodes.length===control.childNodes.length&&previous.nodes.every((node,index)=>node===control.childNodes[index]))return;
  control.classList.toggle('header-account',Boolean(label));
  control.replaceChildren();
  if(label){
    const avatar=element('span',String(label).slice(0,1).toUpperCase(),'header-account-avatar');
    avatar.setAttribute('aria-hidden','true');
    if(avatarPath){
      const image=element('img');image.src=avatarPath;image.alt='';image.width=24;image.height=24;
      image.onerror=()=>{image.remove();avatar.textContent=String(label).slice(0,1).toUpperCase();};avatar.replaceChildren(image);
    }
    control.append(avatar,element('span',label,'header-account-name'));
    if(accountMenus.has(control)){const chevron=icon('M6 9l6 6 6-6');chevron.classList.add('header-account-chevron');control.append(chevron);}
  }else control.textContent='Connect wallet';
  control.title=label||'Connect wallet';
  control.setAttribute('aria-label',label?(accountMenus.has(control)?'Profile menu for ':'Open account for ')+label:'Connect wallet');
  headerAccountViews.set(control,{key,nodes:[...control.childNodes]});
}
function mountAccountMenu(control,session){
  const owner=control.ownerDocument;
  let menu=accountMenus.get(control);
  const previous=documentMenus.get(owner);if(previous&&previous.control!==control)previous.destroy();
  if(menu){menu.session=session;if(control.onclick!==menu.toggle){menu.openAccount=control.onclick;control.onclick=menu.toggle;}menu.close();return menu;}
  const wrapper=element('div',null,'header-profile-menu'),panel=element('div',null,'header-profile-dropdown');
  const edit=element('a','Edit profile'),tokens=element('a','My Tokens'),logout=element('button','Sign out'),message=element('p',null,'header-profile-message');
  edit.href='/?account=overview';edit.dataset.accountEdit='true';tokens.href='/launched-tokens';tokens.dataset.accountTokens='true';
  logout.type='button';logout.dataset.accountLogout='true';message.hidden=true;message.setAttribute('role','alert');
  const entries=[edit,tokens,logout];
  panel.id='header-profile-dropdown';panel.hidden=true;panel.setAttribute('role','menu');panel.setAttribute('aria-label','Profile');
  for(const entry of entries){entry.setAttribute('role','menuitem');entry.tabIndex=-1;panel.append(entry);}panel.append(message);
  control.before(wrapper);wrapper.append(control,panel);
  if(control.tagName==='A')control.setAttribute('role','button');
  control.setAttribute('aria-haspopup','menu');control.setAttribute('aria-expanded','false');control.setAttribute('aria-controls',panel.id);
  function close(returnFocus=false){panel.hidden=true;control.setAttribute('aria-expanded','false');for(const entry of entries)entry.tabIndex=-1;if(returnFocus)control.focus();}
  function open(index){panel.hidden=false;control.setAttribute('aria-expanded','true');for(const entry of entries)entry.tabIndex=0;if(Number.isInteger(index))entries[index].focus();}
  function toggle(event){if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||event.button>0)return;event.preventDefault();event.stopImmediatePropagation();if(panel.hidden)open();else close();}
  function triggerKey(event){
    if(['ArrowDown','ArrowUp','Enter',' '].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();if(['Enter',' '].includes(event.key)&&!panel.hidden)close();else open(event.key==='ArrowUp'?entries.length-1:0);}
    else if(event.key==='Escape'&&!panel.hidden){event.preventDefault();event.stopImmediatePropagation();close(true);}
  }
  function panelKey(event){
    const index=entries.indexOf(owner.activeElement),count=entries.length;
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);}
    else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();entries[event.key==='Home'?0:event.key==='End'?count-1:event.key==='ArrowDown'?(index+1+count)%count:(index-1+count)%count].focus();}
  }
  function outside(event){if(!wrapper.contains(event.target))close();}
  function focusOut(event){if(event.relatedTarget&&!wrapper.contains(event.relatedTarget))close();}
  function editProfile(event){
    if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||event.button>0)return;
    event.preventDefault();close();
    // Toolkit pages retain their own account/security dialogs and connection state.
    if(!control.hasAttribute('data-account-link')&&typeof menu.openAccount==='function')menu.openAccount.call(control,event);
    else void openPublicAccount(menu.session,control);
  }
  async function signOut(event){
    event.preventDefault();if(logout.disabled)return;
    logout.disabled=true;logout.textContent='Signing out…';message.hidden=true;message.textContent='';
    const accountId=menu.session.account?.id;
    try{
      // Security changes can rotate the session token while this menu is closed.
      // Use the existing logout endpoint with its current, same-origin CSRF token.
      const sessionResponse=await fetch('/api/session',{credentials:'same-origin',cache:'no-store'}),fresh=await sessionResponse.json();
      if(!sessionResponse.ok)throw Error('Could not check your session. Please try again.');
      if(fresh.authenticated){
        if(accountId&&fresh.account?.id!==accountId)throw Error('Your account changed. Refresh the page and try again.');
        if(!fresh.token)throw Error('Could not verify your session. Refresh the page and try again.');
        const response=await fetch('/api/account/logout',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-control-token':fresh.token},body:'{}'});
        if(!response.ok&&response.status!==401){const value=await response.json().catch(()=>({}));throw Error(value.error||'Could not sign out. Please try again.');}
      }
      owner.dispatchEvent(new owner.defaultView.CustomEvent('curve-account-updated',{detail:{authenticated:false,account:null,token:''}}));
      // Reload clears page-local account data and wallet connections just like
      // the original profile sign-out flow; server-side runs remain untouched.
      owner.defaultView.location.reload();
    }catch(error){message.textContent=error.message||'Could not sign out. Please try again.';message.hidden=false;open();}
    finally{logout.disabled=false;logout.textContent='Sign out';}
  }
  edit.onclick=editProfile;tokens.addEventListener('click',()=>close());
  logout.onclick=signOut;
  control.addEventListener('keydown',triggerKey,true);panel.addEventListener('keydown',panelKey);wrapper.addEventListener('focusout',focusOut);owner.addEventListener('click',outside);
  menu={control,session,close,toggle,openAccount:control.onclick,destroy(){close();if(control.onclick===toggle)control.onclick=menu.openAccount;control.removeEventListener('keydown',triggerKey,true);owner.removeEventListener('click',outside);wrapper.removeEventListener('focusout',focusOut);panel.removeEventListener('keydown',panelKey);for(const name of ['aria-haspopup','aria-expanded','aria-controls'])control.removeAttribute(name);if(control.tagName==='A')control.removeAttribute('role');wrapper.before(control);wrapper.remove();accountMenus.delete(control);if(documentMenus.get(owner)===menu)documentMenus.delete(owner);}};
  control.onclick=toggle;
  accountMenus.set(control,menu);documentMenus.set(owner,menu);return menu;
}
function syncAccountNavigation(session) {
  shellSessions.set(document,session||{});
  const account=session?.authenticated===false?null:session?.account;
  for(const link of document.querySelectorAll('[data-account-link]')){
    if(account?.username)mountAccountMenu(link,session);else accountMenus.get(link)?.destroy();
    renderHeaderAccount(link,account);
    link.href=account?'/?account=overview':'/?signin=1';
    if(!account?.username)link.onclick=event=>{if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();if(account)openPublicAccount(session,link);else openSignIn(link);};
  }
  for(const id of ['account-button','rh-account']){const control=document.getElementById(id);if(!control)continue;if(account?.username)mountAccountMenu(control,session);else accountMenus.get(control)?.destroy();renderHeaderAccount(control,account);}
  for(const link of document.querySelectorAll('[data-account-connection]')){
    if(link.tagName==='A')link.href=account?.authType==='wallet'?'/wallet-account':'/trade?account=connections';
  }
  for(const link of document.querySelectorAll('[data-signin-link]')){
    link.href='/?signin=1';
    link.onclick=event=>{if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();openSignIn(link);};
  }
  const toolkit=document.querySelector('.relay-toolkit'),toolkitEnabled=session?.features?.toolkit===true;
  document.body.dataset.toolkit=String(toolkitEnabled);
  if(toolkit){toolkit.hidden=!toolkitEnabled;if(!toolkitEnabled){toolkit.open=false;toolkit.querySelector('summary')?.setAttribute('aria-expanded','false');}}
  const local=document.querySelector('.app-header .local');
  if(account?.role!=='admin'){
    for(const link of document.querySelectorAll('.header-admin,.toolkit-admin'))link.remove();
    const owner=document.getElementById('owner-sessions');if(owner)owner.hidden=true;
  }else if(local&&!local.querySelector('.header-admin')){
    const shortcut=document.getElementById('owner-sessions')||element('a');shortcut.href='/admin';shortcut.hidden=false;
    shortcut.className='small-button header-admin';shortcut.setAttribute('aria-label','Admin panel');shortcut.title='Admin panel';shortcut.replaceChildren(icon('M12 3l8 4v6c0 5-8 8-8 8s-8-3-8-8V7zM9 12l2 2 4-4'),element('span','Admin panel'));
    if(['admin','sessions'].includes(document.body.dataset.page))shortcut.setAttribute('aria-current','page');
    const accountLink=local.querySelector('[data-account-link],#account-button,#rh-account');
    if(accountLink)(accountLink.closest('.header-profile-menu')||accountLink).before(shortcut);else local.append(shortcut);
  }
  // Modified-click links and old account bookmarks reopen the same launchpad
  // overlay after the session has loaded; they never enter a trading tool.
  if(typeof session?.authenticated==='boolean'&&!openedAccountRoutes.has(document)){
    const query=new URL(globalThis.location?.href||document.defaultView.location?.href||'http://localhost/').searchParams;
    if(query.get('signin')==='1'||query.get('account')==='overview'){
      openedAccountRoutes.add(document);
      const source=document.querySelector('[data-account-link],#account-button,#rh-account');
      if(source){if(account)void openPublicAccount(session,source);else void openSignIn(source);}
    }
  }
}
// The chain toggle (v71.42): Solana | Robinhood with the chains' marks, right after the brand on every page. On the
// home page it filters the market (the page answers `curve-chain-selected` and prevents the default); on the launch
// page it picks the chain step; anywhere else it opens the home page on that chain. The choice is remembered under
// the home page's key, and `data-chain` on <body> hides the Solana-only entries (Gotchi, Agents) on Robinhood.
export const CHAIN_PREF_KEY='curve.explore.chain';
export const SITE_CHAINS=Object.freeze([['solana','Solana','/solana-chain.svg'],['robinhood','Robinhood','/robinhood-chain.svg']]);
export function rememberedSiteChain(document){try{const value=document.defaultView?.localStorage?.getItem(CHAIN_PREF_KEY);return value==='robinhood'||value==='solana'?value:'all';}catch{return 'all';}}
export function applySiteChain(document,chain){
  const value=chain==='robinhood'||chain==='solana'?chain:'all';
  document.body.dataset.chain=value;
  for(const button of document.querySelectorAll('.site-chain-toggle [data-chain]'))button.setAttribute('aria-pressed',String(button.dataset.chain===value));
  return value;
}
export function selectSiteChain(document,chain){
  const value=chain==='robinhood'?'robinhood':'solana';
  try{document.defaultView?.localStorage?.setItem(CHAIN_PREF_KEY,value);}catch{/* a convenience */}
  applySiteChain(document,value);
  const EventType=document.defaultView?.CustomEvent||globalThis.CustomEvent;
  const unhandled=document.dispatchEvent(new EventType('curve-chain-selected',{detail:{chain:value},cancelable:true,bubbles:false}));
  if(unhandled&&document.defaultView?.location)document.defaultView.location.href='/?chain='+value;
}
export function mountChainToggle({document,container,chain}={}){
  if(!container)return null;
  // v71.43: a host with Robinhood Chain off has nothing to toggle; the body stays on Solana.
  if(!robinhoodEnabled(document)){container.querySelector('.site-chain-toggle')?.remove();applySiteChain(document,'solana');return null;}
  let nav=container.querySelector('.site-chain-toggle');
  if(!nav){
    nav=document.createElement('nav');nav.className='site-chain-toggle';nav.setAttribute('aria-label','Chain');
    for(const [id,label,src] of SITE_CHAINS){const button=document.createElement('button');button.type='button';button.dataset.chain=id;button.title=label+' coins';button.setAttribute('aria-pressed','false');const img=document.createElement('img');img.src=src;img.width=18;img.height=18;img.alt='';const text=document.createElement('span');text.textContent=label;button.append(img,text);button.addEventListener('click',()=>selectSiteChain(document,id));nav.append(button);}
    const brand=container.querySelector('.brand');if(brand)brand.after(nav);else container.prepend(nav);
    if(!chainListeners.has(document)){chainListeners.add(document);document.addEventListener('curve-chain-applied',event=>applySiteChain(document,event.detail?.chain));}
  }
  // A later mount (the session arriving) keeps what the page applied meanwhile; the stored choice seeds the first one.
  applySiteChain(document,chain||document.body.dataset.chain||rememberedSiteChain(document));
  return nav;
}
const chainListeners=new WeakSet();
// Gotchi Mode entry: first in the header's local group, between the search
// field and the $LAUNCHPAD price badge, on every page that mounts the shell.
export function mountGotchiNav({document,container,page}={}){
  if(!container)return null;
  let link=container.querySelector('.gotchi-nav');
  if(!link){link=document.createElement('a');link.className='gotchi-nav';link.href='/gotchi';link.dataset.workspaceTool='gotchi';link.title='Gotchi Mode';link.setAttribute('aria-label','Gotchi Mode');
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.classList.add('tool-icon');
    for(const d of ['M12 3c4.4 0 7.5 3.1 7.5 7.2V13a7.5 7.5 0 0 1-15 0v-2.8C4.5 6.1 7.6 3 12 3z','M9 11h.01M15 11h.01','M9.5 15c1.4 1.2 3.6 1.2 5 0','M7 5 5 2M17 5l2-3']){const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',d);svg.append(path);}
    const label=document.createElement('span');label.textContent='Gotchi';link.append(svg,label);}
  if(page==='gotchi')link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
  container.prepend(link);return link;
}
// AI Agents entry: directly after the Gotchi entry, so Gotchi keeps its place.
export function mountAgentsNav({document,container,page}={}){
  if(!container)return null;
  let link=container.querySelector('.agents-nav');
  if(!link){link=document.createElement('a');link.className='agents-nav';link.href='/agents';link.dataset.workspaceTool='agents';link.title='AI Agents';link.setAttribute('aria-label','AI Agents');
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.classList.add('tool-icon');
    for(const d of ['M7 8h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3z','M9 13h.01M15 13h.01','M12 8V4','M9.5 17c1.4-1 3.6-1 5 0']){const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',d);svg.append(path);}
    const label=document.createElement('span');label.textContent='Agents';link.append(svg,label);}
  if(page==='agents')link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
  const gotchi=container.querySelector('.gotchi-nav');if(gotchi)gotchi.after(link);else container.prepend(link);return link;
}
function skipToContent(event){
  if(event.defaultPrevented||event.button>0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
  const owner=event.currentTarget?.ownerDocument||document,target=owner.querySelector('main:not([hidden])');if(!target)return;
  event.preventDefault();if(!target.hasAttribute('tabindex'))target.tabIndex=-1;target.focus();
}
function footerSocialHref(value){try{const url=new URL(String(value||''));return url.protocol==='https:'&&!url.username&&!url.password?url.href:'';}catch{return '';}}
export function createSiteFooter(){
  let footer=[...document.body.children].find(node=>node.tagName==='FOOTER');
  if(footer?.classList.contains('site-footer'))return footer;
  footer ||= element('footer');footer.className='site-footer';footer.hidden=false;
  const inner=element('div',null,'site-footer-inner'),brand=element('a','Launchpad.','site-footer-brand');brand.href='/';brand.setAttribute('aria-label','Launchpad home');
  const nav=element('nav',null,'site-footer-links');nav.setAttribute('aria-label','Information');
  for(const [text,href]of [['Analytics','/analytics'],['Docs','/docs'],['Terms of Service','/terms'],['Privacy Policy','/privacy']]){const link=element('a',text);link.href=href;if(href==='/'+document.body.dataset.page)link.setAttribute('aria-current','page');nav.append(link);}
  inner.append(brand,nav);
  // The platform's X profile when the host sets one (LAUNCHPAD_X_URL, or a white-label launchpad's own link).
  const x=footerSocialHref(document.body.dataset.brandX||document.body.dataset.linkX);
  if(x){const social=element('a','X','site-footer-social');social.href=x;social.target='_blank';social.rel='noopener noreferrer';social.title='Launchpad on X';social.setAttribute('aria-label','Launchpad on X (opens in a new tab)');inner.append(social);}
  footer.replaceChildren(inner);document.body.append(footer);return footer;
}
export function createWorkspaceShell({chain='solana',nav,session,openConnections,page}={}) {
  if(!navigationSessions.has(document)){
    const owner=document;navigationSessions.add(owner);
    owner.addEventListener('curve-navigation-start',()=>{publishedSessions.delete(owner);documentMenus.get(owner)?.close();});
    // Pages publish sign-in, sign-out, session expiry and profile edits as a
    // session object. It replaces the header's account at once, including one
    // saved earlier on this page (for example at sign-in).
    owner.addEventListener('curve-account-updated',event=>{
      const detail=event.detail;if(!detail||typeof detail!=='object'||(!Object.hasOwn(detail,'account')&&detail.authenticated!==false))return;
      const next={...(shellSessions.get(owner)||{}),...detail};
      if(!detail.account||typeof detail.account!=='object'||detail.authenticated===false){next.account=null;next.authenticated=false;next.token='';}
      else if(detail.authenticated!==true)next.authenticated=true;
      publishedSessions.set(owner,next);syncAccountNavigation(next);
    });
  }
  // A page's initial session fetch may finish after local sign-in or profile edits.
  // Each new route fetches a fresh session; a prior route's published account
  // must not override a later expiry/sign-out response from the server.
  session=publishedSessions.get(document)||session||shellSessions.get(document)||{};
  createSiteFooter();
  if(document.querySelector('.app-header')?.dataset.shellMounted==='true'){const launch=document.querySelector('.top-launch');if(launch){if(page==='launchpad')launch.setAttribute('aria-current','page');else launch.removeAttribute('aria-current');}mountExploreHeaderSearch({document,container:document.querySelector('.workspace-header-inner')});mountChainToggle({document,container:document.querySelector('.workspace-header-inner')});if(document.body?.dataset.product!=='tenant')mountCurvePriceBadge({document,container:document.querySelector('.app-header .local')});mountGotchiNav({document,container:document.querySelector('.app-header .local'),page});mountSiteTape({document});syncAccountNavigation(session);return;}
  const $=id=>document.getElementById(id),header=document.querySelector('.app-header');
  if(!header)return;
  document.body.dataset.shell='true';document.body.dataset.navigation='top';header.dataset.shellMounted='true';
  const brand=header.querySelector('.brand')||element('a',null,'brand');brand.href='/';brand.setAttribute('aria-label','Launchpad home');
  const logo=element('img');logo.src='/brand-icon.svg?v=54';logo.alt='';logo.width=38;logo.height=38;logo.className='mark';
  const wordmark=element('span','Launchpad');wordmark.append(element('span','.','brand-dot'));brand.replaceChildren(logo,wordmark);
  const base=chainToolHref(chain,'terminal');
  if(!nav){nav=element('nav',null,'static-tools');for(const [kind,label,,path]of tools){const a=element('a',null);a.href=kind==='terminal'?base:`${base}?tool=${kind}`;a.dataset.tool=kind;a.append(icon(path),element('span',label));nav.append(a);}}
  nav.classList.add('workspace-navigation');nav.setAttribute('aria-label','Toolkit');nav.id ||= 'workspace-tools';
  {const a=element('a',null);a.href=chainToolHref(chain,'funding');a.dataset.workspaceTool='funding';a.append(icon('M4 6h16v14H4zM4 10h16M13 15h4'),element('span','Funding'));nav.append(a);}
  for(const button of nav.children){
    const kind=button.dataset.terminal?'terminal':button.dataset.kind||button.dataset.tab||button.dataset.tool;
    const tool=tools.find(t=>t[0]===kind);if(!tool)continue;
    const svg=button.querySelector('svg')||icon(tool[3]);button.replaceChildren(svg,element('span',tool[1]));button.title=tool[2];button.setAttribute('aria-label',tool[1]);button.dataset.workspaceTool=kind;
  }
  const launch=header.querySelector('.top-launch')||element('a',null,'top-launch');launch.replaceChildren();launch.href='/launchpad';launch.dataset.workspaceTool='launchpad';launch.append(icon('M12 5v14M5 12h14'),element('span','Launch on Launchpad'));launch.title='Create a coin on Launchpad';launch.setAttribute('aria-label','Launch on Launchpad');if(page==='launchpad')launch.setAttribute('aria-current','page');
  const toolkit=element('details',null,'relay-toolkit');toolkit.hidden=true;toolkit.open=false;
  const toolkitSummary=element('summary');toolkitSummary.setAttribute('aria-label','Toolkit');toolkitSummary.title='Toolkit';toolkitSummary.setAttribute('aria-controls',nav.id);toolkitSummary.setAttribute('aria-expanded','false');
  toolkitSummary.append(icon('M4 7h16v14H4zM8 7V3h8v4M4 12h16M10 12v3h4v-3'));const toolkitPanel=element('div',null,'toolkit-panel');toolkitPanel.append(nav);toolkit.append(toolkitSummary,toolkitPanel);
  const connections=element(openConnections?'button':'a');connections.dataset.accountConnection='true';connections.append(icon('M4 7h16M7 4v6M4 17h16m-5-3v6'),element('span','Connections'));
  if(openConnections){connections.type='button';connections.onclick=event=>{event.stopPropagation();closeToolkit();openConnections();};}else connections.href=session.account?.authType==='wallet'?'/wallet-account':'/trade?account=connections';
  const guide=element('a');guide.href='/tutorial';guide.append(icon('M4 4h7l1 2 1-2h7v16h-7l-1 1-1-1H4zM12 6v15'),element('span','Setup guide'));if(page==='guide')guide.setAttribute('aria-current','page');guide.dataset.workspaceTool='guide';nav.append(connections,guide);
  const chains=header.querySelector('.chain-switch');if(chains){const networks=element('div',null,'toolkit-networks');networks.append(element('span','Network'),chains);toolkitPanel.append(networks);}
  const local=header.querySelector('.local')||element('div',null,'local');
  // Legacy page shortcuts duplicate the common navigation; account/security controls remain.
  for(const link of [...header.querySelectorAll('a')])if(link!==brand&&!chains?.contains(link)&&!link.hasAttribute('data-account-link')&&link.id!=='owner-sessions'&&['/','/tutorial','/trade'].includes(link.getAttribute('href')))link.remove();
  local.querySelector('.explore-network')?.remove();
  local.prepend(launch,toolkit);
  if(!local.querySelector('[data-account-link],#account-button,#rh-account')){const account=element('a','Connect wallet','small-button');account.dataset.accountLink='true';account.href='/?signin=1';local.append(account);}
  const inner=header.querySelector('.workspace-header-inner')||element('div',null,'workspace-header-inner'),searchLabel=inner.querySelector('.header-search');inner.replaceChildren(brand,...(searchLabel?[searchLabel]:[]),local);header.replaceChildren(inner);
  mountExploreHeaderSearch({document,container:inner});
  mountChainToggle({document,container:inner});
  if(document.body?.dataset.product!=='tenant')mountCurvePriceBadge({document,container:local});
  mountGotchiNav({document,container:local,page});
  mountAgentsNav({document,container:local,page});
  mountSiteTape({document});
  syncAccountNavigation(session);
  const skip=element('a','Skip to workspace','skip-link');skip.href='#workspace-content';document.body.prepend(skip);
  const main=document.querySelector('main');if(main){main.id ||= 'workspace-content';skip.href='#'+main.id;main.tabIndex=-1;}
  // Focus the page content without changing the URL: pages that route by hash
  // (the admin panel) would read '#<main id>' as a different section.
  skip.addEventListener('click',skipToContent);
  function closeToolkit(returnFocus=false){toolkit.open=false;toolkitSummary.setAttribute('aria-expanded','false');if(returnFocus)toolkitSummary.focus();}
  toolkit.addEventListener('toggle',()=>toolkitSummary.setAttribute('aria-expanded',String(toolkit.open)));
  toolkitSummary.addEventListener('keydown',event=>{if(event.key==='ArrowDown'){event.preventDefault();toolkit.open=true;toolkitSummary.setAttribute('aria-expanded','true');nav.querySelector('a,button')?.focus();}});
  document.addEventListener('click',event=>{if(toolkit.open&&!toolkit.contains(event.target))closeToolkit();});
  toolkit.addEventListener('focusout',event=>{if(toolkit.open&&event.relatedTarget&&!toolkit.contains(event.relatedTarget))closeToolkit();});
  const search=$('token-search');
  if(search){
    $('token-load').textContent='Search';search.querySelector('label').textContent='Search a token';
    const hint=element('kbd','/','search-shortcut');hint.setAttribute('aria-hidden','true');search.querySelector('input').after(hint);
    const heading=document.querySelector('.terminal-heading');heading.querySelector('h1').textContent='Markets';heading.querySelector('.subtitle').textContent='Your markets, positions and trading tools.';
  }
  const current=()=>page||([...nav.children].find(b=>b.getAttribute('aria-pressed')==='true'||b.getAttribute('aria-selected')==='true')?.dataset.workspaceTool)||'terminal';
  let last=current();
  const chainLinks=[...document.querySelectorAll('.chain-switch a')].map(a=>[a,new URL(a.href,location.href).pathname==='/robinhood'?'robinhood':'solana']);
  const syncChainLinks=()=>{for(const [a,target] of chainLinks)a.href=chainToolHref(target,current());};
  for(const [a] of chainLinks)a.addEventListener('click',syncChainLinks);
  function sync(){const kind=current();for(const b of nav.children)b.classList.toggle('is-active',b.dataset.workspaceTool===kind);toolkitSummary.classList.toggle('toolkit-active',tools.some(t=>t[0]===kind)||['funding','guide'].includes(kind));syncChainLinks();if(kind!==last){last=kind;motion(kind==='terminal'?$('trade-terminal'):document.querySelector('.workspace'));}}
  nav.addEventListener('click',()=>requestAnimationFrame(sync));sync();
  nav.addEventListener('click',event=>{if(event.target.closest('a,button'))closeToolkit(event.target.closest('button')&&!document.querySelector('dialog[open]'));});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&toolkit.open&&!document.querySelector('dialog[open]')){closeToolkit(true);}});
  document.addEventListener('keydown',event=>{
    if(event.defaultPrevented||!search||event.altKey||document.querySelector('dialog[open]')||event.target.closest?.('input,textarea,select,[contenteditable=true]'))return;
    if(event.key==='/'||((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k')){event.preventDefault();nav.querySelector('[data-terminal]')?.click();$('token-contract').focus();}
  });
  document.addEventListener('toggle',event=>{
    if(!event.target.open)return;
    if(event.target.tagName==='DIALOG')motion(event.target);
    else if(event.target.tagName==='DETAILS')for(const child of event.target.children)if(child.tagName!=='SUMMARY')motion(child);
  },true);
  const summary=element('div',null,'workspace-summary');summary.setAttribute('aria-label','Workspace overview');
  const values={};
  if($('trade-terminal')){
    for(const [key,label]of [['active','Active tools'],['positions','Open positions'],['pending','Pending transactions'],['network','Network']]){const cell=element('div',null,'overview-stat');const value=element('strong','—');cell.append(element('span',label),value);summary.append(cell);values[key]=value;}
    values.network.textContent=chain==='solana'?'Solana':'Robinhood';values.network.className='overview-network';
    $('trade-terminal').querySelector('.terminal-search-heading').after(summary);
  }
  return {sync,update(overview){if(!values.active)return;const sessions=overview.sessions||[];const next={active:sessions.filter(s=>s.state!=='stopped').length,positions:sessions.reduce((n,s)=>n+openPositionCount(s.positions),0),pending:sessions.reduce((n,s)=>n+(s.pending?.length||0),0)};for(const [key,value]of Object.entries(next))if(values[key].textContent!==String(value))values[key].textContent=value;}};
}

if(typeof document!=='undefined'&&document.body.dataset.page==='guide'){
  fetch('/api/session').then(response=>response.ok?response.json():{}).catch(()=>({})).then(session=>createWorkspaceShell({page:'guide',session}));
}
