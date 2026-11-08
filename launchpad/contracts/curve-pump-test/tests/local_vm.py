"""No RPC, no broadcast. Deterministic test keys and in-memory accounts only."""
import base64, hashlib, json, math, os, pathlib, struct, sys, time
from solders.litesvm import LiteSVM
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.account import Account
from solders.instruction import Instruction, AccountMeta
from solders.message import Message
from solders.transaction import Transaction
from solders.compute_budget import set_compute_unit_limit
from solders.system_program import create_account, CreateAccountParams, transfer, TransferParams
ROOT=pathlib.Path(__file__).resolve().parents[1]
P=Pubkey.from_string
TOKEN=P('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'); TOKEN22=P('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'); ATA=P('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'); SYS=P('11111111111111111111111111111111'); WSOL=P('So11111111111111111111111111111111111111112'); PUMP=P('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'); GLOBAL=P('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw')
PROGRAM=Keypair.from_seed(bytes([88])*32).pubkey();ADMIN=Keypair.from_seed(bytes([99])*32);TREASURY=Keypair.from_seed(bytes([98])*32).pubkey();OTHER=Keypair.from_seed(bytes([97])*32)
SUPPLY=10**15;VB=1876395877837567;VQ=187639587783;CAP=689658924614012;GRAD=2885;TRADE=100
PUMP_BINARY=pathlib.Path(os.environ.get('PUMP_TEST_BINARY','/tmp/pumpswap-tax-audit/pump-mainnet.so'))
OUR_BINARY=ROOT/'artifacts/curve_pump_test_LOCAL_ONLY.so'
def meta(k,w=False,s=False):return AccountMeta(k,s,w)
def ix(program,data,accounts):return Instruction(program,data,accounts)
def ata(owner,mint,program=TOKEN):return Pubkey.find_program_address([bytes(owner),bytes(program),bytes(mint)],ATA)[0]
def u64(d,o=0):return struct.unpack_from('<Q',d,o)[0]
def token_amount(vm,key):return u64(vm.get_account(key).data,64)
def outcome(res):
 try:return {'ok':False,'error':str(res.err()),'logs':res.meta().logs(),'units':res.meta().compute_units_consumed()}
 except AttributeError:return {'ok':True,'logs':res.logs(),'units':res.compute_units_consumed()}
