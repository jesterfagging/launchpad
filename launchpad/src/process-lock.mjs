import { open, readFile, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

async function processStart(pid) {
  try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]; } catch { return null; }
}

// A previous Android child may still be draining sent transactions after its
// Java parent closes. Never open the same ledger until that child has exited.
export async function acquireProcessLock(path, waitMs = 30000) {
  const owner = JSON.stringify({ pid: process.pid, start: await processStart(process.pid), nonce: randomUUID() });
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      const file = await open(path, 'wx', 0o600);
      await file.writeFile(owner); await file.close();
      return async () => { try { if (await readFile(path, 'utf8') === owner) await unlink(path); } catch {} };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      try { previous = await readFile(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      let pid, start;
      try { const parsed = JSON.parse(previous); pid = typeof parsed === 'number' ? parsed : parsed.pid; start = parsed.start; } catch {}
      let alive = true;
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (e) {
          // App-private Android journals cannot belong to another UID. A reused
          // PID from another app after reboot is not this app's previous engine.
          if (e.code === 'ESRCH' || (process.platform === 'android' && e.code === 'EPERM')) alive = false;
        }
        const currentStart = await processStart(pid);
        if (start && currentStart && start !== currentStart) alive = false;
      }
      if (!alive) { if (await readFile(path, 'utf8').catch(() => '') === previous) await unlink(path).catch(() => {}); continue; }
      if (Date.now() >= deadline) throw new Error('The previous engine is still stopping. Wait a moment, then reopen Launchpad.');
      await delay(200);
    }
  }
}
