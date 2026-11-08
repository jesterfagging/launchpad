// Paycheck (v71.44): the published terms of the Paycheck launch mode, shared by the launch form, the coin page, the
// docs copy and the server. The numbers are the policy; the server's ledger (src/launchpad-paycheck.mjs) applies them.
export const PAYCHECK_POLICY = 'paycheck-v1';
export const PAYCHECK_INTERVAL_MS = 15 * 60 * 1000;
export const PAYCHECK_THRESHOLD_CENTS = 50n;       // a wallet is paid once its accrued share is worth $0.50
export const PAYCHECK_CLAIM_MINIMUM_CENTS = 100n;  // the creator-fee vault is claimed once it holds $1
export const PAYCHECK_SPLIT_BPS = Object.freeze({ holders: 5000, burn: 3500, curve: 1000, creator: 500 });
export const PAYCHECK_SPLIT_LABELS = Object.freeze({ holders: 'Holders', burn: '$LAUNCHPAD buy-and-burn', curve: 'Launchpad', creator: 'Creator' });
export const paycheckPercent = key => (PAYCHECK_SPLIT_BPS[key] / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '%';
export const PAYCHECK_SPLIT_SENTENCE = `holders ${paycheckPercent('holders')} · $LAUNCHPAD buy-and-burn ${paycheckPercent('burn')} · Launchpad ${paycheckPercent('curve')} · creator ${paycheckPercent('creator')}`;
/** A launch input (saved or being built) that runs Paycheck: a holder-rewards launch with no transfer tax and the Paycheck policy. */
export const paycheckInput = input => !!input && input.feeMode === 'holders' && !input.gotchi && input.paycheck?.policy === PAYCHECK_POLICY;
