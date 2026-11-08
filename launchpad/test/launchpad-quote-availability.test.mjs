import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey} from '@solana/web3.js';
import {createHash} from 'node:crypto';
import {LAUNCH_ASSETS} from '../public/launch-assets.mjs';
import {launchQuoteAvailability,sunriseAsset} from '../src/launchpad-quotes.mjs';
import {Launchpad} from '../src/launchpad.mjs';
import {LaunchChain,ray} from '../src/launchpad-chain.mjs';

const monero=LAUNCH_ASSETS.find(asset=>asset.symbol==='XMR');
test('active PreStocks and wrapped Monero retain verified Solana identities',()=>{
  const preipo=LAUNCH_ASSETS.filter(asset=>asset.category==='preipo'&&asset.issuer==='PreStocks');
  assert.deepEqual(preipo.map(asset=>asset.symbol).sort(),['ANDURIL','ANTHROPIC','FIGUREAI','KALSHI','NEURALINK','OPENAI','POLYMARKET']);
  for(const asset of preipo){assert.equal(asset.issuer,'PreStocks');assert.equal(new URL(asset.source).hostname,'prestocks.com');assert.equal(new PublicKey(asset.mint).toBase58(),asset.mint);assert.equal(asset.supported,undefined);}
  assert.equal(monero.mint,'WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp');assert.equal(monero.category,'crypto');assert.match(monero.name,/wrapped on Solana/);assert.equal(monero.source,'https://wxmr.io/');
  assert(!LAUNCH_ASSETS.some(asset=>['PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh','PreC1KtJ1sBPPqaeeqL6Qb15GTLCYVvyYEwxhdfTwfx'].includes(asset.mint)));
  for(const asset of [monero,...preipo])assert.deepEqual(sunriseAsset({chain:'solana',address:asset.mint,symbol:asset.symbol,name:'Generic upstream label'}),asset);
});

test('Tessera issuer mints stay distinct from PreStocks and await actual Raydium availability',()=>{
  const expected={tSpaceX:'TSPXcLV76s6V2zDiZQ18kBfcbnjaE2ZzNT3ga2Pd99v',tKalshi:'TKLSidmLVt3cqGaaodG8tyRzoANfQwoh67AccjmubeZ',tOpenAI:'oPAiAikWTaFj9RYoRFD35ccfwhnMcB3ThgBZRHSkjTZ'},assets=LAUNCH_ASSETS.filter(a=>a.issuer==='Tessera');
  assert.equal(assets.length,3);
  for(const asset of assets){assert.equal(asset.mint,expected[asset.symbol]);assert.equal(new PublicKey(asset.mint).toBase58(),asset.mint);assert.equal(asset.category,'preipo');assert.equal(asset.source,'https://docs.tessera.pe/technicals/on-chain-programs');assert.equal(asset.supported,undefined);assert.equal(launchQuoteAvailability(asset,[]).supported,false);assert.deepEqual(sunriseAsset({chain:'solana',address:asset.mint,symbol:asset.symbol,name:'Generic upstream name'}),asset);}
  assert.notEqual(expected.tOpenAI,LAUNCH_ASSETS.find(a=>a.symbol==='OPENAI').mint);assert.notEqual(expected.tKalshi,LAUNCH_ASSETS.find(a=>a.symbol==='KALSHI').mint);
});

test('availability distinguishes unsupported mints from a failed live check',()=>{
  const stock=LAUNCH_ASSETS.find(asset=>asset.symbol==='INTC');
  assert.equal(launchQuoteAvailability(stock,[monero.mint]).supported,false);
  assert.match(launchQuoteAvailability(stock,[]).supportReason,/no bonding-curve launch configuration/);
  const unknown=launchQuoteAvailability(stock,null);assert.equal(unknown.supported,null);assert.match(unknown.supportReason,/could not be checked/);
  const approved=launchQuoteAvailability(monero,[monero.mint]);assert.equal(approved.supported,true);assert.equal(approved.supportReason,'');
  assert.equal(stock.supported,undefined,'availability never mutates issuer catalogue entries');
});

test('concurrent quote checks coalesce per account and cache only verified results',async()=>{
  let now=100000,calls=0,closed=0,release;
  const gate=new Promise(resolve=>{release=resolve;}),service=new Launchpad({},null,{now:()=>now,quoteCatalogue:{read:async()=>({assets:[monero]}),close(){}}});
  service.chain=async()=>({approvedQuotes:async()=>{calls++;await gate;return[monero.mint];},close:()=>closed++});
  try{
    const a=service.quotes('alice'),b=service.quotes('alice');await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);release();
    assert.equal((await a).assets[0].supported,true);assert.equal((await b).assets[0].supported,true);assert.equal(closed,1);
    await service.quotes('alice');assert.equal(calls,1);
    await service.quotes('bob');assert.equal(calls,2,'one account does not use another account RPC result');
    now+=60001;service.chain=async()=>({approvedQuotes:async()=>{throw Error('provider failed');},close:()=>closed++});
    assert.equal((await service.quotes('alice')).assets[0].supported,null,'expired positive checks cannot imply fresh support after provider failure');
  }finally{await service.close();}
});

