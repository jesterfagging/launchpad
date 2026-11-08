import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ACCOUNT_SIZE, ExtensionType, getTypeLen, getAccountLen } from '@solana/spl-token';

// Token-2022's required_init_account_extensions, plus the ATA program's
// ImmutableOwner requirement. Confidential balances are opt-in and are not
// allocated by ordinary ATA creation. This is sizing, never mint approval.
// https://github.com/solana-program/token-2022/blob/main/interface/src/extension/mod.rs
// https://github.com/solana-program/associated-token-account/blob/main/program/src/processor.rs
const CONFIDENTIAL_TRANSFER_FEE_CONFIG = 16;
const mintTypes = new Set([1,3,4,6,9,10,12,14,16,18,19,20,21,22,23,25,26]);
const required = new Map([
  [ExtensionType.TransferFeeConfig, [ExtensionType.TransferFeeAmount]],
  [ExtensionType.NonTransferable, [ExtensionType.NonTransferableAccount, ExtensionType.ImmutableOwner]],
  [ExtensionType.TransferHook, [ExtensionType.TransferHookAccount]],
  [ExtensionType.PausableConfig, [ExtensionType.PausableAccount]],
]);
const check = (value,message) => { if (!value) throw Error(message); };

export function associatedTokenAccountSize(info) {
  const tlv = info?.mint?.tlvData;
  check(Buffer.isBuffer(tlv), 'The mint extension data is unavailable for account sizing.');
  if (info?.program?.equals(TOKEN_PROGRAM_ID)) {
    check(tlv.length === 0, 'A legacy token mint cannot contain token extensions.');
    return ACCOUNT_SIZE;
  }
  check(info?.program?.equals(TOKEN_2022_PROGRAM_ID), 'The mint token program is unsupported for account sizing.');
  const extensions = new Map();
  for (let offset=0; offset<tlv.length;) {
    // Token-2022 may leave zero padding after its last initialized extension.
    if (tlv.subarray(offset).every(byte=>byte===0)) break;
    check(offset+4<=tlv.length, 'The mint extension data is truncated.');
    const type=tlv.readUInt16LE(offset),length=tlv.readUInt16LE(offset+2),end=offset+4+length;
    check(mintTypes.has(type), `Unsupported mint extension for account sizing: ${type}.`);
    check(!extensions.has(type)&&end<=tlv.length, 'The mint extension data is duplicated or truncated.');
    const expected=type===CONFIDENTIAL_TRANSFER_FEE_CONFIG?129:type===ExtensionType.TokenMetadata?null:getTypeLen(type);
    check(expected===null?length>=80:length===expected, 'The mint extension has an invalid size.');
    extensions.set(type,tlv.subarray(offset+4,end));offset=end;
  }
  const confidential=extensions.get(CONFIDENTIAL_TRANSFER_FEE_CONFIG);
  check(!confidential||(confidential[64]<=1&&extensions.has(ExtensionType.TransferFeeConfig)&&extensions.has(ExtensionType.ConfidentialTransferMint)), 'The mint has an invalid confidential transfer fee configuration.');
  const accountTypes = new Set([ExtensionType.ImmutableOwner]);
  for (const type of extensions.keys()) for (const accountType of required.get(type)||[]) accountTypes.add(accountType);
  // The SDK's getAccountLen handles TLV headers and the 355-byte multisig
  // ambiguity rule; it receives only explicit, supported account extensions.
  return getAccountLen([...accountTypes]);
}
