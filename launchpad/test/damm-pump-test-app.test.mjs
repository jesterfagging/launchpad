import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Keypair} from '@solana/web3.js';
import {createDammPumpTestIntegration,createDammPumpTestMetadataPublisher} from '../src/damm-pump-test-app.mjs';

const SOL='So11111111111111111111111111111111111111112',USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
test('private status lists hundreds of compatible pairs without a live-price fanout; only the selected pair checks micro geometry',async t=>{
  const now=1790000000000;let prices=0,models=0;const pairs=[{mint:SOL,decimals:9,launchReady:true,symbol:'SOL'},{mint:USDC,decimals:6,launchReady:true,symbol:'USDC'},...Array.from({length:200},(_,i)=>({mint:Keypair.generate().publicKey.toBase58(),decimals:6,launchReady:true,symbol:'Q'+i}))];
  const productionService={listPairs:async()=>structuredClone(pairs),quoteEligibility:async mint=>structuredClone(pairs.find(row=>row.mint===mint)),getQuotePrice:async mint=>{prices++;return {mint,usd:mint===SOL?200:1,at:now};}};
  const adapter={model:launch=>{models++;if(launch.quoteMint===USDC)throw Error('Unsupported small-price rounding');return {startUsd:'50',graduationUsd:'100'};},close(){}};
  const accounts={hostStore:{read:async(_key,fallback)=>fallback}},session={account:{id:'owner',role:'admin',mfaEnabled:true},mfaVerified:true},context={sessionToken:'owner-session',authorize:async()=>session};
  const integration=createDammPumpTestIntegration({accounts,productionService,adapter,requireOwner:async()=>{},now:()=>now});t.after(()=>integration.stop());
  const status=await integration.service.ownerStatus(session,context);assert.equal(status.pairs.length,202);assert(status.pairs.every(pair=>pair.launchReady&&pair.testModelVerified===false));assert.equal(prices,0,'Opening status cannot start reference-price requests for the catalogue');assert.equal(models,0);
  const selected=await integration.service.quoteEligibility(SOL);assert.equal(selected.testModelVerified,true);assert.equal(prices,1);assert.equal(models,1);
  const incompatible=await integration.service.quoteEligibility(USDC);assert.equal(incompatible.launchReady,false);assert.match(incompatible.supportReason,/rounding/);assert.equal(prices,2);assert.equal(models,2);
  await integration.service.ownerStatus(session,context);assert.equal(prices,2,'Repeated status still does not refresh unrelated prices');assert(pairs.every(pair=>pair.launchReady),'Public catalogue is untouched');
});

test('private metadata defaults to the Launchpad icon and refuses another image owner or changes to a saved mint',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'launchpad-micro-metadata-'));t.after(()=>rm(dir,{recursive:true,force:true}));let images=0;
  const publish=createDammPumpTestMetadataPublisher({accounts:{dir},launches:{ownedImage:async(id)=>{images++;if(id!=='owner')throw Error('image owner mismatch');}},publicUrl:'https://launch.example'});
  const input={accountId:'owner',mint:Keypair.generate().publicKey.toBase58(),name:'Launchpad graduation test',symbol:'CTEST',description:'',image:''};const url=await publish(input);assert.match(url,/https:\/\/launch\.example\/token-metadata\//);const metadata=JSON.parse(await readFile(join(dir,'token-metadata',input.mint+'.json'),'utf8'));assert.equal(metadata.image,'https://launch.example/brand-icon.svg');assert.equal(metadata.properties.files[0].type,'image/svg+xml');assert.equal(images,0);assert.equal(await publish(input),url);
  await assert.rejects(publish({...input,name:'changed'}),/different published metadata/);await assert.rejects(publish({...input,mint:Keypair.generate().publicKey.toBase58(),image:'https://evil.example/icon.png'}),/uploaded token image/);await assert.rejects(publish({...input,accountId:'other',mint:Keypair.generate().publicKey.toBase58(),image:'/token-images/'+ 'a'.repeat(64)+'.png'}),/image owner mismatch/);
});
