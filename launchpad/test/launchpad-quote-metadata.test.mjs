import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,MintLayout,ExtensionType,MetadataPointerLayout } from '@solana/spl-token';
import { pack } from '@solana/spl-token-metadata';
import { QuoteMetadataResolver,quoteMetadataAddress,quoteMetadataFromMint } from '../src/launchpad-quote-metadata.mjs';
import { quoteLabel,cleanQuoteSymbol } from '../public/quote-identity.mjs';
import { createCoinRewardsView } from '../public/coin-rewards-view.mjs';
import { parseHTML } from 'linkedom';

const key=n=>new PublicKey(Buffer.alloc(32,n)),mint=key(7).toBase58(),other=key(8).toBase58();
const SV151='SV151D5pjygAKA8aJJcKzm4wFnRX5G92Fye94jQJk7g',METADATA=new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
function mintAccount({metadataMint=mint,pointer=mint,symbol='ASTRA',extensions=false}={}) {
  const value=pack({mint:new PublicKey(metadataMint),name:'Custom asset',symbol,uri:'https://not-fetched.invalid/metadata',additionalMetadata:[]});
  const data=Buffer.alloc(extensions?166+4+64+4+value.length:MintLayout.span);
  MintLayout.encode({mintAuthorityOption:0,mintAuthority:PublicKey.default,supply:1000000000n,decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},data);
  if(extensions){data[165]=1;data.writeUInt16LE(ExtensionType.MetadataPointer,166);data.writeUInt16LE(64,168);MetadataPointerLayout.encode({authority:PublicKey.default,metadataAddress:new PublicKey(pointer)},data,170);data.writeUInt16LE(ExtensionType.TokenMetadata,234);data.writeUInt16LE(value.length,236);data.set(value,238);}
  return{data,owner:extensions?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID,executable:false,lamports:1};
}
function metadataAccount({metadataMint=mint,symbol='ASTRA'}={}){
  const str=value=>{const text=Buffer.from(value),size=Buffer.alloc(4);size.writeUInt32LE(text.length);return Buffer.concat([size,text]);};
  return{owner:METADATA,executable:false,data:Buffer.concat([Buffer.from([4]),key(9).toBuffer(),new PublicKey(metadataMint).toBuffer(),str('Custom asset\0\0'),str(symbol+'\0'),str('https://not-fetched.invalid')])};
}

test('verified issuer labels replace legacy placeholders without changing the quote identity',()=>{
  assert.equal(quoteLabel(SV151,'QUOTE'),'SV151');assert.equal(quoteLabel(SV151,'USDC'),'SV151');
  for(const placeholder of ['QUOTE','quote tokens',' Custom pair ','Unknown','TOKEN'])assert.equal(quoteLabel(mint,placeholder),mint.slice(0,5)+'…'+mint.slice(-5));
  assert.equal(quoteLabel(mint,'QUOTE','ACTUAL'),'ACTUAL');assert.equal(cleanQuoteSymbol('\u202eSV151\0'),'SV151');
});

test('catalogue and validated inline Token-2022 metadata require no provider request',async()=>{
  const resolver=new QuoteMetadataResolver(),connection={getAccountInfo(){throw Error('unnecessary RPC');}};
  assert.equal((await resolver.read(connection,SV151,{fallbackSymbol:'QUOTE'})).symbol,'SV151');
  const account=mintAccount({extensions:true});assert.equal(quoteMetadataFromMint(mint,account).symbol,'ASTRA');
  const value=await resolver.read(connection,mint,{mintAccount:account,fallbackSymbol:'QUOTE'});assert.equal(value.source,'mint_metadata');assert.equal(value.name,'Custom asset');await resolver.close();
});

test('inline metadata cannot claim a different mint or follow a foreign pointer',()=>{
  assert.equal(quoteMetadataFromMint(mint,mintAccount({extensions:true,metadataMint:other})),null);
  assert.equal(quoteMetadataFromMint(mint,mintAccount({extensions:true,pointer:other})),null);
  assert.equal(quoteMetadataFromMint(mint,{...mintAccount({extensions:true}),owner:key(9)}),null);
  assert.equal(quoteMetadataFromMint(mint,{...mintAccount({extensions:true}),executable:true}),null);
  assert.equal(quoteMetadataFromMint(mint,mintAccount({extensions:true,symbol:'QUOTE'})),null);
});

