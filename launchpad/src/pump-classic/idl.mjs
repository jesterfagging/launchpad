// Pump.fun Classic: the vendored subset of Pump's official Anchor IDLs and a
// small IDL-driven Borsh codec for instruction data, accounts and events.
//
// vendor/pump-idl/pump-classic-idl.json is generated from
// https://github.com/pump-fun/pump-public-docs (commit and SHA-256 of each source
// IDL are recorded in its "source" block). Only the instructions, accounts and
// events this integration uses are kept. Account layouts grow by appending
// fields; shorter (older) accounts decode with the missing trailing fields set
// to their zero value, exactly as Pump's documentation specifies.
import { readFileSync } from 'node:fs';
import { BorshWriter, BorshReader } from './codec.mjs';

const fail = (message, code = 'PUMP_CLASSIC_IDL') => { throw Object.assign(Error(message), { code }); };
const IDL = JSON.parse(readFileSync(new URL('../../vendor/pump-idl/pump-classic-idl.json', import.meta.url), 'utf8'));
export const IDL_SOURCE = Object.freeze(IDL.source);
export const PROGRAMS = Object.freeze(Object.fromEntries(Object.entries(IDL.programs).map(([name, p]) => [name, p.address])));
// Anchor's event-CPI instruction tag: sha256("anchor:event")[0..8].
export const EVENT_IX_TAG = Buffer.from('e445a52e51cb9a1d', 'hex');

const index = Object.fromEntries(Object.entries(IDL.programs).map(([name, p]) => [name, {
  address: p.address,
  instructions: new Map(p.instructions.map(i => [i.name, i])),
  accounts: new Map(p.accounts.map(a => [a.name, a])),
  events: new Map(p.events.map(e => [e.name, e])),
  types: new Map(p.types.map(t => [t.name, t])),
}]));
const program = name => index[name] || fail(`Unknown Pump program ${name}.`);
export const instructionSpec = (prog, name) => program(prog).instructions.get(name) || fail(`Unknown ${prog} instruction ${name}.`);
export const discriminator = (prog, name) => Buffer.from(instructionSpec(prog, name).discriminator);
export const accountDiscriminator = (prog, name) => Buffer.from((program(prog).accounts.get(name) || fail(`Unknown ${prog} account ${name}.`)).discriminator);
// Byte offset of a fixed-size account field (for RPC memcmp filters), counted from the 8-byte discriminator.
const FIXED_SIZES = Object.freeze({ u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, bool: 1, pubkey: 32 });
export function accountFieldOffset(prog, name, field) {
  const def = program(prog).types.get(name) || fail(`Missing ${name} layout.`);
  let offset = 8;
  for (const f of def.type.fields) {
    if (f.name === field) return offset;
    const size = FIXED_SIZES[typeof f.type === 'string' ? f.type : ''];
    if (!size) fail(`Field ${f.name} of ${name} has no fixed size.`);
    offset += size;
  }
  return fail(`Unknown field ${field} of ${name}.`);
}

