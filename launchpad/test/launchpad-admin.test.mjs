import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Keypair, PublicKey } from '@solana/web3.js';
import { Launchpad } from '../src/launchpad.mjs';
import { LaunchpadAdmin, launchAdminRow } from '../src/launchpad-admin.mjs';
import { newLaunchKeys } from '../src/launchpad-receipts.mjs';

const adminId = 'a'.repeat(32), userId = 'b'.repeat(32), otherId = 'c'.repeat(32);
const address = () => Keypair.generate().publicKey.toBase58();
const fixture = (index = 1, mode = 'creator') => ({
  id: index.toString(16).padStart(32, '0'), createdAt: index, feeCustody: 'relay', curve: address(),
  keys: { ...newLaunchKeys(), payer: newLaunchKeys().wallet },
  input: { route: 'raydium', network: 'mainnet-beta', name: `Coin ${index}`, symbol: `COIN${index}`, quoteMint: address(), feeMode: mode, taxBps: 0, recipient: mode === 'creator' ? address() : '' },
  state: 'live', operations: [{ state: 'confirmed', signature: 'launch-signature', kind: 'create' }],
  credits: { quote: '0', base: '0' }, gas: { reserved: '9000' }, autoFees: true, feesRequested: false,
});

async function harness(t, launches = [fixture()]) {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-launch-admin-')), books = new Map([[userId, { launches }], [otherId, { launches: [] }], [adminId, { launches: [] }]]);
  const users = new Map([
    [adminId, { id: adminId, username: 'owner', role: 'admin', mfaEnabled: true, mainWallet: address() }],
    [userId, { id: userId, username: 'creator', role: 'user', mfaEnabled: true, mainWallet: address() }],
    [otherId, { id: otherId, username: 'another', role: 'user', mfaEnabled: false, mainWallet: address() }],
  ]);
  let reads = 0;
  const accounts = {
    dir, get: async id => structuredClone(users.get(id)), list: async () => structuredClone([...users.values()]),
    storeFor: id => ({ dir: join(dir, id), read: async () => { reads++; return structuredClone(books.get(id) || { launches: [] }); }, write: async (key, book) => books.set(id, structuredClone(book)) }),
  };
  const launchpad = new Launchpad(accounts, null), service = new LaunchpadAdmin({ accounts, launchpad, now: () => 12345 });
  t.after(async () => { await launchpad.close(); await rm(dir, { recursive: true, force: true }); });
  return { service, launchpad, books, users, accounts, get reads() { return reads; } };
}
const request = (launch, extra = {}) => ({ accountId: userId, id: launch.id, recipient: address(), expectedRecipient: launch.input.recipient, expectedMode: launch.input.feeMode, reason: 'Verified community takeover.', ...extra });

test('admin fee inventory denies ordinary and non-MFA users before reading launch records', async t => {
  const h = await harness(t);
  for (const id of [userId, otherId]) { await assert.rejects(h.service.list(id), error => error.statusCode === 403); await assert.rejects(h.service.update(id, {}), error => error.statusCode === 403); }
  assert.equal(h.reads, 0);
  h.users.get(adminId).mfaEnabled = false; await assert.rejects(h.service.list(adminId), /two-factor/); assert.equal(h.reads, 0);
});

test('admin inventory paginates and searches all accounts without disclosing stored secrets', async t => {
  const launches = [fixture(1), fixture(2), fixture(3)], h = await harness(t, launches);
  h.books.get(otherId).launches.push(fixture(4));
  const page = await h.service.list(adminId, { limit: 2 }); assert.equal(page.total, 4); assert.equal(page.nextOffset, 2); assert.deepEqual(page.launches.map(l => l.name), ['Coin 4', 'Coin 3']);
  const last = await h.service.list(adminId, { limit: 2, offset: 2 }); assert.equal(last.nextOffset, null); assert.equal(last.launches.length, 2);
  assert.equal((await h.service.list(adminId, { search: 'another' })).launches[0].accountId, otherId);
  assert.equal((await h.service.list(adminId, { search: launches[0].keys.mint.address })).launches[0].id, launches[0].id);
  assert(!JSON.stringify(page).includes(launches[2].keys.wallet.secret)); assert(!JSON.stringify(page).includes('secret'));
  for (const query of [{ offset: -1 }, { offset: 0.5 }, { limit: 51 }, { search: 'a'.repeat(129) }]) await assert.rejects(h.service.list(adminId, query));
});

