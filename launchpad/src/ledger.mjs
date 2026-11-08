import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export class Ledger {
  constructor(path) { this.path = path; this.data = { version: 1, lots: [], pending: [], seen: [], events: [], trades: 0, feeReceipts: [] }; this.writes = Promise.resolve(); }
  async load() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      if (value.version !== 1 || !['lots', 'pending', 'seen', 'events'].every(k => Array.isArray(value[k]))) throw new Error('Invalid ledger format');
      if (value.feeReceipts !== undefined && !Array.isArray(value.feeReceipts)) throw new Error('Invalid platform fee ledger');
      this.data = { ...value, feeReceipts: value.feeReceipts || [] };
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('Position ledger is unreadable. Restore data from a backup; refusing to discard positions.'); }
    return this;
  }
  async save() {
    const snapshot = JSON.stringify(this.data, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
    const write = this.writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(this.path + '.tmp', snapshot, { mode: 0o600 });
      await rename(this.path + '.tmp', this.path);
    });
    this.writes = write;
    return write;
  }
  async remember(key) {
    if (this.data.seen.includes(key)) return false;
    this.data.seen.push(key);
    if (this.data.seen.length > 30000) this.data.seen.splice(0, this.data.seen.length - 30000);
    await this.save();
    return true;
  }
  addEvent(event) { this.data.events.unshift(event); this.data.events.length = Math.min(400, this.data.events.length); }
}
