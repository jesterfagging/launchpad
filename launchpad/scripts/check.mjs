import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
// Syntax-check every JavaScript file of the engine and its tests (src/ recursively).
const files = [];
const walk = (dir, deep) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) { if (deep) walk(path, deep); } else if (/\.(mjs|cjs|js)$/.test(name)) files.push(path); } };
for (const [dir, deep] of [['src', true], ['public', false], ['test', false], ['scripts', false]]) walk(dir, deep);
for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
console.log(`JavaScript syntax checked (${files.length} files).`);
