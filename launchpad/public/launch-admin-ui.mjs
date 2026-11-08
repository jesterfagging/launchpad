const el = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
const modes = { creator: 'Creator wallet', holders: 'Holder rewards', paycheck: 'Paycheck', buyback: 'Agent buyback' };
const validAmount=value=>typeof value==='string'&&/^\d{1,40}(?:\.\d{1,18})?$/.test(value);
const validAddress=value=>typeof value==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
const BASE58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// A base58 string that decodes to exactly 32 bytes: a Solana wallet address (checked before the identity prompt).
const walletAddress=value=>{if(!validAddress(value))return false;let number=0n,bytes=0;for(const char of value)number=number*58n+BigInt(BASE58.indexOf(char));for(;number>0n;number>>=8n)bytes++;return value.match(/^1*/)[0].length+bytes===32;};
const distributionLamports=value=>typeof value==='string'&&/^\d{1,40}$/.test(value)?BigInt(value):null;
const distributionSOL=value=>{const whole=value/1000000000n,fraction=(value%1000000000n).toString().padStart(9,'0').replace(/0+$/,'');return whole.toString()+(fraction?'.'+fraction:'');};
const sweepAmount=(value,decimals)=>{const units=distributionLamports(value);if(units===null||!Number.isInteger(decimals)||decimals<0||decimals>18)return null;const scale=10n**BigInt(decimals),fraction=(units%scale).toString().padStart(decimals,'0').replace(/0+$/,'');return (units/scale).toString()+(fraction?'.'+fraction:'');};
const sweepStates=['queued','waiting','processing','completed','partial','blocked','failed','skipped'];
const distributionReserved=item=>distributionLamports(item.remainingLamports)??distributionLamports(item.deferredLamports);
const routineDistributionSkip=item=>item.state==='skipped'&&/^(Only SOL-paired Raydium holder rewards are eligible\.|Only live holder rewards with SOL as the reward asset are included\.|The launch is not ready for a holder payout\.|No confirmed SOL reward credit is available\.|No credited SOL\.)$/.test(item.reason||'');
function taxAutomationMessage(row){
  const tax=row.taxBurn,automation=row.rewardsAutomation;
  if(tax.accountingUnavailable)return 'Tax collection and burning need an accounting review.';
  if(automation?.enabled!==true)return 'Automatic tax collection is paused with this coin’s reward service. Use Resume rewards to enable automatic checks. Collected tax stays reserved.';
  if(tax.enabled!==true||tax.paused===true)return 'Tax burns are paused by server settings or burn approval. Collected tax stays reserved.';
  if(tax.manual===true)return tax.manualRequested===true?'A burn of the collected tax is requested and runs with the next tax check, after any saved transaction.':'Automatic burning is off: tax is still collected into the rewards wallet and kept there until you use Burn collected tax now. It is never sold.';
  if(automation.status==='blocked'||['paused','error'].includes(row.state))return 'Automatic tax collection and burning need attention. Review the saved error below.';
  if(row.pendingOperation)return 'Automatic tax collection and burning are enabled. The saved transaction must finish first.';
  if(row.taxMaintenance?.retry)return 'Automatic tax collection and burning are waiting to retry. See the tax retry reason and next check.';
  return 'Automatic tax collection and burning are enabled and checked separately from holder payouts.';
}

