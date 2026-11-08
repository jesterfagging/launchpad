import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { Keypair } from '@solana/web3.js';
import { createAccountApp } from '../src/account-app.mjs';
import { SOL_MINT } from '../public/launchpad-model.mjs';

const wallet=Keypair.generate().publicKey.toBase58(),otherWallet=Keypair.generate().publicKey.toBase58(),id='a'.repeat(32),otherId='b'.repeat(32);
test('personal rewards HTTP API is private, read-only, CSRF protected and ignores wallet overrides',async t=>{
  const person={id,mainWallet:wallet,authType:'wallet'},other={id:otherId,mainWallet:otherWallet,authType:'wallet'};
  let session={account:person,authMethod:'wallet',walletAddress:wallet,walletVerified:true};
  const accounts={master:Buffer.alloc(32),list:async()=>[person,other],get:async accountId=>accountId===id?person:other,hostStore:{read:async()=>null},
    getSessionWithCsrf:async(token,csrf)=>({session:token==='valid'?session:null,csrfValid:csrf==='csrf'}),registry:async()=>({accounts:[person,other]})};
  const now=Date.now(),launch={input:{route:'raydium',network:'mainnet-beta',feeMode:'holders',quoteMint:SOL_MINT},keys:{wallet:{address:otherWallet,secret:'PRIVATE_SECRET'},mint:{address:Keypair.generate().publicKey.toBase58()}},curve:Keypair.generate().publicKey.toBase58(),review:{quoteDecimals:9},operations:[{kind:'create',state:'confirmed',slot:1,signature:'2'.repeat(88)},{kind:'payout',state:'confirmed',slot:2,signature:'3'.repeat(88),amount:'1000000000',payouts:[{owner:wallet,amount:'1000000000'}],receipt:{quoteDelta:'-1000000000',baseDelta:'0'},confirmedAt:now}]};
  const server=createAccountApp({accounts,runtimes:{},policy:{},launchpad:{book:async accountId=>({launches:accountId===otherId?[launch]:[]})},
    marketData:{},protocolFees:{},protocolTreasury:{},branding:{},adminPanel:{},adminRevenue:{},explore:{quoteReferences:new Map([[SOL_MINT,{mint:SOL_MINT,usd:'100',at:now}]])},trading:{},adminVolume:{quotePrices:()=>new Map()},lifetimeVolume:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await server.closeServices();});
  const request=(path,{method='GET',headers={}}={})=>new Promise((resolve,reject)=>{
    const req=httpRequest(`http://127.0.0.1:${server.address().port}${path}`,{method,headers},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(chunks).toString()}));});req.on('error',reject);req.end();
  });
  const path='/api/launchpad/earnings',headers={cookie:'launchpad-session=valid','x-control-token':'csrf'};
  assert.equal((await request(path)).status,401);assert.equal((await request(path,{headers:{cookie:headers.cookie}})).status,403);
  assert.equal((await request(path,{method:'POST',headers})).status,405);
  const good=await request(path+`?wallet=${otherWallet}&accountId=${otherId}`,{headers}),data=JSON.parse(good.text);
  assert.equal(good.status,200);assert.equal(good.headers['cache-control'],'no-store');assert.equal(data.wallet,wallet);assert.equal(data.holders.usdEstimate,100);assert.doesNotMatch(good.text,/PRIVATE_SECRET/);
  session={account:other,authMethod:'wallet',walletAddress:otherWallet,walletVerified:true};const switched=JSON.parse((await request(path,{headers})).text);assert.equal(switched.wallet,otherWallet);assert.equal(switched.holders.usdEstimate,0);
  session=null;assert.equal((await request(path,{headers})).status,401);
  const asset=await request('/personal-earnings.mjs');assert.equal(asset.status,200);assert.match(asset.headers['content-type'],/javascript/);assert.match(asset.text,/personal|earnings/i);
});
