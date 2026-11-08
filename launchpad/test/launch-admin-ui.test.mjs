import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createLaunchAdmin } from '../public/launch-admin-ui.mjs';

const sample = () => ({ accountId: 'a'.repeat(32), id: 'b'.repeat(32), name: '<img src=x onerror=alert(1)>', symbol: 'COIN', mint: 'mint', username: 'creator', recipient: 'old-wallet', feeMode: 'creator', eligibility: { allowed: true, reason: '' }, history: [] });
function dom(t) {
  const prior = globalThis.document, { document } = parseHTML('<html><head></head><body></body></html>'); globalThis.document = document;
  t.after(() => { globalThis.document = prior; }); return document;
}
const result = row => ({ launches: [row], total: 1, offset: 0, nextOffset: null });

test('admin reward rows show automatic retry time only while automation is enabled and waiting',async t=>{
  dom(t);const at=Date.now()+3600000,row={...sample(),feeMode:'holders',rewardsAction:{kind:'distribute',allowed:true,autoFees:true},rewardRetry:{at,attempt:2,kind:'sell',reason:'RPC timeout'},serviceStage:'route',state:'live'};
  const ui=createLaunchAdmin({api:async()=>result(row),security:{},getAccount:()=>({id:'admin',role:'admin',mfaEnabled:true}),message(){}});await ui.load();
  const text=ui.element.querySelector('.launch-admin-reward').textContent;assert.match(text,/Rewards will retry automatically at/);assert(text.includes(new Date(at).toLocaleString()));assert.doesNotMatch(text,/Checking pending/);
  row.rewardsAction.autoFees=false;await ui.load();assert.doesNotMatch(ui.element.textContent,/Rewards will retry automatically/);
  row.rewardsAction.autoFees=true;row.rewardRetry.at=Date.now()-1000;await ui.load();assert.doesNotMatch(ui.element.textContent,/Rewards will retry automatically/);
});

test('admin shows the retry reason and reserved rewards as text without exposing controls or causing payments',async t=>{
  dom(t);let writes=0;
  const row={...sample(),feeMode:'holders',rewardsAction:{kind:'distribute',allowed:false,autoFees:true},rewardsAutomation:{enabled:true},rewardRetry:{at:Date.now()+300000,reason:'<img src=x onerror=alert(1)> rent check'},deferredRewards:{wallets:2,amount:'0.0002'}};
  const ui=createLaunchAdmin({api:async(_,body)=>{if(body)writes++;return result(row);},security:{},getAccount:()=>({id:'admin',role:'admin',mfaEnabled:true}),message(){}});
  await ui.load();const section=ui.element.querySelector('.launch-admin-reward');
  assert.match(section.querySelector('.launch-admin-retry-reason').textContent,/Last retry reason: <img/);
  assert.equal(section.querySelector('img,script'),null);
  assert.match(section.querySelector('.launch-admin-deferred-rewards').textContent,/0.0002 SOL is still owed to 2 wallets/);
  assert.match(section.textContent,/Rewards stay reserved until payout checks pass, including Solana’s minimum receiving-wallet balance/);
  assert.match(section.textContent,/Automatic checks are enabled/);
  assert.doesNotMatch(section.textContent,/Other holders continue receiving payouts/);
  row.rewardsAutomation.enabled=false;await ui.load();const paused=ui.element.querySelector('.launch-admin-deferred-rewards').textContent;
  assert.match(paused,/Enable automatic rewards or use Distribute now to recheck/);assert.doesNotMatch(paused,/Automatic checks are enabled/);
  row.deferredRewards={unavailable:true};await ui.load();assert.match(ui.element.textContent,/Reserved holder rewards need an accounting review/);assert.equal(ui.element.querySelector('.launch-admin-deferred-rewards'),null);
  assert.equal(writes,0);
});

test('admin UI renders untrusted launch text safely and requires fresh identity proof for recipient change', async t => {
  const document = dom(t), row = sample(), posts = [], authorizations = [], messages = [];
  const ui = createLaunchAdmin({ api: async (path, body) => { if (body) { posts.push({ path, body }); return {}; } return result(row); }, security: { authorize: async (...args) => { authorizations.push(args); return { password: 'test-password', code: '123456' }; } }, getAccount: () => ({ id: 'admin', role: 'admin', mfaEnabled: true }), message: text => messages.push(text) });
  document.body.append(ui.element); await ui.load();
  assert.equal(ui.element.querySelector('.launch-admin-create a').getAttribute('href'),'/launchpad?admin=1');
  assert.match(ui.element.querySelector('.launch-admin-create').textContent,/\$100,000/);
  assert.equal(ui.element.querySelector('img'), null); assert(ui.element.textContent.includes(row.name));
  const form = ui.element.querySelector('.launch-admin-row form'); form.querySelector('input').value = '9J7iw6jVxqPoiBMXWsWRNAsgFT9qkkkVHyAS26euwoBq'; form.querySelector('textarea').value = 'Approved community takeover.';
  await form.onsubmit({ preventDefault() {} });
  assert.equal(authorizations.length, 1); assert.equal(authorizations[0][1].requireCode, true);
  assert.deepEqual(posts, [{ path: '/api/admin/launches/recipient', body: { accountId: row.accountId, id: row.id, recipient: '9J7iw6jVxqPoiBMXWsWRNAsgFT9qkkkVHyAS26euwoBq', expectedRecipient: 'old-wallet', expectedMode: 'creator', reason: 'Approved community takeover.', password: 'test-password', code: '123456' } }]);
  assert(!document.body.textContent.includes('test-password')); assert(messages.includes('Creator fee recipient updated.'));
});

test('closing administration while identity confirmation is pending cancels the recipient mutation', async t => {
  dom(t); let confirm, posts = 0;
  const ui = createLaunchAdmin({ api: async (path, body) => { if (body) posts++; return result(sample()); }, security: { authorize: () => new Promise(resolve => { confirm = resolve; }) }, getAccount: () => ({ id: 'admin', role: 'admin', mfaEnabled: true }), message() {} });
  await ui.load(); const form = ui.element.querySelector('.launch-admin-row form'); form.querySelector('input').value = '9J7iw6jVxqPoiBMXWsWRNAsgFT9qkkkVHyAS26euwoBq'; form.querySelector('textarea').value = 'Approved takeover.';
  const pending = form.onsubmit({ preventDefault() {} }); ui.clear(); confirm({ password: 'test-password', code: '123456' }); await pending;
  assert.equal(posts, 0); assert.equal(ui.element.hidden, true); assert.equal(ui.element.querySelectorAll('.launch-admin-row').length, 0);
});

test('non-admin accounts never request private launch inventory and restricted coins have no editor', async t => {
  dom(t); let reads = 0, account = { id: 'user', role: 'user', mfaEnabled: true };
  const row = sample(); row.eligibility = { allowed: false, reason: 'The connected creator wallet controls these fees.' };
  const ui = createLaunchAdmin({ api: async () => { reads++; return result(row); }, security: {}, getAccount: () => account, message() {} });
  await ui.load(); assert.equal(reads, 0); assert.equal(ui.element.hidden, true);
  account = { id: 'admin', role: 'admin', mfaEnabled: true }; await ui.load(); assert.equal(reads, 1);
  assert.equal(ui.element.querySelector('.launch-admin-row form:not(.launch-admin-visibility)'), null); assert(ui.element.textContent.includes(row.eligibility.reason));
  account.role = 'user'; await ui.load(); assert.equal(reads, 1); assert.equal(ui.element.querySelectorAll('.launch-admin-row').length, 0);
});

