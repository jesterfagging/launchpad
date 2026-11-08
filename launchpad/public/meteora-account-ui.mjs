import {getLaunchpadWallet} from './launchpad-wallet.mjs';
import {createMeteoraOperation,meteoraUnits} from './meteora-ui.mjs';
const ADDRESS=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/,BASE58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',LIVE=['trading','bonded','migrated'];
const short=value=>typeof value==='string'?value.slice(0,6)+'…'+value.slice(-6):'Unavailable';
// A receiving wallet must decode to exactly 32 bytes; length and alphabet alone
// also accept an address that a paste or a typo cut short.
const validWallet=value=>{
  if(typeof value!=='string'||!ADDRESS.test(value))return false;
  const bytes=[];for(const char of value){let carry=BASE58.indexOf(char);for(let i=0;i<bytes.length;i++){carry+=bytes[i]*58;bytes[i]=carry&255;carry>>=8;}while(carry>0){bytes.push(carry&255);carry>>=8;}}
  for(let i=0;i<value.length&&value[i]==='1';i++)bytes.push(0);
  return bytes.length===32;
};
const live=row=>LIVE.includes(row?.status);
const recipientOf=row=>row?.creatorRecipient||row?.feeRedirect?.recipient;

/** Private per-account fee controls. Public attribution remains with the creator. */
export function createMeteoraAccountLaunches({document,window,root,api,clock=Date.now,walletFactory=getLaunchpadWallet,setTimer=setInterval,clearTimer=clearInterval}={}){
  if(document.head&&!document.getElementById('meteora-account-styles')){const style=document.createElement('link');style.id='meteora-account-styles';style.rel='stylesheet';style.href='/meteora-account.css?v=64';document.head.append(style);}
  const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
  let session=null,rows=[],filter='launched',disposed=false,busy=false,selected=null,generation=0,rerouting=false,connecting=false,wallet=null,unsubscribe=null,redirectRow=null;
  const title=el('h2','Your Meteora launches and fee assignments'),heading=el('div',null,'tokens-venue-heading'),headingCopy=el('div'),grid=el('div',null,'tokens-grid'),status=el('p','','help'),choices=el('div',null,'ct-wallet-options'),operationRoot=el('div');headingCopy.append(title,el('p','Meteora DBC · graduates to DAMM v2 with permanently locked liquidity'));heading.append(headingCopy);root.classList.add('tokens-venue-section');status.setAttribute('role','status');choices.hidden=true;root.replaceChildren(heading,grid,status,choices,operationRoot);root.hidden=true;
  // The one-time redirect is permanent: like the Raydium redirect it previews the
  // full address and needs an explicit confirmation before anything is sent.
  const dialog=el('dialog',null,'tokens-wallet-dialog tokens-fee-redirect-dialog'),redirectForm=el('form'),redirectHead=el('div',null,'tokens-wallet-heading'),redirectTitle=el('h2','Redirect creator fees'),redirectClose=el('button','×','small-button'),redirectCurrent=el('span','','fee-redirect-address'),currentLine=el('p','Current recipient '),redirectLabel=el('label','New receiving wallet'),redirectInput=el('input'),redirectPreview=el('output','','fee-redirect-address'),redirectConfirmLabel=el('label',null,'fee-redirect-confirm'),redirectConfirm=el('input'),redirectStatus=el('p'),redirectSubmit=el('button','Confirm one-time redirect','primary');
  dialog.id='meteora-fee-redirect-dialog';dialog.setAttribute('aria-labelledby','meteora-fee-redirect-title');redirectTitle.id='meteora-fee-redirect-title';redirectClose.type='button';redirectClose.setAttribute('aria-label','Close fee redirect');
  redirectInput.id='meteora-fee-redirect-address';redirectInput.type='text';redirectInput.autocomplete='off';redirectInput.setAttribute('autocapitalize','off');redirectInput.spellcheck=false;redirectInput.required=true;redirectInput.placeholder='Solana wallet address';redirectLabel.htmlFor=redirectInput.id;
  redirectPreview.setAttribute('aria-live','polite');redirectConfirm.type='checkbox';redirectConfirm.required=true;redirectStatus.setAttribute('role','status');redirectStatus.setAttribute('aria-live','polite');redirectSubmit.type='submit';
  currentLine.append(redirectCurrent);redirectConfirmLabel.append(redirectConfirm,el('span','I checked the full wallet address. I understand this is my one change, and the new recipient can claim fees but cannot change this address.'));redirectHead.append(redirectTitle,redirectClose);
  redirectForm.append(redirectHead,currentLine,redirectLabel,redirectInput,redirectPreview,el('p','You can change this recipient only once. Future creator fees go to this wallet. The coin stays on your public profile; its recipient can claim fees from their private Launched tokens page.'),redirectConfirmLabel,redirectStatus,redirectSubmit);dialog.append(redirectForm);(document.body||root).append(dialog);
  const showDialog=()=>{if(typeof dialog.showModal==='function'){if(!dialog.open)dialog.showModal();}else dialog.setAttribute('open','');};
  const hideDialog=()=>{if(typeof dialog.close==='function'){if(dialog.open)dialog.close();}else dialog.removeAttribute('open');};
  const identity=()=>session?.authenticated?(session.account?.id||session.account?.mainWallet||''):'';
  const binding=()=>[identity(),session?.token,selected?.mint,wallet?.state().address].join(':');
  const ensureWallet=()=>{if(!wallet){wallet=walletFactory({window});unsubscribe=wallet.onChange(()=>{generation++;operation.reset();choices.hidden=true;render();});}return wallet;};
  const walletProxy={state:()=>wallet?.state()||{address:null,wallets:[]},sign:input=>ensureWallet().sign(input)};
  const request=(path,body)=>api('/api/launchpad/meteora'+path,body);
  const operation=createMeteoraOperation({document,root:operationRoot,request,wallet:walletProxy,clock,setTimer,clearTimer,context:()=>({active:!disposed&&!!identity()&&!!selected,key:binding(),mint:selected?.mint,symbol:selected?.symbol,quoteMint:selected?.quoteMint,quoteSymbol:selected?.quoteSymbol,quoteDecimals:selected?.quoteDecimals,baseDecimals:selected?.baseDecimals??6}),onChange:()=>render(),onConfirmed:()=>load(),onFinalized:()=>load()});
  // The server accepts a redirect only from the original creator of a live creator-fee coin.
  const redirectable=row=>row?.feeRedirect?.canRedirect===true&&row.feeMode!=='agent'&&row.feeMode!=='gotchi'&&row.feeMode!=='holders'&&live(row);
  function render(){
    if(disposed)return;const visible=rows.filter(row=>(row.hidden||row.archived?'archived':LIVE.includes(row.status)?'launched':'drafts')===filter);
    root.hidden=!identity()||!visible.length&&!selected;grid.replaceChildren();
    for(const row of visible){
      const card=el('article',null,'token-card'),header=el('div',null,'token-card-heading'),avatar=el('div',(row.symbol||row.name||'M').slice(0,1).toUpperCase(),'token-avatar'),identity=el('div',null,'token-card-identity'),state=el('div',null,'token-card-state'),stateText=row.status==='migrated'?'Meteora DAMM v2 · permanently locked liquidity':row.status==='bonded'?'Graduation in progress':row.status==='trading'?'Meteora DBC':'Launch pending',chip=el('span',stateText,'token-status'+(['migrated','trading'].includes(row.status)?'':' pending'));avatar.setAttribute('aria-hidden','true');identity.append(el('h3',row.name||row.symbol||'Coin'),el('span','$'+(row.symbol||'TOKEN')));header.append(avatar,identity);state.append(chip);card.append(header,state);
      const pair=el('p','Paired with '+(row.quoteSymbol||'quote'),'help');card.append(pair);
      if(row.creatorId!==session?.account?.id)card.append(el('p','Fees assigned to your wallet. This coin remains on the original creator’s public profile.','help'));
      let open=null;
      if(row.feeMode==='gotchi'){
        card.append(el('p','Gotchi prize pot · the creator share of trading fees funds '+(row.gotchi?.theme||'the Gotchi')+'’s pot','help'));
        const data=row.creatorRewards,summary=el('dl',null,'creator-earnings-grid');for(const[label,value]of [['Contributed to the pot',data?.totalPaidRaw],['Collected awaiting payout',data?.pendingRaw]]){const item=el('div');item.append(el('dt',label),el('dd',meteoraUnits(value,row.quoteDecimals)+' '+(row.quoteSymbol||'')));summary.append(item);}card.append(summary);
        const race=el('a','Open the Gotchi race →','small-button');race.href='/gotchi?id='+encodeURIComponent(row.gotchi?.id||'');card.append(race);
      }else if(row.feeMode==='holders'){
        card.append(el('p','Holder rewards · funded by the creator share of trading fees','help'));
        const data=row.holderRewards,summary=el('dl',null,'creator-earnings-grid');
        for(const[label,value]of [['Distributed',data?.totalDistributedQuote],['Collecting',data?.pendingQuote]]){const item=el('div');item.append(el('dt',label),el('dd',value==null?'Unavailable':String(value)+' '+(row.quoteSymbol||'')));summary.append(item);}card.append(summary);
      }else if(row.feeMode==='agent'){
        // AI Agent coins: Launchpad routes the creator share to the agent's own wallets; there is nothing for the creator to claim or redirect.
        card.append(el('p','AI Agent · the creator share of trading fees funds this coin’s agent (30% operations / 70% treasury). Launchpad routes it automatically; there is nothing to claim.','help'));
        if(live(row)){open=el('a','Open the agent →','small-button token-card-open');open.href=typeof row.agent?.href==='string'&&/^\/coin\?mint=[1-9A-HJ-NP-Za-km-z]{32,44}#agent$/.test(row.agent.href)?row.agent.href:'/coin?mint='+encodeURIComponent(row.mint)+'#agent';}
      }else{
        const data=row.creatorRewards,summary=el('dl',null,'creator-earnings-grid');for(const[label,value]of [['Recorded creator earnings',data?.totalClaimedRaw],['Paid to recipients',data?.totalPaidRaw],['Collected awaiting payout',data?.pendingRaw]]){const item=el('div');item.append(el('dt',label),el('dd',meteoraUnits(value,row.quoteDecimals)+' '+(row.quoteSymbol||'')));summary.append(item);}card.append(summary);
        const recipient=recipientOf(row);card.append(el('p','Fee recipient: '+short(recipient),'help'));
        if(live(row)){const claim=el('button','Claim creator fees','small-button');claim.type='button';claim.disabled=busy||operation.busy||operation.pending||rerouting||!ADDRESS.test(recipient||'');claim.onclick=()=>claimFees(row);card.append(claim);}
        else card.append(el('p','Creator fees can be claimed after this coin is live.','help'));
        if(redirectable(row)){
          const button=el('button','Redirect creator fees','small-button');button.type='button';button.dataset.meteoraRedirect=row.mint;button.disabled=busy||operation.busy||operation.pending||rerouting;button.onclick=()=>openRedirect(row);
          card.append(button,el('p','One recipient change per coin. This change is permanent: the recipient can claim fees but cannot redirect them again.','help'));
        }else if(row.feeRedirect?.used)card.append(el('p','Creator fees were redirected. The recipient is now fixed.','help'));
      }
      if(!open){open=el('a',live(row)?'Open coin →':'Open launchpad →','small-button token-card-open');open.href=live(row)?'/coin?mint='+encodeURIComponent(row.mint):'/launchpad?venue=meteora';}
      card.append(open);
      // Presentation: notes and actions each get one wrapper (the My Tokens card layout: heading · state · notes · actions).
      const body=el('div',null,'token-card-body'),actions=el('div',null,'token-card-actions');for(const node of [...card.children]){if(node===header||node===state)continue;(node.matches('a,button')?actions:body).append(node);}card.append(body,actions);grid.append(card);
    }
  }
  function chooseWallet(row){
    choices.replaceChildren();choices.hidden=false;const expected=recipientOf(row);choices.append(el('p','Connect the fee recipient wallet '+short(expected)+'.','help'));
    for(const option of ensureWallet().state().wallets){const button=el('button',option.name,'small-button');button.type='button';button.onclick=async()=>{if(disposed||connecting)return;const account=identity();connecting=true;button.disabled=true;try{await wallet.connect(option.id);if(disposed||account!==identity())return;if(wallet.state().address!==expected)throw Error('Switch to the fee recipient wallet '+short(expected)+'.');choices.hidden=true;await claimFees(row);}catch(error){if(!disposed&&account===identity())status.textContent=error.message;}finally{connecting=false;button.disabled=false;}};choices.append(button);}
  }
  async function claimFees(row){
    if(disposed||!identity()||busy||operation.busy||operation.pending||rerouting||!live(row)||row.feeMode==='agent')return;
    const recipient=recipientOf(row);if(ensureWallet().state().address!==recipient)return chooseWallet(row);
    selected=row;const key=binding(),version=generation;busy=true;status.textContent='Checking saved creator fee claims…';render();
    try{
      const saved=await request('/operations');if(disposed||version!==generation||key!==binding())return;
      const pending=(saved.operations||[]).find(op=>op.mint===row.mint&&op.wallet===recipient&&['claim','creator-claim','payout'].includes(op.action));
      if(pending&&operation.restore(pending)){await operation.reconcile();return;}
      const result=await operation.prepare({action:'claim',mint:row.mint});if(result?.operation)await operation.submit();status.textContent='';
    }catch(error){status.textContent=error.message;}finally{busy=false;render();}
  }
  function renderRedirect(){
    const next=redirectInput.value.trim(),valid=validWallet(next);
    redirectInput.disabled=redirectConfirm.disabled=redirectClose.disabled=rerouting;redirectPreview.textContent=valid?next:'';
    redirectSubmit.disabled=rerouting||!redirectRow||!redirectConfirm.checked||!valid||next===recipientOf(redirectRow);redirectSubmit.textContent=rerouting?'Saving fee recipient…':'Confirm one-time redirect';
  }
  function resetRedirect(){redirectRow=null;redirectInput.value='';redirectConfirm.checked=false;redirectStatus.textContent='';renderRedirect();hideDialog();}
  function openRedirect(row){
    if(disposed||!identity()||rerouting||busy||operation.busy||operation.pending||!redirectable(row))return;
    resetRedirect();redirectRow=row;redirectTitle.textContent='Redirect '+(row.symbol||'coin')+' creator fees';redirectCurrent.textContent=recipientOf(row)||'Unavailable';renderRedirect();showDialog();redirectInput.focus?.();
  }
  function closeRedirect(){if(!rerouting)resetRedirect();}
  async function reroute(row,recipient){
    if(disposed||!identity()||rerouting||operation.busy||operation.pending||!redirectable(row))return;
    const target=String(recipient||'').trim();if(!validWallet(target)){redirectStatus.textContent='Enter a valid Solana wallet address.';return;}
    // The redirect is authorized by the signed-in session, not the browser wallet, so only a session change discards its result.
    const account=identity()+':'+session?.token,current=()=>!disposed&&account===identity()+':'+session?.token;rerouting=true;redirectStatus.textContent='Saving the one-time fee recipient change…';renderRedirect();render();
    try{const result=await request('/reroute',{mint:row.mint,recipient:target});if(!current())return;const updated=result.launch||result;if(updated.mint!==row.mint||updated.creatorRecipient!==target&&updated.feeRedirect?.recipient!==target)throw Error('Refresh to verify the fee recipient change.');rerouting=false;resetRedirect();status.textContent='Creator fees now belong to '+short(target)+'.';await load();}
    catch(error){if(current())redirectStatus.textContent=error.message;}
    finally{if(current()||disposed){rerouting=false;if(!disposed){renderRedirect();render();}}}
  }
  redirectInput.oninput=renderRedirect;redirectConfirm.onchange=renderRedirect;redirectClose.onclick=closeRedirect;dialog.addEventListener('cancel',event=>{event.preventDefault();closeRedirect();});
  redirectForm.onsubmit=event=>{event?.preventDefault?.();const row=redirectRow,target=redirectInput.value.trim();if(!row||!redirectConfirm.checked||!validWallet(target)||target===recipientOf(row))return;return reroute(row,target);};
  async function load(){
    if(disposed||!identity())return;const version=generation;try{const data=await request('/launches');if(disposed||version!==generation)return;const values=Array.isArray(data)?data:data.launches;if(!Array.isArray(values))throw Error('Meteora launches could not be loaded.');rows=values.filter(row=>row.platform==='meteora'&&ADDRESS.test(row.mint||''));if(selected)selected=rows.find(row=>row.mint===selected.mint)||selected;if(redirectRow&&!rerouting){const next=rows.find(row=>row.mint===redirectRow.mint);if(redirectable(next))redirectRow=next;else resetRedirect();}render();}catch(error){if(!disposed&&version===generation){status.textContent=error.message;root.hidden=false;}}
  }
  return {load,setFilter(next){filter=next;render();},setSession(next){const previous=identity()+':'+session?.token;session=next;if(previous!==identity()+':'+session?.token){generation++;rows=[];selected=null;operation.reset();status.textContent='';choices.hidden=true;rerouting=false;resetRedirect();}render();},canLeave:()=>!busy&&!rerouting&&!connecting&&operation.canLeave(),clear(){generation++;rows=[];selected=null;operation.reset();rerouting=false;resetRedirect();root.hidden=true;},destroy(){if(disposed)return;disposed=true;generation++;unsubscribe?.();operation.destroy();hideDialog();dialog.remove();root.replaceChildren();}};
}
