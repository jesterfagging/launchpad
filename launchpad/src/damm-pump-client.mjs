/** DAMM v2 to ordinary PumpSwap custody ABI. Pure builders: no signing or RPC. */
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync, createInitializeMint2Instruction, createSetAuthorityInstruction, AuthorityType } from '@solana/spl-token';
import { CP_AMM_PROGRAM_ID, deriveCustomizablePoolAddress, derivePoolAuthority, derivePositionAddress, derivePositionNftAccount, deriveTokenVaultAddress, deriveTokenBadgeAddress } from '@meteora-ag/cp-amm-sdk';
import { PUBLIC_PUMP, PUBLIC_TREASURY, configAddress, metadataIx } from './pump-public-client.mjs';
export { PUBLIC_PUMP, PUBLIC_TREASURY };
export const PUBLIC_PROGRAM_ID = 'FBD7sVcEMutFtQn6SXGxLZPFLKEY4pbQTkLYTGC9FXKA';
export const DAMM_STATE_SIZE = 512;
export const DAMM_PUMP_SUPPLY = '1000000000000000';
const pk = value => value instanceof PublicKey ? value : new PublicKey(value);
const ensure = (ok, message) => { if (!ok) throw Error(message); };
const meta = (key, writable = false, signer = false) => ({ pubkey: pk(key), isWritable: writable, isSigner: signer });
const uint = (value, bits) => { ensure(/^(0|[1-9]\d*)$/.test(String(value)), 'Invalid unsigned integer.'); const n = BigInt(value); ensure(n < 1n << BigInt(bits), `Integer exceeds u${bits}.`); return n; };
const enc = (value, bytes) => { let n = uint(value, bytes * 8); const b = Buffer.alloc(bytes); for (let i = 0; i < bytes; i++, n >>= 8n) b[i] = Number(n & 255n); return b; };
const read = (data, offset, bytes) => { let n = 0n; for (let i = bytes - 1; i >= 0; i--) n = n * 256n + BigInt(data[offset + i]); return String(n); };
const ata = (mint, owner, program = TOKEN_PROGRAM_ID) => getAssociatedTokenAddressSync(pk(mint), pk(owner), true, pk(program));
export function addresses({ programId = PUBLIC_PROGRAM_ID, mint, quoteMint = NATIVE_MINT, quoteTokenProgram = TOKEN_PROGRAM_ID, user, poolIndex = 0 }) {
  ensure(Number.isInteger(poolIndex) && poolIndex >= 0 && poolIndex <= 65535, 'Invalid PumpSwap pool index.');
  const program = pk(programId), base = pk(mint), quote = pk(quoteMint), quoteProgram = pk(quoteTokenProgram), pump = pk(PUBLIC_PUMP);
  ensure([TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].some(p => p.equals(quoteProgram)) && !base.equals(quote), 'Unsupported quote token program or identical mints.');
  const derive = name => PublicKey.findProgramAddressSync([Buffer.from(name), base.toBuffer()], program)[0];
  const state = derive('damm'), authority = derive('damm-vault'), nftMint = derive('damm-nft'), dammPool = deriveCustomizablePoolAddress(base, quote);
  const pool = PublicKey.findProgramAddressSync([Buffer.from('pool'), enc(poolIndex,2), authority.toBuffer(), base.toBuffer(), quote.toBuffer()], pump)[0];
  const lpMint = PublicKey.findProgramAddressSync([Buffer.from('pool_lp_mint'),pool.toBuffer()],pump)[0];
  return { program, mint: base, quoteMint: quote, quoteTokenProgram: quoteProgram, config: configAddress(program), state, authority, baseAta: ata(base,authority), quoteAta: ata(quote,authority,quoteProgram),
    dammProgram: CP_AMM_PROGRAM_ID, dammAuthority: derivePoolAuthority(), dammPool, position: derivePositionAddress(nftMint), nftMint, nftAccount: derivePositionNftAccount(nftMint),
    dammBaseVault: deriveTokenVaultAddress(base,dammPool), dammQuoteVault: deriveTokenVaultAddress(quote,dammPool), dammEvent: PublicKey.findProgramAddressSync([Buffer.from('__event_authority')],CP_AMM_PROGRAM_ID)[0],
    baseBadge: deriveTokenBadgeAddress(base), quoteBadge: deriveTokenBadgeAddress(quote), userAta: user ? ata(base,user) : null, userQuoteAta: user ? ata(quote,user,quoteProgram) : null,
    pump, pool, poolIndex, lpMint, authorityLp: ata(lpMint,authority,TOKEN_2022_PROGRAM_ID), poolBase: ata(base,pool), poolQuote: ata(quote,pool,quoteProgram),
    pumpGlobal: PublicKey.findProgramAddressSync([Buffer.from('global_config')],pump)[0], pumpEvent: PublicKey.findProgramAddressSync([Buffer.from('__event_authority')],pump)[0] };
}
export function decodeState(account, programId = PUBLIC_PROGRAM_ID) {
  if (!account) return null;
  const d = Buffer.from(account.data || []); ensure(pk(account.owner).equals(pk(programId)) && !account.executable && d.length === DAMM_STATE_SIZE && d.subarray(0,8).equals(Buffer.from('CRVDAMM1')) && [0,2].includes(d[8]), 'Invalid DAMM custody state.');
  const key = offset => pk(d.subarray(offset,offset+32)).toBase58(), u64 = offset => read(d,offset,8), u128 = offset => read(d,offset,16);
  const state = { phase:d[8], bump:d[9], quoteDecimals:d[10], creator:key(16), mint:key(48), quoteMint:key(80), quoteTokenProgram:key(112), dammPool:key(144), position:key(176), nftMint:key(208), nftAccount:key(240), sqrtMinPrice:u128(272), sqrtMaxPrice:u128(288), liquidity:u128(304), saleBase:u64(320), reserveBase:u64(328), expectedQuote:u64(336), quoteUsdMicros:u64(344), createdUnix:u64(352), rentFloor:u64(360), pool:key(368), burnedLp:u64(400), quoteMigrated:u64(408), baseMigrated:u64(416), claimedProtocolQuote:u64(424),poolIndex:d.readUInt16LE(432) };
  ensure(state.quoteDecimals <= 18 && BigInt(state.saleBase) + BigInt(state.reserveBase) === BigInt(DAMM_PUMP_SUPPLY) && BigInt(state.sqrtMinPrice) > 0n && BigInt(state.sqrtMaxPrice) > BigInt(state.sqrtMinPrice) && BigInt(state.liquidity) > 0n, 'DAMM custody policy mismatch.');
  return state;
}
export async function mintSetupIxs({ programId = PUBLIC_PROGRAM_ID, creator, mintSeed, mintRentLamports, name, symbol, metadataUri, quoteMint = NATIVE_MINT, quoteTokenProgram = TOKEN_PROGRAM_ID }) {
  ensure(typeof mintSeed === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(mintSeed), 'Invalid mint seed.'); const payer = pk(creator), rent = uint(mintRentLamports,64); ensure(rent > 0n && rent <= BigInt(Number.MAX_SAFE_INTEGER), 'Invalid mint rent.');
  const mint = await PublicKey.createWithSeed(payer,mintSeed,TOKEN_PROGRAM_ID), a = addresses({ programId,mint,quoteMint,quoteTokenProgram,user:payer });
  return { mint:mint.toBase58(), addresses:a, instructions:[SystemProgram.createAccountWithSeed({fromPubkey:payer,newAccountPubkey:mint,basePubkey:payer,seed:mintSeed,lamports:Number(rent),space:82,programId:TOKEN_PROGRAM_ID}),createInitializeMint2Instruction(mint,6,payer,null),metadataIx({mint,creator:payer,name,symbol,metadataUri}),createSetAuthorityInstruction(mint,payer,AuthorityType.MintTokens,a.authority)] };
}
export function initializeIx({ programId = PUBLIC_PROGRAM_ID, creator, relayer, mint, quoteMint = NATIVE_MINT, quoteTokenProgram = TOKEN_PROGRAM_ID, quoteDecimals, quoteUsdMicros, expiresUnix, model }) {
  ensure(Number.isInteger(quoteDecimals) && quoteDecimals >= 0 && quoteDecimals <= 18, 'Unsupported quote decimals.'); ensure(!pk(creator).equals(pk(relayer)), 'Creator and relayer must differ.');
  const a = addresses({programId,mint,quoteMint,quoteTokenProgram,user:creator});
  const keys = [pk(creator),a.state,a.authority,a.mint,a.baseAta,a.quoteMint,a.quoteAta,a.config,pk(relayer),SystemProgram.programId,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,a.quoteTokenProgram,ASSOCIATED_TOKEN_PROGRAM_ID,a.dammProgram,a.dammAuthority,a.dammPool,a.position,a.nftMint,a.nftAccount,a.dammBaseVault,a.dammQuoteVault,a.dammEvent,a.baseBadge,a.quoteBadge,a.userQuoteAta];
  const data = Buffer.concat([Buffer.from([6]),enc(quoteUsdMicros,8),enc(expiresUnix,8),Buffer.from([quoteDecimals]),enc(model.sqrtMinPrice,16),enc(model.sqrtMaxPrice,16),enc(model.liquidity,16),enc(model.baseForSale ?? model.saleBase,8),enc(model.baseReserved ?? model.reserveBase,8),enc(model.finalQuote ?? model.expectedQuote,8)]);
  return new TransactionInstruction({programId:pk(programId),keys:keys.map((k,i)=>meta(k,[0,1,2,3,4,6,16,17,18,19,20,21,25].includes(i),[0,8].includes(i))),data});
}
export function migrateIx({ programId = PUBLIC_PROGRAM_ID, payer, mint, quoteMint = NATIVE_MINT, quoteTokenProgram = TOKEN_PROGRAM_ID, poolIndex = 0 }) {
  const a=addresses({programId,mint,quoteMint,quoteTokenProgram,poolIndex});
  const keys=[pk(payer),a.state,a.authority,a.mint,a.baseAta,a.quoteMint,a.quoteAta,a.dammProgram,a.dammAuthority,a.dammPool,a.position,a.nftMint,a.nftAccount,a.dammBaseVault,a.dammQuoteVault,a.dammEvent,a.pump,a.pumpGlobal,a.pool,a.lpMint,a.authorityLp,a.poolBase,a.poolQuote,SystemProgram.programId,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,a.quoteTokenProgram,ASSOCIATED_TOKEN_PROGRAM_ID,a.pumpEvent];
  return new TransactionInstruction({programId:pk(programId),keys:keys.map((k,i)=>meta(k,[0,1,2,4,6,9,10,13,14,18,19,20,21,22].includes(i),i===0)),data:Buffer.concat([Buffer.from([7]),enc(poolIndex,2)])});
}

export function protocolFeesIx({ programId = PUBLIC_PROGRAM_ID, payer, mint, quoteMint = NATIVE_MINT, quoteTokenProgram = TOKEN_PROGRAM_ID }) {
  const a=addresses({programId,mint,quoteMint,quoteTokenProgram}), treasury=pk(PUBLIC_TREASURY), treasuryQuote=ata(a.quoteMint,treasury,a.quoteTokenProgram);
  const keys=[pk(payer),a.state,a.authority,a.mint,a.baseAta,a.quoteMint,treasuryQuote,a.dammProgram,a.dammAuthority,a.dammPool,a.position,a.nftMint,a.nftAccount,a.dammBaseVault,a.dammQuoteVault,a.dammEvent,treasury,SystemProgram.programId,TOKEN_PROGRAM_ID,a.quoteTokenProgram,ASSOCIATED_TOKEN_PROGRAM_ID];
  return new TransactionInstruction({programId:pk(programId),keys:keys.map((k,i)=>meta(k,[0,1,4,6,10,13,14].includes(i),i===0)),data:Buffer.from([8])});
}
