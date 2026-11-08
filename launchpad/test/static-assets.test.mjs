import test from 'node:test';
import assert from 'node:assert/strict';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { createStaticAsset, staticAssetRepresentation, staticAssetMatches, warmStaticAssetEncoding } from '../src/static-assets.mjs';

const content=Buffer.from('const unchanged = "Launchpad appearance and behavior remain identical";\n'.repeat(1000));
test('public text is losslessly compressed once per accepted encoding',async()=>{
  const asset=createStaticAsset(content);
  const [first,second]=await Promise.all([staticAssetRepresentation(asset,'text/javascript','gzip, br'),staticAssetRepresentation(asset,'text/javascript','br')]);
  assert.equal(first,second);assert.equal(asset.variants.size,1);assert.equal(first.encoding,'br');
  assert.deepEqual(brotliDecompressSync(first.bytes),content);assert(first.bytes.length<content.length/2);
  const zipped=await staticAssetRepresentation(asset,'text/javascript','gzip');
  assert.equal(zipped.encoding,'gzip');assert.deepEqual(gunzipSync(zipped.bytes),content);assert.equal(asset.variants.size,2);
  assert.notEqual(first.etag,asset.etag);assert.notEqual(first.etag,zipped.etag);assert.deepEqual(asset.bytes,content);
});
test('the warm-up upgrades an early quick body to the best compression without changing content',async()=>{
  const text=Buffer.from(Array.from({length:4000},(_,i)=>`export const row${i} = ${JSON.stringify('Launchpad '+(i*7919%1000))};`).join('\n'));
  const asset=createStaticAsset(text),early=await staticAssetRepresentation(asset,'text/javascript','br');
  assert.equal(early.encoding,'br');assert.deepEqual(brotliDecompressSync(early.bytes),text);
  const [best,again]=await Promise.all([warmStaticAssetEncoding(asset,'text/javascript','br'),warmStaticAssetEncoding(asset,'text/javascript','br')]);
  assert.equal(best,again,'concurrent warm-ups share one compression');assert(best.bytes.length<early.bytes.length,'best quality is smaller');
  assert.deepEqual(brotliDecompressSync(best.bytes),text);assert.notEqual(best.etag,early.etag);
  assert.equal(await staticAssetRepresentation(asset,'text/javascript','br'),best,'requests now share the upgraded body');assert.equal(asset.variants.size,1);
  assert.equal(await warmStaticAssetEncoding(asset,'text/javascript','br'),best,'an upgraded body is never rebuilt');
  const zipped=await warmStaticAssetEncoding(asset,'text/javascript','gzip');assert.deepEqual(gunzipSync(zipped.bytes),text);assert.equal(asset.variants.size,2);
  // Binary media and tiny text are never compressed, warmed or not.
  for(const [type,bytes] of [['image/png',text],['font/woff2',text],['text/css',Buffer.from('body{color:white}')]]){const other=createStaticAsset(bytes);assert.equal(await warmStaticAssetEncoding(other,type,'br'),null,type);assert.equal(other.variants.size,0);}
});
test('negotiation respects explicit exclusions, identity preference, wildcards and empty headers',async()=>{
  const asset=createStaticAsset(content);
  for(const [header,encoding] of [[undefined,null],['',null],['br;q=0,gzip;q=1','gzip'],['gzip;q=0,br;q=0',null],['br;q=0.3,gzip;q=0.7','gzip'],['br;q=0.5,identity;q=1',null],['*;q=0,identity;q=1',null],['*;q=1,gzip;q=0','br'],['BR;q=1,GZIP;q=0','br'],['zstd',null]]) {
    assert.equal((await staticAssetRepresentation(asset,'text/css',header)).encoding,encoding,String(header));
  }
  assert.equal(await staticAssetRepresentation(asset,'text/css','br;q=0,gzip;q=0,identity;q=0'),null);
  assert.equal(await staticAssetRepresentation(asset,'text/css','*;q=0'),null);
  assert.equal((await staticAssetRepresentation(asset,'text/css','br;q=1,br;q=0,gzip')).encoding,'gzip');
});
test('already-compressed images/fonts and tiny text are delivered unchanged',async()=>{
  for(const type of ['image/png','image/webp','font/woff2']) {
    const asset=createStaticAsset(content),response=await staticAssetRepresentation(asset,type,'br,gzip');
    assert.equal(response.encoding,null);assert.equal(response.bytes,content);assert.equal(asset.variants.size,0);
  }
  const asset=createStaticAsset(Buffer.from('body{color:white}'));
  assert.equal((await staticAssetRepresentation(asset,'text/css','br,gzip')).encoding,null);
  assert.equal((await staticAssetRepresentation(asset,'text/css','gzip,identity;q=0')).encoding,'gzip');
});
test('conditional requests match only the selected representation including weak tags and lists',()=>{
  const tag='"selected"';
  for(const header of [tag,'W/'+tag,'"old", W/'+tag,'*'])assert.equal(staticAssetMatches(header,tag),true);
  for(const header of [undefined,'"different"','"selected-other"'])assert.equal(staticAssetMatches(header,tag),false);
});
