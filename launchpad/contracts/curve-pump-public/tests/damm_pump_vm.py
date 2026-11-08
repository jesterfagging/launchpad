"""Offline integration: controller -> captured DAMM v2 -> captured PumpSwap.

Synthetic keys and balances only. The VM cannot broadcast. A single fixture-only
configuration transaction disables signature verification because the deployed
administrator's private key is deliberately unavailable. Every other transaction
uses real signatures from deterministic, test-only keys.
"""
import base64, hashlib, json, math, os, pathlib, struct, subprocess
from solders.litesvm import LiteSVM
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.account import Account
from solders.instruction import Instruction, AccountMeta
from solders.message import Message
from solders.transaction import Transaction
from solders.signature import Signature
from solders.compute_budget import set_compute_unit_limit
from solders.system_program import create_account, CreateAccountParams, transfer, TransferParams

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
FIXTURES = HERE / 'fixtures/damm-pump'
BINARY = pathlib.Path(os.environ.get('DAMM_CONTROLLER_BINARY', ROOT / 'artifacts/curve_pump_public.so'))
P = Pubkey.from_string
PROGRAM = P('FBD7sVcEMutFtQn6SXGxLZPFLKEY4pbQTkLYTGC9FXKA')
TOKEN = P('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
TOKEN22 = P('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
ATA = P('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
SYS = P('11111111111111111111111111111111')
DAMM = P('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG')
PUMP = P('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')
WSOL = P('So11111111111111111111111111111111111111112')
ADMIN = P('7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS')
TREASURY = P('HN22QWXBPb7dfmPhTjCf14jDco4dYzwDKeehWDXcnHEF')
CREATOR, USER, RELAYER, OTHER = [Keypair.from_seed(bytes([n])*32) for n in [71,72,73,74]]
SUPPLY = 10**15

def meta(key, writable=False, signer=False): return AccountMeta(key, signer, writable)
def ix(program, data, keys): return Instruction(program, data, keys)
def ata(owner, mint, program=TOKEN): return Pubkey.find_program_address([bytes(owner),bytes(program),bytes(mint)],ATA)[0]
def u64(data, offset=0): return struct.unpack_from('<Q',data,offset)[0]
def u128(data, offset=0): return int.from_bytes(data[offset:offset+16],'little')
def amount(vm, key):
    a = vm.get_account(key)
    return u64(a.data,64) if a else 0
def ata_ix(payer, owner, mint, program=TOKEN):
    return ix(ATA,b'\x01',[meta(payer,True,True),meta(ata(owner,mint,program),True),meta(owner),meta(mint),meta(SYS),meta(program)])
def decoded_ix(value):
    return ix(P(value['program']),base64.b64decode(value['data']),[meta(P(k['key']),k['writable'],k['signer']) for k in value['keys']])
def substitute(instruction, index, key):
    keys=list(instruction.accounts);old=keys[index];keys[index]=meta(key,old.is_writable,old.is_signer)
    return ix(instruction.program_id,instruction.data,keys)
def outcome(result):
    try: return {'ok':False,'error':str(result.err()),'logs':result.meta().logs(),'units':result.meta().compute_units_consumed()}
    except AttributeError: return {'ok':True,'logs':result.logs(),'units':result.compute_units_consumed()}

class Scenario:
    def __init__(self, decimals=6, price=1_000_000, quote_program=TOKEN, seed=77, initialize=True, native=False, quote_freeze=False):
        if native: decimals,price,quote_program=9,150_000_000,TOKEN
        self.vm=LiteSVM(); self.quote_program=quote_program; self.decimals=decimals
        manifest=json.loads((FIXTURES/'manifest.json').read_text())
        for row in manifest['programs']:
            binary=(FIXTURES/row['file']).read_bytes()
            assert hashlib.sha256(binary).hexdigest()==row['sha256'], 'Executable fixture hash mismatch'
            self.vm.add_program(P(row['programId']),binary)
        self.vm.add_program(PROGRAM,BINARY.read_bytes())
        row=json.loads((FIXTURES/'pump-global.json').read_text()); a=row['account']
        self.vm.set_account(P(row['pubkey']),Account(a['lamports'],base64.b64decode(a['data'][0]),P(a['owner']),a['executable'],a['rentEpoch']))
        trading_file=FIXTURES/'pump-trading-config.json'
        assert hashlib.sha256(trading_file.read_bytes()).hexdigest()==manifest['pumpTradingConfigSha256']
        for key,a in json.loads(trading_file.read_text())['accounts'].items():
            self.vm.set_account(P(key),Account(a['lamports'],base64.b64decode(a['data'][0]),P(a['owner']),a['executable'],a['rentEpoch']))
        for key in [CREATOR.pubkey(),USER.pubkey(),RELAYER.pubkey(),OTHER.pubkey(),ADMIN,TREASURY]: self.vm.airdrop(key,10**12)
        self.config=Pubkey.find_program_address([b'config'],PROGRAM)[0]
        assert self.configure()['ok']
        self.base_key=Keypair.from_seed(bytes([seed])*32); self.base=self.base_key.pubkey()
        self.quote_key=Keypair.from_seed(bytes([seed+1])*32); self.quote=WSOL if native else self.quote_key.pubkey()
        auth=Pubkey.find_program_address([b'damm-vault',bytes(self.base)],PROGRAM)[0]
        setup=[]
        mints=[(self.base,TOKEN,6,auth)]+([] if native else [(self.quote,quote_program,decimals,CREATOR.pubkey())])
        if native: self.vm.set_account(WSOL,Account(100_000_000,bytes(44)+bytes([9,1])+bytes(36),TOKEN))
        for mint,program,dec,authority in mints:
            freeze=b'\x01'+bytes(CREATOR.pubkey()) if quote_freeze and mint==self.quote else b'\x00'
            setup.extend([create_account(CreateAccountParams(from_pubkey=CREATOR.pubkey(),to_pubkey=mint,lamports=10_000_000,space=82,owner=program)),ix(program,b'\x14'+bytes([dec])+bytes(authority)+freeze,[meta(mint,True)])])
        self.require(self.send(setup,[CREATOR,self.base_key]+([] if native else [self.quote_key])),'create synthetic mints')
        setup=[]
        for owner in [CREATOR.pubkey(),USER.pubkey()]:
            setup.extend([ata_ix(CREATOR.pubkey(),owner,self.base),ata_ix(CREATOR.pubkey(),owner,self.quote,quote_program)])
        self.require(self.send(setup),'create trader ATAs')
        minted=min(((1<<64)-1)//2,max(10**decimals*1_000_000,(50_000_000_000*10**decimals+price-1)//price))
        if native:
            for owner in [CREATOR,USER]:
                target=ata(owner.pubkey(),WSOL)
                self.require(self.send([transfer(TransferParams(from_pubkey=owner.pubkey(),to_pubkey=target,lamports=400_000_000_000)),ix(TOKEN,b'\x11',[meta(target,True)])],[owner]),'fund synthetic wrapped SOL')
        else:
            self.require(self.send([ix(quote_program,b'\x07'+struct.pack('<Q',minted),[meta(self.quote,True),meta(ata(owner,self.quote,quote_program),True),meta(CREATOR.pubkey(),False,True)]) for owner in [CREATOR.pubkey(),USER.pubkey()]]),'fund synthetic quote')
        self.params={'programId':str(PROGRAM),'creator':str(CREATOR.pubkey()),'user':str(CREATOR.pubkey()),'payer':str(RELAYER.pubkey()),'relayer':str(RELAYER.pubkey()),'mint':str(self.base),'quoteMint':str(self.quote),'quoteTokenProgram':str(quote_program),'quoteDecimals':decimals,'quoteUsdMicros':str(price),'expiresUnix':str(self.vm.get_clock().unix_timestamp+120),'poolIndex':0}
        self.load_builders()
        self.init=self.send([self.initialize],[CREATOR,RELAYER]) if initialize else None
    @staticmethod
    def require(result, label):
        if not result['ok']: raise AssertionError((label,result))
    def load_builders(self):
        result=subprocess.run(['node',str(HERE/'damm_fixture.mjs')],input=json.dumps(self.params),text=True,capture_output=True,check=True)
        self.fixture=json.loads(result.stdout); self.model=self.fixture['model']; self.a={k:P(v) for k,v in self.fixture['addresses'].items() if isinstance(v,str) and k!='poolIndex'}
        self.initialize=decoded_ix(self.fixture['initialize']); self.migrate_instruction=decoded_ix(self.fixture['migrate']); self.claim_instruction=decoded_ix(self.fixture['claim'])
    def configure(self, relayer=RELAYER.pubkey(), enabled=True):
        ci=ix(PROGRAM,b'\x04'+bytes(relayer)+bytes([enabled]),[meta(ADMIN,True,True),meta(self.config,True),meta(SYS)])
        self.vm.expire_blockhash(); msg=Message.new_with_blockhash([ci],ADMIN,self.vm.latest_blockhash()); tx=Transaction.populate(msg,[Signature.default()]); self.vm.with_sigverify(False)
        try: return outcome(self.vm.send_transaction(tx))
        finally: self.vm.with_sigverify(True)
    def send(self, instructions, signers=None, compute_limit=1_400_000):
        signers=signers or [CREATOR]; self.vm.expire_blockhash()
        tx=Transaction(signers,Message([set_compute_unit_limit(compute_limit)]+instructions,signers[0].pubkey()),self.vm.latest_blockhash())
        return {**outcome(self.vm.send_transaction(tx)),'harnessTransactionBytes':len(bytes(tx))}
    def state(self):
        d=self.vm.get_account(self.a['state']).data
        return {'phase':d[8],'sale':u64(d,320),'reserve':u64(d,328),'quote':u64(d,336),'burned':u64(d,400),'migratedQuote':u64(d,408),'migratedBase':u64(d,416),'fees':u64(d,424)}
    def pool(self):
        d=self.vm.get_account(self.a['dammPool']).data
        return {'liquidity':u128(d,360),'min':u128(d,424),'max':u128(d,440),'sqrt':u128(d,456),'fee':u64(d,8),'mode':d[484],'trackedBase':u64(d,680),'trackedQuote':u64(d,688),'layout':d[696]}
    def snapshot(self):
        keys=set(self.a.values())|{self.base,self.quote,ata(USER.pubkey(),self.base),ata(USER.pubkey(),self.quote,self.quote_program),ata(TREASURY,self.quote,self.quote_program)}
        # Transaction fees may reduce payer SOL on failure. Custody balances and
        # every protocol/trader token account must nevertheless roll back.
        keys-= {CREATOR.pubkey(),USER.pubkey(),RELAYER.pubkey(),OTHER.pubkey(),ADMIN}
        return {str(k): None if (a:=self.vm.get_account(k)) is None else (a.lamports,bytes(a.data),str(a.owner)) for k in keys}
    def swap_ix(self, buy, quantity, minimum=1, mode=0, trader=USER.pubkey()):
        a=self.a; user_base=ata(trader,self.base); user_quote=ata(trader,self.quote,self.quote_program)
        keys=[a['dammAuthority'],a['dammPool'],user_quote if buy else user_base,user_base if buy else user_quote,a['dammBaseVault'],a['dammQuoteVault'],self.base,self.quote,trader,TOKEN,self.quote_program,DAMM,a['dammEvent'],DAMM]
        return ix(DAMM,bytes([65,75,63,76,235,91,91,136])+struct.pack('<QQB',quantity,minimum,mode),[meta(k,i in [1,2,3,4,5],i==8) for i,k in enumerate(keys)])
    def swap(self,buy,quantity,minimum=1,mode=0): return self.send([self.swap_ix(buy,quantity,minimum,mode)],[USER])
    def bond(self): return self.swap(True,int(self.model['endpointQuoteRoundedUp'])*2,mode=1)
    def migrate(self): return self.send([self.migrate_instruction],[RELAYER])
    def claim(self): return self.send([self.claim_instruction],[RELAYER])
    def index(self,index): self.params['poolIndex']=index; self.load_builders()
    def pump_trade(self,side,quantity):
        keys=set(self.a.values())|{self.base,self.quote,ata(USER.pubkey(),self.base),ata(USER.pubkey(),self.quote,self.quote_program),P('5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx')}
        accounts={}
        for key in keys:
            account=self.vm.get_account(key)
            if account: accounts[str(key)]={'lamports':account.lamports,'owner':str(account.owner),'executable':account.executable,'data':base64.b64encode(account.data).decode()}
        data={**self.params,'user':str(USER.pubkey()),'side':side,'amountRaw':str(quantity),'slot':self.vm.get_clock().slot,'nativeAccountRent':self.vm.minimum_balance_for_rent_exemption(165),'accounts':accounts}
        built=json.loads(subprocess.run(['node',str(HERE/'damm_pump_trade_fixture.mjs')],input=json.dumps(data),text=True,capture_output=True,check=True).stdout)
        return self.send([decoded_ix(ix) for ix in built['instructions']],[USER]),built

RESULTS=[]
def check(ok,name,detail=None):
    if not ok: raise AssertionError((name,detail))
    metrics={key:detail[key] for key in ['units','harnessTransactionBytes'] if isinstance(detail,dict) and key in detail}
    RESULTS.append({'name':name,'passed':True,**metrics})
def rejects(s,instruction,signers,name):
    before=s.snapshot(); result=s.send([instruction],signers)
    check(not result['ok'] and before==s.snapshot(),name,result)

def postmigration_trades(s,label):
    base=ata(USER.pubkey(),s.base);quote=ata(USER.pubkey(),s.quote,s.quote_program)
    before_base,before_quote=amount(s.vm,base),amount(s.vm,quote)
    result,built=s.pump_trade('buy',10**s.decimals)
    check(result['ok'],label+' post-graduation buy executes production SDK instructions on actual PumpSwap',result)
    bought=amount(s.vm,base)-before_base
    quote_change=before_quote-amount(s.vm,quote)
    check(bought>=int(built['trade']['minimum'])>0 and quote_change==(0 if s.quote==WSOL else 10**s.decimals),label+' post-graduation buy delivers minimum base and debits the exact quote budget')
    if s.quote==WSOL:check(s.vm.get_account(P(built['trade']['quoteAccount'])) is None,label+' buy closes its temporary SOL account and preserves existing wrapped SOL')
    before_base,before_quote=amount(s.vm,base),amount(s.vm,quote);before_sol=s.vm.get_account(USER.pubkey()).lamports
    result,built=s.pump_trade('sell',bought//2)
    check(result['ok'],label+' post-graduation sell executes production SDK instructions on actual PumpSwap',result)
    received=amount(s.vm,quote)-before_quote
    if s.quote==WSOL:received=s.vm.get_account(USER.pubkey()).lamports-before_sol+5000
    check(before_base-amount(s.vm,base)==bought//2 and received>=int(built['trade']['minimum'])>0,label+' post-graduation sell debits exact base and delivers minimum quote')
    if s.quote==WSOL:check(amount(s.vm,quote)==before_quote and s.vm.get_account(P(built['trade']['quoteAccount'])) is None,label+' sell unwraps proceeds without touching existing wrapped SOL')
    check(amount(s.vm,s.a['authorityLp'])==0 and u64(s.vm.get_account(s.a['lpMint']).data,36)==0,label+' continues trading with all received LP burned')

def run():
    s=Scenario(); check(s.init['ok'],'actual DAMM initializes through controller CPI',s.init)
    if destination:=os.environ.get('DAMM_CAPTURE_INITIALIZED'):
        captured={'controllerSha256':hashlib.sha256(BINARY.read_bytes()).hexdigest(),'params':s.params,'model':s.model,'addresses':s.fixture['addresses'],'accounts':{}}
        for name in ['state','dammPool','position','mint','quoteMint','nftMint','nftAccount','baseAta','quoteAta','dammBaseVault','dammQuoteVault']:
            key=s.a[name];account=s.vm.get_account(key)
            captured['accounts'][name]={'pubkey':str(key),'owner':str(account.owner),'lamports':account.lamports,'data':base64.b64encode(account.data).decode()}
        pathlib.Path(destination).write_text(json.dumps(captured,indent=2)+'\n')
    state=s.state(); pool=s.pool()
    check(state['sale']+state['reserve']==SUPPLY,'fixed billion-token supply splits exactly')
    check(pool['sqrt']==pool['min'] and pool['trackedQuote']==0,'initial active quote is exactly zero',pool)
    check(pool['fee']==12_500_000 and pool['mode']==1,'DAMM fee is fixed 125 bps and quote-only',pool)
    check(amount(s.vm,s.a['baseAta'])==state['reserve'] and amount(s.vm,s.a['dammBaseVault'])==state['sale'],'PDA keeps reserve and DAMM owns sale allocation')
    mint=s.vm.get_account(s.base).data
    check(mint[:4]==bytes(4) and mint[46:50]==bytes(4) and u64(mint,36)==SUPPLY,'base mint and freeze authorities absent after exact issuance')
    nft=s.vm.get_account(s.a['nftAccount']).data
    check(nft[32:64]==bytes(s.a['authority']) and u64(nft,64)==1,'controller owns DAMM position NFT')
    check(s.swap(True,100*10**s.decimals)['ok'],'unrelated wallet buys through actual DAMM')
    held=amount(s.vm,ata(USER.pubkey(),s.base)); check(held>0,'native DAMM buy delivers base tokens')
    check(s.swap(False,held//2)['ok'],'unrelated wallet sells through actual DAMM')
    rejects(s,s.migrate_instruction,[RELAYER],'premature graduation rejects without reserve mutation')
    before=s.pool(); qbefore=amount(s.vm,ata(TREASURY,s.quote)); result=s.claim()
    check(result['ok'],'protocol claims quote fees through actual DAMM',result)
    check(s.pool()==before and amount(s.vm,ata(TREASURY,s.quote))>qbefore,'fee claim leaves all liquidity and principal unchanged')
    rejects(s,substitute(s.claim_instruction,6,ata(USER.pubkey(),s.quote)),[RELAYER],'fee claim cannot pay an arbitrary quote account')
    for index,key,label in [(9,OTHER.pubkey(),'foreign pool'),(12,ata(USER.pubkey(),s.base),'foreign NFT custody'),(26,TOKEN22,'quote token program substitution')]:
        rejects(s,substitute(s.migrate_instruction,index,key),[RELAYER],label+' rejected atomically')
    rejects(s,s.initialize,[CREATOR,RELAYER],'initialization replay cannot mint twice')
    for index,quote_tokens in enumerate([1,13,257,3,999,41,7,1001,2,89,503,17]):
        result=s.swap(True,quote_tokens*10**s.decimals+index+1)
        check(result['ok'],f'repeated native DAMM buy {index+1} executes',result)
        held=amount(s.vm,ata(USER.pubkey(),s.base));result=s.swap(False,held//(3+index%5))
        check(result['ok'],f'repeated native DAMM sell {index+1} executes',result)
    result=s.bond(); check(result['ok'],'final partial-fill buy reaches finite range endpoint after repeated buys and sells',result)
    pool=s.pool(); check(pool['sqrt']==pool['max'],'terminal DAMM sqrt price exactly equals upper bound',pool)
    global_key=s.a['pumpGlobal']; global_account=s.vm.get_account(global_key)
    disabled=bytearray(global_account.data); disabled[56]|=1
    s.vm.set_account(global_key,Account(global_account.lamports,bytes(disabled),global_account.owner))
    before=s.snapshot(); result=s.migrate()
    check(not result['ok'] and before==s.snapshot(),'Pump failure rolls back successful DAMM withdrawal and all reserves',result)
    check(any('Instruction: RemoveLiquidity' in line for line in result['logs']) and any(str(PUMP)+' invoke' in line for line in result['logs']),'rollback test reaches both actual venue CPIs',result)
    s.vm.set_account(global_key,global_account)
    result=s.migrate()
    check(result['ok'],'actual DAMM withdraw and actual Pump create-pool complete atomically',result)
    state=s.state()
    check(state['phase']==2 and amount(s.vm,s.a['poolBase'])==state['migratedBase'] and amount(s.vm,s.a['poolQuote'])==state['migratedQuote'],'Pump tracked custody reserves equal migrated principal')
    check(state['migratedBase']>=state['reserve'] and abs(state['migratedQuote']-state['quote'])<=2,'terminal rounding preserves reserved base and quote budget',state)
    check(amount(s.vm,s.a['authorityLp'])==0 and u64(s.vm.get_account(s.a['lpMint']).data,36)==0 and state['burned']>0,'every received Pump LP token is burned')
    check(state['burned']==math.isqrt(state['migratedBase']*state['migratedQuote'])-100,'burn amount equals full Pump LP issuance minus protocol minimum')
    before=s.snapshot(); result=s.migrate(); check(result['ok'] and s.snapshot()==before,'graduation retry is idempotent',result)
    before=s.pool(); treasury_before=amount(s.vm,ata(TREASURY,s.quote)); result=s.claim()
    check(result['ok'] and s.pool()==before and amount(s.vm,ata(TREASURY,s.quote))>treasury_before,'remaining DAMM protocol fees remain claimable after LP migration',result)
    postmigration_trades(s,'Classic SPL quote')
    f=Scenario(initialize=False)
    rejects(f,substitute(f.initialize,8,OTHER.pubkey()),[CREATOR,OTHER],'unapproved relayer cannot initialize')
    rejects(f,substitute(f.initialize,1,Pubkey.find_program_address([b'curve',bytes(f.base)],PROGRAM)[0]),[CREATOR,RELAYER],'legacy state namespace cannot be substituted')
    rejects(f,substitute(f.initialize,17,OTHER.pubkey()),[CREATOR,RELAYER],'noncanonical position cannot be substituted')
    altered=bytearray(f.initialize.data); altered[66]^=1
    rejects(f,ix(PROGRAM,bytes(altered),f.initialize.accounts),[CREATOR,RELAYER],'signed geometry cannot change the fixed supply economics')
    check(f.configure(relayer=OTHER.pubkey())['ok'],'configuration rotation succeeds')
    rejects(f,f.initialize,[CREATOR,RELAYER],'stale relayer configuration rejects saved initialization')
    check(f.configure()['ok'] and f.send([f.initialize],[CREATOR,RELAYER])['ok'],'fresh authorized configuration permits unchanged safe retry')
    f=Scenario(initialize=False,seed=80)
    quote_account=f.vm.get_account(f.quote); changed=bytearray(quote_account.data); changed[44]+=1
    f.vm.set_account(f.quote,Account(quote_account.lamports,bytes(changed),quote_account.owner))
    rejects(f,f.initialize,[CREATOR,RELAYER],'changed quote decimals reject before custody creation')
    f.vm.set_account(f.quote,Account(quote_account.lamports,quote_account.data,TOKEN22))
    rejects(f,f.initialize,[CREATOR,RELAYER],'quote mint owner must match the fixed token program')
    f.vm.set_account(f.quote,quote_account)
    no_signer=list(f.initialize.accounts); no_signer[8]=meta(RELAYER.pubkey())
    rejects(f,ix(PROGRAM,f.initialize.data,no_signer),[CREATOR],'relayer address without relayer signature is insufficient')
    expired=bytearray(f.initialize.data); struct.pack_into('<Q',expired,9,999999999)
    rejects(f,ix(PROGRAM,bytes(expired),f.initialize.accounts),[CREATOR,RELAYER],'unbounded quote attestation expiry rejects')
    clock=f.vm.get_clock(); clock.unix_timestamp+=121; f.vm.set_clock(clock)
    rejects(f,f.initialize,[CREATOR,RELAYER],'expired quote attestation cannot initialize at a stale price')
    f=Scenario(quote_program=TOKEN22,initialize=False,seed=82)
    account=f.vm.get_account(f.quote); fee=bytearray(108)
    struct.pack_into('<Q',fee,80,1_000_000); struct.pack_into('<H',fee,88,100)
    data=account.data+bytes(83)+b'\x01'+struct.pack('<HH',1,108)+bytes(fee)
    f.vm.set_account(f.quote,Account(account.lamports,data,TOKEN22))
    rejects(f,f.initialize,[CREATOR,RELAYER],'active Token-2022 transfer fee cannot enter an exact-reserve launch')
    for kind,size,label in [(1,108,'zero transfer-fee configuration'),(12,32,'permanent delegate'),(10,52,'interest-bearing configuration'),(25,56,'scaled UI configuration'),(14,64,'transfer hook')]:
        data=account.data+bytes(83)+b'\x01'+struct.pack('<HH',kind,size)+bytes(size)
        f.vm.set_account(f.quote,Account(account.lamports,data,TOKEN22))
        rejects(f,f.initialize,[CREATOR,RELAYER],label+' is rejected because PumpSwap quote compatibility is unproven or unsupported')
    for native,program,label in [(False,TOKEN22,'Token-2022 quote'),(True,TOKEN,'native SOL quote')]:
        f=Scenario(quote_program=program,native=native)
        check(f.init['ok'],label+' initializes through actual DAMM',f.init)
        check(f.pool()['trackedQuote']==0 and amount(f.vm,f.a['dammQuoteVault'])==1,label+' starts with zero active quote and the mandatory one-unit vault seed')
        check(amount(f.vm,f.a['quoteAta'])==0,label+' transfers exactly the mandatory seed without retaining quote principal')
        result=f.bond();check(result['ok'],label+' reaches range endpoint with partial fill',result)
        result=f.migrate();check(result['ok'],label+' migrates through both venues and burns LP',result)
        check(amount(f.vm,f.a['authorityLp'])==0 and u64(f.vm.get_account(f.a['lpMint']).data,36)==0,label+' leaves no redeemable Pump LP')
        postmigration_trades(f,label)
    for include_metadata,label in [(False,'Token-2022 metadata-pointer quote'),(True,'Token-2022 metadata-pointer and metadata quote')]:
        f=Scenario(quote_program=TOKEN22,initialize=False)
        account=f.vm.get_account(f.quote)
        data=account.data+bytes(83)+b'\x01'+struct.pack('<HH',18,64)+bytes(32)+bytes(f.quote)
        if include_metadata: data+=struct.pack('<HH',19,80)+bytes(32)+bytes(f.quote)+bytes(16)
        f.vm.set_account(f.quote,Account(account.lamports,data,TOKEN22))
        result=f.send([f.initialize],[CREATOR,RELAYER]);check(result['ok'],label+' initializes through actual DAMM',result)
        result=f.bond();check(result['ok'],label+' reaches the exact endpoint',result)
        result=f.migrate();check(result['ok'] and amount(f.vm,f.a['authorityLp'])==0,label+' migrates through actual PumpSwap and burns LP',result)
        postmigration_trades(f,label)
    for decimals,price,label in [(0,1_000_000,'zero-decimal quote'),(2,50_000_000,'two-decimal fifty-dollar quote'),(8,100_000_000_000,'eight-decimal high-price quote'),(18,1_000_000_000_000,'eighteen-decimal quote'),(6,1,'micro-dollar quote')]:
        f=Scenario(decimals=decimals,price=price)
        check(f.init['ok'],label+' validates identical Rust and SDK launch geometry',f.init)
        result=f.bond();check(result['ok'] and f.pool()['sqrt']==f.pool()['max'],label+' reaches the exact endpoint',result)
        result=f.migrate();check(result['ok'],label+' withdraws exact principal and completes PumpSwap migration',result)
        check(f.state()['migratedQuote']==int(f.model['finalQuote']) and f.state()['migratedBase']==int(f.model['baseReserved']) and amount(f.vm,f.a['authorityLp'])==0,label+' preserves exact fixed principal and burns LP')
    f=Scenario()
    # These are real token transfers by an unrelated holder, not fixture edits.
    check(f.swap(True,100*10**f.decimals)['ok'],'donation fixture acquires base through native DAMM')
    donations=[ix(TOKEN,b'\x03'+struct.pack('<Q',quantity),[meta(source,True),meta(target,True),meta(USER.pubkey(),False,True)]) for source,target,quantity in [(ata(USER.pubkey(),f.base),f.a['baseAta'],7),(ata(USER.pubkey(),f.quote),f.a['quoteAta'],11)]]
    check(f.send(donations,[USER])['ok'],'unrelated holder can donate assets without becoming a controller authority')
    rejects(f,ix(TOKEN,b'\x03'+struct.pack('<Q',1),[meta(f.a['baseAta'],True),meta(ata(USER.pubkey(),f.base),True),meta(USER.pubkey(),False,True)]),[USER],'unrelated signer cannot transfer custody reserves')
    result=f.bond();check(result['ok'],'donations cannot prevent reaching the endpoint',result)
    check(f.configure(enabled=False)['ok'],'new-launch switch can be disabled after existing launch trades')
    # Graduation is deliberately permissionless and independent of the launch
    # relayer/config so existing capital cannot become hostage to a stale relayer.
    result=f.send([substitute(f.migrate_instruction,0,OTHER.pubkey())],[OTHER])
    check(result['ok'],'unrelated keeper can migrate an existing launch after new-launch disable',result)
    check(amount(f.vm,f.a['baseAta'])==7 and amount(f.vm,f.a['quoteAta'])==11,'migration excludes unsolicited donations from fixed pool principal')
    check(f.state()['migratedBase']==int(f.model['baseReserved']) and f.state()['migratedQuote']==int(f.model['finalQuote']),'donations cannot change immutable migration economics')
    f=Scenario();check(f.bond()['ok'],'pre-funded destination recovery fixture reaches endpoint')
    check(f.send([ata_ix(USER.pubkey(),f.a['pool'],f.quote),ix(TOKEN,b'\x03'+struct.pack('<Q',1),[meta(ata(USER.pubkey(),f.quote),True),meta(f.a['poolQuote'],True),meta(USER.pubkey(),False,True)])],[USER])['ok'],'unrelated holder pre-funds a candidate PumpSwap vault')
    rejects(f,f.migrate_instruction,[RELAYER],'pre-funded destination rejects without withdrawing launch liquidity')
    f.index(32767);result=f.migrate()
    check(result['ok'],'fresh PumpSwap index recovers from a pre-funded destination atomically',result)
    f=Scenario(initialize=False,quote_freeze=True)
    instructions=[ata_ix(CREATOR.pubkey(),f.a['authority'],f.quote),ix(TOKEN,b'\x03'+struct.pack('<Q',1),[meta(ata(CREATOR.pubkey(),f.quote),True),meta(f.a['quoteAta'],True),meta(CREATOR.pubkey(),False,True)]),ix(TOKEN,b'\x0a',[meta(f.a['quoteAta'],True),meta(f.quote),meta(CREATOR.pubkey(),False,True)])]
    check(f.send(instructions)['ok'],'issuer freezes a seeded quote account using the real SPL instruction')
    before=f.snapshot();result=f.send([f.initialize],[CREATOR,RELAYER])
    check(not result['ok'] and before==f.snapshot(),'frozen quote source rejects without mutating mint issuance or custody',result)
    check(f.send([ix(TOKEN,b'\x0b',[meta(f.a['quoteAta'],True),meta(f.quote),meta(CREATOR.pubkey(),False,True)])])['ok'],'issuer can thaw the same quote source')
    result=f.send([f.initialize],[CREATOR,RELAYER]);check(result['ok'],'same initialization safely retries after the quote source is restored',result)
    f=Scenario(initialize=False);before=f.snapshot()
    result=f.send([f.initialize],[CREATOR,RELAYER],compute_limit=300_000)
    check(not result['ok'] and before==f.snapshot(),'late initialization failure rolls back mint issuance, revoked authority, custody and DAMM account creation',result)
    check(any('Instruction: InitializeCustomizablePool' in line for line in result['logs']),'late initialization rollback exercises the actual DAMM CPI')
    result=f.send([f.initialize],[CREATOR,RELAYER]);check(result['ok'],'same initialization safely retries after a compute-budget failure',result)
    return {'realFundsUsed':False,'broadcast':False,'signatureVerification':'all user/relayer transactions verified; configuration admin fixture only uses signer flag without private key','packetSizeScope':'harnessTransactionBytes reports offline legacy harness transactions, not the separate full production v0/ALT launch packet; production packet limits are verified in JS client tests','maximumRecordedComputeUnits':max(row.get('units',0) for row in RESULTS),'controllerSha256':hashlib.sha256(BINARY.read_bytes()).hexdigest(),'fixtureManifest':json.loads((FIXTURES/'manifest.json').read_text()),'testCount':len(RESULTS),'tests':RESULTS}

if __name__=='__main__':
    report=run(); destination=pathlib.Path(os.environ.get('DAMM_VM_REPORT',ROOT/'damm-vm-results.json'))
    destination.write_text(json.dumps(report,indent=2)+'\n'); print(json.dumps(report,indent=2))
