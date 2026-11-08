"""Real production final-buy + fee graduation v0 transactions, offline LiteSVM.

Run: python contracts/curve-damm-pump-fee/tests/atomic_graduation_vm.py
The reviewed controller and venue ELFs are unchanged. Only the synthetic
administrator configuration fixture disables signature verification. Creators,
external liquidity providers and every final buyer use valid test-key signatures.
No live RPC, real assets, deployment, or transaction broadcasting is possible.
"""
import base64, hashlib, importlib.util, json, math, pathlib, struct, subprocess
from solders.compute_budget import ComputeBudget
from solders.transaction import VersionedTransaction

HERE=pathlib.Path(__file__).resolve().parent
ROOT=HERE.parent
APP=ROOT.parent.parent
spec=importlib.util.spec_from_file_location('atomic_fee_suite',HERE/'fee_public_vm.py')
fee=importlib.util.module_from_spec(spec);spec.loader.exec_module(fee)
suite=fee.suite;h=suite.h
BRIDGE=HERE/'atomic_graduation_fixture.mjs'
TABLE=h.Keypair.from_seed(bytes([191])*32).pubkey()
CONTROLLER_HASH='0e0337bdc95d5a77175f317766ccee9ce5a4f35a0e2ec594239266f012a729dd'
CHECKS=[]

def check(condition,label,**details):
    if not condition:raise AssertionError((label,details))
    CHECKS.append({'name':label,'passed':True,**details})

class Scenario(suite.Scenario):
    def load_builders(self):
        if self.quote==h.WSOL:self.params['quoteUsdMicros']='117240000'
        super().load_builders()
    def bridge(self,operation='build',wallet=h.USER.pubkey(),amount=100_000_000,**extra):
        keys=set(self.a.values())|{self.base,self.quote,h.ata(h.TREASURY,self.quote,self.quote_program)}
        accounts={}
        for key in keys:
            a=self.vm.get_account(key)
            if a:accounts[str(key)]={'lamports':a.lamports,'owner':str(a.owner),'executable':a.executable,'data':base64.b64encode(a.data).decode()}
        args={**self.params,'creator':str(h.CREATOR.pubkey()),'wallet':str(wallet),'operation':operation,'amountRaw':str(amount),'accounts':accounts,'slot':self.vm.get_clock().slot,'now':self.vm.get_clock().unix_timestamp,'nativeRent':self.vm.minimum_balance_for_rent_exemption(165),'lookupTableKey':str(TABLE),'blockhash':str(self.vm.latest_blockhash()),**extra}
        result=subprocess.run(['node',str(BRIDGE)],cwd=APP,input=json.dumps(args),text=True,capture_output=True)
        if result.returncode:raise AssertionError(('production builder failed',result.stderr))
        return json.loads(result.stdout)
    def install_table(self,built):
        row=built['lookupTable'];data=struct.pack('<IQQBBH',1,(1<<64)-1,0,0,0,0).ljust(56,b'\0')+b''.join(bytes(h.P(k)) for k in row['addresses'])
        self.vm.set_account(h.P(row['address']),h.Account(10_000_000,data,h.P('AddressLookupTab1e1111111111111111111111111')))
    def send_v0(self,built,signer):
        self.install_table(built)
        unsigned=VersionedTransaction.from_bytes(base64.b64decode(built['wire']))
        tx=VersionedTransaction(unsigned.message,[signer])
        result=h.outcome(self.vm.send_transaction(tx))
        result.update(packetBytes=len(bytes(tx)),invokeCount=sum(' invoke [' in line for line in result['logs']))
        return result,tx


def extra_liquidity(s):
    check(s.swap(True,500_000_000)['ok'],'external LP first acquires base through real DAMM')
    nft=h.Keypair.from_seed(bytes([189])*32);before=s.pool()['liquidity'];delta=before*5912//10_000_000
    built=s.bridge('add-position',positionNft=str(nft.pubkey()),userBase=str(h.ata(h.USER.pubkey(),s.base)),userQuote=str(h.ata(h.USER.pubkey(),s.quote,s.quote_program)),liquidityDelta=str(delta))
    result=s.send([h.decoded_ix(ix) for ix in built['instructions']],[h.USER,nft])
    check(result['ok'] and s.pool()['liquidity']==before+delta,'actual unrelated LP adds 0.05912% liquidity',units=result['units'])
    return delta


