import { requireValue as ok } from '../public/launchpad-model.mjs';
import { launchProtocolPolicy } from './launchpad-protocol-fees.mjs';
import { TAX_CONVERSION_BACKLOG_UNITS, TAX_CONVERSION_BURST_POLICY } from './launchpad-tax-conversion.mjs';

// This is a share of realized transfer-tax proceeds, never percentage points
// added to a token's transfer tax or a share of creator/LP fees.
export const TAX_PROTOCOL_POLICY = 'collected-tax-proceeds-v1';
export const TAX_PROTOCOL_SHARE_BPS = 500;
const fields = ['harvestedBase','sourceBaseCredit','convertedBase','burnedBase','convertedQuote','holderQuote','accruedQuote','creditQuote','paidQuote','roundingRemainder','handoffBaseLoss','handoffQuoteLoss'];
const amount = value => { ok(typeof value==='string'&&/^\d+$/.test(value),'Invalid transfer-tax fee ledger.');return BigInt(value); };
export const hasTransferTax = l => l.input.route==='raydium'&&l.input.feeMode==='holders'&&Number(l.input.taxBps)>0;

export function taxProtocolLedger(l) {
  const value=l.taxProtocol;
  if(!value)return {policy:TAX_PROTOCOL_POLICY,shareBps:TAX_PROTOCOL_SHARE_BPS,...Object.fromEntries(fields.map(k=>[k,'0']))};
  ok(value.policy===TAX_PROTOCOL_POLICY&&value.shareBps===TAX_PROTOCOL_SHARE_BPS,'Unknown transfer-tax fee policy.');
  const normalized={handoffBaseLoss:'0',handoffQuoteLoss:'0',burnedBase:'0',...value};
  const n=Object.fromEntries(fields.map(k=>[k,amount(normalized[k])]));
  ok(n.harvestedBase===n.sourceBaseCredit+n.convertedBase+n.burnedBase+n.handoffBaseLoss&&n.convertedQuote===n.holderQuote+n.accruedQuote&&n.accruedQuote===n.creditQuote+n.paidQuote+n.handoffQuoteLoss&&n.roundingRemainder<10000n&&n.accruedQuote*10000n+n.roundingRemainder===n.convertedQuote*BigInt(TAX_PROTOCOL_SHARE_BPS),'Transfer-tax fee ledger invariant failed.');
  ok(n.sourceBaseCredit<=BigInt(l.credits.base),'Transfer-tax source exceeds earned base credit.');
  return normalized;
}

// Moving the earned inventory to its dedicated wallet can itself incur the
// mint's immutable transfer fee. Preserve historical harvest/conversion totals;
// this loss is neither a sale nor protocol revenue or a treasury payment.
export function recordTaxHandoffLoss(l,{baseLoss=0n,quoteLoss=0n}={}){
  const ledger=taxProtocolLedger(l),base=BigInt(baseLoss),quote=BigInt(quoteLoss);
  ok(base>=0n&&base<=BigInt(ledger.sourceBaseCredit)&&quote>=0n&&quote<=BigInt(ledger.creditQuote),'Reward handoff loss exceeds reserved tax credit.');
  ledger.sourceBaseCredit=(BigInt(ledger.sourceBaseCredit)-base).toString();ledger.handoffBaseLoss=(BigInt(ledger.handoffBaseLoss)+base).toString();
  ledger.creditQuote=(BigInt(ledger.creditQuote)-quote).toString();ledger.handoffQuoteLoss=(BigInt(ledger.handoffQuoteLoss)+quote).toString();
  return ledger;
}

export async function taxProtocolTreasury(accounts,l) {
  const policy=await launchProtocolPolicy(accounts);
  ok(policy.recipientScope==='launchpad','Configure a separate launchpad fee wallet before collecting transfer taxes.');
  ok(policy.recipient!==l.keys.wallet.address,'The launchpad fee wallet must differ from this launch fee wallet.');
  ok(policy.recipient!==l.keys.rewards?.address,'The launchpad fee wallet must differ from this launch rewards wallet.');
  return policy.recipient;
}

export function recordTaxHarvest(l,base) {
  ok(hasTransferTax(l),'Only collected transfer taxes can enter the tax protocol ledger.');
  const ledger=taxProtocolLedger(l),value=BigInt(base);ok(value>=0n,'Tax harvest cannot debit base tokens.');
  ledger.harvestedBase=(BigInt(ledger.harvestedBase)+value).toString();
  ledger.sourceBaseCredit=(BigInt(ledger.sourceBaseCredit)+value).toString();
  return ledger;
}

export function taxConversionSource(l) {
  const ledger=taxProtocolLedger(l),tax=BigInt(ledger.sourceBaseCredit);
  // Old mixed balances cannot be safely attributed. They remain holder credit
  // and never become protocol revenue; each new tax sale is isolated instead.
  return tax>0n?{credit:tax.toString(),operationData:{taxProtocolPolicy:TAX_PROTOCOL_POLICY,taxSource:'withheld-tax'}}:{credit:l.credits.base,operationData:{}};
}

