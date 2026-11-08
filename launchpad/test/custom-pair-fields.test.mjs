import test from 'node:test';
import assert from 'node:assert/strict';
import { customPairLabels } from '../public/custom-pair-fields.mjs';

test('custom labels preserve requested emoji, punctuation, casing and Unicode spacing exactly',()=>{
 for(const [name,ticker] of [['🟥🟪🟦🟩🟨🟧','🟥🟩'],['You’ll','You’ll'],['“Rainbow”','‘RGB’'],['我的刀盾','我的刀盾'],['熊猫','熊猫'],['Upside Down Cat','USDC'],['"　"','"　"'],['Xavier: Renegade Angel','Xavier'],['Energy','$NRG'],['Funny','LMAO!'],['Gork','@gork']])assert.deepEqual(customPairLabels({name,ticker}),{name,symbol:ticker});
 assert.deepEqual(customPairLabels({name:'  Name  ',ticker:'  aBc  '}),{name:'Name',symbol:'aBc'});
});
test('label bounds count Unicode code points without permitting markup, controls, format or bidi characters',()=>{
 assert.deepEqual(customPairLabels({name:'🟥'.repeat(80),ticker:'🟩'.repeat(24)}),{name:'🟥'.repeat(80),symbol:'🟩'.repeat(24)});
 assert.throws(()=>customPairLabels({name:'🟥'.repeat(81),ticker:'OK'}));assert.throws(()=>customPairLabels({name:'Name',ticker:'🟩'.repeat(25)}));
 for(const value of ['<script>','bad\u200btext','bad\u200dtext','bad\u202etext','bad\u2066text','bad\u0000text','bad\ntext','\nName','Name\t','\u007fName','\ud800','   ']){
  assert.throws(()=>customPairLabels({name:value,ticker:'OK'}),JSON.stringify(value));assert.throws(()=>customPairLabels({name:'Name',ticker:value}),JSON.stringify(value));
 }
});
