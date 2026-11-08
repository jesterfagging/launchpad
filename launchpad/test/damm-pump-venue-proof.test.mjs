import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { DAMM_PUMP_VENUE_PROOFS as proofs, verifyDammPumpVenues } from '../src/damm-pump-venue-proof.mjs';

const fixtures=new URL('../contracts/curve-pump-public/tests/fixtures/damm-pump/',import.meta.url);
const manifest=JSON.parse(readFileSync(new URL('manifest.json',fixtures)));
const loader=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
// The venue programs' binaries are third-party code and are not bundled: capture them with
// contracts/curve-pump-public/tests/capture_damm_programs.py to run these tests.
let binaries=null;try{binaries=manifest.programs.map(p=>readFileSync(new URL(p.file,fixtures)));}catch{binaries=null;}
const SKIP=binaries?false:'venue program binaries not captured (contracts/curve-pump-public/tests/capture_damm_programs.py)';
function mock() {
  const calls=[],state={slot:500_000_000,genesis:manifest.genesisHash,headerMutation:null,fullMutation:null,failure:null};
  const headers=proofs.map(p=>{const b=Buffer.alloc(45);b.writeUInt32LE(3);b.writeBigUInt64LE(BigInt(p.deploymentSlot),4);b[12]=1;new PublicKey(p.programId).toBuffer().copy(b,13);return b;});
  const program=i=>{const data=Buffer.alloc(36);data.writeUInt32LE(2);new PublicKey(proofs[i].programData).toBuffer().copy(data,4);return {owner:loader,executable:true,data};};
  const connection={
    getGenesisHash:async()=>state.genesis,
    getMultipleAccountsInfoAndContext:async(keys,options)=>{
      calls.push({keys:keys.map(String),options});assert.equal(options.commitment,'finalized');
      if(state.failure)throw state.failure;
      const sliced=!!options.dataSlice;
      let value=keys.map(key=>{
        const text=String(key),programIndex=proofs.findIndex(p=>p.programId===text),dataIndex=proofs.findIndex(p=>p.programData===text);
        if(programIndex>=0)return program(programIndex);
        assert.ok(dataIndex>=0,'only pinned venue accounts are read');
        const data=Buffer.concat([headers[dataIndex],binaries[dataIndex]]),slice=options.dataSlice;
        return {owner:loader,executable:false,data:sliced?data.subarray(slice.offset,slice.offset+slice.length):data};
      });
      if(sliced&&state.headerMutation)state.headerMutation(value,calls);
      if(!sliced&&state.fullMutation)state.fullMutation(value,calls);
      return {context:{slot:state.slot},value};
    },
  };
  return {connection,calls,state,headers};
}
const fullCalls=m=>m.calls.filter(c=>!c.options.dataSlice);
const isProof=error=>error.code==='DAMM_VENUE_PROOF'&&error.statusCode===409;

test('venue pins match all captured executable fixture identities',{skip:SKIP},()=>{
  for(let i=0;i<proofs.length;i++)for(const [key,other]of Object.entries({programId:'programId',programData:'programData',deploymentSlot:'lastDeployedSlot',bytes:'bytes',sha256:'sha256'}))assert.equal(String(proofs[i][key]),String(manifest.programs[i][other]));
});

test('real web3 RPC serialization fits the transport limit while the old combined read fails',{skip:SKIP},async()=>{
  const m=mock(),encodedCalls=[],limit=16*1024*1024;
  const connection=new Connection('https://fixture.invalid',{disableRetryOnRateLimit:true,fetch:async(_url,options)=>{
    const request=JSON.parse(options.body);let result;
    if(request.method==='getGenesisHash')result=await m.connection.getGenesisHash();
    else {
      assert.equal(request.method,'getMultipleAccounts');
      const read=await m.connection.getMultipleAccountsInfoAndContext(request.params[0].map(key=>new PublicKey(key)),request.params[1]);
      result={...read,value:read.value.map(account=>({...account,owner:account.owner.toBase58(),data:[account.data.toString('base64'),'base64'],lamports:1,rentEpoch:0}))};
    }
    const body=JSON.stringify({jsonrpc:'2.0',id:request.id,result}),length=Buffer.byteLength(body);
    encodedCalls.push({method:request.method,params:request.params,length});
    if(length>limit)throw Error('Provider response is too large.');
    return new Response(body,{status:200,headers:{'content-type':'application/json'}});
  }});
  await assert.rejects(connection.getMultipleAccountsInfoAndContext(proofs.map(p=>new PublicKey(p.programData)),{commitment:'finalized'}),/response is too large/);
  assert.ok(encodedCalls[0].length>limit);
  encodedCalls.length=0;m.calls.length=0;
  assert.equal((await verifyDammPumpVenues({connection})).cached,false);
  assert.ok(encodedCalls.every(c=>c.length<limit));
  const full=encodedCalls.filter(c=>c.method==='getMultipleAccounts'&&!c.params[1].dataSlice);
  assert.equal(full.length,proofs.length);assert.ok(full.every(c=>c.params[0].length===1));
  assert.ok(full.reduce((n,c)=>n+c.length,0)>limit,'the verified bytes were split, not omitted');
  assert.deepEqual(encodedCalls.filter(c=>c.params?.[1]?.dataSlice).map(c=>c.params[1].dataSlice),[{offset:0,length:45},{offset:0,length:45}]);
});

