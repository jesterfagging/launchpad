import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { toolkitEnabled, telegramEnabled } from '../src/product-mode.mjs';
import { AccountRuntimeManager } from '../src/account-runtime.mjs';
const project=new URL('../',import.meta.url);
const cleanEnv=()=>Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^LAUNCHPAD_/.test(key)&&key!=='COPYTRADER_PORT'));
async function directory(t){const dir=await mkdtemp(join(tmpdir(),'launchpad-launchpad-only-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
function child(script,env={}){return spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:project,env:{...cleanEnv(),NODE_ENV:'test',NODE_USE_ENV_PROXY:'0',...env},encoding:'utf8',timeout:30000});}
const hostScript=`
  import {createServer} from 'node:net';
  import {runHost} from './src/host-server.mjs';
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));process.env.COPYTRADER_PORT=String(port);
  const host=await runHost({telegram:true,bindAddress:'127.0.0.1'});
  try{const response=await fetch('http://127.0.0.1:'+port+'/healthz');
    console.log('RESULT '+JSON.stringify({products:host.products,toolkitRuntime:host.runtimes.toolkit,balances:!!host.runtimes.balances,workers:host.runtimes.runtimes.size,background:Object.fromEntries(Object.entries(host.background).map(([k,v])=>[k,!!v])),health:response.status}));
  }finally{await host.shutdown();}
`;
function result(output){assert.equal(output.status,0,output.stderr||output.stdout);return JSON.parse(output.stdout.split('\n').find(line=>line.startsWith('RESULT ')).slice(7));}

test('product defaults disable toolkit and Telegram, with two independent future opt-ins',()=>{
  assert.equal(toolkitEnabled({}),false);assert.equal(telegramEnabled({LAUNCHPAD_ENABLE_TELEGRAM:'1'}),false);
  assert.equal(toolkitEnabled({LAUNCHPAD_ENABLE_TOOLKIT:'1'}),true);assert.equal(telegramEnabled({LAUNCHPAD_ENABLE_TOOLKIT:'1'}),false);
  assert.equal(telegramEnabled({LAUNCHPAD_ENABLE_TOOLKIT:'1',LAUNCHPAD_ENABLE_TELEGRAM:'1'}),true);
});

test('actual default host keeps launchpad health alive and constructs no dormant-product services',async t=>{
  const dir=await directory(t);const out=result(child(hostScript,{LAUNCHPAD_DATA_DIR:join(dir,'accounts'),LAUNCHPAD_TELEGRAM_DATA_DIR:join(dir,'telegram'),LAUNCHPAD_ENABLE_TELEGRAM:'1'}));
  assert.deepEqual(out.products,{toolkit:false,telegram:false});assert.equal(out.health,200);assert.equal(out.toolkitRuntime,false);assert.equal(out.balances,false);assert.equal(out.workers,0);
  assert.deepEqual(out.background,{positionFeed:false,verifier:false,robinhood:false,telegramService:false});
  await assert.rejects(stat(join(dir,'telegram')),{code:'ENOENT'});
});

test('future toolkit opt-in restores services without enabling Telegram implicitly',async t=>{
  const dir=await directory(t);const out=result(child(hostScript,{LAUNCHPAD_DATA_DIR:join(dir,'accounts'),LAUNCHPAD_TELEGRAM_DATA_DIR:join(dir,'telegram'),LAUNCHPAD_ENABLE_TOOLKIT:'1',LAUNCHPAD_ENABLE_TELEGRAM:'0'}));
  assert.deepEqual(out.products,{toolkit:true,telegram:false});assert.equal(out.health,200);assert.equal(out.balances,true);
  assert.deepEqual(out.background,{positionFeed:true,verifier:true,robinhood:true,telegramService:false});
  await assert.rejects(stat(join(dir,'telegram')),{code:'ENOENT'});
});

test('direct Telegram start and setup fail before data access when Telegram is enabled without the toolkit',async t=>{
  const dir=await directory(t),env={LAUNCHPAD_DATA_DIR:join(dir,'accounts'),LAUNCHPAD_TELEGRAM_DATA_DIR:join(dir,'telegram'),LAUNCHPAD_ENABLE_TELEGRAM:'1'};
  for(const script of ["import {main} from './src/telegram-server.mjs';await main();","import {startHostedTelegram} from './src/telegram-server.mjs';await startHostedTelegram({});","await import('./scripts/setup-telegram.mjs');"]){
    const out=child(script,env);assert.notEqual(out.status,0);assert.match(out.stderr,/Telegram is disabled/);
  }
  await assert.rejects(stat(join(dir,'telegram')),{code:'ENOENT'});await assert.rejects(stat(join(dir,'accounts')),{code:'ENOENT'});
  const allowed=child("import {requireTelegramEnabled} from './src/telegram-server.mjs';requireTelegramEnabled();",{LAUNCHPAD_ENABLE_TOOLKIT:'1',LAUNCHPAD_ENABLE_TELEGRAM:'1'});assert.equal(allowed.status,0,allowed.stderr);
});

test('launchpad-only runtime reads operator connections without changing saved toolkit settings or journals',async t=>{
  const overrides={LAUNCHPAD_PUBLIC_RPC_URL:'https://operator.example.test/',LAUNCHPAD_PUBLIC_JUPITER_KEY:'operator-fixture-key'},previous=Object.fromEntries(Object.keys(overrides).map(key=>[key,process.env[key]]));
  for(const [key,value] of Object.entries(overrides)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  t.after(()=>{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const saved={walletSchema:0,rpcUrl:'https://user.example.test/',heliusKey:'old-user-key',jupiterKey:'old-user-jupiter',wallets:[],mode:'paper'},before=structuredClone(saved);let writes=0,workers=0;
  const runtime=new AccountRuntimeManager({storeFor:()=>({read:async(name)=>{assert.equal(name,'settings');return saved;},write:async()=>writes++})},{},{toolkit:false,engineFactory:()=>{workers++;throw Error('disabled worker started');}});t.after(()=>runtime.close());
  const view=await runtime.readSettings('account');assert.equal(view.settings.rpcUrl,'https://operator.example.test/');assert.equal(view.settings.jupiterKey,'operator-fixture-key');assert.equal(view.settings.heliusKey,'');
  assert.deepEqual(saved,before);assert.equal(writes,0);assert.equal(runtime.walletMigrations.size,0);assert.equal(runtime.balances,null);
  assert.throws(()=>runtime.get('account'),/Toolkit is disabled/);assert.throws(()=>runtime.makeWorker('account','copy',{}),/Toolkit is disabled/);assert.throws(()=>runtime.prepare('account'),/Toolkit is disabled/);assert.equal(workers,0);
});

test('the systemd template uses the web entry and the documented data paths',async()=>{
  {const source=await readFile(new URL('../deploy/launchpad.service',import.meta.url),'utf8');assert.match(source,/ExecStart=.*\/src\/server\.mjs/);assert.doesNotMatch(source,/ExecStart=.*telegram-server/);assert(source.includes('/opt/launchpad/data'));assert(source.includes('/opt/launchpad/telegram-data'));}
});

test('actual host shutdown keeps shared RPC admission alive until application jobs have drained',async t=>{
  const dir=await directory(t);
  const out=result(child(`
    import assert from 'node:assert/strict';
    import {createServer} from 'node:net';
    import {runHost} from './src/host-server.mjs';
    const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));process.env.COPYTRADER_PORT=String(port);
    const host=await runHost({bindAddress:'127.0.0.1'}),gate=host.runtimes.rpcGate;
    let finish,closing;const pendingJob=new Promise(resolve=>{finish=resolve;}),closeServices=host.server.closeServices;
    host.server.closeServices=()=>closing ||= Promise.allSettled([closeServices(),pendingJob]);
    try{
      const stopped=host.shutdown();assert.equal(host.shutdown(),stopped,'repeated shutdown shares one drain');
      await new Promise(resolve=>setImmediate(resolve));
      assert.equal(host.runtimes.closing,true);assert.equal(gate.closed,false);
      // This is the next RPC read of an existing reward job, after workers
      // were asked to stop but before its saved operation has been checked.
      await gate.acquire('fixture-endpoint','reward-job',8,{method:'getAccountInfo'});
      finish();await stopped;
      assert.equal(gate.closed,true);await assert.rejects(gate.acquire('fixture-endpoint','late-job',8),/RPC scheduler closed/);
      console.log('RESULT '+JSON.stringify({drainedBeforeRpcClose:true}));
    }finally{finish();await host.shutdown();}
  `,{LAUNCHPAD_DATA_DIR:join(dir,'accounts')}));
  assert.equal(out.drainedBeforeRpcClose,true);
});

test('runtime shutdown stops workers immediately and waits for successful or failed consumers only once',async()=>{
  for(const rejected of [false,true]){
    const runtime=new AccountRuntimeManager({}, {}, {toolkit:false}),events=[];
    let finish;const consumersClosed=new Promise((resolve,reject)=>{finish=()=>rejected?reject(Error('fixture consumer drain failed')):resolve();});
    runtime.runtimes.set('fixture',{stop(){events.push('stop');},cancelInventoryRefresh:async()=>events.push('cancel'),busy:false,
      lanes:new Map([['copy',{worker:{close:async()=>{events.push('worker closed');}}}]])});
    const stopped=runtime.close({consumersClosed});
    assert.equal(runtime.close(),stopped,'a second close cannot bypass the existing consumer barrier');
    assert.equal(runtime.closing,true);assert.deepEqual(events,['stop','cancel']);
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(events,['stop','cancel','worker closed']);assert.equal(runtime.rpcGate.closed,false);
    await runtime.rpcGate.acquire('fixture-endpoint','reward-job',8);
    finish();await stopped;
    assert.equal(runtime.rpcGate.closed,true);assert.equal(runtime.rpcGate.requests.closed,true);
    assert.deepEqual(events,['stop','cancel','worker closed']);
  }
});
