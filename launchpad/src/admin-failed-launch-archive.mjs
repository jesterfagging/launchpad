import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireProcessLock } from './process-lock.mjs';
import { launchArchiveView, setLaunchArchive } from './launchpad-archive.mjs';
import { pumpArchiveView, setPumpArchive } from './pump-public-moderation.mjs';

const STORE = 'admin-failed-launch-archive';
const ID = /^[a-f0-9]{32}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const FAILED = new Set(['failed', 'error']);
const TERMINAL = new Set(['confirmed', 'failed', 'expired', 'cancelled']);
const CREATED = new Set(['create', 'launch-all', 'initialize']);
const NATIVE_TERMINAL = new Set(['finalized', 'failed', 'expired', 'cancelled']);
const DAMM_LAUNCH_ACTIONS = new Set(['configure', 'fund-quote', 'prepare-buy', 'initialize']);
const failedDammDraft = (launch, operations) => launch?.status === 'draft' && Array.isArray(operations) && operations.some(op => op?.mint === launch.mint && DAMM_LAUNCH_ACTIONS.has(op.action) && ['failed', 'expired', 'cancelled'].includes(op.state));
const REASONS = {
  unsupported: 'This launch provider needs individual archive review.',
  identity: 'The saved request identity needs review.',
  not_failed: 'The request is no longer failed.',
  archived: 'The request is already archived or hidden.',
  created: 'A token was already created or confirmed onchain.',
  pending: 'A saved transaction or wallet approval still needs reconciliation.',
  recovery: 'Setup recovery has not completed.',
  funds: 'Funds or reward obligations remain reserved for this request.',
  invalid: 'The saved request accounting needs individual review.',
  guard: 'The existing archive guard requires individual review.',
  missing: 'The saved request or its account is no longer available.',
  save_failed: 'The archive result could not be saved; retry this same request.',
};
const fail = (message, statusCode = 409) => { throw Object.assign(Error(message), { statusCode }); };
const zero = value => value === undefined || value === null || typeof value === 'string' && /^0+$/.test(value) || value === 0;
const nonzero = values => values.some(value => !zero(value));
const list = value => value === undefined || value === null ? [] : Array.isArray(value) ? value : null;
const reasonRows = counts => Object.entries(counts).filter(([, count]) => count > 0).map(([code, count]) => ({ code, count, message: REASONS[code] || REASONS.invalid }));

// This intentionally tightens individual archive policy: bulk cleanup must not
// hide a recovery, signed transaction, live mint, or unsettled reward balance.
// Provider inventory projections are not authoritative accounting records.
export function failedLaunchArchiveEligibility(launch, route = launch?.input?.route || 'raydium') {
  if (!launch || !FAILED.has(launch.state)) return { eligible: false, code: 'not_failed' };
  if (route !== 'raydium') return { eligible: false, code: 'unsupported' };
  if (!Array.isArray(launch.operations) || !launch.credits || !launch.gas) return { eligible: false, code: 'invalid' };
  const ops = launch.operations;
  if (launch.curve || launch.poolId || launch.dbcPoolId || launch.mintLive === true || launch.finalizedAt || launch.confirmedAt || ops.some(op => CREATED.has(op.kind || op.action) && ['confirmed', 'finalized'].includes(op.state))) return { eligible: false, code: 'created' };
  if (ops.some(op => !op || !TERMINAL.has(op.state) || op.raw || op.signedTransaction || op.needsSignature) || launch.pendingSignature) return { eligible: false, code: 'pending' };
  if (launch.recovery && launch.recovery.status !== 'complete' || !launch.recovery && (launch.authorizedAt || ops.some(op => op.state === 'confirmed'))) return { eligible: false, code: 'recovery' };
  const obligations = [launch.nativeRewardDebts?.payouts, launch.rewards?.debts, launch.reservedPayouts];
  if (obligations.some(rows => list(rows) === null)) return { eligible: false, code: 'invalid' };
  if (launch.cycle || launch.rewards?.cycle || launch.autoFees || launch.feesRequested || launch.protocolFeesRequested || launch.taxBurn?.initialInventory?.status === 'authorized' || ['queued', 'processing'].includes(launch.heldSolDistribution?.state || launch.heldSolDistribution?.status) || obligations.some(rows => list(rows).length) || nonzero([
    ...Object.values(launch.credits), launch.gas.reserved,
    launch.recovery?.unreturnedLamports, launch.recovery?.reservedLamports,
    launch.recovery?.remainingLamports, launch.recovery?.balanceLamports,
    launch.reservedLamports, launch.recoveryFunds, launch.refundPendingLamports,
    launch.taxProtocol?.creditQuote, launch.taxProtocol?.sourceBaseCredit,
    launch.protocolCredit, launch.protocolBaseCredit,
  ])) return { eligible: false, code: 'funds' };
  const existing = launchArchiveView(launch);
  if (existing.listArchived) return { eligible: false, code: 'archived' };
  if (!existing.canArchive) return { eligible: false, code: 'guard' };
  return { eligible: true, code: '' };
}

