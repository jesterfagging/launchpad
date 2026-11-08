/** Offline bridge: exercise production ABI builders without an RPC connection. */
import { readFileSync } from 'node:fs';
import { addresses, initializeIx, migrateIx, protocolFeesIx } from '../../../src/damm-pump-client.mjs';
import { dammPumpCurveAtGraduationTarget } from '../../../src/damm-pump-policy.mjs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const model = dammPumpCurveAtGraduationTarget({quoteDecimals:input.quoteDecimals,quoteUsdMicros:input.quoteUsdMicros});
const a = addresses(input);
const encode = ix => ({program:String(ix.programId),data:ix.data.toString('base64'),keys:ix.keys.map(k=>({key:String(k.pubkey),writable:k.isWritable,signer:k.isSigner}))});
process.stdout.write(JSON.stringify({model,addresses:Object.fromEntries(Object.entries(a).map(([k,v])=>[k,v?.toBase58?.()??v])),initialize:encode(initializeIx({...input,model})),migrate:encode(migrateIx(input)),claim:encode(protocolFeesIx(input))}));
