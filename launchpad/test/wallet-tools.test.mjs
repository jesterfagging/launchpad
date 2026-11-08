import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultTradingWallets, generateWalletBatch } from '../src/wallet-generation.mjs';
import { upgradeWalletTools } from '../src/wallet-tools.mjs';
import { defaults } from '../src/telegram-settings.mjs';
import { selectedRunSettings } from '../src/run-settings.mjs';
import { checkWalletCaps, toolWallets } from '../public/wallet-limits.mjs';
import { createPreset, readPreset } from '../public/presets.mjs';

test('wallet groups have independent caps, preset selections and no default Main wallet',async()=>{
 const settings=await defaultTradingWallets(defaults);
 for(const [kind,cap] of [['copy',25],['liquidity',10],['market',5]]) {
  const group=toolWallets(settings,kind); settings.wallets.push(...await generateWalletBatch(cap-1,group,kind));
  assert.equal(selectedRunSettings(settings,kind).wallets.length,cap);
  await assert.rejects(generateWalletBatch(1,toolWallets(settings,kind),kind),/Maximum/);
 }
 assert.equal(settings.wallets.length,40); checkWalletCaps(settings,{wallets:[]});
 settings.runWallets={copy:[settings.defaultWallets.copy],sniper:[toolWallets(settings,'copy')[1].publicKey]};
 const saved=readPreset(JSON.stringify(createPreset(settings))); assert.equal(selectedRunSettings(saved,'sniper').wallets[0].publicKey,settings.runWallets.sniper[0]);
 assert.equal(selectedRunSettings(saved,'copy').wallets[0].publicKey,settings.defaultWallets.copy);
 await assert.rejects(async()=>selectedRunSettings({...settings,runWallets:{market:[settings.defaultWallets.copy]}},'market'),/no longer imported/);
});
test('legacy migration preserves every key and position, creates three defaults once, and keeps old selections',async()=>{
 const old=await generateWalletBatch(3); old.forEach(w=>delete w.tool);
 const saved={...structuredClone(defaults),wallets:old}, books={'liquidity-live':{lots:[{wallet:old[1].publicKey}],pending:[]},'market-live':{lots:[{wallet:old[2].publicKey}],pending:[]}};
 let writes=0; const store={async read(name,fallback){return books[name]||fallback;},async write(name,v){books[name]=structuredClone(v);writes++;}};
 const next=await upgradeWalletTools(saved,store); assert.equal(next.wallets.length,6); assert.deepEqual(next.wallets.slice(0,3).map(w=>w.tool),['copy','liquidity','market']);
 assert.deepEqual(next.wallets.slice(0,3).map(w=>w.privateKey),old.map(w=>w.privateKey));
 assert.deepEqual(next.runWallets.copy,[old[0].publicKey]); assert.equal(writes,1);
 await upgradeWalletTools(next,store); assert.equal(writes,1);
 assert.deepEqual(books['liquidity-live'].lots,[{wallet:old[1].publicKey}]);
});
test('legacy over-cap MM wallets remain recoverable but cannot start or grow beyond the new cap',async()=>{
 const wallets=await generateWalletBatch(20); wallets.forEach(w=>delete w.tool);
 const store={async read(name,fallback){return name==='market-live'?{lots:wallets.map(w=>({wallet:w.publicKey})),pending:[]}:fallback;},async write(){}};
 const saved=await upgradeWalletTools({...structuredClone(defaults),wallets},store);
 assert.equal(toolWallets(saved,'market').length,20); checkWalletCaps(saved,saved);
 assert.equal(selectedRunSettings(saved,'market').wallets.length,5);
 const extra=(await generateWalletBatch(1,[],'market'))[0];
 assert.throws(()=>checkWalletCaps({...saved,wallets:[...saved.wallets,extra]},saved),/Maximum/);
});
