// Transfer hook rules (v71.28, rules v2) readiness check for operators. Reads the
// host environment (or an env file given as the first argument), validates
// LAUNCHPAD_HOOK_PROGRAM_ID, asks the RPC whether that account is an executable
// program (skipped when no RPC answers), and prints the accounts the hook
// program derives for a sample mint under a sample rule set: the HookConfig,
// the ExtraAccountMetaList (with its shape and size), the BlockList PDA, a
// sample wallet's WalletState and AllowEntry. It never signs, sends or prints a
// secret. Run with:
//   node scripts/check-hook-readiness.mjs [/etc/launchpad.env] [--mint <base58>] [--wallet <base58>] [--rules a,b,c] [--offline]
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { HOOK_RULES, HOOK_MAX_RULES, HOOK_LIMITS, HOOK_PARAM_COUNT, HOOK_APP_SETTINGS, hookRuleById, hookRuleByApp, hookRuleParams, describeHookAppMark } from '../public/hook-catalog.mjs';
import { meteoraHookProgramId, meteoraHookAppMark } from '../src/meteora-service.mjs';

const args = process.argv.slice(2), valued = ['--mint', '--wallet', '--rules'], envFile = args.find((arg, i) => !arg.startsWith('--') && !valued.includes(args[i - 1]));
if (args.includes('--help') || args.includes('-h')) { console.log('usage: node scripts/check-hook-readiness.mjs [/etc/launchpad.env] [--mint <base58>] [--wallet <base58>] [--rules id,id,...] [--offline]'); process.exit(0); }
const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const env = { ...process.env };
if (envFile) { for (const line of readFileSync(envFile, 'utf8').split('\n')) { const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line); if (match && !line.trim().startsWith('#')) env[match[1]] = match[2].replace(/^["']|["']$/g, ''); } }
let failed = 0;
const check = (condition, message) => { if (!condition) { failed++; console.error('FAIL ' + message); } else console.log('ok   ' + message); };
const note = message => console.log('     ' + message);
const sample = seed => new PublicKey(createHash('sha256').update('curve-transfer-hook:' + seed).digest());

console.log(`Transfer hook readiness (${envFile || 'process environment'})`);
let programId = null;
try { programId = meteoraHookProgramId(env.LAUNCHPAD_HOOK_PROGRAM_ID); } catch (error) { check(false, error.message); }
if (programId === null && !failed) { check(false, 'LAUNCHPAD_HOOK_PROGRAM_ID is unset: transfer hook rules are off and every hooked launch request answers 503'); }
else if (programId) check(true, `LAUNCHPAD_HOOK_PROGRAM_ID ${programId} is a base58 address`);
note(`catalogue: ${HOOK_RULES.length} rules (kinds 1–${Math.max(...HOOK_RULES.map(r => r.kind))}), at most ${HOOK_MAX_RULES} per coin, ${HOOK_PARAM_COUNT} parameters each, allowlist batches of ${HOOK_LIMITS.allowlistBatch}, blocklist batches of ${HOOK_LIMITS.blocklistBatch} (≤ ${HOOK_LIMITS.blocklistTotal} wallets)`);

// App-only rules (v71.36): each is offered only when its app's mark is named (signer:<wallet>, program:<id> or program:<id>:account:<slot>);
// the key must be a base58 address other than the hook program.
const marks = {};
for (const [app, setting] of Object.entries(HOOK_APP_SETTINGS)) {
  const rule = hookRuleByApp(app);
  try { const mark = meteoraHookAppMark(env[setting], setting); marks[app] = mark; if (mark) check(mark.key !== programId, `${setting} = ${String(env[setting]).trim()} — ${describeHookAppMark(mark, rule.appName)} (${rule.name} is offered)`); else note(`${setting} is unset: ${rule.name} is not offered (greyed out on the launch page)`); }
  catch (error) { check(false, error.message); }
}

if (programId && !args.includes('--offline')) {
  const rpcUrl = env.LAUNCHPAD_PUBLIC_RPC_URL || 'https://api.mainnet-beta.solana.com';
  try {
    const { Connection } = await import('@solana/web3.js');
    const connection = new Connection(rpcUrl, 'finalized'), info = await connection.getAccountInfo(new PublicKey(programId), 'finalized');
    check(!!info, `program account exists on ${new URL(rpcUrl).host}`);
    if (info) check(info.executable === true, `program account is executable (owner ${info.owner.toBase58()})`);
  } catch (error) { note(`RPC check skipped: ${error.message.split('\n')[0]}`); }
} else if (programId) note('RPC check skipped (--offline)');

if (programId) {
  const mint = option('--mint') ? new PublicKey(option('--mint')) : sample('mint'), wallet = option('--wallet') ? new PublicKey(option('--wallet')) : sample('wallet');
  const ruleIds = (option('--rules') || 'blocklist,sniper_fee_cap,max_per_wallet').split(',').map(s => s.trim()).filter(Boolean);
  try {
    const hooks = await import('../src/hooks/program.mjs'), program = new PublicKey(programId), show = value => new PublicKey(value.address ?? value).toBase58();
    const items = ruleIds.map(id => { const item = hookRuleById(id); if (!item) throw Error(`unknown rule "${id}"`); return item; });
    // App-only rules (v71.36) take the app's mark from the environment (LAUNCHPAD_HOOK_FOMO_MARK / LAUNCHPAD_HOOK_PUMP_APP_MARK); a sample signer mark stands in when it is unset.
    const appMark = item => { const mark = marks[item.app]; if (mark) return { kind: mark.kind, keyBytes: new PublicKey(mark.key).toBytes(), index: mark.index }; note(`${item.id}: ${HOOK_APP_SETTINGS[item.app]} is not set on this host (the rule is not offered); packing a sample signer mark`); return { kind: 'signer', keyBytes: sample('app:' + item.app).toBytes(), index: 0 }; };
    const rules = items.map(item => ({ kind: item.kind, params: hookRuleParams(item.id, {}, { gateDecimals: 6, ...(item.route === 'app' ? { appMark: appMark(item) } : {}) }) }));
    const shape = hooks.hookShape(rules);
    const needs = Object.entries(shape).filter(([key, value]) => key !== 'count' && value).map(([key]) => key);
    note(`sample rules: ${items.map(r => `${r.id} (kind ${r.kind}, ${r.route === 'curve' ? 'Launchpad route' : r.route === 'app' ? r.appName + ' only' : 'any route'})`).join(', ')}`);
    note(`list shape: ${shape.count} entr${shape.count === 1 ? 'y' : 'ies'} (config${needs.length ? ' + ' + needs.join(' + ') : ''}), ${hooks.extraMetasSize(shape)} bytes; Execute carries ${hooks.hookShapePositions(shape).accounts} accounts`);
    note(`derived for ${option('--mint') ? 'mint' : 'sample mint'} ${mint.toBase58()}:`);
    note(`  HookConfig            ${show(hooks.hookConfigPda(program, mint))} (${hooks.HOOK_CONFIG_SIZE} bytes)`);
    note(`  ExtraAccountMetaList  ${show(hooks.extraMetasPda(program, mint))}`);
    note(`  BlockList             ${show(hooks.blocklistPda(program, mint))} (${hooks.BLOCKLIST_SIZE} bytes when created)`);
    note(`  WalletState (${option('--wallet') ? 'wallet' : 'sample wallet'} ${wallet.toBase58()}) ${show(hooks.walletStatePda(program, mint, wallet))} (${hooks.WALLET_STATE_SIZE} bytes)`);
    note(`  AllowEntry  (same wallet) ${show(hooks.allowEntryPda(program, mint, wallet))} (${hooks.ALLOW_ENTRY_SIZE} bytes)`);
    const data = hooks.initConfigData({ exempt: [wallet], venues: [sample('vault')], gateMint: shape.holderGated ? sample('gate') : null, gateTokenProgram: shape.holderGated ? hooks.TOKEN_2022_PROGRAM_ID : null, titheRecipient: rules.some(r => r.kind === hooks.KIND.tithe) ? sample('tithe') : null, swapBaseAmount: '800000000000000', rules });
    note(`InitConfig payload for these rules: ${data.length} bytes (+1 tag); every catalogue parameter encodes as a u64`);
    note(`encoder: ${Object.keys(hooks.HOOK_ERRORS || {}).length} named hook program errors (${Object.keys(hooks.HOOK_ERRORS).filter(c => c < 6100).length} rules + ${Object.keys(hooks.HOOK_ERRORS).filter(c => c >= 6100).length} structural), hookErrorMessage ${typeof hooks.hookErrorMessage === 'function' ? 'present' : 'missing'}`);
    check(true, 'src/hooks/program.mjs derives the hook accounts and encodes the sample rules');
  } catch (error) { check(false, 'src/hooks/program.mjs could not derive the hook accounts: ' + error.message); }
  note('a hooked launch takes three wallet approvals: curve configuration, hook setup (InitConfig + ExtraAccountMetaList [+ blocklist chunks]), coin creation');
}

console.log(failed ? `Transfer hook readiness: ${failed} problem(s).` : 'Transfer hook readiness: all checks passed.');
process.exitCode = failed ? 1 : 0;
