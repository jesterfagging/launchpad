import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPrivateKey,sign,randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {AccountService} from '../src/accounts.mjs';
import {Launchpad} from '../src/launchpad.mjs';
import {newLaunchKeys} from '../src/launchpad-receipts.mjs';
import {createAccountApp} from '../src/account-app.mjs';
import {SOL_MINT} from '../public/launchpad-model.mjs';

const password='creator-redirect-http-password-123';
const signature=(wallet,message)=>sign(null,Buffer.from(message),createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(wallet.secretKey.slice(0,32))]),format:'der',type:'pkcs8'})).toString('base64');
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-creator-redirect-http-')),accounts=await new AccountService(dir).init(),wallet=Keypair.generate(),recipient=Keypair.generate(),binding='c'.repeat(64),origin='https://launchpad.example';
  const prove=async key=>{const challenge=await accounts.walletChallenge(key.publicKey.toBase58(),origin,binding);return accounts.authenticateWallet({nonce:challenge.nonce,signature:signature(key,challenge.message)},origin,binding);};
  const creatorProof=await prove(wallet),creator=await accounts.createWalletSession(creatorProof),receiver=await accounts.createWalletSession(await prove(recipient));
  const unverified=await accounts.createSession(creatorProof.id),manualAccount=await accounts.register('manual_redirect',password),manual=await accounts.createSession(manualAccount.id);
  const manager=new Launchpad(accounts,null);manager.kick=()=>{};
  const launch={id:'d'.repeat(32),keys:{...newLaunchKeys(),payer:{address:wallet.publicKey.toBase58(),external:true}},input:{route:'raydium',network:'mainnet-beta',name:'Creator coin',symbol:'CREATOR',quoteMint:SOL_MINT,feeMode:'creator',recipient:wallet.publicKey.toBase58(),taxBps:0,walletMode:'external',externalWallet:wallet.publicKey.toBase58(),dailyGasLamports:'50000000'},review:{minimumSol:'0.02',quoteDecimals:9,quoteSymbol:'SOL'},feeCustody:'relay',authorizedAt:Date.now()-1000,createdAt:Date.now()-1000,lastCycle:Date.now()-1000,state:'live',curve:newLaunchKeys().mint.address,credits:{quote:'0',base:'0'},operations:[],gas:{day:'2026-09-29',reserved:'0'},autoFees:false};
  await manager.save(creatorProof.id,{version:1,launches:[launch]});
  const explore={registryLoaded:true,listCache:new Map()},server=createAccountApp({accounts,runtimes:{},policy:{},launchpad:manager,explore,pumpPublic:{start(){},stop(){},publicStatus:async()=>({available:false})},pumpTest:{requireOwner:async()=>{throw Error('Not owner');}},marketData:{},protocolFees:{},protocolTreasury:{},protocolGasFunding:{},branding:{},adminPanel:{},adminRevenue:{},adminRevenueAudit:{},trading:{},adminVolume:{},lifetimeVolume:{},publicAnalytics:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await server.closeServices();await rm(dir,{recursive:true,force:true});});
  async function request(path,{auth,body,method=body===undefined?'GET':'POST',headers={}}={}){const response=await fetch(base+path,{method,headers:{...(auth?{cookie:`launchpad-session=${auth.token}`,'x-control-token':auth.csrfToken}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};}
  return{accounts,manager,creator,receiver,unverified,manual,request,explore,launch,body:{id:launch.id,recipient:recipient.publicKey.toBase58(),expectedRecipient:wallet.publicKey.toBase58(),requestId:randomUUID()},read:async()=>(await manager.book(creatorProof.id)).launches[0]};
}

test('HTTP fee redirect requires original wallet proof and CSRF; body cannot impersonate its owner',async t=>{
  const h=await fixture(t),path='/api/launchpad/fee-assignments/redirect',before=await h.read();
  assert.equal((await h.request(path,{body:h.body})).status,401);
  assert.equal((await h.request(path,{auth:h.creator,body:h.body,headers:{'x-control-token':'wrong'}})).status,403);
  assert.equal((await h.request(path,{auth:h.creator})).status,405);
  assert.equal((await h.request(path+'?owner=true',{auth:h.creator,body:h.body})).status,400);
  for(const auth of [h.unverified,h.manual,h.receiver]){
    const result=await h.request(path,{auth,body:{...h.body,ownerAccountId:h.creator.account.id,accountId:h.creator.account.id,walletVerified:true,walletAddress:h.body.expectedRecipient}});
    assert.equal(result.status,403);assert.deepEqual(await h.read(),before);
  }
  const result=await h.request(path,{auth:h.creator,body:h.body});assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.launch.input.recipient,h.body.recipient);assert.equal(result.body.alreadyRedirected,false);assert.equal(h.explore.registryLoaded,false);
  assert.doesNotMatch(JSON.stringify(result.body),/secret|actorId|requestId/);
  const retry=await h.request(path,{auth:h.creator,body:h.body});assert.equal(retry.status,200);assert.equal(retry.body.alreadyRedirected,true);assert.equal((await h.read()).feeRecipientHistory.length,1);
  const again=await h.request(path,{auth:h.creator,body:{...h.body,expectedRecipient:h.body.recipient,recipient:Keypair.generate().publicKey.toBase58(),requestId:randomUUID()}});assert.equal(again.status,409);
});

test('session endpoint reports verified wallet identity only for server-proven sessions',async t=>{
  const h=await fixture(t);
  const proven=await h.request('/api/session',{auth:h.creator});assert.equal(proven.status,200);assert.equal(proven.body.authMethod,'wallet');assert.equal(proven.body.walletVerified,true);assert.equal(proven.body.walletAddress,h.body.expectedRecipient);
  for(const auth of [h.unverified,h.manual]){const data=(await h.request('/api/session',{auth})).body;assert.equal(data.authMethod,'password');assert.equal(data.walletVerified,false);assert.equal(data.walletAddress,null);}
  await h.accounts.revokeSession(h.creator.token);const revoked=(await h.request('/api/session',{auth:h.creator})).body;assert.equal(revoked.authenticated,false);assert.equal(revoked.walletAddress,undefined);
  assert.equal((await h.request('/api/launchpad/fee-assignments/redirect',{auth:h.creator,body:h.body})).status,401);
});

test('logout while a redirect waits for its owner journal lock prevents mutation',async t=>{
  const h=await fixture(t),original=h.manager.locked.bind(h.manager);let locked=false;
  h.manager.locked=async(id,fn)=>{locked=true;await h.accounts.revokeSession(h.creator.token);return original(id,fn);};
  const before=await h.read(),result=await h.request('/api/launchpad/fee-assignments/redirect',{auth:h.creator,body:h.body});
  assert.equal(locked,true);assert.equal(result.status,401);assert.deepEqual(await h.read(),before);
});
