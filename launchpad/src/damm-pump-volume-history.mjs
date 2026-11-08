import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { CP_AMM_PROGRAM_ID, CpAmmIdl, cpAmmCoder } from '@meteora-ag/cp-amm-sdk';
import { PUMP_AMM_PROGRAM_ID, PUMP_AMM_SDK } from '@pump-fun/pump-swap-sdk';

// Read-only accounting. Pool identities come from registered launches and are
// checked against the actual program-owned pool before its events are accepted.
const STORE = 'damm-pump-volume-history', VERSION = 1;
const PROGRAMS = { damm: String(CP_AMM_PROGRAM_ID), pumpswap: String(PUMP_AMM_PROGRAM_ID) };
const EVENT_TAG = Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]);
const MAX_POOLS = 2000, MAX_EVENTS = 200000, PAGE = 20, FRESH = 120000;
const HASH = /^[a-f0-9]{64}$/, RAW = /^(?:0|[1-9]\d{0,19})$/;
const key = value => String(value?.pubkey ?? value ?? '');
const address = value => { try { return typeof value === 'string' && new PublicKey(value).toBase58() === value; } catch { return false; } };
const signature = value => { try { return typeof value === 'string' && bs58.decode(value).length === 64; } catch { return false; } };
const safeTime = value => Number.isSafeInteger(value) && value >= 1500000000;
const hash = value => createHash('sha256').update(value).digest('hex');
const ensure = (condition, message = 'Invalid on-chain volume history.') => { if (!condition) throw Error(message); };
const positiveRaw = value => { const result = key(value); ensure(RAW.test(result) && BigInt(result) > 0n && BigInt(result) <= 18446744073709551615n); return result; };
const field = (value, snake, camel) => value?.[snake] ?? value?.[camel];
const coder = venue => venue === 'damm' ? cpAmmCoder : PUMP_AMM_SDK.offlineProgram.coder;
const instructionDefs = {
  damm: CpAmmIdl.instructions.filter(row => ['swap', 'swap2'].includes(row.name)),
  pumpswap: PUMP_AMM_SDK.offlineProgram.idl.instructions.filter(row => ['buy', 'buyExactQuoteIn', 'sell'].includes(row.name)),
};
const eventDefs = {
  damm: CpAmmIdl.events.filter(row => row.name === 'EvtSwap2'),
  pumpswap: PUMP_AMM_SDK.offlineProgram.idl.events.filter(row => ['buyEvent', 'sellEvent'].includes(row.name)),
};

function bytes(value) { return typeof value === 'string' ? Buffer.from(bs58.decode(value)) : Buffer.from(value || []); }
function accountsOf(ix, keys) { return Array.from(ix.accounts ?? ix.accountKeyIndexes ?? [], value => typeof value === 'number' ? keys[value] : key(value)); }
function swapFor(ix, keys, pool) {
  const program = ix.programIdIndex !== undefined ? keys[ix.programIdIndex] : key(ix.programId);
  if (program !== pool.program) return null;
  let data; try { data = bytes(ix.data); } catch { return null; }
  const definition = instructionDefs[pool.venue].find(row => data.subarray(0, 8).equals(Buffer.from(row.discriminator)));
  if (!definition) return null;
  const accounts = accountsOf(ix, keys), at = name => accounts[definition.accounts.findIndex(row => row.name === name)];
  if (at('pool') !== pool.address) return null;
  const base = at(pool.venue === 'damm' ? 'token_a_mint' : 'baseMint');
  const quote = at(pool.venue === 'damm' ? 'token_b_mint' : 'quoteMint');
  const baseVault = at(pool.venue === 'damm' ? 'token_a_vault' : 'poolBaseTokenAccount');
  const quoteVault = at(pool.venue === 'damm' ? 'token_b_vault' : 'poolQuoteTokenAccount');
  ensure(base === pool.mint && quote === pool.quoteMint && baseVault === pool.baseVault && quoteVault === pool.quoteVault, 'Swap pool currencies or vaults differ from the registered pool.');
  const wallet = at(pool.venue === 'damm' ? 'payer' : 'user'); ensure(address(wallet));
  return { definition, wallet, events: 0 };
}

/** Decode authentic Anchor event CPIs, including swaps inside router CPIs.
 * Stable instruction locations preserve multiple swaps in the same transaction.
 * Logs and whole-wallet balance changes are deliberately not volume evidence. */
