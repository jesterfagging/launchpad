import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PublicKey, Connection } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ExtensionType, getTypeLen, unpackMint } from '@solana/spl-token';
import { associatedTokenAccountSize } from '../src/launchpad-token-account-size.mjs';
import { LaunchChain, ray, decodeRay, newLaunchKeys } from '../src/launchpad-chain.mjs';
import { Launchpad } from '../src/launchpad.mjs';
import { provisionRewardsWallet } from '../src/launchpad-rewards-wallet.mjs';

const pk=value=>new PublicKey(value);
const tlv=(type,length=type===16?129:getTypeLen(type))=>{const out=Buffer.alloc(4+length);out.writeUInt16LE(type);out.writeUInt16LE(length,2);return out;};
const mintInfo=(types,program=TOKEN_2022_PROGRAM_ID)=>({program,mint:{tlvData:Buffer.concat(types.map(type=>tlv(type)))}});

test('ordinary ATAs use mandatory token extensions and ImmutableOwner, not optional confidential balances',()=>{
  assert.equal(associatedTokenAccountSize(mintInfo([],TOKEN_PROGRAM_ID)),165);
  assert.equal(associatedTokenAccountSize(mintInfo([])),170);
  assert.equal(associatedTokenAccountSize(mintInfo([1])),182);
  assert.equal(associatedTokenAccountSize(mintInfo([14])),175);
  assert.equal(associatedTokenAccountSize(mintInfo([4,1,16,14,26])),191);
  assert.equal(associatedTokenAccountSize(mintInfo([9])),174);
});

test('unknown or account-only TLVs and malformed confidential fee mint state fail closed',()=>{
  for(const type of [2,5,7,15,17,24,99])assert.throws(()=>associatedTokenAccountSize({program:TOKEN_2022_PROGRAM_ID,mint:{tlvData:tlv(type,0)}}),/Unsupported mint extension/);
  assert.throws(()=>associatedTokenAccountSize(mintInfo([16])),/invalid confidential/);
  const invalid=mintInfo([1,4,16]);const feeOffset=tlv(1).length+tlv(4).length+4;invalid.mint.tlvData[feeOffset+64]=2;
  assert.throws(()=>associatedTokenAccountSize(invalid),/invalid confidential/);
  assert.throws(()=>associatedTokenAccountSize(mintInfo([14,14])),/duplicated/);
  assert.throws(()=>associatedTokenAccountSize({program:TOKEN_2022_PROGRAM_ID,mint:{tlvData:tlv(14,63)}}),/invalid size/);
  assert.throws(()=>associatedTokenAccountSize({program:TOKEN_2022_PROGRAM_ID,mint:{tlvData:Buffer.from([1,0])}}),/truncated/);
  assert.throws(()=>associatedTokenAccountSize(mintInfo([14],TOKEN_PROGRAM_ID)),/legacy/);
  const padded=mintInfo([14]);padded.mint.tlvData=Buffer.concat([padded.mint.tlvData,Buffer.alloc(9)]);assert.equal(associatedTokenAccountSize(padded),175);
});