test('manual holder distributions and buybacks use fresh proof and an idempotent request ID without bypassing limits',async t=>{
  const document=dom(t);
  for(const kind of ['distribute','buyback']){const row={...sample(),feeMode:kind==='distribute'?'holders':'buyback',rewardsAction:{kind,allowed:true,reason:'',busy:false},credits:{quote:'12.3',base:'500'},quoteSymbol:'USDC'},posts=[],authorizations=[];const ui=createLaunchAdmin({api:async(path,body)=>{if(body){posts.push({path,body});return{status:'queued',message:'Manual action queued.'};}return result(row);},security:{authorize:async(...args)=>{authorizations.push(args);return{password:'test-password',code:'123456'};}},getAccount:()=>({id:'admin',role:'admin',mfaEnabled:true}),message(){}});document.body.append(ui.element);await ui.load();const form=ui.element.querySelector('.launch-admin-reward form');form.querySelector('input').value='Operator requested reward run.';await form.onsubmit({preventDefault(){}});assert.equal(authorizations[0][1].requireCode,true);assert.equal(posts[0].path,'/api/admin/launches/action');assert.equal(posts[0].body.action,kind);assert.match(posts[0].body.requestId,/^[a-f0-9]{32}$/);assert.equal(posts[0].body.accountId,row.accountId);assert.match(ui.element.textContent,/12.3 USDC available/);assert(!ui.element.textContent.includes('test-password'));ui.element.remove();}
});

test('unavailable bulk distribution routes release controls and preserve retry identities without claiming a queued run',async t=>{
  const document=dom(t),posts=[],messages=[],row={...sample(),feeMode:'holders',rewardsAction:{kind:'distribute',allowed:true}};
  let manualAttempts=0;
  const ui=createLaunchAdmin({api:async(path,body)=>{
    if(body)posts.push({path,body});
    if(path==='/api/admin/holder-distributions'||path==='/api/admin/launches/action'&&++manualAttempts===1)throw Object.assign(Error('Not found.'),{statusCode:404});
    if(body)return{status:'queued',message:'Manual action queued.'};
    return result(row);
  },security:{authorize:async()=>({password:'test-password',code:'123456'})},getAccount:()=>({id:'admin',role:'admin',mfaEnabled:true}),message:(...args)=>messages.push(args),setTimer:()=>1,clearTimer(){}});
  document.body.append(ui.element);t.after(()=>ui.clear());await ui.load();
  const all=ui.element.querySelector('[data-admin-distribute-all]');
  await ui.refreshDistributions();assert.equal(all.disabled,false);
  for(let attempt=0;attempt<2;attempt++){
    await all.onclick();await ui.refreshDistributions();
    assert.equal(all.textContent,'Retry distribute all');assert.equal(all.disabled,false);
    assert.equal(ui.element.querySelector('[data-view=archived]').disabled,false);
    assert.equal(ui.element.querySelector('.launch-admin-reward button').disabled,false);
    assert.match(ui.element.querySelector('[aria-label="Bulk holder distributions"]').textContent,/Distribution status is temporarily unavailable\. Not found\./);
    assert.doesNotMatch(ui.element.querySelector('[aria-label="Bulk holder distributions"]').textContent,/Distributions queued|Distributions processing|Distribution run finished/);
  }
  const bulkPosts=posts.filter(post=>post.path==='/api/admin/holder-distributions');assert.equal(bulkPosts.length,2);assert.equal(bulkPosts[0].body.requestId,bulkPosts[1].body.requestId);
  const form=ui.element.querySelector('.launch-admin-reward form');form.querySelector('input').value='Operator requested reward run.';
  await form.onsubmit({preventDefault(){}});assert.equal(form.querySelector('button').disabled,false);assert.deepEqual(messages.at(-1),['Not found.',true]);
  await form.onsubmit({preventDefault(){}});const manualPosts=posts.filter(post=>post.path==='/api/admin/launches/action');assert.equal(manualPosts.length,2);assert.equal(manualPosts[0].body.requestId,manualPosts[1].body.requestId);assert.deepEqual(messages.at(-1),['Manual action queued.']);
  assert.equal(ui.element.querySelector('.launch-admin-reward button').disabled,false);
});

test('unavailable manual reward action stays disabled and does not call authorization',async t=>{
  dom(t);let authorized=0;const row={...sample(),rewardsAction:{kind:'distribute',allowed:false,reason:'A cycle is already running.',busy:true}};const ui=createLaunchAdmin({api:async()=>result(row),security:{authorize:async()=>{authorized++;}},getAccount:()=>({id:'admin',role:'admin',mfaEnabled:true}),message(){}});await ui.load();const form=ui.element.querySelector('.launch-admin-reward form');assert.equal(form.querySelector('button').disabled,true);await form.onsubmit({preventDefault(){}});assert.equal(authorized,0);assert.match(ui.element.textContent,/cycle is already running/);
});

test('pending reward transaction replaces stale cycle state and links the exact mainnet receipt without submitting work', async t => {
  dom(t); let writes = 0;
  const signature = '3'.repeat(88), row = { ...sample(), network: 'mainnet-beta', state: 'live', serviceStage: 'distribute', feeMode: 'buyback', rewardsAction: { kind: 'buyback', allowed: true }, pendingOperation: { kind: 'buy', state: 'pending', signature, createdAt: 12345, reason: 'Checking transaction history.' } };
  const ui = createLaunchAdmin({ api: async (path, body) => { if (body) writes++; return result(row); }, security: {}, getAccount: () => ({ id: 'admin', role: 'admin', mfaEnabled: true }), message() {} });
  await ui.load();
  const section = ui.element.querySelector('.launch-admin-reward'), pending = section.querySelector('.launch-admin-pending'), link = pending.querySelector('a');
  assert.match(pending.textContent, /Checking pending buy transaction/);
  assert.match(pending.textContent, /Checking transaction history/);
  assert.match(pending.textContent, /saved transaction before preparing another/);
  assert(!section.textContent.includes('Saved step: distribute'));
  assert.equal(link.href, 'https://solscan.io/tx/' + signature);
  assert(link.textContent.includes(signature));
  assert.equal(link.target, '_blank'); assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(writes, 0);
});

test('pending transaction display safely handles hostile data, missing signatures and archived networks', async t => {
  dom(t);
  const row = { ...sample(), network: 'mainnet-beta', feeMode: 'buyback', rewardsAction: { kind: 'buyback', allowed: true }, pendingOperation: { kind: '<img src=x onerror=alert(1)>', state: 'awaiting_signature', signature: 'javascript:alert(1)', createdAt: 'invalid', reason: '<script>alert(1)</script>' } };
  const ui = createLaunchAdmin({ api: async () => result(row), security: {}, getAccount: () => ({ id: 'admin', role: 'admin', mfaEnabled: true }), message() {} });
  await ui.load();
  let pending = ui.element.querySelector('.launch-admin-pending');
  assert.match(pending.textContent, /Waiting for wallet approval/);
  assert(pending.textContent.includes(row.pendingOperation.kind));
  assert(pending.textContent.includes(row.pendingOperation.reason));
  assert.equal(pending.querySelector('a, img, script'), null);
  assert(!pending.textContent.includes('Invalid Date'));
  row.pendingOperation = { kind: 'burn', state: 'pending', signature: '3'.repeat(88), createdAt: null };
  row.network = 'devnet'; await ui.load();
  pending = ui.element.querySelector('.launch-admin-pending');
  assert.match(pending.textContent, /Checking pending burn transaction/);
  assert.equal(pending.querySelector('a'), null);
  row.pendingOperation = null; row.serviceStage = 'claim'; row.state = 'paused'; await ui.load();
  assert.equal(ui.element.querySelector('.launch-admin-pending'), null);
  assert.match(ui.element.querySelector('.launch-admin-reward').textContent, /Saved step: claim · paused/);
});

