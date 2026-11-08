/** Build the production post-graduation trade against an offline VM snapshot. */
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, MintLayout } from '@solana/spl-token';
import { PUMP_AMM_SDK, PUMP_AMM_FEE_CONFIG_PDA } from '@pump-fun/pump-swap-sdk';
import BN from 'bn.js';
import { DammPumpClientAdapter } from '../../../src/damm-pump-chain.mjs';
import { addresses } from '../../../src/damm-pump-client.mjs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const pk = value => new PublicKey(value);
const info = raw => raw ? {...raw, owner:pk(raw.owner), data:Buffer.from(raw.data, 'base64')} : null;
const a = addresses(input);
const rows = Object.fromEntries(Object.entries(input.accounts).map(([k,v])=>[k,info(v)]));
const get = key => rows[String(key)] ?? null;
const poolInfo = get(a.pool), pool = PUMP_AMM_SDK.decodePool(poolInfo);
const sdk = {
  globalConfig:PUMP_AMM_SDK.decodeGlobalConfig(get(a.pumpGlobal)),
  feeConfig:get(PUMP_AMM_FEE_CONFIG_PDA) ? PUMP_AMM_SDK.decodeFeeConfig(get(PUMP_AMM_FEE_CONFIG_PDA)) : null,
  poolKey:a.pool, poolAccountInfo:poolInfo, pool,
  poolBaseAmount:new BN(get(a.poolBase).data.readBigUInt64LE(64).toString()),
  poolQuoteAmount:new BN(get(a.poolQuote).data.readBigUInt64LE(64).toString()),
  baseTokenProgram:TOKEN_PROGRAM_ID, quoteTokenProgram:a.quoteTokenProgram,
  baseMint:a.mint, baseMintAccount:MintLayout.decode(get(a.mint).data), user:pk(input.user),
  userBaseTokenAccount:a.userAta, userQuoteTokenAccount:a.userQuoteAta,
  userBaseAccountInfo:get(a.userAta), userQuoteAccountInfo:get(a.userQuoteAta),
};
const connection = {getMinimumBalanceForRentExemption:async size=>{
  if(size!==165)throw Error('Unexpected native account size'); return input.nativeAccountRent;
}};
const adapter = new DammPumpClientAdapter({connection});
adapter.pumpSnapshot = async()=>({addresses:a,pool,sdk,state:{phase:2},slot:input.slot});
const built = await adapter.pumpTrade({}, {}, input.user, input.side, BigInt(input.amountRaw), 100);
const encode = ix => ({program:String(ix.programId),data:ix.data.toString('base64'),keys:ix.keys.map(k=>({key:String(k.pubkey),writable:k.isWritable,signer:k.isSigner}))});
process.stdout.write(JSON.stringify({...built,instructions:built.instructions.map(encode)}));
