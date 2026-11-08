import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureFeeAutomation,setFeeAutomation,autoRewardEnabled,scheduleRewardRetry,clearRewardRetry,publicRewardRetry,rewardResumeBlocker} from '../src/launchpad-reward-recovery.mjs';

const NOW=Date.parse('2026-09-25T16:30:00Z');
const launch=()=>({input:{route:'raydium',network:'mainnet-beta',feeMode:'holders',autoFees:true},keys:{wallet:{address:'creator',secret:'not-exported'}},curve:'verified-curve',authorizedAt:1,state:'live',autoFees:true,credits:{quote:'100',base:'200'},cycle:{stage:'payout',index:2,payouts:[{owner:'holder',amount:'5'}]},operations:[{kind:'payout',state:'pending',signature:'exact-signature',raw:'saved-signed-bytes'}]});
const enable=l=>{setFeeAutomation(l,true,NOW);return l;};
const error=(message,extra={})=>Object.assign(new Error(message),extra);
const closedScheduler='failed to get info about account 5eqQJP9Ms7Rq6gqz1wKY9mNTiQckw2eQNh4hRtCB5Hh5: Error: RPC scheduler closed';

test('tax-burn recovery keeps the saved signature and all reward obligations; an explicit pause wins',()=>{
  for(const message of ['tax-burn failed onchain. Fees are paused. Resume to retry this step.','The saved tax-burn transaction expired without landing. Its signature remains in history. Resume rewards to continue the saved step.']){
    const l=enable(launch());l.operations[0].kind='tax-burn';l.error=message;l.state='paused';
    const before=structuredClone(l);
    assert.equal(ensureFeeAutomation(l,NOW+1000),true);
    assert.equal(l.rewardRetry.kind,'transaction');
    for(const key of ['operations','credits','cycle'])assert.deepEqual(l[key],before[key]);
    setFeeAutomation(l,false,NOW+2000,'admin');l.error=message;l.state='paused';
    const paused=structuredClone(l);assert.equal(ensureFeeAutomation(l,NOW+3000),false);assert.deepEqual(l,paused);
  }
  const l=enable(launch());const before=structuredClone(l);
  assert.equal(scheduleRewardRetry(l,error('Tax burn receipt amount mismatch',{code:'REWARD_TRANSACTION_FAILED'}),NOW),false);
  assert.deepEqual(l,before);
});

test('existing enabled automation is persisted once without modifying transaction or reward ledgers',()=>{
  const l=launch(),before=structuredClone(l);assert.equal(ensureFeeAutomation(l,NOW),true);assert.equal(l.feeAutomation.source,'legacy-enabled');assert.equal(autoRewardEnabled(l),true);assert.equal(ensureFeeAutomation(l,NOW+1),false);
  for(const key of ['operations','credits','cycle'])assert.deepEqual(l[key],before[key]);
});

test('explicit pauses are authoritative across restarts and later recovery messages',()=>{
  const l=launch();setFeeAutomation(l,false,NOW,'user');l.error='Transaction receipt is still unresolved. Automatic work is paused while Launchpad checks the saved signature.';
  const restored=JSON.parse(JSON.stringify(l));assert.equal(ensureFeeAutomation(restored,NOW+1000),false);assert.equal(autoRewardEnabled(restored),false);assert.equal(scheduleRewardRetry(restored,error('fetch failed'),NOW+1000),false);assert.equal(restored.autoFees,false);
  restored.autoFees=true;assert.equal(ensureFeeAutomation(restored,NOW+2000),true);assert.equal(restored.autoFees,false);assert.equal(restored.feeAutomation.updatedAt,NOW);
});

test('legacy recovery migrates only exact prior engine messages and retains an unresolved signature',()=>{
  for(const message of ['An earlier tax conversion is awaiting its receipt. Launchpad will check it without submitting the old sale again.','buy failed onchain. Fees are paused. Resume to retry this step.','The saved burn transaction expired without landing. Its signature remains in history. Retry Buy back & burn to continue the saved step.']){
    const l=launch();l.autoFees=false;l.state='paused';l.error=message;const before=structuredClone(l);
    assert.equal(ensureFeeAutomation(l,NOW),true);assert.equal(l.feeAutomation.source,'legacy-recovery');assert.equal(l.state,'live');assert.equal(l.autoFees,true);assert.equal(l.feesRequested,true);
    for(const key of ['operations','credits','cycle'])assert.deepEqual(l[key],before[key]);
  }
});

