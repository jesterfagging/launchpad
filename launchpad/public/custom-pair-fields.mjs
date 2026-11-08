// Display labels never identify an asset; the canonical mint does. Keep real
// ticker punctuation and Unicode while excluding markup and invisible controls.
export function customPairLabels({name,ticker}={}){
  const clean=(value,max,label)=>{
    const text=typeof value==='string'?value.trim():'';
    if(!text||/[\p{Cc}\p{Cf}]/u.test(value)||[...text].length>max||!/^[\p{L}\p{N}\p{M}\p{Zs}\p{Extended_Pictographic}‘’“”.,'":;!?@#$%&()_+\-=/]+$/u.test(text))throw Error(`Use ${label} with 1–${max} visible letters, numbers, emoji, spaces or standard punctuation.`);
    return text;
  };
  return {name:clean(name,80,'a name'),symbol:clean(ticker,24,'a ticker')};
}
