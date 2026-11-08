import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey, Keypair } from '@solana/web3.js';
import { AccountLayout, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { Providers } from '../src/providers.mjs';

const mint = Keypair.generate().publicKey.toBase58();
const wallet = () => Keypair.generate().publicKey.toBase58();
const ata = (owner, program = TOKEN_2022_PROGRAM_ID) => getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), false, program).toBase58();
function account(owner, amount, program = TOKEN_2022_PROGRAM_ID, options = {}) {
  const data = Buffer.alloc(165);
  AccountLayout.encode({ mint: new PublicKey(mint), owner: new PublicKey(owner), amount, delegateOption: 0, delegate: PublicKey.default,
    state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default, ...options }, data);
  return { data: [data.toString('base64'), 'base64'], owner: program.toBase58(), executable: false, lamports: 2039280 };
}
function setup() {
  const p = new Providers({ rpcUrl: 'https://example.invalid', rpcRequestsPerSecond: 8, maxSignalAgeMs: 5000 }, () => {});
  const calls = [], accounts = new Map(), owned = new Map();
  p.rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'getMultipleAccounts') return { context: { slot: 120 }, value: params[0].map(a => accounts.get(a) || null) };
    if (method === 'getTokenAccountsByOwner') return { context: { slot: 121 }, value: owned.get(params[0]) || [] };
    if (method === 'getSignatureStatuses') return { value: params[0].map(() => ({ slot: 110, err: null, confirmationStatus: 'finalized' })) };
    throw Error(method);
  };
  return { p, calls, accounts, owned };
}
const group = (owner, rest = {}) => ({ wallet: owner, mint, tracked: 100n, minContextSlot: 100, ...rest });

test('20 simultaneous inventory checks share one fresh confirmed dual-program ATA snapshot', async () => {
  const { p, calls, accounts } = setup(), wallets = Array.from({ length: 20 }, wallet);
  wallets.forEach((owner, i) => accounts.set(ata(owner, i % 2 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID), account(owner, 100n, i % 2 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID)));
  const rows = await Promise.all(wallets.map(owner => p.trackedBalances([group(owner)])));
  assert.equal(calls.length, 1); assert.equal(calls[0].params[0].length, 40);
  assert.equal(calls[0].params[1].commitment, 'confirmed'); assert.equal(calls[0].params[1].minContextSlot, 100);
  assert(rows.every(([r]) => r.amount === 100n && !r.complete && r.slot === 120));
  accounts.clear();
  const [next] = await p.trackedBalances([group(wallets[0])]);
  assert.equal(next.amount, 0n); assert(next.complete); assert.equal(calls.length, 3);
});

test('legacy receipt slots are anchored once per burst before reading retained positions', async () => {
  const { p, calls, accounts } = setup(), wallets = Array.from({ length: 20 }, wallet);
  wallets.forEach(owner => accounts.set(ata(owner), account(owner, 100n)));
  await Promise.all(wallets.map((owner, i) => p.trackedBalances([group(owner, { minContextSlot: 0, signatures: [`old-${i}`] })])));
  assert.deepEqual(calls.map(c => c.method), ['getSignatureStatuses', 'getMultipleAccounts']);
  assert.equal(calls[0].params[0].length, 20); assert.equal(calls[1].params[1].minContextSlot, 110);
});

test('shortfall checks include all owned accounts instead of treating a missing ATA as a sale', async () => {
  const { p, calls, accounts, owned } = setup(), owner = wallet(), other = wallet();
  accounts.set(ata(owner), account(owner, 25n));
  owned.set(owner, [{ pubkey: ata(owner), account: account(owner, 25n) }, { pubkey: other, account: account(owner, 75n) }]);
  const [result] = await p.trackedBalances([group(owner)]);
  assert(result.complete); assert.equal(result.amount, 100n);
  const read = calls.find(c => c.method === 'getTokenAccountsByOwner');
  assert.equal(read.params[2].minContextSlot, 120); assert.equal(read.params[2].commitment, 'confirmed');
});

test('repeated outside exits return actual current inventory without adopting extra deposits', async () => {
  const { p, accounts, owned } = setup(), owner = wallet();
  accounts.set(ata(owner), account(owner, 331208783391n));
  owned.set(owner, [{ pubkey: ata(owner), account: account(owner, 331208783391n) }]);
  const [result] = await p.trackedBalances([group(owner, { tracked: 991714394254n })]);
  assert(result.complete); assert.equal(result.amount, 331208783391n);
  accounts.set(ata(owner), account(owner, 999999999999n));
  const [deposit] = await p.trackedBalances([group(owner)]);
  assert.equal(deposit.complete, false); // This lower bound never authorizes a quantity increase.
});

test('failed, stale, incomplete, mismatched, or cancelled reads never return a balance adjustment', async () => {
  for (const kind of ['unanchored', 'unknown-receipt', 'stale-ata', 'incomplete-ata', 'wrong-owner', 'wrong-mint', 'stale-owned', 'duplicate-owned', 'rpc', 'stop']) {
    const { p, accounts, owned } = setup(), owner = wallet(), abort = new AbortController(), original = p.rpc;
    if (kind === 'wrong-owner') accounts.set(ata(owner), account(wallet(), 1n));
    if (kind === 'wrong-mint') accounts.set(ata(owner), account(owner, 1n, TOKEN_2022_PROGRAM_ID, { mint: Keypair.generate().publicKey }));
    if (kind === 'duplicate-owned') owned.set(owner, Array(2).fill({ pubkey: ata(owner), account: account(owner, 1n) }));
    p.rpc = async (method, params, signal) => {
      if (kind === 'rpc') throw Error('limited');
      const result = await original(method, params, signal);
      if (kind === 'unknown-receipt' && method === 'getSignatureStatuses') result.value = [null];
      if (kind === 'stale-ata' && method === 'getMultipleAccounts') result.context.slot = 99;
      if (kind === 'incomplete-ata' && method === 'getMultipleAccounts') result.value = [];
      if (kind === 'stale-owned' && method === 'getTokenAccountsByOwner') result.context.slot = 119;
      return result;
    };
    const input = group(owner, kind === 'unanchored' ? { minContextSlot: 0 } : kind === 'unknown-receipt' ? { minContextSlot: 0, signatures: ['missing'] } : {});
    const job = p.trackedBalances([input], abort.signal);
    if (kind === 'stop') abort.abort();
    await assert.rejects(job, undefined, kind);
  }
});

test('frozen holdings remain positions while invalid token accounts are rejected', async () => {
  const { p, accounts } = setup(), owner = wallet();
  accounts.set(ata(owner), account(owner, 100n, TOKEN_2022_PROGRAM_ID, { state: 2 }));
  const [result] = await p.trackedBalances([group(owner)]); assert.equal(result.amount, 100n);
  accounts.set(ata(owner), account(owner, 100n, TOKEN_2022_PROGRAM_ID, { state: 0 }));
  await assert.rejects(p.trackedBalances([group(owner)]));
});
