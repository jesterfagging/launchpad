"""Verify owner feature using a NEW PUBLIC FIXTURE KEY; never deploy that artifact."""
import importlib.util,json,os,pathlib,hashlib,struct
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('local_vm',ROOT/'tests/local_vm.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
FIXTURE=m.Keypair.from_seed(bytes([71])*32)
m.ADMIN=FIXTURE
BINARY=pathlib.Path(os.environ['LAUNCHPAD_OWNER_VERIFICATION_BINARY'])
config=json.loads((ROOT/'fixtures/micro-test-parameters.json').read_text())
results=[]
def check(ok,name,details=None):
 if not ok:raise AssertionError((name,details))
 results.append({'name':name,'passed':True})
def scenario(**kwargs):return m.Scenario(binary=BINARY,config=kwargs.pop('config',config),**kwargs)
def run():
 s=scenario(budget=20_000_000);check(s.init['ok'],'distinct owner initializes micro preset with minimum 0.02 SOL subsidy',s.init)
 bad=s.tradeix(True,1000000000,admin=m.OTHER.pubkey());before=s.snapshot();r=s.send([bad],[FIXTURE,m.OTHER]);check(not r['ok'] and s.snapshot()==before,'different signer cannot spend owner curve')
 original=m.ADMIN;m.ADMIN=m.Keypair.from_seed(bytes([99])*32)
 try:r=m.Scenario(binary=BINARY,config=config).init;check(not r['ok'],'public local-test operator cannot use owner executable',r)
 finally:m.ADMIN=original
 wrong=dict(config);wrong['virtualBaseRaw']=str(m.VB);wrong['tokensSoldAtGraduationRaw']=str(m.CAP);r=scenario(config=wrong).init;check(not r['ok'],'standard preset rejected by owner-only micro build')
 wrong=dict(config);wrong['virtualQuoteRaw']='10000000000';r=scenario(config=wrong).init;check(not r['ok'],'more than three SOL required principal rejected at initialization')
 r=scenario(budget=100000001).init;check(not r['ok'],'migration rent subsidy above 0.1 SOL rejected')
 old=m.GRAD;m.GRAD=2884
 try:check(not scenario().init['ok'],'graduation fee other than 2885 bps rejected')
 finally:m.GRAD=old
 old=m.TRADE;m.TRADE=101
 try:check(not scenario().init['ok'],'trading fee other than 100 bps rejected')
 finally:m.TRADE=old
 r=s.buy(10000000000);check(r['ok'] and s.saved()['quote']<=3000000000,'owner buy capped at immutable micro allocation and principal ceiling',r)
 # At ready, failed destination cannot force owner principal to remain locked.
 r=s.send([m.ata_ix(FIXTURE.pubkey(),s.pool,m.WSOL),m.transfer(m.TransferParams(from_pubkey=FIXTURE.pubkey(),to_pubkey=s.pq,lamports=1000000)),m.ix(m.TOKEN,b'\x11',[m.meta(s.pq,True)])]);check(r['ok'],'owner fixture pre-donated destination created')
 before=s.snapshot();r=s.migrate();check(not r['ok'] and s.snapshot()==before,'owner migration rejects dusted destination atomically')
 r=s.sell(int(config['tokensSoldAtGraduationRaw']));check(r['ok'] and s.saved()['sold']==0 and s.saved()['phase']==0,'owner redeems fully when migration destination blocked',r)
 check(s.buy(10000000000)['ok'],'owner can refill reopened micro curve')
 s.choose_index(1);r=s.migrate();check(r['ok'],'owner feature actual PumpSwap migration using clean index',r);check(m.token_amount(s.vm,s.lpata)==0 and s.saved()['lpBurned']>0,'owner feature burns entire received LP balance')
 before=s.snapshot();r=s.migrate();check(r['ok'] and s.snapshot()==before,'owner migration replay does not charge twice')
 return {'localOnly':True,'realFundsUsed':False,'feature':'owner-test','verificationOperator':str(FIXTURE.pubkey()),'PUBLIC_FIXTURE_NEVER_DEPLOY':True,'binarySha256':hashlib.sha256(BINARY.read_bytes()).hexdigest(),'testCount':len(results),'tests':results}
if __name__=='__main__':
 report=run();(ROOT/'owner-vm-results.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
