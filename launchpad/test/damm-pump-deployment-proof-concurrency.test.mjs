import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { DAMM_PUMP_DEPLOYMENT_POLICY as legacyPolicy } from '../src/damm-pump-deployment.mjs';
import { DAMM_PUMP_FEE_DEPLOYMENT_POLICY as feePolicy } from '../src/damm-pump-fee-deployment.mjs';
import { DAMM_PUMP_TEST_DEPLOYMENT_POLICY as testPolicy } from '../src/damm-pump-test-deployment.mjs';
import { verifyDammPumpDeployment, DammPumpDeploymentService } from '../src/damm-pump-deployment-service.mjs';
import { verifyDammPumpFeeDeployment, DammPumpFeeDeploymentService } from '../src/damm-pump-fee-deployment-service.mjs';
import { verifyDammPumpTestDeployment, DammPumpTestDeploymentService } from '../src/damm-pump-test-deployment-service.mjs';

const variants = [
  ['legacy', legacyPolicy, verifyDammPumpDeployment, DammPumpDeploymentService, '../private/damm-pump/curve_damm_pump.so'],
  ['fee', feePolicy, verifyDammPumpFeeDeployment, DammPumpFeeDeploymentService, '../private/damm-pump-fee/curve_damm_pump_fee.so'],
  ['admin test', testPolicy, verifyDammPumpTestDeployment, DammPumpTestDeploymentService, '../private/damm-pump-admin-test/curve_damm_pump_admin_test.so'],
];
const relayer = Keypair.fromSeed(new Uint8Array(32).fill(151)).publicKey.toBase58();
const foreignRelayer = Keypair.fromSeed(new Uint8Array(32).fill(152)).publicKey.toBase58();

async function fixture(policy, file) {
  const binary = await readFile(new URL(file, import.meta.url));
  const programId = new PublicKey(policy.programId), loader = new PublicKey(policy.loader);
  const configuration = PublicKey.findProgramAddressSync([Buffer.from('config')], programId)[0];
  const p = Buffer.alloc(36); p.writeUInt32LE(2); new PublicKey(policy.programData).toBuffer().copy(p, 4);
  const d = Buffer.alloc(45 + binary.length); d.writeUInt32LE(3); d.writeBigUInt64LE(100n, 4); d[12] = 1;
  new PublicKey(policy.operator).toBuffer().copy(d, 13); binary.copy(d, 45);
  const g = Buffer.alloc(128); Buffer.from('CRVPCFG1').copy(g); g[8] = 1; g[9] = 1;
  new PublicKey(policy.operator).toBuffer().copy(g, 16); new PublicKey(policy.treasury).toBuffer().copy(g, 48);
  new PublicKey(relayer).toBuffer().copy(g, 80);
  const state = { present: true, failFull: false, snapshotSlot: 200, program: p, data: d, global: g };
  const counts = { genesis: 0, full: 0, rent: 0, snapshot: 0, fullBytes: 0, snapshotBytes: 0 };
  const account = key => key.equals(configuration)
    ? { owner: programId, executable: false, data: state.global, lamports: 1_000_000 }
    : !state.present ? null : key.toBase58() === policy.programId
      ? { owner: loader, executable: true, data: state.program, lamports: 1_000_000 }
      : key.toBase58() === policy.programData
        ? { owner: loader, executable: false, data: state.data, lamports: 1_000_000_000 } : null;
  const connection = {
    async getGenesisHash() { counts.genesis++; return policy.genesisHash; },
    async getMinimumBalanceForRentExemption() { counts.rent++; return 1_000_000; },
    async getMultipleAccountsInfoAndContext(keys, options) {
      const sliced = !!options?.dataSlice;
      if (sliced) {
        counts.snapshot++;
        assert.deepEqual(keys.map(String), [configuration, programId, new PublicKey(policy.programData)].map(String));
        assert.deepEqual(options.dataSlice, { offset: 0, length: 128 });
        assert.equal(options.commitment, 'finalized');
        assert(options.minContextSlot >= 200);
      } else {
        counts.full++;
        if (state.failFull) throw Error('synthetic temporary RPC failure');
      }
      const value = keys.map(key => {
        const a = account(key);
        if (!a) return null;
        const data = Buffer.from(sliced ? a.data.subarray(0, 128) : a.data);
        counts[sliced ? 'snapshotBytes' : 'fullBytes'] += data.length;
        return { ...a, data };
      });
      return { context: { slot: sliced ? state.snapshotSlot : 200 }, value };
    },
    async getAccountInfoAndContext() { throw Error('Configuration must share the fresh loader-header snapshot.'); },
  };
  const config = { schemaVersion: 1, cluster: 'mainnet-beta', programId: policy.programId,
    expectedProgramSha256: policy.binarySha256, expectedDeploymentSlot: '100',
    expectedUpgradeAuthority: policy.operator, treasury: policy.treasury, relayer, enabled: true };
  return { state, counts, connection, config, binary };
}

