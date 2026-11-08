import { launchpadEnv } from '../src/brand-env.mjs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { formatEther, getContractAddress, keccak256, parseEther, parseGwei } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { RobinhoodRpc } from '../src/robinhood-rpc.mjs';
import { evmAddress, robinhoodDefaults } from '../src/robinhood-settings.mjs';
import { deploymentErrorMessage } from '../src/robinhood-rpc-errors.mjs';
import { executorAddress, executorDeployment, verifyExecutor } from '../src/robinhood-deployment.mjs';
import { installTelegramNetworkGuard } from '../src/telegram-network.mjs';
import { readSecret } from './terminal-secret.mjs';

async function preparationStep(stage, run) {
  try { return await run(); } catch (cause) {
    const error = Error(`${stage}: ${deploymentErrorMessage(cause)}`, { cause });
    error.deploymentStage = stage; throw error;
  }
}

export async function prepareDeploymentTransaction(client, account, deployment, maximumCostEth, onStatus = () => {}) {
  if (await preparationStep('Checking chain', () => client.getChainId()) !== 4663 || deployment.chainId !== 4663) throw Error('Deployment requires Robinhood mainnet, chain ID 4663.');
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(String(maximumCostEth || ''))) throw Error('Set a positive LAUNCHPAD_ROBINHOOD_DEPLOY_MAX_ETH cost ceiling before deployment.');
  const maximumCost = parseEther(String(maximumCostEth)); if (maximumCost <= 0n) throw Error('The deployment cost ceiling must be positive.');
  const [nonce, minedNonce, block, balance] = await Promise.all([
    preparationStep('Reading pending nonce', () => client.getTransactionCount({ address: account.address, blockTag: 'pending' })),
    preparationStep('Reading mined nonce', () => client.getTransactionCount({ address: account.address, blockTag: 'latest' })),
    preparationStep('Reading latest block', () => client.getBlock()),
    preparationStep('Reading wallet balance', () => client.getBalance({ address: account.address }))
  ]);
  onStatus({ address: account.address, balance, nonce, minedNonce, baseFeePerGas: block.baseFeePerGas });
  if (balance === 0n) throw Error('The deployment wallet has 0 Robinhood ETH on chain 4663. Check the wallet address and network before funding it. Nothing was sent.');
  if (nonce !== minedNonce) throw Error('The deployment wallet has a pending transaction. Wait for its receipt before deploying.');
  if (block.baseFeePerGas == null) throw Error('RPC omitted the base fee.');
  const maxPriorityFeePerGas = parseGwei('0.001'), maxFeePerGas = block.baseFeePerGas * 2n + maxPriorityFeePerGas;
  const tx = { chainId: 4663, type: 'eip1559', data: deployment.data, value: 0n, nonce, maxFeePerGas, maxPriorityFeePerGas };
  const gas = (await preparationStep('Estimating deployment gas', () => client.estimateGas({ ...tx, account: account.address }))) * 120n / 100n, ceiling = gas * maxFeePerGas;
  if (ceiling > maximumCost) throw Error(`Deployment needs a cost ceiling of at least ${formatEther(ceiling)} Robinhood ETH. Nothing was sent.`);
  if (balance < ceiling) throw Error(`The deployment wallet has ${formatEther(balance)} Robinhood ETH; estimated maximum network cost is ${formatEther(ceiling)}. Nothing was sent.`);
  return { transaction: { ...tx, gas }, ceiling, balance, predictedAddress: getContractAddress({ from: account.address, nonce: BigInt(nonce) }) };
}

