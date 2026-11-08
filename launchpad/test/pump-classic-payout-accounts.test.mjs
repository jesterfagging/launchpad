// Holder payouts in a pair asset (v71.24) skip token accounts that refuse a
// plain transfer. A Token-2022 account that requires a memo on incoming
// transfers (MemoTransfer, extension type 8, enabled) is one of them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenAccountRequiresMemo } from '../src/pump-classic/chain.mjs';

/** A 165-byte token account, its account-type byte and the given [type, bytes] extensions. */
const account = (extensions = null) => {
  if (!extensions) return Buffer.alloc(165);
  const parts = [Buffer.alloc(165), Buffer.from([2])];
  for (const [type, data] of extensions) { const header = Buffer.alloc(4); header.writeUInt16LE(type, 0); header.writeUInt16LE(data.length, 2); parts.push(header, Buffer.from(data)); }
  return Buffer.concat(parts);
};

test('a token account that requires incoming transfer memos is recognised; others are not', () => {
  assert.equal(tokenAccountRequiresMemo(account()), false, 'a classic SPL account');
  assert.equal(tokenAccountRequiresMemo(account([[7, []]])), false, 'immutable owner only');
  assert.equal(tokenAccountRequiresMemo(account([[7, []], [8, [1]]])), true, 'memos required');
  assert.equal(tokenAccountRequiresMemo(account([[7, []], [8, [0]]])), false, 'memo extension switched off');
  assert.equal(tokenAccountRequiresMemo(account([[2, new Array(8).fill(0)], [8, [1]]])), true, 'after another extension');
  assert.equal(tokenAccountRequiresMemo(account([[0, []], [8, [1]]])), false, 'the list ends at an empty entry');
  assert.equal(tokenAccountRequiresMemo(null), false);
});
