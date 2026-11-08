// Durable request results are also the retry boundary for web and Telegram.
export function manualIdentity(trade) {
  return JSON.stringify({ side: trade.side, token: String(trade.token).toLowerCase(), quote: String(trade.quote || '').toLowerCase(), amount: trade.side === 'buy' ? String(trade.amount) : '', percent: trade.side === 'sell' ? Number(trade.percent) : 0, wallets: (trade.wallets || []).map(w => w.toLowerCase()).sort() });
}
export function manualResult(data, id) {
  const record = id ? data.manualRequests?.find(r => r.id === id) : data.manualRequests?.at(-1);
  if (!record) return null;
  return { id: record.id, side: record.side, complete: record.complete, results: record.results.map(row => {
    const pending = data.pending.find(p => p.context?.manualId === record.id && p.wallet === row.wallet);
    return pending ? { ...row, state: 'pending', signature: pending.signature, error: 'Transaction broadcast; awaiting a verified receipt. This request will not submit it again.' } : { ...row };
  }) };
}
export function updateManualResult(data, id, wallet, patch) {
  const row = data.manualRequests?.find(r => r.id === id)?.results.find(r => r.wallet === wallet);
  if (row) { Object.assign(row, patch); if (patch.state === 'confirmed') delete row.error; }
}