async function main() {
  const [mode = '--prepare', output, ...extra] = process.argv.slice(2);
  if (!['--prepare', '--rpc-check', '--check', '--estimate', '--broadcast'].includes(mode) || extra.length || output && !['--prepare', '--estimate'].includes(mode)) throw Error('Usage: npm run robinhood:deployment -- --prepare [output.json] | --rpc-check | --check | --estimate [public-wallet-address] | --broadcast');
  const deployment = await executorDeployment();
  if (mode === '--prepare') {
    const path = resolve(output || 'deploy/robinhood-executor-deployment.json');
    await writeFile(path, JSON.stringify({ ...deployment, note: 'Unsigned contract creation, not a release readiness certificate. Never reuse the deployer key as a customer key.' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`Unsigned deployment saved: ${path}\nChain: 4663; value: 0 ETH; runtime hash: ${deployment.expectedRuntimeHash}\nNo RPC, private key, signature or transaction submission was used.`); return;
  }
  installTelegramNetworkGuard();
  if (!launchpadEnv('ROBINHOOD_RPC_URL') && !launchpadEnv('ROBINHOOD_CASHBACK_RPC_URL') && !process.stdin.isTTY) throw Error('Set LAUNCHPAD_ROBINHOOD_RPC_URL privately on the host, or run this command in an interactive terminal.');
  const rpcUrl = launchpadEnv('ROBINHOOD_RPC_URL') || launchpadEnv('ROBINHOOD_CASHBACK_RPC_URL') || await readSecret('Robinhood mainnet RPC URL (hidden): ');
  const rpc = new RobinhoodRpc({ ...robinhoodDefaults, rpcUrl });
  if (mode === '--estimate') {
    // Enforce read-only at transport, as well as returning before the signer path.
    const request = rpc.request.bind(rpc);
    const allowed = new Set(['eth_chainId', 'eth_getCode', 'eth_call', 'eth_getBlockByNumber', 'eth_getBalance', 'eth_getTransactionCount', 'eth_estimateGas']);
    rpc.request = args => {
      if (!allowed.has(args.method)) throw Error('Read-only deployment estimate refused a non-read RPC method.');
      return request(args);
    };
    console.log('Read-only deployment estimate. No private key, signature or transaction submission.');
  }
  console.log('Checking Robinhood mainnet and pinned contract dependencies. RPC credentials remain hidden.');
  await rpc.connect();
  const block = await rpc.client.getBlock();
  if (!block.hash || !block.timestamp || Math.abs(Date.now() / 1000 - Number(block.timestamp)) > 120) throw Error('RPC returned a missing or stale latest block.');
  if (mode === '--rpc-check') {
    console.log('PASS: Robinhood chain 4663, pinned contract dependencies and a fresh latest block.\nNo key, contract deployment or trade was needed. This check does not establish successful swaps or LP round trips.'); return;
  }
  if (mode === '--check') {
    const address = await verifyExecutor(rpc.client, executorAddress());
    console.log(`PASS: chain 4663, contract dependencies, fresh block and executor bytecode.\nExecution contract: ${address}\nRuntime hash: ${deployment.expectedRuntimeHash}\nThis read-only check does not establish successful live swaps or LP round trips.`); return;
  }
  const showStatus = status => console.log(`Deployment wallet: ${status.address}\nRobinhood ETH balance: ${formatEther(status.balance)}\nNonce: pending ${status.nonce}, mined ${status.minedNonce}\nBase fee: ${status.baseFeePerGas == null ? 'missing' : `${status.baseFeePerGas} wei`}`);
  if (mode === '--estimate') {
    let address = output;
    if (!address) {
      if (!process.stdin.isTTY) throw Error('Supply the deployment wallet PUBLIC 0x address after --estimate. No private key is needed.');
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try { address = await terminal.question('Deployment wallet PUBLIC 0x address (not its private key): '); } finally { terminal.close(); }
    }
    address = evmAddress(address);
    const budget = launchpadEnv('ROBINHOOD_DEPLOY_MAX_ETH') || '0.001';
    console.log(`Deployment budget: ${budget} Robinhood ETH`);
    const prepared = await prepareDeploymentTransaction(rpc.client, { address }, deployment, budget, showStatus);
    console.log(`PASS: deployment gas estimate ${prepared.transaction.gas} (includes 20% margin).\nMaximum network cost at the current fee cap: ${formatEther(prepared.ceiling)} Robinhood ETH\nExpected contract: ${prepared.predictedAddress}\nNo transaction was signed or sent. This is an estimate, not a mined deployment.`);
    return;
  }
  const existing = executorAddress();
  if (existing) { await verifyExecutor(rpc.client, existing); throw Error('A matching execution contract is already configured. No second deployment is needed.'); }
  if (!process.stdin.isTTY) throw Error('Run deployment in an interactive terminal to enter the deployer key with hidden input.');
  const privateKey = await readSecret('Deployment wallet private key (hidden, not saved): ');
  let account; try { account = privateKeyToAccount(privateKey); } catch { throw Error('Invalid deployment private key.'); }
  const prepared = await prepareDeploymentTransaction(rpc.client, account, deployment, launchpadEnv('ROBINHOOD_DEPLOY_MAX_ETH'), showStatus);
  const signed = await account.signTransaction(prepared.transaction), hash = keccak256(signed);
  const record = { chainId: 4663, from: account.address, nonce: prepared.transaction.nonce, transactionHash: hash, contractAddress: prepared.predictedAddress, maxCostEth: formatEther(prepared.ceiling), sourceSha256: deployment.sourceSha256, runtimeHash: deployment.expectedRuntimeHash, createdAt: new Date().toISOString() };
  // Record identity before submitting. Never save the private key or signed bytes.
  const journal = resolve(`deploy/robinhood-deployment-${hash.slice(2, 14)}.json`);
  await writeFile(journal, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`Deploying from ${account.address}\nTransaction: ${hash}\nExpected contract: ${prepared.predictedAddress}\nMaximum network cost: ${record.maxCostEth} Robinhood ETH\nReceipt record: ${journal}`);
  try {
    const returned = await rpc.request({ method: 'eth_sendRawTransaction', params: [signed] });
    if (returned?.toLowerCase() !== hash.toLowerCase()) throw Error('Hash mismatch.');
  } catch { throw Error(`Deployment submission is unresolved. Check transaction ${hash} before any retry; do not deploy again blindly.`); }
  const receipt = await rpc.client.waitForTransactionReceipt({ hash, timeout: 60000, confirmations: 2 });
  if (receipt.status !== 'success' || receipt.contractAddress?.toLowerCase() !== prepared.predictedAddress.toLowerCase()) throw Error(`Deployment did not succeed at the expected address. Check ${hash}.`);
  await verifyExecutor(rpc.client, receipt.contractAddress);
  console.log(`Verified deployment. Add this public address to the web and Telegram host environment, then restart:\nLAUNCHPAD_ROBINHOOD_EXECUTOR_ADDRESS=${receipt.contractAddress}\nKeep your deployer key private. No customer keys or trading settings were modified.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(deploymentErrorMessage(error)); process.exitCode = 1;
});