// A backlog burst uses exactly the earned launch-base credit, with tax credit
// first. Ordinary/legacy earned tokens may fill the rest of the same swap but
// never become taxable proceeds merely because they share its transaction.
export function taxBacklogSource(l,value) {
  const requested=BigInt(value),base=amount(l.credits.base),ledger=taxProtocolLedger(l),tax=BigInt(ledger.sourceBaseCredit);
  ok(requested===TAX_CONVERSION_BACKLOG_UNITS&&requested<=base,'A reward backlog burst requires exactly ten million earned base tokens.');
  const tracked=tax<requested?tax:requested;
  if(tracked===0n)return {credit:requested.toString(),operationData:{}};
  ok(hasTransferTax(l),'Only collected transfer taxes can enter a reward backlog tax source.');
  if(tracked===requested)return {credit:requested.toString(),operationData:{taxProtocolPolicy:TAX_PROTOCOL_POLICY,taxSource:'withheld-tax'}};
  return {credit:requested.toString(),operationData:{taxProtocolPolicy:TAX_PROTOCOL_POLICY,taxSource:'mixed-earned',taxBaseUnits:tracked.toString(),ordinaryBaseUnits:(requested-tracked).toString()}};
}

export function recordMixedTaxConversion(l,op,base,quote) {
  ok(hasTransferTax(l)&&op.taxProtocolPolicy===TAX_PROTOCOL_POLICY&&op.taxSource==='mixed-earned'&&op.taxConversionPolicy===TAX_CONVERSION_BURST_POLICY,'The conversion is not an authorized mixed reward backlog sale.');
  const spent=BigInt(base),received=BigInt(quote),requested=amount(op.amount),tax=amount(op.taxBaseUnits),ordinary=amount(op.ordinaryBaseUnits);
  ok(spent===TAX_CONVERSION_BACKLOG_UNITS&&requested===spent&&received>0n&&tax>0n&&ordinary>0n&&tax+ordinary===spent,'Mixed reward backlog receipt differs from its exact saved source amounts.');
  const expected=taxBacklogSource(l,requested).operationData;
  ok(expected.taxSource==='mixed-earned'&&tax.toString()===expected.taxBaseUnits&&ordinary.toString()===expected.ordinaryBaseUnits,'Mixed reward backlog source differs from its confirmed earned credits.');
  const ledger=taxProtocolLedger(l),taxQuote=received*tax/spent;
  // Floor the proportional tax proceeds; all remaining realized quote belongs
  // to the ordinary source. Even a one-unit output may attribute zero to tax.
  // Preserve the existing cumulative fee remainder without inventing a fee.
  const numerator=taxQuote*BigInt(TAX_PROTOCOL_SHARE_BPS)+BigInt(ledger.roundingRemainder),share=numerator/10000n;
  ledger.sourceBaseCredit=(BigInt(ledger.sourceBaseCredit)-tax).toString();
  ledger.convertedBase=(BigInt(ledger.convertedBase)+tax).toString();
  ledger.convertedQuote=(BigInt(ledger.convertedQuote)+taxQuote).toString();
  ledger.holderQuote=(BigInt(ledger.holderQuote)+taxQuote-share).toString();
  ledger.accruedQuote=(BigInt(ledger.accruedQuote)+share).toString();
  ledger.creditQuote=(BigInt(ledger.creditQuote)+share).toString();
  ledger.roundingRemainder=(numerator%10000n).toString();
  return {ledger,holderQuote:received-share,protocolQuote:share,taxBase:tax,taxQuote,ordinaryQuote:received-taxQuote};
}

export function recordTaxConversion(l,op,base,quote) {
  const ledger=taxProtocolLedger(l),spent=BigInt(base),received=BigInt(quote);
  ok(hasTransferTax(l)&&op.taxProtocolPolicy===TAX_PROTOCOL_POLICY&&op.taxSource==='withheld-tax','The conversion is not an authorized transfer-tax sale.');
  ok(spent>0n&&spent<=BigInt(op.amount)&&spent<=BigInt(ledger.sourceBaseCredit)&&received>0n,'Tax conversion exceeds its confirmed source credit.');
  const numerator=received*BigInt(TAX_PROTOCOL_SHARE_BPS)+BigInt(ledger.roundingRemainder),share=numerator/10000n;
  ledger.sourceBaseCredit=(BigInt(ledger.sourceBaseCredit)-spent).toString();
  ledger.convertedBase=(BigInt(ledger.convertedBase)+spent).toString();
  ledger.convertedQuote=(BigInt(ledger.convertedQuote)+received).toString();
  ledger.holderQuote=(BigInt(ledger.holderQuote)+received-share).toString();
  ledger.accruedQuote=(BigInt(ledger.accruedQuote)+share).toString();
  ledger.creditQuote=(BigInt(ledger.creditQuote)+share).toString();
  ledger.roundingRemainder=(numerator%10000n).toString();
  return {ledger,holderQuote:received-share,protocolQuote:share};
}

export function recordTaxProtocolPayout(l,op,delta) {
  const ledger=taxProtocolLedger(l),paid=BigInt(op.amount);
  ok(op.taxProtocolPolicy===TAX_PROTOCOL_POLICY&&typeof op.taxProtocolRecipient==='string'&&op.payouts?.length===1&&op.payouts[0].owner===op.taxProtocolRecipient&&op.payouts[0].amount===op.amount,'Tax protocol payout destination differs from its saved transaction.');
  ok(paid>0n&&delta.quote===-paid&&delta.base===0n&&paid<=BigInt(ledger.creditQuote),'Tax protocol payout differs from its reserved credit.');
  ledger.creditQuote=(BigInt(ledger.creditQuote)-paid).toString();
  ledger.paidQuote=(BigInt(ledger.paidQuote)+paid).toString();
  return ledger;
}
