// Regenerates vendor/pump-idl/pump-classic-idl.json: the subset of Pump's official
// Anchor IDLs this integration uses, with the source commit and the SHA-256 of
// every source file recorded. Run against a checkout of
// https://github.com/pump-fun/pump-public-docs at the commit you reviewed:
//   node scripts/vendor-pump-idl.mjs /path/to/pump-public-docs [--check]
// --check only compares the generated subset with the vendored file.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const SELECT = {
  pump: {
    instructions: ['buy_exact_quote_in_v2', 'buy_v2', 'collect_creator_fee_v2', 'create_v2', 'distribute_creator_fees_v2', 'get_minimum_distributable_fee', 'init_user_volume_accumulator', 'sell_v2'],
    accounts: ['BondingCurve', 'FeeConfig', 'Global', 'QuoteControl', 'SharingConfig'],
    events: ['CollectCreatorFeeEvent', 'CompleteEvent', 'CompletePumpAmmMigrationEvent', 'CreateEvent', 'DistributeCreatorFeesEvent', 'MinimumDistributableFeeEvent', 'TradeEvent'],
  },
  pump_amm: {
    instructions: ['buy_exact_quote_in', 'deposit', 'sell', 'transfer_creator_fees_to_pump_v2', 'withdraw'],
    accounts: ['FeeConfig', 'GlobalConfig', 'Pool'],
    events: ['BuyEvent', 'DepositEvent', 'SellEvent', 'WithdrawEvent'],
  },
  pump_fees: {
    instructions: ['create_fee_sharing_config', 'update_fee_shares_v2'],
    accounts: ['SharingConfig'],
    events: ['CreateFeeSharingConfigEvent', 'UpdateFeeSharesEvent'],
  },
};
const [repo, flag] = process.argv.slice(2);
if (!repo) { console.error('usage: node scripts/vendor-pump-idl.mjs /path/to/pump-public-docs [--check]'); process.exit(2); }
const definedNames = (value, out = new Set()) => { if (Array.isArray(value)) value.forEach(v => definedNames(v, out)); else if (value && typeof value === 'object') { if (value.defined) out.add(typeof value.defined === 'string' ? value.defined : value.defined.name); Object.values(value).forEach(v => definedNames(v, out)); } return out; };
const files = {}, programs = {};
for (const [name, pick] of Object.entries(SELECT)) {
  const path = `idl/${name}.json`, bytes = readFileSync(join(repo, path)), idl = JSON.parse(bytes);
  files[path] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  const take = (list, names, label) => names.map(n => list.find(x => x.name === n) || (() => { throw Error(`${name}: missing ${label} ${n}`); })());
  const instructions = take(idl.instructions, pick.instructions, 'instruction'), accounts = take(idl.accounts, pick.accounts, 'account'), events = take(idl.events, pick.events, 'event');
  const wanted = new Set([...pick.accounts, ...pick.events, ...definedNames(instructions)]), types = [];
  for (let changed = true; changed;) { changed = false; for (const t of idl.types) if (wanted.has(t.name) && !types.includes(t)) { types.push(t); for (const n of definedNames(t)) if (!wanted.has(n)) { wanted.add(n); changed = true; } } }
  programs[name] = { address: idl.address, instructions, accounts, events, types: types.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) };
}
const commit = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%H'], { encoding: 'utf8' }).trim(), committed = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%cI'], { encoding: 'utf8' }).trim();
const out = JSON.stringify({ source: { repository: 'https://github.com/pump-fun/pump-public-docs', commit, committed, files }, programs });
const target = new URL('../vendor/pump-idl/pump-classic-idl.json', import.meta.url);
if (flag === '--check') { const same = readFileSync(target, 'utf8') === out; console.log(same ? 'vendored IDL subset is current' : 'vendored IDL subset differs'); process.exit(same ? 0 : 1); }
writeFileSync(target, out); console.log(`wrote ${out.length} bytes from ${commit}`);
