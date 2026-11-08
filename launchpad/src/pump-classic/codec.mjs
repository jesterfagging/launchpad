// Pump.fun Classic: dependency-free encoding primitives.
//
// Base58, program-derived addresses, associated token addresses and a small
// Borsh reader/writer. Nothing here imports @solana/web3.js, so the instruction
// builders and their tests run anywhere; the chain adapter converts the plain
// results to web3.js objects at the edge. PDA derivation follows
// solana_program::pubkey::Pubkey::find_program_address exactly (the off-curve
// check is the Ed25519 point decompression used by the runtime).
import { createHash } from 'node:crypto';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));
const fail = message => { throw Object.assign(Error(message), { code: 'PUMP_CLASSIC_CODEC' }); };

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const NATIVE_MINT = 'So11111111111111111111111111111111111111112';

export function base58Encode(bytes) {
  const data = Buffer.from(bytes);
  let n = BigInt('0x' + (data.toString('hex') || '0')), out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const byte of data) { if (byte !== 0) break; out = '1' + out; }
  return out;
}
export function base58Decode(text, maxLength = 128) {
  if (typeof text !== 'string' || !text.length || text.length > maxLength) fail('Invalid base58 value.');
  let n = 0n;
  for (const c of text) { const v = INDEX.get(c); if (v === undefined) fail('Invalid base58 value.'); n = n * 58n + v; }
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  let zeros = 0; for (const c of text) { if (c !== '1') break; zeros++; }
  return Buffer.concat([Buffer.alloc(zeros), body]);
}
export function publicKeyBytes(value) {
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array ? Buffer.from(value) : base58Decode(String(value));
  if (bytes.length !== 32) fail('A Solana address must be 32 bytes.');
  return bytes;
}
export const isAddress = value => { try { return typeof value === 'string' && base58Encode(publicKeyBytes(value)) === value; } catch { return false; } };
export const sha256 = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };

// --- Ed25519 point decompression (on-curve test) --------------------------------
const P = 2n ** 255n - 19n;
const D = mod(-121665n * modInverse(121666n));
const SQRT_M1 = modPow(2n, (P - 1n) / 4n);
function mod(a) { const r = a % P; return r >= 0n ? r : r + P; }
function modPow(base, exp) { let result = 1n, b = mod(base), e = exp; while (e > 0n) { if (e & 1n) result = (result * b) % P; b = (b * b) % P; e >>= 1n; } return result; }
function modInverse(a) { return modPow(a, P - 2n); }
/** True when the 32 bytes decompress to an Ed25519 point (i.e. could be a wallet key). */
export function isOnCurve(bytes) {
  const b = publicKeyBytes(bytes), y = BigInt('0x' + Buffer.from(b).reverse().toString('hex')) & ((1n << 255n) - 1n);
  const y2 = mod(y * y), u = mod(y2 - 1n), v = mod(D * y2 + 1n);
  // sqrt_ratio_i(u, v): x = u v^3 (u v^7)^((p-5)/8)
  const v3 = mod(v * v * v), v7 = mod(v3 * v3 * v);
  let x = mod(u * v3 * modPow(mod(u * v7), (P - 5n) / 8n));
  const vx2 = mod(v * x * x);
  if (vx2 === u) return true;
  if (vx2 === mod(-u)) { x = mod(x * SQRT_M1); return true; }
  return u === 0n; // y = ±1 decodes to x = 0 (on the curve)
}
const PDA_MARKER = Buffer.from('ProgramDerivedAddress');
function seedBytes(seed) {
  const bytes = typeof seed === 'string' ? Buffer.from(seed, 'utf8') : Buffer.from(seed);
  if (bytes.length > 32) fail('A PDA seed is longer than 32 bytes.');
  return bytes;
}
export function createProgramAddress(seeds, programId) {
  if (seeds.length > 16) fail('Too many PDA seeds.');
  const hash = sha256(...seeds.map(seedBytes), publicKeyBytes(programId), PDA_MARKER);
  if (isOnCurve(hash)) fail('Invalid seeds: address is on the curve.');
  return base58Encode(hash);
}
const pdaCache = new Map();
/** find_program_address: highest bump whose address is off the curve. */
export function findProgramAddress(seeds, programId) {
  const key = programId + ':' + seeds.map(s => seedBytes(s).toString('hex')).join(':');
  const hit = pdaCache.get(key); if (hit) return hit;
  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256(...seeds.map(seedBytes), Buffer.from([bump]), publicKeyBytes(programId), PDA_MARKER);
    if (!isOnCurve(hash)) {
      const result = Object.freeze({ address: base58Encode(hash), bump });
      if (pdaCache.size > 4096) pdaCache.clear();
      pdaCache.set(key, result); return result;
    }
  }
  return fail('No viable program-derived address bump.');
}
/** Seeds: UTF-8 strings for literal seeds, Buffers (e.g. key(address)) for everything else. */
export const pda = (seeds, programId) => findProgramAddress(seeds, programId).address;
export const key = address => publicKeyBytes(address);
export function associatedTokenAddress(owner, mint, tokenProgram = TOKEN_PROGRAM) {
  return findProgramAddress([publicKeyBytes(owner), publicKeyBytes(tokenProgram), publicKeyBytes(mint)], ASSOCIATED_TOKEN_PROGRAM).address;
}

