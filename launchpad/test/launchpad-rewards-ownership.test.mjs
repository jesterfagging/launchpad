import test from 'node:test';
import assert from 'node:assert/strict';
import {Launchpad} from '../src/launchpad.mjs';

test('the reward viewer resolves launch ownership and holder policy before every cached read',async t=>{
  const id='a'.repeat(32),launch={id,input:{route:'raydium',network:'mainnet-beta',feeMode:'holders'},authorizedAt:1,curve:'curve',operations:[]};
  const books=new Map([['owner',{launches:[launch]}],['other',{launches:[]}]]),calls=[];
  const manager=new Launchpad({storeFor:account=>({read:async()=>structuredClone(books.get(account)||{launches:[]})})},null);
  manager.rewardsView={read:async(account,l)=>{calls.push(account);return{launchId:l.id,quoteBalance:'12'};},close:async()=>{}};t.after(()=>manager.close());
  assert.equal((await manager.rewards('owner',id)).launchId,id);
  await assert.rejects(manager.rewards('other',id),/not found/);assert.equal(calls.length,1);
  launch.input.feeMode='creator';await assert.rejects(manager.rewards('owner',id),/holder-reward/);assert.equal(calls.length,1);
  launch.input.feeMode='holders';launch.curve=null;await assert.rejects(manager.rewards('owner',id),/confirmed/);
  launch.operations=[{kind:'create',state:'confirmed'}];assert.equal((await manager.rewards('owner',id)).launchId,id);
  launch.authorizedAt=null;await assert.rejects(manager.rewards('owner',id),/confirmed/);assert.deepEqual(calls,['owner','owner']);
});
