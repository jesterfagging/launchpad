import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {Keypair} from '@solana/web3.js';
import bs58 from 'bs58';
import {privateKeyToAccount} from 'viem/accounts';
import {verifyMessage} from 'viem';

test('the supported Irys Solana and EVM signing paths do not use the flagged Elliptic ECDSA signer',async()=>{
  const require=createRequire(import.meta.url),irysRequire=createRequire(require.resolve('@irys/upload-solana')),bundles=irysRequire('@irys/bundles'),elliptic=irysRequire('elliptic');
  const original=elliptic.ec.prototype.sign,wallet=Keypair.generate();
  elliptic.ec.prototype.sign=()=>{throw Error('Vulnerable ECDSA signing path used.');};
  try{
    const signer=new bundles.HexSolanaSigner(bs58.encode(wallet.secretKey)),message=Buffer.from('Launchpad dependency regression');
    const signature=await signer.sign(message);assert.equal(signature.length,64);assert.equal(await bundles.HexSolanaSigner.verify(wallet.publicKey.toBuffer(),message,signature),true);
    const evm=privateKeyToAccount('0x'+'11'.repeat(32)),text='Launchpad signing regression';
    const evmSignature=await evm.signMessage({message:text});assert.equal(await verifyMessage({address:evm.address,message:text,signature:evmSignature}),true);
  }finally{elliptic.ec.prototype.sign=original;wallet.secretKey.fill(0);}
});
