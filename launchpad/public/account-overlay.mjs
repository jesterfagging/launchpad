import { createAccountSecurity } from './account-security-ui.js';
import { createCashbackWalletUI } from './cashback-wallet-ui.mjs';
import { createSignInWalletUI } from './signin-wallet-ui.mjs';
import { createEvmWalletLinkUI } from './evm-wallet-link-ui.mjs';
import { validateProfilePicture, optimizeProfileImage } from './profile-image.mjs';

const localAvatar=value=>/^\/token-images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(value||'')?value:'';
const amount=(raw,decimals)=>{
  if(!Number.isInteger(decimals)||decimals<0||decimals>18)return String(raw||'0')+' raw units';
  try{const text=BigInt(raw||0).toString().padStart(decimals+1,'0');return decimals?text.slice(0,-decimals)+'.'+(text.slice(-decimals).replace(/0+$/,'')||'0'):text;}catch{return 'Unavailable';}
};

export function createAccountOverlay({document,window,fetcher=fetch,onAccount=()=>{},securityFactory=createAccountSecurity,cashbackFactory=createCashbackWalletUI,signinWalletFactory=createSignInWalletUI,evmWalletFactory=createEvmWalletLinkUI}={}) {
  const dialog=document.createElement('dialog');dialog.id='public-account-dialog';dialog.className='account-dialog public-account-dialog';
  dialog.innerHTML=`<div class="card-heading"><h2>Edit profile</h2><button type="button" class="small-button" data-close aria-label="Close account">Close</button></div>
    <p data-message class="help" role="status"></p><div class="account-actions" data-signin-action hidden><a data-signin-link class="primary" href="/?signin=1">Connect wallet</a></div><div data-content hidden>
    <section class="account-section"><h3>Public profile <small>(optional)</small></h3><form data-profile><div class="public-profile-photo"><img data-avatar alt="Profile picture" hidden><div><label for="public-profile-picture">Profile picture</label><input id="public-profile-picture" data-picture type="file" accept="image/png,image/jpeg,image/webp" hidden><div class="account-actions"><button data-choose type="button" class="small-button cv-sm" aria-describedby="public-profile-picture-help">Choose picture</button><button data-remove type="button" class="text-button">Remove picture</button></div><p data-picture-name class="help" role="status" hidden></p></div></div><p class="help" id="public-profile-picture-help">PNG, JPG or WebP · up to 5 MB</p><label>Username<input data-username required minlength="3" maxlength="32" pattern="[a-zA-Z0-9_][a-zA-Z0-9_\\-]{2,31}" autocomplete="username"></label><p data-name-note class="help"></p><label>Bio<textarea data-bio maxlength="280" rows="3" placeholder="Tell people a little about yourself"></textarea></label><button data-save class="primary" type="submit">Save profile</button></form></section>
    <section class="account-section" data-toolkit-wallet hidden><h3 data-wallet-title>Trading wallet</h3><p data-wallet-note class="help"></p><p data-wallet class="account-address"></p><button data-copy class="small-button" type="button">Copy address</button><p data-rate class="help"></p><div data-cashback class="cashback-summary"></div><div data-export-controls hidden><button data-export type="button" class="text-button">Export main wallet key</button><div data-export-result hidden><label>Main wallet private key<input data-key type="password" readonly autocomplete="off" spellcheck="false"></label><button data-reveal type="button" class="text-button">Show key</button><button data-clear-key type="button" class="text-button">Clear key</button></div></div></section>
    <section class="account-section" data-signin-wallet></section>
    <section class="account-section" data-evm-wallet></section>
    <section class="account-section" data-cashback-settings hidden></section>
    <section data-telegram class="account-section" hidden><h3>Telegram</h3><p data-telegram-status class="help"></p><div class="account-actions"><button data-link type="button" class="small-button">Create linking code</button><button data-unlink type="button" class="small-button" hidden>Disconnect Telegram</button></div><p data-link-code class="account-address" hidden></p><p data-link-expiry class="help" hidden></p></section>
    <section data-admin class="account-section" hidden><h3>Admin panel</h3><a href="/admin" class="small-button">Open admin panel →</a></section>
    </div>`;
  document.body.append(dialog);
  const $=name=>dialog.querySelector('[data-'+name+']');
  // style.css sets textareas in the monospace font; the bio is prose (CSSOM, so the CSP stays strict).
  if($('bio')?.style)$('bio').style.fontFamily='var(--sans)';
  let account=null,csrf='',avatarId='',security=null,opening=null,generation=0,keyTimer,previousOverflow='',scroll=null,trigger=null,profileBusy=false,sessionAuthType='',features={},cashbackWallet=null,picturePreview=null;
  const toolkit=()=>features.toolkit===true,telegram=()=>features.telegram===true;
  const accountUpdate=()=>{onAccount({authenticated:true,account,token:csrf,features});};
  const message=(text,error=false)=>{ $('message').textContent=text||'';$('message').classList.toggle('account-error',error);$('message').setAttribute('role',error?'alert':'status'); };
  const UNAVAILABLE='Launchpad is temporarily unavailable. Please try again shortly.';
  // Signed out (expired session or a sign-out elsewhere): offer sign-in right here.
  // The header wires [data-signin-link] to its sign-in dialog once it shows the
  // signed-out state; this dialog closes first so the two never stack.
  $('signin-action').querySelector('a').addEventListener('click',()=>{if(dialog.open)dialog.close();});
  function signedOut(text){generation++;opening=null;account=null;csrf='';clearSecrets();cashbackWallet?.cancel();signinWallet.cancel();evmWallet.cancel();$('content').hidden=true;$('signin-action').hidden=false;if(dialog.open)message(text,true);}
  // A 401 means the server ended this session: publish the signed-out state so the header follows.
  function expired(text='Your session expired. Sign in again to open your account.'){signedOut(text);onAccount({authenticated:false,account:null,token:''});return Object.assign(Error(text),{sessionExpired:true});}
  async function api(path,body){
    if(!toolkit()&&['/api/account/cashback-wallet','/api/account/cashback-wallet/challenge'].includes(path)||!telegram()&&path.startsWith('/api/account/telegram-'))throw Error('This feature is not available on the launchpad.');
    if(sessionAuthType==='wallet'&&!['/api/session','/api/account','/api/account/profile','/api/account/avatar','/api/account/logout','/api/account/cashback-wallet','/api/account/cashback-wallet/challenge','/api/account/evm-wallet','/api/account/evm-wallet/challenge','/api/account/evm-wallet/unlink'].includes(path))throw Error('This wallet account can only manage its profile and launches.');
    const requestGeneration=generation;
    let response;
    try{response=await fetcher(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{...(csrf?{'x-control-token':csrf}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
    catch{if(requestGeneration!==generation||!dialog.open)throw Error('Cancelled.');throw Error('Launchpad could not be reached. Check your connection and try again.');}
    // Proxy outages answer with an HTML page: show readable text, never a parser error.
    const value=await response.json().catch(()=>null);
    if(requestGeneration!==generation||!dialog.open){
      if(response.ok&&path==='/api/wallet/verify'&&value?.authenticated){window.location.reload();throw Error('Cancelled.');}
      // The browser may already have accepted a rotated session cookie.
      // Refresh only public session state; never render late recovery material.
      if(response.ok&&['/api/account/mfa/enable','/api/account/signin-wallet','/api/account/signin-wallet/unlink'].includes(path))try{const freshResponse=await fetcher('/api/session',{credentials:'same-origin'});const fresh=await freshResponse.json();if(freshResponse.ok&&fresh.authenticated&&fresh.account?.id===account?.id&&fresh.token){csrf=fresh.token;account=fresh.account;if(fresh.features)features=fresh.features;onAccount({...fresh,features});}}catch{}
      throw Error('Cancelled.');
    }
    if(!response.ok){if(response.status===401&&!['/api/session','/api/wallet/challenge','/api/wallet/verify'].includes(path))throw expired('Your session expired. Sign in again to continue.');throw Error(typeof value?.error==='string'&&value.error?value.error:UNAVAILABLE);}
    if(!value||typeof value!=='object')throw Error(UNAVAILABLE);
    if(value.token)csrf=value.token;
    if(value.features)features=value.features;
    if(path==='/api/account/mfa/enable'&&value.account){account=value.account;accountUpdate();}
    return value;
  }
  function clearSecrets(){clearTimeout(keyTimer);$('key').value='';$('key').type='password';$('export-result').hidden=true;$('reveal').textContent='Show key';$('link-code').textContent='';$('link-code').hidden=true;$('link-expiry').textContent='';$('link-expiry').hidden=true;}
  function renderProfile(){
    avatarId=account.avatarId||'';$('username').value=account.username||'';$('bio').value=account.bio||'';$('picture').value='';picturePreview=null;showPictureName('');
    const src=localAvatar(account.avatar);$('avatar').hidden=!src;if(src)$('avatar').src=src;else $('avatar').removeAttribute('src');
    const next=Number(account.usernameChangeAvailableAt)||0;$('username').readOnly=next>Date.now();$('name-note').textContent=next>Date.now()?'You can change your username again on '+new Date(next).toLocaleDateString()+'.':'You can change your username now. After saving a new name, the next change is available in 30 days.';
  }
  function render(data){
    if(account?.id&&data.account?.id!==account.id)throw Error('Your account changed. Reload this page before continuing.');
    if(data.features)features=data.features;
    account=data.account;const walletOnly=account.authType==='wallet',legacy=features.walletOnly!==false&&!walletOnly;renderProfile();
    $('wallet-title').textContent=legacy?'Legacy trading wallet':'Trading wallet';$('wallet-note').textContent=legacy?'Your original account wallet remains available for recovery. Link an external wallet below to sign in and approve trades.':'Your connected wallet approves launches and trades.';$('wallet').textContent=account.mainWallet||'';
    $('toolkit-wallet').hidden=!toolkit()&&walletOnly;$('cashback-settings').hidden=!toolkit();
    $('rate').textContent=Number(account.cashbackBps||0)?`Cashback: ${Number(account.cashbackBps)/100}% of eligible Launchpad fees.`:'No cashback rate has been assigned to your account yet.';
    $('cashback').replaceChildren();for(const row of data.cashback||[]){const line=document.createElement('p');const native=row.mint==='So11111111111111111111111111111111111111112';line.className='help';line.textContent=`${native?'SOL':String(row.mint||'Token')} · Pending (verified, unpaid): ${amount(row.pendingAmount,native?9:row.decimals)} · Paid: ${amount(row.paidAmount,native?9:row.decimals)}`;$('cashback').append(line);}if(!$('cashback').children.length)$('cashback').textContent='No cashback accrued yet.';
    if(!toolkit()){$('rate').textContent='';$('cashback').replaceChildren();cashbackWallet?.cancel();$('cashback-settings').replaceChildren();cashbackWallet=null;clearSecrets();}
    else if(!cashbackWallet)cashbackWallet=cashbackFactory({document,window,container:$('cashback-settings'),getAccount:()=>account,api,authorize:title=>security.authorize(title),isActive:()=>dialog.open&&toolkit(),onSaved:next=>{account=next;accountUpdate();}});
    $('export-controls').hidden=walletOnly;$('telegram').hidden=!telegram()||walletOnly;$('admin').hidden=account.role!=='admin';
    $('telegram-status').textContent=account.telegramId?'Telegram is linked to your account.':'Link the same Launchpad account in the Telegram bot.';$('unlink').hidden=!account.telegramId;
    if(!walletOnly&&!security)security=securityFactory({api,dialog,getAccount:()=>account,getFeatures:()=>features,refresh,message,idPrefix:'public-',after:$('profile').closest('.account-section')});
    security?.render();cashbackWallet?.render();signinWallet.render();evmWallet.render();$('signin-action').hidden=true;$('content').hidden=false;accountUpdate();
  }
  const signinWallet=signinWalletFactory({document,window,container:$('signin-wallet'),getAccount:()=>account,getFeatures:()=>features,api,authorize:title=>security.authorize(title),isActive:()=>dialog.open,onSaved:next=>{account=next;accountUpdate();}});
  // The EVM wallet editor: a wallet-created account has no password step (security is null for it), so authorize is only reached on a password account.
  const evmWallet=evmWalletFactory({document,window,container:$('evm-wallet'),getAccount:()=>account,api,authorize:title=>{if(!security)throw Error('Account verification is unavailable. Reopen your account and try again.');return security.authorize(title);},isActive:()=>dialog.open,onSaved:next=>{account=next;accountUpdate();}});
  async function refresh(){const data=await api('/api/account');if(dialog.open)render(data);}
  // The site router may leave the page while this dialog is idle (it closes it first); a save, export or link in
  // progress holds the page like any other wallet action.
  let pendingActions=0;
  const syncNavigation=()=>dialog.toggleAttribute('data-navigation-free',pendingActions===0);
  async function action(button,task){button.disabled=true;pendingActions++;syncNavigation();const current=generation;try{message('');await task(current);}catch(e){if(dialog.open&&current===generation&&e.message!=='Cancelled.')message(e.message,true);}finally{pendingActions=Math.max(0,pendingActions-1);syncNavigation();button.disabled=false;}}
  $('close').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{generation++;opening=null;clearSecrets();cashbackWallet?.cancel();signinWallet.cancel();evmWallet.cancel();$('picture').value='';document.body.style.overflow=previousOverflow;if(scroll)window.scrollTo?.(scroll.x,scroll.y);trigger?.focus?.({preventScroll:true});scroll=null;trigger=null;});
  // A page change closes this dialog: the new page keeps its own scroll position and focus.
  document.addEventListener('curve-navigation-start',()=>{scroll=null;trigger=null;});
  syncNavigation();
  document.addEventListener('curve-account-updated',event=>{
    const next=event.detail;if(!next||!account)return;
    if(next.authenticated===false){signedOut('Your session changed. Sign in again to continue.');return;}
    if(next.account?.id&&next.account.id!==account.id){
      generation++;opening=null;account=null;csrf='';clearSecrets();cashbackWallet?.cancel();signinWallet.cancel();evmWallet.cancel();$('content').hidden=true;
      if(dialog.open)message('Your session changed. Close and reopen your account to continue.',true);return;
    }
    if(next.account?.id!==account.id)return;account=next.account;if(next.token)csrf=next.token;if(next.features)features=next.features;
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden)clearSecrets();});
  // A chosen picture is previewed before saving (a data: URL; the CSP allows no blob: images). Saving still uploads the file itself.
  function showPictureName(text){$('picture-name').textContent=text;$('picture-name').hidden=!text;}
  function restorePicture(){const saved=picturePreview;picturePreview=null;if(!saved)return;if(saved.src)$('avatar').src=saved.src;else $('avatar').removeAttribute('src');$('avatar').hidden=saved.hidden;}
  function previewPicture(file){
    if(typeof FileReader!=='function'||typeof Blob!=='function'||!(file instanceof Blob))return;
    const reader=new FileReader(),current=generation;
    reader.onload=()=>{if(current!==generation||!dialog.open||$('picture').files?.[0]!==file||typeof reader.result!=='string'||!/^data:image\/(png|jpeg|webp);base64,/.test(reader.result))return;if(!picturePreview)picturePreview={hidden:$('avatar').hidden,src:$('avatar').getAttribute('src')};$('avatar').src=reader.result;$('avatar').hidden=false;};
    try{reader.readAsDataURL(file);}catch{}
  }
  $('choose').onclick=()=>$('picture').click();
  $('picture').onchange=()=>{message('');const file=$('picture').files?.[0];if(!file){restorePicture();showPictureName('');return;}try{validateProfilePicture(file);showPictureName(typeof file.name==='string'?file.name.slice(0,120):'');previewPicture(file);}catch(e){$('picture').value='';restorePicture();showPictureName('');message(e.message,true);}};
  $('remove').onclick=()=>{avatarId='';$('picture').value='';picturePreview=null;showPictureName('');$('avatar').hidden=true;message('Picture removed from the form. Save your profile to apply it.');};
  $('avatar').onerror=()=>{$('avatar').hidden=true;};
  $('profile').onsubmit=async event=>{
    event.preventDefault();if(profileBusy)return;profileBusy=true;
    await action($('save'),async current=>{
      const file=$('picture').files?.[0];let nextAvatar=avatarId;
      if(file){const data=(await optimizeProfileImage(file)).split(',')[1];if(!dialog.open||current!==generation)return;nextAvatar=(await api('/api/account/avatar',{data})).imageId;}
      if(!dialog.open||current!==generation)return;
      const result=await api('/api/account/profile',{username:$('username').value,bio:$('bio').value,avatarId:nextAvatar});
      if(current!==generation||!dialog.open)return;account=result.account;renderProfile();accountUpdate();message('Profile saved.');
    });profileBusy=false;
  };
  $('copy').onclick=()=>action($('copy'),async()=>{await window.navigator.clipboard.writeText(account.mainWallet);message('Address copied.');});
  $('export').onclick=()=>action($('export'),async current=>{
    if(account?.authType==='wallet'||!security)return;
    const credentials=await security.authorize('Export main wallet private key');if(!dialog.open||current!==generation)return;
    const result=await api('/api/account/export',credentials);if(dialog.open&&current===generation){clearSecrets();$('key').value=result.privateKey||'';$('export-result').hidden=false;keyTimer=setTimeout(clearSecrets,60000);message('Key unlocked for one minute.');}
  });
  $('reveal').onclick=()=>{const show=$('key').type==='password';$('key').type=show?'text':'password';$('reveal').textContent=show?'Hide key':'Show key';};$('clear-key').onclick=clearSecrets;
  $('link').onclick=()=>action($('link'),async current=>{
    if(account?.authType==='wallet'||!security)return;const credentials=await security.authorize('Link Telegram to this account');if(!dialog.open||current!==generation)return;
    const result=await api('/api/account/telegram-link',credentials);if(dialog.open&&current===generation){$('link-code').textContent='/link '+result.code;$('link-code').hidden=false;$('link-expiry').textContent='Send this privately to the Launchpad bot. Expires '+new Date(result.expiresAt).toLocaleTimeString()+'.';$('link-expiry').hidden=false;}
  });
  $('unlink').onclick=()=>action($('unlink'),async current=>{
    if(account?.authType==='wallet'||!security)return;const credentials=await security.authorize('Disconnect Telegram');if(!dialog.open||current!==generation)return;
    await api('/api/account/telegram-unlink',credentials);if(dialog.open&&current===generation){clearSecrets();await refresh();message('Telegram disconnected.');}
  });
  return {dialog,open(session,source){
    if(opening)return opening;if(dialog.open){dialog.focus();return Promise.resolve();}
    generation++;const current=generation;trigger=source;scroll={x:window.scrollX||0,y:window.scrollY||0};previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';clearSecrets();$('content').hidden=true;$('signin-action').hidden=true;message('Loading your account…');dialog.showModal();
    const promise=(async()=>{const fresh=await api('/api/session');sessionAuthType=fresh.account?.authType||'';if(!fresh.authenticated)throw expired();csrf=fresh.token||session?.token||'';const data=await api('/api/account');if(dialog.open&&current===generation){render(data);message('');}})().catch(e=>{if(dialog.open&&current===generation)message(e.message,true);}).finally(()=>{if(opening===promise)opening=null;});opening=promise;return promise;
  }};
}
