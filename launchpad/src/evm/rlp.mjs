// Recursive Length Prefix encoding and decoding (the Ethereum wire format for transactions).
import { bigIntToBytes } from './hex.mjs';

function lengthPrefix(length, offset) {
  if (length < 56) return Buffer.from([offset + length]);
  const lengthBytes = bigIntToBytes(BigInt(length));
  return Buffer.concat([Buffer.from([offset + 55 + lengthBytes.length]), lengthBytes]);
}

/** Encodes bytes, a BigInt / number (as a minimal big-endian integer), a 0x hex string, or an array of those. */
export function rlpEncode(item) {
  if (Array.isArray(item)) {
    const body = Buffer.concat(item.map(rlpEncode));
    return Buffer.concat([lengthPrefix(body.length, 0xc0), body]);
  }
  const bytes = toBytes(item);
  if (bytes.length === 1 && bytes[0] < 0x80) return bytes;
  return Buffer.concat([lengthPrefix(bytes.length, 0x80), bytes]);
}

function toBytes(item) {
  if (item instanceof Uint8Array) return Buffer.from(item);
  if (typeof item === 'bigint' || typeof item === 'number') return bigIntToBytes(BigInt(item));
  if (typeof item === 'string' && /^0x[0-9a-fA-F]*$/.test(item)) return Buffer.from(item.length % 2 ? '0' + item.slice(2) : item.slice(2), 'hex');
  if (typeof item === 'string') return Buffer.from(item, 'utf8');
  if (item === null || item === undefined) return Buffer.alloc(0);
  throw Error('RLP cannot encode this value.');
}

/** Decodes into nested arrays of Buffers. */
export function rlpDecode(input) {
  const bytes = Buffer.from(input);
  const [value, rest] = decodeAt(bytes, 0);
  if (rest !== bytes.length) throw Error('RLP: trailing bytes.');
  return value;
}

function decodeAt(bytes, start) {
  if (start >= bytes.length) throw Error('RLP: unexpected end.');
  const first = bytes[start];
  if (first < 0x80) return [bytes.subarray(start, start + 1), start + 1];
  if (first < 0xb8) { const length = first - 0x80; return [bytes.subarray(start + 1, start + 1 + length), start + 1 + length]; }
  if (first < 0xc0) {
    const lengthLength = first - 0xb7, length = Number(BigInt('0x' + bytes.subarray(start + 1, start + 1 + lengthLength).toString('hex')));
    const from = start + 1 + lengthLength;
    return [bytes.subarray(from, from + length), from + length];
  }
  let length, from;
  if (first < 0xf8) { length = first - 0xc0; from = start + 1; } else {
    const lengthLength = first - 0xf7;
    length = Number(BigInt('0x' + bytes.subarray(start + 1, start + 1 + lengthLength).toString('hex')));
    from = start + 1 + lengthLength;
  }
  const items = [];
  let cursor = from;
  while (cursor < from + length) { const [item, next] = decodeAt(bytes, cursor); items.push(item); cursor = next; }
  if (cursor !== from + length) throw Error('RLP: list length mismatch.');
  return [items, cursor];
}
