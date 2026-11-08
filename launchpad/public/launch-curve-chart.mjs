import { chartTimeFormatters } from './ui-performance.mjs';
// The chart accent follows the page's --acc token (the launchpad's accent colour).
const chartAccent = (fallback) => { try { const value = globalThis.getComputedStyle?.(document.body).getPropertyValue('--acc').trim(); return /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback; } catch { return fallback; } };

// Seconds are built from executed trades. The opening price carries the last
// known execution close, matching a continuous last-traded-price chart. Empty
// time buckets are not fabricated; volume counts executions in this bucket only.
export function intervalCandles(candles=[],trades=[],seconds=60){
  if(![1,5,15,30,60,300,900,3600,14400,86400].includes(seconds))return [];
  const input=seconds<60?(Array.isArray(trades)?trades:[]).filter(t=>Number.isSafeInteger(t.time)&&t.time>0&&Number.isFinite(t.amount)&&t.amount>0&&Number.isFinite(t.quote)&&t.quote>0).slice().reverse().map(t=>({time:t.time,open:t.quote/t.amount,high:t.quote/t.amount,low:t.quote/t.amount,close:t.quote/t.amount,volume:t.quote})):curveCandles(candles).map(c=>({...c,volume:candles.find(r=>r.time===c.time)?.volume??null}));
  input.sort((a,b)=>a.time-b.time);const groups=new Map();
  for(const c of input){const time=Math.floor(c.time/seconds)*seconds,old=groups.get(time);if(!old)groups.set(time,{...c,time});else{old.high=Math.max(old.high,c.high);old.low=Math.min(old.low,c.low);old.close=c.close;old.volume=old.volume!=null&&c.volume!=null?old.volume+c.volume:null;}}
  const rows=[...groups.values()];
  if(seconds<60)for(let i=1;i<rows.length;i++){
    const open=rows[i-1].close;
    rows[i].open=open;rows[i].high=Math.max(open,rows[i].high);rows[i].low=Math.min(open,rows[i].low);
  }
  return rows;
}
// Raydium quote candles and observed curve prices remain separate; USD history is never backfilled.
export function observationSeries(points, { supply = 1, mode = 'price' } = {}) {
  const multiplier = mode === 'fdv' ? Number(supply) : 1;
  if (!Number.isFinite(multiplier) || multiplier <= 0) return [];
  const rows = new Map();
  for (const point of Array.isArray(points) ? points : []) {
    const time = Number(point?.time), price = Number(point?.priceQuote), value = price * multiplier;
    if (!Number.isSafeInteger(time) || time <= 0 || point?.priceQuote == null || !Number.isFinite(price) || price <= 0 || !Number.isFinite(value)) continue;
    rows.set(time, { time, value });
  }
  return [...rows.values()].sort((a, b) => a.time - b.time).slice(-1500);
}
export function curveCandles(candles, { supply = 1, mode = 'price' } = {}) {
  const multiplier = mode === 'fdv' ? Number(supply) : 1;
  if (!Number.isFinite(multiplier) || multiplier <= 0) return [];
  const rows = new Map();
  for (const candle of Array.isArray(candles) ? candles : []) {
    const time = Number(candle?.time), values = ['open','high','low','close'].map(key => candle?.[key] == null ? NaN : Number(candle[key]) * multiplier);
    const [open,high,low,close] = values;
    if (!Number.isSafeInteger(time) || time <= 0 || values.some(value => !Number.isFinite(value) || value <= 0) || high < Math.max(open,close) || low > Math.min(open,close) || high < low) continue;
    rows.set(time, {time,open,high,low,close});
  }
  return [...rows.values()].sort((a,b) => a.time-b.time).slice(-1500);
}
export const formatCurveNumber = value => Number.isFinite(Number(value)) && value != null ? Number(value).toLocaleString(undefined, { maximumSignificantDigits: 6 }) : '—';
// Chart labels only (price axis, crosshair, last price): below 0.00001 the run of zeros after the decimal
// point is written as a subscript count, so 0.000000271051 reads 0.0₆271051 and tiny quote prices do not
// widen the price scale. Six significant digits, like formatCurveNumber; page text keeps the full decimals.
const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';
export function formatChartPrice(value) {
  const number = Number(value);
  if (value == null || !Number.isFinite(number)) return '—';
  const magnitude = Math.abs(number);
  if (magnitude === 0 || magnitude >= 1e-5) return formatCurveNumber(number);
  const [mantissa, exponent] = magnitude.toExponential(5).split('e');
  const zeros = -Number(exponent) - 1, digits = mantissa.replace('.', '').replace(/0+$/, '') || '0';
  const decimal = (0.5).toLocaleString().replace(/\d/g, '') || '.';
  return (number < 0 ? '-' : '') + '0' + decimal + '0' + [...String(zeros)].map(digit => SUBSCRIPT[digit]).join('') + digits;
}

// A confirmed current snapshot is itself one observation. It must remain visible
// when the separate history service has no rows yet; it is never a trade candle.
export function curveChartSnapshot(snapshot) {
  if(!snapshot||typeof snapshot!=='object')return null;
  const points=(Array.isArray(snapshot.points)?snapshot.points:[]).filter(point=>Number.isSafeInteger(point?.time)&&point.time>0&&Number.isFinite(Number(point.priceQuote))&&Number(point.priceQuote)>0).map(point=>({...point,priceQuote:Number(point.priceQuote)}));
  if(!points.length&&snapshot.status==='curve'&&Number.isSafeInteger(snapshot.slot)&&snapshot.slot>0&&Number.isFinite(Number(snapshot.at))&&Number(snapshot.at)>=1000&&Number(snapshot.at)<=8640000000000000&&snapshot.priceQuote!=null&&Number.isFinite(Number(snapshot.priceQuote))&&Number(snapshot.priceQuote)>0)points.push({time:Math.floor(Number(snapshot.at)/1000),priceQuote:Number(snapshot.priceQuote),slot:snapshot.slot});
  const result={...snapshot,points,candles:(Array.isArray(snapshot.candles)?snapshot.candles:[]).filter(candle=>curveCandles([candle]).length>0).map(candle=>({...candle}))};
  if(snapshot.status!=='curve'){result.priceQuote=null;result.fdvQuote=null;result.priceUsd=null;result.fdvUsd=null;}
  else if(snapshot.quote?.stale!==false){result.priceUsd=null;result.fdvUsd=null;}
  return result;
}

