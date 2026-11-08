"""Independent real-Metaplex executable test; local accounts, no broadcast.

Usage: PYTHONPATH=/tmp/pumpswap-tax-audit/pydeps python3 tests/metadata_security.py
METAPLEX_TEST_BINARY points to the downloaded mainnet executable fixture.
"""
import hashlib, json, os, pathlib, struct
from solders.litesvm import LiteSVM
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.account import Account
from solders.instruction import Instruction, AccountMeta
from solders.message import Message
from solders.transaction import Transaction
from solders.compute_budget import set_compute_unit_limit
from solders.system_program import create_account, CreateAccountParams

P = Pubkey.from_string
ROOT = pathlib.Path(__file__).resolve().parents[1]
MPL = P('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
TOKEN = P('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
ATA = P('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
SYS = P('11111111111111111111111111111111')
ADMIN = P('7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS')
TREASURY = P('HN22QWXBPb7dfmPhTjCf14jDco4dYzwDKeehWDXcnHEF')
CREATOR = Keypair.from_seed(bytes([51])*32)
RELAYER = Keypair.from_seed(bytes([52])*32)
MINT = Keypair.from_seed(bytes([53])*32)
PROGRAM = Keypair.from_seed(bytes([54])*32).pubkey()
BINARY = pathlib.Path(os.environ.get('METAPLEX_TEST_BINARY', '/tmp/launchpad-public-security/metaplex-mainnet.so'))
OUR_BINARY = ROOT/'artifacts/curve_pump_public.so'
def meta(key, writable=False, signer=False): return AccountMeta(key, signer, writable)
def ix(program, data, accounts): return Instruction(program, data, accounts)
def string(value):
    raw=value.encode('utf8'); return struct.pack('<I',len(raw))+raw
def outcome(result):
    try: return {'ok':False,'error':str(result.err()),'logs':result.meta().logs()}
    except AttributeError: return {'ok':True,'logs':result.logs(),'units':result.compute_units_consumed()}
def decode_metadata(raw):
    pos=65; out={}
    for key in ['name','symbol','uri']:
        size=struct.unpack_from('<I',raw,pos)[0];pos+=4
        out[key]=raw[pos:pos+size].decode().rstrip('\x00');pos+=size
    out['sellerFeeBps']=struct.unpack_from('<H',raw,pos)[0];pos+=2
    assert raw[pos]==0;pos+=1 # creators: None
    out['primarySale']=bool(raw[pos]);out['isMutable']=bool(raw[pos+1])
    return out
def run():
    vm=LiteSVM();vm.add_program(MPL,BINARY.read_bytes());vm.add_program(PROGRAM,OUR_BINARY.read_bytes())
    vm.airdrop(CREATOR.pubkey(),10_000_000_000);vm.airdrop(RELAYER.pubkey(),1_000_000_000);vm.airdrop(TREASURY,1_000_000)
    vault=Pubkey.find_program_address([b'vault',bytes(MINT.pubkey())],PROGRAM)[0]
    state=Pubkey.find_program_address([b'curve',bytes(MINT.pubkey())],PROGRAM)[0]
    baseata=Pubkey.find_program_address([bytes(vault),bytes(TOKEN),bytes(MINT.pubkey())],ATA)[0]
    config=Pubkey.find_program_address([b'config'],PROGRAM)[0]
    cfg=bytearray(128);cfg[:8]=b'CRVPCFG1';cfg[8]=1;cfg[9]=1;cfg[16:48]=bytes(ADMIN);cfg[48:80]=bytes(TREASURY);cfg[80:112]=bytes(RELAYER.pubkey())
    # Configuration injected as fixture; configuration authorization is tested separately.
    vm.set_account(config,Account(10_000_000,bytes(cfg),PROGRAM))
    metadata=Pubkey.find_program_address([b'metadata',bytes(MPL),bytes(MINT.pubkey())],MPL)[0]
    name='Launchpad public proof';symbol='LPPROOF';uri='https://launch.example.com/api/metadata/public-proof.json'
    metadata_ix=ix(MPL,b'\x21'+string(name)+string(symbol)+string(uri)+struct.pack('<H',0)+bytes(5),[
        meta(metadata,True),meta(MINT.pubkey()),meta(CREATOR.pubkey(),False,True),
        meta(CREATOR.pubkey(),True,True),meta(CREATOR.pubkey()),meta(SYS)])
    clock=vm.get_clock()
    instructions=[set_compute_unit_limit(1_400_000),
        create_account(CreateAccountParams(from_pubkey=CREATOR.pubkey(),to_pubkey=MINT.pubkey(),lamports=vm.minimum_balance_for_rent_exemption(82),space=82,owner=TOKEN)),
        ix(TOKEN,b'\x14\x06'+bytes(CREATOR.pubkey())+b'\x00',[meta(MINT.pubkey(),True)]),
        metadata_ix,
        ix(TOKEN,b'\x06\x00\x01'+bytes(vault),[meta(MINT.pubkey(),True),meta(CREATOR.pubkey(),False,True)]),
        ix(PROGRAM,b'\x00'+struct.pack('<QQ',200_000_000,clock.unix_timestamp+120),[
            meta(CREATOR.pubkey(),True,True),meta(state,True),meta(vault,True),meta(MINT.pubkey(),True),meta(baseata,True),
            meta(TREASURY),meta(SYS),meta(TOKEN),meta(ATA),meta(config),meta(RELAYER.pubkey(),False,True)])]
    tx=Transaction([CREATOR,MINT,RELAYER],Message(instructions,CREATOR.pubkey()),vm.latest_blockhash())
    assert len(bytes(tx))<=1232, len(bytes(tx))
    payer_before=vm.get_account(CREATOR.pubkey()).lamports
    result=outcome(vm.send_transaction(tx));assert result['ok'],result
    payer_debit=payer_before-vm.get_account(CREATOR.pubkey()).lamports
    deposits={key:vm.get_account(addr).lamports for key,addr in [('mint',MINT.pubkey()),('metadata',metadata),('state',state),('vault',vault),('baseAta',baseata)]}
    data=vm.get_account(MINT.pubkey()).data
    metadata_data=vm.get_account(metadata).data;parsed=decode_metadata(metadata_data)
    checks=[('immutable metadata name, symbol and URI survive atomic initialization',parsed=={'name':name,'symbol':symbol,'uri':uri,'sellerFeeBps':0,'primarySale':False,'isMutable':False}),
      ('mint authority revoked after handoff and exact fixed supply mint',data[:4]==bytes(4) and struct.unpack_from('<Q',data,36)[0]==10**15),
      ('freeze authority remains absent',data[46:50]==bytes(4)),
      ('all supply is in the program vault',struct.unpack_from('<Q',vm.get_account(baseata).data,64)[0]==10**15),
      ('full launch transaction fits packet limit',len(bytes(tx))<=1232)]
    for label,ok in checks: assert ok,(label,parsed)
    # A creator cannot edit immutable onchain metadata after the launch succeeds.
    edit_data=string('Changed')+string(symbol)+string(uri)+struct.pack('<H',0)+bytes(3)
    update=ix(MPL,b'\x0f\x01'+edit_data+bytes(3),[meta(metadata,True),meta(CREATOR.pubkey(),False,True)])
    before=bytes(metadata_data);vm.expire_blockhash()
    edited=outcome(vm.send_transaction(Transaction([CREATOR],Message([update],CREATOR.pubkey()),vm.latest_blockhash())))
    assert not edited['ok'] and bytes(vm.get_account(metadata).data)==before,edited
    checks.append(('creator cannot edit immutable token metadata',True))
    # Verify the entire create chain rolls back if its final custody instruction fails.
    vm2=LiteSVM();vm2.add_program(MPL,BINARY.read_bytes());vm2.add_program(PROGRAM,OUR_BINARY.read_bytes());vm2.airdrop(CREATOR.pubkey(),10_000_000_000);vm2.airdrop(RELAYER.pubkey(),1_000_000_000);vm2.airdrop(TREASURY,1_000_000)
    cfg[9]=0;vm2.set_account(config,Account(10_000_000,bytes(cfg),PROGRAM))
    failure=outcome(vm2.send_transaction(Transaction([CREATOR,MINT,RELAYER],Message(instructions,CREATOR.pubkey()),vm2.latest_blockhash())))
    assert not failure['ok'] and vm2.get_account(MINT.pubkey()) is None and vm2.get_account(metadata) is None,failure
    checks.append(('failed custody init rolls back mint and metadata creation atomically',True))
    return {'localOnly':True,'realFundsUsed':False,'testCount':len(checks),'tests':[{'name':n,'passed':v} for n,v in checks],
      'metadataProgramSha256':hashlib.sha256(BINARY.read_bytes()).hexdigest(),'curveProgramSha256':hashlib.sha256(OUR_BINARY.read_bytes()).hexdigest(),
      'transactionBytes':len(bytes(tx)),'computeUnits':result['units'],'metadata':parsed,'creatorDebitLamports':payer_debit,'deposits':deposits}
if __name__=='__main__':
    report=run();(ROOT/'metadata-security-results.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
