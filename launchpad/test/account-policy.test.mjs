import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AccountFeePolicy, verifyFeeRecipient } from '../src/account-policy.mjs';

const recipient = Keypair.generate().publicKey.toBase58();
const genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const rpc = (value, chain = genesis) => async (_url, method) => method === 'getGenesisHash' ? chain : method === 'getMinimumBalanceForRentExemption' ? 890880 : { value };
const funded = { owner: SystemProgram.programId.toBase58(), executable: false, data: ['', 'base64'], lamports: 1000000 };
test('collector setup accepts a funded normal mainnet wallet and rejects absent, underfunded and program accounts', async () => {
  await verifyFeeRecipient(recipient, { rpc: rpc(funded) });
  for (const info of [null, { ...funded, lamports: 100 }, { ...funded, executable: true }, { ...funded, owner: recipient }, { ...funded, data: ['nonce', 'base64'] }]) {
    await assert.rejects(verifyFeeRecipient(recipient, { rpc: rpc(info) }), /Fund/);
  }
  await assert.rejects(verifyFeeRecipient(recipient, { rpc: rpc(funded, 'devnet') }), /mainnet/);
});
test('collector validation failure does not replace the active recipient', async t => {
  const dir=await mkdtemp(join(tmpdir(),'launchpad-fee-policy-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let saved = { recipient, fundingVerified: true }, fail = false;
  const accounts = { dir, hostStore: { read: async (key,fallback) => key==='fee-policy'?saved:fallback, write: async (_name, value) => { saved = value; } }, get: async () => ({ mainWallet: recipient, cashbackBps: 1000 }) };
  const policy = new AccountFeePolicy(accounts, { verifyRecipient: async () => { if (fail) throw new Error('Not funded'); } });
  await policy.setRecipient(recipient);
  const original = await policy.get('account');
  fail = true;
  await assert.rejects(policy.setRecipient(Keypair.generate().publicKey.toBase58()), /Not funded/);
  assert.equal((await policy.get('account')).recipient, original.recipient);
  assert.equal((await policy.get('account')).ready, true);
  saved.fundingVerified = false;
  assert.equal((await policy.get('account')).ready, false);
});

test('toolkit fees cannot be routed to an installed gas wallet even while refills are disabled',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'launchpad-fee-policy-gas-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const gasWallet=Keypair.generate().publicKey.toBase58(),records=new Map([['fee-policy',{recipient,fundingVerified:true}],['protocol-gas-funding',{enabled:false,wallet:{address:gasWallet}}]]);
  let verified=0,writes=0;
  const accounts={dir,hostStore:{read:async(name,fallback)=>structuredClone(records.get(name)??fallback),write:async(name,value)=>{writes++;records.set(name,structuredClone(value));}}};
  const policy=new AccountFeePolicy(accounts,{verifyRecipient:async()=>{verified++;}}),before=structuredClone([...records]);
  await assert.rejects(policy.setRecipient(gasWallet),/separate wallet.*service gas/);
  assert.deepEqual([...records],before);assert.equal(verified,0);assert.equal(writes,0);
  const other=Keypair.generate().publicKey.toBase58();await policy.setRecipient(other);assert.equal(records.get('fee-policy').recipient,other);
});