export function createLaunchAdmin({ api, security, message, getAccount, setTimer = setTimeout, clearTimer = clearTimeout, isActive = () => true }) {
  if (!document.querySelector('link[href^="/launch-admin.css"]')) { const style = el('link'); style.rel = 'stylesheet'; style.href = '/launch-admin.css?v=67'; document.head.append(style); }
  const element = el('section', '', 'launch-admin account-section');
  const heading = el('div', '', 'card-heading'), refresh = el('button', 'Refresh', 'text-button'); refresh.type = 'button';
  const headingActions=el('div','','launch-admin-heading-actions'),distributeAll=el('button','Distribute SOL rewards','small-button'),archiveFailed=el('button','Archive all failed','small-button');distributeAll.type='button';distributeAll.dataset.adminDistributeAll='true';archiveFailed.type='button';archiveFailed.dataset.adminArchiveFailed='true';
  const sweepAll=el('button','Sell & distribute all rewards','small-button');sweepAll.type='button';sweepAll.dataset.adminSweepAll='true';
  headingActions.append(archiveFailed,distributeAll,sweepAll,refresh);heading.append(el('h3', 'Coins'), headingActions);
  const archivePanel=el('section','','launch-admin-distributions'),archiveStatus=el('p','','help'),archiveReasons=el('ul','','help'),archiveControls=el('div','','launch-admin-heading-actions'),archiveConfirm=el('button','Archive failed requests','small-button'),archiveCancel=el('button','Cancel','text-button');
  archivePanel.hidden=true;archivePanel.setAttribute('aria-label','Archive failed launch requests');archiveStatus.setAttribute('role','status');archiveConfirm.type=archiveCancel.type='button';archiveConfirm.dataset.adminArchiveConfirm='true';archiveCancel.dataset.adminArchiveCancel='true';archiveControls.append(archiveConfirm,archiveCancel);archivePanel.append(archiveStatus,archiveReasons,archiveControls);
  const distributionPanel=el('section','','launch-admin-distributions'),distributionHelp=el('p','Pay recorded SOL holder reward credits across eligible coins, including SOL-paired Pump.fun Holders coins. Protocol revenue uses Collect protocol fees. Gas reserves remain untouched. Other tokens are not converted.','help'),distributionStatus=el('p','','help'),distributionDetails=el('details'),distributionRows=el('ol','','launch-admin-distribution-rows');
  const distributionExcluded=el('details'),distributionExcludedSummary=el('summary'),distributionExcludedRows=el('ul','','help');distributionExcluded.dataset.distributionExcluded='true';distributionExcluded.append(distributionExcludedSummary,distributionExcludedRows);distributionExcluded.hidden=true;
  distributionPanel.setAttribute('aria-label','Bulk holder distributions');distributionStatus.setAttribute('role','status');distributionDetails.append(el('summary','Distribution progress'),distributionRows,distributionExcluded);distributionDetails.hidden=true;const distributionMore=el('details','','admin-more');distributionMore.append(el('summary','About Distribute SOL rewards'),distributionHelp);distributionPanel.append(distributionMore,distributionStatus,distributionDetails);
  const sweepPanel=el('section','','launch-admin-distributions launch-admin-reward-sweeps'),sweepStatus=el('p','','help'),sweepDetails=el('details'),sweepRows=el('ol','','launch-admin-distribution-rows');
  sweepPanel.setAttribute('aria-label','Sell and distribute all rewards');sweepStatus.setAttribute('role','status');sweepDetails.append(el('summary','Sell and distribute progress'),sweepRows);sweepDetails.hidden=true;
  const sweepMore=el('details','','admin-more');sweepMore.append(el('summary','About Sell & distribute all rewards'),el('p','Collect and sell eligible reward tokens into each coin’s quote asset, then distribute available rewards with no automatic minimum. Includes SOL and token quote pairs. Existing transactions finish first; network, liquidity and account checks still apply. LAUNCHPAD transfer tax keeps its configured burn policy. Pump.fun Holders coins collect their creator fees and pay holders in their pair asset; only a small part is sold for new holder accounts and network fees.','help'));sweepPanel.append(sweepMore,sweepStatus,sweepDetails);
  const help = el('p', 'Archived tokens includes hidden coins and archived launch requests. Expand a row to manage creator fees, holder distributions and buybacks.', 'help');
  const tabs = el('div', '', 'launch-admin-tabs cv-segmented'), activeTab = el('button', 'Active coins (0)', 'small-button'), archivedTab = el('button', 'Archived tokens (0)', 'small-button');
  tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Launch lists');
  for (const [button, target] of [[activeTab, 'active'], [archivedTab, 'archived']]) { button.type = 'button'; button.dataset.view = target; button.setAttribute('role', 'tab'); tabs.append(button); }

  const form = el('form', '', 'launch-admin-search admin-sticky-tools'), label = el('label', 'Find a launch'), search = el('input');
  search.type = 'search'; search.placeholder = 'Token, ticker, mint or account'; search.maxLength = 128; label.append(search);
  const find = el('button', 'Search', 'small-button'); find.type = 'submit'; form.append(label, find);
  const status = el('p', '', 'help'); status.setAttribute('role', 'status');
  const list = el('div', '', 'launch-admin-list');list.setAttribute('aria-label','Coins');list.tabIndex=0;const pagination = el('div', '', 'account-actions');
  const prev = el('button', 'Previous', 'small-button'), next = el('button', 'Next', 'small-button'); prev.type = next.type = 'button'; pagination.append(prev, next);
  const launchEntry=el('section','','launch-admin-create'),launchCopy=el('div');launchCopy.append(el('h3','Administrator launch'),el('p','Choose a starting market cap from $20,000 to $100,000. Public launches start at $20,000.','help'));const launchLink=el('a','Launch a token ↗','small-button');launchLink.href='/launchpad?admin=1';launchLink.dataset.adminPageAction='true';launchEntry.append(launchCopy,launchLink);
  element.append(launchEntry,heading, sweepPanel, distributionPanel, archivePanel, help, tabs, form, status, list, pagination);
  let offset = 0, nextOffset = null, revision = 0, busy = false, loading = false, view = 'active', accountId = null; const counts = { active: 0, archived: 0 }, moderating = new Map();
  const permitted = () => getAccount()?.role === 'admin' && getAccount()?.mfaEnabled;
  let distributionEpoch=0,distributionReadRevision=0,distributionTimer=null,distributionRead=null,distributionJob=null,distributionRequestId='';
  let sweepReadRevision=0,sweepTimer=null,sweepRead=null,sweepJob=null,sweepRequestId='';
  let archivePreview=null,archiveRequestId='';
  function clear() { clearRewardSweeps();++distributionEpoch;++distributionReadRevision;if(distributionTimer!==null)clearTimer(distributionTimer);distributionTimer=null;distributionRead=null;distributionJob=null;distributionRequestId='';distributionStatus.textContent='';distributionDetails.hidden=true;distributionRows.replaceChildren();distributionExcluded.hidden=true;distributionExcluded.open=false;distributionExcludedRows.replaceChildren();archivePreview=null;archiveRequestId='';archivePanel.hidden=true;archiveStatus.textContent='';archiveReasons.replaceChildren(); ++revision; moderating.clear(); busy = loading = false; accountId = null; list.replaceChildren(); status.textContent = ''; search.value = ''; offset = 0; nextOffset = null; view = 'active'; counts.active = counts.archived = 0; setNavigation(); element.hidden = true; }
  const sameSession = (generation, actorId) => generation === revision && permitted() && actorId === getAccount()?.id;
  function syncSession() { if (!permitted()) { clear(); return false; } if (accountId !== null && accountId !== getAccount().id) clear(); accountId = getAccount().id; return true; }

  const distributionActive=()=>['queued','running'].includes(distributionJob?.state);
  const sameDistributionSession=(epoch,actorId)=>epoch===distributionEpoch&&permitted()&&actorId===getAccount()?.id&&actorId===accountId;
  const distributionsVisible=()=>element.isConnected&&!element.hidden&&!element.closest('[hidden]')&&document.visibilityState!=='hidden'&&isActive();
  function scheduleDistributions({refresh=false}={}){
    if(distributionTimer!==null)clearTimer(distributionTimer);
    distributionTimer=null;if(!accountId||!permitted()||(!refresh&&!distributionActive()&&!distributionRequestId))return;
    distributionTimer=setTimer(async()=>{distributionTimer=null;if(distributionsVisible())await refreshDistributions();else scheduleDistributions({refresh});},5000);distributionTimer?.unref?.();
  }
  function displayDistributions(job){
    if(job!==null&&(!job||!/^([a-f0-9]{32})$/.test(job.requestId||'')||!['queued','running','completed','blocked'].includes(job.state)||!Array.isArray(job.items)||!job.items.every(item=>item&&typeof item==='object')||!['queued','processing','completed','skipped','failed'].every(key=>Number.isSafeInteger(job.counts?.[key])&&job.counts[key]>=0)||job.counts.waiting!==undefined&&(!Number.isSafeInteger(job.counts.waiting)||job.counts.waiting<0)||job.excludedCount!==undefined&&(!Number.isSafeInteger(job.excludedCount)||job.excludedCount<0)||job.excludedReasons!==undefined&&(!Array.isArray(job.excludedReasons)||!job.excludedReasons.every(row=>row&&typeof row.reason==='string'&&Number.isSafeInteger(row.count)&&row.count>=0))))throw Error('Distribution status could not be verified. Refresh to check the saved run.');
    distributionJob=job;distributionRows.replaceChildren();distributionExcludedRows.replaceChildren();distributionExcluded.hidden=true;distributionDetails.hidden=!job;
    if(!job){distributionStatus.textContent=distributionRequestId?'The last request is not confirmed yet. Retrying uses the same request ID.':'';setNavigation();return;}
    const counts=job.counts,state=job.state==='completed'?'Distribution run finished':job.state==='blocked'?'Distribution run needs attention':job.state==='running'?'Distributions processing':'Distributions queued';
    distributionStatus.textContent=`${state} · ${counts.queued} queued · ${counts.waiting||0} waiting · ${counts.processing} processing · ${counts.completed} finished · ${counts.skipped} skipped · ${counts.failed} failed.`;
    const paid=job.items.map(item=>distributionLamports(item.paidLamports)).filter(value=>value!==null),reserved=job.items.map(distributionReserved).filter(value=>value!==null);
    if(paid.length)distributionStatus.textContent+=` Reported paid: ${distributionSOL(paid.reduce((sum,value)=>sum+value,0n))} SOL.`;
    if(reserved.length)distributionStatus.textContent+=` Reported reserved (unpaid or rounding): ${distributionSOL(reserved.reduce((sum,value)=>sum+value,0n))} SOL.`;
    if(typeof job.reason==='string'&&job.reason)distributionStatus.textContent+=' '+job.reason.slice(0,300);
    const excludedReasons=new Map(),excluded=job.items.filter(routineDistributionSkip),operational=job.items.filter(item=>!routineDistributionSkip(item)),priority={failed:0,waiting:1,skipped:2,processing:3,queued:4,completed:5},labels={queued:'Queued',waiting:'Waiting',processing:'Processing',completed:'Finished',skipped:'Skipped',failed:'Failed'};
    for(const row of job.excludedReasons||[])excludedReasons.set(row.reason,(excludedReasons.get(row.reason)||0)+row.count);
    for(const item of excluded)excludedReasons.set(item.reason,(excludedReasons.get(item.reason)||0)+1);
    operational.sort((a,b)=>(priority[a.state]??6)-(priority[b.state]??6));
    for(const item of operational.slice(0,100)){
      const row=el('li'),name=String(item.symbol||item.name||item.mint||'Launch').slice(0,100),paid=distributionLamports(item.paidLamports),reserved=distributionReserved(item);let label=labels[item.state]||'Checking';
      if(item.state==='completed'&&paid!==null)label=paid>0n?'Paid':reserved>0n?'Reserved':'No payout';
      row.append(el('strong',name+' · '+label));
      if(validAddress(item.mint)){const mint=el('a',item.mint.slice(0,6)+'…'+item.mint.slice(-5));mint.href='https://solscan.io/token/'+item.mint;mint.target='_blank';mint.rel='noopener noreferrer';mint.title=item.mint;row.append(mint);}else if(typeof item.launchId==='string'&&item.launchId)row.append(el('small','Launch '+item.launchId.slice(0,12)));
      if(paid!==null||reserved!==null)row.append(el('span',[paid!==null?`${distributionSOL(paid)} SOL paid`:null,reserved!==null?`${distributionSOL(reserved)} SOL reserved (unpaid or rounding)`:null].filter(Boolean).join(' · ')));
      if(typeof item.reason==='string'&&item.reason)row.append(el('span',item.reason.slice(0,300)));distributionRows.append(row);
    }
    if(operational.length>100)distributionRows.append(el('li',`Showing the first 100 of ${operational.length} eligible or attention-needed launches. Totals include the entire run.`));
    const excludedCount=(job.excludedCount||0)+excluded.length;
    if(excludedCount){distributionExcluded.hidden=false;distributionExcludedSummary.textContent=`${excludedCount} launches excluded from this SOL payout run`;for(const [reason,count]of excludedReasons)distributionExcludedRows.append(el('li',`${count} · ${reason.slice(0,300)}`));}
    if(operational.some(item=>['waiting','failed','skipped'].includes(item.state)))distributionDetails.open=true;
    if(distributionRequestId===job.requestId)distributionRequestId='';setNavigation();
  }
  async function refreshDistributions(){
    if(!syncSession()||element.hidden)return;
    if(distributionRead||busy){scheduleDistributions({refresh:true});return;}
    const epoch=distributionEpoch,actorId=accountId,read=++distributionReadRevision,request={};distributionRead=request;
    try{const result=await api('/api/admin/holder-distributions');if(!sameDistributionSession(epoch,actorId)||read!==distributionReadRevision)return;displayDistributions(result?.job);}
    catch(error){if(sameDistributionSession(epoch,actorId)&&read===distributionReadRevision)distributionStatus.textContent='Distribution status is temporarily unavailable. '+String(error.message||'Refresh to check the saved run.').slice(0,300);}
    finally{if(distributionRead===request)distributionRead=null;if(sameDistributionSession(epoch,actorId))scheduleDistributions();}
  }
  distributeAll.onclick=async()=>{
    if(!syncSession()||element.hidden||busy||loading||moderating.size||distributionActive())return;
    const request={},epoch=distributionEpoch,actorId=accountId;busy=request;++distributionReadRevision;distributionStatus.textContent='Confirm your identity to start the distribution run.';setNavigation();
    try{
      const credentials=await security.authorize('Distribute all holder rewards',{requireCode:true});if(!sameDistributionSession(epoch,actorId))return;
      if(!distributionRequestId)distributionRequestId=globalThis.crypto.randomUUID().replaceAll('-','');
      const requestId=distributionRequestId;distributionStatus.textContent='Saving the distribution request…';
      const result=await api('/api/admin/holder-distributions',{requestId,...credentials});if(!sameDistributionSession(epoch,actorId))return;
      if(result?.job?.requestId!==requestId&&result?.alreadyRequested!==true)throw Error('The distribution request could not be verified. Refresh to check the saved run.');
      displayDistributions(result.job);distributionRequestId='';distributionDetails.open=true;
    }catch(error){if(sameDistributionSession(epoch,actorId)&&error.message!=='Cancelled.')distributionStatus.textContent=String(error.message||'The request could not be confirmed.').slice(0,300)+(distributionRequestId?' Refresh to check its status, or retry the same request.':'');else if(sameDistributionSession(epoch,actorId))displayDistributions(distributionJob);}
    finally{if(busy===request){busy=false;setNavigation();}if(sameDistributionSession(epoch,actorId))scheduleDistributions();}
  };
  function clearRewardSweeps(){++sweepReadRevision;if(sweepTimer!==null)clearTimer(sweepTimer);sweepTimer=null;sweepRead=null;sweepJob=null;sweepRequestId='';sweepStatus.textContent='';sweepDetails.hidden=true;sweepDetails.open=false;sweepRows.replaceChildren();}
  const sweepActive=()=>['queued','running'].includes(sweepJob?.state);
  function scheduleRewardSweeps({refresh=false}={}){
    if(sweepTimer!==null)clearTimer(sweepTimer);sweepTimer=null;
    if(!accountId||!permitted()||(!refresh&&!sweepActive()&&!sweepRequestId))return;
    sweepTimer=setTimer(async()=>{sweepTimer=null;if(distributionsVisible())await refreshRewardSweeps();else scheduleRewardSweeps({refresh});},5000);sweepTimer?.unref?.();
  }
  function displayRewardSweeps(job){
    if(job!==null&&(!job||!/^[a-f0-9]{32}$/.test(job.requestId||'')||!['queued','running','completed','blocked'].includes(job.state)||!Array.isArray(job.items)||!job.items.every(item=>item&&typeof item==='object'&&sweepStates.includes(item.state))||!sweepStates.every(key=>Number.isSafeInteger(job.counts?.[key])&&job.counts[key]>=0)))throw Error('Sell-and-distribute status could not be verified. Refresh to check the saved run.');
    sweepJob=job;sweepRows.replaceChildren();sweepDetails.hidden=!job;
    if(!job){sweepStatus.textContent=sweepRequestId?'The last sell-and-distribute request is not confirmed yet. Retrying uses the same request ID.':'';setNavigation();return;}
    const counts=job.counts,headline={queued:'Sell-and-distribute run queued',running:'Selling and distributing rewards',completed:'Sell-and-distribute run finished',blocked:'Sell-and-distribute run needs attention'}[job.state];
    sweepStatus.textContent=`${headline} · ${counts.queued} queued · ${counts.processing} processing · ${counts.waiting} waiting · ${counts.completed} finished · ${counts.partial} partial · ${counts.blocked} blocked · ${counts.failed} failed · ${counts.skipped} skipped.`;
    if(typeof job.reason==='string'&&job.reason)sweepStatus.textContent+=' '+job.reason.slice(0,500);
    const priority={failed:0,blocked:1,partial:2,waiting:3,processing:4,queued:5,completed:6,skipped:7},labels={queued:'Queued',waiting:'Waiting',processing:'Processing',completed:'Finished',partial:'Partially paid',blocked:'Blocked',failed:'Failed',skipped:'Skipped'};
    const rows=[...job.items].sort((a,b)=>priority[a.state]-priority[b.state]);
    for(const item of rows.slice(0,100)){
      const row=el('li'),name=typeof item.symbol==='string'?item.symbol.slice(0,40):'Token',quote=typeof item.quoteSymbol==='string'&&item.quoteSymbol?item.quoteSymbol.slice(0,40):'quote tokens';row.dataset.sweepState=item.state;
      if(['blocked','failed'].includes(item.state))row.classList.add('negative');row.append(el('strong',`${name} · ${labels[item.state]}`));
      if(validAddress(item.mint)){const mint=el('a',item.mint.slice(0,6)+'…'+item.mint.slice(-5));mint.href='https://solscan.io/token/'+item.mint;mint.target='_blank';mint.rel='noopener noreferrer';mint.title=item.mint;row.append(mint);}
      const remaining=sweepAmount(item.remainingBaseUnits,6),paid=sweepAmount(item.distributedQuoteUnits,item.quoteDecimals),reserved=sweepAmount(item.remainingQuoteUnits,item.quoteDecimals);
      if(remaining!==null)row.append(el('span',`${remaining} ${name} awaiting conversion`));
      if(paid!==null||reserved!==null)row.append(el('span',[paid!==null?`${paid} ${quote} paid`:null,reserved!==null?`${reserved} ${quote} reserved`:null].filter(Boolean).join(' · ')));
      if(['blocked','failed','waiting'].includes(item.state)&&((distributionLamports(item.remainingBaseUnits)||0n)>0n||(distributionLamports(item.remainingQuoteUnits)||0n)>0n))row.append(el('strong','Rewards are waiting in this coin’s wallets.'));
      const stages={existing:'Finishing saved transactions',collect:'Collecting reward fees and tax',convert:'Converting reward tokens',payout:'Paying holders',distribute:'Preparing holder payouts',done:'Run finished'};
      if(stages[item.stage])row.append(el('span',stages[item.stage]));
      if(typeof item.reason==='string'&&item.reason)row.append(el('span',item.reason.slice(0,500)));sweepRows.append(row);
    }
    if(rows.length>100)sweepRows.append(el('li',`Showing the first 100 of ${rows.length} coins. Totals include the entire run.`));
    if(job.items.some(item=>['blocked','failed','partial','waiting'].includes(item.state)))sweepDetails.open=true;
    if(sweepRequestId===job.requestId)sweepRequestId='';setNavigation();
  }
  async function refreshRewardSweeps(){
    if(!syncSession()||element.hidden)return;
    if(sweepRead||busy){scheduleRewardSweeps({refresh:true});return;}
    const epoch=distributionEpoch,actorId=accountId,read=++sweepReadRevision,request={};sweepRead=request;
    try{const result=await api('/api/admin/reward-sweeps');if(!sameDistributionSession(epoch,actorId)||read!==sweepReadRevision)return;displayRewardSweeps(result?.job);}
    catch(error){if(sameDistributionSession(epoch,actorId)&&read===sweepReadRevision)sweepStatus.textContent='Sell-and-distribute status is temporarily unavailable. '+String(error.message||'Refresh to check the saved run.').slice(0,300);}
    finally{if(sweepRead===request)sweepRead=null;if(sameDistributionSession(epoch,actorId))scheduleRewardSweeps();}
  }
  sweepAll.onclick=async()=>{
    if(!syncSession()||element.hidden||busy||loading||moderating.size||sweepActive())return;
    const request={},epoch=distributionEpoch,actorId=accountId;busy=request;++sweepReadRevision;sweepStatus.textContent='Confirm your identity to sell and distribute all rewards.';setNavigation();
    try{
      const credentials=await security.authorize('Sell and distribute all holder rewards',{requireCode:true});if(!sameDistributionSession(epoch,actorId))return;
      if(!sweepRequestId)sweepRequestId=globalThis.crypto.randomUUID().replaceAll('-','');const requestId=sweepRequestId;sweepStatus.textContent='Saving the sell-and-distribute request…';
      const result=await api('/api/admin/reward-sweeps',{requestId,...credentials});if(!sameDistributionSession(epoch,actorId))return;
      if(result?.job?.requestId!==requestId&&result?.alreadyRequested!==true)throw Error('The sell-and-distribute request could not be verified. Refresh to check the saved run.');
      displayRewardSweeps(result.job);sweepRequestId='';sweepDetails.open=true;
    }catch(error){if(sameDistributionSession(epoch,actorId)&&error.message!=='Cancelled.')sweepStatus.textContent=String(error.message||'The request could not be confirmed.').slice(0,300)+(sweepRequestId?' Retry uses the same saved request.':'');else if(sameDistributionSession(epoch,actorId))displayRewardSweeps(sweepJob);}
    finally{if(busy===request){busy=false;setNavigation();}if(sameDistributionSession(epoch,actorId))scheduleRewardSweeps();}
  };
  function showArchiveReasons(rows){archiveReasons.replaceChildren();for(const row of Array.isArray(rows)?rows.slice(0,20):[])if(Number.isSafeInteger(row?.count)&&row.count>0&&typeof row.message==='string')archiveReasons.append(el('li',`${row.count} · ${row.message.slice(0,250)}`));}
  archiveFailed.onclick=async()=>{
    if(!syncSession()||element.hidden||busy||loading||moderating.size||archiveRequestId)return;
    const request={},epoch=distributionEpoch,actorId=accountId;busy=request;archivePreview=null;archivePanel.hidden=false;archiveStatus.textContent='Checking failed requests across all accounts and pages…';archiveReasons.replaceChildren();setNavigation();
    try{
      const result=await api('/api/admin/failed-launch-archive');if(!sameDistributionSession(epoch,actorId))return;
      if(!Number.isSafeInteger(result?.eligibleCount)||result.eligibleCount<0||!Number.isSafeInteger(result?.excludedCount)||result.excludedCount<0)throw Error('The archive preview could not be verified.');
      archivePreview=result;archiveStatus.textContent=`${result.eligibleCount} failed ${result.eligibleCount===1?'request is':'requests are'} eligible to archive across all accounts. ${result.excludedCount} excluded. Live tokens, pending transactions and requests with funds or recovery work stay untouched.`;showArchiveReasons(result.excludedReasons);
    }catch(error){if(sameDistributionSession(epoch,actorId))archiveStatus.textContent=String(error.message||'Failed requests could not be checked.').slice(0,300);}
    finally{if(busy===request){busy=false;setNavigation();}}
  };
  archiveConfirm.onclick=async()=>{
    if(!syncSession()||element.hidden||busy||loading||moderating.size||!(archivePreview?.eligibleCount>0||archiveRequestId))return;
    const request={},epoch=distributionEpoch,actorId=accountId;busy=request;setNavigation();
    try{
      const credentials=await security.authorize(archiveRequestId?'Retry saved failed-launch archive':`Archive ${archivePreview.eligibleCount} eligible failed launch requests`,{requireCode:true});if(!sameDistributionSession(epoch,actorId))return;
      if(!archiveRequestId)archiveRequestId=globalThis.crypto.randomUUID().replaceAll('-','');const requestId=archiveRequestId;archiveStatus.textContent='Archiving eligible failed requests…';
      const result=await api('/api/admin/failed-launch-archive',{requestId,...credentials});if(!sameDistributionSession(epoch,actorId))return;
      if(result?.requestId!==requestId||!['completed','partial'].includes(result?.status)||!['archivedCount','skippedCount','remainingCount','excludedCount'].every(key=>Number.isSafeInteger(result[key])&&result[key]>=0)||result.status==='completed'&&result.remainingCount!==0)throw Error('The archive result could not be verified. Retry the saved request.');
      archiveStatus.textContent=`${result.archivedCount} failed ${result.archivedCount===1?'request':'requests'} archived · ${result.skippedCount} skipped during recheck · ${result.excludedCount} excluded in total.${result.status==='partial'?` ${result.remainingCount} still need confirmation. Retry this saved request to finish.`:' Archived records remain available in Archived tokens.'}`;showArchiveReasons(result.excludedReasons);if(result.status==='completed'){archiveRequestId='';archivePreview=null;}await load(offset,{afterMutation:true});
    }catch(error){if(sameDistributionSession(epoch,actorId)&&error.message!=='Cancelled.')archiveStatus.textContent=String(error.message||'The archive request could not be confirmed.').slice(0,300)+(archiveRequestId?' Retry uses the same saved request.':'');}
    finally{if(busy===request){busy=false;setNavigation();}}
  };
  archiveCancel.onclick=()=>{if(busy||archiveRequestId)return;archivePanel.hidden=true;archivePreview=null;archiveStatus.textContent='';archiveReasons.replaceChildren();setNavigation();};

  function render(row) {
    const damm=row.route==='damm-pump',pumpFun=row.route==='pump-classic',pump=damm||pumpFun||row.route==='pumpswap',meteora=row.route==='meteora',native=pump||meteora,routeBody=native?{route:row.route,mint:row.mint}:{};
    const item = el('details', '', 'launch-admin-row'), title = el('summary');
    const identity=el('span','','launch-admin-coin-identity'),actions=el('span','','launch-admin-coin-actions'),visibilityState=el('span','','launch-admin-visibility-state'),visibilityButton=el('button','','small-button launch-admin-visibility-toggle'),rowStatus=el('span','','launch-admin-row-status');
    identity.append(el('strong',`${row.name} · ${row.symbol}`),el('small',`${row.username} · ${row.mint?row.mint.slice(0,6)+'…'+row.mint.slice(-5):'Mint pending'}`));
    identity.append(el('span',meteora?'Meteora':pumpFun?'Pump.fun':pump?'PumpSwap':'Raydium','launch-admin-venue'));
    if(!pump&&row.rewardsAutomation?.needed===true){const paused=row.rewardsAutomation.enabled!==true||['paused','error'].includes(row.state);identity.append(el('span',paused?'Rewards paused':'Rewards need attention','launch-admin-reward-badge'));}
    visibilityButton.type='button';actions.append(visibilityState,visibilityButton,el('span','⌄','launch-admin-expand'));title.append(identity,actions);item.append(title);rowStatus.setAttribute('role','status');identity.append(rowStatus);
    const key=(native?row.route+':':'')+String(row.accountId)+':'+String(row.id);item.dataset.launchKey=key;
    const archiveButton = row.canArchive || row.canRestore ? el('button', '', 'small-button launch-admin-archive-toggle') : null;
    visibilityButton.dataset.adminListAction = 'true';
    if (archiveButton) { archiveButton.type = 'button'; archiveButton.dataset.adminListAction = 'true'; actions.insertBefore(archiveButton, actions.lastChild); }
    function visibilityStateRender() {
      visibilityState.textContent = row.hidden ? 'Hidden' : row.manuallyArchived ? 'Archived' : 'Visible'; visibilityState.dataset.hidden = String(row.hidden === true);
      visibilityButton.textContent = row.hidden ? 'Restore visibility' : 'Hide'; visibilityButton.setAttribute('aria-label', `${row.hidden ? 'Restore visibility for' : 'Hide'} ${row.symbol || row.name}`); visibilityButton.title = row.hidden ? 'Restore this coin to public pages' : native?'Hide this coin from public listings; direct token links remain available':'Hide this coin from public listings and token pages';
      if (archiveButton) { archiveButton.textContent = row.manuallyArchived ? 'Restore request' : 'Archive request'; archiveButton.setAttribute('aria-label', `${row.manuallyArchived ? 'Restore' : 'Archive'} launch request for ${row.symbol || row.name}`); }
    }
    visibilityStateRender();
    async function updateListing(event, kind) {
      event?.preventDefault(); event?.stopPropagation();
      if (!permitted() || accountId !== getAccount().id || busy || moderating.size) return;
      const archived = row.manuallyArchived !== true;
      if (kind === 'archive' && (archived ? !row.canArchive : !row.canRestore)) return;
      const request = {}, generation = revision, actorId = getAccount().id, targetHidden = !row.hidden;
      moderating.set(key, request); rowStatus.textContent = ''; rowStatus.classList.remove('negative'); setNavigation();
      const button = kind === 'archive' ? archiveButton : visibilityButton;
      button.textContent = kind === 'archive' ? archived ? 'Archiving…' : 'Restoring…' : targetHidden ? 'Hiding…' : 'Restoring…';
      let refreshList = false;
      try {
        if (kind === 'archive') {
          const result = await api('/api/admin/launches/archive', { accountId: row.accountId, id: row.id, ...routeBody, archived });
          if (!sameSession(generation, actorId)) return;
          if (result?.launch?.id !== row.id || result.launch.manuallyArchived !== archived || native&&(result.route!==row.route||result.launch.route!==row.route||result.launch.mint!==row.mint)) throw Error('The archive update could not be verified. Refresh to check this request.');
          if ((view === 'archived') !== Boolean(result.launch.listArchived ?? (archived || result.launch.hidden))) item.remove();
          message(archived ? 'Launch request moved to Archived tokens.' : result.launch.hidden ? 'Request restored. The hidden coin remains in Archived tokens.' : 'Launch request restored to Active coins.');
        } else {
          const result = await api('/api/admin/moderation/launch', { accountId: row.accountId, id: row.id, ...routeBody, hidden: targetHidden, reason: targetHidden ? 'Administrator hid this coin from public pages.' : 'Administrator restored this coin to public pages.' });
          if (!sameSession(generation, actorId)) return;
          if (result?.hidden !== targetHidden || result?.id !== row.id || native&&(result.route!==row.route||result.mint!==row.mint)) throw Error('The visibility update could not be verified. Refresh to check this coin.');
          row.hidden = result.hidden;
          if ((view === 'archived') !== Boolean(row.hidden || row.manuallyArchived)) item.remove();
          message(targetHidden ? 'Coin hidden and moved to Archived tokens.' : row.manuallyArchived ? 'Public visibility restored. The archived request remains in Archived tokens.' : 'Coin restored to public pages and Active coins.');
        }
        refreshList = true;
      } catch (error) {
        if (sameSession(generation, actorId)) { rowStatus.textContent = error.message || 'This request could not be updated. Try again.'; rowStatus.classList.add('negative'); }
      } finally {
        if (moderating.get(key) === request) moderating.delete(key);
        if (sameSession(generation, actorId)) { visibilityStateRender(); setNavigation(); if (refreshList) await load(offset); }
      }
    }
    visibilityButton.onclick = event => updateListing(event, 'visibility');
    if (archiveButton) archiveButton.onclick = event => updateListing(event, 'archive');
    if (row.archiveReason) item.append(el('p', row.archiveReason, 'help'));
    item.append(el('p', `${row.username} · ${modes[row.feeMode] || row.feeMode}`, 'help'), el('p', row.mint, 'account-address'));
    const current = el('p', row.recipient || modes[row.feeMode] || 'No wallet recipient', 'account-address'); item.append(el('p', 'Current recipient', 'help'), current);
    if(native&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(row.mint||'')){const open=el('a','Open coin →','small-button');open.href='/coin?mint='+encodeURIComponent(row.mint);item.append(open);}
    if (!native&&row.eligibility?.allowed) {
      const editor = el('form'), recipientLabel = el('label', 'New recipient'), recipient = el('input'); recipient.required = true; recipient.autocomplete = 'off'; recipient.spellcheck = false; recipient.maxLength = 44; recipient.placeholder = 'Solana wallet address'; recipientLabel.append(recipient);
      const reasonLabel = el('label', 'Takeover reason'), reason = el('textarea'); reason.required = true; reason.minLength = 5; reason.maxLength = 500; reason.rows = 2; reason.placeholder = 'Why are these creator fees being reassigned?'; reasonLabel.append(reason);
      const note = el('p', 'Unclaimed creator fees will follow the new recipient. Completed payouts and token authorities stay unchanged. This change is recorded in the admin history.', 'help');
      const save = el('button', 'Change recipient', 'small-button admin-danger'); save.type = 'submit'; editor.append(recipientLabel, reasonLabel, note, save);
      editor.onsubmit = async event => {
        event.preventDefault(); if (busy || moderating.size || !permitted() || accountId !== getAccount().id) return;
        const nextRecipient = recipient.value.trim(), explanation = reason.value.trim();
        if (!walletAddress(nextRecipient)) { message('Enter a valid Solana wallet address for the new recipient.', true); recipient.focus?.(); return; }
        if (nextRecipient === row.recipient && row.feeMode === 'creator') { message('This wallet already receives the creator fees.', true); recipient.focus?.(); return; }
        if (explanation.length < 5 || explanation.length > 500) { message('Enter a takeover reason between 5 and 500 characters.', true); reason.focus?.(); return; }
        const request = {}; busy = request; save.disabled = true; setNavigation(); const generation = revision, actorId = getAccount().id;
        try {
          const credentials = await security.authorize(`Change ${row.symbol} fee recipient`, { requireCode: true });
          if (!sameSession(generation, actorId)) return;
          await api('/api/admin/launches/recipient', { accountId: row.accountId, id: row.id, recipient: nextRecipient, expectedRecipient: row.recipient, expectedMode: row.feeMode, reason: explanation, ...credentials });
          if (!sameSession(generation, actorId)) return; message('Creator fee recipient updated.'); await load(offset, { afterMutation: true });
        } catch (error) { if (sameSession(generation, actorId) && error.message !== 'Cancelled.') message(error.message, true); }
        finally { if (busy === request) { busy = false; save.disabled = false; setNavigation(); } }
      };
      item.append(editor);
    } else item.append(el('p', meteora?'Meteora fee routing is managed from the recipient’s private launches page. Visibility changes do not stop trading.':damm?'This PumpSwap launch has no creator or holder rewards. Visibility changes affect public listings; the token and its trading page stay available.':pump?'The creator fee recipient is fixed for this PumpSwap version. Visibility changes affect public listings; the token and its trading page stay available.':row.eligibility?.reason||'Fee recipient changes are unavailable.', 'help'));
    if(!native&&row.rewardsAction?.kind){
      const action=row.rewardsAction,section=el('section','','launch-admin-reward');section.append(el('h4',action.kind==='distribute'?'Holder reward operations':'Buyback operations'));
      const rewardsWallet=row.rewardsWallet,taxBurn=row.taxBurn?.selected===true?row.taxBurn:null;
      if(action.kind==='distribute'&&rewardsWallet?.status==='active'&&typeof rewardsWallet.address==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(rewardsWallet.address)){
        const roles=el('p','','help'),link=el('a',taxBurn?'Tax burn & payout wallet ↗':'Reward conversion & payout wallet ↗');link.href='https://solscan.io/account/'+rewardsWallet.address;link.title=rewardsWallet.address;link.target='_blank';link.rel='noopener noreferrer';roles.append(link,el('span',' · Creator fee collection keeps its original wallet.'));section.append(roles);
      }else if(action.kind==='distribute'&&rewardsWallet?.status==='migrating')section.append(el('p','Preparing a separate reward conversion wallet. Pending transactions finish before earned funds move.','help'));
      const automation=row.rewardsAutomation;
      if(automation?.pauseAllowed===true&&(automation.enabled===true||automation.pauseNeeded===true)){
        const pausePanel=el('div','','launch-admin-reward-recovery'),controls=el('div','','launch-admin-reward-controls'),pause=el('button','Pause automatic rewards','small-button'),feedback=el('p','','help');
        pause.type='button';pause.dataset.adminRewardPause='true';pause.dataset.pauseAllowed='true';pause.setAttribute('aria-label',`Pause automatic rewards for ${row.symbol||row.name}`);
        controls.append(el('strong',automation.enabled===true?'Automatic rewards enabled':'Reward work requested'),pause);pausePanel.append(controls,el('p','Stops new reward work for this coin. Already signed transactions are still checked; unsent holder rewards and token balances stay reserved.','help'));
        feedback.setAttribute('role','status');feedback.classList.add('launch-admin-pause-feedback');pausePanel.append(feedback);section.append(pausePanel);let pauseRequestId='';
        pause.onclick=async event=>{
          event?.preventDefault();event?.stopPropagation();
          if(busy||moderating.size||loading||!permitted()||accountId!==getAccount().id)return;
          const request={};busy=request;feedback.textContent='';feedback.classList.remove('negative');pause.textContent='Pausing…';setNavigation();const generation=revision,actorId=getAccount().id;
          try{
            const credentials=await security.authorize(`Pause ${row.symbol} automatic rewards`,{requireCode:true});if(!sameSession(generation,actorId))return;
            if(!pauseRequestId)pauseRequestId=globalThis.crypto.randomUUID().replaceAll('-','');
            const result=await api('/api/admin/launches/action',{accountId:row.accountId,id:row.id,action:'pause-rewards',reason:'Automatic rewards paused from the admin panel.',requestId:pauseRequestId,...credentials});
            if(!sameSession(generation,actorId))return;
            if(!['paused','already_requested'].includes(result?.status)||result.requestId!==pauseRequestId||result.launch?.id!==row.id||result.launch?.accountId!==row.accountId||result.launch?.rewardsAutomation?.enabled!==false)throw Error('The pause could not be verified. Refresh to check this coin.');
            message(result.message||'Automatic rewards paused. Saved transactions will still be checked.');pauseRequestId='';await load(offset,{afterMutation:true});
          }catch(error){if(sameSession(generation,actorId)&&error.message!=='Cancelled.'){feedback.textContent=error.message||'Rewards could not be paused. Try again.';feedback.classList.add('negative');}}
          finally{if(busy===request){busy=false;pause.textContent='Pause automatic rewards';setNavigation();}}
        };
      }
      if(automation?.needed===true){
        const recovery=el('div','','launch-admin-reward-recovery'),controls=el('div','','launch-admin-reward-controls'),resume=el('button','Resume rewards','small-button'),feedback=el('p','','help');
        resume.type='button';resume.dataset.adminRewardResume='true';resume.dataset.resumeAllowed=String(automation.allowed===true);resume.disabled=automation.allowed!==true;resume.setAttribute('aria-label',`Resume rewards for ${row.symbol||row.name}`);
        controls.append(el('strong',automation.enabled!==true||['paused','error'].includes(row.state)?'Automatic rewards paused':'Automatic rewards need attention'),resume);recovery.append(controls);
        if(row.serviceError)recovery.append(el('p',row.serviceError,'negative'));
        recovery.append(el('p',automation.reason||(automation.pending?'The saved transaction will be checked before any new reward work.':'Resume automatic checks from the saved step. The $100 distribution minimum and network-cost limits still apply.'),'help'));
        feedback.setAttribute('role','status');feedback.classList.add('launch-admin-reward-feedback');recovery.append(feedback);section.append(recovery);let resumeRequestId='';
        resume.onclick=async event=>{
          event?.preventDefault();event?.stopPropagation();
          if(busy||moderating.size||loading||!permitted()||accountId!==getAccount().id||automation.allowed!==true)return;
          const request={};busy=request;feedback.textContent='';feedback.classList.remove('negative');resume.textContent='Resuming…';setNavigation();const generation=revision,actorId=getAccount().id;
          try{
            const credentials=await security.authorize(`Resume ${row.symbol} rewards`,{requireCode:true});if(!sameSession(generation,actorId))return;
            if(!resumeRequestId)resumeRequestId=globalThis.crypto.randomUUID().replaceAll('-','');
            const result=await api('/api/admin/launches/action',{accountId:row.accountId,id:row.id,action:'resume-rewards',reason:'Automatic rewards resumed from the admin panel.',requestId:resumeRequestId,...credentials});
            if(!sameSession(generation,actorId))return;
            if(!['resumed','already_requested'].includes(result?.status)||result.requestId!==resumeRequestId||result.launch?.id!==row.id||result.launch?.accountId!==row.accountId||result.launch?.rewardsAutomation?.enabled!==true)throw Error('The resume request could not be verified. Refresh to check this coin.');
            message(result.message||'Automatic rewards resumed. Saved transactions are checked before new work.');resumeRequestId='';await load(offset,{afterMutation:true});
          }catch(error){if(sameSession(generation,actorId)&&error.message!=='Cancelled.'){feedback.textContent=error.message||'Rewards could not be resumed. Try again.';feedback.classList.add('negative');}}
          finally{if(busy===request){busy=false;resume.textContent='Resume rewards';setNavigation();}}
        };
      }else if(row.serviceError)section.append(el('p',row.serviceError,'negative'));
      const retryReason=typeof row.rewardRetry?.reason==='string'?row.rewardRetry.reason.slice(0,300):'';
      if(retryReason)section.append(el('p',`${taxBurn?'Holder rewards — last retry reason':'Last retry reason'}: ${retryReason}`,'help launch-admin-retry-reason'));
      // Payout gas (v71.37): on a pair other than SOL, Launchpad sells a little of the rewards for the SOL a payout needs; say what it did.
      const gas=row.payoutGas;
      if(gas&&(gas.confirmedSales||gas.pending||gas.note)){
        const parts=[];
        if(gas.pending)parts.push('Selling a little of the rewards for the SOL this payout needs (new holder token accounts and network fees).');
        else if(gas.confirmedSales)parts.push(`Sold rewards for payout network costs ${gas.confirmedSales} time${gas.confirmedSales===1?'':'s'}${gas.cycleSales?` (${gas.cycleSales} in this cycle)`:''}${gas.lastSaleAt?`, last ${new Date(gas.lastSaleAt).toLocaleString()}`:''}.`);
        if(gas.note)parts.push(gas.note);
        section.append(el('p',parts.join(' '),'help launch-admin-payout-gas'));
      }
      const deferred=row.deferredRewards;
      if(deferred?.unavailable===true)section.append(el('p','Reserved holder rewards need an accounting review.','negative'));
      else if(Number.isSafeInteger(deferred?.wallets)&&deferred.wallets>0&&typeof deferred.amount==='string'&&/^\d+(\.\d+)?$/.test(deferred.amount))section.append(el('p',`${deferred.amount} SOL is still owed to ${deferred.wallets} ${deferred.wallets===1?'wallet':'wallets'}. Rewards stay reserved until payout checks pass, including Solana’s minimum receiving-wallet balance. ${row.rewardsAutomation?.enabled===true?'Automatic checks are enabled.':'Enable automatic rewards or use Distribute now to recheck.'}`,'help launch-admin-deferred-rewards'));
      const retryAt=row.rewardRetry?.at;
      if(action.autoFees&&Number.isSafeInteger(retryAt)&&retryAt>Date.now()&&retryAt<=8640000000000000){const retry=el('p',`Rewards will retry automatically at ${new Date(retryAt).toLocaleString()}.`,'help');retry.setAttribute('role','status');section.append(retry);}
      const pending=row.pendingOperation;
      if(pending&&['pending','awaiting_signature'].includes(pending.state)){
        const details=el('div','','launch-admin-pending'),kind=typeof pending.kind==='string'?pending.kind.replaceAll('-',' ').slice(0,64):'reward';
        details.setAttribute('role','status');details.append(el('p',pending.state==='awaiting_signature'?`Waiting for wallet approval for the ${kind||'reward'} transaction.`:`Checking pending ${kind||'reward'} transaction.`,'help'));
        if(typeof pending.reason==='string'&&pending.reason)details.append(el('p',pending.reason.slice(0,300),'help'));
        if(pending.state==='pending')details.append(el('p','Launchpad checks this saved transaction before preparing another.','help'));
        if(Number.isSafeInteger(pending.createdAt)&&pending.createdAt>=0&&pending.createdAt<=8640000000000000)details.append(el('p',`Prepared ${new Date(pending.createdAt).toLocaleString()}`,'help'));
        if(row.network==='mainnet-beta'&&typeof pending.signature==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(pending.signature)){
          const receipt=el('p','','account-address'),link=el('a',`View transaction: ${pending.signature} ↗`);link.href='https://solscan.io/tx/'+pending.signature;link.target='_blank';link.rel='noopener noreferrer';receipt.append(link);details.append(receipt);
        }
        section.append(details);
      }else if(row.serviceStage)section.append(el('p',`Saved step: ${row.serviceStage} · ${row.state}`,'help'));
      const balances=el('div','','launch-admin-credits');if(row.credits?.quote!==null&&row.credits?.quote!==undefined)balances.append(el('span',`${row.credits.quote} ${row.quoteSymbol||'quote tokens'} ${taxBurn?'recorded holder rewards':'available'}`));if(!taxBurn&&row.credits?.base!==null&&row.credits?.base!==undefined)balances.append(el('span',`${row.credits.base} ${row.symbol} awaiting ${action.kind==='buyback'?'burn':'conversion'}`));if(taxBurn){if(taxBurn.pendingTaxTokens!=null)balances.append(el('span',`${taxBurn.pendingTaxTokens} ${row.symbol} collected tax awaiting burn`));if(taxBurn.initialInventory?.status==='authorized')balances.append(el('span',`${taxBurn.initialInventory.approvedTokens} ${row.symbol} initial inventory approved for one burn (includes collected tax above)`));else if(taxBurn.unattributedTokens!=null&&Number(taxBurn.unattributedTokens)>0)balances.append(el('span',`${taxBurn.unattributedTokens} ${row.symbol} other token credit reserved`));}if(balances.childNodes.length)section.append(balances);
      if(taxBurn){
        const detail=el('p',`${taxBurn.manual===true?`Collected ${row.symbol} transfer tax is kept in the rewards wallet until you burn it; 100% of it is burned, never sold.`:`100% of collected ${row.symbol} transfer tax is burned directly.`} Separately accrued creator-fee SOL still funds holder rewards; existing owed SOL stays reserved. Recorded holder rewards are not the wallet’s spendable gas balance. ${taxAutomationMessage(row)}`,'help launch-admin-tax-burn');
        if(taxBurn.tokensBurned!=null)detail.append(el('span',` ${taxBurn.tokensBurned} ${row.symbol} burned directly in ${taxBurn.completedBurns??'—'} confirmed burns${taxBurn.initialInventory?.status==='burned'?', including the approved initial inventory':''}.`));
        if(typeof taxBurn.lastBurnSignature==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(taxBurn.lastBurnSignature)){const link=el('a',' Latest tax burn ↗');link.href='https://solscan.io/tx/'+taxBurn.lastBurnSignature;link.target='_blank';link.rel='noopener noreferrer';detail.append(link);}
        if(taxBurn.accountingUnavailable)detail.append(el('span',' Tax-burn accounting needs review; amounts are unavailable.'));
        section.append(detail);
        // v71.24: without automatic burns, the owner burns the collected tax on request (password and 2FA).
        if(taxBurn.manual===true&&taxBurn.manualRequested!==true&&taxBurn.paused!==true&&(Number(taxBurn.pendingTaxTokens)>0||taxBurn.initialInventory?.status==='authorized')){
          const burnBox=el('div','','launch-admin-reward-controls'),burn=el('button','Burn collected tax now','small-button admin-danger'),feedback=el('p','','help');let burnRequestId='';
          burn.type='button';burn.dataset.adminTaxBurn='true';feedback.setAttribute('role','status');burnBox.append(el('strong',`${taxBurn.pendingTaxTokens??'—'} ${row.symbol} collected tax ready to burn`),burn);section.append(burnBox,feedback);
          burn.onclick=async event=>{
            event?.preventDefault();if(busy||moderating.size||loading||!permitted()||accountId!==getAccount().id)return;
            const request={};busy=request;burn.disabled=true;feedback.textContent='';feedback.classList.remove('negative');setNavigation();const generation=revision,actorId=getAccount().id;
            try{
              const credentials=await security.authorize(`Burn ${row.symbol} collected tax`,{requireCode:true});if(!sameSession(generation,actorId))return;
              if(!burnRequestId)burnRequestId=globalThis.crypto.randomUUID().replaceAll('-','');
              const result=await api('/api/admin/launches/action',{accountId:row.accountId,id:row.id,action:'burn-tax',reason:'Burn the collected transfer tax from the admin panel.',requestId:burnRequestId,...credentials});
              if(!sameSession(generation,actorId))return;
              if(!['queued','already_requested'].includes(result?.status)||result.requestId!==burnRequestId)throw Error('The burn request could not be verified. Refresh to check this coin.');
              message(result.message||'Burn request saved.');burnRequestId='';await load(offset,{afterMutation:true});
            }catch(error){if(sameSession(generation,actorId)&&error.message!=='Cancelled.'){feedback.textContent=error.message||'The burn could not be requested. Try again.';feedback.classList.add('negative');}}
            finally{if(busy===request){busy=false;burn.disabled=false;setNavigation();}}
          };
        }
        const maintenance=row.taxMaintenance,taxRetry=maintenance?.retry;
        if(typeof taxRetry?.reason==='string'&&taxRetry.reason)section.append(el('p','Tax retry reason: '+taxRetry.reason.slice(0,300),'help launch-admin-tax-retry'));
        const nextTax=taxRetry?.at||maintenance?.nextAt;
        if(automation?.enabled===true&&row.state==='live'&&taxBurn.enabled===true&&!taxBurn.paused&&Number.isSafeInteger(nextTax)&&nextTax>0&&nextTax<=8640000000000000){
          section.append(el('p',nextTax>Date.now()?`Next automatic tax check: ${new Date(nextTax).toLocaleString()}.`:'Automatic tax check is due; any saved transaction is checked first.','help launch-admin-tax-next'));
        }
        if(validAddress(row.mint)){
          const taxBalance=el('p','Uncollected tax has not been checked. It is separate from collected tax awaiting burn.','help launch-admin-uncollected-tax'),check=el('button','Check uncollected tax','text-button');
          taxBalance.setAttribute('role','status');check.type='button';check.dataset.adminTaxCheck='true';let checking=false;
          check.onclick=async()=>{
            if(checking||busy||loading||moderating.size||!permitted()||accountId!==getAccount()?.id)return;
            checking=true;check.dataset.checking='true';check.disabled=true;check.textContent='Checking tax…';const generation=revision,actorId=accountId;
            try{
              const data=await api('/api/explore/rewards?mint='+encodeURIComponent(row.mint));if(!sameSession(generation,actorId))return;
              if(data?.mint!==row.mint||data.mode!=='holders'||data.quote?.mint!==row.quoteMint||data.taxBurn?.selected!==true)throw Error('The tax response did not match this coin.');
              const tax=data.holder,at=tax?.withheldAsOf,dated=Number.isSafeInteger(at)&&at>0&&at<=Date.now()+30000,fresh=tax?.withheldStale===false&&dated&&Date.now()-at<=120000;
              taxBalance.textContent=validAmount(tax?.withheldTokens)?`${tax.withheldTokens} ${row.symbol} uncollected transfer tax · ${fresh?'estimate':'last observed estimate; balance delayed'}${dated?' · '+new Date(at).toLocaleString():''}. Separate from collected tax awaiting burn; balances may change during collection.`:'Uncollected transfer tax is currently unavailable. The collected amount above does not include tax still withheld at the mint or token accounts.';
            }catch(error){if(sameSession(generation,actorId))taxBalance.textContent='Uncollected transfer tax could not be checked. '+String(error.message||'Try again shortly.').slice(0,300);}
            finally{checking=false;check.dataset.checking='false';check.textContent='Check uncollected tax';if(sameSession(generation,actorId))setNavigation();}
          };
          section.append(taxBalance,check);
        }
      }
      const manual=row.manualHolderDistribution;
      if(manual){
        const phases={existing:'Waiting for the saved reward cycle or transaction to finish.',collect:'Collecting available reward fees and transfer tax.',convert:`Converting reward tokens into ${row.quoteSymbol||'the quote asset'}.`,payout:'Distributing available quote rewards.',distribute:'Distributing available quote rewards.'};
        const states={queued:'Sell-and-distribute request queued.',processing:'Sell-and-distribute request processing.',waiting:'Sell-and-distribute request waiting.',blocked:'Sell-and-distribute request needs attention.',completed:'Sell-and-distribute request finished.',partial:'Sell-and-distribute request partially completed; remaining balances stay reserved.',cancelled:'Sell-and-distribute request stopped.',no_funds:'No distributable reward balance was available.'};
        const progress=el('p',states[manual.state]||'Saved sell-and-distribute request.','help launch-admin-manual-distribution');progress.setAttribute('role','status');
        if(phases[manual.phase]&&['queued','processing','waiting','blocked'].includes(manual.state))progress.append(el('span',' '+phases[manual.phase]));
        if(typeof manual.remainingBase==='string'&&/^\d+(\.\d+)?$/.test(manual.remainingBase))progress.append(el('span',` ${manual.remainingBase} ${row.symbol} remains in this conversion request.`));
        if(typeof manual.distributedQuote==='string'&&/^\d+(\.\d+)?$/.test(manual.distributedQuote))progress.append(el('span',` ${manual.distributedQuote} ${row.quoteSymbol||'quote tokens'} paid.`));
        if(typeof manual.remainingQuote==='string'&&/^\d+(\.\d+)?$/.test(manual.remainingQuote))progress.append(el('span',` ${manual.remainingQuote} ${row.quoteSymbol||'quote tokens'} still reserved.`));
        if(typeof manual.reason==='string'&&manual.reason)progress.append(el('span',' '+manual.reason.slice(0,300)));section.append(progress);
      }
      const editor=el('form'),label=el('label','Reason for manual action'),reason=el('input');reason.required=true;reason.minLength=5;reason.maxLength=500;reason.placeholder='Explain why you are running this manually';reason.autocomplete='off';label.append(reason);
      const run=el('button',action.kind==='distribute'?'Distribute now':'Buy back & burn','small-button admin-danger');run.type='submit';run.disabled=!action.allowed;let requestId='';editor.append(label,el('p',action.reason||(action.kind==='distribute'?taxBurn?(taxBurn.manual===true?'Distribute earned SOL, including below $100. Collected tax is not touched; use Burn collected tax now for it. Existing payout obligations and gas reserves remain protected.':'Check collected-tax burns and distribute earned SOL, including below $100. Existing payout obligations and gas reserves remain protected.'):`Collect available reward fees and tax, sell all eligible reward tokens into ${row.quoteSymbol||'the quote asset'} in successive clips without the automatic five-minute wait, then distribute available rewards at any amount. Liquidity, slippage and gas checks still apply; unpayable dust remains reserved. Existing transactions finish first. Automatic reward settings stay unchanged.`:'Claims available fees and runs buyback and burn, including below the automatic $1 minimum. Earned-credit, slippage and network-cost limits still apply.'),'help'),run);section.append(editor);
      editor.onsubmit=async event=>{event.preventDefault();if(busy||moderating.size||!permitted()||accountId!==getAccount().id||!action.allowed)return;const explanation=reason.value.trim();if(explanation.length<5){message('Enter a reason of at least five characters.',true);return;}const request={};busy=request;run.disabled=true;setNavigation();const generation=revision,actorId=getAccount().id;
        try{const credentials=await security.authorize(action.kind==='distribute'?`Distribute ${row.symbol} holder rewards`:`Run ${row.symbol} buyback and burn`,{requireCode:true});if(!sameSession(generation,actorId))return;if(!requestId)requestId=globalThis.crypto.randomUUID().replaceAll('-','');const result=await api('/api/admin/launches/action',{accountId:row.accountId,id:row.id,action:action.kind,reason:explanation,requestId,...credentials});if(!sameSession(generation,actorId))return;message(result.message||(action.kind==='distribute'?'Sell-and-distribute request saved. Pending transactions finish first.':'Manual action queued. The service will process it under its existing limits.'));requestId='';await load(offset,{afterMutation:true});}
        catch(error){if(sameSession(generation,actorId)&&error.message!=='Cancelled.')message(error.message,true);}finally{if(busy===request){busy=false;run.disabled=!action.allowed;setNavigation();}}
      };
      if(row.rewardHistory?.length){const history=el('details'),events=el('ol','','launch-admin-history');history.append(el('summary','Manual action history'));for(const event of row.rewardHistory){const entry=el('li');entry.append(el('p',`${new Date(event.at).toLocaleString()} · ${event.actor} · ${event.action==='distribute'?'Holder distribution':event.action==='resume-rewards'?'Rewards resumed':event.action==='pause-rewards'?'Rewards paused':event.action==='burn-tax'?'Tax burn':'Buyback'} · ${event.status}`,'help'),el('p',event.reason,'help'));events.append(entry);}history.append(events);section.append(history);}item.append(section);
    }
    if (row.history?.length) {
      const history = el('details'), summary = el('summary', 'Recipient history'), events = el('ol', '', 'launch-admin-history');
      for (const event of row.history) {
        const entry = el('li'); entry.append(el('p', `${new Date(event.at).toLocaleString()} · ${event.actor}`, 'help'), el('p', `${event.from || modes[event.fromMode] || 'Previous recipient'} → ${event.to}`, 'account-address'), el('p', event.reason, 'help')); events.append(entry);
      }
      history.append(summary, events); item.append(history);
    }
    return item;
  }
  function setNavigation() {
    const blocked = loading || busy || moderating.size > 0;
    sweepAll.disabled=blocked||sweepActive();sweepAll.textContent=sweepActive()?'Selling & distributing…':sweepRequestId?'Retry sell & distribute':'Sell & distribute all rewards';
    distributeAll.disabled=blocked||distributionActive();distributeAll.textContent=distributionActive()?'Distributing SOL…':distributionRequestId?'Retry distribute all':'Distribute SOL rewards';
    archiveFailed.disabled=blocked||!!archiveRequestId;archiveConfirm.disabled=blocked||!(archivePreview?.eligibleCount>0||archiveRequestId);archiveConfirm.textContent=archiveRequestId?'Retry saved archive request':archivePreview?.eligibleCount>0?`Archive ${archivePreview.eligibleCount} failed requests`:'Archive failed requests';archiveCancel.disabled=blocked||!!archiveRequestId;
    refresh.disabled = find.disabled = activeTab.disabled = archivedTab.disabled = blocked;
    prev.disabled = blocked || offset === 0; next.disabled = blocked || nextOffset === null;
    for (const button of list.querySelectorAll('[data-admin-list-action]')) button.disabled = blocked;
    for (const button of list.querySelectorAll('[data-admin-reward-resume]')) button.disabled = blocked || button.dataset.resumeAllowed !== 'true';
    for (const button of list.querySelectorAll('[data-admin-reward-pause]')) button.disabled = blocked || button.dataset.pauseAllowed !== 'true';
    for (const button of list.querySelectorAll('[data-admin-tax-check]')) button.disabled = blocked || button.dataset.checking === 'true';
    for (const [button, target, label] of [[activeTab, 'active', 'Active coins'], [archivedTab, 'archived', 'Archived tokens']]) { button.textContent = `${label} (${counts[target]})`; button.setAttribute('aria-selected', String(view === target)); }
    list.setAttribute('aria-label', view === 'archived' ? 'Archived tokens' : 'Active coins');
  }
  async function load(start = 0, { afterMutation = false } = {}) {
    if (!syncSession()) return;
    if (moderating.size || (busy && !afterMutation)) return;
    element.hidden = false; const generation = ++revision, actorId = accountId, requestedView = view;
    const expanded=new Set([...list.querySelectorAll('.launch-admin-row[open]')].map(item=>item.dataset.launchKey));
    loading = true; setNavigation(); status.textContent = 'Loading launches…';
    try {
      const params = new URLSearchParams({ search: search.value.trim(), offset: String(start), limit: '10', view: requestedView });
      const data = await api('/api/admin/launches?' + params);
      if (!sameSession(generation, actorId)) return;
      if (data.view && data.view !== requestedView) throw Error('The launch list changed. Refresh to try again.');
      if (!data.launches.length && start > 0) { loading = false; return load(Math.max(0, Math.floor((data.total - 1) / 10) * 10), { afterMutation }); }
      offset = data.offset; nextOffset = data.nextOffset;
      for (const target of ['active', 'archived']) if (Number.isSafeInteger(data.counts?.[target]) && data.counts[target] >= 0) counts[target] = data.counts[target];
      list.replaceChildren(...data.launches.map(row=>{const item=render(row);if(expanded.has(item.dataset.launchKey))item.setAttribute('open','');return item;})); list.scrollTop = 0;
      status.textContent = data.total ? `${offset + 1}–${offset + data.launches.length} of ${data.total} ${requestedView === 'archived' ? 'archived tokens' : 'launches'}` : search.value.trim() ? 'No launches match your search.' : requestedView === 'archived' ? 'No archived tokens.' : 'No active coins.';
    } catch (error) { if (sameSession(generation, actorId)) { status.textContent = 'Launches could not be loaded.'; message(error.message, true); } }
    finally { if (sameSession(generation, actorId)) { loading = false; setNavigation(); scheduleDistributions({refresh:true}); scheduleRewardSweeps({refresh:true}); } }
  }
  function selectView(target) { if (loading || busy || moderating.size) return; view = target; offset = 0; nextOffset = null; return load(0); }
  activeTab.onclick = () => selectView('active'); archivedTab.onclick = () => selectView('archived');
  refresh.onclick = () => load(offset); form.onsubmit = event => { event.preventDefault(); return load(0); }; prev.onclick = () => load(Math.max(0, offset - 10)); next.onclick = () => { if (nextOffset !== null) return load(nextOffset); };
  // Refresh section reloads the page of coins being viewed instead of returning to the first page.
  const reload = () => load(offset);
  // Jump to one coin (the admin palette): search for it in the list it belongs to and open its row.
  async function findCoin(query, { row = null } = {}) {
    if (!syncSession() || loading || busy || moderating.size) return;
    search.value = String(query || '').slice(0, 128); view = row && (row.listArchived || row.hidden || row.manuallyArchived) ? 'archived' : 'active'; offset = 0; nextOffset = null;
    await load(0);
    const key = row ? (row.route && row.route !== 'raydium' ? row.route + ':' : '') + String(row.accountId) + ':' + String(row.id) : '';
    const item = (key && list.querySelector(`[data-launch-key="${key.replace(/"/g, '')}"]`)) || list.querySelector('.launch-admin-row');
    if (item) { item.open = true; item.scrollIntoView?.({ block: 'center' }); item.querySelector('summary')?.focus?.(); }
  }
  clear(); return { element, load, reload, clear, find: findCoin, refreshDistributions, refreshRewardSweeps };
}
