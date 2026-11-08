import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { LaunchpadExplore } from '../src/launchpad-explore.mjs';
import { LaunchpadTrading } from '../src/launchpad-trading.mjs';
import { AccountService } from '../src/accounts.mjs';
import { createAccountApp } from '../src/account-app.mjs';
import { PumpTestService } from '../src/pump-test-service.mjs';
import { totp } from '../src/totp.mjs';
import { AdminVolume } from '../src/admin-volume.mjs';
import { PersistentLifetimeVolume } from '../src/public-lifetime-volume.mjs';
import { holderLpVaults } from '../src/public-coin-holders.mjs';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';

const NOW=1790600000000, SOL='So11111111111111111111111111111111111111112', key=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
function launch(patch={}) { return {id:'public-launch',mint:key(5),creatorId:'creator-private-id',creatorWallet:key(10),platform:'pumpswap',status:'trading',stateAddress:key(6),custodyAuthority:key(7),publicProgramId:key(8),quoteMint:SOL,createdAt:NOW-10000,name:'Public coin',symbol:'PUB',description:'Description',image:'/token-images/'+'f'.repeat(64)+'.png',website:'https://example.com',privateSecret:'DO-NOT-PUBLISH',...patch}; }
function discovery(t, rows=[launch()]) {
  let now=NOW, banned=false, status='curve', rayReads=0;
  const creator={id:'creator-private-id',username:'creator_name',mainWallet:key(10)};
  const accounts={list:async()=>[{...creator,banned}],get:async()=>({...creator,banned}),storeFor:()=>({read:async()=>({launches:[]})})};
  const pump={publicList:async()=>rows,publicDetail:async mint=>rows.find(row=>row.mint===mint),marketSnapshot:async mint=>({mint,curve:key(6),status,at:now,slot:500,supply:1e9,priceQuote:.0000002,fdvQuote:200,priceUsd:.00003,fdvUsd:30000,raisedQuote:20,targetQuote:100,progressPercent:20,quote:{mint:SOL,symbol:'SOL',usd:150,at:now,stale:false}}),trades:async()=>[{amount:50,quote:.01,side:'buy',time:Math.floor(now/1000)-30,wallet:key(11),signature:'1'.repeat(64),privateSecret:'DO-NOT-PUBLISH'}]};
  const service=new LaunchpadExplore({accounts,pumpPublic:pump,now:()=>now,listWaitMs:100,marketData:{pools:async(_chain,mint)=>({tokenAddress:mint,at:now,pools:[]})},chainFactory:async()=>({marketSnapshot(){rayReads++;throw Error('Pump must not call Raydium');},close(){}}),activity:{read:async()=>null,close(){}},history:{read:async()=>null,close(){}}});
  t.after(()=>service.close());
  return {service,accounts,pump,rows,get rayReads(){return rayReads;},ban(){banned=true;},advance(){now+=11000;},graduate(){status='migrated';rows[0].status='migrated';rows[0].poolId=key(9);}};
}

test('public Pump launches appear in discovery, creators and token pages without Raydium or private fields',async t=>{
  const h=discovery(t),feed=await h.service.list();
  assert.equal(feed.total,1);assert.equal(feed.coins[0].platform,'pumpswap');assert.equal(feed.coins[0].feeMode,'creator');assert.equal(feed.coins[0].creatorFeeBps,50);assert.equal(feed.coins[0].creator.username,'creator_name');assert.equal(feed.coins[0].fdvUsd,30000);assert.equal(feed.coins[0].marketSource,'Launchpad onchain');assert.equal(h.rayReads,0);
  const profile=await h.service.creator('creator_name');assert.equal(profile.total,1);
  const token=await h.service.token(key(5));assert.equal(token.coin.symbol,'PUB');
  const market=await h.service.market(key(5));assert.equal(market.native.source,'Launchpad onchain');assert.equal(market.native.points.length,1);
  const text=JSON.stringify([feed,profile,token,market]);assert.doesNotMatch(text,/creator-private-id|DO-NOT-PUBLISH|privateSecret/);
});

