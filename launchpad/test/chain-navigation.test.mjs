import test from 'node:test';
import assert from 'node:assert/strict';
import { chainToolHref } from '../public/chains.mjs';
import { parseHTML } from 'linkedom';
test('chain switches preserve every shared trading tool in both directions',()=>{
  for(const tool of ['copy','sniper','liquidity','market']){
    assert.equal(chainToolHref('solana',tool),`/trade?tool=${tool}`);
    assert.equal(chainToolHref('robinhood',tool),`/robinhood?tool=${tool}`);
  }
  assert.equal(chainToolHref('solana','terminal'),'/trade');
  assert.equal(chainToolHref('robinhood','terminal'),'/robinhood');
  assert.equal(chainToolHref('robinhood','funding'),'/funding?chain=robinhood');
  assert.throws(()=>chainToolHref('unexpected','liquidity'));
});

test('workspace chain links follow the current selected tab, including an immediate switch before the animation frame',async()=>{
  const {document,window}=parseHTML('<html><body><header class="app-header"><a class="brand">Launchpad</a><nav class="chain-switch"><a href="/">Solana</a><a href="/robinhood">Robinhood</a></nav></header><main><div class="workspace"></div></main><nav id="tools"><button data-tab="copy" aria-pressed="true">Copy</button><button data-tab="liquidity">Liquidity</button></nav></body></html>');
  const original={document:globalThis.document,location:globalThis.location,requestAnimationFrame:globalThis.requestAnimationFrame};Object.assign(globalThis,{document,location:{href:'http://localhost/'},requestAnimationFrame:fn=>fn()});
  try{const {createWorkspaceShell}=await import('../public/workspace-shell.js');const nav=document.getElementById('tools');createWorkspaceShell({chain:'solana',nav,session:{features:{toolkit:true}}});const links=document.querySelectorAll('.chain-switch a');assert.equal(links[1].getAttribute('href'),'/robinhood?tool=copy');
    nav.querySelector('[data-tab=copy]').setAttribute('aria-pressed','false');nav.querySelector('[data-tab=liquidity]').setAttribute('aria-pressed','true');links[1].dispatchEvent(new window.Event('click'));assert.equal(links[1].getAttribute('href'),'/robinhood?tool=liquidity');
    assert.equal(document.querySelectorAll('[data-workspace-tool=funding]').length,1);assert.equal(document.querySelectorAll('[data-workspace-tool=launchpad]').length,1);
  }finally{for(const [k,v]of Object.entries(original))v===undefined?delete globalThis[k]:globalThis[k]=v;}
});

test('explicit toolkit opt-in preserves its navigation beside Launch without an Explore duplicate',async()=>{
  const {document,window}=parseHTML('<html><body class="relay-terminal"><header class="app-header"><a class="brand">Launchpad</a></header><main></main></body></html>');
  const original={document:globalThis.document,location:globalThis.location,requestAnimationFrame:globalThis.requestAnimationFrame};Object.assign(globalThis,{document,location:{href:'http://localhost/'},requestAnimationFrame:fn=>fn()});
  try{
    const {createWorkspaceShell}=await import('../public/workspace-shell.js');createWorkspaceShell({page:'explore',session:{features:{toolkit:true}}});
    const group=document.querySelector('.relay-toolkit'),nav=group.querySelector('nav');
    assert.equal(document.querySelector('.workspace-primary-nav'),null);assert.equal(document.querySelector('.top-explore'),null);assert.equal(document.querySelector('.app-header .brand').getAttribute('href'),'/');
    assert.equal(group.previousElementSibling.textContent,'Launch on Launchpad');assert.equal(group.previousElementSibling.getAttribute('href'),'/launchpad');assert.equal(group.open,false);
    assert.deepEqual([...nav.children].map(el=>el.textContent),['Markets','Copy trading','Launch sniper','Liquidity manager','Market maker','Funding','Connections','Setup guide']);
    assert.equal(nav.firstChild.getAttribute('href'),'/trade');assert.equal(nav.children[5].getAttribute('href'),'/funding?chain=solana');assert.equal(nav.lastChild.getAttribute('href'),'/tutorial');
    assert.equal(document.querySelector('.workspace-sidebar'),null);assert.equal(document.querySelector('.workspace-breadcrumb'),null);assert.equal(document.querySelector('a[href="/launched-tokens"]'),null);assert.equal(group.querySelector('summary').textContent,'');assert.equal(group.querySelector('summary').getAttribute('aria-label'),'Toolkit');assert.equal(nav.children[6].getAttribute('href'),'/trade?account=connections');
    group.open=true;const key=new window.Event('keydown');key.key='Escape';document.dispatchEvent(key);assert.equal(group.open,false);
  }finally{for(const [k,v]of Object.entries(original))v===undefined?delete globalThis[k]:globalThis[k]=v;}
});

