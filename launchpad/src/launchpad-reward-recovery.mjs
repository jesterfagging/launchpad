import {isCurrentLaunch} from '../public/launchpad-model.mjs';
import {knownRewardTransportMessage,rewardIntegrityMessage} from './reward-transport-recovery.mjs';

const DAY_MS=86400000,MAX_BACKOFF_MS=15*60000;
const managedRewards=l=>['holders','buyback'].includes(l?.input?.feeMode)&&l?.keys?.wallet?.external!==true;
const verifiedRewards=l=>managedRewards(l)&&isCurrentLaunch(l.input)&&!!l.curve&&!!l.authorizedAt&&!['draft','failed','archived','stopping'].includes(l.state);
const reason=value=>String(value?.message||value||'Reward processing is waiting to retry.').replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi,'[provider]').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,300);
const hasIntent=l=>Object.hasOwn(l,'feeAutomation');
const validTime=value=>Number.isSafeInteger(value)&&value>=0&&value<=8640000000000000;
const retryKind=value=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,39}$/.test(value)?value:null;

// Only messages emitted by earlier reward-engine recovery paths establish a
// migration candidate. A launch preference alone never overrides a saved pause.
const legacyRecoveryMessages=new Set([
  'Transaction receipt is still unresolved. Automatic work is paused while Launchpad checks the saved signature.',
  'An earlier tax conversion is awaiting its receipt. Launchpad will check it without submitting the old sale again.',
  'The earlier tax conversion expired without landing. Reward balances are unchanged. You can now upgrade the protocol policy or manually resume holder rewards.',
  'Automatic rewards paused to limit network costs. Resume tomorrow; your token stays live.',
  'The curve is awaiting graduation. Fee processing is paused until its AMM pool is available.',
  'Fee swap is below the minimum size.',
]);
const accountIndexOverload=message=>/^failed to get accounts owned by program [1-9A-HJ-NP-Za-km-z]{32,44}\b[\s\S]*\baccount index service overloaded\b/i.test(message);
const legacyFailedReward=message=>/^(?:claim|tax|tax-burn|sell|gas-sell|buy|burn|payout|tax-protocol-payout|reward-handoff) failed onchain\. Fees are paused\. Resume to retry this step\.$/.test(message||'');
const legacyExpiredReward=message=>/^The saved (?:claim|tax|tax-burn|sell|gas-sell|buy|burn|payout|tax-protocol-payout|reward-handoff) transaction expired without landing\. Its signature remains in history\. (?:Retry Buy back & burn|Resume rewards) to continue the saved step\.$/.test(message||'');
const legacySystemFunding=message=>/^Onchain simulation failed during fee processing \(instruction (0|[1-9]\d{0,3}), program 11111111111111111111111111111111\): \{"InstructionError":\[\1,\{"Custom":1\}\]\}\.$/.test(message||'');
const legacyRecovery=l=>legacyRecoveryMessages.has(l.error)||legacyFailedReward(l.error)||legacyExpiredReward(l.error)||l.input?.autoFees===true&&legacySystemFunding(l.error)||(accountIndexOverload(l.error||'')||l.input?.autoFees===true&&knownRewardTransportMessage(l.error))&&classify(l.error)==='network';

function resumeEnabledWait(l,now){
  // Persisted opt-in survives an operational pause. Restart only failures we
  // can classify; do not turn an integrity error into automatic spending.
  if(l.state!=='paused'||l.rewardRetry||!l.feeAutomation?.enabled)return false;
  let error=l.error;
  if(error==='Automatic rewards paused to limit network costs. Resume tomorrow; your token stays live.')error={message:error,code:'REWARD_GAS_BUDGET'};
  else if(legacyFailedReward(error))error={message:error,code:'REWARD_TRANSACTION_FAILED'};
  else if(legacyExpiredReward(error))error={message:error,code:'REWARD_TRANSACTION_EXPIRED'};
  else if(error==='Token-account scan is temporarily unavailable. Rewards will retry automatically.')error={message:error,code:'REWARD_ACCOUNT_SCAN_RETRY'};
  return scheduleRewardRetry(l,error,now);
}

