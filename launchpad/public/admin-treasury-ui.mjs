import { revenueAmount } from './admin-revenue-ui.mjs';
import { PLATFORM_TOKEN_MINT } from './platform-token.mjs';

const POLL_MS=15000;
// The platform token (public/platform-token.mjs); '' when the host has none.
const LAUNCHPAD_MINT=PLATFORM_TOKEN_MINT;
// A white-label launchpad (<body data-product="tenant">, src/tenant/treasury.mjs): the treasury is made and switched on by the server;
// the panel shows the platform share and the owner's own share, and the owner withdraws their share. Nothing to set up.
const TENANT=typeof document!=='undefined'&&document.body?.dataset?.product==='tenant';
const LAUNCHER=TENANT?String(document.body.dataset.launcherName||'the platform'):'';
const SETUP_COMMAND='sudo systemd-run --pty --wait --collect --uid=launchpad --property=WorkingDirectory=/opt/launchpad/app --property=EnvironmentFile=/etc/launchpad.env --property=UMask=0077 --property=LimitCORE=0 /usr/bin/node /opt/launchpad/app/scripts/setup-treasury-wallet.mjs';
const BASE58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const labels={convert:'Asset conversion',conversion:'Asset conversion',buy:'LAUNCHPAD buyback',buyback:'LAUNCHPAD buyback',burn:'LAUNCHPAD burn',recognize:'Revenue transfer',receipt:'Revenue receipt',withdraw:'Retained revenue withdrawal'};
function validBase58(value,bytes){
  if(typeof value!=='string'||value.length<bytes||value.length>Math.ceil(bytes*1.38)||!/^[1-9A-HJ-NP-Za-km-z]+$/.test(value))return false;
  let decoded=0n;for(const char of value)decoded=decoded*58n+BigInt(BASE58.indexOf(char));
  return (value.match(/^1*/)?.[0].length||0)+(decoded===0n?0:Math.ceil(decoded.toString(16).length/2))===bytes;
}
const dateLabel=value=>{const number=Number(value),date=Number.isFinite(number)&&number>0?new Date(number):null;return date&&!Number.isNaN(date.getTime())?date.toLocaleString():null;};
const solUnits=value=>{if(typeof value!=='string'||!/^\d{1,20}(\.\d{1,9})?$/.test(value))return null;const [whole,fraction='']=value.split('.');return BigInt(whole)*1000000000n+BigInt(fraction.padEnd(9,'0'));};

