const ADDRESS=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE=/^[1-9A-HJ-NP-Za-km-z]{64,100}$/;
const ID=/^[a-zA-Z0-9_-]{8,128}$/;
const RAW=/^(0|[1-9]\d{0,24})$/;
const TERMINAL=new Set(['finalized','failed','expired','cancelled']);
export const isPumpCoin=coin=>coin?.platform==='pumpswap'||coin?.venue==='pumpswap';
export function pumpDecimalRaw(value,decimals=9){
  const source=String(value??'').trim(),text=source.startsWith('.')?'0'+source:source;
  if(!Number.isInteger(decimals)||decimals<0||decimals>18||text.length>45||!new RegExp('^(?:0|[1-9]\\d*)(?:\\.\\d{1,'+Math.max(1,decimals)+'})?$').test(text)||decimals===0&&text.includes('.'))throw Error('Enter a plain amount with up to '+decimals+' decimal places.');
  const [whole,fraction='']=text.split('.');return (BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0')||'0')).toString();
}
export function pumpUnits(value,decimals=9){
  if(!RAW.test(String(value??'')))return '—';const n=BigInt(value),scale=10n**BigInt(decimals),fraction=(n%scale).toString().padStart(decimals,'0').replace(/0+$/,'');return String(n/scale)+(fraction?'.'+fraction:'');
}
export function validPublicPumpOperation(value,{wallet,action,mint,now=Date.now()}={}){
  return !!value&&ID.test(value.id||'')&&['initialize','buy','sell'].includes(value.action)&&(!action||value.action===action)&&ADDRESS.test(value.wallet||'')&&(!wallet||value.wallet===wallet)&&ADDRESS.test(value.mint||'')&&(!mint||value.mint===mint)&&value.state==='awaiting_signature'&&typeof value.transaction==='string'&&value.transaction.length>0&&value.transaction.length<=24000&&/^[A-Za-z0-9+/]+={0,2}$/.test(value.transaction)&&Number.isFinite(Number(value.expiresAt))&&Number(value.expiresAt)>now&&RAW.test(String(value.review?.maxWalletDebitLamports??''));
}
export function createPublicPumpOperation({document,root,request,wallet,context,onChange=()=>{},onConfirmed=()=>{},onFinalized=()=>{},onOpenCoin=()=>{},launchFlow=false,getLaunchInput=null,clock=Date.now,setTimer=setInterval,clearTimer=clearInterval,setDelay=setTimeout,clearDelay=clearTimeout}){
  const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  root.classList.add('pump-operation');
  const facts=el('dl',undefined,'pump-operation-facts'),notice=el('p','','help pump-operation-status'),buttons=el('div',undefined,'pump-operation-actions');notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');
  const approve=el('button','Create coin','primary'),retry=el('button','Retry saved submission','small-button'),check=el('button','Check confirmation','small-button'),clear=el('button','Cancel review','text-button'),receipt=el('a','View transaction ↗','small-button'),coinLink=el('a','Open coin →','small-button');
  for(const b of [approve,retry,check,clear])b.type='button';receipt.target='_blank';receipt.rel='noopener noreferrer';buttons.append(approve,retry,check,clear,receipt,coinLink);root.replaceChildren(facts,notice,buttons);
  let operation=null,signed=null,busy=false,disposed=false,generation=0,message='',negative=false,announced='',confirmedAnnounced='',reviewBinding='',pendingSince=0,nextPollAt=0,preparedInputKey='',autoQueued=false,autoPreparing=false,autoDue=0,autoTimer=null,signing=false;
  const active=()=>!disposed&&context().active===true;
  const walletAddress=()=>wallet.state().address;
  const binding=()=>JSON.stringify([context().key,walletAddress(),context().mint||'',context().active]);
  const capture=()=>{const version=generation,key=binding();return ()=>{if(!active()||version!==generation||key!==binding())throw Object.assign(Error('Wallet or page changed. Review the saved transaction before continuing.'),{cancelled:true});};};
  const pending=()=>!!operation&&!TERMINAL.has(operation.state);
  const created=()=>operation?.action==='initialize'&&['confirmed','finalized'].includes(operation.state);
  const launchKey=()=>{try{return typeof getLaunchInput==='function'?JSON.stringify(getLaunchInput()):'';}catch{return null;}};
  const update=()=>{render();onChange();if(autoQueued&&!autoPreparing&&!busy)armAutomatic();};
  function render(){
    if(disposed)return;
    root.hidden=!active()||!launchFlow&&!operation&&!message;facts.replaceChildren();facts.hidden=launchFlow&&created();
    if(operation){
      const r=operation.review||{},pairs=[];
      if(operation.action==='initialize'){
        const first=String(r.firstBuyLamports??r.devBuyLamports??'0'),total=String(r.maxWalletDebitLamports??''),fee=String(RAW.test(total)&&RAW.test(first)&&BigInt(total)>=BigInt(first)?BigInt(total)-BigInt(first):r.launchFeeLamports??'');
        pairs.push(['Launch fees',pumpUnits(fee)+' SOL'],['Your first buy',pumpUnits(first)+' SOL'],['Total SOL budget',pumpUnits(total)+' SOL']);
      }else{
        if(RAW.test(String(r.inputRaw??r.amountRaw??'')))pairs.push([operation.action==='buy'?'You pay':'You sell',pumpUnits(r.inputRaw??r.amountRaw,operation.action==='buy'?9:6)+' '+(operation.action==='buy'?'SOL':context().symbol||'tokens')]);
        if(RAW.test(String(r.expectedOutputRaw??r.expectedOutput??'')))pairs.push(['Estimated receive',pumpUnits(r.expectedOutputRaw??r.expectedOutput,operation.action==='buy'?6:9)+' '+(operation.action==='buy'?context().symbol||'tokens':'SOL')]);
        if(RAW.test(String(r.minOutputRaw??r.minimumOutputRaw??r.minimumOutput??'')))pairs.push(['Minimum receive',pumpUnits(r.minOutputRaw??r.minimumOutputRaw??r.minimumOutput,operation.action==='buy'?6:9)+' '+(operation.action==='buy'?context().symbol||'tokens':'SOL')]);
        pairs.push(['Maximum SOL debit',pumpUnits(r.maxWalletDebitLamports)+' SOL']);
      }
      for(const [label,value]of pairs){const row=el('div');row.append(el('dt',label),el('dd',value));facts.append(row);}
    }
    notice.textContent=message;notice.classList.toggle('negative',negative);
    approve.textContent=launchFlow||operation?.action==='initialize'?'Create coin':operation?.action==='sell'?'Approve sell':'Approve buy';
    const launchInputMatches=launchKey()!==null&&preparedInputKey===launchKey();
    approve.hidden=launchFlow?(created()||!!signed||!!operation&&pending()&&operation.state!=='awaiting_signature'):!operation||operation.state!=='awaiting_signature'||!!signed;
    approve.disabled=busy||autoPreparing||autoQueued||(launchFlow?launchKey()===null||operation?.state==='awaiting_signature'&&!launchInputMatches:reviewBinding!==binding()||!validPublicPumpOperation(operation,{wallet:walletAddress(),now:clock()}));
    retry.hidden=!signed;retry.disabled=busy;check.hidden=!operation||TERMINAL.has(operation.state)||operation.state==='awaiting_signature'&&!signed||launchFlow&&created();check.disabled=busy;
    clear.hidden=launchFlow||!operation||operation.state!=='awaiting_signature'||!!signed;clear.disabled=busy;
    receipt.hidden=!SIGNATURE.test(operation?.signature||'');if(!receipt.hidden)receipt.href='https://solscan.io/tx/'+operation.signature;else receipt.removeAttribute('href');
    coinLink.hidden=operation?.action!=='initialize'||!['confirmed','finalized'].includes(operation?.state);if(!coinLink.hidden)coinLink.href='/coin?mint='+encodeURIComponent(operation.mint);coinLink.className=launchFlow?'primary':'small-button';
    root.setAttribute('aria-busy',String(busy));
  }
  function accept(result,id){
    const next=result?.operation;if(!next||next.id!==id||next.action!==operation?.action||next.wallet!==operation?.wallet||next.mint!==operation?.mint)throw Error('Saved transaction response did not match this review.');
    operation={...operation,...next};if(TERMINAL.has(next.state)||['submitted','confirmed','pending'].includes(next.state))signed=null;
    if(TERMINAL.has(next.state)){pendingSince=0;nextPollAt=0;}else if(next.state!=='awaiting_signature'){pendingSince||=clock();nextPollAt=clock()+(clock()-pendingSince<30000?2000:5000);}
    if(launchFlow&&next.action==='initialize'&&['confirmed','finalized'].includes(next.state)&&confirmedAnnounced!==id&&announced!==id)try{document.dispatchEvent(new document.defaultView.CustomEvent('curve-celebrate',{detail:{target:coinLink}}));}catch{}
    if(next.state==='finalized'){message=next.action==='initialize'?'Your coin is live. Launchpad handles graduation and burns the pool liquidity automatically.':'Trade finalized. Your balances are updating.';negative=false;if(announced!==id){announced=id;Promise.resolve(onFinalized(result)).catch(()=>{});}}
    else if(next.state==='confirmed'){message=next.action==='initialize'?'Launch confirmed. Final verification continues in the background.':'Trade confirmed. Final verification continues in the background.';negative=false;if(confirmedAnnounced!==id){confirmedAnnounced=id;Promise.resolve(onConfirmed(result)).catch(()=>{});}}
    else if(['failed','expired','cancelled'].includes(next.state)){negative=next.state!=='cancelled';message=next.error||next.reason||'Transaction '+next.state+'. You can review a new transaction.';}
    else message='Transaction saved. Waiting for confirmation; no replacement is being created.';
  }
  async function prepare(input){
    if(busy||!active()||launchFlow&&created())return;if(pending()){message='Finish or cancel the saved review before preparing another transaction.';update();return;}
    if(!ADDRESS.test(walletAddress()||''))throw Error('Connect your wallet first.');
    busy=true;negative=false;message='Calculating and simulating your transaction…';update();const version=generation,guard=capture();
    try{const result=await request('/prepare',{...input,expectedWallet:walletAddress()});guard();if(!validPublicPumpOperation(result.operation,{wallet:walletAddress(),action:input.action,mint:input.mint,now:clock()}))throw Error('The transaction review is unavailable or expired. Nothing was signed.');operation=result.operation;reviewBinding=binding();preparedInputKey=JSON.stringify(input);signed=null;message=launchFlow?'':'Review the amounts, then approve in your wallet.';return result;}
    catch(error){if(!error.cancelled){negative=true;message=error.message;}return null;}
    finally{if(version===generation){busy=false;update();}}
  }
  async function submit(){
    if(busy||!active()||launchFlow&&preparedInputKey!==launchKey()||reviewBinding!==binding()||!validPublicPumpOperation(operation,{wallet:walletAddress(),now:clock()}))return;
    busy=true;signing=true;negative=false;message='Approve this transaction in your wallet.';update();const version=generation,guard=capture(),review=operation;
    try{const transaction=await wallet.sign({wallet:review.wallet,transaction:review.transaction,operationId:review.id,kind:'curve-pumpswap-'+review.action});guard();signed={operationId:review.id,signedTransaction:transaction};message='Submitting the reviewed transaction…';render();const result=await request('/submit',signed);guard();accept(result,review.id);}
    catch(error){if(!error.cancelled){negative=true;message=signed?'Confirmation was interrupted. Check this transaction or retry its exact signed submission.':error.message||'Wallet approval was cancelled.';}}
    finally{if(version===generation){busy=false;signing=false;update();}}
  }
  async function retrySigned(){
    if(busy||!active()||!signed||walletAddress()!==operation?.wallet)return;busy=true;negative=false;const version=generation,guard=capture(),payload=signed;message='Retrying the same signed transaction…';update();
    try{const result=await request('/submit',payload);guard();accept(result,payload.operationId);}catch(error){if(!error.cancelled){negative=true;message=error.message;}}finally{if(version===generation){busy=false;update();}}
  }
  async function reconcile({quiet=false}={}){
    if(busy||!active()||!operation)return;busy=true;const version=generation,guard=capture(),id=operation.id;if(!quiet)message='Checking the saved receipt…';update();
    try{const result=await request('/reconcile',{operationId:id});guard();accept(result,id);}catch(error){if(!error.cancelled){negative=true;message=error.message;nextPollAt=clock()+5000;}}finally{if(version===generation){busy=false;update();}}
  }
  function restore(next){
    if(!active()||busy||!next||!ID.test(next.id||'')||!['initialize','buy','sell'].includes(next.action)||next.wallet!==walletAddress()||!ADDRESS.test(next.mint||'')||context().mint&&next.mint!==context().mint)return false;
    operation=next;reviewBinding=binding();preparedInputKey='';signed=null;pendingSince=clock();nextPollAt=clock();message='An unfinished transaction is saved. Check its receipt before creating another.';update();return true;
  }
  async function cancelUnsigned(){
    if(busy||signed||operation?.state!=='awaiting_signature')return;const id=operation.id,version=generation;busy=true;message='Cancelling the unsigned review…';update();
    try{const result=await request('/cancel',{operationId:id});if(disposed||version!==generation)return;accept(result,id);if(operation.state==='cancelled'){operation=null;reviewBinding='';message='Review cancelled. You can change the amount or create a new review.';}}
    catch(error){if(!error.cancelled&&version===generation){negative=true;message=error.message;}}
    finally{if(version===generation){busy=false;update();}}
  }
  function armAutomatic(){if(autoTimer!==null)clearDelay(autoTimer);autoTimer=setDelay(()=>{autoTimer=null;void runAutomatic();},Math.max(0,autoDue-clock()));}
  function schedulePrepare(delay=400){
    if(!launchFlow||!active()||created()||signed||operation&&pending()&&operation.state!=='awaiting_signature')return;
    autoQueued=true;autoDue=clock()+delay;armAutomatic();render();onChange();
  }
  async function runAutomatic(){
    if(!launchFlow||!active()||busy||autoPreparing||!autoQueued||created()||signed)return;
    if(clock()<autoDue){armAutomatic();return;}
    autoQueued=false;autoPreparing=true;const version=generation;let input,key;
    try{
      input=getLaunchInput();key=JSON.stringify(input);
      if(operation?.state==='awaiting_signature'&&preparedInputKey===key&&validPublicPumpOperation(operation,{wallet:walletAddress(),now:clock()+5000}))return;
      if(operation?.state==='awaiting_signature'){await cancelUnsigned();if(operation?.state==='awaiting_signature')return;}
      if(version!==generation||!active()||signed||created()||operation&&pending())return;
      // Re-read after cancellation so typing never prepares an obsolete amount.
      input=getLaunchInput();key=JSON.stringify(input);await prepare(input);
    }catch(error){if(!error.cancelled&&version===generation){negative=true;message=error.message;}}
    finally{if(version===generation){autoPreparing=false;if(active()&&key&&launchKey()!==key&&!created())schedulePrepare(400);update();}}
  }
  async function createLaunch(){
    if(!launchFlow)return submit();
    if(busy||autoPreparing||autoQueued||!active()||created()||signed||operation&&pending()&&operation.state!=='awaiting_signature')return;
    const wanted=launchKey();if(wanted===null)return;
    if(!validPublicPumpOperation(operation,{wallet:walletAddress(),action:'initialize',now:clock()})||preparedInputKey!==wanted){autoQueued=true;autoDue=clock();await runAutomatic();}
    if(active()&&launchKey()===wanted&&preparedInputKey===wanted&&validPublicPumpOperation(operation,{wallet:walletAddress(),action:'initialize',now:clock()}))await submit();
  }
  approve.onclick=createLaunch;retry.onclick=retrySigned;check.onclick=()=>reconcile();clear.onclick=cancelUnsigned;
  coinLink.onclick=event=>{if(!created()||!active()||signed){event?.preventDefault?.();return;}onOpenCoin(event,operation);};
  function poll(){if(!disposed&&!document.hidden&&!busy&&operation&&!TERMINAL.has(operation.state)&&operation.state!=='awaiting_signature'&&clock()>=nextPollAt){pendingSince||=clock();nextPollAt=clock()+(clock()-pendingSince<30000?2000:5000);return reconcile({quiet:true});}}
  const timer=setTimer(()=>{void poll();},1000);
  render();
  return {prepare,reconcile,render,restore,cancelUnsigned,schedulePrepare,get inputLocked(){return signing||!!signed||!!operation&&operation.state!=='awaiting_signature'&&!['failed','expired','cancelled'].includes(operation.state);},get busy(){return busy;},get pending(){return pending();},get operation(){return operation;},canLeave:()=>launchFlow&&created()&&!signed||!busy&&!signed&&operation?.state!=='awaiting_signature',clearUnsigned:cancelUnsigned,poll,reset(){generation++;if(autoTimer!==null)clearDelay(autoTimer);autoTimer=null;autoQueued=false;autoPreparing=false;preparedInputKey='';signing=false;busy=false;operation=null;reviewBinding='';signed=null;message='';negative=false;pendingSince=0;nextPollAt=0;confirmedAnnounced='';announced='';update();},destroy(){disposed=true;generation++;if(autoTimer!==null)clearDelay(autoTimer);clearTimer(timer);signed=null;root.replaceChildren();}};
}
