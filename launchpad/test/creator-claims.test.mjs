import test from 'node:test';
import assert from 'node:assert/strict';
import {runCreatorClaim} from '../public/creator-claims.mjs';
const base={id:'coin',state:'live',lastCycle:0,operations:[]};
const pending={operationId:'claim-one',wallet:'wallet',kind:'claim',transaction:'raw'};
test('a submission response is not claim completion, retries reuse the same signed bytes',async()=>{
  let signs=0,submissions=0,reads=0;const bodies=[];
  const launch={...base,state:'awaiting_signature',feesRequested:true,pendingSignature:pending};
  const result=await runCreatorClaim({launch,baseline:base,wait:async()=>{},sign:async()=>{signs++;return 'the-same-signed-transaction';},request:async(path,body)=>{
    if(path==='/signature')return launch;
    if(path==='/sign'){bodies.push(body);if(++submissions===1)throw Error('Network interrupted');return {...base,feesRequested:true,operations:[{kind:'claim',state:'pending',signature:'receipt'}]};}
    reads++;return {launches:[{...base,feesRequested:false,lastCycle:10,operations:[{kind:'claim',state:'confirmed',signature:'receipt'}]}]};
  }});
  assert.equal(signs,1);assert.equal(submissions,2);assert.deepEqual(bodies[0],bodies[1]);assert.equal(reads,1);assert.equal(result.receipts[0].signature,'receipt');
});
test('unrelated launch signatures are never sent to a wallet by a fee claim',async()=>{
  let signed=false;const launch={...base,state:'awaiting_signature',feesRequested:true,pendingSignature:{...pending,kind:'create'}};
  await assert.rejects(runCreatorClaim({launch,sign:async()=>{signed=true;},request:async()=>launch,wait:async()=>{}}),/not a fee claim/);assert.equal(signed,false);
});
test('unchanged idle launch is never misreported as successful and mismatched responses fail closed',async()=>{
  await assert.rejects(runCreatorClaim({launch:base,sign:async()=>{},request:async()=>({launches:[base]}),wait:async()=>{},maxPolls:2}),/still processing/);
  const launch={...base,state:'awaiting_signature',feesRequested:true,pendingSignature:pending};
  await assert.rejects(runCreatorClaim({launch,sign:async()=>{},request:async()=>({...base,id:'other',feesRequested:false,lastCycle:1}),wait:async()=>{},maxPolls:2}),/does not match/);
});