test('admin pending step shows the worker-selected transaction without serializing signed payloads or operation secrets', async t => {
  const launch = fixture(1, 'buyback'), signature = '3'.repeat(88), h = await harness(t, [launch]);
  launch.cycle = { stage: 'distribute' };
  launch.operations.push({ kind: 'buy', state: 'pending', signature, createdAt: 12345, receiptNote: 'Checking transaction history.', raw: 'private-signed-bytes', unsignedRaw: 'private-unsigned-bytes', secret: 'private-operation-key', operationData: { secret: 'nested-secret' } });
  launch.operations.push({ kind: 'burn', state: 'pending', signature: '4'.repeat(88), createdAt: 23456 });
  const row = (await h.service.list(adminId)).launches[0];
  assert.equal(row.network, 'mainnet-beta');
  assert.equal(row.serviceStage, 'distribute');
  assert.deepEqual(row.pendingOperation, { kind: 'buy', state: 'pending', signature, createdAt: 12345, reason: 'Checking transaction history.' });
  const serialized = JSON.stringify(row);
  for (const secret of ['private-signed-bytes', 'private-unsigned-bytes', 'private-operation-key', 'nested-secret', launch.keys.wallet.secret]) assert(!serialized.includes(secret));
  assert(!Object.hasOwn(row, 'operations'));
  launch.operations.push({ kind: 'claim', state: 'awaiting_signature', unsignedRaw: 'private-wallet-request', externalSigner: address(), createdAt: 34567 });
  const waiting = (await h.service.list(adminId)).launches[0];
  assert.deepEqual(waiting.pendingOperation, { kind: 'claim', state: 'awaiting_signature', signature: '', createdAt: 34567, reason: '' });
  assert(!JSON.stringify(waiting).includes('private-wallet-request'));
});

test('admin pending projection handles absent, settled and malformed data without inventing a transaction link', () => {
  const launch = fixture(), account = { id: userId, username: 'creator' };
  assert.equal(launchAdminRow(account, launch).pendingOperation, null);
  launch.operations.push({ kind: '<img src=x onerror=alert(1)>', state: 'pending', signature: 'javascript:alert(1)', createdAt: { secret: 'private-time' }, receiptNote: { secret: 'private-note' }, raw: 'private-bytes' });
  const row = launchAdminRow(account, launch);
  assert.deepEqual(row.pendingOperation, { kind: '<img src=x onerror=alert(1)>', state: 'pending', signature: '', createdAt: null, reason: '' });
  launch.input.network = 'devnet';
  assert.equal(launchAdminRow(account, launch).network, '');
  launch.operations = [];
  assert.equal(launchAdminRow(account, launch).pendingOperation, null);
});

test('admin reward retries expose only the validated schedule and sanitized reason', () => {
  const launch=fixture(1,'buyback'),account={id:userId,username:'creator'};
  launch.rewardRetry={at:123456,attempt:2,kind:'buy',reason:'RPC timed out at https://private-provider.example/key',raw:'private-signed-bytes',secret:'private-operation-key'};
  const row=launchAdminRow(account,launch);
  assert.deepEqual(row.rewardRetry,{at:123456,attempt:2,kind:'buy',reason:'RPC timed out at [provider]'});
  assert(!JSON.stringify(row).includes('private-provider'));assert(!JSON.stringify(row).includes('private-signed-bytes'));
  launch.rewardRetry.at='invalid';assert.equal(launchAdminRow(account,launch).rewardRetry,null);
});

