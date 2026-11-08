// Read-only report of the newest Pump.fun launches on this host. For each launch
// it prints the state, the journaled transactions (kind, state, signature and
// error) and the events. Then it runs the read-only readiness check
// (check-pump-classic.mjs) for the newest launch's pair and creator fee, with its
// funding wallet standing in as the payer. That check simulates the setup and
// creation transactions and prints Pump's program logs when one fails. On another
// pair it also checks a 1-unit dev buy (the funding wallet must hold 1 of the
// pair asset for that simulation) and the SOL route Launchpad buys the pair asset with.
//
// Nothing is signed or sent, the database is opened read-only, and no key or
// signed transaction is printed. Run on the VPS:
//   sudo node scripts/pump-classic-report.mjs [/etc/launchpad.env] [--launches 3] [--symbol DEMO] [--no-check]
// --symbol limits the report to coins with that ticker. Each launch shows its latest 60 operations and events.
// A copy outside the app directory works too; it uses APP (default /opt/launchpad/app).
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2), flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const envFile = args.find((arg, i) => !arg.startsWith('--') && !args[i - 1]?.startsWith('--')) || '/etc/launchpad.env';
const here = dirname(fileURLToPath(import.meta.url));
const app = existsSync(join(here, 'check-pump-classic.mjs')) ? resolve(here, '..') : resolve(process.env.APP || '/opt/launchpad/app');
const env = {};
if (existsSync(envFile)) for (const line of readFileSync(envFile, 'utf8').split('\n')) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line); if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2'); }
const setting = name => env['LAUNCHPAD_' + name] ?? process.env['LAUNCHPAD_' + name] ?? '';
const dataDir = resolve(setting('DATA_DIR') || join(app, 'launchpad-data'));
const dbPath = setting('PUMP_CLASSIC_DB_PATH') || join(dataDir, 'pump-classic', 'pump-classic.sqlite');
const rpc = setting('PUBLIC_RPC_URL'); let rpcHost = '(not set)'; try { rpcHost = new URL(rpc).host; } catch {}
const time = ms => Number.isFinite(Number(ms)) && Number(ms) > 0 ? new Date(Number(ms)).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '-';
const sol = lamports => { try { const n = BigInt(String(lamports || '0')); return (Number(n) / 1e9).toFixed(9).replace(/\.?0+$/, '') || '0'; } catch { return String(lamports); } };
const json = text => { try { return JSON.parse(text); } catch { return null; } };
const units = (raw, decimals) => { try { const n = BigInt(String(raw || '0')), scale = 10n ** BigInt(decimals), frac = (n % scale).toString().padStart(Number(decimals), '0').replace(/0+$/, ''); return (n / scale).toString() + (frac ? '.' + frac : ''); } catch { return String(raw); } };

