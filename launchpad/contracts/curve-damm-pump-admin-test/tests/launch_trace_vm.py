"""Full mint + metadata + native dev-buy trace regression against real venues.

Local synthetic accounts only. Real admin secret unavailable, so owner and
relayer signer flags are verified by the program, with fixture signatures skipped.
Uses the runtime default 64 trace entries; no compute-budget override of trace.
"""
import importlib.util,pathlib,json,subprocess,base64,hashlib,struct
from solders.transaction import VersionedTransaction
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('admin_vm',HERE/'admin_test_vm.py');a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a);h=a.h
BRIDGE=HERE/'launch_trace_fixture.mjs';MPL=h.P('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
class Scenario(a.Scenario):
 def __init__(self,mode='test',wrapped=None):
  self.mode=mode
  super().__init__(native=True)
  self.vm.with_log_bytes_limit(100000)
  self.vm.warp_to_slot(10)
  row=json.loads((h.FIXTURES/'metaplex.json').read_text());elf=(h.FIXTURES/row['file']).read_bytes();assert hashlib.sha256(elf).hexdigest()==row['sha256'];self.vm.add_program(MPL,elf)
  self.base=h.Pubkey.create_with_seed(h.ADMIN,'curve-000000000000000000000000',h.TOKEN)
  self.params.update(mint=str(self.base),mintSeed='curve-000000000000000000000000',quoteUsdMicros='119000000')
  self.load_builders()
  if wrapped is not None:
   target=h.ata(h.ADMIN,h.WSOL)
   r=self.send([h.ata_ix(h.CREATOR.pubkey(),h.ADMIN,h.WSOL)])
   assert r['ok'],r
   if wrapped:
    r=self.send([h.transfer(h.TransferParams(from_pubkey=h.CREATOR.pubkey(),to_pubkey=target,lamports=wrapped)),h.ix(h.TOKEN,b'\x11',[h.meta(target,True)])]);assert r['ok'],r
 def build(self,**extra):
  account=self.vm.get_account(h.ata(h.ADMIN,h.WSOL));nativeBefore={'owner':str(account.owner),'lamports':account.lamports,'data':base64.b64encode(account.data).decode()} if account else None
  data={**self.params,'mode':self.mode,'nativeBefore':nativeBefore,'mintRent':self.vm.minimum_balance_for_rent_exemption(82),'nativeRent':self.vm.minimum_balance_for_rent_exemption(165),'blockhash':str(self.vm.latest_blockhash()),'slot':self.vm.get_clock().slot,**extra}
  r=subprocess.run(['node',str(BRIDGE)],input=json.dumps(data),text=True,capture_output=True)
  if r.returncode:raise Exception(r.stderr)
  return json.loads(r.stdout)
 def send_owner(self,built):
  table=built['lookupTable'];addresses=b''.join(bytes(h.P(k)) for k in table['addresses'])
  # Frozen, active ALT account encoding. Its entries are the production builder's exact list.
  data=struct.pack('<IQQBBH',1,(1<<64)-1,0,0,0,0).ljust(56,b'\0')+addresses
  self.vm.set_account(h.P(table['key']),h.Account(10000000,data,h.P('AddressLookupTab1e1111111111111111111111111')))
  tx=VersionedTransaction.from_bytes(base64.b64decode(built['wire']));self.vm.with_sigverify(False)
  try:r=h.outcome(self.vm.send_transaction(tx))
  finally:self.vm.with_sigverify(True)
  r['invokeCount']=sum(' invoke [' in l for l in r['logs']);r['packetBytes']=built['packetBytes'];return r

def run():
 results=[]
 for mode in ['test','public']:
  if mode=='public':
   h.PROGRAM=h.P('5F4tt5fQwSR9ymzx5KiYL4Q2Ln8FJxbMfbXD1HhMgUrw');h.BINARY=HERE.parent.parent/'curve-damm-pump-fee/artifacts/curve_damm_pump_fee.so';a.FIXTURE=HERE.parent.parent/'curve-damm-pump-fee/tests/damm_fixture.mjs'
  seed=Scenario(mode);init=seed.build();r=seed.send_owner(init);assert r['ok'],r
  pool=base64.b64encode(seed.vm.get_account(seed.a['dammPool']).data).decode()
  for variant,wrapped in [('legacy-ata',None),('legacy-ata',0),('legacy-ata',20000000),('production',0),('production',20000000)]:
   s=Scenario(mode,wrapped);built=s.build(pool=pool,amountRaw='10000000',variant=variant,name='N'*32,symbol='S'*10,creationFee='100000000' if mode=='public' else '0');before=s.snapshot();r=s.send_owner(built)
   if wrapped is None:
    assert not r['ok'] and 'MaxInstructionTraceLengthExceeded' in r['error'] and '(10,' in r['error'],r
    assert before==s.snapshot(),'failed transaction leaked state'
   else:
    assert r['ok'],r
    assert built['packetBytes']<=1232,'production packet exceeds 1232bytes'
    assert r['invokeCount']<=62,'launch exceeds reviewed trace margin'
    assert h.amount(s.vm,h.ata(h.ADMIN,h.WSOL))==wrapped,'existing WSOL balance changed'
    assert h.amount(s.vm,h.ata(h.ADMIN,s.base))>=int(built['trade']['minimum'])>0,'reviewed dev-buy tokens missing'
   results.append({'mode':mode,'variant':variant,'wrappedBeforeRaw':wrapped,**r});print(mode,variant,wrapped,json.dumps({k:v for k,v in r.items() if k!='logs'}))
  s=Scenario(mode,20000000);built=s.build(pool=pool,amountRaw='10000000',variant='production',name='N'*32,symbol='S'*10,forceSlippageFailure=True)
  before=s.snapshot();r=s.send_owner(built)
  assert not r['ok'] and 'MaxInstructionTraceLengthExceeded' not in r['error'] and before==s.snapshot(),r
  assert s.vm.get_account(s.base) is None,'failed dev buy left launched mint'
  assert h.amount(s.vm,h.ata(h.ADMIN,h.WSOL))==20000000,'failed dev buy spent wrapped SOL'
  results.append({'mode':mode,'variant':'production-slippage-rollback',**r});print(mode,'slippage rollback',json.dumps({k:v for k,v in r.items() if k!='logs'}))
 report={'broadcast':False,'realFundsUsed':False,'amountSol':'0.01','quoteUsd':'119','defaultMaxInstructionTraceLength':64,'results':results}
 (HERE.parent/'launch-trace-vm-results.json').write_text(json.dumps(report,indent=2)+'\n')
 return report
if __name__=='__main__':run()