const definedName = type => typeof type.defined === 'string' ? type.defined : type.defined?.name;
function encodeValue(w, type, value, types) {
  if (typeof type === 'string') {
    switch (type) {
      case 'u8': return w.u8(value); case 'u16': return w.u16(value); case 'u32': return w.u32(value); case 'u64': return w.u64(value);
      case 'i64': return w.i64(value); case 'u128': return w.u128(value); case 'i128': return w.i128(value); case 'bool': return w.bool(value);
      case 'pubkey': case 'publicKey': return w.pubkey(value); case 'string': return w.string(value);
      default: return fail(`Unsupported IDL type ${type}.`);
    }
  }
  if (type.vec) { if (!Array.isArray(value)) fail('IDL vec expected.'); w.u32(value.length); for (const v of value) encodeValue(w, type.vec, v, types); return w; }
  if (type.array) { const [inner, length] = type.array; if (!Array.isArray(value) || value.length !== length) fail('IDL array length mismatch.'); for (const v of value) encodeValue(w, inner, v, types); return w; }
  if (type.option) { if (value === null || value === undefined) return w.u8(0); w.u8(1); return encodeValue(w, type.option, value, types); }
  if (type.defined) {
    const def = types.get(definedName(type)) || fail(`Unknown IDL type ${definedName(type)}.`);
    if (def.type.kind === 'struct') {
      const fields = def.type.fields;
      // Tuple newtypes such as OptionBool / OptionU64 ("fields": ["bool"]).
      if (fields.every(f => typeof f === 'string' || !f.name)) { const values = Array.isArray(value) ? value : [value]; fields.forEach((f, i) => encodeValue(w, typeof f === 'string' ? f : f.type, values[i], types)); return w; }
      for (const f of fields) encodeValue(w, f.type, value?.[f.name], types);
      return w;
    }
    if (def.type.kind === 'enum') { const i = def.type.variants.findIndex(v => v.name === value); if (i < 0) fail('Unknown IDL enum variant.'); return w.u8(i); }
  }
  return fail('Unsupported IDL type.');
}
function decodeValue(r, type, types) {
  if (typeof type === 'string') {
    switch (type) {
      case 'u8': return r.u8(); case 'u16': return r.u16(); case 'u32': return r.u32(); case 'u64': return r.u64();
      case 'i64': return r.i64(); case 'u128': return r.u128(); case 'i128': return r.i128(); case 'bool': return r.bool();
      case 'pubkey': case 'publicKey': return r.pubkey(); case 'string': return r.string();
      default: return fail(`Unsupported IDL type ${type}.`);
    }
  }
  if (type.vec) { const n = r.u32(); if (n > 4096) fail('IDL vec is implausibly long.'); return Array.from({ length: n }, () => decodeValue(r, type.vec, types)); }
  if (type.array) { const [inner, length] = type.array; return Array.from({ length }, () => decodeValue(r, inner, types)); }
  if (type.option) return r.u8() === 1 ? decodeValue(r, type.option, types) : null;
  if (type.defined) {
    const def = types.get(definedName(type)) || fail(`Unknown IDL type ${definedName(type)}.`);
    if (def.type.kind === 'struct') {
      const fields = def.type.fields;
      if (fields.every(f => typeof f === 'string' || !f.name)) { const values = fields.map(f => decodeValue(r, typeof f === 'string' ? f : f.type, types)); return values.length === 1 ? values[0] : values; }
      return Object.fromEntries(fields.map(f => [f.name, decodeValue(r, f.type, types)]));
    }
    if (def.type.kind === 'enum') { const i = r.u8(); const v = def.type.variants[i] || fail('Unknown IDL enum variant.'); return v.name; }
  }
  return fail('Unsupported IDL type.');
}
function zeroValue(type, types) {
  if (typeof type === 'string') return ['u64', 'i64', 'u128', 'i128'].includes(type) ? 0n : ['u8', 'u16', 'u32'].includes(type) ? 0 : type === 'bool' ? false : ['pubkey', 'publicKey'].includes(type) ? '11111111111111111111111111111111' : '';
  if (type.vec) return [];
  if (type.option) return null;
  if (type.array) return Array.from({ length: type.array[1] }, () => zeroValue(type.array[0], types));
  const def = types.get(definedName(type));
  if (def?.type.kind === 'enum') return def.type.variants[0].name;
  if (def?.type.kind === 'struct') return Object.fromEntries(def.type.fields.map(f => [f.name, zeroValue(f.type, types)]));
  return null;
}