export function nativeFailedLaunchArchiveEligibility(launch, operations, route) {
  if (!launch || !FAILED.has(launch.status) && !(route === 'damm-pump' && failedDammDraft(launch, operations))) return { eligible: false, code: 'not_failed' };
  if (!['meteora', 'pumpswap', 'damm-pump'].includes(route)) return { eligible: false, code: 'unsupported' };
  if (!Array.isArray(operations) || route === 'meteora' && (!launch.ledger || typeof launch.ledger !== 'object')) return { eligible: false, code: 'invalid' };
  const ops = operations.filter(op => op?.mint === launch.mint);
  if (launch.poolId || launch.dbcPoolId || launch.mintLive || launch.finalizedAt || launch.confirmedAt || launch.migrationSignature || launch.burnReceipt || ['confirmed', 'finalized'].includes(launch.confirmationStatus) || ops.some(op => op.action === 'initialize' && ['confirmed', 'finalized'].includes(op.state))) return { eligible: false, code: 'created' };
  if (ops.some(op => !NATIVE_TERMINAL.has(op.state) || op.needsSignature || (op.signedTransaction || op.raw || op.signature) && (op.state === 'cancelled' || op.result?.state !== op.state))) return { eligible: false, code: 'pending' };
  if (route === 'damm-pump') {
    // Damm keeps failed setup attempts as drafts. Prepared PDA/pool addresses,
    // lookup tables and estimated setup costs are not evidence of a live pool.
    // Successful or ambiguous setup/funding must remain individually reviewable.
    if (ops.some(op => op.walletSignedTransaction && (op.state === 'cancelled' || op.result?.state !== op.state) || op.observedSignatureStatus && op.state !== 'failed')) return { eligible: false, code: 'pending' };
    if (['setupSignature', 'fundingSignature', 'fundingReceipt', 'nativeBuySetupSignature'].some(key => launch[key]) ||
        ['setupStatus', 'fundingStatus', 'nativeBuySetupStatus'].some(key => launch[key] && !['failed', 'expired', 'cancelled'].includes(launch[key])) ||
        nonzero([launch.quoteFundingDebitLamports, launch.nativeBuySetupDebitLamports])) return { eligible: false, code: 'funds' };
  }
  if (launch.recovery && launch.recovery.status !== 'complete') return { eligible: false, code: 'recovery' };
  const debts = list(launch.rewards?.debts);
  if (debts === null) return { eligible: false, code: 'invalid' };
  if (launch.configSignature || ops.some(op => op.state === 'finalized') || launch.rewards?.cycle || debts.length || ['queued', 'processing'].includes(launch.heldSolDistribution?.state || launch.heldSolDistribution?.status) || nonzero([
    ...Object.values(launch.ledger || {}), launch.creatorFeesPending, launch.creatorFeesPaid,
    launch.reservedLamports, launch.recoveryFunds, launch.refundPendingLamports,
    launch.recovery?.unreturnedLamports, launch.recovery?.reservedLamports,
    launch.recovery?.remainingLamports, launch.recovery?.balanceLamports,
  ])) return { eligible: false, code: 'funds' };
  const existing = pumpArchiveView(launch, operations);
  if (existing.listArchived) return { eligible: false, code: 'archived' };
  if (!existing.canArchive) return { eligible: false, code: 'guard' };
  return { eligible: true, code: '' };
}