// --- Borsh ------------------------------------------------------------------------
const U64_MAX = 2n ** 64n - 1n;
export class BorshWriter {
  constructor() { this.parts = []; }
  u8(v) { this.parts.push(Buffer.from([Number(intRange(v, 0n, 255n))])); return this; }
  u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(Number(intRange(v, 0n, 65535n))); this.parts.push(b); return this; }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(Number(intRange(v, 0n, 4294967295n))); this.parts.push(b); return this; }
  u64(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(intRange(v, 0n, U64_MAX)); this.parts.push(b); return this; }
  i64(v) { const b = Buffer.alloc(8); b.writeBigInt64LE(intRange(v, -(2n ** 63n), 2n ** 63n - 1n)); this.parts.push(b); return this; }
  u128(v) { const n = intRange(v, 0n, 2n ** 128n - 1n), b = Buffer.alloc(16); b.writeBigUInt64LE(n & U64_MAX, 0); b.writeBigUInt64LE(n >> 64n, 8); this.parts.push(b); return this; }
  i128(v) { const n = intRange(v, -(2n ** 127n), 2n ** 127n - 1n); return this.u128(n < 0n ? n + 2n ** 128n : n); }
  bool(v) { if (typeof v !== 'boolean') fail('Borsh bool expected.'); this.parts.push(Buffer.from([v ? 1 : 0])); return this; }
  pubkey(v) { this.parts.push(publicKeyBytes(v)); return this; }
  string(v) { if (typeof v !== 'string') fail('Borsh string expected.'); const b = Buffer.from(v, 'utf8'); this.u32(b.length); this.parts.push(b); return this; }
  bytes(v) { this.parts.push(Buffer.from(v)); return this; }
  toBuffer() { return Buffer.concat(this.parts); }
}
function intRange(value, min, max) {
  const n = typeof value === 'bigint' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : typeof value === 'string' && /^-?\d+$/.test(value) ? BigInt(value) : fail('Borsh integer expected.');
  if (n < min || n > max) fail('Borsh integer out of range.');
  return n;
}
export class BorshReader {
  constructor(data, offset = 0) { this.data = Buffer.from(data); this.offset = offset; }
  need(n) { if (this.offset + n > this.data.length) throw Object.assign(Error('Account data is shorter than its layout.'), { code: 'PUMP_CLASSIC_SHORT' }); }
  remaining() { return this.data.length - this.offset; }
  u8() { this.need(1); return this.data[this.offset++]; }
  u16() { this.need(2); const v = this.data.readUInt16LE(this.offset); this.offset += 2; return v; }
  u32() { this.need(4); const v = this.data.readUInt32LE(this.offset); this.offset += 4; return v; }
  u64() { this.need(8); const v = this.data.readBigUInt64LE(this.offset); this.offset += 8; return v; }
  i64() { this.need(8); const v = this.data.readBigInt64LE(this.offset); this.offset += 8; return v; }
  u128() { this.need(16); const lo = this.data.readBigUInt64LE(this.offset), hi = this.data.readBigUInt64LE(this.offset + 8); this.offset += 16; return (hi << 64n) | lo; }
  i128() { const u = this.u128(); return u >= 2n ** 127n ? u - 2n ** 128n : u; }
  bool() { const v = this.u8(); if (v > 1) fail('Invalid Borsh bool.'); return v === 1; }
  pubkey() { this.need(32); const v = base58Encode(this.data.subarray(this.offset, this.offset + 32)); this.offset += 32; return v; }
  string() { const n = this.u32(); this.need(n); const v = this.data.subarray(this.offset, this.offset + n).toString('utf8'); this.offset += n; return v; }
}
