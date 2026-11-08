import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { acquireProcessLock } from './process-lock.mjs';
import { MANUAL_PROTOCOL_MINT, MANUAL_PROTOCOL_HISTORY } from './protocol-manual-history.mjs';

// This journal is display-only. It never touches treasury balances, budgets,
// signing keys, or transaction submission. All quantities are integer base units.
const STORE = 'admin-burn-history', MAX_ROWS = 20000, MAX_INSTRUCTIONS = 5000;
const BURN_OWNERS = Symbol('verified-burn-owners');
const MINT = MANUAL_PROTOCOL_MINT, SOL = 'So11111111111111111111111111111111111111112';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const tokenProgram = program => program === TOKEN || program === TOKEN_2022;
const uint = value => typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
const signature = value => { try { return typeof value === 'string' && value.length >= 64 && value.length <= 88 && bs58.decode(value).length === 64; } catch { return false; } };
const publicKey = value => { try { return typeof value === 'string' && new PublicKey(value).toBase58() === value; } catch { return false; } };
const key = value => typeof value === 'string' ? value : value?.toBase58?.() || '';
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode, publicBurnHistoryError: true }); };
const identity = row => `${row.kind}:${row.signature}`;
const empty = () => ({ version: 1, history: [] });
const discriminator = name => createHash('sha256').update(`global:${name}`).digest('hex').slice(0, 16);
const swaps = new Map([
  ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', ['route','route_v2','shared_accounts_route','shared_accounts_route_v2','exact_out_route','shared_accounts_exact_out_route','route_with_token_ledger','shared_accounts_route_with_token_ledger']],
  ['LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', ['buy_exact_in','buy_exact_out']],
  ['CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', ['swap_base_input','swap_base_output']],
  ['CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', ['swap','swap_v2']],
  ['cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', ['swap','swap2']],
  ['LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', ['swap','swap2','swap_exact_out','swap_exact_out2']],
  ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', ['buy','buy_exact_quote_in']],
].map(([program, names]) => [program, new Set(names.map(discriminator))]));

export function burnHistorySignature(value, { optional = false, label = 'Burn' } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || value.length > 300) fail(`${label} must be a Solscan transaction link or transaction signature.`);
  let input = value.trim();
  if (!input && optional) return null;
  if (input.startsWith('https://')) {
    let url; try { url = new URL(input); } catch { fail(`${label} link is invalid.`); }
    if (!['solscan.io','www.solscan.io'].includes(url.hostname) || url.port || url.username || url.password || !/^\/tx\/[^/]+\/?$/.test(url.pathname)) fail(`${label} must be a Solscan transaction link.`);
    for (const cluster of url.searchParams.getAll('cluster')) if (!['mainnet-beta','mainnet'].includes(cluster)) fail('Only Solana mainnet transactions can be added.');
    input = url.pathname.split('/')[2];
  }
  if (!signature(input)) fail(`${label} must be a Solscan transaction link or transaction signature.`);
  return input;
}