test('legacy inference does not override deliberate or ambiguous pauses, malformed intent, or unsupported launches',()=>{
  for(const message of ['', 'Fee service paused. Pending receipts will still be reconciled.','fetch failed','The operator paused this coin.','buy failed onchain. Fees are paused. Resume to retry this step. Extra text.']){
    const l=launch();l.autoFees=false;l.error=message;const before=structuredClone(l);assert.equal(ensureFeeAutomation(l,NOW),true);assert.equal(l.feeAutomation.enabled,false);assert.equal(l.feeAutomation.source,'legacy-paused');const {feeAutomation,...unchanged}=l;assert.deepEqual(unchanged,before);
  }
  for(const mutate of [l=>{l.feeAutomation={enabled:false};},l=>{l.input.feeMode='creator';},l=>{l.input.network='devnet';},l=>{l.keys.wallet.external=true;},l=>{delete l.curve;},l=>{delete l.authorizedAt;},l=>{l.state='archived';}]){
    const l=launch();l.autoFees=false;l.error='buy failed onchain. Fees are paused. Resume to retry this step.';mutate(l);const before=structuredClone(l);assert.equal(ensureFeeAutomation(l,NOW),false);assert.deepEqual(l,before);
  }
});

test('launch intent can be set before the curve exists and explicit resume clears only runtime retry state',()=>{
  const l=launch();delete l.curve;l.rewardRetry={attempt:3,at:NOW+1000,kind:'network',reason:'Waiting'};const cycle=structuredClone(l.cycle);
  setFeeAutomation(l,true,NOW,'launch');assert.equal(l.feeAutomation.enabled,true);assert.equal(l.feeAutomation.source,'launch');assert.equal(l.rewardRetry,undefined);assert.deepEqual(l.cycle,cycle);
  setFeeAutomation(l,false,NOW+1);assert.equal(autoRewardEnabled(l),false);assert.equal(l.autoFees,false);
});

test('recoverable network failures use durable capped backoff without changing money or signed operations',()=>{
  const l=enable(launch()),before=structuredClone(l);let now=NOW;
  for(let attempt=1;attempt<=10;attempt++){
    assert.equal(scheduleRewardRetry(l,error('fetch failed from https://private.example/rpc?api-key=SECRET'),now),true);
    assert.equal(l.rewardRetry.attempt,attempt);assert.equal(l.rewardRetry.at-now,Math.min(900000,30000*2**Math.min(attempt-1,5)));assert.equal(l.rewardRetry.kind,'network');assert.doesNotMatch(l.rewardRetry.reason,/SECRET|private\.example/);
    now=l.rewardRetry.at;
  }
  assert.equal(l.autoFees,true);assert.equal(l.feesRequested,true);assert.equal(l.state,'live');assert.deepEqual(l.feeAutomation,before.feeAutomation);
  for(const key of ['operations','credits','cycle'])assert.deepEqual(l[key],before[key]);
  const restored=JSON.parse(JSON.stringify(l));scheduleRewardRetry(restored,error('HTTP 503'),now);assert.equal(restored.rewardRetry.attempt,11);assert.equal(restored.rewardRetry.at-now,900000);
});

test('daily budget waits until next UTC day while native and rent funding waits at least five minutes',()=>{
  const l=enable(launch());assert.equal(scheduleRewardRetry(l,error('Automatic rewards paused to limit network costs.',{code:'REWARD_GAS_BUDGET'}),NOW),true);
  assert.equal(l.rewardRetry.at,Date.parse('2026-09-26T00:00:01Z'));assert.equal(l.rewardRetry.kind,'gas-budget');assert.match(l.error,/daily gas budget resets/);
  for(const message of ['Insufficient SOL balance.','insufficient funds for rent','Transaction simulation failed: InsufficientFundsForFee','not enough lamports to pay rent']){
    clearRewardRetry(l);assert.equal(scheduleRewardRetry(l,error(message),NOW,{delayMs:1000}),true);assert.equal(l.rewardRetry.at,NOW+300000);assert.equal(l.rewardRetry.kind,'funding');
  }
});

