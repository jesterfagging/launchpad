"""Offline $50 -> $100 owner-only DAMM/PumpSwap executable integration.

Imports the public harness and the same hash-pinned actual venue executables.
The real administrator key is deliberately unavailable: configuration and owner
initialization fixtures use its signer flag with signature verification disabled.
Other transactions (including unauthorized creators, public trades and graduation)
use real signatures from deterministic test-only keys. No RPC or broadcasting.
"""
import importlib.util, pathlib, json, hashlib, os, struct, math, subprocess

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
PUBLIC_TESTS = ROOT.parent / 'curve-pump-public/tests'
spec = importlib.util.spec_from_file_location('public_vm', PUBLIC_TESTS/'damm_pump_vm.py')
h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)
h.PROGRAM = h.P('CzgJRVKJSmAibnZAjkEYqmAVvxyCSSukjxNG2y7b62NU')
h.BINARY = ROOT/'artifacts/curve_damm_pump_admin_test.so'
FIXTURE = HERE/'damm_fixture.mjs'
OWNER_ONLY = True
EXPECTED_START = 50
EXPECTED_END = 100

class Scenario(h.Scenario):
    def __init__(self, **kwargs):
        super().__init__(initialize=False, **kwargs)
        # Synthetic creator funds the administrator's one-unit seed. This is a
        # normal signature-verified transfer, separate from owner initialization.
        if self.quote != h.WSOL:
            instructions=[h.ata_ix(h.CREATOR.pubkey(), h.ADMIN, self.quote, self.quote_program),
                h.ix(self.quote_program,b'\x03'+struct.pack('<Q',1),[
                    h.meta(h.ata(h.CREATOR.pubkey(),self.quote,self.quote_program),True),
                    h.meta(h.ata(h.ADMIN,self.quote,self.quote_program),True),h.meta(h.CREATOR.pubkey(),False,True)])]
            self.require(self.send(instructions),'fund administrator initialization seed')
    def load_builders(self):
        self.params.update(creator=str(h.ADMIN),user=str(h.ADMIN))
        result=subprocess.run(['node',str(FIXTURE)],input=json.dumps(self.params),text=True,capture_output=True,check=True)
        self.fixture=json.loads(result.stdout); self.model=self.fixture['model']
        self.a={k:h.P(v) for k,v in self.fixture['addresses'].items() if isinstance(v,str) and k!='poolIndex'}
        self.initialize=h.decoded_ix(self.fixture['initialize'])
        self.migrate_instruction=h.decoded_ix(self.fixture['migrate'])
        self.claim_instruction=h.decoded_ix(self.fixture['claim'])
    def owner_initialize(self, instruction=None, verify=False, compute_limit=1_400_000):
        instruction=instruction or self.initialize
        self.vm.expire_blockhash()
        msg=h.Message.new_with_blockhash([h.set_compute_unit_limit(compute_limit),instruction],h.ADMIN,self.vm.latest_blockhash())
        signatures=[h.RELAYER.sign_message(bytes(msg)) if key==h.RELAYER.pubkey() else h.Signature.default() for key in msg.account_keys[:msg.header.num_required_signatures]]
        tx=h.Transaction.populate(msg,signatures)
        self.vm.with_sigverify(verify)
        try:return {**h.outcome(self.vm.send_transaction(tx)),'harnessTransactionBytes':len(bytes(tx))}
        finally:self.vm.with_sigverify(True)
    def foreign_initialize(self, creator=h.CREATOR):
        params={**self.params,'creator':str(creator.pubkey()),'user':str(creator.pubkey())}
        built=json.loads(subprocess.run(['node',str(FIXTURE)],input=json.dumps(params),text=True,capture_output=True,check=True).stdout)
        return self.send([h.decoded_ix(built['initialize'])],[creator,h.RELAYER])

def check_unchanged(s, result, before, name):
    h.check(not result['ok'] and before==s.snapshot(),name,result)

