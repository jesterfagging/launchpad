// The September 28 provider audit found canonical launch configurations for
// these mints, but neither had a usable live quote for the full launch preview.
// Keep their issuer metadata and retry through the existing account-scoped
// verifier; a configuration alone must not advertise them as ready to launch.
// This is a small revalidation policy, not an unavailable/denied mint list.
const previewRequired = new Set([
  'PENGTDQeQSXEjKcYw3CTQi9qznxcTHXAA7LMfUNrxLV', // PENG — Penguin Solutions
  'AMBAHqGPjjtJaHPPSuvPu2mPCJdkGZpmhHQa5pkXbxrM', // AMBA — Ambarella
]);

export async function revalidateLaunchQuotes(actorId, assets, verifier) {
  return Promise.all(assets.map(async asset => {
    // Never spend a preview on unconfigured/unknown mints, or let a cached
    // successful preview override the current canonical configuration gate.
    if (asset.supported !== true || !previewRequired.has(asset.mint)) return asset;
    // LaunchCustomPairs.verify provides the full read-only launch preview,
    // per-account cache, 30-second failure retry and shared four-check bound.
    const check = await verifier.verify(actorId, asset.mint);
    return {...asset, supported:check.supported,
      supportReason:check.supported === true ? '' : check.supported === false
        ? check.supportReason
        : 'A live launch preview is not available yet. Launchpad will check again automatically.',
      checkedAt:check.checkedAt};
  }));
}
