// The dependency-free EVM primitives behind the Robinhood launch venue, against published vectors and an
// independent implementation: keccak-256 (Keccak test vectors), secp256k1 (the key-1 address, the RFC 6979
// "Satoshi Nakamoto" nonce vector, and OpenSSL's secp256k1 through node:crypto), RLP (the Ethereum wiki vectors),
// EIP-1559 serialization (raw transactions produced by Foundry's cast), the ABI codec (the Solidity ABI spec
// examples) and the unit helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import { keccak256, keccakHex } from '../src/evm/keccak.mjs';
import { privateKeyToAddress, publicKey, sign, recover, recoverAddress, verify, checksumAddress, isAddress, randomPrivateKey, N } from '../src/evm/secp256k1.mjs';
import { rlpEncode, rlpDecode } from '../src/evm/rlp.mjs';
import { signTransaction, parseTransaction, personalMessageHash } from '../src/evm/tx.mjs';
import { encodeCall, encodeParams, decodeParams, decodeResult, decodeLog, decodeRevert, topicOf, selectorOf, canonicalType } from '../src/evm/abi.mjs';
import { parseUnits, formatUnits, parseEther, formatEther, toQuantity, hexToBigInt } from '../src/evm/hex.mjs';

const KEY1 = '0x' + '1'.padStart(64, '0');

