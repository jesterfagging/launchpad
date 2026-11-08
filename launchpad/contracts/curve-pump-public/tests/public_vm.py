"""Actual public ELF + actual PumpSwap ELF, in-memory Solana VM, no RPC/broadcast."""
import base64,hashlib,json,os,pathlib,struct
from solders.litesvm import LiteSVM
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.account import Account
from solders.instruction import Instruction,AccountMeta
from solders.message import Message
from solders.transaction import Transaction
from solders.signature import Signature
from solders.compute_budget import set_compute_unit_limit
from solders.system_program import create_account,CreateAccountParams,transfer,TransferParams
ROOT=pathlib.Path(__file__).resolve().parents[1];P=Pubkey.from_string
TOKEN=P('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');TOKEN22=P('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');ATA=P('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');SYS=P('11111111111111111111111111111111');WSOL=P('So11111111111111111111111111111111111111112');PUMP=P('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');GLOBAL=P('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw')
PROGRAM=P('458mQ1YveCRQQQqnR4kBUyRGXwqmJ8EuybKcUKRc2L6C');ADMIN=P('7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS');TREASURY=P('HN22QWXBPb7dfmPhTjCf14jDco4dYzwDKeehWDXcnHEF');CREATOR=Keypair.from_seed(bytes([71])*32);USER=Keypair.from_seed(bytes([72])*32);RELAYER=Keypair.from_seed(bytes([73])*32);OTHER=Keypair.from_seed(bytes([74])*32)
SUPPLY=10**15;VB=1876395877837567;CAP=689658924614012;PRICE=200_000_000
PUMP_BINARY=pathlib.Path(os.environ.get('PUMP_TEST_BINARY','/tmp/pumpswap-tax-audit/pump-mainnet.so'));OUR_BINARY=ROOT/'artifacts/curve_pump_public.so'
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
 def __init__(self,mint_seed=77,vm=None,initialize=True,price=PRICE,expiry=None,enabled=True):
  self.vm=vm or LiteSVM();self.config=Pubkey.find_program_address([b'config'],PROGRAM)[0]
  if vm is None:
   self.vm.add_program(PROGRAM,OUR_BINARY.read_bytes());self.vm.add_program(PUMP,PUMP_BINARY.read_bytes());j=json.loads((ROOT/'fixtures/pump-global.json').read_text())['result']['value'];self.vm.set_account(GLOBAL,Account(j['lamports'],base64.b64decode(j['data'][0]),P(j['owner']),j['executable'],j['rentEpoch']));self.vm.set_account(WSOL,Account(100000000,bytes(44)+bytes([9,1])+bytes(36),TOKEN))
   for k in [CREATOR.pubkey(),USER.pubkey(),RELAYER.pubkey(),OTHER.pubkey(),ADMIN,TREASURY]:self.vm.airdrop(k,1_000_000_000_000)
   # Only this configuration transaction disables signature verification because no
   # mainnet admin private key is possessed. Runtime signer flags are still checked.
   self.configured=self.configure(enabled=enabled);assert self.configured['ok'],self.configured
  self.mintkey=Keypair.from_seed(bytes([mint_seed])*32);self.mint=self.mintkey.pubkey();self.state=Pubkey.find_program_address([b'curve',bytes(self.mint)],PROGRAM)[0];self.auth=Pubkey.find_program_address([b'vault',bytes(self.mint)],PROGRAM)[0];self.vault=ata(self.auth,self.mint);self.user=ata(CREATOR.pubkey(),self.mint);self.otheruser=ata(USER.pubkey(),self.mint);self.quote=ata(self.auth,WSOL);self.event=Pubkey.find_program_address([b'__event_authority'],PUMP)[0];self.choose_index(0)
  self.setup=self.send([create_account(CreateAccountParams(from_pubkey=CREATOR.pubkey(),to_pubkey=self.mint,lamports=10_000_000,space=82,owner=TOKEN)),ix(TOKEN,b'\x14\x06'+bytes(self.auth)+b'\x00',[meta(self.mint,True)]),ata_ix(CREATOR.pubkey(),CREATOR.pubkey(),self.mint),ata_ix(CREATOR.pubkey(),USER.pubkey(),self.mint)],[CREATOR,self.mintkey]);assert self.setup['ok'],self.setup
  self.expiry=expiry if expiry is not None else self.vm.get_clock().unix_timestamp+120
  self.initix=ix(PROGRAM,b'\x00'+struct.pack('<QQ',price,self.expiry),[meta(CREATOR.pubkey(),True,True),meta(self.state,True),meta(self.auth,True),meta(self.mint,True),meta(self.vault,True),meta(TREASURY),meta(SYS),meta(TOKEN),meta(ATA),meta(self.config),meta(RELAYER.pubkey(),False,True)])
  self.init=self.send([self.initix],[CREATOR,RELAYER]) if initialize else None
 def configure(self,relayer=RELAYER.pubkey(),enabled=True,admin=ADMIN):
  ci=ix(PROGRAM,b'\x04'+bytes(relayer)+bytes([int(enabled)]),[meta(admin,True,True),meta(self.config,True),meta(SYS)])
  self.vm.expire_blockhash();msg=Message.new_with_blockhash([ci],admin,self.vm.latest_blockhash());tx=Transaction.populate(msg,[Signature.default()]);self.vm.with_sigverify(False)
  try:return outcome(self.vm.send_transaction(tx))
  finally:self.vm.with_sigverify(True)
 def send(self,instructions,signers=None,payer=None,units=1_400_000):
  signers=signers or [CREATOR];payer=payer or signers[0].pubkey();self.vm.expire_blockhash();tx=Transaction(signers,Message([set_compute_unit_limit(units)]+instructions,payer),self.vm.latest_blockhash());return outcome(self.vm.send_transaction(tx))
 def data(self):return self.vm.get_account(self.state).data
 def saved(self):
  d=self.data();return {'phase':d[8],'vb':u64(d,112),'vq':u64(d,120),'sold':u64(d,136),'quote':u64(d,144),'lpBurned':u64(d,192),'graduationFee':u64(d,200),'price':u64(d,256),'created':u64(d,264)}
 def tradeix(self,buy,amount,minimum=1,treasury=TREASURY,user=None,trader=None,creator=None):
  trader=trader or CREATOR.pubkey();return ix(PROGRAM,bytes([1 if buy else 2])+struct.pack('<QQ',amount,minimum),[meta(trader,True,True),meta(self.state,True),meta(self.auth,True),meta(self.mint),meta(self.vault,True),meta(user or ata(trader,self.mint),True),meta(treasury,True),meta(SYS),meta(TOKEN),meta(creator or CREATOR.pubkey(),True)])
 def buy(self,amount=200_000_000_000,minimum=1,trader=CREATOR):return self.send([self.tradeix(True,amount,minimum,trader=trader.pubkey())],[trader])
 def sell(self,amount,minimum=1,trader=CREATOR):return self.send([self.tradeix(False,amount,minimum,trader=trader.pubkey())],[trader])
 def choose_index(self,index):
  self.index=index;self.pool=Pubkey.find_program_address([b'pool',struct.pack('<H',index),bytes(self.auth),bytes(self.mint),bytes(WSOL)],PUMP)[0];self.lp=Pubkey.find_program_address([b'pool_lp_mint',bytes(self.pool)],PUMP)[0];self.lpata=ata(self.auth,self.lp,TOKEN22);self.pb=ata(self.pool,self.mint);self.pq=ata(self.pool,WSOL)
 def migrateix(self,substitute=None,relayer=RELAYER.pubkey()):
  keys=[relayer,self.state,self.auth,self.mint,self.vault,TREASURY,GLOBAL,self.pool,WSOL,self.lp,self.quote,self.lpata,self.pb,self.pq,SYS,TOKEN,TOKEN22,ATA,self.event,PUMP,self.config]
  if substitute:keys[substitute[0]]=substitute[1]
  return ix(PROGRAM,b'\x03'+struct.pack('<H',self.index),[meta(k,i in [0,1,2,4,5,7,9,10,11,12,13],i==0) for i,k in enumerate(keys)])
 def migrate(self,relayer=RELAYER):return self.send([self.migrateix(relayer=relayer.pubkey())],[relayer])
 def snapshot(self):
  out={}
  for k in [self.state,self.auth,self.mint,self.vault,TREASURY,self.pool,self.lp,self.lpata,self.quote,self.pb,self.pq,self.user,self.otheruser,self.config]:
   a=self.vm.get_account(k);out[str(k)]=None if a is None else (a.lamports,bytes(a.data),str(a.owner))
  return out
