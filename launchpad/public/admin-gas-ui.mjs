import { revenueAmount } from './admin-revenue-ui.mjs';

const POLL_MS=30000;
const SETUP_COMMAND='sudo systemd-run --pty --wait --collect --uid=launchpad --property=WorkingDirectory=/opt/launchpad/app --property=EnvironmentFile=/etc/launchpad.env --property=UMask=0077 --property=LimitCORE=0 /usr/bin/node /opt/launchpad/app/scripts/setup-gas-wallet.mjs';
const address=value=>typeof value==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
const signature=value=>typeof value==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value);
const units=value=>typeof value==='string'&&/^(0|[1-9][0-9]{0,79})$/.test(value);
const amount=value=>units(value)?revenueAmount(value,9)+' SOL':'—';
const at=value=>typeof value==='number'&&Number.isFinite(value)&&value>0?value:null;
const roleLabels={fees:'Fee collection',protocol:'Protocol fees',platform:'Platform operations',rewards:'Holder rewards',holders:'Holder rewards',creator:'Creator payouts',buyback:'Legacy buybacks',fee:'Fee collection',tax:'Tax conversion',meteora:'Meteora operations'};
const stateLabels={daily_limit:'Daily limit reached',low_source:'Funding wallet needs SOL',refill_pending:'Refill pending',waiting:'Awaiting a service check',ready:'Ready',funded:'Funded',healthy:'Funded',low:'Low gas',eligible:'Eligible',cooldown:'Waiting for cooldown',pending:'Refill pending',unavailable:'Balance unavailable',error:'Awaiting another check',unknown:'Not checked',skipped:'Not eligible',principal_shortfall:'Reward balance needs review'};

