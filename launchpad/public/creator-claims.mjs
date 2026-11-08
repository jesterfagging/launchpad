const feeKinds=new Set(['claim','tax','payout','sell','buy','burn']);
export function creatorClaimState(launch){
  if(!launch?.curve||launch.archived)return {available:false,busy:false,reason:'Creator fees are available after the launch is confirmed.'};
  if(launch.input?.feeMode!=='creator')return {available:false,busy:false,reason:launch.gotchi||launch.input?.gotchi?'Fees feed the Gotchi prize pot.':launch.input?.feeMode==='holders'?'Fees are reserved for holder rewards.':'Fees fund automatic buybacks and burns.'};
  return launch.feeClaim||{available:false,busy:false,reason:'Refresh to check creator fee availability.'};
}

// Claims can need more than one transaction. Completion is based on the server's
// settled cycle, never just a wallet approval or a successful submission response.
export async function runCreatorClaim({launch,baseline=launch,request,sign,onUpdate=()=>{},onProgress=()=>{},wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),check=()=>{},maxPolls=150}){
  const previous=new Set((baseline.operations||[]).filter(op=>op.state==='confirmed').map(op=>op.signature));
  const submitted=new Set();let current=launch,approvals=0;
  async function retry(path,body){
    for(let attempt=0;;attempt++){
      check();try{return await request(path,body);}catch(e){
        if(attempt>=2||e.statusCode&&![408,429,502,503,504].includes(e.statusCode))throw e;
        onProgress('Connection interrupted. Checking the saved claim…');await wait(Math.min(10000,Math.max(1200,Number(e.retryAfterMs)||1200*2**attempt)));
      }
    }
  }
  for(let poll=0;poll<maxPolls;poll++){
    check();if(current?.id!==launch.id)throw Error('The claim response does not match this launch.');onUpdate(current);
    const pending=(current.operations||[]).some(op=>feeKinds.has(op.kind)&&['pending','awaiting_signature'].includes(op.state));
    if(current.state==='live'&&current.feesRequested===false&&!current.cycle&&!current.pendingSignature&&!pending&&(Number(current.lastCycle)>Number(baseline.lastCycle||0)||baseline.feesRequested||baseline.cycle||launch.feesRequested||launch.cycle)){
      const receipts=(current.operations||[]).filter(op=>feeKinds.has(op.kind)&&op.state==='confirmed'&&op.signature&&!previous.has(op.signature));
      return {launch:current,receipts};
    }
    if(['error','paused','failed'].includes(current.state)&&!current.retry)throw Error(current.error||'Claim paused. Your progress is saved.');
    if(current.pendingSignature&&!submitted.has(current.pendingSignature.operationId)){
      current=await retry('/signature',{id:current.id,operationId:current.pendingSignature.operationId});check();if(current?.id!==launch.id)throw Error('The claim response does not match this launch.');onUpdate(current);
      const pending=current.pendingSignature;if(!pending)continue;
      if(!feeKinds.has(pending.kind))throw Error('This wallet request is not a fee claim. Review the launch before continuing.');
      if(++approvals>6)throw Error('More wallet approvals are needed. Your claim progress is saved.');
      onProgress('Approve the fee claim in your wallet.');const transaction=await sign(pending);check();
      onProgress('Confirming your transaction…');current=await retry('/sign',{id:current.id,operationId:pending.operationId,transaction});submitted.add(pending.operationId);continue;
    }
    onProgress(current.pendingSignature?'Waiting for wallet approval…':pending?'Confirming your transaction…':'Checking creator fees…');
    await wait(1200);check();const result=await retry('');
    current=result.launches?.find(row=>row.id===launch.id);if(!current)throw Error('This launch is no longer available in your account.');
  }
  throw Error('Your claim is still processing. Check its status before trying again.');
}
