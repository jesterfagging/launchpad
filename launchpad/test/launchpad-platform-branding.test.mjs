import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Keypair } from '@solana/web3.js';
import { Launchpad } from '../src/launchpad.mjs';
import { LaunchBranding,platformBrand } from '../src/launchpad-branding.mjs';
import { newLaunchKeys } from '../src/launchpad-receipts.mjs';

process.env.LAUNCHPAD_PUBLIC_URL='https://launchpad.example';
const LAUNCHPAD_PLATFORM_BRAND=platformBrand(),PREVIOUS_BRAND=Object.freeze({version:'brand-v1',name:'Previous name',web:'https://previous.example',img:'https://previous.example/brand-avatar.png'});
const admin='a'.repeat(32),user='b'.repeat(32),other='c'.repeat(32),address=()=>Keypair.generate().publicKey.toBase58();
function fixture(n=1){return {id:n.toString(16).padStart(32,'0'),createdAt:n,authorizedAt:10,feeCustody:'relay',curve:address(),state:'live',keys:{...newLaunchKeys(),payer:newLaunchKeys().wallet,platform:newLaunchKeys().wallet},input:{route:'raydium',network:'mainnet-beta',name:'Creator’s Example coin',symbol:'EXAMPLE',description:'Keep my original token identity.',image:'https://example.com/original.png',quoteMint:address(),creatorFeeBps:25,taxBps:300,feeMode:'holders'},review:{quoteDecimals:6,quoteSymbol:'USDC',creatorFeeBps:25,platformFeeBps:100,protocolFees:{recipient:address(),lpPolicy:'platform_locked',platformLpPercent:75}},uri:'https://gateway.irys.xyz/OriginalTokenMetadata',storage:{platformImage:'https://gateway.irys.xyz/OriginalPlatformLogo',items:[{id:'original-item',state:'uploaded',raw:'signed-immutable-storage-item'}]},operations:[{kind:'create',state:'confirmed',signature:'original-signature',raw:'original-signed-bytes'}],autoFees:true,feesRequested:false,credits:{quote:'555',base:'666'},gas:{reserved:'12345'}};}
async function harness(t,launches=[fixture()]){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-brand-admin-')),books=new Map([[admin,{launches:[]}],[user,{launches}],[other,{launches:[]}]]),users=new Map([[admin,{id:admin,username:'owner',role:'admin',mfaEnabled:true,mainWallet:address()}],[user,{id:user,username:'creator',role:'user',mfaEnabled:true,mainWallet:address()}],[other,{id:other,username:'second',role:'user',mfaEnabled:false,mainWallet:address()}]]);
  let reads=0,writes=0,kicks=0,failWrite=false;
  const accounts={dir,get:async id=>structuredClone(users.get(id)),list:async()=>structuredClone([...users.values()]),storeFor:id=>({dir:join(dir,id),read:async()=>{reads++;return structuredClone(books.get(id)||{launches:[]});},write:async(_,value)=>{if(failWrite)throw Error('Storage unavailable');writes++;books.set(id,structuredClone(value));}})};
  const launchpad=new Launchpad(accounts,null);launchpad.kick=()=>{kicks++;};const service=new LaunchBranding({accounts,launchpad,now:()=>12345});
  t.after(async()=>{await launchpad.close();await rm(dir,{recursive:true,force:true});});
  return{service,accounts,launchpad,books,users,get reads(){return reads;},get writes(){return writes;},get kicks(){return kicks;},set failWrite(value){failWrite=value;}};
}
const body=(launch,extra={})=>({accountId:user,id:launch.id,requestId:'1'.repeat(32),reason:'Update platform attribution to Launchpad.',confirmPublishedLogo:true,...extra});

test('platform branding requires administrator MFA before accessing any account records',async t=>{
  const h=await harness(t);
  for(const actor of [user,other]){await assert.rejects(h.service.list(actor),e=>e.statusCode===403);await assert.rejects(h.service.update(actor,{}),e=>e.statusCode===403);}
  h.users.get(admin).mfaEnabled=false;await assert.rejects(h.service.list(admin),e=>e.statusCode===403);assert.equal(h.reads,0);assert.equal(h.writes,0);assert.equal(h.kicks,0);
});

