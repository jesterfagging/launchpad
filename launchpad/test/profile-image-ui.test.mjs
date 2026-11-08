import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
import {MAX_PROFILE_FILE_BYTES, validateProfilePicture, optimizeProfileImage} from '../public/profile-image.mjs';
import {createCashbackWalletUI} from '../public/cashback-wallet-ui.mjs';
import {createSignInWalletUI} from '../public/signin-wallet-ui.mjs';
import {inspectLaunchImage} from '../src/launchpad-media.mjs';

test('profile pictures accept exactly 5 MiB and reject larger, empty, or unsupported originals',()=>{
  assert.equal(MAX_PROFILE_FILE_BYTES,5 * 1024 * 1024);
  for(const type of ['image/png','image/jpeg','image/webp']){
    const file={type,size:MAX_PROFILE_FILE_BYTES};
    assert.equal(validateProfilePicture(file),file);
    assert.throws(()=>validateProfilePicture({...file,size:MAX_PROFILE_FILE_BYTES+1}),/5 MB or smaller/);
  }
  assert.throws(()=>validateProfilePicture({type:'image/png',size:0}),/non-empty/);
  assert.throws(()=>validateProfilePicture({type:'image/svg+xml',size:100}),/PNG, JPG or WebP/);
});

test('profile upload uses mobile image fallback while retaining 512px output and server raster validation',async()=>{
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=',data='data:image/png;base64,'+png;
  let bitmapCalls=0,imageCalls=0,closed=0,objectUrls=0;const revoked=[],draws=[],sources=[];
  const canvas={getContext:()=>({clearRect(){},drawImage(...args){draws.push(args);}}),toBlob:callback=>callback({size:68,type:'image/png'})};
  const image={naturalWidth:1024,naturalHeight:512,set src(value){sources.push(value);queueMicrotask(()=>this.onload());},removeAttribute(){closed++;}};
  const options={document:{createElement:type=>{if(type==='canvas')return canvas;imageCalls++;return image;}},createImageBitmap:async()=>{bitmapCalls++;throw Error('Unavailable in wallet browser');},URL:{createObjectURL:()=>{objectUrls++;return 'blob:profile';},revokeObjectURL:value=>revoked.push(value)},readBlob:async()=>data,maxEdge:4096};
  const result=await optimizeProfileImage({type:'image/png',size:68},options);
  assert.equal(result,data);assert.equal(bitmapCalls,1);assert.equal(imageCalls,1);assert.equal(closed,1);
  // The fallback decodes the picture from a data: URL; the site CSP (img-src 'self' data:) blocks blob: URLs.
  assert.deepEqual(sources,[data]);assert.equal(objectUrls,0);assert.deepEqual(revoked,[]);
  assert.equal(canvas.width,512);assert.equal(canvas.height,256);assert.deepEqual(draws[0].slice(1),[0,0,512,256]);
  assert.equal(inspectLaunchImage(result.split(',')[1]).type,'image/png');
  await assert.rejects(optimizeProfileImage({type:'image/png',size:MAX_PROFILE_FILE_BYTES+1},options),/5 MB/);assert.equal(bitmapCalls,1);
});

test('small profile originals remain usable with unavailable canvas without bypassing the upload cap',async()=>{
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=';
  const options={document:{createElement:()=>({getContext:()=>null})},createImageBitmap:async()=>({width:1,height:1,close(){}}),readBlob:async()=> 'data:image/png;base64,'+png};
  const result=await optimizeProfileImage({type:'image/png',size:68},options);assert.equal(inspectLaunchImage(result.split(',')[1]).type,'image/png');
  await assert.rejects(optimizeProfileImage({type:'image/png',size:96*1024+1},options),/browser could not prepare/);
});

test('oversized profile selections show feedback immediately without uploading or replacing the saved avatar',async()=>{
  const {document}=parseHTML(await readFile(new URL('../public/wallet-account.html',import.meta.url),'utf8'));
  const source=(await readFile(new URL('../public/wallet-account.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
  const account={username:'creator',mainWallet:'public-wallet',avatar:'/token-images/'+ 'a'.repeat(64)+'.png'},calls=[];
  const fetch=async(path,options={})=>{calls.push({path,...options});return{ok:true,json:async()=>path==='/api/session'?{authenticated:true,token:'csrf',account}:{account,cashback:[]}};};
  const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  await new AsyncFunction('document','fetch','createWorkspaceShell','validateProfilePicture','optimizeProfileImage','createCashbackWalletUI','createSignInWalletUI',source)(document,fetch,()=>{},validateProfilePicture,optimizeProfileImage,createCashbackWalletUI,createSignInWalletUI);
  const input=document.getElementById('profile-image'),message=document.getElementById('profile-message'),preview=document.getElementById('profile-preview');
  Object.defineProperty(input,'files',{value:[{type:'image/png',size:MAX_PROFILE_FILE_BYTES+1}],writable:true});
  input.value='too-big.png';input.onchange();
  assert.match(message.textContent,/5 MB or smaller/);assert.equal(input.value,'');
  assert.equal(preview.getAttribute('src'),account.avatar);assert.equal(preview.hidden,false);
  assert(calls.every(call=>!call.method||call.method==='GET'));
  assert.match(document.getElementById('profile-image-help').textContent,/PNG, JPG or WebP · 5 MB max/);
  input.files=[{type:'image/webp',size:MAX_PROFILE_FILE_BYTES}];input.value='allowed.webp';input.onchange();
  assert.equal(message.textContent,'');assert.equal(input.value,'allowed.webp');
  input.files=[{type:'image/jpeg',size:MAX_PROFILE_FILE_BYTES+1}];
  await document.getElementById('profile-form').onsubmit({preventDefault(){}});
  assert.match(message.textContent,/5 MB or smaller/);assert(calls.every(call=>call.method==='GET'));
});