export function decodeDammPumpVolumeTransaction(tx, pool, expectedSignature) {
  ensure(tx?.meta && Array.isArray(tx.transaction?.signatures), 'Transaction details are temporarily unavailable.');
  ensure(Object.hasOwn(tx.meta, 'err'), 'RPC omitted transaction status.');
  ensure(tx.transaction.signatures[0] === expectedSignature && signature(expectedSignature));
  if (tx.meta.err !== null) return [];
  ensure(Number.isSafeInteger(tx.slot) && tx.slot > 0 && safeTime(tx.blockTime), 'Finalized transaction time is unavailable.');
  const message = tx.transaction.message;
  const keys = [...(message.staticAccountKeys || message.accountKeys || []).map(key), ...(tx.meta.loadedAddresses?.writable || []).map(key), ...(tx.meta.loadedAddresses?.readonly || []).map(key)];
  ensure(keys.includes(pool.address));
  const outer = message.compiledInstructions || message.instructions;
  ensure(Array.isArray(outer) && Array.isArray(tx.meta.innerInstructions), 'RPC omitted swap instruction evidence.');
  const allInstructions = [...outer, ...tx.meta.innerInstructions.flatMap(group => group.instructions || [])];
  const programOf = ix => ix.programIdIndex !== undefined ? keys[ix.programIdIndex] : key(ix.programId);
  const sawPoolInvocation = allInstructions.some(ix => programOf(ix) === pool.program && accountsOf(ix, keys).includes(pool.address));
  const simplePrograms = new Set(['11111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL']);
  const routedPool = allInstructions.some(ix => !simplePrograms.has(programOf(ix)) && programOf(ix) !== pool.program && [pool.address, pool.program].every(value => accountsOf(ix, keys).includes(value)));
  ensure(!routedPool || sawPoolInvocation, 'RPC omitted routed pool invocation evidence.');
  const rows = [], swaps = [];
  for (const [outerIndex, instruction] of outer.entries()) {
    const rootSwap = swapFor(instruction, keys, pool), stack = [{ height: 1, swap: rootSwap }];
    if (rootSwap) swaps.push(rootSwap);
    const group = tx.meta.innerInstructions.find(row => row.index === outerIndex);
    for (const [innerIndex, ix] of (group?.instructions || []).entries()) {
      const height = ix.stackHeight;
      ensure(Number.isInteger(height) && height >= 2, 'RPC omitted CPI nesting evidence.');
      while (stack.length && stack.at(-1).height >= height) stack.pop();
      const program = ix.programIdIndex !== undefined ? keys[ix.programIdIndex] : key(ix.programId);
      let data; try { data = bytes(ix.data); } catch { data = Buffer.alloc(0); }
      if (program === pool.program && data.subarray(0, 8).equals(EVENT_TAG)) {
        const def = eventDefs[pool.venue].find(row => data.subarray(8, 16).equals(Buffer.from(row.discriminator)));
        if (def) {
          const parent = stack.at(-1)?.swap;
          ensure(parent && stack.at(-1).height === height - 1, 'Swap event is missing its authenticated invocation.');
          const event = coder(pool.venue).events.decode(data.subarray(8).toString('base64'));
          ensure(event && event.name === def.name && key(event.data.pool) === pool.address);
          const authority = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], new PublicKey(pool.program))[0].toBase58();
          ensure(accountsOf(ix, keys)[0] === authority, 'Swap event authority does not match.');
          const value = event.data;
          let side, baseRaw, quoteRaw;
          if (pool.venue === 'damm') {
            const direction = field(value, 'trade_direction', 'tradeDirection'); ensure(direction === 0 || direction === 1);
            side = direction === 1 ? 'buy' : 'sell';
            const input = positiveRaw(field(value, 'included_transfer_fee_amount_in', 'includedTransferFeeAmountIn'));
            const output = positiveRaw(field(value, 'excluded_transfer_fee_amount_out', 'excludedTransferFeeAmountOut'));
            [baseRaw, quoteRaw] = side === 'buy' ? [output, input] : [input, output];
          } else {
            side = def.name === 'buyEvent' ? 'buy' : 'sell';
            ensure(key(value.user) === parent.wallet && (parent.definition.name === 'sell') === (side === 'sell'));
            baseRaw = positiveRaw(side === 'buy' ? value.baseAmountOut : value.baseAmountIn);
            quoteRaw = positiveRaw(side === 'buy' ? value.userQuoteAmountIn : value.userQuoteAmountOut);
          }
          const eventId = hash([expectedSignature, pool.program, outerIndex, innerIndex].join(':'));
          rows.push({ id: eventId, eventId, signature: expectedSignature, poolId: pool.address, venue: pool.venue, wallet: parent.wallet,
            side, time: tx.blockTime, at: tx.blockTime * 1000, slot: tx.slot, amountRaw: baseRaw, baseRaw, quoteRaw,
            amount: Number(baseRaw) / 10 ** pool.baseDecimals, quote: Number(quoteRaw) / 10 ** pool.quoteDecimals });
          parent.events++;
        }
      }
      const nestedSwap = swapFor(ix, keys, pool); if (nestedSwap) swaps.push(nestedSwap);
      stack.push({ height, swap: nestedSwap });
    }
  }
  ensure(swaps.every(row => row.events === 1), 'A finalized swap is missing its complete event; history will retry.');
  return rows;
}

