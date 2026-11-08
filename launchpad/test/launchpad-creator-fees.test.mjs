import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import {Launchpad} from '../src/launchpad.mjs';
import {LaunchCreatorFees,creatorFeeDecision,creatorFeeEligible} from '../src/launchpad-creator-fees.mjs';
import {CREATOR_FEE_POLICY,HOLDER_CREATOR_FEE_POLICY} from '../public/creator-fee-schedule.mjs';
import {SOL_MINT} from '../public/launchpad-model.mjs';

test('legacy worker integrations cannot enqueue tier changes or request price data',async()=>{
  const forbidden=()=>{throw Error('Retired fee scheduler accessed storage or RPC');};
  const worker=new LaunchCreatorFees({accounts:{list:forbidden},launchpad:{book:forbidden,refreshCreatorFee:forbidden}});
  worker.start();await worker.tick();await worker.close();
  for(const policy of ['sol-market-cap-v1',CREATOR_FEE_POLICY,undefined]){
    const launch={input:{creatorFeePolicy:policy},review:{creatorFeePolicy:policy},creatorFees:{ratePpm:2750}};
    assert.equal(creatorFeeEligible(launch),false);assert.equal(creatorFeeDecision(launch).status,'deferred');
    assert.equal((await Launchpad.prototype.refreshCreatorFee.call({},'account','coin')).status,'deferred');
    assert.equal(launch.creatorFees.ratePpm,2750);
  }
});
test('the server enforces zero creator fees for taxed holders and 0.5% for new creator launches despite client overrides',async()=>{
  const recipient=Keypair.generate().publicKey.toBase58(),manager={accounts:{hostStore:{read:async(name,fallback)=>name==='launch-protocol-fees'?{recipient}:fallback}}};
  for(const feeMode of ['creator','holders'])for(const creatorFeePercent of ['0','0.25','0.275','0.99']){
    const input=await Launchpad.prototype.newLaunchInput.call(manager,'account',{name:'Flat',symbol:'FLAT',quoteMint:SOL_MINT,feeMode,creatorFeePercent,creatorFeePolicy:'sol-market-cap-v1',taxPercent:feeMode==='holders'?'2':'0'});
    assert.equal(input.creatorFeeBps,feeMode==='holders'?0:50);assert.equal(input.creatorFeePolicy,feeMode==='holders'?HOLDER_CREATOR_FEE_POLICY:CREATOR_FEE_POLICY);assert.equal(input.protocolFees.platformLpPercent,75);
  }
  await assert.rejects(Launchpad.prototype.newLaunchInput.call(manager,'account',{name:'Retired',symbol:'OLD',quoteMint:SOL_MINT,feeMode:'buyback'}),error=>error.code==='LAUNCH_MODE_RETIRED');
});
