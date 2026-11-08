// Funding deposits for an AI Agent coin: "Fund activity" (100% operating
// credit) and "Fund treasury" (100% coin treasury). The server prepares an
// unsigned, memo-bound SOL transfer from the connected wallet; the wallet
// signs it; Launchpad submits once and reconciles the finalized receipt. Nothing
// here spends from an agent wallet and nothing is refundable.
import { getLaunchpadWallet } from './launchpad-wallet.mjs';

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function createAgentFunding({ document, window, root, mint, fetcher = fetch, walletFactory = getLaunchpadWallet, onFinalized = () => {}, clock = Date.now } = {}) {
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = String(text); if (cls) node.className = cls; return node; };
  let session = null, wallet = null, busy = false, intent = null, disposed = false, purpose = 'activity', amount = '', message = '', bad = false, pollTimer = null, unsubscribe = null;
  root.innerHTML = `<div class="agent-fund"><div class="agent-fund-heading"><h3>Fund this agent</h3><span class="agent-fund-note">Non-refundable · no ownership or reward claim</span></div><div class="agent-fund-choice" role="group" aria-label="Funding purpose"><button type="button" data-fund-purpose="activity" aria-pressed="true">Fund activity</button><button type="button" data-fund-purpose="treasury" aria-pressed="false">Fund treasury</button></div><p class="agent-fund-help" data-fund-help></p><div class="agent-fund-row"><label class="agent-fund-amount"><span>Amount</span><input data-fund-amount type="number" min="0.01" max="1000" step="0.01" inputmode="decimal" placeholder="0.10"><b>SOL</b></label><button type="button" class="primary" data-fund-action>Connect wallet</button></div><div class="agent-fund-wallets" data-fund-wallets hidden></div><p class="agent-fund-status" data-fund-status role="status"></p><div class="agent-fund-terms"><strong>Before you sign</strong><span>Your wallet signs a plain SOL transfer to the agent wallet with a unique memo. Activity funding becomes operating credit only after settlement to USDC and provider backing; treasury funding is available to the agent's capped actions after finalization. Contributions are not trading fees, not organic volume and not protocol revenue. Launchpad holds the agent wallet key.</span></div></div>`;
  const $ = selector => root.querySelector(selector);
  function ensureWallet() { if (!wallet) { wallet = walletFactory({ window }); unsubscribe = wallet.onChange?.(() => { if (!disposed) render(); }); } return wallet; }
  function connectedAddress() { const address = ensureWallet().state()?.address || ''; return ADDRESS.test(address) ? address : ''; }
  function identity() { return session?.authenticated ? session.account?.id || '' : ''; }
  function sessionWallet() { return session?.walletVerified === true ? session.walletAddress : session?.account?.mainWallet || ''; }
  async function api(path, body) {
    const response = await fetcher('/api/launchpad/agents/' + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'x-control-token': session?.token || '', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json().catch(() => ({})); if (!response.ok) throw Object.assign(Error(data.error || 'The funding request failed.'), { status: response.status }); return data;
  }
  function status(text, isBad = false) { message = text; bad = isBad; render(); }
  function render() {
    if (disposed) return;
    for (const button of root.querySelectorAll('[data-fund-purpose]')) button.setAttribute('aria-pressed', String(button.dataset.fundPurpose === purpose));
    $('[data-fund-help]').textContent = purpose === 'activity' ? '100% to operating credit: pays for the agent’s model and browser usage after settlement and provider backing. Shown as "unsettled" until then.' : '100% to the coin treasury: available only to the agent’s capped buyback-and-burn and holder-reward actions.';
    const action = $('[data-fund-action]'), connected = connectedAddress(), expected = sessionWallet();
    const active = intent && ['awaiting_signature', 'submitted'].includes(intent.state);
    action.disabled = busy || !!active || !identity();
    action.textContent = !identity() ? 'Sign in to fund' : busy ? 'Working…' : !connected ? 'Connect wallet' : active ? 'Waiting for confirmation…' : 'Sign ' + (purpose === 'activity' ? 'activity' : 'treasury') + ' deposit';
    const note = $('[data-fund-status]'); note.textContent = message || (connected && expected && connected !== expected ? 'Connect the wallet you signed in with (' + expected.slice(0, 4) + '…' + expected.slice(-4) + ').' : ''); note.dataset.bad = String(bad);
  }
  function renderWallets() {
    const host = $('[data-fund-wallets]'), state = ensureWallet().state() || {}; host.replaceChildren();
    for (const row of state.wallets || []) { const button = el('button', row.name, 'small-button'); button.type = 'button'; button.onclick = async () => { try { await ensureWallet().connect(row.id); host.hidden = true; status(''); } catch (error) { status(error.message || 'The wallet could not connect.', true); } }; host.append(button); }
    if (!(state.wallets || []).length) host.append(el('p', 'Open Launchpad in your Solana wallet browser or use a compatible wallet extension.', 'agent-fund-help'));
  }
  async function poll(id) {
    window.clearTimeout(pollTimer);
    try { const latest = await api('fund/status?intentId=' + encodeURIComponent(id)); if (disposed) return; intent = latest; if (latest.state === 'finalized') { status('Deposit finalized: ' + latest.amountSol + ' SOL credited to ' + (latest.purpose === 'activity' ? 'operating funds' : 'the treasury') + '.'); onFinalized(latest); return; } if (['failed', 'expired', 'cancelled'].includes(latest.state)) { status(latest.error || 'The deposit did not complete. Nothing was credited.', true); return; } }
    catch (error) { if (!disposed) status(error.message, true); }
    pollTimer = window.setTimeout(() => poll(id), 5000);
  }
  async function act() {
    if (busy || disposed) return;
    if (!identity()) return;
    const connected = connectedAddress();
    if (!connected) { const rows = ensureWallet().state().wallets || []; if (rows.length === 1) { try { await ensureWallet().connect(rows[0].id); } catch (error) { return status(error.message || 'The wallet could not connect.', true); } } else { $('[data-fund-wallets]').hidden = !$('[data-fund-wallets]').hidden; renderWallets(); return render(); } }
    const expected = sessionWallet(); if (expected && connectedAddress() !== expected) return status('Connect the wallet you signed in with before funding.', true);
    const value = Number($('[data-fund-amount]').value); if (!Number.isFinite(value) || value < 0.01) return status('Enter at least 0.01 SOL.', true);
    busy = true; status('Preparing the deposit…');
    try {
      const prepared = await api('fund/prepare', { mint, purpose, amountSol: String(value) }); if (disposed) return;
      intent = prepared; status('Approve the ' + prepared.amountSol + ' SOL deposit in your wallet. Memo ' + prepared.memo + '.');
      let signed; try { signed = await ensureWallet().sign({ wallet: prepared.sender, transaction: prepared.transaction }); }
      catch (error) { await api('fund/cancel', { intentId: prepared.id }).catch(() => {}); intent = null; status('Wallet approval was cancelled or failed. Nothing was submitted.', true); return; }
      if (disposed) return;
      status('Submitting once and waiting for the finalized receipt…');
      const submitted = await api('fund/submit', { intentId: prepared.id, signedTransaction: signed }); if (disposed) return;
      intent = submitted; poll(submitted.id);
    } catch (error) { if (!disposed) status(error.message || 'The deposit could not be prepared.', true); }
    finally { busy = false; if (!disposed) render(); }
  }
  for (const button of root.querySelectorAll('[data-fund-purpose]')) button.onclick = () => { if (busy) return; purpose = button.dataset.fundPurpose; status(''); };
  $('[data-fund-action]').onclick = act;
  render();
  return { setSession(next) { session = next; render(); }, preset({ purpose: nextPurpose, amount: nextAmount } = {}) { if (['activity', 'treasury'].includes(nextPurpose)) purpose = nextPurpose; if (nextAmount) { amount = String(nextAmount); $('[data-fund-amount]').value = amount; } render(); }, destroy() { disposed = true; window.clearTimeout(pollTimer); unsubscribe?.(); }, busy: () => busy || !!(intent && intent.state === 'awaiting_signature') };
}
