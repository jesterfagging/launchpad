#!/usr/bin/env node
// Puts the Uniswap v4 core sources where the Foundry tests expect them (test/vendor/v4-core/src), so the launch,
// rules and payouts tests run against the real PoolManager instead of a mock. v4-core is not part of this repository
// (its licence is Uniswap's; the deployed PoolManager on Robinhood Chain is the official one), so this runs once per
// checkout:
//
//     node scripts/vendor-v4-core.mjs                 clones https://github.com/Uniswap/v4-core (needs git and network)
//     node scripts/vendor-v4-core.mjs C:\path\to\v4-core   uses a checkout or an extracted main.zip you already have
//
// It copies v4-core/src (without src/test), relaxes the PoolManager's pinned `pragma solidity 0.8.26` to the ^0.8.24 the rest of the
// tree uses (foundry.toml pins solc 0.8.28), and writes the one external file v4-core imports (solmate's Owned) under
// test/vendor/solmate, which foundry.toml remaps. Then: forge test --evm-version cancun
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'test', 'vendor', 'v4-core');
let source = process.argv[2] ? resolve(process.argv[2]) : null;
let cloned = null;
if (source && !existsSync(join(source, 'src', 'PoolManager.sol'))) {
  // An extracted GitHub zip nests the tree one folder down (v4-core-main/).
  const nested = readdirSync(source).map(n => join(source, n)).find(d => { try { return statSync(d).isDirectory() && existsSync(join(d, 'src', 'PoolManager.sol')); } catch { return false; } });
  if (nested) source = nested;
}
if (!source) {
  cloned = join(tmpdir(), 'launchpad-v4-core-' + process.pid);
  console.log('cloning Uniswap/v4-core into', cloned);
  execSync(`git clone --depth 1 https://github.com/Uniswap/v4-core.git "${cloned}"`, { stdio: 'inherit' });
  source = cloned;
}
if (!existsSync(join(source, 'src', 'PoolManager.sol'))) {
  console.error('no src/PoolManager.sol under', source, '— give the path of a v4-core checkout (or the folder main.zip extracted to)');
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, 'src'), { recursive: true });
// src/test holds Uniswap's own test hooks and routers, which import forge-std: not needed and not compilable here.
cpSync(join(source, 'src'), join(target, 'src'), { recursive: true, filter: p => !/[\\/]src[\\/]test([\\/]|$)/.test(p) });
let patched = 0;
const walk = dir => { for (const name of readdirSync(dir)) { const p = join(dir, name); if (statSync(p).isDirectory()) walk(p); else if (name.endsWith('.sol')) { const text = readFileSync(p, 'utf8'); const next = text.replace(/pragma solidity 0\.8\.\d+;/, 'pragma solidity ^0.8.24;'); if (next !== text) { writeFileSync(p, next); patched++; } } } };
walk(join(target, 'src'));
const owned = join(root, 'test', 'vendor', 'solmate', 'src', 'auth', 'Owned.sol');
mkdirSync(dirname(owned), { recursive: true });
writeFileSync(owned, `// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.0;

/// @notice The subset of solmate's Owned that Uniswap v4's ProtocolFees uses (test vendoring; see scripts/vendor-v4-core.mjs).
abstract contract Owned {
    event OwnershipTransferred(address indexed user, address indexed newOwner);

    address public owner;

    modifier onlyOwner() virtual {
        require(msg.sender == owner, "UNAUTHORIZED");
        _;
    }

    constructor(address _owner) {
        owner = _owner;
        emit OwnershipTransferred(address(0), _owner);
    }

    function transferOwnership(address newOwner) public virtual onlyOwner {
        owner = newOwner;
        emit OwnershipTransferred(msg.sender, newOwner);
    }
}
`);
let version = 'unknown';
try { version = execSync('git rev-parse --short HEAD', { cwd: source, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* a zip has no git */ }
writeFileSync(join(target, 'VENDORED.txt'), `Uniswap v4-core src/ copied by scripts/vendor-v4-core.mjs from ${cloned ? 'a fresh clone' : source} (commit ${version}); ${patched} pinned pragma(s) relaxed to ^0.8.24.\nNot part of Launchpad's source: see the licence in the v4-core repository.\n`);
if (cloned) rmSync(cloned, { recursive: true, force: true });
console.log(`vendored v4-core (${version}) into ${target}; ${patched} pragma(s) relaxed. Now: forge test --evm-version cancun`);
