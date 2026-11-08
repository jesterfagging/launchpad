import { randomBytes } from 'node:crypto';
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { signer } from './launchpad-receipts.mjs';
import { requireValue as ok, isCurrentLaunch } from '../public/launchpad-model.mjs';

// A signing prompt can outlive a browser tab. Never reclaim its setup funds
// while its blockhash remains valid, even when Launchpad never received a signature.
export const ABANDONED_LAUNCH_MS = 15 * 60 * 1000;
const CHECK_DELAY = 10000;
const RETRY_DELAY = 60000;
const INITIAL = new Set(['storage-credit','storage-fund','platform','platform-setup','quote-fund','create','setup','launch-all']);
const CREATED = new Set(['create','launch-all']);
const terminal = l => !!l.curve || l.recovery?.status === 'complete';
const lastActivity = l => Math.max(l.lastLaunchActivityAt || 0, l.authorizedAt || l.createdAt || 0, ...(l.operations || []).map(o => o.signedAt || o.createdAt || 0));
const pk = value => new PublicKey(value);
const notice = 'Only unused setup SOL can be returned. Network fees, image storage and nonrecoverable account costs have already been spent. Pairing tokens already purchased remain in the original paying wallet.';
const scrub = e => String(e?.message || e).replace(/(?:https?|wss?):\/\/\S+/g, '[provider]').slice(0, 300);

export function recoveryWakeAt(l, now = Date.now()) {
  if (!isCurrentLaunch(l.input) || terminal(l)) return Infinity;
  if (l.recovery) return l.recovery.nextAt || now;
  if (!l.authorizedAt) return Infinity;
  if (['error','failed'].includes(l.state)) return now;
  if (['launching','awaiting_signature','pending','stopping'].includes(l.state)) return lastActivity(l) + ABANDONED_LAUNCH_MS;
  return Infinity;
}
export function recoveryDue(l, now = Date.now()) { return recoveryWakeAt(l, now) <= now; }
export function beginLaunchRecovery(l, now = Date.now()) {
  if (l.recovery) return false;
  const payer = l.keys.payer || l.keys.wallet;
  l.recovery = {version:1,status:'checking',startedAt:now,nextAt:now,refundWallet:payer.address,refundedLamports:'0',reason:'Checking the original launch before returning unused setup SOL.'};
  l.failureReason = l.error || 'The launch was not completed.';
  l.state = 'stopping'; l.autoFees = false; l.feesRequested = false; delete l.retry;
  return true;
}
export function publicRecovery(l) {
  const r = l.recovery;
  return r ? {status:r.status, reason:r.reason || '', refundedLamports:r.refundedLamports || '0', refundWallet:r.refundWallet, notice, signatures:(l.operations || []).filter(o => o.kind === 'setup-refund' && o.state === 'confirmed').map(o => o.signature), completedAt:r.completedAt || null} : null;
}
function accountKeys(tx) {
  const m = tx?.transaction?.message;
  return [...(m?.staticAccountKeys || m?.accountKeys || []).map(k => String(k.pubkey || k)), ...(tx?.meta?.loadedAddresses?.writable || []).map(String), ...(tx?.meta?.loadedAddresses?.readonly || []).map(String)];
}
function nativeDelta(tx, address) {
  const at = accountKeys(tx).indexOf(address);
  if (at < 0) return 0n;
  ok(Number.isSafeInteger(tx?.meta?.preBalances?.[at]) && Number.isSafeInteger(tx?.meta?.postBalances?.[at]), 'The setup receipt omitted a native balance. Recovery will retry.');
  return BigInt(tx.meta.postBalances[at]) - BigInt(tx.meta.preBalances[at]);
}
function checkReceipt(tx, op) {
  ok(tx?.transaction?.signatures?.[0] === op.signature && tx.meta && Number.isSafeInteger(tx.slot), 'The setup receipt could not be verified. Recovery will retry.');
}
async function mark(launch, persist, now, status, reason, extra = {}) {
  Object.assign(launch.recovery, {status, reason, nextAt:status === 'complete' ? null : now + (status === 'blocked' ? RETRY_DELAY : CHECK_DELAY)}, extra);
  if (status === 'complete') launch.recovery.completedAt = now;
  await persist();
}
async function launchSnapshot(chain, launch, minContextSlot) {
  const {pool, m} = chain.addresses(launch);
  const result = await chain.c.getMultipleAccountsInfoAndContext([pool, m], {commitment:'finalized', minContextSlot});
  ok(Number.isSafeInteger(result?.context?.slot) && result.context.slot >= minContextSlot && Array.isArray(result.value) && result.value.length === 2, 'The RPC omitted the finalized launch check. Recovery will retry.');
  return {slot:result.context.slot, exists:result.value.some(Boolean)};
}
async function restoreLive(launch, chain, persist) {
  const result = await chain.verifyLaunch(launch);
  ok(result?.curve, 'The existing onchain launch could not be verified. Recovery is paused.');
  launch.curve = result.curve; launch.state = 'live'; launch.phase = 'verify';
  launch.error = ''; launch.autoFees = false; launch.feesRequested = false;
  launch.recovery.status = 'not-needed'; launch.recovery.reason = 'The original launch succeeded onchain. No setup funds were refunded.';
  launch.recovery.nextAt = null;
  await persist();
}

