import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import {SOL_MINT} from '../public/launchpad-model.mjs';
import {AdminRevenueAudit,buildAdminRevenueAudit} from '../src/admin-revenue-audit.mjs';
const address=()=>Keypair.generate().publicKey.toBase58(),signature=n=>String(n).repeat(88),admin='a'.repeat(32),owner='b'.repeat(32),NOW=2_000_000;
function fixture(){
  const recipient=address(),prior=address(),wallet=address(),payer=address(),mint=address();
  const savedPolicy={recipient,recipientScope:'launchpad',creationFeeSol:'0.015',autoHarvest:true,lpPolicy:'platform_locked',platformLpPercent:75,liquidityPolicyVersion:1};
  const launch={id:'c'.repeat(32),curve:address(),authorizedAt:1,feeCustody:'relay',input:{route:'raydium',network:'mainnet-beta',name:'Coin',symbol:'COIN',quoteMint:SOL_MINT,feeMode:'creator',taxBps:0},keys:{wallet:{address:wallet,secret:'PRIVATE_SIGNER'},payer:{address:payer,external:true},mint:{address:mint,secret:'PRIVATE_MINT'}},review:{platformFeeBps:100,quoteDecimals:9,quoteSymbol:'SOL',protocolFees:{...savedPolicy}},operations:[{kind:'create',state:'confirmed',signature:signature(1),creationFeeReceipt:{mint:SOL_MINT,decimals:9,recipient,amount:'15000000'},raw:'SIGNED_RAW'},{kind:'protocol-payout',state:'confirmed',signature:signature(2),amount:'1000',payouts:[{owner:recipient,amount:'1000'}],receipt:{quoteDelta:'-1000',baseDelta:'0'}}],credits:{quote:'0',base:'0'}};
  const savedTreasury={wallet:{address:recipient,secret:'TREASURY_SECRET'},enabled:true,previousRecipients:[prior],pending:null};
  return {recipient,prior,wallet,payer,mint,launch,savedPolicy,savedTreasury,rows:[{accountId:owner,launch}],now:NOW};
}
test('read-only revenue report separates saved receipt totals from independent live verification and excludes secrets',()=>{
  const f=fixture(),before=structuredClone(f),report=buildAdminRevenueAudit(f),serialized=JSON.stringify(report);
  assert.equal(report.liveChainVerified,false);assert.equal(report.evidence,'saved-records');assert.equal(report.policy.creationFeeSol,'0.015');assert.equal(report.policy.curveFeeBps,100);assert.equal(report.policy.taxRevenueShareBps,500);
  assert.equal(report.summary.launches,1);assert.equal(report.summary.attentionCount,0);assert.equal(report.treasury.recipientMatches,true);
  assert.deepEqual(report.totals.map(row=>[row.kind,row.amount,row.decimals,row.receipts]),[['creation','15000000',9,1],['protocol-payout','1000',9,1]]);
  assert.equal(report.transfers[0].signature,signature(1));assert.equal(report.coins[0].quoteMint,SOL_MINT);assert.equal(report.coins[0].quoteDecimals,9);assert.equal(report.coins[0].baseDecimals,6);
  assert.doesNotMatch(serialized,/PRIVATE_|TREASURY_SECRET|SIGNED_RAW|"secret"|"raw"|"keys"/);assert.deepEqual(f,before);
});
test('receipt totals deduplicate cloned launches, retain old destinations, and never combine different assets',()=>{
  const f=fixture(),quote=address();f.launch.operations.push({kind:'protocol-lp-payout',state:'confirmed',signature:signature(3),amount:'25',baseAmount:'40',protocolRecipient:f.prior,receipt:{quoteDelta:'-25',baseDelta:'-40'}});
  const second=structuredClone(f.launch);second.id='d'.repeat(32);second.input.quoteMint=quote;second.review.quoteDecimals=6;second.review.quoteSymbol='QUOTE';second.operations=[{kind:'protocol-payout',state:'confirmed',signature:signature(4),amount:'200',payouts:[{owner:f.recipient,amount:'200'}],receipt:{quoteDelta:'-200',baseDelta:'0'}}];
  f.rows.push({accountId:owner,launch:structuredClone(f.launch)},{accountId:owner,launch:second});const report=buildAdminRevenueAudit(f);
  assert.equal(report.transfers.length,5);assert.equal(report.totals.find(row=>row.kind==='creation').receipts,1);
  assert(report.totals.some(row=>row.mint===f.mint&&row.amount==='40'&&row.decimals===6&&!row.currentRecipient));
  assert(report.totals.some(row=>row.mint===quote&&row.amount==='200'&&row.decimals===6));
  assert.deepEqual(report.issues.find(row=>row.code==='previous_recipient_history'),{code:'previous_recipient_history',scope:'history',count:2});
});
test('legacy policies, old missing receipts, pending transactions and collected credit remain visible without inventing income',()=>{
  const f=fixture();f.launch.review.platformFeeBps=0;f.launch.review.protocolFees={creationFeeSol:'0.015',autoHarvest:false};delete f.launch.feeCustody;delete f.launch.operations[0].creationFeeReceipt;
  f.launch.operations.push({kind:'protocol-claim',state:'pending',signature:signature(5),createdAt:1,raw:'PENDING_SECRET'});f.launch.protocolCredit='9';f.launch.protocolError='https://rpc.invalid/?secret=PRIVATE';
  const report=buildAdminRevenueAudit(f),coin=report.coins[0];
  assert.equal(report.summary.legacyLaunches,1);assert.equal(report.summary.untrackedCreationReceipts,1);assert.equal(report.summary.pendingOperations,1);assert.equal(report.transfers.length,1);
  for(const code of ['legacy_protocol_policy','legacy_burned_lp','protocol_signer_unavailable','automatic_collection_disabled','creation_history_untracked','pending_transaction','receipt_waiting','collected_awaiting_forward','collection_needs_attention'])assert(coin.issues.includes(code),code);
  assert.equal(coin.pending[0].signature,signature(5));assert.equal(coin.protocolCredit,'9');assert.doesNotMatch(JSON.stringify(report),/PENDING_SECRET|rpc.invalid|PRIVATE/);
});
test('zero-fee creation and unrelated drafts do not produce missing fee claims, and invalid ledgers are identified',()=>{
  const f=fixture();f.launch.review.protocolFees.creationFeeSol='0.00';delete f.launch.operations[0].creationFeeReceipt;f.launch.taxProtocol={policy:'wrong'};f.launch.protocolCredit='not-a-number';
  const draft=structuredClone(f.launch);delete draft.curve;draft.operations=[];f.rows.push({accountId:owner,launch:draft});
  const report=buildAdminRevenueAudit(f);assert.equal(report.summary.launches,1);assert.equal(report.summary.untrackedCreationReceipts,0);assert.equal(report.coins[0].protocolCredit,null);assert.equal(report.coins[0].taxProtocolCredit,null);
  assert(report.coins[0].issues.includes('invalid_tax_ledger'));assert(report.coins[0].issues.includes('invalid_protocol_ledger'));
});
test('treasury status reports unconfigured, disabled and mismatched settings explicitly',()=>{
  const empty=buildAdminRevenueAudit({now:NOW});assert.equal(empty.policy.configured,false);assert.equal(empty.treasury.configured,false);assert(empty.issues.some(row=>row.code==='recipient_unconfigured'));assert(empty.issues.some(row=>row.code==='treasury_unconfigured'));
  const f=fixture();f.savedTreasury.wallet.address=address();f.savedTreasury.pending={kind:'buy',state:'pending',signature:signature(6),createdAt:1,raw:'SECRET'};let report=buildAdminRevenueAudit(f);assert(report.issues.some(row=>row.code==='treasury_recipient_mismatch'));assert.equal(report.treasury.pending.signature,signature(6));
  f.savedTreasury.enabled=false;report=buildAdminRevenueAudit(f);assert(report.issues.some(row=>row.code==='treasury_automation_disabled'));
  f.savedPolicy.creationFeeSol='secret';f.savedPolicy.recipient='bad';f.savedPolicy.lpPolicy='bad';report=buildAdminRevenueAudit(f);assert.equal(report.policy.recipient,'');assert.equal(report.policy.creationFeeSol,null);assert.equal(report.policy.lpPolicy,'platform_locked');assert.equal(report.policy.platformLpPercent,75);
});
test('revenue report includes hidden and banned-owner history and rejects non-admin or revoked access with no writes',async()=>{
  const f=fixture();f.launch.moderation={hidden:true};f.launch.listArchive={archived:true};let actor={id:admin,role:'admin',mfaEnabled:true,banned:false},reads=0,checks=0;
  const accounts={get:async()=>{checks++;return {...actor};},list:async()=>[{id:owner,banned:true}],hostStore:{read:async name=>{reads++;return structuredClone(name==='launch-protocol-fees'?f.savedPolicy:f.savedTreasury);},write:async()=>assert.fail('must not write')},storeFor:()=>({read:async()=>({launches:[structuredClone(f.launch)]}),write:async()=>assert.fail('must not write')})};
  const service=new AdminRevenueAudit({accounts,now:()=>NOW});assert.equal((await service.read(admin)).summary.launches,1);assert.equal(checks,2);
  actor.role='user';const before=reads;await assert.rejects(service.read(admin),error=>error.statusCode===403);assert.equal(reads,before);
  actor.role='admin';actor.mfaEnabled=false;await assert.rejects(service.read(admin),error=>error.statusCode===403);actor.mfaEnabled=true;actor.banned=true;await assert.rejects(service.read(admin),error=>error.statusCode===403);
  actor.banned=false;accounts.storeFor=()=>({read:async()=>{actor.role='user';return{launches:[f.launch]};}});await assert.rejects(service.read(admin),error=>error.statusCode===403);
});
test('read-only report bounds account and operation history instead of silently truncating revenue',async()=>{
  const f=fixture(),accounts={get:async()=>({role:'admin',mfaEnabled:true}),list:async()=>[{id:owner}],hostStore:{read:async()=>null},storeFor:()=>({read:async()=>({launches:[f.launch]})})};
  await assert.rejects(new AdminRevenueAudit({accounts,maxAccounts:0}).read(admin),/account scan limit/);
  await assert.rejects(new AdminRevenueAudit({accounts,maxRecords:1}).read(admin),/record scan limit/);
});

