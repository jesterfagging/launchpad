import { pumpLaunchLogs } from './launch-signals.mjs';
import { randomInt, randomBytes, createPublicKey, verify } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import bs58 from 'bs58';
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, AddressLookupTableAccount, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';
import { SOL, JUPITER, PUMP, PUMP_AMM, LAUNCHLAB, SENDER_TIPS, invariant, priorityPricing, DirectRouteUnavailableError } from './core.mjs';
import { inspectPumpLogs } from './pump-logs.mjs';
import { getAssociatedTokenAddressSync, unpackAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { makeV1Transaction, deserializeTransaction, TransactionCapacityError } from './transactions-v1.mjs';
import { trackedBalances } from './holding-reader.mjs';
import { localRequestGate } from './request-pacing.mjs';

export class ProviderError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'ProviderError'; Object.assign(this, details); }
}
export class TransactionTooLargeError extends Error {
  constructor(size, route = 'Swap', version = 0) {
    const limit = version === 1 ? 4096 : 1232;
    super(`${route} needs ${size} bytes; the v${version} transaction limit is ${limit} bytes.`);
    this.name = 'TransactionTooLargeError'; this.size = size; this.limit = limit; this.version = version;
  }
}
export function verifySignedTransaction(bytes, expectedPayer, additionalSigners = []) {
  const failure = 'Local transaction signature verification failed. Nothing was submitted.';
  try {
    invariant(bytes.length <= (bytes[0] === 0x81 ? 4096 : 1232), failure);
    const tx = deserializeTransaction(bytes), message = tx.message;
    invariant([0, 1].includes(message.version) && message.header.numRequiredSignatures === 1 + additionalSigners.length && tx.signatures.length === 1 + additionalSigners.length, failure);
    if (message.version === 1) invariant(message.staticAccountKeys.length <= 64 && message.compiledInstructions.length <= 64, failure);
    const payer = message.staticAccountKeys[0];
    invariant(!expectedPayer || payer.toBase58() === expectedPayer, failure);
    // Check the exact wire payload, including the final blockhash. A valid
    // unsigned simulation says nothing about whether this signature is valid.
    invariant(Buffer.from(tx.serialize()).equals(Buffer.from(bytes)), failure);
    const allowed = new Set(additionalSigners);
    invariant(allowed.size === additionalSigners.length, failure);
    for (let i = 0; i < tx.signatures.length; i++) {
      const signer = message.staticAccountKeys[i];
      if (i > 0) invariant(allowed.delete(signer.toBase58()), failure);
      const key = createPublicKey({ key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'), signer.toBuffer(),
      ]), format: 'der', type: 'spki' });
      invariant(verify(null, message.serialize(), key, tx.signatures[i]), failure);
    }
    return { signature: bs58.encode(tx.signatures[0]), payer: payer.toBase58() };
  } catch { throw new Error(failure); }
}
const compactLengthBytes = length => { let bytes = 1; while (length >= 128) { length = Math.floor(length / 128); bytes++; } return bytes; };
export function transactionSize(message) {
  if (message.version === 1) return message.serialize().length + 64 * message.header.numRequiredSignatures;
  // Measure the wire layout before web3.js serializes into its fixed buffer.
  // Calling serialize() to measure an oversized message throws first.
  invariant(message.version === 0, 'Expected a v0 transaction message.');
  const signatures = message.header.numRequiredSignatures;
  return compactLengthBytes(signatures) + 64 * signatures + 1 + 3 +
    compactLengthBytes(message.staticAccountKeys.length) + 32 * message.staticAccountKeys.length + 32 +
    compactLengthBytes(message.compiledInstructions.length) + message.compiledInstructions.reduce((size, ix) =>
      size + 1 + compactLengthBytes(ix.accountKeyIndexes.length) + ix.accountKeyIndexes.length + compactLengthBytes(ix.data.length) + ix.data.length, 0) +
    compactLengthBytes(message.addressTableLookups.length) + message.addressTableLookups.reduce((size, table) =>
      size + 32 + compactLengthBytes(table.writableIndexes.length) + table.writableIndexes.length + compactLengthBytes(table.readonlyIndexes.length) + table.readonlyIndexes.length, 0);
}
function compactMessage(message, tables) {
  const original = message.compileToV0Message(tables);
  if (!tables.length) return original;
  // The SDK uses tables in order, even if an early table consumes just one
  // address that a later table already covers. Each extra table costs 34 bytes.
  // Reorder whole tables, never the addresses inside them (those are on-chain indexes).
  const available = new Set(message.instructions.flatMap(ix => ix.keys.map(k => k.pubkey.toBase58())));
  available.delete(message.payerKey.toBase58());
  for (const ix of message.instructions) {
    available.delete(ix.programId.toBase58());
    for (const key of ix.keys) if (key.isSigner) available.delete(key.pubkey.toBase58());
  }
  const remaining = tables.map(table => ({ table, addresses: new Set(table.state.addresses.map(String)) })), chosen = [];
  while (remaining.length) {
    let index = -1, matches = [];
    for (let i = 0; i < remaining.length; i++) {
      const hits = [...available].filter(key => remaining[i].addresses.has(key));
      if (hits.length > matches.length) { index = i; matches = hits; }
    }
    // A table loading one address is three bytes larger than keeping it static.
    if (matches.length < 2) break;
    chosen.push(remaining.splice(index, 1)[0].table);
    for (const key of matches) available.delete(key);
  }
  const compact = message.compileToV0Message(chosen);
  return transactionSize(compact) < transactionSize(original) ? compact : original;
}
function retryAfter(response) {
  const value = response.headers.get('retry-after');
  const milliseconds = !value ? 0 : /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000 - Date.now();
  return Math.max(0, Number.isFinite(milliseconds) ? milliseconds : 0, Number.isFinite(reset) ? reset : 0);
}
function safeProviderMessage(message, url, headers = {}) {
  let text = String(message || '').replace(/(?:https?|wss?):\/\/\S+/g, '[provider]');
  // Provider error messages can echo credentials. Never persist URL query values or auth headers.
  for (const secret of [...new URL(url).searchParams.values(), ...Object.entries(headers).filter(([k]) => /auth|key|token/i.test(k)).map(([, v]) => v)]) {
    if (String(secret).length >= 4) text = text.split(String(secret)).join('[redacted]');
  }
  return text.replace(/(?:api[-_]?key|authorization|token)\s*[:=]\s*[^\s,;]+/gi, '[credential redacted]').slice(0, 200);
}
export async function jsonFetch(url, options = {}, label = 'Provider', timeout = 10000) {
  const { onResponse, ...requestOptions } = options;
  let response;
  try { response = await fetch(url, { ...requestOptions, redirect: 'error', signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) }); }
  catch (error) {
    if (options.signal?.aborted) throw new Error('Stopped.');
    const reasons = {
      ENOTFOUND: 'DNS lookup failed. Check the RPC hostname and your network.', EAI_AGAIN: 'DNS lookup did not complete. Check your network.',
      ECONNREFUSED: 'Connection refused. Check the endpoint and port.', ECONNRESET: 'The connection was reset.',
      ENETUNREACH: 'Network is unreachable.', EHOSTUNREACH: 'The server is unreachable.',
      EACCES: 'Android denied network access.', EPERM: 'Network access is not permitted.', EADDRNOTAVAIL: 'No usable network address is available.',
      ETIMEDOUT: 'Connection timed out.', UND_ERR_CONNECT_TIMEOUT: 'Connection timed out.',
      UND_ERR_HEADERS_TIMEOUT: 'The server did not respond in time.', UND_ERR_SOCKET: 'The connection closed unexpectedly.',
      CERT_HAS_EXPIRED: 'The server TLS certificate has expired.', ERR_TLS_CERT_ALTNAME_INVALID: 'The TLS certificate does not match the endpoint.',
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'The server TLS certificate could not be verified.',
      UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'The server TLS issuer could not be verified.',
      DEPTH_ZERO_SELF_SIGNED_CERT: 'The endpoint uses an untrusted self-signed TLS certificate.',
      SELF_SIGNED_CERT_IN_CHAIN: 'The TLS certificate chain is not trusted.',
      ERR_SSL_WRONG_VERSION_NUMBER: 'The endpoint does not speak the expected TLS protocol.',
      ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE: 'The TLS handshake was rejected.', EPROTO: 'The secure connection could not be negotiated.',
    };
    const candidates = [error, error?.cause, ...(error?.cause?.errors || [])];
    const code = candidates.map(e => e?.code).find(code => Object.hasOwn(reasons, code));
    const reason = code ? `${reasons[code]} (${code})` : error?.name === 'TimeoutError' ? 'Request timed out.' : 'Network request failed.';
    throw new ProviderError(`${label}: ${reason}`, { retryable: !code || !/CERT|TLS|ISSUER|SIGNATURE/.test(code), networkCode: code || 'NETWORK_ERROR' });
  }
  onResponse?.(response);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = body?.error?.message || body?.message || body?.error;
    const reason = typeof detail === 'string' ? safeProviderMessage(detail, url, options.headers) : '';
    const code = body?.errorCode || body?.error?.code;
    const routeUnavailable = [400, 404, 422].includes(response.status) &&
      (['COULD_NOT_FIND_ANY_ROUTE', 'NO_ROUTES_FOUND', 'TOKEN_NOT_TRADABLE'].includes(code) || /no routes? found|could not find any route|token is not tradable/i.test(reason));
    const authHelp = response.status === 401 && label.startsWith('RPC ') ? ' Authentication rejected. Check Connections → Custom RPC URL, its API key, and the provider’s access rules for the bot host. A custom RPC overrides the Helius key field.' : '';
    throw new ProviderError(`${label} returned HTTP ${response.status}${response.status === 429 ? ' (rate limited)' : ''}${reason ? `: ${reason}` : '.'}${authHelp}`, {
      httpStatus: response.status, retryAfterMs: retryAfter(response), rateLimited: response.status === 429, routeUnavailable,
      retryable: [408, 429, 500, 502, 503, 504].includes(response.status),
    });
  }
  let body;
  try { body = await response.json(); } catch { throw new ProviderError(`${label} returned invalid JSON.`, { retryable: true }); }
  if (!body || typeof body !== 'object') throw new ProviderError(`${label} returned an invalid response.`, { retryable: true });
  if (body.error) {
    const code = typeof body.error === 'object' ? body.error.code : body.error;
    const reason = safeProviderMessage(body.error.message || body.error, url, options.headers);
    const rateLimited = code === 429 || /rate.?limit|too many requests/i.test(reason);
    throw new ProviderError(`${label} rejected the request${typeof code === 'number' ? ` (${code})` : ''}: ${reason}`, {
      rpcCode: typeof code === 'number' ? code : undefined, rateLimited,
      retryable: rateLimited || [-32004, -32005, -32007, -32009, -32016, -32603].includes(code), retryAfterMs: retryAfter(response),
    });
  }
  return body;
}
export async function rpcCall(url, method, params = [], signal, headers = {}) {
  const data = await jsonFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal }, `RPC ${method}`);
  if (!data || !Object.hasOwn(data, 'result')) throw new ProviderError(`RPC ${method} omitted its result.`, { retryable: true });
  return data.result;
}
export function makeTransaction(build, wallet, config, jitoTips, version = 0) {
  const payer = new PublicKey(wallet.publicKey);
  const decode = ix => new TransactionInstruction({ programId: new PublicKey(ix.programId), keys: ix.accounts.map(a => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })), data: Buffer.from(ix.data, 'base64') });
  const raw = build.nativeInstructions || [...(build.setupInstructions || []), build.swapInstruction, ...(build.cleanupInstruction ? [build.cleanupInstruction] : []), ...(build.otherInstructions || [])].filter(Boolean).map(decode);
  const priority = priorityPricing(config.fees.priority, config.computeUnits);
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: config.computeUnits }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority.microLamports }), ...(build.platformFeeInstructions || []), ...raw.filter(ix => !ix.programId.equals(ComputeBudgetProgram.programId)), ...(build.platformFeeAfterInstructions || [])];
  // Distinct lead trades can otherwise produce identical signatures within one blockhash window.
  instructions.push(new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [], data: Buffer.from(randomBytes(8).toString('base64url')) }));
  if (config.sendJito) {
    invariant(jitoTips.length > 0, 'Jito tip accounts are unavailable.');
    const inTables = new Set(version === 0 ? Object.values(build.addressesByLookupTableAddress || {}).flat() : []);
    const candidates = jitoTips.filter(t => !inTables.has(t));
    invariant(candidates.length > 0, 'No Jito tip destination outside the route lookup tables. Disable Jito for this route.');
    instructions.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(candidates[randomInt(candidates.length)]), lamports: config.fees.jito }));
  }
  if (config.sendHelius) instructions.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(SENDER_TIPS[randomInt(SENDER_TIPS.length)]), lamports: config.fees.helius }));
  const alts = version === 1 ? [] : Object.entries(build.addressesByLookupTableAddress || {}).map(([key, addresses]) => new AddressLookupTableAccount({ key: new PublicKey(key), state: { deactivationSlot: 18446744073709551615n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: addresses.map(a => new PublicKey(a)) } }));
  const metadata = build.blockhashWithMetadata;
  invariant(metadata && Number.isSafeInteger(metadata.lastValidBlockHeight), 'Router omitted transaction expiry.');
  const blockhash = typeof metadata.blockhash === 'string' ? metadata.blockhash : bs58.encode(Uint8Array.from(metadata.blockhash));
  invariant(version === 0 || version === 1, 'Unsupported transaction format.');
  const tx = version === 1 ? makeV1Transaction(payer, blockhash,
    instructions.filter(ix => !ix.programId.equals(ComputeBudgetProgram.programId)), config)
    : new VersionedTransaction(compactMessage(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }), alts));
  invariant(tx.message.header.numRequiredSignatures === 1 && tx.message.staticAccountKeys[0].equals(payer), 'Unexpected swap signers.');
  const accounts = tx.message.staticAccountKeys.length + tx.message.addressTableLookups.reduce((n, t) => n + t.writableIndexes.length + t.readonlyIndexes.length, 0);
  if (accounts > 64) throw new TransactionCapacityError(`${build.routeName} needs ${accounts} accounts; the transaction limit is 64.`);
  const size = transactionSize(tx.message);
  if (size > (version === 1 ? 4096 : 1232)) throw new TransactionTooLargeError(size, build.routeName, version);
  return { tx, size, blockhash, lastValidBlockHeight: metadata.lastValidBlockHeight,
    chargedPriority: version === 1 ? config.fees.priority : priority.chargedLamports };
}
export async function prepareTransaction(build, order, wallet, config, providers, signal) {
  let oversized;
  const deadline = Number.isFinite(order.receivedAt) ? order.receivedAt + config.maxSignalAgeMs : Infinity;
  const checkActive = () => {
    invariant(!signal?.aborted && !providers.closed, 'Stopped.');
    invariant(Date.now() <= deadline, 'Compact route search exceeded your maximum signal age. Nothing was submitted.');
  };
  const tryV1 = candidate => {
    checkActive();
    try {
      const transaction = makeTransaction(candidate, wallet, config, providers.jitoTips, 1);
      providers.onEvent?.('info', `${candidate.routeName} uses v1: ${transaction.size}/4096 bytes, with your configured fees and tips. Checking it with an unsigned simulation before signing.`);
      return { build: { ...candidate, requiresSimulation: true }, transaction };
    } catch (error) {
      if (!(error instanceof TransactionTooLargeError || error instanceof TransactionCapacityError)) throw error;
      return null;
    }
  };
  checkActive();
  try { return { build, transaction: makeTransaction(build, wallet, config, providers.jitoTips) }; }
  catch (error) { if (!(error instanceof TransactionTooLargeError || error instanceof TransactionCapacityError)) throw error; oversized = error; }
  // The same atomic route can fit v1 without more quotes, lookup tables or a
  // separate funding transaction. Ordinary small trades keep their v0 fast path.
  const v1 = tryV1(build);
  if (v1) return v1;
  invariant(!build.feeSettlementLocked, 'The trade plus atomic SOL fee conversion exceeds transaction limits. Reduce route complexity or use a SOL pair. Nothing was submitted.');
  const fundingRoute = build.fundingLeg && providers.direct;
  providers.onEvent?.('info', `${oversized.message} ${fundingRoute ? 'Rebuilding the quote-token funding leg with fewer accounts.' : 'Requesting a compact route.'}`);
  let unavailable;
  for (const maxAccounts of [32, 24, 16]) {
    invariant(!signal?.aborted && !providers.closed, 'Stopped.');
    invariant(Date.now() <= deadline, 'Compact route search exceeded your maximum signal age. Nothing was submitted.');
    let routed;
    try {
      // For a SOL-funded launch, Jupiter only acquires the quote token. It may
      // not index the launch token at all. Rebuild BOTH legs with the new quote's
      // guaranteed minimum; never splice a cheaper funding quote into an old buy.
      routed = fundingRoute ? await providers.direct.build(order, wallet, signal, maxAccounts) : null;
      if (!routed) routed = await providers.jupiterBuild(order, wallet, signal, maxAccounts);
      // Compact-route retries must keep the host's exact atomic fee transfer.
      routed = { ...routed, platformFeeInstructions: build.platformFeeInstructions, requiresSimulation: !!(routed.requiresSimulation || build.requiresSimulation) };
    } catch (error) {
      if (!error.routeUnavailable) throw error;
      unavailable = error.message;
      providers.onEvent?.('info', `No ${fundingRoute ? 'funding ' : ''}route at the ${maxAccounts}-account limit.`);
      continue;
    }
    invariant(!signal?.aborted && !providers.closed, 'Stopped.');
    invariant(Date.now() <= deadline, 'Compact route search exceeded your maximum signal age. Nothing was submitted.');
    // Prefer retaining the original direct instructions when the router's
    // lookup tables can compress them. Lookup address order is never changed.
    const retained = { ...build, addressesByLookupTableAddress: {
      ...(build.addressesByLookupTableAddress || {}), ...(routed.addressesByLookupTableAddress || {}),
    } };
    const candidates = build.nativeInstructions ? (fundingRoute ? [routed, retained] : [retained, routed]) : [routed];
    for (const candidate of candidates) {
      try {
        const transaction = makeTransaction(candidate, wallet, config, providers.jitoTips);
        providers.onEvent?.('info', `${candidate.routeName} fits in ${transaction.size} bytes with the configured fees and tips.`);
        return { build: { ...candidate, requiresSimulation: true }, transaction };
      } catch (error) { if (!(error instanceof TransactionTooLargeError || error instanceof TransactionCapacityError)) throw error; oversized = error; }
      const v1 = tryV1(candidate);
      if (v1) return v1;
    }
  }
  throw new Error(`${oversized.message} No compact ${fundingRoute ? 'funding ' : ''}route fit v0 or v1 with the configured tips.${unavailable ? ` ${unavailable}` : ''} Nothing was submitted.`);
}

