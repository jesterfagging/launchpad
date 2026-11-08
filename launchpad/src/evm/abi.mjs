// Contract ABI encoding and decoding over JSON ABI parameter descriptions (the shape forge and solc emit:
// {name, type, components?}), including nested tuples, fixed and dynamic arrays, strings and bytes; function
// selectors and call data; event topics and log decoding. Values: BigInt / number / decimal strings for integers,
// 0x strings for addresses and bytes (or Buffers), booleans, arrays, and objects or arrays for tuples.
import { keccak256 } from './keccak.mjs';
import { isAddress, checksumAddress } from './secp256k1.mjs';
import { hexToBytes, bytesToHex, toWord, bytesToBigInt } from './hex.mjs';

const WORD = 32;
const UINT_MAX = (1n << 256n) - 1n;
const ARRAY = /^(.*)\[(\d*)\]$/;

/** The canonical type string of a parameter, with tuples expanded (for selectors and topics). */
export function canonicalType(param) {
  const match = param.type.match(ARRAY);
  if (match) return canonicalType({ ...param, type: match[1] }) + `[${match[2]}]`;
  if (param.type === 'tuple') return '(' + param.components.map(canonicalType).join(',') + ')';
  return param.type;
}
export const signatureOf = item => `${item.name}(${(item.inputs || []).map(canonicalType).join(',')})`;
export const selectorOf = item => keccak256(Buffer.from(signatureOf(item), 'ascii')).subarray(0, 4);
export const topicOf = item => bytesToHex(keccak256(Buffer.from(signatureOf(item), 'ascii')));

function baseOf(param) {
  const match = param.type.match(ARRAY);
  if (!match) return null;
  return { inner: { ...param, type: match[1] }, length: match[2] === '' ? null : Number(match[2]) };
}
export function isDynamic(param) {
  const array = baseOf(param);
  if (array) return array.length === null || isDynamic(array.inner);
  if (param.type === 'tuple') return param.components.some(isDynamic);
  return param.type === 'bytes' || param.type === 'string';
}
function staticSize(param) {
  const array = baseOf(param);
  if (array) return array.length * staticSize(array.inner);
  if (param.type === 'tuple') return param.components.reduce((sum, c) => sum + staticSize(c), 0);
  return WORD;
}

// ------------------------------------------------------------------ encoding

function encodeWordInt(value, bits, signed, type) {
  if (typeof value === 'string' && /^-?\d+$/.test(value)) value = BigInt(value);
  if (typeof value === 'number') { if (!Number.isSafeInteger(value)) throw Error(`${type}: unsafe number`); value = BigInt(value); }
  if (typeof value === 'boolean') value = value ? 1n : 0n;
  if (typeof value !== 'bigint') throw Error(`${type}: expected an integer`);
  const limit = 1n << BigInt(bits);
  if (signed) {
    if (value < -(limit >> 1n) || value >= (limit >> 1n)) throw Error(`${type}: out of range`);
    return value < 0n ? value + (1n << 256n) : value;
  }
  if (value < 0n || value >= limit) throw Error(`${type}: out of range`);
  return value;
}
const padRight = bytes => bytes.length % WORD === 0 ? bytes : Buffer.concat([bytes, Buffer.alloc(WORD - bytes.length % WORD)]);
const wordOf = value => Buffer.from(toWord(value).slice(2), 'hex');
const toBuffer = (value, type) => {
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value)) return hexToBytes(value);
  throw Error(`${type}: expected bytes`);
};

