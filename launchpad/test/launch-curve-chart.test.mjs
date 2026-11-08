import test from 'node:test';
import assert from 'node:assert/strict';
import { intervalCandles, observationSeries, curveCandles, curveChartSnapshot, formatCurveNumber, createLaunchCurveChart } from '../public/launch-curve-chart.mjs';

test('the first quote observation remains one exact point including tiny WBTC prices',()=>{
  assert.deepEqual(observationSeries([{time:1700000000,priceQuote:2e-10,slot:1}]),[{time:1700000000,value:2e-10}]);
  assert.equal(formatCurveNumber(2e-10),'0.0000000002');
  assert.deepEqual(observationSeries([{time:1700000000,priceQuote:2e-10}],{mode:'fdv',supply:1e9}),[{time:1700000000,value:.2}]);
});
test('a verified current snapshot supplies one exact point when history is missing without inventing candles',()=>{
  const snapshot={status:'curve',at:1700000000500,slot:300,priceQuote:2e-10,quote:{stale:true},priceUsd:12,fdvUsd:12000};
  const data=curveChartSnapshot(snapshot);assert.deepEqual(data.points,[{time:1700000000,priceQuote:2e-10,slot:300}]);assert.deepEqual(data.candles,[]);assert.equal(data.priceUsd,null);assert.equal(data.fdvUsd,null);
  assert.deepEqual(curveChartSnapshot({...snapshot,status:'migrated'}).points,[]);assert.deepEqual(curveChartSnapshot({...snapshot,slot:0}).points,[]);assert.deepEqual(curveChartSnapshot({...snapshot,at:null}).points,[]);assert.equal(curveChartSnapshot({...snapshot,status:'migrated'}).priceQuote,null);
});
test('observations are sorted and deduplicated without inventing history or accepting invalid prices',()=>{
  const rows=observationSeries([{time:1700000001,priceQuote:2},{time:1700000000,priceQuote:1},{time:1700000001,priceQuote:3},{time:1700000002,priceQuote:null},{time:1700000003,priceQuote:Infinity},{time:1700000004,priceQuote:-1},{time:0,priceQuote:1}]);
  assert.deepEqual(rows,[{time:1700000000,value:1},{time:1700000001,value:3}]);
  assert.deepEqual(observationSeries(rows,{mode:'fdv',supply:Infinity}),[]);
});
test('real candle history validates OHLC and scales every price together for current-supply FDV',()=>{
  const candle={time:1700000000,open:1e-10,high:3e-10,low:1e-10,close:2e-10,volume:99};
  assert.deepEqual(curveCandles([candle],{mode:'fdv',supply:1e9}),[{time:1700000000,open:.1,high:.3,low:.1,close:.2}]);
  assert.deepEqual(curveCandles([{...candle,high:1e-11},{...candle,low:4e-10},{...candle,close:null},{...candle,open:-1}]),[]);
});
function libraryFixture(){
  const rows=[],timeScale={fits:0,fitContent(){this.fits++;}},chart={removed:false,addSeries(type,options){const series={type,options,resets:[],updates:[],visibility:[],setData(rows){this.resets.push(rows);},update(row){this.updates.push(row);},applyOptions(options){this.visibility.push(options.visible);}};rows.push(series);return series;},timeScale:()=>timeScale,remove(){this.removed=true;}};
  return {rows,chart,timeScale,library:{AreaSeries:'area',CandlestickSeries:'candles',createChart:()=>chart}};
}
test('append and same-time refresh update a stable chart without repeatedly fitting user zoom',async()=>{
  const fixture=libraryFixture(),view=await createLaunchCurveChart({},fixture);
  view.set([{time:1700000000,priceQuote:1}]);view.set([{time:1700000000,priceQuote:1},{time:1700000005,priceQuote:2}]);view.set([{time:1700000000,priceQuote:1},{time:1700000005,priceQuote:3}]);
  assert.equal(fixture.rows[0].resets.length,1);assert.deepEqual(fixture.rows[0].updates,[{time:1700000005,value:2},{time:1700000005,value:3}]);assert.equal(fixture.timeScale.fits,1);
  assert.equal(fixture.rows[0].options.pointMarkersVisible,true);assert.equal(fixture.rows[0].options.pointMarkersRadius,5);
  view.set([{time:1700000000,priceQuote:1},{time:1700000005,priceQuote:3}],{mode:'fdv',supply:100});assert.equal(fixture.rows[0].resets.length,2);assert.equal(fixture.rows[0].resets[1][1].value,300);view.remove();assert.equal(fixture.chart.removed,true);
});
test('received trade candles replace observed line without fabricating a candle from the live snapshot',async()=>{
  const fixture=libraryFixture(),view=await createLaunchCurveChart({},fixture),points=[{time:1700000005,priceQuote:2}],candle={time:1700000000,open:1,high:2,low:1,close:2};
  view.set(points);view.set(points,{candles:[candle]});assert.equal(fixture.rows[0].visibility.at(-1),false);assert.equal(fixture.rows[1].visibility.at(-1),true);assert.deepEqual(fixture.rows[1].resets,[[candle]]);
  view.set(points,{candles:[{...candle,high:3,close:3}]});assert.equal(fixture.rows[1].resets.length,1);assert.deepEqual(fixture.rows[1].updates,[{...candle,high:3,close:3}]);assert.equal(fixture.timeScale.fits,2);
});

