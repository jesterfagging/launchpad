import { MessageV1, VersionedTransaction } from '@solana/web3.js';
import { compileTransactionMessage, getCompiledTransactionMessageEncoder } from '@solana/transaction-messages';
import { getTransactionEncoder } from '@solana/transactions';

const messageEncoder = getCompiledTransactionMessageEncoder(), transactionEncoder = getTransactionEncoder();

export class TransactionCapacityError extends Error {
  constructor(message) { super(message); this.name = 'TransactionCapacityError'; }
}

// web3.js 1.99 can READ v1, but its message serializer throws and its transaction
// serializer still writes signatures first. Use Solana Kit's official codecs
// while retaining the existing signer and mutable replacement-blockhash API.
class WritableMessageV1 extends MessageV1 {
  serialize() {
    const c = this.transactionConfig, configValues = [];
    let configMask = 0;
    for (const [field, mask, kind] of [['priorityFee', 3, 'u64'], ['computeUnitLimit', 4, 'u32'],
      ['loadedAccountsDataSizeLimit', 8, 'u32'], ['heapSize', 16, 'u32']]) {
      if (c[field] !== null && c[field] !== undefined) {
        configMask |= mask; configValues.push({ kind, value: kind === 'u64' ? BigInt(c[field]) : c[field] });
      }
    }
    return messageEncoder.encode({
      version: 1, lifetimeToken: this.recentBlockhash, configMask, configValues,
      header: { numSignerAccounts: this.header.numRequiredSignatures, numReadonlySignerAccounts: this.header.numReadonlySignedAccounts,
        numReadonlyNonSignerAccounts: this.header.numReadonlyUnsignedAccounts },
      numInstructions: this.compiledInstructions.length, numStaticAccounts: this.staticAccountKeys.length,
      staticAccounts: this.staticAccountKeys.map(String),
      instructionHeaders: this.compiledInstructions.map(ix => ({ programAccountIndex: ix.programIdIndex,
        numInstructionAccounts: ix.accountKeyIndexes.length, numInstructionDataBytes: ix.data.length })),
      instructionPayloads: this.compiledInstructions.map(ix => ({ instructionAccountIndices: ix.accountKeyIndexes, instructionData: ix.data })),
    });
  }
}

class WritableTransactionV1 extends VersionedTransaction {
  serialize() {
    return transactionEncoder.encode({ messageBytes: this.message.serialize(), signatures: Object.fromEntries(
      this.message.staticAccountKeys.slice(0, this.message.header.numRequiredSignatures).map((key, i) => [String(key), this.signatures[i]]),
    ) });
  }
}

export function makeV1Transaction(payer, blockhash, instructions, config) {
  const accounts = new Set([String(payer), ...instructions.flatMap(ix => [String(ix.programId), ...ix.keys.map(k => String(k.pubkey))])]);
  if (accounts.size > 64 || instructions.length > 64 || instructions.some(ix => ix.keys.length > 255))
    throw new TransactionCapacityError(`Route needs ${accounts.size} accounts and ${instructions.length} instructions; v1 allows 64 of each and 255 accounts per instruction.`);
  const compiled = compileTransactionMessage({
    version: 1, feePayer: { address: String(payer) }, lifetimeConstraint: { blockhash, lastValidBlockHeight: 0n },
    config: { computeUnitLimit: config.computeUnits, loadedAccountsDataSizeLimit: 64 * 1024 * 1024,
      priorityFeeLamports: config.fees.priority },
    instructions: instructions.map(ix => ({ programAddress: String(ix.programId), data: ix.data,
      accounts: ix.keys.map(k => ({ address: String(k.pubkey), role: (k.isSigner ? 2 : 0) + (k.isWritable ? 1 : 0) })) })),
  });
  return new WritableTransactionV1(new WritableMessageV1(MessageV1.deserialize(messageEncoder.encode(compiled))));
}

export function deserializeTransaction(bytes) {
  const tx = VersionedTransaction.deserialize(bytes);
  return tx.version === 1 ? new WritableTransactionV1(new WritableMessageV1(tx.message), tx.signatures) : tx;
}
