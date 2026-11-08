'use strict';

// Based on bigint-buffer's Apache-2.0 JavaScript implementation. See NOTICE.md.
// There is deliberately no optional native binding or installation script.
function checkedBuffer(value) {
  if (!Buffer.isBuffer(value)) throw new TypeError('Expected a Buffer.');
  return value;
}
function toBigIntBE(buffer) {
  const hex = checkedBuffer(buffer).toString('hex');
  return hex.length ? BigInt(`0x${hex}`) : 0n;
}
function toBigIntLE(buffer) {
  return toBigIntBE(Buffer.from(checkedBuffer(buffer)).reverse());
}
function toBufferBE(value, width) {
  if (typeof value !== 'bigint' || value < 0n) throw new RangeError('Expected an unsigned bigint.');
  if (!Number.isSafeInteger(width) || width < 0 || width > 1024) throw new RangeError('Unsupported integer byte width.');
  if (!width) {
    if (value !== 0n) throw new RangeError('Integer exceeds its byte width.');
    return Buffer.alloc(0);
  }
  const hex = value.toString(16);
  if (hex.length > width * 2) throw new RangeError('Integer exceeds its byte width.');
  return Buffer.from(hex.padStart(width * 2, '0'), 'hex');
}
function toBufferLE(value, width) { return toBufferBE(value, width).reverse(); }

exports.toBigIntLE = toBigIntLE;
exports.toBigIntBE = toBigIntBE;
exports.toBufferLE = toBufferLE;
exports.toBufferBE = toBufferBE;
