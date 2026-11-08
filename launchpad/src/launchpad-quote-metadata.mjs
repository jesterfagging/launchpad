import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackMint, ExtensionType, getExtensionData, getMetadataPointerState } from '@solana/spl-token';
import { unpack as unpackTokenMetadata } from '@solana/spl-token-metadata';
import { cleanQuoteSymbol, knownQuoteAsset, quoteLabel } from '../public/quote-identity.mjs';

const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const safeName = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 100) : '';
const fallback = (mint, symbol) => ({ mint, symbol: quoteLabel(mint, symbol), name: knownQuoteAsset(mint)?.name || '', source: knownQuoteAsset(mint) ? 'catalogue' : cleanQuoteSymbol(symbol) ? 'saved' : 'mint_address' });
function verifiedMint(mint, account) {
  if (!account || account.executable || ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(program => program.equals(account.owner))) throw Error('Invalid quote mint.');
  const value = unpackMint(new PublicKey(mint), account, account.owner);
  if (!value.isInitialized) throw Error('Uninitialized quote mint.');
  return value;
}

/** Decode metadata held by this exact Token-2022 mint, without fetching its URI. */
export function quoteMetadataFromMint(mint, account) {
  try {
    const state = verifiedMint(mint, account);
    if (!account.owner.equals(TOKEN_2022_PROGRAM_ID)) return null;
    const pointer = getMetadataPointerState(state);
    if (!pointer?.metadataAddress?.equals(new PublicKey(mint))) return null;
    const extension = getExtensionData(ExtensionType.TokenMetadata, state.tlvData);
    if (!extension) return null;
    const metadata = unpackTokenMetadata(extension), symbol = cleanQuoteSymbol(metadata.symbol);
    if (!metadata.mint.equals(new PublicKey(mint)) || !symbol) return null;
    return { mint, symbol, name: safeName(metadata.name), source: 'mint_metadata' };
  } catch { return null; }
}

export function quoteMetadataAddress(mint) {
  return PublicKey.findProgramAddressSync([Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), new PublicKey(mint).toBuffer()], METADATA_PROGRAM)[0];
}

// Only the canonical Metaplex MetadataV1 account is accepted. The prefix stores
// discriminator, update authority, mint, then Borsh name/symbol/URI strings.
function legacyMetadata(mint, account) {
  if (!account || account.executable || !METADATA_PROGRAM.equals(account.owner)) return null;
  const data = Buffer.from(account.data);
  if (data.length < 73 || data.length > 4096 || data[0] !== 4 || !data.subarray(33, 65).equals(new PublicKey(mint).toBuffer())) return null;
  let offset = 65;
  const string = max => { if (offset + 4 > data.length) throw Error('Invalid metadata.'); const size = data.readUInt32LE(offset); offset += 4; if (size > max || offset + size > data.length) throw Error('Invalid metadata.'); const result = new TextDecoder('utf-8', {fatal: true}).decode(data.subarray(offset, offset + size)); offset += size; return result; };
  try { const name = safeName(string(128)), symbol = cleanQuoteSymbol(string(64)); string(1024); return symbol ? {mint, symbol, name, source: 'metaplex_metadata'} : null; } catch { return null; }
}

/** Bounded, coalesced read-only identity lookups. No offchain URLs or balances. */
export class QuoteMetadataResolver {
  constructor({now = Date.now, waitMs = 750} = {}) { this.now = now; this.waitMs = waitMs; this.entries = new Map(); this.pending = new Map(); this.closed = false; }
  async result(job, basic) {
    let timer;
    try { return await Promise.race([job.then(value => value || basic), new Promise(resolve => { timer = setTimeout(() => resolve(basic), this.waitMs); })]); }
    finally { clearTimeout(timer); }
  }
  async read(connection, mint, {mintAccount, fallbackSymbol} = {}) {
    const basic = fallback(mint, fallbackSymbol);
    if (knownQuoteAsset(mint) || this.closed) return basic;
    try { if (new PublicKey(mint).toBase58() !== mint) return basic; } catch { return basic; }
    const inline = mintAccount && quoteMetadataFromMint(mint, mintAccount);
    if (inline) return inline;
    const cached = this.entries.get(mint);
    if (cached?.until > this.now()) return cached.value || basic;
    if (this.pending.has(mint)) return this.result(this.pending.get(mint), basic);
    if (this.pending.size >= 3 || typeof connection?.getAccountInfo !== 'function') return basic;
    const job = (async () => {
      let value = null;
      try {
        const account = mintAccount || await connection.getAccountInfo(new PublicKey(mint), 'confirmed');
        verifiedMint(mint, account);
        value = quoteMetadataFromMint(mint, account);
        if (!value) value = legacyMetadata(mint, await connection.getAccountInfo(quoteMetadataAddress(mint), 'confirmed'));
      } catch { /* Labels must never make verified balances unavailable. */ }
      this.entries.delete(mint); this.entries.set(mint, {value, until: this.now() + (value ? 900_000 : 60_000)});
      while (this.entries.size > 100) this.entries.delete(this.entries.keys().next().value);
      return value;
    })().finally(() => this.pending.delete(mint));
    this.pending.set(mint, job); return this.result(job, basic);
  }
  async close() { this.closed = true; await Promise.allSettled([...this.pending.values()]); this.entries.clear(); }
}