const click = { preventDefault() {}, stopPropagation() {} };
const admin = () => ({ id: 'admin', role: 'admin', mfaEnabled: true });
function inventory(rows, path) {
  const params = new URL(path, 'https://launchpad.test').searchParams, view = params.get('view') || 'active', offset = Number(params.get('offset') || 0), search = params.get('search') || '';
  const matching = rows.filter(row => !search || `${row.name} ${row.symbol}`.includes(search)), archived = row => Boolean(row.hidden || row.manuallyArchived);
  const selected = matching.filter(row => archived(row) === (view === 'archived'));
  return { launches: selected.slice(offset, offset + 10).map(row => ({ ...row, listArchived: archived(row) })), view, counts: { active: matching.filter(row => !archived(row)).length, archived: matching.filter(archived).length }, total: selected.length, offset, nextOffset: offset + 10 < selected.length ? offset + 10 : null };
}

test('hiding a coin moves it into Archived tokens and restoring visibility returns it to Active coins', async t => {
  dom(t); const row = sample(), calls = []; let authorizations = 0;
  const ui = createLaunchAdmin({ api: async (path, body) => { calls.push({ path, body }); if (body) { row.hidden = body.hidden; return { id: body.id, hidden: row.hidden }; } return inventory([row], path); }, security: { authorize: async () => { authorizations++; } }, getAccount: admin, message() {} });
  await ui.load(); const item = ui.element.querySelector('.launch-admin-row'); assert.equal(item.hasAttribute('open'), false);
  await item.querySelector('.launch-admin-visibility-toggle').onclick(click);
  assert.equal(ui.element.querySelector('.launch-admin-row'), null);
  assert.equal(ui.element.querySelector('[data-view=active]').textContent, 'Active coins (0)'); assert.equal(ui.element.querySelector('[data-view=archived]').textContent, 'Archived tokens (1)');
  assert.equal(calls[1].path, '/api/admin/moderation/launch'); assert.deepEqual(Object.keys(calls[1].body).sort(), ['accountId', 'hidden', 'id', 'reason']); assert.equal(calls[1].body.hidden, true);
  await ui.element.querySelector('[data-view=archived]').onclick(); const hidden = ui.element.querySelector('.launch-admin-row');
  assert(hidden.querySelector('form')); assert.equal(hidden.querySelector('.launch-admin-visibility-toggle').textContent, 'Restore visibility');
  await hidden.querySelector('.launch-admin-visibility-toggle').onclick(click); assert.equal(ui.element.querySelector('.launch-admin-row'), null);
  await ui.element.querySelector('[data-view=active]').onclick(); assert.equal(ui.element.querySelector('.launch-admin-visibility-toggle').textContent, 'Hide'); assert.equal(authorizations, 0);
});

test('coin visibility rejects duplicate clicks, exposes a retryable row error, and blocks after permission loss',async t=>{
  dom(t);const row=sample();let resolve,reject,account={id:'admin',role:'admin',mfaEnabled:true},posts=0;
  const ui=createLaunchAdmin({api:async(path,body)=>{if(body){posts++;return new Promise((ok,bad)=>{resolve=value=>{row.hidden=value.hidden;ok(value);};reject=bad;});}return inventory([row],path);},security:{authorize(){throw Error('Unexpected identity prompt');}},getAccount:()=>account,message(){}});await ui.load();const button=ui.element.querySelector('summary button'),click={preventDefault(){},stopPropagation(){}};
  const first=button.onclick(click);assert.equal(button.disabled,true);assert.equal(button.textContent,'Hiding…');await button.onclick(click);assert.equal(posts,1);reject(Error('Network interrupted.'));await first;assert.equal(button.disabled,false);assert.equal(button.textContent,'Hide');assert.match(ui.element.querySelector('.launch-admin-row summary').textContent,/Network interrupted/);
  const retry=button.onclick(click);resolve({id:row.id,hidden:true});await retry;assert.equal(posts,2);assert.equal(ui.element.querySelector('.launch-admin-row'),null);
  account={role:'user',mfaEnabled:true};await button.onclick(click);assert.equal(posts,2);
});

test('late visibility responses cannot reopen or repopulate cleared administration',async t=>{
  dom(t);let resolve;const row=sample();const ui=createLaunchAdmin({api:async(path,body)=>body?new Promise(done=>{resolve=done;}):result(row),security:{},getAccount:()=>({id:'admin',role:'admin',mfaEnabled:true}),message(){throw Error('No messages after clear');}});await ui.load();
  const pending=ui.element.querySelector('summary button').onclick({preventDefault(){},stopPropagation(){}});ui.clear();resolve({id:row.id,hidden:true});await pending;assert.equal(ui.element.hidden,true);assert.equal(ui.element.querySelector('.launch-admin-row'),null);
});

test('coin search sends the entered filter and resets pagination without a mutation',async t=>{
  dom(t);const calls=[];const ui=createLaunchAdmin({api:async(path,body)=>{calls.push({path,body});return result(sample());},security:{},getAccount:()=>({id:'admin',role:'admin',mfaEnabled:true}),message(){}});await ui.load();const form=ui.element.querySelector('.launch-admin-search');form.querySelector('input').value='specific ticker';form.onsubmit({preventDefault(){}});await new Promise(resolve=>setTimeout(resolve,0));const url=new URL(calls.at(-1).path,'https://launchpad.test');assert.equal(url.searchParams.get('search'),'specific ticker');assert.equal(url.searchParams.get('offset'),'0');assert.equal(calls.at(-1).body,undefined);
});


test('archive tabs send the selected view and search before pagination and reset to page one', async t => {
  dom(t); const rows = Array.from({ length: 24 }, (_, i) => ({ ...sample(), id: String(i), name: 'Matching', manuallyArchived: i >= 12 })), calls = [];
  const ui = createLaunchAdmin({ api: async path => { calls.push(path); return inventory(rows, path); }, security: {}, getAccount: admin, message() {} }); await ui.load();
  assert.equal(ui.element.querySelector('[data-view=active]').getAttribute('aria-selected'), 'true');
  await ui.element.querySelector('.account-actions button:last-child').onclick(); assert.equal(new URL(calls.at(-1), 'https://launchpad.test').searchParams.get('offset'), '10');
  await ui.element.querySelector('[data-view=archived]').onclick(); let params = new URL(calls.at(-1), 'https://launchpad.test').searchParams;
  assert.equal(params.get('view'), 'archived'); assert.equal(params.get('offset'), '0'); assert.equal(params.get('limit'), '10');
  assert.equal(ui.element.querySelector('.launch-admin-list').getAttribute('aria-label'), 'Archived tokens'); assert.equal(ui.element.querySelector('[data-view=archived]').textContent, 'Archived tokens (12)');
  ui.element.querySelector('input[type=search]').value = 'Matching'; await ui.element.querySelector('.launch-admin-search').onsubmit(click); params = new URL(calls.at(-1), 'https://launchpad.test').searchParams; assert.equal(params.get('view'), 'archived'); assert.equal(params.get('search'), 'Matching'); assert.equal(params.get('offset'), '0');
});

test('eligible failed requests archive and restore without a reason or a new identity prompt', async t => {
  dom(t); const row = { ...sample(), state: 'failed', canArchive: true, canRestore: false, manuallyArchived: false }, posts = [];
  const ui = createLaunchAdmin({ api: async (path, body) => { if (!body) return inventory([row], path); posts.push({ path, body }); row.manuallyArchived = body.archived; row.canArchive = !body.archived; row.canRestore = body.archived; return { launch: { ...row, listArchived: body.archived } }; }, security: { authorize() { throw Error('Unexpected authorization'); } }, getAccount: admin, message() {} });
  await ui.load(); await ui.element.querySelector('.launch-admin-archive-toggle').onclick(click); assert.equal(ui.element.querySelector('.launch-admin-row'), null);
  assert.deepEqual(posts[0], { path: '/api/admin/launches/archive', body: { accountId: row.accountId, id: row.id, archived: true } });
  await ui.element.querySelector('[data-view=archived]').onclick(); assert.equal(ui.element.querySelector('.launch-admin-archive-toggle').textContent, 'Restore request');
  await ui.element.querySelector('.launch-admin-archive-toggle').onclick(click); assert.equal(ui.element.querySelector('.launch-admin-row'), null); assert.equal(posts[1].body.archived, false);
  await ui.element.querySelector('[data-view=active]').onclick(); assert.equal(ui.element.querySelector('.launch-admin-archive-toggle').textContent, 'Archive request');
});

