import test from 'node:test';
import assert from 'node:assert/strict';
import {Connection,PublicKey} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID} from '@solana/spl-token';
import {PublicCoinHolders,holderLpVaults} from '../src/public-coin-holders.mjs';
import {ray} from '../src/launchpad-chain.mjs';
import {pumpClassicDiscoveryRecord} from '../src/launchpad-explore.mjs';
import {PumpClassicService,generateWallet} from '../src/pump-classic/service.mjs';
import {coinAddresses} from '../src/pump-classic/instructions.mjs';
const key=n=>new PublicKey(Buffer.alloc(32,n));
function token(mint=key(1),wallet=key(2),amount=2500000n,program=TOKEN_PROGRAM_ID){
  const data=Buffer.alloc(program.equals(TOKEN_PROGRAM_ID)?165:166);mint.toBuffer().copy(data);wallet.toBuffer().copy(data,32);data.writeBigUInt64LE(amount,64);data[108]=1;if(data.length>165)data[165]=2;
  return {owner:program,data,executable:false,lamports:2039280,rentEpoch:0};
}
function mint(program=TOKEN_PROGRAM_ID){const data=Buffer.alloc(82);data.writeBigUInt64LE(10000000n,36);data[44]=6;data[45]=1;return {owner:program,data,executable:false,lamports:1461600,rentEpoch:0};}
function rpc(patch={}){return {getAccountInfo:async()=>mint(),getTokenLargestAccounts:async()=>({value:[{address:key(3)}]}),getMultipleAccountsInfo:async()=>[token()],...patch};}
function launch(){const base=key(1),quote=key(7);return {curve:ray.getPdaLaunchpadPoolId(ray.LAUNCHPAD_PROGRAM,base,quote).publicKey.toBase58(),input:{network:'mainnet-beta',route:'raydium',quoteMint:quote.toBase58()},review:{cpConfigId:key(8).toBase58()},keys:{mint:{address:base.toBase58()}}};}

test('public holder snapshots verify mint ownership, show raw balances and cache shared reads',async()=>{
  let reads=0;const c=rpc({getTokenLargestAccounts:async()=>{reads++;return {value:[{address:key(3)}]};}});
  const service=new PublicCoinHolders({chain:async()=>({c}),now:()=>123});
  const [one,two]=await Promise.all([service.read(key(1).toBase58()),service.read(key(1).toBase58())]);assert.deepEqual(one,two);assert.equal(reads,1);assert.equal(one.holders[0].amount,'2.5');assert.equal(one.holders[0].percent,25);assert.equal(one.holders[0].wallet,key(2).toBase58());
  const wrong=await service.read(key(4).toBase58());assert.equal(wrong.available,false);assert.deepEqual(wrong.holders,[]);await service.close();
});
test('RPC errors do not expose endpoints, credentials or invented holder counts',async()=>{
  const service=new PublicCoinHolders({chain:async()=>{throw Error('https://secret-rpc/?key=SECRET');}});const result=await service.read(key(1).toBase58());assert.equal(result.available,false);assert.doesNotMatch(JSON.stringify(result),/SECRET|secret-rpc/);assert.equal(result.total,undefined);assert.match(result.note,/public Solana RPC/);await service.close();
});

