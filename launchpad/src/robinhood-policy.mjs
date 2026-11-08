import { launchpadEnv } from './brand-env.mjs';
import { createHash } from 'node:crypto';
import { createPublicClient, http } from 'viem';
import { RATES } from './account-policy.mjs';
import { ROBINHOOD, EVM_NATIVE } from '../public/chains.mjs';
import { ensureRobinhoodAccount, evmAddress } from './robinhood-settings.mjs';
import { publicEndpoint } from './telegram-network.mjs';
import { executorAddress } from './robinhood-deployment.mjs';

export class RobinhoodFeePolicy {
  constructor(accounts, { verifyRecipient, adapterAddress = executorAddress } = {}) { this.accounts = accounts; this.adapterAddress = adapterAddress; this.verifyRecipient = verifyRecipient || (async recipient => {
    const rpc = createPublicClient({ transport: http(publicEndpoint(launchpadEnv('ROBINHOOD_CASHBACK_RPC_URL') || ROBINHOOD.rpc).toString(), { retryCount: 0, timeout: 12000 }) });
    if (await rpc.getChainId() !== ROBINHOOD.id) throw Error('The fee verifier RPC must use Robinhood mainnet (4663).');
    if ((await rpc.getCode({ address: recipient }))?.length > 2) throw Error('Use a regular Robinhood wallet as the fee collection address.');
  }); }
  async get(id) {
    const account = await this.accounts.get(id), data = await ensureRobinhoodAccount(this.accounts, id), saved = await this.accounts.hostStore.read('robinhood-fee-policy', {});
    const rates = { ...RATES, settlement: 'eth' }, recipient = saved.recipient || '', adapter = this.adapterAddress();
    const version = createHash('sha256').update(JSON.stringify({ chainId: ROBINHOOD.id, schedule: 3, recipient, adapter, ...rates, cashbackBps: account.cashbackBps })).digest('hex').slice(0, 24);
    return { ...rates, chain: 'robinhood', chainId: ROBINHOOD.id, version, accountId: id, recipient, adapter, ready: !!recipient && saved.verified === true && !!adapter, mainWallet: data.mainWallet.publicKey, cashbackBps: account.cashbackBps,
      description: 'Copy: 0.25% per buy or sell. Sniping: 1%. Market Making: 0.10%. Copy and sniping buy amounts include the Launchpad fee in Robinhood ETH; sells deduct it from ETH proceeds. Stock quote tokens are converted automatically. Market Making fees settle in ETH. Gas and pool fees are additional. Start or Confirm accepts these fees.',
      liquidityDescription: 'LP automatic adjustments: 0.005%, 0.015%, or 0.025% of fresh position value, by pool fee tier up to 0.05%, up to 0.30%, or higher. Initial deposits, manual withdrawals, fee claims and reinvesting earned fees have no Launchpad management fee. Network and pool swap fees still apply. Cashback accrues after independent verification; payouts are not automatic.' };
  }
  async setRecipient(value) {
    const recipient = evmAddress(value);
    if (BigInt(recipient) <= 2n || recipient === EVM_NATIVE) throw Error('Enter a regular Robinhood fee-collection wallet.');
    await this.verifyRecipient(recipient);
    await this.accounts.hostStore.write('robinhood-fee-policy', { recipient, chainId: ROBINHOOD.id, verified: true, updatedAt: Date.now() }); return recipient;
  }
}
