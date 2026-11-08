import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { AccountLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';

const require=createRequire(import.meta.url),solanaRequire=createRequire(require.resolve('@solana/buffer-layout-utils')),codec=solanaRequire('bigint-buffer'),layout=require('@solana/buffer-layout-utils');

test('Solana integer decoding uses the bundled JavaScript codec without loading a native addon',()=>{
  assert.equal(solanaRequire('bigint-buffer/package.json').name,'@launchpad/bigint-buffer-js');
  assert.equal(readFileSync(solanaRequire.resolve('bigint-buffer'),'utf8'),readFileSync(new URL('../vendor/bigint-buffer/index.cjs',import.meta.url),'utf8'));
  assert.equal(Object.keys(require.cache).some(path=>/bigint.*\.node$/.test(path)),false);
  assert.equal(codec.toBigIntLE(Buffer.alloc(0)),0n);assert.equal(codec.toBigIntBE(Buffer.alloc(0)),0n);
  assert.equal(codec.toBigIntLE(Buffer.from('01020304','hex')),0x04030201n);assert.equal(codec.toBigIntBE(Buffer.from('01020304','hex')),0x01020304n);
  // The native implementation cannot safely handle this boundary. The JS path
  // must decode without buffer over-read, input mutation or process failure.
  const bytes=Buffer.alloc(65,255),original=Buffer.from(bytes);
  assert.equal(codec.toBigIntLE(bytes),(1n<<520n)-1n);assert.deepEqual(bytes,original);
});

test('all Solana unsigned layouts retain exact bytes, offsets and full-width values',()=>{
  for(const bits of [64,128,192,256]){
    const width=bits/8,maximum=(1n<<BigInt(bits))-1n;
    for(const value of [0n,1n,1n<<BigInt(bits-1),maximum,BigInt('0x'+randomBytes(width).toString('hex'))]){
      for(const endian of ['','be']){
        const type=layout['u'+bits+endian](),buffer=Buffer.alloc(width+4,0x55);type.encode(value,buffer,2);
        assert.equal(type.decode(buffer,2),value);assert.equal(buffer[0],0x55);assert.equal(buffer.at(-1),0x55);
        const expected=value.toString(16).padStart(width*2,'0'),bytes=buffer.subarray(2,2+width);
        assert.equal((endian?bytes:Buffer.from(bytes).reverse()).toString('hex'),expected);
      }
    }
  }
});

test('oversized, negative and malformed integer encodings fail without truncating balances',()=>{
  for(const encode of [codec.toBufferLE,codec.toBufferBE]){
    for(const value of [-1n,1n<<64n,1,NaN])assert.throws(()=>encode(value,8),/unsigned|width/);
    for(const width of [-1,1.5,Infinity,1025])assert.throws(()=>encode(1n,width),/width/);
    assert.deepEqual(encode(0n,0),Buffer.alloc(0));assert.throws(()=>encode(1n,0),/width/);
  }
  assert.throws(()=>codec.toBigIntLE('private-input'),/Buffer/);
  const mint=Keypair.generate().publicKey,owner=Keypair.generate().publicKey,data=Buffer.alloc(AccountLayout.span),amount=(1n<<64n)-1n;
  AccountLayout.encode({mint,owner,amount,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},data);
  const decoded=AccountLayout.decode(data);assert.equal(decoded.amount,amount);assert(decoded.mint.equals(mint));assert(decoded.owner.equals(owner));assert(TOKEN_PROGRAM_ID);
});
