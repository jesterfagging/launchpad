import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { createPublicClient, createWalletClient, http, parseEther, decodeEventLog } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import solc from 'solc';
import { ROBINHOOD_CHAIN, EVM_NATIVE } from '../src/robinhood-contracts.mjs';
import { executorArtifact } from '../src/robinhood-deployment.mjs';

const mocks = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import "RobinhoodExecutor.sol";
contract Coin {
 mapping(address=>uint) public balanceOf; mapping(address=>mapping(address=>uint)) public allowance;
 function mint(address a,uint n) external { balanceOf[a]+=n; }
 function approve(address a,uint n) external returns(bool){allowance[msg.sender][a]=n;return true;}
 function transfer(address a,uint n) external returns(bool){balanceOf[msg.sender]-=n;balanceOf[a]+=n;return true;}
 function transferFrom(address a,address b,uint n) external returns(bool){allowance[a][msg.sender]-=n;balanceOf[a]-=n;balanceOf[b]+=n;return true;}
}
contract Factory is IPonsFactory {
 mapping(address=>Launch) private launches;
 function set(address token,address curve,address quote,uint8 phase) external { launches[token] = Launch(token,curve,msg.sender,msg.sender,quote,0,3000,60,0,false,phase,0,0,0,true); }
 function getLaunchedToken(address t) external view returns(Launch memory){return launches[t];}
}
contract Launchpad {
 address public immutable factory; address public immutable token; address public immutable pairToken;
 bool public partialFill; bool public failing; address public lastRecipient;
 constructor(address f,address t,address q){factory=f;token=t;pairToken=q;}
 receive() external payable{}
 function configure(bool p,bool f) external {partialFill=p;failing=f;}
 function buy(uint n,uint minimum,address recipient) external payable returns(uint){
 require(!failing);lastRecipient=recipient;
 if(pairToken==address(0))require(msg.value==n);else {require(msg.value==0);Coin(pairToken).transferFrom(msg.sender,address(this),n);}
 uint spent=partialFill?n/2:n; uint out=spent*4;require(out>=minimum);Coin(token).mint(recipient,out);
 if(spent<n){if(pairToken==address(0)){(bool ok,)=msg.sender.call{value:n-spent}("");require(ok);}else Coin(pairToken).transfer(msg.sender,n-spent);}return out;}
 function sell(uint n,uint minimum,address recipient) external returns(uint){require(!failing);lastRecipient=recipient;Coin(token).transferFrom(msg.sender,address(this),n);uint out=n/4;require(out>=minimum);if(pairToken==address(0)){(bool ok,)=recipient.call{value:out}("");require(ok);}else Coin(pairToken).transfer(recipient,out);return out;}
}
contract Positions {
 mapping(uint=>address) public ownerOf; mapping(uint=>address) public getApproved; mapping(uint=>uint128) public liquidity;
 function setup(uint id,address owner,uint128 amount) external {ownerOf[id]=owner;liquidity[id]=amount;}
 function approve(address to,uint id) external {require(ownerOf[id]==msg.sender);getApproved[id]=to;}
 function decreaseLiquidity(IV3Positions.Decrease calldata p) external payable returns(uint,uint){require(msg.sender==ownerOf[p.tokenId]||getApproved[p.tokenId]==msg.sender);liquidity[p.tokenId]-=p.liquidity;return(p.liquidity,p.liquidity);}
 function collect(IV3Positions.Collect calldata p) external payable returns(uint,uint){require(msg.sender==ownerOf[p.tokenId]||getApproved[p.tokenId]==msg.sender);return(10,10);}
}
contract RejectEther {receive() external payable {revert();}}
`;
test('local EVM: atomic curve fees, partial refunds, ERC20 quotes, custody and LP authorization', { timeout: 90000 }, async t => {
  const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise(r => server.close(r));
  const process = spawn(new URL('../node_modules/.bin/anvil', import.meta.url).pathname, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '4663'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => process.kill('SIGTERM'));
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Local EVM did not start.')), 12000); const done = text => { if (String(text).includes('Listening on')) { clearTimeout(timer); resolve(); } }; process.stdout.on('data', done); process.stderr.on('data', done); process.once('error', reject); });
  // Public Anvil fixture key; only used with the loopback EVM created above.
  const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  const transport = http(`http://127.0.0.1:${port}`), client = createPublicClient({ chain: ROBINHOOD_CHAIN, transport }), wallet = createWalletClient({ account, chain: ROBINHOOD_CHAIN, transport });
  const source = await readFile(new URL('../contracts/RobinhoodExecutor.sol', import.meta.url), 'utf8');
  const built = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'RobinhoodExecutor.sol': { content: source }, 'Mocks.sol': { content: mocks } }, settings: { viaIR: true, optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  assert(!built.errors?.some(e => e.severity === 'error'), built.errors?.map(e => e.formattedMessage).join('\n'));
  const deploy = async (name, args = []) => { const c = built.contracts['Mocks.sol'][name]; const hash = await wallet.deployContract({ abi: c.abi, bytecode: `0x${c.evm.bytecode.object}`, args }); const receipt = await client.waitForTransactionReceipt({ hash }); assert.equal(receipt.status, 'success'); return { address: receipt.contractAddress, abi: c.abi }; };
  const write = async (c, functionName, args, value = 0n) => { const hash = await wallet.writeContract({ ...c, functionName, args, value }); const receipt = await client.waitForTransactionReceipt({ hash }); assert.equal(receipt.status, 'success'); return receipt; };
  const read = (c, functionName, args = []) => client.readContract({ ...c, functionName, args });
  const factory = await deploy('Factory'), coin = await deploy('Coin'), quote = await deploy('Coin'), positions = await deploy('Positions'), reject = await deploy('RejectEther');
  const artifact = await executorArtifact(), hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [factory.address, factory.address, positions.address] }), receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success'); const adapter = { address: receipt.contractAddress, abi: artifact.abi };
  const curve = await deploy('Launchpad', [factory.address, coin.address, EVM_NATIVE]); await write(factory, 'set', [coin.address, curve.address, EVM_NATIVE, 0]);
  const collector = '0x3333333333333333333333333333333333333333', stranger = '0x4444444444444444444444444444444444444444', fee = parseEther('0.0025'), amount = parseEther('1'), deadline = BigInt(Math.floor(Date.now() / 1000) + 1000);
  await t.test('native buy pays fee and delivers tokens directly to the user', async () => {
    await write(adapter, 'curveSwap', [coin.address, true, amount, amount * 4n, collector, fee, deadline], amount + fee);
    assert.equal(await read(coin, 'balanceOf', [account.address]), amount * 4n); assert.equal(await read(curve, 'lastRecipient'), account.address);
    assert.equal(await client.getBalance({ address: collector }), fee); assert.equal(await client.getBalance({ address: adapter.address }), 0n);
  });
  await t.test('failed curve execution never charges the fee', async () => {
    await write(curve, 'configure', [false, true]);
    await assert.rejects(() => client.simulateContract({ ...adapter, account, functionName: 'curveSwap', args: [coin.address, true, amount, 1n, collector, fee, deadline], value: amount + fee }));
    assert.equal(await client.getBalance({ address: collector }), fee); await write(curve, 'configure', [true, false]);
  });
  await t.test('graduation partial fill refunds input and pro-rates the fee', async () => {
    const result = await write(adapter, 'curveSwap', [coin.address, true, amount, amount * 2n, collector, fee, deadline], amount + fee);
    const event = result.logs.flatMap(l => { try { const d = decodeEventLog({ abi: adapter.abi, ...l }); return d.eventName === 'CurveTraded' ? [d.args] : []; } catch { return []; } });
    assert.equal(event[0].inputSpent, amount / 2n); assert.equal(await client.getBalance({ address: collector }), fee + fee / 2n); assert.equal(await client.getBalance({ address: adapter.address }), 0n);
  });
  await t.test('ERC20 stock quote buy/sell returns assets and clears curve allowances', async () => {
    const stockCurve = await deploy('Launchpad', [factory.address, coin.address, quote.address]); await write(factory, 'set', [coin.address, stockCurve.address, quote.address, 0]);
    await write(quote, 'mint', [account.address, amount]); await write(quote, 'approve', [adapter.address, amount]);
    await write(adapter, 'curveSwap', [coin.address, true, amount, amount * 4n, collector, fee, deadline], fee);
    await write(coin, 'approve', [adapter.address, amount * 4n]); await write(adapter, 'curveSwap', [coin.address, false, amount * 4n, amount, collector, fee, deadline], fee);
    assert.equal(await read(quote, 'balanceOf', [account.address]), amount); assert.equal(await read(quote, 'balanceOf', [adapter.address]), 0n); assert.equal(await read(coin, 'balanceOf', [adapter.address]), 0n);
    assert.equal(await read(quote, 'allowance', [adapter.address, stockCurve.address]), 0n); assert.equal(await read(coin, 'allowance', [adapter.address, stockCurve.address]), 0n);
  });
  await t.test('NFT approvals cannot be used by someone other than the recorded owner', async () => {
    await write(positions, 'setup', [1n, stranger, 1000n]);
    await assert.rejects(() => client.simulateContract({ ...adapter, account, functionName: 'withdrawV3', args: [1n, 1000n, 0n, 0n, collector, fee, deadline], value: fee }));
    assert.equal(await read(positions, 'liquidity', [1n]), 1000n);
  });
  await t.test('a rejected LP fee rolls back the withdrawal in the same transaction', async () => {
    await write(positions, 'setup', [2n, account.address, 1000n]); await write(positions, 'approve', [adapter.address, 2n]);
    await assert.rejects(() => client.simulateContract({ ...adapter, account, functionName: 'withdrawV3', args: [2n, 1000n, 0n, 0n, reject.address, fee, deadline], value: fee }));
    assert.equal(await read(positions, 'liquidity', [2n]), 1000n);
    await write(adapter, 'withdrawV3', [2n, 1000n, 0n, 0n, collector, fee, deadline], fee); assert.equal(await read(positions, 'liquidity', [2n]), 0n);
  });
});
