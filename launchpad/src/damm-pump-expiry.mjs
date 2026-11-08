/** Bounded finalized-history proof for one already journaled PumpSwap packet. */
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { proveExpiredAbsence } from './meteora-expiry.mjs';
import { validateWalletMessage } from './launchpad-wallet-guards.mjs';
import { verifySignedTransaction } from './providers.mjs';

function reviewedKeys(tx, bundle) {
  const prepared=VersionedTransaction.deserialize(Buffer.from(bundle.unsignedTransaction,'base64'));
  if(prepared.version!==0)throw Error('Unsupported saved review.');
  const snapshots=bundle.addressLookupTables||bundle.lookupTables||[];
  const required=new Set([...prepared.message.addressTableLookups,...tx.message.addressTableLookups].map(row=>row.accountKey.toBase58()));
  if(!Array.isArray(snapshots))throw Error('Missing saved lookup snapshot.');
  const tables=[...required].map(key=>{
    const rows=snapshots.filter(row=>(row.address||row.key)===key);
    if(rows.length!==1||!Array.isArray(rows[0].addresses)||!rows[0].addresses.length)throw Error('Changed saved lookup snapshot.');
    return {key:new PublicKey(key),state:{addresses:rows[0].addresses.map(address=>new PublicKey(address))}};
  });
  validateWalletMessage(prepared.message,tx.message,{resolvedTables:tables,allowEquivalentRecompile:true,allowComputeBudget:true});
  const signers=prepared.message.staticAccountKeys.slice(0,prepared.message.header.numRequiredSignatures).map(key=>key.toBase58());
  verifySignedTransaction(Buffer.from(tx.serialize()),signers[0],signers.slice(1));
  return tx.message.getAccountKeys({addressLookupTableAccounts:tables}).keySegments().flat();
}

export function proveExpiredDammPumpAbsence(connection, op) {
  return proveExpiredAbsence(connection,op,{validateReviewedMessage:reviewedKeys});
}