export function setFeeAutomation(l,enabled,now,source='user'){
  l.feeAutomation={enabled:enabled===true,source:retryKind(source)||'user',updatedAt:now};
  l.autoFees=l.feeAutomation.enabled;
  delete l.rewardRetry;
}

export function ensureFeeAutomation(l,now){
  if(!verifiedRewards(l))return false;
  if(hasIntent(l)){
    // Malformed persisted intent is not permission to infer a new opt-in,
    // including an old runtime flag or a queued unsigned reward request.
    if(typeof l.feeAutomation?.enabled!=='boolean'){
      const message='Saved reward automation settings need to be restored. Choose Resume rewards to continue.';
      const changed=l.autoFees!==false||l.feesRequested!==false||Object.hasOwn(l,'rewardRetry')||l.state!=='paused'||l.error!==message;
      l.autoFees=false;l.feesRequested=false;delete l.rewardRetry;l.state='paused';l.error=message;return changed;
    }
    if(resumeEnabledWait(l,now))return true;
    if(l.autoFees===l.feeAutomation.enabled)return false;
    l.autoFees=l.feeAutomation.enabled;return true;
  }
  if(l.autoFees===true){setFeeAutomation(l,true,now,'legacy-enabled');resumeEnabledWait(l,now);return true;}
  if(l.autoFees===false&&l.input.autoFees!==false&&legacyRecovery(l)){
    setFeeAutomation(l,true,now,'legacy-recovery');l.state='live';l.feesRequested=!!l.cycle;return true;
  }
  // Freeze an ambiguous old pause now. Receipt reconciliation may replace its
  // old message later, but that must never manufacture an automatic opt-in.
  setFeeAutomation(l,false,now,'legacy-paused');return true;
}

export function autoRewardEnabled(l){
  return managedRewards(l)&&(hasIntent(l)?l.feeAutomation?.enabled===true:l.autoFees===true);
}

export function rewardResumeBlocker(l){
  const message=typeof l?.error==='string'?l.error:'';
  // An explicit administrator resume can restore a deliberate opt-out or
  // recheck a fixed provider connection. It must not erase an unexplained
  // receipt, authority, incomplete snapshot or accounting failure.
  if(!message||[
    'Fee service paused. Pending receipts will still be reconciled.',
    'Saved reward automation settings need to be restored. Choose Resume rewards to continue.',
    'The token-account RPC request failed. Rewards paused without using incomplete data.',
    'Automatic rewards are waiting to retry automatically.',
    'Automatic rewards are waiting for SOL and will retry automatically.',
    'Automatic rewards will continue after the daily gas budget resets.',
    'Token-account scan is temporarily unavailable. Rewards will retry automatically.',
    'Waiting for the saved reward transaction. Rewards will continue automatically once its outcome is verified.',
    'Submission response unavailable. Launchpad is checking the saved signature; it will not create a second transaction.',
  ].includes(message)||legacyRecovery(l)||classify(message))return '';
  return 'Review the saved reward error before resuming. Account, signer, receipt and balance checks cannot be bypassed.';
}

