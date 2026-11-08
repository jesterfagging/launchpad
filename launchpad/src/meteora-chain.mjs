import { PublicKey, Transaction, TransactionMessage, VersionedTransaction, TransactionInstruction, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, unpackMint, getTransferFeeConfig, getTransferHook } from '@solana/spl-token';
import BN from 'bn.js';
import { DynamicBondingCurveClient, DYNAMIC_BONDING_CURVE_PROGRAM_ID, DAMM_V2_PROGRAM_ID, DAMM_V2_MIGRATION_FEE_ADDRESS, deriveDbcPoolAddress, deriveDbcPoolAuthority, deriveDbcTokenVaultAddress, deriveDammV2PoolAddress, deriveDammV2PoolAuthority, derivePositionAddress, derivePositionNftAccount, getPriceFromSqrtPrice } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CpAmm, cpAmmCoder, MIN_SQRT_PRICE, MAX_SQRT_PRICE, getUnClaimLpFee, decodePodAlignedFeeTimeScheduler } from '@meteora-ag/cp-amm-sdk';
import { LaunchChain } from './launchpad-chain.mjs';
import { tokenConversion, buildTokenConversion, SOL_ROUTE_ACCOUNT_BUDGETS } from './launchpad-trading-route.mjs';
import { BASKET_LIMITS } from '../public/basket-catalog.mjs';
import { launchpadEnv } from './brand-env.mjs';
import { operatorCapacity } from './operator-capacity.mjs';
import { proveExpiredAbsence } from './meteora-expiry.mjs';
import { associatedTokenAccountSize } from './launchpad-token-account-size.mjs';
import { METEORA_POLICY, meteoraCurveConfig, meteoraPolicy, meteoraFeeNumerator, meteoraHookTokenOptions } from './meteora-policy.mjs';
import { HOOK_LIMITS, hookRuleById, hookRuleByKind, hookRuleParams, hookAppTradeNote } from '../public/hook-catalog.mjs';
import { displayUnits } from '../public/launchpad-model.mjs';

