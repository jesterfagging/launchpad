// Private preview helpers and owner-funded wallet UI. Transactions are prepared,
// verified and submitted only by the separately gated server test service.
export function pumpPreviewInput({asset,preset='standard',quoteUsd,graduationPercent,tradePercent}){
  if(!asset||asset.testSelectable!==true||asset.poolCompatible!==true||asset.mintCompatibility!=='supported'||asset.launchReady!==false||!asset.id)throw Error('Choose a verified PumpSwap test pair.');
  if(!['standard','micro-test'].includes(preset))throw Error('Choose a supported private test size.');
  const fixed=(value,places,label)=>{const source=String(value??'').trim();if(source.length>24||!new RegExp('^(?:0|[1-9]\\d*)(?:\\.\\d{1,'+places+'})?$').test(source))throw Error('Enter '+label+'.');const [whole,part='']=source.split('.');return BigInt(whole)*10n**BigInt(places)+BigInt(part.padEnd(places,'0'));};
  const quoteUsdMicros=fixed(quoteUsd,6,'a manual quote price in USD (up to 6 decimals)'),graduationFeeBps=fixed(graduationPercent,2,'a graduation fee percentage (up to 2 decimals)'),tradeFeeBps=fixed(tradePercent,2,'a bonding trade fee percentage (up to 2 decimals)');
  if(quoteUsdMicros>1000000000000n)throw Error('The manual quote price cannot exceed $1,000,000.');
  if(quoteUsdMicros<=0n)throw Error('The manual quote price must be greater than zero.');
  if(graduationFeeBps!==2885n)throw Error('The private test uses a fixed 28.85% graduation fee.');
  if(tradeFeeBps>300n)throw Error('The bonding trade fee cannot exceed 3% in this test.');
  return {preset,quoteId:asset.id,quoteUsdMicros:quoteUsdMicros.toString(),graduationFeeBps:Number(graduationFeeBps),tradeFeeBps:Number(tradeFeeBps)};
}
export function validPumpPreview(value,preset='standard'){
  const start=preset==='micro-test'?100:20000,graduation=preset==='micro-test'?500:50000;
  return value?.mode==='local-test'&&value.fundedLaunchEnabled===false&&value.publicLaunchEnabled===false&&value.preset===preset&&Number(value.startingFdvUsd)===start&&Number(value.graduationFdvUsd)===graduation&&value.estimate&&['quoteCollectedUsd','graduationFeeUsd','lpQuoteUsd','lpTokenValueUsd','lpTotalUsd','poolOpeningFdvUsd'].every(key=>/^\d+(?:\.\d+)?$/.test(String(value.estimate[key]))&&Number.isFinite(Number(value.estimate[key])));
}