test('wallet-only launches cannot use a custodial payer or impersonate another connected wallet',async()=>{
  const wallet=monero.mint,service=new Launchpad({get:async()=>({authType:'wallet',mainWallet:wallet})},null);
  service.newLaunchInput=async(_id,raw)=>raw;
  await assert.rejects(service.normalized('visitor',{quoteMint:wallet,walletMode:'default'}),/Connect the wallet used to sign in/);
  await assert.rejects(service.normalized('visitor',{quoteMint:wallet,walletMode:'external',externalWallet:'So11111111111111111111111111111111111111112'}),/Connect the wallet used to sign in/);
});

test('catalogue keeps issuer-distinct stocks and includes expanded canonical crypto pairs without duplicate mints',()=>{
  assert.equal(new Set(LAUNCH_ASSETS.map(a=>a.mint)).size,LAUNCH_ASSETS.length);
  for(const symbol of ['INTCx','HOODx','MSTRx','SPCXx','NVDAx','MSFTx','AAPLx','QUBT','TTWO','RBLX','MON','LIT','USDT','RAY','AAVE','UNI'])assert.ok(LAUNCH_ASSETS.some(a=>a.symbol===symbol),symbol);
});

function configRow(mint,curveType=0,index=0){
  const data=Buffer.alloc(ray.LaunchpadConfig.span),mintB=new PublicKey(mint);
  ray.LaunchpadConfig.encode({...ray.LaunchpadConfig.decode(data),mintB,curveType,index},data);
  createHash('sha256').update('account:GlobalConfig').digest().copy(data,0,0,8);
  return{pubkey:ray.getPdaLaunchpadConfigId(ray.LAUNCHPAD_PROGRAM,mintB,curveType,index).publicKey,account:{data,owner:ray.LAUNCHPAD_PROGRAM,executable:false}};
}
test('custom quote eligibility validates canonical configs and deduplicates multiple valid configurations',async()=>{
  const rows=[configRow(monero.mint),configRow(monero.mint,0,1),configRow(LAUNCH_ASSETS[0].mint,1)];
  const chain=new LaunchChain({network:'mainnet-beta',connection:{getProgramAccounts:async(program,options)=>{assert(program.equals(ray.LAUNCHPAD_PROGRAM));assert.deepEqual(options.filters,[{dataSize:ray.LaunchpadConfig.span}]);return rows;}}});
  assert.deepEqual(await chain.approvedQuotes(),[monero.mint]);
});
test('malformed or substituted config rows cannot advertise a quote as supported',async()=>{
  const key=new PublicKey(Buffer.alloc(32,9));
  const cases=[row=>{row.pubkey=key;},row=>{row.account.owner=key;},row=>{row.account.executable=true;},row=>{row.account.data[0]^=1;},row=>{row.account.data=row.account.data.subarray(0,-1);},row=>{row.account.data=Buffer.concat([row.account.data,Buffer.alloc(1)]);}];
  for(const mutate of cases){const row=configRow(monero.mint);mutate(row);const chain=new LaunchChain({network:'mainnet-beta',connection:{getProgramAccounts:async()=>[row]}});await assert.rejects(chain.approvedQuotes());}
  for(const rows of [null,{},Array(4097).fill(configRow(monero.mint)),[configRow(monero.mint),configRow(monero.mint)],[configRow(PublicKey.default.toBase58())]]){const chain=new LaunchChain({network:'mainnet-beta',connection:{getProgramAccounts:async()=>rows}});await assert.rejects(chain.approvedQuotes());}
});
test('discovering an approved custom mint does not publish an unsolicited catalogue listing',async()=>{
  const unlisted=new PublicKey(Buffer.alloc(32,17)).toBase58(),service=new Launchpad({},null,{quoteCatalogue:{read:async()=>({assets:[monero]}),close(){}}});
  service.chain=async()=>({approvedQuotes:async()=>[monero.mint,unlisted],close(){}});
  try{const result=await service.quotes('alice');assert.deepEqual(result.assets.map(row=>row.mint),[monero.mint]);assert.equal(result.assets[0].supported,true);}finally{await service.close();}
});
