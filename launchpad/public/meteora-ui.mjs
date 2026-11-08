const ADDRESS=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE=/^[1-9A-HJ-NP-Za-km-z]{64,100}$/;
const ID=/^[a-zA-Z0-9_-]{8,128}$/;
const RAW=/^(0|[1-9]\d{0,24})$/;
const SOL='So11111111111111111111111111111111111111112';
const TERMINAL=new Set(['finalized','failed','expired','cancelled']);
// v71.28: the creator of a hooked coin adds or removes allowlist wallets (`hook-allow`) through the same prepare/submit flow.
const ACTIONS=new Set(['configure','initialize','buy','sell','claim','creator-claim','payout','hook-allow']);
// A hooked launch takes three approvals: the curve configuration, a second configure-kind stage that writes the transfer hook
// setup (`review.stage === 'hook-setup'`, `review.stages === 3`) and the coin creation. A blocklist longer than the setup
// transaction can hold repeats the hook-setup stage: `review.step` is 'k/n', and `review.blocklistWallets` (written by this
// approval) with `review.blocklistCountAfter` (the chain's count once it lands) place them; `review.hook.blocklist` or
// `review.blocklistTotal` gives the whole list's size. A literal `review.blocklist` ({ from, to, total }) is read too.
const hookSetupStage=value=>value?.review?.stage==='hook-setup';
const hookedLaunch=value=>value?.review?.stages===3||hookSetupStage(value);
/** The hook-setup stage's position from `review.step` ('k/n'; absent = the only one): { step, steps }. */
export function hookSetupStep(value){
  const r=value?.review,m=/^\s*(\d+)\s*(?:\/|of)\s*(\d+)\s*$/i.exec(String(r?.step??''));
  const given=m?[Number(m[1]),Number(m[2])]:[Number(r?.hookSetupStep),Number(r?.hookSetupSteps)],step=Number.isInteger(given[0])&&given[0]>=1?given[0]:1;
  return {step,steps:Math.max(step,Number.isInteger(given[1])?given[1]:1)};
}
const hookSetupMore=value=>{const {step,steps}=hookSetupStep(value);return step<steps;};
/** "17–44 of 120": the blocklist wallets one hook-setup approval writes (1-based), or '' when the review does not place them. */
export function hookBlocklistRange(value){
  const r=value?.review;if(!r||typeof r!=='object')return '';const b=r.blocklist;let from,to,total;
  if(b&&typeof b==='object'&&!Array.isArray(b)){from=Number(b.from);to=Number(b.to);total=Number(b.total);}
  else{const n=Number(r.blocklistWallets),after=Number(r.blocklistCountAfter);if(Number.isInteger(n)&&n>0&&Number.isInteger(after)&&after>=n){from=after-n+1;to=after;}total=Number(r.blocklistTotal??(Array.isArray(r.hook?.blocklist)?r.hook.blocklist.length:Array.isArray(b)?b.length:NaN));}
  if(!Number.isInteger(from)||!Number.isInteger(to)||from<1||to<from)return '';return from+'–'+to+(Number.isInteger(total)&&total>=to?' of '+total:'');
}
/** "Hook setup 2 of 3: blocklist wallets 17–44 of 120" (one approval of a repeated stage), or "Transfer hook setup". */
export function hookSetupTitle(value){
  const {step,steps}=hookSetupStep(value),range=hookBlocklistRange(value);
  return steps>1?'Hook setup '+step+' of '+steps+(range?': blocklist wallets '+range:''):'Transfer hook setup';
}
/** The request that continues a saved launch after a finalized setup-kind approval is always `initialize` (the server resumes the
 * launch and chooses its stage from chain state: for a hooked coin the hook setup, more blocklist batches, then the coin creation).
 * hookSetupStep/hookSetupTitle name what that next approval will be. */
export const meteoraLaunchNextAction=value=>value?.action==='configure'&&value.state==='finalized'?'initialize':null;
/** A continuation requested as `initialize` may come back as another `configure`-kind approval on a hooked launch (the hook setup
 * and its blocklist batches); a plain launch's continuation is the coin creation itself. */
