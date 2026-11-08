import { launchpadEnv } from '../src/brand-env.mjs';
// Opt-in integration checks against real contracts, executing ONLY on a local fork.
// No customer key, production signer, or production transaction submission is used.
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, custom, encodeFunctionData, decodeEventLog, parseAbi, parseEther, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ROBINHOOD_CHAIN, CONTRACTS, EVM_NATIVE, positionAbi } from '../src/robinhood-contracts.mjs';
import { cleanPool, evmAddress, robinhoodDefaults } from '../src/robinhood-settings.mjs';
import { publicEndpoint } from '../src/telegram-network.mjs';
import { RobinhoodRpc } from '../src/robinhood-rpc.mjs';
import { RobinhoodPools, buildSwapPlan, otherCurrency } from '../src/robinhood-pools.mjs';
import { RobinhoodExecutor } from '../src/robinhood-executor.mjs';
import { executorDeployment, verifyExecutor } from '../src/robinhood-deployment.mjs';
import { buildLpDeposit, buildLpWithdrawal, liveLpLiquidity } from '../src/robinhood-liquidity.mjs';
import { buildFeeClaim, buildFeeCompound } from '../src/robinhood-lp-fees.mjs';

export const UPSTREAM_READ_METHODS = new Set([
  'eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash',
  'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_getTransactionCount',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getProof', 'eth_getLogs',
  'eth_call', 'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
  'net_version', 'web3_clientVersion',
]);
const transferAbi = parseAbi(['function transfer(address,uint256) returns (bool)', 'function deposit() payable']);
const positiveRaw = (value, name) => {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || BigInt(value) >= 2n ** 128n) throw Error(`${name} must be a positive raw-unit integer string below uint128.`);
  return value;
};
function onlyKeys(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`${name} must be an object.`);
  if (Object.keys(value).some(k => !keys.includes(k))) throw Error(`${name} contains an unsupported field. Private keys and RPC URLs do not belong in fixtures.`);
}
export function validateFixture(value) {
  onlyKeys(value, ['version', 'chainId', 'blockNumber', 'cases'], 'Fixture');
  if (value.version !== 1 || value.chainId !== 4663) throw Error('Fixture version 1 and Robinhood chainId 4663 are required.');
  if (value.blockNumber != null && (!Number.isSafeInteger(value.blockNumber) || value.blockNumber <= 0)) throw Error('blockNumber must be a positive safe integer.');
  if (!Array.isArray(value.cases) || !value.cases.length || value.cases.length > 20) throw Error('Provide 1–20 real-pool cases.');
  const cases = value.cases.map((item, index) => {
    onlyKeys(item, ['name', 'pool', 'input', 'buyRaw', 'funding', 'feePool', 'slippageBps', 'ppm', 'lp'], `Case ${index + 1}`);
    if (typeof item.name !== 'string' || !/^[a-zA-Z0-9 _-]{1,64}$/.test(item.name)) throw Error('Case names must use 1–64 letters, numbers, spaces, underscores or hyphens.');
    const pool = cleanPool(item.pool), input = evmAddress(item.input);
    if (!pool || ![pool.currency0, pool.currency1].includes(input)) throw Error('Each case requires an explicit pool and input belonging to that pool.');
    const ppm = item.ppm ?? 2500, slippageBps = item.slippageBps ?? 200;
    if (![1000, 2500, 10000].includes(ppm)) throw Error('ppm must be a current Launchpad trade fee: 1000, 2500 or 10000.');
    if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 1000) throw Error('Fixture slippageBps must be 1–1000.');
    if (!Array.isArray(item.funding) || item.funding.length > 10) throw Error('funding must be an array of up to 10 public token-holder fixtures.');
    const funding = item.funding.map(f => {
      onlyKeys(f, ['token', 'holder', 'raw'], 'Funding');
      const token = evmAddress(f.token), holder = f.holder ? evmAddress(f.holder) : null;
      if (token === EVM_NATIVE) throw Error('Native ETH is funded by Anvil automatically; omit it from funding.');
      if (token !== CONTRACTS.weth && !holder) throw Error('ERC20 funding requires a public holder address to impersonate on the fork only.');
      return { token, holder, raw: positiveRaw(f.raw, 'Funding raw') };
    });
    let lp;
    if (item.lp) {
      if (pool.protocol === 'pons-curve') throw Error('Pons curves do not accept user LP deposits; supply their graduated pool in a separate case.');
      onlyKeys(item.lp, ['amount0Raw', 'amount1Raw', 'feeTradeRaw'], 'LP');
      lp = Object.fromEntries(['amount0Raw', 'amount1Raw', 'feeTradeRaw'].map(key => [key, positiveRaw(item.lp[key], key)]));
    }
    return { name: item.name, pool, input, buyRaw: positiveRaw(item.buyRaw, 'buyRaw'), funding, feePool: cleanPool(item.feePool), ppm, slippageBps, lp };
  });
  return { version: 1, chainId: 4663, ...(value.blockNumber ? { blockNumber: value.blockNumber } : {}), cases };
}