test('branding inventory exposes safe attribution fields, excludes drafts and preserves user token identities',async t=>{
  const launch=fixture(),draft=fixture(2);delete draft.curve;draft.state='draft';const h=await harness(t,[launch,draft]);
  const result=await h.service.list(admin);assert.equal(result.coins.length,1);assert.equal(result.coins[0].name,launch.input.name);assert.equal(result.coins[0].symbol,'EXAMPLE');assert.equal(result.coins[0].status,'legacy');assert.deepEqual(result.brand,LAUNCHPAD_PLATFORM_BRAND);assert.equal(result.requiresPublishedLogo,true);
  const text=JSON.stringify(result);for(const secret of [launch.keys.wallet.secret,launch.keys.platform.secret,launch.storage.items[0].raw,launch.operations[0].raw])assert(!text.includes(secret));assert.equal(h.writes,0);
});

test('branding queues only server-selected platform attribution and leaves financial and creator records unchanged',async t=>{
  const launch=fixture(),h=await harness(t,[launch]),before=structuredClone(launch);
  const result=await h.service.update(admin,body(launch,{target:{name:'Malicious',web:'https://attacker.invalid/',img:'https://attacker.invalid/logo.png'}})),saved=h.books.get(user).launches[0];
  assert.equal(result.alreadyRequested,false);assert.equal(result.coin.status,'queued');assert.deepEqual(saved.brandingUpdate,{target:LAUNCHPAD_PLATFORM_BRAND});assert.equal(saved.brandingRequested,true);
  for(const key of ['input','review','keys','storage','uri','operations','credits','gas','autoFees','feesRequested'])assert.deepEqual(saved[key],before[key]);
  assert.deepEqual(saved.brandingRequests,[{requestId:'1'.repeat(32),actorId:admin,actor:'owner',at:12345,reason:body(launch).reason,target:LAUNCHPAD_PLATFORM_BRAND}]);assert.equal(saved.platformBrand,undefined);assert.equal(h.writes,1);assert.equal(h.kicks,1);
});

test('public-domain logo updates require an explicit publishing acknowledgment before queuing',async t=>{
  const launch=fixture(),h=await harness(t,[launch]);
  for(const confirmPublishedLogo of [undefined,false,'true'])await assert.rejects(h.service.update(admin,body(launch,{confirmPublishedLogo})),/Publish launchpad\.example/);
  assert.deepEqual(h.books.get(user).launches[0],launch);assert.equal(h.kicks,0);
});

test('branding can reuse only a verified uploaded copy of the exact current platform logo',async t=>{
  const launch=fixture(),h=await harness(t,[launch]),source=fixture(2),hash=createHash('sha256').update(await readFile(new URL('../public/brand-icon.png',import.meta.url))).digest('hex'),image='https://gateway.irys.xyz/'+'A'.repeat(43);
  source.review.platformBrand={...LAUNCHPAD_PLATFORM_BRAND,img:image};source.storage={platformLogoSha256:hash,platformImage:image,items:[{state:'uploaded',id:'A'.repeat(43)}]};h.books.get(other).launches.push(source);
  assert.equal((await h.service.list(admin)).requiresPublishedLogo,false);await h.service.update(admin,body(launch,{confirmPublishedLogo:false}));assert.equal(h.books.get(user).launches[0].brandingUpdate.target.img,image);
  source.storage.platformLogoSha256='f'.repeat(64);assert.equal((await h.service.list(admin)).requiresPublishedLogo,true);
  source.storage.platformLogoSha256=hash;source.storage.items[0].state='pending';assert.equal((await h.service.list(admin)).requiresPublishedLogo,true);
});

test('branding request replay is bound to the same administrator and cannot requeue a completed update',async t=>{
  const launch=fixture(),h=await harness(t,[launch]),request=body(launch);
  const replies=await Promise.all([h.service.update(admin,request),h.service.update(admin,request)]);assert.deepEqual(replies.map(r=>r.alreadyRequested),[false,true]);assert.equal(h.writes,1);
  const saved=h.books.get(user).launches[0];saved.brandingRequested=false;saved.platformBrand={...LAUNCHPAD_PLATFORM_BRAND,updatedAt:999,signature:'confirmed-branding-signature'};
  const replay=await h.service.update(admin,request);assert.equal(replay.coin.status,'updated');assert.equal(saved.brandingRequested,false);assert.equal(h.writes,1);
  h.users.get(other).role='admin';h.users.get(other).mfaEnabled=true;await assert.rejects(h.service.update(other,request),e=>e.statusCode===409);
});

