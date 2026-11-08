import { MAX_DEV_TOKENS, requireValue as ok } from '../public/launchpad-model.mjs';

export const MAX_DEVELOPER_BUY_RAW = MAX_DEV_TOKENS * 1000000n;

// quoteCost returns the exact gross pairing-token debit for a gross curve-token
// amount, including protocol/creator/quote-transfer fees. The slippage allowance
// is reserved inside the user's budget, never added to their SOL spend limit.
export function invertDeveloperBudget({quoteBudget,quoteCost,taxBps=0,slippageBps=100,maxGross=MAX_DEVELOPER_BUY_RAW}) {
  let budget,cap;
  ok(typeof quoteBudget!=='number'||Number.isSafeInteger(quoteBudget),'Developer buy has an invalid budget.');
  ok(typeof maxGross!=='number'||Number.isSafeInteger(maxGross),'Developer buys are limited to 100 million tokens.');
  try { budget=BigInt(quoteBudget);cap=BigInt(maxGross); } catch { throw Error('Developer buy has an invalid budget.'); }
  ok(budget>=0n&&budget<=18446744073709551615n,'Developer buy has an invalid budget.');
  ok(cap>0n&&cap<=MAX_DEVELOPER_BUY_RAW,'Developer buys are limited to 100 million tokens.');
  ok(Number.isInteger(taxBps)&&taxBps>=0&&taxBps<10000,'Developer buy has an invalid transfer tax.');
  ok(Number.isInteger(slippageBps)&&slippageBps>=0&&slippageBps<=1000,'Developer buy has an invalid slippage allowance.');
  ok(typeof quoteCost==='function','Developer-buy curve pricing is unavailable.');
  if(budget===0n)return{gross:'0',net:'0',maxQuote:'0',estimatedQuote:'0',quoteBudget:'0'};
  const quotes=new Map();
  const price=gross=>{
    if(gross===0n)return{estimated:0n,maximum:0n};
    if(quotes.has(gross))return quotes.get(gross);
    const estimated=quoteCost(gross);ok(typeof estimated==='bigint'&&estimated>0n,'Developer-buy curve returned an invalid price.');
    const maximum=(estimated*BigInt(10000+slippageBps)+9999n)/10000n;
    const result={estimated,maximum};quotes.set(gross,result);return result;
  };
  const ceiling=price(cap);
  if(budget>ceiling.maximum)throw Object.assign(Error('This amount exceeds the developer-buy limit of 10% of supply (100 million tokens). Reduce the SOL amount.'),{code:'DEV_BUY_SUPPLY_CAP',maxQuoteBudget:ceiling.maximum.toString(),maxGross:cap.toString()});
  let low=0n,high=cap;
  while(low<high){const middle=(low+high+1n)/2n;if(price(middle).maximum<=budget)low=middle;else high=middle-1n;}
  const gross=low,net=gross-(gross*BigInt(taxBps)+9999n)/10000n;
  ok(net>0n,'The developer-buy amount is too small to receive tokens. Increase the SOL amount.');
  const quote=price(gross);
  return{gross:gross.toString(),net:net.toString(),maxQuote:quote.maximum.toString(),estimatedQuote:quote.estimated.toString(),quoteBudget:budget.toString()};
}
