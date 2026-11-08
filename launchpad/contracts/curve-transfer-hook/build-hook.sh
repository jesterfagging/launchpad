#!/usr/bin/env bash
# Builds the Launchpad transfer hook program with the owner's Solana platform tools,
# the same way contracts/curve-damm-pump-fee/build-fee.sh builds the fee controller.
# Needs LAUNCHPAD_PLATFORM_TOOLS (the platform-tools checkout: rust/ and llvm/) and
# LAUNCHPAD_SBF_SDK (the sbf-sdk directory with c/sbf.ld). `cargo build-sbf` is the
# plain alternative when the Solana CLI is installed (see README.md).
set -euo pipefail
cd "$(dirname "$0")"
: "${LAUNCHPAD_PLATFORM_TOOLS:?Set Solana platform-tools path}"
: "${LAUNCHPAD_SBF_SDK:?Set Solana sbf-sdk path}"
export PATH="$LAUNCHPAD_PLATFORM_TOOLS/rust/bin:$PATH"
export RUSTFLAGS="-C linker=$LAUNCHPAD_PLATFORM_TOOLS/llvm/bin/ld.lld -C link-arg=-T$LAUNCHPAD_SBF_SDK/c/sbf.ld -C link-arg=--shared -C panic=abort"
mkdir -p artifacts
# The first build on a machine needs the registry once (`cargo fetch` with network);
# every later build is reproducible offline from Cargo.lock.
if [ -f Cargo.lock ]; then
  cargo build --locked --offline --release --target sbpf-solana-solana
else
  cargo build --release --target sbpf-solana-solana
fi
cp target/sbpf-solana-solana/release/curve_transfer_hook.so artifacts/curve_transfer_hook.so
sha256sum artifacts/curve_transfer_hook.so