test('external, shared, exported or busy platform authorities cannot be rebranded by the admin service',async t=>{
  const changes=[l=>{delete l.authorizedAt;},l=>{delete l.curve;},l=>{l.feeCustody='legacy';},l=>{l.input.network='devnet';},l=>{l.keys.wallet.external=true;},l=>{l.keys.platform.external=true;},l=>{delete l.keys.platform.secret;},l=>{l.keys.payer=l.keys.wallet;},l=>{l.feeWalletExportedAt=1;},l=>{l.walletExportedAt=1;},l=>{l.keys.wallet.exportedAt=1;},l=>{l.keys.platform.exportedAt=1;},l=>{l.protocolFeesRequested=true;},l=>{l.brandingRequested=true;},l=>{l.operations.push({kind:'claim',state:'pending'});},l=>{l.operations.push({kind:'create',state:'awaiting_signature'});}];
  for(const change of changes){const launch=fixture();change(launch);const h=await harness(t,[launch]),before=structuredClone(h.books.get(user));await assert.rejects(h.service.update(admin,body(launch)),e=>e.statusCode===409);assert.deepEqual(h.books.get(user),before);assert.equal(h.kicks,0);}
  const launch=fixture(),h=await harness(t,[launch]),shared=fixture(2);shared.keys.platform=launch.keys.platform;h.books.get(other).launches.push(shared);await assert.rejects(h.service.update(admin,body(launch)),/Shared or personal/);h.books.get(other).launches=[];h.users.get(other).mainWallet=launch.keys.platform.address;await assert.rejects(h.service.update(admin,body(launch)),/Shared or personal/);
});

test('role revocation during target selection or inventory prevents branding output and save',async t=>{
  const launch=fixture(),h=await harness(t,[launch]),target=h.service.target.bind(h.service);
  h.service.target=async rows=>{const result=await target(rows);h.users.get(admin).role='user';return result;};
  await assert.rejects(h.service.list(admin),/Administrator/);h.users.get(admin).role='admin';await assert.rejects(h.service.update(admin,body(launch)),/Administrator/);assert.deepEqual(h.books.get(user).launches[0],launch);assert.equal(h.writes,0);assert.equal(h.kicks,0);
});

test('invalid inputs and failed durable storage never kick a branding transaction',async t=>{
  const launch=fixture(),h=await harness(t,[launch]);
  for(const extra of [{accountId:'bad'},{id:'bad'},{requestId:'bad'},{reason:'no'},{reason:'x'.repeat(501)}])await assert.rejects(h.service.update(admin,body(launch,extra)));
  h.failWrite=true;await assert.rejects(h.service.update(admin,body(launch)),/Storage unavailable/);assert.deepEqual(h.books.get(user).launches[0],launch);assert.equal(h.kicks,0);
});

test('a confirmed older platform identity takes priority over a newer review in branding status',async t=>{
  const launch=fixture();launch.review.platformBrand={...LAUNCHPAD_PLATFORM_BRAND};launch.platformBrand={...PREVIOUS_BRAND};
  const h=await harness(t,[launch]),{coins}=await h.service.list(admin);
  assert.equal(coins[0].status,'legacy');assert.deepEqual(coins[0].currentBrand,PREVIOUS_BRAND);
});


test('paused rewards and queued fees do not prevent a branding update at a transaction boundary',async t=>{
  for(const stage of ['claim','buyback','burn','distribute']){
    const launch=fixture();launch.state='paused';launch.autoFees=false;launch.feesRequested=true;launch.cycle={stage,startedAt:123,credit:'1234'};
    launch.operations.push({kind:stage,state:'failed',error:'Previously failed operation.'});
    const h=await harness(t,[launch]);const result=await h.service.update(admin,body(launch)),saved=h.books.get(user).launches[0];
    assert.equal(result.coin.status,'queued');assert.equal(saved.state,'paused');assert.equal(saved.autoFees,false);assert.equal(saved.feesRequested,true);
    assert.deepEqual(saved.cycle,launch.cycle);assert.deepEqual(saved.operations,launch.operations);assert.deepEqual(saved.credits,launch.credits);
  }
});

test('unresolved reward receipts and signatures still prevent branding during a paused cycle',async t=>{
  for(const state of ['pending','awaiting_signature']){
    const launch=fixture();launch.state='paused';launch.cycle={stage:'distribute'};launch.operations.push({kind:'distribute',state,signature:'unresolved-signature'});
    const h=await harness(t,[launch]);await assert.rejects(h.service.update(admin,body(launch)),/Wait for the current/);
    assert.deepEqual(h.books.get(user).launches[0],launch);assert.equal(h.kicks,0);
  }
});
