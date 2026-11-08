import { PublicKey } from '@solana/web3.js';
import { ACCOUNT_SIZE, AccountLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackAccount } from '@solana/spl-token';
import { knownRewardTransportMessage, rewardIntegrityMessage } from './reward-transport-recovery.mjs';

const PAGE_SIZE = 1000, MAX_PAGES = 100, MAX_ACCOUNTS = 50000, SCAN_TIMEOUT_MS = 60000;
const scanError = (message, code = 'REWARD_ACCOUNT_SCAN_INVALID') => Object.assign(Error(message), { code });
const check = (condition, message) => { if (!condition) throw scanError(message); };
const temporary = () => scanError('Token-account scan is temporarily unavailable. Rewards will retry automatically.', 'REWARD_ACCOUNT_SCAN_RETRY');

// Detect the actual Connection endpoint, never a saved API key or a URL substring.
// Custom proxies retain standard Solana RPC behavior until explicitly supported.
function helius(connection) {
  try {
    const url = new URL(connection.rpcEndpoint);
    return url.protocol === 'https:' && !url.port && !url.username && !url.password
      && ['mainnet.helius-rpc.com', 'devnet.helius-rpc.com'].includes(url.hostname);
  } catch { return false; }
}

function rpcError(error) {
  // Do not persist provider payloads: they can contain a credential-bearing URL.
  const message = String(error?.message || ''), code = Number(error?.code);
  const failed = () => scanError('The token-account RPC request failed. Rewards paused without using incomplete data.', 'REWARD_ACCOUNT_SCAN_RPC');
  if (error?.code === 'REWARD_ACCOUNT_SCAN_INVALID') return scanError('The token-account scan returned invalid account data.');
  if (error?.code === 'REWARD_ACCOUNT_SCAN_RPC' || rewardIntegrityMessage(message)) return failed();
  if ([-32600, -32601, -32602, -32001].includes(code) || /unauthori[sz]ed|forbidden|method not found|invalid params|invalid api[- ]?key/i.test(message)) return failed();
  if (error?.code === 'RPC_SCHEDULER_CLOSED' || knownRewardTransportMessage(message)) return temporary();
  if (error?.retryable || error?.rateLimited || error?.capacityLimited || [-32002, -32003, -32005, -32016, -32603].includes(code)
    || /overload|too many requests|rate.?limit|temporar|unavailable|timed?\s*out|timeout|fetch failed|network|connection failed|connection reset|interrupted|deadline|maximum signal age|cooling down|stopped|abort|\b(?:429|502|503|504|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN)\b/i.test(message)) return temporary();
  return failed();
}

function accountRow(row, program, mint, encoded) {
  try {
    const pubkey = new PublicKey(row?.pubkey), input = row?.account, owner = new PublicKey(input?.owner);
    check(owner.equals(program) && input.executable === false, 'The token-account scan returned an invalid program owner.');
    check(Number.isSafeInteger(input.lamports) && input.lamports >= 0, 'The token-account scan returned invalid account metadata.');
    let data = input.data;
    if (encoded) {
      check(Array.isArray(data) && data.length === 2 && data[1] === 'base64' && typeof data[0] === 'string', 'The token-account scan returned an unsupported encoding.');
      const decoded = Buffer.from(data[0], 'base64');
      check(decoded.toString('base64') === data[0], 'The token-account scan returned malformed account data.');
      data = decoded;
    }
    check(Buffer.isBuffer(data) && data.length >= ACCOUNT_SIZE && (!program.equals(TOKEN_PROGRAM_ID) || data.length === ACCOUNT_SIZE), 'The token-account scan returned an invalid token account.');
    check([1, 2].includes(data[AccountLayout.offsetOf('state')]), 'The token-account scan returned an uninitialized or invalid token account.');
    const account = { ...input, owner, data }, token = unpackAccount(pubkey, account, program);
    check(token.mint.equals(mint), 'The token-account scan returned a different mint.');
    return { pubkey, account };
  } catch (error) {
    if (error?.code === 'REWARD_ACCOUNT_SCAN_INVALID') throw error;
    throw scanError('The token-account scan returned malformed account data.');
  }
}

// A complete finalized scan is required before the caller can build rewards or
// tax instructions. Pagination is not an atomic single-slot snapshot; each page
// is at least as recent as the preceding page, and context.slot marks completion.
export async function readMintTokenAccounts(chain, program, mint, { minContextSlot = 0 } = {}) {
  const connection = chain.c, deadline = Date.now() + SCAN_TIMEOUT_MS;
  check([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(p => p.equals(program)), 'Unsupported token-account scan program.');
  check(Number.isSafeInteger(minContextSlot) && minContextSlot >= 0, 'Invalid token-account scan minimum slot.');
  const run = async () => {
    const paged = helius(connection), accounts = new Map(), cursors = new Set();
    let cursor, slot = minContextSlot, count = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (Date.now() >= deadline) throw temporary();
      const config = { commitment: 'finalized', withContext: true, filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }], ...(slot ? { minContextSlot: slot } : {}) };
      let result;
      if (paged) {
        check(typeof connection._rpcRequest === 'function', 'The paginated token-account RPC transport is unavailable.');
        let response;
        // web3's request uses the same fetch, endpoint gate, cooldown and deadline
        // as every ordinary RPC call. No independent transport or retry loop.
        try { response = await connection._rpcRequest('getProgramAccountsV2', [program.toBase58(), { ...config, encoding: 'base64', limit: PAGE_SIZE, ...(cursor ? { paginationKey: cursor } : {}) }]); }
        catch (error) { throw rpcError(error); }
        if (response?.error) throw rpcError(response.error);
        check(response?.jsonrpc === '2.0' && response.result, 'The token-account scan returned an invalid RPC response.');
        result = response.result;
      } else {
        check(typeof connection?.getProgramAccounts === 'function', 'The token-account RPC transport is unavailable.');
        try { result = await connection.getProgramAccounts(program, config); }
        catch (error) { throw rpcError(error); }
      }
      if (Date.now() >= deadline) throw temporary();
      check(Number.isSafeInteger(result?.context?.slot) && result.context.slot > 0 && result.context.slot >= slot, 'The token-account scan returned an invalid or older finalized slot.');
      slot = result.context.slot;
      const rows = paged ? result.value?.accounts : result.value;
      check(Array.isArray(rows) && (!paged || rows.length <= PAGE_SIZE), 'The token-account scan returned an incomplete or invalid page.');
      count += rows.length;
      check(count <= MAX_ACCOUNTS, 'Token-account scan exceeds the service limit; rewards paused without truncation.');
      for (const input of rows) {
        const row = accountRow(input, program, mint, paged), address = row.pubkey.toBase58(), previous = accounts.get(address);
        check(!previous || previous.account.data.equals(row.account.data), 'The token-account scan returned conflicting duplicate accounts.');
        if (!previous) accounts.set(address, row);
      }
      if (!paged) return { context: { slot }, value: [...accounts.values()] };
      const next = result.value.paginationKey;
      // Short and even empty filtered pages may still have a cursor. Only the
      // provider's explicit null cursor proves that all pages were consumed.
      if (next === null) return { context: { slot }, value: [...accounts.values()] };
      check(typeof next === 'string' && next.length > 0 && next.length <= 1024 && !cursors.has(next), 'The token-account scan returned an invalid or repeated pagination cursor.');
      cursors.add(next); cursor = next;
    }
    throw scanError('Token-account scan exceeds the page limit; rewards paused without truncation.');
  };
  return typeof chain.withRpcContext === 'function' ? chain.withRpcContext({ deadline }, run) : run();
}