for (const [label, policy, verify, Service, file] of variants) {
  test(`${label}: 32 cold readers share one ELF while all 32 check fresh configuration and headers`, async t => {
    const f = await fixture(policy, file);
    const first = await Promise.all(Array.from({ length: 32 }, () => verify({ connection: f.connection, config: f.config })));
    assert(first.every(result => result.chainEnabled && result.finalizedObservationSlot === 200));
    assert.equal(f.counts.full, 1);
    assert.equal(f.counts.rent, 3);
    assert.equal(f.counts.genesis, 1);
    assert.equal(f.counts.snapshot, 32);
    assert.equal(f.counts.fullBytes, policy.binaryLength + 81);
    t.diagnostic(`32 cold checks: 37 RPC calls; 1 full ELF read (${f.counts.fullBytes} raw bytes), 32 fresh snapshots. Previous path: 224 RPC calls and 32 full ELF reads.`);

    f.state.global[9] = 0;
    const paused = await Promise.all(Array.from({ length: 32 }, () => verify(f)));
    assert(paused.every(result => !result.chainEnabled));
    assert.equal(f.counts.full, 1);
    assert.equal(f.counts.rent, 3);
    assert.equal(f.counts.genesis, 33);
    assert.equal(f.counts.snapshot, 64);
    t.diagnostic('32 warm checks: 64 RPC calls and no full ELF reads. Previous path: 96 RPC calls. Fresh paused state observed by every caller.');
  });

  test(`${label}: cached executable never bypasses fresh recipient, slot or program checks`, async () => {
    const f = await fixture(policy, file);
    await verify(f);
    new PublicKey(foreignRelayer).toBuffer().copy(f.state.global, 80);
    await assert.rejects(verify(f), /relayer/);
    new PublicKey(relayer).toBuffer().copy(f.state.global, 80);
    f.state.data.writeBigUInt64LE(101n, 4);
    await assert.rejects(verify(f), /changed during/);
    f.state.data.writeBigUInt64LE(100n, 4);
    f.state.program[4] ^= 1;
    await assert.rejects(verify(f), /identity changed/);
    f.state.program[4] ^= 1;
    f.state.snapshotSlot = 199;
    await assert.rejects(verify(f), /predates/);
    assert.equal(f.counts.full, 1);
  });

  test(`${label}: failed or incomplete cold inspections are never retained`, async () => {
    const f = await fixture(policy, file);
    f.state.failFull = true;
    const failed = await Promise.allSettled(Array.from({ length: 16 }, () => verify(f)));
    assert(failed.every(result => result.status === 'rejected'));
    assert.equal(f.counts.full, 1);
    f.state.failFull = false;
    f.state.present = false;
    await assert.rejects(verify(f), /not deployed/);
    assert.equal(f.counts.full, 2);
    f.state.present = true;
    assert.equal((await verify(f)).chainEnabled, true);
    assert.equal(f.counts.full, 3);
  });

  test(`${label}: supplied binary validates before sharing a pending or cached inspection`, async () => {
    const f = await fixture(policy, file), changed = Buffer.from(f.binary);
    changed[100] ^= 1;
    const pending = verify(f);
    await assert.rejects(verify({ ...f, binary: changed }), /reviewed/);
    await pending;
    assert.equal(f.counts.full, 1);
    assert.equal(f.counts.snapshot, 1);
    await assert.rejects(verify({ ...f, binary: changed }), /reviewed/);
    assert.equal(f.counts.full, 1);
    assert.equal(f.counts.snapshot, 1);
  });

  test(`${label}: the same connection cannot reuse another controller executable proof`, async () => {
    const f = await fixture(policy, file);
    await verify(f);
    const [, otherPolicy, otherVerify] = variants.find(row => row[0] !== label);
    const config = { ...f.config, programId: otherPolicy.programId,
      expectedProgramSha256: otherPolicy.binarySha256, expectedUpgradeAuthority: otherPolicy.operator,
      treasury: otherPolicy.treasury };
    await assert.rejects(otherVerify({ connection: f.connection, config }), /not deployed/);
    assert.equal(f.counts.full, 2);
    assert.equal((await verify(f)).chainEnabled, true);
    assert.equal(f.counts.full, 2);
  });

  test(`${label}: a regressed snapshot retries at the newest slot without using stale enablement`, async () => {
    const f = await fixture(policy, file);
    f.state.snapshotSlot = 220;
    await verify(f);
    const request = f.connection.getMultipleAccountsInfoAndContext;
    let snapshots = 0;
    f.connection.getMultipleAccountsInfoAndContext = async (keys, options) => {
      if (options?.dataSlice) {
        snapshots++;
        assert.equal(options.minContextSlot, 220);
        f.state.snapshotSlot = snapshots === 1 ? 219 : 221;
        f.state.global[9] = snapshots === 1 ? 1 : 0;
      }
      return request(keys, options);
    };
    const result = await verify(f);
    assert.equal(snapshots, 2);
    assert.equal(result.chainEnabled, false);
    assert.equal(result.finalizedObservationSlot, 221);
    assert.equal(f.counts.full, 1);
  });

  test(`${label}: configuration journals reuse the loader connection without sharing authorization`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'launchpad-deployment-connection-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    let authorized = 0;
    const service = new Service({ accounts: { dir }, rpcUrl: 'https://rpc.invalid',
      requireOwner: async () => { authorized++; }, ensureRelayer: async () => ({ address: relayer }),
      installDeployment: async () => {} });
    const session = { account: { id: 'admin' } };
    const context = { sessionToken: 'current-owner-session-for-test', authorize: async () => { authorized++; } };
    const a = await service.configService(session, context);
    const b = await service.configService(session, context);
    assert.equal(a.service.connection, service.loader.connection);
    assert.equal(b.service.connection, service.loader.connection);
    assert.notEqual(a.service, b.service);
    assert.equal(authorized, 4);
  });
}