def ata_ix(payer,owner,mint,token=TOKEN):return ix(ATA,b'\x01',[meta(payer,True,True),meta(ata(owner,mint,token),True),meta(owner),meta(mint),meta(SYS),meta(token)])
def spl_transfer(src,dst,owner,n):return ix(TOKEN,b'\x03'+struct.pack('<Q',n),[meta(src,True),meta(dst,True),meta(owner,False,True)])
class Scenario:
 def __init__(self,donated_state=0,donated_auth=0,budget=100_000_000,binary=OUR_BINARY,config=None):
  self.vm=LiteSVM();self.vm.add_program(PROGRAM,binary.read_bytes());self.vm.add_program(PUMP,PUMP_BINARY.read_bytes());j=json.loads((ROOT/'fixtures/pump-global.json').read_text())['result']['value'];self.vm.set_account(GLOBAL,Account(j['lamports'],base64.b64decode(j['data'][0]),P(j['owner']),j['executable'],j['rentEpoch']));self.vm.set_account(WSOL,Account(100000000,bytes(44)+bytes([9,1])+bytes(36),TOKEN));self.vm.airdrop(ADMIN.pubkey(),1_000_000_000_000);self.vm.airdrop(OTHER.pubkey(),1_000_000_000);self.vm.airdrop(TREASURY,1_000_000)
  self.mintkey=Keypair.from_seed(bytes([77])*32);self.mint=self.mintkey.pubkey();self.state=Pubkey.find_program_address([b'curve',bytes(self.mint)],PROGRAM)[0];self.auth=Pubkey.find_program_address([b'vault',bytes(self.mint)],PROGRAM)[0];self.vault=ata(self.auth,self.mint);self.user=ata(ADMIN.pubkey(),self.mint);self.quote=ata(self.auth,WSOL)
  self.index=0;self.pool=Pubkey.find_program_address([b'pool',struct.pack('<H',0),bytes(self.auth),bytes(self.mint),bytes(WSOL)],PUMP)[0];self.lp=Pubkey.find_program_address([b'pool_lp_mint',bytes(self.pool)],PUMP)[0];self.lpata=ata(self.auth,self.lp,TOKEN22);self.pb=ata(self.pool,self.mint);self.pq=ata(self.pool,WSOL);self.event=Pubkey.find_program_address([b'__event_authority'],PUMP)[0]
  if donated_state:self.vm.airdrop(self.state,donated_state)
  if donated_auth:self.vm.airdrop(self.auth,donated_auth)
  self.setup=self.send([create_account(CreateAccountParams(from_pubkey=ADMIN.pubkey(),to_pubkey=self.mint,lamports=10_000_000,space=82,owner=TOKEN)),ix(TOKEN,b'\x14\x06'+bytes(self.auth)+b'\x00',[meta(self.mint,True)]),ata_ix(ADMIN.pubkey(),ADMIN.pubkey(),self.mint)],[ADMIN,self.mintkey]);assert self.setup['ok'],self.setup
  self.config=config or {'virtualBaseRaw':str(VB),'virtualQuoteRaw':str(VQ),'tokensSoldAtGraduationRaw':str(CAP)}
  self.initix=ix(PROGRAM,b'\x00'+struct.pack('<6Q',int(self.config['virtualBaseRaw']),int(self.config['virtualQuoteRaw']),int(self.config['tokensSoldAtGraduationRaw']),budget,GRAD,TRADE),[meta(ADMIN.pubkey(),True,True),meta(self.state,True),meta(self.auth,True),meta(self.mint,True),meta(self.vault,True),meta(TREASURY),meta(SYS),meta(TOKEN),meta(ATA)])
  self.init=self.send([self.initix]);
 def send(self,instructions,signers=None):
  self.vm.expire_blockhash();tx=Transaction(signers or [ADMIN],Message([set_compute_unit_limit(1_400_000)]+instructions,ADMIN.pubkey()),self.vm.latest_blockhash());return outcome(self.vm.send_transaction(tx))
 def data(self):return self.vm.get_account(self.state).data
 def saved(self):
  d=self.data();return {'phase':d[8],'vb':u64(d,112),'vq':u64(d,120),'sold':u64(d,136),'quote':u64(d,144),'lpBurned':u64(d,192),'graduationFee':u64(d,200)}
 def tradeix(self,buy,amount,minimum=1,treasury=TREASURY,user=None,admin=None):return ix(PROGRAM,bytes([1 if buy else 2])+struct.pack('<QQ',amount,minimum),[meta(admin or ADMIN.pubkey(),True,True),meta(self.state,True),meta(self.auth,True),meta(self.mint),meta(self.vault,True),meta(user or self.user,True),meta(treasury,True),meta(SYS),meta(TOKEN)])
 def buy(self,amount=200_000_000_000,minimum=1):return self.send([self.tradeix(True,amount,minimum)])
 def sell(self,amount,minimum=1):return self.send([self.tradeix(False,amount,minimum)])
 def choose_index(self,index):
  self.index=index;self.pool=Pubkey.find_program_address([b'pool',struct.pack('<H',index),bytes(self.auth),bytes(self.mint),bytes(WSOL)],PUMP)[0];self.lp=Pubkey.find_program_address([b'pool_lp_mint',bytes(self.pool)],PUMP)[0];self.lpata=ata(self.auth,self.lp,TOKEN22);self.pb=ata(self.pool,self.mint);self.pq=ata(self.pool,WSOL)
 def migrateix(self,substitute=None):
  keys=[ADMIN.pubkey(),self.state,self.auth,self.mint,self.vault,TREASURY,GLOBAL,self.pool,WSOL,self.lp,self.quote,self.lpata,self.pb,self.pq,SYS,TOKEN,TOKEN22,ATA,self.event,PUMP];
  if substitute:keys[substitute[0]]=substitute[1]
  return ix(PROGRAM,b'\x03'+struct.pack('<H',self.index),[meta(k,i in [0,1,2,4,5,7,9,10,11,12,13],i==0) for i,k in enumerate(keys)])
 def migrate(self):return self.send([self.migrateix()])
 def snapshot(self):
  out={}
  for k in [self.state,self.auth,self.mint,self.vault,TREASURY,self.pool,self.lp,self.lpata,self.quote,self.pb,self.pq,self.user]:
   a=self.vm.get_account(k);out[str(k)]=None if a is None else (a.lamports,bytes(a.data),str(a.owner))
  return out