/** Instruction data: 8-byte discriminator + Borsh args. Trailing optional args may be omitted (undefined). */
export function encodeInstructionData(prog, name, args = {}) {
  const spec = instructionSpec(prog, name), types = program(prog).types, w = new BorshWriter().bytes(spec.discriminator);
  const fields = spec.args;
  let last = fields.length;
  while (last > 0 && args[fields[last - 1].name] === undefined) last--;
  for (let i = 0; i < last; i++) {
    const f = fields[i];
    if (args[f.name] === undefined) fail(`Instruction ${name} is missing argument ${f.name}.`);
    encodeValue(w, f.type, args[f.name], types);
  }
  for (let i = last; i < fields.length; i++) {
    // Only the documented optional trailing arguments may be left off.
    const t = fields[i].type, optional = t?.defined && ['OptionBool', 'OptionU64'].includes(definedName(t));
    if (!optional) fail(`Instruction ${name} requires argument ${fields[i].name}.`);
  }
  return w.toBuffer();
}
export function decodeInstructionArgs(prog, name, data) {
  const spec = instructionSpec(prog, name), types = program(prog).types, bytes = Buffer.from(data);
  if (!bytes.subarray(0, 8).equals(Buffer.from(spec.discriminator))) fail(`Not a ${name} instruction.`);
  const r = new BorshReader(bytes, 8), out = {};
  for (const f of spec.args) { if (r.remaining() === 0) break; out[f.name] = decodeValue(r, f.type, types); }
  if (r.remaining() !== 0) fail(`Trailing bytes after ${name} arguments.`);
  return out;
}
/** Decodes an Anchor account, tolerating older (shorter) layouts. */
export function decodeAccount(prog, name, data) {
  const p = program(prog), spec = p.accounts.get(name) || fail(`Unknown ${prog} account ${name}.`), bytes = Buffer.from(data);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from(spec.discriminator))) fail(`The account is not a ${prog} ${name}.`, 'PUMP_CLASSIC_ACCOUNT_TYPE');
  const def = p.types.get(name) || fail(`Missing ${name} layout.`), r = new BorshReader(bytes, 8), out = {};
  let short = false;
  for (const f of def.type.fields) {
    if (!short) {
      const start = r.offset;
      try { out[f.name] = decodeValue(r, f.type, p.types); continue; }
      catch (error) { if (error.code !== 'PUMP_CLASSIC_SHORT') throw error; r.offset = start; short = true; }
    }
    out[f.name] = zeroValue(f.type, p.types);
  }
  return out;
}
/** Decodes an Anchor event-CPI payload (tag + event discriminator + fields) if it is one of ours. */
export function decodeEvent(prog, data) {
  const p = program(prog), bytes = Buffer.from(data);
  if (bytes.length < 16 || !bytes.subarray(0, 8).equals(EVENT_IX_TAG)) return null;
  const disc = bytes.subarray(8, 16);
  for (const [name, spec] of p.events) {
    if (!disc.equals(Buffer.from(spec.discriminator))) continue;
    const def = p.types.get(name) || fail(`Missing ${name} layout.`), r = new BorshReader(bytes, 16), out = {};
    let short = false;
    for (const f of def.type.fields) {
      if (!short) { const start = r.offset; try { out[f.name] = decodeValue(r, f.type, p.types); continue; } catch (error) { if (error.code !== 'PUMP_CLASSIC_SHORT') throw error; r.offset = start; short = true; } }
      out[f.name] = zeroValue(f.type, p.types);
    }
    return { name, fields: out };
  }
  return null;
}
/** Encodes an account (discriminator + Borsh fields); used for fixtures and offline verification tests. */
export function encodeAccount(prog, name, fields) {
  const p = program(prog), spec = p.accounts.get(name) || fail(`Unknown ${prog} account ${name}.`), def = p.types.get(name) || fail(`Missing ${name} layout.`), w = new BorshWriter().bytes(spec.discriminator);
  for (const f of def.type.fields) encodeValue(w, f.type, fields[f.name], p.types);
  return w.toBuffer();
}
/** Encodes an event-CPI payload (tag + discriminator + fields); used for fixtures and tests. */
export function encodeEvent(prog, name, fields) {
  const p = program(prog), spec = p.events.get(name) || fail(`Unknown ${prog} event ${name}.`), def = p.types.get(name) || fail(`Missing ${name} layout.`), w = new BorshWriter().bytes(EVENT_IX_TAG).bytes(spec.discriminator);
  for (const f of def.type.fields) encodeValue(w, f.type, fields[f.name], p.types);
  return w.toBuffer();
}
/** Account metas for an instruction in IDL order. `values` maps IDL account names to addresses. */
export function accountMetas(prog, name, values, { optionalPlaceholder = program(prog).address } = {}) {
  const spec = instructionSpec(prog, name);
  return spec.accounts.map(a => {
    let pubkey = values[a.name];
    if (pubkey === undefined && a.address) pubkey = a.address;
    if (pubkey === undefined || pubkey === null) {
      if (!a.optional) fail(`Instruction ${name} is missing account ${a.name}.`);
      // Anchor reads the invoked program's ID in an optional slot as None.
      return { pubkey: optionalPlaceholder, isSigner: false, isWritable: false, name: a.name };
    }
    if (a.address && pubkey !== a.address) fail(`Instruction ${name} account ${a.name} must be ${a.address}.`);
    return { pubkey, isSigner: !!a.signer, isWritable: !!a.writable, name: a.name };
  });
}
