import {createDammPumpTrade} from './damm-pump-trade-ui.mjs';
import {isDammPumpCoin} from './damm-pump-ui.mjs';
import {createMeteoraTrade} from './meteora-trade-ui.mjs';
import {createPublicPumpTrade} from './pump-public-trade-ui.mjs';
import {isPumpCoin} from './pump-public-ui.mjs';
import {createPumpClassicTrade,isPumpClassicCoin} from './pump-classic-coin.mjs';
import { getLaunchpadWallet, renderWalletDeepLinks } from './launchpad-wallet.mjs';

const ADDRESS=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE=/^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const WSOL='So11111111111111111111111111111111111111112';
const short=value=>typeof value==='string'&&value?value.slice(0,5)+'…'+value.slice(-5):'';
const active=trade=>trade&&['pending','submitted','unknown','confirming'].includes(trade.state);
const ready=trade=>trade&&['prepared','awaiting_signature'].includes(trade.state);
export function rawTradeAmount(value,decimals=0){
  if(!/^\d+$/.test(String(value??''))||!Number.isInteger(decimals)||decimals<0||decimals>18)return null;
  const raw=String(value).replace(/^0+(?=\d)/,''),padded=raw.padStart(decimals+1,'0');
  return decimals?(padded.slice(0,-decimals)+'.'+padded.slice(-decimals)).replace(/\.?0+$/,''):raw;
}
export function tradePreset(value,decimals,percent){
  if(![25,50,100].includes(percent)||rawTradeAmount(value,decimals)===null)return '';
  return rawTradeAmount((BigInt(value)*BigInt(percent)/100n).toString(),decimals);
}
export function normalizeTradeAmount(value,decimals=18){
  if(typeof value!=='string'||!Number.isInteger(decimals)||decimals<0||decimals>18)return null;
  const text=value.trim();
  if(text.length>48||!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text))return null;
  const [whole='',fraction]=text.split('.'),integer=(whole||'0').replace(/^0+(?=\d)/,'');
  if(integer.length>20||(fraction?.length||0)>decimals||!/[1-9]/.test(text))return null;
  // Keep the user's exact decimal precision; Number() can round token amounts.
  return integer+(fraction===undefined?'':'.'+fraction);
}
export function tradeSlippageBps(value){
  if(typeof value!=='string')return null;
  const text=value.trim();
  if(text.length>8||!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(text))return null;
  const [whole='',fraction='']=text.split('.'),bps=Number(whole||'0')*100+Number(fraction.padEnd(2,'0'));
  return Number.isSafeInteger(bps)&&bps>=0&&bps<=10000?bps:null;
}
const exactAmount=value=>{const text=String(value??'');if(!/^\d+(?:\.\d+)?$/.test(text))return '—';const [whole,fraction]=text.split('.');return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(fraction?'.'+fraction:'');};
const display=value=>value==null?'—':new Intl.NumberFormat(undefined,{maximumSignificantDigits:8}).format(Number(value));
const key=session=>session?.authenticated&&session.account?.id?session.account.id:'';

