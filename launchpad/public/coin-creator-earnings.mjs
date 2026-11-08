const RAW=/^(0|[1-9]\d{0,39})$/;
const ADDRESS=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// Compact display: up to 4 decimals (or 4 significant digits below 1), grouped
// thousands, rounded half-up with integer math. The exact amount stays in title.
function compactUnits(exact){
  if(typeof exact!=='string'||!/^\d+(\.\d+)?$/.test(exact))return exact;
  const [whole,fraction='']=exact.split('.');if(!fraction)return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',');
  const keep=Math.min(fraction.length,whole==='0'?fraction.match(/^0*/)[0].length+4:4);
  const scaled=BigInt(whole+fraction.slice(0,keep))+(Number(fraction[keep]||0)>=5?1n:0n),digits=scaled.toString().padStart(keep+1,'0');
  const rounded=digits.slice(0,digits.length-keep),decimals=digits.slice(digits.length-keep).replace(/0+$/,'');
  return rounded.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(decimals?'.'+decimals:'');
}
function units(value,decimals){if(typeof value!=='string'||!RAW.test(value)||!Number.isInteger(decimals)||decimals<0||decimals>18)return null;const amount=BigInt(value),scale=10n**BigInt(decimals),fraction=(amount%scale).toString().padStart(decimals,'0').replace(/0+$/,'');return String(amount/scale)+(fraction?'.'+fraction:'');}
export function createCoinCreatorEarningsView({document,root}){
  if(!root)return{render(){}};
  if(document.head&&!document.getElementById('coin-creator-earnings-styles')){const style=document.createElement('link');style.id='coin-creator-earnings-styles';style.rel='stylesheet';style.href='/coin-creator-earnings.css?v=64';document.head.append(style);}
  const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
  return{render({coin}={}){
    root.replaceChildren();root.hidden=coin?.feeMode!=='creator';if(root.hidden)return;
    const data=coin?.creatorEarnings,valid=data?.scope==='coin'&&data.quote?.mint===coin.quote?.mint&&['available','partial','unavailable'].includes(data.status),symbol=String(valid?data.quote.symbol||coin.quote?.symbol||'quote':coin.quote?.symbol||'quote').slice(0,24);
    root.append(el('h2','Creator earnings'));const grid=el('dl',undefined,'creator-earnings-grid');
    for(const [key,label]of [['earnedRaw','Recorded creator revenue'],['paidRaw','Paid to recipients'],['pendingRaw',coin.platform==='pumpswap'?'Awaiting automatic payout':'Collected awaiting payout']]){
      const amount=valid?units(data[key],data.quote.decimals):null,row=el('div'),value=el('dd',amount===null?'Unavailable':compactUnits(amount)+' '+symbol);if(amount!==null){value.title=amount+' '+symbol;value.dataset.motionNumber='';if(compactUnits(amount)!==amount)value.dataset.rounded='true';}else value.className='is-unavailable';row.append(el('dt',label),value);grid.append(row);
    }
    root.append(grid);
    if(valid&&ADDRESS.test(data.recipient||'')){const recipient=el('p',undefined,'creator-earnings-recipient'),link=el('a',data.recipient.slice(0,6)+'…'+data.recipient.slice(-6));link.href='https://solscan.io/account/'+data.recipient;link.target='_blank';link.rel='noopener noreferrer';recipient.append(el('span','Current fee recipient: '),link);root.append(recipient);}
    root.append(el('p',valid&&typeof data.note==='string'?data.note.slice(0,700):'Creator earnings are unavailable while the saved fee history refreshes.','creator-earnings-note'));
    // The short date matches the reward and Pump.fun cards; the exact time stays in datetime.
    if(valid&&Number.isSafeInteger(data.at)&&data.at>0&&data.at<=Date.now()){const time=el('time','Last recorded '+new Date(data.at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}),'creator-earnings-time');time.dateTime=new Date(data.at).toISOString();root.append(time);}
  }};
}
