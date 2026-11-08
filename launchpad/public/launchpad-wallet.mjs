// Wallet Standard discovery stays inside the launchpad. Wallets only sign;
// Launchpad validates, journals and submits the returned transaction.
const CHAIN='solana:mainnet', SIGN='solana:signTransaction', MESSAGE='solana:signMessage';
// Non-canonical spellings some wallets use for Solana mainnet.
const MAINNET=[CHAIN,'solana:mainnet-beta','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'];
const ADDRESS=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const DISCOVERY_GRACE_MS=1200, ACCOUNT_WAIT_STEPS=10, ACCOUNT_WAIT_MS=100;
const CANCELLED='You cancelled the request in your wallet.';

const list=value=>{try{return value==null||typeof value==='string'?[]:Array.from(value);}catch{return[];}};
const tag=value=>Object.prototype.toString.call(value);
const byte=value=>Number.isInteger(value)&&value>=0&&value<=255;
const own=message=>Object.assign(Error(message),{curveWallet:true});

// Wallet outputs can come from another JS realm (extension worlds, iframes),
// as Buffers, plain number arrays, JSON-encoded Buffers or bare ArrayBuffers.
// Normalize every byte-shaped value to a same-realm copy; callers still check
// the exact length they require.
export function walletBytes(value){
  try{
    if(value==null||typeof value!=='object')return null;
    if(ArrayBuffer.isView(value)){
      if(tag(value)!=='[object DataView]'&&value.BYTES_PER_ELEMENT!==1)return null;
      return new Uint8Array(value.buffer,value.byteOffset,value.byteLength).slice();
    }
    if(tag(value)==='[object ArrayBuffer]')return new Uint8Array(value).slice();
    const items=Array.isArray(value)?value:value.type==='Buffer'&&Array.isArray(value.data)?value.data:null;
    if(items)return items.every(byte)?Uint8Array.from(items):null;
    const keys=Object.keys(value);// {"0":1,"1":2,…} from a JSON round trip of a typed array
    if(keys.length&&keys.length<=65536&&keys.every((key,index)=>key===String(index))){const values=keys.map(key=>value[key]);return values.every(byte)?Uint8Array.from(values):null;}
  }catch{/* Unreadable wallet output is treated as missing. */}
  return null;
}
function fromBase58(text){
  if(typeof text!=='string'||!text||text.length>128||!/^[1-9A-HJ-NP-Za-km-z]+$/.test(text))return null;
  const bytes=[];
  for(const char of text){let carry=B58.indexOf(char);for(let i=0;i<bytes.length;i++){carry+=bytes[i]*58;bytes[i]=carry&255;carry>>=8;}while(carry>0){bytes.push(carry&255);carry>>=8;}}
  for(let i=0;i<text.length&&text[i]==='1';i++)bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}
function signatureBytes(value){
  if(typeof value==='string'){
    if(/^[A-Za-z0-9+/]{86}==$/.test(value)){try{return Uint8Array.from(atob(value),x=>x.charCodeAt(0));}catch{return null;}}
    return fromBase58(value);
  }
  return walletBytes(value);
}
const toBase64=bytes=>{let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);};
const sameBytes=(a,b)=>a.length===b.length&&a.every((value,index)=>value===b[index]);

