export const CHAIN_IDS = Object.freeze(['solana', 'robinhood']);
export function chainName(value = 'solana') {
  if (!CHAIN_IDS.includes(value)) throw Error('Choose Solana or Robinhood Chain.');
  return value;
}
export const ROBINHOOD = Object.freeze({ id: 4663, name: 'Robinhood Chain', currency: 'ETH', rpc: 'https://rpc.mainnet.chain.robinhood.com', explorer: 'https://robinhoodchain.blockscout.com' });
export const EVM_NATIVE = '0x0000000000000000000000000000000000000000';
export const TOOL_NAMES = Object.freeze({ copy: 'Copytrading', sniper: 'Launch Sniping', liquidity: 'LP Management', market: 'Market Making' });
export function chainToolHref(chain, tool = 'terminal') {
  const base = chainName(chain) === 'robinhood' ? '/robinhood' : '/trade';
  return Object.hasOwn(TOOL_NAMES, tool) ? `${base}?tool=${encodeURIComponent(tool)}` : tool === 'funding' ? `/funding?chain=${chain}` : base;
}

// v71.43: the page says whether Robinhood Chain is on this host (<body data-robinhood="on|off">, written by the server).
export const robinhoodEnabled = document => document?.body?.dataset?.robinhood !== 'off';
