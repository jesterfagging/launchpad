import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicRefreshQueue, boundedRefresh } from '../src/public-refresh-queue.mjs';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('timed-out callers keep their FIFO position without exceeding concurrency or the minute budget',async()=>{
  let now=1000,release;const started=[];
  const queue=new PublicRefreshQueue({concurrency:1,perMinute:2,maxQueued:3,now:()=>now});
  try{
    const first=queue.run(async()=>{started.push('first');await new Promise(resolve=>{release=resolve;});return 1;});
    const second=queue.run(async()=>{started.push('second');return 2;});
    const third=queue.run(async()=>{started.push('third');return 3;});
    assert.equal(await boundedRefresh(second,()=>null,5),null);
    assert.deepEqual(started,['first']);release();await first;assert.equal(await second,2);await flush();
    assert.deepEqual(started,['first','second']);assert.equal(queue.active,0);assert.equal(queue.queue.length,1);
    now+=60001;queue.drain();assert.equal(await third,3);assert.deepEqual(started,['first','second','third']);
  }finally{queue.close();}
});
test('queue overflow is bounded and shutdown rejects queued reads without starting provider work',async()=>{
  let release,calls=0;const queue=new PublicRefreshQueue({concurrency:1,maxQueued:1});
  const first=queue.run(async()=>{calls++;await new Promise(resolve=>{release=resolve;});});
  const queued=queue.run(async()=>{calls++;});assert.equal(queue.run(async()=>{}),null);
  const rejected=assert.rejects(queued,/restarting/);queue.close();await rejected;release();await first;assert.equal(calls,1);
});