const pk = value => value instanceof PublicKey ? value : new PublicKey(value);
// Well-known program ids as PublicKeys of this module's web3 instance: the SDK constants when they are usable (a different bundled
// web3 copy still prints the same base58), the fixed mainnet addresses otherwise. The DBC id identifies the swap / fee-claim
// instruction whose trailing accounts the hook post-processing replaces (see patchHookAccounts).
const knownKey = (candidate, literal) => { try { const text = candidate?.toBase58?.(); if (typeof text === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) return new PublicKey(text); } catch {} return new PublicKey(literal); };
export const METEORA_DBC_PROGRAM_ID = knownKey(DYNAMIC_BONDING_CURVE_PROGRAM_ID, 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
const TOKEN_PROGRAM = knownKey(TOKEN_PROGRAM_ID, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), TOKEN_2022 = knownKey(TOKEN_2022_PROGRAM_ID, 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'), ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const sameKey = (a, b) => { try { return pk(a).equals(pk(b)); } catch { return false; } };
// Transfer hook rules (v71.28, v2 layouts). Rent estimates for the hook program's per-coin accounts: src/hooks/program.mjs exports the
// exact sizes (HOOK_CONFIG_SIZE, extraMetasSize(rules), BLOCKLIST_SIZE), which win; these fallbacks cover a module that lacks them
// (HookConfig v2 ≈ 780 bytes, 800 budgeted; BlockList = 8-byte header + 200 × 32; ExtraAccountMetaList = 16 + 35 × entries).
// A hooked base mint is Token-2022 with the TransferHook, MetadataPointer and TokenMetadata extensions (~530 bytes with Launchpad's
// metadata URI; 600 is budgeted) and its vault carries TransferHookAccount (171 bytes).
const HOOK_CONFIG_SIZE = 800, BLOCKLIST_SIZE = 8 + 200 * 32, HOOKED_MINT_SIZE = 600, HOOKED_VAULT_SIZE = 171;
// HookConfig prefix (contracts/curve-transfer-hook/README.md, unchanged in v2): version u8, bump u8, mint [32], creator [32], ...
const HOOK_CONFIG_MINT_OFFSET = 2, HOOK_CONFIG_CREATOR_OFFSET = 34;
/** The ExtraAccountMetaList shape a rule set needs (contracts/curve-transfer-hook/README.md), from the catalogue's flags; the encoder's hookShape wins when present. */
export const hookShapeOf = rules => {
  const ids = new Set((Array.isArray(rules) ? rules : []).map(r => r?.id)), items = [...ids].map(id => hookRuleById(id)).filter(Boolean);
  const sysvar = items.some(r => r.needsSysvar), blocklist = items.some(r => r.needsBlocklist), walletState = items.some(r => r.needsWalletState), allowlist = ids.has('allowlist'), holderGated = ids.has('holder_gated');
  return { sysvar, blocklist, walletState, allowlist, holderGated, count: 1 + (sysvar ? 1 : 0) + (blocklist ? 1 : 0) + (walletState ? 2 : 0) + (allowlist ? 1 : 0) + (holderGated ? 4 : 0) };
};
const hookExtraMetasSize = rules => 16 + 35 * hookShapeOf(rules).count;
// Blocklist writing: the first AddBlocked shares the hook-setup transaction with InitConfig and InitializeExtraAccountMetaList and
// carries as many wallets as the packet leaves room for (never more than 16); every further chunk is its own approval of ≤ 28
// wallets, the program's per-instruction limit (HOOK_LIMITS.blocklistBatch).
export const HOOK_SETUP_FIRST_CHUNK_MAX = 16;
/** Wallets of the blocklist that fit the hook-setup transaction next to InitConfig and InitializeExtraAccountMetaList. A v0 packet
 * holds 1232 bytes: the signature (65), version and header (4), eight static keys (257), the blockhash (32), the instruction and
 * lookup counts (2), the compute-unit instruction (8), the two setup instructions and AddBlocked's fixed bytes (11); `headroom` is left
 * for the wallet's own priority-fee instruction. A pure function so the arithmetic is testable. */
export function hookSetupFirstChunk({ initConfigDataLength, metasDataLength, total, max = HOOK_SETUP_FIRST_CHUNK_MAX, headroom = 64 }) {
  const compact = n => (n < 128 ? 1 : n < 16384 ? 2 : 3), ix = (accounts, data) => 1 + 1 + accounts + compact(data) + data;
  const fixed = 65 + 1 + 3 + (1 + 32 * 8) + 32 + 1 + 1 + 8 + ix(5, initConfigDataLength) + ix(6, metasDataLength) + (1 + 1 + 5 + 2 + 2);
  return Math.max(0, Math.min(max, HOOK_LIMITS.blocklistBatch, Math.max(0, Number(total) || 0), Math.floor((1232 - headroom - fixed) / 32)));
}
/** Approvals the hook-setup stage takes for a blocklist of `total` wallets whose first `first` ride with the setup instructions. */
export const hookSetupSteps = (total, first) => 1 + Math.ceil(Math.max(0, total - first) / HOOK_LIMITS.blocklistBatch);
const HOOK_LAYOUT_ERROR = 'The Meteora SDK returned an unexpected hook account layout. No transaction was built.';
const hookFailure = (hook, logs, errors) => {
  // A failed simulation names the failing program in its logs. Only a custom error
  // raised by the coin's own hook program is read as a rule; DBC and token errors
  // keep the generic message (their custom codes overlap the 6000 range).
  if (!hook?.program || !Array.isArray(logs)) return null;
  for (const line of logs) {
    const match = /^Program (\S+) failed: custom program error: 0x([0-9a-fA-F]+)$/.exec(String(line));
    if (!match || match[1] !== hook.program) continue;
    const code = Number.parseInt(match[2], 16), known = errors?.[code] || errors?.[String(code)] || null;
    // 6001–6025 = 6000 + the rule kind (the catalogue's hookRuleByKind); the coin's own rule list is consulted first.
    const rule = (hook.rules || []).map(r => hookRuleById(r.id)).find(r => r && 6000 + r.kind === code) || (code > 6000 && code <= 6025 ? hookRuleByKind(code - 6000) : null);
    const text = typeof known === 'string' ? known : known?.message || known?.text || null;
    return { code, name: rule?.name || known?.name || `error ${code}`, message: text || (rule ? rule.rule : 'The hook program refused this transfer.') };
  }
  return null;
};
const str = value => value?.toBase58?.() ?? value?.toString?.() ?? String(value);
const raw = value => new BN(String(value ?? '0'),10);
const ensure = (condition,message) => { if (!condition) throw Object.assign(new Error(message),{statusCode:409}); };
const U64MAX = new BN('18446744073709551615');
const DEFAULT_DAMM_CONFIG = DAMM_V2_MIGRATION_FEE_ADDRESS[6];
const safeJson = value => JSON.parse(JSON.stringify(value,(_,v)=>typeof v==='bigint'?String(v):v));
// Simulation failures in plain words (v71.34). The runtime's own log lines decide the sentence, never a bare custom code (System,
// the Token programs and Meteora all use small numbers): the System program logs exactly how many lamports a transfer or account
// creation lacked, the Token programs log "insufficient funds", Anchor programs (Meteora's) log their error message. Anything else
// names the failing instruction and its program for support. The sentences also carry `code: 'METEORA_GAS'` and the shortfall on
// the thrown error so the worker can keep the exact words for the administrator.
const SYSTEM_PROGRAM = SystemProgram.programId.toBase58(), COMPUTE_BUDGET_PROGRAM = ComputeBudgetProgram.programId.toBase58(), METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const DAMM_V2_PROGRAM = knownKey(DAMM_V2_PROGRAM_ID, 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
const PROGRAM_NAMES = { [SYSTEM_PROGRAM]: 'the System program', [COMPUTE_BUDGET_PROGRAM]: 'the Compute Budget program', [str(TOKEN_PROGRAM)]: 'the Token program', [str(TOKEN_2022)]: 'the Token-2022 program', [str(ATA_PROGRAM)]: 'the Associated Token program', [str(METEORA_DBC_PROGRAM_ID)]: 'Meteora’s bonding-curve program', [str(DAMM_V2_PROGRAM)]: 'Meteora DAMM v2', [METADATA_PROGRAM]: 'Metaplex Token Metadata' };
const sol = lamports => displayUnits(lamports, 9);
const STEP_PURPOSE = { configure: 'pay for the curve configuration (account rent and network fees)', initialize: 'create the coin (account rent and network fees)', 'initialize-buy': 'create the coin and make the first buy (account rent, the first buy and network fees)', buy: 'complete this trade (token-account rent and network fees)', sell: 'complete this trade (token-account rent and network fees)', 'hook-allow': 'pay for the allowlist entries', migrate: 'graduate this coin (the DAMM v2 pool, its positions and network fees)', 'creator-claim': 'claim this coin’s fees (token-account rent and network fees)', 'partner-claim': 'claim this coin’s fees (token-account rent and network fees)', payout: 'send these rewards (recipient token-account rent and network fees)', 'partner-payout': 'send the protocol share (token-account rent and network fees)', 'basket-convert': 'convert this reward share (token-account rent and network fees)' };
/** The failing instruction of a simulation result: its index, custom code (or error kind) and the program id the message names for it. */
export function simulationFailure(tx, err) {
  const failure = err?.InstructionError;
  if (!Array.isArray(failure) || !Number.isSafeInteger(failure[0]) || failure[0] < 0) return null;
  const index = failure[0], detail = failure[1];
  const code = detail && typeof detail === 'object' && Number.isSafeInteger(detail.Custom) ? detail.Custom : null, kind = typeof detail === 'string' ? detail : null;
  let program = null;
  try { const message = tx?.message, ix = message?.compiledInstructions?.[index], key = ix ? message.staticAccountKeys?.[ix.programIdIndex] : null; program = key ? str(key) : null; } catch { program = null; }
  return { index, code, kind, program };
}
/** What the runtime logged about a failure: a lamport shortfall (System transfers and account creations, also inside another
 * program's call), a token shortfall (the Token programs), an Anchor error message, and the last "Program … failed" reason. */
export function simulationLogs(logs) {
  const out = { shortfallLamports: null, insufficientTokens: false, anchor: null, failed: null };
  for (const line of Array.isArray(logs) ? logs : []) {
    const text = String(line);
    const shortage = /^Transfer: insufficient lamports (\d{1,20}), need (\d{1,20})$/.exec(text);
    if (shortage) { const have = BigInt(shortage[1]), need = BigInt(shortage[2]); if (need > have && need <= 18446744073709551615n) out.shortfallLamports = (need - have).toString(); continue; }
    if (/^Program log: Error: insufficient funds$/i.test(text)) { out.insufficientTokens = true; continue; }
    const anchor = /^Program log: AnchorError .*?Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.+?)\.?$/.exec(text);
    if (anchor) { out.anchor = { code: anchor[1], number: Number(anchor[2]), message: anchor[3] }; continue; }
    const failed = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed: (.+)$/.exec(text);
    if (failed) out.failed = { program: failed[1], reason: failed[2] };
  }
  return out;
}
/** The sentence for a failed simulation that is not a hook rule: who is short of what, or which instruction of which program failed.
 * `action` is the prepared step, `firstBuy` whether the create stage carries a first buy, `managed` whether the payer is Launchpad's
 * Meteora gas wallet (the worker's steps) rather than the person's connected wallet. */
export function describeSimulationFailure({ tx, value, action = '', firstBuy = false, managed = false, quoteSymbol = '', coinSymbol = '', quoteMint = '', coinMint = '' } = {}) {
  const err = value?.err, failure = simulationFailure(tx, err), logs = simulationLogs(value?.logs);
  const payer = managed ? 'Launchpad’s Meteora gas wallet' : 'Your wallet', purpose = STEP_PURPOSE[action === 'initialize' && firstBuy ? 'initialize-buy' : action] || 'complete this step';
  const topUp = managed ? ' Top it up from the Meteora admin page; this step retries on its own.' : '';
  const program = failure?.program || null, custom1 = failure?.code === 1;
  const systemShort = logs.shortfallLamports !== null || custom1 && (program === SYSTEM_PROGRAM || program === str(ATA_PROGRAM));
  const tokenShort = !systemShort && (logs.insufficientTokens || custom1 && (program === str(TOKEN_PROGRAM) || program === str(TOKEN_2022)));
  if (systemShort) {
    const amount = logs.shortfallLamports !== null ? `about ${sol(logs.shortfallLamports)} more SOL` : 'more SOL';
    return { code: 'METEORA_GAS', shortfallLamports: logs.shortfallLamports, message: `${payer} needs ${amount} to ${purpose}. Nothing was signed or spent.${topUp}` };
  }
  if (tokenShort) {
    const selling = action === 'sell', symbol = selling ? coinSymbol || 'this coin' : quoteSymbol || 'the pair asset', mint = selling ? coinMint : quoteMint, named = `${symbol}${mint ? ` (contract address ${mint})` : ''}`;
    const what = action === 'initialize' ? 'the first buy' : action === 'buy' || selling ? 'this trade' : 'this step';
    const advice = action === 'initialize' ? ` A Meteora first buy is paid in the pair asset from your wallet, so buy ${named} into your wallet or launch without a first buy.` : !selling && !managed ? ` Buy ${named} into your wallet and try again.` : '';
    return { code: 'METEORA_FUNDS', shortfallLamports: null, message: `${payer} does not hold enough ${symbol} for ${what}.${advice} Nothing was signed or spent.` };
  }
  if (logs.anchor) return { code: 'METEORA_REFUSED', shortfallLamports: null, message: `Meteora refused this transaction: ${logs.anchor.message}. No transaction was submitted.` };
  const reason = logs.failed?.reason && !failure?.kind ? logs.failed.reason : '', name = program ? PROGRAM_NAMES[program] || `program ${program}` : '';
  const where = failure && (name || reason) ? ` (instruction ${failure.index}${name ? `, ${name}` : ''}${reason ? ` — ${reason}` : ''})` : '';
  return { code: 'METEORA_SIMULATION', shortfallLamports: null, message: `Meteora simulation failed: ${JSON.stringify(err)}${where}. No transaction was submitted.` };
}
const validAmount = value => { ensure(/^\d+$/.test(String(value)) && BigInt(value)>0n && BigInt(value)<=18446744073709551615n,'Invalid token amount.'); return raw(value); };
const slippage = value => { ensure(Number.isInteger(value)&&value>=0&&value<=10000,'Slippage must be between 0% and 100%.'); return value; };
const tokenDelta = (receipt,mint,owner) => {
  const sum = rows => (rows||[]).filter(x=>x.mint===mint&&x.owner===owner).reduce((n,x)=>n+BigInt(x.uiTokenAmount.amount),0n);
  return sum(receipt.meta.postTokenBalances)-sum(receipt.meta.preTokenBalances);
};
const transfers = receipt => [...(receipt.transaction.message.instructions||[]),...(receipt.meta.innerInstructions||[]).flatMap(x=>x.instructions||[])];
const tokenTransfers = receipt => transfers(receipt).filter(x=>[TOKEN_PROGRAM_ID.toBase58(),TOKEN_2022_PROGRAM_ID.toBase58()].includes(str(x.programId))&&['transfer','transferChecked'].includes(x.parsed?.type));
const transferAmount = ix => BigInt(ix.parsed.info.amount??ix.parsed.info.tokenAmount.amount);

/** No signer secrets or network submission policy live here; the service journals exact signed wire bytes. */
export class MeteoraChainAdapter {
  constructor({connection,rpcUrl,rpcGate,rpcRequestsPerSecond,jupiterKey='',routes=null,fetcher=null,now=Date.now}={}) {
    if(!connection){const endpoint=rpcUrl||launchpadEnv('PUBLIC_RPC_URL')||'https://api.mainnet-beta.solana.com';this.transport=new LaunchChain({network:'mainnet-beta',rpcUrl:endpoint,rpcGate,rpcRequestsPerSecond:rpcRequestsPerSecond??operatorCapacity({rpcUrl:endpoint}).rpcRequestsPerSecond,jupiterKey});}
    else if(fetcher)this.transport=new LaunchChain({network:'mainnet-beta',connection,fetcher,rpcGate,jupiterKey});
    this.connection=connection||this.transport.c; this.c=this.connection; this.now=now;
    // Reward baskets (v71.33) convert through Jupiter with the shared audited route builders; tests inject fakes.
    this.routes=routes||{tokenConversion,buildTokenConversion};
    this.dbc=DynamicBondingCurveClient.create(this.connection,'finalized'); this.cp=new CpAmm(this.connection);
  }
  /** Reward baskets need a Jupiter route builder: the RPC transport (with or without an API key) provides it. */
  basketsAvailable(){return !!this.transport&&typeof this.transport.fetcher==='function';}
  close(){this.transport?.close?.();}
  poolAddress(launch){return deriveDbcPoolAddress(pk(launch.quoteMint),pk(launch.mint),pk(launch.configAddress));}
  dammAddress(launch){return deriveDammV2PoolAddress(DEFAULT_DAMM_CONFIG,pk(launch.mint),pk(launch.quoteMint));}
  quoteProgram(launch){return pk(launch.quoteProgram||TOKEN_PROGRAM_ID);}
  /** A hooked coin (launch.hook) is a Token-2022 mint; every other Meteora coin is an ordinary SPL mint. */
  baseProgram(launch){return launch.hook?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID;}
  quoteAccountSize(launch,quoteMintState){return associatedTokenAccountSize({mint:quoteMintState,program:this.quoteProgram(launch)});}
  policyFor(launch){return launch.policy||{migrationFeePercentage:launch.migrationFeePercentage??0};}
  feePolicy(launch){return meteoraPolicy(this.policyFor(launch));}
  expectedConfig(launch){return meteoraCurveConfig({quoteUsd:Number(launch.priceSnapshot?.usd),quoteDecimals:launch.quoteDecimals,policy:this.policyFor(launch),hooked:!!launch.hook});}
  // ---- Transfer hook rules (v71.28, contract v2). The hook program id, PDAs, exempt keys, venue and the frozen plan live on the launch
  // record (launch.hook); this adapter derives nothing from live settings. src/hooks/program.mjs (the instruction encoder) is loaded on first use.
  async hooksModule(){return this.hooks||=await import('./hooks/program.mjs');}
  poolAuthority(){return deriveDbcPoolAuthority();}
  /** The DAMM v2 pool authority: the destination owner of the graduation transfer (base vault → DAMM v2 vault). It is exempt slot 3 so
   * a wallet cap can never block graduation even if the hook were still attached at that moment; the hook never tests a venue's own
   * owner, so the DBC pool authority needs no slot. */
  dammPoolAuthority(){return deriveDammV2PoolAuthority();}
  baseVaultAddress(launch){return deriveDbcTokenVaultAddress(this.poolAddress(launch),pk(launch.mint));}
  /** web3 TransactionInstruction from an encoder result { programId, keys, data }. */
  instruction(built){return new TransactionInstruction({programId:pk(built.programId),keys:built.keys.map(k=>({pubkey:pk(k.pubkey),isSigner:!!k.isSigner,isWritable:!!k.isWritable})),data:Buffer.from(built.data||[])});}
  /** A System transfer of lamports (the tithe donation a trade carries), behind a seam so tests can inspect it. */
  systemTransfer({from,to,lamports}){return SystemProgram.transfer({fromPubkey:pk(from),toPubkey:pk(to),lamports:BigInt(lamports)});}
  /** The associated token account of `owner` for `mint` (off-curve owners allowed: the managed authorities are PDAs' peers), behind a seam. */
  associatedToken(mint,owner,program){return getAssociatedTokenAddressSync(pk(mint),pk(owner),true,program);}
  /** The addresses a hooked launch records when it is created; prepareLaunch derives them again and refuses a record that differs. */
  async hookAddresses({mint,quoteMint,configAddress,program}){
    const hooks=await this.hooksModule(),programId=pk(program),base=pk(mint),launch={mint,quoteMint,configAddress};
    return {program:programId.toBase58(),configPda:str(pk(hooks.hookConfigPda(programId,base).address)),extraMetasPda:str(pk(hooks.extraMetasPda(programId,base).address)),blocklistPda:typeof hooks.blocklistPda==='function'?str(pk(hooks.blocklistPda(programId,base).address)):null,poolAuthority:this.poolAuthority().toBase58(),dammPoolAuthority:this.dammPoolAuthority().toBase58(),dbcPool:this.poolAddress(launch).toBase58(),baseVault:this.baseVaultAddress(launch).toBase58()};
  }
  /** Whether the configured hook program is deployed (executable) on this cluster; null when the RPC did not answer. */
  async hookProgramInfo(program){try{const a=await this.connection.getAccountInfo(pk(program),'finalized');return {programId:str(program),executable:a?.executable===true};}catch{return {programId:str(program),executable:null};}}
  /** Refuses any hooked transaction while the hook program is not deployed: no creator pays for a Token-2022 config it cannot use. */
  async requireHookProgram(hook){const program=await this.hookProgramInfo(hook.program);if(program.executable!==true)throw Object.assign(new Error('The transfer hook program is not deployed on this cluster. Hooked launches wait until the host owner deploys it.'),{statusCode:503});return program;}
  /** The hook setup state of a launch: whether its HookConfig and ExtraAccountMetaList PDAs exist (`exists`) and, for a blocklist
   * coin, how many of the planned wallets the on-chain BlockList holds (`blocklist.count` of `total`); `ready` = everything written,
   * the pool may be created. An existing config must be the creator's own for this mint (mint and creator fields); a blocklist whose
   * wallets are not the saved plan's prefix is refused rather than built upon. */
  async hookSetupState(launch,commitment='confirmed',minContextSlot){
    const hook=launch.hook,program=pk(hook.program),options={commitment,...(minContextSlot===undefined?{}:{minContextSlot})},blocklisted=hook.needsBlocklist===true;
    if(blocklisted)ensure(typeof hook.blocklistPda==='string'&&Array.isArray(hook.blocklist)&&hook.blocklist.length>0,'The saved blocklist is invalid.');
    const total=blocklisted?hook.blocklist.length:0;
    const [config,metas,block]=await this.connection.getMultipleAccountsInfo([pk(hook.configPda),pk(hook.extraMetasPda),...(blocklisted?[pk(hook.blocklistPda)]:[])],options);
    if(!config&&!metas){ensure(!block,'The transfer hook accounts are in an unexpected state. Check the launch’s saved transactions.');return {ready:false,exists:false,config:null,metas:null,blocklist:blocklisted?{exists:false,count:0,total,complete:false}:null};}
    ensure(config&&metas,'The transfer hook accounts are in an unexpected state. Check the launch’s saved transactions.');
    ensure(config.owner.equals(program)&&metas.owner.equals(program),'The transfer hook accounts were not created by the hook program.');
    const data=Buffer.from(config.data);ensure(data.length>=HOOK_CONFIG_CREATOR_OFFSET+32&&data[0]>=1&&new PublicKey(data.subarray(HOOK_CONFIG_MINT_OFFSET,HOOK_CONFIG_MINT_OFFSET+32)).equals(pk(launch.mint))&&new PublicKey(data.subarray(HOOK_CONFIG_CREATOR_OFFSET,HOOK_CONFIG_CREATOR_OFFSET+32)).equals(pk(launch.creatorWallet)),'The transfer hook configuration on chain does not belong to this launch.');
    let blocklist=null;
    if(blocklisted){
      let count=0;
      if(block){ensure(block.owner.equals(program),'The transfer hook accounts were not created by the hook program.');const hooks=await this.hooksModule(),decoded=hooks.decodeBlocklist(Buffer.from(block.data));count=Number(decoded.count);const wallets=(decoded.wallets||[]).slice(0,count);ensure(Number.isInteger(count)&&count>=0&&count<=total&&wallets.length===count&&wallets.every((w,i)=>str(w)===hook.blocklist[i]),'The blocklist on chain differs from the saved launch.');}
      blocklist={exists:!!block,count,total,complete:count>=total};
    }
    return {ready:!blocklist||blocklist.complete,exists:true,config,metas,blocklist};
  }
  /** Holder-gated rules: the gate token's program and decimals, read from chain. Null when the mint does not exist. */
  async hookGateMint(mint){
    const a=await this.connection.getAccountInfo(pk(mint),'finalized');if(!a)return null;
    ensure(a.owner.equals(TOKEN_PROGRAM_ID)||a.owner.equals(TOKEN_2022_PROGRAM_ID),'The gate token is not an SPL or Token-2022 mint.');
    const m=unpackMint(pk(mint),a,a.owner);ensure(m.isInitialized,'The gate token mint is not initialized.');
    return {mint:str(mint),program:a.owner.toBase58(),decimals:m.decimals};
  }
  /** The exact on-chain rule parameters (public/hook-catalog.mjs is the single source of these numbers): kind + six u64 decimal strings. */
  hookRules(hook){
    ensure(Array.isArray(hook?.rules)&&hook.rules.length>0&&hook.rules.length<=4,'The saved transfer hook rules are invalid.');
    // An app-only rule (v71.36) carries the app's mark, frozen on the record at launch: its key as four packed parameters, its kind and slot.
    let appMark=null;if(hook.route==='app'){const m=hook.appMark;ensure(m&&typeof m==='object'&&typeof m.key==='string'&&m.key&&typeof m.kind==='string','This app-only launch has no app mark recorded.');appMark={kind:m.kind,keyBytes:pk(m.key).toBytes(),index:m.index||0};}
    return hook.rules.map(r=>({kind:r.kind,params:hookRuleParams(r.id,r.settings,{gateDecimals:hook.gateDecimals||0,decimals:METEORA_POLICY.decimals,appMark})}));
  }
  /** The N accounts a hooked DBC instruction carries for one transfer, resolved by Launchpad's encoder from the known owners: the extra
   * accounts in ExtraAccountMetaList order (config first), then the hook program and the list PDA. */
  async hookRemainingAccounts(launch,{sourceOwner,destinationOwner}){
    const hooks=await this.hooksModule(),hook=launch.hook;
    const metas=hooks.hookRemainingAccounts({programId:pk(hook.program),mint:pk(launch.mint),sourceOwner:pk(sourceOwner),destinationOwner:pk(destinationOwner),rules:hook.rules,gateMint:hook.gateMint?pk(hook.gateMint):null,gateTokenProgram:hook.gateTokenProgram?pk(hook.gateTokenProgram):null});
    const block=metas.map(meta=>({pubkey:pk(meta.pubkey),isSigner:false,isWritable:meta.isWritable===true})),n=block.length;
    ensure(n>=3&&block[0].pubkey.equals(pk(hook.configPda))&&block[n-2].pubkey.equals(pk(hook.program))&&block[n-1].pubkey.equals(pk(hook.extraMetasPda)),'The hook account resolution does not match the saved launch.');
    return block;
  }
  /** "Launchpad route" post-processing (contracts/curve-transfer-hook/README.md). The SDK resolves the hook's extra accounts with PublicKey.default standing in for
   * the source, destination and owner, so every entry derived from a trader (wallet records, allow entries, gate token accounts) is a
   * placeholder; mint-derived and literal entries are right already. The SDK appends `types` identical blocks of N keys (N = list
   * entries + 2: the resolved metas, the hook program, the list PDA) at the end of the DBC instruction; each block is replaced here by
   * Launchpad's own resolution after checking it starts with the config PDA and ends with [hook program, list PDA]. Only keys change: the
   * instruction data (and its slice lengths) is untouched because N is unchanged. Anything else is refused. */
  async patchHookAccounts(instructions,launch,{sourceOwner,destinationOwner,blocks=1}){
    const hook=launch.hook,block=await this.hookRemainingAccounts(launch,{sourceOwner,destinationOwner}),n=block.length;
    const targets=instructions.filter(ix=>sameKey(ix.programId,METEORA_DBC_PROGRAM_ID));ensure(targets.length===1,HOOK_LAYOUT_ERROR);
    const keys=targets[0].keys;ensure(Array.isArray(keys)&&keys.length>n*blocks,HOOK_LAYOUT_ERROR);
    for(let b=0;b<blocks;b++){
      const start=keys.length-n*(blocks-b),segment=keys.slice(start,start+n);
      ensure(sameKey(segment[0].pubkey,hook.configPda)&&sameKey(segment[n-2].pubkey,hook.program)&&sameKey(segment[n-1].pubkey,hook.extraMetasPda),HOOK_LAYOUT_ERROR);
      for(let i=0;i<n;i++)keys[start+i]={pubkey:block[i].pubkey,isSigner:false,isWritable:block[i].isWritable};
    }
    return {instruction:targets[0],replaced:n*blocks};
  }
  /** The connection the SDK's hooked builders resolve extra accounts through. spl-token resolves a seed that reads an owner out of a
   * token account (data(0)[32..64], data(2)[32..64]) by fetching that account; with PublicKey.default standing in for the source and
   * destination it fetches the System Program's account, whose 14 bytes cannot be sliced, and throws TokenTransferHookInvalidSeed.
   * This view answers that one read with a blank token account so the resolution completes with placeholder keys of the right
   * count — which patchHookAccounts replaces. Every other read passes through to the real connection. */
  hookResolutionConnection(){
    const target=this.connection;
    return this.resolutionConnection||=new Proxy(target,{get(connection,key){
      if(key==='getAccountInfo')return async(address,...rest)=>sameKey(address,PublicKey.default)?{data:Buffer.alloc(165),owner:TOKEN_2022,lamports:0,executable:false,rentEpoch:0}:connection.getAccountInfo(address,...rest);
      const value=Reflect.get(connection,key);return typeof value==='function'?value.bind(connection):value;
    }});
  }
  /** The DBC client used for hooked swaps and fee claims (see hookResolutionConnection). */
  dbcForHooks(){return this.hookedDbc||=DynamicBondingCurveClient.create(this.hookResolutionConnection(),'finalized');}
  // SDK calls for hooked coins, each behind its own method so tests can replace the SDK (@meteora-ag/dynamic-bonding-curve-sdk 1.5.x,
  // verified against its source: createConfigWithTransferHook takes transferHookProgram; swap2WithTransferHook resolves the hook
  // accounts itself and carries them as the instruction's trailing remaining accounts, which patchHookAccounts replaces). Fee claims
  // are built from the program's own `…2` methods in prepareClaim, with the hook accounts Launchpad resolves.
  sdkCreateConfigWithTransferHook(params){return this.dbc.partner.createConfigWithTransferHook({...params,...meteoraHookTokenOptions()});}
  sdkCreatePoolWithTransferHook(params){return this.dbc.creator.createPoolWithTransferHook(params);}
  sdkSwap2WithTransferHook(params){return this.dbcForHooks().pool.swap2WithTransferHook(params);}
  /** The on-chain PoolConfig of the curve created in stage 1; its swapBaseAmount is written into the hook config at setup. */
  sdkPoolConfig(config){return this.dbc.state.getPoolConfig(pk(config));}
  async sdkInstructions(result){const tx=await result;return tx.instructions??(await tx.transaction()).instructions;}
  async readAccount(address,program,commitment='finalized',minContextSlot){
    const result=await this.connection.getAccountInfoAndContext(pk(address),{commitment,...(minContextSlot===undefined?{}:{minContextSlot})});
    if(result.value)ensure(result.value.owner.equals(program),'Meteora account owner does not match the expected program.');
    return result;
  }
  async config(launch,minContextSlot){
    const r=await this.readAccount(launch.configAddress,DYNAMIC_BONDING_CURVE_PROGRAM_ID,'finalized',minContextSlot);
    if(!r.value)return null;
    // A hooked launch's config is Meteora's `ConfigWithTransferHook` (its own discriminator; `config` embeds the PoolConfig and
    // `transferHookProgram` names the hook); a plain launch's is `PoolConfig`. Decoding the other kind fails on the discriminator.
    const c=this.decodePoolConfig(launch,r.value.data),e=this.expectedConfig(launch);
    ensure(str(c.quoteMint)===launch.quoteMint&&str(c.feeClaimer)===launch.partnerAuthority&&str(c.leftoverReceiver)===(launch.leftoverReceiver||launch.partnerAuthority),'Meteora config fee destinations differ from the registered launch.');
    for(const k of ['collectFeeMode','migrationOption','activationType','tokenType','tokenDecimal','partnerLiquidityPercentage','partnerPermanentLockedLiquidityPercentage','creatorLiquidityPercentage','creatorPermanentLockedLiquidityPercentage','migrationFeeOption','creatorTradingFeePercentage','tokenUpdateAuthority'])ensure(str(c[k])===str(e[k]),`Meteora config ${k} does not match launch policy.`);
    const policy=this.feePolicy(launch);
    for(const [k,v] of Object.entries({migrationFeePercentage:0,creatorMigrationFeePercentage:0,migratedPoolFeeBps:policy.tradingFeeBps,migratedCollectFeeMode:0,migratedDynamicFee:0,poolCreationFee:0,preMigrationTokenSupply:'1000000000000000',postMigrationTokenSupply:'1000000000000000'}))ensure(str(c[k])===String(v),`Meteora config ${k} does not match launch policy.`);
    ensure(str(c.sqrtStartPrice)===str(e.sqrtStartPrice)&&str(c.migrationQuoteThreshold)===str(e.migrationQuoteThreshold),'Meteora curve targets differ from the saved quote price.');
    ensure(str(c.poolFees.baseFee.cliffFeeNumerator)===meteoraFeeNumerator(this.policyFor(launch))&&c.poolFees.baseFee.firstFactor===0&&str(c.poolFees.baseFee.secondFactor)==='0'&&str(c.poolFees.baseFee.thirdFactor)==='0'&&c.poolFees.baseFee.baseFeeMode===0&&!c.poolFees.dynamicFee?.initialized,'Meteora trading fee is not the configured fixed fee.');
    for(let i=0;i<c.curve.length;i++){const expected=e.curve[i];ensure(expected?str(c.curve[i].sqrtPrice)===str(expected.sqrtPrice)&&str(c.curve[i].liquidity)===str(expected.liquidity):str(c.curve[i].sqrtPrice)==='0'&&str(c.curve[i].liquidity)==='0','Meteora curve liquidity differs from launch policy.');}
    return c;
  }
  /** Decodes a DBC pool config account: `configWithTransferHook` (whose `config` embeds the PoolConfig) for a hooked launch, `poolConfig`
   * otherwise. The hooked kind must name the launch's hook program. Verified against the program's state/config.rs and the SDK's
   * getPoolConfig, which tries both discriminators the same way. */
  decodePoolConfig(launch,data){
    const coder=this.dbc.state.getProgram().coder.accounts;
    if(!launch.hook)return coder.decode('poolConfig',data);
    const wrapped=coder.decode('configWithTransferHook',data);
    ensure(wrapped?.config&&str(wrapped.transferHookProgram)===launch.hook.program,'The Meteora config on chain does not carry this launch’s transfer hook program.');
    return wrapped.config;
  }
  /** Decodes a DBC pool account: `transferHookPool` for a hooked launch, `virtualPool` otherwise. Both embed the same `poolState`
   * (program state/virtual_pool.rs) under their own discriminators; the SDK's getPool tries both the same way. */
  decodePool(launch,data){return this.dbc.state.getProgram().coder.accounts.decode(launch.hook?'transferHookPool':'virtualPool',data);}
  async rawState(launch,minContextSlot){
    const address=this.poolAddress(launch),r=await this.readAccount(address,DYNAMIC_BONDING_CURVE_PROGRAM_ID,'finalized',minContextSlot);
    if(!r.value)return null;
    const virtual=this.decodePool(launch,r.value.data),p=virtual.poolState||virtual,c=await this.config(launch,minContextSlot);
    ensure(c&&str(p.baseMint)===launch.mint&&str(p.config)===launch.configAddress&&str(p.creator)===launch.creatorAuthority,'Meteora pool identity does not match the registered launch.');
    return {pool:p,virtual,config:c,slot:r.context.slot,address};
  }
  async migrationCheck(info={}){
    try{
      if(!this.migrationConfigCache||this.now()-this.migrationConfigCache.at>60000){
        if(!this.migrationConfigLoading)this.migrationConfigLoading=(async()=>{const r=await this.readAccount(DEFAULT_DAMM_CONFIG,DAMM_V2_PROGRAM_ID);ensure(r.value,'Meteora migration config is unavailable.');return {at:this.now(),slot:r.context.slot,config:this.cp._program.coder.accounts.decode('config',r.value.data)};})();
        try{this.migrationConfigCache=await this.migrationConfigLoading;}finally{this.migrationConfigLoading=null;}
      }
      const c=this.migrationConfigCache.config;
      // The official Customizable migration config stores zero range placeholders.
      // DBC's initialize_pool_with_dynamic_config CPI supplies the full range.
      ensure(str(c.poolCreatorAuthority)===str(deriveDbcPoolAuthority())&&c.configType===1&&str(c.sqrtMinPrice)==='0'&&str(c.sqrtMaxPrice)==='0'&&pk(c.vaultConfigKey).equals(PublicKey.default),'Meteora migration configuration is not the expected DBC full-range config.');
      if(info.requiresTokenBadge)ensure((BigInt(str(c.permission))&1n)!==0n,'Meteora graduation config does not permit this quote mint.');
      return {supported:true,config:DEFAULT_DAMM_CONFIG.toBase58(),slot:this.migrationConfigCache.slot};
    }catch(error){return {supported:false,config:DEFAULT_DAMM_CONFIG.toBase58(),reason:error.message};}
  }
  async readiness({authority,treasury,hookProgramId=null}={}){
    const blockers=[];
    try{ensure(await this.connection.getGenesisHash()==='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d','The Meteora RPC must be Solana mainnet.');for(const id of [DYNAMIC_BONDING_CURVE_PROGRAM_ID,DAMM_V2_PROGRAM_ID]){const a=await this.connection.getAccountInfo(id,'finalized');ensure(a?.executable,'A required Meteora program is unavailable.');}const m=await this.migrationCheck({requiresTokenBadge:false});if(!m.supported)blockers.push(m.reason);pk(treasury);pk(authority);}catch(e){blockers.push(e.message);}
    const minimumBalanceLamports='100000000';let balanceLamports='0';try{balanceLamports=String(await this.connection.getBalance(pk(authority),'finalized'));if(BigInt(balanceLamports)<BigInt(minimumBalanceLamports))blockers.push('The Meteora gas wallet needs at least 0.1 SOL to create graduation positions and claim fees.');}catch(e){blockers.push(e.message);}
    // Transfer hook rules are optional: an undeployed hook program is reported, never a blocker for ordinary launches.
    const hookProgram=hookProgramId?await this.hookProgramInfo(hookProgramId):null;
    return {ready:blockers.length===0,blockers,minimumBalanceLamports,balanceLamports,policy:METEORA_POLICY,hookProgram};
  }
  async verifyQuote(launch){
    const a=await this.connection.getAccountInfo(pk(launch.quoteMint),'finalized');ensure(a&&a.owner.equals(this.quoteProgram(launch)),'The quote mint token program changed.');
    const mint=unpackMint(pk(launch.quoteMint),a,a.owner);ensure(mint.isInitialized&&mint.decimals===launch.quoteDecimals,'The quote mint decimals changed.');
    const fee=getTransferFeeConfig(mint);ensure(!fee||fee.olderTransferFee.transferFeeBasisPoints===0&&fee.newerTransferFee.transferFeeBasisPoints===0,'Transfer-tax quote tokens are not supported by this Meteora launch mode.');
    const hook=getTransferHook(mint);ensure(!hook||hook.programId.equals(PublicKey.default),'Transfer-hook quote tokens require a separate reviewed trading integration.');
    const migration=await this.migrationCheck({requiresTokenBadge:!!launch.tokenBadge});ensure(migration.supported,migration.reason);return mint;
  }
  /** The sentence shown when a simulation fails. A hooked coin's rule failure is recognised from the hook program's own log line
   * (never from a bare custom code, which DBC and the token program also use) and said in plain words: the encoder's
   * hookErrorMessage (src/hooks/program.mjs) first, its HOOK_ERRORS table or the catalogue's rule text otherwise. Every other
   * failure is described by describeSimulationFailure: a SOL or token shortfall of the payer with the amount, Meteora's own error
   * message, or the failing instruction and its program. `context` carries the prepared transaction and step. */
  async simulationFailureMessage(launch,value,context={}){
    const hooks=launch?.hook?await this.hooksModule().catch(()=>null):null,rule=launch?.hook?hookFailure(launch.hook,value?.logs,hooks?.HOOK_ERRORS):null;
    if(!rule)return this.simulationFailureDetail(launch,value,context).message;
    let sentence=null;
    if(typeof hooks?.hookErrorMessage==='function')for(const input of [value,value?.err,{code:rule.code}]){try{const text=hooks.hookErrorMessage(input,{programId:launch.hook.program});if(typeof text==='string'&&text.trim()){sentence=text.trim();break;}}catch{}}
    return `This transfer breaks the coin’s rule: ${rule.name}. ${sentence||rule.message} No transaction was submitted.`;
  }
  simulationFailureDetail(launch,value,{tx=null,action='',wallet=null,firstBuy=false}={}){
    const managed=!!wallet&&!!launch?.partnerAuthority&&wallet===launch.partnerAuthority;
    return describeSimulationFailure({tx,value,action,firstBuy,managed,quoteSymbol:launch?.quoteSymbol||'',coinSymbol:launch?.symbol||'',quoteMint:launch?.quoteMint||'',coinMint:launch?.mint||''});
  }
  async prepareTransaction({wallet,launch,action,instructions,review={},addresses={},extra={}}){
    const payer=pk(wallet),preparedAtSlot=(await this.connection.getEpochInfo('finalized')).absoluteSlot,latest=await this.connection.getLatestBlockhash('confirmed');ensure(Number.isSafeInteger(preparedAtSlot)&&preparedAtSlot>0,'The finalized transaction expiry anchor is unavailable.');
    const ixs=instructions.filter(ix=>!ix.programId.equals(ComputeBudgetProgram.programId));
    const tx=new VersionedTransaction(new TransactionMessage({payerKey:payer,recentBlockhash:latest.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:action==='migrate'?1_200_000:action==='initialize'?800_000:500_000}),...ixs]}).compileToV0Message());
    const bytes=Buffer.from(tx.serialize());ensure(bytes.length<=1232,'This Meteora transaction exceeds Solana’s packet size. It has not been submitted.');
    const requiredSigners=tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures).map(str);
    const fee=await this.connection.getFeeForMessage(tx.message,'confirmed');ensure(Number.isSafeInteger(fee.value)&&fee.value>=0,'The network fee could not be verified.');
    const before=await this.connection.getBalance(payer,'confirmed');
    const simulated=await this.connection.simulateTransaction(tx,{sigVerify:false,commitment:'confirmed',accounts:{encoding:'base64',addresses:[wallet]}});
    if(simulated.value.err){
      const context={tx,action,wallet,firstBuy:review?.stage==='initialize'&&BigInt(review?.firstBuyRaw||'0')>0n},message=await this.simulationFailureMessage(launch,simulated.value,context),detail=this.simulationFailureDetail(launch,simulated.value,context);
      const hookRule=message.startsWith('This transfer breaks the coin’s rule');
      throw Object.assign(new Error(message),{statusCode:409,code:hookRule?'METEORA_HOOK_RULE':detail.code,...(!hookRule&&detail.shortfallLamports?{shortfallLamports:detail.shortfallLamports}:{})});
    }
    const after=simulated.value.accounts?.[0]?.lamports;ensure(Number.isSafeInteger(after)&&after>=0,'Meteora simulation did not return the payer balance.');
    ensure(Number.isSafeInteger(simulated.context?.slot)&&simulated.context.slot>0,'The simulation context is unavailable.');const freshBalance=await this.connection.getBalance(payer,{commitment:'confirmed',minContextSlot:simulated.context.slot});ensure(freshBalance===before,'Your wallet balance changed during preparation. Refresh the launch budget.');
    const debit=Math.max(fee.value,before-after);
    if(before<debit){const managed=wallet===launch?.partnerAuthority;throw Object.assign(new Error(`${managed?'Launchpad’s Meteora gas wallet':'Your wallet'} has ${sol(before)} SOL; this step takes up to ${sol(debit)} SOL. Add ${sol(debit-before)} SOL and try again.`),{statusCode:409,code:'METEORA_GAS',shortfallLamports:String(debit-before)});}
    return {action,unsignedTransaction:bytes.toString('base64'),requiredSigners,blockhash:latest,lastValidBlockHeight:latest.lastValidBlockHeight,addresses:{dbcPool:this.poolAddress(launch).toBase58(),...addresses},review:{...review,quoteMint:launch.quoteMint,quoteSymbol:launch.quoteSymbol,quoteDecimals:launch.quoteDecimals,networkFeeLamports:String(fee.value),maxWalletDebitLamports:String(debit),totalSolBudgetLamports:String(debit)},preparedAtSlot,preparedAt:this.now(),...extra};
  }
  /** A plain launch has two stages (configure, initialize). A hooked launch (launch.hook) has three: configure
   * (createConfigWithTransferHook: the same curve on a Token-2022 mint), hook-setup (the hook program's InitConfig and
   * InitializeExtraAccountMetaList, ~500 bytes of rule data, plus the first blocklist wallets; further blocklist chunks of ≤ 28 wallets
   * are more approvals inside the same stage, review.step "k/n") and initialize (createPoolWithTransferHook, no first buy). The
   * hook-setup bundles are `configure`-kind actions flagged `hookSetup`, so the launch flow's continuation needs no new action. The
   * stage is chosen from chain state: config account, then hook PDAs, then a complete blocklist, then the pool. */
  /** Rent for the accounts the create stage makes: mint, metadata, pool, base vault, quote vault and, with a first buy, the buyer's
   * base and quote token accounts (a hooked launch's hook accounts are budgeted by the hook-setup stage). */
  async createStageRent(launch,quoteMintState,first){
    const hook=launch.hook||null,sizes=[hook?HOOKED_MINT_SIZE:82,679,this.dbc.state.getProgram().account.virtualPool.size,hook?HOOKED_VAULT_SIZE:165,this.quoteAccountSize(launch,quoteMintState)];
    if(first>0n)sizes.push(165,this.quoteAccountSize(launch,quoteMintState));
    return (await Promise.all(sizes.map(size=>this.connection.getMinimumBalanceForRentExemption(size,'confirmed')))).reduce((n,v)=>n+BigInt(v),0n);
  }
  /** Before anything is built (v71.34): a first buy on a pair other than SOL is paid in that asset from the creator's wallet (Launchpad
   * never buys it for a Meteora launch), so the wallet must hold it; and at the create stage the wallet must hold the SOL the
   * transaction takes. Both are said in words with the numbers instead of failing in simulation. Returns the wallet balances. */
  async requireLaunchFunds({wallet,launch,quoteMintState,first,stage}){
    const funds=await this.wallet(launch,wallet),native=BigInt(funds.nativeBalanceLamports),solQuote=launch.quoteMint===NATIVE_MINT.toBase58(),symbol=launch.quoteSymbol||'the pair asset';
    if(first>0n&&!solQuote)ensure(BigInt(funds.quoteBalanceRaw)>=first,`Your wallet holds ${displayUnits(funds.quoteBalanceRaw,launch.quoteDecimals)} ${symbol}; the first buy needs ${displayUnits(first,launch.quoteDecimals)} ${symbol}. A Meteora first buy is paid in the pair asset from your wallet, so buy ${displayUnits(first-BigInt(funds.quoteBalanceRaw),launch.quoteDecimals)} more ${symbol} (contract address ${launch.quoteMint}) into your wallet or launch without a first buy.`);
    if(stage!=='initialize')return funds;
    const rent=await this.createStageRent(launch,quoteMintState,first),creationFee=BigInt(launch.creationFee?.lamports||'0'),networkFee=10000n,needed=rent+networkFee+creationFee+(solQuote?first:0n);
    const parts=[`${sol(rent+networkFee)} SOL of account rent and network fees`];if(solQuote&&first>0n)parts.push(`the ${sol(first)} SOL first buy`);if(creationFee>0n)parts.push(`the ${sol(creationFee)} SOL creation fee`);
    if(native<needed)throw Object.assign(new Error(`Your wallet has ${sol(native)} SOL; creating the coin needs about ${sol(needed)} SOL (${parts.join(', ')}). Add ${sol(needed-native)} SOL${solQuote&&first>0n?' or lower the first buy':''} and try again.`),{statusCode:409,code:'METEORA_GAS',shortfallLamports:String(needed-native)});
    return funds;
  }
  async prepareLaunch({wallet,launch,firstBuyRaw=launch.firstBuyRaw||'0',slippageBps=100}){
    const hook=launch.hook||null;
    const quoteMintState=await this.verifyQuote(launch);if(hook)await this.requireHookProgram(hook);const existing=await this.config(launch),params=this.expectedConfig(launch),baseMint=pk(launch.mint),config=pk(launch.configAddress);
    const first=BigInt(firstBuyRaw);ensure(first>=0n&&first<=18446744073709551615n,'Invalid first buy amount.');
    // A hooked coin's first transfer out of the pool runs the rules with the trader's accounts; it is a separate swap after launch.
    if(hook)ensure(first===0n,'A hooked coin’s first buy is a separate trade after launch.');
    const quote=first>0n?this.dbc.pool.getQuoteFromInputAmount({config:params,swapBaseForQuote:false,amountIn:raw(firstBuyRaw),slippageBps:slippage(slippageBps)}):null;
    if(quote)ensure(BigInt(str(quote.outputAmount))<=100000000000000n,'The first buy cannot exceed 10% of the token supply.');
    // The pair asset of a first buy must already be in the wallet: checked before the configuration is paid for (the create stage checks again, with the SOL).
    if(!existing&&first>0n&&launch.quoteMint!==NATIVE_MINT.toBase58())await this.requireLaunchFunds({wallet,launch,quoteMintState,first,stage:'configure'});
    const policy=this.feePolicy(launch),stages=hook?3:2;
    const review={firstBuyRaw:String(first),expectedOutputRaw:quote?str(quote.outputAmount):'0',minOutputRaw:quote?str(quote.minimumAmountOut):'0',initialFdvUsd:policy.initialFdvUsd,graduationFdvUsd:policy.graduationFdvUsd,tradingFeeBps:policy.tradingFeeBps,creatorSharePercent:policy.creatorSharePercent,partnerSharePercent:policy.partnerSharePercent,...(launch.policy?.preset?{feePreset:launch.policy.preset}:{}),graduationFeePercent:0,lpLockPercent:100,...(hook?{transferHook:{program:hook.program,rules:hook.rules.map(r=>r.id),route:hook.route||'any',gateMint:hook.gateMint||null,titheRecipient:hook.titheRecipient||null,blocklistCount:hook.needsBlocklist?hook.blocklist.length:0,tokenType:'token2022'}}:{})};
    if(!existing){
      const configParams={...params,config,feeClaimer:pk(launch.partnerAuthority),leftoverReceiver:pk(launch.leftoverReceiver||launch.partnerAuthority),quoteMint:pk(launch.quoteMint),payer:pk(wallet),...(launch.tokenBadge?{tokenBadge:pk(launch.tokenBadge)}:{})};
      // A hooked config is the same curve on a Token-2022 mint, naming the hook program (transferHookProgram) and Meteora's Token2022 +
      // Immutable token options (meteora-policy.mjs): the mint authority is revoked at creation like every Launchpad coin.
      const tx=hook?await this.sdkCreateConfigWithTransferHook({...configParams,transferHookProgram:pk(hook.program)}):await this.dbc.partner.createConfig(configParams);
      // Rent budget for the later stages: mint, config, pool, base vault, quote vault, (first-buy accounts), (hook accounts).
      const sizes=[hook?HOOKED_MINT_SIZE:82,679,this.dbc.state.getProgram().account.virtualPool.size,hook?HOOKED_VAULT_SIZE:165,this.quoteAccountSize(launch,quoteMintState)];
      if(first>0n)sizes.push(165,this.quoteAccountSize(launch,quoteMintState));
      let approvals=stages;
      if(hook){const hooks=await this.hooksModule().catch(()=>null);sizes.push(hooks?.HOOK_CONFIG_SIZE??HOOK_CONFIG_SIZE,typeof hooks?.extraMetasSize==='function'?hooks.extraMetasSize(hook.rules):hookExtraMetasSize(hook.rules));if(hook.needsBlocklist){sizes.push(hooks?.BLOCKLIST_SIZE??BLOCKLIST_SIZE);approvals+=hookSetupSteps(hook.blocklist.length,0)-1;}}
      const rent=(await Promise.all(sizes.map(size=>this.connection.getMinimumBalanceForRentExemption(size,'confirmed')))).reduce((n,v)=>n+BigInt(v),0n);
      const laterBudget=rent+20000n*BigInt(approvals-1)+BigInt(launch.creationFee?.lamports||'0')+(launch.quoteMint===NATIVE_MINT.toBase58()?first:0n);
      const bundle=await this.prepareTransaction({wallet,launch,action:'configure',instructions:tx.instructions,review:{...review,stage:'configure',stages}});
      bundle.review.totalLaunchMaxDebitLamports=String(BigInt(bundle.review.maxWalletDebitLamports)+laterBudget);bundle.review.budgetIncludesAccountRent=true;
      ensure(BigInt(await this.connection.getBalance(pk(wallet),'confirmed'))>=BigInt(bundle.review.totalLaunchMaxDebitLamports),hook?'Your wallet needs more SOL for the three launch transactions.':'Your wallet needs more SOL for both launch transactions and the first buy.');return bundle;
    }
    ensure(!await this.rawState(launch),'This launch already exists on chain.');
    if(hook){
      // The saved record is verified against this launch's derivations before chain state decides the stage.
      const {exempt}=await this.verifyHookRecord({wallet,launch}),setup=await this.hookSetupState(launch);
      const transferHook={program:hook.program,configPda:hook.configPda,extraMetasPda:hook.extraMetasPda,blocklistPda:hook.needsBlocklist?hook.blocklistPda:null},addresses={hookConfig:hook.configPda,hookExtraMetas:hook.extraMetasPda,...(hook.needsBlocklist?{hookBlocklist:hook.blocklistPda}:{}),baseVault:hook.venue};
      if(!setup.ready){
        const plan=await this.hookSetupPlan({wallet,launch,baseMint,config,exempt,setup});
        return this.prepareTransaction({wallet,launch,action:'configure',instructions:plan.instructions,review:{...review,stage:'hook-setup',stages,step:`${plan.step}/${plan.steps}`,hookSetupStep:plan.step,hookSetupSteps:plan.steps,blocklistWallets:plan.wallets.length,blocklistCountAfter:plan.blocklistCountAfter},addresses,extra:{hookSetup:true,hookSetupStep:{kind:plan.kind,step:plan.step,steps:plan.steps,wallets:plan.wallets,blocklistCountAfter:plan.blocklistCountAfter},transferHook:{...transferHook,...(plan.swapBaseAmount?{swapBaseAmount:plan.swapBaseAmount}:{})}}});
      }
      await this.requireLaunchFunds({wallet,launch,quoteMintState,first,stage:'initialize'});
      const instructions=await this.hookedPoolInstructions({wallet,launch,baseMint,config});
      if(launch.creationFee&&BigInt(launch.creationFee.lamports)>0n)instructions.push(SystemProgram.transfer({fromPubkey:pk(wallet),toPubkey:pk(launch.creationFee.recipient),lamports:BigInt(launch.creationFee.lamports)}));
      return this.prepareTransaction({wallet,launch,action:'initialize',instructions,review:{...review,stage:'initialize',stages},addresses,extra:{executionVenue:'dbc',amountRaw:'0',side:'buy',expectedTrade:null,transferHook}});
    }
    await this.requireLaunchFunds({wallet,launch,quoteMintState,first,stage:'initialize'});
    const tx=await this.dbc.creator.createPoolWithFirstBuy({createPoolParam:{baseMint,config,name:launch.name,symbol:launch.symbol,uri:launch.metadataUri,payer:pk(wallet),poolCreator:pk(launch.creatorAuthority),...(launch.tokenBadge?{tokenBadge:pk(launch.tokenBadge)}:{})},...(quote?{firstBuyParam:{buyer:pk(wallet),receiver:pk(wallet),buyAmount:raw(firstBuyRaw),minimumAmountOut:quote.minimumAmountOut,referralTokenAccount:null}}:{})});
    if(launch.creationFee&&BigInt(launch.creationFee.lamports)>0n)tx.add(SystemProgram.transfer({fromPubkey:pk(wallet),toPubkey:pk(launch.creationFee.recipient),lamports:BigInt(launch.creationFee.lamports)}));
    return this.prepareTransaction({wallet,launch,action:'initialize',instructions:tx.instructions,review:{...review,stage:'initialize',stages},extra:{executionVenue:'dbc',amountRaw:String(first),side:'buy',expectedTrade:quote?{inputRaw:String(first),outputRaw:str(quote.outputAmount),minOutputRaw:str(quote.minimumAmountOut)}:null}});
  }
  /** The saved hook record must still be what this launch derives: program, PDAs, venue and the four exempt keys (creator wallet,
   * partner authority, leftover receiver, DAMM v2 pool authority). The creator wallet is the only payer and signer of the hook stages. */
  async verifyHookRecord({wallet,launch}){
    const hook=launch.hook;ensure(hook?.version===2&&Array.isArray(hook.rules),'This hooked launch uses an earlier rules format and cannot be resumed.');
    const derived=await this.hookAddresses({mint:launch.mint,quoteMint:launch.quoteMint,configAddress:launch.configAddress,program:hook.program});
    ensure(derived.configPda===hook.configPda&&derived.extraMetasPda===hook.extraMetasPda&&derived.baseVault===hook.venue,'The saved transfer hook addresses do not match this launch.');
    if(hook.needsBlocklist)ensure(typeof hook.blocklistPda==='string'&&(derived.blocklistPda===null||derived.blocklistPda===hook.blocklistPda),'The saved transfer hook addresses do not match this launch.');
    const exempt=[launch.creatorWallet,launch.partnerAuthority,launch.leftoverReceiver||launch.partnerAuthority,derived.dammPoolAuthority];
    ensure(launch.creatorWallet===wallet&&Array.isArray(hook.exempt)&&hook.exempt.length===4&&hook.exempt.every((key,i)=>key===exempt[i]),'The saved transfer hook exemptions do not match this launch.');
    return {derived,exempt};
  }
  /** swapBaseAmount for InitConfig: the base tokens the curve sells before graduation, read from the PoolConfig created in stage 1. */
  async hookSwapBaseAmount(config){
    const poolConfig=await this.sdkPoolConfig(config);const text=str(poolConfig?.swapBaseAmount??'');
    ensure(/^\d+$/.test(text)&&BigInt(text)>0n&&BigInt(text)<=18446744073709551615n,'The curve configuration on chain has no swap base amount yet.');return text;
  }
  /** The hook program's setup instructions for this launch, encoded once per stage. InitConfig first — the program writes the config
   * first and the metas list reads the gate keys from it (contracts/curve-transfer-hook/src/lib.rs) — then InitializeExtraAccountMetaList,
   * both paid and signed by the creator wallet (the hook config's creator). The mint does not exist yet: the PDAs derive from its
   * address alone. Exempt keys, venues (the DBC base vault, one spare slot zero), the gate token, the tithe recipient, swapBaseAmount
   * and the rules' exact parameters (public/hook-catalog.mjs hookRuleParams) are written once. */
  async hookSetupEncoded({wallet,launch,baseMint,exempt,swapBaseAmount}){
    const hook=launch.hook,hooks=await this.hooksModule(),programId=pk(hook.program),creator=pk(wallet),holderGated=!!hook.gateMint;
    if(holderGated)ensure(typeof hook.gateTokenProgram==='string','The saved gate token program is missing.');
    if(hook.rules.some(r=>r.id==='tithe'))ensure(typeof hook.titheRecipient==='string','The saved tithe recipient is missing.');
    const init=hooks.initConfig({programId,mint:baseMint,creator,payer:creator,exempt:exempt.map(pk),venues:[pk(hook.venue),PublicKey.default],gateMint:holderGated?pk(hook.gateMint):null,gateTokenProgram:holderGated?pk(hook.gateTokenProgram):null,titheRecipient:hook.titheRecipient?pk(hook.titheRecipient):null,swapBaseAmount,rules:this.hookRules(hook)});
    const metas=hooks.initializeExtraAccountMetaList({programId,mint:baseMint,authority:creator,payer:creator});
    return {init,metas,first:hook.needsBlocklist?hookSetupFirstChunk({initConfigDataLength:init.data.length,metasDataLength:metas.data.length,total:hook.blocklist.length}):0};
  }
  /** The next hook-setup approval: step 1 = [InitConfig, InitializeExtraAccountMetaList, AddBlocked(first wallets that fit)]; every
   * further step = AddBlocked(next ≤ 28 wallets), continuing from the count the chain holds. */
  async hookSetupPlan({wallet,launch,baseMint,config,exempt,setup}){
    const hook=launch.hook,hooks=await this.hooksModule(),programId=pk(hook.program),creator=pk(wallet),total=hook.needsBlocklist?hook.blocklist.length:0;
    const chunk=wallets=>this.instruction(hooks.addBlocked({programId,mint:baseMint,creator,payer:creator,wallets:wallets.map(pk)}));
    if(!setup.exists){
      const swapBaseAmount=await this.hookSwapBaseAmount(config),{init,metas,first}=await this.hookSetupEncoded({wallet,launch,baseMint,exempt,swapBaseAmount}),wallets=hook.needsBlocklist?hook.blocklist.slice(0,first):[];
      return {kind:'setup',instructions:[this.instruction(init),this.instruction(metas),...(wallets.length?[chunk(wallets)]:[])],step:1,steps:hookSetupSteps(total,first),wallets,blocklistCountAfter:wallets.length,swapBaseAmount};
    }
    ensure(setup.blocklist&&!setup.blocklist.complete,'The transfer hook setup is already complete.');
    const {first}=await this.hookSetupEncoded({wallet,launch,baseMint,exempt,swapBaseAmount:'1'}),count=setup.blocklist.count,wallets=hook.blocklist.slice(count,count+HOOK_LIMITS.blocklistBatch);
    return {kind:'blocklist',instructions:[chunk(wallets)],step:2+Math.max(0,Math.ceil((count-first)/HOOK_LIMITS.blocklistBatch)),steps:hookSetupSteps(total,first),wallets,blocklistCountAfter:count+wallets.length,swapBaseAmount:null};
  }
  /** The hooked initialize stage: createPoolWithTransferHook alone (the hook accounts exist by now). Payer = creator wallet; the server
   * signs only the managed mint and pool-creator keys, as for every Meteora launch. */
  async hookedPoolInstructions({wallet,launch,baseMint,config}){
    const hook=launch.hook;
    return this.sdkInstructions(this.sdkCreatePoolWithTransferHook({baseMint,config,name:launch.name,symbol:launch.symbol,uri:launch.metadataUri,payer:pk(wallet),poolCreator:pk(launch.creatorAuthority),transferHookProgram:pk(hook.program),...(launch.tokenBadge?{tokenBadge:pk(launch.tokenBadge)}:{})}));
  }
  async readDammPool(launch,minContextSlot){const r=await this.readAccount(this.dammAddress(launch),DAMM_V2_PROGRAM_ID,'finalized',minContextSlot);ensure(r.value,'The graduated pool is not indexed yet.');const p=this.cp._program.coder.accounts.decode('pool',r.value.data);this.verifyDammPool(launch,p);return p;}
  async readPosition(address,minContextSlot){const r=await this.readAccount(address,DAMM_V2_PROGRAM_ID,'finalized',minContextSlot);ensure(r.value,'The permanent position is not indexed yet.');return this.cp._program.coder.accounts.decode('position',r.value.data);}
  async positions(launch,owner,minContextSlot){
    // Callers pass either a base58 string or a PublicKey; compare by address.
    const saved=launch.position?.[str(owner)===launch.creatorAuthority?'creator':'partner'];
    let candidates;
    if(Array.isArray(saved)&&saved.length)candidates=saved.map(x=>({position:pk(x.position),positionNftAccount:derivePositionNftAccount(pk(x.nftMint))}));
    else{candidates=[];for(const mint of launch.migrationPositionMints||[]){const position=derivePositionAddress(pk(mint)),r=await this.readAccount(position,DAMM_V2_PROGRAM_ID,'finalized',minContextSlot);if(!r.value)continue;const positionNftAccount=derivePositionNftAccount(pk(mint)),nft=await this.connection.getAccountInfo(positionNftAccount,'finalized');if(nft?.data.length>=165&&new PublicKey(nft.data.subarray(32,64)).equals(pk(owner)))candidates.push({position,positionNftAccount});}
      if(!candidates.length)candidates=await this.cp.getUserPositionByPool(this.dammAddress(launch),pk(owner));}
    const result=[];for(const x of candidates){const position=await this.readPosition(x.position,minContextSlot);ensure(str(position.pool)===str(this.dammAddress(launch)),'Fee position pool mismatch.');if(str(position.unlockedLiquidity)!=='0'||str(position.vestedLiquidity)!=='0'||BigInt(str(position.permanentLockedLiquidity))===0n)continue;const nft=await this.connection.getAccountInfo(pk(x.positionNftAccount),{commitment:'finalized',...(minContextSlot?{minContextSlot}:{})});ensure(nft?.owner.equals(TOKEN_2022_PROGRAM_ID)&&nft.data.length>=165&&new PublicKey(nft.data.subarray(0,32)).equals(position.nftMint)&&new PublicKey(nft.data.subarray(32,64)).equals(pk(owner))&&nft.data.readBigUInt64LE(64)===1n,'The permanent position NFT ownership could not be verified.');result.push({...x,positionState:position});}return result;}
  async positionFees(launch,p,owner){const positions=await this.positions(launch,owner);ensure(positions.length>0,'The migrated permanent fee position is not indexed yet.');return {fees:positions.reduce((n,x)=>n+BigInt(str(getUnClaimLpFee(p,x.positionState).feeTokenB)),0n),positions:positions.map(x=>({position:str(x.position),nftMint:str(x.positionState.nftMint),owner,lockedLiquidityRaw:str(x.positionState.permanentLockedLiquidity)}))};}
  async state(launch,minContextSlot){const r=await this.rawState(launch,minContextSlot);if(!r)return null;const p=r.pool;let creator=BigInt(str(p.creatorQuoteFee)),partner=BigInt(str(p.partnerQuoteFee)),position=null;if(p.isMigrated){const damm=await this.readDammPool(launch),cf=await this.positionFees(launch,damm,launch.creatorAuthority),pf=await this.positionFees(launch,damm,launch.partnerAuthority);creator+=cf.fees;partner+=pf.fees;position={creator:cf.positions,partner:pf.positions};}return {lpLocked:p.isMigrated?true:false,position,creatorFeesPending:String(creator),partnerFeesPending:String(partner),phase:p.isMigrated?'migrated':p.quoteReserve.gte(r.config.migrationQuoteThreshold)?'bonded':'trading',poolId:p.isMigrated?this.dammAddress(launch).toBase58():r.address.toBase58(),dbcPool:r.address.toBase58(),dbcPoolId:r.address.toBase58(),migrationProgress:p.migrationProgress,quoteReserveRaw:str(p.quoteReserve),baseReserveRaw:str(p.baseReserve),creatorQuoteRaw:str(p.creatorQuoteFee),partnerQuoteRaw:str(p.partnerQuoteFee),slot:r.slot};}
  async wallet(launch,wallet){const native=await this.connection.getBalance(pk(wallet),'confirmed');const read=async(mint,program)=>{const address=getAssociatedTokenAddressSync(pk(mint),pk(wallet),false,program);const info=await this.connection.getAccountInfo(address,'confirmed');if(!info)return '0';ensure(info.owner.equals(program)&&info.data.length>=165&&new PublicKey(info.data.subarray(0,32)).equals(pk(mint))&&new PublicKey(info.data.subarray(32,64)).equals(pk(wallet)),'Token account identity mismatch.');return info.data.readBigUInt64LE(64).toString();};return {wallet,nativeBalanceLamports:String(native),baseBalanceRaw:await read(launch.mint,this.baseProgram(launch)),quoteBalanceRaw:launch.quoteMint===NATIVE_MINT.toBase58()?String(native):await read(launch.quoteMint,this.quoteProgram(launch)),baseDecimals:6,quoteDecimals:launch.quoteDecimals};}
  /** What a trader's transaction on a hooked curve carries besides the swap (the hook README's "Launchpad route"): RegisterWallet (payer =
   * trader) when the coin vests holders, the trade is a buy whose expected receipt is at least the rule's minimum qualifying share of
   * the supply and the trader has no WalletState yet (a sell, or a smaller buy, needs no record); the tithe donation, a System transfer
   * trader → recipient of the rule's lamports, on every buy and sell except the creator's (an exempt owner the rules skip). */
  async hookedTradePrefix({wallet,launch,side,expectedOutputRaw}){
    const hook=launch.hook,instructions=[];let registersWallet=false,titheLamports=null;
    const vesting=hook.rules.find(r=>r.id==='holder_vesting');
    if(vesting&&side==='buy'){
      const params=hookRuleParams('holder_vesting',vesting.settings),threshold=BigInt(METEORA_POLICY.supply)*10n**BigInt(METEORA_POLICY.decimals)*BigInt(params[4])/1_000_000n;
      if(BigInt(expectedOutputRaw)>=threshold){const hooks=await this.hooksModule(),state=hooks.walletStatePda(pk(hook.program),pk(launch.mint),pk(wallet));if(!await this.connection.getAccountInfo(pk(state.address),'confirmed')){instructions.push(this.instruction(hooks.registerWallet({programId:pk(hook.program),mint:pk(launch.mint),wallet:pk(wallet),payer:pk(wallet)})));registersWallet=true;}}
    }
    const tithe=hook.rules.find(r=>r.id==='tithe');
    if(tithe){ensure(typeof hook.titheRecipient==='string','The saved tithe recipient is missing.');titheLamports=hookRuleParams('tithe',tithe.settings)[0];if(wallet!==launch.creatorWallet)instructions.push(this.systemTransfer({from:wallet,to:hook.titheRecipient,lamports:titheLamports}));}
    return {instructions,registersWallet,titheLamports};
  }
  async prepareTrade({wallet,launch,side,amountRaw,slippageBps=100}){
    ensure(['buy','sell'].includes(side),'Invalid trade side.');await this.verifyQuote(launch);const r=await this.rawState(launch);ensure(r,'Meteora pool is not initialized.');
    const amount=validAmount(amountRaw),slip=slippage(slippageBps),currentPoint=raw(Math.floor(this.now()/1000)),hook=launch.hook||null;let instructions,q,hookReview=null;
    if(r.pool.isMigrated){const pool=this.dammAddress(launch),p=await this.readDammPool(launch);this.verifyDammPool(launch,p);q=this.cp.getQuote2({inputTokenMint:pk(side==='buy'?launch.quoteMint:launch.mint),slippage:slip,currentPoint,poolState:p,tokenADecimal:6,tokenBDecimal:launch.quoteDecimals,hasReferral:false,swapMode:0,amountIn:amount});instructions=await this.sdkInstructions(this.cp.swap2({payer:pk(wallet),pool,inputTokenMint:pk(side==='buy'?launch.quoteMint:launch.mint),outputTokenMint:pk(side==='buy'?launch.mint:launch.quoteMint),tokenAMint:p.tokenAMint,tokenBMint:p.tokenBMint,tokenAVault:p.tokenAVault,tokenBVault:p.tokenBVault,tokenAProgram:this.baseProgram(launch),tokenBProgram:this.quoteProgram(launch),referralTokenAccount:null,swapMode:0,amountIn:amount,minimumAmountOut:q.minimumAmountOut,poolState:p}));}
    else{
      ensure(r.pool.quoteReserve.lt(r.config.migrationQuoteThreshold),'This pool is graduating. Its automatic migration will finish before trading resumes.');q=this.dbc.pool.swapQuote2({virtualPool:r.virtual,config:r.config,swapBaseForQuote:side==='sell',hasReferral:false,eligibleForFirstSwapWithMinFee:false,currentPoint,slippageBps:slip,swapMode:0,amountIn:amount});
      const swap={owner:pk(wallet),pool:r.address,swapBaseForQuote:side==='sell',referralTokenAccount:null,swapMode:0,amountIn:amount,minimumAmountOut:q.minimumAmountOut};
      if(hook){
        // An app-only coin (v71.35) trades only through its app while on the curve (the app's mark must be in the trade); Launchpad never builds that trade.
        ensure(hook.route!=='app',hookAppTradeNote(hook.appName));
        // While the coin is on the curve its transfers run the hook: a sell moves wallet → base vault (owner: pool authority), a buy
        // moves base vault → wallet. The SDK's swap is post-processed with the accounts Launchpad resolves for those owners.
        const poolAuthority=this.poolAuthority(),owners=side==='buy'?{sourceOwner:poolAuthority,destinationOwner:pk(wallet)}:{sourceOwner:pk(wallet),destinationOwner:poolAuthority};
        const prefix=await this.hookedTradePrefix({wallet,launch,side,expectedOutputRaw:str(q.outputAmount)});
        instructions=await this.sdkInstructions(this.sdkSwap2WithTransferHook(swap));await this.patchHookAccounts(instructions,launch,{...owners,blocks:swap.referralTokenAccount?2:1});
        instructions=[...prefix.instructions,...instructions];hookReview={program:hook.program,route:hook.route||'any',registersWallet:prefix.registersWallet,titheLamports:prefix.titheLamports};
      }else instructions=await this.sdkInstructions(this.dbc.pool.swap2(swap));
    }
    return this.prepareTransaction({wallet,launch,action:side,instructions,review:{side,inputRaw:String(amountRaw),expectedOutputRaw:str(q.outputAmount),minOutputRaw:str(q.minimumAmountOut),slippageBps:slip,...(hookReview?{transferHook:hookReview}:{})},extra:{executionVenue:r.pool.isMigrated?'damm':'dbc',amountRaw:String(amountRaw),side,expectedTrade:{inputRaw:String(amountRaw),outputRaw:str(q.outputAmount),minOutputRaw:str(q.minimumAmountOut)}}});
  }
  verifyDammPool(launch,p){ensure(str(p.tokenAMint)===launch.mint&&str(p.tokenBMint)===launch.quoteMint&&p.collectFeeMode===1&&str(p.sqrtMinPrice)===str(MIN_SQRT_PRICE)&&str(p.sqrtMaxPrice)===str(MAX_SQRT_PRICE),'Graduated Meteora pool does not match the registered quote, full range and quote-only fees.');const fee=decodePodAlignedFeeTimeScheduler(Buffer.from(p.poolFees.baseFee.baseFeeInfo.data));ensure(str(fee.cliffFeeNumerator)===meteoraFeeNumerator(this.policyFor(launch))&&fee.numberOfPeriod===0&&str(fee.periodFrequency)==='0'&&str(fee.reductionFactor)==='0'&&fee.baseFeeMode===0&&p.poolFees.dynamicFee.initialized===0&&p.poolFees.protocolFeePercent===20,'Graduated Meteora trading fees do not match the fixed policy.');}
  async prepareMigration({wallet,launch,migrationPositionMints=launch.migrationPositionMints}){
    const r=await this.rawState(launch);ensure(r&&!r.pool.isMigrated&&r.pool.quoteReserve.gte(r.config.migrationQuoteThreshold),'The Meteora pool is not ready to graduate.');await this.verifyQuote(launch);ensure(Array.isArray(migrationPositionMints)&&migrationPositionMints.length===2,'Migration position signer keys must be durably saved before preparation.');
    const plan=await this.dbc.migration.migrateToDammV2({payer:pk(wallet),pool:r.address,dammConfig:DEFAULT_DAMM_CONFIG});
    const replacements=new Map();for(const [old,next] of [[plan.firstPositionNftKeypair.publicKey,pk(migrationPositionMints[0])],[plan.secondPositionNftKeypair.publicKey,pk(migrationPositionMints[1])]]){replacements.set(str(old),next);replacements.set(str(derivePositionAddress(old)),derivePositionAddress(next));replacements.set(str(derivePositionNftAccount(old)),derivePositionNftAccount(next));}
    for(const ix of plan.transaction.instructions)for(const key of ix.keys)if(replacements.has(str(key.pubkey)))key.pubkey=replacements.get(str(key.pubkey));
    return this.prepareTransaction({wallet,launch,action:'migrate',instructions:plan.transaction.instructions,review:{lpLockPercent:100},addresses:{dammPool:this.dammAddress(launch).toBase58()},extra:{migrationPositionMints}});
  }
  async prepareCreatorClaim(args){return this.prepareClaim({...args,role:'creator'});}
  async preparePartnerClaim(args){return this.prepareClaim({...args,role:'partner'});}
  async prepareClaim({wallet,launch,receiver,role}){
    ensure(role==='creator'?[launch.creatorAuthority,launch.creatorRecipient].includes(receiver):receiver===launch.partnerAuthority,'Meteora fees must be paid to their registered destination.');const r=await this.rawState(launch);ensure(r,'Meteora pool is unavailable.');const owner=pk(role==='creator'?launch.creatorAuthority:launch.partnerAuthority),to=pk(receiver),payer=pk(wallet),program=this.quoteProgram(launch),baseProgram=this.baseProgram(launch),baseAta=this.associatedToken(launch.mint,to,baseProgram),quoteAta=this.associatedToken(launch.quoteMint,to,program);
    const instructions=[createAssociatedTokenAccountIdempotentInstruction(payer,baseAta,to,pk(launch.mint),baseProgram),createAssociatedTokenAccountIdempotentInstruction(payer,quoteAta,to,pk(launch.quoteMint),program)];
    if(BigInt(str(role==='creator'?r.pool.creatorQuoteFee:r.pool.partnerQuoteFee))>0n){
      // The claim instruction is built from the DBC program's own methods (as every plain claim is), so the quote lands in the receiver's
      // quote token account that Launchpad's ledgers read. A hooked coin's pool is a TransferHookPool, which only the `…2` claims accept:
      // the same accounts as the plain claims plus the hook's accounts as remaining accounts, because the claim moves base tokens
      // venue → receiver (an exempt owner: the rules skip, but Token-2022 needs the accounts) — resolved by Launchpad's encoder like a trade's.
      // Once Meteora's curve-completing swap revoked the hook (or after migration) there are none to carry: empty slices.
      const accounts={poolAuthority:deriveDbcPoolAuthority(),pool:r.address,tokenAAccount:baseAta,tokenBAccount:quoteAta,baseVault:r.pool.baseVault,quoteVault:r.pool.quoteVault,baseMint:pk(launch.mint),quoteMint:pk(launch.quoteMint),tokenBaseProgram:baseProgram,tokenQuoteProgram:program},methods=this.dbc.state.getProgram().methods;
      if(launch.hook){
        const hooked=!r.pool.isMigrated&&(await this.readHookedMint(launch)).transferHookProgram!==null;
        const block=hooked?await this.hookRemainingAccounts(launch,{sourceOwner:this.poolAuthority(),destinationOwner:to}):[];
        const info={slices:hooked?[{accountsType:{transferHookBase:{}},length:block.length}]:[]};
        instructions.push(await(role==='creator'?methods.claimCreatorTradingFee2(raw(0),U64MAX,info).accountsPartial({...accounts,creator:owner}):methods.claimTradingFee2(raw(0),U64MAX,info).accountsPartial({...accounts,config:pk(launch.configAddress),feeClaimer:owner})).remainingAccounts(block).instruction());
      }
      else instructions.push(await(role==='creator'?methods.claimCreatorTradingFee(raw(0),U64MAX).accountsPartial({...accounts,creator:owner}):methods.claimTradingFee(raw(0),U64MAX).accountsPartial({...accounts,config:pk(launch.configAddress),feeClaimer:owner})).instruction());
    }
    if(r.pool.isMigrated){const pool=this.dammAddress(launch),p=await this.readDammPool(launch);this.verifyDammPool(launch,p);const positions=await this.positions(launch,owner);ensure(positions.length>0,'The permanent fee position has not been indexed yet.');for(const position of positions.sort((a,b)=>{const x=BigInt(str(getUnClaimLpFee(p,a.positionState).feeTokenB)),y=BigInt(str(getUnClaimLpFee(p,b.positionState).feeTokenB));return x===y?str(a.position).localeCompare(str(b.position)):x>y?-1:1;}).slice(0,1)){ensure(str(position.positionState.unlockedLiquidity)==='0'&&str(position.positionState.vestedLiquidity)==='0'&&BigInt(str(position.positionState.permanentLockedLiquidity))>0n,'A fee position has unexpected withdrawable liquidity.');instructions.push(await this.cp.buildClaimPositionFeeInstruction({owner,poolAuthority:deriveDammV2PoolAuthority(),position:position.position,pool,positionNftAccount:position.positionNftAccount,tokenAAccount:baseAta,tokenBAccount:quoteAta,tokenAMint:p.tokenAMint,tokenBMint:p.tokenBMint,tokenAVault:p.tokenAVault,tokenBVault:p.tokenBVault,tokenAProgram:baseProgram,tokenBProgram:program}));}}
    ensure(instructions.length>2,'No creator or protocol fees are ready to claim.');
    return this.prepareTransaction({wallet,launch,action:`${role}-claim`,instructions,review:{receiver,quoteDelivery:'token-account'},extra:{feeRole:role,receiver,receiverQuoteAta:quoteAta.toBase58()}});
  }
  /** The hooked coin's Token-2022 mint: authorities (base58 or null), supply, decimals and the transfer hook program it carries (null
   * once Meteora's curve-completing swap revoked it). */
  async readHookedMint(launch,commitment='confirmed',minContextSlot){
    const info=await this.connection.getAccountInfo(pk(launch.mint),{commitment,...(minContextSlot===undefined?{}:{minContextSlot})});ensure(info?.owner.equals(TOKEN_2022_PROGRAM_ID),'The hooked mint is not a Token-2022 token.');
    const m=unpackMint(pk(launch.mint),info,TOKEN_2022_PROGRAM_ID),hook=getTransferHook(m);
    return {mintAuthority:m.mintAuthority?str(m.mintAuthority):null,freezeAuthority:m.freezeAuthority?str(m.freezeAuthority):null,supply:String(m.supply),decimals:m.decimals,transferHookProgram:hook?.programId&&!hook.programId.equals(PublicKey.default)?str(hook.programId):null};
  }
  /** The coin's allowlist as the chain holds it: every AllowEntry account of the hook program for this mint (dataSize + mint memcmp
   * filters from the encoder), decoded and sorted. This is the authoritative list; the service's recorded list is the fallback. */
  async hookAllowlistOnChain(launch){
    const hook=launch.hook,hooks=await this.hooksModule();ensure(hook?.program,'This coin has no transfer hook rules.');
    const rows=await this.connection.getProgramAccounts(pk(hook.program),{commitment:'confirmed',filters:hooks.allowEntryFilters(pk(launch.mint))});
    const wallets=new Set();for(const row of rows){let entry;try{entry=hooks.decodeAllowEntry(row.account.data);}catch{continue;}if(entry.mint===launch.mint)wallets.add(entry.wallet);}
    return [...wallets].sort();
  }
  /** The coin's blocklist as the chain holds it: the BlockList PDA decoded by the encoder (its first `count` wallets). An absent account
   * is an empty list; an account another program owns is refused. */
  async hookBlocklistOnChain(launch){
    const hook=launch.hook,hooks=await this.hooksModule();ensure(hook?.program&&hook.needsBlocklist===true&&typeof hook.blocklistPda==='string','This coin has no blocklist rule.');
    const a=await this.connection.getAccountInfo(pk(hook.blocklistPda),'confirmed');if(!a)return [];
    ensure(a.owner.equals(pk(hook.program)),'The blocklist account was not created by the hook program.');
    const decoded=hooks.decodeBlocklist(Buffer.from(a.data));return (decoded.wallets||[]).slice(0,Number(decoded.count)).map(str);
  }
  /** Allowlist changes for a hooked coin: AddAllowed / RemoveAllowed signed by the creator wallet, which also pays and is refunded
   * the closed entries' rent. The chain is read first so a wallet that is already allowed (or not allowed) is refused in words
   * instead of failing in simulation. Unsigned; the server adds no signature of its own. */
  async prepareHookAllowlist({wallet,launch,add=[],remove=[]}){
    const hook=launch.hook;ensure(hook?.program&&hook.rules?.some(rule=>rule.id==='allowlist'),'This coin has no allowlist rule.');ensure(wallet===launch.creatorWallet,'Only the coin’s creator wallet can change its allowlist.');
    const wallets=[...add,...remove];ensure(wallets.length>0&&wallets.length<=HOOK_LIMITS.allowlistBatch&&new Set(wallets).size===wallets.length,`Change between 1 and ${HOOK_LIMITS.allowlistBatch} wallets per transaction.`);
    const hooks=await this.hooksModule(),programId=pk(hook.program),mint=pk(launch.mint),creator=pk(wallet);
    const entries=wallets.map(w=>pk(hooks.allowEntryPda(programId,mint,pk(w)).address)),existing=await this.connection.getMultipleAccountsInfo(entries,'confirmed');
    add.forEach((w,i)=>ensure(!existing[i],`${w} is already on the allowlist.`));remove.forEach((w,i)=>ensure(!!existing[add.length+i],`${w} is not on the allowlist.`));
    const instructions=[...add.map(w=>this.instruction(hooks.addAllowed({programId,mint,creator,payer:creator,wallet:pk(w)}))),...remove.map(w=>this.instruction(hooks.removeAllowed({programId,mint,creator,wallet:pk(w),refundTo:creator})))];
    return this.prepareTransaction({wallet,launch,action:'hook-allow',instructions,review:{add:[...add],remove:[...remove],program:hook.program},addresses:{hookConfig:hook.configPda},extra:{hookAllowlist:{add:[...add],remove:[...remove]}}});
  }
  async holderSnapshot(launch){const helpers=await import('./meteora-rewards.mjs');return {...await helpers.holderSnapshot({connection:this.connection,launch}),complete:true};}
  /** Holder (or creator / protocol) payouts in the pair asset, or — reward baskets, v71.33 — in one basket asset (`asset`): the same
   * exact-transfer builder with the asset's mint, decimals and program in place of the pair's; the bundle names the asset so the
   * receipt is checked against it. */
  async preparePayout({wallet,launch,source=launch.creatorAuthority,payouts,operationId,role='creator',asset=null}){
    ensure(['creator','partner'].includes(role),'Invalid payout role.');
    if(role==='partner')ensure(source===launch.partnerAuthority&&wallet===launch.partnerAuthority&&payouts.length===1&&payouts[0].owner===launch.treasury,'Protocol payout must send the saved credit to the registered treasury.');
    else ensure(source===launch.creatorAuthority,'Creator payout source changed.');
    if(asset){ensure(role==='creator'&&launch.feeMode==='holders'&&Array.isArray(launch.basket?.assets)&&launch.basket.assets.some(a=>a.mint===asset.mint&&a.decimals===asset.decimals),'Only a saved reward-basket asset can pay holder rewards.');}
    const target=asset?{...launch,quoteMint:asset.mint,quoteDecimals:asset.decimals,quoteProgram:asset.program||TOKEN_PROGRAM_ID.toBase58(),quoteSymbol:asset.symbol||''}:launch,program=pk(target.quoteProgram||TOKEN_PROGRAM_ID);
    const allowPayerRecipient=role==='creator'&&!asset&&payouts.length===1&&payouts[0].owner===launch.creatorRecipient&&wallet===launch.creatorRecipient;
    const helpers=await import('./meteora-rewards.mjs'),plan=await helpers.prepareHolderPayoutInstructions({connection:this.connection,wallet,launch:role==='partner'?{...target,creatorAuthority:launch.partnerAuthority}:target,source,payouts,operationId,allowPayerRecipient});
    const payout={allowPayerRecipient,quoteDebitRaw:plan.quoteDebitRaw,recipients:plan.payouts,source,mint:target.quoteMint,decimals:target.quoteDecimals,program:str(program),sourceQuoteAta:getAssociatedTokenAddressSync(pk(target.quoteMint),pk(source),true,program).toBase58()};
    if(!plan.payouts?.length)return {action:role==='partner'?'partner-payout':'payout',deferredPayouts:plan.deferredPayouts,payout:{...payout,quoteDebitRaw:'0',recipients:[]}};
    const bundle=await this.prepareTransaction({wallet,launch,action:role==='partner'?'partner-payout':'payout',instructions:plan.instructions,review:{recipientCount:plan.payouts.length,...(asset?{basketAsset:{mint:asset.mint,symbol:asset.symbol||'',decimals:asset.decimals}}:{})},extra:{deferredPayouts:plan.deferredPayouts,payout}});
    if(asset)Object.assign(bundle.review,{quoteMint:target.quoteMint,quoteSymbol:target.quoteSymbol,quoteDecimals:target.quoteDecimals});
    return bundle;}
  /** Reward baskets (v71.33): whether Jupiter can route `amountRaw` of one asset into another within the basket guard (at most 2%
   * price impact). Returns { outAmount, priceImpactPct }; throws a 409 naming the problem. Used when a basket is chosen at launch. */
  async basketRouteCheck({inputMint,outputMint,amountRaw}){
    ensure(this.basketsAvailable(),'Reward baskets are not available on this host.');
    const input=str(pk(inputMint)),output=str(pk(outputMint));ensure(input!==output&&/^[1-9]\d{0,19}$/.test(String(amountRaw)),'Invalid basket route request.');
    const chain=this.transport,signal=AbortSignal.timeout(15000),config={jupiterKey:chain.jupiterKey||''};
    await chain.jupiterGate.acquire(config,signal,Date.now()+15000);
    const query=new URLSearchParams({inputMint:input,outputMint:output,amount:String(amountRaw),swapMode:'ExactIn',slippageBps:String(BASKET_LIMITS.conversionSlippageBps),maxAccounts:'32'});
    let response;try{response=await chain.fetcher('https://api.jup.ag/swap/v1/quote?'+query,{headers:chain.jupiterKey?{'x-api-key':chain.jupiterKey}:{},signal});}catch{ensure(false,'The swap route provider could not be reached. Try again shortly.');}
    if(response.status===429)chain.jupiterGate.cooldown(config,Math.max(1000,(Number(response.headers?.get?.('retry-after'))||1)*1000));
    ensure(response.ok,'No swap route is available for this basket asset right now. Choose another asset or try again shortly.');
    const q=await response.json();
    ensure(q&&q.inputMint===input&&q.outputMint===output&&String(q.inAmount)===String(amountRaw)&&q.swapMode==='ExactIn'&&/^[1-9]\d*$/.test(String(q.outAmount))&&Array.isArray(q.routePlan)&&q.routePlan.length>0,'The swap route provider returned an unexpected quote for this basket asset.');
    const impact=Math.abs(Number(q.priceImpactPct));ensure(Number.isFinite(impact)&&impact<=BASKET_LIMITS.conversionMaxImpactPct/100,'Converting into this basket asset would move its price more than 2%. Choose a more liquid asset.');
    return {outAmount:String(q.outAmount),priceImpactPct:String(q.priceImpactPct)};
  }
  /** Reward baskets (v71.33): one conversion of the pair asset into a basket asset for a reward round, from and to the creator
   * authority's own token accounts, with the managed gas wallet paying the network fee and any new token-account rent. The route is
   * built and audited by the shared Jupiter builders (tokenConversion: fixed authority, mints and recipients, no fee, bounded impact),
   * the composed transaction (lookup tables allowed: every account was audited before compilation) is simulated and must debit exactly
   * the leg's input and credit at least the route's minimum output; the authority's other token balances and the gas spend stay
   * within bounds. Unsigned; the service signs with the gas wallet and the creator authority. */
  async prepareBasketConversion({wallet,launch,asset,inputRaw}){
    ensure(this.basketsAvailable(),'Reward baskets are not available on this host.');
    ensure(launch.feeMode==='holders'&&Array.isArray(launch.basket?.assets)&&asset&&asset.mint!==launch.quoteMint&&launch.basket.assets.some(a=>a.mint===asset.mint&&a.decimals===asset.decimals),'Only a saved reward-basket asset can be converted.');
    const payer=pk(wallet),owner=pk(launch.creatorAuthority),inputProgram=this.quoteProgram(launch),outputProgram=pk(asset.program||TOKEN_PROGRAM_ID),amount=BigInt(str(validAmount(inputRaw)));
    const info=await this.connection.getAccountInfo(pk(asset.mint),'finalized');ensure(info&&info.owner.equals(outputProgram),'The basket asset token program changed.');
    const mint=unpackMint(pk(asset.mint),info,info.owner);ensure(mint.isInitialized&&mint.decimals===asset.decimals,'The basket asset decimals changed.');
    const transferFee=getTransferFeeConfig(mint);ensure(!transferFee||transferFee.olderTransferFee.transferFeeBasisPoints===0&&transferFee.newerTransferFee.transferFeeBasisPoints===0,'A transfer-tax basket asset cannot pay exact rewards.');
    const hook=getTransferHook(mint);ensure(!hook||hook.programId.equals(PublicKey.default),'A basket asset with an active transfer hook is not supported.');
    let quote=null,route=null,oversized=null;
    for(const maxAccounts of SOL_ROUTE_ACCOUNT_BUDGETS){
      try{
        const candidate=await this.routes.tokenConversion(this.transport,{inputMint:launch.quoteMint,outputMint:asset.mint,amountRaw:String(amount),slippageBps:BASKET_LIMITS.conversionSlippageBps,wallet:launch.creatorAuthority,inputProgram,outputProgram,maxAccounts});
        ensure(Math.abs(Number(candidate.priceImpactPct))<=BASKET_LIMITS.conversionMaxImpactPct/100,'Converting into this basket asset would move its price more than 2%.');
        const built=await this.routes.buildTokenConversion(this.transport,candidate,{payer:wallet});
        const probe=new VersionedTransaction(new TransactionMessage({payerKey:payer,recentBlockhash:PublicKey.default.toBase58(),instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),...built.instructions]}).compileToV0Message(built.lookupTables||[]));
        if(probe.serialize().length>1232){oversized=Object.assign(Error('The conversion route is too large for one transaction.'),{code:'BASKET_ROUTE_TOO_LARGE'});continue;}
        quote=candidate;route=built;break;
      }catch(error){if(oversized&&error?.code==='SOL_ROUTE_NOT_FOUND')continue;throw error;}
    }
    if(!quote||!route)throw oversized||Object.assign(Error('No conversion route is available right now.'),{statusCode:409,code:'SOL_ROUTE_NOT_FOUND'});
    const source=pk(route.source),destination=pk(route.destination),minimum=BigInt(quote.minimumRaw),expected=BigInt(quote.expectedRaw);
    ensure(source.equals(getAssociatedTokenAddressSync(pk(launch.quoteMint),owner,false,inputProgram))&&destination.equals(getAssociatedTokenAddressSync(pk(asset.mint),owner,false,outputProgram)),'The conversion route does not use the creator authority’s own accounts.');
    const monitored=(route.monitoredAccounts||[]).map(row=>({...row,key:pk(row.address)}));ensure(monitored.length<=32,'The conversion route has too many intermediate accounts.');
    const preparedAtSlot=(await this.connection.getEpochInfo('finalized')).absoluteSlot,latest=await this.connection.getLatestBlockhash('confirmed');ensure(Number.isSafeInteger(preparedAtSlot)&&preparedAtSlot>0,'The finalized transaction expiry anchor is unavailable.');
    const message=new TransactionMessage({payerKey:payer,recentBlockhash:latest.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),...route.instructions]}).compileToV0Message(route.lookupTables||[]);
    const tx=new VersionedTransaction(message),bytes=Buffer.from(tx.serialize());ensure(bytes.length<=1232,'The conversion transaction exceeds Solana’s packet size. It has not been submitted.');
    const requiredSigners=tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures).map(str);
    ensure(requiredSigners.length===2&&requiredSigners[0]===wallet&&requiredSigners[1]===launch.creatorAuthority,'The conversion requires unexpected signers.');
    const fee=await this.connection.getFeeForMessage(tx.message,'confirmed');ensure(Number.isSafeInteger(fee.value)&&fee.value>=0,'The network fee could not be verified.');
    const watched=[payer,source,destination,...monitored.map(row=>row.key)],addresses=watched.map(str);
    const before=await this.connection.getMultipleAccountsInfo(watched,'confirmed');ensure(Array.isArray(before)&&before.length===watched.length,'The conversion accounts could not be read.');
    const tokenAmount=data=>Buffer.isBuffer(data)&&data.length>=72?data.readBigUInt64LE(64):0n;
    const payerBefore=BigInt(before[0]?.lamports||0),sourceBefore=tokenAmount(before[1]?.data),destinationBefore=tokenAmount(before[2]?.data);
    ensure(before[1]&&sourceBefore>=amount,'The pair-asset reward credit is not available in the creator authority’s account.');
    const simulated=await this.connection.simulateTransaction(tx,{sigVerify:false,commitment:'confirmed',accounts:{encoding:'base64',addresses}});
    if(simulated.value.err){const detail=this.simulationFailureDetail(launch,simulated.value,{tx,action:'basket-convert',wallet});throw Object.assign(new Error(detail.code==='METEORA_SIMULATION'?`Conversion simulation failed: ${JSON.stringify(simulated.value.err)}. No transaction was submitted.`:detail.message),{statusCode:409,code:detail.code,...(detail.shortfallLamports?{shortfallLamports:detail.shortfallLamports}:{})});}
    const after=simulated.value.accounts;ensure(Array.isArray(after)&&after.length===watched.length,'The conversion simulation did not return balances.');
    const decoded=index=>after[index]?Buffer.from(after[index].data[0],'base64'):null;
    const payerAfter=BigInt(after[0]?.lamports??0),sourceAfter=tokenAmount(decoded(1)),destinationAfter=tokenAmount(decoded(2));
    ensure(sourceBefore-sourceAfter===amount,'The conversion would spend a different amount of the pair asset.');
    ensure(destinationAfter-destinationBefore>=minimum,'The conversion would deliver less than its minimum output.');
    for(let i=0;i<monitored.length;i++){const row=monitored[i],value=after[i+3];ensure(value&&tokenAmount(decoded(i+3))>=BigInt(row.minimumAmountRaw||'0')&&BigInt(value.lamports)>=BigInt(row.minimumLamports||0),'The conversion would spend an unrelated token balance or its rent.');}
    const debit=payerBefore-payerAfter,gasLimit=BigInt(fee.value)+BigInt(route.rentLamports||0)+20000000n;ensure(debit>=0n&&debit<=gasLimit,'The conversion would spend more gas than expected.');
    const conversion={inputMint:launch.quoteMint,outputMint:asset.mint,inputRaw:String(amount),expectedRaw:String(expected),minimumRaw:String(minimum),priceImpactPct:String(quote.priceImpactPct),source:route.source,destination:route.destination,decimals:asset.decimals,program:str(outputProgram),lookupTables:(route.lookupTables||[]).length};
    return {action:'basket-convert',unsignedTransaction:bytes.toString('base64'),requiredSigners,blockhash:latest,lastValidBlockHeight:latest.lastValidBlockHeight,addresses:{dbcPool:this.poolAddress(launch).toBase58()},review:{conversion:'Jupiter',inputMint:launch.quoteMint,inputSymbol:launch.quoteSymbol,inputRaw:String(amount),outputMint:asset.mint,outputSymbol:asset.symbol||'',expectedRaw:String(expected),minimumRaw:String(minimum),priceImpactPct:String(quote.priceImpactPct),slippageBps:BASKET_LIMITS.conversionSlippageBps,networkFeeLamports:String(fee.value),maxWalletDebitLamports:String(debit),totalSolBudgetLamports:String(debit)},preparedAtSlot,preparedAt:this.now(),conversion};
  }
  send(encoded){return this.connection.sendRawTransaction(Buffer.from(encoded,'base64'),{skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0});}
  async reconcile(op,launch){
    const bundle=op.bundle;let status=(await this.connection.getSignatureStatuses([op.signature],{searchTransactionHistory:true})).value[0];
    if(status?.confirmationStatus!=='finalized'){
      if(await this.connection.getBlockHeight('finalized')<=bundle.blockhash.lastValidBlockHeight)return {state:'pending'};
      if((await this.connection.isBlockhashValid(bundle.blockhash.blockhash,{commitment:'finalized'})).value)return {state:'pending'};
      status=(await this.connection.getSignatureStatuses([op.signature],{searchTransactionHistory:true})).value[0];
      if(!status){
        // A missing RPC status is not proof of non-execution. In particular a
        // payout must never be paid again merely because an index is lagging.
        const historical=await this.connection.getTransaction(op.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
        if(historical?.meta)status={confirmationStatus:'finalized',err:historical.meta.err};
        else if(await proveExpiredAbsence(this.connection,op))return {state:'expired'};
        else return {state:'pending',notice:'The transaction expired but its finalized receipt is not indexed yet. No replacement payment will be sent.'};
      }if(status.confirmationStatus!=='finalized')return {state:'pending'};
    }
    if(status.err)return {state:'failed',error:'The Meteora transaction failed on chain; its transfers were rolled back.'};
    const response=await this.connection._rpcRequest('getTransaction',[op.signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);
    ensure(!response.error&&response.result?.meta?.err===null&&response.result.transaction?.[0]===op.signedTransaction,'The finalized receipt does not match the saved signed Meteora transaction.');
    const receipt=await this.connection.getParsedTransaction(op.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});ensure(receipt?.meta&&receipt.meta.err===null,'The finalized Meteora receipt is unavailable.');
    const result={state:'finalized',signature:op.signature,slot:receipt.slot};
    if(bundle.action==='configure'){
      // A hook-setup step proves its accounts at the receipt's slot: the two PDAs (owned by the hook program, this mint, this creator)
      // and, for a blocklist chunk, that the chain now holds at least the wallets written so far.
      if(bundle.hookSetup){ensure(launch.hook,'The hook setup receipt has no hooked launch.');const setup=await this.hookSetupState(launch,'finalized',receipt.slot);ensure(setup.exists,'The finalized transfer hook accounts were not found.');const step=bundle.hookSetupStep||{};if(Number.isInteger(step.blocklistCountAfter)&&step.blocklistCountAfter>0)ensure(setup.blocklist&&setup.blocklist.count>=step.blocklistCountAfter,'The finalized blocklist wallets were not found.');result.hookSetup={kind:step.kind||'setup',step:step.step??1,steps:step.steps??1,blocklistCount:setup.blocklist?.count??0,complete:setup.ready===true,...(bundle.transferHook?.swapBaseAmount?{swapBaseAmount:bundle.transferHook.swapBaseAmount}:{})};return result;}
      ensure(await this.config(launch,receipt.slot),'The finalized config was not found.');return result;
    }
    const r=await this.rawState(launch,receipt.slot);ensure(r,'The finalized Meteora pool was not found.');Object.assign(result,await this.state(launch,receipt.slot));result.slot=receipt.slot;result.state='finalized';
    if(bundle.action==='initialize'&&launch.hook){
      // A hooked coin: a Token-2022 mint whose transfer hook is the coin's hook program, created under Meteora's Immutable option: no
      // mint authority and no freeze authority from the first slot, exactly like a plain Launchpad coin.
      const info=await this.connection.getAccountInfo(pk(launch.mint),{commitment:'finalized',minContextSlot:receipt.slot});ensure(info?.owner.equals(TOKEN_2022_PROGRAM_ID),'The launched hooked mint is not a Token-2022 token.');const m=unpackMint(pk(launch.mint),info,TOKEN_2022_PROGRAM_ID);
      ensure(m.decimals===6&&m.supply===1000000000000000n&&!m.freezeAuthority&&!m.mintAuthority,'The launched token supply or revoked authorities do not match the approved hooked launch.');
      const hook=getTransferHook(m);ensure(hook?.programId&&hook.programId.equals(pk(launch.hook.program)),'The launched mint does not carry the coin’s transfer hook program.');
      for(const address of [launch.hook.configPda,launch.hook.extraMetasPda]){const a=await this.connection.getAccountInfo(pk(address),{commitment:'finalized',minContextSlot:receipt.slot});ensure(a?.owner.equals(pk(launch.hook.program)),'The transfer hook accounts were not created by the hook program.');}
    }
    else if(bundle.action==='initialize'){const info=await this.connection.getAccountInfo(pk(launch.mint),{commitment:'finalized',minContextSlot:receipt.slot});ensure(info?.owner.equals(TOKEN_PROGRAM_ID),'The launched mint is not an ordinary SPL token.');const m=unpackMint(pk(launch.mint),info,TOKEN_PROGRAM_ID);ensure(m.decimals===6&&m.supply===1000000000000000n&&!m.mintAuthority&&!m.freezeAuthority,'The launched token supply or revoked authorities do not match the approved launch.');}
    if(bundle.action==='hook-allow'){ensure(launch.hook?.program&&transfers(receipt).some(ix=>str(ix.programId)===launch.hook.program),'The finalized allowlist transaction did not call the hook program.');result.hookAllowlist=bundle.hookAllowlist||{add:[],remove:[]};}
    if(bundle.action==='initialize'&&BigInt(launch.creationFee?.lamports||'0')>0n){const expected=BigInt(launch.creationFee.lamports),recipient=launch.creationFee.recipient;const amount=transfers(receipt).filter(ix=>ix.program==='system'&&ix.parsed?.type==='transfer'&&ix.parsed.info.source===op.wallet&&ix.parsed.info.destination===recipient).reduce((n,ix)=>n+BigInt(ix.parsed.info.lamports),0n);ensure(amount===expected,'The finalized creation fee does not match the registered treasury payment.');const keys=receipt.transaction.message.accountKeys.map(x=>str(x.pubkey||x)),i=keys.indexOf(recipient);ensure(recipient!==op.wallet&&i>=0&&BigInt(receipt.meta.postBalances[i])-BigInt(receipt.meta.preBalances[i])>=expected,'The creation fee treasury credit could not be verified.');result.creationFeeReceipt={mint:NATIVE_MINT.toBase58(),decimals:9,amount:String(expected),recipient,selfPayment:false};}
    if(bundle.action==='migrate'){ensure(r.pool.isMigrated,'The finalized migration did not mark the curve migrated.');const pool=this.dammAddress(launch),p=await this.readDammPool(launch);this.verifyDammPool(launch,p);let locked=0n;for(const mint of bundle.migrationPositionMints){const a=derivePositionAddress(pk(mint)),position=await this.readPosition(a,receipt.slot);ensure(str(position.pool)===str(pool)&&str(position.nftMint)===mint&&str(position.unlockedLiquidity)==='0'&&str(position.vestedLiquidity)==='0','Migration LP was not permanently locked.');locked+=BigInt(str(position.permanentLockedLiquidity));}ensure(locked>0n,'Migration did not create permanently locked liquidity.');result.lpLocked=true;result.permanentLockedLiquidityRaw=String(locked);result.poolId=pool.toBase58();}
    if(bundle.expectedTrade){const base=tokenDelta(receipt,launch.mint,op.wallet);ensure(bundle.side==='sell'?base<0n:base>0n,'The receipt does not contain the expected traded token movement.');const absolute=base<0n?-base:base;ensure(bundle.side==='sell'?absolute===BigInt(bundle.amountRaw):absolute>=BigInt(bundle.expectedTrade.minOutputRaw),'The executed trade does not match the reviewed amount.');const quoteVault=str(r.pool.quoteVault);let quote=0n;for(const ix of tokenTransfers(receipt)){const i=ix.parsed.info;if(bundle.side==='sell'&&i.source===quoteVault)quote+=transferAmount(ix);if(bundle.side!=='sell'&&i.destination===quoteVault)quote+=transferAmount(ix);}if(bundle.executionVenue==='damm'){const p=await this.readDammPool(launch,receipt.slot);quote=tokenTransfers(receipt).filter(ix=>bundle.side==='sell'?ix.parsed.info.source===str(p.tokenBVault):ix.parsed.info.destination===str(p.tokenBVault)).reduce((n,ix)=>n+transferAmount(ix),0n);}ensure(quote>0n,'The trade quote movement could not be verified.');result.trade={side:bundle.side,amountRaw:String(absolute),quoteRaw:String(quote),amount:Number(absolute)/1e6,quote:Number(quote)/10**launch.quoteDecimals,time:receipt.blockTime||Math.floor(this.now()/1000)};}
    if(bundle.feeRole){const amount=tokenDelta(receipt,launch.quoteMint,bundle.receiver);ensure(amount>=0n,'The fee receipt has a negative quote credit.');const feeVaults=new Set([str(r.pool.quoteVault)]);if(r.pool.isMigrated)feeVaults.add(str((await this.readDammPool(launch,receipt.slot)).tokenBVault));const incoming=tokenTransfers(receipt).filter(ix=>ix.parsed.info.destination===bundle.receiverQuoteAta&&feeVaults.has(ix.parsed.info.source)).reduce((n,ix)=>n+transferAmount(ix),0n);ensure(incoming===amount,'The fee credit does not match the finalized token transfers.');result.fees={[`${bundle.feeRole}QuoteRaw`]:String(amount)};}
    if(bundle.conversion){
      // Reward baskets: the creator authority's pair-asset account lost exactly the planned input and its basket-asset account
      // gained at least the route's minimum; nothing else about the receipt is read into the ledger.
      const plan=bundle.conversion,spent=-tokenDelta(receipt,plan.inputMint,launch.creatorAuthority),received=tokenDelta(receipt,plan.outputMint,launch.creatorAuthority);
      ensure(spent===BigInt(plan.inputRaw),'The conversion spent a different amount of the pair asset than its durable plan.');ensure(received>=BigInt(plan.minimumRaw),'The conversion delivered less than its minimum output.');
      result.conversion={inputMint:plan.inputMint,outputMint:plan.outputMint,inputRaw:String(spent),outputRaw:String(received)};
    }
    if(bundle.payout){const payout=bundle.payout,payoutMint=payout.mint||launch.quoteMint;let debit=0n;for(const ix of tokenTransfers(receipt))if(ix.parsed.info.source===payout.sourceQuoteAta)debit+=transferAmount(ix);ensure(debit===BigInt(payout.quoteDebitRaw),'The payout debit does not match its durable plan.');for(const recipient of payout.recipients){const amount=BigInt(recipient.amount);if(payoutMint===NATIVE_MINT.toBase58()&&payout.allowPayerRecipient&&recipient.owner===op.wallet){const keys=receipt.transaction.message.accountKeys.map(x=>str(x.pubkey||x)),index=keys.indexOf(op.wallet);ensure(index===0&&BigInt(receipt.meta.postBalances[index])-BigInt(receipt.meta.preBalances[index])+BigInt(receipt.meta.fee)===amount,'The manual creator payout native credit does not match the saved amount.');}else if(payoutMint===NATIVE_MINT.toBase58()){const paid=transfers(receipt).filter(ix=>ix.program==='system'&&ix.parsed?.type==='transfer'&&ix.parsed.info.source===op.wallet&&ix.parsed.info.destination===recipient.owner).reduce((n,ix)=>n+BigInt(ix.parsed.info.lamports),0n);ensure(paid===amount,'A holder SOL payment does not match its durable plan.');}else ensure(tokenDelta(receipt,payoutMint,recipient.owner)===amount,'A holder quote-token payment does not match its durable plan.');}result.payout={quoteDebitRaw:String(debit),recipients:payout.recipients,...(payout.mint?{mint:payout.mint}:{})};}
    return safeJson(result);
  }
  async marketSnapshot(launch,quote){const r=await this.rawState(launch);if(!r)return null;let sqrt=r.pool.sqrtPrice;if(r.pool.isMigrated){const p=await this.readDammPool(launch);this.verifyDammPool(launch,p);sqrt=p.sqrtPrice;}const priceQuote=Number(getPriceFromSqrtPrice(sqrt,6,launch.quoteDecimals));const q=quote&&Number(quote.usd)>0&&quote.at<=this.now()+5000&&this.now()-quote.at<=60000?Number(quote.usd):null;return {mint:launch.mint,curve:r.address.toBase58(),status:r.pool.isMigrated?'migrated':r.pool.quoteReserve.gte(r.config.migrationQuoteThreshold)?'migrating':'curve',slot:r.slot,at:this.now(),supply:1e9,priceQuote,fdvQuote:priceQuote*1e9,priceUsd:q===null?null:priceQuote*q,fdvUsd:q===null?null:priceQuote*q*1e9,quote:{mint:launch.quoteMint,symbol:launch.quoteSymbol,usd:q,at:q===null?null:quote.at,stale:q===null},raisedQuote:Number(str(r.pool.quoteReserve))/10**launch.quoteDecimals,targetQuote:Number(str(r.config.migrationQuoteThreshold))/10**launch.quoteDecimals,progressPercent:r.pool.isMigrated?100:Math.min(100,Number(str(r.pool.quoteReserve))/Number(str(r.config.migrationQuoteThreshold))*100),poolId:r.pool.isMigrated?this.dammAddress(launch).toBase58():r.address.toBase58()};}
}
export { METEORA_POLICY, meteoraPolicy } from './meteora-policy.mjs';
