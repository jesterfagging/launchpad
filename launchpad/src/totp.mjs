import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes) {
  let bits = 0, value = 0, output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; output += alphabet[(value >>> bits) & 31]; }
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}
function decode(secret) {
  if (!/^[A-Z2-7]{32}$/.test(secret)) throw new Error('Two-factor authentication data is damaged.');
  let bits = 0, value = 0; const output = [];
  for (const character of secret) {
    value = (value << 5) | alphabet.indexOf(character); bits += 5;
    if (bits >= 8) { bits -= 8; output.push((value >>> bits) & 255); }
  }
  return Buffer.from(output);
}
export const newTotpSecret = () => base32(randomBytes(20));
export function totp(secret, now = Date.now(), digits = 6) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  const digest = createHmac('sha1', decode(secret)).update(counter).digest();
  return String((digest.readUInt32BE(digest.at(-1) & 15) & 0x7fffffff) % (10 ** digits)).padStart(digits, '0');
}
export function verifyTotp(secret, code, now, lastCounter = -1) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30000);
  for (const counter of [current, current - 1, current + 1]) {
    if (counter < 0 || counter <= lastCounter) continue;
    if (timingSafeEqual(Buffer.from(totp(secret, counter * 30000)), Buffer.from(code))) return counter;
  }
  return null;
}
export const recoveryHash = code => createHash('sha256').update(String(code).trim().toLowerCase()).digest('hex');
export function newRecoveryCodes() {
  const codes = Array.from({ length: 10 }, () => randomBytes(12).toString('hex').match(/.{6}/g).join('-'));
  return { codes, hashes: codes.map(recoveryHash) };
}
