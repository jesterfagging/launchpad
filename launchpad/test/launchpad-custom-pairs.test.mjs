import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { LaunchCustomPairs, readCustomPairs } from '../src/launchpad-custom-pairs.mjs';
import { Launchpad } from '../src/launchpad.mjs';
import { LAUNCH_ASSETS } from '../public/launch-assets.mjs';
import { launchInput } from '../public/launchpad-model.mjs';
import { customPairLabels } from '../public/custom-pair-fields.mjs';

const key=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const mint=key(18),second=key(19),image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0f8AAAAASUVORK5CYII=';
const copy=value=>structuredClone(value);
async function setup(t){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-custom-pairs-')),data=new Map();let clock=1000000;
  const admin={id:'admin',role:'admin',mfaEnabled:true,banned:false},counts={mint:0,approved:0,preview:0,closed:0};
  const accounts={dir,get:async id=>id==='admin'?admin:{id,role:'user',mfaEnabled:true},hostStore:{read:async(name,fallback)=>copy(data.get(name)??fallback),write:async(name,value)=>data.set(name,copy(value))}};
  const options={approved:[mint,second],invalid:false,providerError:false,previewError:false,previewHook:null,catalogue:[]};
  const launchpad={quoteCatalogue:{read:async()=>({assets:options.catalogue})},newLaunchInput:async(_id,raw)=>({...launchInput({...raw,creatorFeePercent:'0.5'},{marketCapPolicy:'public'}),protocolFees:{curveFeeBps:100,platformLpBps:7500}}),chain:async(_id,network)=>{
    assert.equal(network,'mainnet-beta');return {
      mintInfo:async address=>{counts.mint++;if(options.providerError)throw Error('https://private.rpc/key=secret');if(options.invalid)throw Error('Quote mint was not found on this Solana network.');return {key:new PublicKey(address),program:TOKEN_PROGRAM_ID,mint:{isInitialized:true,decimals:6,tlvData:Buffer.alloc(0)},extensions:[]};},
      approvedQuotes:async()=>{counts.approved++;return options.approved;},
      preview:async input=>{counts.preview++;assert.equal(input.devBuyLamports,'0');assert.equal(input.targetUsd,'20000');assert.equal(input.graduationTargetUsd,'50000');assert.equal(input.network,'mainnet-beta');assert.equal(input.protocolFees.curveFeeBps,100);assert.equal(input.protocolFees.platformLpBps,7500);if(options.previewHook)await options.previewHook();if(options.previewError)throw Error(options.previewError);return {quoteProgram:TOKEN_PROGRAM_ID.toBase58(),quoteDecimals:6,price:{usd:'1'}};},
      close:()=>counts.closed++,
    };
  }};
  const service=new LaunchCustomPairs({accounts,launchpad,now:()=>clock});
  t.after(async()=>{await service.close();await rm(dir,{recursive:true,force:true});});
  return {service,accounts,admin,options,counts,data,dir,launchpad,advance:ms=>clock+=ms,input:(extra={})=>({revision:0,name:'Example Coin',ticker:'EXAMPLE',mint,image,...extra})};
}

test('admin adds a validated custom pair with local content-hash image and no public operator identity',async t=>{
  const h=await setup(t),checked=await h.service.previewMint('admin',{mint});
  assert.equal(checked.supported,true);assert.equal(checked.alreadyListed,false);assert.equal(checked.decimals,6);
  const saved=await h.service.save('admin',h.input());assert.equal(saved.revision,1);assert.equal(saved.asset.category,'custom');assert.equal(saved.asset.supported,true);
  assert.match(saved.asset.logoPath,/^\/token-images\/[a-f0-9]{64}\.png$/);assert.equal(await readFile(join(h.dir,saved.asset.logoPath.slice(1)),'base64'),image);
  assert.equal(h.counts.preview,2,'save revalidates instead of trusting the prior UI check');
  assert.deepEqual(await h.service.read('admin'),{revision:1,assets:[saved.asset]});
  assert(!JSON.stringify(saved).includes('createdBy'));assert(!JSON.stringify(await h.service.read('admin')).includes('admin'));
  assert.equal(h.data.get('launch-custom-pairs').assets[0].createdBy,'admin');
});

