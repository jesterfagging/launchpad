import { revenueAmount } from './admin-revenue-ui.mjs';

const POLL_MS=60000;
const address=value=>typeof value==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)?value:'';
const signature=value=>typeof value==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value)?value:'';
const text=(value,size=160)=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,'').slice(0,size):'';
const integer=(value,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=0&&value<=max?value:null;
const timestamp=value=>integer(value,8640000000000000);
const creationFee=value=>typeof value==='string'&&/^(?:0|0\.\d{1,9})$/.test(value)&&Number(value)<=.1?value:null;
const raw=value=>typeof value==='string'&&/^\d{1,80}$/.test(value)?value:null;
const flag=value=>typeof value==='boolean'?value:null;
const list=value=>Array.isArray(value)?value:[];
const operation=value=>({kind:text(value?.kind,40),signature:signature(value?.signature),state:text(value?.state,30),createdAt:timestamp(value?.createdAt)});
const issue=value=>({code:text(value?.code,80),scope:text(value?.scope,40),...(integer(value?.count)!==null?{count:value.count}:{})});

// Downloads deliberately project a public diagnostic schema. Never serialize
// an entire response, account, launch record or managed treasury object.
export function safeRevenueAuditReport(value={}){
  const policy=value?.policy||{},treasury=value?.treasury||{},summary=value?.summary||{};
  return {
    version:1,generatedAt:timestamp(value?.generatedAt),evidence:'saved-records',liveChainVerified:false,
    policy:{configured:flag(policy.configured),recipient:address(policy.recipient),creationFeeSol:creationFee(policy.creationFeeSol),curveFeeBps:integer(policy.curveFeeBps,10000),taxRevenueShareBps:integer(policy.taxRevenueShareBps,10000),autoHarvest:flag(policy.autoHarvest),lpPolicy:text(policy.lpPolicy,80),platformLpPercent:integer(policy.platformLpPercent,100)},
    treasury:{configured:flag(treasury.configured),enabled:flag(treasury.enabled),address:address(treasury.address),recipientMatches:flag(treasury.recipientMatches),previousRecipients:list(treasury.previousRecipients).map(address).filter(Boolean),pending:treasury.pending?operation(treasury.pending):null},
    summary:Object.fromEntries(['launches','meteoraReceipts','legacyLaunches','pendingOperations','untrackedCreationReceipts','attentionCount'].map(key=>[key,integer(summary[key])])),
    totals:list(value?.totals).map(row=>({mint:address(row?.mint),symbol:text(row?.symbol,30),decimals:integer(row?.decimals,18),recipient:address(row?.recipient),kind:text(row?.kind,40),amount:raw(row?.amount),receipts:integer(row?.receipts),currentRecipient:flag(row?.currentRecipient)})),
    transfers:list(value?.transfers).map(row=>({signature:signature(row?.signature),mint:address(row?.mint),amount:raw(row?.amount),recipient:address(row?.recipient),sourceWallet:address(row?.sourceWallet),decimals:integer(row?.decimals,18),symbol:text(row?.symbol,30),kind:text(row?.kind,40),currentRecipient:flag(row?.currentRecipient)})),
    coins:list(value?.coins).map(row=>({id:text(row?.id,100),accountId:text(row?.accountId,100),name:text(row?.name,100),symbol:text(row?.symbol,30),mint:address(row?.mint),quoteMint:address(row?.quoteMint),quoteSymbol:text(row?.quoteSymbol,30),quoteDecimals:integer(row?.quoteDecimals,18),baseDecimals:integer(row?.baseDecimals,18),platformFeeBps:integer(row?.platformFeeBps,10000),protocolWallet:address(row?.protocolWallet),recipient:address(row?.recipient),autoHarvest:flag(row?.autoHarvest),lpPolicy:text(row?.lpPolicy,80),taxBps:integer(row?.taxBps,10000),taxSourceBaseCredit:raw(row?.taxSourceBaseCredit),protocolCredit:raw(row?.protocolCredit),protocolBaseCredit:raw(row?.protocolBaseCredit),taxProtocolCredit:raw(row?.taxProtocolCredit),pending:list(row?.pending).map(operation),issues:list(row?.issues).map(value=>text(value,80))})),
    issues:list(value?.issues).map(issue),
  };
}

const issueLabels={
  recipient_unconfigured:'A protocol revenue recipient is not configured.',
  invalid_creation_fee:'The saved creation fee needs review.',
  invalid_fee_policy:'The saved swap or transfer-tax fee policy needs review.',
  invalid_lp_policy:'The saved migration LP policy needs review.',
  automatic_collection_disabled:'Automatic protocol fee collection is disabled.',
  treasury_unconfigured:'The managed treasury has not been configured.',
  treasury_automation_disabled:'Automatic treasury conversions and buybacks are paused.',
  invalid_revenue_history:'Some saved revenue history could not be reconciled.',
  previous_recipient_history:'Saved payouts include earlier or different recipients. Compare their dates with recipient changes.',
  creation_history_untracked:'Some creation fees have no retained receipt to reconcile.',
  pending_transaction:'A saved transaction is awaiting a signature or confirmation.',
  receipt_waiting:'A saved transaction is still waiting for its receipt.',
  protocol_signer_unavailable:'A dedicated managed protocol fee signer is unavailable for this launch.',
  legacy_burned_lp:'This launch uses the legacy policy that burns all migration LP.',
  collection_needs_attention:'Protocol collection needs a status review.',
  invalid_tax_ledger:'The saved tax revenue ledger needs review.',
  invalid_protocol_ledger:'The saved protocol revenue ledger needs review.',
  collected_awaiting_forward:'Collected protocol revenue is awaiting payout.',
  tax_conversion_pending:'Collected transfer tax is awaiting conversion before its protocol share is calculated.',
  missing_protocol_recipient:'A protocol revenue recipient is not configured.',
  protocol_recipient_missing:'A protocol revenue recipient is not configured.',
  treasury_recipient_mismatch:'The revenue recipient differs from the managed treasury wallet.',
  treasury_disabled:'Automatic treasury conversions and buybacks are paused or not enabled.',
  treasury_not_configured:'The managed treasury has not been configured.',
  auto_harvest_disabled:'Automatic protocol fee collection is disabled.',
  protocol_auto_harvest_disabled:'Automatic protocol fee collection is disabled.',
  legacy_launch:'This launch uses a legacy fee policy.',
  legacy_protocol_policy:'This launch uses a legacy fee policy.',
  missing_creation_receipt:'A creation fee has no retained receipt to reconcile.',
  untracked_creation_receipts:'Some creation fees have no retained receipt to reconcile.',
  pending_operation:'A saved fee transaction is awaiting confirmation.',
  pending_operations:'Saved fee transactions are awaiting confirmation.',
  history_unavailable:'Some saved history is unavailable.',
  incomplete_history:'Some saved history is incomplete.',
  protocol_credit_pending:'Collected protocol fees are awaiting payout.',
  tax_protocol_credit_pending:'Collected tax revenue is awaiting payout.',
  recipient_mismatch:'A recorded payout recipient differs from the current recipient.',
};
const kindLabels={'meteora-partner-payout':'Meteora protocol revenue',creation:'Creation fees','protocol-payout':'Protocol swap fees','tax-protocol-payout':'Transfer-tax revenue','protocol-lp-payout':'Locked LP fees'};
const issueLabel=code=>issueLabels[code]||'This record needs review; the downloaded report includes its diagnostic code.';
const dateLabel=value=>Number.isSafeInteger(value)&&value>0&&!Number.isNaN(new Date(value).getTime())?new Date(value).toLocaleString():null;
const feeLabel=value=>value===null?'Unavailable':String(value/100)+'%';

export function createAdminRevenueAudit({document,api,getAccount,isActive=()=>true,setTimer=setInterval,clearTimer=clearInterval,downloadFile,clock=Date.now}){
  const el=(tag,value,cls)=>{const node=document.createElement(tag);if(value!==undefined&&value!==null)node.textContent=String(value);if(cls)node.className=cls;return node;};
  const element=el('details',null,'admin-revenue-gross admin-revenue-audit');element.id='admin-revenue-audit';element.append(el('summary','Revenue checks'));
  const introduction=el('p','Checks the saved fee configuration and payout records. This report does not independently verify on-chain balances or prove that every historical fee was collected.','admin-muted');
  const controls=el('div',null,'admin-card-heading'),refresh=el('button','Refresh checks','text-button'),download=el('button','Download report','text-button');refresh.type=download.type='button';refresh.id='admin-revenue-audit-refresh';download.id='admin-revenue-audit-download';controls.append(refresh,download);
  const status=el('p','','admin-revenue-status');status.id='admin-revenue-audit-status';status.setAttribute('role','status');
  const configuration=el('div',null,'admin-protocol-gas'),issues=el('div',null,'admin-protocol-gas'),totals=el('div',null,'admin-revenue-table-wrap'),coins=el('div',null,'admin-revenue-products');
  element.append(introduction,controls,status,configuration,issues,totals,coins);
  let revision=0,loading=false,disposed=false,active=false,timer=null,snapshot=null,snapshotOwner='',loadedAt=0;
  const identity=()=>getAccount()?.id||getAccount()?.username||'';
  const permitted=()=>!disposed&&getAccount()?.role==='admin'&&getAccount()?.mfaEnabled===true&&!getAccount()?.banned;
  const permittedAt=(generation,owner)=>permitted()&&revision===generation&&identity()===owner;
  function stop(){if(timer!==null){clearTimer(timer);timer=null;}}
  function pause(){active=false;stop();}
  function schedule(){stop();if(active&&isActive()&&permitted()&&!document.hidden)timer=setTimer(()=>{if(isActive()&&permitted()&&!document.hidden)void load();else stop();},POLL_MS);}
  function clear(){revision++;active=false;loading=false;stop();snapshot=null;snapshotOwner='';loadedAt=0;configuration.replaceChildren();issues.replaceChildren();totals.replaceChildren();coins.replaceChildren();status.textContent='';element.hidden=true;refresh.disabled=false;download.disabled=true;}
  function amount(value,decimals,symbol){const formatted=revenueAmount(value,decimals);return formatted===null?'Unavailable':formatted+(symbol?' '+symbol:'');}
  function wallet(label,value){const root=el('p',null,'admin-muted'),address=el('span',value||'Not configured','account-address');if(typeof value==='string'&&value.length>12){address.replaceChildren(el('span',value.slice(0,-6)),el('span',value.slice(-6)));address.classList.add('admin-address');address.setAttribute('title',value);}root.append(el('strong',label+': '),address);return root;}
  function fact(label,value){const line=el('p',null,'admin-muted');line.append(el('strong',label+': '),el('span',value));return line;}
  function render(data,owner){
    snapshot=safeRevenueAuditReport(data);snapshotOwner=owner;loadedAt=clock();const {policy,treasury,summary}=snapshot;
    configuration.replaceChildren(el('h3','Current fee routing'),wallet('Protocol revenue wallet',policy.recipient),wallet('Managed treasury',treasury.address));
    configuration.append(fact('Creation fee',policy.creationFeeSol===null?'Unavailable':policy.creationFeeSol+' SOL'),fact('Automatic protocol collection',policy.autoHarvest===true?'Enabled':policy.autoHarvest===false?'Disabled':'Unavailable'),fact('Treasury conversions and buybacks',treasury.enabled===true?'Enabled':treasury.configured===true?'Paused':'Not configured'),fact('Treasury destination',treasury.recipientMatches===true?'Matches protocol revenue wallet':treasury.recipientMatches===false?'Does not match protocol revenue wallet':'Unavailable'),fact('Launchpad protocol swap fee',feeLabel(policy.curveFeeBps)),fact('Protocol share of transfer taxes',feeLabel(policy.taxRevenueShareBps)+' of collected tax proceeds'));
    if(policy.taxRevenueShareBps!==null)configuration.append(el('p','A '+feeLabel(policy.taxRevenueShareBps)+' share of a 5% transfer tax is '+String(policy.taxRevenueShareBps/2000)+'% of the taxable transfer before rounding and conversion costs.','admin-muted'));
    const counts=[['Raydium launch policies checked',summary.launches],['Legacy launches',summary.legacyLaunches],['Pending transactions',summary.pendingOperations],['Untracked creation receipts',summary.untrackedCreationReceipts]];
    for(const[label,value]of counts)configuration.append(fact(label,value===null?'Unavailable':String(value)));
    if(summary.meteoraReceipts!==null)configuration.append(fact('Finalized Meteora protocol payouts',String(summary.meteoraReceipts)));
    issues.replaceChildren(el('h3','Items to review'));
    if(snapshot.issues.length){const rows=el('ul',null,'admin-protocol-history');for(const row of snapshot.issues){const item=el('li',issueLabel(row.code)+(row.count!==undefined?' ('+row.count+')':''));rows.append(item);}issues.append(rows);}
    else issues.append(el('p','No configuration issues were reported in the saved records. On-chain collection has not been independently verified.','admin-muted'));
    if(treasury.pending)issues.append(el('p','Treasury transaction: '+(treasury.pending.kind||'Operation')+' · '+(treasury.pending.state||'Awaiting confirmation'),'admin-muted'));
    totals.replaceChildren(el('h3','Recorded payouts by destination'));
    if(snapshot.totals.length){const table=el('table',null,'admin-revenue-table'),head=el('thead'),header=el('tr'),body=el('tbody');for(const label of ['Revenue','Amount sent','Destination','Receipts'])header.append(el('th',label,['Amount sent','Receipts'].includes(label)?'num':null));head.append(header);table.append(head,body);for(const row of snapshot.totals){const line=el('tr');line.append(el('td',kindLabels[row.kind]||'Protocol revenue'),el('td',amount(row.amount,row.decimals,row.symbol),'admin-revenue-amount num'));const destination=el('td'),recipient=el('span',row.recipient||'Unavailable','account-address');
        // A recipient address keeps its full text and gives way in the middle on narrow screens.
        if(row.recipient&&row.recipient.length>12){recipient.replaceChildren(el('span',row.recipient.slice(0,-6)),el('span',row.recipient.slice(-6)));recipient.classList.add('admin-address');recipient.setAttribute('title',row.recipient);}
        destination.append(recipient,el('small',row.currentRecipient===true?'Current recipient':row.currentRecipient===false?'Previous or different recipient':'Recipient comparison unavailable','admin-muted'));line.append(destination,el('td',row.receipts===null?'Unavailable':row.receipts,'num'));body.append(line);}totals.append(table,el('p','Amounts are recorded gross payouts before token transfer fees. These saved receipts are not a live reconciliation.','admin-muted'));}
    else totals.append(el('p','No retained protocol payout receipts are available. This does not establish zero lifetime revenue.','admin-muted'));
    coins.replaceChildren();
    const attention=snapshot.coins.filter(row=>row.issues.length||row.pending.length||[row.protocolCredit,row.protocolBaseCredit,row.taxProtocolCredit,row.taxSourceBaseCredit].some(value=>value!==null&&BigInt(value)>0n));
    if(attention.length){coins.append(el('h3','Launches with pending amounts or checks'));for(const row of attention.slice(0,20)){const card=el('article',null,'admin-revenue-product');card.append(el('h4',(row.name||'Launch')+(row.symbol?' · '+row.symbol:'')),wallet('Token',row.mint));for(const code of row.issues)card.append(el('p',issueLabel(code),'admin-muted'));for(const[label,key,decimals,symbol]of [['Protocol payout pending','protocolCredit',row.quoteDecimals,row.quoteSymbol],['Tax revenue payout pending','taxProtocolCredit',row.quoteDecimals,row.quoteSymbol],['LP token-side payout pending','protocolBaseCredit',row.baseDecimals,row.symbol],['Collected tax awaiting conversion','taxSourceBaseCredit',row.baseDecimals,row.symbol]])if(row[key]!==null&&BigInt(row[key])>0n)card.append(fact(label,amount(row[key],decimals,symbol)));if(row.pending.length)card.append(fact('Saved transactions awaiting confirmation',String(row.pending.length)));coins.append(card);}if(attention.length>20)coins.append(el('p','Showing 20 of '+attention.length+' launches needing review. Download the report for all records.','admin-muted'));}
    const at=dateLabel(snapshot.generatedAt);status.textContent=(at?'Checked saved records '+at+'. ':'')+'On-chain verification: not performed.';status.classList.remove('negative');download.disabled=false;
  }
  async function load(){
    if(!permitted()){clear();return;}if(snapshot&&snapshotOwner!==identity())clear();if(!isActive()){pause();return;}active=true;if(document.hidden){schedule();return;}if(loading)return;
    loading=true;refresh.disabled=true;element.hidden=false;const generation=revision,owner=identity();if(!snapshot)status.textContent='Checking saved revenue records…';
    try{const data=await api('/api/admin/revenue-audit');if(permittedAt(generation,owner))render(data,owner);}
    catch{if(permittedAt(generation,owner)){status.textContent=snapshot?'Revenue checks could not refresh. Showing the previous saved-record snapshot.':'Revenue checks are temporarily unavailable. Use Refresh checks to try again.';status.classList.add('negative');}}
    finally{if(generation===revision){if(!permittedAt(generation,owner)){clear();return;}loading=false;refresh.disabled=false;schedule();}}
  }
  async function saveDownload(){
    if(!permitted()||!snapshot||snapshotOwner!==identity()){clear();return;}
    const current=safeRevenueAuditReport(snapshot),date=dateLabel(current.generatedAt)?new Date(current.generatedAt).toISOString().slice(0,10):'snapshot';
    const file={name:'Launchpad-Revenue-Checks-'+date+'.json',type:'application/json',contents:JSON.stringify(current,null,2)+'\n'};
    try{
      if(downloadFile)await downloadFile(file);
      else {const objectUrl=URL.createObjectURL(new Blob([file.contents],{type:file.type})),link=el('a');try{link.href=objectUrl;link.download=file.name;document.body.append(link);link.click();}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(objectUrl),1000);}}
    }catch{status.textContent='The report could not be downloaded. Refresh checks and try again.';status.classList.add('negative');}
  }
  // Opening the page again reuses checks younger than one poll interval and only restarts polling.
  function show(){if(permitted()&&isActive()&&snapshot&&snapshotOwner===identity()&&clock()-loadedAt<POLL_MS){active=true;schedule();return;}return load();}
  function visibility(){if(document.hidden){stop();return;}if(active&&isActive()&&permitted())void load();}
  function destroy(){clear();disposed=true;document.removeEventListener('visibilitychange',visibility);}
  refresh.onclick=load;download.onclick=saveDownload;document.addEventListener('visibilitychange',visibility);clear();return {element,load,show,clear,pause,destroy};
}
