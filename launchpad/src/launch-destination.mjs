// New launches cannot accidentally enter the live Raydium flow from a preview
// destination. Existing saved launches retain their historical route.
export function assertRaydiumLaunchRequest(input) {
  for (const key of ['route', 'venue', 'destination', 'launchMode']) {
    if (input?.[key] !== undefined && input[key] !== 'raydium') {
      throw Object.assign(new Error('This endpoint only accepts Raydium launches. PumpSwap testing is a separate, unfunded preview.'), {statusCode:400});
    }
  }
}