def check(ok,label,details=None):
 if not ok:raise AssertionError((label,details))
 results.append({'name':label,'passed':True})
results=[]
def run():
 s=Scenario(donated_state=1_000_000,donated_auth=10_000_000);check(s.init['ok'],'initialize accepts prefunded PDA addresses',s.init);check(u64(s.vm.get_account(s.mint).data,36)==SUPPLY,'initial supply minted exactly once');check(s.vm.get_account(s.mint).data[:4]==bytes(4),'mint authority revoked');check(s.vm.get_account(s.mint).data[46:50]==bytes(4),'freeze authority absent');check(s.vm.get_account(s.auth).owner==SYS,'SOL reserve owned by PDA under system program');check(s.saved()['quote']==0,'prefunded SOL excluded from price ledger');before=s.snapshot();r=s.send([s.initix]);check(not r['ok'] and s.snapshot()==before,'reinitialization rejected atomically',r)
 r=s.buy(1_000_000_000);check(r['ok'],'buy executes',r);st=s.saved();held=token_amount(s.vm,s.user);check(st['sold']==held and st['quote']>0,'buy ledger reconciles token custody');check(s.vm.get_account(s.auth).lamports>=st['quote'],'reserve covers accounted principal')
 before=s.snapshot();r=s.sell(held,10**18);check(not r['ok'] and s.snapshot()==before,'sell slippage failure rolls back');r=s.sell(held//2);check(r['ok'],'sell executes',r)
 before=s.snapshot();r=s.send([s.tradeix(True,1_000_000_000,treasury=OTHER.pubkey())]);check(not r['ok'] and s.snapshot()==before,'treasury substitution rejected');before=s.snapshot();r=s.send([s.tradeix(True,1_000_000_000,admin=OTHER.pubkey())],[ADMIN,OTHER]);check(not r['ok'] and s.snapshot()==before,'unauthorized operator rejected')
 # A voluntary holder burn must not freeze the curve.
 r=s.send([ix(TOKEN,b'\x08'+struct.pack('<Q',1),[meta(s.user,True),meta(s.mint,True),meta(ADMIN.pubkey(),False,True)])]);check(r['ok'],'external holder burn fixture succeeds',r);r=s.buy(1_000_000_000);check(r['ok'],'holder burn does not prevent later buy',r)
 # Both donations ignored by the economic ledger, excess base remains inaccessible.
 ledger=s.saved().copy();r=s.send([transfer(TransferParams(from_pubkey=ADMIN.pubkey(),to_pubkey=s.auth,lamports=1_000_000)),spl_transfer(s.user,s.vault,ADMIN.pubkey(),1)]);check(r['ok'] and s.saved()==ledger,'SOL and base donations do not change curve prices or cap',r)
 # Premature migration and excessive sells reject without mutation.
 before=s.snapshot();r=s.migrate();check(not r['ok'] and s.snapshot()==before,'premature migration rejected');before=s.snapshot();r=s.sell(s.saved()['sold']+1);check(not r['ok'] and s.snapshot()==before,'sell greater than sold supply rejected')
 r=s.buy();check(r['ok'],'final buy reaches graduation',r);check(s.saved()['sold']==CAP and s.saved()['phase']==1,'final buy clips precisely to immutable cap');before=s.snapshot();r=s.buy(1000000000);check(not r['ok'] and s.snapshot()==before,'buy after ready phase rejected');r=s.sell(100000);check(r['ok'] and s.saved()['phase']==0,'sell after ready phase redeems principal and reopens curve');check(s.buy()['ok'] and s.saved()['phase']==1,'reopened curve can graduate again')
 before=s.snapshot();r=s.send([s.migrateix((5,OTHER.pubkey()))]);check(not r['ok'] and s.snapshot()==before,'migration treasury substitution rejected')
 q=s.saved()['quote'];fee=(q*GRAD+9999)//10000;tb=s.vm.get_account(TREASURY).lamports;r=s.migrate();migration_units=r['units'];check(r['ok'],'atomic actual PumpSwap pool creation and LP burn',r);check(s.saved()['phase']==2 and s.saved()['quote']==0,'migration commits only on success');check(token_amount(s.vm,s.lpata)==0 and s.saved()['lpBurned']>0,'all newly received LP tokens actually burned');check(token_amount(s.vm,s.pq)==q-fee,'pool quote matches accounted funds minus exact graduation fee');check(token_amount(s.vm,s.pb)==SUPPLY-CAP,'pool base matches allocation ignoring donated tokens');check(s.vm.get_account(TREASURY).lamports-tb==fee,'graduation fee paid exactly once');check(token_amount(s.vm,s.vault)==1,'unsolicited base surplus remains inaccessible');before=s.snapshot();r=s.migrate();check(r['ok'] and s.snapshot()==before,'migration retry is a no-op and does not repay fee',r)
 # Program substitution, source insolvency and execution failure must preserve state.
 f=Scenario();check(f.init['ok'],'second fixture initialize');r=f.buy();check(r['ok'],'second fixture ready');before=f.snapshot();r=f.send([f.migrateix((19,TOKEN))]);check(not r['ok'] and f.snapshot()==before,'wrong AMM program rejected');a=f.vm.get_account(f.auth);f.vm.set_account(f.auth,Account(1_000_000,bytes(a.data),a.owner));before=f.snapshot();r=f.migrate();check(not r['ok'] and f.snapshot()==before,'insolvent reserve migration fails without fee or phase change')
 overflow=Scenario();check(overflow.init['ok'],'post-burn rollback fixture initializes');check(overflow.buy()['ok'],'post-burn rollback fixture ready');overflow.vm.set_account(TREASURY,Account(2**64-1,bytes(),SYS));before=overflow.snapshot();r=overflow.migrate();check(not r['ok'] and any('Burn' in x for x in r['logs']) and overflow.snapshot()==before,'failure after LP burn rolls back pool, fee and burn atomically',r)
 # Negative account and instruction cases use actual executable, not code-text assertions.
 f=Scenario();check(f.init['ok'],'negative account fixture initialize')
 for name,transaction in [('zero minimum output',f.tradeix(True,1_000_000_000,0)),('zero input',f.tradeix(True,0)),('unknown opcode',ix(PROGRAM,b'\xff',[meta(ADMIN.pubkey(),True,True)])),('duplicate account alias',f.tradeix(True,1_000_000_000,treasury=f.auth))]:
  before=f.snapshot();r=f.send([transaction]);check(not r['ok'] and f.snapshot()==before,name+' rejected atomically',r)
 disabled=Scenario(binary=ROOT/'artifacts/curve_pump_test_DISABLED.so');check(not disabled.init['ok'] and '7000' in disabled.init['error'],'default executable rejects all custody operations',disabled.init)
 # Force CPI success then program failure by reducing allowed instruction compute:
 # exact source balances and state remain unchanged regardless of point of failure.
 f=Scenario();check(f.init['ok'],'rollback fixture initialize');check(f.buy()['ok'],'rollback fixture ready');before=f.snapshot();f.vm.expire_blockhash();tx=Transaction([ADMIN],Message([set_compute_unit_limit(90_000),f.migrateix()],ADMIN.pubkey()),f.vm.latest_blockhash());r=outcome(f.vm.send_transaction(tx));check(not r['ok'] and f.snapshot()==before,'compute exhaustion during migration rolls back all account changes',r)
 # Pool reserve dust cannot alter pricing; fresh canonical index permits retry.
 f=Scenario();check(f.init['ok'],'donation blocker fixture initialize');check(f.buy()['ok'],'donation blocker fixture ready');r=f.send([ata_ix(ADMIN.pubkey(),f.pool,f.mint),spl_transfer(f.user,f.pb,ADMIN.pubkey(),1)]);check(r['ok'],'future Pump reserve donation fixture succeeds',r);before=f.snapshot();r=f.migrate();check(not r['ok'] and f.snapshot()==before,'pool reserve donation rejected without price change or fee',r)
 f.choose_index(1);r=f.migrate();check(r['ok'] and f.saved()['phase']==2,'pre-donated pool index can recover to clean canonical index');f.choose_index(0);before=f.snapshot();r=f.migrate();check(not r['ok'] and f.snapshot()==before,'completed migration cannot replay with different index')
 redeem=Scenario();check(redeem.init['ok'],'blocked migration redemption fixture initializes');check(redeem.buy()['ok'],'redemption fixture reaches cap');r=redeem.send([ata_ix(ADMIN.pubkey(),redeem.pool,WSOL),transfer(TransferParams(from_pubkey=ADMIN.pubkey(),to_pubkey=redeem.pq,lamports=1_000_000)),ix(TOKEN,b'\x11',[meta(redeem.pq,True)])]);check(r['ok'],'quote reserve predonation fixture succeeds');check(not redeem.migrate()['ok'],'predonated quote reserve blocks unsafe price change');r=redeem.sell(CAP);check(r['ok'] and redeem.saved()['sold']==0 and redeem.saved()['phase']==0 and redeem.saved()['quote']<=1,'full held supply redeems even when migration destination blocked',r)
 micro_config=json.loads((ROOT/'fixtures/micro-test-parameters.json').read_text())
 micro=Scenario(config=micro_config);check(micro.init['ok'],'$100/$500 micro preset initializes',micro.init);check(micro.buy(10_000_000_000)['ok'],'micro preset capped buy reaches graduation');micro_q=micro.saved()['quote'];micro_fee=(micro_q*GRAD+9999)//10000;mr=micro.migrate();check(mr['ok'],'micro preset actual PumpSwap migration and LP burn',mr);check(token_amount(micro.vm,micro.pq)==micro_q-micro_fee and token_amount(micro.vm,micro.lpata)==0,'micro preset exact LP quote and zero received LP balance');check(token_amount(micro.vm,micro.pb)==SUPPLY-int(micro_config['tokensSoldAtGraduationRaw']),'micro preset base allocation matches frozen parameters')
 return {'localOnly':True,'realFundsUsed':False,'programId':str(PROGRAM),'programSha256':hashlib.sha256(OUR_BINARY.read_bytes()).hexdigest(),'pumpProgramSha256':hashlib.sha256(PUMP_BINARY.read_bytes()).hexdigest(),'testCount':len(results),'tests':results,'migrationComputeUnits':migration_units,'remainingProductionBlockers':['all 65536 pool indices could theoretically be pre-donated; phase1 sells preserve redemption while migration unavailable','local-test operator is public test fixture key, default build rejects all instructions','no independent professional audit, devnet or live integration deployment','SOL-only custody program, broader pair previews are not implemented on chain'],'exampleMigration':{'grossQuoteLamports':str(q),'graduationFeeLamports':str(fee),'poolQuoteLamports':str(q-fee),'poolBaseAtoms':str(SUPPLY-CAP),'burnedLpAtoms':str(s.saved()['lpBurned'])}}
if __name__=='__main__':
 try:
  report=run();(ROOT/'local-vm-results.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
 except Exception as e:
  print('PASSED BEFORE FAILURE',len(results));print(e);raise