test('only known transaction, network and market failures qualify, never generic retryable or invariant failures',()=>{
  const recoverable=[error('expired',{code:'REWARD_TRANSACTION_EXPIRED'}),error('failed',{code:'REWARD_TRANSACTION_FAILED'}),error('busy',{statusCode:429}),error('provider',{status:500}),error('lag',{code:-32016}),error('connect',{cause:{code:'ECONNRESET'}}),error('Slippage tolerance exceeded'),error('No swap route currently available'),error('The curve is awaiting graduation. Fee processing is paused until its AMM pool is available.')];
  for(const e of recoverable)assert.equal(scheduleRewardRetry(enable(launch()),e,NOW),true,e.message);
  for(const e of [error('Insufficient funds'),error('Insufficient token balance.'),error('authority differs'),error('receipt amount mismatch',{code:'REWARD_TRANSACTION_FAILED'}),error('Payout exceeds earned fee credit.'),error('invalid signer',{statusCode:503}),error('unknown failure',{retryable:true}),error('holder mint mismatch; fetch failed'),error('Transaction signature was already applied.'),error('HTTP 401'),error('Onchain simulation failed: unknown program failure.')]){
    const l=enable(launch()),before=structuredClone(l);assert.equal(scheduleRewardRetry(l,e,NOW),false,e.message);assert.deepEqual(l,before);
  }
});

test('clearing runtime retry preserves enabled intent and public retry exposes only sanitized safe fields',()=>{
  const l=enable(launch());scheduleRewardRetry(l,error('fetch failed at wss://rpc.example/path?secret=PRIVATE'),NOW,{kind:'rpc-reconnect'});l.rewardRetry.raw='signed bytes';l.rewardRetry.secret='private key';
  assert.deepEqual(publicRewardRetry(l),{at:NOW+30000,attempt:1,kind:'rpc-reconnect',reason:'fetch failed at [provider]'});clearRewardRetry(l);assert.equal(publicRewardRetry(l),null);assert.equal(autoRewardEnabled(l),true);
  for(const value of [{at:-1,attempt:1,kind:'network'},{at:NOW,attempt:0,kind:'network'},{at:NOW,attempt:1,kind:'<script>'},{at:NaN,attempt:1,kind:'network'}]){l.rewardRetry=value;assert.equal(publicRewardRetry(l),null);}
});


test('an ambiguous legacy pause is frozen before receipt updates can resemble a recoverable error',()=>{
  const l=launch();l.autoFees=false;l.error='';const original=structuredClone(l.operations);
  assert.equal(ensureFeeAutomation(l,NOW),true);assert.deepEqual(l.feeAutomation,{enabled:false,source:'legacy-paused',updatedAt:NOW});
  l.error='Transaction receipt is still unresolved. Automatic work is paused while Launchpad checks the saved signature.';
  assert.equal(ensureFeeAutomation(l,NOW+1000),false);assert.equal(autoRewardEnabled(l),false);assert.equal(l.autoFees,false);assert.deepEqual(l.operations,original);
  const off=launch();off.input.autoFees=false;off.autoFees=false;off.error='buy failed onchain. Fees are paused. Resume to retry this step.';
  assert.equal(ensureFeeAutomation(off,NOW),true);assert.equal(off.feeAutomation.enabled,false);assert.equal(off.feeAutomation.source,'legacy-paused');
});


test('reward retry cannot promote an unfinished launch into a verified live launch',()=>{
  for(const e of [error('HTTP 429'),error('Insufficient SOL balance.')]){
    const l=launch();l.curve=null;l.state='launching';setFeeAutomation(l,true,NOW,'launch');const before=structuredClone(l);
    assert.equal(autoRewardEnabled(l),true);assert.equal(scheduleRewardRetry(l,e,NOW),false);assert.deepEqual(l,before);
  }
  for(const mutate of [l=>{delete l.authorizedAt;},l=>{l.input.network='devnet';},l=>{l.state='archived';}]){
    const l=enable(launch());mutate(l);const before=structuredClone(l);assert.equal(scheduleRewardRetry(l,error('HTTP 503'),NOW),false);assert.deepEqual(l,before);
  }
});


