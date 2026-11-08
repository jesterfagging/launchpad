import { getLaunchpadWallet, renderWalletDeepLinks } from './launchpad-wallet.mjs';

const BASE58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// A receiving wallet must decode to exactly 32 bytes; length and alphabet alone
// also accept an address that a paste or a typo cut short.
const validWallet=value=>{
  if(typeof value!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))return false;
  const bytes=[];for(const char of value){let carry=BASE58.indexOf(char);for(let i=0;i<bytes.length;i++){carry+=bytes[i]*58;bytes[i]=carry&255;carry>>=8;}while(carry>0){bytes.push(carry&255);carry>>=8;}}
  for(let i=0;i<value.length&&value[i]==='1';i++)bytes.push(0);
  return bytes.length===32;
};

// The receiving address is a preference, never the account's authentication key.
export function createCashbackWalletUI({document,window,container,getAccount,api,authorize,onSaved=()=>{},isActive=()=>true,walletFactory=getLaunchpadWallet}={}) {
  container.classList.add('cashback-wallet-settings');
  container.innerHTML=`<h3>Cashback wallet</h3><p class="help">Choose the Solana wallet that receives your eligible cashback.</p><p data-cbw-address class="account-address"></p><div class="account-actions"><button type="button" class="small-button" data-cbw-copy>Copy address</button><button type="button" class="small-button" data-cbw-edit>Edit cashback wallet</button></div><form data-cbw-form hidden><label>Receiving wallet address<input data-cbw-input required minlength="32" autocomplete="off" spellcheck="false" autocapitalize="none" placeholder="Solana wallet address"></label><p class="help">Your sign-in wallet and coin reward settings stay the same.</p><div data-cbw-wallets class="signin-wallets" hidden></div><div class="account-actions"><button type="submit" class="primary" data-cbw-save>Verify &amp; save</button><button type="button" class="small-button" data-cbw-cancel>Cancel</button></div></form><p data-cbw-message class="help" role="status"></p>`;
  const $=name=>container.querySelector('[data-cbw-'+name+']');
  let generation=0,busy=false,identity='',editing=false,wallet=null;
  const destination=account=>account?.cashbackWallet||account?.mainWallet||'';
  const message=(text,error=false)=>{$('message').textContent=text||'';$('message').classList.toggle('account-error',error);$('message').setAttribute('role',error?'alert':'status');};
  function controls(){for(const button of container.querySelectorAll('button,input'))button.disabled=busy;}
  function current(token,id){return generation===token&&isActive()&&getAccount()?.id===id;}
  function cancel(){generation++;editing=false;$('form').hidden=true;$('wallets').hidden=true;$('wallets').replaceChildren();$('input').value='';message('');}
  function render(){
    const account=getAccount();if(identity!==account?.id){cancel();identity=account?.id||'';}
    $('address').textContent=destination(account);
    if(!editing)$('input').value=destination(account);
    $('edit').hidden=editing;controls();
  }
  function chooseWallet(){
    const state=wallet.state(),wallets=state.wallets||[];$('wallets').replaceChildren();$('wallets').hidden=false;
    for(const row of wallets){const button=document.createElement('button');button.type='button';button.className='small-button';button.textContent=row.name;button.onclick=()=>save(row.id);$('wallets').append(button);}
    // Phones have no wallet extensions: offer to reopen Launchpad inside a wallet app.
    const links=!wallets.length&&!state.discovering&&renderWalletDeepLinks({document,container:$('wallets'),links:state.deepLinks||[]});
    message(wallets.length?'Connect the wallet you use to sign in to approve this change.':links?'No wallet found in this browser. Open Launchpad in your wallet app to continue.':'Open Launchpad in your Solana wallet browser, or install a compatible wallet extension.',!wallets.length);
  }
  async function save(walletId){
    if(busy||!editing||!isActive())return;
    const account=getAccount(),id=account?.id,address=$('input').value.trim(),token=generation;
    if(!id)return;
    if(!validWallet(address)){message('Enter a valid Solana wallet address.',true);return;}
    busy=true;controls();message('');
    try{
      let proof;
      if(account.authType==='wallet'){
        wallet ||= walletFactory({window});
        if(walletId){await wallet.connect(walletId);if(!current(token,id))return;}
        if(wallet.state().address!==account.mainWallet){chooseWallet();return;}
        message('Approve the cashback wallet change in your sign-in wallet.');
        const challenge=await api('/api/account/cashback-wallet/challenge',{address});if(!current(token,id))return;
        if(wallet.state().address!==account.mainWallet)throw Error('Your wallet changed. Reconnect your sign-in wallet and try again.');
        const signature=await wallet.signMessage(challenge.message);if(!current(token,id))return;
        if(wallet.state().address!==account.mainWallet)throw Error('Your wallet changed. Reconnect your sign-in wallet and try again.');
        proof={nonce:challenge.nonce,signature};
      }else{
        if(!authorize)throw Error('Account verification is unavailable. Reopen your account and try again.');
        proof=await authorize('Change cashback wallet');if(!current(token,id))return;
      }
      const result=await api('/api/account/cashback-wallet',{address,...proof});if(!current(token,id))return;
      if(result.account?.id!==id)throw Error('Your account changed. Reopen your account before continuing.');
      onSaved(result.account);cancel();render();message('Cashback wallet saved.');
    }catch(error){if(current(token,id)&&error.message!=='Cancelled.')message(error.message||'Could not save your cashback wallet.',!error.walletRejected);}
    finally{busy=false;controls();}
  }
  $('edit').onclick=()=>{if(busy)return;editing=true;$('form').hidden=false;$('edit').hidden=true;$('input').value=destination(getAccount());message('');$('input').focus();};
  $('cancel').onclick=()=>{cancel();render();};
  $('form').onsubmit=event=>{event.preventDefault();return save();};
  $('copy').onclick=async()=>{try{await window.navigator.clipboard.writeText(destination(getAccount()));if(isActive())message('Cashback address copied.');}catch{message('Select the address to copy it.',true);}};
  return {render,cancel,destroy(){cancel();container.replaceChildren();}};
}
