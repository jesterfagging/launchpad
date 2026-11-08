// Prints the deployment pin for one of your own Solana program builds: the addresses the program, its upload buffer
// and its ProgramData account will have when your operator wallet deploys it with the given seeds, and the binary's
// SHA-256 and length. Paste the result into the matching *_DEPLOYMENT_POLICY in src/*-deployment.mjs (docs/PROGRAMS.md).
// Reads one local file; no network, no keys.
//
//   node scripts/program-pins.mjs --operator <wallet> --treasury <wallet> \
//     --program-seed my-public-v1 --buffer-seed my-public-buf-v1 --binary private/pump-public/curve_pump_public.so
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const USAGE = 'Usage: node scripts/program-pins.mjs --operator <wallet> --treasury <wallet> --program-seed <seed> --buffer-seed <seed> --binary <file.so>';

function options(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw Error(USAGE);
    out[key.slice(2)] = value;
  }
  for (const key of ['operator', 'treasury', 'program-seed', 'buffer-seed', 'binary']) if (!out[key]) throw Error(USAGE);
  return out;
}
function wallet(value, name) {
  let key; try { key = new PublicKey(value); } catch { throw Error(`${name} is not a Solana address.`); }
  if (key.toBase58() !== value || !PublicKey.isOnCurve(key.toBytes())) throw Error(`${name} must be a regular wallet address.`);
  return key;
}
function seed(value, name) {
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(value)) throw Error(`${name} must be 1 to 32 letters, numbers, dots, dashes or underscores.`);
  return value;
}

async function main() {
  const args = options(process.argv.slice(2));
  const operator = wallet(args.operator, '--operator'), treasury = wallet(args.treasury, '--treasury');
  const programSeed = seed(args['program-seed'], '--program-seed'), bufferSeed = seed(args['buffer-seed'], '--buffer-seed');
  if (programSeed === bufferSeed) throw Error('Use different program and buffer seeds.');
  const binary = await readFile(args.binary);
  if (binary.length < 1024 || binary.subarray(0, 4).toString('latin1') !== '\x7fELF') throw Error(`${args.binary} is not a Solana program build (.so).`);
  const programId = await PublicKey.createWithSeed(operator, programSeed, LOADER);
  const buffer = await PublicKey.createWithSeed(operator, bufferSeed, LOADER);
  const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], LOADER);
  const pin = {
    operator: operator.toBase58(), treasury: treasury.toBase58(),
    binarySha256: createHash('sha256').update(binary).digest('hex'), binaryLength: binary.length,
    programSeed, bufferSeed, programId: programId.toBase58(), buffer: buffer.toBase58(), programData: programData.toBase58(),
  };
  for (const [key, value] of Object.entries(pin)) process.stdout.write(`  ${key}: ${typeof value === 'number' ? value : `'${value}'`},\n`);
}
main().catch(error => { process.stderr.write(String(error?.message || error) + '\n'); process.exitCode = 1; });