test('malformed durable intent disables all unsigned reward work while preserving pending receipt accounting',()=>{
  for(const malformed of [{enabled:'true'},null,{},true]){
    const l=launch();l.feeAutomation=malformed;l.autoFees=true;l.feesRequested=true;l.rewardRetry={attempt:1,at:NOW+1000,kind:'network',reason:'retry'};
    const before=structuredClone(l);assert.equal(ensureFeeAutomation(l,NOW),true);
    assert.equal(l.autoFees,false);assert.equal(l.feesRequested,false);assert.equal(l.rewardRetry,undefined);assert.equal(l.state,'paused');assert.equal(autoRewardEnabled(l),false);
    assert.equal(l.error,'Saved reward automation settings need to be restored. Choose Resume rewards to continue.');assert.deepEqual(l.feeAutomation,malformed);
    for(const key of ['operations','credits','cycle'])assert.deepEqual(l[key],before[key]);
    assert.equal(ensureFeeAutomation(l,NOW+1),false);assert.equal(scheduleRewardRetry(l,error('HTTP 503'),NOW+1),false);
    setFeeAutomation(l,true,NOW+2,'user');assert.equal(autoRewardEnabled(l),true);assert.equal(l.feeAutomation.enabled,true);
  }
});


test('specific production market-data and transfer-fee epoch waits retry without broad unavailable matching',()=>{
  for(const [message,kind]of [
    ['The current transfer-fee epoch is unavailable.','network'],
    ['Asset pricing is temporarily unavailable. Please try again shortly.','market'],
    ['This asset’s current price is unavailable. Check your Jupiter connection in Account or try again shortly.','market'],
    ['A fresh quote price is required for the $100 holder reward minimum.','market'],
  ]){
    const l=enable(launch()),before=structuredClone(l);assert.equal(scheduleRewardRetry(l,error(message),NOW),true);assert.equal(l.rewardRetry.kind,kind);assert.equal(l.rewardRetry.at,NOW+30000);
    for(const key of ['operations','credits','cycle'])assert.deepEqual(l[key],before[key]);
  }
  for(const message of ['RPC unavailable','Quote mint was not found on this Solana network.','Invalid asset price.','The reward quote decimals changed.','The quote price reference must be positive.','The creator fee vault is invalid.','The reward conversion pool changed.','Launch signer is unavailable.','The reward conversion vaults differ from the pool.']){
    const l=enable(launch()),before=structuredClone(l);assert.equal(scheduleRewardRetry(l,error(message),NOW),false,message);assert.deepEqual(l,before);
  }
});

test('account-index overload retries both reward modes and scan integrity errors remain blocked',()=>{
  const message='failed to get accounts owned by program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: account index service overloaded, please try again. Please use getProgramAccountsV2';
  for(const mode of ['holders','buyback'])for(const failure of [error(message),error('Token account lookup is temporarily unavailable.',{code:'REWARD_ACCOUNT_SCAN_RETRY'})]){
    const l=enable(launch());l.input.feeMode=mode;const before=structuredClone(l);
    assert.equal(scheduleRewardRetry(l,failure,NOW),true);assert.equal(l.rewardRetry.kind,'network');assert.equal(l.rewardRetry.at,NOW+30000);
    for(const key of ['operations','credits','cycle'])assert.deepEqual(l[key],before[key]);
  }
  for(const failure of [error('HTTP 503',{code:'REWARD_ACCOUNT_SCAN_INVALID'}),error('HTTP 429',{code:'REWARD_ACCOUNT_SCAN_RPC'}),error('holder account owner mismatch',{code:'REWARD_ACCOUNT_SCAN_RETRY'}),error('duplicate account: '+message)]){
    const l=enable(launch()),before=structuredClone(l);assert.equal(scheduleRewardRetry(l,failure,NOW),false);assert.deepEqual(l,before);
  }
});