results=[]
def check(ok,name,detail=None):
 if not ok:raise AssertionError((name,detail))
 results.append({'name':name,'passed':True})
def run():
 s=Scenario();check(s.init['ok'],'public creator initializes with independent relayer signature',s.init);check(s.saved()['vb']==VB and s.saved()['vq']==VB*20000//PRICE,'fixed public20000/50000 parameters enforced');check(s.vm.get_account(s.mint).data[:4]==bytes(4),'mint authority revoked after fixed supply minted');check(s.vm.get_account(s.mint).data[46:50]==bytes(4),'freeze authority absent')
 r=s.buy(1000000000,trader=USER);check(r['ok'],'unrelated wallet buys without creator or relayer signature',r);held=token_amount(s.vm,s.otheruser);r=s.sell(held//2,trader=USER);check(r['ok'],'unrelated wallet sells without creator or relayer signature',r)
 for title,ixs,signers in [('substituted treasury',[s.tradeix(True,1000000000,treasury=OTHER.pubkey())],[CREATOR]),('another users token account',[s.tradeix(False,1,user=s.otheruser)],[CREATOR]),('zero minimum output',[s.tradeix(True,1000000000,0)],[CREATOR]),('premature migration',[s.migrateix()],[RELAYER])]:
  before=s.snapshot();r=s.send(ixs,signers);check(not r['ok'] and before==s.snapshot(),title+' rejects without reserve mutation',r)
 before=s.snapshot();r=s.send([s.initix],[CREATOR,RELAYER]);check(not r['ok'] and before==s.snapshot(),'initialization replay cannot remint or charge twice')
 check(s.configure(enabled=False)['ok'],'admin can pause new launches');check(s.buy(1000000000,trader=USER)['ok'],'pause does not block existing holders trading');t=Scenario(vm=s.vm,mint_seed=78);check(not t.init['ok'],'paused new launches rejected');check(s.configure()['ok'],'admin re-enables launches');t.init=t.send([t.initix],[CREATOR,RELAYER]);check(t.init['ok'],'second independent launch initializes')
 before={k:v for k,v in t.snapshot().items() if k!=str(TREASURY)};check(s.buy(1000000000)['ok'],'first launch continues trading');check({k:v for k,v in t.snapshot().items() if k!=str(TREASURY)}==before,'separate launch reserves and price state isolated')
 check(s.buy()['ok'] and s.saved()['sold']==CAP,'final buy clips exactly to fixed public supply cap');before=s.snapshot();r=s.migrate(relayer=CREATOR);check(not r['ok'] and before==s.snapshot(),'launch developer cannot submit LP migration')
 # Native donations to the vault WSOL account must not block every pool index.
 r=s.send([ata_ix(CREATOR.pubkey(),s.auth,WSOL),transfer(TransferParams(from_pubkey=CREATOR.pubkey(),to_pubkey=s.quote,lamports=1234567))]);check(r['ok'],'unsynchronized native WSOL donation setup')
 q=s.saved()['quote'];fee=(q*2885+9999)//10000;tb=s.vm.get_account(TREASURY).lamports;r=s.migrate();check(r['ok'],'platform relayer creates actual PumpSwap pool and atomically burns LP',r);check(token_amount(s.vm,s.lpata)==0 and s.saved()['lpBurned']>0,'PDA receives and burns all LP, developer never owns it');check(token_amount(s.vm,s.pq)==q-fee and token_amount(s.vm,s.pb)==SUPPLY-CAP,'exact pool reserves exclude unsolicited donation');check(s.vm.get_account(TREASURY).lamports-tb==fee,'exact 28.85 percent graduation fee paid once');check(token_amount(s.vm,s.quote)==1234567,'unsolicited WSOL donation excluded from principal');before=s.snapshot();r=s.migrate();check(r['ok'] and before==s.snapshot(),'migration replay is idempotent')
 f=Scenario();check(f.buy()['ok'],'blocked migration fixture bonds');r=f.send([ata_ix(CREATOR.pubkey(),f.pool,f.mint),spl_transfer(f.user,f.pb,CREATOR.pubkey(),1)]);check(r['ok'],'future pool dust attack setup');before=f.snapshot();r=f.migrate();check(not r['ok'] and before==f.snapshot(),'dusted pool rejects atomically without shifting price');held=token_amount(f.vm,f.user);check(f.sell(held)['ok'] and f.saved()['phase']==0,'holders redeem while migration blocked');check(f.buy()['ok'],'curve reopens then bonds');f.choose_index(1);check(f.migrate()['ok'],'relayer retries a fresh canonical pool index')
 f=Scenario();check(f.buy()['ok'],'rotation fixture bonds');check(f.configure(relayer=OTHER.pubkey())['ok'],'admin rotates failed relayer without fund withdrawal');before=f.snapshot();r=f.migrate();check(not r['ok'] and before==f.snapshot(),'old relayer revoked');check(f.migrate(relayer=OTHER)['ok'],'replacement relayer completes same fixed custody migration')
 for title,price,expiry in [('excessive price',1000000000001,None),('zero price',0,None),('unbounded launch expiry',PRICE,1000000000)]:
  f=Scenario(price=price,expiry=expiry);check(not f.init['ok'],title+' rejected')
 f=Scenario();before=f.snapshot();r=f.configure(admin=OTHER.pubkey());check(not r['ok'] and before==f.snapshot(),'outsider cannot change relayer or enable state')
 return {'realFundsUsed':False,'signatureVerification':'enabled for all creator/trader/relayer transactions; config admin fixture-only transaction bypasses cryptographic signature, never broadcast','programSha256':hashlib.sha256(OUR_BINARY.read_bytes()).hexdigest(),'pumpSha256':hashlib.sha256(PUMP_BINARY.read_bytes()).hexdigest(),'testCount':len(results),'tests':results}
if __name__=='__main__':
 report=run();(ROOT/'public-vm-results.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
