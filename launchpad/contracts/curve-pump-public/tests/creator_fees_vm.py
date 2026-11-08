"""Actual public executable: fixed creator/protocol splits and rent-safe payouts."""
import hashlib,json,pathlib,struct
import public_vm as m
from solders.account import Account
ROOT=pathlib.Path(__file__).resolve().parents[1]
results=[];quotes=[]
def check(ok,name):
    assert ok,name
    results.append({'name':name,'passed':True})
def balance(s,k): return s.vm.get_account(k).lamports
def claim(s,recipient=None):
    return s.send([m.ix(m.PROGRAM,b'\x05',[m.meta(m.RELAYER.pubkey(),True,True),m.meta(s.state,True),m.meta(recipient or m.CREATOR.pubkey(),True)])],[m.RELAYER])
def run():
    s=m.Scenario();creator=m.CREATOR.pubkey();trader=m.USER.pubkey()
    before=s.saved();c=balance(s,creator);t=balance(s,m.TREASURY);u=balance(s,trader)
    r=s.buy(1_000_000_000,trader=m.USER);check(r['ok'],'unrelated wallet buy succeeds with creator payment')
    after=s.saved();net=after['quote']-before['quote'];gross=(net*10000+9849)//9850;cf=gross*50//10000;pf=gross-net-cf
    quotes.append({'side':'buy','amount':'1000000000','before':before,'output':str(m.token_amount(s.vm,s.otheruser)),'charged':str(gross),'creatorFee':str(cf),'protocolFee':str(pf)})
    check(balance(s,creator)-c==cf and cf>0,'buy pays creator 50 bps of charged SOL, rounded down')
    check(balance(s,m.TREASURY)-t==pf and abs(pf-gross*100//10000)<=2,'buy pays treasury 100 bps plus sub-lamport rounding')
    check(m.u64(s.data(),272)==0 and m.u64(s.data(),280)==cf,'paid creator fee is recorded without a pending credit')
    held=m.token_amount(s.vm,s.otheruser);before=s.saved();c=balance(s,creator);t=balance(s,m.TREASURY)
    amount=held//3;gross=before['vq']*amount//(before['vb']+amount);total=(gross*150+9999)//10000;cf=gross*50//10000
    r=s.sell(amount,trader=m.USER);check(r['ok'],'unrelated wallet sell succeeds with creator payment')
    quotes.append({'side':'sell','amount':str(amount),'before':before,'output':str(gross-total),'charged':str(amount),'creatorFee':str(cf),'protocolFee':str(total-cf)})
    check(balance(s,creator)-c==cf and balance(s,m.TREASURY)-t==total-cf,'sell pays the same 0.5 percent creator and 1 percent protocol split')
    before=s.snapshot();r=s.send([s.tradeix(True,1000000000,trader=trader,creator=m.OTHER.pubkey())],[m.USER])
    check(not r['ok'] and s.snapshot()==before,'trade cannot substitute a creator fee recipient')
    check(s.buy(1000000000)['ok'],'creator can buy their own coin without account alias failure')
    # Emulate a creator emptying their system wallet; the trade payer is unrelated.
    s.vm.set_account(creator,Account(0,b'',m.SYS));before=s.saved();r=s.buy(1_000_000,trader=m.USER)
    check(r['ok'] and m.u64(s.data(),272)>0,'small payout to an empty creator is queued without blocking trades')
    pending=m.u64(s.data(),272);before=s.snapshot();r=claim(s,m.OTHER.pubkey())
    check(not r['ok'] and before==s.snapshot(),'permissionless settlement cannot redirect queued creator fees')
    check(claim(s)['ok'] and m.u64(s.data(),272)==pending,'below-rent settlement keeps the complete credit safe')
    s.vm.airdrop(creator,1_000_000);c=balance(s,creator);r=claim(s)
    check(r['ok'] and balance(s,creator)-c==pending and m.u64(s.data(),272)==0,'relayer automatically settles exact queued fees once recipient can receive')
    before=balance(s,creator);check(claim(s)['ok'] and balance(s,creator)==before,'settlement replay cannot pay twice')
    check(s.buy(trader=m.USER)['ok'],'creator-fee model still reaches the original supply cap')
    quote=s.saved()['quote'];t=balance(s,m.TREASURY);c=balance(s,creator);r=s.migrate()
    check(r['ok'] and balance(s,m.TREASURY)-t==(quote*2885+9999)//10000,'graduation fee goes to exactly the same protocol treasury')
    check(balance(s,creator)==c and m.token_amount(s.vm,s.lpata)==0,'graduation does not pay another creator fee and burns all custody LP')
    return {'realFundsUsed':False,'programSha256':hashlib.sha256(m.OUR_BINARY.read_bytes()).hexdigest(),'testCount':len(results),'quotes':quotes,'tests':results}
if __name__=='__main__':
    report=run();(ROOT/'creator-fees-vm-results.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
