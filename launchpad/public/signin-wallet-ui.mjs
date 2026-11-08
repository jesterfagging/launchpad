import { getLaunchpadWallet, renderWalletDeepLinks } from './launchpad-wallet.mjs';

// Linking is an explicit account-security change, separate from payout preferences.
export function createSignInWalletUI({document,window,container,getAccount,api,authorize,getFeatures=()=>({}),onSaved=()=>{},isActive=()=>true,walletFactory=getLaunchpadWallet}={}) {
  container.classList.add('signin-wallet-settings');
  container.innerHTML=`<h3>Sign-in wallet</h3><p data-siw-status class="help"></p><p data-siw-address class="account-address"></p><div class="account-actions"><button type="button" class="small-button" data-siw-edit>Link sign-in wallet</button><button type="button" class="text-button" data-siw-unlink hidden>Unlink wallet</button></div><div data-siw-form hidden><p class="help">Connect the wallet you want to use, then verify this account and approve a linking message. Your existing account wallet stays the same.</p><p data-siw-selected class="account-address"></p><button type="button" class="small-button" data-siw-connect>Connect wallet</button><div data-siw-wallets class="signin-wallets" hidden></div><p data-siw-warning class="help"></p><div class="account-actions"><button type="button" class="primary" data-siw-save>Verify &amp; link</button><button type="button" class="small-button" data-siw-cancel>Cancel</button></div></div><div data-siw-previous hidden><p class="help">Previous wallet account: <strong data-siw-previous-name></strong></p><p class="help">Its launches and profile are preserved separately.</p><button type="button" class="small-button" data-siw-previous-open>Open account</button><div data-siw-previous-wallets class="signin-wallets" hidden></div></div><p data-siw-message class="help" role="status"></p>`;
  const $=name=>container.querySelector('[data-siw-'+name+']');
  const validAddress=value=>typeof value==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
  let generation=0,busy=false,identity='',editing=false,wallet=null,unsubscribe=null,operation=0,walletWait=0;
  const NO_WALLET='Open Launchpad in your Solana wallet browser, or install a compatible wallet extension.';
  // A wallet request that never settles is released by cancel(); generation checks ignore its late result.
  const start=()=>{busy=true;walletWait=0;return ++operation;},finish=token=>{if(token===operation){busy=false;walletWait=0;controls();}};
  async function fromWallet(token,task){walletWait=token;try{return await task();}finally{if(walletWait===token)walletWait=0;}}
  const noWallet=(box,state)=>{const links=state?.discovering?[]:state?.deepLinks;return renderWalletDeepLinks({document,container:box,links:Array.isArray(links)?links:[]})?'No wallet found in this browser. Open Launchpad in your wallet app to connect.':state?.discovering?'Looking for wallets in this browser…':NO_WALLET;};
  const failure=(error,fallback)=>message(error?.message||fallback,!error?.walletRejected);
  const manual=()=>getAccount()?.authType!=='wallet'&&!!getAccount()?.id;
  const message=(text,error=false)=>{$('message').textContent=text||'';$('message').classList.toggle('account-error',error);$('message').setAttribute('role',error?'alert':'status');};
  const current=(token,id)=>generation===token&&isActive()&&manual()&&getAccount()?.id===id;
  function controls(){for(const button of container.querySelectorAll('button'))button.disabled=busy;$('save').disabled=busy||!manual()||!validAddress(wallet?.state().address);}
  function selected(){const address=wallet?.state().address||'';$('selected').textContent=address||'No wallet connected.';$('connect').textContent=address?'Change connected wallet':'Connect wallet';controls();}
  function ensureWallet(){if(!wallet){wallet=walletFactory({window});unsubscribe=wallet.onChange?.(()=>{if(editing){selected();if(!$('wallets').hidden)renderWallets();}});}return wallet;}
  function cancel(){generation++;const released=busy&&walletWait===operation;if(released){operation++;busy=false;walletWait=0;}editing=false;$('form').hidden=true;$('wallets').hidden=true;$('wallets').replaceChildren();$('selected').textContent='';$('previous-wallets').hidden=true;$('previous-wallets').replaceChildren();message('');if(released)controls();}
  function render(){
    const account=getAccount();if(identity!==account?.id){cancel();identity=account?.id||'';}
    const walletOnly=account?.authType==='wallet',linked=account?.signInWallet||'';
    const previous=account?.walletAccount;$('previous').hidden=!manual()||!validAddress(linked)||!previous?.id;$('previous-name').textContent=previous?.username||'';
    $('address').textContent=walletOnly?account.mainWallet||'':linked||'No sign-in wallet linked.';
    $('status').textContent=walletOnly?'This wallet signs in to your account and can approve your launches and trades.':(getFeatures()?.walletOnly!==false?'Link an external wallet to return to this account with Connect wallet. Your existing password and two-factor setting remain available for account recovery.':'Connect wallet can sign in to this same account after you link a wallet. Wallet sign-in needs a wallet signature, without a password or authenticator code. Password sign-in keeps your two-factor setting.');
    $('edit').hidden=!manual()||editing;$('edit').textContent=linked?'Change sign-in wallet':'Link sign-in wallet';$('unlink').hidden=!manual()||editing||!linked;
    $('warning').textContent=account?.role==='admin'?'This wallet will be able to sign in to your administrator account. Link only a wallet you control.':'Anyone who controls this wallet can sign in to this account. Link only a wallet you control.';
    if(!manual()){$('form').hidden=true;editing=false;}controls();
  }
  function renderWallets(){
    const state=ensureWallet().state(),rows=state.wallets||[];$('wallets').replaceChildren();
    for(const row of rows){const button=document.createElement('button');button.type='button';button.className='small-button';button.textContent=row.name;button.disabled=busy;button.onclick=()=>connect(row.id);$('wallets').append(button);}
    if(!rows.length)message(noWallet($('wallets'),state),true);
  }
  async function connect(id){
    if(busy||!editing||!manual()||!isActive())return;const token=generation,accountId=getAccount().id,op=start();controls();message('Connect the wallet you want to link.');
    try{await fromWallet(op,()=>ensureWallet().connect(id));if(!current(token,accountId))return;$('wallets').hidden=true;message('');selected();}
    catch(error){if(current(token,accountId))failure(error,'Could not connect your wallet.');}
    finally{finish(op);}
  }
  async function save(){
    if(busy||!editing||!manual()||!isActive())return;
    const account=getAccount(),id=account.id,token=generation,address=ensureWallet().state().address;
    if(!validAddress(address)){message('Connect the wallet you want to link first.',true);return;}
    const op=start();controls();message('');
    try{
      if(!authorize)throw Error('Account verification is unavailable. Reopen your account and try again.');
      const credentials=await authorize('Link sign-in wallet');if(!current(token,id))return;
      if(wallet.state().address!==address)throw Error('Your wallet changed. Review the connected wallet and try again.');
      const challenge=await api('/api/account/signin-wallet/challenge',{address,...credentials});if(!current(token,id))return;
      if(wallet.state().address!==address)throw Error('Your wallet changed. Review the connected wallet and try again.');
      message('Approve the linking message in your wallet.');const signature=await fromWallet(op,()=>wallet.signMessage(challenge.message));if(!current(token,id))return;
      const now=wallet.state().address;if(now&&now!==address)throw Error('Your wallet changed while signing. Try again.');
      const result=await api('/api/account/signin-wallet',{nonce:challenge.nonce,signature});if(!current(token,id))return;
      if(result.account?.id!==id)throw Error('Your account changed. Reopen your account before continuing.');
      onSaved(result.account);cancel();render();message('Sign-in wallet linked. Use Connect wallet to return to this account.');
    }catch(error){if(current(token,id)&&error.message!=='Cancelled.')failure(error,'Could not link your sign-in wallet.');}
    finally{finish(op);}
  }
  async function unlink(){
    if(busy||!manual()||!isActive()||!getAccount().signInWallet)return;
    const id=getAccount().id,token=generation,op=start();controls();message('');
    try{
      if(!authorize)throw Error('Account verification is unavailable. Reopen your account and try again.');
      const credentials=await authorize('Unlink sign-in wallet');if(!current(token,id))return;
      const result=await api('/api/account/signin-wallet/unlink',credentials);if(!current(token,id))return;
      if(result.account?.id!==id)throw Error('Your account changed. Reopen your account before continuing.');
      onSaved(result.account);cancel();render();message(getFeatures()?.walletOnly!==false?'Sign-in wallet unlinked. Use Recover an existing account with your username and password to return.':'Sign-in wallet unlinked. You can still sign in with your username and password.');
    }catch(error){if(current(token,id)&&error.message!=='Cancelled.')message(error.message||'Could not unlink your sign-in wallet.',true);}
    finally{finish(op);}
  }
  async function openPrevious(walletId){
    const account=getAccount(),previous=account?.walletAccount,address=account?.signInWallet;
    if(busy||!manual()||!isActive()||!previous?.id||!validAddress(address))return;
    const id=account.id,target=previous.id,token=generation,op=start();controls();message('');
    try{
      ensureWallet();if(walletId){await fromWallet(op,()=>wallet.connect(walletId));if(!current(token,id))return;}
      if(wallet.state().address!==address){
        const state=wallet.state(),rows=state.wallets||[];$('previous-wallets').replaceChildren();$('previous-wallets').hidden=false;
        for(const row of rows){const button=document.createElement('button');button.type='button';button.className='small-button';button.textContent=row.name;button.onclick=()=>openPrevious(row.id);$('previous-wallets').append(button);}
        message(rows.length?'Connect your linked sign-in wallet to open its previous account.':noWallet($('previous-wallets'),state),!rows.length);return;
      }
      $('previous-wallets').hidden=true;message('Approve the sign-in message to open your previous wallet account.');
      const challenge=await api('/api/wallet/challenge',{address,accountId:target});if(!current(token,id))return;
      if(wallet.state().address!==address)throw Error('Your wallet changed. Connect your linked wallet and try again.');
      const signature=await fromWallet(op,()=>wallet.signMessage(challenge.message));if(!current(token,id))return;
      const now=wallet.state().address;if(now&&now!==address)throw Error('Your wallet changed while signing. Try again.');
      const result=await api('/api/wallet/verify',{nonce:challenge.nonce,signature});
      if(!result.authenticated||result.account?.id!==target)throw Error('Your sign-in changed. Reopen your account and try again.');
      // A successful proof already changed the browser cookie. Clear the old
      // account's visible controls even if this editor was closed meanwhile.
      window.location.reload();
    }catch(error){if(current(token,id)&&error.message!=='Cancelled.')failure(error,'Could not open your previous wallet account.');}
    finally{finish(op);}
  }
  $('edit').onclick=()=>{if(busy||!manual()||!isActive())return;editing=true;ensureWallet();$('form').hidden=false;message('');render();selected();};
  $('connect').onclick=()=>{if(busy||!editing||!manual()||!isActive())return;const rows=ensureWallet().state().wallets;if(rows.length===1)return connect(rows[0].id);$('wallets').hidden=false;renderWallets();};
  $('save').onclick=save;$('unlink').onclick=unlink;$('previous-open').onclick=()=>openPrevious();$('cancel').onclick=()=>{cancel();render();};
  return {render,cancel,destroy(){cancel();unsubscribe?.();container.replaceChildren();}};
}