const summary = job => {
  const archivedCount = job.targets.filter(item => item.status === 'archived').length;
  const skippedCount = job.targets.filter(item => item.status === 'skipped').length;
  const remainingCount = job.targets.length - archivedCount - skippedCount;
  const exclusions = { ...job.exclusions };
  for (const item of job.targets) if (item.status === 'skipped') exclusions[item.code] = (exclusions[item.code] || 0) + 1;
  return {
    requestId: job.requestId, status: remainingCount ? 'partial' : 'completed',
    scannedCount: job.scannedCount, failedCount: job.failedCount, eligibleCount: job.targets.length,
    archivedCount, skippedCount, remainingCount,
    excludedCount: job.failedCount - job.targets.length + skippedCount,
    excludedReasons: reasonRows(exclusions),
  };
};

export class AdminFailedLaunchArchive {
  constructor({ accounts, launchpad, launchAdmin, now = Date.now, maxTargets = 10000, maxRequests = 10000 } = {}) {
    Object.assign(this, { accounts, launchpad, launchAdmin, now, maxTargets, maxRequests });
  }
  async write(name, value) {
    await this.accounts.hostStore.write(name, value);
    if (this.accounts.hostStore.dir) {
      const directory = await open(this.accounts.hostStore.dir, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }
  service(route) { return route === 'meteora' ? this.launchAdmin.meteora : route === 'pumpswap' ? this.launchAdmin.pumpPublic : route === 'damm-pump' ? this.launchAdmin.dammPump : null; }
  nativeAvailable(service) { return ['locked', 'load', 'save'].every(method => typeof service?.[method] === 'function'); }
  async discover(actorId) {
    await this.launchAdmin.requireAdmin(actorId);
    const { launches } = await this.launchAdmin.inventory(undefined, actorId);
    if (!Array.isArray(launches)) fail('Launch inventory is unavailable. No requests were archived.');
    const targets = [], exclusions = {}, seen = new Set(), nativeSnapshots = new Map(); let failedCount = 0;
    for (const { account, launch } of launches) {
      const route = launch?.input?.route || 'raydium';
      if (!FAILED.has(launch?.state) && !(route === 'damm-pump' && launch?.state === 'draft')) continue;
      const key = `${route}:${account?.id}:${launch.id}`;
      if (seen.has(key)) continue; seen.add(key); failedCount++;
      let result;
      const mint = launch.keys?.mint?.address;
      if (!ID.test(account?.id || '') || !(route === 'raydium' ? ID : UUID).test(launch.id || '') || route !== 'raydium' && !MINT.test(mint || '')) result = { eligible: false, code: 'identity' };
      else if (route === 'raydium') result = failedLaunchArchiveEligibility(launch, route);
      else {
        const service = this.service(route);
        if (!this.nativeAvailable(service)) result = { eligible: false, code: 'unsupported' };
        else {
          if (!nativeSnapshots.has(route)) nativeSnapshots.set(route, await service.locked(async () => { await this.launchAdmin.requireAdmin(actorId); return service.load(); }));
          const data = nativeSnapshots.get(route);
          const source = data.launches?.find(row => row.id === launch.id && row.creatorId === account.id && row.mint === mint);
          result = source ? nativeFailedLaunchArchiveEligibility(source, data.operations, route) : { eligible: false, code: 'missing' };
        }
      }
      // Ordinary unfinished drafts are not failed requests. Count a Damm draft
      // only after its authoritative journal proves a failed launch attempt.
      if (route === 'damm-pump' && launch.state === 'draft' && result.code === 'not_failed') { failedCount--; continue; }
      if (result.eligible) targets.push({ accountId: account.id, launchId: launch.id, route, ...(route === 'raydium' ? {} : { mint }), status: 'pending' });
      else exclusions[result.code] = (exclusions[result.code] || 0) + 1;
    }
    if (targets.length > this.maxTargets) fail(`There are more than ${this.maxTargets} eligible requests. Nothing was archived; the inventory was not truncated.`);
    await this.launchAdmin.requireAdmin(actorId);
    return { scannedCount: launches.length, failedCount, targets, exclusions };
  }
  async preview(actorId) {
    const found = await this.discover(actorId);
    return { scannedCount: found.scannedCount, failedCount: found.failedCount, eligibleCount: found.targets.length, excludedCount: found.failedCount - found.targets.length, excludedReasons: reasonRows(found.exclusions) };
  }
  async archive(actorId, { requestId } = {}, context = {}) {
    await this.launchAdmin.requireAdmin(actorId);
    if (typeof requestId !== 'string' || !ID.test(requestId)) fail('Choose a valid archive request ID.', 400);
    const release = await acquireProcessLock(join(this.accounts.dir, `${STORE}.lock`));
    try {
      const authorize = async () => { await context.authorize?.(); await this.launchAdmin.requireAdmin(actorId); };
      await authorize();
      let index = await this.accounts.hostStore.read(STORE, { version: 1, requests: {} });
      if (index?.version !== 1 || !index.requests || typeof index.requests !== 'object' || Array.isArray(index.requests)) fail('The saved archive journal needs operator review.');
      let job = await this.accounts.hostStore.read(`${STORE}-${requestId}`, null);
      const alreadyRequested = !!job;
      if (job) {
        if (job.actorId !== actorId) fail('This archive request belongs to another administrator.', 403);
        if (job.version !== 1 || job.requestId !== requestId || !Array.isArray(job.targets) || job.targets.some(item => !ID.test(item.accountId) || !(item.route && item.route !== 'raydium' ? UUID : ID).test(item.launchId) || item.route && !['raydium', 'meteora', 'pumpswap', 'damm-pump'].includes(item.route) || item.route && item.route !== 'raydium' && !MINT.test(item.mint || '') || !['pending', 'archived', 'skipped'].includes(item.status))) fail('The saved archive request needs operator review.');
      } else {
        if (index.requests[requestId]) fail('The saved archive snapshot is unavailable. No new snapshot was created.');
        if (Object.keys(index.requests).length >= this.maxRequests) fail('The archive journal is full. No saved requests were discarded.');
        const found = await this.discover(actorId);
        job = { version: 1, requestId, actorId, createdAt: this.now(), ...found };
        await authorize(); await this.write(`${STORE}-${requestId}`, job);
      }
      if (!index.requests[requestId]) { await authorize(); index.requests[requestId] = actorId; await this.write(STORE, index); }
      for (const item of job.targets) {
        if (item.status !== 'pending') continue;
        await authorize();
        try {
          const apply = async (launch, eligibility, setter, save) => {
            await authorize();
            const account = await this.accounts.get(item.accountId);
            if (!account || !launch) return { status: 'skipped', code: 'missing' };
            // The per-launch audit closes the crash window between its save and
            // the parent result. A restored launch is never re-archived on replay.
            if ((launch.listArchiveHistory || []).some(event => event.bulkRequestId === requestId && event.actorId === actorId && event.archived)) return { status: 'archived' };
            const result = eligibility();
            if (!result.eligible) return { status: 'skipped', code: result.code };
            await authorize();
            setter({ archived: true, actorId, at: this.now() });
            launch.listArchive.bulkRequestId = requestId;
            await save();
            return { status: 'archived' };
          };
          let outcome;
          if (!item.route || item.route === 'raydium') outcome = await this.launchpad.locked(item.accountId, async book => {
            const launch = book.launches?.find(row => row.id === item.launchId);
            return apply(launch, () => failedLaunchArchiveEligibility(launch), options => setLaunchArchive(launch, options), () => this.launchpad.save(item.accountId, book));
          });
          else {
            const service = this.service(item.route);
            if (!this.nativeAvailable(service)) outcome = { status: 'skipped', code: 'unsupported' };
            else outcome = await service.locked(async () => {
              await authorize(); const data = await service.load();
              const launch = data.launches?.find(row => row.id === item.launchId && row.creatorId === item.accountId && row.mint === item.mint);
              return apply(launch, () => nativeFailedLaunchArchiveEligibility(launch, data.operations, item.route), options => setPumpArchive(launch, data.operations, options), () => service.save(data));
            });
          }
          Object.assign(item, outcome); job.updatedAt = this.now();
          await this.write(`${STORE}-${requestId}`, job);
        } catch (error) {
          if ([401, 403].includes(error.statusCode)) throw error;
          // No raw storage/provider exception is exposed. The durable snapshot
          // and per-launch audit allow this exact request to resume safely.
          return { ...summary(job), status: 'partial', alreadyRequested, error: REASONS.save_failed };
        }
      }
      await authorize();
      return { ...summary(job), alreadyRequested };
    } finally { await release(); }
  }
}
