import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { renderIfChanged, candleUpdate, openPositionCount, chartTimeFormatters } from '../public/ui-performance.mjs';

test('unchanged status snapshots preserve controls, and switching panels invalidates the previous render',()=>{
  const {document}=parseHTML('<main><div id="body"></div></main>'),body=document.getElementById('body');
  let rendered=0;
  const draw=()=>{rendered++;const button=document.createElement('button');button.textContent='Action';body.replaceChildren(button);};
  renderIfChanged(body,{pending:0,state:'running'},draw);const first=body.firstChild;
  assert.equal(renderIfChanged(body,{pending:0,state:'running'},draw),false);assert.equal(body.firstChild,first);
  body.replaceChildren(document.createElement('p'));
  assert.equal(renderIfChanged(body,{pending:0,state:'running'},draw),true);assert.equal(rendered,2);
  assert.equal(renderIfChanged(body,{pending:1,state:'running'},draw),true);assert.equal(rendered,3);
});
const bar=(time,close=2)=>({time,open:1,high:3,low:1,close,volume:100});
test('candle updates append live bars, skip identical data and reset for genuine history corrections',()=>{
  const old=[bar(60),bar(120)];
  assert.deepEqual(candleUpdate(old,old.map(row=>({...row}))),{reset:false,rows:[]});
  assert.deepEqual(candleUpdate(old,[bar(60),bar(120,3),bar(180)]),{reset:false,rows:[bar(120,3),bar(180)]});
  assert.deepEqual(candleUpdate(old,[bar(60),bar(120),bar(180)]),{reset:false,rows:[bar(180)]});
  for(const rows of [[bar(60,3),bar(120)],[bar(120),bar(180)],[],[bar(60)]])assert.equal(candleUpdate(old,rows).reset,true);
});
test('workspace counts include open LP positions and exclude closed lots',()=>{
  assert.equal(openPositionCount([{remaining:'2'},{remaining:'0'},{liquidity:'5'},{position:{venue:'Meteora'}},{position:null}]),3);
});

test('chart time labels use the visitor time zone and leave business days and daily UTC buckets readable',()=>{
  const at=Date.UTC(2026,9,3,14,45,30)/1000,midnight=Date.UTC(2026,9,3)/1000;
  const kolkata=chartTimeFormatters({timeZone:'Asia/Kolkata'});assert.equal(kolkata.tickMarkFormatter(at,3,'en-US'),'20:15');assert.equal(kolkata.tickMarkFormatter(midnight,1,'en-US'),'Oct 3 05:30');assert.equal(kolkata.timeFormatter(at),'Oct 3, 2026, 20:15');
  const utc=chartTimeFormatters({timeZone:'UTC',seconds:()=>true});assert.equal(utc.tickMarkFormatter(midnight,0,'en-US'),'2026');assert.equal(utc.tickMarkFormatter(midnight,1,'en-US'),'Oct');assert.equal(utc.timeFormatter(at),'Oct 3, 2026, 14:45:30');
  assert.equal(utc.timeFormatter({year:2026,month:10,day:3}),'2026-10-3');assert.equal(utc.tickMarkFormatter({year:2026,month:10,day:3},2,'en-US'),null);
  const daily=chartTimeFormatters({timeZone:'Pacific/Honolulu',daily:()=>true});assert.equal(daily.tickMarkFormatter(midnight,2,'en-US'),null);assert.equal(daily.timeFormatter(midnight),'Oct 3, 2026');
});