test('restart repairs enabled operational pauses once without changing saved receipt or payout work',()=>{
  for(const mode of ['holders','buyback'])for(const message of ['fetch failed','No swap route currently available','Insufficient SOL balance.','Automatic rewards paused to limit network costs. Resume tomorrow; your token stays live.']){
    const l=enable(launch());l.input.feeMode=mode;l.state='paused';l.autoFees=false;l.feesRequested=false;l.error=message;
    const before=structuredClone(l);assert.equal(ensureFeeAutomation(l,NOW),true);assert.equal(l.state,'live');assert.equal(l.autoFees,true);assert.equal(l.feesRequested,true);assert(l.rewardRetry.at>NOW);
    for(const key of ['operations','credits','cycle','feeAutomation'])assert.deepEqual(l[key],before[key]);
    const retried=structuredClone(l);assert.equal(ensureFeeAutomation(l,NOW+1),false);assert.deepEqual(l,retried);
  }
  const l=launch();l.state='paused';l.error='HTTP 503';assert.equal(ensureFeeAutomation(l,NOW),true);assert.equal(l.feeAutomation.source,'legacy-enabled');assert.equal(l.state,'live');assert(l.rewardRetry);
});

test('restart never repairs an explicit pause or a saved integrity failure as a transient wait',()=>{
  for(const source of ['user','legacy-paused']){
    const l=launch();setFeeAutomation(l,false,NOW,source);l.state='paused';l.feesRequested=false;l.error='HTTP 503';const before=structuredClone(l);
    assert.equal(ensureFeeAutomation(l,NOW+1),false);assert.deepEqual(l,before);
  }
  for(const message of ['The reward mint differs from the pool.','Invalid holder account; HTTP 503','Unknown reward error.']){
    const l=enable(launch());l.state='paused';l.error=message;const before=structuredClone(l);assert.equal(ensureFeeAutomation(l,NOW),false);assert.deepEqual(l,before);
  }
});

test('legacy provider overload is a narrow migration candidate, never a generic paused network error',()=>{
  const l=launch();l.state='paused';l.autoFees=false;l.error='failed to get accounts owned by program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: account index service overloaded, please try again.';
  const before=structuredClone(l);assert.equal(ensureFeeAutomation(l,NOW),true);assert.equal(l.feeAutomation.source,'legacy-recovery');assert.equal(l.state,'live');assert.equal(l.autoFees,true);
  for(const key of ['operations','credits','cycle'])assert.deepEqual(l[key],before[key]);
});

test('enabled old transaction pauses and the saved scan wait recover only from exact engine messages',()=>{
  const messages=['buy failed onchain. Fees are paused. Resume to retry this step.','The saved payout transaction expired without landing. Its signature remains in history. Retry Buy back & burn to continue the saved step.','Token-account scan is temporarily unavailable. Rewards will retry automatically.'];
  for(const mode of ['holders','buyback'])for(const message of messages){
    const l=enable(launch());l.input.feeMode=mode;l.state='paused';l.autoFees=false;l.feesRequested=false;l.error=message;const before=structuredClone(l);
    assert.equal(ensureFeeAutomation(l,NOW),true);assert.equal(l.state,'live');assert.equal(l.rewardRetry.at,NOW+30000);assert.equal(l.rewardRetry.kind,message.startsWith('Token-account')?'network':'transaction');
    for(const key of ['operations','credits','cycle','feeAutomation'])assert.deepEqual(l[key],before[key]);
    const paused=structuredClone(before);setFeeAutomation(paused,false,NOW,'user');const saved=structuredClone(paused);assert.equal(ensureFeeAutomation(paused,NOW),false);assert.deepEqual(paused,saved);
    const modified=structuredClone(before);modified.error+=' Additional unknown failure.';modified.autoFees=true;const original=structuredClone(modified);assert.equal(ensureFeeAutomation(modified,NOW),false);assert.deepEqual(modified,original);
  }
});

test('a closed RPC scheduler retries exact provider failures without replacing signed reward work',()=>{
  for(const mode of ['holders','buyback'])for(const failure of [error('RPC scheduler closed'),error(closedScheduler),error('Connection retired',{code:'RPC_SCHEDULER_CLOSED'})]){
    const l=enable(launch());l.input.feeMode=mode;const before=structuredClone(l);
    assert.equal(scheduleRewardRetry(l,failure,NOW),true,failure.message);
    assert.equal(l.rewardRetry.kind,'network');assert.equal(l.rewardRetry.at,NOW+30000);assert.equal(l.state,'live');assert.equal(l.autoFees,true);assert.equal(l.feesRequested,true);
    for(const key of ['operations','credits','cycle','feeAutomation'])assert.deepEqual(l[key],before[key]);
  }
});