test('hidden or archived completed Pump coins retain fresh direct pages and trading without entering discovery',async t=>{
  for(const flags of [{hidden:true},{archived:true},{moderation:{hidden:true}}]){
    const row=launch({...flags,creatorFeesPaid:'250000000',creatorFeesPending:'50000000',creatorFeesAt:NOW}),h=discovery(t,[row]);
    assert.equal((await h.service.list()).total,0);assert.equal((await h.service.creator('creator_name')).total,0);
    const token=await h.service.token(row.mint),market=await h.service.market(row.mint),trade=await h.service.findForTrade(row.mint);
    assert.equal(token.coin.mint,row.mint);assert.equal(trade.chainRecord.input.route,'pumpswap');
    assert.equal(token.coin.creatorEarnings.earnedRaw,'300000000');assert.deepEqual(market.coin.creatorEarnings,token.coin.creatorEarnings);
    assert.equal(h.service.records.has(row.mint),false);assert.equal(h.service.owners.has(row.mint),false);
    assert.equal((await h.service.list({search:'PUB'})).total,0);assert.equal((await h.service.creator('creator_name')).total,0);
    assert.equal(h.rayReads,0);assert.doesNotMatch(JSON.stringify([token,market]),/creator-private-id|DO-NOT-PUBLISH|moderation|archived|hidden/);
    h.ban();await assert.rejects(h.service.token(row.mint),{statusCode:404});await assert.rejects(h.service.findForTrade(row.mint),{statusCode:403});
  }
});

test('direct Pump fallback rejects noncompleted, mismatched and banned-wallet records',async t=>{
  const h=discovery(t,[]),mint=key(5);let row=launch({hidden:true});h.pump.publicDetail=async()=>row;
  for(const status of ['draft','failed','cancelled']){row.status=status;await assert.rejects(h.service.token(mint),{statusCode:404});await assert.rejects(h.service.findForTrade(mint),{statusCode:404});}
  row.status='trading';row.mint=key(19);await assert.rejects(h.service.findForTrade(mint),{statusCode:404});row.mint=mint;
  h.accounts.assertWalletAllowed=async()=>{throw Object.assign(Error('Wallet is banned.'),{statusCode:403});};
  await assert.rejects(h.service.token(mint),{statusCode:403});await assert.rejects(h.service.findForTrade(mint),{statusCode:403});assert.equal(h.service.records.size,0);
});