def run():
    s=Scenario()
    before=s.snapshot(); result=s.foreign_initialize()
    if OWNER_ONLY:
        check_unchanged(s,result,before,'on-chain rejects non-admin creator with valid creator and relayer signatures')
        h.check('7002' in result['error'],'unauthorized creator receives the explicit unauthorized program error',result)
    else:
        h.check(result['ok'],'future public fee controller accepts ordinary creator with real creator and relayer signatures',result)
        s=Scenario()
    before=s.snapshot();result=s.owner_initialize(verify=True)
    check_unchanged(s,result,before,'real signature verification rejects forged administrator signature')
    no_signer=list(s.initialize.accounts);no_signer[0]=h.meta(h.ADMIN,True,False)
    before=s.snapshot();result=s.send([h.ix(h.PROGRAM,s.initialize.data,no_signer)],[h.RELAYER])
    check_unchanged(s,result,before,'administrator address without administrator signature cannot initialize')
    # Legacy opcode 0 would otherwise bypass the test-only launch gate.
    for opcode in [0,1,2,3,5,9]:
        before=s.snapshot();result=s.send([h.ix(h.PROGRAM,bytes([opcode]),[h.meta(h.CREATOR.pubkey(),True,True)])])
        check_unchanged(s,result,before,f'legacy or unsupported opcode {opcode} cannot launch or move custody')
    altered=bytearray(s.initialize.data);altered[66]^=1
    before=s.snapshot();result=s.owner_initialize(h.ix(h.PROGRAM,bytes(altered),s.initialize.accounts))
    check_unchanged(s,result,before,'owner and relayer cannot alter immutable test geometry')
    result=s.owner_initialize();h.check(result['ok'],f'owner initializes actual DAMM at ${EXPECTED_START} FDV',result)
    h.check(abs(float(s.model['actualStartUsd'])-EXPECTED_START)<0.001 and abs(float(s.model['actualGraduationUsd'])-EXPECTED_END)<0.001,f'SDK model preserves ${EXPECTED_START} start and ${EXPECTED_END} graduation')
    h.check(s.pool()['min']==int(s.model['sqrtMinPrice']) and s.pool()['max']==int(s.model['sqrtMaxPrice']),'on-chain DAMM range matches test policy exactly')
    h.check(s.state()['sale']+s.state()['reserve']==h.SUPPLY,'full billion-token test supply splits exactly')
    h.check(s.pool()['trackedQuote']==0 and h.amount(s.vm,s.a['dammQuoteVault'])==1,'test starts with zero active quote and one-unit initialization seed')
    h.check(s.pool()['fee']==12_500_000 and s.pool()['mode']==1,'test uses production 125-bps quote-only DAMM fees')
    mint=s.vm.get_account(s.base).data
    h.check(mint[:4]==bytes(4) and mint[46:50]==bytes(4) and h.u64(mint,36)==h.SUPPLY,'test mint and freeze authorities revoked after issuance')
    before=s.snapshot();result=s.owner_initialize()
    check_unchanged(s,result,before,'test initialization replay cannot mint more tokens')
    before=s.snapshot();result=s.migrate()
    check_unchanged(s,result,before,'test cannot graduate before the actual DAMM endpoint')
    result=s.swap(True,1_000_000);h.check(result['ok'],'unrelated holder buys the test coin through actual DAMM',result)
    held=h.amount(s.vm,h.ata(h.USER.pubkey(),s.base));result=s.swap(False,held//3)
    h.check(result['ok'],'unrelated holder sells the test coin through actual DAMM',result)
    before=s.pool();fees_before=h.amount(s.vm,h.ata(h.TREASURY,s.quote));result=s.claim()
    h.check(result['ok'] and s.pool()==before and h.amount(s.vm,h.ata(h.TREASURY,s.quote))>fees_before,'test fee claims pay the same treasury without withdrawing principal',result)
    result=s.bond();h.check(result['ok'] and s.pool()['sqrt']==s.pool()['max'],'test bonds exactly at its FDV endpoint through an actual partial-fill buy',result)
    h.check(len(s.migrate_instruction.accounts)==31,'fee-aware migration requires the full 31-account ABI')
    for index,key,label in [(29,h.OTHER.pubkey(),'treasury wallet'),(30,h.ata(h.USER.pubkey(),s.quote,s.quote_program),'treasury token account')]:
        before=s.snapshot();result=s.send([h.substitute(s.migrate_instruction,index,key)],[h.RELAYER])
        check_unchanged(s,result,before,'graduation cannot redirect the '+label)
    global_key=s.a['pumpGlobal'];global_account=s.vm.get_account(global_key)
    disabled=bytearray(global_account.data);disabled[56]|=1
    s.vm.set_account(global_key,h.Account(global_account.lamports,bytes(disabled),global_account.owner))
    before=s.snapshot();result=s.migrate()
    check_unchanged(s,result,before,'actual PumpSwap failure atomically rolls back withdrawn test liquidity')
    h.check(any('Instruction: RemoveLiquidity' in line for line in result['logs']) and any(str(h.PUMP)+' invoke' in line for line in result['logs']),'rollback reaches actual DAMM and PumpSwap CPIs',result)
    s.vm.set_account(global_key,global_account)
    treasury_before=h.amount(s.vm,h.ata(h.TREASURY,s.quote,s.quote_program))
    result=s.migrate();h.check(result['ok'],'fee-aware graduation creates an ordinary PumpSwap pool',result)
    state=s.state()
    recorded_fee=h.u64(s.vm.get_account(s.a['state']).data,440)
    expected_fee=int(s.model['finalQuote'])*322369073//1000000000
    h.check(recorded_fee==expected_fee==int(s.model['graduationFeeRaw']) and h.amount(s.vm,h.ata(h.TREASURY,s.quote,s.quote_program))-treasury_before==expected_fee,'fixed graduation fee pays the pinned treasury exactly once')
    h.check(state['migratedQuote']+recorded_fee==int(s.model['finalQuote']),'gross withdrawn quote equals net LP deposit plus treasury fee')
    h.check(h.u64(s.vm.get_account(s.base).data,36)==h.SUPPLY,'graduation fee does not burn or reduce the billion-token supply')
    h.check(h.amount(s.vm,s.a['baseAta'])==0 and h.amount(s.vm,s.a['quoteAta'])==0,'all reserved base and net quote are deposited without stranded principal')
    spot_fdv=state['migratedQuote']*h.SUPPLY*int(s.params['quoteUsdMicros'])/(state['migratedBase']*10**s.decimals*1000000)
    h.check(abs(spot_fdv/EXPECTED_END-1)<=0.0005,'post-fee PumpSwap price and full-supply FDV match the DAMM endpoint within five basis points')
    h.check(state['phase']==2 and h.amount(s.vm,s.a['poolBase'])==state['migratedBase'] and h.amount(s.vm,s.a['poolQuote'])==state['migratedQuote'],'test PumpSwap holds exactly migrated reserves')
    h.check(state['migratedBase']==int(s.model['baseReserved']) and state['migratedQuote']==int(s.model['migrationQuoteRaw']),'test migration preserves fixed sale and quote principal')
    h.check(h.amount(s.vm,s.a['authorityLp'])==0 and h.u64(s.vm.get_account(s.a['lpMint']).data,36)==0 and state['burned']==math.isqrt(state['migratedBase']*state['migratedQuote'])-100,'all received test PumpSwap LP tokens burn atomically')
    before=s.snapshot();result=s.migrate();h.check(result['ok'] and before==s.snapshot(),'test graduation retries are idempotent',result)
    h.postmigration_trades(s,'Admin test classic quote')
    for native,program,label in [(True,h.TOKEN,'SOL'),(False,h.TOKEN22,'Token-2022')]:
        f=Scenario(native=native,quote_program=program)
        result=f.owner_initialize();h.check(result['ok'],label+' test owner initialization succeeds',result)
        result=f.bond();h.check(result['ok'] and f.pool()['sqrt']==f.pool()['max'],label+' test reaches actual endpoint',result)
        h.check(f.configure(enabled=False)['ok'],label+' disable only blocks new owner test launches')
        fee_before=h.amount(f.vm,h.ata(h.TREASURY,f.quote,f.quote_program))
        result=f.send([h.substitute(f.migrate_instruction,0,h.OTHER.pubkey())],[h.OTHER])
        h.check(result['ok'],label+' unrelated keeper still graduates an existing test while new launches paused',result)
        h.check(f.state()['migratedQuote']==int(f.model['migrationQuoteRaw']) and h.amount(f.vm,f.a['authorityLp'])==0,label+' test preserves quote principal and burns LP')
        h.check(h.u64(f.vm.get_account(f.a['state']).data,440)==int(f.model['graduationFeeRaw']) and h.amount(f.vm,h.ata(h.TREASURY,f.quote,f.quote_program))-fee_before==int(f.model['graduationFeeRaw']),label+' migration pays exact recorded fee to pinned treasury')
        h.check(h.u64(f.vm.get_account(f.base).data,36)==h.SUPPLY and h.amount(f.vm,f.a['baseAta'])==0,label+' fee preserves full supply and deposits every reserved token')
        h.postmigration_trades(f,'Admin test '+label)
    # Arbitrary donations are not launch principal and cannot change the fee.
    donated=Scenario();h.check(donated.owner_initialize()['ok'],'donation fixture initializes fee-aware custody')
    h.check(donated.swap(True,1_000_000)['ok'],'donation fixture acquires base through actual DAMM')
    transfers=[h.ix(h.TOKEN,b'\x03'+struct.pack('<Q',quantity),[h.meta(source,True),h.meta(destination,True),h.meta(h.USER.pubkey(),False,True)]) for source,destination,quantity in [
        (h.ata(h.USER.pubkey(),donated.base),donated.a['baseAta'],7),
        (h.ata(h.USER.pubkey(),donated.quote),donated.a['quoteAta'],11)]]
    h.check(donated.send(transfers,[h.USER])['ok'],'unrelated donor transfers extra assets into fee-aware custody')
    h.check(donated.bond()['ok'],'donated assets cannot prevent reaching the endpoint')
    treasury_before=h.amount(donated.vm,h.ata(h.TREASURY,donated.quote))
    result=donated.migrate();h.check(result['ok'],'donated assets cannot prevent fee-aware graduation',result)
    h.check(h.amount(donated.vm,donated.a['baseAta'])==7 and h.amount(donated.vm,donated.a['quoteAta'])==11,'migration consumes all allocated principal and excludes only unsolicited donations')
    h.check(h.amount(donated.vm,h.ata(h.TREASURY,donated.quote))-treasury_before==int(donated.model['graduationFeeRaw']),'donations do not inflate the fixed treasury graduation fee')
    h.check(donated.state()['migratedBase']==int(donated.model['baseReserved']) and donated.state()['migratedQuote']==int(donated.model['migrationQuoteRaw']),'donations do not alter LP deposits or migration price')
    # Owner and relayer are both mandatory, even for the separate small-value mode.
    f=Scenario();h.check(f.configure(enabled=False)['ok'],'admin can pause new test launches')
    before=f.snapshot();result=f.owner_initialize()
    check_unchanged(f,result,before,'paused test initialization rejects without creating custody')
    h.check(f.configure()['ok'],'admin can resume new test launches')
    no_relayer=list(f.initialize.accounts);no_relayer[8]=h.meta(h.RELAYER.pubkey())
    before=f.snapshot();result=f.owner_initialize(h.ix(h.PROGRAM,f.initialize.data,no_relayer))
    check_unchanged(f,result,before,'test owner still requires the reviewed relayer signature')
    before=f.snapshot();result=f.owner_initialize(compute_limit=300_000)
    check_unchanged(f,result,before,'test late compute failure rolls back mint issuance and custody')
    h.check(f.owner_initialize()['ok'],'unchanged test launch safely retries after compute failure')
    public_binary=ROOT.parent.parent/'private/damm-pump/curve_damm_pump.so'
    h.check(hashlib.sha256(public_binary.read_bytes()).hexdigest()=='5b45c7f3e114f5e8ccd73aaf12f500fb654915e7ab8656d169d54a3ad6f2d252','production controller executable remains byte-for-byte unchanged')
    return {'realFundsUsed':False,'broadcast':False,'programId':str(h.PROGRAM),'ownerOnly':OWNER_ONLY,'startUsd':EXPECTED_START,'graduationUsd':EXPECTED_END,
        'graduationFeeNumerator':'322369073','graduationFeeDenominator':'1000000000',
        'signatureVerification':'Owner initialization and configuration fixture uses administrator signer flag; all other transactions use real verified test-key signatures. Forged administrator signatures are explicitly rejected when verification enabled.',
        'packetSizeScope':'Offline legacy harness bytes only; production launch packet checks are separate.',
        'controllerSha256':hashlib.sha256(h.BINARY.read_bytes()).hexdigest(),
        'maximumRecordedComputeUnits':max(row.get('units',0) for row in h.RESULTS),
        'fixtureManifest':json.loads((h.FIXTURES/'manifest.json').read_text()),
        'testCount':len(h.RESULTS),'tests':h.RESULTS}

if __name__=='__main__':
    report=run();destination=pathlib.Path(os.environ.get('DAMM_ADMIN_TEST_VM_REPORT',ROOT/'admin-test-vm-results.json'))
    destination.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
