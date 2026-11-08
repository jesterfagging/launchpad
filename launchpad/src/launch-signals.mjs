import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { PUMP_SDK, getPumpProgram, pumpIdl, bondingCurvePda } from '@pump-fun/pump-sdk';
import { PUMP, SOL } from './core.mjs';

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const tokens = new Set([TOKEN, TOKEN_2022]);
const createDiscriminator = Buffer.from(pumpIdl.events.find(e => e.name === 'CreateEvent').discriminator);
const coder = getPumpProgram(null).coder.types;
const creationInstructions = pumpIdl.instructions.filter(ix => ['create', 'create_v2'].includes(ix.name));
const key = v => String(v?.pubkey || v || '');
function pumpSignal(developer, mint, program, quote = SOL) {
  return { lead: developer, inputMint: quote, outputMint: mint, inputDecimals: quote === SOL ? 9 : undefined,
    venue: { type: 'pump', pool: bondingCurvePda(new PublicKey(mint)).toBase58(), baseMint: mint, quoteMint: quote, baseTokenProgram: program, lookupTables: [] },
    source: 'pump-create', launch: true };
}

// Only authenticated Program data emitted inside a successful Pump frame is
// accepted. The launch user is a required signer; the freely chosen creator
// metadata field alone must never trigger another user's sniper.
export function pumpLaunchLogs(value, developers) {
  if (value?.err !== null || !Array.isArray(value.logs)) return [];
  const stack = [], launches = [];
  try {
    for (const line of value.logs) {
      if (typeof line !== 'string' || /log truncated/i.test(line)) return [];
      const invoke = /^Program (\w+) invoke \[(\d+)\]$/.exec(line);
      if (invoke) { if (+invoke[2] !== stack.length + 1) return []; stack.push(invoke[1]); continue; }
      const end = /^Program (\w+) (success|failed:.*)$/.exec(line);
      if (end) { if (stack.pop() !== end[1] || end[2] !== 'success') return []; continue; }
      if (stack.at(-1) !== PUMP || !line.startsWith('Program data: ')) continue;
      const encoded = line.slice(14); if (encoded.length > 10000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return [];
      const data = Buffer.from(encoded, 'base64'); if (!data.subarray(0, 8).equals(createDiscriminator)) continue;
      const body = data.subarray(8), event = PUMP_SDK.decodeCreateEventBc(body);
      const canonical = coder.encode('createEvent', event);
      // Older layouts fall back to full instruction parsing rather than guess
      // an omitted token program, quote mint or creator identity.
      if (![0, 1, 9].includes(canonical.length - body.length) || !canonical.subarray(0, body.length).equals(body)) return [];
      const developer = event.user.toBase58(), mint = event.mint.toBase58(), program = event.tokenProgram.toBase58();
      if (!developers.includes(developer) || !tokens.has(program)) continue;
      if (event.bondingCurve.toBase58() !== bondingCurvePda(event.mint).toBase58()) return [];
      const quote = !event.quoteMint || event.quoteMint.equals(PublicKey.default) ? SOL : event.quoteMint.toBase58();
      launches.push(pumpSignal(developer, mint, program, quote));
    }
    return stack.length ? [] : [...new Map(launches.map(l => [l.outputMint, l])).values()];
  } catch { return []; }
}

export function detectLaunches(tx, developers) {
  if (!tx?.meta || tx.meta.err !== null) return [];
  const message = tx.transaction?.message, keys = message?.accountKeys || [];
  const signers = new Set(keys.flatMap((v, i) => v?.signer === true || (typeof v === 'string' && i < (message.header?.numRequiredSignatures || 0)) ? [key(v)] : []));
  const instructions = [...(message?.instructions || []), ...(tx.meta.innerInstructions || []).flatMap(row => row.instructions || [])];
  const launches = new Map();
  for (const ix of instructions) {
    const program = key(ix.programId || keys[ix.programIdIndex]);
    if (program === PUMP && typeof ix.data === 'string' && Array.isArray(ix.accounts)) {
      let bytes; try { bytes = bs58.decode(ix.data); } catch { continue; }
      const schema = creationInstructions.find(row => Buffer.from(row.discriminator).equals(Buffer.from(bytes).subarray(0, 8)));
      if (!schema) continue;
      const account = name => { const v = ix.accounts[schema.accounts.findIndex(a => a.name === name)]; return typeof v === 'number' ? key(keys[v]) : key(v); };
      const developer = account('user'), mint = account('mint'), tokenProgram = account('token_program');
      if (!developers.includes(developer) || !signers.has(developer) || !tokens.has(tokenProgram)) continue;
      try {
        if (account('bonding_curve') !== bondingCurvePda(new PublicKey(mint)).toBase58()) continue;
        // A modern event carries non-SOL quote metadata. Legacy create uses SOL.
        const event = pumpLaunchLogs({ err: null, logs: tx.meta.logMessages }, developers).find(l => l.outputMint === mint);
        let quote = SOL;
        if (schema.name === 'create_v2' && ix.accounts.length > schema.accounts.length) {
          if (ix.accounts.length !== schema.accounts.length + 4) continue;
          const extra = ix.accounts.slice(schema.accounts.length).map(v => typeof v === 'number' ? key(keys[v]) : key(v));
          if (!tokens.has(extra[2])) continue;
          quote = new PublicKey(extra[0]).toBase58();
        }
        if (event && (event.lead !== developer || event.inputMint !== quote)) continue;
        launches.set(mint, event || pumpSignal(developer, mint, tokenProgram, quote));
      } catch {}
    }
    if (tokens.has(program) && ['initializeMint', 'initializeMint2'].includes(ix.parsed?.type)) {
      const info = ix.parsed.info, developer = key(info.mintAuthority), mint = key(info.mint);
      if (!developers.includes(developer) || !signers.has(developer) || launches.has(mint)) continue;
      try { new PublicKey(mint); } catch { continue; }
      launches.set(mint, { lead: developer, inputMint: SOL, outputMint: mint, inputDecimals: 9, outputDecimals: Number(info.decimals), source: 'spl-mint-create', launch: true });
    }
  }
  return [...launches.values()];
}
