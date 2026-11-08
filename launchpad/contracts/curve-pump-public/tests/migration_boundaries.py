"""Targeted actual-PumpSwap LP burn proof over SOL price boundaries and churn.
No RPC, real funds, key export or live transaction broadcast.
"""
import hashlib,importlib.util,json,math,pathlib
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('public_vm',ROOT/'tests/public_vm.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def ceil(a,b):return (a+b-1)//b

def run():
 scenarios=[];checks=0
 for price in [1_000_000,1_000_001,25_000_000,200_000_000,1_000_000_000,100_000_000_000]:
  s=m.Scenario(price=price);assert s.init['ok'],(price,s.init)
  for key in [m.CREATOR.pubkey(),m.USER.pubkey()]:s.vm.airdrop(key,100_000_000_000_000)
  initial=s.saved();raise_quote=ceil(initial['vq']*m.CAP,m.VB-m.CAP);trace=[]
  def trade(buy,amount,trader):
   nonlocal checks
   before=s.saved();tb=s.vm.get_account(m.TREASURY).lamports;cp=m.u64(s.data(),280);credit=m.u64(s.data(),272)
   r=s.buy(amount,trader=trader) if buy else s.sell(amount,trader=trader);assert r['ok'],(price,'buy' if buy else 'sell',r)
   after=s.saved();net=after['quote']-before['quote'] if buy else before['quote']-after['quote']
   gross=ceil(net*10000,9850) if buy else net;fee=gross-net if buy else ceil(gross*150,10000);creator=gross*50//10000
   assert s.vm.get_account(m.TREASURY).lamports-tb==fee-creator
   assert m.u64(s.data(),280)-cp+m.u64(s.data(),272)-credit==creator
   assert after['vb']==m.VB-after['sold'] and after['vq']==initial['vq']+after['quote']
   assert s.vm.get_account(s.auth).lamports>=after['quote']+m.u64(s.data(),152)
   trace.append({'side':'buy' if buy else 'sell','input':str(amount),'reserveDelta':str(net),'protocolFee':str(fee-creator),'creatorFee':str(creator)})
   checks+=5
  trade(True,max(1,raise_quote//40),m.USER)
  trade(True,max(1,raise_quote//25),m.CREATOR)
  trade(False,m.token_amount(s.vm,s.otheruser)//2,m.USER)
  trade(True,max(1,raise_quote//15),m.USER)
  trade(False,m.token_amount(s.vm,s.user)//4,m.CREATOR)
  trade(True,raise_quote*2,m.CREATOR)
  assert s.saved()['phase']==1 and s.saved()['sold']==m.CAP
  quote=s.saved()['quote'];fee=ceil(quote*2885,10000);expected_quote=quote-fee;expected_base=m.SUPPLY-m.CAP;treasury=s.vm.get_account(m.TREASURY).lamports;creator=s.vm.get_account(m.CREATOR.pubkey()).lamports
  result=s.migrate();assert result['ok'],(price,result)
  # Three independent observations: completed onchain receipt; actual received
  # token-account balance; total LP mint supply is zero after the burn.
  burned=s.saved()['lpBurned'];lp_data=s.vm.get_account(s.lp).data;remaining_lp=m.u64(lp_data,36);expected_total=math.isqrt(expected_base*expected_quote)
  assert s.saved()['phase']==2 and s.saved()['quote']==0 and burned>0
  assert m.token_amount(s.vm,s.lpata)==0
  assert remaining_lp==0 and expected_total-burned==100, (price,burned,remaining_lp,expected_total)
  assert m.token_amount(s.vm,s.pb)==expected_base and m.token_amount(s.vm,s.pq)==expected_quote
  assert s.vm.get_account(m.TREASURY).lamports-treasury==fee and s.saved()['graduationFee']==fee
  assert quote==m.token_amount(s.vm,s.pq)+s.saved()['graduationFee']
  assert s.vm.get_account(m.CREATOR.pubkey()).lamports==creator
  assert s.vm.get_account(s.lpata).data[32:64]==bytes(s.auth)
  # Repeat must not burn a second time, pay the graduation fee twice or alter LP.
  snapshot=s.snapshot();again=s.migrate();assert again['ok'] and s.snapshot()==snapshot
  checks+=10
  scenarios.append({'solUsdMicros':str(price),'trades':trace,'accountedQuoteAtGraduation':str(quote),'graduationFee':str(fee),'poolQuote':str(expected_quote),'poolBase':str(expected_base),'receivedLpBurned':str(burned),'remainingLpMintSupply':str(remaining_lp),'unmintedMinimumLpAtoms':str(expected_total-burned),'creatorLpBalance':'0','migrationComputeUnits':result['units'],'checks':40,'passed':True})
 return {'realFundsUsed':False,'programSha256':hashlib.sha256(m.OUR_BINARY.read_bytes()).hexdigest(),'pumpSha256':hashlib.sha256(m.PUMP_BINARY.read_bytes()).hexdigest(),'scope':'Six price boundary scenarios, partial buy/sell churn, exact fee conservation, LP account and supply burn evidence, idempotent migration','checkCount':checks,'scenarioCount':len(scenarios),'scenarios':scenarios}
if __name__=='__main__':
 report=run();(ROOT/'migration-boundary-results.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items() if k!='scenarios'},indent=2))