test('one corrupt saved record cannot erase other retained payout receipts or leak its contents',()=>{
  const f=fixture(),broken=structuredClone(f.launch);broken.id='e'.repeat(32);broken.operations={data:'PRIVATE_OPERATION_DATA'};
  const partial=structuredClone(f.launch);partial.id='f'.repeat(32);partial.operations=[{kind:'protocol-payout',state:'confirmed',signature:signature(3),amount:'1',payouts:[null],receipt:{quoteDelta:'-1',baseDelta:'0'}},{...f.launch.operations[0],signature:signature(4)}];
  f.rows.push(null,{accountId:owner,launch:null},{accountId:owner,launch:broken},{accountId:owner,launch:partial});const report=buildAdminRevenueAudit(f);
  assert.equal(report.transfers.length,3);assert.equal(report.totals.find(row=>row.kind==='creation').receipts,2);assert.equal(report.totals.find(row=>row.kind==='protocol-payout').amount,'1000');assert(report.issues.some(row=>row.code==='invalid_revenue_history'));assert.doesNotMatch(JSON.stringify(report),/PRIVATE_OPERATION_DATA|"data"/);
});

test('tax awaiting conversion contributes attention and corrupt numbers or dates stay unavailable',()=>{
  const f=fixture();f.launch.input.taxBps=500;f.launch.credits.base='123';f.launch.taxProtocol={policy:'collected-tax-proceeds-v1',shareBps:500,harvestedBase:'123',sourceBaseCredit:'123',convertedBase:'0',convertedQuote:'0',holderQuote:'0',accruedQuote:'0',creditQuote:'0',paidQuote:'0',roundingRemainder:'0'};
  let report=buildAdminRevenueAudit(f);assert.equal(report.coins[0].taxBps,500);assert.equal(report.coins[0].taxSourceBaseCredit,'123');assert(report.coins[0].issues.includes('tax_conversion_pending'));assert.equal(report.summary.attentionCount,1);
  f.launch.taxProtocol.harvestedBase='1'.repeat(10000);f.launch.review.platformFeeBps=-1;f.launch.input.taxBps=10001;f.launch.operations.push({kind:'protocol-claim',state:'pending',createdAt:Number.MAX_SAFE_INTEGER,signature:signature(5)});f.now=Number.MAX_SAFE_INTEGER;report=buildAdminRevenueAudit(f);
  assert.equal(report.generatedAt,null);assert.equal(report.coins[0].pending[0].createdAt,null);assert.equal(report.coins[0].platformFeeBps,null);assert.equal(report.coins[0].taxBps,null);assert.equal(report.coins[0].taxSourceBaseCredit,null);assert(report.coins[0].issues.includes('invalid_tax_ledger'));assert(!report.coins[0].issues.includes('receipt_waiting'));
  assert(report.coins[0].issues.includes('invalid_fee_policy'));assert.equal(report.summary.legacyLaunches,0);
});

test('unreadable account listings fail with fixed diagnostic text and null launch records stay labeled incomplete',async()=>{
  const accounts={get:async()=>({role:'admin',mfaEnabled:true}),list:async()=>({secret:'PRIVATE_ACCOUNT_DATA'}),hostStore:{read:async()=>null},storeFor:()=>({read:async()=>({launches:[null]})})};
  await assert.rejects(new AdminRevenueAudit({accounts}).read(admin),error=>error.statusCode===503&&error.message==='Saved account history could not be read.');accounts.list=async()=>[{id:owner}];const report=await new AdminRevenueAudit({accounts}).read(admin);assert.equal(report.summary.launches,0);assert(report.issues.some(row=>row.code==='invalid_revenue_history'));
});
