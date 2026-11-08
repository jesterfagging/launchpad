// Pump.fun Classic: dependency-free codec, IDL and instruction builders.
// Address vectors are real mainnet accounts published in Pump's documentation,
// so a passing PDA/ATA test proves the derivation matches the runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pda, key, findProgramAddress, associatedTokenAddress, base58Encode, base58Decode, isOnCurve, BorshReader, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, NATIVE_MINT, ASSOCIATED_TOKEN_PROGRAM, SYSTEM_PROGRAM } from '../src/pump-classic/codec.mjs';
import { IDL_SOURCE, PROGRAMS, instructionSpec, encodeInstructionData, decodeInstructionArgs, decodeAccount, decodeEvent, EVENT_IX_TAG, accountDiscriminator } from '../src/pump-classic/idl.mjs';
import * as ix from '../src/pump-classic/instructions.mjs';

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', FEES = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
const wallet = n => base58Encode(createHash('sha256').update('pump-classic-test-wallet:' + n).digest());
const MINT = wallet('mint'), LAUNCH = wallet('launch'), DEV = wallet('dev'), PROTOCOL = wallet('protocol'), MODE = wallet('mode'), FEE_RECIPIENT = wallet('fee'), BUYBACK = wallet('buyback');

test('PDA and ATA derivation reproduce published mainnet addresses', () => {
  assert.equal(pda(['global'], PUMP), '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
  assert.equal(pda(['global_config'], AMM), 'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
  assert.equal(findProgramAddress(['bonding-curve', key('Coyj3LtKn1BNSgWc9HsGK5SKoGfEoDaymig4wrN6pump')], PUMP).bump, 255);
  assert.equal(findProgramAddress(['bonding-curve', key('3cLSxG6eXcCD9NSMawkhUcrvVCUC8KHKHMCxx6bhpump')], PUMP).bump, 251);
  const base = '7LSsEoJGhLeZzGvDofTdNg7M3JttxQqGWNLo6vWMpump', authority = pda(['pool-authority', key(base)], PUMP);
  assert.equal(authority, '9XDYTfQKwW8sHPqnFdUreMmtmffmkHVPGTNV2e3LKxNW');
  const pool = pda(['pool', Buffer.alloc(2), key(authority), key(base), key(NATIVE_MINT)], AMM);
  assert.equal(pool, 'GseMAnNDvntR5uFePZ51yZBXzNSn7GdFPkfHwfr6d77J');
  assert.equal(pda(['pool_lp_mint', key(pool)], AMM), '6dpnPD6UWDw5hbJEuPQwnCCMba1JYwHANKuL6GQ6otAH');
  assert.equal(associatedTokenAddress(pool, base, TOKEN_PROGRAM), '5jMpkf4JF4noHftLgNKyPNh6roVfPSGSjuEk3U4eLKRa');
  assert.equal(associatedTokenAddress(pool, NATIVE_MINT, TOKEN_PROGRAM), '43DVcZR4kQFjh4Xm2i3DcneRxNjZp7HMud8yDrJWrDr8');
  assert.equal(isOnCurve(base58Decode('BvGRhAWRik2bMPx3DxgsFM9L86HpQtBkgK3irkgZW7Yh')), true, 'an ordinary wallet is on the curve');
  assert.equal(isOnCurve(base58Decode(authority)), false, 'a PDA is off the curve');
  assert.equal(base58Encode(base58Decode('11111111111111111111111111111111')), '11111111111111111111111111111111');
});

test('the vendored IDL is the documented program set with recorded provenance', () => {
  assert.deepEqual(PROGRAMS, { pump: PUMP, pump_amm: AMM, pump_fees: FEES });
  assert.match(IDL_SOURCE.commit, /^[0-9a-f]{40}$/);
  for (const file of ['idl/pump.json', 'idl/pump_amm.json', 'idl/pump_fees.json']) assert.match(IDL_SOURCE.files[file].sha256, /^[0-9a-f]{64}$/);
  // Program IDs embedded as raw bytes in the IDL seeds resolve to the expected programs.
  const raw = JSON.parse(readFileSync(new URL('../vendor/pump-idl/pump-classic-idl.json', import.meta.url), 'utf8'));
  const programBytes = new Set();
  for (const p of Object.values(raw.programs)) for (const i of p.instructions) for (const a of i.accounts) if (a.pda?.program?.kind === 'const') programBytes.add(base58Encode(Buffer.from(a.pda.program.value)));
  for (const id of programBytes) assert.ok([PUMP, AMM, FEES, ix.MAYHEM_PROGRAM, ASSOCIATED_TOKEN_PROGRAM].includes(id), `unexpected seed program ${id}`);
  assert.equal(EVENT_IX_TAG.toString('hex'), 'e445a52e51cb9a1d');
});

test('create_v2 matches the IDL layout and omits the optional coin-mode arguments', () => {
  const create = ix.createV2({ mint: MINT, user: LAUNCH, creator: LAUNCH, name: 'Scout Signal', symbol: 'SCOUT', uri: 'https://arweave.net/abc' });
  assert.equal(create.programId, PUMP);
  assert.equal(create.keys.length, instructionSpec('pump', 'create_v2').accounts.length);
  assert.deepEqual(create.keys.filter(k => k.isSigner).map(k => k.pubkey), [MINT, LAUNCH]);
  const a = ix.coinAddresses(MINT);
  assert.equal(create.keys[2].pubkey, a.bondingCurve);
  assert.equal(create.keys[3].pubkey, associatedTokenAddress(a.bondingCurve, MINT, TOKEN_2022_PROGRAM));
  assert.equal(create.keys[7].pubkey, TOKEN_2022_PROGRAM);
  assert.equal(create.keys[15].pubkey, PUMP);
  const args = decodeInstructionArgs('pump', 'create_v2', create.data);
  assert.deepEqual(args, { name: 'Scout Signal', symbol: 'SCOUT', uri: 'https://arweave.net/abc', creator: LAUNCH, is_mayhem_mode: false });
  assert.equal(create.data.length, 8 + 4 + 12 + 4 + 5 + 4 + 23 + 32 + 1, 'no trailing cashback / creator-fee / holder-reward bytes');
  assert.throws(() => ix.createV2({ mint: MINT, user: LAUNCH, creator: LAUNCH, name: 'x'.repeat(33), symbol: 'S', uri: 'https://a.b' }), /1-32/);
  assert.throws(() => ix.createV2({ mint: MINT, user: LAUNCH, creator: LAUNCH, name: 'N', symbol: 'S', uri: 'http://insecure' }), /https/);
});

test('fee sharing: config creation and one-time share update', () => {
  const create = ix.createFeeSharingConfig({ payer: LAUNCH, mint: MINT });
  assert.equal(create.programId, FEES);
  assert.equal(create.keys.length, 13);
  assert.deepEqual(create.keys.slice(10).map(k => [k.pubkey, k.isWritable]), [[FEES, false], [FEES, false], [FEES, false]], 'graduation-only accounts read as None');
  const update = ix.updateFeeSharesV2({ authority: LAUNCH, mint: MINT, currentShareholders: [LAUNCH], newShareholders: [{ address: PROTOCOL, shareBps: 1000 }, { address: DEV, shareBps: 9000 }] });
  assert.equal(update.keys.length, 19 + 1);
  assert.deepEqual(update.keys.at(-1), { pubkey: LAUNCH, isSigner: false, isWritable: true });
  const a = ix.coinAddresses(MINT);
  assert.equal(update.keys[5].pubkey, a.sharingConfig);
  assert.equal(update.keys[7].pubkey, pda(['creator-vault', key(a.sharingConfig)], PUMP));
  assert.equal(update.keys[17].pubkey, pda(['creator_vault', key(a.sharingConfig)], AMM));
  const decoded = decodeInstructionArgs('pump_fees', 'update_fee_shares_v2', update.data);
  assert.deepEqual(decoded.shareholders, [{ address: PROTOCOL, share_bps: 1000 }, { address: DEV, share_bps: 9000 }]);
  assert.throws(() => ix.validShareholders([{ address: PROTOCOL, shareBps: 5000 }, { address: DEV, shareBps: 4999 }]), /10,000/);
  assert.throws(() => ix.validShareholders([{ address: DEV, shareBps: 5000 }, { address: DEV, shareBps: 5000 }]), /distinct/);
});

test('buy_v2 / buy_exact_quote_in_v2 / sell_v2 accounts follow the IDL with the sharing-config creator vault', () => {
  const a = ix.coinAddresses(MINT);
  const common = { mint: MINT, user: wallet('trader'), creator: a.sharingConfig, feeRecipient: FEE_RECIPIENT, buybackFeeRecipient: BUYBACK };
  const buy = ix.buyV2({ ...common, amount: 1000000n, maxQuoteIn: 2000000n });
  assert.equal(buy.keys.length, 27);
  assert.equal(buy.keys[16].pubkey, a.sharedCreatorVault, 'creator vault is derived from the sharing config');
  assert.equal(buy.keys[18].pubkey, a.sharingConfig);
  assert.equal(buy.keys[22].pubkey, pda(['fee_config', key(PUMP)], FEES));
  assert.deepEqual(decodeInstructionArgs('pump', 'buy_v2', buy.data), { amount: 1000000n, max_sol_cost: 2000000n });
  const exact = ix.buyExactQuoteInV2({ ...common, quoteIn: 5000n, minTokensOut: 7n });
  assert.deepEqual(decodeInstructionArgs('pump', 'buy_exact_quote_in_v2', exact.data), { spendable_quote_in: 5000n, min_tokens_out: 7n });
  const sell = ix.sellV2({ ...common, amount: 10n, minQuoteOut: 1n });
  assert.equal(sell.keys.length, 26);
  assert.equal(sell.keys.filter(k => k.isSigner).length, 1);
  assert.throws(() => ix.buyV2({ ...common, amount: -1n, maxQuoteIn: 1n }), /amount/);
});

test('distribution and AMM sweep pass the configured shareholders as writable remaining accounts', () => {
  const a = ix.coinAddresses(MINT);
  const distribute = ix.distributeCreatorFeesV2({ payer: PROTOCOL, mint: MINT, shareholders: [PROTOCOL, MODE] });
  assert.equal(distribute.keys.length, 12 + 2);
  assert.equal(distribute.keys[4].pubkey, a.sharedCreatorVault);
  assert.deepEqual(distribute.keys.slice(-2).map(k => [k.pubkey, k.isWritable, k.isSigner]), [[PROTOCOL, true, false], [MODE, true, false]]);
  assert.deepEqual(decodeInstructionArgs('pump', 'distribute_creator_fees_v2', distribute.data), { initialize_ata: false });
  const sweep = ix.transferCreatorFeesToPumpV2({ payer: PROTOCOL, mint: MINT });
  assert.equal(sweep.programId, AMM);
  assert.equal(sweep.keys.length, 12);
  assert.equal(sweep.keys[5].pubkey, a.sharingConfig);
  assert.equal(sweep.keys[8].pubkey, a.sharedCreatorVault);
});

test('SPL helpers encode the documented layouts', () => {
  const t = ix.transferChecked({ owner: LAUNCH, recipient: DEV, mint: MINT, amount: 123n, decimals: 6 });
  assert.equal(t.programId, TOKEN_2022_PROGRAM);
  assert.equal(t.data.toString('hex'), '0c' + '7b00000000000000' + '06');
  assert.equal(t.keys[0].pubkey, associatedTokenAddress(LAUNCH, MINT, TOKEN_2022_PROGRAM));
  assert.equal(t.keys[2].pubkey, associatedTokenAddress(DEV, MINT, TOKEN_2022_PROGRAM));
  const s = ix.systemTransfer({ from: LAUNCH, to: DEV, lamports: 5n });
  assert.equal(s.programId, SYSTEM_PROGRAM);
  assert.equal(s.data.toString('hex'), '02000000' + '0500000000000000');
  assert.equal(ix.createAtaIdempotent({ payer: LAUNCH, owner: DEV, mint: MINT }).data[0], 1);
  assert.equal(ix.closeTokenAccount({ owner: LAUNCH, mint: MINT }).data[0], 9);
  assert.equal(ix.computeUnitLimit(400000).data.toString('hex'), '02801a0600');
});

test('account decoders tolerate shorter (older) layouts and events decode from event-CPI data', () => {
  const disc = accountDiscriminator('pump', 'BondingCurve');
  const data = Buffer.concat([disc, Buffer.alloc(8 * 5), Buffer.from([0]), key(LAUNCH)]);
  const curve = decodeAccount('pump', 'BondingCurve', data);
  assert.equal(curve.creator, LAUNCH);
  assert.equal(curve.is_holder_reward, false);
  assert.equal(curve.quote_mint, SYSTEM_PROGRAM);
  assert.throws(() => decodeAccount('pump', 'Global', data), /not a pump Global/);
  const payload = Buffer.concat([EVENT_IX_TAG, Buffer.from(JSON.parse(readFileSync(new URL('../vendor/pump-idl/pump-classic-idl.json', import.meta.url), 'utf8')).programs.pump.events.find(e => e.name === 'DistributeCreatorFeesEvent').discriminator),
    Buffer.alloc(8), key(MINT), key(wallet('bc')), key(wallet('sc')), key(LAUNCH), Buffer.from([2, 0, 0, 0]), key(PROTOCOL), Buffer.from([0xe8, 0x03]), key(DEV), Buffer.from([0x28, 0x23]), Buffer.from('a086010000000000', 'hex'), key(NATIVE_MINT)]);
  const event = decodeEvent('pump', payload);
  assert.equal(event.name, 'DistributeCreatorFeesEvent');
  assert.equal(event.fields.distributed, 100000n);
  assert.deepEqual(event.fields.shareholders, [{ address: PROTOCOL, share_bps: 1000 }, { address: DEV, share_bps: 9000 }]);
  assert.equal(decodeEvent('pump', Buffer.from('00', 'hex')), null);
  assert.equal(new BorshReader(Buffer.from([1])).bool(), true);
});
