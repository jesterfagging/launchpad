import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import solc from 'solc';
const name = 'RobinhoodExecutor', file = `${name}.sol`;
const source = await readFile(new URL(`../contracts/${file}`, import.meta.url), 'utf8');
const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { [file]: { content: source } }, settings: { viaIR: true, optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode'], '': ['ast'] } } } })));
if (output.errors?.some(e => e.severity === 'error')) throw Error(output.errors.map(e => e.formattedMessage).join('\n'));
const contract = output.contracts[file][name], immutableNames = {};
function visit(value) { if (!value || typeof value !== 'object') return; if (value.nodeType === 'VariableDeclaration' && value.mutability === 'immutable') immutableNames[value.id] = value.name; for (const child of Object.values(value)) if (typeof child === 'object') Array.isArray(child) ? child.forEach(visit) : visit(child); }
visit(output.sources[file].ast);
const artifact = { contract: name, compiler: solc.version(), sourceSha256: createHash('sha256').update(source).digest('hex'), abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}`, runtime: `0x${contract.evm.deployedBytecode.object}`, immutableReferences: Object.fromEntries(Object.entries(contract.evm.deployedBytecode.immutableReferences).map(([id, refs]) => [immutableNames[id], refs])) };
await mkdir(new URL('../contracts/artifacts/', import.meta.url), { recursive: true });
await writeFile(new URL(`../contracts/artifacts/${name}.json`, import.meta.url), JSON.stringify(artifact, null, 2) + '\n');
console.log(`${name}: ${artifact.runtime.slice(2).length / 2} runtime bytes; compiled with ${artifact.compiler}.`);