const FUNDED_OPERATOR='7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS';
const FUNDED_TREASURY='HN22QWXBPb7dfmPhTjCf14jDco4dYzwDKeehWDXcnHEF';
const FUNDED_SOL='So11111111111111111111111111111111111111112';
const FUNDED_ACTIONS=Object.freeze({'initialize':'Initialize test coin','buy-to-bond':'Buy to graduation','sell-recovery':'Sell back to curve','migrate':'Create pool and burn LP'});
const TERMINAL=new Set(['finalized','failed','cancelled']);
const integerAmount=value=>typeof value==='string'&&/^(0|[1-9]\d{0,19})$/.test(value);
const operationId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{8,128}$/.test(value);
const expiry=value=>typeof value==='number'?value:Date.parse(value);
const priceMicros=value=>{const source=String(value??'').trim();if(source.length>24||!/^(0|[1-9]\d*)(?:\.\d{1,6})?$/.test(source))throw Error('Enter a fresh manual SOL/USD price, up to 6 decimals, before initializing.');const [whole,part='']=source.split('.'),n=BigInt(whole)*1000000n+BigInt(part.padEnd(6,'0'));if(n<=0n||n>1000000000000n)throw Error('The manual SOL price must be greater than zero and no more than $1,000,000.');return n.toString();};
const priceText=value=>{const n=BigInt(value);return `${n/1000000n}.${String(n%1000000n).padStart(6,'0').replace(/0+$/,'')||'0'}`;};
const sol=value=>{const n=BigInt(value);return `${n/1000000000n}.${String(n%1000000000n).padStart(9,'0').replace(/0+$/,'')||'0'} SOL`;};
export function fundedTestReady(value){return value?.enabled===true&&value.verifiedDeployment===true&&value.operator===FUNDED_OPERATOR&&value.treasury===FUNDED_TREASURY&&value.quoteMint===FUNDED_SOL&&value.preset==='micro-test'&&value.cluster==='mainnet-beta'&&Array.isArray(value.actions)&&value.actions.every(action=>Object.hasOwn(FUNDED_ACTIONS,action));}
export function validFundedOperation(value,{action,now=Date.now()}={}){
  return !!value&&operationId(value.id)&&Object.hasOwn(FUNDED_ACTIONS,value.action)&&(!action||value.action===action)&&value.wallet===FUNDED_OPERATOR&&value.state==='awaiting_signature'&&typeof value.transaction==='string'&&value.transaction.length>0&&value.transaction.length<=24000&&/^[A-Za-z0-9+/]+={0,2}$/.test(value.transaction)&&Number.isFinite(expiry(value.expiresAt))&&expiry(value.expiresAt)>now&&integerAmount(value.review?.maxWalletDebitLamports)&&BigInt(value.review.maxWalletDebitLamports)<=3300000000n&&(value.action!=='initialize'||integerAmount(value.review.solUsdMicros)&&BigInt(value.review.solUsdMicros)>0n&&BigInt(value.review.solUsdMicros)<=1000000000000n);
}
// The server verifies deployment, exact message bytes, signatures and receipts.
// This controller never builds a transaction, refreshes a blockhash or broadcasts.
export function createPumpFundedTestUi({document,request,wallet,context,openWallets,onChange=()=>{},now=Date.now}){
  const $=id=>document.getElementById(id),panel=$('launch-pump-funded'),buttons=[...document.querySelectorAll('[data-pump-funded-action]')];
  let disposed=false,revision=0,status=null,operation=null,signed=null,busy=false,notice='',failed=false,terminalRefreshed='';
  const node=(tag,text='')=>{const n=document.createElement(tag);n.textContent=text;return n;};
  const active=()=>!disposed&&context().active===true;
  const pairReady=()=>context().quoteMint===FUNDED_SOL;
  const ready=()=>active()&&pairReady()&&fundedTestReady(status);
  const ownWallet=()=>wallet.state().address===FUNDED_OPERATOR;
  const current=()=>{const version=revision,address=wallet.state().address;return Object.assign(()=>{if(disposed||!active()||version!==revision||address!==wallet.state().address)throw Object.assign(Error('Private test cancelled because the wallet, account or venue changed.'),{cancelled:true});},{revision:version});};
  const update=()=>{render();onChange();};
  const replaceableUnsigned=()=>operation?.state==='awaiting_signature'&&!signed&&Number.isFinite(expiry(operation.expiresAt))&&expiry(operation.expiresAt)<=now();
  const operationLocked=()=>!!operation&&!TERMINAL.has(operation.state)&&!replaceableUnsigned();
  function render(){
    panel.hidden=!active();if(!active())return;
    const configured=fundedTestReady(status),locked=operationLocked();
    $('launch-pump-funded-state').textContent=notice||(!status?'Check the verified deployment before using real funds.':!configured?(status.blockers||[]).filter(x=>typeof x==='string').join(' ')||'Funded testing is unavailable until the configured program deployment is verified.':!pairReady()?'Funded testing currently supports SOL only. Choose SOL to continue.':`Verified private test · ${status.phase||'ready'}.`);
    $('launch-pump-funded-state').dataset.error=String(failed);
    const priceField=$('launch-pump-funded-price');$('launch-pump-funded-price-wrap').hidden=!configured||!(status.actions.includes('initialize')||operation?.action==='initialize');priceField.disabled=busy;priceField.readOnly=operation?.action==='initialize'&&operationLocked();
    $('launch-pump-funded-wallet').textContent=ownWallet()?'Test wallet connected':wallet.state().address?'Switch to test wallet':'Connect test wallet';$('launch-pump-funded-wallet').disabled=busy;
    $('launch-pump-funded-refresh').disabled=busy;$('launch-pump-funded-actions').hidden=!configured;
    for(const button of buttons)button.disabled=busy||!ready()||!ownWallet()||locked||!status.actions.includes(button.dataset.pumpFundedAction);
    const review=$('launch-pump-funded-review');review.hidden=!operation;
    if(operation){
      $('launch-pump-funded-review-title').textContent=FUNDED_ACTIONS[operation.action]||'Saved test operation';
      const facts=[['Status',String(operation.state||'unknown')],['Network','Solana mainnet'],['Operator',FUNDED_OPERATOR],['Treasury',FUNDED_TREASURY]];
      if(integerAmount(operation.review?.maxWalletDebitLamports))facts.splice(1,0,['Maximum wallet debit',sol(operation.review.maxWalletDebitLamports)]);
      const r=operation.review||{},detail=r.details||r,receipt=operation.result||{};
      if(operation.action==='initialize'&&integerAmount(r.solUsdMicros))facts.push(['Manual SOL/USD reference','$'+priceText(r.solUsdMicros)]);
      if(operation.action==='migrate'&&operation.state==='finalized'&&integerAmount(receipt.burnedLpAtoms)&&BigInt(receipt.burnedLpAtoms)>0n&&receipt.issuedMinusBurnedLpAtoms==='0'&&receipt.authorityLpBalanceAtReceipt==='0')facts.push(['LP burn','All received LP burned; zero LP retained']);
      if(integerAmount(detail.minimumLamports))facts.push(['Minimum recovery proceeds',sol(detail.minimumLamports)]);
      if(integerAmount(detail.poolQuoteLamports))facts.push(['SOL deposited into pool',sol(detail.poolQuoteLamports)]);
      if(integerAmount(detail.graduationFeeLamports))facts.push(['Graduation transfer to Launchpad',sol(detail.graduationFeeLamports)]);
      $('launch-pump-funded-facts').replaceChildren(...facts.map(([label,value])=>{const row=node('div');row.append(node('dt',label),node('dd',value));return row;}));
      $('launch-pump-funded-operation-note').textContent=operation.action==='migrate'?'This migration permanently burns every LP token received in the transaction. Confirmed migration cannot be undone.':operation.action==='sell-recovery'?'This sells your held test tokens back to the curve before migration. Trading fees, rent and network fees are not refunded.':'Review the maximum debit before approving this single operation in your wallet.';
      const tx=$('launch-pump-funded-transaction'),signature=operation.signature;tx.hidden=typeof signature!=='string'||!(/^[1-9A-HJ-NP-Za-km-z]{64,100}$/).test(signature);if(!tx.hidden)tx.href='https://solscan.io/tx/'+signature;else tx.removeAttribute('href');
    }
    $('launch-pump-funded-sign').hidden=!operation||operation.state!=='awaiting_signature'||!!signed;
    $('launch-pump-funded-sign').disabled=busy||!ready()||!ownWallet()||!validFundedOperation(operation,{now:now()});
    $('launch-pump-funded-retry-submit').hidden=!signed;$('launch-pump-funded-retry-submit').disabled=busy||!active()||!ownWallet();
    $('launch-pump-funded-reconcile').hidden=!operation;$('launch-pump-funded-reconcile').disabled=busy||!active();
  }
  async function refresh(){
    if(!active()||busy)return;busy=true;failed=false;notice='Checking deployment and saved operation…';update();const check=current();
    try{const result=await request('/funded/status');check();status=result;operation=result.activeOperation||null;if(operation?.action==='initialize'&&integerAmount(operation.review?.solUsdMicros))$('launch-pump-funded-price').value=priceText(operation.review.solUsdMicros);if(signed&&operation?.id!==signed.operationId)signed=null;notice='';}
    catch(e){if(!e.cancelled){failed=true;notice=e.message||'Could not verify the private test.';status=null;}}
    finally{if(check.revision===revision){busy=false;update();}}
  }
  async function prepare(action){
    if(busy)return;let solUsdMicros;
    try{if(action==='initialize')solUsdMicros=priceMicros($('launch-pump-funded-price').value);if(!ready()||!ownWallet())throw Error('Connect the configured test wallet and verify the SOL microtest before preparing.');if(!status.actions.includes(action)||operationLocked())throw Error('Reconcile the saved operation before preparing another.');}
    catch(e){failed=true;notice=e.message;update();return;}
    busy=true;failed=false;notice='Preparing and simulating one test operation…';update();const check=current();
    try{const result=await request('/funded/prepare',{action,expectedWallet:FUNDED_OPERATOR,...(action==='initialize'?{solUsdMicros}:{})});check();if(action==='initialize'&&result.operation?.review?.solUsdMicros!==solUsdMicros)throw Error('The prepared SOL reference differs from the requested price. Nothing was signed.');if(!validFundedOperation(result.operation,{action,now:now()}))throw Error('Invalid or expired test operation. Nothing was signed.');operation=result.operation;signed=null;notice='Prepared. Review the debit, then approve in your wallet.';}
    catch(e){if(!e.cancelled){failed=true;notice=e.message||'Could not prepare the test.';}}
    finally{if(check.revision===revision){busy=false;update();}}
  }
  async function submitPrepared(){
    if(busy)return;
    try{if(operation?.action==='initialize'&&priceMicros($('launch-pump-funded-price').value)!==operation.review?.solUsdMicros)throw Error('The manual SOL reference changed. Check the saved review before continuing.');if(!ready()||!ownWallet()||!validFundedOperation(operation,{now:now()}))throw Error('This test review is unavailable or expired. Check its saved status before continuing.');}
    catch(e){failed=true;notice=e.message;update();return;}
    busy=true;failed=false;notice='Approve this test operation in your wallet.';update();const check=current(),review=operation;
    try{const transaction=await wallet.sign({operationId:review.id,kind:'curve-owner-private-test',wallet:review.wallet,transaction:review.transaction});check();signed={operationId:review.id,signedTransaction:transaction};notice='Submitting the exact signed transaction…';render();const result=await request('/funded/submit',signed);check();acceptOperation(result,review.id);notice=operation.state==='finalized'?'Operation finalized.':'Transaction saved. Checking its receipt is safe; no replacement will be created.';}
    catch(e){if(!e.cancelled){failed=true;notice=signed?'Submission confirmation unavailable. Retry the same signed transaction or check its receipt. No replacement has been created.':e.message||'Wallet approval failed.';}}
    finally{if(check.revision===revision){busy=false;update();}}
  }
  function acceptOperation(result,id){if(!result.operation||result.operation.id!==id||result.operation.action!==operation?.action||!Object.hasOwn(FUNDED_ACTIONS,result.operation.action)||result.operation.wallet&&result.operation.wallet!==FUNDED_OPERATOR)throw Error('The returned operation does not match the saved test.');operation={...operation,...result.operation};if(TERMINAL.has(operation.state)||['pending','submitted','confirmed'].includes(operation.state))signed=null;}
  async function retrySubmit(){
    if(busy||!active()||!signed||!ownWallet())return;const payload={...signed},check=current();busy=true;failed=false;notice='Retrying the same signed transaction…';update();
    try{const result=await request('/funded/submit',payload);check();acceptOperation(result,payload.operationId);notice='Saved transaction checked. No new transaction was created.';}
    catch(e){if(!e.cancelled){failed=true;notice=e.message||'Could not confirm the saved submission.';}}
    finally{if(check.revision===revision){busy=false;update();}}
  }
  async function reconcile(){
    if(busy||!active()||!operationId(operation?.id))return;const id=operation.id,check=current();busy=true;failed=false;notice='Checking the saved transaction receipt…';update();
    try{const result=await request('/funded/reconcile',{operationId:id});check();acceptOperation(result,id);notice=operation.state==='finalized'?'Operation finalized and verified.':'Saved status: '+operation.state+'. No replacement transaction was created.';}
    catch(e){if(!e.cancelled){failed=true;notice=e.message||'Receipt is not available yet.';}}
    finally{if(check.revision===revision){busy=false;update();}}
  }
  $('launch-pump-funded-refresh').onclick=refresh;$('launch-pump-funded-wallet').onclick=()=>{if(active()&&!busy)openWallets();};for(const button of buttons)button.onclick=()=>prepare(button.dataset.pumpFundedAction);
  $('launch-pump-funded-sign').onclick=submitPrepared;$('launch-pump-funded-retry-submit').onclick=retrySubmit;$('launch-pump-funded-reconcile').onclick=reconcile;
  return {get busy(){return busy;},render,refresh,poll(){if(!busy&&active()&&operation){if(['pending','submitted','confirmed'].includes(operation.state))return reconcile();if(TERMINAL.has(operation.state)&&terminalRefreshed!==operation.id){terminalRefreshed=operation.id;return refresh().then(()=>{if(!status)terminalRefreshed='';});}}},contextChanged(){revision++;notice='';failed=false;operation=null;signed=null;status=null;busy=false;render();},walletChanged(){revision++;signed=null;notice='';failed=false;busy=false;render();},destroy(){disposed=true;revision++;signed=null;operation=null;status=null;panel.hidden=true;}};
}