test('valid unconfigured mint saves Coming Soon; discovery never lists an unsolicited mint',async t=>{
  const h=await setup(t);h.options.approved=[];
  assert.equal((await h.service.previewMint('admin',{mint})).supported,false);
  const result=await h.service.save('admin',h.input());assert.equal(result.asset.supported,false);assert.equal(h.counts.preview,0);
  assert.match(result.asset.supportReason,/no bonding-curve/);
  const rows=await h.service.publicAssets('viewer',{assets:[]},[second]);assert.equal(rows.length,1);assert.equal(rows[0].mint,mint);assert.equal(rows[0].supported,false);
  h.options.approved=[mint];const available=await h.service.publicAssets('viewer',{assets:[]},[mint]);assert.equal(available[0].supported,true,'saved Coming Soon pair activates after an actual successful check');
});

test('provider failures and failed full previews never publish a configured mint as available',async t=>{
  const h=await setup(t);h.options.providerError=true;
  const checked=await h.service.previewMint('admin',{mint});assert.equal(checked.supported,null);assert(!JSON.stringify(checked).includes('private.rpc'));
  await assert.rejects(h.service.save('admin',h.input()),e=>e.statusCode===503);assert.equal(h.data.size,0);
  h.options.providerError=false;h.options.previewError='USD reference unavailable';
  assert.equal((await h.service.previewMint('admin',{mint})).supported,null);
  await assert.rejects(h.service.save('admin',h.input()),e=>e.statusCode===503);assert.equal(h.data.size,0);
  h.options.previewError='This quote cannot migrate to Raydium CPMM: its Token-2022 extensions are not registered.';
  const incompatible=await h.service.previewMint('admin',{mint});assert.equal(incompatible.supported,false);assert.match(incompatible.supportReason,/extensions/);
});

test('invalid, nonexistent and uninitialized mints fail before any listing or image write',async t=>{
  const h=await setup(t);
  for(const invalid of ['https://rpc.example/',`${mint} `,PublicKey.default.toBase58(),'not-a-mint'])await assert.rejects(h.service.previewMint('admin',{mint:invalid}),e=>e.statusCode===400);
  h.options.invalid=true;
  await assert.rejects(h.service.previewMint('admin',{mint}),e=>e.statusCode===400);
  await assert.rejects(h.service.save('admin',h.input()),e=>e.statusCode===400);
  assert.deepEqual(await readdir(h.dir),[]);assert.equal(h.data.size,0);
});

test('service enforces admin MFA for reads/checks/saves and rechecks revocation during validation',async t=>{
  const h=await setup(t);
  for(const fn of [()=>h.service.read('user'),()=>h.service.previewMint('user',{mint}),()=>h.service.save('user',h.input())])await assert.rejects(fn(),e=>e.statusCode===403);
  h.admin.mfaEnabled=false;await assert.rejects(h.service.save('admin',h.input()),e=>e.statusCode===403);h.admin.mfaEnabled=true;
  h.options.previewHook=()=>{h.admin.role='user';};
  await assert.rejects(h.service.save('admin',h.input()),e=>e.statusCode===403);assert.equal(h.data.size,0);assert.deepEqual(await readdir(h.dir),[]);
});