def setup(native=True,extra=False,metadata_quote=False,remaining_raw=None):
    s=Scenario(native=native,quote_program=h.TOKEN22 if metadata_quote else h.TOKEN);s.vm.with_compute_budget(ComputeBudget(False));s.vm.with_log_bytes_limit(200_000);s.vm.warp_to_slot(10)
    if metadata_quote:
        # Synthetic mint fixture: metadata pointer and variable-length token
        # metadata only, matching the extension allowlist offered by the app.
        account=s.vm.get_account(s.quote)
        pointer=bytes(32)+bytes(s.quote)
        strings=[b'VM Quote',b'VMQ',b'https://example.invalid/metadata.json']
        metadata=bytes(32)+bytes(s.quote)+b''.join(struct.pack('<I',len(value))+value for value in strings)+bytes(4)
        data=account.data[:82]+bytes(83)+b'\x01'+struct.pack('<HH',18,len(pointer))+pointer+struct.pack('<HH',19,len(metadata))+metadata
        s.vm.set_account(s.quote,h.Account(account.lamports,data,account.owner))
    check(s.foreign_initialize()['ok'],'ordinary creator initializes public fee controller with valid signatures')
    if extra:extra_liquidity(s)
    remaining=s.bridge('quote',amount=int(s.model['endpointQuoteRoundedUp'])*3)
    target=remaining_raw if remaining_raw is not None else (39_000_000 if native else 39_000)
    result=s.swap(True,int(remaining['charged'])-target,mode=1)
    check(result['ok'] and s.pool()['sqrt']<s.pool()['max'],f'actual swaps advance to {target} raw quote units before the endpoint')
    return s


def account_map(s,tx,built):
    keys=list(tx.message.account_keys)
    table=[h.P(k) for k in built['lookupTable']['addresses']]
    for row in tx.message.address_table_lookups:
        keys.extend(table[i] for i in row.writable_indexes)
        keys.extend(table[i] for i in row.readonly_indexes)
    return {str(k):s.vm.get_account(k) for k in keys}


def graduation_proof(s,before_treasury,label):
    state=s.state();paid=h.u64(s.vm.get_account(s.a['state']).data,440)
    check(state['phase']==2 and s.pool()['sqrt']==s.pool()['max'],label+' final buy and migration commit together')
    check(paid==int(s.model['graduationFeeRaw']) and h.amount(s.vm,h.ata(h.TREASURY,s.quote,s.quote_program))-before_treasury==paid,label+' exact graduation fee reaches treasury once')
    check(state['migratedBase']==int(s.model['baseReserved']) and state['migratedQuote']==int(s.model['migrationQuoteRaw']),label+' all reserved principal enters PumpSwap')
    check(h.amount(s.vm,s.a['baseAta'])==0 and h.amount(s.vm,s.a['quoteAta'])==0,label+' no base or quote principal remains in custody')
    check(h.amount(s.vm,s.a['authorityLp'])==0 and h.u64(s.vm.get_account(s.a['lpMint']).data,36)==0 and state['burned']==math.isqrt(state['migratedBase']*state['migratedQuote'])-100,label+' all received PumpSwap LP burns atomically')
    check(h.u64(s.vm.get_account(s.base).data,36)==h.SUPPLY,label+' full billion-token supply is preserved')
    before=s.snapshot();result=s.migrate()
    check(result['ok'] and s.snapshot()==before,label+' migration retry cannot pay a second fee or move principal')


