// secp256k1 for Ethereum signing, dependency-free: Jacobian point arithmetic over BigInt, RFC 6979 deterministic
// nonces (HMAC-SHA256 from node:crypto), low-s signatures with a recovery id, public-key recovery and the
// keccak-derived address. Only what signing and verifying transactions needs; no encryption, no ECDH.
import { createHmac, randomBytes } from 'node:crypto';
import { keccak256 } from './keccak.mjs';

export const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
const HALF_N = N >> 1n;

const mod = (a, m = P) => { const r = a % m; return r < 0n ? r + m : r; };
function modPow(base, exponent, m) {
  let result = 1n; base = mod(base, m);
  while (exponent > 0n) { if (exponent & 1n) result = result * base % m; base = base * base % m; exponent >>= 1n; }
  return result;
}
const inverse = (a, m = P) => modPow(a, m - 2n, m); // m is prime

// Jacobian coordinates (X, Y, Z) with x = X / Z^2, y = Y / Z^3; the point at infinity has Z = 0.
const INFINITY = [0n, 1n, 0n];
function double([x, y, z]) {
  if (z === 0n) return INFINITY;
  const a = mod(x * x), b = mod(y * y), c = mod(b * b);
  const d = mod(2n * (mod((x + b) * (x + b)) - a - c));
  const e = mod(3n * a), f = mod(e * e);
  const x3 = mod(f - 2n * d);
  return [x3, mod(e * (d - x3) - 8n * c), mod(2n * y * z)];
}
function add(p, q) {
  const [x1, y1, z1] = p, [x2, y2, z2] = q;
  if (z1 === 0n) return q;
  if (z2 === 0n) return p;
  const z1z1 = mod(z1 * z1), z2z2 = mod(z2 * z2);
  const u1 = mod(x1 * z2z2), u2 = mod(x2 * z1z1);
  const s1 = mod(y1 * z2 * z2z2), s2 = mod(y2 * z1 * z1z1);
  const h = mod(u2 - u1), r = mod(s2 - s1);
  if (h === 0n) return r === 0n ? double(p) : INFINITY;
  const hh = mod(h * h), hhh = mod(hh * h), v = mod(u1 * hh);
  const x3 = mod(r * r - hhh - 2n * v);
  return [x3, mod(r * (v - x3) - s1 * hhh), mod(h * z1 * z2)];
}
function multiply(point, scalar) {
  let result = INFINITY, addend = point;
  while (scalar > 0n) {
    if (scalar & 1n) result = add(result, addend);
    addend = double(addend);
    scalar >>= 1n;
  }
  return result;
}
function affine([x, y, z]) {
  if (z === 0n) throw Error('point at infinity');
  const zi = inverse(z), zi2 = mod(zi * zi);
  return [mod(x * zi2), mod(y * zi2 * zi)];
}
const G = [GX, GY, 1n];
const toBytes32 = value => Buffer.from(value.toString(16).padStart(64, '0'), 'hex');
const fromBytes = bytes => BigInt('0x' + Buffer.from(bytes).toString('hex'));

/** A fresh private key: 32 random bytes in [1, N-1], as a 0x hex string. */
export function randomPrivateKey() {
  for (;;) {
    const d = fromBytes(randomBytes(32));
    if (d > 0n && d < N) return '0x' + d.toString(16).padStart(64, '0');
  }
}

export function privateKeyToBigInt(privateKey) {
  const text = String(privateKey).replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(text)) throw Error('A private key is 32 bytes of hex.');
  const d = BigInt('0x' + text);
  if (d <= 0n || d >= N) throw Error('The private key is outside the curve order.');
  return d;
}

/** The uncompressed public key (64 bytes, x || y) of a private key. */
export function publicKey(privateKey) {
  const [x, y] = affine(multiply(G, privateKeyToBigInt(privateKey)));
  return Buffer.concat([toBytes32(x), toBytes32(y)]);
}

/** The EIP-55 checksummed address of a 64-byte public key. */
export function publicKeyToAddress(pub) {
  const bytes = pub.length === 65 ? pub.subarray(1) : pub;
  if (bytes.length !== 64) throw Error('An uncompressed public key is 64 bytes.');
  return checksumAddress('0x' + keccak256(bytes).subarray(12).toString('hex'));
}

export function privateKeyToAddress(privateKey) { return publicKeyToAddress(publicKey(privateKey)); }

/** EIP-55 mixed-case checksum of a 20-byte hex address. */
export function checksumAddress(address) {
  const lower = String(address).toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(lower)) throw Error('An address is 20 bytes of hex.');
  const hash = keccak256(Buffer.from(lower, 'ascii')).toString('hex');
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

