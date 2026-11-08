import { createInterface, clearLine, cursorTo } from 'node:readline';
import { Writable } from 'node:stream';

// Keep readline's paste/edit handling, but send its raw echo to a sink.
// The real terminal receives only a mask and character count.
export function readSecret(label, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY) throw new Error('Open an interactive terminal to enter this secret.');
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const rl = createInterface({ input, output: muted, terminal: true, historySize: 0 });
  return new Promise((resolve, reject) => {
    let finished = false;
    const render = () => {
      if (finished) return;
      const count = rl.line.length;
      cursorTo(output, 0); clearLine(output, 0);
      output.write(label + '*'.repeat(Math.min(count, 32)) + (count ? ` (${count} characters)` : ''));
    };
    const finish = (error, answer) => {
      if (finished) return; finished = true;
      input.off('keypress', render); rl.close(); muted.end(); output.write('\n');
      if (error) reject(error); else resolve(answer.trim());
    };
    rl.once('SIGINT', () => finish(new Error('Setup cancelled.')));
    rl.once('close', () => { if (!finished) finish(new Error('Secret input closed. Run setup again.')); });
    // Registered after readline, so line edits have already been applied.
    input.on('keypress', render);
    rl.question('', answer => finish(null, answer)); render();
  });
}