export function createAdminTreasury({document,api,security,message=()=>{},getAccount,onConfigured=async()=>{},isActive=()=>true,clock=Date.now,setTimer=setInterval,clearTimer=clearInterval,copyText=text=>document.defaultView.navigator.clipboard.writeText(text)}){
  const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined&&text!==null)node.textContent=String(text);if(cls)node.className=cls;return node;};
  const element=el('section',null,'admin-card admin-treasury');element.id='admin-treasury';
  const heading=el('div',null,'admin-card-heading'),copy=el('div'),refresh=el('button','Refresh','text-button');refresh.type='button';refresh.id='admin-treasury-refresh';
  if(TENANT)copy.append(el('p','TREASURY / REVENUE','eyebrow'),el('h2','Your launchpad’s revenue'),el('p','Every protocol fee your launchpad earns lands in this treasury and is turned into SOL. The platform share goes to '+LAUNCHER+' automatically; the rest is yours to withdraw below.'));
  else copy.append(el('p','PROTOCOL / AUTOMATION','eyebrow'),el('h2','Automatic LAUNCHPAD buybacks'),el('p','Convert confirmed protocol revenue to SOL, then use 50% to buy and burn LAUNCHPAD.'));
  heading.append(copy,refresh);
  const status=el('p','','admin-revenue-status');status.setAttribute('role','status');status.id='admin-treasury-status';
  const wallet=el('div',null,'admin-protocol-gas'),facts=el('div',null,'admin-protocol-facts'),pending=el('div',null,'admin-protocol-gas'),assets=el('div',null,'admin-revenue-products'),history=el('div',null,'admin-protocol-gas');
  const setup=el('details',null,'admin-protocol-gas admin-treasury-setup');setup.id='admin-treasury-setup';setup.hidden=true;
  const setupCommand=el('pre',null,'admin-treasury-setup-command'),setupCode=el('code',SETUP_COMMAND),setupCopy=el('button','Copy VPS command','small-button'),setupMessage=el('p','','help');setupCommand.id='admin-treasury-setup-command';setupCommand.tabIndex=0;setupCommand.append(setupCode);setupCopy.type='button';setupCopy.id='admin-treasury-setup-copy';setupMessage.setAttribute('role','status');
  setup.append(el('summary','Set up your own treasury wallet'),el('p','Create a dedicated Solana wallet and save its backup. In your connected VPS terminal, run this command:','help'),setupCommand,setupCopy,setupMessage,el('p','Follow the private terminal prompts to verify your Launchpad admin account and install the wallet. Paste the wallet’s private key only into that terminal’s masked prompt. Never enter it on this website or in chat.','help'),el('p','Setup does not enable spending or redirect fees. When it finishes, refresh this panel, verify the wallet address, then enable automatic buybacks when ready.','help'));
  const policyNote=el('p','50% of confirmed SOL revenue is allocated to LAUNCHPAD buybacks; the other 50% stays in the treasury for platform costs. The worker keeps a 0.01 SOL operating reserve and batches buys from 0.001 SOL. Automated swaps use a fixed 1% slippage limit, separate from user trade settings.','help');
  const mint=el('p',null,'help');
  if(LAUNCHPAD_MINT)mint.append(el('span','Official LAUNCHPAD token: '),explorer('account',LAUNCHPAD_MINT,LAUNCHPAD_MINT));
  else mint.append(el('span','No platform token is set (LAUNCHPAD_TOKEN_MINT), so the treasury keeps all revenue in SOL.'));
  const form=el('form',null,'admin-protocol-form');form.id='admin-treasury-configure';
  const reasonLabel=el('label','Reason for update','admin-protocol-wide'),reason=el('input');reason.id='admin-treasury-reason';reason.required=true;reason.minLength=5;reason.maxLength=500;reason.placeholder='Record why automation is changing';reasonLabel.append(reason);
  const ackLabel=el('label',null,'check admin-protocol-wide'),ack=el('input'),ackCopy=el('span');ack.type='checkbox';ack.id='admin-treasury-ack';ackLabel.append(ack,ackCopy);
  const actionNote=el('p','','help admin-protocol-wide'),toggle=el('button','Enable automatic buybacks','small-button');toggle.type='submit';toggle.id='admin-treasury-toggle';form.append(reasonLabel,ackLabel,actionNote,toggle);
  const migration=el('details',null,'admin-protocol-gas');migration.id='admin-treasury-migration';migration.append(el('summary','Bring in previously collected protocol revenue'));
  migration.append(el('p','Transfer previously collected protocol revenue from a previous protocol fee wallet to the dedicated treasury wallet shown above. Then add the confirmed transfer below. Launchpad verifies the transaction and the recorded revenue before allocating it; an unrelated deposit or wallet balance does not count as revenue.','help'));
  const previous=el('div'),recognizeForm=el('form',null,'admin-protocol-form');recognizeForm.id='admin-treasury-recognize';
  const signatureLabel=el('label','Confirmed transfer signature','admin-protocol-wide'),signature=el('input');signature.required=true;signature.maxLength=88;signature.autocomplete='off';signature.spellcheck=false;signature.id='admin-treasury-signature';signatureLabel.append(signature);
  const assetLabel=el('label','Transferred revenue asset'),assetSelect=el('select');assetSelect.id='admin-treasury-asset';assetSelect.required=true;assetLabel.append(assetSelect);
  const transferReasonLabel=el('label','Reason for recognition'),transferReason=el('input');transferReason.id='admin-treasury-transfer-reason';transferReason.required=true;transferReason.minLength=5;transferReason.maxLength=500;transferReason.placeholder='Identify the protocol revenue transferred';transferReasonLabel.append(transferReason);
  const recognize=el('button','Verify and recognize revenue','small-button');recognize.type='submit';recognize.id='admin-treasury-recognize-submit';recognizeForm.append(signatureLabel,assetLabel,transferReasonLabel,recognize);
  const recognitionNote=el('p','','help');migration.append(previous,recognizeForm,recognitionNote);
  const withdrawals=el('details',null,'admin-protocol-gas');withdrawals.id='admin-treasury-withdrawals';withdrawals.append(el('summary','Withdraw retained platform revenue'));
  const withdrawalStatus=el('p','','help'),withdrawalPending=el('p','','help'),withdrawalForm=el('form',null,'admin-protocol-form');withdrawalForm.id='admin-treasury-withdraw';
  withdrawals.append(el('p','Withdraw only the platform’s retained share. The buyback allocation and required operating reserve remain protected. Each request is queued once and checked onchain before another transaction is prepared.','help'),withdrawalStatus,withdrawalPending,withdrawalForm);
  const amountLabel=el('label','Amount (SOL)'),withdrawalAmount=el('input');withdrawalAmount.id='admin-treasury-withdraw-amount';withdrawalAmount.inputMode='decimal';withdrawalAmount.required=true;withdrawalAmount.maxLength=30;withdrawalAmount.placeholder='0.00';amountLabel.append(withdrawalAmount);
  const recipientLabel=el('label','Receiving Solana wallet'),withdrawalRecipient=el('input');withdrawalRecipient.id='admin-treasury-withdraw-recipient';withdrawalRecipient.required=true;withdrawalRecipient.maxLength=44;withdrawalRecipient.autocomplete='off';withdrawalRecipient.spellcheck=false;recipientLabel.append(withdrawalRecipient);
  const withdrawalReasonLabel=el('label','Reason for withdrawal','admin-protocol-wide'),withdrawalReason=el('input');withdrawalReason.id='admin-treasury-withdraw-reason';withdrawalReason.required=true;withdrawalReason.minLength=5;withdrawalReason.maxLength=500;withdrawalReason.placeholder='Record the purpose of this withdrawal';withdrawalReasonLabel.append(withdrawalReason);
  const withdraw=el('button','Queue withdrawal','small-button');withdraw.type='submit';withdraw.id='admin-treasury-withdraw-submit';withdrawalForm.append(amountLabel,recipientLabel,withdrawalReasonLabel,withdraw);
  const recorded=el('div',null,'admin-protocol-gas');recorded.id='admin-treasury-recorded-buybacks';recorded.hidden=true;
  const platform=el('div',null,'admin-protocol-gas');platform.id='admin-treasury-platform';platform.hidden=true;
  if(TENANT){policyNote.textContent='Revenue in other tokens is converted to SOL first (Jupiter, with a fixed 1% slippage limit). The treasury keeps a 0.01 SOL operating reserve for network fees. The platform share is paid once it reaches its minimum.';mint.hidden=true;form.hidden=true;migration.hidden=true;withdrawals.querySelector('summary').textContent='Withdraw your revenue';withdrawals.querySelector('p').textContent='Withdraw your share of the revenue. The platform’s unpaid share and the operating reserve stay in the treasury. Each request is queued once and checked onchain before another transaction is prepared.';}
  const accountingTitle=el('h3','Automatic treasury accounting');
  element.append(heading,status,wallet,setup,policyNote,mint,recorded,platform,accountingTitle,facts,form,pending,assets,migration,withdrawals,history);

  let revision=0,disposed=false,active=false,loading=false,busy=false,timer=null,snapshot=null,hasData=false,assetChoices=[],withdrawalRequest=null,reviewedWallet=null,loadedAt=0;
  const permitted=()=>!disposed&&getAccount()?.role==='admin'&&getAccount()?.mfaEnabled;
  const identity=()=>{const account=getAccount();return account?.id??account;};
  const permittedAt=(generation,owner)=>permitted()&&generation===revision&&owner===identity();
  setupCopy.onclick=async()=>{if(!permitted()||setup.hidden)return;const generation=revision,owner=identity();try{await copyText(SETUP_COMMAND);if(permittedAt(generation,owner))setupMessage.textContent='Command copied. Paste it into your connected VPS terminal.';}catch{if(permittedAt(generation,owner))setupMessage.textContent='Select and copy the command above, then paste it into your connected VPS terminal.';}};
  function explorer(kind,value,label){const node=el(validBase58(value,kind==='tx'?64:32)?'a':'span',label||value,'text-button');if(node.tagName==='A'){node.href='https://solscan.io/'+kind+'/'+value;node.target='_blank';node.rel='noopener noreferrer';}
    // An address shown as its own link keeps its full text and gives way in the middle when space runs out.
    if(typeof value==='string'&&value.length>12&&node.textContent===value){node.replaceChildren(el('span',value.slice(0,-6)),el('span',value.slice(-6)));node.classList.add('admin-address');node.setAttribute('title',value);}return node;}
  function stop(){if(timer!==null){clearTimer(timer);timer=null;}}
  function schedule(){stop();if(active&&permitted()&&isActive()&&!document.hidden&&!busy)timer=setTimer(()=>{if(permitted()&&isActive()&&!document.hidden)void load();else stop();},POLL_MS);}
  function updateControls(){
    const unavailable=!permitted()||!hasData||busy||loading;
    const enable=snapshot?.enabled!==true,walletReady=snapshot?.configured===true&&validBase58(snapshot?.address,32);
    setup.hidden=!permitted()||!hasData||snapshot?.configured!==false||validBase58(snapshot?.address,32);if(setup.hidden){setup.open=false;setupMessage.textContent='';}
    refresh.disabled=busy||loading||!permitted();toggle.disabled=unavailable||snapshot?.activationPending===true||(enable&&!walletReady);
    reason.disabled=unavailable;ack.disabled=unavailable||!walletReady;
    toggle.textContent=snapshot?.activationPending?'Activation in progress…':enable?'Enable automatic buybacks':'Pause automatic buybacks';
    ackLabel.hidden=!enable;ack.required=enable;
    ackCopy.textContent=snapshot?.ownerControlled===true?'I have backed up this wallet and verified its address above. Use it for future protocol fee receipts and enable automatic conversion, LAUNCHPAD buybacks and burns.':'I have verified the treasury address above. Use it for future protocol fee receipts and enable automatic conversion, LAUNCHPAD buybacks and burns.';
    const transferReady=walletReady&&Array.isArray(snapshot?.previousRecipients)&&snapshot.previousRecipients.some(value=>validBase58(value,32))&&assetChoices.length>0;
    recognize.disabled=signature.disabled=assetSelect.disabled=transferReason.disabled=unavailable||!transferReady;
    const balance=typeof snapshot?.availableRetainedSol==='string'&&/^\d{1,80}$/.test(snapshot.availableRetainedSol)?BigInt(snapshot.availableRetainedSol):0n;
    withdraw.disabled=withdrawalAmount.disabled=withdrawalRecipient.disabled=withdrawalReason.disabled=unavailable||!walletReady||!!snapshot?.pendingWithdrawal||(balance===0n&&!withdrawalRequest);
  }
  function clear(){
    revision++;active=false;loading=false;busy=false;stop();snapshot=null;hasData=false;loadedAt=0;assetChoices=[];withdrawalRequest=null;reviewedWallet=null;element.hidden=true;
    status.textContent='';status.classList.remove('negative');recorded.replaceChildren();recorded.hidden=true;wallet.replaceChildren();facts.replaceChildren();pending.replaceChildren();assets.replaceChildren();history.replaceChildren();previous.replaceChildren();assetSelect.replaceChildren();
    reason.value='';ack.checked=false;signature.value='';transferReason.value='';withdrawalAmount.value='';withdrawalRecipient.value='';withdrawalReason.value='';withdrawalStatus.textContent='';withdrawalPending.textContent='';actionNote.textContent='';recognitionNote.textContent='';setupMessage.textContent='';setup.open=migration.open=withdrawals.open=false;updateControls();
  }
  function amount(value,decimals,symbol){const result=revenueAmount(value,decimals);return result===null?'—':result+(symbol?' '+symbol:'');}
  function renderWalletBalance(data){
    wallet.querySelector('#admin-treasury-wallet-balance')?.remove();
    const balance=data.walletBalance,now=clock(),observed=balance?.observedAt;
    const fresh=balance?.status==='available'&&balance.address===data.address&&balance.commitment==='finalized'&&Number.isSafeInteger(balance.slot)&&balance.slot>=0&&Number.isSafeInteger(observed)&&observed>0&&observed<=now&&now-observed<=120000&&typeof balance.lamports==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(balance.lamports)&&BigInt(balance.lamports)<=2n**64n-1n;
    const block=el('div',null,'admin-protocol-gas');block.id='admin-treasury-wallet-balance';
    const value=el('strong',fresh?amount(balance.lamports,9,'SOL'):'—');value.id='admin-treasury-wallet-balance-value';
    block.append(el('h3','Actual wallet balance'),value,el('p',fresh?'Finalized SOL balance · checked '+dateLabel(observed)+'.':'The wallet balance is temporarily unavailable. Refresh to check it.','help'),el('p',TENANT?'This is the SOL held in the treasury wallet right now, including the operating reserve and any platform share not paid yet. A deposit that is not a protocol fee is not counted as revenue.':'This is the SOL held in the wallet, separate from the recorded revenue and buyback allocations below. Deposits may include gas or other funds; they are not automatically treated as protocol revenue.','help'));
    wallet.append(block);
  }
  function renderRecordedBuybacks(data){
    if(TENANT){recorded.hidden=true;return;}
    const totals=data.recordedBuybackTotals;recorded.replaceChildren();recorded.hidden=!totals?.manualIncluded&&totals?.status!=='unavailable';if(recorded.hidden)return;
    recorded.append(el('h3','Recorded protocol buybacks'));
    if(totals.status==='unavailable'){recorded.append(el('p','Recorded buyback history needs reconciliation. Automatic treasury accounting remains below.','help'));return;}
    const metrics=el('div',null,'admin-protocol-facts');
    for(const [label,value,decimals,symbol] of [['SOL spent',totals.solSpent,9,'SOL'],['LAUNCHPAD acquired',totals.curveBought,totals.curveDecimals,'LAUNCHPAD'],['LAUNCHPAD burned',totals.curveBurned,totals.curveDecimals,'LAUNCHPAD']]){
      const item=el('div',null,'admin-stat');item.append(el('span',label),el('strong',Number.isInteger(decimals)?amount(value,decimals,symbol):'—'));metrics.append(item);
    }
    recorded.append(metrics,el('p',(totals.complete===false?'Recorded subtotal. ':'')+'Includes automatic treasury activity and verified manual receipts. Manual receipts do not change the available automatic buyback budget. Amounts exclude network fees and rent; acquired LAUNCHPAD is net of transfer tax.','help'));
    const contributed=typeof totals.manualContributionBurned==='string'&&/^[1-9]\d{0,79}$/.test(totals.manualContributionBurned)?amount(totals.manualContributionBurned,totals.curveDecimals,'LAUNCHPAD'):'—';
    if(contributed!=='—')recorded.append(el('p',contributed+' in this burn total came from tokens contributed to the treasury; no protocol buyback spend is recorded for them.','help'));
    const rows=Array.isArray(totals.history)?totals.history:[],details=el('details');details.append(el('summary','Verified buyback and burn receipts'));
    for(const row of rows){if(!['buy','burn'].includes(row.kind)||!validBase58(row.signature,64))continue;const line=el('p',null,'help'),label=row.kind==='burn'&&row.funding==='external-contribution'?'Contributed LAUNCHPAD burn':(row.source==='manual'?'Manual ':'Automatic ')+(row.kind==='buy'?'buyback':'burn');line.append(explorer('tx',row.signature,label),el('span',dateLabel(row.confirmedAt)?' · '+dateLabel(row.confirmedAt):''));details.append(line);}
    if(details.children.length>1)recorded.append(details);
  }
  function setFacts(data){
    const totals=data.totals||{},curveDecimals=Number.isInteger(data.curveDecimals)?data.curveDecimals:null;
    const curveAmount=value=>curveDecimals===null?amount(value,0,'base units'):amount(value,curveDecimals,'LAUNCHPAD');
    if(TENANT){const share=data.platform||{};facts.replaceChildren(...[['SOL revenue received',amount(totals.receivedSol,9,'SOL')],['Assets converted to SOL',amount(totals.convertedSol,9,'SOL')],['Platform share accrued',amount(share.accrued,9,'SOL')],['Your share (after network costs)',amount(totals.retainedSol,9,'SOL')],['Network costs paid',amount(totals.networkSpent,9,'SOL')],['You withdrew',amount(totals.withdrawnSol,9,'SOL')]].map(([label,value])=>{const item=el('div',null,'admin-stat');item.append(el('span',label),el('strong',value));return item;}));return;}
    facts.replaceChildren(...[
      ['SOL revenue received',amount(totals.receivedSol,9,'SOL')],['Assets converted to SOL',amount(totals.convertedSol,9,'SOL')],
      ['Available buyback budget',amount(totals.buybackAvailable,9,'SOL')],['Retained for platform costs',amount(totals.retainedSol,9,'SOL')],
      ['Spent on LAUNCHPAD buys',amount(totals.buybackSpent,9,'SOL')],['LAUNCHPAD burned',curveAmount(totals.curveBurned)],
      ['LAUNCHPAD awaiting burn',curveAmount(totals.burnAvailable)],['Network costs paid',amount(totals.networkSpent,9,'SOL')],['Retained SOL withdrawn',amount(totals.withdrawnSol,9,'SOL')]
    ].map(([label,value])=>{const item=el('div',null,'admin-stat');item.append(el('span',label),el('strong',value));return item;}));
  }
  function renderAssets(rows){
    assets.replaceChildren(el('h3','Revenue assets awaiting conversion'));
    if(!rows.length){assets.append(el('p','No recorded assets are waiting for conversion.','help'));return;}
    for(const asset of rows){
      const item=el('article',null,'admin-revenue-product');item.append(el('h4',asset.symbol||'Revenue token'),el('p',validBase58(asset.mint,32)?asset.mint:'Asset address unavailable','account-address'));
      const credited=el('p','Recorded revenue: '+amount(asset.received,asset.decimals,asset.symbol)+' · Available to convert: '+amount(asset.credit,asset.decimals,asset.symbol),'help');
      item.append(credited,el('p','Converted: '+amount(asset.converted,asset.decimals,asset.symbol),'help'));
      const next=dateLabel(asset.nextAttemptAt);if(asset.error||next)item.append(el('p',(asset.error?'Waiting to retry conversion. ':'')+(next?'Next attempt: '+next+'.':'Launchpad checks available routes automatically while enabled.'),'help'));
      assets.append(item);
    }
  }
  function renderPending(operation){
    pending.replaceChildren(el('h3','Pending operation'));
    if(!operation){pending.append(el('p','No transaction is awaiting confirmation.','help'));return;}
    const state=operation.state==='confirmed'?'Confirmed':operation.state==='pending'?'Awaiting confirmation':operation.state==='prepared'?'Prepared':'Checking transaction';
    pending.append(el('p',(labels[operation.kind]||'Treasury transaction')+' · '+state,'help'));
    if(validBase58(operation.signature,64))pending.append(explorer('tx',operation.signature,'View transaction ↗'));
    if(operation.error)pending.append(el('p','Launchpad is checking this saved transaction before preparing another.','help'));
  }
  function renderHistory(rows){
    history.replaceChildren(el('h3','Recent treasury activity'));
    if(!rows.length){history.append(el('p','Confirmed treasury activity will appear here.','help'));return;}
    const list=el('ul',null,'admin-protocol-history');
    for(const entry of rows.slice(0,30)){const item=el('li'),state=entry.state==='confirmed'?'Confirmed':entry.state==='failed'?'Not completed':'Awaiting confirmation',time=dateLabel(entry.confirmedAt||entry.createdAt);item.append(el('span',(labels[entry.kind]||'Treasury transaction')+' · '+state+(time?' · '+time:'')));if(validBase58(entry.signature,64))item.append(explorer('tx',entry.signature,'View transaction ↗'));list.append(item);}
    history.append(list);
  }
  function updateChoices(rows){
    const selected=assetSelect.value;assetChoices=rows.filter(asset=>validBase58(asset.mint,32)).filter((asset,index,all)=>all.findIndex(other=>other.mint===asset.mint)===index);
    const current=[...assetSelect.options].map(option=>[option.value,option.textContent]);
    const options=assetChoices.map(asset=>[asset.mint,(asset.symbol||'Token')+' · '+asset.mint.slice(0,6)+'…'+asset.mint.slice(-4)]);
    if(JSON.stringify(current)!==JSON.stringify(options)){assetSelect.replaceChildren(...options.map(([value,text])=>{const option=el('option',text);option.value=value;return option;}));if(assetChoices.some(asset=>asset.mint===selected))assetSelect.value=selected;}
  }
  function render(data){
    const review=JSON.stringify([data.address,data.signerOrigin,data.expectedRecipient??data.recipient]);if(review!==reviewedWallet){ack.checked=false;reviewedWallet=review;}
    snapshot=data;hasData=true;loadedAt=clock();element.hidden=false;wallet.replaceChildren(el('h3','Dedicated treasury wallet'));
    const walletReady=data.configured===true&&validBase58(data.address,32);
    if(validBase58(data.address,32)){
      wallet.append(el('p',data.address,'account-address'),explorer('account',data.address,'View wallet ↗'));
      if(TENANT)wallet.append(el('p','Made by the server for this launchpad · receives every protocol fee','help'));
      else if(data.ownerControlled===true)wallet.append(el('p','Your wallet · installed from your backup','help'),el('p','Compare this address with your wallet app before enabling automation. Your backup gives you direct wallet access; Launchpad also has signing access to run the automation.','help'));
      else wallet.append(el('p','Existing service-managed treasury wallet','help'));
      wallet.append(el('p','Keep at least 0.01 SOL here for operating costs. New protocol receipts sent here are processed while automation is enabled.','help'));
    }
    if(walletReady)renderWalletBalance(data);
    if(TENANT){const share=data.platform;platform.hidden=!share;if(share){const pct=Number(share.bps)/100;platform.replaceChildren(el('h3','Platform share · '+(Number.isFinite(pct)?pct:'—')+'% to '+LAUNCHER));const grid=el('div',null,'admin-protocol-facts');for(const [label,value] of [['Accrued',amount(share.accrued,9,'SOL')],['Paid',amount(share.paid,9,'SOL')],['Waiting to be paid',amount(share.owed,9,'SOL')],['Paid from',amount(share.minimumLamports,9,'SOL')]]){const item=el('div',null,'admin-stat');item.append(el('span',label),el('strong',value));grid.append(item);}platform.append(grid);if(share.retry?.reason)platform.append(el('p','Next platform payout: '+share.retry.reason,'help'));const payouts=Array.isArray(share.payouts)?share.payouts.slice(-5).reverse():[];if(payouts.length){const list=el('p',null,'help');list.append(el('span','Recent payouts: '));payouts.forEach((row,index)=>{if(index)list.append(el('span',' · '));list.append(explorer('tx',row.signature,amount(row.amount,9,'SOL')));});platform.append(list);}}}
    if(!walletReady&&!TENANT)wallet.append(el('p','Wallet setup required. Create and back up a dedicated Solana wallet, then install it using the treasury wallet setup command on your VPS. Refresh this panel when setup finishes. Keep private keys and seed phrases out of this page.','help'));
    const enabled=data.enabled===true,updated=dateLabel(data.updatedAt);
    status.textContent=(data.activationPending?'Activation is in progress.':enabled?'Automation enabled.':walletReady?'Automation paused.':'Wallet setup required before automation can be enabled.')+(typeof data.error==='string'&&data.error?' '+data.error.slice(0,220):'')+(updated?' Updated '+updated+'.':'');status.classList.toggle('negative',!!data.error);
    for(const [label,retry] of [['Buyback',data.buyRetry],['Burn',data.burnRetry]]){
      if(!retry||!Number.isSafeInteger(retry.attempts)||retry.attempts<1)continue;
      const next=dateLabel(retry.nextAttemptAt),why=typeof retry.reason==='string'?retry.reason.slice(0,220):'';
      status.append(el('span',' '+label+' retry '+retry.attempts+(why&&why!==data.error?': '+why:'.')+(enabled&&next?' Next attempt: '+next+'.':!enabled?' Automation is paused.':'')));
    }
    actionNote.textContent=enabled?'Pause stops new conversions, purchases and burns. Already submitted transactions are still checked, and outstanding allocations remain recorded.':!walletReady?'Installing your wallet does not activate automation, redirect fees or transfer funds. Complete setup on your VPS, then review the wallet address here.':'Enabling routes newly prepared protocol and locked-LP payouts, transfer-tax revenue and new creation fee receipts to this dedicated wallet. Previously collected funds stay in their existing wallet until transferred.';
    renderRecordedBuybacks(data);setFacts(data);renderAssets(Array.isArray(data.assets)?data.assets:[]);renderPending(data.pending);renderHistory(Array.isArray(data.history)?data.history:[]);
    previous.replaceChildren();for(const address of Array.isArray(data.previousRecipients)?data.previousRecipients:[])if(validBase58(address,32)){const p=el('p',null,'help');p.append(el('span','Previous protocol wallet: '),explorer('account',address,address));previous.append(p);}
    updateChoices(Array.isArray(data.recognitionAssets)?data.recognitionAssets:[]);
    recognitionNote.textContent=!walletReady?'Complete treasury wallet setup on your VPS first.':!previous.children.length?'No previous protocol wallet is recorded for revenue transfers.':!assetChoices.length?'No eligible previously collected protocol assets are recorded yet.':'Only verified transfers of recorded protocol revenue from a previous protocol wallet are recognized. Do not submit a gas-only top-up as revenue.';
    withdrawalStatus.textContent=(TENANT?'Available to withdraw (after the platform share and the operating reserve): ':'Available after the buyback allocation and operating reserve: ')+amount(data.availableRetainedSol,9,'SOL')+'.';
    withdrawalPending.replaceChildren();if(data.pendingWithdrawal){withdrawalPending.append(el('span','Queued withdrawal: '+amount(data.pendingWithdrawal.amount,9,'SOL')));if(validBase58(data.pendingWithdrawal.recipient,32))withdrawalPending.append(el('span',' to '),explorer('account',data.pendingWithdrawal.recipient,data.pendingWithdrawal.recipient));}
    updateControls();
  }
  async function load(){
    if(!permitted()){clear();return;}if(!isActive()){stop();return;}active=true;if(document.hidden){schedule();return;}if(loading||busy)return;
    loading=true;updateControls();const generation=revision,owner=identity();element.hidden=false;if(!hasData)status.textContent='Loading treasury status…';
    try{const data=await api('/api/admin/protocol-treasury');if(permittedAt(generation,owner))render(data);}
    catch{if(permittedAt(generation,owner)){status.textContent=hasData?'Treasury status could not be refreshed. Showing the last confirmed snapshot.':'Treasury status is temporarily unavailable. Use Refresh to try again.';status.classList.add('negative');if(snapshot?.configured===true&&validBase58(snapshot.address,32))renderWalletBalance({...snapshot,walletBalance:null});}}
    finally{if(generation===revision){if(!permittedAt(generation,owner)){clear();return;}loading=false;updateControls();schedule();}}
  }
  async function mutate(title,path,body,{configured=false,withdrawal=false,createdWithdrawal=false}={}){
    if(!permitted()||!hasData||busy||loading||element.hidden)return;
    const generation=revision,owner=identity();let submitted=false;busy=true;stop();updateControls();
    try{
      const credentials=await security.authorize(title,{requireCode:true});if(!permittedAt(generation,owner))return;
      submitted=true;const data=await api(path,{...body,...credentials});if(!permittedAt(generation,owner))return;
      render(data);if(configured){reason.value='';ack.checked=false;message(data.enabled?'Automatic LAUNCHPAD buybacks enabled.':'Automatic LAUNCHPAD buybacks paused.');await onConfigured();}
      else if(withdrawal){withdrawalRequest=null;withdrawalAmount.value='';withdrawalRecipient.value='';withdrawalReason.value='';message('Retained-revenue withdrawal request recorded. Confirmation is tracked below.');}
      else{signature.value='';transferReason.value='';message('Revenue transfer verified and recorded.');}
    }catch(error){if(permittedAt(generation,owner)){if(withdrawal&&createdWithdrawal&&!submitted)withdrawalRequest=null;if(error?.message!=='Cancelled.')message(error?.known?error.message:'The treasury update could not be confirmed. Refresh status before trying again.',true);}}
    finally{if(generation===revision){if(!permittedAt(generation,owner)){clear();return;}busy=false;updateControls();schedule();}}
  }
  form.onsubmit=async event=>{
    event.preventDefault();if(toggle.disabled||!permitted())return;
    const explanation=reason.value.trim(),enabled=snapshot?.enabled!==true;
    if(explanation.length<5||explanation.length>500){message('Enter a reason from 5 to 500 characters.',true);return;}
    if(enabled&&!ack.checked){message('Confirm the treasury setup before enabling automatic buybacks.',true);return;}
    return mutate(enabled?'Enable automatic LAUNCHPAD buybacks and burns':'Pause automatic LAUNCHPAD buybacks','/api/admin/protocol-treasury/configure',{enabled,expectedRecipient:typeof snapshot.expectedRecipient==='string'?snapshot.expectedRecipient:typeof snapshot.recipient==='string'?snapshot.recipient:'',...(enabled?{expectedTreasuryAddress:snapshot.address}:{}),reason:explanation},{configured:true});
  };
  recognizeForm.onsubmit=async event=>{
    event.preventDefault();if(recognize.disabled||!permitted())return;
    const tx=signature.value.trim(),mint=assetSelect.value,explanation=transferReason.value.trim();
    if(!validBase58(tx,64)){message('Enter the confirmed Solana transfer signature.',true);return;}
    if(!assetChoices.some(asset=>asset.mint===mint)){message('Choose a recorded protocol revenue asset.',true);return;}
    if(explanation.length<5||explanation.length>500){message('Enter a reason from 5 to 500 characters.',true);return;}
    return mutate('Recognize previously collected protocol revenue','/api/admin/protocol-treasury/recognize',{signature:tx,mint,reason:explanation});
  };
  withdrawalForm.onsubmit=async event=>{
    event.preventDefault();if(withdraw.disabled||!permitted())return;
    const amountSol=withdrawalAmount.value.trim(),units=solUnits(amountSol),recipient=withdrawalRecipient.value.trim(),explanation=withdrawalReason.value.trim();
    if(units===null||units<=0n){message('Enter a positive SOL amount with up to nine decimal places.',true);return;}
    if(!validBase58(recipient,32)||recipient===snapshot.address){message('Enter a different valid Solana receiving wallet.',true);return;}
    if(explanation.length<5||explanation.length>500){message('Enter a reason from 5 to 500 characters.',true);return;}
    const intent=JSON.stringify([units.toString(),recipient,explanation]);
    if(withdrawalRequest&&withdrawalRequest.intent!==intent){message('Retry the previous withdrawal with its original details to confirm its status before changing this request.',true);return;}
    if(!withdrawalRequest&&(!/^\d{1,80}$/.test(snapshot.availableRetainedSol||'')||units>BigInt(snapshot.availableRetainedSol))){message('The amount exceeds retained SOL available after the buyback allocation and operating reserve.',true);return;}
    const createdWithdrawal=!withdrawalRequest;withdrawalRequest||={intent,requestId:globalThis.crypto.randomUUID()};
    return mutate('Withdraw retained platform revenue','/api/admin/protocol-treasury/withdraw',{amountSol,recipient,reason:explanation,requestId:withdrawalRequest.requestId},{withdrawal:true,createdWithdrawal});
  };
  function pause(){active=false;stop();}
  // Opening the page again reuses a snapshot younger than one poll interval and only restarts polling.
  function show(){if(permitted()&&isActive()&&hasData&&clock()-loadedAt<POLL_MS){active=true;schedule();return;}return load();}
  function visibility(){if(document.hidden||!isActive()){stop();return;}if(active&&permitted())void load();}
  function destroy(){clear();disposed=true;document.removeEventListener('visibilitychange',visibility);}
  refresh.onclick=load;document.addEventListener('visibilitychange',visibility);clear();return {element,load,show,clear,pause,destroy};
}
