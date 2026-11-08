#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
: "${LAUNCHPAD_PLATFORM_TOOLS:?Set path to Solana platform-tools v1.57}"
: "${LAUNCHPAD_SBF_SDK:?Set path to sbf-sdk v4.3.0}"
: "${LAUNCHPAD_TEST_OPERATOR:?Set real owner wallet PUBLIC KEY, never a private key}"
: "${LAUNCHPAD_TEST_PROGRAM_ID:?Set planned deployment program PUBLIC KEY for manifest}"
if [[ "$LAUNCHPAD_TEST_OPERATOR" == "GFKfRLPKHYRyARLSTc4p94vukKPMFAkSrQT5j55WYoy2" ]]; then
  printf '%s\n' 'Refusing public owner-verification fixture key. Use your own wallet public key.' >&2
  exit 1
fi
export PATH="$LAUNCHPAD_PLATFORM_TOOLS/rust/bin:$PATH"
export RUSTFLAGS="-C linker=$LAUNCHPAD_PLATFORM_TOOLS/llvm/bin/ld.lld -C link-arg=-T$LAUNCHPAD_SBF_SDK/c/sbf.ld -C link-arg=--shared -C panic=abort"
mkdir -p artifacts
cargo build --locked --release --target sbpf-solana-solana --features owner-test
cp target/sbpf-solana-solana/release/curve_pump_test.so artifacts/curve_pump_test_OWNER_REQUIRES_REVIEW.so
sha256sum artifacts/curve_pump_test_OWNER_REQUIRES_REVIEW.so
printf '%s\n' 'Owner artifact compiled only. Check program identity and upgrade policy before deployment. No deployment or transaction performed.'
python3 - <<'PY'
import hashlib,json,os,pathlib
root=pathlib.Path.cwd();binary=root/'artifacts/curve_pump_test_OWNER_REQUIRES_REVIEW.so'
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
manifest={'schemaVersion':1,'feature':'owner-test','operator':os.environ['LAUNCHPAD_TEST_OPERATOR'],'programId':os.environ['LAUNCHPAD_TEST_PROGRAM_ID'],'binarySha256':digest(binary),'binaryLength':binary.stat().st_size,'sourceSha256':digest(root/'src/lib.rs'),'cargoLockSha256':digest(root/'Cargo.lock'),'buildScriptSha256':digest(root/'build.rs'),'fixtureKeys':False,'preset':'micro-test','graduationFeeBps':2885,'tradeFeeBps':100,'maximumPrincipalLamports':'3000000000','maximumMigrationRentLamports':'100000000','deployed':False}
(root/'artifacts/owner-build-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
PY