test('full ELF verification is cached with fresh finalized headers and bounded TTL',{skip:SKIP},async()=>{
  const m=mock();let at=1000;
  assert.equal((await verifyDammPumpVenues({connection:m.connection,now:()=>at})).cached,false);
  assert.equal(m.calls.length,5);assert.equal(fullCalls(m).length,3);
  assert.equal((await verifyDammPumpVenues({connection:m.connection,now:()=>at})).cached,true);
  assert.equal(m.calls.length,6);assert.ok(m.calls[5].options.dataSlice);
  at+=300_000;
  assert.equal((await verifyDammPumpVenues({connection:m.connection,now:()=>at})).cached,false);
  assert.equal(m.calls.length,11);assert.equal(fullCalls(m).length,6);
  assert.ok(m.calls.every(c=>c.options.minContextSlot>=0));
});

test('simultaneous scans coalesce executable reads',{skip:SKIP},async()=>{
  const m=mock();await Promise.all(Array.from({length:12},()=>verifyDammPumpVenues({connection:m.connection})));
  assert.equal(fullCalls(m).length,3);assert.equal(m.calls.length,5);
  assert.deepEqual(fullCalls(m).map(c=>c.keys),proofs.map(p=>[p.programData]));
});

test('wrong chain, loader owner, ProgramData identity, and deployment slot fail closed',{skip:SKIP},async()=>{
  for(const mutation of [m=>{m.state.genesis='devnet';},m=>{m.state.headerMutation=v=>{v[0].owner=new PublicKey(proofs[0].programId);};},m=>{m.state.headerMutation=v=>{v[0].data[4]^=1;};},m=>{m.state.headerMutation=v=>{v[1].data.writeBigUInt64LE(1n,4);};}]){
    const m=mock();mutation(m);await assert.rejects(verifyDammPumpVenues({connection:m.connection}),isProof);
  }
});

test('every executable requires its exact bytes, length, loader, and account count',{skip:SKIP},async()=>{
  for(const proof of proofs)for(const mutation of [v=>{v[0].data[100]^=1;},v=>{v[0].data=v[0].data.subarray(0,-1);},v=>{v[0].data=Buffer.concat([v[0].data,Buffer.from([0])]);},v=>{v[0].owner=new PublicKey(proof.programId);},v=>{v[0].executable=true;},v=>{v.push(v[0]);},v=>{v[0]=null;}]){
    const m=mock();m.state.fullMutation=(value,calls)=>{if(calls.at(-1).keys[0]===proof.programData)mutation(value);};
    await assert.rejects(verifyDammPumpVenues({connection:m.connection}),isProof);
    assert.equal(fullCalls(m).at(-1).keys[0],proof.programData,'no later executable is trusted after failure');
  }
});

test('an upgrade between sequential reads or after the final read fails closed',{skip:SKIP},async()=>{
  const racing=mock();racing.state.fullMutation=(_value,calls)=>{if(calls.at(-1).keys[0]===proofs[0].programData)racing.headers[1].writeBigUInt64LE(1n,4);};
  await assert.rejects(verifyDammPumpVenues({connection:racing.connection}),/PumpSwap executable differs/);
  const after=mock();after.state.fullMutation=(_value,calls)=>{if(calls.at(-1).keys[0]===proofs.at(-1).programData)after.state.headerMutation=v=>{v[1].data[13]^=1;};};
  await assert.rejects(verifyDammPumpVenues({connection:after.connection}),/changed during verification/);
});

test('sequential executable and closing-header reads advance the minimum snapshot slot',{skip:SKIP},async()=>{
  const m=mock();m.state.fullMutation=()=>{m.state.slot+=10;};
  const checked=await verifyDammPumpVenues({connection:m.connection});
  assert.deepEqual(m.calls.map(c=>c.options.minContextSlot),[0,500000000,500000010,500000020,500000030]);
  assert.equal(checked.slot,500000030);
  const stale=mock();stale.state.fullMutation=(_value,calls)=>{stale.state.slot+=calls.at(-1).keys[0]===proofs[0].programData?10:-1;};
  await assert.rejects(verifyDammPumpVenues({connection:stale.connection}),/snapshot is outdated/);
  assert.equal(fullCalls(stale).length,2);
});

test('cached proof never masks a changed header and stale snapshots are rejected',{skip:SKIP},async()=>{
  const m=mock();await verifyDammPumpVenues({connection:m.connection});m.state.headerMutation=v=>{v[1].data.writeBigUInt64LE(2n,4);};
  await assert.rejects(verifyDammPumpVenues({connection:m.connection}),/deployment differs/);
  const stale=mock();stale.state.fullMutation=()=>{stale.state.slot--;};
  await assert.rejects(verifyDammPumpVenues({connection:stale.connection}),/snapshot is outdated/);
  await assert.rejects(verifyDammPumpVenues({connection:mock().connection,cacheTtlMs:300_001}),/cache lifetime is invalid/);
});

test('transport failures are retryable, hide provider secrets, and invalidate cached proofs',{skip:SKIP},async()=>{
  const m=mock();await verifyDammPumpVenues({connection:m.connection});
  m.state.failure=Error('429 https://rpc.fixture.invalid/?api-key=private-test-secret');
  await assert.rejects(verifyDammPumpVenues({connection:m.connection}),error=>{
    assert.equal(error.statusCode,503);assert.equal(error.code,'DAMM_VENUE_RPC');assert.equal(error.retryable,true);
    assert.match(error.message,/temporarily unavailable/);assert.doesNotMatch(error.message,/fixture|private-test-secret|compatibility review|venue changed/);return true;
  });
  m.state.failure=null;
  assert.equal((await verifyDammPumpVenues({connection:m.connection})).cached,false);
  assert.equal(fullCalls(m).length,6,'recovery must re-read all executables after an RPC failure');
});
