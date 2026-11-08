export function createToolLayout({ chain, openConnections }) {
  const $ = id => document.getElementById(id);
  const form = $(chain === 'solana' ? 'setup' : 'rh-setup');
  // Retain the existing configuration inputs as backing state so presets and
  // trade construction keep exactly the same contract. Account owns the editor.
  let backing;
  if (chain === 'solana') {
    backing = $('heliusKey').closest('.card');
    const fast = $('fast-setup'), help = fast.nextElementSibling, speed = $('speed-settings');
    document.querySelector('.advanced .details-content').prepend(fast, help, speed);
    for (const key of ['rpcRequestsPerSecond','jitoUrl','jitoAuth','senderUrl']) {
      const label = $(key).closest('label');
      if (key === 'rpcRequestsPerSecond' && label.nextElementSibling?.classList.contains('help')) backing.append(label.nextElementSibling);
      backing.append(label);
    }
  } else {
    backing = document.createElement('div'); form.append(backing);
    const gasCard = $('rh-rpc').closest('.card'); gasCard.querySelector('h2').textContent = 'Gas & execution';
    for (const key of ['rh-rpc','rh-rps','rh-poll']) { $(key).required = false; backing.append($(key).closest('label')); }
    gasCard.querySelector('summary').textContent = 'Execution limits';
    gasCard.querySelector('.help').textContent = 'Gas is paid in Robinhood ETH. These limits apply to your trades.';
    gasCard.querySelector('.card-heading').remove();
    const execution = document.createElement('details'), summary = document.createElement('summary');
    execution.className = 'execution-settings'; summary.textContent = 'Gas & execution';
    execution.append(summary);
    const note = document.createElement('p'); note.className = 'help'; note.textContent = 'Default settings are ready. Adjust your gas reserve, slippage, or execution limits here.'; execution.append(note);
    while (gasCard.firstChild) execution.append(gasCard.firstChild);
    gasCard.append(execution);
  }
  backing.classList.add('account-connection-backing'); backing.hidden = true;
  const strip = document.createElement('div'); strip.className = 'account-connection-strip';
  const info = document.createElement('p'); info.textContent = 'RPCs & API keys';
  const hint = document.createElement('span'); hint.textContent = 'Managed in your account'; info.append(hint);
  const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.textContent = 'Account → Connections'; button.onclick = openConnections;
  strip.append(info, button); form.prepend(strip);
  // Single vertical flow for setup cards prevents equal-height grid rows from
  // leaving the large holes under shorter panels seen in the previous build.
  form.classList.add('tool-setup-flow');
  const nav = document.querySelector(chain === 'solana' ? '.strategy-tabs' : '#rh-tools');
  const paths = { terminal:'M3 17l5-5 4 3 8-11M14 4h6v6', copy:'M8 8h12v12H8zM4 16H3V3h13v1', sniper:'M12 3v3m0 12v3M3 12h3m12 0h3M18 12a6 6 0 11-12 0 6 6 0 0112 0z', liquidity:'M12 3C9 7 5 11 5 15a7 7 0 0014 0c0-4-4-8-7-12z', market:'M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4' };
  for (const button of nav.children) {
    const kind = button.dataset.terminal ? 'terminal' : button.dataset.kind || button.dataset.tab;
    if (!paths[kind]) continue;
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('aria-hidden','true'); svg.classList.add('tool-icon');
    const path = document.createElementNS('http://www.w3.org/2000/svg','path'); path.setAttribute('d',paths[kind]); svg.append(path); button.prepend(svg);
  }
}