test('admin reserved reward summary exposes amounts and counts without exposing recipient debt records',()=>{
  const launch=fixture(1,'holders'),account={id:userId,username:'creator'},recipient=address();
  launch.input.quoteMint='So11111111111111111111111111111111111111112';launch.review={quoteDecimals:9};launch.credits.quote='1000000';
  launch.nativeRewardDebts={version:1,payouts:[{owner:recipient,amount:'100000'}]};
  let row=launchAdminRow(account,launch);
  assert.deepEqual(row.deferredRewards,{wallets:1,amount:'0.0001'});
  assert(!JSON.stringify(row).includes(recipient));assert(!JSON.stringify(row).includes('nativeRewardDebts'));
  launch.nativeRewardDebts.payouts[0].amount='1000001';row=launchAdminRow(account,launch);
  assert.deepEqual(row.deferredRewards,{unavailable:true});
});

test('recipient updates preserve authority, daily gas accounting and settled operations while recording actor and reason', async t => {
  const launch = fixture(), h = await harness(t, [launch]), body = request(launch), before = structuredClone(launch);
  const result = await h.service.update(adminId, body), saved = h.books.get(userId).launches[0];
  assert.equal(result.launch.recipient, body.recipient); assert.equal(saved.input.recipient, body.recipient);
  assert.deepEqual(saved.keys, before.keys); assert.deepEqual(saved.operations, before.operations); assert.deepEqual(saved.credits, before.credits); assert.deepEqual(saved.gas, before.gas); assert.equal(saved.autoFees, before.autoFees);
  assert.deepEqual(saved.feeRecipientHistory, [{ at: 12345, actorId: adminId, actor: 'owner', from: before.input.recipient, to: body.recipient, fromMode: 'creator', toMode: 'creator', reason: body.reason }]);
  assert(!JSON.stringify(result).includes(saved.keys.wallet.secret)); assert.equal(result.launch.history[0].to, body.recipient);
});

test('managed holder and buyback takeovers record former policy without altering token tax settings', async t => {
  for (const mode of ['holders', 'buyback']) {
    const launch = fixture(mode === 'holders' ? 1 : 2, mode), h = await harness(t, [launch]), body = request(launch);
    await h.service.update(adminId, body); const saved = h.books.get(userId).launches[0];
    assert.equal(saved.input.feeMode, 'creator'); assert.equal(saved.input.taxBps, 0); assert.equal(saved.input.recipient, body.recipient); assert.equal(saved.feeRecipientHistory[0].fromMode, mode);
  }
});

test('locked compare-and-set prevents two takeover requests from overwriting each other', async t => {
  const launch = fixture(), h = await harness(t, [launch]), bodies = [request(launch), request(launch)];
  const results = await Promise.allSettled(bodies.map(body => h.service.update(adminId, body)));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1); assert.equal(results.find(x => x.status === 'rejected').reason.statusCode, 409);
  assert.equal(h.books.get(userId).launches[0].feeRecipientHistory.length, 1);
});

test('unsafe legacy custody, pending work and unspent fee credits block takeover without data mutation', async t => {
  const changes = [
    l => { delete l.feeCustody; }, l => { l.keys.wallet.external = true; }, l => { l.keys.payer = l.keys.wallet; },
    l => { l.feeWalletExportedAt = 1; }, l => { l.walletExportedAt = 1; }, l => { l.keys.wallet.exportedAt = 1; },
    l => { l.input.taxBps = 300; l.input.feeMode = 'holders'; }, l => { l.state = 'draft'; }, l => { delete l.curve; },
    l => { l.operations.push({ state: 'pending' }); }, l => { l.operations.push({ state: 'awaiting_signature' }); },
    l => { l.cycle = { stage: 'claim' }; }, l => { l.feesRequested = true; }, l => { l.credits.quote = '1'; },
    l => { l.credits.base = '1'; }, l => { l.credits.quote = 'invalid'; }, l => { l.keys.wallet.secret = 'invalid'; },
  ];
  for (const change of changes) {
    const launch = fixture(); change(launch); const h = await harness(t, [launch]), before = structuredClone(h.books.get(userId));
    await assert.rejects(h.service.update(adminId, request(launch)), error => error.statusCode === 409); assert.deepEqual(h.books.get(userId), before);
  }
});