test('restart repairs enabled scheduler-closed pauses and preserves explicit off intent',()=>{
  for(const mode of ['holders','buyback'])for(const message of ['RPC scheduler closed',closedScheduler]){
    const l=enable(launch());Object.assign(l,{state:'paused',autoFees:false,feesRequested:false,error:message});l.input.feeMode=mode;const before=structuredClone(l);
    assert.equal(ensureFeeAutomation(l,NOW),true);assert.equal(l.state,'live');assert.equal(l.autoFees,true);assert.equal(l.feesRequested,true);assert.equal(l.rewardRetry.kind,'network');assert.equal(l.rewardRetry.at,NOW+30000);
    for(const key of ['operations','credits','cycle','feeAutomation'])assert.deepEqual(l[key],before[key]);
    const retried=structuredClone(l);assert.equal(ensureFeeAutomation(l,NOW+1),false);assert.deepEqual(l,retried);
    for(const source of ['user','legacy-paused']){
      const paused=structuredClone(before);setFeeAutomation(paused,false,NOW,source);const saved=structuredClone(paused);
      assert.equal(ensureFeeAutomation(paused,NOW+1),false);assert.equal(scheduleRewardRetry(paused,error(message),NOW+1),false);assert.deepEqual(paused,saved);
    }
  }
});

test('legacy scheduler recovery requires a known exact failure and prior launch opt-in',()=>{
  for(const message of ['RPC scheduler closed',closedScheduler]){
    const l=launch();Object.assign(l,{autoFees:false,state:'paused',feesRequested:false,error:message});const before=structuredClone(l);
    assert.equal(ensureFeeAutomation(l,NOW),true);assert.equal(l.feeAutomation.enabled,true);assert.equal(l.feeAutomation.source,'legacy-recovery');assert.equal(l.state,'live');assert.equal(l.feesRequested,true);
    for(const key of ['operations','credits','cycle'])assert.deepEqual(l[key],before[key]);
    const paused=structuredClone(before);paused.input.autoFees=false;assert.equal(ensureFeeAutomation(paused,NOW),true);assert.equal(paused.feeAutomation.enabled,false);assert.equal(paused.feeAutomation.source,'legacy-paused');assert.equal(paused.state,'paused');
  }
  for(const message of ['RPC scheduler unavailable',`${closedScheduler}. Unknown failure.`,`Unexpected failure: ${closedScheduler}`]){
    const l=launch();Object.assign(l,{autoFees:false,state:'paused',error:message});const before=structuredClone(l);
    assert.equal(ensureFeeAutomation(l,NOW),true);assert.equal(l.feeAutomation.enabled,false);assert.equal(l.feeAutomation.source,'legacy-paused');
    const {feeAutomation,...rest}=l;assert.deepEqual(rest,before);assert.notEqual(rewardResumeBlocker(l),'');
  }
});

test('scheduler-closed text and codes cannot turn integrity errors into retry or resume permission',()=>{
  for(const message of [`Payout receipt mismatch; ${closedScheduler}`,`Invalid holder account; RPC scheduler closed`,`Fee-credit invariant failed. ${closedScheduler}`])for(const code of [undefined,'RPC_SCHEDULER_CLOSED']){
    const l=enable(launch());Object.assign(l,{state:'paused',error:message});const before=structuredClone(l);
    assert.equal(scheduleRewardRetry(l,error(message,{code}),NOW),false);assert.equal(ensureFeeAutomation(l,NOW),false);assert.notEqual(rewardResumeBlocker(l),'');assert.deepEqual(l,before);
    const legacy=launch();Object.assign(legacy,{autoFees:false,state:'paused',error:message});assert.equal(ensureFeeAutomation(legacy,NOW),true);assert.equal(legacy.feeAutomation.enabled,false);assert.equal(legacy.feeAutomation.source,'legacy-paused');
  }
});