export class Providers {
  constructor(config, onEvent) {
    this.c = config; this.onEvent = onEvent; this.jitoTips = []; this.knownPrograms = new Set([JUPITER, PUMP, PUMP_AMM, LAUNCHLAB]);
    this.market = new Map(); this.ws = null; this.closed = false; this.heartbeat = null; this.retryTimer = null;
    this.blockhash = null; this.warmTimer = null; this.marketTimer = null; this.marketBusy = false;
    this.jupiterGate = Providers.sharedJupiterGate || localRequestGate('jupiter'); this.jitoGate = Providers.sharedJitoGate || localRequestGate('jito');
    this.rpcStarts = []; this.rpcGate = Promise.resolve(); this.rpcBlockedUntil = 0; this.rpcFailures = 0;
    this.logReads = new Map(); this.fastLogReads = new Set(); this.logFallbacks = new Map(); this.blockhashPromise = null; this.relayRetryAt = new Map(); this.solBalanceBatches = new Map(); this.accountBatches = new Map();
    this.signatureWatches = new Map(); this.signatureRequests = new Map(); this.signatureSubscriptions = new Map(); this.signatureRequested = new Set(); this.signatureRequestId = 100000;
    this.fetch = jsonFetch; this.rpcTransport = (method, params, signal) => rpcCall(config.rpcUrl, method, params, signal);
    this.rpc = (method, params, signal, deadline) => this.requestRpc(method, params, signal, deadline);
  }
  async requestRpc(method, params, signal, deadline = Infinity) {
    // Shared admission already owns bounded queues. Do not place another
    // unbounded promise chain ahead of it or reset deadlines at the queue head.
    const admitted = Providers.sharedRpcGate ? Providers.sharedRpcGate.acquire(this.c, signal, deadline, method) : this.rpcGate.then(async () => {
      for (;;) {
        signal?.throwIfAborted();
        const now = Date.now();
        if (now > deadline) throw new ProviderError('Maximum signal age exceeded before the RPC request started.');
        if (now < this.rpcBlockedUntil) throw new ProviderError('RPC is cooling down after a rate limit.', {
          rateLimited: true, retryable: true, retryAfterMs: this.rpcBlockedUntil - now,
        });
        this.rpcStarts = this.rpcStarts.filter(at => at > now - 1000);
        if (this.rpcStarts.length < this.c.rpcRequestsPerSecond) { this.rpcStarts.push(now); return; }
        await delay(Math.max(1, this.rpcStarts[0] + 1001 - now), undefined, { signal });
      }
    });
    this.rpcGate = admitted.catch(() => {});
    await admitted;
    try {
      const result = await this.rpcTransport(method, params, signal);
      if (Date.now() >= this.rpcBlockedUntil) this.rpcFailures = 0;
      return result;
    } catch (error) {
      if (error.rateLimited) {
        const backoff = Math.min(30000, 1000 * 2 ** Math.min(this.rpcFailures++, 5));
        const wait = Math.max(error.retryAfterMs || 0, backoff + randomInt(251));
        this.rpcBlockedUntil = Math.max(this.rpcBlockedUntil, Date.now() + wait);
        error.retryAfterMs = this.rpcBlockedUntil - Date.now();
        Providers.sharedRpcGate?.cooldown(this.c, error.retryAfterMs);
      }
      throw error;
    }
  }
  async init(signal) {
    const genesis = await this.rpc('getGenesisHash', [], signal);
    // getGenesisHash returns the complete base58 hash, not the shortened chain identifier.
    invariant(genesis === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', 'RPC returned a network other than Solana mainnet. Select a mainnet RPC URL.');
    if (!this.c.jupiterKey) this.onEvent('info', 'Jupiter key is blank: using public access, limited to 30 requests per minute. Direct launch routes use no Jupiter quota unless a funding conversion is needed.');
    const tasks = [this.refreshBlockhash(signal), this.loadPrograms(signal)];
    if (this.c.sendJito) tasks.push(this.loadJitoTips(signal));
    await Promise.all(tasks);
    this.warmTimer = setInterval(() => { this.refreshBlockhash().catch(() => {}); if (this.c.sendHelius) fetch(new URL('/ping', this.c.senderUrl), { signal: AbortSignal.timeout(2500) }).catch(() => {}); }, 5000);
  }
  async refreshBlockhash(signal) {
    if (!this.blockhashPromise) this.blockhashPromise = this.rpc('getLatestBlockhash', [{ commitment: 'confirmed' }], signal)
      .then(result => { this.blockhash = { ...result.value, at: Date.now() }; }).finally(() => { this.blockhashPromise = null; });
    return this.blockhashPromise;
  }
  async jupiterRequest(path, label, signal, deadline = Infinity) {
    deadline = Math.min(deadline, Date.now() + 120000);
    for (let attempt = 0; ; attempt++) {
      invariant(!this.closed && !signal?.aborted, 'Stopped.');
      await this.jupiterGate.acquire(this.c, signal, deadline);
      invariant(!this.closed && !signal?.aborted, 'Stopped.');
      invariant(Date.now() <= deadline, 'Jupiter request exceeded your maximum signal age.');
      try {
        return await this.fetch(`https://api.jup.ag${path}`, { headers: this.c.jupiterKey ? { 'x-api-key': this.c.jupiterKey } : {}, signal,
          onResponse: response => { const remaining = response.headers.get('x-ratelimit-remaining'); if (remaining !== null && Number(remaining) <= 0) this.jupiterGate.cooldown(this.c, retryAfter(response)); },
        }, label, Math.max(1, Math.min(10000, deadline - Date.now())));
      } catch (error) {
        if (!error.rateLimited || signal?.aborted || this.closed) throw error;
        const wait = Math.max(error.retryAfterMs || 0, Math.min(8000, 1000 * 2 ** attempt));
        this.jupiterGate.cooldown(this.c, wait);
        if (attempt >= 3 || Date.now() + wait >= deadline) throw new ProviderError('Jupiter capacity is temporarily exhausted. This unsigned trade was stopped; wait for capacity before trying again.', { rateLimited: true, retryAfterMs: wait });
        if (attempt === 0) this.onEvent('info', 'Jupiter is busy. Waiting for route capacity before preparing this trade.');
      }
    }
  }
  async loadPrograms(signal) {
    try {
      const labels = await this.jupiterRequest('/swap/v1/program-id-to-label', 'Jupiter program registry', signal);
      for (const key of Object.keys(labels)) { try { this.knownPrograms.add(new PublicKey(key).toBase58()); } catch {} }
    } catch { this.onEvent('warn', 'DEX registry unavailable. Detection is limited to Jupiter, Pump, PumpSwap, and LaunchLab until the next start.'); }
  }
  async loadJitoTips(signal) {
    const u = new URL(this.c.jitoUrl); u.pathname = '/api/v1/bundles';
    const result = await rpcCall(u, 'getTipAccounts', [], signal, this.c.jitoAuth ? { 'x-jito-auth': this.c.jitoAuth } : {});
    invariant(Array.isArray(result) && result.length > 0, 'No Jito tip accounts returned.');
    this.jitoTips = result.map(k => new PublicKey(k).toBase58());
  }
  async balance(owner, mint, signal) {
    if (mint === SOL) {
      // All followers handling the same notification share one fresh read. No
      // cached balances: outside transfers and the previous fill remain visible.
      return new Promise((resolve, reject) => {
        let batch = this.solBalanceBatches.get(signal);
        if (!batch) {
          batch = []; this.solBalanceBatches.set(signal, batch);
          queueMicrotask(() => this.flushSolBalances(signal));
        }
        batch.push({ owner, resolve, reject });
      });
    }
    const data = await this.rpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }], signal);
    return data.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  }
  trackedBalances(groups, signal) { return trackedBalances(this, groups, signal); }
  readAccounts(keys, slot = 0, signal, { commitment = 'processed' } = {}) {
    // Coalesce simultaneous pool/mint/follower reads into a fresh snapshot.
    // Different commitments, slots or cancellation scopes never share a batch.
    return new Promise((resolve, reject) => {
      invariant(keys.length > 0 && Number.isSafeInteger(slot) && slot >= 0, 'Invalid account snapshot request.');
      invariant(['processed', 'confirmed', 'finalized'].includes(commitment), 'Invalid account snapshot commitment.');
      let slots = this.accountBatches.get(signal);
      if (!slots) { slots = new Map(); this.accountBatches.set(signal, slots); }
      const batchKey = `${commitment}:${slot}`;
      let batch = slots.get(batchKey);
      if (!batch) {
        batch = []; slots.set(batchKey, batch);
        queueMicrotask(() => {
          slots.delete(batchKey); if (!slots.size) this.accountBatches.delete(signal);
          this.flushAccountReads(batch, slot, signal, commitment);
        });
      }
      batch.push({ keys: keys.map(String), resolve, reject });
    });
  }
  async flushAccountReads(batch, slot, signal, commitment = 'processed') {
    try {
      invariant(!this.closed && !signal?.aborted, 'Stopped.');
      const keys = [...new Set(batch.flatMap(r => r.keys))], accounts = new Map();
      let snapshotSlot = Infinity;
      for (let offset = 0; offset < keys.length; offset += 100) {
        const chunk = keys.slice(offset, offset + 100);
        const result = await this.accountSnapshot(chunk, slot, signal, commitment);
        invariant(!this.closed && !signal?.aborted, 'Stopped.');
        invariant(Number.isSafeInteger(result?.context?.slot) && result.context.slot >= slot && Array.isArray(result.value) && result.value.length === chunk.length,
          'RPC returned an incomplete or stale account snapshot.');
        snapshotSlot = Math.min(snapshotSlot, result.context.slot);
        chunk.forEach((key, i) => accounts.set(key, result.value[i]));
      }
      batch.forEach(r => r.resolve({ context: { slot: snapshotSlot }, value: r.keys.map(key => accounts.get(key)) }));
    } catch (error) { batch.forEach(r => r.reject(error)); }
  }
  async accountSnapshot(keys, slot, signal, commitment = 'processed') {
    const params = [keys, { encoding:'base64', commitment, ...(slot ? { minContextSlot:slot } : {}) }];
    const started = Date.now(), deadline = started + Math.min(1500, this.c.maxSignalAgeMs);
    let retries = 0, retrySignal;
    const lagError = () => new ProviderError(`RPC is still behind lead slot ${slot}; fresh-state retry limit reached. Trade skipped before signing.`,
      { rpcCode:-32016, requiredSlot:slot, attempts:retries+1, retryable:true });
    for (;;) {
      invariant(!this.closed && !signal?.aborted, 'Stopped.');
      if (retries && Date.now() >= deadline) throw lagError();
      try {
        const result = await this.rpc('getMultipleAccounts', params, retrySignal || signal, retries ? deadline : Infinity);
        invariant(!this.closed && !signal?.aborted, 'Stopped.');
        if (retries && Date.now() >= deadline) throw lagError();
        if (retries && result?.context?.slot >= slot) this.onEvent('info', `RPC caught up; fresh accounts loaded after ${retries+1} reads.`,
          { requiredSlot:slot, accountSlot:result.context.slot, attempts:retries+1, accountReadMs:Date.now()-started });
        return result;
      } catch (error) {
        invariant(!this.closed && !signal?.aborted, 'Stopped.');
        if (retrySignal?.aborted || (retries && Date.now() >= deadline)) throw lagError();
        if (error.rpcCode !== -32016 || !slot || error.rateLimited) throw error;
        if (retries >= 4 || Date.now() >= deadline) throw lagError();
        if (!retries) {
          this.onEvent('info', 'RPC is behind the lead slot; retrying the fresh account read.', { requiredSlot:slot, rpcCode:-32016 });
          retrySignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(Math.max(1, deadline-Date.now()))]);
        }
        try { await delay(Math.min(20 * 2 ** retries, Math.max(1,deadline-Date.now())), undefined, { signal:retrySignal }); }
        catch { invariant(!this.closed && !signal?.aborted, 'Stopped.'); throw lagError(); }
        retries++;
      }
    }
  }
  async executionBalances(order, wallet, signal) {
    const v = order.venue;
    // Manual Pump exits have a recorded/derived venue, but no lead-log source.
    // Keep their 20 wallet/ATA checks in the same snapshot as the fresh curve
    // read, rather than issuing a token-account request for every wallet.
    const batchedPump = order.signalSource === 'manual' || (this.c.fastPumpLogs && order.signalSource === 'pump-processed-logs');
    const fastPump = this.c.directLaunches && batchedPump && v?.type === 'pump' &&
      v.quoteMint === SOL && v.baseTokenProgram === TOKEN_2022_PROGRAM_ID.toBase58() && [SOL, v.baseMint].includes(order.inputMint);
    // Fee preparation already validates an SPL input mint/program and the
    // payer's exact source ATA. Reuse that identity for batched fresh balance
    // checks on other pairs too, preserving their confirmed commitment.
    const fee = order.platformFee, feeInput = order.inputMint !== SOL && fee?.mint === order.inputMint && fee.wallet === wallet.publicKey &&
      [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(fee.program);
    if (!fastPump && !feeInput)
      return Promise.all([this.balance(wallet.publicKey, SOL, signal), order.inputMint === SOL ? null : this.balance(wallet.publicKey, order.inputMint, signal)]);
    const owner = new PublicKey(wallet.publicKey), tokenIn = order.inputMint !== SOL;
    const program = fastPump ? TOKEN_2022_PROGRAM_ID : new PublicKey(fee.program);
    const ata = tokenIn ? getAssociatedTokenAddressSync(new PublicKey(order.inputMint), owner, false, program) : null;
    if (feeInput) invariant(ata?.toBase58() === fee.source, 'Platform fee source differs from the input token account.');
    const { value: [native, token] } = await this.readAccounts(ata ? [owner, ata] : [owner], fastPump ? order.slot : 0, signal,
      { commitment: fastPump ? 'processed' : 'confirmed' });
    invariant(native === null || (Number.isSafeInteger(native?.lamports) && native.lamports >= 0), 'RPC returned an invalid SOL balance.');
    let amount = null;
    if (tokenIn) {
      amount = 0n;
      if (token) {
        invariant(Array.isArray(token.data) && token.data[1] === 'base64', 'RPC returned an invalid token balance.');
        const account = unpackAccount(ata, { ...token, owner: new PublicKey(token.owner), data: Buffer.from(token.data[0], 'base64') }, program);
        invariant(account.owner.equals(owner) && account.mint.toBase58() === order.inputMint && account.isInitialized && !account.isFrozen,
          'Input token account is unavailable or does not match this wallet and mint.');
        amount = account.amount;
      }
    }
    return [BigInt(native?.lamports || 0), amount];
  }
  async flushSolBalances(signal) {
    const batch = this.solBalanceBatches.get(signal) || [];
    this.solBalanceBatches.delete(signal);
    for (let offset = 0; offset < batch.length; offset += 100) {
      const requests = batch.slice(offset, offset + 100);
      try {
        invariant(!this.closed && !signal?.aborted, 'Stopped.');
        const result = await this.rpc('getMultipleAccounts', [requests.map(r => r.owner), {
          commitment: 'confirmed', encoding: 'base64', dataSlice: { offset: 0, length: 0 },
        }], signal);
        invariant(Array.isArray(result?.value) && result.value.length === requests.length && result.value.every(a =>
          a === null || (Number.isSafeInteger(a?.lamports) && a.lamports >= 0)), 'RPC returned incomplete wallet balances.');
        requests.forEach((r, i) => r.resolve(BigInt(result.value[i]?.lamports || 0)));
      } catch (error) { requests.forEach(r => r.reject(error)); }
    }
  }
  async jupiterBuild(order, wallet, signal, maxAccounts = this.c.sendJito && this.c.sendHelius ? 48 : 56) {
    const query = new URLSearchParams({ inputMint: order.inputMint, outputMint: order.outputMint, amount: String(order.amount), taker: wallet.publicKey,
      slippageBps: String(order.slippageBps ?? this.c.slippageBps), mode: 'fast', maxAccounts: String(maxAccounts), wrapAndUnwrapSol: 'true' });
    const queueWindow = order.signalSource === 'manual' ? 120000 : order.signalSource === 'strategy' ? 60000 : this.c.maxSignalAgeMs;
    const deadline = Math.min(Number.isFinite(order.receivedAt) ? order.receivedAt + (order.routeQuotedAt ? this.c.maxSignalAgeMs : queueWindow) : Infinity,
      Number.isFinite(order.priceExpiresAt) ? order.priceExpiresAt : Infinity);
    const build = await this.jupiterRequest(`/swap/v2/build?${query}`, 'Jupiter route', signal, deadline);
    invariant(build.inputMint === order.inputMint && build.outputMint === order.outputMint && BigInt(build.inAmount) === order.amount, 'Router returned a different swap than requested.');
    invariant(!build.swapMode || build.swapMode === 'ExactIn', 'Router must use exact input amounts.');
    invariant(BigInt(build.outAmount || 0) > 0n && build.swapInstruction, 'No executable Jupiter route for this pair.');
    invariant(build.slippageBps <= (order.slippageBps ?? this.c.slippageBps) && BigInt(build.otherAmountThreshold || 0) > 0n, 'Router exceeded slippage or omitted the minimum output.');
    invariant(!build.tipInstruction, 'Unexpected router tip. Only the configured Jito and Helius tips are allowed.');
    if (build.priceImpactPct !== undefined) invariant(Number(build.priceImpactPct) <= (order.maxPriceImpact ?? this.c.maxPriceImpact), 'Route exceeds your price-impact limit.');
    build.routeName = 'Jupiter'; return build;
  }
  async build(order, wallet, signal) {
    if (this.c.directLaunches && order.venue && this.direct) {
      try {
        const direct = await this.direct.build(order, wallet, signal);
        if (direct) return direct;
      } catch (error) {
        // Only a known unsupported extension triggers fallback. Slippage limits,
        // invalid pool state, malformed accounts and cancellation still stop here.
        if (!(error instanceof DirectRouteUnavailableError)) throw error;
        invariant(!this.closed && !signal?.aborted, 'Stopped.');
        this.onEvent('warn', `${error.message} Trying Jupiter; live execution requires a successful simulation.`);
        const routed = await this.jupiterBuild(order, wallet, signal);
        return { ...routed, requiresSimulation: true };
      }
    }
    return this.jupiterBuild(order, wallet, signal);
  }
  async submit(bytes, onResult = () => {}, signal, deadline = Infinity, additionalSigners = []) {
    const payload = Buffer.from(bytes);
    const { signature: expected } = verifySignedTransaction(payload, undefined, additionalSigners);
    const encoded = payload.toString('base64');
    const params = [encoded, { encoding: 'base64', skipPreflight: true, maxRetries: 0, preflightCommitment: 'confirmed' }];
    const sends = [];
    const send = (route, request) => Promise.resolve().then(() => {
      if (this.closed || signal?.aborted) throw new ProviderError('Stopped before this relay request started.');
      if (Date.now() > deadline) throw new ProviderError('Maximum signal age exceeded before this relay request started.');
      const remaining = (this.relayRetryAt.get(route) || 0) - Date.now();
      if (remaining > 0) throw new ProviderError('Submission relay is cooling down after a rate limit.', { retryAfterMs: remaining, rateLimited: true });
      return request();
    }).then(signature => {
      if (signature !== expected) throw new ProviderError('Submission relay returned a different signature; the original signature is still being tracked.');
      const result = { route, signature, accepted: true }; onResult(result); return result;
    }).catch(error => {
      if (error.rateLimited) this.relayRetryAt.set(route, Date.now() + Math.max(1000, error.retryAfterMs || 0));
      onResult({ route, accepted: false, error: error.message, httpStatus: error.httpStatus, rpcCode: error.rpcCode, retryAfterMs: error.retryAfterMs });
      throw error;
    });
    if (this.c.sendRpc) sends.push(send('RPC', () => this.rpc('sendTransaction', params, signal, deadline)));
    if (this.c.sendJito) sends.push(send('Jito', async () => {
      await this.jitoGate.acquire(this.c, signal, deadline);
      invariant(!this.closed && !signal?.aborted && Date.now() <= deadline, 'Stopped before Jito submission.');
      try { return await rpcCall(this.c.jitoUrl, 'sendTransaction', [encoded, { encoding: 'base64' }], signal, this.c.jitoAuth ? { 'x-jito-auth': this.c.jitoAuth } : {}); }
      catch (error) { if (error.rateLimited) this.jitoGate.cooldown(this.c, Math.max(1000, error.retryAfterMs || 0)); throw error; }
    }));
    if (this.c.sendHelius) sends.push(send('Helius', () => rpcCall(this.c.senderUrl, 'sendTransaction', params, signal)));
    return Promise.any(sends); // Identical signed bytes on every relay: one on-chain swap, one set of tips.
  }
  async statuses(signatures) {
    invariant(signatures.length <= 256, 'Too many signatures in one status request.');
    const result = await this.rpc('getSignatureStatuses', [signatures, { searchTransactionHistory: true }]);
    if (!Array.isArray(result?.value) || result.value.length !== signatures.length || result.value.some(v => v !== null && (typeof v !== 'object' || !['processed', 'confirmed', 'finalized'].includes(v.confirmationStatus) || !Object.hasOwn(v, 'err')))) {
      throw new ProviderError('RPC returned incomplete signature statuses; outcomes remain unresolved.', { retryable: true });
    }
    return result.value;
  }
  async status(signature) { return (await this.statuses([signature]))[0]; }
  async transaction(signature, signal) { return this.rpc('getTransaction', [signature, { commitment: 'confirmed', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }], signal); }
  async height() {
    const height = await this.rpc('getBlockHeight', [{ commitment: 'finalized' }]);
    if (!Number.isSafeInteger(height) || height <= 0) throw new ProviderError('RPC returned an invalid block height.', { retryable: true });
    return height;
  }
  async markets(mints, signal) {
    // All position values use the same SOL/USD observation. Never interpret a
    // token's priceNative as SOL: its pool may be quoted in WBTC, ETH or stocks.
    const list = [...new Set([SOL, ...mints])].filter(Boolean);
    for (let i = 0; i < list.length; i += 30) {
      const chunk = list.slice(i, i + 30);
      const pairs = await this.fetch(`https://api.dexscreener.com/tokens/v1/solana/${chunk.join(',')}`, { signal }, 'Market data', 6000);
      invariant(Array.isArray(pairs), 'Market data response is invalid.');
      for (const mint of chunk) {
        const rows = pairs.filter(p => p.chainId === 'solana' && p.baseToken?.address === mint && Number.isFinite(Number(p.priceUsd)) && Number(p.priceUsd) > 0)
          .sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
        const p = rows[0];
        if (p) this.market.set(mint, { price: Number(p.priceUsd), marketCap: Number.isFinite(Number(p.marketCap)) && Number(p.marketCap) > 0 ? Number(p.marketCap) : null,
          symbol: String(p.baseToken.symbol || '').slice(0, 25), pair: p.pairAddress, quoteMint: p.quoteToken?.address || null, receivedAt: Date.now() });
        else this.market.delete(mint);
      }
    }
    return this.market;
  }
  subscribe(onTransaction, onConnection) {
    this.onTransaction = onTransaction; this.onConnection = onConnection; this.closed = false;
    return this.connect(true);
  }
  watchSignature(signature, callback) {
    this.signatureWatches.set(signature, callback);
    this.sendSignatureWatch(signature);
  }
  sendSignatureWatch(signature) {
    if (this.closed || this.ws?.readyState !== WebSocket.OPEN || this.signatureRequested.has(signature)) return;
    const id = ++this.signatureRequestId;
    this.signatureRequests.set(id, signature); this.signatureRequested.add(signature);
    this.ws.send(JSON.stringify({ jsonrpc:'2.0', id, method:'signatureSubscribe', params:[signature, { commitment:'confirmed', enableReceivedNotification:false }] }));
  }
  unwatchSignature(signature) {
    this.signatureWatches.delete(signature);
    this.signatureRequested.delete(signature);
    for (const [id, watched] of this.signatureSubscriptions) if (watched === signature) {
      this.signatureSubscriptions.delete(id);
      if (!this.closed && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ jsonrpc:'2.0', id:++this.signatureRequestId, method:'signatureUnsubscribe', params:[id] }));
    }
  }
  signatureMessage(message) {
    if (this.signatureRequests.has(message.id)) {
      const signature = this.signatureRequests.get(message.id); this.signatureRequests.delete(message.id);
      if (message.error || !Number.isSafeInteger(message.result)) {
        this.onEvent('info', 'Confirmation notifications unavailable; using batched RPC checks.'); return true;
      }
      this.signatureSubscriptions.set(message.result, signature);
      if (!this.signatureWatches.has(signature)) this.unwatchSignature(signature);
      return true;
    }
    if (message.method !== 'signatureNotification') return false;
    const id = message.params?.subscription, signature = this.signatureSubscriptions.get(id), result = message.params?.result;
    if (!signature || !result?.value || typeof result.value !== 'object' || !Object.hasOwn(result.value, 'err') || !Number.isSafeInteger(result.context?.slot)) return true;
    // A receivedSignature acknowledgment is not a fill. Only the terminal
    // confirmed notification wakes receipt processing, which still reads balances.
    const callback = this.signatureWatches.get(signature);
    this.signatureSubscriptions.delete(id); this.signatureWatches.delete(signature); this.signatureRequested.delete(signature);
    callback?.({ confirmationStatus:'confirmed', err:result.value.err, slot:result.context.slot });
    return true;
  }
  connect(initial = false) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('Stopped.'));
      let settled = false, accepted = 0;
      const subscriptionRequests = new Map(), subscriptions = new Map();
      this.signatureRequests.clear(); this.signatureSubscriptions.clear(); this.signatureRequested.clear();
      const ws = new WebSocket(this.c.wsUrl, { handshakeTimeout: 10000, maxPayload: 8 * 1024 * 1024 }); this.ws = ws;
      const fail = detail => { if (!settled) {
        settled = true;
        const reason = detail ? safeProviderMessage(detail, this.c.wsUrl) : 'Check the WebSocket URL and provider access.';
        reject(new Error(`${this.c.streamMode === 'logs' ? 'Logs' : 'Full transaction'} stream unavailable: ${reason}${this.c.streamMode === 'logs' ? '' : ' Helius transactionSubscribe requires a Developer plan or higher.'}`));
      } };
      const timeout = setTimeout(() => { fail(); ws.terminate(); }, 15000);
      const fastLogs = this.c.streamMode === 'logs' && this.c.fastPumpLogs;
      const expected = this.c.streamMode === 'logs' ? this.c.leads.length * (fastLogs ? 2 : 1) : 1;
      ws.on('open', () => {
        if (this.closed) return ws.close();
        if (this.c.streamMode === 'logs') {
          let id = 0;
          for (const lead of this.c.leads) for (const commitment of fastLogs ? ['processed', 'confirmed'] : ['confirmed']) {
            subscriptionRequests.set(++id, commitment);
            ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [lead] }, { commitment }] }));
          }
        } else {
          subscriptionRequests.set(1, this.c.commitment);
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'transactionSubscribe', params: [{ vote: false, failed: false, accountInclude: this.c.leads }, { commitment: this.c.commitment, encoding: 'jsonParsed', transactionDetails: 'full', showRewards: false, maxSupportedTransactionVersion: 1 }] }));
        }
        for (const signature of this.signatureWatches.keys()) this.sendSignatureWatch(signature);
        let alive = true;
        ws.on('pong', () => { alive = true; });
        this.heartbeat = setInterval(() => { if (!alive) return ws.terminate(); alive = false; if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 15000);
      });
      ws.on('message', buffer => {
        if (this.closed) return;
        const observedAt = performance.now(), receivedAt = Date.now();
        try {
          const message = JSON.parse(buffer.toString());
          if (this.signatureMessage(message)) return;
          if (message.id) {
            if (!subscriptionRequests.has(message.id)) return;
            const commitment = subscriptionRequests.get(message.id); subscriptionRequests.delete(message.id);
            if (message.error) { fail(message.error.message || 'Subscription rejected.'); return ws.close(); }
            if (typeof message.result !== 'number') { fail('Provider omitted the subscription ID.'); return ws.close(); }
            subscriptions.set(message.result, commitment);
            if (++accepted === expected) {
              settled = true; clearTimeout(timeout);
              this.streamInfo = { mode: this.c.streamMode, commitment: fastLogs ? 'processed + confirmed fallback' : this.c.streamMode === 'logs' ? 'confirmed' : this.c.commitment, fastPumpLogs: fastLogs };
              this.onConnection(true); resolve();
            }
            return;
          }
          if (message.method === 'transactionNotification') {
            const r = message.params?.result;
            if (r?.transaction?.meta && r.signature) this.onTransaction({ signature: r.signature, tx: r.transaction, slot: r.slot, observedAt, receivedAt });
          } else if (message.method === 'logsNotification') {
            const r = message.params?.result;
            const commitment = subscriptions.get(message.params?.subscription);
            if (!commitment || !r?.value?.signature || r.value.err !== null) return;
            const signature = r.value.signature;
            if (this.fastLogReads.has(signature)) return;
            const launches = this.c.sniperMode ? pumpLaunchLogs(r.value, this.c.leads) : [];
            if (launches.length) this.onTransaction({ signature, launches, slot: r.context?.slot, observedAt, receivedAt });
            const inspected = fastLogs ? inspectPumpLogs(r.value, this.c.leads, this.c.mirrorFraction) : { signal: null };
            const decoded = inspected.signal;
            if (decoded) {
              this.fastLogReads.add(signature);
              if (this.fastLogReads.size > 30000) this.fastLogReads.delete(this.fastLogReads.values().next().value);
              const first = this.logFallbacks.get(signature); this.logFallbacks.delete(signature);
              decoded.source = commitment === 'processed' ? 'pump-processed-logs' : 'pump-confirmed-logs';
              this.onTransaction({ signature, decoded, slot: r.context?.slot, observedAt: first?.observedAt ?? observedAt, receivedAt: first?.receivedAt ?? receivedAt,
                ...(first ? { fallbackReason:first.reason, confirmationWaitMs:Math.round((observedAt-first.observedAt)*10)/10 } : {}) });
            } else if (commitment === 'processed') {
              if (!this.logFallbacks.has(signature)) this.logFallbacks.set(signature, { observedAt, receivedAt, reason: inspected.reason });
              if (this.logFallbacks.size > 30000) this.logFallbacks.delete(this.logFallbacks.keys().next().value);
              // getTransaction remains confirmed. Start one read immediately:
              // HTTP may expose that confirmed transaction before the confirmed
              // logs subscription delivers it. A null read waits for that event.
              this.readLogTransaction(signature, r.context?.slot, observedAt, receivedAt,
                { fallbackReason:inspected.reason, confirmationWaitMs:0 }, false);
            } else if (commitment === 'confirmed') {
              const first = this.logFallbacks.get(signature); this.logFallbacks.delete(signature);
              const details = fastLogs ? { fallbackReason: first?.reason || inspected.reason,
                confirmationWaitMs: first ? Math.round((observedAt - first.observedAt) * 10) / 10 : null } : {};
              this.readLogTransaction(signature, r.context?.slot, first?.observedAt ?? observedAt, first?.receivedAt ?? receivedAt, details);
            }
          }
        } catch { this.onEvent('warn', 'Malformed stream event skipped.'); }
      });
      ws.on('error', () => { fail(); });
      ws.on('close', () => {
        clearTimeout(timeout); clearInterval(this.heartbeat); this.onConnection(false); fail();
        if (!this.closed && !initial) this.scheduleReconnect();
        else if (!this.closed && settled && accepted === expected) this.scheduleReconnect();
      });
    });
  }
  scheduleReconnect() {
    if (this.retryTimer || this.closed) return;
    this.onEvent('warn', 'Stream disconnected. Reconnecting; trades during the gap are not replayed.');
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(false).catch(() => this.scheduleReconnect()); }, 1500);
  }
  async readLogTransaction(signature, slot, observedAt, receivedAt, details = {}, confirmed = true) {
    let read = this.logReads.get(signature);
    if (read?.done || this.fastLogReads.has(signature)) return;
    if (!read) { read = { confirmed, busy:false, done:false }; this.logReads.set(signature, read); }
    else read.confirmed ||= confirmed;
    if (read.busy) return;
    read.busy = true;
    if (this.logReads.size > 30000) this.logReads.delete(this.logReads.keys().next().value);
    try {
      const fetchAt = performance.now(); let tx = null;
      for (let attempt = 0; attempt < (confirmed ? 3 : 1); attempt++) {
        if (this.closed || this.fastLogReads.has(signature) || Date.now() - receivedAt >= this.c.maxSignalAgeMs) return;
        tx = await this.transaction(signature);
        if (tx) break;
        if (confirmed && attempt < 2) await delay(80 * (attempt + 1));
      }
      if (tx && !this.closed && !this.fastLogReads.has(signature)) {
        read.done = true; this.logFallbacks.delete(signature);
        this.onTransaction({ signature, tx, slot:tx.slot ?? slot, observedAt, receivedAt,
          ...details, transactionFetchMs: Math.round((performance.now() - fetchAt) * 10) / 10 });
      } else if (!tx && confirmed && !this.closed) {
        read.done = true; this.onEvent('warn', 'Lead transaction remained unavailable after confirmed RPC retries; skipped.', { signature, fallbackReason:details.fallbackReason });
      }
    } catch (error) { if (confirmed && !this.closed) { read.done = true; this.onEvent('warn', 'Could not read a lead transaction from the custom RPC.', { signature, fallbackReason:details.fallbackReason, httpStatus:error.httpStatus, rpcCode:error.rpcCode }); } }
    finally {
      read.busy = false;
      // A confirmed notification arriving during the speculative HTTP read
      // gets its own attempt if that read returned null or failed.
      if (!confirmed && read.confirmed && !read.done && !this.closed) this.readLogTransaction(signature, slot, observedAt, receivedAt,
        { ...details, confirmationWaitMs:Math.round((performance.now()-observedAt)*10)/10 }, true);
    }
  }
  close() { this.closed = true; this.signatureWatches.clear(); clearInterval(this.heartbeat); clearInterval(this.warmTimer); clearTimeout(this.retryTimer); this.retryTimer = null; if (this.ws) this.ws.terminate(); }
}
