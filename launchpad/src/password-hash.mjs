// Account password hashing, in one place: the engine's accounts (src/accounts.mjs) and automated set-ups that create a
// launchpad owner from a password hash (scripts/tenant-provision.mjs) must produce the same records.
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
export const HASH_OPTIONS = Object.freeze({ N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
export function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128) throw new Error('Password must contain 10–128 characters.');
  return value;
}
/** { algorithm: 'scrypt-v1', salt, hash } (base64): a 32-byte salt and a 64-byte key. */
export async function passwordHash(password) {
  const salt = randomBytes(32);
  const hash = await scrypt(validatePassword(password), salt, 64, HASH_OPTIONS);
  return { algorithm: 'scrypt-v1', salt: salt.toString('base64'), hash: hash.toString('base64') };
}
export async function verifyPassword(password, record) {
  if (record?.algorithm !== 'scrypt-v1') throw new Error('Account password data is damaged.');
  const expected = Buffer.from(record.hash, 'base64'), salt = Buffer.from(record.salt, 'base64');
  if (expected.length !== 64 || salt.length !== 32) throw new Error('Account password data is damaged.');
  const actual = await scrypt(password, salt, expected.length, HASH_OPTIONS);
  return timingSafeEqual(actual, expected);
}
