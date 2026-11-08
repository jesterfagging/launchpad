import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

export const DEPENDENCY_MARKER = '.curve-dependencies-v2.sha256';
const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'overrides', 'workspaces', 'installConfig', 'packageManager', 'os', 'cpu'];
const installArgs = ['ci', '--ignore-scripts', '--no-audit', '--no-fund'];
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const dependencySettings = value => Object.fromEntries(dependencyFields.filter(key => value[key] !== undefined).map(key => [key, value[key]]));

export function dependencyFingerprint(root, { platform = process.platform, arch = process.arch, abi = process.versions.modules, env = process.env } = {}) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  if (!lock.packages || typeof lock.packages !== 'object') throw new Error('The dependency lockfile is invalid. Restore package-lock.json from this release.');
  // Application names and release versions do not change the installed graph.
  // Retain every resolved package record, including integrity and platform rules.
  const packages = Object.fromEntries(Object.entries(lock.packages).filter(([path]) => path !== ''));
  const npmrc = join(root, '.npmrc');
  const npmConfig = Object.fromEntries(Object.entries(env).filter(([key]) => /^npm_config_(omit|include|optional|production|legacy_peer_deps|strict_peer_deps|install_links|install_strategy)$/i.test(key)).map(([key, value]) => [key.toLowerCase(), value]));
  const input = { version: 2, platform, arch, abi, installArgs, manifest: dependencySettings(manifest),
    lockfileVersion: lock.lockfileVersion, root: dependencySettings(lock.packages[''] || {}), packages,
    config: { nodeEnv: env.NODE_ENV || '', npmConfig, npmrc: existsSync(npmrc) ? readFileSync(npmrc, 'utf8') : '' } };
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
}

export function dependencyInstallCommand(root, platform = process.platform) {
  // cmd.exe is needed for npm.cmd, but the command text is fixed. In particular,
  // the installation path is supplied only as cwd, never as shell command text.
  return platform === 'win32'
    ? { command: 'cmd.exe', args: ['/d', '/s', '/c', 'npm.cmd ci --ignore-scripts --no-audit --no-fund'], options: { cwd: root, stdio: 'inherit', shell: false } }
    : { command: 'npm', args: [...installArgs], options: { cwd: root, stdio: 'inherit', shell: false } };
}

export function ensureDependencies(root, install, runtime = {}) {
  const fingerprint = dependencyFingerprint(root, runtime);
  const marker = join(root, 'node_modules', DEPENDENCY_MARKER);
  if (existsSync(marker) && readFileSync(marker, 'utf8') === fingerprint) return false;
  // Remove any previous success before npm can alter the installation. A failed
  // or interrupted attempt must retry, even if the user restores an older build.
  rmSync(marker, { force: true });
  console.log('Installing dependencies for this build...');
  const run = install || (() => { const { command, args, options } = dependencyInstallCommand(root, runtime.platform); return spawnSync(command, args, options); });
  const advice = 'Dependency installation failed. If npm reports EPERM, EBUSY or a file in use, close all Launchpad and Telegram windows and retry; restart Windows if the file stays locked. For download or connection errors, check your internet connection and retry.';
  let result;
  try { result = run(); }
  catch (cause) { throw new Error(advice, { cause }); }
  if (result?.error || result?.status !== 0) throw new Error(advice, { cause: result?.error });
  writeFileSync(marker, fingerprint);
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { ensureDependencies(fileURLToPath(new URL('../', import.meta.url))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