test('a fee authority shared across accounts or matching any personal main wallet is blocked', async t => {
  const launch = fixture(), h = await harness(t, [launch]);
  const other = fixture(2); other.keys.wallet = launch.keys.wallet; h.books.get(otherId).launches.push(other);
  const page = await h.service.list(adminId, { eligibleOnly: true }); assert.equal(page.total, 0);
  await assert.rejects(h.service.update(adminId, request(launch)), /shared or personal/);
  h.books.get(otherId).launches = []; h.users.get(otherId).mainWallet = launch.keys.wallet.address;
  await assert.rejects(h.service.update(adminId, request(launch)), /shared or personal/);
});

test('invalid recipients, stale policies and missing reasons cannot commit a takeover', async t => {
  const launch = fixture(), h = await harness(t, [launch]);
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('test')], Keypair.generate().publicKey);
  for (const extra of [ { recipient: 'not an address' }, { recipient: pda.toBase58() }, { recipient: launch.keys.wallet.address }, { reason: 'no' }, { reason: 'x'.repeat(501) }, { expectedRecipient: undefined }, { expectedRecipient: address() }, { expectedMode: 'holders' }, { recipient: launch.input.recipient } ]) await assert.rejects(h.service.update(adminId, request(launch, extra)));
  assert.deepEqual(h.books.get(userId).launches[0], launch);
});

test('role revocation during inventory prevents both private list output and update commit', async t => {
  const launch = fixture(), h = await harness(t, [launch]), originalList = h.accounts.list;
  h.accounts.list = async () => { const values = await originalList(); h.users.get(adminId).role = 'user'; return values; };
  await assert.rejects(h.service.list(adminId), /Administrator/);
  h.users.get(adminId).role = 'admin'; await assert.rejects(h.service.update(adminId, request(launch)), /Administrator/);
  assert.deepEqual(h.books.get(userId).launches[0], launch);
});

test('only an administrator can hide and restore launches with durable reasons',async t=>{
 const l=fixture(),h=await harness(t,[l]),body={accountId:userId,id:l.id,hidden:true,reason:'Prohibited explicit content'};
 await assert.rejects(h.service.visibility(userId,body),/Administrator/);
 await h.service.visibility(adminId,body);let saved=(await h.launchpad.book(userId)).launches[0];assert.equal(saved.moderation.hidden,true);assert.equal(saved.moderationHistory.length,1);
 await h.service.visibility(adminId,{...body,hidden:false,reason:'Review completed'});saved=(await h.launchpad.book(userId)).launches[0];assert.equal(saved.moderation.hidden,false);assert.equal(saved.moderationHistory.length,2);
});

test('admin active and archived views filter before pagination and count hidden, manual and legacy records',async t=>{
  const launches=Array.from({length:6},(_,index)=>fixture(index+1));
  launches[0].moderation={hidden:true,at:11};launches[1].listArchive={archived:true,at:12};launches[2].input.network='devnet';
  const h=await harness(t,launches),active=await h.service.list(adminId,{limit:2});
  assert.equal(active.view,'active');assert.equal(active.total,3);assert.deepEqual(active.counts,{active:3,archived:3});assert.deepEqual(active.launches.map(l=>l.name),['Coin 6','Coin 5']);assert.equal(active.nextOffset,2);
  const archived=await h.service.list(adminId,{view:'archived',limit:2});assert.equal(archived.total,3);assert.deepEqual(archived.launches.map(l=>l.name),['Coin 3','Coin 2']);assert(archived.launches.every(l=>l.listArchived));
  assert.deepEqual((await h.service.list(adminId,{view:'archived',offset:2,limit:2})).launches.map(l=>l.name),['Coin 1']);
  assert.equal((await h.service.list(adminId,{view:'all'})).launches.length,6);
  assert.deepEqual((await h.service.list(adminId,{view:'archived',search:'COIN1'})).counts,{active:0,archived:1});
  await assert.rejects(h.service.list(adminId,{view:'invalid'}),/view/);
});

