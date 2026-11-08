import { Keypair, SystemProgram, PublicKey } from '@solana/web3.js';
import { performance } from 'node:perf_hooks';
import { SOL, JUPITER } from '../src/core.mjs';
export const lead = Keypair.generate().publicKey.toBase58();
export const lead2 = Keypair.generate().publicKey.toBase58();
export const mint = Keypair.generate().publicKey.toBase58();
export const quote = Keypair.generate().publicKey.toBase58();
export const key1 = Keypair.generate(), key2 = Keypair.generate();
export const blockhash = Keypair.generate().publicKey.toBase58();
export const token = (owner, mint, amount, decimals = 6, index = 2) => ({ owner, mint, accountIndex: index, uiTokenAmount: { amount: String(amount), decimals } });
export function swap({ owner = lead, input = SOL, output = mint, before = 1000n, sold = 500n, received = 100n, program = JUPITER, instructions = [] } = {}) {
  const preTokenBalances = [], postTokenBalances = [];
  if (input !== SOL) { preTokenBalances.push(token(owner,input,before,6,2)); postTokenBalances.push(token(owner,input,before-sold,6,2)); }
  if (output !== SOL) { preTokenBalances.push(token(owner,output,0,6,3)); postTokenBalances.push(token(owner,output,received,6,3)); }
  return { transaction: { message: { accountKeys: [{pubkey:owner,signer:true},{pubkey:program,signer:false}], instructions } }, meta: { err:null,fee:5000,preBalances:[1e9,1],postBalances:[1e9-5000+(input===SOL?-10000000:output===SOL?10000000:0),1],preTokenBalances,postTokenBalances,logMessages:[`Program ${program} invoke [1]`,'Program log: Instruction: Swap',`Program ${program} success`] } };
}
export function build(order,wallet) {
  const ix=SystemProgram.transfer({fromPubkey:new PublicKey(wallet.publicKey),toPubkey:new PublicKey(quote),lamports:1});
  return {inputMint:order.inputMint,outputMint:order.outputMint,inAmount:String(order.amount),outAmount:'1000',otherAmountThreshold:'980',slippageBps:200,swapMode:'ExactIn',routeName:'Mock route',swapInstruction:{programId:ix.programId.toBase58(),accounts:ix.keys.map(k=>({pubkey:k.pubkey.toBase58(),isSigner:k.isSigner,isWritable:k.isWritable})),data:ix.data.toString('base64')},blockhashWithMetadata:{blockhash,lastValidBlockHeight:1000},addressesByLookupTableAddress:{}};
}
export function config({mode='paper',wallets=[key1],...rest}={}) {
  return {mode,leads:[lead],wallets:wallets.map((key,index)=>({label:`Wallet ${index+1}`,publicKey:key.publicKey.toBase58(),privateKey:mode==='live'?JSON.stringify([...key.secretKey]):'',amount:'0.05'})),heliusKey:'dummy-test-key',jupiterKey:'dummy-jupiter',sendRpc:true,heliusSol:'0',jitoSol:'0',prioritySol:'0.0001',buyAmount:'0.05',...rest};
}
export function event(tx=swap(),signature=Keypair.generate().publicKey.toBase58()) {return {tx,signature,slot:123,receivedAt:Date.now(),observedAt:performance.now()};}
