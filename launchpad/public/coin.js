import { createWorkspaceShell } from './workspace-shell.js';
import { createCoinPage } from './coin-view.mjs';
import { bootPage } from './navigation.mjs';
export function mountPage({document=globalThis.document,window=document.defaultView}={}){
  const params=new URLSearchParams(window.location.search),chain=(params.get('chain')||'').toLowerCase(),mint=(params.get('mint')||'').trim();
  // v71.39: a Robinhood Chain coin (?chain=robinhood, an EVM address) opens its own page module; Solana coins keep theirs.
  const robinhood=chain==='robinhood'||/^0x[0-9a-fA-F]{40}$/.test(mint);
  let page=null,pending=null;
  if(robinhood){
    const api=async path=>{const response=await fetch('/api/launchpad/robinhood'+path,{credentials:'same-origin',cache:'no-store'});let data;try{data=await response.json();}catch{throw Object.assign(Error('Market information is temporarily unavailable.'),{status:response.status});}if(!response.ok)throw Object.assign(Error(data?.error||'This coin could not be loaded.'),{status:response.status});return data;};
    pending=import('./robinhood-coin.mjs').then(async module=>{const wallets=await import('./evm-wallet.mjs');page=module.createRobinhoodCoinPage({document,window,request:api,token:mint,walletFactory:async()=>wallets.createEvmWallet({window})});return page;});
    createWorkspaceShell({page:'coin'});
  }
  else page=createCoinPage({document,window,shell:createWorkspaceShell});
  let sessionUpdated=false,disposed=false;const controller=new AbortController();
  const setSession=session=>{if(disposed)return;if(page)page.setSession(session);else pending?.then(p=>{if(!disposed)p.setSession(session);});};
  const update=event=>{sessionUpdated=true;setSession(event.detail);};
  document.addEventListener('curve-account-updated',update);
  fetch('/api/session',{credentials:'same-origin',cache:'no-store',signal:controller.signal}).then(response=>response.ok?response.json():{authenticated:false}).then(session=>{if(disposed||sessionUpdated)return;setSession(session);createWorkspaceShell({page:'coin',session});}).catch(()=>{});
  return {get coin(){return page?.coin;},setSession,destroy(){disposed=true;controller.abort();document.removeEventListener('curve-account-updated',update);if(page)page.destroy();else pending?.then(p=>p.destroy());}};
}
bootPage('coin',mountPage);
