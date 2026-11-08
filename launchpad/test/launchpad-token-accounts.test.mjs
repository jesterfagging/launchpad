import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Keypair, PublicKey } from '@solana/web3.js';
import { AccountLayout, ExtensionType, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TransferFeeAmountLayout } from '@solana/spl-token';
import { LaunchChain } from '../src/launchpad-chain.mjs';
import { readMintTokenAccounts } from '../src/launchpad-token-accounts.mjs';

const mint = Keypair.generate().publicKey, holder = Keypair.generate().publicKey;
const invalid = { code: 'REWARD_ACCOUNT_SCAN_INVALID' }, retry = { code: 'REWARD_ACCOUNT_SCAN_RETRY' };
const row = ({ program = TOKEN_2022_PROGRAM_ID, owner = holder, amount = 10n, state = 1, withheld, tokenMint = mint, address = Keypair.generate().publicKey } = {}) => {
  const data = Buffer.alloc(withheld === undefined ? AccountLayout.span : 170 + TransferFeeAmountLayout.span);
  AccountLayout.encode({ mint: tokenMint, owner, amount, delegateOption: 0, delegate: PublicKey.default, state, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  if (withheld !== undefined) { data[165] = 2; data.writeUInt16LE(ExtensionType.TransferFeeAmount, 166); data.writeUInt16LE(TransferFeeAmountLayout.span, 168); TransferFeeAmountLayout.encode({ withheldAmount: withheld }, data, 170); }
  return { pubkey: address, account: { data, owner: program, executable: false, lamports: 2039280, rentEpoch: 18446744073709551615 } };
};
const raw = record => ({ pubkey: record.pubkey.toBase58(), account: { ...record.account, owner: record.account.owner.toBase58(), data: [record.account.data.toString('base64'), 'base64'] } });

test('verified mint-withheld fees remain collectible during a temporary account-index outage',async()=>{
  const wallet=Keypair.generate().publicKey,launch={keys:{wallet:{address:wallet.toBase58()},mint:{address:mint.toBase58()}},input:{route:'raydium',feeMode:'holders',taxBps:200,quoteMint:TOKEN_PROGRAM_ID.toBase58()},review:{quoteProgram:TOKEN_PROGRAM_ID.toBase58()}};
  for(const withheld of [19091161794670n,0n]){
    // Even valid accounts from earlier pages must not enter fallback results.
    const f=fixture([page([row({withheld:99n})],'next'),Object.assign(Error('account index service overloaded'),{code:-32005})]),chain=new LaunchChain({network:'mainnet-beta',connection:f.chain.c});
    chain.mintInfo=async()=>({});chain.transferTax=()=>({withdrawWithheldAuthority:wallet,withheldAmount:withheld});
    if(withheld===0n)await assert.rejects(chain.claimInstructions(launch,'tax'),{code:'REWARD_ACCOUNT_SCAN_RETRY'});
    else {const instructions=await chain.claimInstructions(launch,'tax');assert.equal(instructions.length,2);assert.equal(instructions.taxAccountScanDeferred,true);assert.deepEqual([...instructions[1].data],[26,2]);assert(instructions[1].keys[0].pubkey.equals(mint));assert(instructions[1].keys[2].pubkey.equals(wallet));}
    assert.equal(f.calls.length,2);
  }
  for(const response of [page([row({tokenMint:Keypair.generate().publicKey})]),{jsonrpc:'2.0',error:{code:-32601,message:'Method not found'}}]){
    const f=fixture([response]),chain=new LaunchChain({network:'mainnet-beta',connection:f.chain.c});chain.mintInfo=async()=>({});chain.transferTax=()=>({withdrawWithheldAuthority:wallet,withheldAmount:1n});
    await assert.rejects(chain.claimInstructions(launch,'tax'),error=>['REWARD_ACCOUNT_SCAN_INVALID','REWARD_ACCOUNT_SCAN_RPC'].includes(error.code));
  }
});
const page = (rows = [], paginationKey = null, slot = 100) => ({ jsonrpc: '2.0', id: 'test', result: { context: { slot }, value: { accounts: rows.map(raw), paginationKey } } });
function fixture(pages, endpoint = 'https://mainnet.helius-rpc.com/?api-key=test-only') {
  const calls = [], chain = { c: { rpcEndpoint: endpoint, _rpcRequest: async (method, params) => { calls.push({ method, params }); const result = pages[calls.length - 1]; if (result instanceof Error) throw result; return result; }, getProgramAccounts: async () => { throw Error('Standard GPA must not replace a failed paginated scan.'); } } };
  return { chain, calls, read: (options, program = TOKEN_2022_PROGRAM_ID) => readMintTokenAccounts(chain, program, mint, options) };
}

test('Helius reads every filtered page, including short and empty pages, and deduplicates identical accounts', async () => {
  const a = row(), b = row({ amount: 20n });
  const f = fixture([page([a], 'a', 100), page([], 'b', 101), page([a, b], null, 102)]);
  const result = await f.read({ minContextSlot: 99 });
  assert.equal(result.context.slot, 102); assert.deepEqual(result.value.map(x => x.pubkey.toBase58()), [a.pubkey.toBase58(), b.pubkey.toBase58()]);
  assert(Buffer.isBuffer(result.value[0].account.data)); assert(result.value[0].account.owner.equals(TOKEN_2022_PROGRAM_ID));
  assert.equal(f.calls.length, 3);
  for (const [i, call] of f.calls.entries()) {
    assert.equal(call.method, 'getProgramAccountsV2'); assert.equal(call.params[0], TOKEN_2022_PROGRAM_ID.toBase58());
    assert.deepEqual(call.params[1], { commitment: 'finalized', withContext: true, filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }], minContextSlot: [99, 100, 101][i], encoding: 'base64', limit: 1000, ...(i ? { paginationKey: ['a', 'b'][i - 1] } : {}) });
    assert(!('changedSinceSlot' in call.params[1]), 'Rewards require all holders, never just recently changed accounts');
  }
});

