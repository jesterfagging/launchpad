import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { PUMP_SDK, getPumpProgram, pumpIdl, bondingCurvePda } from '@pump-fun/pump-sdk';
import BN from 'bn.js';
import bs58 from 'bs58';
import { detectLaunches, pumpLaunchLogs } from '../src/launch-signals.mjs';
import { SniperEngine } from '../src/sniper.mjs';
import { cleanSniper, sniperRunSettings } from '../public/sniper-settings.mjs';
import { PUMP, SOL, validateConfig } from '../src/core.mjs';
import { key1, key2, mint, quote, config, event } from './fixtures.mjs';
const developer=key1.publicKey.toBase58(), other=key2.publicKey.toBase58();
const coder=getPumpProgram(null).coder.types;
function createLogs(extra={}) {
 const body=coder.encode('createEvent',{name:'test',symbol:'TEST',uri:'https://example.com',mint:new PublicKey(mint),bondingCurve:bondingCurvePda(new PublicKey(mint)),user:key1.publicKey,creator:key2.publicKey,timestamp:new BN(1),virtualTokenReserves:new BN(1),virtualSolReserves:new BN(1),realTokenReserves:new BN(1),tokenTotalSupply:new BN(1000),tokenProgram:TOKEN_2022_PROGRAM_ID,isMayhemMode:false,isCashbackEnabled:false,quoteMint:PublicKey.default,virtualQuoteReserves:new BN(1),creatorFeeBps:new BN(0),isHolderReward:false,...extra});
 const data=Buffer.concat([Buffer.from(pumpIdl.events.find(e=>e.name==='CreateEvent').discriminator),body]);
 return {err:null,logs:[`Program ${PUMP} invoke [1]`,`Program data: ${data.toString('base64')}`,`Program ${PUMP} success`]};
}
async function transaction(quoteMint=SOL) {
 const ix=await PUMP_SDK.createV2Instruction({mint:new PublicKey(mint),name:'Test',symbol:'TEST',uri:'https://example.com',creator:key2.publicKey,user:key1.publicKey,mayhemMode:false,quoteMint:new PublicKey(quoteMint)});
 return {meta:{err:null,logMessages:[],innerInstructions:[]},transaction:{message:{accountKeys:[{pubkey:developer,signer:true},{pubkey:mint,signer:true}],instructions:[{programId:PUMP,accounts:ix.keys.map(k=>k.pubkey.toBase58()),data:bs58.encode(ix.data)}]}}};
}
test('authenticated Pump creation events use the creating user, not an arbitrary creator field',()=>{
 const value=createLogs(); const launches=pumpLaunchLogs(value,[developer]); assert.equal(launches.length,1); assert.equal(launches[0].lead,developer); assert.equal(launches[0].outputMint,mint);
 assert.deepEqual(pumpLaunchLogs(value,[other]),[]);
 assert.deepEqual(pumpLaunchLogs({...value,err:'Failed'},[developer]),[]);
 assert.deepEqual(pumpLaunchLogs({err:null,logs:value.logs.slice(0,-1)},[developer]),[]);
 assert.deepEqual(pumpLaunchLogs({err:null,logs:value.logs.map(l=>l.replace(PUMP,quote))},[developer]),[]);
 assert.deepEqual(pumpLaunchLogs(createLogs({bondingCurve:key2.publicKey}),[developer]),[]);
 assert.equal(pumpLaunchLogs(createLogs({quoteMint:new PublicKey(quote)}),[developer])[0].inputMint,quote);
});
test('creation instruction decoding verifies developer signer and resolves non-SOL quote remaining accounts',async()=>{
 const sol=await transaction(), quoted=await transaction(quote);
 assert.equal(detectLaunches(sol,[developer])[0].inputMint,SOL); assert.equal(detectLaunches(quoted,[developer])[0].inputMint,quote);
 assert.deepEqual(detectLaunches(quoted,[other]),[]);
 quoted.transaction.message.accountKeys[0].signer=false; assert.deepEqual(detectLaunches(quoted,[developer]),[]);
 sol.meta.err={InstructionError:[0,'Failed']}; assert.deepEqual(detectLaunches(sol,[developer]),[]);
});
test('developer address lists allow 100 unique public wallets and reject excess or malformed entries',()=>{
 const keys=Array.from({length:101},(_,i)=>new PublicKey(Uint8Array.from({length:32},(_,j)=>j===0?i:1)).toBase58());
 assert.equal(cleanSniper({developers:keys.slice(0,100).join('\n')}).developers.split('\n').length,100);
 assert.throws(()=>cleanSniper({developers:keys.join('\n')}),/100/); assert.throws(()=>cleanSniper({developers:'not/a/wallet'}),/addresses/);
});
test('a launch buys once across duplicate streams and restarts; normal buys never trigger sniper entries, and developer sells can exit',async()=>{
 const data={lots:[],pending:[],events:[],seen:[]}, ledger={data,async save(){},addEvent(e){data.events.push(e);},async remember(k){if(data.seen.includes(k))return false;data.seen.push(k);return true;}};
 const e=new SniperEngine({live:ledger,paper:ledger}); e.c=validateConfig(sniperRunSettings({...config({wallets:[key2]}),sniper:{developers:developer,sellMode:'mirror'}})); e.accepting=true; e.abort=new AbortController();
 e.p={markets:async()=>{},market:new Map(),knownPrograms:new Set()}; let buys=0,sells=0; e.buy=async()=>{buys++;};e.mirrorSell=async()=>{sells++;};
 const launch=pumpLaunchLogs(createLogs(),[developer]);
 await e.onTransaction({...event(undefined,'create-a'),tx:undefined,launches:launch}); await e.onTransaction({...event(undefined,'create-b'),tx:undefined,launches:launch});
 await Promise.all([...e.queues.values()]); assert.equal(buys,1);
 e.incoming.clear(); await e.onTransaction({...event(undefined,'create-c'),tx:undefined,launches:launch}); await Promise.all([...e.queues.values()]); assert.equal(buys,1);
 await e.onTransaction({...event(undefined,'later-buy'),tx:undefined,decoded:{lead:developer,inputMint:SOL,outputMint:mint}}); await Promise.all([...e.queues.values()]); assert.equal(buys,1);
 await e.onTransaction({...event(undefined,'later-sell'),tx:undefined,decoded:{lead:developer,inputMint:mint,outputMint:SOL,inputPre:100n,inputAmount:100n}}); await Promise.all([...e.queues.values()]); assert.equal(sells,1);
 e.accepting=false; await e.onTransaction({...event(undefined,'stopped'),tx:undefined,launches:[{...launch[0],outputMint:quote}]}); assert.equal(buys,1);
});
