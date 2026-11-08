import { createWorkspaceShell } from './workspace-shell.js';
import { bootPage } from './navigation.mjs';
export function mountPage({document=globalThis.document,window=document.defaultView}={}){
  const page=document.body.dataset.page;
  let sessionUpdated=false,disposed=false;const controller=new AbortController();
  const onAccountUpdate=()=>{sessionUpdated=true;};
  document.addEventListener('curve-account-updated',onAccountUpdate);
  createWorkspaceShell({page});
  fetch('/api/session',{credentials:'same-origin',cache:'no-store',signal:controller.signal})
    .then(response=>response.ok?response.json():{authenticated:false})
    .then(session=>{if(!disposed&&!sessionUpdated)createWorkspaceShell({page,session});}).catch(()=>{});
  const reading=readingAids({document,window,signal:controller.signal});
  return {destroy(){disposed=true;controller.abort();reading.destroy();document.removeEventListener('curve-account-updated',onAccountUpdate);}};
}

// Reading aids, presentation only: the "On this page" list highlights the
// section being read, and in-page links scroll smoothly (native jumps when the
// reader prefers reduced motion or the browser lacks the APIs).
//
// Sections use content-visibility:auto, so parts of the article far from the
// viewport are laid out lazily with an estimated height. Whenever the browser
// is about to scroll to a position computed from the layout (a #hash on load,
// an in-page link, or the router re-mounting this page and restoring its
// scroll), every section is laid out for a moment first so the jump lands on
// the real position; afterwards sections keep their remembered size.
// (The initial page script and the router's import are separate module
// instances of this file, so the hand-off between mounts lives on <html>.)
function readingAids({document,window,signal}){
  const nav=document.querySelector('.documentation-jump'),root=document.documentElement,article=document.querySelector('.documentation-article');
  const links=nav?[...nav.querySelectorAll('a[href^="#"]')]:[];
  const sections=links.map(link=>{try{return document.getElementById(decodeURIComponent(link.getAttribute('href').slice(1)));}catch{return null;}});
  const reduced=()=>{try{return window?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches===true;}catch{return false;}};
  const now=()=>Date.now();
  let active=-1,settleTimer=0,observer=null;
  if(root.dataset.docAids!=='on'){root.dataset.docAids='on';document.addEventListener('curve-navigation-start',()=>{root.dataset.docRouted='yes';});}
  function settle(smooth){
    article?.classList.add('is-scrolling');
    if(smooth&&!reduced())root.style.scrollBehavior='smooth';
    window?.clearTimeout?.(settleTimer);settleTimer=window?.setTimeout?.(()=>{root.style.removeProperty('scroll-behavior');article?.classList.remove('is-scrolling');},1400);
  }
  const viaRouter=root.dataset.docRouted==='yes',hash=String(window?.location?.hash||'');delete root.dataset.docRouted;
  if(viaRouter||hash)settle(now()<Number(root.dataset.docSmooth||0));
  // A direct load of /docs#section: the browser scrolls to the fragment before
  // the shell's shared stylesheets (which set the header's scroll padding) have
  // loaded. Once the page has loaded, align to the target again with every
  // section laid out.
  const mountedAt=now();
  if(hash&&!viaRouter&&document.readyState!=='complete')window?.addEventListener?.('load',()=>{
    // A slow load means the reader may already be scrolling: leave them be.
    if(now()-mountedAt>4000)return;
    let target=null;try{target=document.getElementById(decodeURIComponent(hash.slice(1)));}catch{}if(!target||typeof window.scrollTo!=='function')return;
    settle(false);
    // Layout position (offsetTop chain), so the page entrance transform that is
    // still animating does not skew the alignment.
    let top=0;for(let node=target;node;node=node.offsetParent)top+=node.offsetTop||0;
    const padding=parseFloat(window.getComputedStyle?.(root)?.scrollPaddingTop)||0,margin=parseFloat(window.getComputedStyle?.(target)?.scrollMarginTop)||0;
    window.scrollTo({top:Math.max(0,top-padding-margin),behavior:'auto'});
  },{once:true,signal});
  function mark(index){
    if(index===active)return;active=index;
    links.forEach((link,i)=>{if(i===index)link.setAttribute('aria-current','location');else link.removeAttribute('aria-current');});
    const link=links[index];
    if(!nav||!link||typeof nav.style?.setProperty!=='function'||!Number.isFinite(link.offsetTop))return;
    nav.style.setProperty('--toc-y',link.offsetTop+'px');nav.style.setProperty('--toc-h',String(link.offsetHeight||0));nav.classList.add('has-marker');
    // Keep the highlighted entry visible when the list scrolls sideways on small screens.
    if(nav.scrollWidth>nav.clientWidth+4&&typeof nav.scrollTo==='function')nav.scrollTo({left:Math.max(0,link.offsetLeft-24),behavior:reduced()?'auto':'smooth'});
  }
  if(sections.some(Boolean)&&typeof window?.IntersectionObserver==='function'){
    const visible=new Set();
    // A section is "being read" while it crosses the band 22%–38% down the
    // viewport. Between sections (and at the very top), the nearest section
    // above that band stays marked, so the list always shows a position.
    observer=new window.IntersectionObserver(entries=>{
      for(const entry of entries){const index=sections.indexOf(entry.target);if(entry.isIntersecting)visible.add(index);else visible.delete(index);}
      if(visible.size){mark(Math.min(...visible));return;}
      const line=(window.innerHeight||0)*.38;let current=0;
      sections.forEach((section,index)=>{const top=section?.getBoundingClientRect?.().top;if(Number.isFinite(top)&&top<=line)current=index;});
      mark(current);
    },{rootMargin:'-22% 0px -62% 0px',threshold:0});
    for(const section of sections)if(section)observer.observe(section);
  }
  function smooth(event){
    if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    const link=event.target.closest?.('a[href*="#"]');if(!link||link.target&&link.target!=='_self')return;
    let url;try{url=new URL(link.href,window.location.href);}catch{return;}
    if(url.pathname!==window.location.pathname||!url.hash||!document.getElementById(decodeURIComponent(url.hash.slice(1))))return;
    // The public router re-mounts this page on the hash change and scrolls to
    // the target itself; the next mount keeps the smooth intent.
    root.dataset.docSmooth=String(now()+1500);settle(true);
  }
  document.addEventListener('click',smooth,{capture:true,signal});
  return {destroy(){observer?.disconnect();window?.clearTimeout?.(settleTimer);root.style.removeProperty('scroll-behavior');article?.classList.remove('is-scrolling');}};
}
for(const page of ['docs','terms','privacy'])bootPage(page,mountPage);