export function createAdminGasFunding({document,api,security,message=()=>{},getAccount,isActive=()=>true,clock=Date.now,setTimer=setInterval,clearTimer=clearInterval,copyText=text=>document.defaultView.navigator.clipboard.writeText(text)}={}){
  const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=String(text);if(cls)node.className=cls;return node;};
  const element=el('section',null,'admin-card admin-gas-funding');element.id='admin-gas-funding';const more=(...nodes)=>{const box=el('details',null,'admin-more');box.append(el('summary','More info'),...nodes);return box;};
  const heading=el('div',null,'admin-card-heading'),copy=el('div'),refresh=el('button','Refresh','text-button');refresh.id='admin-gas-refresh';refresh.type='button';
  copy.append(el('p','PROTOCOL / NETWORK FEES','eyebrow'),el('h2','Automatic gas refills'),el('p','Keep verified protocol wallets funded for network fees using a separate SOL wallet.'));heading.append(copy,refresh);
  const status=el('p','','admin-revenue-status');status.id='admin-gas-status';status.setAttribute('role','status');
  const wallet=el('div',null,'admin-gas-wallet'),facts=el('div',null,'admin-gas-facts'),policy=el('p','','help'),warning=el('p','','admin-gas-warning');warning.id='admin-gas-warning';warning.hidden=true;warning.setAttribute('role','status');
  const setup=el('details',null,'admin-protocol-gas admin-treasury-setup');setup.id='admin-gas-setup';setup.hidden=true;
  const command=el('pre',null,'admin-treasury-setup-command'),code=el('code',SETUP_COMMAND),copyButton=el('button','Copy VPS command','small-button'),copyStatus=el('p','','help');command.id='admin-gas-setup-command';command.tabIndex=0;command.append(code);copyButton.type='button';copyButton.id='admin-gas-setup-copy';copyStatus.setAttribute('role','status');
  setup.append(el('summary','Set up your gas funding wallet'),el('p','Create and back up a dedicated Solana wallet, separate from your buyback treasury. Run this command in your connected VPS terminal:','help'),command,copyButton,copyStatus,el('p','Follow the private terminal prompts. Paste the private key only into the masked terminal prompt, never into this website or chat. Setup leaves refills off. Refresh this panel, verify the address, deposit SOL for gas, then enable refills.','help'));
  const form=el('form',null,'admin-protocol-form');form.id='admin-gas-configure';
  const reasonLabel=el('label','Reason for update','admin-protocol-wide'),reason=el('input');reason.id='admin-gas-reason';reason.required=true;reason.minLength=5;reason.maxLength=500;reason.placeholder='Record why gas refills are changing';reasonLabel.append(reason);
  const ackLabel=el('label',null,'check admin-protocol-wide'),ack=el('input');ack.id='admin-gas-ack';ack.type='checkbox';ackLabel.append(ack,el('span','I verified this wallet and authorize its deposited SOL to refill only verified, managed protocol wallets under these limits.'));
  const toggle=el('button','Enable gas refills','small-button');toggle.id='admin-gas-toggle';toggle.type='submit';const actionNote=el('p','','help admin-protocol-wide');form.append(reasonLabel,ackLabel,actionNote,toggle);
  const details=el('details',null,'admin-protocol-gas admin-gas-activity');details.id='admin-gas-activity';const summary=el('summary','Wallets and refill activity'),targets=el('div',null,'admin-gas-targets'),pending=el('div',null,'admin-gas-pending'),history=el('ul',null,'admin-protocol-history');targets.id='admin-gas-targets';pending.id='admin-gas-pending';history.id='admin-gas-history';details.append(summary,targets,pending,el('h3','Recent refills'),history);
  element.append(heading,status,wallet,warning,facts,more(policy),setup,form,details);
  let snapshot=null,revision=0,disposed=false,loading=false,busy=false,active=false,timer=null,viewOwner=null,reviewedAddress=null,readFailed=false,loadedAt=0;
  const accountIdentity=()=>getAccount()?.id??getAccount();
  const permitted=()=>!disposed&&getAccount()?.role==='admin'&&getAccount()?.mfaEnabled===true;
  const permittedAt=(generation,owner)=>permitted()&&revision===generation&&accountIdentity()===owner;
  function link(kind,value,label){const node=el(kind==='tx'?signature(value)?'a':'span':address(value)?'a':'span',label||value);if(node.tagName==='A'){node.href='https://solscan.io/'+kind+'/'+value;node.target='_blank';node.rel='noopener noreferrer';}return node;}
  // A long address in a list keeps its full text and gives way in the middle when space runs out.
  function shortened(node,value){if(typeof value==='string'&&value.length>12&&node.textContent===value){node.replaceChildren(el('span',value.slice(0,-6)),el('span',value.slice(-6)));node.classList.add('admin-address');node.setAttribute('title',value);}return node;}
  function stop(){if(timer!==null){clearTimer(timer);timer=null;}}
  function schedule(){stop();if(active&&permitted()&&isActive()&&!document.hidden&&!busy)timer=setTimer(()=>{if(permitted()&&isActive()&&!document.hidden)void load();else stop();},POLL_MS);}
  function controls(){
    const ready=snapshot?.configured===true&&address(snapshot.address),enable=snapshot?.enabled!==true,disabled=!permitted()||!snapshot||loading||busy;
    refresh.disabled=!permitted()||loading||busy;reason.disabled=disabled;ack.disabled=disabled||!ready;ackLabel.hidden=!enable;ack.required=enable;
    toggle.disabled=disabled||!ready||(enable&&readFailed);toggle.textContent=enable?'Enable gas refills':'Pause gas refills';
    setup.hidden=!permitted()||!snapshot||snapshot.configured!==false||address(snapshot.address);if(setup.hidden){setup.open=false;copyStatus.textContent='';}
    actionNote.textContent=snapshot?.enabled?'Pause stops new refills. Already submitted transactions are still checked before another can be prepared.':'Refills use only SOL deposited into this dedicated gas wallet. The protocol treasury and its 50% LAUNCHPAD buyback allocation are unchanged.';
  }
  function clear(){revision++;stop();snapshot=null;viewOwner=null;reviewedAddress=null;loadedAt=0;loading=false;busy=false;active=false;readFailed=false;element.hidden=true;status.textContent='';wallet.replaceChildren();facts.replaceChildren();targets.replaceChildren();pending.replaceChildren();history.replaceChildren();policy.textContent='';warning.textContent='';warning.hidden=true;reason.value='';ack.checked=false;details.open=setup.open=false;copyStatus.textContent='';controls();}
  function render(data){
    if(!data||data.version!==1||typeof data.configured!=='boolean'||typeof data.enabled!=='boolean')throw Error('Gas funding snapshot unavailable.');
    if(reviewedAddress!==data.address){ack.checked=false;reviewedAddress=data.address;}snapshot=data;readFailed=false;loadedAt=clock();element.hidden=false;
    const ready=data.configured&&address(data.address),balanceAt=at(data.balanceAt),fresh=balanceAt!==null&&balanceAt<=clock()&&clock()-balanceAt<=120000&&units(data.balanceLamports);
    status.textContent=ready?(data.enabled?'Gas refills enabled.':'Gas refills paused.'):'Set up a gas funding wallet to enable refills.';
    if(data.pending)status.textContent+=' Checking a saved refill before preparing another.';
    if(data.error)status.textContent+=' A service check will retry automatically.';
    wallet.replaceChildren();if(ready){wallet.append(el('span','Gas funding wallet','admin-muted'),link('account',data.address,data.address),el('p','Deposit SOL here for refills. This wallet is separate from the buyback treasury.','help'));}
    const entries=[['Gas funding balance',fresh?amount(data.balanceLamports):'—'],[data.day?.date===new Date(clock()).toISOString().slice(0,10)?'Refilled today':'Last recorded day',amount(data.day?.spentLamports)],['Daily cap',amount(data.policy?.dailyLimitLamports)],['Total refilled',amount(data.totals?.refilledLamports)]];
    facts.replaceChildren(...entries.map(([label,value])=>{const item=el('div',null,'admin-stat');item.append(el('span',label),el('strong',value));return item;}));
    if(ready&&!fresh)status.textContent+=' Funding balance is awaiting a fresh check.';
    warning.hidden=!(ready&&fresh&&data.lowBalance===true);warning.textContent=warning.hidden?'':'Gas funding is low. Deposit SOL into the gas funding wallet above so refills can continue.';
    const p=data.policy||{};policy.textContent='Refill below '+amount(p.lowWaterLamports)+' toward '+amount(p.targetLamports)+'. Reward wallet preparation can request an earlier refill under the same limits. Maximum '+amount(p.maxRefillLamports)+' per refill and '+amount(p.dailyLimitLamports)+' in refills per UTC day. Network costs have a separate '+amount(p.dailyNetworkLimitLamports)+' daily cap. At least one hour between refills to the same wallet; '+amount(p.reserveLamports)+' stays in the funding wallet.';
    const rows=Array.isArray(data.targets)?data.targets.filter(row=>address(row?.address)):[];
    summary.textContent='Wallets and refill activity · '+rows.length.toLocaleString()+' verified wallets';targets.replaceChildren();
    for(const row of rows.slice(0,100)){const item=el('div',null,'admin-gas-target'),roles=Array.isArray(row.roles)?[...new Set(row.roles.map(role=>roleLabels[role]).filter(Boolean))].join(', '):'';
      const checked=at(row.checkedAt),current=checked!==null&&checked<=clock()&&clock()-checked<=120000&&units(row.balanceLamports);
      item.append(shortened(link('account',row.address,row.address),row.address),el('span',[roles||'Managed protocol wallet',stateLabels[row.status]||'Awaiting a service check',current?amount(row.balanceLamports):'Balance awaiting check'].join(' · '),'help'));
      if(current&&units(row.requiredBalanceLamports))item.append(el('span','Reward wallet operations need a balance of '+amount(row.requiredBalanceLamports)+'.','help'));
      if(row.status==='principal_shortfall')item.append(el('span','Gas refills cannot replace missing reward funds. Review this wallet’s recorded reward balance.','help'));
      targets.append(item);}
    if(!rows.length)targets.append(el('p','Verified wallets appear after the service checks eligible launches.','help'));else if(rows.length>100)targets.append(el('p','Showing the first 100 verified wallets.','help'));
    pending.replaceChildren();if(data.pending){pending.append(el('h3','Pending refill'),el('p','Checking '+amount(data.pending.inputAmount)+' before preparing another refill.','help'));if(address(data.pending.recipient))pending.append(shortened(link('account',data.pending.recipient,data.pending.recipient),data.pending.recipient));if(signature(data.pending.signature))pending.append(link('tx',data.pending.signature,'View transaction ↗'));}
    history.replaceChildren();for(const row of (Array.isArray(data.history)?data.history:[]).slice(0,20)){const item=el('li');item.append(el('span',(row.state==='confirmed'?'Confirmed':['failed','expired'].includes(row.state)?'Not completed':'Checking')+' · '+amount(row.amountLamports)));if(signature(row.signature))item.append(link('tx',row.signature,'View transaction ↗'));history.append(item);}if(!history.children.length)history.append(el('li','Confirmed refills will appear here.','help'));
    controls();
  }
  async function load(){
    if(!permitted()){clear();return;}if(!isActive()){stop();return;}const owner=accountIdentity();if(viewOwner!==null&&viewOwner!==owner)clear();viewOwner=owner;active=true;
    if(document.hidden){schedule();return;}if(loading||busy)return;loading=true;element.hidden=false;controls();const generation=revision;if(!snapshot)status.textContent='Loading gas funding status…';
    try{const data=await api('/api/admin/protocol-gas-funding');if(permittedAt(generation,owner))render(data);}
    catch{if(permittedAt(generation,owner)){readFailed=true;status.textContent=snapshot?'Gas status could not be refreshed. Showing the last saved status.':'Gas funding status is temporarily unavailable. Use Refresh to try again.';}}
    finally{if(generation===revision){if(!permittedAt(generation,owner)){clear();return;}loading=false;controls();schedule();}}
  }
  form.onsubmit=async event=>{
    event.preventDefault();if(viewOwner!==accountIdentity()){clear();return;}if(toggle.disabled||!permitted()||element.hidden||!isActive())return;const explanation=reason.value.trim(),enabled=snapshot.enabled!==true;
    if(explanation.length<5||explanation.length>500){message('Enter a reason from 5 to 500 characters.',true);return;}if(enabled&&!ack.checked){message('Confirm the gas funding wallet and refill limits before enabling.',true);return;}
    const generation=revision,owner=accountIdentity(),expectedAddress=snapshot.address;busy=true;stop();controls();
    try{const credentials=await security.authorize(enabled?'Enable automatic protocol gas refills':'Pause automatic protocol gas refills',{requireCode:true});if(!permittedAt(generation,owner)||!isActive())return;const data=await api('/api/admin/protocol-gas-funding/configure',{enabled,expectedAddress,reason:explanation,...credentials});if(!permittedAt(generation,owner))return;render(data);reason.value='';ack.checked=false;message(data.enabled?'Automatic gas refills enabled.':'Automatic gas refills paused.');}
    catch(error){if(permittedAt(generation,owner)&&error?.message!=='Cancelled.'){if(error?.known)message(error.message,true);else{readFailed=true;message('The gas refill update could not be confirmed. Refresh status before trying again.',true);}}}
    finally{if(generation===revision){if(!permittedAt(generation,owner)){clear();return;}busy=false;controls();schedule();}}
  };
  copyButton.onclick=async()=>{if(!permitted()||setup.hidden)return;const generation=revision,owner=accountIdentity();try{await copyText(SETUP_COMMAND);if(permittedAt(generation,owner))copyStatus.textContent='Command copied. Paste it into your connected VPS terminal.';}catch{if(permittedAt(generation,owner))copyStatus.textContent='Select and copy the command above into your connected VPS terminal.';}};
  function pause(){active=false;stop();}
  // Opening the page again reuses a snapshot younger than one poll interval and only restarts polling.
  function show(){if(permitted()&&isActive()&&snapshot&&viewOwner===accountIdentity()&&clock()-loadedAt<POLL_MS){active=true;schedule();return;}return load();}
  function visibility(){if(document.hidden||!isActive()){stop();return;}if(active&&permitted())void load();}
  function destroy(){clear();disposed=true;document.removeEventListener('visibilitychange',visibility);}
  refresh.onclick=load;document.addEventListener('visibilitychange',visibility);clear();return{element,load,show,clear,pause,destroy};
}
