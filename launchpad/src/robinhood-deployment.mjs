import { launchpadEnv } from './brand-env.mjs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { encodeDeployData, keccak256 } from 'viem';
import { CONTRACTS } from './robinhood-contracts.mjs';
import { evmAddress } from './robinhood-settings.mjs';

let artifact;
export async function executorArtifact() { return artifact ||= JSON.parse(await readFile(new URL('../contracts/artifacts/RobinhoodExecutor.json', import.meta.url), 'utf8')); }
export function executorAddress() { return launchpadEnv('ROBINHOOD_EXECUTOR_ADDRESS') ? evmAddress(launchpadEnv('ROBINHOOD_EXECUTOR_ADDRESS')) : ''; }
export async function executorDeployment() {
  const artifact = await executorArtifact();
  const source = await readFile(new URL('../contracts/RobinhoodExecutor.sol', import.meta.url));
  if (createHash('sha256').update(source).digest('hex') !== artifact.sourceSha256) throw Error('Execution-contract source changed. Run npm run robinhood:compile before preparing deployment.');
  const args = [CONTRACTS.ponsFactory, CONTRACTS.v2Router, CONTRACTS.v3PositionManager];
  return { chainId: 4663, value: '0', contract: artifact.contract, compiler: artifact.compiler, sourceSha256: artifact.sourceSha256, constructorArguments: args,
    data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args }), expectedRuntimeHash: keccak256(await expectedExecutorCode()) };
}
export async function expectedExecutorCode() {
  const artifact = await executorArtifact(), values = { ponsFactory: CONTRACTS.ponsFactory, v2Router: CONTRACTS.v2Router, v3PositionManager: CONTRACTS.v3PositionManager };
  let code = artifact.runtime.slice(2);
  for (const [name, refs] of Object.entries(artifact.immutableReferences)) {
    if (!values[name]) throw Error('Unknown execution-contract immutable.');
    for (const { start, length } of refs) { if (length !== 32) throw Error('Invalid execution-contract immutable size.'); code = code.slice(0, start * 2) + values[name].slice(2).toLowerCase().padStart(length * 2, '0') + code.slice((start + length) * 2); }
  }
  return `0x${code}`;
}
export async function verifyExecutor(client, address) {
  if (!address) throw Error('The host must deploy and configure the Robinhood execution contract before enabling this chain.');
  const code = await client.getCode({ address: evmAddress(address) });
  if (!code || code === '0x' || keccak256(code) !== keccak256(await expectedExecutorCode())) throw Error('The Robinhood execution contract does not match this release’s compiled code and pinned dependencies.');
  return evmAddress(address);
}
