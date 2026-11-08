import test from 'node:test';
import assert from 'node:assert/strict';
import {launchInput,socialLink} from '../public/launchpad-model.mjs';

const input=extra=>launchInput({name:'Rewards',symbol:'RWD',feeMode:'holders',...extra});
test('new launch input cannot override the platform holder reward minimum',()=>{
  for(const value of ['',null,'0','.00000001','10.25','10000000','NaN','Infinity',{},false])assert.equal(input({holderRewardMinimum:value,minimumUsd:1,holderRewards:{minimumQuoteUnits:'1'}}).holderRewardMinimum,'');
});
test('creator fees and buybacks never inherit a holder minimum',()=>{
  for(const feeMode of ['creator','buyback'])assert.equal(input({feeMode,holderRewardMinimum:'0.1'}).holderRewardMinimum,'');
});

test('new public and admin holder launches default to 2% and enforce 1–3% on both boundaries',()=>{
  const raw={name:'Rewards',symbol:'RWD',feeMode:'holders'};
  for(const marketCapPolicy of ['public','admin']){
    assert.equal(launchInput(raw,{marketCapPolicy}).taxBps,200);
    for(const taxPercent of ['1','1.5','2','2.5','3'])assert.equal(launchInput({...raw,taxPercent},{marketCapPolicy}).taxBps,Number(taxPercent)*100);
    for(const taxPercent of ['0','0.5','0.99','3.01','4','5','5.01'])assert.throws(()=>launchInput({...raw,taxPercent},{marketCapPolicy}),/between 1% and 3%/);
    for(const taxPercent of ['-2','2.001','NaN','Infinity',''])assert.throws(()=>launchInput({...raw,taxPercent},{marketCapPolicy}));
    for(const feeMode of ['creator','buyback'])assert.equal(launchInput({...raw,feeMode},{marketCapPolicy}).taxBps,0);
  }
});

test('historical holder launch parsing preserves original 0%, 1% and 5% taxes',()=>{
  for(const taxPercent of ['0','1','1.2','5'])assert.equal(input({taxPercent}).taxBps,Number(taxPercent)*100);
  assert.equal(input({}).taxBps,0);
});

// v71.25: an @handle used to be saved as https://examplecoin/ (a host without a dot) and kept in the coin metadata.
test('new launch input turns X and Telegram handles into profile links and refuses addresses without a dotted host',()=>{
  const links=extra=>launchInput({name:'Links',symbol:'LNK',feeMode:'creator',...extra}).links;
  assert.deepEqual(links({twitter:'@examplecoin',telegram:'@example_chat',website:'examplecoin.com'}),{twitter:'https://x.com/examplecoin',telegram:'https://t.me/example_chat',website:'https://examplecoin.com/'});
  assert.deepEqual(links({twitter:'examplecoin',telegram:'https://@example_chat'}),{twitter:'https://x.com/examplecoin',telegram:'https://t.me/example_chat'});
  assert.deepEqual(links({twitter:'x.com/examplecoin',telegram:'https://t.me/+AbCdEf'}),{twitter:'https://x.com/examplecoin',telegram:'https://t.me/+AbCdEf'});
  assert.deepEqual(links({website:' ',twitter:''}),{});
  for(const [field,value,message] of [['website','examplecoin',/website as an https:\/\/ address with a domain/],['website','https://examplecoin/',/website/],['website','http://examplecoin.com',/website/],['website','https://user:pass@examplecoin.com',/website/],['twitter','@example coin',/X as @handle/],['twitter','@this_handle_is_too_long',/X as @handle/],['telegram','@abc',/Telegram as @username/]])
    assert.throws(()=>links({[field]:value}),message,field+' '+value);
  assert.equal(socialLink('twitter','@examplecoin'),'https://x.com/examplecoin');assert.equal(socialLink('website',''),'');
  assert.throws(()=>socialLink('website','a'.repeat(190)+'.example.com'),/at most 200 characters/);assert.equal(links({website:'a'.repeat(190)+'.example.com'}).website,'https://'+'a'.repeat(190)+'.example.com/','Raydium keeps its 300-character limit');
});

// v71.25: a Raydium description is stored on one line, as on the other venues (a line break used to be kept and
// shown as "Line one.Line two." wherever Launchpad lists coin text).
test('new launch input stores the description on one line: trimmed, line breaks and tabs as single spaces',()=>{
  const description=value=>launchInput({name:'Lines',symbol:'LNS',feeMode:'creator',description:value}).description;
  assert.equal(description('  Line one.\nLine two.\r\n\tLine three.  '),'Line one. Line two. Line three.');
  assert.equal(description('Tab\there  and there'),'Tab here and there');
  assert.equal(description('Bell\u0007 removed'),'Bell removed');
  assert.equal(description(undefined),'');
  assert.equal(description('🚀'.repeat(600)),'🚀'.repeat(500),'500 characters, never half an emoji');
  assert.equal(description('a'.repeat(499)+' b'),'a'.repeat(499),'no trailing space after the cut');
});

// v71.44: Paycheck is a holder-rewards launch funded by the flat 0.50% creator fee: no transfer tax, SOL pair only,
// Raydium only, and the saved input carries the policy so the server keeps its ledger.
test('Paycheck launch input: a holders launch with no tax, the paycheck-v1 policy and a SOL pair',()=>{
  const raw={name:'Paycheck',symbol:'PAY',feeMode:'paycheck'};
  for(const marketCapPolicy of ['public','admin','historical']){
    const value=launchInput(raw,{marketCapPolicy});
    assert.equal(value.feeMode,'holders');assert.equal(value.taxBps,0);assert.deepEqual(value.paycheck,{policy:'paycheck-v1'});assert.equal(value.quoteMint,'So11111111111111111111111111111111111111112');
    assert.equal(value.gotchiId,undefined);assert.equal(value.agentRequest,undefined);assert.equal(value.dailyGasLamports,'100000000','the holder-rewards gas budget');
    assert.equal(launchInput({...raw,taxPercent:'0'},{marketCapPolicy}).taxBps,0);
    assert.throws(()=>launchInput({...raw,taxPercent:'2'},{marketCapPolicy}),/Paycheck launches have no transfer tax/);
    assert.throws(()=>launchInput({...raw,quoteMint:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'},{marketCapPolicy}),/pair with SOL only/);
    assert.throws(()=>launchInput({...raw,gotchiId:'koi'},{marketCapPolicy}),/Gotchi pairing requires the Gotchi reward option/);
    assert.throws(()=>launchInput({...raw,route:'meteora'},{marketCapPolicy}),/Launches use Raydium/);
  }
  assert.equal(launchInput({...raw,feeMode:'holders',taxPercent:'2'},{marketCapPolicy:'public'}).paycheck,undefined,'an ordinary holders launch carries no Paycheck policy');
  const holders=launchInput({...raw,feeMode:'holders',paycheck:{policy:'paycheck-v1'}},{marketCapPolicy:'public'});
  assert.equal(holders.paycheck,undefined,'a caller cannot attach the policy to another mode');assert.equal(holders.taxBps,200);
  assert.equal(launchInput({...raw,feeMode:'creator',paycheck:{policy:'paycheck-v1'}},{marketCapPolicy:'public'}).paycheck,undefined);
});
