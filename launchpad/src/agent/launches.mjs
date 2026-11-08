// AI Agent helpers over Raydium launch records. An agent launch is an ordinary
// creator-fee launch (flat 0.50% creator fee, no transfer tax, relay fee
// custody) whose fee recipient is the agent's server-managed wallet. The
// existing claim and payout machinery is reused unchanged; only the recipient
// differs and every payout to it becomes an agent fee receipt once finalized.
import { isCurrentLaunch, SOL_MINT } from '../../public/launchpad-model.mjs';
import { rewardsWalletSelection, rewardsWalletKey } from '../launchpad-rewards-wallet.mjs';
import { AGENT_MODE } from '../../public/agent-catalog.mjs';

const base58 = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
const signature = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value);
const digits = value => typeof value === 'string' && /^\d+$/.test(value);
const hex = (value, length) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);

export function validAgentAttachment(value) {
  return !!value && value.version === 1 && value.mode === AGENT_MODE && hex(value.id, 24) && base58(value.wallet) && hex(value.policyHash, 64) && Number.isInteger(value.capabilities) && value.capabilities > 0 && typeof value.model === 'string' && value.model.length > 0;
}
// Read from the immutable launch input only. A malformed attachment is not an
// agent launch and never routes fees anywhere new.
export function agentLaunch(l) {
  const input = l?.input;
  return !!input && input.feeMode === 'creator' && validAgentAttachment(input.agent) && input.recipient === input.agent.wallet && Number(input.taxBps || 0) === 0 && input.quoteMint === SOL_MINT;
}
export function agentWallet(l) { return agentLaunch(l) ? l.input.agent.wallet : null; }
function confirmedCreation(l) { return (l.operations || []).find(op => ['create', 'launch-all'].includes(op.kind) && op.state === 'confirmed'); }
/** Non-secret launch row for the agent core's sync pass. */
export function raydiumAgentLaunch(l, { accountId = null } = {}) {
  if (!agentLaunch(l) || !isCurrentLaunch(l.input) || l.state === 'draft') return null;
  const mint = l.keys?.mint?.address; if (!base58(mint)) return null;
  const creation = confirmedCreation(l);
  let paid = 0n, pendingQuote = 0n;
  for (const op of l.operations || []) { if (op.kind !== 'payout' || op.state !== 'confirmed' || !Array.isArray(op.payouts)) continue; for (const row of op.payouts) if (row.owner === l.input.agent.wallet && digits(row.amount)) paid += BigInt(row.amount); }
  if (digits(l.credits?.quote)) pendingQuote = BigInt(l.credits.quote);
  const custody = [l.keys?.wallet?.address, l.keys?.rewards?.address, l.keys?.platform?.address, l.keys?.payer?.address, l.keys?.protocol?.address, l.curve].filter(base58);
  return { venue: 'raydium', mint, launchId: l.id, accountId, name: String(l.input.name || '').slice(0, 100), symbol: String(l.input.symbol || '').slice(0, 24), image: /^[a-f0-9]{64}\.(png|jpg|webp)$/.test(l.input.imageId || '') ? '/token-images/' + l.input.imageId : null,
    agent: { ...l.input.agent }, creatorWallet: l.keys?.payer?.address || l.keys?.wallet?.address || '', status: l.state, live: !!l.curve && ['live', 'paused', 'error'].includes(l.state), created: !!creation || !!l.curve, createdAt: creation?.confirmedAt || l.authorizedAt || l.createdAt, authorizedAt: l.authorizedAt || null, failed: ['failed', 'archived'].includes(l.state) && !l.curve,
    feeCustody: l.feeCustody || 'creator', feeWallet: l.keys?.wallet?.address || null, quoteMint: l.input.quoteMint, quoteDecimals: l.review?.quoteDecimals ?? 9, custody, hidden: l.moderation?.hidden === true, archived: !!l.listArchive?.archived, paidRaw: paid.toString(), pendingRaw: pendingQuote.toString(), redirected: !!l.feeRecipientRedirect || !!l.feeRecipientRedirectedAt };
}
/** Finalized creator payouts to the agent wallet; the sender is the key that signed the payout. */
export function raydiumAgentSources(l) {
  if (!agentLaunch(l) || !isCurrentLaunch(l.input)) return [];
  const rows = [], wallet = l.input.agent.wallet, mint = l.keys?.mint?.address;
  for (const op of l.operations || []) {
    if (op.kind !== 'payout' || op.state !== 'confirmed' || !signature(op.signature) || !Array.isArray(op.payouts)) continue;
    let sender; try { sender = rewardsWalletKey(l, rewardsWalletSelection(l, { operation: op, receipt: true }), { signer: true, receipt: true })?.address; } catch { continue; }
    if (!base58(sender)) continue;
    op.payouts.forEach((row, index) => {
      if (row.owner !== wallet || !digits(row.amount) || BigInt(row.amount) === 0n) return;
      rows.push({ kind: 'raydium-agent-payout', agentId: l.input.agent.id, launchMint: mint, venue: 'raydium', signature: op.signature, allocation: `${mint}:${index}`, mint: l.input.quoteMint, amount: row.amount, wallet, sourceWallet: sender, decimals: l.review?.quoteDecimals ?? 9, at: op.confirmedAt || op.createdAt || null });
    });
  }
  return rows;
}
