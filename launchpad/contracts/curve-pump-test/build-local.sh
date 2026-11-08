#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
: "${LAUNCHPAD_PLATFORM_TOOLS:?Set path to Solana platform-tools v1.57}"
: "${LAUNCHPAD_SBF_SDK:?Set path to sbf-sdk v4.3.0}"
export PATH="$LAUNCHPAD_PLATFORM_TOOLS/rust/bin:$PATH"
export RUSTFLAGS="-C linker=$LAUNCHPAD_PLATFORM_TOOLS/llvm/bin/ld.lld -C link-arg=-T$LAUNCHPAD_SBF_SDK/c/sbf.ld -C link-arg=--shared -C panic=abort"
mkdir -p artifacts
cargo build --locked --release --target sbpf-solana-solana --features local-test
cp target/sbpf-solana-solana/release/curve_pump_test.so artifacts/curve_pump_test_LOCAL_ONLY.so
cargo build --locked --release --target sbpf-solana-solana
cp target/sbpf-solana-solana/release/curve_pump_test.so artifacts/curve_pump_test_DISABLED.so
printf '%s\n' 'Compiled local-only and disabled programs. No deployment or transaction performed.'
