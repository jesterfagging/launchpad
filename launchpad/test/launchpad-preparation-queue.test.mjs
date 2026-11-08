import test from 'node:test';
import assert from 'node:assert/strict';
import {LaunchPreparationQueue} from '../src/launchpad-preparation-queue.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};

test('preparation queue bounds workers and rotates waiting owners instead of allowing one account to monopolize the queue',async()=>{
  const q=new LaunchPreparationQueue({concurrency:1,perOwner:4}),gate=deferred(),started=[];
  const task=(name,block=false)=>q.run(name[0],async()=>{started.push(name);if(block)await gate.promise;return name;});
  const work=[task('A1',true),task('A2'),task('A3'),task('B1'),task('C1')];
  await tick();assert.deepEqual(started,['A1']);assert.equal(q.active,1);gate.resolve();
  assert.deepEqual(await Promise.all(work),['A1','A2','A3','B1','C1']);await tick();
  assert.deepEqual(started,['A1','A2','B1','C1','A3']);assert.equal(q.count,0);assert.equal(q.active,0);q.close();
});
test('1000 distinct owners are admitted with at most20 active preparations and close leaves no queued work',async()=>{
  const q=new LaunchPreparationQueue(),gate=deferred();let active=0,max=0;
  const work=Array.from({length:1000},(_,i)=>q.run(String(i),async()=>{max=Math.max(max,++active);await gate.promise;active--;return i;}));
  await tick();assert.equal(max,20);assert.equal(q.count,1000);gate.resolve();assert.equal((await Promise.all(work)).length,1000);await tick();assert.equal(q.count,0);q.close();
});
test('queue capacity, owner cap, wait expiry and shutdown return retryable errors without executing rejected tasks',async()=>{
  const q=new LaunchPreparationQueue({concurrency:1,capacity:3,perOwner:2,waitMs:15}),gate=deferred();let ran=0;
  const active=q.run('a',()=>gate.promise),own=q.run('a',()=>{ran++;});
  await assert.rejects(q.run('a',()=>{ran++;}),e=>e.statusCode===503&&e.retryAfter===2);
  const other=q.run('b',()=>{ran++;});const queuedResults=Promise.allSettled([own,other]);
  await assert.rejects(q.run('c',()=>{ran++;}),e=>e.code==='LAUNCH_PREPARATION_BUSY');
  await new Promise(resolve=>setTimeout(resolve,30));
  assert((await queuedResults).every(item=>item.status==='rejected'&&item.reason.retryable));assert.equal(ran,0);
  const queued=q.run('b',()=>{ran++;});const rejected=assert.rejects(queued,/restarting/);q.close();await rejected;
  gate.resolve();await active;await tick();assert.equal(q.count,0);assert.equal(ran,0);
});

test('saved-review priority is bounded so new reviews keep progressing',async()=>{
  const q=new LaunchPreparationQueue({concurrency:1}),gate=deferred(),started=[];
  const active=q.run('active',()=>gate.promise);await tick();
  const waiting=[q.run('new',()=>{started.push('new');})];
  for(const owner of ['resume1','resume2','resume3','resume4'])waiting.push(q.run(owner,()=>{started.push(owner);},{priority:'resume'}));
  gate.resolve();await Promise.all([active,...waiting]);await tick();
  assert.deepEqual(started,['resume1','resume2','resume3','new','resume4']);assert.equal(q.active,0);q.close();
});

test('estimates and reviews share the same worker limit without parallel work for one owner',async()=>{
  const q=new LaunchPreparationQueue({concurrency:1,perOwner:3}),gate=deferred(),started=[];
  const active=q.run('active',()=>gate.promise);await tick();
  const estimate=q.run('owner',()=>{started.push('estimate');},{priority:'estimate'});
  const review=q.run('owner',()=>{started.push('review');});
  gate.resolve();await Promise.all([active,estimate,review]);await tick();
  assert.deepEqual(started,['review','estimate']);assert.equal(q.count,0);q.close();
});

test('FIFO fairness turns protect the middle review lane while resume and estimate traffic continues',async()=>{
  const q=new LaunchPreparationQueue({concurrency:1}),gate=deferred(),started=[],work=[];
  work.push(q.run('active',()=>gate.promise));await tick();
  const resume=name=>q.run(name,()=>{started.push(name);},{priority:'resume'});
  work.push(resume('resume1'));
  const estimate=n=>q.run('estimate',()=>{started.push('estimate'+n);if(n<4)work.push(estimate(n+1));},{priority:'estimate'});
  work.push(estimate(1),q.run('review',()=>{started.push('review');}));
  for(let n=2;n<=12;n++)work.push(resume('resume'+n));
  gate.resolve();while(q.count)await tick();await Promise.all(work);
  assert.deepEqual(started.slice(0,8),['resume1','resume2','resume3','estimate1','resume4','resume5','resume6','review']);
  assert.equal(started.filter(name=>name.startsWith('estimate')).length,4);assert.equal(q.active,0);q.close();
});