export function classifyRewardFailure(error){
  const message=String(error?.message||error||''),code=error?.code;
  if(['REWARD_ACCOUNT_SCAN_INVALID','REWARD_ACCOUNT_SCAN_RPC'].includes(code))return null;
  // Semantic failures must never become retryable because a provider appends
  // network/slippage text or supplies a broad retryable flag.
  if(rewardIntegrityMessage(message))return null;
  if(code==='RPC_SCHEDULER_CLOSED'||knownRewardTransportMessage(message))return 'network';
  if(code==='REWARD_GAS_BUDGET')return 'gas-budget';
  if(code==='REWARD_ACCOUNT_SCAN_RETRY'||accountIndexOverload(message))return 'network';
  if(['REWARD_TRANSACTION_EXPIRED','REWARD_TRANSACTION_FAILED'].includes(code))return 'transaction';
  if(['REWARD_NATIVE_FUNDS','REWARD_SOL_REQUIRED','REWARD_RENT_REQUIRED'].includes(code))return 'funding';
  if(legacySystemFunding(message))return 'funding';
  if(['REWARD_MARKET_WAIT','REWARD_SLIPPAGE','REWARD_ROUTE_UNAVAILABLE'].includes(code))return 'market';
  if(message==='The current transfer-fee epoch is unavailable.')return 'network';
  if([
    'Asset pricing is temporarily unavailable. Please try again shortly.',
    'This asset’s current price is unavailable. Check your Jupiter connection in Account or try again shortly.',
    'A fresh quote price is required for the $100 holder reward minimum.',
  ].includes(message))return 'market';
  if(/insufficient (?:SOL|lamports|native (?:SOL |coin |token )?balance)|(?:not enough|insufficient) (?:SOL|lamports) (?:balance |to |for )|insufficient funds for (?:rent|(?:the )?(?:transaction )?fee)|insufficient lamports|insufficientfundsforrent|insufficientfundsforfee|insufficient native balance|(?:SOL|native) balance (?:is )?too low|not enough (?:SOL|lamports)\b/i.test(message))return 'funding';
  if(/\binsufficient funds\b|insufficient (?:token|quote|base) balance/i.test(message))return null;
  const statuses=[error?.statusCode,error?.status,error?.response?.status,error?.cause?.status,code];
  if(statuses.some(value=>Number(value)===408||Number(value)===429||Number(value)>=500&&Number(value)<=599||Number(value)===-32016))return 'network';
  if([code,error?.cause?.code].some(value=>['ECONNRESET','ETIMEDOUT','ECONNABORTED','EAI_AGAIN','ENETUNREACH','ECONNREFUSED','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','LAUNCH_SIMULATION_BLOCKHASH','LAUNCH_BLOCKHASH_EXPIRED'].includes(value))||error?.name==='TimeoutError')return 'network';
  if(/minimum context slot|HTTP (?:408|429|5\d\d)\b|ECONNRESET|ETIMEDOUT|ECONNABORTED|timeout of \d+ms exceeded|fetch failed|socket hang up|RPC (?:request )?(?:timeout|timed out)|request (?:timed out|deadline expired)|rate limit(?:ed| exceeded)?/i.test(message))return 'network';
  if(/slippage (?:tolerance )?(?:exceeded|limit)|slippage tolerance|slippagetoleranceexceeded|exceededslippage|(?:route|routing|liquidity) (?:is )?temporarily unavailable|no (?:swap )?route (?:is )?(?:currently )?(?:available|found)|could not find (?:a )?(?:swap )?route|curve is awaiting graduation|fee swap is below the minimum size/i.test(message))return 'market';
  return null;
}

const classify=classifyRewardFailure;

export function scheduleRewardRetry(l,error,now,{kind,delayMs}={}){
  if(!verifiedRewards(l)||!autoRewardEnabled(l)||!validTime(now))return false;
  const category=classify(error);if(!category)return false;
  const previous=Number.isSafeInteger(l.rewardRetry?.attempt)&&l.rewardRetry.attempt>0?l.rewardRetry.attempt:0,attempt=Math.min(previous+1,1000000);
  const requested=Number.isFinite(delayMs)&&delayMs>0?Math.max(1000,Math.min(MAX_BACKOFF_MS,Math.floor(delayMs))):null;
  const delay=category==='funding'?Math.max(5*60000,requested||0):requested||Math.min(MAX_BACKOFF_MS,30000*2**Math.min(attempt-1,5));
  const at=category==='gas-budget'?(Math.floor(now/DAY_MS)+1)*DAY_MS+1000:now+delay;
  if(!validTime(at))return false;
  l.rewardRetry={attempt,at,kind:retryKind(kind)||category,reason:reason(error)};
  l.state='live';l.autoFees=true;l.feesRequested=true;
  l.error=category==='gas-budget'?'Automatic rewards will continue after the daily gas budget resets.':category==='funding'?'Automatic rewards are waiting for SOL and will retry automatically.':'Automatic rewards are waiting to retry automatically.';
  return true;
}

export function clearRewardRetry(l){delete l.rewardRetry;}

export function publicRewardRetry(l){
  const value=l?.rewardRetry;
  if(!value||!validTime(value.at)||!Number.isSafeInteger(value.attempt)||value.attempt<1||!retryKind(value.kind))return null;
  return{at:value.at,attempt:value.attempt,kind:value.kind,reason:reason(value.reason)};
}