test('hidden live tokens retain reward operations and manual archive restoration is separate from visibility', async t => {
  dom(t); const row = { ...sample(), hidden: true, manuallyArchived: true, canRestore: true, feeMode: 'holders', rewardsAction: { kind: 'distribute', allowed: true } }, messages = [];
  const ui = createLaunchAdmin({ api: async (path, body) => { if (!body) return inventory([row], path); if (path.endsWith('/archive')) { row.manuallyArchived = body.archived; row.canRestore = false; return { launch: row }; } row.hidden = body.hidden; return { id: row.id, hidden: row.hidden }; }, security: {}, getAccount: admin, message: text => messages.push(text) });
  await ui.load(); await ui.element.querySelector('[data-view=archived]').onclick(); assert(ui.element.querySelector('.launch-admin-reward form')); assert.equal(ui.element.querySelector('.launch-admin-reward button').disabled, false);
  await ui.element.querySelector('.launch-admin-archive-toggle').onclick(click); assert(ui.element.querySelector('.launch-admin-row')); assert.match(messages.at(-1), /hidden coin remains/); assert.equal(ui.element.querySelector('.launch-admin-archive-toggle'), null); assert(ui.element.querySelector('.launch-admin-reward form'));
  await ui.element.querySelector('.launch-admin-visibility-toggle').onclick(click); assert.equal(ui.element.querySelector('.launch-admin-row'), null);
});

test('ineligible archive actions remain absent and archive reasons are text only', async t => {
  dom(t); const row = { ...sample(), archiveReason: '<img src=x onerror=alert(1)>', archived: true, manuallyArchived: false, canArchive: false, canRestore: false };
  const ui = createLaunchAdmin({ api: async path => inventory([row], path), security: {}, getAccount: admin, message() {} }); await ui.load(); assert.equal(ui.element.querySelector('.launch-admin-archive-toggle'), null); assert(ui.element.textContent.includes(row.archiveReason)); assert.equal(ui.element.querySelector('img'), null); assert.equal(ui.element.querySelector('[data-view=active]').textContent, 'Active coins (1)');
});

test('archive mutations reject duplicates, block navigation, and preserve errors for retry', async t => {
  dom(t); const row = { ...sample(), canArchive: true }; let reject, resolve, writes = 0, reads = 0;
  const ui = createLaunchAdmin({ api: async (path, body) => { if (body) { writes++; return new Promise((ok, bad) => { resolve = ok; reject = bad; }); } reads++; return inventory([row], path); }, security: {}, getAccount: admin, message() {} }); await ui.load(); const button = ui.element.querySelector('.launch-admin-archive-toggle'); const first = button.onclick(click); await button.onclick(click); await ui.load(); await ui.element.querySelector('[data-view=archived]').onclick(); assert.equal(writes, 1); assert.equal(reads, 1); assert.equal(button.disabled, true); assert.equal(ui.element.querySelector('[data-view=archived]').disabled, true);
  reject(Error('Network interrupted.')); await first; assert.equal(button.disabled, false); assert.match(ui.element.querySelector('.launch-admin-row-status').textContent, /Network interrupted/);
  const retry = button.onclick(click); resolve({ launch: { id: row.id, manuallyArchived: false } }); await retry; assert.match(ui.element.querySelector('.launch-admin-row-status').textContent, /could not be verified/); assert.equal(writes, 2);
});

test('late archive responses and inventory errors are discarded after an administrator session change', async t => {
  dom(t); let account = admin(), resolveMutation, rejectInventory, reads = 0; const row = { ...sample(), canArchive: true }, messages = [];
  const ui = createLaunchAdmin({ api: async (path, body) => { if (body) return new Promise(resolve => { resolveMutation = resolve; }); if (++reads === 1) return inventory([row], path); return new Promise((resolve, reject) => { rejectInventory = reject; }); }, security: {}, getAccount: () => account, message: text => messages.push(text) });
  await ui.load(); const pending = ui.element.querySelector('.launch-admin-archive-toggle').onclick(click); account = { ...admin(), id: 'another-admin' }; const loading = ui.load(); resolveMutation({ launch: { id: row.id, manuallyArchived: true } }); await pending; assert.equal(messages.length, 0); assert.equal(ui.element.querySelector('.launch-admin-row'), null);
  account = { id: 'regular-user', role: 'user', mfaEnabled: true }; rejectInventory(Error('Private error')); await loading; assert.equal(messages.length, 0); await ui.load(); assert.equal(ui.element.hidden, true);
});

test('overlapping list loads keep the latest response and moving the last row corrects pagination', async t => {
  dom(t); let firstResolve, calls = 0; const row = sample();
  const ui = createLaunchAdmin({ api: async path => { if (++calls === 1) return new Promise(resolve => { firstResolve = resolve; }); return inventory([], path); }, security: {}, getAccount: admin, message() {} }); const first = ui.load(); await ui.load(); firstResolve(inventory([row], '/?view=active')); await first; assert.equal(ui.element.querySelector('.launch-admin-row'), null); assert.equal(ui.element.querySelector('[data-view=active]').textContent, 'Active coins (0)');
  const rows = Array.from({ length: 11 }, (_, i) => ({ ...sample(), id: String(i), canArchive: true })), paths = [];
  const paged = createLaunchAdmin({ api: async (path, body) => { paths.push(path); if (body) { const target = rows.find(row => row.id === body.id); target.manuallyArchived = true; return { launch: target }; } return inventory(rows, path); }, security: {}, getAccount: admin, message() {} }); await paged.load(10); await paged.element.querySelector('.launch-admin-archive-toggle').onclick(click); assert.equal(paged.element.querySelectorAll('.launch-admin-row').length, 10); assert.equal(new URL(paths.at(-1), 'https://launchpad.test').searchParams.get('offset'), '0');
});

const pausedRewards = (patch={}) => ({...sample(),feeMode:'holders',state:'paused',eligibility:{allowed:false,reason:'Creator fees are paid to holders.'},serviceError:'Token-account scan is temporarily unavailable.',rewardsAction:{kind:'distribute',allowed:false,autoFees:false,reason:'A saved reward step is waiting.'},rewardsAutomation:{allowed:true,enabled:false,reason:'Resume automatic checks from the saved step.',needed:true,pending:false},...patch});

test('healthy automatic rewards expose Pause and switch to Resume after a verified admin action',async t=>{
  dom(t);const row=pausedRewards({symbol:'LAUNCHPAD',state:'live',serviceError:'',rewardsAutomation:{allowed:true,enabled:true,needed:false,pending:false,pauseAllowed:true,pauseNeeded:true}}),posts=[],checks=[],messages=[];
  const ui=createLaunchAdmin({api:async(path,body)=>{if(!body)return result(row);posts.push({path,body});row.rewardsAutomation={...row.rewardsAutomation,enabled:false,needed:true,pauseNeeded:false};return{status:'paused',requestId:body.requestId,launch:row,message:'Automatic rewards paused.'};},security:{authorize:async(...args)=>{checks.push(args);return{password:'test-password',code:'123456'};}},getAccount:admin,message:text=>messages.push(text)});await ui.load();
  const item=ui.element.querySelector('.launch-admin-row');item.open=true;assert.equal(item.querySelector('[data-admin-reward-resume]'),null);const button=item.querySelector('[data-admin-reward-pause]');assert.equal(button.textContent,'Pause automatic rewards');await button.onclick(click);
  assert.deepEqual(checks,[['Pause LAUNCHPAD automatic rewards',{requireCode:true}]]);assert.equal(posts[0].path,'/api/admin/launches/action');assert.equal(posts[0].body.action,'pause-rewards');assert.match(posts[0].body.requestId,/^[a-f0-9]{32}$/);assert.equal(posts[0].body.signature,undefined);assert.equal(posts[0].body.clearPending,undefined);assert.equal(ui.element.querySelector('[data-admin-reward-pause]'),null);assert(ui.element.querySelector('[data-admin-reward-resume]'));assert.deepEqual(messages,['Automatic rewards paused.']);
});

