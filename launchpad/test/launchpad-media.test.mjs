import test from 'node:test';import assert from 'node:assert/strict';
import {LaunchMetadataStorage,inspectLaunchImage,MAX_LAUNCH_IMAGE,launchCoinWebsite} from '../src/launchpad-media.mjs';
import {LaunchQuoteCatalogue,sunriseAsset} from '../src/launchpad-quotes.mjs';
import {LAUNCH_ASSETS} from '../public/launch-assets.mjs';
import {PublicKey,Keypair} from '@solana/web3.js';
import {generateKeyPairSync} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import bs58 from 'bs58';
process.env.LAUNCHPAD_PUBLIC_URL='https://launchpad.example';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=';
test('uploaded images use immutable content IDs and reject active content, oversized payloads and false headers',()=>{
 const image=inspectLaunchImage(png);assert.equal(image.type,'image/png');assert.equal(image.width,1);assert.match(image.id,/^[a-f0-9]{64}\.png$/);assert.equal(inspectLaunchImage(png).id,image.id);
 for(const value of [Buffer.from('<svg><script>alert(1)</script></svg>').toString('base64'),png+'=',Buffer.alloc(MAX_LAUNCH_IMAGE+1).toString('base64'),Buffer.from('not an image '.repeat(6)).toString('base64')])assert.throws(()=>inspectLaunchImage(value));
 const large=Buffer.from(png,'base64');large.writeUInt32BE(100000,16);assert.throws(()=>inspectLaunchImage(large.toString('base64')),/4096/);
});
function storageHarness(){let price=0,number=0,failSecond=false;const signed=[],uploads=[],secrets=[],credits=[];
 const client={createTransaction:(data,{tags})=>{const id=String(++number).padStart(43,'a'),tx={id,sign:async()=>signed.push({id,data:Buffer.from(data),tags}),getPrice:async()=>({toFixed:()=>String(price)}),getRaw:()=>Buffer.from(id)};return tx;},utils:{getBundlerAddress:async()=>Keypair.generate().publicKey.toBase58()},funder:{submitFundTransaction:async s=>credits.push(s)},transaction:{fromRaw:raw=>({id:raw.toString(),isValid:async()=>true,upload:async()=>{uploads.push(raw.toString());if(failSecond&&uploads.length===2)throw Error('timeout');return{id:raw.toString(),signature:'receipt'};}})},verifyReceipt:async()=>true};
 const storage=new LaunchMetadataStorage({clientFactory:async secret=>{secrets.push(secret);return client;}}),keys={mint:{address:Keypair.generate().publicKey.toBase58()},wallet:{secret:'managed-fees'},payer:{secret:'developer'}};
 return{storage,keys,signed,uploads,secrets,credits,client,set price(v){price=v;},set failSecond(v){failSecond=v;}};
}
test('Irys coin image, metadata and Launchpad platform logo resume using their original immutable IDs',async()=>{
 const h=storageHarness(),input={name:'Example',symbol:'EX',description:'Hello',links:{website:'https://example.com'}};
 const prepared=await h.storage.prepare(input,h.keys,inspectLaunchImage(png));assert.equal(h.uploads.length,0);assert.equal(h.signed.length,3);
 const json=JSON.parse(h.signed[1].data);assert.equal(json.image,prepared.imageUrl);assert.equal(json.website,input.links.website);assert.equal(json.name,'Example');assert.equal(json.symbol,'EX');assert.equal(json.description,'Hello');assert.deepEqual(json.properties.launchpad,{name:'Launchpad',url:'https://launchpad.example'});assert(h.signed.every(row=>row.tags.some(tag=>tag.name==='App-Name'&&tag.value==='Launchpad')));assert.equal(h.signed[0].tags[0].value,'image/png');
 assert.equal(json.external_url,input.links.website);assert.equal(json.extensions.website,input.links.website);
 assert.deepEqual(h.signed[2].data,await readFile(new URL('../public/brand-icon.png',import.meta.url)));assert.equal(h.signed[2].tags[0].value,'image/png');assert.equal(prepared.storage.platformImage,'https://gateway.irys.xyz/'+h.signed[2].id);assert.notEqual(prepared.storage.platformImage,prepared.imageUrl);
 const launch={keys:h.keys,...prepared,operations:[]};let saves=0;h.failSecond=true;
 await assert.rejects(h.storage.upload(launch,async()=>saves++),/timeout/);assert.equal(launch.storage.items[0].state,'uploaded');assert.equal(launch.storage.items[1].state,'prepared');
 h.failSecond=false;await h.storage.upload(launch,async()=>saves++);assert.deepEqual(h.uploads,[h.signed[0].id,h.signed[1].id,h.signed[1].id,h.signed[2].id]);assert(h.secrets.every(s=>s==='developer'));assert.equal(saves,3);assert(launch.storage.items.every(i=>!i.raw));
});
test('blank creator websites use the actual mint page in each indexer field without changing reusable input',async()=>{
 for(const website of [undefined,'','   ']){
  const h=storageHarness(),input={name:'Example',symbol:'EX',links:{twitter:'https://x.com/example',telegram:'https://t.me/example',...(website===undefined?{}:{website})},publicOrigin:'https://attacker.example',host:'attacker.example'},before=structuredClone(input);
  const prepared=await h.storage.prepare(input,h.keys,inspectLaunchImage(png)),expected='https://launchpad.example/coin?mint='+h.keys.mint.address,json=JSON.parse(h.signed[1].data);
  assert.equal(json.website,expected);assert.equal(json.external_url,expected);assert.equal(json.extensions.website,expected);assert.equal(prepared.metadata.website,expected);assert.equal(json.extensions.twitter,input.links.twitter);assert.equal(json.extensions.telegram,input.links.telegram);assert.deepEqual(input,before);
  const nextKeys={...h.keys,mint:{address:Keypair.generate().publicKey.toBase58()}},next=await h.storage.prepare(input,nextKeys,inspectLaunchImage(png));
  assert.equal(next.metadata.website,'https://launchpad.example/coin?mint='+nextKeys.mint.address);assert.notEqual(next.metadata.website,expected);
 }
});
test('coin websites use only the configured HTTPS origin and canonical public coin route',async()=>{
 const h=storageHarness(),mint=h.keys.mint.address;
 assert.equal(launchCoinWebsite(mint,'https://LAUNCHPAD.example/'),'https://launchpad.example/coin?mint='+mint);
 const prepared=await h.storage.prepare({name:'Example',links:{}},h.keys,inspectLaunchImage(png),{publicUrl:'https://launch.example/'});
 assert.equal(prepared.metadata.website,'https://launch.example/coin?mint='+mint);
 for(const origin of ['http://launchpad.example','//attacker.example','https://user:pass@launchpad.example','https://launchpad.example/coin','https://launchpad.example/?host=attacker.example','https://launchpad.example/#fragment'])assert.throws(()=>launchCoinWebsite(mint,origin),/HTTPS origin/);
 for(const address of [undefined,'',mint+'?redirect=https://attacker.example',mint+'#fragment','../coin','1'.repeat(44)])assert.throws(()=>launchCoinWebsite(address),/prepared token mint/);
 const configured=process.env.LAUNCHPAD_PUBLIC_URL;delete process.env.LAUNCHPAD_PUBLIC_URL;try{assert.throws(()=>launchCoinWebsite(mint),/LAUNCHPAD_PUBLIC_URL must be an HTTPS origin/);}finally{process.env.LAUNCHPAD_PUBLIC_URL=configured;}
 const before=h.signed.length;await assert.rejects(h.storage.prepare({links:{}},{...h.keys,mint:undefined},inspectLaunchImage(png)),/prepared token mint/);assert.equal(h.signed.length,before);
});
test('a paid default website upload retry keeps its original signed metadata despite later configuration or input changes',async()=>{
 const h=storageHarness();h.price=1000;
 const input={name:'Example',symbol:'EX',links:{}},prepared=await h.storage.prepare(input,h.keys,inspectLaunchImage(png),{publicUrl:'https://launchpad.example'}),metadata=structuredClone(prepared.metadata),signed=h.signed.map(row=>({...row,data:Buffer.from(row.data)}));
 const launch={keys:h.keys,input,...prepared,operations:[{kind:'storage-fund',state:'confirmed',signature:'paid-storage'}]};h.failSecond=true;
 await assert.rejects(h.storage.upload(launch,async()=>{}),/timeout/);
 launch.publicOrigin='https://changed.example';launch.input.links.website='https://new-creator.example';h.failSecond=false;
 await h.storage.upload(launch,async()=>{});assert.deepEqual(h.signed,signed);assert.deepEqual(prepared.metadata,metadata);assert.deepEqual(h.credits,['paid-storage']);assert.deepEqual(h.uploads,[signed[0].id,signed[1].id,signed[1].id,signed[2].id]);
});
test('paid storage cannot upload before its journaled funding receipt and never funds itself through the SDK',async()=>{
 const h=storageHarness();h.price=1000;const prepared=await h.storage.prepare({name:'x',symbol:'X',links:{}},h.keys,inspectLaunchImage(png)),launch={keys:h.keys,...prepared,operations:[]};assert.equal(prepared.storage.budget,'3750');
 await assert.rejects(h.storage.upload(launch,async()=>{}),/payment/);assert.equal(h.uploads.length,0);
 launch.operations.push({kind:'storage-fund',state:'confirmed',signature:'confirmed-only'});await h.storage.upload(launch,async()=>{});await h.storage.upload(launch,async()=>{});assert.deepEqual(h.credits,['confirmed-only']);assert.equal(h.uploads.length,3);
 h.price=3000000;await assert.rejects(h.storage.prepare({name:'x',symbol:'X',links:{}},h.keys,inspectLaunchImage(png)),/expensive/);
});
test('storage rejects invalid receipts and shutdown prevents external upload',async()=>{
 const h=storageHarness(),prepared=await h.storage.prepare({name:'x',symbol:'X',links:{}},h.keys,inspectLaunchImage(png)),l={keys:h.keys,...prepared};
 assert.equal(await h.storage.upload(l,async()=>{},()=>true),false);assert.equal(h.uploads.length,0);
 h.client.verifyReceipt=async()=>false;await assert.rejects(h.storage.upload(l,async()=>{}),/signed receipt/);assert.equal(l.storage.items[0].state,'prepared');assert(l.storage.items[0].raw);
});
test('stock catalogue contains actual issuer mints, labels Micron correctly and does not invent launch support',()=>{
 assert.equal(new Set(LAUNCH_ASSETS.map(a=>a.mint)).size,LAUNCH_ASSETS.length);for(const asset of LAUNCH_ASSETS)new PublicKey(asset.mint);
 assert(LAUNCH_ASSETS.filter(a=>a.category==='stocks').length>=30);assert.match(LAUNCH_ASSETS.find(a=>a.symbol==='MU').name,/Micron/i);const backpack=LAUNCH_ASSETS.find(a=>a.mint==='BPxxfRCXkUVhig4HS1Lh7kZqV6SPJhzfEk4x6fVBjPCy');assert.equal(backpack?.symbol,'BP');assert.equal(backpack.name,'Backpack');
 const stock=sunriseAsset({chain:'solana',address:Keypair.generate().publicKey.toBase58(),name:'Stock',symbol:'ABC',stock:{ticker:'ABC'}});assert.equal(stock.category,'stocks');assert.equal(stock.issuer,'Sunrise listing');assert.equal(stock.supported,undefined);
 assert.equal(sunriseAsset({chain:'ethereum'}),null);
});
test('partial or looping issuer pagination cannot replace the verified quote catalogue',async()=>{
 let calls=0;const c=new LaunchQuoteCatalogue({fetcher:async()=>{calls++;return new Response(JSON.stringify({success:true,data:{listings:[{listing:{appId:'sunrise',status:'active',visibleFrom:'2026-01-01T00:00:00Z',visibleUntil:null},token:{horizonChainId:'solana',symbol:'FAKE',name:'Incomplete',address:Keypair.generate().publicKey.toBase58()}}],count:1,pagination:{limit:200,nextCursor:'same'}}}));}});
 const result=await c.read();assert.equal(calls,2);assert.deepEqual(result.assets,LAUNCH_ASSETS);assert(result.notice);await c.read();assert.equal(calls,2);
});
test('the installed Irys SDK prepares 44-character document IDs, restores signatures and verifies upload receipts without network access',async()=>{
 const wallet=Keypair.fromSeed(Buffer.alloc(32,7)),keys={mint:{address:Keypair.generate().publicKey.toBase58()},payer:{secret:bs58.encode(wallet.secretKey)}},client=await new LaunchMetadataStorage().client(keys.payer.secret);
 const create=client.createTransaction.bind(client),created=[],posted=[];
 client.createTransaction=(data,opts)=>{const tx=create(data,{...opts,anchor:'0'.repeat(32)});created.push(tx);return tx;};
 client.utils.getPrice=async()=>({toFixed:()=> '0'});
 client.utils.getBundlerAddress=async()=>{throw Error('Unexpected funding lookup');};
 const receiptKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'jwk'});
 client.api.post=async(url,raw)=>{
   assert.equal(new URL(url).pathname,'/tx/solana');const tx=client.transaction.fromRaw(raw);assert(await tx.isValid());posted.push(tx.id);
   const receipt={id:tx.id,deadlineHeight:123456,timestamp:123456789,version:'1.0.0',public:receiptKey.n};
   const payload=await client.bundles.deepHash(['Bundlr',receipt.version,receipt.id,String(receipt.deadlineHeight),String(receipt.timestamp)].map(s=>client.bundles.stringToBuffer(s)));
   receipt.signature=Buffer.from(await client.bundles.getCryptoDriver().sign(receiptKey,payload)).toString('base64url');
   return{status:200,data:receipt};
 };
 const storage=new LaunchMetadataStorage({clientFactory:async()=>client}),prepared=await storage.prepare({name:'Example',symbol:'EX',description:'Hello',links:{}},keys,inspectLaunchImage(png));
 assert(created.some(tx=>tx.id.length===44),'Fixture must cover the ID length that failed in production');
 for(const item of prepared.storage.items){assert.equal(bs58.decode(item.id).length,32);const tx=client.transaction.fromRaw(Buffer.from(item.raw,'base64'));assert.equal(tx.id,item.id);assert(await tx.isValid());}
 assert.equal(prepared.imageUrl,'https://gateway.irys.xyz/'+created[0].id);assert.equal(prepared.uri,'https://gateway.irys.xyz/'+created[1].id);
 assert.equal(JSON.parse(created[1].rawData).image,prepared.imageUrl);
 assert.equal(JSON.parse(created[1].rawData).external_url,'https://launchpad.example/coin?mint='+keys.mint.address);
 const launch={keys,...prepared,operations:[]};await storage.upload(launch,async()=>{});assert.deepEqual(posted,created.map(tx=>tx.id));assert(launch.storage.items.every(item=>item.state==='uploaded'&&!item.raw));
 for(const item of launch.storage.items){assert(await client.verifyReceipt(item.receipt));assert.equal(await client.verifyReceipt({...item.receipt,id:'tampered'}),false);}
});
test('external launch storage uses its managed platform identity without requesting an external private key',async()=>{
 const h=storageHarness(),keys={mint:h.keys.mint,payer:{address:Keypair.generate().publicKey.toBase58()},platform:{secret:'managed-storage'}},input={walletMode:'external',name:'Example',symbol:'EX',links:{}};
 const prepared=await h.storage.prepare(input,keys,inspectLaunchImage(png));await h.storage.upload({keys,input,...prepared,operations:[]},async()=>{});assert.deepEqual(h.secrets,['managed-storage','managed-storage']);
 await assert.rejects(h.storage.prepare(input,{...keys,platform:undefined},inspectLaunchImage(png)),/signing wallet is missing/);
});
test('a signed upload with another app tag resumes with exactly its original ID, tags and bytes',async()=>{
 const wallet=Keypair.fromSeed(Buffer.alloc(32,9)),secret=bs58.encode(wallet.secretKey),client=await new LaunchMetadataStorage().client(secret);
 const old=client.createTransaction(Buffer.from('{"name":"Creator coin","image":"https://legacy.example/coin.png"}'),{anchor:'0'.repeat(32),tags:[{name:'Content-Type',value:'application/json'},{name:'App-Name',value:'Previous name'}]});await old.sign();
 const raw=Buffer.from(old.getRaw()),id=old.id;let uploaded=0;
 client.api.post=async(_url,bytes)=>{assert.deepEqual(Buffer.from(bytes),raw);const restored=client.transaction.fromRaw(bytes);assert.equal(restored.id,id);assert(await restored.isValid());assert(restored.tags.some(tag=>tag.name==='App-Name'&&tag.value==='Previous name'));uploaded++;return {status:200,data:{id,signature:'saved-receipt'}};};client.verifyReceipt=async()=>true;
 client.createTransaction=()=>{throw Error('Legacy retries must not prepare a replacement storage item.');};
 const storage=new LaunchMetadataStorage({clientFactory:async()=>client}),launch={keys:{payer:{secret}},operations:[],storage:{provider:'irys',budget:'0',items:[{id,raw:raw.toString('base64'),state:'prepared'}]}};
 await storage.upload(launch,async()=>{});assert.equal(uploaded,1);assert.equal(launch.storage.items[0].id,id);assert.equal(launch.storage.items[0].state,'uploaded');
});
test('storage rejects malformed document IDs and a mismatched restored ID before uploading',async()=>{
 const h=storageHarness(),input={name:'x',symbol:'X',links:{}},create=h.client.createTransaction;
 for(const id of ['', '_'.repeat(44), 'abc/../evil', '1'.repeat(44)]){h.client.createTransaction=(...args)=>({...create(...args),id});await assert.rejects(h.storage.prepare(input,h.keys,inspectLaunchImage(png)),/invalid document ID/);}
 h.client.createTransaction=create;const prepared=await h.storage.prepare(input,h.keys,inspectLaunchImage(png));prepared.storage.items[0].raw=Buffer.from(prepared.storage.items[1].id).toString('base64');
 await assert.rejects(h.storage.upload({keys:h.keys,...prepared,operations:[]},async()=>{}),/signature failed validation/);assert.equal(h.uploads.length,0);
});
