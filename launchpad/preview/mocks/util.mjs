// Small deterministic helpers for the preview mocks: base58 ids, seeded
// random numbers and a dependency-free PNG avatar generator.
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes) {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex') || '0'), out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}
export const sha = (text, bytes = 32) => createHash('sha256').update(String(text)).digest().subarray(0, bytes);
export const hex64 = text => createHash('sha256').update(String(text)).digest('hex');
/** Deterministic, valid-looking Solana address (32 bytes → 43/44 chars, no leading 1s). */
export function address(seed) { let i = 0, out; do { out = base58(sha(seed + ':' + i++)); } while (out.length < 43 || out.startsWith('1')); return out; }
/** Deterministic 64-byte transaction signature (87/88 chars). */
export function signature(seed) { let i = 0, out; do { const a = sha(seed + ':a' + i), b = sha(seed + ':b' + i++); out = base58(Buffer.concat([a, b])); } while (out.length < 87 || out.startsWith('1')); return out; }

export function rng(seed) {
  let s = sha(seed).readUInt32LE(0) || 1;
  return () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------- PNG avatars
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function hsl(h, s, l) { const a = s * Math.min(l, 1 - l), f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); }; return [f(0) * 255, f(8) * 255, f(4) * 255]; }
const cache = new Map();
/** A soft two-tone gradient avatar with a highlight orb, derived from a hash. */
export function avatarPng(key, size = 192) {
  if (cache.has(key)) return cache.get(key);
  const h = sha(key), hue1 = h[0] / 255 * 360, hue2 = (hue1 + 40 + h[1] / 255 * 120) % 360;
  const c1 = hsl(hue1, .62, .52), c2 = hsl(hue2, .7, .34), orbX = .25 + h[2] / 255 * .5, orbY = .2 + h[3] / 255 * .4, ring = h[4] % 3;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size), dx = x / size - orbX, dy = y / size - orbY, d = Math.sqrt(dx * dx + dy * dy);
      let r = c1[0] * (1 - t) + c2[0] * t, g = c1[1] * (1 - t) + c2[1] * t, b = c1[2] * (1 - t) + c2[2] * t;
      const glow = Math.max(0, 1 - d / .32) ** 2 * .55; r += (255 - r) * glow; g += (255 - g) * glow; b += (255 - b) * glow;
      if (ring) { const edge = Math.abs(Math.sqrt((x / size - .5) ** 2 + (y / size - .5) ** 2) - (ring === 1 ? .34 : .27)), k = Math.max(0, 1 - edge / .03) ** 2 * .35; r = r * (1 - k) + 255 * k; g = g * (1 - k) + 255 * k; b = b * (1 - k) + 255 * k; }
      const o = y * (size * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  cache.set(key, png); return png;
}