test('Pause retries retain request identity, reject duplicate clicks and never announce an unverified stop',async t=>{
  dom(t);const row=pausedRewards({rewardsAutomation:{enabled:true,needed:true,allowed:false,pauseAllowed:true,pauseNeeded:true}}),posts=[],messages=[];let reject;
  const ui=createLaunchAdmin({api:async(path,body)=>{if(!body)return result(row);posts.push(body);if(posts.length===1)return new Promise((resolve,fail)=>{reject=fail;});return{status:'paused',requestId:body.requestId,launch:{...row,rewardsAutomation:{enabled:true}}};},security:{authorize:async()=>({code:'123456'})},getAccount:admin,message:text=>messages.push(text)});await ui.load();const button=ui.element.querySelector('[data-admin-reward-pause]'),job=button.onclick(click);await new Promise(resolve=>setTimeout(resolve,0));assert.equal(button.disabled,true);await button.onclick(click);assert.equal(posts.length,1);reject(Error('Network unavailable'));await job;assert.equal(button.disabled,false);await button.onclick(click);assert.equal(posts[0].requestId,posts[1].requestId);assert.match(ui.element.querySelector('.launch-admin-pause-feedback').textContent,/pause could not be verified/);assert.equal(messages.length,0);
});

test('closing or switching administrator accounts while Pause authorization is open suppresses the mutation',async t=>{
  dom(t);for(const change of ['clear','account']){let account=admin(),approve,writes=0;const row=pausedRewards({rewardsAutomation:{enabled:true,pauseAllowed:true,pauseNeeded:true}}),ui=createLaunchAdmin({api:async(path,body)=>{if(body)writes++;return result(row);},security:{authorize:()=>new Promise(resolve=>{approve=resolve;})},getAccount:()=>account,message(){throw Error('Stale completion');}});await ui.load();const job=ui.element.querySelector('[data-admin-reward-pause]').onclick(click);if(change==='clear')ui.clear();else account={...admin(),id:'new-admin'};approve({code:'123456'});await job;assert.equal(writes,0);}
});

test('paused reward cards expose a direct resume button with fresh proof and preserve the expanded coin',async t=>{
  dom(t);const row=pausedRewards(),posts=[],authorizations=[],messages=[];
  const ui=createLaunchAdmin({api:async(path,body)=>{if(!body)return result(row);posts.push({path,body});row.rewardsAutomation={...row.rewardsAutomation,enabled:true,needed:false};row.state='live';row.serviceError='';return{status:'resumed',requestId:body.requestId,launch:{...row},message:'Automatic rewards resumed.'};},security:{authorize:async(...args)=>{authorizations.push(args);return{password:'test-password',code:'123456'};}},getAccount:admin,message:text=>messages.push(text)});await ui.load();
  const item=ui.element.querySelector('.launch-admin-row');item.setAttribute('open','');assert.match(item.querySelector('summary').textContent,/Rewards paused/);const button=item.querySelector('[data-admin-reward-resume]');assert.equal(button.textContent,'Resume rewards');assert.equal(button.disabled,false);assert.equal(item.querySelector('.launch-admin-reward-recovery input'),null);await button.onclick(click);
  assert.deepEqual(authorizations,[['Resume COIN rewards',{requireCode:true}]]);assert.equal(posts.length,1);assert.equal(posts[0].path,'/api/admin/launches/action');assert.equal(posts[0].body.action,'resume-rewards');assert.equal(posts[0].body.reason,'Automatic rewards resumed from the admin panel.');assert.match(posts[0].body.requestId,/^[a-f0-9]{32}$/);assert.equal(posts[0].body.accountId,row.accountId);assert.equal(posts[0].body.id,row.id);assert.equal(posts[0].body.autoFees,undefined);assert.equal(posts[0].body.force,undefined);
  assert.equal(ui.element.querySelector('[data-admin-reward-resume]'),null);assert.equal(ui.element.querySelector('.launch-admin-row').hasAttribute('open'),true);assert.deepEqual(messages,['Automatic rewards resumed.']);assert(!ui.element.textContent.includes('test-password'));
});

test('resume remains available for a saved pending transaction and never submits a distribution or clears its receipt',async t=>{
  dom(t);const signature='3'.repeat(88),row=pausedRewards({network:'mainnet-beta',pendingOperation:{kind:'sell',state:'pending',signature,createdAt:12345},rewardsAutomation:{allowed:true,enabled:false,needed:true,pending:true}}),posts=[];
  const ui=createLaunchAdmin({api:async(path,body)=>{if(!body)return result(row);posts.push(body);row.rewardsAutomation.enabled=true;return{status:'resumed',requestId:body.requestId,launch:row,message:'Automatic rewards enabled. Checking the saved transaction first.'};},security:{authorize:async()=>({code:'123456'})},getAccount:admin,message(){}});await ui.load();assert.match(ui.element.querySelector('.launch-admin-reward-recovery').textContent,/saved transaction will be checked/);await ui.element.querySelector('[data-admin-reward-resume]').onclick(click);assert.equal(posts.length,1);assert.equal(posts[0].action,'resume-rewards');assert.equal(posts[0].signature,undefined);assert.equal(posts[0].clearPending,undefined);assert.equal(ui.element.querySelector('.launch-admin-pending a').href,'https://solscan.io/tx/'+signature);
});

test('resume retries reuse request identity, reject duplicate clicks and retain an actionable error',async t=>{
  dom(t);const row=pausedRewards(),posts=[];let reject;const ui=createLaunchAdmin({api:async(path,body)=>{if(!body)return result(row);posts.push(body);if(posts.length===1)return new Promise((resolve,bad)=>{reject=bad;});row.rewardsAutomation.enabled=true;return{status:'already_requested',requestId:body.requestId,launch:row};},security:{authorize:async()=>({code:'123456'})},getAccount:admin,message(){}});await ui.load();const button=ui.element.querySelector('[data-admin-reward-resume]');const pending=button.onclick(click);await new Promise(resolve=>setTimeout(resolve,0));assert.equal(button.disabled,true);assert.equal(button.textContent,'Resuming…');assert.equal(ui.element.querySelector('[data-view=archived]').disabled,true);await button.onclick(click);assert.equal(posts.length,1);reject(Error('Connection interrupted. Try again.'));await pending;assert.equal(button.disabled,false);assert.equal(button.textContent,'Resume rewards');assert.match(ui.element.querySelector('.launch-admin-reward-feedback').textContent,/Connection interrupted/);await button.onclick(click);assert.equal(posts.length,2);assert.equal(posts[0].requestId,posts[1].requestId);
});

