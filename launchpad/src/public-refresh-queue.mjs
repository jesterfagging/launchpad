// Bounded FIFO admission for public, read-only refreshes. A caller timing out
// does not discard its place in line. Provider budgets are never raised by
// adding viewers; the caller separately coalesces requests for the same mint.
export class PublicRefreshQueue {
  constructor({concurrency=3,maxQueued=200,perMinute=60,now=Date.now}={}) {
    Object.assign(this,{concurrency,maxQueued,perMinute,now});this.active=0;this.queue=[];this.starts=[];this.closed=false;this.blockedUntil=0;this.timer=null;
  }
  trim(){const cutoff=this.now()-60_000;this.starts=this.starts.filter(at=>at>cutoff);}
  get rateBlocked(){this.trim();return this.now()<this.blockedUntil||this.starts.length>=this.perMinute;}
  run(work) {
    if(this.closed||this.queue.length>=this.maxQueued)return null;
    let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});
    promise.started=false;this.queue.push({work,resolve,reject,promise});this.drain();return promise;
  }
  cooldown(until){this.blockedUntil=Math.max(this.blockedUntil,until);this.drain();}
  drain() {
    clearTimeout(this.timer);this.timer=null;if(this.closed)return;this.trim();
    while(this.queue.length&&this.active<this.concurrency&&!this.rateBlocked){
      const item=this.queue.shift();item.promise.started=true;this.active++;this.starts.push(this.now());
      let result;try{result=item.work();}catch(error){result=Promise.reject(error);}
      Promise.resolve(result).then(item.resolve,item.reject).finally(()=>{this.active--;this.drain();});
    }
    if(this.queue.length&&this.active<this.concurrency&&this.rateBlocked){
      const until=Math.max(this.blockedUntil,this.starts.length>=this.perMinute?this.starts[0]+60_001:0);
      this.timer=setTimeout(()=>this.drain(),Math.max(1,until-this.now()));this.timer.unref?.();
    }
  }
  close(){this.closed=true;clearTimeout(this.timer);this.timer=null;for(const item of this.queue.splice(0))item.reject(Error('Public refresh service is restarting.'));}
}

export async function boundedRefresh(work,fallback,waitMs){
  let timer;
  try{return await Promise.race([work,new Promise(resolve=>{timer=setTimeout(()=>resolve(fallback()),waitMs);})]);}
  finally{clearTimeout(timer);}
}
