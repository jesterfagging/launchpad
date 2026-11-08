"""Actual executable: creator account changes cannot veto holder exits or redirect fees."""
import hashlib, json, pathlib
import public_vm as m
from solders.account import Account
from solders.system_program import assign, AssignParams, allocate, AllocateParams

ROOT = pathlib.Path(__file__).resolve().parents[1]
results = []

def check(ok, name, detail=None):
    assert ok, (name, detail)
    results.append({'name': name, 'passed': True})

def claim(s, recipient=None):
    return s.send([m.ix(m.PROGRAM, b'\x05', [m.meta(m.RELAYER.pubkey(), True, True),
        m.meta(s.state, True), m.meta(recipient or m.CREATOR.pubkey(), True)])], [m.RELAYER])

def run():
    creator = m.CREATOR.pubkey()
    for kind in ['assigned', 'allocated']:
        s = m.Scenario()
        mutation = (assign(AssignParams(pubkey=creator, owner=m.PUMP)) if kind == 'assigned'
            else allocate(AllocateParams(pubkey=creator, space=512)))
        r = s.send([mutation])
        check(r['ok'], f'creator can sign a real {kind} account transition', r)
        before = s.vm.get_account(creator)
        r = s.buy(1_000_000_000, trader=m.USER)
        after = s.vm.get_account(creator)
        check(r['ok'] and after.lamports > before.lamports and after.owner == before.owner
            and bytes(after.data) == bytes(before.data), f'{kind} creator cannot block buy or alter payout destination', r)
        held = m.token_amount(s.vm, s.otheruser)
        r = s.sell(held // 2, trader=m.USER)
        check(r['ok'], f'{kind} creator cannot block an unrelated holder exit', r)
        before = s.vm.get_account(creator).lamports
        r = claim(s)
        check(r['ok'] and s.vm.get_account(creator).lamports == before,
            f'{kind} creator settlement is accepted and cannot pay twice', r)
        r = s.buy(trader=m.USER)
        check(r['ok'] and s.saved()['phase'] == 1, f'{kind} creator does not block bonding', r)
        r = s.migrate()
        check(r['ok'] and m.token_amount(s.vm, s.lpata) == 0 and s.saved()['lpBurned'] > 0,
            f'{kind} creator does not block atomic custody LP burn', r)

    # A pre-existing rent-paying recipient is an intentionally hostile VM fixture.
    # Every trade and claim below executes real transactions with real signatures.
    s = m.Scenario()
    s.vm.set_account(creator, Account(500_000, bytes(512), m.PUMP))
    before = s.vm.get_account(creator)
    r = s.buy(250_000_000, trader=m.USER)
    pending = m.u64(s.data(), 272)
    check(r['ok'] and pending > 0 and s.vm.get_account(creator).lamports == before.lamports,
        'allocated rent-paying recipient queues credits instead of aborting holder trades', r)
    state_rent = s.vm.minimum_balance_for_rent_exemption(len(s.data()))
    check(s.vm.get_account(s.state).lamports >= state_rent + pending,
        'creator credit is fully backed separately from state rent and curve vault')
    before_claim = s.snapshot()
    r = claim(s)
    check(r['ok'] and s.snapshot() == before_claim and m.u64(s.data(), 272) == pending,
        'claim below actual recipient data rent leaves accrued credit intact', r)
    before_claim = s.snapshot()
    r = claim(s, m.OTHER.pubkey())
    check(not r['ok'] and s.snapshot() == before_claim,
        'owner flexibility never permits substitution of the immutable creator')
    s.vm.airdrop(creator, 10_000_000)
    before = s.vm.get_account(creator).lamports
    r = claim(s)
    check(r['ok'] and s.vm.get_account(creator).lamports == before + pending and m.u64(s.data(), 272) == 0,
        'funded allocated recipient receives exactly its queued credit', r)
    before = s.vm.get_account(creator).lamports
    r = claim(s)
    check(r['ok'] and s.vm.get_account(creator).lamports == before,
        'allocated creator cannot replay settlement to drain state rent', r)
    return {'realFundsUsed': False, 'programSha256': hashlib.sha256(m.OUR_BINARY.read_bytes()).hexdigest(),
        'testCount': len(results), 'tests': results}

if __name__ == '__main__':
    report = run()
    (ROOT / 'creator-account-security-results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