test('unsafe or unsupported reward resumes remain disabled with the backend reason',async t=>{
  dom(t);const row=pausedRewards({rewardsAutomation:{allowed:false,enabled:false,needed:true,reason:'The saved payout needs review before rewards can resume.'}});let writes=0,proofs=0;const ui=createLaunchAdmin({api:async(path,body)=>{if(body)writes++;return result(row);},security:{authorize:async()=>{proofs++;}},getAccount:admin,message(){}});await ui.load();const button=ui.element.querySelector('[data-admin-reward-resume]');assert.equal(button.disabled,true);assert.match(ui.element.querySelector('.launch-admin-reward-recovery').textContent,/saved payout needs review/);await button.onclick(click);assert.equal(writes,0);assert.equal(proofs,0);
});

test('resume rejects a mismatched response instead of announcing an unverified success',async t=>{
  dom(t);const row=pausedRewards(),messages=[];const ui=createLaunchAdmin({api:async(path,body)=>body?{status:'resumed',requestId:body.requestId,launch:{...row,id:'wrong',rewardsAutomation:{enabled:true}}}:result(row),security:{authorize:async()=>({code:'123456'})},getAccount:admin,message:text=>messages.push(text)});await ui.load();await ui.element.querySelector('[data-admin-reward-resume]').onclick(click);assert.match(ui.element.querySelector('.launch-admin-reward-feedback').textContent,/could not be verified/);assert.equal(messages.length,0);
});

test('closing admin or changing accounts during resume authorization prevents the mutation',async t=>{
  dom(t);for(const change of ['clear','account']){let account=admin(),confirm,writes=0;const ui=createLaunchAdmin({api:async(path,body)=>{if(body)writes++;return result(pausedRewards());},security:{authorize:()=>new Promise(resolve=>{confirm=resolve;})},getAccount:()=>account,message(){throw Error('No stale message');}});await ui.load();const pending=ui.element.querySelector('[data-admin-reward-resume]').onclick(click);if(change==='clear')ui.clear();else account={...admin(),id:'different-admin'};confirm({code:'123456'});await pending;assert.equal(writes,0);}
});

test('late resume replies are discarded after the admin session closes and cancellation does not send a request',async t=>{
  dom(t);let resolve,writes=0;const row=pausedRewards(),ui=createLaunchAdmin({api:async(path,body)=>{if(!body)return result(row);writes++;return new Promise(done=>{resolve=()=>done({status:'resumed',requestId:body.requestId,launch:{...row,rewardsAutomation:{enabled:true}}});});},security:{authorize:async()=>({code:'123456'})},getAccount:admin,message(){throw Error('No stale message');}});await ui.load();const pending=ui.element.querySelector('[data-admin-reward-resume]').onclick(click);await new Promise(done=>setTimeout(done,0));ui.clear();resolve();await pending;assert.equal(ui.element.hidden,true);assert.equal(ui.element.querySelector('.launch-admin-row'),null);assert.equal(writes,1);
  const cancelled=createLaunchAdmin({api:async(path,body)=>{if(body)writes++;return result(row);},security:{authorize:async()=>{throw Error('Cancelled.');}},getAccount:admin,message(){}});await cancelled.load();await cancelled.element.querySelector('[data-admin-reward-resume]').onclick(click);assert.equal(writes,1);assert.equal(cancelled.element.querySelector('.launch-admin-reward-feedback').textContent,'');assert.equal(cancelled.element.querySelector('[data-admin-reward-resume]').disabled,false);
});

test('resume audit events have the correct label and external strings remain plain text',async t=>{
  dom(t);const row=pausedRewards({serviceError:'<img src=x onerror=alert(1)>',rewardsAutomation:{allowed:false,enabled:false,needed:true,reason:'<script>alert(1)</script>'},rewardHistory:[{at:12345,actor:'admin',action:'resume-rewards',status:'resumed',reason:'Automatic rewards resumed from the admin panel.'}]});const ui=createLaunchAdmin({api:async()=>result(row),security:{},getAccount:admin,message(){}});await ui.load();assert.match(ui.element.querySelector('.launch-admin-history').textContent,/Rewards resumed/);assert(ui.element.textContent.includes(row.serviceError));assert(ui.element.textContent.includes(row.rewardsAutomation.reason));assert.equal(ui.element.querySelector('img,script'),null);
});

test('PumpSwap admin inventory exposes visibility and exact venue identity without Raydium fee or reward controls',async t=>{
 dom(t);const mint='7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS',row={...sample(),route:'pumpswap',mint,name:'Coffee Cat',symbol:'COFFEECAT',rewardsAction:{kind:'distribute',allowed:true},rewardsAutomation:{needed:true,allowed:true}},posts=[];
 const ui=createLaunchAdmin({api:async(path,body)=>{if(!body)return inventory([row],path);posts.push({path,body});row.hidden=body.hidden;return{id:row.id,route:'pumpswap',mint,hidden:row.hidden};},security:{authorize(){throw Error('No custody or fee action permitted');}},getAccount:admin,message(){}});await ui.load();const item=ui.element.querySelector('.launch-admin-row');assert.match(item.textContent,/PumpSwap/);assert.match(item.textContent,/Coffee Cat/);assert.equal(item.querySelector('form'),null);assert.equal(item.querySelector('.launch-admin-reward'),null);assert.equal(item.querySelector('[data-admin-reward-resume]'),null);assert.equal(item.querySelector('a').href,'/coin?mint='+mint);assert.match(item.dataset.launchKey,/^pumpswap:/);
 await item.querySelector('.launch-admin-visibility-toggle').onclick(click);assert.deepEqual(posts[0].body,{accountId:row.accountId,id:row.id,route:'pumpswap',mint,hidden:true,reason:'Administrator hid this coin from public pages.'});assert.equal(ui.element.querySelector('.launch-admin-row'),null);await ui.element.querySelector('[data-view=archived]').onclick();assert.match(ui.element.textContent,/COFFEECAT/);assert.match(ui.element.textContent,/direct|trading page stay/);await ui.element.querySelector('.launch-admin-visibility-toggle').onclick(click);assert.equal(posts[1].body.hidden,false);assert.equal(posts[1].body.route,'pumpswap');
});

test('PumpSwap moderation refuses mismatched venue or mint receipts and archived drafts restore through their own route',async t=>{
 dom(t);const mint='7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS',row={...sample(),route:'pumpswap',mint,state:'draft',canArchive:true,canRestore:false},posts=[];let bad=true;
 const ui=createLaunchAdmin({api:async(path,body)=>{if(!body)return inventory([row],path);posts.push({path,body});if(bad)return{id:row.id,hidden:true,route:'raydium',mint};row.manuallyArchived=body.archived;row.canArchive=!body.archived;row.canRestore=body.archived;return{route:'pumpswap',launch:{...row,listArchived:row.manuallyArchived}};},security:{},getAccount:admin,message(){}});await ui.load();await ui.element.querySelector('.launch-admin-visibility-toggle').onclick(click);assert.match(ui.element.querySelector('.launch-admin-row-status').textContent,/could not be verified/);assert.equal(ui.element.querySelector('.launch-admin-visibility-toggle').textContent,'Hide');bad=false;await ui.element.querySelector('.launch-admin-archive-toggle').onclick(click);assert.deepEqual(posts[1].body,{accountId:row.accountId,id:row.id,route:'pumpswap',mint,archived:true});await ui.element.querySelector('[data-view=archived]').onclick();await ui.element.querySelector('.launch-admin-archive-toggle').onclick(click);assert.equal(posts[2].body.archived,false);assert.equal(posts[2].body.route,'pumpswap');
});

