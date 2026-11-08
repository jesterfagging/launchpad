/** Offline bridge: exercise production ABI builders without an RPC connection. */
import { readFileSync } from 'node:fs';
import { migrateIx } from '../../../src/damm-pump-admin-test-client.mjs';
import { addresses, initializeIx, protocolFeesIx } from '../../../src/damm-pump-client.mjs';
import { dammPumpFeeCurveAtGraduationTarget } from '../../../src/damm-pump-fee-policy.mjs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const model = dammPumpFeeCurveAtGraduationTarget({quoteDecimals:input.quoteDecimals,quoteUsdMicros:input.quoteUsdMicros});
const a = addresses(input);
const encode = ix => ({program:String(ix.programId),data:ix.data.toString('base64'),keys:ix.keys.map(k=>({key:String(k.pubkey),writable:k.isWritable,signer:k.isSigner}))});
process.stdout.write(JSON.stringify({model,addresses:Object.fromEntries(Object.entries(a).map(([k,v])=>[k,v?.toBase58?.()??v])),initialize:encode(initializeIx({...input,model})),migrate:encode(migrateIx(input)),claim:encode(protocolFeesIx(input))}));
