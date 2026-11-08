// Standalone Android service entry. No runtime download and no automatic trading.
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { Ledger } from './ledger.mjs';
import { Engine } from './engine.mjs';
import { PortfolioEngine } from './portfolio.mjs';
import { createApp } from './app.mjs';
import { acquireProcessLock } from './process-lock.mjs';
import { installAndroidDns } from './android-dns.mjs';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (!/^[a-f0-9]{64}$/.test(config.accessToken) || !/^[a-f0-9]{64}$/.test(config.controlToken)) throw Error('Invalid Android session.');
if (config.nativeDns === true) installAndroidDns();
await mkdir(config.dataRoot, { recursive: true, mode: 0o700 });
const releaseLock = await acquireProcessLock(join(config.dataRoot, 'process.lock'));
const live = await new Ledger(join(config.dataRoot, 'live.json')).load();
const paper = await new Ledger(join(config.dataRoot, 'paper.json')).load();
const engine = new Engine({ live, paper });
const portfolioLive = await new Ledger(join(config.dataRoot, 'portfolio-live.json')).load();
const portfolioPaper = await new Ledger(join(config.dataRoot, 'portfolio-paper.json')).load();
const portfolio = new PortfolioEngine({ live: portfolioLive, paper: portfolioPaper });
const server = createApp(engine, config.controlToken, { accessToken: config.accessToken, portfolio });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
await writeFile(config.readyFile + '.tmp', JSON.stringify({ port: server.address().port }), { mode: 0o600 });
await rename(config.readyFile + '.tmp', config.readyFile);
let exiting = false;
async function shutdown() {
  if (exiting) return;
  exiting = true;
  engine.stop(); portfolio.stop();
  const deadline = Date.now() + 25000;
  while ((engine.state !== 'stopped' || portfolio.state !== 'stopped') && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  await Promise.all([live.save(), paper.save(), portfolioLive.save(), portfolioPaper.save()]);
  await releaseLock();
  server.closeAllConnections(); server.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
// The native service owns this pipe. Parent death stops new trades even if the
// OS leaves the child alive long enough to reconcile transactions already sent.
process.stdin.resume();
process.stdin.on('end', shutdown);