/** True for a 0x-prefixed 20-byte hex address whose mixed case, if any, is a valid EIP-55 checksum. */
export function isAddress(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) return false;
  const lower = value.toLowerCase(), upper = value.toUpperCase();
  if (value === lower || value === '0x' + upper.slice(2)) return true;
  return checksumAddress(value) === value;
}

// RFC 6979 section 3.2 with SHA-256: the nonce is a function of the key and the message hash alone.
function deterministicNonce(d, hash) {
  const x = toBytes32(d), h1 = toBytes32(mod(fromBytes(hash), N));
  let v = Buffer.alloc(32, 0x01), k = Buffer.alloc(32, 0x00);
  const hmac = (key, ...parts) => createHmac('sha256', key).update(Buffer.concat(parts)).digest();
  k = hmac(k, v, Buffer.from([0x00]), x, h1);
  v = hmac(k, v);
  k = hmac(k, v, Buffer.from([0x01]), x, h1);
  v = hmac(k, v);
  for (;;) {
    v = hmac(k, v);
    const candidate = fromBytes(v);
    if (candidate > 0n && candidate < N) return candidate;
    k = hmac(k, v, Buffer.from([0x00]));
    v = hmac(k, v);
  }
}

/**
 * Signs a 32-byte hash. Returns {r, s, recovery} with s in the lower half of the order (as Ethereum requires) and
 * recovery = 0 or 1 (the parity of R's y, flipped when s was negated), the value EIP-155 / EIP-1559 call yParity.
 */
export function sign(hash, privateKey) {
  const bytes = Buffer.from(hash);
  if (bytes.length !== 32) throw Error('Sign a 32-byte hash.');
  const d = privateKeyToBigInt(privateKey), z = fromBytes(bytes);
  let k = deterministicNonce(d, bytes);
  for (let attempt = 0; attempt < 64; attempt++) {
    const [rx, ry] = affine(multiply(G, k));
    const r = mod(rx, N);
    if (r !== 0n) {
      let s = mod(inverse(k, N) * mod(z + r * d, N), N);
      if (s !== 0n) {
        let recovery = Number(ry & 1n) | (rx >= N ? 2 : 0);
        if (s > HALF_N) { s = N - s; recovery ^= 1; }
        return { r, s, recovery };
      }
    }
    k = mod(k + 1n, N) || 1n; // astronomically unlikely; keeps the signature well-defined
  }
  throw Error('Could not produce a signature.');
}

/** Recovers the 64-byte public key that signed `hash` with (r, s, recovery). */
export function recover(hash, { r, s, recovery }) {
  const bytes = Buffer.from(hash);
  if (bytes.length !== 32) throw Error('Recover from a 32-byte hash.');
  if (r <= 0n || r >= N || s <= 0n || s >= N) throw Error('Signature values are outside the curve order.');
  if (recovery < 0 || recovery > 3) throw Error('The recovery id is 0 to 3.');
  const x = r + (recovery >= 2 ? N : 0n);
  if (x >= P) throw Error('The signature does not recover.');
  const ySquared = mod(x * x * x + 7n);
  let y = modPow(ySquared, (P + 1n) / 4n, P);
  if (mod(y * y) !== ySquared) throw Error('The signature does not recover.');
  if (Number(y & 1n) !== (recovery & 1)) y = P - y;
  const z = fromBytes(bytes), rInverse = inverse(r, N);
  // Q = r^-1 (s R - z G)
  const sR = multiply([x, y, 1n], s), zG = multiply(G, mod(z, N));
  const point = multiply(add(sR, [zG[0], mod(P - zG[1]), zG[2]]), rInverse);
  const [qx, qy] = affine(point);
  return Buffer.concat([toBytes32(qx), toBytes32(qy)]);
}

/** The address that signed `hash`. */
export function recoverAddress(hash, signature) { return publicKeyToAddress(recover(hash, signature)); }

/** Verifies (r, s) against a 64-byte public key without the recovery id. */
export function verify(hash, { r, s }, pub) {
  if (r <= 0n || r >= N || s <= 0n || s >= N) return false;
  const bytes = pub.length === 65 ? pub.subarray(1) : pub;
  const q = [fromBytes(bytes.subarray(0, 32)), fromBytes(bytes.subarray(32, 64)), 1n];
  const z = mod(fromBytes(Buffer.from(hash)), N), w = inverse(s, N);
  const u1 = mod(z * w, N), u2 = mod(r * w, N);
  const point = add(multiply(G, u1), multiply(q, u2));
  if (point[2] === 0n) return false;
  const [x] = affine(point);
  return mod(x, N) === r;
}

/** Serializes r and s as the 64 fixed-width bytes Ethereum uses (followed by v in a 65-byte signature). */
export function signatureBytes({ r, s, recovery }, vOffset = 27) {
  return Buffer.concat([toBytes32(r), toBytes32(s), Buffer.from([recovery + vOffset])]);
}