function instructionBytes(instruction) {
  try { return typeof instruction.data === 'string' && instruction.data.length <= 20000 ? Buffer.from(bs58.decode(instruction.data)) : null; } catch { return null; }
}
function isSwap(instruction) {
  const program = key(instruction.programId), bytes = instructionBytes(instruction);
  if (!bytes) return false;
  if (program === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') return bytes.length === 17 && [9,11].includes(bytes[0]);
  return bytes.length >= 8 && swaps.get(program)?.has(bytes.subarray(0, 8).toString('hex')) === true;
}
function instructions(tx) {
  const tops = tx.transaction.message.instructions, groups = new Map();
  if (!Array.isArray(tops) || !Array.isArray(tx.meta.innerInstructions || [])) fail('Transaction instructions are unavailable.');
  for (const group of tx.meta.innerInstructions || []) {
    if (!Number.isSafeInteger(group.index) || group.index < 0 || group.index >= tops.length || groups.has(group.index) || !Array.isArray(group.instructions)) fail('Transaction instructions are incomplete.');
    groups.set(group.index, group.instructions);
  }
  const rows = [];
  for (let index = 0; index < tops.length; index++) {
    const top = tops[index], stack = [false, isSwap(top)];
    rows.push({ instruction: top, swap: stack[1], group: index });
    for (const instruction of groups.get(index) || []) {
      const depth = instruction.stackHeight;
      let swap = stack[1];
      if (Number.isSafeInteger(depth) && depth >= 2 && depth <= 64) {
        stack.length = depth;
        swap = stack[depth - 1] === true || isSwap(instruction);
        stack[depth] = swap;
      }
      rows.push({ instruction, swap, group: index });
      if (rows.length > MAX_INSTRUCTIONS) fail('Transaction exceeds the supported instruction limit.');
    }
  }
  if (rows.length > MAX_INSTRUCTIONS) fail('Transaction exceeds the supported instruction limit.');
  return rows;
}
function decodedToken(instruction) {
  if (!tokenProgram(key(instruction.programId))) return null;
  if (instruction.parsed?.info && typeof instruction.parsed.type === 'string') return instruction.parsed;
  const bytes = instructionBytes(instruction), accounts = instruction.accounts?.map(key);
  if (!bytes || !accounts) return null;
  if (bytes[0] === 8 && bytes.length === 9 && accounts.length >= 3) return { type: 'burn', info: { account: accounts[0], mint: accounts[1], authority: accounts[2], amount: bytes.readBigUInt64LE(1).toString() } };
  if (bytes[0] === 15 && bytes.length === 10 && accounts.length >= 3) return { type: 'burnChecked', info: { account: accounts[0], mint: accounts[1], authority: accounts[2], tokenAmount: { amount: bytes.readBigUInt64LE(1).toString(), decimals: bytes[9] } } };
  if (bytes[0] === 3 && bytes.length === 9 && accounts.length >= 3) return { type: 'transfer', info: { source: accounts[0], destination: accounts[1], authority: accounts[2], amount: bytes.readBigUInt64LE(1).toString() } };
  if (bytes[0] === 12 && bytes.length === 10 && accounts.length >= 4) return { type: 'transferChecked', info: { source: accounts[0], mint: accounts[1], destination: accounts[2], authority: accounts[3], tokenAmount: { amount: bytes.readBigUInt64LE(1).toString(), decimals: bytes[9] } } };
  return null;
}
function transactionFacts(tx) {
  const keys = tx.transaction.message.accountKeys;
  if (!Array.isArray(keys) || keys.length > 256) fail('Transaction account details are unavailable.');
  const addresses = keys.map(item => key(item.pubkey || item));
  if (!addresses.every(publicKey)) fail('Transaction account details are invalid.');
  const rows = instructions(tx), accounts = new Map();
  const put = (account, info) => {
    if (!publicKey(account) || !publicKey(info.mint) || !publicKey(info.owner)) fail('Transaction token ownership cannot be verified.');
    const prior = accounts.get(account);
    if (prior && (prior.mint !== info.mint || prior.owner !== info.owner)) fail('Transaction changes token ownership; its purchase amount cannot be verified.');
    accounts.set(account, { ...prior, ...info });
  };
  for (const side of ['pre','post']) {
    if (!Array.isArray(tx.meta[`${side}TokenBalances`])) fail('Transaction token balances are unavailable.');
    const seen = new Set();
    for (const balance of tx.meta[`${side}TokenBalances`]) {
      const amount = balance.uiTokenAmount?.amount, decimals = balance.uiTokenAmount?.decimals;
      if (!Number.isSafeInteger(balance.accountIndex) || seen.has(balance.accountIndex) || !uint(amount) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18 || !tokenProgram(balance.programId)) fail('Transaction token balances are invalid.');
      seen.add(balance.accountIndex);
      if (balance.mint === MINT && decimals !== 6 || balance.mint === SOL && decimals !== 9) fail('Transaction token decimals do not match LAUNCHPAD or SOL.');
      put(addresses[balance.accountIndex], { mint: balance.mint, owner: balance.owner, [side]: BigInt(amount), decimals });
    }
  }
  for (const {instruction} of rows) {
    const parsed = decodedToken(instruction), info = parsed?.info;
    if (['initializeAccount','initializeAccount2','initializeAccount3'].includes(parsed?.type)) put(info.account, { mint: info.mint, owner: info.owner });
    if (key(instruction.programId) === ATA && ['create','createIdempotent'].includes(instruction.parsed?.type)) {
      const data = instruction.parsed.info;
      put(data.account, { mint: data.mint, owner: data.wallet });
    }
  }
  return { rows, accounts, signers: new Set(keys.filter(item => item.signer === true).map(item => key(item.pubkey))) };
}
function burns(facts) {
  const result = [];
  for (const {instruction} of facts.rows) {
    const parsed = decodedToken(instruction), info = parsed?.info;
    if (!['burn','burnChecked'].includes(parsed?.type) || info.mint !== MINT) continue;
    const amount = parsed.type === 'burnChecked' ? info.tokenAmount?.amount : info.amount;
    if (!uint(amount) || parsed.type === 'burnChecked' && info.tokenAmount?.decimals !== 6 || !publicKey(info.account)) fail('LAUNCHPAD burn amount could not be verified.');
    const account = facts.accounts.get(info.account);
    if (account && account.mint !== MINT) fail('LAUNCHPAD burn account does not match the mint.');
    if (BigInt(amount) > 0n) result.push({ amount: BigInt(amount), account: info.account, wallet: account?.owner || (publicKey(info.authority) ? info.authority : null) });
  }
  return result;
}
function burnReceipt(tx, signatureValue) {
  const facts = transactionFacts(tx), found = burns(facts), amount = found.reduce((sum, row) => sum + row.amount, 0n);
  if (!amount) fail('This transaction has no completed burn of the official LAUNCHPAD token. Use the burn transaction link.');
  if (!uint(amount.toString())) fail('LAUNCHPAD burn amount exceeds the supported token range.');
  const wallets = new Set(found.map(row => row.wallet).filter(Boolean));
  return { ...receiptBase(tx, signatureValue), kind: 'burn', inputAmount: amount.toString(), outputAmount: '0', [BURN_OWNERS]: [...wallets], ...(wallets.size === 1 ? { wallet: [...wallets][0] } : {}) };
}
const buyError = () => fail('The exact SOL-to-LAUNCHPAD purchase could not be verified. Use its swap transaction link, or leave Buyback link empty to record the burn alone.');
function buyReceipt(tx, signatureValue) {
  const facts = transactionFacts(tx), burnt = burns(facts), candidates = [];
  for (const wallet of facts.signers) {
    const owned = [...facts.accounts].filter(([, account]) => account.owner === wallet);
    let acquired = owned.filter(([, account]) => account.mint === MINT).reduce((sum, [, account]) => sum + (account.post || 0n) - (account.pre || 0n), 0n);
    acquired += burnt.filter(row => facts.accounts.get(row.account)?.owner === wallet).reduce((sum, row) => sum + row.amount, 0n);
    if (acquired <= 0n) continue;
    let spent = 0n, grossReceived = 0n, valid = true;
    const inputGroups = new Set(), outputGroups = new Set();
    for (const {instruction, swap, group} of facts.rows) {
      const parsed = decodedToken(instruction), info = parsed?.info;
      // No extra minting, withheld-fee withdrawals, authority changes or other
      // token credits may be mixed into a purchase's net received quantity.
      if (tokenProgram(key(instruction.programId)) && !['transfer','transferChecked','transferCheckedWithFee','burn','burnChecked','initializeAccount','initializeAccount2','initializeAccount3','initializeImmutableOwner','getAccountDataSize','syncNative','closeAccount','approve','approveChecked','revoke'].includes(parsed?.type)) { valid = false; continue; }
      if (!['transfer','transferChecked','transferCheckedWithFee'].includes(parsed?.type)) continue;
      const source = facts.accounts.get(info.source), destination = facts.accounts.get(info.destination);
      if (source?.owner !== wallet && destination?.owner !== wallet) continue;
      if (source?.owner === wallet && destination?.owner === wallet) continue;
      const mint = info.mint || source?.mint || destination?.mint;
      if (source && source.mint !== mint || destination && destination.mint !== mint) { valid = false; continue; }
      const amount = info.tokenAmount?.amount ?? info.amount;
      if (!uint(amount)) { valid = false; continue; }
      if (mint === SOL) {
        if (!swap) { valid = false; continue; }
        spent += (source?.owner === wallet ? 1n : -1n) * BigInt(amount);
        if (source?.owner === wallet) inputGroups.add(group);
      } else if (mint === MINT) {
        if (!swap || source?.owner === wallet) { valid = false; continue; }
        grossReceived += BigInt(amount); outputGroups.add(group);
      } else { valid = false; }
    }
    // A received token balance alone could be a gift or mint. Require actual
    // swap output instructions and a corresponding WSOL debit in that call.
    if (owned.some(([, account]) => ![MINT,SOL].includes(account.mint) && (account.post || 0n) !== (account.pre || 0n))) valid = false;
    if (!outputGroups.size || [...outputGroups].some(group => !inputGroups.has(group)) || [...inputGroups].some(group => !outputGroups.has(group))) valid = false;
    if (valid && spent > 0n && grossReceived >= acquired && uint(spent.toString()) && uint(acquired.toString())) candidates.push({ wallet, spent, acquired });
  }
  if (candidates.length !== 1) buyError();
  const chosen = candidates[0];
  return { ...receiptBase(tx, signatureValue), kind: 'buy', wallet: chosen.wallet, inputAmount: chosen.spent.toString(), outputAmount: chosen.acquired.toString() };
}
function receiptBase(tx, signatureValue) {
  return { signature: signatureValue, slot: tx.slot, confirmedAt: tx.blockTime * 1000, commitment: 'finalized', mint: MINT, curveDecimals: 6, source: 'admin' };
}
function canonical(row, now) {
  if (!row || !['buy','burn'].includes(row.kind) || !signature(row.signature) || !uint(row.inputAmount) || BigInt(row.inputAmount) === 0n || !uint(row.outputAmount) || (row.kind === 'burn' ? row.outputAmount !== '0' : BigInt(row.outputAmount) === 0n) || !Number.isSafeInteger(row.confirmedAt) || row.confirmedAt <= 0 || row.confirmedAt > now + 5000 || !Number.isSafeInteger(row.slot) || row.slot <= 0 || row.commitment !== 'finalized' || row.mint !== MINT || row.curveDecimals !== 6 || row.source !== 'admin' || row.wallet !== undefined && !publicKey(row.wallet) || row.buybackSignature !== undefined && (row.kind !== 'burn' || !signature(row.buybackSignature)) || row.accountingSource !== undefined && row.accountingSource !== 'managed-treasury') fail('Saved burn history is invalid. Restore the original journal before adding records.', 503);
  return { kind: row.kind, signature: row.signature, inputAmount: row.inputAmount, outputAmount: row.outputAmount, confirmedAt: row.confirmedAt, slot: row.slot, commitment: 'finalized', mint: MINT, curveDecimals: 6, source: 'admin', ...(row.wallet ? {wallet: row.wallet} : {}), ...(row.buybackSignature ? {buybackSignature: row.buybackSignature} : {}), ...(row.accountingSource ? {accountingSource: row.accountingSource} : {}) };
}
function sameReceipt(a, b) { return ['kind','signature','inputAmount','outputAmount','confirmedAt','slot','wallet'].every(field => a[field] === b[field]); }
function sameAmounts(a, b) { return ['kind','signature','inputAmount','outputAmount'].every(field => a[field] === b[field]); }
function view(state) { return { status: 'available', complete: true, history: structuredClone(state.history).sort((a, b) => b.confirmedAt - a.confirmedAt || identity(a).localeCompare(identity(b))) }; }
async function bounded(work, ms = 15000) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Transaction lookup timed out. Try again shortly.'), {statusCode: 503, publicBurnHistoryError: true})), ms); timer.unref?.(); })]); }
  finally { clearTimeout(timer); }
}