test('unknown endpoints retain finalized standard GPA even when their URL contains a Helius hostname', async () => {
  for (const endpoint of ['https://rpc.example.test/?provider=mainnet.helius-rpc.com', 'https://mainnet.helius-rpc.com.attacker.test/', 'https://rpc.example.test/mainnet.helius-rpc.com', undefined]) {
    for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      let reads = 0; const a = row({ program });
      const chain = { c: { rpcEndpoint: endpoint, _rpcRequest: async () => assert.fail('Unknown providers must not receive Helius extensions'), getProgramAccounts: async (actualProgram, config) => { reads++; assert(actualProgram.equals(program)); assert.deepEqual(config, { commitment: 'finalized', withContext: true, filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }], minContextSlot: 70 }); return { context: { slot: 71 }, value: [a] }; } } };
      assert.equal((await readMintTokenAccounts(chain, program, mint, { minContextSlot: 70 })).value.length, 1); assert.equal(reads, 1);
    }
  }
});

test('a later-page RPC failure never returns partial holders and never falls back to GPA', async () => {
  const f = fixture([page([row()], 'next'), { jsonrpc: '2.0', error: { code: -32000, message: 'account index service overloaded; https://provider/?api-key=do-not-persist' } }]);
  await assert.rejects(f.read(), error => { assert.equal(error.code, retry.code); assert(!error.message.includes('do-not-persist')); return true; });
  assert.equal(f.calls.length, 2);
  const unsupported = fixture([{ jsonrpc: '2.0', error: { code: -32601, message: 'Method not found https://provider/?api-key=secret' } }]);
  await assert.rejects(unsupported.read(), { code: 'REWARD_ACCOUNT_SCAN_RPC' }); assert.equal(unsupported.calls.length, 1);
  for (const code of [-32600, -32601, -32602, -32001]) await assert.rejects(fixture([{ jsonrpc: '2.0', error: { code, message: 'temporarily unavailable', retryable: true } }]).read(), { code: 'REWARD_ACCOUNT_SCAN_RPC' });
});

test('malformed pages, missing completion, repeated cursors and regressing context fail closed', async () => {
  for (const response of [
    { jsonrpc: '2.0', result: { accounts: [], paginationKey: null } },
    { jsonrpc: '2.0', result: { context: { slot: 100 }, value: { accounts: [] } } },
    { jsonrpc: '2.0', result: { context: { slot: 100 }, value: { accounts: [], paginationKey: '' } } },
    page([], null, 0), page([], null, 99), page([], null, 100.5),
  ]) await assert.rejects(fixture([response]).read({ minContextSlot: 100 }), invalid);
  await assert.rejects(fixture([page([], 'same'), page([], 'same', 101)]).read(), invalid);
  await assert.rejects(fixture([page([], 'a'), page([], 'b', 101), page([], 'a', 102)]).read(), invalid);
  await assert.rejects(fixture([page([], 'a', 101), page([], null, 100)]).read(), invalid);
  await assert.rejects(fixture(Array.from({ length: 100 }, (_, i) => page([], 'next-' + i))).read(), /page limit/);
});

