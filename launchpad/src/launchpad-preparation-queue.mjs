export const launchPreparationBusy = (message = 'Launch reviews are busy. Retrying shortly.') => Object.assign(new Error(message), {statusCode:503,code:'LAUNCH_PREPARATION_BUSY',retryAfter:2,retryable:true});

// Bound expensive chain/storage preparation without letting one account occupy
// every worker. HTTP callers wait only briefly; overload remains retryable.
export class LaunchPreparationQueue {
  constructor({concurrency=20,capacity=1200,perOwner=2,waitMs=30000,priorityBurst=3}={}) {
    this.concurrency=concurrency;this.capacity=capacity;this.perOwner=perOwner;this.waitMs=waitMs;
    this.priorityBurst=priorityBurst;this.priorityStreak=0;
    this.owners=new Map();this.order=[];this.activeOwners=new Set();this.count=0;this.active=0;this.closed=false;
  }
  run(owner,fn,{priority='review'}={}) {
    if(this.closed)return Promise.reject(launchPreparationBusy('Launchpad is restarting. Retry your launch review shortly.'));
    const owned=(this.owners.get(owner)?.length||0)+Number(this.activeOwners.has(owner));
    if(this.count>=this.capacity||owned>=this.perOwner)return Promise.reject(launchPreparationBusy());
    this.count++;
    return new Promise((resolve,reject)=>{
      const task={fn,resolve,reject,timer:null,priority:priority==='resume'?1:priority==='estimate'?-1:0};
      if(!this.owners.has(owner)){this.owners.set(owner,[]);this.order.push(owner);}
      this.owners.get(owner).push(task);
      task.timer=setTimeout(()=>{
        const list=this.owners.get(owner),at=list?.indexOf(task)??-1;if(at<0)return;
        list.splice(at,1);this.count--;if(!list.length)this.removeOwner(owner);
        reject(launchPreparationBusy());this.drain();
      },this.waitMs);task.timer.unref?.();
      this.drain();
    });
  }
  removeOwner(owner) {this.owners.delete(owner);this.order=this.order.filter(value=>value!==owner);}
  drain() {
    if(this.closed)return;
    while(this.active<this.concurrency&&this.order.length){
      const eligible=this.order.filter(owner=>!this.activeOwners.has(owner));
      if(!eligible.length)break;
      const priorities=eligible.flatMap(owner=>this.owners.get(owner).map(task=>task.priority));
      const highest=Math.max(...priorities),lowest=Math.min(...priorities);
      // Saved reviews take the next free worker, but a continuous stream of
      // refreshes cannot starve new reviews or estimates. No running task is
      // interrupted and each account still has at most one active task.
      const fairTurn=highest>lowest&&this.priorityStreak>=this.priorityBurst;
      const owner=fairTurn?eligible[0]:eligible.find(owner=>this.owners.get(owner).some(task=>task.priority===highest));
      this.order.splice(this.order.indexOf(owner),1);
      const list=this.owners.get(owner),at=fairTurn?0:list.findIndex(task=>task.priority===highest),[task]=list.splice(at,1);
      if(list.length)this.order.push(owner);else this.owners.delete(owner);
      this.priorityStreak=!fairTurn&&highest>lowest?this.priorityStreak+1:0;
      clearTimeout(task.timer);this.active++;this.activeOwners.add(owner);
      Promise.resolve().then(task.fn).then(task.resolve,task.reject).finally(()=>{
        this.active--;this.count--;this.activeOwners.delete(owner);this.drain();
      });
    }
  }
  close() {
    this.closed=true;
    for(const list of this.owners.values())for(const task of list){clearTimeout(task.timer);this.count--;task.reject(launchPreparationBusy('Launchpad is restarting. Retry your launch review shortly.'));}
    this.owners.clear();this.order=[];
  }
}