export class AdminBurnHistory {
  constructor({ accounts, connectionFactory, now = Date.now } = {}) { Object.assign(this, { accounts, connectionFactory, now }); this.queue = Promise.resolve(); }
  async requireAdmin(actorId) {
    const actor = await this.accounts.get(actorId);
    if (!actor || actor.role !== 'admin' || !actor.mfaEnabled || actor.banned) fail('Administrator access with two-factor authentication is required.', 403);
    return actor;
  }
  async load() {
    let saved;
    try { saved = await this.accounts.hostStore.read(STORE, null); }
    catch { fail('Saved burn history could not be read. Restore the original journal before adding records.', 503); }
    if (saved === null) return empty();
    if (saved?.version !== 1 || !Array.isArray(saved.history) || saved.history.length > MAX_ROWS) fail('Saved burn history is invalid. Restore the original journal before adding records.', 503);
    const history = saved.history.map(row => canonical(row, this.now())), seen = new Set();
    for (const row of history) { if (seen.has(identity(row))) fail('Saved burn history contains duplicate records.', 503); seen.add(identity(row)); }
    for (const row of history) if (row.buybackSignature && !seen.has(`buy:${row.buybackSignature}`)) fail('Saved burn history has an incomplete buyback reference.', 503);
    return { version: 1, history };
  }
  async read(actorId) { await this.requireAdmin(actorId); return view(await this.load()); }
  async readPublic() {
    try { return view(await this.load()); }
    catch { return { status: 'unavailable', complete: false, history: [] }; }
  }
  async classifyAccounting(incoming, saved) {
    let treasury;
    try { treasury = await this.accounts.hostStore.read('protocol-treasury', null); }
    catch { fail('Treasury history could not be checked for duplicate receipts. Try again after restoring its original data.', 503); }
    if (treasury === null) return;
    if (treasury?.version !== 1 || !Array.isArray(treasury.history) || treasury.history.length > 500 || treasury.wallet && !publicKey(treasury.wallet.address)) fail('Treasury history could not be checked for duplicate receipts.', 503);
    for (const row of incoming) {
      if (treasury.pending?.signature === row.signature) fail('This transaction is awaiting treasury reconciliation. Try adding it again after that cycle completes.', 409);
      const known = treasury.history.filter(item => item?.state === 'confirmed' && identity(item) === identity(row));
      if (known.length) {
        if (known.some(item => !sameAmounts(item, row))) fail('This transaction conflicts with a confirmed treasury receipt. No records were changed.', 409);
        row.accountingSource = 'managed-treasury';
        continue;
      }
      const prior = saved.history.find(item => identity(item) === identity(row));
      if (prior?.accountingSource === 'managed-treasury') { row.accountingSource = 'managed-treasury'; continue; }
      // This journal starts with the importer: an exact earlier standalone
      // import has already passed this locked check before retention advanced.
      if (prior && sameReceipt(prior, row)) continue;
      if (MANUAL_PROTOCOL_HISTORY.some(item => sameAmounts(item, row))) continue;
      const wallets = row[BURN_OWNERS] || [row.wallet];
      if (treasury.history.length === 500 && wallets.includes(treasury.wallet?.address)) {
        const times = treasury.history.map(item => item.confirmedAt).filter(value => Number.isSafeInteger(value) && value > 0);
        if (!times.length || row.confirmedAt <= Math.min(...times)) fail('This treasury transaction predates retained receipt history and may already be counted. It cannot be added again without reconciling that history.', 409);
      }
    }
  }
  async verified(connection, signatureValue) {
    let tx, response;
    try {
      [tx, response] = await bounded(Promise.all([
        connection.getParsedTransaction(signatureValue, {commitment: 'finalized', maxSupportedTransactionVersion: 0}),
        connection.getSignatureStatuses([signatureValue], {searchTransactionHistory: true}),
      ]));
    } catch (error) { if (error.publicBurnHistoryError) throw error; fail('Transaction lookup is unavailable. Try again shortly.', 503); }
    const status = response?.value?.[0];
    if (!tx || !status) fail('Transaction was not found in finalized mainnet history. Check the link or try again shortly.');
    if (status.err !== null || tx.meta?.err !== null) fail('Failed transactions cannot be added to analytics.');
    if (status.confirmationStatus !== 'finalized') fail('Wait until the transaction is finalized before adding it.');
    if (!Number.isSafeInteger(tx.slot) || tx.slot <= 0 || tx.slot !== status.slot || !Number.isSafeInteger(tx.blockTime) || tx.blockTime <= 0 || !Number.isSafeInteger(tx.blockTime * 1000) || tx.blockTime * 1000 > this.now() + 5000 || tx.transaction?.signatures?.[0] !== signatureValue) fail('Transaction receipt identity or confirmation time could not be verified.');
    return tx;
  }
  async add(actorId, { burnLink, buybackLink } = {}, { authorize } = {}) {
    await this.requireAdmin(actorId); if (authorize) await authorize();
    const burnSignature = burnHistorySignature(burnLink), buySignature = burnHistorySignature(buybackLink, {optional: true, label: 'Buyback'});
    let resource, burn, buy, factoryAbandoned = false;
    try {
      try { resource = await bounded(Promise.resolve().then(() => this.connectionFactory({actorId})).then(async value => { if (factoryAbandoned) { try { await value?.close?.(); } catch {} } return value; })); }
      catch (error) { factoryAbandoned = true; if (error.publicBurnHistoryError) throw error; fail('Mainnet transaction lookup is unavailable. Try again shortly.', 503); }
      const connection = resource?.connection || resource;
      const burnTx = await this.verified(connection, burnSignature);
      burn = burnReceipt(burnTx, burnSignature);
      if (buySignature) {
        const buyTx = buySignature === burnSignature ? burnTx : await this.verified(connection, buySignature);
        buy = buyReceipt(buyTx, buySignature);
        if (buy.slot > burn.slot) fail('The buyback transaction must occur before or in the same transaction as the burn.');
        burn.buybackSignature = buySignature;
      }
    } finally { try { await resource?.close?.(); } catch {} }
    const job = this.queue.catch(() => {}).then(async () => {
      let release, releaseTreasury;
      try {
        release = await acquireProcessLock(join(this.accounts.dir, 'admin-burn-history.lock'));
        releaseTreasury = await acquireProcessLock(join(this.accounts.dir, 'protocol-treasury.lock'));
        await this.requireAdmin(actorId); if (authorize) await authorize();
        const state = await this.load(); let added = 0, updated = false;
        await this.classifyAccounting([buy, burn].filter(Boolean), state);
        for (const incoming of [buy, burn].filter(Boolean)) {
          const row = canonical(incoming, this.now()), prior = state.history.find(item => identity(item) === identity(row));
          if (prior) {
            if (!sameReceipt(prior, row)) fail('This transaction conflicts with its saved receipt. No records were changed.', 409);
            if (row.buybackSignature && prior.buybackSignature && row.buybackSignature !== prior.buybackSignature) fail('This burn already has a different buyback link. No records were changed.', 409);
            if (row.buybackSignature && !prior.buybackSignature) { prior.buybackSignature = row.buybackSignature; updated = true; }
            if (row.accountingSource && !prior.accountingSource) { prior.accountingSource = row.accountingSource; updated = true; }
          } else { state.history.push(row); added++; }
        }
        if (state.history.length > MAX_ROWS) fail('Burn history has reached its storage limit. No records were changed.', 409);
        if (added || updated) {
          // Recheck the session and current admin role immediately before the
          // single atomic encrypted write, after all network checks complete.
          await this.requireAdmin(actorId); if (authorize) await authorize();
          try { await this.accounts.hostStore.write(STORE, state); }
          catch { fail('Burn history could not be saved. Check storage and try again.', 503); }
        }
        return { ...view(state), added, updated, alreadyRecorded: added === 0 && !updated };
      } finally { await releaseTreasury?.(); await release?.(); }
    });
    this.queue = job.catch(() => {});
    return job;
  }
}
