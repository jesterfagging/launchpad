// Hex, byte and unit helpers shared by the EVM modules. Quantities are BigInt; hex strings are 0x-prefixed.

export const isHex = value => typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value);
export function hexToBytes(hex) {
  if (!isHex(hex)) throw Error('Expected 0x hex.');
  const body = hex.length % 2 ? '0' + hex.slice(2) : hex.slice(2);
  return Buffer.from(body, 'hex');
}
export const bytesToHex = bytes => '0x' + Buffer.from(bytes).toString('hex');
export function hexToBigInt(hex) {
  if (!isHex(hex)) throw Error('Expected 0x hex.');
  return hex.length > 2 ? BigInt(hex) : 0n;
}
/** A quantity as minimal 0x hex (no leading zeros, 0x0 for zero), the JSON-RPC form. */
export function toQuantity(value) {
  const n = BigInt(value);
  if (n < 0n) throw Error('Quantities are not negative.');
  return '0x' + n.toString(16);
}
/** A quantity as a fixed-width 32-byte hex word. */
export const toWord = value => '0x' + BigInt(value).toString(16).padStart(64, '0');
/** The big-endian bytes of a non-negative BigInt, empty for zero (RLP's integer form). */
export function bigIntToBytes(value) {
  const n = BigInt(value);
  if (n < 0n) throw Error('Negative integers have no byte form here.');
  if (n === 0n) return Buffer.alloc(0);
  const hex = n.toString(16);
  return Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex');
}
export const bytesToBigInt = bytes => bytes.length ? BigInt('0x' + Buffer.from(bytes).toString('hex')) : 0n;

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
/** A decimal text amount to integer units with `decimals` places (rejects more fraction digits than the unit has). */
export function parseUnits(text, decimals) {
  const value = String(text ?? '').trim();
  if (!DECIMAL.test(value)) throw Error('Enter a plain decimal amount.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw Error(`At most ${decimals} decimal places.`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
}
/** Integer units to decimal text, trimmed of trailing zeros (up to `places` fraction digits when given). */
export function formatUnits(value, decimals, places = decimals) {
  let n = BigInt(value); const negative = n < 0n; if (negative) n = -n;
  const base = 10n ** BigInt(decimals);
  const whole = n / base, fraction = (n % base).toString().padStart(decimals, '0').slice(0, places).replace(/0+$/, '');
  return (negative ? '-' : '') + whole.toString() + (fraction ? '.' + fraction : '');
}
export const parseEther = text => parseUnits(text, 18);
export const formatEther = (value, places = 18) => formatUnits(value, 18, places);