test('hidden records remain in financial custody inventory even when excluded from active results',async t=>{
  const launch=fixture(),duplicate=fixture(2);duplicate.keys.wallet=launch.keys.wallet;duplicate.moderation={hidden:true};
  const h=await harness(t,[launch,duplicate]),active=await h.service.list(adminId);
  assert.equal(active.launches.length,1);assert.equal(active.launches[0].eligibility.allowed,false);assert.match(active.launches[0].eligibility.reason,/shared/);
  assert.equal((await h.service.inventory()).launches.length,2);
  assert.equal((await h.service.list(adminId,{eligibleOnly:true})).total,0);
});

test('admin archive writes metadata only and the same state is visible to both owner and admin',async t=>{
  const launch=fixture();delete launch.curve;launch.state='failed';launch.operations=[{kind:'platform-setup',state:'confirmed',signature:'saved'}];launch.recovery={status:'checking',nextAt:12346};
  const h=await harness(t,[launch]),before=structuredClone(launch),body={accountId:userId,id:launch.id,archived:true};
  let kicks=0;h.launchpad.kick=()=>{kicks++;};
  const result=await h.service.archive(adminId,body),saved=h.books.get(userId).launches[0];
  assert.equal(result.launch.listArchived,true);assert.equal(result.launch.canRestore,true);assert.equal(kicks,0);
  const metadata={...saved};delete metadata.listArchive;delete metadata.listArchiveHistory;assert.deepEqual(metadata,before);
  assert.deepEqual(saved.listArchive,{archived:true,actorId:adminId,at:12345});assert.equal((await h.service.list(adminId)).total,0);
  assert.equal((await h.service.list(adminId,{view:'archived'})).launches[0].id,launch.id);
  await h.service.archive(adminId,body);assert.equal(h.books.get(userId).launches[0].listArchiveHistory.length,1);
  await h.service.archive(adminId,{...body,archived:false});await h.service.archive(adminId,{...body,archived:false});assert.equal(h.books.get(userId).launches[0].listArchiveHistory.length,2);assert.equal((await h.service.list(adminId)).total,1);
  assert(!JSON.stringify(result).includes(launch.keys.wallet.secret));
});

test('admin archive rejects active launches, pending creation receipts and confirmed creation without changing data',async t=>{
  for(const change of [l=>{},l=>{delete l.curve;l.state='failed';},l=>{delete l.curve;l.operations=[];l.state='launching';},l=>{delete l.curve;l.state='failed';l.operations=[{kind:'create',state:'pending'}];}]){
    const launch=fixture();change(launch);const h=await harness(t,[launch]);
    await assert.rejects(h.service.archive(adminId,{accountId:userId,id:launch.id,archived:true}),error=>error.statusCode===409);assert.deepEqual(h.books.get(userId).launches[0],launch);
  }
});

test('archive mutation requires current unbanned admin with MFA before reads and immediately before commit',async t=>{
  const launch=fixture();delete launch.curve;launch.state='failed';launch.operations=[];const h=await harness(t,[launch]),body={accountId:userId,id:launch.id,archived:true};
  await assert.rejects(h.service.archive(userId,body),error=>error.statusCode===403);assert.equal(h.reads,0);
  h.users.get(adminId).banned=true;await assert.rejects(h.service.archive(adminId,body),error=>error.statusCode===403);assert.equal(h.reads,0);h.users.get(adminId).banned=false;
  h.users.get(adminId).mfaEnabled=false;await assert.rejects(h.service.archive(adminId,body),error=>error.statusCode===403);assert.equal(h.reads,0);h.users.get(adminId).mfaEnabled=true;
  const list=h.accounts.list;h.accounts.list=async()=>{const result=await list();h.users.get(adminId).role='user';return result;};
  await assert.rejects(h.service.archive(adminId,body),error=>error.statusCode===403);assert.deepEqual(h.books.get(userId).launches[0],launch);
});