def success_case(label,native=True,extra=False,fresh=False,metadata_quote=False,automatic=False):
    s=setup(native,extra,metadata_quote);signer=h.RELAYER if automatic else (h.OTHER if fresh else h.USER);wallet=signer.pubkey()
    budget=100_000_000 if native else 100_000
    finish_plan=None
    if automatic:
        finish_plan=s.bridge('finish-plan',wallet=wallet)
        check(finish_plan is not None and finish_plan['amountRaw']==finish_plan['maxAmountRaw']==finish_plan['maxFinishSolLamports']=='250000000',label+' production planner sets the fixed 0.25 SOL maximum budget')
        check(int(finish_plan['expectedSpendRaw'])==39_000_000 and 0<int(finish_plan['remainingQuoteRaw'])<int(finish_plan['expectedSpendRaw']),label+' production planner includes trading fees within the funding cap')
        budget=int(finish_plan['amountRaw'])
    elif not native:
        check(s.bridge('finish-plan') is None,label+' automatic SOL funding excludes non-SOL quotes')
    built=s.bridge(wallet=wallet,amount=budget)
    if metadata_quote:
        compatibility=built['quoteCompatibility']
        check(compatibility['ready'] and compatibility['tokenProgram']==str(h.TOKEN22) and compatibility['extensions']==[18,19],label+' production quote validation accepts only the two supported metadata extensions')
    check(built['graduation'] is not None and built['trade']['reachesGraduation'],label+' SDK exact endpoint triggers production atomic graduation')
    charged=int(built['trade']['charged'])
    check(abs(charged-(39_000_000 if native else 39_000))<=2 and charged<budget,label+f' {budget} raw quote budget only spends approximately 0.039 quote units',chargedRaw=str(charged),unusedRaw=str(budget-charged))
    check(built['packetBytes']<=1232,label+' complete v0 transaction fits existing frozen launch ALT',packetBytes=built['packetBytes'])
    if fresh:check(s.vm.get_account(h.ata(wallet,s.base)) is None,label+' final buyer starts without a token account')
    unsigned=VersionedTransaction.from_bytes(base64.b64decode(built['wire']));before_accounts=account_map(s,unsigned,built)
    treasury=h.amount(s.vm,h.ata(h.TREASURY,s.quote,s.quote_program));before_wallet=s.vm.get_account(wallet).lamports
    base_before=h.amount(s.vm,h.ata(wallet,s.base));quote_before=h.amount(s.vm,h.ata(wallet,s.quote,s.quote_program))
    result,tx=s.send_v0(built,signer)
    check(result['ok'],label+' real signed production transaction succeeds',packetBytes=result['packetBytes'],units=result['units'],invokeCount=result['invokeCount'],error=result.get('error'))
    check(result['invokeCount']<=64,label+' instruction trace remains inside the real 64-entry limit',invokeCount=result['invokeCount'])
    check(h.amount(s.vm,h.ata(wallet,s.base))-base_before==int(built['trade']['output']),label+' buyer receives the quoted remaining curve tokens')
    if native:
        check(s.vm.get_account(h.P(built['trade']['quoteAccount'])) is None and h.amount(s.vm,h.ata(wallet,s.quote,s.quote_program))==quote_before,label+' temporary SOL account closes and existing WSOL stays untouched')
        after_accounts=account_map(s,tx,built);rent=0
        for key,account in after_accounts.items():
            if account and before_accounts.get(key) is None:
                native_tokens=h.u64(account.data,64) if account.owner==h.TOKEN and len(account.data)==165 and account.data[:32]==bytes(h.WSOL) else 0
                rent+=account.lamports-native_tokens
        authority_key=str(s.a['authority'])
        subsidy=before_accounts[authority_key].lamports-after_accounts[authority_key].lamports
        buyer_rent=rent-subsidy
        debit=before_wallet-s.vm.get_account(wallet).lamports
        check(buyer_rent==(s.vm.minimum_balance_for_rent_exemption(165) if fresh else 0),label+' migration account rent uses the existing launch subsidy')
        check(debit==charged+buyer_rent+5000,label+' unspent input and temporary-account rent return to buyer exactly',walletDebitLamports=str(debit),chargedLamports=str(charged),buyerAccountRentLamports=str(buyer_rent),migrationRentSubsidyLamports=str(subsidy),networkFeeLamports='5000')
    else:check(quote_before-h.amount(s.vm,h.ata(wallet,s.quote,s.quote_program))==charged,label+' unspent SPL quote remains in buyer wallet')
    graduation_proof(s,treasury,label)
    if automatic:
        check(s.bridge('finish-plan',wallet=wallet) is None,label+' migrated launch receives no additional automatic funding plan')
    return {'case':label,'automaticFinishPlan':finish_plan,'trade':built['trade'],'graduation':built['graduation'],'quoteCompatibility':built['quoteCompatibility'],'result':result}


def rollback_case():
    s=setup();built=s.bridge(amount=100_000_000)
    # After the reviewed quote, another holder sells enough to make the final
    # user's unchanged budget insufficient. This is an actual venue trade.
    race_tx=h.Transaction([h.USER],h.Message([h.set_compute_unit_limit(500_000),s.swap_ix(False,1_000_000*10**6)],h.USER.pubkey()),s.vm.latest_blockhash())
    check(h.outcome(s.vm.send_transaction(race_tx))['ok'],'race fixture executes an unrelated sell after final-buy preparation')
    fresh_quote=s.bridge('quote',amount=100_000_000)
    check(int(fresh_quote['nextSqrtPrice'])<s.pool()['max'],'race makes the saved 0.1 SOL buy fall short of graduation')
    before=s.snapshot();wallet_before=s.vm.get_account(h.USER.pubkey()).lamports
    treasury=h.amount(s.vm,h.ata(h.TREASURY,s.quote));result,_=s.send_v0(built,h.USER)
    check(not result['ok'] and before==s.snapshot(),'stale final-buy undershoot rolls back the buy and migration together',units=result['units'],invokeCount=result['invokeCount'],error=result.get('error'))
    check(any(str(h.DAMM)+' success' in line for line in result['logs']) and '7006' in result.get('error',''),'race rejection happens in migration after the actual DAMM buy succeeded')
    check(s.state()['phase']==0 and h.u64(s.vm.get_account(s.a['state']).data,440)==0 and h.amount(s.vm,h.ata(h.TREASURY,s.quote))==treasury,'failed atomic graduation pays no early graduation fee')
    check(wallet_before-s.vm.get_account(h.USER.pubkey()).lamports==5000 and s.vm.get_account(h.P(built['trade']['quoteAccount'])) is None,'race failure charges only network fee and leaves no temporary SOL account')
    return {'case':'race-undershoot','result':result}