test('Pump visibility and archive HTTP routes enforce authentication, CSRF, admin and venue dispatch',async t=>{
  const h=await httpFixture(t),seen=[];
  for(const method of ['adminVisibility','adminArchive'])h.service[method]=async(actor,body)=>{seen.push({method,actor,body});return {route:'pumpswap',mint:body.mint,id:body.id};};
  const body={route:'pumpswap',accountId:'a'.repeat(32),id:'00000000-0000-4000-8000-000000000001',mint:key(5),hidden:true,archived:true,reason:'Visibility test.'};
  for(const [path,method] of [['/api/admin/moderation/launch','adminVisibility'],['/api/admin/launches/archive','adminArchive']]){
    assert.equal((await h.request(path,{body})).status,401);assert.equal((await h.request(path,{auth:h.other,body})).status,403);
    assert.equal((await h.request(path,{auth:h.owner,body,headers:{'x-control-token':'wrong'}})).status,403);assert.equal(seen.length,method==='adminVisibility'?0:1);
    assert.equal((await h.request(path,{auth:h.owner,body:{...body,route:'unknown'}})).status,400);
    h.explore.registryLoaded=true;const result=await h.request(path,{auth:h.owner,body});assert.equal(result.status,200);assert.equal(result.body.route,'pumpswap');assert.equal(h.explore.registryLoaded,false);
    const call=seen.at(-1);assert.equal(call.method,method);assert.equal(call.actor,h.owner.account.id);assert.equal(call.body.mint,body.mint);assert.equal(call.body.accountId,body.accountId);assert.equal(call.body.id,body.id);
  }
  const original=h.accounts.getSessionWithCsrf.bind(h.accounts);h.accounts.getSessionWithCsrf=async(...args)=>{const value=await original(...args);if(value.session)value.session.mfaVerified=false;return value;};
  assert.equal((await h.request('/api/admin/moderation/launch',{auth:h.owner,body})).status,403);assert.equal(seen.length,2);
});
test('draft, hidden, malformed and banned Pump records stay out of public discovery',async t=>{
  const h=discovery(t,[launch({status:'draft'}),launch({mint:key(20),hidden:true}),launch({mint:key(21),stateAddress:'wrong'}),launch({mint:key(22),status:'migrated'})]);
  assert.equal((await h.service.list()).total,0);
  h.rows.push(launch());h.advance();assert.equal((await h.service.list()).total,1);h.ban();h.advance();assert.equal((await h.service.list()).total,0);
});
test('trading resolves fresh Pump identities and preserves onchain verification fields',async t=>{
  const h=discovery(t);await h.service.list();h.graduate();
  const record=await h.service.findForTrade(key(5));assert.equal(record.chainRecord.input.route,'pumpswap');assert.equal(record.chainRecord.review.poolId,key(9));
  const trading=new LaunchpadTrading({accounts:h.accounts,explore:h.service});
  const found=await trading.coin(key(5));assert.equal(found.launch.input.route,'pumpswap');assert.equal(found.launch.review.publicProgramId,key(8));assert.equal(found.launch.review.stateAddress,key(6));assert.equal(found.launch.keys.wallet.address,key(7));assert.equal(found.launch.review.poolId,key(9));
  h.ban();await assert.rejects(h.service.findForTrade(key(5)),{statusCode:403});
});
test('Pump activity exposes only confirmed sanitized human-unit rows and never claims complete chain history',async t=>{
  const h=discovery(t),data=await h.service.trades(key(5));assert.equal(data.mint,key(5));assert.equal(data.trades.length,1);assert.equal(data.trades[0].amount,50);assert.equal(data.complete,false);assert.doesNotMatch(JSON.stringify(data),/DO-NOT-PUBLISH/);
  assert.deepEqual(await h.service.rewards(key(5)),{mint:key(5),mode:'none',holder:null,buyback:null,refreshMs:30000});
});

