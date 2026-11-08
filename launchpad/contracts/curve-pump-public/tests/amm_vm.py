"""Execute generated public AMM client instructions using actual venue programs."""
import base64,hashlib,json,os,pathlib,struct,sys
from solders.litesvm import LiteSVM
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.account import Account
from solders.instruction import Instruction,AccountMeta
from solders.message import Message
from solders.transaction import Transaction
from solders.compute_budget import set_compute_unit_limit,set_compute_unit_price
ROOT=pathlib.Path(__file__).resolve().parents[1];P=Pubkey.from_string
PUMP=P('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');FEES=P('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');TOKEN=P('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');ATA=P('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');WSOL=P('So11111111111111111111111111111111111111112')
def outcome(r):
 try:return {'ok':False,'error':str(r.err()),'logs':r.meta().logs(),'units':r.meta().compute_units_consumed()}
 except AttributeError:return {'ok':True,'logs':r.logs(),'units':r.compute_units_consumed()}
def amount(vm,key):
 a=vm.get_account(key);return 0 if a is None else struct.unpack_from('<Q',a.data,64)[0]
def run():
 fixture=json.loads(pathlib.Path('/tmp/public-pool-vm-fixtures.json').read_text());extra=json.loads(pathlib.Path('/tmp/launchpad-public-amm-proof/rpc-accounts.json').read_text());trades=json.loads(pathlib.Path(os.environ.get('LAUNCHPAD_AMM_VM_TRADES','/tmp/public-amm-trades.json')).read_text());results=[]
 for trade in trades['trades']:
  vm=LiteSVM();vm.add_program(PUMP,pathlib.Path('/tmp/pumpswap-tax-audit/pump-mainnet.so').read_bytes());vm.add_program(FEES,pathlib.Path('/tmp/launchpad-public-amm-proof/pump-fees.so').read_bytes());vm.add_program(P(fixture['programId']),(ROOT/'artifacts/curve_pump_public.so').read_bytes())
  for k,a in {**extra,**fixture['accounts']}.items():
   if a and not a.get('executable'):vm.set_account(P(k),Account(a['lamports'],base64.b64decode(a['data'][0]),P(a['owner']),False,a.get('rentEpoch',a.get('rent_epoch',0))))
  trader=Keypair.from_seed(bytes([72 if trade['side']=='buy' else 71])*32);user=trader.pubkey();assert str(user)==trade['wallet'];mint=P(fixture['mint']);base=Pubkey.find_program_address([bytes(user),bytes(TOKEN),bytes(mint)],ATA)[0];wsol=Pubkey.find_program_address([bytes(user),bytes(TOKEN),bytes(WSOL)],ATA)[0]
  # Existing wrapped SOL account deliberately has a nonzero balance: helpers may
  # only spend/close their newly created temporary WSOL account.
  raw=bytearray(165);raw[:32]=bytes(WSOL);raw[32:64]=bytes(user);struct.pack_into('<Q',raw,64,12345678);raw[108]=1;struct.pack_into('<I',raw,109,1);struct.pack_into('<Q',raw,113,2039280);vm.set_account(wsol,Account(12345678+2039280,bytes(raw),TOKEN))
  native_before=vm.get_account(user).lamports;base_before=amount(vm,base);wsol_before=vm.get_account(wsol)
  ixs=[Instruction(P(i['programId']),base64.b64decode(i['data']),[AccountMeta(P(k['pubkey']),k['isSigner'],k['isWritable']) for k in i['keys']]) for i in trade['instructions']]
  vm.expire_blockhash();tx=Transaction([trader],Message([set_compute_unit_limit(800000),set_compute_unit_price(2000)]+ixs,user),vm.latest_blockhash());result=outcome(vm.send_transaction(tx));assert result['ok'],(trade['side'],result)
  after=vm.get_account(user).lamports;minimum=int(trade['quote']['minimumOutputRaw']);costs=int(trade['quote']['rentLamports'])+int(trade['quote']['networkFeeLamports']);spent=int(trade['quote']['amountRaw'])
  if trade['side']=='buy':assert amount(vm,base)-base_before>=minimum and native_before-after<=spent+costs
  else:assert base_before-amount(vm,base)==spent and after-native_before+costs>=minimum
  assert vm.get_account(wsol)==wsol_before
  temporary=ixs[0].accounts[1].pubkey;assert vm.get_account(temporary) is None
  results.append({'side':trade['side'],'passed':True,'computeUnits':result['units'],'transactionBytes':len(bytes(tx)),'nativeDeltaLamports':after-native_before,'baseDeltaAtoms':amount(vm,base)-base_before,'existingWsolUnchanged':True,'temporaryWsolClosed':True})
 return {'realFundsUsed':False,'pumpSha256':hashlib.sha256(pathlib.Path('/tmp/pumpswap-tax-audit/pump-mainnet.so').read_bytes()).hexdigest(),'feeProgramSha256':hashlib.sha256(pathlib.Path('/tmp/launchpad-public-amm-proof/pump-fees.so').read_bytes()).hexdigest(),'tests':results}
if __name__=='__main__':
 report=run();(ROOT/'amm-vm-results.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