export function createRaydiumCoinTrade({document,window,root,fetcher=fetch,clock=Date.now,random=Math.random,walletFactory=getLaunchpadWallet,onConfirmed=()=>{},openSignIn=()=>document.querySelector('[data-account-link]')?.click(),setTimer=setInterval,clearTimer=clearInterval}={}){
  if(!root)return {setCoin(){},setSession(){},destroy(){},refresh:async()=>{}};
  root.classList.add('coin-trade-panel');root.setAttribute('aria-label','Buy and sell this coin');
  root.innerHTML=`<div class="ct-heading"><h2>Trade</h2><span data-ct-pair></span></div><div class="ct-side" role="group" aria-label="Trade direction"><button type="button" data-ct-buy aria-pressed="true">Buy</button><button type="button" data-ct-sell aria-pressed="false">Sell</button></div><div class="ct-wallet"><div><span data-ct-wallet-label>Trading wallet</span><strong data-ct-wallet-address>Connect wallet to trade</strong></div><button type="button" class="text-button" data-ct-connect>Connect wallet</button></div><div data-ct-wallet-options class="ct-wallet-options" hidden></div><p data-ct-gate class="ct-note">Connect your wallet to trade. Your profile is created automatically.</p><div data-ct-form hidden><label class="ct-amount-label"><span data-ct-input-label>Buy with</span><span data-ct-balance>Balance —</span><span class="ct-amount"><input data-ct-amount type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" aria-label="Trade amount"><strong data-ct-input-symbol></strong></span></label><div class="ct-presets" data-ct-presets hidden><button type="button" data-ct-percent="25">25%</button><button type="button" data-ct-percent="50">50%</button><button type="button" data-ct-percent="100">100%</button></div><div class="ct-options"><label>Slippage <span class="ct-slippage-input"><input data-ct-slippage type="text" inputmode="decimal" autocomplete="off" value="1" maxlength="8" aria-label="Maximum slippage percent" title="0% to 100%, up to two decimal places"><span>%</span></span></label><button type="button" class="text-button" data-ct-refresh>Refresh balance</button></div><p class="ct-note ct-slippage-note" data-ct-slippage-note hidden></p><p class="ct-note" data-ct-direction></p><div class="ct-review" data-ct-review hidden><h3>Review trade</h3><dl><div><dt>You pay</dt><dd data-ct-pay></dd></div><div><dt>Estimated receive</dt><dd data-ct-output></dd></div><div><dt>Minimum receive</dt><dd data-ct-minimum></dd></div><div><dt>Maximum slippage</dt><dd data-ct-tolerance></dd></div><div data-ct-cost-row hidden><dt>Network + account setup (max)</dt><dd data-ct-cost></dd></div></dl><p class="ct-note" data-ct-route-warning hidden></p><p class="ct-note" data-ct-approval></p></div></div><button type="button" class="primary ct-action" data-ct-action>Connect wallet</button><button type="button" class="text-button ct-cancel" data-ct-cancel hidden>Cancel review</button><p data-ct-status class="ct-status" role="status" aria-live="polite"></p><a data-ct-receipt class="ct-receipt" target="_blank" rel="noopener noreferrer" hidden>View transaction ↗</a>`;
  const $=name=>root.querySelector('[data-ct-'+name+']');
  let coin=null,session=null,side='buy',wallet=null,unsubscribe=null,connected='',walletInfo=null,quote=null,trade=null,busy=false,busyLabel='Please wait…',disposed=false,generation=0,balanceGeneration=0,statusBusy=false,pollAt=0,pollDelay=3000,statusFailures=0,announced='',notice='',noticeError=false;
  const controllers=new Set();
  const identity=()=>key(session);
  const walletOnly=()=>session?.features?.walletOnly!==false;
  const requiresConnection=()=>walletOnly()||session?.account?.authType==='wallet'||walletInfo?.requiresConnection===true;
  function selected(){return connected||requiresConnection()?{mode:'external',wallet:connected}:{mode:'default'};}
  function selectedAddress(){return connected||(requiresConnection()?'':walletInfo?.address||session?.account?.mainWallet||'');}
  function sessionBinding(){return identity()+':'+(session?.token||'');}
  function fingerprint(){return [sessionBinding(),coin?.mint,connected||(requiresConnection()?'unconnected':'default')].join(':');}
  function alive(version){return !disposed&&version===generation;}
  function message(text='',error=false){notice=text;noticeError=error;$('status').textContent=text;$('status').classList.toggle('ct-error',error);$('status').setAttribute('role',error?'alert':'status');}
  async function api(path,body){
    const controller=new AbortController();controllers.add(controller);const timer=window.setTimeout(()=>controller.abort(),20000);
    try{const response=await fetcher('/api/launchpad/trading/'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{'x-control-token':session?.token||'',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:controller.signal});const data=await response.json();if(!response.ok)throw Object.assign(Error(data.error||'This trade could not be completed.'),{status:response.status});return data;}
    finally{window.clearTimeout(timer);controllers.delete(controller);}
  }
  function invalidate({clearTrade=false}={}){generation++;quote=null;if(clearTrade)trade=null;busy=false;$('review').hidden=true;}
  function walletChanged(state){
    // Connecting a first wallet is not a change: only switching or disconnecting a wallet warns.
    const address=ADDRESS.test(state?.address||'')?state.address:'';if(address!==connected){const old=trade,previous=connected;connected=address;invalidate({clearTrade:!active(old)});walletInfo=null;message(previous?'Wallet changed. Check your amount and try again.':'');if(ready(old)&&identity())void api('cancel',{tradeId:old.id}).catch(()=>{});void refresh();}
    if(!$('wallet-options').hidden)renderWallets();render();
  }
  function ensureWallet(){if(!wallet){wallet=walletFactory({window});connected=ADDRESS.test(wallet.state()?.address||'')?wallet.state().address:'';unsubscribe=wallet.onChange?.(walletChanged);}return wallet;}
  function renderWallets(){
    const state=ensureWallet().state()||{},rows=state.wallets||[];$('wallet-options').replaceChildren();
    for(const row of rows){const button=document.createElement('button');button.type='button';button.className='small-button';button.textContent=row.name;button.disabled=busy||active(trade);button.onclick=()=>connect(row.id);$('wallet-options').append(button);}
    if(!rows.length){const note=document.createElement('p');note.className='ct-note';note.textContent='Open Launchpad in your Solana wallet browser or use a compatible wallet extension.';$('wallet-options').append(note);if(!state.discovering)renderWalletDeepLinks({document,container:$('wallet-options'),links:state.deepLinks||[]});}
  }
  async function connect(id){
    if(busy||active(trade))return;message('');
    try{await ensureWallet().connect(id);if(disposed)return;$('wallet-options').hidden=true;await refresh();}
    catch(error){if(!disposed){message(error.message||'Wallet connection was cancelled.',true);render();}}
  }
  function connectChoice(){
    if(!identity()){openSignIn();return;}if(busy||active(trade))return;
    const rows=ensureWallet().state().wallets||[];if(rows.length===1)return connect(rows[0].id);$('wallet-options').hidden=!$('wallet-options').hidden;renderWallets();
  }
  function validQuote(value){return (!requiresConnection()||!!connected)&&value&&value.mint===coin?.mint&&typeof value.id==='string'&&value.side===side&&value.wallet===selectedAddress()&&value.mode===selected().mode&&Number(value.expiresAt)>clock()&&value.expectedOutput!=null&&value.minimumOutput!=null;}
  function inputBalance(){return side==='buy'?rawTradeAmount(walletInfo?.nativeBalanceLamports,9):rawTradeAmount(walletInfo?.baseBalanceRaw,walletInfo?.baseDecimals);}
  function render(){
    if(disposed)return;root.hidden=!coin?.mint;const authenticated=!!identity(),symbol=coin?.symbol||'TOKEN',paired='SOL',inSymbol=side==='buy'?paired:symbol;
    // Trades are paid and received in SOL. A coin paired with another asset routes through SOL, so the label names
    // the trading currency instead of reading like the coin's pool pair.
    const solPair=!coin?.quote?.mint||coin.quote.mint===WSOL||coin.quote.symbol==='SOL';
    $('pair').textContent=solPair?symbol+' / '+paired:symbol+' · trades in '+paired;$('buy').setAttribute('aria-pressed',String(side==='buy'));$('sell').setAttribute('aria-pressed',String(side==='sell'));
    const displayWallet=active(trade)?trade.quote?.wallet||selectedAddress():selectedAddress();$('wallet-label').textContent=active(trade)?'Pending transaction wallet':connected?'Connected wallet':requiresConnection()?'Trading wallet':'Main wallet';$('wallet-address').textContent=authenticated?short(displayWallet)||'Connect a wallet':walletOnly()?'Connect wallet to trade':'Sign in to trade';$('wallet-address').title=authenticated?displayWallet:'';
    $('connect').textContent=connected?'Change':'Connect wallet';$('gate').hidden=authenticated&&(!requiresConnection()||!!connected);$('gate').textContent=walletOnly()?'Connect your wallet to trade. Approve each transaction in your wallet.':'Connect wallet OR sign in with your username and password.';$('form').hidden=!authenticated||requiresConnection()&&!connected;
    $('input-label').textContent=side==='buy'?'Buy with '+paired:'Sell '+symbol;$('input-symbol').textContent=inSymbol;$('balance').textContent='Balance '+display(inputBalance());$('amount').setAttribute('aria-label',side==='buy'?'Amount of '+paired+' to spend':'Amount of '+symbol+' to sell');$('presets').hidden=side!=='sell';
    $('direction').textContent=side==='buy'?'Pay in '+paired+'. Network fees are paid in SOL.':'Receive '+paired+'. Network fees are paid in SOL.';
    const needsWallet=authenticated&&!connected&&requiresConnection(),pending=active(trade),review=ready(trade)?trade.quote:quote;
    root.querySelector('.ct-wallet').hidden=!authenticated||needsWallet&&!pending;
    if(authenticated&&needsWallet){$('direction').textContent='Connect your wallet to approve trades. Your wallet keys stay in your wallet.';}
    const tolerance=review?.slippageBps??tradeSlippageBps($('slippage').value);
    $('slippage-note').textContent=tolerance===10000?'100% slippage sets the minimum received to 0.':tolerance>500?'High slippage can result in a much lower return.':'';$('slippage-note').hidden=!$('slippage-note').textContent;
    $('review').hidden=!review||pending||(review.mode==='external'&&busy);
    if(review){$('pay').textContent=exactAmount(review.amount)+' '+(review.inputSymbol||inSymbol);$('output').textContent=exactAmount(review.expectedOutput)+' '+review.outputSymbol;$('minimum').textContent=exactAmount(review.minimumOutput)+' '+review.outputSymbol;$('tolerance').textContent=display(Number(review.slippageBps)/100)+'%';const fee=String(review.networkFeeLamports??''),rent=String(review.rentLamports??'');$('cost-row').hidden=!/^\d+$/.test(fee)||!/^\d+$/.test(rent);if(!$('cost-row').hidden)$('cost').textContent=rawTradeAmount((BigInt(fee)+BigInt(rent)).toString(),9)+' SOL';$('route-warning').textContent=review.warning||(review.residualQuotePossible?'An unused balance of '+(review.quoteSymbol||coin?.quote?.symbol||'the paired asset')+' may remain in your wallet after conversion.':'');$('route-warning').hidden=!$('route-warning').textContent;$('approval').textContent=(review.mode==='external'?'Confirm, then approve the transaction in your wallet.':'Confirm to trade from your account’s Main wallet.')+' Pool fees are included in the quote.';}
    $('action').textContent=!authenticated?(walletOnly()?'Connect wallet':'Connect wallet or sign in'):pending?'Checking confirmation…':busy?busyLabel:needsWallet?'Connect wallet':review?(review.mode==='external'?'Continue '+side:'Confirm '+side):connected?(side==='buy'?'Buy':'Sell'):'Review '+side;
    $('action').disabled=!!(busy||pending||authenticated&&!needsWallet&&walletInfo?.available===false&&!walletInfo?.requiresConnection);
    for(const node of [$('buy'),$('sell'),$('amount'),$('slippage'),$('connect'),$('refresh'),...root.querySelectorAll('[data-ct-percent]')])node.disabled=busy||pending||ready(trade);
    $('cancel').hidden=!review||pending||(review.mode==='external'&&busy);$('cancel').disabled=busy;
    const signature=trade?.signature;$('receipt').hidden=!SIGNATURE.test(signature||'');if(!$('receipt').hidden)$('receipt').href='https://solscan.io/tx/'+signature;else $('receipt').removeAttribute('href');
  }
  async function refresh(){
    if(disposed||!coin?.mint||!identity())return;ensureWallet();if(requiresConnection()&&!connected){walletInfo=null;render();return;}const current=fingerprint(),read=++balanceGeneration;
    try{const result=await api('wallet',{mint:coin.mint,...selected()});if(disposed||read!==balanceGeneration||current!==fingerprint())return;walletInfo=result.wallet;if(walletInfo?.mode!==selected().mode||connected&&walletInfo.address!==connected){walletInfo=null;throw Error('The wallet response changed. Refresh your balance.');}if(walletInfo.available===false&&walletInfo.reason)message(walletInfo.reason,true);render();}
    catch(error){if(!disposed&&read===balanceGeneration&&current===fingerprint()){message(error.name==='AbortError'?'Balance check timed out. Try refreshing.':error.message,true);render();}}
  }
  function acceptTrade(value){
    if(!value)return;trade=value;quote=null;if(ready(value)&&['buy','sell'].includes(value.quote?.side)){side=value.quote.side;if(Number.isInteger(value.quote.slippageBps)&&value.quote.slippageBps>=0&&value.quote.slippageBps<=10000)$('slippage').value=String(value.quote.slippageBps/100);}
    if(active(value)){pollDelay=Number.isInteger(value.pollAfterMs)?Math.max(3000,Math.min(30000,value.pollAfterMs)):3000;message(value.error||'Transaction submitted. Waiting for onchain confirmation. Do not submit another trade.');}
    else if(value.state==='confirmed'){message('Trade confirmed. Your balances and market are updating.');if(announced!==value.id){announced=value.id;$('amount').value='';void refresh();Promise.resolve(onConfirmed(value)).catch(()=>{});
      if(clock()-Number(value.updatedAt)<120000)try{document.dispatchEvent(new (document.defaultView?.CustomEvent||CustomEvent)('curve-celebrate'));}catch{}}}
    else if(['failed','expired','cancelled'].includes(value.state))message(value.error||({failed:'The transaction failed. Review a fresh quote to try again.',expired:'The transaction expired without confirmation. Review a fresh quote.',cancelled:'Trade cancelled.'}[value.state]),value.state!=='cancelled');
    else if(ready(value))message('An unfinished trade is saved. Review its details before continuing.');
    render();
  }
  async function checkSaved(force=false){
    if(disposed||!identity()||!coin?.mint||statusBusy||(!force&&(!active(trade)||document.hidden||clock()<pollAt)))return;
    const current=sessionBinding()+':'+coin.mint;statusBusy=true;pollAt=clock()+pollDelay+Math.floor(random()*1000);
    try{const result=await api('status',trade?.id?{tradeId:trade.id}:{mint:coin.mint});if(disposed||current!==sessionBinding()+':'+coin?.mint)return;
      statusFailures=0;const saved=result.trade;if(saved&&(!ready(saved)||saved.quote?.wallet===selectedAddress()&&saved.quote?.mode===selected().mode))acceptTrade(saved);
      else if(saved&&ready(saved)){trade=saved;message('An unfinished trade belongs to '+short(saved.quote?.wallet)+'. Cancel the saved trade before using another wallet.',true);render();$('action').disabled=true;$('cancel').hidden=false;}
      pollAt=clock()+pollDelay+Math.floor(random()*1000);
    }catch(error){if(!disposed&&current===sessionBinding()+':'+coin?.mint&&trade){statusFailures++;pollAt=clock()+Math.min(30000,3000*2**Math.min(4,statusFailures))+Math.floor(random()*1000);message('Confirmation is still being checked. The same saved transaction is being tracked; no replacement trade will be created.',true);render();}}
    finally{statusBusy=false;}
  }
  async function review(){
    if(busy||active(trade)||!identity())return;if(requiresConnection()&&!connected)return connectChoice();const amount=normalizeTradeAmount($('amount').value),slippageBps=tradeSlippageBps($('slippage').value);
    if(amount===null){message('Enter an amount greater than zero using plain decimal notation.',true);return;}
    const decimals=side==='buy'?9:walletInfo?.baseDecimals;
    if(Number.isInteger(decimals)&&normalizeTradeAmount(amount,decimals)===null){message((side==='buy'?'SOL':coin?.symbol||'Token')+' amounts support up to '+decimals+' decimal places.',true);return;}
    if(slippageBps===null){message('Enter slippage from 0% to 100%, with up to two decimal places.',true);return;}
    $('amount').value=amount;
    const version=generation,selectedWallet=selectedAddress();let direct=false;busy=true;busyLabel='Getting quote…';message('Getting a quote…');render();
    try{const result=await api('quote',{mint:coin.mint,...selected(),side,amount,slippageBps});if(!alive(version))return;if(selectedAddress()!==selectedWallet||!validQuote(result.quote))throw Error('The quote expired or the wallet changed. Try again.');if(result.quote.amount!==amount||result.quote.slippageBps!==slippageBps)throw Error('The quote did not match your amount or slippage. Try again.');quote=result.quote;trade=null;direct=quote.mode==='external';if(!direct)message('Review the amounts below before confirming.');}
    catch(error){if(alive(version))message(error.name==='AbortError'?'Quote request timed out. Try again.':error.message,true);}
    finally{if(alive(version)){busy=false;if(!direct)render();}}
    // The same Buy/Sell click obtains a checked quote and opens wallet approval.
    // A connected wallet still signs explicitly; hosted trades keep confirmation.
    if(direct&&alive(version))await confirm();
  }
  async function confirm(){
    if(busy||active(trade)||!identity())return;if(requiresConnection()&&!connected)return connectChoice();const reviewed=ready(trade)?trade.quote:quote;if(!validQuote(reviewed)){invalidate();message('Your quote expired or your wallet changed. Try again.',true);render();return;}
    const version=generation,chosen=fingerprint();busy=true;busyLabel='Preparing trade…';message('Preparing your trade…');render();let prepared=trade;const originalIdentity=identity();
    try{
      if(!ready(prepared)){const requestId=window.crypto?.randomUUID?.()||globalThis.crypto.randomUUID();const result=await api('prepare',{quoteId:reviewed.id,requestId});if(!alive(version)||chosen!==fingerprint()){if(identity()===originalIdentity&&ready(result.trade))void api('cancel',{tradeId:result.trade.id}).catch(()=>{});return;}prepared=result.trade;if(!prepared?.id||!ready(prepared))throw Error('The prepared trade is unavailable. Check its saved status.');trade=prepared;}
      if(['id','mint','wallet','mode','side','amount','inputSymbol','outputSymbol','minimumOutput','expectedOutput','slippageBps'].some(field=>prepared.quote?.[field]!==reviewed[field]))throw Error('The prepared trade did not match your review. Cancel it and get a fresh quote.');
      const payload={tradeId:prepared.id,confirm:true};
      if(reviewed.mode==='external'){
        if(ensureWallet().state().address!==reviewed.wallet)throw Error('Reconnect the same wallet before signing.');
        busyLabel='Approve in wallet…';message('Approve this '+side+' in your connected wallet.');render();
        try{payload.signedTransaction=await wallet.sign({wallet:reviewed.wallet,transaction:prepared.unsignedTransaction});}
        catch(error){if(alive(version)){await api('cancel',{tradeId:prepared.id}).catch(()=>{});trade=null;quote=null;message('Wallet approval was cancelled or failed. Nothing was submitted.',true);}return;}
        if(!alive(version)||chosen!==fingerprint()||wallet.state().address!==reviewed.wallet)return;
      }
      message('Submitting once and checking confirmation…');
      // Retain the prepared ID before a network request. A lost response is
      // reconciled through status; the UI never retries transaction submission.
      trade={...prepared,state:'pending'};render();
      try{const result=await api('submit',payload);if(!alive(version))return;acceptTrade(result.trade);}
      catch(error){if(alive(version)){message('The submission response was interrupted. Checking the saved transaction before any further trade.',true);pollAt=0;await checkSaved(true);}}
    }catch(error){if(alive(version)){message(error.message||'Could not prepare your trade.',true);await checkSaved(true);}}
    finally{if(alive(version)){busy=false;render();}}
  }
  async function cancel(){
    if(busy||active(trade))return;const version=generation;busy=true;busyLabel='Cancelling…';render();
    try{if(ready(trade)){const result=await api('cancel',{tradeId:trade.id});if(!alive(version))return;if(active(result.trade)){acceptTrade(result.trade);return;}}invalidate({clearTrade:true});message('');}
    catch(error){if(alive(version))message(error.message,true);}finally{busy=false;render();}
  }
  function setSide(next){if(busy||active(trade)||ready(trade)||side===next)return;side=next;invalidate({clearTrade:true});$('amount').value='';message('');render();}
  $('buy').onclick=()=>setSide('buy');$('sell').onclick=()=>setSide('sell');$('connect').onclick=connectChoice;
  $('refresh').onclick=refresh;$('cancel').onclick=cancel;
  $('amount').oninput=$('slippage').oninput=$('slippage').onchange=()=>{if(busy||active(trade)||ready(trade))return;invalidate({clearTrade:true});message('');render();};
  for(const button of root.querySelectorAll('[data-ct-percent]'))button.onclick=()=>{if(busy||active(trade)||ready(trade))return;$('amount').value=tradePreset(walletInfo?.baseBalanceRaw,walletInfo?.baseDecimals,Number(button.dataset.ctPercent));invalidate({clearTrade:true});message('');render();};
  $('action').onclick=()=>{if(!identity())return openSignIn();if(!connected&&requiresConnection())return connectChoice();return quote||ready(trade)?confirm():review();};
  function setCoin(next){const changed=coin?.mint!==next?.mint;coin=next;if(changed){balanceGeneration++;invalidate({clearTrade:true});walletInfo=null;$('amount').value='';message('');if(identity()){void refresh().then(()=>checkSaved(true));}}render();}
  function setSession(next){
    if(disposed)return;const sameAccount=!!key(next)&&key(next)===identity(),changed=!sameAccount||next?.token!==session?.token||next?.features?.walletOnly!==session?.features?.walletOnly,previous=trade;session=next;if(changed){balanceGeneration++;invalidate({clearTrade:!sameAccount||!active(previous)});walletInfo=null;statusBusy=false;announced='';$('amount').value='';message('');}
    if(identity()&&coin?.mint){ensureWallet();if(changed){const cleanup=sameAccount&&ready(previous)?api('cancel',{tradeId:previous.id}).catch(()=>{}):Promise.resolve();void cleanup.then(()=>refresh()).then(()=>checkSaved(true));}}render();
  }
  const accountUpdated=event=>setSession(event.detail||{authenticated:false});document.addEventListener('curve-account-updated',accountUpdated);
  const timer=setTimer(()=>{if(quote&&Number(quote.expiresAt)<=clock()&&!busy){quote=null;message('Your quote expired. Click Buy or Sell again for a fresh quote.');render();}void checkSaved();},1000);
  render();
  return {setCoin,setSession,refresh,checkSaved,canLeave:()=>!busy&&!ready(trade),destroy(){disposed=true;generation++;clearTimer(timer);unsubscribe?.();for(const controller of controllers)controller.abort();document.removeEventListener('curve-account-updated',accountUpdated);}};
}

// Keep Launchpad's pre-graduation custody transactions separate from pool routes.
export function createCoinTrade(options={}){
  let controller=null,venue='',session=null,coin=null;
  // Pump.fun coins trade on Pump.fun; Launchpad links there instead of routing the trade.
  const choose=next=>isPumpClassicCoin(next)?'pump-classic':isDammPumpCoin(next)?'damm-pump':next?.platform==='meteora'?'meteora':isPumpCoin(next)&&next?.stage!=='graduated'?'pump':'pool';
  function mount(next){const key=choose(next);if(controller&&key===venue)return;controller?.destroy();venue=key;controller=(key==='pump-classic'?createPumpClassicTrade:key==='damm-pump'?createDammPumpTrade:key==='meteora'?createMeteoraTrade:key==='pump'?createPublicPumpTrade:createRaydiumCoinTrade)(options);controller.setSession(session);}
  return {setCoin(next){coin=next;mount(next);controller.setCoin(next);},setSession(next){session=next;controller?.setSession(next);},refresh:()=>controller?.refresh(),checkSaved:(...args)=>controller?.checkSaved?.(...args),canLeave:()=>controller?.canLeave?.()!==false,destroy(){controller?.destroy();controller=null;}};
}
