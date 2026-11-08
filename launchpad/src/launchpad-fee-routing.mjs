import { PublicKey } from '@solana/web3.js';
import { isCurrentLaunch } from '../public/launchpad-model.mjs';

const wallet=value=>{try{return typeof value==='string'&&new PublicKey(value).toBase58()===value&&PublicKey.isOnCurve(new PublicKey(value).toBytes())?value:null;}catch{return null;}};
const hasCredit=value=>{try{return BigInt(value??'0')!==0n;}catch{return true;}};

// The launch payer is retained independently of its payout beneficiary. Never
// derive creator authority from the current recipient or the viewer's wallet.
export function originalFeeCreatorWallet(launch){
  const payer=launch.keys?.payer,original=wallet(payer?.address);
  return payer?.external===true&&launch.input?.walletMode==='external'&&launch.input.externalWallet===original?original:null;
}

export function feeRecipientRedirectUsed(launch){
  if(Object.hasOwn(launch,'feeRecipientRedirect')||Object.hasOwn(launch,'feeRecipientRedirectedAt'))return true;
  if(launch.feeRecipientHistory!==undefined&&(!Array.isArray(launch.feeRecipientHistory)||launch.feeRecipientHistory.length>0))return true;
  // Older records may predate the audit journal. Normalized creator launches
  // originally paid their developer wallet, so a differing recipient is locked.
  const original=originalFeeCreatorWallet(launch);
  return !!(original&&launch.input?.feeMode==='creator'&&launch.input.recipient!==original);
}

export function creatorFeeRedirectStatus(launch,{shared=false,personal=false}={}){
  const originalWallet=originalFeeCreatorWallet(launch),used=feeRecipientRedirectUsed(launch);
  const result=reason=>({allowed:!reason,used,reason,originalWallet,recipient:launch.input?.recipient||''});
  if(used)return result('This coin’s one-time fee redirect has already been used.');
  if(launch.input?.route==='pumpswap')return result('This Pump launch pays its original creator onchain and cannot redirect fees.');
  if(!isCurrentLaunch(launch.input)||!launch.curve||!launch.authorizedAt)return result('A verified live launch is required.');
  if(launch.input.agent)return result('AI Agent launches assign their creator fees to the agent permanently and cannot redirect them.');
  if(launch.input.feeMode!=='creator'||Number(launch.input.taxBps)!==0)return result('Only creator-fee coins without holder transfer fees can redirect creator fees.');
  if(!originalWallet)return result('The original connected creator wallet could not be verified for this launch.');
  const key=launch.keys?.wallet;
  if(launch.feeCustody!=='relay'||!key?.secret||key.external||key.exportedAt||key.compromised||key.compromisedAt||launch.feeWalletExportedAt||launch.walletExportedAt||launch.walletCompromisedAt)return result('Exclusive fee custody is unavailable for this launch.');
  if(shared||personal||key.address===launch.keys.payer.address)return result('This launch uses a shared or personal fee wallet.');
  if(!['live','paused'].includes(launch.state))return result('Finish or recover this launch before redirecting its fees.');
  if((launch.operations||[]).some(op=>['pending','awaiting_signature'].includes(op.state))||launch.cycle||launch.feesRequested)return result('A fee claim or transaction is in progress. Finish it before redirecting fees.');
  if(hasCredit(launch.credits?.quote)||hasCredit(launch.credits?.base))return result('Existing fee credits must finish distributing before redirecting fees.');
  return result('');
}