def late_pump_failure():
    s=setup();built=s.bridge(amount=100_000_000)
    # Captured Pump configuration is changed only in the offline fixture to
    # exercise a venue rejecting pool creation after DAMM withdrawal and fee CPI.
    key=s.a['pumpGlobal'];account=s.vm.get_account(key);disabled=bytearray(account.data);disabled[56]|=1
    s.vm.set_account(key,h.Account(account.lamports,bytes(disabled),account.owner))
    before=s.snapshot();wallet_before=s.vm.get_account(h.USER.pubkey()).lamports
    treasury=h.amount(s.vm,h.ata(h.TREASURY,s.quote));result,_=s.send_v0(built,h.USER)
    check(not result['ok'] and before==s.snapshot(),'late PumpSwap failure rolls back final buy, withdrawal and graduation fee',units=result['units'],invokeCount=result['invokeCount'],error=result.get('error'))
    check(any('Instruction: RemoveLiquidity' in line for line in result['logs']) and any(str(h.PUMP)+' invoke' in line for line in result['logs']),'late failure reaches actual DAMM withdrawal and actual PumpSwap CPI')
    check(s.state()['phase']==0 and h.u64(s.vm.get_account(s.a['state']).data,440)==0 and h.amount(s.vm,h.ata(h.TREASURY,s.quote))==treasury,'late PumpSwap failure leaves no paid graduation fee')
    check(wallet_before-s.vm.get_account(h.USER.pubkey()).lamports==5000 and s.vm.get_account(h.P(built['trade']['quoteAccount'])) is None,'late PumpSwap failure leaves no quote debit or temporary SOL account')
    return {'case':'late-pump-failure','result':result}


def finish_cap_gate():
    # Gross input is just above 0.25 SOL, while net principal is below 0.25.
    # This distinguishes a genuine fee-inclusive cap from a net-only check.
    s=setup(remaining_raw=251_000_000)
    full=s.bridge('quote',amount=500_000_000)
    check(int(full['charged'])==251_000_000,'automatic finish cap fixture needs 0.251 SOL including trading fees')
    check(s.bridge('finish-plan') is None,'production finish planner refuses a fee-inclusive remainder above 0.25 SOL')
    before=s.snapshot();check(s.bond()['ok'],'finish cap fixture reaches the endpoint by an ordinary holder buy')
    check(s.bridge('finish-plan') is None,'already bonded launch receives no automatic funding plan')
    return {'case':'automatic-finish-cap-gates','result':{'ok':True},'grossRequiredRaw':full['charged']}


def run():
    check(hashlib.sha256(h.BINARY.read_bytes()).hexdigest()==CONTROLLER_HASH,'deployed fee controller ELF is unchanged')
    check(ComputeBudget(False).max_instruction_trace_length==64,'LiteSVM uses actual 64-entry instruction trace limit')
    reports=[success_case('native exact 117.24'),success_case('native extra-L fresh buyer',extra=True,fresh=True),success_case('classic SPL quote',native=False),success_case('Token-2022 metadata quote',native=False,metadata_quote=True),success_case('automatic relayer finish',extra=True,fresh=True,automatic=True),finish_cap_gate(),rollback_case(),late_pump_failure()]
    return {'broadcast':False,'realFundsUsed':False,'programId':str(h.PROGRAM),'controllerSha256':CONTROLLER_HASH,'traceLimit':64,'signatureVerification':'All final-buy, migration and liquidity-provider transactions have real verified synthetic signatures; only administrator configuration uses a fixture signer.','testCount':len(CHECKS),'tests':CHECKS,'cases':reports}

if __name__=='__main__':
    report=run();destination=ROOT/'atomic-graduation-vm-results.json';destination.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'testCount':report['testCount'],'report':str(destination),'cases':[{k:v for k,v in row['result'].items() if k!='logs'} for row in report['cases']]},indent=2))
