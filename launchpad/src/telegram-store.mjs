import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { mkdir, readFile, open, rename, unlink, readdir, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { Ledger } from './ledger.mjs';

const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
export function userId(value) {
  if (!Number.isSafeInteger(Number(value)) || !/^[1-9]\d{0,15}$/.test(String(value))) throw new Error('Invalid Telegram user.');
  return String(value);
}
export function userKey(master, id) {
  return Buffer.from(hkdfSync('sha256', master, Buffer.from('relay-telegram-v1'), Buffer.from(userId(id)), 32));
}
export async function atomicWrite(path, bytes) {
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  let file;
  try {
    file = await open(temp, 'wx', 0o600);
    await file.writeFile(bytes); await file.sync(); await file.close(); file = null;
    await rename(temp, path);
  } finally { await file?.close().catch(() => {}); await unlink(temp).catch(() => {}); }
}
export async function loadMasterKey(dir, { keyFile } = {}) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(dir, 0o700);
  if (keyFile) {
    // An explicit key path is never created, replaced or silently ignored.
    const file = await open(keyFile, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== 32 || process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error('External account key must be a 32-byte file readable only by its owner.');
      return await file.readFile();
    } finally { await file.close(); }
  }
  const path = join(dir, 'master.key');
  try {
    const key = await readFile(path);
    if (key.length !== 32) throw new Error('Telegram encryption key is damaged. Restore the key and data together.');
    if (process.platform !== 'win32') await chmod(path, 0o600);
    return key;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if ((await readdir(dir)).some(name => name.endsWith('.enc') || name === 'users')) throw new Error('Telegram encryption key is missing. Restore it; existing data will not be reset.');
    const key = randomBytes(32), file = await open(path, 'wx', 0o600);
    try { await file.writeFile(key); await file.sync(); } finally { await file.close(); }
    return key;
  }
}

// Authenticated encryption binds every file to both its user and purpose.
// The server needs master.key to decrypt; encryption does not hide keys from its operator.
export class TelegramStore {
  constructor(dir, key, context = 'host') { this.dir = dir; this.key = Buffer.from(key); this.context = context; this.writes = new Map(); }
  path(name) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Invalid storage name.');
    return join(this.dir, `${name}.enc`);
  }
  async read(name, fallback = null) {
    try {
      const value = JSON.parse(await readFile(this.path(name), 'utf8'));
      if (value.v !== 1) throw new Error('version');
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.iv, 'base64'));
      decipher.setAAD(Buffer.from(`${this.context}:${name}:v1`));
      decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return structuredClone(fallback);
      throw new Error('Encrypted Telegram data cannot be read. Restore the matching data and encryption key; no data was reset.');
    }
  }
  async write(name, value) {
    const path = this.path(name), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${this.context}:${name}:v1`));
    const data = Buffer.concat([cipher.update(json(value)), cipher.final()]);
    const bytes = json({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
    const job = (this.writes.get(name) || Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 }); await atomicWrite(path, bytes);
    });
    this.writes.set(name, job);
    try { await job; } finally { if (this.writes.get(name) === job) this.writes.delete(name); }
  }
}

export class TelegramLedger extends Ledger {
  constructor(store, mode) { super(null); this.store = store; this.mode = mode; }
  async load() {
    const value = await this.store.read(this.mode, this.data);
    if (value.version !== 1 || !['lots', 'pending', 'seen', 'events'].every(k => Array.isArray(value[k]))) throw new Error('Invalid encrypted position ledger.');
    if (value.feeReceipts !== undefined && !Array.isArray(value.feeReceipts)) throw new Error('Invalid encrypted platform fee ledger.');
    this.data = { ...value, feeReceipts: value.feeReceipts || [] }; return this;
  }
  async save() { return this.store.write(this.mode, this.data); }
}
