#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
: "${LAUNCHPAD_PLATFORM_TOOLS:?Set Solana platform-tools path}"
: "${LAUNCHPAD_SBF_SDK:?Set Solana sbf-sdk path}"
export PATH="$LAUNCHPAD_PLATFORM_TOOLS/rust/bin:$PATH"
export RUSTFLAGS="-C linker=$LAUNCHPAD_PLATFORM_TOOLS/llvm/bin/ld.lld -C link-arg=-T$LAUNCHPAD_SBF_SDK/c/sbf.ld -C link-arg=--shared -C panic=abort"
mkdir -p artifacts
cargo build --locked --offline --release --target sbpf-solana-solana
cp target/sbpf-solana-solana/release/curve_damm_pump_admin_test.so artifacts/curve_damm_pump_admin_test.so
sha256sum artifacts/curve_damm_pump_admin_test.so
