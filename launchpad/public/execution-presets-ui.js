import { cleanExecutionPresets, executionFields, executionInputValue, selectedExecutionValues, useExecutionPreset } from './execution-presets.mjs';

export function createExecutionPresetsUI({ chain, mount, read, write, locked = () => false }) {
  const make = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
  const bar = make('div', null, 'execution-presets'), buttons = make('div', null, 'execution-preset-tabs'), edit = make('button', 'Edit', 'text-button');
  buttons.setAttribute('aria-label', 'Execution presets'); edit.type = 'button'; edit.setAttribute('aria-label', 'Edit execution presets');
  const note = make('p', '', 'help execution-preset-note'); note.setAttribute('role', 'status');
  bar.append(buttons, edit); mount.append(bar, note);
  const dialog = make('dialog', null, 'execution-preset-dialog'), title = make('h2', 'Gas & fee presets'), close = make('button', 'Close', 'small-button'), heading = make('div', null, 'card-heading');
  close.type = 'button'; heading.append(title, close);
  const tabs = make('div', null, 'execution-preset-tabs'), form = make('form'), fieldset = make('fieldset'), nameLabel = make('label', 'Preset name'), name = make('input');
  name.maxLength = 24; name.required = true; nameLabel.append(name); fieldset.append(nameLabel);
  const inputs = new Map();
  for (const f of executionFields(chain)) {
    const label = make('label', f.label), input = make(f.options ? 'select' : 'input'); input.dataset.executionField = f.key;
    if (f.options) for (const option of f.options) { const node = make('option', option === 'swqos' ? 'SWQOS' : 'Max'); node.value = option; input.append(node); }
    else { input.type = f.type === 'boolean' ? 'checkbox' : 'text'; if (f.type !== 'boolean') { input.inputMode = 'decimal'; input.required = true; } }
    if (f.type === 'boolean') label.className = 'check';
    label.append(input); fieldset.append(label); inputs.set(f.key, input);
  }
  const help = make('p', 'Presets control slippage and network fees. The displayed Launchpad platform fee also applies. New slots start with your current settings.', 'help');
  const message = make('p', '', 'help'); message.setAttribute('role', 'status');
  const save = make('button', 'Save & use preset', 'primary'); save.type = 'submit';
  form.append(fieldset, help, message, save); dialog.append(heading, tabs, form); document.body.append(dialog);
  let busy = false, index = 0, failure = '';
  function render() {
    if (busy) return;
    try {
      const settings = read(), book = cleanExecutionPresets(chain, settings.executionPresets, settings), active = selectedExecutionValues(chain, settings) ? book.selected : null;
      for (const [i, button] of [...buttons.children].entries()) { button.setAttribute('aria-pressed', String(active === i)); button.title = book.slots[i].name; button.disabled = locked(); }
      edit.disabled = locked(); note.textContent = failure || (locked() ? 'Stop active tools to change execution presets.' : active == null ? 'Current settings · choose P1, P2 or P3' : `${book.slots[active].name} · saved execution settings`);
    } catch (error) { note.textContent = error.message; }
  }
  async function apply(slotIndex, slot) {
    if (busy || locked()) return;
    busy = true; failure = ''; fieldset.disabled = true; save.disabled = true; edit.disabled = true;
    for (const button of buttons.children) button.disabled = true;
    try { await write(useExecutionPreset(chain, read(), slotIndex, slot)); dialog.close(); }
    catch (error) { failure = error.message; message.textContent = error.message; }
    finally { busy = false; fieldset.disabled = false; save.disabled = false; render(); }
  }
  function show(slotIndex) {
    index = slotIndex;
    const slot = cleanExecutionPresets(chain, read().executionPresets, read()).slots[index]; name.value = slot.name;
    for (const f of executionFields(chain)) { const input = inputs.get(f.key); if (f.type === 'boolean') input.checked = slot.values[f.key]; else input.value = f.scale ? Number(slot.values[f.key]) / f.scale : slot.values[f.key]; }
    for (const [i, button] of [...tabs.children].entries()) button.setAttribute('aria-pressed', String(i === index));
    message.textContent = '';
  }
  for (let i = 0; i < 3; i++) {
    const button = make('button', `P${i + 1}`); button.type = 'button'; button.onclick = () => apply(i); buttons.append(button);
    const tab = make('button', `P${i + 1}`); tab.type = 'button'; tab.onclick = () => { if (!busy) show(i); }; tabs.append(tab);
  }
  edit.onclick = () => { if (!locked()) { show(read().executionPresets?.selected ?? 0); dialog.showModal(); } };
  close.onclick = () => { if (!busy) dialog.close(); }; dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  form.onsubmit = event => {
    event.preventDefault();
    try { const values = Object.fromEntries(executionFields(chain).map(f => [f.key, f.type === 'boolean' ? inputs.get(f.key).checked : executionInputValue(f, inputs.get(f.key).value)])); apply(index, { name: name.value, values }); }
    catch (error) { message.textContent = error.message; }
  };
  render(); return { render, get busy() { return busy; } };
}