test('Archive all failed previews the full inventory and confirms through the authenticated bulk route',async t=>{
  dom(t);const posts=[],checks=[];let archived=false;const ui=createLaunchAdmin({api:async(path,body)=>{
    if(path==='/api/admin/failed-launch-archive'){
      if(!body)return{eligibleCount:42,excludedCount:3,excludedReasons:[{count:3,message:'Funds remain reserved.'}]};
      posts.push(body);archived=true;return{requestId:body.requestId,status:'completed',archivedCount:42,skippedCount:0,remainingCount:0,excludedCount:3};
    }
    return inventory(archived?[]:[{...sample(),state:'failed'}],path);
  },security:{authorize:async(...args)=>{checks.push(args);return{code:'123456'};}},getAccount:admin,message(){}});await ui.load();
  await ui.element.querySelector('[data-admin-archive-failed]').onclick();assert.match(ui.element.textContent,/42 failed requests are eligible/);assert.equal(posts.length,0);
  await ui.element.querySelector('[data-admin-archive-confirm]').onclick();assert.equal(posts.length,1);assert.match(posts[0].requestId,/^[a-f0-9]{32}$/);assert.equal(posts[0].code,'123456');assert.equal(posts[0].ids,undefined);
  assert.deepEqual(checks,[['Archive 42 eligible failed launch requests',{requireCode:true}]]);assert.match(ui.element.textContent,/42 failed requests archived/);assert.equal(ui.element.querySelector('[data-admin-archive-confirm]').disabled,true);assert.equal(ui.element.querySelector('.launch-admin-row'),null);
});

test('partial archive retries keep one request identity and duplicate clicks cannot start another batch',async t=>{
  dom(t);const posts=[];let complete,attempt=0;const ui=createLaunchAdmin({api:async(path,body)=>{
    if(path!=='/api/admin/failed-launch-archive')return inventory([],path);
    if(!body)return{eligibleCount:2,excludedCount:0};posts.push(body);attempt++;if(attempt===1)return new Promise(resolve=>{complete=()=>resolve({requestId:body.requestId,status:'partial',archivedCount:1,skippedCount:0,remainingCount:1,excludedCount:0});});return{requestId:body.requestId,status:'completed',archivedCount:2,skippedCount:0,remainingCount:0,excludedCount:0};
  },security:{authorize:async()=>({code:'123456'})},getAccount:admin,message(){}});await ui.load();await ui.element.querySelector('[data-admin-archive-failed]').onclick();const button=ui.element.querySelector('[data-admin-archive-confirm]'),pending=button.onclick();await new Promise(resolve=>setTimeout(resolve,0));await button.onclick();assert.equal(posts.length,1);complete();await pending;assert.match(ui.element.textContent,/1 still need confirmation/);await button.onclick();assert.equal(posts.length,2);assert.equal(posts[0].requestId,posts[1].requestId);assert.match(ui.element.textContent,/2 failed requests archived/);
});

test('bulk archive ignores stale sessions and renders exclusion reasons as text',async t=>{
  dom(t);let account=admin(),approve,writes=0;const reason='<img src=x onerror=alert(1)>';const ui=createLaunchAdmin({api:async(path,body)=>{if(body)writes++;return path==='/api/admin/failed-launch-archive'?{eligibleCount:1,excludedCount:1,excludedReasons:[{count:1,message:reason}]}:inventory([],path);},security:{authorize:()=>new Promise(resolve=>{approve=resolve;})},getAccount:()=>account,message(){}});await ui.load();await ui.element.querySelector('[data-admin-archive-failed]').onclick();assert(ui.element.textContent.includes(reason));assert.equal(ui.element.querySelector('img'),null);const pending=ui.element.querySelector('[data-admin-archive-confirm]').onclick();account={...admin(),id:'other-admin'};approve({code:'123456'});await pending;assert.equal(writes,0);
});


test('Distribute now explains immediate reward conversion and shows saved progress and reserved partial balances',async t=>{
  dom(t);let writes=0;const row={...sample(),feeMode:'holders',rewardsAction:{kind:'distribute',allowed:true,busy:true},quoteSymbol:'OPENAI',manualHolderDistribution:{state:'processing',phase:'convert',remainingBase:'123.456',reason:'<img src=x onerror=alert(1)> waiting for liquidity'}};
  const ui=createLaunchAdmin({api:async(path,body)=>{if(body)writes++;return result(row);},security:{},getAccount:()=>({id:'admin',role:'admin',mfaEnabled:true}),message(){}});await ui.load();
  const form=ui.element.querySelector('.launch-admin-reward form');assert.equal(form.querySelector('button').disabled,false);
  assert.match(form.textContent,/sell all eligible reward tokens into OPENAI/);assert.match(form.textContent,/without the automatic five-minute wait/);assert.match(form.textContent,/any amount/);assert.match(form.textContent,/Automatic reward settings stay unchanged/);
  const progress=ui.element.querySelector('.launch-admin-manual-distribution');assert.match(progress.textContent,/Converting reward tokens into OPENAI/);assert.match(progress.textContent,/123.456 COIN remains/);assert.equal(progress.querySelector('img'),null);
  row.manualHolderDistribution={state:'partial',phase:'done',remainingBase:'0.000001',remainingQuote:'0.02',distributedQuote:'0.4',reason:'Unpaid or rounding amounts remain reserved in reward credits.'};await ui.load();
  assert.match(ui.element.querySelector('.launch-admin-manual-distribution').textContent,/partially completed/);assert.match(ui.element.textContent,/0.4 OPENAI paid/);assert.match(ui.element.textContent,/0.02 OPENAI still reserved/);assert.equal(writes,0);
});