console.log(`Pump.fun launch report · env ${envFile} · database ${dbPath} · RPC host ${rpcHost}`);
if (!existsSync(dbPath)) { console.error('The Pump.fun database does not exist at that path.'); process.exit(1); }
const db = new DatabaseSync(dbPath, { readOnly: true });
const limit = Math.max(1, Math.min(20, Number(flag('--launches')) || 3));
const symbol = flag('--symbol');
const launches = symbol ? db.prepare('SELECT * FROM launches WHERE upper(symbol) = upper(?) ORDER BY created_at DESC LIMIT ?').all(String(symbol).replace(/^\$/, ''), limit) : db.prepare('SELECT * FROM launches ORDER BY created_at DESC LIMIT ?').all(limit);
if (!launches.length) console.log(symbol ? `No Pump.fun launch with the ticker ${symbol}.` : 'No Pump.fun launches yet.');
for (const l of launches) {
  const plan = json(l.plan) || {}, quote = json(l.quote) || {};
  console.log(`\n=== ${l.id} · ${l.mode} · ${l.symbol} · created ${time(l.created_at)} · policy ${l.policy_version}`);
  console.log(`state ${l.state}${l.state_reason ? ` (${l.state_reason})` : ''} · create attempts ${l.create_attempts}`);
  console.log(`pair ${l.quote_symbol} ${l.quote_mint} (${l.quote_kind}${l.quote_control ? ', quote control' : ''}) · creator fee ${l.creator_fee_bps} bps`);
  const solCoin = l.quote_mint === 'So11111111111111111111111111111111111111112', c = quote.conversion;
  console.log(`dev buy ${solCoin ? sol(l.dev_buy_lamports) + ' SOL' : (BigInt(l.dev_buy_lamports || '0') > 0n ? sol(l.dev_buy_lamports) + ' SOL for ' : '') + l.dev_buy_raw + ' raw ' + l.quote_symbol + (c ? ' (reviewed minimum)' : '')} · quoted tokens ${quote.tokens ?? '?'}${quote.expectedTokens ? ' (about ' + quote.expectedTokens + ')' : ''} · fee ${quote.feeBps ?? '?'} bps`);
  if (c) console.log(`pair purchase: expected ${c.expectedRaw} raw, route minimum ${c.routeMinimumRaw ?? '?'}, reviewed ${c.minimumRaw}${c.prepareFailures ? ' · not sent ' + c.prepareFailures + 'x' : ''}${c.waitFailures ? ' · waited on the network ' + c.waitFailures + 'x' : ''}${c.receipt ? ` · bought ${c.receipt.outputRaw} raw for ${sol(c.receipt.inputLamports)} SOL (cost ${sol(c.receipt.costLamports)}) at slot ${c.receipt.slot}` : ''}${c.unwind ? ` · sold back: ${c.unwind.state}${c.unwind.outputLamports ? ' for ' + sol(c.unwind.outputLamports) + ' SOL' : ''}` : ''}`);
  console.log(`funding plan ${sol(plan.funding?.totalLamports)} SOL (dev buy ${sol(plan.funding?.devBuyLamports)}, setup ${sol(plan.funding?.setupBudgetLamports)}${plan.funding?.conversionBudgetLamports ? ', purchase ' + sol(plan.funding.conversionBudgetLamports) : ''}, collector ${sol(plan.funding?.collectorGasLamports)}, option ${sol(plan.funding?.modeGasLamports)}, seed ${sol(plan.funding?.seedLamports)})`);
  console.log(`funded ${sol(l.funded_lamports)} SOL${c || solCoin ? '' : ` + ${l.funded_quote} raw ${l.quote_symbol}`} at ${time(l.funded_at)} · funding signature ${l.funding_signature || '-'}`);
  console.log(`developer ${l.developer_wallet} · launch wallet ${l.launch_wallet} · mint ${l.mint}`);
  console.log(`refund ${l.refund_state} ${l.refund_signature || ''} · pair refund ${l.quote_refund_state} ${l.quote_refund_signature || ''} · created ${l.create_signature || '-'} · delivery ${l.delivery_state} · dev tokens ${l.dev_tokens}`);
  if (l.mode === 'holders') {
    // v71.24: holder rewards are paid in the pair asset; the open payout, the last result and the latest cycles.
    const cursor = name => db.prepare('SELECT value FROM cursors WHERE launch_id = ? AND name = ?').get(l.id, name)?.value || '';
    const q = db.prepare("SELECT credited, converted FROM quote_balances WHERE launch_id = ? AND role = 'rewards'").get(l.id), b = db.prepare("SELECT credited, debited, costs FROM balances WHERE launch_id = ? AND role = 'rewards'").get(l.id);
    console.log(`holder rewards: ${solCoin ? `credited ${sol(b?.credited)} SOL · paid ${sol(b?.debited)} SOL · network costs ${sol(b?.costs)} SOL` : `received ${units(q?.credited, l.quote_decimals)} ${l.quote_symbol} · paid or sold ${units(q?.converted, l.quote_decimals)} ${l.quote_symbol} · SOL from sales ${sol(b?.credited)} · SOL costs ${sol(b?.costs)}`}`);
    const open = json(cursor('holder-payout')), last = json(cursor('holder-payout-last'));
    if (open) console.log(`holder payout open: ${open.source} · stage ${open.stage}${open.waiting ? ' · waiting: ' + open.waiting : open.note ? ' · ' + open.note : ''} · since ${time(open.at)}`);
    if (last) console.log(`last holder payout ${time(last.at)}: ${last.state}${last.reason ? ' · ' + last.reason : ''}`);
    for (const c of db.prepare('SELECT state, amount, paid, payouts, created_at FROM reward_cycles WHERE launch_id = ? ORDER BY created_at DESC LIMIT 3').all(l.id)) {
      const payouts = json(c.payouts) || [], token = payouts.some(p => /^[1-9]\d*$/.test(String(p.tokens || '')));
      console.log(`  reward cycle ${time(c.created_at)} ${c.state} · paid ${token ? units(c.paid, l.quote_decimals) + ' ' + l.quote_symbol : sol(c.paid) + ' SOL'} of ${token ? units(c.amount, l.quote_decimals) : sol(c.amount)} · ${payouts.length} holders`);
    }
  }
  const opCount = db.prepare('SELECT count(*) AS n FROM operations WHERE launch_id = ?').get(l.id).n, eventCount = db.prepare('SELECT count(*) AS n FROM events WHERE launch_id = ?').get(l.id).n;
  if (opCount > 60) console.log(`  (${opCount - 60} earlier operations not shown)`);
  for (const op of db.prepare('SELECT kind, state, signature, error, attempts, receipt, created_at FROM operations WHERE launch_id = ? ORDER BY created_at DESC LIMIT 60').all(l.id).reverse()) {
    const receipt = json(op.receipt), slot = receipt?.slot ?? receipt?.expiryCheck?.slot;
    console.log(`  op ${time(op.created_at)} ${op.kind} ${op.state} ${op.signature || '(unsigned)'}${slot ? ' slot ' + slot : ''}${op.attempts ? ' sent ' + op.attempts + 'x' : ''}${op.error ? ' · ' + op.error : ''}`);
  }
  if (eventCount > 60) console.log(`  (${eventCount - 60} earlier events not shown)`);
  for (const e of db.prepare('SELECT kind, title, body, signature, at FROM events WHERE launch_id = ? ORDER BY at DESC LIMIT 60').all(l.id).reverse()) console.log(`  event ${time(e.at)} ${e.kind} · ${e.title}${e.body ? ' · ' + e.body : ''}`);
}
db.close();

