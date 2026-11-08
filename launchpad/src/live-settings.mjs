// Never reinterpret an old Paper execution request as a funded Live request.
// Setup imports can be upgraded to Live; starting still requires the user to
// supply private keys and explicitly submit a Live request.
export function requireLive(settings) {
  if (settings?.mode !== 'live') throw new Error('Paper trading has been removed. Use Live trading and import wallet private keys before starting.');
}