// Wallet rejections arrive as EIP-1193 style codes or free text that differs per wallet.
const REJECTED=/\b(?:user|you)\b[^.]{0,40}?\b(?:reject(?:ed)?|denied|declined|cancell?ed|aborted|closed)\b|\b(?:rejected|denied|declined|cancell?ed)\b\s+by\s+(?:the\s+)?user\b|\btransaction\s+(?:was\s+)?cancell?ed\b|\brequest\s+(?:was\s+)?(?:rejected|cancell?ed|denied|declined)\b|\bapproval\s+(?:was\s+)?(?:denied|rejected)\b|\b0x6985\b|\b(?:popup|window|plugin)\s+(?:was\s+)?closed\b/i;
export function isWalletRejection(error){
  try{
    if(error?.walletRejected)return true;
    const code=error?.code??error?.error?.code;
    if(code===4001||code==='4001'||code==='ACTION_REJECTED'||code==='USER_REJECTED')return true;
    if(/^UserRejected/i.test(String(error?.name||'')))return true;
    return REJECTED.test(String(error?.message??error?.error?.message??(typeof error==='string'?error:'')));
  }catch{return false;}
}
function walletFailure(error,action){
  if(error?.curveWallet)return error;
  if(isWalletRejection(error))return Object.assign(Error(CANCELLED),{code:4001,walletRejected:true,cause:error});
  let code,raw='';try{code=error?.code??error?.error?.code;raw=String(error?.message??error?.error?.message??(typeof error==='string'?error:'')).replace(/\s+/g,' ').trim().slice(0,200);}catch{/* Use the generic message. */}
  let text;
  if(code===4100||/not (?:been )?authori[sz]ed|unauthori[sz]ed/i.test(raw))text='Your wallet has not approved Launchpad yet. Open your wallet, approve the connection, then try again.';
  else if(code===-32002||/already pending|already (?:has|in) (?:a )?(?:pending|progress)|request (?:is )?already/i.test(raw))text='Your wallet already has a request open. Open your wallet, finish or dismiss it, then try again.';
  else if(code===4900||code===4901||/\bdisconnected\b|\bnot connected\b/i.test(raw))text='Your wallet is disconnected. Unlock it and connect again.';
  else if(/\blocked\b|\bunlock\b/i.test(raw))text='Unlock your wallet, then try again.';
  else if(/timed? ?out\b|timeout/i.test(raw))text='Your wallet did not respond in time. Open your wallet and try again.';
  else if(/blind sign|0x6a81|0x6808/i.test(raw))text='Your hardware wallet could not sign this request. Open the Solana app on the device, enable blind signing, then try again.';
  else{
    const start=action==='connect'?'Your wallet could not connect':action==='message'?'Your wallet could not sign the sign-in message':'Your wallet could not sign this transaction';
    text=raw&&!/^(?:unexpected error|internal error|error|undefined|null|\[object object\])\.?$/i.test(raw)?start+': '+raw.replace(/[.\s]+$/,'')+'.':start+'. Try again; if it keeps failing, unlock or restart your wallet.';
  }
  return Object.assign(Error(text),{code,walletError:true,cause:error});
}