test('wrong program, wrong mint, invalid encoding and conflicting duplicates cannot enter a reward scan', async () => {
  const badRows = [row({ program: TOKEN_PROGRAM_ID }), row({ tokenMint: Keypair.generate().publicKey }), row({ state: 0 }), row({ state: 3 })];
  for (const record of badRows) await assert.rejects(fixture([page([record])]).read(), invalid);
  for (const change of [r => r.account.data[1] = 'base64+zstd', r => r.account.data[0] += '!', r => r.account.executable = true, r => r.account.lamports = -1, r => r.pubkey = 'invalid-key']) {
    const response = page([row()]); change(response.result.value.accounts[0]); await assert.rejects(fixture([response]).read(), invalid);
  }
  const a = row(), changed = row({ address: a.pubkey, amount: 999n });
  await assert.rejects(fixture([page([a], 'next'), page([changed])]).read(), /conflicting duplicate/);
});

test('account and time budgets never produce truncated success', async t => {
  const a = row(), pages = Array.from({ length: 51 }, (_, i) => page(Array(1000).fill(a), 'next-' + i));
  await assert.rejects(fixture(pages).read(), /service limit/);
  await assert.rejects(fixture([page(Array(1001).fill(a))]).read(), invalid);
  let clock = 1000; t.mock.method(Date, 'now', () => clock);
  const f = fixture([page([a], 'next')]);
  f.chain.c._rpcRequest = async () => { clock += 60001; return page([a], null); };
  await assert.rejects(f.read(), retry);
});

test('holder eligibility and tax harvesting both consume the complete shared scan', async () => {
  const wallet = Keypair.generate().publicKey, offCurve = PublicKey.findProgramAddressSync([Buffer.from('excluded')], TOKEN_PROGRAM_ID)[0];
  const launch = { keys: { wallet: { address: wallet.toBase58() }, mint: { address: mint.toBase58() } }, input: { route: 'raydium', feeMode: 'holders', taxBps: 100, quoteMint: TOKEN_PROGRAM_ID.toBase58() }, review: { quoteProgram: TOKEN_PROGRAM_ID.toBase58() } };
  for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const a = row({ program }), b = row({ program, amount: 21n }), excluded = [row({ program, owner: wallet }), row({ program, owner: offCurve }), row({ program, amount: 0n }), row({ program, state: 2 })];
    const f = fixture([page([a, ...excluded], 'next'), page([b], null, 101)]), chain = new LaunchChain({ network: 'mainnet-beta', connection: f.chain.c });
    chain.mintInfo = async () => ({ program });
    assert.deepEqual(await chain.holderSnapshot(launch), { slot: 101, rows: [{ owner: holder.toBase58(), amount: '10' }, { owner: holder.toBase58(), amount: '21' }] });
  }
  const sources = Array.from({ length: 14 }, () => row({ withheld: 9n }));
  const f = fixture([page([row({ withheld: 0n })], 'next'), page(sources, null, 101)]), chain = new LaunchChain({ network: 'mainnet-beta', connection: f.chain.c });
  chain.mintInfo = async () => ({}); chain.transferTax = () => ({ withdrawWithheldAuthority: wallet, withheldAmount: 1n });
  const instructions = await chain.claimInstructions(launch, 'tax');
  assert.equal(f.calls.length, 2); assert.equal(instructions.length, 3);
  const sourceKeys = instructions.at(-1).keys.slice(3).map(key => key.pubkey.toBase58());
  assert.deepEqual(sourceKeys, sources.slice(0, 12).map(record => record.pubkey.toBase58()), 'Collection preserves the existing twelve-account transaction bound');
  const failed = fixture([page(sources, 'next'), Error('RPC timed out')]); chain.c = failed.chain.c;
  chain.transferTax = () => ({ withdrawWithheldAuthority: wallet, withheldAmount: 0n });
  await assert.rejects(chain.claimInstructions(launch, 'tax'), retry);
});