test('administrators get one independent header link while the Toolkit stays hidden',async()=>{
  const original={document:globalThis.document,location:globalThis.location,requestAnimationFrame:globalThis.requestAnimationFrame};
  try{
    const {createWorkspaceShell}=await import('../public/workspace-shell.js');
    for(const role of ['admin','user']){
      const {document}=parseHTML('<html><body><header class="app-header"><a class="brand">Launchpad</a><div class="local"><a id="owner-sessions" hidden>Sessions</a></div></header><main></main></body></html>');
      Object.assign(globalThis,{document,location:{href:'http://localhost/'},requestAnimationFrame:fn=>fn()});
      createWorkspaceShell({page:'explore',session:{account:{role,mfaEnabled:false}}});
      assert.equal(document.querySelectorAll('a[href="/admin"]').length,role==='admin'?1:0);
      if(role==='admin'){assert.equal(document.getElementById('owner-sessions').textContent,'Admin panel');assert.equal(document.getElementById('owner-sessions').hidden,false);}
      assert.equal(document.querySelector('.sidebar-utilities a[href="/sessions"]'),null);
    }
  }finally{for(const [key,value]of Object.entries(original))value===undefined?delete globalThis[key]:globalThis[key]=value;}
});


test('header avatar updates preserve controls and reject remote image URLs', async()=>{
  const {document,window}=parseHTML('<html><body><header class="app-header"><a class="brand">Launchpad</a><div class="local"><button id="account-button">Account</button></div></header><main></main></body></html>');
  const original={document:globalThis.document,location:globalThis.location,requestAnimationFrame:globalThis.requestAnimationFrame};Object.assign(globalThis,{document,location:{href:'http://localhost/'},requestAnimationFrame:fn=>fn()});
  try{
    const {createWorkspaceShell}=await import('../public/workspace-shell.js');let accountClicks=0,connectionsClicks=0;
    const control=document.getElementById('account-button');control.onclick=()=>accountClicks++;
    createWorkspaceShell({session:{features:{toolkit:true},account:{username:'Tester',avatar:'/token-images/'+ 'a'.repeat(64)+'.png'}},openConnections:()=>connectionsClicks++});
    assert.equal(control.querySelector('img').getAttribute('src'),'/token-images/'+ 'a'.repeat(64)+'.png');assert.equal(control.querySelector('.header-account-name').textContent,'Tester');control.click();assert.equal(accountClicks,0);assert.equal(control.getAttribute('aria-expanded'),'true');document.querySelector('[data-account-edit]').click();assert.equal(accountClicks,1);assert.equal(control.getAttribute('aria-expanded'),'false');
    const toolkit=document.querySelector('.relay-toolkit');toolkit.open=true;const focus=new window.Event('focusout',{bubbles:true});focus.relatedTarget=document.querySelector('[data-account-connection]');toolkit.querySelector('summary').dispatchEvent(focus);assert.equal(toolkit.open,true,'focus moving into the dropdown must not close it before click');document.querySelector('[data-account-connection]').click();assert.equal(connectionsClicks,1);assert.equal(toolkit.open,false);
    createWorkspaceShell({session:{features:{toolkit:true},account:{username:'Changed',avatar:'https://external.example/avatar.png'}}});
    assert.equal(document.querySelectorAll('.relay-toolkit').length,1);assert.equal(control.querySelector('img'),null);assert.equal(control.querySelector('.header-account-avatar').textContent,'C');assert.equal(control.querySelector('.header-account-name').textContent,'Changed');
    toolkit.open=true;document.querySelector('main').dispatchEvent(new window.Event('click',{bubbles:true}));assert.equal(toolkit.open,false);
  }finally{for(const [k,v]of Object.entries(original))v===undefined?delete globalThis[k]:globalThis[k]=v;}
});

