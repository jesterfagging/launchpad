import { getLaunchpadWallet, renderWalletDeepLinks } from './launchpad-wallet.mjs';

// A wallet that never answers (closed popup, locked extension) must not leave the dialog disabled.
const WALLET_WAIT_MS=120000;

export function createSignInOverlay({document,window,fetcher=fetch,onSession=()=>{},walletFactory=getLaunchpadWallet,getFeatures=()=>({})}={}) {
  const dialog=document.createElement('dialog');dialog.id='signin-dialog';dialog.className='account-dialog signin-dialog';
  dialog.innerHTML=`<div class="card-heading"><h2 data-title>Welcome to Launchpad</h2><button type="button" class="small-button" data-close aria-label="Close sign in">Close</button></div><p class="help" data-intro>Connect your wallet to get started. Your account is created automatically, and adding a profile is optional.</p>
    <button type="button" class="primary signin-wallet" data-connect>Connect wallet</button><div data-wallets class="signin-wallets" hidden></div><p class="help signin-wallet-note">Your connected wallet is your default wallet for launches and trades. Approve a sign-in message; no password needed.</p>
    <p class="help signin-policy-note">By continuing, you agree to the <a href="/terms">Terms of Service</a> and acknowledge the <a href="/privacy">Privacy Policy</a>.</p><p data-message class="help" role="status"></p><button type="button" class="text-button" data-recovery aria-expanded="false" aria-controls="signin-existing-account">Recover an existing account</button><div data-manual id="signin-existing-account" hidden><div class="signin-divider" data-divider><span>OR</span></div><h3 class="signin-manual-heading" data-manual-heading>Recover an existing account</h3><p class="help" data-recovery-note>Use your existing username and password to access your account and link a wallet. This does not create a new account.</p><form data-form><label>Username<input data-username name="username" autocomplete="username" minlength="3" maxlength="64" required spellcheck="false" autocapitalize="none"></label><label>Password<input data-password name="password" type="password" autocomplete="current-password" minlength="10" maxlength="128" required></label><label data-code-label hidden>Authenticator or recovery code<input data-code name="code" autocomplete="one-time-code" maxlength="40" spellcheck="false"></label><button type="submit" class="primary" data-submit>Recover account</button></form><button type="button" class="text-button" data-mode hidden>New here? Create an account</button></div>`;
  document.body.append(dialog);const $=name=>dialog.querySelector('[data-'+name+']');
  const wallet=walletFactory({window});
  // busy is false, 'wallet' or 'login'. Wallet flows are released when the dialog closes.
  let mode='login',busy=false,generation=0,trigger=null,previousOverflow='',scroll=null,recovery=false,walletFlow=0,walletSequence=0,watchdog=null;
  const walletOnly=()=>getFeatures()?.walletOnly!==false;
  const message=(text,error=false)=>{$('message').textContent=text||'';$('message').classList.toggle('account-error',error);$('message').setAttribute('role',error?'alert':'status');};
  const clear=()=>{$('password').value='';$('code').value='';};
  const snapshot=()=>{try{const value=wallet.state();return value&&typeof value==='object'?value:{};}catch{return {};}};
  function renderMode(){
    const only=walletOnly();if(only)mode='login';
    $('intro').textContent=only?'Connect your wallet to get started. Your account is created automatically, and adding a profile is optional.':'Connect your wallet or sign in to your account.';
    $('recovery').hidden=!only;$('recovery').setAttribute('aria-expanded',String(recovery));$('recovery').textContent=recovery?'Back to wallet connection':'Recover an existing account';
    $('manual').hidden=only&&!recovery;$('divider').hidden=only;$('recovery-note').hidden=!only;$('mode').hidden=only;
    $('title').textContent=mode==='register'?'Create your account':'Welcome to Launchpad';
    $('submit').textContent=only?'Recover account':mode==='login'?'Sign in':'Create account';
    $('manual-heading').textContent=only?'Recover an existing account':mode==='login'?'Sign in with username and password':'Create an account with username and password';
    $('mode').textContent=mode==='login'?'New here? Create an account':'Already have an account? Sign in';
    $('password').autocomplete=mode==='login'?'current-password':'new-password';
    if(mode==='register')$('username').pattern='[A-Za-z0-9_]{3,32}';else $('username').removeAttribute('pattern');
  }
  // While idle the dialog never holds page navigation: its links close it and
  // open their page. A pending wallet approval or login keeps the page in place.
  function controls(){for(const node of dialog.querySelectorAll('button:not([data-close]),input'))node.disabled=!!busy;if(busy)dialog.removeAttribute('data-navigation-free');else dialog.setAttribute('data-navigation-free','');}
  async function api(path,body){const response=await fetcher(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:body===undefined?{}:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json();if(!response.ok)throw Object.assign(Error(data.error||'Sign-in failed. Please try again.'),{mfaRequired:!!data.mfaRequired});return data;}
  function renderWallets(){
    const state=snapshot(),rows=Array.isArray(state.wallets)?state.wallets:[],box=$('wallets');box.replaceChildren();
    for(const row of rows){const button=document.createElement('button');button.type='button';button.className='small-button';button.textContent=row.name;button.disabled=!!busy;button.onclick=()=>connect(row.id);box.append(button);}
    if(!rows.length){
      const links=Array.isArray(state.deepLinks)?state.deepLinks:[],note=document.createElement('p');note.className='help';
      note.textContent=state.discovering?'Looking for wallets in this browser…':links.length?'No wallet found in this browser. Open Launchpad in your wallet app to connect:':'Open this page in a Solana wallet browser, or install a compatible wallet extension.';
      box.append(note);
      // Phones have no wallet extensions: offer the wallet apps right away.
      if(!state.discovering&&renderWalletDeepLinks({document,container:box,links}))box.hidden=false;
    }
  }
  const off=wallet.onChange(()=>{if(dialog.open)renderWallets();});
  async function finish(result,current){
    const session=await api('/api/session');if(!session.authenticated||session.account?.id!==result.account?.id)throw Error('Your sign-in changed. Please try again.');
    // An already accepted request may finish after Close; keep the header in sync
    // with the browser's real cookie without reopening or navigating the page.
    onSession(session);if(dialog.open)dialog.close();
  }
  function releaseWallet(){globalThis.clearTimeout?.(watchdog);watchdog=null;walletFlow=0;if(busy==='wallet')busy=false;}
  const failure=e=>/^Invalid wallet signature/i.test(e?.message||'')?'Launchpad could not verify your wallet signature. Make sure the account selected in your wallet is the one you connected, then try again.':e?.message||'Wallet sign-in failed. Please try again.';
  async function connect(id){
    if(busy)return;const flow=++walletSequence,current=generation;walletFlow=flow;busy='wallet';
    const live=()=>dialog.open&&current===generation&&walletFlow===flow;
    message('Connect and approve the sign-in message in your wallet.');controls();
    globalThis.clearTimeout?.(watchdog);
    watchdog=globalThis.setTimeout?.(()=>{if(walletFlow!==flow)return;releaseWallet();controls();renderWallets();if(dialog.open)message('Your wallet did not respond. Open your wallet to finish or dismiss the request, then try again.',true);},WALLET_WAIT_MS);watchdog?.unref?.();
    try{
      await wallet.connect(id);if(!live())return;const address=wallet.state().address;
      if(!address)throw Error('Your wallet did not share an account. Unlock it and connect again.');
      const challenge=await api('/api/wallet/challenge',{address});if(!live())return;
      if(wallet.state().address!==address)throw Error('Your wallet changed. Connect again.');
      message('Approve the sign-in message in your wallet.');
      const signature=await wallet.signMessage(challenge.message);if(!live())return;
      // The server checks the signature against the challenged address, so only
      // a different connected account (not a momentary empty one) is fatal here.
      const now=wallet.state().address;if(now&&now!==address)throw Error('Your wallet changed. Connect again.');
      const result=await api('/api/wallet/verify',{nonce:challenge.nonce,signature});await finish(result,current);
    }catch(e){if(live())message(failure(e),!e?.walletRejected);}
    finally{if(walletFlow===flow){releaseWallet();controls();renderWallets();}}
  }
  $('connect').onclick=()=>{if(busy)return;const rows=snapshot().wallets||[];if(rows.length===1)connect(rows[0].id);else{$('wallets').hidden=false;renderWallets();}};
  $('form').onsubmit=async event=>{
    event.preventDefault();if(busy||walletOnly()&&!recovery)return;busy='login';const current=generation;message(walletOnly()?'Recovering your account…':'Signing in…');controls();
    try{const result=await api('/api/account/'+(walletOnly()?'login':mode),{username:$('username').value.trim(),password:$('password').value,code:$('code').value.trim()});await finish(result,current);}
    catch(e){if(dialog.open&&current===generation){if(e.mfaRequired){$('code-label').hidden=false;$('code').required=true;}message(e.message,true);}}
    finally{busy=false;controls();if(dialog.open&&current===generation&&!$('code-label').hidden)$('code').focus();}
  };
  $('mode').onclick=()=>{if(busy||walletOnly())return;mode=mode==='login'?'register':'login';clear();$('code-label').hidden=true;$('code').required=false;message('');renderMode();};
  $('recovery').onclick=()=>{if(busy||!walletOnly())return;recovery=!recovery;clear();message('');$('code-label').hidden=true;$('code').required=false;renderMode();if(recovery)$('username').focus();};
  $('close').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{generation++;if(busy==='wallet'){releaseWallet();controls();}clear();message('');document.body.style.overflow=previousOverflow;if(scroll)window.scrollTo?.(scroll.x,scroll.y);trigger?.focus?.({preventScroll:true});scroll=null;trigger=null;});
  const visibility=()=>{if(document.hidden&&dialog.open)clear();};document.addEventListener('visibilitychange',visibility);
  // A link inside the dialog that changes page closes it: the new page keeps its
  // own scroll position and focus instead of the previous page's.
  const navigation=()=>{scroll=null;trigger=null;};document.addEventListener('curve-navigation-start',navigation);
  dialog.setAttribute('data-navigation-free','');renderMode();
  return {dialog,open(source){if(dialog.open){dialog.focus();return;}generation++;trigger=source;recovery=false;mode='login';clear();message('');renderMode();$('code-label').hidden=true;$('code').required=false;$('wallets').hidden=true;previousOverflow=document.body.style.overflow;scroll={x:window.scrollX||0,y:window.scrollY||0};document.body.style.overflow='hidden';renderWallets();controls();dialog.showModal();},destroy(){off();releaseWallet();document.removeEventListener('visibilitychange',visibility);document.removeEventListener('curve-navigation-start',navigation);clear();if(dialog.open)dialog.close();dialog.remove();}};
}