export async function createLaunchCurveChart(container, { library, timeZone } = {}) {
  const { createChart, AreaSeries, CandlestickSeries, HistogramSeries } = library || await import('./vendor/lightweight-charts.mjs');
  // The axis and crosshair use the visitor's local time, like the rest of the page.
  let interval = 60;
  const times = chartTimeFormatters({ daily: () => interval >= 86400, seconds: () => interval < 60, timeZone });
  // Sunrise chart theme: a quiet inset background, faint gridlines, a dashed peach crosshair with brand labels,
  // green/coral candles that match the trade chips, and a peach area line for observed prices.
  const chart = createChart(container, {
    autoSize: true,
    layout: { background: { type: 'solid', color: '#0b0b0c' }, textColor: '#9a9aa3', fontSize: 11, fontFamily: "'Launchpad Inter', Inter, ui-sans-serif, sans-serif", attributionLogo: true },
    grid: { vertLines: { color: '#121214' }, horzLines: { color: '#121214' } },
    // A few wide candles (1d, 4h) stay candle-sized instead of stretching across the plot.
    timeScale: { timeVisible: true, secondsVisible: true, borderColor: '#1f1f23', rightOffset: 5, maxBarSpacing: 48, tickMarkFormatter: times.tickMarkFormatter, tickMarkMaxCharacterLength: 12 },
    rightPriceScale: { borderColor: '#1f1f23', scaleMargins: { top: .14, bottom: .22 } },
    crosshair: { mode: 0, vertLine: { color: chartAccent(chartAccent('#8b5cff')) + '80', width: 1, style: 2, labelBackgroundColor: chartAccent('#1a1430') + '33' }, horzLine: { color: chartAccent(chartAccent('#8b5cff')) + '80', width: 1, style: 2, labelBackgroundColor: chartAccent('#1a1430') + '33' } },
    localization: { priceFormatter: formatChartPrice, timeFormatter: times.timeFormatter },
  });
  const series = chart.addSeries(AreaSeries, {
    lineColor: chartAccent('#8b5cff'), topColor: chartAccent(chartAccent('#8b5cff')) + '40', bottomColor: chartAccent('#4b2fa0') + '00', lineWidth: 2,
    pointMarkersVisible: true, pointMarkersRadius: 5, lastValueVisible: true, priceLineColor: chartAccent('#8b5cff'), priceLineStyle: 2,
    crosshairMarkerBorderColor: '#ffffff', crosshairMarkerBackgroundColor: chartAccent('#8b5cff'),
    priceFormat: { type: 'custom', base: 1e18, minMove: 1e-18, formatter: formatChartPrice },
    lastPriceAnimation: 0,
  });
  const candles = chart.addSeries(CandlestickSeries, { visible: false, upColor: '#2ee59d', downColor: '#ff4d6d', borderVisible: false, wickUpColor: '#2ee59dcc', wickDownColor: '#ff4d6dcc', priceLineColor: chartAccent('#8b5cff'), priceLineStyle: 2, priceFormat: {type:'custom',base:1e18,minMove:1e-18,formatter:formatChartPrice} });
  const volume=HistogramSeries?chart.addSeries(HistogramSeries,{priceFormat:{type:'volume'},priceScaleId:'volume',lastValueVisible:false,priceLineVisible:false}):null;
  volume?.priceScale().applyOptions({scaleMargins:{top:.84,bottom:0}});
  let previous = [], configuration = '', initialized = false;
  return {
    set(points, options = {}) {
      interval = Number(options.interval) || 60;
      const history = curveCandles(options.candles, options), useCandles = history.length > 0;
      const target = useCandles ? candles : series, next = useCandles ? history : observationSeries(points, options), key = `${useCandles?'candles':'observations'}:${options.mode || 'price'}:${options.supply || 1}:${options.interval||60}`;
      volume?.setData((options.candles||[]).filter(c=>Number.isFinite(c.volume)&&c.volume>=0).map(c=>({time:c.time,value:c.volume,color:c.close>=c.open?'#2ee59d3d':'#ff4d6d3d'})));
      if(configuration&&configuration!==key)initialized=false;
      series.applyOptions({visible:!useCandles});candles.applyOptions({visible:useCandles});
      const prefix = configuration === key && previous.length <= next.length && previous.slice(0,-1).every((row, index) => JSON.stringify(row) === JSON.stringify(next[index])) && (!previous.length || previous.at(-1).time === next[previous.length-1]?.time);
      if (!prefix) target.setData(next);
      else {
        const start = previous.length && JSON.stringify(previous.at(-1)) !== JSON.stringify(next[previous.length-1]) ? previous.length-1 : previous.length;
        for (const row of next.slice(start)) target.update(row);
      }
      previous = next; configuration = key;
      if (!initialized && next.length) { chart.timeScale().fitContent(); initialized = true; }
    },
    remove() { chart.remove(); },
  };
}