test('page changes and identical session refreshes preserve the loaded profile menu nodes',async()=>{
  const {document,window}=parseHTML('<html><body class="relay-terminal"><header class="app-header"><a class="brand">Launchpad</a></header><main></main></body></html>');
  const original={document:globalThis.document,location:globalThis.location,requestAnimationFrame:globalThis.requestAnimationFrame};
  Object.assign(globalThis,{document,location:{href:'http://localhost/'},requestAnimationFrame:fn=>fn()});
  try{
    const {createWorkspaceShell}=await import('../public/workspace-shell.js');
    const session={authenticated:true,account:{id:'owner',username:'Owner',role:'admin',avatar:'/token-images/'+'a'.repeat(64)+'.png'},features:{toolkit:false}};
    createWorkspaceShell({page:'explore',session});
    const selectors=['.app-header','.header-profile-menu','[data-account-link]','.header-account-avatar','.header-account-avatar img','.header-account-name','.header-account-chevron','#header-profile-dropdown','.header-admin'];
    const nodes=selectors.map(selector=>document.querySelector(selector));assert(nodes.every(Boolean));
    for(const page of ['analytics','launchpad','launched-tokens','coin','explore']){
      document.dispatchEvent(new window.Event('curve-navigation-start'));
      createWorkspaceShell({page});
      for(let i=0;i<selectors.length;i++)assert.equal(document.querySelector(selectors[i]),nodes[i],page+' initial '+selectors[i]);
      await Promise.resolve();createWorkspaceShell({page,session:structuredClone(session)});
      for(let i=0;i<selectors.length;i++)assert.equal(document.querySelector(selectors[i]),nodes[i],page+' session '+selectors[i]);
    }
    // A failed image stays on its existing fallback through normal refreshes.
    nodes[4].onerror();const fallback=nodes[3].firstChild;
    createWorkspaceShell({page:'analytics',session:structuredClone(session)});
    assert.equal(nodes[3].firstChild,fallback);assert.equal(nodes[3].querySelector('img'),null);
    createWorkspaceShell({page:'analytics',session:{...session,account:{...session.account,username:'New name',avatar:'/token-images/'+'b'.repeat(64)+'.webp'}}});
    assert.equal(document.querySelector('[data-account-link]'),nodes[2]);assert.equal(document.querySelector('.header-account-name').textContent,'New name');
    assert.equal(document.querySelector('.header-account-avatar img').getAttribute('src'),'/token-images/'+'b'.repeat(64)+'.webp');
    document.dispatchEvent(new window.Event('curve-navigation-start'));
    createWorkspaceShell({page:'explore',session:{authenticated:false,account:null,features:{toolkit:false}}});
    assert.equal(document.querySelector('.header-profile-menu'),null);assert.equal(nodes[2].textContent,'Connect wallet');assert.equal(document.querySelector('.header-admin'),null);
  }finally{for(const [key,value]of Object.entries(original))value===undefined?delete globalThis[key]:globalThis[key]=value;}
});

test('launchpad navigation defaults off before session loading and only a true host flag restores tools',async()=>{
  const {document}=parseHTML('<html><body class="relay-terminal"><header class="app-header"><a class="brand">Launchpad</a></header><main></main></body></html>');
  const original={document:globalThis.document,location:globalThis.location,requestAnimationFrame:globalThis.requestAnimationFrame};Object.assign(globalThis,{document,location:{href:'http://localhost/'},requestAnimationFrame:fn=>fn()});
  try{
    const {createWorkspaceShell}=await import('../public/workspace-shell.js');createWorkspaceShell({page:'explore'});
    const group=document.querySelector('.relay-toolkit');assert.equal(group.hidden,true);assert.equal(document.body.dataset.toolkit,'false');assert.equal(document.querySelector('.brand').getAttribute('href'),'/');assert.equal(document.querySelector('.top-launch').getAttribute('href'),'/launchpad');assert.equal(document.querySelector('[data-account-link]').getAttribute('href'),'/?signin=1');
    for(const features of [{},{toolkit:false},{toolkit:'true'}]){createWorkspaceShell({session:{authenticated:false,features}});assert.equal(group.hidden,true);}
    createWorkspaceShell({session:{authenticated:false,features:{toolkit:true}}});assert.equal(group.hidden,false);assert.equal(document.body.dataset.toolkit,'true');
    group.open=true;createWorkspaceShell({session:{authenticated:true,account:{username:'creator',role:'user'},features:{toolkit:false}}});assert.equal(group.hidden,true);assert.equal(group.open,false);assert.equal(document.querySelectorAll('.relay-toolkit').length,1);assert.equal(document.querySelector('[data-account-link]').getAttribute('href'),'/?account=overview');
  }finally{for(const [k,v]of Object.entries(original))v===undefined?delete globalThis[k]:globalThis[k]=v;}
});