test('intervals aggregate real trades for seconds and minute candles for longer periods',()=>{
  const trades=[{time:121,quote:8,amount:2},{time:120,quote:4,amount:2},{time:119,quote:2,amount:2}];
  assert.deepEqual(intervalCandles([],trades,30),[{time:90,open:1,high:1,low:1,close:1,volume:2},{time:120,open:1,high:4,low:1,close:4,volume:12}]);
  assert.equal(intervalCandles([],trades,1).length,3);
  assert.deepEqual(intervalCandles([{time:120,open:1,high:9,low:1,close:9}],[],1),[]);
  assert.deepEqual(intervalCandles([{time:120,open:1,high:3,low:1,close:2,volume:5},{time:180,open:2,high:4,low:2,close:3,volume:7}],[],300),[{time:0,open:1,high:4,low:1,close:3,volume:12}]);
});

test('sparse seconds candles carry the previous executed close without inventing activity',()=>{
  const trades=[{time:189,quote:2,amount:2},{time:155,quote:6,amount:2},{time:121,quote:4,amount:2}];
  for(const seconds of [1,5,15,30]){
    const rows=intervalCandles([],trades,seconds);
    assert.equal(rows.length,3);
    assert.deepEqual(rows.map(({open,high,low,close,volume})=>({open,high,low,close,volume})),[{open:2,high:2,low:2,close:2,volume:4},{open:2,high:3,low:2,close:3,volume:6},{open:3,high:3,low:1,close:1,volume:2}]);
    assert.equal(rows.reduce((n,r)=>n+r.volume,0),12);
    assert(rows[2].time-rows[1].time>=30);
  }
});

test('the chart axis and crosshair label times in the visitor time zone; day candles keep their UTC dates',async()=>{
  let options=null;const fixture=libraryFixture();fixture.library.createChart=(_container,value)=>{options=value;return fixture.chart;};
  const view=await createLaunchCurveChart({},{...fixture,timeZone:'America/Los_Angeles'}),at=Date.UTC(2026,9,3,14,45,30)/1000,midnight=Date.UTC(2026,9,3)/1000;
  const tick=options.timeScale.tickMarkFormatter,crosshair=options.localization.timeFormatter;
  assert.equal(tick(at,3,'en-US'),'07:45');assert.equal(tick(at,4,'en-US'),'07:45:30');assert.equal(crosshair(at),'Oct 3, 2026, 07:45');
  assert.equal(tick(midnight,2,'en-US'),'Oct 2 17:00','a UTC day mark shows its local date and time');assert(options.timeScale.tickMarkMaxCharacterLength>=11);
  view.set([],{interval:15,candles:[]});assert.equal(crosshair(at),'Oct 3, 2026, 07:45:30','second intervals show seconds');
  view.set([],{interval:86400,candles:[]});assert.equal(tick(midnight,2,'en-US'),null,'day candles keep the library UTC date');assert.equal(crosshair(midnight),'Oct 3, 2026');
  const utc=await createLaunchCurveChart({},{...fixture,timeZone:'UTC'});assert.equal(options.timeScale.tickMarkFormatter(midnight,2,'en-US'),'3');assert.equal(options.timeScale.tickMarkFormatter(at,3,'en-US'),'14:45');utc.remove();
});
