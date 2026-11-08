import {getLaunchpadWallet} from './launchpad-wallet.mjs';

const OPERATOR='7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS';
const DEFAULT_BASE='/api/admin/pump-test/deployment';
const sol=value=>{
  if(!/^(0|[1-9][0-9]{0,19})$/.test(String(value??'')))return 'Unavailable';
  const n=BigInt(value),fraction=(n%1000000000n).toString().padStart(9,'0').replace(/0+$/,'');
  return `${n/1000000000n}${fraction?'.'+fraction:''} SOL`;
};
export function createAdminPumpDeployment({document,api,getAccount,isActive=()=>true,walletFactory=getLaunchpadWallet,setTimer=setTimeout,clearTimer=clearTimeout,base=DEFAULT_BASE,publicMode=false,presentation={}}){
  const BASE=base;
  const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const element=el('section',undefined,'admin-card admin-pump-deployment');element.id=presentation.id||(publicMode?'admin-pump-public-deployment':'admin-pump-deployment');
  element.append(el('p',presentation.eyebrow||(publicMode?'PUMPSWAP / ONE-TIME SETUP':'PRIVATE / ONE-TIME SETUP'),'eyebrow'),el('h2',presentation.title||(publicMode?'Deploy public launch contract':'Set up the funded test')),el('p',presentation.intro||(publicMode?'Deploy the public launch contract using your wallet. Each upload batch needs your approval. Public launches stay off until activation.':'Deploy the private test contract using your wallet. The upload is split into batches; each batch needs your approval.'),'admin-muted'));
  const identity=el('p',`${publicMode?'Deployment':'Test'} wallet: ${OPERATOR}`,'admin-muted');identity.style.overflowWrap='anywhere';
  const walletRow=el('div',undefined,'admin-pump-test-actions'),walletSelect=el('select'),connect=el('button',publicMode?'Connect deployment wallet':'Connect test wallet','small-button'),walletHint=el('p','No Solana wallet app was found in this browser. Install or unlock one (for example Phantom or Solflare) to connect.','admin-wallet-hint');walletSelect.setAttribute('aria-label',publicMode?'Wallet app for public deployment':'Wallet app for private test');connect.type='button';walletHint.hidden=true;walletRow.append(walletSelect,walletHint,connect);
  const connected=el('p','','admin-muted'),status=el('p','','admin-muted');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const metrics=el('div',undefined,'admin-pump-test-metrics'),actions=el('div',undefined,'admin-pump-test-actions');
  const refresh=el('button','Refresh progress','text-button'),prepare=el('button','Review next setup step','small-button');refresh.type=prepare.type='button';actions.append(refresh,prepare);
  const review=el('div',undefined,'admin-pump-deployment-review'),amount=el('p'),description=el('p','','admin-muted'),approve=el('button','Approve in wallet','small-button'),cancel=el('button','Cancel review','text-button');approve.type=cancel.type='button';review.append(amount,description,approve,cancel);review.hidden=true;
  element.append(identity,walletRow,connected,status,metrics,actions,review);
  const wallet=walletFactory({window:document.defaultView});let disposed=false,revision=0,owner='',data=null,plan=null,busy=false,timer=null;
  const accountId=()=>String(getAccount()?.id||'');
  const permitted=()=>{const a=getAccount();return !disposed&&!!accountId()&&a?.role==='admin'&&a?.mfaEnabled===true&&!a?.banned;};
  const current=(generation,id)=>permitted()&&isActive()&&generation===revision&&id===accountId();
  const pending=()=>!!data?.pendingBatch&&data.pendingBatch.state!=='prepared';
  const canPrepare=()=>!!data&&!pending()&&!done()&&(data.canPrepare!==false||data.pendingBatch?.state==='prepared');
  const done=()=>!!data?.verifiedDeployment;
  function message(text,negative=false){status.textContent=text;status.classList.toggle('negative',negative);}
  function controls(){
    const state=wallet.state();connected.textContent=state.address?`${state.name||'Wallet'} · ${state.address}`:publicMode?'Connect the deployment wallet while keeping your admin sign-in.':'Connect the test wallet while keeping your current admin sign-in.';connected.style.overflowWrap='anywhere';
    const selected=walletSelect.value;walletSelect.replaceChildren(...state.wallets.map(w=>{const o=el('option',w.name);o.value=w.id;return o;}));if(state.wallets.some(w=>w.id===selected))walletSelect.value=selected;
    connect.disabled=busy||!state.wallets.length;walletSelect.disabled=busy;walletSelect.hidden=!state.wallets.length;walletHint.hidden=!!state.wallets.length;
    refresh.disabled=busy;prepare.disabled=busy||!canPrepare()||state.address!==OPERATOR;
    approve.disabled=busy||!plan||state.address!==OPERATOR||(plan.pendingSignatures?.length>1&&state.batchSigning===false);cancel.disabled=busy;
    element.setAttribute('aria-busy',String(busy));
  }
  function dropPlan(){plan=null;review.hidden=true;amount.textContent='';description.textContent='';}
  function stopTimer(){if(timer!==null)clearTimer(timer);timer=null;}
  function clear(){revision++;stopTimer();owner='';data=null;busy=false;dropPlan();metrics.replaceChildren();message('');element.hidden=true;controls();}
  function pause(){revision++;stopTimer();busy=false;dropPlan();controls();}
  function render(next){
    data=next;metrics.replaceChildren();
    for(const [label,value] of [['Upload progress',`${next.uploadedChunks||0} / ${next.totalChunks||0} chunks`],['Estimated program rent',sol(next.estimatedRentLamports)]]){const card=el('div');card.append(el('span',label),el('strong',value));metrics.append(card);}
    if(next.programId){const line=el('p',`Program: ${next.programId}`,'admin-muted');line.style.overflowWrap='anywhere';metrics.append(line);}
    if(done())message(presentation.verified||(publicMode?'Contract verified. Complete custody configuration and activation below.':'Contract verified. Open Launch on Launchpad → PumpSwap for the funded micro test.'));
    else if(pending())message('A submitted batch is being checked. No new wallet approval will be requested automatically.');
    else message('Review the next setup step to see its SOL budget before approving.');
    controls();
  }
  function schedule(){stopTimer();if(permitted()&&isActive()&&pending())timer=setTimer(()=>{timer=null;void load();},6000);}
  async function load(){
    if(!permitted()){clear();return;}if(owner&&owner!==accountId())clear();if(!isActive()||document.hidden||busy)return;
    const generation=revision,id=accountId();owner=id;element.hidden=false;busy=true;controls();
    try{
      const next=await api(pending()?BASE+'/reconcile':BASE+'/status',pending()?{}:undefined);
      if(!current(generation,id))return;
      const snapshot=next?.status||next;
      if(snapshot?.operator!==OPERATOR||typeof snapshot.stage!=='string')throw Error('The owner deployment setup is not available in this build.');
      render(snapshot);
    }catch(error){if(current(generation,id)){data=null;dropPlan();message(error?.message||'Could not check the private setup.',true);}}
    finally{if(generation===revision){busy=false;controls();schedule();}}
  }
  connect.onclick=async()=>{
    if(!permitted()||!isActive()||busy)return;const generation=revision,id=accountId();busy=true;controls();
    try{await wallet.connect(walletSelect.value);if(current(generation,id)){dropPlan();if(wallet.state().address!==OPERATOR)message('Select the configured BMBe…KARi account in your wallet app.',true);}}
    catch(error){if(current(generation,id))message(error.message,true);}
    finally{if(generation===revision){busy=false;controls();}}
  };
  prepare.onclick=async()=>{
    if(!permitted()||!isActive()||busy||!canPrepare()||wallet.state().address!==OPERATOR)return;
    const generation=revision,id=accountId();busy=true;dropPlan();stopTimer();controls();
    try{
      const next=await api(BASE+'/prepare',{});if(!current(generation,id))return;
      if(typeof next?.planId!=='string'||!Array.isArray(next.pendingSignatures)||next.pendingSignatures.length<1||next.pendingSignatures.length>25||next.pendingSignatures.some(p=>p?.wallet!==OPERATOR||typeof p.transaction!=='string')||sol(next.maxWalletDebitLamports)==='Unavailable')throw Error('The setup review is incomplete. Refresh progress.');
      plan=next;review.hidden=false;amount.textContent=`Maximum wallet debit for this step: ${sol(next.maxWalletDebitLamports)}`;
      description.textContent=`${next.pendingSignatures.length} transaction${next.pendingSignatures.length===1?'':'s'} · Network fees ${sol(next.totalNetworkFeeLamports)}. This is contract setup; it does not buy a token or burn liquidity.`;
      approve.textContent=`Approve ${next.pendingSignatures.length===1?'setup transaction':next.pendingSignatures.length+' setup transactions'}`;
      message('Review the amount, then approve this step in your wallet.');
    }catch(error){if(current(generation,id))message(error.message,true);}
    finally{if(generation===revision){busy=false;controls();}}
  };
  approve.onclick=async()=>{
    if(!permitted()||!isActive()||busy||!plan||wallet.state().address!==OPERATOR)return;
    const generation=revision,id=accountId(),reviewed=plan;busy=true;controls();
    try{
      const signedTransactions=await wallet.signBatch(reviewed.pendingSignatures);
      if(!current(generation,id)||wallet.state().address!==OPERATOR||plan!==reviewed)return;
      message('Wallet approved. Submitting this reviewed setup step…');
      await api(BASE+'/submit',{planId:reviewed.planId,signedTransactions});
      if(!current(generation,id))return;dropPlan();
      const next=await api(BASE+'/status');
      if(!current(generation,id))return;
      if(next?.operator!==OPERATOR||typeof next.stage!=='string')throw Error('Could not refresh setup progress.');
      render(next);
    }catch(error){if(current(generation,id)){dropPlan();data={...data,pendingBatch:true};message(`${error.message||'Setup interrupted.'} Refresh progress before another approval.`,true);}}
    finally{if(generation===revision){busy=false;controls();schedule();}}
  };
  cancel.onclick=()=>{if(!busy){dropPlan();message('Review cancelled. Nothing was submitted by this action.');controls();}};
  refresh.onclick=load;
  let walletIdentity=wallet.state().address+'|'+wallet.state().name;
  const unsubscribe=wallet.onChange(()=>{const next=wallet.state().address+'|'+wallet.state().name;if(next!==walletIdentity){walletIdentity=next;dropPlan();}controls();});
  const updated=()=>{if(!permitted()||owner&&owner!==accountId())clear();};document.addEventListener('curve-account-updated',updated);
  clear();
  return{element,load,clear,pause,destroy(){clear();disposed=true;unsubscribe();document.removeEventListener('curve-account-updated',updated);}};
}