test('DAMM PumpSwap UUID launch hides and restores through its own route without Raydium controls',async t=>{
 dom(t);const mint='7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS',row={...sample(),id:'d52053ef-506d-4fb8-aaf1-210c3c5e2c50',route:'damm-pump',mint,name:'CrashBandicootWumpaWhipCoin',symbol:'COIN',username:'lunar-panda-1fd058f3',feeMode:'none',rewardsAction:{kind:'distribute',allowed:true},rewardsAutomation:{needed:true,allowed:true}},posts=[];
 const ui=createLaunchAdmin({api:async(path,body)=>{if(!body)return inventory([row],path);posts.push({path,body});row.hidden=body.hidden;return{id:row.id,route:'damm-pump',mint,hidden:row.hidden};},security:{authorize(){throw Error('No fee or custody action permitted');}},getAccount:admin,message(){}});await ui.load();const item=ui.element.querySelector('.launch-admin-row');assert.equal(item.querySelector('.launch-admin-venue').textContent,'PumpSwap');assert.match(item.dataset.launchKey,/^damm-pump:/);assert.equal(item.querySelector('form'),null);assert.equal(item.querySelector('.launch-admin-reward'),null);assert.equal(item.querySelector('.launch-admin-reward-badge'),null);assert.equal(item.querySelector('a').href,'/coin?mint='+mint);assert.match(item.textContent,/no creator or holder rewards/);
 await item.querySelector('.launch-admin-visibility-toggle').onclick(click);assert.deepEqual(posts[0],{path:'/api/admin/moderation/launch',body:{accountId:row.accountId,id:row.id,route:'damm-pump',mint,hidden:true,reason:'Administrator hid this coin from public pages.'}});assert.equal(ui.element.querySelector('.launch-admin-row'),null);await ui.element.querySelector('[data-view=archived]').onclick();await ui.element.querySelector('.launch-admin-visibility-toggle').onclick(click);assert.equal(posts[1].body.route,'damm-pump');assert.equal(posts[1].body.mint,mint);assert.equal(posts[1].body.id,row.id);assert.equal(posts[1].body.hidden,false);
});
test('DAMM PumpSwap rejects mismatched moderation receipts and archives its UUID request through the correct route',async t=>{
 dom(t);const mint='7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS',row={...sample(),id:'3ad302b9-215a-4297-90c2-3ba21164b318',route:'damm-pump',mint,state:'draft',canArchive:true,canRestore:false},posts=[];let bad=true;
 const ui=createLaunchAdmin({api:async(path,body)=>{if(!body)return inventory([row],path);posts.push({path,body});if(bad)return{id:row.id,hidden:true,route:'pumpswap',mint};row.manuallyArchived=body.archived;row.canArchive=!body.archived;row.canRestore=body.archived;return{route:'damm-pump',launch:{...row,listArchived:row.manuallyArchived}};},security:{},getAccount:admin,message(){}});await ui.load();await ui.element.querySelector('.launch-admin-visibility-toggle').onclick(click);assert.match(ui.element.querySelector('.launch-admin-row-status').textContent,/could not be verified/);assert.equal(ui.element.querySelector('.launch-admin-visibility-toggle').textContent,'Hide');bad=false;await ui.element.querySelector('.launch-admin-archive-toggle').onclick(click);assert.deepEqual(posts[1].body,{accountId:row.accountId,id:row.id,route:'damm-pump',mint,archived:true});await ui.element.querySelector('[data-view=archived]').onclick();await ui.element.querySelector('.launch-admin-archive-toggle').onclick(click);assert.equal(posts[2].body.archived,false);assert.equal(posts[2].body.route,'damm-pump');assert.equal(posts[2].body.mint,mint);
});
test('a Pump.fun coin hides and restores through its own route, labelled Pump.fun, without Raydium controls',async t=>{
  dom(t);const mint='GFSpfeqjttGeLWeCnGsgwpYWZUxcFHUabfuG9tAfjz3U',row={...sample(),id:'ab'.repeat(12),route:'pump-classic',mint,name:'Liquidity Manager',symbol:'LIQUID',feeMode:'lp_manager',eligibility:{allowed:false,reason:'Pump.fun coins use Pump.fun’s native fee sharing; manage them in the Pump.fun tab. Only visibility is changed here.'},rewardsAction:{kind:null,allowed:false},rewardsAutomation:{needed:false,allowed:false},canArchive:false,canRestore:false},posts=[];
  const ui=createLaunchAdmin({api:async(path,body)=>{if(!body)return inventory([row],path);posts.push({path,body});row.hidden=body.hidden;return{id:row.id,route:'pump-classic',mint,hidden:row.hidden};},security:{authorize(){throw Error('No fee or custody action permitted');}},getAccount:admin,message(){}});await ui.load();
  const item=ui.element.querySelector('.launch-admin-row');
  assert.equal(item.querySelector('.launch-admin-venue').textContent,'Pump.fun');assert.match(item.dataset.launchKey,/^pump-classic:/);assert.equal(item.querySelector('form'),null,'no recipient takeover');assert.equal(item.querySelector('.launch-admin-archive-toggle'),null,'Pump.fun requests are archived in the Pump.fun tab');assert.equal(item.querySelector('a').href,'/coin?mint='+mint);
  await item.querySelector('.launch-admin-visibility-toggle').onclick(click);
  assert.deepEqual(posts[0],{path:'/api/admin/moderation/launch',body:{accountId:row.accountId,id:row.id,route:'pump-classic',mint,hidden:true,reason:'Administrator hid this coin from public pages.'}});
  assert.equal(ui.element.querySelector('.launch-admin-row'),null,'a hidden coin leaves Active coins');
  await ui.element.querySelector('[data-view=archived]').onclick();await ui.element.querySelector('.launch-admin-visibility-toggle').onclick(click);
  assert.deepEqual([posts[1].body.route,posts[1].body.mint,posts[1].body.hidden],['pump-classic',mint,false]);
});

test('an invalid new recipient or reason is rejected before the identity prompt', async t => {
  dom(t); const posts = [], authorizations = [], messages = [], row = sample();
  const ui = createLaunchAdmin({ api: async (path, body) => { if (body) { posts.push({ path, body }); return {}; } return result(row); }, security: { authorize: async (...args) => { authorizations.push(args); return { password: 'test-password', code: '123456' }; } }, getAccount: () => ({ id: 'admin', role: 'admin', mfaEnabled: true }), message: (text, negative) => messages.push({ text, negative }) });
  await ui.load(); const form = ui.element.querySelector('.launch-admin-row form'), input = form.querySelector('input'), reason = form.querySelector('textarea');
  for (const [wallet, why, expected] of [['not-a-wallet', 'Approved community takeover.', /valid Solana wallet/], ['1111111111111111111111111111111111111111111', 'Approved community takeover.', /valid Solana wallet/], [' 9J7iw6jVxqPoiBMXWsWRNAsgFT9qkkkVHyAS26euwoBq ', 'no', /reason between 5 and 500/]]) {
    input.value = wallet; reason.value = why; await form.onsubmit({ preventDefault() {} }); assert.match(messages.at(-1).text, expected); assert.equal(messages.at(-1).negative, true);
  }
  assert.equal(authorizations.length, 0); assert.equal(posts.length, 0);
  reason.value = 'Approved community takeover.'; await form.onsubmit({ preventDefault() {} });
  assert.equal(authorizations.length, 1); assert.equal(posts[0].body.recipient, '9J7iw6jVxqPoiBMXWsWRNAsgFT9qkkkVHyAS26euwoBq', 'the address is trimmed');
});

test('reload refreshes the page of coins being viewed instead of returning to the first page', async t => {
  dom(t); const reads = [];
  const ui = createLaunchAdmin({ api: async path => { reads.push(path); const offset = Number(new URLSearchParams(path.split('?')[1]).get('offset')); return { launches: [{ ...sample(), id: String(offset).padStart(32, '0') }], total: 25, offset, nextOffset: offset + 10 < 25 ? offset + 10 : null }; }, security: {}, getAccount: () => ({ id: 'admin', role: 'admin', mfaEnabled: true }), message() {} });
  await ui.load(); await ui.element.querySelectorAll('.account-actions button')[1].onclick();
  assert.match(reads.at(-1), /offset=10/);
  await ui.reload(); assert.match(reads.at(-1), /offset=10/); assert.match(ui.element.textContent, /11–11 of 25/);
});

test('payout gas (v71.37): the admin row says when rewards were sold for payout network costs, as text only',async t=>{
  dom(t);
  const row={...sample(),feeMode:'holders',rewardsAction:{kind:'distribute',allowed:false,autoFees:true},rewardsAutomation:{enabled:true},rewardRetry:{at:Date.now()+300000,reason:'Insufficient SOL in wallet'},payoutGas:{applies:true,cycleSales:1,confirmedSales:2,lastSaleAt:1759600000000,lastSaleAmount:'648020',lastSaleReceipt:'-648020',pending:false,note:''}};
  const ui=createLaunchAdmin({api:async()=>result(row),security:{},getAccount:()=>({id:'admin',role:'admin',mfaEnabled:true}),message(){}});
  await ui.load();let line=ui.element.querySelector('.launch-admin-payout-gas');
  assert.match(line.textContent,/Sold rewards for payout network costs 2 times \(1 in this cycle\), last /);assert(line.textContent.includes(new Date(1759600000000).toLocaleString()));
  row.payoutGas={applies:true,cycleSales:0,confirmedSales:0,lastSaleAt:null,lastSaleAmount:null,lastSaleReceipt:null,pending:true,note:''};await ui.load();line=ui.element.querySelector('.launch-admin-payout-gas');
  assert.match(line.textContent,/Selling a little of the rewards for the SOL this payout needs/);
  row.payoutGas={applies:true,cycleSales:0,confirmedSales:0,lastSaleAt:null,lastSaleAmount:null,lastSaleReceipt:null,pending:false,note:'The rewards waiting are too small <img src=x onerror=alert(1)> to pay for the holders’ new token accounts and network fees.'};await ui.load();line=ui.element.querySelector('.launch-admin-payout-gas');
  assert.match(line.textContent,/too small <img/);assert.equal(ui.element.querySelector('.launch-admin-reward img,.launch-admin-reward script'),null);
  row.payoutGas=null;await ui.load();assert.equal(ui.element.querySelector('.launch-admin-payout-gas'),null);
});