test('canonical metadata resolves existing custom mints and coalesces cached RPC reads',async()=>{
  let calls=0,now=0;const resolver=new QuoteMetadataResolver({now:()=>now});
  const connection={getAccountInfo:async(address,commitment)=>{calls++;assert.equal(commitment,'confirmed');assert.equal(String(address),String(quoteMetadataAddress(mint)));return metadataAccount();}};
  const options={mintAccount:mintAccount(),fallbackSymbol:'QUOTE'};
  const values=await Promise.all([resolver.read(connection,mint,options),resolver.read(connection,mint,options)]);assert.equal(calls,1);assert.equal(values[0].symbol,'ASTRA');assert.equal(values[1].name,'Custom asset');
  await resolver.read(connection,mint,options);assert.equal(calls,1);now+=900001;await resolver.read(connection,mint,options);assert.equal(calls,2);await resolver.close();
});

test('legacy metadata rejects wrong mint, owner, executable and malformed Borsh data',async()=>{
  for(const account of [metadataAccount({metadataMint:other}),{...metadataAccount(),owner:key(9)},{...metadataAccount(),executable:true},{...metadataAccount(),data:Buffer.from([4])},metadataAccount({symbol:'QUOTE'})]){
    const resolver=new QuoteMetadataResolver();const result=await resolver.read({getAccountInfo:async()=>account},mint,{mintAccount:mintAccount(),fallbackSymbol:'QUOTE'});assert.equal(result.symbol,quoteLabel(mint));assert.equal(result.name,'');await resolver.close();
  }
});

test('failed lookups are cached briefly, keep safe saved labels, and never leak RPC errors',async()=>{
  let calls=0,now=0;const resolver=new QuoteMetadataResolver({now:()=>now}),connection={getAccountInfo:async()=>{calls++;throw Error('https://PRIVATE-RPC/?key=SECRET');}};
  const first=await resolver.read(connection,mint,{mintAccount:mintAccount(),fallbackSymbol:'ACTUAL'});assert.equal(first.symbol,'ACTUAL');assert(!JSON.stringify(first).includes('PRIVATE'));
  assert.equal((await resolver.read(connection,mint,{fallbackSymbol:'QUOTE'})).symbol,quoteLabel(mint));assert.equal(calls,1);now+=60001;await resolver.read(connection,mint);assert.equal(calls,2);await resolver.close();
});

test('a stalled optional metadata lookup returns promptly without duplicating the request',async()=>{
  let finish,calls=0;const resolver=new QuoteMetadataResolver({waitMs:10}),connection={getAccountInfo:async()=>{calls++;return new Promise(resolve=>{finish=resolve;});}};
  const result=await resolver.read(connection,mint,{mintAccount:mintAccount(),fallbackSymbol:'QUOTE'});assert.equal(result.symbol,quoteLabel(mint));assert.equal(calls,1);
  const waiting=resolver.read(connection,mint,{mintAccount:mintAccount()});finish(metadataAccount());assert.equal((await waiting).symbol,'ASTRA');assert.equal(calls,1);await resolver.close();
});

test('holder and agent cards show SV151 even for previously saved QUOTE labels',()=>{
  for(const feeMode of ['holders','buyback']){
    const {document}=parseHTML('<section></section>'),root=document.querySelector('section'),view=createCoinRewardsView({document,root});
    const coin={mint,feeMode,symbol:'BETA',quote:{mint:SV151,symbol:'QUOTE'}};
    const data={mint,mode:feeMode,quote:{mint:SV151,symbol:'QUOTE'},holder:{distributedQuote:'279.823',pendingQuote:'1.24837'},buyback:{totalQuoteSpent:'279.823',pendingQuote:'1.24837'}};
    view.render({coin,data});assert.match(root.textContent,/SV151/);assert(!root.textContent.includes('QUOTE'));assert.match(root.textContent,/279\.823/);
    data.quote.mint=other;data.quote.symbol='WRONG';view.render({coin,data});assert(!root.textContent.includes('WRONG'));assert(!root.textContent.includes('279.823'));
  }
});

test('custom quote symbols remain text and cannot create injected markup',()=>{
  const {document}=parseHTML('<section></section>'),root=document.querySelector('section');createCoinRewardsView({document,root}).render({coin:{mint,feeMode:'holders',quote:{mint:other,symbol:'<img src=x onerror=x>'}}});assert(!root.querySelector('img'));assert.match(root.textContent,/<img/);
});