function encodeStatic(param, value) {
  const { type } = param;
  if (type === 'address') {
    if (!isAddress(value)) throw Error(`${param.name || 'address'}: expected an address`);
    return wordOf(BigInt(value));
  }
  if (type === 'bool') { if (typeof value !== 'boolean') throw Error(`${type}: expected a boolean`); return wordOf(value ? 1n : 0n); }
  const intMatch = type.match(/^(u?)int(\d*)$/);
  if (intMatch) return wordOf(encodeWordInt(value, Number(intMatch[2] || 256), intMatch[1] === '', type));
  const bytesMatch = type.match(/^bytes(\d+)$/);
  if (bytesMatch) {
    const size = Number(bytesMatch[1]), bytes = toBuffer(value, type);
    if (bytes.length !== size) throw Error(`${type}: expected ${size} bytes`);
    return padRight(bytes);
  }
  throw Error(`Unsupported ABI type ${type}`);
}

function encodeTuple(components, values) {
  const list = Array.isArray(values) ? values : components.map(c => {
    if (!values || typeof values !== 'object' || !(c.name in values)) throw Error(`Missing tuple field ${c.name}`);
    return values[c.name];
  });
  if (list.length !== components.length) throw Error('Tuple arity mismatch.');
  const heads = [], tails = [];
  let offset = components.reduce((sum, c) => sum + (isDynamic(c) ? WORD : staticSize(c)), 0);
  components.forEach((component, i) => {
    const encoded = encodeParam(component, list[i]);
    if (isDynamic(component)) { heads.push(wordOf(BigInt(offset))); tails.push(encoded); offset += encoded.length; } else heads.push(encoded);
  });
  return Buffer.concat([...heads, ...tails]);
}

export function encodeParam(param, value) {
  const array = baseOf(param);
  if (array) {
    if (!Array.isArray(value)) throw Error(`${param.name || param.type}: expected an array`);
    if (array.length !== null && value.length !== array.length) throw Error(`${param.type}: expected ${array.length} items`);
    const body = encodeTuple(value.map(() => array.inner), value);
    return array.length === null ? Buffer.concat([wordOf(BigInt(value.length)), body]) : body;
  }
  if (param.type === 'tuple') return encodeTuple(param.components, value);
  if (param.type === 'bytes') { const bytes = toBuffer(value, 'bytes'); return Buffer.concat([wordOf(BigInt(bytes.length)), padRight(bytes)]); }
  if (param.type === 'string') { if (typeof value !== 'string') throw Error('string: expected text'); const bytes = Buffer.from(value, 'utf8'); return Buffer.concat([wordOf(BigInt(bytes.length)), padRight(bytes)]); }
  return encodeStatic(param, value);
}

/** Encodes a parameter list (the arguments of a call, or the data of an event). */
export const encodeParams = (params, values) => encodeTuple(params, values);

/** Call data for a function ABI item: the 4-byte selector followed by the encoded arguments. */
export function encodeCall(item, args = []) {
  return bytesToHex(Buffer.concat([selectorOf(item), encodeParams(item.inputs || [], args)]));
}

// ------------------------------------------------------------------ decoding

function decodeTuple(components, bytes, base) {
  const values = [];
  let cursor = base;
  for (const component of components) {
    if (isDynamic(component)) {
      const offset = Number(bytesToBigInt(bytes.subarray(cursor, cursor + WORD)));
      values.push(decodeParam(component, bytes, base + offset));
      cursor += WORD;
    } else {
      values.push(decodeParam(component, bytes, cursor));
      cursor += staticSize(component);
    }
  }
  return values;
}

