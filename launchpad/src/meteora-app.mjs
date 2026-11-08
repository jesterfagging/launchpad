import { MeteoraService } from './meteora-service.mjs';
import { MeteoraChainAdapter } from './meteora-chain.mjs';
import { meteoraCurveConfig } from './meteora-policy.mjs';
import { MeteoraQuoteCatalogue, readMeteoraQuotePrices } from './meteora-quotes.mjs';
import { createPublicFetcher } from './telegram-network.mjs';
import { readCustomPairs } from './launchpad-custom-pairs.mjs';
import { launchProtocolPolicy } from './launchpad-protocol-fees.mjs';
import { launchpadEnv } from './brand-env.mjs';
import { units } from '../public/launchpad-model.mjs';

export function createMeteoraIntegration({ accounts, launches, discovery, requireOwner, publishMetadata, rpcUrl, rpcGate, gotchiTarget = null, agentTarget = null }) {
  // Reward baskets (v71.33) convert through Jupiter with the operator's key (LAUNCHPAD_PUBLIC_JUPITER_KEY), as every other conversion does.
  const adapter = new MeteoraChainAdapter({ rpcUrl, rpcGate, jupiterKey: launchpadEnv('PUBLIC_JUPITER_KEY') || '' });
  const network = createPublicFetcher();
  const getTreasury = async () => {
    const policy = await launchProtocolPolicy(accounts);
    return policy.recipient;
  };
  const quotePrice = async (mint, info) => {
    const chain = await discovery.chain();
    const price = await chain.referencePrice({ quoteMint:mint }, info || await chain.mintInfo(mint));
    return { ...price, mint };
  };
  const quotes = new MeteoraQuoteCatalogue({
    catalogue: launches.quoteCatalogue,
    customAssets: async () => (await readCustomPairs(accounts)).assets,
    connection: adapter.connection,
    price: (asset, info) => quotePrice(asset.mint, info),
    priceBatch: (assets, accounts) => readMeteoraQuotePrices(assets, accounts, { fetcher:network.fetcher }),
    migrationCheck: check => adapter.migrationCheck(check),
    curveCheck: input => meteoraCurveConfig(input),
    store: accounts.hostStore,
  });
  const pairReadiness = async () => {
    const result = await quotes.list({ includeUnavailable:true, limitChecks:0 });
    return { ...result.counts, checked:result.checked, total:result.total, running:result.running, complete:result.ready === true };
  };
  const service = new MeteoraService({ accounts, requireOwner, adapter,
    getTreasury, getQuotePrice:quotePrice, publishMetadata,
    getCreationFee: async () => {
      const recipient = await getTreasury(), policy = await launchProtocolPolicy(accounts);
      return { lamports:units(policy.creationFeeSol || '0', 9).toString(), recipient };
    },
    quoteEligibility: async mint => {
      const [asset, check] = await Promise.all([
        quotes.assets().then(assets => assets.find(asset => asset.mint === mint)),
        quotes.status(mint, { fresh:true }),
      ]);
      return { ...asset, ...check };
    },
    listPairs: async () => (await quotes.list({ limitChecks:0 })).assets,
    pairReadiness, gotchiTarget, agentTarget,
  });
  let sweep = null, timer = null, closed = false;
  const warm = ({ force = false } = {}) => {
    if (closed || sweep) return sweep;
    sweep = Promise.resolve().then(async () => {
      // Installing an update must not add a catalogue-wide network workload to
      // a host that has not opted into Meteora setup yet.
      if (!(await accounts.hostStore.read('meteora-launches', null))?.config) return null;
      const previous = await quotes.sweepStatus();
      return quotes.fullSweep({ force:force || previous.counts?.pending > 0 });
    }).catch(() => null).finally(() => { sweep = null; });
    return sweep;
  };
  return { service, quotes, adapter, warm,
    start() { closed = false; service.start(); void warm(); timer ||= setInterval(() => { void warm(); }, 300000); timer.unref?.(); },
    async stop() { closed = true; clearInterval(timer); timer = null; network.close(); await service.stop(); await quotes.close(); await sweep; },
  };
}