test('Pump custody and pool token vaults are labeled as liquidity, never developer holder wallets',async t=>{
  const h=discovery(t);await h.service.inventory();h.graduate();const record=await h.service.findForTrade(key(5)),vaults=holderLpVaults(new PublicKey(key(5)),record.chainRecord);
  const custody=getAssociatedTokenAddressSync(new PublicKey(key(5)),new PublicKey(key(7)),true,TOKEN_PROGRAM_ID).toBase58(),pool=getAssociatedTokenAddressSync(new PublicKey(key(5)),new PublicKey(key(9)),true,TOKEN_PROGRAM_ID).toBase58();
  assert.equal(vaults.get(custody).lpType,'curve');assert.equal(vaults.get(pool).lpType,'pool');assert.equal(vaults.has(key(10)),false);
});
test('public analytics count finalized Pump launches and report observed onsite curve volume as partial',async t=>{
  const h=discovery(t),volume=new AdminVolume({accounts:h.accounts,explore:h.service,now:()=>NOW,waitMs:100});t.after(()=>volume.close());
  await volume.inventory();assert.equal(volume.records.length,1);assert.equal(volume.launchFacts.length,1);assert.equal(volume.inventoryComplete,true);assert.equal(volume.records[0].platform,'pumpswap');
  await volume.observe(volume.records[0]);const result=await volume.readPublic();assert.equal(result.launches.total,1);assert.equal(result.volume.observedUsd,1.5);assert.equal(result.volume.complete,false);assert.doesNotMatch(JSON.stringify(result),/creator-private-id|DO-NOT-PUBLISH/);
});
test('Pump lifetime events survive refreshes without being requested from Raydium or counted twice',async t=>{
  const data=new Map(),store={read:async(k,fallback)=>structuredClone(data.get(k)||fallback),write:async(k,v)=>data.set(k,structuredClone(v))},row=launch();let requests=0;
  const volume=new PersistentLifetimeVolume({store,now:()=>NOW,inventory:async()=>({records:[{mint:row.mint,curve:row.stateAddress,platform:'pumpswap',quote:{mint:SOL,symbol:'SOL'}}],complete:true}),quotePrices:async()=>new Map([[SOL,{usd:150,at:NOW}]]),pumpTrades:async()=>({trades:[{amount:50,quote:.01,side:'buy',time:Math.floor(NOW/1000)-30,wallet:key(11),signature:'1'.repeat(64)}],complete:false}),fetcher:async()=>{requests++;throw Error('Pump history cannot use Raydium');}});t.after(()=>volume.close());
  await volume.collect();await volume.collect();const result=volume.readPublic();assert.equal(result.tradeCount,1);assert.equal(result.recordedVolumeUsdEstimate,1.5);assert.equal(result.coverage.launches,1);assert.equal(result.coverage.historyComplete,false);assert.equal(requests,0);
});

