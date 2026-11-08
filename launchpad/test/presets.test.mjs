import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreset, readPreset, settingIds } from '../public/presets.mjs';

test('full presets preserve all credentials, URLs, run mode and 20 wallet keys exactly',()=>{
  const settings={leads:'lead-one\nlead-two',mode:'live',amountMode:'custom',buyAmount:'0.12',sendRpc:true,simulateBeforeSend:false,fastPumpLogs:true,streamMode:'logs',
    prioritySol:'0.001',jitoSol:'0.002',heliusSol:'0.003',heliusKey:'test-helius-key',jupiterKey:'test-jupiter-key',
    rpcUrl:'https://rpc.example/?api-key=a%2Bb%3Dc',wsUrl:'wss://ws.example/token/path?auth=xyz',
    jitoUrl:'https://jito.example/api/v1/transactions',jitoAuth:'test-auth-id',senderUrl:'https://sender.example/fast?swqos_only=true',
    wallets:Array.from({length:20},(_,i)=>({label:`Wallet ${i}`,publicKey:`public-${i}`,privateKey:i%2?'seed:test-seed-'+i:'[1, 2, 3, 4]',amount:`0.${i+1}`}))};
  const result=readPreset(JSON.stringify(createPreset(settings)));assert.deepEqual(result,settings);
  assert(settingIds.includes('rpcUrl'));assert(settingIds.includes('jitoAuth'));
});

test('old presets still load, while malformed or unrelated input never echoes secrets in errors',()=>{
  const old={mode:'paper',leads:'lead',wallets:[{label:'Follower',publicKey:'address',amount:'0.05'}]};
  assert.equal(readPreset(JSON.stringify(old)).wallets[0].privateKey,'');
  assert.equal(readPreset(JSON.stringify(old)).mode,'live');
  assert.equal(createPreset({wallets:[]}).mode,'live');
  const secret='do-not-echo-this-test-secret';
  for(const value of [null,[],{state:'running',followers:[]},{wallets:Array(65).fill({})},{wallets:[],heliusKey:{secret}},{wallets:[{privateKey:{secret}}]},{wallets:[],sendRpc:'true'},{format:'relay-settings',version:99,wallets:[]}]) {
    assert.throws(()=>readPreset(JSON.stringify(value)),error=>!error.message.includes(secret));
  }
  assert.throws(()=>readPreset('{'+secret),error=>!error.message.includes(secret));
});

test('preset data is whitelisted and does not mutate the original form values',()=>{
  const input=JSON.parse('{"mode":"paper","wallets":[{"privateKey":"test-secret","amount":"0.05","extra":"ignored"}],"__proto__":{"polluted":true},"events":["ignored"]}');
  const snapshot=JSON.stringify(input),result=createPreset(input);
  assert.equal(result.mode,'live');
  assert.equal(JSON.stringify(input),snapshot);assert.equal(result.wallets[0].privateKey,'test-secret');
  assert(!Object.hasOwn(result,'__proto__'));assert(!Object.hasOwn(result,'events'));assert(!Object.hasOwn(result.wallets[0],'extra'));assert.equal({}.polluted,undefined);
});