test('every shared page has one public information footer including signed-out launch and profile pages',async()=>{
  const original={document:globalThis.document,location:globalThis.location,requestAnimationFrame:globalThis.requestAnimationFrame};
  try{
    const {createWorkspaceShell}=await import('../public/workspace-shell.js');
    for(const page of ['explore','coin','launchpad','creator','profile','docs','terms','privacy','analytics']){
      const {document}=parseHTML('<html><body class="relay-terminal" data-session="guest"><header class="app-header"><a class="brand">Launchpad</a></header><main></main><footer>Legacy footer</footer></body></html>');Object.assign(globalThis,{document,location:{href:'http://localhost/'},requestAnimationFrame:fn=>fn()});
      createWorkspaceShell({page});createWorkspaceShell({page,session:{authenticated:false,features:{toolkit:false}}});
      const footer=document.querySelector('.site-footer');assert.equal(document.querySelectorAll('footer').length,1);assert.equal(footer.hidden,false);assert.deepEqual([...footer.querySelectorAll('.site-footer-links a')].map(link=>[link.textContent,link.getAttribute('href')]),[['Analytics','/analytics'],['Docs','/docs'],['Terms of Service','/terms'],['Privacy Policy','/privacy']]);
      assert.equal(footer.querySelector('.site-footer-social'),null,'no X link unless the host sets one');
    }
    // A host with an X profile (LAUNCHPAD_X_URL → <body data-brand-x>) links it from the footer.
    for(const page of ['explore','docs']){
      const {document}=parseHTML('<html><body class="relay-terminal" data-session="guest" data-brand-x="https://x.com/example"><header class="app-header"><a class="brand">Launchpad</a></header><main></main></body></html>');Object.assign(globalThis,{document,location:{href:'http://localhost/'},requestAnimationFrame:fn=>fn()});
      createWorkspaceShell({page});const footer=document.querySelector('.site-footer');
      const x=footer.querySelector('.site-footer-social');assert.equal(x.getAttribute('href'),'https://x.com/example');assert.equal(x.getAttribute('target'),'_blank');assert.match(x.getAttribute('rel'),/noopener/);assert.match(x.getAttribute('aria-label'),/Launchpad on X/);assert.doesNotMatch(footer.textContent,/Toolkit|Telegram|Connections|cashback/);
    }
  }finally{for(const [k,v]of Object.entries(original))v===undefined?delete globalThis[k]:globalThis[k]=v;}
});

test('a sign-in bookmark waits for session state and opens the inline dialog once without navigation',async()=>{
  const {document,window}=parseHTML('<html><body><header class="app-header"><a class="brand">Launchpad</a></header><main><input value="Untouched draft"></main></body></html>');
  const original={document:globalThis.document,location:globalThis.location,requestAnimationFrame:globalThis.requestAnimationFrame};Object.assign(globalThis,{document,location:{href:'http://localhost/?signin=1'},requestAnimationFrame:fn=>fn()});
  window.HTMLElement.prototype.showModal=function(){this.open=true;};window.HTMLElement.prototype.close=function(){this.open=false;};
  try{
    const {createWorkspaceShell}=await import('../public/workspace-shell.js');createWorkspaceShell({page:'explore'});assert.equal(document.getElementById('signin-dialog'),null);
    createWorkspaceShell({page:'explore',session:{authenticated:false,features:{toolkit:false}}});for(let i=0;i<10;i++)await new Promise(setImmediate);
    const dialog=document.getElementById('signin-dialog');assert.equal(dialog?.open,true);assert.equal(globalThis.location.href,'http://localhost/?signin=1');assert.equal(document.querySelector('main input').value,'Untouched draft');assert.equal(document.querySelector('[data-account-link]').getAttribute('aria-label'),'Connect wallet');assert.doesNotMatch(dialog.textContent,/cashback/i);
    dialog.close();createWorkspaceShell({page:'explore',session:{authenticated:false,features:{toolkit:false}}});assert.equal(dialog.open,false);assert.equal(document.querySelectorAll('#signin-dialog').length,1);
  }finally{for(const [k,v]of Object.entries(original))v===undefined?delete globalThis[k]:globalThis[k]=v;}
});