if (launches.length && !args.includes('--no-check')) {
  const l = launches[0], checker = join(app, 'scripts', 'check-pump-classic.mjs'), runs = [];
  const pair = l.quote_mint !== 'So11111111111111111111111111111111111111112';
  const fee = l.creator_fee_bps ? ['--creator-fee', String(l.creator_fee_bps)] : [];
  if (pair) {
    // Without a dev buy; then with a 1-unit dev buy (the funding wallet must hold 1 of the pair asset) and the SOL route a real dev buy takes.
    runs.push(['--quote', l.quote_mint, '--dev-buy', '0', '--payer', l.developer_wallet, ...fee]);
    runs.push(['--quote', l.quote_mint, '--dev-buy', '1', '--dev-buy-sol', '0.05', '--payer', l.developer_wallet, ...fee]);
  }
  runs.push(['--dev-buy', '0.01', '--payer', l.developer_wallet]);
  for (const extra of runs) {
    console.log(`\n--- readiness check: node scripts/check-pump-classic.mjs ${envFile} ${extra.join(' ')}`);
    const r = spawnSync(process.execPath, [checker, envFile, ...extra], { cwd: app, encoding: 'utf8', timeout: 180000 });
    process.stdout.write(r.stdout || ''); process.stdout.write(r.stderr || ''); if (r.error) console.log('(the check could not run: ' + r.error.message + ')');
  }
}
console.log('\nNothing was signed or sent.');
