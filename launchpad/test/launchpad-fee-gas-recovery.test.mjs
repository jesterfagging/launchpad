import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,SystemProgram,TransactionInstruction,TransactionMessage,VersionedTransaction,PublicKey} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {LaunchChain,newLaunchKeys,launchSimulationError} from '../src/launchpad-chain.mjs';
import {ensureFeeAutomation,setFeeAutomation,scheduleRewardRetry} from '../src/launchpad-reward-recovery.mjs';

const key=()=>Keypair.generate().publicKey;
const message=(instruction,payer=instruction.keys[0].pubkey)=>new VersionedTransaction(new TransactionMessage({payerKey:payer,recentBlockhash:key().toBase58(),instructions:[instruction]}).compileToV0Message());
const failed={err:{InstructionError:[0,{Custom:1}]},logs:['Transfer: insufficient lamports 1486000, need 1488440']};
const NOW=Date.UTC(2026,8,29),legacy='Onchain simulation failed during fee processing (instruction 2, program 11111111111111111111111111111111): {"InstructionError":[2,{"Custom":1}]}.',launch=()=>({input:{route:'raydium',network:'mainnet-beta',feeMode:'holders',autoFees:true},keys:{wallet:{address:key().toBase58()}},curve:key().toBase58(),authorizedAt:1,state:'paused',autoFees:true,feesRequested:true,error:legacy,operations:[{kind:'payout',state:'pending',signature:'saved-signature',raw:'saved-bytes'}],credits:{quote:'100'},cycle:{stage:'payout',index:2}});

test('System insufficient lamports reports the exact debit wallet and instruction shortfall',()=>{
  const source=key(),payer=key(),instruction=SystemProgram.createAccountWithSeed({fromPubkey:source,basePubkey:source,newAccountPubkey:key(),seed:'unwrap',lamports:1488440,space:165,programId:TOKEN_PROGRAM_ID});
  const error=launchSimulationError(message(instruction,payer),failed,false);
  assert.equal(error.code,'REWARD_NATIVE_FUNDS');assert.equal(error.fundingWallet,source.toBase58());assert.equal(error.fundingShortfallLamports,'2440');assert.match(error.message,/0\.00000244 SOL/);assert(error.message.includes(source.toBase58()));assert(!error.message.includes(payer.toBase58()));assert.match(error.message,/Nothing was submitted/);
  const l=launch();setFeeAutomation(l,true,NOW);const before=structuredClone(l);
  assert.equal(scheduleRewardRetry(l,error,NOW),true);assert.equal(l.state,'live');assert.equal(l.rewardRetry.kind,'funding');assert.equal(l.rewardRetry.at,NOW+300000);assert(l.rewardRetry.reason.includes(source.toBase58()));
  for(const field of ['operations','credits','cycle','feeAutomation'])assert.deepEqual(l[field],before[field]);
});

test('fee-only shortage identifies payer; unavailable shortfall and foreign custom numbers are never guessed',()=>{
  const payer=key(),tx=message(SystemProgram.transfer({fromPubkey:payer,toPubkey:key(),lamports:5}));
  const fee=launchSimulationError(tx,{err:'InsufficientFundsForFee'},false);assert.equal(fee.fundingWallet,payer.toBase58());assert.equal(fee.fundingShortfallLamports,undefined);
  assert.equal(launchSimulationError(tx,{err:failed.err,logs:[]},false).code,'REWARD_NATIVE_FUNDS');
  const foreign=message(new TransactionInstruction({programId:TOKEN_PROGRAM_ID,keys:[{pubkey:payer,isSigner:true,isWritable:true}],data:Buffer.from([2,0,0,0])}));
  assert.equal(launchSimulationError(foreign,failed,false).code,undefined);
  assert.equal(launchSimulationError(tx,failed,'trade').code,'TRADE_INSUFFICIENT_SOL');
  assert.equal(launchSimulationError(tx,{err:{InstructionError:[0,{Custom:2}]}},false).code,undefined);
});

test('actual fee preparation rejects before journaling with a retryable native SOL shortage',async()=>{
  const l={...launch(),keys:newLaunchKeys()},payer=new PublicKey(l.keys.wallet.address);
  const c=new LaunchChain({network:'mainnet-beta',connection:{getLatestBlockhash:async()=>({blockhash:key().toBase58(),lastValidBlockHeight:100}),simulateTransaction:async()=>({context:{slot:42},value:{...failed,err:{InstructionError:[2,{Custom:1}]}}})}});
  await assert.rejects(c.prepare(l,[SystemProgram.transfer({fromPubkey:payer,toPubkey:key(),lamports:1488440})]),error=>error.code==='REWARD_NATIVE_FUNDS'&&error.fundingWallet===payer.toBase58()&&error.fundingShortfallLamports==='2440');
});

test('only exact historical System funding failures restore existing automatic intent',()=>{
  for(const durable of [false,true]){
    const l=launch();if(durable)setFeeAutomation(l,true,NOW);else l.autoFees=false;l.error=legacy;const before=structuredClone(l);
    assert.equal(ensureFeeAutomation(l,NOW),true);assert.equal(l.state,'live');assert.equal(l.autoFees,true);
    if(durable)assert.equal(l.rewardRetry.kind,'funding');
    for(const field of ['operations','credits','cycle'])assert.deepEqual(l[field],before[field]);
  }
  const paused=launch();setFeeAutomation(paused,false,NOW,'user');const before=structuredClone(paused);assert.equal(ensureFeeAutomation(paused,NOW),false);assert.deepEqual(paused,before);
  for(const wrong of [legacy.replace('"Custom":1','"Custom":2'),legacy.replace('"InstructionError":[2','"InstructionError":[3'),legacy.replace('11111111111111111111111111111111',TOKEN_PROGRAM_ID.toBase58()),legacy+' Extra failure.']){
    const l=launch();setFeeAutomation(l,true,NOW);l.error=wrong;const saved=structuredClone(l);assert.equal(ensureFeeAutomation(l,NOW),false);assert.deepEqual(l,saved);
  }
});