test('profile dropdown has Edit profile, My Tokens and Sign out on public and admin pages and opens existing account controls only on Edit',async()=>{
  const original={document:globalThis.document,location:globalThis.location,requestAnimationFrame:globalThis.requestAnimationFrame,fetch:globalThis.fetch};
  try{
    const {createWorkspaceShell}=await import('../public/workspace-shell.js');
    for(const page of ['explore','coin','launchpad','launched-tokens','analytics','admin']){
      const {document,window}=parseHTML('<html><body class="relay-terminal"><header class="app-header"><a class="brand">Launchpad</a></header><main><input value="Draft stays here"></main></body></html>');
      document.body.dataset.page=page;window.HTMLElement.prototype.showModal=function(){this.open=true;};window.HTMLElement.prototype.close=function(){this.open=false;this.dispatchEvent(new window.Event('close'));};
      const account={id:'a'.repeat(32),username:'owner',role:'admin',authType:'password',mfaEnabled:true,mainWallet:'1'.repeat(32)},session={authenticated:true,account,token:'private-csrf',features:{toolkit:false}};const calls=[];
      Object.assign(globalThis,{document,location:{href:'http://localhost/'+page},requestAnimationFrame:fn=>fn(),fetch:async path=>{calls.push(path);return{ok:true,json:async()=>path==='/api/session'?session:path==='/api/account'?{account}: {}};}});
      createWorkspaceShell({page,session});const control=document.querySelector('[data-account-link]'),panel=document.getElementById('header-profile-dropdown');
      assert.deepEqual([...panel.querySelectorAll('[role=menuitem]')].map(node=>node.textContent),['Edit profile','My Tokens','Sign out']);assert.equal(panel.querySelector('[data-account-tokens]').getAttribute('href'),'/launched-tokens');
      assert.equal(document.querySelector('.header-admin').parentElement.className,'local');
      control.click();assert.equal(control.getAttribute('aria-expanded'),'true');assert.equal(panel.hidden,false);assert.equal(document.getElementById('public-account-dialog'),null);assert(!calls.includes('/api/account'));
      document.querySelector('[data-account-edit]').click();for(let i=0;i<20;i++)await new Promise(setImmediate);
      const dialog=document.getElementById('public-account-dialog');assert.equal(dialog?.open,true,page);assert.equal(dialog.querySelector('h2').textContent,'Edit profile');
      assert.equal(dialog.querySelector('[data-logout]'),null);assert.match(dialog.textContent,/Public profile/);assert.match(dialog.textContent,/Security/);assert.match(dialog.textContent,/Sign-in wallet/);assert.equal(dialog.querySelector('[data-admin]').hidden,false);
      assert.equal(panel.hidden,true);assert.equal(document.querySelector('main input').value,'Draft stays here');assert.equal(globalThis.location.href,'http://localhost/'+page);
      dialog.close();
    }
  }finally{for(const [key,value]of Object.entries(original))value===undefined?delete globalThis[key]:globalThis[key]=value;}
});

