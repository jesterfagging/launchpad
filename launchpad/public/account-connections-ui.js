import { connectionFields } from './connection-fields.mjs';
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text) node.textContent = text; if (cls) node.className = cls; return node; };
const saved = value => typeof value === 'string' && value.startsWith('relay-saved-v1:');

export function createAccountConnections({ dialog, api, chain = 'solana', onSaved = () => {}, onOverview = () => {}, getAccount = () => null }) {
  const heading = dialog.querySelector('.card-heading');
  const overview = el('div', '', 'account-overview');
  for (const child of [...dialog.children]) if (child !== heading) overview.append(child);
  const tabs = el('nav', '', 'account-tabs'); tabs.setAttribute('aria-label', 'Account pages');
  const overviewButton = el('button', 'Overview');
  overviewButton.type = 'button';
  const launchedTokens = el('a', 'Launched tokens'); launchedTokens.href = '/launched-tokens'; launchedTokens.id = 'account-launched-tokens';
  tabs.append(overviewButton, launchedTokens);
  const panel = el('section', '', 'account-connections'); panel.hidden = true; panel.id = 'account-connections';
  const intro = el('div', '', 'connections-intro'); intro.append(el('p', 'YOUR TRADING CONNECTIONS', 'eyebrow'), el('h3', 'Set up once. Use every tool.'), el('p', 'Your RPCs and API keys are shared across your tools on each chain, and sync between web and Telegram. Changes apply to new runs.', 'help'));
  const chains = el('div', '', 'connection-chains'), selectors = {};
  for (const [key, title] of [['solana','Solana'],['robinhood','Robinhood'],['market','Market data']]) {
    const button = el('button', title, 'small-button'); button.type = 'button'; button.dataset.connectionChain = key;
    button.onclick = () => { if (busy) return; collectDraft();clearHusher(); selected = key; load(); }; chains.append(button); selectors[key] = button;
  }
  const form = el('form'), fields = el('div', '', 'connection-fields'); form.autocomplete = 'off';
  const status = el('p', '', 'connection-status help'); status.setAttribute('role', 'status');
  const actions = el('div', '', 'connection-actions'), submit = el('button', 'Save connections', 'primary'), reload = el('button', 'Reload saved', 'text-button');
  submit.type = 'submit'; reload.type = 'button'; reload.onclick = () => { delete drafts[selected]; load(); };
  actions.append(submit, reload); form.append(fields, status, actions);
  const dataNote = el('div', '', 'hosted-data-note'); dataNote.append(el('strong', 'Market data, ready to view'), el('p', 'DEX Screener supplies charts and token statistics without an API key. Live swaps use your chain RPC. Robinhood holder activity uses Blockscout; Solana balances use your RPC and recent activity uses Helius.', 'help'));
  const husher=el('section','','connection-group husher-connection');husher.id='husher-connection';husher.hidden=true;
  husher.append(el('h4','Husher · owner connection'),el('p','Your private host key for wallet funding. Other accounts can use Funding without seeing this key.','help'));
  const husherForm=el('form'),husherKey=el('input'),husherPassword=el('input'),husherCode=el('input'),husherStatus=el('p','','help');
  husherKey.type='password';husherKey.autocomplete='off';husherKey.spellcheck=false;husherKey.id='husher-api-key';husherKey.placeholder='Paste a key to set or replace it';
  husherPassword.type='password';husherPassword.autocomplete='current-password';husherPassword.required=true;husherCode.inputMode='numeric';husherCode.autocomplete='one-time-code';husherCode.required=true;
  for(const [text,input]of [['Husher API key',husherKey],['Account password',husherPassword],['Two-factor code',husherCode]]){const label=el('label',text);label.append(input);husherForm.append(label);}
  const husherActions=el('div','','connection-actions'),reveal=el('button','Reveal saved key','small-button'),hide=el('button','Hide and clear','text-button'),saveHusher=el('button','Verify and save key','small-button');reveal.type=hide.type='button';saveHusher.type='submit';hide.hidden=true;
  husherActions.append(reveal,hide,saveHusher);husherForm.append(husherActions,husherStatus);husher.append(husherForm);
  let husherBusy=false,husherVersion=0,husherTimer;
  function clearHusher(){++husherVersion;clearTimeout(husherTimer);husherKey.value='';husherKey.type='password';husherPassword.value='';husherCode.value='';hide.hidden=true;}
  async function loadHusher(){clearHusher();husher.hidden=getAccount()?.role!=='admin';if(husher.hidden)return;const version=husherVersion;try{const data=await api('/api/account/connections/husher');if(version!==husherVersion)return;husherStatus.textContent=data.configured?'A key is saved. Verify your identity to reveal it or save a replacement.':'No Husher key is configured yet.';husherKey.placeholder=data.configured?'Saved key · reveal to inspect':'Paste your Husher API key';}catch(e){if(version===husherVersion)husherStatus.textContent=e.message;}}
  async function husherAction(action){if(husherBusy)return;if(!husherPassword.value||!husherCode.value){husherStatus.textContent='Enter your account password and two-factor code.';return;}if(action==='save'&&!husherKey.value){husherStatus.textContent='Paste your Husher API key first.';return;}
    husherBusy=true;reveal.disabled=saveHusher.disabled=true;const version=++husherVersion;
    try{const data=await api('/api/account/connections/husher',{action,password:husherPassword.value,code:husherCode.value,...(action==='save'?{apiKey:husherKey.value}:{})});if(version!==husherVersion)return;
      if(action==='reveal'){husherKey.value=data.apiKey||'';husherKey.type='text';hide.hidden=false;husherStatus.textContent='Visible only in your owner session. This field clears after one minute.';husherTimer=setTimeout(clearHusher,60000);}else{clearHusher();husherStatus.textContent='Husher key verified and saved.';}
    }catch(e){if(version===husherVersion)husherStatus.textContent=e.message;}finally{husherPassword.value='';husherCode.value='';husherBusy=false;reveal.disabled=saveHusher.disabled=false;}
  }
  reveal.onclick=()=>husherAction('reveal');hide.onclick=clearHusher;husherForm.onsubmit=e=>{e.preventDefault();husherAction('save');};
  document.addEventListener('visibilitychange',()=>{if(document.hidden)clearHusher();});
  panel.append(intro, chains, form, husher, dataNote); dialog.append(tabs, overview, panel);
  let selected = chain, current = null, busy = false, request = 0, inputs = new Map(), drafts = {};
  function view(isConnections) { overview.hidden = isConnections; panel.hidden = !isConnections; overviewButton.setAttribute('aria-pressed', String(!isConnections)); if (isConnections) {load();loadHusher();}else clearHusher(); }
  overviewButton.onclick = () => { collectDraft(); view(false); onOverview(); }; view(false);
  function collectDraft() { if (current && !busy) drafts[selected] = { revision: current.revision, values: values() }; }
  function values() { return Object.fromEntries([...inputs].map(([key, input]) => [key, input.type === 'checkbox' ? input.checked : input.value])); }
  function controls() { submit.disabled = busy || !current; reload.disabled = busy; for (const button of Object.values(selectors)) button.disabled = busy; }
  function render(value) {
    fields.replaceChildren(); inputs = new Map(); let group, box;
    for (const field of connectionFields[selected]) {
      if (field.group !== group) {
        group = field.group; const section = el(group === 'Advanced endpoints' ? 'details' : 'section', '', 'connection-group');
        section.append(el(group === 'Advanced endpoints' ? 'summary' : 'h4', group)); box = el('div', '', 'connection-grid'); section.append(box); fields.append(section);
      }
      const label = el('label', '', 'connection-field'), line = el('span', field.label), wrap = el('div', '', 'connection-input');
      let input = el(field.type === 'select' ? 'select' : 'input'); input.id = `connection-${selected}-${field.key}`; input.name = field.key;
      if (field.type === 'select') for (const [key, title] of field.options) { const option = el('option', title); option.value = key; input.append(option); }
      else input.type = field.type === 'secret' ? 'password' : field.type === 'boolean' ? 'checkbox' : 'number';
      if (field.type === 'number') { input.min = String(field.min); input.max = String(field.max); input.step = '1'; input.required = true; }
      const initial = value.values[field.key] ?? ''; if (field.type === 'boolean') input.checked = !!initial; else input.value = initial;
      input.autocomplete = 'off'; input.spellcheck = false; if (field.type === 'secret') input.placeholder = 'Not set · paste to add';
      wrap.append(input);
      if (field.type === 'secret') {
        const badge = el('small', initial ? 'Saved' : selected === 'market' ? 'Not set' : 'Optional', 'connection-badge'); line.append(badge);
        const clear = el('button', 'Clear', 'text-button'); clear.type = 'button'; clear.setAttribute('aria-label', `Clear ${field.label}`);
        clear.onclick = () => { input.value = ''; badge.textContent = 'Will clear'; input.focus(); };
        input.oninput = () => { badge.textContent = input.value ? saved(input.value) ? 'Saved' : 'New value' : 'Will clear'; }; wrap.append(clear);
      }
      if (field.type === 'boolean') { label.classList.add('connection-check'); label.append(wrap, line); } else label.append(line, wrap);
      if (field.help) label.append(el('small', field.help, 'help'));
      if (field.link) { const link = el('a', field.linkText, 'connection-provider-link'); link.href = field.link; link.target = '_blank'; link.rel = 'noopener noreferrer'; label.append(link); }
      box.append(label); inputs.set(field.key, input);
    }
  }
  async function load() {
    const generation = ++request; busy = true; current = null; status.textContent = 'Loading saved connections…'; controls();
    for (const [key, button] of Object.entries(selectors)) button.setAttribute('aria-pressed', String(key === selected));
    fields.replaceChildren(); inputs.clear();
    try { const value = await api(`/api/account/connections?chain=${selected}`); if (generation !== request) return; current = value;
      if (drafts[selected]?.revision === value.revision) value.values = drafts[selected].values;
      else if (drafts[selected]) delete drafts[selected];
      render(value); status.textContent = 'Saved keys stay masked. Paste a new value to replace one.';
    } catch (error) { if (generation === request) status.textContent = error.message; }
    finally { if (generation === request) { busy = false; controls(); } }
  }
  form.onsubmit = async event => {
    event.preventDefault(); if (busy || !current) return; const target = selected, generation = request, revision = current.revision, patch = values(); busy = true; controls(); status.textContent = 'Saving connections…';
    try { const result = await api('/api/account/connections', { chain: target, values: patch, revision });
      const synchronized = onSaved({ ...result, previousRevision: revision });
      if (target === 'market') document.dispatchEvent(new CustomEvent('relay-market-connections-saved', { detail: { refreshMs: Number(result.values.marketRefreshSeconds) * 1000 } }));
      delete drafts[target]; if (generation !== request) return; current = result; render(result); status.textContent = synchronized === false ? 'Connections saved. Reload the trading page before saving or starting: other settings changed on another device.' : target === 'market' ? 'Saved. Market data now uses your connections.' : 'Saved. New runs on web and Telegram will use these connections.';
    } catch (error) { if (generation === request) status.textContent = error.message; }
    finally { if (generation === request) { busy = false; controls(); } }
  };
  dialog.addEventListener('close', () => { ++request; busy = false; current = null; drafts = {}; inputs.clear(); fields.replaceChildren(); status.textContent = ''; view(false); });
  return { open: () => { if (!dialog.open) dialog.showModal(); view(true); }, showOverview: () => { view(false); onOverview(); } };
}
