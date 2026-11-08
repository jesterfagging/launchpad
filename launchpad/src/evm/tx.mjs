// EIP-1559 (type 2) transactions: build, sign, serialize and hash; plus EIP-191 personal-message hashing for
// off-chain proofs. Everything a service that sends its own transactions needs, nothing a wallet needs.
import { keccak256 } from './keccak.mjs';
import { rlpEncode, rlpDecode } from './rlp.mjs';
import { sign, recoverAddress, isAddress, checksumAddress } from './secp256k1.mjs';
import { bytesToHex, hexToBytes, bytesToBigInt } from './hex.mjs';

const quantity = value => { const n = BigInt(value ?? 0); if (n < 0n) throw Error('Transaction fields are not negative.'); return n; };

/** Normalizes a transaction request: {chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to, value, data}. */
export function normalizeTx(tx) {
  const to = tx.to == null || tx.to === '' ? null : tx.to;
  if (to !== null && !isAddress(to)) throw Error('Transaction "to" is not an address.');
  const data = tx.data ?? '0x';
  if (typeof data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(data)) throw Error('Transaction data is not hex bytes.');
  return {
    chainId: quantity(tx.chainId), nonce: quantity(tx.nonce), maxPriorityFeePerGas: quantity(tx.maxPriorityFeePerGas), maxFeePerGas: quantity(tx.maxFeePerGas),
    gas: quantity(tx.gas), to: to === null ? null : checksumAddress(to), value: quantity(tx.value), data, accessList: tx.accessList || [],
  };
}

function fields(tx, signature) {
  const list = [tx.chainId, tx.nonce, tx.maxPriorityFeePerGas, tx.maxFeePerGas, tx.gas, tx.to ? tx.to : '0x', tx.value, tx.data, tx.accessList.map(entry => [entry.address, entry.storageKeys || []])];
  if (signature) list.push(BigInt(signature.recovery), signature.r, signature.s);
  return list;
}

/** The bytes a signer hashes for a type-2 transaction (0x02 || rlp([...])). */
export function signingPayload(tx) {
  return Buffer.concat([Buffer.from([0x02]), rlpEncode(fields(normalizeTx(tx)))]);
}

/** Signs and serializes; returns {raw (0x hex), hash (0x hex), signature}. */
export function signTransaction(tx, privateKey) {
  const normalized = normalizeTx(tx);
  const signature = sign(keccak256(signingPayload(normalized)), privateKey);
  const raw = Buffer.concat([Buffer.from([0x02]), rlpEncode(fields(normalized, signature))]);
  return { raw: bytesToHex(raw), hash: bytesToHex(keccak256(raw)), signature };
}

/** Parses a raw type-2 transaction back into its fields and the signer's address. */
export function parseTransaction(raw) {
  const bytes = hexToBytes(raw);
  if (bytes[0] !== 0x02) throw Error('Only EIP-1559 transactions are parsed.');
  const items = rlpDecode(bytes.subarray(1));
  if (!Array.isArray(items) || items.length !== 12) throw Error('Malformed transaction.');
  const [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to, value, data, accessList, yParity, r, s] = items;
  const tx = {
    chainId: bytesToBigInt(chainId), nonce: bytesToBigInt(nonce), maxPriorityFeePerGas: bytesToBigInt(maxPriorityFeePerGas), maxFeePerGas: bytesToBigInt(maxFeePerGas),
    gas: bytesToBigInt(gas), to: to.length ? checksumAddress(bytesToHex(to)) : null, value: bytesToBigInt(value), data: bytesToHex(data),
    accessList: accessList.map(([address, keys]) => ({ address: checksumAddress(bytesToHex(address)), storageKeys: keys.map(bytesToHex) })),
  };
  const signature = { recovery: Number(bytesToBigInt(yParity)), r: bytesToBigInt(r), s: bytesToBigInt(s) };
  const from = recoverAddress(keccak256(signingPayload(tx)), signature);
  return { ...tx, from, hash: bytesToHex(keccak256(bytes)), signature };
}

/** EIP-191 hash of a personal message ("\x19Ethereum Signed Message:\n" + length + message). */
export function personalMessageHash(message) {
  const body = typeof message === 'string' ? Buffer.from(message, 'utf8') : Buffer.from(message);
  return keccak256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`, 'utf8'), body]));
}
