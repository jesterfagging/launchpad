import test from 'node:test';
import assert from 'node:assert/strict';
import {CREATOR_FEE_POLICY,CREATOR_FEE_RATE_PPM,HOLDER_CREATOR_FEE_POLICY,creatorFeeForLaunch,creatorFeeForSol,creatorFeeForUsd,creatorFeeForQuote,effectiveCreatorFeeRate} from '../public/creator-fee-schedule.mjs';

test('creator fees stay at 0.5% across previous tier boundaries and do not require market prices',()=>{
  for(const value of [0,419.99,420,1000,34380,54030,58940,1000000,undefined,NaN]){
    for(const quote of [undefined,0,1,200,60000])for(const decide of [creatorFeeForSol,creatorFeeForUsd,creatorFeeForQuote]){
      assert.deepEqual(decide(value,quote,quote),{policy:CREATOR_FEE_POLICY,ratePpm:5000,ratePercent:.5});
    }
  }
  assert.equal(CREATOR_FEE_RATE_PPM,5000);
});
test('legacy and pending upgrades report the last confirmed fee, with exact half-basis-point precision',()=>{
  const l={input:{creatorFeeBps:25},review:{},protocolActivation:{creatorFeeRatePpm:5000}};
  assert.equal(effectiveCreatorFeeRate(l),2500);
  l.creatorFees={ratePpm:2750};assert.equal(effectiveCreatorFeeRate(l),2750);
  l.creatorFees={policy:CREATOR_FEE_POLICY,ratePpm:5000};assert.equal(effectiveCreatorFeeRate(l),5000);
  assert.throws(()=>effectiveCreatorFeeRate({input:{creatorFeeBps:100},review:{}}));
});

test('taxed holders have no new curve creator fee while creator, buyback and historical untaxed holders retain flat fee policy',()=>{
  for(const taxBps of [100,200,300,500])assert.deepEqual(creatorFeeForLaunch({feeMode:'holders',taxBps}),{policy:HOLDER_CREATOR_FEE_POLICY,ratePpm:0,ratePercent:0});
  for(const feeMode of ['creator','buyback'])assert.deepEqual(creatorFeeForLaunch({feeMode,taxBps:0}),{policy:CREATOR_FEE_POLICY,ratePpm:5000,ratePercent:.5});
  assert.equal(creatorFeeForLaunch({feeMode:'holders',taxBps:0}).ratePpm,5000);
});
test('saved taxed holder launches do not adopt zero before a verified explicit upgrade',()=>{
  const launch={input:{feeMode:'holders',taxBps:500,creatorFeeBps:50,creatorFeePolicy:CREATOR_FEE_POLICY},review:{creatorFeeRatePpm:5000,creatorFeePolicy:CREATOR_FEE_POLICY},protocolActivation:{creatorFeePolicy:HOLDER_CREATOR_FEE_POLICY,creatorFeeRatePpm:0}};
  assert.equal(effectiveCreatorFeeRate(launch),5000);launch.creatorFees={policy:HOLDER_CREATOR_FEE_POLICY,ratePpm:0};assert.equal(effectiveCreatorFeeRate(launch),0);assert.equal(launch.input.taxBps,500);
});