test('binary mint supply and mint-scoped fallback work through real web3 transport for SPL and Token-2022',async()=>{
  for(const program of [TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID]){
    const calls=[],record=launch(),vaults=holderLpVaults(key(1),record),[vault,lp]=[...vaults][0];
    const wire=info=>({...info,owner:info.owner.toBase58(),data:[info.data.toString('base64'),'base64']});
    const c=new Connection('https://rpc.example.com',{fetch:async(_url,options)=>{
      const req=JSON.parse(options.body);calls.push(req);let result,error;
      if(req.method==='getAccountInfo')result={context:{slot:100},value:wire(mint(program))};
      else if(req.method==='getTokenLargestAccounts')error={code:-32004,message:'Method unavailable on this RPC plan'};
      else if(req.method==='getProgramAccounts')result=[{pubkey:key(3).toBase58(),account:wire(token(key(1),key(2),1000000n,program))},{pubkey:vault,account:wire(token(key(1),new PublicKey(lp.authority),9000000n,program))}];
      else assert.fail('Unexpected RPC '+req.method);
      return new Response(JSON.stringify({jsonrpc:'2.0',id:req.id,...(error?{error}:{result})}),{headers:{'Content-Type':'application/json'}});
    }});
    const service=new PublicCoinHolders({chain:async()=>({c})});
    const data=await service.read(key(1).toBase58(),record);
    assert.equal(data.available,true);assert.equal(data.holders[0].amount,'9');assert.equal(data.holders[0].percent,90);assert.equal(data.holders[0].isLp,true);assert.equal(data.holders[0].lpType,'curve');assert.equal(data.holders[1].isLp,false);
    const scan=calls.find(row=>row.method==='getProgramAccounts');assert.equal(scan.params[0],program.toBase58());assert.deepEqual(scan.params[1].dataSlice,{offset:0,length:166});assert.deepEqual(scan.params[1].filters[0],{memcmp:{offset:0,bytes:key(1).toBase58(),encoding:'base58'}});assert(!calls.some(call=>call.method==='getTokenSupply'));await service.close();
  }
});
test('only exact launch and migrated vault addresses with the correct authority receive LP labels',async()=>{
  const record=launch(),vaults=holderLpVaults(key(1),record),entries=[...vaults];assert.equal(entries.length,2);
  const c=rpc({getTokenLargestAccounts:async()=>({value:entries.map(([address])=>({address:new PublicKey(address)}))}),getMultipleAccountsInfo:async()=>entries.map(([,lp])=>token(key(1),new PublicKey(lp.authority),2500000n))});
  const service=new PublicCoinHolders({chain:async()=>({c})}),data=await service.read(key(1).toBase58(),record);
  assert.deepEqual(data.holders.map(row=>row.lpType),['curve','pool']);assert(data.holders.every(row=>row.isLp));await service.close();
  for(const [address,owner]of [[entries[0][0],key(2)],[key(3).toBase58(),new PublicKey(entries[0][1].authority)]]){
    const bad=new PublicCoinHolders({chain:async()=>({c:rpc({getTokenLargestAccounts:async()=>({value:[{address:new PublicKey(address)}]}),getMultipleAccountsInfo:async()=>[token(key(1),owner)]})})});
    assert.equal((await bad.read(key(1).toBase58(),record)).holders[0].isLp,false);await bad.close();
  }
  assert.equal(holderLpVaults(key(1),{...record,curve:key(5).toBase58()}).size,0);
});
test('temporary provider failures preserve the last good snapshot and retry after ten seconds',async()=>{
  let now=1000,failed=false,reads=0;
  const c=rpc({getAccountInfo:async()=>{reads++;if(failed)throw Error('SECRET');return mint();},getTokenLargestAccounts:async()=>{if(failed)throw Error('SECRET');return {value:[{address:key(3)}]};}});
  const service=new PublicCoinHolders({chain:async()=>({c}),now:()=>now});const first=await service.read(key(1).toBase58());
  now+=61000;failed=true;const stale=await service.read(key(1).toBase58());assert.equal(stale.available,true);assert.equal(stale.stale,true);assert.equal(stale.at,first.at);assert.deepEqual(stale.holders,first.holders);assert.doesNotMatch(JSON.stringify(stale),/SECRET/);
  await Promise.all(service.pending.values());now+=5000;failed=false;assert.equal((await service.read(key(1).toBase58())).stale,true);assert.equal(reads,2);
  now+=6000;assert.equal((await service.read(key(1).toBase58())).stale,true);await Promise.all(service.pending.values());assert.equal((await service.read(key(1).toBase58())).stale,false);assert.equal(reads,3);
  now+=16*60000;failed=true;assert.equal((await service.read(key(1).toBase58())).available,false);await service.close();
});
test('caller deadline keeps timed-out work coalesced and publishes it once complete',async()=>{
  let finish,reads=0;const gate=new Promise(resolve=>{finish=resolve;});
  const service=new PublicCoinHolders({waitMs:5,chain:async()=>({c:rpc({getAccountInfo:async()=>{reads++;await gate;return mint();}})})});
  const first=await service.read(key(1).toBase58());assert.equal(first.available,false);assert.equal(service.pending.size,1);
  const again=await service.read(key(1).toBase58());assert.equal(again.available,false);assert.equal(reads,1);
  finish();await Promise.allSettled(service.pending.values());assert.equal((await service.read(key(1).toBase58())).available,true);await service.close();
});
test('fallback rejects unrelated mint/program accounts and truncated excessive scans',async()=>{
  for(const rows of [[{pubkey:key(3),account:token(key(9))}],[{pubkey:key(3),account:token(key(1),key(2),1n,TOKEN_2022_PROGRAM_ID)}],Array(10001).fill({pubkey:key(3),account:token()})]){
    const service=new PublicCoinHolders({chain:async()=>({c:rpc({getTokenLargestAccounts:async()=>{throw Error('not supported');},getProgramAccounts:async()=>rows})})});
    assert.equal((await service.read(key(1).toBase58())).available,false);await service.close();
  }
});