async function httpFixture(t){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-public-pump-http-')),accounts=await new AccountService(dir).init(),password='public-pump-http-only-123';
  const ownerAccount=await accounts.register('pump_owner',password);await accounts.setAdmin(ownerAccount.id);const mfa=await accounts.beginMfa(ownerAccount.id,password);await accounts.enableMfa(ownerAccount.id,password,totp(mfa.secret,Date.now()));
  const owner=await accounts.createSession(ownerAccount.id,{mfaVerified:true}),otherAccount=await accounts.register('pump_other',password),other=await accounts.createSession(otherAccount.id),calls=[];
  const service={publicStatus:async()=>({available:false,publicEnabled:false,pairs:[]}),start(){calls.push('start');},stop(){calls.push('stop');}};
  for(const name of ['listAccount','operations','ownerStatus'])service[name]=async(session,context)=>{await context.authorize();calls.push(name);return {ok:true};};
  for(const name of ['prepare','submit','reconcile','cancel','wallet','setup','setEnabled'])service[name]=async(session,input,context)=>{await context.authorize();calls.push(name);return {ok:true};};
  const publicDeployment={};for(const name of ['status','prepare','submit','reconcile'])publicDeployment[name]=async(session,...args)=>{await args.at(-1).authorize();calls.push('deployment-'+name);return {ok:true};};publicDeployment.configuration=publicDeployment;
  const explore={registryLoaded:true};
  const server=createAccountApp({pumpPublicDeployment:publicDeployment,accounts,runtimes:{},policy:{},pumpPublic:service,pumpTest:new PumpTestService({accounts,ownerId:ownerAccount.id}),launchpad:{},marketData:{},protocolFees:{},protocolTreasury:{},protocolGasFunding:{},branding:{},adminPanel:{},adminRevenue:{},adminRevenueAudit:{},explore,trading:{},adminVolume:{},lifetimeVolume:{},publicAnalytics:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await server.closeServices();await rm(dir,{recursive:true,force:true});});
  async function request(path,{auth,body,method=body===undefined?'GET':'POST',headers={}}={}){const response=await fetch(base+path,{method,headers:{...(auth?{cookie:`launchpad-session=${auth.token}`,'x-control-token':auth.csrfToken}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};}
  return {accounts,owner,other,request,calls,service,explore};
}
test('public status is available without authentication while public mutation routes require current session and CSRF',async t=>{
  const h=await httpFixture(t);const status=await h.request('/api/launchpad/pump/status');assert.equal(status.status,200);assert.equal(status.body.publicEnabled,false);
  for(const action of ['prepare','submit','reconcile','cancel','wallet']){const path='/api/launchpad/pump/'+action;assert.equal((await h.request(path,{body:{}})).status,401);assert.equal((await h.request(path,{auth:h.other,body:{},headers:{'x-control-token':'wrong'}})).status,403);assert.equal((await h.request(path,{auth:h.other})).status,405);assert.equal((await h.request(path,{auth:h.other,body:{}})).status,200);}
  for(const action of ['launches','operations'])assert.equal((await h.request('/api/launchpad/pump/'+action,{auth:h.other})).status,200);
  assert.equal((await h.request('/api/launchpad/pump/submit?rpcUrl=override',{auth:h.other,body:{}})).status,400);
});
test('the real public pair route shares status availability and passes only a current authenticated preview context',async t=>{
  const h=await httpFixture(t);
  h.service.publicStatus=async(session,context)=>{
    if(session)await context.authorize();
    const preview=!!session;
    return {available:preview,publicEnabled:false,ownerPreview:preview,pairs:preview?[{mint:SOL,symbol:'SOL',launchReady:true}]:[]};
  };
  for(const suffix of ['status','pairs']){
    const path='/api/launchpad/pump/'+suffix;
    assert.deepEqual((await h.request(path)).body.pairs,[]);
    assert.equal((await h.request(path,{auth:h.owner})).body.pairs[0].mint,SOL);
    assert.deepEqual((await h.request(path,{auth:h.owner,headers:{'x-control-token':'wrong'}})).body.pairs,[]);
    assert.equal((await h.request(path+'?ownerPreview=true',{auth:h.owner})).status,400);
  }
});
test('owner setup routes are explicitly allowed by product mode and remain owner/MFA protected',async t=>{
  const h=await httpFixture(t);
  for(const action of ['status','setup','configure']){const path='/api/admin/pump-public/'+action,args=action==='status'?{}:{body:{}};assert.equal((await h.request(path,args)).status,401,path);assert.equal((await h.request(path,{...args,auth:h.other})).status,403,path);assert.equal((await h.request(path,{...args,auth:h.owner})).status,200,path);}
  assert(h.calls.includes('setEnabled'));assert(h.calls.includes('start'));assert.equal((await h.request('/api/admin/pump-public/unknown',{auth:h.owner})).status,404);
});
test('revoked sessions cannot receive asynchronous public account operation results',async t=>{
  const h=await httpFixture(t);h.service.prepare=async()=>{await h.accounts.revokeSession(h.other.token);return {privateResult:'must-not-leak'};};
  const response=await h.request('/api/launchpad/pump/prepare',{auth:h.other,body:{}});assert.equal(response.status,401);assert.doesNotMatch(JSON.stringify(response.body),/must-not-leak/);
});

test('public deployment and configuration health probes resolve exact protected routes, never false 404',async t=>{
  const h=await httpFixture(t);
  for(const group of ['deployment','configuration'])for(const action of ['status','prepare','submit','reconcile']){
    const path='/api/admin/pump-public/'+group+'/'+action,args=action==='status'?{}:{body:{}};
    assert.equal((await h.request(path,args)).status,401,path+' guest');assert.equal((await h.request(path,{...args,auth:h.other})).status,403,path+' ordinary');assert.equal((await h.request(path,{...args,auth:h.owner})).status,200,path+' owner');
  }
});

test('confirmed launch receipt invalidates the old discovery snapshot before returning its coin link',async t=>{
  const h=await httpFixture(t);
  h.service.reconcile=async()=>({operation:{action:'initialize',state:'confirmed'}});
  assert.equal(h.explore.registryLoaded,true);
  const result=await h.request('/api/launchpad/pump/reconcile',{auth:h.other,body:{}});
  assert.equal(result.status,200);assert.equal(h.explore.registryLoaded,false);
});
