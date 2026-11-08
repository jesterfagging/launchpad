import {createWorkspaceShell} from './workspace-shell.js';
import {validateProfilePicture,optimizeProfileImage} from './profile-image.mjs';
import {createCashbackWalletUI} from './cashback-wallet-ui.mjs';
import {createSignInWalletUI} from './signin-wallet-ui.mjs';
import {createEvmWalletLinkUI} from './evm-wallet-link-ui.mjs';
const $=id=>document.getElementById(id);let csrf='',address='',profile=null,avatarId='',accountIdentity='',sessionGeneration=0,sessionReceived=false,features={},cashbackWallet=null;
const toolkit=()=>features.toolkit===true;
const walletOnlyMode=()=>features.walletOnly!==false;
createWorkspaceShell({page:'wallet-account'});
const identity=account=>account?.id||account?.mainWallet||account?.username||'';
const stale=()=>Object.assign(Error('Your account changed. Please try again.'),{cancelled:true});
const UNAVAILABLE='Launchpad is temporarily unavailable. Please try again shortly.';
let sessionExpired=false,retryTimer=null,retryCount=0;
// A 401 means the server ended this session: sign the header and this page out.
function sessionEnded(){
 if(!accountIdentity)return;sessionExpired=true;
 document.dispatchEvent(new document.defaultView.CustomEvent('curve-account-updated',{detail:{authenticated:false,account:null,token:''}}));
}
const request=async(path,body,generation=sessionGeneration)=>{
 if(!toolkit()&&path.startsWith('/api/account/cashback-wallet'))throw Error('This feature is not available on the launchpad.');
 let response;
 try{response=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'x-control-token':csrf,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
 catch{if(generation!==sessionGeneration)throw stale();throw Error('Launchpad could not be reached. Check your connection and try again.');}
 // Proxy outages answer with an HTML page: show readable text, never a parser error.
 const value=await response.json().catch(()=>null);
 const securityRotation=response.ok&&value?.token&&['/api/account/signin-wallet','/api/account/signin-wallet/unlink'].includes(path);
 const walletSignIn=response.ok&&path==='/api/wallet/verify'&&value?.authenticated;
 if(generation!==sessionGeneration||(securityRotation&&identity(value.account)!==accountIdentity)){
  // The browser may already have accepted this response's session cookie.
  if(securityRotation||walletSignIn)document.defaultView.location.reload();
  throw stale();
 }
 if(!response.ok){if(response.status===401&&!['/api/session','/api/wallet/challenge','/api/wallet/verify'].includes(path)){sessionEnded();throw stale();}throw Error(typeof value?.error==='string'&&value.error?value.error:UNAVAILABLE);}
 if(!value||typeof value!=='object')throw Error(UNAVAILABLE);
 if(value.features)features=value.features;
 if(securityRotation){
  csrf=value.token;
  if(value.account&&identity(value.account)===accountIdentity){profile=value.account;renderWalletSettings();}
  createWorkspaceShell({session:{authenticated:true,account:profile,token:csrf,features},page:'wallet-account'});
 }
 return value;
};
function clearAccount(){
 profile=null;address='';avatarId='';$('wallet-profile').hidden=true;
 for(const id of ['wallet-profile-username','wallet-profile-address','wallet-profile-rate','wallet-profile-cashback','profile-message'])$(id).textContent='';
 for(const id of ['profile-username','profile-bio','profile-image'])$(id).value='';
 picturePreview=null;$('profile-preview').removeAttribute('src');$('profile-preview').hidden=true;$('profile-save').disabled=false;
 cashbackWallet?.cancel(); signInWallet.cancel(); evmWallet.cancel(); finishCashbackVerification(); renderWalletSettings();
}
// Failed loads (outage, proxy error page) retry with backoff instead of waiting for a reload.
function clearRetry(){if(retryTimer)clearTimeout(retryTimer);retryTimer=null;}
function scheduleRetry(){if(retryTimer)return;retryTimer=setTimeout(()=>{retryTimer=null;void loadSession(true);},Math.min(60000,5000*2**Math.min(retryCount++,4)));}
async function activateSession(session){
 sessionReceived=true;clearRetry();$('wallet-profile-error').hidden=true;
 if(session.features)features=session.features;else if(!session.authenticated)features={};
 if(session.authenticated)sessionExpired=false;
 $('wallet-profile-gate-note').textContent=(sessionExpired?'Your session expired. ':'')+(walletOnlyMode()?'Connect your wallet to create or open your account. Your public profile is optional.':'Connect your sign-in wallet or use your username and password.');
 const nextIdentity=session.authenticated?identity(session.account):'';
 if(nextIdentity!==accountIdentity){sessionGeneration++;accountIdentity=nextIdentity;clearAccount();}
 csrf=session.token||'';createWorkspaceShell({session:{...session,features},page:'wallet-account'});
 $('wallet-profile-gate').hidden=!!session.authenticated;
 if(!session.authenticated)return;
 if(profile&&identity(profile)===nextIdentity){profile=session.account;renderProfile();$('wallet-profile-username').textContent=profile.username;renderWalletSettings();return;}
 const generation=sessionGeneration;
 try{
  const data=await request('/api/account',undefined,generation);if(generation!==sessionGeneration)return;
  if(identity(data.account)!==nextIdentity)throw Error('Your account changed. Please sign in again.');
  if(data.features)features=data.features;profile=data.account;renderProfile();address=profile.mainWallet||'';
  $('wallet-profile-username').textContent=profile.username;$('wallet-profile-address').textContent=address;
  $('wallet-profile-rate').textContent=Number(profile.cashbackBps||0)?`Cashback rate: ${Number(profile.cashbackBps)/100}% of eligible platform fees.`:'No cashback rate has been assigned to this account yet.';
  const box=$('wallet-profile-cashback');box.replaceChildren();if(!data.cashback?.length)box.textContent='No cashback accrued yet.';
  for(const row of data.cashback||[]){const line=document.createElement('p');const decimals=Number.isInteger(row.decimals)?row.decimals:0;const amount=(value)=>{const raw=BigInt(value||0),scale=10n**BigInt(decimals);return decimals?`${raw/scale}.${(raw%scale).toString().padStart(decimals,'0').replace(/0+$/,'')||'0'}`:raw.toString();};line.textContent=`${row.mint} · Pending (verified, unpaid): ${amount(row.pendingAmount)} · Paid: ${amount(row.paidAmount)}`;box.append(line);}
  $('wallet-profile-error').hidden=true;$('wallet-profile').hidden=false;retryCount=0;renderWalletSettings();
 }catch(e){if(generation!==sessionGeneration||e.cancelled)return;$('wallet-profile-error').hidden=false;$('wallet-profile-error').textContent=(e.message===UNAVAILABLE?'Your Launchpad account could not be loaded right now.':e.message)+' Retrying automatically.';scheduleRetry();}
}
document.addEventListener('curve-account-updated',event=>{if(event.detail?.authenticated===false||event.detail?.authenticated&&event.detail.account)void activateSession(event.detail);});
let cashbackVerification = null;
const cashbackAuth = $('wallet-cashback-auth');
function finishCashbackVerification(credentials) {
 const pending = cashbackVerification; cashbackVerification = null;
 $('wallet-cashback-password').value = ''; $('wallet-cashback-code').value = '';
 if (cashbackAuth.open) cashbackAuth.close();
 if (pending) credentials ? pending.resolve(credentials) : pending.reject(Error('Cancelled.'));
}
function authorizeCashback(title) {
 if (cashbackVerification) return Promise.reject(Error('Finish the current identity check first.'));
 $('wallet-cashback-auth-title').textContent = title;
 $('wallet-cashback-password').value = ''; $('wallet-cashback-code').value = '';
 $('wallet-cashback-code-label').hidden = !profile?.mfaEnabled;
 $('wallet-cashback-code').required = Boolean(profile?.mfaEnabled);
 return new Promise((resolve,reject) => { cashbackVerification={resolve,reject}; cashbackAuth.showModal(); $('wallet-cashback-password').focus(); });
}
$('wallet-cashback-auth-form').onsubmit = event => {
 event.preventDefault(); finishCashbackVerification({password:$('wallet-cashback-password').value,code:$('wallet-cashback-code').value.trim()});
};
$('wallet-cashback-auth-cancel').onclick = () => finishCashbackVerification();
cashbackAuth.addEventListener('cancel', event => { event.preventDefault(); finishCashbackVerification(); });
cashbackAuth.addEventListener('close', () => { if(cashbackVerification) finishCashbackVerification(); });
function mountCashbackWallet() { return createCashbackWalletUI({
 document, window: document.defaultView, container: $('wallet-profile-cashback-wallet'), getAccount: () => profile,
 api: request, authorize: authorizeCashback,
 isActive: () => toolkit() && Boolean(profile) && !$('wallet-profile').hidden,
 onSaved: account => { profile = account; renderWalletSettings(); },
}); }
const signInWallet = createSignInWalletUI({
 document, window: document.defaultView, container: $('wallet-profile-signin-wallet'), getAccount: () => profile, getFeatures: () => features,
 api: request, authorize: authorizeCashback,
 isActive: () => Boolean(profile) && !$('wallet-profile').hidden,
 onSaved: account => { profile = account; renderWalletSettings(); },
});
const evmWallet = createEvmWalletLinkUI({
 document, window: document.defaultView, container: $('wallet-profile-evm-wallet'), getAccount: () => profile,
 api: request, authorize: authorizeCashback,
 isActive: () => Boolean(profile) && !$('wallet-profile').hidden,
 onSaved: account => { profile = account; renderWalletSettings(); document.dispatchEvent(new document.defaultView.CustomEvent('curve-account-updated',{detail:{authenticated:true,account:profile,token:csrf,features}})); },
});
function renderWalletSettings() {
 const legacy=walletOnlyMode()&&profile?.authType!=='wallet';
 $('wallet-profile-wallet-title').textContent=legacy?'Legacy trading wallet':'Trading wallet';
 $('wallet-profile-wallet-note').textContent=legacy?'Your original account wallet remains available for recovery. Link an external wallet above to sign in and approve trades.':'Your connected wallet approves launches and trades.';
 $('wallet-profile-security').textContent=legacy?'Account recovery & wallet access':'Account settings';
 address=profile?.mainWallet||'';$('wallet-profile-wallet-section').hidden=false;$('wallet-profile-address').textContent=address;$('wallet-profile-cashback-section').hidden=!toolkit();
 if(toolkit()){cashbackWallet ||= mountCashbackWallet();cashbackWallet.render();$('wallet-profile-address').textContent=profile?.mainWallet||'';}
 else{cashbackWallet?.cancel();cashbackWallet=null;$('wallet-profile-cashback-wallet').replaceChildren();for(const id of ['wallet-profile-rate','wallet-profile-cashback'])$(id).textContent='';}
 signInWallet.render(); evmWallet.render();
}
document.defaultView.addEventListener('pagehide', () => { clearRetry(); cashbackWallet?.cancel(); signInWallet.cancel(); evmWallet.cancel(); finishCashbackVerification(); });
// The header profile menu's "Edit profile" opens the account dialog; the account
// button itself only toggles that menu (or opens sign-in when signed out).
$('wallet-profile-security').onclick=()=>(document.querySelector('[data-account-edit]')||document.querySelector('[data-account-link]'))?.click();
$('wallet-profile-copy').onclick=async()=>{try{await navigator.clipboard.writeText(address);$('wallet-profile-copy').textContent='Copied';}catch{$('wallet-profile-copy').textContent='Select the address to copy';}};
const signIn=$('wallet-profile-gate')?.querySelector('a');if(signIn)signIn.onclick=event=>{event.preventDefault();document.querySelector('[data-account-link]')?.click();};


function renderProfile(){
 picturePreview=null;avatarId=profile.avatarId||'';$('profile-username').value=profile.username;$('profile-bio').value=profile.bio||'';
 $('profile-preview').hidden=!profile.avatar;if(profile.avatar)$('profile-preview').src=profile.avatar;
 const next=profile.usernameChangeAvailableAt||0;$('profile-username').readOnly=next>Date.now();
 $('profile-name-note').textContent=next>Date.now()?'You can change your username again on '+new Date(next).toLocaleDateString()+'.':'You can change your username now. After saving a new name, the next change is available in 30 days.';
}
// A chosen picture is previewed before saving (a data: URL; the CSP allows no blob: images). Saving still uploads the file itself.
let picturePreview=null;
function restorePicture(){const saved=picturePreview,preview=$('profile-preview');picturePreview=null;if(!saved)return;if(saved.src)preview.src=saved.src;else preview.removeAttribute('src');preview.hidden=saved.hidden;}
function previewPicture(file){
 if(typeof FileReader!=='function'||typeof Blob!=='function'||!(file instanceof Blob))return;
 const reader=new FileReader(),generation=sessionGeneration;
 reader.onload=()=>{if(generation!==sessionGeneration||$('profile-image').files?.[0]!==file||typeof reader.result!=='string'||!/^data:image\/(png|jpeg|webp);base64,/.test(reader.result))return;const preview=$('profile-preview');if(!picturePreview)picturePreview={hidden:preview.hidden,src:preview.getAttribute('src')};preview.src=reader.result;preview.hidden=false;};
 try{reader.readAsDataURL(file);}catch{}
}
$('profile-image').onchange=()=>{
 const input=$('profile-image');$('profile-message').textContent='';
 if(!input.files?.[0]){restorePicture();return;}
 try{validateProfilePicture(input.files[0]);previewPicture(input.files[0]);}catch(e){input.value='';restorePicture();$('profile-message').textContent=e.message;}
};
$('profile-remove').onclick=()=>{avatarId='';$('profile-image').value='';picturePreview=null;$('profile-preview').hidden=true;$('profile-message').textContent='';};
$('profile-form').onsubmit=async event=>{
 event.preventDefault();if(!profile)return;const generation=sessionGeneration,username=$('profile-username').value,bio=$('profile-bio').value;let nextAvatar=avatarId;
 $('profile-save').disabled=true;$('profile-message').textContent='Saving…';
 try{
  const file=$('profile-image').files?.[0];if(file){const data=(await optimizeProfileImage(file)).split(',')[1];if(generation!==sessionGeneration)return;nextAvatar=(await request('/api/account/avatar',{data},generation)).imageId;}
  if(generation!==sessionGeneration)return;
  const data=await request('/api/account/profile',{username,bio,avatarId:nextAvatar},generation);if(generation!==sessionGeneration)return;
  profile=data.account;renderProfile();$('profile-image').value='';$('wallet-profile-username').textContent=profile.username;
  // Publish the saved profile so the header (and any other listener) shows the new name and picture.
  document.dispatchEvent(new document.defaultView.CustomEvent('curve-account-updated',{detail:{authenticated:true,account:profile,token:csrf,features}}));
  renderWalletSettings();$('profile-message').textContent='Profile saved.';
 }catch(e){if(generation===sessionGeneration&&!e.cancelled)$('profile-message').textContent=e.message;}finally{if(generation===sessionGeneration)$('profile-save').disabled=false;}
};

async function loadSession(retry=false){
 try{const session=await request('/api/session');if(retry||!sessionReceived)await activateSession(session);}
 catch(e){if(e.cancelled||sessionReceived&&!retry)return;$('wallet-profile-error').hidden=false;$('wallet-profile-error').textContent='Your Launchpad account could not be loaded right now. Retrying automatically.';scheduleRetry();}
}
await loadSession();
