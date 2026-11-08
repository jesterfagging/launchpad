// CJS entry points keep the SDKs lazy on desktop and statically discoverable
// by the Android bundler. In particular, DLMM's ESM entry uses directory imports.
module.exports = {
  pump: () => require('@pump-fun/pump-swap-sdk'),
  raydium: () => require('@raydium-io/raydium-sdk-v2'),
  damm: () => require('@meteora-ag/cp-amm-sdk'),
  dlmm: () => require('@meteora-ag/dlmm'),
};
