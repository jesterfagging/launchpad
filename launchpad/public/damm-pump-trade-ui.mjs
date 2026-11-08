import {getLaunchpadWallet} from './launchpad-wallet.mjs';
import {createDammPumpOperation,dammPumpDecimalRaw,dammPumpUnits} from './damm-pump-ui.mjs';
const ADDRESS=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function createDammPumpTrade({document,window,root,fetcher=fetch,clock=Date.now,walletFactory=getLaunchpadWallet,onConfirmed=()=>{},openSignIn=()=>document.querySelector('[data-account-link]')?.click(),setTimer=setInterval,clearTimer=clearInterval}={}){
  if(document.head&&!document.getElementById('meteora-account-styles')){const style=document.createElement('link');style.id='meteora-account-styles';style.rel='stylesheet';style.href='/meteora-account.css?v=64';document.head.append(style);}
  root.classList.add('coin-trade-panel');
  root.innerHTML='<div class="ct-heading"><h2>Trade</h2><span data-mt-pair></span></div><div class="ct-side" role="group" aria-label="Trade direction"><button type="button" data-mt-buy aria-pressed="true">Buy</button><button type="button" data-mt-sell aria-pressed="false">Sell</button></div><div class="ct-wallet"><strong data-mt-wallet>Connect wallet</strong><button type="button" data-mt-connect class="text-button">Connect wallet</button></div><div data-mt-wallets class="ct-wallet-options" hidden></div><div data-mt-form><label class="ct-amount-label"><span data-mt-label>Buy with SOL</span><span data-mt-balance>Balance —</span><span class="ct-amount"><input data-mt-amount type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" aria-label="Trade amount"><strong data-mt-unit>SOL</strong></span></label><div class="ct-options"><label>Slippage <span class="ct-slippage-input"><input data-mt-slippage type="text" inputmode="decimal" autocomplete="off" value="1" maxlength="8" aria-label="Maximum slippage percent"><span>%</span></span></label><button data-mt-refresh type="button" class="text-button">Refresh balance</button></div><p class="ct-note" data-mt-slippage-note hidden></p></div><p class="ct-note" data-mt-progress></p><button type="button" data-mt-review class="primary ct-action">Buy</button><p class="ct-status" data-mt-status role="status"></p><div data-mt-operation hidden></div><p class="ct-note">No transfer tax. Before graduation the 1.25% pool trading fee includes approximately 1% for Launchpad. PumpSwap pool fees apply after graduation. Creator and holder rewards are not enabled.</p>';
  const $=name=>root.querySelector('[data-mt-'+name+']');
  let coin=null,session=null,side='buy',disposed=false,balance=null,balanceBusy=false,generation=0;const controllers=new Set(),wallet=walletFactory({window});
  const identity=()=>session?.authenticated?session.account?.id||session.account?.mainWallet||'':'';
  const binding=()=>[identity(),session?.token,coin?.mint,wallet.state().address].join(':');
  const active=()=>!disposed&&!!coin?.mint;
  async function request(path,body){
    const key=binding(),controller=new AbortController();controllers.add(controller);const timeout=window.setTimeout(()=>controller.abort(),20000);
    try{const response=await fetcher('/api/launchpad/damm-pump'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:{'x-control-token':session?.token||'',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:controller.signal});const data=await response.json();if(disposed||key!==binding())throw Object.assign(Error('Wallet or account changed.'),{cancelled:true});if(!response.ok)throw Object.assign(Error(data.error||'Trade unavailable.'),{status:response.status,code:data.code,retryAfterMs:data.retryAfterMs});return data;}finally{window.clearTimeout(timeout);controllers.delete(controller);}
  }
  // Decorative only: one confetti burst per confirmed trade, at the first confirmed or finalized callback.
  let celebrated='';const celebrate=result=>{const id=String(result?.operation?.id||'');if(id&&id===celebrated)return;celebrated=id;try{document.dispatchEvent(new (document.defaultView?.CustomEvent||CustomEvent)('curve-celebrate'));}catch{}};
  const operation=createDammPumpOperation({document,root:$('operation'),request,wallet,clock,context:()=>({active:active()&&!!identity(),key:binding(),mint:coin?.mint,symbol:coin?.symbol,quoteMint:coin?.quote?.mint,quoteSymbol:coin?.quote?.symbol,quoteDecimals:coin?.quote?.decimals,baseDecimals:coin?.baseDecimals??6}),onChange:render,onConfirmed:async result=>{celebrate(result);await Promise.all([refresh(),Promise.resolve(onConfirmed(result))]);},onFinalized:async result=>{celebrate(result);await Promise.all([refresh(),Promise.resolve(onConfirmed(result))]);}});
  function render(){
    if(disposed)return;root.hidden=!coin?.mint;const address=wallet.state().address,authenticated=!!identity(),migrating=coin?.curveStatus==='migrating';
    $('pair').textContent=(coin?.symbol||'TOKEN')+' / '+(coin?.quote?.symbol||'quote');$('buy').setAttribute('aria-pressed',String(side==='buy'));$('sell').setAttribute('aria-pressed',String(side==='sell'));
    $('wallet').textContent=address?address.slice(0,5)+'…'+address.slice(-5):'Connect wallet';root.querySelector('.ct-wallet').hidden=!address;$('wallet').title=address||'';$('connect').textContent=address?'Change wallet':'Connect wallet';$('form').hidden=!authenticated||!address;
    $('label').textContent=side==='buy'?'Buy with '+(coin?.quote?.symbol||'quote'):'Sell '+(coin?.symbol||'TOKEN');$('unit').textContent=side==='buy'?coin?.quote?.symbol||'quote':coin?.symbol||'TOKEN';$('balance').textContent='Balance '+dammPumpUnits(side==='buy'?balance?.quoteBalanceRaw:balance?.baseBalanceRaw,side==='buy'?coin?.quote?.decimals:coin?.baseDecimals??6);
    $('progress').textContent=migrating?'Graduation to PumpSwap is in progress.':coin?.stage==='graduated'?'Trading on PumpSwap.':coin?.progressPercent!=null?Number(coin.progressPercent).toFixed(1)+'% to graduation.':'Trading on Meteora. Graduates to PumpSwap.';
    $('review').textContent=!authenticated||!address?'Connect wallet':migrating?'Graduating…':operation.busy?'Please wait…':side==='buy'?'Buy':'Sell';$('review').disabled=operation.busy||operation.pending||migrating||!Number.isInteger(coin?.quote?.decimals);
    for(const element of [$('amount'),$('slippage'),$('buy'),$('sell'),$('connect')])element.disabled=operation.busy||operation.pending;$('refresh').disabled=balanceBusy;
    const slippage=Number($('slippage').value);$('slippage-note').hidden=!(slippage>5);$('slippage-note').textContent=slippage===100?'100% slippage permits receiving zero output.':'High slippage can result in a lower return.';
  }
  async function recover(){if(!active()||!identity()||!wallet.state().address||operation.operation)return;try{const saved=await request('/operations');const pending=[...(saved.operations||[])].reverse().find(x=>x.mint===coin.mint&&x.wallet===wallet.state().address&&['buy','sell'].includes(x.action)&&!['failed','expired','cancelled','finalized'].includes(x.state));if(pending&&operation.restore(pending))await operation.reconcile();}catch(error){if(!error.cancelled)$('status').textContent=error.message;}}
  async function refresh(){
    if(!active()||!identity()||!ADDRESS.test(wallet.state().address||'')||balanceBusy)return;const version=generation;balanceBusy=true;render();
    try{const result=await request('/wallet',{mint:coin.mint,expectedWallet:wallet.state().address});if(version!==generation)return;balance=typeof result.wallet==='object'?result.wallet:result;$('status').textContent='';}
    catch(error){if(!error.cancelled)$('status').textContent=error.message;}finally{balanceBusy=false;render();}
  }
  function connect(){
    if(!identity())return openSignIn();if(operation.busy||operation.pending)return;
    const choices=wallet.state().wallets;$('wallets').replaceChildren();$('wallets').hidden=!$('wallets').hidden;
    for(const item of choices){const button=document.createElement('button');button.type='button';button.className='small-button';button.textContent=item.name;button.onclick=async()=>{try{await wallet.connect(item.id);$('wallets').hidden=true;await refresh();}catch(error){$('status').textContent=error.message;}};$('wallets').append(button);}
    if(!choices.length)$('wallets').textContent='Open Launchpad in your Solana wallet browser or use a wallet extension.';
  }
  $('connect').onclick=connect;$('refresh').onclick=refresh;
  // Switching Buy/Sell starts a new trade: earlier status and finished-operation messages are cleared.
  const setSide=next=>{if(operation.pending||operation.busy)return;side=next;$('amount').value='';$('status').textContent='';operation.reset();render();};
  $('buy').onclick=()=>setSide('buy');$('sell').onclick=()=>setSide('sell');
  $('slippage').oninput=$('amount').oninput=()=>{operation.clearUnsigned();render();};
  // Slippage has its own message; the amount parser's wording would point at the amount.
  const slippageBps=value=>{let bps=NaN;try{bps=Number(dammPumpDecimalRaw(value,2));}catch{}return Number.isInteger(bps)&&bps>=0&&bps<=10000?bps:null;};
  $('review').onclick=async()=>{if(!identity()||!wallet.state().address)return connect();try{if(!Number.isInteger(coin?.quote?.decimals))throw Error('Quote token precision is unavailable. Refresh this coin before trading.');const amountRaw=dammPumpDecimalRaw($('amount').value,side==='buy'?coin?.quote?.decimals:coin?.baseDecimals??6);if(BigInt(amountRaw)<=0n)throw Error('Enter an amount greater than zero.');const bps=slippageBps($('slippage').value);if(bps===null)throw Error('Enter slippage from 0% to 100%, with up to two decimal places.');$('status').textContent='';const result=await operation.prepare({action:side,mint:coin.mint,amountRaw,slippageBps:bps});if(result?.operation&&result.operation.review?.atomicGraduation!==true)await operation.submit();}catch(error){$('status').textContent=error.message;}};
  const unsubscribe=wallet.onChange(()=>{generation++;balance=null;operation.reset();render();void refresh();});
  function setSession(next){const previous=binding();session=next;if(binding()!==previous){generation++;balance=null;operation.reset();}render();void refresh().then(recover);}
  function setCoin(next){const changed=coin?.mint!==next?.mint;coin=next;if(changed){generation++;balance=null;operation.reset();}render();if(changed)void refresh().then(recover);}
  const timer=setTimer(()=>{if(!disposed&&!document.hidden)void operation.poll();},5000);
  return {setCoin,setSession,refresh,canLeave:operation.canLeave,destroy(){disposed=true;generation++;clearTimer(timer);unsubscribe?.();operation.destroy();for(const controller of controllers)controller.abort();root.replaceChildren();}};
}