const internalTransportWaits=[
  'RPC worker closed.',
  'Request scheduler closed.',
  'Request worker closed.',
  'Maximum signal age exceeded before the RPC request started.',
  'RPC capacity is busy. Try again shortly; nothing new was submitted.',
  'Provider capacity was unavailable before this trade expired. Nothing new was submitted.',
  'The operation was aborted due to timeout.',
  'TimeoutError: The operation was aborted due to timeout',
];
const transportWrappers=message=>[message,message.replace(/\.$/,''),`Error: ${message}`,`failed to get info about account 5eqQJP9Ms7Rq6gqz1wKY9mNTiQckw2eQNh4hRtCB5Hh5: Error: ${message}`,`failed to get balance of account 5eqQJP9Ms7Rq6gqz1wKY9mNTiQckw2eQNh4hRtCB5Hh5: ${message.startsWith('TimeoutError: ')?'':'Error: '}${message}`];

test('known internal transport capacity and lifecycle waits retry through supported web3 wrappers',()=>{
  for(const mode of ['holders','buyback'])for(const base of internalTransportWaits)for(const message of transportWrappers(base)){
    const l=enable(launch());l.input.feeMode=mode;const before=structuredClone(l);
    assert.equal(scheduleRewardRetry(l,error(message),NOW),true,message);assert.equal(l.rewardRetry.kind,'network');assert.equal(l.rewardRetry.at,NOW+30000);assert.equal(l.state,'live');assert.equal(rewardResumeBlocker({...l,error:message}),'');
    for(const key of ['operations','credits','cycle','feeAutomation'])assert.deepEqual(l[key],before[key]);
    const restored=structuredClone(before);Object.assign(restored,{state:'paused',autoFees:false,feesRequested:false,error:message});assert.equal(ensureFeeAutomation(restored,NOW),true);assert.equal(restored.state,'live');assert.equal(restored.rewardRetry.kind,'network');
  }
});

test('legacy internal transport inference requires an explicit original launch opt-in and never overrides saved off intent',()=>{
  for(const base of ['RPC scheduler closed.',...internalTransportWaits])for(const message of transportWrappers(base)){
    const l=launch();Object.assign(l,{state:'paused',autoFees:false,error:message});const before=structuredClone(l);
    assert.equal(ensureFeeAutomation(l,NOW),true);assert.equal(l.feeAutomation.enabled,true,message);assert.equal(l.feeAutomation.source,'legacy-recovery');assert.equal(l.state,'live');
    for(const key of ['operations','credits','cycle'])assert.deepEqual(l[key],before[key]);
    for(const originalPreference of [false,undefined]){
      const off=structuredClone(before);if(originalPreference===undefined)delete off.input.autoFees;else off.input.autoFees=originalPreference;
      assert.equal(ensureFeeAutomation(off,NOW),true);assert.equal(off.feeAutomation.enabled,false);assert.equal(off.feeAutomation.source,'legacy-paused');assert.equal(off.state,'paused');
    }
    const off=structuredClone(before);setFeeAutomation(off,false,NOW,'user');const saved=structuredClone(off);assert.equal(ensureFeeAutomation(off,NOW+1),false);assert.equal(scheduleRewardRetry(off,error(message),NOW+1),false);assert.deepEqual(off,saved);
  }
});

test('transport matching rejects unsupported wrappers, added failure text, and integrity errors',()=>{
  for(const message of [
    'RPC worker closed unexpectedly.',
    'Request scheduler closed. Check account state.',
    'Unexpected error: RPC capacity is busy. Try again shortly; nothing new was submitted.',
    'failed to get info about account not-a-public-key: Error: RPC scheduler closed.',
    'failed to get unrelated data: Error: Request worker closed.',
    'The operation was aborted.',
    'Unknown failure. TimeoutError: The operation was aborted due to timeout',
    'Payout receipt mismatch; Request worker closed.',
    'Invalid holder account; Provider capacity was unavailable before this trade expired. Nothing new was submitted.',
  ]){
    const l=enable(launch());Object.assign(l,{state:'paused',error:message});const before=structuredClone(l);
    assert.equal(scheduleRewardRetry(l,error(message),NOW),false,message);assert.equal(ensureFeeAutomation(l,NOW),false);assert.notEqual(rewardResumeBlocker(l),'');assert.deepEqual(l,before);
  }
});