export const meteoraContinuationMatches=(requested,received,operation)=>requested===received||requested==='initialize'&&received==='configure'&&(hookedLaunch(operation)||operation?.hookSetup===true);
export const isMeteoraCoin=coin=>['meteora','meteora-dbc'].includes(coin?.platform)||['meteora','meteora-dbc'].includes(coin?.venue);
export function meteoraDecimalRaw(value,decimals=9){
  const source=String(value??'').trim(),text=source.startsWith('.')?'0'+source:source;
  if(!Number.isInteger(decimals)||decimals<0||decimals>18||text.length>45||!new RegExp('^(?:0|[1-9]\\d*)(?:\\.\\d{1,'+Math.max(1,decimals)+'})?$').test(text)||decimals===0&&text.includes('.'))throw Error('Enter a plain amount with up to '+decimals+' decimal places.');
  const [whole,fraction='']=text.split('.'),raw=(BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0')||'0')).toString();
  if(!RAW.test(raw))throw Error('This amount is too large.');return raw;
}
export function meteoraUnits(value,decimals=9){
  if(!RAW.test(String(value??''))||!Number.isInteger(decimals)||decimals<0||decimals>18)return '—';const n=BigInt(value),scale=10n**BigInt(decimals),fraction=decimals?(n%scale).toString().padStart(decimals,'0').replace(/0+$/,''):'';return String(n/scale)+(fraction?'.'+fraction:'');
}
export function validMeteoraOperation(value,{wallet,action,mint,quoteMint,quoteDecimals,now=Date.now(),additionalActions=[]}={}){
  const r=value?.review;
  return !!value&&ID.test(value.id||'')&&(ACTIONS.has(value.action)||additionalActions.includes(value.action))&&(!action||value.action===action||action==='claim'&&['creator-claim','payout'].includes(value.action)||action==='initialize'&&value.action==='configure')&&ADDRESS.test(value.wallet||'')&&(!wallet||value.wallet===wallet)&&ADDRESS.test(value.mint||'')&&(!mint||value.mint===mint)&&value.state==='awaiting_signature'&&typeof value.transaction==='string'&&value.transaction.length>0&&value.transaction.length<=24000&&/^[A-Za-z0-9+/]+={0,2}$/.test(value.transaction)&&Number.isFinite(Number(value.expiresAt))&&Number(value.expiresAt)>now&&RAW.test(String(r?.maxWalletDebitLamports??''))&&ADDRESS.test(r?.quoteMint||'')&&(!quoteMint||r.quoteMint===quoteMint)&&Number.isInteger(r.quoteDecimals)&&r.quoteDecimals>=0&&r.quoteDecimals<=18&&(quoteDecimals===undefined||r.quoteDecimals===quoteDecimals)&&(!['configure','initialize'].includes(value.action)||RAW.test(String(r.firstBuyRaw??'')));
}
export function createMeteoraOperation({document,root,request,wallet,context,onChange=()=>{},onConfirmed=()=>{},onFinalized=()=>{},onOpenCoin=()=>{},onStartAnotherLaunch=null,launchFlow=false,getLaunchInput=null,validateOperation=validMeteoraOperation,continuationActionMatches=meteoraContinuationMatches,isTemporaryError=()=>false,additionalActions=[],continuationActions=[],nextLaunchAction=meteoraLaunchNextAction,setupKind='configuration',transactionKindPrefix='curve-meteora-',launchedMessage='Your coin is live. It will graduate to Meteora DAMM v2 with permanently locked liquidity.',clock=Date.now,setTimer=setInterval,clearTimer=clearInterval,setDelay=setTimeout,clearDelay=clearTimeout}){
  const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  root.classList.add('meteora-operation');
  const facts=el('dl',undefined,'meteora-operation-facts'),notice=el('p','','help meteora-operation-status'),buttons=el('div',undefined,'meteora-operation-actions');notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');
  const approve=el('button','Create coin','primary'),retry=el('button','Retry saved submission','small-button'),check=el('button','Check confirmation','small-button'),clear=el('button','Cancel','text-button'),startAnother=el('button','Start another launch','text-button'),receipt=el('a','View transaction ↗','small-button'),coinLink=el('a','Open coin →','primary');
  for(const b of [approve,retry,check,clear,startAnother])b.type='button';receipt.target='_blank';receipt.rel='noopener noreferrer';buttons.append(approve,retry,check,clear,startAnother,receipt,coinLink);root.replaceChildren(facts,notice,buttons);
  let operation=null,signed=null,submissionError=null,busy=false,disposed=false,generation=0,message='',negative=false,announced='',confirmedAnnounced='',reviewBinding='',nextPollAt=0,pollFailures=0,preparedInputKey='',autoQueued=false,autoPreparing=false,autoDue=0,autoTimer=null,signing=false,continueIntent=false,advancing=false;
  const active=()=>!disposed&&context().active===true;
  const walletAddress=()=>wallet.state().address;
  const binding=()=>JSON.stringify([context().key,walletAddress(),context().mint||'',context().quoteMint||'',context().quoteDecimals,context().active]);
  const capture=()=>{const version=generation,key=binding();return ()=>{if(!active()||version!==generation||key!==binding())throw Object.assign(Error('Wallet or page changed. Return to the saved launch to continue.'),{cancelled:true});};};
  const pending=()=>!!operation&&!TERMINAL.has(operation.state);
  const configured=()=>operation?.state==='finalized'&&!!nextLaunchAction(operation);
  const continuation=()=>operation?.review?.configurationCreated===true||continuationActions.includes(operation?.action);
  const created=()=>operation?.action==='initialize'&&['confirmed','finalized'].includes(operation.state);
  const valid=(value,extra={})=>validateOperation(value,{wallet:walletAddress(),quoteMint:context().quoteMint,quoteDecimals:context().quoteDecimals,now:clock(),additionalActions,...extra});
  const launchKey=()=>{try{return typeof getLaunchInput==='function'?JSON.stringify(getLaunchInput()):'';}catch{return null;}};
  // Only this explicit pre-submission rejection proves that these bytes were
  // not journaled or broadcast. Timeouts and connection failures are ambiguous:
  // retain their exact signed packet until the saved operation is reconciled.
  function rejectedApproval(error){
    if(!signed||operation?.state!=='awaiting_signature'||error?.code!=='WALLET_TRANSACTION_REJECTED'||(error.statusCode??error.status)!==400)return false;
    signed=null;submissionError=null;continueIntent=false;negative=true;
    message=(error.message||'The wallet approval could not be validated. Nothing was submitted.')+' Approve the saved launch step again. Completed setup remains saved.';
    return true;
  }
  function update(){render();onChange();if(autoQueued&&!autoPreparing&&!busy)armAutomatic();if(launchFlow&&configured()&&continueIntent&&!busy&&!advancing)void continueLaunch();}
  function budgetRows(r,action){
    const symbol=r.quoteSymbol||context().quoteSymbol||'quote tokens',decimals=r.quoteDecimals;
    if(action==='prepare-buy'){
      const rows=[];if(RAW.test(String(r.nativeAccountRentLamports??'')))rows.push(['Included account rent',meteoraUnits(r.nativeAccountRentLamports)+' SOL']);
      rows.push(['This setup approval',meteoraUnits(r.maxWalletDebitLamports)+' SOL'],['First buy at coin creation',meteoraUnits(r.firstBuyRaw,decimals)+' '+symbol],['Next approval','Coin creation and first buy']);return rows;
    }
    if(action==='configure'&&r.stage==='hook-setup'){
      // The transfer hook setup approval writes the rules, the hook accounts and the first blocklist wallets; it moves no quote
      // funds. A longer blocklist repeats the stage, one batch of wallets per approval.
      const {step,steps}=hookSetupStep({review:r}),range=hookBlocklistRange({review:r}),rules=Array.isArray(r.hook?.rules)&&r.hook.rules.length?r.hook.rules.length+(r.hook.rules.length===1?' rule':' rules'):'Rules';
      const rows=step===1?[[steps>1?'Hook setup 1 of '+steps:'Transfer hook setup',rules+' written on chain with the hook accounts'+(range?' · blocklist wallets '+range:'')]]:[['Hook setup '+step+' of '+steps,'Blocklist wallets '+(range||'of the next batch')+' written on chain']];
      if(RAW.test(String(r.maxWalletDebitLamports??'')))rows.push(['This approval',meteoraUnits(r.maxWalletDebitLamports)+' SOL']);
      rows.push(['Next approval',step<steps?'Hook setup '+(step+1)+' of '+steps:'Coin creation (3 of 3)']);return rows;
    }
    if(['configure','initialize',...continuationActions].includes(action)){
      if(r.fundingMode==='sol'&&RAW.test(String(r.firstBuySolLamports??''))){
        const first=String(r.firstBuySolLamports),funding=String(r.quoteFundingInLamports??first),total=String(r.totalLaunchMaxDebitLamports??r.maxWalletDebitLamports??''),seedOnly=r.quoteMint!==SOL&&first==='0',complete=RAW.test(String(r.totalLaunchMaxDebitLamports??''))||action==='initialize',rows=[];
        if(complete&&RAW.test(total)&&RAW.test(funding)&&BigInt(total)>=BigInt(funding))rows.push(['Launch fees',meteoraUnits(String(BigInt(total)-BigInt(funding)))+' SOL']);
        rows.push([seedOnly?'Pool seed conversion':r.quoteFundingComplete===true?'SOL converted':'Your first buy',meteoraUnits(funding)+' SOL']);
        if(r.quoteFundingComplete===true&&RAW.test(String(r.firstBuyRaw??''))&&BigInt(r.firstBuyRaw)>0n)rows.push(['Your first buy',meteoraUnits(r.firstBuyRaw,decimals)+' '+symbol]);
        if(r.quoteMint!==SOL&&RAW.test(String(r.quoteFundingMinRaw??'')))rows.push(['Minimum quote received',meteoraUnits(r.quoteFundingMinRaw,decimals)+' '+symbol]);
        if(RAW.test(String(r.setupRentLamports??r.lookupTableRentLamports??'')))rows.push(['Included setup rent',meteoraUnits(r.setupRentLamports??r.lookupTableRentLamports)+' SOL']);
        rows.push([complete?'Total SOL budget':'This approval',meteoraUnits(total)+' SOL']);
        if(RAW.test(String(r.minimumWalletBalanceLamports??'')))rows.push(['SOL balance needed',meteoraUnits(r.minimumWalletBalanceLamports)+' SOL']);
        return rows;
      }
      const first=String(r.firstBuyRaw??'0'),total=String(r.totalLaunchMaxDebitLamports??r.maxWalletDebitLamports??''),isSol=r.quoteMint===SOL,setupRent=String(r.setupRentLamports??r.lookupTableRentLamports??'');
      if(action==='configure'&&setupKind==='lookup'&&!RAW.test(String(r.totalLaunchMaxDebitLamports??''))){
        return [...(RAW.test(setupRent)?[['Setup rent',meteoraUnits(setupRent)+' SOL']]:[]),['This setup approval',meteoraUnits(r.maxWalletDebitLamports)+' SOL'],['First buy at coin creation',meteoraUnits(first,decimals)+' '+symbol],['Next approval','Coin creation and first buy, reviewed separately']];
      }
      const fee=String(RAW.test(total)&&RAW.test(first)&&isSol&&BigInt(total)>=BigInt(first)?BigInt(total)-BigInt(first):total);
      const rows=[['Launch fees',meteoraUnits(fee)+' SOL'],['Your first buy',meteoraUnits(first,decimals)+' '+symbol]];
      if(RAW.test(setupRent))rows.push(['Included setup rent',meteoraUnits(setupRent)+' SOL']);
      rows.push([action==='configure'&&setupKind==='lookup'?'Estimated total budget':isSol?'Total SOL budget':'Total budget',meteoraUnits(total)+' SOL'+(!isSol&&RAW.test(first)&&BigInt(first)>0n?' + '+meteoraUnits(first,decimals)+' '+symbol:'')]);if(setupKind==='lookup'&&RAW.test(String(r.minimumWalletBalanceLamports??'')))rows.push(['SOL balance needed',meteoraUnits(r.minimumWalletBalanceLamports)+' SOL']);return rows;
    }
    if(action==='hook-allow'){
      // Allowlist changes move no tokens: the review lists the wallets written and removed and the rent the creator pays.
      const rows=[],countOf=(list,n)=>Array.isArray(list)?list.length:Number.isInteger(n)&&n>=0?n:null,added=countOf(r.add,r.added??r.addCount),removedCount=countOf(r.remove,r.removed??r.removeCount);
      if(added!==null)rows.push(['Wallets added',String(added)]);if(removedCount!==null)rows.push(['Wallets removed',String(removedCount)]);
      if(RAW.test(String(r.maxWalletDebitLamports??'')))rows.push(['Maximum SOL debit',meteoraUnits(r.maxWalletDebitLamports)+' SOL']);return rows;
    }
    if(['claim','creator-claim','payout'].includes(action)){
      const rows=[],amount=r.payoutRaw??r.expectedOutputRaw;
      if(RAW.test(String(amount??'')))rows.push(['Creator fees',meteoraUnits(amount,decimals)+' '+symbol]);
      if(r.quoteDelivery==='token-account'&&r.quoteMint===SOL)rows.push(['Delivery','Wrapped SOL (WSOL) in your wallet; unwrap it to use as SOL.']);
      rows.push(['Maximum SOL debit',meteoraUnits(r.maxWalletDebitLamports)+' SOL']);return rows;
    }
    if(action==='buy'&&r.atomicGraduation===true){
      const rows=[['Buy budget (max)',meteoraUnits(r.inputRaw,decimals)+' '+symbol],['Expected buy spend',meteoraUnits(r.chargedRaw,decimals)+' '+symbol]];
      if(RAW.test(String(r.unusedQuoteBudgetRaw??''))&&BigInt(r.unusedQuoteBudgetRaw)>0n)rows.push(['Expected unused budget',meteoraUnits(r.unusedQuoteBudgetRaw,decimals)+' '+symbol]);
      rows.push(['Estimated receive',meteoraUnits(r.expectedOutputRaw,context().baseDecimals??6)+' '+(context().symbol||'tokens')],['Minimum receive',meteoraUnits(r.minOutputRaw,context().baseDecimals??6)+' '+(context().symbol||'tokens')],['Network fee (included)',meteoraUnits(r.networkFeeLamports)+' SOL'],['Account setup, including graduation',meteoraUnits(r.accountSetupLamports)+' SOL'],['Maximum SOL debit'+(r.quoteMint===SOL?' (buy + costs)':' (costs)'),meteoraUnits(r.maxWalletDebitLamports)+' SOL']);return rows;
    }
    const rows=[],buy=action==='buy';
    if(RAW.test(String(r.inputRaw??r.amountRaw??'')))rows.push([buy?'You pay':'You sell',meteoraUnits(r.inputRaw??r.amountRaw,buy?decimals:context().baseDecimals??6)+' '+(buy?symbol:context().symbol||'tokens')]);
    if(RAW.test(String(r.expectedOutputRaw??'')))rows.push(['Estimated receive',meteoraUnits(r.expectedOutputRaw,buy?context().baseDecimals??6:decimals)+' '+(buy?context().symbol||'tokens':symbol)]);
    if(RAW.test(String(r.minOutputRaw??'')))rows.push(['Minimum receive',meteoraUnits(r.minOutputRaw,buy?context().baseDecimals??6:decimals)+' '+(buy?context().symbol||'tokens':symbol)]);
    rows.push(['Maximum SOL debit',meteoraUnits(r.maxWalletDebitLamports)+' SOL']);return rows;
  }
  function render(){
    if(disposed)return;
    root.hidden=!active()||!launchFlow&&!operation&&!message;facts.replaceChildren();facts.hidden=launchFlow&&created();
    if(operation)for(const[label,value]of budgetRows(operation.review||{},operation.action)){const row=el('div');row.append(el('dt',label),el('dd',value));facts.append(row);}
    const adjusted=operation?.review?.firstBuyAdjusted===true&&!created()?'First buy adjusted to stay within the 10% limit. Unused '+(operation.review.quoteSymbol||context().quoteSymbol||'quote tokens')+' stays in your wallet.':'';const graduation=operation?.action==='buy'&&operation.review?.atomicGraduation===true&&!TERMINAL.has(operation.state)?'Buy and PumpSwap graduation share one transaction. Unspent buy funds stay in your wallet.':'';notice.textContent=[message,adjusted,graduation].filter(Boolean).join(' ');notice.classList.toggle('negative',negative);
    approve.textContent=configured()?'Continue launch':operation?.action==='prepare-buy'?'Complete launch setup':launchFlow||['configure','initialize'].includes(operation?.action)?'Create coin':['claim','creator-claim','payout'].includes(operation?.action)?'Claim fees':operation?.action==='hook-allow'?'Approve allowlist change':operation?.action==='sell'?'Approve sell':operation?.review?.atomicGraduation===true?'Approve buy + graduation':'Approve buy';
    const continuing=continuation();
    const matches=continuing||launchKey()!==null&&preparedInputKey===launchKey();
    approve.hidden=launchFlow?(created()||!!signed||!!operation&&pending()&&operation.state!=='awaiting_signature'):!operation||operation.state!=='awaiting_signature'||!!signed;
    approve.disabled=busy||autoPreparing||autoQueued||(launchFlow?!configured()&&(!continuing&&launchKey()===null||operation?.state==='awaiting_signature'&&!matches):reviewBinding!==binding()||!valid(operation));
    retry.hidden=!signed;retry.disabled=busy;check.hidden=!operation||TERMINAL.has(operation.state)||operation.state==='awaiting_signature'&&!signed||launchFlow&&created();check.disabled=busy;
    startAnother.hidden=!launchFlow||typeof onStartAnotherLaunch!=='function'||!configured();startAnother.disabled=busy||advancing||autoPreparing||autoQueued||!!signed||signing;
    clear.hidden=launchFlow||!operation||operation.state!=='awaiting_signature'||!!signed;clear.disabled=busy;
    receipt.hidden=!SIGNATURE.test(operation?.signature||'');if(!receipt.hidden)receipt.href='https://solscan.io/tx/'+operation.signature;else receipt.removeAttribute('href');
    coinLink.hidden=!created();if(!coinLink.hidden)coinLink.href='/coin?mint='+encodeURIComponent(operation.mint);root.setAttribute('aria-busy',String(busy));
  }
  function accept(result,id){
    const next=result?.operation;if(!next||next.id!==id||next.action!==operation?.action||next.wallet!==operation?.wallet||next.mint!==operation?.mint)throw Error('Saved transaction response did not match this launch.');
    operation={...operation,...next,nextAction:result.nextAction!==undefined?result.nextAction:next.nextAction!==undefined?next.nextAction:operation.nextAction};if(TERMINAL.has(next.state)||['submitted','confirmed','pending','journaled'].includes(next.state)){signed=null;submissionError=null;}
    pollFailures=0;nextPollAt=clock()+2500;
    if(launchFlow&&next.action==='initialize'&&['confirmed','finalized'].includes(next.state)&&confirmedAnnounced!==id&&announced!==id)try{document.dispatchEvent(new document.defaultView.CustomEvent('curve-celebrate',{detail:{target:coinLink}}));}catch{}
    if(configured()){const {step,steps}=hookSetupStep(next);message=next.action==='prepare-buy'?'Launch account setup confirmed. Continue with coin creation.':next.action==='fund-quote'?'SOL conversion confirmed. Continue with coin creation.':nextLaunchAction(operation)==='fund-quote'?'Launch setup confirmed. Continue with the SOL conversion.':hookSetupStage(next)?(step<steps?'Hook setup '+step+' of '+steps+' confirmed. Next: hook setup '+(step+1)+' of '+steps+' (the next blocklist wallets), then the coin creation approval.':'Transfer hook setup confirmed. Next: the coin creation approval (3 of 3).'):hookedLaunch(next)?'Launchpad configuration confirmed. Next: the transfer hook setup approval (2 of 3).':setupKind==='lookup'?'Launch setup confirmed. Continue with the coin creation approval.':'Launchpad configuration confirmed. Continue with the coin creation approval.';negative=false;}
    else if(next.state==='finalized'){message=next.action==='initialize'?launchedMessage:next.action==='hook-allow'?'Allowlist change finalized. The list is read again from the chain.':'Transaction finalized. Your balances are updating.';negative=false;if(announced!==id){announced=id;Promise.resolve(onFinalized(result)).catch(()=>{});}}
    else if(next.state==='confirmed'){message=next.action==='initialize'?'Your coin is live. Final verification continues in the background.':next.action==='hook-allow'?'Allowlist change confirmed. Waiting for final verification.':'Transaction confirmed. Waiting for final verification.';negative=false;if(next.action!=='configure'&&confirmedAnnounced!==id){confirmedAnnounced=id;Promise.resolve(onConfirmed(result)).catch(()=>{});}}
    else if(['failed','expired','cancelled'].includes(next.state)){continueIntent=false;negative=next.state!=='cancelled';message=next.error||next.reason||'Transaction '+next.state+'. Your saved progress will be checked before another attempt.';}
    else if(next.state==='awaiting_signature'&&signed){negative=submissionError?.negative===true;message=[submissionError?.message,'Launchpad has not confirmed receipt of your signed approval. Retry the same submission to continue.'].filter(Boolean).join(' ');}
    else{negative=false;message='Transaction saved. Waiting for confirmation; no replacement is being created.';}
  }
  async function prepare(input,{continuation=false}={}){
    if(busy||!active()||launchFlow&&created())return;if(pending()){message='The saved transaction must finish before another can be prepared.';update();return;}
    if(!ADDRESS.test(walletAddress()||''))throw Error('Connect your wallet first.');
    busy=true;negative=false;message='Calculating your launch cost…';update();const version=generation,guard=capture();
    try{const result=await request('/prepare',{...input,expectedWallet:walletAddress()});guard();if(!valid(result.operation,{action:input.action,mint:input.mint})||continuation&&!continuationActionMatches(input.action,result.operation.action,result.operation))throw Error('The transaction is unavailable, expired or for another pair. Nothing was signed.');operation=result.operation;if(continuation)operation={...operation,review:{...operation.review,configurationCreated:true}};reviewBinding=binding();preparedInputKey=continuation?launchKey():JSON.stringify(input);signed=null;submissionError=null;pollFailures=0;message='';return result;}
    catch(error){continueIntent=false;if(!error.cancelled){negative=!isTemporaryError(error);message=error.message;}return null;}
    finally{if(version===generation){busy=false;update();}}
  }
  async function submit(){
    if(busy||!active()||launchFlow&&!continuation()&&preparedInputKey!==launchKey()||reviewBinding!==binding()||!valid(operation))return;
    busy=true;signing=true;submissionError=null;negative=false;message=operation.action==='prepare-buy'?'Approve the remaining account setup in your wallet. Coin creation and your first buy follow automatically.':operation.action==='fund-quote'?'Approve the SOL conversion in your wallet. Coin creation follows automatically after confirmation.':operation.action==='configure'?(hookSetupStage(operation)?(hookSetupStep(operation).steps>1?'Approve '+hookSetupTitle(operation).replace(/^Hook/,'hook')+' in your wallet. '+(hookSetupMore(operation)?'More hook setup approvals follow before the coin creation.':'Coin creation follows as the last approval.'):'Approve the transfer hook setup in your wallet. Coin creation follows in a third approval.'):hookedLaunch(operation)?'Approve the launch configuration in your wallet. The transfer hook setup and coin creation follow in two more approvals.':setupKind==='lookup'?(operation.review?.fundingMode==='sol'&&operation.review.quoteMint!==SOL?'Approve launch setup in your wallet. SOL conversion and coin creation follow.':'Approve the one-time launch setup in your wallet. It pays setup rent; the remaining launch steps follow automatically.'):'Approve the launch configuration in your wallet. Coin creation follows in a second approval.'):'Approve this transaction in your wallet.';update();const version=generation,guard=capture(),review=operation;
    try{const transaction=await wallet.sign({wallet:review.wallet,transaction:review.transaction,operationId:review.id,kind:transactionKindPrefix+review.action});guard();signed={operationId:review.id,signedTransaction:transaction};message='Submitting your transaction…';render();const result=await request('/submit',signed);guard();accept(result,review.id);}
    catch(error){continueIntent=false;if(!error.cancelled&&!rejectedApproval(error)){const temporary=isTemporaryError(error);negative=!temporary;if(signed)submissionError={message:error.message||'Submission needs attention.',negative:!temporary};message=signed?(temporary?'Your signed transaction is saved. Checking confirmation; you can also retry the same submission.':(error.message||'Submission needs attention.')+' Your signed transaction is saved; check its status before trying again.'):error.message||'Wallet approval was cancelled.';}}
    finally{if(version===generation){busy=false;signing=false;update();}}
  }
  async function continueLaunch(){
    if(!launchFlow||advancing||busy||!active()||!configured()||operation.wallet!==walletAddress()||reviewBinding!==binding())return;
    const mint=operation.mint,action=nextLaunchAction(operation);advancing=true;continueIntent=false;
    try{const result=await prepare({action,mint},{continuation:true});if(result&&active()){continueIntent=true;await submit();}}finally{advancing=false;update();}
  }
  async function retrySigned(){
    if(busy||!active()||!signed||walletAddress()!==operation?.wallet||reviewBinding!==binding())return;busy=true;negative=false;const version=generation,guard=capture(),payload=signed;message='Retrying the same signed transaction…';update();
    try{const result=await request('/submit',payload);guard();accept(result,payload.operationId);}catch(error){if(!error.cancelled&&!rejectedApproval(error)){negative=!isTemporaryError(error);submissionError={message:error.message||'Submission needs attention.',negative};message=submissionError.message;}}finally{if(version===generation){busy=false;update();}}
  }
  async function reconcile({quiet=false}={}){
    if(busy||!active()||!operation||operation.wallet!==walletAddress())return;busy=true;const version=generation,guard=capture(),id=operation.id;if(!quiet)message='Checking the saved transaction…';update();
    try{const result=await request('/reconcile',{operationId:id});guard();accept(result,id);}catch(error){if(!error.cancelled&&version===generation){
      const temporary=isTemporaryError(error),original=signed&&submissionError?.negative?submissionError:null;
      negative=!!original||!temporary;message=[...new Set([original?.message,error.message].filter(Boolean))].join(' ');
      pollFailures=temporary?Math.min(pollFailures+1,4):0;
      const retryAfter=Number.isFinite(error.retryAfterMs)&&error.retryAfterMs>0?Math.min(300000,error.retryAfterMs):0;
      nextPollAt=clock()+Math.max(temporary?Math.min(30000,5000*2**(pollFailures-1)):5000,retryAfter);
    }}finally{if(version===generation){busy=false;update();}}
  }
  function restore(next){
    if(!active()||busy||!next||!ID.test(next.id||'')||!(ACTIONS.has(next.action)||additionalActions.includes(next.action))||next.wallet!==walletAddress()||!ADDRESS.test(next.mint||'')||context().mint&&next.mint!==context().mint||context().quoteMint&&next.review?.quoteMint!==context().quoteMint)return false;
    operation=next;reviewBinding=binding();preparedInputKey='';signed=null;submissionError=null;continueIntent=false;pollFailures=0;nextPollAt=clock();message=configured()?(next.action==='prepare-buy'?'Your launch account setup is confirmed. Continue to create the same coin.':next.action==='fund-quote'?'Your SOL conversion is confirmed. Continue to create the same coin.':nextLaunchAction(operation)==='fund-quote'?'Your paid launch setup is ready. Continue to convert SOL and create the same coin.':hookSetupStage(next)?(hookSetupMore(next)?'Your hook setup '+hookSetupStep(next).step+' of '+hookSetupStep(next).steps+' is confirmed. Next: hook setup '+(hookSetupStep(next).step+1)+' of '+hookSetupStep(next).steps+', then the coin creation approval.':'Your transfer hook setup is ready. Next: the coin creation approval (3 of 3).'):hookedLaunch(next)?'Your launch configuration is ready. Next: the transfer hook setup approval (2 of 3).':setupKind==='lookup'?'Your paid launch setup is ready. Continue to create the same coin.':'Your launch configuration is ready. Continue to create the coin.'):'An unfinished transaction is saved. Its confirmation will be checked before continuing.';update();return true;
  }
  async function cancelUnsigned(){
    if(busy||signed||operation?.state!=='awaiting_signature')return;const id=operation.id,version=generation,guard=capture();busy=true;message='Updating the unsigned transaction…';update();
    try{const result=await request('/cancel',{operationId:id});guard();accept(result,id);if(operation.state==='cancelled'){operation=null;reviewBinding='';message='';}}
    catch(error){if(!error.cancelled&&version===generation){negative=!isTemporaryError(error);message=error.message;}}
    finally{if(version===generation){busy=false;update();}}
  }
  function armAutomatic(){if(autoTimer!==null)clearDelay(autoTimer);autoTimer=setDelay(()=>{autoTimer=null;void runAutomatic();},Math.max(0,autoDue-clock()));}
  function schedulePrepare(delay=400){
    if(!launchFlow||!active()||created()||configured()||signed||continuation()||operation&&pending()&&operation.state!=='awaiting_signature')return;
    autoQueued=true;autoDue=clock()+delay;armAutomatic();render();onChange();
  }
  async function runAutomatic(){
    if(!launchFlow||!active()||busy||autoPreparing||!autoQueued||created()||configured()||signed)return;
    if(clock()<autoDue){armAutomatic();return;}
    autoQueued=false;autoPreparing=true;const version=generation;let input,key;
    try{input=getLaunchInput();key=JSON.stringify(input);if(operation?.state==='awaiting_signature'&&preparedInputKey===key&&valid(operation,{now:clock()+5000}))return;
      if(operation?.state==='awaiting_signature'){await cancelUnsigned();if(operation?.state==='awaiting_signature')return;}
      if(version!==generation||!active()||signed||created()||configured()||operation&&pending())return;
      input=getLaunchInput();key=JSON.stringify(input);await prepare(input);
    }catch(error){if(!error.cancelled&&version===generation){negative=!isTemporaryError(error);message=error.message;}}
    finally{if(version===generation){autoPreparing=false;if(active()&&key&&launchKey()!==key&&!created()&&!configured())schedulePrepare(400);update();}}
  }
  async function createLaunch(){
    if(!launchFlow)return submit();
    if(busy||autoPreparing||autoQueued||!active()||created()||signed||operation&&pending()&&operation.state!=='awaiting_signature')return;
    if(configured())return continueLaunch();
    if(continuation()){const mint=operation.mint,action=operation.action==='prepare-buy'?'initialize':operation.action;if(!valid(operation)){await cancelUnsigned();if(operation?.state==='awaiting_signature')return;const result=await prepare({action,mint},{continuation:true});if(!result)return;}continueIntent=true;return submit();}
    const wanted=launchKey();if(wanted===null)return;
    if(!valid(operation,{action:'initialize'})||preparedInputKey!==wanted){autoQueued=true;autoDue=clock();await runAutomatic();}
    if(active()&&launchKey()===wanted&&preparedInputKey===wanted&&valid(operation,{action:'initialize'})){continueIntent=true;await submit();}
  }
  startAnother.onclick=()=>{if(!active()||busy||advancing||autoPreparing||autoQueued||signed||signing||!launchFlow||!configured()||typeof onStartAnotherLaunch!=='function'||operation.wallet!==walletAddress()||reviewBinding!==binding())return;const saved=operation;onStartAnotherLaunch(saved);reset();message='Your previous setup remains saved. Enter the first buy for a new launch.';update();};
  approve.onclick=createLaunch;retry.onclick=retrySigned;check.onclick=()=>reconcile();clear.onclick=cancelUnsigned;
  coinLink.onclick=event=>{if(!created()||!active()||signed){event?.preventDefault?.();return;}onOpenCoin(event,operation);};
  function poll(){if(active()&&!document.hidden&&!busy&&operation&&!TERMINAL.has(operation.state)&&(operation.state!=='awaiting_signature'||signed)&&clock()>=nextPollAt){nextPollAt=clock()+2500;return reconcile({quiet:true});}}
  function reset(){generation++;if(autoTimer!==null)clearDelay(autoTimer);autoTimer=null;autoQueued=false;autoPreparing=false;preparedInputKey='';signing=false;busy=false;operation=null;reviewBinding='';signed=null;submissionError=null;message='';negative=false;nextPollAt=0;pollFailures=0;confirmedAnnounced='';announced='';continueIntent=false;advancing=false;update();}
  const timer=setTimer(()=>{void poll();},1000);render();
  return {prepare,submit,reconcile,render,restore,cancelUnsigned,schedulePrepare,poll,get inputLocked(){return signing||!!signed||configured()||continuation()||!!operation&&operation.state!=='awaiting_signature'&&!['failed','expired','cancelled'].includes(operation.state);},get busy(){return busy||advancing;},get pending(){return pending();},get operation(){return operation;},canLeave:()=>launchFlow&&created()&&!signed||!busy&&!signed&&operation?.state!=='awaiting_signature',clearUnsigned:cancelUnsigned,reset,destroy(){disposed=true;generation++;if(autoTimer!==null)clearDelay(autoTimer);clearTimer(timer);signed=null;root.replaceChildren();}};
}