test('every V2 page uses the existing endpoint gate and inherited deadline before HTTP', async t => {
  const permits = [], calls = [], events = [];
  t.mock.method(https, 'request', (_url, _options, callback) => {
    const request = new EventEmitter(); request.setTimeout = () => request;
    request.end = body => queueMicrotask(() => {
      const call = JSON.parse(body); calls.push(call); events.push('http');
      const response = new PassThrough(); response.statusCode = 200; response.headers = { 'content-type': 'application/json' }; callback(response);
      response.end(JSON.stringify({ ...page([], calls.length === 1 ? 'next' : null, 100 + calls.length), id: call.id }));
    }); return request;
  });
  const chain = new LaunchChain({ network: 'mainnet-beta', rpcUrl: 'https://mainnet.helius-rpc.com/?api-key=test-only', rpcGate: { acquire: async (key, client, rate, options) => { permits.push({ key, client, rate, options }); events.push('gate'); }, removeClient() {}, cooldown() {} } }); t.after(() => chain.close());
  const deadline = Date.now() + 5000;
  const result = await chain.withRpcContext({ deadline }, () => readMintTokenAccounts(chain, TOKEN_2022_PROGRAM_ID, mint));
  assert.equal(result.context.slot, 102); assert.deepEqual(events, ['gate', 'http', 'gate', 'http']);
  assert.equal(permits.length, 2); assert.equal(permits[0].key, permits[1].key); assert.equal(permits[0].client, permits[1].client);
  for (const permit of permits) { assert.equal(permit.options.method, 'getProgramAccountsV2'); assert(permit.options.deadline <= deadline); }
  await assert.rejects(chain.withRpcContext({ deadline: Date.now() - 1 }, () => readMintTokenAccounts(chain, TOKEN_2022_PROGRAM_ID, mint)), retry);
  assert.equal(calls.length, 2, 'Expired scans never reach HTTP');
});

test('known scheduler and capacity transport failures retry without returning a partial token scan',async()=>{
  const messages=[
    'RPC scheduler closed.',
    'RPC worker closed.',
    'Request scheduler closed.',
    'Request worker closed.',
    'Maximum signal age exceeded before the RPC request started.',
    'RPC capacity is busy. Try again shortly; nothing new was submitted.',
    'Provider capacity was unavailable before this trade expired. Nothing new was submitted.',
    'TimeoutError: The operation was aborted due to timeout',
  ];
  const failures=messages.flatMap(message=>[Error(message),Error(`failed to get info about account ${mint.toBase58()}: Error: ${message}`),Error(`failed to get balance of account ${mint.toBase58()}: ${message}`)]);
  failures.push(Object.assign(Error('Connection retired'),{code:'RPC_SCHEDULER_CLOSED'}));
  for(const failure of failures){
    const f=fixture([page([row()],'next'),failure]);await assert.rejects(f.read(),retry);assert.equal(f.calls.length,2);
    let reads=0;const chain={c:{rpcEndpoint:'https://rpc.example.test/',getProgramAccounts:async()=>{reads++;throw failure;}}};
    await assert.rejects(readMintTokenAccounts(chain,TOKEN_2022_PROGRAM_ID,mint),retry);assert.equal(reads,1);
  }
});

test('scanner transport retry cannot override invalid snapshots, authorization, or mismatched accounting',async()=>{
  for(const failure of [
    Error('Unknown failure: RPC scheduler closed.'),
    Error('Request worker closed. Unknown failure.'),
    Error('failed to get unrelated data: Error: RPC scheduler closed.'),
    Object.assign(Error('Invalid holder account; RPC scheduler closed.'),{code:'RPC_SCHEDULER_CLOSED',retryable:true}),
    Object.assign(Error('Payout receipt mismatch; RPC capacity is busy. Try again shortly; nothing new was submitted.'),{code:'RPC_SCHEDULER_CLOSED'}),
    Object.assign(Error('Unauthorized; Request scheduler closed.'),{code:'RPC_SCHEDULER_CLOSED'}),
    Object.assign(Error('RPC scheduler closed.'),{code:-32601}),
    Object.assign(Error('RPC scheduler closed.'),{code:'REWARD_ACCOUNT_SCAN_RPC'}),
  ]){
    const f=fixture([page([row()],'next'),failure]);await assert.rejects(f.read(),{code:'REWARD_ACCOUNT_SCAN_RPC'});assert.equal(f.calls.length,2);
  }
  const invalidError=Object.assign(Error('RPC scheduler closed. HTTP 503'),{code:'REWARD_ACCOUNT_SCAN_INVALID',retryable:true});
  await assert.rejects(fixture([page([row()],'next'),invalidError]).read(),invalid);
  const incomplete=page([row()],'next');delete incomplete.result.value.accounts;incomplete.result.value.message='RPC scheduler closed.';
  await assert.rejects(fixture([incomplete]).read(),invalid);
});