test('hidden coins must use moderation restore before clearing a manual archive',async t=>{
  const launch=fixture();delete launch.curve;launch.state='failed';launch.operations=[];launch.listArchive={archived:true,actorId:userId,at:12};launch.moderation={hidden:true,at:13};
  const h=await harness(t,[launch]),body={accountId:userId,id:launch.id,archived:false};
  await assert.rejects(h.service.archive(adminId,body),error=>error.statusCode===409);
  await h.service.visibility(adminId,{accountId:userId,id:launch.id,hidden:false,reason:'Review complete'});assert.equal((await h.service.list(adminId)).total,0);
  await h.service.archive(adminId,body);assert.equal((await h.service.list(adminId)).total,1);assert.equal(h.books.get(userId).launches[0].moderation.hidden,false);
});


test('admin manual conversion projection combines remaining sources and exposes only safe progress fields',()=>{
  const launch=fixture(),account={id:userId,username:'creator'};launch.review={quoteDecimals:9};
  launch.manualHolderDistribution={version:1,requestId:'c'.repeat(32),state:'partial',phase:'payout',remainingBaseUnits:'500000',remainingTaxBaseUnits:'1250000',remainingQuoteUnits:'250000',distributedQuoteUnits:'1000000000',reason:'Reserved dust.',raw:'private-signed-bytes',actorSecret:'private-key'};
  const row=launchAdminRow(account,launch);
  assert.deepEqual(row.manualHolderDistribution,{requestId:'c'.repeat(32),state:'partial',phase:'payout',reason:'Reserved dust.',remainingBase:'1.75',remainingQuote:'0.00025',distributedQuote:'1'});
  assert(!JSON.stringify(row).includes('private-signed-bytes'));assert(!JSON.stringify(row).includes('private-key'));
  launch.manualHolderDistribution.remainingTaxBaseUnits='broken';assert.equal(launchAdminRow(account,launch).manualHolderDistribution.remainingBase,null);
});

test('live Pump.fun coins join the moderation inventory through their own provider, searchable and in the archived view when hidden', async t => {
  const h = await harness(t), mint = address(), hidden = { value: false };
  h.service.pumpClassic = { async adminInventory(actorId) {
    assert.equal(actorId, adminId);
    const adminRow = { route: 'pump-classic', platform: 'pump-classic', accountId: userId, username: 'creator', id: 'ab'.repeat(12), mint, name: 'Liquidity Manager', symbol: 'LIQUID', createdAt: 99999, state: 'created', hidden: hidden.value, manuallyArchived: false, listArchived: hidden.value, canArchive: false, canRestore: false, eligibility: { allowed: false, reason: 'Pump.fun' } };
    return [{ account: { id: userId, username: 'creator' }, adminRow, launch: { id: adminRow.id, createdAt: 99999, state: 'created', input: { route: 'pump-classic', name: adminRow.name, symbol: adminRow.symbol, recipient: address(), feeMode: 'lp_manager' }, keys: { mint: { address: mint } }, moderation: { hidden: hidden.value }, listArchive: { archived: false } } }];
  } };
  const page = await h.service.list(adminId);
  assert.deepEqual(page.launches.map(l => [l.route || 'raydium', l.symbol || l.name]), [['pump-classic', 'LIQUID'], ['raydium', 'COIN1']], 'newest first, alongside the other venues');
  assert.equal((await h.service.list(adminId, { search: mint.slice(0, 10) })).launches[0].mint, mint, 'found by its address');
  assert.equal((await h.service.list(adminId, { eligibleOnly: true })).launches.some(l => l.route === 'pump-classic'), false, 'never offered for Raydium fee takeovers');
  hidden.value = true;
  assert.equal((await h.service.list(adminId)).launches.some(l => l.route === 'pump-classic'), false);
  assert.equal((await h.service.list(adminId, { view: 'archived' })).launches[0].route, 'pump-classic', 'a hidden Pump.fun coin is listed under Archived tokens');
});
