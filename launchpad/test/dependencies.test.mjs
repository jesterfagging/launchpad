import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDependencies, dependencyInstallCommand, DEPENDENCY_MARKER } from '../scripts/ensure-dependencies.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'launchpad-deps-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = { name: 'launchpad-engine', version: '1.0.0', dependencies: { example: '1.0.0' } };
  const lock = { name: 'launchpad-engine', version: '1.0.0', lockfileVersion: 3, packages: { '': structuredClone(manifest), 'node_modules/example': { version: '1.0.0', resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz', integrity: 'sha512-example' } } };
  const save = () => { writeFileSync(join(root, 'package.json'), JSON.stringify(manifest)); writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock)); };
  let installs = 0;
  const install = () => { installs++; mkdirSync(join(root, 'node_modules'), { recursive: true }); return { status: 0 }; };
  const marker = join(root, 'node_modules', DEPENDENCY_MARKER);
  save(); return { root, manifest, lock, save, install, marker, installs: () => installs };
}

test('launchers install changed dependencies once and preserve existing application data', t => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'data')); writeFileSync(join(f.root, 'data', 'live.json'), 'existing journal');
  assert.equal(ensureDependencies(f.root, f.install), true); assert.equal(ensureDependencies(f.root, f.install), false);
  f.manifest.dependencies.example = '1.1.0'; f.lock.packages[''].dependencies.example = '1.1.0'; f.lock.packages['node_modules/example'].version = '1.1.0'; f.save();
  assert.equal(ensureDependencies(f.root, f.install), true); assert.equal(f.installs(), 2);
  assert.equal(readFileSync(join(f.root, 'data', 'live.json'), 'utf8'), 'existing journal');
});

test('source edits, app name/version changes and JSON formatting do not reinstall dependencies', t => {
  const f = fixture(t); ensureDependencies(f.root, f.install);
  f.manifest.name = f.lock.name = f.lock.packages[''].name = 'curve-renamed';
  f.manifest.version = f.lock.version = f.lock.packages[''].version = '2.0.0'; f.save();
  writeFileSync(join(f.root, 'app.mjs'), '// changed app source');
  writeFileSync(join(f.root, 'package-lock.json'), JSON.stringify(Object.fromEntries(Object.entries(f.lock).reverse()), null, 4));
  assert.equal(ensureDependencies(f.root, f.install), false); assert.equal(f.installs(), 1);
});

test('resolved package integrity and manifest overrides each invalidate the installation', t => {
  const f = fixture(t); ensureDependencies(f.root, f.install);
  f.lock.packages['node_modules/example'].integrity = 'sha512-different'; f.save();
  assert.equal(ensureDependencies(f.root, f.install), true);
  f.manifest.overrides = { example: '$example' }; f.save();
  assert.equal(ensureDependencies(f.root, f.install), true); assert.equal(f.installs(), 3);
});

test('platform, architecture, Node ABI and install configuration changes require an install', t => {
  const f = fixture(t), runtime = { platform: 'linux', arch: 'x64', abi: '127', env: {} };
  ensureDependencies(f.root, f.install, runtime);
  for (const change of [{ platform: 'win32' }, { arch: 'arm64' }, { abi: '137' }, { env: { NODE_ENV: 'production' } }, { env: { npm_config_omit: 'optional' } }]) {
    Object.assign(runtime, change); assert.equal(ensureDependencies(f.root, f.install, runtime), true);
    assert.equal(ensureDependencies(f.root, f.install, runtime), false);
  }
  writeFileSync(join(f.root, '.npmrc'), 'legacy-peer-deps=true\n');
  assert.equal(ensureDependencies(f.root, f.install, runtime), true);
});

test('old dependency markers require one fresh install and then skip', t => {
  const f = fixture(t); mkdirSync(join(f.root, 'node_modules'));
  writeFileSync(join(f.root, 'node_modules', '.relay-dependencies.sha256'), 'old marker');
  assert.equal(ensureDependencies(f.root, f.install), true); assert.equal(ensureDependencies(f.root, f.install), false);
});

test('failed or interrupted attempts invalidate previous success before installation starts', t => {
  const f = fixture(t); ensureDependencies(f.root, f.install);
  const original = structuredClone(f.lock.packages['node_modules/example']);
  f.lock.packages['node_modules/example'].version = '1.1.0'; f.save();
  for (const result of [{ status: 1 }, { status: null, error: Object.assign(Error('locked'), { code: 'EPERM' }) }, { status: null, signal: 'SIGINT' }]) {
    assert.throws(() => ensureDependencies(f.root, () => { assert.equal(existsSync(f.marker), false); return result; }), /EPERM, EBUSY.*close all Launchpad and Telegram.*restart Windows/);
    assert.equal(existsSync(f.marker), false);
  }
  assert.throws(() => ensureDependencies(f.root, () => { throw Error('interrupted'); }), /installation failed/);
  assert.equal(existsSync(f.marker), false);
  f.lock.packages['node_modules/example'] = original; f.save();
  assert.equal(ensureDependencies(f.root, f.install), true);
});

test('Windows npm invocation uses a fixed command without interpolating the working directory', () => {
  const root = 'C:\\Launchpad & echo unsafe\\percent%PATH% (test)';
  const run = dependencyInstallCommand(root, 'win32');
  assert.equal(run.command, 'cmd.exe'); assert.equal(run.options.shell, false); assert.equal(run.options.cwd, root);
  assert.deepEqual(run.args, ['/d', '/s', '/c', 'npm.cmd ci --ignore-scripts --no-audit --no-fund']);
  assert(!run.args.some(value => value.includes(root)));
  const posix = dependencyInstallCommand('/tmp/Launchpad & test', 'linux');
  assert.equal(posix.command, 'npm'); assert.equal(posix.options.shell, false);
  assert.deepEqual(posix.args, ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
});