export function assertLoopbackRpc(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('Fork signing is restricted to the ephemeral 127.0.0.1 HTTP endpoint.');
  return url.toString();
}
export function scrubError(error, secrets = []) {
  let text = String(error?.shortMessage || error?.message || 'Fork validation failed.');
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[redacted]');
  return text.replace(/(?:https?|wss?):\/\/\S+/gi, '[RPC URL]').replace(/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g, '[hash or key]').slice(0, 800);
}
export function readOnlyUpstream(upstream, fetcher = fetch) {
  let sequence = 0;
  return async ({ method, params = [] }) => {
    if (!UPSTREAM_READ_METHODS.has(method)) throw Error('Upstream mutation methods are forbidden by the fork checker.');
    const response = await fetcher(upstream, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }), signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw Error(`Upstream read ${method} returned HTTP ${response.status}.`);
    let data; try { data = await response.json(); } catch { throw Error(`Upstream read ${method} did not return JSON.`); }
    if (data.error) {
      // Never relay provider messages or arbitrary data: either may contain URL credentials.
      const error = Error(`Upstream read ${method} failed with RPC code ${Number(data.error.code) || -32000}.`); error.code = Number(data.error.code) || -32000; throw error;
    }
    if (!Object.hasOwn(data, 'result')) throw Error('Upstream read returned an invalid JSON-RPC response.');
    return data.result;
  };
}
export async function startReadOnlyProxy(read) {
  const server = createServer(async (req, res) => {
    const respond = data => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.method !== 'POST' || req.url !== '/') { res.writeHead(405); res.end(); return; }
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw Error('RPC request exceeds limit.'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const one = async call => {
        const id = typeof call?.id === 'number' || typeof call?.id === 'string' ? call.id : null;
        if (!call || !UPSTREAM_READ_METHODS.has(call.method) || call.jsonrpc !== '2.0' || !Array.isArray(call.params || [])) return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Only allowlisted read methods may reach the upstream RPC.' } };
        try { return { jsonrpc: '2.0', id, result: await read({ method: call.method, params: call.params || [] }) }; }
        catch (error) { return { jsonrpc: '2.0', id, error: { code: Number(error.code) || -32000, message: 'Upstream read failed. Check RPC access and archive availability.' } }; }
      };
      if (Array.isArray(body) && (body.length === 0 || body.length > 100)) throw Error('Invalid batch size.');
      respond(Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body));
    } catch { respond({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid local fork request.' } }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
export function localRequest(url, fetcher = fetch) {
  const endpoint = assertLoopbackRpc(url); let sequence = 0;
  return async ({ method, params = [] }) => {
    assertLoopbackRpc(endpoint);
    const response = await fetcher(endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }), signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw Error(`Local fork RPC ${method} returned HTTP ${response.status}.`);
    const data = await response.json();
    if (data.error) { const error = Error(`Local fork ${method} failed: ${scrubError({ message: data.error.message })}`); error.code = data.error.code; error.data = data.error.data; throw error; }
    return data.result;
  };
}
async function freePort() {
  const server = createTcpServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function startFork(proxyUrl, blockNumber) {
  assertLoopbackRpc(proxyUrl); const port = await freePort(), url = `http://127.0.0.1:${port}/`;
  // The child receives a local proxy URL, never the credential-bearing upstream URL.
  // Invoke the package's JS launcher with Node, not a Unix-only .bin shim.
  const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/@foundry-rs/anvil/bin.mjs', import.meta.url)), '--host', '127.0.0.1', '--port', String(port), '--chain-id', '4663', '--fork-url', proxyUrl, '--fork-block-number', String(blockNumber), '--no-storage-caching'], { stdio: 'ignore', env: { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } });
  const stop = async () => { if (child.exitCode !== null || child.signalCode !== null) return; child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
  let spawnError; child.once('error', () => { spawnError = true; });
  const request = localRequest(url), client = createPublicClient({ chain: ROBINHOOD_CHAIN, transport: custom({ request }, { retryCount: 0 }) });
  try {
    const limit = Date.now() + 45000;
    while (Date.now() < limit) {
      if (spawnError || child.exitCode !== null) throw Error('Anvil could not start. Check the installed development dependencies and upstream archive support.');
      try {
        const version = await request({ method: 'web3_clientVersion' });
        if (/anvil/i.test(version) && await client.getChainId() === 4663) return { url, request, client, stop };
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw Error('Local fork startup timed out. Check upstream archive support.');
  } catch (error) { await stop(); throw error; }
}
function forkRpc(fork) {
  // Reuse the production RPC connect/token/balance checks, replacing its request
  // transport with the already-verified loopback fork. No public-network signer.
  const rpc = new RobinhoodRpc({ ...robinhoodDefaults, rpcRequestsPerSecond: 1000, maxGasGwei: '100000', reserveEth: '0' });
  rpc.request = args => fork.request(args); rpc.client = fork.client; rpc.url = assertLoopbackRpc(fork.url); return rpc;
}
async function successfulReceipt(client, hash) {
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60000, pollingInterval: 50 });
  if (receipt.status !== 'success') throw Error('Local fork transaction reverted.'); return receipt;
}
async function fundTokens(fork, rpc, account, funding) {
  const signer = createWalletClient({ account, chain: ROBINHOOD_CHAIN, transport: custom({ request: fork.request }, { retryCount: 0 }) });
  for (const f of funding) {
    const before = await rpc.balance(account.address, f.token), amount = BigInt(f.raw);
    if (f.token === CONTRACTS.weth && !f.holder) {
      await successfulReceipt(fork.client, await signer.writeContract({ address: CONTRACTS.weth, abi: transferAbi, functionName: 'deposit', value: amount }));
    } else {
      if (await rpc.balance(f.holder, f.token) < amount) throw Error('Public funding holder lacks the requested ERC20 amount at the fork block.');
      await fork.request({ method: 'anvil_setBalance', params: [f.holder, toHex(parseEther('100'))] });
      await fork.request({ method: 'anvil_impersonateAccount', params: [f.holder] });
      try {
        const hash = await fork.request({ method: 'eth_sendTransaction', params: [{ from: f.holder, to: f.token, data: encodeFunctionData({ abi: transferAbi, functionName: 'transfer', args: [account.address, amount] }), gas: '0x4c4b40' }] });
        await successfulReceipt(fork.client, hash);
      } finally { await fork.request({ method: 'anvil_stopImpersonatingAccount', params: [f.holder] }); }
    }
    if (await rpc.balance(account.address, f.token) - before !== amount) throw Error('Funding did not deliver the exact requested amount; this token needs a dedicated integration fixture.');
  }
}
const positive = n => n > 0n ? n : 0n;
async function runCase(fork, rpc, adapter, item) {
  const privateKey = generatePrivateKey(), account = privateKeyToAccount(privateKey), wallet = { publicKey: account.address, privateKey };
  const collector = privateKeyToAccount(generatePrivateKey()).address;
  await fork.request({ method: 'anvil_setBalance', params: [wallet.publicKey, toHex(parseEther('1000'))] });
  await fundTokens(fork, rpc, account, item.funding);
  const pools = new RobinhoodPools(rpc), pool = await pools.validate(item.pool), feePool = item.feePool ? await pools.validate(item.feePool) : null;
  const ledger = { data: { pending: [], feeReceipts: [] }, save: async () => {} };
  const executor = new RobinhoodExecutor(rpc, ledger, { policy: { adapter, mainWallet: wallet.publicKey, cashbackBps: 0, accountId: 'local-fork-only', version: 'fork-check' } });
  const results = [];
  const send = async (plan, operation) => {
    assertLoopbackRpc(rpc.url); await executor.approvals(wallet, plan.approvals || []);
    const feeBefore = await rpc.client.getBalance({ address: collector });
    const receipt = await executor.send(wallet, plan, { operation });
    if (ledger.data.pending.length) throw Error('Local fork receipt was not reconciled.');
    const fees = (await rpc.client.getBalance({ address: collector })) - feeBefore;
    if (BigInt(plan.feeEth || 0) && (fees <= 0n || fees > BigInt(plan.feeEth))) throw Error('Local fee transfer did not match its signed bound.');
    if (!BigInt(plan.feeEth || 0) && fees !== 0n) throw Error('A fee-free operation charged a Launchpad fee.');
    results.push({ operation, status: 'passed', transactionHash: receipt.transactionHash }); return receipt;
  };
  const swap = async (input, amount, operation) => {
    const output = otherCurrency(pool, input);
    const plan = await buildSwapPlan({ pools, pool, input, amount, wallet: wallet.publicKey, recipient: collector, adapter, ppm: item.ppm, slippageBps: item.slippageBps, feePool });
    // Keep approval gas outside the swap's native-output balance measurement.
    await executor.approvals(wallet, plan.approvals || []);
    const before = await rpc.balance(wallet.publicKey, output);
    const receipt = await send(plan, operation);
    let delta = (await rpc.balance(wallet.publicKey, output)) - before;
    if (output === EVM_NATIVE) delta += BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice) + BigInt(plan.value || 0);
    if (delta < BigInt(plan.minimum)) throw Error('Swap output was below the production plan minimum.');
    return delta;
  };
  const output = otherCurrency(pool, item.input), bought = await swap(item.input, BigInt(item.buyRaw), 'buy');
  await swap(output, bought, 'sell');
  if (item.lp) {
    const deposit = await buildLpDeposit({ pools, pool, wallet: wallet.publicKey, amount0: BigInt(item.lp.amount0Raw), amount1: BigInt(item.lp.amount1Raw), preset: 'balanced', rangeBps: 2000, slippageBps: item.slippageBps });
    const beforeLp = pool.protocol === 'v2' ? await rpc.balance(wallet.publicKey, pool.address) : 0n;
    const receipt = await send(deposit, 'lp-deposit');
    let tokenId, liquidity = deposit.liquidity;
    if (pool.protocol === 'v2') { liquidity = String((await rpc.balance(wallet.publicKey, pool.address)) - beforeLp); tokenId = pool.address; }
    else {
      const manager = pool.protocol === 'v3' ? CONTRACTS.v3PositionManager : CONTRACTS.positionManager;
      for (const log of receipt.logs) if (log.address.toLowerCase() === manager.toLowerCase()) try {
        const d = decodeEventLog({ abi: positionAbi, eventName: 'Transfer', topics: log.topics, data: log.data });
        if (d.args.from === EVM_NATIVE && d.args.to.toLowerCase() === wallet.publicKey.toLowerCase()) tokenId = String(d.args.tokenId);
      } catch {}
      if (!tokenId) throw Error('LP mint did not emit an NFT transfer to the fixture wallet.');
    }
    const lot = { pool, wallet: wallet.publicKey, tokenId, liquidity, lower: deposit.lower, upper: deposit.upper };
    const minted = await liveLpLiquidity(rpc, lot); if (minted <= 0n) throw Error('LP mint created no usable liquidity.'); lot.liquidity = String(minted);
    // Controlled local-only trades create real contract fee growth on the fork.
    const feeBuy = await swap(item.input, BigInt(item.lp.feeTradeRaw), 'lp-fee-accrual-buy');
    await swap(output, feeBuy, 'lp-fee-accrual-sell');
    if (pool.protocol === 'v2') results.push({ operation: 'lp-fee-claim-and-compound', status: 'not-applicable', reason: 'v2 retains trading fees in reserves.' });
    else {
      const claim = await buildFeeClaim({ rpc, lot, wallet: wallet.publicKey, slippageBps: item.slippageBps });
      if (!claim) throw Error('Fixture accrued too little LP income to test claiming. Increase its local LP share or feeTradeRaw.');
      const tokens = [pool.currency0, pool.currency1], balances = await Promise.all(tokens.map(token => rpc.balance(wallet.publicKey, token)));
      const claimed = await send(claim, 'lp-claim');
      const amounts = {};
      for (const [i, token] of tokens.entries()) {
        let delta = (await rpc.balance(wallet.publicKey, token)) - balances[i];
        if (token === EVM_NATIVE) delta += BigInt(claimed.gasUsed) * BigInt(claimed.effectiveGasPrice);
        const credited = positive(delta), bound = BigInt(claim.amounts[i]); amounts[token] = String(credited < bound ? credited : bound);
      }
      if (await liveLpLiquidity(rpc, lot) !== minted) throw Error('Fee claiming changed LP principal.');
      const compound = await buildFeeCompound({ rpc, pools, lot, wallet: wallet.publicKey, amounts, slippageBps: item.slippageBps });
      if (!compound) throw Error('Fixture accrued insufficient two-sided fees to test compounding. Increase its local LP share or feeTradeRaw.');
      await send(compound, 'lp-compound');
      const increased = await liveLpLiquidity(rpc, lot); if (increased <= minted) throw Error('Compounding did not increase LP liquidity.'); lot.liquidity = String(increased);
    }
    // Both user withdrawal and fee-bearing automatic adjustment use the same
    // locally created position, with a fork snapshot restoring it between checks.
    const snapshot = await fork.request({ method: 'evm_snapshot' });
    for (const automatic of [false, true]) {
      const plan = await buildLpWithdrawal({ rpc, pools, lot, wallet: wallet.publicKey, automatic, recipient: collector, adapter, slippageBps: item.slippageBps, feePool });
      await send(plan, automatic ? 'lp-automatic-withdrawal' : 'lp-manual-withdrawal');
      if (await liveLpLiquidity(rpc, lot) !== 0n) throw Error('Withdrawal left position liquidity behind.');
      if (!automatic && !await fork.request({ method: 'evm_revert', params: [snapshot] })) throw Error('Local LP snapshot could not be restored.');
    }
  }
  return { name: item.name, protocol: pool.protocol || 'v4', status: 'passed', checks: results };
}

export async function runForkCheck(fixture, upstream, { progress = console.log } = {}) {
  fixture = validateFixture(fixture); upstream = publicEndpoint(upstream).toString();
  const read = readOnlyUpstream(upstream);
  if (BigInt(await read({ method: 'eth_chainId' })) !== 4663n) throw Error('Upstream must be Robinhood mainnet chain 4663.');
  const blockNumber = fixture.blockNumber ?? Number(BigInt(await read({ method: 'eth_blockNumber' })));
  const upstreamBlock = await read({ method: 'eth_getBlockByNumber', params: [toHex(blockNumber), false] });
  if (!upstreamBlock?.hash) throw Error('Upstream did not return the requested fork block.');
  const proxy = await startReadOnlyProxy(read); let fork;
  const report = { kind: 'local-mainnet-fork', chainId: 4663, blockNumber, blockHash: upstreamBlock.hash, realFundsUsed: false, startedAt: new Date().toISOString(), cases: [] };
  try {
    progress(`Starting read-only Robinhood fork at block ${blockNumber}. All transactions stay on loopback.`);
    fork = await startFork(proxy.url, blockNumber); const rpc = forkRpc(fork); await rpc.connect();
    if ((await fork.client.getBlock({ blockNumber: BigInt(blockNumber) })).hash !== upstreamBlock.hash) throw Error('Local fork block identity differs from upstream.');
    // Production builders use wall-clock deadlines, so align only the local fork.
    const timestamp = Math.max(Math.floor(Date.now() / 1000), Number(BigInt(upstreamBlock.timestamp)) + 1);
    await fork.request({ method: 'evm_setNextBlockTimestamp', params: [timestamp] });
    const deployer = privateKeyToAccount(generatePrivateKey());
    await fork.request({ method: 'anvil_setBalance', params: [deployer.address, toHex(parseEther('100'))] });
    const wallet = createWalletClient({ account: deployer, chain: ROBINHOOD_CHAIN, transport: custom({ request: fork.request }, { retryCount: 0 }) });
    const deployment = await executorDeployment(), receipt = await successfulReceipt(fork.client, await wallet.sendTransaction({ data: deployment.data }));
    const adapter = await verifyExecutor(fork.client, receipt.contractAddress); report.localExecutor = adapter; report.runtimeHash = deployment.expectedRuntimeHash;
    for (const item of fixture.cases) {
      const snapshot = await fork.request({ method: 'evm_snapshot' }); progress(`Checking ${item.name}: buy/sell${item.lp ? ', LP deposit, earned-fee handling and both withdrawals' : ''}.`);
      try { report.cases.push(await runCase(fork, rpc, adapter, item)); }
      catch (error) { report.cases.push({ name: item.name, protocol: item.pool.protocol || 'v4', status: 'failed', error: scrubError(error, [upstream]) }); }
      finally { if (!await fork.request({ method: 'evm_revert', params: [snapshot] })) throw Error('Local case snapshot could not be restored.'); }
    }
    report.passed = report.cases.every(item => item.status === 'passed'); report.finishedAt = new Date().toISOString(); return report;
  } finally { if (fork) await fork.stop(); await proxy.close(); }
}

async function main() {
  const [fixturePath, reportPath, ...extra] = process.argv.slice(2);
  if (!fixturePath || extra.length) throw Error('Usage: node scripts/robinhood-fork-check.mjs <fixture.json> [new-report.json]');
  const upstream = launchpadEnv('ROBINHOOD_RPC_URL');
  if (!upstream) throw Error('Set LAUNCHPAD_ROBINHOOD_RPC_URL privately to an archive-capable Robinhood mainnet RPC. No private key is required.');
  const fixture = validateFixture(JSON.parse(await readFile(fixturePath, 'utf8')));
  const report = await runForkCheck(fixture, upstream);
  if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  for (const item of report.cases) console.log(`${item.status.toUpperCase()} ${item.name}${item.error ? `: ${item.error}` : ''}`);
  console.log('Scope: supplied real-pool fixtures on a local fork. This does not deploy to mainnet, test live landing latency, or certify untested pools and hooks.');
  if (!report.passed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(scrubError(error, [launchpadEnv('ROBINHOOD_RPC_URL')])); process.exitCode = 1; });