export function isMobileBrowser(env=globalThis.window){
  try{
    const nav=env?.navigator,agent=String(nav?.userAgent||'');
    if(nav?.userAgentData?.mobile===true)return true;
    if(/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|Opera Mini|IEMobile|webOS|BlackBerry/i.test(agent))return true;
    return /Macintosh/i.test(agent)&&Number(nav?.maxTouchPoints)>1;// iPadOS reports a desktop agent
  }catch{return false;}
}
// Mobile browsers have no wallet extensions: these open the current page in a wallet's in-app browser.
export function walletDeepLinks(env=globalThis.window){
  try{
    const href=String(env?.location?.href||'');if(!/^https?:\/\//i.test(href))return[];
    const origin=String(env.location.origin||new URL(href).origin),url=encodeURIComponent(href),ref=encodeURIComponent(origin);
    return[
      {id:'phantom',name:'Phantom',href:`https://phantom.app/ul/browse/${url}?ref=${ref}`},
      {id:'solflare',name:'Solflare',href:`https://solflare.com/ul/v1/browse/${url}?ref=${ref}`},
      {id:'backpack',name:'Backpack',href:`https://backpack.app/ul/v1/browse/${url}?ref=${ref}`},
    ];
  }catch{return[];}
}
export function renderWalletDeepLinks({document,container,links,className='small-button'}={}){
  if(!document||!container||!Array.isArray(links))return 0;let count=0;
  for(const link of links){
    if(typeof link?.href!=='string'||!link.href.startsWith('https://'))continue;
    const anchor=document.createElement('a');anchor.className=className;anchor.href=link.href;anchor.rel='noopener';anchor.textContent='Open in '+link.name;Object.assign(anchor.style,{display:'flex',alignItems:'center',justifyContent:'center'});// CSSOM, allowed by the CSP
    anchor.setAttribute('data-wallet-deeplink',String(link.id||''));container.append(anchor);count++;
  }
  return count;
}

const walletName=wallet=>{try{const name=wallet?.name;return typeof name==='string'&&name.trim()?name.trim().slice(0,64):'Solana wallet';}catch{return'Solana wallet';}};
const mainnetChain=wallet=>{const chains=list(wallet?.chains);return MAINNET.find(chain=>chains.includes(chain))||(chains.some(chain=>String(chain).startsWith('solana:'))?null:CHAIN);};
// Wallet-level chains and features are authoritative. Account-level lists are
// often incomplete, so they only rank accounts instead of hiding them.
const compatible=wallet=>{
  try{
    const features=wallet?.features,sign=features?.[SIGN];
    return !!mainnetChain(wallet)&&typeof features['standard:connect']?.connect==='function'&&typeof sign?.signTransaction==='function'&&list(sign.supportedTransactionVersions).some(version=>version===0||version==='0');
  }catch{return false;}
};
const validAccount=account=>{try{return !!account&&typeof account.address==='string'&&ADDRESS.test(account.address);}catch{return false;}};
const accountsOf=wallet=>{try{return list(wallet?.accounts).filter(validAccount);}catch{return[];}};
function pickAccount(accounts,preferred){
  const rows=list(accounts).filter(validAccount);
  const mainnet=account=>MAINNET.some(chain=>list(account.chains).includes(chain)),signs=account=>list(account.features).includes(SIGN);
  return rows.find(account=>account.address===preferred)||rows.find(account=>mainnet(account)&&signs(account))||rows.find(mainnet)||rows[0]||null;
}

// Injected providers are a fallback for wallets whose Wallet Standard
// registration is missing or lacks sign-only versioned transaction support.
const INJECTED=[
  {name:'Phantom',find:env=>{const provider=env.phantom?.solana;if(provider?.isPhantom)return provider;return env.solana?.isPhantom&&!env.solana.isBraveWallet?env.solana:null;}},
  {name:'Solflare',find:env=>env.solflare?.isSolflare?env.solflare:env.solana?.isSolflare&&!env.solana.isPhantom?env.solana:null},
];
function injectedWallet(provider,name){
  if(typeof provider?.connect!=='function'||typeof provider.signTransaction!=='function')return null;
  const asAccount=key=>{if(!key)return null;let address='';try{address=String(key.toBase58?.()||key.toString());}catch{return null;}if(!ADDRESS.test(address))return null;let publicKey;try{publicKey=walletBytes(key.toBytes?.());}catch{/* optional */}return{address,publicKey:publicKey?.length===32?publicKey:fromBase58(address)||new Uint8Array(32),chains:[CHAIN],features:[SIGN,...(typeof provider.signMessage==='function'?[MESSAGE]:[])]};};
  let current=null;try{current=asAccount(provider.publicKey);}catch{/* not connected yet */}
  const signAll=()=>typeof provider.signAllTransactions==='function';
  return{name,chains:[CHAIN],get accounts(){return current?[current]:[];},features:{
    'standard:connect':{async connect(){const result=await provider.connect();let key=null;try{key=result?.publicKey||provider.publicKey;}catch{/* read below */}current=asAccount(key);return{accounts:current?[current]:[]};}},
    'standard:disconnect':{async disconnect(){current=null;await provider.disconnect?.();}},
    'standard:events':{on(type,listener){
      if(type!=='change'||typeof provider.on!=='function')return()=>{};
      const changed=key=>{current=asAccount(key);listener({accounts:current?[current]:[]});},disconnected=()=>changed(null);
      provider.on('accountChanged',changed);provider.on('disconnect',disconnected);
      return()=>{const remove=provider.removeListener||provider.off;remove?.call(provider,'accountChanged',changed);remove?.call(provider,'disconnect',disconnected);};
    }},
    ...(typeof provider.signMessage==='function'?{[MESSAGE]:{async signMessage(input){const result=await provider.signMessage(input.message,'utf8');const signature=result?.signature??result;return[{signature:signatureBytes(signature)||signature,signedMessage:input.message}];}}}:{}),
    [SIGN]:{supportedTransactionVersions:[0],get supportsBatchSigning(){return signAll();},async signTransaction(...inputs){
      if(!inputs.length||inputs.some(input=>!current||input?.account?.address!==current.address))throw own('Connect the developer wallet before signing.');
      // The documented injected providers accept web3 VersionedTransaction,
      // while some wallets omit sign-only support from Wallet Standard.
      const {VersionedTransaction}=await import('./vendor/solana-transaction.mjs');
      const transactions=inputs.map(input=>VersionedTransaction.deserialize(input.transaction));
      if(transactions.some(tx=>tx.version!==0))throw own('This wallet request uses an unsupported transaction version.');
      if(transactions.length>1&&!signAll())throw own('This wallet does not support signing a batch. Use a wallet with batch signing for test deployment.');
      const signed=transactions.length===1?[await provider.signTransaction(transactions[0])]:await provider.signAllTransactions(transactions);
      if(!Array.isArray(signed)||signed.length!==transactions.length||signed.some(tx=>typeof tx?.serialize!=='function'))throw own(name+' did not return every signed transaction.');
      return signed.map(tx=>({signedTransaction:walletBytes(tx.serialize())}));
    }}
  }};
}

const outputsOf=output=>Array.isArray(output)?output:output&&typeof output==='object'&&('signedTransaction' in output||'signature' in output)?[output]:[];
function signedTransactionBytes(item){
  const value=item?.signedTransaction;
  try{if(value&&typeof value.serialize==='function'&&!ArrayBuffer.isView(value))return walletBytes(value.serialize());}catch{return null;}
  return walletBytes(value);
}
async function verifiesOriginal(publicKey,signature,message){
  try{
    const subtle=globalThis.crypto?.subtle;if(!subtle||publicKey?.length!==32)return false;
    const key=await subtle.importKey('raw',publicKey,{name:'Ed25519'},false,['verify']);
    return await subtle.verify({name:'Ed25519'},key,signature,message);
  }catch{return false;}
}

export function createLaunchpadWallet({window:env=globalThis.window}={}){
  const registry=new Map(),listeners=new Set(),injected=new Map(),providers=new Map();
  let sequence=0,wallet=null,account=null,identity='',off=null,generation=0,disposed=false,inflight=0,pendingEmpty=false,settled=false;
  const mobile=isMobileBrowser(env);
  function scanInjected(){
    if(disposed||!env)return false;let added=false;
    for(const spec of INJECTED){
      try{
        const provider=spec.find(env);if(!provider||providers.get(spec.name)?.provider===provider)continue;
        const candidate=injectedWallet(provider,spec.name);if(!candidate)continue;
        const previous=providers.get(spec.name);
        if(previous&&previous.candidate!==wallet)for(const [id,value] of registry)if(value===previous.candidate)registry.delete(id);
        providers.set(spec.name,{provider,candidate});injected.set(candidate,spec.name.toLowerCase());registry.set(String(++sequence),candidate);added=true;
      }catch{/* A hostile or half-initialized provider must not break discovery. */}
    }
    return added;
  }
  function visible(){
    const standard=new Set();
    for(const candidate of registry.values())if(!injected.has(candidate)&&compatible(candidate))standard.add(walletName(candidate).toLowerCase());
    const rows=[],names=new Set();
    for(const [id,candidate] of registry){
      if(!compatible(candidate))continue;
      const name=walletName(candidate),key=name.toLowerCase(),current=candidate===wallet;
      // Prefer a compatible Wallet Standard registration over the injected fallback, and
      // hide duplicate registrations of the same wallet unless it is the connected one.
      if(!current&&(injected.has(candidate)&&standard.has(injected.get(candidate))||names.has(key)))continue;
      names.add(key);rows.push({id,name});
    }
    return rows;
  }
  const state=()=>{
    scanInjected();
    let wallets=[];try{wallets=visible();}catch{/* report no wallets rather than throwing into the UI */}
    let batchSigning=false;try{batchSigning=!!wallet&&wallet.features?.[SIGN]?.supportsBatchSigning!==false;}catch{/* false */}
    const empty=!wallets.length;
    return{address:account?.address||'',name:wallet?walletName(wallet):'',batchSigning,wallets,mobile,discovering:empty&&!settled,deepLinks:empty&&settled&&mobile?walletDeepLinks(env):[]};
  };
  const emit=()=>{const snapshot=state();for(const fn of [...listeners]){try{fn(snapshot);}catch{/* one listener must not block the rest */}}};
  const clear=()=>{generation++;try{off?.();}catch{/* already detached */}off=null;wallet=null;account=null;identity='';pendingEmpty=false;emit();};
  const register=(...entries)=>{
    if(disposed)return()=>{};
    const added=[];for(const candidate of entries)if(candidate&&typeof candidate==='object'&&![...registry.values()].includes(candidate)){const id=String(++sequence);registry.set(id,candidate);added.push(id);}
    if(added.length)emit();
    return()=>{for(const id of added){if(registry.get(id)===wallet)clear();registry.delete(id);}emit();};
  };
  const api=Object.freeze({register});
  const registered=event=>{try{if(typeof event.detail==='function')event.detail(api);}catch{/* One incompatible extension must not break discovery. */}};
  try{env?.addEventListener?.('wallet-standard:register-wallet',registered);}catch{/* no event target */}
  try{if(env&&typeof env.Event==='function'){const ready=new env.Event('wallet-standard:app-ready');Object.defineProperty(ready,'detail',{value:api});env.dispatchEvent(ready);}}catch{/* discovery continues through register events */}
  // Extensions may inject after this module runs. Re-check once, then let UIs
  // switch from "looking for wallets" to install or open-in-app guidance.
  const timer=globalThis.setTimeout?.(()=>{if(disposed)return;settled=true;const added=scanInjected();let empty=true;try{empty=!visible().length;}catch{/* treat as empty */}if(added||empty)emit();},DISCOVERY_GRACE_MS);
  timer?.unref?.();

  const changed=candidate=>properties=>{
    try{
      if(wallet!==candidate||disposed)return;
      if(!compatible(candidate)){clear();return;}
      if(properties&&typeof properties==='object'&&'accounts' in properties){
        const rows=list(properties.accounts).filter(validAccount);
        if(!rows.length){
          // Some wallets briefly publish no accounts while an approval is open.
          // Decide once the request settles instead of cancelling it.
          if(inflight){pendingEmpty=true;return;}
          account=null;
        }else{
          pendingEmpty=false;const next=pickAccount(rows,identity);
          // Only a different account invalidates requests already in the wallet.
          if(next.address!==identity){generation++;identity=next.address;}
          account=next;
        }
      }
      emit();
    }catch{/* malformed wallet event */}
  };
  // The wallet's own account object is passed back on every request because
  // some wallets compare it by identity.
  const liveAccount=()=>accountsOf(wallet).find(row=>row.address===account?.address)||account;
  async function request(signer,run,action){
    inflight++;
    try{return await run();}
    catch(error){throw walletFailure(error,action);}
    finally{
      inflight--;
      if(!inflight&&pendingEmpty&&wallet===signer){pendingEmpty=false;account=accountsOf(signer).find(row=>row.address===identity)||null;emit();}
    }
  }
  const changedWhileSigning=(current,signer,address)=>current!==generation||wallet!==signer||!!account&&account.address!==address;
  return{
    state,
    onChange(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    async connect(id){
      scanInjected();
      const candidate=registry.get(String(id));
      if(!candidate)throw Error('That wallet is no longer available. Refresh the page and choose your wallet again.');
      if(!compatible(candidate))throw Error('Choose a wallet that supports Solana mainnet and versioned transaction signing.');
      clear();const current=generation,stale=()=>current!==generation||disposed;
      let result;
      try{result=await candidate.features['standard:connect'].connect();}
      catch(error){if(stale())throw Error('Wallet connection changed. Connect again.');throw walletFailure(error,'connect');}
      if(stale())throw Error('Wallet connection changed. Connect again.');
      // Already-approved wallets may resolve with an empty list (silent connect)
      // or publish the approved account just after connect resolves.
      let next=pickAccount(result?.accounts)||pickAccount(accountsOf(candidate));
      for(let step=0;!next&&step<ACCOUNT_WAIT_STEPS;step++){await new Promise(resolve=>setTimeout(resolve,ACCOUNT_WAIT_MS));if(stale())throw Error('Wallet connection changed. Connect again.');next=pickAccount(accountsOf(candidate));}
      if(!next)throw Error(walletName(candidate)+' did not share a Solana account. Unlock the wallet, select an account, then connect again.');
      wallet=candidate;account=next;identity=next.address;pendingEmpty=false;
      try{const events=candidate.features['standard:events'];const remove=typeof events?.on==='function'?events.on('change',changed(candidate)):null;off=typeof remove==='function'?remove:null;}catch{off=null;}
      emit();return state();
    },
    async disconnect(){const previous=wallet;clear();try{await previous?.features?.['standard:disconnect']?.disconnect?.();}catch{/* local connection is already cleared */}},
    async signMessage(message){
      if(!wallet||!account)throw Error('Connect a wallet first.');
      if(typeof message!=='string'||!message)throw Error('The sign-in message is unavailable. Try again.');
      let feature;try{feature=wallet.features?.[MESSAGE];}catch{feature=null;}
      if(typeof feature?.signMessage!=='function')throw Error('This wallet does not support sign-in messages. Use a wallet with message signing.');
      const bytes=new TextEncoder().encode(message),signer=wallet,current=generation,address=account.address,signing=liveAccount();
      const output=await request(signer,()=>feature.signMessage({account:signing,message:bytes}),'message');
      if(changedWhileSigning(current,signer,address))throw Error('Wallet changed while signing. Connect again.');
      const row=walletBytes(output)?.length===64?{signature:output}:outputsOf(output)[0];
      const signature=signatureBytes(row?.signature);
      if(signature?.length!==64)throw Error('Invalid wallet sign-in signature.');
      if(row.signedMessage!=null){
        const signed=typeof row.signedMessage==='string'?new TextEncoder().encode(row.signedMessage):walletBytes(row.signedMessage);
        const publicKey=walletBytes(signing?.publicKey)?.length===32?walletBytes(signing.publicKey):fromBase58(address);
        // Launchpad verifies the exact challenge text. A prefixed or rewritten message
        // (common with hardware-wallet accounts) cannot sign in.
        if(!signed||!sameBytes(signed,bytes)){if(!await verifiesOriginal(publicKey,signature,bytes))throw Object.assign(Error('Your wallet signed a modified version of the sign-in message, so Launchpad cannot verify it. This happens with some hardware-wallet accounts. Use a regular wallet account to sign in, or update your wallet.'),{code:'WALLET_MESSAGE_MODIFIED'});}
      }
      return toBase64(signature);
    },
    async sign(pending){
      if(!wallet||!account)throw Error('Connect the developer wallet to sign this transaction.');
      if(account.address!==pending.wallet)throw Error('Connect the same developer wallet used for this launch: '+pending.wallet);
      if(!compatible(wallet)||!validAccount(account))throw Error('This wallet no longer supports Solana mainnet transaction signing.');
      if(typeof pending.transaction!=='string'||pending.transaction.length>24000||!pending.transaction.length||!/^[A-Za-z0-9+/]+={0,2}$/.test(pending.transaction))throw Error('The prepared transaction is invalid. Refresh the launch and try again.');
      const transaction=Uint8Array.from(atob(pending.transaction),x=>x.charCodeAt(0)),current=generation,signer=wallet,address=account.address;
      const input={account:liveAccount(),chain:mainnetChain(signer)||CHAIN,transaction};
      const output=await request(signer,()=>signer.features[SIGN].signTransaction(input),'transaction');
      if(changedWhileSigning(current,signer,address))throw Error('Wallet changed while signing. Reconnect the developer wallet and try again.');
      const rows=outputsOf(output),signed=rows.length===1?signedTransactionBytes(rows[0]):null;
      if(!signed||!signed.length||signed.length>16000)throw Error('The wallet did not return a signed transaction. Try again.');
      return toBase64(signed);
    },
    async signBatch(pending){
      if(!wallet||!account)throw Error('Connect the test wallet before signing.');
      if(!Array.isArray(pending)||pending.length<1||pending.length>25)throw Error('A test deployment batch must contain 1–25 transactions.');
      if(!compatible(wallet)||!validAccount(account))throw Error('This wallet no longer supports Solana mainnet transaction signing.');
      if(pending.length>1&&wallet.features[SIGN].supportsBatchSigning===false)throw Error('This wallet does not support signing a batch.');
      const current=generation,signer=wallet,address=account.address,signing=liveAccount(),chain=mainnetChain(signer)||CHAIN;
      const inputs=pending.map(item=>{
        if(item?.wallet!==address)throw Error('Connect the configured test wallet: '+String(item?.wallet||''));
        if(typeof item.transaction!=='string'||!item.transaction.length||item.transaction.length>24000||!/^[A-Za-z0-9+/]+={0,2}$/.test(item.transaction))throw Error('The prepared deployment batch is invalid.');
        const transaction=Uint8Array.from(atob(item.transaction),x=>x.charCodeAt(0));
        if(transaction.length>1232)throw Error('A prepared deployment transaction exceeds the wallet packet limit.');
        return{account:signing,chain,transaction};
      });
      const output=await request(signer,()=>signer.features[SIGN].signTransaction(...inputs),'transaction');
      if(changedWhileSigning(current,signer,address))throw Error('Wallet changed while signing. Reconnect the configured test wallet.');
      const rows=outputsOf(output);
      if(rows.length!==inputs.length)throw Error('The wallet did not return the complete signed batch. Nothing was submitted by Launchpad.');
      return rows.map(item=>{
        const signed=signedTransactionBytes(item);
        if(!signed||!signed.length||signed.length>1232)throw Error('The wallet returned an invalid signed deployment transaction.');
        return toBase64(signed);
      });
    },
    dispose(){disposed=true;globalThis.clearTimeout?.(timer);clear();listeners.clear();registry.clear();try{env?.removeEventListener?.('wallet-standard:register-wallet',registered);}catch{/* detached */}}
  };
}


const sharedWallets=new WeakMap();
export function getLaunchpadWallet({window:env=globalThis.window}={}){
  if(!env)return createLaunchpadWallet({window:env});
  let wallet=sharedWallets.get(env);
  if(!wallet){wallet=createLaunchpadWallet({window:env});const dispose=wallet.dispose;wallet.dispose=()=>{sharedWallets.delete(env);dispose();};sharedWallets.set(env,wallet);}
  return wallet;
}