const captured=JSON.parse(await readFile(new URL('./fixtures/provider-previews-v59.json',import.meta.url),'utf8'));
const account=raw=>raw?{...raw,owner:pk(raw.owner),data:Buffer.from(raw.data[0],'base64')}:null;
const capturedInfo=mint=>{const raw=account(captured.accounts[mint]);return{key:pk(mint),program:raw.owner,mint:unpackMint(pk(mint),raw,raw.owner)};};
function replay(){
  const requested=[];
  const fetcher=async(url,options={})=>{
    if(!options.body){const value=captured.market.find(row=>row.url===String(url));assert(value,'Uncaptured market request: '+url);return Response.json(value.response,{status:value.status});}
    const req=JSON.parse(options.body);requested.push(req.method);let result;
    if(req.method==='getAccountInfo'){assert(Object.hasOwn(captured.accounts,req.params[0]),'Uncaptured account '+req.params[0]);result={context:captured.configCapture.result.context,value:captured.accounts[req.params[0]]};}
    else if(req.method==='getProgramAccounts'&&req.params[0]===ray.LAUNCHPAD_PROGRAM.toBase58()){
      const filter=req.params[1].filters.find(x=>x.memcmp)?.memcmp;
      result=captured.configCapture.result.value.filter(row=>!filter||decodeRay(account(row.account),ray.LAUNCHPAD_PROGRAM,ray.LaunchpadConfig,'GlobalConfig').mintB.toBase58()===filter.bytes);
    }else{
      const value=captured.rpc.find(row=>row.method===req.method&&(req.method==='getMinimumBalanceForRentExemption'?row.params[0]===req.params[0]:JSON.stringify(row.params)===JSON.stringify(req.params||[])));
      assert(value,'Uncaptured RPC request '+JSON.stringify(req));assert(!value.response.error);result=value.response.result;
    }
    return Response.json({jsonrpc:'2.0',id:req.id,result});
  };
  const connection=new Connection('https://captured.invalid',{commitment:'finalized',disableRetryOnRateLimit:true,fetch:fetcher});
  return{chain:new LaunchChain({network:'mainnet-beta',connection,fetcher}),requested};
}

for(const asset of captured.assets)test(`captured ${asset.symbol} mint/price/config passes both launch modes with exact ATA rent`,async()=>{
  const {chain,requested}=replay(),accounts={hostStore:{read:async(name,fallback)=>name==='launch-protocol-fees'?captured.protocolFees:fallback}};
  await chain.init();
  for(const feeMode of ['creator','holders']){
    const input=await Launchpad.prototype.newLaunchInput.call({accounts},'audit',{name:'Pair check',symbol:'PAIR',quoteMint:asset.mint,feeMode,devBuySol:'0'});
    const review=await chain.preview(input);
    assert.equal(review.platformFeeBps,100);assert.equal(review.creatorFeeBps,feeMode==='creator'?50:0);assert.match(review.lp,/75%.*locked.*25%.*burned/);
    assert(Math.abs(Number(review.actualUsd)-20000)<.01);assert(Math.abs(Number(review.graduationUsd)-50000)<.01);
  }
  assert(requested.every(method=>['getAccountInfo','getProgramAccounts','getMinimumBalanceForRentExemption','getGenesisHash','getEpochInfo'].includes(method)));
});

test('captured PreStocks quote funds both holder setup and later rewards-wallet ATA handoff',async()=>{
  const asset=captured.assets.find(a=>a.symbol==='ANDURIL'),info=capturedInfo(asset.mint),sizes=[];
  assert.equal(associatedTokenAccountSize(info),191);
  const chain=new LaunchChain({network:'mainnet-beta',connection:{getMinimumBalanceForRentExemption:async size=>{sizes.push(size);return 1000000+size*10;},getBalance:async()=>50000000,getAccountInfo:async()=>null}});
  const funding=await chain.fundingEstimate({feeMode:'holders',feeCustody:'relay',taxBps:200,walletMode:'external',quoteMint:asset.mint},info);
  assert.equal(funding.serviceReserve,String(21000000+1001820+1001910));assert(sizes.includes(182));assert(sizes.includes(191));
  const launch={id:'a'.repeat(32),feeCustody:'relay',keys:{...newLaunchKeys(),rewards:newLaunchKeys().wallet},input:{route:'raydium',quoteMint:asset.mint,feeMode:'holders',taxBps:200},credits:{base:'0',quote:'100'}};
  provisionRewardsWallet(launch,1);launch.rewardsWallet.status='active';chain.mintInfo=async()=>info;sizes.length=0;
  const plan=await chain.rewardsGasFundingPlan(launch);assert.equal(plan.ready,true);assert.deepEqual(sizes,[191]);assert.equal(plan.handoffCostLamports,'1051910');
});
