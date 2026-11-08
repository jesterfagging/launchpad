"""Independent public custody adversarial execution tests, local VM only."""
import importlib.util,json,hashlib,pathlib
from solders.account import Account
from solders.clock import Clock
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('public_vm',ROOT/'tests/public_vm.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def changed(instruction,index,key=None,signer=None):
    accounts=list(instruction.accounts);old=accounts[index]
    accounts[index]=m.meta(key or old.pubkey,old.is_writable,old.is_signer if signer is None else signer)
    return m.ix(instruction.program_id,instruction.data,accounts)
def run():
    checks=[]
    def check(ok,label,detail=None):
        assert ok,(label,detail);checks.append({'name':label,'passed':True})
    s=m.Scenario();t=m.Scenario(vm=s.vm,mint_seed=79)
    check(s.init['ok'] and t.init['ok'],'two separate launch PDAs initialize')
    # A valid instruction cannot be repointed at another funded launch.
    check(s.buy(1_000_000_000,trader=m.USER)['ok'] and t.buy(2_000_000_000,trader=m.USER)['ok'],'both independent launches receive unrelated trader funds')
    for index,replacement,label in [(1,t.state,'state'),(2,t.auth,'SOL vault'),(3,t.mint,'mint'),(4,t.vault,'token vault')]:
        before=(s.snapshot(),t.snapshot());r=s.send([changed(s.tradeix(False,1,trader=m.USER.pubkey()),index,replacement)],[m.USER])
        check(not r['ok'] and before==(s.snapshot(),t.snapshot()),'cross-launch '+label+' substitution rejects atomically',r)
    # Config is an authenticated program PDA; attacker-owned lookalikes fail.
    fresh=m.Scenario(initialize=False)
    original=fresh.vm.get_account(fresh.config)
    fresh.vm.set_account(fresh.config,Account(original.lamports,bytes(original.data),m.SYS))
    r=fresh.send([fresh.initix],[m.CREATOR,m.RELAYER]);check(not r['ok'],'system-owned configuration lookalike cannot authorize a launch',r)
    fresh.vm.set_account(fresh.config,original)
    r=fresh.send([changed(fresh.initix,10,signer=False)],[m.CREATOR]);check(not r['ok'],'creator cannot initialize without relayer price signature',r)
    r=fresh.send([changed(fresh.initix,10,m.OTHER.pubkey())],[m.CREATOR,m.OTHER]);check(not r['ok'],'unconfigured cosigner cannot attest launch price',r)
    clock=fresh.vm.get_clock();fresh.vm.set_clock(Clock(clock.slot,clock.epoch_start_timestamp,clock.epoch,clock.leader_schedule_epoch,fresh.expiry+1))
    r=fresh.send([fresh.initix],[m.CREATOR,m.RELAYER]);check(not r['ok'],'expired relayer price approval cannot initialize',r)
    # Migration may not redirect another launch's vault, pool assets or fee target.
    check(s.buy()['ok'],'primary launch reaches migration cap')
    for index,replacement,label in [(2,t.auth,'custody'),(4,t.vault,'source tokens'),(5,m.OTHER.pubkey(),'treasury'),(12,t.pb,'pool token vault'),(13,t.pq,'pool quote vault')]:
        before=(s.snapshot(),t.snapshot());r=s.send([s.migrateix((index,replacement))],[m.RELAYER])
        check(not r['ok'] and before==(s.snapshot(),t.snapshot()),'migration '+label+' substitution rejects atomically',r)
    # Even a failure after burn cannot leave a half-created pool/fee charged.
    f=m.Scenario();check(f.buy()['ok'],'post-burn rollback fixture reaches graduation')
    f.vm.set_account(m.TREASURY,Account(2**64-1,bytes(),m.SYS));before=f.snapshot();r=f.migrate()
    check(not r['ok'] and any('Burn' in log for log in r['logs']) and before==f.snapshot(),'failure after LP burn rolls back pool, reserves, fee and phase',r)
    return {'localOnly':True,'realFundsUsed':False,'programSha256':hashlib.sha256(m.OUR_BINARY.read_bytes()).hexdigest(),'testCount':len(checks),'tests':checks}
if __name__=='__main__':
    report=run();(ROOT/'adversarial-security-results.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
