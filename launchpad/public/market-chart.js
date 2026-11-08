import { createChart, CandlestickSeries, HistogramSeries } from './vendor/lightweight-charts.mjs';
import { candleUpdate, chartTimeFormatters } from './ui-performance.mjs';
// The chart's colours follow the page's tokens (the accent and the dark or light surfaces), and follow a theme switch (a
// launchpad's shell announces one as 'tenant-theme-change').
const token = (name, fallback) => { try { const value = globalThis.getComputedStyle?.(document.body).getPropertyValue(name).trim(); return /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback; } catch { return fallback; } };
const chartAccent = (fallback) => token('--acc', fallback);
const surfaceOptions = () => ({ layout: { background: { type: 'solid', color: token('--s1', '#0b0b0c') }, textColor: token('--muted', '#9a9aa3') }, grid: { vertLines: { color: token('--line', '#121214') }, horzLines: { color: token('--line', '#121214') } }, timeScale: { borderColor: token('--line-strong', '#1f1f23') }, rightPriceScale: { borderColor: token('--line-strong', '#1f1f23') } });

// TradingView Lightweight Charts™ 5.0.9. The unmodified library and its
// Apache-2.0 license/NOTICE are distributed in public/vendor.
export function marketChart(container) {
  container.replaceChildren();
  // Local-time axis and crosshair; candles a day or more apart keep their UTC dates.
  let daily=false;const times=chartTimeFormatters({daily:()=>daily});
  const chart=createChart(container,{autoSize:true,localization:{locale:'en-US',timeFormatter:times.timeFormatter},layout:{background:{type:'solid',color:token('--s1','#0b0b0c')},textColor:token('--muted','#9a9aa3'),fontSize:11,attributionLogo:true},grid:{vertLines:{color:token('--line','#121214')},horzLines:{color:token('--line','#121214')}},timeScale:{timeVisible:true,secondsVisible:false,borderColor:token('--line-strong','#1f1f23'),tickMarkFormatter:times.tickMarkFormatter,tickMarkMaxCharacterLength:12},rightPriceScale:{borderColor:token('--line-strong','#1f1f23'),scaleMargins:{top:0.12,bottom:0.25}},crosshair:{mode:0,vertLine:{color:chartAccent(chartAccent('#8b5cff')) + '80',style:2,labelBackgroundColor:chartAccent('#1a1430') + '33'},horzLine:{color:chartAccent(chartAccent('#8b5cff')) + '80',style:2,labelBackgroundColor:chartAccent('#1a1430') + '33'}}});
  const price=chart.addSeries(CandlestickSeries,{upColor:'#2ee59d',downColor:'#ff4d6d',borderVisible:false,wickUpColor:'#2ee59dcc',wickDownColor:'#ff4d6dcc',priceFormat:{type:'custom',minMove:0.000000000001,formatter:value=>Number(value).toLocaleString('en-US',{maximumSignificantDigits:6})}});
  const volume=chart.addSeries(HistogramSeries,{priceFormat:{type:'volume'},priceScaleId:'volume',lastValueVisible:false,priceLineVisible:false});volume.priceScale().applyOptions({scaleMargins:{top:0.83,bottom:0}});
  const onTheme=()=>{try{chart.applyOptions(surfaceOptions());}catch{/* the chart may be gone */}};document.addEventListener('tenant-theme-change',onTheme);
  let initial=true, previous=[];
  const priceBar=({time,open,high,low,close})=>({time,open,high,low,close});
  const volumeBar=row=>({time:row.time,value:row.volume,color:row.close>=row.open?'rgba(127,224,168,0.24)':'rgba(244,154,154,0.24)'});
  return { set(candles){
    const gaps=candles.slice(1).map((row,index)=>row.time-candles[index].time).filter(gap=>gap>0);daily=gaps.length>0&&Math.min(...gaps)>=86400;
    const change=candleUpdate(previous,candles);
    if(change.reset){price.setData(candles.map(priceBar));volume.setData(candles.map(volumeBar));}
    else for(const row of change.rows){price.update(priceBar(row));volume.update(volumeBar(row));}
    previous=candles.map(row=>({...row}));
    if(initial&&candles.length){chart.timeScale().fitContent();initial=false;}
  }, remove(){document.removeEventListener('tenant-theme-change',onTheme);chart.remove();} };
}