function poolState(record, venue, addressValue) {
  return { address: addressValue, mint: record.mint, quoteMint: record.quote.mint, quoteDecimals: record.quote.decimals,
    baseDecimals: record.baseDecimals ?? 6, venue, program: PROGRAMS[venue], createdAt: record.createdAt,
    head: null, headAt: null, before: null, oldest: null, historyComplete: false, turn: 0, batch: null,
    recentBefore: null, recentHead: null, failures: 0, retryAt: 0, events: {} };
}
function validateStoredPool(pool, now) {
  ensure(pool && address(pool.address) && address(pool.mint) && address(pool.quoteMint) && PROGRAMS[pool.venue] === pool.program);
  ensure(Number.isInteger(pool.quoteDecimals) && pool.quoteDecimals >= 0 && pool.quoteDecimals <= 18 && Number.isInteger(pool.baseDecimals) && pool.baseDecimals >= 0 && pool.baseDecimals <= 18);
  ensure(typeof pool.historyComplete === 'boolean' && Number.isSafeInteger(pool.turn) && pool.turn >= 0 && Number.isSafeInteger(pool.failures) && pool.failures >= 0 && Number.isSafeInteger(pool.retryAt) && pool.retryAt >= 0);
  for (const name of ['head', 'before', 'recentBefore', 'recentHead']) ensure(pool[name] === null || signature(pool[name]));
  ensure(pool.headAt === null || Number.isSafeInteger(pool.headAt) && pool.headAt <= now + 5000);
  ensure(pool.oldest === null || safeTime(pool.oldest));
  ensure(pool.events && typeof pool.events === 'object' && !Array.isArray(pool.events));
  for (const [id, event] of Object.entries(pool.events)) {
    ensure(HASH.test(id) && event.id === id && event.eventId === id && event.poolId === pool.address && signature(event.signature) && address(event.wallet));
    ensure(['buy', 'sell'].includes(event.side) && safeTime(event.time) && event.time * 1000 <= now + 60000 && event.at === event.time * 1000);
    positiveRaw(event.quoteRaw); positiveRaw(event.amountRaw);
    ensure(event.quote === Number(event.quoteRaw) / 10 ** pool.quoteDecimals && event.amount === Number(event.amountRaw) / 10 ** pool.baseDecimals);
  }
  if (pool.batch !== null) {
    const batch = pool.batch;
    ensure(batch && ['history', 'recent'].includes(batch.lane) && Array.isArray(batch.rows) && batch.rows.length <= PAGE && typeof batch.exhausted === 'boolean');
    for (const row of batch.rows) ensure(signature(row.signature) && typeof row.done === 'boolean' && (row.blockTime === null || safeTime(row.blockTime)));
  }
}