test('issuer and custom duplicates, stale revisions, and concurrent writers cannot overwrite a pair',async t=>{
  const h=await setup(t);
  await assert.rejects(h.service.save('admin',h.input({mint:LAUNCH_ASSETS[0].mint})),e=>e.statusCode===409);
  h.options.catalogue=[{mint:second,symbol:'ISSUER'}];await assert.rejects(h.service.save('admin',h.input({mint:second})),e=>e.statusCode===409);
  const results=await Promise.allSettled([h.service.save('admin',h.input()),h.service.save('admin',h.input({name:'Overwrite'}))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.statusCode,409);
  assert.equal(h.data.get('launch-custom-pairs').assets.length,1);
  await assert.rejects(h.service.save('admin',h.input({revision:1})),e=>e.statusCode===409);
});

test('text, oversized/remote/SVG images and malformed stored catalogues fail closed',async t=>{
  const h=await setup(t);
  for(const extra of [{name:'<script>alert(1)</script>'},{name:'wrong\u202etext'},{ticker:'<IMG>'},{image:'https://evil.invalid/logo.png'},{image:'data:image/png;base64,'+image},{image:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64')},{image:'A'.repeat(131073)}])await assert.rejects(h.service.save('admin',h.input(extra)));
  assert.equal(h.counts.mint,0);assert.equal(h.data.size,0);
  h.data.set('launch-custom-pairs',{version:1,revision:0,assets:[{mint,name:'bad'}]});
  await assert.rejects(readCustomPairs(h.accounts),e=>e.statusCode===503);assert.equal(h.data.get('launch-custom-pairs').assets.length,1);
});

test('custom public validation coalesces per account, expires and never overrides issuer data',async t=>{
  const h=await setup(t),saved=await h.service.save('admin',h.input());h.advance(300001);let release;
  h.options.previewHook=()=>new Promise(resolve=>{release=resolve;});
  const a=h.service.publicAssets('viewer',{assets:[]},[mint]),b=h.service.publicAssets('viewer',{assets:[]},[mint]);
  while(!release)await new Promise(resolve=>setImmediate(resolve));assert.equal(h.counts.preview,2);release();
  assert.equal((await a)[0].supported,true);assert.equal((await b)[0].supported,true);h.options.previewHook=null;
  assert.equal((await h.service.publicAssets('viewer',{assets:[]},null))[0].supported,null,'failed config availability overrides previous positive checks');
  assert.equal((await h.service.publicAssets('viewer',{assets:[]},[]))[0].supported,false);
  assert.deepEqual(await h.service.publicAssets('viewer',{assets:[{mint,name:'Issuer verified'}]},[mint]),[]);
  h.advance(300001);h.options.providerError=true;
  assert.equal((await h.service.publicAssets('viewer',{assets:[]},[mint]))[0].supported,null);const calls=h.counts.mint;
  await h.service.publicAssets('viewer',{assets:[]},[mint]);assert.equal(h.counts.mint,calls,'unknown results use a bounded retry delay');
  h.advance(30001);await h.service.publicAssets('viewer',{assets:[]},[mint]);assert.equal(h.counts.mint,calls+1);
  assert.equal(saved.asset.logoPath,h.data.get('launch-custom-pairs').assets[0].logoPath);
});

test('one account RPC cannot poison custom pair availability for another account',async t=>{
  const h=await setup(t);await h.service.save('admin',h.input());h.advance(300001);
  h.options.providerError=true;
  assert.equal((await h.service.publicAssets('alice',{assets:[]},[mint]))[0].supported,null);
  h.options.providerError=false;
  assert.equal((await h.service.publicAssets('bob',{assets:[]},[mint]))[0].supported,true);
  assert.equal((await h.service.publicAssets('alice',{assets:[]},[mint]))[0].supported,null);
});

test('one public request validates at most four stale listed mints and no provider metadata URLs',async t=>{
  const h=await setup(t),saved=await h.service.save('admin',h.input()),state=h.data.get('launch-custom-pairs');
  state.assets=Array.from({length:10},(_,n)=>({...state.assets[0],mint:key(n+40),symbol:'PAIR'+n,check:{mint:key(n+40),supported:true,checkedAt:1,supportReason:''}}));h.data.set('launch-custom-pairs',state);h.options.approved=state.assets.map(row=>row.mint);
  const before=h.counts.preview,rows=await h.service.publicAssets('viewer',{assets:[]},h.options.approved);
  assert.equal(h.counts.preview-before,4);assert.equal(rows.filter(row=>row.supported===true).length,4);assert.equal(rows.filter(row=>row.supported===null).length,6);assert.equal(rows.length,10);assert(saved.asset.logoPath);
});

test('Launchpad quote responses merge saved custom rows without changing verified catalogue assets',async t=>{
  const h=await setup(t);await h.service.save('admin',h.input());
  const launchpad=new Launchpad(h.accounts,null,{now:()=>1000000,quoteCatalogue:{read:async()=>({assets:[LAUNCH_ASSETS[0]],source:'verified'}),close(){}}});
  launchpad.chain=async()=>({approvedQuotes:async()=>[mint,LAUNCH_ASSETS[0].mint],close(){}});launchpad.customPairs=h.service;
  t.after(()=>launchpad.close());const result=await launchpad.quotes('viewer');assert.equal(result.assets.length,2);assert.equal(result.assets[0].mint,LAUNCH_ASSETS[0].mint);assert.equal(result.assets[1].category,'custom');assert.equal(result.assets[1].supported,true);
});

test('custom labels preserve supplied punctuation and Unicode while excluding invisible controls and markup',()=>{
  for(const value of ['$NRG','LMAO!','@gork','Xavier:','熊猫','"　"'])assert.deepEqual(customPairLabels({name:value,ticker:value}),{name:value,symbol:value});
  for(const value of ['<img>','bad\u202etext','bad\u200btext','bad\ntext'])assert.throws(()=>customPairLabels({name:value,ticker:'OK'}));
});

test('admin list refreshes stale availability without requiring the operator to resave a pair',async t=>{
  const h=await setup(t);await h.service.save('admin',h.input());h.advance(300001);const before=h.counts.preview;
  const result=await h.service.read('admin');assert.equal(result.assets[0].supported,true);assert.equal(h.counts.preview,before+1);assert.equal(result.revision,1);
});