test('different cold mints retain their queue positions after callers time out',async()=>{
  let release,reads=0;const gate=new Promise(resolve=>{release=resolve;});
  const c=rpc({getAccountInfo:async()=>{reads++;await gate;return mint();},getTokenLargestAccounts:async()=>({value:[]})});
  const service=new PublicCoinHolders({waitMs:5,chain:async()=>({c})});
  try{
    const first=await Promise.all([1,2,3,4].map(n=>service.read(key(n).toBase58())));
    assert(first.every(row=>!row.available));assert.equal(reads,2);assert.equal(service.pending.size,4);
    release();await Promise.all(service.pending.values());assert.equal(reads,4);
    const recovered=await Promise.all([1,2,3,4].map(n=>service.read(key(n).toBase58())));assert(recovered.every(row=>row.available));assert.equal(reads,4);
  }finally{release();await service.close();}
});

test('known holder balances return immediately and keep their timestamp during an active slow refresh',async()=>{
  let now=1000,blocked=false,release;const gate=new Promise(resolve=>{release=resolve;});
  const c=rpc({getAccountInfo:async()=>{if(blocked)await gate;return mint();}}),service=new PublicCoinHolders({chain:async()=>({c}),now:()=>now});
  const original=await service.read(key(1).toBase58());now+=61000;blocked=true;let timer;
  try{
    const rows=await Promise.race([Promise.all([service.read(key(1).toBase58()),service.read(key(1).toBase58())]),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),200);})]);
    assert(rows,'last-good holders must not wait for the RPC');assert(rows.every(row=>row.available&&row.stale&&row.at===original.at&&row.refreshing));
  }finally{clearTimeout(timer);blocked=false;release();await Promise.all(service.pending.values());await service.close();}
});

test('a Pump.fun coin marks its bonding curve vault, and once graduated its canonical PumpSwap pool vault, as LP',()=>{
  // The record exactly as discovery builds it from the Pump.fun service's public row.
  const service=new PumpClassicService({config:{enabled:false}}),now=Date.now(),mint=generateWallet().address,key=new PublicKey(mint),a=coinAddresses(mint);
  const record=(venue,pair={})=>pumpClassicDiscoveryRecord(service.publicRow({id:'a'.repeat(24),account_id:'acct',mint,name:'Scout',symbol:'SCOUT',description:'',image:'',live_at:now-1000,created_at:now-2000,mode:'creator',venue_state:venue,website:'',twitter:'',telegram:'',gotchi:null,agent:null,hidden:false,creator_fee_bps:0,...pair}),now).chainRecord;
  const curve=[a.associatedBondingCurve,{authority:a.bondingCurve,lpType:'curve'}],pool=[a.poolBaseTokenAccount,{authority:a.canonicalPool,lpType:'pool'}];
  assert.deepEqual([...holderLpVaults(key,record('curve'))],[curve],'on the curve: its token account, owned by the bonding curve');
  assert.deepEqual([...holderLpVaults(key,record('amm'))],[curve,pool],'graduated: the canonical pool base vault too');
  const graduated=record('amm'),other=generateWallet().address;
  assert.equal(holderLpVaults(key,{...graduated,curve:other}).size,0,'a curve that is not the mint’s own PDA marks nothing');
  assert.deepEqual([...holderLpVaults(key,{...graduated,review:{...graduated.review,poolId:other}})],[curve],'only the canonical pool is a pool');
  assert.equal(holderLpVaults(new PublicKey(other),graduated).size,0,'another mint marks nothing');
  // Another pair: the canonical pool depends on the pair's mint, the curve vault does not.
  const usdc='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',token='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',paired=coinAddresses(mint,{mint:usdc,program:token});
  assert.deepEqual([...holderLpVaults(key,record('amm',{quote_mint:usdc,quote_program:token,quote_decimals:6,quote_symbol:'USDC',quote_kind:'listed'}))],[curve,[paired.poolBaseTokenAccount,{authority:paired.canonicalPool,lpType:'pool'}]]);
});