test('profile dropdown keyboard, outside click, focus exit, account updates and signout stay synchronized',async()=>{
  const {document,window}=parseHTML('<html><body class="relay-terminal"><header class="app-header"><a class="brand">Launchpad</a></header><main><button>Outside</button></main></body></html>');
  const original={document:globalThis.document,location:globalThis.location,requestAnimationFrame:globalThis.requestAnimationFrame};Object.assign(globalThis,{document,location:{href:'http://localhost/'},requestAnimationFrame:fn=>fn()});
  try{
    const {createWorkspaceShell}=await import('../public/workspace-shell.js');const session={authenticated:true,account:{id:'owner',username:'Original',role:'user'},features:{toolkit:false}};
    createWorkspaceShell({page:'explore',session});const control=document.querySelector('[data-account-link]'),panel=document.getElementById('header-profile-dropdown'),[edit,tokens,logout]=panel.children;let focused=null;
    Object.defineProperty(document,'activeElement',{configurable:true,get:()=>focused});for(const node of [control,edit,tokens,logout])node.focus=()=>{focused=node;};
    const key=(node,value)=>{const event=new window.Event('keydown',{bubbles:true,cancelable:true});event.key=value;node.dispatchEvent(event);return event;};
    key(control,'ArrowDown');assert.equal(focused,edit);assert.equal(panel.hidden,false);key(edit,'ArrowDown');assert.equal(focused,tokens);key(tokens,'Home');assert.equal(focused,edit);key(edit,'End');assert.equal(focused,logout);key(logout,'ArrowDown');assert.equal(focused,edit);key(edit,'ArrowUp');assert.equal(focused,logout);key(logout,'Escape');assert.equal(panel.hidden,true);assert.equal(focused,control);
    control.click();document.querySelector('main').dispatchEvent(new window.Event('click',{bubbles:true}));assert.equal(panel.hidden,true);
    key(control,'ArrowUp');assert.equal(focused,logout);const out=new window.Event('focusout',{bubbles:true});out.relatedTarget=document.querySelector('main button');tokens.dispatchEvent(out);assert.equal(panel.hidden,true);
    control.click();document.dispatchEvent(new window.CustomEvent('curve-account-updated',{detail:{account:{...session.account,username:'<img src=x>'},token:'new-token'}}));assert.equal(panel.hidden,true);assert.equal(control.querySelector('.header-account-name').textContent,'<img src=x>');assert.equal(control.querySelector('img'),null);assert.equal(document.querySelectorAll('.header-profile-menu').length,1);
    control.click();document.dispatchEvent(new window.CustomEvent('curve-account-updated',{detail:{authenticated:false}}));assert.equal(document.getElementById('header-profile-dropdown'),null);assert.equal(control.getAttribute('aria-haspopup'),null);assert.equal(control.textContent,'Connect wallet');assert.equal(control.getAttribute('href'),'/?signin=1');
    document.dispatchEvent(new window.CustomEvent('curve-account-updated',{detail:session}));assert.equal(document.querySelectorAll('.header-profile-menu').length,1);control.click();assert.equal(control.getAttribute('aria-expanded'),'true');document.dispatchEvent(new window.Event('curve-navigation-start'));assert.equal(control.getAttribute('aria-expanded'),'false');
    document.dispatchEvent(new window.CustomEvent('curve-account-updated',{detail:{account:null}}));assert.equal(document.querySelector('.header-profile-menu'),null);
  }finally{for(const [key,value]of Object.entries(original))value===undefined?delete globalThis[key]:globalThis[key]=value;}
});