// Caller holds the account launch lock. This function never advances creation,
// trades pairing tokens, closes token accounts, or accesses the user payer key.
export async function recoverFailedLaunch({launch:l, chain:c, persist, now = Date.now(), closed = () => false}) {
  if (!recoveryDue(l, now)) return false;
  if (beginLaunchRecovery(l,now)) await persist();
  try {
    if (closed()) return true;
    // Reconcile a previously journaled refund before considering any new one.
    const refund = l.operations.find(o => o.kind === 'setup-refund' && o.state === 'pending');
    if (refund) {
      const tx = await c.receipt(refund);
      if (!tx) {
        // A timeout is never permission to sign a replacement refund.
        if (now - (refund.lastBroadcast || refund.createdAt) > 15000 && await c.c.getBlockHeight('finalized') <= refund.lastValidBlockHeight && !closed()) {
          refund.lastBroadcast = now; await persist(); await c.broadcast(refund).catch(() => {});
        }
        await mark(l,persist,now,'refunding','Confirming the saved refund transaction.'); return true;
      }
      checkReceipt(tx,refund);
      if (tx.meta.err) {
        refund.state = 'failed'; refund.error = JSON.stringify(tx.meta.err); delete refund.raw;
        await mark(l,persist,now,'blocked','The refund transaction failed. Its receipt is saved; recovery will retry after rechecking the remaining balance.'); return true;
      }
      ok(nativeDelta(tx,refund.to) === BigInt(refund.amount), 'The refund receipt amount differs from the recorded refund. Recovery is paused.');
      ok(-nativeDelta(tx,refund.from) === BigInt(refund.amount) + BigInt(tx.meta.fee), 'The refund debit differs from the recorded refund. Recovery is paused.');
      refund.state = 'confirmed'; refund.slot = tx.slot; delete refund.raw;
      l.recovery.refundedLamports = (BigInt(l.recovery.refundedLamports || 0) + BigInt(refund.amount)).toString();
      await mark(l,persist,now,'complete','Unused setup SOL was returned to the original paying wallet.'); return true;
    }
    // Epoch info binds block height and slot to the same finalized snapshot;
    // minContextSlot prevents a lagging RPC replica from declaring the mint absent.
    const epoch = await c.c.getEpochInfo('finalized');
    const finalizedHeight = epoch?.blockHeight, finalizedSlot = epoch?.absoluteSlot;
    ok(Number.isSafeInteger(finalizedHeight) && finalizedHeight >= 0 && Number.isSafeInteger(finalizedSlot) && finalizedSlot >= 0, 'The RPC omitted the finalized recovery checkpoint. Recovery will retry.');
    const receipts = new Map();
    for (const op of l.operations.filter(o => INITIAL.has(o.kind))) {
      if (op.state === 'awaiting_signature') {
        if (!Number.isSafeInteger(op.lastValidBlockHeight) || finalizedHeight <= op.lastValidBlockHeight) {
          await mark(l,persist,now,'checking','The last wallet request is expiring before recovery can continue.'); return true;
        }
        op.state = 'cancelled'; op.needsSignature = false; delete op.unsignedRaw; delete op.messageHash;
        await persist();
      }
      if (!op.signature) continue;
      const tx = await c.receipt(op);
      if (tx) {
        checkReceipt(tx,op); receipts.set(op.operationId || op.signature,tx);
        op.state = tx.meta.err ? 'failed' : 'confirmed'; op.slot = tx.slot;
        if (tx.meta.err) op.error = JSON.stringify(tx.meta.err);
        delete op.raw;
        await persist();
      } else if (op.state === 'pending' && (!Number.isSafeInteger(op.lastValidBlockHeight) || finalizedHeight <= op.lastValidBlockHeight)) {
        await mark(l,persist,now,'checking','Checking the saved launch transaction before returning any funds.'); return true;
      }
    }
    const receiptSlots = [...receipts.values()].map(tx => tx.slot);
    const snapshot = await launchSnapshot(c,l,Math.max(finalizedSlot, ...receiptSlots));
    if (snapshot.exists) { await restoreLive(l,c,persist); return true; }
    // A confirmed creation must never be declared failed just because another
    // RPC replica temporarily reports missing accounts.
    if (l.operations.some(o => CREATED.has(o.kind) && o.state === 'confirmed')) {
      await mark(l,persist,now,'checking','The creation transaction confirmed. Waiting for its onchain accounts to become available.'); return true;
    }
    l.state = 'failed'; l.phase = 'failed'; l.error = l.failureReason; await persist();
    const payer = l.keys.payer || l.keys.wallet, source = l.keys.platform;
    ok(payer.address === l.recovery.refundWallet, 'The original refund wallet changed. Recovery is paused.');
    if (!source?.secret || source.external || source.address === payer.address || source.address === l.keys.mint.address) {
      await mark(l,persist,now,'complete','No separate refundable setup wallet was used. Unspent funds remain in the original paying wallet.'); return true;
    }
    const key = signer(source.secret);
    ok(key.publicKey.toBase58() === source.address, 'The saved setup signer does not match its address.');
    // Mint/curve nonexistence does not establish how much native SOL belongs to
    // this launch. Attribute every debit and credit using exact saved receipts.
    let attributable = 0n;
    for (const op of l.operations.filter(o => INITIAL.has(o.kind) && o.signature)) {
      const tx = receipts.get(op.operationId || op.signature);
      if (!tx) {
        await mark(l,persist,now,'blocked','An earlier transaction receipt is unavailable. Funds will remain untouched until its exact outcome is verified.'); return true;
      }
      attributable += nativeDelta(tx,source.address);
    }
    for (const op of l.operations.filter(o => o.kind === 'setup-refund' && ['failed','confirmed'].includes(o.state))) {
      const tx = await c.receipt(op);
      ok(tx, 'A prior refund receipt is unavailable. Recovery will retry without creating another refund.');
      checkReceipt(tx,op); attributable += nativeDelta(tx,source.address);
    }
    const snapshotAccount = await c.c.getAccountInfoAndContext(key.publicKey,{commitment:'finalized',minContextSlot:snapshot.slot});
    ok(Number.isSafeInteger(snapshotAccount?.context?.slot) && snapshotAccount.context.slot >= snapshot.slot, 'The setup balance is behind the finalized launch check. Recovery will retry.');
    const account = snapshotAccount.value;
    if (!account || attributable <= 0n) {
      if (account?.lamports > 0 && attributable <= 0n && l.operations.some(o => o.state === 'cancelled')) {
        await mark(l,persist,now,'blocked','The setup wallet contains funds without a saved funding receipt. Recovery will not move an unverified balance.'); return true;
      }
      await mark(l,persist,now,'complete','No refundable setup SOL remains. Unspent funds and purchased pairing tokens remain in the original paying wallet.'); return true;
    }
    ok(account.owner.equals(SystemProgram.programId) && !account.executable && account.data.length === 0 && Number.isSafeInteger(account.lamports), 'The setup account is not a plain SOL wallet. Recovery is paused.');
    const balance = BigInt(account.lamports), budget = attributable < balance ? attributable : balance;
    const block = await c.c.getLatestBlockhash('finalized');
    ok(Number.isSafeInteger(block?.lastValidBlockHeight), 'The refund blockhash is unavailable. Recovery will retry.');
    const makeMessage = amount => new TransactionMessage({payerKey:key.publicKey,recentBlockhash:block.blockhash,instructions:[SystemProgram.transfer({fromPubkey:key.publicKey,toPubkey:pk(payer.address),lamports:amount})]}).compileToV0Message();
    const feeResult = await c.c.getFeeForMessage(makeMessage(1n),'finalized');
    ok(Number.isSafeInteger(feeResult?.value) && feeResult.value >= 0, 'The refund network fee is unavailable. Recovery will retry.');
    const fee = BigInt(feeResult.value), rent = BigInt(await c.c.getMinimumBalanceForRentExemption(0));
    let amount = budget > fee ? budget - fee : 0n;
    const remainder = balance - fee - amount;
    if (remainder > 0n && remainder < rent) amount = balance > fee + rent ? balance - fee - rent : 0n;
    if (amount <= 0n) {await mark(l,persist,now,'complete','The remaining setup balance is too small to cover its return transaction.',{unreturnedLamports:budget.toString()}); return true;}
    ok(amount + fee <= budget, 'The refund exceeds verified unused setup funds.');
    const tx = new VersionedTransaction(makeMessage(amount)); tx.sign([key]);
    const sim = await c.c.simulateTransaction(tx,{sigVerify:true,commitment:'finalized',minContextSlot:snapshotAccount.context.slot});
    ok(sim?.value && !sim.value.err, 'The refund could not be simulated. Funds have not moved; recovery will retry.');
    if (closed()) return true;
    const op = {operationId:randomBytes(16).toString('hex'),kind:'setup-refund',state:'pending',from:source.address,to:payer.address,amount:amount.toString(),networkFee:fee.toString(),signature:bs58.encode(tx.signatures[0]),raw:Buffer.from(tx.serialize()).toString('base64'),blockhash:block.blockhash,lastValidBlockHeight:block.lastValidBlockHeight,createdAt:now};
    l.operations.push(op); await mark(l,persist,now,'refunding','Returning unused setup SOL to the original paying wallet.');
    // The exact signed operation is durable before any network submission.
    if (!closed()) await c.broadcast(op).catch(() => {});
    return true;
  } catch (error) {
    await mark(l,persist,now,'blocked',scrub(error)); return true;
  }
}