export function decodeParam(param, bytes, at = 0) {
  if (at + WORD > bytes.length && !(baseOf(param)?.length === 0)) throw Error('ABI data is too short.');
  const array = baseOf(param);
  if (array) {
    let length = array.length, base = at;
    if (length === null) { length = Number(bytesToBigInt(bytes.subarray(at, at + WORD))); base = at + WORD; }
    return decodeTuple(Array.from({ length }, () => array.inner), bytes, base);
  }
  if (param.type === 'tuple') {
    const values = decodeTuple(param.components, bytes, at);
    return named(param.components, values);
  }
  if (param.type === 'bytes' || param.type === 'string') {
    const length = Number(bytesToBigInt(bytes.subarray(at, at + WORD)));
    const body = bytes.subarray(at + WORD, at + WORD + length);
    if (body.length !== length) throw Error('ABI data is too short.');
    return param.type === 'string' ? body.toString('utf8') : bytesToHex(body);
  }
  const word = bytes.subarray(at, at + WORD);
  if (word.length !== WORD) throw Error('ABI data is too short.');
  const { type } = param;
  if (type === 'address') return checksumAddress(bytesToHex(word.subarray(12)));
  if (type === 'bool') return bytesToBigInt(word) !== 0n;
  const intMatch = type.match(/^(u?)int(\d*)$/);
  if (intMatch) {
    const value = bytesToBigInt(word);
    if (intMatch[1] === 'u') return value;
    return value > (UINT_MAX >> 1n) ? value - (1n << 256n) : value;
  }
  const bytesMatch = type.match(/^bytes(\d+)$/);
  if (bytesMatch) return bytesToHex(word.subarray(0, Number(bytesMatch[1])));
  throw Error(`Unsupported ABI type ${type}`);
}

/** Names the values of a tuple when every component is named; otherwise returns the array. */
function named(components, values) {
  if (!components.length || !components.every(c => c.name)) return values;
  const out = {};
  components.forEach((c, i) => { out[c.name] = values[i]; });
  return out;
}

/** Decodes a parameter list; returns an array, with named fields attached when every parameter is named. */
export function decodeParams(params, data) {
  const bytes = typeof data === 'string' ? hexToBytes(data) : Buffer.from(data);
  const values = decodeTuple(params, bytes, 0);
  const result = [...values];
  if (params.length && params.every(p => p.name)) params.forEach((p, i) => { result[p.name] = values[i]; });
  return result;
}

/** Decodes the return data of a function call. A single output comes back on its own. */
export function decodeResult(item, data) {
  const outputs = item.outputs || [];
  const values = decodeParams(outputs, data);
  return outputs.length === 1 ? values[0] : values;
}

/** Decodes a log against an event ABI item; returns null when the first topic is not this event's. */
export function decodeLog(item, log) {
  if (!log.topics?.length || log.topics[0].toLowerCase() !== topicOf(item).toLowerCase()) return null;
  const indexed = (item.inputs || []).filter(p => p.indexed), plain = (item.inputs || []).filter(p => !p.indexed);
  if (log.topics.length !== indexed.length + 1) throw Error(`${item.name}: topic count mismatch`);
  const args = {};
  indexed.forEach((p, i) => {
    const topic = hexToBytes(log.topics[i + 1]);
    args[p.name] = isDynamic(p) ? bytesToHex(topic) : decodeParam(p, topic, 0);
  });
  const values = decodeParams(plain, log.data || '0x');
  plain.forEach((p, i) => { args[p.name] = values[i]; });
  return { name: item.name, args };
}

/** Decodes an error from revert data: a custom error from `errors`, or Error(string) / Panic(uint256). */
export function decodeRevert(data, errors = []) {
  if (typeof data !== 'string' || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase(), body = '0x' + data.slice(10);
  if (selector === '0x08c379a0') return { name: 'Error', args: { message: decodeParams([{ name: 'message', type: 'string' }], body)[0] } };
  if (selector === '0x4e487b71') return { name: 'Panic', args: { code: decodeParams([{ name: 'code', type: 'uint256' }], body)[0] } };
  for (const item of errors) {
    if (bytesToHex(selectorOf(item)) === selector) {
      const values = decodeParams(item.inputs || [], body);
      const args = {}; (item.inputs || []).forEach((p, i) => { args[p.name || String(i)] = values[i]; });
      return { name: item.name, args };
    }
  }
  return { name: 'unknown', selector };
}

/** Finds an ABI item by type and name; throws when absent. */
export function abiItem(abi, name, type = 'function') {
  const item = abi.find(entry => entry.type === type && entry.name === name);
  if (!item) throw Error(`ABI has no ${type} ${name}`);
  return item;
}