test('header Sign out revokes wallet and password sessions with current CSRF once, clears account UI and reloads',async()=>{
  const original={document:globalThis.document,location:globalThis.location,requestAnimationFrame:globalThis.requestAnimationFrame,fetch:globalThis.fetch};
  const flush=async()=>{for(let i=0;i<5;i++)await new Promise(setImmediate);};
  try{
    const {createWorkspaceShell}=await import('../public/workspace-shell.js');
    for(const authType of ['wallet','password']){
      const {document,window}=parseHTML('<html><body><header class="app-header"><a class="brand">Launchpad</a></header><main></main></body></html>');
      const session={authenticated:true,account:{id:'owner',username:'Owner',role:'admin',authType},token:'old-csrf',features:{toolkit:false}},calls=[],updates=[];
      let reads=0,reloads=0,finishSession;
      Object.assign(globalThis,{document,location:{href:'http://localhost/launchpad',reload:()=>reloads++},requestAnimationFrame:fn=>fn(),fetch:async(path,options)=>{
        if(path.startsWith('/api/explore/'))return{ok:false,json:async()=>({})};
        calls.push({path,options});
        if(path==='/api/session'){reads++;await new Promise(resolve=>{finishSession=resolve;});return{ok:true,json:async()=>({...session,token:'current-csrf'})};}
        assert.equal(path,'/api/account/logout');return{ok:true,json:async()=>({ok:true})};
      }});
      document.addEventListener('curve-account-updated',event=>updates.push(event.detail));
      createWorkspaceShell({page:'launchpad',session});document.querySelector('[data-account-link]').click();
      const button=document.querySelector('[data-account-logout]');assert.equal(button.type,'button');assert.equal(button.getAttribute('role'),'menuitem');assert.equal(button.previousElementSibling.textContent,'My Tokens');
      button.click();button.click();await flush();assert.equal(reads,1);assert.equal(button.disabled,true);assert.equal(button.textContent,'Signing out…');assert.equal(reloads,0);
      finishSession();await flush();
      assert.deepEqual(calls.map(row=>row.path),['/api/session','/api/account/logout']);
      assert.deepEqual(calls[1].options,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-control-token':'current-csrf'},body:'{}'});
      assert.equal(calls[0].options.credentials,'same-origin');assert.equal(calls[0].options.cache,'no-store');
      assert.deepEqual(updates.at(-1),{authenticated:false,account:null,token:''});assert.equal(reloads,1);
      assert.equal(document.querySelector('.header-profile-menu'),null);assert.equal(document.querySelector('.header-admin'),null);assert.equal(document.querySelector('[data-account-link]').textContent,'Connect wallet');
      assert.equal(document.getElementById('public-account-dialog'),null);
    }
  }finally{for(const [key,value]of Object.entries(original))value===undefined?delete globalThis[key]:globalThis[key]=value;}
});

test('failed header Sign out leaves the session intact, displays the error and supports retry',async()=>{
  const {document}=parseHTML('<html><body><header class="app-header"><a class="brand">Launchpad</a></header><main></main></body></html>');
  const original={document:globalThis.document,location:globalThis.location,requestAnimationFrame:globalThis.requestAnimationFrame,fetch:globalThis.fetch};
  const session={authenticated:true,account:{id:'owner',username:'Owner'},token:'old-csrf'},calls=[];let fail=true,reloads=0;
  Object.assign(globalThis,{document,location:{href:'http://localhost/',reload:()=>reloads++},requestAnimationFrame:fn=>fn(),fetch:async(path,options)=>{
    calls.push({path,options});return path==='/api/session'?{ok:true,json:async()=>({...session,token:'fresh'})}:fail?{ok:false,status:403,json:async()=>({error:'Session verification failed. Please try again.'})}:{ok:true};
  }});
  try{
    const {createWorkspaceShell}=await import('../public/workspace-shell.js');createWorkspaceShell({session});document.querySelector('[data-account-link]').click();
    const button=document.querySelector('[data-account-logout]');await button.onclick({preventDefault(){}});
    assert.equal(reloads,0);assert.equal(button.disabled,false);assert.equal(button.textContent,'Sign out');assert.equal(document.querySelector('.header-account-name').textContent,'Owner');
    assert.equal(document.querySelector('.header-profile-dropdown').hidden,false);assert.equal(document.querySelector('.header-profile-message').hidden,false);assert.match(document.querySelector('.header-profile-message').textContent,/Session verification failed/);
    fail=false;await button.onclick({preventDefault(){}});assert.equal(reloads,1);assert.equal(calls.filter(row=>row.path==='/api/account/logout').length,2);
  }finally{for(const [key,value]of Object.entries(original))value===undefined?delete globalThis[key]:globalThis[key]=value;}
});

test('header Sign out never revokes another account after a session change, and treats an expired session as signed out',async()=>{
  const original={document:globalThis.document,location:globalThis.location,requestAnimationFrame:globalThis.requestAnimationFrame,fetch:globalThis.fetch};
  try{
    const {createWorkspaceShell}=await import('../public/workspace-shell.js');
    for(const fresh of [{authenticated:true,account:{id:'other'},token:'other-csrf'},{authenticated:false}]){
      const {document}=parseHTML('<html><body><header class="app-header"><a class="brand">Launchpad</a></header><main></main></body></html>');let reloads=0;const calls=[];
      Object.assign(globalThis,{document,location:{href:'http://localhost/',reload:()=>reloads++},requestAnimationFrame:fn=>fn(),fetch:async path=>{if(path.startsWith('/api/explore/'))return{ok:false,json:async()=>({})};calls.push(path);return{ok:true,json:async()=>fresh};}});
      createWorkspaceShell({session:{authenticated:true,account:{id:'owner',username:'Owner'},token:'old'}});
      await document.querySelector('[data-account-logout]').onclick({preventDefault(){}});
      assert.deepEqual(calls,['/api/session']);assert.equal(reloads,fresh.authenticated?0:1);
      if(fresh.authenticated)assert.match(document.querySelector('.header-profile-message').textContent,/account changed/);
      else assert.equal(document.querySelector('[data-account-link]').textContent,'Connect wallet');
    }
  }finally{for(const [key,value]of Object.entries(original))value===undefined?delete globalThis[key]:globalThis[key]=value;}
});

test('Skip to workspace focuses the page content without changing the URL hash a page routes by',async()=>{
  const {document,window}=parseHTML('<html><body data-page="admin"><header class="app-header"><a class="brand">Launchpad</a></header><main id="admin-workspace"><h1>Admin</h1></main></body></html>');
  const original={document:globalThis.document,location:globalThis.location,requestAnimationFrame:globalThis.requestAnimationFrame};Object.assign(globalThis,{document,location:{href:'http://localhost/admin#tokens/gotchi'},requestAnimationFrame:fn=>fn()});
  try{
    const {createWorkspaceShell}=await import('../public/workspace-shell.js');createWorkspaceShell({page:'admin',session:{authenticated:true,account:{username:'operator',role:'admin'}}});
    const skip=document.querySelector('.skip-link'),main=document.querySelector('main');let focused=null;main.focus=function(){focused=this;};
    assert.equal(skip.getAttribute('href'),'#admin-workspace');assert.equal(main.tabIndex,-1);
    const click=new window.Event('click',{bubbles:true,cancelable:true});skip.dispatchEvent(click);
    assert.equal(click.defaultPrevented,true,'#tokens/gotchi stays in the address bar');assert.equal(focused,main);
    const modified=new window.Event('click',{bubbles:true,cancelable:true});Object.defineProperty(modified,'ctrlKey',{value:true});skip.dispatchEvent(modified);assert.equal(modified.defaultPrevented,false,'a modified click keeps the browser behaviour');
  }finally{for(const [k,v]of Object.entries(original))v===undefined?delete globalThis[k]:globalThis[k]=v;}
});

test('the header follows published account changes: a rename replaces the session saved at sign-in, and expiry signs it out',async()=>{
  const {document,window}=parseHTML('<html><body data-page="explore"><header class="app-header"><a class="brand">Launchpad</a><div class="local"><a data-account-link class="small-button" href="/?signin=1">Connect wallet</a></div></header><main></main></body></html>');
  const original={document:globalThis.document,location:globalThis.location,requestAnimationFrame:globalThis.requestAnimationFrame};Object.assign(globalThis,{document,location:{href:'http://localhost/'},requestAnimationFrame:fn=>fn()});
  try{
    const {createWorkspaceShell}=await import('../public/workspace-shell.js');createWorkspaceShell({page:'explore',session:{authenticated:false,account:null}});
    const link=document.querySelector('[data-account-link]'),publish=detail=>document.dispatchEvent(new window.CustomEvent('curve-account-updated',{detail}));
    const signedIn={authenticated:true,token:'csrf-one',features:{},account:{id:'account-one',username:'mira_builds',role:'user',authType:'wallet'}};
    publish(signedIn);assert.match(link.textContent,/mira_builds/);assert(link.closest('.header-profile-menu'));
    createWorkspaceShell({page:'explore',session:{authenticated:false,account:null}});assert.match(link.textContent,/mira_builds/,'a slower page session read does not undo the sign-in');
    const avatar='/token-images/'+'c'.repeat(64)+'.png';publish({...signedIn,account:{...signedIn.account,username:'mira_renamed',avatar}});
    assert.match(link.textContent,/mira_renamed/);assert.doesNotMatch(link.textContent,/mira_builds/);assert.equal(link.querySelector('img').getAttribute('src'),avatar);assert.equal(link.getAttribute('aria-label'),'Profile menu for mira_renamed');
    publish({authenticated:false,account:null,token:''});
    assert.equal(link.textContent,'Connect wallet');assert.equal(link.getAttribute('href'),'/?signin=1');assert.equal(link.closest('.header-profile-menu'),null);
    publish({account:{...signedIn.account,username:'mira_again'},token:'csrf-two'});assert.match(link.textContent,/mira_again/,'an account-only update after sign-out is a sign-in');
  }finally{for(const [k,v]of Object.entries(original))v===undefined?delete globalThis[k]:globalThis[k]=v;}
});