test('keccak-256 matches the Keccak vectors, across block boundaries', () => {
  assert.equal(keccakHex(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccakHex('abc'), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(keccakHex('transfer(address,uint256)').slice(0, 10), '0xa9059cbb');
  // 300 bytes spans three 136-byte blocks (cast keccak of the same input).
  assert.equal(keccakHex('a'.repeat(300)), '0x5b7e0e47a96f32a88b4f14ca177982790807c40e1a105742ba0fc1babe1ef826');
  assert.equal(keccakHex(Buffer.alloc(136)), keccakHex(new Uint8Array(136)), 'buffers and typed arrays alike');
  assert.equal(keccak256('x').length, 32);
});

test('secp256k1 addresses and the RFC 6979 vector', () => {
  assert.equal(privateKeyToAddress(KEY1), '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
  assert.equal(privateKeyToAddress('0x' + '2'.padStart(64, '0')), '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF');
  assert.equal(publicKey(KEY1).toString('hex'), '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8');
  const hash = createHash('sha256').update('Satoshi Nakamoto').digest();
  const signature = sign(hash, KEY1);
  assert.equal(signature.r.toString(16), '934b1ea10a4b3c1757e2b0c017d0b6143ce3c9a7e6a4a49860d7a6ab210ee3d8');
  assert.equal(signature.s.toString(16), '2442ce9d2b916064108014783e923ec36b49743e2ffa1c4496f01a512aafd9e5');
  assert.ok(signature.s <= N >> 1n, 'low s');
  assert.equal(recoverAddress(hash, signature), privateKeyToAddress(KEY1));
  assert.ok(verify(hash, signature, publicKey(KEY1)));
  assert.ok(!verify(hash, { r: signature.r, s: signature.s + 1n }, publicKey(KEY1)));
  assert.throws(() => sign(Buffer.alloc(31), KEY1), /32-byte/);
  assert.throws(() => privateKeyToAddress('0x' + '0'.repeat(64)), /curve order/);
});

test('secp256k1 agrees with OpenSSL: derived public keys, our signatures verified there, theirs recovered here', () => {
  const der = (r, s) => {
    const enc = v => { let b = Buffer.from(v.toString(16).padStart(64, '0'), 'hex'); while (b.length > 1 && b[0] === 0) b = b.subarray(1); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return Buffer.concat([Buffer.from([0x02, b.length]), b]); };
    const body = Buffer.concat([enc(r), enc(s)]); return Buffer.concat([Buffer.from([0x30, body.length]), body]);
  };
  for (let i = 0; i < 6; i++) {
    const { privateKey, publicKey: pub } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    const jwk = privateKey.export({ format: 'jwk' });
    const key = '0x' + Buffer.from(jwk.d, 'base64url').toString('hex');
    const theirs = Buffer.concat([Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
    assert.ok(publicKey(key).equals(theirs), 'public key');
    const message = Buffer.from('message ' + i), hash = createHash('sha256').update(message).digest();
    const ours = sign(hash, key);
    assert.ok(nodeVerify('sha256', message, { key: pub, dsaEncoding: 'der' }, der(ours.r, ours.s)), 'OpenSSL accepts our signature');
    const raw = nodeSign('sha256', message, { key: privateKey, dsaEncoding: 'ieee-p1363' });
    const r = BigInt('0x' + raw.subarray(0, 32).toString('hex')), s = BigInt('0x' + raw.subarray(32).toString('hex'));
    assert.ok(verify(hash, { r, s }, theirs), 'we accept OpenSSL signatures');
    const recovered = [0, 1].map(recovery => { try { return recover(hash, { r, s, recovery }); } catch { return null; } });
    assert.ok(recovered.some(p => p && p.equals(theirs)), 'one recovery id yields the key');
  }
});

test('EIP-55 checksums and address validation', () => {
  assert.equal(checksumAddress('0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'), '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
  assert.equal(checksumAddress('0x8366a39cc670b4001a1121b8f6a443a643e40951'), '0x8366a39CC670B4001A1121B8F6A443A643e40951');
  assert.ok(isAddress('0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf'));
  assert.ok(isAddress('0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'), 'all lower case passes');
  assert.ok(!isAddress('0x7E5F4552091A69125d5DfCb7b8C2659029395BdF'), 'a wrong mixed case fails');
  assert.ok(!isAddress('0x7E5F') && !isAddress('7E5F4552091A69125d5DfCb7b8C2659029395Bdf'));
  const key = randomPrivateKey();
  assert.match(key, /^0x[0-9a-f]{64}$/);
  assert.ok(isAddress(privateKeyToAddress(key)));
});

test('RLP encodes and decodes the reference vectors', () => {
  const hex = b => Buffer.from(b).toString('hex');
  assert.equal(hex(rlpEncode('dog')), '83646f67');
  assert.equal(hex(rlpEncode(['cat', 'dog'])), 'c88363617483646f67');
  assert.equal(hex(rlpEncode('')), '80');
  assert.equal(hex(rlpEncode(0n)), '80');
  assert.equal(hex(rlpEncode(15n)), '0f');
  assert.equal(hex(rlpEncode(1024n)), '820400');
  assert.equal(hex(rlpEncode([])), 'c0');
  assert.equal(hex(rlpEncode([[], [[]], [[], [[]]]])), 'c7c0c1c0c3c0c1c0');
  assert.equal(hex(rlpEncode('Lorem ipsum dolor sit amet, consectetur adipisicing elit')), 'b8384c6f72656d20697073756d20646f6c6f722073697420616d65742c20636f6e7365637465747572206164697069736963696e6720656c6974');
  const decoded = rlpDecode(rlpEncode(['cat', ['dog', 0x0400n], '0x']));
  assert.equal(decoded[0].toString(), 'cat');
  assert.equal(decoded[1][0].toString(), 'dog');
  assert.equal(decoded[1][1].toString('hex'), '0400');
  assert.equal(decoded[2].length, 0);
  assert.throws(() => rlpDecode(Buffer.from('c88363617483646f6700', 'hex')), /trailing/);
});

test('EIP-1559 transactions serialize exactly as cast does and parse back', () => {
  const key = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
  const transfer = signTransaction({ chainId: 4663, nonce: 5, maxPriorityFeePerGas: 1000000, maxFeePerGas: 100000000, gas: 21000, to: '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF', value: 1000 }, key);
  assert.equal(transfer.raw, '0x02f86d82123705830f42408405f5e100825208942b5ad5c4795c026514f8317c7a215e218dccd6cf8203e880c080a0c1a849d12bcbbc805d059d954619b67ccc77b43c61ed8e55effdcdaa358ba63ea05de35735bcee85b9c2029d80bbfbc680a391f1b6dd295aa7355d323ccfef3c2a');
  const data = '0xa9059cbb000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ff';
  const call = signTransaction({ chainId: 4663, nonce: 5, maxPriorityFeePerGas: 1000000, maxFeePerGas: 100000000, gas: 60000, to: '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF', value: 0, data }, key);
  assert.equal(call.raw, '0x02f8b082123705830f42408405f5e10082ea60942b5ad5c4795c026514f8317c7a215e218dccd6cf80b844a9059cbb000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ffc001a056dc4906dc2e9270830794fa7caa4d912d826fe15dfb2ac47e47aadbd2446e91a075862c0deda27e3afb36c13d04aa2a3d5d183bdc818606e35db2daec6743af65');
  assert.equal(call.hash, keccakHex(Buffer.from(call.raw.slice(2), 'hex')));
  const parsed = parseTransaction(call.raw);
  assert.equal(parsed.from, '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23');
  assert.equal(parsed.nonce, 5n); assert.equal(parsed.gas, 60000n); assert.equal(parsed.chainId, 4663n); assert.equal(parsed.data, data); assert.equal(parsed.hash, call.hash);
  assert.throws(() => signTransaction({ chainId: 1, nonce: 0, maxPriorityFeePerGas: 1, maxFeePerGas: 1, gas: 21000, to: '0x1234', value: 0 }, key), /not an address/);
  assert.throws(() => signTransaction({ chainId: 1, nonce: -1, maxPriorityFeePerGas: 1, maxFeePerGas: 1, gas: 21000, to: null, value: 0 }, key), /negative/);
  // A contract creation has no "to".
  const create = parseTransaction(signTransaction({ chainId: 1, nonce: 0, maxPriorityFeePerGas: 1, maxFeePerGas: 2, gas: 100000, to: null, value: 0, data: '0x6001' }, key).raw);
  assert.equal(create.to, null);
  assert.equal(personalMessageHash('hello').toString('hex'), '50b2c43fd39106bafbba0da34fc430e1f91e3c96ea2acee2bc34119f92b37750');
});

test('ABI encoding matches the Solidity ABI specification examples', () => {
  const sam = { type: 'function', name: 'sam', inputs: [{ name: 'a', type: 'bytes' }, { name: 'b', type: 'bool' }, { name: 'c', type: 'uint256[]' }] };
  assert.equal(encodeCall(sam, ['0x64617665', true, [1n, 2n, 3n]]), '0xa5643bf2'
    + '0000000000000000000000000000000000000000000000000000000000000060'
    + '0000000000000000000000000000000000000000000000000000000000000001'
    + '00000000000000000000000000000000000000000000000000000000000000a0'
    + '0000000000000000000000000000000000000000000000000000000000000004'
    + '6461766500000000000000000000000000000000000000000000000000000000'
    + '0000000000000000000000000000000000000000000000000000000000000003'
    + '0000000000000000000000000000000000000000000000000000000000000001'
    + '0000000000000000000000000000000000000000000000000000000000000002'
    + '0000000000000000000000000000000000000000000000000000000000000003');
  const f = { type: 'function', name: 'f', inputs: [{ type: 'uint256' }, { type: 'uint32[]' }, { type: 'bytes10' }, { type: 'bytes' }] };
  assert.equal(encodeCall(f, [0x123n, [0x456n, 0x789n], '0x31323334353637383930', '0x48656c6c6f2c20776f726c6421']), '0x8be65246'
    + '0000000000000000000000000000000000000000000000000000000000000123'
    + '0000000000000000000000000000000000000000000000000000000000000080'
    + '3132333435363738393000000000000000000000000000000000000000000000'
    + '00000000000000000000000000000000000000000000000000000000000000e0'
    + '0000000000000000000000000000000000000000000000000000000000000002'
    + '0000000000000000000000000000000000000000000000000000000000000456'
    + '0000000000000000000000000000000000000000000000000000000000000789'
    + '000000000000000000000000000000000000000000000000000000000000000d'
    + '48656c6c6f2c20776f726c642100000000000000000000000000000000000000');
  assert.ok(encodeParams([{ type: 'int256' }], [-1n]).equals(encodeParams([{ type: 'int256' }], ['-1'])), 'decimal strings are integers too');
  assert.equal(Buffer.from(encodeParams([{ type: 'int256' }], [-1n])).toString('hex'), 'f'.repeat(64));
  assert.equal(canonicalType({ type: 'tuple[]', components: [{ type: 'uint8' }, { type: 'uint256[6]' }] }), '(uint8,uint256[6])[]');
  assert.equal(Buffer.from(selectorOf({ name: 'transfer', inputs: [{ type: 'address' }, { type: 'uint256' }] })).toString('hex'), 'a9059cbb');
  assert.throws(() => encodeParams([{ type: 'uint8' }], [256n]), /out of range/);
  assert.throws(() => encodeParams([{ type: 'address' }], ['0x12']), /address/);
  assert.throws(() => encodeParams([{ type: 'bytes32' }], ['0x1234']), /32 bytes/);
});

test('ABI round-trips nested structs with dynamic arrays, and decodes results, logs and reverts', () => {
  const launch = { type: 'function', name: 'launch', inputs: [{ name: 'p', type: 'tuple', components: [
    { name: 'name', type: 'string' }, { name: 'creator', type: 'address' },
    { name: 'rules', type: 'tuple[]', components: [{ name: 'kind', type: 'uint8' }, { name: 'p', type: 'uint256[6]' }] },
    { name: 'allow', type: 'address[]' }, { name: 'salt', type: 'bytes32' }, { name: 'taxBps', type: 'uint16' }, { name: 'tick', type: 'int24' }] }] };
  const args = [{ name: 'Launchpad Coin', creator: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf', rules: [{ kind: 7, p: [100n, 0n, 0n, 0n, 0n, 0n] }, { kind: 25, p: [1n, 2n, 3n, 4n, 5n, 6n] }], allow: ['0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF'], salt: '0x' + 'ab'.repeat(32), taxBps: 500, tick: -887200n }];
  const data = encodeCall(launch, args);
  // The same call built from positional tuples encodes identically.
  assert.equal(encodeCall(launch, [['Launchpad Coin', args[0].creator, [[7, args[0].rules[0].p], [25, args[0].rules[1].p]], args[0].allow, args[0].salt, 500, -887200n]]), data);
  const [p] = decodeParams(launch.inputs, '0x' + data.slice(10));
  assert.equal(p.name, 'Launchpad Coin'); assert.equal(p.creator, args[0].creator); assert.equal(p.rules.length, 2);
  assert.equal(p.rules[1].kind, 25n); assert.deepEqual(p.rules[1].p, [1n, 2n, 3n, 4n, 5n, 6n]);
  assert.deepEqual(p.allow, args[0].allow); assert.equal(p.salt, args[0].salt); assert.equal(p.taxBps, 500n); assert.equal(p.tick, -887200n);
  assert.throws(() => encodeCall(launch, [{ ...args[0], rules: undefined }]), /rules: expected an array/);
  const { rules: _omitted, ...withoutRules } = args[0];
  assert.throws(() => encodeCall(launch, [withoutRules]), /Missing tuple field rules/);
  const state = { type: 'function', name: 'state', outputs: [{ name: 'raised', type: 'uint256' }, { name: 'done', type: 'bool' }, { name: 'id', type: 'bytes32' }, { name: 'liq', type: 'uint128' }] };
  const encoded = '0x' + (85n * 10n ** 18n).toString(16).padStart(64, '0') + '1'.padStart(64, '0') + '11'.repeat(32) + (12345n).toString(16).padStart(64, '0');
  const result = decodeResult(state, encoded);
  assert.equal(result.raised, 85n * 10n ** 18n); assert.equal(result.done, true); assert.equal(result.id, '0x' + '11'.repeat(32)); assert.equal(result.liq, 12345n);
  assert.equal(decodeResult({ outputs: [{ name: 'x', type: 'uint256' }] }, '0x' + '5'.padStart(64, '0')), 5n, 'a single output stands alone');
  const transfer = { type: 'event', name: 'Transfer', inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'value', type: 'uint256' }] };
  assert.equal(topicOf(transfer), '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
  const log = decodeLog(transfer, { topics: [topicOf(transfer), '0x' + '0'.repeat(24) + '7e5f4552091a69125d5dfcb7b8c2659029395bdf', '0x' + '0'.repeat(24) + '2b5ad5c4795c026514f8317c7a215e218dccd6cf'], data: '0x' + (5n).toString(16).padStart(64, '0') });
  assert.deepEqual(log, { name: 'Transfer', args: { from: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf', to: '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF', value: 5n } });
  assert.equal(decodeLog(transfer, { topics: ['0x' + '00'.repeat(32)], data: '0x' }), null, 'another event is not this one');
  const refused = { type: 'error', name: 'RuleRefused', inputs: [{ name: 'kind', type: 'uint8' }] };
  assert.deepEqual(decodeRevert('0xeb0613880000000000000000000000000000000000000000000000000000000000000007', [refused]), { name: 'RuleRefused', args: { kind: 7n } });
  assert.deepEqual(decodeRevert('0x08c379a0' + encodeParams([{ type: 'string' }], ['nope']).toString('hex')).args, { message: 'nope' });
  assert.equal(decodeRevert('0x12345678deadbeef', []).name, 'unknown');
  assert.equal(decodeRevert('0x', []), null);
});

test('units and quantities', () => {
  assert.equal(parseEther('1.5'), 1500000000000000000n);
  assert.equal(parseUnits('19371.29', 6), 19371290000n);
  assert.throws(() => parseUnits('1.1234567', 6), /decimal places/);
  assert.throws(() => parseUnits('1e5', 18), /plain decimal/);
  assert.equal(formatEther(1500000000000000000n), '1.5');
  assert.equal(formatEther(85858585858585858586n, 4), '85.8585');
  assert.equal(formatUnits(19371290000n, 6), '19371.29');
  assert.equal(formatUnits(-5n, 1), '-0.5');
  assert.equal(toQuantity(0), '0x0'); assert.equal(toQuantity(255n), '0xff');
  assert.equal(hexToBigInt('0x'), 0n); assert.equal(hexToBigInt('0x10'), 16n);
  assert.throws(() => toQuantity(-1), /negative/);
});