export class DammPumpVolumeHistory {
  constructor({ store, connection, connectionFactory, now = Date.now, maxTransactions = 20, concurrency = 2 } = {}) {
    Object.assign(this, { store, connection, connectionFactory, now });
    this.maxTransactions = Math.max(1, Math.min(20, maxTransactions)); this.concurrency = Math.max(1, Math.min(2, concurrency));
    this.data = { version: VERSION, pools: {} }; this.published = this.data; this.records = new Map(); this.verified = new Map(); this.loaded = false; this.pending = null; this.cursor = 0; this.closed = false;
  }
  async load() {
    if (this.loaded) return;
    const data = await this.store.read(STORE, { version: VERSION, pools: {} });
    ensure(data?.version === VERSION && data.pools && typeof data.pools === 'object' && !Array.isArray(data.pools) && Object.keys(data.pools).length <= MAX_POOLS);
    let total = 0; for (const [id, pool] of Object.entries(data.pools)) { validateStoredPool(pool, this.now()); ensure(id === pool.address); total += Object.keys(pool.events).length; }
    ensure(total <= MAX_EVENTS); this.data = structuredClone(data); this.published = structuredClone(data); this.loaded = true;
  }
  async commit() {
    const encoded = JSON.stringify(this.data); ensure(Buffer.byteLength(encoded) <= 96000000, 'Volume history storage capacity reached.');
    await this.store.write(STORE, this.data);
    this.published = structuredClone(this.data);
  }
  async sync(records) {
    await this.load(); ensure(Array.isArray(records));
    const next = new Map();
    for (const value of records) {
      const record = { ...value, curve: value.curve || value.dammPoolId };
      ensure(address(record.mint) && address(record.curve) && address(record.quote?.mint) && record.mint !== record.quote.mint);
      ensure(Number.isInteger(record.quote.decimals) && record.quote.decimals >= 0 && record.quote.decimals <= 18 && Number.isSafeInteger(record.createdAt) && record.createdAt > 0 && record.createdAt <= this.now() + 5000);
      if (record.poolId) ensure(address(record.poolId) && record.poolId !== record.curve);
      const duplicate = next.get(record.mint); ensure(!duplicate || duplicate.curve === record.curve);
      next.set(record.mint, record);
      for (const [venue, id] of [['damm', record.curve], ['pumpswap', record.poolId]]) if (id) {
        const old = this.data.pools[id];
        ensure(!old || old.mint === record.mint && old.quoteMint === record.quote.mint && old.quoteDecimals === record.quote.decimals && old.venue === venue);
        if (!old) { ensure(Object.keys(this.data.pools).length < MAX_POOLS); this.data.pools[id] = poolState(record, venue, id); }
      }
    }
    this.records = next;
  }
  async verify(pool, connection) {
    if (this.verified.has(pool.address)) return this.verified.get(pool.address);
    const info = await connection.getAccountInfo(new PublicKey(pool.address), 'finalized');
    ensure(info && !info.executable && key(info.owner) === pool.program, 'Volume pool program could not be verified.');
    const decoded = pool.venue === 'damm' ? cpAmmCoder.accounts.decode('Pool', Buffer.from(info.data)) : PUMP_AMM_SDK.decodePool({ ...info, data: Buffer.from(info.data) });
    const mint = key(pool.venue === 'damm' ? field(decoded, 'token_a_mint', 'tokenAMint') : decoded.baseMint);
    const quote = key(pool.venue === 'damm' ? field(decoded, 'token_b_mint', 'tokenBMint') : decoded.quoteMint);
    const baseVault = key(pool.venue === 'damm' ? field(decoded, 'token_a_vault', 'tokenAVault') : decoded.poolBaseTokenAccount);
    const quoteVault = key(pool.venue === 'damm' ? field(decoded, 'token_b_vault', 'tokenBVault') : decoded.poolQuoteTokenAccount);
    ensure(mint === pool.mint && quote === pool.quoteMint && address(baseVault) && address(quoteVault), 'Volume pool mint identity changed.');
    const verified = { ...pool, baseVault, quoteVault }; this.verified.set(pool.address, verified); return verified;
  }
  async page(pool, connection) {
    if (pool.batch) return;
    const lane = pool.historyComplete || pool.turn % 2 ? 'recent' : 'history';
    const before = lane === 'history' ? pool.before : pool.recentBefore;
    const result = await connection.getSignaturesForAddress(new PublicKey(pool.address), { limit: PAGE, ...(before ? { before } : {}), ...(lane === 'recent' && pool.head ? { until: pool.head } : {}) }, 'finalized');
    ensure(Array.isArray(result) && result.length <= PAGE);
    const seen = new Set(); let previousSlot = Infinity;
    for (const row of result) { ensure(Object.hasOwn(row, 'err') && signature(row.signature) && !seen.has(row.signature) && row.signature !== before && Number.isSafeInteger(row.slot) && row.slot > 0 && row.slot <= previousSlot && (row.blockTime === null || safeTime(row.blockTime))); seen.add(row.signature); previousSlot = row.slot; }
    if (lane === 'recent' && !pool.recentBefore && result.length) pool.recentHead = result[0].signature;
    pool.batch = { lane, exhausted: result.length < PAGE, rows: result.map(row => ({ signature: row.signature, blockTime: row.blockTime, done: row.err !== null, failed: row.err !== null })) };
  }
  finishBatch(pool) {
    const batch = pool.batch; if (!batch || batch.rows.some(row => !row.done)) return;
    const last = batch.rows.at(-1)?.signature;
    if (batch.lane === 'history') {
      if (last) pool.before = last;
      for (const row of batch.rows) if (safeTime(row.blockTime)) pool.oldest = Math.min(pool.oldest ?? Infinity, row.blockTime);
      if (!pool.head && batch.rows.length) { pool.head = batch.rows[0].signature; pool.headAt = this.now(); }
      if (batch.exhausted) { pool.historyComplete = true; if (!pool.headAt) pool.headAt = this.now(); }
    } else if (batch.exhausted) {
      pool.head = pool.recentHead || pool.head; pool.headAt = this.now(); pool.recentBefore = null; pool.recentHead = null;
    } else pool.recentBefore = last;
    pool.batch = null; pool.turn++; pool.failures = 0; pool.retryAt = 0;
  }
  advance() {
    if (this.closed) return Promise.resolve(); if (this.pending) return this.pending;
    this.pending = (async () => {
      await this.load(); const previous = structuredClone(this.data);
      try { await this.collect(); } catch (error) { this.data = previous; throw error; }
    })().finally(() => { this.pending = null; }); return this.pending;
  }
  async collect() {
    await this.load(); const connection = this.connection || await this.connectionFactory(); ensure(connection);
    const ids = [...this.records.values()].flatMap(row => [row.curve, row.poolId].filter(Boolean));
    const rotated = ids.slice(this.cursor).concat(ids.slice(0, this.cursor)); this.cursor = ids.length ? (this.cursor + 1) % ids.length : 0;
    const eligible = rotated.map(id => this.data.pools[id]).filter(pool => pool.retryAt <= this.now()).slice(0, 2);
    const work = [];
    for (const pool of eligible) {
      try { const verified = await this.verify(pool, connection); await this.page(pool, connection); this.finishBatch(pool);
        if (pool.batch) for (const row of pool.batch.rows.filter(row => !row.done).slice(0, Math.max(1, Math.floor(this.maxTransactions / eligible.length)))) if (work.length < this.maxTransactions) work.push({ pool, verified, row });
      } catch { pool.failures++; pool.retryAt = this.now() + Math.min(300000, 5000 * 2 ** Math.min(pool.failures - 1, 6)); }
    }
    let next = 0, total = Object.values(this.data.pools).reduce((sum, pool) => sum + Object.keys(pool.events).length, 0);
    await Promise.all(Array.from({ length: Math.min(this.concurrency, work.length) }, async () => {
      while (!this.closed && next < work.length) {
        const { pool, verified, row } = work[next++];
        try {
          // Raw JSON preserves v1 transactions that web3.js's legacy message
          // deserializer cannot represent. The transport still owns rate gates.
          const options = { commitment: 'finalized', maxSupportedTransactionVersion: 1 };
          const response = typeof connection._rpcRequest === 'function' ? await connection._rpcRequest('getTransaction', [row.signature, { ...options, encoding: 'json' }]) : null;
          if (response) ensure(!response.error, 'The RPC could not return this finalized transaction.');
          const tx = response ? response.result : await connection.getTransaction(row.signature, options);
          ensure(tx, 'Transaction details are temporarily unavailable.');
          const events = decodeDammPumpVolumeTransaction(tx, verified, row.signature);
          for (const event of events) {
            const existing = pool.events[event.id]; ensure(!existing || JSON.stringify(existing) === JSON.stringify(event));
            if (!existing) { ensure(total < MAX_EVENTS, 'Volume history event capacity reached.'); pool.events[event.id] = event; total++; }
          }
          row.done = true; if (safeTime(tx.blockTime)) row.blockTime = tx.blockTime;
        } catch { pool.failures++; pool.retryAt = this.now() + Math.min(300000, 5000 * 2 ** Math.min(pool.failures - 1, 6)); }
      }
    }));
    for (const pool of eligible) this.finishBatch(pool);
    if (!this.closed) await this.commit();
  }
  read(mint) {
    const record = this.records.get(mint); if (!record) return null;
    const pools = [['damm', record.curve], ['pumpswap', record.poolId]].filter(([, id]) => id).map(([venue, id]) => this.published.pools[id] || poolState(record, venue, id));
    const now = this.now(), historyComplete = pools.every(pool => pool.historyComplete);
    const recentComplete = pools.every(pool => (pool.historyComplete || pool.oldest !== null && pool.oldest <= Math.floor((now - 86400000) / 1000)) && pool.headAt !== null && now - pool.headAt <= FRESH && !pool.recentBefore && !pool.failures);
    const trades = pools.flatMap(pool => Object.values(pool.events)).sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    const at = pools.every(pool => pool.headAt !== null) ? Math.min(...pools.map(pool => pool.headAt)) : null;
    return { source: 'damm-pump-onchain', poolId: record.curve, mint, trades, at, updatedAt: at,
      historyComplete, recentComplete, complete: historyComplete && recentComplete, postGraduationIncluded: true,
      coverage: { pools: pools.length, historyComplete, recentComplete, pendingTransactions: pools.reduce((sum, pool) => sum + (pool.batch?.rows.filter(row => !row.done).length || 0), 0) } };
  }
  close() { this.closed = true; this.verified.clear(); }
}
