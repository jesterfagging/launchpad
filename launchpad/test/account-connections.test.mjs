import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountService } from '../src/accounts.mjs';
import { AccountRuntimeManager } from '../src/account-runtime.mjs';
import { RobinhoodRuntimeManager } from '../src/robinhood-runtime.mjs';
import { AccountConnections } from '../src/account-connections.mjs';
import { createAccountApp } from '../src/account-app.mjs';
import { TelegramConnections } from '../src/telegram-connections.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(),'launchpad-connections-')), accounts = await new AccountService(dir).init();
  const owner = await accounts.register('connections_owner','test-password-12345'), other = await accounts.register('connections_other','test-password-12345');
  const policy = {get: async()=>({ready:false})}, solana = new AccountRuntimeManager(accounts,policy), robinhood = new RobinhoodRuntimeManager(accounts,policy,{solana});
  t.after(async()=>{await solana.close();await robinhood.close();await rm(dir,{recursive:true,force:true});});
  return {accounts,owner,other,solana,robinhood,policy,service:new AccountConnections(accounts,solana,robinhood)};
}
test('connection edits preserve wallets and fees, keep chains/users isolated and reject foreign references or stale changes',async t=>{
  const h=await fixture(t),id=h.owner.id,old=(await h.solana.readSettings(id)).settings;
  const first=await h.service.read(id,'solana');
  const result=await h.service.save(id,'solana',{heliusKey:'private-helius-connection',jupiterKey:'private-jupiter-connection',rpcUrl:'https://example.com/rpc?api-key=user-only'},first.revision);
  const stored=(await h.solana.readSettings(id)).settings;
  assert.equal(stored.heliusKey,'private-helius-connection');assert.deepEqual(stored.wallets,old.wallets);assert.equal(stored.prioritySol,old.prioritySol);assert.deepEqual(stored.strategies,old.strategies);
  assert(!JSON.stringify(result).includes('private-helius-connection'));assert(!JSON.stringify(result).includes('user-only'));assert.equal(result.values.heliusKey.startsWith('relay-saved-v1:'),true);
  assert.equal((await h.solana.readSettings(h.other.id)).settings.heliusKey,'');
  const foreign=await h.service.read(h.other.id,'solana');await assert.rejects(h.service.save(h.other.id,'solana',{heliusKey:result.values.heliusKey},foreign.revision),/another account/);
  const rh=await h.service.read(id,'robinhood');
  await assert.rejects(h.service.save(id,'robinhood',{rpcUrl:result.values.rpcUrl},rh.revision),/another account/);
  await h.service.save(id,'robinhood',{rpcUrl:'https://example.org/rh?key=private-rh',pollMs:500},rh.revision);
  assert.equal((await h.solana.readSettings(id)).settings.rpcUrl,stored.rpcUrl);
  assert.equal((await h.robinhood.readSettings(id)).settings.pollMs,500);
  await assert.rejects(h.service.save(id,'solana',{heliusKey:'stale'},first.revision),/changed/);
  await assert.rejects(h.service.save(id,'solana',{wallets:[]},result.revision),/Only connection/);
  await assert.rejects(h.service.save(id,'solana',{rpcUrl:'https://127.0.0.1/private'},result.revision),/public HTTPS/);
  await assert.rejects(h.service.save(id,'__proto__',{},result.revision),/Choose/);
  const cleared=await h.service.save(id,'solana',{heliusKey:''},result.revision);assert.equal(cleared.values.heliusKey,'');assert.equal((await h.solana.readSettings(id)).settings.jupiterKey,stored.jupiterKey);
});
test('connection HTTP endpoints require sign-in and CSRF, never accept an account ID override or expose host keys',async t=>{
  const h=await fixture(t), server=createAccountApp({accounts:h.accounts,runtimes:h.solana,policy:h.policy,robinhood:{runtimes:h.robinhood,policy:h.policy},features:{toolkit:true,telegram:true,walletOnly:false}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const auth=await h.accounts.createSession(h.owner.id),base=`http://127.0.0.1:${server.address().port}`;
  const call=async(path,body,login=true,csrf=true)=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{...(login?{cookie:`launchpad-session=${auth.token}`}:{}),...(csrf?{'x-control-token':auth.csrfToken}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
  assert.equal((await call('/api/account/connections',null,false)).status,401);
  assert.equal((await call('/api/account/connections',null,true,false)).status,403);
  const current=await call('/api/account/connections?chain=solana');assert.equal(current.status,200);
  const saved=await call('/api/account/connections',{chain:'solana',accountId:h.other.id,values:{jupiterKey:'my-routing-key'},revision:current.data.revision});
  assert.equal(saved.status,200);assert(!JSON.stringify(saved).includes('my-routing-key'));assert.equal((await h.solana.readSettings(h.owner.id)).settings.jupiterKey,'my-routing-key');assert.equal((await h.solana.readSettings(h.other.id)).settings.jupiterKey,'');
  assert.deepEqual(Object.keys(saved.data).sort(),['chain','revision','values']);
});
test('Telegram account connections can edit either chain without changing the chosen tool or echoing credentials',async t=>{
  const h=await fixture(t),sent=[],deleted=[];let refreshes=0;
  const bot={accounts:h.accounts,now:Date.now,button:(_ctx,text,op,args)=>({text,op,args}),say:(_ctx,text,rows)=>sent.push({text,rows}),deleteInput:async(_ctx,msg)=>deleted.push(msg),refreshSettings:async()=>{refreshes++;}};
  const menu=new TelegramConnections(bot,h.solana,h.robinhood),ctx={account:h.owner,chain:'solana',tool:'market',revision:1};
  await menu.menu(ctx,'robinhood');const field=sent.at(-1).rows.flat().find(b=>b.args?.key==='rpcUrl');assert(field);
  await menu.field(ctx,field.args);assert.equal(ctx.prompt.kind,'accountConnection');await menu.message(ctx,{text:'https://example.net/rh?key=private-user-secret'});
  assert.equal(ctx.chain,'solana');assert.equal(ctx.tool,'market');assert.equal(refreshes,1);assert.equal(deleted.length,1);assert(!JSON.stringify(sent).includes('private-user-secret'));
  assert.equal((await h.robinhood.readSettings(h.owner.id)).settings.rpcUrl,'https://example.net/rh?key=private-user-secret');
  assert.equal((await h.solana.readSettings(h.owner.id)).settings.rpcUrl,'');
});

test('market credentials are encrypted, account-scoped, independent of runs and protected against concurrent overwrites',async t=>{
  const h=await fixture(t),id=h.owner.id,setup=await h.solana.readSettings(id),rh=await h.robinhood.readSettings(id),before=await h.service.read(id,'market');
  const saved=await h.service.save(id,'market',{coingeckoKey:'user-private-chart-key',blockscoutKey:'user-private-holder-key',coingeckoPlan:'demo',marketRefreshSeconds:'300'},before.revision);
  assert(!JSON.stringify(saved).includes('user-private'));assert(saved.values.coingeckoKey.startsWith('relay-saved-v1:'));
  assert.deepEqual(await h.solana.readSettings(id),setup);assert.deepEqual(await h.robinhood.readSettings(id),rh);
  const other=await h.service.read(h.other.id,'market');assert.equal(other.values.blockscoutKey,'');
  await assert.rejects(h.service.save(h.other.id,'market',{blockscoutKey:saved.values.blockscoutKey},other.revision),/another account/);
  const {readFile}=await import('node:fs/promises');const stored=await readFile(h.accounts.storeFor(id).path('market-connections'),'utf8');assert(!stored.includes('user-private'));
  const second=new AccountConnections(h.accounts,h.solana,h.robinhood);
  const results=await Promise.allSettled([h.service.save(id,'market',{coingeckoKey:'web-change'},saved.revision),second.save(id,'market',{coingeckoKey:'telegram-change'},saved.revision)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.statusCode,409);
  const current=await h.service.read(id,'market');
  await assert.rejects(h.service.save(id,'market',{blockscoutKey:'https://api.example/key'},current.revision),/key only/);
  const clear=await h.service.save(id,'market',{blockscoutKey:''},current.revision);assert.equal(clear.values.blockscoutKey,'');assert(clear.values.coingeckoKey);
});
