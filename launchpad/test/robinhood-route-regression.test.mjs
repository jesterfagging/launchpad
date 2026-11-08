import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createPublicClient, createWalletClient, http, decodeAbiParameters, parseAbiParameters } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import solc from 'solc';
import { v4Swap, encode } from '../src/robinhood-pools.mjs';
import { ROBINHOOD_CHAIN, EVM_NATIVE, CONTRACTS } from '../src/robinhood-contracts.mjs';

// A local protocol harness: enforce PoolManager's zero-delta unlock invariant,
// the v4 router's action ABI, and its msgSender/address(this) recipient aliases.
// This is not a deployed-venue/fork test. Actual input/output are independent
// fixture values, including a partial fill that the old payload cannot settle.
const harness = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
contract V4Settlement {
 struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
 struct Swap { PoolKey poolKey; bool zeroForOne; uint128 amountIn; uint128 amountOutMinimum; uint256 minHopPriceX36; bytes hookData; }
 error CurrencyNotSettled();
 function exercise(bytes calldata payload,uint128 actualInput,uint128 actualOutput,address user,address router)
 external pure returns(address refundTo,uint256 refund,address outputTo,uint256 output,uint256 paid) {
   (bytes memory actions,bytes[] memory params)=abi.decode(payload,(bytes,bytes[]));
   address inputCurrency; address outputCurrency; int256 inputDelta; int256 outputDelta;
   for(uint i;i<actions.length;i++) {
     if(actions[i]==0x06) {
       Swap memory p=abi.decode(params[i],(Swap));
       require(actualInput<=p.amountIn,"input cap");
       require(actualOutput>=p.amountOutMinimum,"minimum output");
       inputCurrency=p.zeroForOne?p.poolKey.currency0:p.poolKey.currency1;
       outputCurrency=p.zeroForOne?p.poolKey.currency1:p.poolKey.currency0;
       inputDelta-=int256(uint256(actualInput)); outputDelta+=int256(uint256(actualOutput));
     } else if(actions[i]==0x0b) {
       (address currency,uint256 amount,)=abi.decode(params[i],(address,uint256,bool));
       require(currency==inputCurrency,"settle currency");
       // DeltaResolver's OPEN_DELTA means full debt when amount is zero.
       if(amount==0){require(inputDelta<=0);amount=uint256(-inputDelta);}
       inputDelta+=int256(amount); paid+=amount;
     } else if(actions[i]==0x0e) {
       (address currency,address recipient,uint256 amount)=abi.decode(params[i],(address,address,uint256));
       if(recipient==address(1))recipient=user;else if(recipient==address(2))recipient=router;
       int256 delta=currency==inputCurrency?inputDelta:outputDelta;
       require(delta>=0,"negative credit"); if(amount==0)amount=uint256(delta);
       if(currency==inputCurrency){inputDelta-=int256(amount);refundTo=recipient;refund+=amount;}
       else {require(currency==outputCurrency);outputDelta-=int256(amount);outputTo=recipient;output+=amount;}
     } else revert("unexpected action");
   }
   if(inputDelta!=0||outputDelta!=0)revert CurrencyNotSettled();
 }
}`;

test('v4 execution refunds unconsumed input without leaving deltas or exceeding its signed cap', { timeout: 30000 }, async t => {
  const listener = createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r)); const port = listener.address().port; await new Promise(r => listener.close(r));
  const node = spawn(new URL('../node_modules/.bin/anvil', import.meta.url).pathname, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '4663'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => node.kill('SIGTERM'));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Local EVM did not start.')), 12000);
    const ready = data => { if (String(data).includes('Listening on')) { clearTimeout(timer); resolve(); } };
    node.stdout.on('data', ready); node.stderr.on('data', ready); node.once('error', error => { clearTimeout(timer); reject(error); });
  });
  // Public Anvil fixture key used only on this loopback test node.
  const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  const transport = http(`http://127.0.0.1:${port}`), client = createPublicClient({ chain: ROBINHOOD_CHAIN, transport }), wallet = createWalletClient({ account, chain: ROBINHOOD_CHAIN, transport });
  const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'Harness.sol': { content: harness } }, settings: { viaIR: true, optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  assert(!compiled.errors?.some(e => e.severity === 'error'), compiled.errors?.map(e => e.formattedMessage).join('\n'));
  const artifact = compiled.contracts['Harness.sol'].V4Settlement;
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}` });
  const receipt = await client.waitForTransactionReceipt({ hash }); assert.equal(receipt.status, 'success');
  const run = (payload, spent = 95n, output = 190n) => client.readContract({ address: receipt.contractAddress, abi: artifact.abi, functionName: 'exercise', args: [payload, spent, output, account.address, CONTRACTS.router] });
  const token = '0x1111111111111111111111111111111111111111', stock = '0x2222222222222222222222222222222222222222';
  for (const input of [EVM_NATIVE, stock]) for (const payerIsUser of [true, false]) {
    const currencies = [token, input].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
    const pool = { currency0: currencies[0], currency1: currencies[1], fee: 3000, tickSpacing: 60, hooks: EVM_NATIVE };
    // Fee hops deliver output to the router even when input belongs to the user.
    const payload = v4Swap(pool, input, 100n, 180n, CONTRACTS.router, payerIsUser);
    const result = await run(payload);
    assert.deepEqual(result, [payerIsUser ? account.address : CONTRACTS.router, 5n, CONTRACTS.router, 190n, 100n]);
    assert.equal((await run(payload, 100n, 200n))[1], 0n);
    await assert.rejects(run(payload, 95n, 179n), /minimum output/);
    await assert.rejects(run(payload, 101n, 202n), /input cap/);
    const [actions, values] = decodeAbiParameters(parseAbiParameters('bytes,bytes[]'), payload);
    // Reproduce the old 3-action payload: unused input made unlock revert.
    await assert.rejects(run(encode('bytes,bytes[]', [actions.slice(0, -2), values.slice(0, -1)])), /CurrencyNotSettled|reverted/);
  }
});
