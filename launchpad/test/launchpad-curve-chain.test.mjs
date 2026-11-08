import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID} from '@solana/spl-token';
import {LaunchChain,ray,decodeRay,rayCurveAtTarget,rayCurveForLaunch,newLaunchKeys} from '../src/launchpad-chain.mjs';
import {launchInput,LAUNCH_CURVE_POLICY,SOL_MINT,USDC_MINT} from '../public/launchpad-model.mjs';
import {creatorFeeForLaunch} from '../public/creator-fee-schedule.mjs';

const fixture=JSON.parse(await readFile(new URL('./launchpad-accounts.json',import.meta.url),'utf8'));
const pk=value=>new PublicKey(value);
const cpId='D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2';
function harness({historical=false,tax=0,quote=SOL_MINT}={}) {
  const quoteDecimals=quote===SOL_MINT?9:6,price=quote===SOL_MINT?'150':'1';
  const configAccount={...fixture.rayConfig.account,owner:pk(fixture.rayConfig.account.owner),data:Buffer.from(fixture.rayConfig.account.data[0],'base64')};
  pk(quote).toBuffer().copy(configAccount.data,ray.LaunchpadConfig.offsetOf('mintB'));
  if(quote!==SOL_MINT) configAccount.data.writeBigUInt64LE(1n,ray.LaunchpadConfig.offsetOf('minFundRaisingB'));
  const config=decodeRay(configAccount,ray.LAUNCHPAD_PROGRAM,ray.LaunchpadConfig,'GlobalConfig');
  const cpData=Buffer.alloc(ray.CpmmConfigInfoLayout.span);
  createHash('sha256').update('account:AmmConfig').digest().copy(cpData,0,0,8);
  cpData.writeBigUInt64LE(2500n,ray.CpmmConfigInfoLayout.offsetOf('tradeFeeRate'));
  cpData.writeBigUInt64LE(5000n,ray.CpmmConfigInfoLayout.offsetOf('creatorFeeRate'));
  const cpAccount={owner:ray.CREATE_CPMM_POOL_PROGRAM,data:cpData};
  const input=launchInput({name:'Launchpad target',symbol:'TEST',feeMode:tax?'holders':'creator',taxPercent:String(tax),quoteMint:quote,targetUsd:'20000'}, {marketCapPolicy:historical?'historical':'public'});
  const fee=creatorFeeForLaunch(input);input.creatorFeeBps=fee.ratePpm/100;input.creatorFeePolicy=fee.policy;
  input.protocolFees={curveFeeBps:100,lpPolicy:'platform_locked',platformLpPercent:75};
  const chain=new LaunchChain({network:'mainnet-beta',connection:{
    getAccountInfo:async key=>key.toBase58()===fixture.rayConfig.pubkey?configAccount:cpAccount,
    getProgramAccounts:async program=>program.equals(ray.LAUNCHPAD_PROGRAM)?[{pubkey:pk(fixture.rayConfig.pubkey),account:configAccount}]:[{pubkey:pk(cpId),account:cpAccount}]
  }});
  chain.mintInfo=async()=>({key:pk(quote),program:TOKEN_PROGRAM_ID,mint:{decimals:quoteDecimals,freezeAuthority:null,tlvData:Buffer.alloc(0)},extensions:[]});
  chain.referencePrice=async()=>({usd:price});
  chain.fundingEstimate=async()=>({minimumSol:'0.06',platformRent:'15000000'});
  chain.devBuyEstimate=async()=>({gross:'0',net:'0',solBudget:'0'});
  return {chain,input,config,price,quoteDecimals};
}

test('new real-chain previews and encoded launch instructions use the reviewed lower curve with fees and taxes intact',async()=>{
  for(const quote of [SOL_MINT,USDC_MINT]) for(const tax of [0,1,3]) {
    const h=harness({tax,quote}),review=await h.chain.preview(h.input);
    assert.equal(review.curvePolicy,LAUNCH_CURVE_POLICY);
    assert.equal(review.graduationTargetUsd,'50000');
    assert(Math.abs(Number(review.actualUsd)-20000)<0.01);
    assert(Math.abs(Number(review.graduationUsd)-50000)<0.01);
    assert.equal(review.platformFeeBps,100);
    assert.equal(review.creatorFeeBps,tax?0:50);
    assert.match(review.lp,/75%.*locked.*25%.*burned/);
    const launch={input:h.input,review,keys:newLaunchKeys(),uri:'https://example.com/token.json'};
    await h.chain.preflightLaunch(launch);
    const ix=(await h.chain.launchInstructions(launch,'create'))[0];
    assert(ix.keys.some(key=>key.pubkey.equals(tax?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID)));
    assert(ix.keys.some(key=>key.pubkey.equals(pk(quote))));
    let at=9;for(let i=0;i<3;i++)at+=4+ix.data.readUInt32LE(at);
    assert.equal(ix.data[at++],0);
    assert.equal(ix.data.readBigUInt64LE(at),BigInt(review.supply));at+=8;
    assert.equal(ix.data.readBigUInt64LE(at),BigInt(review.sell));at+=8;
    assert.equal(ix.data.readBigUInt64LE(at),BigInt(review.raise));at+=8;
    assert.equal(ix.data[at],1);
    const before=structuredClone(launch.review);
    launch.review.sell=String(BigInt(review.sell)+1n);
    await assert.rejects(h.chain.preflightLaunch(launch),/configuration changed/);
    launch.review=before;launch.review.graduationTargetUsd='80000';
    await assert.rejects(h.chain.preflightLaunch(launch),/policy differs/);
  }
});

test('saved legacy chain reviews retain the exact original curve and reject silently relabeled policies',async()=>{
  const h=harness({historical:true}),review=await h.chain.preview(h.input);
  const legacy=rayCurveAtTarget(h.config,h.quoteDecimals,h.price,h.input.targetUsd);
  for(const field of ['sell','raise','supply','virtualBase','virtualQuote'])assert.equal(review[field],legacy[field]);
  assert.equal(review.curvePolicy,undefined);
  assert.equal(BigInt(review.sell)*100n/BigInt(review.supply),80n);
  const launch={input:h.input,review};
  await h.chain.preflightLaunch(launch);
  launch.review.curvePolicy=LAUNCH_CURVE_POLICY;launch.review.graduationTargetUsd='75000';
  await assert.rejects(h.chain.preflightLaunch(launch),/policy differs/);
});

test('unknown or partial persisted curve policies fail closed instead of selecting a different curve',()=>{
  const h=harness();
  for(const fields of [{curvePolicy:'unknown'}, {graduationTargetUsd:'80000'}, {curvePolicy:null}, {graduationTargetUsd:null}]) {
    assert.throws(()=>rayCurveForLaunch(h.config,h.quoteDecimals,h.price,{...h.input,...fields}),/policy is invalid/);
  }
});
