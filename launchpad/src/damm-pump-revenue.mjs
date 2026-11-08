import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import bs58 from 'bs58';
import { DAMM_PUMP_FEE_DEPLOYMENT_POLICY } from './damm-pump-fee-deployment.mjs';

const TREASURY = DAMM_PUMP_FEE_DEPLOYMENT_POLICY.treasury, SOL = NATIVE_MINT.toBase58();
const raw = value => typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) < 1n << 64n ? BigInt(value) : null;
const address = value => { try { return typeof value === 'string' && new PublicKey(value).toBase58() === value; } catch { return false; } };
const signature = value => { try { return typeof value === 'string' && bs58.decode(value).length === 64; } catch { return false; } };
const symbol = value => String(value || 'Quote').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 30);

// Older DAMM launches did not save a separate creation-fee receipt. Their
// finalized reconciler did verify that this exact signed wire succeeded on
// chain. Recover only its explicit System transfer, never the review budget,
// total wallet debit (which includes rent), or a current wallet balance.
function creationTransfer(op, launch) {
  try {
    const fee = raw(launch.creationFee?.lamports);
    if (fee === null || launch.creationFee.recipient !== TREASURY || op.wallet !== launch.creatorWallet || !address(op.wallet)) return null;
    if (!fee || op.wallet === TREASURY) return 0n;
    if (typeof op.signedTransaction !== 'string' || op.signedTransaction.length > 1800) return null;
    const wire = Buffer.from(op.signedTransaction, 'base64'), tx = VersionedTransaction.deserialize(wire);
    if (wire.length > 1232 || !wire.equals(Buffer.from(tx.serialize())) || bs58.encode(tx.signatures[0]) !== op.signature) return null;
    const snapshots = op.bundle?.addressLookupTables || op.bundle?.lookupTables || [];
    const tables = snapshots.map(row => ({ key: new PublicKey(row.address || row.key), state: { addresses: row.addresses.map(value => new PublicKey(value)) } }));
    const message = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: tables });
    if (message.payerKey.toBase58() !== op.wallet) return null;
    const transfers = message.instructions.filter(ix => ix.programId.equals(SystemProgram.programId) && ix.data.length === 12 && ix.data.readUInt32LE(0) === 2 && ix.keys[0]?.pubkey.toBase58() === op.wallet && ix.keys[1]?.pubkey.toBase58() === TREASURY);
    return transfers.length === 1 && transfers[0].data.readBigUInt64LE(4) === fee ? fee : null;
  } catch { return null; }
}

// Reporting only; callers supply the production store. This neither claims
// fees nor scans balances and must never be wired to the private test service.
export function dammPumpRevenueAnalyticsSources(book) {
  if (book?.schemaVersion !== 1 || !Array.isArray(book.launches) || !Array.isArray(book.operations) || book.launches.length > 100000 || book.operations.length > 1000000) throw Error('PumpSwap revenue history is unavailable.');
  let complete = book.historyTruncated !== true && book.operationsTruncated !== true, creationComplete = complete;
  const launches = new Map(), candidates = new Map(), conflicts = new Set();
  for (const launch of book.launches) {
    if (!address(launch?.mint) || !address(launch.quoteMint) || !Number.isInteger(launch.quoteDecimals) || launch.quoteDecimals < 0 || launch.quoteDecimals > 18 || launches.has(launch.mint)) { complete = creationComplete = false; continue; }
    launches.set(launch.mint, launch);
    if (launch.historyTruncated === true || launch.operationsTruncated === true) complete = creationComplete = false;
  }
  const add = row => {
    const key = row.signature + ':' + row.kind, prior = candidates.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row)) { conflicts.add(key); complete = creationComplete = false; }
    else candidates.set(key, row);
  };
  for (const op of book.operations) {
    if (op?.state !== 'finalized' || !['initialize', 'protocol-fees', 'migrate', 'buy'].includes(op.action) || op.action === 'buy' && op.bundle?.atomicGraduation !== true) continue;
    const launch = launches.get(op.mint), result = op.result;
    if (!launch || result?.state !== 'finalized' || !signature(op.signature) || result.signature !== op.signature || !Number.isSafeInteger(result.slot) || result.slot <= 0) { if (op.action === 'initialize') creationComplete = false; else complete = false; continue; }
    const common = { signature: op.signature, launchMint: launch.mint, recipient: TREASURY, slot: result.slot };
    if (op.action === 'initialize') {
      const fee = creationTransfer(op, launch);
      if (fee === null) creationComplete = false;
      else if (fee) add({ ...common, kind: 'creation', mint: SOL, decimals: 9, symbol: 'SOL', amount: String(fee) });
      continue;
    }
    if (op.action === 'protocol-fees') {
      const fee = raw(result.protocolFee?.quoteRaw);
      if (fee === null || fee <= 0n || result.protocolFee.recipient !== TREASURY) { complete = false; continue; }
      add({ ...common, kind: 'protocol-fees', mint: launch.quoteMint, decimals: launch.quoteDecimals, symbol: symbol(launch.quoteSymbol), amount: String(fee) });
      continue;
    }
    // Legacy no-fee controllers genuinely produce no graduation revenue.
    if (launch.publicProgramId !== DAMM_PUMP_FEE_DEPLOYMENT_POLICY.programId) {
      if (result.graduationFee || raw(result.graduationFeeRaw || '0') !== 0n) complete = false;
      continue;
    }
    const fee = result.graduationFee, amount = raw(fee?.amountRaw), gross = raw(result.grossQuoteRaw), net = raw(result.poolQuoteRaw);
    if (fee?.verified !== true || fee.signature !== op.signature || fee.recipient !== TREASURY || fee.quoteMint !== launch.quoteMint || amount === null || amount <= 0n || gross === null || net === null || result.graduationFeeRaw !== String(amount) || amount + net !== gross || amount !== gross * 322369073n / 1000000000n || result.phase !== 'migrated') { complete = false; continue; }
    add({ ...common, kind: 'graduation', mint: launch.quoteMint, decimals: launch.quoteDecimals, symbol: symbol(launch.quoteSymbol), amount: String(amount) });
  }
  const sources = [...candidates].filter(([key]) => !conflicts.has(key)).map(([, row]) => row), created = new Set(), migrated = new Set(), paid = new Map();
  for (const row of sources) {
    if (row.kind === 'creation') created.add(row.launchMint);
    else if (row.kind === 'graduation') migrated.add(row.launchMint);
    else paid.set(row.launchMint, (paid.get(row.launchMint) || 0n) + BigInt(row.amount));
  }
  for (const launch of launches.values()) {
    if (launch.protocolFeesPaidRaw !== undefined && (raw(launch.protocolFeesPaidRaw) === null || raw(launch.protocolFeesPaidRaw) > (paid.get(launch.mint) || 0n))) complete = false;
    if (launch.status === 'migrated' && launch.publicProgramId === DAMM_PUMP_FEE_DEPLOYMENT_POLICY.programId && !migrated.has(launch.mint)) complete = false;
    if (launch.finalizedAt && raw(launch.creationFee?.lamports) !== 0n && launch.creatorWallet !== TREASURY && !created.has(launch.mint)) creationComplete = false;
  }
  return { sources, complete, creationComplete };
}
