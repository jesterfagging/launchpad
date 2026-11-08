import {randomBytes} from 'node:crypto';
import {requireValue as ok,units,displayUnits} from '../public/launchpad-model.mjs';
const SCALE=100000000000n,TOTAL=100n*SCALE;
function randomBetween(min,max){const range=max-min+1n,bytes=Math.ceil(range.toString(2).length/8),space=1n<<BigInt(bytes*8),ceiling=space-space%range;let n;do{n=BigInt('0x'+randomBytes(bytes).toString('hex'));}while(n>=ceiling);return min+n%range;}
export function fundingAllocations(raw,random=randomBetween){
  const mode=raw.allocationMode||'percent',rows=raw.recipients;
  ok(['percent','amount','random'].includes(mode),'Choose percentage, per-wallet amount, or random funding.');
  ok(Array.isArray(rows)&&rows.length>0&&rows.length<=100,'Choose 1–100 destination wallets.');
  if(mode==='percent')return{mode,totalAmount:raw.totalAmount,recipients:rows};
  let min,max;
  if(mode==='random'){min=units(raw.randomMin,9,'Minimum per wallet');max=units(raw.randomMax,9,'Maximum per wallet');ok(min>0n&&max>=min&&max<=10000000000000000n,'Set a positive random range with the maximum at least the minimum.');}
  const amounts=rows.map(r=>mode==='random'?random(min,max):units(r.amount,9,'Amount per wallet'));
  ok(amounts.every(n=>n>0n&&n<=10000000000000000n),'Every selected wallet needs a positive amount, up to 10 million units.');
  const total=amounts.reduce((n,a)=>n+a,0n);ok(total<=10000000000000000n,'The combined funding amount cannot exceed 10 million units.');
  const weights=amounts.map((n,i)=>({i,value:n*TOTAL/total,remainder:n*TOTAL%total}));
  let remainder=TOTAL-weights.reduce((n,w)=>n+w.value,0n);
  for(const w of weights.slice().sort((a,b)=>a.remainder===b.remainder?a.i-b.i:a.remainder>b.remainder?-1:1)){if(!remainder)break;w.value++;remainder--;}
  const recipients=rows.map((row,i)=>{
    const represented=(total*weights[i].value+TOTAL/2n)/TOTAL;
    ok(weights[i].value>0n&&represented===amounts[i],'These amounts exceed the route’s allocation precision. Use fewer decimal places or reduce the total.');
    return{...row,percent:Number(weights[i].value)/Number(SCALE),amount:displayUnits(amounts[i])};
  });
  return{mode,totalAmount:displayUnits(total),recipients,...(mode==='random'?{randomMin:displayUnits(min),randomMax:displayUnits(max)}:{})};
}
